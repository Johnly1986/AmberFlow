/**
 * Learned hints through the PLAN CLI — end to end, and sidecar-only.
 *
 * `plan_cli run --learn-hints` (or `--hint-memory FILE`) is how the round-6 measurement becomes
 * a usable capability: the first run asks the model once, the memory records the stable handle
 * of the element that worked, and the next run of the same page+subgoal resolves by rule.
 *
 * The load-bearing invariant is that the PLAN ITSELF is untouched — a frozen plan is an audited
 * artifact, so what a run learned lives in its own file next to it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TaskPlan } from "../src/plan.ts";
import { cmdRun } from "../src/plan-cli.ts";
import { createHintMemory } from "../src/hint-memory.ts";
import {
  installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer, type Question,
} from "../src/model.ts";

afterAll(() => installLayaRuntime(null));

const io = {
  ask: async (): Promise<boolean> => true,
  out: (): void => {},
};

/** A page whose target has a stable handle; no authored hint anywhere in the plan. */
function pageFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-hints-"));
  const file = path.join(dir, "page.html");
  fs.writeFileSync(file, `<!doctype html><html><body><main>
<button data-test="other-thing" onclick="void 0">Store locator</button>
<button data-test="proceed-now" onclick="document.querySelector('[data-test=status]').textContent='DONE'">Continue</button>
<div data-test="status">IDLE</div></main></body></html>`, "utf-8");
  return `file://${file}`;
}

/** Counts model calls; always picks the element that actually completes the subgoal. */
function countingModel(): () => number {
  let calls = 0;
  installLayaRuntime(scriptedRuntime(scriptedAgent((key, _s, questions): Answer | undefined => {
    if (key === "r") return { noul: 0.05 };
    if (key === "d") return { noul: 0.0 };
    if (key === "act") {
      calls += 1;
      const crit = (questions[key]!.criteria ?? {}) as Record<string, string>;
      const keys = Object.keys(crit);
      const target = keys.find((k) => String(crit[k]).includes("Continue")) ?? keys[0] ?? "";
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

/** A one-subgoal plan over a local page, with NO target_hint. */
function suite(): { planFile: string; memFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-plan-"));
  const planFile = path.join(dir, "plan.json");
  const plan = new TaskPlan("complete checkout", [{
    desc: "complete checkout",
    signal: { css_text_equals: ["[data-test=status]", "DONE"] },
    start_url: pageFile(),
  }], planFile);
  plan.save();
  return { planFile, memFile: path.join(dir, "plan.json.hints.json") };
}

const args = (planFile: string, hintMemory: string | null) =>
  ({ file: planFile, max: 8, reset: true, confirm: "allow" as const, replan: false, hintMemory });

describe("plan_cli run --learn-hints", () => {
  it("run 1 asks the model and writes a SIDECAR, never the plan", async () => {
    const { planFile, memFile } = suite();
    const before = JSON.parse(fs.readFileSync(planFile, "utf-8")) as {
      goal: string; subgoals: Array<Record<string, unknown>>;
    };
    const calls = countingModel();

    const first = await cmdRun(args(planFile, memFile), io);
    expect(first.finished).toBe(true);
    expect(calls()).toBeGreaterThan(0);

    // The plan DOES get its run state checkpointed (status/obstacle — that is the resume
    // feature), but a run must never write what it LEARNED into the audited artifact.
    const after = JSON.parse(fs.readFileSync(planFile, "utf-8")) as {
      goal: string; subgoals: Array<Record<string, unknown>>;
    };
    expect(after.goal).toBe(before.goal);
    for (const [i, sg] of after.subgoals.entries()) {
      expect(sg["desc"]).toBe(before.subgoals[i]!["desc"]);
      expect(sg["signal"]).toEqual(before.subgoals[i]!["signal"]);
      expect(sg["target_hint"] ?? null).toBeNull();
      expect(sg["target_hints"] ?? null).toBeNull();
    }
    expect(fs.readFileSync(planFile, "utf-8")).not.toContain("proceed-now");

    const mem = JSON.parse(fs.readFileSync(memFile, "utf-8")) as { hints: Array<[string, string]> };
    expect(mem.hints).toHaveLength(1);
    expect(mem.hints[0]![1]).toBe("[data-test=proceed-now]");       // the handle that worked
  }, 180_000);

  it("run 2 of the same plan reuses it: the model is not asked again", async () => {
    const { planFile, memFile } = suite();
    const calls = countingModel();

    await cmdRun(args(planFile, memFile), io);
    const afterFirst = calls();
    const second = await cmdRun(args(planFile, memFile), io);

    expect(second.finished).toBe(true);
    expect(calls()).toBe(afterFirst);                                // zero further model calls
    const mem = JSON.parse(fs.readFileSync(memFile, "utf-8")) as { hints: unknown[] };
    expect(mem.hints).toHaveLength(1);                               // still one stable handle
  }, 240_000);

  it("without the flag nothing is written and the model is asked every time (control)", async () => {
    const { planFile } = suite();
    const calls = countingModel();
    await cmdRun(args(planFile, null), io);
    const afterFirst = calls();
    await cmdRun(args(planFile, null), io);
    expect(calls()).toBeGreaterThan(afterFirst);
  }, 240_000);

  it("accepts an injected in-memory store (the test seam)", async () => {
    const { planFile } = suite();
    countingModel();
    const mem = createHintMemory();
    const res = await cmdRun(args(planFile, null), io, { hintMemory: mem });
    expect(res.finished).toBe(true);
    expect(mem.stats().entries).toBe(1);
  }, 180_000);
});
