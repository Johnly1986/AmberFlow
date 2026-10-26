/**
 * 原始工具入口的统一配置引导：`npm run apps` / `apps:suite` / `tools/*` 直接跑时，
 * 也必须看见 `amber config set` 写的 `AMBERFLOW_DECISION_*`（以前它们只读旧 rc）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { applyConfiguredEnv } from "../src/support/apply-config-env.ts";
import { resolveProviderSpec } from "../src/model/decision-provider.ts";
import { REPO } from "../src/flow/flow.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-apply-env-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const prev = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
  Object.assign(process.env, prev);
});

function homeWith(config: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(tmp, "home-"));
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config), "utf-8");
  return home;
}

describe("原始工具入口读统一配置层", () => {
  it("用户配置里的统一三键被补进 env；环境变量仍然赢", () => {
    const home = homeWith({
      AMBERFLOW_DECISION_BASE_URL: "http://127.0.0.1:8008",
      AMBERFLOW_DECISION_MODEL: "kev-onnx",
      AMBERFLOW_DECISION_API_KEY: "from-config",
    });
    const env: NodeJS.ProcessEnv = { ...process.env, AMBERFLOW_HOME: home, AMBERFLOW_DECISION_MODEL: "from-env" };
    const result = applyConfiguredEnv(env, REPO, { includeFiles: true });
    expect(result.errors).toEqual([]);
    expect(env.AMBERFLOW_DECISION_BASE_URL).toBe("http://127.0.0.1:8008");
    expect(env.AMBERFLOW_DECISION_API_KEY).toBe("from-config");
    expect(env.AMBERFLOW_DECISION_MODEL).toBe("from-env");      // 环境变量优先
    expect(result.applied).toContain("AMBERFLOW_DECISION_BASE_URL");
    expect(result.applied).not.toContain("AMBERFLOW_DECISION_MODEL");
  });

  it("补完之后没有 provider 时默认走本地模型", async () => {
    const home = homeWith({
      AMBERFLOW_DECISION_BASE_URL: "http://127.0.0.1:8008",
      AMBERFLOW_DECISION_MODEL: "kev-onnx",
    });
    for (const key of ["AMBERFLOW_DECISION_BASE_URL", "AMBERFLOW_DECISION_MODEL", "AMBERFLOW_DECISION_API_KEY",
      "AMBERFLOW_DECISION_PROTOCOL", "AMBERFLOW_DEFAULT_DECISION_PROVIDER", "AMBERFLOW_DECISION_PROVIDER"]) {
      delete process.env[key];
    }
    process.env.AMBERFLOW_HOME = home;
    const result = applyConfiguredEnv(process.env, REPO, { includeFiles: true });
    expect(result.errors).toEqual([]);
    const spec = await resolveProviderSpec(undefined, process.env);
    expect(spec.name).toBe("laya-onnx");

    const home2 = homeWith({
      AMBERFLOW_DECISION_BASE_URL: "http://127.0.0.1:8008",
      AMBERFLOW_DECISION_MODEL: "kev-onnx",
      AMBERFLOW_DECISION_PROVIDER: "decision-service",
    });
    process.env.AMBERFLOW_HOME = home2;
    applyConfiguredEnv(process.env, REPO, { includeFiles: true });
    const service = await resolveProviderSpec(undefined, process.env);
    expect(service.name).toBe("decision-service");
    expect(service.tier).toBe("on");
  });

  it("配置层里的未知键照样报错（入口应 exit 2，不是静默忽略）", () => {
    const home = homeWith({ AMBERFLOW_DECISION_BASE_URL: "http://127.0.0.1:8008", NOT_A_KEY: "x" });
    const env: NodeJS.ProcessEnv = { ...process.env, AMBERFLOW_HOME: home };
    const result = applyConfiguredEnv(env, REPO, { includeFiles: true });
    expect(result.errors.join("\n")).toMatch(/NOT_A_KEY/);
  });
});
