/**
 * **应用支持器（AppAdapter）**——应用层的类型抽象。
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
 *
 * Slice 2（2026-10-18）：进程族支持器新增 `ssh`（真实的 `ssh` 子进程，信号复用 `tool-signals`），
 * 并给 `cli`/`ssh` 加**返回值**（`returns`，stdout/regex/exit_code 抽取）→ 运行级数据集 →
 * 后续步骤以 `{dataset:NAME}` 消费（缺失 = 结构化 `needs_value`，绝不猜）。
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { loadSource, type CliObservation } from "../data/datasource.ts";
import { REPO } from "../flow/flow.ts";
import type { DatasetReader } from "../engine/dataset.ts";
import { checkToolSignal, validateToolSignal, type ToolSignal } from "../browser/tool-signals.ts";
import type { ToolStepResult } from "./app-runner.ts";
import type { ExpandedStep } from "./app-pack.ts";
import type { Subgoal } from "../engine/plan.ts";
import { validateSignalSpec, type SignalSpec } from "../engine/signals.ts";

/** 所有适配器共用的步键（`adapter` 是类型选择器，任何类型都可以写）。 */
export const SHARED_STEP_KEYS = [
  "role", "desc", "signal", "slots", "retries", "id", "next", "adapter", "returns",
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
  /** `returns`: 名字 → 抽取器（只在信号成立后抽取；Slice 2）。 */
  returns: Record<string, ReturnExtractor> | null;
}

/* ---------------------------------------------------- 返回值（Slice 2） */

/** 进程观察面的返回值抽取器（cli/ssh 共用；只抽"可验证的事实"，不抽模型转述）。 */
export type ReturnExtractor =
  | { from: "stdout" }
  | { from: "exit_code" }
  | { from: "stdout_regex"; pattern: string }
  | { from: "stderr_regex"; pattern: string };

const RETURN_FROM = ["stdout", "exit_code", "stdout_regex", "stderr_regex"] as const;
const RETURN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 校验并规范化 `returns`（加载期）。未知抽取器/缺 pattern/名字非法都报错。
 * 返回 null = 没有声明。**只在进程族（cli/ssh）支持**；web 步由适配器明确拒绝（Slice 4）。
 */
export function validateReturns(
  raw: unknown, where: string, problems: string[],
): Record<string, ReturnExtractor> | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    problems.push(`${where}.returns must be an object of name -> extractor`);
    return null;
  }
  const out: Record<string, ReturnExtractor> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    problems.push(`${where}.returns: empty object (remove the key or declare at least one value)`);
    return null;
  }
  for (const [name, spec] of entries) {
    const at = `${where}.returns.${name}`;
    if (!RETURN_NAME.test(name)) problems.push(`${at}: name must match [A-Za-z_][A-Za-z0-9_]*`);
    if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
      problems.push(`${at}: must be an object like {"from":"stdout_regex","pattern":"..."}`);
      continue;
    }
    const from = String((spec as Record<string, unknown>)["from"] ?? "");
    if (!(RETURN_FROM as readonly string[]).includes(from)) {
      problems.push(`${at}.from: must be one of ${RETURN_FROM.join(" | ")} (got ${JSON.stringify(from)})`);
      continue;
    }
    const pattern = (spec as Record<string, unknown>)["pattern"];
    if ((from === "stdout_regex" || from === "stderr_regex")) {
      if (typeof pattern !== "string" || pattern === "") {
        problems.push(`${at}.pattern: required for ${from} (a regex with a capture group)`);
        continue;
      }
      try { new RegExp(pattern); } catch (e) {
        problems.push(`${at}.pattern: invalid regex (${e instanceof Error ? e.message : String(e)})`);
        continue;
      }
    } else if (pattern !== undefined) {
      problems.push(`${at}.pattern: only meaningful for *_regex extractors`);
      continue;
    }
    out[name] = from === "stdout" ? { from } : from === "exit_code" ? { from }
      : { from, pattern: pattern as string } as ReturnExtractor;
  }
  return out;
}

