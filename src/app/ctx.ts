/**
 * L2 运行期 `ctx`（真实实现）——脚本应用**唯一**的运行期面。
 *
 * 分工（与 API 草案一致）：
 *   - **脚本**：控制流（循环/条件/重试/组合）；
 *   - **引擎**：一步之内的一切——元素池、规则/hint/模型选元素、置信度/风险闸门、
 *     可操作性探针、DOM 信号判定、绑定与数据腿、危险动作 dry-run+确认。
 *
 * 红线在 L2 的落法：
 *   - 脚本拿不到模型文本/分数、拿不到 `page`/`locator`、不能自报完成——只能拿到
 *     `{ok, stopCode, evidence}` 这种**结构化结果**；
 *   - 完成只认该面证据：`step`/`arrive` 的 `done` 由 `checkSignal`/`checkToolSignal` 裁决；
 *   - 值只来自声明/观察/派生：`read.*` 是只读观察，`source()` 是数据腿观察。
 */
import path from "node:path";
import {
  disallowedHost, type BrowserMiddleware, type BrowserSession, type ExecutedAction,
  type RunReport, type SkippedAction, type StepStateRecord,
} from "../engine/executor.ts";
import { validateCommands } from "../engine/actions.ts";
import { firstOf, framesOf, locatorAnyFrame, urlOf, type PageLike } from "../engine/extraction.ts";
import { observePage, validateObserveOptions, type ObserveOptions, type ObserveResult } from "../engine/observe.ts";
import { checkSignal } from "../engine/signals.ts";
import { defaultDates, defaultDatesSlotNames, loadSource, parseDatesValue, runSource, ValueError } from "../data/datasource.ts";
import {
  listAppAdapters, requireAppAdapter, validateReturns, type ReturnExtractor,
} from "./app-adapters.ts";
import type { DatasetStore } from "../engine/dataset.ts";
import { capToolText, stderrTail } from "./tool-artifact.ts";
import { REPO } from "../flow/flow.ts";
import { PageStateStore, type PageState } from "./page-state.ts";
import { createKit, type CommandDecl, type DomSignal, type TargetDecl, type ValueBinding } from "./kit.ts";
import { pushEvent, type AppTrace, type TraceCall } from "./trace.ts";
import { validateToolSignal, type ToolSignal } from "../browser/tool-signals.ts";
// B1 节奏统一：最小步间距（start-to-start）的核心计算在三脸共用的 support/pace.ts。
import { paceRemainder } from "../support/pace.ts";

