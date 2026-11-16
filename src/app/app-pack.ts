/**
 * 应用的**内部 IR**（不在磁盘上存在）与加载期校验。
 *
 * 作者面只有 `apps/<id>/app.mjs` 的 `flow(ctx)`；`AppPack` 是加载器把 `meta` 投影出来的
 * 运行期结构，供执行器、报告、不变量和参数校验共用。它**不是**可编辑文件格式：
 * 没有 `pack.json`，没有声明式数据脚本，也没有语义模板。
 *
 * IR 保留三块信息：
 *   1. **元数据**：id/label/goal/hosts/slots/sources/site/policy/pace/...；
 *   2. **结束态验收**：`invariants`（在 `ctx.done()` 时求值）；
 *   3. **空 journey**：flow 的步骤是运行期事实，`journey` 永远为空，只为复用既有校验/报告形状。
 *
 * 三条纪律：
 *   - **发现制**：`apps/<id>/app.mjs` 扫出来，没有中央清单；
 *   - **加载期校验**：未知 meta 键、未知槽位、坏信号、坏数据源全部在加载时炸
 *     （信号复用 `PlanningRules.problems`，与冻结计划同一套校验）；
 *   - **占位符只替换已声明的槽位**（`{coupon}`），其余花括号原样保留。
 */

import fs from "node:fs";
import path from "node:path";
import { appsSearchPath } from "../support/amberflow-home.ts";
import { REPO } from "../flow/flow.ts";
import type { Subgoal } from "../engine/plan.ts";
import type { SignalSpec } from "../engine/signals.ts";
import { CLI_STEP_KEYS, SHARED_STEP_KEYS, WEB_STEP_KEYS, listAppAdapterObjects } from "./app-adapters.ts";
import type { ProcessStepDecl } from "./app-adapters.ts";
import type { PackPolicy } from "./pack-policy.ts";
/* 实现拆分（导出面与调用点不变）：pack-policy.ts（policy 声明面）、pack-expand.ts（展开）、
   validate-pack.ts（加载期校验）。本文件保留类型面、常量与目录发现，并显式 re-export 原符号。 */
export { POLICY_KEYS, NAVIGATION_MODES, ACT_HINT_MODES, ACT_HINT_TIER_MODES, TARGET_RESOLUTION_MODES, ATTR_VALUE_MATCH_MODES, BROWSER_CHANNELS, DECISION_STATE_GATES, DECISION_STATE_CONTEXTS, RISK_ASK_MODES } from "./pack-policy.ts";
export type { PackPolicy } from "./pack-policy.ts";
export { RUNTIME_PLACEHOLDERS, adapterKind, stepKind, expandPack, resolveSourceSlots } from "./pack-expand.ts";
export type { ExpandedPack } from "./pack-expand.ts";
export { validateSiteBlock, validatePack } from "./validate-pack.ts";

export const APPS_DIR = path.join(REPO, "apps");

export const SPEC_VERSION = 1;

/** 包级允许的键；未知键在加载期报错（配置写错了要响亮，不静默）。 */
export const PACK_KEYS = [
  "spec_version", "id", "label", "goal", "model", "max_subgoals", "hosts",
  "slots", "required_slots", "secret_slots", "sources", "source_slots", "roles", "journey", "invariants", "notes",
  "probe", "device", "site",
  "max_step_visits", "generated_from", "recorded_from", "policy", "pace",
] as const;

/**
 * **运行节奏声明**（应用配置表里的 `pace` 块）：步与步之间、同一子目标内动作与动作之间的
 * 最小等待。缺省 = 0（与今天逐字节一致）；只对声明/配置了值的应用生效。
 *
 * 为什么放在**应用声明**里：节奏是"这个站点/这个旅程能承受多快"，属于站点知识；
 * 全局环境变量只是默认值（见 `AMBERFLOW_STEP_DELAY_MS` / `AMBERFLOW_ACTION_DELAY_MS`），
 * 应用表里的值优先。它不是反爬对抗，而是**降载/礼貌客户端**的显式配置。
 */
