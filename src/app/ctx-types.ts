/**
 * L2 运行期 `ctx` 的**类型面**（从 ctx.ts 拆出）——纯类型 + `StopError`，无运行时装配。
 *
 * 拆出的理由（F1）：ctx.ts 2655 行里约 600 行是类型声明，且这些类型被 createCtx 内部、
 * ctx-dry、ctx-replay、app-script、app-runner 反复 import。集中到这里后，任何一面都能
 * 直接引用同一份类型而不造成 createCtx 的加载依赖。
 */
import type { CommandDecl, DomSignal, TargetDecl, ValueBinding } from "./kit.ts";
import { createKit } from "./kit.ts";
import type { PageState } from "./page-state.ts";
import type {
  BrowserMiddleware, BrowserSession, ExecutedAction, RunReport, SkippedAction, StepStateRecord,
} from "../engine/executor.ts";
import type { ObserveOptions, ObserveResult } from "../engine/observe.ts";
import type { AppTrace, TraceCall } from "./trace.ts";
import type { DatasetStore } from "../engine/dataset.ts";
import type { ReturnExtractor } from "./app-adapters.ts";
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
   * `applied` = 控件值事实已经是目标；`accurate` = **requested 值真实在控件上**
   * （task-21/1a 收紧为精确语义——achieved === requested；容差只用于交互收敛判定）。
   * 失败路径也如实 false。
   */
  applied?: boolean;
  accurate?: boolean;
  /** 目标数值（percent 已折算；对账用）。 */
  target?: number;
  /** task-21/1a：调用方请求的原始值（越界拒绝时 = 被拒的请求；正常时 === target）。 */
  requested?: number;
  /** task-21/1a：越界请求被拒绝时记录的钳制值（零动作证据链；仅 value_out_of_range 出现）。 */
  clamped_from?: number;
  /** task-21/1a：键盘策略收敛失败的可判别原因（仅键盘路径失败时出现）。 */
  probe?: "value_unreadable" | "home_ignored" | "lattice_unreachable";
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

/**
 * C1：`ctx.extract` 的第二个参数（分页起点）。
 *
 * 为什么是第二参而不是 spec 键：inline spec 是**行抽取声明**（rows/fields/maxItems），
 * offset 是**这一次调用**的读取位置——两者混在一张对象里会让声明在 `meta.site.listExtract`
 * 与 inline 之间无法复用。写进 spec = 结构化 `config_error` 并指路到这里。
 */
export interface ExtractOptions {
  /** 0-based 行偏移；整数 0..10000，非法 = `config_error`。 */
  offset?: number;
}

export interface Ctx {
  readonly app: Readonly<{ id: string; label?: string; goal: string }>;
  readonly slots: Readonly<Record<string, string>>;
  /**
   * 运行期只读投影。`epoch` = 执行器状态游标的当前 epoch（每次抽池/观察 +1；每个 `run()`
   * 重置）。dry 面给合成值 0——dry 没有真实页面观察，不假装有。
   *
   * `dry`（eval3 消歧义）= 本会话是否 dry/replay 面：dry 与 replay 恒 `true`，真跑恒 `false`。
   * **两面判据就用它**——`epoch === 0` 不再是 dry 判据（真跑首个观察前 epoch 同样是 0）；
   * 数据驱动分支/断言请用 `ctx.runtime.dry`（此前文档建议的 `runId === "(dry)"` 仍可用，
   * 但那只是 CLI 惯例值不是契约）。
   */
  readonly runtime: Readonly<{ outDir: string; runId: string; today: string; epoch: number; dry: boolean }>;
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
   * 依赖观察值的分支/断言请用 `ctx.runtime.dry`（dry/replay 恒 true）或 counts 守卫。
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
   *
   * C1：第二个参数 `{ offset? }` 只做**分页起点**（整数 0..10000；`maxItems` 仍是每页上限）。
   * 返回值形状不变（仍是行数组，`count` 语义不变）——`offset` 只认第二参，写进 spec =
   * 结构化 `config_error`（指路到这里）。
   */
  extract(
    name: string | { rows: string; fields: Record<string, string>; maxItems?: number },
    opts?: ExtractOptions,
  ): Promise<Array<Record<string, string>>>;
  holds(sig: DomSignal): Promise<boolean>;
  waitFor(sig: DomSignal, opts?: { timeoutMs?: number; pollMs?: number }): Promise<boolean>;
  /**
   * C2（评审 #9 合并形态）：等一个 hint 语义目标**可命中**——observe + hintMatch 轮询。
   * 免费只读（与 `waitFor` 同类：不计预算、不进模型请求面、不改页面状态）。覆盖两类现场：
   * 水合期芯片「声明了但还没进池」（hidden 元素不进可见准入池 → count 0，可见后才命中）与
   * 跨源 iframe 帧就绪（帧出现后元素才进池）。返回 `{found, count}`——**不假装**：超时如实
   * `found:false`，脚本据此分支。dry 面合成 `{found:false, count:0, dry:true}`（不真评）——
   * 与 `waitFor` 的 dry「立即 true」口径不同：那是"信号已成立"的模拟，这里没有可模拟的
   * 命中事实，如实 not found（差异写进 docs §4）。
   */
  waitForTarget(hint: string, opts?: { visible?: boolean; timeoutMs?: number; pollMs?: number }):
    Promise<{ found: boolean; count: number; dry?: boolean }>;
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
   * A1：`aria-label` 属性 hint 的池侧匹配底座（来自 `meta.policy.attr_value_match`；
   * 缺省 undefined = `full_label` = 修复后行为；`"display"` = A1 之前只看前 40 字）。
   * 只服务 `ctx.waitForTarget` 的命中轮询——动作路径的口径在执行器实例上（同一 policy）。
   */
  attrValueMatch?: "full_label" | "display";
  /**
   * P0-B：`meta.site.pages` 声明的页面 URL 清单。仅 `navPolicy:"entry-only"` 使用：
   * 再次直接导航到**声明页**（URL 经 `new URL().href` 归一后全等）放行——例如
   * `ctx.openPage("home")` 回入口页；未声明的 URL 仍 `navigation_forbidden`。
   * 缺省 undefined = 不放开（行为逐字节不变）。
   */
  declaredPages?: string[];
  /**
   * C1：extract 的**总量观测口**（只有 session 面注入；其它调用面不注入、不新增字段）。
   *
   * `ctx.extract` 的返回类型仍是行数组（`count` 语义不变），分页需要的 `total` 不能塞进
   * 返回值——引擎在写完本次结果后就地回写 `total`（= 当前匹配行总数），由注入方读取。
   * 不注入 = 不写（run/dry/replay 的行为与产物逐字节不变）。
   */
  extractStats?: { total: number };
}
