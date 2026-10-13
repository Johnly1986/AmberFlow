/**
 * JevK5 provider 的测试：**不加载任何权重**，用一个假的 `/v1/systemone` 服务把线协议钉住。
 *
 * 为什么值得单独一份：本机跑不动 JevK5（3.7 GB 内存 / 2 核 / 无 llama.cpp；4B bf16 要 ~9 GB GPU），
 * 所以"能不能接"这件事必须由协议测试回答，而不是等一台有 GPU 的机器。
 * 一旦真服务在场，同一份 provider 代码直接就能用——契约与映射已经在这里锁死了。
 *
 * 钉住的重点：
 * - `confidence` 在 JevK5 里是 `max(probs)`（源码 `jevk5/prompt.py:answer`），
 *   **不是** laya 的 `1 − H/log k` ⇒ `score_kind = calibrated_prob`，且 pTop1/pTop2/margin 从分布算；
 * - JevK5 的 choice 要求**至少两个选项**（`server.py:normalized` 会 400）⇒ 单候选时不发请求、直接"没得选"；
 * - 请求形状（criteria 的 key 是元素 ref、state 带 goal）与响应映射一起钉，防止两边各改一半。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jevk5Provider } from "../src/decision-jevk5.ts";
import { providerContract } from "./provider-contract.ts";
import type { ChoiceRequest } from "../src/decision-provider.ts";

/** 服务端的可编程响应 + 收到的请求体。 */
let replies: Record<string, unknown>[] = [];
let received: { path: string; body: any }[] = [];
let status = 200;

let server: http.Server;
let endpoint = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      received.push({ path: req.url ?? "", body });
      const answer = replies[received.length - 1] ?? replies[0];
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200
        ? { model: "jevk5-fake", answers: { act: answer, q: answer }, usage: { input_tokens: 10, output_tokens: 0 }, latency_ms: 1 }
        : answer));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;
});

afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

const fakeElems = { e1: { tag: "button", label: "Add to cart" }, e2: { tag: "a", label: "Cart" } } as never;
const reqOf = (over: Partial<ChoiceRequest> = {}): ChoiceRequest => ({
  goal: "add the wireless mouse to the cart",
  page: { title: async () => "Shop", url: () => "file://x" } as never,
  elems: fakeElems, forbidden: new Set(), notes: null, narrow: null, k: 8, ...over,
});
/** 设好下一次响应、清空收到的请求、设 HTTP 状态码。 */
function reset(answer: Record<string, unknown>, code = 200): void {
  replies = [answer]; received = []; status = code;
}

describe("jevk5 provider（假 /v1/systemone，无权重）", () => {
  it("choice：criteria 的 key 是元素 ref，state 带 goal（线协议钉住）", async () => {
    reset({ type: "choice", choice: "e1", confidence: 0.62, probabilities: { e1: 0.62, e2: 0.38 } });
    const out = await jevk5Provider({ endpoint }).pick(reqOf());
    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe("/v1/systemone");
    expect(received[0]!.body.questions.act.type).toBe("choice");
    expect(Object.keys(received[0]!.body.questions.act.criteria)).toEqual(["e1", "e2"]);
    expect(received[0]!.body.state.goal).toContain("wireless mouse");
    expect(out.ref).toBe("e1");
  });

  it("confidence=max(probs)：pTop1/pTop2/margin 从分布算，score_kind 与 laya 不同", async () => {
    reset({ type: "choice", choice: "e2", confidence: 0.55, probabilities: { e1: 0.45, e2: 0.55 } });
    const out = await jevk5Provider({ endpoint }).pick(reqOf());
    expect(out.scoreKind).toBe("calibrated_prob");        // laya 那一支是 entropy_conf
    expect(out.score).toBeCloseTo(0.55);
    expect(out.signals.pTop1).toBeCloseTo(0.55);
    expect(out.signals.pTop2).toBeCloseTo(0.45);
    expect(out.signals.margin).toBeCloseTo(0.1);
    expect(out.options).toBe(2);
  });

  it("只剩一个候选时**不发请求**（JevK5 的 choice 要 ≥2 个选项，否则服务端 400）", async () => {
    reset({ type: "choice", choice: "e1", confidence: 1, probabilities: { e1: 1 } });
    const one = { e1: { tag: "button", label: "Only" } } as never;
    const out = await jevk5Provider({ endpoint }).pick(reqOf({ elems: one }));
    expect(received).toHaveLength(0);                     // 关键：没去敲服务端
    expect(out.ref).toBeNull();
    expect(out.signals.pTop1).toBeNull();                 // "结构上没得选" ≠ "零把握"
  });

  it("服务端 400 时把原因带出来（不吞、不瞎选）", async () => {
    reset({ error: "choice criteria must name at least two options" }, 400);
    status = 400;
    await expect(jevk5Provider({ endpoint }).pick(reqOf())).rejects.toThrow(/at least two options/);
    status = 200;
  });

  it("服务不可达：报错指路，而不是抛裸栈", async () => {
    const p = jevk5Provider({ endpoint: "http://127.0.0.1:1/v1/systemone", timeoutMs: 2000 });
    await expect(p.pick(reqOf())).rejects.toThrow(/JevK5 服务不可达.*docs\/DECISION_PROVIDER_JEVK5\.md/);
  });

  it("risk / doneVote 走 noul（返回概率，不是选项）", async () => {
    reset({ type: "noul", noul: 0.83, confidence: 0.83 });
    const p = jevk5Provider({ endpoint });
    expect(await p.risk!("buy now", 'click button "Buy now"')).toBeCloseTo(0.83);
    reset({ type: "noul", noul: 0.12, confidence: 0.88 });
    expect(await p.doneVote!("g", { url: "file://x" })).toBeCloseTo(0.12);
  });

  // 同一份考卷：外部 provider 与内置 provider 走完全相同的契约
  providerContract("jevk5（假服务）", () => jevk5Provider({ endpoint }),
    () => reqOf().page, () => fakeElems);
});