/** 运行期**配置级**停因：脚本可以 `catch`，但默认直接结束运行（不是业务失败）。 */
export class StopError extends Error {
  readonly code: string;
  /** 结构化证据（如 navigation_forbidden 的 {policy, attempted, current}）；缺省不出现。 */
  readonly diagnostics?: Record<string, unknown>;
  constructor(code: string, message: string, diagnostics?: Record<string, unknown>) {
    super(message);
    this.name = "StopError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export interface StepRequest {
  /** **必填**：完成只由引擎按信号裁决。 */
  done: DomSignal;
  /**
   * **可选**：目标（kit.hint/hints）或命令闭集。
   *
   * 省略 = 把“点哪里”交给引擎的规则/决策层——这是默认的**决策语句**写法。
   * 只有需要稳定锚点、或必须收窄候选集时才写 hint/命令闭集；纯导航步用 `arrive`。
   */
  act?: TargetDecl | CommandDecl[];
  /** 这一步的起点 URL（缺省 = 当前页）；相对仓库路径按仓库根解析成 `file://`。 */
  url?: string;
  slots?: Record<string, string>;
  /**
   * U1 步级显式值袋（决策语句步的值通道）：`{ "<关联键>": "<值>" }`。决策层选中
   * fill/select 目标后，值请求先按本袋解析（控件 name/id/data_test/label 与 key 的
   * 精确/互含匹配，与 slots 同一套两档匹配），命中即用——**作者显式值 > 隐式 slot 匹配**；
   * 两袋都落空仍返回结构化 `needs_value`，绝不猜（红线②）。命令步（act 命令闭集）不受
   * 影响：其值面仍是 `{from:"slot", key}` 具名绑定。缺省不出现 = 既有行为逐字节不变。
   */
  values?: Record<string, string>;
  /** 适用性守卫（在动作前判定；不成立 = 这一步不执行，返回 ok=false + stopCode="precondition_skipped"）。 */
  when?: DomSignal;
  /** 稳定步骤标识（进 trace / step_traces / failure；缺省时按执行序号记录）。 */
  id?: string;
  timeoutMs?: number;
  /**
   * A1 `forceAct`（opt-in）：命令步即使 done 信号在**动作前**已成立，也先把命令闭集执行完，
   * 执行后（全部命令走完时）再评估 done。缺省不出现 = 既有行为逐字节不变。
   *
   * 为什么需要显式声明：引擎当前本来就没有"done 已成立就跳过动作"的短路，默认就是先动作；
   * 写成声明是为了给后续可能引入的 done 预判短路留 opt-out 出口，同时让脚本作者能明确
   * 表达"这一步必须真的动一下"。dry/replay 只记录/回放声明，不重新决策。
   */
  forceAct?: boolean;
  /**
   * S4 `force`（opt-in，缺省 false = 既有行为逐字节不变）：动作走 Playwright 的 force 语义
   * （跳过 actionability 检查，仍要求元素可定位），用于作者已确认的瞬态弹层/动画控件。
   * 风险：鼠标坐标上的顶层元素可能不是目标本身（可能点到被遮挡目标）——只在必要时声明。
   * dry 面只记录声明（`forced: true`），不改变模拟；trace 的执行/失败行同样记 `forced`。
   */
  force?: boolean;
  /**
   * S4 `staleRetry`（opt-in，缺省 false = 既有行为逐字节不变）：动作失败且疑似 stale 时，
   * 重抽池 → 用**同一声明目标**（命令 target / act hint）重新解析 → 重试动作，最多 2 次。
   * 判据只有三类：stale_ref（盖章句柄全落空）、action_failed、not-actionable-or-covered 且
   * 现场 requery=detached（节点已被卸载）。action-timeout / 有覆盖者且节点仍在都不重试。
   * 纯模型挑元素的决策步没有可复现的声明目标，不重试。每次重试进 trace 行事件
   * `stale_retry:[{attempt,reason,ref}]`（dry 面同名键是布尔声明标记）；StepResult 侧的
   * 汇总字段名是复数的 `stale_retries`（两处字段名不同，文案勿混写——R9 记录项 1）。
   */
  staleRetry?: boolean;
  /**
   * F2 `newTab`（opt-in，缺省不出现 = 既有行为逐字节不变）：把 `target=_blank` /
   * `window.open` 的**新标签页**升为这一步的一等完成面。
   *
   * 声明 `{ urlContains?: string }` 后：
   *   1. **去重采用**——动作前若已存在 URL 含 `urlContains`（大小写不敏感）的标签
   *      （此前尝试开的），直接切到它、**不再点击**（不执行 act/决策动作，done 在该
   *      标签上判定）——消除 R05–R08/R11 实测的「步骤重试连点开 2–4 个重复标签」；
   *   2. 动作执行后短暂等待，若出现**新标签** → 引擎自动把读面与动作面（session.page）
   *      切到它，done 在新标签上判定；优先采用 URL 命中 `urlContains` 的新标签；
   *   3. 声明了 `newTab` 且 act 是单条 `ctx.hint(...)` 时，动作收敛为**恰好一次点击**
   *      （单命令闭集语义：点完即判 done，不重试）——决策步（无 act）保持引擎决策，
   *      建议脆弱的 `_blank` 步显式给 act hint；
   *   4. 未声明 `newTab` 的步骤逐字节不变；声明了但**没有新标签出现** → 正常 done
   *      判定（如实失败，不假装成功）。
   *
   * 新标签 URL 在 meta.hosts 信封外仍按既有 popup 门禁拒绝（popup_not_allowed）。
   * dry 只验声明形状（urlContains 非空字符串）；dry 无法验标签行为（没有浏览器）。
   */
  newTab?: { urlContains?: string };
}

export interface StepEvidence {
  url: string;
  attempts: number;
  elapsedMs: number;
  /** 动作/导航落地后的 PageState（同一运行内可比较 poolVersion）。 */
  pageState?: Readonly<PageState>;
}

/** 工具步的一次进程观察（有界；全文在工件里）。 */
export interface ToolStepOutput {
  /** 退出码（`null` = 进程没有退出码：起不来/被信号杀掉/被拒绝执行）。 */
  code: number | null;
  /** stdout 头部，最多 8KB。 */
  stdout: string;
  /** stderr 头部，最多 8KB。 */
  stderr: string;
  /** true = stdout 或 stderr 至少有一侧被截断（全文见 `artifact`）。 */
  truncated?: boolean;
}

export interface StepResult {
  ok: boolean;
  /** 请求里声明的稳定步骤标识（透传；没给就没有）。 */
  id?: string;
  stopCode?: string;
  /** 引擎给出的人可读原因（与 `stopCode` 配对；排障/分支用，**不是**模型自由文本）。 */
  reason?: string;
  evidence: StepEvidence;
  /**
   * A1 动作执行证据（全部可选：缺字段 = 该事实不适用，不硬造）。
   * `executed=false` + `skipped_actions` 是"完成裁决为真、但一个动作都没执行"的显式证据，
   * 让脚本/Agent 分得清"信号本来就成立"与"动作推进了页面"。
   */
  executed?: boolean;
  executed_actions?: ExecutedAction[];
  skipped_actions?: SkippedAction[];
  /** 命令步在动作前对 done 的预评估结果（仅命令步出现；不改变执行顺序）。 */
  done_preheld?: boolean;
  /** S4：stale 重解析重试证据（每次一条；缺字段 = 没重试过）。与 trace 行事件字段 `stale_retry`（同一条目数组）是同一份证据的汇总面；字段名两处不同（trace 行单数、这里复数），文案勿混写（R9 记录项 1）。 */
  stale_retries?: Array<{ attempt: number; reason: string; ref: string }>;
  /** S4：本步动作按 `force` 声明执行（Playwright force 语义）。 */
  forced?: boolean;
  /**
   * F2 `newTab` 采用事实（仅声明了 `newTab` 且有标签被采用时出现）：
   * `adopted:"existing"` = 命中已存标签直接采用、未点击（去重）；`adopted:"opened"` =
   * 动作开出的新标签被自动采用（读面与动作面已切过去，done 在该标签上判定）。
   */
  newTab?: { index: number; url: string; title: string; adopted: "existing" | "opened" };
  /** 运行期诚实性警告（如 suspected_async）。只在产生时出现。 */
  warnings?: string[];
  /**
   * U3：执行器的结构化诊断（池空判档证据）。只在执行器给出时透出：
   * `readiness={verdict,evidence}`（verdict==="ready" 时省略；`ready_empty` 也出现）。
   * 缺字段 = 本步没有这类诊断（旧产物形状不变）。
   */
  diagnostics?: RunReport["diagnostics"];
  /**
   * 工具步（`ctx.run`/`ctx.dangerous`）的**进程输出**：stdout/stderr 各截断到 8KB，
   * 超过上限时 `truncated: true`（全文在 outDir 的工具步工件里，见 `artifact`）。
   * 缺字段 = 这不是工具步、或该步没有任何进程输出（旧脚本行为逐字节不变）。
   */
  output?: ToolStepOutput;
  /**
   * 工具步工件在**本次运行产物目录内的相对路径**（如 `tool-steps/01-query.json`）。
   * 缺字段 = 没有工件（非工具步，或工件写盘失败——写盘失败不改变工具步结论）。
   */
  artifact?: string;
  /**
   * S1 状态层：这一步的状态记录（before/after 指纹、动作计数、前进性 flags、effect）。
   * 缺字段 = 没有页面观察（dry/replay：dry 给合成值，见 `ctx-dry.ts`）。
   */
  state?: StepStateRecord;
}

/** A3 `ctx.scrollList` 选项：方向（缺省 bottom）或像素增量，二选一优先 by。 */
export interface ScrollListOptions {
  to?: "bottom" | "top" | "page";
  /** 相对当前位置的像素增量（给"慢慢滚"的场景；优先于 to）。 */
  by?: number;
  /** 滚动后稳定等待（毫秒；缺省 150）。 */
  settleMs?: number;
}

/** A3 `ctx.scrollList` 结果：滚动容器的事实（失败也带可判别原因）。 */
export interface ScrollListResult {
  ok: boolean;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  moved?: boolean;
  stopCode?: string;
  reason?: string;
}

/** A3 `ctx.expand` 的行数读法：`{rows, fields?}` 或 `{selector}`（二选一）。 */
export type ExpandCount =
  | { rows: string; fields?: Record<string, string> }
  | { selector: string };

export interface ExpandOptions {
  count: ExpandCount;
  /** 最多点击次数（缺省 20）；内部点击**不占** flow 预算。 */
  maxClicks?: number;
  /** 连续多少轮行数不增长即判稳定（缺省 2）。 */
  stableRounds?: number;
  /** 每次点击后的稳定等待（毫秒；缺省 800）。 */
  settleMs?: number;
  /** 总超时（毫秒；缺省 60000）；到顶未稳定 = 结构化失败但带完整指标。 */
  timeoutMs?: number;
}

/** A3 `ctx.expand` 结果：展开过程与最终行数事实（失败也带完整指标，不假装成功）。 */
export interface ExpandResult {
  ok: boolean;
  clicks: number;
  before: number;
  after: number;
  grew: boolean;
  stable: boolean;
  coverage: { rows: number };
  stopCode?: string;
  reason?: string;
}

/** A3 `ctx.setRange` 的目标值：绝对值或百分比。 */
export type RangeValue = { value: number } | { percent: number };

export interface SetRangeOptions {
  /** 成功判定容差（缺省 0.5；整数滑块不可能像素级精确）。 */
  tolerance?: number;
  /** 总超时（毫秒；缺省 10000）。 */
  timeoutMs?: number;
}

/** A3 `ctx.setRange` 结果：三道策略的最终事实（失败 = `slider_not_settable`，绝不造假）。 */
export interface SetRangeResult {
  ok: boolean;
  achieved?: number;
  strategy?: "fill" | "keyboard" | "pointer";
  stopCode?: string;
  reason?: string;
  /**
   * S1 effect 读回（`meta.policy.effect_readback.set_range !== false` 时出现）：
   * `applied` = 控件值事实已经是目标；`accurate` = 在容差内。失败路径也如实 false。
   */
  applied?: boolean;
  accurate?: boolean;
  /** 目标数值（percent 已折算；对账用）。 */
  target?: number;
}

/**
 * S3 `ctx.collect` 的停止理由——**诚实口径**：说清这次到底为什么停下，不假装穷尽。
 *   - `stable`        滚到底/滚不动之后，连续 stableRounds 轮没有新增行（到 plateau 或没有更多可加载）
 *   - `maxRows`       达到 maxRows 上限（还有没取到的行，结果不是全集）
 *   - `budget`        内部轮数上限 maxRounds 用完仍未稳定（不是 flow 步预算）
 *   - `not_scrollable` 行元素的容器不可滚动（没有可滚动祖先/页面本身不滚）——只拿到当前可见部分
 *   - `dry`           dry 面桩值（没有页面；不代表任何真实覆盖）
 */
export type CollectStopReason = "stable" | "maxRows" | "budget" | "not_scrollable" | "dry";

/** S3 `ctx.collect` 的请求：行选择器 + 可选字段投影 + 停止条件。 */
export interface CollectRequest {
  /** 行选择器（CSS；主 frame 或可达的子 frame，同源/跨源均可定位）。内部滚动取行元素的最近可滚动祖先。 */
  row: string;
  /** 行内相对字段（与 extract inline 同语法）；缺省 `{ text: "." }`（行自身文本）。 */
  fields?: Record<string, string>;
  /** 停止条件二选一；缺省 `{stableRounds:2}`。 */
  until?: { stableRounds?: number } | { maxRows?: number };
  /** 按整行内容去重（缺省 true）。 */
  dedupe?: boolean;
  /** 内部轮数上限（缺省 30）；用尽 = stopReason "budget"。 */
  maxRounds?: number;
}

/** S3 `ctx.collect` 的覆盖证据：取了几轮、累计多少行、最后一轮新增几行。 */
export interface CollectCoverage {
  rounds: number;
  rowsSeen: number;
  addedLastRound: number;
}

export interface CollectResult {
  rows: Array<Record<string, string>>;
  coverage: CollectCoverage;
  stopReason: CollectStopReason;
}

export interface SourceObservationView {
  counts: Record<string, number>;
  selects: Record<string, Record<string, string> | null>;
  rows: Array<Record<string, string>>;
  version?: string;
  /**
   * 按日期键控的完整观察（多日期范围在这里；`counts/selects/rows` 仍是第一天的快照，
   * 与 source_slots 回写同一口径）。只有成功取到数的日期进这张表；被风控挡住的日期
   * 不出现（错误进数据腿报告）。
   */
  byDate?: Record<string, {
    url?: string;
    counts: Record<string, number>;
    selects: Record<string, Record<string, string> | null>;
    rows: Array<Record<string, string>>;
  }>;
}

/** 工具步的请求（进程观察面；完成真值 = exit/stdout/stderr/产物）。 */
export interface ToolRunRequest {
  desc: string;
  source: string;
  done: Record<string, unknown>;
  /**
   * 可选的稳定步标识（`ctx.run(..., { id })`）：进 trace/失败面，并作为数据集
   * `writtenBy` 的步名（缺省用 `desc`——两者都必须非空）。
   */
  id?: string;
  /**
   * 声明式的返回值抽取（`returns`，只在信号成立后执行，由驱动侧用
   * `extractProcessReturns` 的**同一份实现**落到运行级数据集）。
   */
  returns?: Record<string, ReturnExtractor> | null;
  /**
   * 应用支持器：`cli`（默认）/ `ssh` / `stdio`。非 cli 时用 `rawStep` 里的声明块
   * （`{ssh:{...}}` / `{stdio:{...}}`），由对应适配器校验、展开、执行——与声明式
   * 应用的支持器是**同一份实现**（不另写一套）。
   */
  adapter?: string;
  rawStep?: Record<string, unknown>;
  args?: string[];
  dryRunArgs?: string[];
  idempotent?: boolean;
  dangerous?: boolean;
  retries?: number;
}

export interface ToolRunResult {
  ok: boolean;
  stopCode?: string;
  reason?: string;
  refused?: string;
  code: number | null;
  stdout: string;
  stderr: string;
  attempts: number;
  dryRun?: unknown;
  /** 信号成立后抽出的返回值（驱动侧用 `extractProcessReturns`；ctx 写进运行级数据集）。 */
  returns?: Record<string, unknown>;
  /** 本步工件的相对路径（驱动侧落盘；缺省 = 没有工件）。 */
  artifact?: string;
}

export interface CtxBudget {
  maxSteps: number;
  stepsUsed: number;
  deadline: number;
}

/** flow 里的人工步请求（`ctx.manual`）。 */
export interface ManualRequest {
  desc: string;
  instructions: string;
  url: string | null;
}

/**
 * A5：同一个 browser context 里一个**未关闭**的标签页。枚举序 = `context.pages()` 序，
 * `index` 是这个序里的 0-based 位置（`ctx.switchTab({index})` 认同一个序）。
 * `active` = 引擎当前页（`session.page`）；列表只读，不改变当前页。
 */
export interface TabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

/**
 * A5：`ctx.switchTab` 的匹配条件。至少给一个；同时给多个时按 AND 收窄。
 * `index` 是 0-based 枚举序；`urlContains`/`titleContains` 是大小写不敏感子串。
 */
export interface SwitchTabMatch {
  index?: number;
  urlContains?: string;
  titleContains?: string;
}

/** A5：切页成功的结果（命中恰好一个标签页）。 */
export interface SwitchTabResult {
  ok: true;
  index: number;
  url: string;
  title: string;
}

export interface Ctx {
  readonly app: Readonly<{ id: string; label?: string; goal: string }>;
  readonly slots: Readonly<Record<string, string>>;
  /**
   * 运行期只读投影。`epoch` = 执行器状态游标的当前 epoch（每次抽池/观察 +1；每个 `run()`
   * 重置）。dry 面给合成值 0——dry 没有真实页面观察，不假装有。
   */
  readonly runtime: Readonly<{ outDir: string; runId: string; today: string; epoch: number }>;
  readonly budget: CtxBudget;
  log(msg: string, data?: unknown): void;
  open(url: string, opts?: { timeoutMs?: number }): Promise<void>;
  openPage(role: string): Promise<void>;
  arrive(url: string, req: { done: DomSignal; desc?: string; id?: string; timeoutMs?: number }): Promise<StepResult>;
  /**
   * A5：只读枚举当前 browser context 里**未关闭**的标签页（含当前页；`index` 0-based，
   * `active` = 引擎当前页）。不切页、不计 flow step（与 read/extract 同属免费观察类）。
   * 列表可以包含 `meta.hosts` 信封外的页面——只读观察不受限，但切过去会被信封拒绝。
   */
  tabs(): Promise<TabInfo[]>;
  /**
   * A5：显式切到**恰好一个**匹配的标签页（`{index}` / `{urlContains}` / `{titleContains}`，
   * 多条件 AND；子串大小写不敏感）。0 个或 >1 个匹配 = 结构化 `config_error`（reason 列出
   * 当前 tabs，不回退随便选一个）；目标 URL 不在 `meta.hosts` 信封内 = `host_not_allowed`
   * 且不切换。成功后引擎当前页改为目标页；**计 1 个 flow step** 且走 pace。
   * 注意：动作打开的新标签页**不会自动跟随**——先 `ctx.tabs()` 确认，再 `switchTab`。
   */
  switchTab(match: SwitchTabMatch): Promise<SwitchTabResult>;
  /**
   * P0-A：**只读观察当前会话页**，返回 DOM 侧真实存在、但**不要求入池**的元素清单
   * （准入面元素；`selector` 给定时以它为准），带 class/bbox/可见性/`admitted` +
   * `why_not_admitted` + 经同一个 `hintMatch` 自证的 `hint_candidates`。用于脚本内侦察/
   * 取证（替代"故意失败步捞池快照"或反复建 app）。
   *
   * 纪律：**免费**（不计 flow step/预算、不触发 pace）、**不写 outDir**、**不进模型请求面**
   * （不调用任何 provider、不抽决策池）、**不改页面状态**（只读 DOM，无点击/滚动/导航）。
   * 每次观察 ≤6 次 `page.evaluate`（主 frame + 可达子 frame），最多 200 行；不做水合等待
   * （要等页面先 `ctx.waitFor`/`arrive`）。`selector` 非法 CSS 返回
   * `{ok:false, error:"bad_selector", reason}`，不抛栈、不中断 flow。
   *
   * 产物：trace 只记 `{call:"observe", url, counts, truncated}`（**不记元素/class 明细**），
   * result JSON 里没有 observe 结果（需要证据就在 flow 里自己用 `ctx.log`/写文件）。
   * dry 返回 `{ok:true, dry:true, counts 全 0, elements:[]}`；replay 只还原 counts/truncated
   * （元素明细未录制）——`if (obs.elements.length)` 这类分支在 dry/replay 走不到，
   * 依赖观察值的分支/断言请用 `ctx.runtime.runId === "(dry)"` 或 counts 守卫。
   */
  observe(opts?: ObserveOptions): Promise<ObserveResult>;
  step(desc: string, req: StepRequest): Promise<StepResult>;
  /**
   * A3：把目标（hint）自身或其最近可滚动祖先滚到方向 `to`（缺省 bottom）或相对 `by` 像素。
   * 纯 DOM `scrollTop`（不做滚轮/鼠标模拟，不自动扩散到页面其它区域）；计 1 个 flow step。
   * 找不到可滚动容器 = `not_scrollable`；目标解析不到 = `target_not_found`。
   */
  scrollList(target: string, opts?: ScrollListOptions): Promise<ScrollListResult>;
  /**
   * A3：列表展开——反复点击"加载更多/展开"直到行数连续 `stableRounds` 轮不增长。
   * 内部点击不占 flow 预算（整体计 1 步），由 `maxClicks`/`timeoutMs` 兜底；
   * 到顶未稳定 = `ok:false` + 完整指标（`expand_not_stable`），不假装成功。
   */
  expand(target: string, opts: ExpandOptions): Promise<ExpandResult>;
  /**
   * A3：范围控件设值三策略（range fill → ARIA 键盘 → 指针拖拽，0×0 手柄用最近有尺寸祖先）。
   * 设不了 = `slider_not_settable`（带已试策略/bbox/当前值），计 1 个 flow step。
   */
  setRange(target: string, value: RangeValue, opts?: SetRangeOptions): Promise<SetRangeResult>;
  /**
   * S3：列表穷举原语——反复（滚动行容器 → 抽行 → 去重）直到**连续 stableRounds 轮**
   * 没有新增行、或达到 maxRows / 内部轮数上限。**整体计 1 个 flow step**（内部滚动/等待
   * 不占预算）。返回诚实 `stopReason`（stable / maxRows / budget / not_scrollable），
   * 不假装穷尽；`coverage` 给出轮数、累计行数、最后一轮新增行数。`stable` 只在容器
   * 到底/滚不动之后累计"无新增"轮数（没滚到底的轮次不算 plateau）。
   */
  collect(req: CollectRequest): Promise<CollectResult>;
  /**
   * 人工步：登录/验证码/人工确认。人完成并确认后，可选 DOM 信号由引擎再验一遍。
   * `{manual:true}` 信号 = 人自证；非 TTY 且开了 manualFailFast 时返回 needs_human，不拉有头浏览器。
   */
  manual(desc: string, req: { done: DomSignal; instructions?: string; id?: string }): Promise<StepResult>;
  url(): string;
  readonly read: {
    text(selector: string): Promise<string | null>;
    value(selector: string): Promise<string | null>;
    count(selector: string): Promise<number>;
    /** 读一个属性（不存在/超时 → null）。 */
    attr(selector: string, attr: string): Promise<string | null>;
  };
  /**
   * Q5 的决定：v1 **不开放**行抽取的新语法；调用会给结构化 `config_error`。
   * 命名行抽取用 `ctx.extract(name)`（走 `meta.site.listExtract` 声明）。
   */
  rows(spec: { row: string; fields: Record<string, string> }): Promise<Array<Record<string, string>>>;
  /**
   * 具名结构化抽取：`meta.site.listExtract[name]`，或 inline `{ rows, fields, maxItems? }`。
   * 行选择器 + 字段选择器；字段值 `"."` = 行自身文本。引擎负责观察与证据，不做业务解释。
   */
  extract(name: string | { rows: string; fields: Record<string, string>; maxItems?: number }):
    Promise<Array<Record<string, string>>>;
  holds(sig: DomSignal): Promise<boolean>;
  waitFor(sig: DomSignal, opts?: { timeoutMs?: number; pollMs?: number }): Promise<boolean>;
  source(name: string, opts?: { dates?: string | string[] }): Promise<SourceObservationView>;
  readonly data: {
    min<T extends Record<string, unknown>>(rows: T[], by: string): T | null;
    max<T extends Record<string, unknown>>(rows: T[], by: string): T | null;
  };
  // 纯构造器（与 L1 kit 同一份实现；脚本里 `ctx.judge.*` / `ctx.hint()` / `ctx.command()`）
  readonly judge: ReturnType<typeof createKit>["judge"];
  readonly tool: ReturnType<typeof createKit>["tool"];
  /** 结构化终止：抛带 stop_code 的 StopError，结果仍走引擎既有分类（不是裸栈）。 */
  fail(code: string, reason?: string): never;
  hint(hint: string): TargetDecl;
  hints(...hints: string[]): TargetDecl;
  command(op: string, target?: string, value?: ValueBinding): CommandDecl;
  readonly value: ReturnType<typeof createKit>["value"];
  /** ① 命令行形式：`ctx.run("my-tool", ["--flag"], { done })`。 */
  run(source: string, args: string[], req: {
    done: Record<string, unknown>; desc?: string; id?: string; adapter?: string;
    idempotent?: boolean; retries?: number; dryRunArgs?: string[];
    /** 声明式返回值抽取（`{NAME: {from:"stdout"}}` 等）；信号成立后写运行级数据集。 */
    returns?: Record<string, unknown>;
  }): Promise<StepResult>;
  /**
   * ② 声明形式（任意应用支持器）：`ctx.run({ adapter?: "cli"|"ssh"|"stdio", ssh?: {...}, stdio?: {...}, done })`。
   * 与声明式应用的 `journey` 步是同一套声明面（同一份校验/展开/执行实现），
   * 所以"声明式能表达的进程类型，flow 脚本也表达得了"。
   */
  run(step: Record<string, unknown> & { done: Record<string, unknown> }): Promise<StepResult>;
  dangerous(req: {
    desc: string; source: string; args: string[]; dryRunArgs: string[];
    done: Record<string, unknown>; id?: string; idempotent?: boolean; retries?: number;
  }): Promise<StepResult>;
  done(): Promise<void>;
}

export interface CtxDeps {
  pack: {
    id: string; label?: string; goal: string; hosts?: string[] | null;
    invariants?: Array<Record<string, unknown>>;
    site?: { pages?: Record<string, string>; listExtract?: Record<string, { rows: string; fields: Record<string, string> }> };
    /** 数据腿回写槽位的**键集**（环封口校验用：数据腿参数不许引用数据腿产物）。 */
    source_slots?: Record<string, unknown> | null;
  };
  slots: Record<string, string>;
  runtime: { outDir: string; runId: string; today: string };
  ensureSession(): Promise<BrowserSession>;
  mw(): BrowserMiddleware;
  trace: AppTrace;
  maxSteps?: number;
  deadline?: number;
  verbose?: boolean;
  /**
   * S1 effect 读回开关（来自 `meta.policy.effect_readback`；缺省两项都开）。
   * fill 的读回在执行器里（构造参数），这里只控制 `ctx.setRange` 结果的 applied/accurate。
   */
  effectReadback?: { fill?: boolean; set_range?: boolean };
  /** 数据腿：与 `runApp` 的同一实现（`runSource` + `defaultDates`）。 */
  sourceRunner?: (name: string, opts?: { dates?: string | string[] }) => Promise<SourceObservationView>;
  /**
   * 运行级数据集（与 `runApp` 的同一份 `DatasetStore`）：`ctx.run` 的 `returns` 在信号
   * 成立后写这里，下游命令步 `{from:"dataset",key}` 现读。缺省 = 不写（dry/replay 没有数据集）。
   */
  dataset?: DatasetStore;
  /** 工具步：由驱动接到 `runToolStep`（干跑/确认/幂等重试的既有实现）。 */
  toolRunner?: (req: ToolRunRequest) => Promise<ToolRunResult>;
  /** `--skip-data`：数据腿被显式跳过时，`ctx.source()` 报结构化错误（不静默跑网络）。 */
  allowSources?: boolean;
  /** 每次 `ctx.step`/`arrive` 的实际执行报告（驱动用它汇总决策账，套件/矩阵念同一份数）。 */
  onRunReport?: (rep: RunReport) => void;
  /** 人工步的接入点（默认 = TTY 提示；嵌入方可注入）。 */
  manualRunner?: (req: ManualRequest) => boolean | Promise<boolean>;
  /** 非交互：遇到人工步直接 needs_human，不创建有头浏览器。 */
  manualFailFast?: boolean;
  /**
   * A6 walk 调试模式（`--walk`，默认关 = 逐字节不变）：`ctx.step` 声明的 `url` 与当前页
   * **同页**（origin+path 相同；query/hash 忽略）时不再重导航——「url=当前页」的重锚折叠成
   * 缺省「当前页」语义，SPA 客户端状态跨步保留；指向**另一页**的显式 url 仍然导航
   * （显式意图优先）。`open`/`openPage`/`arrive` 与 done 判定/停因/after/决策账全部不变。
   */
  walk?: boolean;
  /** 步间最小间距（`meta.pace.between_steps_ms`；start-to-start ≥ gap；0 = 不等待）。 */
  stepDelayMs?: number;
  /** action 后 done 信号总等待窗口（毫秒；缺省 2000）。 */
  doneTimeoutMs?: number;
  /** action 后 done 信号轮询间隔（毫秒；缺省 120）。 */
  donePollMs?: number;
  /** pool ready gate 最大等待（毫秒；缺省 700）。 */
  poolReadyTimeoutMs?: number;
  /** pool ready gate 轮询间隔（毫秒；缺省 100）。 */
  poolReadyPollMs?: number;
  /** U3：池空判档（缺省 fact；strict = U3 之前的 page_not_ready 快败）。 */
  poolGate?: "fact" | "strict";
  /** U3：surface 类目策略（缺省 native_activation="window"）。 */
  surfacePolicy?: { native_activation?: "window" | "resolve" | "off" };
  /**
   * 导航纪律（`meta.policy.navigation`；缺省/`"free"` = undefined = 现行为逐字节不变）。
   * `"entry-only"` = 入口之外的直接 URL 导航（open/openPage/arrive/step 级 url）结构化
   * 停因 `navigation_forbidden`。只在 flow 脚本面生效。
   */
  navPolicy?: "entry-only" | "free";
  /**
   * P0-B：`meta.site.pages` 声明的页面 URL 清单。仅 `navPolicy:"entry-only"` 使用：
   * 再次直接导航到**声明页**（URL 经 `new URL().href` 归一后全等）放行——例如
   * `ctx.openPage("home")` 回入口页；未声明的 URL 仍 `navigation_forbidden`。
   * 缺省 undefined = 不放开（行为逐字节不变）。
   */
  declaredPages?: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 相对仓库路径 → `file://`（dry/replay 也用这一份，host/URL 语义才同口径）。 */
export function resolveCtxUrl(u: string): string {
  if (/^(https?|file):/i.test(u)) return u;
  // 与 `app-runner.startUrl` 同一口径：用 `new URL("file://" + path)` 而不是 `pathToFileURL`，
  // 因为后者会把 `?sn=CAM-1001` 当成文件名百分号编码掉（实测 ERR_FILE_NOT_FOUND）。
  return new URL(`file://${path.resolve(REPO, u)}`).href;
}

function assertAct(req: StepRequest): void {
  if (req === null || typeof req !== "object") throw new StopError("config_error", "ctx.step needs a request object");
  if (req.done === undefined || req.done === null || !isObj(req.done) || !Object.keys(req.done).length) {
    throw new StopError("config_error", "ctx.step: done signal is required (completion only comes from the evidence surface)");
  }
  // act 省略 = 让引擎决策目标；只有显式给了 act 才校验它的形状（真正形状由 targetOptions/执行器校验）。
  // F2：newTab 声明形状（对象；urlContains 若给必须是非空字符串）——dry 与真实面同文案。
  if (req.newTab !== undefined && req.newTab !== null) {
    if (typeof req.newTab !== "object" || Array.isArray(req.newTab)) {
      throw new StopError("config_error", "ctx.step: newTab must be an object like { urlContains: \"p2\" }");
    }
    const uc = (req.newTab as Record<string, unknown>)["urlContains"];
    if (uc !== undefined && (typeof uc !== "string" || !uc.trim())) {
      throw new StopError("config_error", "ctx.step: newTab.urlContains must be a non-empty string (case-insensitive URL substring used for tab adoption/dedup)");
    }
  }
}

/**
 * A6 walk 的同页判定：origin+path 相同即同页（query/hash 忽略）。
 * 为什么忽略 query：作者惯例里「每步起点 URL」常写成当前页去 query 的重锚
 * （如 Maps 的 `cleanUrl(await ctx.url())`）——walk 把它折叠成缺省「当前页」语义（不重导航，
 * SPA 状态跨步保留）；而真正换页（不同 origin/path）的显式 url 仍然导航，显式意图优先。
 * 解析不了 URL 的原始串按字面相等兜底。
 */
function samePage(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host && ua.pathname === ub.pathname;
  } catch {
    return a === b;
  }
}

/**
 * 导航纪律（`meta.policy.navigation:"entry-only"`）的**同 URL 重试**判定：
 * origin+path+query 全等（hash 忽略——锚点滚动不是换页）。解析不了的原始串按
 * 去 hash 字面相等兜底。与 walk 的 `samePage`（只比 origin+path）口径不同：
 * gate 管"重试同址"，query 变了就是新地址（拼参数直达正是要拦的行为）。
 */
export function sameNavTarget(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host
      && ua.pathname === ub.pathname && ua.search === ub.search;
  } catch {
    const bare = (s: string) => { const i = s.indexOf("#"); return i < 0 ? s : s.slice(0, i); };
    return bare(a) === bare(b);
  }
}

