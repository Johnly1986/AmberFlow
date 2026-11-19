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
  describeFrameSuffixRejection, describeRowIndexSuffixRejection, describeRowSuffixRejection,
  frameChainValueProblem, parseHint, splitTailSuffixes, type ParsedHint,
} from "./hint.ts";
import { parseClickAtValue } from "./click-at.ts";
import { sleepMs } from "../support/sleep.ts"; import { POOL_CAP_ELEMENTS, STATE_TEXT_BUDGET_CHARS, WIDE_SCAN_POOL_ELEMENTS } from "../support/tuning.ts";
// frame:<origin> 帧链 helper（A 批，唯一出处 frame-scope.ts）：extraction 只做打点/帧过滤，
// 判定与 frameOriginOf 的实现都在 frame-scope（这里 re-export 保持既有导出面不变）。
import { elemFrameStamp, frameChainOf, frameGateExcludes, frameInHostsEnvelope, frameOriginOf, frameScopeMatchesFrame } from "./frame-scope.ts";
export { elemFrameStamp, frameChainOf, frameInHostsEnvelope, frameScopeMatches, frameScopeMatchesFrame, frameOriginOf } from "./frame-scope.ts";
// 内嵌 JS 探针区（COLLECT_JS/PASS_*…）拆到 pool-js.ts（F6）；导出面不变，这里读回同一份。
import {
  COLLECT_JS, PASS_EXTRACT, PASS_OBSERVE, PASS_WINDOW, PASS_UNDERLOAD,
  PASS_META, PASS_NEAR, PASS_HINT, PASS_HINT_PROBE, PASS_HEURISTIC, FN_TAG, FN_FIRST, FN_WRAPPER,
  PASS_LISTENER_FINGERPRINT,
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

/* ---- 纯区外搬（本轮拆分）：导出面由此处 re-export，既有 importer 零改动 ---- */
import { firstOf, framesOf, urlOf } from "./page-shapes.ts";
import { frameGateOf } from "./frame-scope.ts";
import type { Elem, ElemPool } from "./elem-model.ts";
export {
  ACTION_ADAPTERS, actionCapabilities, elemFamily, esig, extractSlots, filterElemsByFamily, firstIfSame, orderElemsByFamily,
} from "./elem-model.ts";
export type {
  ActionAdapter, ActionCapability, ActionLocatorLike, Elem, ElemFamily, ElemPool, PoolBucket, PoolQuotas,
} from "./elem-model.ts";
export { BUCKET_FILL_ORDER, BUCKET_ORDER, POOL_QUOTAS, QUOTA_MODE_QUOTAS, QUOTA_MODE_WIDE_QUOTAS, WIDE_QUOTAS } from "./elem-model.ts";
export { firstOf, framesOf, urlOf } from "./page-shapes.ts";
export {
  countAnyFrame, rowStatsAnyFrame, frameAt, frameGateOf, frameScopeEvidenceOf, framesScopedPage, locatorAnyFrame, splitFrameSuffixFromSelector,
} from "./frame-scope.ts";
export type { FrameGate, FrameScopeEvidence, SplitSelectorFrameSuffix } from "./frame-scope.ts";

/* page 形状类型已下沉 L0（src/support/page-like.ts）：这里 re-export 保持既有 importer 不变。 */
import type { FrameLike, InnerLoc, LocLike, PageLike } from "../support/page-like.ts";
export type { FrameLike, InnerLoc, LocLike, PageLike } from "../support/page-like.ts";

/**
 * P0-D：host 信封的**只读**判定（与执行器 `disallowedHost` 同一语义：hostname 精确或后缀）。
 * 帧 URL 无法解析 / about:blank / file: 等：返回 true（不可判 origin 时绝不擅自排除）。
 */
/** 信封布尔视图：true = 在声明的 hosts 信封内。单源实现见 host-envelope.ts（L2 合并）。 */
import { urlInHostsEnvelope } from "./host-envelope.ts";
export { urlInHostsEnvelope } from "./host-envelope.ts";


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
export const MAX_ELEMENTS = POOL_CAP_ELEMENTS;
/**
 * 低置信恢复路径宽扫的元素预算（executor 的 ONE wider look；R2 起同通道展开
 * 启发式伪按钮候选）。单一出处：executor 与 inspect --wide 共用。
 */
export const WIDE_POOL_ELEMENTS = WIDE_SCAN_POOL_ELEMENTS;


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
/** 2.2b 过渡：共享给 app 候选扫描（`src/app/candidate-scan.ts` 的 jsInteractiveWidgets）。 */
export const listenerCache = new Map<string, unknown[]>();

/** `listenerCacheKeyOf` 的指纹读数（`PASS_LISTENER_FINGERPRINT` 的返回形状）。 */
interface ListenerDomFingerprint {
  nodes?: unknown;
  bodyChildren?: unknown;
  visibleInteractive?: unknown;
  jsStamped?: unknown;
}

/**
 * 监听探针缓存键的**唯一出处**：`<url>|<总元素数>|<body 子元素数>|<可见原生交互数>|<已盖
 * data-js-ref 数>`（裸 URL 键会把陈旧"已扫"结论套到 SPA 换页/换日期后的新 DOM 上——URL
 * 不变而交互面已换，新控件永远盖不上 `data-js-ref`）。
 *
 * 为什么四项计数足以区分 SPA 换页/换日期：状态迁移是 DOM 重写——总元素数与 body 顶层
 * 结构几乎必然变化；新出现的原生交互面改变可见交互数；"已盖 data-js-ref 数"捕捉最隐蔽的
 * **同形重建**（节点数/结构/交互数全同、但旧章随旧节点消失）。指纹只读计数，单次
 * evaluate、零 CDP 往返；`jsStamped` 分量要求缓存键按**盖章后**的状态取——调用方在探针
 * 有产出时用盖章后的指纹重算键落缓存，否则自己的盖章会让下一次查找必然 miss。
 * evaluate 不可用/页面已换 → `|nofp` 后缀 = 退化为裸 URL 键（fail-open 到旧口径，不抛）。
 */
export async function listenerCacheKeyOf(page: PageLike): Promise<string> {
  const url = urlOf(page);
  let fp: ListenerDomFingerprint | null = null;
  try {
    fp = (await page.evaluate!(PASS_LISTENER_FINGERPRINT, { interactiveSel: POOL_SEL })) as ListenerDomFingerprint | null;
  } catch {
    fp = null;
  }
  const part = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? String(v) : "?");
  if (fp === null || typeof fp !== "object") return `${url}|nofp`;
  return `${url}|${part(fp.nodes)}|${part(fp.bodyChildren)}|${part(fp.visibleInteractive)}|${part(fp.jsStamped)}`;
}


