/**
 * Host-side compiled JS passes（从 executor.ts 拆出，F2）——五段内嵌脚本 + `asFunction`。
 *
 * 拆出的理由：这些是**纯字符串 + 一个 `new Function` 壳**，不依赖执行器类闭包，却占了
 * executor.ts 约 90 行。浏览器面（`BrowserMiddleware`）与任何需要跑同样 JS pass 的面都能
 * 直接引用同一份，避免散落两处导致注入脚本漂移。
 */

/**
 * Compile a JS snippet string into a callable. Playwright runs these in the page
 * context; the string is a function body expression (no statement), so we wrap
 * in `return (...)` before handing to `new Function`.
 */
export function asFunction(src: string): (...args: any[]) => any {
  // eslint-disable-next-line no-new-func
  return (new Function(`return (${src});`) as () => (...args: any[]) => any)();
}
/** Every input's current value — inner_text misses fills, and values drive validation.
 *
 * SECRET REDACTION (P0-3): `password`/`file`/`hidden`
 * inputs keep their SHAPE (a per-character mask) but never their content. The inert
 * check compares this string, so a typed password still CHANGES the snapshot
 * (`"" -> "*"` -> `"**"`) without leaking the value into a snapshot, a trace line or
 * a committed `-result.json`. A raw `.value` of a secret field must not survive here. */
const VALS_JS = `() => [...document.querySelectorAll('input,textarea,select')]
  .map(e => {
    const t = (e.getAttribute('type') || '').toLowerCase();
    const raw = String(e.value ?? '');
    const v = (t === 'password' || t === 'file' || t === 'hidden') ? '*'.repeat(raw.length) : raw;
    return (e.name || e.id || e.getAttribute('data-test') || e.tagName) + '=' + v;
  })
  .join('&')`;
const FN_VALS = asFunction(VALS_JS);

/**
 * B3：可勾选控件状态——独立于 `vals` 的**签名**字段，不拼进 vals 串（分隔符碰撞、
 * 且 P0-3 的敏感值掩码面零改动）。只记确定性状态：原生 checkbox/radio 的 `0/1`、
 * 带 `aria-checked` 元素的属性值、`aria-selected="true"`（只记 true）、
 * `select[multiple]` 的选中 index 列表。无此类控件时返回空串（快照字段省略 ⇒ 产物不变）。
 */
const CHECKS_JS = `() => {
  const out = [];
  for (const e of document.querySelectorAll('input,select,[aria-checked],[aria-selected]')) {
    const tag = e.tagName.toLowerCase();
    const t = (e.getAttribute('type') || '').toLowerCase();
    const key = e.name || e.id || e.getAttribute('data-test') || tag;
    if (tag === 'input' && (t === 'checkbox' || t === 'radio')) {
      out.push(key + '=' + (e.checked ? '1' : '0'));
    }
    if (tag === 'select' && e.multiple) {
      const picked = [...e.selectedOptions].map(o => o.index);
      // 无选中项不产生条目：仅含「未选中的多选 select」的页面 checks 仍为空 ⇒ 产物不变。
      if (picked.length) out.push(key + '=m[' + picked.join(',') + ']');
    }
    const ac = e.getAttribute('aria-checked');
    if (ac !== null) out.push(key + ':ac=' + ac);
    if (e.getAttribute('aria-selected') === 'true') out.push(key + ':as=1');
  }
  return out.join('&');
}`;
const FN_CHECKS = asFunction(CHECKS_JS);

/** B3：`{vals, checks}` **一次** evaluate 取回（页面往返不增加）；两段脚本各自单一出处。 */
const STATE_JS = `() => ({ vals: (${VALS_JS})(), checks: (${CHECKS_JS})() })`;
const FN_STATE = asFunction(STATE_JS);

