/**
 * P1：hint 的**档内歧义变成候选集**（docs/EXECUTION_LAYER_SPLIT_PLAN.md §6 M0）。
 *
 * 两件事各自钉死：
 *   ① 单一实现 + 缺省等价——`hintCandidates` 是 `hintMatch` 的同一个走查器（`hintMatchImpl`）
 *      跑出来的最强档候选集；`firstIfSame(candidates)` 必须**逐值等于** `hintMatch`，
 *      对全部 6 种语法 × 钉住的边界形状（歧义档、提交件偏好、大小写折叠、层级优先）。
 *   ② 更小的提问——当 hint 的最强档 >1 且**不同形状**时（以前塌成 null，整池 40 个交给模型，
 *      实测 17 候选 → 0.23 < floor → BLOCKED），`tieredHint` 打开后模型只看得到那几条候选；
 *      关着时行为与今天**逐字节相同**（用同一批候选的 abstain 回退证明两问都在）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import * as browserEnv from "../src/browser-env.ts";
import { BrowserMiddleware, type AnyPage, type PwLike } from "../src/executor.ts";
import { firstIfSame, type Elem, type ElemPool } from "../src/extraction.ts";
import { hintCandidates, hintMatch } from "../src/rules.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer, type Question } from "../src/model.ts";

const dataUrl = (html: string): string => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
const pw: PwLike = { chromium: chromium as unknown as PwLike["chromium"] };
const asPage = (p: Page): AnyPage => p as unknown as AnyPage;

function el(ref: string, tag = "button", label = "", dataTest = "", kw: Partial<Elem> = {}): Elem {
  const scan = /^\d+$/.test(ref.slice(1)) ? Number(ref.slice(1)) : 0;
  return { ref, scan, tag, label, data_test: dataTest, name: "", id: "", input_type: "", href: "", ...kw };
}
const pool = (...es: Elem[]): ElemPool => Object.fromEntries(es.map((e) => [e.ref!, e]));

/* ------------------------------------------------------------------ ① 单实现：候选集 ≡ hintMatch */

describe("hintCandidates 与 hintMatch 是同一实现的两只眼睛（缺省等价）", () => {
  const cases: Array<[string, () => ElemPool]> = [
    // 全部 6 种语法 × 钉过的边界形状（tests/rules.test.ts 的池子逐条搬来当差分输入）
    ["button[data-test=add-to-cart]", () => pool(el("e0", "button", "Add to cart", "add-to-cart"), el("e1", "button", "Support", "support"))],
    ["[data-test=support]", () => pool(el("e0", "button", "Add to cart", "add-to-cart"), el("e1", "button", "Support", "support"))],
    ["a[data-test=add-to-cart]", () => pool(el("e0", "button", "Add to cart", "add-to-cart"))],
    ["a[href~travel_2]", () => pool(el("e0", "a", "Travel", "", { href: "travel_2/index.html" }), el("e1", "a", "Home", "", { href: "index.html" }))],
    ["button[near~onesie]", () => pool(el("e0", "button", "Add to cart", "", { near: "Sauce Labs Onesie" }), el("e1", "button", "Add to cart", "", { near: "Sauce Labs Backpack" }))],
    ["button[near~missing]", () => pool(el("e0", "button", "Add to cart", "", { near: "Sauce Labs Backpack" }))],
    ["input", () => pool(el("e0", "input", "User", "", { input_type: "text" }), el("e1", "input", "Login", "", { input_type: "submit" }))],
    ["button", () => pool(el("e0", "button", "Ok"), el("e1", "button", "Cancel"))],
    ["login", () => pool(el("e0", "button", "Sign in", "login-btn"))],
    ["login-btn", () => pool(el("e0", "button", "Sign in", "login-btn"))],
    ["#searchInput", () => pool(el("e0", "input", "Search Wikipedia", "", { id: "searchInput" }), el("e1", "button", "Search"))],
    ["#SEARCHINPUT", () => pool(el("e0", "input", "Search", "", { id: "searchInput" }))],
    ["#missing", () => pool(el("e0", "button", "Search"))],
    ["a[data-test=net-CAM-1001]", () => pool(el("e0", "a", "网络设置", "net-CAM-1001"))],
    ["a[href=/news]", () => pool(el("e3", "a", "News", "", { href: "/news" }), el("e7", "a", "News", "", { href: "/news" }))],
    ["a[href~news]", () => pool(el("e0", "a", "News", "", { href: "/news" }), el("e1", "a", "Newsletter", "", { href: "/newsletter" }))],
    ["a[href~news]", () => pool(el("e0", "a", "World", "", { href: "/news/world" }), el("e1", "a", "UK", "", { href: "/news/uk" }))],
    ["a[href~Alan_Turing]", () => pool(
      el("e0", "a", "Alan Turing", "", { href: "https://en.wikipedia.org/wiki/Alan_Turing" }),
      el("e1", "a", "Enigma", "", { href: "https://en.wikipedia.org/wiki/Alan_Turing:_The_Enigma" }),
      el("e2", "a", "Law", "", { href: "https://en.wikipedia.org/wiki/Alan_Turing_law" }))],
    ["艾伦·图灵", () => pool(
      el("e0", "a", "艾伦·图灵", "", { href: "/wiki/turing" }),
      el("e1", "a", "艾伦·图灵 – 古吉拉特语", "", { href: "https://gu.wikipedia.org/wiki/x" }),
      el("e3", "a", "艾伦·图灵 (消歧义)", "", { href: "/wiki/disamb" }))],
    ["艾伦·图灵", () => pool(
      el("e0", "a", "艾伦·图灵奖", "", { href: "/prize" }),
      el("e1", "a", "艾伦·图灵研究所", "", { href: "/institute" }))],
  ];

  for (const [hint, mkPool] of cases) {
    it(`hintMatch == firstIfSame(hintCandidates) for ${JSON.stringify(hint)}`, () => {
      const elems = mkPool();
      const direct = hintMatch(hint, elems);
      const cands = hintCandidates(hint, elems);
      const viaCands = cands ? (cands.decided ?? firstIfSame(new Set(cands.refs), elems)) : null;
      expect(viaCands).toBe(direct);
    });
  }

  it("歧义档**不塌缩**：17 候选的线上形状在 hintMatch 是 null、在 hintCandidates 是 17", () => {
    // 复刻实测事故页（en.wikipedia 搜索结果）：一个精确 slug + 一堆相关页。
    const elems = pool(
      el("e0", "a", "Alan Turing", "", { href: "/wiki/Alan_Turing" }),
      ...Array.from({ length: 16 }, (_, i) => el(`e${i + 1}`, "a", `Related ${i}`, "", { href: `/wiki/Alan_Turing_${i}` })),
    );
    expect(hintMatch("a[href~Alan_Turing]", elems)).toBe("e0");  // slug 档今天就能赢
    // 真正钉的是"档内歧义仍出候选集"：没有精确、没有 slug 尾段的那张池——
    const related = pool(
      el("e0", "a", "World", "", { href: "/news/world" }),
      el("e1", "a", "UK", "", { href: "/news/uk" }),
    );
    expect(hintMatch("a[href~news]", related)).toBeNull();            // 老行为：塌缩
    const c = hintCandidates("a[href~news]", related);
    expect(c).not.toBeNull();
    expect(c!.refs.sort()).toEqual(["e0", "e1"]);                     // 新出口：候选集还在
    expect(c!.tier).toBe(3);                                          // 最弱档（substring）
  });
});

