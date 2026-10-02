/**
 * Signal induction tests.
 *
 * The load-bearing one is the browser case: a human hand-wrote
 * `{css_text_equals: ["[data-test=cart-count]", "1"]}` for the fixture's
 * "add to cart" step, and induction must recover exactly that predicate from a
 * single demonstration — otherwise "the human does not have to capture signals"
 * is not true.
 */
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import * as browserEnv from "../src/browser-env.ts";
import { extractElements, urlOf, type PageLike } from "../src/extraction.ts";
import {
  captureStateView, diffStates, induceSignals, isVolatile, signalReproducible, stableToken,
  type StateView,
} from "../src/signal-induction.ts";
import { checkSignal, evalSignalOnState, matchSelector, type SignalSpec } from "../src/signals.ts";

const PAGES = new URL("../testpages/", import.meta.url).pathname;
const el = (tag: string, label: string, extra: Record<string, unknown> = {}, scan = 1) =>
  ({ tag, label, scan, ...extra });
const view = (url: string, elems: StateView["elems"]): StateView => ({ url, elems });

describe("offline signal evaluation (the induction substrate)", () => {
  const before = view("https://x/product.html", { e0: el("span", "0", { data_test: "cart-count" }) });
  const after = view("https://x/product.html", { e0: el("span", "1", { data_test: "cart-count" }) });
  const sig: SignalSpec = { css_text_equals: ["[data-test=cart-count]", "1"] };

  it("decides the five operators over a captured pool", () => {
    expect(evalSignalOnState(sig, before)).toBe(false);
    expect(evalSignalOnState(sig, after)).toBe(true);
    expect(evalSignalOnState({ url_contains: "product" }, after)).toBe(true);
    expect(evalSignalOnState({ css_exists: ["#nope"] }, after)).toBe(false);
    expect(evalSignalOnState({ css_value_equals: ["[data-test=cart-count]", "1"] }, after)).toBe(true);
  });

  it("returns null (not a guess) for what the pool cannot express", () => {
    expect(evalSignalOnState({ css_exists: [".badge"] }, after)).toBeNull();
    expect(evalSignalOnState({ css_text_contains: ["div > span", "x"] }, after)).toBeNull();
    expect(evalSignalOnState({ manual: true }, after)).toBeNull();
    expect(matchSelector(after.elems, "span, [data-test=cart-count]")).toHaveLength(2);
  });

  it("composes without weakening: all_of / any_of / not", () => {
    expect(evalSignalOnState({ all_of: [sig, { url_contains: "product" }] }, after)).toBe(true);
    expect(evalSignalOnState({ all_of: [sig, { url_contains: "cart" }] }, after)).toBe(false);
    expect(evalSignalOnState({ any_of: [{ url_contains: "cart" }, sig] }, after)).toBe(true);
    expect(evalSignalOnState({ not: { css_exists: ["#gone"] } }, after)).toBe(true);
    // an undecidable part makes the whole composition undecidable, never true
    expect(evalSignalOnState({ all_of: [sig, { css_exists: [".badge"] }] }, after)).toBeNull();
  });
});

describe("stability guards", () => {
  it("rejects volatile literals", () => {
    // NB a single digit is NOT volatile — `css_text_equals ["[data-test=cart-count]", "1"]`
    // is the repo's own hand-written signal for the add-to-cart step.
    for (const s of ["2026", "订单号 12345", "9f8e7d6c5b", "2026-10-05", "12:30"]) {
      expect(isVolatile(s), s).toBe(true);
    }
    for (const s of ["已加入购物车", "Add to cart", "保存成功"]) {
      expect(isVolatile(s), s).toBe(false);
    }
  });

  it("picks a stable token out of a noisy text", () => {
    expect(stableToken("已加入购物车 · 订单 12345")).toBe("已加入购物车");
    expect(stableToken("12345")).toBeNull();
  });

  it("only addresses elements with a stable identity", () => {
    const r = induceSignals(
      view("https://x/a", { e0: el("div", "spinner", {}) }),
      view("https://x/a", { e0: el("div", "spinner", {}) , e1: el("div", "done", {}, 2) }),
    );
    // no data-test/id/name/near on the new element -> nothing addressable -> manual
    expect(r.verdict).toBe("no-signal");
  });
});

