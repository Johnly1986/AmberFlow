/**
 * Executor tests — the production loop driven end-to-end against a REAL
 * Playwright browser and the repo's own fixtures, with a scripted model runtime
 * (no checkpoint is ever loaded: `installLayaRuntime(scriptedRuntime(...))`).
 *
 * Each case pins one of the semantics `layaapp/executor.py` encodes, in the same
 * order the Python suite would: DOM-signal completion, the risk gate, the
 * confidence floor, the `when` precondition, ordered target_hints, submit-type
 * inputs, inert detection, the locator handle chain, frames, and the
 * occlusion/actionability probe.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import * as browserEnv from "../src/browser-env.ts";
import {
  BrowserMiddleware,
  browserSession,
  routerMaxLoaded,
  type AnyPage,
  type PwLike,
} from "../src/executor.ts";
import { extractElements, type Elem } from "../src/extraction.ts";
import {
  installLayaRuntime,
  scriptedAgent,
  scriptedRuntime,
  type DecisionAgent,
  type ModelState,
  type Question,
} from "../src/model.ts";
import { checkSignal } from "../src/signals.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const fixture = (...p: string[]): string => pathToFileURL(path.join(REPO, ...p)).href;
/** Synthetic pages need no new fixture file: run() navigates to a data: URL. */
const dataUrl = (html: string): string => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

let browser: Browser;
let page: Page;

const pw: PwLike = { chromium: chromium as unknown as PwLike["chromium"] };
const asPage = (): AnyPage => page as unknown as AnyPage;

beforeAll(async () => {
  browser = (await browserEnv.launch(pw)) as unknown as Browser;
  const ctx = await browser.newContext();
  page = await ctx.newPage();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  installLayaRuntime(null);          // never leak the fake runtime into another file
});

/* ---------------------------------------------------------------- scripted model */

type Pick = (crit: Record<string, string>, state: ModelState) => { choice: string; confidence: number } | null;

/**
 * A fake laya agent answering all three question kinds the executor asks:
 * `act` (choice), `r` (risky noul), `d` (done noul). The pick is chosen from the
 * criteria view the executor handed us, so a test never hard-codes a positional
 * ref (refs are re-indexed on every scan).
 */
function fakeAgent(pick: Pick, risk = 0.05, done = 0.0): DecisionAgent {
  return scriptedAgent((key, state, questions: Record<string, Question>) => {
    if (key === "act") {
      const crit = (questions["act"]?.criteria ?? {}) as Record<string, string>;
      const r = pick(crit, state);
      if (!r) return undefined;
      return { choice: r.choice, probabilities: { [r.choice]: r.confidence }, confidence: r.confidence };
    }
    if (key === "r") return { noul: risk };
    if (key === "d") return { noul: done };
    return undefined;
  });
}

const refWith = (crit: Record<string, string>, needle: string): string | null =>
  Object.entries(crit).find(([, v]) => v.includes(needle))?.[0] ?? null;
const firstRef = (crit: Record<string, string>): string | null => Object.keys(crit)[0] ?? null;

const install = (agent: DecisionAgent): void => installLayaRuntime(scriptedRuntime(agent));
const mw = (opts: ConstructorParameters<typeof BrowserMiddleware>[0] = {}): BrowserMiddleware =>
  new BrowserMiddleware({ modelId: "scripted", ...opts });

beforeEach(() => {
  // A benign default so no test can accidentally run without a runtime.
  install(fakeAgent((crit) => {
    const r = firstRef(crit);
    return r ? { choice: r, confidence: 0.9 } : null;
  }));
});

/* ---------------------------------------------------------------- the loop */