/* ------------------------------------------------------------------ discovery */

/**
 * Discover the interactive elements the model and the executor may act on.
 * `jsProbe` runs the CDP listener walk first (cached per `listenerCacheKeyOf`:
 * URL + DOM fingerprint), so JS-only widgets (addEventListener divs) are stamped
 * `data-js-ref` and join the scan.
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
  /**
   * F83：dup 组内 DOM 先序位次（1-based）——OBSERVE_JS dup 门控编号（帧内同组按 rows 数组序；
   * 无 dup 页不出字段 ⇒ 观察 JSON 逐字节不变）。syntheticElem 透传后 observe 自证池与池行
   * 同构，suggestHints 第 6 档可给出 row-index 候选。不进模型面。
   */
  row_index?: number;
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
 *   - **不调用候选扫描（app/candidate-scan）的 jsInteractiveWidgets**（CDP 探针会盖章 `data-js-ref`，
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
      raw = null;   // frame detached / 无执行上下文：跳过（与候选扫描同口径）
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
 * 的那些（被 64/128 窗口或分桶顺序挤出；≤limit 条，按桶优先级排序）。
 * `shown` 由调用方给（池大小），这里只回答"页面有多少 / 窗口外还有哪些"。
 * 一区域一候选证据面（additive）：`dedup_dropped` = 同区域重复裁决里让位的元素
 * （tag/label/why；章由 EXTRACT_JS 盖、每趟清旧章）——它们不是"窗口挤出"，单列成账；
 * 无被剔时不出现该键（旧产物逐字节不变）。
 */
