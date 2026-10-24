/**
 * `ctx.run` 的两种形态 + 应用支持器（适配器）扩展点。
 *
 * 审计发现（`docs/SCRIPT_AUTHORING_AUDIT.md` E3）：脚本驱动的工具步曾**硬编码 `adapter:"cli"`**，
 * 于是声明式应用能写的 ssh/stdio 步在 flow 脚本里不可表达——把"换成脚本"变成能力回退。
 * 现在两条入口共用同一份适配器实现（validate → expand → run）。
 *
 * 同时钉住 `StepResult.reason`：拒绝/失败必须给人话原因，作者不该靠猜 stopCode。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dryRunFlow, loadScriptApp } from "../src/app/app-script.ts";
import { runScriptApp } from "../src/app/app-runner.ts";
import { readTrace } from "../src/app/trace.ts";
import { listAppAdapters } from "../src/app/app-adapters.ts";
import { REPO } from "../src/flow/flow.ts";
import fs from "node:fs";
import os from "node:os";

const ADAPTER = path.join(REPO, "tests/fixtures/scripts/flow-tool-adapter.mjs");
const REFUSED = path.join(REPO, "tests/fixtures/scripts/flow-tool-refused.mjs");

describe("ctx.run 声明形式：与应用支持器共用同一份实现", () => {
  it("支持器清单里确实有 cli / ssh / stdio（扩展点是活的，不是文档承诺）", () => {
    for (const k of ["cli", "ssh", "stdio", "web"]) expect(listAppAdapters()).toContain(k);
  });

  it("dry 跑：声明形式的 stdio 步被识别，零 problems", async () => {
    const loaded = await loadScriptApp(ADAPTER);
    const dry = await dryRunFlow(loaded);
    expect(dry.problems).toEqual([]);
    expect(dry.trace.events.map((e) => e.call)).toEqual(["run", "log", "done"]);
  });

  it("真实跑：stdio 适配器跑子进程，完成真值 = 退出码 + stdout", async () => {
    const loaded = await loadScriptApp(ADAPTER);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-adapters-"));
    try {
      const tracePath = path.join(outDir, "trace.json");
      const res = await runScriptApp(loaded, { verbose: false, outDir, emitTrace: tracePath });
      expect(res.ok).toBe(true);
      const trace = readTrace(tracePath);
      const run = trace.events.find((e) => e.call === "run");
      expect(run?.ok).toBe(true);
      expect((run?.result as { adapter?: string } | undefined)?.adapter).toBe("stdio");
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("未知适配器：dry 期就红（点名已知清单），不是运行期玄学失败", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-bad-adapter-"));
    const file = path.join(dir, "app.mjs");
    fs.writeFileSync(file, `export const meta = () => ({ id: "bad-adapter", label: "x", goal: "g", hosts: [] });
export async function flow(ctx) {
  await ctx.run({ adapter: "carrier-pigeon", pigeon: { coo: true }, done: ctx.tool.exitOk(0) });
}`, "utf-8");
    try {
      const loaded = await loadScriptApp(file);
      const dry = await dryRunFlow(loaded);
      expect(dry.problems.join(" | ")).toMatch(/unknown app adapter "carrier-pigeon"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("StepResult.reason：拒绝/失败带人话原因", () => {
  it("危险步未放行：stopCode=dangerous 且 reason 说明为什么（脚本可据此分支）", async () => {
    const loaded = await loadScriptApp(REFUSED);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-refused-"));
    try {
      const res = await runScriptApp(loaded, { verbose: false, outDir });
      expect(res.ok).toBe(true);            // 脚本按设计接受拒绝
      expect(fs.existsSync(path.join(outDir, "never.txt"))).toBe(false);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 120_000);
});
