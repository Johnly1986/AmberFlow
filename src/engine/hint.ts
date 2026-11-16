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
  | { kind: "id"; value: string; within?: string[]; frameChain?: string[]; inRow?: string; rowIndex?: number }
  | { kind: "attrSubstr"; tag: string; attr: string; value: string; within?: string[]; frameChain?: string[]; inRow?: string; rowIndex?: number }
  | { kind: "nearToken"; tag: string; token: string; within?: string[]; frameChain?: string[]; inRow?: string; rowIndex?: number }
  | { kind: "attrEq"; tag: string; attr: string; value: string; within?: string[]; frameChain?: string[]; inRow?: string; rowIndex?: number }
  | { kind: "tag"; tag: string; within?: string[]; frameChain?: string[]; inRow?: string; rowIndex?: number }
  | { kind: "bare"; token: string; within?: string[]; frameChain?: string[]; inRow?: string; rowIndex?: number };

/** DOM 属性名的规范形（`test`→`data-test`、`type`→`type`）；池侧用 `poolAttr` 映射回字段名。 */
const DOM_ATTR: Record<string, string> = { test: "data-test", "data-test": "data-test", type: "type" };
const POOL_ATTR: Record<string, string> = { "data-test": "data_test", type: "input_type" };

/** 池侧字段名（`Elem` 的字段，不是 DOM 属性名）。 */
export function poolAttr(attr: string): string {
  return POOL_ATTR[attr] ?? attr;
}

/**
 * **唯一**的 hint 语法解析器（6 种形状 + `within:#id` / `frame:<origin链>` / `in-row:<token>` /
 * `row-index:N` 四类尾缀 + 大小写折叠在这里发生一次）。
 *
 * 规则（与冻结计划的写法一一对应）：
 *   `#id` ｜ `tag[attr~substr]`（含 `[near~token]`）｜ 无括号的 `tag~token`（近邻）｜
 *   `tag[attr=value]`（值去引号）｜ `button|link|input|textarea|select`（角色词）｜ 裸词。
 *
 * E3：尾缀 `within:#id`（可选；E2 起为**语义链** `within:#a1>#a2`——`>` 分隔外→内、≤4 段、
 * 每段 id charset；单层 = 长度 1 链，逐字节兼容）——把命中集限定在锚链子树内。
 * A 批：尾缀 `frame:<origin链>`（可选；`>` 分隔外→内、≤4 段、每段 `v === new URL(v).origin`
 * 的 http(s) 规范形；末段 = 元素所在帧自身 origin，声明链 = 帧完整链的后缀）。
 * F82：尾缀 `in-row:<token>`（可选；行锚——命中集限定到"行上下文文本包含 token"的元素；
 * token 非空/无空白/禁 `>`/≤40 字符；解析只管形状，匹配 = 各观察面的 row_texts 底座）。
 * F83：尾缀 `row-index:N`（可选；顺序行锚——命中集限定到"同 dup 组内 DOM 先序第 N 个成员"；
 * 值 = 1-based 正整数、无前导 0、≤9 位，0/负数/非数字 = 整组回退；匹配 = 各观察面的
 * row_index 底座，整数全等比较；序号即语义的合法场景由作者显式承担序漂移）。
 * 剥离发生在一切形状判定之前；锚只能是 `#id` 链形态（任意 CSS 锚拒绝）。
 *
 * **串尾词法预扫 + 循环剥离**（R2-5）：三类后缀各**至多一次**，只认「前置空白 + 串尾」；
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

/**
 * F82（in-row 行锚，第三类尾缀）：`in-row:` 值被拒的**原因类别**（与 frameChainValueProblem
 * 同位——解析面判合法、诊断面要原因类别）。token 闭集：非空、无空白（`\S+` 词法天然）、
 * 禁 `>`（为未来链语法保留词法余量）、≤40 字符。空格进不了 `\S+` 词法（整组回退的另一路），
 * 这里只判闭集约束本身。
 */
export type InRowValueProblem =
  | { kind: "empty" }
  | { kind: "too-long"; length: number }
  | { kind: "has-gt" };

