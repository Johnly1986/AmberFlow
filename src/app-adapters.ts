/**
 * **应用支持器（AppAdapter）**——应用层的类型抽象（docs/APP_SUPPORTER_DESIGN.md）。
 *
 * 为什么要这层：应用层原来只有两种步型，且靠"有没有 `source` 键"隐式判定、核心两处
 * （`app-pack` 的校验/展开 + `app-runner` 的分派）各写一遍类型知识。想加 ssh / 游戏 /
 * 其它应用类型，就必须改核心——违反"加一个应用 = 加数据"的纪律。
 *
 * 现在：一种应用类型 = 一个支持器，负责
 *   ① 声明面（该类型的步键、必需键、加载期语义校验）；
 *   ② 信号面（web = DOM 信号；cli/ssh/stdio = 进程观察信号 `tool-signals`）；
 *   ③ 执行（`run`；`web`/`cli` 是**迁移桥**：委托 runner 提供的服务回调，执行循环本身不搬）；
 *   ④ 返回值抽取（`returns` → 运行级数据集；Slice 2 起）。
 *
 * 注册表纪律与 provider 注册表同一条：**拼错类型名在加载期就红并列出已知项**，绝不静默退回。
 */
import { loadSource } from "./datasource.ts";
import { validateToolSignal, type ToolSignal } from "./tool-signals.ts";
import type { ToolStepResult } from "./app-runner.ts";
import type { ExpandedStep } from "./app-pack.ts";
import type { Subgoal } from "./plan.ts";

/** 所有适配器共用的步键（`adapter` 是类型选择器，任何类型都可以写）。 */
export const SHARED_STEP_KEYS = [
  "role", "desc", "signal", "slots", "retries", "id", "next", "adapter",
] as const;

/** `web` 类型专属键（浏览器步声明面）。 */
export const WEB_STEP_KEYS = [
  "start_url", "target_hint", "target_hints", "when", "commands", "effect",
] as const;

/** `cli` 类型专属键（命令行动作腿声明面；ssh/stdio 会复用同一族进程键，见设计文档 §4）。 */
export const CLI_STEP_KEYS = [
  "source", "args", "dry_run_args", "idempotent", "dangerous",
] as const;

/** `effect`（可逆性声明）的键集（web 步；Slice 4 起可能推广到其它类型）。 */
export const EFFECT_KEYS = ["irreversible"] as const;

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 进程类步的声明值（cli 今天用它；ssh/stdio 在各自适配器里扩展或复用）。 */
export interface ProcessStepDecl {
  source: string;
  args: string[];
  dry_run_args: string[] | null;
  signal: ToolSignal;
  retries: number;
  idempotent: boolean;
  dangerous: boolean;
}

/** 加载期展开结果：适配器决定这一步怎么进 `ExpandedStep`。 */
export interface AdapterStepExpand {
  /** 适配器自己的声明值（运行期原样交回给 `run`）。 */
  decl: unknown;
  /** web 步：进浏览器计划的子目标（保持既有 `ExpandedStep.subgoal` 字段）。 */
  subgoal?: Record<string, unknown>;
  /** cli 步：进程声明（保持既有 `ExpandedStep.tool` 字段）。 */
  tool?: ProcessStepDecl;
}

/** 运行期一步的结果（类型无关的最小公共面）。 */
export interface AdapterStepRun {
  /** 该步是否已按**它自己的信号**成立完成。 */
  done: boolean;
  /** 进程类步的结构化结果（runner 原样放进 `tool_steps`；web 步没有）。 */
  tool?: ToolStepResult;
  /** 适配器可带回的观察（`returns` 抽取用；Slice 2 起）。 */
  lastObservation?: unknown;
}

/** 运行上下文：runner 提供的服务面（迁移桥；新适配器不依赖这些回调，自己实现 run）。 */
export interface AdapterRunContext {
  /** 运行输出目录（`{out_dir}` 占位符的落点）。 */
  readonly outDir: string;
  readonly verbose: boolean;
  /** 迁移桥：web 适配器把执行委托给 runner 的浏览器服务。 */
  runWebStep(step: ExpandedStep): Promise<{ done: boolean }>;
  /** 迁移桥：cli 适配器把执行委托给 runner 的工具步服务。 */
  runCliStep(step: ExpandedStep): Promise<ToolStepResult>;
}

