/**
 * P0-A `ctx.observe()` —— **只读观察原语**的宿主侧实现。
 *
 * 语义（与 `ctx.ts`/`docs/APP_SCRIPT_AUTHORING.md` 是同一份口径）：
 *   - **免费**：不计 `ctx.step`/`arrive` 预算、不写 outDir、不进模型请求面（不调用任何
 *     provider / 不抽决策池）、不改页面状态（`page.evaluate` 只读 DOM；不点击/不滚动/
 *     不导航/不盖章）；
 *   - **观察 ≠ 池**：返回 DOM 侧真实存在的准入面元素（`selector` 给定时以它为准），
 *     不要求入池；`admitted` 才是"引擎今天能不能按声明指向它"的判据；
 *   - **不制造新的"照抄必失败"**：`hint_candidates` 每一条都用同一个 `rules.hintMatch`
 *     在**本次观察到的准入面元素集合**上自证（恰好唯一命中该元素才保留）。这比真实池
 *     （120 窗口/分桶子集）更严：能在观察集合里唯一命中的形状，在包含该元素的任何池子集
 *     里同样唯一；反过来，真实池没这个元素时 hint 仍会落空——窗口/分桶是池的事实，
 *     observe 只回答"准入面可解析"，不冒充"一定在本次窗口内"（inspect --json 的
 *     `window` 才答窗口问题）。
 *
 * 为什么不在 observe 里调 `extractElements`：那是池提取（盖章 `data-dshref`、跑 CDP
 * 监听探针 `data-js-ref`、按窗口/分桶裁序）——既改页面（写属性），又把一次观察的成本
 * 变成多次往返。observe 只做一次 DOM 读。
 *
 * dry：不访问浏览器，返回合成形状（`{ok:true, dry:true, counts 全 0, elements:[]}`）；
 * replay：不访问浏览器，按录制事件还原 `counts`/`truncated`（元素明细不进 trace，见
 * `trace.ts` 的 observe 事件），`elements: []`。两处实现分别在 ctx-dry.ts / ctx-replay.ts。
 */
import type { Elem, ElemPool, PageLike } from "./extraction.ts";
import { observeElements, urlOf, type ObserveRawRow } from "./extraction.ts";
import type { SurfacePolicy } from "./surface.ts";
import { suggestHints } from "./rules.ts";

/** `ctx.observe({max})` 的缺省与硬上限（有界：单次观察最多 200 行）。 */
export const OBSERVE_DEFAULT_MAX = 120;
export const OBSERVE_HARD_MAX = 200;
/** 可达子 frame 的观察上限（主 frame + ≤5 子 frame，与 framesOf 同口径）。 */
export const OBSERVE_FRAME_LIMIT = 6;

export interface ObserveOptions {
  /** 返回行数上限（缺省 120，硬上限 200；所有 frame 合计）。 */
  max?: number;
  /** 任意 CSS（只读过滤）；缺省 = 当前生效的准入面（ADMIT_SEL 投影 + JS 探针后缀）。 */
  selector?: string;
  /** 是否包含不可见元素（缺省 false；包含时该行 `visible:false`，且 `admitted:false`）。 */
  includeHidden?: boolean;
  /** 是否观察可达子 frame（缺省 true；主 frame + ≤5 子 frame）。 */
  includeFrames?: boolean;
  /**
   * B 批：是否附带**结构证据** `structure_path`（缺省 false）。true 时元素行多
   * `structure_path`（祖先 tag/`#id` + 同 tag 兄弟序号 + 帧下标前缀，≤160 字符）与
   * `structure_unstable:true`。只作诊断：动态页面（重排/虚拟列表/插入广告）随时失效，
   * **不可照抄进 hint/target**，也不进 hint 自证、歧义证据或模型请求面。
   */
  includeStructure?: boolean;
}

export interface ObserveBBox { x: number; y: number; w: number; h: number }

