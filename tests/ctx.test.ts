/**
 * L2 运行期 `ctx`：dry / real / replay 三种实现。
 *
 * 验收（计划 §6 L2 退出条件）：
 *   1. `flow(ctx)` 真实跑通一条 file:// 夹具（browser 步 + 运行期循环 + 结束态不变量）；
 *   2. dry 展开的调用序列与真实运行一致（同一套 ctx 面）；
 *   3. trace 落盘可读；同一脚本+输入重放通过；换槽位后**拒跑**（版本/输入闸门）；
 *   4. 预算耗尽 = 结构化停因（`budget_exceeded`），不是挂死。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dryRunFlow, loadScriptApp } from "../src/app/app-script.ts";
import { runScriptApp } from "../src/app/app-runner.ts";
import { readTrace, sameEventSequence, sameEventStructure, validateTrace } from "../src/app/trace.ts";
import { REPO } from "../src/flow/flow.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-ctx-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const FLOW = path.join(REPO, "tests/fixtures/scripts/flow-demo-app.mjs");

describe("L2 ctx：dry 跑（不动作、不开浏览器）", () => {
  it("flow 脚本可加载，pack 没有静态旅程（步骤在运行期产生）", async () => {
    const loaded = await loadScriptApp(FLOW);
    expect(loaded.mode).toBe("flow");
    expect(loaded.pack.journey).toEqual([]);
    expect(loaded.pack.invariants).toHaveLength(1);
  });

  it("dry 跑：调用序列 = open → step×4 → done，零 problems，且可重复", async () => {
    const loaded = await loadScriptApp(FLOW);
    const a = await dryRunFlow(loaded);
    const b = await dryRunFlow(loaded);
    expect(a.problems).toEqual([]);
    expect(a.trace.events.map((e) => e.call)).toEqual(["open", "step", "step", "step", "step", "done"]);
    expect(sameEventSequence(a.trace, b.trace)).toBe(true);
  });

  it("dry 也校验：未知信号算子 / 缺 act / 命令 op 错 → 结构化 problems", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "bad-"));
    const cases: Array<[string, string, RegExp]> = [
      ["bad-signal", `export const meta = (kit)=>({id:"x",label:"x",goal:"g",hosts:[]});
export async function flow(ctx){ await ctx.step("s", { act: ctx.hint("#a"), done: { magic: 1 } }); }`, /unknown signal op 'magic'/],
      ["bad-act", `export const meta = (kit)=>({id:"x",label:"x",goal:"g",hosts:[]});
export async function flow(ctx){ await ctx.step("s", { done: ctx.judge.url("x") }); }`, /act is required/],
      ["bad-cmd", `export const meta = (kit)=>({id:"x",label:"x",goal:"g",hosts:[]});
export async function flow(ctx){ await ctx.step("s", { act: [{op:"explode"}], done: ctx.judge.url("x") }); }`, /unknown command op/],
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

describe("L2 ctx：真实跑（浏览器 + 执行器）", () => {
  it("flow 跑通商店夹具：ok、不变量成立、trace 落盘可读", async () => {
    const loaded = await loadScriptApp(FLOW);
    const tracePath = path.join(tmp, "run.trace.json");
    const res = await runScriptApp(loaded, { verbose: false, headful: false, emitTrace: tracePath });
    expect(res.ok).toBe(true);
    expect(res.script?.mode).toBe("flow");
    expect(res.script?.stop_code).toBeUndefined();
    expect(res.invariants).toEqual([{ id: "on-thanks-page", desc: "旅程结束时确实在感谢页（不是停在购物车页）", held: true }]);
    expect(res.script?.trace_path).toBe(tracePath);
    const trace = readTrace(tracePath);
    expect(validateTrace(trace)).toEqual([]);
    expect(trace.done).toBe(true);
    expect(trace.app).toBe("flow-demo-app");
    const calls = trace.events.map((e) => e.call);
    expect(calls).toContain("open");
    expect(calls.filter((c) => c === "step")).toHaveLength(4);
    expect(calls[calls.length - 1]).toBe("done");
  }, 120_000);

  it("重放：同一脚本+输入 → 通过；换槽位 → 拒跑（inputs mismatch）", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "replay-"));
    const loaded = await loadScriptApp(FLOW);
    const tracePath = path.join(dir, "t.json");
    const first = await runScriptApp(loaded, { verbose: false, headful: false, emitTrace: tracePath });
    expect(first.ok).toBe(true);

    const replay = await runScriptApp(loaded, { verbose: false, replayTrace: tracePath });
    expect(replay.ok).toBe(true);
    expect(replay.script?.stop_code).toBeUndefined();

    await expect(runScriptApp(loaded, {
      verbose: false, replayTrace: tracePath, slots: { coupon: "OTHER" },
    })).rejects.toThrow(/inputs mismatch/);
  }, 180_000);

  it("L2 一致性：dry 与真实运行的调用序列相同；真实两次运行的结构相同（忽略耗时）", async () => {
    const loaded = await loadScriptApp(FLOW);
    const out = fs.mkdtempSync(path.join(tmp, "conform-"));
    const dry = await dryRunFlow(loaded);
    const t1 = path.join(out, "r1.json");
    const t2 = path.join(out, "r2.json");
    const r1 = await runScriptApp(loaded, { verbose: false, headful: false, emitTrace: t1 });
    const r2 = await runScriptApp(loaded, { verbose: false, headful: false, emitTrace: t2 });
    expect(r1.ok && r2.ok).toBe(true);
    // E2（三实现一致性）：dry 的调用序列就是真实运行的调用序列（结构面）。
    const pick = (events: Array<{ call: string; desc?: string; ok?: boolean }>) =>
      events.map((e) => ({ call: e.call, desc: e.desc ?? null, ok: e.ok ?? null }));
    expect(pick(readTrace(t1).events)).toEqual(pick(dry.trace.events));
    // P3（真实运行的确定性）：同一脚本+输入两次运行结构相同；耗时证据不参与。
    expect(sameEventStructure(readTrace(t1), readTrace(t2))).toBe(true);
  }, 240_000);

  it("预算耗尽 = 结构化停因（不是挂死）", async () => {
    const loaded = await loadScriptApp(FLOW);
    const res = await runScriptApp(loaded, { verbose: false, headful: false, maxSteps: 2 });
    expect(res.ok).toBe(false);
    expect(res.script?.stop_code).toBe("budget_exceeded");
  }, 120_000);
});
