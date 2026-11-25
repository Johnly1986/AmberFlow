/**
 * ARIA 视图的**解析与身份对齐**（`criteriaView` 的模型面判据底座）。
 *
 * Playwright `ariaSnapshot()` 的每一行是 YAML：`- <key>: <value>` / `- <key>`。key 由
 * Playwright 从 `role + " " + JSON.stringify(name)` 拼出，再按 YAML 规则**按需**用单引号
 * 包住（名字里含 `": "` / `" #"` / 大括号等时）；单引号内的 `'` 双写转义，双引号/反斜杠
 * 由 JSON 转义。这里把「role 与 name 的还原」与「池行 ↔ 行的身份对齐」收在一处，因为
 * 两者是同一条判据的两半：name 还原错（截断/串位）会让对齐判据误判，反之对齐判据
 * 依赖 name 的正确性。
 *
 * 为什么对齐必须是**逐项身份**而不是计数：`ariaLines.length === 池大小` 只说明两边数量
 * 巧合相等。页面一有 `aria-hidden` 子树、嵌套控件、被窗口挤出的元素，位置就可能错配；
 * 错配后模型看到的是**另一个元素的 role/name**，选错也不会产生任何信号。所以无法逐项
 * 确认时**刻意降级**到 `tag "label"`（宁可少给 role 语义，也不给错的身份）——降级是
 * 设计决定，不是兜底。
 */
import type { Elem } from "./elem-model.ts";

/** 一条交互行：`[role, name]`（name 为空串 = 该行没有可还原的名字）。 */
export type AriaLine = [role: string, name: string];

/** 行首 `- `（缩进由 aria 树的层级决定；层级本身对池对齐无意义）。 */
const LINE_MARK_RE = /^\s*-\s+/;

/**
 * 键在 YAML 里的映射冒号：`:` 后必须紧跟空白或行尾。
 * Playwright 对含 `": "` 的键必然加单引号，所以裸键里不会出现 `": "`——这条判据只在
 * 「名字以 `:` 结尾」时有歧义，而那种形态下冒号后面紧跟的是 JSON 的收尾双引号，不匹配。
 */
const KEY_COLON_RE = /:(?:\s|$)/;

/** role 与 name 之间的分隔（key = `role + " " + JSON.stringify(name)`）。 */
const ROLE_NAME_SEP = " ";

/** 从 `- <key>: <value>` 里取出 key 文本（去掉 YAML 的单引号包裹并还原 `''`）。 */
function keyTextOf(line: string): string | null {
  const mark = LINE_MARK_RE.exec(line);
  if (mark === null) return null;
  const rest = line.slice(mark[0].length);
  if (rest.startsWith("'")) {
    // YAML 单引号标量：内部 `''` = 一个字面单引号；闭合引号之后是映射冒号/属性/行尾。
    let text = "";
    for (let i = 1; i < rest.length; i += 1) {
      const ch = rest[i]!;
      if (ch !== "'") { text += ch; continue; }
      if (rest[i + 1] === "'") { text += "'"; i += 1; continue; }
      return text;
    }
    return null;   // 未闭合：不猜（宁可丢这一行，也不给出错位的 role/name）
  }
  const colon = KEY_COLON_RE.exec(rest);
  return (colon === null ? rest : rest.slice(0, colon.index)).trimEnd();
}

/**
 * 解析一条 aria 行：只收 `roles` 闭集内的 role（`text:` / `heading` / `/url:` 等不是交互
 * 叶子，必须原样忽略）；name 从 key 里 JSON 字符串还原，转义还原失败/形态不认识时
 * **退化为空 name**——截断的错误名字比空缺更糟（它会被拼进模型提示词）。
 *
 * 支持的 name 形态 = Playwright `renderAriaTree` 用 `JSON.stringify` 产出的形态（裸键与
 * 单引号键都走同一还原）；不支持的形态：`renderStringsAsRegex` 的 `/…/` 正则串（本仓不启用
 * 该模式，`ariaSnapshot()` 缺省模式恒为普通字符串）、name 超 900 字符（Playwright 直接
 * 不写 name，行里只剩 role）、以及非 Playwright 渲染的任意 YAML 方言。
 */
export function parseAriaInteractiveLine(line: string, roles: ReadonlySet<string>): AriaLine | null {
  const key = keyTextOf(line);
  if (key === null) return null;
  const sep = key.indexOf(ROLE_NAME_SEP);
  const role = sep < 0 ? key : key.slice(0, sep);
  if (!roles.has(role)) return null;
  if (sep < 0) return [role, ""];
  // role 之后只可能是 JSON 字符串（+ `[checked]` 之类属性后缀）；其余形态不猜 name。
  const tail = key.slice(sep + 1);
  if (!tail.startsWith('"')) return [role, ""];
  let end = -1;
  for (let i = 1; i < tail.length; i += 1) {
    if (tail[i] === "\\") { i += 1; continue; }
    if (tail[i] === '"') { end = i; break; }
  }
  if (end < 0) return [role, ""];
  try {
    const parsed: unknown = JSON.parse(tail.slice(0, end + 1));
    return [role, typeof parsed === "string" ? parsed.trim() : ""];
  } catch {
    return [role, ""];
  }
}

