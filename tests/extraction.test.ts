/**
 * Extraction-layer integration tests against the repo's own fixtures — the same
 * pages the Python suite and the bench use. Proves the port drives a real
 * browser through the repo's chromium (browser-env resolution, no download).
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import * as browserEnv from "../src/browser/browser-env.ts";
import {
  addNearContext, ariaInteractiveLines, criteriaView, elemFamily, extractElements, hintLookup,
  jsInteractiveWidgets, pageText, stateText, type Elem, type ElemPool,
} from "../src/engine/extraction.ts";
import { captureStepStateView } from "../src/model/page-context.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const fixture = (...p: string[]): string => pathToFileURL(path.join(REPO, ...p)).href;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = (await browserEnv.launch({ chromium } as never)) as unknown as Browser;
  const ctx = await browser.newContext();
  page = await ctx.newPage();
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

describe("extractElements — one JS pass over a real page", () => {
  it("finds the fixture's controls, labels them and stamps data-dshref", async () => {
    await page.goto(fixture("testpages", "product.html"));
    const elems = await extractElements(page);

    const byTest = (t: string): Elem | undefined => Object.values(elems).find((e) => e.data_test === t);
    expect(byTest("add-to-cart")!.label).toBe("Add to cart");
    expect(byTest("search-box")!.label).toContain("Search products");   // placeholder fallback
    expect(Object.keys(elems).every((k) => /^e\d+$/.test(k))).toBe(true);
    // the stamp is what _locatorFor uses first: element identity is single-sourced
    expect(await page.locator("[data-dshref]").count()).toBeGreaterThan(0);
  }, 60_000);

  it("namespaces child-frame elements (frames are first-class)", async () => {
    await page.goto(fixture("bench", "fixtures", "frames_parent.html"));
    const elems = await extractElements(page);
    const childRefs = Object.keys(elems).filter((r) => r.startsWith("f1:"));
    expect(childRefs.length).toBeGreaterThan(0);
    expect(elems[childRefs[0]!]!.frame).toBe(1);
    // the iframe form is where the actionable field lives; the parent sees nothing
    expect(Object.values(elems).some((e) => e.frame === 1 && e.tag === "input")).toBe(true);
  }, 60_000);

  it("recovers a plan-named target the budget evicted (hintLookup + data-hintref stamp)", async () => {
    await page.goto(fixture("testpages", "product.html"));
    const hits = await hintLookup(page, "add-to-cart");
    expect(Object.keys(hits).length).toBeGreaterThan(0);
    expect(Object.values(hits).some((e) => e.data_test === "add-to-cart")).toBe(true);
    expect(await page.locator("[data-hintref]").count()).toBeGreaterThan(0);
  }, 60_000);
});

describe("synthetic pages — the paths the fixtures cannot express", () => {
  it("CDP probe finds a listener-only <div> the CSS scan cannot see", async () => {
    // setContent keeps the CURRENT document URL, and the probe caches per URL —
    // start from a clean about:blank so the cache cannot answer for us.
    await page.goto("about:blank");
    await page.setContent(`<html><body><div id="save">Save draft</div>
      <script>document.getElementById('save').addEventListener('click', () => {});</script>
      </body></html>`);
    const widgets = await jsInteractiveWidgets(page, 10, 150, 2.0);
    expect(widgets.length).toBeGreaterThan(0);
    const w = widgets[0] as Record<string, unknown>;
    expect(w.tag).toBe("div");
    expect(w.label).toBe("Save draft");
    expect((w.js_events as string[])).toContain("click");

    // …and it joins the normal scan through the data-js-ref stamp
    const elems = await extractElements(page);
    expect(Object.values(elems).some((e) => (e.label ?? "").includes("Save draft"))).toBe(true);
  }, 60_000);

  it("addNearContext gives identical grid buttons their container identity line", async () => {
    await page.goto("about:blank");
    await page.setContent(`<html><body><main>
      <div class="card"><h3>Sauce Labs Onesie</h3><button>Add to cart</button></div>
      <div class="card"><h3>Sauce Labs Backpack</h3><button>Add to cart</button></div>
      </main></body></html>`);
    const elems = await extractElements(page, false);   // probe not under test here
    const dupes = Object.values(elems).filter((e) => e.label === "Add to cart");
    expect(dupes.length).toBe(2);
    const nears = dupes.map((e) => e.near);
    expect(nears.filter(Boolean).length).toBeGreaterThan(0);
    // and the criteria view surfaces them (duplicate strings are zero-information)
    const view = criteriaView(elems, new Set(), null);
    expect(Object.values(view).some((v) => v.includes("[near="))).toBe(true);
  }, 60_000);

  it("keeps an inline anchor that WRAPS A BLOCK (any non-zero rect, not just the first)", async () => {
    // The live shape, measured on saucedemo.com's inventory: every product title is
    // `<a data-test="item-2-title-link"><div>Sauce Labs Onesie</div></a>`. An inline
    // anchor's own inline boxes report 0x0 FIRST and the wrapped block box after it,
    // so the old `rects[0]` test dropped all six title links (pool 25/31) — the
    // element a human clicks was invisible to both the model and hint matching.
    await page.goto("about:blank");
    await page.setContent(`<html><body><main>
      <a href="#" data-test="card-title"><div class="name">Sauce Labs Onesie</div></a>
      <a href="#" id="zero" style="display:inline-block;width:0;height:0;overflow:hidden">not actionable</a>
      </main></body></html>`);
    const elems = await extractElements(page, false);
    const values = Object.values(elems);
    expect(values.some((e) => e.data_test === "card-title")).toBe(true);
    // …while a genuinely 0x0 box is still rejected: Wikipedia's collapsed language
    // sidebar passes checkVisibility() but Playwright refuses to click it.
    expect(values.some((e) => e.id === "zero")).toBe(false);
  }, 60_000);
});

describe("views", () => {
  it("ariaInteractiveLines renders role names for the same element space", async () => {
    await page.goto(fixture("testpages", "product.html"));
    const elems = await extractElements(page);
    const aria = await ariaInteractiveLines(page);
    expect(aria).not.toBeNull();
    expect(aria!.length).toBeGreaterThan(0);
    // hybrid view: role from aria, our label/attrs kept
    const view = criteriaView(elems, new Set(), aria);
    expect(Object.values(view).some((v) => /^(button|link|textbox|searchbox|combobox) "/.test(v))).toBe(true);
  }, 60_000);

  it("pageText ships head+tail; stateText packs query-matching lines", async () => {
    await page.goto(fixture("testpages", "product.html"));
    const pt = await pageText(page, 60, 40);
    expect(pt.length).toBeGreaterThan(0);
    const st = await stateText(page, "wireless mouse add to cart", null, 320);
    expect(st.length).toBeGreaterThan(0);
    expect(st.toLowerCase()).toContain("wireless");
    expect(st.length).toBeLessThanOrEqual(400);
  }, 60_000);
});

describe("criteriaView — hybrid rendering rules (unit)", () => {
  const el = (ref: string, scan: number, tag: string, label: string, extra: Partial<Elem> = {}): Elem =>
    ({ ref, scan, tag, label, data_test: "", href: "", ...extra });
  const pool = (...es: Elem[]): ElemPool => Object.fromEntries(es.map((e) => [e.ref!, e]));

  it("orders by scan, skips forbidden refs and appends [test=] / -> href", () => {
    const elems = pool(
      el("e1", 5, "button", "Buy", { data_test: "buy", href: "" }),
      el("e0", 1, "a", "Home", { href: "shop/index" }),
    );
    const view = criteriaView(elems, new Set(["e0"]), null);
    expect(Object.keys(view)).toEqual(["e1"]);
    expect(view.e1).toBe('button "Buy" [test=buy]');
  });

  it("uses aria roles when aligned, and shows the selected option for a <select>", () => {
    const elems = pool(el("e0", 0, "input", "Quantity"), el("e1", 1, "select", "Economy"));
    const aria: Array<[string, string]> = [["spinbutton", ""], ["combobox", "Business"]];
    const view = criteriaView(elems, new Set(), aria);
    expect(view.e0).toBe('spinbutton "Quantity"');
    expect(view.e1).toBe('select "Business" [now=Economy]');
  });

  it("falls back per-element when the aria line count drifts", () => {
    const elems = pool(el("e0", 0, "button", "Go"));
    const view = criteriaView(elems, new Set(), [["button", "Go"], ["link", "Extra"]]);
    expect(view.e0).toBe('button "Go"');
  });
});

/* ------------------------- 元素族分类：语义角色优先（结构族 ≠ 语义动作） */

