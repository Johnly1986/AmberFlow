/**
 * 本地检查点选择：`AMBERFLOW_DECISION_MODEL` 在没有 provider 时选本地 checkpoint。
 * 命令行不再有 `--model` / `--checkpoint`；模型名只走配置。
 */
import { afterEach, describe, expect, it } from "vitest";
import { configuredDecisionModel, resolveLocalCheckpoint } from "../src/model/checkpoint.ts";
import { main as appMain } from "../src/app/app-runner.ts";

const prev = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
  Object.assign(process.env, prev);
});

function clean(extra: Record<string, string> = {}): void {
  for (const k of ["AMBERFLOW_DECISION_MODEL", "AMBERFLOW_DECISION_PROVIDER",
    "AMBERFLOW_DEFAULT_DECISION_PROVIDER"]) delete process.env[k];
  Object.assign(process.env, extra);
}

describe("AMBERFLOW_DECISION_MODEL — 本地 checkpoint", () => {
  it("配置 > 包声明 > english；空串等于没设", () => {
    clean();
    expect(configuredDecisionModel()).toBeNull();
    expect(resolveLocalCheckpoint(process.env)).toBe("english");
    expect(resolveLocalCheckpoint(process.env, "multilingual")).toBe("multilingual");
    clean({ AMBERFLOW_DECISION_MODEL: "multilingual" });
    expect(resolveLocalCheckpoint(process.env, "english")).toBe("multilingual");
    clean({ AMBERFLOW_DECISION_MODEL: " " });
    expect(resolveLocalCheckpoint(process.env)).toBe("english");
  });

  it("router 只对 benchmark 臂开放；在线模型名不是本地 checkpoint，报错指路 provider", () => {
    clean({ AMBERFLOW_DECISION_MODEL: "router" });
    expect(resolveLocalCheckpoint(process.env, null, { allowRouter: true })).toBe("router");
    expect(() => resolveLocalCheckpoint(process.env)).toThrow(/不是本地 checkpoint/);
    clean({ AMBERFLOW_DECISION_MODEL: "decision-model-preview" });
    expect(() => resolveLocalCheckpoint(process.env)).toThrow(/设置 provider/);
  });

  it("app-runner 在没有 provider 时用配置的本地 checkpoint；在线模型名会 exit 2", async () => {
    clean({ AMBERFLOW_DECISION_MODEL: "multilingual" });
    expect(await appMain(["--app", "demo-app", "--dry"])).toBe(0);

    clean({ AMBERFLOW_DECISION_MODEL: "decision-model-preview" });
    expect(await appMain(["--app", "demo-app", "--dry"])).toBe(2);
  });
});
