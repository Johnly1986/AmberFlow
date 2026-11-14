/**
 * `target_hint` 语法的**唯一**解析器（P0-B）。
 *
 * 背景：池侧（`rules.hintMatchImpl`）与 DOM 侧回捞（`extraction.hintLookup`）曾经各写一遍
 * 字符串解析，靠"成对改"的纪律维持同构，漂移过两次（`#id` 只加一侧、`=` 漏大小写折叠）。
 * 现在"这串 hint 是什么形状"只在这里回答一次；两个面只回答"在我的底座上它命中谁"
 * （池侧 = `Elem` 字段投影，DOM 侧 = 活页面属性/标签）。
 *
 * 注意：解析只管**形状**。属性名是否在池子的字段模型里、值怎么比（精确/包含/按路径段分档）
 * 是各观察面自己的事——那部分差异是设计（池子是投影，DOM 是活页面），不是漂移。
 */
/**
 * `target_hint` 的**解析结果**——语法只有这一份（`parseHint`），两个观察面各自提供"匹配底座"：
 * 池侧按 `Elem` 字段匹配，DOM 侧按活页面属性/标签匹配（回捞被预算挤出的元素）。
 *
 * 为什么把解析抽出来：两面曾经各写一遍字符串解析，漂移过两次（`#id` 只加一侧、`=` 漏大小写
 * 折叠）。现在"这串 hint 是什么形状"只在一个函数里回答；两面只回答"在这个底座上它命中谁"。
 */
export type ParsedHint =
  | { kind: "id"; value: string; within?: string; frameChain?: string[] }
  | { kind: "attrSubstr"; tag: string; attr: string; value: string; within?: string; frameChain?: string[] }
  | { kind: "nearToken"; tag: string; token: string; within?: string; frameChain?: string[] }
  | { kind: "attrEq"; tag: string; attr: string; value: string; within?: string; frameChain?: string[] }
  | { kind: "tag"; tag: string; within?: string; frameChain?: string[] }
  | { kind: "bare"; token: string; within?: string; frameChain?: string[] };

/** DOM 属性名的规范形（`test`→`data-test`、`type`→`type`）；池侧用 `poolAttr` 映射回字段名。 */
const DOM_ATTR: Record<string, string> = { test: "data-test", "data-test": "data-test", type: "type" };
const POOL_ATTR: Record<string, string> = { "data-test": "data_test", type: "input_type" };

/** 池侧字段名（`Elem` 的字段，不是 DOM 属性名）。 */
export function poolAttr(attr: string): string {
  return POOL_ATTR[attr] ?? attr;
}

/**
 * **唯一**的 hint 语法解析器（6 种形状 + `within:#id` / `frame:<origin链>` 尾缀 + 大小写折叠在这里发生一次）。
 *
 * 规则（与冻结计划的写法一一对应）：
 *   `#id` ｜ `tag[attr~substr]`（含 `[near~token]`）｜ 无括号的 `tag~token`（近邻）｜
 *   `tag[attr=value]`（值去引号）｜ `button|link|input|textarea|select`（角色词）｜ 裸词。
 *
 * E3：尾缀 `within:#id`（可选；**单层，不链式**）——把命中集限定在锚元素子树内。
 * A 批：尾缀 `frame:<origin链>`（可选；`>` 分隔外→内、≤4 段、每段 `v === new URL(v).origin`
 * 的 http(s) 规范形；末段 = 元素所在帧自身 origin，声明链 = 帧完整链的后缀）。
 * 剥离发生在一切形状判定之前；锚只能是 `#id` 形态（任意 CSS 锚拒绝）。
 *
 * **串尾词法预扫 + 循环剥离**（R2-5）：两类后缀各**至多一次**，只认「前置空白 + 串尾」；
 * 任一类超限 / 值非法 / 空段 ⇒ **整组后缀都不应用**——按原始串回退（禁止半剥），
 * 原串按既有形状解析 → 大概率落空 = 显式失败，绝不静默取第一个。计数只数**串尾预扫**
 * 发现的后缀，不做全局子串计数（旧实现 `(h.match(/within:/g)).length` 会把值内的伪后缀
 * 误当成第二个尾缀而整串拒绝——`host within:8080 within:#panel` 就是这个误伤）。
 *
 * 注意：解析只管**形状**。属性名是否在池子的字段模型里、值怎么比（精确/包含/按路径段分档）
 * 是各观察面自己的事——那部分差异是设计（池子是投影，DOM 是活页面），不是漂移。
 */
