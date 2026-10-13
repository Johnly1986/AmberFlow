/**
 * 执行器 × 外部 provider：风险头这一路必须被真的测到。
 *
 * 存在的理由是一条真 bug：Stage 2 把 `pick` 改走 provider 时，`isRisky`/`isDone` 只加了
 * "能力跳过"的守卫、**没有真的改走 provider**，于是注册型 provider 落回旧路径读 `this.agent`
 * （那里它是 null）⇒ `TypeError: Cannot read properties of null (reading 'predict')`，
 * 而且把**每个有 hint 的步**一起打红（风险闸门在 pick 之后跑，规则决定的步同样要过它）。
 * 内置基线恰好都声明 `risk: false`，所以整套测试当时全绿——**是覆盖面放过了它，不是代码对**。
 *
 * 这三条把当时的三个漏洞各自钉住：风险头掉线要能降级并**说出来**；provider 的数字要真的驱动闸门；
 * 没声明风险头的 provider 不该被问。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as browserEnv from "../src/browser-env.ts";
import { BrowserMiddleware, type AnyPage } from "../src/executor.ts";
import { checkSignal } from "../src/signals.ts";
import { installLayaRuntime } from "../src/model.ts";
import { installDecisionProvider, type ChoiceOutcome, type ChoiceRequest, type DecisionProvider } from "../src/decision-provider.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const PRODUCT = pathToFileURL(path.join(REPO, "testpages", "product.html")).href;
const CART = pathToFileURL(path.join(REPO, "bench", "fixtures", "shop_cart.html")).href;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = (await browserEnv.launch({ chromium } as never, true)) as never;
  page = await (browser as unknown as { newPage(): Promise<Page> }).newPage();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  installDecisionProvider(null);
  installLayaRuntime(null);
});

/** 一个"永远选第一个候选"的 provider，风险头行为可配。 */
function fakeProvider(over: Partial<DecisionProvider> = {}): DecisionProvider {
  return {
    name: "fake", version: "1",
    capabilities: { choice: true, risk: true, done: false, shortlist: false, score_kind: "calibrated_prob" },
    async pick(req: ChoiceRequest): Promise<ChoiceOutcome> {
      const refs = Object.keys(req.elems).filter((r) => !req.forbidden.has(r));
      const p = refs.length ? 1 / refs.length : 0;
      return { ref: refs[0] ?? null, score: p, scoreKind: "calibrated_prob",
        signals: { pTop1: p || null, pTop2: null, margin: p ? 0 : null },
        options: refs.length, passthrough: true, probs: {} };
    },
    async risk(): Promise<number> { return 0.1; },
    ...over,
  };
}

/** 带 target_hint 的一步：选择由规则决定——当时恰恰是这种步被风险头一起打红。 */
const hinted = (over: { goal: string; url: string; hint: string; signal: Record<string, unknown>; mw?: Record<string, unknown> }) =>
  new BrowserMiddleware({ maxSteps: 3, ...(over.mw ?? {}) }).run(
    over.goal, over.url, {
      page: page as unknown as AnyPage, pw: browser as never, verbose: false, targetHint: over.hint,
      goalSignalFn: (p) => checkSignal(p as never, over.signal as never),
    });

describe("执行器 × 外部 provider 的风险头", () => {
  it("① 风险头掉线 ⇒ 降级到关键词规则、跑完，并把退化写进结果", async () => {
    installDecisionProvider(fakeProvider({
      risk: async () => { throw new Error("JevK5 服务不可达"); },
    }));
    const mw = new BrowserMiddleware({ maxSteps: 3 });
    const report = await mw.run("add the wireless mouse to the cart", PRODUCT, {
      page: page as unknown as AnyPage, pw: browser as never, verbose: false,
      targetHint: "button[data-test=add-to-cart]",       // 规则决定选谁：provider 只可能被判风险
      goalSignalFn: (p) => checkSignal(p as never, { css_text_contains: ["[data-test='cart-count']", "1"] } as never),
    });
    expect(report.done).toBe(true);                 // 关键：不是整条计划被打红
    expect(mw.riskDegraded).toContain("服务不可达");  // 且退化是被记录下来的，不是静默的
    expect(report.steps[0]?.method).toBe("rule:match");
  }, 120_000);

  it("② 降级时关键词规则仍然拦得住不可逆动作（不许掉线=解锁安全闸门）", async () => {
    installDecisionProvider(fakeProvider({ risk: async () => { throw new Error("down"); } }));
    const asked: string[] = [];
    const mw = new BrowserMiddleware({ maxSteps: 2, confirmFn: (d) => { asked.push(d); return false; } });
    await mw.run("proceed to checkout", CART, {
      page: page as unknown as AnyPage, pw: browser as never, verbose: false, goalSignalFn: () => false,
    });
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain("Proceed to checkout");
  }, 120_000);

  it("③ provider 的风险数字真的驱动闸门（0.9 ⇒ 问人；不声明风险头 ⇒ 一次都不问）", async () => {
    installDecisionProvider(fakeProvider({ risk: async () => 0.9 }));
    const askedHigh: string[] = [];
    const high = await hinted({
      goal: "add the wireless mouse to the cart", url: PRODUCT, hint: "button[data-test=add-to-cart]",
      signal: { css_text_contains: ["[data-test='cart-count']", "1"] },
      mw: { confirmFn: (d: string) => { askedHigh.push(d); return false; } },
    });
    // 人一直说"不" ⇒ 每轮都问一次（maxSteps=3 就问 3 次）：重点是**问的次数 > 0 且全指向同一个元素**，
    // 以及"被拒绝的步不会假装完成"。断死次数会把循环策略的变化误报成风险头的回归。
    expect(askedHigh.length).toBeGreaterThan(0);
    // 第一条必须是 hint 点名的那个元素（hint 权威）；被拒之后循环会落到 provider 的
    // 下一个候选，所以**不能**断言"每次都问同一个"——那是梯级行为，不是风险头的行为。
    expect(askedHigh[0]).toContain("Add to cart");
    expect(high.done).toBe(false);               // laya 根本没参与，是 provider 说的"危险"拦下的

    installDecisionProvider(fakeProvider({ risk: undefined,
      capabilities: { choice: true, risk: false, done: false, shortlist: false, score_kind: "rank_only" } }));
    const askedLow: string[] = [];
    const mw = new BrowserMiddleware({ maxSteps: 3, confirmFn: (d: string) => { askedLow.push(d); return false; } });
    const low = await mw.run("add the wireless mouse to the cart", PRODUCT, {
      page: page as unknown as AnyPage, pw: browser as never, verbose: false,
      targetHint: "button[data-test=add-to-cart]",
      goalSignalFn: (p) => checkSignal(p as never, { css_text_contains: ["[data-test='cart-count']", "1"] } as never),
    });
    expect(askedLow).toEqual([]);                // 没这个头就别编一个数
    expect(low.done).toBe(true);                 // 而且照样跑得完
    expect(mw.riskDegraded).toBeNull();          // 也不算"退化"
  }, 180_000);
});
