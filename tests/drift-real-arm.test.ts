/**
 * **R1（第二次目的审查 2026-10-14 立项）：漂移族真模型臂进门禁。**
 *
 * 审查的验收判据："臂进 verify 的可选档；0/3 或任何变化都有冻结产物。"
 * 这里跑的是**不依赖模型**的那一半：
 *   ① 已入库产物 `bench/drift-real-arm.json` 记两条臂——plain（今天）0/3 与
 *      **A2′（裁决）3/3**（谁悄悄改了它，这里红）；A2′ 那一列就是"运行期弹性"第一次有的数字；
 *   ② `compareVerdicts` 是纯函数——它能抓到"某格从红翻绿"，正是逼作者显式
 *      `--write` + 改这张期望表的机制（同 W0 的 `tests/gate-signals.test.ts`）。
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
      recovered: string; cells: CellVerdict[];
      recovered_adjudicated: string; cells_adjudicated: CellVerdict[]; note: string;
    };
    // plain 臂 = 今天：三格全红，红因是"低置信"（不是崩溃/超时），conf 全在 0.25 闸门外。
    expect(doc.recovered).toBe("0/3");
    expect(doc.cells).toHaveLength(3);
    for (const c of doc.cells) {
      expect(c.done).toBe(false);
      expect(c.stop).toMatch(/low confidence .* < floor/);
    }
    const confs = doc.cells.map((c) => Number(/([\d.]+)/.exec(String(c.stop))?.[1] ?? "1"));
    expect(Math.max(...confs)).toBeLessThan(0.25);
    // A2′ 臂 = 裁决：三格全绿，且是 `laya:adjudicated` 兜回的——
    // 模型低置信下其实**选对了**，是闸门把正确答案丢了；让信号裁决，三格全恢复。
    // 这是"运行期弹性"第一次有数字背书（审查 §B2 的 0/3 变成 3/3）。
    expect(doc.recovered_adjudicated).toBe("3/3");
    for (const c of doc.cells_adjudicated) {
      expect(c.done).toBe(true);
      expect(c.method).toBe("laya:adjudicated");
    }
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