/**
 * C 批（B8）：`frame:` 值被拒的**原因类别**（与 parseFrameChainValue 共用同一判定，只是保留
 * 拒绝理由——诊断面要区分"多段/非法 scheme/带 path"）。非法 = 返回 problem；合法 = null。
 */
export type FrameChainValueProblem =
  | { kind: "empty" }
  | { kind: "too-long"; segments: number }
  | { kind: "empty-segment"; segments: number }
  | { kind: "not-http-origin"; segment: string }
  | { kind: "not-canonical"; segment: string };

/** frame 链值的唯一校验（§12.3 R2-1）：`>` 分隔 origin 链、≤4 段、每段
 *  `v === new URL(v).origin` 且是 http/https 规范形（带 path/query/显式默认端口/about:blank/ftp
 *  都拒绝）。解析面只看"是否合法"，诊断面要原因类别——同一份判定，不另写第二套。 */
export function frameChainValueProblem(raw: string): FrameChainValueProblem | null {
  if (raw === "") return { kind: "empty" };
  const segs = raw.split(">");
  if (segs.length > 4) return { kind: "too-long", segments: segs.length };
  for (const seg of segs) {
    if (seg === "") return { kind: "empty-segment", segments: segs.length };
    let origin: string;
    try { origin = new URL(seg).origin; } catch { return { kind: "not-http-origin", segment: seg }; }
    if (origin === "null") return { kind: "not-http-origin", segment: seg };   // about:blank / file 等
    if (!origin.startsWith("http://") && !origin.startsWith("https://")) {
      return { kind: "not-http-origin", segment: seg };
    }
    if (seg !== origin) return { kind: "not-canonical", segment: seg };       // path/query/显式默认端口
  }
  return null;
}

/** `frame:` 值校验：合法 = 段数组（小写规范 origin），非法 = null。 */
function parseFrameChainValue(raw: string): string[] | null {
  if (frameChainValueProblem(raw) !== null) return null;
  return raw.split(">");
}

/** 诊断面的尾缀预扫：与 frame 尾缀同形但允许**空值**（空值 parseHint 同样回退旧形状，
 *  `describeFrameSuffixRejection` 要能点名"frame: 后没有值"）。 */
