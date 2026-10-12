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

  // ── §4 可逆性是**声明**，不是靠关键词猜（docs/ARCHITECTURE_IMPROVEMENTS.md §4）──────
  it("§4 声明 irreversible:false ⇒ 含 checkout 的步不再问人（白跑不留后果，这是模型可被放开的依据）", async () => {
    install(fakeAgent((crit) => {
      const r = refWith(crit, "[test=checkout]") ?? firstRef(crit);
      return r ? { choice: r, confidence: 0.9 } : null;
    }));
    const asked: string[] = [];
    const report = await mw({ maxSteps: 2, confirmFn: (d) => { asked.push(d); return false; } }).run(
      "proceed to checkout", fixture("bench", "fixtures", "shop_cart.html"),
      {
        page: asPage(), pw, verbose: false, goalSignalFn: () => true,
        effect: { irreversible: false },
      },
    );
    expect(asked).toEqual([]);            // 同一条 desc，今天会被 "checkout" 关键词判风险
    expect(report.done).toBe(true);
  }, 60_000);

  it("§4 声明 irreversible:true ⇒ 良性步也要问人（声明优先于关键词与模型票）", async () => {
    install(fakeAgent((crit) => {
      const r = refWith(crit, "[test=add-to-cart]") ?? firstRef(crit);
      return r ? { choice: r, confidence: 0.9 } : null;
    }));
    const asked: string[] = [];
    // maxSteps=1：一次尝试就够——声明作用于**整个子目标**，所以换到的每个候选都会问；
    // 断言要的是"良性 desc 也被问了"，不是"只问一次"。
    const report = await mw({ maxSteps: 1, confirmFn: (d) => { asked.push(d); return false; } }).run(
      "add the wireless mouse to the cart", fixture("testpages", "product.html"),
      {
        page: asPage(), pw, verbose: false,
        goalSignalFn: (p) => checkSignal(p, { css_text_contains: ["[data-test='cart-count']", "1"] }),
        effect: { irreversible: true },
      },
    );
    expect(asked).toHaveLength(1);        // "Add to cart" 不含任何破坏性关键词
    expect(asked[0]).toContain("Add to cart");
    expect(report.done).toBe(false);      // 人说了不 ⇒ 这一步不落地
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

  it("⑨ a plan hint that matches nothing falls through to LAYA, never to token guessing", async () => {
    // Measured live on the en.wikipedia search page (which served an error shell, so
    // the plan's `#searchInput` was absent): `navRule` ran FIRST and token-matched 18
    // slot-less fields, each forbidden and re-picked inside ONE step, then laya
    // clicked junk -> `max_steps` after 22 steps. A hint is authoritative: when it
    // matches nothing the documented fall-through is the MODEL.
    let calls = 0;
    install(scriptedAgent((key, _s, questions) => {
      calls += 1;
      if (key === "act") {
        const crit = (questions["act"]?.criteria ?? {}) as Record<string, string>;
        return { choice: Object.keys(crit)[0]!, probabilities: {}, confidence: 0.9 };
      }
      if (key === "r") return { noul: 0.0 };
      if (key === "d") return { noul: 0.0 };
      return undefined;
    }));
    const report = await mw({ maxSteps: 1 }).run(
      "add the wireless mouse to the shopping cart", fixture("testpages", "product.html"),
      { page: asPage(), pw, verbose: false, goalSignalFn: () => false, targetHint: "#no-such-id" },
    );
    expect(report.steps.some((s) => s.method === "laya")).toBe(true);
    expect(report.steps.some((s) => s.method === "rule:match")).toBe(false);
    expect(calls).toBeGreaterThan(0);
  }, 60_000);

  it("⑨b a matching hint still resolves by rule, with the model never asked to pick", async () => {
    const acts: string[] = [];
    install(scriptedAgent((key, _s, questions) => {
      if (key === "act") {
        acts.push("act");
        const crit = (questions["act"]?.criteria ?? {}) as Record<string, string>;
        return { choice: Object.keys(crit)[0]!, probabilities: {}, confidence: 0.9 };
      }
      if (key === "r") return { noul: 0.0 };
      if (key === "d") return { noul: 0.0 };
      return undefined;
    }));
    const report = await mw({ maxSteps: 1 }).run(
      "add the wireless mouse to the shopping cart", fixture("testpages", "product.html"),
      { page: asPage(), pw, verbose: false, goalSignalFn: () => false, targetHint: "[data-test=add-to-cart]" },
    );
    expect(report.steps[0]!.method).toBe("rule:match");
    expect(acts).toHaveLength(0);          // the pick never reached the model
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

  it("⑤b advances an ordered hint whose element went dead and RESOLVES the next one in the same step", async () => {
    // Live shape (saucedemo.com's burger menu): the first action is a CSS-only change,
    // so its pre/post snapshot is identical and the loop calls it `inert` — forbidding
    // that element. The hint list is the plan's own answer to "this action is done";
    // advancing it without re-resolving handed the NEXT action to the model, and in
    // rules-only mode blocked a subgoal whose target the list named all along.
    let picks = 0;
    install(fakeAgent(() => { picks += 1; return null; }));   // abstains; must never be needed
    const report = await mw({ maxSteps: 4 }).run(
      "open the panel and confirm", dataUrl(`<html><body><main><h1>Panel</h1>
        <button id="open" onclick="document.getElementById('panel').style.transform='translateX(0)'">Open panel</button>
        <div id="panel" style="transform:translateX(-400px)">Panel body</div>
        <button id="confirm" onclick="document.getElementById('out').textContent='confirmed'">Confirm</button>
        <p id="out"></p></main></body></html>`),
      {
        page: asPage(), pw, verbose: false,
        targetHints: ["#open", "#confirm"],
        goalSignalFn: (p) => checkSignal(p, { css_text_contains: ["#out", "confirmed"] }),
      },
    );

    expect(report.done).toBe(true);
    expect(report.stop_reason).toBe("dom goal signal");
    expect(report.steps).toHaveLength(2);
    expect(report.steps[0]).toMatchObject({ step: 1, how: "clicked", method: "rule:match", inert: true });
    expect(report.steps[1]).toMatchObject({ step: 2, how: "clicked", method: "rule:match", executed: true });
    expect(String(report.steps[1]!.desc)).toContain("Confirm");
    expect(picks).toBe(0);          // every step was decided by the ordered hint
  }, 60_000);

  it("⑤c gives a done-signal a bounded settle window after an action (client-side re-render)", async () => {
    // Live shape (saucedemo "Back to products"): the click returns before the app
    // re-renders, so one immediate check sees the OLD page — measured 30-230 ms.
    // With no window the step looked `inert`, the signal never fired and the loop
    // asked the model for a target the action had already removed.
    let picks = 0;
    install(fakeAgent(() => { picks += 1; return null; }));
    const report = await mw({ maxSteps: 3 }).run(
      "confirm the delayed change", dataUrl(`<html><body><main><h1>Delayed</h1>
        <button data-test="delayed" onclick="setTimeout(() => { document.getElementById('out').textContent='confirmed'; }, 260)">Confirm</button>
        <p id="out"></p></main></body></html>`),
      {
        page: asPage(), pw, verbose: false,
        targetHint: "[data-test=delayed]",
        goalSignalFn: (p) => checkSignal(p, { css_text_contains: ["#out", "confirmed"] }),
      },
    );

    expect(report.done).toBe(true);
    expect(report.stop_reason).toBe("dom goal signal");
    expect(report.steps).toHaveLength(1);
    expect(picks).toBe(0);
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

  it("⑩b retries a SLOW-but-unblocked element with a longer budget instead of banning it", async () => {
    // Live shape (saucedemo's burger sidebar): Playwright will not commit a click on
    // a moving element. The hit-test says nothing covers it, so the short probe was
    // simply too short — reporting `action-timeout` FORBIDS the ref for the rest of
    // the subgoal, which is how the long flow lost its last ordered hint target.
    await page.goto(dataUrl(`<html><body><main><h1>Sliding</h1>
      <div id="wrap" style="transform:translateX(10px);transition:transform 1200ms linear">
        <button data-test="slide" onclick="document.getElementById('out').textContent='clicked'">Slide</button>
      </div><p id="out"></p></main>
      <script>requestAnimationFrame(() => { document.getElementById('wrap').style.transform = 'translateX(140px)'; });</script>
      </body></html>`));
    await new Promise((r) => setTimeout(r, 150));        // mid-transition: in viewport, still moving
    const elems = await extractElements(page as unknown as Parameters<typeof extractElements>[0], false);
    const el = Object.values(elems).find((e) => e.data_test === "slide")!;
    expect(el).toBeDefined();

    // a 0.2 s probe cannot click it; the longer retry waits the motion out
    expect(await mw().occludedReason(asPage(), el, 200, 2500)).toBe("__clicked__");
    expect(await page.locator("#out").innerText()).toBe("clicked");
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


describe("riskAsk（§W1：批模式下这次前向的答案本来就被丢掉，要省就声明着省）", () => {
  const riskyVoter = (): void => install(fakeAgent(() => ({ choice: "e1", confidence: 0.9 }), 0.95));

  it("默认 always：非关键词动作也问一次模型，命中阈值就问人", async () => {
    riskyVoter();
    const asked: string[] = [];
    await mw({ maxSteps: 1, confirmFn: (d) => { asked.push(d); return false; } }).run(
      "add the wireless mouse to the cart", fixture("testpages", "product.html"),
      { page: asPage(), pw, verbose: false, goalSignalFn: () => false },
    );
    expect(asked.length).toBe(1);              // 模型票 0.95 ≥ 0.6 ⇒ 问人
  }, 60_000);

  it("声明 rules-only：同样的模型票不再花前向，而关键词命中仍然拦", async () => {
    riskyVoter();
    const asked: string[] = [];
    await mw({
      maxSteps: 1, riskAsk: "rules-only",
      confirmFn: (d) => { asked.push(d); return false; },
    }).run("add the wireless mouse to the cart", fixture("testpages", "product.html"),
      { page: asPage(), pw, verbose: false, goalSignalFn: () => false });
    expect(asked).toEqual([]);                 // 良性动作：不问了

    const asked2: string[] = [];
    await mw({ maxSteps: 2, riskAsk: "rules-only", confirmFn: (d) => { asked2.push(d); return false; } }).run(
      "proceed to checkout", fixture("bench", "fixtures", "shop_cart.html"),
      { page: asPage(), pw, verbose: false, goalSignalFn: () => false });
    expect(asked2.length).toBe(1);             // "checkout" 命中关键词 ⇒ 规则照样拦，没放松
    expect(asked2[0]).toContain("Proceed to checkout");
  }, 90_000);
});

/* ── §2 决策接口：一次提案必须带"问法形状"，不能只给一个 float ───────────── */
describe("pickProposal（ARCHITECTURE_IMPROVEMENTS §2：conf 是两把尺子，形状要进接口）", () => {
  /** 装一个能回**多条概率**的运行时（fakeAgent 会把概率塌成一条，测不出形状）。 */
  const installProbs = (answer: Record<string, unknown>, passthrough: boolean): void => {
    installLayaRuntime({
      async load() { return null as never; },
      embedFnFromAgent() { return null; },
      async predictShortlist(_a: unknown, _s: unknown, questions: Record<string, unknown>) {
        const labels = Object.keys(((questions["act"] as { criteria?: object })?.criteria) ?? {});
        return {
          answers: { act: { type: "choice", ...answer } },
          shortlist: { act: { passthrough: passthrough || labels.length <= 8 } },
        };
      },
    } as never);
  };

  it("passthrough：shape=full，entropyConf 与 pickElement 的 conf 同值；margin = p1 − p2", async () => {
    installProbs({ choice: "e1", confidence: 0.42, probabilities: { e1: 0.5, e2: 0.1 } }, true);
    const prop = await mw().pickProposal("x", asPage(), { e1: {}, e2: {}, e3: {} } as never, new Set());
    expect(prop.shape.kind).toBe("full");
    expect(prop.shape.options).toBe(2);
    expect(prop.pTop1).toBeCloseTo(0.5);
    expect(prop.pTop2).toBeCloseTo(0.1);
    expect(prop.margin).toBeCloseTo(0.4);
    expect(prop.entropyConf).toBeCloseTo(0.42);
    // 三元组视图必须给出**同一个** conf：默认口径一位字节都没动
    const [ref, conf] = await mw().pickElement("x", asPage(), { e1: {}, e2: {}, e3: {} } as never, new Set());
    expect(ref).toBe("e1");
    expect(conf).toBeCloseTo(0.42);
  }, 60_000);

  it("shortlist：conf 是子集 max(probs)，形状必须被标出来（不许与 full 混比）", async () => {
    // 短名单只在**池子 > k=8** 时才生效——所以夹具要给 10 个元素，否则测的是 passthrough。
    installProbs({ choice: "e1", confidence: 0.99, probabilities: { e1: 0.31, e2: 0.22 } }, false);
    const ten = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`e${i + 1}`, {}]));
    const prop = await mw().pickProposal("x", asPage(), ten as never, new Set());
    expect(prop.shape.kind).toBe("shortlist");
    expect(prop.entropyConf).toBeCloseTo(0.31);   // 不是熵！这就是两支尺子的差别所在
    expect(prop.margin).toBeCloseTo(0.09);
  }, 60_000);

  it("没有概率的运行时：pTop/margin 为 null，绝不出现 -Infinity", async () => {
    installProbs({ choice: "e1", confidence: 0.7 }, true);
    const prop = await mw().pickProposal("x", asPage(), { e1: {} } as never, new Set());
    expect(prop.pTop1).toBeNull();
    expect(prop.margin).toBeNull();
    expect(Number.isFinite(prop.entropyConf)).toBe(true);
  }, 60_000);

  it("§2 答了但没给出可用元素 ⇒ choiceRef 归一成 null，而 pickElement 必须**保留 undefined**", async () => {
    // 这条测试存在的理由：本轮把 `a.choice ?? null` 写进内核，调用方就再也分不出
    // "答了但没可用元素"（该说人话：hint 没命中 / 这一步没点名）与"根本没答"
    // （action space exhausted），两条 UX 测试当场打红。区别是承重的。
    installLayaRuntime({
      async load() { return null as never; },
      embedFnFromAgent() { return null; },
      async predictShortlist() {
        return { answers: { act: { type: "choice", confidence: 0.5 } as never }, shortlist: { act: { passthrough: true } } };
      },
    } as never);
    const prop = await mw().pickProposal("x", asPage(), { e1: {} } as never, new Set());
    expect(prop.choiceRef).toBeNull();                 // 结构化视图归一，消费方不用想这个
    const [ref] = await mw().pickElement("x", asPage(), { e1: {} } as never, new Set());
    expect(ref).toBeUndefined();                       // 三元组视图**不能**归一：调用方靠它选报错文案
  }, 60_000);

  it("动作空间耗尽：shape=none、choiceRef=null —— 『没得选』是一种结果", async () => {
    installProbs({ choice: "e9", confidence: 0.9 }, true);
    const prop = await mw().pickProposal("x", asPage(), {} as never, new Set());
    expect(prop.choiceRef).toBeNull();
    expect(prop.shape.kind).toBe("none");
  }, 60_000);
});
