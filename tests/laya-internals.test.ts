/**
 * Inference-side assertions ported from `test_laya.py` (the 37-test suite that
 * covers the pip package's internals). The training-side half — `proper_reward`,
 * temperature FITTING — is deliberately out of scope for the port (there is no
 * training code in the TS project) and is recorded in
 * tests/migration-completeness.test.ts instead.
 */
import { describe, expect, it } from "vitest";
import {
  QTYPES, QTYPE_NAMES, confidenceFromProbs, eceScore, renderOptions, scoreExpectedValue,
  serializeState, tempBucket, toInternal,
} from "../src/model/laya-format.ts";

describe("serialize_state", () => {
  it("passes strings through and keeps a dict's non-ASCII text", () => {
    expect(serializeState("hello")).toBe("hello");
    expect(serializeState({ text: "无线鼠标" })).toBe('{"text": "无线鼠标"}');
  });
});

describe("render_options", () => {
  it("choice: a description-less option is just its key; null and '' both mean 'no description'", () => {
    expect(renderOptions({ type: "choice", criteria: { a: null, b: "", c: "desc" } }))
      .toEqual(["a", "b", "c: desc"]);
  });

  it("choice: a structured value renders as compact JSON (not a Python repr)", () => {
    expect(renderOptions({ type: "choice", criteria: { a: { score: 3, why: "cheap" } } }))
      .toEqual(['a: {"score": 3, "why": "cheap"}']);
  });

  it("score: numbered levels", () => {
    expect(renderOptions({ type: "score", criteria: ["bad", "ok", "great"] }))
      .toEqual(["level 0: bad", "level 1: ok", "level 2: great"]);
  });

  it("noul: defaults to the false/true phrasing, and honours custom criteria", () => {
    expect(renderOptions({ type: "noul", criteria: null }))
      .toEqual(["false: no, the statement does not hold", "true: yes, the statement holds"]);
    expect(renderOptions({ type: "noul", criteria: { false: "not yet", true: "done" } }))
      .toEqual(["false: not yet", "true: done"]);
  });
});

describe("confidence_from_probs", () => {
  it("one-hot is max, uniform is zero, a single option is 1.0", () => {
    // pytest.approx's default tolerance is 1e-6; the p=0 entries are clipped to
    // 1e-12 exactly like numpy's np.clip, so 1.0 is not bit-exact.
    expect(confidenceFromProbs([1, 0, 0], 3)).toBeCloseTo(1.0, 6);
    expect(confidenceFromProbs([1 / 3, 1 / 3, 1 / 3], 3)).toBeCloseTo(0.0, 6);
    expect(confidenceFromProbs([1.0], 1)).toBe(1.0);
  });

  it("is monotone in sharpness", () => {
    const sharp = confidenceFromProbs([0.9, 0.05, 0.05], 3);
    const mid = confidenceFromProbs([0.5, 0.3, 0.2], 3);
    const flat = confidenceFromProbs([0.4, 0.3, 0.3], 3);
    expect(sharp).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(flat);
  });
});

describe("temperature bucket boundaries (exactly the Python assertions)", () => {
  it("maps (qtype, k) to the fitted-temperature key", () => {
    expect(tempBucket(0, 2)).toBe("choice:2");
    expect(tempBucket(1, 4)).toBe("score:3-5");
    expect(tempBucket(2, 7)).toBe("noul:6-10");
    expect(tempBucket(0, 11)).toBe("choice:11+");
  });

  it("keeps the qtype tables inverse", () => {
    for (const [name, idx] of Object.entries(QTYPES)) {
      expect(QTYPE_NAMES[idx]).toBe(name);
    }
  });
});

describe("score readout", () => {
  it("E[level] = sum(i * p_i)", () => {
    expect(scoreExpectedValue([0.2, 0.5, 0.3])).toBeCloseTo(0.2 * 0 + 0.5 * 1 + 0.3 * 2, 10);
  });
});

describe("ece_score", () => {
  it("perfect calibration is zero", () => {
    expect(eceScore([0.0, 1.0], [0, 1])).toBeCloseTo(0.0, 10);
  });

  it("well-calibrated beats overconfident", () => {
    const conf = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    const well = conf.map((c) => (c > 0.5 ? 1 : 0));
    const over = new Array<number>(10).fill(1);      // always certain
    const wellEce = eceScore(conf, well);
    const overEce = eceScore(over, over.map(() => 0));
    expect(wellEce).toBeLessThan(overEce);
  });

  it("overconfidence is positive", () => {
    expect(eceScore([0.9, 0.9], [0, 0])).toBeGreaterThan(0);
  });

  it("no samples is NaN (not 0)", () => {
    expect(Number.isNaN(eceScore([], []))).toBe(true);
  });
});

describe("to_internal", () => {
  it("choice with a LIST criteria becomes a key->null dict", () => {
    expect(toInternal({ type: "choice", instructions: "pick", criteria: ["a", "b"] }))
      .toEqual({ t: "choice", ins: "pick", crit: { a: null, b: null } });
  });

  it("non-string instructions are JSON-encoded", () => {
    expect(toInternal({ type: "noul", instructions: { q: "done?" } as never }))
      .toEqual({ t: "noul", ins: '{"q":"done?"}', crit: null });
  });
});
