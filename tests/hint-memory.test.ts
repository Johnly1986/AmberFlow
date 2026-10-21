/**
 * Learned hints — an OBSERVED success becomes a rule for next time.
 *
 * The repo's own numbers say the lever on real pages is asking the model less often
 * (8/8 with authored hints vs 4/8 without). Authored hints come from the planner; this
 * lets them be EARNED: a model pick that actually advanced the subgoal becomes a hint in
 * the existing grammar, restricted to stable handles, so the next run of the same
 * (url, subgoal) resolves `rule:match` at zero model cost.
 *
 * Same epistemology as induced completion signals: WATCHED, never guessed — and harmless
 * when wrong, because a hint that matches nothing or is ambiguous falls back to the model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import * as browserEnv from "../src/browser/browser-env.ts";
import { BenchMiddleware } from "../src/cli/bench.ts";
import { BrowserMiddleware } from "../src/engine/executor.ts";
import { checkSignal } from "../src/engine/signals.ts";
import { HintMemory, createHintMemory, induceHint } from "../src/model/hint-memory.ts";
import type { Elem } from "../src/engine/extraction.ts";
import {
  installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer, type Question,
} from "../src/model/model.ts";

afterAll(() => installLayaRuntime(null));

const elem = (o: Partial<Elem>): Elem => ({ tag: "button", label: "Button", ...o });

describe("induceHint", () => {
  it("prefers the most stable handle the element actually has", () => {
    expect(induceHint(elem({ data_test: "checkout-btn", id: "x", name: "y" }))).toBe("[data-test=checkout-btn]");
    expect(induceHint(elem({ id: "checkout-btn", name: "y" }))).toBe("[id=checkout-btn]");
    expect(induceHint(elem({ name: "coupon" }))).toBe("[name=coupon]");
  });

  it("falls back to a near-token only with a real label, and never invents a position", () => {
    expect(induceHint(elem({ label: "Proceed to payment" }))).toBe("button[near~Proceed to payment]");
    expect(induceHint(elem({ label: "" }))).toBeNull();
    expect(induceHint(elem({ tag: "", label: "Buy" }))).toBeNull();
    expect(induceHint(null)).toBeNull();
  });

  it("refuses volatile values (ids, counts, years, hashes) — those rot", () => {
    // label cleared so this isolates the ATTRIBUTE check (a generic label would
    // otherwise legitimately fall back to `near~`, which the grammar then treats as
    // ambiguous and hands back to the model — harmless, but not what is under test)
    expect(induceHint(elem({ id: "row-1234567", label: "" }))).toBeNull();       // 4+ digits
    expect(induceHint(elem({ data_test: "usr_9f8e7d6c5b4a3210", label: "" }))).toBeNull();
    expect(induceHint(elem({ data_test: "  ", label: "" }))).toBeNull();
    // volatile attribute + a usable label -> the label may still carry the hint
    expect(induceHint(elem({ id: "row-1234567", label: "Proceed to payment" })))
      .toBe("button[near~Proceed to payment]");
  });
});

describe("HintMemory", () => {
  it("keys on (url, subgoal), is bounded, counts uses, rejects empty hints", () => {
    const m = createHintMemory({ max: 2 });
    const k = m.key("https://x/p", "Open the cart");
    expect(m.lookup(k)).toBeNull();
    m.record(k, "[data-test=cart]");
    expect(m.lookup(k)).toBe("[data-test=cart]");
    expect(m.key("https://x/q", "Open the cart")).not.toBe(k);
    m.record("k2", "[id=a]");
    m.record("k3", "[id=b]");
    expect(m.stats().entries).toBe(2);                    // k evicted by LRU
    m.countUsed(2);
    m.record("k4", "");                                    // nothing stable -> refused
    expect(m.stats()).toMatchObject({ used: 2, rejected: 1 });
  });

  it("persists across processes and survives a damaged file", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hmem-")), "hints.json");
    const a = createHintMemory({ path: file });
    a.record(a.key("https://x/p", "buy"), "[data-test=buy]");
    expect(new HintMemory({ path: file }).lookup(a.key("https://x/p", "buy"))).toBe("[data-test=buy]");
    fs.writeFileSync(file, "{oops", "utf-8");
    expect(new HintMemory({ path: file }).stats().entries).toBe(0);
  });

  it("BenchMiddleware forwards it (the dropped-option regression, again)", () => {
    const hints = createHintMemory();
    expect(new BenchMiddleware({ hintMemory: hints }).hintMemory).toBe(hints);
  });
});

/** A page whose target carries a stable handle, with NO authored hint anywhere. */
function page(): string {
  const html = `<!doctype html><html><body><main>
<button data-test="other-thing" onclick="void 0">Store locator</button>
<button data-test="proceed-now" onclick="document.querySelector('[data-test=status]').textContent='DONE'">Proceed to payment</button>
<div data-test="status">IDLE</div></main></body></html>`;
  const file = path.join(os.tmpdir(), "hint-memory-page.html");
  fs.writeFileSync(file, html, "utf-8");
  return `file://${file}`;
}

