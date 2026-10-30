/**
 * hint / 信号语法**描述**的唯一出处（提示词面）——对齐「命令表唯一出处是 registry.ts」
 * 的同一条纪律：语法描述不许在任何面手抄。
 *
 * 两个事实来源在这里汇合并**自证**：
 *   - hint 形状：镜像 `parseHint`（hint.ts，唯一解析器）的闭集；import 时逐个示例断言
 *     解析结果 = 声明形状——示例烂了/解析器改了没跟上，**启动即红**。
 *   - 信号算子：从 `SIGNAL_OPS`（signal-ops.ts，叶子）生成；import 时双向对齐断言——
 *     新增算子漏写描述 / 删算子留死描述，**启动即红**。提示词不可能再悄悄落后于校验器。
 *
 * 消费点（引擎内直接 import）：`executor.ts` 的 target_not_found 报错文案、
 * `plan.ts` 的 `PlanningRules.promptText()`。
 * 引擎外（DSH 桥，"called, not embedded"，不 import 引擎代码）走**生成物**：
 * `integrations/dsh-bridge/src/grammar.generated.ts`，由 `npm run prompt-hit` 生成并校验同步。
 */

import { parseHint } from "./hint.ts";
import { SIGNAL_OPS } from "./signal-ops.ts";

/** 语法描述里的一个 hint 形状。 */
export interface HintShape {
  /** 中文语境的形状名（报错文案里列形状用）。 */
  token: string;
  /** 英文语境的形状名（英文提示词用）。 */
  en: string;
  /** 可直接照抄的示例——必须被 `parseHint` 解析成 `kind`。 */
  example: string;
  /** 声明的形状 = `ParsedHint` 的 kind。 */
  kind: string;
  note: string;
}

/**
 * 6 种 hint 形状，镜像 `parseHint` 的闭集。顺序即报错/提示词里的展示顺序。
 * 注意：示例只示范**形状**，不承诺在任意页面上唯一命中（多候选时 hintMatch 返回
 * null、宁缺勿错——照抄前先 `amber inspect` 看这一页）。
 */
export const HINT_SHAPES: readonly HintShape[] = [
  { token: "#id", en: "#id", example: "#login-button", kind: "id", note: "元素 id" },
  {
    token: "tag[attr~substr]", en: "tag[attr~substr]", example: "a[href~travel_2]",
    kind: "attrSubstr", note: "属性子串——真实页面的主力形状",
  },
  {
    token: "tag~token", en: "tag~token", example: "button~onesie",
    kind: "nearToken", note: "近邻上下文词（消歧重复标签）",
  },
  {
    token: "tag[attr=value]", en: "tag[attr=value]", example: "[data-test=add-to-cart]",
    kind: "attrEq", note: "属性精确匹配（大小写折叠）",
  },
  {
    token: "角色词", en: "tag (button|link|input|textarea|select)", example: "button",
    kind: "tag", note: "角色词：button | link | input | textarea | select",
  },
  {
    token: "裸词", en: "bare-token", example: "travel",
    kind: "bare", note: "唯一标签 / data-test 词（多候选即歧义，宁缺勿错）",
  },
];

/* ---- import 时自证 1：示例 ↔ 唯一解析器 ---------------------------------- */

for (const s of HINT_SHAPES) {
  const got = parseHint(s.example).kind;
  if (got !== s.kind) {
    throw new Error(
      `grammar-prompt: HINT_SHAPES 示例 '${s.example}' 被解析为 kind='${got}'，声明为 '${s.kind}'`
        + `——示例或 parseHint 漂移了，先对齐 hint.ts 再改这里`,
    );
  }
}

/**
 * 信号算子的提示词描述，键集合必须与 `SIGNAL_OPS` **双向一致**（下方 import 时断言）。
 * 描述面向英文提示词（`PlanningRules.promptText()`）；前五个叶子的措辞与历史版本逐字一致。
 */
