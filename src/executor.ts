/**
 * Application layer: the browser-automation executor — the TS twin of
 * `layaapp/executor.py`.
 *
 * `BrowserMiddleware` is THE execution loop — one implementation shared by the
 * demos, the CLI, the batch entries and the benchmark harness (BenchMiddleware
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

import os from "node:os";

import { getAuditor, type AuditVerdict, type Auditor, type TraceStep } from "./audit.ts";
import * as browserEnv from "./browser-env.ts";
import type { BrowserLike, LaunchOptions } from "./browser-env.ts";
import {
  INTERACTIVE_ALL,
  ariaInteractiveLines,
  criteriaView,
  esig,
  extractElements,
  extractSlots,
  firstOf,
  frameAt,
  framesOf,
  hintLookup,
  stateText,
  urlOf,
  type Elem,
  type ElemPool,
  type PageLike,
} from "./extraction.ts";
import {
  getLayaRuntime,
  type ChoiceAnswer,
  type DecisionAgent,
  type ModelState,
  type NoulAnswer,
  type RouterLike,
} from "./model.ts";
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
import { LayaNotConfiguredError, type LayaRuntime } from "./model.ts";
import { induceHint } from "./hint-memory.ts";
import { instantiateSpace, resolveCommandValue, type CommandDecl } from "./actions.ts";
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
 * Structured stop cause (docs/ARCHITECTURE_REVIEW.md D4 / P0-2).
 *
 * The loop used to terminate on 12 free-text `stop_reason` strings, so every
 * downstream consumer (apps:suite exit codes, the DSH bridge, reports, refusal
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
  | "config_error"
  /** P2: a declared command space with NOTHING resolvable on this page (space-empty). */
  | "space_empty"
  /**
   * D3/R-4：同一个元素被**有效地**执行了 N 次而完成信号始终不成立 —— 循环卡住了，
   * 不是步数预算用完了。与 `max_steps` 分开（backlog R-4）：前者说"目标死了/信号不会来了"，
   * 后者说"给了 8 步还没跑完"。
   */
  | "no_progress"
  /** P2: a `fill`/`select` command's declared slot binding has no value (never guessed). */
  | "needs_value";

/** Minimal locator surface used by the executor (superset of `extraction.LocLike`). */
interface AnyLoc {
  click(opts?: Record<string, unknown>): Promise<void>;
  fill(value: string, opts?: Record<string, unknown>): Promise<void>;
  selectOption(value: unknown, opts?: Record<string, unknown>): Promise<void>;
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
}

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
 * CLEARS the mark the moment that element works (see src/outcome-memory.ts).
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
 * — restricted to stable handles by `induceHint` (see src/hint-memory.ts).
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
  /** Reuse an open page (one browser across subgoals); run() then owns nothing. */
  page?: AnyPage | null;
  slots?: Record<string, unknown> | null;
  targetHint?: string | null;
  /** Reuse a live playwright object; run() then leaves it alone. */
  pw?: PwLike | null;
  verbose?: boolean;
  targetHints?: string[] | null;
  /** `when` guard: evaluated after navigation, before any action. */
  precondition?: SignalSpec | null;
  /**
   * P2 COMMAND SPACE (docs/ARCHITECTURE_REVIEW.md §6, the "check + submit in ONE
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
   * §4：这一步的**可逆性**声明（来自 `pack` 的 `effect`）。它改变的是"闸门相不相信关键词/模型票"，
   * 不改变任何缺省行为：不写 = 今天（DESTRUCTIVE_PATTERNS + 模型票）。
   * `irreversible: true` ⇒ 必问确认且不许被模型提议；`false` ⇒ 明确告诉架构"错了也白跑"，
   * 这是 W4/A2 唯一允许放开模型的依据。
   */
  effect?: { irreversible?: boolean; verify_after?: "signal" | "none" };
  /**
   * Navigation envelope (see `disallowedHost`): when non-empty, `run()` refuses
   * to open a `start_url` whose host is not declared, and stops the subgoal if
   * an executed action lands on an undeclared host. Default: no envelope —
   * behaviour identical to before. `apps/<id>/pack.json`'s `hosts` feeds this.
   */
  hosts?: string[] | null;
  /**
   * P1 TIERED HINT (docs/EXECUTION_LAYER_SPLIT_PLAN.md M0, default OFF): when the
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
   * D3/R-4：同一个元素（按**元素签名**，不是位置性 ref）在**一个子目标内**最多被有效执行几次。
   *
   * 为什么需要这个上界：`inert` 是整页快照比对，页面上有个倒计时/轮播/广告计时器时它
   * **永远不成立**（前/后两次采样之间页面必然变了），于是"这个元素没用了"的证据链断掉，
   * anti-repeat 不触发，同一个死按钮被反复点，最后报告把病因写成 `max_steps`——
   * 一个噪声信号不该是循环唯一的终止依据（重审 D3）。缺省 3；0 = 关闭（回到今天的行为）。
   */
  maxEffectiveRepeats?: number;
  /** Constructor-level default for `RunOptions.tieredHint` (P1 narrowed question, default OFF). */
  tieredHint?: boolean;
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
 * SECRET REDACTION (P0-3, docs/ARCHITECTURE_REVIEW.md D5①): `password`/`file`/`hidden`
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
const WIDER_ELEMENTS = 120;