/**
 * P0-B：entry-only 的**声明页放行**判定。两边 URL 各经 `new URL(...).href` 归一后
 * **全等**（含 query；不做尾斜杠/case/协议升级等特判）⇒ 目标是一个已声明入口页。
 * 解析不了的原始串按字面相等兜底（与 `sameNavTarget` 同一条纪律）。
 */
export function sameDeclaredPageHref(target: string, declared: readonly string[]): boolean {
  if (!declared.length) return false;
  const hrefOf = (u: string): string => {
    try { return new URL(u).href; } catch { return u; }
  };
  const h = hrefOf(target);
  for (const d of declared) if (hrefOf(d) === h) return true;
  return false;
}

/**
 * 命令闭集补 id：`ctx.command(...)` 不强制作者写 id，但执行器的闭集要求每个选项有名字。
 * 缺省补「序号 + op」的稳定 id（不随运行变化；重放/forbidden 语义仍稳定）。
 */
export function normalizeCommandIds(commands: CommandDecl[]): CommandDecl[] {
  return commands.map((c, i) => {
    const rec = c as unknown as Record<string, unknown>;
    if (typeof rec["id"] === "string" && String(rec["id"]).trim()) return c;
    return { ...(c as object), id: `cmd${i + 1}_${String(rec["op"] ?? "op")}` } as CommandDecl;
  });
}

/**
 * `ctx.run` **声明形式**允许的顶层键（唯一出处；dry/`apps check` 与运行期共用）。
 * 以实现实际消费者为准：
 *   - `adapter`/`source`/`args`/`dryRunArgs`（cli 形式，`source`/`args` 也供 ssh/stdio 的
 *     适配器校验读取）；
 *   - `stdio`/`ssh`（声明块；块内未知键由各自 adapter 校验）；
 *   - `desc`/`id`/`idempotent`/`retries`/`returns`/`done`；
 *   - `signal` 只为给出「journey 词写进了 flow」的显式改法（不是合法字段）；
 *   - `dangerous`：ssh/stdio 的 adapter.validateStep 会读它并给出「尚未实现」的结构化拒绝。
 * 没有 `cli`：cli 形式就是 `source`+`args`+`dryRunArgs`，没有 `cli: {...}` 块消费者——
 * 写了它等于写了没用，按未知键拒绝（不静默忽略）。
 */
export const DECLARED_RUN_KEYS = [
  "adapter", "source", "args", "dryRunArgs", "desc", "id", "idempotent", "retries",
  "returns", "done", "stdio", "ssh", "signal", "dangerous",
] as const;

/**
 * `ctx.run` 声明形式的**共享校验**（T7）：未知顶层键、`signal`/`done` 冲突、done 必需。
 * dry/`apps check` 与运行期念同一段文案；未知键点名 unknown + known，绝不静默忽略。
 */
export function declaredRunProblems(step: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const known = DECLARED_RUN_KEYS as readonly string[];
  const unknown = Object.keys(step).filter((k) => !known.includes(k));
  if (unknown.length) {
    problems.push(`ctx.run: unknown declaration key(s) ${unknown.map((k) => JSON.stringify(k)).join(", ")}`
      + ` (known: ${DECLARED_RUN_KEYS.join(", ")})`);
  }
  const straySignal = step["signal"];
  if (straySignal !== undefined && step["done"] === undefined) {
    problems.push("ctx.run: flow 的声明形式用 done（journey 用 signal）；把 signal 改名为 done，"
      + "例如 { stdio: {...}, done: { stdout_contains: \"ok\" } }");
  }
  if (straySignal !== undefined && step["done"] !== undefined) {
    problems.push("ctx.run: 声明块同时写了 signal 和 done——flow 的声明形式只认 done（signal 是 journey 的词）；"
      + "删掉 signal，或把它改名为 done");
  }
  if (step["done"] === undefined || step["done"] === null) {
    problems.push("ctx.run: done signal is required (completion is the process observation)");
  } else if (typeof step["done"] !== "object" || Array.isArray(step["done"])) {
    problems.push("ctx.run: done signal must be an object");
  }
  return problems;
}

/* ---- A3 原语参数校验（真实/dry/replay 共用同一份声明面；校验失败 = config_error） ---- */

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

const SWITCH_TAB_MATCH_KEYS = new Set(["index", "urlContains", "titleContains"]);

/**
 * A5：`ctx.switchTab` 的声明面校验（真实/dry/replay 共用同一份；坏 match 在 dry 期也红）。
 * 三条纪律：只认三个键（拼错的 `url`/`title` 不静默忽略）、至少给一个条件（否则等于
 * "随便挑一个"，与显式原语的初衷相反）、index 是 0-based 非负整数。
 */
export function validateSwitchTabMatch(match: unknown): void {
  if (!isObj(match)) {
    throw new StopError("config_error",
      "ctx.switchTab: match must be an object like { index } | { urlContains } | { titleContains }");
  }
  const unknownKeys = Object.keys(match).filter((k) => !SWITCH_TAB_MATCH_KEYS.has(k));
  if (unknownKeys.length) {
    throw new StopError("config_error",
      `ctx.switchTab: unknown match key(s) ${unknownKeys.map((k) => JSON.stringify(k)).join(", ")} `
      + "(allowed: index, urlContains, titleContains)");
  }
  const { index, urlContains, titleContains } = match as Record<string, unknown>;
  if (index !== undefined && (typeof index !== "number" || !Number.isInteger(index) || index < 0)) {
    throw new StopError("config_error",
      `ctx.switchTab: match.index must be a 0-based integer (got ${JSON.stringify(index)})`);
  }
  if (urlContains !== undefined && !isNonEmptyString(urlContains)) {
    throw new StopError("config_error",
      `ctx.switchTab: match.urlContains must be a non-empty string (got ${JSON.stringify(urlContains)})`);
  }
  if (titleContains !== undefined && !isNonEmptyString(titleContains)) {
    throw new StopError("config_error",
      `ctx.switchTab: match.titleContains must be a non-empty string (got ${JSON.stringify(titleContains)})`);
  }
  if (index === undefined && urlContains === undefined && titleContains === undefined) {
    throw new StopError("config_error",
      "ctx.switchTab: match needs at least one of index | urlContains | titleContains "
      + "(refusing to pick a tab implicitly)");
  }
}

/** A5 匹配语义（真实/dry 共用）：多条件 AND；url/title 子串大小写不敏感。 */
export function switchTabMatches(
  tab: { index: number; url: string; title: string }, match: SwitchTabMatch,
): boolean {
  if (match.index !== undefined && tab.index !== match.index) return false;
  if (match.urlContains !== undefined && !tab.url.toLowerCase().includes(match.urlContains.toLowerCase())) return false;
  if (match.titleContains !== undefined && !tab.title.toLowerCase().includes(match.titleContains.toLowerCase())) return false;
  return true;
}

/** A5：错误面里列出当前 tabs（index/url/title/active）——作者不用再猜为什么没匹配上。 */
export function describeTabs(
  tabs: ReadonlyArray<{ index: number; url: string; title: string; active?: boolean }>,
): string {
  if (tabs.length === 0) return "(none)";
  return tabs.map((t) => `#${t.index} url=${JSON.stringify(t.url)} title=${JSON.stringify(t.title)}`
    + (t.active === true ? " [active]" : "")).join("; ");
}

/**
 * F1：`ctx.scrollList` 的**合成滚动目标**闭集（大小写不敏感）。这些名字不进元素池、
 * 不占池位，也不做 hint 匹配：统一解析为主滚动器 `document.scrollingElement`
 * （兜底 body → documentElement）。容器目标（任何其他 hint）走既有池外回退解析，
 * 行为逐字节不变。
 */
export const SCROLL_SYNTHETIC_TARGETS = ["document", "body", "html", "window"] as const;

export function isSyntheticScrollTarget(target: string): boolean {
  return (SCROLL_SYNTHETIC_TARGETS as readonly string[]).includes(target.trim().toLowerCase());
}

/** `ctx.scrollList` 的参数声明。非法值**在这里**红（dry 期也能拦住，不留到真跑）。 */
export function validateScrollListRequest(target: unknown, opts: unknown): void {
  if (!isNonEmptyString(target)) {
    throw new StopError("config_error", "ctx.scrollList: target must be a non-empty hint string (e.g. \"Feed list\" or \"#feed\", or a synthetic \"document\"|\"body\"|\"html\"|\"window\")");
  }
  if (opts === undefined) return;
  if (!isObj(opts)) throw new StopError("config_error", "ctx.scrollList: opts must be an object");
  const to = opts["to"];
  if (to !== undefined && to !== "bottom" && to !== "top" && to !== "page") {
    throw new StopError("config_error", `ctx.scrollList: opts.to must be one of bottom | top | page (got ${JSON.stringify(to)})`);
  }
  const by = opts["by"];
  if (by !== undefined && (typeof by !== "number" || !Number.isFinite(by) || by === 0)) {
    throw new StopError("config_error", "ctx.scrollList: opts.by must be a non-zero finite number of pixels");
  }
  const settle = opts["settleMs"];
  if (settle !== undefined && (typeof settle !== "number" || !Number.isFinite(settle) || settle < 0)) {
    throw new StopError("config_error", "ctx.scrollList: opts.settleMs must be a number >= 0");
  }
}

/** `ctx.expand` 的参数声明（count 形状/上限都校验；未知形状在 dry 期红）。 */
export function validateExpandRequest(target: unknown, opts: unknown): void {
  if (!isNonEmptyString(target)) {
    throw new StopError("config_error", "ctx.expand: target must be a non-empty hint string (the load-more/expand control)");
  }
  if (!isObj(opts)) throw new StopError("config_error", "ctx.expand: opts must be an object like { count: { rows, fields? } }");
  const count = opts["count"];
  if (!isObj(count)) {
    // S0：首句点破**类型**（以前只说形状，number/string 这类错要读到句尾才反应过来）。
    const got = count === null ? "null" : Array.isArray(count) ? "array" : typeof count;
    throw new StopError("config_error",
      `ctx.expand: opts.count must be an object { rows: selector } | { selector } — got ${got}`);
  }
  const hasRows = count["rows"] !== undefined;
  const hasSelector = count["selector"] !== undefined;
  if (hasRows === hasSelector) {
    throw new StopError("config_error", "ctx.expand: opts.count must have EXACTLY one of rows | selector (got both or neither)");
  }
  if (hasRows && !isNonEmptyString(count["rows"])) {
    throw new StopError("config_error", "ctx.expand: opts.count.rows must be a non-empty selector string");
  }
  if (hasSelector && !isNonEmptyString(count["selector"])) {
    throw new StopError("config_error", "ctx.expand: opts.count.selector must be a non-empty selector string");
  }
  if (hasRows && count["fields"] !== undefined) {
    if (!isObj(count["fields"])) throw new StopError("config_error", "ctx.expand: opts.count.fields must be an object of field -> selector");
    for (const [k, v] of Object.entries(count["fields"])) {
      if (!isNonEmptyString(k) || !isNonEmptyString(v)) {
        throw new StopError("config_error", `ctx.expand: opts.count.fields[${JSON.stringify(k)}] must map a field name to a non-empty selector`);
      }
    }
  }
  for (const [key, min, max] of [["maxClicks", 1, 500], ["stableRounds", 1, 20]] as const) {
    const v = opts[key];
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)) {
      throw new StopError("config_error", `ctx.expand: opts.${key} must be an integer in [${min}, ${max}] (got ${JSON.stringify(v)})`);
    }
  }
  for (const [key, max] of [["settleMs", 60_000], ["timeoutMs", 600_000]] as const) {
    const v = opts[key];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max)) {
      throw new StopError("config_error", `ctx.expand: opts.${key} must be a number in [0, ${max}] (got ${JSON.stringify(v)})`);
    }
  }
}

/** `ctx.setRange` 的参数声明：value 二选一、数值有限、percent 在 [0,100]。 */
export function validateSetRangeRequest(target: unknown, value: unknown, opts: unknown): void {
  if (!isNonEmptyString(target)) {
    throw new StopError("config_error", "ctx.setRange: target must be a non-empty hint string (the range/slider control)");
  }
  if (!isObj(value)) throw new StopError("config_error", "ctx.setRange: value must be { value: number } or { percent: 0..100 }");
  const hasValue = value["value"] !== undefined;
  const hasPercent = value["percent"] !== undefined;
  if (hasValue === hasPercent) {
    throw new StopError("config_error", "ctx.setRange: value must have EXACTLY one of {value} | {percent} (got both or neither)");
  }
  if (hasValue) {
    const v = value["value"];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new StopError("config_error", "ctx.setRange: value.value must be a finite number");
  } else {
    const p = value["percent"];
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 100) {
      throw new StopError("config_error", "ctx.setRange: value.percent must be a number in [0, 100]");
    }
  }
  if (opts === undefined) return;
  if (!isObj(opts)) throw new StopError("config_error", "ctx.setRange: opts must be an object");
  const tol = opts["tolerance"];
  if (tol !== undefined && (typeof tol !== "number" || !Number.isFinite(tol) || tol < 0)) {
    throw new StopError("config_error", "ctx.setRange: opts.tolerance must be a number >= 0");
  }
  const timeout = opts["timeoutMs"];
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 1 || timeout > 600_000)) {
    throw new StopError("config_error", "ctx.setRange: opts.timeoutMs must be a number in [1, 600000]");
  }
}