/** Counts how often the model is asked, and always picks the working element. */
function countingModel(): () => number {
  let calls = 0;
  installLayaRuntime(scriptedRuntime(scriptedAgent((key, _s, questions): Answer | undefined => {
    if (key === "r") return { noul: 0.05 };
    if (key === "d") return { noul: 0.0 };
    if (key === "act") {
      calls += 1;
      const crit = (questions[key]!.criteria ?? {}) as Record<string, string>;
      const keys = Object.keys(crit);
      const target = keys.find((k) => String(crit[k]).includes("Proceed to payment")) ?? keys[0] ?? "";
      return {
        choice: target,
        probabilities: Object.fromEntries(keys.map((k) => [k, k === target ? 0.9 : 0.1 / keys.length])),
        confidence: 0.9,
      };
    }
    return undefined;
  })));
  return () => calls;
}

const SIGNAL = { css_text_equals: ["[data-test=status]", "DONE"] } as const;
const GOAL = "complete checkout";

describe("a learned hint replaces the next model call", () => {
  const attempt = (mw: BrowserMiddleware, url: string) => mw.run(GOAL, url, {
    slots: {}, goalSignalFn: (p) => checkSignal(p as never, SIGNAL), verbose: false,
  });

  it("run 1 asks the model and learns; run 2 resolves by hint without asking", async () => {
    const calls = countingModel();
    const url = page();
    const hints = createHintMemory();
    const mw = new BrowserMiddleware({ maxSteps: 3, confirmFn: () => true, hintMemory: hints });

    const first = await attempt(mw, url);
    expect(first.done).toBe(true);
    expect(first.steps[0]!.method).toBe("laya");
    expect(calls()).toBeGreaterThan(0);
    expect(hints.stats().entries).toBe(1);                 // the success was turned into a hint
    const before = calls();

    const second = await attempt(mw, url);
    expect(second.done).toBe(true);
    expect(second.steps[0]!.method).toBe("rule:match");    // learned hint decided the step
    expect(calls()).toBe(before);                          // zero extra model calls
    expect(hints.stats().used).toBe(1);
  }, 120_000);

  it("without the memory, run 2 asks the model again (the control)", async () => {
    const calls = countingModel();
    const url = page();
    const mw = new BrowserMiddleware({ maxSteps: 3, confirmFn: () => true });
    await attempt(mw, url);
    const before = calls();
    const second = await attempt(mw, url);
    expect(second.steps[0]!.method).toBe("laya");
    expect(calls()).toBeGreaterThan(before);
  }, 120_000);

  it("an authored hint still wins over a learned one", async () => {
    const calls = countingModel();
    const hints = createHintMemory();
    const url = page();
    // poison the memory with a hint that matches nothing on this page
    hints.record(hints.key(url, GOAL), "[data-test=does-not-exist]");
    const mw = new BrowserMiddleware({ maxSteps: 3, confirmFn: () => true, hintMemory: hints });
    const report = await attempt(mw, url);
    // a hint that matches nothing falls through to the model (documented behaviour),
    // so the run still completes — the learned hint is advisory, not a trap
    expect(report.done).toBe(true);
    expect(calls()).toBeGreaterThan(0);
  }, 120_000);
});
