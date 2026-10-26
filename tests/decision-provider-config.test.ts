/**
 * **决策源选择**：地址/密钥/模型三件套或本地 checkpoint，不再需要 provider 键。
 *
 * 钉住四条行为：
 *  ① 没有服务地址 ⇒ 本地 laya（开箱不受影响）；
 *  ② 有服务地址 ⇒ 统一决策服务（即使没有 `AMBERFLOW_DECISION_PROVIDER`）；
 *  ③ 配了地址却缺密钥/坏协议 ⇒ 解析期响亮报错，不静默降到规则档；
 *  ④ `--provider NAME` 仍可作为本次实验/兼容旧适配器的显式覆盖。
 *
 * 旧键 `AMBERFLOW_DECISION_PROVIDER` / `AMBERFLOW_DEFAULT_DECISION_PROVIDER` 不再是配置面，
 * 这里顺带证明它们不会再改变选择。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProviderSpec } from "../src/model/decision-provider.ts";

const ENDPOINT = "https://x.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone";
const KEYS = ["DASHSCOPE_API_KEY", "BAILIAN_API_KEY", "BAILIAN_ENDPOINT", "BAILIAN_WORKSPACE_ID"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } });

describe("resolveProviderSpec：三件套选线上，无地址选本地", () => {
  it("① 没有服务地址 ⇒ 本地 laya（旧 provider 键不再参与选择）", async () => {
    const spec = await resolveProviderSpec(undefined, {
      AMBERFLOW_DECISION_PROVIDER: "bailian",
      AMBERFLOW_DEFAULT_DECISION_PROVIDER: "bailian",
    });
    expect(spec.kind).toBe("laya");
    expect(spec.name).toBe("laya-onnx");
  });

  it("② 有服务地址 ⇒ decision-service，不需要 provider 键", async () => {
    const spec = await resolveProviderSpec(undefined, {
      AMBERFLOW_DECISION_BASE_URL: "http://127.0.0.1:8008",
      AMBERFLOW_DECISION_MODEL: "m",
    });
    expect(spec.kind).toBe("provider");
    expect(spec.name).toBe("decision-service");
    expect(spec.tier).toBe("on");
  });

  it("③ 地址在但远程缺 key ⇒ 解析期响亮报错（配了服务就是要用服务）", async () => {
    await expect(resolveProviderSpec(undefined, {
      AMBERFLOW_DECISION_BASE_URL: "https://api.example.com",
      AMBERFLOW_DECISION_MODEL: "m",
    })).rejects.toThrow(/决策服务未配置：.*缺 API key/);
  });

  it("④ 显式 --provider bailian 却没配 ⇒ 响亮报错指路", async () => {
    await expect(resolveProviderSpec("bailian", {})).rejects.toThrow(/未配置/);
  });

  it("④b 配好了（key + 端点）⇒ 显式 bailian 仍可用（实验/兼容入口）", async () => {
    process.env.DASHSCOPE_API_KEY = "k";
    process.env.BAILIAN_ENDPOINT = ENDPOINT;
    const spec = await resolveProviderSpec("bailian", {});
    expect(spec.kind).toBe("provider");
    expect(spec.name).toBe("bailian");
    expect(spec.tier).toBe("on");
  });
});