/**
 * 文档收口批的小修回归（B 组）：
 *   B1 flow 配置/语法错误带**脚本行号**（审计 U3）；
 *   B2 `run --dry-run --json` 加载失败也在 `problems` 里给真因；
 *   B3 `amber doctor --help` 不再混入 `apps new` 的旗标；
 *   B4 dry 静态检查仓库内相对路径的**文件存在性**（带 ?query 不误判）；
 *   B5 suite 的 flow 行在 hint 覆盖列显式标"运行期"，不参与声明面聚合。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dryRunFlow, loadScriptApp } from "../src/app/app-script.ts";
import { cli, workspace } from "./cli-harness.ts";
import { REPO } from "../src/flow/flow.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-doc-closeout-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function writeScript(tag: string, lines: string[]): string {
  const dir = path.join(tmp, tag);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "app.mjs");
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  return file;
}

describe("B1) 脚本错误带文件:行:列", () => {
  it("dry 运行期配置错误 → problems 里带 app.mjs:<line>:<col>", async () => {
    const file = writeScript("loc-runtime", [
      'export const meta = () => ({ id: "loc-runtime", label: "x", goal: "g", hosts: [] });',
      "export async function flow(ctx) {",
      '  await ctx.step("s", { act: ctx.hint("#a") });',
      "}",
    ]);
    const dry = await dryRunFlow(await loadScriptApp(file));
    expect(dry.problems.join(" | ")).toMatch(/done signal is required.*\(at app\.mjs:\d+:\d+\)/);
  });

  it("语法错误 → 加载错误里带 app.mjs:<line>", async () => {
    const file = writeScript("loc-syntax", [
      'export const meta = () => ({ id: "loc-syntax", label: "x", goal: "g" });',
      "export async function flow(ctx) {",
      "  this is not js",
      "}",
    ]);
    await expect(loadScriptApp(file)).rejects.toThrow(/app\.mjs:\d+/);
  });
});

describe("B2) run --dry-run --json：加载失败带 problems", () => {
  it("坏脚本 → exit 2，envelope.ok=false 且 data.problems 非空", async () => {
    const ws = workspace();
    try {
      const file = path.join(ws.home, "bad.mjs");
      fs.writeFileSync(file, 'export const meta = () => ({ id: "bad", goal: "g" });', "utf-8");
      const r = await cli(["run", file, "--dry-run", "--json"]);
      expect(r.code).toBe(2);
      const env = r.json();
      expect(env.ok).toBe(false);
      expect(env.data.problems.length).toBeGreaterThan(0);
      expect(String(env.data.problems[0])).toMatch(/needs either|export const app/);
    } finally {
      ws.cleanup();
    }
  });
});

describe("B3) 命令帮助不再串台", () => {
  it("doctor --help 不含 apps new 的旗标；apps --help 含", async () => {
    const doctor = await cli(["doctor", "--help"]);
    expect(doctor.out).not.toContain("apps new 的形态");
    expect(doctor.out).not.toContain("--kind flow|data");
    const apps = await cli(["apps", "--help"]);
    expect(apps.out).toContain("--kind flow|data");
  });
});

describe("B4) dry 检查仓库内相对路径存在性", () => {
  it("不存在的仓库相对页面 → problems 点名（真跑会 ERR_FILE_NOT_FOUND）", async () => {
    const file = writeScript("missing-page", [
      'export const meta = () => ({ id: "missing-page", label: "x", goal: "g", hosts: [] });',
      "export async function flow(ctx) {",
      '  await ctx.open("testpages/definitely-missing.html");',
      "  await ctx.done();",
      "}",
    ]);
    const dry = await dryRunFlow(await loadScriptApp(file));
    expect(dry.problems.join(" | ")).toMatch(/does not exist under the repo root/);
  });

  it("带 ?query 的真实页面不误判（dry 通过）", async () => {
    const file = writeScript("query-page", [
      'export const meta = () => ({ id: "query-page", label: "x", goal: "g", hosts: [] });',
      "export async function flow(ctx) {",
      '  await ctx.open("testpages/net_settings.html?sn=CAM-1001");',
      "  await ctx.done();",
      "}",
    ]);
    const dry = await dryRunFlow(await loadScriptApp(file));
    expect(dry.problems).toEqual([]);
  });
});
