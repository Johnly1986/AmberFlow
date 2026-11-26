/**
 * 会话 `extract` 的 `fields` 闭集：属性白名单（纯数据）+ 校验/规范化（纯函数）。
 *
 * 为什么需要闭集：`@` 取属性把任意串直接交给 `getAttribute` 时，不存在的名字（`@innerText`
 * 是 DOM **属性**、不是 HTML **属性**）静默返回空串——于是「页面没内容」与「字段名写错」
 * 在响应里长得一模一样，排查成本极高。白名单把后者变成入口处的结构化问题。
 *
 * 边界：本模块只回答「这个字段写法合法吗」与「规范化后的字段表」，不产出会话响应、
 * 不碰页面。{@link EXTRACT_ATTR_WHITELIST} 是可枚举的纯数组，调用方可以自行格式化错误
 * 文案；{@link extractFieldsReason} 是同一份文案的单一出处（会话面复用，桥面/CLI 也可用）。
 */

/**
 * `@self`：**伪属性** = 该行元素自身的可见文本（`innerText`，trim；与字段值 `"."` 同义）。
 *
 * 为什么要有它：「这一行的文本」是抽取刚需，而 `innerText` 是 DOM 属性不是 HTML 属性，
 * 没有合法属性名可用。给它一个正式名字并登记进白名单，比放开任意 `@xxx` 或让人猜 `"."`
 * 更省事；归一实现 = 会话面把它翻成既有 `"."`（抽取语义零新增，`ctx.readRows` 的
 * `"."`/`":scope"` 分支就是行 `innerText`）。
 * 不带 `@` 的裸 `self` **不**作为别名：那在既有形状里是合法 CSS 类型选择器（`<self>` 元素），
 * 占用它会静默改掉老请求的语义。
 */
export const EXTRACT_FIELD_SELF = "@self";

/**
 * `@` 取属性的**唯一白名单**（真实 HTML 属性名，小写）。
 *
 * 口径：HTML 属性名**大小写不敏感**（校验前统一小写）；`data-*` 是标准允许的作者自定义族
 * （无法枚举，按前缀认，见 {@link isExtractableAttr}）；事件处理器内容属性按 `on<event>`
 * 常见名枚举。非标准框架属性（如 `jsaction`）不在表内——这是**有意**的 fail-closed：
 * 真需要的名字走 `read {what:"attr"}` 单独取，而不是让 `@` 的名字面无限开放。
 */
