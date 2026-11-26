/**
 * 池抽取的**共享 JS 片段**（collect / 分桶 / 标签 / 结构证据 / 锚 / 行爬升）与宿主编译器。
 *
 * 从 pool-js.ts 纯搬移（本轮大文件拆分）：这些片段被 EXTRACT/OBSERVE/WINDOW/HINT/HEURISTIC
 * 多个 pass 以模板内插共用，单独成模块后"同一份 JS 只写一次"更显式；pool-js 与各 pass
 * 仍经 re-export/import 读同一份字符串，字节不变。
 */
// 标签/可见文本的字符上限**单一出处**（elem-model 的 FULL_LABEL_MAX = ElementView 合同的
// labelMaxChars 200）：注入页面的 JS 用 `${FULL_LABEL_MAX}` 内插，避免魔法数回写。
import { FULL_LABEL_MAX } from "./elem-model.ts";

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
 * 可见文本抽取的**唯一 JS 算法**（`LABEL_HELPERS_JS` 与 `ROW_CLIMB_JS` 内插同一份源码，
 * 各自绑定到不同名字：OBSERVE_JS 会把这两个片段**同时**内插进同一个函数作用域，同名 `const`
 * 会重复声明 ⇒ 同一份算法、两个绑定名）。
 *
 * 口径（缺陷修正：内联 `<style>` 文本污染 label）。此前的取法是 `childNodes[0].textContent`，
 * 首子节点是 `<style>` 时标签就成了 CSS（google.com 首页实测：某 div 的 label 变成
 * `.plsC5e{display:flex…}`，某 button 唯一可解析文本就是一段 CSS ⇒ 既读不懂也点不到）：
 *   1) 跳过 `style`/`script`/`noscript`/`template` **子树**——它们不是可见内容；
 *   2) 取**第一个可见内容节点**（文本节点或元素）的文本：元素侧按同一规则递归拼接；
 *   3) 防抖：候选文本形如 CSS（含 `{` 且含 `:` 或 `display:`）视为无效，**继续找下一个候选**，
 *      一个都不剩则返回空串（调用点的 innerText 兜底链照旧）。
 * `whole=true` 返回元素整棵子树的可见文本（`Elem.text` 用，同一跳过规则）。
 *
 * 字节纪律：不含 style/script 的普通元素走 `textContent` 快路径（与旧读数同一个值），
 * 因此既有 label 只在"首部有非渲染子树"或"候选是 CSS 文本"时才改变。
 *
 * 导出是为了让还有同款取法的镜像面（`identity.ts` 的 FW8 候选摘要、`candidate-scan.ts` 的
 * 逐元素回退）第二批**直接内插同一份**算法——绑定名由调用点自己定，别抄第二份实现。
 */
export const VISIBLE_TEXT_BODY = String.raw`(e, whole) => {
    const NON_RENDERED = 'style, script, noscript, template';
    const SKIP_TAGS = { style: 1, script: 1, noscript: 1, template: 1 };
    const isNonRendered = (n) => !!n && n.nodeType === 1
      && SKIP_TAGS[String(n.tagName || '').toLowerCase()] === 1;
    // 元素文本：无 style/script 子树时直接读 textContent（与此前同一读数 = 零漂移快路径），
    // 有则递归拼接并跳过非渲染子树。
    const textOf = (n) => {
      if (!n) return '';
      if (n.nodeType === 3) return String(n.nodeValue || '');
      if (n.nodeType !== 1 || isNonRendered(n)) return '';
      let dirty = null;
      try { dirty = n.querySelector(NON_RENDERED); } catch (err) { dirty = null; }
      if (dirty === null) return String(n.textContent || '');
      let out = '';
      const kids = n.childNodes || [];
      for (let i = 0; i < kids.length; i++) out += textOf(kids[i]);
      return out;
    };
    const cssish = (t) => t.indexOf('{') >= 0 && (t.indexOf(':') >= 0 || t.indexOf('display:') >= 0);
    if (whole) return textOf(e);
    const kids = e && e.childNodes ? e.childNodes : [];
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i];
      if (isNonRendered(n)) continue;                       // 非渲染子树不是内容
      if (n.nodeType !== 1 && n.nodeType !== 3) continue;    // 注释/处理指令等
      const t = textOf(n);
      if (cssish(t)) continue;                              // 防抖：CSS 文本不是标签，看下一个候选
      return t;                                             // 首个内容节点（空串 = 交给 innerText 兜底链）
    }
    return '';
  }`;

