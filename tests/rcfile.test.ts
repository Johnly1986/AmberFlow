/**
 * `.amberflowrc.json` —— 机器事实配置的解析面。
 *
 * 钉住的不是"文件能读"，而是它和既有纪律的接口：
 * ① 优先级 CLI/env > 文件 > 缺省（文件绝不覆盖已设的环境）；
 * ② 文件缺席 = 零动作（默认等价，CI/干净机器行为逐字节不变）；
 * ③ 未知键 / 坏 JSON / 非字符串值 = 加载期响亮拒绝（与 pack/source 同一口气）——
 *    尤其证明 `LAYA_TODAY` 进不来：展开日期是仓库常量，不是机器配置；
 * ④ 空串 = 没设（否则击穿消费点的 `?? 缺省` 链）；
 * ⑤ 掩码只针对凭据名，路径类原样；
 * ⑥ 接进既有单一读点：文件里的 LAYA_ONNX_MODEL 经 onnxModelPath/checkArtifacts 生效。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyRcToEnv, loadRc, maskValue, rcStatusLines, RC_FILENAME, resetRcCache } from "../src/rcfile.ts";
import { checkArtifacts, modelConfigError, onnxModelPath } from "../src/model-artifacts.ts";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "af-rc-")); resetRcCache(); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); resetRcCache(); });

function writeRc(obj: unknown): void {
  fs.writeFileSync(path.join(root, RC_FILENAME), typeof obj === "string" ? obj : JSON.stringify(obj), "utf-8");
}

describe("rc：文件缺席 = 零动作（默认等价）", () => {
  it("没有 .amberflowrc.json：loadRc 无路径无错，applyRcToEnv 不改 env", () => {
    const load = loadRc(root);
    expect(load.path).toBeNull();
    expect(load.errors).toEqual([]);
    const env: NodeJS.ProcessEnv = {};
    const a = applyRcToEnv(env, root);
    expect(Object.keys(env)).toHaveLength(0);
    expect(a.applied).toEqual([]);
  });
});

describe("rc：优先级 env > 文件，且只补没设过的键", () => {
  it("文件值补进空缺的 env 键", () => {
    writeRc({ LAYA_ONNX_MODEL: "/data/laya_dec.onnx" });
    const env: NodeJS.ProcessEnv = {};
    const a = applyRcToEnv(env, root);
    expect(env.LAYA_ONNX_MODEL).toBe("/data/laya_dec.onnx");
    expect(a.applied).toContain("LAYA_ONNX_MODEL");
  });

  it("环境里已设的键：文件不覆盖（CLI/env 永远赢）", () => {
    writeRc({ LAYA_ONNX_MODEL: "/from/file.onnx" });
    const env: NodeJS.ProcessEnv = { LAYA_ONNX_MODEL: "/from/env.onnx" };
    applyRcToEnv(env, root);
    expect(env.LAYA_ONNX_MODEL).toBe("/from/env.onnx");
  });

  it("文件里的空串 = 没设：既不写入也不击穿缺省（否则 model-artifacts 的 ?? 链会取到空）", () => {
    writeRc({ LAYA_TOKENIZER_DIR: "", PLAYWRIGHT_BROWSERS_PATH: "" });
    const env: NodeJS.ProcessEnv = {};
    applyRcToEnv(env, root);
    expect(env.LAYA_TOKENIZER_DIR).toBeUndefined();
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
  });
});

describe("rc：加载期响亮拒绝（未知键 / 坏 JSON / 非字符串）", () => {
  it("未知键被点名，且明确指回 example", () => {
    writeRc({ OPENAI_BASE_URL: "https://x", NOT_A_REAL_KEY: "y" });
    const load = loadRc(root);
    expect(load.errors.join("\n")).toMatch(/NOT_A_REAL_KEY/);
    expect(load.errors.join("\n")).toMatch(/example/);
  });

  it("LAYA_TODAY 想当机器配置 → 未知键拒绝（展开日期属于仓库常量，不属于本机）", () => {
    writeRc({ LAYA_TODAY: "2027-01-01" });
    const load = loadRc(root);
    expect(load.errors.length).toBeGreaterThan(0);
    expect(load.errors.join("\n")).toMatch(/LAYA_TODAY/);
  });

  it("坏 JSON：错误点名文件，不崩、不静默当空", () => {
    writeRc("{ this is not json ");
    const load = loadRc(root);
    expect(load.errors.join("\n")).toMatch(/不是合法 JSON/);
    expect(load.values).toEqual({});
  });

  it("非字符串值：点名该键", () => {
    writeRc({ PLANNER_MODEL: { nested: true } });
    expect(loadRc(root).errors.join("\n")).toMatch(/PLANNER_MODEL 必须是字符串/);
  });

  it("有错时 applyRcToEnv 一个字都不写进 env（拒绝先于生效）", () => {
    writeRc({ OPENAI_API_KEY: "sk-1", BAD_KEY: "x" });
    const env: NodeJS.ProcessEnv = {};
    applyRcToEnv(env, root);
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("顶层不是对象（数组/标量）也拒绝", () => {
    writeRc([1, 2, 3]);
    expect(loadRc(root).errors.join("\n")).toMatch(/顶层必须是对象/);
  });
});

describe("rc：掩码与来源展示（doctor 口径）", () => {
  it("凭据名按长度掩码，路径类原样显示", () => {
    expect(maskValue("TOKEN_PLAN_API_KEY", "sk-abcdefghij123")).toMatch(/^\*+/);
    expect(maskValue("TOKEN_PLAN_API_KEY", "sk-abcdefghij123")).toContain("已掩码");
    expect(maskValue("LAYA_ONNX_MODEL", "/tmp/laya_dec.onnx")).toBe("/tmp/laya_dec.onnx");
  });

  it("rcStatusLines 标出每个键的来源（文件 vs 环境）", () => {
    writeRc({ LAYA_ONNX_MODEL: "/from/file.onnx", OPENAI_API_KEY: "sk-secretvalue" });
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-envwins" };
    applyRcToEnv(env, root);
    const text = rcStatusLines(env, root).join("\n");
    expect(text).toMatch(/LAYA_ONNX_MODEL=.*文件/);
    expect(text).toMatch(/OPENAI_API_KEY=.*（环境）/);
    expect(text).not.toMatch(/sk-envwins/);        // 凭据值绝不原样进展示
  });
});

describe("rc：接进既有单一读点（不新造第二套配置门）", () => {
  it("文件里的 LAYA_ONNX_MODEL 经 onnxModelPath/checkArtifacts/modelConfigError 生效", () => {
    const onnx = path.join(root, "laya_dec.onnx");
    fs.writeFileSync(onnx, "x"); fs.writeFileSync(`${onnx}.data`, "y");
    writeRc({ LAYA_ONNX_MODEL: onnx });
    const env: NodeJS.ProcessEnv = {};
    applyRcToEnv(env, root);
    expect(onnxModelPath(env)).toBe(onnx);
    expect(checkArtifacts(onnxModelPath(env), () => "tok-dir").ready).toBe(true);
    expect(modelConfigError(env)).toBeNull();       // 显式指向存在的文件 → 不是用法错误
  });

  it("文件把一个不存在的图指给 LAYA_ONNX_MODEL → modelConfigError 点名（配置错误，非缺件）", () => {
    writeRc({ LAYA_ONNX_MODEL: path.join(root, "absent.onnx") });
    const env: NodeJS.ProcessEnv = {};
    applyRcToEnv(env, root);
    expect(String(modelConfigError(env))).toMatch(/does not exist/);
  });
});
