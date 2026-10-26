/**
 * OpenAI Decisions API 适配器（`POST /v1/decisions`）：协议形状与 System One 不同，
 * 这里用假服务钉住请求/响应映射，并验证统一配置层按 protocol 分发。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  normalizeOpenAIDecisionsEndpoint, OPENAI_DECISIONS_DEFAULT_MODEL, openaiDecisionsProvider,
} from "../src/model/decision-openai.ts";
import {
  DECISION_SERVICE_KEYS, decisionServiceProvider, serviceConfigError,
} from "../src/model/decision-service.ts";
import { resolveProviderSpec } from "../src/model/decision-provider.ts";

const prev = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in prev)) delete process.env[key];
  Object.assign(process.env, prev);
  delete process.env.AMBERFLOW_DECISION_PROVIDER;
  delete process.env.AMBERFLOW_DEFAULT_DECISION_PROVIDER;
});
afterAll(() => { Object.assign(process.env, prev); });

describe("端点归一化", () => {
  it("host / …/v1 / 完整 …/v1/decisions", () => {
    expect(normalizeOpenAIDecisionsEndpoint("https://api.openai.com")).toBe("https://api.openai.com/v1/decisions");
    expect(normalizeOpenAIDecisionsEndpoint("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/decisions");
    expect(normalizeOpenAIDecisionsEndpoint("https://api.openai.com/v1/decisions/"))
      .toBe("https://api.openai.com/v1/decisions");
    expect(normalizeOpenAIDecisionsEndpoint("http://localhost:9000")).toBe("http://localhost:9000/v1/decisions");
  });
});

describe("线协议映射（假 OpenAI Decisions 服务）", () => {
  let server: ReturnType<typeof createServer>;
  let base: string;
  let refusal = false;
  const seen: Array<{ url: string; auth: string; body: any }> = [];

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (c) => { raw += String(c); });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        seen.push({ url: req.url ?? "", auth: String(req.headers.authorization ?? ""), body });
        const answers = (body.questions ?? []).map((q: Record<string, any>) => {
          if (refusal) return { type: "refusal", name: q.name };
          if (q.type === "predicate") return { type: "predicate", name: q.name, probability: 0.87 };
          if (q.type === "choice") {
            const choices = (q.choices ?? []) as Array<{ value: string }>;
            return {
              type: "choice", name: q.name, choice: choices[1]?.value ?? choices[0]?.value,
              confidence: 0.9,
              probabilities: choices.map((c, i) => ({ value: c.value, probability: i === 1 ? 0.7 : 0.15 })),
            };
          }
          return { type: "score", name: q.name, score: 1.2, confidence: 0.8 };
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ answers, usage: { input_tokens: 42 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  const fakePage = {
    url: () => "http://fake.test/ticket",
    title: async () => "Fake ticket page",
    locator: () => { throw new Error("no DOM in this fake"); },
  } as never;

  function provider() {
    return openaiDecisionsProvider({
      endpoint: normalizeOpenAIDecisionsEndpoint(base),
      model: "gpt-6-luna",
      apiKey: "test-key",
    });
  }

  it("pick：input 带上下文、questions 是数组、choice 映射成 ChoiceOutcome", async () => {
    refusal = false; seen.length = 0;
    const outcome = await provider().pick({
      goal: "Route the ticket",
      page: fakePage,
      elems: { e1: { tag: "button", label: "Billing" }, e2: { tag: "button", label: "Technical" }, e3: { tag: "button", label: "Other" } },
      forbidden: new Set(), notes: null, narrow: null, k: 8,
    });
    expect(outcome.ref).toBe("e2");
    expect(outcome.score).toBe(0.9);
    expect(outcome.scoreKind).toBe("calibrated_prob");
    expect(outcome.signals.pTop1).toBe(0.7);
    expect(outcome.signals.pTop2).toBe(0.15);
    expect(outcome.signals.margin!).toBeCloseTo(0.55, 10);
    expect(outcome.options).toBe(3);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/v1/decisions");
    expect(seen[0]!.auth).toBe("Bearer test-key");
    expect(seen[0]!.body.model).toBe("gpt-6-luna");
    expect(seen[0]!.body.input).toContain("Goal: Route the ticket");
    expect(seen[0]!.body.input).toContain("http://fake.test/ticket");
    expect(seen[0]!.body.input).toContain("Fake ticket page");
    const q = seen[0]!.body.questions[0];
    expect(q).toMatchObject({ type: "choice", name: "act" });
    expect(q.choices.map((c: { value: string }) => c.value)).toEqual(["e1", "e2", "e3"]);
  });

  it("risk/askChoice 走 predicate/choice；拒绝(refusal)映射成“没答”，不伪装成低置信", async () => {
    refusal = false; seen.length = 0;
    const p = provider();
    expect(await p.risk!("do the thing", "click Pay")).toBeCloseTo(0.87);
    const ask = await p.askChoice!({ goal: "pick", instructions: "Which?", criteria: { a: "A", b: "B" } });
    expect(ask?.ref).toBe("b");
    expect(seen[1]!.body.questions[0].type).toBe("choice");

    refusal = true;
    const refused = await provider().pick({
      goal: "x", page: fakePage,
      elems: { a: { tag: "button", label: "A" } },
      forbidden: new Set(), notes: null, narrow: null, k: 8,
    });
    expect(refused.ref).toBeNull();
    expect(refused.signals).toEqual({ pTop1: null, pTop2: null, margin: null });
    await expect(provider().risk!("g", "a")).rejects.toThrow(/refusal/);
  });
});

describe("统一配置按 protocol 分发", () => {
  it("openai-decisions → OpenAI provider（默认 gpt-6-luna）；systemone 仍是 System One", () => {
    for (const key of DECISION_SERVICE_KEYS) delete process.env[key];
    process.env.AMBERFLOW_DECISION_BASE_URL = "http://127.0.0.1:9000/v1/decisions";
    process.env.AMBERFLOW_DECISION_PROTOCOL = "openai-decisions";
    process.env.AMBERFLOW_DECISION_API_KEY = "k";
    const p = decisionServiceProvider(process.env);
    expect(p.name).toBe("decision-service");
    expect(p.version).toBe(OPENAI_DECISIONS_DEFAULT_MODEL);
    expect(p.capabilities.score_kind).toBe("calibrated_prob");
    expect(serviceConfigError(process.env)).toBeNull();
  });

  it("配置好 OpenAI Decisions 后默认解析到 decision-service；缺 key 在解析期报错", async () => {
    for (const key of DECISION_SERVICE_KEYS) delete process.env[key];
    process.env.AMBERFLOW_DECISION_BASE_URL = "http://127.0.0.1:9000";
    process.env.AMBERFLOW_DECISION_PROTOCOL = "openai-decisions";
    process.env.AMBERFLOW_DECISION_API_KEY = "k";
    process.env.AMBERFLOW_DECISION_PROVIDER = "decision-service";
    const spec = await resolveProviderSpec(undefined, process.env);
    expect(spec.name).toBe("decision-service");
    expect(spec.tier).toBe("on");

    delete process.env.AMBERFLOW_DECISION_API_KEY;
    process.env.AMBERFLOW_DECISION_BASE_URL = "https://api.openai.com/v1/decisions";
    // provider 仍是显式 decision-service：缺 key 必须在解析期报错，而不是退回本地。
    await expect(resolveProviderSpec(undefined, process.env)).rejects.toThrow(/缺 API key/);
  });
});
