/**
 * 基线对照的**账**要钉住：它现在是谁都能碰的判据——"新决策模型要赢 first-candidate"。
 *
 * 两条腿：
 * ① 读已提交的 `bench/provider-baselines.json`，钉住首轮结论（快，不开浏览器）；
 * ② 真跑一格（demo-app × first-candidate，约 5 秒），证明**工具今天还能复现它**——
 *    只钉产物会变成"数字考古"，只真跑会把套件拖慢。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..");
const ART = path.join(REPO, "bench", "provider-baselines.json");

describe("决策提供者基线对照（bench/provider-baselines.json）", () => {
  it("首轮结论：零智能的 first-candidate 过 3/4，abstain 与 coin-flip 各 0/4", () => {
    const j = JSON.parse(fs.readFileSync(ART, "utf-8")) as {
      apps: string[]; results: Record<string, Record<string, { ok: boolean }>>;
    };
    const wins = (p: string): number => j.apps.filter((a) => j.results[a]?.[p]?.ok === true).length;
    expect(wins("first-candidate")).toBe(3);
    expect(wins("always-abstain")).toBe(0);
    expect(wins("coin-flip")).toBe(0);
    // 这三条一起构成结论本身：不是"基线总能过"，是"基线常常就够，而模型在这批上没做到"
    expect(j.results["ctrip-case"]?.["first-candidate"]?.ok).toBe(false);
  });

  it("工具今天仍能复现其中一格（demo-app × first-candidate ⇒ 通过）", () => {
    try {
      execFileSync("node", ["--experimental-strip-types", "tools/provider-baselines.ts",
        "--apps", "demo-app", "--providers", "first-candidate",
        "--out", "/tmp/pb-test.json"], { cwd: REPO, encoding: "utf-8", stdio: "pipe", timeout: 300_000 });
    } catch { /* 非零退出是结果不是故障 */ }
    const j = JSON.parse(fs.readFileSync("/tmp/pb-test.json", "utf-8")) as
      { results: Record<string, Record<string, { ok: boolean; completed: string }>> };
    expect(j.results["demo-app"]?.["first-candidate"]?.ok).toBe(true);
    expect(j.results["demo-app"]?.["first-candidate"]?.completed).toBe("5/5");
  }, 300_000);
});
