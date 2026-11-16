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

import {
  describeFrameSuffixRejection, describeRowSuffixRejection, frameChainValueProblem,
  parseHint, splitTailSuffixes, type ParsedHint,
} from "./hint.ts";
import { parseClickAtValue } from "./click-at.ts";
import { sleepMs } from "../support/sleep.ts";
// frame:<origin> 帧链 helper（A 批，唯一出处 frame-scope.ts）：extraction 只做打点/帧过滤，
// 判定与 frameOriginOf 的实现都在 frame-scope（这里 re-export 保持既有导出面不变）。
import { elemFrameStamp, frameChainOf, frameOriginOf, frameScopeMatchesFrame } from "./frame-scope.ts";
export { elemFrameStamp, frameChainOf, frameScopeMatches, frameScopeMatchesFrame, frameOriginOf } from "./frame-scope.ts";
// 内嵌 JS 探针区（COLLECT_JS/PASS_*…）拆到 pool-js.ts（F6）；导出面不变，这里读回同一份。
import {
  COLLECT_JS, PASS_EXTRACT, PASS_OBSERVE, PASS_WINDOW, PASS_UNDERLOAD,
  PASS_META, PASS_NEAR, PASS_HINT, PASS_HINT_PROBE, PASS_HEURISTIC, FN_TAG, FN_FIRST, FN_WRAPPER,
  BUCKET_HELPERS_JS, compile,
} from "./pool-js.ts";
// FW8 身份回捞区（identityHintInfo/identityLookup 等）拆到 identity.ts（F6）；
// 这里 re-export 维持既有导出面不变（executor 等既有调用方零改动）。
export {
  identityHintInfo, identityLookup, formatIdentityCandidates,
} from "./identity.ts";
export type { IdentityCandidate, IdentityHintInfo, IdentityLookupResult } from "./identity.ts";
export {
  COLLECT_JS, BUCKET_HELPERS_JS, WINDOW_AUDIT_JS, VIEWPORT_UNDERLOAD_JS, LABEL_HELPERS_JS,
  EXTRACT_JS, OBSERVE_JS, PASS_EXTRACT, PASS_OBSERVE, PASS_WINDOW, PASS_UNDERLOAD,
  PASS_META, PASS_NEAR, PASS_HINT, PASS_HINT_PROBE, FN_TAG, FN_FIRST, FN_WRAPPER,
} from "./pool-js.ts";
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
  /**
   * F75：A3 DOM 回退面合成行的探针句柄（`data-af-probe="<批次>-<序号>"` 的值）——run 决策步
   * 复用回退面时 `_locatorFor` 的 af_probe 首分支据此重建 locator。仅合成行携带；真池行
   * 恒缺省（键不出现 = 行为不变）。
   */
  af_probe?: string;
  name?: string;
  id?: string;
  /**
   * E3：祖先链上的 id 集合（小写；≤8 个，最近祖先在前）——`within:#id` 尾缀的
   * 池侧判定底座（纯内存：锚 id ∈ anchor_ids ⇔ 元素在锚子树内）。提取期一次
   * 算好；无 id 祖先的普通页面 = 空数组（池行多一个空字段，匹配面零开销）。
   */
  anchor_ids?: string[];
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
   * F82（in-row 行锚）：行上下文文本（≤6 行、每行 ≤40 字符）——`in-row:<token>` 尾缀的池侧
   * 匹配底座（rules.rowMatch 单档 includes，仅小写折叠）与 suggestHints 第 5 档的词元来源。
   * **仅同文案重复组元素携带**（与 near 同触发：addNearContext / OBSERVE_JS dup 门控 /
   * HINT_HEAD in-row 门 / A3 DOM fallback 行）——行锚只服务"同文案网格"这一它要解决的问题，
   * 非重复组写 in-row = 恒落空（fail-closed 对称，R6）。**不进模型面**
   * （`modelProjectionOf` guard+解构两处剥离，F14/T9 同纪律）；**不进 esig/firstIfSame 签名**；
   * 只服务匹配/回捞/建议。与 near 的一句话分工：near = 模型视图单行（宿主挑选后的展示装饰），
   * row_texts = in-row 匹配底座（自证候选的词元来源）。
   */
  row_texts?: string[];
  /**
   * U3 类目标记（native-control / native-label / aria-role / aria-widget / native-activation）。
   * **只进 PoolView / inspect / 类目计数**，不进 `ChoiceRequest.elems` 的模型投影（F14）。
   */
  surface?: string;
  frame?: number;
  /**
   * A 批（frame:<origin> 帧限定）：元素所在帧的 origin（小写 http(s) 规范形）与祖先 origin
   * 链（外→内）。`frame_path` 省略 = 主帧（帧链 = [frame_origin]）；两字段都缺 = 未知
   * origin 帧（about:blank/srcdoc/空串等）——该帧内元素**不可被任何 `frame:` 命中**。
   * 打点唯一出处 = frame-scope.elemFrameStamp；消费点：rules.hintMatchImpl 入口过滤
   * （档位在帧内计算）与 PoolView 展示。不进 `ChoiceRequest.elems`（pickInner 剥离，
   * 与 surface 同一处）；**不进 esig/firstIfSame 签名**。
   */
  frame_origin?: string;
  frame_path?: string[];
  /**
   * B 批：结构证据（仅 inspect 的 `structurePath` opt-in 时出现；≤160 字符）。祖先 tag/`#id`
   * + 同 tag 兄弟序号 + 帧下标前缀（如 `f2>div#panel>button[2]`）。**只作诊断**：动态页面
   * （重排/虚拟列表/插入广告）随时失效，**不可照抄进 hint/target**；不进模型面
   * （`modelProjectionOf` 剥离）、不进歧义证据（`describeAmbiguity` 是零页面 I/O 纯函数）。
   */
  structure_path?: string;
  /** 结构证据的不稳定标记（与 `structure_path` 同出现：一眼看出"不是 hint"）。 */
  structure_unstable?: true;
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
  /**
   * A 批（frame:<origin> 帧链）：父帧（Playwright Frame.parentFrame）。可选——测试替身与
   * `framesOf` 的 `[page as FrameLike]` 兜底没有它 = 主帧（帧链 = [ownOrigin]）。
   * 判根用 `parentFrame()===null`，**不**假设 `frames()[0]` 是主帧。
   */
  parentFrame?(): FrameLike | null;
  /**
   * A 批（frame:<origin> 帧链）：帧存活判定（Playwright 1.58 Frame.isDetached）。
   * detach 后 `parentFrame()` 不抛错也不返回 null（返回陈旧父帧）——判活只能靠它；
   * detached 帧 = 未知 origin（frame-scope.frameChainOf 返回 undefined）。
   */
  isDetached?(): boolean;
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
import { urlInHostsEnvelope } from "./host-envelope.ts";
export { urlInHostsEnvelope } from "./host-envelope.ts";

