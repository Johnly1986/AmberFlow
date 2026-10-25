/**
 * 声明式脚本的**字段表**（`META_FIELD_MAP` 是唯一清单）：
 *   - 序列化（IR→脚本）与降级（脚本→IR）共用同一张表：加字段只改一处；
 *   - canonical 名字（camelCase）写盘；旧 snake 别名仍可读；
 *   - 未知 meta 字段**响亮拒绝**（拼错字段如果被静默忽略，表现会是"没生效"而不是"拼错了"）。
 */
import { describe, expect, it } from "vitest";
import {
  META_FIELD_MAP, lowerDeclarative, packToScriptSource, parseDeclarativeScript,
  type ScriptMeta,
} from "../src/app/declarative.ts";
import { expandPack, loadPack, type AppPack } from "../src/app/app-pack.ts";

const SAMPLES: Record<string, unknown> = {
  id: "field-app",
  label: "字段应用",
  goal: "验证字段表",
  model: "english",
  max_subgoals: 7,
  hosts: ["example.test"],
  slots: { a: "1" },
  required_slots: ["a"],
  sources: ["demo-tool"],
  device: { is_mobile: true },
  site: { pages: { home: "testpages/portal.html" }, listExtract: { rows: { rows: ".row", fields: { name: ".name" } } } },
  notes: ["note"],
  policy: { conf_floor: 0.4 },
  roles: { r: { desc: "d", start_url: "testpages/portal.html", target_hint: "#x", signal: { url_contains: "x" } } },
  probe: { date: "{date}" },
  invariants: [{ id: "inv", signal: { url_contains: "x" } }],
  recorded_from: { url: "testpages/product.html", steps: 1 },
  generated_from: { spec: "specs/demo.json", plan_sha256: "0".repeat(64) },
};

function basePack(): AppPack {
  return { spec_version: 1, id: "base", goal: "g", hosts: [], slots: {}, journey: [], invariants: [] } as unknown as AppPack;
}

describe("META_FIELD_MAP：序列化/降级共用的唯一字段表", () => {
  it("表覆盖全部字段（每项都有 meta/pack 名，camelCase 无 snake）", () => {
    expect(META_FIELD_MAP.length).toBeGreaterThanOrEqual(15);
    for (const f of META_FIELD_MAP) {
      expect(f.meta, f.pack).not.toMatch(/_/);
      expect(f.pack).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it.each(META_FIELD_MAP.map((f) => [f.pack, f] as const))(
    "%s：IR 里的值经 序列化→解析→降级 后逐字段回来",
    (packKey, field) => {
      const pack = basePack() as unknown as Record<string, unknown>;
      const sample = SAMPLES[packKey];
      expect(sample, packKey).not.toBeUndefined();
      pack[packKey] = sample;
      const source = packToScriptSource(pack as unknown as AppPack);
      const parts = parseDeclarativeScript(source);
      const back = lowerDeclarative(parts.meta, { data: parts.data, exec: parts.journey }) as unknown as Record<string, unknown>;
      expect(back[packKey]).toEqual(sample);
    },
  );

  it("序列化写 canonical 名字（不写 max_subgoals 这类旧名）", () => {
    const pack = basePack() as unknown as Record<string, unknown>;
    pack["max_subgoals"] = 7;
    pack["required_slots"] = ["a"];
    const source = packToScriptSource(pack as unknown as AppPack);
    expect(source).toContain('"maxSubgoals": 7');
    expect(source).toContain('"requiredSlots"');
    expect(source).not.toContain('"max_subgoals"');
  });

  it("旧脚本的 snake 别名仍可读（升级窗口）", () => {
    const meta = { id: "legacy", goal: "g", max_subgoals: 4, required_slots: ["x"] } as ScriptMeta;
    const back = lowerDeclarative(meta, { exec: [] }) as unknown as Record<string, unknown>;
    expect(back["max_subgoals"]).toBe(4);
    expect(back["required_slots"]).toEqual(["x"]);
  });

  it("未知 meta 字段 → 响亮拒绝（点名已知字段；`_` 前缀视为注释）", () => {
    expect(() => lowerDeclarative({ id: "x", goal: "g", invaraints: [] } as unknown as ScriptMeta, { exec: [] }))
      .toThrow(/meta\.invaraints: unknown field/);
    expect(() => lowerDeclarative({ id: "x", goal: "g", _comment: "ok" } as unknown as ScriptMeta, { exec: [] }))
      .not.toThrow();
    expect(() => lowerDeclarative({ id: "x", goal: "g" } as ScriptMeta, { exec: [], extra: 1 } as never))
      .toThrow(/app\.extra: unknown field/);
  });

  it("仓库应用整体 round-trip：脚本 → IR → 脚本 → IR 仍逐字段一致", () => {
    const original = loadPack("demo-app");
    const source = packToScriptSource(original);
    const parts = parseDeclarativeScript(source);
    const back = lowerDeclarative(parts.meta, { data: parts.data, exec: parts.journey });
    expect(expandPack(back).steps).toEqual(expandPack(original).steps);
    expect(back.invariants).toEqual(original.invariants);
  });
});
