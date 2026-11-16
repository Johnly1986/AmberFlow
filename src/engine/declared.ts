/**
 * P0-C：**声明目标解析面（DRF，declared target resolution）**——池 / ADMIT 回捞 / FW8
 * 身份回捞全部落空后，给"这一步作者声明的目标"（命令 `target` / act hint）的最后一条
 * **DOM 侧**解析链。只服务声明目标，决策步与模型选出的元素**永不**走这里。
 *
 * 两种模式（同一条「恰好一个可见匹配」纪律）：
 *   1. attr（属性/身份型 hint：`#id` / `tag[attr=value]` / `tag[attr~substr]` /
 *      `tag~token` / 角色词）：复用 A3 `_domFallbackResolve` 的 ADMIT_SEL DOM 收集
 *      （`admitSelectorWithJsFor`，不新增 surface 类目、不改投影）+ 同一套 `hintMatch`
 *      语义；跨 frame（`framesOf` ≤6）统计，恰好一个可见才动作。
 *   2. text（裸词 hint）：**可见文本精确匹配**——收集归一化（大小写不敏感、折叠空白）
 *      后 `innerText` 全等于该 token 的元素；优先最深的匹配元素（祖先同一文本被剪掉），
 *      到父容器这一档时仍以动作前 hit-test 兜底；恰好一个可见才动作。
 *
 * 边界：
 *   - 匹配 >1 可见 → 调用方报结构化 `target_ambiguous`（候选 tag/文本/frame/visible），绝不猜；
 *     全部隐藏 → 视为 0（绝不操作隐藏元素），调用方只留 hidden 诊断。
 *   - 命中行临时盖 `data-hintref`（复用 `_locatorFor` 既有身份链），调用方动作尝试结束必须
 *     `cleanup()`（与 FW8/A3 同纪律）。
 *   - 合成 `Elem` **与池同构**（tag/label/id/name/data_test/role/input_type/content_editable/
 *     draggable/hint_ref/frame），能力守门由调用方走既有 `actionCapabilities`。
 *   - 本模块不认识"模型"：不调用 provider，回捞元素不会进入 `ChoiceRequest.elems` 的
 *     模型投影（调用方在 pickInner 剥离 `declared` 旁路标记）。
 */
import { framesOf, type Elem, type ElemPool, type PageLike } from "./extraction.ts";
import { elemFrameStamp, frameGateExcludes, frameScopeMatchesFrame } from "./frame-scope.ts";
import { admitSelectorWithJsFor, type SurfacePolicy } from "./surface.ts";
import { anchorChainMatch, hintCandidates, type HintMatchOptions } from "./rules.ts";
import { ANCHOR_JS, compile } from "./pool-js.ts";
import { parseHint } from "./hint.ts";

/** P0-C：一个 DOM 侧候选（歧义/隐藏诊断用；只放人读字段，不放 locator）。 */
export interface DeclaredCandidate {
  tag: string;
  /** 归一化后的可见文本（text 模式）或可读标签（attr 模式）。 */
  text: string;
  id: string;
  frame: number;
  visible: boolean;
}

export interface DeclaredResolveResult {
  /** 形状是否被 DRF 接受（空串/解析不出 → false，调用方保持既有失败路径）。 */
  eligible: boolean;
  mode: "attr" | "text";
  /** 本批次章前缀（唯一；cleanup 只删本批次）。 */
  stamp: string;
  /** 可见命中行（0/1；>1 由调用方判歧义）。恰好 1 行时已盖 `data-hintref`。 */
  rows: Elem[];
  /** 全部匹配（可见 + 隐藏）的摘要（含隐藏；不含章/locator）。 */
  candidates: DeclaredCandidate[];
  /** 全部匹配数（可见 + 隐藏）。 */
  total_matches: number;
  /** 匹配到但不可见（CSS 可见性或零盒）的数量。 */
  hidden_matches: number;
  /** 可见匹配数。 */
  visible_matches: number;
  /** 清理本次盖下的章（只删本批次值；候选 0/多也照清）。 */
  cleanup: () => Promise<void>;
}