export const SIGNAL_OP_PROMPT: Readonly<Record<string, string>> = {
  url_contains: "substring of the final url  (op=value)",
  css_exists: "css selector that must exist  (op=value)",
  css_text_equals: "selector|exact text",
  css_text_contains: "selector|substring of the element's text",
  css_value_equals: "selector|exact input value",
  all_of: "AND-composition: a non-empty list of signals, each leaf still a DOM fact",
  any_of: "OR-composition: a non-empty list of signal alternatives",
  not: "negation of one signal (e.g. the spinner is gone)",
  manual: "no-arg leaf: a human attestation, never verifiable from the DOM",
};

/* ---- import 时自证 2：算子描述 ↔ SIGNAL_OPS 双向对齐 ---------------------- */

for (const op of Object.keys(SIGNAL_OPS)) {
  if (!(op in SIGNAL_OP_PROMPT)) {
    throw new Error(
      `grammar-prompt: 信号算子 '${op}'（SIGNAL_OPS）没有提示词描述——新增算子必须在这里补描述`,
    );
  }
}
for (const op of Object.keys(SIGNAL_OP_PROMPT)) {
  if (!(op in SIGNAL_OPS)) {
    throw new Error(
      `grammar-prompt: SIGNAL_OP_PROMPT 的 '${op}' 不是 SIGNAL_OPS 里的算子——算子已删/改名，删掉死描述`,
    );
  }
}

/* ---- 生成的文案 ----------------------------------------------------------- */

const HINT_TOKEN_LINE_CN = HINT_SHAPES.map((s) => s.token).join(" / ");
const HINT_TOKEN_LINE_EN = HINT_SHAPES.map((s) => s.en).join(" | ");

/**
 * 池侧可参与匹配的属性名（唯一权威清单，报错/文档/工具都从这渲染）。
 * 依据：attrSubstr/attrEq 按 `e[poolAttr(attr)]` 匹配（rules.ts），`poolAttr` 只给
 * test/type 发别名、其余直取同名字段——**凡是 Elem 池字段**的属性都可命中
 * （extraction.ts `Elem`：data_test/name/id/input_type/href/role/near）；
 * class/title 等非池字段永不命中。历史教训：文档曾写「title、href 等不在池字段
 * 模型里」，与本文件自证示例 `a[href~travel_2]`（books-category rule:match 实测
 * 命中）直接矛盾——真实 Agent 首用即被搅浑（2026-10-29 实测报告）。
 */
export const MATCHABLE_POOL_ATTRS: readonly string[] = [
  "test→data-test",
  "type→input_type",
  "href",
  "name",
  "id",
  "role",
  "near",
];

/** 属性匹配模型的权威表述（docs/APP_SCRIPT_AUTHORING.md 必须逐字包含，prompt-hit 校验）。 */
export const ATTR_MATCH_MODEL_TEXT =
  `属性名按池字段匹配：${MATCHABLE_POOL_ATTRS.join("、")}`
  + `；class、title 等不在池字段模型里，永不命中`;

/**
 * target_not_found 报错里的闭集提示（executor.ts 消费）。
 * 由 HINT_SHAPES / MATCHABLE_POOL_ATTRS 生成，不再手抄——形状或属性模型增删时这行自动跟上。
 */
export const HINT_CLOSED_SET_TEXT =
  `hint 语法是 ${HINT_SHAPES.length} 形状闭集（${HINT_TOKEN_LINE_CN}；`
  + `${ATTR_MATCH_MODEL_TEXT}）——`
  + `容器/后代 CSS（如 "#outer input"）会被当成一个永不命中的形状，报"matches nothing"而非语法错误`;

/** 英文提示词里的 hint 形状行（plan.ts promptText 消费）。 */
export function hintPromptTokens(): string {
  return HINT_TOKEN_LINE_EN;
}

/** 英文提示词里的信号算子行，每行 `op: 描述`（plan.ts promptText 消费）。 */
export function signalPromptLines(): string[] {
  return Object.entries(SIGNAL_OP_PROMPT).map(([op, d]) => `${op}: ${d}`);
}
