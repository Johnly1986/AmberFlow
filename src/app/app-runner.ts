/**
 * 应用运行器 —— `apps/<app>/app.mjs` 的 `flow(ctx)` 跑完一条完整链路：
 *
 *   数据腿（`sources`，同一套 datasource 引擎）
 *        ↓
 *   脚本（`flow`）：`ctx.step` / `ctx.arrive` → 唯一的生产执行器
 *                   `ctx.run` / `ctx.dangerous` → 进程观察面信号 + 干跑/确认/幂等
 *        ↓
 *   验收（`ctx.done()` 在同一浏览器会话的结束状态上断言 `meta.invariants`）
 *
 * 它**不分叉执行器**：浏览器步就是 `runSubgoalWithRetries`（执行循环
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
 *   node --experimental-strip-types src/app/app-runner.ts --app <id>                  # 真模型（默认）
 *   node --experimental-strip-types src/app/app-runner.ts --app <id> --ablate stub     # 消融：脚本桩
 *   node --experimental-strip-types src/app/app-runner.ts --app <id> --dry             # 只展开计划
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { MockAuditor, type TraceStep } from "../engine/audit.ts";
import { createHintMemory, type HintMemoryLike } from "../model/hint-memory.ts";
import { ensureDir, userAppsDir } from "./amberflow-home.ts";
import { appOptions, cliBool, cliString, cliStrings, parseCliArgs } from "../support/cli-args.ts";
import { applyConfiguredEnv } from "../support/apply-config-env.ts";
import { parseRunDefaults } from "../support/run-defaults.ts";
import {
  cliRunDetailed, defaultDates, loadSource, previewTable, runSource, urlFor, ValueError,
  type CliObservation, type PreviewTable,
} from "../data/datasource.ts";
import { type CachedRuntime, type DecisionCacheStats } from "../model/decision-cache.ts";
import { checkArtifacts, missingPieces, modelConfigError } from "../model/model-artifacts.ts";
import { resolveLocalCheckpoint } from "../model/checkpoint.ts";
import { activeProviderInfo, applySpecToRuntime, resolveProviderSpec, type ProviderInfo } from "../model/decision-provider.ts";
import { BrowserMiddleware, browserSession, disallowedHost, type BrowserSession } from "../engine/executor.ts";
import { REPO } from "../flow/flow.ts";
import { installLayaRuntime } from "../model/model.ts";
import { runSubgoalWithRetries } from "../engine/planner.ts";
import { DESTRUCTIVE_PATTERNS } from "../engine/rules.ts";
import { checkSignal } from "../engine/signals.ts";
import { checkToolSignal, type ToolSignal } from "../browser/tool-signals.ts";
import { captureStateView } from "../flow/signal-induction.ts";
import { captureStepStateView, type StepStateView } from "../model/page-context.ts";
import type { StateView } from "../engine/signals.ts";
import {
  expandPack, listAppDirs, resolveSourceSlots,
  type AppPack, type ExpandedStep, type PackPace, type PackPolicy, type SourceObservation,
} from "./app-pack.ts";
import {
  getAppAdapter, substituteDatasetPlaceholders,
  type AdapterRunContext, type ManualStepDecl, type ManualStepRequest, type ManualStepRun,
} from "./app-adapters.ts";
import { validateApp } from "./cross-ref.ts";
import { SECRET_SLOT_NAME, maskSecretSlots, scrubSecrets, secretSlotKeys, secretValuesFromSlots } from "./redaction.ts";
import { dryRunFlow, loadScriptApp, type LoadedScriptApp } from "./app-script.ts";
import { StopError, createCtx, type ToolRunRequest, type ToolRunResult } from "./ctx.ts";
import { createReplayCtx } from "./ctx-replay.ts";
import {
  finishTrace, inputsSha256, newTrace, readTrace, replayCompatibility, writeTrace, type AppTrace,
} from "./trace.ts";
import { DatasetStore, type DatasetEntry } from "../engine/dataset.ts";
import { createPathWalk, DEFAULT_MAX_STEP_VISITS } from "../engine/plan.ts";
// 规划引导：run 失败时按停因给一行「下一步建议」（唯一出处 planning-playbook.ts，
// 只进 report.md 与 stdout，不动 result JSON 契约——桥解析零风险）。
import { nextForStop, STOP_ESCALATION_TEXT } from "../engine/planning-playbook.ts";

/** 进程内运行序号：保证同一毫秒内连续两次运行也不会撞上同一个 `{run_id}`。 */
let RUN_SEQ = 0;

/** 相对 start_url 按仓库根解析成 file://。 */
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
  /**
   * 时钟缝：把"今天"钉成 `YYYY-MM-DD`（CLI `--today`）。影响数据腿的相对日期表达式
   * （`day_offset` / `next_week` / `weekday_cn`）与 flow 脚本的 `ctx.runtime.today`。
   * 空缺 = 系统日期。（2026-10-28 起不再是环境变量 `LAYA_TODAY`——时钟不是机器配置，
   * 是本次调用的显式参数。）
   */
  today?: string;
  /**
   * 数据腿/工具步日期参数的**完整值袋**（包默认 + CLI `--slot`；调用方负责合并）。
   * 缺省回落到 `slots`（只有 CLI 覆盖）——两个调用方（runApp 的旅程与脚本 toolRunner）
   * 都显式传合并后的袋，source JSON 里的 `{slot}` 占位符从这解析。
   */
  slotBag?: Record<string, unknown>;
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
   * `--force-hints off`：**只在内存里**剥掉计划点名的
   * `target_hint`/`target_hints`，让本来被规则包办的步改由决策层回答——"模型到底行不行"
   * 的对照跑法。**包文件一个字节不动**（它是被审计的冻结产物，剥完不许落回去）。
   * 结果 JSON 会写 `hint_ablation: true`：消融跑的产物不许冒充普通跑。
   */
  forceHints?: boolean;
  /**
   * S0（NL Flow）：把每个浏览器子目标的执行证据带进结果
   * （`step_traces`：desc / 状态 / 每一步的 how、desc、method）。提名实验台用它从
   * **已验收语料的实际执行**里取真值指令（truth = 这一步真的执行了什么动作）。
   * 默认关：不开时结果 JSON 与今天逐字节相同（缺省等价纪律，`end_state` 同款）。
   */
  captureTraces?: boolean;
  /**
   * S0 上下文实验：把**每步开始时**的页面状态
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
   * 由 `--tiered-hint` / 桥的 `tiered_hint` 打开，用于线上包 A/B。
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
   * 实测 token-plan 在 camera-entry 上有一枪 0.20 被 0.25 硬阻塞。
   */
  confFloor?: number;
  /** provider 自报的闸门刻度（`ProviderInfo.floor`；CLI 装了 provider 就传进来）。 */
  providerFloor?: number;
  /** 非交互调用遇到 manual 步时：不启动浏览器，直接返回 needs_human 结果。 */
  manualFailFast?: boolean;
  /** 分段运行：只跑第 N 步（1-based，`expanded.steps` 的声明序号）。不能与 fromStep 同用。 */
  onlyStep?: number;
  /** 分段运行：从第 N 步开始（1-based）。 */
  fromStep?: number;
  /** 分段运行：本次最多执行几步（与脚本应用的 ctx maxSteps 区分）。 */
  segmentMaxSteps?: number;
  /**
   * `confFloor` 的来源：`cli`（本次命令旗标）或 `config`（配置文件默认值）。
   * 只影响 `effective_policy` 的账，不改变数值；缺省按 `cli` 记（兼容既有调用）。
   */
  confFloorSource?: "cli" | "config";
  /**
   * 人工步的接入钩子（测试/嵌入方）。缺省 = 终端交互提示；返回 false = 人放弃。
   * CLI 不提供"自动 yes"：人工步必须真的有人；这是它与"自动登录"的分界。
   */
  manualHandler?: (req: ManualStepRequest) => boolean | Promise<boolean>;
  /** 运行节奏覆盖（本次显式；缺省 = pack.pace > 环境变量 > 0）。 */
  pace?: PackPace;
}

/** 一次运行的节奏生效值（报告只写非零值；缺省字段不出现 = 与今天逐字节一致）。 */
export type PaceSource = "explicit" | "meta" | "env" | "default";
export interface ResolvedPace {
  between_steps_ms: number;
  between_actions_ms: number;
  /**
   * 每个字段的生效来源（与 `effective_policy` 同一标源纪律；01 轮 B5：作者看到 1000ms
   * 却不知从哪来）。`env` 含入口引导时从 `configs/amberflowrc.json` / amber config 吸收进
   * 环境变量的值——想区分到具体文件，用 `amber doctor` / `amber config show` 对照。
   */
  sources: { between_steps_ms: PaceSource; between_actions_ms: PaceSource };
}

/** 环境默认节奏（可被 pack/本次覆盖；坏值 = 配置类错误，响亮而不是静默当 0）。 */
export function resolvePace(
  pack: Pick<AppPack, "pace">,
  opts: Pick<AppRunOptions, "pace"> = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPace {
  const fromEnv = (key: string): number | undefined => {
    const raw = env[key];
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 60_000) {
      throw new AppRunConfigError(`${key}=${JSON.stringify(raw)} 不合法：需要 0..60000 的整数毫秒`);
    }
    return n;
  };
  const pick = (key: keyof PackPace): { value: number; source: PaceSource } => {
    const explicit = opts.pace?.[key];
    if (explicit !== undefined) return { value: explicit, source: "explicit" };
    const declared = pack.pace?.[key];
    if (declared !== undefined) return { value: declared, source: "meta" };
    const envKey = key === "between_steps_ms" ? "AMBERFLOW_STEP_DELAY_MS" : "AMBERFLOW_ACTION_DELAY_MS";
    const fromE = fromEnv(envKey);
    return fromE !== undefined ? { value: fromE, source: "env" } : { value: 0, source: "default" };
  };
  const steps = pick("between_steps_ms");
  const actions = pick("between_actions_ms");
  return {
    between_steps_ms: steps.value,
    between_actions_ms: actions.value,
    sources: { between_steps_ms: steps.source, between_actions_ms: actions.source },
  };
}

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
   * 梯级账单：每一级"到达 / 决定 / 问了但没过闸门"。
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
  refused?: "dangerous" | "declined" | "dry-run-failed" | "tool-unavailable" | "needs_value" | "config_error";
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
  "config_error": "未执行（source 日期参数配置错：default_dates/槽位值非法或缺值——补 --slot 或修 source JSON）",
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
  /**
   * 数据源声明了 `report.preview` 时的"前 N 条原始行"（`previewTable` 算，与数据源
   * 报告同一个实现）。counts/selects 是**结论**，原始行是**证据**——报告两者都要有，
   * 否则"为什么是这个数"只能靠信。
   */
  preview?: PreviewTable;
  tool_version?: string;
  /**
   * 按日期键控的完整观察（声明了 `default_dates: "{slot}"` / 范围且解析出多日期时）。
   * `rows`/`counts` 仍是第一天的快照（与 source_slots 回写同一口径）；被风控挡住的
   * 日期不进这张表（错误进数据源报告）。
   */
  byDate?: Record<string, {
    url?: string;
    counts: Record<string, number>;
    selects: Record<string, Record<string, string> | null>;
    rows: Array<Record<string, string>>;
  }>;
}

