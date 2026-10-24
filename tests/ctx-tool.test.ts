/**
 * L2 工具步：`ctx.run` / `ctx.dangerous` 接到既有 `runToolStep`（干跑/确认/幂等重试的唯一实现）。
 *
 * 验收：
 *   1. 完成真值 = 进程观察面（退出码/stdout/stderr/产物）；
 *   2. 危险步**默认拒绝**（`refused: dangerous`），放行后才真执行并落盘；
 *   3. dry 也校验工具信号语法与"危险步必须有 dryRunArgs"。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dryRunFlow, loadScriptApp } from "../src/app/app-script.ts";
import { runScriptApp } from "../src/app/app-runner.ts";
import { readTrace } from "../src/app/trace.ts";
import { REPO } from "../src/flow/flow.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-ctx-tool-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const FLOW = path.join(REPO, "tests/fixtures/scripts/flow-cli-report.mjs");

describe("L2 工具步：dry 调用序列", () => {
  it("run×4 + dangerous 出现在 dry 序列里，零 problems", async () => {
    const loaded = await loadScriptApp(FLOW);
    const dry = await dryRunFlow(loaded);
    expect(dry.problems).toEqual([]);
    const calls = dry.trace.events.map((e) => e.call);
    expect(calls.filter((c) => c === "run")).toHaveLength(4);
    expect(calls).toContain("dangerous");
  });

  it("dry 校验工具信号语法与危险步干跑声明", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "bad-"));
    const cases: Array<[string, string, RegExp]> = [
      ["bad-tool-signal", `export const meta=()=>({id:"x",label:"x",goal:"g",hosts:[]});
export async function flow(ctx){ await ctx.run("demo-tool", [], { done: { magic: 1 } }); }`, /unknown tool signal op 'magic'/],
      ["dangerous-no-dry", `export const meta=()=>({id:"x",label:"x",goal:"g",hosts:[]});
export async function flow(ctx){ await ctx.dangerous({ desc:"d", source:"demo-tool", args:[], done: { exit_ok: true } }); }`, /requires dryRunArgs/],
    ];
    for (const [name, body, re] of cases) {
      const file = path.join(dir, `${name}.mjs`);
      fs.writeFileSync(file, body, "utf-8");
      const loaded = await loadScriptApp(file);
      const dry = await dryRunFlow(loaded);
      expect(dry.problems.join(" | "), name).toMatch(re);
    }
  });
});

describe("L2 工具步：真实跑（进程观察面）", () => {
  it("危险步未放行：ok（脚本按设计接受拒绝）、trace 记 refused、产物不落盘", async () => {
    const loaded = await loadScriptApp(FLOW);
    const outDir = fs.mkdtempSync(path.join(tmp, "refused-"));
    const tracePath = path.join(outDir, "run.trace.json");
    const res = await runScriptApp(loaded, { verbose: false, outDir, emitTrace: tracePath });
    expect(res.ok).toBe(true);
    const trace = readTrace(tracePath);
    const dangerous = trace.events.find((e) => e.call === "dangerous");
    expect(dangerous?.ok).toBe(false);
    expect(dangerous?.stop_code).toBe("dangerous");
    expect(fs.existsSync(path.join(outDir, "flow-artifact.txt"))).toBe(false);
  }, 120_000);

  it("放行后真执行：危险步 ok、产物落盘", async () => {
    const loaded = await loadScriptApp(FLOW);
    const outDir = fs.mkdtempSync(path.join(tmp, "allowed-"));
    const tracePath = path.join(outDir, "run.trace.json");
    const res = await runScriptApp(loaded, {
      verbose: false, outDir, allowDangerous: true, emitTrace: tracePath,
    });
    expect(res.ok).toBe(true);
    const trace = readTrace(tracePath);
    const dangerous = trace.events.find((e) => e.call === "dangerous");
    expect(dangerous?.ok).toBe(true);
    expect(fs.existsSync(path.join(outDir, "flow-artifact.txt"))).toBe(true);
  }, 120_000);
});
