/**
 * Application layer executor 的**类型面**（从 executor.ts 拆出，F2）——纯类型，无运行时。
 *
 * 拆出的理由：executor.ts 6194 行里约 860 行是类型声明（AnyPage/StopCode/ExecutedAction/
 * SkippedAction/AuditVerdictLike/MiddlewareOptions/…），且这些类型被 BrowserMiddleware
 * 类体与外部面反复引用。集中到这里后，任何一面都能引用同一份类型而不造成执行器类的
 * 加载依赖（也避免 `import type` 与运行时 import 混在同一个 6000 行文件里）。
 */
import type { AuditVerdict, Auditor, TraceStep } from "./audit.ts";
import type { BrowserLike, LaunchOptions } from "../browser/browser-env.ts";
import type { ActionCapability, Elem, ElemFamily, FrameGate, PageLike } from "./extraction.ts";
import type { SurfacePolicy } from "./surface.ts";
import type { DeclaredCandidate } from "./declared.ts";
import type {
  ChoiceAnswer, DecisionAgent, ModelState, NoulAnswer, RouterLike,
} from "../model/model.ts";
import type { DecisionProvider } from "../model/decision-provider.ts";
import type { RangeOptions, RangeOutcome, RangeValue } from "./range.ts";
import type { AttrValueMatch, HintMatchCandidate } from "./rules.ts";
import type { AmbiguousOrdering } from "./ambiguity.ts";
import type { SignalSpec } from "./signals.ts";
import type { SettlePage, SettleResult } from "./settle.ts";
import type { CommandDecl } from "./actions.ts";
import type { BindingDiagnostics, OptionCandidate } from "./bindings.ts";
import type { DatasetReader } from "./dataset.ts";

export type AnyPage = Omit<PageLike, "locator" | "evaluate"> & {
  locator(selector: string): any;
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  title(): Promise<string>;
  waitForLoadState(state?: string, opts?: { timeout?: number }): Promise<void>;
  [k: string]: any;
};

/** The playwright "connection" object: just the BrowserType, in Node. */
/** 一次选元素提案（见 `pickProposal` 的注释：为什么"问法形状"必须进接口）。 */
export interface PickProposal {
  choiceRef: string | null;
  shape: { kind: "full" | "shortlist" | "none"; k: number; poolSize: number; options: number };
  pTop1: number | null;
  pTop2: number | null;
  /** 只有一个候选时 margin = pTop1（没有对手可比，不是"很有把握"）。 */
  margin: number | null;
  /** 今天的 `conf`：passthrough=1−归一化熵；shortlist=max(子集概率)。**只作诊断，别跨 shape 比。** */
  entropyConf: number;
  probs: Record<string, number>;
}

export interface PwLike {
  chromium: { launch(opts: LaunchOptions): Promise<unknown> };
}

/** A launched browser plus the one extra call the executor makes. */
export interface BrowserHandle extends BrowserLike {
  newPage(): Promise<unknown>;
  close(): Promise<void>;
}

/** Element signature — refs are positional, so forbiddances key on this. */
export type Sig = [string, string, string];

/**
 * Structured stop cause .
 *
 * The loop used to terminate on 12 free-text `stop_reason` strings, so every
 * downstream consumer (online suite exit codes, the DSH bridge, reports, refusal
 * labels) had to STRING-MATCH prose. `stop_code` is the data; `stop_reason`
 * stays the human rendering — byte-identical to what the frozen parity corpus
 * records (the Python reference asserted those strings; fixture-level rule:
 * adding shape, never rewording).
 */
export type StopCode =
  | "max_steps"
  | "dom_goal_signal"
  | "precondition_skipped"
  | "no_model_runtime"
  | "page_not_ready"
  | "target_not_found"
  | "target_ambiguous"
  | "action_unsupported"
  | "done_not_held"
  | "action_space_exhausted"
  | "hint_matched_nothing"
  | "step_names_no_target"
  | "low_confidence"
  | "dry_run"
  | "dry_run_not_actionable"
  | "manual_needs_human"
  | "manual_confirmation"
  | "noul_unverified"
  | "host_not_allowed"
  | "frame_not_allowed"
  | "popup_not_allowed"
  /**
   * 导航纪律（`meta.policy.navigation:"entry-only"`，flow 脚本面）：入口之外的直接 URL
   * 导航（ctx.open/openPage/arrive/step 级 url）被闸门拒绝。页面驱动的跳转（点击/锚点/
   * 新标签页）永不产生此停因。reason 带当前 URL 与试图跳转的 URL。
   */
  | "navigation_forbidden"
  | "config_error"
  /**
   * S2 ③ 运行期接线（改版）：提名族是软先验；**有界修复**时本页一个该族候选都没有。
   */
  | "nominated_family_empty"
  /**
   * S2 ③ 运行期接线（改版）：第一轮解析出的动作族与提名不符，且有界修复也没解出
   * 过闸的该族候选——结构化停因（绝不执行一个与提名矛盾的动作）。
   */
  | "nominated_family_mismatch"
  /**
   * A2：候选窗口超过决策服务上限（MAX_CHOICES=200，服务侧硬上限 255）。这不是"放大窗口"
   * 能解决的——收窄 hint / 用分桶优先级；结构化停因，绝不把 200+ 选项硬塞给服务。
   */
  | "decision_service_choice_limit"
  /** P2: a declared command space with NOTHING resolvable on this page (space-empty). */
  | "space_empty"
  /**
   * D3/R-4：同一个元素被**有效地**执行了 N 次而完成信号始终不成立 —— 循环卡住了，
   * 不是步数预算用完了。与 `max_steps` 分开（backlog R-4）：前者说"目标死了/信号不会来了"，
   * 后者说"给了 8 步还没跑完"。
   */
  | "no_progress"
  /** P2: a `fill`/`select` command's declared slot binding has no value (never guessed). */
  | "needs_value"
  /**
   * S1 状态层（policy.done_preheld=fail）：done 在动作**之前**已成立 ⇒ 这一步的完成证据
   * 不是动作推进出来的。默认（warn）只记 flag/warning；显式 fail 才在动作前停住。
   *
   * 覆盖范围：只有**命令步**（声明了 act 命令闭集）会在动作前预评估 done 并可能标记；
   * 决策步不付这次评估成本，因此不会出现 done_preheld。
   */
  | "done_preheld"
  /**
   * P0-E 完成语义诚实（policy.done_guard=fail 档）：done 成立后的只读复核 guard 判定
   * 这一步的完成疑似假绿——登录墙特征（URL/标题文案/跨出 hosts 信封）或
   * 「有动作但 changed=false 且 done 是否定式」的零前进蹭成立。默认 warn 档只记
   * step warning，不改判定；fail 档才结构化停止（reason 带证据）。
   */
  | "false_done"
  /**
   * F3：步级 `timeoutMs` 显式声明时的**整步挂钟帽**——约束 reobserve/升级循环的每轮
   * 与总时长（循环头逐轮检查；过期后不再起新的宽扫/升级；已在途的决策调用不可抢占，
   * 超额 ≤ 一次在途调用）。R06 实测：done 永不成立的循环在「宽扫+模型改点」上单步内
   * 耗 3–4 分钟且不受任何约束，4 次运行被外层墙钟击杀。未声明 `timeoutMs` 的步骤
   * 没有这个帽（缺省行为逐字节不变）。与 `max_steps` 的分工：那是动作步数预算，这是挂钟。
   */
  | "step_timeout";

