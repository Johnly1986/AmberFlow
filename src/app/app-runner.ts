/**
 * 应用运行器 —— 一份 `apps/<app>/pack.json` 跑完一条完整链路：
 *
 *   数据腿（`sources`，同一套 datasource 引擎）
 *        ↓
 *   旅程（`journey`）：**浏览器步** → 冻结计划 → 唯一的生产执行器
 *                      **工具步**   → 命令行工具（进程观察面信号 + 干跑/确认/幂等）
 *        ↓
 *   验收（`invariants` 在**同一个浏览器会话的结束状态**上断言）
 *
 * 它**不分叉执行器**：浏览器步就是 `runSubgoalWithRetries`（bench 用的同一个入口，执行循环
 * 始终是 `BrowserMiddleware.run`），只是把会话的生命周期握在自己手里——会话在**第一个**浏览器
 * 步时才创建，并且推迟 `close()`，好让旅程结束后的不变量还能在同一页面/cookie 上求值。
 * 之所以不再整段交给 `runPlan`：旅程现在混了两种面（DOM / 进程），`runPlan` 只认识 DOM 步。
 *
 * 工具步的三条纪律（都来自"浏览器里重点一次很便宜、命令行重跑可能不可逆"）：
 *   1. **默认不重试**：`retries > 0` 必须显式 `idempotent: true`（加载期校验）；
 *   2. **不可逆先干跑**：`dangerous: true` 必须有 `dry_run_args`，干跑不成功就不 apply；
 *   3. **确认才动手**：`dangerous` 步默认**拒绝**，只有 `--allow-dangerous`（或注入的
 *      `confirmToolStep`）点头才执行；拒绝会作为显式结果上报，不是静默跳过。
 *
 *   node --experimental-strip-types src/app/app-runner.ts --list
 *   node --experimental-strip-types src/app/app-runner.ts --app demo-app                  # 真模型（默认）
 *   node --experimental-strip-types src/app/app-runner.ts --app demo-app --ablate stub     # 消融：脚本桩
 *   node --experimental-strip-types src/app/app-runner.ts --app demo-app --dry          # 只展开计划
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { MockAuditor, type TraceStep } from "../engine/audit.ts";
import { createHintMemory, type HintMemoryLike } from "../model/hint-memory.ts";
import { ensureDir, userAppsDir } from "./amberflow-home.ts";
import { isParseUsageError, renamedHint, usageErrorLine } from "../support/cli-args.ts";
import { applyRcToEnv } from "../support/rcfile.ts";
import { cliRunDetailed, defaultDates, loadSource, runSource, urlFor, type CliObservation } from "../data/datasource.ts";
import { type CachedRuntime, type DecisionCacheStats } from "../model/decision-cache.ts";
import { checkArtifacts, missingPieces, modelConfigError } from "../model/model-artifacts.ts";
import { activeProviderInfo, applySpecToRuntime, resolveProviderSpec, type ProviderInfo } from "../model/decision-provider.ts";
import { BrowserMiddleware, browserSession, type BrowserSession } from "../engine/executor.ts";
import { REPO } from "../flow/flow.ts";
import { installLayaRuntime } from "../model/model.ts";
import { runSubgoalWithRetries } from "../engine/planner.ts";
import { DESTRUCTIVE_PATTERNS } from "../engine/rules.ts";
import { checkSignal } from "../engine/signals.ts";
import { checkToolSignal, type ToolSignal } from "../browser/tool-signals.ts";
import { captureStateView } from "../flow/signal-induction.ts";
import { captureStepStateView, type StepStateView } from "../model/page-context.ts";
import type { StateView } from "../engine/signals.ts";
import { expandPack, listPacks, loadPack, type AppPack, type ExpandedStep, type PackPolicy } from "./app-pack.ts";
import { getAppAdapter, substituteDatasetPlaceholders, type AdapterRunContext } from "./app-adapters.ts";
import { DatasetStore, type DatasetEntry } from "../engine/dataset.ts";
import { createPathWalk, DEFAULT_MAX_STEP_VISITS } from "../engine/plan.ts";

/** 进程内运行序号：保证同一毫秒内连续两次运行也不会撞上同一个 `{run_id}`。 */
let RUN_SEQ = 0;

/** 相对 start_url 按仓库根解析成 file://（与 bench 同一口径）。 */
export function startUrl(u: string): string {
  if (u.includes("://")) return u;
  return new URL(`file://${path.resolve(REPO, u)}`).href;
}

// S0 上下文实验用：页面状态采集的**单一出处**在 `src/model/page-context.ts`（实验台与运行期共用）；
// 这里保留同名导出，既有导入面（tools/instruction_nomination.ts 等）不用改。
export { captureStepStateView, type StepStateView };
export interface AppRunOptions {
  /** 覆盖包的槽位（`--slot k=v`）。值仍然只来自计划。 */
  slots?: Record<string, unknown>;
  /** 计划 checkpoint 的落盘位置。 */
  planPath?: string;
  /** 跑数据腿（默认跑）。 */
  sources?: boolean;
  /** 浏览器步：危险动作一律拒绝（默认允许并在日志里标注 RISKY）。 */
  confirmSafe?: boolean;
  /** 工具步：允许 `dangerous` 步真跑（默认拒绝）。 */
  allowDangerous?: boolean;
  /** 本次实际用的决策提供者身份（CLI 解析后传入；未提供则产物里没有这个字段）。 */
  providerInfo?: ProviderInfo;
  /** 工具步：注入确认钩子（拿到干跑证据）；返回 false 则拒绝。 */
  confirmToolStep?: (desc: string, evidence: ToolStepEvidence) => boolean | Promise<boolean>;
  verbose?: boolean;
  /** 本次运行的输出目录：工具步的 `{out_dir}` 占位符用它替换（运行期值，不是计划数据）。 */
  outDir?: string;
  /** 本次运行唯一标识：`{run_id}`（默认时间戳 + pid；测试可注入固定值以复现）。 */
  runId?: string;
  /** 测试缝：注入会话工厂。 */
  sessionFactory?: () => Promise<BrowserSession>;
  /**
   * **有头运行**：浏览器窗口可见（CLI `--headful`）。默认关 = 与不传时逐字节等价（headless）。
   * 窗口开在**跑引擎的那台机器**上：本机要有真实显示器，或用虚拟显示（`xvfb-run -a npm run apps ...`）
   * 再配 VNC/noVNC 才能被人看见。
   */
  headful?: boolean;
  /**
   * 把旅程**结束时的页面状态**一并返回（`end_state`）：给"不变量归纳"用
   * （`tools/apps-induce.ts` 拿它与"还没动手时的状态"比，挑出真正被这条旅程改变的、稳定的 DOM 事实）。
   * 默认关：普通运行不需要多付一次页面扫描。
   */
  captureState?: boolean;
  /**
   * `--force-hints off`（bench 同名旗标的 apps 臂）：**只在内存里**剥掉计划点名的
   * `target_hint`/`target_hints`，让本来被规则包办的步改由决策层回答——"模型到底行不行"
   * 的对照跑法。**包文件一个字节不动**（它是被审计的冻结产物，剥完不许落回去）。
   * 结果 JSON 会写 `hint_ablation: true`：消融跑的产物不许冒充普通跑。
   */
  forceHints?: boolean;
  /**
   * S0（NL Flow，docs/NL_FLOW_DESIGN.md §10-S0）：把每个浏览器子目标的执行证据带进结果
   * （`step_traces`：desc / 状态 / 每一步的 how、desc、method）。提名实验台用它从
   * **已验收语料的实际执行**里取真值指令（truth = 这一步真的执行了什么动作）。
   * 默认关：不开时结果 JSON 与今天逐字节相同（缺省等价纪律，`end_state` 同款）。
   */
  captureTraces?: boolean;
  /**
   * S0 上下文实验（docs/NOMINATION_QUESTION_SET_ANALYSIS.md §6）：把**每步开始时**的页面状态
   * 采进 `step_traces[i].state_view`（URL/标题/正文摘要/控件能力摘要）。**缺省关**：
   * 不开时与 captureTraces 既有行为逐字节不变（只在需要时多付一次导航 + 一次提取）。
   */
  captureStateView?: boolean;
  modelId?: string;
  /**
   * 本次运行跑在哪个模型层级：`on`（真模型，**默认**）/ `off(missing)`（产物不齐，如实降级）/
   * `off(ablation:scripted-stub)` 与 `off(ablation:rules-only)`（**消融实验臂**，`--ablate` 显式才出现）。
   * 旧名字 `off(rules-only)` 曾指"装了个脚本桩"——名实不符，已随 `--no-model` 一起改掉。
   * 由**调用方**（CLI / 套件 / 桥的桩）判定并传入——运行器自己不猜：装进 `installLayaRuntime`
   * 的东西对这里透明，而"真模型在不在"的判定出处在 `src/model/model-artifacts.ts`。
   * 结果 JSON 与桥的 summary 都念这一个值（LAYA_VALUE_PLAN P0：用户先要知道此刻跑在哪层）。
   */
  modelStatus?: string;
  /**
   * 运行级数据集（Slice 2：返回值传递）。缺省 = 本次运行新建一个；注入 = 调用方要
   * 在运行前预置值（测试）/复用同一份（同一进程连跑）。`{dataset:NAME}` 只认它。
   */
  dataset?: DatasetStore;
  /** 决策缓存统计的取数口（调用方装了缓存就给；`runApp` 在旅程跑完后读一次）。 */
  runtimeStats?: () => DecisionCacheStats;
  /** 模型咨询计数的取数口（`countingRuntime` 包一层就给；同样是跑完读一次）。 */
  pickAsks?: () => number;
  /**
   * P1 `tieredHint` 的出口（默认关 = 今天逐字节）：hint 档内歧义变成对模型的更小提问。
   * 由 `--tiered-hint` / 桥的 `tiered_hint` 打开，用于线上包 A/B（EXECUTION_LAYER_SPLIT_PLAN §4#1）。
   */
  tieredHint?: boolean;
  /**
   * R2（2026-10-14 立项）：**学习环接主链路**——把"模型选对且推进了子目标"的观察
   * 变成规则（`src/model/hint-memory.ts` 的既有纪律：authored 恒优先、句柄必须稳定、
   * 键 =（精确 url, 子目标））。**学到的永不进被审计的包**——它是 sidecar，
   * 与 plan-cli `--learn-hints` 同一形状；不开这个口时运行器与产物逐字节不变。
   */
  hintMemory?: HintMemoryLike | null;
  /** sidecar 的落点（仅报告用；`--hint-memory FILE` / 默认 `$AMBERFLOW_HOME/hint-memory/<app>.json`）。 */
  hintMemoryPath?: string | null;
  /**
   * 置信度闸门的**本次覆盖**（`--conf-floor N`）。不传 = 让 pack.policy / provider 自报 / 0.25 接管。
   * 为什么需要它：闸门比的是 provider 的 `score`，换 provider（score_kind 不同）时缺省刻度不再成立——
   * 实测 token-plan 在 camera-entry 上有一枪 0.20 被 0.25 硬阻塞（见 docs/DECISION_PROVIDER_TOKENPLAN.md）。
   */
  confFloor?: number;
  /** provider 自报的闸门刻度（`ProviderInfo.floor`；CLI 装了 provider 就传进来）。 */
  providerFloor?: number;
}

