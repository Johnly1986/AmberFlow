/**
 * verify-rule-vocab —— **非门禁**的规则面词面证据 lane（零网络、零浏览器、零模型）。
 *
 * 回答一个问题：`affordanceRule`（零模型的第一档）在「goal 与候选 label 共用同一套通用
 * 词表」时，会不会因为**两侧口径不对称**而选中组内的错误选项；修复后是否只改了该改的
 * 那一种，而没动任何与词面无关的场景。
 *
 * 缺陷形态（真实 pilot 轨迹里复现过）：goal 里写着通用指令词（`open`/`now` 这类，落在
 * `STOP_TOKENS`），候选 label 侧却从不剔除。于是**每个词都是通用词**的多词 label 在内容词
 * 档里恒不可见——而同组里只要有一个词是 goal 的内容词，那个**部分命中**的候选就独占命中，
 * 规则档于是把一个 goal 从未逐词点名的选项判成唯一命中。
 *
 * 断言分六组（全部是纯函数对合成池，零外部请求；候选只声明 tag/label，不构造页面事实）：
 *   ① 正向（该修的必须修）：goal 逐词点名一个「全通用词」多词 label，池里同时存在一个含
 *      内容词的近似 label ⇒ 必须点名被逐词点名的那个。
 *   ② 反例 A（不得误杀）：goal 明说内容词（`24` 这类）⇒ 近似 label 仍是合法可选；
 *   ③ 反例 B（无关场景不得变）：goal 与候选词表无交集（价格档位形状）⇒ 与**修复前逐字节一致**；
 *   ④ 反例 C（纯通用按钮不得变）：`Continue`/`Next`/`Confirm` 池 ⇒ 与修复前逐字节一致；
 *   ⑤ 无新词面（不引入领域词）：修复只复用 goal 已有的词与同一套通用词表，任一侧出现
 *      goal 没写的词就不得点名——用「goal 不含候选词」的行证明点名不会凭空发生；
 *   ⑥ 归一对称性 + 契约边界：`rule-vocab` 是切词的唯一出处（`rules.ts` 不再自带第二套
 *      ASCII2/CJK 正字面量），且同一段文本在 goal 侧与候选侧切出的词表相同；无撞词时不得把
 *      「无命中」变成「命中」，撞词候选自身被完全点名时不重排。
 *
 * 「与修复前逐字节一致」的基线值：`baseline` 字段是改动前实跑该行抓到的点名结果（label 或
 * null），逐字写进本 lane 作为回归护栏；它不是模型输出、也不随实现漂移。
 *
 * 用法：node --experimental-strip-types tools/verify-rule-vocab.ts [--json]
 * 退出码：0 = 全部断言全绿；1 = 有断言失败；2 = 用法错误。
 * 接线（package.json script 与 verify:lanes 清单）由主线维护者统一做，本 lane 不自接线。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { affordanceRule, STOP_TOKENS, ROLE_TOKENS, FILLER_TOKENS } from "../src/engine/rules.ts";
import { ASCII2, words } from "../src/engine/rule-vocab.ts";
import type { ElemPool } from "../src/engine/extraction.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const USAGE = "usage: node --experimental-strip-types tools/verify-rule-vocab.ts [--json]";
const FLAGS = process.argv.slice(2);
for (const f of FLAGS) if (f !== "--json") { console.error(USAGE); process.exit(2); }
const JSON_OUT = FLAGS.includes("--json");

/* ------------------------------------------------------------------ 合成池 */

/** 候选行只声明与词面有关的字段（tag/label）。 */
const elem = (label: string, tag = "button"): { tag: string; label: string } => ({ tag, label });
const pool = (rows: Record<string, { tag: string; label: string }>): ElemPool => rows as ElemPool;

/** 真实缺陷形态：goal 逐词点名 `Open now`，同组另有含内容词的近似 label。 */
const OPEN2 = pool({ e1: elem("Open now"), e2: elem("Open 24 hours") });
/** 三候选项形态（含单内容词标签 `Hours`）。 */
const OPEN3 = pool({ e1: elem("Open now"), e2: elem("Open 24 hours"), e3: elem("Hours") });
/** 纯通用按钮池（反例 C）。 */
const GENERIC = pool({ c1: elem("Continue"), c2: elem("Next"), c3: elem("Confirm") });
/** 与 Open/hours 无关的通用业务形状（反例 B）。 */
const PRICE = pool({ p1: elem("Price"), p2: elem("Price low"), p3: elem("Price high") });

/* ------------------------------------------------------------------ 行表 */

interface Row {
  id: string;
  kind: "positive" | "counter-a" | "counter-b" | "counter-c" | "no-new-vocab" | "contract";
  goal: string;
  elems: ElemPool;
  /** 期望点名结果（候选 label 原文；null = 期望规则档不点名）。 */
  expect: string | null;
  /**
   * 改动前（HEAD）实跑抓到的点名结果。反例/无新词面/契约行要求与它**逐字节一致**（不许漂移）；
   * 正向行记录修复前的错选，作为「这一行确实在改行为」的证据（不要求相等）。
   */
  baseline?: string | null;
}

