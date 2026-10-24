/**
 * L1 命令面：`amber apps check / explain / emit` 对**脚本**工作。
 *
 * 三条命令的分工（也是"人可核验"的落点）：
 *   - `check`   ：构建 + 校验，problems 带路径（Agent 自纠用；不启动浏览器）
 *   - `explain` ：把三段骨架展开成人话（人核验用）
 *   - `emit`    ：展开成 IR 快照（审计/交接用，带 `generated_from` 血统）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cli } from "./cli-harness.ts";
import { REPO } from "../src/flow/flow.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-app-cli-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const CAMERA = path.join(REPO, "tests/fixtures/scripts/camera-entry.mjs");
const CLI_REPORT = path.join(REPO, "tests/fixtures/scripts/cli-report.mjs");

describe("amber apps check：脚本可直接校验", () => {
  it("合法脚本 → exit 0", async () => {
    const r = await cli(["apps", "check", CAMERA]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("camera-entry");
    expect(r.out).toContain("全部通过校验");
  });

  it("JSON 信封可机读（Agent 自纠的输入）", async () => {
    const r = await cli(["apps", "check", CAMERA, "--json"]);
    const env = r.json();
    expect(env.ok).toBe(true);
    expect(env.data.checked).toBe(1);
    expect(env.data.results[0].problems).toEqual([]);
  });

  it("坏脚本 → exit 2 且 problems 里点名（不是静默跳过）", async () => {
    const bad = path.join(tmp, "bad.mjs");
    fs.writeFileSync(bad, `export const meta = () => ({ id: "bad", goal: "g" });
export const app = (kit) => ({ exec: [kit.go("testpages/product.html", { done: null })] });`, "utf-8");
    const r = await cli(["apps", "check", bad]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toMatch(/missing done-signal|is invalid/);
  });
});

describe("amber apps explain：人话计划（不动作）", () => {
  it("逐步输出：动作、完成条件、目标；工具步显示 source", async () => {
    const r = await cli(["apps", "explain", CLI_REPORT]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("cli-report");
    expect(r.out).toContain("[tool]");
    expect(r.out).toContain("工具 demo-tool");
    expect(r.out).toContain("完成：");
    expect(r.out).toContain("文件存在 {out_dir}/cli-report-artifact.txt");
  });

  it("--json 给出结构化步骤与 plan_sha256", async () => {
    const r = await cli(["apps", "explain", CAMERA, "--json"]);
    const env = r.json();
    expect(env.data.app).toBe("camera-entry");
    expect(env.data.steps).toHaveLength(4);
    expect(env.data.steps[0].kind).toBe("browser");
    expect(env.data.steps[0].targets).toHaveLength(3);
    expect(env.data.steps[0].done).toContain("URL 含");
    expect(env.data.plan_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(env.data.invariants).toHaveLength(3);
  });
});

describe("amber apps emit：IR 快照（带血统）", () => {
  it("写出 pack.json，且能被 apps check 再次接受", async () => {
    const out = path.join(tmp, "emit", "camera-entry.json");
    const r = await cli(["apps", "emit", CAMERA, "--out", out]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
    const pack = JSON.parse(fs.readFileSync(out, "utf-8"));
    expect(pack.id).toBe("camera-entry");
    expect(pack.generated_from.source).toContain("camera-entry.mjs#app");
    expect(pack.generated_from.plan_sha256).toMatch(/^[0-9a-f]{64}$/);

    const check = await cli(["apps", "check", out]);
    expect(check.code).toBe(0);
  });
});