export interface PackPace {
  /** 两个旅程步之间（含工具步/人工步）的最小等待，毫秒。 */
  between_steps_ms?: number;
  /** 同一浏览器子目标内，两次动作之间的最小等待，毫秒。 */
  between_actions_ms?: number;
}

/**
 * 站点面的声明（`meta.site` / pack `site`）：页面角色 → URL，以及可命名的行抽取。
 *
 * 为什么是数据而不是新 ctx 语法：`openPage(role)` 与 `extract(name)` 的语义就是
 * "把站点知识声明出来"，与 hint/探针同一条纪律——站点相关的东西不许写进共享代码。
 * Q5 的决定：v1 只给 `extract(name)`（走这里），不开放 `rows({row, fields})` 的新语法。
 */
export interface PackSite {
  /** 页面角色 → URL（仓库相对路径或 http(s)）。`ctx.openPage(role)` 用。 */
  pages?: Record<string, string>;
  /** 命名行抽取：`rows` = 行选择器；`fields` = 字段 → 行内选择器（`"."` = 行自身文本）。 */
  listExtract?: Record<string, { rows: string; fields: Record<string, string> }>;
}

/**
 * **数据腿的结果回写槽位**（`source_slots`）——一条声明，把"数据源查到了什么"接到
 * "旅程用什么值去走"。
 *
 * 数据腿与旅程必须是**同一条运行里的两条腿**：`sources` 跑完只进报告（rows/counts/selects）
 * 时，旅程用的槽位只能是人写死的默认值（`slots`）——于是"打开榜首番剧"这种应用必须先把
 * 榜首 URL 抄进包里，抄完就过期，而数据腿明明刚刚查到了它。
 *
 * 声明形状（`{slot: {source, select|count, field?}}`）：
 *   "top_anime_url": { "source": "bilibili-anime-rank", "select": "top", "field": "url" }
 *
 * 三条纪律：
 *   - **只有一个产者**：多个数据源往同一个槽位写，谁最后写谁赢——加载期拒绝重名；
 *   - **取值点名到字段**：`select` 必须在该数据源的 `selects` 里、`count` 必须在 `counts` 里（加载期查）；
 *   - **没查到就是没查到**：回写值是空的槽位按"占位符没有值"处理（响亮），不回落到包里的默认值。
 */
export interface SourceSlotBinding {
  /** 数据源名：必须是本包 `sources` 里的一员。 */
  source: string;
  /** 取该数据源 `selects.<key>` 选中行的某个字段（不给 `field` 就取该行的主值）。 */
  select?: string;
  /** 取该数据源 `counts.<key>` 的数（写回字符串形式的数字）。 */
  count?: string;
  /** 取行里的哪个字段；`select` 专用。 */
  field?: string;
}

/** 一个数据源跑完后的观察面（回写槽位只用这两张表——与数据腿报告同一口径）。 */
export interface SourceObservation {
  selects: Record<string, Record<string, string> | null>;
  counts: Record<string, number>;
}

/**
 * `device` 允许的键（与 `DeviceSpec` 一一对应）。理由是**只有手机版页面存在**的站点：
 * 桌面 UA/视口下 DOM 不同、计划点名的目标不在池里，hint 必然落空。设备是站点知识，所以进声明面；
 * 未知键在加载期报错（写错了要响亮）。
 */
export const DEVICE_KEYS = [
  "user_agent", "viewport", "is_mobile", "has_touch", "locale", "timezone", "device_scale_factor",
] as const;

/**
 * 旅程里一步允许的键。**单一出处** = 共享键 + 各应用支持器的专属键（`src/app/app-adapters.ts`）。
 * 写错类型/写了别的类型的键，加载期就红（"写了没用"不存在）。
 */
export const STEP_KEYS = [...SHARED_STEP_KEYS, ...WEB_STEP_KEYS, ...CLI_STEP_KEYS, "adjudicate"] as const;

