/**
 * 脚本应用与声明式应用的**策略一致性**（审计发现 U13）：
 * 同一个 `pack.policy` 必须在两条执行入口（`runApp` 数据脚本 / `runScriptApp` flow 脚本）
 * 生效成同一个值；`--force-hints` 这种对 flow 没有声明层可剥的旗标必须**拒绝**而不是静默无效。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadScriptApp } from "../src/app/app-script.ts";
import { main as appMain, runScriptApp } from "../src/app/app-runner.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-policy-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function writeFlow(id: string, policy: Record<string, unknown>): string {
  const dir = path.join(tmp, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "app.mjs");
  fs.writeFileSync(file, `export const meta = () => ({
  id: ${JSON.stringify(id)}, label: "policy", goal: "g", hosts: [], slots: {},
  policy: ${JSON.stringify(policy)},
});
export async function flow(ctx) { await ctx.done(); }
`, "utf-8");
  return file;
}

describe("policy 一致性：flow 脚本也认 pack.policy", () => {
  it("声明的 conf_floor / reobserve 生效，且产物写 effective_policy（来源=pack）", async () => {
    const file = writeFlow("policy-app", { conf_floor: 0.5, reobserve: false, max_effective_repeats: 2 });
    const loaded = await loadScriptApp(file);
    const outDir = path.join(tmp, "out1");
    const res = await runScriptApp(loaded, { verbose: false, outDir });
    expect(res.ok).toBe(true);
    expect(res.effective_policy?.conf_floor).toEqual({ value: 0.5, source: "pack" });
    expect(res.effective_policy?.reobserve).toEqual({ value: false, source: "pack" });
    expect(res.effective_policy?.max_effective_repeats).toEqual({ value: 2, source: "pack" });
  }, 60_000);

  it("没声明策略 → 产物不带 effective_policy（缺省等价纪律）", async () => {
    const file = writeFlow("policy-none", {});
    const loaded = await loadScriptApp(file);
    const res = await runScriptApp(loaded, { verbose: false, outDir: path.join(tmp, "out2") });
    expect(res.ok).toBe(true);
    expect(res.effective_policy).toBeUndefined();
  }, 60_000);

  it("CLI --conf-floor 覆盖包声明（来源=cli）", async () => {
    const file = writeFlow("policy-cli", { conf_floor: 0.5 });
    const loaded = await loadScriptApp(file);
    const res = await runScriptApp(loaded, { verbose: false, outDir: path.join(tmp, "out3"), confFloor: 0.9 });
    expect(res.effective_policy?.conf_floor).toEqual({ value: 0.9, source: "cli" });
  }, 60_000);
});

describe("--force-hints off 对 flow 脚本：拒绝（没有声明层可剥，静默无效就是假账）", () => {
  it("app-runner CLI 返回 2 并点名原因，不启动任何步骤", async () => {
    const home = fs.mkdtempSync(path.join(tmp, "home-"));
    const dir = path.join(home, "apps", "fh-app");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "app.mjs"), `export const meta = () => ({ id: "fh-app", label: "x", goal: "g", hosts: [] });
export async function flow(ctx) { await ctx.done(); }
`, "utf-8");
    const prev = process.env.AMBERFLOW_HOME;
    process.env.AMBERFLOW_HOME = home;
    const logged: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    try {
      const code = await appMain(["--app", "fh-app", "--force-hints", "off"]);
      expect(code).toBe(2);
      expect(logged.join("\n")).toContain("只适用于声明式应用");
      // dry 分支曾提前 return、静默接受同一个旗标（子代理验收复现）——现在两处都拒绝。
      logged.length = 0;
      const dryCode = await appMain(["--app", "fh-app", "--force-hints", "off", "--dry"]);
      expect(dryCode).toBe(2);
      expect(logged.join("\n")).toContain("只适用于声明式应用");
    } finally {
      console.error = origErr;
      if (prev === undefined) delete process.env.AMBERFLOW_HOME; else process.env.AMBERFLOW_HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
