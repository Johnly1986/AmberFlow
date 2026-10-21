/**
 * Escalation — C3-R's deliberative path, adapted to this project's contract.
 *
 * The local decision model is the fast path; when it is unsure (below the floor,
 * even after one wider look) a stronger reasoner may still name ONE of the elements
 * the harness already showed. It is a PICKER, not a planner: an answer that is not a
 * ref from that view is rejected, so it cannot invent an element, a value or an
 * action — and it fails closed (no endpoint ⇒ abstain ⇒ the subgoal blocks as before).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import * as browserEnv from "../src/browser/browser-env.ts";
import { BrowserMiddleware, type EscalationRequest } from "../src/engine/executor.ts";
import { checkSignal } from "../src/engine/signals.ts";
import { llmEscalator } from "../src/engine/planner.ts";
import {
  installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer, type Question,
} from "../src/model/model.ts";

afterAll(() => installLayaRuntime(null));

/** Decoys first, so the target is outside the narrow pool; a wider look finds it. */
function pageWithDecoys(n = 60): string {
  const decoys = Array.from({ length: n }, (_v, i) => `<button data-test="decoy-${i}">Decoy ${i}</button>`).join("");
  const html = `<!doctype html><html><body><main>${decoys}
<button data-test="real-target" onclick="document.querySelector('[data-test=status]').textContent='DONE'">Real target</button>
<div data-test="status">IDLE</div></main></body></html>`;
  const file = path.join(os.tmpdir(), `escalate-${n}.html`);
  fs.writeFileSync(file, html, "utf-8");
  return `file://${file}`;
}

/** A local model that is unsure no matter what it is shown. */
function alwaysUnsure(): void {
  installLayaRuntime(scriptedRuntime(scriptedAgent((key, _s, questions): Answer | undefined => {
    if (key === "r") return { noul: 0.05 };
    if (key === "d") return { noul: 0.0 };
    if (key === "act") {
      const keys = Object.keys((questions[key]!.criteria ?? {}) as Record<string, unknown>);
      const flat = 1 / Math.max(1, keys.length);
      return {
        choice: keys[0] ?? "",
        probabilities: Object.fromEntries(keys.map((k) => [k, flat])),
        confidence: 0.05,
      };
    }
    return undefined;
  })));
}

const SIGNAL = { css_text_equals: ["[data-test=status]", "DONE"] } as const;
const GOAL = "press the real target button";

