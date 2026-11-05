/**
 * Plan runner — TS twin of the planner half of `layaapp/planner.py`.
 *
 * `run_plan` executes a frozen plan subgoal by subgoal in ONE browser session;
 * `runSubgoalWithRetries` is the single implementation of `retries` (a retry is
 * the WHOLE subgoal: fresh navigation, re-evaluated `when`, re-scanned pool).
 *
 * 规划归 Agent（2026-11 前提）：引擎内没有 LLM 规划/重规划面——计划由人/Agent 给出
 * （TaskPlan JSON 或 app.mjs），本模块只执行冻结计划。原 `LLMPlanner`（System-2 起草）
 * 与裸读 `OPENAI_*` 的 `llmEscalator` 已移除；低置信恢复的 escalation 梯级走 provider 缝
 * （`src/model/provider-escalator.ts`，经 `DecisionProvider.askChoice` 闭集窄问）。
 *
 * PORT FIX (Python audit H1): the reference `run_plan` prints a replan exception
 * and then reads `amended`, which is unbound on the FIRST exception — the run
 * dies with UnboundLocalError, exactly in the case the try/except exists for.
 * Here the exception leaves `amended = null` and the loop continues blocked;
 * `test_run_plan_replan_exception_does_not_kill_the_run` pins it.
 */
import { extractSlots } from "./extraction.ts";
import { PlanningRules, TaskPlan, type Subgoal } from "./plan.ts";
import { checkSignal } from "./signals.ts";
import { browserSession, type BrowserSession, type RunOptions } from "./executor.ts";
import type { TraceStep } from "./audit.ts";
// B1 节奏统一（engine → support，无环）：规划脸节奏 = env-only——规划脸没有 pack/meta，
// `meta.pace` 是应用脸专属；间距语义（start-to-start ≥ gap）与 env 口径与另外两脸同源。
import { envPace, newPaceClock, paceBeforeUnit, type PaceClock } from "../support/pace.ts";

/* ------------------------------------------------------------------ planners */

export interface PlannerLike {
  makePlan?(goal: string, opts?: Record<string, unknown>): TaskPlan | Promise<TaskPlan>;
  replan(plan: TaskPlan, obstacle: Subgoal, rules?: PlanningRules | null): TaskPlan | Promise<TaskPlan>;
}

/**
 * The deliberative rung — MOVED (2026-11): escalation now goes through the provider
 * seam via `DecisionProvider.askChoice`; see `src/model/provider-escalator.ts`.
 * The old `llmEscalator` (raw `OPENAI_*` reads, hardcoded `/chat/completions`) is gone.
 */

/* ------------------------------------------------------------------ runner */

export interface MiddlewareReport {
  done: boolean;
  skipped?: boolean;
  stop_reason: string;
  /** Structured stop cause (the executor's `StopCode`); absent for hand-made reports. */
  stop_code?: string;
  steps: TraceStep[];
  [k: string]: unknown;
}

/**
 * Stops that a retry CANNOT fix :
 * `config_error` re-runs the same broken path, `host_not_allowed` re-walks into the
 * same undeclared host, and a command-mode `needs_value` re-reads the same plan
 * data bag — all three say the identical sentence on every attempt, each attempt
 * with its own side effects. (Measured: a bad artifact path ran the data leg AND
 * the first tool step, then repeated the config error two more times.)
 */
export const NEVER_RETRY_CODES: ReadonlySet<string> = new Set([
  "config_error", "host_not_allowed", "needs_value",
  // S2 ③：提名指令收窄后本页没有该族候选——同一页重试 N 次也是同一个空集。
  "nominated_family_empty",
]);

export interface MiddlewareLike {
  run(instruction: string, startUrl: string, opts?: RunOptions): Promise<MiddlewareReport>;
  _planVerbose?: boolean;
}

