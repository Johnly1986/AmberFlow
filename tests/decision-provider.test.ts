/**
 * 决策提供者层的两件事：**等价**与**可替换**。
 *
 * 1. **等价**（Stage 2 的前提）：`layaProvider().pick()` 必须与今天执行器内部的
 *    `pickProposal()` 在同一份夹具上**逐字段相同**。不是"应该一样"，是被测住一样——
 *    因为这条缝包住的是全仓库最承重的一个函数（`pickInner`），而六层对拍的执行器层
 *    就挂在它上面。
 * 2. **可替换**（抽象成不成立的判据）：契约测试跑在**三个** provider 上——
 *    laya 适配器、一个只有名次的 `rank_only`、一个均匀随机的 `coin-flip`。
 *    后两个**不 import 任何 laya 类型**：如果它们能过契约，说明这个接口不是 laya 的形状。
 *
 * 契约里最要紧的一条是"`null` 不许写成 `0`"：没有概率的 provider 若把 `pTop1` 报成 0，
 * 任何阈值都会把它判成"最没把握"，于是"这个模型不给概率"被伪装成"这个模型很不确定"。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as browserEnv from "../src/browser-env.ts";
import { BrowserMiddleware, type AnyPage } from "../src/executor.ts";
import { extractElements, type ElemPool } from "../src/extraction.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime, type DecisionAgent, type LayaRuntime, type ModelState } from "../src/model.ts";
import { providerContract } from "./provider-contract.ts";
import {
  layaProvider, listDecisionProviders, registerDecisionProvider, installProviderFromEnv,
  installDecisionProvider, type ChoiceRequest, type ChoiceOutcome, type DecisionProvider,
} from "../src/decision-provider.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const PAGE_URL = pathToFileURL(path.join(REPO, "testpages", "product.html")).href;

let browser: Browser;
let pageObj: Page;
let elems: ElemPool;

beforeAll(async () => {
  browser = (await browserEnv.launch({ chromium } as never, true)) as never;
  pageObj = await (browser as unknown as { newPage(): Promise<Page> }).newPage();
  await pageObj.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  elems = await extractElements(pageObj as unknown as AnyPage);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  installLayaRuntime(null);
  installDecisionProvider(null);
});

/** 契约要的页面与元素池（每次现取，避免跨用例脏）。 */
const page = (): ChoiceRequest["page"] => pageObj as unknown as ChoiceRequest["page"];
const pool = (): ChoiceRequest["elems"] => elems as never;

/** 一个"永远选第一个候选、conf 0.42"的脚本 laya 替身。 */
const scriptedModel = (): { runtime: LayaRuntime; agent: DecisionAgent } => {
  const runtime = scriptedRuntime(scriptedAgent((key, _s, questions) => {
    if (key === "act") {
      const crit = (questions["act"]?.criteria ?? {}) as Record<string, string>;
      const first = Object.keys(crit)[0];
      return first ? { choice: first, confidence: 0.42, probabilities: { [first]: 0.42 } } : undefined;
    }
    if (key === "r") return { noul: 0.05 };
    return { noul: 0.0 };
  }) as never);
  const box: { agent: DecisionAgent } = { agent: null as never };
  const wrapped: LayaRuntime = {
    async load(id, o) { box.agent = await runtime.load(id, o); return box.agent; },
    embedFnFromAgent: (a) => runtime.embedFnFromAgent(a),
    predictShortlist: (a, s, q, o) => runtime.predictShortlist(a, s, q, o),
  };
  return { runtime: wrapped, agent: box.agent };
};

describe("① 等价：laya 适配器必须等于今天执行器内部的那条路", () => {
  it("同一份夹具上 ref / score / passthrough / options / signals 逐字段相同", async () => {
    const { runtime } = scriptedModel();
    installLayaRuntime(runtime);
    const mw = new BrowserMiddleware({ modelId: "scripted" });
    const provider = layaProvider({
      runtime,
      agentFor: async (s: ModelState) => ({ agent: await runtime.load("scripted"), embedFn: null }),
    });
    const viaExecutor = await mw.pickProposal("add the wireless mouse to the cart",
      pageObj as unknown as AnyPage, elems, new Set(), null);
    const viaProvider = await provider.pick({
      goal: "add the wireless mouse to the cart", page: page(),
      elems: elems as never, forbidden: new Set(), notes: null, narrow: null, k: 8,
    } satisfies ChoiceRequest);

    expect(viaProvider.ref).toEqual(viaExecutor.choiceRef);
    expect(viaProvider.score).toBeCloseTo(viaExecutor.entropyConf, 6);
    expect(viaProvider.passthrough).toBe(viaExecutor.shape.kind !== "shortlist");
    expect(viaProvider.options).toBeGreaterThan(0);
    expect(viaProvider.signals.pTop1).not.toBeNull();
    // 禁掉全部候选 ⇒ 两边都得说"没得选"（null，不是 undefined、不是 0 分瞎选）
    const all = new Set(Object.keys(elems));
    const emptyViaExecutor = await mw.pickProposal("x", pageObj as unknown as AnyPage, elems, all, null);
    const emptyViaProvider = await provider.pick({
      goal: "x", page: page(), elems: elems as never,
      forbidden: all, notes: null, narrow: null, k: 8,
    });
    expect(emptyViaExecutor.choiceRef).toBeNull();
    expect(emptyViaProvider.ref).toBeNull();
    expect(emptyViaProvider.options).toBe(0);
  }, 120_000);
});

