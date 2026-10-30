/**
 * prompt-hit —— 「提示词怎么说」↔「实现认什么」的离线闸门（不开浏览器、不调模型）。
 *
 * 语法描述的唯一出处是 `src/engine/grammar-prompt.ts`（import 时已自证与 `parseHint` /
 * `SIGNAL_OPS` 对齐）；本工具在其上再钉四层钉子：
 *
 *   1. grammar  HINT_SHAPES 示例逐个被唯一解析器解析成声明形状；SIGNAL_OP_PROMPT 与
 *               SIGNAL_OPS 键集合双向一致（多写/漏写都红）。
 *   2. pool     每个示例 hint 在合成元素池上 `hintMatch` **恰好命中一个**预期元素
 *               （示例可直接照抄）；防御性反例：容器/后代 CSS `#outer input` 永不命中、
 *               多候选裸词宁缺勿错（返回 null 而不是猜）。
 *   3. plan     代表性信号样本（all_of 组合、未知算子、空 all_of、manual、参数个数）过
 *               `validateSignalSpec`，判定与 SIGNAL_OP_PROMPT 的声明一致。
 *   4. bridge   `integrations/dsh-bridge/src/grammar.generated.ts` 与 grammar-prompt 同步。
 *               桥纪律 "called, not embedded"：不 import 引擎代码，语法以**生成物**分发——
 *               `--fix` 重新生成；不带 --fix 时漂移即红（接进 `npm run check`）。
 *   5. doc      `docs/APP_SCRIPT_AUTHORING.md` 必须逐字包含 ATTR_MATCH_MODEL_TEXT
 *               （属性匹配模型权威表述），且不含已知错误句——文档也是消费面。
 *   6. doc      同上：快速路径（PLAN_PLAYBOOK_TEXT）与失败速查（FAILURE_SIGNS_TEXT）
 *               必须逐字在文档里——「引擎告诉 Agent 怎么规划」的文案不许手抄。
 *
 * 退出码：0 全绿 / 1 有不一致。
 * 用法：node --experimental-strip-types tools/prompt-hit.ts [--fix]
 */
import fs from "node:fs";
import path from "node:path";
import { REPO } from "../src/support/paths.ts";
import { parseHint } from "../src/engine/hint.ts";
import { SIGNAL_OPS } from "../src/engine/signal-ops.ts";
import { HINT_SHAPES, SIGNAL_OP_PROMPT, ATTR_MATCH_MODEL_TEXT } from "../src/engine/grammar-prompt.ts";
import { PLAN_PLAYBOOK_TEXT, FAILURE_SIGNS_TEXT, PLAN_PLAYBOOK_SHORT } from "../src/engine/planning-playbook.ts";
import { hintMatch } from "../src/engine/rules.ts";
import { validateSignalSpec } from "../src/engine/signals.ts";

const fix = process.argv.includes("--fix");
if (process.argv.filter((a) => a !== "--fix").length > 2) {
  console.error("usage: node --experimental-strip-types tools/prompt-hit.ts [--fix]");
  process.exit(2);
}

const problems: string[] = [];

/* ---- 1. grammar：示例 ↔ 解析器，算子描述 ↔ SIGNAL_OPS --------------------- */

for (const s of HINT_SHAPES) {
  const got = parseHint(s.example).kind;
  if (got !== s.kind) problems.push(`grammar: '${s.example}' 解析为 ${got}，声明为 ${s.kind}`);
}
const opKeys = Object.keys(SIGNAL_OPS).sort();
const descKeys = Object.keys(SIGNAL_OP_PROMPT).sort();
if (JSON.stringify(opKeys) !== JSON.stringify(descKeys)) {
  const missing = opKeys.filter((k) => !descKeys.includes(k));
  const extra = descKeys.filter((k) => !opKeys.includes(k));
  problems.push(`grammar: 算子描述与 SIGNAL_OPS 不一致（缺描述: ${missing.join(", ") || "-"}；死描述: ${extra.join(", ") || "-"}）`);
}

/* ---- 2. pool：示例必须恰好命中预期元素；反例必须永不命中 ------------------- */

