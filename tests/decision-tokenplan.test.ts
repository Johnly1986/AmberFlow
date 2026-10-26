/**
 * token-plan MaaS 网关 `decision-model-preview` provider 的测试：**不碰网络、不碰真 key**，
 * 用一个假的 `/compatible-mode/v1/systemone` 服务把线协议钉住（与 JevK5 / 百炼测试同一套方法）。
 *
 * 钉住的重点（都是 2026-10-15 对真服务的实测结论，必须各自有证据）：
 * - 认证走 header、不进 body：`Authorization: Bearer <key>`；key 从环境按名读，绝不内联；
 * - **`confidence` ≠ `max(probabilities)`**（实测 0.97 vs 0.98）——score 取 confidence，
 *   pTop1/pTop2/margin 取分布，score_kind=calibrated_prob；
 * - **单候选也能问**（实测 1 项 OK）；只有 0 候选才不发请求；
 * - 池外答案当作没答（ref=null）；
 * - 缺 key / 非 2xx（401 invalid_api_key / 404 model_not_found / 400 InvalidParameter）：
 *   报错带服务端原因与指路，不静默退回、不瞎选；
 * - 显式点名却没配 ⇒ 解析期响亮报错；环境默认档没配 ⇒ 干净落 rules-only。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { tokenPlanProvider } from "../src/model/decision-tokenplan.ts";
import { resolveProviderSpec } from "../src/model/decision-provider.ts";
import { providerContract } from "./provider-contract.ts";
import type { ChoiceRequest } from "../src/model/decision-provider.ts";

let replies: Record<string, unknown>[] = [];
let received: { path: string; auth?: string; body: any }[] = [];
let status = 200;
let server: http.Server;
let endpoint = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      received.push({ path: req.url ?? "", auth: req.headers["authorization"], body });
      const answer = replies[received.length - 1] ?? replies[0];
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200
        ? { model: "decision-model-preview", request_id: "r-1", answers: { act: answer, q: answer }, usage: { input_tokens: 10 }, latency_ms: 1 }
        : answer));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/compatible-mode/v1/systemone`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
afterEach(() => { status = 200; });

const fakeElems = { e1: { tag: "button", label: "Add to cart" }, e2: { tag: "a", label: "Cart" } } as never;
const reqOf = (over: Partial<ChoiceRequest> = {}): ChoiceRequest => ({
  goal: "add the wireless mouse to the cart",
  page: { title: async () => "Shop", url: () => "file://x" } as never,
  elems: fakeElems, forbidden: new Set(), notes: null, narrow: null, k: 8, ...over,
});
function reset(answer: Record<string, unknown>, code = 200): void {
  replies = [answer]; received = []; status = code;
}
const P = () => tokenPlanProvider({ endpoint, apiKey: "test-key-not-secret" });

describe("token-plan decision-model-preview provider（假 /systemone，无网络无真 key）", () => {
  it("线协议：POST <base>/systemone，带 model + Bearer 认证头（key 不进 body）", async () => {
    reset({ type: "choice", choice: "e1", confidence: 0.97, probabilities: { e1: 0.98, e2: 0.02 } });
    const out = await P().pick(reqOf());
    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe("/compatible-mode/v1/systemone");
    expect(received[0]!.auth).toBe("Bearer test-key-not-secret");        // 认证在 header
    expect(JSON.stringify(received[0]!.body)).not.toContain("test-key-not-secret"); // 绝不在 body
    expect(received[0]!.body.model).toBe("decision-model-preview");
    expect(received[0]!.body.questions.act.type).toBe("choice");
    expect(Object.keys(received[0]!.body.questions.act.criteria)).toEqual(["e1", "e2"]);
    expect(received[0]!.body.state.goal).toContain("wireless mouse");
    expect(out.ref).toBe("e1");
  });

  it("confidence ≠ max(prob)（实测 0.97 vs 0.98）：score 取 confidence，分布进 signals", async () => {
    reset({ type: "choice", choice: "e1", confidence: 0.97, probabilities: { e1: 0.98, e2: 0.02 } });
    const out = await P().pick(reqOf());
    expect(out.scoreKind).toBe("calibrated_prob");
    expect(out.score).toBeCloseTo(0.97);          // provider 的"把握" = confidence
    expect(out.signals.pTop1).toBeCloseTo(0.98);  // 分布的最大值 ≠ confidence
    expect(out.signals.margin).toBeCloseTo(0.96);
  });

  it("单候选也发请求（实测 1 项 OK）；0 候选才不发请求、signals 全 null", async () => {
    reset({ type: "choice", choice: "e1", confidence: 1, probabilities: { e1: 1 } });
    const one = { e1: { tag: "button", label: "Only" } } as never;
    const out = await P().pick(reqOf({ elems: one }));
    expect(received).toHaveLength(1);
    expect(out.ref).toBe("e1");
    reset({ type: "choice", choice: "e1", confidence: 1, probabilities: { e1: 1 } });
    const none = await P().pick(reqOf({ forbidden: new Set(["e1", "e2"]) }));
    expect(received).toHaveLength(0);
    expect(none.ref).toBeNull();
    expect(none.signals.pTop1).toBeNull();
  });

  it("池外答案（模型给 other）当作没答，不拿它点不存在的元素", async () => {
    reset({ type: "choice", choice: "other", confidence: 0.5, probabilities: { other: 0.5, e1: 0.5 } });
    const out = await P().pick(reqOf());
    expect(out.ref).toBeNull();
  });

  it("缺 key：报错指路，不敲服务、不静默退回", async () => {
    const p = tokenPlanProvider({ endpoint });     // 不传 apiKey
    const savedA = process.env.TOKEN_PLAN_API_KEY, savedD = process.env.DASHSCOPE_API_KEY;
    delete process.env.TOKEN_PLAN_API_KEY; delete process.env.DASHSCOPE_API_KEY;
    received = [];                                // 下面要证"根本没去敲门"
    try {
      await expect(p.pick(reqOf())).rejects.toThrow(/TOKEN_PLAN_API_KEY|DASHSCOPE_API_KEY/);
      expect(received).toHaveLength(0);
    } finally {
      if (savedA !== undefined) process.env.TOKEN_PLAN_API_KEY = savedA;
      if (savedD !== undefined) process.env.DASHSCOPE_API_KEY = savedD;
    }
  });

  it("非 2xx：把服务端原因带出来（401 invalid_api_key / 404 model_not_found 不吞）", async () => {
    reset({ error: { message: "Invalid API-key provided.", code: "invalid_api_key" } }, 401);
    await expect(P().pick(reqOf())).rejects.toThrow(/401.*Invalid API-key provided/);
    reset({ error: { message: "Model not exist.", code: "model_not_found" } }, 404);
    await expect(P().pick(reqOf())).rejects.toThrow(/404.*Model not exist/);
    reset({ code: "InvalidParameter", message: "<400> invalid SystemOne request: criteria" }, 400);
    await expect(P().pick(reqOf())).rejects.toThrow(/400.*invalid SystemOne request/);
  });

  it("risk / doneVote 走 noul（返回 P(yes)，不是选项）", async () => {
    reset({ type: "noul", noul: 0.83 });
    const p = P();
    expect(await p.risk!("buy now", 'click button "Buy now"')).toBeCloseTo(0.83);
    reset({ type: "noul", noul: 0.12 });
    expect(await p.doneVote!("g", { url: "file://x" })).toBeCloseTo(0.12);
  });

  it("askChoice（S2 ③ 提名形状）：body 带调用方给的题面/闭集，返回 ref 且做闭集校验", async () => {
    reset({ type: "choice", choice: "fill", confidence: 0.82, probabilities: { click: 0.1, fill: 0.9 } });
    const p = P();
    const out = await p.askChoice!({
      goal: "输入出发城市",
      instructions: "Which single instruction should be executed next?",
      criteria: { click: "点击一个元素", fill: "往输入框里填值" },
    });
    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe("/compatible-mode/v1/systemone");
    expect(received[0]!.auth).toBe("Bearer test-key-not-secret");   // 认证仍在 header
    expect(received[0]!.body.state.goal).toBe("输入出发城市");
    expect(received[0]!.body.questions.act.instructions).toContain("Which single instruction");
    expect(received[0]!.body.questions.act.criteria).toEqual({ click: "点击一个元素", fill: "往输入框里填值" });
    expect(out).toMatchObject({ ref: "fill", score: 0.82, scoreKind: "calibrated_prob" });
    expect(out!.probs).toEqual({ click: 0.1, fill: 0.9 });
    // 池外答案 → null（不拿它去当指令）
    reset({ type: "choice", choice: "other", confidence: 0.5, probabilities: { other: 0.5, click: 0.5 } });
    const out2 = await p.askChoice!({ goal: "g", instructions: "i", criteria: { click: "点击" } });
    expect(out2!.ref).toBeNull();
  });

  // 同一份考卷：外部 provider 与内置 provider 走完全相同的契约
  providerContract("token-plan（假服务）", () => tokenPlanProvider({ endpoint, apiKey: "test-key-not-secret" }),
    () => reqOf().page, () => fakeElems);
});

describe("token-plan 的配置判定（显式/默认两档 + 内建端点）", () => {
  it("自报闸门刻度 0.20（实测边界：camera-entry 的 0.20 一枪在缺省 0.25 下被误伤）", () => {
    expect(tokenPlanProvider().floor).toBe(0.2);
  });

  it("端点只从环境读（共享层不写死外部主机——泄漏门禁的纪律）：缺端点 ⇒ 显式点名报错", async () => {
    const savedE = process.env.TOKEN_PLAN_ENDPOINT, savedA = process.env.TOKEN_PLAN_API_KEY, savedD = process.env.DASHSCOPE_API_KEY;
    delete process.env.TOKEN_PLAN_ENDPOINT;
    process.env.TOKEN_PLAN_API_KEY = "test-key-not-secret";
    try {
      await expect(resolveProviderSpec("token-plan", {})).rejects.toThrow(/未配置.*TOKEN_PLAN_ENDPOINT/);
    } finally {
      if (savedE !== undefined) process.env.TOKEN_PLAN_ENDPOINT = savedE;
      if (savedA === undefined) delete process.env.TOKEN_PLAN_API_KEY; else process.env.TOKEN_PLAN_API_KEY = savedA;
      if (savedD !== undefined) process.env.DASHSCOPE_API_KEY = savedD;
    }
  });

  it("显式 --provider token-plan 却没 key ⇒ 解析期响亮报错指路", async () => {
    const savedA = process.env.TOKEN_PLAN_API_KEY, savedD = process.env.DASHSCOPE_API_KEY;
    const savedE = process.env.TOKEN_PLAN_ENDPOINT;
    delete process.env.TOKEN_PLAN_API_KEY; delete process.env.DASHSCOPE_API_KEY; delete process.env.TOKEN_PLAN_ENDPOINT;
    try {
      await expect(resolveProviderSpec("token-plan", {})).rejects.toThrow(/未配置/);
    } finally {
      if (savedA !== undefined) process.env.TOKEN_PLAN_API_KEY = savedA;
      if (savedD !== undefined) process.env.DASHSCOPE_API_KEY = savedD;
    }
  });

  it("旧 AMBERFLOW_DEFAULT_DECISION_PROVIDER 不再选 provider；没有服务地址 ⇒ 本地", async () => {
    const spec = await resolveProviderSpec(undefined, { AMBERFLOW_DEFAULT_DECISION_PROVIDER: "token-plan" });
    expect(spec.kind).toBe("laya");
    expect(spec.name).toBe("laya-onnx");
  });

  it("配了 key ⇒ 走在线 provider（tier=on，名字如实写 token-plan）", async () => {
    const savedA = process.env.TOKEN_PLAN_API_KEY;
    const savedE = process.env.TOKEN_PLAN_ENDPOINT;
    process.env.TOKEN_PLAN_API_KEY = "test-key-not-secret";
    process.env.TOKEN_PLAN_ENDPOINT = "http://127.0.0.1:1/compatible-mode/v1/systemone";
    try {
      const spec = await resolveProviderSpec("token-plan", {});
      expect(spec).toMatchObject({ kind: "provider", name: "token-plan", tier: "on" });
    } finally {
      if (savedA === undefined) delete process.env.TOKEN_PLAN_API_KEY;
      else process.env.TOKEN_PLAN_API_KEY = savedA;
    }
  });
});

describe("configError：启动期就能判定的配置错误（不该跑到一半退化才说）", () => {
  it("endpoint 少了 /systemone 后缀（实测抄成 /v1 的形状）⇒ 预检点名正确形状", () => {
    const p = tokenPlanProvider({ endpoint: "https://gw.example/compatible-mode/v1", apiKey: "sk-x" });
    expect(String(p.configError?.())).toMatch(/要以 \/compatible-mode\/v1\/systemone 结尾/);
  });

  it("完整形状 + 有 key ⇒ 无配置错误；结尾多一个斜杠也认", () => {
    expect(tokenPlanProvider({ endpoint: "https://gw.example/compatible-mode/v1/systemone", apiKey: "sk-x" }).configError?.()).toBeNull();
    expect(tokenPlanProvider({ endpoint: "https://gw.example/compatible-mode/v1/systemone/", apiKey: "sk-x" }).configError?.()).toBeNull();
  });

  it("缺 key / 缺端点仍按原口径点名", () => {
    const p = tokenPlanProvider({ endpoint: "", apiKey: "" });
    expect(String(p.configError?.())).toMatch(/缺 .*API key.* 与 .*端点/);
  });
});

describe("choice 的上文：state 从 {goal} 扩到 goal+url+title+main_text", () => {
  it("默认带上文；页面取不到的段就少带、题照问（fake 页只供 url/title）", async () => {
    reset({ type: "choice", choice: "e1", confidence: 0.9, probabilities: { e1: 1 } });
    await P().pick(reqOf());
    const st = received[0]!.body.state as Record<string, unknown>;
    expect(st.goal).toContain("wireless mouse");
    expect(st.url).toBe("file://x");
    expect(st.title).toBe("Shop");
    expect("main_text" in st).toBe(false);              // 假页没有 evaluate：少一段，不崩
  });

  it("消融臂 TOKEN_PLAN_STATE_CONTEXT=0 ⇒ state 逐字回到 {goal}（A/B 对照臂同机一键复现）", async () => {
    process.env.TOKEN_PLAN_STATE_CONTEXT = "0";
    try {
      reset({ type: "choice", choice: "e1", confidence: 0.9, probabilities: { e1: 1 } });
      await P().pick(reqOf());
      expect(received[0]!.body.state).toEqual({ goal: "add the wireless mouse to the cart" });
    } finally {
      delete process.env.TOKEN_PLAN_STATE_CONTEXT;
    }
  });

  it("jevk5 不受影响：没声明 stateBuilder 的 profile，body 是旧形状（默认等价钉在别人身上）", async () => {
    const { jevk5Provider } = await import("../src/model/decision-jevk5.ts");
    let body: Record<string, unknown> | null = null;
    const fakeFetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ answers: { act: { type: "choice", choice: "e1", confidence: 0.5 } } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const p = jevk5Provider({ endpoint: "http://x/v1/systemone", fetchImpl: fakeFetch });
    await p.pick(reqOf());
    expect((body as { state: unknown } | null)!.state).toEqual({ goal: "add the wireless mouse to the cart" });
  });
});
