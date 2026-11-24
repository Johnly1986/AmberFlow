/**
 * `row-anchor:check` —— 行锚语义（F82/F83/F84/F85）的**仓内可复现离线断言**。
 *
 * 为什么需要它（架构评审结论）：行锚的验收证据此前全部在仓库外（一次性脚本 /
 * 真站 run 产物 / "95/272/25" 这类计数），`npm run check` 只能证明解析层可加载。评审指出的
 * 三条对外承诺（撞多行零动作 / 编号底座一致 / 记忆可复现）恰恰都在"匹配 + 生成"层，
 * 真站回归不可门禁、probe 期望又过宽。本工具用合成 ElemPool 把这几条语义钉死，
 * 随 `npm run check` 进 PR 门禁（纯内存、零浏览器、零网络）。
 *
 * 覆盖：
 *   ① 行锚声明下多候选 = 零动作（hintMatch null / hintCandidates refs>1 decided null）；
 *   ② 单命中 / 组合守卫仍正常解析；未声明行锚的 firstIfSame 语义逐字节不变；
 *   ③ rowMatch fail-closed（无 row_texts / 跨行不拼接 / 小写折叠）；
 *   ④ 恢复面前置：identityHintInfo 对行锚声明 ineligible（FW8 不按 base 丢行约束）；
 *   ⑤ 记忆面：只学内容锚（in-row），禁产单用 row-index；tokenAllow 下传；
 *   ⑥ 生成纪律：inspect/observe 面仍产单用 row-index（供作者手写），allow 表可救 SKU 词元。
 *
 * 边界：不给真实页面编号打点（那需要四个 web pass，属真站证据）；编号/标签口径的跨面
 * 对齐由 `__rowLabelOf` + 可见性编号在代码层保证，残余边界写进 docs（池元素宇宙 vs ADMIT_SEL）。
 */
import {
  parseHint, rowIndexValueProblem, inRowValueProblem,
} from "../src/engine/hint.ts";
import { hintCandidates, hintMatch, rowMatch, suggestHints } from "../src/engine/rules.ts";
import { identityHintInfo } from "../src/engine/identity.ts";
import { induceHint } from "../src/model/hint-memory.ts";
import type { Elem, ElemPool } from "../src/engine/extraction.ts";

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.error(`  ✗ ${name}${detail === undefined ? "" : ` —— ${detail}`}`);
}

/** 合成池行：同文案按钮网格的最小形状（tag/label 相同 = 同签名；行锚底座由 row_* 区分）。 */
function row(
  ref: string, scan: number,
  extra: Partial<Elem> = {},
): Elem {
  return {
    ref, scan, tag: "button", label: "add to basket", full_label: "add to basket",
    ...extra,
  } as Elem;
}

function poolOf(rows: Elem[]): ElemPool {
  return Object.fromEntries(rows.map((r) => [String(r.ref), r]));
}

/* ① 行锚声明 = 多候选零动作（P0 承诺） ------------------------------------------ */
{
  // 两行都含 token（同名商品重复卡片 / 共享词），签名完全相同 → 旧语义会 firstIfSame 合并首行。
  const pool = poolOf([
    row("e0", 100, { row_texts: ["it's only the himalayas 45.17"], row_index: 1 }),
    row("e1", 200, { row_texts: ["the himalayas trip 32.00"], row_index: 2 }),
  ]);
  check("in-row 撞多行：hintMatch 必须 null（绝不取首行）", hintMatch("add to basket in-row:himalayas", pool) === null);
  const cand = hintCandidates("add to basket in-row:himalayas", pool);
  check("in-row 撞多行：hintCandidates 保留全部候选（歧义证据）",
    cand !== null && cand.refs.length === 2 && cand.decided === null,
    JSON.stringify(cand));
  // 单命中：行内容唯一 → 正常解析（不把 fail-closed 变成过度拒绝）。
  check("in-row 单命中：hintMatch 命中唯一行",
    hintMatch("add to basket in-row:trip", pool) === "e1");
  // 组合守卫：row-index + in-row 双条件 AND。
  check("组合守卫（row-index+in-row 同行走同一行）",
    hintMatch("add to basket row-index:2 in-row:himalayas", pool) === "e1");
  check("组合守卫内容不符 = 显式落空",
    hintMatch("add to basket row-index:1 in-row:trip", pool) === null);
  // row-index 单用越界 / 撞多组。
  check("row-index 越界落空", hintMatch("add to basket row-index:9", pool) === null);
  const twoGroups = poolOf([
    row("a1", 100, { row_index: 1 }), row("a2", 200, { row_index: 2 }),
    row("b1", 300, { label: "buy now", full_label: "buy now", row_index: 1 }),
    row("b2", 400, { label: "buy now", full_label: "buy now", row_index: 2 }),
  ]);
  check("row-index 撞多组（同序成员）→ 零动作",
    hintMatch("button row-index:1", twoGroups) === null);
  const twoCand = hintCandidates("button row-index:1", twoGroups);
  check("row-index 撞多组：候选全量保留",
    twoCand !== null && twoCand.refs.length === 2 && twoCand.decided === null,
    JSON.stringify(twoCand));
}

/* ② 未声明行锚：firstIfSame 既有语义逐字节不变 -------------------------------- */
{
  // bbc 两条相同 /news 链接：同签名可互换 = 允许取首行（旧行为，行锚不得改变它）。
  const pool = poolOf([
    row("n0", 100, { tag: "a", label: "news", full_label: "news", href: "/news" }),
    row("n1", 200, { tag: "a", label: "news", full_label: "news", href: "/news" }),
  ]);
  check("未声明行锚：同签名候选仍按 firstIfSame 取首行（旧语义不变）",
    hintMatch("news", pool) === "n0");
}