/**
 * S3 `ctx.collect` 的参数声明。真实/dry/replay 三面共用；非法值在**这里**红（dry 期也拦）。
 * `until` 二选一：`stableRounds`（1..20）或 `maxRows`（1..5000）。
 */
export function validateCollectRequest(req: unknown): void {
  const where = "ctx.collect";
  if (!isObj(req)) {
    throw new StopError("config_error", `${where}: request must be an object { row, fields?, until?, dedupe?, maxRounds? }`);
  }
  if (!isNonEmptyString(req["row"])) {
    throw new StopError("config_error", `${where}: row must be a non-empty CSS row selector (e.g. "li.item")`);
  }
  const fields = req["fields"];
  if (fields !== undefined) {
    if (!isObj(fields)) throw new StopError("config_error", `${where}: fields must be an object of field -> selector`);
    for (const [k, v] of Object.entries(fields)) {
      if (!isNonEmptyString(k) || !isNonEmptyString(v)) {
        throw new StopError("config_error", `${where}: fields[${JSON.stringify(k)}] must map a field name to a non-empty selector`);
      }
    }
  }
  const until = req["until"];
  if (until !== undefined) {
    if (!isObj(until)) {
      throw new StopError("config_error", `${where}: until must be one of { stableRounds } | { maxRows }`);
    }
    const hasStable = until["stableRounds"] !== undefined;
    const hasMax = until["maxRows"] !== undefined;
    if (hasStable === hasMax) {
      throw new StopError("config_error", `${where}: until must have EXACTLY one of stableRounds | maxRows (got both or neither)`);
    }
    if (hasStable) {
      const v = until["stableRounds"];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 20) {
        throw new StopError("config_error", `${where}: until.stableRounds must be an integer in [1, 20] (got ${JSON.stringify(v)})`);
      }
    } else {
      const v = until["maxRows"];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5000) {
        throw new StopError("config_error", `${where}: until.maxRows must be an integer in [1, 5000] (got ${JSON.stringify(v)})`);
      }
    }
  }
  const dedupe = req["dedupe"];
  if (dedupe !== undefined && typeof dedupe !== "boolean") {
    throw new StopError("config_error", `${where}: dedupe must be a boolean`);
  }
  const maxRounds = req["maxRounds"];
  if (maxRounds !== undefined && (typeof maxRounds !== "number" || !Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 200)) {
    throw new StopError("config_error", `${where}: maxRounds must be an integer in [1, 200] (got ${JSON.stringify(maxRounds)})`);
  }
}

/** 把 `StepRequest` 的目标声明摊成 `RunOptions` 的字段。 */
function targetOptions(act: TargetDecl | CommandDecl[]): {
  targetHint?: string | null; targetHints?: string[] | null; commands?: CommandDecl[] | null;
} {
  if (Array.isArray(act)) {
    for (const [i, c] of act.entries()) {
      if (!isObj(c) || typeof c.op !== "string" || !c.op) {
        throw new StopError("config_error", `ctx.step: act[${i}] is not a command (needs {op, ...}; build it with kit.command())`);
      }
    }
    const commands = normalizeCommandIds(act);
    // 与 dry 面**同一份**命令声明校验（`engine/actions.validateCommands`）：未知 op（含 hover 这类
    // 新原语的拼写错误）/ 重复 id / 缺 target / 给不支持 value 的 op 带 value，都在动作前红。
    const problems: string[] = [];
    validateCommands(commands, "ctx.step", problems);
    if (problems.length) throw new StopError("config_error", problems.join("；"));
    return { commands };
  }
  if (!isObj(act) || (act.kind !== "hint" && act.kind !== "hints")) {
    throw new StopError("config_error", "ctx.step: act must be kit.hint()/kit.hints() or an array of kit.command(...)");
  }
  if (act.kind === "hint") {
    if (typeof act.hint !== "string" || !act.hint.trim()) throw new StopError("config_error", "ctx.step: hint must be a non-empty string");
    return { targetHint: act.hint };
  }
  if (!Array.isArray(act.hints) || !act.hints.length || act.hints.some((h) => typeof h !== "string" || !h.trim())) {
    throw new StopError("config_error", "ctx.step: hints must be a non-empty list of strings");
  }
  return { targetHints: act.hints };
}

