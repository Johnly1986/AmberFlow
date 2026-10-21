/**
 * build_sequence / calibration parity with the Python reference.
 *
 * The corpus (tools/gen_laya_corpus.py) stores the EXACT text fragments the
 * Python algorithm encodes plus the real tokenizer's ids. The lookup tokenizer
 * below throws on an unknown text, so any divergence in text construction — the
 * Python `json.dumps` separator trap, a missing leading space on an option —
 * fails loudly instead of silently shifting every token position.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSequence, clampTemperature, confidenceFromProbs, pyJsonDumps,
  renderOptions, serializeState, tempBucket, type SeqTokenizer,
} from "../src/model/laya-format.ts";

interface Case {
  name: string;
  state: unknown;
  question: { type: "choice" | "score" | "noul"; instructions: string; criteria: unknown };
  max_len: number;
  head_max_len: number;
  truncate_left: boolean;
  specials: { cls: number; sep: number; mask: number };
  texts: { head: string; options: string[]; state: string };
  fragment_ids: { head: number[]; options: number[][]; state: number[] };
  expected: { ids: number[]; markers: number[] };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(here, "..", "tools", "laya-corpus.json"), "utf-8")) as {
  cases: Case[];
  calibration: {
    clamp: Array<{ repr: string; expected: number }>;
    buckets: Array<{ qtype: number; k: number; out: string }>;
    confidence: Array<{ p: number[]; k: number; out: number }>;
  };
};

/** Tokenizer backed by the corpus fragments: unknown text = port bug. */
function lookupTokenizer(c: Case): SeqTokenizer {
  const table = new Map<string, number[]>([[c.texts.head, c.fragment_ids.head]]);
  c.texts.options.forEach((t, i) => table.set(t, c.fragment_ids.options[i]!));
  table.set(c.texts.state, c.fragment_ids.state);
  return {
    maskToken: "[MASK]",
    clsTokenId: c.specials.cls,
    sepTokenId: c.specials.sep,
    maskTokenId: c.specials.mask,
    encode(text) {
      const ids = table.get(text);
      if (!ids) throw new Error(`tokenizer lookup miss (text drift): ${JSON.stringify(text.slice(0, 80))}`);
      return ids;
    },
  };
}

describe("build_sequence parity (9 cases from the Python reference)", () => {
  for (const c of corpus.cases) {
    it(c.name, () => {
      const { ids, markers } = buildSequence(
        lookupTokenizer(c),
        c.state as never,
        { type: c.question.type, instructions: c.question.instructions, criteria: c.question.criteria as never },
        c.max_len, c.head_max_len, null, c.truncate_left,
      );
      expect(markers).toEqual(c.expected.markers);
      expect(ids).toEqual(c.expected.ids);
    });
  }
});

describe("serialize / render (the python-json traps)", () => {
  it("uses Python's json.dumps separators (', ' and ': ')", () => {
    expect(serializeState({ url: "u", text: "t" })).toBe('{"url": "u", "text": "t"}');
    expect(pyJsonDumps([1, 2])).toBe("[1, 2]");
    expect(pyJsonDumps(true)).toBe("true");
    expect(pyJsonDumps(null)).toBe("null");
  });

  it("renders option texts exactly like the reference", () => {
    expect(renderOptions({ type: "choice", criteria: { a: null, b: "", c: 0, d: { x: 1 } } }))
      .toEqual(["a", "b", "c: 0", 'd: {"x": 1}']);
    expect(renderOptions({ type: "score", criteria: ["bad", "ok"] }))
      .toEqual(["level 0: bad", "level 1: ok"]);
    expect(renderOptions({ type: "noul", criteria: null }))
      .toEqual(["false: no, the statement does not hold", "true: yes, the statement holds"]);
  });
});

describe("calibration parity", () => {
  it("clamps temperatures into [0.5, 5] and falls back to 1.0", () => {
    const asValue = (repr: string): unknown =>
      repr === "nan" ? NaN : repr === "inf" ? Infinity : repr === "-inf" ? -Infinity
      : repr === "None" ? null : /^-?\d+(\.\d+)?$/.test(repr) ? Number(repr) : repr;
    for (const { repr, expected } of corpus.calibration.clamp) {
      expect(clampTemperature(asValue(repr)), `repr=${repr}`).toBeCloseTo(expected, 10);
    }
  });

  it("buckets by question type and option count", () => {
    for (const { qtype, k, out } of corpus.calibration.buckets) {
      expect(tempBucket(qtype, k)).toBe(out);
    }
  });

  it("computes entropy confidence", () => {
    for (const { p, k, out } of corpus.calibration.confidence) {
      expect(confidenceFromProbs(p, k)).toBeCloseTo(out, 10);
    }
  });
});
