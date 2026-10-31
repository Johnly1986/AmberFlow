/**
 * prompt-hit —— 「提示词怎么说」↔「实现认什么」的离线闸门（不开浏览器、不调模型）。
 *
 * 语法描述的唯一出处是 `src/engine/grammar-prompt.ts`（import 时已自证与 `parseHint` /
 * `SIGNAL_OPS` 对齐）；本工具按**组**校验（文档引用组名，不引用编号——插组不失准）：
 *
 *   grammar  HINT_SHAPES 示例逐个被唯一解析器解析成声明形状；SIGNAL_OP_PROMPT 与
 *            SIGNAL_OPS 键集合双向一致（多写/漏写都红）。
 *   pool     每个示例 hint 在合成元素池上 `hintMatch` **恰好命中一个**预期元素
 *            （示例可直接照抄）；防御性反例：容器/后代 CSS `#outer input` 永不命中、
 *            多候选裸词宁缺勿错（返回 null 而不是猜）。
 *   plan     代表性信号样本（all_of 组合、未知算子、空 all_of、manual、参数个数）过
 *            `validateSignalSpec`，判定与 SIGNAL_OP_PROMPT 的声明一致。
 *   bridge   `integrations/dsh-bridge/src/grammar.generated.ts` 与引擎侧真源同步
 *            （grammar + playbook + escalation + overview）。桥纪律 "called, not
 *            embedded"：不 import 引擎代码，语法以**生成物**分发——`--fix` 重新生成；
 *            不带 --fix 时漂移即红（接进 `npm run check`）。
 *   doc      `docs/APP_SCRIPT_AUTHORING.md` 逐字包含 ATTR_MATCH_MODEL_TEXT /
 *            PLAN_PLAYBOOK_TEXT / FAILURE_SIGNS_TEXT——文档也是消费面，关键句不许手抄。
 *   overview 概述层（层 1）多面一致：AGENTS.md 逐字含 OVERVIEW_TEXT；长度预算
 *            （概述 ≤400 字符、when ≤40、flow ≤4 行）；registry when ↔ help-map
 *            WHEN_TO_USE 双向一致；概述进桥生成物。
 *   coverage 提示层（层 3）完整性：STOPCODE_MEANING 键集 ⊆ STOP_NEXT ∪ EXEMPT_NEXT；
 *            CLI `next:` 无死链；同一事实（--max-steps=执行预算）三处抽查一致。
 *
 * 三层提示词系统的设计出处：docs/PROMPT_SYSTEM.md。
 * 退出码：0 全绿 / 1 有不一致。
 * 用法：node --experimental-strip-types tools/prompt-hit.ts [--fix]
 */
import fs from "node:fs";
import path from "node:path";
import { REPO } from "../src/support/paths.ts";
import { parseHint } from "../src/engine/hint.ts";
import { SIGNAL_OPS } from "../src/engine/signal-ops.ts";
import { HINT_SHAPES, SIGNAL_OP_PROMPT, ATTR_MATCH_MODEL_TEXT } from "../src/engine/grammar-prompt.ts";
import { PLAN_PLAYBOOK_TEXT, FAILURE_SIGNS_TEXT, PLAN_PLAYBOOK_SHORT, STOP_ESCALATION_TEXT, EXEMPT_NEXT, nextForStop } from "../src/engine/planning-playbook.ts";
import { hintMatch } from "../src/engine/rules.ts";
import { validateSignalSpec } from "../src/engine/signals.ts";
import { OVERVIEW_TEXT, WHEN_TO_USE } from "../src/support/help-map.ts";
import { STOPCODE_MEANING } from "../src/support/schema-gen.ts";
import { COMMANDS, commandSpec } from "../src/cli/registry.ts";

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
void fix; // --fix 只在 bridge 组的写入分支里生效；此处引用防止未用告警。

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

/* ---- 4. bridge：生成物 ↔ grammar-prompt / planning-playbook / help-map --------- */

const GENERATED = path.join(REPO, "integrations", "dsh-bridge", "src", "grammar.generated.ts");

