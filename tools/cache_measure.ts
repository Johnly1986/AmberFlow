#!/usr/bin/env node
/**
 * Measure the decision cache on the REAL model: run the same fixture cases twice
 * in one process, with and without the cache, and report model forwards + seconds.
 *
 *   node --experimental-strip-types tools/cache_measure.ts [caseId ...]
 *
 * Rationale (see decision-cache.ts): laya is deterministic, so a second identical
 * run — a resume, a replan, an ablation, a re-run of the same plan — re-asks
 * questions that were already answered.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCase, type BenchCase } from "../src/bench.ts";
import { withDecisionCache, type CachedRuntime } from "../src/decision-cache.ts";
import { createLayaOnnxRuntime } from "../src/laya-onnx.ts";
import { REPO } from "../src/flow.ts";
import { installLayaRuntime, type DecisionAgent, type LayaRuntime, type ModelState, type PredictResult, type Question } from "../src/model.ts";

const CASES = JSON.parse(fs.readFileSync(path.join(REPO, "bench", "cases.json"), "utf-8")).cases as BenchCase[];

/** A runtime that counts forwards and can be wrapped with the cache. */
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

async function runTwice(rt: LayaRuntime, cases: BenchCase[], agentsFor: (id: string) => Promise<DecisionAgent | null>) {
  const agents: Record<string, DecisionAgent | null> = {};
  for (const id of [...new Set(cases.map((c) => c.model ?? "english"))]) agents[id] = await agentsFor(id);
  const out: Array<{ run: number; secs: number }> = [];
  for (let run = 1; run <= 2; run++) {
    const t0 = Date.now();
    for (const c of cases) await runCase(c, agents);
    out.push({ run, secs: Math.round((Date.now() - t0) / 100) / 10 });
  }
  return out;
}

export async function main(): Promise<number> {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const cases = (wanted.length ? CASES.filter((c) => wanted.includes(c.id)) : CASES).slice(0, 3);
  console.log(`cases: ${cases.map((c) => c.id).join(", ")}\n`);

  const base = createLayaOnnxRuntime();

  const plain = counting(base);
  installLayaRuntime(plain.rt);              // the executor reaches the model through this seam
  const plainRuns = await runTwice(plain.rt, cases, (id) => plain.rt.load(id));
  const plainCalls = plain.calls();

  const backed = createLayaOnnxRuntime();
  installLayaRuntime(null);                  // rebuild from scratch for the cached phase
  // Counter INSIDE the cache: only real forwards are counted (a cache hit must not
  // be reported as a forward, which is exactly what the previous placement did).
  const inner = counting(backed);
  const cached = withDecisionCache(inner.rt) as CachedRuntime;
  installLayaRuntime(cached);
  const cachedRuns = await runTwice(cached, cases, (id) => cached.load(id));
  const cachedCalls = inner.calls();
  const stats = cached.decisionStats();

  console.log(`without cache : run1 ${plainRuns[0]!.secs}s  run2 ${plainRuns[1]!.secs}s   forwards=${plainCalls}`);
  console.log(`with cache    : run1 ${cachedRuns[0]!.secs}s  run2 ${cachedRuns[1]!.secs}s   forwards=${cachedCalls}`
    + `  hits=${stats.hits} misses=${stats.misses}`);
  console.log(`second run    : ${plainRuns[1]!.secs}s -> ${cachedRuns[1]!.secs}s`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
