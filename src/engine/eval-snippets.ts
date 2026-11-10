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

/** Centre hit-test: distinguishes "covered" from "slow but unblocked". */
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

export { VALS_JS, HIT_JS, HIT_DETAIL_JS, FINAL_JS, SNAPSHOT_JS, VALS_FN, HIT_FN, HIT_DETAIL_FN, FINAL_FN, SNAPSHOT_FN };