/**
 * SPA settle window: how long a done-signal gets to become true after an executed
 * action before the loop spends another step. Client-side routing updates the url
 * immediately and re-renders afterwards — measured 30-230 ms on the live saucedemo
 * long flow — and a single check there is a coin flip.
 */
const SPA_SETTLE_MS = 120;
const SPA_SETTLE_POLLS = 4;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
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
 * Navigation envelope (P0-4, docs/ARCHITECTURE_REVIEW.md D5② / backlog R-5).
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

function safeUrl(obj: unknown): string {
  try {
    return urlOf(obj as PageLike);
  } catch {
    return "";
  }
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
  reobserve = true;
  escalateFn: EscalatorLike | null = null;
  /** No runtime installed: rules/hints only. Set by `ready()` (see RULES-ONLY MODE). */
  rulesOnly = false;
  rulesOnlyReason = "";
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
  /** See `RunOptions.tieredHint` (P1 narrowed question; default OFF = today's behaviour). */
  tieredHint = false;
  /** See `MiddlewareOptions.maxEffectiveRepeats` (D3/R-4; default 3, 0 disables). */
  maxEffectiveRepeats = 3;
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
    this.reobserve = opts.reobserve ?? true;
    this.escalateFn = opts.escalateFn ?? null;
    this.outcomeMemory = opts.outcomeMemory ?? null;
    this.outcomeMemoryMode = opts.outcomeMemoryMode ?? "forbid";
    this.hintMemory = opts.hintMemory ?? null;
    this.gotoTimeout = opts.gotoTimeout ?? 30000;
    this.hosts = opts.hosts ?? null;
    this.maxEffectiveRepeats = opts.maxEffectiveRepeats ?? this.maxEffectiveRepeats;
    this.tieredHint = opts.tieredHint ?? this.tieredHint;
  }

  /**
   * Build the resident checkpoint + the optional router ONCE (PORT NOTE 4 —
   * Python does this in `__init__`, which cannot await). Idempotent.
   */
  private async ready(): Promise<void> {
    if (this._ready) return;
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
   * 一次"选元素"的**完整提案**（docs/ARCHITECTURE_IMPROVEMENTS.md §2）。
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
    if (this.rulesOnly) {
      // no model to ask: the caller reports "needs a model pick" instead of a crash
      return { ref: null, conf: 0.0, probs: {}, passthrough: true };
    }
    const crit = criteriaView(elems, forbidden, await ariaInteractiveLines(page), notes);
    if (!Object.keys(crit).length) {
      // action space exhausted (every element forbidden/inert) — signal this
      // with conf 0 so the caller stops instead of crashing the runtime.
      return { ref: null, conf: 0.0, probs: {}, passthrough: true };
    }
    const state = {
      goal,
      url: urlOf(page),
      title: await page.title(),
      main_text: await stateText(page, goal, this.embedFn),
    };
    const { agent, embedFn } = await this.agentFor(state);
    const res = await getLayaRuntime().predictShortlist(agent, state, {
      act: {
        type: "choice",
        instructions: `Goal: ${goal}. Which single element should be interacted with next to make progress on this goal? Ignore branding, navigation and decoration unless the goal requires them.`,
        criteria: crit,
      },
    }, { embedFn, k: 8 });
    const a = res.answers["act"] as ChoiceAnswer | undefined;
    // A runtime that does not answer `act` AT ALL must block the step, not crash
    // (same guard as isRisky/isDone — "no pick" is a result). A present but
    // choiceless answer (a noul-shaped object) flows on exactly as before: the
    // caller's `elems[ref]` miss reports it via the helpful "names no target"
    // message, which is the UX contract for a step nothing could name.
    if (a === undefined) return { ref: null, conf: 0.0, probs: {}, passthrough: false };
    // The shortlist re-normalises probabilities over its kept subset only: when
    // it dropped nothing (labels <= k), that renormalised value is NOT the
    // model's calibrated confidence — `predict_shortlist` hands back the
    // passthrough answer whose own `confidence` is. Trusting the subset one
    // inflated a 0.13 pick to 0.76 and let wrong clicks through the floor.
    const probs = a.probabilities ?? {};
    const sl = res.shortlist?.["act"] ?? {};
    // **不要**把 `a.choice` 的 undefined 归成 null：调用方靠这两种值区分
    // "运行时答了但没给出可用元素"（→ 说人话：hint 没命中 / 这一步没点名）与
    // "根本没答"（→ action space exhausted）。本轮把它写成 `?? null` 就打红了
    // tests/ux-fixes.test.ts ③ 与 tests/app-packs-verified.test.ts 第 5 轮各一条。
    if (sl.passthrough) return { ref: a.choice as string | null, conf: a.confidence, probs, passthrough: true };
    // `confidence` is 1 - normalized entropy: with few options it collapses even
    // when the model is decisive. The argmax value against the runner-up is the
    // calibration-consistent gate signal here.
    // `Math.max()` of an empty list is -Infinity: a runtime that answers without
    // probabilities must not poison the floor comparison (the stop message printed
    // `low confidence -Infinity`). Fall back to the answer's own confidence.
    const values = Object.values(probs);
    const top = values.length ? Math.max(...values) : (a.confidence ?? 0);
    return { ref: a.choice as string | null, conf: top, probs, passthrough: false };
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
    const state = {
      goal,
      url: urlOf(page),
      title: await page.title(),
      main_text: await stateText(page, goal, this.embedFn),
    };
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

  /**
   * Stable handle for an element we just inspected.
   *
   * Every lookup is scoped to the frame the element came from: `page.locator`
   * only ever searches the main frame, so an element inside an iframe is
   * unreachable from there. Within a frame the order is the stamp written by the
   * pass that identified the element (data-dshref from extraction, data-hintref
   * from hint recovery), then data-js-ref (CDP probe), then data-test, id, name,
   * input type, and a positional fallback into the same frame's scan.
   */
  async _locatorFor(page: AnyPage, el: Elem): Promise<AnyLoc | null> {
    let scope: any = page;
    if (el["frame"]) scope = frameAt(page, el["frame"] as number) ?? page;
    const chain: Array<[string, string]> = [
      ["dsh_ref", "[data-dshref='%s']"],
      ["hint_ref", "[data-hintref='%s']"],
      ["js_ref", "[data-js-ref='%s']"],
      ["data_test", "[data-test='%s']"],
    ];
    for (const [key, selector] of chain) {
      if (el[key]) {
        const loc = scope.locator(selector.replace("%s", String(el[key])));
        if (await loc.count()) return loc as AnyLoc;
      }
    }
    if (el["id"]) {
      const loc = scope.locator(`#${el["id"]}`);
      if (await loc.count()) return loc as AnyLoc;
    }
    if (el["name"]) {
      const loc = scope.locator(`${el.tag}[name='${el["name"]}']`);
      if (await loc.count()) return loc as AnyLoc;
    }
    if (el["input_type"]) {
      const loc = scope.locator(`${el.tag}[type='${el["input_type"]}']`);
      if (await loc.count()) return loc as AnyLoc;
    }
    // positional fallback: refs are indices into THAT FRAME's scan. Never index
    // off the ref string — namespaced refs ("f1:e3") are not numeric.
    if (el["scan"] === undefined) return null;
    const allm = (await scope.locator(INTERACTIVE_ALL).all()) as AnyLoc[];
    if ((el["scan"] as number) < allm.length) return allm[el["scan"] as number]!;
    return null;
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
        if (hit) return `not-actionable-or-covered:${String(hit)}`;
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

  /**
   * Non-mutating actionability probe for a dry run. `occludedReason` cannot be used
   * here: its fast path IS the real click, so a dry run through it would already have
   * acted. This asks Playwright the read-only questions only (`isVisible` /
   * `isEnabled`) plus the same centre hit-test, so the page state is untouched.
   */
  async dryRunProbe(page: AnyPage, el: Elem): Promise<{ actionable: boolean; reason: string | null }> {
    const loc = await this._locatorFor(page, el);
    if (loc === null) return { actionable: false, reason: "stale_ref" };
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

  /** Match a plan slot to this field: exact key first, then substring, any case. */
  _slotValue(el: Elem, slots: Record<string, unknown>): unknown {
    const keys = [el["data_test"], el["label"], el["name"], el["id"]].filter((k) => !!k) as string[];
    for (const k of keys) {
      if (k in slots) return slots[k];                 // exact key hit first
    }
    for (const k of keys) {
      const kl = String(k).toLowerCase();
      for (const [sk, sv] of Object.entries(slots)) {
        const skl = sk.toLowerCase();
        if (skl && (skl.includes(kl) || kl.includes(skl))) return sv;
      }
    }
    return null;
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
  async _clickOnly(page: AnyPage, el: Elem): Promise<[string, unknown]> {
    const loc = await this._locatorFor(page, el);
    if (loc === null) return ["stale_ref", null];
    // Same containment as `_executeElement`: an element that passes the
    // actionability probe can still be unclickable a moment later (a collapsed
    // language sidebar, a re-render, an animation). Playwright raises a 5 s
    // TimeoutError; letting it escape killed the whole plan (measured on the live
    // zh.wikipedia case: 0/0 subgoals). Report it and let the loop forbid the ref.
    try {
      await firstLoc(loc).click({ timeout: 5000 });
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
  ): Promise<[string, unknown]> {
    const tag = el.tag;
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (this._isSubmit(el)) return this._clickOnly(page, el);
      // P2: a command-space fill/select arrives with its value ALREADY BOUND BY NAME
      // (`{from:"slot", key}` from the plan) — it must not fall back to `_slotValue`'s
      // substring heuristic, which is how a value once got handed to a radio. When no
      // binding was given (every pre-existing path), the heuristic stays exactly as today.
      const val = bound !== undefined && bound !== null ? bound.value : this._slotValue(el, slots);
      if (val === null || val === undefined) return ["needs_value", null];
      const loc = await this._locatorFor(page, el);
      if (loc === null) return ["stale_ref", null];
      // A failing action is a RESULT, not an exception: a disabled/hidden field
      // or a page that unmounts mid-step must forbid the ref (the loop does that
      // for any non-"filled"/"clicked" outcome) and keep the subgoal alive. The
      // Python reference let Playwright's TimeoutError escape `run()` and killed
      // the whole plan; found by the live zh.wikipedia case.
      try {
        if (tag === "select") {
          if (bound?.byValue) {
            // 声明式绑定已经**按值**命中过当次观察到的候选：直接按值选（不付 label 探测，
            // 也不会选中"标签恰好等于这个机器值"的另一个 option）。
            await firstLoc(loc).selectOption({ value: String(val) }, { timeout: 5000 });
          } else {
            try {
              await firstLoc(loc).selectOption({ label: String(val) }, { timeout: 1500 });
            } catch {
              await firstLoc(loc).selectOption({ value: String(val) }, { timeout: 5000 });
            }
          }
        } else {
          await firstLoc(loc).fill(String(val));
        }
      } catch (e) {
        return ["action_failed", describeActionError(e)];
      }
      return ["filled", val];
    }
    return this._clickOnly(page, el);
  }

  /**
   * Visible empty inputs/textareas whose value the frozen plan supplies.
   *
   * Not just `[required]`: a submit button guarded by JS on an empty field is
   * inert without it. Deterministic pre-fill from the plan's data bag — values
   * never come from the model. Reuses the scan the caller already has:
   * re-extracting here cost a SECOND full extraction before every click.
   */
  async _missingRequired(page: AnyPage, slots: Record<string, unknown>, elems: ElemPool | null = null): Promise<Elem[]> {
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
      const elemsNow = elems ?? (await extractElements(page));
      let match: Elem | undefined;
      for (const e of Object.values(elemsNow)) {
        if ((em.dt && e["data_test"] === em.dt)
          || (em.id && e["id"] === em.id)
          || (em.name && e["name"] === em.name)) {
          match = e;
          break;
        }
      }
      if (match === undefined || this._slotValue(match, slots) === null) continue;
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
      targetHint = null,
      pw: pwIn = null,
      verbose = true,
      targetHints = null,
      precondition = null,
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
      effect,
    } = opts;

    // The navigation envelope: run-level declaration wins, else the middleware's
    // (set once for a whole journey by the app runner from `pack.hosts`).
    const hostGate = hosts ?? this.hosts;
    // P2 command space: the ordered closed set for THIS subgoal. Progress is per-run
    // local state (a retry re-runs the whole subgoal, so the space restarts walking
    // from the top — exactly the `retries` contract).
    const cmdSpace: CommandDecl[] = (commands ?? []).filter((c) => c && typeof c.id === "string");
    const cmdDone = new Set<string>();
    let cmdI = 0;
    // D3/R-4: element signature -> how many times this subgoal effectively drove it while the
    // done-signal stayed false. Keyed by SIGNATURE (refs are positional); see the check below.
    const effectiveRuns: Record<string, number> = {};

    const slots: Record<string, unknown> = { ...extractSlots(instruction), ...(slotsIn ?? {}) };
    this.targetHints = (targetHints ?? []).filter((h) => !!h);
    this._hintI = 0;
    // A single hint keeps its old, whole-subgoal authority; a list hands
    // authority to currentHint() so it can walk the sequence.
    this.targetHint = this.targetHints.length ? null : targetHint;

    const trace: TraceStep[] = [];
    let done = false;
    let manualDone = false;          // done because a HUMAN attested, not a DOM signal
    let dryRan = false;              // stopped at the dry-run probe (nothing executed)
    let stopReason = "max_steps";
    let stopCode: StopCode = "max_steps";
    let stopStep: number | undefined;
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

    try {
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
      await pg.goto(startUrl, { waitUntil: "domcontentloaded", timeout: this.gotoTimeout });
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
        let elems = await extractElements(pg);
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
        let reobserved = false;          // at most ONE wider look per step
        let escalated = false;           // at most ONE escalation per step
        let escalatedPick: string | null = null;
        // P2 COMMAND SPACE — the step's action is chosen ON THE CLOSED SET, not on the pool:
        // `instantiateSpace` semantics implemented as the walk below (declaration × this
        // step's observation; a command resolving to nothing is OUT — with the same
        // "the plan-named target is never eaten by the budget" recovery hints get — and
        // nothing left is a structured stop, NEVER a fallback to the full pool, NEVER a
        // model pick). Order is decided by the declaration and the page, not by scoring;
        // completion truth stays the subgoal signal (红线③ untouched).
        let cmdPick: { cmd: CommandDecl; ref: string; index: number } | null = null;
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
            let r = hintMatch(target, elems);
            if (r === null && target !== "") {
              for (const [ref, e] of Object.entries(await hintLookup(pg, target))) {
                if (!scans.has(e.scan)) elems[ref] = e;
              }
              r = hintMatch(target, elems);
            }
            pruneForbids(elems);
            if (r !== null && !(r in forbidden)) { cmdPick = { cmd: c, ref: r, index: i }; break; }
            if (r === null) { pendingUnresolved.push(c.id); continue; }
            // resolved but forbidden: that command's action already ran or died — walk past it.
            cmdDone.add(c.id);
            cmdI = i + 1;
          }
          if (cmdPick === null) {
            if (cmdDone.size >= cmdSpace.length) {
              stop("action_space_exhausted",
                `commands exhausted (${cmdDone.size}/${cmdSpace.length} acted) but the done-signal never held on step ${stepNo}`, stepNo);
            } else {
              stop("space_empty",
                `command space matches nothing on this page — pending unresolved: `
                + `${pendingUnresolved.join(", ") || "-"} (unresolvable candidates are OUT; the space never falls back to the full pool) on step ${stepNo}`, stepNo);
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
            for (const [ref, e] of Object.entries(await hintLookup(pg, curHint))) {
              if (!new Set(Object.values(elems).map((x) => x.scan)).has(e.scan)) elems[ref] = e;
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
        const commandMode = cmdSpace.length > 0;
        // resolve the picked command's parameter binding NOW (fill/select). A missing
        // declared binding is a STRUCTURED `needs_value` stop, never a guess (红线②):
        // the value's only source is the plan's data bag, named by `value.key`.
        let commandValue: unknown;
        let commandByValue = false;
        let commandBindMissing: string | null = null;
        if (commandMode && cmdPick && (cmdPick.cmd.op === "fill" || cmdPick.cmd.op === "select")) {
          // P3: an `option` source is an OBSERVATION at bind time — read this page's
          // candidate list now (never assumed, never remembered from another run).
          let boundOptions: OptionCandidate[] | undefined;
          if (cmdPick.cmd.value?.from === "option") {
            const boundEl = elems[cmdPick.ref];
            boundOptions = boundEl ? await this._optionCandidates(pg, boundEl) : [];
          }
          const rv = resolveCommandValue(cmdPick.cmd, slots, { options: boundOptions });
          if (!rv.ok) commandBindMissing = rv.reason;
          else {
            commandValue = rv.value;
            // 声明式候选是按**值**解出来的，执行也按值选：label 优先的探测既白付 1.5 s，
            // 又可能选中"标签恰好等于我们要的机器值"的另一个 option。今天的启发式路径
            // （没有绑定）一字不动，仍走 label→value 两候选回退。
            commandByValue = cmdPick.cmd.value?.from === "option";
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
          ruleRef = curHint
            ? affordanceRule(instruction, elems, curHint)
            : (navRule(instruction, elems) ?? affordanceRule(instruction, elems, null));
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
        let method = "laya";
        let layaMargin: number | null = null;      // C3-R top-two margin (diagnostic)
        let tierAsk: { n: number; tier: number } | null = null;   // P1 diagnostic: the narrowed question
        if (ruleRef && !(ruleRef in forbidden)) {
          ref = ruleRef;
          conf = 1.0;
          method = "rule:match";
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
          let askPool = elems;
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
          if (askPool !== elems && (picked === null || pconf < this.confFloor)) {
            // narrowed ask abstained: today's full-pool ask still gets its turn
            if (verbose) console.log(`  step ${stepNo}: tiered hint (${tierAsk!.n} candidates) abstained -> full pool`);
            tierAsk = null;
            [picked, pconf, pprobs] = await this.pickElement(
              instruction, pg, elems, forbiddenSet, noted);
          }
          ref = picked;
          conf = pconf;
          method = "laya";
          layaMargin = topTwoMargin(pprobs);
        }
        if (ref === null) {
          // In rules-only mode a null ref usually means "no runtime to ask", which is not
          // the same failure as "every element is forbidden" — say which one it is.
          if (this.rulesOnly) {
            stop("no_model_runtime",
              `no model runtime: this step needs a model pick (rules-only mode) on step ${stepNo}`, stepNo);
          } else {
            stop("action_space_exhausted", `action space exhausted on step ${stepNo}`, stepNo);
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
              `no model runtime: this step needs a model pick (rules-only mode) on step ${stepNo}`, stepNo);
            if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
            break;
          } else if (Object.keys(forbidden).length >= Math.max(0, Object.keys(elems).length - 1)) {
            stop("action_space_exhausted",
              `action space exhausted (${Object.keys(forbidden).length} forbidden) on step ${stepNo}`, stepNo);
            break;
          } else {
            // OBSERVATION-BOTTLENECK RECOVERY (browser-use's "the button is there, we
            // just failed to show it"): the pool is the model's entire world, so a
            // target that never entered it cannot be chosen no matter how good the
            // model is. Take ONE wider look and re-ask before blocking the subgoal.
            // Only the way to stopping pays for the extra scan; the pick is recorded
            // as `laya:reobserve` so a widened step is visible in the trace/audit.
            let recovered = false;
            if (reobserve && !reobserved && ref !== null) {
              reobserved = true;
              const wide = await extractElements(pg, true, WIDER_ELEMENTS);
              if (Object.keys(wide).length > Object.keys(elems).length) {
                // refs are positional: re-prune forbids whose ref now names a
                // different element before re-asking (same rule as the step head).
                pruneForbids(wide);
                const [ref2, conf2] = await this.pickElement(
                  instruction, pg, wide, new Set(Object.keys(forbidden)), noted);
                // The wider view BECOMES the step's view even when the local model
                // stays unsure: a stronger reasoner (escalation) must be able to see
                // what the wider look already found, or widening would be pointless.
                // (Measured: the escalator was handed the 40-element narrow view and
                // the target was still invisible to it.)
                elems = wide;
                if (ref2 !== null && conf2 >= floor) {
                  ref = ref2;
                  conf = conf2;
                  method = "laya:reobserve";
                  recovered = true;
                  if (verbose) {
                    console.log(`  step ${stepNo}: re-observed wider `
                      + `(${Object.keys(wide).length} elements) -> ${ref} conf=${conf2.toFixed(2)}`);
                  }
                } else if (verbose) {
                  console.log(`  step ${stepNo}: re-observed wider `
                    + `(${Object.keys(wide).length} elements) -> still below floor`);
                }
              }
            }
            // ESCALATION (C3-R's deliberative path): a stronger reasoner may still
            // name one of the elements the harness showed. It is a picker, not a
            // planner — an answer that is not a ref from THIS view is rejected, so
            // nothing it says can invent an element, a value or an action.
            if (!recovered && escalateFn && !escalated) {
              escalated = true;
              const crit = criteriaView(elems, new Set(Object.keys(forbidden)),
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
              stop("low_confidence",
                `low confidence ${conf.toFixed(2)} < floor ${floor.toFixed(2)} on step ${stepNo}`, stepNo);
              break;
            }
          }
        }
        const el = elems[ref]!;
        const verb = this._isTyping(el) ? "type text into" : "click";
        const desc = `${verb} ${el.tag} "${el.label}"`;
        // DRY RUN stops HERE: the target is resolved (rule hint / local model /
        // re-observe / escalate) and probed, and nothing on the page is touched —
        // the pre-fill guard below and `occludedReason` (which clicks) are never
        // reached. The caller gets "what WOULD happen" as evidence.
        if (dryRun) {
          const probe = await this.dryRunProbe(pg, el);
          dryRan = true;
          if (probe.actionable) {
            stop("dry_run", `dry-run: would ${desc} (${method}, conf=${conf.toFixed(2)})`, stepNo);
          } else {
            stop("dry_run_not_actionable",
              `dry-run: target not actionable (${probe.reason ?? "unknown"})`, stepNo);
          }
          trace.push({
            step: stepNo, desc, method, conf: round3(conf), executed: false,
            dry_run: true, actionable: probe.actionable,
            ...(probe.reason === null ? {} : { reason: probe.reason }),
            would: `${el.tag} "${el.label}"`, url: urlOf(pg),
          });
          if (verbose) {
            console.log(`  step ${stepNo}: DRY-RUN `
              + (probe.actionable ? `would ${desc}` : `not actionable (${probe.reason ?? "unknown"})`));
          }
          break;
        }
        // P2: a fill/select whose DECLARED binding has no value stops here — honestly,
        // structurally, and never with a guessed value. (The substring-heuristic path
        // below is the old behaviour; a command space replaces guessing with binding.)
        if (commandMode && commandBindMissing !== null) {
          trace.push({ step: stepNo, desc, how: "needs_value", executed: false, method, conf: 1.0, command: cmdPick!.cmd.id, url: urlOf(pg) });
          stop("needs_value",
            `command ${JSON.stringify(cmdPick!.cmd.id)}: ${commandBindMissing} `
            + `— a declared binding either has its value in the plan or the step stops (红线②: never guessed) on step ${stepNo}`, stepNo);
          if (verbose) console.log(`  step ${stepNo}: ${stopReason}`);
          break;
        }
        // Pre-fill guard: a click whose form has empty fields that the plan's
        // slots can supply would die in HTML5 validation or JS checks — an inert
        // click and a wasted step. Values come from the plan, never the model.
        if (!this._isTyping(el)) {
          // Pre-fill before ANY click, including clicks on a submit-type input.
          for (const pe of await this._missingRequired(pg, slots, elems)) {
            const [phow] = await this._executeElement(pg, pe, slots);
            if (verbose) console.log(`  step ${stepNo}.pre: fill required ${JSON.stringify(pe.label)} -> ${phow}`);
          }
        } else if (method === "rule:match" && !commandMode) {
          // A rule-picked field with no slot value cannot be filled; forbid it so
          // the next step goes to laya instead of burning the subgoal on
          // needs_value. Submit-type inputs are the exception: they are CLICKED,
          // never filled.
          if (this._slotValue(el, slots) === null && !this._isSubmit(el)) {
            forbid(ref, el, "needs_value");
            trace.push({ step: stepNo, desc, how: "needs_value", executed: false, method, conf: round3(conf), url: urlOf(pg) });
            if (verbose) console.log(`  step ${stepNo}: (needs_value, rule) -> skip ${ref}`);
            continue;
          }
        }
        // §4：可逆性是**声明**，不该靠关键词猜。写了 effect.irreversible 就以它为准
        // （true ⇒ 一定问人；false ⇒ 这一步非破坏性，跳过一次模型前向，省下 W1 要省的那笔钱）。
        // 没写就完全走今天的路径：关键词 + 模型票。
        let risky: boolean, riskP: number;
        if (effect?.irreversible !== undefined) {
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
            trace.push({ step: stepNo, desc, risky: true, executed: false, confirmed: false, url: urlOf(pg) });
            continue;
          }
        }
        const pre = await this.snapshot(pg);
        // Click path goes through the actionability probe: a free element is
        // clicked inside it ("__clicked__"); a covered/slow one costs 0.8 s and
        // reports why, instead of burning 5 s + an inert step.
        let how: string | null = null;
        let arg: unknown = null;
        if (!this._isTyping(el)) {
          const reason = await this.occludedReason(pg, el);
          if (reason === "__clicked__") {
            try {
              await pg.waitForLoadState("domcontentloaded", { timeout: 3000 });
            } catch {
              /* nothing to wait for */
            }
            how = "clicked";
            arg = null;
          } else if (reason) {
            forbid(ref, el, reason);
            if (reason.startsWith("not-actionable-or-covered") && !reAdmitted.has(ref)) {
              blockedRetry[ref] = [stepNo, trace.length];
            }
            trace.push({ step: stepNo, desc, how: reason, executed: false, method, conf: round3(conf), url: urlOf(pg) });
            if (verbose) console.log(`  step ${stepNo}: (${reason}, ${method}) -> skip ${ref}`);
            continue;
          }
        }
        if (how === null) {
          // Submit-type inputs carry their label in `value` and must be clicked,
          // never filled — `_executeElement`'s input branch would return
          // needs_value otherwise.
          if (!this._isTyping(el)) {
            [how, arg] = await this._clickOnly(pg, el);
          } else {
            [how, arg] = await this._executeElement(pg, el, slots,
              commandMode ? { value: commandValue, byValue: commandByValue } : null);
          }
        }
        const executed = how === "clicked" || how === "filled";
        if (!executed) {
          // needs_value / stale_ref: this element cannot advance the plan right
          // now; forbid and try another (no model call).
          forbid(ref, el, String(how));
          trace.push({
            step: stepNo, desc: `click ${el.tag} "${el.label}"`, how,
            executed: false, method, conf: round3(conf),
            ...(cmdPick ? { command: cmdPick.cmd.id } : {}),
            url: urlOf(pg),
          });
          if (verbose) console.log(`  step ${stepNo}: (${how}, ${method}) -> skip ${ref}`);
          continue;
        }
        const post = await this.snapshot(pg);
        const inert = JSON.stringify(pre) === JSON.stringify(post);   // url+text+input-values all identical
        // P2: an executed command is ACTED whether or not the page moved — the walk
        // must not re-drive the same command next step (its element is forbidden on
        // inert anyway, but the closed set advances by the command's identity, not the
        // element's). `executed && !inert` also advances `target_hints` below.
        if (executed && cmdPick) {
          cmdDone.add(cmdPick.cmd.id);
          cmdI = cmdPick.index + 1;
        }
        trace.push({
          step: stepNo, desc, how, value: redactValue(el, arg), risky, executed, confirmed, method,
          conf: round3(conf), ...(cmdPick ? { command: cmdPick.cmd.id } : {}),
          ...(method.startsWith("laya") && layaMargin !== null
            ? { margin: Math.round(layaMargin * 1000) / 1000 } : {}),
          ...(method === "escalate" && escalatedPick ? { escalated: true } : {}),
          ...(prevented ? { prevented } : {}),
          ...(noted ? { noted: Object.keys(noted).length } : {}),
          ...(tierAsk ? { hint_tier: tierAsk } : {}),   // P1: this pick answered a NARROWED question
          inert, url: urlOf(pg),
        });
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

        if (executed && !inert && this._learnedHintApplied && method === "rule:match") {
          (hintMemory as HintMemoryLike | null)?.countUsed?.(1);
        }
        if (executed && !inert) this._advanceHint();
        if (goalSignalFn && (await goalSignalFn(pg))) {
          // A MODEL pick that actually advanced the subgoal is a hint we EARNED: record
          // it (stable handles only, via induceHint) so the next run of this exact url +
          // subgoal resolves by rule at zero model cost. Rule hits need no help.
          if (hintMemory && this._hintKey && (method.startsWith("laya") || method === "escalate")) {
            const learned = induceHint(el);
            if (learned) {
              hintMemory.record(this._hintKey, learned);
              if (verbose) console.log(`  step ${stepNo}: learned hint ${learned} for this page+subgoal`);
            }
          }
          done = true;
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
          for (let k = 0; k < SPA_SETTLE_POLLS; k++) {
            await sleep(SPA_SETTLE_MS);
            if (await goalSignalFn(pg)) {
              done = true;
              stop("dom_goal_signal", "dom goal signal", stepNo);
              if (verbose) {
                console.log(`  step ${stepNo}: -> done (dom goal signal, `
                  + `settled after ${(k + 1) * SPA_SETTLE_MS} ms)`);
              }
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
        // testpages/dead-target.html (50 ms tick): 8 clicks on the dead button, `max_steps`,
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
        if (inert) {
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
          if (method === "laya" || how === "filled") forbid(ref, el, "anti-repeat");
        }
      }
    } finally {
      // Only close the browser run() launched itself: an injected page/pw belongs
      // to the caller (PORT NOTE 5, Python's owns_browser/_stop_playwright_owned).
      if (browser !== null) await browser.close();
    }

    const verdict = (await this.auditor.audit(instruction, trace, done)) as AuditVerdict;
    return {
      goal: instruction, done, stop_reason: stopReason, steps: trace, audit: verdict,
      stop_code: stopCode,
      ...(stopStep !== undefined ? { stop_step: stopStep } : {}),
      ...(manualDone ? { manual: true } : {}),
      ...(dryRan ? { dry_run: true } : {}),
    };
  }
}