describe("induction over synthetic transitions", () => {
  const before = view("https://x/product.html", {
    e0: el("span", "0", { data_test: "cart-count" }),
    e1: el("button", "Add to cart", { data_test: "add-to-cart" }, 2),
  });
  const after = view("https://x/cart.html", {
    e0: el("span", "1", { data_test: "cart-count" }),
    e1: el("button", "Add to cart", { data_test: "add-to-cart" }, 2),
    e2: el("div", "已加入购物车", { data_test: "toast" }, 3),
  });

  it("describes the effect and ranks discriminating candidates", () => {
    const r = induceSignals(before, after);
    expect(r.verdict).toBe("discriminating");
    expect(r.effect.join(" | ")).toContain("URL");
    expect(r.effect.join(" | ")).toContain("cart-count");
    const jsons = r.candidates.map((c) => JSON.stringify(c.signal));
    expect(jsons).toContain(JSON.stringify({ url_contains: "/cart.html" }));
    expect(jsons).toContain(JSON.stringify({ css_text_equals: ["[data-test=cart-count]", "1"] }));
    expect(jsons.some((j) => j.includes('"all_of"'))).toBe(true);
    // every candidate really discriminates
    for (const c of r.candidates) {
      expect(evalSignalOnState(c.signal, before), JSON.stringify(c.signal)).toBe(false);
      expect(evalSignalOnState(c.signal, after), JSON.stringify(c.signal)).toBe(true);
    }
  });

  it("expresses a disappearing element as `not`, never as a positive claim", () => {
    const withSpinner = view("https://x/a", { e0: el("div", "loading", { data_test: "spinner" }) });
    const noSpinner = view("https://x/a", { e1: el("div", "done", { data_test: "done" }) });
    const r = induceSignals(withSpinner, noSpinner);
    const gone = r.candidates.find((c) => c.kind === "gone");
    expect(gone).toBeDefined();
    expect(JSON.stringify(gone!.signal)).toBe(JSON.stringify({ not: { css_exists: ["[data-test=spinner]"] } }));
    expect(evalSignalOnState(gone!.signal, withSpinner)).toBe(false);
    expect(evalSignalOnState(gone!.signal, noSpinner)).toBe(true);
  });

  it("says no-signal (-> manual) instead of offering a predicate that does not discriminate", () => {
    // a truly identical state (no URL change, no element delta): nothing to induce
    const r = induceSignals(before, { url: before.url, elems: { ...before.elems } });
    expect(r.verdict).toBe("no-signal");
    expect(r.candidates).toEqual([]);
    // a predicate that is ALREADY true before the action must be rejected: the
    // selector `[data-test=toast]` matches a different element in each state, so
    // "it exists after" is not evidence of this step's effect.
    const alreadyTrue = induceSignals(
      view("https://x/a", { e0: el("a", "old", { data_test: "toast" }) }),
      view("https://x/a", { e0: el("a", "old", { data_test: "toast" }),
                            e1: el("button", "new", { data_test: "toast" }, 2) }),
    );
    expect(alreadyTrue.rejected.some((x) => /not discriminating/.test(x.reason))).toBe(true);
  });

  it("names the fields it compared", () => {
    const d = diffStates(before, after);
    expect(d.urlChanged).toBe(true);
    expect(d.appeared.map((e) => e.data_test)).toEqual(["toast"]);
    expect(d.changed.map((c) => c.after.data_test)).toEqual(["cart-count"]);
    expect(d.gone).toEqual([]);
  });

  it("gates adoption on reproduction across runs", () => {
    const sig: SignalSpec = { css_text_equals: ["[data-test=cart-count]", "1"] };
    expect(signalReproducible(sig, [[before, after], [before, after]])).toBe(true);
    expect(signalReproducible(sig, [[before, after], [after, after]])).toBe(false);
    expect(signalReproducible(sig, [])).toBe(false);
  });
});

describe("induction on a real transition (browser)", () => {
  it("recovers the hand-written signal for the fixture's add-to-cart step", async () => {
    const browser = (await browserEnv.launch({ chromium } as never, true)) as never as {
      newPage(): Promise<unknown>; close(): Promise<void>;
    };
    const raw = await browser.newPage();
    const page = raw as unknown as PageLike & {
      goto(u: string, o?: unknown): Promise<void>;
      click(s: string): Promise<void>;
    };
    const snap = async (): Promise<StateView> =>
      captureStateView(page as never, { interactive: await extractElements(page as never) });
    try {
      await page.goto(`file://${PAGES}product.html`, { waitUntil: "domcontentloaded" });
      const before = await snap();
      await page.click("[data-test=add-to-cart]");
      const after = await snap();

      const r = induceSignals(before, after);
      expect(r.verdict).toBe("discriminating");
      const jsons = r.candidates.map((c) => JSON.stringify(c.signal));
      // the hand-authored signal for this step, in the repo's own fixtures:
      expect(jsons).toContain(JSON.stringify({ css_text_equals: ["[data-test=cart-count]", "1"] }));

      // ... and the hand-written signal is discriminating on the captured states,
      // which is the offline check a plan author now gets for free
      const human: SignalSpec = { css_text_equals: ["[data-test=cart-count]", "1"] };
      expect(evalSignalOnState(human, before)).toBe(false);
      expect(evalSignalOnState(human, after)).toBe(true);

      // the recommended candidate behaves like the hand-written one on the LIVE page
      expect(await checkSignal(page as never, r.candidates[0]!.signal)).toBe(true);
      await page.goto(`file://${PAGES}product.html`, { waitUntil: "domcontentloaded" });
      expect(await checkSignal(page as never, r.candidates[0]!.signal)).toBe(false);
    } finally {
      await browser.close();
    }
  }, 120_000);
});
