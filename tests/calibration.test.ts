/**
 * The calibration instrument (tools/calibration.ts).
 *
 * C3-R — the same-base application — refuses to decide without "held-out,
 * slice-specific calibration". This repo had the model author's ECE metric ported
 * (`eceScore`) but never applied it to DECISIONS; these tests pin the pipeline that
 * does: recorded traces -> per-slice reliability + ECE, on two labels (did the
 * action change the page, did the subgoal complete).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { report, samplesFromFiles, type PickSample } from "../tools/calibration.ts";

const pick = (conf: number, effective: boolean, extra: Partial<PickSample> = {}): PickSample => ({
  case: "c", model: "english", slice: "english", conf,
  effective, taskDone: effective, margin: null, inert: !effective && extra.executed !== false,
  executed: true, ...extra,
});

describe("samplesFromFiles", () => {
  it("keeps model-driven steps and drops rule hits, with the outcome labels attached", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calib-"));
    const file = path.join(dir, "run.json");
    fs.writeFileSync(file, JSON.stringify({
      detail: [{
        case: "live-x", model: "english",
        results: [
          {
            done: true,
            steps: [
              { method: "rule:match", executed: true, conf: 1, url: "u" },              // not a model pick
              { method: "laya", executed: true, inert: false, conf: 0.4, margin: 0.2 }, // effective + task done
              { method: "laya:reobserve", executed: true, inert: true, conf: 0.3 },     // inert -> ineffective
            ],
          },
          { done: false, steps: [{ method: "laya", executed: true, inert: false, conf: 0.9 }] },
          { done: false, steps: [{ method: "laya", executed: false, conf: 0.2 }] },     // no outcome
        ],
      }],
    }), "utf-8");

    const s = samplesFromFiles([file]);
    expect(s).toHaveLength(4);
    expect(s.map((x) => x.slice)).toEqual(["english", "english+reobserve", "english", "english"]);
    expect(s[0]).toMatchObject({ effective: true, taskDone: true, executed: true });
    expect(s[1]).toMatchObject({ effective: false, inert: true, executed: true });
    expect(s[2]).toMatchObject({ taskDone: false });
    expect(s[3]).toMatchObject({ executed: false });
  });
});

describe("report", () => {
  it("excludes samples without an outcome and reports both labels", () => {
    const rows = report([
      pick(0.3, true), pick(0.35, true), pick(0.3, true),
      pick(0.9, false, { taskDone: true }),                       // ineffective action, task still done
      pick(0.2, true, { executed: false }),                       // excluded
    ]);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.n).toBe(4);
    expect(r.accuracy).toBeCloseTo(0.75, 6);
    expect(r.taskAccuracy).toBeCloseTo(1.0, 6);
    // the confidence signal points the wrong way here, so ECE must be large — this is
    // exactly the inversion the live run showed (low-conf band more effective)
    expect(r.ece).toBeGreaterThan(0.4);
    expect(r.buckets.filter((b) => b.n > 0).map((b) => b.n)).toEqual([3, 1]);
  });

  it("separates slices, so a per-slice gate has something to key on", () => {
    const rows = report([
      pick(0.5, true, { slice: "english" }), pick(0.5, true, { slice: "english" }),
      pick(0.5, false, { slice: "multilingual" }),
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.slice, r]));
    expect(by.english!.accuracy).toBe(1);
    expect(by.multilingual!.accuracy).toBe(0);
    expect(rows[0]!.slice).toBe("english");           // sorted by sample count
  });

  it("a perfectly calibrated slice has ECE ~ 0 (the metric is not degenerate)", () => {
    // conf 0.2 -> 20% effective, conf 0.8 -> 80% effective, within their bins
    const rows = report([
      ...Array.from({ length: 10 }, (_v, i) => pick(0.21, i < 2)),   // bin 0.2-0.4, 20%
      ...Array.from({ length: 10 }, (_v, i) => pick(0.81, i < 8)),   // bin 0.8-1.0, 80%
    ], 5);
    expect(rows[0]!.ece).toBeLessThan(0.05);
  });
});