/** Minimal locator surface used by the executor (superset of `extraction.LocLike`). */
export interface AnyLoc {
  click(opts?: Record<string, unknown>): Promise<void>;
  fill(value: string, opts?: Record<string, unknown>): Promise<void>;
  selectOption(value: unknown, opts?: Record<string, unknown>): Promise<void>;
  /** S4 hover 原语；可选（测试替身没有时按 action_unsupported 诚实报）。 */
  hover?(opts?: Record<string, unknown>): Promise<void>;
  dragTo?(target: unknown, opts?: Record<string, unknown>): Promise<void>;
  /** U6 上传原语；可选（测试替身没有时按 action_unsupported 诚实报）。 */
  setInputFiles?(files: unknown, opts?: Record<string, unknown>): Promise<void>;
  count(): Promise<number> | number;
  all(): Promise<unknown[]>;
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
  innerText(opts?: Record<string, unknown>): Promise<string> | string;
  inputValue(opts?: Record<string, unknown>): Promise<string> | string;
  /** Read-only actionability questions (the dry-run probe uses only these). */
  isVisible?(): Promise<boolean>;
  isEnabled?(): Promise<boolean>;
  first?: unknown;
}

/** Observable page state before an action; compared after it (inert check). */
export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  vals: string;
  /**
   * B3：可勾选控件状态签名（原生 checkbox/radio 的 0/1、aria-checked 值、
   * aria-selected=true、select[multiple] 选中 index）。空串时字段省略 ⇒ 无此类控件的
   * 页面快照逐字节不变；敏感值掩码仍在 `vals` 的 VALS_JS 面，本字段不碰它。
   */
  checks?: string;
  frames: Array<{ url: string; text: string; vals: string; checks?: string }>;
}

/** The audit block of a report, wide enough for the SKIPPED literal. */
export interface AuditVerdictLike {
  verdict: string;
  reasons: string[];
  auditor: string;
}

/** A1：一次**实际执行**的动作（`RunReport.executed_actions`；StepResult 同名面透出）。 */
export interface ExecutedAction {
  /** 动作 op（命令闭集的 op；决策步从 how 归一成 click/fill/select/scroll/drag/hover；upload/clickAt 只走命令面）。 */
  op: string;
  /** 命令声明里的目标；决策步/无命令声明时为 null。 */
  target: string | null;
  /** 元素 ref（位置性编号，进 trace 便于对账）。 */
  ref: string;
  /** U6：upload 的 how 如实记为 setInputFiles（Playwright 原语），其余沿用动作结果词。 */
  how: "clicked" | "filled" | "scrolled" | "dragged" | "hovered" | "setInputFiles";
  desc: string;
  /** pre/post 快照是否变化（scroll/drag 的 viewport 变化不在快照里，见 inert 口径）。 */
  changed: boolean;
  /** U6：upload 实际写进 input 的文件 **basename**（绝不散绝对路径）；其它 op 缺席。 */
  files?: string[];
  /** U7：clickAt 实际点击的**元素相对**坐标（与声明绑定同值）；其它 op 缺席。 */
  position?: { x: number; y: number };
  /**
   * FW8：本动作的**声明目标**由身份回捞解析（合成 ref，如 `dom:0`；不是池 ref）。
   * 缺字段 = 普通池解析。trace 行的同一事实还带 `identity:{shape,attr,value,…}`。
   */
  resolved_by?: "dom_identity" | "declared_dom";
  /**
   * P0-C：DRF 命中证据（与 trace 行 `declared_resolve` 同源同值；仅 declared 解析时出现）。
   * `hit_test` 只在 click 族动作前跑过 hit-test 时出现（covered/ancestor 表示未点击）。
   */
  declared_resolve?: {
    mode: "attr" | "text"; target: string; matches: number;
    hidden_matches: number; total_matches: number; frame: number;
    hit_test?: "covered" | "ancestor"; blocker?: string;
  };
}

/**
 * A1：一个**本该动作却没执行**的候选/命令 + 原因（零执行步骤的显式证据）。
 *
 * 为什么需要它：`done=true` + 零执行是合法的（信号本来就成立），但"零执行"不该等于
 * "没有证据"——旧 trace 只留下一条 `executed:false` 的行，作者看不出是哪个命令、
 * 因为什么被跳过。skipped_actions 把每一条"为什么没动作"落成结构化数据。
 */
export interface SkippedAction {
  command_id?: string;
  ref?: string;
  target?: string | null;
  /** 结构化原因：target_ambiguous / target_not_found / forbidden / not-actionable-or-covered /
   *  action-timeout / stale_ref / needs_value / action_unsupported / action_failed … */
  reason: string;
  detail?: string;
}

/**
 * `not-actionable-or-covered` 的现场：当时 bbox / 覆盖者 / 重查时节点是否还在。
 * 只作为**诊断证据**（不改动作/判定）；覆盖元素是快照，页面可能已经变了。
 */
export interface ActionabilityDetail {
  reason: string;
  bbox: { x: number; y: number; width: number; height: number } | null;
  /** 中心点命中的顶层元素（如 `div#cookie-banner`）；zero-size/offscreen 也在这里说明。 */
  blocker: string | null;
  /** 重新查询时目标节点还在不在文档里。 */
  requery: "present" | "detached" | "unknown";
}

/**
 * E4：overlay 证据行（只读探测；**不自动消散**——是否关闭由作者/策略决定，
 * 引擎只把"页面上有遮罩"变成结构化事实）。行数有界（≤3）。
 */
export interface OverlayEvidenceRow {
  /** `tag#id.class`（id/首两 class，与 blocker 描述同口径）。 */
  desc: string;
  /** 计算样式 z-index（解析不出数字 = 0）。 */
  z: number;
  /** 遮挡块面积 / 视口面积（四舍五入到百分位）。 */
  area: number;
  /** 是否整块盖住视口（cookie banner 背板的典型形状）。 */
  covers: boolean;
  /** 元素文本首 40 字（折叠空白；空文本省略由构造方决定）。 */
  txt: string;
}

