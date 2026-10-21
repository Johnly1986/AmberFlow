/**
 * The ONNX port's acceptance tests.
 *
 * Two layers:
 *   - the shortlist contract runs everywhere (a scripted agent, no checkpoint);
 *   - the heavy cases run ONLY when the exported graph, the HF snapshot's
 *     tokenizer and the Python parity reference are all present, and are skipped
 *     otherwise so `npm test` stays green and fast on a box without 1.7 GB of
 *     weights. They compare one real forward pass against
 *     `node-port-poc/laya_parity_ref.json` (Python ORT), check noul, and pin the
 *     built sequence against the Python reference's ids/markers so a wrong
 *     argument (state where the criteria belong) cannot pass silently.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ONNX_PATH, DEFAULT_SHORTLIST_K, LayaTokenizer, createLayaOnnxRuntime,
  findDefaultTokenizerDir, prepareQuestionSequences,
} from "../src/model/laya-onnx.ts";
import { buildSequence } from "../src/model/laya-format.ts";
import { scriptedAgent, type ChoiceAnswer, type NoulAnswer, type Question } from "../src/model/model.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const REF_PATH = path.join(here, "..", "node-port-poc", "laya_parity_ref.json");
const ONNX_PATH = process.env.LAYAA_ONNX_MODEL ?? process.env.LAYA_ONNX_MODEL ?? DEFAULT_ONNX_PATH;
const TOKENIZER_DIR = process.env.LAYAA_TOKENIZER_DIR ?? process.env.LAYA_TOKENIZER_DIR ?? findDefaultTokenizerDir();

const MISSING = [
  fs.existsSync(ONNX_PATH) ? null : `graph ${ONNX_PATH}`,
  TOKENIZER_DIR && fs.existsSync(path.join(TOKENIZER_DIR, "tokenizer.json")) ? null : "tokenizer dir",
  fs.existsSync(REF_PATH) ? null : `reference ${REF_PATH}`,
].filter((x): x is string => x !== null);
const HEAVY = MISSING.length === 0;
const heavy = HEAVY ? describe : describe.skip;

interface ParityRef {
  ids: number[];
  markers: number[];
  probs: number[];
  conf: number;
  text: { ins: string; crit: string[]; state: { url: string; text: string } };
}

const ref: ParityRef | null = fs.existsSync(REF_PATH)
  ? JSON.parse(fs.readFileSync(REF_PATH, "utf-8")) as ParityRef
  : null;

/** The POC's real question: a 4-option CJK choice over a `{url, text}` state. */
function pocQuestion(): Question {
  const r = ref!;
  return {
    type: "choice",
    instructions: r.text.ins,
    criteria: Object.fromEntries(r.text.crit.map((label) => [label, null])),
  };
}

/* ------------------------------------------------ shortlist contract (fast) */

