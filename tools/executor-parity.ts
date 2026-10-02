/**
 * Executor cross-runtime parity: replay the shared scenarios through the TS
 * executor with a scripted model that is BEHAVIOURALLY IDENTICAL to the one the
 * Python reference dump used (`tools/dump_executor.py`), then diff the normalised
 * outcome (done / stop_reason / step count / per-step how+method).
 *
 *   python3 ts/tools/dump_executor.py        # Python reference
 *   cd ts && node --experimental-strip-types tools/executor-parity.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import * as browserEnv from "../src/browser-env.ts";
import { BrowserMiddleware } from "../src/executor.ts";
import { checkSignal } from "../src/signals.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer, type Question } from "../src/model.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..");

interface Scenario {
  id: string;
  fixture: string;
  instruction: string;
  signal: Record<string, unknown>;
  hint: string | null;
  confirm: boolean;
  model: { pick: string; confidence: number; risky: number; done: number };
}
const spec = JSON.parse(fs.readFileSync(path.join(here, "executor-scenarios.json"), "utf-8")) as { scenarios: Scenario[] };
const reference = JSON.parse(fs.readFileSync(path.join(here, "executor-python.json"), "utf-8")) as Record<string, {
  done: boolean; stop_reason: string; n_steps: number; steps: Array<{ how: unknown; method: unknown }>;
}>;

const NUM = /\d+\.\d+/g;
const normReason = (s: string): string => (s ?? "").replace(NUM, (m) => Number(m).toFixed(2));

/** Byte-for-byte the fake in dump_executor.py: noul always 0.0; choice picks the
 * first criterion whose text contains `model.pick` (else the first key). */
function fakeAgent(scen: Scenario) {
  return scriptedAgent((key: string, _state: unknown, questions: Record<string, Question>): Answer | undefined => {
    const q = questions[key];
    if (!q) return undefined;
    if (q.type === "noul") return { noul: 0.0 };
    const crit = (q.criteria ?? {}) as Record<string, unknown>;
    const keys = Object.keys(crit);
    const want = String(scen.model.pick ?? "").toLowerCase();
    const pick = keys.find((k) => want && String(crit[k] ?? "").toLowerCase().includes(want)) ?? keys[0]!;
    const conf = scen.model.confidence;
    const rest = (1 - conf) / Math.max(1, keys.length - 1);
    return {
      choice: pick,
      probabilities: Object.fromEntries(keys.map((k) => [k, k === pick ? conf : rest])),
      confidence: conf,
    };
  });
}

const pw = { chromium };
const browser: any = await browserEnv.launch(pw as never);
const ctx = await browser.newContext();
const page = await ctx.newPage();

let mismatched = 0;
for (const scen of spec.scenarios) {
  installLayaRuntime(scriptedRuntime(fakeAgent(scen)));
  await page.goto(pathToFileURL(path.join(REPO, scen.fixture)).href, { waitUntil: "domcontentloaded" });
  const mw = new BrowserMiddleware({ maxSteps: 4, confirmFn: () => scen.confirm });
  const rep = await mw.run(scen.instruction, page.url(), {
    goalSignalFn: (p: unknown) => checkSignal(p as never, scen.signal),
    page,
    pw: pw as never,
    targetHint: scen.hint,
    verbose: false,
  });
  const got = {
    done: rep.done,
    stop_reason: normReason(rep.stop_reason),
    n_steps: rep.steps.length,
    steps: rep.steps.map((s) => ({ how: s.how ?? null, method: s.method ?? null })),
  };
  const want = reference[scen.id]!;
  const same = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${same ? "OK  " : "DIFF"} ${scen.id}: done=${got.done} steps=${got.n_steps} (${got.stop_reason.slice(0, 48)})`);
  if (!same) {
    mismatched++;
    console.log(`   ts=${JSON.stringify(got)}`);
    console.log(`   py=${JSON.stringify(want)}`);
  }
}
await browser.close();
installLayaRuntime(null);

if (mismatched) {
  console.log(`\nVERDICT: ${mismatched}/${spec.scenarios.length} scenarios differ`);
  process.exit(1);
}
console.log(`\nVERDICT: 执行器与 Python 参考实现在 ${spec.scenarios.length} 个场景上结果一致`);