/** `ctx.observe()` 的元素行（MVP 稳定字段）。 */
export interface ObserveElement {
  /** 观察序号 `o0/o1…`（**不是**池 ref `eN`，也不冒充）。 */
  ref: string;
  tag: string;
  role?: string;
  label?: string;
  id?: string;
  name?: string;
  data_test?: string;
  type?: string;
  /** DOM 原始 `getAttribute('href')`（T9 href_full 口径：query/fragment/origin 都在）。 */
  href?: string;
  /** 有界类名（≤8 个、每项 ≤40 字符）。 */
  class_names?: string[];
  visible: boolean;
  bbox?: ObserveBBox;
  /** 当前准入面（匹配 ADMIT_SEL + 可见 + 至少一条 hintMatch 自证 hint）可解析。 */
  admitted: boolean;
  why_not_admitted?: string;
  /** 经同一个 hintMatch 在本次观察集合上自证的形状（可照抄进 ctx.hint/命令 target）。 */
  hint_candidates?: string[];
  /** 0 = 主 frame；与 `frames[]` 的下标一致。 */
  frame?: number;
  /**
   * A 批数据面 / B 批观察面透传：元素所在帧的 origin 与祖先 origin 链（外→内；主帧
   * `frame_path` 省略；两字段都缺 = 未知 origin 帧，如 about:blank/srcdoc）。`frame:`
   * 候选与匹配判定的底座；非空才出现（与既有可选字段同口径）。
   */
  frame_origin?: string;
  frame_path?: string[];
  /**
   * F82（in-row 观察面闭环）：行上下文文本（≤6 行 × ≤40 字符）——**仅同文案重复组元素
   * 携带**（OBSERVE_JS dup 门控；无 dup 页不出字段 ⇒ 观察 JSON 逐字节不变）。in-row 匹配
   * 底座与 suggestHints 第 5 档的词元来源；不进模型面。边界：dup 判定只对观察集合内可见
   * 同文案计数执行（max 截断边界见 APP_SCRIPT_AUTHORING §4.12）。
   */
  row_texts?: string[];
  /**
   * F83（row-index 观察面闭环）：dup 组内 DOM 先序位次（1-based）——**仅同文案重复组元素
   * 携带**（帧内同组；无 dup 页不出字段 ⇒ 观察 JSON 逐字节不变）。row-index 匹配底座与
   * suggestHints 第 6 档的序号来源（内容不可分网格的可行动出口）；不进模型面。序号即语义
   * 的序漂移责任在作者（APP_SCRIPT_AUTHORING §4.13）。
   */
  row_index?: number;
  /**
   * B 批：**结构证据**（仅 `includeStructure:true` 时出现；≤160 字符）。祖先 tag/`#id` +
   * 同 tag 兄弟序号 + 帧下标前缀（如 `f2>div#panel>button[2]`）——只回答"在哪个子树"，
   * **不是 hint**：动态页面可能失效、不可照抄。
   */
  structure_path?: string;
  /** 结构证据的不稳定标记（与 `structure_path` 同出现：一眼看出"不是 hint"）。 */
  structure_unstable?: true;
}

