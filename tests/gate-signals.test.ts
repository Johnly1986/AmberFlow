/**
 * **W0 的结论必须可复算，也不能被悄悄改掉。**
 *
 * 这个测试不跑模型（15 分钟那一步的产物已经冻结进 `bench/w0-model-contribution.json`，
 * 172 行逐题实测，与 `npm run model:contribution` 同形状、多了 `shape/pTop1/pTop2/margin`），
 * 它跑的是**分析**：三个候选闸门信号在同一份数据上的判别力。
 *
 * 钉住的不是"哪个信号好"，而是**这个否证本身**：
 * 2026-10-13 的 W0 实测显示 `confidence / pTop1 / margin` 三者在同 coverage 下
 * 都不优于现状（14.7% / 8% / 12%），且分桶后 AUC 全在 0.33–0.59 之间——
 * 也就是说"闸门读错了统计量"这个假设**被数据否掉了**。
 * 以后若有人想改闸门信号，得先让这张表变绿，而不是先改代码。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..");
const OUT = path.join(REPO, "bench", "w0-gate-signals.json");

function analyze(): Record<string, any> {
  execFileSync("node", ["--experimental-strip-types", "tools/gate-signals.ts",
    "--in", path.join(REPO, "bench", "w0-model-contribution.json"), "--out", OUT],
  { cwd: REPO, encoding: "utf-8", stdio: "pipe" });
  return JSON.parse(fs.readFileSync(OUT, "utf-8")) as Record<string, any>;
}

describe("W0：三个闸门信号同台比（结论钉在冻结语料上）", () => {
  it("162 步可判、margin 在全部可判行上都有定义", () => {
    const v = analyze();
    expect(v.judged).toBe(162);
    expect(v.margin_defined).toBe(162);
  }, 120_000);

  it("同 coverage（采纳 75 步）下：confidence 14.7% 是三者里最好的 ⇒ 换信号无收益", () => {
    const s = analyze().signals as Record<string, any>;
    expect(s["confidence (1−H/log k)"].at_baseline_coverage.precision).toBeCloseTo(14.7, 1);
    expect(s["pTop1"].at_baseline_coverage.precision).toBeLessThan(14.7);
    expect(s["margin (pTop1−pTop2)"].at_baseline_coverage.precision).toBeLessThan(14.7);
  }, 120_000);

  it("分桶后 confidence 不再是'反向'（0.48 / 0.533）——聚合的 0.325 是混合假象", () => {
    const s = analyze().signals as Record<string, any>;
    const conf = s["confidence (1−H/log k)"].by_bucket as Record<string, any>;
    expect(conf["3-5"].auc).toBeGreaterThanOrEqual(0.45);
    expect(conf["6-10"].auc).toBeGreaterThanOrEqual(0.45);
    expect(s["confidence (1−H/log k)"].auc_all).toBeLessThan(0.4);   // 聚合值仍然难看
  }, 120_000);

  it("margin 的否证与仓库早年的 C3-R 测量一致（都在 0.5 以下）", () => {
    const m = analyze().signals["margin (pTop1−pTop2)"] as Record<string, any>;
    expect(m.auc_all).toBeLessThan(0.5);
    for (const b of ["3-5", "6-10"]) {
      if (m.by_bucket[b]?.auc !== null) expect(m.by_bucket[b].auc).toBeLessThan(0.5);
    }
  }, 120_000);
});