/**
 * task-11（B3）/ task-16（B3+）：限速/降频判读证据——**两个面的并集，缺字段省略纪律**
 * （每个面只落自己观测到的字段）。全部是已有观测的记账；唯一新增页面往返 = 失败路径的
 * 一次只读 sniff（U3 同款底座）。
 *   - step 侧（B3；probe3 现场标定：单会话观察调用 202→15、8 秒跑完、芯片 declared_hidden）：
 *     池面字段 pool_size / pool_size_session_high / admitted / session_elapsed_ms / declared_hidden。
 *   - arrive 侧（B3+；纯导航不走执行器、无池面）：到达面字段 url / in_arrive_first / in_arrive_last，
 *     峰值基线 body_text_peak 来自 step 侧失败嗅探的记账（经 sessionBodyTextPeak() 读出）。
 */
export interface ThrottleSuspect {
  evidence: {
    /** 失败嗅探：正文长度（chars）——两面共有。 */
    body_text: number;
    /** B3：上一次失败嗅探的正文长度（首次失败没有前值，缺省省略）。 */
    body_text_prev?: number;
    /** B3：本步池大小 / 会话池高峰基线（arrive 侧无池面，缺省省略）。 */
    pool_size?: number;
    pool_size_session_high?: number;
    /** B3：可见 ADMIT_SEL 交互计数及其前值（arrive 侧缺省省略）。 */
    admitted?: number;
    admitted_prev?: number;
    /** 失败嗅探时的 readyState——两面共有。 */
    ready_state: string;
    /** B3：本会话首次抽池以来的毫秒数（「8 秒跑完全程」特征的记账；arrive 侧缺省省略）。 */
    session_elapsed_ms?: number;
    /** B3：失败现场的 declared_hidden 事实（芯片/目标全隐藏——限速降频的典型并发特征）。 */
    declared_hidden?: { target: string; hidden: number; total: number };
    /** B3+ 到达面：arrive 落地 URL（step 侧的 URL 在行字段上，缺省省略）。 */
    url?: string;
    /** B3+ 到达面：done 轮询等待期正文读数的首/末（捕捉等待期间塌缩；缺省省略）。 */
    in_arrive_first?: number;
    in_arrive_last?: number;
  };
}

export interface RunReport {
  goal: string;
  done: boolean;
  skipped?: boolean;
  /** `done` came from a HUMAN attestation (`{manual: true}`), not a DOM signal. */
  manual?: boolean;
  /** The run stopped at the dry-run probe: nothing was executed. */
  dry_run?: boolean;
  /** Human-readable rendering of why the loop stopped. Stable text, never parsed. */
  stop_reason: string;
  /** The SAME fact as data (see `StopCode`); consumers branch on this, not prose. */
  stop_code?: StopCode;
  /** Which step produced the stop (1-based; absent for pre-step exits like `host_not_allowed`). */
  stop_step?: number;
  steps: TraceStep[];
  audit: AuditVerdictLike;
  /** 结构化诊断：失败时不要求 Agent 再读源码/自己探页面。 */
  diagnostics?: {
    /**
     * task-16（B3+）起改为可选：step 侧诊断恒带池大小；arrive 侧诊断（到达面子集）没有池，
     * 只带 throttle_suspect（限速判读证据）。
     */
    pool_size?: number;
    waited_ms?: number;
    frame_origins?: string[];
    target?: string | null;
    candidates?: string[];
    /** A2：target_not_found 现场发现的滚动容器事实（内容远高于可视区 = 可能未渲染）。 */
    viewport_underloaded?: Array<{ tag: string; id: string; scrollHeight: number; clientHeight: number; rendered: number }>;
    /**
     * U3：就绪判档证据（verdict==="ready" 时省略）。`ready_empty` 也带本对象
     * （池空但页面已就绪是事实，不是 page_not_ready）。
     */
    readiness?: Readiness;
    /**
     * task-11（B3，评审 #8）：信号不成立且观测到**会话级骤降**时的限速/降频判读证据
     * （probe3 现场：单会话观察调用 202→15、8 秒跑完全程、芯片 declared_hidden）。
     * 组合判据防误报：池高峰 ≥20 且当前 ≤ 高峰/4，或两次失败嗅探间正文塌缩——
     * 正常小页面（本来元素就少）不触发。**不新增 stopCode**（stopCode 表是脚本分支
     * 契约）：warning + 证据字段，判读指引见 docs/APP_SCRIPT_AUTHORING.md §10。
     */
    throttle_suspect?: ThrottleSuspect;
  };
  /**
   * A1 动作执行证据（全部可选：缺字段 = 该事实不适用，不硬造）。
   * `executed` 只在**有动作面**的步（命令步/发生过动作尝试）出现：false = 声明了动作但
   * 一个都没执行（见 skipped_actions），true = 至少执行了一个（见 executed_actions）。
   */
  executed?: boolean;
  executed_actions?: ExecutedAction[];
  skipped_actions?: SkippedAction[];
  /**
   * S4：本子目标发生过的 stale 重解析重试（每次一条；缺字段 = 没重试过）。
   * 与 trace 行事件字段 `stale_retry`（同一条目数组）是同一份证据的汇总面；
   * 字段名两处不同（trace 行单数、这里复数），文案勿混写（R9 记录项 1）。
   */
  stale_retries?: Array<{ attempt: number; reason: string; ref: string }>;
  /** S4：本子目标至少一个动作按步级 `force` 声明执行（trace 行 `forced=true` 的汇总）。 */
  forced?: boolean;
  /** 命令步在解析/动作前对 done 信号的预评估结果（仅命令步出现；不改变执行顺序）。 */
  done_preheld?: boolean;
  /** 运行期诚实性警告（如 suspected_async）；只在产生时出现。 */
  warnings?: string[];
  /**
   * S1 状态层：本次 `run()` 的状态记录（一次 ctx.step = 一个 flow 步 = 一条记录）。
   * 向后兼容：旧消费者不认识这个字段就忽略；没有页面往返可观察时键省略。
   */
  state?: StepStateRecord;
}

/* ------------------------------------------------------------------ state layer (S1/S2)
 *
 * 状态 = trace 的字段 + 执行器私产。S1 做“记录”（指纹/flags/effect），S2 加稳定门
 * （settle：只作传感器，不中断执行循环）。指纹只在**已有观察**（步首池提取）与运行
 * 收尾时各算一次；`struct` 只用结构分布，`content` 仅诊断——前进性判据不吃 content
 * （时间戳/轮播会让它抖）。
 */

/** 页面在观察时刻的就绪态（`document.readyState`）。 */
export type ReadyState = "loading" | "interactive" | "complete";

