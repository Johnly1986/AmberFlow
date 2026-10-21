/**
 * Plan-runner tests — ported from `test_middleware.py`'s run_plan suite, plus the
 * port's H1 fix (a replan exception must not kill the run; the Python reference
 * dies with UnboundLocalError there).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlanningRules, TaskPlan, type Subgoal } from "../src/engine/plan.ts";
import {
  LLMPlanner, ScriptedPlanner, runPlan, runSubgoalWithRetries, snapshotText,
  type MiddlewareLike, type MiddlewareReport,
} from "../src/engine/planner.ts";
import type { BrowserSession } from "../src/engine/executor.ts";
import type { ElemPool } from "../src/engine/extraction.ts";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "layaplan-"));
});

/** Fake session: the subgoal policy is what is under test, not the browser. */
function fakeSession(counter: { opened: number }): () => Promise<BrowserSession> {
  return async () => {
    counter.opened += 1;
    return { pw: "PW", page: "PAGE", browser: {}, close: async () => {} } as unknown as BrowserSession;
  };
}

interface Call {
  desc: string; page: unknown; pw: unknown; targetHint: unknown; targetHints: unknown;
  slots: Record<string, unknown> | null | undefined; precondition: unknown;
}

class FakeMW implements MiddlewareLike {
  calls: Call[] = [];
  _planVerbose = false;
  decide: (desc: string, n: number) => MiddlewareReport;
  constructor(decide: (desc: string, n: number) => MiddlewareReport) { this.decide = decide; }
  async run(desc: string, _url: string, opts: any = {}): Promise<MiddlewareReport> {
    this.calls.push({
      desc, page: opts.page, pw: opts.pw, targetHint: opts.targetHint,
      targetHints: opts.targetHints, slots: opts.slots, precondition: opts.precondition,
    });
    return this.decide(desc, this.calls.length);
  }
}

const DONE = (reason = "dom goal signal"): MiddlewareReport => ({ done: true, steps: [], stop_reason: reason });
const STUCK = (reason = "stuck"): MiddlewareReport => ({ done: false, steps: [], stop_reason: reason });

describe("runPlan — one session, plan policies", () => {
  it("shares one browser session across subgoals and carries target_hint", async () => {
    const counter = { opened: 0 };
    const mw = new FakeMW(() => DONE());
    const plan = new TaskPlan("g", [
      { desc: "a", signal: { url_contains: "x" }, target_hint: "h1" },
      { desc: "b", signal: { url_contains: "y" } },
    ], path.join(tmp, "p.json"));
    const rep = await runPlan(mw, plan, { startUrl: "u", verbose: false, sessionFactory: fakeSession(counter) });

    expect(rep.completed).toBe("2/2");
    expect(counter.opened).toBe(1);                                  // ONE session, not N
    expect(mw.calls.map((c) => c.page)).toEqual(["PAGE", "PAGE"]);
    expect(mw.calls.map((c) => c.pw)).toEqual(["PW", "PW"]);
    expect(mw.calls[0]!.targetHint).toBe("h1");
    expect(mw.calls[1]!.targetHint).toBeNull();
  });

  it("retries a transient failure (whole subgoal) and counts it", async () => {
    const counter = { opened: 0 };
    const mw = new FakeMW((_d, n) => (n === 1 ? STUCK("cold load") : DONE()));
    const plan = new TaskPlan("g", [
      { desc: "a", signal: { css_exists: "#a" }, retries: 2 },
    ], path.join(tmp, "p.json"));
    const rep = await runPlan(mw, plan, { startUrl: "u", verbose: false, sessionFactory: fakeSession(counter) });

    expect(mw.calls).toHaveLength(2);
    expect(rep.completed).toBe("1/1 (1 retried)");
    expect(plan.subgoals[0]!.attempts).toBe(2);
  });

  it("blocks a subgoal only after its retries are exhausted", async () => {
    const counter = { opened: 0 };
    const mw = new FakeMW(() => STUCK("cold load"));
    const plan = new TaskPlan("g", [
      { desc: "a", signal: { css_exists: "#a" }, retries: 2 },
    ], path.join(tmp, "p.json"));
    const rep = await runPlan(mw, plan, { startUrl: "u", verbose: false, sessionFactory: fakeSession(counter) });

    expect(mw.calls).toHaveLength(3);
    expect(rep.completed).toBe("0/1 (1 retried)");   // three attempts = one retried subgoal
    expect(plan.subgoals[0]!.status).toBe("blocked");
    expect(plan.subgoals[0]!.obstacle).toBe("cold load");
  });

  it("records a skipped subgoal as finished and resumes without retrying it", async () => {
    const counter = { opened: 0 };
    const mw = new FakeMW(() => ({ done: true, skipped: true, steps: [], stop_reason: "precondition not met" }));
    const plan = new TaskPlan("g", [{ desc: "dismiss", signal: { css_exists: "#gone" }, when: { css_exists: ".overlay" } }],
      path.join(tmp, "p.json"));
    const rep = await runPlan(mw, plan, { startUrl: "u", verbose: false, sessionFactory: fakeSession(counter) });
    expect(rep.completed).toBe("0/1 (+1 skipped)");
    expect(plan.subgoals[0]!.status).toBe("skipped");

    // resume: nothing pending -> the browser must not even open
    const counter2 = { opened: 0 };
    const mw2 = new FakeMW(() => DONE());
    const rep2 = await runPlan(mw2, plan, { startUrl: "u", verbose: false, sessionFactory: fakeSession(counter2) });
    expect(counter2.opened).toBe(0);
    expect(rep2.completed).toBe("0/1 (+1 skipped)");
  });

  it("merges plan slots with the subgoal bag and passes precondition/hints through", async () => {
    const counter = { opened: 0 };
    const mw = new FakeMW(() => DONE());
    const plan = new TaskPlan("g", [{
      desc: "fill and submit", signal: { css_exists: "#r" },
      target_hints: ["input[name=date]", "button[type=submit]"],
      slots: { date: "2026-10-06" }, when: { css_exists: "#form" },
    }], path.join(tmp, "p.json"), { coupon: "ACME10" });
    await runPlan(mw, plan, { startUrl: "u", verbose: false, sessionFactory: fakeSession(counter) });

    expect(mw.calls[0]!.slots).toEqual({ coupon: "ACME10", date: "2026-10-06" });
    expect(mw.calls[0]!.targetHints).toEqual(["input[name=date]", "button[type=submit]"]);
    expect(mw.calls[0]!.precondition).toEqual({ css_exists: "#form" });
  });
});

