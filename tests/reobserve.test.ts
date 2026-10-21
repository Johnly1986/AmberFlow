/**
 * Observation-bottleneck recovery.
 *
 * The element pool is the model's ENTIRE world. A target that never entered it
 * cannot be chosen, however good the model is — browser-use names this the
 * observation bottleneck ("the button is there, we just failed to show it"), and
 * this repo hit it live twice (the plan's `#searchInput` evicted by the 40-element
 * budget on python.org; the fixture's own `cart-count` badge living outside the
 * pool entirely). The executor's answer: when a pick lands below the confidence
 * floor and it is about to block, take ONE wider look and re-ask.
 *
 * The page here has 60 decoy buttons before the target, so the 40-element budget
 * provably drops the target from the model's view.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import * as browserEnv from "../src/browser/browser-env.ts";
import { BrowserMiddleware } from "../src/engine/executor.ts";
import { MAX_ELEMENTS, extractElements } from "../src/engine/extraction.ts";
import { checkSignal } from "../src/engine/signals.ts";
import {
  installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer, type Question,
} from "../src/model/model.ts";

afterAll(() => installLayaRuntime(null));

/** 60 visible decoys, then the only element that can complete the goal. */
function pageWithDecoys(decoyCount = 60): string {
  const decoys = Array.from({ length: decoyCount },
    (_v, i) => `<button data-test="decoy-${i}">Decoy ${i}</button>`).join("");
  const html = `<!doctype html><html><body><main>
${decoys}
<button data-test="real-target" onclick="document.querySelector('[data-test=status]').textContent='DONE'">Real target</button>
<div data-test="status">IDLE</div>
</main></body></html>`;
  const file = path.join(os.tmpdir(), `reobserve-${decoyCount}.html`);
  fs.writeFileSync(file, html, "utf-8");
  return `file://${file}`;
}

/**
 * A model that can only pick what it SEES: with the target in view it is sure
 * (0.90); without it, nothing looks right (0.10) — exactly how a good small model
 * behaves when the harness failed to show it the button.
 */
function seesOnlyWhatItIsShown(): void {
  installLayaRuntime(scriptedRuntime(scriptedAgent((key, _s, questions): Answer | undefined => {
    if (key === "r") return { noul: 0.05 };
    if (key === "d") return { noul: 0.0 };
    if (key === "act") {
      const crit = (questions[key]!.criteria ?? {}) as Record<string, string>;
      const keys = Object.keys(crit);
      const target = keys.find((k) => String(crit[k]).includes("Real target"));
      // probabilities for EVERY option: the executor derives the gate signal from
      // the distribution when >k options exist (passthrough only applies at <=k).
      if (target) {
        const rest = 0.1 / Math.max(1, keys.length - 1);
        return {
          choice: target,
          probabilities: Object.fromEntries(keys.map((k) => [k, k === target ? 0.9 : rest])),
          confidence: 0.9,
        };
      }
      const flat = 1 / Math.max(1, keys.length);
      return {
        choice: keys[0] ?? "",
        probabilities: Object.fromEntries(keys.map((k) => [k, flat])),
        confidence: flat,
      };
    }
    return undefined;
  })));
}

const SIGNAL = { css_text_equals: ["[data-test=status]", "DONE"] } as const;
const GOAL = "press the real target button";

describe("the budget really hides the target", () => {
  it("40 elements by default, 120 when asked for a wider look", async () => {
    const browser = (await browserEnv.launch({ chromium } as never, true)) as never as {
      newPage(): Promise<unknown>; close(): Promise<void>;
    };
    const page = await browser.newPage();
    try {
      await (page as never as { goto(u: string): Promise<void> }).goto(pageWithDecoys());
      const narrow = await extractElements(page as never);
      const wide = await extractElements(page as never, true, 120);
      expect(Object.keys(narrow).length).toBe(MAX_ELEMENTS);
      expect(Object.values(narrow).some((e) => e.data_test === "real-target")).toBe(false);
      expect(Object.values(wide).some((e) => e.data_test === "real-target")).toBe(true);
    } finally {
      await browser.close();
    }
  }, 120_000);
});

describe("low confidence triggers one wider look", () => {
  it("recovers the subgoal, and the trace says the pick came from a re-observation", async () => {
    seesOnlyWhatItIsShown();
    const mw = new BrowserMiddleware({ maxSteps: 3, confirmFn: () => true });
    const report = await mw.run(GOAL, pageWithDecoys(), {
      slots: {}, goalSignalFn: (p) => checkSignal(p as never, SIGNAL), verbose: false,
    });
    expect(report.done).toBe(true);
    expect(report.stop_reason).toBe("dom goal signal");
    expect(report.steps[0]!.method).toBe("laya:reobserve");
  }, 120_000);

  it("with re-observe OFF the same run blocks — the wider look is what recovered it", async () => {
    seesOnlyWhatItIsShown();
    const mw = new BrowserMiddleware({ maxSteps: 3, confirmFn: () => true, reobserve: false });
    const report = await mw.run(GOAL, pageWithDecoys(), {
      slots: {}, goalSignalFn: (p) => checkSignal(p as never, SIGNAL), verbose: false,
    });
    expect(report.done).toBe(false);
    expect(report.stop_reason).toMatch(/^low confidence 0\.0\d < floor 0\.25 on step 1$/);
    expect(report.steps).toHaveLength(0);
  }, 120_000);

  it("when the wider view does not help either, the stop reason stays exact", async () => {
    // a model that is unsure no matter how much it is shown
    installLayaRuntime(scriptedRuntime(scriptedAgent((key, _s, questions): Answer | undefined => {
      if (key === "r") return { noul: 0.05 };
      if (key === "d") return { noul: 0.0 };
      if (key === "act") {
        const keys = Object.keys((questions[key]!.criteria ?? {}) as Record<string, unknown>);
        const flat = 1 / Math.max(1, keys.length);
        return {
          choice: keys[0] ?? "",
          probabilities: Object.fromEntries(keys.map((k) => [k, flat])),
          confidence: 0.17,
        };
      }
      return undefined;
    })));
    const mw = new BrowserMiddleware({ maxSteps: 3, confirmFn: () => true });
    const report = await mw.run(GOAL, pageWithDecoys(), {
      slots: {}, goalSignalFn: (p) => checkSignal(p as never, SIGNAL), verbose: false,
    });
    expect(report.done).toBe(false);
    expect(report.stop_reason).toMatch(/^low confidence 0\.0\d < floor 0\.25 on step 1$/);
  }, 120_000);
});
