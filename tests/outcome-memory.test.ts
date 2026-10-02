/**
 * Outcome memory — remembering what HAPPENED, not what was decided.
 *
 * Round 2/3 measured that wrong actions on real pages are confident clicks on
 * plausible-but-inert elements, which no confidence gate can see. What CAN see them
 * is the outcome itself: this memory carries "this element did nothing on this page
 * for this subgoal" across attempts, so a retry does not repeat a dead action.
 *
 * Identity is the element SIGNATURE (refs are re-indexed on every scan, so they must
 * never be persisted), the key is (exact url, subgoal), a mark is dropped the moment
 * the element works, and a mark can never empty the pool.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import * as browserEnv from "../src/browser-env.ts";
import { BrowserMiddleware } from "../src/executor.ts";
import { checkSignal } from "../src/signals.ts";
import { BenchMiddleware } from "../src/bench.ts";
import { OutcomeMemory, createOutcomeMemory } from "../src/outcome-memory.ts";
import {
  installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer, type Question,
} from "../src/model.ts";

afterAll(() => installLayaRuntime(null));

describe("OutcomeMemory", () => {
  it("keys on (url, subgoal) — a different page or goal is different memory", () => {
    const m = createOutcomeMemory();
    const a = m.key("https://x/p", "open the cart");
    expect(m.key("https://x/p", "open the cart")).toBe(a);
    expect(m.key("https://x/q", "open the cart")).not.toBe(a);
    expect(m.key("https://x/p", "open the basket")).not.toBe(a);
    // case/whitespace-insensitive in the subgoal only (urls are exact)
    expect(m.key("https://x/p", "  Open The Cart ")).toBe(a);
  });

  it("remembers inert elements, clears the mark when the element works", () => {
    const m = createOutcomeMemory();
    const k = m.key("u", "g");
    m.record(k, "sig-a", "inert");
    m.record(k, "sig-b", "inert");
    expect([...m.inertIn(k)]).toEqual(["sig-a", "sig-b"]);
    m.record(k, "sig-a", "effective");
    expect([...m.inertIn(k)]).toEqual(["sig-b"]);
    expect(m.stats()).toMatchObject({ states: 1, entries: 1, cleared: 1 });
    m.record(k, "sig-b", "effective");                    // last one clears the key
    expect(m.stats().states).toBe(0);
  });

  it("is bounded per key and across keys (LRU)", () => {
    const m = createOutcomeMemory({ maxStates: 2, maxPerState: 3 });
    for (const s of ["a", "b", "c", "d"]) m.record("k1", s, "inert");
    expect(m.inertIn("k1").size).toBe(3);                 // oldest evicted
    expect([...m.inertIn("k1")]).toEqual(["b", "c", "d"]);
    m.record("k2", "x", "inert");
    m.record("k3", "y", "inert");
    expect(m.stats().states).toBe(2);                     // k1 evicted by LRU touch order
    m.inertIn("k3");
    m.record("k4", "z", "inert");
    expect([...m.inertIn("k2")]).toEqual([]);             // k2 is the coldest now
  });

  it("counts the skips it caused, for the audit", () => {
    const m = createOutcomeMemory();
    m.countPrevented(3);
    expect(m.stats().prevented).toBe(3);
  });

  it("persists and reloads across processes (resume)", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omem-")), "memory.json");
    const a = createOutcomeMemory({ path: file });
    a.record(a.key("https://x/p", "buy"), '["button","Buy","",""]', "inert");
    const b = new OutcomeMemory({ path: file });
    expect([...b.inertIn(b.key("https://x/p", "buy"))]).toEqual(['["button","Buy","",""]']);
    expect(b.stats().entries).toBe(1);
  });

  it("survives an unreadable file (memory is never a reason to fail a run)", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omem-")), "bad.json");
    fs.writeFileSync(file, "{not json", "utf-8");
    const m = createOutcomeMemory({ path: file });
    expect(m.stats()).toMatchObject({ states: 0, entries: 0 });
  });
});

/**
 * Two buttons, worded so NO rule can resolve them (round 1's measurement: a goal
 * token that appears in a label makes `affordance_rule` decide the step and the model
 * is never asked — which would make this test pass for the wrong reason).
 */
function pageWithDeadFirst(): string {
  const html = `<!doctype html><html><body><main>
<button data-test="dead-a" onclick="void 0">Store locator</button>
<button data-test="live-b" onclick="document.querySelector('[data-test=status]').textContent='DONE'">Proceed to payment</button>
<div data-test="status">IDLE</div></main></body></html>`;
  const file = path.join(os.tmpdir(), "outcome-memory-page.html");
  fs.writeFileSync(file, html, "utf-8");
  return `file://${file}`;
}

