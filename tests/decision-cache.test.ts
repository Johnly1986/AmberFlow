/**
 * Decision cache: exact-key memoisation of a DETERMINISTIC model, plus the JSONL
 * decision log that makes a run replayable.
 *
 * The point is not "learning across pages" — a changed state is a MISS by
 * construction (the key is a fingerprint of the state and the questions), and the
 * whole thing is disableable. The point is that retried subgoals, replans, resumed
 * runs and ablation re-runs re-ask questions that were already answered, and laya
 * answers them identically every time.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withDecisionCache } from "../src/decision-cache.ts";
import {
  installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer, type Question,
} from "../src/model.ts";

const STATE = { goal: "add to cart", url: "https://x/p", title: "P", main_text: "mouse" };
const QUESTIONS = {
  act: { type: "choice" as const, instructions: "which?", criteria: { e0: "a", e1: "b" } },
};

function counted() {
  let calls = 0;
  const agent = scriptedAgent((key): Answer => {
    calls += 1;
    if (key === "act") return { choice: "e0", probabilities: { e0: 0.9, e1: 0.1 }, confidence: 0.9 };
    return { noul: 0.1 };
  });
  return { agent, calls: () => calls };
}

describe("withDecisionCache", () => {
  it("answers an identical (state, question) from memory, and only that", async () => {
    const { agent, calls } = counted();
    const rt = withDecisionCache(scriptedRuntime(agent));
    const loaded = await rt.load("scripted");

    await loaded.predict(STATE, QUESTIONS);
    await loaded.predict(STATE, QUESTIONS);
    expect(calls()).toBe(1);
    expect(rt.decisionStats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });

    // a different state or a different option set is a fresh decision
    await loaded.predict({ ...STATE, url: "https://x/other" }, QUESTIONS);
    await loaded.predict(STATE, {
      act: { type: "choice", instructions: "which?", criteria: { e0: "a", e1: "b", e2: "c" } },
    });
    expect(calls()).toBe(3);
    expect(rt.decisionStats()).toMatchObject({ hits: 1, misses: 3, entries: 3 });

    // shortlist picks share the same store
    await rt.predictShortlist(loaded, STATE, QUESTIONS, { k: 8 });
    await rt.predictShortlist(loaded, STATE, QUESTIONS, { k: 8 });
    expect(rt.decisionStats().hits).toBe(2);
  });

  it("key order does not change the fingerprint (same content = same decision)", async () => {
    const { agent, calls } = counted();
    const rt = withDecisionCache(scriptedRuntime(agent));
    const loaded = await rt.load("scripted");
    await loaded.predict(STATE, QUESTIONS);
    await loaded.predict({ main_text: "mouse", title: "P", url: "https://x/p", goal: "add to cart" }, QUESTIONS);
    expect(calls()).toBe(1);
  });

  it("writes one JSONL record per decision, hits included", async () => {
    const { agent } = counted();
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dcache-")), "decisions.jsonl");
    const rt = withDecisionCache(scriptedRuntime(agent), { logPath });
    const loaded = await rt.load("scripted");
    await loaded.predict(STATE, QUESTIONS);
    await loaded.predict(STATE, QUESTIONS);
    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.cached)).toEqual([false, true]);
    expect(lines[0].questions).toEqual(["act"]);
    expect(lines[0].model).toBe("scripted/");
  });

  it("is bounded and resettable", async () => {
    const { agent } = counted();
    const rt = withDecisionCache(scriptedRuntime(agent), { max: 2 });
    const loaded = await rt.load("scripted");
    for (const url of ["a", "b", "c"]) await loaded.predict({ ...STATE, url }, QUESTIONS);
    expect(rt.decisionStats().entries).toBeLessThanOrEqual(2);
    rt.resetDecisionCache();
    expect(rt.decisionStats()).toMatchObject({ hits: 0, misses: 3, entries: 0 });
  });

  it("leaves a runtime without a cache alone (the wrapper is opt-in)", async () => {
    installLayaRuntime(null);
    const { agent, calls } = counted();
    const plain = scriptedRuntime(agent);
    const loaded = await plain.load("scripted");
    await loaded.predict(STATE, QUESTIONS);
    await loaded.predict(STATE, QUESTIONS);
    expect(calls()).toBe(2);
  });
});