export const EXTRACT_ATTR_WHITELIST: readonly string[] = (() => {
  const groups: readonly (readonly string[])[] = [
    // 全局属性（所有元素可用）
    ["accesskey", "autocapitalize", "autocorrect", "autofocus", "class", "contenteditable",
      "dir", "draggable", "enterkeyhint", "exportparts", "hidden", "id", "inert", "inputmode",
      "is", "itemid", "itemprop", "itemref", "itemscope", "itemtype", "lang", "nonce", "part",
      "popover", "role", "slot", "spellcheck", "style", "tabindex", "title", "translate",
      "virtualkeyboardpolicy", "writingsuggestions"],
    // 链接/资源（a / area / link / base）
    ["href", "hreflang", "rel", "rev", "target", "download", "ping", "referrerpolicy", "media",
      "as", "crossorigin", "integrity", "charset", "shape", "coords", "sizes", "type"],
    // 媒体 / 内嵌（img / source / video / audio / track / iframe / embed / object）
    ["src", "srcset", "alt", "width", "height", "loading", "decoding", "fetchpriority", "ismap",
      "usemap", "longdesc", "controls", "autoplay", "loop", "muted", "preload", "poster",
      "playsinline", "kind", "srclang", "default", "mediagroup", "srcdoc", "sandbox", "allow",
      "allowfullscreen", "frameborder", "marginwidth", "marginheight", "scrolling", "data"],
    // 表单 / 控件（form / input / button / select / option / optgroup / textarea / label）
    ["action", "method", "enctype", "accept-charset", "novalidate", "form", "formaction",
      "formenctype", "formmethod", "formnovalidate", "formtarget", "name", "value", "disabled",
      "readonly", "required", "checked", "placeholder", "maxlength", "minlength", "min", "max",
      "step", "pattern", "size", "multiple", "autocomplete", "list", "accept", "capture",
      "dirname", "for", "rows", "cols", "wrap", "selected", "label", "open"],
    // 表格（table / td / th / col / ol / li 等）
    ["colspan", "rowspan", "headers", "scope", "abbr", "summary", "span", "nowrap", "align",
      "valign", "border", "cellpadding", "cellspacing", "frame", "rules", "bgcolor", "char",
      "charoff", "start", "reversed"],
    // 元数据 / 脚本（meta / script / style / title）
    ["content", "http-equiv", "property", "async", "defer", "nomodule", "blocking", "scoped"],
    // 其余常用（time / blockquote / q / ins / del / progress / meter / details / html）
    ["datetime", "cite", "manifest", "low", "high", "optimum"],
    // ARIA（ARIA 1.2/1.3 属性表；逐个枚举，不做 `aria-` 前缀放行）
    ["aria-activedescendant", "aria-atomic", "aria-autocomplete", "aria-braillelabel",
      "aria-brailleroledescription", "aria-busy", "aria-checked", "aria-colcount",
      "aria-colindex", "aria-colindextext", "aria-colspan", "aria-controls", "aria-current",
      "aria-describedby", "aria-description", "aria-details", "aria-disabled",
      "aria-errormessage", "aria-expanded", "aria-flowto", "aria-haspopup", "aria-hidden",
      "aria-invalid", "aria-keyshortcuts", "aria-label", "aria-labelledby", "aria-level",
      "aria-live", "aria-modal", "aria-multiline", "aria-multiselectable", "aria-orientation",
      "aria-owns", "aria-placeholder", "aria-posinset", "aria-pressed", "aria-readonly",
      "aria-relevant", "aria-required", "aria-roledescription", "aria-rowcount", "aria-rowindex",
      "aria-rowindextext", "aria-rowspan", "aria-selected", "aria-setsize", "aria-sort",
      "aria-valuemax", "aria-valuemin", "aria-valuenow", "aria-valuetext"],
    // 事件处理器内容属性（on<event> 常见项）
    ["onclick", "ondblclick", "onchange", "oninput", "onsubmit", "onreset", "onfocus", "onblur",
      "onload", "onerror", "onscroll", "onkeydown", "onkeyup", "onkeypress", "onmousedown",
      "onmouseup", "onmouseover", "onmouseout", "onmouseenter", "onmouseleave", "onmousemove",
      "ontouchstart", "ontouchend", "ontouchmove", "onpointerdown", "onpointerup",
      "onpointermove", "ondragstart", "ondragover", "ondrop", "onanimationend",
      "ontransitionend"],
  ];
  return Object.freeze([...new Set(groups.flat())].sort());
})();

const EXTRACT_ATTR_SET: ReadonlySet<string> = new Set(EXTRACT_ATTR_WHITELIST);

/**
 * `@xxx` 是否在白名单内（**大小写不敏感**：HTML 属性名由 DOM 按大小写不敏感解析，
 * 拿 `@HREF` 去拒人对页面没有好处）。`data-*` 只认「`data-` + 非空后缀」。
 */
export function isExtractableAttr(rawName: string): boolean {
  const name = rawName.trim().toLowerCase();
  if (name === "") return false;
  if (EXTRACT_ATTR_SET.has(name)) return true;
  return name.startsWith("data-") && name.length > "data-".length;
}

/** 报错里给的可用样例（白名单太长，全量清单见 {@link EXTRACT_ATTR_WHITELIST}）。 */
const EXTRACT_ATTR_SAMPLES: readonly string[] = [
  "id", "class", "title", "href", "src", "alt", "name", "value", "type", "role",
  "placeholder", "aria-label", "data-test", "style",
];