export function inRowValueProblem(raw: string): InRowValueProblem | null {
  if (raw === "") return { kind: "empty" };
  if (raw.length > 40) return { kind: "too-long", length: raw.length };
  if (raw.includes(">")) return { kind: "has-gt" };
  return null;
}

/** `in-row:` 值解析：合法 = token（小写折叠在调用方做，与 within/frame 值同口径），非法 = null。 */
function parseInRowValue(raw: string): string | null {
  if (inRowValueProblem(raw) !== null) return null;
  return raw;
}

/**
 * F83（row-index 顺序行锚，第四类尾缀）：`row-index:` 值被拒的**原因类别**（与
 * `inRowValueProblem`/`frameChainValueProblem` 同位——解析面判合法、诊断面要原因类别）。
 * 值闭集 = **1-based 正整数**、无前导 0、≤9 位（`^[1-9]\d{0,8}$`——词法卫生 + Number 精确
 * 比较 + 早失败早诊断，v1.0 Q4 仲裁）。类别（v1.0 B 项修正）：`empty` / `not-positive-integer`
 * （0、负数、非数字、带字母、带 `>`、前导 0——**文案必须点名"row-index 从 1 开始"**：0 与
 * 负数是作者常见笔误，拒因要点名而非笼统"非数字"）/ `too-many-digits`（>9 位）。
 * `>` 与带空白由词法天然拒（`\S+` 不收空白；纯数字值不含 `>`——带 `>` 归
 * not-positive-integer），不单设类别。
 */
export type RowIndexValueProblem =
  | { kind: "empty" }
  | { kind: "not-positive-integer"; raw: string }
  | { kind: "too-many-digits"; digits: number };

export function rowIndexValueProblem(raw: string): RowIndexValueProblem | null {
  if (raw === "") return { kind: "empty" };
  if (!/^\d{1,9}$/.test(raw)) {
    if (/^\d{10,}$/.test(raw)) return { kind: "too-many-digits", digits: raw.length };
    return { kind: "not-positive-integer", raw };
  }
  if (raw === "0" || raw.startsWith("0")) return { kind: "not-positive-integer", raw };
  return null;
}

/** `row-index:` 值解析：合法 = 1-based 序号（Number，≤9 位内精确），非法 = null。 */
function parseRowIndexValue(raw: string): number | null {
  if (rowIndexValueProblem(raw) !== null) return null;
  return Number(raw);
}

/**
 * E2（within 语义链）：`within:` 尾缀值 = `#id` 链（`>` 分隔、**外→内**、≤4 段）。
 * 段归一：每段可带可选 `#` 前缀（首段由值形状要求 `#`；后续段 `#a>#b` 与 `#a>b` 两种
 * 写法都归一为 `["a","b"]`——同一链、同一语义，不做第二套形状）。
 * 校验 = 段 charset（`[a-z0-9_\-.:]+`、非空）+ ≤4 段；空段/超限/非法段 ⇒ 非法（调用方
 * **整组回退**：绝不半剥，原始串按旧形状解析 → 落空 = 显式失败）。
 * 单层 `within:#p` = 长度 1 的链（n=1 是自然推广，行为与 E3 单层 membership 逐字节一致）。
 */
export type WithinChainValueProblem =
  | { kind: "too-long"; segments: number }
  | { kind: "empty-segment"; segments: number }
  | { kind: "bad-segment"; segment: string };

/** within 链值的唯一校验（与 frameChainValueProblem 同位：解析面只看"是否合法"，诊断面要原因类别）。 */
export function withinChainValueProblem(raw: string): WithinChainValueProblem | null {
  const segs = raw.toLowerCase().split(">");
  if (segs.length > 4) return { kind: "too-long", segments: segs.length };
  for (const seg of segs) {
    const id = seg.startsWith("#") ? seg.slice(1) : seg;
    if (id === "") return { kind: "empty-segment", segments: segs.length };
    if (!/^[a-z0-9_\-.:]+$/.test(id)) return { kind: "bad-segment", segment: seg };
  }
  return null;
}