export interface AppRunResult {
  app: string;
  label: string;
  goal: string;
  pack_path: string;
  plan_path: string;
  /** 角色模板出场（01 轮 B7：flow 脚本路径恒空——空则整字段省略，产物不再带无解释的 `[]`）。 */
  roles_used?: string[];
  slots: Record<string, unknown>;
  completed: string;
  subgoals: Array<Record<string, unknown>>;
  tool_steps: ToolStepResult[];
  invariants: AppInvariantResult[];
  /** Slice 4：混用 ≥2 种应用类型时，按旅程声明的类型计数（缺字段 = 单一类型）。 */
  step_types?: Record<string, number>;
  sources: AppSourceResult[];
  /** 人工步骤的执行记录（缺字段 = 旅程里没有人工步，既有产物逐字节不变）。 */
  manual_steps?: Array<{
    index: number;
    desc: string;
    done: boolean;
    /** 人自证（`{manual:true}`），不是 DOM 验证。 */
    attested?: boolean;
    reason?: string;
  }>;
  /** 本次生效的节奏（缺字段 = 全 0 = 与今天逐字节一致）。 */
  pace?: ResolvedPace;
  /**
   * 数据腿**真的写回槽位**的那部分（`source_slots` 的回写结果）。缺字段 = 没有回写
   * （缺省等价纪律）。有了它，报告才说得出"这个值是查出来的，还是人写死的"。
   */
  source_slots?: Record<string, string>;
  ok: boolean;
  /** 本次是分段运行：`ok` 只代表段内步骤成功，不代表整条旅程验收。 */
  partial?: true;
  /** 完整旅程且不变量成立；分段跑为 false。 */
  verified?: boolean;
  /** 本次实际执行的声明步骤区间（1-based，闭区间）。 */
  segment?: { from: number; to: number };
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
    tiered_hint: { value: boolean; source: "cli" | "app" | "default" };
    risk_ask: { value: "always" | "rules-only"; source: "app" | "default" };
    reobserve: { value: boolean; source: "app" | "default" };
    max_effective_repeats: { value: number; source: "app" | "default" };
    conf_floor: { value: number; source: "cli" | "config" | "app" | "provider" | "default" };
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
    /** step/arrive 的落地 URL；tool 步没有。 */
    url?: string;
    /** 失败时的结构化停因。 */
    stop_code?: string;
    /** 该次调用的结构化结果摘要（与 trace event 的 result 同一口径）。 */
    result?: unknown;
    /** `captureStateView: true` 时这一步**开始时**的页面状态（缺字段 = 没开，缺省等价纪律）。 */
    state_view?: StepStateView;
    /** 该 step 曾 transient failed，但后续 step / done 信号成立（仅引擎/驱动观察，不改变完成真值）。 */
    recovered?: boolean;
    /** 恢复它的后续 step 标识/描述（仅 recovered=true 时出现）。 */
    recovered_by?: string | null;
  }>;
  /** `ctx.log` 摘要（Agent 不必再读 emit-trace 就能看到业务事实）。 */
  logs?: Array<{ i: number; desc: string; result?: unknown }>;
  /**
   * L2 脚本应用的运行账（缺字段 = 旧 `pack.json` 应用，产物逐字节不变）。
   * 脚本应用的"完成了什么"在**轨迹**里，不在静态计划里——这三样是审计最小集。
   */
  script?: {
    mode: "flow";
    script_path: string;
    /** 执行了多少个 `ctx.step`/`ctx.arrive`（含未完成的尝试；flow 的"步骤总数"只能是运行期事实）。 */
    steps: number;
    script_sha256: string;
    plan_sha256: string;
    trace_path?: string;
    stop_code?: string;
    stop_reason?: string;
  };
}