/** P0-D：一个 frame 的 URL 是否在信封内（空 URL / about:blank = 允许，口径同上面）。 */
export function frameInHostsEnvelope(frame: FrameLike, hosts: string[] | null | undefined): boolean {
  let url = "";
  try { url = typeof frame.url === "function" ? frame.url() : (frame.url ?? ""); } catch { url = ""; }
  return urlInHostsEnvelope(String(url), hosts);
}

/** P0-D：frame 的 origin 证据文案已移入 frame-scope.ts（唯一出处；文件头 re-export 保持导出面）。 */

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

/* ------------------------------------------------ 读侧帧限定（E4，M4 收口） */

/**
 * E4（读侧帧限定对称化）：CSS 选择器串尾 ` frame:<origin链>` 尾缀的**唯一**剥离出处
 * （消费面：`locatorAnyFrame`/`countAnyFrame` 的帧循环过滤 + ctx 读/抽取面的证据与诊断）。
 *
 * 语义（架构师裁决）：
 *   - **值不合法 ⇒ 整串按原 CSS 处理**（显式落空），绝不半剥——防选择器属性值以
 *     ` frame:` 结尾的伪尾缀误伤。`rejected` 带 B8 同款拒因，调用方只在原样 CSS
 *     解析失败时附注（M4①），成功路径零影响。
 *   - **值合法 ⇒ 帧限定查询**。纯 CSS 形态在 E4 前必然是非法 CSS（`frame:<origin>` 落在
 *     选择器尾只能是伪类语法、永不成立），故尾缀**只能激活原本就保证失败的纯 CSS 串**——
 *     既有 CSS 选择器零影响（无尾缀 = `selector` 逐字节原样返回）。**非 CSS 引擎不保证**
 *     （Playwright `text=` 等把整串当文本）：作者需把文本显式引用（或依赖下列守卫拒绝），
 *     详见 N4 守卫与文档。
 *   - **N4 守卫**：剥离后的 base 必须引号/括号配对（`"`/`'`/`(`/`)`/`[`/`]`；CSS 字符串内
 *     的对比字符不算、反斜杠转义跳过）——`new URL()` 会接受 `)`/`'`/`"` 作为 host 字符，
 *     让 `div:has-text("x frame:https://a.com")` 这类**引号内**的尾缀被误剥；不配对 ⇒
 *     整串原样 + rejected（"选择器含未闭合引号/括号，尾缀未应用"）。
 *   - **N5 空值**：词法收 ` frame:` 后无值（`(\S*)`）——整串原样 + rejected（"frame: 后没有值"）。
 *   - 校验与 hint 的 `frame:` 尾缀同一份 `frameChainValueProblem`（`>` 分隔外→内、
 *     ≤4 段、每段 `v === new URL(v).origin` 的 http(s) 规范形）；同一串至多一个尾缀——
 *     剥离后 base 仍以「规范 origin 值的 frame: 尾缀」结尾 = 第二个真尾缀 ⇒ 整组拒绝
 *     （值内伪尾缀的捕获必然带着 CSS 收尾字符、过不了 origin 校验，不会误伤）。
 *   - `within:` 不在剥面（读侧 CSS 无锚定语义；带 within 的串按原 CSS 显式落空）。
 */
export interface SplitSelectorFrameSuffix {
  /** 剥离后的 CSS（无尾缀/被拒 = **原串逐字节**，含原大小写与空白）。 */
  selector: string;
  /** 合法声明链（小写规范 origin，外→内）；无合法尾缀时省略。 */
  frameChain?: string[];
  /** M4①：串含 ` frame:` 尾缀形状但未生效（值非法/缺主体/空值/双尾缀/引号括号不配对）时的拒因；其余省略。 */
  rejected?: string;
}

const SELECTOR_FRAME_TAIL_RE = /(?:\s+frame:)(\S*)\s*$/i;

/**
 * E7（N4）：剥离后 base 的引号/括号配对守卫。只做词法配对（不认识 CSS 语义）：
 * 反斜杠转义跳过、字符串内的 `(`/`[` 等不参与配对；出现**先闭后开**或收尾未闭合即视为
 * 不配对。用于拦截"尾缀原本落在引号/括号内部"的误剥（`new URL()` 会把 `)`/`'`/`"` 当
 * host 字符收下，单看值校验发现不了）。
 */