/** DRF 候选摘要的人读文案（`target_ambiguous` 的 reason 与 trace 证据共用一份）。 */
export function formatDeclaredCandidates(c: DeclaredCandidate[]): string {
  return c.map((x) =>
    `${x.tag}${x.id ? `#${x.id}` : ""} ${JSON.stringify(x.text)} (frame=${x.frame}, visible=${x.visible})`,
  ).join("; ");
}

/** 批次号只在进程内递增——章值 `afdrf<n>-…` 不与 hintLookup 的 `af<批>-h<n>` / FW8 的 `afid<n>-0` 撞名。 */
let declaredBatch = 0;

type RawRow = Record<string, unknown>;

/**
 * attr 模式：在 ADMIT_SEL 投影上收集（含隐藏，可见性另记），一次 evaluate 每帧。
 * 返回行含 `i`（该帧 querySelectorAll 下标，盖章/回查用）与全部池同构字段。
 *
 * E1（within 权威对等）：原为 inline TS arrow evaluate——**闭包不跨**（Playwright 序列化
 * 函数源码，宿主变量进不去），共享 ANCHOR_JS 必须 `${}` 内插进 pass 源码 ⇒ 转 `compile()`
 * PASS 常量（identity PASS_IDENTITY 先例）。行补 `anchors`（共享 ANCHOR_JS）。
 */
const ATTR_COLLECT_BODY = String.raw`(arg) => {
  const g = globalThis;
${ANCHOR_JS}
  const out = [];
  let all;
  try { all = g.document.querySelectorAll(arg.sel); } catch (err) { return out; }
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    const tag = String(e.tagName || "").toLowerCase();
    const full = String(
      e.getAttribute("aria-label") || e.getAttribute("title") || e.innerText
      || e.getAttribute("placeholder") || e.getAttribute("value") || "",
    ).replace(/\s+/g, " ").trim().slice(0, 200);
    const href = String(e.getAttribute("href") || "");
    let visible = true;
    try {
      visible = e.checkVisibility ? e.checkVisibility({ checkVisibilityCSS: true }) : true;
      if (visible) {
        const r = e.getBoundingClientRect();
        visible = r.width > 0 && r.height > 0;
      }
    } catch (err) {
      visible = false;
    }
    const stamp = arg.tok + "-" + arg.frame + "-" + i;
    try { e.setAttribute("data-hintref", stamp); } catch (err) { /* 只读节点：按未盖章处理 */ }
    out.push({
      // A1 不变量：label === full_label 的前 40 字（同一 full 截断）。
      i, stamp, tag, full_label: full, label: full.slice(0, 40),
      role: String(e.getAttribute("role") || "").toLowerCase(),
      id: String(e.id || ""),
      dt: String(e.getAttribute("data-test") || ""),
      name: String(e.getAttribute("name") || ""),
      type: String(e.getAttribute("type") || "").toLowerCase(),
      content_editable: e.isContentEditable === true,
      draggable: String(e.getAttribute("draggable") || "").toLowerCase() === "true",
      href: href ? href.split("?")[0].replace(/\/+$/, "").split("/").slice(-2).join("/") : "",
      // E1：祖先链 id（≤8、小写、内→外）——rowToElem 透传 anchor_ids（F-2：attr 模式经
      // hintCandidates→inAnchor 自动消费 within）。
      anchors: anchorIdsOf(e),
      ...(href ? { href_full: href } : {}),
      visible,
    });
  }
  return out;
}`;
const PASS_ATTR_COLLECT = compile("arg", `return (${ATTR_COLLECT_BODY})(arg);`);

/**
 * text 模式：按**文本节点**找候选（避免对全树每个元素求 innerText），向上爬到
 * `normalized innerText === token` 的元素；同一批候选里祖先（严格包含另一个候选）
 * 被剪掉 = "优先最深的匹配元素"。
 *
 * E1：同 ATTR_COLLECT_BODY——inline TS arrow → `compile()` PASS 常量（闭包不跨，
 * ANCHOR_JS `${}` 内插），行补 `anchors`（text 模式收集后显式按 within 过滤）。
 */