/** 构造真实 ctx（一个运行一个实例；会话惰性创建、由驱动关闭）。 */
export function createCtx(deps: CtxDeps): Ctx {
  const { pack, slots, runtime, trace } = deps;
  const budget: CtxBudget = {
    maxSteps: deps.maxSteps ?? 100,
    stepsUsed: 0,
    deadline: deps.deadline ?? Number.POSITIVE_INFINITY,
  };
  const hosts = (pack.hosts ?? null) as string[] | null;
  const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  let currentUrl = "about:blank";
  let closed = false;
  /**
   * 导航纪律（`meta.policy.navigation:"entry-only"`；缺省/`"free"` 关 = 逐字节不变）。
   * 计数在**成功落地**时建立入口（`directNavs === 0` ⇒ 下一次直接导航按入口放行）：
   * 失败的直接导航不烧掉入口槽——同目标的下一次尝试仍按入口放行（重试语义保留）。
   * 页面驱动的跳转（点击/锚点/新标签页）不经过这里，永不拦截。
   */
  const navOnly = deps.navPolicy === "entry-only";
  /** P0-B：声明页清单（相对路径按 ctx URL 口径解析；仅 entry-only 参与判定）。 */
  const declaredPageHrefs = (deps.declaredPages ?? []).map(resolveCtxUrl);
  let directNavs = 0;
  const markDirectNavLanded = (): void => { if (navOnly && directNavs === 0) directNavs = 1; };
  /**
   * 入口之外的直接导航闸门：目标与当前页 origin+path+query 全等（忽略 hash）= 重试放行；
   * 其余 `navigation_forbidden`。先落 trace 证据事件，再抛带 `diagnostics` 的 StopError。
   * hosts 信封检查在其之前执行（既有优先级不变）。
   */
  const navGate = (call: TraceCall, label: string, target: string): void => {
    if (!navOnly) return;
    if (directNavs === 0 || sameNavTarget(target, currentUrl)
      || sameDeclaredPageHref(target, declaredPageHrefs)) return;
    const diag = { policy: "entry-only", attempted: target, current: currentUrl };
    pushEvent(trace, { call, url: target, ok: false, stop_code: "navigation_forbidden", result: diag });
    throw new StopError("navigation_forbidden",
      `${label}: direct navigation to ${JSON.stringify(target)} is forbidden by meta.policy.navigation="entry-only"`
      + ` (current page ${JSON.stringify(currentUrl)}; only the first direct navigation of a run is the entry,`
      + ` and later direct navigations must equal the current page's origin+path+query)`
      + ` ——导航必须经由页面元素（链接/按钮）完成；如确需直达请移除该 policy`,
      diag);
  };
  /** flow 运行期的单一 PageState 事实源（不是 Playwright page 对象的替代）。 */
  const pageState = new PageStateStore();
  /** `ctx.done()` 已验收：之后不许再有动作（结束态不变量必须在"结束"之后求值）。 */
  const assertOpen = (label: string): void => {
    if (closed) throw new StopError("config_error", `${label}: ctx.done() was already called; no actions after the end-state acceptance`);
  };

  const page = async (): Promise<PageLike> => {
    const s = await deps.ensureSession();
    return s.page as unknown as PageLike;
  };

  /**
   * A5：标签页枚举。Playwright 的 Page 在两条会话构造路径（`browser.newPage()` 的隐式
   * context / 设备声明的 `newContext`）上都能 `page.context().pages()` 枚举；替身可能
   * 把 context/pages 给成属性，两种形状都认。`isClosed()` 不可用或抛错的页面按关闭处理
   * （绝不对关掉的页做 title 读取/切换）。
   */
  type TabPage = PageLike & {
    title?(): Promise<string>;
    isClosed?(): boolean;
    bringToFront?(): Promise<void>;
    waitForLoadState?(state?: string, opts?: { timeout?: number }): Promise<void>;
  };
  const contextPages = async (session: BrowserSession): Promise<TabPage[]> => {
    const active = session.page as unknown as TabPage;
    const contextValue = (active as unknown as { context?: unknown }).context;
    const context = (typeof contextValue === "function"
      ? contextValue.call(active)
      : contextValue) as { pages?: ArrayLike<TabPage> | (() => ArrayLike<TabPage>) } | undefined;
    const raw = typeof context?.pages === "function" ? context.pages() : context?.pages;
    return Array.from(raw ?? []).filter((p) => {
      try { return p.isClosed?.() !== true; } catch { return false; }
    });
  };
  /** 标题读取有界（2s）：一个卡死的标签页不能拖住 tabs()/switchTab 的错误面。 */
  const titleOf = async (p: TabPage): Promise<string> => {
    if (typeof p.title !== "function") return "";
    const title = Promise.resolve().then(() => p.title!()).then((t) => String(t ?? "")).catch(() => "");
    return await Promise.race([title, sleepMs(2000).then(() => "")]);
  };
  const listTabs = async (session: BrowserSession): Promise<Array<TabInfo & { page: TabPage }>> => {
    const pages = await contextPages(session);
    const active = session.page as unknown as TabPage;
    const out: Array<TabInfo & { page: TabPage }> = [];
    for (const [index, p] of pages.entries()) {
      let url = "";
      try { url = urlOf(p) || ""; } catch { url = ""; }
      out.push({ index, url, title: await titleOf(p), active: p === active, page: p });
    }
    return out;
  };

  /** best-effort 的有界等待：超时/失败都不致命（切页事实已经发生）。 */
  const bounded = async (fn: () => Promise<unknown> | undefined, ms: number): Promise<void> => {
    try { await Promise.race([Promise.resolve().then(fn), sleepMs(ms)]); } catch { /* best effort */ }
  };

  const checkBudget = (): void => {
    if (Date.now() > budget.deadline) throw new StopError("budget_exceeded", "run deadline exceeded (ctx.budget.deadline)");
    if (budget.stepsUsed >= budget.maxSteps) {
      throw new StopError("budget_exceeded", `step budget exhausted: ${budget.stepsUsed}/${budget.maxSteps} (raise --max-steps or fix the loop)`);
    }
  };

  const record = (ok: boolean | undefined, extra: Record<string, unknown> = {}): void => {
    pushEvent(trace, { call: "step", ok, ...extra });
  };

  /**
   * B1 最小步间距（`meta.pace.between_steps_ms` / env 层）：相邻两次引擎单元
   * （step/arrive/manual/run/scrollList/expand/setRange/collect）**开始时刻**至少隔 gap
   * ——上一步耗时长则本步不补等（start-to-start ≥ gap，不是无条件 sleep）；首个单元之前
   * 不等（时钟未启动 = remainder 0）。等待量由 support/pace.ts 的 paceRemainder 计算。
   */
  let lastUnitStartTs: number | undefined;
  const paceBeforeStep = async (): Promise<void> => {
    const gap = deps.stepDelayMs ?? 0;
    if (gap <= 0) return;
    const now = Date.now();
    const wait = paceRemainder(gap, lastUnitStartTs, now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastUnitStartTs = now + wait;
  };

  /** 所有导航的唯一实现（open / openPage / arrive 共用；hosts 信封与导航纪律闸门在打开之前强制）。 */
  const navigate = async (
    rawUrl: string, call: "open" | "openPage" | "arrive", label: string,
    timeoutMs?: number, desc?: string, traceIt = true,
  ): Promise<void> => {
    assertOpen(label);
    const url = resolveCtxUrl(rawUrl);
    if (hosts && hosts.length && disallowedHost(url, hosts)) {
      throw new StopError("host_not_allowed", `${label}: ${JSON.stringify(url)} is outside the declared hosts envelope (${hosts.join(", ")})`);
    }
    navGate(call, label, url);
    const p = await page();
    try {
      await (p as unknown as { goto(u: string, o?: unknown): Promise<unknown> }).goto(
        url, { waitUntil: "domcontentloaded", timeout: timeoutMs ?? 30_000 },
      );
    } catch (e) {
      // 网络/可达性失败 ≠ 声明错误：DNS 解析失败、连接拒绝、导航超时都是「站点此刻
      // 不可达」，正确动作是验证可达后重试/放宽 --timeout，不是改声明。只有其余
      // 异常（如畸形 URL）才归 config_error（改声明，不要重试）。
      const msg = e instanceof Error ? e.message : String(e);
      if (/Timeout .*ms exceeded|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED|ERR_NAVIGATION_ABORTED/.test(msg)) {
        throw new StopError("unreachable",
          `${label}(${JSON.stringify(url)}) unreachable: ${msg}——先验证站点可达（curl/fetch），再放宽 --timeout 或稍后重试；不是声明错误，改 meta 无效`);
      }
      throw new StopError("config_error", `${label}(${JSON.stringify(url)}) failed: ${msg}`);
    }
    // 落地检查：请求 URL 过了信封不代表**最终页面**也过了（302/重定向可以跨主机）。
    const landed = urlOf(p);
    if (landed && hosts && hosts.length && disallowedHost(landed, hosts)) {
      throw new StopError("host_not_allowed",
        `${label}: landed on ${JSON.stringify(landed)} outside the declared hosts envelope (${hosts.join(", ")})`);
    }
    currentUrl = landed || url;
    markDirectNavLanded();
    pageState.update(p, "settled");
    if (traceIt) pushEvent(trace, { call, url: currentUrl, ...(desc === undefined ? {} : { desc }) });
  };

  const runOneStep = async (desc: string, req: {
    url?: string; done: DomSignal | Record<string, unknown>; act?: TargetDecl | CommandDecl[];
    slots?: Record<string, string>; values?: Record<string, string>;
    when?: DomSignal | null; id?: string; timeoutMs?: number;
    forceAct?: boolean; force?: boolean; staleRetry?: boolean;
    newTab?: { urlContains?: string };
  }): Promise<StepResult> => {
    assertOpen(`ctx.step(${JSON.stringify(desc)})`);
    checkBudget();
    await paceBeforeStep();
    const started = Date.now();
    const startUrl = resolveCtxUrl(req.url ?? currentUrl);
    if (hosts && hosts.length && disallowedHost(startUrl, hosts)) {
      throw new StopError("host_not_allowed", `ctx.step: ${JSON.stringify(startUrl)} is outside the declared hosts envelope (${hosts.join(", ")})`);
    }
    const session = await deps.ensureSession();
    // A6 walk 调试模式：步声明的 url 与当前页**同页**（origin+path 相同）=「起点 URL=当前页」
    // 的重锚，折叠成缺省「当前页」语义——不重导航（SPA 客户端状态跨步保留）；指向另一页的
    // 显式 url 仍然导航。默认（walk 关）逐字节不变：带 url 就导航。
    const walkKeepPage = deps.walk === true && req.url !== undefined
      && samePage(startUrl, urlOf(session.page) || currentUrl);
    // 导航纪律闸门（entry-only）：step 级 url 重锚是引擎发起的直接导航（执行器在
    // skipNavigation 关闭时 `pg.goto(startUrl)`）；walk 的同页重锚没有 goto，不进闸门。
    if (req.url !== undefined && !walkKeepPage) navGate("step", `ctx.step(${JSON.stringify(desc)})`, startUrl);
    if (req.url !== undefined && !walkKeepPage) currentUrl = startUrl;
    // ---- F2 newTab（缺省不声明 = 本块整体不存在，行为逐字节不变）----
    // ① 去重采用：动作前已存在 URL 命中 urlContains 的标签（此前尝试开的）→ 直接切过去、
    //    不再点击（act/决策动作整体跳过），done 在该标签上判定——消重复标签。
    //    信封外的命中标签不采用（与 switchTab/popup 同一判定），照常走动作路径。
    const nt = req.newTab;
    const ntActive = nt !== undefined && nt !== null;
    const ntContains = ntActive && typeof (nt as { urlContains?: unknown })["urlContains"] === "string"
      ? String((nt as { urlContains: string })["urlContains"]) : undefined;
    type NtTab = { index: number; url: string; title: string; adopted: "existing" | "opened" };
    let ntAdopted: NtTab | null = null;
    let ntAdoptedPage: TabPage | null = null;
    let ntSkipAction = false;
    let ntBeforePages: Set<unknown> | null = null;
    if (ntActive) {
      const listed = await listTabs(session);
      if (ntContains !== undefined && ntContains.trim()) {
        const hit = listed.find((t) => t.url.toLowerCase().includes(ntContains.toLowerCase()));
        if (hit && !(hosts && hosts.length && disallowedHost(hit.url, hosts))) {
          ntAdopted = { index: hit.index, url: hit.url, title: hit.title, adopted: "existing" };
          ntAdoptedPage = hit.page;
          ntSkipAction = true;
        }
      }
      if (!ntSkipAction) ntBeforePages = new Set<unknown>(await contextPages(session));
    }
    if (ntSkipAction && ntAdopted !== null && ntAdoptedPage !== null) {
      // 去重采用路径：不进执行器（零动作），done 只在采用的标签上求值（如实，不假装成功）。
      const before = urlOf(session.page as unknown as PageLike) || currentUrl;
      session.page = ntAdoptedPage as unknown as typeof session.page;
      currentUrl = ntAdopted.url;
      await bounded(() => (ntAdoptedPage as { bringToFront?: () => Promise<void> }).bringToFront?.(), 2000);
      await bounded(() => (ntAdoptedPage as { waitForLoadState?: (s?: string, o?: { timeout?: number }) => Promise<void> })
        .waitForLoadState?.("domcontentloaded", { timeout: 5000 }), 5000);
      let held = false;
      try {
        held = (await checkSignal(ntAdoptedPage as never, req.done as never)) === true;
      } catch (e) {
        throw new StopError("config_error",
          `ctx.step newTab dedup: done signal evaluation failed on the adopted tab: ${e instanceof Error ? e.message : String(e)}`);
      }
      budget.stepsUsed += 1;
      try { pageState.update(ntAdoptedPage, "settled"); } catch { /* 记录面让位事实 */ }
      const result: StepResult = {
        ok: held,
        ...(req.id === undefined ? {} : { id: req.id }),
        ...(held ? {} : { stopCode: "done_not_held" }),
        ...(held
          ? { reason: `newTab dedup: adopted existing tab ${JSON.stringify(ntAdopted.url)} (was ${JSON.stringify(before)}); done-signal held on it, no click performed` }
          : { reason: `newTab dedup: adopted existing tab ${JSON.stringify(ntAdopted.url)} (no click performed — a tab matching urlContains already existed) but the done-signal never held on it` }),
        newTab: ntAdopted,
        evidence: { url: ntAdopted.url, attempts: 1, elapsedMs: Date.now() - started },
      };
      record(held, {
        desc, url: ntAdopted.url,
        ...(req.id === undefined ? {} : { id: req.id }),
        ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
        result: {
          ok: held,
          ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          elapsed_ms: result.evidence.elapsedMs,
          new_tab: ntAdopted,
        },
      });
      return result;
    }
    const opts: Record<string, unknown> = {
      goalSignalFn: (p: unknown) => checkSignal(p as never, req.done as never),
      page: session.page,
      // 不带 url = 决策语句在当前页上执行；带 url 才先导航。整页重载会丢 SPA 状态。
      // walk 的同页重锚（walkKeepPage）走同一条「当前页」路径（A6）。
      ...(req.url === undefined || walkKeepPage ? { skipNavigation: true } : {}),
      poolReady: true,
      ...(deps.poolReadyTimeoutMs === undefined ? {} : { poolReadyTimeoutMs: deps.poolReadyTimeoutMs }),
      ...(deps.poolReadyPollMs === undefined ? {} : { poolReadyPollMs: deps.poolReadyPollMs }),
      ...(deps.poolGate === undefined ? {} : { poolGate: deps.poolGate }),
      ...(deps.surfacePolicy === undefined ? {} : { surfacePolicy: deps.surfacePolicy }),
      ...(req.timeoutMs === undefined
        // 04-F：步级 timeoutMs 以前声明了却从未接进执行器——现在映射到该步的 done 等待上限
        // （本次显式 > meta.policy.done_timeout_ms）。它约束的是"动作后等信号成立"的窗口，
        // 不约束整步挂钟时长（模型咨询/导航耗时不在其内）。
        // F3：显式 timeoutMs 同时是该步的**整步挂钟帽**（stepTimeoutMs）——reobserve/升级
        // 循环的每轮与总时长受它约束，超时 = 结构化 stop_timeout。未声明 = 无帽，不变。
        ? (deps.doneTimeoutMs === undefined ? {} : { doneTimeoutMs: deps.doneTimeoutMs })
        : { doneTimeoutMs: req.timeoutMs, stepTimeoutMs: req.timeoutMs }),
      ...(deps.donePollMs === undefined ? {} : { donePollMs: deps.donePollMs }),
      // 带 url 的步：domcontentloaded 对 SPA 太早，给面板一个短稳定窗口再抽取。
      // walk 同页重锚没有 goto（页面早已就位），与不带 url 的步同待遇。
      ...(req.url === undefined || walkKeepPage ? {} : { settleMs: 700 }),
      pw: session.pw,
      slots: { ...slots, ...(req.slots ?? {}) },
      // U1：步级显式值袋（缺省不出现 = 既有行为逐字节不变；执行器只在决策步值请求里用）。
      ...(req.values === undefined ? {} : { values: req.values }),
      verbose: deps.verbose === true,
    };
    if (req.when !== undefined && req.when !== null) opts["precondition"] = req.when;
    // P0-E：原始 done 声明进执行器（只读；false_done guard 的「弱 done 零前进」判定用）。
    opts["doneSpec"] = req.done as never;
    // A1 forceAct：只把声明透传给执行器（缺省不出现 = 既有行为不变；执行器只记录、不改变顺序）。
    if (req.forceAct === true) opts["forceAct"] = true;
    // S4：步级 force / staleRetry 同样是显式声明（缺省不出现 = 既有行为逐字节不变）。
    if (req.force === true) opts["force"] = true;
    if (req.staleRetry === true) opts["staleRetry"] = true;
    if (ntActive && !ntSkipAction && req.act !== undefined && !Array.isArray(req.act)
        && (req.act as { kind?: string }).kind === "hint") {
      // F2：newTab + 单条 act hint → 收敛为**恰好一次点击**的单命令闭集：点完即判 done，
      // done 不成立 = done_not_held（不再重试连点，避免同一动作开出一串重复标签）。
      // 命令 target 走既有声明解析链（池/ADMIT/FW8/DRF），hint 语义不变。
      const hint = String((req.act as { hint: string }).hint);
      const one: CommandDecl[] = normalizeCommandIds([{ id: "newtab_open", op: "click", target: hint }]);
      const problems: string[] = [];
      validateCommands(one, "ctx.step", problems);
      if (problems.length) throw new StopError("config_error", problems.join("；"));
      opts["commands"] = one;
    } else {
      Object.assign(opts, req.act === undefined ? {} : targetOptions(req.act));
    }
    let rep: RunReport;
    try {
      rep = await deps.mw().run(desc, startUrl, opts as never);
    } catch (e) {
      // 执行器把"动作失败"当结果而不是异常（既有语义）；走到这里只可能是配置级错误。
      throw new StopError("config_error", `ctx.step ${JSON.stringify(desc)} crashed: ${e instanceof Error ? e.message : String(e)}`);
    }
    deps.onRunReport?.(rep);
    budget.stepsUsed += 1;
    // ---- F2 newTab ②：动作后短暂等待新标签并自动采用（读面 + 动作面），done 在新标签上判定 ----
    // 声明了 newTab 且没有命中已存标签时执行；没有新标签出现 = rep 原样（正常 done 判定，
    // 如实失败）。已在途的 executor 轮询即"短暂等待"（动作后 done 窗口内新 tab 已 commit）。
    if (ntActive && !ntSkipAction) {
      try {
        const listed = await listTabs(session);
        const fresh = ntBeforePages === null ? [] : listed.filter((t) => !ntBeforePages!.has(t.page));
        if (fresh.length > 0) {
          const pick = (ntContains !== undefined && ntContains.trim()
            ? fresh.find((t) => t.url.toLowerCase().includes(ntContains.toLowerCase()))
            : undefined) ?? fresh[fresh.length - 1]!;
          // 信封外的新标签不采用（既有 popup 门禁已在执行器侧拒绝；这里只是不再重复处理）。
          if (!(hosts && hosts.length && disallowedHost(pick.url, hosts))) {
            session.page = pick.page as unknown as typeof session.page;
            await bounded(() => pick.page.bringToFront?.(), 2000);
            await bounded(() => pick.page.waitForLoadState?.("domcontentloaded", { timeout: 5000 }), 5000);
            ntAdopted = { index: pick.index, url: pick.url, title: pick.title, adopted: "opened" };
            ntAdoptedPage = pick.page;
            try {
              if ((await checkSignal(pick.page as never, req.done as never)) === true) {
                rep = { ...rep, done: true, stop_code: "dom_goal_signal",
                  stop_reason: "dom goal signal (new tab adopted; done judged on the adopted tab)" };
              } else {
                rep = { ...rep, done: false, stop_code: "done_not_held",
                  stop_reason: `new tab ${JSON.stringify(pick.url)} was opened and adopted (read+action face follow it), `
                    + `but the done-signal never held on the adopted tab — judged honestly there` };
              }
            } catch (e) {
              throw new StopError("config_error",
                `ctx.step newTab: done signal evaluation failed on the adopted tab: ${e instanceof Error ? e.message : String(e)}`);
            }
            try { pageState.update(pick.page, "settled"); } catch { /* 记录面让位事实 */ }
          }
        }
      } catch (e) {
        if (e instanceof StopError) throw e;
        // 标签枚举失败不吞掉执行器的既有结论（如实按 rep 判定）。
      }
    }
    // 动作可能导航到另一个页面；`ctx.step` 之后的下一条语句必须从**落地页**开始，
    // 否则 `ctx.step({url?})` 会把上一页当成当前页（实测：Maps 已打开，下一步却又回到 google.com）。
    const landed = urlOf(session.page) || startUrl;
    currentUrl = landed;
    // 入口只在**真的发生直接导航**时建立（无 url 的步没有 goto，不烧入口槽）。
    if (req.url !== undefined && !walkKeepPage) markDirectNavLanded();
    const landedState = pageState.update(session.page as unknown as PageLike, "settled");
    const reason = typeof rep.stop_reason === "string" && rep.stop_reason ? rep.stop_reason : undefined;
    // when 守卫不成立的步（rep.skipped）= “不适用”，不是“完成”：执行器在计划层把它记成
    // done 让流程前进，但 ctx.step 对作者返回 ok:false + stopCode="precondition_skipped"
    // （与 §4 文档和本文件 when 字段注释一致），脚本据 stopCode 分支。跳过步同样消耗预算。
    const skipped = rep.skipped === true;
    const result: StepResult = {
      ok: rep.done === true && !skipped,
      ...(req.id === undefined ? {} : { id: req.id }),
      ...(rep.stop_code === undefined ? {} : { stopCode: rep.stop_code }),
      ...(reason === undefined ? {} : { reason }),
      evidence: { url: landed, attempts: 1, elapsedMs: Date.now() - started, pageState: landedState },
      // A1 动作执行证据：执行器只在有事实时给字段，这里原样透出（缺省不硬造）。
      ...(rep.executed === undefined ? {} : { executed: rep.executed }),
      ...(rep.executed_actions === undefined ? {} : { executed_actions: rep.executed_actions }),
      ...(rep.skipped_actions === undefined ? {} : { skipped_actions: rep.skipped_actions }),
      ...(rep.stale_retries === undefined ? {} : { stale_retries: rep.stale_retries }),
      ...(rep.forced === undefined ? {} : { forced: rep.forced }),
      ...(rep.done_preheld === undefined ? {} : { done_preheld: rep.done_preheld }),
      ...(rep.warnings === undefined ? {} : { warnings: rep.warnings }),
      ...(rep.diagnostics === undefined ? {} : { diagnostics: rep.diagnostics }),
      // S1 状态记录：执行器只在本 run 有观察时给；原样透出（dry 面另有合成值）。
      ...(rep.state === undefined ? {} : { state: rep.state }),
      // F2 newTab：本步采用的新标签事实（缺字段 = 没声明 newTab 或没有标签被采用）。
      ...(ntAdopted === null ? {} : { newTab: ntAdopted }),
    };
    record(result.ok, {
      desc, url: landed,
      ...(req.id === undefined ? {} : { id: req.id }),
      ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
      result: {
        ok: result.ok,
        // 成功步不写 stop_code：`dom_goal_signal` 这类是执行器的“完成依据”停因，不是失败分类，
        // 放在名为 stop_code 的字段里会把成功读成失败（01 轮 B6）。完成动作证据在 hows/methods 行里。
        ...(result.ok ? {} : { stop_code: result.stopCode ?? null }),
        ...(reason === undefined ? {} : { reason }),
        elapsed_ms: result.evidence.elapsedMs,
        // PageState 的紧凑证据；不记 observedAt（每次运行都会变，不属于结构）。
        page_state: {
          page_id: landedState.pageId,
          readiness: landedState.readiness,
          pool_version: landedState.poolVersion,
          frame_origins: landedState.frameOrigins,
        },
        // A1：动作执行证据同样进 trace event 的 result——app-runner 的 step_traces 与
        // report.md 的动作证据小节都从这一份投影（缺省不出现，旧产物形状不变）。
        ...(result.executed === undefined ? {} : { executed: result.executed }),
        ...(result.executed_actions === undefined ? {} : { executed_actions: result.executed_actions }),
        ...(result.skipped_actions === undefined ? {} : { skipped_actions: result.skipped_actions }),
        ...(result.stale_retries === undefined ? {} : { stale_retries: result.stale_retries }),
        ...(result.forced === undefined ? {} : { forced: result.forced }),
        ...(result.done_preheld === undefined ? {} : { done_preheld: result.done_preheld }),
        ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
        ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
        ...(result.state === undefined ? {} : { state: result.state }),
        ...(ntAdopted === null ? {} : { new_tab: ntAdopted }),
      },
    });
    return result;
  };

  /**
   * 工具步结果的**唯一收口**（命令行/声明两形式共用）：有界 output、失败诊断、数据集回写、
   * trace 事件。三条纪律都在这里，脚本面无法绕过：
   *   - 返回值只在**信号成立**后写（`ok !== true` 一个都不写）；
   *   - `writtenBy = <id|desc>#<attempts>`（与声明式路径同一形状，审计能数到第几次尝试）；
   *   - 失败原因带底层证据（exit code + stderr 尾行），不是 `refusalLine` 空壳。
   */
  const finishToolRun = (
    r: ToolRunResult, started: number, call: "run" | "dangerous",
    desc: string, req: { source: string; id?: string; adapter?: string },
  ): StepResult => {
    const ok = r.ok === true;
    const stopCode = r.stopCode ?? (ok ? undefined : (r.refused ?? "tool_failed"));
    const attempts = r.attempts ?? 1;
    const elapsedMs = Date.now() - started;
    const out = capToolText(r.stdout);
    const err = capToolText(r.stderr);
    const tail = stderrTail(r.stderr);
    const reason = stopCode === undefined
      ? r.reason
      : toolFailureReason(stopCode, r.code, tail, r.reason);
    // 数据集回写（T2）：步标识必须是**稳定非空**字符串；`desc` 在两条入口都有缺省，不会空。
    const written: string[] = [];
    const stepKey = (req.id !== undefined && req.id.trim() ? req.id.trim() : desc).trim();
    if (ok && r.returns !== undefined && deps.dataset !== undefined && stepKey) {
      const writtenBy = `${stepKey}#${attempts}`;
      for (const [name, value] of Object.entries(r.returns)) {
        deps.dataset.write(name, value, writtenBy);
        written.push(name);
      }
    }
    const hasOutput = out.text.length > 0 || err.text.length > 0
      || (r.code !== null && r.code !== undefined);
    const isCli = req.adapter === undefined || req.adapter === "cli";
    const result: StepResult = {
      ok,
      ...(stepKey && req.id !== undefined ? { id: stepKey } : {}),
      ...(stopCode === undefined ? {} : { stopCode }),
      ...(reason === undefined ? {} : { reason }),
      ...(hasOutput ? {
        output: {
          code: r.code ?? null, stdout: out.text, stderr: err.text,
          ...(out.truncated || err.truncated ? { truncated: true as const } : {}),
        },
      } : {}),
      ...(r.artifact === undefined ? {} : { artifact: r.artifact }),
      evidence: { url: currentUrl, attempts, elapsedMs },
    };
    pushEvent(trace, {
      call, desc, ok,
      ...(stopCode === undefined ? {} : { stop_code: stopCode }),
      // 08-C：attempts/code/refused 进事件 result（投影面从这里读，不再只有脚本侧 evidence）。
      // T6：工具步至少带 code/ok（事件顶层 ok）/artifact/stderr_tail——失败不再是空壳。
      result: {
        source: req.source,
        ...(isCli ? {} : { adapter: req.adapter }),
        ...(stepKey && req.id !== undefined ? { id: stepKey } : {}),
        attempts, code: r.code ?? null, refused: r.refused ?? null,
        ...(isCli ? { dry_run: r.dryRun ?? null } : (r.dryRun === undefined ? {} : { dry_run: r.dryRun })),
        elapsed_ms: elapsedMs,
        ...(r.artifact === undefined ? {} : { artifact: r.artifact }),
        ...(tail === undefined ? {} : { stderr_tail: tail }),
        // T4：信号不成立的结构化诊断（path/类型/值摘要）也进 trace——投影面/报告从
        // 同一份事件重建，不再只剩「signal not held」。
        ...(stopCode !== undefined && r.reason !== undefined ? { reason: r.reason } : {}),
        ...(written.length > 0 ? { dataset_written: written } : {}),
      },
    });
    return result;
  };
  const runTool = async (source: string, args: string[], req: ToolRunRequest, dangerous: boolean): Promise<StepResult> => {
    if (typeof source !== "string" || !source.trim()) throw new StopError("config_error", "ctx.run: source must be a non-empty string");
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new StopError("config_error", "ctx.run: args must be a list of strings");
    if (req === null || typeof req !== "object" || req.done === undefined || req.done === null) {
      throw new StopError("config_error", "ctx.run: done signal is required (completion is the process observation)");
    }
    // T7：工具信号载荷的运行期兜底（与 dry 同一份校验器）。坏载荷是配置错误，
    // 不能落到 `checkToolSignal` 里静默 false。
    const signalProblems = validateToolSignal(req.done as ToolSignal, `ctx.run(${JSON.stringify(req.desc ?? source)}).done`);
    if (signalProblems.length) {
      throw new StopError("config_error", signalProblems.join("；"));
    }
    if (dangerous && (!Array.isArray(req.dryRunArgs) || req.dryRunArgs.length === 0)) {
      throw new StopError("config_error", "ctx.dangerous requires dryRunArgs (a failed dry run must never apply)");
    }
    if (deps.toolRunner === undefined) {
      throw new StopError("config_error", "ctx.run: no tool runner wired in this build");
    }
    // 与声明式适配器同一条纪律（load 期就该红；ctx 在运行期补一次，flow 也逃不掉）。
    if ((req.retries ?? 0) > 0 && req.idempotent !== true) {
      throw new StopError("config_error",
        `ctx.run: retries=${req.retries} needs idempotent: true (re-running a process can be irreversible)`);
    }
    // `returns` 只认既有 `ReturnExtractor` 声明面（缺失/形状错 = fail closed，不给模型开口子）。
    const returns = toolReturns(req.returns, `ctx.run(${JSON.stringify(req.desc ?? source)})`);
    assertOpen(`ctx.run` + (req.desc ? ` ${JSON.stringify(req.desc)}` : ""));
    checkBudget();
    await paceBeforeStep();
    const started = Date.now();
    let r: ToolRunResult;
    try {
      r = await deps.toolRunner({
        ...req, desc: req.desc ?? (dangerous ? `dangerous ${source}` : `run ${source}`),
        ...(req.id === undefined ? {} : { id: req.id.trim() || undefined }),
        returns, source, args, ...(dangerous ? { dangerous: true } : {}),
      });
    } catch (e) {
      // 工具源名/配置错（如 loadSource 抛）不能变成裸栈：给结构化 config_error。
      throw new StopError("config_error",
        `ctx.run: ${e instanceof Error ? e.message : String(e)}`);
    }
    budget.stepsUsed += 1;
    return finishToolRun(r, started, dangerous ? "dangerous" : "run",
      req.desc ?? source, { source, ...(req.id === undefined ? {} : { id: req.id }) });
  };
  /** 声明形式：挑适配器 → 交给驱动（与声明式 journey 同一套适配器实现）。 */
  const runDeclaredTool = async (step: Record<string, unknown>, dangerous: boolean): Promise<StepResult> => {
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      throw new StopError("config_error", "ctx.run: the declaration form needs an object like { stdio: {...}, done: {...} }");
    }
    const done = step["done"];
    // T7：未知顶层键/`signal` 冲突/done 必需在真实与 dry 两面念同一段文案
    // （`declaredRunProblems` 是唯一出处）。
    const declaredProblems = declaredRunProblems(step);
    if (declaredProblems.length) {
      throw new StopError("config_error", declaredProblems.join("；"));
    }
    const adapter = typeof step["adapter"] === "string" && step["adapter"]
      ? step["adapter"]
      : step["ssh"] !== undefined ? "ssh"
        : step["stdio"] !== undefined ? "stdio"
          : "cli";
    if (adapter === "web") {
      throw new StopError("config_error", "ctx.run: the web adapter is not a process step; use ctx.step() for browser steps");
    }
    try {
      requireAppAdapter(adapter);
    } catch {
      throw new StopError("config_error", `ctx.run: unknown app adapter ${JSON.stringify(adapter)} (known: ${listAppAdapters().join(", ")})`);
    }
    // `returns`/`id` 在两条分支（cli 委托 / 其它适配器直跑）前统一规范化一次。
    const declaredSource = typeof step["source"] === "string" ? step["source"] : "";
    const declaredDesc = typeof step["desc"] === "string" && step["desc"]
      ? step["desc"]
      : adapter === "cli" ? `cli:${declaredSource || "declared"}` : `${adapter} step`;
    const declaredReturns = toolReturns(step["returns"], `ctx.run(${JSON.stringify(declaredDesc)})`);
    const declaredId = typeof step["id"] === "string" && step["id"].trim() ? step["id"].trim() : undefined;
    if (adapter === "cli") {
      // 声明形式的 cli 步与命令行形式完全等价（args/dryRunArgs/idempotent/retries 都认）。
      const cliArgs = Array.isArray(step["args"]) ? (step["args"] as unknown[]).map(String) : [];
      const cliReq: ToolRunRequest = {
        desc: declaredDesc,
        source: declaredSource, done: done as Record<string, unknown>, adapter: "cli", rawStep: step,
        ...(declaredId === undefined ? {} : { id: declaredId }),
        ...(declaredReturns === null ? {} : { returns: declaredReturns }),
        ...(Array.isArray(step["dryRunArgs"]) ? { dryRunArgs: (step["dryRunArgs"] as unknown[]).map(String) } : {}),
        ...(step["idempotent"] === true ? { idempotent: true } : {}),
        ...(typeof step["retries"] === "number" ? { retries: step["retries"] } : {}),
        ...(dangerous ? { dangerous: true } : {}),
      };
      return runTool(declaredSource, cliArgs, cliReq, dangerous);
    }
    if (deps.toolRunner === undefined) throw new StopError("config_error", "ctx.run: no tool runner wired in this build");
    checkBudget();
    await paceBeforeStep();
    const started = Date.now();
    const desc = declaredDesc;
    let r: ToolRunResult;
    try {
      r = await deps.toolRunner({
        desc, source: declaredSource || `${adapter}:declared`,
        done: done as Record<string, unknown>, adapter, rawStep: step,
        ...(declaredId === undefined ? {} : { id: declaredId }),
        ...(declaredReturns === null ? {} : { returns: declaredReturns }),
        ...(dangerous ? { dangerous: true } : {}),
      });
    } catch (e) {
      throw new StopError("config_error", `ctx.run: ${e instanceof Error ? e.message : String(e)}`);
    }
    budget.stepsUsed += 1;
    return finishToolRun(r, started, dangerous ? "dangerous" : "run", desc, {
      source: declaredSource || `${adapter}:declared`,
      adapter,
      ...(declaredId === undefined ? {} : { id: declaredId }),
    });
  };

  /**
   * 行抽取的**唯一实现**（`ctx.extract` 与 `ctx.collect` 共用）：对当前 DOM 取行对象。
   * 字段值 = 行内相对选择器的文本投影（表单控件回退 inputValue；"." = 行自身文本）。
   * 返回 `{ rows, total }`：`total` = 当前匹配行总数（截断对账用）。
   */
  const readRows = async (
    rowSelector: string, fields: Record<string, string>, cap = 500,
  ): Promise<{ rows: Array<Record<string, string>>; total: number }> => {
    const p = await page();
    const rowsLoc = await locatorAnyFrame(p, rowSelector);
    const rows: Array<Record<string, string>> = [];
    if (rowsLoc === null) return { rows, total: 0 };
    const all = rowsLoc.all === undefined ? null : await rowsLoc.all();
    if (all === null) {
      throw new StopError("config_error", "ctx.extract needs a Playwright locator (locator.all() is not available here)");
    }
    for (const row of all.slice(0, cap)) {
      const locators = row as {
        locator?: (s: string) => { first(): { innerText(o?: { timeout?: number }): Promise<string>; inputValue(o?: { timeout?: number }): Promise<string> } };
        innerText?: (o?: { timeout?: number }) => Promise<string>;
      };
      const rec: Record<string, string> = {};
      for (const [field, cellSel] of Object.entries(fields)) {
        let value = "";
        try {
          if (cellSel === "." || cellSel === ":scope") {
            if (typeof locators.innerText === "function") value = await locators.innerText({ timeout: 1500 });
          } else if (typeof locators.locator === "function") {
            const cell = locators.locator(cellSel).first();
            try { value = await cell.innerText({ timeout: 1500 }); }
            catch { value = await cell.inputValue({ timeout: 1500 }); }
          }
        } catch { value = ""; }
        rec[field] = String(value ?? "").trim();
      }
      rows.push(rec);
    }
    return { rows, total: all.length };
  };

  /**
   * S3 collect：把行元素所在容器的滚动推进一屏（最近可滚动祖先；否则页面滚动元素）。
   * 逐 frame 探测（行可能在可达的子 frame 里，同源/跨源均可定位）；找不到行 = found:false。
   */
  const scrollRowsContainer = async (
    rowSelector: string,
  ): Promise<{ found: boolean; scrollable: boolean; moved: boolean; atBottom: boolean }> => {
    const p = await page();
    for (const fr of framesOf(p)) {
      try {
        const raw = await fr.evaluate((sel: string) => {
          // 只用结构类型：本仓库 tsconfig 不含 DOM lib（页面侧形状走 structural cast）。
          type DomNode = {
            scrollTop: number; scrollHeight: number; clientHeight: number;
            parentElement: DomNode | null;
          };
          const g = globalThis as unknown as {
            document?: {
              querySelectorAll(s: string): { length: number; [index: number]: DomNode };
              documentElement: DomNode;
              scrollingElement?: DomNode | null;
              body: unknown;
            };
            getComputedStyle(e: DomNode): { overflowY?: string | null } | null;
          };
          const doc = g.document;
          if (!doc) return { found: false, scrollable: false, moved: false, atBottom: true };
          const rows = doc.querySelectorAll(sel);
          if (!rows.length) return { found: false, scrollable: false, moved: false, atBottom: true };
          let node: DomNode | null = rows[rows.length - 1]!;
          let container: DomNode | null = null;
          while (node !== null) {
            const cs = g.getComputedStyle(node);
            const oy = cs === null || cs === undefined ? "" : String(cs.overflowY || "");
            if ((oy === "auto" || oy === "scroll" || oy === "overlay")
              && node.scrollHeight > node.clientHeight + 2) { container = node; break; }
            node = node.parentElement;
          }
          if (container === null) {
            const se = doc.scrollingElement || doc.documentElement;
            if (se && se.scrollHeight > se.clientHeight + 2) container = se;
          }
          if (container === null) return { found: true, scrollable: false, moved: false, atBottom: true };
          const before = Number(container.scrollTop) || 0;
          const max = Math.max(0, Number(container.scrollHeight) - Number(container.clientHeight));
          const stepPx = Math.max(200, Math.floor((Number(container.clientHeight) || 0) * 0.8));
          container.scrollTop = Math.min(max, before + stepPx);
          const after = Number(container.scrollTop) || 0;
          return { found: true, scrollable: true, moved: after !== before, atBottom: after >= max - 2 };
        }, rowSelector);
        if (raw !== null && typeof raw === "object") {
          const rec = raw as Record<string, unknown>;
          if (rec["found"] === true) {
            return {
              found: true,
              scrollable: rec["scrollable"] === true,
              moved: rec["moved"] === true,
              atBottom: rec["atBottom"] === true,
            };
          }
        }
      } catch {
        continue;   // 跨源 frame：evaluate 抛错，跳过
      }
    }
    return { found: false, scrollable: false, moved: false, atBottom: true };
  };

  const kit = createKit();
  // S1：`runtime.epoch` 是**执行器游标**的只读投影（不自建第二份状态来源）。
  const runtimeView = Object.freeze({
    outDir: runtime.outDir, runId: runtime.runId, today: runtime.today,
    get epoch(): number { return deps.mw().stateEpoch(); },
  });
  const ctx: Ctx = {
    judge: kit.judge,
    tool: kit.tool,
    hint: kit.hint,
    hints: kit.hints,
    command: kit.command,
    value: kit.value,
    app: { id: pack.id, ...(pack.label === undefined ? {} : { label: pack.label }), goal: pack.goal },
    slots: Object.freeze({ ...slots }),
    runtime: runtimeView,
    budget,
    log: (msg, data) => {
      pushEvent(trace, { call: "log", desc: msg, ...(data === undefined ? {} : { result: data }) });
      if (deps.verbose) console.log(`  [flow] ${msg}`);
    },
    open: async (u, o = {}) => { await navigate(u, "open", "ctx.open", o.timeoutMs); },
    openPage: async (role) => {
      if (typeof role !== "string" || !role.trim()) {
        throw new StopError("config_error", "ctx.openPage: role must be a non-empty string");
      }
      const pages = (pack.site?.pages ?? {}) as Record<string, string>;
      const url = pages[role];
      if (typeof url !== "string" || !url.trim()) {
        const known = Object.keys(pages);
        throw new StopError("config_error",
          `ctx.openPage(${JSON.stringify(role)}): no such page role in meta.site.pages`
          + ` (known: ${known.length ? known.join(", ") : "none declared"})${known.length ? "" : " — declare meta.site.pages or use ctx.open(url)"}`);
      }
      await navigate(url, "openPage", `ctx.openPage(${JSON.stringify(role)})`, undefined, role);
    },
    arrive: async (u, req) => {
      if (!isObj(req) || !isObj(req.done) || !Object.keys(req.done).length) {
        throw new StopError("config_error", "ctx.arrive: done signal is required");
      }
      checkBudget();
      await paceBeforeStep();
      const started = Date.now();
      const label = req.desc ?? `到达 ${u}`;
      // 纯导航：只 goto + 等信号，**不做元素选择、不花模型**（以前误走 step 路径：
      // 记录成 step、还会因选不到元素而 no_model_runtime —— 三实现漂移，replay 必 mismatch）。
      await navigate(u, "arrive", label, req.timeoutMs, req.desc, false);
      const timeout = req.timeoutMs ?? 15_000;
      const deadline = Date.now() + timeout;
      let held = false;
      let waitErr: unknown;
      let hostViolation: string | null = null;
      try {
        const p = await page();
        const pAny = p as unknown as { waitForTimeout?(ms: number): Promise<void> };
        do {
          const landed = urlOf(p);
          if (landed) {
            if (hosts && hosts.length && disallowedHost(landed, hosts)) { hostViolation = landed; break; }
            currentUrl = landed;
            pageState.update(p as PageLike, "settled");
          }
          try {
            if (await checkSignal(p as never, req.done as never)) { held = true; break; }
          } catch (e) { waitErr = e; break; }        // 坏信号 = 配置错误，别轮询到超时
          if (typeof pAny.waitForTimeout === "function") await pAny.waitForTimeout(200);
          else await new Promise((r) => setTimeout(r, 200));
        } while (Date.now() < deadline);
      } catch (e) { waitErr = e; }
      budget.stepsUsed += 1;
      const stopCode = held ? undefined : (hostViolation !== null ? "host_not_allowed" : "arrive_signal_not_held");
      const failReason = held ? undefined
        : hostViolation !== null
          ? `arrive: landed on ${JSON.stringify(hostViolation)} outside the declared hosts envelope (${hosts?.join(", ")})`
          : `arrive: navigation finished but done-signal never held within ${timeout}ms`
            + (waitErr instanceof Error ? ` (${waitErr.message})` : "");
      // 06-D：与 ctx.step 记录面同形——成功也留"到达依据"文案，嵌套 result 带 page_state；
      // 不为 arrive 伪造 method/hows（它没有决策流水，差异是语义不是缺陷）。
      const reason = held ? "arrive signal held" : failReason;
      let arrivedState: ReturnType<typeof pageState.update> | null = null;
      if (held) {
        try { arrivedState = pageState.update((await page()) as PageLike, "settled"); } catch { /* 记录面让位事实 */ }
      }
      const result: StepResult = {
        ok: held,
        ...(req.id === undefined ? {} : { id: req.id }),
        ...(stopCode === undefined ? {} : { stopCode }),
        ...(reason === undefined ? {} : { reason }),
        evidence: { url: currentUrl, attempts: 1, elapsedMs: Date.now() - started },
      };
      pushEvent(trace, {
        call: "arrive", desc: req.desc ?? label, url: currentUrl, ok: held,
        ...(req.id === undefined ? {} : { id: req.id }),
        ...(stopCode === undefined ? {} : { stop_code: stopCode }),
        result: { ok: held, ...(stopCode === undefined ? {} : { stop_code: stopCode }),
          ...(reason === undefined ? {} : { reason }), elapsed_ms: result.evidence.elapsedMs,
          ...(arrivedState === null ? {} : {
            page_state: {
              page_id: arrivedState.pageId,
              readiness: arrivedState.readiness,
              pool_version: arrivedState.poolVersion,
              frame_origins: arrivedState.frameOrigins,
            },
          }) },
      });
      return result;
    },
    // ---- P0-A observe：免费只读（不占预算/不 pace/不写盘/不进模型面/不改页面）----
    observe: async (opts = {}) => {
      // 声明面先校验（形状错误 = config_error；非法 CSS 不在这里判——那要浏览器才知道，
      // 且 observe 用结构化 {ok:false,error:"bad_selector"} 回报，不中断 flow）。
      const problems = validateObserveOptions(opts);
      if (problems.length) throw new StopError("config_error", problems.join("；"));
      const started = Date.now();
      const session = await deps.ensureSession();
      const result = await observePage(session.page as unknown as PageLike, opts, deps.surfacePolicy);
      // 只记摘要：counts + truncated（**不记元素明细/class**，避免 trace 膨胀与脱敏问题）。
      pushEvent(trace, {
        call: "observe", url: result.url, ok: result.ok,
        counts: result.counts, truncated: result.truncated,
        ...(result.ok ? {} : { result: { error: result.error, reason: result.reason } }),
      });
      if (deps.verbose === true) {
        // verbose 只打计数（不打印元素），与 trace 同一口径。
        console.log(`  [observe] ${result.url} elements=${result.counts.elements} admitted=${result.counts.admitted} omitted=${result.counts.omitted} (${Date.now() - started}ms)`);
      }
      return result;
    },
    // ---- A5 标签页：tabs() 免费只读；switchTab 计 1 flow step 且走 pace（与 step/arrive 同单元语义）----
    tabs: async () => {
      const session = await deps.ensureSession();
      const listed = await listTabs(session);
      const view: TabInfo[] = listed.map(({ index, url, title, active }) => ({ index, url, title, active }));
      pushEvent(trace, { call: "tab", desc: "tabs()", action: "list", pages: view, ok: true });
      return view;
    },
    switchTab: async (match) => {
      assertOpen("ctx.switchTab");
      validateSwitchTabMatch(match);
      checkBudget();
      await paceBeforeStep();
      const started = Date.now();
      const session = await deps.ensureSession();
      const before = urlOf(session.page as unknown as PageLike) || currentUrl;
      const listed = await listTabs(session);
      const matched = listed.filter((t) => switchTabMatches(t, match));
      if (matched.length !== 1) {
        const why = matched.length === 0
          ? "no tab matches"
          : `${matched.length} tabs match`;
        throw new StopError("config_error",
          `ctx.switchTab: ${why} ${JSON.stringify(match)} — expected exactly 1; current tabs: ${describeTabs(listed)}`
          + " (use ctx.tabs() to inspect; no implicit fallback to an arbitrary tab)");
      }
      const target = matched[0]!;
      // 导航信封：列表可以只读看到信封外页面，切过去不行（与 open/openPage 同一判定）。
      if (hosts && hosts.length && disallowedHost(target.url, hosts) !== null) {
        throw new StopError("host_not_allowed",
          `ctx.switchTab: ${JSON.stringify(target.url)} is outside the declared hosts envelope (${hosts.join(", ")})`
          + " — the tab was not activated");
      }
      session.page = target.page as unknown as typeof session.page;
      currentUrl = target.url;
      // Playwright 成熟做法：置前 + 有界等 domcontentloaded；两者失败都不致命（切页已是事实）。
      await bounded(() => target.page.bringToFront?.(), 2000);
      await bounded(() => target.page.waitForLoadState?.("domcontentloaded", { timeout: 5000 }), 5000);
      budget.stepsUsed += 1;
      try { pageState.update(target.page, "settled"); } catch { /* 记录面让位事实 */ }
      pushEvent(trace, {
        call: "tab", desc: `switchTab(${JSON.stringify(match)})`, action: "switch",
        from: { url: before },
        to: { index: target.index, url: target.url, title: target.title },
        pages: listed.length,
        args: match,
        ok: true,
        result: {
          index: target.index, url: target.url, title: target.title,
          elapsed_ms: Date.now() - started,
        },
      });
      return { ok: true as const, index: target.index, url: target.url, title: target.title };
    },
    step: async (desc, req) => {
      assertAct(req);
      return runOneStep(desc, { ...req, when: req.when ?? null });
    },
    // ---- A3 列表/范围原语：各计 1 flow step；内部 click/滚动不占预算（由 maxClicks/timeoutMs 兜底）----
    scrollList: async (target, opts = {}) => {
      validateScrollListRequest(target, opts);
      assertOpen("ctx.scrollList");
      checkBudget();
      await paceBeforeStep();
      const p = await page();
      budget.stepsUsed += 1;
      // F1：合成滚动目标（"document"/"body"/"html"/"window"，大小写不敏感）不进池、
      // 不做 hint 匹配——直接解析主滚动器执行同一套滚动语义；其余目标走既有容器路径
      // （池外回退 + 最近可滚动祖先），行为逐字节不变。
      const r = isSyntheticScrollTarget(target)
        ? await deps.mw().scrollDocument(
          p as never, opts.to ?? "bottom",
          { ...(opts.by === undefined ? {} : { by: opts.by }), ...(opts.settleMs === undefined ? {} : { settleMs: opts.settleMs }) },
        )
        : await deps.mw().scrollContainer(
          p as never, target, opts.to ?? "bottom",
          { ...(opts.by === undefined ? {} : { by: opts.by }), ...(opts.settleMs === undefined ? {} : { settleMs: opts.settleMs }) },
        );
      const result: ScrollListResult = {
        ok: r.ok,
        ...(r.scrollTop === undefined ? {} : { scrollTop: r.scrollTop }),
        ...(r.scrollHeight === undefined ? {} : { scrollHeight: r.scrollHeight }),
        ...(r.clientHeight === undefined ? {} : { clientHeight: r.clientHeight }),
        ...(r.moved === undefined ? {} : { moved: r.moved }),
        ...(r.stopCode === undefined ? {} : { stopCode: r.stopCode }),
        ...(r.reason === undefined ? {} : { reason: r.reason }),
      };
      pushEvent(trace, {
        call: "scrollList", desc: target, ok: result.ok,
        args: { target, opts },
        ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
        result,
      });
      try { pageState.update(p, "interactive"); } catch { /* 记录面让位事实 */ }
      return result;
    },
    expand: async (target, opts) => {
      validateExpandRequest(target, opts);
      assertOpen("ctx.expand");
      checkBudget();
      await paceBeforeStep();
      const p = await page();
      budget.stepsUsed += 1;
      // 行数只用 rows/selector 计数（`count.fields` 仅形状校验，不参与 expand 判定）：直接 DOM 计数
      // 而不走 ctx.read/extract——内部观察不应写成独立 trace 事件（否则 replay 要额外消费，
      // extract 还有 maxItems 截断）。coverage.rows = 最终 DOM 行数。
      const rowSelector = "rows" in opts.count ? opts.count.rows : opts.count.selector;
      const maxClicks = opts.maxClicks ?? 20;
      const stableRounds = opts.stableRounds ?? 2;
      const settleMs = opts.settleMs ?? 800;
      const timeoutMs = opts.timeoutMs ?? 60_000;
      const started = Date.now();
      const countRows = async (): Promise<number> => {
        try {
          const n = await p.evaluate!((sel: string) => {
            const g = globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } };
            return g.document.querySelectorAll(sel).length;
          }, rowSelector);
          return Number(n) || 0;
        } catch (e) {
          throw new StopError("config_error",
            `ctx.expand: row selector ${JSON.stringify(rowSelector)} is invalid (${e instanceof Error ? e.message : String(e)})`);
        }
      };
      const before = await countRows();
      let after = before;
      let clicks = 0;
      let grew = false;
      let stable = false;
      let stableCount = 0;
      let stopCode: string | undefined;
      let reason: string | undefined;
      let clickFailures = 0;
      let lastClickError: string | undefined;
      const mw = deps.mw();
      while (clicks < maxClicks && Date.now() - started < timeoutMs) {
        const act = await mw.actOnce(p as never, target, "click");
        clicks += 1;
        // 点击失败不立即判死：真站的"展开更多"在**到达展开上限**后会变成不可点
        //（Maps See more 实测：行数稳定后按钮仍在、但点击 timeout）。此时以"行数
        // 是否还在长"为准——等一拍重读，长出来的算异步到达，连续 stableRounds 轮
        // 不再长才算稳定（plateau 是这次调用的目标，grew/clicks 仍如实暴露）。
        if (!act.ok) {
          clickFailures += 1;
          lastClickError = act.reason ?? act.stopCode ?? "click failed";
        }
        if (settleMs > 0) await sleepMs(settleMs);
        const now = await countRows();
        if (now > after) { grew = true; stableCount = 0; } else { stableCount += 1; }
        after = now;
        if (stableCount >= stableRounds) { stable = true; break; }
      }
      if (!stable && stopCode === undefined) {
        stopCode = "expand_not_stable";
        reason = `stopped after ${clicks} click(s)/${Date.now() - started}ms without ${stableRounds} consecutive stable round(s) `
          + `(maxClicks=${maxClicks}, timeoutMs=${timeoutMs}, rows=${after})`
          + (clickFailures ? `; ${clickFailures} click(s) failed (last: ${lastClickError ?? "-"})` : "");
      } else if (stable && clickFailures > 0) {
        // 稳定但有点击失败：说明到顶后控件不可点（不是本调用的失败，但必须可解释）。
        reason = `rows stabilized at ${after} after ${clicks} click(s); ${clickFailures} click(s) failed `
          + `(last: ${lastClickError ?? "-"}) — the expand control no longer accepts clicks`;
      }
      const result: ExpandResult = {
        ok: stable, clicks, before, after, grew, stable,
        coverage: { rows: after },
        ...(stopCode === undefined ? {} : { stopCode }),
        ...(reason === undefined ? {} : { reason }),
      };
      pushEvent(trace, {
        call: "expand", desc: target, ok: result.ok,
        args: { target, opts },
        ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
        result,
      });
      try { pageState.update(p, "interactive"); } catch { /* 记录面让位事实 */ }
      return result;
    },
    setRange: async (target, value, opts = {}) => {
      validateSetRangeRequest(target, value, opts);
      assertOpen("ctx.setRange");
      checkBudget();
      await paceBeforeStep();
      const p = await page();
      budget.stepsUsed += 1;
      const r = await deps.mw().setRange(p as never, target, value, opts);
      // S1 effect 读回：`applied`/`accurate` 只在开关开着时出现（缺省开）。
      const readback = deps.effectReadback?.set_range !== false;
      const result: SetRangeResult = {
        ok: r.ok,
        ...(r.achieved === undefined ? {} : { achieved: r.achieved }),
        ...(r.strategy === undefined ? {} : { strategy: r.strategy }),
        ...(r.stopCode === undefined ? {} : { stopCode: r.stopCode }),
        ...(r.reason === undefined ? {} : { reason: r.reason }),
        ...(!readback || r.applied === undefined ? {} : { applied: r.applied }),
        ...(!readback || r.accurate === undefined ? {} : { accurate: r.accurate }),
        ...(!readback || r.target === undefined ? {} : { target: r.target }),
      };
      pushEvent(trace, {
        call: "setRange", desc: target, ok: result.ok,
        args: { target, value, opts },
        ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
        result,
      });
      try { pageState.update(p, "interactive"); } catch { /* 记录面让位事实 */ }
      return result;
    },
    manual: async (desc, req) => {
      assertOpen(`ctx.manual(${JSON.stringify(desc)})`);
      if (req === null || typeof req !== "object" || req.done === undefined || req.done === null) {
        throw new StopError("config_error", "ctx.manual: done signal is required");
      }
      if (deps.manualFailFast === true) {
        const stopCode = "needs_human";
        const reason = "manual step needs a human; --manual-fail-fast is set";
        pushEvent(trace, {
          call: "manual", desc, ...(req.id === undefined ? {} : { id: req.id }),
          url: currentUrl, ok: false, stop_code: stopCode,
          result: { needs_human: true, reason },
        });
        return {
          ok: false, ...(req.id === undefined ? {} : { id: req.id }), stopCode, reason,
          evidence: { url: currentUrl, attempts: 0, elapsedMs: 0 },
        };
      }
      if (deps.manualRunner === undefined) {
        if (!process.stdin.isTTY) {
          const stopCode = "needs_human";
          const reason = "manual step needs an interactive terminal (non-TTY)";
          pushEvent(trace, {
            call: "manual", desc, ...(req.id === undefined ? {} : { id: req.id }),
            url: currentUrl, ok: false, stop_code: stopCode,
            result: { needs_human: true, reason },
          });
          return {
            ok: false, ...(req.id === undefined ? {} : { id: req.id }),
            stopCode, reason,
            evidence: { url: currentUrl, attempts: 0, elapsedMs: 0 },
          };
        }
        throw new StopError("config_error", "ctx.manual: no manual runner wired in this build");
      }
      checkBudget();
      await paceBeforeStep();
      const started = Date.now();
      const session = await deps.ensureSession();
      const pageUrl = urlOf(session.page) || currentUrl;
      if (pageUrl) pageState.update(session.page as unknown as PageLike, "interactive");
      let approved = false;
      try {
        approved = await deps.manualRunner({
          desc,
          instructions: typeof req.instructions === "string" ? req.instructions : "",
          url: pageUrl,
        });
      } catch (e) {
        const reason = `manual handler failed: ${e instanceof Error ? e.message : String(e)}`;
        pushEvent(trace, {
          call: "manual", desc, ...(req.id === undefined ? {} : { id: req.id }),
          url: pageUrl, ok: false, stop_code: "manual_handler_error", result: { reason },
        });
        return {
          ok: false, ...(req.id === undefined ? {} : { id: req.id }),
          stopCode: "manual_handler_error", reason,
          evidence: { url: pageUrl, attempts: 0, elapsedMs: Date.now() - started },
        };
      }
      budget.stepsUsed += 1;
      const manualLeaf = isObj(req.done) && Object.prototype.hasOwnProperty.call(req.done, "manual");
      let ok = approved;
      let stopCode: string | undefined = approved ? undefined : "manual_declined";
      let reason: string | undefined = approved ? undefined : "human declined the manual step";
      if (approved) {
        if (!manualLeaf) {
          try {
            ok = await checkSignal(session.page as never, req.done as never);
          } catch (e) {
            throw new StopError("config_error", `ctx.manual(${JSON.stringify(desc)}) signal: ${e instanceof Error ? e.message : String(e)}`);
          }
          if (!ok) {
            stopCode = "manual_signal_not_held";
            reason = "human confirmed, but the declared DOM signal is not held";
          }
        }
      }
      const result: StepResult = {
        ok,
        ...(req.id === undefined ? {} : { id: req.id }),
        ...(stopCode === undefined ? {} : { stopCode }),
        ...(reason === undefined ? {} : { reason }),
        evidence: { url: pageUrl, attempts: 1, elapsedMs: Date.now() - started },
      };
      pushEvent(trace, {
        call: "manual", desc, ...(req.id === undefined ? {} : { id: req.id }),
        url: pageUrl, ok,
        ...(stopCode === undefined ? {} : { stop_code: stopCode }),
        result: { approved, attested: manualLeaf, ...(reason === undefined ? {} : { reason }) },
      });
      return result;
    },
    fail: (code, reason) => {
      throw new StopError(typeof code === "string" && code.trim() ? code : "flow_failed", reason ?? "");
    },
    url: () => currentUrl,
    read: {
      text: async (sel) => {
        let value: string | null = null;
        try {
          const loc = await locatorAnyFrame(await page(), sel, { hosts });
          if (loc !== null) value = String(await firstOf(loc).innerText({ timeout: 1500 }));
        } catch { value = null; }
        pushEvent(trace, { call: "read", desc: `text(${sel})`, result: value });
        return value;
      },
      value: async (sel) => {
        let value: string | null = null;
        try {
          const loc = await locatorAnyFrame(await page(), sel, { hosts });
          if (loc !== null) value = String(await firstOf(loc).inputValue({ timeout: 1500 }));
        } catch { value = null; }
        pushEvent(trace, { call: "read", desc: `value(${sel})`, result: value });
        return value;
      },
      count: async (sel) => {
        let value = 0;
        try {
          const loc = await locatorAnyFrame(await page(), sel, { hosts });
          value = loc === null ? 0 : Number(await loc.count());
        } catch { value = 0; }
        pushEvent(trace, { call: "read", desc: `count(${sel})`, result: value });
        return value;
      },
      attr: async (sel, attr) => {
        if (typeof sel !== "string" || !sel.trim()) throw new StopError("config_error", "ctx.read.attr: selector must be a non-empty string");
        if (typeof attr !== "string" || !attr.trim()) throw new StopError("config_error", "ctx.read.attr: attribute name must be a non-empty string");
        let value: string | null = null;
        try {
          const loc = await locatorAnyFrame(await page(), sel, { hosts });
          if (loc !== null) {
            const inner = firstOf(loc) as { getAttribute?(n: string, o?: { timeout?: number }): Promise<string | null> };
            if (typeof inner.getAttribute === "function") value = await inner.getAttribute(attr, { timeout: 1500 });
          }
        } catch { value = null; }
        pushEvent(trace, { call: "read", desc: `attr(${sel}, ${attr})`, result: value });
        return value;
      },
    },
    holds: async (sig) => {
      if (!isObj(sig) || !Object.keys(sig).length) throw new StopError("config_error", "ctx.holds needs a non-empty signal");
      const ok = await checkSignal(await page(), sig as never, { hosts });
      pushEvent(trace, { call: "holds", ok });
      return ok;
    },
    waitFor: async (sig, opts = {}) => {
      if (!isObj(sig) || !Object.keys(sig).length) throw new StopError("config_error", "ctx.waitFor needs a non-empty signal");
      const timeoutMs = Math.max(0, Number(opts.timeoutMs ?? 15_000));
      const pollMs = Math.max(1, Number(opts.pollMs ?? 200));
      const started = Date.now();
      const deadline = started + timeoutMs;
      const p = await page();
      let held = false;
      // 轮询语义：至少检查一次；最后一次 sleep 裁到 deadline，不让“下一次会越界”提前退出。
      while (true) {
        try {
          if (await checkSignal(p as never, sig as never, { hosts })) { held = true; break; }
        } catch (e) {
          throw new StopError("config_error", `ctx.waitFor: ${e instanceof Error ? e.message : String(e)}`);
        }
        const now = Date.now();
        if (now >= deadline) break;
        await new Promise((r) => setTimeout(r, Math.max(1, Math.min(pollMs, deadline - now))));
      }
      if (held) pageState.update(p as PageLike, "settled");
      pushEvent(trace, {
        call: "waitFor", ok: held,
        result: { timeout_ms: timeoutMs, poll_ms: pollMs, elapsed_ms: Date.now() - started },
      });
      return held;
    },
    source: async (name, sourceOpts = {}) => {
      if (deps.allowSources === false) {
        throw new StopError("config_error", `ctx.source(${JSON.stringify(name)})：本次运行带 --skip-data，数据腿被显式跳过`);
      }
      if (deps.sourceRunner) {
        const obs = await deps.sourceRunner(name, sourceOpts);
        // T6：sources 观测面不只记行数——名字 + counts + selects 都进事件（result 投影同源）。
        pushEvent(trace, {
          call: "source", desc: name,
          result: { name, counts: obs.counts, selects: obs.selects, rows: obs.rows.length },
        });
        return obs;
      }
      const src = loadSource(name);
      // 环封口：数据腿的日期参数只能来自包默认/CLI 槽位——引用 source_slots 产物
      // 是循环依赖（那些值要等数据腿跑完才存在），加载已知就拒绝。
      const producerSlots = new Set(Object.keys(deps.pack.source_slots ?? {}));
      for (const ph of defaultDatesSlotNames(src)) {
        if (producerSlots.has(ph)) {
          throw new StopError("config_error", `source ${JSON.stringify(name)} 的 default_dates 引用 {${ph}}，`
            + `但 ${ph} 由数据腿回写（source_slots）——数据腿参数不允许引用数据腿产物`);
        }
      }
      let dates: string[];
      try {
        if (sourceOpts.dates !== undefined) {
          const raws = Array.isArray(sourceOpts.dates) ? sourceOpts.dates : [sourceOpts.dates];
          dates = raws.flatMap((r) => parseDatesValue(String(r), deps.runtime.today || undefined));
        } else {
          dates = defaultDates(src, slots, deps.runtime.today || undefined);
        }
      } catch (e) {
        // 坏日期参数/缺槽位值是配置类错误：ValueError → 结构化 StopError，不裸抛。
        if (e instanceof ValueError) {
          throw new StopError("config_error", `ctx.source(${JSON.stringify(name)}): ${e.message}`);
        }
        throw e;
      }
      const res = await runSource(src, dates, { verbose: false, today: deps.runtime.today || undefined });
      const day = Object.values(res.dates)[0] as unknown as Record<string, unknown> | undefined;
      const counts = (day?.["counts"] ?? {}) as Record<string, number>;
      const selects = (day?.["selects"] ?? {}) as Record<string, Record<string, string> | null>;
      const rows = (day?.["rows"] ?? []) as Array<Record<string, string>>;
      const byDate: NonNullable<SourceObservationView["byDate"]> = {};
      for (const [dateKey, entry] of Object.entries(res.dates)) {
        const e = entry as unknown as Record<string, unknown>;
        if (e["error"] !== undefined) continue;
        byDate[dateKey] = {
          ...(e["url"] !== undefined ? { url: String(e["url"]) } : {}),
          counts: (e["counts"] ?? {}) as Record<string, number>,
          selects: (e["selects"] ?? {}) as Record<string, Record<string, string> | null>,
          rows: (e["rows"] ?? []) as Array<Record<string, string>>,
        };
      }
      const obs: SourceObservationView = {
        counts, selects, rows,
        ...(res.tool_version ? { version: res.tool_version } : {}),
        ...(Object.keys(byDate).length ? { byDate } : {}),
      };
      pushEvent(trace, {
        call: "source", desc: name,
        result: { name, counts, selects, rows: rows.length, dates: Object.keys(byDate) },
      });
      return obs;
    },
    data: {
      min: (rows, by) => pickRow(rows, by, "min"),
      max: (rows, by) => pickRow(rows, by, "max"),
    },
    rows: async () => {
      throw new StopError("config_error", "ctx.rows is closed in v1 (Q5: no new extraction grammar); "
        + "declare named row extraction in meta.site.listExtract and call ctx.extract(name)");
    },
    extract: async (nameOrSpec) => {
      let spec: { rows: string; fields: Record<string, string>; maxItems?: number };
      if (typeof nameOrSpec === "string") {
        if (!nameOrSpec.trim()) throw new StopError("config_error", "ctx.extract: name must be a non-empty string");
        const named = pack.site?.listExtract?.[nameOrSpec];
        if (named === undefined) {
          const known = Object.keys(pack.site?.listExtract ?? {});
          throw new StopError("config_error",
            `ctx.extract(${JSON.stringify(nameOrSpec)}): meta.site.listExtract has no such entry`
            + ` (known: ${known.length ? known.join(", ") : "none declared"})`);
        }
        spec = named;
      } else if (isObj(nameOrSpec) && typeof nameOrSpec["rows"] === "string" && nameOrSpec["rows"].trim()
          && isObj(nameOrSpec["fields"])) {
        spec = { rows: nameOrSpec["rows"], fields: nameOrSpec["fields"] as Record<string, string> };
        if (typeof nameOrSpec["maxItems"] === "number") spec.maxItems = nameOrSpec["maxItems"];
      } else {
        throw new StopError("config_error",
          "ctx.extract needs a declared name or { rows, fields, maxItems? } structure");
      }
      const extractName = typeof nameOrSpec === "string" ? nameOrSpec : `inline:${spec.rows}`;
      const cap = Math.max(1, Math.min(500, Math.floor(spec.maxItems ?? 500)));
      const found = await readRows(spec.rows, spec.fields, cap);
      pushEvent(trace, { call: "extract", desc: extractName, result: { rows: found.rows, truncated: found.total > cap } });
      return found.rows;
    },
    collect: async (req) => {
      validateCollectRequest(req);
      assertOpen("ctx.collect");
      checkBudget();
      await paceBeforeStep();
      const p = await page();
      budget.stepsUsed += 1;
      const fields = req.fields ?? { text: "." };
      const until = req.until ?? { stableRounds: 2 };
      const stableRounds = "stableRounds" in until ? (until.stableRounds ?? 2) : 2;
      const maxRows = "maxRows" in until ? (until.maxRows ?? 500) : 500;
      const dedupe = req.dedupe !== false;
      const maxRounds = req.maxRounds ?? 30;
      // 行选择器语法在真跑里也要响亮（dry 面已校验形状，但 CSS 非法只有浏览器知道）。
      try {
        const bad = await p.evaluate!((sel: string) => {
          const g = globalThis as unknown as { document?: { querySelectorAll(s: string): unknown } };
          try { g.document?.querySelectorAll(sel); return null; } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
        }, req.row);
        if (typeof bad === "string" && bad) {
          throw new StopError("config_error", `ctx.collect: row selector ${JSON.stringify(req.row)} is invalid (${bad})`);
        }
      } catch (e) {
        if (e instanceof StopError) throw e;
        // 页面不可读时让下面的抽取给出诚实结果（不把 record 面故障当选择器错误）。
      }
      const rows: Array<Record<string, string>> = [];
      const seen = new Set<string>();
      let rounds = 0;
      let addedLastRound = 0;
      let stableCount = 0;
      /**
       * 是否已确认"滚到底/滚不动"。滚动没到底时"本轮没新增"是正常的（还没滚到新内容），
       * 不能算进 plateau；只有到底后连续 stableRounds 轮无新增才是 stable。
       */
      let atBottomKnown = false;
      let stopReason: CollectStopReason = "budget";
      while (rounds < maxRounds) {
        rounds += 1;
        const found = await readRows(req.row, fields, maxRows);
        addedLastRound = 0;
        for (const row of found.rows) {
          const key = JSON.stringify(row);
          if (dedupe && seen.has(key)) continue;
          seen.add(key);
          rows.push(row);
          addedLastRound += 1;
          if (rows.length >= maxRows) break;
        }
        if (rows.length >= maxRows) { stopReason = "maxRows"; break; }
        if (addedLastRound > 0) stableCount = 0;
        else if (atBottomKnown) stableCount += 1;
        if (stableCount >= stableRounds) { stopReason = "stable"; break; }
        if (rounds >= maxRounds) break;                    // 内部轮数用尽 → budget
        const scroll = await scrollRowsContainer(req.row);
        if (!scroll.found || !scroll.scrollable) { stopReason = "not_scrollable"; break; }
        atBottomKnown = scroll.atBottom || !scroll.moved;
        // 给懒加载/无限滚动一点时间再读下一轮；这段等待**不占** flow 预算。
        await sleepMs(300);
      }
      const coverage: CollectCoverage = { rounds, rowsSeen: rows.length, addedLastRound };
      const result: CollectResult = { rows, coverage, stopReason };
      pushEvent(trace, {
        call: "collect", desc: req.row, ok: true,
        args: req,
        result,
      });
      return result;
    },
    run: (async (sourceOrStep: unknown, args?: string[], req?: unknown): Promise<StepResult> => {
      if (typeof sourceOrStep === "string") {
        return runTool(sourceOrStep, args ?? [], req as ToolRunRequest, false);
      }
      const step = sourceOrStep as Record<string, unknown>;
      return runDeclaredTool(step, false);
    }) as Ctx["run"],
    dangerous: async (req) => {
      if (!Array.isArray(req?.dryRunArgs) || req.dryRunArgs.length === 0) {
        throw new StopError("config_error", "ctx.dangerous requires dryRunArgs (a failed dry run must never apply)");
      }
      return runTool(req.source, req.args, req as ToolRunRequest, true);
    },
    done: async () => {
      if (closed) throw new StopError("config_error", "ctx.done called twice");
      closed = true;
      const invs = (pack.invariants ?? []) as Array<Record<string, unknown>>;
      if (!invs.length) {
        pushEvent(trace, { call: "done", ok: true });
        return;
      }
      let p: PageLike;
      try {
        p = await page();
      } catch {
        throw new StopError("invariant_failed", "ctx.done: no browser session, but web invariants need the end state");
      }
      const failed: string[] = [];
      const details: Array<{ id: string; held: boolean }> = [];
      for (const inv of invs) {
        const sig = inv["signal"];
        const held = isObj(sig) ? await checkSignal(p, sig as never) : false;
        details.push({ id: String(inv["id"] ?? "?"), held });
        if (!held) failed.push(String(inv["id"] ?? "?"));
      }
      pushEvent(trace, {
        call: "done", ok: failed.length === 0,
        ...(failed.length ? { stop_code: "invariant_failed" } : {}),
        result: { invariants: details },
      });
      if (failed.length) {
        throw new StopError("invariant_failed", `ctx.done: invariants failed on the end state: ${failed.join(", ")}`);
      }
    },
  };
  return ctx;
}