describe("runPlan — replan wiring", () => {
  it("replans a blocked subgoal: obstacle kept, amended subgoals run", async () => {
    const counter = { opened: 0 };
    const ran: string[] = [];
    const calls: Array<[string, unknown]> = [];
    const mw = new FakeMW((desc) => {
      ran.push(desc);
      return desc.includes("amended") ? DONE() : STUCK("stuck");
    });
    const planner = {
      replan(plan: TaskPlan, obstacle: Subgoal) {
        calls.push([obstacle.desc, obstacle.obstacle]);
        return new TaskPlan(plan.goal, [{ desc: "amended step", signal: { url_contains: "ok" } }]);
      },
    };
    const plan = new TaskPlan("g", [{ desc: "doomed step", signal: { url_contains: "x" } }],
      path.join(tmp, "p.json"));
    const rep = await runPlan(mw, plan, {
      startUrl: "u", planner, verbose: false, sessionFactory: fakeSession(counter),
    });

    expect(ran).toEqual(["doomed step", "amended step"]);
    expect(calls).toEqual([["doomed step", "stuck"]]);
    expect(rep.replans).toBe(1);
    expect(rep.completed).toBe("1/2");
    expect(plan.subgoals[0]!.obstacle).toBe("stuck");
  });

  it("replan 补丁带来的 `next` 边被**响亮地**不采纳（入口守卫不能只管初始计划）", async () => {
    const ran: string[] = [];
    const mw = new FakeMW((desc) => { ran.push(desc); return desc.includes("amended") ? DONE() : STUCK("stuck"); });
    const planner = {
      replan: () => new TaskPlan("g", [
        { desc: "amended one", signal: { url_contains: "ok" }, id: "a1", next: ["a3"] },
        { desc: "amended two", signal: { url_contains: "ok" }, id: "a2" },
      ]),
    };
    const plan = new TaskPlan("g", [{ desc: "doomed step", signal: { url_contains: "x" } }],
      path.join(tmp, "p-next.json"));
    const printed: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { printed.push(a.join(" ")); };
    let rep;
    try {
      rep = await runPlan(mw, plan, {
        startUrl: "u", planner: planner as never, verbose: false, sessionFactory: fakeSession({ opened: 0 }),
      });
    } finally {
      console.log = orig;
    }
    // 步照常补进来（那是 replan 的本职），但边**没有**溜进计划：runPlan 走的是 resume 队列。
    expect(ran).toEqual(["doomed step", "amended one", "amended two"]);
    expect(rep!.replans).toBe(1);
    expect(plan.subgoals[1]!.next).toBeUndefined();
    expect(plan.subgoals[1]!.id).toBe("a1");
    expect(printed.some((l) => /declares `next` \(a3\), which runPlan cannot honour/.test(l))).toBe(true);
  });

  it("stops when the planner makes no progress (an echo can never spin)", async () => {
    const counter = { opened: 0 };
    let calls = 0;
    const planner = { replan: (plan: TaskPlan) => { calls += 1; return plan; } };
    const plan = new TaskPlan("g", [{ desc: "d", signal: { url_contains: "x" } }], path.join(tmp, "p1.json"));
    const rep = await runPlan(new FakeMW(() => STUCK()), plan, {
      startUrl: "u", planner, verbose: false, sessionFactory: fakeSession(counter),
    });
    expect(calls).toBe(1);
    expect(rep.replans).toBe(0);
    expect(rep.completed).toBe("0/1");
  });

  it("respects maxReplans", async () => {
    const counter = { opened: 0 };
    let calls = 0;
    const planner = {
      replan: (plan: TaskPlan) => {
        calls += 1;
        return new TaskPlan(plan.goal, [{ desc: `retry-${calls}`, signal: { url_contains: "x" } }]);
      },
    };
    const plan = new TaskPlan("g", [{ desc: "d0", signal: { url_contains: "x" } }], path.join(tmp, "p2.json"));
    const rep = await runPlan(new FakeMW(() => STUCK()), plan, {
      startUrl: "u", planner, maxReplans: 2, verbose: false, sessionFactory: fakeSession(counter),
    });
    expect(calls).toBe(2);
    expect(rep.replans).toBe(2);
    expect(rep.completed).toBe("0/3");       // original + 2 amendments, all blocked
  });

  it("PORT FIX H1: a replan EXCEPTION is printed, not fatal (Python crashes)", async () => {
    const counter = { opened: 0 };
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const planner = { replan: () => { throw new Error("bad LLM reply"); } };
    const plan = new TaskPlan("g", [{ desc: "d", signal: { url_contains: "x" } }], path.join(tmp, "p3.json"));

    const rep = await runPlan(new FakeMW(() => STUCK("stuck")), plan, {
      startUrl: "u", planner, verbose: true, sessionFactory: fakeSession(counter),
    });

    expect(rep.completed).toBe("0/1");
    expect(rep.replans).toBe(0);
    expect(plan.subgoals[0]!.obstacle).toBe("stuck");
    expect(logs.mock.calls.flat().join("\n")).toContain("replan FAILED");
    logs.mockRestore();
  });

  it("carries when/retries of amended subgoals (Python's insert dropped them)", async () => {
    const counter = { opened: 0 };
    const mw = new FakeMW((desc) => (desc.includes("amended") ? DONE() : STUCK()));
    const planner = {
      replan: (plan: TaskPlan) => new TaskPlan(plan.goal, [{
        desc: "amended step", signal: { css_exists: "#ok" },
        when: { css_exists: ".overlay" }, retries: 2,
      }]),
    };
    const plan = new TaskPlan("g", [{ desc: "d", signal: { url_contains: "x" } }], path.join(tmp, "p4.json"));
    await runPlan(mw, plan, { startUrl: "u", planner, verbose: false, sessionFactory: fakeSession(counter) });
    const amended = plan.subgoals[1]!;
    expect(amended.when).toEqual({ css_exists: ".overlay" });
    expect(amended.retries).toBe(2);
    expect(mw.calls[1]!.precondition).toEqual({ css_exists: ".overlay" });
  });
});