const FRAME_TAIL_VALUE_RE = /(?:\s+frame:)(\S*)\s*$/;
/** 诊断面用：within 尾缀词法（与 splitTailSuffixes 内部同形；describe 在小写串上逐段剥离）。 */
const WITHIN_TAIL_RE = /(?:\s+within:)(#[a-z0-9_\-.:]+)\s*$/;

/**
 * 串尾词法预扫 + 循环剥离（A 批 R2-5；C 批 B-1 起导出为**唯一剥离出处**，供 parseHint 与
 * `findByHint` 等旧匹配器共用——N6：防 hint 语法两处漂移）。在**原始大小写**串上做（正则 /i）；
 * 返回 base 保留原串大小写，`within`/frameChain 值小写规范化。
 * 两类后缀各 ≤1、只认「前置空白 + 串尾」；任一类超限/值非法/空段 ⇒ **整组回退**
 * （base = trim 后原串、无后缀字段，绝不半剥）——与 parseHint 逐字节同口径。
 */
export function splitTailSuffixes(hint: string): { base: string; within?: string; frameChain?: string[] } {
  const WITHIN_TAIL_RE = /(?:\s+within:)(#[a-z0-9_\-.:]+)\s*$/i;
  const FRAME_TAIL_RE = /(?:\s+frame:)(\S+)\s*$/i;
  let rest = hint.trim();
  let within: string | undefined;
  let frameChain: string[] | undefined;
  let withinSeen = 0;
  let frameSeen = 0;
  let rejected = false;
  for (;;) {
    const wm = WITHIN_TAIL_RE.exec(rest);
    const fm = wm === null ? FRAME_TAIL_RE.exec(rest) : null;
    if (wm === null && fm === null) break;
    if (wm !== null) {
      const base = rest.slice(0, wm.index).trim();
      if (base === "") { rejected = true; break; }
      withinSeen += 1;
      if (withinSeen > 1) { rejected = true; break; }
      within = wm[1]!.slice(1).toLowerCase();
      rest = base;
      continue;
    }
    const base = rest.slice(0, fm!.index).trim();
    if (base === "") { rejected = true; break; }
    frameSeen += 1;
    if (frameSeen > 1) { rejected = true; break; }
    const chain = parseFrameChainValue(fm![1]!.toLowerCase());
    if (chain === null) { rejected = true; break; }
    frameChain = chain;
    rest = base;
  }
  if (rejected) return { base: hint.trim() };   // 整组回退：绝不半剥
  return {
    base: rest,
    ...(within !== undefined ? { within } : {}),
    ...(frameChain !== undefined ? { frameChain } : {}),
  };
}

export function parseHint(hint: string): ParsedHint {
  // 串尾剥离收口在 splitTailSuffixes（唯一出处）；先小写再剥离，与旧实现逐字节同口径。
  const s = splitTailSuffixes(hint.toLowerCase());
  const rest = s.base;
  const within = s.within;
  const frameChain = s.frameChain;
  const withSuffix = <T extends ParsedHint>(p: T): T => {
    let q = p;
    if (within !== undefined) q = { ...q, within } as T;
    if (frameChain !== undefined) q = { ...q, frameChain } as T;
    return q;
  };
  if (rest.startsWith("#")) return withSuffix({ kind: "id", value: rest.slice(1) });
  if (rest.includes("[") && rest.split("[", 2)[1]!.includes("~")) {
    const tag = rest.slice(0, rest.indexOf("["));
    const body = rest.slice(rest.indexOf("[") + 1).replace(/\]$/, "");
    const tilde = body.indexOf("~");
    return withSuffix({ kind: "attrSubstr", tag, attr: DOM_ATTR[body.slice(0, tilde)] ?? body.slice(0, tilde), value: body.slice(tilde + 1) });
  }
  if (rest.split("[").pop()!.includes("~")) {
    // 04-E：无括号的 `tag~token` 是文档声明的合法形状（:40），但旧实现无括号时走
    // `indexOf("[") >= 0 ? … : 0` 分支——tag 恒为空串。按 "~" 切开：前段是 tag，后段是 token。
    const bracket = rest.indexOf("[");
    const tilde = rest.indexOf("~");
    const tag = bracket >= 0 ? rest.slice(0, bracket) : rest.slice(0, tilde);
    const after = bracket >= 0 ? rest.slice(bracket + 1) : rest.slice(tilde + 1);
    return withSuffix({ kind: "nearToken", tag, token: after.replace(/\]$/, "").split("~").slice(-1)[0]! });
  }
  if (rest.includes("[")) {
    const tag = rest.slice(0, rest.indexOf("["));
    const body = rest.slice(rest.indexOf("[") + 1);
    const eq = body.indexOf("=");
    const attr = DOM_ATTR[eq >= 0 ? body.slice(0, eq) : body] ?? (eq >= 0 ? body.slice(0, eq) : body);
    const value = (eq >= 0 ? body.slice(eq + 1) : "").replace(/\]$/, "").replace(/^['"]|['"]$/g, "");
    return withSuffix({ kind: "attrEq", tag, attr, value });
  }
  if (["button", "link", "input", "textarea", "select"].includes(rest)) return withSuffix({ kind: "tag", tag: rest });
  return withSuffix({ kind: "bare", token: rest });
}

/* ------------------------------------------------ 后缀被拒绝的只读诊断（C 批 B8） */

/**
 * C 批（B8）：**串尾 ` frame:` 形状的尝试未被 parseHint 接受**时，给一行可行动原因；没有尝试 /
 * 已合法接受 = null。纯字符串、零页面 I/O、不改 parseHint 的返回值语义。
 *
 * 为什么需要它：非法 origin / 多尾缀 / 带 path 的值按 R2-5「整组回退」被当成旧形状裸词，运行期
 * 只会得到 target_not_found 或会话 act 零命中——不点名后缀等于让作者猜。这里把"哪个尾缀、因为
 * 什么类别没生效"说清楚（消费面：executor 的 target_not_found reason + 会话 act reason；
 * 页面可用 origin 列表由调用方另行追加）。
 *
 * 判定与 parseHint **同一条词法预扫**（`\s+` + 串尾；within 只认 `#...`、frame 值可为空串——
 * 空值 parseHint 会按旧形状回退，这里也要能点名）。**只报 frame 相关**：只重复 within 的问题
 * 不归本函数（它没有 frame: 可说），但"frame: 合法却因同串 within 问题被整组回退"要报——
 * 那正是 frame: 静默失效的一条。
 */
export function describeFrameSuffixRejection(hint: string): string | null {
  // 合法（含与 within 组合）＝ parseHint 已接受，没有"被拒绝"可报。
  if (parseHint(hint).frameChain !== undefined) return null;
  const h = hint.trim().toLowerCase();
  let rest = h;
  let frameSeen = 0;
  let withinSeen = 0;
  let frameProblem: string | null = null;
  let blockedByWithin = false;
  for (;;) {
    const wm = WITHIN_TAIL_RE.exec(rest);
    const fm = wm === null ? FRAME_TAIL_VALUE_RE.exec(rest) : null;
    if (wm === null && fm === null) break;
    const base = rest.slice(0, (wm ?? fm)!.index).trim();
    if (wm !== null) {
      withinSeen += 1;
      // within 自己出问题：parseHint 在这里就整组回退，但我们继续剥（只诊断）——为的是回答
      // "这一串里到底有没有 frame: 尝试"（`frame:… within:#a within:#b` 的 frame 同样没生效）。
      if (base === "" || withinSeen > 1) blockedByWithin = true;
      if (base === "") break;
      rest = base;
      continue;
    }
    // 值内伪尾缀：`tag[attr=value frame:…]` 里的 ` frame:` 属于**属性值**（base 里有未闭合的
    // `[`），不是语法后缀——不误报（parseHint 也从不把形状值里的 frame: 当尾缀）。
    if (hasUnclosedBracket(base)) break;
    frameSeen += 1;
    const raw = fm![1]!;
    if (base === "") {
      frameProblem = "尾缀前没有 hint 主体（必须写成 `<hint> frame:<origin>`）";
      break;
    }
    if (frameSeen > 1) {
      frameProblem = "同一串出现多个 frame: 尾缀（至多一次；整组后缀都不应用）";
      break;
    }
    const problem = frameChainValueProblem(raw);
    if (problem !== null) { frameProblem = frameChainProblemText(problem); break; }
    rest = base;
  }
  if (frameProblem !== null) {
    return `frame: 尾缀未被应用（${frameProblem}）——整串按旧形状解析，目标大概率落空`
      + `（命令步 target_not_found / 会话 act 零命中）。修法：写成 \`<hint> frame:<http(s)://host[:port]>\`，`
      + `\`>\` 链 ≤4 段、每段用规范 origin（不带 path/query/显式默认端口），且一条 hint 只能有一个 frame: 尾缀`;
  }
  if (frameSeen > 0 && blockedByWithin) {
    return "frame: 尾缀未被应用（同一串的 within: 尾缀重复或缺少 hint 主体——R2-5 整组回退："
      + "任一类后缀超限/非法则所有后缀都不应用）——修法：去掉重复/孤立的 within: 后 frame: 才会生效";
  }
  return null;
}

/** 值问题的人话（有界：值的展示 ≤80 字符）。 */
function frameChainProblemText(p: FrameChainValueProblem): string {
  switch (p.kind) {
    case "empty": return "frame: 后没有值";
    case "too-long": return `声明 ${p.segments} 段超过上限 4 段`;
    case "empty-segment": return "链里有空段（\">\" 两侧都必须有 origin）";
    case "not-http-origin": return `值 ${JSON.stringify(clipForDiagnosis(p.segment))} 不是 http(s) origin`
      + "（需要 scheme://host[:port]；about:blank/相对值/其它 scheme 都不支持）";
    case "not-canonical": return `值 ${JSON.stringify(clipForDiagnosis(p.segment))} 不是规范 origin`
      + "（带 path/query 或显式默认端口等；每段必须 v === new URL(v).origin，如 https://a:443 要写 https://a）";
  }
}

function clipForDiagnosis(s: string): string {
  return s.length <= 80 ? s : `${s.slice(0, 77)}...`;
}

/** base 里有未闭合的 `[`：后面的 ` frame:` 落在属性值内部，不是语法后缀（值内伪尾缀）。 */
function hasUnclosedBracket(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === "[") depth += 1;
    else if (ch === "]") depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

