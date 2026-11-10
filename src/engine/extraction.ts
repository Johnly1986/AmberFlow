/**
 * Extraction layer: turn a live page into the model-facing element space.
 *
 * TS twin of `layaapp/extraction.py`. Owns everything between "a Playwright page
 * exists" and "here is the element pool, its labels, its handles and the JS passes
 * that keep them consistent": interactive discovery (one JS pass over main and
 * child frames — same-origin and cross-origin both resolve, R11 B5 — plus open
 * shadow roots), the aria/criteria views, the CDP listener probe
 * for JS-only widgets, target_hint recovery, element signatures and frame scope.
 * No decisions and no execution.
 *
 * The JS bodies are RAW strings (String.raw): writing `\\s` here would reach the
 * browser as a literal backslash class — that exact bug silently broke
 * hint_lookup's multi-word labels in the Python version.
 */

import { parseHint, type ParsedHint } from "./hint.ts";
import { parseClickAtValue } from "./click-at.ts";
import {
  ADMIT_SEL, POOL_SEL, SURFACE_SELECTORS, WINDOW_CAPS,
  admitSelectorWithJsFor, poolSelectorWithJsFor, type SurfacePolicy,
} from "./surface.ts";

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
  /**
   * T9：**原始** `getAttribute('href')`（原样保留 query/fragment/origin，不切段）。
   * `href` 仍是展示投影（模型视图/criteriaView 用的就是它），本字段只服务 hint 匹配
   * （rules.ts 的 href 双字段底座）与 inspect 的观察面；不进 `ChoiceRequest.elems`
   * （executor.pickInner 剥离，与 `surface` 同一处）。空 href 不出现（空即缺省）。
   */
  href_full?: string;
  /** 显式 ARIA 角色（`getAttribute('role')`；没有就不出现——对拍语料逐字节不变）。 */
  role?: string;
  /** `contenteditable` 为真（语义上是"可填"，结构上不是 input/textarea）。 */
  content_editable?: boolean;
  near?: string;
  /**
   * U3 类目标记（native-control / native-label / aria-role / aria-widget / native-activation）。
   * **只进 PoolView / inspect / 类目计数**，不进 `ChoiceRequest.elems` 的模型投影（F14）。
   */
  surface?: string;
  frame?: number;
  js_events?: unknown;
  js_ref?: string;
  dsh_ref?: string;
  /**
   * A2 分桶/可寻址（只读诊断字段；主池每个候选都有）：
   *   full_label —— 完整可读标签（≤200 字符；`label` 仍是模型视图的前缀 40，别拿它做完整匹配）；
   *   rect/inViewport/nearViewport —— 提取那一刻相对**当前视口**的几何（不滚动、不追视口）；
   *   scrollDepth/inScrollContainer —— 到最近可滚动祖先的层数（0 = 不在滚动容器里）；
   *   bucket/prio —— 分桶闭集（chrome/viewport/contentNear/mainOffscreen/other）与优先级（仅诊断）。
   */
  full_label?: string;
  /**
   * P0-A（inspect 观察面 opt-in）：`label_full` 是**不截断**的完整标签（`full_label` 仍是
   * ≤200 的匹配口径）；`class_names` 有界（≤8 个、每项 ≤40 字符）。缺省不出现 ⇒ 池/模型面
   * 与既有产物逐字节不变。
   */
  label_full?: string;
  class_names?: string[];
  rect?: { top: number; left: number; width: number; height: number };
  inViewport?: boolean;
  nearViewport?: boolean;
  scrollDepth?: number;
  inScrollContainer?: boolean;
  bucket?: PoolBucket;
  prio?: number;
  [k: string]: unknown;
}
export type ElemPool = Record<string, Elem>;

/**
 * 元素**动作族**（S2 ③ 运行期接线 + 页面状态采集共用）。
 *
 * 判据与执行器自己的分类**同一份**（`_isCheckable` / `_isTyping` / `_isSubmit`）：
 *   - check：input[type=checkbox|radio]
 *   - select：`<select>`
 *   - fill：input/textarea（不含 submit/button/checkbox/radio/file）
 *   - upload：input[type=file]（file 不是文本输入；上传是独立原语，见 U6）
 *   - click：其余（a / button / input[type=submit|button] / 其它可点元素）
 * 为什么必须单一出处：提名指令收窄元素池时，窄出的池子必须正好是"这条指令能作用的那一族"；
 * 两处各判一次就会漂移（本仓 hint 语法漂移过两次，同一条教训）。
 */
export type ElemFamily = "click" | "fill" | "select" | "check" | "upload";

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
  // B2 扩面的五个 role（menuitem / menuitemradio / menuitemcheckbox / option / tab）**有意不设
  // 显式分支**：上面的 select/check/fill 清单都不收它们，落到底部默认 return "click"
  // （menuitemradio/menuitemcheckbox 的选中语义也是 click 驱动，不放 check/slider 族）。
  if (e.content_editable === true) return "fill";       // contenteditable：可填，但不是 input/textarea
  // ---- 原生标签（没有显式角色时按结构与 input type 判）----
  if (e.tag === "input" && (type === "checkbox" || type === "radio")) return "check";
  // U6：文件输入不是文本输入，单独一族——upload 能力面只对它成立。
  if (e.tag === "input" && type === "file") return "upload";
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
export type ActionCapability = "click" | "clickAt" | "fill" | "select" | "check" | "slider" | "scroll" | "drag" | "hover" | "upload";

