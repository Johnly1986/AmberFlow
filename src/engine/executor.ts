/**
 * Application layer: the browser-automation executor — the TS twin of
 * `layaapp/executor.py`.
 *
 * `BrowserMiddleware` is THE execution loop — one implementation shared by the
 * the CLI, the app layer and the online test suite (all share this loop)
 * subclasses it and only picks the checkpoint / flips ablation switches). Per step
 * it discovers interactive elements (`extraction.ts`), resolves the pick by rule
 * or plan-named hint (`rules.ts`), otherwise asks laya, gates on confidence and
 * risk, probes actionability, executes, compares an inert snapshot and checks the
 * plan's own DOM signal. Browser lifecycle and checkpoint routing live here too,
 * because both are concerns of the loop rather than of the page view.
 *
 * Python method               TS twin
 * ---------------------------------------------------------------------------
 * browser_session()           browserSession()
 * router_max_loaded()         routerMaxLoaded()
 * BrowserMiddleware.__init__  constructor + lazy `ready()` (see PORT NOTES)
 * _nav_rule/_affordance_rule  navRule/affordanceRule wiring in run()
 * current_hint/_advance_hint  currentHint/_advanceHint
 * _hint_match                 hintMatch (rules.ts)
 * agent_for                   agentFor
 * pick_element                pickElement
 * is_risky / is_done          isRisky / isDone
 * _locator_for                _locatorFor
 * snapshot                    snapshot
 * occluded_reason             occludedReason
 * _slot_value                 _slotValue
 * _is_checkable/_is_typing/_is_submit   _isCheckable/_isTyping/_isSubmit
 * _click_only/_execute_element          _clickOnly/_executeElement
 * _missing_required           _missingRequired
 * run                         run
 *
 * PORT NOTES (Node vs Python; deliberate, each one forced by the runtime):
 *   1. `page.url` / `frame.url` are METHODS in Node -> `urlOf()` everywhere.
 *   2. `locator.first` is a METHOD in Node -> `firstLoc()` everywhere, and
 *      `locator.all()` is async.
 *   3. `page.evaluate("<js>")` only auto-calls an ISOLATED function-expression
 *      string; the multi-statement bodies here are compiled host-side with
 *      `new Function` (the same trick extraction.ts uses) so they stay verbatim.
 *   4. The whole loop is ASYNC: Python's sync Playwright becomes awaits, and
 *      `laya.load` (sync in Python) becomes `await runtime.load(...)`. The
 *      constructor therefore cannot build the checkpoint; a lazy `ready()` does
 *      it on the first model-facing call (and at the top of `run`), which keeps
 *      `new BrowserMiddleware(...)` usable exactly like the Python class.
 *   5. `sync_playwright()` has no Node twin — the playwright module IS the
 *      connection. `run()`/`browserSession()` use the imported `chromium`
 *      BrowserType when no `pw` is injected, and close only the browser they
 *      launched themselves (the `_stop_playwright_owned`/`owns_browser` rule).
 *   6. `input()` confirm prompt -> a default `confirmFn` that refuses (see
 *      DEFAULT_CONFIRM). Safer than blocking on a stdin that has no tty.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getAuditor, type AuditVerdict, type Auditor, type TraceStep } from "./audit.ts";
import * as browserEnv from "../browser/browser-env.ts";
import type { BrowserLike, LaunchOptions } from "../browser/browser-env.ts";
import {
  INTERACTIVE_ALL,
  MAX_CHOICES,
  WIDE_POOL_ELEMENTS,
  WIDE_QUOTAS,
  ariaInteractiveLines,
  criteriaView,
  esig,
  extractElements,
  extractSlots,
  elemFamily,
  lexicalOverlap,
  filterElemsByFamily,
  actionCapabilities,
  firstOf,
  frameAt,
  framesOf,
  hintLookup,
  identityLookup,
  formatIdentityCandidates,
  orderElemsByFamily,
  poolSniff,
  stateText,
  urlOf,
  viewportUnderload,
  type ActionCapability,
  type Elem,
  type ElemFamily,
  type ElemPool,
  type PageLike,
} from "./extraction.ts";
import { admitSelectorWithJsFor, type SurfacePolicy } from "./surface.ts";
import {
  getLayaRuntime,
  type ChoiceAnswer,
  type DecisionAgent,
  type ModelState,
  type NoulAnswer,
  type RouterLike,
} from "../model/model.ts";
import { decisionProviderOrNull, layaProvider, type DecisionProvider } from "../model/decision-provider.ts";
import { applyRange, type RangeOptions, type RangeOutcome, type RangeValue } from "./range.ts";
import {
  DESTRUCTIVE_PATTERNS,
  FILLER_TOKENS,
  NAV_VERBS,
  ROLE_TOKENS,
  STOP_TOKENS,
  affordanceRule,
  hintCandidates,
  hintMatch,
  navRule,
} from "./rules.ts";
import { checkSignal, type SignalSpec } from "./signals.ts";
// S2 稳定门：MutationObserver 传感器 + 有界静默等待（只作观察增强，不中断执行循环）。
import { DEFAULT_SETTLE, installSettle, settle, type SettlePage, type SettleResult } from "./settle.ts";
// 语法报错文案的唯一出处：形状清单不再手抄（grammar-prompt import 时自证与 parseHint 对齐）。
import { HINT_CLOSED_SET_TEXT } from "./grammar-prompt.ts";
// A2 判别：命令 target 是 hint 语法字符串，词面要从同一份解析器里取（不新开第二种解析）。
import { parseHint } from "./hint.ts";
import { LayaNotConfiguredError, type LayaRuntime } from "../model/model.ts";
import { induceHint } from "../model/hint-memory.ts";
import { instantiateSpace, resolveCommandValue, type CommandDecl } from "./actions.ts";
import { emptySlotBindingReason, type BindingDiagnostics } from "./bindings.ts";
import { parseClickAtValue } from "./click-at.ts";
import type { DatasetReader } from "./dataset.ts";
import { optionCandidatesFrom, type OptionCandidate } from "./bindings.ts";

/* ------------------------------------------------------------------ shapes */

/**
 * A live Playwright page. `extraction.PageLike` already tolerates both runtimes
 * (property vs method `url`/`first`); this makes the page surface the executor
 * needs (locator/goto/title/waitForLoadState/context) explicit and non-optional,
 * so `page.locator(...)` is callable without a `!`. Still structurally assignable
 * to `extraction.PageLike`, which is what the helpers take.
 */
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
type Sig = [string, string, string];

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
  | "done_preheld";

/** Minimal locator surface used by the executor (superset of `extraction.LocLike`). */
interface AnyLoc {
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
  frames: Array<{ url: string; text: string; vals: string }>;
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
  resolved_by?: "dom_identity";
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
    pool_size: number;
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
   * S1：pre-held done 的处置（来自 `meta.policy.done_preheld`；缺省 "warn" = 只记录）。
   * 见 `PackPolicy.done_preheld`（app-pack.ts）的语义说明。
   */
  donePreheldPolicy?: "warn" | "fail" | "allow";
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
  /** U3：surface 类目策略（缺省 native_activation="window"）。 */
  surfacePolicy?: SurfacePolicy;
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

/** `new Function("return (<expr>);")()` -> a real function object for evaluate(). */
function asFunction(src: string): (...args: any[]) => any {
  // eslint-disable-next-line no-new-func
  return (new Function(`return (${src});`) as () => (...args: any[]) => any)();
}

/** Every input's current value — inner_text misses fills, and values drive validation.
 *
 * SECRET REDACTION (P0-3): `password`/`file`/`hidden`
 * inputs keep their SHAPE (a per-character mask) but never their content. The inert
 * check compares this string, so a typed password still CHANGES the snapshot
 * (`"" -> "*"` -> `"**"`) without leaking the value into a snapshot, a trace line or
 * a committed `-result.json`. A raw `.value` of a secret field must not survive here. */
const VALS_JS = `() => [...document.querySelectorAll('input,textarea,select')]
  .map(e => {
    const t = (e.getAttribute('type') || '').toLowerCase();
    const raw = String(e.value ?? '');
    const v = (t === 'password' || t === 'file' || t === 'hidden') ? '*'.repeat(raw.length) : raw;
    return (e.name || e.id || e.getAttribute('data-test') || e.tagName) + '=' + v;
  })
  .join('&')`;
const FN_VALS = asFunction(VALS_JS);

/** Centre hit-test: distinguishes "covered" from "slow but unblocked". */
const HIT_JS = `(e) => {
  const r = e.getBoundingClientRect();
  if (!r.width || !r.height) return 'zero-size';
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return 'offscreen';
  const top = document.elementFromPoint(x, y);
  if (!top || top === e || e.contains(top) || top.contains(e)) return null;
  return [top.tagName.toLowerCase(), top.id ? '#' + top.id : ''].join('');
}`;
const FN_HIT = asFunction(HIT_JS);

/**
 * S1 actionability 现场（只读）：bbox + 中心点覆盖者 + 重查时节点是否仍在文档里。
 * 与 HIT_JS 分开是因为 HIT_JS 的返回值被两处当成“有无覆盖者”的布尔语义（不能改形状）。
 */
const HIT_DETAIL_JS = `(e) => {
  const rr = e.getBoundingClientRect();
  const bbox = {
    x: Math.round(rr.x), y: Math.round(rr.y),
    width: Math.round(rr.width), height: Math.round(rr.height),
  };
  const requery = (e && e.isConnected && document.contains(e)) ? 'present' : 'detached';
  if (!rr.width || !rr.height) return { bbox, blocker: 'zero-size', requery };
  const x = rr.x + rr.width / 2, y = rr.y + rr.height / 2;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { bbox, blocker: 'offscreen', requery };
  const top = document.elementFromPoint(x, y);
  if (!top || top === e || e.contains(top) || top.contains(e)) return { bbox, blocker: null, requery };
  return { bbox, blocker: [top.tagName.toLowerCase(), top.id ? '#' + top.id : ''].join(''), requery };
}`;
const FN_HIT_DETAIL = asFunction(HIT_DETAIL_JS);

/** Visible empty inputs/textareas the frozen plan's data bag can supply. */
const EMPTIES_JS = `() => [...document.querySelectorAll('input:not([type=hidden]),textarea')]
  .filter(e => !e.value.trim() && e.offsetParent !== null
    && !['checkbox','radio','submit','button'].includes((e.getAttribute('type') || '').toLowerCase()))
  .map(e => ({tag: e.tagName.toLowerCase(), dt: e.getAttribute('data-test') || '',
              name: e.name || '', id: e.id || ''}))`;
const FN_EMPTIES = asFunction(EMPTIES_JS);

/* ------------------------------------------------------------------ helpers */

/** `.first` across both Playwright runtimes (property vs method). */
function firstLoc(loc: any): AnyLoc {
  return typeof loc.first === "function" ? loc.first() : loc.first;
}

/** Budget for the ONE wider look a low-confidence decision is allowed to take. */
const WIDER_ELEMENTS = WIDE_POOL_ELEMENTS;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** FNV-1a 32-bit：状态指纹只要**确定且廉价**的 hash，不需要密码学强度。 */
function fnv1aText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * S1 结构指纹：可动元素计数 + 角色/标签分布 hash（前进性判据只用它）。
 * 不读页面、只读已有池（零新增往返应）；分布排序后再 hash，抽池顺序变化不制造假前进。
 */
function structDigest(elems: ElemPool | null): string {
  if (elems === null) return "none";
  const tags: Record<string, number> = {};
  const roles: Record<string, number> = {};
  let n = 0;
  for (const e of Object.values(elems)) {
    n += 1;
    tags[e.tag] = (tags[e.tag] ?? 0) + 1;
    if (typeof e.role === "string" && e.role) roles[e.role] = (roles[e.role] ?? 0) + 1;
  }
  const norm = (o: Record<string, number>): string =>
    Object.keys(o).sort().map((k) => `${k}:${o[k]}`).join(",");
  return `${n}:${fnv1aText(`${norm(tags)}|${norm(roles)}`)}`;
}

/** S1 内容指纹（诊断用）：首批可动元素 label hash；空池/全空 label 时省略。 */
function contentDigest(elems: ElemPool | null): string | undefined {
  if (elems === null) return undefined;
  const labels = Object.values(elems).slice(0, 10)
    .map((e) => String(e.label ?? "").slice(0, 40))
    .filter((s) => s !== "");
  return labels.length === 0 ? undefined : fnv1aText(labels.join("\u0000"));
}

/**
 * Top-two margin of a decision distribution — C3-R's second abstention signal
 * (its decision model abstains when the top two options are too close, even if the
 * top probability is high). Recorded here as a DIAGNOSTIC only: the gate itself is
 * adopted only if measured to separate good picks from bad ones.
 */
function topTwoMargin(probs: Record<string, unknown> | undefined): number | null {
  const vs = Object.values(probs ?? {}).map(Number).filter((v) => Number.isFinite(v))
    .sort((a, b) => b - a);
  if (!vs.length) return null;
  return vs.length === 1 ? vs[0]! : vs[0]! - vs[1]!;
}

/** One line for a failed Playwright action, safe to put in a trace/report. */
function describeActionError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n")[0]!.trim().slice(0, 160);
}

function sigEq(a: Sig, b: Sig): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * Navigation envelope (P0-4).
 *
 * `hosts` used to be a LOAD-TIME fact only: type-checked in `app-pack.ts`, the input
 * of the leak gate — and never consulted at runtime, so any pack could navigate to
 * any host. With an allow-list given, a URL whose host is not declared is refused
 * BEFORE the page goes there (and a mid-journey redirect onto an undeclared host
 * stops the subgoal with a structured reason). An empty/absent list disables the
 * envelope: offline fixture packs declare no hosts and must keep working unchanged.
 *
 * Matching: exact host, or any SUBDOMAIN of a declared host. `file:`/`about:`/
 * `data:` carry no host and pass — the envelope guards the NETWORK, not the fixture.
 */
/** Frame URL 的 host gate：host 边界覆盖 frame，而不是只覆盖顶层导航。 */
/**
 * Popup / new tab 的 host gate：只看当前 page.url 会漏掉 `window.open()` 开出的新页。
 * 这里扫描同一 browser context 的所有 page；`pages` 在 Playwright 里是数组属性，替身可能给函数。
 */
export function deniedContextUrl(page: PageLike, hosts: string[] | null | undefined): string | null {
  if (!hosts || hosts.length === 0) return null;
  // Playwright 的 page.context 是方法；替身可能直接给对象。
  const contextValue = (page as unknown as { context?: unknown }).context;
  const context = (typeof contextValue === "function" ? contextValue.call(page) : contextValue) as
    | { pages?: ArrayLike<PageLike> | (() => ArrayLike<PageLike>) }
    | undefined;
  const rawPages = typeof context?.pages === "function" ? context.pages() : context?.pages;
  const pages = Array.from(rawPages ?? []);
  for (const p of pages) {
    const u = typeof p.url === "function" ? p.url() : p.url;
    if (typeof u !== "string" || !u.trim()) continue;
    if (disallowedHost(u, hosts) !== null) return u;
  }
  return null;
}

export function deniedFrameUrl(page: PageLike, hosts: string[] | null | undefined): string | null {
  if (!hosts || hosts.length === 0) return null;
  for (const frame of framesOf(page, 64)) {
    const u = typeof frame.url === "function" ? frame.url() : frame.url;
    if (typeof u !== "string" || !u.trim()) continue;
    const denied = disallowedHost(u, hosts);
    if (denied !== null) return u;
  }
  return null;
}