/** 一个应用支持器（类型 = 状态机；见设计文档 §2 的完整契约）。 */
export interface AppAdapter {
  /** 唯一 id：`web` / `cli` / 将来的 `ssh` / `stdio` … */
  readonly kind: string;
  /** 兼容视图：既有消费者按 `"browser" | "tool"` 读 `ExpandedStep.kind`。 */
  readonly legacyKind: "browser" | "tool";
  /** 错误消息里的类型名（`browser` / `tool` / `ssh` …）。 */
  readonly label: string;
  /** 该类型专属的步声明键。 */
  readonly stepKeys: readonly string[];
  /** 显式声明该类型时必需的键（如 cli 要 `source`；缺了就是"写了类型却没写动作腿"）。 */
  readonly requiredKeys?: readonly string[];

  /** 加载期：语义校验（键白名单/其它类型的键由 app-pack 统一查完之后调用）。 */
  validateStep(step: Record<string, unknown>, where: string, problems: string[]): void;

  /** 加载期：把合并/替换后的一步展开成声明值（也做一次自校验）。 */
  expand(merged: Record<string, unknown>, where: string): AdapterStepExpand;

  /** 运行期：执行一步。 */
  run(decl: unknown, step: ExpandedStep, ctx: AdapterRunContext): Promise<AdapterStepRun>;

  /** 运行期：从这次观察里抽取声明好的返回值（Slice 2 起用；只在该步信号成立后调用）。 */
  extractReturns?(decl: unknown, outcome: AdapterStepRun): Record<string, unknown>;
}

/* ------------------------------------------------------------------ 注册表 */

const registry = new Map<string, AppAdapter>();

/** 注册一个支持器（幂等；重名覆盖并警告——静默覆盖会让"我在跑哪种类型"变成猜谜）。 */
export function registerAppAdapter(adapter: AppAdapter): void {
  if (registry.has(adapter.kind)) {
    console.warn(`应用支持器 ${JSON.stringify(adapter.kind)} 被重复注册：后一个覆盖前一个`);
  }
  registry.set(adapter.kind, adapter);
}

export function listAppAdapters(): string[] {
  return [...registry.keys()].sort();
}

export function listAppAdapterObjects(): AppAdapter[] {
  return [...registry.values()].sort((a, b) => (a.kind < b.kind ? -1 : 1));
}

export function getAppAdapter(kind: string): AppAdapter | undefined {
  return registry.get(kind);
}

/** 拿不到就响亮报错（加载期用；未知类型不许静默退回 web/tool）。 */
export function requireAppAdapter(kind: string): AppAdapter {
  const a = registry.get(kind);
  if (!a) {
    throw new Error(`未知的应用支持器 ${JSON.stringify(kind)}（已知：${listAppAdapters().join(", ") || "无"}）`);
  }
  return a;
}

/* -------------------------------------------------------------- 内建：web / cli */

/**
 * `web`：浏览器应用。执行走唯一执行器（`BrowserMiddleware`），信号是 DOM 语言。
 *
 * **迁移桥**：`run` 委托 `ctx.runWebStep`——执行循环留在 runner（仓库最承重的函数，搬动风险
 * 大于收益）；适配器负责声明/信号/分派。新类型（ssh/stdio）不经过这座桥。
 */
export const webAdapter: AppAdapter = {
  kind: "web",
  legacyKind: "browser",
  label: "browser",
  stepKeys: WEB_STEP_KEYS,
  validateStep(step, where, p) {
    // effect（§4）：可逆性声明。写错要响亮；不可逆步不许重试。
    const eff = step["effect"];
    if (eff !== undefined) {
      if (!isDict(eff)) {
        p.push(`${where}.effect: must be an object (keys: ${EFFECT_KEYS.join(", ")})`);
      } else {
        for (const k of Object.keys(eff)) {
          if (!(EFFECT_KEYS as readonly string[]).includes(k) && !k.startsWith("_")) {
            p.push(`${where}.effect.${k}: unknown key (known: ${EFFECT_KEYS.join(", ")})`);
          }
        }
        if (eff["irreversible"] !== undefined && typeof eff["irreversible"] !== "boolean") {
          p.push(`${where}.effect.irreversible: must be a boolean`);
        }
        if (eff["verify_after"] !== undefined) {
          // 项目方裁定：`verify_after: none` 不允许存在（等于声明"这一步可以不验证完成"），
          // 而 `signal` 就是循环的默认行为 ⇒ 这个键没有合法取值，已从 schema 删除。
          p.push(`${where}.effect.verify_after: 已删除的键——完成只认该步的证据（红线③），不能被声明关掉；`
            + `默认就是"看该子目标的信号"，不需要写。`);
        }
        const er = Number(step["retries"] ?? 0);
        if (eff["irreversible"] === true && er > 0) {
          p.push(`${where}.effect.irreversible: an irreversible step must not retry (retries=${er})`);
        }
      }
    }
    if (!step["signal"]) p.push(`${where}: needs a done-signal`);
    if (!step["desc"]) p.push(`${where}: needs desc`);
    // G-G：执行器**每个子目标都会重新 goto start_url**（计划里状态不跨子目标保留），
    // 所以浏览器步没有 start_url 在运行时只有两种结局：goto("") 报错，或者悄悄停在上一页。
    if (!step["start_url"]) p.push(`${where}: a browser step needs start_url (each subgoal re-navigates)`);
  },
  expand(merged) {
    const subgoal = { ...merged };
    return { decl: subgoal, subgoal };
  },
  async run(_decl, _step, ctx) {
    const r = await ctx.runWebStep(_step);
    return { done: r.done };
  },
};