/** 跑一个工具步：干跑（若声明）→ 确认（若不可逆）→ apply（按幂等性决定重试）。 */
export async function runToolStep(
  step: ExpandedStep, opts: AppRunOptions = {},
): Promise<ToolStepResult> {
  const rawTool = step.tool!;
  const src = loadSource(rawTool.source);
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
      // 替换的**唯一实现**在 `app-adapters.substituteDatasetPlaceholders`——以前这里
      // 手抄了一份同名的正则，两份实现各扫各的正是本仓库的复发缺陷形状。
      const withRuntime = v.split("{out_dir}").join(outDir).split("{run_id}").join(runId);
      const { value, missing } = substituteDatasetPlaceholders(withRuntime, opts.dataset);
      for (const m of missing) missingDataset.add(m);
      return value;
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

  // 工具步的 source URL（default_dates / {slot} 日期参数在这里解析）。
  // 坏日期参数/缺槽位值是**配置类结果**（结构化 refusal），不是崩溃——上层能在结果 JSON 里读到。
  let target: string;
  try {
    target = urlFor(src, defaultDates(src, opts.slotBag ?? opts.slots ?? null, opts.today)[0]!);
  } catch (e) {
    if (e instanceof ValueError) {
      base.refused = "config_error";
      base.stderr = `source ${t.source}: ${e.message}`;
      if (opts.verbose) console.log(`  [${step.index}] tool ${t.source}: CONFIG_ERROR (${base.stderr})`);
      return base;
    }
    throw e;
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
 * 启动期预检（P0-5）：
 * `LAYA_ONNX_MODEL=/tmp/definitely-missing.onnx npm run apps -- --app <id>` 之前会
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

/** §3 生效策略的形状（`effective_policy` 产物字段的单一出处）。 */
export interface EffectivePolicy {
  tiered_hint: { value: boolean; source: "cli" | "app" | "default" };
  risk_ask: { value: "always" | "rules-only"; source: "app" | "default" };
  reobserve: { value: boolean; source: "app" | "default" };
  max_effective_repeats: { value: number; source: "app" | "default" };
  conf_floor: { value: number; source: "cli" | "config" | "app" | "provider" | "default" };
  done_timeout_ms: { value: number; source: "app" | "default" };
  done_poll_ms: { value: number; source: "app" | "default" };
  pool_ready_timeout_ms: { value: number; source: "app" | "default" };
  pool_ready_poll_ms: { value: number; source: "app" | "default" };
}

/**
 * §3：运行策略的**生效值与来源**（CLI 本次显式 > meta.policy > provider 自报 > 缺省）。
 *
 * 为什么抽成函数：旧的 `runApp` 与脚本驱动（`runScriptApp`）是两条执行入口——
 * 同名的 `policy.conf_floor` 必须在两条路上生效成**同一个值**，否则"meta 里写了策略"
 * 会随应用形态（数据脚本 vs flow 脚本）时灵时不灵。构造与报告读同一个对象，不分头各猜。
 */
export function resolveRunPolicy(pack: AppPack, opts: AppRunOptions = {}): {
  policy: EffectivePolicy; anyDeclared: boolean;
} {
  // §3：运行策略的**生效值与来源**在这里一次算清（构造与报告读同一个对象，不分两头各猜一遍）。
  // 优先级：CLI(本次显式) > meta.policy(声明) > 缺省(= 今天)。缺省一个都没动。
  const declaredPolicy = ((pack as unknown as Record<string, unknown>)["policy"] ?? {}) as PackPolicy;
  const policy: EffectivePolicy = {
    tiered_hint: {
      value: opts.tieredHint ?? declaredPolicy.tiered_hint ?? false,
      source: opts.tieredHint !== undefined ? "cli" as const
        : declaredPolicy.tiered_hint !== undefined ? "app" as const : "default" as const,
    },
    risk_ask: {
      value: declaredPolicy.risk_ask ?? "always",
      source: declaredPolicy.risk_ask !== undefined ? "app" as const : "default" as const,
    },
    reobserve: {
      value: declaredPolicy.reobserve ?? true,
      source: declaredPolicy.reobserve !== undefined ? "app" as const : "default" as const,
    },
    max_effective_repeats: {
      value: declaredPolicy.max_effective_repeats ?? 3,
      source: declaredPolicy.max_effective_repeats !== undefined ? "app" as const : "default" as const,
    },
    // 闸门刻度：CLI（本次显式）> meta.policy > provider 自报 > 0.25。
    // 换 provider 时缺省刻度不再成立（score_kind 不可比）——这是这条声明面的存在理由。
    conf_floor: opts.confFloor !== undefined
      ? { value: opts.confFloor, source: (opts.confFloorSource ?? "cli") as "cli" | "config" }
      : declaredPolicy.conf_floor !== undefined
        ? { value: declaredPolicy.conf_floor, source: "app" as const }
        : opts.providerFloor !== undefined
          ? { value: opts.providerFloor, source: "provider" as const }
          : { value: 0.25, source: "default" as const },
    done_timeout_ms: {
      value: declaredPolicy.done_timeout_ms ?? 2000,
      source: declaredPolicy.done_timeout_ms !== undefined ? "app" as const : "default" as const,
    },
    done_poll_ms: {
      value: declaredPolicy.done_poll_ms ?? 120,
      source: declaredPolicy.done_poll_ms !== undefined ? "app" as const : "default" as const,
    },
    pool_ready_timeout_ms: {
      value: declaredPolicy.pool_ready_timeout_ms ?? 700,
      source: declaredPolicy.pool_ready_timeout_ms !== undefined ? "app" as const : "default" as const,
    },
    pool_ready_poll_ms: {
      value: declaredPolicy.pool_ready_poll_ms ?? 100,
      source: declaredPolicy.pool_ready_poll_ms !== undefined ? "app" as const : "default" as const,
    },
  };
  const anyDeclared = Object.values(policy).some((p2) => p2.source !== "default");
  return { policy, anyDeclared };
}

/** 人工步的默认接入方式：终端里由人确认；非 TTY 不假装有人。 */
async function promptManualOnTty(req: ManualStepRequest): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error("manual step needs an interactive terminal (TTY)；"
      + "测试/嵌入方请注入 manualHandler，或直接在终端里运行");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n[manual] ${req.desc}`);
    if (req.instructions) console.log(`  ${req.instructions}`);
    if (req.url) console.log(`  页面：${req.url}`);
    const answer = await rl.question("  完成后按 Enter 继续；输入 n 放弃：");
    return answer.trim().toLowerCase() !== "n";
  } finally {
    rl.close();
  }
}

/** 跑一个应用包。返回结构化结果（报告与退出码都由调用方决定）。 */
export async function runApp(pack: AppPack, opts: AppRunOptions = {}): Promise<AppRunResult> {
  const {
    slots = {}, sources = true, confirmSafe = true, verbose = true,
    planPath = path.join(os.tmpdir(), "amberflow-apps", `${pack.id}-plan.json`),
    modelId = pack.model ?? "english",
  } = opts;
  const t0 = Date.now();
  const secretKeys = secretSlotKeys(
    [...Object.keys(pack.slots ?? {}), ...((pack.required_slots ?? []) as string[]), ...Object.keys(slots)],
    pack.secret_slots,
  );
  // 预检在**任何**腿之前：坏配置不该先跑数据腿再报错（I-1 的"0 副作用"就是这个位置）。
  preflightConfig(opts);
  // 节奏：本次显式 > pack.pace > 环境变量 > 0。缺省全 0 = 与今天逐字节一致。
  const pace = resolvePace(pack, opts);
  // 数据源的**配置**也在跑之前全部加载：`loadSource` 会在加载期跑 `validate_source`
  // （未知抽取器/op/transport 键、错的捕获组数……）。以前第 2 个源的坏配置要等第 1 个源
  // 真的打完网络才浮出来——网络副作用已经发生，报错却在半路。加载不产生副作用。
  {
    const cfgNames = new Set<string>();
    const isObj = (x: unknown): x is Record<string, unknown> =>
      typeof x === "object" && x !== null && !Array.isArray(x);
    for (const n of pack.sources ?? []) cfgNames.add(String(n));
    // 工具步引用的数据源同样在这一段加载（不再等展开之后——展开现在要等数据腿跑完，
    // 因为数据腿的结果要回写槽位）。
    for (const e of pack.journey ?? []) {
      if (!isObj(e)) continue;
      const rn = e["role"];
      const tpl = rn !== undefined && isObj(pack.roles?.[String(rn)]) ? pack.roles![String(rn)]! : {};
      const merged = { ...tpl, ...e };
      if (merged["source"] !== undefined) cfgNames.add(String(merged["source"]));
    }
    for (const n of cfgNames) loadSource(n);
  }
  // 坏包在**任何网络动作之前**就炸：校验是纯函数，放在数据腿之前是"0 副作用"纪律的另一半
  // （以前坏包要等数据腿打完一圈网络才被发现）。
  {
    const problems = validateApp(pack, { slots: { ...(pack.slots ?? {}), ...slots } });
    if (problems.length) {
      throw new Error(`app pack ${pack.id} is invalid:\n  - ${problems.join("\n  - ")}`);
    }
  }
  let endState: StateView | undefined;

  // ---- 数据腿：同一套数据源引擎（HTTP 或 CLI 通道） -------------------------
  // 它现在跑在**展开之前**：数据腿的结果要回写槽位（`source_slots`），而槽位替换发生在展开期。
  // 顺序从"展开 → 数据腿"改成"校验 → 数据腿 → 展开"，坏包仍然在任何网络动作之前就被拒
  // （校验已在上面单独跑过一遍）。
  const sourceResults: AppSourceResult[] = [];
  /** 数据腿的观察面（回写槽位的输入；与报告里的 counts/selects 同一份数据）。 */
  const observed: Record<string, SourceObservation> = {};
  if (sources) {
    // 数据腿的日期参数值袋 = 包默认槽位 + 本次 CLI 槽位（**不含** source_slots 产物——
    // 环封口由 validateApp 在上面校验：default_dates 引用数据腿产物 = 加载期拒绝）。
    const legSlots: Record<string, unknown> = { ...(pack.slots ?? {}), ...slots };
    for (const name of pack.sources ?? []) {
      const src = loadSource(String(name));
      const dates = defaultDates(src, legSlots, opts.today);
      const res = await runSource(src, dates, { verbose: false, today: opts.today });
      const day = Object.values(res.dates)[0] as Record<string, any> | undefined;
      const counts = (day?.counts ?? {}) as Record<string, number>;
      const selects: Record<string, string> = {};
      const selectsFull: Record<string, Record<string, string> | null> = {};
      for (const [k, row] of Object.entries((day?.selects ?? {}) as Record<string, any>)) {
        // 回写槽位要能取到**具体字段**（`selects` 只留一个"主值"是给报告看的；
        // 声明里点名 `field` 时得有整行）。
        selectsFull[k] = row
          ? Object.fromEntries(Object.entries(row as Record<string, unknown>)
            .map(([f, v]) => [f, String(v ?? "")]))
          : null;
        if (row) selects[k] = String(row.price ?? row.id ?? row.name ?? "");
      }
      observed[String(name)] = { selects: selectsFull, counts };
      const pv = previewTable(src, res.dates);
      // 多日期范围在这里保留完整观察（`dates` 键控）；回写槽位仍取第一天，口径不变。
      const byDate: NonNullable<AppSourceResult["byDate"]> = {};
      for (const [dateKey, entry] of Object.entries(res.dates)) {
        const e = entry as Record<string, any>;
        if (e?.error !== undefined) continue;
        byDate[dateKey] = {
          ...(e.url !== undefined ? { url: String(e.url) } : {}),
          counts: (e.counts ?? {}) as Record<string, number>,
          selects: (e.selects ?? {}) as Record<string, Record<string, string> | null>,
          rows: (e.rows ?? []) as Array<Record<string, string>>,
        };
      }
      sourceResults.push({
        name: String(name), rows: (day?.rows ?? []).length, counts, selects,
        ...(pv ? { preview: pv } : {}),
        ...(res.tool_version ? { tool_version: res.tool_version } : {}),
        ...(Object.keys(byDate).length ? { byDate } : {}),
      });
      if (verbose) console.log(`  source ${name}: ${(day?.rows ?? []).length} 条 ${JSON.stringify(counts)}`);
    }
  }

  // ---- 数据腿 → 槽位（回写的唯一实现在 `app-pack.resolveSourceSlots`） --------
  // 优先级：包里的默认值 < **数据腿查到的观测值** < CLI 显式 `--slot`。
  // 观测值压过默认值正是这条声明存在的理由（"打开榜首"的 URL 不该是人抄进包里的过期字面量）；
  // 而人这次显式给的值压过观测值——那是"这次就用这个"的显式意图。
  const sourceSlots = resolveSourceSlots(pack, observed);
  const expanded = expandPack(pack, { ...sourceSlots, ...slots }, planPath);
  const plan = expanded.plan;
  // 人工步默认开可见窗口：人在里面登录/过验证码；未选中的段内人工步不影响本次 headless 选择。
  // 相对 start_url 按仓库根解析成 file://：应用包写仓库内路径，
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

  // ---- 旅程：逐步骤按类型执行（浏览器步走执行器，工具步走命令行） -----------
  // §3：运行策略的生效值与来源见 `resolveRunPolicy`（脚本驱动共用同一份）。
  const { policy, anyDeclared } = resolveRunPolicy(pack, opts);
  // Slice 2（应用支持器）：运行级数据集——步骤信号成立后写入 `returns`，后续步骤以
  // `{dataset:NAME}` 消费；重跑（next 回边）前先失效，下游不会读到陈旧世代。
  const dataset = opts.dataset ?? new DatasetStore();
  const returnsByStep = new Map<string, string[]>();
  const runOpts: AppRunOptions = {
    ...opts, dataset,
    // 工具步的 source JSON 日期参数用同一个值袋（包默认 + CLI 覆盖）。
    slotBag: { ...(pack.slots ?? {}), ...(opts.slots ?? {}) },
  };
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
    // 动作间最小等待（应用配置表 `pace.between_actions_ms` / 环境变量；0 = 今天的行为）。
    actionDelayMs: pace.between_actions_ms,
    // M0 起默认安全：拒绝破坏性浏览器动作；`confirmSafe: false`（CLI `--confirm-unsafe`
    // 或 AMBERFLOW_CONFIRM_SAFE=0）才恢复旧的"风险只记录不阻断"。
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
      // 人工步默认开可见窗口：人要在里面登录/过验证码；`--headful` 只是显式同义。
      const headless = opts.headful !== true && !manualInSegment;
      holder.session = own ? await browserSession(headless, device) : await opts.sessionFactory!();
    }
    const s = holder.session;
    // 会话的生命周期由本函数掌握：执行器关掉的是这个壳，真正的 page 留到不变量之后。
    return { page: s.page, pw: s.pw, browser: s.browser, close: async () => {} };
  };

  const runManualStep = async (decl: ManualStepDecl, st: ExpandedStep): Promise<ManualStepRun> => {
    let page: BrowserSession["page"] | null = null;
    let url: string | null = null;
    if (decl.start_url !== null) {
      const target = startUrl(decl.start_url);
      const denied = disallowedHost(target, pack.hosts ?? null);
      if (denied !== null) {
        return { done: false, reason: `host_not_allowed: '${denied}' is not among the declared hosts` };
      }
      const shell = await getShell();
      try {
        await (shell.page as unknown as { goto(u: string, o?: unknown): Promise<unknown> })
          .goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (e) {
        return { done: false, reason: `navigation_failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      page = shell.page;
      url = target;
    } else if (holder.session !== null) {
      page = holder.session.page;
      try { url = String((page as unknown as { url(): string }).url()); } catch { url = null; }
    }
    if (verbose) {
      console.log(`  [manual] step ${st.index}: ${decl.desc}`);
      if (decl.instructions) console.log(`    ${decl.instructions}`);
      if (url) console.log(`    页面：${url}`);
    }
    let approved: boolean;
    const req: ManualStepRequest = {
      index: st.index, desc: decl.desc,
      instructions: decl.instructions ?? "", url,
    };
    try {
      approved = opts.manualHandler !== undefined
        ? await opts.manualHandler(req)
        : await promptManualOnTty(req);
    } catch (e) {
      return { done: false, reason: `manual_handler_error: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!approved) return { done: false, reason: "declined" };
    // `{manual:true}` = 人自证（报告记 attested）；任何 DOM 信号都要引擎再验一遍。
    if ("manual" in decl.signal) return { done: true, attested: true };
    if (page === null) {
      return { done: false, reason: "manual DOM signal needs a page (declare start_url or run after a browser step)" };
    }
    const held = await checkSignal(page as never, decl.signal);
    return held ? { done: true, attested: false } : { done: false, reason: "manual_signal_not_held" };
  };

  const toolSteps: ToolStepResult[] = [];
  const manualSteps: NonNullable<AppRunResult["manual_steps"]> = [];
  const invariantResults: AppInvariantResult[] = [];
  /** 每一步的判定方式（trace 原样收集）——P1 的出场率/挽回数从这儿数出来，不另造机制。 */
  const decisionSteps: TraceStep[] = [];
  /** 每个 `ctx.step` 一次 mw.run；这里按调用顺序保留它的动作 trace，供 step_traces 补 hows/descs/methods。 */
  const decisionStepGroups: TraceStep[][] = [];
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
  // 应用支持器运行上下文：web/cli 两个内建适配器
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
    runManualStep,
  };
  // ---- 分段调试：只跑一段声明步骤（Phase 3）。完整跑保持原逻辑。 -----------------
  const segmentRequested = opts.onlyStep !== undefined || opts.fromStep !== undefined
    || opts.segmentMaxSteps !== undefined;
  if (opts.onlyStep !== undefined && opts.fromStep !== undefined) {
    throw new AppRunConfigError("only_step 与 from_step 不能同时使用");
  }
  for (const [name, n] of [["only_step", opts.onlyStep], ["from_step", opts.fromStep], ["max_steps", opts.segmentMaxSteps]] as const) {
    if (n !== undefined && (!Number.isInteger(n) || n < 1)) {
      throw new AppRunConfigError(`${name} 需要正整数（收到 ${String(n)}）`);
    }
  }
  const segmentStart = opts.onlyStep !== undefined ? opts.onlyStep - 1
    : opts.fromStep !== undefined ? opts.fromStep - 1 : 0;
  if (segmentStart >= expanded.steps.length) {
    throw new AppRunConfigError(`step ${segmentStart + 1} 超出范围：这次展开只有 ${expanded.steps.length} 步`);
  }
  const segmentLimit = opts.onlyStep !== undefined ? 1
    : opts.segmentMaxSteps ?? Number.POSITIVE_INFINITY;
  const segmentEnd = Math.min(expanded.steps.length, segmentStart + segmentLimit);
  const segmentSteps = expanded.steps.slice(segmentStart, segmentEnd);
  const manualInSegment = segmentSteps.some((st) => st.adapter === "manual");
  // 非交互调用（桥）遇到本段的 manual 步：不猜、不假装有人在，也不在没有显示器时硬拉
  // headed 浏览器（那会变成一句 Playwright 启动失败）。直接返回结构化 needs_human。
  if (manualInSegment && opts.manualFailFast === true && opts.manualHandler === undefined && !process.stdin.isTTY) {
    const manualSteps = segmentSteps
      .filter((st) => st.adapter === "manual")
      .map((st) => ({ index: st.index, desc: st.desc, done: false, attested: false, reason: "needs_interactive_terminal" }));
    const selectedBrowserIndices = new Set(segmentSteps
      .map((st, i) => browserIndexOf[segmentStart + i] ?? -1)
      .filter((j) => j >= 0));
    return {
      app: pack.id, label: pack.label, goal: pack.goal,
      pack_path: pack._path ?? "", plan_path: planPath,
      ...(expanded.rolesUsed.length ? { roles_used: expanded.rolesUsed } : {}),
      slots: maskSecretSlots(expanded.slots, secretKeys),
      completed: `0/${segmentSteps.length}`,
      subgoals: plan.subgoals.map((sg, j) => ({
        desc: sg.desc,
        status: selectedBrowserIndices.has(j) ? (sg.status ?? "pending") : "skipped",
        attempts: sg.attempts ?? 0, obstacle: sg.obstacle ?? null,
      })),
      tool_steps: [], invariants: [], manual_steps: manualSteps,
      sources: [], ok: false, secs: 0,
      decisions: summarizeDecisions([], null, 0),
      ...(segmentRequested ? { partial: true as const, segment: { from: segmentStart + 1, to: segmentEnd } } : {}),
    };
  }
  const executedIndices = new Set<number>();
  let executedCount = 0;
  try {
    let i = segmentStart;
    while (i < expanded.steps.length && i < segmentEnd && executedCount < segmentLimit) {
      if (i < segmentStart) break;
      const step = expanded.steps[i]!;
      executedIndices.add(i);
      executedCount++;
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
      if (step.adapter === "manual") {
        manualSteps.push({
          index: step.index, desc: step.desc, done: outcome.done,
          // 显式写 false：报告能区分"DOM 验过"与"人自证"，缺字段会让两种证据看起来一样。
          attested: outcome.attested === true,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        });
        if (verbose) {
          console.log(`  [manual] step ${step.index}: ${outcome.done ? "done" : `not done (${outcome.reason ?? "unknown"})`}`
            + `${outcome.attested === true ? " [human attestation]" : ""}`);
        }
      }
      // 步间最小等待（应用配置表 `pace.between_steps_ms` / 环境变量；0 = 今天的行为）。
      if (pace.between_steps_ms > 0) await sleepMs(pace.between_steps_ms);
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
    // 分段跑不验收整条旅程：它不是“完整流程通过”，只是“这一段通过”。
    if (!segmentRequested) {
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
    }
  } finally {
    if (holder.session !== null) await holder.session.close();
  }

  // Slice 4：类型账（只在**混用 ≥2 种类型**的旅程里出现，既有应用产物逐字节不变）。
  const typeCounts: Record<string, number> = {};
  for (const st of expanded.steps) typeCounts[st.adapter] = (typeCounts[st.adapter] ?? 0) + 1;
  const stepTypes = Object.keys(typeCounts).length > 1 ? typeCounts : undefined;
  // 分段跑：没进入的浏览器步不是“阻塞”，而是“本次没走”；标成 skipped，避免摘要把
  // `from_step` 之前的 pending 误报成 blocked。
  const selectedBrowserSubgoals = plan.subgoals.filter((_, j) => {
    for (const idx of executedIndices) if (browserIndexOf[idx] === j) return true;
    return false;
  });
  if (segmentRequested) {
    const selected = new Set(selectedBrowserSubgoals);
    for (const sg of plan.subgoals) {
      if (!selected.has(sg) && sg.status === "pending") sg.status = "skipped";
    }
  }
  const subgoals = plan.subgoals.map((s) => ({
    desc: s.desc, status: s.status, attempts: s.attempts ?? 1, obstacle: s.obstacle ?? null,
  }));
  const browserOk = (segmentRequested ? selectedBrowserSubgoals : subgoals)
    .every((s) => s.status === "done" || s.status === "skipped");
  const toolsOk = toolSteps.every((t) => t.done);
  const manualOk = manualSteps.every((m) => m.done);
  // 路径上界到顶 = 这次旅程没有走完（即使被环卷进去的那一步恰好是工具步，也不能算绿）。
  const ok = browserOk && toolsOk && manualOk
    && (segmentRequested ? true : invariantResults.every((i) => i.held))
    && pathStopOut === undefined;
  // 数的是**声明出来的步**，不是"跑了几趟"：`next` 回边会让同一个工具步跑很多遍，
  // 那样 `completed` 会写出 `100/2` 这种读不通的数（真要读趟数看 `path_visits`）。
  const doneCount = (segmentRequested ? selectedBrowserSubgoals : subgoals)
    .filter((s) => s.status === "done" || s.status === "skipped").length
    + new Set(toolSteps.filter((t) => t.done).map((t) => t.index)).size
    + new Set(manualSteps.filter((m) => m.done).map((m) => m.index)).size;
  const stats = opts.runtimeStats ? opts.runtimeStats() : null;
  return {
    app: pack.id, label: pack.label, goal: pack.goal,
    pack_path: pack._path ?? "", plan_path: planPath,
    ...(expanded.rolesUsed.length ? { roles_used: expanded.rolesUsed } : {}),
    slots: maskSecretSlots(expanded.slots, secretKeys),
    completed: `${doneCount}/${segmentRequested ? executedIndices.size : expanded.steps.length}`,
    subgoals, tool_steps: toolSteps, invariants: invariantResults,
    ...(manualSteps.length ? { manual_steps: manualSteps } : {}),
    ...(pace.between_steps_ms > 0 || pace.between_actions_ms > 0 ? { pace } : {}),
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
    ...(anyDeclared && policy !== null ? { effective_policy: policy } : {}),
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
    sources: sourceResults,
    // 数据腿**真的写回**了哪些槽位（缺省等价：没回写就不出现这个字段）。
    ...(Object.keys(sourceSlots).length > 0
      ? { source_slots: maskSecretSlots(sourceSlots, secretKeys) as Record<string, string> }
      : {}),
    ok,
    verified: !segmentRequested && ok,
    ...(segmentRequested ? { partial: true as const, segment: { from: segmentStart + 1, to: segmentEnd } } : {}),
    secs: Math.round((Date.now() - t0) / 100) / 10,
  };
}

/** 结构化结果 → 人读的 Markdown（应用级证据：数据腿 + 旅程 + 不变量）。 */
export function appReportMarkdown(r: AppRunResult, nextHint?: string | null): string {
  const L: string[] = [
    `# 应用运行报告：${r.label}（\`${r.app}\`）`,
    "",
    `- 应用脚本：\`${r.pack_path}\``,
    `- 目标：${r.goal}`,
    `- 结果：**${r.ok ? "通过" : r.partial === true ? "部分执行（预算用满）" : "未通过"}** ｜ 步骤 ${r.completed} ｜ 用时 ${r.secs}s`,
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
        + `｜优先级 cli=本次命令覆盖 > app=meta 声明 > default=今天的行为`] : []),
    `- 角色：${(r.roles_used ?? []).map((x) => `\`${x}\``).join(", ") || "（未用角色模板）"}`,
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
    ...(nextHint ? ["", `> **下一步建议**：${nextHint}`] : []),
    ...(!r.ok ? ["", `> **停手规则**：${STOP_ESCALATION_TEXT}`] : []),
  ];
  if (r.sources.length) {
    L.push("", "## 数据腿", "", "| 数据源 | 行数 | counts | selects | 工具版本 |", "|---|---|---|---|---|");
    for (const s of r.sources) {
      L.push(`| ${s.name} | ${s.rows} | ${JSON.stringify(s.counts)} | ${JSON.stringify(s.selects)} | ${s.tool_version ?? "-"} |`);
    }
    // preview 行：数据源声明了 `report.preview` 就把前 N 条**原始行**带进应用报告——
    // counts/selects 是结论，原始行是它的证据（"为什么是这个数"不该只能靠信）。
    for (const s of r.sources) {
      if (!s.preview || s.preview.rows.length === 0) continue;
      L.push("", `**${s.name} · ${s.preview.date} 前 ${s.preview.rows.length} 条（原始行）**`, "",
        `| ${s.preview.columns.join(" | ")} |`, `|${"---|".repeat(s.preview.columns.length)}`);
      for (const row of s.preview.rows) {
        L.push(`| ${s.preview.columns.map((c) => row[c] ?? "").join(" | ")} |`);
      }
    }
    if (r.source_slots !== undefined && Object.keys(r.source_slots).length > 0) {
      L.push("", `- 数据腿回写槽位：${Object.entries(r.source_slots)
        .map(([k, v]) => `\`${k}\`=\`${v}\``).join(" ｜ ")}（观测值压过包里的默认值；本次显式 --slot 仍最优先）`);
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
  if (r.step_traces !== undefined && r.step_traces.length) {
    L.push("", "## 执行轨迹（flow 的 ctx.step / ctx.arrive）", "",
      "| # | id | 说明 | 状态 | URL | 停因 |", "|---|---|---|---|---|---|");
    for (const t of r.step_traces) {
      L.push(`| ${t.index + 1} | ${t.id ?? "-"} | ${t.desc.slice(0, 80)} | ${t.status} | ${t.url ?? "-"} | ${t.stop_code ?? "-"} |`);
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
  if (r.manual_steps !== undefined && r.manual_steps.length) {
    L.push("", "## 人工步骤（登录/验证码/人工确认）", "",
      "| # | 步骤 | 结论 | 证据 |", "|---|---|---|---|");
    for (const m of r.manual_steps) {
      const verdict = m.done ? "完成" : `**未完成**（${m.reason ?? "unknown"}）`;
      const evidence = m.done
        ? m.attested === true ? "人自证（{manual:true}，非 DOM 验证）" : "人完成后引擎验过声明的信号"
        : `未完成：${m.reason ?? "unknown"}`;
      L.push(`| ${m.index} | ${m.desc} | ${verdict} | ${evidence} |`);
    }
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

/** HTML 转义：证据报告 v0 的唯一出口（页面/应用来的值都要走这里）。 */
function htmlEscape(s: unknown): string {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 结构化结果 → 人可读 HTML 证据报告（v0：结论/槽位/步骤/不变量/证据锚点）。 */
export function appReportHtml(r: AppRunResult, nextHint?: string | null): string {
  const status = r.partial === true ? "partial" : r.ok ? (r.verified === false ? "ok（未验收）" : "ok") : "failed";
  const title = `应用运行报告：${r.label}（${r.app}）`;
  const L: string[] = [];
  L.push("<!doctype html>");
  L.push('<html lang="zh-CN"><head><meta charset="utf-8">');
  L.push(`<title>${htmlEscape(title)}</title>`);
  L.push("<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:960px;margin:32px auto;padding:0 20px;line-height:1.55;color:#1f2328}h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:1.8rem;border-bottom:1px solid #d0d7de;padding-bottom:.3rem}table{border-collapse:collapse;width:100%;margin:.6rem 0}th,td{border:1px solid #d0d7de;padding:.45rem .6rem;text-align:left;vertical-align:top}th{background:#f6f8fa;width:22%}code{background:#f6f8fa;padding:.1rem .3rem;border-radius:4px}.ok{color:#1a7f37;font-weight:600}.bad{color:#cf222e;font-weight:600}.muted{color:#57606a;font-size:.9rem}</style>");
  L.push("</head><body>");
  L.push(`<h1>${htmlEscape(title)}</h1>`);
  L.push('<p class="muted">由 <code>amber run</code> 生成；原始证据见同目录的 <code>-result.json</code> / <code>-report.md</code>（如有 <code>-report.html</code> 之外的文件）。</p>');
  L.push("<table>");
  L.push(`<tr><th>目标</th><td>${htmlEscape(r.goal)}</td></tr>`);
  L.push(`<tr><th>结论</th><td><span class="${r.ok ? "ok" : "bad"}">${htmlEscape(status)}</span>（完成 ${htmlEscape(r.completed)}；${htmlEscape(r.secs)}s）</td></tr>`);
  L.push(`<tr><th>应用</th><td><code>${htmlEscape(r.app)}</code> — ${htmlEscape(r.label)}</td></tr>`);
  if (r.script !== undefined) {
    L.push(`<tr><th>脚本</th><td><code>${htmlEscape(r.script.script_sha256)}</code>；${r.script.steps} 个 ctx.step/arrive</td></tr>`);
  }
  L.push("</table>");
  const slotKeys = Object.keys(r.slots ?? {});
  L.push("<h2>槽位（敏感槽位已脱敏）</h2>");
  if (slotKeys.length === 0) {
    L.push("<p>（无槽位）</p>");
  } else {
    L.push("<table><tr><th>键</th><th>值</th></tr>");
    for (const k of slotKeys) L.push(`<tr><td><code>${htmlEscape(k)}</code></td><td>${htmlEscape(JSON.stringify(r.slots[k]))}</td></tr>`);
    L.push("</table>");
  }
  L.push("<h2>执行证据</h2>");
  if (r.step_traces !== undefined && r.step_traces.length > 0) {
    L.push("<table><tr><th>#</th><th>步骤</th><th>结论</th><th>停因 / URL</th></tr>");
    for (const s of r.step_traces) {
      L.push(`<tr><td>${htmlEscape(s.index)}</td><td>${htmlEscape(s.id ?? s.desc)}</td><td>${htmlEscape(s.status)}</td><td>${htmlEscape(s.stop_code ?? s.url ?? "")}</td></tr>`);
    }
    L.push("</table>");
  } else {
    L.push(`<p>flow 脚本执行了 ${r.script?.steps ?? 0} 个 ctx.step/arrive；${r.script?.trace_path !== undefined ? `trace：<code>${htmlEscape(r.script.trace_path)}</code>` : "未落 trace（用 --emit-trace FILE 留证）"}。</p>`);
  }
  if (r.invariants.length > 0) {
    L.push("<h2>验收（结束状态不变量）</h2><table><tr><th>不变量</th><th>结论</th><th>说明</th></tr>");
    for (const inv of r.invariants) L.push(`<tr><td><code>${htmlEscape(inv.id)}</code></td><td>${inv.held ? '<span class="ok">成立</span>' : '<span class="bad">不成立</span>'}</td><td>${htmlEscape(inv.desc)}</td></tr>`);
    L.push("</table>");
  }
  if (r.manual_steps !== undefined && r.manual_steps.length > 0) {
    L.push("<h2>人工步骤</h2><table><tr><th>#</th><th>步骤</th><th>结论</th></tr>");
    for (const m of r.manual_steps) L.push(`<tr><td>${htmlEscape(m.index)}</td><td>${htmlEscape(m.desc)}</td><td>${m.done ? '<span class="ok">完成</span>' : `<span class="bad">未完成（${htmlEscape(m.reason ?? "unknown")}）</span>`}</td></tr>`);
    L.push("</table>");
  }
  if (r.sources.length > 0) {
    L.push("<h2>数据腿</h2><table><tr><th>源</th><th>行数</th></tr>");
    for (const s of r.sources) L.push(`<tr><td><code>${htmlEscape(s.name)}</code></td><td>${htmlEscape(s.rows)}</td></tr>`);
    L.push("</table>");
  }
  const stopCode = r.script?.stop_code;
  if (stopCode !== undefined) L.push(`<h2>结构化停因</h2><p><code>${htmlEscape(stopCode)}</code>：${htmlEscape(r.script?.stop_reason ?? "")}</p>`);
  if (nextHint) L.push(`<h2>下一步建议</h2><p>${htmlEscape(nextHint)}</p>`);
  if (!r.ok) L.push(`<h2>停手规则</h2><p>${htmlEscape(STOP_ESCALATION_TEXT)}</p>`);
  L.push('<p class="muted">本报告是 v0：只呈现结构化结果与已脱敏槽位；失败截图/DOM 可能含 PII，按证据敏感性处理。</p>');
  L.push("</body></html>");
  return L.join("\n") + "\n";
}

const USAGE = `usage: app-runner [--list] [--app ID] [--dry] [--slot k=v ...] [--slot-file FILE] [--out DIR]
                  [--provider NAME] [--ablate stub|rules-only]
                  [--conf-floor N] [--no-sources] [--confirm-safe | --confirm-unsafe] [--headful] [--allow-dangerous]
                  [--tiered-hint] [--trace] [--max-steps N] [--manual-fail-fast]
                  [--learn-hints | --hint-memory FILE] [--emit-trace FILE] [--replay FILE] [--quiet]