/** One interactive element only: used to prove the memory cannot empty the pool. */
function pageWithOnlyDead(): string {
  const html = `<!doctype html><html><body><main>
<button data-test="dead-a" onclick="void 0">Store locator</button></main></body></html>`;
  const file = path.join(os.tmpdir(), "outcome-memory-dead.html");
  fs.writeFileSync(file, html, "utf-8");
  return `file://${file}`;
}

/** A model that always takes the first candidate: the decoy, when it is visible. */
function alwaysFirst(): void {
  installLayaRuntime(scriptedRuntime(scriptedAgent((key, _s, questions): Answer | undefined => {
    if (key === "r") return { noul: 0.05 };
    if (key === "d") return { noul: 0.0 };
    if (key === "act") {
      const keys = Object.keys((questions[key]!.criteria ?? {}) as Record<string, unknown>);
      return {
        choice: keys[0] ?? "",
        probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.9 : 0.1 / keys.length])),
        confidence: 0.9,
      };
    }
    return undefined;
  })));
}

const SIGNAL = { css_text_equals: ["[data-test=status]", "DONE"] } as const;
const GOAL = "complete checkout";

describe("the harness actually forwards the memory", () => {
  it("BenchMiddleware keeps the memory it was given", () => {
    // Regression: the first live A/B ran with `opts.outcomeMemory` accepted but never
    // forwarded to super(), so the executor had none — a whole run measured nothing
    // while looking plausible. A silently dropped option is worse than a crash.
    const mem = createOutcomeMemory();
    const mw = new BenchMiddleware({ outcomeMemory: mem });
    expect(mw.outcomeMemory).toBe(mem);
    expect(new BenchMiddleware({}).outcomeMemory).toBeNull();
  });
});

describe("the executor uses it, and it is what saves the retry", () => {
  const attempt = (mw: BrowserMiddleware, url: string) => mw.run(GOAL, url, {
    slots: {}, goalSignalFn: (p) => checkSignal(p as never, SIGNAL), verbose: false,
  });

  it("with memory: attempt 1 hits the dead element, attempt 2 skips it and completes", async () => {
    alwaysFirst();
    const url = pageWithDeadFirst();
    const mem = createOutcomeMemory();
    const mw = new BrowserMiddleware({ maxSteps: 1, confirmFn: () => true, outcomeMemory: mem });

    const first = await attempt(mw, url);
    expect(first.done).toBe(false);                       // clicked the decoy, step budget spent
    expect(first.steps[0]!.inert).toBe(true);
    expect(first.steps[0]!.method).toBe("laya");
    expect(mem.stats()).toMatchObject({ entries: 1 });

    const second = await attempt(mw, url);
    expect(second.done).toBe(true);                       // memory removed the decoy
    expect(second.steps[0]!.prevented).toBe(1);           // and the trace says so
    expect(second.steps[0]!.inert).toBe(false);
    expect(mem.stats().prevented).toBe(1);
  }, 120_000);

  it("without memory the same retry walks into the same dead element (the control)", async () => {
    alwaysFirst();
    const url = pageWithDeadFirst();
    const mw = new BrowserMiddleware({ maxSteps: 1, confirmFn: () => true });
    const a = await attempt(mw, url);
    const b = await attempt(mw, url);
    expect(a.done).toBe(false);
    expect(b.done).toBe(false);                            // identical failure, twice
    expect(b.steps[0]!.prevented).toBeUndefined();
  }, 120_000);

  it("never empties the pool: a remembered element that is the ONLY candidate is still used", async () => {
    alwaysFirst();
    const url = pageWithOnlyDead();
    const mem = createOutcomeMemory();
    const mw = new BrowserMiddleware({ maxSteps: 1, confirmFn: () => true, outcomeMemory: mem });

    const first = await attempt(mw, url);
    expect(first.steps[0]!.inert).toBe(true);
    expect(mem.stats().entries).toBe(1);

    // the mark exists, yet the only candidate must remain choosable — otherwise the
    // step would stop with "action space exhausted" instead of trying it again
    const second = await attempt(mw, url);
    expect(second.steps[0]!.executed).toBe(true);
    expect(second.steps[0]!.prevented).toBeUndefined();
    expect(second.stop_reason).not.toMatch(/exhausted/);
  }, 120_000);
});