/**
 * **当前已注册适配器的全部步键**（动态）：共享键 + 每个适配器的专属键 + `adjudicate`。
 * 校验用这个而不是 `STEP_KEYS` 常量——注册一个新类型后，它的键立刻成为合法键。
 */
export function appStepKeys(): string[] {
  return [...new Set([
    ...SHARED_STEP_KEYS,
    ...listAppAdapterObjects().flatMap((a) => [...a.stepKeys]),
    "adjudicate",
  ])];
}

/**
 * 展开后的一步。`adapter` 是**类型抽象**（`web` / `cli` / 将来的 `ssh` / `stdio`…），
 * `decl` 是该适配器自己的声明值；`kind` 只是既有消费者的**兼容视图**（browser/tool）。
 */
export interface ExpandedStep {
  index: number;
  /** 应用支持器 id（`step.adapter` 显式声明，或按 `source` 推断）。 */
  adapter: string;
  /** 兼容视图：web → browser；其它（进程类）→ tool。 */
  kind: "browser" | "tool";
  desc: string;
  role: string | null;
  /** 步名字（P4：`next` 的落点；此前是死字段）。未声明就是 `null`。 */
  id: string | null;
  /** P4 声明式后继：有序候选步 id（无可走就自然顺序）。 */
  next: string[];
  /** 适配器自己的声明值（web = Subgoal；cli = ProcessStepDecl）。 */
  decl: unknown;
  /** 浏览器步：交给唯一执行器的子目标 */
  subgoal?: Subgoal;
  /** 工具步：命令行动作腿的调用参数（signal 是进程观察面的信号） */
  tool?: ProcessStepDecl;
}

/**
 * 结束状态不变量（Slice 4 起**类型无关**）。
 *
 * 不写 `adapter` = web 不变量（在浏览器结束态上求值；既有包的语义与产物逐字节不变）。
 * 写了 `adapter`（cli/ssh/stdio…）= 该类型的**只读观察探针**：旅程结束后用同样的进程观察信号
 * 验一次（例如 ssh 检查远端文件还在、cli 检查错误路径仍可观察）。探针必须是只读观察——
 * 加载期拒绝 `dangerous`/`retries`，但"任意命令是否只读"无法由 schema 证明，属于声明责任。
 */
export interface AppInvariant {
  id: string;
  desc?: string;
  /** 缺省 = web（浏览器结束态）；否则用该应用支持器做一次只读观察探针。 */
  adapter?: string;
  signal: SignalSpec | Record<string, unknown>;
  /** 展开期填：非 web 不变量的适配器声明值（web 不变量没有）。 */
  decl?: unknown;
}