describe("runSubgoalWithRetries / runOnce", () => {
  it("keeps every attempt's steps in the trace", async () => {
    const mw = new FakeMW((_d, n) => (n === 1
      ? { done: false, steps: [{ desc: "attempt-1" }], stop_reason: "cold" }
      : { done: true, steps: [{ desc: "attempt-2" }], stop_reason: "dom goal signal" }));
    const plan = new TaskPlan("g", [{ desc: "a", signal: { css_exists: "#a" }, retries: 1 }], path.join(tmp, "p.json"));
    const { rep, attempt, steps } = await runSubgoalWithRetries(
      mw, plan.subgoals[0]!, plan, "u", "PAGE", "PW", false);
    expect(rep.done).toBe(true);
    expect(attempt).toBe(2);
    expect(steps.map((s: any) => s.desc)).toEqual(["attempt-1", "attempt-2"]);
  });

  it("turns a throwing middleware into a blocked report instead of crashing", async () => {
    const boom: MiddlewareLike = { run: async () => { throw new Error("page died"); }, _planVerbose: false };
    const plan = new TaskPlan("g", [{ desc: "a", signal: { css_exists: "#a" } }], path.join(tmp, "p.json"));
    const { rep, attempt } = await runSubgoalWithRetries(boom, plan.subgoals[0]!, plan, "u", "PAGE", "PW", false);
    expect(rep.done).toBe(false);
    expect(rep.stop_reason).toContain("error: Error: page died");
    expect(attempt).toBe(1);
  });
});

