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
// cwd 不能是 REPO：resolveConfig 会读 <cwd>/.amberflow/config.json（项目配置，优先级高于
// 用户配置）——开发者本机一旦 `amber config set --project` 过，测试就随他的真实配置漂移。
// 旧 rc 由 resolveConfig 内部固定从 REPO 根读，不受这里 cwd 影响。
const cwd = fs.mkdtempSync(path.join(tmp, "cwd-"));
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
    const result = applyConfiguredEnv(env, cwd, { includeFiles: true });
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
    const result = applyConfiguredEnv(process.env, cwd, { includeFiles: true });
    expect(result.errors).toEqual([]);
    const spec = await resolveProviderSpec(undefined, process.env);
    expect(spec.name).toBe("laya-onnx");

    const home2 = homeWith({
      AMBERFLOW_DECISION_BASE_URL: "http://127.0.0.1:8008",
      AMBERFLOW_DECISION_MODEL: "kev-onnx",
      AMBERFLOW_DECISION_PROVIDER: "decision-service",
    });
    process.env.AMBERFLOW_HOME = home2;
    applyConfiguredEnv(process.env, cwd, { includeFiles: true });
    const service = await resolveProviderSpec(undefined, process.env);
    expect(service.name).toBe("decision-service");
    expect(service.tier).toBe("on");
  });

  it("配置层里的未知键照样报错（入口应 exit 2，不是静默忽略）", () => {
    const home = homeWith({ AMBERFLOW_DECISION_BASE_URL: "http://127.0.0.1:8008", NOT_A_KEY: "x" });
    const env: NodeJS.ProcessEnv = { ...process.env, AMBERFLOW_HOME: home };
    const result = applyConfiguredEnv(env, cwd, { includeFiles: true });
    expect(result.errors.join("\n")).toMatch(/NOT_A_KEY/);
  });

  it("项目配置盖住旧 rc（旧 rc 是最低层，不是最高层）", async () => {
    // 本机的旧 rc（gitignore 的 configs/amberflowrc.json）带着 AMBERFLOW_DECISION_PROVIDER=token-plan；
    // 用户/项目配置点名别的 provider 时必须赢——以前 applyConfiguredEnv 先把旧 rc 灌进 env，
    // resolveConfig 就把它当"环境变量"（最高层），项目配置永远盖不住。CI 没有旧 rc 时跳过。
    // applyRcToEnv 对测试进程有 VITEST 守卫（不吸收本机 rc），这里临时摘掉它才能测旧 rc 层；
    // afterEach 的快照会恢复。写 process.env（同上例）：provider 工厂绑的是 process.env。
    const legacy = path.join(REPO, "configs", "amberflowrc.json");
    if (!fs.existsSync(legacy)) return;
    for (const key of ["AMBERFLOW_DECISION_BASE_URL", "AMBERFLOW_DECISION_MODEL", "AMBERFLOW_DECISION_API_KEY",
      "AMBERFLOW_DECISION_PROTOCOL", "AMBERFLOW_DEFAULT_DECISION_PROVIDER", "AMBERFLOW_DECISION_PROVIDER", "VITEST"]) {
      delete process.env[key];
    }
    process.env.AMBERFLOW_HOME = homeWith({ AMBERFLOW_DECISION_PROVIDER: "decision-service" });
    const result = applyConfiguredEnv(process.env, cwd, { includeFiles: true });
    const spec = await resolveProviderSpec(undefined, process.env);
    expect(spec.name).toBe("decision-service");   // 配置层赢，旧 rc 的 provider 不许冒上来
    expect(result.errors).toEqual([]);
  });
});