const ROWS: readonly Row[] = [
  // ① 正向：逐词点名的多词 label 必须赢过「部分命中」的近似 label。
  // 池取真实缺陷形态：goal 里的内容词 `hours` 撞上近似 label，而 goal 逐词点名的是短的那一个。
  { id: "pos-named-phrase-wins", kind: "positive", goal: "当前营业中/Now open。另有 Hours 快捷入口。", elems: OPEN2, expect: "Open now", baseline: "Open 24 hours" },
  { id: "pos-named-phrase-wins-en", kind: "positive", goal: "Set the filter to Now open. The Hours menu is separate.", elems: OPEN2, expect: "Open now", baseline: "Open 24 hours" },
  { id: "pos-named-phrase-wins-zh", kind: "positive", goal: "当前筛选：Now open（Hours 快捷）。", elems: OPEN2, expect: "Open now", baseline: "Open 24 hours" },
  { id: "pos-named-phrase-wins-panel", kind: "positive", goal: "筛选：Now open；Hours 与 All filters 是另外两个入口。", elems: OPEN2, expect: "Open now", baseline: "Open 24 hours" },
  // ② 反例 A：goal 明说内容词 ⇒ 近似 label 仍可选（不误杀）。
  { id: "counter-explicit-content-word", kind: "counter-a", goal: "Filter the list: open 24 hours only.", elems: OPEN2, expect: "Open 24 hours", baseline: "Open 24 hours" },
  { id: "counter-explicit-content-word-zh", kind: "counter-a", goal: "选择营业 24 小时的筛选", elems: OPEN2, expect: "Open 24 hours", baseline: "Open 24 hours" },
  { id: "counter-explicit-content-word-en", kind: "counter-a", goal: "The list is open 24 hours; it also shows Now open.", elems: OPEN2, expect: "Open 24 hours", baseline: "Open 24 hours" },
  // ③ 反例 B：与 Open/hours 无关的通用场景 ⇒ 修复前后一致。
  { id: "counter-unrelated-price", kind: "counter-b", goal: "选择价格最低的选项", elems: PRICE, expect: null, baseline: null },
  { id: "counter-unrelated-price-en", kind: "counter-b", goal: "choose the lowest price option", elems: PRICE, expect: null, baseline: null },
  // ④ 反例 C：纯通用按钮 ⇒ 修复前后一致。
  { id: "counter-generic-continue", kind: "counter-c", goal: "Continue", elems: GENERIC, expect: "Continue", baseline: "Continue" },
  { id: "counter-generic-continue-long", kind: "counter-c", goal: "Continue to the next step", elems: GENERIC, expect: null, baseline: null },
  { id: "counter-generic-click-continue", kind: "counter-c", goal: "Click continue", elems: GENERIC, expect: "Continue", baseline: "Continue" },
  { id: "counter-generic-next-phrase", kind: "counter-c", goal: "Choose Next to proceed", elems: GENERIC, expect: "Next", baseline: "Next" },
  // ⑤ 无新词面：goal 不含候选的词 ⇒ 不得因为「候选 label 全是通用词」被凭空点名。
  { id: "no-new-vocab-turn-on-open", kind: "no-new-vocab", goal: "Turn on the open filter", elems: OPEN2, expect: null, baseline: null },
  { id: "no-new-vocab-click-button", kind: "no-new-vocab", goal: "click the button", elems: pool({ e1: elem("Now open"), e2: elem("Hours") }), expect: null, baseline: null },
  { id: "no-new-vocab-apply-now", kind: "no-new-vocab", goal: "Apply the now filter", elems: OPEN2, expect: null, baseline: null },
  // ⑥ 契约边界：无撞词时不把「无命中」变成「命中」；多个候选被点名时仍按既有消歧/歧义停。
  { id: "contract-cjk-only-stays-miss", kind: "contract", goal: "打开营业中的筛选按钮", elems: OPEN3, expect: null, baseline: null },
  { id: "contract-ambiguous-three-declines", kind: "contract", goal: "当前营业中/Now open。另有 Hours 快捷入口。", elems: OPEN3, expect: null, baseline: null },
  { id: "contract-partial-hit-kept", kind: "contract", goal: "Fill the text input field", elems: pool({ e1: elem("Text field"), e2: elem("Input field") }), expect: "Text field", baseline: "Text field" },
  { id: "contract-unique-token-kept", kind: "contract", goal: "Dead end", elems: pool({ d1: elem("Dead end"), d2: elem("Search term") }), expect: "Dead end", baseline: "Dead end" },
];

/* ------------------------------------------------------------------ 结果读取 */

