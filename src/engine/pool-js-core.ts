/**
 * 池抽取的**共享 JS 片段**（collect / 分桶 / 标签 / 结构证据 / 锚 / 行爬升）与宿主编译器。
 *
 * 从 pool-js.ts 纯搬移（本轮大文件拆分）：这些片段被 EXTRACT/OBSERVE/WINDOW/HINT/HEURISTIC
 * 多个 pass 以模板内插共用，单独成模块后"同一份 JS 只写一次"更显式；pool-js 与各 pass
 * 仍经 re-export/import 读同一份字符串，字节不变。
 */
/* ------------------------------------------------------------------ JS 共享片段 */
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
  // 范围控件（range / role=slider）的**活值不是身份**：value 属性/当前值随每次操作变化，
  // 拿它做 label 会让同一元素在两次观察里叫两个名字（hint 因此失配，set_range 第二轮直接
  // target_not_found）。身份必须来自稳定面——aria-label / label 包裹 / id / name / data-test。
  const isRangeLike = (e, tag) => tag === 'input' && String(e.getAttribute('type') || '').toLowerCase() === 'range';
  const labelOfRaw = (e, tag) => {
    const first = e.childNodes.length ? String(e.childNodes[0].textContent || '') : '';
    let label = norm(e.getAttribute('aria-label') || e.getAttribute('title') || first || '');
    const text = (!label || tag === 'select') ? norm(e.innerText || '') : '';
    // 范围控件不读自身 value（活值），只读 placeholder（原生 range 无 placeholder，等于不读）。
    if (!label && isRangeLike(e, tag)) label = text || e.getAttribute('placeholder') || '';
    else if (!label) label = text || e.getAttribute('placeholder') || e.getAttribute('value') || '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const own = isRangeLike(e, tag) ? '' : (e.value || '').trim();
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
 * B 批：**结构证据** `structure_path` 的唯一 JS 实现（EXTRACT_JS / OBSERVE_JS 共用）。
 *
 * 形状：帧下标前缀（`f<fi>`，与池 ref/观察 `frame` 同一下标）+ 祖先链（外→内，到 `body`
 * 为止——`html`/`body` 不增加诊断价值，示例从 body 的子节点起）。每段 = `tag#id`（该节点
 * 有 id 时；id 是稳定锚）或 `tag[n]`（同 tag 兄弟序号 = `:nth-of-type` 语义，1-based）。
 * 总长 ≤160 字符；超长从**外侧**截断（保留帧前缀与元素端），中段以 `…>` 标记——链尾才是
 * "这个元素"。
 *
 * 纪律：仅诊断，**不是 hint**（动态页面重排/虚拟列表/插入广告随时失效、不可照抄）；
 * 只在 inspect（`extractElements({structurePath:true})`）或
 * `ctx.observe({includeStructure:true})` 的 opt-in 面出现，不进 hint 自证/歧义证据/
 * 模型请求面（`modelProjectionOf` 仍会剥离，防误传）。
 */
export const STRUCTURE_HELPERS_JS = String.raw`
  const __STRUCTURE_PATH_MAX = 160;
  const __structurePathOf = (el, framePrefix) => {
    if (!el) return '';
    const parts = [];
    let cur = el, guard = 0;
    while (cur && cur.nodeType === 1 && guard < 64) {
      const tag = String(cur.tagName || '').toLowerCase();
      if (!tag) break;
      // html/body 是所有页共有的根容器：不进结构证据（示例从 body 的子节点起）。
      if (tag === 'html' || tag === 'body') break;
      if (cur.id) {
        parts.unshift(tag + '#' + String(cur.id));
      } else {
        let nth = 1;
        const parent = cur.parentElement;
        if (parent) {
          for (let k = 0; k < parent.children.length; k++) {
            const sib = parent.children[k];
            if (sib.tagName === cur.tagName) {
              if (sib === cur) break;
              nth += 1;
            }
          }
        }
        parts.unshift(tag + '[' + nth + ']');
      }
      cur = cur.parentElement; guard += 1;
    }
    const prefix = framePrefix ? String(framePrefix) + '>' : '';
    const body = parts.join('>');
    let out = prefix + body;
    if (out.length > __STRUCTURE_PATH_MAX) {
      // 从外侧（祖先端）截断，保留元素端与帧前缀：f2>…>div#panel>button[2]。
      const room = Math.max(1, __STRUCTURE_PATH_MAX - prefix.length - 2);
      out = prefix + '…>' + body.slice(body.length - room);
    }
    return out;
  };
`;

/**
 * E1（within 权威对等）：`anchorIdsOf` 的**唯一 JS 实现**——祖先链 id（parentElement 上溯、
 * 内→外序、≤8 个、小写、元素自身不入；注意小写化在 push 处），`within:#id` 尾缀的池侧
 * 判定底座（pool-js EXTRACT/OBSERVE/HINT_HEAD/HEURISTIC 四 pass 与 A3/F64 的 PASS 常量
 * 经 `${}` 内插同一份，先例 LABEL_HELPERS_JS——改这里 = 改所有采集面，防五池口径漂移）。
 *
 * 字节纪律：文本与 56456fa 的 EXTRACT_JS 本地实现逐字符一致 ⇒ EXTRACT_JS pass 串字节不变
 * （OBSERVE_JS 的本地副本用词是 "ids"，收敛后统一为 "out"——变量名差异，行为逐字节一致；
 * 离线断言核对两处 diff：EXTRACT 仅允许零字节、OBSERVE 仅允许该注释外的 ids→out 重命名）。
 * 内插点注释只写在模板外（本 docblock）——模板内加注释行会破坏 pass 串字节不变。
 * 无换行首尾（首行直接跟内容、末行 `};` 收尾），调用点以 `${ANCHOR_JS}` 独占一行内插。
 */
export const ANCHOR_JS = String.raw`  const anchorIdsOf = (el) => {
    const out = [];
    let p = el ? el.parentElement : null;
    while (p && out.length < 8) {
      if (p.id) out.push(String(p.id).toLowerCase());
      p = p.parentElement;
    }
    return out;
  };`;

/**
 * F82（in-row 行锚）：行上下文爬升的**唯一 JS 实现**——dup 键（tag+\u0000+label，与宿主
 * addNearContext 的 `${tag}\u0000${label}` 同口径单一出处，防页内计数与宿主 map 漂移）+
 * 爬升采集（≤8 层祖先、容器持有 >1 个同文案交互控件即停 = 网格级 break；行过滤、窗口 6 行）。
 * NEAR_JS（EXTRACT 面）/ OBSERVE_JS（observe 面）/ HINT_HEAD（回捞面）/ DOM_FALLBACK_COLLECT_JS
 * （A3 回退面，executor.ts）经 `${ROW_CLIMB_JS}` 内插同一份（仿 ANCHOR_JS 模式——改这里 =
 * 改所有采集面，防两面漂移）。
 *
 * 字节纪律：`out` 累加器（near）的行过滤链、去重与推进序**逐字符**保持 NEAR_JS 原实现；
 * break 条件取**并集** `(out.length>=3 && rows.length>=6)` ⇒ 新爬升 ⊇ 旧爬升、out 前缀稳定
 * ⇒ near = out.slice(0,3) 逐字节相等（结构性证明，R1）。rows（row_texts）独立行过滤 =
 * 现行过滤 **OR 连续数字 ≥5 位**（救援纯数字订单号 20240101；时刻 "20:20"、短价格段维持
 * 剔除）；泄漏的长数字/价格行无害——价格词元由 suggestHints 生成期硬拒兜底，匹配面不挑词。
 * 无换行首尾（首行直接跟内容、末行 `};` 收尾），调用点以 `${ROW_CLIMB_JS}` 独占一行内插。
 */
export const ROW_CLIMB_JS = String.raw`  const __dupKeyOf = (tag, label) => String(tag || '') + '\u0000' + String(label || '');
  const __dupLabelsOf = (pairs) => {
    const cnt = {};
    for (let i = 0; i < pairs.length; i++) {
      const k = __dupKeyOf(pairs[i][0], pairs[i][1]);
      cnt[k] = (cnt[k] || 0) + 1;
    }
    const out = new Set();
    for (let i = 0; i < pairs.length; i++) {
      if (cnt[__dupKeyOf(pairs[i][0], pairs[i][1])] > 1) out.add(String(pairs[i][1] || ''));
    }
    return out;
  };
  const __rowClimb = (el, labels) => {
    const own = (el.innerText || el.value || '').trim();
    const isDup = (n) => labels.has((n.innerText || n.value || '').trim());
    let p = el ? el.parentElement : null, out = [], rows = [];
    for (let k = 0; k < 8 && p && p.tagName !== 'BODY'; k++, p = p.parentElement) {
      if ([...p.querySelectorAll('button, input[type=submit]')].filter(isDup).length > 1)
          break;                      // whole grid inside: too big
      const raw = (p.innerText || '').trim().split('\n').map(s => s.trim());
      const lines = raw.filter(t => t && t !== own && !labels.has(t)
               && !/^[\u00a3\u20ac$\d.,x%*\s]+$/.test(t)
               && /[a-z\u4e00-\u9fff]/i.test(t) && t.length <= 40);
      for (const t of lines) if (!out.includes(t)) out.push(t);
      for (const t of lines) if (rows.length < 6 && !rows.includes(t)) rows.push(t);
      for (const t of raw) {
        if (!t || t === own || labels.has(t) || rows.includes(t) || t.length > 40) continue;
        if (rows.length < 6 && /\d{5,}/.test(t)) rows.push(t);
      }
      if (out.length >= 3 && rows.length >= 6) break;
    }
    return {out: out, rows: rows};
  };
  // F85（评审收口）：dup 键的**标签口径唯一出处**——与池行 label 同口径（labelOfRaw 全逻辑的
  // 内联复刻：aria-label→title→首子节点文本→innerText→placeholder→value；input/textarea/select
  // 追加 label 包裹文本；PUA 字形剥除 + 空白折叠 + 40 字符截断）。池侧 addNearContext 用
  // Elem.label（= 本函数同口径），observe/HINT_HEAD/A3 若各写一份会对长标签/表单控件分组
  // 不同（K 不同 → 同一 row-index:N 指到不同成员）。改名 __rowLabelOf 避免与 LABEL_HELPERS_JS
  // 的 labelOfRaw 冲突（四 pass 里只有 OBSERVE 内插了 LABEL_HELPERS_JS）。
  const __rowTag = (el) => String(el.tagName || el.nodeName || '').toLowerCase();
  // 范围控件的活值不是身份（与 LABEL_HELPERS_JS 的 isRangeLike 同一口径）——两处必须同步，
  // 否则池行 label 与 dup 分组标签会分叉。
  const __rowIsRange = (el, tag) => tag === 'input'
    && String(el.getAttribute('type') || '').toLowerCase() === 'range';
  const __rowLabelOf = (el) => {
    const tag = __rowTag(el);
    const norm = (t) => String(t || '').replace(/[\uE000-\uF8FF]/g, '').replace(/[ \t\n\r\f\v]+/g, ' ').trim();
    const first = el.childNodes && el.childNodes.length ? String(el.childNodes[0].textContent || '') : '';
    let label = norm(el.getAttribute('aria-label') || el.getAttribute('title') || first || '');
    const text = (!label || tag === 'select') ? norm(el.innerText || '') : '';
    if (!label && __rowIsRange(el, tag)) label = text || el.getAttribute('placeholder') || '';
    else if (!label) label = text || el.getAttribute('placeholder') || el.getAttribute('value') || '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const own = __rowIsRange(el, tag) ? '' : String(el.value || '').trim();
      let p = el.closest ? el.closest('label') : null;
      if (!p && el.id) {
        try { p = document.querySelector('label[for="' + (globalThis.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]'); } catch (err) { p = null; }
      }
      let wrapper = p ? norm(p.innerText) : '';
      if (own && wrapper.indexOf(own) === 0) wrapper = wrapper.slice(own.length).trim();
      if (!label) label = wrapper;
      else if (wrapper && wrapper !== label && label.indexOf(wrapper) === -1) label = label + ' / ' + wrapper;
    } else if (!label) {
      label = norm(el.innerText || '');
    }
    return norm(label).slice(0, 40);
  };
  // “可见”与池/observe 同口径：必须有**非零盒**（EXTRACT 也要求 getClientRects 非零——
  // 无头区/折叠容器里 checkVisibility 为 true 但 Playwright 点不到，这类成员不能计入编号基，
  // 否则跨面 N 会错位）+ CSS 可见性（checkOpacity 与 OBSERVE 一致关掉）。
  const __rowVisible = (e) => {
    const rects = e.getClientRects ? e.getClientRects() : null;
    let hasBox = rects === null;
    if (rects !== null) {
      for (let k = 0; k < rects.length; k++) {
        if (rects[k].width > 0 && rects[k].height > 0) { hasBox = true; break; }
      }
    }
    if (!hasBox) return false;
    return e.checkVisibility ? e.checkVisibility({checkVisibilityCSS: true, checkOpacity: false}) : true;
  };
`;

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