/**
 * Centre hit-test: distinguishes "covered" from "slow but unblocked".
 * 公理 0（模拟正常操作）：中心命中的是**自己的后代** = 正常操作成立——真人点这块区域
 * 就会命中子节点、事件冒泡回元素的 handler（容器候选的常态），绝不判 covered；
 * 命中**自己的祖先** = 元素 pointer-events:none 或布局在祖先上，同样放行（Playwright
 * 的 actionability 与冒泡路径都能成立）；只有**第三方元素**盖住中心才算 covered。
 */
const HIT_JS = `(e) => {
  const r = e.getBoundingClientRect();
  if (!r.width || !r.height) return 'zero-size';
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return 'offscreen';
  const top = document.elementFromPoint(x, y);
  if (!top || top === e || e.contains(top) || top.contains(e)) return null;
  return [top.tagName.toLowerCase(), top.id ? '#' + top.id : ''].join('');
}`;
const FN_HIT = asFunction(HIT_JS);

/**
 * S1 actionability 现场（只读）：bbox + 中心点覆盖者 + 重查时节点是否仍在文档里。
 * 与 HIT_JS 分开是因为 HIT_JS 的返回值被两处当成“有无覆盖者”的布尔语义（不能改形状）。
 * 覆盖者判据与 HIT_JS 同一条公理：后代/祖先命中不算被盖（见 HIT_JS 注释），只有第三方算。
 */
const HIT_DETAIL_JS = `(e) => {
  const rr = e.getBoundingClientRect();
  const bbox = {
    x: Math.round(rr.x), y: Math.round(rr.y),
    width: Math.round(rr.width), height: Math.round(rr.height),
  };
  const requery = (e && e.isConnected && document.contains(e)) ? 'present' : 'detached';
  if (!rr.width || !rr.height) return { bbox, blocker: 'zero-size', requery };
  const x = rr.x + rr.width / 2, y = rr.y + rr.height / 2;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { bbox, blocker: 'offscreen', requery };
  const top = document.elementFromPoint(x, y);
  if (!top || top === e || e.contains(top) || top.contains(e)) return { bbox, blocker: null, requery };
  return { bbox, blocker: [top.tagName.toLowerCase(), top.id ? '#' + top.id : ''].join(''), requery };
}`;
const FN_HIT_DETAIL = asFunction(HIT_DETAIL_JS);

/**
 * Centre hit-test **with the relation** of the hit target to the element.
 *
 * 与 HIT_JS 同一条判据的细分版本，解决一个真实缺口：中心点被**自己的祖先**接住时
 * （元素 pointer-events:none / 布局画在祖先上），Playwright 的动作性检查会拒绝点击
 * （命中目标既非元素自身也非其后代），而冒泡语义下真人点击由祖先 handler 处理。
 * HIT_JS 把祖先命中并入"放行"，调用方因此只能等慢重试、最终报一个无信息量的
 * action-timeout；本探针把关系显式化：`self`/`descendant` = 可动作；`ancestor` = 元素本身
 * 不可命中、可重定向到该祖先；`covered` = 第三方盖住；`zero-size`/`offscreen` = 布局不可点。
 * 判据单源：`_declaredHitTest` 与 `occludedReason` 都读这里的关系口径。
 */
const HIT_RELATION_JS = `(e) => {
  const r = e.getBoundingClientRect();
  const bbox = {
    x: Math.round(r.x), y: Math.round(r.y),
    width: Math.round(r.width), height: Math.round(r.height),
  };
  const desc = (h) => [h.tagName.toLowerCase(), h.id ? '#' + h.id : ''].join('');
  if (!r.width || !r.height) return { relation: 'zero-size', blocker: null, bbox };
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { relation: 'offscreen', blocker: null, bbox };
  const top = document.elementFromPoint(x, y);
  if (!top) return { relation: 'none', blocker: 'none', bbox };
  if (top === e) return { relation: 'self', blocker: null, bbox };
  if (e.contains(top)) return { relation: 'descendant', blocker: null, bbox };
  if (top.contains(e)) return { relation: 'ancestor', blocker: desc(top), bbox };
  return { relation: 'covered', blocker: desc(top), bbox };
}`;
const FN_HIT_RELATION = asFunction(HIT_RELATION_JS);

