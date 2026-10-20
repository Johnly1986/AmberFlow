#!/usr/bin/env node
/**
 * Slice-level calibration report for the DECISION model.
 *
 * C3-R (the same-base application) requires "held-out, slice-specific calibration
 * before making a decision" and abstains when calibration is missing. This tool asks
 * the only question that can justify such a gate here: **is the local model's pick
 * confidence actually informative on our pages, per slice?**
 *
 * Labels come from the run itself, no human required:
 *   - executed & NOT inert  -> the action changed the page  ("effective")
 *   - executed & inert      -> the action did nothing        ("ineffective")
 *   - not executed          -> no outcome (abstained / blocked) -> EXCLUDED
 *
 * That label is coarse (an effective action can still be the wrong one), so the
 * report is read as an *upper bound* on pick quality; ECE is the model author's own
 * metric (`laya.common.ece_score`, ported as `eceScore` in src/laya-format.ts).
 *
 *   node --experimental-strip-types tools/calibration.ts bench/results/live-r3-*.json ...
 *   node --experimental-strip-types tools/calibration.ts --rules-off   # any run, any tag
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eceScore } from "../src/laya-format.ts";
import { REPO } from "../src/flow.ts";
import { applyRcToEnv } from "../src/rcfile.ts";

export interface PickSample {
  case: string;
  model: string;
  slice: string;
  conf: number;
  /** action-level label: the action changed the page */
  effective: boolean;
  /** task-level label: the subgoal this pick belonged to was completed */
  taskDone: boolean;
  margin: number | null;
  inert: boolean;
  executed: boolean;
}

/** Pull model-driven steps out of bench result files (the recorded traces). */
export function samplesFromFiles(files: string[]): PickSample[] {
  const out: PickSample[] = [];
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(f, "utf-8")) as {
      detail?: Array<{
        case: string; model?: string;
        results?: Array<{ steps?: Array<Record<string, unknown>> }>;
      }>;
    };
    for (const c of data.detail ?? []) {
      const model = String(c.model ?? "english");
      // slice = language family of the run + the question type the pick answered
      for (const r of c.results ?? []) {
        const taskDone = Boolean((r as { done?: unknown }).done);
        for (const s of r.steps ?? []) {
          const method = String(s.method ?? "");
          if (!(method.startsWith("laya") || method === "escalate")) continue;
          const executed = Boolean(s.executed);
          const inert = Boolean(s.inert);
          out.push({
            case: c.case, model,
            slice: `${model}${method.includes("reobserve") ? "+reobserve" : method === "escalate" ? "+escalate" : ""}`,
            conf: Number(s.conf ?? 0),
            effective: executed && !inert,
            taskDone,
            margin: typeof s.margin === "number" ? s.margin : null,
            inert, executed,
          });
        }
      }
    }
  }
  return out;
}

export interface SliceReport {
  slice: string;
  n: number;
  accuracy: number;
  meanConfidence: number;
  ece: number;
  /** same table, labelled by SUBGOAL completion instead of page change */
  taskAccuracy: number;
  taskEce: number;
  buckets: Array<{ lo: number; hi: number; n: number; conf: number; acc: number }>;
}

/** Reliability table + ECE for one slice (bins of the model's own confidence). */
export function report(samples: PickSample[], bins = 5): SliceReport[] {
  const bySlice = new Map<string, PickSample[]>();
  for (const s of samples) {
    if (!s.executed) continue;                       // no outcome -> excluded
    const list = bySlice.get(s.slice) ?? [];
    list.push(s);
    bySlice.set(s.slice, list);
  }
  const out: SliceReport[] = [];
  for (const [slice, list] of bySlice) {
    const conf = list.map((s) => s.conf);
    const correct = list.map((s) => (s.effective ? 1 : 0));
    const buckets = Array.from({ length: bins }, (_v, i) => {
      const lo = i / bins, hi = (i + 1) / bins;
      const sel = list.filter((s) => s.conf > lo && s.conf <= hi);
      return {
        lo, hi, n: sel.length,
        conf: sel.length ? sel.reduce((a, s) => a + s.conf, 0) / sel.length : 0,
        acc: sel.length ? sel.filter((s) => s.effective).length / sel.length : 0,
      };
    });
    const taskCorrect = list.map((s) => (s.taskDone ? 1 : 0));
    out.push({
      slice, n: list.length,
      accuracy: correct.reduce<number>((a, b) => a + b, 0) / list.length,
      meanConfidence: conf.reduce((a, b) => a + b, 0) / list.length,
      ece: eceScore(conf, correct, bins),
      taskAccuracy: taskCorrect.reduce<number>((a, b) => a + b, 0) / list.length,
      taskEce: eceScore(conf, taskCorrect, bins),
      buckets,
    });
  }
  return out.sort((a, b) => b.n - a.n);
}

export function format(reports: SliceReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    const f = (x: number): string => (Number.isNaN(x) ? "n/a" : x.toFixed(3));
    lines.push(`slice ${r.slice}: n=${r.n}  mean_conf=${f(r.meanConfidence)}  `
      + `| action-level: acc=${f(r.accuracy)} ECE=${f(r.ece)}  `
      + `| task-level: done=${f(r.taskAccuracy)} ECE=${f(r.taskEce)}`);
    for (const b of r.buckets) {
      if (!b.n) continue;
      lines.push(`    conf ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}: n=${String(b.n).padStart(3)}  `
        + `mean_conf=${f(b.conf)}  effective=${f(b.acc)}`);
    }
  }
  return lines.join("\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // rc 文件坏 = 配置类用法错误：在任何腿出场之前逐行点名并 exit 2（src/rcfile.ts）。
  { const rc = applyRcToEnv(); if (rc.errors.length) { for (const e of rc.errors) console.error(e); return 2; } }
  let files = argv.filter((a) => !a.startsWith("-"));
  if (!files.length) {
    const dir = path.join(REPO, "bench", "results");
    files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f))
      : [];
  }
  if (!files.length) {
    console.error("no recorded runs found; pass result JSON paths explicitly");
    return 2;
  }
  const samples = samplesFromFiles(files);
  if (!samples.length) {
    console.log(`${files.length} file(s), 0 model-driven steps — every step was resolved by rule.`);
    return 0;
  }
  console.log(`${files.length} file(s), ${samples.length} model-driven steps `
    + `(${samples.filter((s) => !s.executed).length} without an outcome -> excluded)\n`);
  console.log(format(report(samples)));
  const ineffective = samples.filter((s) => s.executed && !s.effective);
  if (ineffective.length) {
    console.log("\nineffective picks (executed, page unchanged):");
    for (const s of ineffective) {
      console.log(`  ${s.case}: conf=${s.conf.toFixed(3)} margin=${s.margin === null ? "-" : s.margin.toFixed(3)}`);
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