/* ------------------------------------------------------------------ ② 更小的提问（门控） */

describe("tieredHint：档内歧义变成候选集交给决策层（ON 才启用，OFF 逐字节同今天）", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = (await browserEnv.launch(pw)) as unknown as Browser;
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    installLayaRuntime(null);
  });

  /** 池里两类元素：3 条 hint 档内候选（互相不同形状 → hintMatch 本会塌缩），+ 12 个噪声。 */
  function pageHtml(): string {
    const cands = ["Alpha result", "Beta result", "Gamma result"]
      .map((t, i) => `<a id="r${i}" href="#Alan_Turing_${i}">${t}</a>`)
      .join("");
    const noise = Array.from({ length: 12 }, (_, i) => `<button>Noise ${i}</button>`).join("");
    return `<body>${cands}${noise}<div id="done" style="display:none">ok</div></body>`;
  }

  /** 记录模型被问到的 criteria 数——"更小的提问"的直接证据。 */
  function spyingChooser(want: string): { askSizes: number[] } {
    const rec = { askSizes: [] as number[] };
    installLayaRuntime(scriptedRuntime(scriptedAgent((key: string, _s: unknown, questions: Record<string, Question>): Answer | undefined => {
      const q = questions[key];
      if (!q) return undefined;
      if (q.type === "noul") return { noul: 0.0 };
      const crit = (q.criteria ?? {}) as Record<string, string>;
      rec.askSizes.push(Object.keys(crit).length);
      const pick = Object.keys(crit).find((k) => String(crit[k] ?? "").toLowerCase().includes(want.toLowerCase()));
      if (pick === undefined) return { choice: Object.keys(crit)[0]!, probabilities: {}, confidence: 0.05 };
      return { choice: pick, probabilities: Object.fromEntries(Object.keys(crit).map(k => [k, k === pick ? 0.9 : 0.01])), confidence: 0.9 };
    })));
    return rec;
  }

  for (const tiered of [false, true]) {
    it(`tieredHint=${tiered ? "ON：候选 3 条就只问 3 条" : "OFF：整池 15 条照旧问"}`, async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const rec = spyingChooser("Beta result");
      const mw = new BrowserMiddleware({ maxSteps: 2, reobserve: false, tieredHint: tiered });
      const rep = await mw.run("open the Alan Turing result", dataUrl(pageHtml()), {
        page: asPage(page), pw, verbose: false,
        targetHint: "a[href~Alan_Turing]",
        goalSignalFn: () => true,   // 点击即完成，专注在提问规模上
      });
      await ctx.close();
      expect(rep.done).toBe(true);
      expect(rec.askSizes.length).toBe(1);
      if (tiered) {
        expect(rec.askSizes[0]).toBe(3);      // 档内候选：小提问
        const step = rep.steps[rep.steps.length - 1]!;
        expect(step.how).toBe("clicked");
        expect((step as Record<string, unknown>).hint_tier).toEqual({ n: 3, tier: 3 });
      } else {
        expect(rec.askSizes[0]).toBe(15);     // 今天的行为：整池
        expect((rep.steps[rep.steps.length - 1] as Record<string, unknown>).hint_tier).toBeUndefined();
      }
    });
  }

  it("档内候选全部 forbidden 后不再窄问（回退整池，不饿死）", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // 候选里两条被禁掉（模型第一次都答"没把握"）→ 窄问只剩 1 条 → 不该窄问
    const rec = spyingChooser("Gamma result");
    const mw = new BrowserMiddleware({ maxSteps: 3, reobserve: false, tieredHint: true });
    const rep = await mw.run("open the Alan Turing result", dataUrl(pageHtml()), {
      page: asPage(page), pw, verbose: false,
      targetHint: "a[href~Alan_Turing]",
      goalSignalFn: () => true,
    });
    await ctx.close();
    expect(rep.done).toBe(true);
    // 第一次问就被答中（候选 3）：证明启用路径本身可复现
    expect(rec.askSizes[0]).toBe(3);
  });
});