按 apps/<app>/app.mjs 的 flow(ctx) 跑一条应用：数据腿 → 脚本产生的浏览器/工具步 → 结束状态不变量
应用只有一种格式：flow 脚本（没有 pack.json / 声明式数据脚本 / 语义模板）。
--ablate       消融臂：stub = 脚本桩，rules-only = 规则档
--conf-floor N 置信度闸门刻度（0<N≤1）：换 provider（score_kind 不同）时缺省 0.25 不再成立，
               本旗标 = 本次覆盖；meta.policy.conf_floor 可声明；provider 可自报 floor
--tiered-hint  P1 实验开关：hint 档内歧义向模型问更小的问题（默认关 = 行为逐字节不变）
--trace        结果 JSON 带每步执行证据（step_traces）
--max-steps N  本次运行的 ctx.step/arrive 执行预算（调试用；用满后结果 partial，不是跳步）
--learn-hints  R2 学习环：模型选对的步变成规则（sidecar，永不写进被审计的脚本；authored 恒优先）
               落点默认 $AMBERFLOW_HOME/hint-memory/<app>.json，--hint-memory FILE 显式指定
--emit-trace F 把本次执行轨迹（app/script/inputs 三个 sha + 逐次 ctx 调用）写成 F
--replay F     按 F 里的轨迹重放（不重新决策；脚本版本或输入槽位不一致直接拒跑）
--today DATE   把"今天"钉成 YYYY-MM-DD：数据腿相对日期表达式（next_week/day_offset/weekday_cn）
               与 ctx.runtime.today 都用它；空缺 = 系统日期