describe("LLMPlanner", () => {
  const ENV = ["OPENAI_BASE_URL", "OPENAI_API_KEY"];
  beforeEach(() => { for (const k of ENV) delete process.env[k]; });

  it("needs an endpoint (fails loudly, no silent mock)", () => {
    expect(() => new LLMPlanner()).toThrow(/OPENAI_BASE_URL/);
    process.env.OPENAI_BASE_URL = "https://llm.example/v1/";
    expect(() => new LLMPlanner()).toThrow(/OPENAI_API_KEY/);
  });

  const planWith = (reply: Record<string, unknown>) =>
    new LLMPlanner({ baseUrl: "https://llm.example/v1", apiKey: "k", chatFn: async () => reply });

  it("builds a prompt that carries the rules, the start url and the element snapshot", () => {
    const p = planWith({ subgoals: [] });
    const elems: ElemPool = {
      e0: { ref: "e0", scan: 0, tag: "button", label: "Add to cart", data_test: "add-to-cart", href: "" },
    };
    const [system, user] = p.buildMessages("buy a mouse", new PlanningRules(3), "https://shop/p", elems, { extra: 1 });
    expect(system).toContain("at most 3 subgoals");
    expect(system).toContain("css_text_contains");
    expect(user).toContain("start_url: https://shop/p");
    expect(user).toContain('button "Add to cart" [test=add-to-cart]');
    expect(user).toContain('{"extra":1}');
  });

  it("parses a plan and enforces the planning rules", async () => {
    const plan = await planWith({ subgoals: [{ desc: "a", signal: { url_contains: "x" } }] })
      .makePlan("g", { rules: new PlanningRules(2) });
    expect(plan.subgoals).toHaveLength(1);

    await expect(planWith({ subgoals: [{ desc: "a", signal: {} }] })
      .makePlan("g", { rules: new PlanningRules(2) })).rejects.toThrow(/violates planning rules/);
  });

  it("replans with the blocked subgoal in the prompt and preserves the plan path", async () => {
    let seenUser = "";
    const p = new LLMPlanner({
      baseUrl: "https://llm.example/v1", apiKey: "k",
      chatFn: async (user) => { seenUser = user; return { subgoals: [{ desc: "fixed", signal: { url_contains: "y" } }] }; },
    });
    const plan = new TaskPlan("g", [{ desc: "d", signal: { url_contains: "x" } }], path.join(tmp, "keep.json"));
    const amended = await p.replan(plan, plan.subgoals[0]!);
    expect(amended.path).toBe(plan.path);
    expect(seenUser).toContain("blocked_subgoal");
    expect(seenUser).toContain("plan_so_far");
    expect(seenUser).toContain('"desc":"d"');
  });

  it("ScriptedPlanner echoes the same plan (that is what means 'no amendment')", () => {
    const sp = new ScriptedPlanner([{ desc: "a", signal: { url_contains: "x" } }]);
    const plan = sp.makePlan("g");
    expect(plan.subgoals[0]!.desc).toBe("a");
    expect(sp.replan(plan, plan.subgoals[0]!)).toBe(plan);
  });
});

describe("snapshotText", () => {
  it("renders the executor's own criteria format and honours the limit", () => {
    expect(snapshotText({})).toBe("");
    const elems: ElemPool = {
      e0: { ref: "e0", scan: 0, tag: "a", label: "Home", href: "shop/index" },
      e1: { ref: "e1", scan: 1, tag: "button", label: "Buy", data_test: "buy", href: "" },
    };
    expect(snapshotText(elems)).toBe('a "Home" -> shop/index\nbutton "Buy" [test=buy]');
    expect(snapshotText(elems, 1)).toBe('a "Home" -> shop/index');
  });
});
