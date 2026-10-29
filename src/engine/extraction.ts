/**
 * Extraction layer: turn a live page into the model-facing element space.
 *
 * TS twin of `layaapp/extraction.py`. Owns everything between "a Playwright page
 * exists" and "here is the element pool, its labels, its handles and the JS passes
 * that keep them consistent": interactive discovery (one JS pass, over same-origin
 * frames and open shadow roots), the aria/criteria views, the CDP listener probe
 * for JS-only widgets, target_hint recovery, element signatures and frame scope.
 * No decisions and no execution.
 *
 * The JS bodies are RAW strings (String.raw): writing `\\s` here would reach the
 * browser as a literal backslash class — that exact bug silently broke
 * hint_lookup's multi-word labels in the Python version.
 */

import { parseHint, type ParsedHint } from "./hint.ts";

/* ------------------------------------------------------------------ element model */

export interface Elem {
  ref?: string;
  scan?: number;
  tag: string;
  label: string;
  data_test?: string;
  name?: string;
  id?: string;
  input_type?: string;
  href?: string;
  /** 显式 ARIA 角色（`getAttribute('role')`；没有就不出现——对拍语料逐字节不变）。 */
  role?: string;
  /** `contenteditable` 为真（语义上是"可填"，结构上不是 input/textarea）。 */
  content_editable?: boolean;
  near?: string;
  frame?: number;
  js_events?: unknown;
  js_ref?: string;
  dsh_ref?: string;
  [k: string]: unknown;
}
export type ElemPool = Record<string, Elem>;

/**
 * 元素**动作族**（S2 ③ 运行期接线 + 页面状态采集共用）。
 *
 * 判据与执行器自己的分类**同一份**（`_isCheckable` / `_isTyping` / `_isSubmit`）：
 *   - check：input[type=checkbox|radio]
 *   - select：`<select>`
 *   - fill：input/textarea（不含 submit/button/checkbox/radio）
 *   - click：其余（a / button / input[type=submit|button] / 其它可点元素）
 * 为什么必须单一出处：提名指令收窄元素池时，窄出的池子必须正好是"这条指令能作用的那一族"；
 * 两处各判一次就会漂移（本仓 hint 语法漂移过两次，同一条教训）。
 */
export type ElemFamily = "click" | "fill" | "select" | "check";

export function elemFamily(e: Elem): ElemFamily {
  const type = String(e.input_type ?? "").toLowerCase();
  const role = String(e.role ?? "").toLowerCase();
  // ---- 语义角色优先（结构族 ≠ 语义动作；2026-10-18 推敲）----
  // 显式 ARIA 角色说的就是"这个控件能做什么"，比标签名可靠：
  //   role=combobox/listbox → select（div/span 做的下拉）
  //   role=checkbox/radio/switch → check
  //   role=textbox/searchbox/spinbutton → fill（自定义输入控件）
  if (role === "combobox" || role === "listbox" || role === "menulist") return "select";
  if (role === "checkbox" || role === "radio" || role === "switch") return "check";
  if (role === "textbox" || role === "searchbox" || role === "spinbutton") return "fill";
  if (e.content_editable === true) return "fill";       // contenteditable：可填，但不是 input/textarea
  // ---- 原生标签（没有显式角色时按结构与 input type 判）----
  if (e.tag === "input" && (type === "checkbox" || type === "radio")) return "check";
  if (e.tag === "select") return "select";
  if (role === "button" || role === "link") return "click";
  if ((e.tag === "input" || e.tag === "textarea") && type !== "submit" && type !== "button") return "fill";
  return "click";
}

/**
 * 元素能力面：同一条结构化规则给出"它到底能做什么"。
 * `elemFamily` 仍然是提名/修复用的单一动作族；`actionCapabilities` 面向 PoolView/inspect，
 * 可以表达 role=slider / input[type=range] 这类特殊控件。注意：native range 目前
 * 可由引擎的 `fill` 动作驱动；div[role=slider] 仍是 click 族，当前动作集不能设 aria-valuenow。
 */
export type ActionCapability = "click" | "fill" | "select" | "check" | "slider" | "scroll" | "drag";

/** 执行动作所需的最小 locator 面；由执行器/PoolView 的调用方提供。 */
export interface ActionLocatorLike {
  click(opts?: Record<string, unknown>): Promise<void>;
  fill(value: string, opts?: Record<string, unknown>): Promise<void>;
  selectOption(value: unknown, opts?: Record<string, unknown>): Promise<void>;
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
}

/**
 * ActionAdapter：把"元素能做什么"从动作散布改成显式能力面。
 * `canApply` 是 PoolView / inspect 的静态能力判定；`apply` 是执行器未来接入的同一能力面。
 * 模型不能发明动作；它只能点能力面里已声明的 kind。
 */
export interface ActionAdapter {
  kind: ActionCapability;
  canApply(e: Elem): boolean;
  apply(loc: ActionLocatorLike, opts?: { value?: string; timeoutMs?: number }): Promise<[string, unknown]>;
}

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const CLICK_ADAPTER: ActionAdapter = {
  kind: "click",
  canApply: (e) => elemFamily(e) === "click",
  async apply(loc, { timeoutMs = 5000 } = {}) {
    await loc.click({ timeout: timeoutMs });
    return ["clicked", null];
  },
};

const CHECK_ADAPTER: ActionAdapter = {
  kind: "check",
  canApply: (e) => elemFamily(e) === "check",
  async apply(loc, { timeoutMs = 5000 } = {}) {
    await loc.click({ timeout: timeoutMs });
    return ["clicked", null];
  },
};

const FILL_ADAPTER: ActionAdapter = {
  kind: "fill",
  canApply: (e) => elemFamily(e) === "fill",
  async apply(loc, { value, timeoutMs = 5000 } = {}) {
    if (value === undefined || value === null) return ["needs_value", null];
    await loc.fill(String(value), { timeout: timeoutMs });
    return ["filled", value];
  },
};

const SELECT_ADAPTER: ActionAdapter = {
  kind: "select",
  canApply: (e) => elemFamily(e) === "select",
  async apply(loc, { value, timeoutMs = 5000 } = {}) {
    if (value === undefined || value === null) return ["needs_value", null];
    try {
      await loc.selectOption({ label: String(value) }, { timeout: Math.min(1500, timeoutMs) });
    } catch {
      await loc.selectOption({ value: String(value) }, { timeout: timeoutMs });
    }
    return ["filled", value];
  },
};

const SLIDER_ADAPTER: ActionAdapter = {
  kind: "slider",
  canApply: (e) => String(e.role ?? "").toLowerCase() === "slider"
    || (e.tag === "input" && String(e.input_type ?? "").toLowerCase() === "range"),
  async apply(loc, { value, timeoutMs = 5000 } = {}) {
    if (value === undefined || value === null) return ["needs_value", null];
    await loc.fill(String(value), { timeout: timeoutMs });
    return ["filled", value];
  },
};

