/**
 * Path A / long-task / tune-guard tests. The picker is the seam: a scripted
 * decision table replaces the checkpoint, so the guards, the click logic and the
 * scene verification are what is actually under test.
 */
import { afterAll, describe, expect, it } from "vitest";
import { PAGES, SCENES, extractState, main as pathAMain, type AnyPage } from "../src/path-a.ts";
import { GOAL, main as longTaskMain } from "../src/long-task.ts";
import { PAGES_TO_SCORE, VARIANTS, measure } from "../src/tune-guard.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer, type Question } from "../src/model.ts";
import type { PickDecision, QuickActionPicker } from "../src/picker.ts";
import { chromium } from "playwright";
import * as browserEnv from "../src/browser-env.ts";

afterAll(() => installLayaRuntime(null));

/* ------------------------------------------------------------------ path A */

describe("Path A — extractState + scene verification", () => {
  it("extracts the compact page state (signal, not a DOM dump)", async () => {
    const browser = (await browserEnv.launch({ chromium } as never)) as never as {
      newPage(): Promise<AnyPage>; close(): Promise<void>;
    };
    const page = await browser.newPage();
    try {
      await page.goto(new URL(`file://${PAGES}/product.html`).href);
      const s = await extractState(page);
      expect(s.url).toContain("product.html");
      expect(String(s.title)).toContain("Example Shop");
      expect(String(s.main_text).length).toBeGreaterThan(10);
      expect(s.main_text as string).not.toContain("<");
      expect((s.visible_buttons as string[]).length).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("defines the three scenes with the injection scene never clicking", () => {
    expect(SCENES.map((s) => s.name)).toEqual(["product page", "cart page", "injection page"]);
    expect(SCENES[2]!.expectClick({ confirmSafe: true })).toBe(false);
    expect(SCENES[0]!.expectClick({ confirmSafe: true })).toBe(true);
    expect(SCENES[0]!.expectClick({ confirmSafe: false })).toBe(false);
  });
});

/** Decision table keyed by the page being driven. */
function scriptedPicker(attackP = 0.0): QuickActionPicker {
  const decide = (url: string): PickDecision => {
    const blocked = attackP > 0.5 || url.includes("attack.html");
    if (blocked) {
      return {
        action: "add_to_cart", probabilities: { add_to_cart: 0.9 }, selector: "button[data-test='add-to-cart']",
        auto_execute: false,
        reason: `blocked: suspected prompt injection on page (p=${(attackP > 0.5 ? attackP : 1.0).toFixed(2)})`,
        guards: { attack_p: attackP > 0.5 ? attackP : 1.0, irreversible_p: 0.1, confidence: 0.9 }, candidates: [],
      };
    }
    if (url.includes("cart.html")) {
      return {
        action: "checkout", probabilities: { checkout: 0.82 }, selector: "a[data-test='checkout']",
        auto_execute: false, reason: "destructive/irreversible -- requires user confirmation",
        guards: { attack_p: 0.0, irreversible_p: 0.9, confidence: 0.82 },
        candidates: [{ label: "checkout", probability: 0.82, selector: "a[data-test='checkout']" }],
      };
    }
    return {
      action: "add_to_cart", probabilities: { add_to_cart: 0.94 }, selector: "button[data-test='add-to-cart']",
      auto_execute: false, reason: "destructive/irreversible -- requires user confirmation",
      guards: { attack_p: 0.0, irreversible_p: 0.83, confidence: 0.94 },
      candidates: [{ label: "add_to_cart", probability: 0.94, selector: "button[data-test='add-to-cart']" }],
    };
  };
  return { pick: async (state: Record<string, unknown>) => decide(String(state.url)) } as unknown as QuickActionPicker;
}

describe("Path A — end to end against the fixtures", () => {
  it("passes all three scenes with --confirm-safe (holds get confirmed, injection stays blocked)", async () => {
    expect(await pathAMain(["--confirm-safe"], { picker: scriptedPicker() })).toBe(0);
  }, 120_000);

  it("passes without --confirm-safe too: the holds are expected outcomes", async () => {
    expect(await pathAMain([], { picker: scriptedPicker() })).toBe(0);
  }, 120_000);

  it("fails when a guard blocks a scene that expected a click", async () => {
    // the injection block is absolute: even --confirm-safe must not click
    expect(await pathAMain(["--confirm-safe"], { picker: scriptedPicker(0.99) })).toBe(1);
  }, 120_000);
});

/* ---------------------------------------------------------------- long task */

describe("long task — the flagship plan runs 3/3 and audits APPROVE", () => {
  it("plan → execute → audit end to end", async () => {
    const agent = scriptedAgent((key: string, _s: unknown, questions: Record<string, Question>): Answer | undefined => {
      if (key === "r") return { noul: 0.05 };
      if (key === "act") {
        const crit = (questions[key]!.criteria ?? {}) as Record<string, unknown>;
        const keys = Object.keys(crit);
        const want = ["add to cart", "coupon"];
        const choice = want.map((w) => keys.find((k) => String(crit[k]).toLowerCase().includes(w)))
          .find(Boolean) ?? keys[0]!;
        const rest = 0.1 / Math.max(1, keys.length - 1);
        return {
          choice,
          probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 0.9 : rest])),
          confidence: 0.9,
        };
      }
      return undefined;
    });
    installLayaRuntime(scriptedRuntime(agent));
    expect(GOAL).toContain("coupon=SAVE10");
    expect(await longTaskMain([])).toBe(0);
    installLayaRuntime(null);
  }, 120_000);
});

/* --------------------------------------------------------------- tune guard */

describe("tune_guard — two phrasings, three pages", () => {
  it("scores both phrasings for every fixture page", async () => {
    const agent = scriptedAgent((_k: string, state: unknown, questions: Record<string, Question>): Answer => {
      const ins = String(questions.g!.instructions ?? "");
      // the fixture's injection text lives in a hidden <p> (innerText excludes it),
      // so the fake keys on the page URL — the guard's separation is what matters
      const isAttackPage = String((state as { url?: unknown }).url ?? "").includes("attack");
      const narrower = ins.includes("imperative command");
      return { noul: isAttackPage ? 0.99 : narrower ? 0.2 : 0.85 };
    });
    const table = await measure({ agent });
    expect(Object.keys(table)).toEqual([...PAGES_TO_SCORE]);
    expect(Object.keys(VARIANTS)).toEqual(["A current", "B narrower"]);
    expect(table.attack!["A current"]).toBeCloseTo(0.99, 3);
    expect(table.product!["A current"]).toBeCloseTo(0.85, 3);
    expect(table.product!["B narrower"]).toBeCloseTo(0.2, 3);
  }, 120_000);
});