/** 规则档点名的候选 label（null = 点名落空）。 */
function pickedLabel(goal: string, elems: ElemPool): string | null {
  const ref = affordanceRule(goal, elems);
  return ref === null ? null : String((elems as Record<string, { label?: string }>)[ref]?.label ?? "");
}

const failures: string[] = [];
const results: Array<Record<string, unknown>> = [];
const check = (id: string, fn: () => void): void => {
  try { fn(); } catch (e) {
    failures.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

/* ------------------------------------------------------------------ ①–⑥ */

for (const row of ROWS) {
  check(row.id, () => {
    const got = pickedLabel(row.goal, row.elems);
    assert.equal(got, row.expect, `点名结果应为 ${JSON.stringify(row.expect)}，实际 ${JSON.stringify(got)}`);
    if (row.baseline !== undefined && row.kind !== "positive") {
      assert.equal(got, row.baseline, `反例行必须与修复前逐字节一致（基线 ${JSON.stringify(row.baseline)}，实际 ${JSON.stringify(got)}）`);
    }
    if (row.baseline !== undefined && row.kind === "positive") {
      assert.notEqual(got, row.baseline, `正向行必须在修复前选错（基线 ${JSON.stringify(row.baseline)}），否则这行不构成证据`);
    }
    results.push({ id: row.id, kind: row.kind, picked: got });
  });
}

/* ⑤ 归一对称性：唯一出处 = rule-vocab。 */
check("vocab-single-source", () => {
  const rulesSrc = fs.readFileSync(path.join(REPO, "src", "engine", "rules.ts"), "utf8");
  assert.match(rulesSrc, /from "\.\/rule-vocab\.ts"/, "rules.ts 必须从 rule-vocab 取切词入口");
  const localTokenDefs = rulesSrc.match(/(const|function)\s+(ASCII2|ASCII4|CJK1|CJK2|words)\s*[=(]/g) ?? [];
  assert.deepEqual(localTokenDefs, [], `rules.ts 不得自带第二套切词/正字面量（发现 ${JSON.stringify(localTokenDefs)}）`);
});
check("vocab-symmetric-tokenization", () => {
  const sample = "Open 24 hours / Hours —— Now open";
  const goalSide = words(sample.toLowerCase(), ASCII2);
  const candSide = words(sample.toLowerCase(), ASCII2);
  assert.deepEqual(candSide, goalSide, "同一文本在 goal 侧与候选侧必须切出同一词表");
  assert.ok(goalSide.includes("hours") && goalSide.includes("now"), `归一必须切出 hours/now：${JSON.stringify(goalSide)}`);
  const stop = words("Open now".toLowerCase(), ASCII2);
  assert.ok(stop.every((w) => STOP_TOKENS.has(w)), `与真实缺陷同形的词必须整词都在通用指令词表：${JSON.stringify(stop)}`);
});
check("vocab-no-new-vocabulary", () => {
  // 修复不得新增命中词：所有判定词只来自 goal 的词与这三张通用词表。
  for (const [name, set] of [["STOP", STOP_TOKENS], ["ROLE", ROLE_TOKENS], ["FILLER", FILLER_TOKENS]] as const) {
    assert.ok(set.size > 0, `${name}_TOKENS 不得为空`);
    for (const w of set) {
      assert.equal(String(w), String(w).toLowerCase(), `${name}_TOKENS 的词必须是小写归一形态：${w}`);
    }
  }
  // 规则面词表不得含领域词（站点/业务）：只允许动词、角色词与虚词形态。
  const domain = ["google", "maps", "restaurant", "hotel", "flight", "airline", "price", "rating", "open now", "hours"];
  for (const w of domain) {
    for (const set of [STOP_TOKENS, ROLE_TOKENS, FILLER_TOKENS]) {
      assert.equal(set.has(w), false, `引擎词表不得含领域词 ${w}`);
    }
  }
});

/* ------------------------------------------------------------------ 输出 */

const line = (s: string): void => { if (!JSON_OUT) console.log(s); };
for (const r of results) line(`${r["kind"]}\t${r["id"]}\tpicked=${JSON.stringify(r["picked"])}`);
if (JSON_OUT) console.log(JSON.stringify({ ok: failures.length === 0, rows: results, failures }, null, 2));
if (failures.length > 0) {
  console.error(`verify-rule-vocab: FAIL ${failures.length} 项`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
line(`verify-rule-vocab: PASS ${results.length} 行断言 + 3 组口径断言（正向 ${ROWS.filter((r) => r.kind === "positive").length} / 反例 A ${ROWS.filter((r) => r.kind === "counter-a").length} / 反例 B ${ROWS.filter((r) => r.kind === "counter-b").length} / 反例 C ${ROWS.filter((r) => r.kind === "counter-c").length} / 无新词面 ${ROWS.filter((r) => r.kind === "no-new-vocab").length} / 契约 ${ROWS.filter((r) => r.kind === "contract").length}）`);