/** 从一次进程观察中抽取返回值（只在信号成立后调用）。抽取不到 = 该名字不写入（如实缺席）。 */
export function extractProcessReturns(
  returns: Record<string, ReturnExtractor> | null | undefined,
  obs: { stdout: string; stderr: string; code: number | null },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!returns) return out;
  for (const [name, spec] of Object.entries(returns)) {
    if (spec.from === "stdout") out[name] = obs.stdout.trim();
    else if (spec.from === "exit_code") out[name] = obs.code;
    else {
      const text = spec.from === "stdout_regex" ? obs.stdout : obs.stderr;
      const m = new RegExp(spec.pattern).exec(text);
      if (m !== null) out[name] = m[1] ?? m[0];
    }
  }
  return out;
}

/**
 * `{dataset:NAME}` 运行期占位符替换（进程族 argv 用）。
 * 缺失/陈旧的键 ⇒ 记进 missing（调用方结构化停 `needs_value`），**绝不替换成空串或猜值**。
 */
export function substituteDatasetPlaceholders(
  value: unknown, dataset: DatasetReader | null | undefined,
): { value: unknown; missing: string[] } {
  const missing: string[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v.replace(/\{dataset:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
        const ent = dataset?.read(name) ?? null;
        if (ent === null || ent.value === undefined || ent.value === null) {
          if (!missing.includes(name)) missing.push(name);
          return _m;
        }
        return typeof ent.value === "string" ? ent.value : JSON.stringify(ent.value);
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object" && v !== null) {
      const o: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) o[k] = walk(vv);
      return o;
    }
    return v;
  };
  return { value: walk(value), missing };
}

/** 进程观察面信号里禁止 `file_*` 叶子的适配器（ssh：没有本地文件面）。 */
function collectToolSignalOps(spec: unknown, out: Set<string>): void {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return;
  for (const [op, raw] of Object.entries(spec as Record<string, unknown>)) {
    out.add(op);
    if (op === "all_of" || op === "any_of") for (const child of Array.isArray(raw) ? raw : []) collectToolSignalOps(child, out);
    else if (op === "not") collectToolSignalOps(raw, out);
  }
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
  /** 人工步：人自证（`{manual:true}`）——报告必须与 DOM 验证区分。 */
  attested?: boolean;
  /** 人工步：未完成的结构化原因（declined / manual_signal_not_held …）。 */
  reason?: string;
  /** 进程类步的结构化结果（runner 原样放进 `tool_steps`；web 步没有）。 */
  tool?: ToolStepResult;
  /** 本步声明并经信号成立后抽取出的返回值（runner 写进运行级数据集）。 */
  returns?: Record<string, unknown>;
}

/** 人工步声明（`adapter: "manual"`）：完成由人，证据由声明的 signal 决定。 */
export interface ManualStepDecl {
  desc: string;
  instructions: string | null;
  /** 人工操作前导航到的页面（登录/验证码页）；空 = 人工在外部完成，不碰浏览器。 */
  start_url: string | null;
  /** `{manual:true}` = 人工自证；DOM 信号 = 人工完成后仍要由引擎验一遍。 */
  signal: SignalSpec;
}

/** 人工步的接入请求（终端提示/测试钩子拿到同一份信息）。 */
export interface ManualStepRequest {
  index: number;
  desc: string;
  instructions: string;
  /** 人工操作前已导航到的页面 URL（没有 start_url 且没有浏览器时 = null）。 */
  url: string | null;
}

/** 人工步运行结果（runner 填；`attested` = 人自证，不是 DOM 验证）。 */
export interface ManualStepRun {
  done: boolean;
  attested?: boolean;
  /** 未完成的结构化原因（declined / no-terminal / signal-not-held / host-not-allowed …）。 */
  reason?: string;
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
  /** 人工步：runner 负责可见浏览器/导航/等待人/验 signal（执行器不参与）。 */
  runManualStep(decl: ManualStepDecl, step: ExpandedStep): Promise<ManualStepRun>;
  /** 运行级数据集读取面（`{dataset:NAME}` 占位符；缺失 = needs_value，绝不猜）。 */
  readonly dataset?: DatasetReader | null;
  /** 本次运行的唯一标识（`{run_id}` 占位符；与 `{out_dir}` 同一族运行期占位符）。 */
  readonly runId?: string;
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

