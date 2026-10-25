/**
 * `apps:suite` 的**脚本臂**（审计 P2）：flow 脚本应用也能被套件验收。
 *
 * 以前套件按 `loadPack` 读静态旅程：应用目录里是手写 `flow(ctx)` 脚本时，那一行直接
 * "加载失败"——脚本应用没有"一条命令验收"的入口。现在：
 *   - 同步读不了的手写脚本 → 异步加载器识别为 flow → 走 `runScriptApp`；
 *   - 决策账读 `runScriptApp.decisions`（与声明式应用同一份 `summarizeDecisions`）；
 *   - `steps` 是**实际执行次数**（flow 的步骤总数是运行期事实）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { suite } from "../tools/apps_suite.ts";
import { REPO } from "../src/flow/flow.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-suite-script-"));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe("apps:suite 脚本臂：flow 应用被真执行并验收", () => {
  it("用户作用域的 flow 应用：一行通过、steps=实际执行数、完成串说明是 flow", async () => {
    const dir = path.join(home, "apps", "flow-demo-app");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(REPO, "tests/fixtures/scripts/flow-demo-app.mjs"), path.join(dir, "app.mjs"));
    const prev = process.env.AMBERFLOW_HOME;
    process.env.AMBERFLOW_HOME = home;
    try {
      const out = await suite(["flow-demo-app"], { arm: "ablate" });
      expect(out.unmatched).toEqual([]);
      const row = out.rows.find((r) => r.app === "flow-demo-app");
      expect(row, JSON.stringify(out.rows)).toBeDefined();
      expect(row!.status).toBe("passed");
      expect(row!.steps).toBe(4);
      expect(row!.completed).toContain("flow(ctx)");
      expect(row!.invariants).toBe("1/1");
      // 决策账字段存在（与声明式应用同一口径；消融臂下咨询数由桩决定，这里只要求形状可读）。
      expect(typeof row!.model_asks).toBe("number");
      expect(row!.hint_browser).toBe(0);        // flow 的 hint 是运行期参数，静态覆盖 0/0
    } finally {
      if (prev === undefined) delete process.env.AMBERFLOW_HOME; else process.env.AMBERFLOW_HOME = prev;
    }
  }, 180_000);

  it("有 flow 应用时，声明式应用仍照旧跑（两条臂共存，不是替换）", async () => {
    const dir = path.join(home, "apps", "flow-demo-app");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(REPO, "tests/fixtures/scripts/flow-demo-app.mjs"), path.join(dir, "app.mjs"));
    const prev = process.env.AMBERFLOW_HOME;
    process.env.AMBERFLOW_HOME = home;
    try {
      const out = await suite(["demo-app", "flow-demo-app"], { arm: "ablate" });
      const byApp = new Map(out.rows.map((r) => [r.app, r]));
      expect(byApp.get("demo-app")?.status).toBe("passed");
      expect(byApp.get("flow-demo-app")?.status).toBe("passed");
    } finally {
      if (prev === undefined) delete process.env.AMBERFLOW_HOME; else process.env.AMBERFLOW_HOME = prev;
    }
  }, 240_000);
});
