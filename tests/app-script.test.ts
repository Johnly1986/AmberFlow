/**
 * L1 脚本作者面的**契约测试**：加载、降级、校验、回退、确定性。
 *
 * 设计口径（2026-10-24）：
 *   - 脚本**零 import**（kit 由引擎注入）、运行期 `import()`、不进 `tsconfig`/`vitest`；
 *   - 脚本坏了 → **抛错**（不静默回退到旧 JSON）；
 *   - 没有脚本 → 走旧 `loadPack`；`AMBERFLOW_NO_SCRIPTS=1` 强制旧路径（回退可验）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadPack } from "../src/app/app-pack.ts";
import {
  canonicalJson, loadApp, loadScriptApp, lowerScriptApp, resolveScriptPath, scriptsDisabled,
} from "../src/app/app-script.ts";
import { REPO } from "../src/flow/flow.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-app-script-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function writeScript(body: string): string {
  const file = path.join(tmp, `app-${++seq}.mjs`);
  fs.writeFileSync(file, body, "utf-8");
  return file;
}

const goodMeta = `export const meta = (kit) => ({ id: "t", goal: "g", hosts: [], slots: {}, sources: [], invariants: [] });`;

describe("脚本加载：确定性", () => {
  it("同一脚本连跑两次 → script_sha256 与 plan_sha256 都相同（时钟/随机当场现形）", async () => {
    const file = path.join(REPO, "tests/fixtures/scripts/camera-entry.mjs");
    const a = await loadScriptApp(file);
    const b = await loadScriptApp(file);
    expect(a.scriptSha256).toBe(b.scriptSha256);
    expect(a.planSha256).toBe(b.planSha256);
    expect(a.pack).toEqual(b.pack);
  });

  it("canonicalJson 对键顺序不敏感（plan_sha256 与书写顺序无关）", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe("回退：没有脚本走旧路径；--no-scripts 强制旧路径", () => {
  it("仓库应用：loadApp 与 loadPack 读同一个应用，逐字段相同（含 _path）", async () => {
    const viaLoadApp = await loadApp("camera-entry");
    const viaLoadPack = loadPack(path.join(REPO, "apps/camera-entry/app.mjs"));
    expect(viaLoadApp).toEqual(viaLoadPack);
  });

  it("AMBERFLOW_NO_SCRIPTS=1：scriptsDisabled()=true，脚本应用被明确拒绝（信任边界：不 import）", async () => {
    const prev = process.env.AMBERFLOW_NO_SCRIPTS;
    process.env.AMBERFLOW_NO_SCRIPTS = "1";
    try {
      expect(scriptsDisabled()).toBe(true);
      await expect(loadApp("camera-entry")).rejects.toThrow(/scripts are disabled \(AMBERFLOW_NO_SCRIPTS=1\)/);
      // 显式 JSON 路径仍可读（回退通道没有被一起关掉）。
      const js = JSON.stringify({ ...loadPack(path.join(REPO, "apps/camera-entry/app.mjs")), _path: undefined });
      const file = path.join(tmp, "legacy-pack.json");
      fs.writeFileSync(file, js, "utf-8");
      expect((await loadApp(file)).id).toBe("camera-entry");
    } finally {
      if (prev === undefined) delete process.env.AMBERFLOW_NO_SCRIPTS; else process.env.AMBERFLOW_NO_SCRIPTS = prev;
    }
  });

  it("resolveScriptPath：显式路径可用；不存在的路径/应用 → null；按 id 能找到应用目录下的脚本", () => {
    expect(resolveScriptPath(path.join(REPO, "tests/fixtures/scripts/cli-report.mjs"))).not.toBeNull();
    expect(resolveScriptPath(path.join(tmp, "nope.mjs"))).toBeNull();
    expect(resolveScriptPath("no-such-app")).toBeNull();
    expect(resolveScriptPath("camera-entry")).toBe(path.join(REPO, "apps/camera-entry/app.mjs"));
  });
});

describe("契约：坏脚本加载期就红（不静默回退）", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["缺 meta 导出", `export const app = () => ({ exec: [] });`, /missing "export const meta/],
    ["缺 app 导出", `export const meta = () => ({ id: "t", goal: "g" });`, /needs either "export const app/],
    ["meta 返回非对象", `export const meta = () => null; export const app = () => ({ exec: [] });`, /meta must be an object/],
    ["exec 不是列表", `${goodMeta} export const app = () => ({ exec: "nope" });`, /exec must be a list/],
    ["构建期抛错", `export const meta = () => { throw new Error("boom-meta"); }; export const app = () => ({ exec: [] });`, /building the declarative app threw: boom-meta/],
    ["包不合法（步缺完成信号）", `${goodMeta} export const app = (kit) => ({ exec: [kit.go("testpages/product.html", { done: null })] });`, /is invalid/],
  ];

  it.each(cases)("%s", async (_label, body, re) => {
    const file = writeScript(body);
    await expect(loadScriptApp(file)).rejects.toThrow(re);
    // loadApp 也要听到同一个错——坏脚本不许静默回退到旧 JSON
    await expect(loadApp(file)).rejects.toThrow(re);
  });
});

describe("lowerScriptApp：声明面必填项", () => {
  it("id / goal / exec 缺失时给出点名错误", () => {
    expect(() => lowerScriptApp({ id: "", goal: "g" } as never, { exec: [] }))
      .toThrow(/meta\.id must be a non-empty string/);
    expect(() => lowerScriptApp({ id: "t", goal: "  " } as never, { exec: [] }))
      .toThrow(/meta\.goal must be a non-empty string/);
    expect(() => lowerScriptApp({ id: "t", goal: "g" } as never, {} as never))
      .toThrow(/exec must be a list of steps/);
  });
});
