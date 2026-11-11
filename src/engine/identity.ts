/**
 * FW8 **声明驱动的身份回捞**（identity recovery）——从 extraction.ts 拆出（F6）。
 *
 * 拆出的理由：这一区只服务『声明面目标的最后一跳』（命令 target / act hint），
 * 与池扫描/观察完全不同生命周期；独立成模块后 extraction.ts 只保留扫描与视图。
 * 内容与搬移前逐字节一致。
 */
import { parseHint, type ParsedHint } from "./hint.ts";
import {
  firstOf, framesOf, urlOf, frameInHostsEnvelope, type Elem, type FrameLike, type PageLike,
} from "./extraction.ts";
import { compile } from "./pool-js.ts";

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
      // A1 不变量：label === full_label 的前 40 字（同一 labelOf 截断）。
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

