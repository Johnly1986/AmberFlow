/**
 * `npm run metrics` 的刷新**不能把外部快照字段清成"未测"**——这是 2026-10-14 实测踩到的坑：
 * 裸跑一次 metrics（没给 `--tests`、`/tmp/model-contribution.json` 不在），旧实现会把
 * `tests.count` 与 `model.harness` 一起抹掉，而三张架构图插值这些字段 ⇒ 图门禁同时红
 * （"刷新计量"这个动作本身打爆了门禁）。
 *
 * 修好后的性质：能算的（corpus）永远新鲜；算不出来的（tests/model 快照）在源缺席时
 * **沿用已入库的值并标 carried**，只有从没有过快照才落"未测"。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..");

function runMetrics(): Record<string, any> {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "af-metrics-")), "m.json");
  execFileSync("node", ["--experimental-strip-types", "tools/arch-metrics.ts", "--out", out],
    { cwd: REPO, encoding: "utf-8", stdio: "pipe" });   // 裸跑：无 --tests
  return JSON.parse(fs.readFileSync(out, "utf-8")) as Record<string, any>;
}

describe("arch-metrics 刷新不抹快照", () => {
  it("无 --tests 时 tests.count 沿用已入库值（不是 null）", () => {
    const m = runMetrics();
    expect(typeof m.tests.count).toBe("number");
    expect(m.tests.count).toBeGreaterThan(0);
    expect(String(m.tests.source)).toContain("沿用");
  });

  it("model-contribution 产物缺席时 harness 保留 numeric（图门禁依赖它），并标 carried", () => {
    const m = runMetrics();
    const h = m.model.harness;
    // 只要仓库里有过一次真模型跑的冻结数，刷新就不该把它清成 {note}
    expect(h.numeric).toBeTruthy();
    expect(typeof h.numeric.top1_pct).toBe("number");
    expect(String(h.carried ?? "")).toContain("沿用");
  });

  it("corpus 段永远是实时算出来的（带 journey 包数 > 0，且与 --check 同一条计算）", () => {
    const m = runMetrics();
    expect(m.corpus.packs_with_journey).toBeGreaterThan(0);
    expect(m.corpus.hint_coverage.named).toBeGreaterThan(0);
  });
});