const DRAG_ADAPTER: ActionAdapter = {
  kind: "drag",
  canApply: (e) => e.draggable === true
    || String(e.role ?? "").toLowerCase() === "slider"
    || (e.tag === "input" && String(e.input_type ?? "").toLowerCase() === "range"),
  async apply(loc, { value, timeoutMs = 5000 } = {}) {
    if (value === undefined || value === null || !String(value).trim()) return ["needs_value", null];
    const dragTo = (loc as unknown as { dragTo?: (target: unknown, o?: unknown) => Promise<void> }).dragTo;
    if (typeof dragTo !== "function") return ["action_unsupported", "locator has no dragTo"];
    await dragTo.call(loc, { selector: String(value) }, { timeout: timeoutMs });
    return ["dragged", value];
  },
};

const SCROLL_ADAPTER: ActionAdapter = {
  kind: "scroll",
  canApply: () => true,   // scrollIntoView 是 viewport 语义，任何已定位元素都可用
  async apply(loc) {
    await loc.evaluate(String.raw`(el) => {
      if (typeof el.scrollIntoViewIfNeeded === 'function') el.scrollIntoViewIfNeeded({ block: 'center', behavior: 'instant' });
      else el.scrollIntoView({ block: 'center', behavior: 'instant' });
    }`);
    return ["scrolled", null];
  },
};

export const ACTION_ADAPTERS: readonly ActionAdapter[] = [
  DRAG_ADAPTER, SCROLL_ADAPTER, SLIDER_ADAPTER, CHECK_ADAPTER, SELECT_ADAPTER, FILL_ADAPTER, CLICK_ADAPTER,
];

export function actionCapabilities(e: Elem): ActionCapability[] {
  const out: ActionCapability[] = [];
  for (const adapter of ACTION_ADAPTERS) if (adapter.canApply(e) && !out.includes(adapter.kind)) out.push(adapter.kind);
  return out;
}

/** 按动作族过滤元素池（**只用于有界修复**；ref 保留原值）。 */
export function filterElemsByFamily(elems: ElemPool, family: ElemFamily): ElemPool {
  const out: ElemPool = {};
  for (const [ref, e] of Object.entries(elems)) if (elemFamily(e) === family) out[ref] = e;
  return out;
}

/**
 * 按动作族**排序**元素池（不丢信息）：该族在前、其余在后。
 *
 * 这是"提名族作为**软先验**"的载体——各族元素都还在候选里（其他族的元素既可能是真目标，
 * 也可能是解出目标的上下文：`div[role=combobox]` 是 click 族却是 select、`contenteditable`
 * 是 click 族却是 fill、`input[type=range]` 是 fill 族却是设值），排序只让该族优先被规则/模型看到。
 * 结构族 ≠ 语义动作，所以**不能**拿它硬过滤。
 */
export function orderElemsByFamily(elems: ElemPool, family: ElemFamily): ElemPool {
  const first: ElemPool = {};
  const rest: ElemPool = {};
  for (const [ref, e] of Object.entries(elems)) {
    if (elemFamily(e) === family) first[ref] = e;
    else rest[ref] = e;
  }
  return { ...first, ...rest };
}

/**
 * Element signature for stale-forbidden pruning. refs are POSITIONAL
 * (re-indexed on every scan), so after a DOM change a held `e0` can name a
 * different element than when it was forbidden — an overlay case proved
 * that poisons healthy elements.
 */
export function esig(e: Elem): [string, string, string] {
  return [e.tag, e.label, (e.data_test as string) ?? ""];
}

/**
 * Resolve a target_hint hit set: one hit is unambiguous, none is a miss, and
 * several are decidable when they are indistinguishable on (tag, label, href,
 * data_test) — bbc.com ships two identical `/news` links, either satisfies the
 * goal. Genuinely different candidates return null and defer to laya.
 */
export function firstIfSame(hits: Iterable<string>, elems: ElemPool): string | null {
  const list = [...hits];
  if (list.length === 1) return list[0]!;
  if (list.length === 0) return null;
  const sigs = new Set(list.map((r) => JSON.stringify([
    elems[r]!.tag, elems[r]!.label, (elems[r]!.href as string) ?? "", (elems[r]!.data_test as string) ?? "",
  ])));
  if (sigs.size !== 1) return null;
  return list.reduce((best, r) => ((elems[r]!.scan ?? 0) < (elems[best]!.scan ?? 0) ? r : best));
}

const SLOT_RE = /([A-Za-z_][\p{L}\p{N}_-]*)\s*[=:：]\s*([^\s,，。;；]+)/gu;

/**
 * Pull `key=value` slots out of the instruction. Python's `\w` is Unicode-aware,
 * so the port uses [`\p{L}\p{N}_`] instead of JS's ASCII-only `\w`; duplicate
 * keys: last wins (dict-comprehension semantics).
 */
export function extractSlots(instruction: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of instruction.matchAll(SLOT_RE)) out[m[1]!] = m[2]!;
  return out;
}

/* ------------------------------------------------------------------ page shapes */

export interface InnerLoc {
  innerText(opts?: { timeout?: number }): Promise<string> | string;
  inputValue(opts?: { timeout?: number }): Promise<string> | string;
  /** 读属性（Playwright Locator.getAttribute 的同一语义：不存在 → null）。可选：测试替身可能没有。 */
  getAttribute?(name: string, opts?: { timeout?: number }): Promise<string | null> | string | null;
}
export interface LocLike {
  count(): Promise<number> | number;
  /** Python exposes `.first` as a property; the Node API as a method. */
  first: InnerLoc | (() => InnerLoc);
  all?(): Promise<unknown[]>;
}

/** `.first` across both Playwright runtimes (property vs method). */
export function firstOf(loc: LocLike): InnerLoc {
  return typeof loc.first === "function" ? loc.first() : loc.first;
}
export interface FrameLike {
  locator(selector: string): LocLike & { all?(): Promise<unknown[]> };
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
  url?: string | (() => string);
}
export interface PageLike {
  /** Python's Playwright exposes `page.url` as a property; the Node API as a method. */
  url: string | (() => string);
  frames?: FrameLike[] | (() => FrameLike[]);
  locator?(selector: string): LocLike & { all?(): Promise<unknown[]> };
  evaluate?(fn: unknown, arg?: unknown): Promise<unknown>;
  context?: unknown;
  locatorAnyFrame?(selector: string): LocLike | null | Promise<LocLike | null>;
}

/** `page.url` across both Playwright runtimes (property vs method). */
export function urlOf(page: PageLike): string {
  return typeof page.url === "function" ? page.url() : page.url;
}

/** Main frame first, then at most `limit` child frames (ad iframes must not eat the budget). */
export function framesOf(page: PageLike, limit = 6): FrameLike[] {
  try {
    const f = typeof page.frames === "function" ? page.frames() : page.frames;
    const list = (f ?? []) as FrameLike[];
    return (list.length ? list : [page as unknown as FrameLike]).slice(0, limit);
  } catch {
    return [page as unknown as FrameLike];
  }
}

