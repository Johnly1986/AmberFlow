/**
 * 池抽取的**全部内嵌 JS 探针**与它们的宿主编译产物（从 extraction.ts 拆出，F6）。
 *
 * 拆出的理由：这一区是『写给浏览器执行的 JS 字符串 + new Function 编译』，与宿主
 * TypeScript 逻辑完全不同质；单独成模块后 extraction.ts 只保留扫描驱动与视图函数。
 * 内容与搬移前逐字节一致（inspect --json 快照对比兜底）。
 */
/* ------------------------------------------------------------------ JS passes */

/* ---- 共享片段已外搬（本轮拆分）：本文件 pass 内插同一份，导出面由此 re-export 不变 ---- */
import {
  ANCHOR_JS, BUCKET_HELPERS_JS, COLLECT_JS, LABEL_HELPERS_JS, ROW_CLIMB_JS, STRUCTURE_HELPERS_JS, compile,
} from "./pool-js-core.ts";
export {
  ANCHOR_JS, BUCKET_HELPERS_JS, COLLECT_JS, LABEL_HELPERS_JS, ROW_CLIMB_JS, STRUCTURE_HELPERS_JS, compile,
} from "./pool-js-core.ts";

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
  ${STRUCTURE_HELPERS_JS}
  const sel = arg.sel, max = arg.max;
  // A2：分桶配额（null = main-first 旧行为，policy.candidate_priority 的回退面）。
  const quotas = arg.quotas || null;
  const all = [];
  __collectAll(document, sel, all);
  // A2：池行的 full_label 是**匹配口径**（≤200）——模型视图仍用前 40，但 hint 匹配/诊断
  // 需要完整串（aria-label="Sort by, Not selected" 的前 40 往往截在逗号前，裸词 "Sort by"
  // 就匹配不到）。完整标签见 labelOfRaw：只有 observe/inspect 的观察面才需要它
  // （inspect 传 arg.fullLabel=true）。
  // A1 不变量：label === full_label 的前 40 字（同源同值；label 是模型视图，full_label 是
  // ≤200 的匹配口径）。hint 属性匹配据此可以用 [full_label, label] 双底座而不改短值行为。
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
      // A1 不变量：label === full_label 的前 40 字（同一 lrFull 截断）。
      labelRows.push({ i: i, tag: tag, label: short(lrFull), full_label: lrFull,
        main: (!e.closest('nav, aside, footer, header') && !!e.closest('main, [role=main], article')),
        data_test: e.getAttribute('data-test') || '', name: '', id: e.id || '', input_type: '',
        role: '', content_editable: false, draggable: false, href: '', assoc: assoc });
      continue;
    }
    const fullLabel = labelOf(e, tag);
    if ((tag === 'a' || tag === 'button') && !fullLabel) continue;
    const href = e.getAttribute('href') || '';
    // A1 不变量：label === full_label 的前 40 字（同一 fullLabel 截断）。
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
    // A1 不变量：label === full_label 的前 40 字（此处 full 先按 norm 折叠空白，故按"归一后同源"成立）。
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
  } else if (arg.quotaMode === 'quota') {
    // E1-b 双配额模型（decision.pool_quota_mode:"quota" 灰度档；legacy = 上面既有分支）。
    // 三件事，全部只动"谁被逐出"：
    //   1) id-backed 保留：非空 id 的行是 stable handle 锚（#id hint 的解析底座），不受
    //      所在桶配额逐出——**只在它本来会被逐出时**才占用 PIN_CAP（配额内的 id 行照常
    //      走配额，不额外挤占）；跨桶合计 PIN_CAP 上限防"全页都有 id"的病态面把池挤爆；
    //   2) viewport 保底：配额表由 host 侧换档（viewport 桶加大），host 常量单一出处；
    //   3) 壳元素限额：chrome 桶配额即限额（收紧；pinned 壳元素仍保留——全站导航的
    //      稳定锚不该被逐出）。
    // 桶内次序：配额行（DOM 序）在前、被逐出救回的 pinned 行在后；跨桶次序与 legacy
    // 相同（BUCKET_ORDER）。总预算 max 不变（slice(0, max)）。
    const PIN_CAP = 12;
    const byBucket = { chrome: [], viewport: [], contentNear: [], mainOffscreen: [], other: [] };
    for (const r of rows) {
      const b = r.bucket || 'other';
      (byBucket[b] || byBucket.other).push(r);
    }
    const picked = [];
    const pickedIdx = {};   // row.i -> true（已入池标记；fill 阶段跳过）
    let pinnedTaken = 0;
    for (const b of ['chrome', 'viewport', 'contentNear', 'mainOffscreen', 'other']) {
      const q = typeof quotas[b] === 'number' ? quotas[b] : 0;
      const arr = byBucket[b] || [];
      let n = 0;
      for (let k = 0; k < arr.length; k++) {
        const r = arr[k];
        if (n < q) { n++; picked.push(r); pickedIdx[r.i] = true; continue; }
        if (r.id && pinnedTaken < PIN_CAP) { pinnedTaken++; picked.push(r); pickedIdx[r.i] = true; }
      }
    }
    if (picked.length < max) {
      for (const b of ['viewport', 'contentNear', 'mainOffscreen', 'other', 'chrome']) {
        if (picked.length >= max) break;
        const arr = byBucket[b] || [];
        for (let k = 0; k < arr.length && picked.length < max; k++) {
          const r = arr[k];
          if (pickedIdx[r.i]) continue;
          picked.push(r); pickedIdx[r.i] = true;
        }
      }
    }
    ordered = picked.slice(0, max);
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
  // E3：祖先链 id（≤8、小写、最近祖先在前）——within:#id 尾缀的池侧判定底座。
  // 一次 parentElement 链行走；无 id 祖先 = 空数组（行里省略，池面零开销）。
${ANCHOR_JS}
  return ordered.map((r, pos) => {
    const ref = 'e' + pos;
    const stamp = nonce + '-' + ref;
    const el = all[r.i];
    el.setAttribute('data-dshref', stamp);
    const anchors = anchorIdsOf(el);
    // P0-A inspect 观察面（显式 opt-in，缺省不出字段 ⇒ 池/模型面/既有产物逐字节不变）：
    //   classNames=true → class_names（有界：≤8 个、每项 ≤40 字符，与 ctx.observe 同口径）；
    //   fullLabel=true  → label_full（**不截断**的完整标签；full_label 仍是 ≤200 的匹配口径）。
    const classNames = arg.classNames && el && el.classList
      ? Array.from(el.classList).slice(0, 8).map((c) => String(c).slice(0, 40))
      : null;
    const labelFull = arg.fullLabel && el ? labelOfRaw(el, r.tag) : null;
    // B 批：结构证据 opt-in（缺省不出字段 ⇒ 池/模型面逐字节不变）；帧下标前缀进了
    // structure_path（截断在 JS 内完成，前缀也受同一 160 上限约束）。
    const structurePath = arg.structurePath === true && el
      ? __structurePathOf(el, arg.framePrefix)
      : null;
    return {ref: ref, dsh_ref: stamp, scan: r.i, tag: r.tag, label: r.label, full_label: r.full_label,
            ...(classNames && classNames.length ? {class_names: classNames} : {}),
            ...(labelFull ? {label_full: labelFull} : {}),
            ...(anchors.length ? {anchor_ids: anchors} : {}),
            ...(structurePath ? {structure_path: structurePath, structure_unstable: true} : {}),
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
 *
 * F82（in-row 观察面闭环）：dup 门控采集 row_texts（additive 字段，共享 ROW_CLIMB_JS 内插）——
 * **dup 判定只对"观察集合内可见同文案计数"执行**（键 = __dupKeyOf(tag, label)，与宿主
 * addNearContext 同口径单一出处；label 用观察面的完整 labelOfRaw），计数 ≤1 的行不出字段
 * ⇒ **无 dup 页观察 JSON 逐字节不变**；max 截断边界 = 只对观察集合计数（被 max 截掉的行不
 * 参与，如实按"这一刻的观察"归属）。爬升仅对已判定重复组的元素执行（与 near 同触发），
 * observe 面已有 max ≤200 硬上限。syntheticElem 透传后 observe 自证池与池行同构。
 */
export const OBSERVE_JS = String.raw`(arg) => {
  ${LABEL_HELPERS_JS}
  ${STRUCTURE_HELPERS_JS}
${ROW_CLIMB_JS}
  const sel = arg.sel, max = arg.max, includeHidden = arg.includeHidden === true;
  // E3：祖先链 id（≤8、小写、最近祖先在前）——与 EXTRACT_JS 的 anchorIdsOf 同口径，
  // 是 within:#id 尾缀在 observe 侧的自证底座。一次 parentElement 链行走；无 id 祖先
  // = 空数组（行里省略该字段 ⇒ 这类页面的观察 JSON 形状逐字节不变）。
${ANCHOR_JS}
  const all = [];
  try { __collectAll(document, sel, all); }
  catch (err) { return { bad_selector: String(err && err.message ? err.message : err) }; }
  const rows = [];
  const rowEls = [];
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
    const anchors = anchorIdsOf(e);
    // B 批：结构证据 opt-in（只读祖先前缀行走；缺省不出字段 ⇒ 观察 JSON 逐字节不变）。
    const structurePath = arg.includeStructure === true
      ? __structurePathOf(e, arg.framePrefix)
      : null;
    rowEls.push(e);
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
      ...(anchors.length ? {anchor_ids: anchors} : {}),
      ...(structurePath ? {structure_path: structurePath, structure_unstable: true} : {}),
    });
  }
  // F85（评审收口）：dup 键改用共享 __rowLabelOf（与池行 label 同口径，40 字符）——
  // 长标签/表单控件此前 observe 用全长 label、池用 40 字符 label，分组 K 会不同。
  const rowKeys = [];
  for (let i = 0; i < rows.length; i++) {
    rowKeys.push(rows[i].visible === true ? __dupKeyOf(__rowTag(rowEls[i]), __rowLabelOf(rowEls[i])) : '');
  }
  const dupCnt = {};
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].visible !== true) continue;
    dupCnt[rowKeys[i]] = (dupCnt[rowKeys[i]] || 0) + 1;
  }
  const dupLabels = new Set();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].visible !== true) continue;
    if ((dupCnt[rowKeys[i]] || 0) > 1) dupLabels.add(__rowLabelOf(rowEls[i]));
  }
  // F83：dup 组成员按 rows 数组序（= 本帧 DOM 先序）编号 1..K（帧内同组；additive 字段，
  // 无 dup 页不出键 ⇒ 观察 JSON 逐字节不变）。row_index 独立于爬升——组序是纯计数。
  const rowIdxSeen = {};
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].visible !== true) continue;
    if ((dupCnt[rowKeys[i]] || 0) <= 1) continue;
    rowIdxSeen[rowKeys[i]] = (rowIdxSeen[rowKeys[i]] || 0) + 1;
    rows[i].row_index = rowIdxSeen[rowKeys[i]];
  }
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].visible !== true) continue;
    if ((dupCnt[rowKeys[i]] || 0) <= 1) continue;
    const c = __rowClimb(rowEls[i], dupLabels);
    if (c.rows.length) rows[i].row_texts = c.rows;
  }
  return { rows: rows, total: candidates, returned: rows.length };
}`;



/** One-pass extractor: shadow-aware collector + the row/label/visibility pass. */
export const PASS_EXTRACT = compile("arg", `${COLLECT_JS}\nreturn (${EXTRACT_JS})(arg);`);
/** P0-A：只有读的观察 pass（每帧一次往返；不盖章/不写 DOM）。 */
export const PASS_OBSERVE = compile("arg", `${COLLECT_JS}\nreturn (${OBSERVE_JS})(arg);`);
/** A2：窗口透明化（inspect 用）：可见交互总数 + 被挤出窗口的候选（≤10）。 */
export const PASS_WINDOW = compile("arg", `${COLLECT_JS}\nreturn (${WINDOW_AUDIT_JS})(arg);`);
/** A2：失败路径的 viewport_underloaded 事实（只读 DOM，一次扫描，提前退出）。 */
export const PASS_UNDERLOAD = compile("arg", `return (${VIEWPORT_UNDERLOAD_JS})(arg);`);
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
export const PASS_META = compile("sel", `return (${META_JS})(sel);`);
/**
 * Container identity lines for duplicate-label elements.
 *
 * F82 双累加器：爬升采集收口进共享 ROW_CLIMB_JS（本 pass 内插同一份）——`out`（near）累加序/
 * 行过滤/3 行窗口逐字符不动（near = out.slice(0,3) 逐字节相等，R1 结构性证明）；`rows`
 * （row_texts）独立行过滤（现行过滤 OR 连续数字 ≥5 位）、窗口 6 行；break 取并集
 * `(out.length>=3 && rows.length>=6)` ⇒ 新爬升 ⊇ 旧爬升。返回 `{near, rows}` 形态
 * （宿主 addNearContext：near 走既有唯一性 pick、rows 全量作 row_texts——仅重复组携带）。
 */
const NEAR_JS = String.raw`(arg) => {` + COLLECT_JS + ROW_CLIMB_JS + String.raw`
            const all = [];
            __collectAll(document, arg.sel, all);
            const labels = new Set(arg.labels);
            return arg.pairs.map(([ref, i]) => {
              const e = all[i]; if (!e) return {near: [], rows: []};
              const c = __rowClimb(e, labels);
              return {near: c.out.slice(0, 3), rows: c.rows}; }); }`;
export const PASS_NEAR = compile("arg", `return (${NEAR_JS})(arg);`);
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
            // E3：within:#id 的 DOM 侧限定——锚存在且命中元素在锚子树内（contains 判定；
            // 锚不在本页 = 本帧无命中，下一帧继续找）。单层（解析层已保证）。
            // E2（within 语义链）：p.within 归一为链（外→内数组，单层 = 长度 1）——逐段
            // getElementById + 嵌套 contains 校验：声明链 a1 contains a2 contains … contains
            // 元素；任一段 null / 前段不含后段 ⇒ 本帧 0 行（fail-closed，下一帧继续找）。
            // E7（N1）：id → 文档序首个元素的小写映射，**每趟懒建一次**（memoized）——
            // getElementById 大小写敏感，而 p.within 已按 parseHint 归一为小写（池侧
            // anchor_ids 同样小写）；页面上的 <div id="Wrap"> 此前查 "wrap" 恒 null =
            // DOM 回捞与池侧判定分裂。映射口径与 getElementById 一致：文档序**首个**实例
            // （重复 id 的确定性裁决，M6②）。memo 在 handle 之后、仅 within 参与时建立。
            let idMap = null;
            const elByIdLower = (id) => {
                if (idMap === null) {
                    idMap = new Map();
                    const nodes = document.querySelectorAll('[id]');
                    for (let i = 0; i < nodes.length; i++) {
                        const el = nodes[i];
                        const key = String(el.id || '').toLowerCase();
                        if (key !== '' && !idMap.has(key)) idMap.set(key, el);
                    }
                }
                const hit = idMap.get(id);
                return hit === undefined ? null : hit;
            };
            // E7（N2）：链校验要求**两段锚是不同元素且严格包含**——contains 对自身为
            // true（within:#x>#x 同元素退化会命中），契约是"池侧不匹配、DOM 侧同元素退化也不命中"。
            const chainEls = p.within ? p.within.map(elByIdLower) : [];
            const chainOk = p.within !== undefined && chainEls.every((el, i) =>
                el !== null && (i === 0 || (chainEls[i - 1] !== el && chainEls[i - 1].contains(el))));
            const innermost = chainEls.length ? chainEls[chainEls.length - 1] : null;
            const inAnchor = (e) => p.within === undefined || (chainOk && innermost !== null && innermost.contains(e));
            // E1（within 权威对等，F-1 闭合）：回捞行补 anchor_ids（与真池行同构）——回捞行
            // 并入主池后 executor 重新 hintMatch，池侧 inAnchor 按 anchor_ids 过滤；此前回捞行
            // 缺该字段被二次清零 → 落到 FW8（无视 within）在任意帧动作锚外 #x。共享 ANCHOR_JS。
${ANCHOR_JS}
${ROW_CLIMB_JS}
            const hits = [];
            if (p.kind === 'id') {
                all.forEach((e, i) => {
                    if ((e.id || '').toLowerCase() === p.value && inAnchor(e)) hits.push(i);
                });
            } else if (p.kind === 'attrSubstr') {
                all.forEach((e, i) => {
                    if (p.tag && e.tagName.toLowerCase() !== p.tag) return;
                    if (!inAnchor(e)) return;
                    const hay = (e.getAttribute('href')||'') + ' ' + (e.getAttribute('data-test')||'') + ' ' +
                                (e.id||'') + ' ' + (e.name||'') + ' ' + labelOf(e);
                    if (hay.toLowerCase().includes(p.value)) hits.push(i);
                });
            } else if (p.kind === 'attrEq') {
                all.forEach((e, i) => {
                    if (p.tag && e.tagName.toLowerCase() !== p.tag) return;
                    if (!inAnchor(e)) return;
                    if ((e.getAttribute(p.attr)||'').toLowerCase() === p.value) hits.push(i);
                });
            } else if (p.kind === 'tag') {
                const want = p.tag === 'link' ? 'a' : p.tag;
                all.forEach((e, i) => { if (e.tagName.toLowerCase() === want && inAnchor(e)) hits.push(i); });
            } else {
                // 裸词；nearToken（无括号的 tag~token）在池侧有近邻上下文、DOM 侧没有，
                // 维持回捞路径的旧行为：按整串做裸词匹配（几乎不命中，等于"回捞不到"）。
                const tok = p.kind === 'nearToken' ? h : p.token;
                all.forEach((e, i) => {
                    if (!inAnchor(e)) return;
                    const lab = labelOf(e).toLowerCase(), dt = (e.getAttribute('data-test')||'').toLowerCase();
                    if (bareHit(lab, dt, tok)) hits.push(i);
                });
            }
            const visHits = hits
                .filter((i) => { const e = all[i];
                    return e.checkVisibility ? e.checkVisibility({checkVisibilityCSS: true}) : true; });
            let picked = visHits;
            const rowMemo = new Map();
            const rowIdxMap = new Map();
            if (p.inRow !== undefined || p.rowIndex !== undefined) {
                // F82/F83 in-row/row-index 门（惰性 + memoized + 凑满 5 早退 + 总计算封顶 120，
                // 超标 fail-closed）：先收集形状命中（不含 in-row/row-index 过滤——上面各分支），
                // 按 DOM 序逐候选处理，行词面/组序命中才收集。只补字段不进门的话 slice(0,5)
                // 可能全被非命中占满 ⇒ 回捞路径整体死路（F-1 同构缺口）。
                // F83 编号（v1.0 §3.5 C 项）：**一次 O(n) 全组位次表**——__dupLabelsOf 分出的同
                // 组成员按 __dupKeyOf 键计数、DOM 先序位次 1..K；memo 只适用组合守卫的 row_texts
                // 爬升；**单用 row-index 声明零爬升成本**（纯查表比较，computed 恒 0）。
                // F85（评审收口）：编号基只计**可见**成员、dup 键用共享 __rowLabelOf（与池/
                // observe 同口径）。此前这里对 selector 全集（含隐藏）按自写 labelOf 编号，
                // 会与池面 addNearContext 的可见成员编号错位（同一个 N 指到不同行）。
                const visPairs = [], visEls = [];
                for (let i = 0; i < all.length; i++) {
                    if (!__rowVisible(all[i])) continue;
                    visPairs.push([__rowTag(all[i]), __rowLabelOf(all[i])]);
                    visEls.push(all[i]);
                }
                const dupLabels = __dupLabelsOf(visPairs);
                const dupCnt = {}, idxSeen = {};
                for (let i = 0; i < visPairs.length; i++) {
                    const k = __dupKeyOf(visPairs[i][0], visPairs[i][1]);
                    dupCnt[k] = (dupCnt[k] || 0) + 1;
                }
                for (let i = 0; i < visPairs.length; i++) {
                    const k = __dupKeyOf(visPairs[i][0], visPairs[i][1]);
                    if ((dupCnt[k] || 0) <= 1) continue;
                    idxSeen[k] = (idxSeen[k] || 0) + 1;
                    rowIdxMap.set(visEls[i], idxSeen[k]);
                }
                picked = [];
                let computed = 0;
                for (let k = 0; k < visHits.length; k++) {
                    if (picked.length >= 5 || computed >= 120) break;
                    const e = all[visHits[k]];
                    let rows = null;
                    if (p.inRow !== undefined) {
                        rows = rowMemo.get(e);
                        if (rows === undefined) {
                            computed += 1;
                            rows = __rowClimb(e, dupLabels).rows;
                            rowMemo.set(e, rows);
                        }
                    }
                    const rowOk = p.inRow === undefined
                        || rows.some((t) => String(t).toLowerCase().includes(String(p.inRow)));
                    const idxOk = p.rowIndex === undefined || rowIdxMap.get(e) === p.rowIndex;
                    if (rowOk && idxOk) picked.push(visHits[k]);
                }
            }
            return picked
                .slice(0, 5)
                .map((i, n) => {
                    const e = all[i];
                    const anchors = anchorIdsOf(e);
                    const href = e.getAttribute('href') || '';
                    const ref = 'h' + n;
                    const stamp = nonce + '-' + ref;
                    e.setAttribute('data-hintref', stamp);
                    const climbRows = rowMemo.get(e);
                    const selIdx = p.rowIndex !== undefined ? rowIdxMap.get(e) : undefined;
                    return {hint_ref: stamp, scan: i, tag: e.tagName.toLowerCase(),
                            dsh_ref: e.getAttribute('data-dshref') || '',
                            // A1 不变量：label === full_label 的前 40 字（同一 labelOf 截断）。
                            label: labelOf(e).slice(0, 40), full_label: labelOf(e).slice(0, 200),
                            data_test: e.getAttribute('data-test') || '',
                            name: e.getAttribute('name') || '', id: e.id || '',
                            // E1（F-1 闭合）：回捞行 anchor_ids 与真池行同构（additive）。
                            ...(anchors.length ? {anchor_ids: anchors} : {}),
                            // F82（in-row 权威对等，F-1 同构闭合）：回捞行补 row_texts（additive，
                            // 与 anchor_ids 同形）——回捞行并入主池后二次 hintMatch 的 inRow 过滤
                            // 才有底座；缺字段 = 过滤清零 = 回捞死路。in-row 未声明时 rowMemo 恒空
                            // ⇒ 键不出现（回捞行形状与今天逐字节一致）。
                            ...(climbRows !== undefined && climbRows.length ? {row_texts: climbRows} : {}),
                            // F83（row-index 权威对等）：回捞行补 row_index（additive）——回捞行
                            // 并入主池后二次 hintMatch 的 rowIdx 过滤才有底座；缺字段 = 过滤清零 =
                            // 死路。row-index 未声明时键不出现（批 1 in-row 回捞行逐字节不变）。
                            ...(selIdx !== undefined ? {row_index: selIdx} : {}),
                            input_type: (e.getAttribute('type') || '').toLowerCase(),
                            href: href ? href.split('?')[0].replace(/\/+$/,'').split('/').slice(-2).join('/') : '',
                            ...(href ? {href_full: href} : {})};
                }); }`;
export const PASS_HINT = compile("arg", COLLECT_JS + `\nreturn (${HINT_HEAD})(arg);`);
/**
 * P0-D：**只读**探测用的 hint 收集（同一套 hint 语义，但**不盖** `data-hintref` 章）。
 * 只用于"声明目标是否仅存在于被排除 frame"的复核——绝不动作、绝不进池。
 */
export const PASS_HINT_PROBE = compile("arg",
  COLLECT_JS + `\nreturn (${HINT_HEAD.replace("e.setAttribute('data-hintref', stamp);", "")})(arg);`);
/** tiny per-element fallback probes */
export const FN_TAG = compile("e", "return e.tagName.toLowerCase();");
export const FN_FIRST = compile("e", "return (e.childNodes.length ? e.childNodes[0].textContent : '');");
export const FN_WRAPPER = compile("e", String.raw`const own = (e.value || '').trim();
                const clean = (t) => {
                    t = (t||'').replace(/\s+/g,' ').trim();
                    if (own && t.startsWith(own)) t = t.slice(own.length).trim();
                    return t; };
                let p = e.closest('label');
                if (!p && e.id) p = document.querySelector('label[for="' + CSS.escape(e.id) + '"]');
                return p ? clean(p.innerText) : '';`);

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
  ${ANCHOR_JS}
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
    // E1（M3 第五池）：heuristic 伪按钮行补 anchor_ids（与真池/其余合成池同构，additive）。
    const anchors = anchorIdsOf(e);
    const main = (!e.closest('nav, aside, footer, header') && !!e.closest('main, [role=main], article'));
    const cls = __classify(e, main);
    const full = norm(e.innerText || '').slice(0, 200);
    // A1 不变量：label === full_label 的前 40 字（同一 full 截断）。
    return { tag: tag, label: full.slice(0, 40), full_label: full, main: main,
      ...(anchors.length ? {anchor_ids: anchors} : {}),
      rect: { top: cls.rect.top, left: cls.rect.left, width: cls.rect.width, height: cls.rect.height },
      inViewport: cls.inViewport, nearViewport: cls.nearViewport,
      scrollDepth: cls.scrollDepth, inScrollContainer: cls.inScrollContainer,
      bucket: cls.bucket, prio: cls.prio,
      data_test: e.getAttribute('data-test') || '', name: e.getAttribute('name') || '',
      id: e.id || '', input_type: (e.getAttribute('type') || '').toLowerCase(),
      role: (e.getAttribute('role') || '').toLowerCase() };
  });
}`;

export const PASS_HEURISTIC = compile("arg", `${COLLECT_JS}\nreturn (${HEURISTIC_WIDGET_JS})(arg);`);