/** `input` 的 type → Playwright 渲染出的交互 role（缺省 type / 未知 type 浏览器一律按 text）。 */
const INPUT_TYPE_ROLES: Readonly<Record<string, string[]>> = {
  search: ["searchbox"],
  number: ["spinbutton"],
  checkbox: ["checkbox"],
  radio: ["radio"],
  range: ["slider"],
  file: ["button"],
  submit: ["button"],
  reset: ["button"],
  button: ["button"],
  image: ["button"],
};

/**
 * 池行 **自己** 在 aria 树里应当是哪个 role（用于对齐的身份校验）。
 *
 * 返回 `null` = 从 Elem 侧映射不出来（自绘容器 `div[onclick]`、`contenteditable`、
 * 关联/游离 `label`、`summary`、伪按钮…）：这类行只做 name 校验，不拿 role 硬套。
 * 显式 `role` 属性优先（Playwright 同口径：presentation/none 之外以显式 role 为准）。
 */
export function expectedAriaRoles(e: Elem): string[] | null {
  const explicit = (e.role ?? "").toLowerCase();
  if (explicit) return [explicit];
  const tag = e.tag.toLowerCase();
  if (tag === "a") return e.href ? ["link"] : null;
  if (tag === "button") return ["button"];
  if (tag === "textarea") return ["textbox"];
  // 多选 select 渲染成 listbox、单选渲染成 combobox；`multiple` 不在池行字段里，
  // 两种形态都收（同一 tag 的 role 身份仍然成立，且不会把别的 tag 混进来）。
  if (tag === "select") return ["combobox", "listbox"];
  if (tag !== "input") return null;
  const type = (e.input_type ?? "text").toLowerCase();
  if (type === "hidden") return null;   // 隐藏控件不渲染 aria 叶子，无从对齐
  return INPUT_TYPE_ROLES[type] ?? ["textbox"];
}

/**
 * name 是否与池行 label 相容：完全相等优先；一方为空 = 无从反驳（空 label 的元素仍走
 * 既有的"采纳 aria name"分支）；都非空时要求**互相包含**——aria name 会把后代文本、
 * 徽标计数折进来（实测 `"商品卡片 Alpha" → "商品卡片 Alpha 加入购物车"`），而毫无重叠的
 * 两个非空 name 只能是两个不同的元素。
 */
function nameCompatible(ours: string, ariaName: string): boolean {
  if (ours === ariaName) return true;
  if (ours === "" || ariaName === "") return true;
  return ariaName.includes(ours) || ours.includes(ariaName);
}

/**
 * 池↔aria 行是否**逐项**同一（数量相等只是必要条件）。
 *
 * 两条身份信号按可信度分工：
 *   - **role**（`expectedAriaRoles`，来自 tag/input_type/显式 role）是硬信号：能映射出 role
 *     的行必须同 role，否则判错配——单靠这一条就能抓住「真链接被渲染成 button」那类错位。
 *   - **name** is 软信号：池 label 与 aria name 的取法不同（label 链含 `title`/包装文本，
 *     aria name 只取无障碍名），两者无重叠**不足以**否定对齐（实测 Wikipedia 语言列表：
 *     同一 `<a>` 的 label 是 title 全文、aria name 是可见文案）。只有「该 aria name 恰好是
 *     **另一个**池行的 label」才是错位证据；而在 role 映射不出来的行（自绘容器/伪按钮）上
 *     name 是唯一信号，冲突直接判错配。
 *
 * `ordered` 必须与 `ariaInteractiveLines` 同序（DOM/scan 升序），含被 forbidden 排除的元素
 * ——它们同样占着一行 aria，不能跳过。
 */
export function ariaLinesAligned(ordered: ReadonlyArray<readonly [string, Elem]>, lines: readonly AriaLine[]): boolean {
  if (lines.length !== ordered.length) return false;
  // 名字 → 池行下标（错位证据的底座；只在真的出现 name 冲突时才查，非冲突页零成本）。
  const labelIndex = new Map<string, number[]>();
  ordered.forEach(([, e], i) => {
    if (!e.label) return;
    const hits = labelIndex.get(e.label);
    if (hits === undefined) labelIndex.set(e.label, [i]);
    else hits.push(i);
  });
  for (let i = 0; i < ordered.length; i += 1) {
    const [role, ariaName] = lines[i]!;
    const e = ordered[i]![1];
    const expected = expectedAriaRoles(e);
    if (expected !== null && !expected.includes(role)) return false;
    if (ariaName === "" || e.label === "" || nameCompatible(e.label, ariaName)) continue;
    // 名字互不包含：无 role 证据的行直接判错配；有 role 证据的行只在「是别的池行的名字」
    // 时判错配（这才是位置串位的证据）。
    if (expected === null) return false;
    const others = labelIndex.get(ariaName) ?? [];
    if (others.some((j) => j !== i)) return false;
  }
  return true;
}