/* ③ rowMatch 的 fail-closed 与归一口径 --------------------------------------- */
{
  check("无 row_texts ⇒ in-row 恒不命中（fail-closed 对称）",
    !rowMatch(row("x", 1), "himalayas"));
  check("row_texts 任一行 includes（小写折叠，不跨行拼接）",
    rowMatch(row("x", 1, { row_texts: ["It's Only the Himalayas", "45.17"] }), "himalayas")
    && !rowMatch(row("x", 1, { row_texts: ["himal", "ayas"] }), "himalayas"));
}

/* ④ 恢复面前置：行锚声明时 FW8/DRF/F64 不参与恢复（不按 base 丢行约束） ------- */
{
  check("identityHintInfo：带 in-row 的身份形状 ineligible（row-anchor）",
    identityHintInfo("[data-test=add] in-row:zzz-missing").eligible === false,
    JSON.stringify(identityHintInfo("[data-test=add] in-row:zzz-missing")));
  check("identityHintInfo：带 row-index 的身份形状 ineligible（row-anchor）",
    identityHintInfo("[data-test=add] row-index:3").eligible === false);
  check("identityHintInfo：不带行锚的身份形状仍 eligible（旧行为不变）",
    identityHintInfo("[data-test=add]").eligible === true);
}

/* ⑤ 记忆面：只学内容锚，禁产单用 row-index；tokenAllow 下传 ------------------- */
{
  // 内容不可分网格（两行行文本完全相同）：suggestHints 会产单用 row-index（供作者手写），
  // 但 induceHint 不得把它固化成 learned hint。
  const indistinct = poolOf([
    row("e0", 100, { row_texts: ["add to basket"], row_index: 1 }),
    row("e1", 200, { row_texts: ["add to basket"], row_index: 2 }),
  ]);
  const suggested = suggestHints(indistinct.e0!, indistinct);
  check("inspect/observe 面：内容不可分时仍产单用 row-index 候选（作者手写入口）",
    suggested.some((h) => h.includes(" row-index:")), JSON.stringify(suggested));
  const learnedPositional = induceHint(indistinct.e0!, indistinct);
  check("记忆面：不得学单用 row-index（位置性 hint 不跨运行固化）",
    learnedPositional !== null && !/ row-index:/.test(learnedPositional),
    String(learnedPositional));

  // 内容可分：记忆面学 `in-row:<token>` 内容候选（且不与位置序号拼用）。
  const distinct = poolOf([
    row("e0", 100, { row_texts: ["it's only the himalayas 45.17"], row_index: 1 }),
    row("e1", 200, { row_texts: ["the himalayas trip 32.00"], row_index: 2 }),
  ]);
  const learnedContent = induceHint(distinct.e0!, distinct);
  check("记忆面：内容可分时学 in-row 内容锚", learnedContent !== null && learnedContent.includes(" in-row:"),
    String(learnedContent));

  // tokenAllow 下传：SKU 纯数字词元被价格护栏拒绝，allow 表放行后出现在候选里。
  const sku = poolOf([
    row("s0", 100, { row_texts: ["sku 45021"], row_index: 1 }),
    row("s1", 200, { row_texts: ["sku 99999"], row_index: 2 }),
  ]);
  const noAllow = suggestHints(sku.s0!, sku);
  const withAllow = suggestHints(sku.s0!, sku, { tokenAllow: ["45021"] });
  check("hint_token_allow：未放行时 SKU 纯数字词元不进候选",
    !noAllow.some((h) => h.includes("in-row:45021")), JSON.stringify(noAllow));
  check("hint_token_allow：放行后 SKU 词元进候选（结构约束仍由 tokenOk 兜底）",
    withAllow.some((h) => h.includes("in-row:45021")), JSON.stringify(withAllow));
  const learnedSku = induceHint(sku.s0!, sku, { tokenAllow: ["45021"] });
  check("hint_token_allow：记忆生成面同口径（record 面下传）",
    learnedSku !== null && learnedSku.includes("in-row:45021"), String(learnedSku));
}

/* ⑥ 解析层边界（尾缀闭集 / 整组回退） --------------------------------------- */
{
  check("row-index 从 1 开始（0/负数整组回退）",
    parseHint("button row-index:0").rowIndex === undefined
    && parseHint("button row-index:-1").rowIndex === undefined
    && rowIndexValueProblem("0")?.kind === "not-positive-integer");
  check("row-index 9 位上限", parseHint("button row-index:999999999").rowIndex === 999999999
    && rowIndexValueProblem("9999999999")?.kind === "too-many-digits");
  check("in-row token 禁 > / ≤40",
    inRowValueProblem("a>b")?.kind === "has-gt"
    && inRowValueProblem("x".repeat(41))?.kind === "too-long");
  // 兼容性记录（评审 D）：尾部字面量恰为保留词的旧 hint 语义会变——文档需列保留词；
  // 这里把它钉成显式事实，防止"无尾缀 hint 逐字节不变"被理解成无条件。
  const legacy = parseHint("查看 row-index:3");
  check("兼容性事实：尾部 ` row-index:N` 字面量现在被当尾缀（文档已列保留词风险）",
    legacy.kind === "bare" && legacy.token === "查看" && legacy.rowIndex === 3,
    JSON.stringify(legacy));
}

if (failures > 0) {
  console.error(`row-anchor:check: ${failures}/${checks} assertion(s) failed`);
  process.exit(1);
}
console.log(`row-anchor:check: ${checks} assertions passed (synthetic pool; no browser)`);