/**
 * `ctx.run` 的 `returns` 规范化：只认既有 `ReturnExtractor` 声明面（`validateReturns` 是
 * 加载期与运行期**同一份**校验）。坏声明 = 结构化 `config_error`，绝不"猜一个抽取方式"。
 */
function toolReturns(raw: unknown, where: string): Record<string, ReturnExtractor> | null {
  const problems: string[] = [];
  const out = validateReturns(raw, where, problems);
  if (problems.length > 0) throw new StopError("config_error", problems.join("；"));
  return out;
}

/**
 * 工具步失败的人读原因（T6）：`<stop_code>: exit N — <stderr 尾行>`。
 * 没有退出码（起不来/被拒绝）时省略 `exit` 段；`given`（适配器/拒绝文案）只在
 * stderr 摘要里没有时才补上——同一句话不重复两遍。
 */
function toolFailureReason(
  stopCode: string, code: number | null | undefined, tail: string | undefined, given?: string,
): string {
  let out = stopCode;
  if (code !== null && code !== undefined) out += `: exit ${code}`;
  const g = given !== undefined && given.trim() ? given.trim() : undefined;
  if (tail !== undefined && tail.length > 0) {
    out += ` — ${tail}`;
    if (g !== undefined && g !== tail && !tail.includes(g) && !out.includes(g)) out += ` (${g})`;
  } else if (g !== undefined) {
    out += ` — ${g}`;
  }
  return out;
}

/** 选一行：`min|max` 按字段的数值比较（非数值回落到字符串比较；空集合 → null）。 */
function pickRow<T extends Record<string, unknown>>(rows: T[], by: string, order: "min" | "max"): T | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  let best: T | null = null;
  for (const row of rows) {
    if (best === null) { best = row; continue; }
    const a = num(row[by]);
    const b = num(best[by]);
    const cmp = a !== null && b !== null ? a - b : String(row[by] ?? "").localeCompare(String(best[by] ?? ""));
    if (order === "min" ? cmp < 0 : cmp > 0) best = row;
  }
  return best;
}