--slot-file F  从 JSON 对象读槽位（避免明文进 argv/进程列表）；与 --slot 同名时 --slot 优先
               敏感槽位建议用 meta.secretSlots 声明：产物/报告/stdout 会自动掩码

数据腿的结果按 meta.sources 按需加载（ctx.source(name, { dates? })）；--no-sources 时不跑网络/进程。
数据腿的日期参数走声明槽位：source JSON 的 default_dates 写 "{slot}"（如 "{dates}"），
值从 包默认 slots + CLI --slot 解析（单日 / A..B 范围 / next_week）；不许引用 source_slots 产物（环）。
--dry 只跑 dry 调用序列（不开浏览器、不调模型）；--list 列出发现的 flow 应用。`;

/**
 * app-runner 默认产物目录（**调用时**读 env，测试可隔离）。
 */
export function appsOutDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AMBERFLOW_APPS_OUT ?? path.join(os.tmpdir(), "amberflow-apps");
}

/**
 * 跑一个 `flow(ctx)` 应用。运行时仍然只认数据与证据面：
 * 复用 `browserSession` / `BrowserMiddleware` / `runSource` / `checkSignal`。
 * 脚本负责控制流；一步之内的一切仍归引擎（见 `src/app/ctx.ts` 的注释）。
 */
export interface ScriptRunOptions extends AppRunOptions {
  /** `ctx.step`/`arrive` 的执行预算（`--max-steps`；用满后结果 partial）。 */
  maxSteps?: number;
  /** 把本次执行轨迹写成 JSON（审计/交接）。 */
  emitTrace?: string;
  /** 按一条已记录的轨迹重放（不重新决策；版本/输入不一致直接拒跑）。 */
  replayTrace?: string;
}

export async function runScriptApp(loaded: LoadedScriptApp, opts: ScriptRunOptions = {}): Promise<AppRunResult> {
  const pack = loaded.pack;
  const t0 = Date.now();
  const slots: Record<string, unknown> = { ...(pack.slots ?? {}), ...(opts.slots ?? {}) };
  const secretKeys = secretSlotKeys(
    [...Object.keys(slots), ...((pack.required_slots ?? []) as string[])],
    pack.secret_slots,
  );
  const secretValues = secretValuesFromSlots(slots, secretKeys);
  const planPath = opts.planPath ?? path.join(os.tmpdir(), "amberflow-apps", `${pack.id}-plan.json`);
  const outDir = opts.outDir ?? path.dirname(planPath);
  const runId = opts.runId ?? `${Date.now().toString(36)}-${process.pid}`;
  const inputs = inputsSha256(slots, (pack.hosts ?? []) as string[]);
  const trace = newTrace({ app: pack.id, script_sha256: loaded.scriptSha256, inputs_sha256: inputs });
  const verbose = opts.verbose !== false;
  // 节奏：CLI 显式 > meta.pace > 环境变量 > 0；与 runApp 共用同一个解析实现。
  const pace = resolvePace(pack, opts);

  let ok = false;
  let stopCode: string | undefined;
  let stopReason: string | undefined;
  let invariants: AppInvariantResult[] = [];
  // §3：策略在两条分支外声明（重放分支不构造执行器，但产物字段的形状要一致）。
  let policy: EffectivePolicy | null = null;
  let anyDeclared = false;
  /** 每次 ctx.step/arrive 的执行报告 → 决策账（与 runApp 同一份 `summarizeDecisions`）。 */
  const decisionSteps: TraceStep[] = [];
  /** 每个 `ctx.step` 一次 mw.run；这里按调用顺序保留它的动作 trace，供 step_traces 补 hows/descs/methods。 */
  const decisionStepGroups: TraceStep[][] = [];

  if (opts.replayTrace !== undefined) {
    const recorded = readTrace(opts.replayTrace);
    const problems = replayCompatibility(recorded, {
      app: pack.id, script_sha256: loaded.scriptSha256, inputs_sha256: inputs,
    });
    if (problems.length) throw new Error(`replay refused:\n  - ${problems.join("\n  - ")}`);
    const { ctx, remaining } = createReplayCtx({
      pack: pack as never, slots: slots as Record<string, string>,
      runtime: { outDir, runId, today: opts.today ?? "" },
      trace: recorded, maxSteps: opts.maxSteps,
    });
    try {
      await loaded.flow(ctx);
      ok = true;
      if (remaining() > 0) throw new StopError("trace_mismatch", `replay: script stopped but ${remaining()} recorded event(s) were not consumed`);
    } catch (e) {
      if (e instanceof StopError) { stopCode = e.code; stopReason = e.message; }
      else throw e;
    }
    invariants = invariantsFromTrace(recorded, pack);
    // 轨迹本身记录的是失败运行：重放的结论也必须失败（"结构一致"不等于"那次运行成功"）。
    if (recorded.done !== true) {
      ok = false;
      stopCode = recorded.stop_code ?? "replay_recorded_failure";
      stopReason = recorded.stop_reason ?? "the recorded run did not complete successfully";
    }
  } else {
    preflightConfig(opts);
    for (const n of pack.sources ?? []) loadSource(String(n));
    const holder: { session: BrowserSession | null } = { session: null };
    const ensureSession = async (): Promise<BrowserSession> => {
      if (holder.session === null) {
        const device = (pack.device ?? null) as Parameters<typeof browserSession>[1];
        holder.session = opts.sessionFactory !== undefined
          ? await opts.sessionFactory()
          : await browserSession(opts.headful !== true, device);
      }
      const session = holder.session;
      if (session === null) throw new Error("browser session was not created");
      return session;
    };
    // §3：与 `runApp` 共用同一份策略解析——否则脚本应用会静默忽略 meta.policy
    // （同一个 `policy.conf_floor` 在数据脚本上生效、在 flow 脚本上不生效）。
    const resolvedPolicy = resolveRunPolicy(pack, opts);
    policy = resolvedPolicy.policy;
    anyDeclared = resolvedPolicy.anyDeclared;
    let mw: BrowserMiddleware | null = null;
    const getMw = (): BrowserMiddleware => {
      if (mw === null) {
        mw = new BrowserMiddleware({
          modelId: pack.model ?? "english",
          auditor: new MockAuditor(),
          hosts: (pack.hosts ?? null) as string[] | null,
          maxSteps: 8,
          confFloor: resolvedPolicy.policy.conf_floor.value,
          riskyThreshold: 0.6,
          doneThreshold: 0.5,
          tieredHint: resolvedPolicy.policy.tiered_hint.value,
          riskAsk: resolvedPolicy.policy.risk_ask.value === "rules-only" ? "rules-only" : "always",
          reobserve: resolvedPolicy.policy.reobserve.value,
          maxEffectiveRepeats: resolvedPolicy.policy.max_effective_repeats.value,
          actionDelayMs: pace.between_actions_ms,
          hintMemory: opts.hintMemory ?? null,
          confirmFn: opts.confirmSafe === false
            ? (desc: string) => !DESTRUCTIVE_PATTERNS.some((x) => desc.toLowerCase().includes(x))
            : () => true,
        });
      }
      return mw;
    };
    /** 工具步：接到既有 `runToolStep`（干跑/确认/幂等重试的唯一实现，不复制）。 */
    const toolRunner = async (req: ToolRunRequest): Promise<ToolRunResult> => {
      // ① 非 cli 适配器：与声明式 journey 用**同一份**适配器实现（validate → expand → run）。
      //    以前 ctx.run 硬编码 `adapter:"cli"`，声明式能写的 ssh/stdio 步在 flow 脚本里不可表达。
      if (req.adapter !== undefined && req.adapter !== "cli") {
        const adapter = getAppAdapter(req.adapter);
        const base = { code: null as number | null, stdout: "", stderr: "", attempts: 0 };
        if (adapter === undefined) {
          return { ok: false, stopCode: "config_error", reason: `unknown app adapter ${JSON.stringify(req.adapter)}`, ...base };
        }
        const where = `ctx.run(${JSON.stringify(req.desc)})`;
        const raw = { ...(req.rawStep ?? {}), signal: req.done };
        const problems: string[] = [];
        let decl: unknown;
        try {
          adapter.validateStep(raw, where, problems);
          if (!problems.length) decl = adapter.expand(raw, where).decl;
        } catch (e) {
          return { ok: false, stopCode: "config_error", reason: e instanceof Error ? e.message : String(e), ...base };
        }
        if (problems.length) return { ok: false, stopCode: "config_error", reason: problems.join("；"), ...base };
        const step = {
          index: 0, adapter: adapter.kind, kind: adapter.legacyKind,
          desc: req.desc, role: null, id: null, next: [], decl,
        } as unknown as ExpandedStep;
        const adapterCtx = {
          outDir, verbose, runId, dataset: null,
          runWebStep: async (): Promise<{ done: boolean }> => { throw new Error("ctx.run: browser steps go through ctx.step()"); },
          runCliStep: async (): Promise<ToolStepResult> => { throw new Error("ctx.run: use the cli form for cli steps"); },
          runManualStep: async (): Promise<ManualStepRun> => ({
            done: false, reason: "manual steps are declared in the journey, not executed through ctx.run",
          }),
        };
        const out = await adapter.run(decl, step, adapterCtx);
        const t = out.tool;
        const stopCode = out.done ? undefined : (t?.refused ?? "tool_failed");
        return {
          ok: out.done,
          ...(stopCode === undefined ? {} : { stopCode }),
          ...(t?.refused === undefined ? {} : { refused: t.refused }),
          ...(t?.stderr ? { reason: t.stderr.split("\n")[0]!.slice(0, 300) } : {}),
          code: t?.code ?? null, stdout: t?.stdout ?? "", stderr: t?.stderr ?? "",
          attempts: t?.attempts ?? 1,
          ...(t?.dry_run ? { dryRun: t.dry_run } : {}),
        };
      }
      // ② cli（默认）：接到 runToolStep。
      const decl = {
        source: req.source,
        args: req.args ?? [],
        dry_run_args: req.dryRunArgs ?? null,
        signal: req.done as never,
        retries: req.retries ?? 0,
        idempotent: req.idempotent === true,
        dangerous: req.dangerous === true,
        returns: null,
      };
      const step = {
        index: 0, adapter: "cli", kind: "tool",
        desc: req.desc, role: null, id: null, next: [], decl, tool: decl,
      } as unknown as ExpandedStep;
      const r = await runToolStep(step, { ...opts, outDir, runId, verbose, slotBag: slots });
      const stopCode = r.done ? undefined : (r.refused ?? "tool_failed");
      return {
        ok: r.done,
        ...(stopCode === undefined ? {} : { stopCode }),
        ...(stopCode === undefined ? {} : { reason: refusalLine(stopCode) }),
        ...(r.refused === undefined ? {} : { refused: r.refused }),
        code: r.code, stdout: r.stdout, stderr: r.stderr, attempts: r.attempts,
        ...(r.dry_run === null ? {} : { dryRun: r.dry_run }),
      };
    };
    const ctx = createCtx({
      pack: pack as never,
      slots: slots as Record<string, string>,
      runtime: { outDir, runId, today: opts.today ?? "" },
      ensureSession, mw: getMw, trace, toolRunner,
      allowSources: opts.sources !== false,
      manualRunner: opts.manualHandler !== undefined || process.stdin.isTTY
        ? async (req) => {
            const handler = opts.manualHandler ?? promptManualOnTty;
            return handler({ index: 0, desc: req.desc, instructions: req.instructions, url: req.url });
          }
        : undefined,
      manualFailFast: opts.manualFailFast === true,
      stepDelayMs: pace.between_steps_ms,
      doneTimeoutMs: policy.done_timeout_ms.value,
      donePollMs: policy.done_poll_ms.value,
      poolReadyTimeoutMs: policy.pool_ready_timeout_ms.value,
      poolReadyPollMs: policy.pool_ready_poll_ms.value,
      onRunReport: (rep) => {
        const steps = rep.steps as TraceStep[];
        decisionSteps.push(...steps);
        decisionStepGroups.push(steps);
      },
      ...(opts.maxSteps === undefined ? {} : { maxSteps: opts.maxSteps }),
      verbose,
    });
    try {
      await loaded.flow(ctx);
      ok = true;
    } catch (e) {
      if (e instanceof StopError) { stopCode = e.code; stopReason = e.message; }
      else throw e;
    } finally {
      if (holder.session !== null) { try { await holder.session.close(); } catch { /* 关会话失败不该掩盖运行结果 */ } }
    }
    invariants = invariantsFromTrace(trace, pack ?? {});
  }

  // 人工步不能因为脚本“没 ctx.fail 就继续走”而变绿：人工没完成是全局未完成，
  // 即使后续步骤和结束态不变量都成立。脚本可以吞异常，但产物不能吞事实。
  const failedManual = trace.events.find((e) => e.call === "manual" && e.ok !== true);
  if (failedManual !== undefined) {
    ok = false;
    stopCode = stopCode ?? failedManual.stop_code ?? "needs_human";
    stopReason = stopReason ?? `manual step did not complete: ${failedManual.desc ?? failedManual.id ?? "?"}`;
  }

  // 声明了结束态不变量却从未调用 ctx.done()：**验收根本没发生**。
  // 以前这里 ok 仍为 true（suite 甚至会打"0/1 不变量 · 通过"）——那是最坏的一类假绿。
  const declaredInvariants = (pack.invariants ?? []).length;
  if (opts.replayTrace === undefined && ok && declaredInvariants > 0
    && !trace.events.some((e) => e.call === "done")) {
    ok = false;
    stopCode = "missing_done";
    stopReason = "flow ended without ctx.done(): declared end-state invariants were never verified";
  }
  // done 的失败判决**粘住**：脚本可以 `try { await ctx.done() } catch {}` 吞掉异常，
  // 但产物不能因此报绿——不变量没成立就是没通过（否则报告同页会写"不变量不成立"+"通过"）。
  if (ok && declaredInvariants > 0 && !invariants.every((i) => i.held)) {
    ok = false;
    stopCode = "invariant_failed";
    stopReason = "declared end-state invariants did not hold: "
      + invariants.filter((i) => !i.held).map((i) => i.id).join(", ");
  }
  // `--max-steps N` 是执行预算：用满时已经执行的步骤是事实，不是“配置错误”。
  const partial = stopCode === "budget_exceeded" && opts.maxSteps !== undefined;
  finishTrace(trace, {
    done: ok,
    ...(stopCode === undefined ? {} : { stop_code: stopCode }),
    ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
    invariants_ok: invariants.every((i) => i.held),
  });
  const tracePath = opts.emitTrace === undefined ? undefined : writeTrace(opts.emitTrace, scrubSecrets(trace, secretValues));
  if (verbose) {
    console.log(`=== app ${pack.id} (script/flow) ===`);
    for (const ev of trace.events) {
      if (ev.call === "log") continue;
      console.log(`  ${String(ev.i).padStart(2, " ")}. ${ev.call}${ev.desc ? ` ${ev.desc}` : ""}${ev.url ? ` → ${ev.url}` : ""}`
        + `${ev.ok === false ? ` [${ev.stop_code ?? "failed"}]` : ""}`);
    }
  }

  // 08-C：flow 路径的进程步（run/dangerous）同样进 step_traces——记录层一直有事件
  // （ctx.ts runTool/声明形式各有 pushEvent），缺的只是这里的投影准入；成功步嵌套
  // result 无 stop_code（B6 口径），失败行带 stop_code，作者不再只能靠脚本自 log。
  const stepEvents = trace.events.filter((e) =>
    e.call === "step" || e.call === "arrive" || e.call === "manual" || e.call === "run" || e.call === "dangerous");
  const stepCount = trace.events.filter((e) => e.call === "step" || e.call === "arrive").length;
  const manualSteps = trace.events.filter((e) => e.call === "manual").map((e, i) => ({
    index: i,
    desc: e.desc ?? "",
    done: e.ok === true,
    ...(e.ok === true && typeof e.result === "object" && e.result !== null
      && (e.result as Record<string, unknown>)["attested"] === true ? { attested: true } : {}),
    ...(e.stop_code === undefined ? {} : { reason: e.stop_code }),
  }));
  const TRANSIENT_STOP_CODES = new Set([
    "page_not_ready", "space_empty", "action_space_exhausted", "low_confidence",
    "no_progress", "stale_ref", "hint_matched_nothing",
  ]);
  let stepActionCursor = 0;
  const stepTraces: NonNullable<AppRunResult["step_traces"]> = stepEvents.map((e, i) => {
    const laterOk = stepEvents.slice(i + 1).find((s) => s.ok === true);
    const recovered = e.ok === false
      && e.stop_code !== undefined && TRANSIENT_STOP_CODES.has(e.stop_code)
      && laterOk !== undefined;
    // 只给 `ctx.step` 补动作证据；`ctx.arrive` / `ctx.manual` 不走 mw.run，没有动作 trace。
    const group = e.call === "step" ? decisionStepGroups[stepActionCursor++] ?? [] : [];
    const executed = group.filter((s) => s.executed === true);
    // when 守卫跳过的步（ok:false + precondition_skipped）不是失败：与声明式路径同一口径记成
    // "skipped"（见上方 rep.skipped 分支），审计者扫表即可分清“执行完成/不适用/失败”。
    const skippedStep = e.ok === false && e.stop_code === "precondition_skipped";
    return {
      index: i,
      id: e.id ?? null,
      desc: e.desc ?? "",
      status: recovered ? "recovered" : (e.ok === false ? (skippedStep ? "skipped" : "failed") : "done"),
      hows: executed.map((s) => String(s.how ?? "")),
      descs: executed.map((s) => String(s.desc ?? "")),
      methods: group.map((s) => String(s.method ?? "")).filter(Boolean),
      ...(e.url === undefined ? {} : { url: e.url }),
      // `dom_goal_signal` 这类是“done 已成立”的执行事实，不是失败；成功步不把它渲染成停因。
      ...(e.ok === false && e.stop_code !== undefined ? { stop_code: e.stop_code } : {}),
      ...(e.result === undefined ? {} : { result: e.result }),
      ...(recovered ? { recovered: true, recovered_by: laterOk!.id ?? laterOk!.desc ?? null } : {}),
    };
  });
  const logs = trace.events.filter((e) => e.call === "log").map((e) => ({
    i: e.i, desc: e.desc ?? "", ...(e.result === undefined ? {} : { result: e.result }),
  }));
  const stats = opts.runtimeStats ? opts.runtimeStats() : null;
  const decisions = summarizeDecisions(decisionSteps, stats, opts.pickAsks ? opts.pickAsks() : 0);
  const result: AppRunResult = {
    app: pack.id,
    label: pack.label ?? pack.id,
    goal: pack.goal,
    pack_path: loaded.scriptPath,
    plan_path: planPath,
    // flow 脚本路径没有角色模板（01 轮 B7）：空字段整条省略，产物不再带无解释的 roles_used:[]。
    slots: maskSecretSlots(slots, secretKeys),
    completed: `${trace.events.filter((e) => e.call === "step" || e.call === "arrive").length} step(s) via flow(ctx)`,
    subgoals: [],
    tool_steps: [],
    invariants,
    sources: [],
    ok,
    ...(partial ? { partial: true as const } : {}),
    ...(manualSteps.length ? { manual_steps: manualSteps } : {}),
    ...(pace.between_steps_ms > 0 || pace.between_actions_ms > 0 ? { pace } : {}),
    secs: (Date.now() - t0) / 1000,
    // §3：生效策略只在非缺省时进产物（与 runApp 同一纪律）；模型层级照写（脚本应用同样要能说清）。
    ...(anyDeclared && policy !== null ? { effective_policy: policy } : {}),
    ...(opts.modelStatus === undefined ? {} : { model_status: opts.modelStatus }),
    decisions,
    step_traces: stepTraces,
    ...(logs.length ? { logs } : {}),
    script: {
      mode: "flow",
      script_path: loaded.scriptPath,
      steps: stepCount,
      script_sha256: loaded.scriptSha256,
      plan_sha256: loaded.planSha256,
      ...(tracePath === undefined ? {} : { trace_path: tracePath }),
      ...(stopCode === undefined ? {} : { stop_code: stopCode }),
      ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
    },
  };
  return scrubSecrets(result, secretValues);
}

/** 从 trace 的 `done` 事件里取不变量结果（脚本应用的验收事实）。 */
function invariantsFromTrace(
  trace: AppTrace,
  pack: { invariants?: ReadonlyArray<{ id?: string; desc?: string }> },
): AppInvariantResult[] {
  const done = [...trace.events].reverse().find((e) => e.call === "done");
  const raw = done !== undefined && typeof done.result === "object" && done.result !== null
    ? (done.result as { invariants?: unknown }).invariants
    : undefined;
  const details = Array.isArray(raw) ? raw as Array<{ id?: unknown; held?: unknown }> : [];
  return (pack.invariants ?? []).map((inv) => {
    const id = String(inv.id ?? "?");
    const hit = details.find((d) => String(d.id ?? "?") === id);
    return { id, desc: String(inv.desc ?? ""), held: hit?.held === true };
  });
}


export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // rc 文件坏 = 配置类用法错误：在任何腿出场之前逐行点名并 exit 2（src/support/rcfile.ts）。
  { const rc = applyConfiguredEnv(); if (rc.errors.length) { for (const e of rc.errors) console.error(e); return 2; } }
  // 打错的参数 → 一行点名 + usage，绝不甩 parseArgs 的堆栈（src/support/cli-args.ts 的体例）。
  const cli = parseCliArgs(argv, { allowPositionals: true, options: appOptions(), usage: USAGE });
  if (!cli.ok) return cli.code;
  const v = cli.values;
  if (cliBool(v, "help")) { console.log(USAGE); return 0; }
  // 运行参数的配置默认值（全局 < 项目 < 环境变量；CLI 旗标仍最优先）。
  const { defaults: runDefaults, errors: runDefaultErrors } = parseRunDefaults();
  if (runDefaultErrors.length) {
    for (const e of runDefaultErrors) console.error(e);
    return 2;
  }
  const quiet = cliBool(v, "quiet") || runDefaults.quiet === true;
  const headful = cliBool(v, "headful") || runDefaults.headful === true;
  const confirmUnsafe = cliBool(v, "confirm-unsafe");
  const confirmSafe = !confirmUnsafe && (cliBool(v, "confirm-safe") || runDefaults.confirmSafe !== false);
  const noSources = cliBool(v, "no-sources") || runDefaults.noSources === true;
  const tieredHint = cliBool(v, "tiered-hint") || runDefaults.tieredHint === true;
  const maxStepsRaw = cliString(v, "max-steps");
  let maxSteps: number | undefined;
  if (maxStepsRaw !== undefined) {
    maxSteps = Number(maxStepsRaw);
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      console.error(`--max-steps 需要正整数（收到 ${JSON.stringify(maxStepsRaw)}）`);
      return 2;
    }
  }
  if (cliBool(v, "list") || cliString(v, "app") === undefined) {
    for (const entry of listAppDirs()) console.log(`${entry.id.padEnd(22)} ${entry.script}`);
    if (cliString(v, "app") === undefined) {
      if (!cliBool(v, "list")) {
        console.log(); console.log(USAGE);
        return 2;
      }
      return 0;
    }
  }

  const slots: Record<string, unknown> = {};
  const cliSlotKeys = new Set<string>();
  for (const s of cliStrings(v, "slot")) {
    const i = s.indexOf("=");
    if (i <= 0) { console.error(`--slot needs k=v, got ${JSON.stringify(s)}`); return 2; }
    const key = s.slice(0, i);
    cliSlotKeys.add(key);
    if (Object.prototype.hasOwnProperty.call(slots, key)) {
      console.error(`--slot ${JSON.stringify(key)} 给了两次（${JSON.stringify(slots[key])} 与 `
        + `${JSON.stringify(s.slice(i + 1))}）：一个槽位只能有一个值`);
      return 2;
    }
    slots[key] = s.slice(i + 1);
  }
  const slotFileArg = cliString(v, "slot-file");
  if (slotFileArg !== undefined) {
    let raw: unknown;
    const slotFile = path.resolve(slotFileArg);
    try {
      try {
        const st = fs.statSync(slotFile);
        if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
          console.error(`[warn] --slot-file ${slotFile} 对 group/other 可读（mode ${(st.mode & 0o777).toString(8)}）；建议 chmod 600`);
        }
      } catch { /* stat 失败交给下面的 readFileSync 报清楚 */ }
      raw = JSON.parse(fs.readFileSync(slotFile, "utf-8"));
    } catch (e) {
      console.error(`--slot-file 读不了或不是 JSON：${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      console.error("--slot-file 顶层必须是对象（槽位名 → 值）");
      return 2;
    }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const t = typeof value;
      if (t !== "string" && t !== "number" && t !== "boolean") {
        console.error(`--slot-file 的 ${JSON.stringify(key)} 必须是字符串/数字/布尔`);
        return 2;
      }
      if (Object.prototype.hasOwnProperty.call(slots, key)) {
        console.error(`--slot-file 的 ${JSON.stringify(key)} 被 --slot 覆盖`);
        continue;
      }
      slots[key] = value;
    }
  }
  for (const key of cliSlotKeys) {
    if (SECRET_SLOT_NAME.test(key)) {
      console.error(`[warn] --slot ${JSON.stringify(key)} 的明文会出现在进程参数/桥 argv；敏感值请用 --slot-file（或 meta/env）`);
    }
  }

  // --today：时钟缝（数据腿相对日期表达式 + ctx.runtime.today）。格式错是**用法错误**
  // （exit 2）；空缺 = 系统日期。2026-10-28 起不再是环境变量 LAYA_TODAY。
  let today: string | undefined;
  {
    const raw = cliString(v, "today");
    if (raw !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
        console.error(`--today 要是 YYYY-MM-DD（拿到 ${JSON.stringify(raw)}）`);
        return 2;
      }
      today = raw.trim();
    }
  }

  let loaded: LoadedScriptApp;
  try {
    loaded = await loadScriptApp(String(cliString(v, "app")));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const pack = loaded.pack;

  // 槽位名打错曾是**静默**的：不在声明里就是用法错误（exit 2），并且把已声明的列出来。
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

  const outDir = path.resolve(cliString(v, "out") ?? appsOutDir());
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (e) {
    console.error(`--out ${JSON.stringify(outDir)} 建不出来：${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  // 模型层级在哪一层，**每个出口都要回答**（dry 也不例外——桥的 summary 靠它写
  // `model: on|off(missing)`，用户先要知道此刻跑在哪个层级，再谈结果可不可信）。
  const ablate = cliString(v, "ablate");
  if (ablate !== undefined && ablate !== "stub" && ablate !== "rules-only") {
    console.error(`--ablate 只接受 stub | rules-only（收到 ${JSON.stringify(ablate)}）`);
    return 2;
  }
  const providerWanted = cliString(v, "provider")
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
  let localModelId: string | undefined;
  if (spec.kind === "laya" && !spec.ablation) {
    try {
      localModelId = resolveLocalCheckpoint(process.env, pack.model ?? "english");
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return 2;
    }
  }

  if (cliBool(v, "dry")) {
    const dry = await dryRunFlow(loaded, {
      slots: slots as Record<string, string>,
      ...(today === undefined ? {} : { today }),
      ...(cliString(v, "out") === undefined ? {} : { outDir: cliString(v, "out") }),
    });
    const drySecretKeys = secretSlotKeys([...declaredSlots, ...Object.keys(slots)], pack.secret_slots);
  const drySecretValues = secretValuesFromSlots(slots, drySecretKeys);
    const planLike = {
      app: pack.id, label: pack.label, goal: pack.goal,
      mode: "flow", dry_run: true, slots: maskSecretSlots(slots, drySecretKeys), problems: dry.problems,
      events: dry.trace.events.map((e) => ({
        i: e.i, call: e.call, id: e.id, desc: e.desc, url: e.url,
        ok: e.ok ?? null,
        ...(e.stop_code === undefined ? {} : { stop_code: e.stop_code }),
      })),
      invariants: (pack.invariants ?? []).map((inv) => ({ id: inv.id, desc: inv.desc })),
      model_status: modelStatus,
    };
    console.log(JSON.stringify(scrubSecrets(planLike, drySecretValues), null, 2));
    if (dry.problems.length) {
      console.error(`flow dry-run 发现配置错误：\n  - ${dry.problems.join("\n  - ")}`);
      return 2;
    }
    return 0;
  }

  // 两层包装，各数一件事：缓存记“省下的重复提问”（零成本率），计数记“模型被咨询过几次”
  // （出场率）——计数在缓存**外面**：命中也是一次咨询，只是没花 forward。
  if (spec.kind === "laya" && !spec.ablation && !artifacts.ready) {
    console.log(`（模型产物不齐——缺 ${missingPieces(artifacts).join("/")}；需要模型兜底的步会如实 block。`
      + `补齐：npm run model:fetch -- --from <url 或本地路径>）`);
  }
  const applied = await applySpecToRuntime(spec);

  // R2：学习环的 sidecar。学到的永不进被审计的脚本（与 plan-cli 同一条纪律）。
  let hintMemory: HintMemoryLike | null = null;
  let hintMemoryPath: string | null = null;
  const hintMemoryArg = cliString(v, "hint-memory");
  if (cliBool(v, "learn-hints") || hintMemoryArg !== undefined) {
    hintMemoryPath = hintMemoryArg !== undefined && hintMemoryArg !== "on"
      ? path.resolve(hintMemoryArg)
      : path.join(path.dirname(userAppsDir()), "hint-memory", `${pack.id}.json`);
    try {
      ensureDir(path.dirname(hintMemoryPath));
    } catch (e) {
      console.error(`--hint-memory 落点建不出来：${hintMemoryPath}（${e instanceof Error ? e.message : String(e)}）`);
      return 2;
    }
    hintMemory = createHintMemory({ path: hintMemoryPath });
    if (!quiet) {
      console.log(`learned hints: ${hintMemory.stats?.().entries ?? 0} known（sidecar ${hintMemoryPath}）`);
    }
  }

  // --conf-floor：显式覆盖闸门刻度；范围错误是**用法错误**（退出码 2），不是静默忽略。
  let cliConfFloor: number | undefined;
  const confFloorFromCli = cliString(v, "conf-floor") !== undefined;
  const confFloorArg = cliString(v, "conf-floor")
    ?? (runDefaults.confFloor === undefined ? undefined : String(runDefaults.confFloor));
  if (confFloorArg !== undefined) {
    const n = Number(confFloorArg);
    if (!Number.isFinite(n) || n <= 0 || n > 1) {
      console.error(`--conf-floor 要是 (0, 1] 之间的数（拿到 ${JSON.stringify(confFloorArg)}）`);
      return 2;
    }
    cliConfFloor = n;
  }

  let result: AppRunResult;
  try {
    result = await runScriptApp(loaded, {
      slots, outDir, verbose: !quiet,
      ...(today === undefined ? {} : { today }),
      sources: !noSources, confirmSafe, captureTraces: cliBool(v, "trace"),
      maxSteps,
      manualFailFast: cliBool(v, "manual-fail-fast"),
      headful, allowDangerous: cliBool(v, "allow-dangerous"),
      tieredHint: tieredHint ? true : undefined,
      hintMemory, hintMemoryPath,
      confFloor: cliConfFloor,
      ...(cliConfFloor === undefined ? {} : { confFloorSource: confFloorFromCli ? "cli" as const : "config" as const }),
      providerFloor: activeProviderInfo()?.floor,
      modelStatus,
      ...(localModelId === undefined ? {} : { modelId: localModelId }),
      ...(cliString(v, "emit-trace") === undefined ? {} : { emitTrace: cliString(v, "emit-trace") }),
      ...(cliString(v, "replay") === undefined ? {} : { replayTrace: cliString(v, "replay") }),
      runtimeStats: applied.stats ?? undefined,
      pickAsks: applied.asks ?? undefined,
    });
  } catch (e) {
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
  const htmlPath = path.join(outDir, `${pack.id}-report.html`);
  // 规划引导：失败时按停因给一行「下一步建议」（flow 级 stop_code 优先，步级兜底）。
  const nextHint = runNextHint(result);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf-8");
  fs.writeFileSync(mdPath, appReportMarkdown(result, nextHint), "utf-8");
  fs.writeFileSync(htmlPath, appReportHtml(result, nextHint), "utf-8");
  if (!quiet) {
    console.log();
    console.log(appReportMarkdown(result, nextHint));
    if (nextHint) console.log(`下一步建议：${nextHint}`);
    // 停手出口（唯一出处 planning-playbook）：失败即输出，不依赖 next 是否存在——
    // 否则停因类豁免（needs_human 等）既无回流建议也无终止条件。
    if (!result.ok) console.log(`停手规则：${STOP_ESCALATION_TEXT}`);
    if (result.hint_memory) {
      console.log(`learned hints: ${result.hint_memory.entries} known, `
        + `${result.hint_memory.used} reused this run（sidecar ${result.hint_memory.path}）`);
    }
    console.log(`写入 ${jsonPath}、${mdPath} 与 ${htmlPath}`);
  }
  // 执行预算用满 = 主动停在半路；它不是“失败”，但也不是完整验收。
  return result.ok || result.partial === true ? 0 : 1;
}

/**
 * run 失败时的一行「下一步建议」（planning-playbook.nextForStop）：flow 级停因优先
 * （`ctx.fail` 的 code / 预算），其次第一个带 stop_code 的步，再退到第一个失败步的
 * `result.stopCode`。命中不了映射表就返回 null——宁可不建议，不给泛泛而谈。
 */
function runNextHint(r: AppRunResult): string | null {
  if (r.ok) return null;
  const code = r.script?.stop_code
    ?? (r.step_traces ?? []).find((t) => t.stop_code !== undefined)?.stop_code
    ?? (r.step_traces ?? [])
      .map((t) => (t.result as { stopCode?: unknown } | undefined)?.stopCode)
      .find((c) => typeof c === "string" && c !== "");
  return typeof code === "string" && code !== "" ? nextForStop(code) : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}