describe("predictShortlist semantics (no checkpoint)", () => {
  const runtime = createLayaOnnxRuntime();
  const scripted = (): ReturnType<typeof scriptedAgent> =>
    scriptedAgent((key, _state, questions) => {
      const labels = Object.keys((questions[key]?.criteria as Record<string, unknown>) ?? {});
      const weights = Object.fromEntries(labels.map((label, i) => [label, labels.length - i]));
      return { choice: labels[0]!, probabilities: weights, confidence: 0.42 };
    });
  const question = (labels: string[]): Question => ({
    type: "choice",
    instructions: "pick one",
    criteria: Object.fromEntries(labels.map((l) => [l, l.toUpperCase()])),
  });

  it(`defaults to k=${DEFAULT_SHORTLIST_K} and passes through when it keeps everything`, async () => {
    const labels = ["a", "b", "c", "d"];
    const res = await runtime.predictShortlist(scripted(), {}, { act: question(labels) });
    expect(res.shortlist?.act).toEqual({ passthrough: true, kept: labels });
    const a = res.answers["act"] as ChoiceAnswer;
    expect(a.choice).toBe("a");
    // passthrough must NOT re-normalise: the model's own probability is returned
    expect(a.probabilities).toEqual({ a: 4, b: 3, c: 2, d: 1 });
    expect(a.confidence).toBe(0.42);
  });

  it("keeps top-k and re-normalises over the kept subset when options exceed k", async () => {
    const res = await runtime.predictShortlist(
      scripted(), {}, { act: question(["a", "b", "c", "d", "e"]) }, { k: 3 },
    );
    expect(res.shortlist?.act).toEqual({ passthrough: false, kept: ["a", "b", "c"] });
    const a = res.answers["act"] as ChoiceAnswer;
    expect(Object.keys(a.probabilities)).toEqual(["a", "b", "c"]);
    expect(a.choice).toBe("a");
  });

  it("leaves non-choice questions untouched and outside the shortlist meta", async () => {
    const agent = scriptedAgent((key) =>
      key === "act"
        ? { choice: "a", probabilities: { a: 1 }, confidence: 1 }
        : { noul: 0.25 });
    const res = await runtime.predictShortlist(
      agent, {}, { act: question(["a", "b"]), guard: { type: "noul", instructions: "safe?" } },
    );
    expect((res.answers["guard"] as NoulAnswer).noul).toBe(0.25);
    expect(Object.keys(res.shortlist ?? {})).toEqual(["act"]);
  });

  it("rejects a non-positive k instead of guessing", async () => {
    await expect(
      runtime.predictShortlist(scripted(), {}, { act: question(["a", "b"]) }, { k: 0 }),
    ).rejects.toThrow(/k must be a positive integer/);
  });

  it("ranks by embed_fn cosine when one is supplied (Python's shortlist path)", async () => {
    const labels = ["a", "b", "c", "d", "e"];
    // Row 0 is the query; rows 1..5 are the options in criteria order.
    const docs = [[0, 1], [0.2, 0.98], [1, 0], [0.5, 0.87], [0.99, 0.14]];
    const embedFn = (texts: string[]) => texts.map((_t, i) => (i === 0 ? [1, 0] : docs[i - 1]!));
    const res = await runtime.predictShortlist(
      scripted(), {}, { act: question(labels) }, { k: 2, embedFn },
    );
    expect(res.shortlist?.act).toEqual({ passthrough: false, kept: ["c", "e"] });
    expect(Object.keys((res.answers["act"] as ChoiceAnswer).probabilities)).toEqual(["c", "e"]);
  });

  it("embedFnFromAgent returns null (deterministic state text, no embeddings)", () => {
    expect(runtime.embedFnFromAgent(scripted())).toBeNull();
  });

  it("load() names the missing artifact instead of failing deep inside ORT", async () => {
    const missing = path.join(here, "no-such-artifacts", "laya_dec.onnx");
    const rt = createLayaOnnxRuntime({ onnxPath: missing, tokenizerDir: path.join(here, "no-such-tokenizer") });
    await expect(rt.load("convaiinnovations/laya")).rejects.toThrow(/ONNX graph not found/);
  });
});

/* --------------------------------------------------- heavy cases (skipped) */

