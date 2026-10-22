/**
 * 数据腿的结果**回写槽位**（`source_slots`）——审查各应用层实现后收敛出的那一份。
 *
 * 以前数据腿与旅程是两条各跑各的腿：`sources` 跑完只进报告，旅程用的槽位只能是人写死的
 * 默认值。于是"打开榜首番剧"这类应用必须先把榜首 URL 抄进包里（抄完就过期），而数据腿
 * 明明刚刚查到了它。回写声明的**取值点必须在数据源自己的声明里存在**（加载期查），
 * 没查到就是没查到（不静默回落到默认值）——这两条是这组测试要钉的性质。
 *
 * 顺带钉住报告的 preview 行：数据腿的 counts/selects 是**结论**，原始行是**证据**，
 * 两者都从 `previewTable` 这一个实现出来（应用报告与数据源报告共用）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  expandPack, resolveSourceSlots, validatePack, type AppPack, type SourceObservation,
} from "../src/app/app-pack.ts";
import { appReportMarkdown, runApp } from "../src/app/app-runner.ts";
import { previewTable, reportMarkdown, type DateEntry } from "../src/data/datasource.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime } from "../src/model/model.ts";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** 一个只有工具步的包：旅程消费数据腿回写的值（离线、确定性，CI 无条件可跑）。 */
function pack(): AppPack {
  return {
    spec_version: 1,
    id: "src-slots-fixture",
    label: "数据腿回写槽位（夹具）",
    goal: "用数据腿查到的值走一步",
    model: "english",
    max_subgoals: 1,
    hosts: [],
    sources: ["demo-tool"],
    source_slots: {
      picked: { source: "demo-tool", select: "cheapest", field: "label" },
      n: { source: "demo-tool", count: "rows" },
    },
    journey: [{
      id: "use", desc: "用 {picked}（共 {n} 条）",
      source: "demo-tool", args: ["--query={picked}"], signal: { exit_ok: true },
    }],
  };
}

afterAll(() => installLayaRuntime(null));

describe("source_slots —— 加载期就把取值点点名", () => {
  it("取值点写在数据源自己的声明里才算数", () => {
    expect(validatePack(pack())).toEqual([]);
  });

  it.each([
    ["数据源不是本包的 sources", (p: any) => { p.source_slots.picked.source = "git-log"; }, "is not one of this pack's sources"],
    ["select 名数据源没声明", (p: any) => { p.source_slots.picked.select = "nope"; }, "is not declared by source"],
    ["count 名数据源没声明", (p: any) => { p.source_slots.n.count = "nope"; }, "is not declared by source"],
    ["select 与 count 都给了", (p: any) => { p.source_slots.picked.count = "rows"; }, "needs exactly one of"],
    ["select 与 count 都没给", (p: any) => { delete p.source_slots.picked.select; }, "needs exactly one of"],
    ["槽位名不是合法占位符", (p: any) => { p.source_slots["has-dash"] = { source: "demo-tool", count: "rows" }; }, "slot names must match"],
    ["值不是对象", (p: any) => { p.source_slots.picked = "demo-tool"; }, "must be an object"],
  ])("%s", (_name, mutate, expected) => {
    const p = pack();
    mutate(p);
    expect(validatePack(p).join("\n")).toContain(expected);
  });

  it("回写的槽位是**已声明**槽位：旅程里写 {picked} 不在加载期被判未知", () => {
    // 值要等数据腿跑完才有——加载期只认"这个名字存在"，不认"这个值存在"。
    const p = pack();
    delete (p.slots as Record<string, unknown> | undefined)?.picked;
    expect(validatePack(p)).toEqual([]);
    const problems = validatePack(p);
    expect(problems.join("\n")).not.toContain("unknown slot placeholder {picked}");
  });

  it("没回填到值就是没值：展开期响亮地炸，不静默替换成空串", () => {
    const p = pack();
    expect(() => expandPack(p, {}, path.join(os.tmpdir(), "src-slots-plan.json")))
      .toThrow(/unknown slot placeholder \{picked\}/);
  });
});

describe("resolveSourceSlots —— 回写的唯一实现", () => {
  const observed: Record<string, SourceObservation> = {
    "demo-tool": {
      selects: { cheapest: { id: "w2", label: "小组件 B", price: "3" } },
      counts: { rows: 3 },
    },
  };

  it("按声明取字段；count 写成字符串", () => {
    expect(resolveSourceSlots(pack(), observed)).toEqual({ picked: "小组件 B", n: "3" });
  });

  it("没查到就不写（不回落到默认值、不猜）", () => {
    expect(resolveSourceSlots(pack(), {
      "demo-tool": { selects: { cheapest: null }, counts: {} },
    })).toEqual({});
    // 数据源压根没跑（--no-sources / 源被跳过）同样不写
    expect(resolveSourceSlots(pack(), {})).toEqual({});
  });

  it("不给 field 时取行的主值（与数据腿报告里 selects 列同一口径：price → id → name）", () => {
    const p = pack();
    delete p.source_slots!.picked.field;
    expect(resolveSourceSlots(p, observed)).toEqual({ picked: "3", n: "3" });
  });

  it("没有声明就没有回写（缺省等价）", () => {
    const p = pack();
    delete p.source_slots;
    expect(resolveSourceSlots(p, observed)).toEqual({});
  });
});