/** 执行动作所需的最小 locator 面；由执行器/PoolView 的调用方提供。 */
export interface ActionLocatorLike {
  click(opts?: Record<string, unknown>): Promise<void>;
  fill(value: string, opts?: Record<string, unknown>): Promise<void>;
  selectOption(value: unknown, opts?: Record<string, unknown>): Promise<void>;
  /** S4：指针悬停原语（可选——测试替身可能没有，缺了按 action_unsupported 报）。 */
  hover?(opts?: Record<string, unknown>): Promise<void>;
  /** U6：文件上传原语（Playwright locator.setInputFiles；可选，缺了按 action_unsupported 报）。 */
  setInputFiles?(files: unknown, opts?: Record<string, unknown>): Promise<void>;
  /** U7：clickAt 越界校验要的实测盒（Playwright locator.boundingBox；可选，缺了按测不到报）。 */
  boundingBox?(): Promise<{ x: number; y: number; width: number; height: number } | null>;
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

/**
 * U7：坐标点击原语（命令闭集的 `clickAt` op）。能力面与 click 族**同一集合**
 * （canvas 这类元素在池里归 click 族）；坐标是**元素相对**坐标，只来自声明绑定。
 * 真正执行入口是 executor `_executeElement(clickAt)`（含 bbox 越界校验）；本 adapter
 * 保留同一能力面声明与一份等价的 apply 供未来接入，不另开动作生成路径。
 */
const CLICK_AT_ADAPTER: ActionAdapter = {
  kind: "clickAt",
  canApply: (e) => elemFamily(e) === "click",
  async apply(loc, { value, timeoutMs = 5000 } = {}) {
    const parsed = parseClickAtValue(value);
    if (!parsed.ok) return ["config_error", parsed.reason];
    const box = typeof loc.boundingBox === "function" ? await loc.boundingBox() : null;
    if (box === null) return ["action_failed", "clickAt: element has no bounding box (detached or zero-size)"];
    const { x, y } = parsed.position;
    if (x < 0 || x >= box.width || y < 0 || y >= box.height) {
      return ["config_error",
        `clickAt position ${x},${y} is outside the element: measured ${box.width}x${box.height} `
        + `(need 0 <= x < ${box.width}, 0 <= y < ${box.height})`];
    }
    await loc.click({ position: { x, y }, timeout: timeoutMs });
    return ["clicked", { x, y }];
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

/**
 * S4：hover 原语（命令闭集的 `hover` op）。池里只有**可交互**元素（INTERACTIVE_ALL），
 * 悬停是任何已定位元素都有的指针语义（与 scroll 的 viewport 语义同款），所以能力面恒真；
 * 它只改变指针位置，不点击、不导航——展开 `:hover` 菜单/图层面板正是它的用途。
 */
const HOVER_ADAPTER: ActionAdapter = {
  kind: "hover",
  canApply: () => true,
  async apply(loc, { timeoutMs = 5000 } = {}) {
    if (typeof loc.hover !== "function") return ["action_unsupported", "locator has no hover"];
    await loc.hover({ timeout: timeoutMs });
    return ["hovered", null];
  },
};

/**
 * U6：上传原语（命令闭集的 `upload` op）。能力面**只**对 `input[type=file]` 成立；
 * 值只来自声明绑定（slot/dataset；option/list 不适用），由执行器 `_executeElement` 归一成路径列表后
 * 调 `locator.setInputFiles`。这里保留 adapter 形状供 `actionCapabilities`/PoolView 使用。
 */
const UPLOAD_ADAPTER: ActionAdapter = {
  kind: "upload",
  canApply: (e) => e.tag === "input" && String(e.input_type ?? "").toLowerCase() === "file",
  async apply(loc, { value, timeoutMs = 5000 } = {}) {
    if (value === undefined || value === null || String(value).trim() === "") return ["needs_value", null];
    const setInputFiles = (loc as unknown as {
      setInputFiles?: (files: unknown, o?: unknown) => Promise<void>;
    }).setInputFiles;
    if (typeof setInputFiles !== "function") return ["action_unsupported", "locator has no setInputFiles"];
    await setInputFiles.call(loc, String(value), { timeout: timeoutMs });
    return ["uploaded", value];
  },
};

export const ACTION_ADAPTERS: readonly ActionAdapter[] = [
  DRAG_ADAPTER, SCROLL_ADAPTER, SLIDER_ADAPTER, CHECK_ADAPTER, SELECT_ADAPTER, FILL_ADAPTER, CLICK_ADAPTER,
  CLICK_AT_ADAPTER, HOVER_ADAPTER, UPLOAD_ADAPTER,
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
  /** 可见性（Playwright Locator.isVisible）。可选：测试替身可能没有——调用方按"不可判定"处理。 */
  isVisible?(): Promise<boolean> | boolean;
}
export interface LocLike {
  count(): Promise<number> | number;
  /** Python exposes `.first` as a property; the Node API as a method. */
  first: InnerLoc | (() => InnerLoc);
  all?(): Promise<unknown[]>;
  /** 可见性（Playwright Locator.isVisible）。可选：测试替身可能没有。 */
  isVisible?(): Promise<boolean> | boolean;
}

/** `.first` across both Playwright runtimes (property vs method). */
export function firstOf(loc: LocLike): InnerLoc {
  return typeof loc.first === "function" ? loc.first() : loc.first;
}
export interface FrameLike {
  /** `hasText` 过滤器（css_exists_text）走 Playwright locator(selector, { hasText })。 */
  locator(selector: string, opts?: { hasText?: string }): LocLike & { all?(): Promise<unknown[]> };
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
  url?: string | (() => string);
}
export interface PageLike {
  /** Python's Playwright exposes `page.url` as a property; the Node API as a method. */
  url: string | (() => string);
  frames?: FrameLike[] | (() => FrameLike[]);
  locator?(selector: string, opts?: { hasText?: string }): LocLike & { all?(): Promise<unknown[]> };
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

/**
 * P0-D：host 信封的**只读**判定（与执行器 `disallowedHost` 同一语义：hostname 精确或后缀）。
 * 帧 URL 无法解析 / about:blank / file: 等：返回 true（不可判 origin 时绝不擅自排除）。
 */
/** 信封布尔视图：true = 在声明的 hosts 信封内。单源实现见 host-envelope.ts（L2 合并）。 */
export { urlInHostsEnvelope } from "./host-envelope.ts";

/** P0-D：一个 frame 的 URL 是否在信封内（空 URL / about:blank = 允许，口径同上面）。 */
export function frameInHostsEnvelope(frame: FrameLike, hosts: string[] | null | undefined): boolean {
  let url = "";
  try { url = typeof frame.url === "function" ? frame.url() : (frame.url ?? ""); } catch { url = ""; }
  return urlInHostsEnvelope(String(url), hosts);
}

/** P0-D：frame 的 origin 证据文案（解析失败时退化为空串）。 */
export function frameOriginOf(frame: FrameLike): string {
  let url = "";
  try { url = typeof frame.url === "function" ? frame.url() : (frame.url ?? ""); } catch { url = ""; }
  if (!url) return "";
  try { return new URL(url).origin; } catch { return ""; }
}

/**
 * P0-D：**帧门禁**。主 frame 恒允许（导航信封已经强制过它）；子 frame 的 origin 不在
 * `meta.hosts` 内 → 进 `excluded`（不参与池/hint/identity/DRF/done/when 的解析面）。
 * 无 hosts 声明或没有任何被排除帧时 `null`（缺省路径零新行为）。
 *
 * 索引纪律：`frames` / `allowedIndexes` 保留**真实**下标，池行的 `frame`/`f<fi>:` ref
 * 因此逐字节不变——被排除的只是解析面，不是编号。
 */
export interface FrameGate {
  hosts: string[];
  frames: FrameLike[];
  allowed: FrameLike[];
  allowedIndexes: number[];
  excluded: Array<{ index: number; frame: FrameLike; origin: string }>;
  origins: string[];
}

export function frameGateOf(page: PageLike, hosts: string[] | null | undefined): FrameGate | null {
  if (!hosts || hosts.length === 0) return null;
  const frames = framesOf(page, 64);
  if (frames.length <= 1) return null;
  const allowed: FrameLike[] = [frames[0]!];
  const allowedIndexes: number[] = [0];
  const excluded: Array<{ index: number; frame: FrameLike; origin: string }> = [];
  for (let i = 1; i < frames.length; i++) {
    const fr = frames[i]!;
    if (frameInHostsEnvelope(fr, hosts)) { allowed.push(fr); allowedIndexes.push(i); }
    else excluded.push({ index: i, frame: fr, origin: frameOriginOf(fr) });
  }
  if (excluded.length === 0) return null;
  const origins = [...new Set(excluded.map((e) => e.origin || "about:blank"))];
  return { hosts, frames, allowed, allowedIndexes, excluded, origins };
}

/**
 * P0-D：一个只暴露指定 frame 的**页面视图**（读面用）。只转发信号/池解析真正用到的
 * 成员（url / frames / locator / evaluate）；动作路径永远拿真实 page。
 */
export function framesScopedPage(page: PageLike, frames: FrameLike[]): PageLike {
  const view: PageLike = {
    url: () => urlOf(page),
    frames: () => frames,
    ...(page.locator === undefined ? {} : { locator: (sel, opts) => page.locator!(sel, opts) }),
    ...(page.evaluate === undefined ? {} : { evaluate: (fn, arg) => page.evaluate!(fn, arg) }),
  };
  return view;
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
 * First matching locator across the main frame and reachable child frames
 * (same-origin and cross-origin both resolve through Playwright locators;
 * cross-origin stability is measured, R11 B5). Signals are frequently rendered
 * inside an iframe (a success banner, an embedded form's own field), where
 * `page.locator` never looks.
 *
 * `opts.hasText` 透传给每一帧的 `locator(selector, { hasText })`（`css_exists_text`
 * 用它跨 frame 找"文本含 text"的元素；Playwright 的 hasText 是大小写不敏感的子串匹配）。
 */
export async function locatorAnyFrame(
  page: PageLike, selector: string, opts?: { hasText?: string; hosts?: string[] | null },
): Promise<LocLike | null> {
  if (page.frames !== undefined || page.locator !== undefined) {
    const frames = framesOf(page);
    for (let fi = 0; fi < frames.length; fi++) {
      const fr = frames[fi]!;
      // P0-D：被排除的 frame 不参与信号求值（主 frame 恒在面内；无 hosts = 旧行为）。
      if (fi > 0 && !frameInHostsEnvelope(fr, opts?.hosts)) continue;
      try {
        const loc = opts === undefined ? fr.locator(selector) : fr.locator(selector, opts);
        if (await loc.count()) return loc;
      } catch {
        continue;   // frame detached mid-scan / no execution context: skip（跨源 frame 不在此抛——R11 B5 实测可跨源 locator 定位）
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
// B2 扩面：追加五个 ARIA 菜单/选择/页签 role（menuitem / menuitemradio / menuitemcheckbox /
// option / tab）——弹层菜单项、下拉选项、页签这类 div 自绘控件此前永远进不了池（W3 记录项 1：
// popup.html 的 div[role=menuitem][aria-label] 九宫格 learn 回放 pool=1 失败的根因之一）。
// 这是**全局行为变更**：所有应用的候选池构成可能变化（决策层看到的池/排序不同；同名候选增多
// 可能引入新歧义，如 tab 与按钮同 label）。对 hint 命中无影响（仍按 label 匹配）；
// MAX_ELEMENTS/分桶配额不变，新 role 走既有分桶。
export const INTERACTIVE = POOL_SEL;
/**
 * **池/序号基准**（U3/FW5 语义收窄）：`POOL_SEL + ", [data-js-ref]"`。
 * `scan` 是元素在**本选择器结果数组**里的下标（盖章 / `_locatorFor` 位置回退都依赖它）；
 * 身份寻址/只读计数面一律用 `ADMIT_SEL`，绝不能拿它的下标当 `scan`。
 * 既有成员顺序与 U3 之前逐字节一致，新类目只追加在尾部 ⇒ 不含新类目的页面结果集合不变。
 */
export const INTERACTIVE_ALL = INTERACTIVE + ", [data-js-ref]";
export const MAX_ELEMENTS = 40;
/**
 * 低置信恢复路径宽扫的元素预算（executor 的 ONE wider look；R2 起同通道展开
 * 启发式伪按钮候选）。单一出处：executor 与 inspect --wide 共用。
 */
export const WIDE_POOL_ELEMENTS = 120;

/**
 * A2 分桶闭集与配额。为什么要有配额：默认池是 40 个名额的**有界窗口**，旧排序是
 * "main 优先"，一个长列表就能把页头 8 个按钮（排序/筛选）全部挤出窗口——Google Hotels
 * 的「排序」菜单实测不可选。配额保证每一类页面区域都有最小可见性：
 *   chrome       页面 chrome（nav/aside/footer/header），不受视口限制；
 *   viewport     非 chrome 且在当前视口内（±15%）；
 *   contentNear  非 chrome、视口外但在 ±150% 内（"快滚到"的内容）；
 *   mainOffscreen 非 chrome、更远、且在该页 main/article 里；
 *   other        其余（页脚外正文、侧栏外的离屏控件…）。
 * 配额用不完时按 BUCKET_FILL_ORDER 顺延，绝不自动滚动页面（提取只观察当前视口）。
 */
export type PoolBucket = "chrome" | "viewport" | "contentNear" | "mainOffscreen" | "other";
export type PoolQuotas = Record<PoolBucket, number>;
/** 默认池（40）的分桶配额（合计 40）。 */
export const POOL_QUOTAS: PoolQuotas = { chrome: 8, viewport: 16, contentNear: 8, mainOffscreen: 6, other: 2 };
/** 宽扫池（120）的分桶配额（合计 120）。 */
export const WIDE_QUOTAS: PoolQuotas = { chrome: 16, viewport: 48, contentNear: 32, mainOffscreen: 16, other: 8 };
/** 拼接顺序（ref 编号 / 诊断展示顺序）：chrome 在前，其余按"离当前视口由近到远"。 */
export const BUCKET_ORDER: readonly PoolBucket[] = ["chrome", "viewport", "contentNear", "mainOffscreen", "other"];
/** 配额没填满时的顺延顺序（chrome 最后兜底：它通常量小且已配额内收全）。 */
export const BUCKET_FILL_ORDER: readonly PoolBucket[] = ["viewport", "contentNear", "mainOffscreen", "other", "chrome"];

/**
 * A2：**决策服务单次候选上限**。评测/在线服务把候选清单当选项列表，服务侧硬上限 255；
 * 200 是安全帽。超限不是"窗口开大一点"能解决的——那是结构化停因
 * `decision_service_choice_limit`（收窄 hint / 用分桶优先级，而不是放大候选）。
 */
export const MAX_CHOICES = 200;

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
 * A2 视口几何/分桶的唯一 JS 实现（EXTRACT_JS、WINDOW_AUDIT_JS、viewportUnderload 共用，
 * 避免"三份口径漂移"）。
 *
 * 纪律：**只观察当前视口，绝不自动滚动**——桶是"这一刻的页面"的归属，不是"滚到底会看到什么"。
 * 成本：每候选一次 getBoundingClientRect；滚动祖先用 parent→bool 缓存，单候选 O(depth)。
 */
export const BUCKET_HELPERS_JS = String.raw`
  const __vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const __vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const __BUCKET_RANK = { chrome: 0, viewport: 1, contentNear: 2, mainOffscreen: 3, other: 4 };
  const __rectOf = (e) => {
    const r = e.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height),
             bottom: r.bottom, right: r.right };
  };
  const __isChrome = (e) => { try { return !!e.closest('nav, aside, footer, header'); } catch (err) { return false; } };
  const __inSpan = (r, mx, my) => r.bottom > -my && r.top < __vh + my && r.right > -mx && r.left < __vw + mx;
  const __scrollCache = new Map();
  const __isScrollable = (el) => {
    if (!el || el === document.body || el === document.documentElement) return false;
    let hit = __scrollCache.get(el);
    if (hit === undefined) {
      let cs = null;
      try { cs = getComputedStyle(el); } catch (err) { cs = null; }
      const oy = cs ? cs.overflowY : '', ox = cs ? cs.overflowX : '';
      const canY = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 4;
      const canX = (ox === 'auto' || ox === 'scroll' || ox === 'overlay') && el.scrollWidth > el.clientWidth + 4;
      hit = canY || canX;
      __scrollCache.set(el, hit);
    }
    return hit;
  };
  const __scrollDepth = (e) => {
    let p = e.parentElement, depth = 0, guard = 0;
    while (p && p !== document.body && p !== document.documentElement && guard < 64) {
      if (__isScrollable(p)) return depth + 1;
      depth += 1; guard += 1; p = p.parentElement;
    }
    return 0;
  };
  /** 候选的窗口归属（见 POOL_QUOTAS 的注释；chrome 不受视口限制）。 */
  const __classify = (e, main) => {
    const rect = __rectOf(e);
    const inViewport = __inSpan(rect, __vw * 0.15, __vh * 0.15);
    const nearViewport = __inSpan(rect, __vw * 1.5, __vh * 1.5);
    let bucket;
    if (__isChrome(e)) bucket = 'chrome';
    else if (inViewport) bucket = 'viewport';
    else if (nearViewport) bucket = 'contentNear';
    else if (main) bucket = 'mainOffscreen';
    else bucket = 'other';
    const scrollDepth = __scrollDepth(e);
    return { rect: rect, inViewport: inViewport, nearViewport: nearViewport,
             scrollDepth: scrollDepth, inScrollContainer: scrollDepth > 0,
             bucket: bucket, prio: __BUCKET_RANK[bucket] };
  };
`;

/**
 * A2 窗口透明化：页面上**可见**的交互元素里，有多少没进本次元素池（被窗口/排序挤掉），
 * 以及它们的标签/桶。inspect 用它渲染 `window` 小节，避免 Agent 把"窗口外"误读成"页面没有"。
 */
export const WINDOW_AUDIT_JS = String.raw`(arg) => {
  ${BUCKET_HELPERS_JS}
  const WS = /[ \t\n\r\f\v]+/g;
  const norm = (t) => (t || '').replace(/[\uE000-\uF8FF]/g, '').replace(WS, ' ').trim();
  const all = [];
  __collectAll(document, arg.sel, all);
  const out = [];
  const counts = {};
  const cats = arg.cats || [];
  const surfaceOf = (e) => {
    for (let k = 0; k < cats.length; k++) {
      try { if (e.matches(cats[k][1])) return cats[k][0]; } catch (err) { /* 非法片段：跳过 */ }
    }
    return '';
  };
  let visible = 0;
  for (const e of all) {
    const hasBox = (() => { const r = e.getClientRects(); for (let k = 0; k < r.length; k++) if (r[k].width > 0 && r[k].height > 0) return true; return false; })();
    let vis;
    if (e.checkVisibility) vis = hasBox && e.checkVisibility({checkVisibilityCSS: true, checkOpacity: false});
    else { const cs = getComputedStyle(e); vis = cs.display !== 'none' && cs.visibility !== 'hidden' && hasBox; }
    if (!vis) continue;
    visible += 1;
    const cat = surfaceOf(e);
    if (cat) counts[cat] = (counts[cat] || 0) + 1;
    if (e.getAttribute('data-dshref')) continue;   // A4 章：该元素已在本次池里
    const tag = e.tagName.toLowerCase();
    const label = norm(e.getAttribute('aria-label') || e.getAttribute('title') || e.innerText || e.getAttribute('placeholder') || e.getAttribute('value') || '').slice(0, 40);
    if (!label && (tag === 'a' || tag === 'button')) continue;
    const main = (!e.closest('nav, aside, footer, header') && !!e.closest('main, [role=main], article'));
    const cls = __classify(e, main);
    out.push({ tag: tag, label: label, prio: cls.prio, bucket: cls.bucket });
  }
  out.sort((a, b) => a.prio - b.prio);
  const limit = arg.limit > 0 ? arg.limit : 10;
  return { visible_interactive: visible, out_of_window_total: out.length,
           out_of_window: out.slice(0, limit), surface_counts: counts };
}`;

/**
 * A2 `viewport_underloaded` 事实：失败路径上一次廉价探测——有可滚动容器而它的内容远高于
 * 可视高度（虚拟列表/懒渲染的典型形态）。目标"找不到"到底是页面没有、还是**没渲染**，
 * 这条事实让停因自己说清楚（不猜、不自动滚动）。
 */
export const VIEWPORT_UNDERLOAD_JS = String.raw`(arg) => {
  const minOverflow = arg.minOverflow > 0 ? arg.minOverflow : 200;
  const hits = [];
  const all = document.querySelectorAll('*');
  for (const el of all) {
    if (el.scrollHeight > el.clientHeight + minOverflow && el.clientHeight > 40) {
      const cs = getComputedStyle(el);
      const oy = cs.overflowY;
      const scrollable = oy === 'auto' || oy === 'scroll' || oy === 'overlay' || el === document.scrollingElement;
      if (scrollable) {
        hits.push({ tag: el.tagName.toLowerCase(), id: el.id || '',
                    scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, rendered: el.children.length });
      }
    }
    if (hits.length >= arg.limit) break;
  }
  return hits;
}`;

/**
 * 可读标签的**唯一 JS 实现**（EXTRACT_JS 的池行与 OBSERVE_JS 的只读观察共用）。
 *
 * `labelOfRaw` 返回**不截断**的完整标签：池行在调用点自己 `.slice(0, 200)`（`full_label`
 * 的 200 上限是 A2 的匹配口径，不是标签本身的长度），observe/inspect 才能真正看到
 * 超过 200 字符的标签。两处若各写一份，长标签会在一面被悄悄截断——P0-A 之前的
 * inspect「label ~200 字截断」正是这种漂移。
 */
export const LABEL_HELPERS_JS = String.raw`
  const WS = /[ \t\n\r\f\v]+/g;
  // Material/Google 的图标是 private-use 字形（\ue8ba 等），会出现在按钮文本里；
  // 它是装饰，不是人可读标签。先剥掉 PUA 再折叠空白，否则 Hotels 按钮的 label 会是
  // \ue8baHotels，ctx.hints("Hotels") 匹配不到（Google Maps 实测）。
  const norm = (t) => (t || '').replace(/[\uE000-\uF8FF]/g, '').replace(WS, ' ').trim();
  const labelOfRaw = (e, tag) => {
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
    return norm(label);
  };
`;

/**
 * ONE round trip for the whole page: tag, label (incl. <label>-wrapper text),
 * data-test, name, id, input type, href, visibility and the main-content flag,
 * ordered main-content-first, each winner stamped with `data-dshref` in the same
 * pass so the element list, scan index and locator handle are single-sourced.
 *
 * A4：章值是**批次型**的（`af<批>-e<位>`），本趟提取开头先清掉上一轮的旧章
 * （一次全页 querySelectorAll，只为不残留位置性 ref）。旧章残留会让同一个
 * `[data-dshref="e2"]` 命中两个节点——按章取元素的动作层没有别的唯一性判据。
 */
export const EXTRACT_JS = String.raw`(arg) => {
  ${BUCKET_HELPERS_JS}
  ${LABEL_HELPERS_JS}
  const sel = arg.sel, max = arg.max;
  // A2：分桶配额（null = main-first 旧行为，policy.candidate_priority 的回退面）。
  const quotas = arg.quotas || null;
  const all = [];
  __collectAll(document, sel, all);
  // A2：池行的 full_label 是**匹配口径**（≤200）——模型视图仍用前 40，但 hint 匹配/诊断
  // 需要完整串（aria-label="Sort by, Not selected" 的前 40 往往截在逗号前，裸词 "Sort by"
  // 就匹配不到）。完整标签见 labelOfRaw：只有 observe/inspect 的观察面才需要它
  // （inspect 传 arg.fullLabel=true）。
  const labelOf = (e, tag) => labelOfRaw(e, tag).slice(0, 200);
  const short = (t) => String(t || '').slice(0, 40);
  let rows = [];
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
      const lrFull = labelOf(e, tag);
      labelRows.push({ i: i, tag: tag, label: short(lrFull), full_label: lrFull,
        main: (!e.closest('nav, aside, footer, header') && !!e.closest('main, [role=main], article')),
        data_test: e.getAttribute('data-test') || '', name: '', id: e.id || '', input_type: '',
        role: '', content_editable: false, draggable: false, href: '', assoc: assoc });
      continue;
    }
    const fullLabel = labelOf(e, tag);
    if ((tag === 'a' || tag === 'button') && !fullLabel) continue;
    const href = e.getAttribute('href') || '';
    rows.push({i: i, tag: tag, label: short(fullLabel), full_label: fullLabel,
               main: (!e.closest('nav, aside, footer, header') && !!e.closest('main, [role=main], article')),
               data_test: e.getAttribute('data-test') || '', name: e.getAttribute('name') || '',
               id: e.id || '', input_type: (e.getAttribute('type') || '').toLowerCase(),
               role: (e.getAttribute('role') || '').toLowerCase(),
               content_editable: e.isContentEditable ? true : false,
               draggable: (e.getAttribute('draggable') || '').toLowerCase() === 'true',
               href: href ? href.split('?')[0].replace(/\/+$/, '').split('/').slice(-2).join('/') : '',
               href_full: href});
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
    const wlFull = labelOf(w, 'label') || labelOf(e, 'input');
    rows.push({ i: wi, tag: w.tagName.toLowerCase(), label: short(wlFull), full_label: norm(wlFull).slice(0, 200), main: false,
      data_test: w.getAttribute('data-test') || '', name: e.getAttribute('name') || '',
      id: w.id || e.id || '', input_type: (e.getAttribute('type') || '').toLowerCase(),
      role: (w.getAttribute('role') || '').toLowerCase(), content_editable: false, draggable: false, href: '' });
    stamped.add(wi);
  }
  // U3：类目标记（只作旁路统计/cap，不进模型候选投影）。按 POOL_FRAGMENTS 顺序首匹配。
  const cats = arg.cats || [];
  const surfaceOf = (e) => {
    for (let k = 0; k < cats.length; k++) {
      try { if (e.matches(cats[k][1])) return cats[k][0]; } catch (err) { /* 非法片段：跳过 */ }
    }
    return '';
  };
  for (const r of rows) { const el = all[r.i]; if (el) r.surface = surfaceOf(el); }
  // U3：类目窗口 cap —— **在 slice(max) 之前**裁（§5.3）。裁掉的元素不盖章，
  // windowAudit 的 out_of_window_total 会自然把它们报成"窗口外剩余"（见 WINDOW_AUDIT_JS）。
  const caps = arg.caps || {};
  const capSeen = {};
  const capped = [];
  for (const r of rows) {
    const cat = r.surface || '';
    const cap = typeof caps[cat] === 'number' ? caps[cat] : -1;
    if (cap >= 0) {
      const n = capSeen[cat] || 0;
      if (n >= cap) continue;
      capSeen[cat] = n + 1;
    }
    capped.push(r);
  }
  rows = capped;
  // A2：先给每个候选补窗口/几何字段（bucket/prio 由同一份 __classify 产出，不另写口径）。
  for (const r of rows) {
    const el = all[r.i];
    if (!el) continue;
    const cls = __classify(el, r.main === true);
    r.rect = { top: cls.rect.top, left: cls.rect.left, width: cls.rect.width, height: cls.rect.height };
    r.inViewport = cls.inViewport;
    r.nearViewport = cls.nearViewport;
    r.scrollDepth = cls.scrollDepth;
    r.inScrollContainer = cls.inScrollContainer;
    r.bucket = cls.bucket;
    r.prio = cls.prio;
  }
  let ordered;
  if (!quotas) {
    // main-first 回退面（meta.policy.candidate_priority:"main-first"）：与 A2 之前逐字节同序。
    ordered = rows.filter((r) => r.main).concat(rows.filter((r) => !r.main)).slice(0, max);
  } else {
    // 分桶配额：每桶按 DOM 序取至多 quota 个 → 不足部分按 BUCKET_FILL_ORDER 顺延 → 截断 max。
    const byBucket = { chrome: [], viewport: [], contentNear: [], mainOffscreen: [], other: [] };
    for (const r of rows) {
      const b = r.bucket || 'other';
      (byBucket[b] || byBucket.other).push(r);
    }
    const picked = [];
    const taken = { chrome: 0, viewport: 0, contentNear: 0, mainOffscreen: 0, other: 0 };
    for (const b of ['chrome', 'viewport', 'contentNear', 'mainOffscreen', 'other']) {
      const q = typeof quotas[b] === 'number' ? quotas[b] : 0;
      const arr = byBucket[b] || [];
      const n = Math.min(q, arr.length);
      for (let k = 0; k < n; k++) picked.push(arr[k]);
      taken[b] = n;
    }
    if (picked.length < max) {
      for (const b of ['viewport', 'contentNear', 'mainOffscreen', 'other', 'chrome']) {
        if (picked.length >= max) break;
        const arr = byBucket[b] || [];
        for (let k = taken[b] || 0; k < arr.length && picked.length < max; k++) picked.push(arr[k]);
      }
    }
    ordered = picked.slice(0, max);
  }
  // A4：盖章前先清掉上一轮的旧章。ref 是**位置性**的（e0/e1…），而页面元素会换位
  //（列表插入/滚动重排/SPA 复用 DOM）：不清章时同一个元素身上还挂着旧 ref，本轮
  // 另一个元素又拿到同一个 ref，[data-dshref="e2"] 就会命中两个节点——按章取元素
  // 从"点错"退化到 Playwright strict mode 直接报错。一次全页 querySelectorAll 的开销
  // 远小于一次误点，且只在提取期付。
  try {
    document.querySelectorAll('[data-dshref]').forEach((e) => e.removeAttribute('data-dshref'));
  } catch (err) { /* 清理失败不阻断提取：nonce 仍保证新章不撞旧章 */ }
  // nonce：页内全局递增的批次号，章值 = 批次-位置（如 af3-e2）。旧批次章在清章后
  // 不残留，跨两次提取也不会共用同一个选择器；同一页多次提取共享计数，所以挂
  // globalThis（跨导航自动重置——旧 DOM 已经不在了，重号无害）。
  const nonce = 'af' + ((globalThis.__afStamp = (globalThis.__afStamp | 0) + 1));
  return ordered.map((r, pos) => {
    const ref = 'e' + pos;
    const stamp = nonce + '-' + ref;
    const el = all[r.i];
    el.setAttribute('data-dshref', stamp);
    // P0-A inspect 观察面（显式 opt-in，缺省不出字段 ⇒ 池/模型面/既有产物逐字节不变）：
    //   classNames=true → class_names（有界：≤8 个、每项 ≤40 字符，与 ctx.observe 同口径）；
    //   fullLabel=true  → label_full（**不截断**的完整标签；full_label 仍是 ≤200 的匹配口径）。
    const classNames = arg.classNames && el && el.classList
      ? Array.from(el.classList).slice(0, 8).map((c) => String(c).slice(0, 40))
      : null;
    const labelFull = arg.fullLabel && el ? labelOfRaw(el, r.tag) : null;
    return {ref: ref, dsh_ref: stamp, scan: r.i, tag: r.tag, label: r.label, full_label: r.full_label,
            ...(classNames && classNames.length ? {class_names: classNames} : {}),
            ...(labelFull ? {label_full: labelFull} : {}),
            rect: r.rect, inViewport: r.inViewport, nearViewport: r.nearViewport,
            scrollDepth: r.scrollDepth, inScrollContainer: r.inScrollContainer, bucket: r.bucket, prio: r.prio,
            data_test: r.data_test, name: r.name, id: r.id, input_type: r.input_type, href: r.href,
            ...(r.href_full ? {href_full: r.href_full} : {}),
            ...(r.surface ? {surface: r.surface} : {}),
            ...(r.role ? {role: r.role} : {}),
            ...(r.content_editable ? {content_editable: true} : {}),
            ...(r.draggable ? {draggable: true} : {})};
  });
}`;

/**
 * P0-A `ctx.observe()` 的**只读 DOM 观察**（每帧一次 evaluate；不盖章、不点击、不滚动、
 * 不写任何属性）。
 *
 * 与 EXTRACT_JS 的分工：EXTRACT_JS 产**池**（窗口/分桶/盖章/排序，是动作目标的世界）；
 * 本 pass 产**观察**（DOM 侧真实存在，不要求入池）——准入面元素 + `arg.includeHidden`
 * 时的隐藏元素。两者共用 `LABEL_HELPERS_JS`（同口径完整标签）与同一份可见性判据
 * （checkVisibility CSS + 非零盒），避免"观察面说可见、池子说不入池"的漂移。
 *
 * 返回 `{rows, total, returned}`；`total` 是**通过可见性过滤的候选总数**（截断前）——
 * 调用方用它算 `counts.omitted`（被 max 上限截掉的数，不是"页面没有"）。
 * 非法 CSS 返回 `{bad_selector: message}`（结构化，不抛裸栈）。
 * `in_surface` 用当前生效的准入选择器（ADMIT_SEL 投影 + JS 探针后缀）现场匹配。
 */
export const OBSERVE_JS = String.raw`(arg) => {
  ${LABEL_HELPERS_JS}
  const sel = arg.sel, max = arg.max, includeHidden = arg.includeHidden === true;
  const all = [];
  try { __collectAll(document, sel, all); }
  catch (err) { return { bad_selector: String(err && err.message ? err.message : err) }; }
  const rows = [];
  let candidates = 0;
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    const hasBox = (() => {
      const r = e.getClientRects();
      for (let k = 0; k < r.length; k++) if (r[k].width > 0 && r[k].height > 0) return true;
      return false;
    })();
    let vis;
    if (e.checkVisibility) vis = hasBox && e.checkVisibility({checkVisibilityCSS: true, checkOpacity: false});
    else { const cs = getComputedStyle(e); vis = cs.display !== 'none' && cs.visibility !== 'hidden' && hasBox; }
    if (!vis && !includeHidden) continue;
    candidates += 1;
    if (rows.length >= max) continue;
    const tag = e.tagName.toLowerCase();
    let classes = [];
    try { classes = e.classList ? Array.from(e.classList) : String(e.getAttribute('class') || '').split(/\s+/); }
    catch (err) { classes = []; }
    classes = classes.filter(function (c) { return !!c; }).slice(0, 8).map(function (c) { return String(c).slice(0, 40); });
    let inSurface = false;
    try { inSurface = !!arg.admitSel && e.matches(arg.admitSel); } catch (err) { inSurface = false; }
    const r = e.getBoundingClientRect();
    const href = e.getAttribute('href') || '';
    rows.push({
      tag: tag,
      role: (e.getAttribute('role') || '').toLowerCase(),
      label: labelOfRaw(e, tag),
      id: e.id || '',
      name: e.getAttribute('name') || '',
      data_test: e.getAttribute('data-test') || '',
      type: (e.getAttribute('type') || '').toLowerCase(),
      href: href,
      class_names: classes,
      visible: vis,
      bbox: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      in_surface: inSurface,
    });
  }
  return { rows: rows, total: candidates, returned: rows.length };
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
/** P0-A：只有读的观察 pass（每帧一次往返；不盖章/不写 DOM）。 */
const PASS_OBSERVE = compile("arg", `${COLLECT_JS}\nreturn (${OBSERVE_JS})(arg);`);
/** A2：窗口透明化（inspect 用）：可见交互总数 + 被挤出窗口的候选（≤10）。 */
const PASS_WINDOW = compile("arg", `${COLLECT_JS}\nreturn (${WINDOW_AUDIT_JS})(arg);`);
/** A2：失败路径的 viewport_underloaded 事实（只读 DOM，一次扫描，提前退出）。 */
const PASS_UNDERLOAD = compile("arg", `return (${VIEWPORT_UNDERLOAD_JS})(arg);`);
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
/**
 * target_hint recovery pass (stamps data-hintref in the same pass). A4：章值同样是
 * 批次型的（`af<批>-h<n>`），本趟开头先清旧章——理由见 EXTRACT_JS 的注释：
 * 位置性 ref 的旧章留在换位后的 DOM 上，会让按章取元素命中多个/错位的节点。
 */
const HINT_HEAD = String.raw`(arg) => {
            const all = [], p = arg.parsed, h = arg.hint;
            __collectAll(document, arg.sel, all);
            // A4：与主池同法——先清旧 hint 章再盖新章，章值带页内递增 nonce
            //（af3-h0，与主池共用 __afStamp 计数）。回捞是同一子目标内的重复调用
            //（每个 target_hint 一次、宽扫/复观察再一次），不清章会留下上一轮的 hN：
            // 旧章在 DOM 换位后可能命中另一节点，按章取元素就会点错。
            try {
                document.querySelectorAll('[data-hintref]').forEach((e) => e.removeAttribute('data-hintref'));
            } catch (err) { /* 清理失败不阻断回捞：nonce 保证新章不与旧章同名 */ }
            const nonce = 'af' + ((globalThis.__afStamp = (globalThis.__afStamp | 0) + 1));
            const labelOf = (e) => {
                const first = e.childNodes.length ? String(e.childNodes[0].textContent||'').trim() : '';
                return (e.getAttribute('aria-label') || e.getAttribute('title') || first ||
                        (e.innerText||'').trim() || e.placeholder || e.value || '').replace(/\s+/g,' ').trim();
            };
            // A2：裸词按「大小写不敏感 + 词边界/前缀」匹配**完整**标签（不是 CSS，也不是整串全等）：
            // aria-label="Sort by, Not selected" 必须能被 "Sort by" 命中（逗号/句点/冒号边界同样算词尾）。
            const bareHit = (lab, dt, tok) => {
                if (!tok) return false;
                if (dt === tok || dt.indexOf('-' + tok) >= 0) return true;
                if (lab === tok || lab.split(/\s+/).indexOf(tok) >= 0) return true;
                if (lab.indexOf(tok) === 0) {
                    const next = lab.charAt(tok.length);
                    if (next === '' || next === ' ' || ',.:;!?'.indexOf(next) >= 0) return true;
                }
                if (lab.indexOf(' ' + tok + ' ') >= 0 || lab.slice(-(tok.length + 1)) === ' ' + tok) return true;
                for (const sep of [',', '.', ':', ';', '!', '?']) {
                    if (lab.indexOf(' ' + tok + sep) >= 0) return true;
                }
                return false;
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
                    if (bareHit(lab, dt, tok)) hits.push(i);
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
                    const stamp = nonce + '-' + ref;
                    e.setAttribute('data-hintref', stamp);
                    return {hint_ref: stamp, scan: i, tag: e.tagName.toLowerCase(),
                            dsh_ref: e.getAttribute('data-dshref') || '',
                            label: labelOf(e).slice(0, 40), full_label: labelOf(e).slice(0, 200),
                            data_test: e.getAttribute('data-test') || '',
                            name: e.getAttribute('name') || '', id: e.id || '',
                            input_type: (e.getAttribute('type') || '').toLowerCase(),
                            href: href ? href.split('?')[0].replace(/\/+$/,'').split('/').slice(-2).join('/') : '',
                            ...(href ? {href_full: href} : {})};
                }); }`;
const PASS_HINT = compile("arg", COLLECT_JS + `\nreturn (${HINT_HEAD})(arg);`);
/**
 * P0-D：**只读**探测用的 hint 收集（同一套 hint 语义，但**不盖** `data-hintref` 章）。
 * 只用于"声明目标是否仅存在于被排除 frame"的复核——绝不动作、绝不进池。
 */
const PASS_HINT_PROBE = compile("arg",
  COLLECT_JS + `\nreturn (${HINT_HEAD.replace("e.setAttribute('data-hintref', stamp);", "")})(arg);`);
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
  opts?: {
    widgets?: boolean;
    /**
     * A2 分桶配额（缺省按预算档自动选：≤40 用 POOL_QUOTAS，>40 用 WIDE_QUOTAS）。
     * `null` = main-first 旧行为（policy.candidate_priority 的回退面）。
     */
    quotas?: PoolQuotas | null;
    /** A2：`meta.policy.candidate_priority`（缺省 "bucketed"；"main-first" = 回退旧排序）。 */
    candidatePriority?: "bucketed" | "main-first";
    /** U3：`meta.policy.surface.native_activation`（缺省 window；"off" = 池构成回到 U3 之前）。 */
    surface?: SurfacePolicy;
    /**
     * P0-A（inspect 观察面 opt-in，缺省 false = 池行逐字节不变）：给每行补
     * `class_names`（≤8 个、每项 ≤40 字符）与 `label_full`（不截断的完整标签）。
     */
    classNames?: boolean;
    fullLabel?: boolean;
    /**
     * P0-D：host 信封。给了就**只从信封内的 frame** 抽池（主 frame 恒在面内），被排除
     * frame 的真实下标仍保留（`frame`/`f<fi>:` ref 不变）；缺省 = 今天的全帧面。
     */
    hosts?: string[] | null;
  },
): Promise<ElemPool> {
  // 缺省 bucketed；main-first 显式回退。quota 由预算档决定（40/120 两档常量单一出处）。
  const quotas = opts?.candidatePriority === "main-first"
    ? null
    : (opts?.quotas !== undefined
      ? opts.quotas
      : (maxElements > MAX_ELEMENTS ? WIDE_QUOTAS : POOL_QUOTAS));
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
    if (fi > 0 && !frameInHostsEnvelope(frames[fi]!, opts?.hosts)) continue;   // P0-D：排除帧不进池
    let rows: Elem[] | null = null;
    try {
      rows = (await frames[fi]!.evaluate(PASS_EXTRACT,
        { sel: poolSelectorWithJsFor(opts?.surface), max: remaining, quotas,
          cats: SURFACE_SELECTORS, caps: WINDOW_CAPS,
          // P0-A：只有 inspect 传这两个开关；不传 ⇒ 参数对象与今天逐字节同形。
          ...(opts?.classNames === true ? { classNames: true } : {}),
          ...(opts?.fullLabel === true ? { fullLabel: true } : {}) })) as Elem[] | null;
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

/** P0-A：一帧的原始观察行（JS 侧字段；`frame`/序号由 host 补）。 */
export interface ObserveRawRow {
  tag: string;
  role?: string;
  label?: string;
  id?: string;
  name?: string;
  data_test?: string;
  type?: string;
  href?: string;
  class_names?: string[];
  visible?: boolean;
  bbox?: { x: number; y: number; w: number; h: number };
  in_surface?: boolean;
  frame?: number;
}

/** frame.url 可能是属性或方法（Playwright 两种形状都见过）；读不到就是空串。 */
function frameUrlOf(f: FrameLike): string {
  try {
    const u = typeof f.url === "function" ? f.url() : f.url;
    return typeof u === "string" ? u : "";
  } catch {
    return "";
  }
}

/**
 * P0-A `ctx.observe()` 的 read-only 采集层：每帧一次 `page.evaluate`（`PASS_OBSERVE`），
 * 不发动作、不盖章、不滚动、不等待。返回原始行 + 帧 URL 摘要。
 *
 * 纪律：
 *   - **不调用 extractElements / jsInteractiveWidgets**（CDP 探针会盖章 `data-js-ref`，
 *     那是对页面的写；observe 只读）。默认选择器 = 当前生效的准入面（ADMIT_SEL 投影 +
 *     已有的 `[data-js-ref]` 后缀——引擎上一趟抽池盖过章的元素会自然出现在这里）；
 *   - `selector` 给定时用它（任意 CSS，只读）；非法 CSS 由页面函数结构化返回，不抛栈；
 *   - 最多 `framesOf(page, 6)` 帧（主 frame 在前）；`max` 是**所有帧合计**的上限，
 *     主 frame 先用，子 frame 用剩余额度；
 *   - `total` 是可见性过滤后的候选总数（截断前），调用方用它算 `counts.omitted`。
 */
export async function observeElements(
  page: PageLike,
  opts: {
    selector?: string; max: number; includeHidden?: boolean; includeFrames?: boolean;
    surface?: SurfacePolicy;
  },
): Promise<{ rows: ObserveRawRow[]; total: number; frames: string[]; badSelector?: string }> {
  const sel = opts.selector ?? admitSelectorWithJsFor(opts.surface);
  const admitSel = admitSelectorWithJsFor(opts.surface);
  const allFrames = framesOf(page);
  const frames = opts.includeFrames === false ? allFrames.slice(0, 1) : allFrames;
  // 只列**实际评估过**的帧（includeFrames:false 或 max 提前用尽时，列表不虚报子 frame）；
  // `row.frame` 就是这里的下标。
  const frameUrls: string[] = [];
  const rows: ObserveRawRow[] = [];
  let total = 0;
  let remaining = opts.max;
  type ObserveRawResult = { rows?: ObserveRawRow[]; total?: number; bad_selector?: string };
  for (let fi = 0; fi < frames.length; fi++) {
    if (remaining <= 0) break;
    frameUrls.push(frameUrlOf(frames[fi]!));
    let raw: ObserveRawResult | null = null;
    try {
      raw = (await frames[fi]!.evaluate(PASS_OBSERVE, {
        sel, max: remaining, includeHidden: opts.includeHidden === true, admitSel,
      })) as ObserveRawResult | null;
    } catch {
      raw = null;   // frame detached / 无执行上下文：跳过（与 extractElements 同口径）
    }
    if (raw === null) continue;
    if (typeof raw.bad_selector === "string") {
      return { rows: [], total: 0, frames: frameUrls, badSelector: raw.bad_selector };
    }
    for (const row of raw.rows ?? []) {
      row.frame = fi;
      rows.push(row);
    }
    total += Number(raw.total ?? 0) || 0;
    remaining = opts.max - rows.length;
  }
  return { rows, total, frames: frameUrls };
}

/**
 * A2：`inspect --json` 的 `window` 小节数据——页面上可见的交互元素总数、以及**没进本次池**
 * 的那些（被 40/120 窗口或分桶顺序挤出；≤limit 条，按桶优先级排序）。
 * `shown` 由调用方给（池大小），这里只回答"页面有多少 / 窗口外还有哪些"。
 */
export async function windowAudit(
  page: PageLike, shown: number, limit = 10,
): Promise<{ visible_interactive: number; shown: number; out_of_window_total: number; out_of_window: Array<{ tag: string; label: string; prio: number; bucket: string }>; surface_counts: Record<string, number> }> {
  type WindowRaw = { visible_interactive?: number; out_of_window_total?: number; out_of_window?: unknown; surface_counts?: unknown };
  let raw: WindowRaw | null = null;
  try {
    // U3：只读计数面用 ADMIT_SEL（不是池基准）；绝不用它的下标当 scan。
    raw = (await page.evaluate!(PASS_WINDOW, { sel: admitSelectorWithJsFor(), limit, cats: SURFACE_SELECTORS })) as WindowRaw | null;
  } catch {
    raw = null;
  }
  const rows = Array.isArray(raw?.out_of_window) ? (raw!.out_of_window as Array<Record<string, unknown>>) : [];
  const counts: Record<string, number> = {};
  if (raw?.surface_counts && typeof raw.surface_counts === "object") {
    for (const [k, v] of Object.entries(raw.surface_counts as Record<string, unknown>)) {
      const n = Number(v) || 0;
      if (n > 0) counts[k] = n;
    }
  }
  return {
    visible_interactive: Number(raw?.visible_interactive ?? 0) || 0,
    shown,
    out_of_window_total: Number(raw?.out_of_window_total ?? 0) || 0,
    surface_counts: counts,
    out_of_window: rows.slice(0, limit).map((r) => ({
      tag: String(r["tag"] ?? ""),
      label: String(r["label"] ?? ""),
      prio: Number(r["prio"] ?? 0) || 0,
      bucket: String(r["bucket"] ?? ""),
    })),
  };
}

/**
 * U3 readiness 证据：池空/失败路径上**一次**廉价只读探测（主 frame 一次 evaluate，零新增往返
 * 于非空路径）。回答"页面已就绪但池空时，ADMIT_SEL 能数到几个 / 可聚焦几个 / ARIA 几个 / 正文多长"，
 * 让 `ready_empty` 的 warning 与 `not_ready` 的证据能区分「页面没有交互事实」与「准入面未覆盖」。
 * `frames` = 本次池抽取可见的 frame 数（sniff 本身只跑主 frame，如实标注）。
 */
export async function poolSniff(page: PageLike, sel: string = ADMIT_SEL): Promise<{
  admitted: number; focusable: number; aria: number; frames: number; body_text: number; ready_state: string;
}> {
  type SniffRaw = { admitted?: number; focusable?: number; aria?: number; body_text?: number; ready_state?: string };
  let raw: SniffRaw | null = null;
  try {
    raw = (await page.evaluate!((arg: { sel: string }) => {
      const g = globalThis as unknown as { document: any };
      const visibleCount = (sel: string): number => {
        let n = 0;
        try {
          for (const e of Array.from(g.document.querySelectorAll(sel) as ArrayLike<any>)) {
            const r = typeof e.getClientRects === "function" ? e.getClientRects() : [];
            let box = false;
            for (let k = 0; k < r.length; k++) if (r[k].width > 0 && r[k].height > 0) { box = true; break; }
            if (!box) continue;
            let cv = true;
            try { if (typeof e.checkVisibility === "function") cv = e.checkVisibility({ checkVisibilityCSS: true, checkOpacity: false }); } catch { cv = true; }
            if (cv) n += 1;
          }
        } catch { /* 非法选择器：0 */ }
        return n;
      };
      const count = (sel: string): number => {
        try { return g.document.querySelectorAll(sel).length; } catch { return 0; }
      };
      const body = g.document.body;
      return {
        admitted: visibleCount(arg.sel),
        focusable: count("[tabindex]"),
        aria: count("[role], [aria-expanded], [aria-haspopup], [aria-label]"),
        body_text: String(body ? body.innerText || "" : "").trim().length,
        ready_state: String(g.document.readyState || "unknown"),
      };
    }, { sel })) as SniffRaw | null;
  } catch {
    raw = null;
  }
  let frames = 1;
  try { frames = Math.max(1, framesOf(page).length); } catch { frames = 1; }
  return {
    admitted: Number(raw?.admitted ?? 0) || 0,
    focusable: Number(raw?.focusable ?? 0) || 0,
    aria: Number(raw?.aria ?? 0) || 0,
    frames,
    body_text: Number(raw?.body_text ?? 0) || 0,
    ready_state: String(raw?.ready_state ?? "unknown"),
  };
}

/**
 * A2：`viewport_underloaded` 事实探测（只在 `target_not_found` 失败路径调用一次）：
 * 页面上存在"内容远高于可视高度"的可滚动容器 ⇒ 目标可能只是**没渲染**，不是页面没有。
 * 返回空数组 = 没有这类容器（事实不成立，停因不加这句）。
 */
export async function viewportUnderload(
  page: PageLike, minOverflow = 200, limit = 5,
): Promise<Array<{ tag: string; id: string; scrollHeight: number; clientHeight: number; rendered: number }>> {
  let raw: unknown;
  try {
    raw = await page.evaluate!(PASS_UNDERLOAD, { minOverflow, limit });
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, limit).map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      tag: String(o["tag"] ?? ""),
      id: String(o["id"] ?? ""),
      scrollHeight: Number(o["scrollHeight"] ?? 0) || 0,
      clientHeight: Number(o["clientHeight"] ?? 0) || 0,
      rendered: Number(o["rendered"] ?? 0) || 0,
    };
  });
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
      ref: `e${elems.length}`, scan: i, tag, label: label.slice(0, 40), full_label: label.slice(0, 200),
      data_test: (await el.getAttribute("data-test")) ?? "",
      name: (await el.getAttribute("name")) ?? "",
      id: (await el.getAttribute("id")) ?? "",
      input_type: ((await el.getAttribute("type")) ?? "").toLowerCase(),
      href: href ? href.split("?")[0]!.replace(/\/+$/, "").split("/").slice(-2).join("/") : "",
      ...(href ? { href_full: href } : {}),
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
  ${BUCKET_HELPERS_JS}
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
    const main = (!e.closest('nav, aside, footer, header') && !!e.closest('main, [role=main], article'));
    const cls = __classify(e, main);
    const full = norm(e.innerText || '').slice(0, 200);
    return { tag: tag, label: full.slice(0, 40), full_label: full, main: main,
      rect: { top: cls.rect.top, left: cls.rect.left, width: cls.rect.width, height: cls.rect.height },
      inViewport: cls.inViewport, nearViewport: cls.nearViewport,
      scrollDepth: cls.scrollDepth, inScrollContainer: cls.inScrollContainer,
      bucket: cls.bucket, prio: cls.prio,
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
      full_label: String(r["full_label"] ?? r["label"] ?? "").slice(0, 200),
      ...(typeof r["rect"] === "object" && r["rect"] !== null ? { rect: r["rect"] as Elem["rect"] } : {}),
      ...(typeof r["inViewport"] === "boolean" ? { inViewport: r["inViewport"] } : {}),
      ...(typeof r["nearViewport"] === "boolean" ? { nearViewport: r["nearViewport"] } : {}),
      ...(typeof r["scrollDepth"] === "number" ? { scrollDepth: r["scrollDepth"] } : {}),
      ...(typeof r["inScrollContainer"] === "boolean" ? { inScrollContainer: r["inScrollContainer"] } : {}),
      ...(typeof r["bucket"] === "string" ? { bucket: r["bucket"] as Elem["bucket"] } : {}),
      ...(typeof r["prio"] === "number" ? { prio: r["prio"] } : {}),
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
export function hintLookupArgs(hint: string, sel: string = admitSelectorWithJsFor()): { hint: string; parsed: ParsedHint; sel: string } {
  return { hint: hint.trim().toLowerCase(), parsed: parseHint(hint), sel };
}

export async function hintLookup(
  page: PageLike, hint: string, sel: string = admitSelectorWithJsFor(),
  opts?: { hosts?: string[] | null },
): Promise<ElemPool> {
  const out: ElemPool = {};
  const frames = framesOf(page);
  for (let fi = 0; fi < frames.length; fi++) {
    if (fi > 0 && !frameInHostsEnvelope(frames[fi]!, opts?.hosts)) continue;   // P0-D：排除帧不参与回捞
    let rows: Array<Record<string, unknown>> | null = null;
    try {
      rows = (await frames[fi]!.evaluate(PASS_HINT,
        hintLookupArgs(hint, sel))) as Array<Record<string, unknown>> | null;
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

/** P0-D：声明目标"只存在于被排除 frame"的只读探测结果（证据面）。 */
export interface ExcludedHintProbe {
  /** 被排除 frame 的 origin（去重；证据/reason 用）。 */
  origins: string[];
  /** 排除帧内的命中行（ref 是证据编号，不参与动作）。 */
  matches: Array<{
    ref: string; frame: number; tag: string; label: string;
    id?: string; data_test?: string;
  }>;
}

/**
 * P0-D：**只读探测**——在 host 信封排除的 frame 里找一条 hint 的匹配（不盖章、不动作）。
 * 返回 null = 没有排除帧 / 排除帧里也没有这条 hint（保持既有失败路径）。
 */
export async function probeExcludedHint(
  page: PageLike, hosts: string[] | null | undefined, hint: string,
  sel: string = admitSelectorWithJsFor(),
): Promise<ExcludedHintProbe | null> {
  const gate = frameGateOf(page, hosts);
  if (gate === null) return null;
  const matches: ExcludedHintProbe["matches"] = [];
  for (const { index, frame } of gate.excluded) {
    let got: unknown;
    try {
      got = await frame.evaluate(PASS_HINT_PROBE, hintLookupArgs(hint, sel));
    } catch {
      continue;                     // frame detached / 无执行上下文：跳过
    }
    for (const row of (Array.isArray(got) ? got : []) as Array<Record<string, unknown>>) {
      matches.push({
        ref: `xf${index}:${String(row["scan"] ?? matches.length)}`,
        frame: index,
        tag: String(row["tag"] ?? ""),
        label: String(row["label"] ?? ""),
        ...(String(row["id"] ?? "") ? { id: String(row["id"]) } : {}),
        ...(String(row["data_test"] ?? "") ? { data_test: String(row["data_test"]) } : {}),
      });
    }
  }
  if (matches.length === 0) return null;
  return { origins: gate.origins, matches };
}

/* ------------------------------------------- declared identity recovery (FW8) */

/**
 * FW8：**声明驱动的身份回捞**（identity recovery）。
 *
 * 问题：反应型框架（React/Vue）把 click 监听挂在根容器，叶子自绘控件自身没有可枚举属性
 * ——它既不在选择器闭集（池）里，也不在 ADMIT 准入面里，于是作者写下的稳定身份声明
 * （`act: ctx.hint("#leaf")` / 命令 target `#leaf`）在常规解析里永远落空。
 *
 * 边界（五条硬约束）：
 *   1. **只服务声明面**：唯一调用点是"这一步作者声明的目标"（命令 target / act hint /
 *      plan target_hint 同一执行器路径）；决策步与模型选出的元素**永不**走这里，回捞结果
 *      也绝不进入 `ChoiceRequest.elems` 或 done 判定。
 *   2. **形状白名单**：只认 `#id` / `tag[attr=value]` / `[attr=value]` 且 attr ∈
 *      {data-test, name, id}（精确值，大小写折叠与池侧一致）。`attrSubstr` / `tag~token` /
 *      角色词 / 裸词 / near 都不是身份声明——它们保持今天的失败路径。
 *   3. **恰好一个可见匹配**：跨 frame（与 `hintLookup` 的 `framesOf` 同口径）查询全部匹配；
 *      0 个 → 调用方保持今天的失败路径；>1 个可见 → 由调用方报结构化 `target_ambiguous`；
 *      全部不可见（checkVisibility CSS + 非零盒）→ 视为 0 并给出 hidden_matches 证据。
 *   4. **能力守门**由调用方用同一份 `actionCapabilities`/`elemFamily` 做（合成 Elem 与池
 *      同构，不另造能力判定）。
 *   5. **证据与不污染**：命中行盖 `data-hintref`（复用 `_locatorFor` 既有身份链），调用方
 *      用完必须 `cleanup()`（与 A3 `data-af-probe` 同纪律）。
 */
const IDENTITY_ATTRS: ReadonlySet<string> = new Set(["id", "data-test", "name"]);

export interface IdentityHintInfo {
  /** 形状是否被身份白名单接受；false ⇒ 调用方保持既有失败路径（绝不回捞）。 */
  eligible: boolean;
  /** `#id` / `tag[attr=value]` / `[attr=value]`（结构形状）；不是身份声明时是 parseHint 的 kind。 */
  shape: string;
  /** DOM 属性名（`id` / `data-test` / `name`）。 */
  attr: string;
  /** 解析后的比较值（parseHint 已全小写折叠；DOM 侧按大小写不敏感比较，与池侧一致）。 */
  value: string;
  /** `tag[attr=value]` 的 tag；`#id` / 裸属性形状为空串。 */
  tag: string;
}

/** FW8：判断一条 hint 是不是**身份声明**（白名单五条里的形状/属性两条）。纯函数。 */
export function identityHintInfo(hint: string): IdentityHintInfo {
  const parsed = parseHint(hint);
  const miss = (shape: string): IdentityHintInfo =>
    ({ eligible: false, shape, attr: "", value: "", tag: "" });
  if (parsed.kind === "id") {
    if (parsed.value === "") return miss("id");
    return { eligible: true, shape: "#id", attr: "id", value: parsed.value, tag: "" };
  }
  if (parsed.kind === "attrEq") {
    // `tag[attr=value]` 的 tag 必须是可表达的简单标签名；否则不是身份声明（不拿它去赌 CSS）。
    if (parsed.tag !== "" && !/^[a-z][a-z0-9-]*$/.test(parsed.tag)) return miss("attrEq");
    if (parsed.value === "" || !IDENTITY_ATTRS.has(parsed.attr)) return miss("attrEq");
    return {
      eligible: true,
      shape: parsed.tag ? `${parsed.tag}[${parsed.attr}=value]` : `[${parsed.attr}=value]`,
      attr: parsed.attr,
      value: parsed.value,
      tag: parsed.tag,
    };
  }
  return miss(parsed.kind);
}

/** FW8：一个 DOM 侧匹配候选（可见与隐藏都在这里；歧义/隐藏诊断用）。 */
export interface IdentityCandidate {
  tag: string;
  label: string;
  id: string;
  frame: number;
  visible: boolean;
}

export interface IdentityLookupResult {
  eligible: boolean;
  shape: string;
  attr: string;
  value: string;
  /** 可见命中行（0/1；>1 由调用方判歧义）。恰好 1 行时它已盖 `data-hintref` 章。 */
  rows: Elem[];
  /** 匹配到但不可见（CSS 可见性或零盒）的数量——绝不操作隐藏元素，只作诊断证据。 */
  hidden_matches: number;
  /** 全部匹配数（可见 + 隐藏）。 */
  total_matches: number;
  /** 全部匹配的摘要（含隐藏；不含章/locator）。 */
  candidates: IdentityCandidate[];
  /** 清理本次盖下的章（只删仍是本批次值的节点；候选 0/多或失败时为空操作）。 */
  cleanup: () => Promise<void>;
}

/** FW8：候选摘要的人读文案（`target_ambiguous` 的 reason 与 trace 证据共用一份）。 */
export function formatIdentityCandidates(c: IdentityCandidate[]): string {
  return c.map((x) =>
    `${x.tag}${x.id ? `#${x.id}` : ""} "${x.label}" (frame=${x.frame}, visible=${x.visible})`).join("; ");
}

/** FW8：跨 frame 的身份精确查询（形状/可见性/标签一次算完；不盖章）。 */
const IDENTITY_PROBE_JS = String.raw`(arg) => {
  const attr = arg.attr, want = String(arg.value).toLowerCase(), tag = arg.tag || '';
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const sel = (tag || '*') + '[' + attr + '="' + esc(arg.value) + '" i]';
  let all = [];
  try { all = Array.prototype.slice.call(document.querySelectorAll(sel)); }
  catch (e) { return {rows: []}; }
  const labelOf = (e) => {
    const first = e.childNodes.length ? String(e.childNodes[0].textContent || '').trim() : '';
    return (e.getAttribute('aria-label') || e.getAttribute('title') || first ||
            (e.innerText || '').trim() || e.placeholder || e.value || '').replace(/\s+/g, ' ').trim();
  };
  const rows = [];
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    if (String(e.getAttribute(attr) || '').toLowerCase() !== want) continue;
    let visible = true;
    try {
      visible = e.checkVisibility ? e.checkVisibility({checkVisibilityCSS: true}) : true;
      if (visible) { const r = e.getBoundingClientRect(); visible = r.width > 0 && r.height > 0; }
    } catch (err) { visible = false; }
    const href = e.getAttribute('href') || '';
    rows.push({
      index: i, visible: visible,
      tag: e.tagName.toLowerCase(), label: labelOf(e).slice(0, 40), full_label: labelOf(e).slice(0, 200),
      id: e.id || '', name: e.getAttribute('name') || '', data_test: e.getAttribute('data-test') || '',
      input_type: (e.getAttribute('type') || '').toLowerCase(),
      role: (e.getAttribute('role') || '').toLowerCase(),
      content_editable: e.isContentEditable ? true : false,
      draggable: (e.getAttribute('draggable') || '').toLowerCase() === 'true',
      href: href ? href.split('?')[0].replace(/\/+$/, '').split('/').slice(-2).join('/') : '',
      ...(href ? {href_full: href} : {}),
    });
  }
  return {rows: rows};
}`;
/** FW8：给**唯一**命中行盖章（二次往返，只发生在恰好 1 个可见匹配时）。 */
const IDENTITY_STAMP_JS = String.raw`(arg) => {
  const attr = arg.attr, tag = arg.tag || '';
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const sel = (tag || '*') + '[' + attr + '="' + esc(arg.value) + '" i]';
  let all = [];
  try { all = document.querySelectorAll(sel); } catch (e) { return false; }
  const e = all[arg.index];
  if (!e) return false;
  e.setAttribute('data-hintref', arg.stamp);
  return true;
}`;
/** FW8：清理本次章（精确值匹配：绝不误删 hintLookup/主池的章）。 */
const IDENTITY_CLEANUP_JS = String.raw`(arg) => {
  let n = 0;
  try {
    const all = document.querySelectorAll('[data-hintref]');
    for (let i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-hintref') === arg.stamp) { all[i].removeAttribute('data-hintref'); n++; }
    }
  } catch (e) { /* 清理失败不阻断：章值唯一，残留不会误指 */ }
  return n;
}`;

/** FW8：页面函数必须是真函数（`compile`）——Playwright 的 `evaluate(string)` 只求值表达式，
 *  不会调用箭头函数串（PORT NOTE 3；hintLookup 的 PASS_HINT 同款）。 */
const PASS_IDENTITY = compile("arg", `return (${IDENTITY_PROBE_JS})(arg);`);
const PASS_IDENTITY_STAMP = compile("arg", `return (${IDENTITY_STAMP_JS})(arg);`);
const PASS_IDENTITY_CLEANUP = compile("arg", `return (${IDENTITY_CLEANUP_JS})(arg);`);

/** FW8：批次号只在进程内递增——章值 `afid<n>-0` 不与 hintLookup 的 `af<批>-h<n>` 撞名。 */
let identityBatch = 0;

/**
 * FW8：声明驱动的身份回捞（见文件头的五条约束）。**只应由执行器的声明目标解析调用**。
 *
 * 语义：白名单形状 + 跨 frame 精确属性查询 + 可见性（CSS + 非零盒）+ 恰好一个。返回的
 * 行是**与池同构**的合成 `Elem`（含 ref/frame/hint_ref/role/content_editable/draggable…），
 * 已盖 `data-hintref` 供 `_locatorFor` 既有身份链解析；调用方用完必须 `cleanup()`。
 */
export async function identityLookup(
  page: PageLike, hint: string, opts?: { hosts?: string[] | null },
): Promise<IdentityLookupResult> {
  const info = identityHintInfo(hint);
  const noop = async (): Promise<void> => { /* 没有章可清 */ };
  const out: IdentityLookupResult = {
    eligible: info.eligible, shape: info.shape, attr: info.attr, value: info.value,
    rows: [], hidden_matches: 0, total_matches: 0, candidates: [], cleanup: noop,
  };
  if (!info.eligible) return out;
  const frames = framesOf(page);
  const visible: Array<{ fi: number; row: Record<string, unknown> }> = [];
  const candidates: IdentityCandidate[] = [];
  for (let fi = 0; fi < frames.length; fi++) {
    if (fi > 0 && !frameInHostsEnvelope(frames[fi]!, opts?.hosts)) continue;   // P0-D：排除帧不参与身份回捞
    let got: unknown;
    try {
      got = await frames[fi]!.evaluate(PASS_IDENTITY,
        { attr: info.attr, value: info.value, tag: info.tag });
    } catch {
      continue;                     // frame detached / 无执行上下文：跳过（与 hintLookup 同口径）
    }
    const rows = (got as { rows?: unknown } | null)?.rows;
    if (!Array.isArray(rows)) continue;
    for (const raw of rows) {
      const row = raw as Record<string, unknown>;
      const vis = row["visible"] === true;
      candidates.push({
        tag: String(row["tag"] ?? ""), label: String(row["label"] ?? ""),
        id: String(row["id"] ?? ""), frame: fi, visible: vis,
      });
      if (vis) visible.push({ fi, row });
    }
  }
  out.total_matches = candidates.length;
  out.hidden_matches = candidates.filter((c) => !c.visible).length;
  out.candidates = candidates;
  // 约束 3：恰好一个可见匹配才动作；0 个保持今天；>1 个交给调用方报歧义（绝不随便选）。
  if (visible.length !== 1) return out;
  const { fi, row } = visible[0]!;
  const stamp = `afid${++identityBatch}-0`;
  let stamped = false;
  try {
    stamped = (await frames[fi]!.evaluate(PASS_IDENTITY_STAMP, {
      attr: info.attr, value: info.value, tag: info.tag, index: row["index"], stamp,
    })) === true;
  } catch {
    stamped = false;
  }
  if (!stamped) return out;         // 两次往返之间节点变了：按 0 处理，绝不猜
  const ref = fi === 0 ? "dom:0" : `dom:f${fi}:0`;
  const str = (k: string): string => String(row[k] ?? "");
  const el: Elem = {
    ref, frame: fi, hint_ref: stamp,
    tag: str("tag"),
    label: str("label"),
    ...(str("full_label") ? { full_label: str("full_label") } : {}),
    ...(str("id") ? { id: str("id") } : {}),
    ...(str("name") ? { name: str("name") } : {}),
    ...(str("data_test") ? { data_test: str("data_test") } : {}),
    ...(str("input_type") ? { input_type: str("input_type") } : {}),
    ...(str("role") ? { role: str("role") } : {}),
    ...(row["content_editable"] === true ? { content_editable: true } : {}),
    ...(row["draggable"] === true ? { draggable: true } : {}),
    ...(str("href") ? { href: str("href") } : {}),
    ...(str("href_full") ? { href_full: str("href_full") } : {}),
    identity: true,
  };
  out.rows = [el];
  out.cleanup = async (): Promise<void> => {
    for (const fr of framesOf(page)) {
      try {
        await fr.evaluate(PASS_IDENTITY_CLEANUP, { stamp });
      } catch {
        /* frame 已卸载：该 frame 的章随文档一起消失 */
      }
    }
  };
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