heavy(`laya ONNX parity${HEAVY ? "" : ` (skipped: missing ${MISSING.join(", ")})`}`, () => {
  const timeout = 300_000;
  const r = ref!;
  // One runtime/agent for the whole suite: the session maps 1.7 GB once.
  const runtime = createLayaOnnxRuntime({ onnxPath: ONNX_PATH, tokenizerDir: TOKENIZER_DIR! });
  let agent: Awaited<ReturnType<typeof runtime.load>> | null = null;
  const loaded = async () => (agent ??= await runtime.load("convaiinnovations/laya"));

  it("reproduces the Python reference probs/conf for the POC question", async () => {
    const a = await loaded();
    const res = await runtime.predictShortlist(
      a, r.text.state, { act: pocQuestion() },
      { embedFn: runtime.embedFnFromAgent(a), k: DEFAULT_SHORTLIST_K },
    );
    expect(res.shortlist?.act).toEqual({ passthrough: true, kept: r.text.crit });

    const answer = res.answers["act"] as ChoiceAnswer;
    const refBest = r.probs.indexOf(Math.max(...r.probs));
    expect(answer.choice).toBe(r.text.crit[refBest]);
    expect(answer.choice).toBe("加购物车");
    r.text.crit.forEach((label, i) => {
      expect(answer.probabilities[label], `prob[${label}]`).toBeCloseTo(r.probs[i]!, 3);
    });
    expect(answer.confidence).toBeCloseTo(r.conf, 3);
  }, timeout);

  it("answers a noul question with P(true) in [0, 1]", async () => {
    const a = await loaded();
    const res = await a.predict(r.text.state, {
      guard: {
        type: "noul",
        instructions: "Does the page confirm the item is already in the shopping cart?",
      },
    });
    const noul = (res.answers["guard"] as NoulAnswer).noul;
    expect(typeof noul).toBe("number");
    expect(noul).toBeGreaterThanOrEqual(0);
    expect(noul).toBeLessThanOrEqual(1);
  }, timeout);

  it("builds the exact Python sequence (ids + markers) for that question", async () => {
    const tok = await LayaTokenizer.fromDir(TOKENIZER_DIR!);
    const prepared = prepareQuestionSequences(tok, r.text.state, { act: pocQuestion() }, 512, 192);
    expect(prepared).toHaveLength(1);
    const p = prepared[0]!;
    expect(p.qtype).toBe(0);                                     // choice
    expect(p.markers).toHaveLength(r.text.crit.length);        // 4 options -> 4 markers
    expect(p.ids.length).toBeLessThanOrEqual(512);

    // The same call the runtime makes internally must equal the Python reference
    // ids — this is what catches a state/question argument swap.
    const direct = buildSequence(tok, r.text.state, {
      type: "choice", instructions: r.text.ins, criteria: pocQuestion().criteria,
    }, 512, 192);
    expect(p.ids).toEqual(direct.ids);
    expect(p.markers).toEqual(direct.markers);
    expect(p.ids).toEqual(r.ids);
    expect(p.markers).toEqual(r.markers);
  }, timeout);
});

/**
 * Regression: the exported graph's TopK is STATIC (k=2), so asking the model a
 * `choice` question with ONE option used to die inside ORT —
 * "k argument [2] should not be greater than specified axis dim value [1]".
 * Torch has no such limit, so the Python reference answers it; the runtime now
 * short-circuits it (one option is the argmax; entropy confidence of a 1-option
 * distribution is 1.0). Found by the fixture bench matrix on
 * `spa-overlay-dismiss`, where the cookie overlay leaves exactly one pickable
 * element — every other fixture has >= 2.
 */
// `heavy` is a describe-wrapper; these are standalone cases, so gate with runIf.
it.runIf(HEAVY)("a single-option choice is answered without a forward pass", async () => {
  const rt = createLayaOnnxRuntime({ onnxPath: ONNX_PATH, tokenizerDir: TOKENIZER_DIR! });
  const agent = await rt.load("convaiinnovations/laya");
  const res = await agent.predict({ text: "click something" }, {
    act: {
      type: "choice",
      instructions: "which element?",
      criteria: { only: 'button "Accept"' },
    },
  });
  const a = res.answers.act as { choice: string; probabilities: Record<string, number>; confidence: number };
  expect(a.choice).toBe("only");
  expect(a.probabilities).toEqual({ only: 1 });
  expect(a.confidence).toBe(1);
}, 120_000);

/**
 * The same question with TWO options must still go through the model (the
 * short-circuit must not become a "single option or nothing" gate).
 */
it.runIf(HEAVY)("two options still run the model", async () => {
  const rt = createLayaOnnxRuntime({ onnxPath: ONNX_PATH, tokenizerDir: TOKENIZER_DIR! });
  const agent = await rt.load("convaiinnovations/laya");
  const res = await agent.predict({ text: "click something" }, {
    act: {
      type: "choice",
      instructions: "which element?",
      criteria: { a: 'button "Accept"', b: 'button "Reject"' },
    },
  });
  const a = res.answers.act as { choice: string; probabilities: Record<string, number> };
  expect(["a", "b"]).toContain(a.choice);
  expect(Object.keys(a.probabilities).sort()).toEqual(["a", "b"]);
}, 120_000);
