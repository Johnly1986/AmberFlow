/**
 * Ported 1:1 from `test_middleware.py` (the Python suite is the spec).
 * Every assertion here exists because a measured failure made it necessary —
 * see the comments carried over from the Python tests.
 */
import { describe, expect, it } from "vitest";
import { affordanceRule, hintMatch, navRule } from "../src/rules.ts";
import { esig, type Elem, type ElemPool } from "../src/extraction.ts";

/** Same factory as the Python suite's `el()`. */
function el(ref: string, tag = "button", label = "", dataTest = "", kw: Partial<Elem> = {}): Elem {
  const scan = /^\d+$/.test(ref.slice(1)) ? Number(ref.slice(1)) : 0;
  return { ref, scan, tag, label, data_test: dataTest, name: "", id: "", input_type: "", href: "", ...kw };
}
const pool = (...es: Elem[]): ElemPool => Object.fromEntries(es.map((e) => [e.ref!, e]));

describe("target_hint grammar", () => {
  it("matches an exact attribute and constrains the tag prefix", () => {
    const elems = pool(el("e0", "button", "Add to cart", "add-to-cart"), el("e1", "button", "Support", "support"));
    expect(hintMatch("button[data-test=add-to-cart]", elems)).toBe("e0");
    expect(hintMatch("[data-test=support]", elems)).toBe("e1");
    expect(hintMatch("a[data-test=add-to-cart]", elems)).toBeNull();
  });

  it("matches an attribute substring (href keeps last two path segments)", () => {
    const elems = pool(
      el("e0", "a", "Travel", "", { href: "travel_2/index.html" }),
      el("e1", "a", "Home", "", { href: "index.html" }),
    );
    expect(hintMatch("a[href~travel_2]", elems)).toBe("e0");
  });

  it("disambiguates duplicate labels by the near~ container line", () => {
    const elems = pool(
      el("e0", "button", "Add to cart", "", { near: "Sauce Labs Onesie" }),
      el("e1", "button", "Add to cart", "", { near: "Sauce Labs Backpack" }),
    );
    expect(hintMatch("button[near~onesie]", elems)).toBe("e0");
    expect(hintMatch("button[near~missing]", elems)).toBeNull();
  });

  it("prefers the submit-type widget when the tag alone is ambiguous", () => {
    const elems = pool(
      el("e0", "input", "User", "", { input_type: "text" }),
      el("e1", "input", "Login", "", { input_type: "submit" }),
    );
    expect(hintMatch("input", elems)).toBe("e1");
    const both = pool(el("e0", "button", "Ok"), el("e1", "button", "Cancel"));
    expect(hintMatch("button", both)).toBeNull();   // ambiguity must not be guessed
  });

  it("matches a bare token as ONE whole word (dashed ids use the [data-test=] form)", () => {
    const elems = pool(el("e0", "button", "Sign in", "login-btn"));
    expect(hintMatch("login", elems)).toBe("e0");
    expect(hintMatch("login-btn", elems)).toBeNull();
    expect(hintMatch("[data-test=login-btn]", elems)).toBe("e0");
    expect(hintMatch("nope", elems)).toBeNull();
  });

  it("supports the #id selector, case-folded", () => {
    const elems = pool(el("e0", "input", "Search Wikipedia", "", { id: "searchInput" }), el("e1", "button", "Search"));
    expect(hintMatch("#searchInput", elems)).toBe("e0");
    expect(hintMatch("#SEARCHINPUT", elems)).toBe("e0");
    expect(hintMatch("#missing", elems)).toBeNull();
  });

  it("case-folds attribute VALUES (net-CAM-1001 is the normal device-id shape)", () => {
    const elems = pool(el("e0", "a", "网络设置", "net-CAM-1001"));
    expect(hintMatch("a[data-test=net-CAM-1001]", elems)).toBe("e0");
    expect(hintMatch("a[data-test=NET-cam-1001]", elems)).toBe("e0");
    expect(hintMatch("a[data-test=other]", elems)).toBeNull();
    expect(hintMatch("#net-CAM-1001", pool(el("e1", "a", "", "", { id: "net-CAM-1001" })))).toBe("e1");
  });

  it("resolves indistinguishable duplicate links, refuses genuinely different ones", () => {
    // bbc.com ships two identical /news links (header nav + body): either
    // satisfies the goal, so take the first in scan order.
    const dup = pool(el("e3", "a", "News", "", { href: "/news" }), el("e7", "a", "News", "", { href: "/news" }));
    expect(hintMatch("a[href=/news]", dup)).toBe("e3");
    // TIERED (measured on the live en.wikipedia search results): a slug hint must
    // prefer the page NAMED that slug over pages that merely contain it, instead
    // of declaring ambiguity and handing the step to laya.
    const different = pool(
      el("e0", "a", "News", "", { href: "/news" }),
      el("e1", "a", "Newsletter", "", { href: "/newsletter" }),
    );
    expect(hintMatch("a[href~news]", different)).toBe("e0");
    // ... but when NO candidate owns the slug, genuine ambiguity still refuses.
    const ambiguous = pool(
      el("e0", "a", "World", "", { href: "/news/world" }),
      el("e1", "a", "UK", "", { href: "/news/uk" }),
    );
    expect(hintMatch("a[href~news]", ambiguous)).toBeNull();
  });

  it("prefers an exact attribute over a slug, and a slug over a substring", () => {
    const absolute = pool(
      el("e0", "a", "Alan Turing", "", { href: "https://en.wikipedia.org/wiki/Alan_Turing" }),
      el("e1", "a", "Enigma", "", { href: "https://en.wikipedia.org/wiki/Alan_Turing:_The_Enigma" }),
      el("e2", "a", "Law", "", { href: "https://en.wikipedia.org/wiki/Alan_Turing_law" }),
    );
    expect(hintMatch("a[href~Alan_Turing]", absolute)).toBe("e0");   // absolute href, slug at the end
    const exact = pool(
      el("e0", "a", "Turing", "", { href: "Alan_Turing" }),
      el("e1", "a", "Law", "", { href: "Alan_Turing_law" }),
    );
    expect(hintMatch("a[href~Alan_Turing]", exact)).toBe("e0");      // exact equality wins
  });

  it("resolves a bare token to the exact label when related titles contain it", () => {
    // The live zh search results: the canonical article is one candidate among
    // ~100 language-sidebar links whose title merely CONTAINS the token.
    const elems = pool(
      el("e0", "a", "艾伦·图灵", "", { href: "/wiki/%E8%89%BE%E4%BC%A6%C2%B7%E5%9B%BE%E7%81%B5" }),
      el("e1", "a", "艾伦·图灵 – 古吉拉特语", "", { href: "https://gu.wikipedia.org/wiki/x" }),
      el("e3", "a", "艾伦·图灵 (消歧义)", "", { href: "/wiki/disamb" }),
    );
    expect(hintMatch("艾伦·图灵", elems)).toBe("e0");                // exact word beats prefix/contains
    // A word-level match is stronger than a prefix, but the PREFIX tier itself
    // must stay ambiguous when the candidates differ.
    const onlyPrefixes = pool(
      el("e0", "a", "艾伦·图灵奖", "", { href: "/prize" }),
      el("e1", "a", "艾伦·图灵研究所", "", { href: "/institute" }),
    );
    expect(hintMatch("艾伦·图灵", onlyPrefixes)).toBeNull();
  });
});

