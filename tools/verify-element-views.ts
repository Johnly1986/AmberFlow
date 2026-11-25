/**
 * verify-element-views —— **模型面元素视图**的离线表驱动断言（纯 Node：零浏览器、零网络、零模型）。
 *
 * 为什么需要它：`criteriaView` 的输出直接喂给决策模型选点，两条判据——「aria 行解析」
 * 与「池↔行逐项身份对齐」——都只在**模型看到的文字**上留痕，选错不会产生任何信号。
 * 页面级行为由 `verify:offline` 的 golden 钉住，而这两条判据本身是纯函数，用**同一条
 * 输入的精确期望值**（逐字节）断言比 golden 更直接：改了判据就必须改这里的表。
 *
 * 两组：
 *   parse     Playwright `ariaSnapshot()` 行 → `[role, name]`，并整份快照端到端过一遍
 *             `ariaInteractiveLines`（断言的是**收集面**，不只是解析器）。表里的输入行是
 *             **实测**的 Playwright 输出（名字含 `": "` 时键被单引号包裹、`'` 双写成 `''`、
 *             双引号/反斜杠走 JSON 转义），含非交互 role 必须被忽略的反例。
 *   align     池↔行对齐是逐项身份而不是数量：数量相等但身份错配 → 必须降级；逐项一致 →
 *             必须保持 role 语义。对齐/降级两种输出的期望字符串逐字节写死（行为边界）。
 *   label     池标签对敏感输入（password/file/hidden）不读活值：用宿主 `compile()` 把两份
 *             同口径页面 JS（`LABEL_HELPERS_JS.labelOfRaw` 与 `ROW_CLIMB_JS.__rowLabelOf`）
 *             跑在最小假 DOM 上，断言敏感值不进标签、非敏感元素标签逐字节不变。
 *
 * 用法：node --experimental-strip-types tools/verify-element-views.ts
 * 退出码：0 全过 / 1 断言失败。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ariaInteractiveLines, criteriaView, parseAriaInteractiveLine } from "../src/engine/extraction.ts";
import type { PageLike } from "../src/support/page-like.ts";
import { ariaLinesAligned, expectedAriaRoles } from "../src/engine/aria-view.ts";
import { LABEL_HELPERS_JS, ROW_CLIMB_JS, compile } from "../src/engine/pool-js-core.ts";
import { ARIA_INTERACTIVE_ROLES } from "../src/engine/extraction.ts";
import type { Elem, ElemPool } from "../src/engine/elem-model.ts";

const ROLE_SET: ReadonlySet<string> = new Set(ARIA_INTERACTIVE_ROLES);
const problems: string[] = [];
const failures: Array<Promise<void>> = [];
/** 同步/异步断言共用：异步失败进 `failures`，末尾统一收集（顺序稳定）。 */
const check = (why: string, fn: () => void | Promise<void>): void => {
  try {
    const r = fn();
    if (r !== undefined) failures.push(r.catch((e: unknown) => {
      problems.push(`${why}: ${e instanceof Error ? e.message : String(e)}`);
    }));
  } catch (e) {
    problems.push(`${why}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

/* ------------------------------------------------------------------ 1. 行解析（parse） */

/** 输入行**逐字**取自 Playwright 1.58 `ariaSnapshot()` 的实测输出（见注释列）。 */
const PARSE_CASES: ReadonlyArray<{ line: string; want: [string, string]; why: string }> = [
  { line: '- button "Plain": S3', want: ["button", "Plain"], why: "裸键 + 行内文本值" },
  { line: "- 'button \"Save: draft\"': S1", want: ["button", "Save: draft"], why: "单引号键（名字含 ': '）" },
  { line: "- 'button \"Delete: all\"': S2", want: ["button", "Delete: all"], why: "单引号键（第二条）" },
  { line: '- button "It\'s here": S2', want: ["button", "It's here"], why: "裸键 + 名字含单引号" },
  { line: "- 'button \"It''s: here\"': S2", want: ["button", "It's: here"], why: "单引号键 + YAML '' 双写" },
  { line: String.raw`- button "Say \"hi\"": S3`, want: ["button", 'Say "hi"'], why: "裸键 + JSON 双引号转义" },
  { line: String.raw`- button "back\\slash": S6`, want: ["button", "back\\slash"], why: "裸键 + JSON 反斜杠转义" },
  { line: '- button "Line1 Line2": S4', want: ["button", "Line1 Line2"], why: "折行后的裸键" },
  { line: "- 'textbox \"Name: first\"'", want: ["textbox", "Name: first"], why: "单引号键 + 无值" },
  { line: "- 'textbox \"Name: first\" [disabled]'", want: ["textbox", "Name: first"], why: "属性后缀不影响 name（实测形态）" },
  { line: '- link "Go":', want: ["link", "Go"], why: "有子节点的 link" },
  { line: '  - button "Nested"', want: ["button", "Nested"], why: "缩进行（层级对池对齐无意义）" },
  { line: "- textbox: hunter2", want: ["textbox", ""], why: "无 name 槽：值绝不进 name" },
  { line: "- button", want: ["button", ""], why: "只有 role" },
];

/** 必须被忽略的行：非交互 role（闭集外）与 aria 属性行。 */
const IGNORED_LINES: ReadonlyArray<{ line: string; why: string }> = [
  { line: "- heading \"Title\" [level=1]", why: "heading 不在闭集" },
  { line: "- text: hello", why: "text 不是交互 role" },
  { line: "- /url: /go", why: "属性行（且以 / 开头）" },
  { line: "- listitem \"LI\"", why: "listitem 不在闭集" },
  { line: "- img \"IMG\"", why: "img 不在闭集" },
  { line: "- paragraph: some copy", why: "paragraph 不在闭集" },
];

const parse = (line: string): [string, string] | null => parseAriaInteractiveLine(line, ROLE_SET);

for (const c of PARSE_CASES) {
  check(`parse ${c.why}`, () => {
    const got = parse(c.line);
    assert.deepEqual(got, c.want, `输入 ${JSON.stringify(c.line)} 期望 ${JSON.stringify(c.want)} 实际 ${JSON.stringify(got)}`);
  });
}
for (const c of IGNORED_LINES) {
  check(`parse 忽略 ${c.why}`, () => {
    assert.equal(parse(c.line), null, `${JSON.stringify(c.line)} 必须被忽略（${c.why}）`);
  });
}
// 闭集本身不得被放宽：解析出的 role 恒在 ARIA_INTERACTIVE_ROLES 内。
check("parse 只产出闭集内的 role", () => {
  for (const c of PARSE_CASES) {
    const got = parse(c.line);
    assert.notEqual(got, null, JSON.stringify(c.line));
    assert.equal(ROLE_SET.has(got![0]), true, `role ${JSON.stringify(got![0])} 不在闭集`);
  }
});

/**
 * 整份快照的端到端断言（缺陷复现夹具的实测输出）：4 行里 3 行的键被单引号包裹，
 * 收集面必须一行不少；这是「解析器接没接上」的判据（只测解析器测不出接线回退）。
 */
const QUOTED_SNAPSHOT = [
  "- 'button \"Save: draft\"': S1",
  "- 'button \"Delete: all\"': S2",
  '- button "Plain": S3',
  "- 'textbox \"Name: first\"'",
].join("\n");

check("parse 整份快照端到端（单引号键不丢行）", () => {
  const fakePage = {
    locator: () => ({ first: () => ({ ariaSnapshot: async () => QUOTED_SNAPSHOT }) }),
  } as unknown as PageLike;
  return ariaInteractiveLines(fakePage).then((lines) => {
    assert.deepEqual(lines, [
      ["button", "Save: draft"], ["button", "Delete: all"], ["button", "Plain"], ["textbox", "Name: first"],
    ], `收集面丢行：${JSON.stringify(lines)}`);
  });
});

/* ------------------------------------------------------------------ 2. 身份对齐（align） */

const elem = (tag: string, label: string, extra: Partial<Elem> = {}): Elem => ({ tag, label, ...extra });
const pool = (rows: ReadonlyArray<Elem>): ElemPool =>
  Object.fromEntries(rows.map((e, i) => [`e${i}`, { ...e, scan: i, ref: `e${i}` }]));

/** 缺陷复现：池 2 项（a/"PoolOnly"、a/"Go"）与 aria 2 行（link/"Go"、button/"Go"）数量相等。 */
const COUNT_EQUAL_POOL = { e0: elem("a", "PoolOnly", { href: "/p", scan: 2 }), e1: elem("a", "Go", { href: "/go", scan: 0 }) };
const COUNT_EQUAL_LINES: Array<[string, string]> = [["link", "Go"], ["button", "Go"]];

check("align 数量相等但身份错配必须降级", () => {
  const ordered = Object.entries(COUNT_EQUAL_POOL).sort((a, b) => a[1].scan! - b[1].scan!);
  assert.equal(ariaLinesAligned(ordered, COUNT_EQUAL_LINES), false, "身份错配不得判对齐");
  const view = criteriaView(COUNT_EQUAL_POOL, new Set(), COUNT_EQUAL_LINES);
  // 刻意降级：宁可给 tag，也不把 e0 渲染成另一个元素的 button。
  assert.deepEqual(view, { e1: 'a "Go" -> /go', e0: 'a "PoolOnly" -> /p' }, JSON.stringify(view));
  for (const line of Object.values(view)) {
    assert.equal(line.includes('button "PoolOnly"'), false, `错配后不得出现 button "PoolOnly"：${line}`);
  }
});

check("align 逐项一致时保持 role 语义（逐字节）", () => {
  const p = pool([elem("button", "确认", { data_test: "ok" }), elem("a", "帮助", { href: "/help" })]);
  const lines: Array<[string, string]> = [["button", "确认"], ["link", "帮助"]];
  const ordered = Object.entries(p).sort((a, b) => a[1].scan! - b[1].scan!);
  assert.equal(ariaLinesAligned(ordered, lines), true, "逐项一致必须判对齐");
  assert.deepEqual(criteriaView(p, new Set(), lines), {
    e0: 'button "确认" [test=ok]',
    e1: 'link "帮助" -> /help',
  }, "对齐路径的渲染必须逐字节不变");
});

check("align 数量不等必须降级（既有行为）", () => {
  const p = pool([elem("button", "确认")]);
  assert.deepEqual(criteriaView(p, new Set(), []), { e0: 'button "确认"' });
  assert.deepEqual(criteriaView(p, new Set(), null), { e0: 'button "确认"' });
});

check("align role 身份优先于 name 相容", () => {
  // 名字相同但 role 完全不同（嵌在链接里的按钮 vs 链接）→ 不得判同一元素。
  const p = pool([elem("a", "Go", { href: "/go" })]);
  const ordered = Object.entries(p).sort((a, b) => a[1].scan! - b[1].scan!);
  assert.equal(ariaLinesAligned(ordered, [["button", "Go"]]), false, "link 行与 a 行 role 不同");
  assert.equal(ariaLinesAligned(ordered, [["link", "Go"]]), true, "link 行与 a 行 role 相同");
});

check("align name 冲突只在有错位证据时判错配", () => {
  // role 可映射、名字互不包含但也不是别的池行：无串位证据（label 链与 aria name 取法
  // 本就不同，实测 Wikipedia 语言列表），不据此否定对齐。
  const single = pool([elem("button", "保存")]);
  const singleOrdered = Object.entries(single).sort((a, b) => a[1].scan! - b[1].scan!);
  assert.equal(ariaLinesAligned(singleOrdered, [["button", "删除"]]), true);
  // 名字互不包含 **且** 是另一个池行的 label = 位置串位证据 → 判错配。
  const swapped = pool([elem("button", "保存"), elem("button", "删除")]);
  const swappedOrdered = Object.entries(swapped).sort((a, b) => a[1].scan! - b[1].scan!);
  assert.equal(ariaLinesAligned(swappedOrdered, [["button", "删除"], ["button", "保存"]]), false);
  // 自绘容器（role 映射不出）：name 是唯一信号，冲突直接判错配。
  const selfDrawn = pool([elem("div", "保存")]);
  const selfDrawnOrdered = Object.entries(selfDrawn).sort((a, b) => a[1].scan! - b[1].scan!);
  assert.equal(ariaLinesAligned(selfDrawnOrdered, [["button", "删除"]]), false);
  // aria name 会把后代文本折进来（实测 "商品卡片 Alpha" -> "商品卡片 Alpha 加入购物车"）：
  // 互相包含仍算同一元素，否则这类页面的模型面会整体退化。
  const card = pool([elem("div", "商品卡片 Alpha", { role: "button" })]);
  const cardOrdered = Object.entries(card).sort((a, b) => a[1].scan! - b[1].scan!);
  assert.equal(ariaLinesAligned(cardOrdered, [["button", "商品卡片 Alpha 加入购物车"]]), true);
});

check("align 自绘容器不猜 role（只校验 name）", () => {
  const p = pool([elem("div", "确认订单", { ...{ } })]);
  const ordered = Object.entries(p).sort((a, b) => a[1].scan! - b[1].scan!);
  assert.deepEqual(expectedAriaRoles(p["e0"]!), null, "div 无 role 属性时映射不出 role");
  assert.equal(ariaLinesAligned(ordered, [["link", "确认订单"]]), true, "自绘容器只按 name 校验");
});

check("align 显式 role 优先于 tag", () => {
  const p = pool([elem("a", "下一个", { role: "button", href: "/next" })]);
  const ordered = Object.entries(p).sort((a, b) => a[1].scan! - b[1].scan!);
  assert.deepEqual(expectedAriaRoles(p["e0"]!), ["button"]);
  assert.equal(ariaLinesAligned(ordered, [["button", "下一个"]]), true);
  assert.equal(ariaLinesAligned(ordered, [["link", "下一个"]]), false);
});

check("align input 类型映射到 aria role", () => {
  const cases: Array<[string, string]> = [["search", "searchbox"], ["number", "spinbutton"], ["checkbox", "checkbox"],
    ["radio", "radio"], ["range", "slider"], ["file", "button"], ["password", "textbox"], ["", "textbox"]];
  for (const [type, role] of cases) {
    const e = elem("input", "字段", { input_type: type });
    const ordered: Array<readonly [string, Elem]> = [["e0", e]];
    assert.equal(ariaLinesAligned(ordered, [[role, "字段"]]), true, `type=${JSON.stringify(type)} 应映射 ${role}`);
  }
});

check("align 空 label 仍可采纳 aria name（既有行为）", () => {
  const p = pool([elem("div", "", { role: "button" })]);
  const ordered = Object.entries(p).sort((a, b) => a[1].scan! - b[1].scan!);
  assert.equal(ariaLinesAligned(ordered, [["button", "加入购物车"]]), true);
  assert.deepEqual(criteriaView(p, new Set(), [["button", "加入购物车"]]), { e0: 'button "加入购物车"' });
});

check("align select 的 [now=] 分支保持不变", () => {
  // 池 label 是「首选项文本 / 关联 label 文本」，aria name 只有关联 label：包含关系成立。
  const p = pool([elem("select", "中文 / 语言", { input_type: "" })]);
  const lines: Array<[string, string]> = [["combobox", "语言"]];
  const ordered = Object.entries(p).sort((a, b) => a[1].scan! - b[1].scan!);
  assert.equal(ariaLinesAligned(ordered, lines), true);
  assert.deepEqual(criteriaView(p, new Set(), lines), { e0: 'select "语言" [now=中文 / 语言]' });
});

check("align forbidden 元素仍占 aria 行（不跳过）", () => {
  const p = pool([elem("button", "确认"), elem("button", "取消")]);
  const lines: Array<[string, string]> = [["button", "确认"], ["button", "取消"]];
  assert.deepEqual(criteriaView(p, new Set(["e0"]), lines), { e1: 'button "取消"' });
});

/* ------------------------------------------------------------------ 3. 池标签（label） */

/** 最小假 DOM：只实现两份 label JS 用到的读取面（不引入 jsdom，也不起浏览器）。 */
interface FakeEl {
  tag: string;
  type?: string;
  value?: string;
  innerText?: string;
  id?: string;
  ariaLabel?: string;
  title?: string;
  placeholder?: string;
  labelWrapper?: string;
}
function fakeElement(spec: FakeEl): Record<string, unknown> {
  return {
    tagName: spec.tag.toUpperCase(),
    id: spec.id ?? "",
    value: spec.value ?? "",
    innerText: spec.innerText ?? "",
    childNodes: [],
    getAttribute(name: string): string | null {
      if (name === "type") return spec.type ?? null;
      if (name === "aria-label") return spec.ariaLabel ?? null;
      if (name === "title") return spec.title ?? null;
      if (name === "placeholder") return spec.placeholder ?? null;
      if (name === "value") return spec.value ?? null;
      return null;
    },
    closest(sel: string): unknown { return sel === "label" && spec.labelWrapper ? { innerText: spec.labelWrapper } : null; },
    getClientRects: (): unknown[] => [{ width: 10, height: 10 }],
    checkVisibility: (): boolean => true,
  };
}
const labelOfRaw = compile("e,tag", `${LABEL_HELPERS_JS}\nreturn labelOfRaw(e, tag);`) as (e: unknown, tag: string) => string;
const rowLabelOf = compile("e", `${ROW_CLIMB_JS}\nreturn __rowLabelOf(e);`) as (e: unknown) => string;

const LABEL_CASES: ReadonlyArray<{ spec: FakeEl; want: string; why: string }> = [
  // 非敏感：value 仍是 label 兜底（既有行为，逐字节不变）。
  { spec: { tag: "input", type: "text", value: "alice" }, want: "alice", why: "text input 的 value 仍是 label" },
  { spec: { tag: "input", type: "search", value: "query" }, want: "query", why: "search input 的 value 仍是 label" },
  { spec: { tag: "textarea", value: "typed" }, want: "typed", why: "textarea 的 value 仍是 label" },
  { spec: { tag: "input", type: "email", value: "a@b.test" }, want: "a@b.test", why: "email input 的 value 仍是 label" },
  // 敏感：活值绝不当 label，也不进 label 包裹文本的前缀剥离。
  { spec: { tag: "input", type: "password", value: "hunter2" }, want: "", why: "password 不读活值" },
  { spec: { tag: "input", type: "password", value: "hunter2", labelWrapper: "密码" }, want: "密码", why: "password 用 label 包裹文本（不读活值）" },
  { spec: { tag: "input", type: "text", value: "alice", labelWrapper: "alice 用户名" }, want: "alice / 用户名", why: "text input 的 value + 包裹文本拼接保持既有行为" },
  { spec: { tag: "input", type: "file", value: "upload.txt" }, want: "", why: "file 不读活值" },
  { spec: { tag: "input", type: "hidden", value: "hidden-fixture-value" }, want: "", why: "hidden 不读活值" },
  // 稳定身份面优先：敏感输入也照读 aria-label / placeholder。
  { spec: { tag: "input", type: "password", ariaLabel: "密码", value: "hunter2" }, want: "密码", why: "password 的 aria-label 是身份" },
  { spec: { tag: "input", type: "password", placeholder: "请输入密码", value: "hunter2" }, want: "请输入密码", why: "password 的 placeholder 是身份" },
  // range 的既有先例（活值不是身份）。
  { spec: { tag: "input", type: "range", value: "70" }, want: "", why: "range 不读活值（既有先例）" },
  // 大小写形态：type 属性大小写不敏感。
  { spec: { tag: "input", type: "PASSWORD", value: "hunter2" }, want: "", why: "type 大小写不敏感" },
];

for (const c of LABEL_CASES) {
  check(`label ${c.why}`, () => {
    const el = fakeElement(c.spec);
    const got = labelOfRaw(el, c.spec.tag);
    assert.equal(got, c.want, JSON.stringify(c.spec) + ` 期望 ${JSON.stringify(c.want)} 实际 ${JSON.stringify(got)}`);
    assert.equal(/hunter2|upload\.txt|hidden-fixture-value/.test(got), false, "敏感值不得进入 label");
  });
  check(`label(dup 口径) ${c.why}`, () => {
    const got = rowLabelOf(fakeElement(c.spec));
    const want = c.want.slice(0, 40);
    assert.equal(got, want, "dup 分组标签必须与池行 label 同口径（ROW_CLIMB_JS.__rowLabelOf）");
  });
}

/* ------------------------------------------------------------------ 4. 其余 label 镜像 */

/**
 * 同一口径的**镜像**实现各自持有一份 label 表达式（池/observe 唯一实现之外，dup 分组键、
 * 审计被剔账、回捞、FW8 候选摘要、A3 回退合成行、逐元素兜底池）：它们都会把 label 写进
 * 模型面或失败证据，所以敏感活值的红线必须在每份镜像上都成立。
 *
 * 断言形态是**源码级**（这五处分别在页面 JS 字符串与宿主 TS 里，运行时形状各异）：
 * 每份镜像都必须出现 `password|file|hidden` 判定——任何一处回退到裸
 * `getAttribute('value')` / `e.value` 就红。运行时行为由 label 表与 fixtures 的
 * secret-input 页另行钉住。
 */
const LABEL_MIRRORS: ReadonlyArray<{ file: string; why: string }> = [
  { file: "src/engine/pool-js-core.ts", why: "LABEL_HELPERS_JS（池/observe 唯一实现）" },
  { file: "src/engine/pool-js-core.ts", why: "ROW_CLIMB_JS（dup 分组键）" },
  { file: "src/engine/pool-js.ts", why: "WINDOW_AUDIT_JS / HINT_HEAD（审计 + 回捞）" },
  { file: "src/engine/identity.ts", why: "IDENTITY_PROBE_JS（FW8 候选摘要）" },
  { file: "src/engine/executor.ts", why: "DOM_FALLBACK_COLLECT_JS（A3 回退合成行）" },
  { file: "src/app/candidate-scan.ts", why: "extractRowsPerElement（逐元素兜底）" },
];
check("label 镜像面全部对敏感输入设防（源码级同口径）", () => {
  const seen = new Set<string>();
  for (const m of LABEL_MIRRORS) {
    const src = readFileSync(path.resolve(import.meta.dirname, "..", m.file), "utf8");
    assert.match(src, /password\|file\|hidden/, `${m.file}（${m.why}）缺敏感输入判定`);
    seen.add(m.file);
  }
  assert.ok(seen.size >= 5, `镜像面至少 5 个文件，实际 ${seen.size}`);
});

await Promise.all(failures);

/* ------------------------------------------------------------------ 报告 */

if (problems.length > 0) {
  console.error(`verify-element-views: FAIL — ${problems.length} 个问题`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exitCode = 1;
} else {
  console.log(
    `verify-element-views: OK — parse ${PARSE_CASES.length}+${IGNORED_LINES.length} 行 / align 12 组判据 / label ${LABEL_CASES.length}x2 + ${LABEL_MIRRORS.length} 镜像组`,
  );
}

