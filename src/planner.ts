/**
 * Plan runner — TS twin of the planner half of `layaapp/planner.py`.
 *
 * `run_plan` executes a frozen plan subgoal by subgoal in ONE browser session;
 * `runSubgoalWithRetries` is the single implementation of `retries` (a retry is
 * the WHOLE subgoal: fresh navigation, re-evaluated `when`, re-scanned pool);
 * `LLMPlanner` is the System-2 drafter whose prompt carries the executor's own
 * element rendering (`snapshotText`), because a hint written against any other
 * rendering could never match extraction.
 *
 * PORT FIX (Python audit H1): the reference `run_plan` prints a replan exception
 * and then reads `amended`, which is unbound on the FIRST exception — the run
 * dies with UnboundLocalError, exactly in the case the try/except exists for.
 * Here the exception leaves `amended = null` and the loop continues blocked;
 * `test_run_plan_replan_exception_does_not_kill_the_run` pins it.
 */
import { criteriaView, extractSlots, type ElemPool } from "./extraction.ts";
import { PlanningRules, TaskPlan, type Subgoal } from "./plan.ts";
import { checkSignal } from "./signals.ts";
import { browserSession, type BrowserSession, type RunOptions } from "./executor.ts";
import type { TraceStep } from "./audit.ts";

/* ------------------------------------------------------------------ snapshot */

/**
 * Model-facing rendering of the page's interactive elements, for the PLANNER.
 * Reuses `criteriaView` — the executor's own model-facing format — so the planner
 * writes signals and target_hints against EXACTLY the element space the executor
 * will see.
 */
export function snapshotText(elems: ElemPool, limit = 40): string {
  if (!elems || Object.keys(elems).length === 0) return "";
  return Object.values(criteriaView(elems, new Set(), null)).slice(0, limit).join("\n");
}

/* ------------------------------------------------------------------ planners */

export interface PlannerLike {
  makePlan?(goal: string, opts?: Record<string, unknown>): TaskPlan | Promise<TaskPlan>;
  replan(plan: TaskPlan, obstacle: Subgoal, rules?: PlanningRules | null): TaskPlan | Promise<TaskPlan>;
}

export class ScriptedPlanner implements PlannerLike {
  subgoals: Partial<Subgoal>[];

  constructor(subgoals: Partial<Subgoal>[]) {
    this.subgoals = subgoals;
  }

  makePlan(goal: string): TaskPlan {
    return new TaskPlan(goal, this.subgoals);
  }

  /** Scripted policy: returning the SAME plan tells runPlan "no amendment". */
  replan(plan: TaskPlan, _obstacle?: Subgoal, _rules?: PlanningRules | null): TaskPlan {
    return plan;
  }
}

export type ChatFn = (user: string, system: string) => Promise<Record<string, unknown>>;

export interface LLMPlannerOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeout?: number;
  /** Test seam: replace the HTTP call (defaults to the OpenAI-compatible fetch). */
  chatFn?: ChatFn;
}

export class LLMPlanner implements PlannerLike {
  static SYSTEM =
    "You decompose a browser-automation goal into 2-6 sequential subgoals. "
    + "Each subgoal must be verifiable from the page. Reply ONLY with JSON: "
    + '{"subgoals": [{"desc": "...", "signal": {"url_contains": "..."} | '
    + '{"css_exists": "..."} | {"css_text_contains": ["sel", "text"]} , '
    + '"start_url": null, "target_hint": "#id | tag[attr=value] | tag[near~token] | null}]}\n'
    + "When the user message lists the page's interactive elements, use exactly that "
    + "list to choose done-signals and to write each subgoal's target_hint; a hint is "
    + "resolved by rule at no model cost, so give one whenever the target is "
    + "unambiguous in that list.";

  baseUrl: string;
  apiKey: string;
  model: string;
  timeout: number;
  chatFn: ChatFn;