describe("the escalator is a picker, not a planner", () => {
  it("names a shown candidate and the subgoal completes", async () => {
    alwaysUnsure();                      // even the wider look stays below the floor
    const seen: EscalationRequest[] = [];
    const mw = new BrowserMiddleware({
      maxSteps: 3, confirmFn: () => true,
      escalateFn: (req) => {
        seen.push(req);
        return Object.keys(req.criteria).find((r) => req.criteria[r]!.includes("Real target")) ?? null;
      },
    });
    const report = await mw.run(GOAL, pageWithDecoys(), {
      slots: {}, goalSignalFn: (p) => checkSignal(p as never, SIGNAL), verbose: false,
    });

    expect(report.done).toBe(true);
    expect(report.steps[0]!.method).toBe("escalate");
    expect(report.steps[0]!.escalated).toBe(true);
    // it was shown the harness's own rendering, and the targets are refs from it
    expect(seen).toHaveLength(1);
    expect(seen[0]!.why).toMatch(/low confidence 0\.0\d < floor 0\.25/);
    expect(seen[0]!.instruction).toBe(GOAL);
    expect(Object.values(seen[0]!.criteria).some((line) => line.includes("Real target"))).toBe(true);
    // the escalator sees the WIDER view, not the narrow pool the local model failed on
    expect(Object.keys(seen[0]!.criteria).length).toBeGreaterThan(40);
  }, 120_000);

  it("rejects an invention: an answer that is not a shown ref does nothing", async () => {
    alwaysUnsure();
    const mw = new BrowserMiddleware({
      maxSteps: 2, confirmFn: () => true,
      escalateFn: () => "not-a-real-ref",           // must be ignored
    });
    const report = await mw.run(GOAL, pageWithDecoys(), {
      slots: {}, goalSignalFn: (p) => checkSignal(p as never, SIGNAL), verbose: false,
    });
    expect(report.done).toBe(false);
    expect(report.stop_reason).toMatch(/^low confidence 0\.0\d < floor 0\.25 on step 1$/);
    expect(report.steps.some((s) => s.method === "escalate")).toBe(false);
  }, 120_000);

  it("is not consulted when the local model is confident (and cannot override it)", async () => {
    // a confident local model that picks the FIRST candidate (a decoy)
    installLayaRuntime(scriptedRuntime(scriptedAgent((key, _s, questions): Answer | undefined => {
      if (key === "r") return { noul: 0.05 };
      if (key === "d") return { noul: 0.0 };
      if (key === "act") {
        const keys = Object.keys((questions[key]!.criteria ?? {}) as Record<string, unknown>);
        return {
          choice: keys[0] ?? "",
          probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.95 : 0.05 / keys.length])),
          confidence: 0.95,
        };
      }
      return undefined;
    })));
    let asked = 0;
    const mw = new BrowserMiddleware({
      maxSteps: 1, confirmFn: () => true, escalateFn: () => { asked += 1; return null; },
    });
    const report = await mw.run(GOAL, pageWithDecoys(), {
      slots: {}, goalSignalFn: (p) => checkSignal(p as never, SIGNAL), verbose: false,
    });
    expect(asked).toBe(0);                          // confident local pick stands
    expect(report.steps[0]!.method).toBe("laya");
    expect(report.done).toBe(false);
  }, 120_000);

  it("a throwing escalator degrades to the previous behaviour, never crashes the run", async () => {
    alwaysUnsure();
    const mw = new BrowserMiddleware({
      maxSteps: 2, confirmFn: () => true,
      escalateFn: () => { throw new Error("endpoint down"); },
    });
    const report = await mw.run(GOAL, pageWithDecoys(), {
      slots: {}, goalSignalFn: (p) => checkSignal(p as never, SIGNAL), verbose: false,
    });
    expect(report.done).toBe(false);
    expect(report.stop_reason).toMatch(/^low confidence 0\.0\d < floor 0\.25/);
  }, 120_000);
});

describe("llmEscalator (the shipped deliberative rung)", () => {
  const req: EscalationRequest = {
    instruction: "open the cart",
    criteria: { e0: 'a "Cart" [test=cart-link]', e1: 'button "Buy"' },
    url: "https://x/p", title: "P", main_text: "…",
    why: "low confidence 0.12 < floor 0.25",
  };

  it("parses a valid answer and returns the ref", async () => {
    const esc = llmEscalator({ chatFn: async () => 'Sure!\n{"ref": "e0"}' });
    expect(await esc(req)).toBe("e0");
  });

  it("rejects an element the harness never showed (the contract)", async () => {
    const esc = llmEscalator({ chatFn: async () => '{"ref": "e9"}' });
    expect(await esc(req)).toBeNull();
    const esc2 = llmEscalator({ chatFn: async () => '{"ref": "invented"}' });
    expect(await esc2(req)).toBeNull();
  });

  it("abstains on a null answer, on garbage, and when the endpoint throws", async () => {
    expect(await llmEscalator({ chatFn: async () => '{"ref": null}' })(req)).toBeNull();
    expect(await llmEscalator({ chatFn: async () => "no json here" })(req)).toBeNull();
    expect(await llmEscalator({ chatFn: async () => { throw new Error("boom"); } })(req)).toBeNull();
  });

  it("sends the goal, the abstention reason and the candidate lines", async () => {
    let user = "";
    const esc = llmEscalator({ chatFn: async (u) => { user = u; return '{"ref": "e1"}'; } });
    expect(await esc(req)).toBe("e1");
    expect(user).toContain("open the cart");
    expect(user).toContain("low confidence 0.12");
    expect(user).toContain('e0: a "Cart" [test=cart-link]');
    expect(user).toContain('e1: button "Buy"');
  });

  it("needs no endpoint to be constructed (fails closed at call time)", async () => {
    const esc = llmEscalator({ baseUrl: "", apiKey: "" });
    expect(await esc(req)).toBeNull();
  });
});