/** 状态指纹：每次观察生成，engine 内部/产物可见（只读）。 */
export interface StateFingerprint {
  /** 全局单调递增：每次抽池/观察 +1（每个 run 从 1 开始）。 */
  epoch: number;
  /** 导航代：本次 run 的初始 goto 完成 +1（动作诱发的导航靠 url 变化体现）。 */
  navEpoch: number;
  url: string;
  readyState: ReadyState;
  /** 结构指纹：可动元素计数 + 角色/标签分布 hash（前进性只用它，不用 content）。 */
  struct: string;
  /** 内容指纹（诊断用）：首批可动元素 label hash；空池省略。 */
  content?: string;
}

/**
 * S1 前进性 flag（引擎判定，不是用户语法；done 语言不变）。
 * U3：`pool_empty` = 该步池空但页面已就绪（settle 静默 + readyState complete）——
 * 池空是事实，不是"页面没准备好"；步级继续，只有 strict 档才把它改判 run 级停因。
 */
export type StateFlag = "done_preheld" | "no_state_progress" | "pool_empty";

/** U3 readiness 四档（§5.3 判档表是唯一出处）。 */
export type ReadinessVerdict = "navigating" | "not_ready" | "ready" | "ready_empty";
export interface Readiness {
  verdict: ReadinessVerdict;
  /** 判定所依据的观测事实（全部来自已有往返；sniff 只在池空/失败路径付一次）。 */
  evidence: {
    ready_state: "loading" | "interactive" | "complete" | "unknown";
    settled: boolean | null;
    settle_timed_out: boolean;
    pool_size: number;
    waited_ms: number;
    budget_ms: number;
    sniff: { admitted: number; focusable: number; aria: number; frames: number; body_text: number } | null;
  };
}

/**
 * fill/setRange 的 effect 读回（不可读组件整条省略，不假装）。
 *
 * W8 掩码语义（安全级）：fill 的值来自敏感槽位（`meta.secretSlots` 声明；值绑定
 * `from:slot` 且 key ∈ 名单）或读回内容命中敏感值时，`before`/`after` 恒为 `"***"`
 * （`applied` 布尔保留——它是「真的填进去了」的核心证据，不泄漏值本身）；
 * password/file/hidden 输入形态维持 `redactValue` 的既有 `***(N)` 口径；
 * 非敏感槽位/字面值的 before/after 维持明文（读回证据行为不变）。
 * 掩码在执行器构造 effect 时做（源头一次，两条产物投影同源同掩）。
 * `set_range` 目前无生产者（W1 预留）：若实现真实读回，目标为敏感控件时同口径掩码。
 */
export interface StateEffect {
  kind: "fill" | "set_range";
  before: string;
  after: string;
  /** 页面值事实是否等于写入值/目标（读回成功才出现）。 */
  applied: boolean;
  /** setRange：是否在容差内（fill 不出现）。 */
  accurate?: boolean;
}

/** 每个 flow 步落进 `step_traces[i].state` 的记录。 */
export interface StepStateRecord {
  before: StateFingerprint;
  after?: StateFingerprint;
  /**
   * S2：本步在抽池前等待页面静默的累计毫秒数（0 = 有 settle 但无需等待；策略关闭时键省略）。
   * 见 `settle.ts` 与 `meta.policy.settle`。
   */
  settleMs?: number;
  actions: { attempted: number; executed: number; changed: number };
  flags: StateFlag[];
  effect?: StateEffect;
}

/* ------------------------------------------------------------------ S5 decision-state
 *
 * S5a（gate）与 S5b（context）都是**默认关闭**的实验开关（`meta.policy.decision_state`）：
 * 不声明时执行器的决策路径逐字节不变。它们只改变"什么时候问模型、问的时候带什么观测事实"，
 * 不改变「模型只投票 / 完成只认信号」契约——模型仍只在一组 ref 里选一个。
 */

/** S5a 状态闸门：`off`（缺省）= 今天的行为；`stable_only` = 先 settle，同池同题不重复问。 */
export type DecisionStateGate = "off" | "stable_only";
/** S5b 状态上文：`off`（缺省）；`delta` = 决策请求带 ≤200B 结构化 `state_digest`。 */
export type DecisionStateContext = "off" | "delta";

export interface DecisionStatePolicy {
  gate: DecisionStateGate;
  context: DecisionStateContext;
}

/** 缺省档：两项都关（`meta.policy.decision_state` 不声明就是这个）。 */
export const DEFAULT_DECISION_STATE: Readonly<DecisionStatePolicy> = Object.freeze({ gate: "off", context: "off" });

/**
 * S5 指标（应用产物 `decisions` 的单一来源；默认档全 0，且**不写进产物**——缺省等价纪律）。
 * 计数位置只有执行器的决策路径（`pickInner`），不在报告层重算。
 */
export interface DecisionStateMetrics {
  /** 状态闸门省掉的 ask 数（同题一字不差，或同池结构 + 上次选择仍可行动 ⇒ 复用上一次答复）。 */
  asks_saved: number;
  /** 状态闸门的 settle **实际等待**次数（`waitedMs > 0`；已静默的 0ms 检查不计）。 */
  gate_waits: number;
  /** 带 `state_digest` 真正发出的决策请求数。 */
  context_sent: number;
  /** 策略要求带上文但 provider 不支持（`capabilities.state_digest !== true`）而跳过的请求数。 */
  context_skipped: number;
}

/**
 * S5b 的状态摘要（**只给观测事实，不塞建议**）。字段序即序列化序；≤200 字节是硬约束
 * （`STATE_DIGEST_MAX_BYTES`）——超了先裁 `flags`、再裁 `last_effect`，绝不截断 JSON。
 */
export interface StateDigest {
  /** 距上一次 ask 的导航代数差（本次 run 内；首次 ask = 自 run 起点）。 */
  nav_epoch_delta: number;
  /** 最近一次 effect 读回（只有 fill 产生；值本身不进摘要，只留 kind/applied）。 */
  last_effect?: { kind: StateEffect["kind"]; applied: boolean };
  /** ask 时刻页面是否已静默（settle 传感器的读数；gate 关闭时不等待，只探测）。 */
  settled: boolean;
  /** 当前 ask 的候选池是否与上一次 ask 不同（首次 ask = true）。 */
  pool_changed: boolean;
  /** 本次 run 到目前为止的 S1 flags（done_preheld / no_state_progress；无则省略）。 */
  flags?: StateFlag[];
}

/** `state_digest` 的 JSON 字节上限（协议契约，见 schema F25）。 */
export const STATE_DIGEST_MAX_BYTES = 200;

/**
 * A stronger reasoner consulted when the LOCAL model is unsure — C3-R's
 * "deliberative path" adapted to this project's contract: the escalator is a
 * PICKER, not a planner. It receives the same criteria view the local model saw and
 * may only name one of those refs; it cannot invent elements, values or actions.
 */
