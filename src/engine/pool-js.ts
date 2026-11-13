/**
 * 池抽取的**全部内嵌 JS 探针**与它们的宿主编译产物（从 extraction.ts 拆出，F6）。
 *
 * 拆出的理由：这一区是『写给浏览器执行的 JS 字符串 + new Function 编译』，与宿主
 * TypeScript 逻辑完全不同质；单独成模块后 extraction.ts 只保留扫描驱动与视图函数。
 * 内容与搬移前逐字节一致（inspect --json 快照对比兜底）。
 */
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
  const anchorIdsOf = (el) => {
    const out = [];
    let p = el ? el.parentElement : null;
    while (p && out.length < 8) {
      if (p.id) out.push(String(p.id).toLowerCase());
      p = p.parentElement;
    }
    return out;
  };
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
    return {ref: ref, dsh_ref: stamp, scan: r.i, tag: r.tag, label: r.label, full_label: r.full_label,
            ...(classNames && classNames.length ? {class_names: classNames} : {}),
            ...(labelFull ? {label_full: labelFull} : {}),
            ...(anchors.length ? {anchor_ids: anchors} : {}),
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
export function compile(params: string, body: string): (...args: any[]) => any {
  return new Function(params, body) as (...args: any[]) => any;
}

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
            const anchorEl = p.within ? document.getElementById(p.within) : null;
            const inAnchor = (e) => p.within === undefined || (anchorEl && anchorEl.contains(e));
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
                            // A1 不变量：label === full_label 的前 40 字（同一 labelOf 截断）。
                            label: labelOf(e).slice(0, 40), full_label: labelOf(e).slice(0, 200),
                            data_test: e.getAttribute('data-test') || '',
                            name: e.getAttribute('name') || '', id: e.id || '',
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
    // A1 不变量：label === full_label 的前 40 字（同一 full 截断）。
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

export const PASS_HEURISTIC = compile("arg", `${COLLECT_JS}\nreturn (${HEURISTIC_WIDGET_JS})(arg);`);