type PoolElem = { tag: string; label: string; id?: string; data_test?: string; href?: string; near?: string; input_type?: string };
const pool = (elems: Record<string, PoolElem>) => elems;
const pools: Array<{ hint: string; elems: Record<string, PoolElem>; want: string }> = [
  { hint: HINT_SHAPES[0]!.example, want: "e0",
    elems: pool({ e0: { tag: "button", label: "Login", id: "login-button" } }) },
  { hint: HINT_SHAPES[1]!.example, want: "e0",
    elems: pool({ e0: { tag: "a", label: "Travel", href: "/catalogue/travel_2/index.html" } }) },
  { hint: HINT_SHAPES[2]!.example, want: "e0",
    elems: pool({ e0: { tag: "button", label: "Add to cart", near: "Onesie" } }) },
  { hint: HINT_SHAPES[3]!.example, want: "e0",
    elems: pool({ e0: { tag: "button", label: "Add to cart", data_test: "add-to-cart" } }) },
  { hint: HINT_SHAPES[4]!.example, want: "e0",
    elems: pool({ e0: { tag: "button", label: "Go" } }) },
  { hint: HINT_SHAPES[5]!.example, want: "e0",
    elems: pool({ e0: { tag: "a", label: "Travel" } }) },
];
for (const { hint, elems, want } of pools) {
  const got = hintMatch(hint, elems as never);
  if (got !== want) problems.push(`pool: 示例 '${hint}' 命中 ${JSON.stringify(got)}，预期 '${want}'（示例必须恰好命中一个元素）`);
}
// 防御性反例：容器/后代 CSS 不是语法错误，但必须永不命中（宁缺勿错，不猜）。
const wide = pool({
  e0: { tag: "div", label: "outer", id: "outer" },
  e1: { tag: "input", label: "", id: "inner-input" },
});
if (hintMatch("#outer input", wide as never) !== null) {
  problems.push("pool: 反例 '#outer input' 命中了候选——容器/后代 CSS 必须永不命中");
}
// 歧义反例：token 不全等命中任何 label，但**词级**命中多个候选——宁缺勿错返回 null。
// （"Travel" 全等 label 会被 whole-label 档先命中，构造歧义必须避开全等档。）
const ambiguous = pool({
  e0: { tag: "a", label: "Travel guide" },
  e1: { tag: "a", label: "Travel blog" },
});
if (hintMatch("travel", ambiguous as never) !== null) {
  problems.push("pool: 多候选裸词 'travel' 命中了候选——歧义必须返回 null（宁缺勿错）");
}

/* ---- 3. plan：校验器判定 ↔ 提示词声明 ------------------------------------- */

const ok = (spec: unknown): boolean => validateSignalSpec(spec, "t").length === 0;
const bad = (spec: unknown): string | null => validateSignalSpec(spec, "t").join(" ") || null;
// SIGNAL_OP_PROMPT 声明「non-empty list」⇒ 空 all_of 必须红、非空必须绿：
if (!ok({ all_of: [{ url_contains: "x" }, { css_exists: "#a" }] })) problems.push("plan: all_of 合法组合被判红");
if (!ok({ any_of: [{ url_contains: "x" }] })) problems.push("plan: any_of 合法组合被判红");
if (!ok({ not: { css_exists: ".spinner" } })) problems.push("plan: not 合法用法被判红");
if (!ok({ manual: true })) problems.push("plan: manual（无参叶子）被判红");
if (bad({ all_of: [] }) === null || !bad({ all_of: [] })!.includes("non-empty list")) {
  problems.push("plan: 空 all_of 未按 'non-empty list' 声明判红");
}
// 未知算子必须红，且报错里附上与 SIGNAL_OPS 一致的已知算子表（插入序，提示词↔校验器同表）：
const unknownMsg = bad({ magic_op: "x" }) ?? "";
if (!unknownMsg.includes("unknown signal op")) problems.push("plan: 未知算子未被判红");
if (!unknownMsg.includes(Object.keys(SIGNAL_OPS).join(", "))) problems.push("plan: 未知算子报错未附 SIGNAL_OPS 算子表");
// 参数个数：url_contains 声明 1 参 ⇒ 2 参必须红：
if (bad({ url_contains: ["a", "b"] }) === null) problems.push("plan: url_contains 2 参未被判红");

/* ---- 4. bridge：生成物 ↔ grammar-prompt ----------------------------------- */

const GENERATED = path.join(REPO, "integrations", "dsh-bridge", "src", "grammar.generated.ts");