export interface EscalationRequest {
  instruction: string;
  /** ref -> the rendered line the local model was shown (same rendering). */
  criteria: Record<string, string>;
  url: string;
  title: string;
  main_text: string;
  /** Why the local model was not trusted, e.g. "low confidence 0.12 < floor 0.25". */
  why: string;
}

/**
 * Remembers which elements were clicked and changed nothing, per (page, subgoal), so
 * a retry / resume / re-run does not walk into the same dead element again — and
 * CLEARS the mark the moment that element works (see src/model/outcome-memory.ts).
 */
export interface OutcomeMemoryLike {
  key(url: string, instruction: string): string;
  inertIn(key: string): ReadonlySet<string>;
  record(key: string, signature: string, outcome: "inert" | "effective"): void;
  countPrevented?(n?: number): void;
}

/**
 * Hints EARNED from an observed success: when a model pick actually advanced the
 * subgoal, the element it touched becomes a hint for the same (url, subgoal) next time
 * — restricted to stable handles by `induceHint` (see src/model/hint-memory.ts).
 */
export interface HintMemoryLike {
  key(url: string, instruction: string): string;
  lookup(key: string): string | null;
  record(key: string, hint: string): void;
  countUsed?(n?: number): void;
}

export type EscalatorLike =
  (req: EscalationRequest) => string | null | Promise<string | null>;

