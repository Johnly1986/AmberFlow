/**
 * 百炼 `decision-model-preview` provider 的测试：**不碰网络、不碰真 key**，
 * 用一个假的 `/compatible-mode/v1/systemone` 服务把线协议钉住（与 JevK5 测试同一套方法）。
 *
 * 钉住的重点（都是与 JevK5 不同的地方，必须各自有证据）：
 * - **认证走 header，不进 body**：`Authorization: Bearer <key>`；key 从环境按名读，绝不内联；
 * - **`confidence` ≠ `max(probabilities)`**：官方示例 choice confidence=0.88 而 max(prob)=0.94——
 *   `score` 取 confidence，`pTop1/pTop2/margin` 取分布；两者分开，不混（这是百炼独有的标定语义）；
 * - **单候选也能问**（choice 支持 1–255 项，不像 JevK5 要 ≥2）；只有 0 候选才不发请求；
 * - **池外答案（如 `other`）当作没答**（ref=null），不拿它去点一个不存在的元素；
 * - 缺 key / 缺端点 / 非 2xx：报错指路，不静默退回、不瞎选。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bailianProvider } from "../src/model/decision-bailian.ts";
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
// 契约测试会走真 fetch，缺 key 会抛——给一个假的环境 key，保证不碰真凭据也不误报缺 key。
const savedKey = process.env.DASHSCOPE_API_KEY;
beforeAll(() => { process.env.DASHSCOPE_API_KEY = "test-key-not-secret"; });
afterEach(() => { status = 200; });
afterAll(() => { if (savedKey === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = savedKey; });

const fakeElems = { e1: { tag: "button", label: "Add to cart" }, e2: { tag: "a", label: "Cart" } } as never;
const reqOf = (over: Partial<ChoiceRequest> = {}): ChoiceRequest => ({
  goal: "add the wireless mouse to the cart",
  page: { title: async () => "Shop", url: () => "file://x" } as never,
  elems: fakeElems, forbidden: new Set(), notes: null, narrow: null, k: 8, ...over,
});
function reset(answer: Record<string, unknown>, code = 200): void {
  replies = [answer]; received = []; status = code;
}
const P = () => bailianProvider({ endpoint, apiKey: "test-key-not-secret" });

describe("bailian decision-model-preview provider（假 /systemone，无网络无真 key）", () => {
  it("线协议：POST /compatible-mode/v1/systemone，带 model + Bearer 认证头（key 不进 body）", async () => {
    reset({ type: "choice", choice: "e1", confidence: 0.88, probabilities: { e1: 0.94, e2: 0.06 } });
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

  it("confidence ≠ max(prob)：score 取 confidence，pTop1/pTop2/margin 取分布（百炼独有语义）", async () => {
    reset({ type: "choice", choice: "e1", confidence: 0.88, probabilities: { e1: 0.94, e2: 0.06 } });
    const out = await P().pick(reqOf());
    expect(out.scoreKind).toBe("calibrated_prob");
    expect(out.score).toBeCloseTo(0.88);          // provider 的"把握" = confidence
    expect(out.signals.pTop1).toBeCloseTo(0.94);  // 分布的最大值 ≠ confidence
    expect(out.signals.pTop2).toBeCloseTo(0.06);
    expect(out.signals.margin).toBeCloseTo(0.88);
  });

  it("单候选也发请求（choice 支持 1–255 项，不像 JevK5 要 ≥2）", async () => {
    reset({ type: "choice", choice: "e1", confidence: 0.9, probabilities: { e1: 1 } });
    const one = { e1: { tag: "button", label: "Only" } } as never;
    const out = await P().pick(reqOf({ elems: one }));
    expect(received).toHaveLength(1);             // 关键：单候选照样问
    expect(out.ref).toBe("e1");
  });

  it("0 候选才不发请求，且 signals 全 null（结构上没得选 ≠ 零把握）", async () => {
    reset({ type: "choice", choice: "e1", confidence: 1, probabilities: { e1: 1 } });
    const out = await P().pick(reqOf({ forbidden: new Set(["e1", "e2"]) }));
    expect(received).toHaveLength(0);
    expect(out.ref).toBeNull();
    expect(out.signals.pTop1).toBeNull();
  });

  it("池外答案（模型给 other）当作没答，不拿它点不存在的元素", async () => {
    reset({ type: "choice", choice: "other", confidence: 0.5, probabilities: { other: 0.5, e1: 0.5 } });
    const out = await P().pick(reqOf());
    expect(out.ref).toBeNull();
  });

  it("缺 key：报错指路，不敲服务、不静默退回", async () => {
    const p = bailianProvider({ endpoint });     // 不传 apiKey
    const saved = process.env.DASHSCOPE_API_KEY, savedB = process.env.BAILIAN_API_KEY;
    delete process.env.DASHSCOPE_API_KEY; delete process.env.BAILIAN_API_KEY;
    received = [];                                // 清空：下面要证"根本没去敲门"
    try {
      await expect(p.pick(reqOf())).rejects.toThrow(/DASHSCOPE_API_KEY|BAILIAN_API_KEY/);
      expect(received).toHaveLength(0);          // 缺 key 时根本没去敲门
    } finally {
      if (saved !== undefined) process.env.DASHSCOPE_API_KEY = saved;
      if (savedB !== undefined) process.env.BAILIAN_API_KEY = savedB;
    }
  });

  it("缺端点：报错指路到 workspace/region", async () => {
    const savedE = process.env.BAILIAN_ENDPOINT, savedW = process.env.BAILIAN_WORKSPACE_ID;
    delete process.env.BAILIAN_ENDPOINT; delete process.env.BAILIAN_WORKSPACE_ID;
    try {
      const p = bailianProvider({ apiKey: "k" });
      await expect(p.pick(reqOf())).rejects.toThrow(/BAILIAN_ENDPOINT|BAILIAN_WORKSPACE_ID/);
    } finally {
      if (savedE !== undefined) process.env.BAILIAN_ENDPOINT = savedE;
      if (savedW !== undefined) process.env.BAILIAN_WORKSPACE_ID = savedW;
    }
  });

  it("非 2xx：把服务端原因带出来（401/400 不吞）", async () => {
    reset({ code: "InvalidApiKey", message: "API-key 无效或已过期" }, 401);
    await expect(P().pick(reqOf())).rejects.toThrow(/401.*API-key 无效或已过期|API-key 无效或已过期/);
  });

  it("错误体是嵌套对象（实测 429 限流）：抽出可读原因，绝不 [object Object]", async () => {
    // 真服务在套件突发调用下返回过 `{"error":{"code":"Throttling...","message":"..."}}`，
    // 旧实现把对象字段直接拼进错误串 → `[object Object]`，丢掉了限流这个关键信息。
    reset({ error: { code: "Throttling.RateQuota", message: "Requests rate limit exceeded" } }, 429);
    let msg = "";
    try { await P().pick(reqOf()); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("429");
    expect(msg).toContain("rate limit");
    expect(msg).not.toContain("[object Object]");
  });

  it("risk / doneVote 走 noul（返回 P(yes)，不是选项）", async () => {
    reset({ type: "noul", noul: 0.83 });
    const p = P();
    expect(await p.risk!("buy now", 'click button "Buy now"')).toBeCloseTo(0.83);
    reset({ type: "noul", noul: 0.12 });
    expect(await p.doneVote!("g", { url: "file://x" })).toBeCloseTo(0.12);
  });

  // 同一份考卷：外部 provider 与内置 provider 走完全相同的契约
  providerContract("bailian（假服务）", () => bailianProvider({ endpoint, apiKey: "test-key-not-secret" }),
    () => reqOf().page, () => fakeElems);
});
