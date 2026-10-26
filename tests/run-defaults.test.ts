/**
 * 运行参数（--headful / --force-hints / --conf-floor / …）的配置默认值：
 * 全局配置 < 项目配置 < 环境变量 < CLI 旗标。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseRunDefaults, RUN_DEFAULT_KEYS } from "../src/support/run-defaults.ts";
import { isKnownConfigKey, resolveConfig } from "../src/cli/config-store.ts";
import { main as appMain, resolveRunPolicy } from "../src/app/app-runner.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-run-defaults-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(file: string, values: Record<string, string>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(values), "utf-8");
}

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of RUN_DEFAULT_KEYS) delete env[k];
  Object.assign(env, extra);
  return env;
}

describe("parseRunDefaults", () => {
  it("空配置 = 全缺省；布尔/消融/刻度都能解析", () => {
    expect(parseRunDefaults(cleanEnv()).defaults).toEqual({});
    const { defaults, errors } = parseRunDefaults(cleanEnv({
      AMBERFLOW_HEADFUL: "1",
      AMBERFLOW_TIERED_HINT: "true",
      AMBERFLOW_CONFIRM_SAFE: "on",
      AMBERFLOW_NO_SOURCES: "yes",
      AMBERFLOW_QUIET: "0",
      AMBERFLOW_FORCE_HINTS: "off",
      AMBERFLOW_CONF_FLOOR: "0.3",
    }));
    expect(errors).toEqual([]);
    expect(defaults).toEqual({
      headful: true, tieredHint: true, confirmSafe: true, noSources: true,
      quiet: false, forceHintsOff: true, confFloor: 0.3,
    });
  });

  it("非法值是配置错误（不静默当 false/0）", () => {
    expect(parseRunDefaults(cleanEnv({ AMBERFLOW_HEADFUL: "maybe" })).errors.join("\n"))
      .toMatch(/AMBERFLOW_HEADFUL.*不合法/);
    expect(parseRunDefaults(cleanEnv({ AMBERFLOW_FORCE_HINTS: "on" })).errors.join("\n"))
      .toMatch(/AMBERFLOW_FORCE_HINTS.*只接受 off/);
    expect(parseRunDefaults(cleanEnv({ AMBERFLOW_CONF_FLOOR: "0" })).errors.join("\n"))
      .toMatch(/AMBERFLOW_CONF_FLOOR.*\(0, 1\]/);
    expect(parseRunDefaults(cleanEnv({ AMBERFLOW_CONF_FLOOR: "1.1" })).errors.join("\n"))
      .toMatch(/AMBERFLOW_CONF_FLOOR.*\(0, 1\]/);
  });

  it("配置来源的 conf_floor 在产物里如实标 config，不冒充 cli", () => {
    const { policy } = resolveRunPolicy({} as never, { confFloor: 0.3, confFloorSource: "config" });
    expect(policy.conf_floor).toEqual({ value: 0.3, source: "config" });
  });

  it("配置默认值真的进入一次应用运行（conf_floor 来源=config；quiet 抑制报告）", async () => {
    const out = fs.mkdtempSync(path.join(tmp, "run-"));
    const prevQuiet = process.env.AMBERFLOW_QUIET;
    const prevFloor = process.env.AMBERFLOW_CONF_FLOOR;
    process.env.AMBERFLOW_QUIET = "1";
    process.env.AMBERFLOW_CONF_FLOOR = "0.33";
    try {
      const code = await appMain(["--app", "demo-app", "--out", out, "--ablate", "stub"]);
      expect(code).toBe(0);
      const res = JSON.parse(fs.readFileSync(path.join(out, "demo-app-result.json"), "utf-8"));
      expect(res.ok).toBe(true);
      expect(res.effective_policy.conf_floor).toEqual({ value: 0.33, source: "config" });
    } finally {
      if (prevQuiet === undefined) delete process.env.AMBERFLOW_QUIET; else process.env.AMBERFLOW_QUIET = prevQuiet;
      if (prevFloor === undefined) delete process.env.AMBERFLOW_CONF_FLOOR; else process.env.AMBERFLOW_CONF_FLOOR = prevFloor;
    }
  }, 180_000);

  it("空串 = 没设（模板留空占位不生效）", () => {
    const { defaults, errors } = parseRunDefaults(cleanEnv({
      AMBERFLOW_HEADFUL: "", AMBERFLOW_CONF_FLOOR: "", AMBERFLOW_FORCE_HINTS: "",
    }));
    expect(defaults).toEqual({});
    expect(errors).toEqual([]);
  });
});

describe("配置文件层叠：项目配置 > 全局配置", () => {
  it("新运行参数键都在白名单里", () => {
    for (const k of RUN_DEFAULT_KEYS) expect(isKnownConfigKey(k), k).toBe(true);
  });

  it("同一键：项目覆盖全局；环境变量再覆盖项目", () => {
    const home = fs.mkdtempSync(path.join(tmp, "home-"));
    const cwd = fs.mkdtempSync(path.join(tmp, "project-"));
    const globalFile = path.join(home, "config.json");
    const projectFile = path.join(cwd, ".amberflow", "config.json");
    write(globalFile, { AMBERFLOW_HEADFUL: "0", AMBERFLOW_CONF_FLOOR: "0.4", AMBERFLOW_QUIET: "1" });
    write(projectFile, { AMBERFLOW_HEADFUL: "1", AMBERFLOW_CONF_FLOOR: "0.3" });

    const env = cleanEnv({ AMBERFLOW_HOME: home });
    const r = resolveConfig(env, cwd);
    expect(r.errors).toEqual([]);
    expect(r.values.AMBERFLOW_HEADFUL).toEqual({ value: "1", source: "项目配置", secret: false });
    expect(r.values.AMBERFLOW_CONF_FLOOR).toEqual({ value: "0.3", source: "项目配置", secret: false });
    expect(r.values.AMBERFLOW_QUIET).toEqual({ value: "1", source: "用户配置", secret: false });

    const defaults = parseRunDefaults(r.env).defaults;
    expect(defaults).toMatchObject({ headful: true, confFloor: 0.3, quiet: true });

    const withEnv = cleanEnv({ AMBERFLOW_HOME: home, AMBERFLOW_HEADFUL: "0" });
    const r2 = resolveConfig(withEnv, cwd);
    expect(r2.values.AMBERFLOW_HEADFUL).toEqual({ value: "0", source: "环境变量", secret: false });
    expect(parseRunDefaults(r2.env).defaults.headful).toBe(false);
  });
});