describe("elemFamily — 语义角色优先于标签结构（2026-10-18 推敲）", () => {
  const el = (x: Partial<Elem> & { tag: string }): Elem => x as Elem;
  it("ARIA 角色覆盖标签结构：combobox/listbox→select、checkbox/switch→check、textbox→fill", () => {
    expect(elemFamily(el({ tag: "div", role: "combobox", label: "出发城市" }))).toBe("select");
    expect(elemFamily(el({ tag: "span", role: "listbox", label: "日期" }))).toBe("select");
    expect(elemFamily(el({ tag: "div", role: "checkbox", label: "同意" }))).toBe("check");
    expect(elemFamily(el({ tag: "span", role: "switch", label: "开关" }))).toBe("check");
    expect(elemFamily(el({ tag: "div", role: "textbox", label: "城市" }))).toBe("fill");
    expect(elemFamily(el({ tag: "div", role: "searchbox", label: "搜索" }))).toBe("fill");
    expect(elemFamily(el({ tag: "div", content_editable: true, label: "备注" }))).toBe("fill");
  });
  it("原生标签照旧（未出现语义角色时行为不变）：select/checkbox/radio/submit/textarea/button/anchor", () => {
    expect(elemFamily(el({ tag: "select" }))).toBe("select");
    expect(elemFamily(el({ tag: "input", input_type: "checkbox" }))).toBe("check");
    expect(elemFamily(el({ tag: "input", input_type: "radio" }))).toBe("check");
    expect(elemFamily(el({ tag: "input", input_type: "submit" }))).toBe("click");
    expect(elemFamily(el({ tag: "input", input_type: "button" }))).toBe("click");
    expect(elemFamily(el({ tag: "input", input_type: "range" }))).toBe("fill");
    expect(elemFamily(el({ tag: "textarea" }))).toBe("fill");
    expect(elemFamily(el({ tag: "button" }))).toBe("click");
    expect(elemFamily(el({ tag: "a" }))).toBe("click");
  });
  it("采集：显式 role / contenteditable 条件落字段（没这些属性的元素不加字段 ⇒ 冻结对拍语料不变）", async () => {
    await page.goto("about:blank");
    await page.setContent(`<html><body><main>
      <div role="combobox" aria-label="出发城市" tabindex="0">北京</div>
      <div contenteditable="true" aria-label="备注">写点什么</div>
      <button>普通按钮</button>
      </main></body></html>`);
    const elems = await extractElements(page, false);
    const values = Object.values(elems);
    const combo = values.find((e) => e.role === "combobox")!;
    expect(combo).toBeDefined();
    expect(elemFamily(combo)).toBe("select");
    const ce = values.find((e) => e.content_editable === true)!;
    expect(ce).toBeDefined();
    expect(elemFamily(ce)).toBe("fill");
    // 没有 role/contenteditable 的元素不带这些键（缺省等价；对拍语料逐字节不变）
    const plain = values.find((e) => e.tag === "button")!;
    expect(plain.role).toBeUndefined();
    expect(plain.content_editable).toBeUndefined();
  }, 60_000);
  it("页面上下文摘要按语义族分组：combobox 归入下拉、contenteditable 归入输入框", async () => {
    await page.goto("about:blank");
    await page.setContent(`<html><body><main>
      <div role="combobox" aria-label="出发城市" tabindex="0">北京</div>
      <div contenteditable="true" aria-label="备注">写点什么</div>
      <button>提交</button>
      </main></body></html>`);
    const state = await captureStepStateView(page as never);
    expect(state.affordances.selects.some((x) => x.includes("出发城市"))).toBe(true);
    expect(state.affordances.text_inputs.some((x) => x.includes("备注"))).toBe(true);
    expect(state.affordances.clickables.some((x) => x.includes("提交"))).toBe(true);
  }, 60_000);
});
