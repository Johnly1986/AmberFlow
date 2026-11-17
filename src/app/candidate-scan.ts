/**
 * 候选扫描实现（app 层，BACKLOG #2 2.2b）：把执行器面向的**元素池**从真实页面抽出来。
 *
 * 这是从 `engine/extraction.ts` 搬来的 `extractElements` 整函数（逐字节；split-check
 * manifest 钉 hash 证明纯搬移）。**为什么在 app 层**：BACKLOG #2 的目标是"候选列表怎么来"
 * 由应用层决定——应用层注入 `CandidateProducer`（candidate-source），引擎只消费契约；
 * 扫描所需的共享助手/JS 常量仍由 engine L2 模块提供（app→engine 向下依赖）。
 *
 * 边界：只做页面观察（含 CDP/JS 探针副作用，与引擎既有口径一致），不做决策、不执行动作。
 */
import {
  CLICKY_EVENTS, CUSTOM_WIDGET_TAGS, INTERACTIVE_ALL, MAX_ELEMENTS,
  POOL_QUOTAS, QUOTA_MODE_QUOTAS, QUOTA_MODE_WIDE_QUOTAS, WIDE_QUOTAS,
  candidateMeta, frameAt, framesOf, listenerCache, urlOf,
  type Elem, type ElemPool, type FrameLike, type PageLike, type PoolQuotas,
} from "../engine/extraction.ts";
import { FULL_LABEL_MAX, MODEL_LABEL_MAX } from "../engine/elem-model.ts";
import { elemFrameStamp, frameGateExcludes } from "../engine/frame-scope.ts";
import { FN_FIRST, FN_TAG, FN_WRAPPER, PASS_EXTRACT, PASS_HEURISTIC, PASS_NEAR } from "../engine/pool-js.ts";
import { SURFACE_SELECTORS, WINDOW_CAPS, poolSelectorWithJsFor, type SurfacePolicy } from "../engine/surface.ts";

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
    if (frameGateExcludes(fi, frames[fi]!, opts?.hosts)) continue;   // P0-D：排除帧不进池
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
      ref: `e${elems.length}`, scan: i, tag, label: label.slice(0, MODEL_LABEL_MAX), full_label: label.slice(0, FULL_LABEL_MAX),
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
      label: String(r["label"] ?? "").slice(0, MODEL_LABEL_MAX),
      full_label: String(r["full_label"] ?? r["label"] ?? "").slice(0, FULL_LABEL_MAX),
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
 *
 * F83（row_index 编号接线，纯宿主计算零页面往返）：dup 清单（dups，跨帧计数触发面不变）按
 * **(frame, tag+label) 子组 scan 升序**编号 1..K 写入 `elems[r].row_index`（v1.0 §3.4 编号
 * 口径：帧内 dup 组 DOM 先序；跨帧同名网格各自编号——四面 JS pass 天然 per-frame 对齐）。
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
  // F83：row_index 编号 = 帧内 (tag+label) 子组 scan 升序的 1-based 位次（与 near/row_texts
  // 同触发——同一 dups 清单；纯内存排序，零新增往返）。
  const rowGroups = new Map<string, Array<{ ref: string; scan: number }>>();
  for (const [r, i, fi] of dups) {
    const e = elems[r]!;
    const key = `${fi}\u0000${e.tag}\u0000${e.label}`;
    if (!rowGroups.has(key)) rowGroups.set(key, []);
    rowGroups.get(key)!.push({ ref: r, scan: i });
  }
  for (const members of rowGroups.values()) {
    members.sort((a, b) => a.scan - b.scan);
    members.forEach((m, idx) => { elems[m.ref]!.row_index = idx + 1; });
  }
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