function bridgeGenerated(): string {
  const tokens = HINT_SHAPES.map((s) => s.en);
  const note =
    `A hint is a STABLE-HANDLE CLOSED SET of ${tokens.length} shapes (${tokens.join(" | ")}; `
    + `only test=data-test and type attribute names take part in matching), NOT arbitrary CSS - `
    + `container/descendant selectors (e.g. "#outer input") parse but can never match (target_not_found).`;
  const playbookShort = PLAN_PLAYBOOK_SHORT;
  return `/**
 * 生成物（勿手改）：由 \`src/engine/grammar-prompt.ts\`、\`src/engine/planning-playbook.ts\`
 * 与 \`src/support/help-map.ts\` 经 \`npm run prompt-hit\` 生成与校验。桥纪律
 * "called, not embedded"：不 import 引擎代码，语法、规划引导与概述层以**字符串**
 * 分发到这里。先改引擎模块，再跑 \`npm run prompt-hit\`（本文件漂移会让
 * \`npm run check\` 红）。
 */

export const HINT_SHAPE_TOKENS: readonly string[] = ${JSON.stringify(tokens, null, 2)};

export const HINT_LEARN_NOTE = ${JSON.stringify(note)};

export const PLAN_PLAYBOOK_SHORT = ${JSON.stringify(playbookShort)};

export const STOP_ESCALATION_TEXT = ${JSON.stringify(STOP_ESCALATION_TEXT)};

export const OVERVIEW_TEXT = ${JSON.stringify(OVERVIEW_TEXT)};
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

/* ---- 7. overview：概述层多面一致 ------------------------------------------- */
// 概述（层 1）的唯一出处是 help-map.ts；AGENTS.md 与桥生成物都必须逐字含它，
// 长度预算（概述 ≤400 字符、when ≤40、flow ≤4 行）也是契约——超限即红。

const AGENTS = path.join(REPO, "AGENTS.md");
const agentsText = fs.existsSync(AGENTS) ? fs.readFileSync(AGENTS, "utf-8") : "";
if (!agentsText.includes(OVERVIEW_TEXT)) {
  problems.push("overview: AGENTS.md 未逐字包含 OVERVIEW_TEXT——从 help-map.ts 逐字复制，勿手抄改写");
}
if (OVERVIEW_TEXT.length > 400) {
  problems.push(`overview: OVERVIEW_TEXT ${OVERVIEW_TEXT.length} 字符超预算（≤400）——索引命中展示空间有限，精简后再分发`);
}
for (const w of WHEN_TO_USE) {
  if (w.when.length > 40) {
    problems.push(`overview: '${w.cmd}' 的 when ${w.when.length} 字符超预算（≤40）`);
  }
}
// registry 的 when 与 help-map 的 WHEN_TO_USE 双向一致：registry 写了 when 就必须同句；
// help-map 有条目而 registry 缺 when，是"何时用"悄悄掉面。
for (const spec of COMMANDS) {
  const hit = WHEN_TO_USE.find((w) => w.cmd === spec.name);
  if (spec.when === undefined && hit !== undefined) {
    problems.push(`overview: registry '${spec.name}' 缺 when 字段（help-map 的 WHEN_TO_USE 有一条）`);
  }
  if (spec.when !== undefined && hit === undefined) {
    problems.push(`overview: registry '${spec.name}' 的 when 在 help-map WHEN_TO_USE 里没有对应条目`);
  }
  if (spec.when !== undefined && hit !== undefined && spec.when !== hit.when) {
    problems.push(`overview: registry '${spec.name}' 的 when 与 help-map 不一致（两处必须逐字相同）`);
  }
  if ((spec.flow?.length ?? 0) > 4) {
    problems.push(`overview: registry '${spec.name}' 的 flow ${spec.flow!.length} 行超预算（≤4）`);
  }
}
for (const w of WHEN_TO_USE) {
  if (!COMMANDS.some((c) => c.name === w.cmd)) {
    problems.push(`overview: WHEN_TO_USE 的 '${w.cmd}' 不是 registry 里的命令——死条目`);
  }
}

/* ---- 8. coverage：提示层完整性 + 无死链 ------------------------------------ */
// 键集闭环：schema 的 STOPCODE_MEANING ⊆ STOP_NEXT ∪ EXEMPT_NEXT——新增停因
// 要么给 next，要么显式豁免（带理由），不会静默漏。CLI 的 next 数组不允许指向
// 已删除命令（死链）。同一事实（max-steps 是执行预算）首页/help/桥三处抽查一致。

for (const code of Object.keys(STOPCODE_MEANING)) {
  if (nextForStop(code) === null && !(code in EXEMPT_NEXT)) {
    problems.push(`coverage: 停因 '${code}' 既无 STOP_NEXT 也无 EXEMPT_NEXT 豁免——补 next 或写豁免理由（planning-playbook.ts）`);
  }
}
for (const code of Object.keys(EXEMPT_NEXT)) {
  if (!(code in STOPCODE_MEANING)) {
    problems.push(`coverage: EXEMPT_NEXT 的 '${code}' 不在 schema STOPCODE_MEANING 里——死豁免，删掉`);
  }
}
{
  // CLI next 死链扫描：src/cli/** 的 `next: [...]` 里出现的 `amber <cmd>` 前缀
  // 必须是 registry 的命令（或 help/version/completion 这类内置入口）。
  // 注意 `amber --help` 是 flag 不是命令名——匹配时跳过 - 开头的 token。
  const builtins = new Set(["help", "version", "completion"]);
  const cliDir = path.join(REPO, "src", "cli");
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
    });
  for (const file of walk(cliDir)) {
    const text = fs.readFileSync(file, "utf-8");
    for (const m of text.matchAll(/next:\s*\[([^\]]*)\]/g)) {
      for (const cmd of m[1]!.matchAll(/["']amber\s+([a-zA-Z][a-z-]*)/g)) {
        const name = cmd[1]!;
        if (!builtins.has(name) && !COMMANDS.some((c) => c.name === name)) {
          problems.push(`coverage: ${path.relative(REPO, file)} 的 next 指向未知命令 'amber ${name}'——死链`);
        }
      }
    }
  }
}
{
  // 同一事实抽查：--max-steps 是执行预算，不是"从第 N 步开始"。三处必须都讲对。
  const budgetPhrase = "执行预算";
  const runSpec = commandSpec("run");
  const runFlagsOk = runSpec?.flags.some((f) => f.includes(budgetPhrase)) ?? false;
  if (!runFlagsOk) {
    problems.push("coverage: registry 'run' 的 --max-steps 旗标描述未包含「执行预算」——与首页/桥同一事实的表述漂移");
  }
  const agentsHasBudget = agentsText.includes("--max-steps N` 是 `ctx.step` / `ctx.arrive` 的执行预算");
  if (!agentsHasBudget) {
    problems.push("coverage: AGENTS.md 的 --max-steps 表述不再含「执行预算」关键句——与 registry 同一事实需一致");
  }
  const bridgeText = fs.readFileSync(GENERATED, "utf-8");
  const bridgeHasBudget = bridgeText.includes("Execution budget") || fs.readFileSync(
    path.join(REPO, "integrations", "dsh-bridge", "src", "index.ts"), "utf-8",
  ).includes("EXECUTION BUDGET");
  if (!bridgeHasBudget) {
    problems.push("coverage: 桥 amberflow_run 的 max_steps 描述未含 EXECUTION BUDGET 关键句——三处同一事实需一致");
  }
}

/* ---- 汇总 ------------------------------------------------------------------ */

if (problems.length) {
  for (const p of problems) console.error(`prompt-hit: ${p}`);
  process.exit(1);
}
// 分组清单式输出：文档引用组名，不引用编号（插组不会让既有引用失准）。
console.log(
  `prompt-hit: OK — grammar/pool/plan/bridge/doc/overview/coverage 七组全绿：`
    + `hint ${HINT_SHAPES.length} 形状全部可解析且示例可命中，`
    + `信号 ${Object.keys(SIGNAL_OPS).length} 算子提示词↔校验器一致，`
    + `停因 ${Object.keys(STOPCODE_MEANING).length} 个 next/豁免全覆盖，`
    + `概述层多面一致（AGENTS.md/桥/长度预算），CLI next 无死链`,
);
