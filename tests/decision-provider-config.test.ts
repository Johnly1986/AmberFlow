/**
 * **决策层·配置判定（Stage 3 第一步，机制先于翻默认）**：
 * `resolveProviderSpec` 在**解析时**就区分在线服务是否已配置，而不是装一个每步都抛的 provider。
 *
 * 钉住三种行为：
 *  ① 环境默认档（没人显式点名）指向未配置的在线服务 ⇒ 干净落到 rules-only（开箱不受影响）；
 *  ② 显式点名（--provider bailian / AMBERFLOW_DECISION_PROVIDER）却没配 ⇒ 响亮报错指路；
 *  ③ 配好了 ⇒ 正常返回 provider 档；且**当前缺省仍是 laya-onnx**（本步不翻默认，行为不变）。
 *
 * 注：provider 读 `process.env`（生产里 resolveProviderSpec 的 env 参数缺省就是 process.env，
 * 一致）；测试因此操作 process.env 来配 provider，AMBERFLOW_* 走传入的 env。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProviderSpec } from "../src/decision-provider.ts";

const ENDPOINT = "https://x.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone";
const KEYS = ["DASHSCOPE_API_KEY", "BAILIAN_API_KEY", "BAILIAN_ENDPOINT", "BAILIAN_WORKSPACE_ID"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } });

describe("resolveProviderSpec：在线服务配置判定（显式报错 / 默认降级）", () => {
  it("① 环境默认档指向未配置的 bailian ⇒ 干净落 rules-only（不抛、不装坏 provider）", async () => {
    const spec = await resolveProviderSpec(undefined, { AMBERFLOW_DEFAULT_DECISION_PROVIDER: "bailian" });
    expect(spec.kind).toBe("none");
    expect(spec.tier).toMatch(/no decision service configured/);
    expect(spec.ablation).toBe(true);   // "没有模型" ≠ "真模型跑了没用"——不能触发 exit 4
  });

  it("② 显式 --provider bailian 却没配 ⇒ 响亮报错指路（用户要的就是它）", async () => {
    await expect(resolveProviderSpec("bailian", {})).rejects.toThrow(/未配置/);
  });

  it("②b 显式经 env AMBERFLOW_DECISION_PROVIDER 却没配 ⇒ 同样响亮报错", async () => {
    await expect(resolveProviderSpec(undefined, { AMBERFLOW_DECISION_PROVIDER: "bailian" }))
      .rejects.toThrow(/未配置/);
  });

  it("③ 配好了（key + 端点）⇒ 正常返回 provider 档", async () => {
    process.env.DASHSCOPE_API_KEY = "k";
    process.env.BAILIAN_ENDPOINT = ENDPOINT;
    const spec = await resolveProviderSpec(undefined, { AMBERFLOW_DECISION_PROVIDER: "bailian" });
    expect(spec.kind).toBe("provider");
    expect(spec.name).toBe("bailian");
    expect(spec.tier).toBe("on");
  });

  it("④ 本步不翻默认：无 AMBERFLOW_* 时缺省仍是 laya-onnx（行为逐字不变）", async () => {
    const spec = await resolveProviderSpec(undefined, {});
    expect(spec.kind).toBe("laya");
    expect(spec.name).toBe("laya-onnx");
  });

  it("⑤ 默认档翻成 bailian 且已配置 ⇒ 走在线 provider（为 Stage 3 下一步预铺）", async () => {
    process.env.DASHSCOPE_API_KEY = "k";
    process.env.BAILIAN_ENDPOINT = ENDPOINT;
    const spec = await resolveProviderSpec(undefined, { AMBERFLOW_DEFAULT_DECISION_PROVIDER: "bailian" });
    expect(spec.kind).toBe("provider");
    expect(spec.name).toBe("bailian");
  });
});