describe("BrowserMiddleware.run — production loop semantics", () => {
  it("① completes a subgoal on the DOM signal (report.done === true)", async () => {
    install(fakeAgent((crit) => {
      const r = refWith(crit, "[test=add-to-cart]");
      return r ? { choice: r, confidence: 0.93 } : null;
    }));
    const report = await mw({ maxSteps: 4 }).run(
      "add the wireless mouse to the cart", fixture("testpages", "product.html"),
      {
        page: asPage(), pw, verbose: false,
        goalSignalFn: (p) => checkSignal(p, { css_text_contains: ["[data-test='cart-count']", "1"] }),
      },
    );

    expect(report.done).toBe(true);
    expect(report.stop_reason).toBe("dom goal signal");
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]).toMatchObject({
      step: 1, how: "clicked", executed: true, confirmed: false, inert: false, method: "laya",
    });
    expect(String(report.steps[0]!.desc)).toContain("Add to cart");
    expect(report.audit.verdict).toBe("APPROVE");
  }, 60_000);

  it("② refuses a risky action, forbids that element and never completes", async () => {
    install(fakeAgent((crit) => {
      const r = refWith(crit, "[test=checkout]") ?? firstRef(crit);
      return r ? { choice: r, confidence: 0.9 } : null;
    }));
    const asked: string[] = [];
    const report = await mw({
      maxSteps: 2,
      // the risk gate ASKS (never blocks); this human says no
      confirmFn: (desc) => { asked.push(desc); return false; },
    }).run(
      "proceed to checkout and pay", fixture("bench", "fixtures", "shop_cart.html"),
      { page: asPage(), pw, verbose: false, goalSignalFn: () => false },
    );

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("Proceed to checkout");
    expect(report.done).toBe(false);
    const risky = report.steps.filter((s) => s.risky === true);
    expect(risky).toHaveLength(1);
    // Python's refused step carries no `how` key at all
    expect(risky[0]).toMatchObject({ executed: false, confirmed: false });
    expect("how" in (risky[0] as object)).toBe(false);
    expect(String(risky[0]!.desc)).toContain("Proceed to checkout");
    // the refusal forbade the element: the loop can never re-drive it
    expect(report.steps.filter((s) => String(s.desc).includes("Proceed to checkout"))).toHaveLength(1);
  }, 60_000);

  it("③ stops below the confidence floor with the Python wording", async () => {
    install(fakeAgent((crit) => {
      const r = firstRef(crit);
      return r ? { choice: r, confidence: 0.17 } : null;
    }));
    const report = await mw({ confFloor: 0.25 }).run(
      "choose the ergonomic device", fixture("testpages", "product.html"),
      { page: asPage(), pw, verbose: false, goalSignalFn: () => false },
    );

    expect(report.done).toBe(false);
    expect(report.steps).toHaveLength(0);
    expect(report.stop_reason).toBe("low confidence 0.17 < floor 0.25 on step 1");
  }, 60_000);

  it("④ skips the subgoal when the precondition (`when`) does not hold — zero steps, zero model calls", async () => {
    let calls = 0;
    const counting = scriptedAgent((key, _state, questions) => {
      calls += 1;
      if (key === "act") {
        const crit = (questions["act"]?.criteria ?? {}) as Record<string, string>;
        return { choice: Object.keys(crit)[0]!, probabilities: {}, confidence: 0.9 };
      }
      if (key === "r") return { noul: 0.0 };
      if (key === "d") return { noul: 0.0 };
      return undefined;
    });
    install(counting);

    const report = await mw().run("dismiss the consent banner", fixture("testpages", "product.html"), {
      page: asPage(), pw, verbose: false,
      precondition: { css_exists: "#no-such-banner" },
    });

    expect(report).toMatchObject({
      done: true, skipped: true, stop_reason: "precondition not met -> skipped", steps: [],
    });
    expect(report.audit).toMatchObject({ verdict: "SKIPPED", auditor: "n/a" });
    expect(calls).toBe(0);
  }, 60_000);

  it("⑤ walks ordered target_hints through two deterministic actions (fill, then click)", async () => {
    install(fakeAgent((crit) => {
      const r = firstRef(crit);
      return r ? { choice: r, confidence: 0.9 } : null;
    }));
    const report = await mw({ maxSteps: 4 }).run(
      "apply coupon ACME10", fixture("bench", "fixtures", "shop_cart.html"),
      {
        page: asPage(), pw, verbose: false,
        targetHints: ["[data-test=coupon]", "[data-test=apply-coupon]"],
        slots: { coupon: "ACME10" },
        goalSignalFn: (p) => checkSignal(p, { css_text_contains: ["[data-test='coupon-msg']", "Coupon applied"] }),
      },
    );

    expect(report.done).toBe(true);
    expect(report.stop_reason).toBe("dom goal signal");
    expect(report.steps).toHaveLength(2);
    expect(report.steps[0]).toMatchObject({ step: 1, how: "filled", method: "rule:match", value: "ACME10" });
    expect(String(report.steps[0]!.desc)).toContain("Coupon code");
    expect(report.steps[1]).toMatchObject({ step: 2, how: "clicked", method: "rule:match" });
    expect(String(report.steps[1]!.desc)).toContain("Apply coupon");
  }, 60_000);

  it("⑥ clicks a submit-type input instead of filling it", async () => {
    install(fakeAgent((crit) => {
      const r = firstRef(crit);
      return r ? { choice: r, confidence: 0.9 } : null;
    }));
    const report = await mw({ maxSteps: 3 }).run(
      "log in", dataUrl(`<html><body><main><h1>Sign in</h1>
        <form onsubmit="event.preventDefault();document.getElementById('out').textContent='signed in';">
          <input type="submit" data-test="login" value="Login">
        </form><p id="out"></p></main></body></html>`),
      {
        page: asPage(), pw, verbose: false,
        targetHint: "[data-test=login]",
        goalSignalFn: (p) => checkSignal(p, { css_text_contains: ["#out", "signed in"] }),
      },
    );

    expect(report.done).toBe(true);
    expect(report.steps).toHaveLength(1);
    // "filled"/"needs_value" would both mean the fill branch ran
    expect(report.steps[0]).toMatchObject({ how: "clicked", executed: true });
    expect(String(report.steps[0]!.desc)).toContain('input "Login"');
    // the control was clicked, not typed into: its label-value is untouched
    expect(await page.locator("[data-test='login']").inputValue()).toBe("Login");
  }, 60_000);

  it("⑦ forbids an inert element (unchanged url+text+values) so it is clicked at most once", async () => {
    install(fakeAgent((crit) => {
      const r = firstRef(crit);
      return r ? { choice: r, confidence: 0.9 } : null;
    }));
    const report = await mw({ maxSteps: 2 }).run(
      "do the thing", dataUrl(`<html><body><main><h1>Static</h1>
        <button data-test="noop" onclick="window.__hits=(window.__hits||0)+1">Do nothing</button>
        </main></body></html>`),
      {
        page: asPage(), pw, verbose: false,
        targetHint: "[data-test=noop]",
        goalSignalFn: (p) => checkSignal(p, { css_exists: "#never" }),
      },
    );

    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]).toMatchObject({ step: 1, how: "clicked", executed: true, inert: true });
    // the inert element was forbidden -> step 2 could not pick anything
    expect(report.stop_reason).toBe("action space exhausted on step 2");
    expect(report.done).toBe(false);
    expect(await page.evaluate(() => (globalThis as unknown as { __hits?: number }).__hits ?? 0)).toBe(1);
  }, 60_000);

  it("⑧ resolves an element through the data-dshref handle (positional fallback dead)", async () => {
    await page.goto("about:blank");
    await page.setContent(`<html><body><main><h1>Stamp</h1>
      <button data-test="stamp" onclick="window.__hits=(window.__hits||0)+1">Stamp it</button>
      </main></body></html>`);
    const elems = await extractElements(asPage(), false);
    const el = Object.values(elems).find((e) => e.data_test === "stamp") as Elem;
    expect(el).toBeTruthy();
    expect(el.dsh_ref).toBeTruthy();

    const m = mw();
    // data_test AND the positional fallback are removed: only data-dshref can resolve
    const reason = await m.occludedReason(asPage(), { ...el, data_test: "", scan: 9999 });
    expect(reason).toBe("__clicked__");
    expect(await page.evaluate(() => (globalThis as unknown as { __hits?: number }).__hits ?? 0)).toBe(1);
    // …and with the stamp gone, the dead scan index reports a stale ref
    expect(await m.occludedReason(asPage(), { ...el, dsh_ref: "", data_test: "", scan: 9999 })).toBe("stale_ref");
  }, 60_000);

  it("⑨ drives a form INSIDE an iframe (frame-scoped handles + any-frame signal)", async () => {
    install(fakeAgent((crit) => {
      const r = firstRef(crit);
      return r ? { choice: r, confidence: 0.9 } : null;
    }));
    const report = await mw({ maxSteps: 4 }).run(
      "register the device serial", fixture("bench", "fixtures", "frames_parent.html"),
      {
        page: asPage(), pw, verbose: false,
        targetHints: ["[data-test=f-serial]", "[data-test=f-submit]"],
        slots: { serial: "SN-42" },
        goalSignalFn: (p) => checkSignal(p, { css_text_contains: ["[data-test='done-title']", "已登记"] }),
      },
    );

    expect(report.done).toBe(true);
    expect(report.stop_reason).toBe("dom goal signal");
    expect(report.steps.map((s) => s.how)).toEqual(["filled", "clicked"]);
    expect(report.steps[0]!.value).toBe("SN-42");
  }, 60_000);

  it("⑩ reports a covered element as not-actionable instead of burning the click timeout", async () => {
    install(fakeAgent((crit) => {
      const r = firstRef(crit);
      return r ? { choice: r, confidence: 0.9 } : null;
    }));
    const started = Date.now();
    const report = await mw({ maxSteps: 2 }).run(
      "press the covered button",
      dataUrl(`<html><body><main><h1>Overlay</h1>
        <button data-test="covered">Click me</button></main>
        <div id="overlay" style="position:fixed;inset:0;z-index:9999"></div></body></html>`),
      {
        page: asPage(), pw, verbose: false,
        targetHint: "[data-test=covered]",
        goalSignalFn: () => false,
      },
    );
    const elapsed = Date.now() - started;

    expect(report.steps).toHaveLength(1);
    expect(String(report.steps[0]!.how)).toContain("not-actionable-or-covered");
    expect(report.steps[0]).toMatchObject({ executed: false });
    // the 800 ms probe reports the cause: nothing like the 5 s click timeout
    expect(elapsed).toBeLessThan(5_000);
    expect(report.stop_reason).toBe("action space exhausted on step 2");
  }, 60_000);

  it("⑪ never grants `done` from the model's noul — unverified claims only stop the loop", async () => {
    install(fakeAgent((crit) => {
      const r = refWith(crit, "[test=add-to-cart]");
      return r ? { choice: r, confidence: 0.93 } : null;
    }, 0.05, 0.9));                       // the risk noul says no, the done noul says YES
    const report = await mw({ maxSteps: 4 }).run(
      "add the wireless mouse to the cart", fixture("testpages", "product.html"),
      { page: asPage(), pw, verbose: false },   // no goalSignalFn at all
    );

    expect(report.done).toBe(false);
    expect(report.stop_reason).toBe("laya claims done (p=0.90) but no DOM signal to verify");
    expect(report.steps).toHaveLength(1);
  }, 60_000);

  it("⑫ a rule-picked field with no slot value returns needs_value and never invents one", async () => {
    install(fakeAgent((crit) => {
      const r = firstRef(crit);
      return r ? { choice: r, confidence: 0.9 } : null;
    }));
    const report = await mw({ maxSteps: 1 }).run(
      "apply coupon", fixture("bench", "fixtures", "shop_cart.html"),
      {
        page: asPage(), pw, verbose: false,
        targetHint: "[data-test=coupon]",        // authoritative, but slots carry nothing
        goalSignalFn: () => false,
      },
    );

    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]).toMatchObject({ how: "needs_value", executed: false, method: "rule:match" });
    expect(report.stop_reason).toBe("max_steps");
    expect(await page.locator("[data-test='coupon']").inputValue()).toBe("");
  }, 60_000);
});

/* ---------------------------------------------------------------- lifecycle */

describe("browser lifecycle + RAM probe", () => {
  it("browserSession owns one page and closes its own browser", async () => {
    const s = await browserSession(true);
    await s.page.goto(fixture("testpages", "checkout.html"), { waitUntil: "domcontentloaded" });
    expect(await s.page.title()).toContain("Order Placed");
    await s.close();
    await s.close();          // idempotent teardown
  }, 60_000);

  it("routerMaxLoaded stays in the safe 1..2 range", () => {
    expect([1, 2]).toContain(routerMaxLoaded());
  });
});