const TEXT_COLLECT_BODY = String.raw`(arg) => {
  const g = globalThis;
${ANCHOR_JS}
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const want = norm(arg.token);
  const doc = g.document;
  const seen = new Set();
  const found = [];
  let walker = null;
  try {
    walker = doc.createTreeWalker(doc.body || doc.documentElement, 4 /* NodeFilter.SHOW_TEXT */);
  } catch (err) { return []; }
  if (walker === null) return [];
  let guard = 0;
  for (;;) {
    if (guard++ > 20000) break;
    const node = walker.nextNode();
    if (!node) break;
    const t = norm(node.nodeValue);
    if (!t || !t.includes(want)) continue;
    let e = node.parentElement;
    for (let depth = 0; e && depth < 12; depth++, e = e.parentElement) {
      if (seen.has(e)) continue;
      seen.add(e);
      const txt = norm(e.innerText);
      if (!txt.includes(want)) break;        // 再往上只会更长：不可能再全等
      if (txt === want) { found.push(e); break; }
    }
  }
  // 优先最深：祖先候选（严格包含另一个候选）剪掉；同一元素只留一次。
  const deepest = found.filter((e) => !found.some((o) => o !== e && e.contains(o)));
  const out = [];
  for (let i = 0; i < deepest.length; i++) {
    const e = deepest[i];
    const href = String(e.getAttribute("href") || "");
    const full = String(e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 200);
    let visible = true;
    try {
      visible = e.checkVisibility ? e.checkVisibility({ checkVisibilityCSS: true }) : true;
      if (visible) {
        const r = e.getBoundingClientRect();
        visible = r.width > 0 && r.height > 0;
      }
    } catch (err) {
      visible = false;
    }
    const stamp = arg.tok + "-" + arg.frame + "-" + i;
    try { e.setAttribute("data-hintref", stamp); } catch (err) { /* 只读节点：按未盖章处理 */ }
    out.push({
      // A1 不变量：label === full_label 的前 40 字（同一 full 截断）。
      i, stamp, tag: String(e.tagName || "").toLowerCase(), full_label: full, label: full.slice(0, 40),
      role: String(e.getAttribute("role") || "").toLowerCase(),
      id: String(e.id || ""),
      dt: String(e.getAttribute("data-test") || ""),
      name: String(e.getAttribute("name") || ""),
      type: String(e.getAttribute("type") || "").toLowerCase(),
      content_editable: e.isContentEditable === true,
      draggable: String(e.getAttribute("draggable") || "").toLowerCase() === "true",
      href: href ? href.split("?")[0].replace(/\/+$/, "").split("/").slice(-2).join("/") : "",
      // E1：祖先链 id——text 模式在宿主侧按 row.anchors 显式过滤 within（收集面不做判定）。
      anchors: anchorIdsOf(e),
      ...(href ? { href_full: href } : {}),
      visible,
    });
  }
  return out;
}`;
const PASS_TEXT_COLLECT = compile("arg", `return (${TEXT_COLLECT_BODY})(arg);`);

/** 帧打点形状（A 批 frame:<origin>：rowToElem 透传 frame-scope.elemFrameStamp 的产物）。 */
type FrameStamp = { frame_origin?: string; frame_path?: string[] };

const rowToElem = (ref: string, frame: number, row: RawRow, fstamp: FrameStamp): Elem => {
  const str = (k: string): string => String(row[k] ?? "");
  return {
    ref, frame,
    hint_ref: str("stamp"),
    tag: str("tag"),
    label: str("label"),
    ...(str("full_label") ? { full_label: str("full_label") } : {}),
    ...(str("id") ? { id: str("id") } : {}),
    ...(str("name") ? { name: str("name") } : {}),
    ...(str("dt") ? { data_test: str("dt") } : {}),
    ...(str("type") ? { input_type: str("type") } : {}),
    ...(str("role") ? { role: str("role") } : {}),
    // E1（within 权威对等）：祖先链 id 透传——合成行与真池行同构（additive；无 id 祖先 =
    // 字段省略的既有口径）。attr 模式由此经 hintCandidates→hintMatch.inAnchor **自动**消费
    // within（F-2：零额外代码）；text 模式在收集后按 row.anchors 显式过滤。
    ...(Array.isArray(row["anchors"]) && (row["anchors"] as string[]).length > 0
      ? { anchor_ids: (row["anchors"] as string[]).map((x) => String(x).toLowerCase()) } : {}),
    ...(row["content_editable"] === true ? { content_editable: true } : {}),
    ...(row["draggable"] === true ? { draggable: true } : {}),
    ...(str("href") ? { href: str("href") } : {}),
    ...(str("href_full") ? { href_full: str("href_full") } : {}),
    // A 批（frame:<origin>）：合成池与真池同构——帧链两字段（只写 origin 会让 ≥2 段链
    // 永不命中，B3/R2-3）；不写 = 未知 origin 帧（两字段都省略的口径）。
    ...(fstamp.frame_origin !== undefined ? { frame_origin: fstamp.frame_origin } : {}),
    ...(fstamp.frame_path !== undefined ? { frame_path: fstamp.frame_path } : {}),
    // 旁路标记：模型投影剥离（executor.pickInner），绝不进 ChoiceRequest.elems。
    declared: true,
  };
};

