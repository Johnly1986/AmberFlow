/**
 * L1 等价性：**脚本版应用**与既有 `pack.json` 展开后逐字段相同。
 *
 * 这是 L1 的核心验收（计划 §5 退出条件 1）：脚本只是作者面，降级后必须产出**同一个 IR**。
 * 覆盖两条腿：
 *   - `camera-entry`：纯浏览器步（4 步有序 target_hints + 每步数据槽 + 3 条结束态不变量）；
 *   - `cli-report`：工具步（退出码/JSON/幂等重试/危险步干跑）。
 *
 * 比较的是 `expandPack(...)` 的语义输出（steps/invariants/slots/rolesUsed），不是字节——
 * 键顺序不是契约，行为才是。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandPack, loadPack } from "../src/app/app-pack.ts";
import { loadScriptApp, lowerScriptApp } from "../src/app/app-script.ts";
import { createKit } from "../src/app/kit.ts";
import { REPO } from "../src/flow/flow.ts";

const CASES = [
  ["camera-entry", "tests/fixtures/scripts/camera-entry.mjs"],
  ["cli-report", "tests/fixtures/scripts/cli-report.mjs"],
] as const;

describe("L1 等价：脚本降级 == 既有 pack.json 展开", () => {
  it.each(CASES)("%s：steps / invariants / slots / rolesUsed 逐字段相同", async (id, fixture) => {
    const scripted = await loadScriptApp(path.join(REPO, fixture));
    const legacy = loadPack(path.join(REPO, "apps", id, "pack.json"));
    const a = expandPack(scripted.pack);
    const b = expandPack(legacy);
    expect(a.steps).toEqual(b.steps);
    expect(a.invariants).toEqual(b.invariants);
    expect(a.slots).toEqual(b.slots);
    expect(a.rolesUsed).toEqual(b.rolesUsed);
  });

  it.each(CASES)("%s：声明面字段与既有包一致（hosts/sources/model/label/goal/max_subgoals）", async (id, fixture) => {
    const scripted = await loadScriptApp(path.join(REPO, fixture));
    const legacy = loadPack(path.join(REPO, "apps", id, "pack.json"));
    const pick = (p: typeof scripted.pack) => ({
      id: p.id, label: p.label, goal: p.goal, model: p.model,
      hosts: p.hosts ?? [], sources: p.sources ?? [],
      max_subgoals: p.max_subgoals,
    });
    expect(pick(scripted.pack)).toEqual(pick(legacy));
  });
});

describe("L1 降级：数据槽的两条来源", () => {
  const kit = createKit();

  it("字符串常量 → slots；kit.data.source(...) → source_slots", () => {
    const pack = lowerScriptApp(
      { id: "t", goal: "g", hosts: [], sources: ["s"], invariants: [] },
      {
        data: {
          coupon: "SAVE10",
          top: kit.data.source("s", { select: "top", field: "url" }),
        },
        exec: [],
      },
    );
    expect(pack.slots).toEqual({ coupon: "SAVE10" });
    expect((pack as unknown as Record<string, unknown>)["source_slots"]).toEqual({
      top: { source: "s", select: "top", field: "url" },
    });
  });

  it("非法 data 值在降级期就红（不是等到运行期）", () => {
    expect(() => lowerScriptApp(
      { id: "t", goal: "g", hosts: [], sources: [], invariants: [] },
      { data: { bad: { not: "a binding" } }, exec: [] },
    )).toThrow(/data\.bad/);
  });
});