/** `@` 取属性闭集的可读说明（`extractFieldsReason` 拼进 reason；单一出处）。 */
export const EXTRACT_ATTR_CLOSED_SET_TEXT =
  `\`@\` 取属性是**闭集**：只认真实 HTML 属性 + 伪属性 \`${EXTRACT_FIELD_SELF}\``
  + `（该行元素可见文本，等价字段值 "."），不认 DOM 属性名（innerText 等那类请用 "." / "${EXTRACT_FIELD_SELF}"）。`
  + `可用样例：${EXTRACT_ATTR_SAMPLES.join(" / ")}；`
  + `另有 aria-* 与 on<event> 按表枚举、data-* 是唯一开放族（作者自定义）。`
  + `完整清单 = EXTRACT_ATTR_WHITELIST（${EXTRACT_ATTR_WHITELIST.length} 项，`
  + `src/app/session-extract-fields.ts；grep -n EXTRACT_ATTR_WHITELIST 查看全表）。`;

/** 一个不合法字段的结构化原因（调用方自行格式化；{@link extractFieldsReason} 是默认文案）。 */
export type ExtractFieldProblem =
  | { field: string; kind: "not_a_string"; value: unknown }
  | { field: string; kind: "empty_attr"; raw: string }
  | { field: string; kind: "unknown_attr"; raw: string; attr: string };

/** `extract.fields` 的校验结论：`ok` 时 `fields` 是**可下发给抽取本体**的规范化字段表。 */
export type ExtractFieldsCheck =
  | { ok: true; fields: Record<string, string> }
  | { ok: false; problems: ExtractFieldProblem[] };

/**
 * 会话 `extract` 的 `fields` 入口校验 + 规范化（`{"name": "css | row text | @attr"}` 形状不变）。
 *
 * 做两件事：
 *   1. **闭集校验**：`@xxx` 必须命中 {@link EXTRACT_ATTR_WHITELIST}（或 `data-*` 族 / `@self`）；
 *      未知名字 = 结构化问题（调用方报 `config_error`），绝不静默返回 `""`。
 *   2. **`@self` 归一**：翻成既有 `"."`（行自身 `innerText`）——抽取语义零新增、零重实现。
 * 无 `@` 的字段值原样透传（CSS 子选择器 / 行文本 / `:scope` 的既有行为逐字节不变）；
 * 值不是字符串也在入口拦下（否则会一路走到 `startsWith`/`locator` 变成 internal_error）。
 */
export function normalizeExtractFields(fields: Record<string, unknown>): ExtractFieldsCheck {
  const problems: ExtractFieldProblem[] = [];
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(fields)) {
    if (typeof raw !== "string") {
      problems.push({ field: name, kind: "not_a_string", value: raw });
      continue;
    }
    if (!raw.startsWith("@")) {
      out[name] = raw;
      continue;
    }
    if (raw.toLowerCase() === EXTRACT_FIELD_SELF) {
      out[name] = ".";
      continue;
    }
    const attr = raw.slice(1);
    if (!isExtractableAttr(attr)) {
      problems.push(attr === ""
        ? { field: name, kind: "empty_attr", raw }
        : { field: name, kind: "unknown_attr", raw, attr });
      continue;
    }
    out[name] = raw;
  }
  if (problems.length === 0) return { ok: true, fields: out };
  return { ok: false, problems };
}

/** 结构化问题 → 一段可读 reason（闭集说明在前、逐字段明细在后）。 */
export function extractFieldsReason(problems: readonly ExtractFieldProblem[]): string {
  const lines = problems.map((p) => {
    const field = `fields[${JSON.stringify(p.field)}]`;
    if (p.kind === "not_a_string") return `${field}：值必须是字符串（子 CSS / "." 行文本 / "@attr" 行属性 / "${EXTRACT_FIELD_SELF}"）；收到 ${JSON.stringify(p.value)}`;
    if (p.kind === "empty_attr") return `${field}："@" 后面缺属性名`;
    return `${field}：不支持 ${JSON.stringify(p.raw)}（既非真实 HTML 属性，也非伪属性 ${EXTRACT_FIELD_SELF}）`;
  });
  // 闭集说明在前：桥把 reason 截到 1000 字符，指南必须活过截断。
  return `${EXTRACT_ATTR_CLOSED_SET_TEXT}不合法字段：${lines.join("；")}`;
}