const candidateOf = (frame: number, row: RawRow): DeclaredCandidate => ({
  tag: String(row["tag"] ?? ""),
  text: String(row["full_label"] ?? row["label"] ?? ""),
  id: String(row["id"] ?? ""),
  frame,
  visible: row["visible"] === true,
});

/**
 * P0-C DRF：声明目标的一次 DOM 侧解析（只读；命中行在本批次盖章）。
 *
 * @param hint 作者声明的 hint（hint 语法闭集；裸词走 text 模式，其余走 attr 模式）
 * @param op   调用方声明的动作 op（只用于 attr 模式的收集面：scroll 允许常见容器角色）
 */
export async function declaredLookup(
  page: PageLike,
  hint: string,
  op = "click",
  surfacePolicy: SurfacePolicy = { native_activation: "window" },
  hosts?: string[] | null,
  /** A1：与池侧同一口径的属性值匹配底座（run 面按 `meta.policy.attr_value_match` 传）。 */
  hintOpts?: HintMatchOptions,
): Promise<DeclaredResolveResult> {
  const parsed = typeof hint === "string" && hint.trim() ? parseHint(hint) : null;
  const mode: "attr" | "text" = parsed?.kind === "bare" ? "text" : "attr";
  const noop = async (): Promise<void> => { /* 没有章可清 */ };
  const stampPrefix = `afdrf${++declaredBatch}`;
  const out: DeclaredResolveResult = {
    eligible: parsed !== null, mode, stamp: stampPrefix,
    rows: [], candidates: [], total_matches: 0, hidden_matches: 0, visible_matches: 0, cleanup: noop,
  };
  if (parsed === null) return out;
  // F82/F83 评审收口（fail-closed）：DRF 是 base 形状（attr 模式）/ base 文本（text 模式）的
  // 恢复面——两种模式都不读 `row_texts`/`row_index` 底座。声明行锚时**不参与恢复**
  // （eligible:false），让调用方落回既有 target_not_found + 行锚证据；绝不按 base 绕过行
  // 约束动作（静默丢弃声明约束比显式落空更危险）。
  if (parsed.inRow !== undefined || parsed.rowIndex !== undefined) return out;

  const admitAll = admitSelectorWithJsFor(surfacePolicy);
  const attrSel = op === "scroll"
    // A3 的 scroll 回退面：目标常常是非交互容器（feed/main/region…），仍只在池解析失败时走。
    ? `${admitAll}, [role='feed'], [role='list'], [role='main'], [role='region'], [role='article'], [role='listitem'], main`
    : admitAll;
  // A 批（frame:<origin>）：声明链过滤帧循环（hosts 之外的第二道帧限定；未声明 = 逐字节旧路径）。
  // R2-7：text 模式用 `parsed.token`（解析器剥掉尾缀后的裸词）——不能 `hint.trim()`，
  // 否则尾缀会被塞进文本匹配、带后缀的裸词回捞恒落空（mode==="text" ⇔ parsed.kind==="bare"）。
  const frameChain = parsed.frameChain;
  const bareToken = parsed.kind === "bare" ? parsed.token : "";
  const frames = framesOf(page);
  const frameStamps = frames.map((fr) => elemFrameStamp(fr));
  const collected: Array<{ fi: number; row: RawRow }> = [];
  for (let fi = 0; fi < frames.length; fi++) {
    // P0-D：DRF 只在 host 信封内的 frame 上解析（排除帧不参与声明目标解析）。
    if (frameGateExcludes(fi, frames[fi]!, hosts)) continue;
    // A 批：声明链不匹配的帧不参与 DRF（frame:<origin> 声明的帧之外绝不动作）。
    if (frameChain !== undefined && !frameScopeMatchesFrame(frameChain, frames[fi]!)) continue;
    let raw: unknown;
    try {
      raw = mode === "text"
        ? await frames[fi]!.evaluate(PASS_TEXT_COLLECT, { token: bareToken, tok: stampPrefix, frame: fi })
        : await frames[fi]!.evaluate(PASS_ATTR_COLLECT, { sel: attrSel, tok: stampPrefix, frame: fi });
    } catch {
      continue;                       // frame detached / 无执行上下文：跳过（与 hintLookup 同口径）
    }
    if (!Array.isArray(raw)) continue;
    for (const row of raw as RawRow[]) collected.push({ fi, row });
  }
  const cleanup = async (): Promise<void> => {
    for (const fr of framesOf(page)) {
      try {
        await fr.evaluate((tok: string) => {
          const g = globalThis as unknown as {
            document: { querySelectorAll(s: string): ArrayLike<any> };
          };
          const all = g.document.querySelectorAll(`[data-hintref^="${tok}-"]`);
          for (let i = 0; i < all.length; i++) all[i].removeAttribute("data-hintref");
        }, stampPrefix);
      } catch { /* frame 已卸载：章随文档消失 */ }
    }
  };
  out.cleanup = cleanup;

  // 两种模式的匹配集：
  //  - text：收集阶段已经做了"innerText 全等 + 最深优先"，全部行就是匹配集；
  //    E1（within 权威对等）：**显式过滤**——收集面不做 within 判定，宿主侧按 row.anchors
  //    过滤（anchors 不含 within 的行不进匹配集，与池侧 inAnchor 同口径；过滤后
  //    total/hidden/candidates 变锚内口径，M2 记账）。E2：within = 链（外→内），过滤走
  //    anchorChainMatch 嵌套序包含（唯一出处 rules.ts）——单层 membership 逐字节不变。
  //  - attr：用与池侧同一个 `hintCandidates` 在合成池上取**最强档**，再按可见性判唯一。
  //    E1/F-2：rowToElem 已透传 anchor_ids ⇒ hintMatch.inAnchor 自动消费 within——
  //    本分支**零额外代码**（此前合成行无 anchors ⇒ within 恒 fail-closed）；E2 链语义
  //    经同一个 inAnchor→anchorChainMatch 自动继承（仍零额外代码）。
  let matched: Array<{ fi: number; row: RawRow }>;
  if (mode === "text") {
    matched = parsed.within === undefined ? collected
      : collected.filter(({ row }) => {
          const anchors = Array.isArray(row["anchors"]) ? (row["anchors"] as string[]) : [];
          return anchorChainMatch(anchors, parsed.within!);
        });
  } else {
    const pool: ElemPool = {};
    for (const { fi, row } of collected) {
      const ref = `p${fi}:${String(row["i"])}`;
      pool[ref] = rowToElem(ref, fi, row, frameStamps[fi]!);
    }
    const cand = hintCandidates(hint, pool, hintOpts);
    if (cand === null) { await cleanup(); return out; }
    const want = new Set(cand.refs);
    matched = collected.filter(({ fi, row }) => want.has(`p${fi}:${String(row["i"])}`));
    // 候选集 = 这个 hint 真正命中的元素（歧义证据与隐藏诊断都基于它）。
    out.candidates = matched.map(({ fi, row }) => candidateOf(fi, row));
    out.total_matches = matched.length;
    out.hidden_matches = matched.filter(({ row }) => row["visible"] !== true).length;
  }
  if (mode === "text") {
    out.candidates = matched.map(({ fi, row }) => candidateOf(fi, row));
    out.total_matches = matched.length;
    out.hidden_matches = matched.filter(({ row }) => row["visible"] !== true).length;
  }
  const visible = matched.filter(({ row }) => row["visible"] === true);
  out.visible_matches = visible.length;
  if (visible.length !== 1) { await cleanup(); return out; }
  const only = visible[0]!;
  const el = rowToElem("drf:0", only.fi, only.row, frameStamps[only.fi]!);
  out.rows = [el];
  return out;
}
