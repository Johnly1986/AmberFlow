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
  hintMatch,
  navRule,
} from "./rules.ts";
import { checkSignal, type SignalSpec } from "./signals.ts";

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
  stop_reason: string;
  steps: TraceStep[];
  audit: AuditVerdictLike;
}

export interface RunOptions {
  /** DOM completion signal: `(page) => boolean`, async allowed. */
  goalSignalFn?: ((page: AnyPage) => boolean | Promise<boolean>) | null;
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
  gotoTimeout?: number;
  routeModels?: boolean;
  router?: RouterLike | null;
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

/** Every input's current value — inner_text misses fills, and values drive validation. */
const VALS_JS = `() => [...document.querySelectorAll('input,textarea,select')]
  .map(e => (e.name || e.id || e.getAttribute('data-test') || e.tagName) + '=' + e.value)
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

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function sigEq(a: Sig, b: Sig): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
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
export async function browserSession(headless = true): Promise<BrowserSession> {
  const mod = await import("playwright");
  const pw: PwLike = { chromium: mod.chromium as unknown as PwLike["chromium"] };
  const browser = (await browserEnv.launch(pw, headless)) as unknown as BrowserHandle;
  let page: AnyPage;
  try {
    page = (await browser.newPage()) as AnyPage;
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
  gotoTimeout: number;
  /** Deterministic rule prefilter ON, anti-repeat ON (measured production defaults). */
  rulesOn = true;
  antiRepeat = true;
  /** Frozen-plan disambiguation, set per run() from the plan's target_hint. */
  targetHint: string | null = null;
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
    this.gotoTimeout = opts.gotoTimeout ?? 30000;
  }

  /**
   * Build the resident checkpoint + the optional router ONCE (PORT NOTE 4 —
   * Python does this in `__init__`, which cannot await). Idempotent.
   */
  private async ready(): Promise<void> {
    if (this._ready) return;
    const rt = getLayaRuntime();
    if (this.agent === null) {
      this.agent = typeof this.modelId === "string" ? await rt.load(this.modelId) : this.modelId;
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
          if (this.router.attach && this.router.default) this.router.attach(this.router.default, this.agent);
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
    return this.targetHint;
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

  /** First rung of the pick ladder, then laya. Returns `[ref, conf, probabilities]`. */
  async pickElement(
    goal: string,
    page: AnyPage,
    elems: ElemPool,
    forbidden: Set<string>,
  ): Promise<[string | null, number, Record<string, number>]> {
    const crit = criteriaView(elems, forbidden, await ariaInteractiveLines(page));
    if (!Object.keys(crit).length) {
      // action space exhausted (every element forbidden/inert) — signal this
      // with conf 0 so the caller stops instead of crashing the runtime.
      return [null, 0.0, {}];
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
    const a = res.answers["act"] as ChoiceAnswer;
    // The shortlist re-normalises probabilities over its kept subset only: when
    // it dropped nothing (labels <= k), that renormalised value is NOT the
    // model's calibrated confidence — `predict_shortlist` hands back the
    // passthrough answer whose own `confidence` is. Trusting the subset one
    // inflated a 0.13 pick to 0.76 and let wrong clicks through the floor.
    const probs = a.probabilities ?? {};
    const sl = res.shortlist?.["act"] ?? {};
    if (sl.passthrough) return [a.choice, a.confidence, probs];
    // `confidence` is 1 - normalized entropy: with few options it collapses even
    // when the model is decisive. The argmax value against the runner-up is the
    // calibration-consistent gate signal here.
    const top = Math.max(...Object.values(probs));
    return [a.choice, top, probs];
  }

  /** Layered risk gate. Returns `[isRisky, probability]`. */
  async isRisky(goal: string, desc: string): Promise<[boolean, number]> {
    if (DESTRUCTIVE_PATTERNS.some((p) => desc.toLowerCase().includes(p))) return [true, 1.0];
    const state = { action: desc, user_goal: goal };
    const { agent } = await this.agentFor(state);
    const res = await agent.predict(state, {
      r: {
        type: "noul",
        instructions: "The user goal is given for context only. Judge ONLY the action itself: would performing it trigger an irreversible or externally-visible effect (payment, order placement, deletion, sending a message, final submission)? Typing text into a visible form field, opening pages, or navigating is NOT risky. {action} (context: {user_goal})",
      },
    });
    const p = (res.answers["r"] as NoulAnswer).noul;
    // 0.6 is the measured split; the constructor param used to be shadowed by a
    // literal in Python — now the param is live on both sides.
    return [p >= this.riskyThreshold, p];
  }

  /**
   * The base checkpoint's done-judgment is weak zero-shot and never grants
   * `done` here: DOM signals are the only truth (the caller decides).
   */
  async isDone(goal: string, page: AnyPage): Promise<number> {
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
    return (res.answers["d"] as NoulAnswer).noul;
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
  async occludedReason(page: AnyPage, el: Elem, probeMs = 800): Promise<string | null> {
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
        return "action-timeout";   // slow but unblocked: let the next step retry
      }
      return null;
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
    await firstLoc(loc).click({ timeout: 5000 });
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 });
    } catch {
      /* the page may never fire it; the action already happened */
    }
    return ["clicked", null];
  }

  /**
   * The action model: click / fill / select — with submit-type inputs clicked
   * (never filled: their `value` is the visible label) and `select` trying the
   * human label first with a SHORT timeout (a slot usually carries the machine
   * value, so the label probe is expected to miss and Playwright's 30 s default
   * would charge that miss to every select fill).
   */
  async _executeElement(page: AnyPage, el: Elem, slots: Record<string, unknown>): Promise<[string, unknown]> {
    const tag = el.tag;
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (this._isSubmit(el)) return this._clickOnly(page, el);
      const val = this._slotValue(el, slots);
      if (val === null || val === undefined) return ["needs_value", null];
      const loc = await this._locatorFor(page, el);
      if (loc === null) return ["stale_ref", null];
      if (tag === "select") {
        try {
          await firstLoc(loc).selectOption({ label: String(val) }, { timeout: 1500 });
        } catch {
          await firstLoc(loc).selectOption({ value: String(val) }, { timeout: 5000 });
        }
      } else {
        await firstLoc(loc).fill(String(val));
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
    } = opts;

    const slots: Record<string, unknown> = { ...extractSlots(instruction), ...(slotsIn ?? {}) };
    this.targetHints = (targetHints ?? []).filter((h) => !!h);
    this._hintI = 0;
    // A single hint keeps its old, whole-subgoal authority; a list hands
    // authority to currentHint() so it can walk the sequence.
    this.targetHint = this.targetHints.length ? null : targetHint;

    const trace: TraceStep[] = [];
    let done = false;
    let stopReason = "max_steps";
    const forbidden: Record<string, Sig> = {};                 // ref -> element signature (esig)
    // refs skipped ONLY because an overlay blocked them: retryable once the page
    // changes (the blocker may be gone); never counted as exhausted.
    const blockedRetry: Record<string, [number, number]> = {};  // ref -> (step, len(trace))
    const reAdmitted = new Set<string>();
    let page: AnyPage | null = pageIn;
    const ownsBrowser = page === null;
    let browser: BrowserHandle | null = null;

    try {
      await this.ready();
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
          stop_reason: "precondition not met -> skipped", steps: [],
          audit: { verdict: "SKIPPED", reasons: ["precondition not met"], auditor: "n/a" },
        };
      }

      for (let stepNo = 1; stepNo <= this.maxSteps; stepNo++) {
        const elems = await extractElements(pg);
        // A frozen plan that NAMES its target must never be blocked by the
        // extraction budget: retrieve the hinted element(s) into the pool when
        // they were evicted.
        const curHint = this.currentHint();
        if (curHint && hintMatch(curHint, elems) === null) {
          for (const [ref, e] of Object.entries(await hintLookup(pg, curHint))) {
            if (!new Set(Object.values(elems).map((x) => x.scan)).has(e.scan)) elems[ref] = e;
          }
        }
        // drop forbids whose ref now points at a different element
        for (const r of Object.keys(forbidden)) {
          const cur = elems[r];
          if (cur === undefined || !sigEq(forbidden[r]!, esig(cur))) {
            delete forbidden[r];
            delete blockedRetry[r];
            reAdmitted.delete(r);
          }
        }
        // A dead hint means "this action is done/failed" for an ordered
        // sequence: move to the next one instead of burning the subgoal.
        if (curHint) {
          const dead = hintMatch(curHint, elems);
          if (dead !== null && dead in forbidden) this._advanceHint();
        }
        let ruleRef: string | null = null;
        if (this.rulesOn) {
          ruleRef = navRule(instruction, elems) ?? affordanceRule(instruction, elems, curHint);
        }
        // re-admit refs whose only sin was being covered at an earlier step, but
        // ONLY after this subgoal actually executed something since the block
        // (the recovery click that removed the banner). Once per ref.
        for (const [br, [bStep, bCount]] of Object.entries(blockedRetry)) {
          if (elems[br] !== undefined && stepNo > bStep && trace.slice(bCount).some((t) => t.executed)) {
            delete forbidden[br];
            delete blockedRetry[br];
            reAdmitted.add(br);
          }
        }
        let ref: string | null = null;
        let conf = 0;
        let method = "laya";
        if (ruleRef && !(ruleRef in forbidden)) {
          ref = ruleRef;
          conf = 1.0;
          method = "rule:match";
        } else {
          // the rule's target is forbidden (inert or tried) -> fall through to
          // laya with the reduced action space instead of re-hitting a known-dead
          // element
          const [picked, pconf] = await this.pickElement(instruction, pg, elems, new Set(Object.keys(forbidden)));
          ref = picked;
          conf = pconf;
          method = "laya";
        }
        if (ref === null) {
          stopReason = `action space exhausted on step ${stepNo}`;
          break;
        }
        // PORT FIX: a model answer can name a ref that is no longer in THIS
        // step's pool (the screen changed between the scan and the pick, or the
        // answer is nonsense). The Python reference reads `elems[ref]` unguarded
        // and dies with a KeyError; stop the subgoal with a reason instead.
        if (elems[ref] === undefined) {
          stopReason = `picked ref '${ref}' is not in the element pool on step ${stepNo}`;
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
          } else if (Object.keys(forbidden).length >= Math.max(0, Object.keys(elems).length - 1)) {
            stopReason = `action space exhausted (${Object.keys(forbidden).length} forbidden) on step ${stepNo}`;
            break;
          } else {
            stopReason = `low confidence ${conf.toFixed(2)} < floor ${floor.toFixed(2)} on step ${stepNo}`;
            break;
          }
        }
        const el = elems[ref]!;
        const verb = this._isTyping(el) ? "type text into" : "click";
        const desc = `${verb} ${el.tag} "${el.label}"`;
        // Pre-fill guard: a click whose form has empty fields that the plan's
        // slots can supply would die in HTML5 validation or JS checks — an inert
        // click and a wasted step. Values come from the plan, never the model.
        if (!this._isTyping(el)) {
          // Pre-fill before ANY click, including clicks on a submit-type input.
          for (const pe of await this._missingRequired(pg, slots, elems)) {
            const [phow] = await this._executeElement(pg, pe, slots);
            if (verbose) console.log(`  step ${stepNo}.pre: fill required ${JSON.stringify(pe.label)} -> ${phow}`);
          }
        } else if (method === "rule:match") {
          // A rule-picked field with no slot value cannot be filled; forbid it so
          // the next step goes to laya instead of burning the subgoal on
          // needs_value. Submit-type inputs are the exception: they are CLICKED,
          // never filled.
          if (this._slotValue(el, slots) === null && !this._isSubmit(el)) {
            forbidden[ref] = esig(el);
            trace.push({ step: stepNo, desc, how: "needs_value", executed: false, method, conf: round3(conf), url: urlOf(pg) });
            if (verbose) console.log(`  step ${stepNo}: (needs_value, rule) -> skip ${ref}`);
            continue;
          }
        }
        const [risky, riskP] = await this.isRisky(instruction, desc);
        let confirmed = false;
        if (risky) {
          if (verbose) console.log(`  step ${stepNo}: RISKY ${desc} (p=${riskP.toFixed(2)}) -> asks for confirmation`);
          confirmed = await this.confirmFn(desc);
          if (!confirmed) {
            forbidden[ref] = esig(el);
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
            forbidden[ref] = esig(el);
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
            [how, arg] = await this._executeElement(pg, el, slots);
          }
        }
        const executed = how === "clicked" || how === "filled";
        if (!executed) {
          // needs_value / stale_ref: this element cannot advance the plan right
          // now; forbid and try another (no model call).
          forbidden[ref] = esig(el);
          trace.push({
            step: stepNo, desc: `click ${el.tag} "${el.label}"`, how,
            executed: false, method, conf: round3(conf), url: urlOf(pg),
          });
          if (verbose) console.log(`  step ${stepNo}: (${how}, ${method}) -> skip ${ref}`);
          continue;
        }
        const post = await this.snapshot(pg);
        const inert = JSON.stringify(pre) === JSON.stringify(post);   // url+text+input-values all identical
        trace.push({
          step: stepNo, desc, how, value: arg, risky, executed, confirmed, method,
          conf: round3(conf), inert, url: urlOf(pg),
        });
        if (verbose) {
          console.log(`  step ${stepNo}: ${desc} (${how}, ${method}, conf=${conf.toFixed(2)}${inert ? ", inert" : ""})`);
        }

        if (executed && !inert) this._advanceHint();
        if (goalSignalFn && (await goalSignalFn(pg))) {
          done = true;
          stopReason = "dom goal signal";
          break;
        }
        // DOM signals are the only truth, so the model's noul is consulted ONLY
        // when no DOM signal exists — and even then it never grants `done`, it
        // just stops the loop with an explicit "unverified" reason.
        if (goalSignalFn === null) {
          const doneP = await this.isDone(instruction, pg);
          if (doneP >= this.doneThreshold) {
            done = false;
            stopReason = `laya claims done (p=${doneP.toFixed(2)}) but no DOM signal to verify`;
            break;
          }
        }
        // Inert action on this element -> forbid it for the rest of the subgoal
        // regardless of method (this is what killed the Sign-in loops).
        if (inert) {
          forbidden[ref] = esig(el);
          continue;
        }
        if (this.antiRepeat) {
          // Forbid after a *semantic* (laya) pick that missed the signal, or
          // after any fill that did not advance it. Rule hits on clicks stay
          // exempt: two subgoals may legitimately drive the same button, and the
          // inert guard catches dead loops.
          if (method === "laya" || how === "filled") forbidden[ref] = esig(el);
        }
      }
    } finally {
      // Only close the browser run() launched itself: an injected page/pw belongs
      // to the caller (PORT NOTE 5, Python's owns_browser/_stop_playwright_owned).
      if (browser !== null) await browser.close();
    }

    const verdict = (await this.auditor.audit(instruction, trace, done)) as AuditVerdict;
    return { goal: instruction, done, stop_reason: stopReason, steps: trace, audit: verdict };
  }
}