function selectorDelimiterProblem(base: string): string | null {
  let quote: '"' | "'" | null = null;
  let round = 0;
  let square = 0;
  for (let i = 0; i < base.length; i++) {
    const ch = base[i]!;
    if (ch === "\\") { i += 1; continue; }
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(") round += 1;
    else if (ch === ")") round -= 1;
    else if (ch === "[") square += 1;
    else if (ch === "]") square -= 1;
    if (round < 0 || square < 0) return "选择器含未闭合引号/括号，尾缀未应用";
  }
  if (quote !== null || round !== 0 || square !== 0) return "选择器含未闭合引号/括号，尾缀未应用";
  return null;
}

export function splitFrameSuffixFromSelector(sel: string): SplitSelectorFrameSuffix {
  const m = SELECTOR_FRAME_TAIL_RE.exec(sel);
  if (m === null) return { selector: sel };
  const base = sel.slice(0, m.index).trim();
  const value = m[1]!.toLowerCase();
  if (base === "" || value === "" || frameChainValueProblem(value) !== null) {
    return {
      selector: sel,
      rejected: base === ""
        ? "frame: 尾缀前没有选择器主体（必须写成 `<css> frame:<origin>`）——整串按原 CSS 处理"
        : `frame: 尾缀未被应用（${selectorFrameChainProblemText(value)}）——整串按原 CSS 处理`
          + "（显式落空，绝不半剥）",
    };
  }
  // N4：尾缀可能落在引号/括号内部（值侧 `new URL()` 收得下 `)`/`'`/`"`）——base 不配对 =
  // 这不是一个真正的串尾语法后缀，整串原样（诊断照旧只在失败路径附注）。
  const delimiter = selectorDelimiterProblem(base);
  if (delimiter !== null) {
    return {
      selector: sel,
      rejected: `${delimiter}（尾缀前的主体引号/括号不配对）——整串按原 CSS 处理（显式落空，绝不半剥）`,
    };
  }
  const residual = SELECTOR_FRAME_TAIL_RE.exec(base);
  if (residual !== null && frameChainValueProblem(residual[1]!.toLowerCase()) === null) {
    return {
      selector: sel,
      rejected: "同一串出现多个 frame: 尾缀（至多一次）——整串按原 CSS 处理（显式落空，绝不半剥）",
    };
  }
  return { selector: base, frameChain: value.split(">") };
}

/** `frame:` 尾缀值问题的人话（与 hint.ts 的 frameChainProblemText 同一判定类别）。 */
function selectorFrameChainProblemText(value: string): string {
  const p = frameChainValueProblem(value);
  switch (p?.kind) {
    case "empty": return "frame: 后没有值";
    case "too-long": return `声明 ${p.segments} 段超过上限 4 段`;
    case "empty-segment": return "链里有空段（\">\" 两侧都必须有 origin）";
    case "not-http-origin": return `值 ${JSON.stringify(p.segment)} 不是 http(s) origin（需要 scheme://host[:port] 规范形）`;
    case "not-canonical": return `值 ${JSON.stringify(p.segment)} 不是规范 origin（带 path/query/显式默认端口；如 https://a:443 要写 https://a）`;
    default: return "值非法";
  }
}

/**
 * E4（M4②）：读侧声明帧的**帧级扫描证据**（ctx.read/ctx.extract 的 miss trace 用，
 * additive；与 `locatorAnyFrame`/`countAnyFrame` 的帧循环同一谓词、同一帧序——
 * 链匹配 ∧ 信封规则（主帧恒允许、子帧按 hosts））。
 * `excluded` 非空 = 声明帧存在但被 hosts 信封排除（未扫描）；两者皆空 = 声明帧不存在/链写错。
 */
export interface FrameScopeEvidence {
  declared: string[];
  excluded: string[];
  scanned: string[];
}

export function frameScopeEvidenceOf(
  page: PageLike, hosts: string[] | null | undefined, declared: readonly string[],
): FrameScopeEvidence {
  const excluded: string[] = [];
  const scanned: string[] = [];
  const frames = framesOf(page);
  for (let fi = 0; fi < frames.length; fi++) {
    const fr = frames[fi]!;
    if (!frameScopeMatchesFrame(declared, fr)) continue;
    const origin = frameOriginOf(fr).toLowerCase();
    if (fi > 0 && !frameInHostsEnvelope(fr, hosts)) {
      if (!excluded.includes(origin) && excluded.length < 6) excluded.push(origin);
    } else if (!scanned.includes(origin) && scanned.length < 6) {
      scanned.push(origin);
    }
  }
  return { declared: [...declared], excluded, scanned };
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
 *
 * E4：选择器可尾缀 ` frame:<origin链>`（`splitFrameSuffixFromSelector` 唯一剥离出处）——
 * 声明了合法尾缀时帧循环按 `frameScopeMatchesFrame` 过滤（与 hint 同一尾部对齐判定），
 * 信封规则不变（主帧恒允许、子帧按 hosts；被信封排除且链匹配的帧不扫描）；声明帧一个都
 * 没扫到（不存在/链写错/全在信封外）= 结构化 miss（null），绝不落到 test-double 回捞——
 * 那会拿另一份 DOM 冒充声明帧的答案。无尾缀路径逐字节不变。
 */
export async function locatorAnyFrame(
  page: PageLike, selector: string, opts?: { hasText?: string; hosts?: string[] | null },
): Promise<LocLike | null> {
  // E4（M4④）：split 在一切帧遍历与 test-double fallback 之前。
  const split = splitFrameSuffixFromSelector(selector);
  const declared = split.frameChain;
  if (page.frames !== undefined || page.locator !== undefined) {
    const frames = framesOf(page);
    let chainScanned = 0;   // E4：链匹配且被实际扫描的帧数（声明帧全缺席时的短路依据）
    for (let fi = 0; fi < frames.length; fi++) {
      const fr = frames[fi]!;
      // E4：声明了合法尾缀 = 只查链匹配的帧（frameScopeMatchesFrame 尾部对齐，与 hint 同一口径）。
      if (declared !== undefined && !frameScopeMatchesFrame(declared, fr)) continue;
      // P0-D：被排除的 frame 不参与信号求值（主 frame 恒在面内；无 hosts = 旧行为）。
      if (fi > 0 && !frameInHostsEnvelope(fr, opts?.hosts)) continue;
      chainScanned += 1;
      try {
        const loc = opts === undefined ? fr.locator(split.selector) : fr.locator(split.selector, opts);
        if (await loc.count()) return loc;
      } catch {
        continue;   // frame detached mid-scan / no execution context: skip（跨源 frame 不在此抛——R11 B5 实测可跨源 locator 定位）
      }
    }
    // E4：声明帧在本页一个都没扫到 ⇒ 结构化 miss（不回捞替身 DOM）。
    if (declared !== undefined && chainScanned === 0) return null;
  }
  // Test doubles / non-Playwright pages may provide their own resolver.
  // E4（M4④）：fallback 在 split 之后——替身拿到剥离后的 base（无尾缀 = 原串逐字节）。
  return (await page.locatorAnyFrame?.(split.selector)) ?? null;
}

/**
 * E5：selector 在主 frame + 可达子 frame 的**命中总数**（`css_count_equals` /
 * `css_count_min` 的求值底座）。帧序与 `locatorAnyFrame` 相同（framesOf；被排除
 * frame 不计数，P0-D 信封同口径）；单帧抛错（中途分离等）跳过该帧继续数——
 * 计数是观察面，不因一帧失联把整个信号打成 false。空 selector 返回 null
 * （语法错不猜：调用方按"不成立"处理，与 css_exists 空串的抛错-捕获路径同向）。
 *
 * E4：选择器可尾缀 ` frame:<origin链>`（与 `locatorAnyFrame` 同一剥离出处与同一
 * 帧过滤口径：链匹配 ∧ 信封规则；值非法 = 整串按原 CSS 处理——原串对 locator 是
 * 非法 CSS → 各帧抛错跳过 → 计 0，显式落空）。无尾缀路径逐字节不变。
 */
export async function countAnyFrame(
  page: PageLike, selector: string, opts?: { hosts?: string[] | null },
): Promise<number | null> {
  if (selector.trim() === "") return null;
  const split = splitFrameSuffixFromSelector(selector);
  const declared = split.frameChain;
  if (page.frames !== undefined || page.locator !== undefined) {
    const frames = framesOf(page);
    let total = 0;
    for (let fi = 0; fi < frames.length; fi++) {
      const fr = frames[fi]!;
      if (declared !== undefined && !frameScopeMatchesFrame(declared, fr)) continue;
      if (fi > 0 && !frameInHostsEnvelope(fr, opts?.hosts)) continue;
      try {
        total += await fr.locator(split.selector).count();
      } catch {
        continue;   // frame detached mid-scan / invalid selector piece in this frame
      }
    }
    return total;
  }
  return null;
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
/**
 * E1-b：`decision.pool_quota_mode:"quota"` 灰度档的换档配额——viewport 保底加大、
 * 壳限额收紧（chrome 8→6）。总数不变（40/120 两档预算不动）；只改"谁被逐出"。
 * id-backed 保留不在配额表里（PIN_CAP 在探针侧，跨桶合计）。
 */
export const QUOTA_MODE_QUOTAS: PoolQuotas = { chrome: 6, viewport: 24, contentNear: 8, mainOffscreen: 6, other: 2 };
export const QUOTA_MODE_WIDE_QUOTAS: PoolQuotas = { chrome: 12, viewport: 72, contentNear: 32, mainOffscreen: 16, other: 8 };
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
     * B 批（inspect 观察面 opt-in，缺省 false = 池行逐字节不变）：给每行补**结构证据**
     * `structure_path`（祖先 tag/`#id` + 同 tag 兄弟序号 + 帧下标前缀，≤160 字符）与
     * `structure_unstable: true`。只作诊断（动态页面可能失效、不可照抄进 hint），
     * 不进模型面（`executor-pure.modelProjectionOf` 仍会剥离，防误传）。
     */
    structurePath?: boolean;
    /**
     * P0-D：host 信封。给了就**只从信封内的 frame** 抽池（主 frame 恒在面内），被排除
     * frame 的真实下标仍保留（`frame`/`f<fi>:` ref 不变）；缺省 = 今天的全帧面。
     */
    hosts?: string[] | null;
    /**
     * E1-b：池配额模型（`decision.pool_quota_mode`；缺省 "legacy" = 既有优先级逐出，
     * 行为逐字节不变）。"quota" = 双配额灰度档：viewport 保底换档配额 + id-backed
     * 保留（PIN_CAP）+ 壳元素限额。配额常量单一出处（QUOTA_MODE_QUOTAS）。
     */
    poolQuotaMode?: "legacy" | "quota";
  },
): Promise<ElemPool> {
  // 缺省 bucketed；main-first 显式回退。quota 由预算档决定（40/120 两档常量单一出处）。
  const quotaMode = opts?.poolQuotaMode === "quota" ? "quota" : "legacy";
  const quotas = opts?.candidatePriority === "main-first"
    ? null
    : (opts?.quotas !== undefined
      ? opts.quotas
      : (maxElements > MAX_ELEMENTS
        ? (quotaMode === "quota" ? QUOTA_MODE_WIDE_QUOTAS : WIDE_QUOTAS)
        : (quotaMode === "quota" ? QUOTA_MODE_QUOTAS : POOL_QUOTAS)));
  if (jsProbe) {
    try {
      await jsInteractiveWidgets(page);
    } catch {
      /* silent by design: recovery only */
    }
  }
  const elems: ElemPool = {};
  const frames = framesOf(page);
  // A 批（frame:<origin>）：每帧算一次链打点（parentFrame 上溯；未知 origin 帧 = 不打点）。
  const frameStamps = frames.map((fr) => elemFrameStamp(fr));
  for (let fi = 0; fi < frames.length; fi++) {
    const remaining = maxElements - Object.keys(elems).length;
    if (remaining <= 0) break;
    if (fi > 0 && !frameInHostsEnvelope(frames[fi]!, opts?.hosts)) continue;   // P0-D：排除帧不进池
    let rows: Elem[] | null = null;
    try {
      rows = (await frames[fi]!.evaluate(PASS_EXTRACT,
        { sel: poolSelectorWithJsFor(opts?.surface), max: remaining, quotas,
          ...(quotaMode === "quota" ? { quotaMode: "quota" } : {}),
          cats: SURFACE_SELECTORS, caps: WINDOW_CAPS,
          // P0-A：只有 inspect 传这两个开关；不传 ⇒ 参数对象与今天逐字节同形。
          ...(opts?.classNames === true ? { classNames: true } : {}),
          ...(opts?.fullLabel === true ? { fullLabel: true } : {}),
          // B 批：结构证据 opt-in；帧下标前缀在 JS 内拼进 structure_path（截断也含前缀）。
          ...(opts?.structurePath === true ? { structurePath: true, framePrefix: `f${fi}` } : {}) })) as Elem[] | null;
    } catch {
      rows = null;
    }
    if (rows === null && fi === 0) rows = await extractRowsPerElement(page, maxElements);  // resilience
    for (const row of rows ?? []) {
      // child-frame refs are namespaced so one pool holds every frame
      row.ref = fi === 0 ? row.ref : `f${fi}:${row.ref}`;
      row.frame = fi;
      // A 批（frame:<origin>）：帧链两字段（frame-scope.elemFrameStamp；未知 origin = 省略）。
      const st = frameStamps[fi]!;
      if (st.frame_origin !== undefined) row.frame_origin = st.frame_origin;
      if (st.frame_path !== undefined) row.frame_path = st.frame_path;
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
  /** E3：祖先链 id（小写、≤8、最近祖先在前）；无 id 祖先时 JS 侧不返回该字段。 */
  anchor_ids?: string[];
  /**
   * F82：行上下文文本（≤6 行 × ≤40 字符）——OBSERVE_JS **dup 门控**采集（观察集合内可见
   * 同文案计数 >1 才采集；无 dup 页不出字段 ⇒ 观察 JSON 逐字节不变）。syntheticElem 透传后
   * observe 自证池与池行同构，suggestHints 第 5 档可给出 in-row 候选。不进模型面。
   */
  row_texts?: string[];
  visible?: boolean;
  bbox?: { x: number; y: number; w: number; h: number };
  in_surface?: boolean;
  frame?: number;
  /** A 批（frame:<origin>）：帧链两字段（observeElements 宿主侧按帧打点；主帧 path 省略）。 */
  frame_origin?: string;
  frame_path?: string[];
  /** B 批：结构证据（仅 `includeStructure:true` 时由 OBSERVE_JS 产出；≤160、unstable）。 */
  structure_path?: string;
  structure_unstable?: true;
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
    /** B 批：opt-in 结构证据（OBSERVE_JS 只读计算，额外一次祖先前缀行走/行）。 */
    includeStructure?: boolean;
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
        // B 批：结构证据 opt-in；帧下标前缀在 JS 内拼进 structure_path（截断也含前缀）。
        ...(opts.includeStructure === true ? { includeStructure: true, framePrefix: `f${fi}` } : {}),
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
      // A 批（frame:<origin>）：观察行带帧链两字段——syntheticElem 透传后，observe 自证池
      // 才能验证（并给出）帧限定候选（R2-9：observe 自证池无链 = 永远给不出链候选）。
      const st = elemFrameStamp(frames[fi]!);
      if (st.frame_origin !== undefined) row.frame_origin = st.frame_origin;
      if (st.frame_path !== undefined) row.frame_path = st.frame_path;
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
      // A1 不变量：label === full_label 的前 40 字（同一 label 截断）。
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


export async function extractHeuristicWidgets(
  page: PageLike, startRef: number, max: number,
): Promise<Elem[]> {
  if (max <= 0) return [];
  try {
    const rows = (await page.evaluate!(PASS_HEURISTIC, { startRef: startRef, max: max })) as
      Array<Record<string, unknown>> | null;
    // A 批（frame:<origin>）：heuristic 宽扫是 page.evaluate（**仅主帧**，JS pass 连 frame
    // 都不设）——宿主侧显式补 `frame=0` + 主帧 origin（frame_path 省略 = 主帧链 [origin]）。
    const mainStamp = elemFrameStamp(page as unknown as FrameLike);
    return (rows ?? []).map((r, k): Elem => ({
      ref: `e${startRef + k}`,
      scan: -1,
      frame: 0,
      ...(mainStamp.frame_origin !== undefined ? { frame_origin: mainStamp.frame_origin } : {}),
      tag: String(r["tag"] ?? "div"),
      // A1 不变量：label === full_label 的前 40 字（行由 HEURISTIC_WIDGET_JS 按同一 full 构造）。
      label: String(r["label"] ?? "").slice(0, 40),
      full_label: String(r["full_label"] ?? r["label"] ?? "").slice(0, 200),
      // E1（M3 第五池）：heuristic 伪按钮行透传 anchor_ids（行由 HEURISTIC_WIDGET_JS 经共享
      // ANCHOR_JS 算好；无 id 祖先 = 行字段省略 ⇒ Elem 也不写，与真池口径一致）。
      ...(Array.isArray(r["anchor_ids"]) && (r["anchor_ids"] as string[]).length > 0
        ? { anchor_ids: (r["anchor_ids"] as string[]).map((x) => String(x).toLowerCase()) } : {}),
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
 *
 * F82 双累加器（ROW_ANCHOR_HINT_PLAN §3.4）：与 near 共享同一次爬升（PASS_NEAR →
 * pool-js ROW_CLIMB_JS），两个累加器独立——`out`（near）累加序/行过滤/3 行窗口逐字符不动
 * ⇒ near 逐字节相等；`rows`（row_texts）独立行过滤（现行过滤 OR 连续数字 ≥5 位）、窗口 6 行。
 * row_texts **仅重复组携带**（本函数只碰 dup 元素）、不进模型面（modelProjectionOf 剥离）。
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
  const rowTextsAll: Record<string, string[]> = {};
  for (const [fi, pairs] of byFrame) {
    const fr = frameAt(page, fi) ?? (page as unknown as FrameLike);
    try {
      // F82：NEAR_JS 返回 {near, rows}——near 仍是 out 前 3 行切片（宿主 pick 消费面不动），
      // rows 是独立行过滤的全量行上下文（row_texts 底座，≤6 行）。
      const res = (await fr.evaluate(PASS_NEAR,
      { sel: INTERACTIVE_ALL, pairs, labels })) as Array<{ near?: string[]; rows?: string[] }>;
      pairs.forEach(([r], j) => {
        const got = j < (res?.length ?? 0) ? res[j] : undefined;
        candsAll[r] = (Array.isArray(got?.near) ? got!.near! : []) as string[];
        const rows = (Array.isArray(got?.rows) ? got!.rows! : []) as string[];
        if (rows.length > 0) rowTextsAll[r] = rows;   // additive：空行集不出字段（anchor_ids 同形）
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
  for (const [r, rows] of Object.entries(rowTextsAll)) {
    elems[r]!.row_texts = rows;   // 仅重复组携带（near 同触发）；不进模型面/签名
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
  // A 批（frame:<origin>）：解析一次——帧循环按声明链过滤（R2-5 帮助调用点；未声明 = 逐字节旧路径）。
  const parsed = parseHint(hint);
  const frames = framesOf(page);
  for (let fi = 0; fi < frames.length; fi++) {
    if (fi > 0 && !frameInHostsEnvelope(frames[fi]!, opts?.hosts)) continue;   // P0-D：排除帧不参与回捞
    // A 批：声明链不匹配的帧不参与回捞（frame:<origin> 落在其它帧 = 该帧没有这条声明）。
    if (parsed.frameChain !== undefined && !frameScopeMatchesFrame(parsed.frameChain, frames[fi]!)) continue;
    let rows: Array<Record<string, unknown>> | null = null;
    try {
      rows = (await frames[fi]!.evaluate(PASS_HINT,
        hintLookupArgs(hint, sel))) as Array<Record<string, unknown>> | null;
    } catch {
      continue;
    }
    // A 批：回捞合成行带帧链两字段（并入主池后 hintMatch 的入口 entries 过滤才能按帧限定）。
    const st = elemFrameStamp(frames[fi]!);
    for (const row of rows ?? []) {
      const ref = fi === 0 ? `x${row.scan}` : `xf${fi}:${row.scan}`;
      out[ref] = {
        ref, frame: fi,
        ...(st.frame_origin !== undefined ? { frame_origin: st.frame_origin } : {}),
        ...(st.frame_path !== undefined ? { frame_path: st.frame_path } : {}),
        ...(row as Elem),
      };
    }
  }
  return out;
}

/** P0-D：声明目标"只存在于被排除 frame"的只读探测结果（证据面）。 */
export interface ExcludedHintProbe {
  /** 被排除 frame 的 origin（去重；证据/reason 用）。 */
  origins: string[];
  /**
   * C 批（§12.3 回捞/门禁适配 / F45）：hint 里**声明的帧链**（`frame:` 尾缀；无尾缀省略）。
   * 与 `matchedChains` 并排进 reason，回答"作者声明的链 vs 实际命中的链"。
   */
  declaredChain?: string[];
  /**
   * C 批：**命中帧的完整链**（`frameChainOf`，外→内、末段=该帧自身 origin；未知 origin 帧为
   * 空数组）——按链去重、**前 4 条**（有界列表），只含真正产出匹配的排除帧（不把无关 origin
   * 当证据）。E6：列表截断时**不丢总数**——全量 distinct 链数见 `matched_chains_total`。
   */
  matchedChains: Array<{ frame: number; origin: string; chain: string[] }>;
  /**
   * E6（BACKLOG #7 / WITHIN_PARITY_PLAN §8）：命中帧的**全量 distinct 链数**（去重口径，
   * ≥ `matchedChains.length`）。旧实现把"去重"与"截断到 ≤4"共用一个条件，>4 条时证据里
   * 连总数都看不到；现在总数恒有、列表仍 ≤4。
   */
  matched_chains_total: number;
  /** E6：列表被截断（`matched_chains_total > matchedChains.length`）时为 `true`；≤4 条时省略。 */
  matched_chains_truncated?: true;
  /** 排除帧内的命中行（ref 是证据编号，不参与动作）。 */
  matches: Array<{
    ref: string; frame: number; tag: string; label: string;
    id?: string; data_test?: string;
  }>;
}

/**
 * P0-D：**只读探测**——在 host 信封排除的 frame 里找一条 hint 的匹配（不盖章、不动作）。
 * 返回 null = 没有排除帧 / 排除帧里也没有这条 hint（保持既有失败路径）。
 *
 * C 批：只探测与声明链匹配的排除帧（A 批已过滤）；证据同时带**声明的链**与**命中帧完整链**
 * （按链去重、≤4 条，有界）——reason 的措辞由 executor-pure.frameTargetStopReason 统一拼装。
 * E6：去重与截断解耦——全量 distinct 链数进 `matched_chains_total`，列表仍只列前 4 条，
 * 超出时 `matched_chains_truncated:true`（reason 带总数）；≤4 条时结构与文案逐字节不变。
 */
export async function probeExcludedHint(
  page: PageLike, hosts: string[] | null | undefined, hint: string,
  sel: string = admitSelectorWithJsFor(),
): Promise<ExcludedHintProbe | null> {
  const gate = frameGateOf(page, hosts);
  if (gate === null) return null;
  const parsed = parseHint(hint);
  const matches: ExcludedHintProbe["matches"] = [];
  const matchedChains: ExcludedHintProbe["matchedChains"] = [];
  const seenChains = new Set<string>();
  for (const { index, frame, origin } of gate.excluded) {
    if (parsed.frameChain !== undefined && !frameScopeMatchesFrame(parsed.frameChain, frame)) continue;
    const before = matches.length;
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
    if (matches.length === before) continue;        // 该帧没有命中：不进链证据
    const chain = frameChainOf(frame) ?? [];
    const key = chain.length ? chain.join(">") : `opaque:${origin}`;
    if (seenChains.has(key)) continue;              // 同一链只算一次（全量 distinct 计数）
    seenChains.add(key);
    if (matchedChains.length < 4) matchedChains.push({ frame: index, origin: origin || "about:blank", chain });
  }
  if (matches.length === 0) return null;
  const total = seenChains.size;
  return {
    origins: gate.origins,
    ...(parsed.frameChain === undefined ? {} : { declaredChain: parsed.frameChain }),
    matchedChains,
    matched_chains_total: total,
    ...(total > matchedChains.length ? { matched_chains_truncated: true as const } : {}),
    matches,
  };
}

/**
 * C 批（B8/D7）：页面**允许帧**的 origin 列表（去重、≤6，主帧在前）。
 * 口径与门禁一致：主帧恒允许；子帧 origin 不在 hosts 信封内 = 排除（不列）。
 */
export function allowedFrameOrigins(page: PageLike, hosts: string[] | null | undefined): string[] {
  const out: string[] = [];
  const frames = framesOf(page);
  for (let i = 0; i < frames.length; i++) {
    if (i > 0 && !frameInHostsEnvelope(frames[i]!, hosts)) continue;
    const origin = frameOriginOf(frames[i]!).toLowerCase();
    if (!origin || origin === "null") continue;
    if (!origin.startsWith("http://") && !origin.startsWith("https://")) continue;
    if (!out.includes(origin)) out.push(origin);
  }
  return out.slice(0, 6);
}

/**
 * C 批（B8）：`target_not_found` 类 reason 末尾的 **hint 尾缀失败证据**（frame: + in-row:）。
 *
 * 唯一追加面（命令步 / act_hint strict / 会话 act 都调它，避免多处文案漂移）：
 *   - 目标串里的 `frame:` 尾缀未被 parseHint 接受 → 点名原因（describeFrameSuffixRejection）；
 *   - F82：目标串里的 `in-row:` 尾缀未被接受 → 点名原因（describeRowSuffixRejection）；声明了
 *     合法 in-row 却整链落空时按 §3.9 三案口径给**可区分**证据——① token 在池面任何行词元中
 *     无匹配 → 列池面真实行词元 ≤8（镜像 frame: "页面实际可用 origin" 先例）；② token 已定位
 *     行但行内无 base 命中 → 报"行已定位 + 行内词面"（作者改 base 不改 token）；③ token 撞多行
 *     走 target_ambiguous 歧义谓词（不进本函数）。三案 reason 可区分，stopCode 不加新码；
 *   - 目标串里有**合法**声明链却没命中 → 列出声明链（"合法但写错 origin"要看到页面实际有什么）；
 *   - 两者都出现/出现任一 → 附页面允许帧的 origin 列表（去重 ≤6、有界，主帧 origin 也列）。
 * 没有 frame:/in-row: 参与（无尾缀、也无被拒尝试）= 返回空串 ⇒ 旧 reason 逐字节不变。
 *
 * `elems`（F82 可选）：给定时启用 in-row 三案证据（当前池在手才能回答"token 在行词元里吗"）；
 * 不传 = 纯 frame 行为逐字节不变。
 */
export function frameHintFailureEvidence(
  page: PageLike, hosts: string[] | null | undefined, targets: readonly (string | null | undefined)[],
  elems?: ElemPool,
): string {
  const rejections: string[] = [];
  const declared: string[] = [];
  // E2：within 归一为链（外→内 string[]，单层 = 长度 1）——证据文案按 `#a>#b` 链形渲染
  // （单层 join(">") = 单 id，逐字节等于旧文案）。
  let withinAnchor: string[] | undefined;
  // F82：in-row 侧证据状态（被拒文案 / 第一个合法声明的 token）。
  const rowRejections: string[] = [];
  let declaredToken: string | undefined;
  for (const target of targets) {
    if (typeof target !== "string" || target.trim() === "") continue;
    const rejection = describeFrameSuffixRejection(target);
    if (rejection !== null) {
      if (!rejections.includes(rejection)) rejections.push(rejection);
      continue;
    }
    const parsed = parseHint(target);
    const chain = parsed.frameChain;
    if (chain !== undefined) {
      const text = chain.join(">");
      if (!declared.includes(text)) declared.push(text);
      if (parsed.within !== undefined && withinAnchor === undefined) withinAnchor = parsed.within;
    }
    // F82：in-row 侧（同目标串）——被拒点名；合法声明记 token（只记第一个，证据有界）。
    const rowRejection = describeRowSuffixRejection(target);
    if (rowRejection !== null) {
      if (!rowRejections.includes(rowRejection)) rowRejections.push(rowRejection);
    } else if (parsed.inRow !== undefined && declaredToken === undefined) {
      declaredToken = parsed.inRow;
    }
  }
  // 无尾缀参与 = 空串（旧 reason 逐字节不变）。F82：in-row 参与（被拒尝试或合法声明 +
  // 池在手）也要给证据，故提前返回条件在旧条件上 additive。
  if (rejections.length === 0 && declared.length === 0 && rowRejections.length === 0
      && !(elems !== undefined && declaredToken !== undefined)) return "";
  // F82：in-row 三案证据（纯内存；elems 未传 = 跳过，调用面行为逐字节不变）。
  // 匹配口径与 rules.rowMatch 同一行 includes（extraction 不能 import rules——rules → extraction
  // 既有依赖方向；一行口径改动须两处同步，勿另写第二套）。
  let rowEvidence: string | null = null;
  if (elems !== undefined && declaredToken !== undefined) {
    const tok = declaredToken;
    const hitRefs = Object.entries(elems)
      .filter(([, e]) => Array.isArray(e.row_texts)
        && (e.row_texts as string[]).some((line) => String(line).toLowerCase().includes(tok)))
      .map(([r]) => r);
    if (hitRefs.length === 0) {
      // 案①：token 无匹配 → 列池面真实行词元 ≤8（去重、跳声明 token 本身，每词 ≤20 字符）。
      const toks: string[] = [];
      for (const e of Object.values(elems)) {
        for (const line of Array.isArray(e.row_texts) ? e.row_texts : []) {
          for (const w of String(line).toLowerCase().split(/\s+/)) {
            if (w === "" || w === tok || w.length > 20 || toks.includes(w)) continue;
            toks.push(w);
          }
          if (toks.length >= 8) break;
        }
        if (toks.length >= 8) break;
      }
      rowEvidence = `in-row:${JSON.stringify(tok)} 在池面任何行词元中无匹配（row_texts 只在同文案重复组元素上`
        + `采集，非重复组恒落空）——池面真实行词元 ≤8: [${toks.join(", ") || "-"}]`;
    } else {
      // 案②：行已定位但行内无 base 命中 → 作者改 base 不改 token。
      const withRow = targets.find((t) => typeof t === "string" && parseHint(t as string).inRow !== undefined) as string;
      const base = splitTailSuffixes(withRow).base;
      rowEvidence = `in-row:${JSON.stringify(tok)} 已定位 ${hitRefs.length} 个带该行词面的元素`
        + `（${hitRefs.slice(0, 3).join(", ")}）但行内没有命中 base ${JSON.stringify(base)}——`
        + `行已定位：改 base 不改 token`;
    }
  }
  const parts: string[] = [];
  if (rejections.length > 0) parts.push(rejections.slice(0, 2).join("；"));
  if (rowRejections.length > 0) parts.push(rowRejections.slice(0, 2).join("；"));
  if (rowEvidence !== null) parts.push(rowEvidence);
  if (declared.length > 0) {
    parts.push(`声明链 ${declared.slice(0, 2).map((c) => JSON.stringify(c)).join(" / ")} `
      + `在允许帧里没有命中（检查 origin 是否写错/该帧是否被 hosts 排除）`);
  }
  // 实施复审 N-R2a（E1 后更新）：同帧 within 已在回捞面生效（E1——五池补 anchor_ids +
  // FW8/F64/DRF-text 按 within 过滤/DRF-attr 经 hintCandidates→inAnchor 自动消费），不再是
  // "回捞面不生效"的旧事实。跨帧 within（锚在另一文档）不受支持——anchor_ids 是帧内文档
  // 祖先链，宿主页 iframe 元素不会出现在子帧内容的祖先链里（§13.4 文档边界，不静默）。
  // declared 分支语义不变：只在"声明链合法但没命中 + 同时声明了 within"时追加本条。
  if (declared.length > 0 && withinAnchor !== undefined) {
    parts.push(`注意该目标同时声明了 within:${withinAnchor!.map((a) => `#${a}`).join(">")}——同帧 within 已在回捞面生效（E1）；`
      + `跨帧 within（锚在另一文档）不受支持：anchor_ids 是帧内文档祖先链，锚不在该帧文档 = 该帧无命中；`
      + `先排除"锚不在当前文档/帧"再归因 origin（heuristic 伪按钮行现已带 anchors）`);
  }
  const origins = allowedFrameOrigins(page, hosts);
  parts.push(`页面实际可用 origin（允许帧，去重 ≤6）: [${origins.length ? origins.join(", ") : "-"}]`);
  return parts.join(" — ");
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