describe("② 可替换：契约跑在三个 provider 上（后两个不碰 laya 类型）", () => {
  providerContract("laya 适配器", () => {
    const { runtime } = scriptedModel();
    return layaProvider({ runtime, agentFor: async () => ({ agent: await runtime.load("scripted"), embedFn: null }) });
  }, page, pool);

  providerContract("rank_only（只有名次，例如纯生成式 agent）", () => ({
    name: "rank-only", version: "test",
    capabilities: { choice: true, risk: false, done: false, shortlist: false, score_kind: "rank_only" },
    async pick(req: ChoiceRequest): Promise<ChoiceOutcome> {
      const keys = Object.keys(req.elems).filter((k) => !req.forbidden.has(k));
      return { ref: keys[0] ?? null, score: 0, scoreKind: "rank_only",
        signals: { pTop1: null, pTop2: null, margin: null },
        options: keys.length, passthrough: true, probs: {} };
    },
  }), page, pool);

  providerContract("coin-flip（有概率、但等于瞎猜：对照基线）", () => ({
    name: "coin-flip", version: "test",
    capabilities: { choice: true, risk: true, done: false, shortlist: false, score_kind: "calibrated_prob" },
    async pick(req: ChoiceRequest): Promise<ChoiceOutcome> {
      const keys = Object.keys(req.elems).filter((k) => !req.forbidden.has(k));
      if (!keys.length) {
        return { ref: null, score: 0, scoreKind: "calibrated_prob",
          signals: { pTop1: null, pTop2: null, margin: null }, options: 0, passthrough: true, probs: {} };
      }
      const p = 1 / keys.length;
      const probs = Object.fromEntries(keys.map((k) => [k, p]));
      const pick = keys[Math.floor(Math.random() * keys.length)]!;
      return { ref: pick, score: p, scoreKind: "calibrated_prob",
        signals: { pTop1: p, pTop2: keys.length > 1 ? p : null, margin: keys.length > 1 ? 0 : null },
        options: keys.length, passthrough: true, probs };
    },
    async risk(): Promise<number> { return 0; },
  }), page, pool);
});

describe("③ 注册表：换 provider 是配置，不是改代码", () => {
  it("未注册的名字响亮报错（拼错 provider 名不能静默退回默认）", async () => {
    registerDecisionProvider("test-rank-only", () => ({
      name: "test-rank-only", version: "1",
      capabilities: { choice: true, risk: false, done: false, shortlist: false, score_kind: "rank_only" },
      async pick() {
        return { ref: null, score: 0, scoreKind: "rank_only" as const,
          signals: { pTop1: null, pTop2: null, margin: null }, options: 0, passthrough: true, probs: {} };
      },
    }));
    expect(listDecisionProviders()).toContain("test-rank-only");
    await expect(installProviderFromEnv({ AMBERFLOW_DECISION_PROVIDER: "test-rank-typo" }))
      .rejects.toThrow(/未知的决策提供者.*test-rank-typo/);
    const changed = await installProviderFromEnv({ AMBERFLOW_DECISION_PROVIDER: "test-rank-only" });
    expect(changed).toBe("test-rank-only");
    // 没设 env ⇒ 不动当前 provider（缺省等价的纪律）
    installDecisionProvider(null);
    expect(await installProviderFromEnv({})).toBeNull();
  });
});

/* ------------------------------------------- S2 ③ 提名形状：闭集选择（askChoice） */

describe("askChoice：对调用方给定的闭集做一次 choice（不依赖页面元素池）", () => {
  it("laya 适配器：题面/选项原样问出去；答案做闭集校验；score=confidence；池外答案不采纳", async () => {
    let seen: { state?: unknown; q?: unknown } = {};
    const agent = {
      async predict(state: unknown, questions: Record<string, unknown>) {
        seen = { state, q: questions["act"] };
        return { answers: { act: { type: "choice", choice: "b", confidence: 0.7, probabilities: { a: 0.3, b: 0.7 } } } };
      },
    };
    const provider = layaProvider({
      runtime: {} as never,
      agentFor: async () => ({ agent: agent as never, embedFn: null }),
    });
    const criteria = { a: "点击", b: "选最低价" };
    const out = await provider.askChoice!({ goal: "选择最低价", instructions: "pick one", criteria });
    expect(seen.state).toMatchObject({ goal: "选择最低价" });     // desc-only：不装页面状态
    expect(seen.q).toEqual({ type: "choice", instructions: "pick one", criteria });
    expect(out).toMatchObject({ ref: "b", score: 0.7, scoreKind: "entropy_conf" });
    expect(out!.probs).toEqual({ a: 0.3, b: 0.7 });

    // 池外答案 = 没答（fail closed：绝不为凑答案现造指令）
    const rogue = { async predict() { return { answers: { act: { type: "choice", choice: "zzz", confidence: 0.9 } } }; } };
    const p2 = layaProvider({ runtime: {} as never, agentFor: async () => ({ agent: rogue as never, embedFn: null }) });
    const out2 = await p2.askChoice!({ goal: "x", instructions: "y", criteria: { a: "A" } });
    expect(out2!.ref).toBeNull();
  });

  it("契约：没有 askChoice 的 provider 就是没有这个能力（调用方不得假装问过）", async () => {
    // 内置基线是 provider，但只实现 pick/risk/done（无闭集选择）——梯级遇到它就该 ③ 弃权。
    const { registerBaselines } = await import("../src/decision-baselines.ts");
    const { listDecisionProviders, resolveProviderSpec } = await import("../src/decision-provider.ts");
    registerBaselines();
    expect(listDecisionProviders()).toContain("coin-flip");
    const spec = await resolveProviderSpec("coin-flip", {});
    expect(spec.kind).toBe("provider");
    if (spec.kind === "provider") expect(spec.provider.askChoice).toBeUndefined();
  });
});
