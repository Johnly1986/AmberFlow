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
/** `frame:` 值校验（§12.3 R2-1）：`>` 分隔 origin 链、≤4 段、每段 `v === new URL(v).origin`
 *  且是 http/https 规范形（带 path/query/显式默认端口/about:blank/ftp 都拒绝）。非法 = null。 */
function parseFrameChainValue(raw: string): string[] | null {
  const segs = raw.split(">");
  if (segs.length === 0 || segs.length > 4) return null;
  const out: string[] = [];
  for (const seg of segs) {
    if (seg === "") return null;                    // 空段
    let origin: string;
    try { origin = new URL(seg).origin; } catch { return null; }
    if (origin === "null") return null;             // about:blank / file 等非 http(s)
    if (!origin.startsWith("http://") && !origin.startsWith("https://")) return null;
    if (seg !== origin) return null;                // 带 path/query/显式默认端口等非规范形
    out.push(origin);
  }
  return out;
}

const WITHIN_TAIL_RE = /(?:\s+within:)(#[a-z0-9_\-.:]+)\s*$/;
const FRAME_TAIL_RE = /(?:\s+frame:)(\S+)\s*$/;

export function parseHint(hint: string): ParsedHint {
  const h = hint.trim().toLowerCase();
  // 串尾词法预扫：从串尾反复剥离两类后缀（同一串尾位置字面前缀不同，不可能同时匹配）。
  let rest = h;
  let within: string | undefined;
  let frameChain: string[] | undefined;
  let withinSeen = 0;
  let frameSeen = 0;
  let suffixRejected = false;
  for (;;) {
    const wm = WITHIN_TAIL_RE.exec(rest);
    const fm = wm === null ? FRAME_TAIL_RE.exec(rest) : null;
    if (wm === null && fm === null) break;
    if (wm !== null) {
      const base = rest.slice(0, wm.index).trim();
      if (base === "") { suffixRejected = true; break; }
      withinSeen += 1;
      if (withinSeen > 1) { suffixRejected = true; break; }
      within = wm[1]!.slice(1);
      rest = base;
      continue;
    }
    const base = rest.slice(0, fm!.index).trim();
    if (base === "") { suffixRejected = true; break; }
    frameSeen += 1;
    if (frameSeen > 1) { suffixRejected = true; break; }
    const chain = parseFrameChainValue(fm![1]!);
    if (chain === null) { suffixRejected = true; break; }   // 值非法/空段/超限 ⇒ 整组拒绝
    frameChain = chain;
    rest = base;
  }
  if (suffixRejected) {
    // 整组回退：两类后缀都不应用，按原始串解析（绝不半剥）。
    within = undefined;
    frameChain = undefined;
    rest = h;
  }
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