/**
 * `cli`：命令行工具应用。信号是进程观察面（`tool-signals`）。
 *
 * **迁移桥**：`run` 委托 `ctx.runCliStep`（`runToolStep` 留在 runner：干跑/确认/幂等重试的
 * 既有语义与产物形状都不能动）。ssh/stdio 适配器会复用同一族进程信号，但自己执行。
 */
export const cliAdapter: AppAdapter = {
  kind: "cli",
  legacyKind: "tool",
  label: "tool",
  stepKeys: CLI_STEP_KEYS,
  requiredKeys: ["source"],
  validateStep(step, where, p) {
    if (typeof step["source"] !== "string" || !String(step["source"]).trim()) {
      p.push(`${where}: a cli step needs source (the datasource CLI transport name)`);
      return;
    }
    try {
      loadSource(String(step["source"]));
    } catch (e) {
      p.push(`${where}.source ${JSON.stringify(String(step["source"]))} not found `
        + `(${e instanceof Error ? e.message : String(e)})`);
    }
    p.push(...validateToolSignal((step["signal"] ?? {}) as ToolSignal, `${where}.signal`));
    const args = step["args"];
    if (args !== undefined && !(Array.isArray(args) && args.every((x) => typeof x === "string"))) {
      p.push(`${where}.args must be a list of strings (appended to the source argv)`);
    }
    const dry = step["dry_run_args"];
    if (dry !== undefined && !(Array.isArray(dry) && dry.length && dry.every((x) => typeof x === "string"))) {
      p.push(`${where}.dry_run_args must be a non-empty list of strings`);
    }
    const retries = Number(step["retries"] ?? 0);
    if (retries > 0 && step["idempotent"] !== true) {
      p.push(`${where}.retries=${retries} needs idempotent: true (re-running a tool can be irreversible)`);
    }
    if (step["dangerous"] === true) {
      if (dry === undefined) p.push(`${where}.dangerous needs dry_run_args — 不可逆动作必须先干跑`);
      if (retries > 0) p.push(`${where}.dangerous must not retry (retries=${retries})`);
    }
  },
  expand(merged) {
    const tool: ProcessStepDecl = {
      source: String(merged["source"]),
      args: ((merged["args"] as unknown[]) ?? []).map((x) => String(x)),
      dry_run_args: merged["dry_run_args"] === undefined || merged["dry_run_args"] === null
        ? null : (merged["dry_run_args"] as unknown[]).map((x) => String(x)),
      signal: (merged["signal"] ?? {}) as ToolSignal,
      retries: merged["retries"] === undefined ? 0 : Math.trunc(Number(merged["retries"])),
      idempotent: merged["idempotent"] === true,
      dangerous: merged["dangerous"] === true,
    };
    return { decl: tool, tool };
  },
  async run(_decl, step, ctx) {
    const tool = await ctx.runCliStep(step);
    return { done: tool.done, tool };
  },
};

// 内建注册：顺序无关（注册表按 kind 查）。
registerAppAdapter(webAdapter);
registerAppAdapter(cliAdapter);

/** 已注册适配器的全部专属键（`STEP_KEYS` 的单一出处）。 */
export function appAdapterStepKeys(): string[] {
  return listAppAdapterObjects().flatMap((a) => [...a.stepKeys]);
}

/** 测试/嵌入方：把注册表还原成只有内建适配器（避免测试之间互相污染）。 */
export function resetAppAdapters(): void {
  registry.clear();
  registerAppAdapter(webAdapter);
  registerAppAdapter(cliAdapter);
}