  /**
   * 本机**能力探测**（可选）：这个类型此刻能不能真跑（如 ssh 需要可达的 sshd）。
   * 套件/测试据此决定"跑"还是"如实跳过"——跳过 ≠ 通过；探测失败不影响加载期校验。
   */
  ready?(): { ready: boolean; reason?: string };
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
    if (step["returns"] !== undefined) {
      p.push(`${where}.returns: web 步的返回值抽取尚未实现（Slice 4：DOM 抽取）——先别声明`);
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

/** `manual` 类型专属键（人工步骤的声明面；`signal` 是共享键）。 */
export const MANUAL_STEP_KEYS = ["start_url", "instructions"] as const;

/**
 * `manual`：**人工步骤**——登录、短信/验证码、二次确认、需要人判断的页面操作。
 *
 * 证据纪律：人工步必须声明 `signal`。
 *   - `{manual:true}` = 人自证（trace/报告显式记 `attested`，绝不冒充 DOM 验证）；
 *   - DOM 信号 = 人完成后由引擎再验一遍（验不过 → blocked，不静默算绿）。
 *
 * 执行：runner 负责（可见浏览器/导航/终端等待），执行器不参与；非交互环境由
 * `--manual-handler` 注入缝（测试/嵌入方）或 `ready()` 如实跳过（套件）。
 */
export const manualAdapter: AppAdapter = {
  kind: "manual",
  legacyKind: "browser",
  label: "manual",
  stepKeys: MANUAL_STEP_KEYS,
  validateStep(step, where, p) {
    if (typeof step["desc"] !== "string" || !String(step["desc"]).trim()) {
      p.push(`${where}: a manual step needs desc (what the human is asked to do)`);
    }
    if (step["signal"] === undefined) {
      p.push(`${where}: a manual step needs a signal ({manual:true} = the human attests, or a DOM signal)`);
    } else {
      p.push(...validateSignalSpec(step["signal"], `${where}.signal`));
    }
    if (step["start_url"] !== undefined) {
      if (typeof step["start_url"] !== "string" || !String(step["start_url"]).trim()) {
        p.push(`${where}.start_url: non-empty string required`);
      }
    }
    if (step["instructions"] !== undefined && typeof step["instructions"] !== "string") {
      p.push(`${where}.instructions: must be a string`);
    }
    // 人工步没有自动重试/返回值：声明了却静默忽略，等于"写了没用"。
    if (step["retries"] !== undefined && Number(step["retries"]) > 0) {
      p.push(`${where}.retries: a manual step does not retry（需要人再来一次就再跑一步）`);
    }
    if (step["returns"] !== undefined) {
      p.push(`${where}.returns: a manual step has no process observation to extract from`);
    }
  },
  expand(merged) {
    const decl: ManualStepDecl = {
      desc: String(merged["desc"] ?? ""),
      instructions: merged["instructions"] === undefined || merged["instructions"] === null
        ? null : String(merged["instructions"]),
      start_url: merged["start_url"] === undefined || merged["start_url"] === null
        ? null : String(merged["start_url"]),
      signal: (merged["signal"] ?? {}) as SignalSpec,
    };
    return { decl };
  },
  async run(decl, step, ctx) {
    return ctx.runManualStep(decl as ManualStepDecl, step);
  },
  ready() {
    // 套件是**批处理**：不启用人工步，也不假装能跑（否则在开发者的 TTY 里会挂在那里等人）。
    // 人工步只适合直接用 `npm run apps -- --app ...` 单跑（TTY 下由人确认）。
    return { ready: false, reason: "manual step needs a human; run this app directly (batch runners skip it)" };
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
    validateReturns(step["returns"], where, p);
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
      returns: (isDict(merged["returns"]) ? merged["returns"] : null) as Record<string, ReturnExtractor> | null,
    };
    return { decl: tool, tool };
  },
  async run(decl, step, ctx) {
    // 旅程步的 decl === step.tool；不变量探针只有 decl（没有独立的 tool 字段）——统一成 step.tool。
    const stepWithTool = decl === undefined ? step : { ...step, tool: decl as ProcessStepDecl };
    const tool = await ctx.runCliStep(stepWithTool);
    const d = decl as ProcessStepDecl | undefined;
    return {
      done: tool.done,
      tool,
      ...(tool.done ? { returns: extractProcessReturns(d?.returns, tool) } : {}),
    };
  },
};

/* ------------------------------------------------------------- 内建：ssh */

/** ssh 步声明键（结构化块；`idempotent`/`dangerous` 与 cli 同语义）。 */
const SSH_BLOCK_KEYS = ["host", "user", "port", "key", "argv"] as const;

export interface SshStepDecl {
  host: string;
  user: string | null;
  port: number | null;
  key: string | null;
  argv: string[];
  signal: ToolSignal;
  retries: number;
  idempotent: boolean;
  dangerous: boolean;
  returns: Record<string, ReturnExtractor> | null;
}

function expandSsh(merged: Record<string, unknown>): SshStepDecl {
  const b = (isDict(merged["ssh"]) ? merged["ssh"] : {}) as Record<string, unknown>;
  return {
    host: String(b["host"] ?? ""),
    user: b["user"] === undefined || b["user"] === null ? null : String(b["user"]),
    port: b["port"] === undefined || b["port"] === null ? null : Math.trunc(Number(b["port"])),
    key: b["key"] === undefined || b["key"] === null ? null : String(b["key"]),
    argv: ((b["argv"] as unknown[]) ?? []).map((x) => String(x)),
    signal: (merged["signal"] ?? {}) as ToolSignal,
    retries: merged["retries"] === undefined ? 0 : Math.trunc(Number(merged["retries"])),
    idempotent: merged["idempotent"] === true,
    dangerous: merged["dangerous"] === true,
    returns: (isDict(merged["returns"]) ? merged["returns"] : null) as Record<string, ReturnExtractor> | null,
  };
}

/**
 * `ssh`：把**远端命令**当作旅程里的一步（本机 sshd 是可验的离线真实场景）。
 *
 * 为什么复用进程观察信号：ssh 一步的可验证事实与本地命令行同形（退出码 / stdout / stderr），
 * 所以同一套 `tool-signals` 语言直接成立；唯一例外是 `file_*`——ssh 没有本地文件面，
 * 加载期就拒绝（远端文件请用命令 + stdout/exit 信号，别假装本地文件系统就是远端）。
 */
export const sshAdapter: AppAdapter = {
  kind: "ssh",
  legacyKind: "tool",
  label: "ssh",
  stepKeys: ["ssh", "idempotent", "dangerous"],
  ready: (): { ready: boolean; reason?: string } => sshReady(),
  validateStep(step, where, p) {
    const b = step["ssh"];
    if (!isDict(b)) {
      p.push(`${where}.ssh: an ssh step needs an object {host, argv, [user/port/key]}`);
      return;
    }
    for (const k of Object.keys(b)) {
      if (!(SSH_BLOCK_KEYS as readonly string[]).includes(k)) {
        p.push(`${where}.ssh.${k}: unknown key (known: ${SSH_BLOCK_KEYS.join(", ")})`);
      }
    }
    if (typeof b["host"] !== "string" || !String(b["host"]).trim()) {
      p.push(`${where}.ssh.host: non-empty string required`);
    }
    if (b["user"] !== undefined && (typeof b["user"] !== "string" || !String(b["user"]).trim())) {
      p.push(`${where}.ssh.user: non-empty string required (or omit)`);
    }
    if (b["port"] !== undefined) {
      const port = Number(b["port"]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) p.push(`${where}.ssh.port: integer 1..65535`);
    }
    if (b["key"] !== undefined && (typeof b["key"] !== "string" || !String(b["key"]).trim())) {
      p.push(`${where}.ssh.key: non-empty path string required (or omit)`);
    }
    const argv = b["argv"];
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((x) => typeof x === "string")) {
      p.push(`${where}.ssh.argv: a non-empty list of strings (the remote command + args)`);
    }
    const signal = (step["signal"] ?? {}) as ToolSignal;
    p.push(...validateToolSignal(signal, `${where}.signal`));
    // ssh 没有本地文件面：拒绝 file_* 叶子（远端文件用命令证明，别假装本地 FS 就是远端）
    const ops = new Set<string>();
    collectToolSignalOps(signal, ops);
    for (const op of ops) {
      if (op === "file_exists" || op === "file_absent") {
        p.push(`${where}.signal.${op}: ssh 步没有本地文件面——远端文件请用命令 + stdout/exit 信号证明`);
      }
    }
    const retries = Number(step["retries"] ?? 0);
    if (retries > 0 && step["idempotent"] !== true) {
      p.push(`${where}.retries=${retries} needs idempotent: true (re-running a remote command can be irreversible)`);
    }
    if (step["dangerous"] === true) {
      p.push(`${where}.dangerous: ssh 的危险步/干跑语义尚未实现（设计文档 Slice 4）——先别声明`);
      if (retries > 0) p.push(`${where}.dangerous must not retry (retries=${retries})`);
    }
    validateReturns(step["returns"], where, p);
  },
  expand(merged) {
    const decl = expandSsh(merged);
    return { decl };
  },
  async run(decl, step, ctx) {
    const d = decl as SshStepDecl;
    const base: ToolStepResult = {
      index: step.index, desc: step.desc, source: `ssh:${d.host}`, signal: d.signal, argv: [],
      attempts: 0, done: false, dry_run: null, code: null, ok: false, stdout: "", stderr: "",
    };
    // 运行期占位符：先 `{out_dir}`/`{run_id}`（与 cli 同一族），再 `{dataset:NAME}` 从数据集现读
    // （缺失 = 结构化 needs_value，绝不猜）。
    const runtimeArgv = d.argv.map((a) => a.split("{out_dir}").join(ctx.outDir)
      .split("{run_id}").join(ctx.runId ?? ""));
    const sub = substituteDatasetPlaceholders(runtimeArgv, ctx.dataset ?? null);
    if (sub.missing.length) {
      base.refused = "needs_value";
      base.stderr = `missing dataset value(s): ${sub.missing.join(", ")} `
        + `（{dataset:NAME} 只认前序步骤在信号成立后写的值；没有就停，不猜）`;
      if (ctx.verbose) console.log(`  [${step.index}] ssh ${d.host}: NEEDS_VALUE (${base.stderr})`);
      return { done: false, tool: base };
    }
    const remoteArgv = sub.value as string[];
    const sshArgv = [
      "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=5",
    ];
    if (d.port !== null) sshArgv.push("-p", String(d.port));
    if (d.key !== null) sshArgv.push("-i", d.key);
    sshArgv.push(d.user !== null ? `${d.user}@${d.host}` : d.host, ...remoteArgv);
    const tries = Math.max(1, 1 + (d.idempotent ? d.retries : 0));
    for (let i = 1; i <= tries; i++) {
      base.attempts = i;
      const res = spawnSync("ssh", sshArgv, { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      const spawned = res.error === undefined;
      const code = res.status;
      const stdout = String(res.stdout ?? "");
      const stderr = String(res.stderr ?? "")
        + (spawned ? "" : `${String(res.stderr ?? "").trim() ? "\n" : ""}${res.error!.name}: ${res.error!.message}`);
      base.argv = sshArgv;
      base.code = code;
      base.ok = code === 0;
      base.stdout = stdout;
      base.stderr = stderr;
      if (!spawned) { base.refused = "tool-unavailable"; break; }   // 起不来（缺 ssh / 非法 argv）重试无意义
      const obs: CliObservation = {
        code: code ?? 1, ok: code === 0, stdout, stderr, argv: sshArgv, cwd: ctx.outDir, exit_ok: [0],
      };
      const held = checkToolSignal(obs, d.signal);
      if (ctx.verbose) {
        console.log(`  [${step.index}] ssh ${d.host}: exit ${code ?? "-"}, signal ${held ? "held" : "not yet"}`
          + (i > 1 ? ` (attempt ${i})` : ""));
      }
      if (held) { base.done = true; break; }
    }
    return {
      done: base.done,
      tool: base,
      ...(base.done
        ? { returns: extractProcessReturns(d.returns, { stdout: base.stdout, stderr: base.stderr, code: base.code }) }
        : {}),
    };
  },
};

/** ssh 可用性探测（缓存；测试/套件据此决定跑还是如实跳过——跳过 ≠ 通过）。 */
let sshProbe: { ready: boolean; reason?: string } | null = null;
export function sshReady(): { ready: boolean; reason?: string } {
  if (sshProbe !== null) return sshProbe;
  const probe = spawnSync("ssh", [
    "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=3", "localhost", "true",
  ], { encoding: "utf8", timeout: 10_000 });
  sshProbe = probe.error !== undefined
    ? { ready: false, reason: `ssh 起不来：${probe.error.message}` }
    : probe.status !== 0
      ? { ready: false, reason: `ssh localhost 不可用（exit ${probe.status}）：${String(probe.stderr ?? "").trim().slice(0, 160)}` }
      : { ready: true };
  return sshProbe;
}

/* ------------------------------------------------------------- 内建：stdio */

/** stdio（游戏/任意交互式进程）步的声明键。 */
const STDIO_BLOCK_KEYS = ["argv", "cwd", "env_allow", "script", "timeout_ms"] as const;

/** 一条"看到提示 → 回一行"的交互规则（`when` 是正则，`send` 是原文）。 */
export interface StdioScriptStep { when: string; send: string }

export interface StdioStepDecl {
  argv: string[];
  cwd: string | null;
  envAllow: string[];
  script: StdioScriptStep[];
  timeoutMs: number;
  signal: ToolSignal;
  returns: Record<string, ReturnExtractor> | null;
}

function expandStdio(merged: Record<string, unknown>): StdioStepDecl {
  const b = (isDict(merged["stdio"]) ? merged["stdio"] : {}) as Record<string, unknown>;
  return {
    argv: ((b["argv"] as unknown[]) ?? []).map((x) => String(x)),
    cwd: b["cwd"] === undefined || b["cwd"] === null ? null : String(b["cwd"]),
    envAllow: ((b["env_allow"] as unknown[]) ?? []).map((x) => String(x)),
    script: Array.isArray(b["script"])
      ? (b["script"] as Array<Record<string, unknown>>).map((x) => ({ when: String(x["when"]), send: String(x["send"]) }))
      : [],
    timeoutMs: b["timeout_ms"] === undefined || b["timeout_ms"] === null ? 20_000 : Math.trunc(Number(b["timeout_ms"])),
    signal: (merged["signal"] ?? {}) as ToolSignal,
    returns: (isDict(merged["returns"]) ? merged["returns"] : null) as Record<string, ReturnExtractor> | null,
  };
}

/** env 白名单（与 cli 传输同口径：PATH 恒在，其余按声明；未声明的环境变量不泄漏给子进程）。 */
function envForStdio(allow: readonly string[]): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  for (const k of allow) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/**
 * `stdio`：**持续双向会话**的应用类型（交互式游戏、REPL、终端问答……）。
 *
 * 与 cli/ssh 的区别：那两者是"发一次 argv、看一次观察"；stdio 的完成真值要在一段
 * **提示-应答**对话之后才出现。本适配器把声明写成有序的 `script`（看到正则 → 回一行），
 * 用管道驱动真实子进程，完成仍只认该步自己的进程观察信号（红线③），超时/退出都是结构化结果。
 *
 * 边界（如实）：行文本协议，不是 TUI/全屏终端（没有 pty 语义）；`retries` 不支持（重放一整局
 * 不是同一次交互）；`dangerous` 干跑语义未实现。
 */
export const stdioAdapter: AppAdapter = {
  kind: "stdio",
  legacyKind: "tool",
  label: "stdio",
  stepKeys: ["stdio", "idempotent", "dangerous"],
  validateStep(step, where, p) {
    const b = step["stdio"];
    if (!isDict(b)) {
      p.push(`${where}.stdio: a stdio step needs an object {argv, script, [cwd/env_allow/timeout_ms]}`);
      return;
    }
    for (const k of Object.keys(b)) {
      if (!(STDIO_BLOCK_KEYS as readonly string[]).includes(k)) {
        p.push(`${where}.stdio.${k}: unknown key (known: ${STDIO_BLOCK_KEYS.join(", ")})`);
      }
    }
    const argv = b["argv"];
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((x) => typeof x === "string" && x.trim() !== "")) {
      p.push(`${where}.stdio.argv: a non-empty list of strings (program + args; argv array, never a shell)`);
    }
    if (b["cwd"] !== undefined && (typeof b["cwd"] !== "string" || !String(b["cwd"]).trim())) {
      p.push(`${where}.stdio.cwd: non-empty string required (or omit → repo root)`);
    }
    if (b["env_allow"] !== undefined
      && (!Array.isArray(b["env_allow"]) || b["env_allow"].some((x) => typeof x !== "string"))) {
      p.push(`${where}.stdio.env_allow: a list of env var names (PATH is always kept)`);
    }
    const script = b["script"];
    if (!Array.isArray(script) || script.length === 0) {
      p.push(`${where}.stdio.script: a non-empty list of {when, send} interaction rules`);
    } else {
      script.forEach((entry, i) => {
        const at = `${where}.stdio.script[${i}]`;
        if (!isDict(entry)) { p.push(`${at}: must be an object {when, send}`); return; }
        for (const k of Object.keys(entry)) {
          if (k !== "when" && k !== "send") p.push(`${at}.${k}: unknown key (known: when, send)`);
        }
        if (typeof entry["when"] !== "string" || entry["when"] === "") {
          p.push(`${at}.when: non-empty regex string required (the prompt to wait for)`);
        } else {
          try { new RegExp(entry["when"]); } catch (e) {
            p.push(`${at}.when: invalid regex (${e instanceof Error ? e.message : String(e)})`);
          }
        }
        if (typeof entry["send"] !== "string") p.push(`${at}.send: string required (the line to write)`);
      });
    }
    if (b["timeout_ms"] !== undefined) {
      const t = Number(b["timeout_ms"]);
      if (!Number.isInteger(t) || t < 100 || t > 120_000) {
        p.push(`${where}.stdio.timeout_ms: integer 100..120000 (a hung interactive app must be bounded)`);
      }
    }
    const retries = Number(step["retries"] ?? 0);
    if (retries > 0) {
      p.push(`${where}.retries=${retries}: stdio 是交互式会话，不支持 retries（重放一整局不是同一次交互）`);
    }
    if (step["dangerous"] === true) {
      p.push(`${where}.dangerous: stdio 的危险步/干跑语义尚未实现（设计文档 Slice 4）——先别声明`);
    }
    p.push(...validateToolSignal((step["signal"] ?? {}) as ToolSignal, `${where}.signal`));
    validateReturns(step["returns"], where, p);
  },
  expand(merged) {
    return { decl: expandStdio(merged) };
  },
  async run(decl, step, ctx) {
    const d = decl as StdioStepDecl;
    const base: ToolStepResult = {
      index: step.index, desc: step.desc, source: `stdio:${d.argv[0] ?? ""}`, signal: d.signal, argv: [],
      attempts: 1, done: false, dry_run: null, code: null, ok: false, stdout: "", stderr: "",
    };
    // 运行期占位符：先 {out_dir}/{run_id}，再 {dataset:NAME}（缺失 = needs_value，不猜、不启动进程）。
    const runtime = (xs: string[]): string[] => xs.map((a) => a.split("{out_dir}").join(ctx.outDir)
      .split("{run_id}").join(ctx.runId ?? ""));
    const argvSub = substituteDatasetPlaceholders(runtime(d.argv), ctx.dataset ?? null);
    const sendSub = substituteDatasetPlaceholders(runtime(d.script.map((x) => x.send)), ctx.dataset ?? null);
    const missing = [...new Set([...argvSub.missing, ...sendSub.missing])];
    if (missing.length > 0) {
      base.refused = "needs_value";
      base.stderr = `missing dataset value(s): ${missing.join(", ")} `
        + `（{dataset:NAME} 只认前序步骤在信号成立后写的值；没有就停，不猜）`;
      if (ctx.verbose) console.log(`  [${step.index}] stdio: NEEDS_VALUE (${base.stderr})`);
      return { done: false, tool: base };
    }
    const argv = argvSub.value as string[];
    const sends = sendSub.value as string[];
    const cwd = d.cwd === null ? REPO : path.resolve(REPO, d.cwd);
    base.argv = argv;
    return await new Promise<AdapterStepRun>((resolve) => {
      let stdout = "";
      let stderr = "";
      let next = 0;
      let done = false;
      let settled = false;
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | null = null;
      let graceHandle: NodeJS.Timeout | null = null;
      const proc = spawn(argv[0]!, argv.slice(1), {
        cwd, env: envForStdio(d.envAllow), stdio: ["pipe", "pipe", "pipe"],
      });
      // 进程早退时管道写入会 EPIPE：这是"这局没打完"的一种，不是未捕获异常。
      proc.stdin.on("error", () => { /* 由 close 统一收口 */ });
      const finalObs = (): CliObservation => ({
        code: base.code ?? 1, ok: base.code === 0, stdout, stderr, argv, cwd, exit_ok: [0],
      });
      /** 会话进行中的观察：退出码未知（-1/false），所以 exit_* 叶子在进程真正退出前不会误成立。 */
      const partialObs = (): CliObservation => ({
        code: -1, ok: false, stdout, stderr, argv, cwd, exit_ok: [],
      });
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
        if (graceHandle !== null) clearTimeout(graceHandle);
        base.stdout = stdout;
        base.stderr = stderr;
        if (timedOut) {
          base.stderr = `${stderr}${stderr.trim() ? "\n" : ""}[stdio] timed out after ${d.timeoutMs}ms; `
            + `the interactive session did not reach the step signal (killed)`;
        }
        base.done = done;
        const returns = done ? extractProcessReturns(d.returns, { stdout, stderr, code: base.code }) : undefined;
        resolve({ done, tool: base, ...(returns !== undefined ? { returns } : {}) });
      };
      const writeNext = (): void => {
        while (next < d.script.length && !settled) {
          const rule = d.script[next]!;
          if (!new RegExp(rule.when).test(stdout)) break;
          try { proc.stdin.write(`${sends[next]!}\n`); } catch { /* EPIPE：等 close 收口 */ }
          next += 1;
        }
      };
      const checkDone = (): void => {
        if (done || settled) return;
        if (!checkToolSignal(partialObs(), d.signal)) return;
        done = true;
        // 信号已成立：给进程 1s 体面退出（flush 输出/自行收尾），否则 kill——"服务器型"进程
        // 不能因为信号成立了就让 runner 永远等下去。
        graceHandle = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* 已退出 */ }
          graceHandle = setTimeout(finish, 300);
          if (typeof graceHandle.unref === "function") graceHandle.unref();
        }, 1_000);
        if (typeof graceHandle.unref === "function") graceHandle.unref();
      };
      proc.on("error", (e) => {
        base.refused = "tool-unavailable";
        stderr = `${stderr}${stderr.trim() ? "\n" : ""}${e.name}: ${e.message}`;
        finish();
      });
      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        writeNext();
        checkDone();
      });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (code) => {
        base.code = code;
        if (!done) {
          // 进程已退出：此时才用真实退出码评估信号（exit_* 叶子在这一刻才有意义）。
          done = checkToolSignal(finalObs(), d.signal);
        }
        finish();
      });
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try { proc.kill("SIGKILL"); } catch { /* 已退出 */ }
        // 极端情况 close 不来：再等 500ms 强制收口（结果如实标 timeout）。
        graceHandle = setTimeout(finish, 500);
      }, d.timeoutMs);
      if (ctx.verbose) console.log(`  [${step.index}] stdio ${d.argv[0]}: started (timeout ${d.timeoutMs}ms)`);
    });
  },
};

// 内建注册：顺序无关（注册表按 kind 查）。
registerAppAdapter(webAdapter);
registerAppAdapter(manualAdapter);
registerAppAdapter(cliAdapter);
registerAppAdapter(sshAdapter);
registerAppAdapter(stdioAdapter);