/**
 * 一次运行的"决策来源"汇总（LAYA_VALUE_PLAN P1）——把散在 step 日志里的判定方式变成三组数：
 * 出场率（模型步/总步 + conf）、reobserve 挽回、缓存节约。**纯汇总口径，无新机制**：
 * 数据就是执行器 trace 里已有的 `method`/`conf`，这里只是数一遍。
 */
export interface AppDecisions {
  /** 浏览器动作腿里"有判定"的步数（trace 条目数；跳过的子目标不产生判定）。 */
  total_steps: number;
  /** 各判定方式的计数：`rule:match` / `laya` / `laya:reobserve` / `escalate` / `manual` / 其他。 */
  by_method: Record<string, number>;
  /**
   * 模型被咨询的决策数（运行时缝上数的，含没过置信闸门的那些）。
   * `laya`/`laya:reobserve` 只统计**过关并执行了**的咨询；咨询而没过闸门不在 trace 里留
   * `method`（执行器在 `low confidence` 处直接 break），所以"保险碰没碰过"必须看这个数。
   */
  model_asks: number;
  /** 过关执行的模型步：`laya` + `laya:reobserve`（escalate 是远程老师，另列）。 */
  model_steps: number;
  /** 加宽重看（`laya:reobserve`）的步数——从"低置信要停"边缘救回来的那一步。 */
  reobserve: number;
  /** escalate 步数（LLM 老师点名，非本地模型）。 */
  escalate: number;
  /** 过关模型步的 conf 分布（n/min/max；n=0 时 min/max 为 null）。 */
  conf: { n: number; min: number | null; max: number | null };
  /** 决策缓存（装了才有）：命中数与提问总数。 */
  cache: { hits: number, misses: number } | null;
  /**
   * 梯级账单（ARCHITECTURE_IMPROVEMENTS §5）：每一级"到达 / 决定 / 问了但没过闸门"。
   * **救回**的诚实定义 = 该级独立决定的步数（低一级没决定的那一步才轮得到它——
   * trace 里 `method` 就是这么记的，所以不需要反事实重跑）。整条梯级在语料上决定 0 步
   * 就是 `dead rung`，由套件在**聚合层**判定（单应用看不出全貌，见 tools/apps_suite.ts）。
   */
  ladder: { rule: number; laya: number; reobserve: number; escalate: number; adjudicated: number; asked_not_passed: number };
  /** 一行汇总，人读与机器读同一份：`rule 19 · laya 1 (conf 0.31) · 咨询 5 · laya:reobserve 1 · cache 6/12`。 */
  line: string;
}

/** trace + 咨询计数 → 汇总。口径写死在这一个函数里，套件/矩阵/桥/报告四处念同一份数。 */
export function summarizeDecisions(
  steps: TraceStep[], cache: DecisionCacheStats | null, modelAsks = 0,
): AppDecisions {
  const byMethod: Record<string, number> = {};
  const modelConfs: number[] = [];
  for (const t of steps) {
    const m = typeof t["method"] === "string" ? t["method"] : "other";
    byMethod[m] = (byMethod[m] ?? 0) + 1;
    if ((m === "laya" || m === "laya:reobserve" || m === "laya:adjudicated") && typeof t["conf"] === "number") {
      modelConfs.push(t["conf"]);
    }
  }
  const laya = byMethod["laya"] ?? 0;
  const reobserve = byMethod["laya:reobserve"] ?? 0;
  const adjudicated = byMethod["laya:adjudicated"] ?? 0;
  const escalate = byMethod["escalate"] ?? 0;
  const parts = [
    `rule ${byMethod["rule:match"] ?? 0}`,
    `laya ${laya}` + (modelConfs.length ? ` (conf ${Math.max(...modelConfs).toFixed(2)})` : ""),
    `laya:reobserve ${reobserve}`,
    // A2′：只有真发生过裁决才出现在这一行（缺省等价的纪律，同 path_visits）。
    ...(adjudicated ? [`laya:adjudicated ${adjudicated}`] : []),
    `escalate ${escalate}`,
  ];
  // 咨询数与过关数并排放：差值就是"问了但没过闸门"的那几次——它们不在 trace 里，
  // 但它们是保险被碰过的直接证据（slowjet 的冷加载正是这一形状）。
  // A2′：裁决过的也算"过了"（被执行了，只是没过置信闸门、改由信号裁决），否则会把
  // 一次真救回来的裁决错记成"问了没用"。
  const passed = laya + reobserve + adjudicated;
  if (modelAsks !== passed) {
    parts.push(`模型被咨询 ${modelAsks} 次`
      + (modelAsks > passed ? `（${modelAsks - passed} 次未过闸门）` : ""));
  }
  const extra = Object.entries(byMethod)
    .filter(([m]) => !["rule:match", "laya", "laya:reobserve", "laya:adjudicated", "escalate"].includes(m));
  for (const [m, n] of extra) parts.push(`${m} ${n}`);
  if (cache !== null) {
    parts.push(`cache 命中 ${cache.hits}/${cache.hits + cache.misses} forwards`);
  }
  return {
    total_steps: steps.length,
    by_method: byMethod,
    model_asks: modelAsks,
    model_steps: laya + reobserve + adjudicated,
    reobserve,
    escalate,
    ladder: {
      rule: byMethod["rule:match"] ?? 0,
      laya, reobserve, escalate,
      // A2′：裁决级单独计数（梯级账单要能看见"这一级今天兜回过没有"）。
      adjudicated,
      asked_not_passed: Math.max(0, modelAsks - (laya + reobserve + adjudicated)),
    },
    conf: {
      n: modelConfs.length,
      min: modelConfs.length ? Math.min(...modelConfs) : null,
      max: modelConfs.length ? Math.max(...modelConfs) : null,
    },
    cache: cache === null ? null : { hits: cache.hits, misses: cache.misses },
    line: parts.join(" · "),
  };
}

export interface ToolStepEvidence {
  desc: string;
  source: string;
  argv: string[];
  dry_run: { code: number; ok: boolean; stdout: string; stderr: string } | null;
}

export interface ToolStepResult {
  index: number;
  desc: string;
  source: string;
  signal: ToolSignal;
  argv: string[];
  attempts: number;
  done: boolean;
  /** 显式拒绝的原因：`dangerous`（没允许）/ `declined`（确认函数说不）/ `dry-run-failed` */
  /**
   * 显式拒绝/失败的原因：
   *   dangerous        —— 危险步没拿到许可（默认行为）
   *   declined         —— 确认钩子说不
   *   dry-run-failed   —— 干跑不成功，所以不 apply
   *   tool-unavailable —— 命令根本起不来（缺二进制 / 超时被杀 / argv 非法）：
   *                       这是**结果**不是崩溃——上层要能在结果 JSON 里读到它。
   */
  refused?: "dangerous" | "declined" | "dry-run-failed" | "tool-unavailable" | "needs_value";
  dry_run: { code: number; ok: boolean; stdout: string; argv: string[] } | null;
  code: number | null;
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Slice 2：本步信号成立后抽取出的返回值（runner 同时写进运行级数据集）。 */
  returns?: Record<string, unknown>;
}

export interface AppInvariantResult {
  id: string;
  desc: string;
  held: boolean;
  /** Slice 4：非 web 不变量的类型（web 不变量不写此字段，既有产物逐字节不变）。 */
  adapter?: string;
}

/**
 * **拒绝原因的唯一定义**。同一个状态曾经有三种说法：CLI 说 `REFUSED (dangerous)`、
 * 单应用报告的表里写 `**dangerous**`（那是类别，不是结论）、套件说"待放行(未执行)"——
 * 单独把 .md 发给别人看，它像一次成功的干跑。现在三个界面都念这一张表，
 * 并且一律把"怎么补救"和"有没有落盘"写在同一句里。
 */
export const REFUSAL_LABELS: Record<string, string> = {
  dangerous: "未执行（危险步未放行；加 `--allow-dangerous` 可放行，本次未落盘）",
  declined: "未执行（确认函数拒绝；未落盘）",
  "dry-run-failed": "未执行（干跑没通过，所以没有 apply）",
  "tool-unavailable": "未执行（命令起不来：缺二进制 / 超时 / argv 非法）",
  "needs_value": "未执行（{dataset:NAME} 引用的数据没有值——前序步骤没产生它或已失效；不猜）",
};

