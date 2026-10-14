/**
 * **R1（第二次目的审查 2026-10-14 立项）：漂移族真模型臂进门禁。**
 *
 * 审查的验收判据："臂进 verify 的可选档；0/3 或任何变化都有冻结产物。"
 * 这里跑的是**不依赖模型**的那一半：
 *   ① 已入库产物 `bench/drift-real-arm.json` 记的就是 0/3（谁悄悄改了它，这里红）；
 *   ② `compareVerdicts` 是纯函数——它能抓到"某格从红翻绿"，正是 W4′ 落地那天要逼
 *      作者显式 `--write` + 改这张期望表的机制（同 W0 的 `tests/gate-signals.test.ts`）。
 * 真跑模型的那一半在 `tools/drift-real-arm.ts --check`，由 `bench/smoke.sh` 的模型侧分支调
 * （无 1.7GB 产物时打印 SKIP——跳过 ≠ 通过）。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareVerdicts, type CellVerdict } from "../tools/drift-real-arm.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const ARTIFACT = path.join(REPO, "bench", "drift-real-arm.json");

describe("R1：漂移族真模型臂的冻结结论（不跑模型）", () => {
  it("已入库产物记 0/3——模型在漂移族红格上一格未兜回", () => {
    const doc = JSON.parse(fs.readFileSync(ARTIFACT, "utf-8")) as {
      recovered: string; cells: CellVerdict[]; note: string;
    };
    expect(doc.recovered).toBe("0/3");
    expect(doc.cells).toHaveLength(3);
    // 每一格都红，且红因是"低置信"而不是崩溃/超时（结构化停因，可核对）
    for (const c of doc.cells) {
      expect(c.done).toBe(false);
      expect(c.stop).toMatch(/low confidence .* < floor/);
    }
    // 三格的 conf 都远低于 0.25 闸门——这与审查 §2.3「小池子低置信」同源
    const confs = doc.cells.map((c) => Number(/([\d.]+)/.exec(String(c.stop))?.[1] ?? "1"));
    expect(Math.max(...confs)).toBeLessThan(0.25);
  });

  it("compareVerdicts 抓到某格从红翻绿（W4′ 落地那天不许悄悄发生）", () => {
    const recorded: CellVerdict[] = [
      { file: "d1.html", hint: "h", label: "①", done: false, method: null, conf: null, stop: "low confidence 0.04 < floor 0.25" },
    ];
    // 一致 ⇒ 无漂移
    expect(compareVerdicts(recorded, recorded.map((c) => ({ ...c })))).toEqual([]);
    // 翻绿 ⇒ 报漂移（要认它就得 --write + 改上面的期望，而不是让它悄悄绿）
    const flipped = recorded.map((c) => ({ ...c, done: true, method: "laya", conf: 0.6, stop: null }));
    const problems = compareVerdicts(recorded, flipped);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("①");
    expect(problems[0]).toContain("--write");
    // 产物缺格 ⇒ 也报（不许新增一格绕过比较）
    expect(compareVerdicts([], flipped)[0]).toContain("产物缺这一格");
  });
});
