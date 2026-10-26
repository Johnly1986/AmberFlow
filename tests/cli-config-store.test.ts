/**
 * 配置层叠（`src/cli/config-store.ts`）。
 *
 * 设计文档 §3.8 / §4.3：旧 rc < 用户配置 < 项目配置 < 环境变量；新命令不写旧 rc。
 * 这一层的失败形状很要紧——**未知键响亮拒绝**（与 pack/source 加载期校验同一口气），
 * 因为"配了却像没配"是本项目反复点名的缺陷形状。所以这里不只测"生效值对不对"，
 * 还测"错在哪一层、说了什么"。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_KEYS, displayValue, initConfigFile, isKnownConfigKey, isSecretKey, legacyConfigPath,
  projectConfigPath, readConfigFile, removeConfigValue, resolveConfig, selectedConfigPath,
  userConfigPath, writeConfigValue,
} from "../src/cli/config-store.ts";
import { workspace } from "./cli-harness.ts";

const userFile = (home: string): string => path.join(home, "config.json");
const projectFile = (cwd: string): string => path.join(cwd, ".amberflow", "config.json");

describe("配置键的校验面", () => {
  it("白名单非空且不重复（CONFIG_KEYS 就是 rc 分组的去重并集）", () => {
    expect(CONFIG_KEYS.length).toBeGreaterThan(10);
    expect(new Set(CONFIG_KEYS).size).toBe(CONFIG_KEYS.length);
    expect(CONFIG_KEYS).toContain("AMBERFLOW_DECISION_BASE_URL");
    expect(CONFIG_KEYS).toContain("TOKEN_PLAN_API_KEY");
    // provider 不再是配置键：线上由三件套选，本地由"没有地址"选。
    expect(CONFIG_KEYS).not.toContain("AMBERFLOW_DECISION_PROVIDER");
    expect(CONFIG_KEYS).not.toContain("AMBERFLOW_DEFAULT_DECISION_PROVIDER");
  });

  it("已知键 / 密钥类键的判定", () => {
    expect(isKnownConfigKey("PLANNER_MODEL")).toBe(true);
    expect(isKnownConfigKey("LAYA_TODAY")).toBe(false);       // 仓库常量不是机器配置
    expect(isSecretKey("TOKEN_PLAN_API_KEY")).toBe(true);
    expect(isSecretKey("BAILIAN_API_KEY")).toBe(true);
    expect(isSecretKey("PLANNER_MODEL")).toBe(false);
    expect(isSecretKey("TOKEN_PLAN_ENDPOINT")).toBe(false);   // 主机类掩了反而看不懂
  });

  it("displayValue 只掩真凭据，主机 / 端点原样", () => {
    expect(displayValue("TOKEN_PLAN_API_KEY", "sk-12345678")).not.toContain("sk-12345678");
    expect(displayValue("TOKEN_PLAN_API_KEY", "sk-12345678")).toContain("掩码");
    expect(displayValue("PLANNER_MODEL", "gpt")).toBe("gpt");
  });
});

describe("配置文件路径", () => {
  it("用户配置在 $AMBERFLOW_HOME 下，项目配置在 ./.amberflow 下", () => {
    const ws = workspace();
    try {
      expect(userConfigPath({ AMBERFLOW_HOME: ws.home })).toBe(userFile(ws.home));
      expect(projectConfigPath(ws.cwd)).toBe(projectFile(ws.cwd));
      expect(legacyConfigPath().endsWith(path.join("configs", "amberflowrc.json"))).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it("selectedConfigPath：显式 --config 替换用户 / 项目两层", () => {
    const ws = workspace();
    try {
      const explicit = path.join(ws.cwd, "other.json");
      expect(selectedConfigPath(ws.cwd, { AMBERFLOW_HOME: ws.home }, explicit, false)).toBe(explicit);
      expect(selectedConfigPath(ws.cwd, { AMBERFLOW_HOME: ws.home }, explicit, true)).toBe(explicit);
      expect(selectedConfigPath(ws.cwd, { AMBERFLOW_HOME: ws.home }, null, true))
        .toBe(projectFile(ws.cwd));
      expect(selectedConfigPath(ws.cwd, { AMBERFLOW_HOME: ws.home }, null, false))
        .toBe(userFile(ws.home));
    } finally {
      ws.cleanup();
    }
  });
});

describe("readConfigFile — 坏文件点名到具体原因", () => {
  it("文件不存在 = 合法的空配置（默认等价纪律）", () => {
    const layer = readConfigFile("/definitely/not/here.json", "x");
    expect(layer).toEqual({ name: "x", path: "/definitely/not/here.json", exists: false, values: {}, errors: [] });
  });

  it("不是 JSON / 顶层不是对象 / 未知键 / 值不是字符串，四种都说人话", () => {
    const ws = workspace();
    try {
      const cases: Array<[string, string, RegExp]> = [
        ["broken.json", "{not json", /不是合法 JSON/],
        ["array.json", "[1,2]", /顶层必须是对象/],
        ["unknown.json", '{"NOPE_KEY":"1"}', /未知键 "NOPE_KEY"/],
        ["number.json", '{"PLANNER_MODEL":3}', /必须是字符串/],
      ];
      for (const [name, body, want] of cases) {
        const file = path.join(ws.cwd, name);
        fs.writeFileSync(file, body, "utf-8");
        const layer = readConfigFile(file, "用户配置");
        expect(layer.exists, name).toBe(true);
        expect(layer.errors.join("\n"), name).toMatch(want);
      }
    } finally {
      ws.cleanup();
    }
  });

  it("`_doc` 键是模板自述，不算未知键", () => {
    const ws = workspace();
    try {
      const file = path.join(ws.cwd, "doc.json");
      fs.writeFileSync(file, '{"_doc":"说明","PLANNER_MODEL":"m"}', "utf-8");
      const layer = readConfigFile(file, "用户配置");
      expect(layer.errors).toEqual([]);
      expect(layer.values).toEqual({ PLANNER_MODEL: "m" });
    } finally {
      ws.cleanup();
    }
  });
});

describe("resolveConfig — 层叠与生效来源", () => {
  it("环境变量 > 项目配置 > 用户配置", () => {
    const ws = workspace();
    try {
      writeConfigValue(userFile(ws.home), "PLANNER_MODEL", "from-user");
      writeConfigValue(userFile(ws.home), "AUDIT_MODEL", "only-user");
      writeConfigValue(projectFile(ws.cwd), "PLANNER_MODEL", "from-project");

      const r = resolveConfig({ AMBERFLOW_HOME: ws.home }, ws.cwd);
      expect(r.values.PLANNER_MODEL).toEqual({ value: "from-project", source: "项目配置", secret: false });
      expect(r.values.AUDIT_MODEL!.source).toBe("用户配置");
      expect(r.errors).toEqual([]);
      // 有效环境里补上了文件值，但原 baseEnv 不被改动
      expect(r.env.PLANNER_MODEL).toBe("from-project");

      const withEnv = resolveConfig({ AMBERFLOW_HOME: ws.home, PLANNER_MODEL: "from-env" }, ws.cwd);
      expect(withEnv.values.PLANNER_MODEL).toEqual({ value: "from-env", source: "环境变量", secret: false });
    } finally {
      ws.cleanup();
    }
  });

  it("层顺序固定：旧 rc / 用户 / 项目（显示顺序即优先级从低到高）", () => {
    const ws = workspace();
    try {
      const r = resolveConfig({ AMBERFLOW_HOME: ws.home }, ws.cwd);
      expect(r.layers.map((l) => l.name)).toEqual(["旧 rc", "用户配置", "项目配置"]);
    } finally {
      ws.cleanup();
    }
  });

  it("显式 --config 替换用户 / 项目两层", () => {
    const ws = workspace();
    try {
      writeConfigValue(userFile(ws.home), "PLANNER_MODEL", "from-user");
      const explicit = path.join(ws.cwd, "explicit.json");
      writeConfigValue(explicit, "PLANNER_MODEL", "from-explicit");
      const r = resolveConfig({ AMBERFLOW_HOME: ws.home }, ws.cwd, "explicit.json");
      expect(r.layers.map((l) => l.name)).toEqual(["旧 rc", "显式配置"]);
      expect(r.values.PLANNER_MODEL!.value).toBe("from-explicit");
    } finally {
      ws.cleanup();
    }
  });

  it("错误带层名前缀，并汇总到 errors（不是静默忽略）", () => {
    const ws = workspace();
    try {
      fs.mkdirSync(path.dirname(userFile(ws.home)), { recursive: true });
      fs.writeFileSync(userFile(ws.home), '{"NOPE":1}', "utf-8");
      const r = resolveConfig({ AMBERFLOW_HOME: ws.home }, ws.cwd);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatch(/^用户配置：/);
      expect(r.errors[0]).toContain("NOPE");
    } finally {
      ws.cleanup();
    }
  });

  it("测试进程不吸收本机 rc（VITEST 在场时 rc 层为空）", () => {
    const r = resolveConfig({ VITEST: "1", AMBERFLOW_HOME: "/h" }, "/w");
    const legacy = r.layers[0]!;
    expect(legacy.name).toBe("旧 rc");
    expect(legacy.values).toEqual({});
    expect(legacy.errors).toEqual([]);
  });

  it("密钥类键被打上 secret 标记（供 doctor / config show 掩码）", () => {
    const ws = workspace();
    try {
      writeConfigValue(userFile(ws.home), "TOKEN_PLAN_API_KEY", "sk-1");
      const r = resolveConfig({ AMBERFLOW_HOME: ws.home }, ws.cwd);
      expect(r.values.TOKEN_PLAN_API_KEY!.secret).toBe(true);
    } finally {
      ws.cleanup();
    }
  });
});

describe("配置写入", () => {
  it("set 合并写回、unset 报告是否真的删了、init 不覆盖已有文件", () => {
    const ws = workspace();
    try {
      const file = userFile(ws.home);
      expect(initConfigFile(file)).toBe(true);
      expect(fs.existsSync(file)).toBe(true);
      expect(initConfigFile(file)).toBe(false);

      writeConfigValue(file, "PLANNER_MODEL", "m1");
      writeConfigValue(file, "AUDIT_MODEL", "m2");
      expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toMatchObject({
        PLANNER_MODEL: "m1", AUDIT_MODEL: "m2",
      });

      expect(removeConfigValue(file, "PLANNER_MODEL")).toBe(true);
      expect(removeConfigValue(file, "PLANNER_MODEL")).toBe(false);
      expect(removeConfigValue("/definitely/not/here.json", "X")).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  it("写坏了的配置文件再读时报错（写入层不做校验，读取层负责响亮）", () => {
    const ws = workspace();
    try {
      const file = userFile(ws.home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "{oops", "utf-8");
      expect(() => writeConfigValue(file, "PLANNER_MODEL", "m")).toThrow(/不是合法 JSON/);
      expect(() => removeConfigValue(file, "PLANNER_MODEL")).toThrow(/不是合法 JSON/);
    } finally {
      ws.cleanup();
    }
  });
});
