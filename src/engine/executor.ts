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
import { lastBrowserLaunchFacts } from "../browser/browser-env.ts";
import type { BrowserLike, LaunchOptions } from "../browser/browser-env.ts";
import {
  INTERACTIVE_ALL,
  MAX_CHOICES,
  WIDE_POOL_ELEMENTS,
  WIDE_QUOTAS,
  ariaInteractiveLines,
  criteriaView,
  esig,
  extractSlots,
  elemFamily,
  lexicalOverlap,
  filterElemsByFamily,
  actionCapabilities,
  firstOf,
  probeHintInDom,
  frameAt,
  frameGateOf,
  frameHintFailureEvidence,
  framesOf,
  framesScopedPage,
  hintLookup,
  orderElemsByFamily,
  poolSniff,
  probeExcludedHint,
  stateText,
  urlInHostsEnvelope,
  urlOf,
  viewportUnderload,
  type ActionCapability,
  type Elem,
  type ElemFamily,
  type ElemPool,
  type FrameGate,
  type FrameLike,
  type PageLike,
} from "./extraction.ts";
import { elemFrameStamp, frameGateExcludes, frameScopeMatchesFrame } from "./frame-scope.ts";
import { assembleDecisionRuntime } from "./decision-seam.ts";
import { ANCHOR_JS, ROW_CLIMB_JS, compile } from "./pool-js.ts";
import { describeAmbiguity, orderCandidatesByDomPreorder, type AmbiguityView, type AmbiguousOrdering } from "./ambiguity.ts";
import { admitSelectorWithJsFor, type SurfacePolicy } from "./surface.ts";
import {
  getLayaRuntime,
  type ChoiceAnswer,
  type DecisionAgent,
  type ModelState,
  type NoulAnswer,
  type RouterLike,
} from "../model/model.ts";
// task-24/6a：限速判据阈值单一出处（step 侧与 arrive 侧共用）。
import { THROTTLE_BODY_FLOOR, THROTTLE_COLLAPSE_RATIO, THROTTLE_POOL_HIGH_MIN } from "./throttle-signature.ts";
import { DEFAULT_CONF_FLOOR } from "../support/config-schema.ts"; import { DONE_POLL_INTERVAL_MS, NAVIGATION_GOTO_TIMEOUT_MS, POOL_CAP_ELEMENTS } from "../support/tuning.ts"; import type { DecisionProvider, EvidenceTruncation } from "../support/decision-provider-contract.ts";
import { sleep } from "../support/sleep.ts";
// task-14（D1）：探测失败分类与建议文案的单一出处。
import { classifyDecisionFailure, decisionDegradedAdvice } from "../model/decision-probe.ts";
import { applyRange, type RangeOptions, type RangeOutcome, type RangeValue } from "./range.ts";
import {
  DESTRUCTIVE_PATTERNS,
  FILLER_TOKENS,
  NAV_VERBS,
  ROLE_TOKENS,
  STOP_TOKENS,
  affordanceRule,
  anchorChainMatch,
  hintCandidates,
  hintMatch,
  navRule,
  takeHintMatchOthers,
  type HintMatchCandidate,
  type HintMatchOptions,
  type HintMatchOthersDiag,
} from "./rules.ts";
import { checkSignal, isWeakNegativeSignal, LOGIN_WALL_TEXTS, LOGIN_WALL_URL_RE, type SignalSpec } from "./signals.ts";
// S2 稳定门：MutationObserver 传感器 + 有界静默等待（只作观察增强，不中断执行循环）。
import { DEFAULT_SETTLE, installSettle, settle, type SettlePage, type SettleResult } from "./settle.ts";
// 语法报错文案的唯一出处：形状清单不再手抄（grammar-prompt import 时自证与 parseHint 对齐）。
import { HINT_CLOSED_SET_TEXT } from "./grammar-prompt.ts";
import { RISK_INSTRUCTIONS_LONG, doneInstructionsLong } from "../prompts/model-prompts.ts";
// A2 判别：命令 target 是 hint 语法字符串，词面要从同一份解析器里取（不新开第二种解析）。
import { parseHint } from "./hint.ts";
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
/* 类型面拆到 executor-types.ts（F2）：export * 保持对外 API；import 供本文件类体用。 */
export * from "./executor-types.ts";
import {
  DEFAULT_DECISION_STATE, STATE_DIGEST_MAX_BYTES,
  type AnyLoc,
} from "./executor-types.ts";
import type {
  ActionabilityDetail,
  AnyPage,
  AuditVerdictLike,
  BrowserHandle,
  BrowserSession,
  DecisionRuntimeHooks,
  DecisionStateContext,
  DecisionStateGate,
  DecisionStateMetrics,
  DecisionStatePolicy,
  EscalationRequest,
  EscalatorLike,
  ExecutedAction,
  HintMemoryLike,
  MiddlewareOptions,
  OutcomeMemoryLike,
  OverlayEvidenceRow,
  PageSnapshot,
  PickProposal,
  PwLike,
  Readiness,
  ReadinessVerdict,
  ReadyState,
  RunOptions,
  RunReport,
  SkippedAction,
  StateDigest,
  StateEffect,
  Sig,
  StateFingerprint,
  StateFlag,
  StepStateRecord,
  StopCode,
  ThrottleSuspect,
} from "./executor-types.ts";

/** `new Function("return (<expr>);")()` -> a real function object for evaluate(). */
/** Host-side JS passes —— 拆到 eval-snippets.ts（F2）。 */
import {
  asFunction, FN_STATE, FN_HIT, FN_HIT_DETAIL, FN_EMPTIES, FN_GUARD, FN_OVERLAY,
} from "./eval-snippets.ts";
import {
  clickActionableAncestor, declaredHitTest, describeActionFailure, hitRelation, occlusionProbe,
} from "./executor-actionability.ts";

/* ------------------------------------------------------------------ run ctx */

/**
 * F3：run() 报告尾（runReportTail）的只读上下文。它是 run() 执行循环结束后
 * 的状态快照——false_done 复核 / 审计 / 限速嗅探 / diagnostics / 最终 RunReport
 * 都只**读**这些事实，不再修改执行循环。字段名与 run() 局部变量一一对应，
 * 保证调用点零改写；`stop` 闭包以函数形式传入（runReportTail 在 false_done
 * 档会写 stopCode/stopReason，复用同一闭包保持记账单一来源）。
 */
export interface RunReportTailCtx {
  instruction: string;
  done: boolean;
  manualDone: boolean;
  dryRan: boolean;
  donePreheld: boolean | null;
  stopCode: StopCode;
  stopReason: string;
  stopStep: number | undefined;
  trace: TraceStep[];
  goalSignalFn: ((page: AnyPage) => Promise<boolean> | boolean) | null;
  page: AnyPage | null;
  hostGate: string[] | null;
  doneSpec: SignalSpec | null;
  executedCount: number;
  frameGate: FrameGate | null;
  doneInExcluded: boolean;
  warnings: string[];
  lastPageRef: AnyPage | null;
  lastPoolSize: number;
  lastPoolWaitedMs: number;
  lastReadiness: Readiness | null;
  viewportUnderloaded: Array<{ tag: string; id: string; scrollHeight: number; clientHeight: number; rendered: number }> | null;
  getLastDeclaredHidden: () => { target: string; hidden: number; total: number } | null;
  skippedActions: SkippedAction[];
  stepState: StepStateRecord | undefined;
  cmdSpace: CommandDecl[];
  verbose: boolean;
  poolReady: boolean;
  stop: (code: StopCode, detail?: string, at?: number) => void;
}

/** `runFrameGate` 的返回值：early = 早停报告；ready = 循环所需状态（doneInExcluded 走 getter 跨阶段可观察）。 */
export type FrameGatePhase =
  | { readonly kind: "early"; readonly report: RunReport }
  | { readonly kind: "ready"; readonly frameGate: FrameGate | null; readonly goalHeld: () => Promise<boolean>;
      readonly frameTargetStop: (target: string) => Promise<{ code: StopCode; reason: string } | null>; readonly doneInExcluded: () => boolean; };

/** `runPoolGate` 的返回值：stopped = 页面未就绪早停；其余为后续循环/报告尾要用的每步事实。 */
export type PoolGatePhase = {
  stopped: boolean; stepStartUrl: string; stepStartTabs: number; elems: ElemPool;
  gateSettle: SettleResult | null; lastPoolSize: number; lastPoolWaitedMs: number;
  beforeFp: StateFingerprint | null; pendingAfterIdx: number | null; lastReadiness: Readiness | null;
  poolEmptyThisStep: boolean; readyEmptyWarned: boolean;
};

/** `runDeclaredTargets` 的返回值：stopped = 命令 walk 已停（stop 已记账）；cmdPick 供后续动作面。 */
export type DeclaredTargetsPhase = {
  stopped: boolean;
  cmdPick: { cmd: CommandDecl; ref: string; index: number; cands: string[] } | null;
  rowAmbStop: { code: StopCode; reason: string } | null;
  cmdI: number;
};

/** `runDeclaredHint` 的返回值：stopped = act-hint 解析面已停（stop 已记账）；curHint 供后续规则/动作面。 */
export type DeclaredHintPhase = {
  stopped: boolean;
  curHint: string | null;
};

/** `runModelPick` 的返回值：stopped = 选择段已停（stop 已记账）；elems 为宽扫后的本步视图。 */
export type ModelPickPhase = {
  stopped: boolean; ref: string | null; conf: number; method: string;
  decisionKind: "rule" | "model" | "escalate"; layaMargin: number | null;
  tierAsk: { n: number; tier: number } | null; nominatedRepair: boolean;
  escalatedPick: string | null; elems: ElemPool; label: string;
};

/** `runPostAction` 的返回值：control 决定调用点 continue/break；run 级状态用返回值回写。 */
export type PostActionPhase = {
  control: "next" | "continue" | "break";
  done: boolean; manualDone: boolean;
};

/** `runActionPhase`（经 `runActionExecute`）的返回值：control 决定 continue/break；其余回写 run()。 */
export type ActionPhaseResult = {
  control: "next" | "continue" | "break";
  ref: string; el: Elem; elems: ElemPool;
  desc?: string; how?: string | null; executed?: boolean; inert?: boolean;
  post?: Awaited<ReturnType<BrowserMiddleware["snapshot"]>>;
  lastEffect?: StateEffect; flagSuspectedAsync?: () => void;
  cmdDoneId?: string | null; nextCmdI?: number | null; executedDelta?: number;
};

/** `runSetup` 的返回值：early = 预检拒绝（report 原样返回）；ready = 页面/浏览器/观察闭包。 */
export type SetupPhase =
  | { kind: "early"; report: RunReport; browser: BrowserHandle | null }
  | { kind: "ready"; pg: AnyPage; browser: BrowserHandle | null; observeState: (elems: ElemPool | null) => Promise<StateFingerprint> };

/* ------------------------------------------------------------------ helpers */

/**
 * Navigation envelope (P0-4).
 *
 * `hosts` used to be a LOAD-TIME fact only: type-checked in `app-pack.ts`, the input
 * of the leak gate — and never consulted at runtime, so any pack could navigate to
 * any host. With an allow-list given, a URL whose host is not declared is refused
 * BEFORE the page goes there (and a mid-journey redirect onto an undeclared host
 * stops the subgoal with a structured reason). An empty/absent list disables the
 * envelope: offline fixture packs declare no hosts and must keep working unchanged.
/** 纯函数区（helpers/池判定/风险刻画/缺省确认）—— 拆到 executor-pure.ts（F2）。 */
import { _executeElement, _missingRequired, _hintOpts, resolveCommandRef } from "./executor-resolve-a.ts";
import { _resolveOne, _rehydrateRescanOnce, _liveDomIdFallback, _probeCleanup, _domFallbackResolve, _resolveAxFallback, _resolveClickxyFallback } from "./executor-resolve-b.ts";
import { actOnce, _scrollIntoViewWithEvidence, scrollIntoView, _scrollContainerForElement, _scrollWithLoc, scrollContainer, scrollDocument, setRange } from "./executor-actions.ts";
import { runFrameGate, runPoolGate, runDeclaredTargets, runDeclaredHint } from "./executor-phases-a.ts";
import { runModelPick, runPostAction } from "./executor-phases-b.ts";
import { runActionPhase, runActionExecute, runSetup, runTail, runReportTail } from "./executor-phases-c.ts";
export * from "./executor-pure.ts";
import type { ActMissDiagnostics, ActMissRow, DeviceSpec } from "./executor-pure.ts";
import {
  firstLoc, round3, fnv1aText, structDigest, contentDigest, topTwoMargin,
  describeActionError, sigEq, WIDER_ELEMENTS, WIDER_ELEMENTS_MAX, windowChainMissSuffix,
  type WindowChainFact,
  ALL_FAMILIES,
  DEFAULT_CONFIRM,
  EFFECT_MASK,
  SECRET_INPUT_TYPES,
  actMissDiagnostics,
  actMissDiscrimination,
  bindingCandidateSummaries,
  candidateName,
  candidateText,
  carriesSecret,
  cmdDiscrimination,
  cmdFamilies,
  contextPageCount,
  declaredAllow,
  deniedContextUrl,
  disallowedHost,
  firstPoolText,
  frameTargetStopReason,
  goalLexemes,
  lexMatchOne,
  lexWords,
  lowConfDiscrimination,
  matchedOthersWarning,
  modelProjectionOf,
  nearCandidates,
  poolRoleSummary,
  redactValue,
  safeUrl,
  targetMatcher,
  weakHintRejectedWarning,
  weakRejectedReason,
} from "./executor-pure.ts";
import { createRunAccounting, type RunAccounting } from "./run-context.ts";
import type { CandidateProducer } from "./candidate-contract.ts";
import { createDeclaredTargetsResolver, type DeclaredTargetsResolver } from "./declared-targets.ts";
import {
  declaredEvidence, declaredHiddenSuffix, declaredMissSuffix, drfHintSuffix,
  identityEvidence, identityHiddenSuffix, rowEvidence,
} from "./evidence.ts";