/** ONE attempt at a subgoal, separated so a retry is a loop, not a copy. */
export async function runOnce(
  mw: MiddlewareLike, sg: Subgoal, plan: TaskPlan, url: string,
  page: unknown, pw: unknown,
  /** S2 ③ 运行期接线等需要的**本次运行附加选项**（缺省空 = 既有行为逐字节不变）。 */
  extra: Partial<RunOptions> = {},
): Promise<MiddlewareReport> {
  try {
    return await mw.run(sg.desc, url, {
      goalSignalFn: (p: unknown) => checkSignal(p as never, sg.signal),
      // precedence: plan.goal text < plan.slots < THIS subgoal's slots
      slots: { ...extractSlots(plan.goal), ...plan.slots, ...(sg.slots ?? {}) },
      page: page as never, pw: pw as never,
      targetHint: sg.target_hint ?? null,
      targetHints: sg.target_hints ?? null,
      // P2: the step's command space (absent ⇒ the loop acts exactly like today).
      commands: (sg.commands as never) ?? null,
      // §4: the step's declared reversibility (absent ⇒ the gate falls back to
      // keyword + model vote, i.e. exactly today's behavior).
      effect: sg.effect ?? undefined,
      // A2′: the step declared "wrong = wasted" (load-time checked to REQUIRE
      // effect.irreversible=false + a decidable signal). Absent ⇒ low conf blocks.
      adjudicate: (sg as Record<string, unknown>).adjudicate === true,
      precondition: sg.when ?? null,
      // `{manual: true}` on the subgoal's signal: no DOM fact can confirm this step,
      // so the executor asks the human (the middleware carries `manualConfirmFn`).
      manualGoal: isManualSignal(sg.signal),
      verbose: mw._planVerbose ?? true,
      ...extra,
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
  /** 透传给 `mw.run` 的附加 RunOptions（S2 ③：收窄元素池等；缺省空 = 既有行为不变）。 */
  extra: Partial<RunOptions> = {},
  /**
   * B1 节奏时钟（env-only 规划脸）：调用方创建并**跨子目标共享**（单元 = attempt），
   * 缺省 = 0 间距的 no-op 时钟——既有调用（声明式 runWebStep 等）零感知。
   */
  paceClock: PaceClock = newPaceClock(0),
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
    // B1：重试之间的最小间距（与子目标间距同值同源 = envPace().between_steps_ms）；
    // start-to-start ≥ gap——上一个 attempt 耗时长则不补等。首个 attempt 之前不等
    // （子目标级的间距由调用方循环的 paceBeforeUnit 负责），这里只记录本 attempt 的开始时刻。
    if (i > 1) {
      await paceBeforeUnit(paceClock, verbose
        ? (w) => console.log(
            `    -> pace: ${w}ms before retry ${i - 1}/${tries - 1} `
            + `(min start-to-start gap ${paceClock.gapMs}ms)`)
        : undefined);
    } else if (paceClock.gapMs > 0) {
      paceClock.lastStart = Date.now();
    }
    rep = await runOnce(mw, sg, plan, url, page, pw, extra);
    steps.push(...(rep.steps ?? []));
    if (rep.done) break;
    // D6: a config-class stop is NOT transient. `retries` exists for cold loads and
    // hydration races — the whole subgoal re-running is the point there. Re-running
    // a broken artifact path or an undeclared host is the same refusal N more times,
    // with N more navigations of side effects. Stop after the first honest one.
    if (rep.stop_code && NEVER_RETRY_CODES.has(rep.stop_code)) {
      if (verbose && tries > 1) {
        console.log(`    -> not retried (${rep.stop_code}: a config-class stop is the same on every attempt)`);
      }
      break;
    }
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

  // P4 声明式后继只在**应用旅程**这一层落地（`app-runner` 的走步循环按步 id 走，
  // 上界与环检测由 `plan.createPathWalk` 提供）。计划级 runner 用的是 resume 队列
  // （"下一个未完成的子目标"），与"按声明的边往哪走"是两套语义——**静默忽略一条边**
  // 是最坏的选项（作者以为写了分支，实际什么都没发生），所以这里响亮拒绝、零副作用。
  const withEdges = plan.subgoals.filter((s) => (s.next ?? []).length > 0);
  if (withEdges.length) {
    throw new Error(
      `runPlan cannot honour \`next\` edges (${withEdges.length} subgoal(s) declare them: `
      + `${withEdges.map((s) => JSON.stringify(String(s.id ?? s.desc))).join(", ")}). `
      + "Declarative successors are driven by the app flow script "
      + "(`npm run apps -- --app <id>`, apps/<id>/app.mjs); move the branch there or drop the edges "
      + "— a silently ignored edge would look like a plan that ran.",
    );
  }

  plan.save();
  const traces: TraceStep[] = [];
  let replans = 0;
  const todo = plan.subgoals.filter((s) => !["done", "blocked", "skipped"].includes(String(s.status)));

  // Resume semantics: an already-finished plan must not even open a browser.
  if (todo.length) {
    mw._planVerbose = verbose;
    // B1 节奏（env-only）：子目标之间按 `AMBERFLOW_STEP_DELAY_MS` 的**最小步间距**等待
    // （start-to-start ≥ gap；首个子目标之前不等）；重试之间同值同源（见
    // runSubgoalWithRetries 的 paceClock）。坏 env 值在这里响亮报错（开浏览器之前）。
    const paceEnv = envPace(process.env);
    const paceClock = newPaceClock(paceEnv.between_steps_ms ?? 0);
    const paceActionsMs = paceEnv.between_actions_ms ?? 0;
    const paceSrc = (provided: boolean): string => (provided ? "env" : "default");
    if (verbose && (paceClock.gapMs > 0 || paceActionsMs > 0)) {
      console.log(`  [pace] between_steps=${paceClock.gapMs}ms(${paceSrc(paceEnv.between_steps_ms !== undefined)})`
        + ` between_actions=${paceActionsMs}ms(${paceSrc(paceEnv.between_actions_ms !== undefined)})`);
    }
    const session = await sessionFactory();
    try {
      while (todo.length) {
        const sg = todo.shift()!;
        await paceBeforeUnit(paceClock, (w) =>
          console.log(`  [pace] ${w}ms before subgoal ${JSON.stringify(String(sg.id ?? sg.desc))}`
            + ` (min start-to-start gap ${paceClock.gapMs}ms)`));
        sg.status = "doing";
        plan.save();
        if (verbose) console.log(`  [subgoal] ${sg.desc}`);
        const url = sg.start_url ?? startUrl;
        const { rep, attempt, steps } = await runSubgoalWithRetries(
          mw, sg, plan, url, session.page, session.pw, verbose, {}, paceClock);
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
          // 入口那道守卫只看**初始**计划；一次 replan 补丁是运行期新增的结构，必须同样过闸。
          // 这里是"响亮地不采纳"而不是"静默忽略"：与 replan 异常同一条纪律——吞掉的错误
          // 与"没有补充"长得一模一样。
          const edges = (s.next ?? []).filter((x) => !!x);
          if (edges.length) {
            console.log(`    -> replan amendment ${JSON.stringify(s.id ?? s.desc)} declares \`next\` `
              + `(${edges.join(", ")}), which runPlan cannot honour — the edges are dropped, `
              + `the subgoal is kept`);
          }
          plan.insert(plan.subgoals.length, s.desc, s.signal, s.start_url ?? null,
            s.target_hint ?? null, s.target_hints ?? null, s.slots ?? null,
            s.when ?? null, s.retries ?? null, s.commands ?? null,
            { id: s.id ?? null, next: edges.length ? null : (s.next ?? null) });
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