export interface RunOptions {
  /** DOM completion signal: `(page) => boolean`, async allowed. */
  goalSignalFn?: ((page: AnyPage) => boolean | Promise<boolean>) | null;
  /**
   * The subgoal's signal is `{manual: true}`: its completion cannot be verified
   * from the DOM, so the HUMAN attests it. The executor asks right after an action
   * that had a visible effect, records the page state it was shown, and only then
   * reports `done` (with `manual: true`). With no `manualConfirmFn` the step stops
   * with an explicit reason instead of silently succeeding.
   */
  manualGoal?: boolean;
  manualConfirmFn?: ((desc: string, stateExcerpt: string) => boolean | Promise<boolean>) | null;
  /**
   * Observation-bottleneck recovery: when a model pick lands below the confidence
   * floor, take ONE wider look (a bigger element budget) and re-ask before blocking
   * the subgoal. The pool is the model's entire world — a target that never entered
   * it cannot be chosen no matter how good the model is. Default ON; it only ever
   * runs on the way to stopping.
   */
  reobserve?: boolean;
  /** Consulted after re-observation fails, before the subgoal blocks (opt-in). */
  escalateFn?: EscalatorLike | null;
  /** Cross-run memory of elements that proved inert on this page+subgoal. */
  outcomeMemory?: OutcomeMemoryLike | null;
  /**
   * How an inert memory is used:
   *   "forbid" (default) — the element is removed from the candidate pool
   *   "rank"             — it stays, annotated in the model's view ("tried, no change")
   */
  outcomeMemoryMode?: "forbid" | "rank";
  /** Cross-run memory of hints LEARNED from successful picks (used when the plan has none). */
  hintMemory?: HintMemoryLike | null;
  /**
   * S2 ③ 运行期接线：提名指令**收窄元素池**（可选；缺省 null = 不窄，行为逐字节不变）。
   * 只作用于"规则/模型挑元素"的候选池——**点名叫的目标（hint）与命令空间不受窄**：
   * 计划声明的目标仍是权威，族不一致由语义层 `firstExecFamily` 证据面强制如实报 blocked。
   * 收窄后池子为空 = 结构化停因 `nominated_family_empty`（不猜、不退回全池）。
   */
  expectedFamily?: ElemFamily | null;
  /** Reuse an open page (one browser across subgoals); run() then owns nothing. */
  page?: AnyPage | null;
  /**
   * 当前页已经就位：不要再 `goto(startUrl)`。flow 的 `ctx.step` 不带 `url` 时用它——
   * SPA 的下一步必须接着当前 DOM 走，不能每一步都整页重载（Google Maps 实测：重载会丢筛选面板状态）。
   */
  skipNavigation?: boolean;
  /** 导航后、抽取元素前的稳定等待（ms）；SPA 的 domcontentloaded 早于面板渲染。 */
  settleMs?: number;
  /**
   * 元素池 ready gate：导航/当前页还没渲染出交互元素时，不要立刻判 `space_empty`。
   * flow 的 `ctx.step` 打开它；计划/线上用例可按需打开。
   */
  poolReady?: boolean;
  /** pool ready gate 的最大等待；0 = 只看一次。 */
  poolReadyTimeoutMs?: number;
  /** pool ready gate 的轮询间隔。 */
  poolReadyPollMs?: number;
  /**
   * U3 池空判档（flow 面专属；plan/journey 面 `poolReady=false`，本键不适用）：
   *   "fact"   （缺省）池空但 settle 静默 + readyState complete ⇒ `ready_empty`：步级 `pool_empty`
   *            事实 + warning + **继续**（让后续命令给出真正的失败证据）；
   *   "strict" （逃生口）池空 = `page_not_ready` **逐字节等于 U3 之前的行为**。
   */
  poolGate?: "fact" | "strict";
  /** U3：`meta.policy.surface.native_activation`（缺省 window；"off" = 池构成回到 U3 之前）。 */
  surfacePolicy?: SurfacePolicy;
  /** action 后 done 信号的轮询间隔；0 = 只看一次。 */
  donePollMs?: number;
  /** action 后 done 信号的总等待窗口。 */
  doneTimeoutMs?: number;
  /**
   * F3：步级 `timeoutMs` 显式声明时的**整步挂钟帽**（毫秒）。ctx.ts 只在作者显式声明
   * `ctx.step(..., { timeoutMs })` 时传入（它与 doneTimeoutMs 同值，但语义是整步的
   * 挂钟约束，不是动作后的信号窗口）；缺省不出现 = 本步没有任何挂钟帽（既有行为
   * 逐字节不变）。约束面：reobserve/升级循环的每轮与总时长。
   */
  stepTimeoutMs?: number;
  slots?: Record<string, unknown> | null;
  /**
   * U1 步级显式值袋（决策语句步的值通道）：作者在 `ctx.step(..., { values: {...} })` 声明的
   * `{ 关联键: 值 }`。决策路径的 fill/select 值请求按「values 袋 → slots 袋」顺序解析
   * （两袋同一套两档匹配：精确键 → 大小写不敏感互含，见 `_slotValue`）——作者显式值
   * 优先于隐式 slot 匹配；两袋都落空仍是结构化 `needs_value`，绝不猜（红线②）。
   * 只接决策路径（命令步的值面仍是 `{from:"slot", key}` 具名绑定，`bound` 恒优先）。
   * 缺省不出现 = 既有行为逐字节不变。
   */
  values?: Record<string, unknown> | null;
  targetHint?: string | null;
  /** Reuse a live playwright object; run() then leaves it alone. */
  pw?: PwLike | null;
  verbose?: boolean;
  targetHints?: string[] | null;
  /** `when` guard: evaluated after navigation, before any action. */
  precondition?: SignalSpec | null;
  /**
   * P0-E：本步的原始 done 信号声明（弱否定判定与 guard 证据用；只读，不参与求值——
   * 求值仍走 goalSignalFn。缺省 null = guard 的「弱 done 零前进」分支不启用）。
   */
  doneSpec?: SignalSpec | null;
  /**
   * P2 COMMAND SPACE (the "check + submit in ONE
   * subgoal" use case): an ORDERED CLOSED SET of commands this step may execute,
   * declared by the app config and validated at load (`actions.validateCommands`).
   * When present, the step acts ON THE SPACE, not on the pool:
   *   instantiate the space (decl × this step's pool × forbiddances, a pure function)
   *   → walk it in declared order, executing one command per step
   *   → a command that resolves to nothing is OUT; nothing left ⇒ structured
   *     `space_empty` — the loop NEVER falls back to the whole pool and the model
   *     is NEVER asked to pick (the closed set decides).
   * `fill`/`select` bind their value by NAME from the plan's slots (`{from:"slot",key}`)
   * — a missing binding is `needs_value`, never a guess (红线② at the command layer).
   * Absent ⇒ today's behaviour, byte-identical.
   */
  commands?: CommandDecl[] | null;
  /**
   * A2 候选窗口排序策略（来自 `meta.policy.candidate_priority`，缺省 "bucketed"）：
   *   "bucketed"   —— 分桶配额取池（chrome/viewport/contentNear/mainOffscreen/other），见
   *                  `extraction.POOL_QUOTAS`；A2 的行为变更面。
   *   "main-first" —— 回退 A2 之前的排序（main 内容优先 + 截断），不改任何其它逻辑。
   */
  candidatePriority?: "bucketed" | "main-first";
  /**
   * E2：`on_ambiguous:"act"` 的歧义命中顺序（`decision.ambiguous_ordering` 配置键）。
   * `"dom-preorder"`（缺省）= act 时刻 live-DOM 文档序首个 actionable 候选（行为变更，
   * 见发版说明；证据块输出 ordering/selected_ref/selected_dsh_ref/sort_key）；
   * `"pool-order"` = 旧池序（回退开关）。仅歧义模式（≥2 distinct 候选且 on_ambiguous:"act"）生效。
   */
  ambiguousOrdering?: AmbiguousOrdering;
  /**
   * E1-c：act 的 `#id` hint live-DOM 直查兜底（`decision.id_fallback`；缺省 true = 修复
   * "扫描器报得出、act 却 target_not_found"的一致性 defect；false = 回退开关）。
   * 仅限形态 1（`#id`），其余 hint 形态不做直查。
   */
  idFallback?: boolean;
  /**
   * E1-b：池配额模型（`decision.pool_quota_mode`；缺省 "legacy" = 既有优先级逐出，
   * 行为不变）。"quota" = 双配额灰度档：viewport 保底 + id-backed 保留 + 壳元素限额。
   */
  poolQuotaMode?: "legacy" | "quota";
  /**
   * E1-a：池预算帽的观测面（`decision.act_pool_cap`；缺省 40 = MAX_ELEMENTS）。
   * **只观测**：落空诊断回显 `pool_cap`；池构成不因它变化（默认值调整需另行变更）。
   */
  actPoolCap?: number;
  /**
   * A1 `forceAct`（opt-in，声明面；缺省不出现 = 今天的行为逐字节不变）：
   * 命令步即使 done 信号在动作前已成立，也**先把命令闭集执行完**，执行后再评估 done。
   *
   * 为什么需要这个开关：A1 之前引擎没有任何"done 已成立就跳过动作"的短路，所以缺省
   * 本来就是"先动作"；把这一点**显式声明出来**，是为了让后续可能引入的 done 预判短路
   * 有 opt-out 出口，同时脚本作者能明确表达"这一步必须真的动一下"。A1 只记录声明，
   * dry/replay 只传递声明、不重新决策（`dry` 仍 ok:true；`replay` 按录制序列）。
   */
  forceAct?: boolean;
  /**
   * S4 `force`（opt-in，步级声明；缺省 false = 今天的行为逐字节不变）：
   * 动作执行走 Playwright 的 **force 语义**（`locator.click({force:true})` /
   * `fill(value,{force:true})` / `selectOption(...,{force:true})` / `hover({force:true})`）——
   * 跳过 actionability 检查（可见/稳定/可接收事件/启用），**仍要求元素可定位**。
   *
   * 风险：可能点到被遮挡/动画中的目标（鼠标坐标上的顶层元素收事件），只应在作者已确认
   * 目标会在瞬态弹层/动画后真正接收事件时使用。风险确认（risky/confirmFn）语义不变：
   * force 只改动作可操作性，不改"危险动作必须确认"的闸门。
   */
  force?: boolean;
  /**
   * S4 `staleRetry`（opt-in，步级声明；缺省 false = 今天的行为逐字节不变）：
   * 动作失败且**疑似 stale** 时，重抽池 → 重解析**同一声明目标**（命令 target / act hint）→
   * 重试动作，同一步内最多 2 次（不额外计入子目标动作预算）。
   *
   * 触发判据（只有这三类，全部有界）：
   *   - `stale_ref`：`_locatorFor` 的盖章句柄/属性回退全部落空（节点已不在文档里）；
   *   - `action_failed`：Playwright 动作本身抛错（页面在动作中途重渲染/卸载）；
   *   - `not-actionable-or-covered` 且现场 `requery === "detached"`（节点在探针后被卸载）。
   * `action-timeout` / 有覆盖者且节点仍在（`requery === "present"`）**不重试**——那不是 stale。
   * 没有声明目标的决策步（纯模型挑元素）不重试：重解析必须对着**可复现的声明**做，不能猜。
   * 每次重试进 trace（行上的 `stale_retry: [{attempt, reason, ref}]`）；最终失败仍按既有
   * stopCode 诚实报告（stale_ref / action_failed / not-actionable-or-covered）。
   */
  staleRetry?: boolean;
  /**
   * NL Flow S1：`dataset` 绑定来源的读取面。
   * 命令参数可声明 `{"from":"dataset","key":"…"}` 引用**前序步骤的具名产出**；
   * 解析在绑定那一刻现读最新 generation——陈旧世代不可读。缺省 null ⇒ 该来源
   * 结构化 `needs_value`（没有数据集就没有值，绝不猜）。不声明 dataset 绑定的包：
   * 行为逐字节不变。
   */
  dataset?: DatasetReader | null;
  /**
   * §4：这一步的**可逆性**声明（来自 `pack` 的 `effect`）。它改变的是"闸门相不相信关键词/模型票"，
   * 不改变任何缺省行为：不写 = 今天（DESTRUCTIVE_PATTERNS + 模型票）。
   * `irreversible: true` ⇒ 必问确认且不许被模型提议；`false` ⇒ 明确告诉架构"错了也白跑"，
   * 这是 W4/A2 唯一允许放开模型的依据。
   */
  effect?: { irreversible?: boolean };
  /**
   * A2′（W4′ 存活半边，2026-10-14 补完）：这一步声明了"错了白跑"（`effect.irreversible:false`，
   * 加载期已校验，见 `plan.ts`），于是当规则/窄问/加宽/升级**都拿不下**、本来要 `low_confidence`
   * 阻塞时，**让本地模型的低置信选择被执行，由这一步自己的 DOM 信号事后裁决**——
   * 与老师提名同一认识论（执行 + 信号定生死），只是爆炸半径由声明限定：每个元素一次机会
   * （裁决过未确认即禁），不可逆的步绝不允许开这个口。trace 记 `<provider>:adjudicated`
   * （本地 laya 档即 `laya:adjudicated`）。
   * 不写 = 今天逐字节（低置信即阻塞）。
   */
  adjudicate?: boolean;
  /**
   * Navigation envelope (see `disallowedHost`): when non-empty, `run()` refuses
   * to open a `start_url` whose host is not declared, and stops the subgoal if
   * an executed action lands on an undeclared host. Default: no envelope —
   * behaviour identical to before. `meta.hosts` from `apps/<id>/app.mjs` feeds this.
   */
  hosts?: string[] | null;
  /**
   * P1 TIERED HINT (default OFF): when the
   * plan's `target_hint` resolves to a TIER that is ambiguous inside (several
   * genuinely different candidates), rules.ts used to collapse that to `null` and
   * the step fell to laya over the WHOLE pool — "pick 1 of 40" for what is really
   * "pick 1 of these 3" (measured: 17 candidates → 0.23 → BLOCKED). With this on,
   * the ambiguous tier becomes a NARROWED question: laya sees only those candidates
   * (the shortlist is then a passthrough at ≤ k labels). If the narrowed ask
   * abstains, the step falls back to today's full-pool ask — the tier narrows the
   * question, it never decides by itself. OFF ⇒ byte-identical behaviour.
   */
  tieredHint?: boolean;
  /**
   * DRY RUN: resolve the step's target exactly as a real run would (rule hint →
   * local model → re-observe → escalate), probe that it is actionable WITHOUT
   * touching it, and stop there. Nothing is clicked, filled, or scrolled: the
   * pre-fill guard and the occlusion probe (which clicks) are never reached, so
   * the page is bit-identical afterwards. `stop_reason` starts with `dry-run:` and
   * the trace carries `dry_run: true` + `actionable` + `would`.
   *
   * This is the evidence half of "an irreversible action is always dry-run +
   * human confirmation": the runner shows what WOULD be clicked before asking.
   */
  dryRun?: boolean;
}

