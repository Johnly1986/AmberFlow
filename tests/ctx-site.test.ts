/**
 * L2 ctx 站点面 API（补齐"至 L3 所有功能项"里最后三个未接线成员）：
 *   - `ctx.openPage(role)`：`meta.site.pages` 映射（站点知识是数据，不进共享代码）
 *   - `ctx.extract(name)`：`meta.site.listExtract` 命名行抽取（Q5 的 v1 口径）
 *   - `ctx.read.attr(sel, attr)`：读属性（不存在 → null）
 *   - `ctx.rows(spec)`：**v1 关闭**（Q5），调用给结构化 config_error
 *
 * 验收口径与其它 ctx 成员一致：dry 校验声明、真实跑取真值、trace/replay 可重放
 * （观察类 API 也进 trace —— 否则带 read/extract 的脚本无法重放）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dryRunFlow, loadScriptApp } from "../src/app/app-script.ts";
import { runScriptApp } from "../src/app/app-runner.ts";
import { readTrace } from "../src/app/trace.ts";
import { loadPack, validatePack } from "../src/app/app-pack.ts";
import { REPO } from "../src/flow/flow.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-site-api-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const FLOW = path.join(REPO, "tests/fixtures/scripts/flow-site-api.mjs");

function writeScript(tag: string, body: string): string {
  const dir = path.join(tmp, tag);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "app.mjs");
  fs.writeFileSync(file, body, "utf-8");
  return file;
}

describe("ctx 站点面：声明校验（dry）", () => {
  it("合法声明：dry 调用序列含 openPage / extract / read / done，零 problems", async () => {
    const loaded = await loadScriptApp(FLOW);
    const dry = await dryRunFlow(loaded);
    expect(dry.problems).toEqual([]);
    const calls = dry.trace.events.map((e) => e.call);
    expect(calls).toContain("openPage");
    expect(calls).toContain("extract");
    expect(calls).toContain("read");
    expect(calls[calls.length - 1]).toBe("done");
  });

  it("未知页面角色 → dry 报错并点名已知角色", async () => {
    const file = writeScript("bad-role", `export const meta = (kit) => ({
  id: "bad-role", label: "x", goal: "g", hosts: [],
  site: { pages: { portal: "testpages/portal.html" } },
});
export async function flow(ctx) { await ctx.openPage("nope"); }`);
    const dry = await dryRunFlow(await loadScriptApp(file));
    expect(dry.problems.join(" | ")).toMatch(/no such page role in meta\.site\.pages \(known: portal\)/);
  });

  it("未知行抽取名 → dry 报错并点名已知名字", async () => {
    const file = writeScript("bad-extract", `export const meta = (kit) => ({
  id: "bad-extract", label: "x", goal: "g", hosts: [],
  site: { listExtract: { entries: { rows: "a", fields: { label: "." } } } },
});
export async function flow(ctx) { await ctx.extract("fares"); }`);
    const dry = await dryRunFlow(await loadScriptApp(file));
    expect(dry.problems.join(" | ")).toMatch(/listExtract has no such entry \(known: entries\)/);
  });

  it("ctx.rows 在 v1 关闭：结构化 config_error 指向 extract(name)，不是 TypeError", async () => {
    const file = writeScript("rows-closed", `export const meta = (kit) => ({ id: "rows-closed", label: "x", goal: "g", hosts: [] });
export async function flow(ctx) { await ctx.rows({ row: "a", fields: {} }); }`);
    const dry = await dryRunFlow(await loadScriptApp(file));
    expect(dry.problems.join(" | ")).toMatch(/ctx\.rows is closed in v1/);
    expect(dry.problems.join(" | ")).toMatch(/ctx\.extract\(name\)/);
  });
});

describe("ctx 站点面：真实跑 + 重放", () => {
  it("真实跑：openPage 打开角色页、extract 抽到 2 行、read.attr 读到 href，不变量成立", async () => {
    const loaded = await loadScriptApp(FLOW);
    const outDir = fs.mkdtempSync(path.join(tmp, "run-"));
    const tracePath = path.join(outDir, "trace.json");
    const res = await runScriptApp(loaded, { verbose: false, headful: false, outDir, emitTrace: tracePath });
    expect(res.ok).toBe(true);
    const trace = readTrace(tracePath);
    const ex = trace.events.find((e) => e.call === "extract");
    const rows = (ex?.result as { rows?: Array<Record<string, string>> } | undefined)?.rows ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.label).toContain("枪机");
    const hrefRead = trace.events.filter((e) => e.call === "read" && e.desc?.startsWith("attr("));
    expect(hrefRead[0]!.result).toBe("camera_a.html");
    expect(hrefRead[1]!.result).toBeNull();          // 不存在的属性 → null
  }, 120_000);

  it("重放：带 read/extract 的脚本按其轨迹重放通过（观察类 API 也进 trace）", async () => {
    const loaded = await loadScriptApp(FLOW);
    const outDir = fs.mkdtempSync(path.join(tmp, "replay-"));
    const tracePath = path.join(outDir, "trace.json");
    const first = await runScriptApp(loaded, { verbose: false, outDir, emitTrace: tracePath });
    expect(first.ok).toBe(true);
    const replay = await runScriptApp(loaded, { verbose: false, replayTrace: tracePath });
    expect(replay.ok).toBe(true);
    expect(replay.script?.stop_code).toBeUndefined();
  }, 180_000);

  it("dry 与真实运行的调用序列（call/desc）一致（三实现一致性护栏覆盖新成员）", async () => {
    const loaded = await loadScriptApp(FLOW);
    const dry = await dryRunFlow(loaded);
    const outDir = fs.mkdtempSync(path.join(tmp, "conform-"));
    const tracePath = path.join(outDir, "trace.json");
    await runScriptApp(loaded, { verbose: false, outDir, emitTrace: tracePath });
    // `log` 的文本是脚本自己的观察（dry 下占位值是 0 行、真实是 2 行），不属于引擎行为；
    // 调用序列的等价性只比"调用了什么 + 参数"。
    const pick = (events: Array<{ call: string; desc?: string }>) =>
      events.filter((e) => e.call !== "log").map((e) => ({ call: e.call, desc: e.desc ?? null }));
    expect(pick(readTrace(tracePath).events)).toEqual(pick(dry.trace.events));
  }, 120_000);
});

describe("site 块加载期校验（坏声明不等到运行期）", () => {
  it("pages / listExtract 形状错 → validatePack 点名", () => {
    const pack = loadPack("demo-app") as unknown as Record<string, unknown>;
    pack["site"] = { pages: { home: 42 } };
    expect(validatePack(pack as never).join(" | ")).toMatch(/site\.pages\.home: non-empty url string required/);
    pack["site"] = { listExtract: { rows: { rows: "", fields: { name: 1 } } } };
    const p2 = validatePack(pack as never).join(" | ");
    expect(p2).toMatch(/site\.listExtract\.rows\.rows: non-empty selector string required/);
    expect(p2).toMatch(/site\.listExtract\.rows\.fields\.name: non-empty selector string required/);
    pack["site"] = { unknownBlock: {} };
    expect(validatePack(pack as never).join(" | ")).toMatch(/site\.unknownBlock: unknown key \(known: pages, listExtract\)/);
  });
});