describe("literal rules", () => {
  it("treats a frozen-plan hint as authoritative even when it misses", () => {
    const elems = pool(el("e0", "input", "Coupon", "coupon"));
    expect(affordanceRule("type the coupon in", elems, "input[data-test=coupon]")).toBe("e0");
    expect(affordanceRule("type the coupon in", elems, "input[data-test=does-not-exist]")).toBeNull();
  });

  it("matches labels as whole words, never as prefixes", () => {
    const elems = pool(el("e0", "button", "Apply coupon"));
    expect(affordanceRule("apply a coupon", elems)).toBe("e0");
    expect(affordanceRule("applying a discount", elems)).toBeNull();
  });

  it("lets data-test tokens prefix-match", () => {
    const elems = pool(el("e0", "input", "", "f-title"));
    expect(affordanceRule("type into the title field", elems)).toBe("e0");
  });

  it("requires a CJK label to be a token of the instruction", () => {
    const elems = pool(el("e0", "input", "标题", "f-title"));
    expect(affordanceRule("填写 标题 输入框", elems)).toBe("e0");
    expect(affordanceRule("请填写标题内容", elems)).toBeNull();   // glued interior substring
  });

  it("fires navRule only on navigation verbs", () => {
    const elems = pool(el("e0", "a", "Cart", "", { href: "cart.html" }));
    expect(navRule("add the item to the shopping cart", elems)).toBeNull();
    expect(navRule("open the cart page", elems)).toBe("e0");
  });

  it("narrows nav ambiguity to the anchor", () => {
    const elems = pool(
      el("e0", "a", "Login", "", { href: "login" }),
      el("e1", "input", "Login", "", { input_type: "submit" }),
    );
    expect(navRule("open the login page", elems)).toBe("e0");
  });
});

describe("element identity", () => {
  it("esig ignores the positional ref", () => {
    expect(esig(el("e0", "button", "Pay now"))).toEqual(esig(el("e7", "button", "Pay now")));
    expect(esig(el("e0", "button", "Pay now"))).not.toEqual(esig(el("e0", "button", "Accept")));
  });
});