describe("runApp —— 数据腿 → 槽位 → 旅程", () => {
  it("旅程用的是**查到的**值，不是包里写死的默认值", async () => {
    installLayaRuntime(scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 }))));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-src-slots-"));
    const res = await runApp(pack(), {
      verbose: false, planPath: path.join(dir, "plan.json"), outDir: dir,
    });
    // ① 回写了什么，产物里说得出来
    expect(res.source_slots).toMatchObject({ n: "3" });
    expect(typeof res.source_slots?.picked).toBe("string");
    expect(res.source_slots?.picked).not.toBe("");
    // ② 值进了展开后的槽位（旅程就是拿它替换的）
    expect(res.slots).toMatchObject({ picked: res.source_slots!.picked, n: "3" });
    // ③ 旅程真的用了它：工具步的 argv 里是观测值，不是字面量 {picked}
    expect(res.tool_steps[0]?.argv.join(" ")).toContain(String(res.source_slots?.picked));
    expect(res.tool_steps[0]?.argv.join(" ")).not.toContain("{picked}");
    expect(res.tool_steps[0]?.done).toBe(true);
  }, 120_000);

  it("--no-sources 时不回写：槽位没有值就是没有值（响亮，不猜）", async () => {
    installLayaRuntime(scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 }))));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-src-slots-"));
    await expect(runApp(pack(), {
      verbose: false, sources: false, planPath: path.join(dir, "plan.json"), outDir: dir,
    })).rejects.toThrow(/unknown slot placeholder \{picked\}/);
  }, 120_000);
});

describe("报告展示 preview 行（数据腿的证据）", () => {
  it("previewTable 是数据源报告与应用报告共用的那一份", () => {
    const src = JSON.parse(fs.readFileSync(
      path.join(path.resolve(import.meta.dirname, ".."), "apps", "demo-tool", "sources", "demo-tool.json"), "utf-8",
    )) as Parameters<typeof previewTable>[0];
    const perDate: Record<string, DateEntry> = {
      "2026-10-22": { rows: [{ id: "w1", label: "A", price: 1 }, { id: "w2", label: "B", price: 2 }],
        counts: { rows: 2 }, selects: {}, audits: {}, error: null } as unknown as DateEntry,
    };
    const pv = previewTable(src, perDate);
    expect(pv).toMatchObject({ date: "2026-10-22", columns: ["id", "label", "price"] });
    expect(pv!.rows).toEqual([
      { id: "w1", label: "A", price: "1" },
      { id: "w2", label: "B", price: "2" },
    ]);
    // 同一份声明进数据源报告：标题行就是"前 N 条（原始行）"
    expect(reportMarkdown(src, perDate)).toContain("前 2 条（原始行）");
  });

  it("应用报告带上数据腿的原始行（counts/selects 之外那一份证据）", async () => {
    installLayaRuntime(scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 }))));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-src-slots-"));
    const res = await runApp(pack(), {
      verbose: false, planPath: path.join(dir, "plan.json"), outDir: dir,
    });
    const pv = res.sources[0]?.preview;
    expect(pv?.columns).toEqual(["id", "label", "price"]);
    expect(pv!.rows.length).toBeGreaterThan(0);
    const md = appReportMarkdown(res);
    expect(md).toContain("前 " + String(pv!.rows.length) + " 条（原始行）");
    // 回写了哪些槽位，报告也要说（"这个值是查出来的还是人写死的"必须读得出来）
    expect(md).toContain("数据腿回写槽位");
    expect(md).toContain("`picked`");
  }, 120_000);

  it("没声明 preview 的数据源：报告不出现 preview 段（缺省等价）", () => {
    const src = { name: "x", transport: { client: "curl" } } as unknown as Parameters<typeof previewTable>[0];
    expect(previewTable(src, {})).toBe(null);
    const res = {
      app: "a", label: "l", goal: "g", pack_path: "", plan_path: "", roles_used: [], slots: {},
      completed: "0/0", subgoals: [], tool_steps: [], invariants: [], ok: false, secs: 0,
      sources: [{ name: "x", rows: 0, counts: {}, selects: {} }],
    };
    expect(appReportMarkdown(res)).not.toContain("（原始行）");
  });
});