/**
 * 可读标签的**唯一 JS 实现**（EXTRACT_JS 的池行与 OBSERVE_JS 的只读观察共用）。
 *
 * `labelOfRaw` 返回**不截断**的完整标签：池行在调用点自己 `.slice(0, 200)`（`full_label`
 * 的 200 上限是 A2 的匹配口径，不是标签本身的长度），observe/inspect 才能真正看到
 * 超过 200 字符的标签。两处若各写一份，长标签会在一面被悄悄截断——P0-A 之前的
 * inspect「label ~200 字截断」正是这种漂移。
 *
 * 取值链与来源**同址**：`labelInfoOf` 在每一档赋值处记一次 `source`（封闭枚举见
 * `extraction.ELEM_LABEL_SOURCES`），并可选地算 `text`（元素可见文本，上限 `labelMaxChars`）；
 * `labelOfRaw` 只是它的 `.label` 投影 ⇒ 既有 label 行为不变。
 */
export const LABEL_HELPERS_JS = String.raw`
  const __scanVisibleText = ${VISIBLE_TEXT_BODY};
  const __firstVisibleText = (e) => __scanVisibleText(e, false);
  // 元素整棵子树的可见文本（Elem.text 用；同一跳过规则，调用点再 norm + 截断）。
  const __visibleText = (e) => __scanVisibleText(e, true);
  // Elem.text 的上限 = ElementView 合同 labelMaxChars（与 full_label 同界）。
  const __TEXT_MAX = ${FULL_LABEL_MAX};
  const WS = /[ \t\n\r\f\v]+/g;
  // Material/Google 的图标是 private-use 字形（\ue8ba 等），会出现在按钮文本里；
  // 它是装饰，不是人可读标签。先剥掉 PUA 再折叠空白，否则 Hotels 按钮的 label 会是
  // \ue8baHotels，ctx.hints("Hotels") 匹配不到（Google Maps 实测）。
  const norm = (t) => (t || '').replace(/[\uE000-\uF8FF]/g, '').replace(WS, ' ').trim();
  // 范围控件（range / role=slider）的**活值不是身份**：value 属性/当前值随每次操作变化，
  // 拿它做 label 会让同一元素在两次观察里叫两个名字（hint 因此失配，set_range 第二轮直接
  // target_not_found）。身份必须来自稳定面——aria-label / label 包裹 / id / name / data-test。
  const isRangeLike = (e, tag) => tag === 'input' && String(e.getAttribute('type') || '').toLowerCase() === 'range';
  // 敏感输入（password / file / hidden）的活值**不是身份，也绝不可进标签**：明文凭据不得进入
  // 池快照 / observe 行 / 模型面 / trace / 跑分产物。只按 type 排除（不做"看起来像凭据"的
  // 形态启发——value 是标签兜底链的最后一环，启发式会误伤大量真实标签且无法解释）。
  // 与 isRangeLike 同一形态：不读自身 value，只读稳定面 aria-label / label 包裹 / placeholder。
  // 与 ROW_CLIMB_JS 的 __rowIsSecret 同口径（dup 分组键必须与池行 label 一致）。
  const isSecretInput = (e, tag) => tag === 'input'
    && /^(password|file|hidden)$/i.test(String(e.getAttribute('type') || ''));
  /**
   * 标签 + 来源 + 可见文本（Elem.label / label_source / text 的**唯一构造处**）。
   * 取值链与此前逐字节同序：aria-label → title → 首个可见内容节点 → innerText →
   * placeholder → value → label 包裹；source 在**赋值处**同步落（封闭枚举见
   * extraction.ELEM_LABEL_SOURCES），组合标签（aria / wrapper）记主来源；withText 为真时
   * 才算整棵子树的可见文本（上限 __TEXT_MAX = labelMaxChars），池行只对入池行付这份成本。
   */
  const labelInfoOf = (e, tag, withText) => {
    let source = 'none';
    let label = e.getAttribute('aria-label') || '';
    if (label) source = 'aria-label';
    if (!label) { label = e.getAttribute('title') || ''; if (label) source = 'title'; }
    if (!label) { label = __firstVisibleText(e); if (label) source = 'text'; }
    label = norm(label);
    const text = (!label || tag === 'select') ? norm(e.innerText || '') : '';
    // 范围控件与敏感输入不读自身 value（活值），只读 placeholder（原生 range 无 placeholder，
    // 敏感输入常见 placeholder="请输入密码" 这类稳定身份）。
    if (!label) {
      const placeholder = e.getAttribute('placeholder') || '';
      const value = (isRangeLike(e, tag) || isSecretInput(e, tag)) ? '' : (e.getAttribute('value') || '');
      if (text) { label = text; source = 'text'; }
      else if (placeholder) { label = placeholder; source = 'label'; }
      else if (value) { label = value; source = 'label'; }
      else source = 'none';
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const own = (isRangeLike(e, tag) || isSecretInput(e, tag)) ? '' : (e.value || '').trim();
      let p = e.closest('label');
      if (!p && e.id) {
        try { p = document.querySelector('label[for="' + CSS.escape(e.id) + '"]'); } catch (err) { p = null; }
      }
      let wrapper = p ? norm(p.innerText) : '';
      if (own && wrapper.indexOf(own) === 0) wrapper = wrapper.slice(own.length).trim();
      if (!label) { label = wrapper; if (wrapper) source = 'label'; }
      else if (wrapper && wrapper !== label && label.indexOf(wrapper) === -1) label = label + ' / ' + wrapper;
    } else if (!label) {
      label = norm(e.innerText || '');
      if (label) source = 'text';
    }
    const out = norm(label);
    return { label: out, source: out ? source : 'none',
             text: withText ? norm(__visibleText(e)).slice(0, __TEXT_MAX) : '' };
  };
  const labelOfRaw = (e, tag) => labelInfoOf(e, tag, false).label;
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
 * break 取 `out.length>=3`（rows 另行计算，不再与 near 共用 break 条件）⇒ out 前缀稳定
 * （层只增不减、逐层同序）⇒ near = out.slice(0,3) 逐字节相等（结构性证明，R1）。rows 的行
 * 过滤 = 现行过滤 **OR 连续数字 ≥5 位**（救援纯数字订单号 20240101；时刻 "20:20"、短价格段
 * 维持剔除）；泄漏的长数字/价格行无害——价格词元由 suggestHints 生成期硬拒兜底，匹配面不挑词。
 *
 * R2（行容器口径）：rows 取**行容器**——爬升途中第一个「与兄弟同构」的祖先（签名 tag+id+class
 * 在同父元素里出现 ≥2 次 ⇒ 这一层是"一行"，兄弟是同级的其它行），rows = 从第一层产出内容行的
 * 祖先到该行的并集；跨层并集**不越过行容器**（那会把评论列表/面板抬头/侧栏这些上层容器的文案
 * 并进每一行——Google 地图实测：三个 label="查看更多" 的按钮，行词元变成侧栏搜索结果
 * "Pici (Central)" / 门店地址 ⇒ in-row 指向的不是行）。8 层内既遇不到行容器、也没遇到网格层时
 * 兜底取第一层内容块；本元素自身的 dup 键（tag+label，与分组同一出处）在某层出现 ≥2 次即网格
 * 层，行不在其上。反向面：near 的网格 break 对 `labels`（**全部** dup 标签）的 innerText 交集
 * 生效，卡片上只要另有同文案的 讚/回覆 就在卡片层 break ⇒ rows 必须**独立行走**，不受该 break
 * 拖累。长行**截断到 40**（字符串预算不变；正文单行常 >40，整行丢弃会让行文本只剩上层容器词元）。
 * out（near）逐字节不动（R1 只覆盖 near）；rows 与近邻集合的"⊇"关系不是契约——匹配面
 * （rowMatch）只要求"任一行 includes"，回捞/observe/A3/声明面四面共用本片段故同时生效。
 * `__rowTextsFor` 是声明面（declared.ts 的 DRF 收集）的行文本底座：同一 dup 门控 + 同一
 * `__rowClimb`，非重复组/未爬出内容 = null（调用点不出字段 ⇒ 行锚 fail-closed 对称）。
 * 文本抽取（首个可见内容节点 / 跳过 style·script 子树 / CSS 防抖）与 `LABEL_HELPERS_JS` 是
 * **同一份** `VISIBLE_TEXT_BODY` 源码，只是绑定名不同（`__firstRowVisibleText`，理由见该片段
 * 注释）⇒ 池行 label 与 dup 分组键不会因"两处各写一份"漂移；`pool-js.ts` 的 HINT_HEAD 回捞行
 * 也读这里的第一行 helper（它只内插本片段，不内插 LABEL_HELPERS_JS）。
 * 无换行首尾（首行直接跟内容、末行 `};` 收尾），调用点以 `${ROW_CLIMB_JS}` 独占一行内插。
 */
export const ROW_CLIMB_JS = String.raw`  const __scanRowVisibleText = ${VISIBLE_TEXT_BODY};
  const __firstRowVisibleText = (e) => __scanRowVisibleText(e, false);
  const __dupKeyOf = (tag, label) => String(tag || '') + '\u0000' + String(label || '');
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
      if (out.length >= 3) break;
    }
    // rows（row_texts）**独立行走**（R2）：上面那条网格 break 是 near 的口径，它对 labels **全集**
    // 的 innerText 交集生效——卡片上只要还有同文案的 讚/回覆 就在卡片层 break，行文本会恒空
    // （Google 地图评论卡实测）。行容器判据 = **与兄弟同构的那一层**（tag+id+class 签名在同父元素里
    // 出现 ≥2 次 = 这一层是"一行"，它的兄弟是同级的其它行）；rows = 从第一层产出内容行的祖先到该行
    // 的并集（跨层只到行容器为止，再往上既不是本行也不是行内容）。8 层内既没遇到行容器、又没遇到
    // 网格层时兜底取第一层内容块；本元素自身的 dup 键（tag+label，与分组同一出处）在某层出现
    // ≥2 次即网格层，行不在其上。长行截断到 40（正文单行常 >40，整行丢弃会让行文本只剩上层容器
    // 的词）；预算仍是 ≤6 行 × ≤40 字符。
    const ownKey = __dupKeyOf(__rowTag(el), __rowLabelOf(el));
    let rp = el ? el.parentElement : null, acc = [], first = null, atRow = false;
    for (let k = 0; k < 8 && rp && rp.tagName !== 'BODY' && !atRow; k++, rp = rp.parentElement) {
      const ctrls = [...rp.querySelectorAll('button, input[type=submit]')];
      let selfCnt = 0;
      for (const n of ctrls) { if (__dupKeyOf(__rowTag(n), __rowLabelOf(n)) === ownKey) { selfCnt += 1; if (selfCnt > 1) break; } }
      if (selfCnt > 1) break;           // 网格层（含第二个同类控件）：行在下面，不再往上并
      const raw = (rp.innerText || '').trim().split('\n').map(s => s.trim());
      // 控件文本行（卡片底部 "更多 讚 回覆" 这类 inline 控件被 innerText 拼成一行）不是行内容：
      // 整行只由本层控件自身文本拼成 ⇒ 丢掉（无判别力，只挤占 ≤6 行预算）。
      const ctrlTxt = new Set();
      for (const n of ctrls) ctrlTxt.add((n.innerText || n.value || '').trim());
      const ctrlOnly = (t) => {
        for (const x of t.split(/\s+/)) if (x && !ctrlTxt.has(x)) return false;
        return true;
      };
      const keep = (t) => t && t !== own && !labels.has(t)
               && !/^[\u00a3\u20ac$\d.,x%*\s]+$/.test(t) && /[a-z\u4e00-\u9fff]/i.test(t)
               && !ctrlOnly(t);
      for (const t of raw.filter(keep)) {
        const line = t.length <= 40 ? t : t.slice(0, 40);
        if (acc.length < 6 && !acc.includes(line)) acc.push(line);
      }
      for (const t of raw) {
        if (!t || t === own || labels.has(t) || acc.includes(t) || t.length > 40) continue;
        if (acc.length < 6 && /\d{5,}/.test(t)) acc.push(t);
      }
      if (acc.length && first === null) first = acc.slice();
      // 行容器 = 与兄弟同构的一层（签名 = tag + id + class，同 tag 父元素里出现 ≥2 次）。
      const par = rp.parentElement, sig = __rowSigOf(rp);
      let sib = 0;
      if (par) for (const c of par.children) { if (__rowSigOf(c) === sig) { sib += 1; if (sib > 1) break; } }
      atRow = sib > 1;
    }
    rows = atRow || first === null ? acc : first;
    return {out: out, rows: rows};
  };
  // F85（评审收口）：dup 键的**标签口径唯一出处**——与池行 label 同口径（labelOfRaw 全逻辑的
  // 内联复刻：aria-label→title→首子节点文本→innerText→placeholder→value；input/textarea/select
  // 追加 label 包裹文本；PUA 字形剥除 + 空白折叠 + 40 字符截断）。池侧 addNearContext 用
  // Elem.label（= 本函数同口径），observe/HINT_HEAD/A3 若各写一份会对长标签/表单控件分组
  // 不同（K 不同 → 同一 row-index:N 指到不同成员）。改名 __rowLabelOf 避免与 LABEL_HELPERS_JS
  // 的 labelOfRaw 冲突（四 pass 里只有 OBSERVE 内插了 LABEL_HELPERS_JS）。
  const __rowTag = (el) => String(el.tagName || el.nodeName || '').toLowerCase();
  // 行容器判据的签名（R2）：tag + id + class。同一父元素下出现 ≥2 个同签名子元素 = 这一层是"一行"
  // （兄弟行同构）。**不用**邻居数量类启发（判的是"我这一层像不像行"，不是"页面上有几行"）。
  const __rowSigOf = (n) => __rowTag(n) + '#' + String(n.id || '') + '.' + String(n.getAttribute('class') || '');
  // 范围控件与敏感输入的活值不是身份（与 LABEL_HELPERS_JS 的 isRangeLike/isSecretInput 同一
  // 口径）——两处必须同步，否则池行 label 与 dup 分组标签会分叉。
  const __rowIsRange = (el, tag) => tag === 'input'
    && String(el.getAttribute('type') || '').toLowerCase() === 'range';
  const __rowIsSecret = (el, tag) => tag === 'input'
    && /^(password|file|hidden)$/i.test(String(el.getAttribute('type') || ''));
  const __rowLabelOf = (el) => {
    const tag = __rowTag(el);
    const norm = (t) => String(t || '').replace(/[\uE000-\uF8FF]/g, '').replace(/[ \t\n\r\f\v]+/g, ' ').trim();
    const first = __firstRowVisibleText(el);
    let label = norm(el.getAttribute('aria-label') || el.getAttribute('title') || first || '');
    const text = (!label || tag === 'select') ? norm(el.innerText || '') : '';
    if (!label && __rowIsRange(el, tag)) label = text || el.getAttribute('placeholder') || '';
    else if (!label) {
      label = text || el.getAttribute('placeholder')
        || (__rowIsSecret(el, tag) ? '' : el.getAttribute('value')) || '';
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const own = (__rowIsRange(el, tag) || __rowIsSecret(el, tag)) ? '' : String(el.value || '').trim();
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
  // 声明面（declared.ts DRF 收集）的行文本底座：与池/回捞/observe 同一 dup 门控 + 同一 __rowClimb
  // ——入参是**可见**候选元素数组，返回同下标的行文本（非重复组 / 未爬到内容 = null ⇒ 调用点不出
  // 字段 ⇒ 行锚 fail-closed 对称）。计算封顶与 HINT_HEAD 同档（120，超标 = 行锚落空不半猜）。
  const __rowTextsFor = (els) => {
    const keys = [], cnt = {};
    for (let i = 0; i < els.length; i++) {
      const k = __dupKeyOf(__rowTag(els[i]), __rowLabelOf(els[i]));
      keys.push(k);
      cnt[k] = (cnt[k] || 0) + 1;
    }
    const labels = new Set();
    for (let i = 0; i < els.length; i++) if ((cnt[keys[i]] || 0) > 1) labels.add(__rowLabelOf(els[i]));
    const out = [];
    let computed = 0;
    for (let i = 0; i < els.length; i++) {
      if ((cnt[keys[i]] || 0) <= 1 || computed >= 120) { out.push(null); continue; }
      computed += 1;
      const c = __rowClimb(els[i], labels);
      out.push(c.rows.length ? c.rows : null);
    }
    return out;
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