  constructor(opts: LLMPlannerOptions = {}) {
    const base = opts.baseUrl ?? process.env.OPENAI_BASE_URL;
    const key = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!base) throw new Error("LLMPlanner needs OPENAI_BASE_URL");
    if (!key) throw new Error("LLMPlanner needs OPENAI_API_KEY");
    this.baseUrl = base.replace(/\/+$/, "");
    this.apiKey = key;
    this.model = opts.model ?? process.env.PLANNER_MODEL ?? "gpt-4o-mini";
    this.timeout = opts.timeout ?? 30.0;
    this.chatFn = opts.chatFn ?? ((user, system) => this.httpChat(user, system));
  }

  private async httpChat(user: string, system: string): Promise<Record<string, unknown>> {
    const r = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model, temperature: 0,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(this.timeout * 1000),
    });
    if (!r.ok) throw new Error(`planner endpoint ${r.status}`);
    const body = (await r.json()) as { choices: Array<{ message: { content: string } }> };
    const c = body.choices[0]!.message.content;
    return JSON.parse(c.slice(c.indexOf("{"), c.lastIndexOf("}") + 1)) as Record<string, unknown>;
  }

  /** (system, user) for one planning call. Pure and offline-testable. */
  buildMessages(
    goal: string, rules: PlanningRules | null = null, startUrl?: string | null,
    elems?: ElemPool | null, extra?: Record<string, unknown> | null,
  ): [string, string] {
    const system = rules === null ? LLMPlanner.SYSTEM : `${LLMPlanner.SYSTEM}\n\n${rules.promptText()}`;
    let user = goal;
    if (startUrl) user += `\n\nstart_url: ${startUrl}`;
    if (elems) {
      user += "\n\nInteractive elements currently on the page "
        + "(rendered exactly as the executor sees them; use these for signals "
        + "and target_hints):\n" + snapshotText(elems);
    }
    if (extra) user += `\n\n${JSON.stringify(extra)}`;
    return [system, user];
  }

  async makePlan(
    goal: string, opts: { rules?: PlanningRules | null; startUrl?: string | null; elems?: ElemPool | null } = {},
  ): Promise<TaskPlan> {
    const rules = opts.rules ?? null;
    const [system, user] = this.buildMessages(goal, rules, opts.startUrl ?? null, opts.elems ?? null);
    const d = await this.chatFn(user, system);
    const plan = new TaskPlan(goal, (d.subgoals as Partial<Subgoal>[]) ?? []);
    if (rules) {
      const issues = rules.problems(plan);
      if (issues.length) throw new Error(`LLM plan violates planning rules:\n  ${issues.join("\n  ")}`);
    }
    return plan;
  }

  async replan(
    plan: TaskPlan, obstacle: Subgoal, rules: PlanningRules | null = null, elems?: ElemPool | null,
  ): Promise<TaskPlan> {
    const [system, user] = this.buildMessages(plan.goal, rules, null, elems ?? null,
      { plan_so_far: plan.subgoals, blocked_subgoal: obstacle });
    const d = await this.chatFn(user, system);
    const amended = new TaskPlan(plan.goal, (d.subgoals as Partial<Subgoal>[]) ?? []);
    amended.path = plan.path;
    if (rules) {
      const issues = rules.problems(amended);
      if (issues.length) throw new Error(`amended plan violates planning rules:\n  ${issues.join("\n  ")}`);
    }
    return amended;
  }
}

/* ------------------------------------------------------------------ runner */

export interface MiddlewareReport {
  done: boolean;
  skipped?: boolean;
  stop_reason: string;
  steps: TraceStep[];
  [k: string]: unknown;
}

export interface MiddlewareLike {
  run(instruction: string, startUrl: string, opts?: RunOptions): Promise<MiddlewareReport>;
  _planVerbose?: boolean;
}

/** ONE attempt at a subgoal, separated so a retry is a loop, not a copy. */
export async function runOnce(
  mw: MiddlewareLike, sg: Subgoal, plan: TaskPlan, url: string,
  page: unknown, pw: unknown,
): Promise<MiddlewareReport> {
  try {
    return await mw.run(sg.desc, url, {
      goalSignalFn: (p: unknown) => checkSignal(p as never, sg.signal),
      // precedence: plan.goal text < plan.slots < THIS subgoal's slots
      slots: { ...extractSlots(plan.goal), ...plan.slots, ...(sg.slots ?? {}) },
      page: page as never, pw: pw as never,
      targetHint: sg.target_hint ?? null,
      targetHints: sg.target_hints ?? null,
      precondition: sg.when ?? null,
      // `{manual: true}` on the subgoal's signal: no DOM fact can confirm this step,
      // so the executor asks the human (the middleware carries `manualConfirmFn`).
      manualGoal: isManualSignal(sg.signal),
      verbose: mw._planVerbose ?? true,
    });
  } catch (e) {
    return { done: false, steps: [], stop_reason: `error: ${e}` };
  }
}

/** Is this subgoal's completion a human attestation rather than a DOM fact? */
export function isManualSignal(signal: unknown): boolean {
  return Boolean(signal && typeof signal === "object" && "manual" in (signal as Record<string, unknown>));
}

/**
 * A subgoal may RETRY (`retries`) — and a retry is the WHOLE subgoal: each attempt
 * is a fresh navigation, the `when` guard is re-evaluated and the element pool is
 * re-scanned; only after the last attempt does the subgoal block.
 * Returns steps from EVERY attempt (failed attempts stay in the trace).
 */
export async function runSubgoalWithRetries(
  mw: MiddlewareLike, sg: Subgoal, plan: TaskPlan, url: string,
  page: unknown, pw: unknown, verbose = true,
): Promise<{ rep: MiddlewareReport; attempt: number; steps: TraceStep[] }> {
  const tries = Number(sg.retries ?? 0) + 1;
  let rep: MiddlewareReport = { done: false, steps: [], stop_reason: "no attempt" };
  let attempt = 0;
  const steps: TraceStep[] = [];
  // NOTE: the counter is explicit. A C-style `for (attempt = 1; ...; attempt++)`
  // leaves `attempt === tries + 1` after a normal exit (Python's `for ... in
  // range()` leaves the LAST tried value), which silently marks every subgoal as
  // "retried" and breaks the report string.
  for (let i = 1; i <= tries; i++) {
    attempt = i;
    rep = await runOnce(mw, sg, plan, url, page, pw);
    steps.push(...(rep.steps ?? []));
    if (rep.done) break;
    if (i < tries && verbose) {
      console.log(`    -> retry ${i}/${tries - 1}: ${rep.stop_reason}`);
    }
  }
  return { rep, attempt, steps };
}