function bridgeGenerated(): string {
  const tokens = HINT_SHAPES.map((s) => s.en);
  const note =
    `A hint is a STABLE-HANDLE CLOSED SET of ${tokens.length} shapes (${tokens.join(" | ")}; `
    + `only test=data-test and type attribute names take part in matching), NOT arbitrary CSS - `
    + `container/descendant selectors (e.g. "#outer input") parse but can never match (target_not_found).`;
  const playbookShort = PLAN_PLAYBOOK_SHORT;
  return `/**
 * 生成物（勿手改）：由 \`src/engine/grammar-prompt.ts\` 与 \`src/engine/planning-playbook.ts\`
 * 经 \`npm run prompt-hit\` 生成与校验。桥纪律 "called, not embedded"：不 import 引擎代码，
 * 语法与规划引导以**字符串**分发到这里。先改引擎模块，再跑 \`npm run prompt-hit\`
 * （本文件漂移会让 \`npm run check\` 红）。
 */

export const HINT_SHAPE_TOKENS: readonly string[] = ${JSON.stringify(tokens, null, 2)};

export const HINT_LEARN_NOTE = ${JSON.stringify(note)};

export const PLAN_PLAYBOOK_SHORT = ${JSON.stringify(playbookShort)};
`;
}

const expected = bridgeGenerated();
const actual = fs.existsSync(GENERATED) ? fs.readFileSync(GENERATED, "utf-8") : "";
if (actual !== expected) {
  if (fix) {
    fs.mkdirSync(path.dirname(GENERATED), { recursive: true });
    fs.writeFileSync(GENERATED, expected, "utf-8");
    console.log(`wrote ${path.relative(REPO, GENERATED)}`);
  } else {
    problems.push("bridge: integrations/dsh-bridge/src/grammar.generated.ts 与 grammar-prompt 不一致；运行 npm run prompt-hit -- --fix 重新生成");
  }
}

/* ---- 5. doc：作者文档的属性匹配模型 ↔ grammar-prompt 权威表述 -------------- */
// 2026-10-29 实测教训：文档手抄行「title、href 等不在池字段模型里」与自证示例
// `a[href~travel_2]` 矛盾，真实 Agent 首用即被搅浑——文档的关键事实句必须逐字来自模块。

const DOC = path.join(REPO, "docs", "APP_SCRIPT_AUTHORING.md");
const docText = fs.existsSync(DOC) ? fs.readFileSync(DOC, "utf-8") : "";
if (!docText.includes(ATTR_MATCH_MODEL_TEXT)) {
  problems.push("doc: docs/APP_SCRIPT_AUTHORING.md 未包含属性匹配模型权威表述（ATTR_MATCH_MODEL_TEXT）——从 grammar-prompt.ts 逐字复制，不要手抄改写");
}
if (docText.includes("title、href 等不在池字段模型里")) {
  problems.push("doc: docs/APP_SCRIPT_AUTHORING.md 仍含已知错误句「title、href 等不在池字段模型里」（href 是池字段，books-category rule:match 实测命中）");
}

/* ---- 6. doc：快速路径 ↔ planning-playbook --------------------------------- */
// 引擎引导的五步法/失败速查同样逐字进文档——「引擎告诉 Agent 怎么规划」的文案不许手抄。

if (!docText.includes(PLAN_PLAYBOOK_TEXT)) {
  problems.push("doc: docs/APP_SCRIPT_AUTHORING.md 未包含高效规划五步法（PLAN_PLAYBOOK_TEXT）——从 planning-playbook.ts 逐字复制");
}
if (!docText.includes(FAILURE_SIGNS_TEXT)) {
  problems.push("doc: docs/APP_SCRIPT_AUTHORING.md 未包含失败特征速查（FAILURE_SIGNS_TEXT）——从 planning-playbook.ts 逐字复制");
}

/* ---- 汇总 ------------------------------------------------------------------ */

if (problems.length) {
  for (const p of problems) console.error(`prompt-hit: ${p}`);
  process.exit(1);
}
console.log(
  `prompt-hit: OK（6 层）— hint ${HINT_SHAPES.length} 形状全部可解析且示例可命中，`
    + `信号 ${opKeys.length} 算子提示词↔校验器一致，${fix ? "桥生成物已重写" : "桥生成物同步"}，`
    + `文档快速路径/属性模型逐字一致`,
);
