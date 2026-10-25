/**
 * 统一决策服务配置层（`AMBERFLOW_DECISION_BASE_URL / _MODEL / _API_KEY`）的契约测试。
 *
 * 只认线协议：一个真实的小 HTTP 服务扮演 System One 服务端，断言
 *   - 地址归一化（host / …/v1 / …/compatible-mode/v1 / 完整 …/systemone）；
 *   - 三个统一键被写进请求（Authorization、state、model）；
 *   - pick / askChoice / risk 的映射（choice/noul → DecisionProvider 的字段）；
 *   - 缺配置/坏协议/坏刻度在解析期就红，而不是跑到一半才降级。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DECISION_SERVICE_KEYS, decisionServiceConfigured, decisionServiceProvider,
  normalizeSystemOneEndpoint, serviceConfigError, serviceProtocol,
} from "../src/model/decision-service.ts";
import { resolveProviderSpec } from "../src/model/decision-provider.ts";
import { isKnownConfigKey } from "../src/cli/config-store.ts";
import { cli, workspace } from "./cli-harness.ts";

const prevEnv = { ...process.env };
function setEnv(values: Record<string, string | undefined>): void {
  for (const key of DECISION_SERVICE_KEYS) delete process.env[key];
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
afterEach(() => {
  setEnv({});
});
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in prevEnv)) delete process.env[key];
  Object.assign(process.env, prevEnv);
});

describe("地址归一化", () => {
  it("host / v1 / compatible-mode/v1 / 完整 systemone 都归一到同一个端点", () => {
    expect(normalizeSystemOneEndpoint("https://api.typesafe.ai"))
      .toBe("https://api.typesafe.ai/v1/systemone");
    expect(normalizeSystemOneEndpoint("https://api.typesafe.ai/"))
      .toBe("https://api.typesafe.ai/v1/systemone");
    expect(normalizeSystemOneEndpoint("http://localhost:8008"))
      .toBe("http://localhost:8008/v1/systemone");
    expect(normalizeSystemOneEndpoint("https://host.example/compatible-mode/v1"))
      .toBe("https://host.example/compatible-mode/v1/systemone");
    expect(normalizeSystemOneEndpoint("https://host.example/compatible-mode/v1/systemone/"))
      .toBe("https://host.example/compatible-mode/v1/systemone");
    expect(normalizeSystemOneEndpoint("api.example.com/base"))
      .toBe("https://api.example.com/base/v1/systemone");
  });

  it("协议按 URL 推断（默认 systemone；/decisions 才是 OpenAI Decisions）", () => {
    expect(serviceProtocol({ AMBERFLOW_DECISION_BASE_URL: "https://api.typesafe.ai" })).toBe("systemone");
    expect(serviceProtocol({ AMBERFLOW_DECISION_BASE_URL: "https://host/compatible-mode/v1" })).toBe("systemone");
    expect(serviceProtocol({ AMBERFLOW_DECISION_BASE_URL: "https://api.openai.com/v1/decisions" })).toBe("openai-decisions");
    expect(serviceProtocol({
      AMBERFLOW_DECISION_BASE_URL: "https://host/custom", AMBERFLOW_DECISION_PROTOCOL: "systemone",
    })).toBe("systemone");
  });

  it("坏 URL / 查询串在归一化时拒绝", () => {
    expect(() => normalizeSystemOneEndpoint("ftp://host")).toThrow(/http\(s\)/);
    expect(() => normalizeSystemOneEndpoint("https://host/v1/systemone?x=1")).toThrow(/查询串/);
  });
});

describe("配置可用性（解析期就红）", () => {
  it("缺地址 / 远程缺 key / 本地无 key / 坏协议 / 坏刻度", () => {
    expect(serviceConfigError({})).toMatch(/缺服务地址/);
    expect(decisionServiceConfigured({})).toBe(false);
    expect(serviceConfigError({ AMBERFLOW_DECISION_BASE_URL: "https://api.typesafe.ai" }))
      .toMatch(/缺 API key/);
    expect(serviceConfigError({
      AMBERFLOW_DECISION_BASE_URL: "http://127.0.0.1:8008",
    })).toBeNull();                                   // 本地自托管可无认证
    expect(serviceConfigError({
      AMBERFLOW_DECISION_BASE_URL: "http://127.0.0.1:8008",
      AMBERFLOW_DECISION_PROTOCOL: "openai-decisions",
    })).toMatch(/还没实现/);
    expect(serviceConfigError({
      AMBERFLOW_DECISION_BASE_URL: "https://x.example",
      AMBERFLOW_DECISION_API_KEY: "k",
      AMBERFLOW_DECISION_FLOOR: "1.5",
    })).toMatch(/0–1/);
  });

  it("统一键都进了 config 白名单", () => {
    for (const key of DECISION_SERVICE_KEYS) expect(isKnownConfigKey(key), key).toBe(true);
  });

  it("amber config set 能写统一键，show 对密钥掩码", async () => {
    const ws = workspace();
    try {
      for (const [k, v] of [
        ["AMBERFLOW_DECISION_BASE_URL", "http://127.0.0.1:8008"],
        ["AMBERFLOW_DECISION_MODEL", "kev-onnx"],
        ["AMBERFLOW_DECISION_API_KEY", "test-secret-value"],
      ] as const) {
        const r = await cli(["config", "set", k, v], { home: ws.home });
        expect(r.code, `${k}: ${r.out}${r.err}`).toBe(0);
      }
      const show = await cli(["config", "show"], { home: ws.home });
      expect(show.out).toContain("AMBERFLOW_DECISION_BASE_URL");
      expect(show.out).not.toContain("test-secret-value");
      expect(show.out).toMatch(/已掩码|掩码/);
    } finally {
      ws.cleanup();
    }
  });
});

describe("线协议映射（假 System One 服务）", () => {
  let server: ReturnType<typeof createServer>;
  let base: string;
  const seen: Array<{ url: string; auth: string; body: any }> = [];

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (c) => { raw += String(c); });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        seen.push({ url: req.url ?? "", auth: String(req.headers.authorization ?? ""), body });
        const q = body.questions ?? {};
        const answers: Record<string, unknown> = {};
        for (const [qid, question] of Object.entries<any>(q)) {
          if (question.type === "choice") {
            const keys = Object.keys(question.criteria ?? {});
            answers[qid] = {
              type: "choice", choice: keys[1] ?? keys[0] ?? null,
              confidence: 0.9, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 1 ? 0.7 : 0.15])),
            };
          } else if (question.type === "noul") {
            answers[qid] = { type: "noul", noul: 0.87 };
          } else {
            answers[qid] = { type: "score", score: 1.5, confidence: 0.8, probabilities: { "0": 0.2, "1": 0.5, "2": 0.3 } };
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ answers, usage: { input_tokens: 42 }, latency_ms: 1 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const fakePage = {
    url: () => "http://fake.test/ticket",
    title: async () => "Fake ticket page",
    locator: () => { throw new Error("no DOM in this fake"); },
  } as never;

  function providerFor(overrides: Record<string, string> = {}) {
    setEnv({
      AMBERFLOW_DECISION_BASE_URL: base,
      AMBERFLOW_DECISION_MODEL: "test-model",
      AMBERFLOW_DECISION_API_KEY: "test-key",
      ...overrides,
    });
    return decisionServiceProvider(process.env);
  }

  it("pick：三键进请求；choice 映射成 ChoiceOutcome（ref/score/signals/options/probs）", async () => {
    seen.length = 0;
    const provider = providerFor();
    const outcome = await provider.pick({
      goal: "Route the ticket",
      page: fakePage,
      elems: {
        e1: { tag: "button", label: "Billing" },
        e2: { tag: "button", label: "Technical" },
        e3: { tag: "button", label: "Other" },
      },
      forbidden: new Set(),
      notes: null,
      narrow: null,
      k: 8,
    });
    expect(outcome.ref).toBe("e2");
    expect(outcome.score).toBe(0.9);
    expect(outcome.scoreKind).toBe("calibrated_prob");
    expect(outcome.signals.pTop1).toBe(0.7);
    expect(outcome.signals.pTop2).toBe(0.15);
    expect(outcome.signals.margin!).toBeCloseTo(0.55, 10);
    expect(outcome.options).toBe(3);
    expect(outcome.probs["e2"]).toBe(0.7);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/v1/systemone");
    expect(seen[0]!.auth).toBe("Bearer test-key");
    expect(seen[0]!.body.model).toBe("test-model");
    expect(seen[0]!.body.state).toMatchObject({ goal: "Route the ticket", url: "http://fake.test/ticket", title: "Fake ticket page" });
    expect(Object.keys(seen[0]!.body.questions.act.criteria)).toEqual(["e1", "e2", "e3"]);
  });

  it("risk/askChoice 用同一个服务：noul → 概率；闭集 choice 只接受池内答案", async () => {
    seen.length = 0;
    const provider = providerFor();
    expect(await provider.risk!("do the thing", "click Pay")).toBeCloseTo(0.87);
    const ask = await provider.askChoice!({
      goal: "pick a tool", instructions: "Which tool?", criteria: { a: "A", b: "B" },
    });
    expect(ask?.ref).toBe("b");
    expect(ask?.score).toBe(0.9);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.body.questions.act.type).toBe("choice");
  });

  it("解析器：配了服务地址就默认用它；显式点名但没配好 → 响亮报错", async () => {
    setEnv({ AMBERFLOW_DECISION_BASE_URL: base, AMBERFLOW_DECISION_API_KEY: "test-key", AMBERFLOW_DECISION_MODEL: "m" });
    const spec = await resolveProviderSpec(undefined, process.env);
    expect(spec.name).toBe("decision-service");
    expect(spec.tier).toBe("on");
    expect(spec.kind).toBe("provider");

    setEnv({});
    await expect(resolveProviderSpec("decision-service", process.env)).rejects.toThrow(/缺服务地址/);
  });
});