export interface ObserveResult {
  ok: boolean;
  url: string;
  title?: string;
  /** 主 frame + 可达子 frame 的 URL 摘要（`frame` 字段是它的下标）。 */
  frames?: string[];
  counts: { elements: number; admitted: number; omitted: number };
  truncated: boolean;
  elements: ObserveElement[];
  /** 结构化错误（目前只有非法 `selector`）；`ok:false` 时出现，不抛栈、不中断 flow。 */
  error?: "bad_selector";
  reason?: string;
  /** dry 面合成标记（无页面观察）。 */
  dry?: true;
  /** replay 面合成标记（元素明细未进 trace，只还原 counts/truncated）。 */
  replay?: true;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 声明面形状校验（真实/dry/replay 共用；非法值 = 结构化 config_error，不做静默截断）。 */
export function validateObserveOptions(opts: unknown): string[] {
  if (opts === undefined) return [];
  if (!isObj(opts)) return ["ctx.observe: options must be an object like { max, selector, includeHidden, includeFrames, includeStructure }"];
  const p: string[] = [];
  const allowed = new Set(["max", "selector", "includeHidden", "includeFrames", "includeStructure"]);
  for (const k of Object.keys(opts)) {
    if (!allowed.has(k)) p.push(`ctx.observe: unknown option ${JSON.stringify(k)} (allowed: max, selector, includeHidden, includeFrames, includeStructure)`);
  }
  const { max, selector, includeHidden, includeFrames, includeStructure } = opts;
  if (max !== undefined && (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > OBSERVE_HARD_MAX)) {
    p.push(`ctx.observe: opts.max must be an integer 1..${OBSERVE_HARD_MAX} (got ${JSON.stringify(max)})`);
  }
  if (selector !== undefined && (typeof selector !== "string" || selector.trim() === "")) {
    p.push(`ctx.observe: opts.selector must be a non-empty CSS string (got ${JSON.stringify(selector)})`);
  }
  if (includeHidden !== undefined && typeof includeHidden !== "boolean") {
    p.push(`ctx.observe: opts.includeHidden must be a boolean (got ${JSON.stringify(includeHidden)})`);
  }
  if (includeFrames !== undefined && typeof includeFrames !== "boolean") {
    p.push(`ctx.observe: opts.includeFrames must be a boolean (got ${JSON.stringify(includeFrames)})`);
  }
  if (includeStructure !== undefined && typeof includeStructure !== "boolean") {
    p.push(`ctx.observe: opts.includeStructure must be a boolean (got ${JSON.stringify(includeStructure)})`);
  }
  return p;
}

/** 规范化（调用前必须已过 validateObserveOptions）。 */
export function normalizeObserveOptions(opts: ObserveOptions = {}): Required<Pick<ObserveOptions, "max" | "includeHidden" | "includeFrames" | "includeStructure">> & Pick<ObserveOptions, "selector"> {
  return {
    max: opts.max ?? OBSERVE_DEFAULT_MAX,
    ...(opts.selector === undefined ? {} : { selector: opts.selector }),
    includeHidden: opts.includeHidden === true,
    includeFrames: opts.includeFrames !== false,
    includeStructure: opts.includeStructure === true,
  };
}

/** 池的 href 展示投影（与 EXTRACT_JS 逐字节同口径；只用于观察集合内的 hint 匹配）。 */
function projectHref(href: string): string {
  return href ? href.split("?")[0]!.replace(/\/+$/, "").split("/").slice(-2).join("/") : "";
}

/**
 * 把一条观察行变成**与池同构**的 `Elem`（只用于同一个 `suggestHints`/`hintMatch` 自证）。
 * 关键口径与 EXTRACT_JS 一致：`label` 是模型视图前缀 40、`full_label` 是 ≤200 的匹配串、
 * `href` 是展示投影而 `href_full` 是原始属性。
 */
function syntheticElem(row: ObserveRawRow, ref: string): Elem {
  const labelFull = String(row.label ?? "");
  return {
    ref,
    tag: row.tag,
    // A1 不变量：label === full_label 的前 40 字（同一 labelFull 截断）。
    label: labelFull.slice(0, 40),
    full_label: labelFull.slice(0, 200),
    ...(row.data_test ? { data_test: row.data_test } : {}),
    ...(row.name ? { name: row.name } : {}),
    ...(row.id ? { id: row.id } : {}),
    ...(row.type ? { input_type: row.type } : {}),
    ...(row.href ? { href: projectHref(row.href), href_full: row.href } : {}),
    ...(row.role ? { role: row.role } : {}),
    // E3：OBSERVE_JS 采集的祖先 id 链（≤8、小写、最近祖先在前）——within:#id 的
    // observe 侧底座；无 id 祖先时字段不出现（观察集合形状与池行一致）。
    ...(Array.isArray(row.anchor_ids) && row.anchor_ids.length > 0 ? { anchor_ids: row.anchor_ids } : {}),
    // F82（in-row 观察面闭环）：OBSERVE_JS dup 门控采集的行上下文透传——observe 自证池
    // 与池行同构，suggestHints 第 5 档据此给出 in-row 候选（anchor_ids 先例：无 dup 组时
    // 字段不出现，观察集合形状不变）。
    ...(Array.isArray(row.row_texts) && row.row_texts.length > 0 ? { row_texts: row.row_texts } : {}),
    // F83（row-index 观察面闭环）：dup 组内 DOM 先序位次透传——suggestHints 第 6 档据此给出
    // row-index 候选（内容不可分网格的可行动出口）；无 dup 组时字段不出现。
    ...(typeof row.row_index === "number" ? { row_index: row.row_index } : {}),
    // A 批（frame:<origin>）：observeElements 宿主侧按帧打点的帧链两字段透传——observe
    // 自证池与池行同构，帧限定候选（frame:<origin>）因此可被自证/给出（R2-9）。
    ...(row.frame_origin !== undefined ? { frame_origin: row.frame_origin } : {}),
    ...(row.frame_path !== undefined ? { frame_path: row.frame_path } : {}),
  };
}

const orUndef = (s: string | undefined): string | undefined =>
  typeof s === "string" && s !== "" ? s : undefined;

/** 不可入池/不可解析的**可行动**原因（给 Agent 看的下一步，不是错误码堆叠）。 */
function whyNotAdmitted(row: ObserveRawRow, classNames: string[] | undefined): string {
  const tag = row.tag;
  const cls = classNames !== undefined && classNames.length > 0 ? ` class="${classNames.join(" ")}"` : "";
  const handle = orUndef(row.id) !== undefined ? `#${row.id}`
    : orUndef(row.data_test) !== undefined ? `[data-test=${row.data_test}]`
      : orUndef(row.name) !== undefined ? `[name=${row.name}]`
        : orUndef(row.role) !== undefined ? `role=${row.role}` : undefined;
  if (row.visible !== true) {
    return `${tag}${cls}: not visible (display:none / visibility:hidden / zero-size box) — the pool only holds visible elements; pass includeHidden:true to inspect it anyway`;
  }
  if (row.in_surface !== true) {
    const base = handle === undefined
      ? `class-only ${tag}${cls}: no role/id/data-test/aria-label/href and not in the admission surface`
      : `${tag}${cls}: has a stable handle (${handle}) but is outside the admission surface`;
    return `${base} — add a supported role (role="button") or [onclick]/[tabindex] to enter the admission surface; `
      + `a stable handle alone is only usable by declared-target identity recovery (FW8), not by the pool`;
  }
  return `${tag}${cls}: in the admission surface but no uniquely-resolvable hint shape `
    + `(label empty or shared with another candidate) — add id/name/data-test, make the visible label unique, `
    + "or scope a shared label with `<label> within:#<ancestor-id>`"
    + " (E2 chains also supported: `<label> within:#outer>#inner`, outer-to-inner, <=4 segments)"
    + " — for identical-text row grids (same-label buttons/cards), anchor by row content instead:"
    + " copy a self-verified `<label> in-row:<token>` from hint_candidates (`row_texts` rows carry"
    + " the tokens; row context is collected for same-text duplicate groups ONLY — a non-duplicate"
    + " element can never match `in-row:`, by design); when every row's content is identical (no"
    + " distinguishing tokens), use `<label> row-index:N` to pick by grid order instead (1-based"
    + " DOM order within the duplicate group — the order IS the semantics, the author owns order"
    + " drift; pairing it with an in-row guard or a content done-assertion turns silent mis-picks"
    + " into explicit misses). Boundary: hint_candidates self-verify against"
    + " THIS observation set, not the run pool window (admitted ≠ in the 40/120 pool)";
}

/**
 * 在当前会话页上做一次只读观察。**不**调用 provider、**不**抽决策池、**不**写文件。
 * 非法 selector 返回 `{ok:false, error:"bad_selector", reason}`（不抛栈、不中断 flow）。
 *
 * F83 批 3（deny-list 可配化）：`extras.hintTokenAllow`（meta.policy.hint_token_allow 经
 * CtxDeps 下传）直达自证池的 suggestHints 词元护栏（单点消费）；缺省 undefined = 护栏行为
 * 逐字节不变。会话/桥面无 meta policy → 缺省（面边界与 F58 attr_value_match 同款）。
 */
export async function observePage(
  page: PageLike,
  opts: ObserveOptions = {},
  surface?: SurfacePolicy,
  extras?: { hintTokenAllow?: readonly string[] },
): Promise<ObserveResult> {
  const normalized = normalizeObserveOptions(opts);
  const collected = await observeElements(page, {
    ...(normalized.selector === undefined ? {} : { selector: normalized.selector }),
    max: normalized.max,
    includeHidden: normalized.includeHidden,
    includeFrames: normalized.includeFrames,
    includeStructure: normalized.includeStructure,
    ...(surface === undefined ? {} : { surface }),
  });
  const url = urlOf(page);
  const frames = collected.frames.slice(0, OBSERVE_FRAME_LIMIT);
  if (collected.badSelector !== undefined) {
    return {
      ok: false, url,
      counts: { elements: 0, admitted: 0, omitted: 0 }, truncated: false, elements: [],
      error: "bad_selector",
      reason: `selector ${JSON.stringify(normalized.selector)} is not valid CSS: ${collected.badSelector}`,
    };
  }
  const elements: ObserveElement[] = collected.rows.map((row, i) => {
    const classNames = Array.isArray(row.class_names) && row.class_names.length > 0 ? row.class_names.slice(0, 8) : undefined;
    // A 批数据面 / B 批观察面：帧链两字段非空才出现（与既有可选字段同口径）；未知 origin
    // 帧两字段都缺（与池行一致，不编造 "null"/空串）。
    const frameOrigin = orUndef(row.frame_origin);
    const framePath = Array.isArray(row.frame_path) && row.frame_path.length > 0 ? row.frame_path : undefined;
    // B 批结构证据只由 opt-in 的 OBSERVE_JS 产出；空串不出现（诊断字段不冒充事实）。
    const structurePath = orUndef(row.structure_path);
    // F82：dup 门控采集的行上下文（仅重复组携带；无 dup 页不出字段 ⇒ 观察 JSON 逐字节不变）。
    const rowTexts = Array.isArray(row.row_texts) && row.row_texts.length > 0 ? row.row_texts : undefined;
    // F83：dup 组内 DOM 先序位次（仅重复组携带；无 dup 页不出字段 ⇒ 观察 JSON 逐字节不变）。
    const rowIndex = typeof row.row_index === "number" ? row.row_index : undefined;
    return {
      ref: `o${i}`,
      tag: row.tag,
      ...(orUndef(row.role) === undefined ? {} : { role: row.role }),
      ...(orUndef(row.label) === undefined ? {} : { label: row.label }),
      ...(orUndef(row.id) === undefined ? {} : { id: row.id }),
      ...(orUndef(row.name) === undefined ? {} : { name: row.name }),
      ...(orUndef(row.data_test) === undefined ? {} : { data_test: row.data_test }),
      ...(orUndef(row.type) === undefined ? {} : { type: row.type }),
      ...(orUndef(row.href) === undefined ? {} : { href: row.href }),
      ...(classNames === undefined ? {} : { class_names: classNames }),
      visible: row.visible === true,
      ...(row.bbox === undefined ? {} : { bbox: row.bbox }),
      admitted: false,
      ...(row.frame === undefined ? {} : { frame: row.frame }),
      ...(frameOrigin === undefined ? {} : { frame_origin: frameOrigin }),
      ...(framePath === undefined ? {} : { frame_path: framePath }),
      ...(structurePath === undefined ? {} : { structure_path: structurePath, structure_unstable: true as const }),
      ...(rowTexts === undefined ? {} : { row_texts: rowTexts }),
      ...(rowIndex === undefined ? {} : { row_index: rowIndex }),
    };
  });
  // 自证池 = 本次观察到的**准入面 + 可见**元素（真实池的上界；隐藏/池外元素不在其中，
  // 所以它们的任何 hint 形状都不会被冒充为"可命中"）。
  const pool: ElemPool = {};
  collected.rows.forEach((row, i) => {
    if (row.in_surface !== true || row.visible !== true) return;
    const e = syntheticElem(row, `o${i}`);
    pool[e.ref!] = e;
  });
  let admittedCount = 0;
  // F83 批 3（deny-list 可配化）：放行词元表直达自证池的 suggestHints（单点消费）。
  const suggestExtras = extras?.hintTokenAllow !== undefined
    ? { tokenAllow: extras.hintTokenAllow } : undefined;
  for (const view of elements) {
    const e = pool[view.ref];
    if (e !== undefined) {
      const hints = suggestHints(e, pool, suggestExtras);
      if (hints.length > 0) {
        view.admitted = true;
        view.hint_candidates = hints;
      }
    }
    if (view.admitted) admittedCount += 1;
    else {
      const row = collected.rows[Number(view.ref.slice(1))]!;
      view.why_not_admitted = whyNotAdmitted(row, view.class_names);
    }
  }
  const omitted = Math.max(0, collected.total - elements.length);
  let title: string | undefined;
  try {
    const t = (page as unknown as { title?(): Promise<string> }).title;
    if (typeof t === "function") {
      // 有界 2s：卡死的页面不能拖住一次免费观察；计时器要清掉（否则它会把事件循环多留 2s）。
      let timer: ReturnType<typeof setTimeout> | undefined;
      const raw = await Promise.race([
        Promise.resolve().then(() => t.call(page)),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve(""), 2000); }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      const s = String(raw ?? "").trim();
      if (s) title = s;
    }
  } catch { /* title 读不到不影响观察事实 */ }
  return {
    ok: true,
    url,
    ...(title === undefined ? {} : { title }),
    ...(frames.length === 0 ? {} : { frames }),
    counts: { elements: elements.length, admitted: admittedCount, omitted },
    truncated: omitted > 0,
    elements,
  };
}