/**
 * B2：一次滚动的**实测证据**（容器滚动与滚入视口共用同一形状）。
 *
 * `moved`/`delta` 是 before/after 两个 scrollTop 读数算出来的事实；`scrollTop`/
 * `scrollHeight`/`clientHeight` 三个都在才是可回显的容器几何（"有则附，没有就不附"）。
 * 失败时 `stopCode` 走既有闭集（stale_ref / action_failed / not_scrollable / …），不新增停因。
 */
export interface ScrollEvidence {
  ok: boolean;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  moved?: boolean;
  /** B2：after - before（正 = 向下滚），与 moved 同一对读数。 */
  delta?: number;
  stopCode?: string;
  reason?: string;
}

/**
 * B2：容器几何三件套。三个都是有限数才算"有几何"——缺一个键就不附（"有则附，没有就不附"），
 * 不在响应里填 undefined 占位，也不拿默认值假装量到了。
 */
export function scrollGeoOf(v: { scrollTop?: number; scrollHeight?: number; clientHeight?: number }): {
  scrollTop?: number; scrollHeight?: number; clientHeight?: number;
} {
  return typeof v.scrollTop === "number" && Number.isFinite(v.scrollTop)
    && typeof v.scrollHeight === "number" && Number.isFinite(v.scrollHeight)
    && typeof v.clientHeight === "number" && Number.isFinite(v.clientHeight)
    ? { scrollTop: v.scrollTop, scrollHeight: v.scrollHeight, clientHeight: v.clientHeight }
    : {};
}

/**
 * A2：单动作面（`actOnce` 的 `onAmbiguous:"fail"` 档）歧义停因的人读 reason。
 * 结构化证据在 `ambiguity`；这里只说明「为什么不动作」与两条修法。
 */
export function ambiguityStopReason(target: string, poolSize: number, amb: AmbiguityView): string {
  const where = amb.source === "dom_fallback"
    ? `the DOM fallback candidate set (${amb.candidates_total} distinct candidate(s); nothing matched the visible pool of ${poolSize})`
    : `a pool of ${poolSize} element(s) (${amb.candidates_total} distinct candidate(s))`;
  return `target ${JSON.stringify(target)} matches several candidates in ${where} — single-action resolution never guesses; `
    + `re-observe and narrow the hint (unique #id / [data-test=…] / role word), `
    + `or use on_ambiguous:"act" (--on-ambiguous act) to act on the first actionable candidate (the old behaviour)`;
}

/**
 * F82/F83 评审收口（P0）：目标串是否声明了行锚尾缀（`in-row:` / `row-index:`）。
 *
 * 行锚声明下"多候选 = 零动作"是产品承诺（`ROW_ANCHOR_HINT_PLAN §3.9` / `APP_SCRIPT §10`）：
 * 行身份是"哪一行"，不是可互换的重复元素。`rules.hintMatchImpl` 已对行锚 fail-closed
 * （候选 >1 返回 null），但命令走廊/决策步的候选列表来自 `resolveCommandRef`
 * （`hintCandidates` 的 refs 按"逐个尝试"语义返回多个）——两处消费面必须在**取首候选/
 * widen 之前**把行锚歧义落成结构化 `target_ambiguous`，否则仍会"静默点第一行/交模型猜"。
 */
export function declaresRowAnchor(hint: string | null | undefined): boolean {
  if (typeof hint !== "string" || hint.trim() === "") return false;
  const parsed = parseHint(hint);
  return parsed.inRow !== undefined || parsed.rowIndex !== undefined;
}

/* ------------------------------------------ E1（within 权威对等）：A3/F64 的 PASS 常量 */
// （导出仅为离线断言可访问——差分对照脚本真跑 pass；运行时调用面只用本文件内的
//  PASS_DOM_FALLBACK / PASS_ID_FALLBACK。）

/**
 * A3 池外回退的 DOM 收集 pass。原为 inline TS arrow evaluate——**闭包不跨**（Playwright
 * 序列化函数源码，宿主变量进不去），共享 ANCHOR_JS 必须 `${}` 内插进 pass 源码 ⇒ 转
 * `compile()` PASS 常量（identity PASS_IDENTITY 先例）。行补 `anchors` → 合成主帧行
 * 透传 anchor_ids（与真池行同构；`#x within:#p` 在 A3 面与池侧 inAnchor 同语义）。
 * JS 体与原 TS arrow 的序列化源码逐行对应（仅去掉类型标注 + 行补 anchors）。
 *
 * F82（A3 第二评审补漏项）：共享 ROW_CLIMB_JS 内插（与池/回捞/observe 同一爬升实现）；
 * `arg.inRow` 声明时（仅 in-row hint 走到这里）每行补 `row_texts`（additive，≤6 行 ×
 * ≤40 字符）——fallback 行并入主池后同样走二次 hintMatch 的 inRow 过滤，缺字段 =
 * 重演 F-1 半链缺口（回捞死路）。in-row 未声明时 dupLabels 为 null、零爬升、行形状与
 * 今天逐字节一致。
 *
 * F83（A3 row-index 对等）：`arg.rowIndex` 声明时每行补 `row_index`（dup 组内 DOM 先序
 * 位次表，一次 O(n)——v1.0 §3.5 单用零爬升：row-index-only 不触发 __rowClimb）；缺字段 =
 * rowIdx 过滤清零 = 死路。未声明任一行锚时行形状与今天逐字节一致。
 */
export const DOM_FALLBACK_COLLECT_JS = String.raw`(arg) => {
  const g = globalThis;
${ANCHOR_JS}
${ROW_CLIMB_JS}
  const sel = arg.sel, tok = arg.tok;
  const out = [];
  const all = g.document.querySelectorAll(sel);
  const rowCtx = (arg.inRow === undefined && arg.rowIndex === undefined) ? null : (() => {
    // F85（评审收口）：dup 键用共享 __rowLabelOf（与池/observe 同口径），且只计**可见**成员
    // ——池/observe 的编号都基于可见成员；A3 收集本含隐藏元素，若把隐藏成员计入编号，
    // 同一个 N 会指到与池面不同的行。
    const pairs = [], els = [];
    for (let i = 0; i < all.length; i++) {
      const e = all[i];
      if (!__rowVisible(e)) continue;
      pairs.push([__rowTag(e), __rowLabelOf(e)]);
      els.push(e);
    }
    return { labels: __dupLabelsOf(pairs), pairs: pairs, els: els };
  })();
  const rowIdxMap = new Map();
  if (arg.rowIndex !== undefined && rowCtx !== null) {
    const cnt = {};
    for (let i = 0; i < rowCtx.pairs.length; i++) {
      const k = __dupKeyOf(rowCtx.pairs[i][0], rowCtx.pairs[i][1]);
      cnt[k] = (cnt[k] || 0) + 1;
    }
    const seen = {};
    for (let i = 0; i < rowCtx.pairs.length; i++) {
      const k = __dupKeyOf(rowCtx.pairs[i][0], rowCtx.pairs[i][1]);
      if ((cnt[k] || 0) <= 1) continue;
      seen[k] = (seen[k] || 0) + 1;
      rowIdxMap.set(rowCtx.els[i], seen[k]);
    }
  }
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    const tag = String(e.tagName || "").toLowerCase();
    const label = String(e.getAttribute("aria-label") || e.getAttribute("title") || e.innerText
      || e.getAttribute("placeholder") || e.getAttribute("value") || "").replace(/\s+/g, " ").trim().slice(0, 200);
    e.setAttribute("data-af-probe", tok + "-" + i);
    let rowTexts = null;
    if (arg.inRow !== undefined && rowCtx !== null && __rowVisible(e)) {
      const c = __rowClimb(e, rowCtx.labels);
      if (c.rows.length) rowTexts = c.rows;
    }
    const selIdx = arg.rowIndex !== undefined && rowCtx !== null ? rowIdxMap.get(e) : undefined;
    out.push({
      i, tag, label,
      role: String(e.getAttribute("role") || "").toLowerCase(),
      id: String(e.id || ""),
      dt: String(e.getAttribute("data-test") || ""),
      type: String(e.getAttribute("type") || "").toLowerCase(),
      draggable: String(e.getAttribute("draggable") || "").toLowerCase() === "true",
      anchors: anchorIdsOf(e),
      ...(rowTexts !== null ? { row_texts: rowTexts } : {}),
      ...(selIdx !== undefined ? { row_index: selIdx } : {}),
    });
  }
  return out;
}`;
export const PASS_DOM_FALLBACK = compile("arg", `return (${DOM_FALLBACK_COLLECT_JS})(arg);`);

/**
 * F64 `#id` live-DOM 单点直查 pass。E1：一次 `evaluate` 返回 anchors + TS 判定——
 * 二次求值多一次跨源往返且原子性差；anchors 还能区分「找到但在锚外」（evaluate 结果
 * hit 非 null 且 anchors 不含 within）与「找不到」（hit 为 null）。原为 inline TS arrow
 * evaluate，同 A3 转 `compile()` PASS 常量再内插 ANCHOR_JS。
 */
export const ID_FALLBACK_PROBE_JS = String.raw`(arg) => {
  const g = globalThis;
${ANCHOR_JS}
  const el = g.document.getElementById(arg.id);
  if (el === null || el === undefined) return null;
  const rect = el.getBoundingClientRect();
  const cs = g.getComputedStyle(el);
  const visible = rect.width > 0 && rect.height > 0
    && cs !== null && cs.display !== "none" && cs.visibility !== "hidden";
  el.setAttribute("data-af-probe", arg.attr.slice("data-af-probe=\"".length, -1));
  return {
    tag: String(el.tagName || "").toLowerCase(),
    visible,
    label: String(el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 40),
    anchors: anchorIdsOf(el),
  };
}`;
export const PASS_ID_FALLBACK = compile("arg", `return (${ID_FALLBACK_PROBE_JS})(arg);`);

