#!/usr/bin/env node
/**
 * Measure LEARNED HINTS on a repeat-the-same-plan protocol — no live-site noise.
 *
 * Round 5's live A/B could not attribute anything (three legs, 154/140/128 total steps,
 * Wikipedia error shells). This runs the SAME frozen cases twice IN ONE PROCESS, with the
 * authored hints stripped, so the only difference between run 1 and run 2 is what the plan
 * learned from run 1:
 *
 *   control : matrix twice, no memory          -> run 2 repeats run 1's model work
 *   learned : matrix twice, one shared memory  -> run 2 may resolve by rule at zero cost
 *
 * Counts REAL model forwards (the counter sits on the runtime, inside nothing), model-driven
 * steps and rule hits per leg.
 *
 *   node --experimental-strip-types tools/hint_measure.ts [caseId ...]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCase, type BenchCase } from "../src/bench.ts";
import { createHintMemory } from "../src/hint-memory.ts";
import { createLayaOnnxRuntime } from "../src/laya-onnx.ts";
import { REPO } from "../src/flow.ts";
import { installLayaRuntime, type DecisionAgent, type LayaRuntime, type ModelState, type PredictResult, type Question } from "../src/model.ts";

const CASES = JSON.parse(fs.readFileSync(path.join(REPO, "bench", "cases.json"), "utf-8")).cases as BenchCase[];

/** Strip the AUTHORED hints: that is the regime in which a learned hint is measurable. */
function withoutHints(c: BenchCase): BenchCase {
  const copy = structuredClone(c) as BenchCase;
  for (const sg of (copy.subgoals ?? []) as Array<{ target_hint?: string; target_hints?: string[] }>) {
    delete sg.target_hint;
    delete sg.target_hints;
  }
  return copy;
}

/** A runtime that counts real forwards (a cache/hint hit never reaches it). */
function counting(base: LayaRuntime): { rt: LayaRuntime; calls: () => number; reset: () => void } {
  let calls = 0;
  return {
    calls: () => calls,
    reset: () => { calls = 0; },
    rt: {
      ...base,
      async load(modelId, o) {
        const agent = await base.load(modelId, o);
        return {
          ...agent,
          async predict(state: ModelState, questions: Record<string, Question>): Promise<PredictResult> {
            calls += 1;
            return agent.predict(state, questions);
          },
        } as DecisionAgent;
      },
    },
  };
}

interface LegStat { forwards: number; steps: number; modelSteps: number; ruleSteps: number; cases: string; done: number }

function tally(cases: Array<Record<string, unknown>>): { steps: number; modelSteps: number; ruleSteps: number } {
  let steps = 0, modelSteps = 0, ruleSteps = 0;
  // BenchCaseResult.results[] are the SUBGOAL results; their `steps[]` holds the traces.
  for (const r of cases.flatMap((c) => (c["results"] as Array<Record<string, unknown>> | undefined) ?? [])) {
    for (const s of ((r["steps"] as Array<Record<string, unknown>> | undefined) ?? [])) {
      steps += 1;
      const m = String(s["method"] ?? "");
      if (m.startsWith("laya") || m === "escalate") modelSteps += 1;
      else if (m.startsWith("rule")) ruleSteps += 1;
    }
  }
  return { steps, modelSteps, ruleSteps };
}

async function runMatrix(
  cases: BenchCase[], rt: LayaRuntime, counter: { calls: () => number; reset: () => void },
  agents: Record<string, DecisionAgent | null>, hintMemory: ReturnType<typeof createHintMemory> | null,
): Promise<{ stat: LegStat; results: Array<Record<string, unknown>> }> {
  counter.reset();
  const results: Array<Record<string, unknown>> = [];
  for (const c of cases) results.push(await runCase(c, agents, null, hintMemory) as unknown as Record<string, unknown>);
  const t = tally(results);
  // Pass counts belong in the report: saving forwards by FAILING FASTER would look like a
  // win otherwise.
  const done = results.filter((c) => c["all_done"] === true).length;
  const sgDone = results.map((c) => String(c["subgoals_done"] ?? "?")).join(",");
  return { stat: { forwards: counter.calls(), ...t, cases: `${done}/${results.length}`, done: sgDone.length }, results };
}

export async function main(): Promise<number> {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const cases = (wanted.length ? CASES.filter((c) => wanted.includes(c.id)) : CASES).map(withoutHints);
  console.log(`cases: ${cases.map((c) => c.id).join(", ")}  (authored hints stripped)\n`);

  const line = (name: string, a: LegStat, b: LegStat): void => {
    console.log(`${name.padEnd(9)} run1 forwards=${String(a.forwards).padStart(3)} `
      + `(model ${a.modelSteps} / rule ${a.ruleSteps} of ${a.steps})   `
      + `run2 forwards=${String(b.forwards).padStart(3)} (model ${b.modelSteps} / rule ${b.ruleSteps} of ${b.steps})`);
    console.log(`${"".padEnd(9)} run1 cases=${a.cases}   run2 cases=${b.cases}`);
  };

  // --- control: no memory -------------------------------------------------
  const base1 = createLayaOnnxRuntime();
  const c1 = counting(base1);
  installLayaRuntime(c1.rt);
  const agents: Record<string, DecisionAgent | null> = {};
  for (const id of [...new Set(cases.map((c) => c.model ?? "english"))]) agents[id] = await c1.rt.load(id);
  const control1 = await runMatrix(cases, c1.rt, c1, agents, null);
  const control2 = await runMatrix(cases, c1.rt, c1, agents, null);
  line("control", control1.stat, control2.stat);

  // --- learned hints: one shared memory across both runs ------------------
  installLayaRuntime(null);
  const base2 = createLayaOnnxRuntime();
  const c2 = counting(base2);
  installLayaRuntime(c2.rt);
  const mem = createHintMemory();
  const agents2: Record<string, DecisionAgent | null> = {};
  for (const id of [...new Set(cases.map((c) => c.model ?? "english"))]) agents2[id] = await c2.rt.load(id);
  const learn1 = await runMatrix(cases, c2.rt, c2, agents2, mem);
  const learnedEntries = mem.stats().entries;
  const learn2 = await runMatrix(cases, c2.rt, c2, agents2, mem);
  line("learned", learn1.stat, learn2.stat);

  console.log(`\nhints learned in run 1: ${learnedEntries};  reused in run 2 (steps decided by one): ${mem.stats().used}`);
  console.log(`run 2 forwards: control ${control2.stat.forwards} -> learned ${learn2.stat.forwards}`
    + `  (saved ${control2.stat.forwards - learn2.stat.forwards})`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