export function disallowedHost(url: string, hosts: string[] | null | undefined): string | null {
  if (!hosts || hosts.length === 0) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;                                      // unparseable: whatever the page does next, it is checked again post-action
  }
  if (["file:", "about:", "data:"].includes(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (!host) return null;
  const ok = hosts.some((h) => {
    const e = String(h).toLowerCase().replace(/^\.+/, "");
    return e !== "" && (host === e || host.endsWith(`.${e}`));
  });
  return ok ? null : host;
}

/** Element types whose current value is a SECRET: never written into a trace or report (P0-3, D5①). */
const SECRET_INPUT_TYPES = new Set(["password", "file", "hidden"]);

/** Mask a filled value when the target field is secret-typed; same length, no content. */
function redactValue(el: Elem, val: unknown): unknown {
  if (val === null || val === undefined) return val;
  const t = String(el["input_type"] ?? "").toLowerCase();
  if (!SECRET_INPUT_TYPES.has(t)) return val;
  const s = String(val);
  return `***(${s.length})`;
}

/**
 * W8：敏感槽位 fill 的 effect 掩码值。与 `app/redaction.ts` 的 `MASKED_SLOT` 同值
 * （顶层 slots 掩码、收尾 scrubSecrets 的替换值都用它）；engine 不反向依赖 app 层，
 * 字面量就地同值——改掩码形状时两处同步。
 */
const EFFECT_MASK = "***";

/**
 * W8：s 是否携带敏感值——精确全等不限长度；子串沿用收尾 `scrubSecrets` 的 ≥4 纪律
 * （`app/redaction.ts` 同口径，避免短串误伤普通内容）。这是**内容**判定：掩码只看
 * 读回/写入内容里是否真的出现敏感值，不看绑定的声明形态。
 */
function carriesSecret(s: string, secrets: Iterable<string>): boolean {
  if (s.length === 0) return false;
  for (const x of secrets) {
    if (s === x || (x.length >= 4 && s.includes(x))) return true;
  }
  return false;
}

function safeUrl(obj: unknown): string {
  try {
    return urlOf(obj as PageLike);
  } catch {
    return "";
  }
}

/**
 * A1 子改动③（逐步动作后内容签名，DOM diff 的最小形态）：池首候选文本。
 * 按提取写入序（= 观察序）取第一个带非空 label 的元素，截 ~60 字符；空池返回 null。
 * 只读内存里已有的池，不新增页面往返。
 */
function firstPoolText(pool: ElemPool): string | null {
  for (const e of Object.values(pool)) {
    const t = String(e.label ?? "").trim();
    if (t) return t.slice(0, 60);
  }
  return null;
}

/* ------------------------------------------------------------------ A2 判别（解析失败附池快照答案） */

/**
 * A2（12 轮真站实测的停因判别）：命令闭集解析失败（`target_not_found`）与决策层弃权
 * （`low_confidence`）这两类停因，报错区分不了「候选在池外（引擎/闭集问题）」和
 * 「目标在页面上根本不存在（产品事实）」——真站实验里产品 UI 本来就没有的排序项被
 * 9/11 轮误读成引擎池缺陷，直到专门写 DOM 探针取证才发现排序菜单只有
 * ["Relevance","Rating"]。下面判别全部是**纯内存计算**（池已在手），不新增页面往返；
 * 只往既有 reason 末尾追加一段短文本（一两句 + 最多 5 个候选名），停因码与前置文本不变。
 */

/** 候选的可检索文本：label + data_test + id + name + near——与 hintMatch 的匹配字段同族。 */
function candidateText(e: Elem): string {
  return [e.label, e["data_test"], e.id, e.name, e.near]
    .map((v) => String(v ?? "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
}

/** 词面里的"词"：按空白切、去标点（保留字母/数字/CJK）。 */
function lexWords(lexeme: string): string[] {
  return lexeme.toLowerCase().split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter((w) => w.length > 0);
}

/**
 * 词面匹配（不区分大小写的包含匹配）：完整词面被候选文本包含，**或**（多词目标）清洗后
 * 的全部词同时被包含。全词 AND 是刻意的：目标 "Price (lowest first)" 不能被一个恰好叫
 * "Price" 的筛选 chip 顶成"存在匹配"——那会把「目标不存在」误报成「闭集约束」，正好
 * 复刻本判别要消灭的误读方向。
 */
function lexMatchOne(lexeme: string, text: string): boolean {
  if (!text) return false;
  const lx = lexeme.toLowerCase().trim();
  if (lx && text.includes(lx)) return true;
  const ws = lexWords(lx);
  return ws.length > 1 && ws.every((w) => text.includes(w));
}

/** 一个候选在判别里的显示名：label 优先，退回 data_test/id，最后是 tag。 */
function candidateName(e: Elem, cap = 30): string {
  const label = String(e.label ?? "").trim().slice(0, cap);
  if (label) return label;
  const alt = String(e["data_test"] ?? e.id ?? "").trim().slice(0, cap);
  return alt || e.tag;
}

/**
 * T3：绑定失败时"该步可行动候选"的摘要（目标元素优先，其余按 op 能力面收，最多 3 条）。
 * 只拼诊断文本；不参与选择、不改变任何动作。
 */
function bindingCandidateSummaries(elems: ElemPool, targetRef: string, op: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (e: Elem | undefined): void => {
    if (e === undefined || out.length >= 3) return;
    const bits = [`${e.tag}${e.id ? `#${e.id}` : ""}`];
    if (e.name) bits.push(`name=${JSON.stringify(String(e.name).slice(0, 40))}`);
    if (e["data_test"]) bits.push(`data-test=${JSON.stringify(String(e["data_test"]).slice(0, 40))}`);
    if (e.label) bits.push(`label=${JSON.stringify(String(e.label).slice(0, 60))}`);
    const line = bits.join(" ");
    if (seen.has(line)) return;
    seen.add(line);
    out.push(line);
  };
  add(elems[targetRef]);
  const cap = op as ActionCapability;
  for (const [r, e] of Object.entries(elems)) {
    if (out.length >= 3) break;
    if (r === targetRef) continue;
    if (!actionCapabilities(e).includes(cap)) continue;
    add(e);
  }
  return out;
}

/**
 * 命令目标（hint 语法字符串）→ 词面判定器。`parseHint` 的六种形状各取其"名字"：
 * id/attr 值、near token、裸 token；tag 形状（button/link/…）没有专属词面，退化为对
 * 候选 tag 的相等匹配。返回 null = 拿不到稳健词面（空值/单字符）——调用方不编判别。
 */
function targetMatcher(target: string): ((e: Elem) => boolean) | null {
  const p = parseHint(target);
  const raw = (p.kind === "id" || p.kind === "attrSubstr" || p.kind === "attrEq"
    ? p.value
    : p.kind === "tag" ? p.tag : p.token).trim();
  if (lexWords(raw).join("").length < 2) return null;
  if (p.kind === "tag") return (e) => e.tag === p.tag;
  return (e) => lexMatchOne(raw, candidateText(e));
}

/** 全部动作族：判别拿不到目标族（决策步没有声明 op）时池摘要的兜底范围。 */
const ALL_FAMILIES: ReadonlySet<string> = new Set(["click", "fill", "select", "check", "upload"]);

/** 命令 op 的"同族 + 相邻族"动作面（相邻：click↔check 按压语义、fill↔select 选值语义）。 */
function cmdFamilies(op: string): ReadonlySet<string> {
  switch (String(op)) {
    case "click": return new Set(["click", "check"]);
    case "check": return new Set(["check", "click"]);
    case "fill": return new Set(["fill", "select"]);
    case "select": return new Set(["select", "fill"]);
    case "upload": return new Set(["upload"]);
    case "scroll":
    case "drag": return new Set(["click"]);
    default: return ALL_FAMILIES;
  }
}

/**
 * 池摘要（判别附言的 role 汇总）：只列与目标同/相邻动作族的候选——多成员组（menu/tab/
 * option 这类重复控件区，排障最想先看到的行）按组内数量升序排前，×1 孤儿角色垫底；
 * 泛化大组（button×31）由 5 个名字的预算自然截掉。名字截断到 5 个，超出以「其余略」收尾。
 */
function poolRoleSummary(pool: ElemPool, families: ReadonlySet<string>): string {
  const groups = new Map<string, string[]>();
  for (const e of Object.values(pool)) {
    if (!families.has(elemFamily(e))) continue;
    const name = String(e.label ?? "").trim().slice(0, 24);
    if (!name) continue;                       // 列不出名字的候选只进组计数，不占名名额
    const key = String(e.role ?? "").trim().toLowerCase() || e.tag;
    const arr = groups.get(key) ?? [];
    arr.push(name);
    groups.set(key, arr);
  }
  const rank = (n: number): number => (n === 1 ? Number.MAX_SAFE_INTEGER : n);
  const ordered = [...groups.entries()]
    .sort((a, b) => rank(a[1].length) - rank(b[1].length) || (a[0] < b[0] ? -1 : 1));
  if (!ordered.length) return "";
  const parts: string[] = [];
  let shown = 0;
  let cut = false;
  for (const [key, names] of ordered) {
    if (shown >= 5) { cut = true; break; }
    const take = names.slice(0, 5 - shown);
    parts.push(`${key}×${names.length}: ${take.join(", ")}`);
    shown += take.length;
    if (take.length < names.length) cut = true;
  }
  if (parts.length < ordered.length) cut = true;
  return parts.join("；") + (cut ? "；其余略" : "");
}

/**
 * A2 判别①（命令闭集解析失败，`target_not_found` 停因）：对每个未解析命令，用当时内存里
 * 已有的池回答「是目标不在页面上，还是闭集解析没把它放进命令空间」——
 *   无词面匹配 ⇒ `页面上不存在词面匹配「<目标>」的候选（池 N 项：<role 汇总>）——目标很可能不在本页面存在`
 *   有匹配未入空间 ⇒ `池中存在词面匹配「<目标>」的候选（如 "…"）但未入本次命令空间——属闭集解析约束，非目标缺失`
 * 纯内存、零页面往返；没有未解析命令、池为空、或都拿不到稳健词面时返回空串（reason 保持今天的文本）。
 */
export function cmdDiscrimination(
  cmdSpace: readonly CommandDecl[], unresolved: readonly string[], pool: ElemPool,
): string {
  if (Object.keys(pool).length === 0) return "";
  const cmds = cmdSpace.filter((c) => unresolved.includes(c.id))
    .map((c) => ({ id: c.id, op: String(c.op), target: String(c.target ?? "").trim() }))
    .filter((c) => c.target !== "");
  if (!cmds.length) return "";
  const segs: Array<{ id: string; text: string }> = [];
  let poolShown = false;                     // 多命令时池摘要只随第一个无匹配判别出现一次
  for (const c of cmds) {
    const match = targetMatcher(c.target);
    if (match === null) continue;            // 拿不到稳健词面：不编判别，只靠其他命令的段落
    const hits: string[] = [];
    for (const e of Object.values(pool)) {
      if (!match(e)) continue;
      hits.push(candidateName(e));
      if (hits.length >= 3) break;
    }
    if (hits.length) {
      segs.push({ id: c.id, text:
        `池中存在词面匹配「${c.target}」的候选（如 ${hits.map((h) => `"${h}"`).join("、")}）`
        + `但未入本次命令空间——属闭集解析约束，非目标缺失` });
    } else {
      const summary = poolShown ? "" : poolRoleSummary(pool, cmdFamilies(c.op));
      poolShown = true;
      segs.push({ id: c.id, text:
        `页面上不存在词面匹配「${c.target}」的候选（池 ${Object.keys(pool).length} 项`
        + `${summary ? `：${summary}` : ""}）——目标很可能不在本页面存在` });
    }
  }
  if (!segs.length) return "";
  return "。判别: "
    + segs.map((s) => (segs.length > 1 ? `命令 ${s.id}：${s.text}` : s.text)).join("；");
}

/**
 * 决策步 goal 里的**判别词面**：引号词（"…"、「…」等成对引号）优先——那是作者点名的
 * 目标词；没有引号就退回 goal 全文里的显著词（ASCII ≥3 且非停用/填充/角色词，CJK ≥2 字
 * 连续段，与规则层同一份词表纪律）。找不到稳健词面返回空表 ⇒ 判别降级为只报池摘要。
 */
export function goalLexemes(instruction: string): string[] {
  const out: string[] = [];
  for (const m of String(instruction ?? "").matchAll(/["“”「」『』]([^"“”「」『』]{2,})["“”「」『』]/g)) {
    const t = m[1]!.trim();
    if (t && lexWords(t).join("").length >= 2 && !out.includes(t)) out.push(t);
  }
  if (out.length) return out.slice(0, 3);
  const ins = String(instruction ?? "").toLowerCase();
  for (const w of ins.match(/[a-z0-9]{3,}/g) ?? []) {
    if (!STOP_TOKENS.has(w) && !FILLER_TOKENS.has(w) && !ROLE_TOKENS.has(w) && !out.includes(w)) out.push(w);
  }
  for (const seq of ins.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    if (!out.includes(seq)) out.push(seq);
  }
  return out.slice(0, 6);
}

/**
 * A2 判别②（决策层弃权，`low_confidence` 停因）：模型被咨询但分数不过闸门时，同样用池
 * 回答「是目标不在，还是候选在而模型没把握」。池中存在词面相关候选 ⇒ 明确说
 * 「候选存在但置信度低于闸门（闸门问题）」——这与「目标不存在」是不同问题；
 * 无词面 ⇒ 只报池摘要。纯内存、零页面往返。
 */
export function lowConfDiscrimination(instruction: string, pool: ElemPool, pickRef: string | null): string {
  const n = Object.keys(pool).length;
  if (n === 0) return "";
  const lexemes = goalLexemes(instruction);
  const pick = pickRef !== null ? pool[pickRef] : undefined;
  const families = pick !== undefined ? new Set([elemFamily(pick)]) : ALL_FAMILIES;
  const summary = poolRoleSummary(pool, families);
  if (!lexemes.length) return summary ? `。判别: 池 ${n} 项：${summary}` : "";
  const shown = lexemes.slice(0, 3).join("、");
  const hits: string[] = [];
  for (const e of Object.values(pool)) {
    const text = candidateText(e);
    if (lexemes.some((lx) => lexMatchOne(lx, text))) {
      hits.push(candidateName(e));
      if (hits.length >= 3) break;
    }
  }
  if (hits.length) {
    return `。判别: 池中存在与词面「${shown}」相关的候选（如 ${hits.map((h) => `"${h}"`).join("、")}）`
      + `但置信度低于闸门——候选存在但置信度低于闸门（闸门问题），非目标缺失`;
  }
  return `。判别: 池中不存在与词面「${shown}」相关的候选（池 ${n} 项`
    + `${summary ? `：${summary}` : ""}）——目标可能不在本页面（或未进元素池）`;
}

/**
 * Python's `input("CONFIRM ...")` default. There is no synchronous stdin prompt
 * in Node, and a risky action must never be silently approved — so the port
 * refuses unless the caller supplies `confirmFn`.
 */
const DEFAULT_CONFIRM = (desc: string): boolean => {
  console.warn(`  CONFIRM '${desc}'? [y/N] no confirmFn configured -> refusing`);
  return false;
};

/* ------------------------------------------------------------------ browser lifecycle */

/**
 * One playwright + one page for a whole plan (Python: `browser_session()`).
 *
 * The subgoals of a plan are ONE session, not N: reusing the page keeps cookies
 * and JS state alive across subgoals, avoids paying a cold browser launch per
 * subgoal, and lets a logged-in session survive into the next subgoal. `run()`
 * still navigates to each subgoal's own start_url, so isolation is unchanged.
 *
 * Python is a context manager yielding `(pw, page)`; Node returns a handle with
 * an explicit async `close()` (there is no `with` in TS). `run()` will not own
 * the browser when this page/pw pair is injected.
 */
/**
 * 可声明的**设备面**（应用包里的 `device` 块用它）。
 *
 * 为什么它必须能声明：有些站点是**只有手机版才存在**的——`touch.qunar.com` 的 H5 页在桌面 UA/视口下
 * DOM 都不一样，于是计划点名的城市 chip 在元素池里根本不存在，hint 落空、laya 也选不出来（实测：
 * 桌面上下文下第一个子目标三次尝试都 `low confidence 0.15`；同一份计划在 iPhone UA + 390×844 下
 * 一次命中）。把它写死在驱动里就等于把站点知识藏回代码，所以设备是**声明**。
 */
export interface DeviceSpec {
  user_agent?: string;
  viewport?: { width: number; height: number };
  is_mobile?: boolean;
  has_touch?: boolean;
  locale?: string;
  timezone?: string;
  device_scale_factor?: number;
}

export async function browserSession(headless = true, device?: DeviceSpec | null): Promise<BrowserSession> {
  const mod = await import("playwright");
  const pw: PwLike = { chromium: mod.chromium as unknown as PwLike["chromium"] };
  const browser = (await browserEnv.launch(pw, headless)) as unknown as BrowserHandle;
  let page: AnyPage;
  let context: AnyPage | null = null;
  try {
    if (device && Object.keys(device).length) {
      // 有设备声明就开一个带 UA/视口/触摸的上下文；没有就保持老的 `browser.newPage()` 路径，
      // 免得给所有既有应用引入一层新对象（它们的验收输出不该因为这次改动而变化）。
      const ctx = await (browser as unknown as {
        newContext(o?: Record<string, unknown>): Promise<{
          newPage(): Promise<AnyPage>; close(): Promise<void>;
        }>;
      }).newContext({
        ...(device.user_agent === undefined ? {} : { userAgent: device.user_agent }),
        ...(device.viewport === undefined ? {} : { viewport: device.viewport }),
        ...(device.is_mobile === undefined ? {} : { isMobile: device.is_mobile }),
        ...(device.has_touch === undefined ? {} : { hasTouch: device.has_touch }),
        ...(device.locale === undefined ? {} : { locale: device.locale }),
        ...(device.timezone === undefined ? {} : { timezoneId: device.timezone }),
        ...(device.device_scale_factor === undefined ? {} : { deviceScaleFactor: device.device_scale_factor }),
      });
      context = ctx as unknown as AnyPage;
      page = await ctx.newPage();
    } else {
      page = (await browser.newPage()) as AnyPage;
    }
  } catch (err) {
    await browser.close();
    throw err;
  }
  let closed = false;
  return {
    pw,
    browser,
    page,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (context) { try { await (context as unknown as { close(): Promise<void> }).close(); } catch { /* browser.close()下面兜底 */ } }
      await browser.close();
    },
  };
}

/**
 * How many laya checkpoints may stay resident.
 *
 * Two is laya's own recommendation (with one, a plan that alternates languages
 * re-loads the checkpoint on every switch), but an Agent is ~0.7-1.7 GB of
 * weights. Python probes `os.sysconf("SC_AVPHYS_PAGES")` (available physical
 * pages); the port uses `os.totalmem()`, which is the closest stable cross-
 * platform probe Node ships (there is no sysconf). Any failure falls back to the
 * safe 1.
 */
export function routerMaxLoaded(): number {
  try {
    const totalGb = os.totalmem() / 1e9;
    return totalGb >= 4.0 ? 2 : 1;
  } catch {
    return 1;
  }
}

/* ------------------------------------------------------------------ middleware */

export class BrowserMiddleware {
  /** Vocabulary of the rule layer, aliased for callers/tests (`rules.ts`). */
  static readonly STOP_TOKENS = STOP_TOKENS;
  static readonly ROLE_TOKENS = ROLE_TOKENS;
  static readonly FILLER_TOKENS = FILLER_TOKENS;
  static readonly NAV_VERBS = NAV_VERBS;
  /** Layered risk: high-stakes keywords caught deterministically, model covers the gray zone. */
  static readonly DESTRUCTIVE_PATTERNS: readonly string[] = DESTRUCTIVE_PATTERNS;

  modelId: string | DecisionAgent;
  agent: DecisionAgent | null = null;
  embedFn: unknown = null;
  routeModels: boolean;
  router: RouterLike | null;
  auditor: Auditor;
  maxSteps: number;
  confFloor: number;
  riskyThreshold: number;
  doneThreshold: number;
  confirmFn: (desc: string) => boolean | Promise<boolean>;
  manualConfirmFn: ((desc: string, stateExcerpt: string) => boolean | Promise<boolean>) | null = null;
  /** See MiddlewareOptions.actionDelayMs. */
  actionDelayMs = 0;
  reobserve = true;
  escalateFn: EscalatorLike | null = null;
  /** No runtime installed: rules/hints only. Set by `ready()` (see RULES-ONLY MODE). */
  rulesOnly = false;
  rulesOnlyReason = "";
  /** 在线 provider 掉线/没配好 ⇒ pick 抛错，本次降级到 rules-only 的原因（报告要单列，同 risk_degraded）。 */
  providerDegraded = "";
  /**
   * A CONFIG-class runtime failure (bad artifact path, unreadable weights): unlike
   * "no artifacts configured" (rules-only, legitimate) this is a usage error — the
   * loop refuses to act on it and `run()` stops with `stop_code: "config_error"`,
   * which the retry wrapper NEVER re-attempts (D6: a config error retried twice is
   * the same error, plus two sets of side effects).
   */
  configError: string | null = null;
  outcomeMemory: OutcomeMemoryLike | null = null;
  outcomeMemoryMode: "forbid" | "rank" = "forbid";
  hintMemory: HintMemoryLike | null = null;
  gotoTimeout: number;
  /** Navigation envelope default for runs that do not pass `hosts` (see `RunOptions.hosts`). */
  hosts: string[] | null = null;
  /** See MiddlewareOptions.dataset (constructor-level default for RunOptions.dataset). */
  dataset: DatasetReader | null = null;
  /** See `RunOptions.tieredHint` (P1 narrowed question; default OFF = today's behaviour). */
  tieredHint = false;
  /** U3：池空判档（缺省 fact；strict = U3 之前的 page_not_ready 快败）。 */
  poolGate: "fact" | "strict" = "fact";
  /** U3：surface 类目策略（缺省 native_activation="window"）。 */
  surfacePolicy: SurfacePolicy = { native_activation: "window" };
  /** See `MiddlewareOptions.candidatePriority`（A2 分桶窗口；缺省 bucketed）。 */
  candidatePriority: "bucketed" | "main-first" = "bucketed";
  /** S1：pre-held done 处置（缺省 warn；fail 在动作前结构化停止）。 */
  donePreheldPolicy: "warn" | "fail" | "allow" = "warn";
  /** S1：fill 后读回（缺省 true）。 */
  fillReadback = true;
  /** W8：敏感槽位键名单（见 `MiddlewareOptions.secretSlotKeys`；缺省空 = 无敏感槽位）。 */
  secretSlotKeys: ReadonlySet<string> = new Set<string>();
  /**
   * W8：本实例 fill 命中过的敏感槽位**值**（跨步/跨 run 累计，不随 `run()` 重置）。
   * 为什么不随 run 重置：一次 `ctx.step` = 一次 `run()`，而残留泄漏恰恰**跨步**——
   * 后续步在同一输入上 fill 别的值时，effect.before 的读回仍含早前填进去的秘密，
   * 那时当次袋里可能已看不到该值（步级 slots 只对那一步可见）。实例寿命 ≈ 一次
   * 应用运行（app-runner 每次运行新建执行器）；跨实例不共享。
   */
  private _secretValuesSeen = new Set<string>();
  /**
   * S2：抽池前的稳定门（null = off）。缺省开启（方案 §2.5）；应用层按 meta.policy.settle 覆盖。
   * 只在"页面在动"时等待——已静默立即返回 0ms。
   */
  settlePolicy: { quietMs: number; timeoutMs: number } | null = { ...DEFAULT_SETTLE };
  /** 本次 run 累计的静默等待（毫秒）；写进 `StepStateRecord.settleMs`。 */
  private _settleWaitMs = 0;
  /**
   * S1 状态游标（运行期私产，每次 `run()` 重置）：epoch/navEpoch/当前指纹。
   * 只读投影给 `ctx.runtime.epoch`；观察来源永远只有执行器（不自建第二份）。
   */
  private _state: { epoch: number; navEpoch: number; current: StateFingerprint | null } =
    { epoch: 0, navEpoch: 0, current: null };
  /** 上一条 `not-actionable-or-covered` 的结构化现场（只在同一次调用内消费）。 */
  private _lastActionabilityDetail: ActionabilityDetail | null = null;

  /* -- S5 decision-state ---------------------------------------------------- */

  /** S5：状态接入决策的开关（缺省两项 off；见 `MiddlewareOptions.decisionState`）。 */
  decisionState: DecisionStatePolicy = { ...DEFAULT_DECISION_STATE };
  /**
   * S5 指标（**实例级累计**）：一个 flow 应用会对同一 mw 跑多个 `ctx.step`，应用产物的
   * `decisions` 要的是整次旅程的数，所以计数**不随 run() 重置**。每个应用一次新 mw。
   */
  private _decisionMetrics: DecisionStateMetrics =
    { asks_saved: 0, gate_waits: 0, context_sent: 0, context_skipped: 0 };
  /**
   * S5a：上一次真 ask 的题面指纹与导航代（每次 run() 重置——refs/导航代都是 run 内口径）。
   * 只服务 S5b 的 `state_digest`（`nav_epoch_delta` / `pool_changed` 的基线）；"不重复问"的
   * 复用账在 `_askedPools`（按池结构指纹）。
   */
  private _lastAsk: {
    key: string;
    poolSig: string;
    navEpoch: number;
    result: { ref: string | null; conf: number; probs: Record<string, number>; passthrough: boolean };
  } | null = null;
  /**
   * S5a 第二档（池**结构**指纹）：同一个页面上同一个 goal 的重复咨询是噪声。
   * 键 = `structDigest(ask 池)`（与 S1 的 `StateFingerprint.struct` 同一算法/零页面往返），
   * 值 = 该结构下**最近一次真 ask** 的 goal 指纹与答复。命中时**不发请求**：
   *   ① 题面一字不差（key 相同）⇒ 直接复用答复；
   *   ② 结构相同、goal 相同、且上一次的选择**此刻仍可行动**（在池里且未 forbidden）⇒ 复用答复。
   * 两者的答复都继续走既有的 floor/reobserve/escalate 裁决——这就是"既有降级路径"。
   * 不能安全复用（上一次的选择已被禁/已不在池里）时**照常问**：拿一个过时答复去动作
   * 比多问一次更糟，引擎不替模型编答案。
   */
  private _askedPools = new Map<string, {
    key: string;
    goalKey: string;
    result: { ref: string | null; conf: number; probs: Record<string, number>; passthrough: boolean };
  }>();
  /** S5b：本次 run 到目前为止出现过的 S1 flags（摘要里只放已经发生的事实）。 */
  private _runFlags: StateFlag[] = [];
  /** S5b：最近一次 effect 读回（只留 kind/applied，值本身不进摘要）。 */
  private _lastEffectSeen: { kind: StateEffect["kind"]; applied: boolean } | null = null;
  /**
   * U8：被置信闸门拒绝的 ask conf 账（R8 J3 幸存者偏差的补观测）。记的是**模型意见在
   * floor 处被丢弃**的 ask：主闸门 `conf < floor` 且未被 priorHit 复驾、意见最终也没被
   * adjudicate 复用的那部分，含 reobserve 宽看重问仍不过闸的弃选（主闸门分支内记账；
   * R2b 词面宽扫是词面触发的复核重问、非 conf 闸门事件，不在此账）。计数位置只有
   * 执行器的闸门分支，不在报告层重算——与 `model_asks`（ask 发生数）同一口径来源。
   */
  private readonly _rejectedAskConfs: number[] = [];

  /** S5：指标快照（应用产物 `decisions` 的唯一来源；默认档全 0）。 */
  decisionStateMetrics(): DecisionStateMetrics {
    return { ...this._decisionMetrics };
  }

  /**
   * U8：被拒 ask 的 conf 分布（应用产物 `decisions.rejected_conf` 的唯一来源）。
   * n=0 ⇒ null——产物字段缺席（缺省等价纪律）；n>0 ⇒ {n, min, max}，与既有 `conf`
   * 聚合（过关模型步的 trace 分布）并存、口径互补。
   */
  rejectedAskConfMetrics(): { n: number; min: number | null; max: number | null } | null {
    const xs = this._rejectedAskConfs;
    if (xs.length === 0) return null;
    return { n: xs.length, min: Math.min(...xs), max: Math.max(...xs) };
  }

  /**
   * S5a：ask 前的稳定门。`policy.settle: "off"` 时闸门不等待（只做同池去重）；
   * 页面已静默时 0ms 返回，不改变既有节奏。超时/传感器失败按 `null`（不阻断继续问）。
   * 只有**真的等了**（waitedMs > 0）才计 `gate_waits`——0ms 检查不是"等待"。
   */
  private async _gateSettle(page: AnyPage): Promise<boolean | null> {
    if (this.settlePolicy === null) return null;
    try {
      const r = await settle(page as unknown as SettlePage, this.settlePolicy);
      if (r.waitedMs > 0) this._decisionMetrics.gate_waits += 1;
      return r.settled;
    } catch {
      return null;      // 稳定门是观察增强：失败不阻断（与 S2 同一条纪律）
    }
  }

  /**
   * S5a 的题面指纹：**这一次 ask 实际会给出的候选集合**（ref + 元素签名，排序后 hash）
   * + goal。它回答"是不是同一个问题"（一字不差 ⇒ 可直接复用答复）；候选集合变了但池
   * 结构没变时，由 `_askedPools` 的第二条判据（上次选择仍可行动）决定能不能复用。
   */
  private _askSignature(goal: string, elems: ElemPool, forbidden: Set<string>):
    { key: string; poolSig: string } {
    const refs = Object.keys(elems).filter((r) => !forbidden.has(r) && elems[r] !== undefined).sort();
    const parts = refs.map((r) => `${r}\u0001${esig(elems[r]!).join("\u0001")}`);
    const poolSig = fnv1aText(parts.join("\u0002"));
    return { key: `${fnv1aText(goal)}\u0000${poolSig}`, poolSig };
  }

  /**
   * S5b：构造 ≤200B 的结构化 `state_digest`（只观测事实）。
   * 裁剪顺序固定：`flags` → `last_effect`（字段全可丢，base 三键 ~60B 永不超）；
   * 绝不截断 JSON（半个对象对模型是噪声，不是事实）。没有可说的就返回 null。
   */
  private _buildStateDigest(input: {
    settled: boolean | null;
    poolChanged: boolean;
  }): StateDigest | null {
    const base: StateDigest = {
      nav_epoch_delta: Math.max(0, this._state.navEpoch - (this._lastAsk?.navEpoch ?? 0)),
      settled: input.settled === true,
      pool_changed: input.poolChanged,
    };
    const withLast: StateDigest = this._lastEffectSeen === null
      ? { ...base }
      : { nav_epoch_delta: base.nav_epoch_delta, last_effect: { ...this._lastEffectSeen },
          settled: base.settled, pool_changed: base.pool_changed };
    const withFlags: StateDigest = this._runFlags.length === 0
      ? withLast
      : { ...withLast, flags: [...this._runFlags] };
    const bytes = (d: StateDigest): number => Buffer.byteLength(JSON.stringify(d), "utf8");
    for (const candidate of [withFlags, withLast, base] as StateDigest[]) {
      if (bytes(candidate) <= STATE_DIGEST_MAX_BYTES) return candidate;
    }
    return null;
  }

  /**
   * S5b：不带等待地探测页面是否已静默（`timeoutMs: 0`：只读一次传感器，不睡）。
   * gate 关闭而 context 开启时用；`policy.settle: "off"` 时用缺省 quietMs 口径。
   */
  private async _probeSettled(page: AnyPage): Promise<boolean | null> {
    try {
      const r = await settle(page as unknown as SettlePage, {
        quietMs: this.settlePolicy?.quietMs ?? DEFAULT_SETTLE.quietMs,
        timeoutMs: 0,
      });
      return r.settled;
    } catch {
      return null;
    }
  }

  /** `ctx.runtime.epoch` 的只读投影：还没有观察过就是 0（不硬造）。 */
  stateEpoch(): number {
    return this._state.current?.epoch ?? 0;
  }
  /**
   * S2：抽池前等页面静默（按 `settlePolicy`）。已静默立即返回；超时不抛、不阻断抽取。
   * 等待毫秒数累计到本 run 的 `StepStateRecord.settleMs`。
   */
  private async _settleBeforeExtract(page: AnyPage, deadlineMs?: number): Promise<SettleResult | null> {
    if (this.settlePolicy === null) return null;
    // C8：闸门预算真上限——每轮 settle 的 timeout 钳到剩余预算（缺省无 deadline = 旧行为）。
    const policy = deadlineMs === undefined
      ? this.settlePolicy
      : { ...this.settlePolicy, timeoutMs: Math.max(0, Math.min(this.settlePolicy.timeoutMs, deadlineMs - Date.now())) };
    try {
      const r = await settle(page as unknown as SettlePage, policy);
      this._settleWaitMs += r.waitedMs;
      // C7：把 settled/timedOut 接回调用方（以前只累计 waitedMs，结论被丢掉）。
      return r;
    } catch {
      // 稳定门是观察增强：传感器坏了也照常抽池（页面自会给出 target_not_found 等诚实停因）。
      return null;
    }
  }
  /** S2：settle + 默认池抽取（决策/act 解析、pool ready、收尾观察共用同一序）。 */
  private async _extractPoolSettled(
    page: AnyPage, candidatePriority: "bucketed" | "main-first", deadlineMs?: number,
  ): Promise<{ elems: ElemPool; settle: SettleResult | null }> {
    const settleRes = await this._settleBeforeExtract(page, deadlineMs);
    const elems = await extractElements(page, true, undefined, {
      candidatePriority, surface: this.surfacePolicy,
    });
    return { elems, settle: settleRes };
  }
  /**
   * U3 判档（唯一出处 = ARCH §5.3 判档表）：只在**池空**且预算耗尽时调用一次。
   * 判据只用已有观测（settle 结论）+ 一次只读 sniff（readyState/准入面计数），
   * 不新增"猜测式"往返；`not_ready` 才是 run 级判死，`ready_empty` 是步级事实。
   */
  private async _poolReadiness(
    page: AnyPage, settleRes: SettleResult | null, waitedMs: number, budgetMs: number, poolSize: number,
  ): Promise<Readiness> {
    // sniff 用**本 run 生效的**准入面（off 臂不能拿默认 window 面的计数当证据）。
    const sniff = await poolSniff(page, admitSelectorWithJsFor(this.surfacePolicy));
    const rs = sniff.ready_state === "loading" || sniff.ready_state === "interactive" || sniff.ready_state === "complete"
      ? sniff.ready_state : "unknown";
    const verdict: ReadinessVerdict =
      (settleRes === null || settleRes.settled !== true || rs !== "complete") ? "not_ready" : "ready_empty";
    return {
      verdict,
      evidence: {
        ready_state: rs,
        settled: settleRes === null ? null : settleRes.settled,
        settle_timed_out: settleRes?.timedOut === true,
        pool_size: poolSize,
        waited_ms: waitedMs,
        budget_ms: budgetMs,
        sniff: {
          admitted: sniff.admitted, focusable: sniff.focusable, aria: sniff.aria,
          frames: sniff.frames, body_text: sniff.body_text,
        },
      },
    };
  }
  /** See `MiddlewareOptions.maxEffectiveRepeats` (D3/R-4; default 3, 0 disables). */
  maxEffectiveRepeats = 3;
  /** 见 MiddlewareOptions.riskAsk。 */
  riskAsk: "always" | "rules-only" = "always";
  /**
   * 本次运行实际用的决策提供者（`ready()` 里解析；null = 没有决策层，走 rules-only）。
   * 换模型是配置不是改代码：见 src/model/decision-provider.ts 的头注释。
   */
  decision: DecisionProvider | null = null;
  /**
   * 风险头调用失败的原因（null = 没失败过）。报告与线上套件要把它显式说出来：
   * 一次"退化成关键词判定"的运行和一次正常运行**不是同一件事**，不许混在同一个绿色里。
   */
  riskDegraded: string | null = null;
  /** Deterministic rule prefilter ON, anti-repeat ON (measured production defaults). */
  rulesOn = true;
  antiRepeat = true;
  /** Frozen-plan disambiguation, set per run() from the plan's target_hint. */
  targetHint: string | null = null;
  /** current (url, subgoal) key for the learned-hint memory */
  _hintKey = "";
  /** did the step's decision come from a LEARNED hint? (for the stats) */
  _learnedHintApplied = false;
  /** Ordered hints: each is authoritative for ONE action, then the next takes over. */
  targetHints: string[] = [];
  _hintI = 0;
  /**
   * A4 引用唯一性冲突诊断（`_locatorFor` 写入，动作落 trace 时取走）。
   *
   * 提取前清旧章 + 批次 nonce 已在源头挡住「旧章残留」；这里接住**仍然多命中**的情况
   *（页面复制节点、第三方脚本写同名属性）：多命中不得返回 locator（Playwright strict
   * mode 会报错，`count()` 取首个又会点错元素），回退后把匹配计数与回退结果记成诊断——
   * 否则「点错元素」只会表现为页面没反应，作者无从判断病因。
   */
  _refCollisions: string[] = [];
  /**
   * A2：决策服务候选上限命中原因（null = 没命中）。`pickInner` 只记录、不抛/不猜，
   * 调用方在停因分支把它变成结构化 `decision_service_choice_limit`。
   */
  _choiceLimitReason: string | null = null;
  lastRouting: Record<string, unknown> | null = null;
  _routedModel: string | null = null;
  private _ready = false;

  constructor(opts: MiddlewareOptions = {}) {
    this.modelId = opts.modelId ?? "convaiinnovations/laya";
    if (typeof this.modelId !== "string") this.agent = this.modelId;
    this.routeModels = Boolean(opts.routeModels);
    this.router = opts.router ?? null;
    this.auditor = opts.auditor ?? getAuditor();
    this.maxSteps = opts.maxSteps ?? 8;
    this.confFloor = opts.confFloor ?? 0.25;
    this.riskyThreshold = opts.riskyThreshold ?? 0.6;
    this.doneThreshold = opts.doneThreshold ?? 0.5;
    this.confirmFn = opts.confirmFn ?? DEFAULT_CONFIRM;
    this.manualConfirmFn = opts.manualConfirmFn ?? null;
    this.actionDelayMs = opts.actionDelayMs ?? 0;
    this.reobserve = opts.reobserve ?? true;
    this.escalateFn = opts.escalateFn ?? null;
    this.outcomeMemory = opts.outcomeMemory ?? null;
    this.outcomeMemoryMode = opts.outcomeMemoryMode ?? "forbid";
    this.hintMemory = opts.hintMemory ?? null;
    this.gotoTimeout = opts.gotoTimeout ?? 30000;
    this.hosts = opts.hosts ?? null;
    this.dataset = opts.dataset ?? null;
    this.maxEffectiveRepeats = opts.maxEffectiveRepeats ?? this.maxEffectiveRepeats;
    this.riskAsk = opts.riskAsk ?? this.riskAsk;
    this.tieredHint = opts.tieredHint ?? this.tieredHint;
    this.candidatePriority = opts.candidatePriority ?? this.candidatePriority;
    this.poolGate = opts.poolGate === "strict" ? "strict" : "fact";
    if (opts.surfacePolicy !== undefined) this.surfacePolicy = { ...opts.surfacePolicy };
    this.donePreheldPolicy = opts.donePreheldPolicy ?? this.donePreheldPolicy;
    this.fillReadback = opts.fillReadback ?? this.fillReadback;
    this.secretSlotKeys = opts.secretSlotKeys ?? this.secretSlotKeys;
    if (opts.settle !== undefined) this.settlePolicy = opts.settle;
    if (opts.decisionState !== undefined) {
      // 只认已声明的两个值（策略面已在加载期校验；这里再兜一层，避免嵌入方传入脏值）。
      this.decisionState = {
        gate: opts.decisionState.gate === "stable_only" ? "stable_only" : "off",
        context: opts.decisionState.context === "delta" ? "delta" : "off",
      };
    }
  }

  /**
   * Build the resident checkpoint + the optional router ONCE (PORT NOTE 4 —
   * Python does this in `__init__`, which cannot await). Idempotent.
   */
  private async ready(): Promise<void> {
    if (this._ready) return;
    // **决策提供者层的入口**：
    //   ① 显式装了 provider（换模型测试走这条）⇒ 直接用它，不要求 laya runtime 存在；
    //   ② 否则走旧门：装了 `LayaRuntime` 就就地包一层适配器 ⇒ 行为与今天逐字段相同
    //      （等价由 历史回归 钉住，不是"看着一样"）；
    //   ③ 两者都没有 ⇒ rules-only（下面那段既有逻辑，一个字没改）。
    const explicit = decisionProviderOrNull();
    if (explicit) {
      this.decision = explicit;
      this._ready = true;
      return;
    }
    let rt: LayaRuntime;
    try {
      rt = getLayaRuntime();
    } catch (err) {
      if (!(err instanceof LayaNotConfiguredError)) throw err;
      // RULES-ONLY MODE. A frozen plan that NAMES its targets needs no model at all, so an
      // unconfigured runtime must not abort the whole run: the steps that rules/hints can
      // decide are executed, and a step that genuinely needs a pick blocks with this reason.
      // (Measured need: `npm start` on a fresh checkout has no ONNX artifacts and blocked
      //  immediately, which also made the doctor's "规则模式也能跑" claim false.)
      this.rulesOnly = true;
      this.rulesOnlyReason = (err as Error).message;
      this._ready = true;
      return;
    }
    if (this.agent === null) {
      try {
        this.agent = typeof this.modelId === "string" ? await rt.load(this.modelId) : this.modelId;
      } catch (e) {
        // CONFIG error (bad artifact path etc.): rules cannot stand in for a model
        // the operator explicitly pointed at — refuse to act, and say so once.
        this.configError = e instanceof Error ? e.message : String(e);
        this._ready = true;
        return;
      }
    }
    this.embedFn = rt.embedFnFromAgent(this.agent);
    if (this.routeModels) {
      if (this.router === null) {
        this.router = rt.createRouter ? rt.createRouter({ maxLoaded: routerMaxLoaded() }) : null;
      }
      // The default checkpoint was just built: hand THAT agent to the router
      // instead of letting it build a second copy (Router.attach exists for
      // exactly this). Without it a 3 GB box would hold two.
      try {
        if (this.router) {
          if (this.router.attach && this.router.default && this.agent) {
            this.router.attach(this.router.default, this.agent);
          }
          this._routedModel = this.router.default ?? null;
        }
      } catch {
        /* routing is an optimization, not a dependency */
      }
    }
    this.decision = layaProvider({
      runtime: rt,
      agentFor: (st) => this.agentFor(st),
      name: `laya-onnx`, version: this.modelId === undefined ? "default" : String(this.modelId),
      capabilities: { choice: true, risk: true, done: true, shortlist: true, score_kind: "entropy_conf" },
    });
    this._ready = true;
  }

  /* -- hybrid picking: deterministic affordance rule + laya fallback -------- */

  /**
   * The hint that is authoritative for the NEXT action (see target_hints).
   * `getattr` in Python guards `__new__`-built instances; the TS port only has
   * to guard an empty list.
   */
  currentHint(): string | null {
    const hints = this.targetHints;
    if (hints && hints.length) return hints[Math.min(this._hintI, hints.length - 1)] ?? null;
    if (this.targetHint) return this.targetHint;
    // No authored hint for this step: a LEARNED one (observed success on this exact
    // url + subgoal) takes the same authority. The hint grammar is unchanged, so a
    // learned hint that matches nothing or is ambiguous still falls back to the model.
    if (this.hintMemory && this._hintKey) {
      const learned = this.hintMemory.lookup(this._hintKey);
      if (learned) {
        this._learnedHintApplied = true;
        return learned;
      }
    }
    return null;
  }

  /** Called once the current hint's action has done its job (or died). */
  _advanceHint(): void {
    const hints = this.targetHints;
    if (hints && hints.length && this._hintI < hints.length - 1) this._hintI += 1;
  }

  /**
   * (agent, embedFn) to answer questions about THIS page state.
   *
   * With routing off this is just the resident checkpoint. With routing on,
   * `Router.route` (microseconds, no forward pass) decides by detected
   * script/language and the resident checkpoint is swapped when it differs.
   * `Router.load` builds the new Agent BEFORE evicting the LRU victim, so on a
   * small-RAM box free the current one first — never pin two checkpoints. Any
   * router hiccup degrades to the resident agent: routing is an optimization,
   * not a dependency.
   */
  async agentFor(state: ModelState): Promise<{ agent: DecisionAgent; embedFn: unknown }> {
    await this.ready();
    if (!this.routeModels || this.router === null) return { agent: this.agent!, embedFn: this.embedFn };
    let decision: Record<string, unknown>;
    try {
      decision = { ...(await this.router.route(state)) };
    } catch {
      return { agent: this.agent!, embedFn: this.embedFn };
    }
    if (decision["model"] !== this._routedModel) {
      const prevAgent = this.agent;
      const prevEmbed = this.embedFn;
      try {
        const loaded = this.router.loaded;
        const loadedList = loaded instanceof Set ? [...loaded] : (loaded ?? []);
        const model = String(decision["model"]);
        if (loadedList.length && !loadedList.includes(model)) {
          // Drop OUR reference too, not just the router's: the old Agent is
          // ~0.7-1.7 GB and would otherwise stay alive while the new one is
          // built (the co-residency window is what OOMs a small box).
          this.agent = null;
          this.embedFn = null;
          await this.router.unload();
          (globalThis as { gc?: () => void }).gc?.();
        }
        const agent = await this.router.load(model);
        const embedFn = getLayaRuntime().embedFnFromAgent(agent);
        this.agent = agent;
        this.embedFn = embedFn;
        this._routedModel = model;
        this.lastRouting = decision;
        console.log(`  [router] checkpoint -> ${model} (${String(decision["reason"] ?? "").slice(0, 58)})`);
      } catch {
        this.agent = prevAgent;
        this.embedFn = prevEmbed;
        return { agent: this.agent!, embedFn: this.embedFn };   // routing is an optimization
      }
    }
    return { agent: this.agent!, embedFn: this.embedFn };
  }

  /* -- laya calls (each one forward pass) ---------------------------------- */

  /**
   * 一次"选元素"的**完整提案**。
   *
   * 为什么要结构而不是一个 float：`conf` 今天承载**两个不可比的量**——
   * passthrough（池 ≤ k）是 `1 − 归一化熵`，shortlist（池 > k）是**子集上的 max(probs)**。
   * 实测两者方向相反（AUC 0.233 反向 vs 0.587），拿同一个 floor 比它们是把两把尺子叠在一起。
   * 这里把"问法形状"变成接口的一部分：**闸门要按 shape 分档读，不能跨 shape 比标量**。
   *
   * `entropyConf` 保留但降级为诊断字段（它就是今天的 `conf` 在 passthrough 那一支的含义）；
   * `pTop1/pTop2/margin` 是与选项数无关的信号，W4/R4 的标定要用它们。
   */
  async pickProposal(
    goal: string,
    page: AnyPage,
    elems: ElemPool,
    forbidden: Set<string>,
    notes: Record<string, string> | null = null,
  ): Promise<PickProposal> {
    const picked = await this.pickInner(goal, page, elems, forbidden, notes);
    const values = Object.values(picked.probs).sort((a, b) => b - a);
    const poolSize = Object.keys(elems).length;
    // 形状用**权威信号**（predictShortlist 的 passthrough 标志），不是从概率条数反推——
    // 有些运行时只回一条概率，反推会把 passthrough 误判成 shortlist（本轮测试踩过）。
    const kind: PickProposal["shape"]["kind"] =
      picked.ref === null ? "none" : picked.passthrough ? "full" : "shortlist";
    return {
      choiceRef: picked.ref ?? null,
      shape: { kind, k: 8, poolSize, options: values.length },
      pTop1: values[0] ?? null,
      pTop2: values[1] ?? null,
      margin: values.length >= 2 ? values[0]! - values[1]! : (values[0] ?? null),
      entropyConf: picked.conf,
      probs: picked.probs,
    };
  }

  /**
   * 决策票在 trace `method` 里的显示名：provider 自报其名（decision-service / 基线名…）。
   * legacy runtime 被包装时的名字（`laya(legacy-runtime)`）归一化为 `laya`——本地 laya 档
   * 的 method 串保持逐字节不变；换任何别的 provider，标签就是那个 provider 的真名。
   */
  private modelLabel(): string {
    const n = this.decision?.name ?? "laya";
    return n === "laya(legacy-runtime)" ? "laya" : n;
  }

  /**
   * A3（决策源对齐与失败透传）：pick 抛错降级过 ⇒ 把真实原因（HTTP 状态码 + 服务错误关键句）
   * 编进 `no_model_runtime` 的停因。降级不该把基础设施事实吞掉——「rules-only 没模型」与
   * 「配了决策源但它 403 了」是两件事，停因必须分得清。空串 = 本次 rules-only 是
   * 「本来就没装模型」（LayaNotConfiguredError 路径），后缀缺席，输出逐字节不变。
   */
  private degradedReasonSuffix(): string {
    const d = this.providerDegraded.trim();
    return d === "" ? "" : `（决策源不可用：${d.slice(0, 240)}）`;
  }

  /**
   * 一次提问的全部事实：选了什么、conf 怎么来的（passthrough 与否决定它的含义）、原始概率。
   * `pickElement` 是它的三元组视图（保持既有调用点与 trace 口径不变），`pickProposal` 是带形状的视图。
   */
  private async pickInner(
    goal: string,
    page: AnyPage,
    elems: ElemPool,
    forbidden: Set<string>,
    notes: Record<string, string> | null,
  ): Promise<{ ref: string | null; conf: number; probs: Record<string, number>; passthrough: boolean }> {
    // `pickElement`/`pickProposal` 也允许被**单独调用**（测试与外部嵌入方就这么用），而 provider
    // 是在 ready() 里解析的：不先 ready 就会拿着 null 当成"没得选"。ready() 幂等，
    // run() 那条路早已 await 过，这里不会重复加载权重。
    await this.ready();
    if (this.rulesOnly) {
      // no model to ask: the caller reports "needs a model pick" instead of a crash
      return { ref: null, conf: 0.0, probs: {}, passthrough: true };
    }
    const provider = this.decision;
    if (!provider) {
      return { ref: null, conf: 0.0, probs: {}, passthrough: true };
    }
    // A2：决策服务把候选清单当选项列表，服务侧上限 255——超限不是"窗口开大一点"能解决的，
    // 必须结构化停因（收窄 hint / 用分桶优先级），不能把 200+ 选项硬塞过去。
    const candidateCount = Object.keys(elems).filter((r) => !forbidden.has(r)).length;
    if (candidateCount > MAX_CHOICES) {
      this._choiceLimitReason =
        `candidate window ${candidateCount} > MAX_CHOICES (${MAX_CHOICES}) — the decision service takes at most `
        + `255 choices; narrow the hint or rely on bucket priority (chrome/viewport first) instead of widening the pool`;
      return { ref: null, conf: 0.0, probs: {}, passthrough: true };
    }
    // 视图构造、state 渲染、短名单重问、两支各自的 conf 口径——**全部在适配器里**，
    // 且与替换前的实现逐字段等价（历史回归 ①）。
    //
    // ── S5 状态接入（默认两项 off ⇒ 下面整段短路，决策路径逐字节不变）───────────────
    // 判据「规则层仍歧义」不需要再问一遍：pickInner 是**规则层没解出 ref**（ruleRef 为
    // null / 被 forbidden）之后唯一的模型入口（调用点见 pickElement 的三处），走到这里
    // 就说明规则层给不出目标。
    const askSig = this._askSignature(goal, elems, forbidden);
    const goalKey = fnv1aText(goal);
    const poolStruct = structDigest(elems);
    let settledNow: boolean | null = null;
    if (this.decisionState.gate === "stable_only") {
      // ① 页面在动 ⇒ 先等到静默（走 policy.settle 参数；超时不阻断，照旧问）。
      settledNow = await this._gateSettle(page);
      // ② 池指纹未变 + 规则层仍歧义 ⇒ 不重复敲门，复用该池结构下的上一次答复：
      //    题面一字不差（key 相同）直接复用；仅结构相同则要求上一次的选择此刻仍可行动
      //    （在池里且未 forbidden），否则这次答复已经过时——照常问，不拿死答案去动作。
      const prior = this._askedPools.get(poolStruct);
      if (prior !== undefined && prior.goalKey === goalKey) {
        const stillActionable = prior.result.ref !== null
          && elems[prior.result.ref] !== undefined && !forbidden.has(prior.result.ref);
        if (prior.key === askSig.key || stillActionable) {
          this._decisionMetrics.asks_saved += 1;
          // 复用的答复继续走既有 floor/reobserve/escalate 裁决（就是"既有降级路径"）。
          return { ...prior.result, probs: { ...prior.result.probs } };
        }
      }
    }
    let digest: StateDigest | null = null;
    if (this.decisionState.context === "delta" && this.decision !== null) {
      if (settledNow === null) settledNow = await this._probeSettled(page);
      digest = this._buildStateDigest({
        settled: settledNow,
        poolChanged: this._lastAsk === null ? true : this._lastAsk.poolSig !== askSig.poolSig,
      });
      if (digest !== null) {
        if (this.decision.capabilities.state_digest === true) this._decisionMetrics.context_sent += 1;
        else {
          // provider 的输入 schema 固定（本地 laya-onnx / OpenAI Decisions 等）：**跳过整段上文**，
          // 不塞进自然语言、不改协议；只记账（context_skipped），决策请求与默认档逐字节相同。
          this._decisionMetrics.context_skipped += 1;
          digest = null;
        }
      }
    }
    // **在线 provider 掉线/没配好 ⇒ 优雅降级到 rules-only**（与"本地模型不在位"同一条路）：
    // 缺 key/缺端点/网络不可达时，不该把整条计划崩掉，也不该每步再敲一次坏服务——
    // 声明点名的步照跑，需要选目标的步按 rules-only 如实 block。这是"默认在线 provider"
    // 不破坏开箱（无 key 也能跑声明）的地基。风险头那边早就这么降级（isRisky 的 catch）；
    // pick 这边补齐，两条兜底档对"服务不可用"的反应一致。
    // U3 硬约束：`Elem.surface` 是旁路标记（PoolView/inspect/类目计数用），**不进模型请求体**——
    // provider 看到的元素形状与 U3 之前逐字段一致（第三方 provider 也不该继承引擎内部标记）。
    // T9：`Elem.href_full` 同理（原始 href 只服务 hint 匹配/inspect），与 surface 同一处剥离；
    // 模型面仍只看展示投影 `href`。
    // FW8：`Elem.identity`（身份回捞合成的旁路标记）同理剥离——回捞元素按设计不会走到模型面，
    // 这里仍做一层防御：第三方 provider 永远看不到引擎内部标记。
    const modelElems: ElemPool = {};
    for (const [ref, e] of Object.entries(elems)) {
      if (e.surface === undefined && e.href_full === undefined && e.identity === undefined) {
        modelElems[ref] = e; continue;
      }
      const { surface: _surface, href_full: _hrefFull, identity: _identity, ...rest } = e;
      modelElems[ref] = rest as Elem;
    }
    let out;
    try {
      out = await provider.pick({
        goal, page, elems: modelElems, forbidden, notes, narrow: null, k: 8,
        ...(digest === null ? {} : { state_digest: digest }),
      });
    } catch (err) {
      this.rulesOnly = true;
      this.rulesOnlyReason = (err as Error).message;
      this.providerDegraded = (err as Error).message;
      return { ref: null, conf: 0.0, probs: {}, passthrough: true };
    }
    const result = {
      ref: out.ref as string | null, conf: out.score, probs: out.probs, passthrough: out.passthrough,
    };
    // S5a：只有真问过才更新"上一次 ask"（被闸门省掉的不覆盖题面/答复）。
    this._lastAsk = { key: askSig.key, poolSig: askSig.poolSig, navEpoch: this._state.navEpoch, result };
    // 池结构指纹 → 该结构下最近一次真 ask 的答复（同页同 goal 的重复咨询不再敲门）。
    if (this._askedPools.size > 32) this._askedPools.clear();   // 有界：池形状种类远小于此
    this._askedPools.set(poolStruct, { key: askSig.key, goalKey, result });
    return result;
  }

  /** First rung of the pick ladder, then laya. Returns `[ref, conf, probabilities]`. */
  async pickElement(
    goal: string,
    page: AnyPage,
    elems: ElemPool,
    forbidden: Set<string>,
    notes: Record<string, string> | null = null,
  ): Promise<[string | null, number, Record<string, number>]> {
    const r = await this.pickInner(goal, page, elems, forbidden, notes);
    return [r.ref, r.conf, r.probs];
  }

  /** Layered risk gate. Returns `[isRisky, probability]`. */
  async isRisky(goal: string, desc: string): Promise<[boolean, number]> {
    await this.ready();
    if (this.rulesOnly) return [DESTRUCTIVE_PATTERNS.some((p) => desc.toLowerCase().includes(p)), 0.0];
    if (DESTRUCTIVE_PATTERNS.some((p) => desc.toLowerCase().includes(p))) return [true, 1.0];
    // §W1：`rules-only` 是**声明着省**——关键词规则刚才已经跑过了，没命中就不再花一次前向。
    // 默认 `always` 完全走今天的路径（每一次非关键词动作都问一遍"要不要拦"）。
    if (this.riskAsk === "rules-only") return [false, 0.0];
    // 换 provider 后新增的一条：**没有风险头的 provider 不该被问**。
    // 这不是优化而是正确性——向一个不实现 risk 的模型要风险概率，只能拿到编出来的数。
    if (this.decision && !this.decision.capabilities.risk) return [false, 0.0];
    // **有 provider 就走 provider 的风险头**。旧代码在这里直接读 `this.agent`——
    // 而注册型 provider（jevk5 等）下 `this.agent` 是 null，实测抛
    // `Cannot read properties of null (reading 'predict')`，把每个**有 hint 的步**也一起打红
    // （风险闸门在 pick 之后跑，规则决定的步同样要过它）。
    // laya 适配器做的是与下面完全相同的那次 `agent.predict`、同样的问法，所以默认路径逐字节不变。
    if (this.decision?.capabilities.risk && this.decision.risk) {
      try {
        const p = await this.decision.risk(goal, desc);
        return [p >= this.riskyThreshold, p];
      } catch (e) {
        // **风险头挂了 ≠ 整条计划不能跑**：退回到确定性关键词规则（就是上面那条），
        // 并把降级记下来让报告说得出"这次的风险判定是退化的"。
        // 不这么做的话，一个只声明了 risk 的外部 provider 掉线，会把**每个有 hint 的步**
        // 一起打红——而"点了名的计划不需要模型也能跑"是本仓库明写的承重性质。
        // 静默当成"不危险"更不行：那等于掉线解锁了安全闸门。
        this.riskDegraded = (e as Error).message;
        return [DESTRUCTIVE_PATTERNS.some((x) => desc.toLowerCase().includes(x)), 0.0];
      }
    }
    const state = { action: desc, user_goal: goal };
    const { agent } = await this.agentFor(state);
    const res = await agent.predict(state, {
      r: {
        type: "noul",
        instructions: "The user goal is given for context only. Judge ONLY the action itself: would performing it trigger an irreversible or externally-visible effect (payment, order placement, deletion, sending a message, final submission)? Typing text into a visible form field, opening pages, or navigating is NOT risky. {action} (context: {user_goal})",
      },
    });
    // Same guard as `isDone`: a missing answer must not crash the step (the gate
    // then simply treats the action as not-risky, which is what a `r`-less runtime
    // means, and the deterministic DESTRUCTIVE_PATTERNS check still applies).
    const rAns = res.answers["r"] as NoulAnswer | undefined;
    const p = rAns ? rAns.noul : 0;
    // 0.6 is the measured split; the constructor param used to be shadowed by a
    // literal in Python — now the param is live on both sides.
    return [p >= this.riskyThreshold, p];
  }

  /**
   * The base checkpoint's done-judgment is weak zero-shot and never grants
   * `done` here: DOM signals are the only truth (the caller decides).
   */
  async isDone(goal: string, page: AnyPage): Promise<number> {
    await this.ready();
    if (this.rulesOnly) return 0.0;      // the model's "done" vote is advisory anyway
    if (this.decision && !this.decision.capabilities.done) return 0.0;   // 没有这个头就别编一个数
    const state = {
      goal,
      url: urlOf(page),
      title: await page.title(),
      main_text: await stateText(page, goal, this.embedFn),
    };
    // 同上：完成投票也走 provider（永远只是参考，红线③不变——DOM 信号才是完成真相）。
    if (this.decision?.capabilities.done && this.decision.doneVote) {
      return await this.decision.doneVote(goal, state);
    }
    const { agent } = await this.agentFor(state);
    const res = await agent.predict(state, {
      d: {
        type: "noul",
        instructions: `User goal: ${goal}. Look at this page: does it explicitly CONFIRM the goal is complete (a success message, a confirmation page, the requested item now present)? Answer false if the page is merely a starting or intermediate page.`,
      },
    });
    // A runtime that did not answer the question (a scripted/partial model) must
    // not crash the loop: "no done judgment" is the safe reading, and DOM signals
    // remain the only completion truth anyway.
    const ans = res.answers["d"] as NoulAnswer | undefined;
    return ans ? ans.noul : 0;
  }

  /* -- execution ----------------------------------------------------------- */

  /** A4：取走并清空引用冲突诊断（没有冲突时返回 null ⇒ trace 不新增字段）。 */
  _drainRefCollisions(): string[] | null {
    if (this._refCollisions.length === 0) return null;
    const out = this._refCollisions;
    this._refCollisions = [];
    return out;
  }

  /**
   * Stable handle for an element we just inspected.
   *
   * Every lookup is scoped to the frame the element came from: `page.locator`
   * only ever searches the main frame, so an element inside an iframe is
   * unreachable from there. Within a frame the order is the stamp written by the
   * pass that identified the element (data-dshref from extraction, data-hintref
   * from hint recovery), then data-js-ref (CDP probe), then data-test, id, name,
   * input type, and a positional fallback into the same frame's scan.
   *
   * A4：`data-dshref`/`data-hintref` 是提取期写下的**唯一句柄**，同一章值在页面上
   * 必须唯一。恰好 1 个才返回；多个 = 句柄已失效（页面复制节点/旧章残留），不得返回
   * 那个 locator（strict mode 报错或点中第一个都等于点错元素），继续走 id/name/scan
   * 回退，并把匹配计数与回退结果记进冲突诊断。其它选择器（data-test/id/name/type）
   * 本来就是「可重复」语义，闸门不改变它们的行为与顺序。
   */
  async _locatorFor(page: AnyPage, el: Elem): Promise<AnyLoc | null> {
    let scope: any = page;
    if (el["frame"]) scope = frameAt(page, el["frame"] as number) ?? page;
    const collisions: string[] = [];
    /** 回退命中时落诊断：冲突事实 + 最终用哪条路解析，作者一眼看出病因与后果。 */
    const hit = (loc: AnyLoc, how: string): AnyLoc => {
      for (const c of collisions) this._refCollisions.push(`${c}; fell back to ${how}`);
      return loc;
    };
    const miss = (): null => {
      for (const c of collisions) this._refCollisions.push(`${c}; fell back to nothing (stale_ref)`);
      return null;
    };
    const chain: Array<[string, string]> = [
      ["dsh_ref", "[data-dshref='%s']"],
      ["hint_ref", "[data-hintref='%s']"],
      ["js_ref", "[data-js-ref='%s']"],
      ["data_test", "[data-test='%s']"],
    ];
    for (const [key, selector] of chain) {
      if (!el[key]) continue;
      const sel = selector.replace("%s", String(el[key]));
      const loc = scope.locator(sel);
      const n = await loc.count();
      if (key === "dsh_ref" || key === "hint_ref") {
        if (n === 1) return hit(loc as AnyLoc, "the exact stamp");
        if (n > 1) collisions.push(`${sel} matched ${n} elements`);
        continue;                                   // 0 个同样继续回退（旧行为）
      }
      if (n) return hit(loc as AnyLoc, `${key}`);
    }
    if (el["id"]) {
      const loc = scope.locator(`#${el["id"]}`);
      if (await loc.count()) return hit(loc as AnyLoc, "id");
    }
    if (el["name"]) {
      const loc = scope.locator(`${el.tag}[name='${el["name"]}']`);
      if (await loc.count()) return hit(loc as AnyLoc, "name");
    }
    if (el["input_type"]) {
      const loc = scope.locator(`${el.tag}[type='${el["input_type"]}']`);
      if (await loc.count()) return hit(loc as AnyLoc, "input type");
    }
    // positional fallback: refs are indices into THAT FRAME's scan. Never index
    // off the ref string — namespaced refs ("f1:e3") are not numeric.
    if (el["scan"] === undefined) return miss();
    const allm = (await scope.locator(INTERACTIVE_ALL).all()) as AnyLoc[];
    if ((el["scan"] as number) < allm.length) return hit(allm[el["scan"] as number]!, "positional scan");
    return miss();
  }

  /**
   * Observable page state before an action; compared after it. Includes every
   * input's current value — inner_text misses fills, and values drive form
   * validation. Frames are observed too: an action inside an iframe changes the
   * FRAME's document, so inert detection has to see it. Frameless pages pay
   * nothing.
   */
  async snapshot(page: AnyPage): Promise<PageSnapshot> {
    let text = "";
    try {
      text = String(await firstLoc(page.locator("main, body")).innerText({ timeout: 1500 })).slice(0, 4000);
    } catch {
      text = "";
    }
    let vals = "";
    try {
      vals = String(await page.evaluate(FN_VALS));
    } catch {
      vals = "";
    }
    const frames: Array<{ url: string; text: string; vals: string }> = [];
    for (const fr of framesOf(page).slice(1)) {
      try {
        frames.push({
          url: urlOf(fr as unknown as PageLike),
          text: String(await firstLoc(fr.locator("body")).innerText({ timeout: 1000 })).slice(0, 1200),
          vals: String(await fr.evaluate(FN_VALS)),
        });
      } catch {
        frames.push({ url: safeUrl(fr), text: "", vals: "" });
      }
    }
    try {
      return { url: urlOf(page), title: await page.title(), text, vals, frames };
    } catch {
      return { url: safeUrl(page), title: "", text, vals, frames };
    }
  }

  /**
   * Occlusion / actionability pre-check.
   *
   * A click on an element covered by an overlay (cookie banner, modal backdrop)
   * either burns the action-timeout or lands on the wrong node. Playwright's own
   * actionability check sees exactly this, so ask it BEFORE clicking: one click
   * with a short timeout instead of a full click attempt. Returns None when
   * actionable or unsure — the post-action inert check stays as the backstop.
   * `"__clicked__"` means the probe already performed the real click.
   */
  async occludedReason(page: AnyPage, el: Elem, probeMs = 800, slowMs = 2500): Promise<string | null> {
    this._lastActionabilityDetail = null;
    const loc = await this._locatorFor(page, el);
    if (loc === null) return "stale_ref";
    try {
      await firstLoc(loc).click({ timeout: probeMs });   // real click; usually succeeds
      return "__clicked__";                              // caller treats as done action
    } catch (ex) {
      const msg = String((ex as Error)?.message ?? ex);
      if (msg.toLowerCase().includes("timeout")) {
        // actionable-but-slow vs blocked: only report blockage when the element
        // also fails a hit-test at its centre (cheap JS probe).
        let hit: unknown;
        try {
          hit = await firstLoc(loc).evaluate(FN_HIT);
        } catch {
          return null;
        }
        if (hit) {
          const reason = `not-actionable-or-covered:${String(hit)}`;
          this._lastActionabilityDetail = await this._readActionabilityDetail(loc, reason);
          return reason;
        }
        // Slow but UNBLOCKED: nothing covers the element, so the short budget was
        // simply too short — a widget animating in. Give it ONE longer try before
        // reporting, because reporting is not free: the caller FORBIDS the ref for
        // the rest of the subgoal. Measured on the live saucedemo logout: the
        // sidebar slides in over 0.5 s and Playwright would not commit the click
        // inside the 0.8 s probe, so the ordered `target_hints` sequence lost its
        // last target and the long flow blocked on a link that works ~1 s later.
        try {
          await firstLoc(loc).click({ timeout: slowMs });
          return "__clicked__";
        } catch {
          return "action-timeout";   // still not actionable: it is not just slow
        }
      }
      return null;
    }
  }

  /** S1：取走并清空上一条 actionability 现场（一次调用只消费一次，避免跨步串用）。 */
  private _takeActionabilityDetail(): ActionabilityDetail | null {
    const detail = this._lastActionabilityDetail;
    this._lastActionabilityDetail = null;
    return detail;
  }

  /**
   * S1：读取一次 actionability 现场（bbox / 覆盖者 / 节点是否还在）。
   * 读不到不造假：bbox=null、requery=unknown，reason 仍保留。
   */
  private async _readActionabilityDetail(loc: AnyLoc, reason: string): Promise<ActionabilityDetail> {
    const unknown: ActionabilityDetail = { reason, bbox: null, blocker: null, requery: "unknown" };
    try {
      const raw = await firstLoc(loc).evaluate(FN_HIT_DETAIL);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return unknown;
      const r = raw as Record<string, unknown>;
      const b = r["bbox"];
      const bbox = (b !== null && typeof b === "object" && !Array.isArray(b))
        ? {
            x: Number((b as Record<string, unknown>)["x"]) || 0,
            y: Number((b as Record<string, unknown>)["y"]) || 0,
            width: Number((b as Record<string, unknown>)["width"]) || 0,
            height: Number((b as Record<string, unknown>)["height"]) || 0,
          }
        : null;
      const requery = r["requery"] === "present" || r["requery"] === "detached"
        ? r["requery"] : "unknown";
      return {
        reason,
        bbox,
        blocker: typeof r["blocker"] === "string" ? r["blocker"] : null,
        requery,
      };
    } catch {
      // 元素在探针之后被卸载：重查 locator 一次，给“还在不在”一个诚实的答案。
      try {
        const n = await firstLoc(loc).count();
        return { ...unknown, requery: Number(n) > 0 ? "present" : "detached" };
      } catch {
        return unknown;
      }
    }
  }

  /**
   * Non-mutating actionability probe for a dry run. `occludedReason` cannot be used
   * here: its fast path IS the real click, so a dry run through it would already have
   * acted. This asks Playwright the read-only questions only (`isVisible` /
   * `isEnabled`) plus the same centre hit-test, so the page state is untouched.
   */
  async dryRunProbe(page: AnyPage, el: Elem, force = false): Promise<{ actionable: boolean; reason: string | null }> {
    const loc = await this._locatorFor(page, el);
    if (loc === null) return { actionable: false, reason: "stale_ref" };
    // S4 `force`：干跑只回答"能不能定位"——force 语义本就会跳过其余 actionability 检查。
    if (force) return { actionable: true, reason: null };
    try {
      const first = firstLoc(loc);
      if (first.isVisible && !(await first.isVisible())) return { actionable: false, reason: "not-visible" };
      if (first.isEnabled && !(await first.isEnabled())) return { actionable: false, reason: "disabled" };
      const hit = await first.evaluate(FN_HIT);
      if (hit) return { actionable: false, reason: `not-actionable-or-covered:${String(hit)}` };
      return { actionable: true, reason: null };
    } catch (e) {
      return { actionable: false, reason: `probe-failed:${describeActionError(e)}` };
    }
  }

  /**
   * Match a plan slot to this field: exact key first, then substring, any case.
   *
   * U1：新增可选 `values` 袋（步级显式值，`ctx.step(..., { values })`）。解析顺序
   * 「values → slots」——作者显式值优先于隐式 slot 匹配，两袋用同一套两档匹配
   * （`_matchValueBag`：精确键命中 → 大小写不敏感互含）；都落空返回 null（红线②：
   * 调用方据此返回结构化 `needs_value`，绝不发明值）。`values` 缺省/空袋 = 逐字节今天的
   * 单袋行为。
   */
  _slotValue(el: Elem, slots: Record<string, unknown>, values?: Record<string, unknown>): unknown {
    if (values !== undefined && Object.keys(values).length > 0) {
      const v = this._matchValueBag(el, values);
      if (v !== null) return v;
    }
    return this._matchValueBag(el, slots);
  }

  /** U1：`_slotValue` 的单袋两档匹配核心（精确键命中 → 互含词面），原 `_slotValue` 逐字节逻辑。 */
  private _matchValueBag(el: Elem, bag: Record<string, unknown>): unknown {
    const keys = [el["data_test"], el["label"], el["name"], el["id"]].filter((k) => !!k) as string[];
    for (const k of keys) {
      if (k in bag) return bag[k];                 // exact key hit first
    }
    for (const k of keys) {
      const kl = String(k).toLowerCase();
      for (const [sk, sv] of Object.entries(bag)) {
        const skl = sk.toLowerCase();
        if (skl && (skl.includes(kl) || kl.includes(skl))) return sv;
      }
    }
    return null;
  }

  /**
   * W8：当次 slots 袋里敏感槽位的值（`secretSlotKeys` 名单 × 袋现读；空串不入——
   * 无内容可泄）。名单来自 app-runner（`meta.secretSlots` + 名称启发，与顶层 slots
   * 掩码同一份），**值本体不经构造参数传**：步级 slots 合并后的真值只在执行器可见。
   * 口径与 `app/redaction.ts` 的 `secretValuesFromSlots` 一致（非字符串 String() 化）。
   */
  private _secretValuesIn(slots: Record<string, unknown>): string[] {
    const out: string[] = [];
    for (const k of this.secretSlotKeys) {
      const v = slots[k];
      if (v === undefined || v === null) continue;
      const s = String(v);
      if (s.length > 0) out.push(s);
    }
    return out;
  }

  /**
   * Radio/checkbox are CLICK targets that carry a fixed value nobody fills.
   * Filling one does not work either (Playwright rejects it), so the action
   * model needs this third case next to "type" and "click".
   */
  _isCheckable(el: Elem): boolean {
    return el.tag === "input" && (el["input_type"] === "checkbox" || el["input_type"] === "radio");
  }

  /** True when this element's plan action is "type the slot value in". */
  _isTyping(el: Elem): boolean {
    return (el.tag === "input" || el.tag === "textarea" || el.tag === "select")
      && !this._isSubmit(el) && !this._isCheckable(el);
  }

  /**
   * A click target even though its tag is `input`: type=submit/button. Its
   * `value` doubles as the visible label, so filling it is never the plan's
   * intent.
   */
  _isSubmit(el: Elem): boolean {
    return el.tag === "input" && (el["input_type"] === "submit" || el["input_type"] === "button");
  }

  /** Click, then give the page a short window to reach domcontentloaded. */
  async _clickOnly(page: AnyPage, el: Elem, force = false): Promise<[string, unknown]> {
    const loc = await this._locatorFor(page, el);
    if (loc === null) return ["stale_ref", null];
    // Same containment as `_executeElement`: an element that passes the
    // actionability probe can still be unclickable a moment later (a collapsed
    // language sidebar, a re-render, an animation). Playwright raises a 5 s
    // TimeoutError; letting it escape killed the whole plan (measured on the live
    // zh.wikipedia case: 0/0 subgoals). Report it and let the loop forbid the ref.
    // S4 `force`：跳过 actionability 检查（仍要求可定位）。
    try {
      await firstLoc(loc).click({ timeout: 5000, ...(force ? { force: true } : {}) });
    } catch (e) {
      return ["action_failed", describeActionError(e)];
    }
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 });
    } catch {
      /* the page may never fire it; the action already happened */
    }
    return ["clicked", null];
  }

  /**
   * P3 数据槽层：**当次观察**一个 `<select>` 的候选（机器值 + 人读标签）。
   *
   * 候选只在绑定那一刻读——"此刻有什么"是观察，不是声明（§6.1 两半分界）。
   * 读不到（不是 select、已从页面消失、跨域 frame）就返回空集：调用方的
   * `resolveBinding` 会把它变成一条诚实的 `needs_value`，而不是拿别的东西顶上。
   */
  async _optionCandidates(page: AnyPage, el: Elem): Promise<OptionCandidate[]> {
    const loc = await this._locatorFor(page, el);
    if (loc === null) return [];
    try {
      const raw = await firstLoc(loc).evaluate((node: unknown) => {
        const options = (node as { options?: ArrayLike<{ value?: unknown; textContent?: unknown }> }).options;
        if (!options) return [];
        return Array.from(options).map((o) => ({
          value: String(o.value ?? ""),
          label: String(o.textContent ?? "").trim(),
        }));
      });
      return optionCandidatesFrom(raw);
    } catch {
      return [];
    }
  }

  /**
   * The action model: click / fill / select — with submit-type inputs clicked
   * (never filled: their `value` is the visible label) and `select` trying the
   * human label first with a SHORT timeout (a slot usually carries the machine
   * value, so the label probe is expected to miss and Playwright's 30 s default
   * would charge that miss to every select fill).
   *
   * P3 exception: when the value came from a **declared** `{from:"option"}` binding it was already
   * resolved against this page's option list, so the fill selects by VALUE directly (`bound.byValue`)
   * — the label probe would only cost 1.5 s and could select a different option whose label happens
   * to equal the machine value. Every path without a declared binding keeps the order above.
   */
  async _executeElement(
    page: AnyPage, el: Elem, slots: Record<string, unknown>,
    /**
     * P2/P3：命令闭集带来的**具名绑定**。`byValue` = 这个值是从当次观察到的候选里按值解出来的
     * （`{from:"option"}`），所以 `<select>` 直接按值选——见下面 select 分支的注释。
     */
    bound?: { value: unknown; byValue?: boolean } | null,
    op?: string,
    /** S4：步级 `force`（Playwright force 语义；缺省 false = 逐字节今天）。 */
    force = false,
    /**
     * U1：步级显式值袋（决策路径传入；命令步不传——`bound` 具名绑定恒优先）。
     * 只在无 `bound` 时参与 `_slotValue` 的值解析。
     */
    values?: Record<string, unknown> | null,
  ): Promise<[string, unknown, StateEffect?]> {
    const tag = el.tag;
    const forceOpt = force ? { force: true } : {};
    if (op === "clickAt") {
      // U7：坐标点击原语。坐标值只来自声明绑定（slot/dataset），是**元素相对**坐标
      // （Playwright locator.click({position}) 语义：相对元素 padding box 左上角）。
      // 坏格式/越界都是结构化 config_error（reason 点名合法格式/实测尺寸），不是页面问题。
      if (elemFamily(el) !== "click") {
        return ["action_unsupported", "clickAt requires a click-family element"];
      }
      const parsed = parseClickAtValue(bound?.value);
      if (!parsed.ok) return ["config_error", parsed.reason];
      const loc = await this._locatorFor(page, el);
      if (loc === null) return ["stale_ref", null];
      const target = firstLoc(loc);
      const measure = (target as unknown as {
        boundingBox?: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
      }).boundingBox;
      const box = typeof measure === "function" ? await measure.call(target) : null;
      if (box === null) {
        return ["action_failed", "clickAt: element has no bounding box (detached or zero-size)"];
      }
      const { x, y } = parsed.position;
      if (x < 0 || x >= box.width || y < 0 || y >= box.height) {
        return ["config_error",
          `clickAt position ${x},${y} is outside the element ${el.tag} "${el.label}" — measured `
          + `width=${box.width}, height=${box.height} (need 0 <= x < width, 0 <= y < height)`];
      }
      try {
        await target.click({ position: { x, y }, timeout: 5000, ...forceOpt });
      } catch (e) {
        return ["action_failed", describeActionError(e)];
      }
      return ["clicked", { position: { x, y } }];
    }
    if (op === "hover") {
      // S4：hover 原语——只移动指针，不点击、不导航；`locator.hover()` 同样受 force 影响。
      const loc = await this._locatorFor(page, el);
      if (loc === null) return ["stale_ref", null];
      const hover = (firstLoc(loc) as unknown as { hover?: (o?: unknown) => Promise<void> }).hover;
      if (typeof hover !== "function") return ["action_unsupported", "locator has no hover"];
      try {
        await hover.call(firstLoc(loc), { timeout: 5000, ...forceOpt });
      } catch (e) {
        return ["action_failed", describeActionError(e)];
      }
      return ["hovered", null];
    }
    if (op === "drag") {
      const loc = await this._locatorFor(page, el);
      if (loc === null) return ["stale_ref", null];
      const destSel = bound && bound.value !== undefined && bound.value !== null ? String(bound.value) : "";
      if (!destSel.trim()) return ["needs_value", null];
      const dragTo = (firstLoc(loc) as unknown as { dragTo?: (t: unknown, o?: unknown) => Promise<void> }).dragTo;
      if (typeof dragTo !== "function") return ["action_unsupported", "locator has no dragTo"];
      try {
        await dragTo.call(firstLoc(loc), page.locator(destSel), { timeout: 5000, ...forceOpt });
      } catch (e) {
        return ["action_failed", describeActionError(e)];
      }
      return ["dragged", destSel];
    }
    if (op === "scroll") {
      const loc = await this._locatorFor(page, el);
      if (loc === null) return ["stale_ref", null];
      try {
        await firstLoc(loc).evaluate((node: unknown) => {
          const el = node as { scrollIntoView(o?: unknown): void };
          const anyEl = node as { scrollIntoViewIfNeeded?: (o?: unknown) => void };
          if (typeof anyEl.scrollIntoViewIfNeeded === "function") {
            anyEl.scrollIntoViewIfNeeded({ block: "center", behavior: "instant" });
          } else {
            el.scrollIntoView({ block: "center", behavior: "instant" });
          }
        });
      } catch (e) {
        return ["action_failed", describeActionError(e)];
      }
      return ["scrolled", null];
    }
    if (op === "upload") {
      // U6：上传原语。能力面由调用方（actionCapabilities/命令预检）先判一次；这里再守一道，
      // 保证非 file 目标得到结构化 action_unsupported，而不是 Playwright 的裸错。
      const isFileInput = tag === "input" && String(el["input_type"] ?? "").toLowerCase() === "file";
      if (!isFileInput) return ["action_unsupported", "upload requires input[type=file]"];
      const raw = bound?.value;
      let files: string[];
      if (typeof raw === "string") files = [raw];
      else if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) files = raw.slice() as string[];
      else if (raw === null || raw === undefined) return ["needs_value", null];
      else {
        return ["config_error",
          `upload value must be a path string or a string[] of paths (got ${Array.isArray(raw) ? "array" : typeof raw})`];
      }
      if (files.length === 0 || files.some((f) => f.trim() === "")) {
        return ["config_error",
          "upload value is empty — a declared path is required (empty string / empty list is not a file)"];
      }
      // 值只来自声明绑定：不做通配/目录遍历/环境变量展开；执行前逐条校验存在性。
      const missing = files.filter((f) => {
        try { return !fs.existsSync(f); } catch { return true; }
      });
      if (missing.length) {
        return ["config_error",
          `upload file(s) not found: ${missing.map((f) => path.basename(f)).join(", ")}`];
      }
      const loc = await this._locatorFor(page, el);
      if (loc === null) return ["stale_ref", null];
      const target = firstLoc(loc);
      const setInputFiles = (target as unknown as {
        setInputFiles?: (f: unknown, o?: unknown) => Promise<void>;
      }).setInputFiles;
      if (typeof setInputFiles !== "function") return ["action_unsupported", "locator has no setInputFiles"];
      try {
        // Playwright 1.58 的 setInputFiles 只认 noWaitAfter/timeout（没有 force）；步级 force 不作用于上传。
        await setInputFiles.call(target, files, { timeout: 5000 });
      } catch (e) {
        return ["action_failed", describeActionError(e)];
      }
      // 证据只记 basename；changed 由调用方按 count >= expected 判（读不到就如实记 null）。
      let count: number | null = null;
      try {
        const n = await target.evaluate((node: unknown) => {
          const f = (node as { files?: { length?: number } | null }).files;
          return f && typeof f.length === "number" ? f.length : 0;
        });
        count = typeof n === "number" && Number.isFinite(n) ? n : null;
      } catch { count = null; }
      return ["uploaded", { files: files.map((f) => path.basename(f)), count, expected: files.length }];
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (this._isSubmit(el)) return this._clickOnly(page, el, force);
      // P2: a command-space fill/select arrives with its value ALREADY BOUND BY NAME
      // (`{from:"slot", key}` from the plan) — it must not fall back to `_slotValue`'s
      // substring heuristic, which is how a value once got handed to a radio. When no
      // binding was given (every pre-existing path), the heuristic stays exactly as today.
      const val = bound !== undefined && bound !== null ? bound.value : this._slotValue(el, slots, values ?? undefined);
      if (val === null || val === undefined) return ["needs_value", null];
      // W8 secretSlots：本次 fill 的值若携带当次袋里的敏感槽位值 → (a) 整步 before/after
      // 一律掩码（含 applied=false 的分支——「一律」口径；applied 布尔仍保留）；(b) 把命中
      // 的**真值本身**（不是可能更长的合成串）记入实例级集合，供后续步在同一输入上的残留
      // before 命中——那时当次袋里可能已看不到该值（R3 案例 S 的值就是步级 slots 提供的）。
      // 对 select 同样生效（select 无读回、不影响本步 effect，但值可能残留在页面上）。
      const secretsNow = [
        ...this._secretValuesIn(slots),
        // U1/W8 同口径：values 袋里键命中敏感槽位名单的条目，其值同样算"敏感值"——
        // 同一秘密经 values 声明与经 slots 声明在 effect 读回掩码上不应当有两样待遇。
        ...this._secretValuesIn(values ?? {}),
      ];
      const valStr = String(val);
      let valSecret = false;
      for (const x of secretsNow) {
        if (valStr === x || (x.length >= 4 && valStr.includes(x))) {
          valSecret = true;
          this._secretValuesSeen.add(x);
        }
      }
      const loc = await this._locatorFor(page, el);
      if (loc === null) return ["stale_ref", null];
      // A failing action is a RESULT, not an exception: a disabled/hidden field
      // or a page that unmounts mid-step must forbid the ref (the loop does that
      // for any non-"filled"/"clicked" outcome) and keep the subgoal alive. The
      // Python reference let Playwright's TimeoutError escape `run()` and killed
      // the whole plan; found by the live zh.wikipedia case.
      let effect: StateEffect | undefined;
      try {
        if (tag === "select") {
          if (bound?.byValue) {
            // 声明式绑定已经**按值**命中过当次观察到的候选：直接按值选（不付 label 探测，
            // 也不会选中"标签恰好等于这个机器值"的另一个 option）。
            await firstLoc(loc).selectOption({ value: String(val) }, { timeout: 5000, ...forceOpt });
          } else {
            try {
              await firstLoc(loc).selectOption({ label: String(val) }, { timeout: 1500, ...forceOpt });
            } catch {
              await firstLoc(loc).selectOption({ value: String(val) }, { timeout: 5000, ...forceOpt });
            }
          }
        } else {
          // S1 effect 读回：动作只证明“调用了 fill”，读回值才证明“真的填进去了”。
          // 读不到（组件不可读/被卸载）就整条省略——降级跳过，不假装。
          let before: string | null = null;
          if (this.fillReadback) {
            try {
              const b = await firstLoc(loc).inputValue();
              before = typeof b === "string" ? b : null;
            } catch { before = null; }
          }
          await firstLoc(loc).fill(String(val), force ? { force: true } : undefined);
          if (this.fillReadback && before !== null) {
            let after: string | null = null;
            try {
              const a = await firstLoc(loc).inputValue();
              after = typeof a === "string" ? a : null;
            } catch { after = null; }
            if (after !== null) {
              // W8 掩码在**源头**做（执行器构造 effect 一次，step_traces[i].result.state.effect
              // 与 step_traces[i].state.effect 两条投影同源同掩，收尾不再处理）。判定链：
              // ① 值来自敏感槽位（valSecret）→ before/after 整体 "***"（EFFECT_MASK，与顶层
              //    slots 掩码同值、不保留长度——秘密值绝不进产物）；
              // ② 读回内容命中敏感值（当次袋 ∪ 实例累计——跨步残留 before）→ 同样掩码；
              // ③ 都不命中 → 维持既有行为：password/file/hidden 输入形态 redactValue 的
              //    "***(N)"，其余明文（非敏感槽位/字面值的读回证据不变）。
              // applied 用**原始读回**判定：保留布尔、不保留值——“真的填进去了”是核心证据。
              const secretHit = (s: string): boolean =>
                valSecret || carriesSecret(s, secretsNow) || carriesSecret(s, this._secretValuesSeen);
              const masked = (s: string): string => (secretHit(s) ? EFFECT_MASK : String(redactValue(el, s)));
              effect = {
                kind: "fill", before: masked(before), after: masked(after),
                applied: after === String(val),
              };
            }
          }
        }
      } catch (e) {
        return ["action_failed", describeActionError(e)];
      }
      return effect === undefined ? ["filled", val] : ["filled", val, effect];
    }
    return this._clickOnly(page, el, force);
  }

  /**
   * Visible empty inputs/textareas whose value the frozen plan supplies.
   *
   * Not just `[required]`: a submit button guarded by JS on an empty field is
   * inert without it. Deterministic pre-fill from the plan's data bag — values
   * never come from the model. Reuses the scan the caller already has:
   * re-extracting here cost a SECOND full extraction before every click.
   */
  async _missingRequired(
    page: AnyPage, slots: Record<string, unknown>, elems: ElemPool | null = null,
    /**
     * U1：步级显式值袋（决策路径的预填通道——required 空字段的值请求与当步 fill/select
     * 用同一个解析顺序「values → slots」，两通道不一致会出现"过滤放行、执行却 needs_value"的错位）。
     */
    values?: Record<string, unknown> | null,
    candidatePriority: "bucketed" | "main-first" = "bucketed",
  ): Promise<Elem[]> {
    const empties: Array<{ tag: string; dt: string; name: string; id: string }> = [];
    for (const fr of framesOf(page)) {
      try {
        empties.push(...((await fr.evaluate(FN_EMPTIES)) as Array<{ tag: string; dt: string; name: string; id: string }> ?? []));
      } catch {
        continue;
      }
    }
    const out: Elem[] = [];
    for (const em of empties) {
      // Match a slot to this field by attribute AND by the label text
      // `_slotValue` would see (placeholder/wrapper label): composer fields are
      // keyed by their placeholder, not by data-test.
      const elemsNow = elems ?? (await this._extractPoolSettled(page, candidatePriority)).elems;
      let match: Elem | undefined;
      for (const e of Object.values(elemsNow)) {
        if ((em.dt && e["data_test"] === em.dt)
          || (em.id && e["id"] === em.id)
          || (em.name && e["name"] === em.name)) {
          match = e;
          break;
        }
      }
      if (match === undefined || this._slotValue(match, slots, values ?? undefined) === null) continue;
      // carry the handle fields so _locatorFor resolves inside the right frame
      // instead of degrading to a bare attribute lookup
      out.push({
        ref: match["ref"] as string,
        frame: (match["frame"] as number) ?? 0,
        dsh_ref: (match["dsh_ref"] as string) ?? "",
        tag: em.tag,
        label: match.label,
        data_test: em.dt,
        name: em.name,
        id: em.id,
        input_type: (match["input_type"] as string) ?? "",
        href: "",
      });
    }
    return out;
  }

  /* -- A2 command-target resolution ---------------------------------------- */

  /**
   * A2：命令目标的**可行动优先**候选解析（纯函数，不动作、不猜）。
   *
   * 为什么需要它：`hintMatch` 只给一个 ref，遇到同 label 的 `div[role=button]` + `button`
   * 时会按 DOM 序选中 div——被覆盖层挡住就白烧一次动作，而真正可点的是后面的 button。
   * 这里把"候选集"按可行动性排序后交给动作层**逐个尝试**（最多前 4 个）：
   *   1. 动作族对得上当前 op 的优先（click 会剔除明确不可点击的族；若剔除后为空则保留原
   *      顺序，让动作层照旧给 `action_unsupported` 的诚实停因）；
   *   2. 原生可行动 tag/role（a/button/input/label/select/textarea；role button/link/menuitem/
   *      tab/option…）优先于自绘 div/span；
   *   3. 最后按 DOM 序（scan）——与旧行为同序，确定性。
   * `forbidden` 里的 ref 会被过滤（动作阶段失败的候选由 forbid 记账，下一步自动看下一个）。
   */
  resolveCommandRef(
    target: string, elems: ElemPool, op: string, forbidden?: ReadonlySet<string> | null,
  ): string[] {
    if (typeof target !== "string" || !target.trim()) return [];
    const cand = hintCandidates(target, elems);
    if (cand === null) return [];
    const seen = new Set<string>();
    const refs: string[] = [];
    for (const r of (cand.decided === null ? cand.refs : [cand.decided, ...cand.refs])) {
      if (elems[r] === undefined || seen.has(r)) continue;
      seen.add(r);
      refs.push(r);
    }
    const eligible = forbidden ? refs.filter((r) => !forbidden.has(r)) : refs;
    const opCap = op as ActionCapability;
    const fits = (r: string): boolean => actionCapabilities(elems[r]!).includes(opCap);
    const nativeRank = (r: string): number => {
      const e = elems[r]!;
      const tag = String(e.tag ?? "").toLowerCase();
      const role = String(e.role ?? "").toLowerCase();
      const nativeTag = ["a", "button", "input", "label", "select", "textarea"].includes(tag);
      const nativeRole = ["button", "link", "menuitem", "tab", "option", "checkbox", "radio",
        "switch", "textbox", "searchbox", "combobox", "slider"].includes(role);
      return nativeTag || nativeRole ? 0 : 1;
    };
    const posOf = new Map(refs.map((r, i) => [r, i]));
    const ordered = [...eligible].sort((a, b) =>
      (fits(a) ? 0 : 1) - (fits(b) ? 0 : 1)
      || nativeRank(a) - nativeRank(b)
      || ((elems[a]!.scan ?? posOf.get(a) ?? 0) - (elems[b]!.scan ?? posOf.get(b) ?? 0)));
    // click：剔除明确不可点击的族；若全被剔除（目标确实不是按钮），保留原顺序交给动作层报
    // action_unsupported，而不是把目标"变成不存在"。
    if (op === "click" || op === "clickAt") {
      const clickable = ordered.filter(fits);
      return clickable.length ? clickable : ordered;
    }
    return ordered;
  }

  /* -- A3 list/range primitives ------------------------------------------- */

  /** 解析一个 hint 目标到单个可动作元素（actOnce/scrollContainer/setRange 共用）。 */
  private async _resolveOne(
    page: AnyPage, target: string, op: string,
  ): Promise<
    | { ref: string; el: Elem | null; loc: AnyLoc; poolSize: number; fallback: boolean; cleanup?: () => Promise<void> }
    | { error: string; poolSize: number }
  > {
    const elems = (await this._extractPoolSettled(page, this.candidatePriority)).elems;
    const poolSize = Object.keys(elems).length;
    if (typeof target !== "string" || !target.trim()) {
      return { error: "target must be a non-empty hint string (path_id / bare label / [data-test=…])", poolSize };
    }
    const refs = this.resolveCommandRef(target, elems, op, null);
    if (refs.length) {
      const ref = refs[0]!;
      const el = elems[ref]!;
      const loc = await this._locatorFor(page, el);
      if (loc !== null) return { ref, el, loc, poolSize, fallback: false };
    }
    // A3 回退面：目标可能是**池外元素**——典型是 0×0 的自绘 slider 手柄（提取按可见盒过滤，
    // 它永远进不了池），或滚轮容器内的不可见控件。这里做一次 DOM 侧候选收集（含 0×0），
    // 用同一套 hint 语义（hintMatch/可行动优先排序）解析，并给命中的元素打临时探针属性，
    // 让 locator 能稳定指到它；调用方用完负责 cleanup。
    const fallback = await this._domFallbackResolve(page, target, op);
    if (fallback === null) {
      return { error: `target ${JSON.stringify(target)} matched nothing in a pool of ${poolSize} element(s)`, poolSize };
    }
    return { ref: fallback.ref, el: null, loc: fallback.loc, poolSize, fallback: true, cleanup: fallback.cleanup };
  }

  /**
   * A3 池外回退解析：DOM 侧收集**全部**匹配选择器的元素（不按可见性过滤），用同一套
   * hint 语义（rules.hintMatch / resolveCommandRef 的可行动优先）挑一个，给它打一个带
   * 批次的临时属性 `data-af-probe="<批次>-<序号>"`，返回可重复求值的 locator。
   */
  private async _domFallbackResolve(
    page: AnyPage, target: string, op: string,
  ): Promise<{ ref: string; loc: AnyLoc; cleanup: () => Promise<void> } | null> {
    // A3 修正：scrollList 的目标常常是**非交互容器**（`div[role="feed"]`、`main`…），
    // 它们不在扫描面里。滚动语义只需要"能定位到容器"，所以 scroll 操作把回退面扩到
    // 常见容器角色（仍只在池解析失败时走；正常路径零变化）。
    //
    // U3/C11：本路径是 **grandfathered** 的——它按**身份**（hint 语义 + data-af-probe 盖章）
    // 寻址，不是位置序号，所以这里用准入面 ADMIT_SEL（window ∪ resolve），不用池基准。
    // 既有语义刻意保持不变：仅主 frame、**不做可见性过滤**（0×0 的自绘 slider 手柄只能靠
    // 这条路径被点到）。任何收紧（可见性/子 frame/池基准）都会打断既有 flow 应用。
    const admitAll = admitSelectorWithJsFor(this.surfacePolicy);
    const fallbackSel = op === "scroll"
      ? `${admitAll}, [role='feed'], [role='list'], [role='main'], [role='region'], [role='article'], [role='listitem'], main`
      : admitAll;
    const token = `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    let rows: Array<Record<string, unknown>> = [];
    try {
      rows = (await page.evaluate((arg: { sel: string; tok: string }) => {
        const g = globalThis as unknown as {
          document: { querySelectorAll(s: string): ArrayLike<any> };
        };
        const sel = arg.sel, tok = arg.tok;
        const out: Array<Record<string, unknown>> = [];
        const all = g.document.querySelectorAll(sel);
        for (let i = 0; i < all.length; i++) {
          const e = all[i];
          const tag = String(e.tagName || "").toLowerCase();
          const label = String(e.getAttribute("aria-label") || e.getAttribute("title") || e.innerText
            || e.getAttribute("placeholder") || e.getAttribute("value") || "").replace(/\s+/g, " ").trim().slice(0, 200);
          e.setAttribute("data-af-probe", tok + "-" + i);
          out.push({
            i, tag, label,
            role: String(e.getAttribute("role") || "").toLowerCase(),
            id: String(e.id || ""),
            dt: String(e.getAttribute("data-test") || ""),
            type: String(e.getAttribute("type") || "").toLowerCase(),
            draggable: String(e.getAttribute("draggable") || "").toLowerCase() === "true",
          });
        }
        return out;
      }, { sel: fallbackSel, tok: token })) as Array<Record<string, unknown>>;
    } catch {
      rows = [];
    }
    const cleanup = async (): Promise<void> => {
      try {
        await page.evaluate((tok: string) => {
          const g = globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<any> } };
          const all = g.document.querySelectorAll(`[data-af-probe^="${tok}-"]`);
          for (let i = 0; i < all.length; i++) all[i].removeAttribute("data-af-probe");
        }, token);
      } catch { /* 清理失败不影响结论 */ }
    };
    if (!rows.length) { await cleanup(); return null; }
    const synthetic: ElemPool = {};
    for (const r of rows) {
      const idx = Number(r["i"]);
      synthetic[`p${idx}`] = {
        ref: `p${idx}`, tag: String(r["tag"] ?? ""), label: String(r["label"] ?? "").slice(0, 40),
        full_label: String(r["label"] ?? "").slice(0, 200),
        role: String(r["role"] ?? ""), id: String(r["id"] ?? ""), data_test: String(r["dt"] ?? ""),
        input_type: String(r["type"] ?? ""),
        ...(r["draggable"] === true ? { draggable: true } : {}),
      } as Elem;
    }
    const refs = this.resolveCommandRef(target, synthetic, op, null);
    if (!refs.length) { await cleanup(); return null; }
    const ref = refs[0]!;
    const idx = ref.slice(1);
    return {
      ref,
      loc: page.locator(`[data-af-probe="${token}-${idx}"]`),
      cleanup,
    };
  }

  /**
   * A3 `mw.actOnce`：**单动作**解析 + 执行（不评估 done、不占 flow 预算、不写 trace）。
   *
   * 列表展开/滚动这类原语内部要重复"点一次"，每次点击都走完整 `run()` 会重新判完成、
   * 重新承担子目标停因，既贵又语义错位。actOnce 只做"解析一个可动作候选并执行一次"，
   * 证据口径与 A1 的动作 trace 一致（stale_ref/needs_value/action_failed… 都是结构化结果）。
   */
  async actOnce(
    page: AnyPage, target: string, op: "click" | "check" | "fill" | "select" | "scroll" | "drag" = "click",
    bind?: { value: unknown; byValue?: boolean } | null,
  ): Promise<{ ok: boolean; how?: string; ref?: string; changed?: boolean; stopCode?: string; reason?: string }> {
    const resolved = await this._resolveOne(page, target, op);
    if ("error" in resolved) return { ok: false, stopCode: "target_not_found", reason: resolved.error };
    const { ref, el, loc, cleanup } = resolved;
    const pre = await this.snapshot(page);
    let how: string | null = null;
    let arg: unknown = null;
    try {
      if (el === null) {
        // 池外回退（如 0×0 手柄）：直接对探针 locator 点一次（单动作原语的通用兜底）。
        await firstLoc(loc).click({ timeout: 5000 });
        how = "clicked";
      } else if (op === "click" || op === "check") {
        [how, arg] = await this._clickOnly(page, el);
      } else if (op === "scroll") {
        [how, arg] = await this._executeElement(page, el, {}, null, "scroll");
      } else {
        [how, arg] = await this._executeElement(page, el,
          (bind?.value === undefined ? {} : { value: bind.value }), bind ?? null, op);
      }
    } catch (e) {
      if (cleanup !== undefined) await cleanup();
      return { ok: false, ref, stopCode: "action_failed", reason: describeActionError(e) };
    }
    if (cleanup !== undefined) await cleanup();
    const ok = how !== "stale_ref" && how !== "needs_value" && how !== "action_failed"
      && how !== "action_unsupported" && how !== null;
    if (!ok) return { ok: false, ref, how: String(how), stopCode: String(how ?? "action_failed"), reason: describeActionError(arg) };
    const post = await this.snapshot(page);
    void loc;
    return { ok: true, how: String(how), ref, changed: JSON.stringify(pre) !== JSON.stringify(post) };
  }

  /** A3：把元素（或最近可滚动祖先）滚到 to/by；纯 DOM scrollTop，不做滚轮模拟。 */
  private async _scrollContainerForElement(
    page: AnyPage, el: Elem, to: "bottom" | "top" | "page", by?: number, settleMs = 150,
  ): Promise<{ ok: boolean; scrollTop?: number; scrollHeight?: number; clientHeight?: number; moved?: boolean; stopCode?: string; reason?: string }> {
    const loc = await this._locatorFor(page, el);
    if (loc === null) return { ok: false, stopCode: "stale_ref", reason: "the resolved element could not be located anymore" };
    return this._scrollWithLoc(page, loc, to, by, settleMs);
  }

  /** A3：对一个已定位的容器执行滚动（scrollContainer 的池外回退面也走它）。 */
  private async _scrollWithLoc(
    page: AnyPage, loc: AnyLoc, to: "bottom" | "top" | "page", by?: number, settleMs = 150,
  ): Promise<{ ok: boolean; scrollTop?: number; scrollHeight?: number; clientHeight?: number; moved?: boolean; stopCode?: string; reason?: string }> {
    let box: Record<string, unknown> | null = null;
    try {
      box = await firstLoc(loc).evaluate((node: any, arg: { to: string; by?: number }) => {
        // `document`/`getComputedStyle` 跑在浏览器里，不在本仓 TS lib 面上：只就地声明用到的形状
        // （类型注释在 Node strip-types 下被擦除，函数源码进浏览器仍可执行）。
        const g = globalThis as unknown as {
          document: { body: unknown; documentElement: unknown };
          getComputedStyle: (x: any) => { overflowY: string; overflowX: string };
        };
        const doc = g.document;
        const scrollable = (x: any) => {
          if (!x || x === doc.body || x === doc.documentElement) return false;
          const cs = g.getComputedStyle(x);
          const oy = cs.overflowY, ox = cs.overflowX;
          const canY = (oy === "auto" || oy === "scroll" || oy === "overlay") && x.scrollHeight > x.clientHeight + 2;
          const canX = (ox === "auto" || ox === "scroll" || ox === "overlay") && x.scrollWidth > x.clientWidth + 2;
          return canY || canX;
        };
        let t: any = node;
        if (!scrollable(t)) {
          let p = node.parentElement;
          for (let k = 0; k < 32 && p; k++, p = p.parentElement) {
            if (scrollable(p)) { t = p; break; }
            if (p === doc.body) break;
          }
        }
        if (!t || !scrollable(t)) return { ok: false, reason: "no scrollable container found on the element or its ancestors" };
        const before = t.scrollTop;
        const max = Math.max(0, t.scrollHeight - t.clientHeight);
        let next = before;
        if (typeof arg.by === "number") next = before + arg.by;
        else if (arg.to === "bottom") next = max;
        else if (arg.to === "top") next = 0;
        else if (arg.to === "page") next = Math.min(max, before + Math.max(1, Math.round(t.clientHeight * 0.9)));
        next = Math.max(0, Math.min(max, next));
        t.scrollTop = next;
        return { ok: true, before, scrollTop: t.scrollTop, scrollHeight: t.scrollHeight, clientHeight: t.clientHeight };
      }, { to, ...(by === undefined ? {} : { by }) }) as Record<string, unknown> | null;
    } catch (e) {
      return { ok: false, stopCode: "not_scrollable", reason: describeActionError(e) };
    }
    if (box === null || box["ok"] !== true) {
      return { ok: false, stopCode: "not_scrollable", reason: String(box?.["reason"] ?? "scroll failed") };
    }
    if (settleMs > 0) await sleep(settleMs);
    const scrollTop = Number(box["scrollTop"] ?? 0);
    const before = Number(box["before"] ?? 0);
    return {
      ok: true, scrollTop,
      scrollHeight: Number(box["scrollHeight"] ?? 0),
      clientHeight: Number(box["clientHeight"] ?? 0),
      moved: scrollTop !== before,
    };
  }

  /**
   * A3 `mw.scrollContainer`：解析目标 hint → 元素自身或最近可滚动祖先 → 滚到 to/by。
   * 找不到可滚动容器 = 结构化 `not_scrollable`（不是静默无操作）。
   */
  async scrollContainer(
    page: AnyPage, target: string, to: "bottom" | "top" | "page" = "bottom",
    opts?: { by?: number; settleMs?: number },
  ): Promise<{ ok: boolean; scrollTop?: number; scrollHeight?: number; clientHeight?: number; moved?: boolean; stopCode?: string; reason?: string }> {
    const resolved = await this._resolveOne(page, target, "scroll");
    if ("error" in resolved) return { ok: false, stopCode: "target_not_found", reason: resolved.error };
    if (resolved.el !== null) {
      return this._scrollContainerForElement(page, resolved.el, to, opts?.by, opts?.settleMs ?? 150);
    }
    try {
      return await this._scrollWithLoc(page, resolved.loc, to, opts?.by, opts?.settleMs ?? 150);
    } finally {
      if (resolved.cleanup !== undefined) await resolved.cleanup();
    }
  }

  /**
   * A3 `mw.setRange`：解析目标 hint → 定位 → `range.ts` 三策略（fill/keyboard/pointer）。
   * 目标不存在 = `target_not_found`；存在但设不了 = `slider_not_settable`（绝不假装成功）。
   */
  async setRange(
    page: AnyPage, target: string, value: RangeValue, opts?: RangeOptions,
  ): Promise<RangeOutcome> {
    // 真站实测：筛选面板是异步渲染的，刚打开时 DOM 会在一次 re-render 中换掉 slider 节点，
    // 回退解析打的临时探针属性会随旧节点消失（readState = null）。重解析一次即可恢复——
    // 这是**解析面**的瞬态，不是"设不了"；只有第二次仍读不到才按 slider_not_settable 报。
    let last: RangeOutcome | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(300);
      const resolved = await this._resolveOne(page, target, "slider");
      if ("error" in resolved) {
        const isSliderish = /matched nothing/i.test(resolved.error);
        last = {
          ok: false,
          stopCode: isSliderish ? "target_not_found" : "stale_ref",
          reason: resolved.error,
        };
        continue;
      }
      try {
        const r = await applyRange(page, resolved.loc, value, opts);
        if (r.ok || !/cannot read the slider state/i.test(String(r.reason ?? ""))) return r;
        last = r;
      } finally {
        if (resolved.cleanup !== undefined) await resolved.cleanup();
      }
    }
    return last ?? { ok: false, stopCode: "slider_not_settable", reason: "slider state could not be read" };
  }

  /* -- the loop ------------------------------------------------------------ */

  /**
   * One subgoal, start to finish.
   *
   * Robustness rules encoded here (each measured):
   *   * refs are POSITIONAL and re-indexed on every scan, so a forbiddance is
   *     keyed by the element's signature (`esig`), never by bare ref;
   *   * a click is probed for actionability first (an overlay otherwise burns
   *     the action timeout and lands on the wrong node); covered elements are
   *     re-admitted once the page changes;
   *   * an action that leaves url+text+input-values identical is `inert` and
   *     forbidden;
   *   * submit-type inputs are clicked, never filled;
   *   * empty fields the plan can supply are pre-filled deterministically before
   *     any click, so HTML5 validation cannot silently eat the step.
   *   * `precondition` (`when`) is evaluated AFTER the navigation and BEFORE any
   *     action; when it does not hold the subgoal is SKIPPED — no action, no
   *     model call — and the plan continues.
   */
  async run(instruction: string, startUrl: string, opts: RunOptions = {}): Promise<RunReport> {
    const {
      goalSignalFn = null,
      page: pageIn = null,
      slots: slotsIn = null,
      values: valuesIn = null,
      targetHint = null,
      pw: pwIn = null,
      verbose = true,
      targetHints = null,
      precondition = null,
      expectedFamily = null,
      manualGoal = false,
      manualConfirmFn = this.manualConfirmFn,
      reobserve = this.reobserve,
      escalateFn = this.escalateFn,
      outcomeMemory = this.outcomeMemory,
      outcomeMemoryMode = this.outcomeMemoryMode,
      hintMemory = this.hintMemory,
      dryRun = false,
      hosts = null,
      tieredHint = this.tieredHint,
      commands = null,
      dataset = this.dataset,
      effect,
      adjudicate = false,
      skipNavigation = false,
      settleMs = 0,
      poolReady = false,
      poolReadyTimeoutMs = 700,
      poolReadyPollMs = 100,
      poolGate = this.poolGate,
      surfacePolicy = this.surfacePolicy,
      donePollMs = 120,
      doneTimeoutMs = 2000,
      forceAct = false,
      force = false,
      staleRetry = false,
      candidatePriority = this.candidatePriority,
    } = opts;
    // U3：run 级 surface 策略必须进**每一次**抽池（_extractPoolSettled 读实例字段）。
    this.surfacePolicy = surfacePolicy;

    // The navigation envelope: run-level declaration wins, else the middleware's
    // (set once for a whole journey by the app runner from `pack.hosts`).
    const hostGate = hosts ?? this.hosts;
    // P2 command space: the ordered closed set for THIS subgoal. Progress is per-run
    // local state (a retry re-runs the whole subgoal, so the space restarts walking
    // from the top — exactly the `retries` contract).
    const cmdSpace: CommandDecl[] = (commands ?? []).filter((c) => c && typeof c.id === "string");
    const cmdDone = new Set<string>();
    let cmdI = 0;
    /** A2：每条命令已试过的候选数（最多 CMD_CANDIDATE_ATTEMPTS 个，全败不静默 done）。 */
    const CMD_CANDIDATE_ATTEMPTS = 4;
    const cmdAttempts: Record<string, number> = {};
    // A1（2026-11 真站实测）：act 是多动作命令闭集（N≥2）时，done 必须等**全部命令走完**才评估——
    // 以前每个动作后都判一次 done，第一击点开菜单的中间态就能让信号成立（trace 里 hows 记了
    // clicked、status 却是 done），第二个命令从未执行，整轮"排序成功"全为假绿。"走完"沿用既有
    // walk 语义：skip 按定义解决、执行成功、或目标已 forbidden 而 walk 放行；中途某命令解析失败
    // 仍走既有 target_not_found / action_unsupported / needs_value 结构化停因（本改动不加诊断）。
    // N≤1（单动作/无命令步）恒真——评估时机逐字节不变；04-A 的"全部命令耗尽后才查信号"本来就是
    // 这个语义，本闸门只是把逐动作评估点对齐到它。
    const cmdWalkComplete = (): boolean => cmdSpace.length < 2 || cmdDone.size >= cmdSpace.length;
    // D3/R-4: element signature -> how many times this subgoal effectively drove it while the
    // done-signal stayed false. Keyed by SIGNATURE (refs are positional); see the check below.
    const effectiveRuns: Record<string, number> = {};

    const slots: Record<string, unknown> = { ...extractSlots(instruction), ...(slotsIn ?? {}) };
    // U1：步级显式值袋（与 slots 平行的作者声明面；只在决策路径的值请求里参与匹配）。
    const values: Record<string, unknown> = { ...(valuesIn ?? {}) };
    this.targetHints = (targetHints ?? []).filter((h) => !!h);
    this._hintI = 0;
    // A single hint keeps its old, whole-subgoal authority; a list hands
    // authority to currentHint() so it can walk the sequence.
    this.targetHint = this.targetHints.length ? null : targetHint;

    const trace: TraceStep[] = [];
    // A4：上一次子目标/上一次 run 没被 trace 取走的残留冲突诊断不跨步——本子目标从
    // 干净账本开始，避免"这一步行里出现上一步的冲突"这类错位证据。
    this._drainRefCollisions();
    // A2：候选上限命中原因同样按子目标重置（本次 run 的账）。
    this._choiceLimitReason = null;
    // A4：动作落 trace 时顺带取走引用冲突诊断。没有冲突 ⇒ 空对象 ⇒ 产物字段不变；
    // 有冲突 ⇒ 该步 trace 多一个 `ref_collision`（含选择器、匹配计数、回退结果），
    // 与既有 forbid/diagnostic 同一种"失败要能自解释"的口径。
    const refCollision = (): Record<string, unknown> => {
      const c = this._drainRefCollisions();
      return c === null ? {} : { ref_collision: c };
    };
    // A1 动作执行证据（全部"有才出现"）：
    //   executedCount  —— 本子目标真的执行了几个动作（零执行步骤的判据）；
    //   skippedActions —— "为什么没有动作"的结构化原因（命令被禁/目标歧义/不可操作/缺值…）；
    //   warnings       —— 运行期诚实警告（如 suspected_async）；
    //   donePreheld    —— 命令步动作前对 done 的一次预评估（只记录，不改变执行顺序）。
    let executedCount = 0;
    const skippedActions: SkippedAction[] = [];
    const warnings: string[] = [];
    let donePreheld: boolean | null = null;
    /** A2：target_not_found 现场发现的滚动容器事实（进 diagnostics 的结构化证据）。 */
    let viewportUnderloaded: Array<{ tag: string; id: string; scrollHeight: number; clientHeight: number; rendered: number }> | null = null;
    /** 零执行摘要（A1 §2.2.2）：命令闭集走完而一个动作都没执行时，把跳过证据写进停因文案。 */
    const zeroExecSummary = (): string => {
      if (executedCount > 0) return "";
      const why = skippedActions.slice(0, 6)
        .map((s) => `${s.command_id ?? s.ref ?? "?"}:${s.reason}`)
        .join(", ");
      return ` — executed 0 action(s); skipped: ${why || "-"}; see skipped_actions`;
    };
    /** 挂在动作/尝试 trace 行上的声明面证据（缺省不出现；每步开头重置 donePreheld）。 */
    const actionDeclEvidence = (): Record<string, unknown> => ({
      ...(donePreheld === true ? { done_preheld: true } : {}),
      ...(forceAct ? { force_act: true } : {}),
    });
    /** A1：一条被跳过的命令/动作（原因单一出处，trace 行与 skipped_actions 共用）。
     *  同一 (command_id, ref, reason) 只记一次——多步 walk 里同一命令被"已禁"而越过多轮时，
     *  重复条目只会让产物变长，不增加信息。 */
    const seenSkipped = new Set<string>();
    const noteSkipped = (s: SkippedAction): void => {
      const key = `${s.command_id ?? ""}\u0000${s.ref ?? ""}\u0000${s.reason}`;
      if (seenSkipped.has(key)) return;
      seenSkipped.add(key);
      skippedActions.push(s);
    };
    // A1 子改动③：逐步动作后的轻量 after 签名 {url, pool_size, first_text}，挂在**已执行动作**
    // 的 trace 事件上。动作事件先落账，签名在下一次观察（下一动作步首的那次池提取——内存里
    // 已有的池）补上，它就是上一动作后的页面状态；复用既有提取、零新增页面往返。相邻两个动作
    // 事件的 after.first_text 对一眼，即可判"点击成功但列表是否前进"。done 立即成立的最后动作
    // 没有下一次观察，不补（完成已由信号裁决）；补签动作见循环头部的落账点。
    let pendingAfterIdx: number | null = null;
    let done = false;
    let manualDone = false;          // done because a HUMAN attested, not a DOM signal
    let dryRan = false;              // stopped at the dry-run probe (nothing executed)
    // S1 状态层：本 run 的首个观察指纹 / 最后一次 effect / pre-held done 是否出现过。
    let beforeFp: StateFingerprint | null = null;
    let lastEffect: StateEffect | null = null;
    let donePreheldSeen = false;
    let stopCode: StopCode = "max_steps";
    // 03-D5：这个默认值只在"动作循环自然用满、没有任何站点显式 stop"时存活——以前 reason
    // 就是裸三个字符（对比 no_progress 的详文），作者无从判断预算与进度。现在带数字。
    let stopReason =
      `subgoal action budget used up (${this.maxSteps} action step(s) tried) without the done-signal ever holding — `
      + `raise the budget, narrow the target, or check what the page did after each action`;
    let stopStep: number | undefined;
    let lastPoolSize = 0;
    let lastPoolWaitedMs = 0;
    /** U3：最后一次池空判档（ready 由正常路径覆盖不落此变量；not_ready/ready_empty 进 diagnostics）。 */
    let lastReadiness: Readiness | null = null;
    /** U3：ready_empty 的 warning 同一 run 只出一条（步级 flag 每步照记）。 */
    let readyEmptyWarned = false;
    /** U3：本 run 是否出现过 ready_empty（池空但已就绪）——进 flags，不改变 done 语言。 */
    let poolEmptyThisStep = false;
    /** ONE place where the loop decides to stop (D1/D4): sets code + step, and the
     *  human string when given. Every stop site goes through here. */
    const stop = (code: StopCode, detail?: string, at?: number): void => {
      stopCode = code;
      if (detail !== undefined) stopReason = detail;
      if (at !== undefined) stopStep = at;
    };
    const forbidden: Record<string, Sig> = {};                 // ref -> element signature (esig)
    // WHY each ref was forbidden — diagnostics only (D1: "which of the seven
    // egresses killed this element" used to require reading the code).
    const forbidWhy: Record<string, string> = {};
    // refs skipped ONLY because an overlay blocked them: retryable once the page
    // changes (the blocker may be gone); never counted as exhausted.
    const blockedRetry: Record<string, [number, number]> = {};  // ref -> (step, len(trace))
    const reAdmitted = new Set<string>();
    /** THE forbid egress (D1): an element leaves the action space exactly here.
     *  Seven call sites used to assign the signature directly, each with its own
     *  trace shape; the assignment is now single-sourced. */
    const forbid = (ref: string, el: Elem, why: string): void => {
      forbidden[ref] = esig(el);
      forbidWhy[ref] = why;
    };
    /** THE un-forbid egress (re-admission after a page change removes the blocker). */
    const unforbid = (ref: string): void => {
      delete forbidden[ref];
      delete blockedRetry[ref];
      delete forbidWhy[ref];
    };
    /**
     * THE re-prune egress (D2): forbiddances key on refs, and refs are re-indexed
     * on every scan — a stale forbid now pointing at a DIFFERENT element must go.
     * This same invariant used to be hand-written at three sites (step head,
     * wider re-scan, overlay re-entry); one implementation now.
     */
    const pruneForbids = (elems: ElemPool): void => {
      for (const r of Object.keys(forbidden)) {
        const cur = elems[r];
        if (cur === undefined || !sigEq(forbidden[r]!, esig(cur))) {
          unforbid(r);
          reAdmitted.delete(r);
        }
      }
    };
    let page: AnyPage | null = pageIn;
    const ownsBrowser = page === null;
    let browser: BrowserHandle | null = null;
    /** S1：本 run 的 StepStateRecord（在收尾处组装；无观察时省略）。 */
    let stepState: StepStateRecord | undefined;

    try {
      // S1：每次 run 重置状态游标（epoch/navEpoch 都是**本次 run** 的口径）。
      this._state = { epoch: 0, navEpoch: 0, current: null };
      this._lastActionabilityDetail = null;
      this._settleWaitMs = 0;
      // S5：上次 ask 的题面/答复与 run 内 flags 都是 run 内口径（refs 会重编号）；指标不重置。
      this._lastAsk = null;
      this._askedPools.clear();
      this._runFlags = [];
      this._lastEffectSeen = null;
      await this.ready();
      // A config error is not a transient failure: acting on rules-only anyway would
      // silently downgrade what the operator explicitly configured, and retrying it
      // just repeats the same error with more side effects (D6). Refuse cleanly,
      // BEFORE the navigation envelope and before a single step.
      if (this.configError !== null) {
        const why = `model runtime config error: ${this.configError}`;
        if (verbose) console.log(`  -> REFUSED before navigation: ${why}（配置类错误不重试、不降级跑）`);
        return {
          goal: instruction, done: false,
          stop_reason: why, stop_code: "config_error",
          steps: [],
          audit: { verdict: "REJECT", reasons: [why], auditor: "preflight" },
        };
      }
      // NAVIGATION ENVELOPE (P0-4): refuse BEFORE the browser opens the page. A
      // refused subgoal has touched nothing — zero steps, zero side effects.
      const deniedHost = disallowedHost(startUrl, hostGate);
      if (deniedHost !== null) {
        const why = `host not allowed: '${deniedHost}' is not among the declared hosts `
          + `(${hostGate!.join(", ")}) — add it to the pack's hosts list if this step is meant to leave for it`;
        if (verbose) console.log(`  -> REFUSED before navigation: ${why}`);
        return {
          goal: instruction, done: false,
          stop_reason: why, stop_code: "host_not_allowed",
          steps: [],
          audit: { verdict: "REJECT", reasons: [why], auditor: "navigation-envelope" },
        };
      }
      if (ownsBrowser) {
        // PORT NOTE 5: `sync_playwright()` has no twin; the module IS the
        // connection. Use the injected pw when given, else the imported one.
        let pw = pwIn;
        if (pw === null) {
          const mod = await import("playwright");
          pw = { chromium: mod.chromium as unknown as PwLike["chromium"] };
        }
        browser = (await browserEnv.launch(pw, true)) as unknown as BrowserHandle;
        page = (await browser.newPage()) as AnyPage;
      }
      const pg = page as AnyPage;
      /**
       * S1：生成一次状态指纹并推进 cursor。`elems` 用**已有观察**（步首池）传进来；
       * 收尾处才允许传 null（此时由调用方决定是否先重新抽池）。只读，不发动作。
       */
      const observeState = async (elems: ElemPool | null): Promise<StateFingerprint> => {
        this._state.epoch += 1;
        let url = "";
        try { url = String(urlOf(pg as never) ?? ""); } catch { url = ""; }
        let readyState: ReadyState = "complete";
        try {
          const rs = await pg.evaluate(() => {
            const g = globalThis as unknown as { document?: { readyState?: unknown } };
            return g.document?.readyState;
          });
          if (rs === "loading" || rs === "interactive" || rs === "complete") readyState = rs;
        } catch { /* 页面已关闭：readyState 只是诊断，不阻塞收尾 */ }
        const struct = structDigest(elems);
        const content = contentDigest(elems);
        const fp: StateFingerprint = {
          epoch: this._state.epoch,
          navEpoch: this._state.navEpoch,
          url,
          readyState,
          struct,
          ...(content === undefined ? {} : { content }),
        };
        this._state.current = fp;
        return fp;
      };
      if (opts.skipNavigation !== true) {
        await pg.goto(startUrl, { waitUntil: "domcontentloaded", timeout: this.gotoTimeout });
        this._state.navEpoch += 1;
        // S2：导航会丢掉 window 上下文——observer 在 goto 后重装（幂等；只作传感器）。
        if (this.settlePolicy !== null) await installSettle(pg as unknown as SettlePage);
        if (typeof opts.settleMs === "number" && opts.settleMs > 0) {
          await new Promise((r) => setTimeout(r, opts.settleMs));
        }
      }
      if (hostGate && hostGate.length) {
        const deniedPopup = deniedContextUrl(pg, hostGate);
        if (deniedPopup !== null) {
          const why = `popup not allowed: ${deniedPopup} is outside the declared hosts envelope `
            + `(${hostGate.join(", ")}) — popup/new-tab origins are part of the same host gate`;
          if (verbose) console.log(`  -> REFUSED before navigation: ${why}`);
          return {
            goal: instruction, done: false,
            stop_reason: why, stop_code: "popup_not_allowed",
            steps: [],
            audit: { verdict: "REJECT", reasons: [why], auditor: "navigation-envelope" },
          };
        }
        const deniedFrame = deniedFrameUrl(pg, hostGate);
        if (deniedFrame !== null) {
          const why = `frame not allowed: ${deniedFrame} is outside the declared hosts envelope `
            + `(${hostGate.join(", ")}) — frame origins are part of the same host gate`
            + `；若该 widget/iframe 是流程必需（如 Google apps 抽屉在 ogs.google.com），把它的 origin 加进 meta.hosts 后重跑`;
          if (verbose) console.log(`  -> REFUSED before navigation: ${why}`);
          return {
            goal: instruction, done: false,
            stop_reason: why, stop_code: "frame_not_allowed",
            steps: [],
            audit: { verdict: "REJECT", reasons: [why], auditor: "navigation-envelope" },
          };
        }
      }
      // "Does this step apply?" — asked on the page the step will act on, before
      // spending a single step. A skipped subgoal reports done, so the plan
      // moves on exactly as if the step had succeeded.
      if (precondition !== null && precondition !== undefined && !(await checkSignal(pg, precondition))) {
        if (verbose) console.log(`    -> SKIPPED (precondition not met: ${JSON.stringify(precondition)})`);
        return {
          goal: instruction, done: true, skipped: true,
          stop_reason: "precondition not met -> skipped", stop_code: "precondition_skipped", steps: [],
          audit: { verdict: "SKIPPED", reasons: ["precondition not met"], auditor: "n/a" },
        };
      }

      for (let stepNo = 1; stepNo <= this.maxSteps; stepNo++) {
        // A1：done_preheld 是**逐步**事实——每步开头重置，避免上一步的值被本步的 trace 行
        // 或最终 RunReport 误带（只有命令步会在下面重新评估它）。
        donePreheld = null;
        // P0 pool ready gate：SPA 的 domcontentloaded 可能先于交互元素渲染。
        // 这里只做“pool 非空”这一件事；目标是否存在、动作是否可执行仍由后面分支判断。
        let elems: ElemPool;
        let poolWaitedMs = 0;
        /** U3：闸门最后一次 settle 的结论与真实预算（判档证据；非池空路径不产生）。 */
        let gateSettle: SettleResult | null = null;
        let gateBudgetMs = 0;
        if (poolReady) {
          const readyStarted = Date.now();
          gateBudgetMs = Math.max(0, poolReadyTimeoutMs);
          const readyDeadline = readyStarted + gateBudgetMs;
          // C8：每轮 settle 的 timeout 都由 _extractPoolSettled 钳到剩余预算 ⇒ 总等待有真上限
          // （以前每轮 settle 最长可阻塞到 5s，声明 700ms 的窗口实际可超冲到 ~5.1s）。
          let ex = await this._extractPoolSettled(pg, candidatePriority, readyDeadline);
          elems = ex.elems; gateSettle = ex.settle;
          while (Object.keys(elems).length === 0 && Date.now() < readyDeadline) {
            const remaining = readyDeadline - Date.now();
            await sleep(Math.max(0, Math.min(poolReadyPollMs, remaining)));
            if (Date.now() >= readyDeadline) break;   // 预算耗尽：不再起一轮会越界的 settle
            ex = await this._extractPoolSettled(pg, candidatePriority, readyDeadline);
            elems = ex.elems; gateSettle = ex.settle;
          }
          poolWaitedMs = Date.now() - readyStarted;
        } else {
          elems = (await this._extractPoolSettled(pg, candidatePriority)).elems;
        }
        lastPoolSize = Object.keys(elems).length;
        lastPoolWaitedMs = poolWaitedMs;
        // S1：本 run 的 before 指纹取**第一次已有观察**（步首池），零新增页面往返。
        if (beforeFp === null) beforeFp = await observeState(elems);
        // A1 子改动③：上一次已执行动作的 after 签名在这里落账——本步步首的这次提取就是上一动作
        // 后的页面状态。放在 walk/hintLookup 之前（hint 注入的元素不算观察事实）、放在 poolReady
        // 空池停因之前（动作后页面真被清空也照实记 {pool_size:0}）。
        if (pendingAfterIdx !== null) {
          const prev = trace[pendingAfterIdx];
          if (prev !== undefined && prev.after === undefined) {
            const ft = firstPoolText(elems);
            prev.after = {
              url: urlOf(pg),
              pool_size: lastPoolSize,
              ...(ft === null ? {} : { first_text: ft }),
            };
          }
          pendingAfterIdx = null;
        }
        if (poolReady && Object.keys(elems).length === 0) {
          // U3 四档判档（§5.3，唯一出处）：池空 ≠ 页面未就绪。
          //   not_ready    —— 预算耗尽且 settle 未静默 / readyState 未达（真未就绪，保留 run 级停因）；
          //   ready_empty  —— 预算耗尽但页面已就绪且池为 0（步级事实 + warning，**继续**）；
          //   strict       —— 逃生口：ready_empty 改判 not_ready（U3 之前的快败行为）。
          const readiness = await this._poolReadiness(pg, gateSettle, poolWaitedMs, gateBudgetMs, 0);
          lastReadiness = readiness;
          const strict = poolGate === "strict";
          if (readiness.verdict === "not_ready" || strict) {
            if (strict && readiness.verdict === "ready_empty") readiness.verdict = "not_ready";
            const ev = readiness.evidence;
            stop("page_not_ready",
              `page not ready: element pool stayed empty after ${ev.waited_ms}ms `
              + `(budget_ms=${ev.budget_ms}, settled=${String(ev.settled)}, `
              + `settle_timed_out=${String(ev.settle_timed_out)}, readyState=${ev.ready_state}`
              + `${strict ? ", pool_gate=strict" : ""}) on step ${stepNo}`, stepNo);
            if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
            break;
          }
          // ready_empty：池空但页面已就绪 = 页面事实，不是未就绪证据。记证据后继续，
          // 让后续命令/信号给出真正的失败原因（不再整页判死）。
          poolEmptyThisStep = true;
          if (!readyEmptyWarned) {
            readyEmptyWarned = true;
            warnings.push(
              `pool_empty: the pool stayed empty although the page is settled and readyState=complete `
              + `(step ${stepNo}; sniff admitted=${readiness.evidence.sniff?.admitted ?? 0} visible ADMIT_SEL element(s), `
              + `focusable=${readiness.evidence.sniff?.focusable ?? 0}, aria=${readiness.evidence.sniff?.aria ?? 0}, `
              + `frames=${readiness.evidence.sniff?.frames ?? 0}, body_text=${readiness.evidence.sniff?.body_text ?? 0}) `
              + `— continuing; pool_gate:"strict" would stop with page_not_ready`,
            );
          }
        }
        // A1 §2.2.3：命令步在解析/动作前评估一次 done 并记录 done_preheld（**决策步不付**这次
        // 评估）。默认不改变执行：既有流程照旧动作，这个记录只回答"动作前信号是否已成立"——
        // 否则一次 done=true 分不清是"动作推进了页面"还是"信号本来就成立、动作只是搭便车"。
        // forceAct 的语义是"即使已成立也先把闭集执行完再评估"，与现状一致，故只记录声明。
        if (cmdSpace.length > 0 && goalSignalFn && !dryRun) {
          try {
            donePreheld = (await goalSignalFn(pg)) === true;
          } catch (e) {
            // 预评估只是**证据**，不是完成裁决：信号本身有问题时不要把它变成比真正停因
            // 更早的崩溃。动作后的既有评估点照常暴露错误（那才是会改变结论的评估）。
            donePreheld = null;
            warnings.push(`done_preheld_probe_failed: ${describeActionError(e)}`);
          }
        }
        // S1 pre-held done 策略（动作**之前**判定；缺省 warn = 行为不变）：
        //   fail  —— 在动作前停住：pre-held 的 done 不是这一步的动作证据，继续动作只会
        //            制造“零执行通过/顺手通过”；步级 forceAct 显式要求先动作，优先于 fail。
        //   warn  —— 只记 flag + run summary warning（默认）。
        //   allow —— 显式接受，只留 flag。
        if (donePreheld === true) {
          donePreheldSeen = true;
          if (this.donePreheldPolicy === "fail" && !forceAct) {
            stop("done_preheld",
              `done signal already held BEFORE this step's actions on step ${stepNo} `
              + `(policy.done_preheld="fail") — the completion is not evidence of this step; `
              + `anchor done to post-action evidence, or set forceAct:true / policy.done_preheld:"warn"`, stepNo);
            if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
            break;
          }
          if (this.donePreheldPolicy === "warn") {
            const warning = `done_preheld: the done signal already held before this step's actions `
              + `(step ${stepNo}) — completion is not evidence of progress; anchor done to post-action evidence`;
            if (!warnings.some((w) => w.startsWith("done_preheld:"))) warnings.push(warning);
          }
        }
        // OUTCOME MEMORY: skip elements a previous attempt already proved inert on
        // this page+subgoal — but only while something else remains to choose from
        // (a remembered element must never empty the pool).
        let prevented = 0;
        let noted: Record<string, string> | null = null;
        this._learnedHintApplied = false;
        this._hintKey = hintMemory ? hintMemory.key(urlOf(pg), instruction) : "";
        // OUTCOME MEMORY — two ways to use "this element did nothing last time":
        //   forbid: remove it, but only while something else remains (never empty the pool)
        //   rank:   keep it and SAY SO in the model's view, so the MODEL decides —
        //           annotating the observation instead of gating the action
        if (outcomeMemory) {
          const inert = outcomeMemory.inertIn(outcomeMemory.key(urlOf(pg), instruction));
          if (inert.size) {
            const candidates = Object.entries(elems)
              .filter(([r, e]) => inert.has(JSON.stringify(esig(e))) && forbidden[r] === undefined);
            if (outcomeMemoryMode === "rank") {
              if (candidates.length) {
                noted = {};
                for (const [r] of candidates) noted[r] = "[tried before, page did not change]";
              }
            } else {
              const remaining = Object.keys(elems).length - Object.keys(forbidden).length - candidates.length;
              if (remaining >= 1) {
                for (const [r, e] of candidates) forbid(r, e, "outcome-memory");
                prevented = candidates.length;
                outcomeMemory.countPrevented?.(prevented);
                if (verbose && prevented) {
                  console.log(`  step ${stepNo}: outcome memory skipped ${prevented} inert element(s)`);
                }
              }
            }
          }
        }
        // S2 ③ 运行期接线（改版）：提名族是**软先验**，不是第一道过滤器——族内元素排前面，
        // 其他族元素**仍在候选里**（它们既可能是真目标，也可能是解出目标的上下文：自定义控件
        // 的结构族 ≠ 语义动作）。真正"只在该族里找"只发生在**有界修复**那一次（走向停止才付）。
        const orderedPool = (pool: ElemPool = elems): ElemPool =>
          expectedFamily === null ? pool : orderElemsByFamily(pool, expectedFamily);
        let reobserved = false;          // at most ONE wider look per step
        let escalated = false;           // at most ONE escalation per step
        let escalatedPick: string | null = null;
        // FW8 声明驱动的身份回捞（identity recovery）：只服务**这一步作者声明的目标**
        // （命令 target / act hint / plan target_hint 走同一执行器路径）——决策步与模型
        // 选出的元素永不走这里。形状白名单与跨 frame 可见性匹配在 extraction.identityLookup；
        // `identityTried` 保证同一步里同一条 hint 只尝试一次。
        const identityTried = new Set<string>();
        let identity: {
          ref: string; target: string; shape: string; attr: string; value: string;
          matches: number; total_matches: number; hidden_matches: number; frame: number;
        } | null = null;
        let identityCleanup: (() => Promise<void>) | null = null;
        /** 身份面已在**外部循环**里给出的结构化停因（能力/歧义）；命令循环结束后统一执行。 */
        let identityStop: { code: StopCode; reason: string } | null = null;
        /** 身份回捞命中但全不可见：按 0 处理（绝不操作隐藏元素），只留诊断证据。 */
        let identityHidden: { target: string; hidden: number; total: number } | null = null;
        /** 与 A3 同纪律：章只服务本次动作定位，动作尝试一结束就清。 */
        const cleanupIdentity = async (): Promise<void> => {
          if (identityCleanup === null) return;
          const fn = identityCleanup;
          identityCleanup = null;
          try { await fn(); } catch { /* 清理失败不阻断：章值唯一，残留不会误指 */ }
        };
        const identityEvidence = (): Record<string, unknown> => (identity === null ? {} : {
          resolved_by: "dom_identity",
          identity: {
            target: identity.target, shape: identity.shape, attr: identity.attr, value: identity.value,
            matches: identity.matches, total_matches: identity.total_matches,
            hidden_matches: identity.hidden_matches, frame: identity.frame,
          },
        });
        /** FW8：命中但全不可见时的停因补充（诊断必须带隐藏匹配计数）。 */
        const identityHiddenSuffix = (): string => identityHidden === null ? ""
          : ` — identity recovery: ${JSON.stringify(identityHidden.target)} matched `
            + `${identityHidden.total} element(s) in the DOM but ${identityHidden.hidden} are hidden `
            + `(checkVisibility CSS / zero box); hidden elements are never acted on`;
        // P2 COMMAND SPACE — the step's action is chosen ON THE CLOSED SET, not on the pool:
        // `instantiateSpace` semantics implemented as the walk below (declaration × this
        // step's observation; a command resolving to nothing is OUT — with the same
        // "the plan-named target is never eaten by the budget" recovery hints get — and
        // nothing left is a structured stop, NEVER a fallback to the full pool, NEVER a
        // model pick). Order is decided by the declaration and the page, not by scoring;
        // completion truth stays the subgoal signal (红线③ untouched).
        let cmdPick: { cmd: CommandDecl; ref: string; index: number; cands: string[] } | null = null;
        if (cmdSpace.length) {
          const scans = new Set(Object.values(elems).map((x) => x.scan));
          let pendingUnresolved: string[] = [];
          for (let i = cmdI; i < cmdSpace.length; i++) {
            const c = cmdSpace[i]!;
            if (cmdDone.has(c.id)) continue;
            if (c.op === "skip") {          // skip: resolves by definition, moves the page not at all
              cmdDone.add(c.id);
              cmdI = i + 1;
              continue;
            }
            const target = c.target ?? "";
            if ((cmdAttempts[c.id] ?? 0) >= CMD_CANDIDATE_ATTEMPTS) {
              // A2：一条命令最多试前 4 个可行动候选；到顶仍没成 = 这条命令在本步 OUT
              //（记 attempt_limit 证据；后续 done 成立/不成立都有零执行摘要，不静默 done）。
              noteSkipped({
                command_id: c.id, target: c.target ?? null, reason: "attempt_limit",
                detail: `${CMD_CANDIDATE_ATTEMPTS} candidate(s) tried without success`,
              });
              cmdDone.add(c.id);
              cmdI = i + 1;
              continue;
            }
            // A2：可行动优先的候选列表（`null` 起 = 池里没有这个目标，先做一次 DOM 回捞）。
            let candRefs = this.resolveCommandRef(target, elems, String(c.op), new Set(Object.keys(forbidden)));
            if (candRefs.length === 0 && target !== "" && hintCandidates(target, elems) === null) {
              for (const [ref, e] of Object.entries(await hintLookup(pg, target, admitSelectorWithJsFor(this.surfacePolicy)))) {
                // U3/C10：回捞去重按**节点身份**（已带 data-dshref = 已在池），不再比 scan 序号——
                // 回捞面(ADMIT_SEL)与池面(POOL_SEL)两套序号空间本就不可比。
                if (!e.dsh_ref) elems[ref] = e;
              }
              pruneForbids(elems);
              candRefs = this.resolveCommandRef(target, elems, String(c.op), new Set(Object.keys(forbidden)));
            }
            // FW8：池 + hint 回捞都空之后，做**一次**声明驱动的身份回捞（形状白名单见
            // extraction.identityHintInfo）。只在这一步作者声明的 target 上发生——模型面永不参与。
            if (candRefs.length === 0 && target !== "" && hintCandidates(target, elems) === null
                && !identityTried.has(target)) {
              identityTried.add(target);
              const idr = await identityLookup(pg, target);
              if (idr.eligible) {
                // 约束 3：可见匹配 > 1 = 歧义（rows 只在恰好 1 个可见匹配时非空）。
                const visibleMatches = idr.total_matches - idr.hidden_matches;
                if (visibleMatches > 1) {
                  for (const cand of idr.candidates.filter((x) => x.visible)) {
                    noteSkipped({
                      command_id: c.id, target, ref: `identity:${cand.tag}${cand.id ? `#${cand.id}` : ""}`,
                      reason: "target_ambiguous",
                      detail: `${visibleMatches} visible identity match(es) for ${JSON.stringify(target)}; never guessed`,
                    });
                  }
                  const reason = `command ${JSON.stringify(c.id)} identity target ${JSON.stringify(target)} `
                    + `(${idr.shape}, ${idr.attr}=${JSON.stringify(idr.value)}) matches ${visibleMatches} `
                    + `visible element(s) across frames (total=${idr.total_matches}, hidden=${idr.hidden_matches}) `
                    + `— candidates: ${formatIdentityCandidates(idr.candidates)}. Identity recovery never guesses `
                    + `among several matches; narrow the declaration to a unique id/data-test/name on step ${stepNo}`;
                  await idr.cleanup();
                  identityStop = { code: "target_ambiguous", reason };
                  break;
                }
                if (idr.rows.length === 1) {
                  const el = idr.rows[0]!;
                  const ref = String(el.ref ?? "dom:0");
                  identity = {
                    ref, target, shape: idr.shape, attr: idr.attr, value: idr.value,
                    matches: 1, total_matches: idr.total_matches,
                    hidden_matches: idr.hidden_matches, frame: Number(el.frame ?? 0),
                  };
                  identityCleanup = idr.cleanup;
                  // 只进**本步解析用的局部池**：命令面不再询问模型（cmdPick 直接解析出 ref），
                  // 所以它不会进入 ChoiceRequest.elems；下一步重新抽池即消失。
                  elems[ref] = el;
                  pruneForbids(elems);
                  const pickedRefs = this.resolveCommandRef(target, elems, String(c.op),
                    new Set(Object.keys(forbidden)));
                  cmdPick = {
                    cmd: c, ref: pickedRefs[0] ?? ref, index: i,
                    cands: (pickedRefs.length ? pickedRefs : [ref]).slice(0, CMD_CANDIDATE_ATTEMPTS),
                  };
                  break;
                }
                // 0 可见：保持今天的失败路径（后续候选 / 最终 target_not_found）；隐藏匹配只作证据。
                if (idr.hidden_matches > 0) {
                  identityHidden = { target, hidden: idr.hidden_matches, total: idr.total_matches };
                }
              }
            }
            pruneForbids(elems);
            if (candRefs.length > 0) {
              cmdPick = { cmd: c, ref: candRefs[0]!, index: i, cands: candRefs.slice(0, CMD_CANDIDATE_ATTEMPTS) };
              break;
            }
            if (hintCandidates(target, elems) === null) {
              pendingUnresolved.push(c.id);
              noteSkipped({ command_id: c.id, target: c.target ?? null, reason: "target_not_found" });
              continue;
            }
            // 候选都在禁用面（动作阶段失败已由 forbid 记账）/ 不满足 op 能力：这条命令 OUT。
            // A1：这也是"没有动作"的一条证据——为什么这条命令被跳过。
            noteSkipped({
              command_id: c.id, target: c.target ?? null, reason: "forbidden",
              detail: `${cmdAttempts[c.id] ?? 0} candidate(s) tried, remaining candidates are forbidden`,
            });
            cmdDone.add(c.id);
            cmdI = i + 1;
          }
          // FW8：身份回捞给出的结构化停因（歧义）优先于后续命令选择——绝不"随便选一个"。
          if (identityStop !== null) {
            stop(identityStop.code, identityStop.reason, stepNo);
            if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
            break;
          }
          if (cmdPick === null) {
            // 区分“目标不存在”和“目标存在但歧义”：歧义不是空间为空，而是候选集 > 1。
            const ambiguous = cmdSpace.find((c) => {
              if (c.op === "skip" || !c.target) return false;
              // A2：已经试过候选的命令不再按"歧义"停——它的候选是被逐个尝试后禁用的。
              if ((cmdAttempts[c.id] ?? 0) > 0) return false;
              const cand = hintCandidates(c.target, elems);
              return cand !== null && cand.decided === null && cand.refs.length > 1;
            });
            if (ambiguous?.target) {
              const cand = hintCandidates(ambiguous.target, elems)!;
              // A1：歧义的每个候选都进 skipped_actions——零执行不能只剩一句停因文案。
              for (const candRef of cand.refs) {
                noteSkipped({
                  command_id: ambiguous.id, target: ambiguous.target, ref: candRef,
                  reason: "target_ambiguous",
                  detail: `${cand.refs.length} distinct candidates for ${JSON.stringify(ambiguous.target)}; never guessed`,
                });
              }
              stop("target_ambiguous",
                `command ${JSON.stringify(ambiguous.id)} matches ${cand.refs.length} distinct candidates `
                + `(${cand.refs.join(", ")}) for target ${JSON.stringify(ambiguous.target)} on step ${stepNo}`
                + zeroExecSummary(), stepNo);
              if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
              break;
            }
            if (cmdDone.size >= cmdSpace.length) {
              // 04-A：skip 命令"按定义解决"后从未评估过 done——宣布 "never held" 之前必须先查
              // 一遍信号（与 :2499 正常评估同形；不改评估顺序，只补这条死路的评估缺失）。
              // 这让"零动作验证步"（skip+done）从机制性必死变成合法可用。
              if (goalSignalFn && (await goalSignalFn(pg))) {
                done = true;
                // A1 §2.2.2：done 成立但一个动作都没执行时，停因文案必须带上跳过摘要
                //（done 来自"信号本来就成立"，不是伪造的执行证据）。
                stop("dom_goal_signal",
                  `dom goal signal (commands resolved without action; signal held)${zeroExecSummary()}`, stepNo);
                if (verbose) console.log(`  step ${stepNo}: -> done (signal held after exhausted commands, 04-A)`);
                break;
              }
              stop("done_not_held",
                `commands exhausted (${cmdDone.size}/${cmdSpace.length} acted) but the done-signal never held on step ${stepNo}`
                + zeroExecSummary(), stepNo);
            } else {
              // A2：目标"找不到"到底是页面没有、还是滚动容器里的内容没渲染（虚拟列表/懒加载）？
              // 失败路径上付一次廉价 DOM 探测，把 viewport_underloaded 事实写进停因（与 diagnostics）。
              const under = await viewportUnderload(pg);
              viewportUnderloaded = under.length ? under : null;
              const underNote = under.length
                ? ` — viewport_underloaded: `
                  + under.map((h) => `${h.tag}${h.id ? `#${h.id}` : ""} scrollHeight=${h.scrollHeight} `
                    + `> clientHeight=${h.clientHeight}, rendered children=${h.rendered}`).join("; ")
                  + `（目标可能在未渲染/视口外的滚动内容里；不自动滚动，按六步法② 用滚动/展开原语或收窄窗口取证）`
                : "";
              stop("target_not_found",
                `command space matches nothing on this page — pending unresolved: `
                + `${pendingUnresolved.join(", ") || "-"} (unresolvable candidates are OUT; the space never falls back to the full pool) on step ${stepNo}. `
                + HINT_CLOSED_SET_TEXT
                // A2 判别①：报错现场用内存里已有的池回答「目标不在页面上 vs 闭集没把它放进
                // 命令空间」（12 轮真站实测：9/11 轮把产品 UI 本来就没有的排序项误读成引擎池缺陷）。
                + cmdDiscrimination(cmdSpace, pendingUnresolved, elems)
                // FW8：身份回捞匹配到了、但**全不可见**——按 0 处理，把隐藏匹配数作为诊断证据。
                + (identityHidden === null ? ""
                  : ` — identity recovery: ${JSON.stringify(identityHidden.target)} matched `
                    + `${identityHidden.total} element(s) in the DOM but ${identityHidden.hidden} are hidden `
                    + `(checkVisibility CSS / zero box); hidden elements are never acted on`)
                + underNote, stepNo);
            }
            if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
            break;
          }
        }
        // A frozen plan that NAMES its target must never be blocked by the
        // extraction budget: retrieve the hinted element(s) into the pool when
        // they were evicted. And a hint whose element is already forbidden is
        // "this action is done" for an ORDERED sequence (`target_hints`): advance
        // and RESOLVE THE NEXT HINT IN THE SAME STEP. Advancing without
        // re-resolving handed the very next action to the model — measured on the
        // live saucedemo logout step, whose menu click is classified `inert`
        // (opening a CSS sidebar changes no url/text/input value), so in
        // rules-only mode the subgoal blocked with "needs a model pick" even
        // though the ordered hint list named the logout link all along.
        let curHint = cmdSpace.length ? null : this.currentHint();
        for (let guard = 0; curHint !== null && guard < 8; guard++) {
          if (hintMatch(curHint, elems) === null) {
            for (const [ref, e] of Object.entries(await hintLookup(pg, curHint, admitSelectorWithJsFor(this.surfacePolicy)))) {
              // U3/C10：节点身份去重（见命令路径同一处注释）。
              if (!e.dsh_ref) elems[ref] = e;
            }
            // FW8：act hint 的**声明面**身份回捞——池 + hint 回捞都落空后才尝试，同一步同一
            // hint 只试一次。决策步（无 act）不会来到这里；命中结果只进本步局部池，模型面
            // 永远不会看到它（下面 rule 命中直接给出 ref，不构造 ChoiceRequest）。
            if (hintMatch(curHint, elems) === null && !identityTried.has(curHint)) {
              identityTried.add(curHint);
              const idr = await identityLookup(pg, curHint);
              if (idr.eligible) {
                // 约束 3：可见匹配 > 1 = 歧义（rows 只在恰好 1 个可见匹配时非空）。
                const visibleMatches = idr.total_matches - idr.hidden_matches;
                if (visibleMatches > 1) {
                  for (const cand of idr.candidates.filter((x) => x.visible)) {
                    noteSkipped({
                      ref: `identity:${cand.tag}${cand.id ? `#${cand.id}` : ""}`, reason: "target_ambiguous",
                      detail: `${visibleMatches} visible identity match(es) for ${JSON.stringify(curHint)}; never guessed`,
                    });
                  }
                  await idr.cleanup();
                  identityStop = {
                    code: "target_ambiguous",
                    reason: `target_hint ${JSON.stringify(curHint)} identity declaration (${idr.shape}, `
                      + `${idr.attr}=${JSON.stringify(idr.value)}) matches ${visibleMatches} visible element(s) `
                      + `across frames (total=${idr.total_matches}, hidden=${idr.hidden_matches}) — candidates: `
                      + `${formatIdentityCandidates(idr.candidates)}. Identity recovery never guesses among `
                      + `several matches; narrow the hint to a unique id/data-test/name on step ${stepNo}`,
                  };
                } else if (idr.rows.length === 1) {
                  const el = idr.rows[0]!;
                  const ref = String(el.ref ?? "dom:0");
                  identity = {
                    ref, target: curHint, shape: idr.shape, attr: idr.attr, value: idr.value,
                    matches: 1, total_matches: idr.total_matches,
                    hidden_matches: idr.hidden_matches, frame: Number(el.frame ?? 0),
                  };
                  identityCleanup = idr.cleanup;
                  elems[ref] = el;
                } else if (idr.hidden_matches > 0) {
                  // 全不可见：视为 0，保持今天的失败路径（act hint → 模型回退）；
                  // 隐藏匹配只作诊断证据，绝不操作隐藏元素。
                  identityHidden = { target: curHint, hidden: idr.hidden_matches, total: idr.total_matches };
                }
              }
            }
          }
          // drop forbids whose ref now points at a different element
          pruneForbids(elems);
          // A dead hint means "this action is done/failed" for an ordered
          // sequence: move to the next one instead of burning the subgoal.
          const dead = hintMatch(curHint, elems);
          if (dead !== null && dead in forbidden && this._hintI < this.targetHints.length - 1) {
            this._advanceHint();
            curHint = this.currentHint();
            continue;
          }
          break;
        }
        // FW8：身份歧义是结构化停因，绝不回退"随便选一个"或交给模型猜。
        if (identityStop !== null) {
          stop(identityStop.code, identityStop.reason, stepNo);
          if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
          break;
        }
        if (identityHidden !== null) {
          warnings.push(`identity_hidden: target ${JSON.stringify(identityHidden.target)} matched `
            + `${identityHidden.total} element(s) in the DOM but ${identityHidden.hidden} are hidden `
            + `(checkVisibility CSS / zero box) — not acted on; the step continues on the declared failure path`);
        }
        const commandMode = cmdSpace.length > 0;
        // resolve the picked command's parameter binding NOW (fill/select). A missing
        // declared binding is a STRUCTURED `needs_value` stop, never a guess (红线②):
        // the value's only source is the plan's data bag, named by `value.key`.
        let commandValue: unknown;
        let commandByValue = false;
        let commandBindMissing: string | null = null;
        if (commandMode && cmdPick
            && (cmdPick.cmd.op === "fill" || cmdPick.cmd.op === "select"
              || cmdPick.cmd.op === "drag" || cmdPick.cmd.op === "upload"
              || cmdPick.cmd.op === "clickAt")) {
          // P3: an `option` source is an OBSERVATION at bind time — read this page's
          // candidate list now (never assumed, never remembered from another run).
          const boundEl = elems[cmdPick.ref];
          let boundOptions: OptionCandidate[] | undefined;
          if (cmdPick.cmd.value?.from === "option") {
            boundOptions = boundEl ? await this._optionCandidates(pg, boundEl) : [];
          }
          // T3：失败文案的诊断上下文（命令 id/target、已声明 slots 键、目标控件身份、
          // 该步可行动候选）。只影响 reason；解析语义与成功路径不变。
          const bindingDiag: BindingDiagnostics = {
            command: { id: cmdPick.cmd.id, target: cmdPick.cmd.target ?? null },
            slotKeys: Object.keys(slots),
            ...(boundEl === undefined ? {} : {
              control: {
                tag: boundEl.tag,
                ...(boundEl.label ? { label: boundEl.label } : {}),
                ...(boundEl.name ? { name: boundEl.name } : {}),
                ...(boundEl.id ? { id: boundEl.id } : {}),
                ...(boundEl["data_test"] ? { data_test: String(boundEl["data_test"]) } : {}),
              },
            }),
            ...(() => {
              const cands = bindingCandidateSummaries(elems, cmdPick!.ref, String(cmdPick!.cmd.op));
              return cands.length ? { candidates: cands } : {};
            })(),
          };
          const rv = resolveCommandValue(cmdPick.cmd, slots, {
            options: boundOptions, dataset: dataset ?? undefined, diag: bindingDiag,
          });
          if (!rv.ok) commandBindMissing = rv.reason;
          else {
            commandValue = rv.value;
            // 声明式候选是按**值**解出来的，执行也按值选：label 优先的探测既白付 1.5 s，
            // 又可能选中"标签恰好等于我们要的机器值"的另一个 option。今天的启发式路径
            // （没有绑定）一字不动，仍走 label→value 两候选回退。
            commandByValue = cmdPick.cmd.value?.from === "option";
            // T3 ②：slot 键在袋里但值为 null/undefined = 缺值（不是"有值"。空串对 fill
            // 是合法的清空值，不算缺值）。文案与 resolveBinding 的失败同款（带诊断上下文）。
            if (cmdPick.cmd.value?.from === "slot"
                && (commandValue === null || commandValue === undefined)) {
              commandBindMissing = emptySlotBindingReason(
                cmdPick.cmd.value.key, commandValue, { diag: bindingDiag },
              );
            }
          }
          // U6：upload 的绑定解析出 undefined/null 同样是**缺值**（如槽位键存在但值为空）——
          // 提前落成与 fill/select 同款的 needs_value 停因，而不是让动作层跳到下一个候选。
          if ((cmdPick.cmd.op === "upload" || cmdPick.cmd.op === "clickAt")
              && commandBindMissing === null
              && (commandValue === undefined || commandValue === null)) {
            commandBindMissing = cmdPick.cmd.op === "upload"
              ? "the declared upload binding has no value (files come from the plan, never guessed)"
              : "the declared clickAt binding has no value (coordinates come from the plan, never guessed)";
          }
        }
        let ruleRef: string | null = null;
        if (commandMode && cmdPick) {
          // the space already resolved the element by name; use it verbatim (no token rule,
          // no model, no confidence floor — a closed-set pick is deterministic by contract).
          ruleRef = cmdPick.ref;
        } else if (this.rulesOn) {
          // A frozen plan that NAMES its target is authoritative: href/label token
          // matching may not pre-empt it. Measured live (en.wikipedia search page
          // served an error shell, so the plan's `#searchInput` was absent):
          // running `navRule` first token-matched 18 slot-less fields, each
          // forbidden and re-picked inside ONE step, then laya clicked junk and the
          // subgoal hit `max_steps` after 22 steps. The documented fall-through for
          // a hint that matches nothing is LAYA ("rather than gambling on a token").
          // 计划声明的 hint 是权威；否则规则在**排序先验池**里找（该族在前，其余仍在）。
          ruleRef = curHint
            ? affordanceRule(instruction, elems, curHint)
            : (navRule(instruction, orderedPool()) ?? affordanceRule(instruction, orderedPool(), null));
          // U5（W10）：rules-only 没有模型可回退，也就没有决策脸的"低置信宽扫重看"那一级。
          // 声明的 target_hint 若落在常规 40 窗口之外（分页链接/长列表底部），规则直接未命中，
          // 3 attempts 后 target_not_found —— 明明页面上就在那儿。
          // 这里补**一次**宽扫重解析：120 元素、main-first（与决策脸的加宽恢复同预算档），
          // hintMatch 是确定性的，命中即用、不猜；常规窗口内命中时这条路一步都不走（零多付），
          // 决策脸路径不变（由 rulesOnly 门住）。不放大 attempts、不引入模型。
          if (ruleRef === null && this.rulesOnly && curHint !== null && !reobserved) {
            reobserved = true;
            await this._settleBeforeExtract(pg);
            const wide = await extractElements(pg, true, WIDER_ELEMENTS,
              { widgets: true, candidatePriority: "main-first" });
            if (Object.keys(wide).length > Object.keys(elems).length) {
              // refs 是位置性的：先把"换位后已不是同一元素"的禁用记录清掉（与步头同规则）。
              pruneForbids(wide);
              const wideRef = affordanceRule(instruction, wide, curHint);
              if (wideRef !== null && !(wideRef in forbidden)) {
                elems = wide;
                ruleRef = wideRef;
                if (verbose) {
                  console.log(`  step ${stepNo}: rules-only re-scanned wider `
                    + `(${Object.keys(wide).length} elements) -> ${wideRef}`);
                }
              }
            }
          }
        }
        // re-admit refs whose only sin was being covered at an earlier step, but
        // ONLY after this subgoal actually executed something since the block
        // (the recovery click that removed the banner). Once per ref.
        for (const [br, [bStep, bCount]] of Object.entries(blockedRetry)) {
          if (elems[br] !== undefined && stepNo > bStep && trace.slice(bCount).some((t) => t.executed)) {
            unforbid(br);
            reAdmitted.add(br);
          }
        }
        let ref: string | null = null;
        let conf = 0;
        // 方法标签跟着决策源走（2026-11-01 ④）：provider 自报其名（decision-service / 基线名…）；
        // legacy runtime 包装的归一化为 "laya"——本地 laya 档的 method 串逐字节不变。
        const mm = this.modelLabel();
        let method = mm;
        // 粗分类（聚合用）：rule=规则/闭集解析，model=provider 决策票，escalate=老师点名。
        // 显示名交给 method（可含 :reobserve/:adjudicated 后缀），聚合读这个字段。
        let decisionKind: "rule" | "model" | "escalate" = "model";
        let layaMargin: number | null = null;      // C3-R top-two margin (diagnostic)
        let tierAsk: { n: number; tier: number } | null = null;   // P1 diagnostic: the narrowed question
        if (ruleRef && !(ruleRef in forbidden)) {
          ref = ruleRef;
          conf = 1.0;
          method = "rule:match";
          decisionKind = "rule";
        } else {
          // the rule's target is forbidden (inert or tried) -> fall through to
          // laya with the reduced action space instead of re-hitting a known-dead
          // element
          const forbiddenSet = new Set(Object.keys(forbidden));
          // P1 TIERED HINT (opt-in, `tieredHint`; OFF keeps today's behaviour byte-identical):
          // an ambiguous-in-tier plan hint used to collapse to null and become
          // "pick 1 of the whole 40" — now it becomes "pick 1 of THESE candidates".
          // The tier is a SMALLER QUESTION, never a decider: below floor or no answer,
          // the step re-asks the full pool and every later rung stays as today.
          let askPool = orderedPool();
          if (tieredHint && curHint !== null && ruleRef === null) {
            const cand = hintCandidates(curHint, elems);
            if (cand !== null && cand.decided === null && cand.refs.length > 1) {
              const subset: ElemPool = {};
              for (const r of cand.refs) {
                if (elems[r] !== undefined && !forbiddenSet.has(r)) subset[r] = elems[r]!;
              }
              if (Object.keys(subset).length > 1) {
                askPool = subset;
                tierAsk = { n: Object.keys(subset).length, tier: cand.tier };
              }
            }
          }
          let [picked, pconf, pprobs] = await this.pickElement(
            instruction, pg, askPool, forbiddenSet, noted);
          if (askPool !== elems && tierAsk !== null && (picked === null || pconf < this.confFloor)) {
            // narrowed ask abstained: today's full-pool ask still gets its turn
            if (verbose) console.log(`  step ${stepNo}: tiered hint (${tierAsk!.n} candidates) abstained -> full pool`);
            tierAsk = null;
            [picked, pconf, pprobs] = await this.pickElement(
              instruction, pg, elems, forbiddenSet, noted);
          }
          ref = picked;
          conf = pconf;
          method = mm;
          layaMargin = topTwoMargin(pprobs);
        }
        if (ref === null) {
          // A2：候选窗口超过决策服务上限——结构化停因，绝不把 200+ 选项硬塞过去。
          if (this._choiceLimitReason !== null) {
            const why = this._choiceLimitReason;
            this._choiceLimitReason = null;
            stop("decision_service_choice_limit", why, stepNo);
            if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
            break;
          }
          // In rules-only mode a null ref usually means "no runtime to ask", which is not
          // the same failure as "every element is forbidden" — say which one it is.
          if (this.rulesOnly) {
            // 诚实停因（2026-11-01 产品评审 P1）：这一步**什么动作都没声明**（无 target_hint、
            // 无命令空间）时，"缺模型"是个谎言——真正的问题要么是"信号已成立但这步没声明
            // 零动作命令，引擎不肯替作者宣布完成"，要么是"信号根本不成立"。当场评估一次
            // 信号（只在走向停止时付这一次），把实况和出路说出口，而不是把用户引去装模型。
            if (curHint === null && cmdSpace.length === 0) {
              const held = goalSignalFn ? (await goalSignalFn(pg)) : false;
              stop("no_model_runtime",
                `step ${stepNo} declares no action (no target_hint, no commands) and rules-only has no model `
                + `to pick one — its done-signal ${held ? "ALREADY holds on this page: declare a zero-action "
                    + 'command (commands: [{"op":"skip"}]) on this subgoal, or name a target_hint, so the '
                    + "signal can be honored"
                  : "does not hold on this page either: name a target_hint, declare commands, "
                    + "or provide a decision model"}`
                + this.degradedReasonSuffix(), stepNo);
              if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
              break;
            }
            stop("no_model_runtime",
              `no model runtime: this step needs a model pick (rules-only mode) on step ${stepNo}`
              // 规划引导：计划点了名、规则没解出来、模型又不在/弃权——当场送闭集。
              + (curHint !== null && ruleRef === null
                  ? ` — target_hint "${curHint}" 未被规则命中，${HINT_CLOSED_SET_TEXT}`
                  : "")
              // A3：provider 是抛错降级（而非本来就没装）时，把 HTTP 事实带上——排查不必再猜。
              + this.degradedReasonSuffix() + identityHiddenSuffix(), stepNo);
          } else {
            stop("action_space_exhausted",
              `action space exhausted on step ${stepNo}`
              + (curHint !== null && ruleRef === null
                  ? ` — target_hint "${curHint}" 未被规则命中，${HINT_CLOSED_SET_TEXT}`
                  : "") + identityHiddenSuffix(), stepNo);
          }
          if (verbose && this.rulesOnly) console.log(`  step ${stepNo}: ${stopReason}`);
          break;
        }
        // PORT FIX: a model answer can name a ref that is no longer in THIS
        // step's pool (the screen changed between the scan and the pick, or the
        // answer is nonsense). The Python reference reads `elems[ref]` unguarded
        // and dies with a KeyError; stop the subgoal with a reason instead.
        if (elems[ref] === undefined) {
          // 这条曾经是使用者最看不懂的一句：`picked ref 'undefined' is not in the element
          // pool on step 1`。它真正的意思是"这一步没有能点到的目标"——计划没点名（没有
          // target_hint），规则也没命中，于是一个不存在的 ref 被交到这里。把病因写出来，
          // 并且告诉使用者下一步该改什么（加 target_hint），而不是复述执行器的内部产物。
          const poolSize = Object.keys(elems).length;
          if (curHint) {
            stop("hint_matched_nothing",
              `target_hint ${JSON.stringify(curHint)} matched nothing in a pool of ${poolSize} `
              + `element(s) on step ${stepNo}`, stepNo);
          } else {
            stop("step_names_no_target",
              `step ${stepNo} names no target: no target_hint(s), no rule matched any of the `
              + `${poolSize} element(s), and the picker returned no usable element`
              + `（给这一步加 target_hint，或在页面上点名一个稳定句柄）`, stepNo);
          }
          if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
          break;
        }
        // The confidence floor decays as failed elements are forbidden: a
        // shrunken action space legitimately lowers the margin.
        const floor = Math.max(0.10, this.confFloor - 0.05 * Object.keys(forbidden).length);
        if (conf < floor) {
          const pending = elems[ref]!;
          // U8：本次 ask 的 conf（后续恢复路径会改写 conf 变量；记账用分支入口的值）。
          const askConf = conf;
          /** U8：本分支内被闸门丢掉的 ask conf（暂存；提交点见各出口——adjudicate 复用意见时撤回）。 */
          const gateRejected: number[] = [];
          // A frozen plan may legitimately re-drive an element within one
          // subgoal. If this exact element already executed successfully
          // earlier in THIS subgoal, allow it once more at >= 0.10.
          const wantDesc = (this._isTyping(pending) ? "type text into" : "click")
            + ` ${pending.tag} "${pending.label}"`;
          const priorHit = trace.some((t) => t.desc === wantDesc && t.executed);
          if (priorHit && conf >= 0.10) {
            /* re-drive: proceed despite floor */
          } else if (this.rulesOnly) {
            // No runtime installed and no rule/hint resolved this step: say exactly that.
            // Reporting "low confidence 0.00" here would blame the model for not existing.
            stop("no_model_runtime",
              `no model runtime: this step needs a model pick (rules-only mode) on step ${stepNo}`
              // 同 low_confidence：hint 被点名却没解出来时，当场送闭集（规划引导，见 2026-10-29 实测）。
              + (curHint !== null && ruleRef === null
                  ? ` — target_hint "${curHint}" 未被规则命中，${HINT_CLOSED_SET_TEXT}`
                  : "")
              // A3：同上——降级原因（HTTP 状态码 + 服务错误关键句）随停因透出。
              + this.degradedReasonSuffix(), stepNo);
            if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
            break;
          } else if (!(adjudicate && ref !== null)
            && Object.keys(forbidden).length >= Math.max(0, Object.keys(elems).length - 1)) {
            // A2′：`adjudicate` 开着且还有活着的候选时，不能用"动作空间耗尽"抢在裁决前面——
            // 那最后一个低置信候选正是该被信号裁决的那一个（"错了白跑"是作者声明过的）。
            // 没开裁决时这个提前停原样保留（逐字节今天）。
            gateRejected.push(askConf);   // U8：意见在 floor 处被丢，动作空间也已耗尽——记一笔
            stop("action_space_exhausted",
              `action space exhausted (${Object.keys(forbidden).length} forbidden) on step ${stepNo}`, stepNo);
            break;
          } else {
            // U8：走到恢复分支 = 原 ask 的意见已被闸门丢弃（reobserve/escalate 换别的意见、
            // low_confidence 停；唯一例外是 adjudicate 复用原意见——下面 pop 撤回）。
            gateRejected.push(askConf);
            // OBSERVATION-BOTTLENECK RECOVERY (browser-use's "the button is there, we
            // just failed to show it"): the pool is the model's entire world, so a
            // target that never entered it cannot be chosen no matter how good the
            // model is. Take ONE wider look and re-ask before blocking the subgoal.
            // Only the way to stopping pays for the extra scan; the pick is recorded
            // as `<provider>:reobserve` so a widened step is visible in the trace/audit.
            let recovered = false;
            // A2′：加宽重看即便没过闸门，它看到的候选也可能比窄池那一个更好——
            // 记下来，若这一步声明了裁决资格，就用**最后一次观察到的**低置信选择（elems 已是宽视图）。
            let widePick: { ref: string; conf: number } | null = null;
            if (reobserve && !reobserved && ref !== null) {
              reobserved = true;
              await this._settleBeforeExtract(pg);
              const wide = await extractElements(pg, true, WIDER_ELEMENTS, { widgets: true, quotas: WIDE_QUOTAS, candidatePriority });
              if (Object.keys(wide).length > Object.keys(elems).length) {
                // refs are positional: re-prune forbids whose ref now names a
                // different element before re-asking (same rule as the step head).
                pruneForbids(wide);
                // 宽视图同样只做**排序先验**（不丢元素：加宽看到的东西不该被族过滤掉）。
                const wideAsk = orderedPool(wide);
                const [ref2, conf2] = await this.pickElement(
                  instruction, pg, wideAsk, new Set(Object.keys(forbidden)), noted);
                // The wider view BECOMES the step's view even when the local model
                // stays unsure: a stronger reasoner (escalation) must be able to see
                // what the wider look already found, or widening would be pointless.
                // (Measured: the escalator was handed the 40-element narrow view and
                // the target was still invisible to it.)
                elems = wide;
                if (ref2 !== null && conf2 >= floor) {
                  ref = ref2;
                  conf = conf2;
                  method = `${mm}:reobserve`;
                  recovered = true;
                  if (verbose) {
                    console.log(`  step ${stepNo}: re-observed wider `
                      + `(${Object.keys(wide).length} elements) -> ${ref} conf=${conf2.toFixed(2)}`);
                  }
                } else {
                  if (ref2 !== null) {
                    widePick = { ref: ref2, conf: conf2 };
                    gateRejected.push(conf2);   // U8：宽看重问的意见也未过 floor（adjudicate 复用时撤回）
                  }
                  if (verbose) {
                    console.log(`  step ${stepNo}: re-observed wider `
                      + `(${Object.keys(wide).length} elements) -> still below floor`);
                  }
                }
              }
            }
            // ESCALATION (C3-R's deliberative path): a stronger reasoner may still
            // name one of the elements the harness showed. It is a picker, not a
            // planner — an answer that is not a ref from THIS view is rejected, so
            // nothing it says can invent an element, a value or an action.
            if (!recovered && escalateFn && !escalated) {
              escalated = true;
              const crit = criteriaView(orderedPool(), new Set(Object.keys(forbidden)),
                await ariaInteractiveLines(pg));
              const state = {
                url: urlOf(pg), title: await pg.title(),
                main_text: await stateText(pg, instruction, this.embedFn),
              };
              try {
                const pick = await escalateFn({
                  instruction, criteria: crit, why: `low confidence ${conf.toFixed(2)} < floor ${floor.toFixed(2)}`,
                  ...state,
                });
                if (pick && crit[pick] !== undefined && !(pick in forbidden)) {
                  ref = pick;
                  method = "escalate";
                  decisionKind = "escalate";
                  escalatedPick = pick;
                  recovered = true;
                  if (verbose) console.log(`  step ${stepNo}: escalated -> ${pick}`);
                } else if (verbose) {
                  console.log(`  step ${stepNo}: escalation rejected (${pick === null ? "no answer" : `'${pick}' is not a shown candidate`})`);
                }
              } catch (e) {
                if (verbose) console.log(`  step ${stepNo}: escalation failed (${describeActionError(e)})`);
              }
            }
            if (!recovered) {
              // A2′：这一步声明了"错了白跑"（`adjudicate`，加载期已钉 `effect.irreversible:false`
              // + 可判定信号），于是"低置信"不再是阻塞理由——把模型此刻的选择**执行**，让这一步
              // 自己的 DOM 信号事后裁决（信号成立 = done；不成立 = 下面循环尾部禁掉这个元素，
              // 一次白跑就是它的全部代价）。这是老师的"提名被执行、信号定生死"同一认识论，
              // 只是爆炸半径由作者声明限定。没声明 ⇒ 逐字节今天（低置信即阻塞）。
              const bestPick = widePick ?? (ref !== null ? { ref, conf } : null);
              if (adjudicate && bestPick !== null && !this.rulesOnly) {
                // U8：被裁决执行的那份意见（原 ask 或宽看重问）不算被拒——撤回最后一笔暂存。
                gateRejected.pop();
                ref = bestPick.ref;
                conf = bestPick.conf;
                method = `${mm}:adjudicated`;
                if (verbose) {
                  console.log(`  step ${stepNo}: adjudicating below gate (${ref} `
                    + `conf=${conf.toFixed(2)} < floor ${floor.toFixed(2)}) — the step's own signal judges`);
                }
              } else {
                // U8：提交点①——low_confidence 停，暂存的意见确被丢弃。
                this._rejectedAskConfs.push(...gateRejected);
                stop("low_confidence",
                  `low confidence ${conf.toFixed(2)} < floor ${floor.toFixed(2)} on step ${stepNo}`
                  // 规划引导：计划点了名、规则却没解出来——当场把闭集送给作者，省一次读源码确诊
                  // （2026-10-29 实测：act hint 落空静默回退模型，报错无提示，Agent 读完 hint.ts/rules.ts 才定位）。
                  + (curHint !== null && ruleRef === null
                      ? ` — target_hint "${curHint}" 未被规则命中，${HINT_CLOSED_SET_TEXT}`
                      : "")
                  // A2 判别②：分数不过闸门 ≠ 目标不存在——用内存里的池把两种问题分开说
                  // （候选在而置信度低 = 闸门问题；池里没有词面相关候选 = 目标可能不在本页面）。
                  + lowConfDiscrimination(instruction, elems, ref), stepNo);
                break;
              }
            }
            // U8：提交点②——reobserve/escalate 挽回了这一步，但被丢弃的意见照记（它们
            // 确实在 floor 处被拒过；挽回意见本身走 trace 进既有 `conf` 聚合）。
            this._rejectedAskConfs.push(...gateRejected);
          }
        }
        // R2b：词面零重叠守卫（宽扫的第二个触发器）。模型提名（非规则命中、非满置信）
        // 的 label 与指令零词面重叠（CJK 二元组/ASCII 词）时，是"自信地错"的典型形态——
        // 低置信恢复等不到（模型不觉得自己错，m.ctrip 实证：指令"出发地" vs 提名
        // "组合交通出行"，conf 0.71 过闸点走页脚）。执行前强制一次宽扫重问（宽池含 R2/
        // R2c 启发式候选），重问结果照常过闸；无更优则保留原提名。规则命中与 conf=1.00
        // 的模型提名不触发（books/quotes/hn 全量 rule:match conf=1.00 实证零回归面）。
        if (ref !== null && !reobserved && method === mm && conf < 0.9
            && !lexicalOverlap(instruction, String(elems[ref]?.label ?? ""))) {
          reobserved = true;
          await this._settleBeforeExtract(pg);
          const wideR2b = await extractElements(pg, true, WIDER_ELEMENTS, { widgets: true, quotas: WIDE_QUOTAS, candidatePriority });
          if (Object.keys(wideR2b).length > Object.keys(elems).length) {
            pruneForbids(wideR2b);
            const wideAskR2b = orderedPool(wideR2b);
            const [ref2, conf2] = await this.pickElement(
              instruction, pg, wideAskR2b, new Set(Object.keys(forbidden)), noted);
            elems = wideR2b;
            if (ref2 !== null && conf2 >= floor) {
              ref = ref2;
              conf = conf2;
              method = `${mm}:reobserve`;
              if (verbose) {
                console.log(`  step ${stepNo}: R2b relevance widen -> ${ref} conf=${conf2.toFixed(2)}`);
              }
            } else if (verbose) {
              console.log(`  step ${stepNo}: R2b relevance widen -> keep original `
                + `(${ref2 === null ? "no pick" : `conf ${conf2.toFixed(2)}`} below floor)`);
            }
          }
        }
        // S2 ③ **有界修复**（只在走向停止时付一次成本）：第一轮用全池（软先验）解析出的动作族
        // 与提名不符 / 没解出目标时，才用"该族"再做一次解析；仍不成立 ⇒ 结构化停，
        // 绝不执行一个与提名矛盾的动作。
        // 为什么不是第一道过滤：结构族 ≠ 语义动作（div[role=combobox] = click 但语义 select、
        // contenteditable = click 但语义 fill、input[type=range] = fill 但语义设值），硬过滤会
        // 把真目标或关键上下文元素一并排掉（项目方推敲结论）。
        let nominatedRepair = false;
        if (expectedFamily !== null) {
          const pickedFamily = ref !== null ? elemFamily(elems[ref]!) : null;
          if (ref === null || pickedFamily !== expectedFamily) {
            const narrow = filterElemsByFamily(elems, expectedFamily);
            if (Object.keys(narrow).length === 0) {
              stop("nominated_family_empty",
                `nominated instruction "${expectedFamily}" but this page has no ${expectedFamily} `
                + `candidates on step ${stepNo}`, stepNo);
              if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
              break;
            }
            const repairFloor = Math.max(0.10, this.confFloor - 0.05 * Object.keys(forbidden).length);
            const forbiddenSet = new Set(Object.keys(forbidden));
            const repairRule = navRule(instruction, narrow) ?? affordanceRule(instruction, narrow, null);
            let repaired: { ref: string; conf: number; method: string } | null = null;
            if (repairRule !== null && !(repairRule in forbidden)) {
              repaired = { ref: repairRule, conf: 1, method: "rule:match" };
            }
            if (repaired === null) {
              const [rp, rconf] = await this.pickElement(instruction, pg, narrow, forbiddenSet, noted);
              if (rp !== null && rconf >= repairFloor) repaired = { ref: rp, conf: rconf, method: mm };
            }
            if (repaired === null) {
              stop("nominated_family_mismatch",
                `nominated instruction "${expectedFamily}", but the page resolved ${pickedFamily ?? "nothing"} `
                + `and no ${expectedFamily} candidate passed the floor on step ${stepNo}`, stepNo);
              if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
              break;
            }
            if (verbose) {
              console.log(`  step ${stepNo}: nominated-family repair ${expectedFamily} -> `
                + `${repaired.ref} (${repaired.method})`);
            }
            ref = repaired.ref;
            conf = repaired.conf;
            method = repaired.method;
            nominatedRepair = true;
          }
        }
        // S4：stale 重解析重试会换成本步重新解析出的元素，故 el 可重新绑定（ref 本就是 let）。
        let el = elems[ref]!;
        // ActionAdapter 能力面：命令闭集声明的 op 必须是当前元素已声明的能力。
        // 这不是新的动作生成路径，只是把"跑了才发现不支持"提前到执行前。
        if (commandMode && cmdPick) {
          const caps = actionCapabilities(el);
          const op = String(cmdPick.cmd.op);
          if (op !== "skip" && !caps.includes(op as ActionCapability)) {
            // A2：这个候选不满足 op 能力面，但命令还有其他候选 ⇒ 记跳过、禁用本候选、下一步
            // 换下一个（可行动优先的意义）；全部候选都试完仍不支持 ⇒ 走下面的诚实停因。
            const alt = cmdPick.cands.some((r) => r !== ref && !(r in forbidden)
              && actionCapabilities(elems[r]!).includes(op as ActionCapability));
            if (alt) {
              forbid(ref, el, "action_unsupported");
              noteSkipped({ command_id: cmdPick.cmd.id, target: cmdPick.cmd.target ?? null, ref, reason: "action_unsupported",
                detail: `element declares [${caps.join(", ")}] but the command op is '${op}'; trying the next candidate` });
              cmdAttempts[cmdPick.cmd.id] = (cmdAttempts[cmdPick.cmd.id] ?? 0) + 1;
              if (verbose) console.log(`  step ${stepNo}: command ${cmdPick.cmd.id} candidate ${ref} lacks '${op}' -> next candidate`);
              continue;
            }
            // B1：fill（命令闭集里唯一的取值/打字 op）被拒时点名出路——只说"元素不声明这个 op"
            // 用户不知道怎么走（12 轮实测：Maps 搜索框 role=combobox 归 select 族，fill 被拒）。
            // click/scroll 被拒的出路不同（A2 停因判别已覆盖），不加这句。
            const remedy = op === "fill"
              ? (caps.includes("upload")
                // U6：file input 归 upload 族——fill 被拒时直接点名正确的 op，别把作者引向决策语句。
                ? `。该目标是文件输入（input[type=file]）——上传用命令 op 'upload'（值走声明绑定），不是 fill`
                : `。该输入族不支持命令 ${op}——改用决策语句（省略 act，值经 slots 绑定）或深链直达目标 URL`)
              : op === "upload"
                ? "。upload 只对 input[type=file] 成立——检查目标 hint 是否指到了文件输入"
                : op === "clickAt"
                  ? "。clickAt 只对 click 族元素成立（如 canvas）——检查目标 hint 是否指到了非点击控件"
                  : "";
            await cleanupIdentity();   // FW8：能力守门在动作前停——章到此已无用途
            stop("action_unsupported",
              `command ${JSON.stringify(cmdPick.cmd.id)} declares op '${op}', but element ${ref} `
              + `(${el.tag} "${el.label}") only declares [${caps.join(", ")}] on step ${stepNo}`
              + remedy, stepNo);
            if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
            break;
          }
        }
        // 05-B：动作文案按命令 op 派生（此前只有 typing/click 两态，scroll 步
        // 出现 `hows:["scrolled"]` 配 `descs:["click a \"…\""]` 的自相矛盾行）。
        // 非命令模式保持原语义（typing→click 两态）；desc 只进展示与风险票措辞，不是功能键。
        const cmdOpName = commandMode && cmdPick ? String(cmdPick.cmd.op) : "";
        const verb = cmdOpName === "scroll" ? "scroll to"
          : cmdOpName === "drag" ? "drag"
          : cmdOpName === "check" ? "check"
          : cmdOpName === "hover" ? "hover"
          : cmdOpName === "clickAt" ? "click at"
          : cmdOpName === "upload" ? "upload"
          : cmdOpName === "fill" ? (this._isTyping(el) ? "type text into" : "fill")
          : cmdOpName === "select" ? "select"
          : this._isTyping(el) ? "type text into" : "click";
        const desc = `${verb} ${el.tag} "${el.label}"`;
        // DRY RUN stops HERE: the target is resolved (rule hint / local model /
        // re-observe / escalate) and probed, and nothing on the page is touched —
        // the pre-fill guard below and `occludedReason` (which clicks) are never
        // reached. The caller gets "what WOULD happen" as evidence.
        if (dryRun) {
          const probe = await this.dryRunProbe(pg, el, force);
          dryRan = true;
          await cleanupIdentity();   // FW8：干跑探测结束，章不再需要
          if (probe.actionable) {
            stop("dry_run", `dry-run: would ${desc}${force ? " (force)" : ""} (${method}, conf=${conf.toFixed(2)})`, stepNo);
          } else {
            stop("dry_run_not_actionable",
              `dry-run: target not actionable (${probe.reason ?? "unknown"})`, stepNo);
          }
          trace.push({
            step: stepNo, desc, method, conf: round3(conf), executed: false,
            dry_run: true, actionable: probe.actionable,
            ...(probe.reason === null ? {} : { reason: probe.reason }),
            ...(force ? { forced: true } : {}),
            would: `${el.tag} "${el.label}"`, url: urlOf(pg),
            ...actionDeclEvidence(), ...refCollision(), ...identityEvidence(),
          });
          if (verbose) {
            console.log(`  step ${stepNo}: DRY-RUN `
              + (probe.actionable ? `would ${desc}${force ? " (force)" : ""}` : `not actionable (${probe.reason ?? "unknown"})`));
          }
          break;
        }
        // P2: a fill/select whose DECLARED binding has no value stops here — honestly,
        // structurally, and never with a guessed value. (The substring-heuristic path
        // below is the old behaviour; a command space replaces guessing with binding.)
        if (commandMode && commandBindMissing !== null) {
          noteSkipped({ command_id: cmdPick!.cmd.id, target: cmdPick!.cmd.target ?? null, ref: cmdPick!.ref, reason: "needs_value", detail: commandBindMissing });
          trace.push({
            step: stepNo, desc, how: "needs_value", executed: false, method, conf: 1.0,
            command: cmdPick!.cmd.id, ref: cmdPick!.ref, skipped: true, skip_reason: "needs_value",
            url: urlOf(pg), ...actionDeclEvidence(), ...refCollision(), ...identityEvidence(),
          });
          await cleanupIdentity();   // FW8：缺值在动作前停——章到此已无用途
          stop("needs_value",
            `command ${JSON.stringify(cmdPick!.cmd.id)}: ${commandBindMissing} `
            + `— a declared binding either has its value in the plan or the step stops (红线②: never guessed) on step ${stepNo}`, stepNo);
          if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
          break;
        }
        // Pre-fill guard: a click whose form has empty fields that the plan's
        // slots can supply would die in HTML5 validation or JS checks — an inert
        // click and a wasted step. Values come from the plan, never the model.
        // S4：hover 只移动指针、不应顺手改表单，故不触发预填（既有 click/scroll/drag 行为不变）。
        if (!this._isTyping(el) && cmdOpName !== "hover") {
          // Pre-fill before ANY click, including clicks on a submit-type input.
          for (const pe of await this._missingRequired(pg, slots, elems, values, candidatePriority)) {
            const [phow] = await this._executeElement(pg, pe, slots, null, undefined, false, values);
            if (verbose) console.log(`  step ${stepNo}.pre: fill required ${JSON.stringify(pe.label)} -> ${phow}`);
          }
        } else if (method === "rule:match" && !commandMode) {
          // A rule-picked field with no slot value cannot be filled; forbid it so
          // the next step goes to laya instead of burning the subgoal on
          // needs_value. Submit-type inputs are the exception: they are CLICKED,
          // never filled.
          if (this._slotValue(el, slots, values) === null && !this._isSubmit(el)) {
            forbid(ref, el, "needs_value");
            noteSkipped({ ref, reason: "needs_value", ...(cmdPick ? { command_id: cmdPick.cmd.id, target: cmdPick.cmd.target ?? null } : {}) });
            trace.push({
              step: stepNo, desc, how: "needs_value", executed: false, method, conf: round3(conf),
              ref, skipped: true, skip_reason: "needs_value", url: urlOf(pg),
              ...actionDeclEvidence(), ...refCollision(), ...identityEvidence(),
            });
            await cleanupIdentity();   // FW8：本步不再动作（needs_value）——章清零
            if (verbose) console.log(`  step ${stepNo}: (needs_value, rule) -> skip ${ref}`);
            continue;
          }
        }
        // §4：可逆性是**声明**，不该靠关键词猜。写了 effect.irreversible 就以它为准
        // （true ⇒ 一定问人；false ⇒ 这一步非破坏性，跳过一次模型前向，省下 W1 要省的那笔钱）。
        // 没写就完全走今天的路径：关键词 + 模型票。
        let risky: boolean, riskP: number;
        // U6：上传的可逆性弱（只写 input.files，不提交表单），不新增 risky 语义——
        // 也不让目标 label 的关键词把它误判成破坏性动作。其它 op 的既有判定逐字节不变。
        if (cmdOpName === "upload") {
          risky = false;
          riskP = 0;
        } else if (effect?.irreversible !== undefined) {
          risky = effect.irreversible;
          riskP = effect.irreversible ? 1.0 : 0.0;
        } else {
          [risky, riskP] = await this.isRisky(instruction, desc);
        }
        let confirmed = false;
        if (risky) {
          if (verbose) console.log(`  step ${stepNo}: RISKY ${desc} (p=${riskP.toFixed(2)}) -> asks for confirmation`);
          confirmed = await this.confirmFn(desc);
          if (!confirmed) {
            forbid(ref, el, "risk-declined");
            noteSkipped({ ref, reason: "risk-declined", ...(cmdPick ? { command_id: cmdPick.cmd.id, target: cmdPick.cmd.target ?? null } : {}) });
            trace.push({
              step: stepNo, desc, risky: true, executed: false, confirmed: false, url: urlOf(pg),
              ref, skipped: true, skip_reason: "risk-declined",
              ...actionDeclEvidence(), ...refCollision(), ...identityEvidence(),
            });
            await cleanupIdentity();   // FW8：风险闸门拒绝 = 本步不动作——章清零
            continue;
          }
        }
        // S4：stale 重解析重试的账户（本步内最多 STALE_RETRY_MAX 次；trace 每次记录一条）。
        const STALE_RETRY_MAX = 2;
        const staleRetries: Array<{ attempt: number; reason: string; ref: string }> = [];
        const staleEvidence = (): Record<string, unknown> =>
          staleRetries.length ? { stale_retry: staleRetries.slice() } : {};
        /** S4：步级 force 声明的执行证据（动作 trace 行上 forced=true）。 */
        const forcedEvidence = (): Record<string, unknown> => (force ? { forced: true } : {});
        /**
         * 重试只能对着**可复现的声明**重新解析：命令 target 优先，其次 act hint（规则命中）。
         * 纯模型挑元素的决策步没有声明目标 ⇒ 不重试（重解析必须复现，不能猜一个"看起来像"的）。
         */
        const declaredStaleTarget = commandMode && cmdPick
          && typeof cmdPick.cmd.target === "string" && cmdPick.cmd.target.trim()
          ? cmdPick.cmd.target
          : (method === "rule:match" && curHint !== null ? curHint : null);
        let pre = await this.snapshot(pg);
        // Click path goes through the actionability probe: a free element is
        // clicked inside it ("__clicked__"); a covered/slow one costs 0.8 s and
        // reports why, instead of burning 5 s + an inert step.
        let how: string | null = null;
        let arg: unknown = null;
        /** S1：本动作的 effect 读回（只有 fill 会产生；最后一次非空值进 StepStateRecord）。 */
        let fillEffect: StateEffect | undefined;
        const isScrollCommand = cmdOpName === "scroll";
        const isDragCommand = cmdOpName === "drag";
        const isHoverCommand = cmdOpName === "hover";
        const isClickAtCommand = cmdOpName === "clickAt";
        let actionability: ActionabilityDetail | null = null;
        /** 本条动作（含重试）最后一次 actionability 探针给出的失败原因。 */
        let probeFailure: string | null = null;
        for (let attempt = 0; ; attempt++) {
          how = null; arg = null; fillEffect = undefined; actionability = null; probeFailure = null;
          // force：跳过 actionability 探针，直接按 Playwright force 语义动作（仍要求可定位）。
          // hover：探针的快路径本身就是一次真点击，悬停必须走 hover 分支、不能过探针。
          if (!force && !this._isTyping(el) && !isScrollCommand && !isDragCommand && !isHoverCommand
              && !isClickAtCommand) {
            probeFailure = await this.occludedReason(pg, el);
            // S1：actionability 失败现场（bbox/覆盖者/重查是否还在）；非该原因时保持 null。
            actionability = this._takeActionabilityDetail();
            if (probeFailure === "__clicked__") {
              try {
                await pg.waitForLoadState("domcontentloaded", { timeout: 3000 });
              } catch {
                /* nothing to wait for */
              }
              how = "clicked";
              arg = null;
            }
          }
          if (probeFailure === null && how === null) {
            // Submit-type inputs carry their label in `value` and must be clicked,
            // never filled — `_executeElement`'s input branch would return
            // needs_value otherwise. scroll 是 viewport 语义，必须走专用分支。
            if (isHoverCommand) {
              // S4：hover 原语——只移动指针（:hover 展开菜单/图层面板），不点击、不导航。
              [how, arg, fillEffect] = await this._executeElement(pg, el, slots, null, "hover", force);
            } else if (isClickAtCommand) {
              // U7：坐标点击原语——走 _executeElement 的 clickAt 分支（含坐标解析与 bbox 越界校验），
              // 不能落入下面的中心点击路径，否则坐标原语就退化成"点元素中心"。
              [how, arg, fillEffect] = await this._executeElement(pg, el, slots,
                commandMode ? { value: commandValue, byValue: commandByValue } : null,
                "clickAt", force);
            } else if (isScrollCommand || isDragCommand) {
              // A3：`scroll` 命令可带方向原语 `to`（ctx.command("scroll", sel, {to:"bottom"})）——
              // 语义是"滚动**容器**到方向"，与旧的"把目标滚入视口"不同；旧调用（无 to）逐字节不变。
              const scrollTo = isScrollCommand ? cmdPick?.cmd.to : undefined;
              if (scrollTo !== undefined) {
                const sr = await this._scrollContainerForElement(pg, el, scrollTo);
                how = sr.ok ? "scrolled" : "action_failed";
                arg = sr.ok ? sr.scrollTop : (sr.stopCode ?? "not_scrollable");
              } else {
                [how, arg, fillEffect] = await this._executeElement(pg, el, slots,
                  commandMode ? { value: commandValue, byValue: commandByValue } : null,
                  isDragCommand ? "drag" : "scroll", force);
              }
            } else if (!this._isTyping(el)) {
              [how, arg] = await this._clickOnly(pg, el, force);
            } else {
              [how, arg, fillEffect] = await this._executeElement(pg, el, slots,
                commandMode ? { value: commandValue, byValue: commandByValue } : null,
                commandMode ? String(cmdPick!.cmd.op) : undefined, force,
                // U1：决策路径的显式值袋（命令步的具名绑定 `bound` 恒优先，values 不参与）。
                commandMode ? undefined : values);
            }
          }
          // S4 stale 判据（只有这三类；action-timeout / 有覆盖者且节点仍在都不算 stale）。
          const staleReason = probeFailure !== null && probeFailure !== "__clicked__"
            ? (probeFailure === "stale_ref"
              || (probeFailure.startsWith("not-actionable-or-covered") && actionability?.requery === "detached")
              ? probeFailure : null)
            : (how === "stale_ref" || how === "action_failed" ? how : null);
          if (!staleRetry || staleReason === null || attempt >= STALE_RETRY_MAX || declaredStaleTarget === null) break;
          // 重抽池：先给重渲染一个短拍（settle 在脏页上会再等静默），再用**同一声明目标**
          // 在新池上重新解析——这就是 r7 弹层"点前节点被替换/重挂载"的确定性修法。
          await sleep(120);
          const fresh = (await this._extractPoolSettled(pg, candidatePriority)).elems;
          pruneForbids(fresh);
          // 命令目标：按 op 的能力面重新排候选并剔除已禁；act hint：同一 hint 语义重解析。
          let freshRef: string | null = null;
          if (commandMode) {
            freshRef = this.resolveCommandRef(declaredStaleTarget, fresh, cmdOpName || "click",
              new Set(Object.keys(forbidden)))[0] ?? null;
          } else {
            const r = hintMatch(declaredStaleTarget, fresh);
            if (r !== null && !(r in forbidden)) freshRef = r;
          }
          if (freshRef === null || fresh[freshRef] === undefined) break;   // 此刻仍解析不到：不猜、按原失败报
          staleRetries.push({ attempt: attempt + 1, reason: staleReason, ref: freshRef });
          if (verbose) console.log(`  step ${stepNo}: stale retry ${attempt + 1} (${staleReason}) -> ${freshRef}`);
          elems = fresh;
          ref = freshRef;
          el = fresh[freshRef]!;
          pre = await this.snapshot(pg);   // 重试动作的 pre 快照 = 此刻页面
        }
        // FW8：身份回捞的章只服务本次动作定位——动作尝试（含 stale 重试）一结束就清，
        // 成功/失败同纪律（与 A3 data-af-probe cleanup 同一做法）。
        await cleanupIdentity();
        // U6/U7：upload 的文件/声明值非法、clickAt 的坐标坏格式/越界都是**配置错误**，
        // 不是页面问题——结构化停在这里，不落成"跳过这个候选继续猜下一个"
        // （那会把配置错误伪装成目标缺失）。
        if (how === "config_error") {
          const detail = String(arg ?? `${cmdOpName || "command"} configuration error`);
          forbid(ref, el, "config_error");
          noteSkipped({ ref, reason: "config_error",
            ...(cmdPick ? { command_id: cmdPick.cmd.id, target: cmdPick.cmd.target ?? null } : {}),
            detail });
          trace.push({
            step: stepNo, desc, how: "config_error", executed: false, method, conf: round3(conf),
            ref, skipped: true, skip_reason: "config_error", url: urlOf(pg),
            ...(cmdPick ? { command: cmdPick.cmd.id } : {}),
            ...actionDeclEvidence(), ...forcedEvidence(), ...staleEvidence(), ...refCollision(),
            ...identityEvidence(),
          });
          stop("config_error", detail, stepNo);
          if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
          break;
        }
        if (fillEffect !== undefined) {
          lastEffect = fillEffect;
          // S5b：摘要只留 kind/applied（值本身可能是凭据/隐私，进模型上文的面只要事实）。
          this._lastEffectSeen = { kind: fillEffect.kind, applied: fillEffect.applied };
        }
        const executed = how === "clicked" || how === "filled" || how === "scrolled"
          || how === "dragged" || how === "hovered" || how === "uploaded";
        if (!executed) {
          // 末次失败原因：actionability 探针给出的，或动作本身返回的（stale_ref/needs_value/
          // action_unsupported/action_failed）。
          const reason = probeFailure !== null && probeFailure !== "__clicked__" ? probeFailure : String(how);
          // needs_value / stale_ref: this element cannot advance the plan right
          // now; forbid and try another (no model call).
          forbid(ref, el, reason);
          if (reason.startsWith("not-actionable-or-covered") && !reAdmitted.has(ref)) {
            blockedRetry[ref] = [stepNo, trace.length];
          }
          // A1：动作阶段没执行成 —— skipped_actions 记原因与命令身份（零执行步骤的证据）。
          // S1：not-actionable-or-covered 另附结构化现场（bbox/覆盖者/重查节点是否还在）。
          noteSkipped({
            ref, reason,
            ...(cmdPick ? { command_id: cmdPick.cmd.id, target: cmdPick.cmd.target ?? null } : {}),
            ...(actionability === null ? {} : {
              detail: `bbox=${actionability.bbox === null ? "?" : `${actionability.bbox.x},${actionability.bbox.y} ${actionability.bbox.width}x${actionability.bbox.height}`}`
                + `; blocker=${actionability.blocker ?? "none"}; requery=${actionability.requery}`,
            }),
          });
          // A2：命令步的候选尝试计数（前 4 个为止；失败的候选已被 forbid，下一步换下一个）。
          if (cmdPick) cmdAttempts[cmdPick.cmd.id] = (cmdAttempts[cmdPick.cmd.id] ?? 0) + 1;
          trace.push({
            step: stepNo, desc, how: reason, executed: false, method, conf: round3(conf),
            ref, skipped: true, skip_reason: reason, url: urlOf(pg),
            ...(cmdPick ? { command: cmdPick.cmd.id } : {}),
            ...(actionability === null ? {} : { actionability }),
            ...actionDeclEvidence(), ...forcedEvidence(), ...staleEvidence(), ...refCollision(),
            ...identityEvidence(),
          });
          if (verbose) console.log(`  step ${stepNo}: (${reason}, ${method}) -> skip ${ref}`);
          continue;
        }
        const post = await this.snapshot(pg);
        // U7：clickAt 的实际点击坐标进证据（trace 行 position + executed_actions.position）；
        // changed/inert 沿用 click 的口径（pre/post 快照 diff），不为坐标原语新造判据。
        const clickRaw = cmdOpName === "clickAt" && typeof arg === "object" && arg !== null
          ? (arg as { position?: unknown }).position
          : undefined;
        const clickPosition = typeof clickRaw === "object" && clickRaw !== null
          && typeof (clickRaw as { x?: unknown }).x === "number"
          && typeof (clickRaw as { y?: unknown }).y === "number"
          ? { x: (clickRaw as { x: number }).x, y: (clickRaw as { y: number }).y }
          : null;
        // U6：upload 的 changed 是**动作结果**而不是快照 diff——文件写进 input 不一定改
        // url/text/input value 快照。口径：调用后 input.files.length >= 期望数。
        const upload = how === "uploaded" && typeof arg === "object" && arg !== null
          ? arg as { files?: unknown; count?: unknown; expected?: unknown }
          : null;
        const uploadFiles = upload !== null && Array.isArray(upload.files)
          ? upload.files.filter((f): f is string => typeof f === "string")
          : null;
        // A1：changed = pre/post 快照是否变化（诚实字段，供审查判"点击成功但页面没动"）。
        const changed = upload !== null
          ? Number(upload.count) >= Number(upload.expected)
          : JSON.stringify(pre) !== JSON.stringify(post);
        // scroll 改变的是 viewport，不是 url/text/input 快照；不能把“快照没变”误判成 inert。
        // S4 hover 同理：它改变的是指针/`:hover` 状态，纯视觉展开未必改快照——不据此判死元素。
        const inert = (how === "scrolled" || how === "dragged" || how === "hovered") ? false : !changed;
        // A1：本子目标真的执行了几个动作（零执行步骤的判据）。
        executedCount += 1;
        // P2: an executed command is ACTED whether or not the page moved — the walk
        // must not re-drive the same command next step (its element is forbidden on
        // inert anyway, but the closed set advances by the command's identity, not the
        // element's). `executed && !inert` also advances `target_hints` below.
        if (executed && cmdPick) {
          cmdDone.add(cmdPick.cmd.id);
          cmdI = cmdPick.index + 1;
        }
        // A1：动作身份（op/ref/target）落 trace —— executed_actions / skipped_actions 从这里对账。
        const actionOp = commandMode && cmdPick ? String(cmdPick.cmd.op)
          : how === "filled" ? (el.tag === "select" ? "select" : "fill")
          : how === "scrolled" ? "scroll"
          : how === "dragged" ? "drag"
          : how === "hovered" ? "hover"
          : "click";
        // A1 §2.2.5：click 执行了、但 pre/post 快照没变，随后 done 却成立 —— 这不是"死元素"，
        // 而是效果异步到达（实测形态：点击后 1s 才长出新行）。此时必须记 suspected_async 警告，
        // 而不是 forbid + 写 outcome memory inert（那会把一次有效动作记成死元素，跨运行继续误伤）。
        const flagSuspectedAsync = (): void => {
          if (how !== "clicked" || changed) return;
          const idx = pendingAfterIdx;
          const row = idx === null ? undefined : trace[idx];
          if (row !== undefined) {
            row.inert = false;            // 不是 inert：效果在快照之后到达
            row.suspected_async = true;
          }
          const warning = `suspected_async: click on ${el.tag} "${el.label}" did not change the pre/post `
            + `snapshot, but the done signal held afterwards (step ${stepNo})`;
          warnings.push(warning);
          if (verbose) console.log(`  step ${stepNo}: ${warning}`);
        };
        trace.push({
          step: stepNo, desc, how, value: redactValue(el, uploadFiles ?? (clickPosition !== null ? null : arg)),
          risky, executed, confirmed, method,
          decision_kind: decisionKind,
          conf: round3(conf), ...(cmdPick ? { command: cmdPick.cmd.id } : {}),
          ref, op: actionOp,
          ...(cmdPick?.cmd.target !== undefined && cmdPick.cmd.target !== "" ? { target: cmdPick.cmd.target } : {}),
          changed,
          ...(uploadFiles !== null ? { files: uploadFiles } : {}),
          ...(clickPosition !== null ? { position: clickPosition } : {}),
          ...(nominatedRepair ? { nominated_family_repair: true } : {}),
          ...(decisionKind === "model" && layaMargin !== null
            ? { margin: Math.round(layaMargin * 1000) / 1000 } : {}),
          ...(method === "escalate" && escalatedPick ? { escalated: true } : {}),
          ...(prevented ? { prevented } : {}),
          ...(noted ? { noted: Object.keys(noted).length } : {}),
          ...(tierAsk ? { hint_tier: tierAsk } : {}),   // P1: this pick answered a NARROWED question
          inert, url: urlOf(pg),
          ...actionDeclEvidence(), ...forcedEvidence(), ...staleEvidence(), ...refCollision(),
          ...identityEvidence(),
        });
        // A1 子改动③：这个已执行动作的 after 签名等下一次观察落账（见循环头部的落账点）。
        pendingAfterIdx = trace.length - 1;
        if (verbose) {
          console.log(`  step ${stepNo}: ${desc} (${how}, ${method}, conf=${conf.toFixed(2)}${inert ? ", inert" : ""})`);
        }
        // NAVIGATION ENVELOPE, post-action half: an executed action must not land
        // the page on an undeclared host either. The action DID happen (recorded
        // above, honestly); nothing further is touched and the subgoal stops with
        // a structured reason.
        const landed = disallowedHost(post.url, hostGate);
        if (landed !== null) {
          stop("host_not_allowed",
            `navigated off the envelope to '${landed}' — not among the declared hosts `
            + `(${hostGate!.join(", ")}) on step ${stepNo}`, stepNo);
          if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
          break;
        }
        if (hostGate && hostGate.length) {
          const landedPopup = deniedContextUrl(pg, hostGate);
          if (landedPopup !== null) {
            stop("popup_not_allowed",
              `action opened ${landedPopup} outside the declared hosts envelope `
              + `(${hostGate.join(", ")}) on step ${stepNo}`, stepNo);
            if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
            break;
          }
        }

        if (executed && !inert && this._learnedHintApplied && method === "rule:match") {
          (hintMemory as HintMemoryLike | null)?.countUsed?.(1);
        }
        if (executed && !inert) this._advanceHint();
        // A1：多动作闭集（N≥2）未走完时，中间动作不评估 done（goalSignalFn 不付这次页面往返）；
        // 同时上面"信号成立才学的 hint"也自然不会学到中间态。单命令/无命令步恒真，逐字节原行为。
        if (goalSignalFn && cmdWalkComplete() && (await goalSignalFn(pg))) {
          // A MODEL pick that actually advanced the subgoal is a hint we EARNED: record
          // it (stable handles only, via induceHint) so the next run of this exact url +
          // subgoal resolves by rule at zero model cost. Rule hits need no help.
          if (hintMemory && this._hintKey && (decisionKind === "model" || decisionKind === "escalate")) {
            const learned = induceHint(el);
            if (learned) {
              hintMemory.record(this._hintKey, learned);
              if (verbose) console.log(`  step ${stepNo}: learned hint ${learned} for this page+subgoal`);
            }
          }
          done = true;
          flagSuspectedAsync();
          stop("dom_goal_signal", "dom goal signal", stepNo);
          break;
        }
        // ---- SPA settle ------------------------------------------------------
        // A client-side route change updates the url the instant the click is
        // handled and re-renders AFTERWARDS, so one post-action check can look at
        // the OLD page. Measured on the live long flow (saucedemo "Back to
        // products"): the done-signal became true 30-230 ms after the click, i.e.
        // 1 run in 4 checked too early, then had no target left for the next step
        // (the action had removed the hinted button) and asked the model for one.
        // The plan's DOM signal is the only truth, so give it a bounded window
        // before spending another step — 0.12 s polls, at most 0.48 s, after any
        // action that actually executed. Deliberately NOT gated on `!inert`: the
        // inert judgment is a pre/post SNAPSHOT and cannot see an effect that lands
        // asynchronously (the live burger click *was* inert, and so is a click whose
        // handler only schedules the change).
        if (goalSignalFn && executed) {
          // A1：闭集未走完时中间动作不进入 done 轮询（评估推迟到最后一个命令之后；单命令步不变）。
          // popup 复扫不 gate：它不是 done 评估，是导航信封的安全复扫，逐动作都该付。
          if (cmdWalkComplete()) {
            const settleDeadline = Date.now() + Math.max(0, doneTimeoutMs);
            let poll = 0;
            while (Date.now() < settleDeadline) {
              await sleep(Math.max(1, donePollMs));
              poll++;
              if (await goalSignalFn(pg)) {
                done = true;
                flagSuspectedAsync();
                stop("dom_goal_signal", "dom goal signal", stepNo);
                if (verbose) {
                  console.log(`  step ${stepNo}: -> done (dom goal signal, `
                    + `settled after ${poll * Math.max(1, donePollMs)} ms)`);
                }
                break;
              }
            }
          }
          // Popup 可能在 action 之后几十/几百 ms 才 commit；done 轮询结束后再扫一次 context，
          // 避免“done 已成立，但同一 action 悄悄打开了外域新 tab”。
          if (hostGate && hostGate.length) {
            const settledPopup = deniedContextUrl(pg, hostGate);
            if (settledPopup !== null) {
              done = false;
              stop("popup_not_allowed",
                `action opened ${settledPopup} outside the declared hosts envelope `
                + `(${hostGate.join(", ")}) on step ${stepNo}`, stepNo);
              if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
              break;
            }
          }
          if (done) break;
        }
        // `{manual: true}`: no DOM fact can confirm this step, so the human is asked
        // — but only after an action with a visible effect (an inert action is not a
        // completion), and the state the human was shown is recorded in the trace,
        // which is also the transition signal induction consumes next time.
        if (manualGoal && executed && !inert) {
          const excerpt = JSON.stringify(post).slice(0, 300);
          if (!manualConfirmFn) {
            stop("manual_needs_human",
              "manual step needs a human: no manualConfirmFn configured", stepNo);
            break;
          }
          const attested = await manualConfirmFn(instruction, excerpt);
          trace.push({
            step: stepNo, desc, how: attested ? "manual_confirmed" : "manual_declined",
            executed: true, method: "manual", conf: round3(conf), manual: true,
            url: urlOf(pg), state: excerpt,
          });
          if (attested) {
            done = true;
            manualDone = true;
            stop("manual_confirmation", "manual confirmation (human oracle)", stepNo);
            break;
          }
        }
        // DOM signals are the only truth, so the model's noul is consulted ONLY
        // when no DOM signal exists — and even then it never grants `done`, it
        // just stops the loop with an explicit "unverified" reason.
        if (goalSignalFn === null) {
          const doneP = await this.isDone(instruction, pg);
          if (doneP >= this.doneThreshold) {
            done = false;
            stop("noul_unverified",
              `laya claims done (p=${doneP.toFixed(2)}) but no DOM signal to verify`, stepNo);
            break;
          }
        }
        // D3 / R-4: HOW OFTEN was this exact element effectively driven without the
        // subgoal's signal ever becoming true? `inert` is a full-page snapshot diff, so a
        // page with a running countdown/carousel is NEVER inert: the evidence chain breaks,
        // anti-repeat does not fire, and the same dead button is clicked until `max_steps` —
        // a noise signal must not be the loop's only terminator. Measured on
        // dead-target fixture (50 ms tick): 8 clicks on the dead button, `max_steps`,
        // 4.5 s. The count is keyed by element SIGNATURE (refs are positional and re-indexed
        // every scan) and reset by nothing: within ONE subgoal a repeat is a repeat.
        {
          const repeatKey = JSON.stringify(esig(el));
          const ran = (effectiveRuns[repeatKey] ?? 0) + 1;
          effectiveRuns[repeatKey] = ran;
          if (this.maxEffectiveRepeats > 0 && ran > this.maxEffectiveRepeats) {
            stop("no_progress",
              `${el.tag} "${el.label}" was executed ${ran} time(s) in this subgoal `
              + `and the done-signal never held — the target looks dead (or the signal can never fire); `
              + `stopping here instead of blaming the step budget (max_steps=${this.maxSteps}) on step ${stepNo}`,
              stepNo);
            if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
            break;
          }
        }
        // Inert action on this element -> forbid it for the rest of the subgoal
        // regardless of method (this is what killed the Sign-in loops).
        // A1 §2.2.5：**done 在动作前已成立**（done_preheld）时，click 快照没变不能判死元素——
        // 动作可能是异步生效，或 done 本来就成立、这次动作只是搭便车。记 suspected_async 警告，
        // 不 forbid、不写 outcome memory inert（否则会把一次有效动作记成死元素，跨运行继续误伤）。
        // 动作后 done 成立的路径在这之前已 break，不会走到这里。
        if (inert) {
          if (how === "clicked" && donePreheld === true) {
            flagSuspectedAsync();
            continue;
          }
          forbid(ref, el, "inert");
          outcomeMemory?.record(outcomeMemory.key(urlOf(pg), instruction), JSON.stringify(esig(el)), "inert");
          continue;
        }
        // It worked: forget any earlier inert mark for this exact element (pages
        // change, and a stale blacklist would be worse than no memory).
        outcomeMemory?.record(outcomeMemory.key(urlOf(pg), instruction), JSON.stringify(esig(el)), "effective");
        if (this.antiRepeat) {
          // Forbid after a *semantic* (laya) pick that missed the signal, or
          // after any fill that did not advance it. Rule hits on clicks stay
          // exempt: two subgoals may legitimately drive the same button, and the
          // inert guard catches dead loops.
          if (method === mm || how === "filled") forbid(ref, el, "anti-repeat");
        }
        // A2′：裁决过一次的元素不配第二次机会——声明说"错了白跑"，白跑一次就是它的全部代价。
        // 不挂在 antiRepeat 下（那是循环通用卫生），因为"一次裁决"是 A2′ 的语义本身：
        // 走到这里 = 执行了、非惰性、信号没成立 ⇒ 这一格裁判已给出"不算"，禁掉换下一个候选。
        if (method === `${mm}:adjudicated` && executed) forbid(ref, el, "adjudicated-missed");
        // 动作间最小等待：只在实际执行过动作、且还要继续要下一个动作时付。
        // 放在所有"这步已经结束/这块元素被禁"的分支之后，done 的路径不会多等。
        if (executed && this.actionDelayMs > 0) await sleep(this.actionDelayMs);
      }
      // S1 收尾观察：本 run 的 after 指纹。一次池提取，页面不可读时整条省略（不硬造）。
      let afterFp: StateFingerprint | undefined;
      try {
        const elemsAfter = (await this._extractPoolSettled(pg, candidatePriority)).elems;
        afterFp = await observeState(elemsAfter);
      } catch { afterFp = undefined; }
      // 前进性判定（§2.4）：只在本 run 的**实际事务**上算，done 语言不变。
      const actionRows = trace.filter((t) => t.executed === true || t.skipped === true);
      const attempted = actionRows.length;
      const executedN = actionRows.filter((t) => t.executed === true).length;
      const changedN = actionRows.filter((t) => t.executed === true && t.changed === true).length;
      // 没有 after 观察就不判前进性（不能把“没看见”写成“没前进”）。
      const observed = beforeFp !== null && afterFp !== undefined;
      const progressed = beforeFp !== null && afterFp !== undefined
        && (afterFp.struct !== beforeFp.struct
          || afterFp.url !== beforeFp.url
          || afterFp.navEpoch !== beforeFp.navEpoch);
      const lastActionStep = actionRows.length
        ? Number((actionRows[actionRows.length - 1] as Record<string, unknown>)["step"] ?? 0) || undefined
        : undefined;
      const flags: StateFlag[] = [];
      if (poolEmptyThisStep) flags.push("pool_empty");
      if (donePreheldSeen) flags.push("done_preheld");
      if (done && observed && attempted > 0 && executedN > 0 && changedN === 0 && !progressed) {
        flags.push("no_state_progress");
        warnings.push(
          `no_state_progress: done held after ${executedN} executed action(s) but the page snapshot `
          + `did not change and the state fingerprint did not advance`
          + (lastActionStep === undefined ? "" : ` (step ${lastActionStep})`)
          + ` — the signal may not be evidence of the action`,
        );
      }
      // W1 验收：原“attempted>0 && executed==0 && done && !progressed”的串扰 flag
      // 在控制流上不可达——全 skip 的步会先因 done 不成立而失败，done 成立则必有 executed>0。
      // 该 flag 类别已移除；r8 跨城串扰签名由 done_preheld（命令步动作前预评估）+ no_state_progress 覆盖。
      // S5b：下一次 ask 的 state_digest 只带**已经发生过**的 flags（本步判定完才更新）。
      this._runFlags = [...flags];
      if (beforeFp !== null) {
        stepState = {
          before: beforeFp,
          ...(afterFp === undefined ? {} : { after: afterFp }),
          // S2：策略关闭时键省略（缺字段 = 该事实不适用）；开启时 0 也表示"settle 跑过但无需等待"。
          ...(this.settlePolicy === null ? {} : { settleMs: this._settleWaitMs }),
          actions: { attempted, executed: executedN, changed: changedN },
          flags,
          ...(lastEffect === null ? {} : { effect: lastEffect }),
        };
      }
    } finally {
      // Only close the browser run() launched itself: an injected page/pw belongs
      // to the caller (PORT NOTE 5, Python's owns_browser/_stop_playwright_owned).
      if (browser !== null) await browser.close();
    }

    const verdict = (await this.auditor.audit(instruction, trace, done)) as AuditVerdict;
    const stoppedCode = stopCode as StopCode;
    const diagnostics: RunReport["diagnostics"] | undefined = (
      stoppedCode === "page_not_ready" || stoppedCode === "target_not_found"
      || stoppedCode === "target_ambiguous" || stoppedCode === "action_space_exhausted"
      // U3：ready_empty 没有停因（步级继续），但"池空且已就绪"是必须落盘的事实。
      || (lastReadiness !== null && lastReadiness.verdict !== "ready")
    ) ? {
      pool_size: lastPoolSize,
      ...(poolReady ? { waited_ms: lastPoolWaitedMs } : {}),
      ...(viewportUnderloaded !== null ? { viewport_underloaded: viewportUnderloaded } : {}),
      ...(lastReadiness !== null && lastReadiness.verdict !== "ready" ? { readiness: lastReadiness } : {}),
    } : undefined;
    // A1 动作执行证据汇总（只从 trace 汇总一次，不新增页面往返）：
    //   executed        —— 本子目标是否有动作真的执行（有动作面时必答；缺字段 = 没有动作面）；
    //   executed_actions—— 每个已执行动作的 op/ref/target/how/changed；
    //   skipped_actions —— 每条"为什么没动作"的结构化原因（见 skippedActions）；
    //   done_preheld    —— 命令步动作前的 done 预评估（缺字段 = 本步不是命令步/没信号）；
    //   warnings        —— suspected_async 等运行期诚实话。
    // 动作行 = 有 changed（执行过）或有 skipped（尝试过但没执行）的行；manual 等非动作行不混进来。
    const actionRows = trace.filter((t) =>
      Object.prototype.hasOwnProperty.call(t, "changed") || t["skipped"] === true);
    const executedRows = actionRows.filter((t) => t["executed"] === true
      && ["clicked", "filled", "scrolled", "dragged", "hovered", "uploaded"].includes(String(t["how"] ?? "")));
    const hasActionFace = cmdSpace.length > 0 || actionRows.length > 0;
    const executedActions: ExecutedAction[] = executedRows.map((t) => {
      const rawHow = String(t["how"] ?? "clicked");
      const files = Array.isArray(t["files"])
        ? (t["files"] as unknown[]).filter((f): f is string => typeof f === "string")
        : null;
      // U7：clickAt 的元素相对坐标从 trace 行原样汇总（声明值与实测点击同源）。
      const p = t["position"] as { x?: unknown; y?: unknown } | undefined;
      const position = p !== undefined && typeof p.x === "number" && typeof p.y === "number"
        ? { x: p.x, y: p.y }
        : null;
      return {
        op: String(t["op"] ?? rawHow ?? "click"),
        target: typeof t["target"] === "string" ? t["target"] : null,
        ref: String(t["ref"] ?? ""),
        // U6：upload 的动作结果词是 uploaded，证据面按 Playwright 原语名记 setInputFiles。
        how: (rawHow === "uploaded" ? "setInputFiles" : rawHow) as ExecutedAction["how"],
        desc: String(t["desc"] ?? ""),
        changed: t["changed"] === true,
        ...(files !== null ? { files } : {}),
        ...(position !== null ? { position } : {}),
        ...(t["resolved_by"] === "dom_identity" ? { resolved_by: "dom_identity" as const } : {}),
      };
    });
    // S4 证据汇总：stale 重试每次一条（trace 行本来就一次只落一行），force 只在真正执行时出现。
    const staleRetries: Array<{ attempt: number; reason: string; ref: string }> = [];
    for (const t of trace) {
      if (Array.isArray(t["stale_retry"])) {
        staleRetries.push(...(t["stale_retry"] as Array<{ attempt: number; reason: string; ref: string }>));
      }
    }
    const forcedExecuted = executedRows.some((t) => t["forced"] === true);
    return {
      goal: instruction, done, stop_reason: stopReason, steps: trace, audit: verdict,
      stop_code: stopCode,
      ...(hasActionFace ? { executed: executedRows.length > 0 } : {}),
      ...(executedActions.length ? { executed_actions: executedActions } : {}),
      ...(skippedActions.length ? { skipped_actions: skippedActions.slice(0, 20) } : {}),
      ...(staleRetries.length ? { stale_retries: staleRetries } : {}),
      ...(forcedExecuted ? { forced: true } : {}),
      ...(donePreheld !== null ? { done_preheld: donePreheld } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(stepState === undefined ? {} : { state: stepState }),
      ...(diagnostics !== undefined ? { diagnostics } : {}),
      ...(stopStep !== undefined ? { stop_step: stopStep } : {}),
      ...(manualDone ? { manual: true } : {}),
      ...(dryRan ? { dry_run: true } : {}),
    };
  }
}