export interface RunPlanOptions {
  startUrl?: string;
  replan?: boolean;
  planner?: PlannerLike | null;
  rules?: PlanningRules | null;
  maxReplans?: number;
  verbose?: boolean;
  /** Test seam: the session factory (defaults to the production `browserSession`). */
  sessionFactory?: () => Promise<BrowserSession>;
}

export interface RunPlanResult {
  plan: TaskPlan;
  traces: TraceStep[];
  replans: number;
  skipped: number;
  retried: number;
  completed: string;
}

/**
 * Execute a plan, subgoal by subgoal, in one browser session.
 *
 * Subgoal policies, all optional and all in the plan (never invented at runtime):
 * `when` (skip when it does not apply), `retries` (extra whole-step attempts),
 * per-subgoal `slots`. A subgoal still blocked after its retries keeps its
 * obstacle for the record and may trigger ONE amended plan (`maxReplans` caps it;
 * an amendment that adds nothing ends the loop immediately).
 */
export async function runPlan(
  mw: MiddlewareLike, plan: TaskPlan, opts: RunPlanOptions = {},
): Promise<RunPlanResult> {
  const { startUrl = "", replan = true, planner = null, rules = null,
          maxReplans = 2, verbose = true } = opts;
  const sessionFactory = opts.sessionFactory ?? (() => browserSession());

  plan.save();
  const traces: TraceStep[] = [];
  let replans = 0;
  const todo = plan.subgoals.filter((s) => !["done", "blocked", "skipped"].includes(String(s.status)));

  // Resume semantics: an already-finished plan must not even open a browser.
  if (todo.length) {
    mw._planVerbose = verbose;
    const session = await sessionFactory();
    try {
      while (todo.length) {
        const sg = todo.shift()!;
        sg.status = "doing";
        plan.save();
        if (verbose) console.log(`  [subgoal] ${sg.desc}`);
        const url = sg.start_url ?? startUrl;
        const { rep, attempt, steps } = await runSubgoalWithRetries(
          mw, sg, plan, url, session.page, session.pw, verbose);
        traces.push(...steps);
        sg.attempts = attempt;
        if (rep.done) {
          // a skipped subgoal is FINISHED, not pending: resume must not retry a
          // conditional step that did not apply
          sg.status = rep.skipped ? "skipped" : "done";
          if (verbose) console.log(`    -> ${rep.skipped ? "skipped" : "done"} (${rep.stop_reason})`);
          plan.save();
          continue;
        }
        sg.status = "blocked";
        sg.obstacle = rep.stop_reason;
        if (verbose) console.log(`    -> BLOCKED after ${attempt} attempt(s): ${rep.stop_reason}`);
        plan.save();
        if (!(replan && planner) || replans >= maxReplans) continue;
        let amended: TaskPlan | null = null;
        try {
          amended = await planner.replan(plan, sg, rules);
        } catch (e) {
          // A bad LLM reply must not kill the run -- and must never be silent:
          // a swallowed planner error looks exactly like "nothing to add".
          console.log(`    -> replan FAILED (${(e as Error).name}: ${(e as Error).message}); continuing blocked`);
          amended = null;                       // PORT FIX H1 (Python crashes here)
        }
        if (amended === null || amended === plan) continue;   // no-op planner
        const known = new Set(plan.subgoals.map((x) => x.desc));
        const before = plan.subgoals.length;
        for (const s of amended.subgoals ?? []) {
          if (known.has(s.desc)) continue;       // never re-queue known work
          known.add(s.desc);
          plan.insert(plan.subgoals.length, s.desc, s.signal, s.start_url ?? null,
            s.target_hint ?? null, s.target_hints ?? null, s.slots ?? null,
            s.when ?? null, s.retries ?? null);  // the port carries when/retries too
        }
        const added = plan.subgoals.length - before;
        replans += 1;
        if (verbose) console.log(`    -> replan #${replans}: +${added} subgoal(s)`);
        plan.save();
        if (added) todo.push(...plan.subgoals.slice(before));
      }
    } finally {
      await session.close();
    }
  }

  const doneN = plan.subgoals.filter((s) => s.status === "done").length;
  const skippedN = plan.subgoals.filter((s) => s.status === "skipped").length;
  const retriedN = plan.subgoals.filter((s) => Number(s.attempts ?? 1) > 1).length;
  return {
    plan, traces, replans, skipped: skippedN, retried: retriedN,
    completed: `${doneN}/${plan.subgoals.length}`
      + (skippedN ? ` (+${skippedN} skipped)` : "")
      + (retriedN ? ` (${retriedN} retried)` : ""),
  };
}