/** The frame an element came from (0 = main); undefined once it has detached. */
export function frameAt(page: PageLike, index: number): FrameLike | undefined {
  try {
    const f = typeof page.frames === "function" ? page.frames() : page.frames;
    const list = (f ?? []) as FrameLike[];
    return index >= 0 && index < list.length ? list[index] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * First matching locator across the main frame and same-origin children.
 * Signals are frequently rendered inside an iframe (a success banner, an
 * embedded form's own field), where `page.locator` never looks.
 */
export async function locatorAnyFrame(page: PageLike, selector: string): Promise<LocLike | null> {
  if (page.frames !== undefined || page.locator !== undefined) {
    for (const fr of framesOf(page)) {
      try {
        const loc = fr.locator(selector);
        if (await loc.count()) return loc;
      } catch {
        continue;   // cross-origin frame: evaluate/locator throws, skip
      }
    }
  }
  // Test doubles / non-Playwright pages may provide their own resolver.
  return (await page.locatorAnyFrame?.(selector)) ?? null;
}

/* ------------------------------------------------------------------ constants */

// 扫描面：原生可交互标签 + ARIA 语义角色/可编辑容器（自定义控件由 div/span 实现时，标签结构里
// 没有"可交互"的证据；不扫进来，语义分类与提名都无从谈起。fixtures 无这些属性 ⇒ 对拍语料不变）。
// R1 扩面：`label` 入扫描面，但延迟裁决——关联表单控件自身可见时跳过（点 label ≡ 点控件，
// 避免同控件双份候选）；控件不可见或无关联时保留（此时 label 是唯一可点击面）。
export const INTERACTIVE = "a, button, input, select, textarea, label, [onclick], [role='button']"
  + ", [role='combobox'], [role='listbox'], [role='textbox'], [role='searchbox'], [role='spinbutton']"
  + ", [role='checkbox'], [role='radio'], [role='switch'], [role='slider'], [contenteditable='true'], [contenteditable='']"
  + ", [draggable='true']";
/** CDP-probed JS-only widgets join every later scan, keeping refs consistent. */
export const INTERACTIVE_ALL = INTERACTIVE + ", [data-js-ref]";
export const MAX_ELEMENTS = 40;
/**
 * 低置信恢复路径宽扫的元素预算（executor 的 ONE wider look；R2 起同通道展开
 * 启发式伪按钮候选）。单一出处：executor 与 inspect --wide 共用。
 */
export const WIDE_POOL_ELEMENTS = 120;

/** Roles the accessibility snapshot renders as interactive leaves. */
export const ARIA_INTERACTIVE_ROLES = [
  "button", "link", "textbox", "combobox", "checkbox", "radio", "searchbox",
  "spinbutton", "menuitem", "switch", "slider", "tab",
];
const ARIA_LINE_RE = new RegExp(`^\\s*-\\s+(${ARIA_INTERACTIVE_ROLES.join("|")})(?:\\s+"([^"]*)")?`);

export const CUSTOM_WIDGET_TAGS = new Set(["div", "span", "li", "td", "img", "svg", "i", "p", "article"]);
export const CLICKY_EVENTS = new Set(["click", "mousedown", "mouseup", "keydown", "keyup"]);
const listenerCache = new Map<string, unknown[]>();

/* ------------------------------------------------------------------ JS passes */

/** Document order, descending into open shadow roots — the one collector every JS pass shares. */
export const COLLECT_JS = String.raw`
  const __collectAll = (root, sel, out) => {
    for (const e of root.querySelectorAll(sel)) out.push(e);
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) __collectAll(e.shadowRoot, sel, out);
  };
`;

/**
 * ONE round trip for the whole page: tag, label (incl. <label>-wrapper text),
 * data-test, name, id, input type, href, visibility and the main-content flag,
 * ordered main-content-first, each winner stamped with `data-dshref` in the same
 * pass so the element list, scan index and locator handle are single-sourced.
 */
export const EXTRACT_JS = String.raw`(arg) => {
  const sel = arg.sel, max = arg.max;
  const WS = /[ \t\n\r\f\v]+/g;
  // Material/Google 的图标是 private-use 字形（\ue8ba 等），会出现在按钮文本里；
  // 它是装饰，不是人可读标签。先剥掉 PUA 再折叠空白，否则 Hotels 按钮的 label 会是
  // \ue8baHotels，ctx.hints("Hotels") 匹配不到（Google Maps 实测）。
  const norm = (t) => (t || '').replace(/[\uE000-\uF8FF]/g, '').replace(WS, ' ').trim();
  const all = [];
  __collectAll(document, sel, all);
  const labelOf = (e, tag) => {
    const first = e.childNodes.length ? String(e.childNodes[0].textContent || '') : '';
    let label = norm(e.getAttribute('aria-label') || e.getAttribute('title') || first || '');
    const text = (!label || tag === 'select') ? norm(e.innerText || '') : '';
    if (!label) label = text || e.getAttribute('placeholder') || e.getAttribute('value') || '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const own = (e.value || '').trim();
      let p = e.closest('label');
      if (!p && e.id) {
        try { p = document.querySelector('label[for="' + CSS.escape(e.id) + '"]'); } catch (err) { p = null; }
      }
      let wrapper = p ? norm(p.innerText) : '';
      if (own && wrapper.indexOf(own) === 0) wrapper = wrapper.slice(own.length).trim();
      if (!label) label = wrapper;
      else if (wrapper && wrapper !== label && label.indexOf(wrapper) === -1) label = label + ' / ' + wrapper;
    } else if (!label) {
      label = norm(e.innerText || '');
    }
    return norm(label).slice(0, 40);
  };
  const rows = [];
  const labelRows = [];   // R1a：label 延迟裁决（见下）
  const hiddenCtrls = []; // R1b：不可见表单控件的 scan 索引（见下）
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    // A NON-ZERO BOX is required, not just a layout box: Wikipedia's language
    // sidebar keeps ~349 interlanguage links inside a collapsed container, so
    // checkVisibility() is true while getBoundingClientRect() is 0x0 — Playwright
    // then refuses to click ("element is not visible") and the step died. Keep
    // this in sync with what the executor can actually act on.
    //
    // ANY rect counts, not just the FIRST one. An inline anchor wrapping a block
    // (a div holding the product title — the ordinary card-title markup) reports
    // a 0x0 rect for the inline boxes FIRST and the real block box after it: the
    // r[0] form silently dropped all six product-title links on the live
    // saucedemo.com inventory (pool 25/31), so the element every human clicks was
    // invisible to the model. Rect count is not availability either: all-zero rects
    // (the collapsed interlanguage sidebar) are still rejected.
    const hasBox = (() => {
      const r = e.getClientRects();
      for (let k = 0; k < r.length; k++) if (r[k].width > 0 && r[k].height > 0) return true;
      return false;
    })();
    let vis;
    if (e.checkVisibility) {
      vis = hasBox && e.checkVisibility({checkVisibilityCSS: true, checkOpacity: false});
    } else {
      const cs = getComputedStyle(e);
      vis = cs.display !== 'none' && cs.visibility !== 'hidden' && hasBox;
    }
    if (!vis) {
      // R1b：不可见的表单控件不直接入池，但记下来——后置为它找「可见 label wrapper」代理
      //（携程式「可见自绘 div + 隐藏 input 存值」：人点的是 div，input 自己 0x0）。
      const tg0 = e.tagName.toLowerCase();
      if (tg0 === 'input' || tg0 === 'select' || tg0 === 'textarea') hiddenCtrls.push(i);
      continue;
    }
    const tag = e.tagName.toLowerCase();
    if (tag === 'label') {
      // R1a：label 延迟裁决。关联控件可见 → 冗余，跳过；控件不可见或无关联 → 保留
      //（自定义控件包在 label 里、或控件本身被隐藏时，label 是唯一可点击面）。
      let assoc = null;
      try { assoc = e.control || null; } catch (err) { assoc = null; }
      if (!assoc) {
        const fid = e.getAttribute('for');
        if (fid) { try { assoc = document.getElementById(fid); } catch (err2) { assoc = null; } }
      }
      if (!assoc) { try { assoc = e.querySelector('input, select, textarea, button'); } catch (err3) { assoc = null; } }
      labelRows.push({ i: i, tag: tag, label: labelOf(e, tag),
        main: (!e.closest('nav, aside, footer, header') && !!e.closest('main, [role=main], article')),
        data_test: e.getAttribute('data-test') || '', name: '', id: e.id || '', input_type: '',
        role: '', content_editable: false, draggable: false, href: '', assoc: assoc });
      continue;
    }
    const label = labelOf(e, tag);
    if ((tag === 'a' || tag === 'button') && !label) continue;
    const href = e.getAttribute('href') || '';
    rows.push({i: i, tag: tag, label: label,
               main: (!e.closest('nav, aside, footer, header') && !!e.closest('main, [role=main], article')),
               data_test: e.getAttribute('data-test') || '', name: e.getAttribute('name') || '',
               id: e.id || '', input_type: (e.getAttribute('type') || '').toLowerCase(),
               role: (e.getAttribute('role') || '').toLowerCase(),
               content_editable: e.isContentEditable ? true : false,
               draggable: (e.getAttribute('draggable') || '').toLowerCase() === 'true',
               href: href ? href.split('?')[0].replace(/\/+$/, '').split('/').slice(-2).join('/') : ''});
  }
  // ---- R1a/R1b 后置裁决（都在 slice 前，占 max 预算；代理一律 non-main 排尾）----
  const idxOf = new Map();
  for (let i = 0; i < all.length; i++) idxOf.set(all[i], i);
  const stamped = new Set(rows.map((r) => r.i));
  for (const lr of labelRows) {
    if (lr.assoc) {
      const ai = idxOf.get(lr.assoc);
      if (ai !== undefined && stamped.has(ai)) continue;   // 关联控件自己已在池
      if (ai === undefined) {
        // 关联控件不在扫描结果里：只要它有可见盒就不重复入池（保险面）
        let cv = false;
        try { cv = lr.assoc.getClientRects().length > 0; } catch (err4) { cv = false; }
        if (cv) continue;
      }
    }
    rows.push(lr); stamped.add(lr.i);
  }
  // R1b：不可见表单控件 → 可见 label wrapper 代理入池（点 wrapper 等价于操作控件；
  // wrapper 一定是 label 标签，必在扫描面内，ref/stamp 机制不变）。
  const wrapperSeen = new Set();
  for (const ci of hiddenCtrls) {
    if (rows.length >= max) break;
    const e = all[ci];
    let w = null;
    try { w = e.closest('label'); } catch (err) { w = null; }
    if (!w && e.id) {
      try { w = document.querySelector('label[for="' + CSS.escape(e.id) + '"]'); } catch (err2) { w = null; }
    }
    if (!w || wrapperSeen.has(w)) continue;
    wrapperSeen.add(w);
    const wi = idxOf.get(w);
    if (wi === undefined || stamped.has(wi)) continue;   // wrapper 已在池（R1a 保留的 label 行即是）
    const wb = (() => { const r = w.getClientRects(); for (let k = 0; k < r.length; k++) if (r[k].width > 0 && r[k].height > 0) return true; return false; })();
    let wv;
    if (w.checkVisibility) wv = wb && w.checkVisibility({checkVisibilityCSS: true, checkOpacity: false});
    else { const cs = getComputedStyle(w); wv = cs.display !== 'none' && cs.visibility !== 'hidden' && wb; }
    if (!wv) continue;
    const wl = labelOf(w, 'label') || labelOf(e, 'input');
    rows.push({ i: wi, tag: w.tagName.toLowerCase(), label: norm(wl).slice(0, 40), main: false,
      data_test: w.getAttribute('data-test') || '', name: e.getAttribute('name') || '',
      id: w.id || e.id || '', input_type: (e.getAttribute('type') || '').toLowerCase(),
      role: (w.getAttribute('role') || '').toLowerCase(), content_editable: false, draggable: false, href: '' });
    stamped.add(wi);
  }
  const ordered = rows.filter((r) => r.main).concat(rows.filter((r) => !r.main)).slice(0, max);
  return ordered.map((r, pos) => {
    const ref = 'e' + pos;
    all[r.i].setAttribute('data-dshref', ref);
    return {ref: ref, dsh_ref: ref, scan: r.i, tag: r.tag, label: r.label,
            data_test: r.data_test, name: r.name, id: r.id, input_type: r.input_type, href: r.href,
            ...(r.role ? {role: r.role} : {}),
            ...(r.content_editable ? {content_editable: true} : {}),
            ...(r.draggable ? {draggable: true} : {})};
  });
}`;

/**
 * Compile a raw JS body into a REAL function for `evaluate`.
 *
 * Playwright's Python binding auto-calls an arrow-function string; the Node
 * binding only does so for strings it recognises as a lone function expression —
 * our concatenated body (COLLECT_JS + the pass) starts with a statement, so it
 * was evaluated as an expression and returned `undefined`. Compiling host-side
 * keeps the JS bodies verbatim (shared with the Python implementation) while
 * giving `evaluate` a real function to serialise.
 */
function compile(params: string, body: string): (...args: any[]) => any {
  return new Function(params, body) as (...args: any[]) => any;
}

/** One-pass extractor: shadow-aware collector + the row/label/visibility pass. */
const PASS_EXTRACT = compile("arg", `${COLLECT_JS}\nreturn (${EXTRACT_JS})(arg);`);
/** Fallback metadata pass: {i, vis, main} for every INTERACTIVE_ALL match. */
const META_JS = String.raw`(sel) => [...document.querySelectorAll(sel)].map((e, i) => {
            let vis;
            // non-zero box, same rule as the main pass (see the note there):
            // ANY non-zero rect, not just the first one
            const hasBox = (() => {
                const r = e.getClientRects();
                for (let k = 0; k < r.length; k++) if (r[k].width > 0 && r[k].height > 0) return true;
                return false;
            })();
            if (e.checkVisibility) {
                vis = hasBox && e.checkVisibility({checkVisibilityCSS: true, checkOpacity: false});
            } else {
                const cs = getComputedStyle(e);
                vis = cs.display !== 'none' && cs.visibility !== 'hidden' && hasBox;
            }
            let m = false;
            if (!e.closest('nav, aside, footer, header'))
                m = !!e.closest('main, [role=main], article');
            return {i, vis, main: m}; })`;
const PASS_META = compile("sel", `return (${META_JS})(sel);`);
/** Container identity lines for duplicate-label elements. */
const NEAR_JS = String.raw`(arg) => {` + COLLECT_JS + String.raw`
            const all = [];
            __collectAll(document, arg.sel, all);
            const labels = new Set(arg.labels);
            return arg.pairs.map(([ref, i]) => {
              const e = all[i]; if (!e) return [];
              const own = (e.innerText || e.value || '').trim();
              const isDup = (n) => labels.has((n.innerText || n.value || '').trim());
              let p = e.parentElement, out = [];
              for (let k = 0; k < 8 && p && p.tagName !== 'BODY'; k++, p = p.parentElement) {
                if ([...p.querySelectorAll('button, input[type=submit]')].filter(isDup).length > 1)
                    break;                      // whole grid inside: too big
                const lines = (p.innerText || '').trim().split('\n').map(s => s.trim())
                  .filter(t => t && t !== own && !labels.has(t)
                           && !/^[\u00a3\u20ac$\d.,x%*\s]+$/.test(t)
                           && /[a-z\u4e00-\u9fff]/i.test(t) && t.length <= 40);
                for (const t of lines) if (!out.includes(t)) out.push(t);
                if (out.length >= 3) break;
              }
              return out.slice(0, 3); }); }`;
const PASS_NEAR = compile("arg", `return (${NEAR_JS})(arg);`);
/** target_hint recovery pass (stamps data-hintref in the same pass). */
const HINT_HEAD = String.raw`(arg) => {
            const all = [], p = arg.parsed, h = arg.hint;
            __collectAll(document, arg.sel, all);
            const labelOf = (e) => {
                const first = e.childNodes.length ? String(e.childNodes[0].textContent||'').trim() : '';
                return (e.getAttribute('aria-label') || e.getAttribute('title') || first ||
                        (e.innerText||'').trim() || e.placeholder || e.value || '').replace(/\s+/g,' ').trim();
            };
            const hits = [];
            if (p.kind === 'id') {
                all.forEach((e, i) => {
                    if ((e.id || '').toLowerCase() === p.value) hits.push(i);
                });
            } else if (p.kind === 'attrSubstr') {
                all.forEach((e, i) => {
                    if (p.tag && e.tagName.toLowerCase() !== p.tag) return;
                    const hay = (e.getAttribute('href')||'') + ' ' + (e.getAttribute('data-test')||'') + ' ' +
                                (e.id||'') + ' ' + (e.name||'') + ' ' + labelOf(e);
                    if (hay.toLowerCase().includes(p.value)) hits.push(i);
                });
            } else if (p.kind === 'attrEq') {
                all.forEach((e, i) => {
                    if (p.tag && e.tagName.toLowerCase() !== p.tag) return;
                    if ((e.getAttribute(p.attr)||'').toLowerCase() === p.value) hits.push(i);
                });
            } else if (p.kind === 'tag') {
                const want = p.tag === 'link' ? 'a' : p.tag;
                all.forEach((e, i) => { if (e.tagName.toLowerCase() === want) hits.push(i); });
            } else {
                // 裸词；nearToken（无括号的 tag~token）在池侧有近邻上下文、DOM 侧没有，
                // 维持回捞路径的旧行为：按整串做裸词匹配（几乎不命中，等于"回捞不到"）。
                const tok = p.kind === 'nearToken' ? h : p.token;
                all.forEach((e, i) => {
                    const lab = labelOf(e).toLowerCase(), dt = (e.getAttribute('data-test')||'').toLowerCase();
                    if (dt === tok || dt.includes('-'+tok) || lab === tok || lab.split(/\s+/).includes(tok))
                        hits.push(i);
                });
            }
            return hits
                .filter((i) => { const e = all[i];
                    return e.checkVisibility ? e.checkVisibility({checkVisibilityCSS: true}) : true; })
                .slice(0, 5)
                .map((i, n) => {
                    const e = all[i];
                    const href = e.getAttribute('href') || '';
                    const ref = 'h' + n;
                    e.setAttribute('data-hintref', ref);
                    return {hint_ref: ref, scan: i, tag: e.tagName.toLowerCase(),
                            label: labelOf(e).slice(0, 40),
                            data_test: e.getAttribute('data-test') || '',
                            name: e.getAttribute('name') || '', id: e.id || '',
                            input_type: (e.getAttribute('type') || '').toLowerCase(),
                            href: href ? href.split('?')[0].replace(/\/+$/,'').split('/').slice(-2).join('/') : ''};
                }); }`;
const PASS_HINT = compile("arg", COLLECT_JS + `\nreturn (${HINT_HEAD})(arg);`);
/** tiny per-element fallback probes */
const FN_TAG = compile("e", "return e.tagName.toLowerCase();");
const FN_FIRST = compile("e", "return (e.childNodes.length ? e.childNodes[0].textContent : '');");
const FN_WRAPPER = compile("e", String.raw`const own = (e.value || '').trim();
                const clean = (t) => {
                    t = (t||'').replace(/\s+/g,' ').trim();
                    if (own && t.startsWith(own)) t = t.slice(own.length).trim();
                    return t; };
                let p = e.closest('label');
                if (!p && e.id) p = document.querySelector('label[for="' + CSS.escape(e.id) + '"]');
                return p ? clean(p.innerText) : '';`);

/* ------------------------------------------------------------------ discovery */

/**
 * Discover the interactive elements the model and the executor may act on.
 * `jsProbe` runs the CDP listener walk once per URL first, so JS-only widgets
 * (addEventListener divs) are stamped `data-js-ref` and join the scan.
 */
/**
 * Extract the interaction pool.
 *
 * `maxElements` defaults to the model-view budget (MAX_ELEMENTS). The executor may
 * ask for a WIDER pass once, when a decision came back below the confidence floor:
 * the pool is the model's entire world, so a target that never entered it cannot be
 * chosen no matter how good the model is (the observation bottleneck). Widening is
 * opt-in and costs one extra scan on the failure path only.
 */
export async function extractElements(
  page: PageLike, jsProbe = true, maxElements: number = MAX_ELEMENTS,
  opts?: { widgets?: boolean },
): Promise<ElemPool> {
  if (jsProbe) {
    try {
      await jsInteractiveWidgets(page);
    } catch {
      /* silent by design: recovery only */
    }
  }
  const elems: ElemPool = {};
  const frames = framesOf(page);
  for (let fi = 0; fi < frames.length; fi++) {
    const remaining = maxElements - Object.keys(elems).length;
    if (remaining <= 0) break;
    let rows: Elem[] | null = null;
    try {
      rows = (await frames[fi]!.evaluate(PASS_EXTRACT,
        { sel: INTERACTIVE_ALL, max: remaining })) as Elem[] | null;
    } catch {
      rows = null;
    }
    if (rows === null && fi === 0) rows = await extractRowsPerElement(page, maxElements);  // resilience
    for (const row of rows ?? []) {
      // child-frame refs are namespaced so one pool holds every frame
      row.ref = fi === 0 ? row.ref : `f${fi}:${row.ref}`;
      row.frame = fi;
      elems[row.ref!] = row;
    }
  }
  await addNearContext(page, elems);
  // R2：宽扫通道（opts.widgets）才展开启发式伪按钮——ref 续主池编号，主池字节不变。
  if (opts?.widgets) {
    const startRef = Object.keys(elems).length;
    const extra = await extractHeuristicWidgets(page, startRef, maxElements - startRef);
    for (const row of extra) if (row.ref) elems[row.ref] = row;
  }
  return elems;
}

/** Batched visibility/main flags — the fallback path's ordering input. */
export async function candidateMeta(page: PageLike): Promise<Array<{ i: number; vis: boolean; main: boolean }>> {
  try {
    return (await page.evaluate!(PASS_META, INTERACTIVE_ALL)) as Array<{ i: number; vis: boolean; main: boolean }>;
  } catch {
    return [];
  }
}

/** Resilience path: only used when the one-pass JS extraction throws. */
export async function extractRowsPerElement(page: PageLike, maxElements: number = MAX_ELEMENTS): Promise<Elem[]> {
  const handles = await page.locator!(INTERACTIVE_ALL).all!();
  const meta = await candidateMeta(page);
  let order = [...meta.filter((m) => m.vis && m.main).map((m) => m.i),
               ...meta.filter((m) => m.vis && !m.main).map((m) => m.i)];
  if (!meta.length) order = handles.map((_h, i) => i);   // meta pass failed: DOM order
  const elems: Elem[] = [];
  for (const i of order) {
    if (elems.length >= maxElements) break;
    const el = handles[i] as any;
    if (!el) continue;
    let visible = true;
    try {
      visible = await el.isVisible();
    } catch {
      visible = false;
    }
    if (!visible) continue;
    const tag = (await el.evaluate(FN_TAG)) as string;
    const firstNode = ((await el.evaluate(FN_FIRST)) as string) ?? "";
    let label = (await el.getAttribute("aria-label")) ?? (await el.getAttribute("title")) ?? firstNode.trim() ?? "";
    let text = "";
    if (!label || tag === "select") text = ((await el.innerText()) ?? "").trim();
    if (!label) label = text || (await el.getAttribute("placeholder")) || (await el.getAttribute("value")) || "";
    if (tag === "input" || tag === "textarea" || tag === "select") {
      let wrapper = ((await el.evaluate(FN_WRAPPER)) as string) ?? "";
      wrapper = wrapper.split(/\s+/).filter(Boolean).join(" ");
      if (!label) label = wrapper;
      else if (wrapper && wrapper !== label && !label.includes(wrapper)) label = `${label} / ${wrapper}`;
    }
    if (!(tag === "select" && label.startsWith(text.slice(0, 20))) && !label) label = text;
    label = label.split(/\s+/).filter(Boolean).join(" ");
    if ((tag === "a" || tag === "button") && !label) continue;
    const href = (await el.getAttribute("href")) ?? "";
    const jsRef = (await el.getAttribute("data-js-ref")) ?? "";
    const roleAttr = ((await el.getAttribute("role")) ?? "").trim().toLowerCase();
    let contentEditable = false;
    try {
      contentEditable = (await el.evaluate((n: { isContentEditable: boolean }) => n.isContentEditable)) === true;
    } catch { /* 拿不到就当 false（语义分类退回结构判据） */ }
    elems.push({
      ref: `e${elems.length}`, scan: i, tag, label: label.slice(0, 40),
      data_test: (await el.getAttribute("data-test")) ?? "",
      name: (await el.getAttribute("name")) ?? "",
      id: (await el.getAttribute("id")) ?? "",
      input_type: ((await el.getAttribute("type")) ?? "").toLowerCase(),
      href: href ? href.split("?")[0]!.replace(/\/+$/, "").split("/").slice(-2).join("/") : "",
      ...(jsRef ? { js_ref: jsRef } : {}),
      ...(roleAttr ? { role: roleAttr } : {}),
      ...(contentEditable ? { content_editable: true } : {}),
    });
  }
  return elems;
}

/**
 * R2b：指令与候选 label 的词面重叠判定（ASCII 词 + CJK 二元组）。
 * 零重叠 = 池里可能与指令词面相关的候选一个都没有——模型在"盲选"
 * （m.ctrip 实证：指令"出发地" vs 提名"组合交通出行"，conf 0.71 照样过闸）。
 * 宽扫恢复的第二个触发器判据；纯函数，可单测。
 */
export function lexicalOverlap(instruction: string, label: string): boolean {
  const li = String(label ?? "").toLowerCase();
  if (!li) return false;
  const ins = String(instruction ?? "");
  for (const w of ins.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) {
    if (li.includes(w)) return true;
  }
  for (const seq of ins.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (seq.length === 1) {
      if (li.includes(seq)) return true;
      continue;
    }
    for (let i = 0; i + 2 <= seq.length; i++) {
      if (li.includes(seq.slice(i, i + 2))) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ R2: heuristic widgets */

/**
 * R2 启发式伪按钮（可见 + 有文本的自绘控件）：**只服务低置信失败路径的宽扫通道**
 * （executor.ts WIDER pass），主池永不收——"池=模型的全部世界，宁缺勿滥"不破。
 * 动机（m.ctrip 实证）：零 ARIA 的 SPA 自绘控件（div 文本按钮、事件委托在根节点）
 * 结构白名单与 CDP listener 探针都收不进来，模型世界缺失 → 盲选漂移。
 * 判据：div/span/li/td/article + 可见非零盒 + 自文本 1..60 字 + 非容器
 * （内部无原生交互元素）+ 非 nav/aside/footer/header + 未在主池（无 data-dshref）。
 * 只留最内层（嵌套候选去重）；每候选盖 data-dshref（ref 续主池编号），点击解析机制不变。
 * 带 `heuristic: true` 标记，PoolView/审计可辨。
 */
export const HEURISTIC_WIDGET_JS = String.raw`(arg) => {
  const WS = /[ \t\n\r\f\v]+/g;
  const norm = (t) => (t || '').replace(/[\uE000-\uF8FF]/g, '').replace(WS, ' ').trim();
  const all = [];
  __collectAll(document, 'div, span, li, td, article', all);
  const cands = [];
  for (const e of all) {
    if (cands.length >= 400) break;
    if (e.getAttribute('data-dshref')) continue;
    // R2c：容器排除只针对含**可见**交互后代的容器——"可见 div + 隐藏 input 存值"的
    // 表单容器本身就是人点的伪按钮（m.ctrip City_city-wrap 实证：textContent
    // "北京上海"，内含 0x0 隐藏 input，被旧过滤器整枝丢掉）。全部交互后代都不可见
    // 时，容器按伪按钮候选保留。
    let hasVisibleCtrl = false;
    for (const c of e.querySelectorAll('a, button, input, select, textarea, label')) {
      const cb = (() => { const r = c.getClientRects(); for (let k = 0; k < r.length; k++) if (r[k].width > 0 && r[k].height > 0) return true; return false; })();
      if (cb) { hasVisibleCtrl = true; break; }
    }
    if (hasVisibleCtrl) continue;
    if (e.closest('nav, aside, footer, header')) continue;
    const txt = norm(e.innerText || '');
    if (!txt || txt.length > 60) continue;
    const hasBox = (() => { const r = e.getClientRects(); for (let k = 0; k < r.length; k++) if (r[k].width > 0 && r[k].height > 0) return true; return false; })();
    let vis;
    if (e.checkVisibility) vis = hasBox && e.checkVisibility({checkVisibilityCSS: true, checkOpacity: false});
    else { const cs = getComputedStyle(e); vis = cs.display !== 'none' && cs.visibility !== 'hidden' && hasBox; }
    if (!vis) continue;
    cands.push(e);
  }
  const kept = cands.filter((c) => !cands.some((o) => o !== c && c.contains(o)));
  return kept.slice(0, arg.max).map((e, pos) => {
    const ref = 'e' + (arg.startRef + pos);
    e.setAttribute('data-dshref', ref);
    const tag = e.tagName.toLowerCase();
    return { tag: tag, label: norm(e.innerText || '').slice(0, 40),
      main: (!e.closest('nav, aside, footer, header') && !!e.closest('main, [role=main], article')),
      data_test: e.getAttribute('data-test') || '', name: e.getAttribute('name') || '',
      id: e.id || '', input_type: (e.getAttribute('type') || '').toLowerCase(),
      role: (e.getAttribute('role') || '').toLowerCase() };
  });
}`;

const PASS_HEURISTIC = compile("arg", `${COLLECT_JS}\nreturn (${HEURISTIC_WIDGET_JS})(arg);`);

export async function extractHeuristicWidgets(
  page: PageLike, startRef: number, max: number,
): Promise<Elem[]> {
  if (max <= 0) return [];
  try {
    const rows = (await page.evaluate!(PASS_HEURISTIC, { startRef: startRef, max: max })) as
      Array<Record<string, unknown>> | null;
    return (rows ?? []).map((r, k): Elem => ({
      ref: `e${startRef + k}`,
      scan: -1,
      tag: String(r["tag"] ?? "div"),
      label: String(r["label"] ?? "").slice(0, 40),
      data_test: String(r["data_test"] ?? ""),
      name: String(r["name"] ?? ""),
      id: String(r["id"] ?? ""),
      input_type: String(r["input_type"] ?? ""),
      role: String(r["role"] ?? ""),
      heuristic: true,
    }));
  } catch {
    return [];   // silent by design: recovery only
  }
}

/* ------------------------------------------------------------------ CDP probe */

/**
 * Elements interactive ONLY via JS listeners — the SPA idiom CSS cannot see
 * (`<div>Save</div>` + addEventListener, no onclick attr). Detection stamps each
 * hit with `data-js-ref` during the walk, so identity is exact. Cost is bounded
 * on purpose (~4 ms per candidate); never raises.
 */
export async function jsInteractiveWidgets(page: PageLike, maxAdd = 10, maxExamined = 150,
                                          budgetS = 2.0): Promise<unknown[]> {
  const key = urlOf(page);
  if (listenerCache.has(key)) return listenerCache.get(key)!;
  const out: Array<Record<string, unknown>> = [];
  const examined = [0];
  const deadline = Date.now() / 1000 + budgetS;
  try {
    const cdp = await (page as any).context().newCDPSession(page);
    await cdp.send("DOM.enable");
    const doc = await cdp.send("DOM.getDocument", { depth: -1 });
    const seq = [0];
    const walk = async (node: any): Promise<void> => {
      if (out.length >= maxAdd || examined[0] >= maxExamined || Date.now() / 1000 > deadline) return;
      if (node?.nodeType === 1) {
        const at: string[] = node.attributes ?? [];
        const d: Record<string, string> = {};
        for (let i = 0; i < at.length; i += 2) d[at[i]!] = at[i + 1]!;
        const tag = String(node.nodeName ?? "").toLowerCase();
        if (CUSTOM_WIDGET_TAGS.has(tag) && !("onclick" in d)
            && !["button", "link", "checkbox", "tab"].includes(d.role ?? "")
            && !d["data-test"] && !d.href && !d["data-js-ref"]) {
          examined[0] += 1;
          if (examined[0] > maxExamined) return;
          try {
            const oid = (await cdp.send("DOM.resolveNode", { nodeId: node.nodeId })).object.objectId;
            const ls = await cdp.send("DOMDebugger.getEventListeners", { objectId: oid });
            const clicky = [...new Set((ls.listeners as Array<{ type: string }>).map((l) => l.type))]
              .filter((t) => CLICKY_EVENTS.has(t)).sort();
            if (clicky.length) {
              const r = await cdp.send("Runtime.callFunctionOn", {
                objectId: oid, returnByValue: true,
                arguments: [{ value: `js${seq[0]}` }],
                functionDeclaration: String.raw`function(jsref){
                                  const t=(this.innerText||'').trim();
                                  if(!t && !this.getAttribute('aria-label')
                                     && !this.getAttribute('title')) return null;
                                  this.setAttribute('data-js-ref', jsref);
                                  return {tag: this.tagName.toLowerCase(),
                                          label: (this.getAttribute('aria-label')
                                                  || this.getAttribute('title')
                                                  || t).slice(0,40),
                                          id: this.id || ''}; }`,
              });
              const info = r?.result?.value;
              if (info) {
                seq[0] += 1;
                out.push({ ...info, ref_tag: `js${seq[0] - 1}`, js_events: clicky });
              }
            }
          } catch {
            /* per-node hiccup: keep walking */
          }
        }
      }
      for (const c of node?.children ?? []) await walk(c);
    };
    await walk(doc.root);
    try {
      await cdp.detach();
    } catch {
      /* detached already */
    }
  } catch {
    listenerCache.set(key, []);
    return [];
  }
  listenerCache.set(key, out);
  return out;
}

/* ------------------------------------------------------------------ views */

/** Interactive leaves of Playwright's ARIA snapshot, in DOM order (or null). */
export async function ariaInteractiveLines(page: PageLike): Promise<Array<[string, string]> | null> {
  let snap: string;
  try {
    snap = await (firstOf(page.locator!("body")) as any).ariaSnapshot({ timeout: 4000 });
  } catch {
    return null;
  }
  const out: Array<[string, string]> = [];
  for (const ln of (snap ?? "").split("\n")) {
    const m = ARIA_LINE_RE.exec(ln);
    if (m) out.push([m[1]!, (m[2] ?? "").trim()]);
  }
  return out;
}

/**
 * Model-facing criteria: hybrid rendering — ARIA *role* (a11y normalization) with
 * OUR label text and attribute suffixes kept.
 *
 * Measured on an e-commerce product page: old tag+label -> correct button 0.49 vs logo
 * 0.20; PURE aria role+name -> logo wins 0.59 vs 0.07 (regression); role + our
 * label/attrs -> 0.50 vs 0.18 (this function). The ` [test=..] -> href` suffixes
 * are load-bearing even though rules/hints never read this text.
 */
export function criteriaView(
  elems: ElemPool, forbidden: Set<string>, ariaLines: Array<[string, string]> | null,
  /**
   * Optional per-ref note appended to the rendered line — how a RANKED (not forbidden)
   * candidate tells the model what is already known about it, e.g. that a previous
   * attempt on this exact page+subgoal produced no change (see src/model/outcome-memory.ts).
   */
  notes: Record<string, string> | null = null,
): Record<string, string> {
  const crit: Record<string, string> = {};
  const aligned = ariaLines !== null && ariaLines.length === Object.keys(elems).length;
  const ordered = Object.entries(elems)
    .sort((a, b) => (a[1].scan ?? Number(a[0].slice(1))) - (b[1].scan ?? Number(b[0].slice(1))));
  ordered.forEach(([ref, e], i) => {
    if (forbidden.has(ref)) return;
    const note = notes?.[ref] ? ` ${notes[ref]}` : "";
    const attrs = (e.data_test ? ` [test=${e.data_test}]` : "") + (e.href ? ` -> ${e.href}` : "") + note;
    if (aligned) {
      const [role, name] = ariaLines![i]!;
      const ours = e.label;
      // prefer ours when both exist (aria names can bleed badge spans: "Cart0");
      // adopt aria only where it carries signal ours lacks
      if (!ours && name) crit[ref] = `${role} "${name}"${attrs}`;
      else if (e.tag === "select" && name && name !== ours) crit[ref] = `select "${name}" [now=${ours}]${attrs}`;
      else crit[ref] = `${role} "${ours}"${attrs}`;
    } else {
      crit[ref] = `${e.tag} "${e.label}"${attrs}`;
    }
  });
  // duplicate strings are zero-information for the classifier: disambiguate them
  // with the container identity line captured by addNearContext.
  const counts = new Map<string, number>();
  for (const v of Object.values(crit)) counts.set(v, (counts.get(v) ?? 0) + 1);
  for (const [ref, v] of Object.entries(crit)) {
    const near = elems[ref]?.near;
    if ((counts.get(v) ?? 0) > 1 && near) crit[ref] = `${v} [near=${near}]`;
  }
  return crit;
}

/**
 * Enrich duplicate-label elements with their container's identity line (the
 * grid-of-identical-buttons problem: laya measured a coin flip, 0.26 vs 0.25).
 * Count how many elements of THIS colliding label sit inside the container:
 * a card holds exactly one -> climb; the whole grid holds them all -> stop.
 */
export async function addNearContext(page: PageLike, elems: ElemPool): Promise<void> {
  const cnt = new Map<string, number>();
  for (const e of Object.values(elems)) {
    const k = `${e.tag}\u0000${e.label}`;
    cnt.set(k, (cnt.get(k) ?? 0) + 1);
  }
  const dups: Array<[string, number, number]> = Object.entries(elems)
    .filter(([, e]) => (cnt.get(`${e.tag}\u0000${e.label}`) ?? 0) > 1 && e.scan !== undefined)
    .map(([r, e]) => [r, e.scan!, e.frame ?? 0]);
  if (!dups.length) return;
  const labels = [...new Set(dups.map(([r]) => elems[r]!.label))].sort();
  const byFrame = new Map<number, Array<[string, number]>>();
  for (const [r, i, fi] of dups) {
    if (!byFrame.has(fi)) byFrame.set(fi, []);
    byFrame.get(fi)!.push([r, i]);
  }
  const candsAll: Record<string, string[]> = {};
  for (const [fi, pairs] of byFrame) {
    const fr = frameAt(page, fi) ?? (page as unknown as FrameLike);
    try {
      const res = (await fr.evaluate(PASS_NEAR,
      { sel: INTERACTIVE_ALL, pairs, labels })) as string[][];
      pairs.forEach(([r], j) => {
        candsAll[r] = (j < (res?.length ?? 0) ? res[j] : []) as string[];
      });
    } catch {
      continue;
    }
  }
  for (const [r, lines] of Object.entries(candsAll)) {
    if (!lines.length) continue;
    const pick = lines.find((t) => Object.values(candsAll).filter((o) => o.includes(t)).length === 1) ?? lines[0];
    elems[r]!.near = pick!;
  }
}

/**
 * Retrieve elements matching a frozen-plan target_hint that the MAX_ELEMENTS
 * budget evicted. The budget is a model-view optimization; it must never drop
 * the element the PLAN already named (measured: books home page — 20 product
 * rows ate all 40 slots and the plan's target was simply absent).
 * Winners are stamped `data-hintref` in the same pass that identifies them.
 */
/**
 * `hint_lookup` 的调用参数：**解析只做一次**，页面函数拿到的是 `parsed`（P0-B）。
 * 导出它是为了差分测试能核验"两面用的是同一个解析结果"，而不是各解析一遍。
 */
export function hintLookupArgs(hint: string): { hint: string; parsed: ParsedHint; sel: string } {
  return { hint: hint.trim().toLowerCase(), parsed: parseHint(hint), sel: INTERACTIVE_ALL };
}

export async function hintLookup(page: PageLike, hint: string): Promise<ElemPool> {
  const out: ElemPool = {};
  const frames = framesOf(page);
  for (let fi = 0; fi < frames.length; fi++) {
    let rows: Array<Record<string, unknown>> | null = null;
    try {
      rows = (await frames[fi]!.evaluate(PASS_HINT,
        hintLookupArgs(hint))) as Array<Record<string, unknown>> | null;
    } catch {
      continue;
    }
    for (const row of rows ?? []) {
      const ref = fi === 0 ? `x${row.scan}` : `xf${fi}:${row.scan}`;
      out[ref] = { ref, frame: fi, ...(row as Elem) };
    }
  }
  return out;
}

/* ------------------------------------------------------------------ text views */

/**
 * Head+tail page text: build_sequence keeps the START of the state and cuts the
 * tail at max_len, and forms/errors usually live at the bottom — ship both ends.
 */
export async function pageText(page: PageLike, head = 300, tail = 150): Promise<string> {
  const text = (await firstOf(page.locator!("main, body")).innerText()).trim();
  if (text.length <= head + tail) return text;
  return text.slice(0, head) + "\n...\n" + text.slice(-tail);
}

/**
 * State compressor: rank page lines by keyword overlap with the query and pack
 * only the hits into the budget. Deterministic on purpose — laya's domain-tuned
 * encoder is measurably unreliable as a general text-similarity ranker.
 */
export async function stateText(page: PageLike, query: string, _embedFn: unknown = null, budget = 320): Promise<string> {
  const text = (await firstOf(page.locator!("main, body")).innerText()).trim();
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const ln of text.split("\n").map((l) => l.trim())) {
    if (ln.length >= 4 && !seen.has(ln.toLowerCase())) {
      seen.add(ln.toLowerCase());
      lines.push(ln);
    }
  }
  if (!lines.length) return "";
  if (lines.join("\n").length <= budget) return lines.join("\n");
  const tok = new Set(query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);
  const scored = lines.map((ln, i) => {
    const ws = new Set(ln.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);
    let score = 0;
    for (const t of tok) if (ws.has(t)) score += 1;
    return { score, i };
  }).sort((a, b) => b.score - a.score || a.i - b.i);
  const out: number[] = [];
  let used = 0;
  for (const { score, i } of scored) {
    if (score <= 0) break;
    if (used + lines[i]!.length + 1 > budget) continue;
    out.push(i);
    used += lines[i]!.length + 1;
    if (used >= budget * 0.9) break;
  }
  if (!out.length) return pageText(page);   // query matches nothing -> head+tail
  return out.sort((a, b) => a - b).map((i) => lines[i]).join("\n");
}