export interface BrowserSession {
  pw: PwLike;
  browser: BrowserHandle;
  page: AnyPage;
  close(): Promise<void>;
  /**
   * task-21/D-1：本次会话的浏览器事实（env.browser 一等证据；只增字段）。
   * binary_basename = 实际启动的 chromium 变体（chrome vs chrome-headless-shell——渲染退化
   * 判定的第一块事实）；headless = 是否无头；persistent_profile = 是否持久化 profile。
   * 缺省不出现 = 会话不是本进程 browserSession() 创建的（sessionFactory 注入等）。
   */
  envBrowser?: { binary_basename: string; headless: boolean; persistent_profile: boolean };
}

export interface MiddlewareOptions {
  /** String -> `runtime.load(modelId)`; a DecisionAgent is used as-is. */
  modelId?: string | DecisionAgent;
  auditor?: Auditor;
  maxSteps?: number;
  confFloor?: number;
  riskyThreshold?: number;
  doneThreshold?: number;
  confirmFn?: (desc: string) => boolean | Promise<boolean>;
  /** Human oracle for `{manual: true}` subgoals (see RunOptions.manualGoal). */
  manualConfirmFn?: ((desc: string, stateExcerpt: string) => boolean | Promise<boolean>) | null;
  /**
   * 两次实际动作之间的最小等待（毫秒）；0/缺省 = 今天的行为。由应用配置表的
   * `pace.between_actions_ms` 传入——给需要降载的站点用，不是反爬对抗。
   */
  actionDelayMs?: number;
  /** See RunOptions.reobserve (default ON). */
  reobserve?: boolean;
  /** See RunOptions.escalateFn (default: none — the local model is the last word). */
  escalateFn?: EscalatorLike | null;
  /** See RunOptions.outcomeMemory (default: none — each run starts blind). */
  outcomeMemory?: OutcomeMemoryLike | null;
  /** See RunOptions.outcomeMemoryMode (default "forbid"). */
  outcomeMemoryMode?: "forbid" | "rank";
  /** See RunOptions.hintMemory (default: none — only authored hints are used). */
  hintMemory?: HintMemoryLike | null;
  gotoTimeout?: number;
  routeModels?: boolean;
  router?: RouterLike | null;
  /** Constructor-level default for `RunOptions.hosts` (the navigation envelope). */
  hosts?: string[] | null;
  /**
   * Constructor-level default for `RunOptions.dataset`（NL Flow S1 注入面的旅程级形态）：
   * 一整个旅程共用一个数据集时由构造方给；run 级 opts.dataset 仍可覆盖。
   * 不声明 dataset 绑定的计划：行为逐字节不变。
   */
  dataset?: DatasetReader | null;
  /**
   * D3/R-4：同一个元素（按**元素签名**，不是位置性 ref）在**一个子目标内**最多被有效执行几次。
   *
   * 为什么需要这个上界：`inert` 是整页快照比对，页面上有个倒计时/轮播/广告计时器时它
   * **永远不成立**（前/后两次采样之间页面必然变了），于是"这个元素没用了"的证据链断掉，
   * anti-repeat 不触发，同一个死按钮被反复点，最后报告把病因写成 `max_steps`——
   * 一个噪声信号不该是循环唯一的终止依据（重审 D3）。缺省 3；0 = 关闭（回到今天的行为）。
   */
  maxEffectiveRepeats?: number;
  /**
   * 风险问句花不花一次模型前向（§W1）。默认 `always` = 今天（关键词命中即定，
   * 没命中的**每一步**都问一次模型）。`rules-only` = 只信关键词规则，一步都不问。
   *
   * 为什么这条值得存在：批量运行里 `confirmFn` 默认是"一律放行"，于是这次前向的答案
   * **被丢掉**——它按每步一次的频率收费（实测整批语料 597 s vs 桩 160.7 s，
   * 而选目标只被问了 5 次），换来的东西在批模式下没人看。要省，就得**声明着省**，
   * 而不是让执行器偷偷少问（那会改变 trace 与拒绝行为）。
   */
  riskAsk?: "always" | "rules-only";
  /** Constructor-level default for `RunOptions.tieredHint` (P1 narrowed question, default OFF). */
  tieredHint?: boolean;
  /**
   * A2：constructor-level default for `RunOptions.candidatePriority`（来自
   * `meta.policy.candidate_priority`；缺省 "bucketed" = A2 行为变更面）。
   */
  candidatePriority?: "bucketed" | "main-first";
  /**
   * E2：constructor-level default for 歧义命中顺序（`decision.ambiguous_ordering`
   * 配置键；缺省 "dom-preorder" = 行为变更面，"pool-order" = 旧序回退开关）。
   */
  ambiguousOrdering?: AmbiguousOrdering;
  /**
   * E1-c：constructor-level default for `#id` 直查兜底（`decision.id_fallback`
   * 配置键；缺省 true）。
   */
  idFallback?: boolean;
  /**
   * E1-b：constructor-level default for 池配额模型（`decision.pool_quota_mode`
   * 配置键；缺省 "legacy"）。
   */
  poolQuotaMode?: "legacy" | "quota";
  /**
   * E1-a：constructor-level default for 池帽观测面（`decision.act_pool_cap`
   * 配置键；缺省 40；只观测）。
   */
  actPoolCap?: number;
  /**
   * S1：pre-held done 的处置（来自 `meta.policy.done_preheld`；缺省 "warn" = 只记录）。
   * 见 `PackPolicy.done_preheld`（app-pack.ts）的语义说明。
   */
  donePreheldPolicy?: "warn" | "fail" | "allow";
  /**
   * P0-E：步级 false_done guard 的处置（来自 `meta.policy.done_guard`；缺省 "warn" =
   * 只记 step warning、不改判定；"fail" = done 成立但 guard 命中时结构化停 false_done）。
   */
  doneGuardPolicy?: "warn" | "fail";
  /** S1：fill 后读回 value 并与写入值比对（缺省 true；不可读组件自动降级跳过）。 */
  fillReadback?: boolean;
  /**
   * W8：敏感槽位**键**名单（app-runner 从 `meta.secretSlots` + 名称启发算出后传入；
   * 缺省空 = 无敏感槽位，行为逐字节不变）。fill 的 effect 读回在「值来自这些槽位 /
   * 读回内容命中其值」时把 before/after 掩码为 `***`（applied 保留）。只传键不传值：
   * 值本体由执行器从当次 run 的 slots 袋现读——**步级 slots 合并后的真值只在执行器
   * 可见**（R3 案例 S 的泄漏根源：app-runner 的 secretValues 名单从不包含步级值，
   * 收尾 scrubSecrets 对 effect 读回里的这类值天然失明）。
   */
  secretSlotKeys?: ReadonlySet<string>;
  /**
   * S2：抽池前的稳定门策略（`meta.policy.settle`；缺省开启 `{quietMs:400,timeoutMs:5000}`，
   * `null` = 显式关闭）。只影响"抽池前是否等页面静默"，不改变完成判定/动作语义。
   */
  settle?: { quietMs: number; timeoutMs: number } | null;
  /** U3：池空判档（缺省 "fact"；"strict" = U3 之前的 page_not_ready 快败）。 */
  poolGate?: "fact" | "strict";
  /**
   * P0-B：声明目标（act hint）解析链全落空时是否允许模型自由选。
   * 缺省/`"widen"` = 今天（回退模型）；`"strict"` = **不回退**，结构化
   * `target_not_found`（reason 显式写明 act_hint="strict"）。只砍模型回退：
   * FW8 身份回捞先执行，命令步不受影响。缺省不出现 = 行为逐字节不变。
   */
  actHint?: "widen" | "strict";
  /**
   * A3：`meta.policy.act_hint_tier`（与 `actHint` **正交**；缺省/"any" = 今天逐字节不变）。
   * "strong" = 声明目标的**弱档胜出**（bare tier≥3 词前缀/词包含、attrSubstr tier=3 loose
   * 子串；判据复用 rules 的 `suspicious`，不另造档位表）改判**未命中**：ref 被清空、step
   * warning 换成 `weak_hint_rejected`，随后照 `actHint` 既有语义继续（widen → 交模型；
   * rules-only → 既有 `no_model_runtime`；strict → 结构化 `target_not_found`，reason 写明
   * 弱档被判未命中 + 候选 + 两条修法）。命令 target / learned hint（非作者声明）/ 决策步
   * 不受影响；只作用于声明目标的规则解析与 rules-only 宽扫两处（同一 `declaredAllow`）。
   */
  actHintTier?: "any" | "strong";
  /**
   * P0-C：`meta.policy.target_resolution`（缺省/`"off"` = 今天逐字节不变；`"declared"` =
   * 启用 DRF）。只在**声明目标**（命令 target / act hint）的解析链上生效：池 hintMatch →
   * ADMIT 回捞 → FW8 身份回捞 → **DRF**（attr/text 两模式、恰好一个可见、click 前 hit-test）。
   * 回捞元素只进本步局部池，绝不进模型候选（pickInner 剥离 `declared` 标记）。
   */
  targetResolution?: "off" | "declared";
  /** U3：surface 类目策略（缺省 native_activation="window"）。 */
  surfacePolicy?: SurfacePolicy;
  /**
   * A1：`tag[aria-label=…]` / `tag[aria-label~…]` 的池侧属性值底座
   * （来自 `meta.policy.attr_value_match`；缺省 `full_label` = 用 ≤200 的 full_label 与
   * 模型视图 label 双底座，>40 字的 aria-label 才能命中；`display` = A1 之前只看前 40 字）。
   * 只作用于 hint 匹配；inspect/observe/session 不传 = 恒 `full_label`。
   */
  attrValueMatch?: AttrValueMatch;
  /**
   * S5：状态接入决策（来自 `meta.policy.decision_state`；缺省两项都 "off" = 今天的行为）。
   * 见 `DecisionStatePolicy`：gate 决定"stable_only 时先 settle + 同池同题不重复问"，
   * context 决定"决策请求是否带 ≤200B 结构化 state_digest"。
   */
  decisionState?: Partial<DecisionStatePolicy>;
}

/* ------------------------------------------------------------------ JS passes
 *
 * Compiled host-side (PORT NOTE 3). The bodies are the Python bodies verbatim
 * except for the template literals in `snapshot`'s value walk, which are
 * rewritten as string concatenation so no backtick has to survive a TS literal.
 */