/** Visible empty inputs/textareas the frozen plan's data bag can supply. */
const EMPTIES_JS = `() => [...document.querySelectorAll('input:not([type=hidden]),textarea')]
  .filter(e => !e.value.trim() && e.offsetParent !== null
    && !['checkbox','radio','submit','button'].includes((e.getAttribute('type') || '').toLowerCase()))
  .map(e => ({tag: e.tagName.toLowerCase(), dt: e.getAttribute('data-test') || '',
              name: e.name || '', id: e.id || ''}))`;
const FN_EMPTIES = asFunction(EMPTIES_JS);

/**
 * P0-E false_done guard 的只读复核（主 frame 一次 evaluate；不点击、不导航、不写值）。
 * 收集登录墙特征证据：title / h1-h3 文案（内容页的登录**链接**不算——正文只在
 * 短页（≤400 字符 ≈ 非内容页）上计，避免"页脚有登录入口"的误报）、正文头部。
 */
const GUARD_JS = `() => {
  const kw = ['登录', '登入', '登陆', 'login', 'sign in'];
  const hit = (s) => { const t = String(s || '').toLowerCase(); return kw.find(k => t.includes(k.toLowerCase())) || null; };
  const m = hit(document.title);
  if (m) return { title: document.title, hit: m, where: 'title' };
  for (const sel of ['h1', 'h2', 'h3']) {
    const el = document.querySelector(sel);
    if (el) { const h = hit(el.textContent); if (h) return { title: document.title, hit: h, where: sel }; }
  }
  const body = document.body ? String(document.body.innerText || '') : '';
  const head = body.slice(0, 400);
  if (body.length <= 400 && body.trim()) {
    // 页内的登录**链接**（如页脚"前往登录"）是导航入口不是墙：剥掉 <a> 文案后再匹配。
    let hay = head;
    for (const a of Array.from(document.querySelectorAll('a'))) {
      const t = String(a.textContent || '').trim();
      if (t) hay = hay.split(t).join('');
    }
    const b = hit(hay);
    if (b) return { title: document.title, hit: b, where: 'body(short page)' };
  }
  return { title: document.title, hit: null, where: null };
}`;
const FN_GUARD = asFunction(GUARD_JS);

/**
 * E4：overlay 只读探测（一次 evaluate；不点击、不消散、不猜可关性）。
 * 判据是**几何 + 层级**的客观面：视口大小的 fixed/absolute 元素、或面积 ≥30% 视口的
 * 遮挡块（cookie banner / modal backdrop / 引导遮罩都在这个形状里）。返回有界证据行
 * （≤3 个）：tag#id.class、z-index、面积占比、文本首 40 字。无 overlay = 空数组。
 */
const OVERLAY_JS = `() => {
  const vw = innerWidth, vh = innerHeight;
  const desc = (e) => {
    const id = e.id ? '#' + e.id : '';
    const cls = typeof e.className === 'string' && e.className.trim()
      ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return e.tagName.toLowerCase() + id + cls;
  };
  const out = [];
  for (const e of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
    if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const area = (r.width * r.height) / (vw * vh);
    const covers = r.left <= 0 && r.top <= 0 && r.right >= vw && r.bottom >= vh;
    const z = parseInt(cs.zIndex, 10);
    if (!covers && area < 0.3) continue;
    if (cs.position === 'absolute' && !(z > 0)) continue;
    const txt = String(e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    out.push({ desc: desc(e), z: Number.isFinite(z) ? z : 0, area: Math.round(area * 100) / 100, covers, txt });
    if (out.length >= 3) break;
  }
  return out;
}`;
const FN_OVERLAY = asFunction(OVERLAY_JS);

export {
  VALS_JS, CHECKS_JS, STATE_JS, HIT_JS, HIT_DETAIL_JS, HIT_RELATION_JS, OVERLAY_JS,
  FN_VALS, FN_CHECKS, FN_STATE, FN_HIT, FN_HIT_DETAIL, FN_HIT_RELATION, FN_EMPTIES, FN_GUARD, FN_OVERLAY,
};