/** X1：去掉实现函数第一个参数（`mw`）后的参数元组；包装方法用它保持原签名类型。 */
type OmitMw<T extends readonly unknown[]> = T extends readonly [unknown, ...infer R] ? R : never;

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
  // task-14（D1·兼容性三件）：决策面起跑探测失败/中途死亡的**诚实留痕**。
  // decisionCompat = 本次 run 在兼容范围（默认配置面 AMBERFLOW_DECISION_BASE_URL 已配置且未
  // 显式指定 provider——app-runner 起跑时置位）；markDecisionDegraded 置降级态：规则面继续、
  // 升级链规则兜底、死服务不重试（pickInner 捕获一次即 rulesOnly 永久翻转 + escalate 守卫）。
  decisionCompat = false;
  decisionDegraded: {
    reason_class: "unreachable" | "auth" | "protocol" | "midrun_death" | "unknown";
    message: string;
    config_source: string;
  } | null = null;
  markDecisionDegraded(d: NonNullable<BrowserMiddleware["decisionDegraded"]>): void {
    this.decisionDegraded = d;
    // 与"本地模型不在位"同一条规则面：声明点名的步照跑，需要选点的步按规则面如实 block。
    this.rulesOnly = true;
    this.rulesOnlyReason = d.message;
    this.providerDegraded = d.message;
    // 决策面已知死亡：done 票/风险问询不再碰它（decision=null 的既有守卫天然生效）。
    this.decision = null;
  }
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
  /**
   * P0-D：本次 run 生效的 host 信封（`hosts ?? this.hosts`）。池/hint/identity/DRF 的抽帧面
   * 用它排除第三方 iframe；null = 无声明 = 与今天逐字节相同。
   */
  _frameHosts: string[] | null = null;
  /** task-11（B3）：会话级池高峰（每次抽池记账，零成本）——限速骤降判据的基线。 */
  _sessionPoolHigh = 0;
  _sessionFirstPoolTs = 0;
  /** task-11（B3）：上一次失败路径嗅探（正文/可交互基线；只在失败路径更新）。 */
  _lastFailSniff: { body_text: number; admitted: number } | null = null;
  /** task-16（B3+）：会话正文峰值（每次失败嗅探记账；arrive 侧限速判据的基线来源）。 */
  _bodyTextPeak = 0;

  /**
   * task-26（D2 A/B）：模型面注入的 fenced 站点事实块（opt-in——app-runner 按
   * AMBERFLOW_SITE_FACTS_INTO_MODEL=1 渲染后赋值；缺省 null = notes 原样，逐字节不变）。
   * 只进 pick 的 notes（done 票/风险问询不注入）；本地 laya（schema 固定）忽略 notes。
   */
  siteFactsNotes: string | null = null;

  /** task-16（B3+）：arrive 侧限速判据读的会话正文峰值（零参数只读）。 */
  sessionBodyTextPeak(): number {
    return this._bodyTextPeak;
  }
  /**
   * P0-B：act_hint:"strict"（缺省 false = 今天）。为 true 时，声明目标解析链
   * （池 hintMatch → ADMIT 回捞 → FW8 身份回捞 → rules-only 宽扫）全部未命中后
   * 不再交给模型自由选，直接结构化 target_not_found。
   */
  actHintStrict = false;
  /**
   * A3：`meta.policy.act_hint_tier`（缺省 "any" = 今天逐字节不变）。与 `actHintStrict`
   * **正交**：`actHintStrict` 管"没命中怎么办"，本开关管"弱档（bare t≥3 词前缀/词包含、
   * attrSubstr t=3 loose 子串）算不算命中"。`"strong"` = 弱档胜出判为**未命中**
   * （复用 `rules` 的 `suspicious` 判据，不另造档位表）；随后照 `actHintStrict` 既有语义走。
   */
  actHintTier: "any" | "strong" = "any";
  /** P0-C：DRF（声明目标解析面）开关；缺省 false = 今天逐字节不变。 */
  targetResolutionDeclared = false;
  /**
   * F74：`meta.policy.act_hint_dom_fallback`（缺省 false = 今天逐字节不变）。true = 决策步
   * act hint 在 池→ADMIT 回捞→FW8→(DRF)→(U5/F72 条件跳) 全链真落空后，补一次**主帧
   * ADMIT_SEL DOM 回退跳**（与会话 act 的 `_domFallbackResolve` 同一实现：不过滤可见性、
   * 含 0×0 自绘控件）——补齐"会话 act 能解的声明 hint 在 run 解不了"的 authoring→run
   * 可移植性缺口。命中 = 合成池 + 确定性 rule:match（不进模型投影）；至多一次/步。
   */
  actHintDomFallback = false;
  /**
   * A1：`aria-label` 属性 hint 的池侧匹配底座（`meta.policy.attr_value_match`）。
   * 缺省 `full_label` = 用 ≤200 的 full_label 与模型视图 label 双底座（>40 字的值才命得上）；
   * `display` = A1 之前只看前 40 字 label。只作用于 hint 匹配（inspect/observe/session 无 policy）。
   */
  attrValueMatch: "full_label" | "display" = "full_label";
  /**
   * F84 批 3（deny-list 可配化）：第 5 档词元护栏的放行词元表（`meta.policy.hint_token_allow`；
   * 缺省 undefined = 护栏行为逐字节不变）。生效面 = 歧义证据 suggested_hint（describeAmbiguity
   * 下传）——单点消费在 rules.suggestHints.tokenOk；inspect CLI / session 面缺省（F58 同款面边界）。
   */
  hintTokenAllow?: readonly string[];
  /** See `MiddlewareOptions.candidatePriority`（A2 分桶窗口；缺省 bucketed）。 */
  candidatePriority: "bucketed" | "main-first" = "bucketed";
  /**
   * E2：`on_ambiguous:"act"` 的歧义命中顺序（`decision.ambiguous_ordering`）。
   *   - `"dom-preorder"`（缺省）：命中 act 时刻 live-DOM 文档序首个 actionable 候选
   *     （跨帧按帧序 → 帧内文档序；平局取池内首个）；歧义证据块输出
   *     `ordering/selected_ref/selected_dsh_ref/sort_key`；
   *   - `"pool-order"`：旧池序（可行动优先排序后的首个）——回退开关，线上异常时切回。
   * 只作用于歧义模式（≥2 个 distinct 候选且 `onAmbiguous:"act"`）；单候选与
   * `on_ambiguous:"fail"` 行为不变。资金敏感步骤（下单/支付）禁用 act 模式，默认 fail。
   */
  ambiguousOrdering: AmbiguousOrdering = "dom-preorder";
  /**
   * E1-c：act 的 `#id` hint live-DOM 直查兜底（`decision.id_fallback`，缺省 true）。
   * false = 池内未命中即维持旧 `target_not_found`（回退开关）。仅限形态 1（`#id`）。
   */
  idFallback = true;
  /**
   * E1-b：池配额模型（`decision.pool_quota_mode`，缺省 "legacy" = 既有优先级逐出）。
   * "quota" = 双配额灰度档：viewport 保底 + id-backed 保留 + 壳元素限额。
   */
  poolQuotaMode: "legacy" | "quota" = "legacy";
  /**
   * E1-a：池预算帽的观测面回显（`decision.act_pool_cap`；缺省 64 = MAX_ELEMENTS）。
   * **只观测**：池构成不因它变化；落空诊断把它带进 `pool_cap` 供归因。
   */
  actPoolCap = POOL_CAP_ELEMENTS;
  /** S1：pre-held done 处置（缺省 warn；fail 在动作前结构化停止）。 */
  donePreheldPolicy: "warn" | "fail" | "allow" = "warn";
  /** P0-E：false_done guard 处置（缺省 warn；fail 在 done 成立后结构化停止）。 */
  doneGuardPolicy: "warn" | "fail" = "warn";
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
  _secretValuesSeen = new Set<string>();
  /**
   * S2：抽池前的稳定门（null = off）。缺省开启（方案 §2.5）；应用层按 meta.policy.settle 覆盖。
   * 只在"页面在动"时等待——已静默立即返回 0ms。
   */
  settlePolicy: { quietMs: number; timeoutMs: number } | null = { ...DEFAULT_SETTLE };
  /** 本次 run 累计的静默等待（毫秒）；写进 `StepStateRecord.settleMs`。 */
  _settleWaitMs = 0;
  /**
   * S1 状态游标（运行期私产，每次 `run()` 重置）：epoch/navEpoch/当前指纹。
   * 只读投影给 `ctx.runtime.epoch`；观察来源永远只有执行器（不自建第二份）。
   */
  _state: { epoch: number; navEpoch: number; current: StateFingerprint | null } =
    { epoch: 0, navEpoch: 0, current: null };
  /** 上一条 `not-actionable-or-covered` 的结构化现场（只在同一次调用内消费）。 */
  _lastActionabilityDetail: ActionabilityDetail | null = null;
  /**
   * B1：`occludedReason` 返回 null（非 timeout 异常 / hit-test 读不到）时的 Playwright 首行。
   * 只在同一次单动作调用内消费（与 `_lastActionabilityDetail` 同一纪律），不改 run 面返回值。
   */
  _lastProbeError: string | null = null;
  /**
   * 中心点被自己的祖先接住时，动作被**重定向到可动作祖先**并成功的事实（祖先摘要）。
   * 与 `_lastActionabilityDetail` 同一消费纪律：只在同一次动作调用内取走（additive）。
   */
  _lastAncestorRetarget: string | null = null;

  /* -- S5 decision-state ---------------------------------------------------- */

  /** S5：状态接入决策的开关（缺省两项 off；见 `MiddlewareOptions.decisionState`）。 */
  decisionState: DecisionStatePolicy = { ...DEFAULT_DECISION_STATE };
  /**
   * S5 指标（**实例级累计**）：一个 flow 应用会对同一 mw 跑多个 `ctx.step`，应用产物的
   * `decisions` 要的是整次旅程的数，所以计数**不随 run() 重置**。每个应用一次新 mw。
   */
  _decisionMetrics: DecisionStateMetrics =
    { asks_saved: 0, gate_waits: 0, context_sent: 0, context_skipped: 0 };
  /**
   * S5a：上一次真 ask 的题面指纹与导航代（每次 run() 重置——refs/导航代都是 run 内口径）。
   * 只服务 S5b 的 `state_digest`（`nav_epoch_delta` / `pool_changed` 的基线）；"不重复问"的
   * 复用账在 `_askedPools`（按池结构指纹）。
   */
  _lastAsk: {
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
   * 比多问一次更糟，引擎不替模型编答案。url 记答复观察时的页面——SPA 同构翻页骗不过它。
   */
  _askedPools = new Map<string, {
    key: string;
    goalKey: string;
    url: string;
    result: { ref: string | null; conf: number; probs: Record<string, number>; passthrough: boolean };
    /** A6：上次选中元素的 esig（ref 是位置键，跨抽池重编号不可比，签名才可比）。 */
    pickedSig: [string, string, string] | null;
  }>();
  /** S5b：本次 run 到目前为止出现过的 S1 flags（摘要里只放已经发生的事实）。 */
  _runFlags: StateFlag[] = [];
  /** S5b：最近一次 effect 读回（只留 kind/applied，值本身不进摘要）。 */
  _lastEffectSeen: { kind: StateEffect["kind"]; applied: boolean } | null = null;
  /**
   * U8：被置信闸门拒绝的 ask conf 账（R8 J3 幸存者偏差的补观测）。记的是**模型意见在
   * floor 处被丢弃**的 ask：主闸门 `conf < floor` 且未被 priorHit 复驾、意见最终也没被
   * adjudicate 复用的那部分，含 reobserve 宽看重问仍不过闸的弃选（主闸门分支内记账；
   * R2b 词面宽扫是词面触发的复核重问、非 conf 闸门事件，不在此账）。计数位置只有
   * 执行器的闸门分支，不在报告层重算——与 `model_asks`（ask 发生数）同一口径来源。
   */
  readonly _rejectedAskConfs: number[] = [];

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
  async _gateSettle(page: AnyPage): Promise<boolean | null> {
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
  _askSignature(goal: string, elems: ElemPool, forbidden: Set<string>):
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
  _buildStateDigest(input: {
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
  async _probeSettled(page: AnyPage): Promise<boolean | null> {
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
  async _settleBeforeExtract(page: AnyPage, deadlineMs?: number): Promise<SettleResult | null> {
    if (this.settlePolicy === null) return null;
    // C8：闸门预算真上限——每轮 settle 的 timeout 钳到剩余预算（缺省无 deadline = 旧行为）。
    const policy = deadlineMs === undefined
      ? this.settlePolicy
      : { ...this.settlePolicy, timeoutMs: Math.max(0, Math.min(this.settlePolicy.timeoutMs, deadlineMs - Date.now())) };
    try {
      const r = await settle(page as unknown as SettlePage, policy);
      this._settleWaitMs += r.waitedMs;
      // C7：把 settled/timedOut 接回调用方（只累计 waitedMs 会丢掉结论）。
      return r;
    } catch {
      // 稳定门是观察增强：传感器坏了也照常抽池（页面自会给出 target_not_found 等诚实停因）。
      return null;
    }
  }
  /** S2：settle + 默认池抽取（决策/act 解析、pool ready、收尾观察共用同一序）。 */
  async _extractPoolSettled(
    page: AnyPage, candidatePriority: "bucketed" | "main-first", deadlineMs?: number,
  ): Promise<{ elems: ElemPool; settle: SettleResult | null }> {
    const settleRes = await this._settleBeforeExtract(page, deadlineMs);
    const elems = await this.candidates!.extract({
      page, jsProbe: true, candidatePriority, surface: this.surfacePolicy,
      hosts: this._frameHosts,   // P0-D：被排除 frame 不进池
      ...(this.poolQuotaMode === "quota" ? { poolQuotaMode: "quota" } : {}),   // E1-b
    });    return { elems, settle: settleRes };
  }
  /**
   * U3 判档（唯一出处 = ARCH §5.3 判档表）：只在**池空**且预算耗尽时调用一次。
   * 判据只用已有观测（settle 结论）+ 一次只读 sniff（readyState/准入面计数），
   * 不新增"猜测式"往返；`not_ready` 才是 run 级判死，`ready_empty` 是步级事实。
   */
  async _poolReadiness(
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
   * 换模型是配置不是改代码：装配面见 `src/app/decision-runtime.ts`。
   */
  decision: DecisionProvider | null = null;
  /** 最近一次 provider pick 的证据截断记账（没裁剪/没问过 = null；只进模型步 trace）。 */
  lastPickEvidence: EvidenceTruncation | null = null;
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
  _ready = false;
  /** BACKLOG #2：候选生产者（`buildMiddleware` 必注入；直接构造执行器视为误用 ⇒ null 断言）。 */
  readonly candidates: CandidateProducer | null;
  /**
   * W5-3：决策运行时注入（`buildMiddleware` 缺省注入 app 组合根的实现）。
   * 执行器只依赖这组函数，不 import 具体 provider 实现；null = rules-only。
   */
  readonly decisionRuntime: DecisionRuntimeHooks | null;

  constructor(opts: MiddlewareOptions = {}) {
    this.modelId = opts.modelId ?? "convaiinnovations/laya";
    if (typeof this.modelId !== "string") this.agent = this.modelId;
    this.routeModels = Boolean(opts.routeModels);
    this.router = opts.router ?? null;
    this.auditor = opts.auditor ?? getAuditor();
    this.candidates = opts.candidateProducer ?? null;
    this.decisionRuntime = opts.decisionRuntime ?? null;
    this.maxSteps = opts.maxSteps ?? 8;
    this.confFloor = opts.confFloor ?? DEFAULT_CONF_FLOOR;
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
    this.gotoTimeout = opts.gotoTimeout ?? NAVIGATION_GOTO_TIMEOUT_MS;
    this.hosts = opts.hosts ?? null;
    // P0-D（A 批补漏）：会话面的 frame 门禁必须与 `meta.hosts` 同语义——此前 `_frameHosts`
    // 只在 run 面方法里由 `hosts ?? this.hosts` 赋值，session 面从未设置 ⇒ 池/FW8/DRF/F64
    // 对声明 hosts 外的 iframe 完全不设防（专项测试实测：hosts=[127.0.0.1] 时 localhost 子帧
    // 仍可被 frame:/#id 命中）。构造时以 middleware 默认 hosts 兜底；run 面仍会按 run 覆盖。
    this._frameHosts = this.hosts;
    this.dataset = opts.dataset ?? null;
    this.maxEffectiveRepeats = opts.maxEffectiveRepeats ?? this.maxEffectiveRepeats;
    this.riskAsk = opts.riskAsk ?? this.riskAsk;
    this.tieredHint = opts.tieredHint ?? this.tieredHint;
    this.candidatePriority = opts.candidatePriority ?? this.candidatePriority;
    // E2：歧义命中顺序（decision.ambiguous_ordering）；非法值按缺省 dom-preorder（schema 层已拦）。
    this.ambiguousOrdering = opts.ambiguousOrdering ?? this.ambiguousOrdering;
    // E1-c：#id 直查兜底（decision.id_fallback；缺省 true = 修复行为，false = 回退开关）。
    this.idFallback = opts.idFallback ?? this.idFallback;
    // E1-b：池配额模型（decision.pool_quota_mode；缺省 legacy = 旧行为逐字节）。
    this.poolQuotaMode = opts.poolQuotaMode === "quota" ? "quota" : "legacy";
    // E1-a：池帽观测面（decision.act_pool_cap；缺省 40；只回显不改行为）。
    if (opts.actPoolCap !== undefined && Number.isFinite(opts.actPoolCap)) {
      this.actPoolCap = Math.max(1, Math.min(500, Math.floor(opts.actPoolCap)));
    }
    this.poolGate = opts.poolGate === "strict" ? "strict" : "fact";
    this.actHintStrict = opts.actHint === "strict";
    this.actHintTier = opts.actHintTier === "strong" ? "strong" : "any";
    this.targetResolutionDeclared = opts.targetResolution === "declared";
    this.actHintDomFallback = opts.actHintDomFallback === true;
    this.attrValueMatch = opts.attrValueMatch ?? this.attrValueMatch;
    this.hintTokenAllow = opts.hintTokenAllow ?? this.hintTokenAllow;
    if (opts.surfacePolicy !== undefined) this.surfacePolicy = { ...opts.surfacePolicy };
    this.donePreheldPolicy = opts.donePreheldPolicy ?? this.donePreheldPolicy;
    this.doneGuardPolicy = opts.doneGuardPolicy ?? this.doneGuardPolicy;
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
  async ready(): Promise<void> {
    if (this._ready) return;
    // task-14（D1）：起跑探测已判死决策面（probe 失败 → markDecisionDegraded）——
    // 与"本地模型不在位"同一条规则面：不建 decision（done 票/风险问询自然跳过），
    // 声明点名的步照跑、需要选点的步按规则面如实 block。probe 经 applySpecToRuntime
    // 安装过 provider，这里必须挡在 ① 之前，否则会把已判死的面重新装回来。
    if (this.decisionDegraded !== null) {
      this.rulesOnly = true;
      this.rulesOnlyReason = this.decisionDegraded.message;
      this._ready = true;
      return;
    }
    await assembleDecisionRuntime(this);
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
  modelLabel(): string {
    const n = this.decision?.name ?? "laya";
    return n === "laya(legacy-runtime)" ? "laya" : n;
  }

  /**
   * A3（决策源对齐与失败透传）：pick 抛错降级过 ⇒ 把真实原因（HTTP 状态码 + 服务错误关键句）
   * 编进 `no_model_runtime` 的停因。降级不该把基础设施事实吞掉——「rules-only 没模型」与
   * 「配了决策源但它 403 了」是两件事，停因必须分得清。空串 = 本次 rules-only 是
   * 「本来就没装模型」（LayaNotConfiguredError 路径），后缀缺席，输出逐字节不变。
   */
  degradedReasonSuffix(): string {
    const d = this.providerDegraded.trim();
    return d === "" ? "" : `（决策源不可用：${d.slice(0, 240)}）`;
  }

  /**
   * 一次提问的全部事实：选了什么、conf 怎么来的（passthrough 与否决定它的含义）、原始概率。
   * `pickElement` 是它的三元组视图（保持既有调用点与 trace 口径不变），`pickProposal` 是带形状的视图。
   */
  async pickInner(
    goal: string,
    page: AnyPage,
    elems: ElemPool,
    forbidden: Set<string>,
    notes: Record<string, string> | null,
  ): Promise<{ ref: string | null; conf: number; probs: Record<string, number>; passthrough: boolean; choiceLimit?: string }> {  // choiceLimit=超限原因（A2 即取即清）
    // `pickElement`/`pickProposal` 也允许被**单独调用**（测试/外部嵌入方），而 provider 在
    // ready() 里解析——先 ready 才不会把 null 当"没得选"（ready 幂等，run() 路径不重复加载）。
    await this.ready();
    if (this.rulesOnly) {
      // no model to ask: the caller reports "needs a model pick" instead of a crash
      return { ref: null, conf: 0.0, probs: {}, passthrough: true };
    }
    const provider = this.decision;
    if (!provider) {
      return { ref: null, conf: 0.0, probs: {}, passthrough: true };
    }
    // A2：决策服务把候选清单当选项列表，服务侧上限 255——超限必须结构化停因（收窄 hint /
    // 分桶优先级），不能硬塞 200+ 选项。原因经返回值即取即清（不留成员状态残留）。
    const candidateCount = Object.keys(elems).filter((r) => !forbidden.has(r)).length;
    if (candidateCount > MAX_CHOICES) {
      this.lastPickEvidence = null;
      return {
        ref: null, conf: 0.0, probs: {}, passthrough: true,
        choiceLimit: `candidate window ${candidateCount} > MAX_CHOICES (${MAX_CHOICES}) — the decision service takes at most `
          + `255 choices; narrow the hint or rely on bucket priority (chrome/viewport first) instead of widening the pool`,
      };
    }
    // 视图构造、state 渲染、短名单重问、两支各自的 conf 口径——**全部在适配器里**，
    // 且与替换前的实现逐字段等价（逐字段替换验证 ①）。
    //
    // ── S5 状态接入（默认两项 off ⇒ 下面整段短路，决策路径逐字节不变）───────────────
    // 判据「规则层仍歧义」不需要再问一遍：pickInner 是规则层没解出 ref 后唯一的模型入口。
    const askSig = this._askSignature(goal, elems, forbidden);
    const goalKey = fnv1aText(goal);
    const notesKey = fnv1aText(JSON.stringify(notes ?? {}));   // A7：notes 进题面指纹
    const poolStruct = structDigest(elems);
    let settledNow: boolean | null = null;
    if (this.decisionState.gate === "stable_only") {
      // ① 页面在动 ⇒ 先等到静默（走 policy.settle 参数；超时不阻断，照旧问）。
      settledNow = await this._gateSettle(page);
      // ② 池指纹未变 + 规则层仍歧义 ⇒ 不重复敲门：题面一字不差（key 相同）直接复用；
      //    仅结构相同则要求上次选择此刻仍可行动。SPA 同构翻页骗不过 url 判据（S5a）。
      const prior = this._askedPools.get(poolStruct);
      // A6：ref 是位置键（抽池重编号），"仍在池里"≠"还是那个元素"——补 esig 校验（与
      // stale-forbidden 剪枝同口径）：签名逐字段相等才可复用，否则答复过时、照常问。
      if (prior !== undefined && prior.goalKey === goalKey && prior.url === urlOf(page)) {
        const stillActionable = prior.result.ref !== null && prior.pickedSig !== null
          && elems[prior.result.ref] !== undefined && !forbidden.has(prior.result.ref)
          && sigEq(esig(elems[prior.result.ref]!), prior.pickedSig);
        if (prior.key === `${askSig.key}\u0000${notesKey}` || stillActionable) {
          this._decisionMetrics.asks_saved += 1;
          return { ...prior.result, probs: { ...prior.result.probs } };   // 复用答复仍走既有裁决
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
    // 缺 key/缺端点/网络不可达时，不崩整条计划、不每步敲坏服务——声明步照跑，选目标的步
    // 如实 block。风险头早就这么降级（isRisky 的 catch），pick 这边对齐。
    // U3/T9/FW8/A批（B5）：surface/href_full/identity/frame_* 都是旁路标记，**不进模型请求体**
    //——剥离收口在 executor-pure.modelProjectionOf，第三方 provider 永远看不到引擎内部标记。
    const modelElems: ElemPool = modelProjectionOf(elems);
    let out;
    try {
      // task-26（D2 A/B）：站点事实 fenced block 经 notes 注入模型请求面（opt-in——
      // siteFactsNotes 缺省 null = notes 原样逐字节不变；本地 laya schema 固定忽略 notes）。
      const mergedNotes = this.siteFactsNotes === null
        ? notes
        : { ...(notes ?? {}), site_facts: this.siteFactsNotes };
      out = await provider.pick({
        goal, page, elems: modelElems, forbidden, notes: mergedNotes, narrow: null, k: 8,
        ...(digest === null ? {} : { state_digest: digest }),
      });
    } catch (err) {
      this.lastPickEvidence = null;
      this.rulesOnly = true;
      this.rulesOnlyReason = (err as Error).message;
      this.providerDegraded = (err as Error).message;
      // task-14（D1）：运行中途死亡同样降级一次（死服务不重试——rulesOnly 永久翻转 +
      // escalate 守卫；分类 midrun_death）。只在兼容范围（默认配置面）记账；显式 provider
      // 维持今天的 provider_degraded 面貌（显式意图优先）。
      if (this.decisionCompat && this.decisionDegraded === null && this.decisionRuntime !== null) {
        const fact = this.decisionRuntime.failureFact(err);
        this.markDecisionDegraded({
          reason_class: "midrun_death",
          message: fact.slice(0, 300),
          config_source: "AMBERFLOW_DECISION_BASE_URL",
        });
      }
      return { ref: null, conf: 0.0, probs: {}, passthrough: true };
    }
    this.lastPickEvidence = out.evidence_truncated ?? null;
    const result = {
      ref: out.ref as string | null, conf: out.score, probs: out.probs, passthrough: out.passthrough,
    };
    // S5a：只有真问过才更新"上一次 ask"；池结构指纹 → 最近一次真 ask 的答复
    // （key 含 notes 指纹 A7；pickedSig 留元素签名 A6；同页同 goal 不重复敲门）。
    this._lastAsk = { key: askSig.key, poolSig: askSig.poolSig, navEpoch: this._state.navEpoch, result };
    if (this._askedPools.size > 32) this._askedPools.clear();   // 有界：池形状种类远小于此
    this._askedPools.set(poolStruct, {
      key: `${askSig.key}\u0000${notesKey}`, goalKey, url: urlOf(page), result,
      pickedSig: result.ref !== null ? esig(elems[result.ref]!) : null,
    });
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
    if (r.choiceLimit !== undefined) this._choiceLimitReason = r.choiceLimit;   // 即取即清（A2）
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
        instructions: RISK_INSTRUCTIONS_LONG,
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
        instructions: doneInstructionsLong(goal),
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
      // F75：A3 DOM 回退面合成行的探针句柄（run 决策步复用回退面时携带；真池行恒缺省
      // = 键不出现，链序与既有行为零变化）。
      ["af_probe", "[data-af-probe='%s']"],
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
      if (key === "af_probe" || key === "dsh_ref" || key === "hint_ref") {
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
    let checks = "";
    try {
      // B3：vals 与 checks 一次 evaluate 取回（页面往返不增加）；checks 空则字段省略。
      const st = (await page.evaluate(FN_STATE)) as { vals?: unknown; checks?: unknown } | null;
      vals = String(st?.vals ?? "");
      checks = String(st?.checks ?? "");
    } catch {
      vals = "";
      checks = "";
    }
    const frames: Array<{ url: string; text: string; vals: string; checks?: string }> = [];
    for (const fr of framesOf(page).slice(1)) {
      try {
        const st = (await fr.evaluate(FN_STATE)) as { vals?: unknown; checks?: unknown } | null;
        const fv = String(st?.vals ?? "");
        const fc = String(st?.checks ?? "");
        frames.push({
          url: urlOf(fr as unknown as PageLike),
          text: String(await firstLoc(fr.locator("body")).innerText({ timeout: 1000 })).slice(0, 1200),
          vals: fv,
          ...(fc ? { checks: fc } : {}),
        });
      } catch {
        frames.push({ url: safeUrl(fr), text: "", vals: "" });
      }
    }
    try {
      return {
        url: urlOf(page), title: await page.title(), text, vals,
        ...(checks ? { checks } : {}), frames,
      };
    } catch {
      return {
        url: safeUrl(page), title: "", text, vals,
        ...(checks ? { checks } : {}), frames,
      };
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
    return await occlusionProbe(this, page, el, probeMs, slowMs);
  }


  /**
   * P0-C：DRF 目标的**动作前** hit-test（click 族必须）。
   *
   * 中心点 `document.elementFromPoint` 命中的最顶层元素必须是目标本身或其后代，否则
   * **不点击**——返回 covered（无关元素盖住 / 中心点无元素）或 ancestor（命中目标是
   * 目标的祖先，典型是目标 `pointer-events:none` 或布局在父容器上）。命中非目标时
   * 记录覆盖者摘要（tag#id.class），让失败证据能直接指认现场。
   * 公理 0：**后代命中 = 正常操作成立**——容器候选的中心点命中其子（图标/内层按钮）
   * 是真人点击的常态，事件冒泡回容器的 handler；`node.contains(hit)` 放行，绝不判
   * covered（与 eval-snippets 的 HIT_JS/HIT_DETAIL_JS 同一条判据，三处不得漂移）。
   */
  async _declaredHitTest(page: AnyPage, el: Elem):
    Promise<{ ok: true } | { ok: false; kind: "covered" | "ancestor"; blocker: string }> {
    return await declaredHitTest(this, page, el);
  }

  /** S1：取走并清空上一条 actionability 现场（一次调用只消费一次，避免跨步串用）。 */
  _takeActionabilityDetail(): ActionabilityDetail | null {
    const detail = this._lastActionabilityDetail;
    this._lastActionabilityDetail = null;
    return detail;
  }

  /**
   * E4：页面的 overlay 证据（只读；一次主 frame evaluate；**不消散**）。
   *
   * 用在失败路径的归因：`target_not_found`（目标被遮罩挡在池外？）/ 被遮挡
   * （`not-actionable-or-covered`）。返回 ≤3 行几何证据；探测失败返回 null
   * （证据缺省不造假）。子 frame 不扫——遮罩按定义铺在主 frame 的视口上。
   */
  async overlayEvidence(page: AnyPage): Promise<OverlayEvidenceRow[] | null> {
    try {
      const raw = await page.evaluate(FN_OVERLAY as () => unknown) as unknown;
      if (!Array.isArray(raw)) return null;
      const out: OverlayEvidenceRow[] = [];
      for (const r of raw.slice(0, 3)) {
        if (typeof r !== "object" || r === null) continue;
        const row = r as Record<string, unknown>;
        if (typeof row["desc"] !== "string") continue;
        out.push({
          desc: String(row["desc"]),
          z: Number(row["z"]) || 0,
          area: Number(row["area"]) || 0,
          covers: row["covers"] === true,
          txt: typeof row["txt"] === "string" ? String(row["txt"]).slice(0, 40) : "",
        });
      }
      return out;
    } catch {
      return null;
    }
  }

  /**
   * S1：读取一次 actionability 现场（bbox / 覆盖者 / 节点是否还在）。
   * 读不到不造假：bbox=null、requery=unknown，reason 仍保留。
   */
  async _readActionabilityDetail(loc: AnyLoc, reason: string): Promise<ActionabilityDetail> {
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
    // clickxy：clickxy 合成行没有 locator——干跑回答"坐标在视口内可点"（bbox 中心由解析面
    // 实测过），可行动性由坐标本身承载；证据里 desc 已带 `at (x, y)`。
    if (el.clickxy !== undefined) return { actionable: true, reason: null };
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
  _matchValueBag(el: Elem, bag: Record<string, unknown>): unknown {
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
  _secretValuesIn(slots: Record<string, unknown>): string[] {
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
    // clickxy：坐标点击合成行（clickxy）——**唯一执行点**。不经 locator（无句柄可寻址），
    // 直接点 bbox 中心（视口 CSS 像素）。危险门控在上游风险闸门（risky → confirmFn）。
    if (el.clickxy !== undefined) {
      try {
        await page.mouse.click(el.clickxy.x, el.clickxy.y);
      } catch (e) {
        return ["action_failed", describeActionError(e)];
      }
      try {
        await page.waitForLoadState("domcontentloaded", { timeout: 3000 });
      } catch {
        /* the page may never fire it; the action already happened */
      }
      return ["clicked", { clickxy: { x: el.clickxy.x, y: el.clickxy.y } }];
    }
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
      // 中心点被**自己的祖先**接住 = 元素本身不可命中（Playwright 拒绝点击；冒泡语义下真人
      // 点击由祖先 handler 处理）：重定向到最近可动作祖先点一次，成功等同点击完成。
      // 其余失败保持既有 action_failed（文案带拦截者，见 describeActionFailure）。
      if (!force && String((e as Error)?.message ?? e).toLowerCase().includes("timeout")) {
        if ((await hitRelation(this, loc)).relation === "ancestor"
          && await clickActionableAncestor(this, page, el, loc, 5000) !== null) {
          try {
            await page.waitForLoadState("domcontentloaded", { timeout: 3000 });
          } catch {
            /* the page may never fire it; the action already happened */
          }
          return ["clicked", null];
        }
      }
      return ["action_failed", describeActionFailure(e)];
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
      doneSpec = null,
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
      donePollMs = DONE_POLL_INTERVAL_MS,
      doneTimeoutMs = 2000,
      // F3：步级显式 timeoutMs 的整步挂钟帽（缺省 undefined = 无帽，行为逐字节不变）。
      stepTimeoutMs,
      forceAct = false,
      force = false,
      staleRetry = false,
      candidatePriority = this.candidatePriority,
      // E2：run 级歧义命中顺序（缺省继承实例字段——constructor 已从配置层解析）。
      ambiguousOrdering = this.ambiguousOrdering,
    } = opts;
    // U3：run 级 surface 策略必须进**每一次**抽池（_extractPoolSettled 读实例字段）。
    this.surfacePolicy = surfacePolicy;
    // E2：歧义命中顺序同理——实例字段是后续 actOnce/命令步读取的唯一口径。
    this.ambiguousOrdering = ambiguousOrdering;

    // 四组记账（stop / forbid+why / noteSkipped / unforbid·pruneForbids）的唯一载体：
    // 状态与逻辑都在 RunCtx；run() 只持入口，调用点零改写（顺序/时机由本函数掌握）。
    const acct: RunAccounting = createRunAccounting({ maxSteps: this.maxSteps });
    const { stop, forbid, unforbid, pruneForbids, noteSkipped, forbidden, forbidWhy, blockedRetry, reAdmitted, skippedActions } = acct;

    // The navigation envelope: run-level declaration wins, else the middleware's
    // (set once for a whole journey by the app runner from `pack.hosts`).
    const hostGate = hosts ?? this.hosts;
    this._frameHosts = hostGate ?? null;
    // P2 command space: the ordered closed set for THIS subgoal. Progress is per-run
    // local state (a retry re-runs the whole subgoal, so the space restarts walking
    // from the top — exactly the `retries` contract).
    // 批 2 遗留收编（E 项流转修复）：**id 缺失的命令不再静默丢弃**——丢弃会让声明命令退化为
    // 模型提名，违反命令空间契约（"NEVER a fallback to the full pool, NEVER a model pick"）。
    // 实锤：批 1/批 2 probe 用例（commands 无 id）两次真站实测停于 low_confidence 即此——
    // 在线套件路径（runOneCase → TaskPlan）不过 validateCommands 的 id 必填校验面（计划/应用
    // 包加载面照旧拦截），到执行器才被本行旧 filter 丢掉。回退 id = `cmd<序>`（确定性）；
    // 无 id 命令此后照常参与命令行走廊（未解析 → target_not_found + 行锚证据，绝不模型提名）。
    // 评审收口：自动 id 不得与**显式 id** 撞车——重复 id 会在走廊里经 `cmdDone.has` 被静默
    // 跳过（第二条命令零证据消失），所以按显式集合去重后追加 `_`。
    const cmdSpace: CommandDecl[] = (() => {
      const filtered = (commands ?? []).filter((c): c is CommandDecl => !!c && typeof c === "object");
      const ids = new Set(filtered
        .filter((c) => typeof c.id === "string" && c.id !== "")
        .map((c) => c.id as string));
      return filtered.map((c, i) => {
        if (typeof c.id === "string" && c.id !== "") return c;
        let id = `cmd${i}`;
        while (ids.has(id)) id = `${id}_`;
        ids.add(id);
        return { ...c, id };
      });
    })();
    const cmdDone = new Set<string>();
    let cmdI = 0;
    /** A2：每条命令已试过的候选数（最多 CMD_CANDIDATE_ATTEMPTS 个，全败不静默 done）。 */
    const CMD_CANDIDATE_ATTEMPTS = 4;
    const cmdAttempts: Record<string, number> = {};
    // A1：act 是多动作命令闭集（N≥2）时，done 必须等**全部命令走完**才评估——
    // 若每个动作后都判一次 done，第一击点开菜单的中间态就会让信号成立（trace 里 hows 记了
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
    // F3：步级挂钟帽的判定时刻 = run() 开始（导航/抽池/决策/升级全在内）。仅在作者显式
    // 声明 timeoutMs 时存在；循环头逐轮检查，过期后不再起新的宽扫/升级（已在途的
    // 决策调用不可抢占，超额 ≤ 一次在途调用——如实写进停因 reason）。
    const stepStartedAt = Date.now();
    const stepDeadline = stepTimeoutMs !== undefined && stepTimeoutMs > 0
      ? stepStartedAt + stepTimeoutMs
      : null;
    const stepTimeoutLeft = (): number =>
      stepDeadline === null ? Number.POSITIVE_INFINITY : stepDeadline - Date.now();
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
    const warnings: string[] = [];
    let donePreheld: boolean | null = null;
    /** 窗口递增链事实（本步内累计；循环头每步重置为空数组——与 donePreheld 同一 reset 节奏，
     * 避免上一步的链证据被本步 trace 行误带）。phases-b 持同一数组就地追加。 */
    let windowChainFacts: WindowChainFact[] = [];
    /** 第五档 AX 回退事实（本步内至多一次；循环头每步重置——与 donePreheld 同一节奏）。
     * ref/weak 供 actionDeclEvidence 的 additive 证据；cleanupFn 由 domFallbackCleanup 统一清。 */
    let axFallbackRef: string | null = null;
    let axFallbackWeak = false;
    let axFallbackCleanupFn: (() => Promise<void>) | null = null;
    /** clickxy：第六档 clickxy 合成行的坐标（本步内至多一次；循环头每步重置）。
     * 证据面：actionDeclEvidence 的 resolved_by/clickxy additive 键（命中才出现）。 */
    let clickxyHit: { x: number; y: number } | null = null;
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
      // 窗口递增链事实（additive；本步链真跑过才出现——只发生在 miss/低置信路径）。
      ...(windowChainFacts.length > 0 ? { window_escalation: windowChainFacts } : {}),
      // 第五档 AX 回退命中标记（additive；命中才出现——resolved_by 与 dom_fallback 同族）。
      ...(axFallbackRef !== null ? { resolved_by: "ax_fallback" as const } : {}),
      ...(axFallbackWeak ? { ax_weak_tier: true } : {}),
      // clickxy：第六档 clickxy 合成行事实（additive；命中才出现；危险门控在上游风险闸门）。
      ...(clickxyHit === null ? {} : { resolved_by: "clickxy_fallback" as const, clickxy: clickxyHit }),
    });
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
    let lastPoolSize = 0;
    // task-11（B3）：报告期限速嗅探要用的跨循环事实（步循环内的块作用域变量够不着报告点）。
    let lastPageRef: AnyPage | null = null;
    let lastDeclaredHiddenBox: { target: string; hidden: number; total: number } | null = null;
    // 闭包内的赋值 TS 控制流看不见（与 getDeclared 同一个坑）——getter 返回注解类型。
    const getLastDeclaredHidden = (): { target: string; hidden: number; total: number } | null =>
      lastDeclaredHiddenBox;
    let lastPoolWaitedMs = 0;
    /** U3：最后一次池空判档（ready 由正常路径覆盖不落此变量；not_ready/ready_empty 进 diagnostics）。 */
    let lastReadiness: Readiness | null = null;
    /** U3：ready_empty 的 warning 同一 run 只出一条（步级 flag 每步照记）。 */
    let readyEmptyWarned = false;
    /** U3：本 run 是否出现过 ready_empty（池空但已就绪）——进 flags，不改变 done 语言。 */
    let poolEmptyThisStep = false;
    let gatePhase: FrameGatePhase | null = null;
    let page: AnyPage | null = pageIn;
    let browser: BrowserHandle | null = null;
    /** S1：本 run 的 StepStateRecord（在收尾处组装；无观察时省略）。 */
    let stepState: StepStateRecord | undefined;

    try {
      // S1：每次 run 重置状态游标（epoch/navEpoch 都是**本次 run** 的口径）。
      const setup = await runSetup(this, { instruction, startUrl, hostGate, verbose, pageIn, pwIn,
        skipNavigation: opts.skipNavigation === true, settleMs: opts.settleMs });
      browser = setup.browser;
      if (setup.kind === "early") return setup.report;
      const pg = setup.pg;
      const observeState = setup.observeState;
      page = pg;
      lastPageRef = pg;

      gatePhase = await runFrameGate(this, { instruction, pg, hostGate, goalSignalFn, precondition, warnings, verbose });
      if (gatePhase.kind === "early") return gatePhase.report;
      const { goalHeld, frameTargetStop } = gatePhase;

      for (let stepNo = 1; stepNo <= this.maxSteps; stepNo++) {
        // F3：步级 timeoutMs 显式声明时，reobserve/升级循环的**每轮**受它约束——
        // 超时即结构化停（step_timeout），不再进入下一轮宽扫/模型改点。
        if (stepTimeoutLeft() <= 0) {
          stop("step_timeout",
            `step-level timeoutMs=${stepTimeoutMs} exhausted (step wall clock ~${Math.round(Date.now() - stepStartedAt)} ms) `
            + `while the reobserve/escalation loop was still searching on step ${stepNo} — `
            + `the loop no longer starts another round past the declared step deadline; `
            + `timeoutMs is the WHOLE-STEP wall-clock cap (settle/reobserve/escalation/actions inside this step all share it), `
            + `not a per-action timeout; `
            + `raise timeoutMs, narrow the step's done/target, or split the flow`,
            stepNo);
          if (verbose) console.log(`  step ${stepNo}: ${acct.stopReason}`);
          break;
        }
        // A1：done_preheld 是**逐步**事实——每步开头重置，避免上一步的值被本步的 trace 行
        // 或最终 RunReport 误带（只有命令步会在下面重新评估它）。
        donePreheld = null;
        windowChainFacts = [];
        axFallbackRef = null;
        axFallbackWeak = false;
        axFallbackCleanupFn = null;
        clickxyHit = null;
        const pool = await runPoolGate(this, { pg, stepNo, candidatePriority, poolReady, poolReadyTimeoutMs,
          poolReadyPollMs, poolGate, verbose, observeState, trace, warnings, pendingAfterIdx, beforeFp,
          lastPoolSize, lastPoolWaitedMs, lastReadiness, poolEmptyThisStep, readyEmptyWarned, stop }); if (pool.stopped) break;
        let { stepStartUrl, stepStartTabs, elems, gateSettle } = pool; ({ lastPoolSize, lastPoolWaitedMs, beforeFp,
          pendingAfterIdx, lastReadiness, poolEmptyThisStep, readyEmptyWarned } = pool);

        // A1 §2.2.3：命令步在解析/动作前评估一次 done 并记录 done_preheld（**决策步不付**这次
        // 评估）。默认不改变执行：既有流程照旧动作，这个记录只回答"动作前信号是否已成立"——
        // 否则一次 done=true 分不清是"动作推进了页面"还是"信号本来就成立、动作只是搭便车"。
        // forceAct 的语义是"即使已成立也先把闭集执行完再评估"，与现状一致，故只记录声明。
        if (cmdSpace.length > 0 && goalSignalFn && !dryRun) {
          try {
            donePreheld = (await goalHeld()) === true;
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
            if (verbose) console.log(`  step ${stepNo}: ${acct.stopReason}`);
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
        // 逐 step 的 FW8/DRF 解析状态（resolver 持有去重集合/命中/停因/隐藏证据；证据形状见 evidence.ts）。
        // 每步新建：同一步同一条 hint 只尝试一次；不得跨步复用。
        const targets: DeclaredTargetsResolver = createDeclaredTargetsResolver({
          pg, stepNo, noteSkipped, hintOpts: () => _hintOpts(this, ), surfacePolicy: this.surfacePolicy,
          frameHosts: this._frameHosts, targetResolutionDeclared: this.targetResolutionDeclared,
          onDeclaredHidden: (facts) => { lastDeclaredHiddenBox = facts; },
        });
        // 规划面停因的帧证据单点：frameHintFailureEvidence（与命令空间/strict/会话 act 同一证据面，
        // 不另立函数）；hint 来源取**该步的有效声明目标**（决策步 = [curHint]；命令步 = cmdSpace
        // 各命令的 target）。无行锚声明 = 空串（reason 逐字节不变）；零新增页面 I/O（纯内存证据）。
        const rowAnchorNote = (hints: readonly (string | null | undefined)[]): string => {
          const list = hints.filter((t): t is string => typeof t === "string" && t.trim() !== "");
          if (list.length === 0) return "";
          const note = frameHintFailureEvidence(pg, this._frameHosts, list, elems);
          return note ? ` — ${note}` : "";
        };
        const declaredTargets = (): readonly (string | null | undefined)[] =>
          commandMode ? cmdSpace.map((c) => c.target) : [curHint];
        const declaredPhase = await runDeclaredTargets(this, {
          pg, stepNo, verbose, elems, cmdSpace, cmdDone, cmdI, cmdAttempts, noteSkipped, zeroExecSummary,
          goalHeld, goalSignalFn, frameTargetStop, targets, stop, stopReason: () => acct.stopReason, forbidden, pruneForbids,
          hintOpts: () => _hintOpts(this, ), surfacePolicy: this.surfacePolicy, frameHosts: this._frameHosts,
          targetResolutionDeclared: this.targetResolutionDeclared, candidateAttempts: CMD_CANDIDATE_ATTEMPTS,
          resolveCommandRef: (t, e, op, f) => resolveCommandRef(this, t, e, op, f),
          setDone: () => { done = true; }, setViewportUnderloaded: (v) => { viewportUnderloaded = v; },
        });
        cmdI = declaredPhase.cmdI;
        if (declaredPhase.stopped) break;
        const cmdPick = declaredPhase.cmdPick;

        const hintPhase = await runDeclaredHint(this, {
          pg, stepNo, verbose, elems, commandMode: cmdSpace.length > 0, targets, warnings, stop, noteSkipped, targetResolutionDeclared: this.targetResolutionDeclared,
          stopReason: () => acct.stopReason, frameTargetStop, pruneForbids, forbidden, advanceHint: () => this._advanceHint(), currentHint: () => this.currentHint(), hintIndex: () => this._hintI, hintCount: this.targetHints.length,
          hintMatch, hintLookup, hintCandidates, declaresRowAnchor, hintOpts: () => _hintOpts(this, ), surfacePolicy: this.surfacePolicy, frameHosts: this._frameHosts, isTyping: (el) => this._isTyping(el),
        });
        let { curHint } = hintPhase;
        if (hintPhase.stopped) break;

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
        // F72-②：显式重扫事实（本步内至多一次；trace 行/运行汇总用）。
        let rehydrateRescanFact: {
          waited_ms: number; pool_size_before: number; pool_size: number; resolved: boolean; ref?: string;
        } | null = null;
        // F75：DOM 回退跳的章与证据（命中才非空；章随动作尝试结束清，与 FW8/DRF 同纪律）。
        let domFallbackRef: string | null = null;
        let domFallbackCleanupFn: (() => Promise<void>) | null = null;
        let domFallbackMissed = false;
        // F75 与第五档 AX 回退的探针章统一清理点（动作尝试结束后调用；各自失败不阻断，
        // 章值唯一，残留不会误指）。
        const domFallbackCleanup = async (): Promise<void> => {
          const fns = [domFallbackCleanupFn, axFallbackCleanupFn];
          domFallbackCleanupFn = null;
          axFallbackCleanupFn = null;
          for (const fn of fns) {
            if (fn === null) continue;
            try { await fn(); } catch { /* 清理失败不阻断 */ }
          }
        };
        const domFallbackEvidence = (): Record<string, unknown> =>
          domFallbackRef === null ? {} : { resolved_by: "dom_fallback" as const };
        const domFallbackMissSuffix = (): string => domFallbackMissed
          ? "; DOM fallback (main-frame, ADMIT_SEL, no visibility filter) also ran: no match"
          : "";
        let ruleRef: string | null = null;
        // A3：strong 档下被拒的弱档胜出（严格停因的 reason 要用它的候选/档位；any 恒 null）。
        let weakRejected: HintMatchOthersDiag | null = null;
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
            ? affordanceRule(instruction, elems, curHint, _hintOpts(this, ))
            : (navRule(instruction, orderedPool()) ?? affordanceRule(instruction, orderedPool(), null));
          // task-9（评审 #2）：弱档命中的旁路诊断 → step warning `matched_others`。
          // 只在弱档胜出（bare 词前缀/词包含、attrSubstr loose 子串）时告警——精确命中
          // （整 label 全等/词全等/attr 精确值/slug）不响，clean 应用零新增警告。
          // take 一次即清；hint 相等性校验挡住非 bare/attrSubstr 解析留下的陈旧诊断。
          // A3：同一处判定 `meta.policy.act_hint_tier:"strong"`——弱档胜出改判"未命中"
          // （ref 清空 + 警告换成 weak_hint_rejected，随后走 act_hint 既有语义）；
          // "any"（缺省）就是上面那段逐字节今天的路径。判据只在 `declaredAllow` 一处
          // （复用 diag.suspicious），宽扫重解析也走同一个函数。
          if (curHint !== null) {
            const othersDiag = takeHintMatchOthers();
            const gate = declaredAllow(
              ruleRef, othersDiag, curHint,
              this.actHintTier === "strong" && !this._learnedHintApplied,
            );
            ruleRef = gate.ref;
            if (gate.rejected !== null) {
              weakRejected = gate.rejected;
              warnings.push(weakHintRejectedWarning(gate.rejected, curHint, stepNo));
            } else if (othersDiag !== null && othersDiag.hint === curHint && othersDiag.suspicious) {
              warnings.push(matchedOthersWarning(othersDiag, curHint, stepNo));
            }
          }
          // U5（W10）：rules-only 没有模型可回退，也就没有决策脸的"低置信宽扫重看"那一级。
          // 声明的 target_hint 若落在常规 40 窗口之外（分页链接/长列表底部），规则直接未命中，
          // 3 attempts 后 target_not_found —— 明明页面上就在那儿。
          // 这里补**递增宽扫链**：120 → 240（硬顶档）逐级扩窗重解析，命中即停；120 档未命中
          // （含弱档胜出）且窗口确有增长才升 240 档。hintMatch 是确定性的，命中即用、不猜；
          // 常规窗口内命中时这条路一步都不走（零多付），决策脸路径不变（由 rulesOnly 门住）。
          // 不放大 attempts、不引入模型。链事实 additive 进 trace 行（window_escalation）。
          if (ruleRef === null && this.rulesOnly && curHint !== null && !reobserved
              && stepTimeoutLeft() > 0) {
            // F3：步级 timeoutMs 过期后不再起新的宽扫重解析。
            reobserved = true;
            await this._settleBeforeExtract(pg);
            const wide = await this.candidates!.extract({ page: pg, jsProbe: true, maxElements: WIDER_ELEMENTS, widgets: true, candidatePriority: "main-first", hosts: this._frameHosts });
            if (Object.keys(wide).length > Object.keys(elems).length) {
              // refs 是位置性的：先把"换位后已不是同一元素"的禁用记录清掉（与步头同规则）。
              pruneForbids(wide);
              const wideRef = affordanceRule(instruction, wide, curHint, _hintOpts(this, ));
              // A3：宽扫命中**同样受 strong 约束**（同一个 `declaredAllow`；宽池新增候选
              // 可能让档位更强，也可能仍只在弱档胜出——后者不改写池，按"未命中"记账）。
              const wideGate = declaredAllow(
                wideRef, takeHintMatchOthers(), curHint,
                this.actHintTier === "strong" && !this._learnedHintApplied,
              );
              if (wideGate.ref !== null && !(wideGate.ref in forbidden)) {
                elems = wide;
                ruleRef = wideGate.ref;
                windowChainFacts.push({ window: WIDER_ELEMENTS, miss: 1, resolved: true, ref: wideGate.ref });
                if (verbose) {
                  console.log(`  step ${stepNo}: rules-only re-scanned wider `
                    + `(${Object.keys(wide).length} elements) -> ${wideGate.ref}`);
                }
              } else {
                windowChainFacts.push({ window: WIDER_ELEMENTS, miss: 1, resolved: false });
                if (wideGate.rejected !== null) {
                  // 宽扫也只在弱档胜出：候选/档位以宽池的事实为准（停因 reason 用）。
                  weakRejected = wideGate.rejected;
                  if (verbose) {
                    console.log(`  step ${stepNo}: rules-only wide re-scan hit a weak tier only `
                      + `(tier=${wideGate.rejected.tier}) — rejected by act_hint_tier:"strong"`);
                  }
                }
                // 递增链第二档：120 档未命中且窗口确有增长 → 扩到硬顶再重解析一次（命中即停；
                // 增长判据对 120 窗口——240 档必须带来新候选才值得付这次抽取）。
                if (stepTimeoutLeft() > 0) {
                  const wider = await this.candidates!.extract({ page: pg, jsProbe: true, maxElements: WIDER_ELEMENTS_MAX, widgets: true, candidatePriority: "main-first", hosts: this._frameHosts });
                  if (Object.keys(wider).length > Object.keys(wide).length) {
                    pruneForbids(wider);
                    const widerRef = affordanceRule(instruction, wider, curHint, _hintOpts(this, ));
                    const widerGate = declaredAllow(
                      widerRef, takeHintMatchOthers(), curHint,
                      this.actHintTier === "strong" && !this._learnedHintApplied,
                    );
                    if (widerGate.ref !== null && !(widerGate.ref in forbidden)) {
                      // 硬顶档全档命中：120 档的弱档判词是对旧窗口的，不再约束 strict 停因。
                      elems = wider;
                      ruleRef = widerGate.ref;
                      weakRejected = null;
                      windowChainFacts.push({ window: WIDER_ELEMENTS_MAX, miss: 2, resolved: true, ref: widerGate.ref });
                      if (verbose) {
                        console.log(`  step ${stepNo}: rules-only wide re-scan window `
                          + `${WIDER_ELEMENTS_MAX} (${Object.keys(wider).length} elements) -> ${widerGate.ref}`);
                      }
                    } else {
                      if (widerGate.rejected !== null) {
                        // 候选/档位以**最新窗口**的事实为准（与 120 档同款）。
                        weakRejected = widerGate.rejected;
                      }
                      windowChainFacts.push({ window: WIDER_ELEMENTS_MAX, miss: 2, resolved: false });
                      if (verbose) {
                        console.log(`  step ${stepNo}: rules-only wide re-scan window ${WIDER_ELEMENTS_MAX} `
                          + `-> ${widerGate.rejected !== null ? `weak tier only (tier=${widerGate.rejected.tier})` : "no match"}`);
                      }
                    }
                  }
                }
              }
            }
          }
        }
        // rehydrate_rescan（**缺省自动**；步级 rehydrateRescan:true 声明仍被接受但
        // 不再有额外效果）——act hint 在 池 → ADMIT 回捞 → FW8 身份回捞（→ rules-only 宽扫）全链
        // **真落空**（hintMatch 零命中；弱档胜出不进本路径）且**步首抽池时页面未静默**
        // （settle timedOut——水合中间态池的信号）时，做一次有界重扫：等 2s（受整步挂钟帽钳制）
        // → 重抽池（不再 settle——刚等过的墙钟就是给水合的窗口）→ 同一 hint 走 affordanceRule
        // + declaredAllow（与 U5 宽扫同一档位纪律）。命中 = elems/ruleRef 换新池（确定性
        // rule:match，不重走决策面）；仍未命中 = 原有 strict/模型路径逐字节不变，事实进 trace
        // 行与运行汇总。policy.settle:"off"（或 settle 传感器失败）时步首 settle 结论为 null，
        // 门控信号不存在，重扫永不触发。
        if (!commandMode && curHint !== null && weakRejected === null
            && hintMatch(curHint, elems, _hintOpts(this, )) === null
            && gateSettle !== null && gateSettle.timedOut === true
            && stepTimeoutLeft() > 0) {
          const waitMs = Math.min(2000, Math.max(0, stepTimeoutLeft() - 250));
          if (waitMs > 0) {
            await sleep(waitMs);
            const fresh = await this.candidates!.extract({ page: pg, jsProbe: true, candidatePriority,
              surface: this.surfacePolicy, hosts: this._frameHosts,
              ...(this.poolQuotaMode === "quota" ? { poolQuotaMode: "quota" } : {}) });
            pruneForbids(fresh);
            const freshRef = affordanceRule(instruction, fresh, curHint, _hintOpts(this, ));
            const freshGate = declaredAllow(
              freshRef, takeHintMatchOthers(), curHint,
              this.actHintTier === "strong" && !this._learnedHintApplied,
            );
            rehydrateRescanFact = {
              waited_ms: waitMs, pool_size_before: Object.keys(elems).length,
              pool_size: Object.keys(fresh).length, resolved: false,
            };
            if (freshGate.ref !== null && !(freshGate.ref in forbidden)) {
              elems = fresh;
              ruleRef = freshGate.ref;
              rehydrateRescanFact.resolved = true;
              rehydrateRescanFact.ref = freshGate.ref;
            } else if (freshGate.rejected !== null) {
              // 重扫只在弱档胜出：与 U5 同款——候选/档位以新池事实为准（strict 停因 reason 用）。
              weakRejected = freshGate.rejected;
            }
            if (verbose) {
              console.log(`  step ${stepNo}: rehydrate rescan waited ${waitMs}ms `
                + `(${rehydrateRescanFact.pool_size} elements) -> `
                + (rehydrateRescanFact.resolved ? String(rehydrateRescanFact.ref) : "no match"));
            }
          }
        }
        // F75：DOM 回退跳（`meta.policy.act_hint_dom_fallback:true`，opt-in，缺省 false =
        // 行为逐字节不变）——决策步 act hint 在 池→ADMIT 回捞→FW8→(DRF)→(U5/F72 条件跳)
        // 全链真落空后，补一次**主帧 ADMIT_SEL DOM 回退跳**（与会话 act 的
        // `_domFallbackResolve` 同一实现：不过滤可见性、含 0×0 自绘控件——hintLookup/FW8/
        // DRF/U5/F72 五跳全部要求可见盒/可见匹配，"会话 act 能解的声明 hint 在 run 解不了"
        // 的 authoring→run 可移植性缺口在此补齐）。命中 = 合成行注入本步局部池（df: 前缀
        // 避让 eN/pN/dom:/declared:/identity:/drf: 命名空间）+ 确定性 rule:match（不进模型
        // 投影）；歧义 = 同一谓词结构化 target_ambiguous；落空 = 原有 strict/模型路径逐字节
        // 不变，仅 strict reason 补"已试 DOM 回退"事实。至多一次/步；不放大 attempts；
        // weakRejected（strong 档已判弱档未命中）不翻案。
        if (this.actHintDomFallback && !commandMode && curHint !== null && ruleRef === null
            && weakRejected === null && hintMatch(curHint, elems, _hintOpts(this, )) === null
            && stepTimeoutLeft() > 0) {
          const df = await _domFallbackResolve(this, pg, curHint, "click", "fail", false);
          if ("scan" in df) {
            domFallbackMissed = true;   // 探针已由回退面自清（scan 分支内 cleanup）
          } else if ("ambiguity" in df) {
            // 评审收口（F75 证据弱化）：同一歧义谓词，候选与 skipped_actions 必须与命令走廊/
            // 会话面同强度——停因不是"就停一下"，要能回答"到底撞了哪几个"。
            const amb = df.ambiguity;
            for (const c of amb.candidates) {
              noteSkipped({
                ref: `dom_fallback:${c.ref}`, reason: "target_ambiguous",
                detail: `${amb.candidates_total} DOM-fallback candidate(s) for ${JSON.stringify(curHint)}; never guessed`,
              });
            }
            stop("target_ambiguous",
              `declared target_hint ${JSON.stringify(curHint)} matches ${amb.candidates_total} DOM-fallback `
              + `candidates (main-frame ADMIT_SEL; same ambiguity predicate as the pool) on step ${stepNo} — `
              + `candidates: ${amb.candidates.slice(0, 5).map((c) => `${c.tag} "${c.label}"`).join(" | ") || "-"}`
              + ` — narrow the hint (unique #id / [data-test=…] / exact visible text)`,
              stepNo);
            if (verbose) console.log(`  step ${stepNo}: ${acct.stopReason}`);
            break;
          } else {
            const dfRef = `df:${df.ref.slice(1)}`;   // df.ref 是合成池的 pN；换 df: 前缀入池
            elems[dfRef] = df.elem;
            ruleRef = dfRef;
            domFallbackRef = dfRef;
            domFallbackCleanupFn = df.cleanup;
            if (verbose) console.log(`  step ${stepNo}: dom fallback -> ${dfRef}`);
          }
        }
        // 第五档 AX 回退（strict 停因前；本步至多 1 次）——解析链
        // 池→ADMIT 回捞→FW8→(DRF)→U5/F72/F74/F75 全部落空后的最后手段：AX 可交互有名
        // 节点与 act hint 词面匹配（裸词归一化全等优先，词前缀/词包含标弱档并告警；
        // attr 形状 = AX name 全等；#id/tag/tag~token 不参与——#id 另有直查兜底），反解
        // DOM 盖临时探针章。命中 = ax: 合成行注入本步局部池（declared:true 旁路标记，
        // 绝不进 ChoiceRequest）+ 确定性 rule:match（不进模型面）；>1 候选 = 同一
        // describeAmbiguity 谓词零动作停；快照不可用/无匹配/反解全败 = 既有 strict 路径
        // 逐字节不变。
        if (!commandMode && curHint !== null && ruleRef === null && weakRejected === null
            && axFallbackRef === null) {
          const ax = await _resolveAxFallback(this, pg, curHint, "fail", { strong: this.actHintTier === "strong" });
          if (ax !== null && "hit" in ax) {
            axFallbackRef = ax.hit.ref;
            axFallbackWeak = ax.hit.weak;
            axFallbackCleanupFn = ax.hit.cleanup;
            elems[ax.hit.ref] = ax.hit.elem;
            ruleRef = ax.hit.ref;
            if (ax.hit.weak) {
              warnings.push(`ax_fallback_weak_tier: act hint "${curHint}" matched an AX node name only at a weak tier `
                + `(word prefix/contains) — resolved via the AX fallback as a last resort; verify the target`);
            }
            if (verbose) console.log(`  step ${stepNo}: ax fallback -> ${ax.hit.ref} (${ax.hit.elem.label})`);
          } else if (ax !== null && "rejected_weak" in ax) {
            // declaredAllow 同门：act_hint_tier:"strong" 判弱档**未命中**——清章 + 警告，
            // 落回既有 strict 停因路径（宁显式落空不做静默弱配；门在 _resolveAxFallback 单点）。
            warnings.push(`ax_fallback_weak_tier: act hint "${curHint}" matched an AX node name only at a weak tier `
              + `(word prefix/contains) — rejected by act_hint_tier:"strong" (weak tiers are not hits; `
              + `set "any" to accept the AX last-resort)`);
            if (verbose) console.log(`  step ${stepNo}: ax fallback weak tier rejected by act_hint_tier:"strong"`);
          } else if (ax !== null && "ambiguity" in ax) {
            stop("target_ambiguous",
              `declared target_hint ${JSON.stringify(curHint)} matches ${ax.ambiguity.candidates_total} AX candidates `
              + `(accessibility-tree fallback; same ambiguity predicate as the pool) on step ${stepNo} — `
              + `candidates: ${ax.ambiguity.candidates.slice(0, 5).map((c) => `${c.tag} "${c.label}"`).join(" | ") || "-"}`
              + ` — narrow the hint (unique #id / [data-test=…] / exact visible text)`,
              stepNo);
            if (verbose) console.log(`  step ${stepNo}: ${acct.stopReason}`);
            break;
          }
        }
        // clickxy：第六档（**最后手段**）——文本 bbox 中心坐标点击。全链（含 AX 第五档）落空后，
        // 若页面上存在文本全等且唯一可见的元素（无任何可寻址句柄），解析为 clickxy 合成行；
        // 动作经 _clickOnly 的坐标分支执行，**危险门控**由风险闸门强制 confirmFn（缺省拒绝、
        // 非交互恒拒绝）。>1 可见 = 歧义零动作（落 strict target_not_found，绝不猜坐标）；
        // 本步至多 1 次；快照/探测异常 = null，既有路径逐字节不变。
        if (!commandMode && curHint !== null && ruleRef === null && weakRejected === null
            && axFallbackRef === null && clickxyHit === null) {
          const cx = await _resolveClickxyFallback(pg, curHint);
          if (cx !== null && "hit" in cx) {
            clickxyHit = { x: cx.hit.elem.clickxy!.x, y: cx.hit.elem.clickxy!.y };
            elems[cx.hit.ref] = cx.hit.elem;
            ruleRef = cx.hit.ref;
            if (verbose) {
              console.log(`  step ${stepNo}: clickxy fallback -> (${clickxyHit.x}, ${clickxyHit.y}) "${curHint}"`);
            }
          } else if (cx !== null && "refused" in cx) {
            warnings.push(`clickxy_ambiguous: act hint "${curHint}" matched ${cx.refused.total} visible element(s) `
              + `by exact text — coordinate click refused (never guesses a position)`);
          }
        }
        // P0-B `meta.policy.act_hint:"strict"`：声明目标解析链（池 hintMatch → ADMIT 回捞
        // → FW8 身份回捞 → rules-only 宽扫）全部未命中时，**不再静默回退到模型自由选**
        // （R08 实测：未命中的 act hint 被模型换成"酒店"登录入口 → host_not_allowed 中止）。
        // 命令步不受影响（cmdSpace 非空时 curHint 恒 null，命令面自带解析/报错）；
        // widen（缺省）一个字节都不走这里。identityHidden 的隐藏元素仍算未命中（绝不操作）。
        // A3：`act_hint_tier:"strong"` 把弱档胜出改判"未命中"后，strict 也要收口——
        // 池 hintMatch 本身仍非 null（弱档真解析到了元素），所以判定式与 reason 分开给；
        // 停因码复用既有 target_not_found（不新增 stopCode）。any（缺省）下
        // `weakRejected === null`，条件/文案与今天逐字节一致。
        if (this.actHintStrict && !this._learnedHintApplied && !commandMode
            && curHint !== null
            && (weakRejected !== null || hintMatch(curHint, elems, _hintOpts(this, )) === null)) {
          const poolSize = Object.keys(elems).length;
          const summary = poolRoleSummary(elems, ALL_FAMILIES);
          // C 批（B8）：strict 的两条 reason 也追加 frame: 尾缀诊断 + 页面可用 origin（无 frame:
          // 参与 = 空串，旧文案逐字节不变）。
          // F82：池在手 = 追加 in-row 尾缀被拒点名 / 三案证据（声明 in-row 的 strict 落空
          // 要能回答"token 在行词元里吗"）。
          const frameNote = frameHintFailureEvidence(pg, this._frameHosts, [curHint], elems);
          if (weakRejected !== null) {
            stop("target_not_found",
              weakRejectedReason(weakRejected, curHint, stepNo, poolSize, summary)
              + identityHiddenSuffix(targets.identityHidden) + declaredHiddenSuffix(targets.getDeclaredHidden()) + declaredMissSuffix(targets.declaredMiss) + drfHintSuffix(this.targetResolutionDeclared)
              + (frameNote ? ` — ${frameNote}` : "")
              + windowChainMissSuffix(windowChainFacts), stepNo);
          } else {
            // F73：解析链列举句按声明状态条件化——declared 场景下 DRF 是链的一环，实跑了
            // 就要被点名（缺省未声明时串逐字节不变）。
            const chainNote = this.targetResolutionDeclared
              ? "after hintMatch / ADMIT recovery / FW8 identity recovery / DRF declared-DOM resolution. "
              : "after hintMatch / ADMIT recovery / FW8 identity recovery. ";
            // DOM 等价探测（只读，主帧；单一出处 = extraction.probeHintInDom）——strict
            // 落定前区分"池准入失败"与"页面没有"。命中 = reason 追加"在 DOM 但未进池"段（含
            // 可行动原因）；未命中/探测异常 = 空串（reason 逐字节不变）。弱档胜出分支不探测
            // （目标已可解析，只是档位不够——"在不在 DOM"没有判别力）。
            const inDom = await probeHintInDom(pg, curHint);
            const firstDom = inDom !== null && inDom.matches.length > 0
              ? `<${inDom.matches[0]!.tag}${inDom.matches[0]!.id ? `#${inDom.matches[0]!.id}` : ""}`
                + `${inDom.matches[0]!.class ? `.${inDom.matches[0]!.class}` : ""}>`
              : "";
            const domProbeNote = inDom === null ? ""
              : `; DOM probe: the hint matches ${inDom.total} element(s) in the live DOM`
                + `${firstDom ? ` (first: ${firstDom})` : ""} but none entered the pool — ${inDom.note}`;
            stop("target_not_found",
              `step ${stepNo}: act_hint="strict" forbids the model fallback — declared target_hint `
              + `${JSON.stringify(curHint)} matched nothing in the pool (${poolSize} element(s)`
              + `${summary ? `: ${summary}` : ""}) ${chainNote}`
              + `Fix the hint (closed set: #id | tag[attr=value] | tag[attr~substr] | tag~token | tag | bare-token) `
              + `or remove meta.policy.act_hint:"strict" to let the decision model pick instead`
              + identityHiddenSuffix(targets.identityHidden) + declaredHiddenSuffix(targets.getDeclaredHidden()) + declaredMissSuffix(targets.declaredMiss)
              + domFallbackMissSuffix() + drfHintSuffix(this.targetResolutionDeclared)
              + (frameNote ? ` — ${frameNote}` : "")
              + domProbeNote
              + windowChainMissSuffix(windowChainFacts), stepNo);
          }
          if (verbose) console.log(`  step ${stepNo}: ${acct.stopReason}`);
          break;
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
        const pickPhase = await runModelPick(this, {
          pg, stepNo, instruction, verbose, elems, ruleRef, curHint, commandMode, forbidden, noted, trace, targets, adjudicate, reobserve, escalateFn, expectedFamily,
          confFloor: this.confFloor, candidatePriority, tieredHint, rulesOnly: this.rulesOnly, decisionDegradedReasonClass: this.decisionDegraded?.reason_class ?? null, rejectedAskConfs: this._rejectedAskConfs, warnings,
          reobserved, escalated, escalatedPick, windowChainFacts, stepTimeoutLeft, stop, stopReason: () => acct.stopReason, pickElement: (g, page, pool, blocked, notes) => this.pickElement(g, page, pool, blocked, notes),
          orderedPool, settleBeforeExtract: (page) => this._settleBeforeExtract(page), pruneForbids, hintOpts: () => _hintOpts(this, ), frameHosts: this._frameHosts, stateTextFn: (page, instr) => stateText(page, instr, this.embedFn),
          rowAnchorNote, declaredTargets, goalHeld, goalSignalFn, isTyping: (el) => this._isTyping(el), modelLabel: () => this.modelLabel(), degradedReasonSuffix: () => this.degradedReasonSuffix(),
          choiceLimitReason: () => this._choiceLimitReason, clearChoiceLimitReason: () => { this._choiceLimitReason = null; },
        });
        elems = pickPhase.elems;
        escalatedPick = pickPhase.escalatedPick;
        if (pickPhase.stopped) break;
        let ref = pickPhase.ref;
        const { conf, method, decisionKind, layaMargin, tierAsk, nominatedRepair, label: mm } = pickPhase;
        if (ref === null) break;

        let el = elems[ref]!;
        const action = await runActionPhase(this, {
          pg, stepNo, instruction, verbose, elems, ref, el, cmdPick, commandMode, commandValue, commandByValue,
          commandBindMissing, dryRun, force, effect, slots, values, candidatePriority, curHint, method, conf, mm,
          decisionKind, layaMargin, tierAsk, nominatedRepair, escalatedPick, prevented, noted, staleRetry,
          rehydrateRescanFact, targets, trace, cmdAttempts, blockedRetry, reAdmitted, forbidden, forbid, noteSkipped,
          pruneForbids, stop, stopReason: () => acct.stopReason, domFallbackCleanup, markDryRan: () => { dryRan = true; },
          getPendingAfterIdx: () => pendingAfterIdx, warnings, actionDeclEvidence, refCollision, domFallbackEvidence,
        });
        ref = action.ref; el = action.el; elems = action.elems;
        if (action.control === "continue") continue;
        if (action.control === "break") break;
        if (action.lastEffect !== undefined) lastEffect = action.lastEffect;
        executedCount += action.executedDelta ?? 0;
        if (action.cmdDoneId != null) { cmdDone.add(action.cmdDoneId); cmdI = action.nextCmdI ?? cmdI; }
        const post = action.post!;
        const postPhase = await runPostAction(this, {
          pg, stepNo, verbose, instruction, elems, ref, el, desc: action.desc!, how: action.how!,
          method, conf, inert: action.inert!, executed: action.executed!, mm, decisionKind, post, hostGate,
          trace, setPendingAfterIdx: (idx) => { pendingAfterIdx = idx; }, done, manualDone, donePreheld, manualGoal,
          manualConfirmFn, goalSignalFn, goalHeld,
          cmdWalkComplete, flagSuspectedAsync: action.flagSuspectedAsync!, forbid, outcomeMemory, effectiveRuns, hintMemory, doneTimeoutMs, donePollMs,
          stepStartUrl, stepStartTabs, stop, stopReason: () => acct.stopReason, isDone: (instr, page) => this.isDone(instr, page),
        });
        done = postPhase.done;
        manualDone = postPhase.manualDone;
        if (postPhase.control === "break") break;
        if (postPhase.control === "continue") continue;

      }
      // S1 收尾观察/前进性/stepState 提 runTail（循环后 epilogue）
      stepState = await runTail(this, { pg, candidatePriority, observeState, trace, beforeFp, lastEffect, poolEmptyThisStep, donePreheldSeen, done, warnings });
    } finally {
      // Only close the browser run() launched itself: an injected page/pw belongs
      // to the caller (PORT NOTE 5, Python's owns_browser/_stop_playwright_owned).
      if (browser !== null) await browser.close();
    }

    // F3：run() 报告尾收归 runReportTail（纯只读状态快照 → RunReport）。
    const rttCtx: RunReportTailCtx = {
      instruction,
      done,
      manualDone,
      dryRan,
      donePreheld,
      stopCode: acct.stopCode,
      stopReason: acct.stopReason,
      stopStep: acct.stopStep,
      trace,
      goalSignalFn,
      page,
      hostGate,
      doneSpec,
      executedCount,
      frameGate: gatePhase !== null && gatePhase.kind === "ready" ? gatePhase.frameGate : null,
      doneInExcluded: gatePhase !== null && gatePhase.kind === "ready" ? gatePhase.doneInExcluded() : false,
      warnings,
      lastPageRef,
      lastPoolSize,
      lastPoolWaitedMs,
      lastReadiness,
      viewportUnderloaded,
      getLastDeclaredHidden,
      skippedActions,
      stepState,
      cmdSpace,
      verbose,
      poolReady,
      stop: () => {},
    };
    // ctx.stop 包装原 stop 闭包，并把新停因同步回 ctx（false_done 档需要读到新值）。
    rttCtx.stop = (code: StopCode, detail?: string, at?: number) => {
      stop(code, detail, at);
      rttCtx.stopCode = code;
      if (detail !== undefined) rttCtx.stopReason = detail;
      if (at !== undefined) rttCtx.stopStep = at;
    };
    return await runReportTail(this, rttCtx);
  }



  /* X1：公开方法面（实现已搬 executor-actions.ts；类型由实现函数推导，调用契约不变） */
  async actOnce(...args: OmitMw<Parameters<typeof actOnce>>): ReturnType<typeof actOnce> {
    return actOnce(this, ...args);
  }
  async scrollIntoView(...args: OmitMw<Parameters<typeof scrollIntoView>>): ReturnType<typeof scrollIntoView> {
    return scrollIntoView(this, ...args);
  }
  async scrollDocument(...args: OmitMw<Parameters<typeof scrollDocument>>): ReturnType<typeof scrollDocument> {
    return scrollDocument(this, ...args);
  }
  async scrollContainer(...args: OmitMw<Parameters<typeof scrollContainer>>): ReturnType<typeof scrollContainer> {
    return scrollContainer(this, ...args);
  }
  async setRange(...args: OmitMw<Parameters<typeof setRange>>): ReturnType<typeof setRange> {
    return setRange(this, ...args);
  }

}
