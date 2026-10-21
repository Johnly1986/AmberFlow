/**
 * Manual completion: the honest path for a step whose completion the DOM cannot
 * verify. The human attests it, the state they were shown is recorded in the
 * trace, and the report says `manual: true` — so a manual step can never be
 * mistaken for a DOM-verified one, and its transition is what signal induction
 * consumes to automate the step next time.
 */
import { afterAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import * as browserEnv from "../src/browser/browser-env.ts";
import { BrowserMiddleware } from "../src/engine/executor.ts";
import { TaskPlan, PlanningRules } from "../src/engine/plan.ts";
import { runPlan } from "../src/engine/planner.ts";
import { checkSignal, evalSignalOnState } from "../src/engine/signals.ts";
import {
  installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer, type Question,
} from "../src/model/model.ts";

const PAGES = new URL("../testpages/", import.meta.url).pathname;
const url = (f: string): string => `file://${PAGES}${f}`;

afterAll(() => installLayaRuntime(null));

function installScripted(): void {
  installLayaRuntime(scriptedRuntime(scriptedAgent((key, _s, qs): Answer | undefined => {
    if (key === "r") return { noul: 0.05 };
    if (key === "act") {
      const refs = Object.keys((qs[key]!.criteria ?? {}) as Record<string, unknown>);
      return { choice: refs[0] ?? "", probabilities: {}, confidence: 0.9 };
    }
    if (key === "d") return { noul: 0.0 };
    return undefined;
  })));
}

describe("`{manual: true}` is not a DOM fact", () => {
  it("checkSignal can never verify it, and the offline evaluator declines", async () => {
    const browser = (await browserEnv.launch({ chromium } as never, true)) as never as {
      newPage(): Promise<unknown>; close(): Promise<void>;
    };
    const page = await browser.newPage();
    try {
      await (page as never as { goto(u: string): Promise<void> }).goto(url("product.html"));
      expect(await checkSignal(page as never, { manual: true })).toBe(false);
      expect(evalSignalOnState({ manual: true }, { url: url("product.html"), elems: {} })).toBeNull();
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("passes PlanningRules (a manual step still needs no invented operator)", () => {
    const plan = new TaskPlan("do the thing manually", [
      { desc: "a step only a human can judge", signal: { manual: true }, start_url: url("product.html") },
    ]);
    expect(new PlanningRules(8).problems(plan)).toEqual([]);
  });
});

describe("the human oracle", () => {
  it("attests the step, and the trace records what the human was shown", async () => {
    installScripted();
    const asked: Array<{ desc: string; state: string }> = [];
    const mw = new BrowserMiddleware({
      manualConfirmFn: (desc, state) => { asked.push({ desc, state }); return true; },
    });
    const report = await mw.run("add the item to the cart", url("product.html"), {
      slots: {}, targetHint: "[data-test=add-to-cart]", manualGoal: true,
      goalSignalFn: (p) => checkSignal(p as never, { manual: true }),   // never true
      verbose: false,
    });

    expect(report.done).toBe(true);
    expect(report.manual).toBe(true);
    expect(report.stop_reason).toBe("manual confirmation (human oracle)");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.desc).toContain("add the item");
    expect(asked[0]!.state).toContain("product.html");
    const attested = report.steps.find((s) => s.how === "manual_confirmed")!;
    expect(attested.manual).toBe(true);
    expect(String(attested.state)).toContain("product.html");
  }, 120_000);

  it("without a human it stops with an explicit reason instead of succeeding", async () => {
    installScripted();
    const mw = new BrowserMiddleware({});                      // no manualConfirmFn
    const report = await mw.run("add the item to the cart", url("product.html"), {
      slots: {}, targetHint: "[data-test=add-to-cart]", manualGoal: true,
      goalSignalFn: (p) => checkSignal(p as never, { manual: true }),
      verbose: false,
    });
    expect(report.done).toBe(false);
    expect(report.manual).toBeUndefined();
    expect(report.stop_reason).toBe("manual step needs a human: no manualConfirmFn configured");
  }, 120_000);

  it("a declined attestation is recorded but does not complete the step", async () => {
    installScripted();
    const mw = new BrowserMiddleware({ manualConfirmFn: () => false, maxSteps: 2 });
    const report = await mw.run("add the item to the cart", url("product.html"), {
      slots: {}, targetHint: "[data-test=add-to-cart]", manualGoal: true,
      goalSignalFn: (p) => checkSignal(p as never, { manual: true }),
      verbose: false,
    });
    expect(report.done).toBe(false);
    expect(report.steps.filter((s) => s.how === "manual_declined").length).toBeGreaterThan(0);
  }, 120_000);
});

describe("plan-level wiring", () => {
  it("runPlan passes manualGoal for a `{manual: true}` subgoal and completes on attestation", async () => {
    installScripted();
    const plan = new TaskPlan("手动确认的一步", [
      { desc: "add the item to the cart", signal: { manual: true }, start_url: url("product.html"),
        target_hint: "[data-test=add-to-cart]" },
    ], "/tmp/manual-plan.json", {});
    const mw = new BrowserMiddleware({ manualConfirmFn: () => true });
    const rep = await runPlan(mw as never, plan, { startUrl: url("product.html"), verbose: false });
    expect(rep.completed).toBe("1/1");
    expect(plan.subgoals[0]!.status).toBe("done");
  }, 120_000);
});