/** within 链值解析：合法 = 段数组（**外→内**、小写、`#` 前缀归一剥离），非法 = null。 */
function parseWithinChainValue(raw: string): string[] | null {
  if (withinChainValueProblem(raw) !== null) return null;
  return raw.toLowerCase().split(">").map((seg) => (seg.startsWith("#") ? seg.slice(1) : seg));
}

/** 诊断面的尾缀预扫：与 frame 尾缀同形但允许**空值**（空值 parseHint 同样回退旧形状，
 *  `describeFrameSuffixRejection` 要能点名"frame: 后没有值"）。E2：值 charset 加 `>`
 *  （链分隔符）与 `#`（段首标记——方案 §4.3/M6⑤ 的链写法 `within:#a2>#a1` 每段带 `#`；
 *  词法只管"到串尾"，段的合法性由 withinChainValueProblem 单独判：段内伪 `#`/空段/超限
 *  都在段校验被拒 ⇒ 整组回退——单层无 `>`/无伪 `#` 的旧值逐字节同路径）。 */
const FRAME_TAIL_VALUE_RE = /(?:\s+frame:)(\S*)\s*$/;
/** 诊断面用：within 尾缀词法（与 splitTailSuffixes 内部同形；describe 在小写串上逐段剥离）。 */
const WITHIN_TAIL_RE = /(?:\s+within:)(#[a-z0-9_\-.:#>]+)\s*$/;
/** F82 诊断面用：in-row 尾缀词法（允许**空值**——空值 parseHint 同样回退旧形状，
 *  `describeRowSuffixRejection` 要能点名"in-row: 后没有值"；与 FRAME_TAIL_VALUE_RE 同模式）。 */
const INROW_TAIL_VALUE_RE = /(?:\s+in-row:)(\S*)\s*$/;
/** F83 诊断面用：row-index 尾缀词法（允许**空值**——空值 parseHint 同样回退旧形状，
 *  `describeRowIndexSuffixRejection` 要能点名"row-index: 后没有值"；同上模式）。 */
const ROW_INDEX_TAIL_VALUE_RE = /(?:\s+row-index:)(\S*)\s*$/;

/**
 * 串尾词法预扫 + 循环剥离（A 批 R2-5；C 批 B-1 起导出为**唯一剥离出处**，供 parseHint 与
 * `findByHint` 等旧匹配器共用——N6：防 hint 语法两处漂移）。在**原始大小写**串上做（正则 /i）；
 * 返回 base 保留原串大小写，`within`/frameChain/inRow 值小写规范化，rowIndex 值转数值。
 * F83 起为**四类**后缀（within / frame / in-row / row-index）各 ≤1、只认「前置空白 + 串尾」；
 * 任一类超限/值非法/空段 ⇒ **整组回退**（base = trim 后原串、无后缀字段，绝不半剥）——与
 * parseHint 逐字节同口径。**三类既有分支（within/frame/in-row）逐字节不动**（批 2 纪律），
 * row-index 分支同结构追加（base 空/重复/值非法/伪尾缀 ⇒ 整组 rejected——in-row 的
 * hasUnclosedBracket 伪尾缀守卫同款：base 含未闭合 `[` 时 row-index: 落在属性值里）。
 */
export function splitTailSuffixes(hint: string): { base: string; within?: string[]; frameChain?: string[]; inRow?: string; rowIndex?: number } {
  const WITHIN_TAIL_RE = /(?:\s+within:)(#[a-z0-9_\-.:#>]+)\s*$/i;
  const FRAME_TAIL_RE = /(?:\s+frame:)(\S+)\s*$/i;
  const INROW_TAIL_RE = /(?:\s+in-row:)(\S+)\s*$/i;
  const ROW_INDEX_TAIL_RE = /(?:\s+row-index:)(\S+)\s*$/i;
  let rest = hint.trim();
  let within: string[] | undefined;
  let frameChain: string[] | undefined;
  let inRow: string | undefined;
  let rowIndex: number | undefined;
  let withinSeen = 0;
  let frameSeen = 0;
  let inRowSeen = 0;
  let rowIndexSeen = 0;
  let rejected = false;
  for (;;) {
    const wm = WITHIN_TAIL_RE.exec(rest);
    const fm = wm === null ? FRAME_TAIL_RE.exec(rest) : null;
    const im = wm === null && fm === null ? INROW_TAIL_RE.exec(rest) : null;
    const rm = wm === null && fm === null && im === null ? ROW_INDEX_TAIL_RE.exec(rest) : null;
    if (wm === null && fm === null && im === null && rm === null) break;
    if (wm !== null) {
      const base = rest.slice(0, wm.index).trim();
      if (base === "") { rejected = true; break; }
      withinSeen += 1;
      if (withinSeen > 1) { rejected = true; break; }
      // E2：链值段校验（空段/超限/非法段 ⇒ 整组回退，绝不半剥）——单层 = 长度 1 链。
      const chain = parseWithinChainValue(wm[1]!);
      if (chain === null) { rejected = true; break; }
      within = chain;
      rest = base;
      continue;
    }
    if (fm !== null) {
      const base = rest.slice(0, fm.index).trim();
      if (base === "") { rejected = true; break; }
      frameSeen += 1;
      if (frameSeen > 1) { rejected = true; break; }
      const chain = parseFrameChainValue(fm[1]!.toLowerCase());
      if (chain === null) { rejected = true; break; }
      frameChain = chain;
      rest = base;
      continue;
    }
    if (im !== null) {
      const base = rest.slice(0, im.index).trim();
      if (base === "") { rejected = true; break; }
      if (hasUnclosedBracket(base)) { rejected = true; break; }   // 值内伪尾缀（属性值里的 in-row:）
      inRowSeen += 1;
      if (inRowSeen > 1) { rejected = true; break; }
      const token = parseInRowValue(im[1]!.toLowerCase());
      if (token === null) { rejected = true; break; }
      inRow = token;
      rest = base;
      continue;
    }
    const base = rest.slice(0, rm!.index).trim();
    if (base === "") { rejected = true; break; }
    if (hasUnclosedBracket(base)) { rejected = true; break; }   // 值内伪尾缀（属性值里的 row-index:）
    rowIndexSeen += 1;
    if (rowIndexSeen > 1) { rejected = true; break; }
    const idx = parseRowIndexValue(rm![1]!);
    if (idx === null) { rejected = true; break; }
    rowIndex = idx;
    rest = base;
  }
  if (rejected) return { base: hint.trim() };   // 整组回退：绝不半剥
  return {
    base: rest,
    ...(within !== undefined ? { within } : {}),
    ...(frameChain !== undefined ? { frameChain } : {}),
    ...(inRow !== undefined ? { inRow } : {}),
    ...(rowIndex !== undefined ? { rowIndex } : {}),
  };
}

export function parseHint(hint: string): ParsedHint {
  // 串尾剥离收口在 splitTailSuffixes（唯一出处）；先小写再剥离，与旧实现逐字节同口径。
  const s = splitTailSuffixes(hint.toLowerCase());
  const rest = s.base;
  const within = s.within;
  const frameChain = s.frameChain;
  const inRow = s.inRow;
  const rowIndex = s.rowIndex;
  const withSuffix = <T extends ParsedHint>(p: T): T => {
    let q = p;
    if (within !== undefined) q = { ...q, within } as T;
    if (frameChain !== undefined) q = { ...q, frameChain } as T;
    if (inRow !== undefined) q = { ...q, inRow } as T;
    if (rowIndex !== undefined) q = { ...q, rowIndex } as T;
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
 * 判定与 parseHint **同一条词法预扫**（`\s+` + 串尾；within 只认 `#...` 链、frame 值可为空串——
 * 空值 parseHint 会按旧形状回退，这里也要能点名；E2：within 链值段校验（空段/超限/非法段）
 * 与 parseWithinChainValue 共用同一判定）。**只报 frame 相关**：只重复 within 的问题
 * 不归本函数（它没有 frame: 可说），但"frame: 合法却因同串 within 问题被整组回退"要报——
 * 那正是 frame: 静默失效的一条。
 */
export function describeFrameSuffixRejection(hint: string): string | null {
  // 合法（含与 within 组合）＝ parseHint 已接受，没有"被拒绝"可报。
  if (parseHint(hint).frameChain !== undefined) return null;
  const h = hint.trim().toLowerCase();
  // E6（BACKLOG #8 / WITHIN_PARITY_PLAN §8）：**整串 `frame:<origin>`、首词即 frame:**
  // （无前导空白主体，如 `frame:https://a.com`）——词法预扫只认「前置空白 + 串尾」，
  // 这种串根本进不了下面的循环（`frame:` 在串首），旧实现于是不点名"缺少主体"。
  // 这里显式补同一条措辞的诊断（仍是失败路径附注，不改 parseHint 的解析结果）。
  // 守卫：带未闭合 `[` 时 `frame:` 可能落在属性值内部（`[data-x=frame:o]` 一类形状），
  // 与循环里同一条守卫——不把它当后缀尝试，防误报。
  if (h.startsWith("frame:") && !hasUnclosedBracket(h)) {
    return frameRejectionText("尾缀前没有 hint 主体（必须写成 `<hint> frame:<origin>`）");
  }
  let rest = h;
  let frameSeen = 0;
  let withinSeen = 0;
  let frameProblem: string | null = null;
  /** E2：within 侧被拒原因（链形：空段/超限/非法段；重复/缺主体沿用 blockedByWithin 布尔）。 */
  let withinProblem: string | null = null;
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
      else {
        // E2：链值段校验同批（词法收下但段非法 = 整组回退——诊断点名链形原因）。
        const problem = withinChainValueProblem(wm[1]!);
        if (problem !== null) { withinProblem = withinChainProblemText(problem); blockedByWithin = true; }
      }
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
  if (frameProblem !== null) return frameRejectionText(frameProblem);
  if (frameSeen > 0 && blockedByWithin) {
    if (withinProblem !== null) {
      return `frame: 尾缀未被应用（同一串的 within: 尾缀值非法：${withinProblem}——R2-5 整组回退：`
        + "任一类后缀超限/非法则所有后缀都不应用）——修法：把 within: 链写合法（每段 #id、"
        + "`>` 分隔外→内、≤4 段、无空段）后 frame: 才会生效";
    }
    return "frame: 尾缀未被应用（同一串的 within: 尾缀重复或缺少 hint 主体——R2-5 整组回退："
      + "任一类后缀超限/非法则所有后缀都不应用）——修法：去掉重复/孤立的 within: 后 frame: 才会生效";
  }
  return null;
}

/** 单一措辞出处：frame 尾缀为何未被应用 + 修法（无 frameProblem 的路径不经过这里）。 */
function frameRejectionText(problem: string): string {
  return `frame: 尾缀未被应用（${problem}）——整串按旧形状解析，目标大概率落空`
    + `（命令步 target_not_found / 会话 act 零命中）。修法：写成 \`<hint> frame:<http(s)://host[:port]>\`，`
    + `\`>\` 链 ≤4 段、每段用规范 origin（不带 path/query/显式默认端口），且一条 hint 只能有一个 frame: 尾缀`;
}

/**
 * F82（in-row 行锚）：**串尾 ` in-row:<token>` 形状的尝试未被 parseHint 接受**时，给一行
 * 可行动原因；没有尝试 / 已合法接受 = null。与 `describeFrameSuffixRejection` 同构（同一
 * 消费面：executor 的 target_not_found reason + 会话 act reason——经 extraction 的
 * rowHintFailureEvidence 单点接线）。
 *
 * 判定与 parseHint **同一条词法预扫**：in-row 值可为空串（空值 parseHint 按旧形状回退，
 * 这里要能点名"in-row: 后没有值"）；值闭集校验（空/超 40/含 `>`）与 `inRowValueProblem`
 * 共用同一判定。**只报 in-row 相关**：只重复 within/frame 的问题不归本函数，但"in-row: 合法
 * 却因同串 within/frame 问题被整组回退"要报——那正是 in-row: 静默失效的一条。值内伪尾缀
 * （base 含未闭合 `[`，如 `tag[attr=x in-row:o]`）不报——那是属性值，不是后缀尝试
 * （与 frame 版同一条守卫；parseHint 侧同样按伪尾缀整组回退，见 splitTailSuffixes）。
 */
export function describeRowSuffixRejection(hint: string): string | null {
  // 合法（含与 within/frame 组合）＝ parseHint 已接受，没有"被拒绝"可报。
  if (parseHint(hint).inRow !== undefined) return null;
  const h = hint.trim().toLowerCase();
  // 整串 `in-row:<token>`、首词即 in-row:（无前导空白主体）——词法预扫只认「前置空白 + 串尾」，
  // 这种串进不了下面的循环；显式补同一条措辞的诊断（不改 parseHint 的解析结果）。
  // 守卫：带未闭合 `[` 时 in-row: 可能落在属性值内部——不把它当后缀尝试，防误报。
  if (h.startsWith("in-row:") && !hasUnclosedBracket(h)) {
    return rowRejectionText("尾缀前没有 hint 主体（必须写成 `<hint> in-row:<token>`）");
  }
  let rest = h;
  let inRowSeen = 0;
  let withinSeen = 0;
  let frameSeen = 0;
  let inRowProblem: string | null = null;
  /** 同串 within/frame 侧被拒原因（导致整组回退——in-row: 合法也被连坐，必须点名）。 */
  let otherProblem: string | null = null;
  for (;;) {
    const wm = WITHIN_TAIL_RE.exec(rest);
    const fm = wm === null ? FRAME_TAIL_VALUE_RE.exec(rest) : null;
    const im = wm === null && fm === null ? INROW_TAIL_VALUE_RE.exec(rest) : null;
    if (wm === null && fm === null && im === null) break;
    const base = rest.slice(0, (wm ?? fm ?? im)!.index).trim();
    if (wm !== null) {
      withinSeen += 1;
      if (base === "" || withinSeen > 1) otherProblem = "within: 尾缀重复或缺少 hint 主体";
      else {
        const problem = withinChainValueProblem(wm[1]!);
        if (problem !== null) otherProblem = `within: 尾缀值非法（${withinChainProblemText(problem)}）`;
      }
      if (base === "") break;
      rest = base;
      continue;
    }
    if (fm !== null) {
      if (hasUnclosedBracket(base)) break;   // 值内伪尾缀：不误报
      frameSeen += 1;
      if (base === "") { otherProblem = "frame: 尾缀前没有 hint 主体"; break; }
      if (frameSeen > 1) { otherProblem = "frame: 尾缀重复（至多一次）"; break; }
      const problem = frameChainValueProblem(fm![1]!);
      if (problem !== null) { otherProblem = `frame: 尾缀值非法（${frameChainProblemText(problem)}）`; break; }
      rest = base;
      continue;
    }
    if (hasUnclosedBracket(base)) break;   // 值内伪尾缀：不误报（与 parseHint 同口径整组回退，非后缀尝试）
    inRowSeen += 1;
    const raw = im![1]!;
    if (base === "") {
      inRowProblem = "尾缀前没有 hint 主体（必须写成 `<hint> in-row:<token>`）";
      break;
    }
    if (inRowSeen > 1) {
      inRowProblem = "同一串出现多个 in-row: 尾缀（至多一次；整组后缀都不应用）";
      break;
    }
    const problem = inRowValueProblem(raw);
    if (problem !== null) { inRowProblem = inRowProblemText(problem); break; }
    rest = base;
  }
  if (inRowProblem !== null) return rowRejectionText(inRowProblem);
  if (inRowSeen > 0 && otherProblem !== null) {
    return `in-row: 尾缀未被应用（同一串的 ${otherProblem}——R2-5 整组回退：`
      + "任一类后缀超限/非法则所有后缀都不应用）——修法：把该尾缀写合法后 in-row: 才会生效";
  }
  return null;
}

/** 单一措辞出处：in-row 尾缀为何未被应用 + 修法（无 inRowProblem 的路径不经过这里）。 */
function rowRejectionText(problem: string): string {
  return `in-row: 尾缀未被应用（${problem}）——整串按旧形状解析，目标大概率落空`
    + `（命令步 target_not_found / 会话 act 零命中）。修法：写成 \`<hint> in-row:<token>\`，`
    + `token 非空、无空白、禁 ">"、≤40 字符，且一条 hint 只能有一个 in-row: 尾缀`;
}

/** in-row 值问题的人话（有界：值的展示 ≤80 字符）。 */
function inRowProblemText(p: InRowValueProblem): string {
  switch (p.kind) {
    case "empty": return "in-row: 后没有值";
    case "too-long": return `token ${p.length} 字符超过上限 40`;
    case "has-gt": return "token 含 \">\"（链语法保留字符；行锚 token 不允许）";
  }
}

/**
 * F83（row-index 顺序行锚）：**串尾 ` row-index:N` 形状的尝试未被 parseHint 接受**时，给
 * 一行可行动原因；没有尝试 / 已合法接受 = null。与 `describeRowSuffixRejection` 同构
 * （同一消费面：executor 的 target_not_found reason + 会话 act reason——经 extraction 的
 * frameHintFailureEvidence 单点接线）。
 *
 * 判定与 parseHint **同一条词法预扫**：row-index 值可为空串（空值 parseHint 按旧形状回退，
 * 这里要能点名"row-index: 后没有值"）；值闭集校验（empty / not-positive-integer〔文案点名
 * "row-index 从 1 开始"〕 / too-many-digits）与 `rowIndexValueProblem` 共用同一判定。
 * **只报 row-index 相关**：只重复 within/frame/in-row 的问题不归本函数，但"row-index: 合法
 * 却因同串其它尾缀问题被整组回退"要报——那正是 row-index: 静默失效的一条。值内伪尾缀
 * （base 含未闭合 `[`）不报——那是属性值，不是后缀尝试（与 frame/in-row 版同一条守卫）。
 */
export function describeRowIndexSuffixRejection(hint: string): string | null {
  // 合法（含与 within/frame/in-row 组合）＝ parseHint 已接受，没有"被拒绝"可报。
  if (parseHint(hint).rowIndex !== undefined) return null;
  const h = hint.trim().toLowerCase();
  // 整串 `row-index:N`、首词即 row-index:（无前导空白主体）——词法预扫只认「前置空白 + 串尾」，
  // 这种串进不了下面的循环；显式补同一条措辞的诊断（不改 parseHint 的解析结果）。
  // 守卫：带未闭合 `[` 时 row-index: 可能落在属性值内部——不把它当后缀尝试，防误报。
  if (h.startsWith("row-index:") && !hasUnclosedBracket(h)) {
    return rowIndexRejectionText("尾缀前没有 hint 主体（必须写成 `<hint> row-index:N`）");
  }
  let rest = h;
  let rowIndexSeen = 0;
  let withinSeen = 0;
  let frameSeen = 0;
  let inRowSeen = 0;
  let rowIndexProblem: string | null = null;
  /** 同串 within/frame/in-row 侧被拒原因（导致整组回退——row-index: 合法也被连坐，必须点名）。 */
  let otherProblem: string | null = null;
  for (;;) {
    const wm = WITHIN_TAIL_RE.exec(rest);
    const fm = wm === null ? FRAME_TAIL_VALUE_RE.exec(rest) : null;
    const im = wm === null && fm === null ? INROW_TAIL_VALUE_RE.exec(rest) : null;
    const rm = wm === null && fm === null && im === null ? ROW_INDEX_TAIL_VALUE_RE.exec(rest) : null;
    if (wm === null && fm === null && im === null && rm === null) break;
    const base = rest.slice(0, (wm ?? fm ?? im ?? rm)!.index).trim();
    if (wm !== null) {
      withinSeen += 1;
      if (base === "" || withinSeen > 1) otherProblem = "within: 尾缀重复或缺少 hint 主体";
      else {
        const problem = withinChainValueProblem(wm[1]!);
        if (problem !== null) otherProblem = `within: 尾缀值非法（${withinChainProblemText(problem)}）`;
      }
      if (base === "") break;
      rest = base;
      continue;
    }
    if (fm !== null) {
      if (hasUnclosedBracket(base)) break;   // 值内伪尾缀：不误报
      frameSeen += 1;
      // 值问题只记不break（与 within 分支同法）——继续剥是为了回答"这一串里 row-index: 有没有
      // 被连坐"（row-index: 合法但 frame: 值非法 ⇒ 整组回退，必须点名根因）。
      if (base === "") { otherProblem = "frame: 尾缀前没有 hint 主体"; }
      else if (frameSeen > 1) { otherProblem = "frame: 尾缀重复（至多一次）"; }
      else {
        const problem = frameChainValueProblem(fm![1]!);
        if (problem !== null) otherProblem = `frame: 尾缀值非法（${frameChainProblemText(problem)}）`;
      }
      if (base === "") break;
      rest = base;
      continue;
    }
    if (im !== null) {
      if (hasUnclosedBracket(base)) break;   // 值内伪尾缀：不误报
      inRowSeen += 1;
      // 值问题只记不break（同上——in-row: 非法连坐 row-index: 时点名根因）。
      if (base === "") { otherProblem = "in-row: 尾缀前没有 hint 主体"; }
      else if (inRowSeen > 1) { otherProblem = "in-row: 尾缀重复（至多一次）"; }
      else {
        const problem = inRowValueProblem(im![1]!);
        if (problem !== null) otherProblem = `in-row: 尾缀值非法（${inRowProblemText(problem)}）`;
      }
      if (base === "") break;
      rest = base;
      continue;
    }
    if (hasUnclosedBracket(base)) break;   // 值内伪尾缀：不误报（与 parseHint 同口径整组回退，非后缀尝试）
    rowIndexSeen += 1;
    const raw = rm![1]!;
    if (base === "") {
      rowIndexProblem = "尾缀前没有 hint 主体（必须写成 `<hint> row-index:N`）";
      break;
    }
    if (rowIndexSeen > 1) {
      rowIndexProblem = "同一串出现多个 row-index: 尾缀（至多一次；整组后缀都不应用）";
      break;
    }
    const problem = rowIndexValueProblem(raw);
    if (problem !== null) { rowIndexProblem = rowIndexProblemText(problem); break; }
    rest = base;
  }
  if (rowIndexProblem !== null) return rowIndexRejectionText(rowIndexProblem);
  if (rowIndexSeen > 0 && otherProblem !== null) {
    return `row-index: 尾缀未被应用（同一串的 ${otherProblem}——R2-5 整组回退：`
      + "任一类后缀超限/非法则所有后缀都不应用）——修法：把该尾缀写合法后 row-index: 才会生效";
  }
  return null;
}

/** 单一措辞出处：row-index 尾缀为何未被应用 + 修法（无 rowIndexProblem 的路径不经过这里）。 */
function rowIndexRejectionText(problem: string): string {
  return `row-index: 尾缀未被应用（${problem}）——整串按旧形状解析，目标大概率落空`
    + `（命令步 target_not_found / 会话 act 零命中）。修法：写成 \`<hint> row-index:N\`，`
    + `N 是 1-based 正整数（无前导 0、≤9 位），且一条 hint 只能有一个 row-index: 尾缀`;
}

/** row-index 值问题的人话（有界：值的展示 ≤80 字符；0/负数点名"从 1 开始"——v1.0 B 项口径）。 */
function rowIndexProblemText(p: RowIndexValueProblem): string {
  switch (p.kind) {
    case "empty": return "row-index: 后没有值";
    case "not-positive-integer": return `值 ${JSON.stringify(clipForDiagnosis(p.raw))} 不是合法序号`
      + "——row-index 从 1 开始（1-based 正整数、无前导 0）";
    case "too-many-digits": return `值 ${p.digits} 位超过上限 9 位`;
  }
}

/** within 链值问题的人话（有界：段的展示 ≤80 字符）。 */
function withinChainProblemText(p: WithinChainValueProblem): string {
  switch (p.kind) {
    case "too-long": return `声明 ${p.segments} 段超过上限 4 段`;
    case "empty-segment": return "链里有空段（\">\" 两侧都必须有 #id）";
    case "bad-segment": return `段 ${JSON.stringify(clipForDiagnosis(p.segment))} 不是 #id 形态`
      + "（每段只能是 id 字符 [a-z0-9_.:-]，段首 # 可选；任意 CSS 锚拒绝）";
  }
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