export async function windowAudit(
  page: PageLike, shown: number, limit = 10,
): Promise<{ visible_interactive: number; shown: number; out_of_window_total: number; out_of_window: Array<{ tag: string; label: string; prio: number; bucket: string }>; surface_counts: Record<string, number>; dedup_dropped?: Array<{ tag: string; label: string; why: string }> }> {
  type WindowRaw = { visible_interactive?: number; out_of_window_total?: number; out_of_window?: unknown; surface_counts?: unknown; dedup_dropped?: unknown };
  let raw: WindowRaw | null = null;
  try {
    // U3：只读计数面用 ADMIT_SEL（不是池基准）；绝不用它的下标当 scan。
    raw = (await page.evaluate!(PASS_WINDOW, { sel: admitSelectorWithJsFor(), limit, cats: SURFACE_SELECTORS })) as WindowRaw | null;
  } catch {
    raw = null;
  }
  const rows = Array.isArray(raw?.out_of_window) ? (raw!.out_of_window as Array<Record<string, unknown>>) : [];
  const drops = Array.isArray(raw?.dedup_dropped) ? (raw!.dedup_dropped as Array<Record<string, unknown>>) : [];
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
    // 有界证据（40 条足够归因；整页被剔通常是个位数）。无被剔 = 键不出现（additive）。
    ...(drops.length > 0
      ? { dedup_dropped: drops.slice(0, 40).map((r) => ({
          tag: String(r["tag"] ?? ""),
          label: String(r["label"] ?? ""),
          why: String(r["why"] ?? ""),
        })) }
      : {}),
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


/* ------------------------------------------------------------------ CDP probe */

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
    if (frameGateExcludes(fi, frames[fi]!, opts?.hosts)) continue;   // P0-D：排除帧不参与回捞
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
   * ≥ `matchedChains.length`）。把"去重"与"截断到 ≤4"共用一个条件时，>4 条证据里
   * 连总数都看不到；这里总数恒有、列表仍 ≤4。
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

/** DOM 等价探测的单条匹配（class 首段仅诊断显示用；visible = 可见盒判定）。 */
export type HintInDomMatch = { tag: string; id: string; class?: string; visible: boolean };

/** DOM 等价探测命中的事实块：total = 全量 distinct 命中数；matches = 前 5 条带可见性；note = 可行动原因。 */
export type HintInDomProbe = { total: number; matches: HintInDomMatch[]; note: string };

/** 文本 bbox 探测的单条命中（视口 CSS 像素；visible 已过滤）。 */
export type TextBboxHit = { tag: string; id: string; class?: string; x: number; y: number; w: number; h: number };

/**
 * clickxy：文本全等的**唯一可见**命中 → bbox 中心（clickxy 最后手段的定位底座）。
 *
 * 语义与 DRF text 模式同口径：TreeWalker 走文本节点（≤20000），取归一化后 innerText 全等
 * 的元素（trim + 小写折叠两侧），**最深优先**（祖先含后代时只留后代），**恰好一个可见**
 * 才返回（>1 = 歧义，返回 `{ambiguous:true, total}` 供调用方零动作；0 可见 = null）。
 * 与 DRF text 的差异只在**输出**：这里给 bbox 中心而不是 locator（无句柄可寻址的场景）。
 * 单一出处 = 本 helper（`_resolveClickxyFallback` 唯一消费）；只读、主帧、异常 = null。
 */
export async function probeTextBbox(page: PageLike, token: string): Promise<{ hit: TextBboxHit; total: number } | { ambiguous: true; total: number } | null> {
  const want = String(token ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (want === "") return null;
  let got: unknown;
  try {
    got = await page.evaluate!((arg: { want: string; maxInt: number }) => {
      const g = globalThis as unknown as {
        document: {
          body: any; documentElement: any;
          createTreeWalker(root: any, whatToShow: number): { nextNode(): any };
        };
      };
      const doc = g.document;
      const norm = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const root = doc.body ?? doc.documentElement;
      const found: any[] = [];
      const seen = new Set<any>();
      const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
      let node = walker.nextNode(); let scanned = 0;
      while (node !== null && scanned < arg.maxInt) {
        scanned += 1;
        if (norm(node.nodeValue) === arg.want) {
          const el = node.parentElement;
          if (el !== null && !seen.has(el)) { seen.add(el); found.push(el); }
        }
        node = walker.nextNode();
      }
      // 最深优先：祖先候选（严格包含另一个候选）剪掉。
      const deepest = found.filter((e: any) => !found.some((o: any) => o !== e && e.contains(o)));
      const visible = deepest.filter((e: any) => {
        try {
          if (e.checkVisibility && !e.checkVisibility({ checkVisibilityCSS: true, checkOpacity: false })) return false;
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        } catch { return false; }
      });
      const rows = visible.map((e: any) => {
        const r = e.getBoundingClientRect();
        const cls = String(e.getAttribute("class") ?? "").trim();
        return {
          tag: String(e.tagName ?? "").toLowerCase(), id: String(e.id ?? ""),
          ...(cls ? { class: cls.split(/\s+/)[0].slice(0, 40) } : {}),
          x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
          w: Math.round(r.width), h: Math.round(r.height),
        };
      });
      return { total: rows.length, rows: rows.slice(0, 5) };
    }, { want, maxInt: 20000 });
  } catch {
    return null;
  }
  const row = (got ?? null) as { total: number; rows: Array<Record<string, unknown>> } | null;
  if (row === null || !(Number(row.total) > 0)) return null;
  if (Number(row.total) > 1) return { ambiguous: true, total: Number(row.total) };
  const m = row.rows[0]!;
  return {
    hit: {
      tag: String(m["tag"] ?? ""), id: String(m["id"] ?? ""),
      ...(m["class"] !== undefined && String(m["class"]) !== "" ? { class: String(m["class"]) } : {}),
      x: Number(m["x"] ?? 0), y: Number(m["y"] ?? 0), w: Number(m["w"] ?? 0), h: Number(m["h"] ?? 0),
    },
    total: 1,
  };
}

/**
 * `target_not_found` 落定前的**只读 CSS 等价探测**——区分"池准入失败"与"页面没有"。
 *
 * 单一出处 = 本 helper（session act 诊断面与 run strict 面共用）；observe 面的人读文案
 * 另有镜像，不从这里取。探测口径与解析闭集对齐：
 *   - `#id` → `getElementById`；
 *   - `tag[attr=value]` / `tag[attr~substr]` → `querySelectorAll`（`~` 的 loose 子串 = CSS
 *     `*=`，值引号转义；aria-label 的池侧别名在 label 字段——DOM 侧以 aria-label 属性为
 *     该字段的投影，与 hintMatch 同口径）；
 *   - 裸词 → 文本全等（TreeWalker 走**文本节点**、有界 ≤20000，取直接父元素按元素去重；
 *     复用 DRF text 收集思路）+ `aria-label` 属性全等（图标按钮无可见文本，label 别名是
 *     hintMatch 的实际匹配面）。
 * `tag` / `tag~token` 形状不探测（存在性近乎恒真 / near 是上下文面，无判别力）；带
 * `within` / `in-row:` / `frame:` 声明的 hint 也不探测——那些是池面结构约束，命中会误导
 * （锚外/行外/跨帧元素同样"在 DOM"，但落空原因不是准入；fail-closed 同 `_liveDomIdFallback`
 * 的行锚取舍）。归一 = trim + 小写折叠两侧（bare 梯队 tier-0 同口径，不含内部空白折叠）。
 * 主帧 only（page.evaluate）；任何异常 = 返回 null（调用方 reason 逐字节不变，绝不抛栈）。
 */
export async function probeHintInDom(page: PageLike, hint: string): Promise<HintInDomProbe | null> {
  let parsed: ParsedHint;
  try { parsed = parseHint(hint); } catch { return null; }
  const mode = parsed.kind === "id" ? "id"
    : parsed.kind === "attrEq" ? "attrEq"
    : parsed.kind === "attrSubstr" ? "attrSubstr"
    : parsed.kind === "bare" ? "bare" : null;
  if (mode === null) return null;
  if (parsed.within !== undefined || parsed.inRow !== undefined || parsed.rowIndex !== undefined
      || parsed.frameChain !== undefined) return null;
  let got: unknown;
  try {
    got = await page.evaluate!((arg: { mode: string; tag: string; attr: string; value: string; token: string; maxMatches: number }) => {
      // 浏览器侧执行（Node strip-types 下类型注释被擦除，源码原样进页面）；document 等
      // 浏览器全局只在这里就地声明（与 PASS_* 常量的本地声明同一惯例）。
      const g = globalThis as unknown as {
        document: {
          body: any; documentElement: any;
          getElementById(id: string): any;
          querySelectorAll(sel: string): ArrayLike<any>;
          createTreeWalker(root: any, whatToShow: number): { nextNode(): any };
        };
        getComputedStyle(el: any): { display: string; visibility: string };
      };
      const doc = g.document;
      const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase();
      const visible = (el: any): boolean => {
        const r = el.getBoundingClientRect();
        const cs = g.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
      };
      const capOf = (el: any): Record<string, unknown> => {
        const cls = String(el.getAttribute("class") ?? "").trim();
        return {
          tag: String(el.tagName ?? "").toLowerCase(),
          id: String(el.id ?? ""),
          ...(cls ? { class: cls.split(/\s+/)[0].slice(0, 40) } : {}),
        };
      };
      const q = (v: string): string => `"${v.replace(/[\\"]/g, "\\$&")}"`;
      let els: any[] = [];
      if (arg.mode === "id") {
        const el = doc.getElementById(arg.value);
        if (el !== null) els = [el];
      } else if (arg.mode === "attrEq" || arg.mode === "attrSubstr") {
        // `~` 的池侧语义是 loose 子串（attrMatchValues.includes）→ CSS 等价 = `*=`（值默认
        // 大小写敏感，与池侧一致）。
        const sel = `${arg.tag}[${arg.attr}${arg.mode === "attrEq" ? "=" : "*="}${q(arg.value)}]`;
        els = Array.from(doc.querySelectorAll(sel));
      } else {
        // 裸词：文本全等（TreeWalker SHOW_TEXT=4，≤20000 文本节点；直接父元素即候选，按元素
        // 去重）+ aria-label 全等（label 别名，与 hintMatch 同口径）。
        const seen = new Set<any>();
        const root = doc.body ?? doc.documentElement;
        const walker = doc.createTreeWalker(root, 4);
        let node = walker.nextNode(); let scanned = 0;
        while (node !== null && scanned < 20000) {
          scanned++;
          if (norm(node.data) === arg.token) {
            const el = node.parentElement;
            if (el !== null) seen.add(el);
          }
          node = walker.nextNode();
        }
        for (const el of Array.from(doc.querySelectorAll("[aria-label]"))) {
          if (norm(el.getAttribute("aria-label")) === arg.token) seen.add(el);
        }
        els = Array.from(seen);
      }
      const withId = els.filter((el) => String(el.id ?? "") !== "").length;
      const withDataTest = els.filter((el) => el.hasAttribute("data-test")).length;
      const matches = els.slice(0, arg.maxMatches).map((el) => ({ ...capOf(el), visible: visible(el) }));
      return { total: els.length, withId, withDataTest, matches };
    }, {
      mode,
      tag: parsed.kind === "attrEq" || parsed.kind === "attrSubstr" ? parsed.tag : "",
      attr: parsed.kind === "attrEq" || parsed.kind === "attrSubstr" ? parsed.attr : "",
      value: parsed.kind === "id" ? parsed.value
        : parsed.kind === "attrEq" || parsed.kind === "attrSubstr" ? parsed.value : "",
      token: parsed.kind === "bare" ? parsed.token : "",
      maxMatches: 5,
    });
  } catch {
    return null;                 // 探测异常 = 跳过（绝不抛栈）；reason 逐字节不变
  }
  const row = (got ?? null) as { total: number; withId: number; withDataTest: number; matches: Array<Record<string, unknown>> } | null;
  if (row === null || !(Number(row.total) > 0)) return null;
  const matches: HintInDomMatch[] = (Array.isArray(row.matches) ? row.matches : []).slice(0, 5).map((m) => ({
    tag: String(m["tag"] ?? ""),
    id: String(m["id"] ?? ""),
    ...(m["class"] !== undefined && String(m["class"]) !== "" ? { class: String(m["class"]) } : {}),
    visible: m["visible"] === true,
  }));
  // 可行动原因按**全量命中**的句柄事实判定（不只看前 5 条）：无句柄 = class-only（准入面
  // 收不进来）；有句柄 = 池帽/准入面/帧排除类原因。
  const withId = Number(row.withId ?? 0);
  const withDataTest = Number(row.withDataTest ?? 0);
  const handle = withId > 0 && withDataTest > 0 ? "id/data-test" : withId > 0 ? "id" : withDataTest > 0 ? "data-test" : null;
  const note = handle === null
    ? "class-only control(s) (no id/data-test stable handle) — the pool admission surface never collects "
      + "them; give one a stable handle (id/[data-test]) or enable declared-DOM resolution "
      + "(meta.policy.target_resolution:\"declared\")"
    : `stable handle present (${handle}) but the matched element(s) stayed outside the pool `
      + "(pool cap / surface policy / frame exclusion)";
  return { total: Number(row.total), matches, note };
}

/**
 * C 批（B8/D7）：页面**允许帧**的 origin 列表（去重、≤6，主帧在前）。
 * 口径与门禁一致：主帧恒允许；子帧 origin 不在 hosts 信封内 = 排除（不列）。
 */
export function allowedFrameOrigins(page: PageLike, hosts: string[] | null | undefined): string[] {
  const out: string[] = [];
  const frames = framesOf(page);
  for (let i = 0; i < frames.length; i++) {
    if (frameGateExcludes(i, frames[i]!, hosts)) continue;
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
  // F83：row-index 侧证据状态（被拒文案 / 第一个合法声明的序号）。
  const rowIdxRejections: string[] = [];
  let declaredRowIndex: number | undefined;
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
    // F83：row-index 侧（同目标串）——被拒点名；合法声明记序号（只记第一个，证据有界）。
    const rowIdxRejection = describeRowIndexSuffixRejection(target);
    if (rowIdxRejection !== null) {
      if (!rowIdxRejections.includes(rowIdxRejection)) rowIdxRejections.push(rowIdxRejection);
    } else if (parsed.rowIndex !== undefined && declaredRowIndex === undefined) {
      declaredRowIndex = parsed.rowIndex;
    }
  }
  // 无尾缀参与 = 空串（旧 reason 逐字节不变）。F82/F83：in-row / row-index 参与（被拒尝试
  // 或合法声明 + 池在手）也要给证据，故提前返回条件在旧条件上 additive。
  if (rejections.length === 0 && declared.length === 0 && rowRejections.length === 0
      && rowIdxRejections.length === 0
      && !(elems !== undefined && (declaredToken !== undefined || declaredRowIndex !== undefined))) {
    return "";
  }
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
  // F83：row-index 案①/②证据（纯内存；elems 未传 = 跳过）。匹配口径 = row_index 整数全等
  // （与 rules.rowIdx 同口径；extraction 不能 import rules，一行口径改动须两处同步）。
  // 编号口径 = 帧内 (tag+label) dup 子组 DOM 先序（addNearContext 宿主编号）——本面 K 即池面
  // 可见组大小（截断边界 v1.0 §3.4，案①如实报本面 K）。
  let rowIdxEvidence: string | null = null;
  if (elems !== undefined && declaredRowIndex !== undefined) {
    const n = declaredRowIndex;
    const hitRefs = Object.entries(elems)
      .filter(([, e]) => e.row_index === n)
      .map(([r]) => r);
    if (hitRefs.length === 0) {
      // 案①：越界（N > K）或组不存在 → 报本面网格组大小 K（按 tag+label 分组，≤3 组）
      // + 真实行词元 ≤8（镜像 in-row 案①与 frame: "页面实际可用 origin" 先例）。
      const groups = new Map<string, { tag: string; label: string; k: number }>();
      for (const e of Object.values(elems)) {
        if (e.row_index === undefined) continue;
        const key = `${e.tag}\u0000${e.label}`;
        const g = groups.get(key)
          ?? { tag: e.tag, label: e.label, k: 0 };
        g.k = Math.max(g.k, e.row_index);
        groups.set(key, g);
      }
      const groupsText = [...groups.values()].slice(0, 3)
        .map((g) => `${g.tag} ${JSON.stringify(g.label)} K=${g.k}`).join(", ");
      const toks: string[] = [];
      for (const e of Object.values(elems)) {
        for (const line of Array.isArray(e.row_texts) ? e.row_texts : []) {
          for (const w of String(line).toLowerCase().split(/\s+/)) {
            if (w === "" || w.length > 20 || toks.includes(w)) continue;
            toks.push(w);
          }
          if (toks.length >= 8) break;
        }
        if (toks.length >= 8) break;
      }
      rowIdxEvidence = `row-index:${JSON.stringify(n)} 超出网格组大小（row-index 从 1 开始、按组内`
        + ` DOM 先序编号）——网格组大小 ≤3 组: [${groupsText || "-"}]——池面真实行词元 ≤8: `
        + `[${toks.join(", ") || "-"}]`;
    } else {
      // 案②：序号已定位（第 N 个成员在池内）但 hint 整体未命中 → 作者核对组合守卫 token /
      // 改 base 不改序号。
      const withIdx = targets.find((t) => typeof t === "string" && parseHint(t as string).rowIndex !== undefined) as string;
      const base = splitTailSuffixes(withIdx).base;
      rowIdxEvidence = `row-index:${JSON.stringify(n)} 已定位 ${hitRefs.length} 个第 ${n} 成员`
        + `（${hitRefs.slice(0, 3).join(", ")}）但行内没有命中 base ${JSON.stringify(base)}——`
        + `序号已定位：核对组合守卫 in-row token 或改 base 不改序号`;
    }
  }
  const parts: string[] = [];
  if (rejections.length > 0) parts.push(rejections.slice(0, 2).join("；"));
  if (rowRejections.length > 0) parts.push(rowRejections.slice(0, 2).join("；"));
  if (rowIdxRejections.length > 0) parts.push(rowIdxRejections.slice(0, 2).join("；"));
  if (rowEvidence !== null) parts.push(rowEvidence);
  if (rowIdxEvidence !== null) parts.push(rowIdxEvidence);
  if (declared.length > 0) {
    parts.push(`声明链 ${declared.slice(0, 2).map((c) => JSON.stringify(c)).join(" / ")} `
      + `在允许帧里没有命中（检查 origin 是否写错/该帧是否被 hosts 排除）`);
  }
  // 实施复审 N-R2a（E1 后更新）：同帧 within 已在回捞面生效（E1——五池补 anchor_ids +
  // FW8/F64/DRF-text 按 within 过滤/DRF-attr 经 hintCandidates→inAnchor 自动消费），即
  // "回捞面不生效"不成立。跨帧 within（锚在另一文档）不受支持——anchor_ids 是帧内文档
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
export async function stateText(page: PageLike, query: string, _embedFn: unknown = null, budget = STATE_TEXT_BUDGET_CHARS): Promise<string> {
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
