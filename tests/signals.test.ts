/** Signal language tests — ported from test_middleware.py + one new unknown-op case. */
import { describe, expect, it } from "vitest";
import { checkSignal, SIGNAL_OPS, signalArgs } from "../src/engine/signals.ts";
import type { LocLike, PageLike } from "../src/engine/extraction.ts";

const fakePage = (url: string): PageLike => ({ url });

describe("checkSignal — url operators", () => {
  it("accepts both the scalar (cases.json) and list (plan_cli) shapes", async () => {
    const page = fakePage("https://x.test/cart.html");
    await expect(checkSignal(page, { url_contains: "cart.html" })).resolves.toBe(true);
    await expect(checkSignal(page, { url_contains: ["cart.html"] })).resolves.toBe(true);
    await expect(checkSignal(page, { url_contains: "checkout" })).resolves.toBe(false);
  });

  it("throws on an unknown operator instead of silently passing", async () => {
    await expect(checkSignal(fakePage("https://x.test/"), { nope: "x" })).rejects.toThrow(/unknown signal spec/);
  });
});

describe("checkSignal — css operators read the first match", () => {
  const loc = (text: string, value = ""): LocLike => ({
    count: () => 1,
    first: { innerText: () => text, inputValue: () => value },
  });
  const pageWith = (l: LocLike | null): PageLike => ({ url: "https://x.test/p", locatorAnyFrame: () => l });

  it("css_exists", async () => {
    await expect(checkSignal(pageWith(loc("x")), { css_exists: "#done" })).resolves.toBe(true);
    await expect(checkSignal(pageWith(null), { css_exists: "#done" })).resolves.toBe(false);
  });

  it("css_text_contains survives cosmetic chrome (zh.wikipedia's h1 reads 艾伦·图灵编辑)", async () => {
    const page = pageWith(loc("艾伦·图灵编辑"));
    await expect(checkSignal(page, { css_text_contains: ["h1", "艾伦·图灵"] })).resolves.toBe(true);
    await expect(checkSignal(page, { css_text_equals: ["h1", "艾伦·图灵"] })).resolves.toBe(false);
  });

  it("css_text_equals trims, css_value_equals reads the input value", async () => {
    const page = pageWith(loc("  42  ", "3"));
    await expect(checkSignal(page, { css_text_equals: ["#total", "42"] })).resolves.toBe(true);
    await expect(checkSignal(page, { css_value_equals: ["#qty", 3] })).resolves.toBe(true);
    await expect(checkSignal(page, { css_value_equals: ["#qty", "4"] })).resolves.toBe(false);
  });

  it("degrades to false when the page probe throws (never kills the run)", async () => {
    const page: PageLike = { url: "https://x.test/p", locatorAnyFrame: () => { throw new Error("frame gone"); } };
    await expect(checkSignal(page, { css_exists: "#x" })).resolves.toBe(false);
  });
});

describe("signal contract", () => {
  it("keeps the five DOM leaves, the combinators and `manual` in one map", () => {
    expect(SIGNAL_OPS).toEqual({
      // the leaves: every completion claim is ultimately one of these DOM facts
      url_contains: 1, css_exists: 1, css_text_equals: 2, css_text_contains: 2, css_value_equals: 2,
      // composition (arity handled structurally by PlanningRules, not as scalars)
      all_of: 1, any_of: 1, not: 1,
      // a human attestation: never verifiable from the DOM, so it blocks without a human
      manual: 0,
    });
  });

  it("a `manual` signal is false to the automated loop (only a human can attest it)", async () => {
    // no page needed: the live check returns false before touching the DOM
    expect(await checkSignal({} as never, { manual: true })).toBe(false);
  });

  it("signalArgs normalises scalars without calling .length on a number", () => {
    expect(signalArgs("x")).toEqual(["x"]);
    expect(signalArgs(["a", "b"])).toEqual(["a", "b"]);
    expect(signalArgs(3)).toEqual([3]);
  });
});