/** 给 CLI 用的一行短语（不带 Markdown 反引号）。 */
export function refusalLine(refused: string): string {
  return (REFUSAL_LABELS[refused] ?? `未执行（${refused}）`).replace(/`/g, "");
}

export interface AppSourceResult {
  name: string;
  rows: number;
  counts: Record<string, number>;
  selects: Record<string, string>;
  tool_version?: string;
}

export interface AppRunResult {
  app: string;
  label: string;
  goal: string;
  pack_path: string;
  plan_path: string;
  roles_used: string[];
  slots: Record<string, unknown>;
  completed: string;
  subgoals: Array<Record<string, unknown>>;
  tool_steps: ToolStepResult[];
  invariants: AppInvariantResult[];
  /** Slice 4：混用 ≥2 种应用类型时，按旅程声明的类型计数（缺字段 = 单一类型）。 */
  step_types?: Record<string, number>;
  sources: AppSourceResult[];
  ok: boolean;
  secs: number;
  /**
   * P4 走向的显式停因：`next` 边把同一个步 id 走进了环，路径上界到顶就停在这里——
   * 结构化的 code（不是散文），点名哪一步、进入了几次（§7-P4 的验收台：不是挂死、不是栈溢出）。
   */
  path_stop?: { code: "next_cycle"; step_id: string; visits: number; detail: string };
  /**
   * P4 走向的实数：每个**有名字**的步被进入了几次（`next` 回边会 >1）。
   * `completed` 数的是步数（计划形状），这里数的是**走法**——一次旅程走回来过，
   * 报告必须说得出这件事，否则回边是隐形的。
   */
  path_visits?: Record<string, number>;
  /**
   * P4 走向的另一半事实：被声明式边**跨过去**的步（记成 `skipped`，这里点名是谁跨的）。
   * 与"`when` 不成立所以跳过"分开报——两者的原因不同，报告不该把它们混成一句话。
   */
  path_crossed?: string[];
  /**
   * 生效的运行策略与它的来源（§3）：让"这次跑的是什么策略"成为产物的一部分——
   * 否则同一个包含义随命令行变，而报告看不出来。
   */
  /** 本次实际用的决策提供者（名字/版本/能力）。换模型 A/B 的对照就靠它。 */
  decision_provider?: ProviderInfo;
  effective_policy?: {
    tiered_hint: { value: boolean; source: "cli" | "pack" | "default" };
    risk_ask: { value: "always" | "rules-only"; source: "pack" | "default" };
    reobserve: { value: boolean; source: "pack" | "default" };
    max_effective_repeats: { value: number; source: "pack" | "default" };
    conf_floor: { value: number; source: "cli" | "pack" | "provider" | "default" };
  };
  /** 本次实际用的决策提供者身份（CLI 解析后传进来；未提供则缺字段）。 */
  providerInfo?: ProviderInfo;
  /** 模型层级（`on` / `off(missing)` / `off(ablation:…)`；未提供则缺字段）。 */
  model_status?: string;
  /**
   * 风险判定退化的原因（provider 的风险头调用失败 ⇒ 本次只用了关键词规则）。
   * 缺字段 = 没退化过。见 `src/engine/executor.ts` 的 `riskDegraded`。
   */
  risk_degraded?: string;
  /** 在线 provider 掉线/没配好 ⇒ 本次降级到 rules-only 的原因。缺字段 = 没降级。 */
  provider_degraded?: string;
  /** 决策来源汇总（见 `AppDecisions`；LAYA_VALUE_PLAN P1 的"出场率/挽回/缓存"三组数）。 */
  decisions?: AppDecisions;
  /**
   * R2：本次开了学习环时的账（sidecar 落点 + 已知/复用/被拒的条数）。
   * **缺字段 = 没开**——不开时产物逐字节不变（path_visits/effective_policy 的同一条纪律）。
   */
  hint_memory?: { path: string | null; entries: number; used: number; rejected: number };
  /** `captureState: true` 时的旅程结束状态（见 `RunOptions.captureState`）。 */
  end_state?: StateView;
  /** Slice 2：运行级数据集的审计视图（含陈旧世代与溯源；缺字段 = 没有 returns）。 */
  dataset_view?: DatasetEntry[];
  /**
   * S0（NL Flow）：`captureTraces: true` 时的每浏览器步执行证据。缺字段 = 没开
   * （缺省等价的纪律：新字段不该只是"多一行没人看的数"）。
   */
  step_traces?: Array<{
    index: number;
    id: string | null;
    desc: string;
    status: string;
    /** 每个执行过的动作的 `how`（clicked / filled / …）。 */
    hows: string[];
    /** 每个执行过的动作的人读描述（`click button "…"` / `type text into select …`）。 */
    descs: string[];
    /** 全部 trace 行的判定方式（与 `decisions.ladder` 同一口径）。 */
    methods: string[];
    /** `captureStateView: true` 时这一步**开始时**的页面状态（缺字段 = 没开，缺省等价纪律）。 */
    state_view?: StepStateView;
  }>;
}

/** 跑一个工具步：干跑（若声明）→ 确认（若不可逆）→ apply（按幂等性决定重试）。 */
export async function runToolStep(
  step: ExpandedStep, opts: AppRunOptions = {},
): Promise<ToolStepResult> {
  const rawTool = step.tool!;
  const src = loadSource(rawTool.source);
  const target = urlFor(src, defaultDates(src)[0]!);
  // `{out_dir}` 是运行期占位符（写到哪儿），不是计划里的值：在这里换成真实输出目录
  const outDir = opts.outDir ?? path.dirname(opts.planPath ?? path.join(os.tmpdir(), "app"));
  // `{run_id}`：**每次运行唯一**（进程内单调序号 + 毫秒时间戳 + pid），给"跨调用有状态"的参数用
  // （重试计数等）。只用秒级时间戳是不够的：同一秒里连跑两次会复用同一个计数文件，
  // 于是第二次运行"看起来"第一次就成功了——那正是 G-K 要修的不可复现。
  const runId = opts.runId
    ?? `${Date.now().toString(36)}-${process.pid}-${++RUN_SEQ}`;
  // `{out_dir}` 是运行期占位符（写到哪儿），不是计划里的值：argv、干跑 argv 和 signal 里
  // 的路径（file_exists / file_absent）都要换成真实输出目录，否则"产物落地了吗"永远为假。
  const missingDataset = new Set<string>();
  const sub = (v: unknown): unknown => {
    if (typeof v === "string") {
      // Slice 2：`{dataset:NAME}` 从运行级数据集现读（缺失 = 结构化 needs_value，绝不猜；
      // 与 `{out_dir}`/`{run_id}` 同一条"运行期占位符"纪律，只是值来自前序步骤）。
      return v.split("{out_dir}").join(outDir).split("{run_id}").join(runId)
        .replace(/\{dataset:([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) => {
          const ent = opts.dataset?.read(name) ?? null;
          if (ent === null || ent.value === undefined || ent.value === null) {
            missingDataset.add(name);
            return m;
          }
          return typeof ent.value === "string" ? ent.value : JSON.stringify(ent.value);
        });
    }
    if (Array.isArray(v)) return v.map(sub);
    if (typeof v === "object" && v !== null) {
      const o: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) o[k] = sub(vv);
      return o;
    }
    return v;
  };
  const t = { ...rawTool, signal: sub(rawTool.signal) as ToolSignal };
  // 参数里的运行期占位符一次解析完（干跑与 apply 用同一份），缺失值在**任何副作用之前**停。
  const resolvedArgs = t.args.map((a) => String(sub(a)));
  const resolvedDry = t.dry_run_args === null ? null : t.dry_run_args.map((a) => String(sub(a)));
  const base: ToolStepResult = {
    index: step.index, desc: step.desc, source: t.source, signal: t.signal, argv: [],
    attempts: 0, done: false, dry_run: null, code: null, ok: false, stdout: "", stderr: "",
  };

  if (missingDataset.size > 0) {
    base.refused = "needs_value";
    base.stderr = `missing dataset value(s): ${[...missingDataset].join(", ")} `
      + `（{dataset:NAME} 只认前序步骤在信号成立后写的值；没有就停，不猜）`;
    if (opts.verbose) console.log(`  [${step.index}] tool ${t.source}: NEEDS_VALUE (${base.stderr})`);
    return base;
  }

  const unavailable = (e: unknown): void => {
    base.refused = "tool-unavailable";
    base.stderr = `${e instanceof Error ? e.name : typeof e}: `
      + `${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
    if (opts.verbose) console.log(`  [${step.index}] tool ${t.source}: UNAVAILABLE (${base.stderr})`);
  };

  let dry: CliObservation | null = null;
  if (t.dry_run_args) {
    try {
      dry = await cliRunDetailed(target, 60, src, resolvedDry ?? []);
    } catch (e) {
      // 缺二进制 / 超时被杀：干跑起不来 => 不 apply，并且如实上报（不抛栈）
      unavailable(e);
      return base;
    }
    base.dry_run = { code: dry.code, ok: dry.ok, stdout: dry.stdout, argv: dry.argv };
    if (opts.verbose) {
      console.log(`  [${step.index}] dry-run ${t.source}: exit ${dry.code}${dry.ok ? "" : " (not ok)"}`);
    }
    if (!dry.ok) {
      base.refused = "dry-run-failed";
      return base;
    }
  }
  if (t.dangerous) {
    const evidence: ToolStepEvidence = {
      desc: step.desc, source: t.source, argv: dry?.argv ?? t.args,
      dry_run: dry ? { code: dry.code, ok: dry.ok, stdout: dry.stdout, stderr: dry.stderr } : null,
    };
    let allowed = opts.allowDangerous === true;
    if (opts.confirmToolStep) allowed = await opts.confirmToolStep(step.desc, evidence);
    if (!allowed) {
      base.refused = opts.confirmToolStep ? "declined" : "dangerous";
      if (opts.verbose) console.log(`  [${step.index}] ${refusalLine(base.refused)} —— ${step.desc}`);
      return base;
    }
  }
  const tries = Math.max(1, 1 + (t.idempotent ? t.retries : 0));
  for (let i = 1; i <= tries; i++) {
    base.attempts = i;
    let o: CliObservation;
    try {
      o = await cliRunDetailed(target, 60, src, resolvedArgs);
    } catch (e) {
      unavailable(e);
      break;
    }
    base.argv = o.argv;
    base.code = o.code;
    base.ok = o.ok;
    base.stdout = o.stdout;
    base.stderr = o.stderr;
    const held = checkToolSignal(o, t.signal);
    if (opts.verbose) {
      console.log(`  [${step.index}] tool ${t.source}: exit ${o.code}, signal ${held ? "held" : "not yet"}`
        + (i > 1 ? ` (attempt ${i})` : ""));
    }
    if (held) { base.done = true; break; }
  }
  return base;
}

/** 配置类错误的专用类型：它**不是**一次失败的旅程，是"这次运行根本不该开始"。
 *  调用方（CLI 的 try/catch、桥、套件）看到它就退出 2，**永不重试**（P0-5 / backlog I-1）。 */
export class AppRunConfigError extends Error {}

/**
 * 启动期预检（P0-5，实测见 bench/IMPROVEMENT_BACKLOG.md I-1）：
 * `LAYA_ONNX_MODEL=/tmp/definitely-missing.onnx npm run apps -- --app demo-app` 之前会
 * 把**数据腿与第一个工具步都执行掉**，然后在第一个需要模型的步被同一个配置错误挡住，
 * 并且**重试了 2 次**——配置错误是瞬时的，重跑一百遍还是同一句话，副作用却已经落了盘。
 *
 * 预检只拦"**显式指了一个不存在的产物/目录**"（`model-artifacts.modelConfigError`），
 * 环境变量没设、产物本来就缺的情形仍归 `off(missing)` 层级，照旧如实 block 需要模型的步。
 * 必须在**数据腿之前**跑——函数开头这一处就是"0 步、0 副作用"的那个"0"。
 */
export function preflightConfig(opts: AppRunOptions = {}): void {
  // 消融臂不该被产物齐不齐拦住（它就是不装/装桩），前缀匹配即可。
  if (typeof opts.modelStatus === "string"
    && (opts.modelStatus === "off(rules-only)" || opts.modelStatus === "off(scripted)"
      || opts.modelStatus.startsWith("off(ablation:"))) return;
  const cfg = modelConfigError();
  if (cfg !== null) {
    throw new AppRunConfigError(`model-unavailable: ${cfg}`);
  }
}

/** 跑一个应用包。返回结构化结果（报告与退出码都由调用方决定）。 */
export async function runApp(pack: AppPack, opts: AppRunOptions = {}): Promise<AppRunResult> {
  const {
    slots = {}, sources = true, confirmSafe = false, verbose = true,
    planPath = path.join(os.tmpdir(), "amberflow-apps", `${pack.id}-plan.json`),
    modelId = pack.model ?? "english",
  } = opts;
  const t0 = Date.now();
  // 预检在**任何**腿之前：坏配置不该先跑数据腿再报错（I-1 的"0 副作用"就是这个位置）。
  preflightConfig(opts);
  const expanded = expandPack(pack, slots, planPath);
  // 数据源的**配置**也在跑之前全部加载：`loadSource` 会在加载期跑 `validate_source`
  // （未知抽取器/op/transport 键、错的捕获组数……）。以前第 2 个源的坏配置要等第 1 个源
  // 真的打完网络才浮出来——网络副作用已经发生，报错却在半路。加载不产生副作用。
  {
    const cfgNames = new Set<string>();
    for (const n of pack.sources ?? []) cfgNames.add(String(n));
    for (const s of expanded.steps) if (s.adapter === "cli" && s.tool) cfgNames.add(String(s.tool.source));
    for (const n of cfgNames) loadSource(n);
  }
  let endState: StateView | undefined;
  const plan = expanded.plan;
  // 相对 start_url 按仓库根解析成 file://（与 bench 同一口径）：应用包写仓库内路径，
  // 不写死绝对路径，换机器/换 checkout 目录仍然可跑。
  for (const sg of plan.subgoals) {
    if (sg.start_url) sg.start_url = startUrl(sg.start_url);
  }
  // 消融臂：剥的是**展开后的计划**，包文件从头到尾没被碰过（缺省等价：不声明=零动作）。
  if (opts.forceHints === true) {
    for (const sg of plan.subgoals) {
      delete (sg as { target_hint?: string }).target_hint;
      delete (sg as { target_hints?: string[] }).target_hints;
    }
  }
  if (verbose) {
    const kinds = expanded.steps.map((s) => s.adapter).join(",");
    console.log(`=== app ${pack.id} (${pack.label}) ===`);
    console.log(`  journey: ${expanded.steps.length} step(s) [${kinds}], roles: ${expanded.rolesUsed.join(", ") || "-"}`);
    if (expanded.steps.length === 0 && pack.probe !== undefined) {
      const sets = pack.probe as Record<string, unknown>;
      const n = ["http", "alts", "mobile", "capture"]
        .reduce((k, key) => k + (Array.isArray(sets[key]) ? (sets[key] as unknown[]).length : 0), 0);
      console.log(`  测量型应用（探针集）：${n} 个目标；测量入口见 apps/README.md 的探针一节`);
    }
  }

  // ---- 数据腿：同一套数据源引擎（HTTP 或 CLI 通道） -------------------------
  const sourceResults: AppSourceResult[] = [];
  for (const name of pack.sources ?? []) {
    const src = loadSource(String(name));
    const dates = defaultDates(src);
    const res = await runSource(src, dates, { verbose: false });
    const day = Object.values(res.dates)[0] as Record<string, any> | undefined;
    const counts = (day?.counts ?? {}) as Record<string, number>;
    const selects: Record<string, string> = {};
    for (const [k, row] of Object.entries((day?.selects ?? {}) as Record<string, any>)) {
      if (row) selects[k] = String(row.price ?? row.id ?? row.name ?? "");
    }
    sourceResults.push({
      name: String(name), rows: (day?.rows ?? []).length, counts, selects,
      ...(res.tool_version ? { tool_version: res.tool_version } : {}),
    });
    if (verbose) console.log(`  source ${name}: ${(day?.rows ?? []).length} 条 ${JSON.stringify(counts)}`);
  }

  // ---- 旅程：逐步骤按类型执行（浏览器步走执行器，工具步走命令行） -----------
  // §3：运行策略的**生效值与来源**在这里一次算清（构造与报告读同一个对象，不分两头各猜一遍）。
  // 优先级：CLI(本次显式) > pack.policy(声明) > 缺省(= 今天)。缺省一个都没动。
  const declaredPolicy = ((pack as unknown as Record<string, unknown>)["policy"] ?? {}) as PackPolicy;
  const policy = {
    tiered_hint: {
      value: opts.tieredHint ?? declaredPolicy.tiered_hint ?? false,
      source: opts.tieredHint !== undefined ? "cli" as const
        : declaredPolicy.tiered_hint !== undefined ? "pack" as const : "default" as const,
    },
    risk_ask: {
      value: declaredPolicy.risk_ask ?? "always",
      source: declaredPolicy.risk_ask !== undefined ? "pack" as const : "default" as const,
    },
    reobserve: {
      value: declaredPolicy.reobserve ?? true,
      source: declaredPolicy.reobserve !== undefined ? "pack" as const : "default" as const,
    },
    max_effective_repeats: {
      value: declaredPolicy.max_effective_repeats ?? 3,
      source: declaredPolicy.max_effective_repeats !== undefined ? "pack" as const : "default" as const,
    },
    // 闸门刻度：CLI（本次显式）> pack.policy > provider 自报 > 0.25。
    // 换 provider 时缺省刻度不再成立（score_kind 不可比）——这是这条声明面的存在理由。
    conf_floor: opts.confFloor !== undefined
      ? { value: opts.confFloor, source: "cli" as const }
      : declaredPolicy.conf_floor !== undefined
        ? { value: declaredPolicy.conf_floor, source: "pack" as const }
        : opts.providerFloor !== undefined
          ? { value: opts.providerFloor, source: "provider" as const }
          : { value: 0.25, source: "default" as const },
  };
  const anyDeclared = Object.values(policy).some((p2) => p2.source !== "default");
  // Slice 2（应用支持器）：运行级数据集——步骤信号成立后写入 `returns`，后续步骤以
  // `{dataset:NAME}` 消费；重跑（next 回边）前先失效，下游不会读到陈旧世代。
  const dataset = opts.dataset ?? new DatasetStore();
  const returnsByStep = new Map<string, string[]>();
  const runOpts: AppRunOptions = { ...opts, dataset };
  const mw = new BrowserMiddleware({
    modelId,
    auditor: new MockAuditor(),
    // Slice 2：浏览器命令步可以 `{"from":"dataset","key":"NAME"}` 消费前序步骤的返回值。
    dataset,
    maxSteps: 8,
    confFloor: policy.conf_floor.value,
    riskyThreshold: 0.6,
    doneThreshold: 0.5,
    // P0-4（导航信封）：`hosts` 以前只在**加载期**校验类型、给防泄漏门禁当输入，
    // 运行期谁也不看它——包可以导航到任何主机。现在包声明的 hosts 就是这次旅程的
    // 信封：未声明的主机在 goto 前拒绝、动作后落到未声明主机即停（结构化理由）。
    // 空列表/未声明 = 不启用信封：离线夹具包逐字节不受影响。
    hosts: (pack.hosts ?? null) as string[] | null,
    // P1 窄问开关（默认关；开了也只影响"档内歧义的 hint 步"问模型的范围，阶梯与 method 不动）。
    // §3：优先级 CLI(本次) > pack.policy(声明) > 缺省(false)。不写 policy 的包逐字节不变。
    tieredHint: policy.tiered_hint.value,
    // §W1：`risk_ask: rules-only` 让"要不要拦"不再花一次每步的前向（批模式下它的答案本来就被丢掉）。
    riskAsk: policy.risk_ask.value === "rules-only" ? "rules-only" : "always",
    reobserve: policy.reobserve.value,
    maxEffectiveRepeats: policy.max_effective_repeats.value,
    // R2：学习环（不开 = null = 今天逐字节；authored hint 恒优先于学到的）。
    hintMemory: opts.hintMemory ?? null,
    // 批量运行器的默认：风险只记录不阻断；`confirmSafe` 时拒绝破坏性动作。
    confirmFn: confirmSafe
      ? (desc: string) => !DESTRUCTIVE_PATTERNS.some((x) => desc.toLowerCase().includes(x))
      : () => true,
  });

  const own = opts.sessionFactory === undefined;
  // 用 holder 而不是裸的 `let`：会话是在闭包里惰性创建的，裸变量的控制流收窄会把后续读取
  // 变成 never（TS 看不到闭包里的赋值）。
  const holder: { session: BrowserSession | null } = { session: null };
  const getShell = async (): Promise<BrowserSession> => {
    if (holder.session === null) {
      // 包声明了设备就用它（只有手机版页面存在的站点，桌面 DOM 里 hint 必然落空）
      const device = (pack.device ?? null) as Parameters<typeof browserSession>[1];
      holder.session = own ? await browserSession(opts.headful !== true, device) : await opts.sessionFactory!();
    }
    const s = holder.session;
    // 会话的生命周期由本函数掌握：执行器关掉的是这个壳，真正的 page 留到不变量之后。
    return { page: s.page, pw: s.pw, browser: s.browser, close: async () => {} };
  };

  const toolSteps: ToolStepResult[] = [];
  const invariantResults: AppInvariantResult[] = [];
  /** 每一步的判定方式（trace 原样收集）——P1 的出场率/挽回数从这儿数出来，不另造机制。 */
  const decisionSteps: TraceStep[] = [];
  // S0（NL Flow）：`captureTraces` 开着才收集（见 AppRunOptions.captureTraces）。
  const stepTraces: NonNullable<AppRunResult["step_traces"]> = [];
  // 浏览器步在 `plan.subgoals` 里的下标：`next` 允许跳步，所以不能再靠一个自增计数器
  // （那是"位置即身份"，而边是按**名字**声明的）。
  const browserIndexOf: number[] = [];
  {
    let k = 0;
    for (const s of expanded.steps) browserIndexOf.push(s.adapter === "web" ? k++ : -1);
  }
  // P4 走向：一份实现（`plan.createPathWalk`），带**路径上界**——`maxSteps=8` 是每步的预算，
  // 不是每一条路径的（X4）。环到顶就是显式停因，不是挂死、不是栈溢出。
  const walk = createPathWalk(expanded.steps, pack.max_step_visits ?? DEFAULT_MAX_STEP_VISITS);
  const pathCrossed: string[] = [];
  let pathStopOut: AppRunResult["path_stop"];
  // 应用支持器运行上下文（docs/APP_SUPPORTER_DESIGN.md §2）：web/cli 两个内建适配器
  // **迁移桥**——执行委托回下面两个服务（执行循环本身不搬进适配器）；新类型自己实现 run。
  const appRunId = `${Date.now().toString(36)}-${process.pid}`;
  const adapterCtx: AdapterRunContext = {
    outDir: path.dirname(planPath),
    verbose,
    dataset,
    runId: appRunId,
    runWebStep: async (st: ExpandedStep): Promise<{ done: boolean }> => {
      const sg = plan.subgoals[browserIndexOf[st.index]!]!;
      const shell = await getShell();
      // S0 上下文实验：快照这一步**开始时**的页面（只读；只在本开关打开时多付一次导航）。
      let stateView: StepStateView | null = null;
      if (opts.captureTraces && opts.captureStateView && sg.start_url) {
        try {
          await (shell.page as unknown as { goto(u: string, o?: unknown): Promise<unknown> }).goto(
            sg.start_url, { waitUntil: "domcontentloaded", timeout: 30_000 },
          );
          stateView = await captureStepStateView(shell.page as never);
        } catch { stateView = null; }
      }
      const { rep, attempt, steps } = await runSubgoalWithRetries(
        mw as never, sg, plan, sg.start_url ?? "", shell.page, shell.pw, verbose);
      decisionSteps.push(...steps);
      if (opts.captureTraces) {
        const executed = rep.steps.filter((t) => t.executed);
        stepTraces.push({
          index: st.index ?? 0,
          id: st.id ?? null,
          desc: sg.desc,
          status: rep.done ? (rep.skipped ? "skipped" : "done") : "blocked",
          hows: executed.map((t) => String(t.how ?? "")),
          descs: executed.map((t) => String(t.desc ?? "")),
          methods: rep.steps.map((t) => String(t.method ?? "")).filter(Boolean),
          ...(stateView ? { state_view: stateView } : {}),
        });
      }
      sg.status = rep.done ? (rep.skipped ? "skipped" : "done") : "blocked";
      sg.attempts = attempt;
      sg.obstacle = rep.done ? null : rep.stop_reason;
      if (!rep.done && rep.stop_code) (sg as Record<string, unknown>).stop_code = rep.stop_code;
      plan.save();
      return { done: rep.done };
    },
    runCliStep: async (st: ExpandedStep) => runToolStep(st, runOpts),
  };
  try {
    let i = 0;
    while (i < expanded.steps.length) {
      const step = expanded.steps[i]!;
      // 进入这一步：同一个步 id 走太多遍 = 声明的 `next` 边成了环。
      const over = walk.enter(i);
      if (over !== null) {
        pathStopOut = {
          code: "next_cycle",
          step_id: over.id,
          visits: over.visits,
          detail: `step ${JSON.stringify(over.id)} was entered ${over.visits} time(s) in one run`
            + ` (per-path bound max_step_visits=${pack.max_step_visits ?? DEFAULT_MAX_STEP_VISITS})`
            + ` — a declared \`next\` edge forms a cycle; stopping instead of looping forever`,
        };
        const sg = browserIndexOf[i]! >= 0 ? plan.subgoals[browserIndexOf[i]!] : undefined;
        if (sg) { sg.status = "blocked"; sg.obstacle = pathStopOut.detail; plan.save(); }
        if (verbose) console.log(`  [journey] ${pathStopOut.detail}`);
        break;
      }
      // 应用支持器分派：一种类型 = 一个适配器（web/cli 走迁移桥，新类型原生执行）。
      const adapter = getAppAdapter(step.adapter);
      if (adapter === undefined) {
        throw new AppRunConfigError(`unknown app adapter ${JSON.stringify(step.adapter)} `
          + `on step #${step.index} (known: web, cli)`);
      }
      // `next` 回边/重跑：这一步上次写过的返回值在重新执行前先失效（数据集纪律：
      // 陈旧世代不可读，下游会以 needs_value 结构化停，而不是静默使用旧值）。
      const stepKey = step.id ?? `#${step.index}`;
      for (const by of returnsByStep.get(stepKey) ?? []) dataset.invalidateStep(by);
      returnsByStep.delete(stepKey);
      const outcome = await adapter.run(step.decl, step, adapterCtx);
      if (outcome.tool) {
        if (outcome.done && outcome.returns !== undefined) {
          // 声明的抽取执行过了：哪怕一个都没抽到，也在证据面留 {}（"执行了，只是没抽到"）。
          outcome.tool.returns = outcome.returns;
          if (Object.keys(outcome.returns).length > 0) {
            const writtenBy = `${stepKey}#${outcome.tool.attempts || 1}`;
            for (const [name, value] of Object.entries(outcome.returns)) {
              dataset.write(name, value, writtenBy);
            }
            returnsByStep.set(stepKey, [writtenBy]);
          }
        }
        toolSteps.push(outcome.tool);
      }
      // 声明式后继：按序取第一个"此刻适用"的候选；都没声明/都不适用 ⇒ 自然顺序。
      // 适用性问的是该步**自己的 `when`**（"这一步适不适用"），问在当次页面上——
      // 这一步没有模型参与，走向由声明与页面证据决定（红线①）。
      const from = i;
      i = await walk.after(i, async (j) => {
        const cand = expanded.steps[j]!;
        if (cand.adapter !== "web") return true;             // 非 web 步没有 `when`：声明了就适用（Slice 1 边界）
        const sg = plan.subgoals[browserIndexOf[j]!];
        const when = sg?.when;
        if (when === undefined || when === null) return true;
        if (holder.session === null) {
          // 还没有页面可问（旅程第一步是工具步、候选却在浏览器步上）：此刻无法成立，
          // 如实当作"不适用"，继续看下一个候选——不为了让分支走通去偷偷开一个浏览器。
          if (verbose) console.log(`  [journey] next candidate ${JSON.stringify(cand.id ?? j)} not evaluated (no page yet)`);
          return false;
        }
        return await checkSignal(holder.session.page as never, when);
      });
      // 被声明式边**跨过去**的步：这条边就是作者对"这条路径上它不适用"的声明，
      // 所以记成 `skipped`（不是留在 pending——那会让任何前向分支都红）。
      // 记的是"跨过"这件事本身，报告里单列（`path_crossed`），不与 `when` 自然的跳过混为一谈。
      if (i > from + 1) {
        for (let k = from + 1; k < i; k++) {
          const crossed = expanded.steps[k]!;
          if (crossed.adapter === "web") {
            const sg = plan.subgoals[browserIndexOf[k]!]!;
            if (sg.status === "pending") { sg.status = "skipped"; plan.save(); }
          }
          pathCrossed.push(`${crossed.id ?? `#${crossed.index}`} (crossed by \`next\` from ${expanded.steps[from]!.id ?? `#${expanded.steps[from]!.index}`})`);
          if (verbose) console.log(`  [journey] step ${crossed.id ?? `#${crossed.index}`} crossed by a declared next edge -> skipped`);
        }
      }
    }
    // ---- 验收：结束状态上的不变量（同一会话、同一 cookie/页面） -------------
    // 显式再标注一次类型：`session` 是在 `getShell` 闭包里赋值的，控制流分析看不到。
    const live = holder.session;
    // `expanded.invariants`（不是 pack.invariants）：展开期已做槽位替换，与 journey 同一套规则。
    for (const inv of expanded.invariants) {
      const kind = inv.adapter ?? "web";
      let held = false;
      if (kind === "web") {
        // web 不变量：在浏览器会话的结束状态上求值（既有语义，逐字节不变）。
        held = live === null ? false : await checkSignal(live.page as never, inv.signal as never);
      } else {
        // 进程族不变量：用该类型的**只读观察探针**在旅程结束后再验一次（如 ssh 看远端文件还在）。
        const adapter = getAppAdapter(kind);
        if (adapter !== undefined) {
          const probe: ExpandedStep = {
            index: -1, adapter: adapter.kind, kind: adapter.legacyKind,
            desc: inv.desc ?? inv.id, role: null, id: inv.id, next: [], decl: inv.decl,
          };
          const out = await adapter.run(inv.decl, probe, adapterCtx);
          held = out.done;
        }
      }
      invariantResults.push({
        id: inv.id, desc: inv.desc ?? inv.id, held,
        ...(kind !== "web" ? { adapter: kind } : {}),
      });
      if (verbose) console.log(`  invariant ${inv.id}${kind === "web" ? "" : ` [${kind}]`}: ${held ? "held" : "VIOLATED"}`);
    }
    // 结束态必须在 session 关掉**之前**抓（否则抓到的是一个已关闭的页面）。
    // 捕获失败不该让一条本来成功的旅程变红，但也不能静默——verbose 下说明原因。
    if (opts.captureState && live !== null) {
      try {
        endState = await captureStateView(live.page as never);
      } catch (e) {
        if (verbose) console.log(`  end-state capture failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    if (holder.session !== null) await holder.session.close();
  }

  // Slice 4：类型账（只在**混用 ≥2 种类型**的旅程里出现，既有应用产物逐字节不变）。
  const typeCounts: Record<string, number> = {};
  for (const st of expanded.steps) typeCounts[st.adapter] = (typeCounts[st.adapter] ?? 0) + 1;
  const stepTypes = Object.keys(typeCounts).length > 1 ? typeCounts : undefined;
  const subgoals = plan.subgoals.map((s) => ({
    desc: s.desc, status: s.status, attempts: s.attempts ?? 1, obstacle: s.obstacle ?? null,
  }));
  const browserOk = subgoals.every((s) => s.status === "done" || s.status === "skipped");
  const toolsOk = toolSteps.every((t) => t.done);
  // 路径上界到顶 = 这次旅程没有走完（即使被环卷进去的那一步恰好是工具步，也不能算绿）。
  const ok = browserOk && toolsOk && invariantResults.every((i) => i.held) && pathStopOut === undefined;
  // 数的是**声明出来的步**，不是"跑了几趟"：`next` 回边会让同一个工具步跑很多遍，
  // 那样 `completed` 会写出 `100/2` 这种读不通的数（真要读趟数看 `path_visits`）。
  const doneCount = subgoals.filter((s) => s.status === "done" || s.status === "skipped").length
    + new Set(toolSteps.filter((t) => t.done).map((t) => t.index)).size;
  const stats = opts.runtimeStats ? opts.runtimeStats() : null;
  return {
    app: pack.id, label: pack.label, goal: pack.goal,
    pack_path: pack._path ?? "", plan_path: planPath,
    roles_used: expanded.rolesUsed, slots: expanded.slots,
    completed: `${doneCount}/${expanded.steps.length}`,
    subgoals, tool_steps: toolSteps, invariants: invariantResults,
    ...(stepTypes !== undefined ? { step_types: stepTypes } : {}),
    ...(opts.captureTraces ? { step_traces: stepTraces } : {}),
    // Slice 2：返回值传递的审计面（缺省不出现——没有 returns 的包产物逐字节不变）。
    ...(dataset.entriesView().length > 0 ? { dataset_view: [...dataset.entriesView()] } : {}),
    // 只在**真的走回来过**时才写这个字段：声明了 id 但没走边的包，结果 JSON 与今天一模一样
    // （缺省等价的纪律：新字段不该只是"多一行没人看的数"）。
    ...(Object.values(walk.visits()).some((n) => n > 1) ? { path_visits: walk.visits() } : {}),
    ...(pathCrossed.length ? { path_crossed: pathCrossed } : {}),
    ...(pathStopOut ? { path_stop: pathStopOut } : {}),
    ...(endState ? { end_state: endState } : {}),
    // §3：生效策略**只在非缺省时写进产物**（与 path_visits 同一纪律）。
    // 来源三态要说清：CLI 本次覆盖 / 包声明 / 都没写——否则报告看不出这次跑的和上次是不是同一件事。
    ...(anyDeclared ? { effective_policy: policy } : {}),
    // 换模型测试的对照靠这个字段：层级只说"有没有决策层"，身份才说"是哪一家"。
    ...(opts.providerInfo ? { decision_provider: opts.providerInfo } : {}),
    ...(opts.modelStatus !== undefined ? { model_status: opts.modelStatus } : {}),
    // 消融跑要能被产物读出来（不声明 ⇒ 字段缺席，逐字节与今天相同）。
    ...(opts.forceHints === true ? { hint_ablation: true } : {}),
    decisions: summarizeDecisions(decisionSteps, stats, opts.pickAsks ? opts.pickAsks() : 0),
    // R2：学习环的账——只在**开了**的时候写字段（缺省等价纪律，同 path_visits）。
    // `rejected` 要 cast：接口只承诺 entries/used，它是 HintMemory 实现多给的——
    // 跨实现注入（测试桩/别的记忆）时不能假设它在。
    ...(opts.hintMemory ? {
      hint_memory: {
        path: opts.hintMemoryPath ?? null,
        entries: opts.hintMemory.stats?.().entries ?? 0,
        used: opts.hintMemory.stats?.().used ?? 0,
        rejected: (opts.hintMemory.stats?.() as { rejected?: number } | undefined)?.rejected ?? 0,
      },
    } : {}),
    // 风险头掉线时执行器退回到关键词规则——**这件事必须出现在产物里**，
    // 否则一次"退化的运行"和一次正常的运行会共用同一个绿色。
    ...(mw.riskDegraded ? { risk_degraded: mw.riskDegraded } : {}),
    // 在线 provider 掉线/没配好 ⇒ 本次跑降级到 rules-only——同样必须出现在产物里（同 risk_degraded）。
    ...(mw.providerDegraded ? { provider_degraded: mw.providerDegraded } : {}),
    sources: sourceResults, ok, secs: Math.round((Date.now() - t0) / 100) / 10,
  };
}

/** 结构化结果 → 人读的 Markdown（应用级证据：数据腿 + 旅程 + 不变量）。 */
export function appReportMarkdown(r: AppRunResult): string {
  const L: string[] = [
    `# 应用运行报告：${r.label}（\`${r.app}\`）`,
    "",
    `- 应用包：\`${r.pack_path}\``,
    `- 目标：${r.goal}`,
    `- 结果：**${r.ok ? "通过" : "未通过"}** ｜ 步骤 ${r.completed} ｜ 用时 ${r.secs}s`,
    ...(r.model_status !== undefined
      ? [`- 模型层级：\`${r.model_status}\`（on=真 ONNX 在位；off(missing)=缺产物，走的是规则模式）`] : []),
    ...(r.decision_provider
      ? [`- 决策提供者：\`${r.decision_provider.name} ${r.decision_provider.version}\``
        + `（score=${String(r.decision_provider.capabilities.score_kind)}`
        + `${r.decision_provider.floor !== undefined ? `，闸门刻度 ${r.decision_provider.floor}` : ""}）`] : []),
    ...(r.effective_policy
      ? [`- 生效策略：${Object.entries(r.effective_policy)
          .filter(([, v]) => v.source !== "default")
          .map(([k, v]) => `\`${k}=${String(v.value)}\`(${v.source})`).join(" ")}`
        + `｜优先级 cli=本次命令覆盖 > pack=包声明 > default=今天的行为`] : []),
    `- 角色：${r.roles_used.map((x) => `\`${x}\``).join(", ") || "（未用角色模板）"}`,
    ...(r.dataset_view !== undefined && r.dataset_view.length > 0
      ? [`- 数据传递：${r.dataset_view.map((e) => `\`${e.key}=${JSON.stringify(e.value ?? null)}\``
        + `${e.stale ? "（陈旧）" : ""}（${e.writtenBy}）`).join(" ｜ ")}`]
      : []),
    `- 槽位（值只来自计划）：${JSON.stringify(r.slots)}`,
    ...(r.path_stop !== undefined
      ? [`- **走向停因**：\`${r.path_stop.code}\` ｜ 步 \`${r.path_stop.step_id}\` 被进入 ${r.path_stop.visits} 次：${r.path_stop.detail}`]
      : []),
    ...(r.path_visits !== undefined && Object.values(r.path_visits).some((n) => n > 1)
      ? ["- **走向**（`next` 边真的走回来了）："
        + Object.entries(r.path_visits).map(([k, n]) => `\`${k}\`×${n}`).join("、")]
      : []),
    ...(r.path_crossed !== undefined && r.path_crossed.length
      ? ["- **跨过的步**（声明式边跨过去，记成 skipped）：" + r.path_crossed.join("、")]
      : []),
  ];
  if (r.sources.length) {
    L.push("", "## 数据腿", "", "| 数据源 | 行数 | counts | selects | 工具版本 |", "|---|---|---|---|---|");
    for (const s of r.sources) {
      L.push(`| ${s.name} | ${s.rows} | ${JSON.stringify(s.counts)} | ${JSON.stringify(s.selects)} | ${s.tool_version ?? "-"} |`);
    }
  }
  if (r.subgoals.length) {
    L.push("", "## 动作腿：浏览器步（冻结计划）", "", "| # | 子目标 | 状态 | 尝试 | 障碍 |", "|---|---|---|---|---|");
    r.subgoals.forEach((s, i) => {
      L.push(`| ${i} | ${String(s.desc).slice(0, 80)} | ${s.status} | ${s.attempts} | ${s.obstacle ?? "-"} |`);
    });
    if (r.decisions !== undefined) {
      // 出场率一行（LAYA_VALUE_PLAN P1）：谁判的、模型救了几步、缓存省了几次——小计在表下，不散在日志里。
      if (r.risk_degraded) {
        L.push("", `- ⚠ **风险判定已退化**：${r.risk_degraded}`
          + `（本次只用关键词规则代替模型投票——这**不是**一次正常的风险闸门运行）`);
      }
      if (r.provider_degraded) {
        L.push("", `- ⚠ **决策服务已退化到规则模式**：${r.provider_degraded}`
          + `（provider 不可用/未配置——声明点名的步照跑，需要选目标的步按 rules-only 如实 block）`);
      }
      L.push("", `**决策来源**：${r.decisions.line}`
        + ` ｜ 模型出场 ${r.decisions.model_steps}/${r.decisions.total_steps} 步`
        + (r.decisions.model_steps === 0 ? "（model not needed——能规则化就别猜）" : ""));
    }
  }
  if (r.tool_steps.length) {
    L.push("", "## 动作腿：工具步（命令行）", "",
      "| # | 步骤 | 数据源 | 退出码 | 结论 | 尝试 | 干跑 |", "|---|---|---|---|---|---|---|");
    for (const t of r.tool_steps) {
      // 结论列写**结论**（"未执行 + 怎么补救"），不写内部类别（`dangerous` 仍然在 JSON 里）。
      const verdict = t.done ? "signal held"
        : t.refused ? `**${REFUSAL_LABELS[t.refused] ?? "未执行"}**` : "signal not held";
      const dry = t.dry_run ? `exit ${t.dry_run.code}${t.dry_run.ok ? "" : " (not ok)"}` : "-";
      L.push(`| ${t.index} | ${t.desc.slice(0, 60)} | ${t.source} | ${t.code ?? "-"} | ${verdict} | ${t.attempts} | ${dry} |`);
    }
    L.push("", "<details><summary>工具步的原始观察（argv / stdout 摘要）</summary>", "");
    for (const t of r.tool_steps) {
      L.push(`- \`${t.source}\` argv: \`${t.argv.join(" ")}\``);
      if (t.dry_run) L.push(`  - dry-run argv: \`${t.dry_run.argv.join(" ")}\``);
      if (t.stdout) L.push(`  - stdout: ${JSON.stringify(t.stdout.slice(0, 200))}`);
      if (t.stderr) L.push(`  - stderr: ${JSON.stringify(t.stderr.slice(0, 200))}`);
    }
    L.push("", "</details>");
  }
  if (r.step_types !== undefined) {
    L.push(`- 应用类型：${Object.entries(r.step_types).map(([k, n]) => `\`${k}\`×${n}`).join(" · ")}（旅程声明）`);
  }
  if (r.invariants.length) {
    L.push("", "## 验收（结束状态不变量：web = 浏览器结束态；其它类型 = 只读观察探针）",
      "", "| 不变量 | 类型 | 说明 | 结论 |", "|---|---|---|---|");
    for (const i of r.invariants) {
      L.push(`| ${i.id} | ${i.adapter ?? "web"} | ${i.desc} | ${i.held ? "成立" : "**不成立**"} |`);
    }
  }
  return L.join("\n") + "\n";
}

const USAGE = `usage: app-runner [--list] [--app ID] [--dry] [--slot k=v ...] [--out DIR]
                  [--model ID] [--provider NAME] [--ablate stub|rules-only] [--force-hints off] [--no-sources] [--confirm-safe]
                  [--headful]
                  [--allow-dangerous] [--tiered-hint] [--learn-hints | --hint-memory FILE] [--conf-floor N] [--quiet]

按 apps/<app>/pack.json 跑一条完整应用链路：数据腿 → 浏览器步/工具步 → 结束状态不变量
--tiered-hint  P1 实验开关：hint 档内歧义向模型问更小的问题（默认关 = 行为逐字节不变）
--learn-hints  R2 学习环：模型选对的步变成规则（sidecar，永不写进被审计的包；authored 恒优先）
               落点默认 $AMBERFLOW_HOME/hint-memory/<app>.json，--hint-memory FILE 显式指定
--conf-floor N 置信度闸门刻度（0<N≤1）：换 provider（score_kind 不同）时缺省 0.25 不再成立，
               本旗标 = 本次覆盖；包可用 policy.conf_floor 声明；provider 可自报 floor`;

/**
 * app-runner 默认产物目录（**调用时**读 env，测试可隔离——与 apps_suite 的 suiteOutDir 同一纪律）。
 * matrix 的"学到/复用"列读的就是这里：那是"上一次真跑"的证据，没跑过显示"未跑"。
 */
export function appsOutDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AMBERFLOW_APPS_OUT ?? path.join(os.tmpdir(), "amberflow-apps");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // rc 文件坏 = 配置类用法错误：在任何腿出场之前逐行点名并 exit 2（src/support/rcfile.ts）。
  { const rc = applyRcToEnv(); if (rc.errors.length) { for (const e of rc.errors) console.error(e); return 2; } }
  // 打错的参数 → 一行点名 + usage，绝不甩 parseArgs 的堆栈（src/support/cli-args.ts 的体例）。
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true,
      options: {
        list: { type: "boolean" }, app: { type: "string" }, dry: { type: "boolean" },
        slot: { type: "string", multiple: true }, out: { type: "string" },
        model: { type: "string" }, ablate: { type: "string" }, provider: { type: "string" },
        "no-sources": { type: "boolean" }, "confirm-safe": { type: "boolean" }, headful: { type: "boolean" },
        "allow-dangerous": { type: "boolean" },
        "tiered-hint": { type: "boolean" },
        // 消融臂（与 bench 同名）：内存里剥掉计划点名的 hint，让规则包办的步改由决策层回答。
        "force-hints": { type: "string" },
        "learn-hints": { type: "boolean" }, "hint-memory": { type: "string" },
        "conf-floor": { type: "string" },
        quiet: { type: "boolean" }, help: { type: "boolean" },
      },
    });
  } catch (err) {
    if (!isParseUsageError(err)) throw err;
    const line = usageErrorLine(err);
    console.error(line);
    const hint = renamedHint(line);        // 旧调用方（升级窗口的旧桥）要知道新写法
    if (hint) console.error(hint);
    console.error();
    console.error(USAGE);
    return 2;
  }
  const v = parsed.values;
  if (v.help) { console.log(USAGE); return 0; }
  if (v.list || !v.app) {
    for (const [id, label, p] of listPacks()) console.log(`${id.padEnd(22)} ${label}  ${p}`);
    if (!v.app) { console.log(); console.log(USAGE); return v.list ? 0 : 2; }
  }

  const slots: Record<string, unknown> = {};
  for (const s of v.slot ?? []) {
    const i = s.indexOf("=");
    if (i <= 0) { console.error(`--slot needs k=v, got ${JSON.stringify(s)}`); return 2; }
    const key = s.slice(0, i);
    // 同名给两次曾经是**静默 last-wins**：`--slot coupon=A --slot coupon=B` 里 A 悄悄消失。
    // 与"打错槽位名"同一类缺陷（值没被用上而使用者以为生效），所以同样按用法错误处理。
    if (Object.prototype.hasOwnProperty.call(slots, key)) {
      console.error(`--slot ${JSON.stringify(key)} 给了两次（${JSON.stringify(slots[key])} 与 `
        + `${JSON.stringify(s.slice(i + 1))}）：一个槽位只能有一个值`);
      return 2;
    }
    slots[key] = s.slice(i + 1);
  }

  let pack: AppPack;
  try {
    pack = loadPack(String(v.app));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }

  // 槽位名打错曾是**静默**的：`--slot coupn=X` 会被原样塞进计划，值谁也没用上，而应用照旧"通过"。
  // 值只来自计划，但键必须有出处——不在声明里就是用法错误（exit 2），并且把已声明的列出来。
  const declaredSlots = new Set([
    ...Object.keys(pack.slots ?? {}),
    ...((pack.required_slots ?? []) as string[]),
  ]);
  const unknownSlots = Object.keys(slots).filter((k) => !declaredSlots.has(k));
  if (unknownSlots.length) {
    console.error(`--slot ${unknownSlots.map((k) => JSON.stringify(k)).join(", ")} not declared by app ${pack.id}`
      + (declaredSlots.size
        ? `（已声明：${[...declaredSlots].sort().join(", ")}）`
        : "（该应用没有声明任何槽位）"));
    return 2;
  }

  const outDir = path.resolve(v.out ?? appsOutDir());
  // 输出目录建不出来时是**用法错误**，不该把 Node 的 mkdir 栈甩给使用者（`--out /sys/x`）。
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (e) {
    console.error(`--out ${JSON.stringify(outDir)} 建不出来：${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const planPath = path.join(outDir, `${pack.id}-plan.json`);

  // 测量型应用（只声明 probe、没有 journey）走 app 运行器是没有意义的：它会"通过 0/0"。
  // 与其给一个什么都没证明的绿色，不如指路到真正的测量入口。
  if (pack.probe !== undefined && (pack.journey ?? []).length === 0) {
    const sets = pack.probe as Record<string, unknown>;
    const n = ["http", "alts", "mobile", "capture"]
      .reduce((k, key) => k + (Array.isArray(sets[key]) ? (sets[key] as unknown[]).length : 0), 0);
    console.error(`app ${pack.id} 是测量型应用（探针集，${n} 个目标），没有 journey：`
      + "请用对应的探针驱动（src/sites/live-probe.ts / live-capture.ts / ota-probe.ts / qunar-probe.ts），"
      + "或用 `npm run apps -- --app " + pack.id + " --dry` 只看声明。");
    return 2;
  }

  // 模型层级在哪一层，**每个出口都要回答**（dry 也不例外——桥的 summary 靠它写
  // `model: on|off(missing)`，用户先要知道此刻跑在哪个层级，再谈结果可不可信）。
  // 默认**只有一个层级**：真模型。`--ablate` 是**消融实验**的开关，不是"另一种跑法"——
  // 它的存在只为回答"没有这一层会怎样"（本仓库的每条主张都靠这种 A/B 立起来），
  // 所以名字里带 ablate、产物里带 ablation 前缀，谁都不会把它当成日常模式。
  // （旧 `--no-model` 有两个问题：① 它装的其实是脚本桩，却把层级标成 `off(rules-only)`；
  //  ② "no model" 听起来像默认路径的替代，于是所有文档示例都带着它跑，真模型反而从没上过场。）
  const ablate = v.ablate;
  if (ablate !== undefined && ablate !== "stub" && ablate !== "rules-only") {
    console.error(`--ablate 只接受 stub | rules-only（收到 ${JSON.stringify(ablate)}）`);
    return 2;
  }
  if (v["force-hints"] !== undefined && v["force-hints"] !== "off") {
    console.error(`--force-hints 只接受 off（收到 ${JSON.stringify(v["force-hints"])}）——它是消融旗标，只有"剥掉"这一档。`);
    return 2;
  }
  // §provider 层：`--provider` 选决策模型（换模型做测试的那条路）；`--ablate` 保留为消融简写。
  // 解析与安装分开做（resolveProviderSpec），因为中间必须插进**决策缓存与咨询计数**——
  // 少了它们，`模型边际`/`梯级账单`/缓存命中率三组数就不存在了。
  const providerWanted = v.provider
    ?? (ablate === "stub" ? "scripted-stub" : ablate === "rules-only" ? "none" : undefined);
  let spec;
  try {
    spec = await resolveProviderSpec(providerWanted);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const artifacts = checkArtifacts();
  const modelStatus = spec.tier;

  if (v.dry) {
    let dryOut;
    try {
      dryOut = expandPack(pack, slots, planPath);
    } catch (e) {                                  // 坏包也要干净地报错（exit 2），不是抛栈
      console.error(e instanceof Error ? e.message : String(e));
      return 2;
    }
    const { plan, steps, rolesUsed } = dryOut;
    console.log(JSON.stringify({
      app: pack.id, roles_used: rolesUsed, slots: plan.slots,
      goal: plan.goal, steps, subgoals: plan.subgoals, model_status: modelStatus,
    }, null, 2));
    return 0;
  }

  // 两层包装，各数一件事：缓存记"省下的重复提问"（零成本率），计数记"模型被咨询过几次"
  // （出场率）——计数在缓存**外面**：命中也是一次咨询，只是没花 forward。
  // laya 是确定性的，同一问题不该问两次；命中率本身就是要报的数（LAYA_VALUE_PLAN P1）。
  // `rules-only` 消融**不装任何 runtime**（走执行器真正的 rulesOnly 路径），
  // `stub` 消融装一个恒定 0.05 的桩（回答"问了但永远不过闸门"的形状）。两者都不是默认。
  if (spec.kind === "laya" && !spec.ablation && !artifacts.ready) {
    console.log(`（模型产物不齐——缺 ${missingPieces(artifacts).join("/")}；需要模型兜底的步会如实 block。`
      + `补齐：npm run model:fetch -- --from <url 或本地路径>）`);
  }
  // 安装序列收敛进 applySpecToRuntime——apps/suite/start/bench 四个门共用这一个实现
  //（此前这里是手抄的一份、apps_suite 里还有第二份；"两份实现各扫各的"是本仓库的复发缺陷形状。
  //  细则注释跟着函数走了：两层包装各数什么、provider 为什么不套缓存，见 decision-provider.ts。）
  const applied = await applySpecToRuntime(spec);

  // R2：学习环的 sidecar。**学到的永不进被审计的包**（plan-cli `--learn-hints` 的同一条纪律，
  // 由 tests/plan-cli-hints.test.ts 钉过：包文件逐字节不变，学到的只出现在 sidecar）。
  // 默认落 `$AMBERFLOW_HOME/hint-memory/<app>.json`（用户作用域，不写 checkout）；
  // `--hint-memory FILE` 显式指定。都不给 ⇒ null ⇒ 执行器与产物逐字节不变。
  let hintMemory: HintMemoryLike | null = null;
  let hintMemoryPath: string | null = null;
  if (v["learn-hints"] === true || v["hint-memory"]) {
    hintMemoryPath = v["hint-memory"]
      ? path.resolve(String(v["hint-memory"]))
      : path.join(path.dirname(userAppsDir()), "hint-memory", `${pack.id}.json`);
    try {
      ensureDir(path.dirname(hintMemoryPath));
    } catch (e) {
      console.error(`--hint-memory 落点建不出来：${hintMemoryPath}（${e instanceof Error ? e.message : String(e)}）`);
      return 2;
    }
    hintMemory = createHintMemory({ path: hintMemoryPath });
    if (!v.quiet) {
      console.log(`learned hints: ${hintMemory.stats?.().entries ?? 0} known（sidecar ${hintMemoryPath}）`);
    }
  }

  // --conf-floor：显式覆盖闸门刻度；范围错误是**用法错误**（退出码 2），不是静默忽略。
  let cliConfFloor: number | undefined;
  if (v["conf-floor"] !== undefined) {
    const n = Number(v["conf-floor"]);
    if (!Number.isFinite(n) || n <= 0 || n > 1) {
      console.error(`--conf-floor 要是 (0, 1] 之间的数（拿到 ${JSON.stringify(v["conf-floor"])}）`);
      return 2;
    }
    cliConfFloor = n;
  }

  let result: AppRunResult;
  try {
    result = await runApp(pack, {
      slots, planPath, outDir, verbose: !v.quiet,
      sources: !v["no-sources"], confirmSafe: v["confirm-safe"] === true, headful: v.headful === true,
      allowDangerous: v["allow-dangerous"] === true,
      // §3：只有**显式给了旗标**才算"本次覆盖"；否则留 undefined，让包声明赢。
      // （以前这里恒传一个布尔，等于 CLI 永远压过 pack——报告还会把来源写成 cli，假账。）
      tieredHint: v["tiered-hint"] === true ? true : undefined,
      forceHints: v["force-hints"] === "off" ? true : undefined,
      hintMemory, hintMemoryPath,
      confFloor: cliConfFloor,
      providerFloor: activeProviderInfo()?.floor,
      modelId: v.model ?? pack.model ?? "english",
      modelStatus,
      providerInfo: activeProviderInfo() ?? {
        name: spec.name, version: spec.kind === "laya" ? "runtime" : "n/a",
        capabilities: { choice: spec.kind !== "none", risk: spec.kind === "laya", done: spec.kind === "laya",
          shortlist: spec.kind === "laya", score_kind: spec.kind === "laya" ? ("entropy_conf" as const) : ("rank_only" as const) },
      },
      runtimeStats: applied.stats ?? undefined,
      pickAsks: applied.asks ?? undefined,
    });
  } catch (e) {
    // 坏包（未知键/角色/占位符/主机……）在 `expandPack` 里就抛出：CLI 的契约是
    // "报清楚 + 退出码 2"，不是把栈甩给用户。
    // 配置类错误单独走 stdout（I-1 验收：`model-unavailable` 出现在输出里、
    // 退出码非 0、产物文件**不存在**——预检在任何腿之前，这里没有可落的盘）。
    if (e instanceof AppRunConfigError) {
      console.log(e.message);
      console.log(`（未开跑：0 步、0 副作用；配置类错误不进重试循环）`);
      return 2;
    }
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  } finally {
    installLayaRuntime(null);
  }

  const jsonPath = path.join(outDir, `${pack.id}-result.json`);
  const mdPath = path.join(outDir, `${pack.id}-report.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf-8");
  fs.writeFileSync(mdPath, appReportMarkdown(result), "utf-8");
  if (!v.quiet) {
    console.log();
    console.log(appReportMarkdown(result));
    // R2 的账（plan-cli 同一形状）：known = sidecar 里现存几条；reused = 本次真的按它命中的次数。
    if (result.hint_memory) {
      console.log(`learned hints: ${result.hint_memory.entries} known, `
        + `${result.hint_memory.used} reused this run（sidecar ${result.hint_memory.path}）`);
    }
    console.log(`写入 ${jsonPath} 与 ${mdPath}`);
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
