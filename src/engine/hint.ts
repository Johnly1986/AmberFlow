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
  | { kind: "id"; value: string }
  | { kind: "attrSubstr"; tag: string; attr: string; value: string }
  | { kind: "nearToken"; tag: string; token: string }
  | { kind: "attrEq"; tag: string; attr: string; value: string }
  | { kind: "tag"; tag: string }
  | { kind: "bare"; token: string };

/** DOM 属性名的规范形（`test`→`data-test`、`type`→`type`）；池侧用 `poolAttr` 映射回字段名。 */
const DOM_ATTR: Record<string, string> = { test: "data-test", "data-test": "data-test", type: "type" };
const POOL_ATTR: Record<string, string> = { "data-test": "data_test", type: "input_type" };

/** 池侧字段名（`Elem` 的字段，不是 DOM 属性名）。 */
export function poolAttr(attr: string): string {
  return POOL_ATTR[attr] ?? attr;
}

/**
 * **唯一**的 hint 语法解析器（6 种形状 + 大小写折叠在这里发生一次）。
 *
 * 规则（与冻结计划的写法一一对应）：
 *   `#id` ｜ `tag[attr~substr]`（含 `[near~token]`）｜ 无括号的 `tag~token`（近邻）｜
 *   `tag[attr=value]`（值去引号）｜ `button|link|input|textarea|select`（角色词）｜ 裸词。
 *
 * 注意：解析只管**形状**。属性名是否在池子的字段模型里、值怎么比（精确/包含/按路径段分档）
 * 是各观察面自己的事——那部分差异是设计（池子是投影，DOM 是活页面），不是漂移。
 */
export function parseHint(hint: string): ParsedHint {
  const h = hint.trim().toLowerCase();
  if (h.startsWith("#")) return { kind: "id", value: h.slice(1) };
  if (h.includes("[") && h.split("[", 2)[1]!.includes("~")) {
    const tag = h.slice(0, h.indexOf("["));
    const rest = h.slice(h.indexOf("[") + 1).replace(/\]$/, "");
    const tilde = rest.indexOf("~");
    return { kind: "attrSubstr", tag, attr: DOM_ATTR[rest.slice(0, tilde)] ?? rest.slice(0, tilde), value: rest.slice(tilde + 1) };
  }
  if (h.split("[").pop()!.includes("~")) {
    const tag = h.slice(0, h.indexOf("[") >= 0 ? h.indexOf("[") : 0);
    const after = h.includes("[") ? h.slice(h.indexOf("[") + 1) : h;
    return { kind: "nearToken", tag, token: after.replace(/\]$/, "").split("~").slice(-1)[0]! };
  }
  if (h.includes("[")) {
    const tag = h.slice(0, h.indexOf("["));
    const rest = h.slice(h.indexOf("[") + 1);
    const eq = rest.indexOf("=");
    const attr = DOM_ATTR[eq >= 0 ? rest.slice(0, eq) : rest] ?? (eq >= 0 ? rest.slice(0, eq) : rest);
    const value = (eq >= 0 ? rest.slice(eq + 1) : "").replace(/\]$/, "").replace(/^['"]|['"]$/g, "");
    return { kind: "attrEq", tag, attr, value };
  }
  if (["button", "link", "input", "textarea", "select"].includes(h)) return { kind: "tag", tag: h };
  return { kind: "bare", token: h };
}