export interface AppPack {
  /** §3：运行策略声明（缺省 = 今天的行为；未知键加载期报错）。 */
  policy?: PackPolicy;
  /** 运行节奏（步/动作间最小等待；缺省 = 0 = 今天的行为）。 */
  pace?: PackPace;
  spec_version: number;
  id: string;
  label: string;
  goal: string;
  model?: string;
  max_subgoals?: number;
  /**
   * P4：`next` 边的**路径上界**——同一个步 id 在一次运行里最多进入几次（默认 3）。
   * 环不会挂死：到顶就是结构化停因（`next_cycle`），点名是哪一步、走了几次。
   */
  max_step_visits?: number;
  hosts?: string[];
  slots?: Record<string, unknown>;
  required_slots?: string[];
  /** 声明为敏感槽位的键：产物/报告/stdout 一律掩码（M0 P0）。 */
  secret_slots?: string[];
  sources?: string[];
  /** 数据腿的结果回写槽位（声明式；见 `SourceSlotBinding` 的三条纪律）。 */
  source_slots?: Record<string, SourceSlotBinding>;
  roles?: Record<string, Record<string, unknown>>;
  journey: Array<Record<string, unknown>>;
  /**
   * 这个包是**生成的**：`{ spec, plan_sha256 }`（见 `tools/spec-to-pack.ts`）。
   *
   * 它把"对齐"从"两处独立写的东西互验"变成一个构造性质：旅程 = `emitPlan(spec)` 的展开结果，
   * 而 `plan_sha256` 是展开内容的指纹——改包或改来源都会让它变化。
   * 人写的部分（`invariants` / `notes`）仍然是这个包的一部分，生成器只搬运、不发明。
   */
  generated_from?:
    | { spec: string; plan_sha256: string }
    | { source: string; plan_sha256: string };
  /**
   * 这个包是**演示一次录下来的**（`npm run learn`）：`{ url, steps, sha256 }`。
   *
   * 与 `generated_from` 同族：都是"这份文件从哪来"的血统，让 `--check`/回放能判漂移。
   * 区别在于上游——`generated_from` 的上游是 spec/代码，`recorded_from` 的上游是**一次真实演示**
   * （人做了一遍，或外层 Agent 带着 goal+url 让它跑了一遍）。**故意不带时间戳**：冻结语料不许依赖时钟。
   */
  recorded_from?: { url: string; steps: number; sha256: string };
  /** 浏览器设备面（只有手机版页面存在的站点必须声明它；见 `executor.DeviceSpec`）。 */
  device?: Record<string, unknown>;
  /** 站点面声明（页面角色 / 命名行抽取）；见 `PackSite`。 */
  site?: PackSite;
  /**
   * 探针集（测量型应用）：声明要测哪些 URL、站点特征、结果目录。站点知识的**唯一**合法
   * 去处——驱动只剩"怎么测"。校验见 `probe-set.validateProbeBlock`（含"每个 URL 的主机都
   * 必须在 `hosts` 里"，否则防泄漏门禁会漏掉它）。
   */
  probe?: Record<string, unknown>;
  invariants?: AppInvariant[];
  notes?: string[];
  /** 加载器写入：这个包的文件路径（报告用）。 */
  _path?: string;
}

/** 应用目录里的脚本名（与 `app-script.ts` 的优先级一致；这里不 import 它以免循环依赖）。 */
export const APP_SCRIPT_FILENAMES = ["app.mjs", "app.js", "app.ts"] as const;

/** 一个应用目录里的 flow 脚本（没有脚本 = 不是应用）。 */
export function appScriptFile(dir: string): string | null {
  for (const name of APP_SCRIPT_FILENAMES) {
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* 读不了就当没有 */ }
  }
  return null;
}

export interface AppDirEntry {
  /** 目录名（= 应用 id 的默认发现键）。 */
  id: string;
  dir: string;
  script: string;
}

/**
 * 发现所有应用目录（用户目录 → 仓库夹具，同 id 用户目录赢）。
 * 判据只有一个：目录里有 `app.mjs`（或 `app.js`/`app.ts`）。
 */
export function listAppDirs(): AppDirEntry[] {
  const out: AppDirEntry[] = [];
  const seen = new Set<string>();
  for (const base of appsSearchPath(APPS_DIR)) {
    let names: string[];
    try {
      names = fs.readdirSync(base);
    } catch {
      continue;                              // 用户目录还没建出来：正常，跳过
    }
    for (const n of names.sort()) {
      if (seen.has(n)) continue;             // 同名应用：用户目录覆盖仓库夹具
      const dir = path.join(base, n);
      const script = appScriptFile(dir);
      if (script === null) continue;
      seen.add(n);
      out.push({ id: n, dir, script });
    }
  }
  return out;
}

/** 已发现应用目录（按 id 排序）。 */
export function appDirs(): string[] {
  return listAppDirs().map((e) => e.dir);
}

// 兼容导出（历史导入面）
export { EFFECT_KEYS } from "./app-adapters.ts";
export type { ProcessStepDecl };
// 类型归属在 `plan.ts`（步骤语法的一部分）；这里只保留校验用的键集。
export type { StepEffect } from "../engine/plan.ts";
