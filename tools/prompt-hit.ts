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
 *            不带 --fix 时漂移即红（接进 `npm run check`）。另守手写闭集的文本漂移：
 *            session 工具 `signal` 描述必须列全 `SIGNAL_OPS` 键；`drive_command.note`
 *            的桥 schema/描述 ↔ 引擎形状校验 ↔ pilot JSONL 行三面一致。
 *   doc      `docs/APP_SCRIPT_AUTHORING.md` 逐字包含 ATTR_MATCH_MODEL_TEXT /
 *            PLAN_PLAYBOOK_TEXT / FAILURE_SIGNS_TEXT——文档也是消费面，关键句不许手抄。
 *   overview 概述层（层 1）多面一致：AGENTS.md 逐字含 OVERVIEW_TEXT；长度预算
 *            （概述 ≤400 字符、when ≤40、flow ≤4 行）；registry when ↔ help-map
 *            WHEN_TO_USE 双向一致；概述进桥生成物。
 *   coverage 提示层（层 3）完整性：STOPCODE_MEANING 键集 ⊆ STOP_NEXT ∪ EXEMPT_NEXT；
 *            CLI `next:` 无死链；同一事实（--max-steps=执行预算）三处抽查一致。
 *   intervention 介入/救援文案六条清单（intervention-texts.ts §6，实施照抄）：
 *            ① texts 每条 zh 非空；② en 可空但渲染器不得拼 zh；③ summary ≤400 字；
 *            ④ human_question ≤120 字；⑤ 人话层（summary/human_question）禁
 *            stopCode 键名/JSON/英文栈；⑥ agent_hint 不含面向人的祈使句。
 *            agent_hint（en 面）经 bridgeGenerated() 以 RESCUE_AGENT_HINTS 导出
 *            进桥生成物（called, not embedded 纪律不变）。
 *   model    模型决策提示词单源（P0-0.4）：11 条唯一文本 / 25 处消费点收进
 *            `src/prompts/model-prompts.ts`；本组断言 ①id 唯一且消费点=25
 *            ②文本无重复 ③长度预算（默认 ≤400）④输出契约关键句
 *            ⑤无站点/业务专名（picker 电商动作目录=显式 legacy 例外）
 *            ⑥消费面不再手写同句 ⑦tools/golden/prompts/snapshot.json 快照 hash 一致。
 *   agent    Agent 规划面单源：`plan.rules` 收进 `src/prompts/agent-prompts.ts`，
 *            断言 ①spec 形状/预算/消费点 ②plan.ts 只装配不手抄 ③逐字节冻结
 *            （sha256 基线）④默认/变体 ≤ 预算 ⑤playbook short ≤500 / full ≤2200
 *            ⑥CANDIDATE_WINDOW_TEXT 数字由 tuning/elem-model 常量渲染。
 *   evidence 决策证据载荷 spec/预算/快照：`src/prompts/evidence-prompts.ts`
 *            闭集 5 条，断言 ①都有 version/budget/consumers ②候选渲染分级预算
 *            （40≤6k / 120≤12k / 200 帽≤20k，合成池实测）③单档预算（state_text 320 /
 *            state_digest 200B / site_facts 700 / notes 80）④契约句 ⑤无站点名
 *            ⑥tools/golden/prompts/evidence.json 快照 hash 一致（不改截断行为）。
 *   bridge_desc 桥工具描述覆盖（**warn-only**）：扫 dsh-bridge `index.ts` 与生成物
 *            `run-contract.generated.ts` 的 description 字符串——长度 ≤800/条、
 *            `amber <cmd>` 死链、站点/业务专名；命中只打 warn（退出码不受影响），
 *            并输出统计行（N/总数）。
 *   clarity  Agent/用户面提示词语义清晰度（fail）：overview/playbook/failure_signs/
 *            stop_escalation/stop_next/exempt/grammar 文案——禁模糊措辞（尽量/也许/大概/
 *            可能/视情况…）、禁双重否定、禁 TODO/待定；单句 ≤200 字符；STOP_NEXT ≤120；
 *            概述必须含「什么时候用 / 从哪开始」两段；HOME_NEXT why ≤40。
 *
 * 三层提示词系统的设计出处：docs/PROMPT_SYSTEM.md。
 * 退出码：0 全绿 / 1 有不一致。
 * 用法：node --experimental-strip-types tools/prompt-hit.ts [--fix]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "../src/support/paths.ts";
import { parseHint } from "../src/engine/hint.ts";
import { SIGNAL_OPS } from "../src/engine/signal-ops.ts";
import {
  HINT_SHAPES, HINT_FRAME_SUFFIX, SIGNAL_OP_PROMPT, ATTR_MATCH_MODEL_TEXT,
  CANDIDATE_WINDOW_TEXT, HINT_CLOSED_SET_TEXT, hintPromptTokens, signalPromptLines,
} from "../src/engine/grammar-prompt.ts";
import { PLAN_PLAYBOOK_TEXT, FAILURE_SIGNS_TEXT, PLAN_PLAYBOOK_SHORT, STOP_ESCALATION_TEXT, STOP_NEXT, EXEMPT_NEXT, nextForStop } from "../src/engine/planning-playbook.ts";
import { hintMatch } from "../src/engine/rules.ts";
import { validateSignalSpec } from "../src/engine/signals.ts";
import {
  driveCommandLine, driveCommandProblem, SESSION_DRIVE_NOTE_MAX_CHARS,
} from "../src/app/session-runtime-contract.ts";
import { HOME_NEXT, OVERVIEW_TEXT, WHEN_TO_USE } from "../src/support/help-map.ts";
import { STOPCODE_MEANING, EXECUTOR_ONLY_STOPCODES, RESCUE_RESULT_SHAPE_TEXT, RESCUE_SHADOW_SWITCH_TEXT } from "../src/cli/schema-gen.ts";
import { COMMANDS, commandSpec, helpCommandsPayload } from "../src/cli/registry.ts";
import { RESCUE_TEXTS, SIGNAL_NOT_HELD_TEXT, OUTCOME_TEXTS, FULFILLED_NOT_HELD_TEXT } from "../src/support/intervention-texts.ts";
import { PROMPT_SPECS, renderedPrompts, SAMPLE_GOAL } from "../src/prompts/model-prompts.ts";
import { AGENT_PROMPT_SPECS, PLAN_RULES_SPEC, buildPlanRulesPrompt } from "../src/prompts/agent-prompts.ts";
import {
  EVIDENCE_SPECS, buildEvidence, type EvidenceRenderers,
} from "../src/prompts/evidence-prompts.ts";
import { PlanningRules } from "../src/engine/plan.ts";
import { criteriaView, stateText, POOL_QUOTAS } from "../src/engine/extraction.ts";
import { renderModelFence, type MatchedSiteFact } from "../src/app/site-facts.ts";
import { STATE_DIGEST_MAX_BYTES } from "../src/engine/executor-types.ts";
import { POOL_CAP_ELEMENTS, WIDE_SCAN_POOL_ELEMENTS, STATE_TEXT_BUDGET_CHARS } from "../src/support/tuning.ts";

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
// A 批（frame:<origin> 帧限定尾缀）断言 1：合法剥离——2 段 origin 链（外→内）落进 frameChain，
// 基形状不受影响；导出示例（单段）同样可解析。
const frameChainOk = parseHint(`button frame:https://a.example>https://b.example`);
if (frameChainOk.kind !== "tag"
    || JSON.stringify(frameChainOk.frameChain) !== JSON.stringify(["https://a.example", "https://b.example"])) {
  problems.push(`grammar: 2 段 frame 链示例解析为 kind=${frameChainOk.kind}, frameChain=${JSON.stringify(frameChainOk.frameChain)}——期望 tag + ['https://a.example','https://b.example']`);
}
const frameExampleOk = parseHint(HINT_FRAME_SUFFIX.example);
if (frameExampleOk.kind !== "bare"
    || JSON.stringify(frameExampleOk.frameChain) !== JSON.stringify(["https://checkout.example.com"])) {
  problems.push(`grammar: HINT_FRAME_SUFFIX 示例 '${HINT_FRAME_SUFFIX.example}' 解析为 kind=${frameExampleOk.kind}, frameChain=${JSON.stringify(frameExampleOk.frameChain)}`);
}
// A 批断言 2：双 frame 后缀 = 超限 ⇒ **整组拒绝**（原始串回退成裸词落空，绝不半剥/取第一个）。
const frameDouble = parseHint("button frame:https://a.example frame:https://b.example");
if (frameDouble.frameChain !== undefined || frameDouble.kind !== "bare"
    || frameDouble.token !== "button frame:https://a.example frame:https://b.example") {
  problems.push(`grammar: 双 frame 后缀解析为 kind=${frameDouble.kind}, frameChain=${JSON.stringify(frameDouble.frameChain)}——必须整组拒绝（原始串按裸词落空）`);
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

/* ---- 4. bridge：生成物 ↔ grammar-prompt / planning-playbook / help-map --------- */

const GENERATED = path.join(REPO, "integrations", "dsh-bridge", "src", "grammar.generated.ts");

function bridgeGenerated(): string {
  const tokens = HINT_SHAPES.map((s) => s.en);
  const note =
    `A hint is a STABLE-HANDLE CLOSED SET of ${tokens.length} shapes (${tokens.join(" | ")}; `
    + `only test=data-test, type and aria-label attribute names take part in matching), NOT arbitrary CSS - `
    + `container/descendant selectors (e.g. "#outer input") parse but can never match (target_not_found).`;
  const playbookShort = PLAN_PLAYBOOK_SHORT;
  // 求援 agent_hint（en 面）的生成投影：三键 fact/recommended_action/stop_condition
  // 按既有条目同款形状导出（RESCUE_AGENT_HINTS）。渲染面（zh）留在引擎侧，
  // 桥只分发机器层——called, not embedded 纪律。
  const rescueAgentHints = Object.fromEntries(
    Object.entries(RESCUE_TEXTS).map(([kind, t]) => [kind, t.agent_hint]),
  );
  return `/**
 * 生成物（勿手改）：由 \`src/engine/grammar-prompt.ts\`、\`src/engine/planning-playbook.ts\`、
 * \`src/support/help-map.ts\` 与 \`src/support/intervention-texts.ts\` 经 \`npm run prompt-hit\`
 * 生成与校验。桥纪律 "called, not embedded"：不 import 引擎代码，语法、规划引导、概述层
 * 与求援 agent_hint 以**字符串**分发到这里。先改引擎模块，再跑 \`npm run prompt-hit\`
 * （本文件漂移会让 \`npm run check\` 红）。
 */

export const HINT_SHAPE_TOKENS: readonly string[] = ${JSON.stringify(tokens, null, 2)};

export const HINT_LEARN_NOTE = ${JSON.stringify(note)};

export const PLAN_PLAYBOOK_SHORT = ${JSON.stringify(playbookShort)};

export const STOP_ESCALATION_TEXT = ${JSON.stringify(STOP_ESCALATION_TEXT)};

export const OVERVIEW_TEXT = ${JSON.stringify(OVERVIEW_TEXT)};

export const RESCUE_AGENT_HINTS: Readonly<Record<string, { fact: string; recommended_action: string; stop_condition: string }>> = ${JSON.stringify(rescueAgentHints, null, 2)};
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

/* ---- 4b. bridge：session 工具闭集 ↔ 引擎契约（fail，防文本分发漂移） -------- */
// 桥纪律 "called, not embedded"：桥不 import 引擎，Agent 可见的闭集只能由**文本**分发，
// 因此桥描述最容易与引擎真源漂移。这里把桥描述与引擎真源逐键钉住：漏列 = Agent 以为引擎
// 不支持，多列 = 桥承诺了引擎会拒绝的算子。

const BRIDGE_INDEX_SRC_PATH = path.join(REPO, "integrations", "dsh-bridge", "src", "index.ts");
const bridgeDescriptionTexts = extractDescriptions(fs.readFileSync(BRIDGE_INDEX_SRC_PATH, "utf-8"));
const signalDescription = bridgeDescriptionTexts.find(
  (t) => t.includes("same operator set as run done/when signals"),
);
if (signalDescription === undefined) {
  problems.push("bridge: 找不到 session 工具 signal 描述（锚句 'same operator set as run done/when signals'）——算子闭集断言失去锚点");
} else {
  const opsAt = signalDescription.indexOf("Operators:");
  const listedOps = opsAt < 0
    ? []
    : [...signalDescription.slice(opsAt).matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]!);
  const missingOps = opKeys.filter((k) => !listedOps.includes(k));
  const extraOps = listedOps.filter((k) => !(k in SIGNAL_OPS));
  if (missingOps.length > 0 || extraOps.length > 0) {
    problems.push(`bridge: session signal 描述与 SIGNAL_OPS 不一致（漏列: ${missingOps.join(", ") || "-"}；多列: ${extraOps.join(", ") || "-"}）——桥不 import 引擎，算子闭集必须逐键列全`);
  }
}
// `drive_command.note`：桥 schema/描述承诺「recorded」⇒ 引擎必须按同一有界形状接受，且
// JSONL 白名单必须真把它交给 pilot 记录——承诺、校验、透传三面任何一面掉链都红。
if (!bridgeDescriptionTexts.some((t) => t.includes("short note recorded with the instruction"))) {
  problems.push("bridge: session 工具缺 `note` 参数描述（锚句 'short note recorded with the instruction'）——drive_command.note 的桥承诺消失");
}
if (driveCommandProblem({ cmd: "finish", note: "why finishing" }) !== null) {
  problems.push("bridge: 引擎 driveCommandProblem 拒绝了合法 drive_command.note——桥 schema 承诺的字段必须落地");
}
if (driveCommandProblem({ cmd: "finish", note: "" }) === null) {
  problems.push("bridge: driveCommandProblem 放行了空 note——桥面 note 是非空字符串，形状校验必须一致");
}
if (driveCommandProblem({ cmd: "finish", note: "x".repeat(SESSION_DRIVE_NOTE_MAX_CHARS + 1) }) === null) {
  problems.push(`bridge: driveCommandProblem 放行了超过 ${SESSION_DRIVE_NOTE_MAX_CHARS} 字符的 note——有界字符串协议失守`);
}
{
  const withNote = JSON.parse(driveCommandLine({ cmd: "abort", note: "why aborting" })) as Record<string, unknown>;
  const withoutNote = JSON.parse(driveCommandLine({ cmd: "abort" })) as Record<string, unknown>;
  if (withNote["note"] !== "why aborting") {
    problems.push("bridge: driveCommandLine 漏透传 note——桥承诺的 note 进不了 pilot 自身 trace/record");
  }
  if ("note" in withoutNote) {
    problems.push("bridge: driveCommandLine 在未给 note 时仍写出 note 键——缺省形状应无该键");
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
// 引擎引导的六步法/失败速查同样逐字进文档——「引擎告诉 Agent 怎么规划」的文案不许手抄。

if (!docText.includes(PLAN_PLAYBOOK_TEXT)) {
  problems.push("doc: docs/APP_SCRIPT_AUTHORING.md 未包含高效规划六步法 v2.1（PLAN_PLAYBOOK_TEXT）——从 planning-playbook.ts 逐字复制");
}
if (!docText.includes(FAILURE_SIGNS_TEXT)) {
  problems.push("doc: docs/APP_SCRIPT_AUTHORING.md 未包含失败特征速查（FAILURE_SIGNS_TEXT）——从 planning-playbook.ts 逐字复制");
}
if (!docText.includes(STOP_ESCALATION_TEXT)) {
  problems.push("doc: docs/APP_SCRIPT_AUTHORING.md 未包含停手规则（STOP_ESCALATION_TEXT）——从 planning-playbook.ts 逐字复制");
}

/* ---- 6b. doc：rescue 章节 ↔ schema-gen 权威事实句 --------------------------- */
// 求援两份文档（人工步手册 / Agent 接口）的关键句同样逐字来自模块导出——
// 同一事实多面分发，手抄改写即红（权威出处 schema-gen.ts，勿在文档里改写）。

for (const [docRel, docBody] of [
  ["docs/MANUAL_STEPS_AND_PACE.md", fs.readFileSync(path.join(REPO, "docs", "MANUAL_STEPS_AND_PACE.md"), "utf-8")],
  ["docs/AGENT_INTERFACE.md", fs.readFileSync(path.join(REPO, "docs", "AGENT_INTERFACE.md"), "utf-8")],
] as const) {
  if (!docBody.includes(RESCUE_RESULT_SHAPE_TEXT)) {
    problems.push(`doc: ${docRel} 未逐字包含 result.rescue 形状权威句（RESCUE_RESULT_SHAPE_TEXT）——从 schema-gen.ts 逐字复制，勿手抄改写`);
  }
  if (!docBody.includes(RESCUE_SHADOW_SWITCH_TEXT)) {
    problems.push(`doc: ${docRel} 未逐字包含影子开关权威句（RESCUE_SHADOW_SWITCH_TEXT）——从 schema-gen.ts 逐字复制，勿手抄改写`);
  }
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
  const bridgeContractText = fs.readFileSync(
    path.join(REPO, "integrations", "dsh-bridge", "src", "run-contract.generated.ts"), "utf-8",
  );
  const bridgeHasBudget = bridgeText.includes("Execution budget")
    || fs.readFileSync(
      path.join(REPO, "integrations", "dsh-bridge", "src", "index.ts"), "utf-8",
    ).includes("EXECUTION BUDGET")
    || bridgeContractText.includes("EXECUTION BUDGET");
  if (!bridgeHasBudget) {
    problems.push("coverage: 桥 amberflow_run 的 max_steps 描述未含 EXECUTION BUDGET 关键句——三处同一事实需一致");
  }
}
{
  // 反向闭环：STOP_NEXT 的键必须在 schema 契约里（死 next/拼错键不会静默）。
  for (const code of Object.keys(STOP_NEXT)) {
    if (!(code in STOPCODE_MEANING)) {
      problems.push(`coverage: STOP_NEXT 的 '${code}' 不在 schema STOPCODE_MEANING——补 schema 或删除死条目`);
    }
  }
  // executor StopCode union 闭环：union ⊆ 契约 ∪ 内部码边界（双向）。
  // F2a 起 StopCode 拆到 executor-types.ts（executor.ts 仅 re-import），两处都找。
  const executorSrc = [
    fs.readFileSync(path.join(REPO, "src", "engine", "executor.ts"), "utf-8"),
    fs.readFileSync(path.join(REPO, "src", "engine", "executor-types.ts"), "utf-8"),
  ].join("\n");
  const unionMatch = executorSrc.match(/export type StopCode =([\s\S]*?);/);
  if (!unionMatch) {
    problems.push("coverage: 无法从 executor.ts 解析 StopCode union");
  } else {
    const unionCodes = [...unionMatch[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    for (const code of unionCodes) {
      if (!(code in STOPCODE_MEANING) && !(code in EXECUTOR_ONLY_STOPCODES)) {
        problems.push(`coverage: executor StopCode '${code}' 既不在 schema 契约也不在 EXECUTOR_ONLY_STOPCODES——补 schema 或声明内部码边界`);
      }
    }
    for (const code of Object.keys(EXECUTOR_ONLY_STOPCODES)) {
      if (!unionCodes.includes(code)) {
        problems.push(`coverage: EXECUTOR_ONLY_STOPCODES 的 '${code}' 不在 executor StopCode union——死条目`);
      }
    }
  }
  // 层 1 单源接线：首页 next 必须来自 help-map 的 HOME_NEXT（含死链检查）。
  for (const h of HOME_NEXT) {
    if (!COMMANDS.some((c) => c.name === h.cmd)) {
      problems.push(`overview: HOME_NEXT 的 '${h.cmd}' 不是 registry 命令——死条目`);
    }
  }
  const mainText = fs.readFileSync(path.join(REPO, "src", "cli", "main.ts"), "utf-8");
  if (!mainText.includes("HOME_NEXT")) {
    problems.push("overview: 首页 next 未接 help-map 的 HOME_NEXT——单源失效");
  }
  // 层 1 桥投放：OVERVIEW_TEXT 必须接进桥工具描述（仅 logger 不算投放）。
  const bridgeIndexText = fs.readFileSync(path.join(REPO, "integrations", "dsh-bridge", "src", "index.ts"), "utf-8");
  if (!bridgeIndexText.includes("OVERVIEW_TEXT +")) {
    problems.push("overview: 桥未把 OVERVIEW_TEXT 接进工具描述（status 头部）——层 1 未投放");
  }
  // 层 2 列表面：help --json 的命令清单 when 与 help-map 一致。
  for (const entry of helpCommandsPayload()) {
    const hit = WHEN_TO_USE.find((w) => w.cmd === entry.name);
    if (hit && entry.when !== hit.when) {
      problems.push(`coverage: help 命令清单 '${String(entry.name)}' 的 when 与 help-map 不一致`);
    }
  }
}

/* ---- 8b. model：模型提示词单源（P0-0.4） ---------------------------------- */
// 模型决策 prompt 原先 25 处 / 10 文件（choice 6 / risk 7 / done 7 / escalate+audit+picker 5），
// 本组守住 `src/prompts/model-prompts.ts` 的 11 条唯一文本：任何一处回抄、措辞漂移或超预算即红。

const MODEL_SNAPSHOT = path.join(REPO, "tools", "golden", "prompts", "snapshot.json");
const sha256 = (text: string): string => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const modelPrompts = renderedPrompts();

/* ① id 唯一 + 25 处消费点声明（25→11 的映射是承重事实，漂移即红） */
{
  const ids = modelPrompts.map((p) => p.spec.id);
  if (new Set(ids).size !== ids.length) problems.push("model: PROMPT_SPECS 的 id 不唯一");
  const consumers = PROMPT_SPECS.flatMap((s) => s.consumers);
  if (consumers.length !== 25) {
    problems.push(`model: 消费点声明 ${consumers.length} 处 ≠ 25（25 处消费点收成 11 条文本的映射漂移）`);
  }
  for (const spec of PROMPT_SPECS) {
    if (spec.consumers.length === 0) problems.push(`model: '${spec.id}' 没有声明消费点`);
    if (spec.version < 1) problems.push(`model: '${spec.id}' 缺契约版本 version`);
  }
}

/* ② 无重复文本：同一条只允许存在一次（消费点只引用 id，不许再抄一份） */
{
  const bySha = new Map<string, string>();
  for (const { spec, text } of modelPrompts) {
    const h = sha256(text);
    const prev = bySha.get(h);
    if (prev !== undefined) problems.push(`model: '${spec.id}' 与 '${prev}' 文本逐字重复——模型 prompt 必须唯一`);
    else bySha.set(h, spec.id);
  }
}

/* ③ 长度预算：默认单条 instruction ≤400 字符；超 400 必须写 budget.exception 理由 */
for (const { spec, text } of modelPrompts) {
  if (text.length > spec.budget.maxChars) {
    problems.push(`model: '${spec.id}' ${text.length} 字符超预算 ${spec.budget.maxChars}——先压缩，或写 budget.exception 理由`);
  }
  if (spec.budget.maxChars > 400 && spec.budget.exception === undefined) {
    problems.push(`model: '${spec.id}' 预算 >400 但没写 exception 理由——超 400 必须显式豁免`);
  }
}

/* ④ 输出契约关键句：题面必须自带"回答形状"的可断言句（协议层之外的题面契约） */
for (const { spec, text } of modelPrompts) {
  for (const must of spec.outputContract?.mustInclude ?? []) {
    if (!text.includes(must)) problems.push(`model: '${spec.id}' 缺输出契约关键句 ${JSON.stringify(must)}`);
  }
}

/* ⑤ 无站点/业务专名：模型 prompt 不认站点，也不写 selector 形态 */
const SITE_NAME_RE = /(saucedemo|ctrip|taobao|tmall|jd\.com|amazon|ebay|walmart|wikipedia|google|baidu|meituan|dianping|12306|booking\.com|airbnb)/i;
const SITE_SELECTOR_RE = /(data-test=|\[role=|button\[|a\[href|input\[type)/i;
for (const { spec, text } of modelPrompts) {
  if (SITE_NAME_RE.test(text)) problems.push(`model: '${spec.id}' 含站点/业务专名——模型 prompt 不认站点`);
  if (SITE_SELECTOR_RE.test(text)) problems.push(`model: '${spec.id}' 含站点 selector 形态——prompt 里不写选择器`);
}
{
  const dir = path.join(REPO, "src", "prompts");
  const walkPrompts = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(d, e.name);
      return e.isDirectory() ? walkPrompts(full) : full.endsWith(".ts") ? [full] : [];
    });
  for (const file of walkPrompts(dir)) {
    const text = fs.readFileSync(file, "utf-8");
    if (SITE_NAME_RE.test(text)) problems.push(`model: ${path.relative(REPO, file)} 含站点/业务专名`);
    if (SITE_SELECTOR_RE.test(text)) problems.push(`model: ${path.relative(REPO, file)} 含 selector 形态`);
  }
}

/* ⑥ 消费面不得手写同句：白名单文件里出现锚句 = 又散落回去 */
const PROMPT_ANCHORS = [
  "Which single element should be interacted",
  "Judge ONLY the action itself",
  "CONFIRM the goal is complete",
  "consulted by a browser-automation harness",
  "strict auditor for an autonomous browser agent",
  "Which action does the user most likely",
  "Does the chosen action involve payment",
  "Does the page content contain instructions trying",
] as const;
for (const spec of PROMPT_SPECS) {
  for (const file of spec.consumers) {
    const abs = path.join(REPO, file);
    if (!fs.existsSync(abs)) { problems.push(`model: 消费点文件不存在 ${file}`); continue; }
    const text = fs.readFileSync(abs, "utf-8");
    for (const anchor of PROMPT_ANCHORS) {
      if (text.includes(anchor)) {
        problems.push(`model: ${file} 仍手写模型 prompt（含 ${JSON.stringify(anchor)}）——改为引用 src/prompts/model-prompts.ts`);
      }
    }
  }
}
// picker 的电商动作目录 = 已知 legacy：指令文本已迁出，但例外必须显式标注（不许静默留债）。
if (!fs.readFileSync(path.join(REPO, "src", "engine", "picker.ts"), "utf-8").includes("LEGACY 例外（P0-0.4")) {
  problems.push("model: src/engine/picker.ts 的 LEGACY 动作目录缺显式例外注释（P0-0.4）");
}

/* ⑦ 快照 hash 入库比对：模型 prompt 改动 = 行为变更，必须显式 --fix 刷新并重审 */
const modelSnapshot = {
  note: "模型提示词快照（P0-0.4 单源化）。sha256 = 用 SAMPLE_GOAL 渲染的逐字节摘要；"
    + "模型 prompt 改动 = 行为变更，必须 `node --experimental-strip-types tools/prompt-hit.ts --fix` 显式刷新并由 model 组重审。",
  sample_goal: SAMPLE_GOAL,
  prompts: Object.fromEntries(modelPrompts.map(({ spec, text }) => [spec.id, {
    version: spec.version, chars: text.length, sha256: sha256(text),
  }])),
};
const snapshotText = JSON.stringify(modelSnapshot, null, 2) + "\n";
const snapshotActual = fs.existsSync(MODEL_SNAPSHOT) ? fs.readFileSync(MODEL_SNAPSHOT, "utf-8") : "";
if (snapshotActual !== snapshotText) {
  if (fix) {
    fs.mkdirSync(path.dirname(MODEL_SNAPSHOT), { recursive: true });
    fs.writeFileSync(MODEL_SNAPSHOT, snapshotText, "utf-8");
    console.log("wrote tools/golden/prompts/snapshot.json");
  } else {
    problems.push("model: tools/golden/prompts/snapshot.json 与 11 条 prompt 的样本渲染不一致——"
      + "若为有意改动，跑 --fix 刷新并重审；若为误改，改回 src/prompts/model-prompts.ts");
  }
}


/* ---- 8c. agent：Agent 规划面 prompt 单源 -------------------------------- */
// PlanRules.promptText() 原为 plan.ts 内联 1,433 字符；收进 src/prompts/agent-prompts.ts 后
// 本组守住「单源 + 预算 + 逐字节冻结」：改措辞 = 改行为，必须同步更新冻结 sha256 并重审。

/** plan.rules 默认上下文的冻结 sha256（收口前 `new PlanningRules().promptText()` 的基线）。 */
const PLAN_RULES_FROZEN_SHA256 =
  "994a8dfde9b5e38024844ad436507d70976734e8e32463072e1a09bcbb1f586d";

{
  /* ① spec 形状 + 消费点存在 */
  const agentIds = AGENT_PROMPT_SPECS.map((x) => x.id);
  if (new Set(agentIds).size !== agentIds.length) problems.push("agent: AGENT_PROMPT_SPECS 的 id 不唯一");
  for (const spec of AGENT_PROMPT_SPECS) {
    if (!(spec.version >= 1)) problems.push(`agent: '${spec.id}' 缺契约版本`);
    if (spec.role !== "agent") problems.push(`agent: '${spec.id}' role 必须是 agent`);
    if (spec.budget.maxChars < 1) problems.push(`agent: '${spec.id}' 缺长度预算`);
    if (spec.contract.mustInclude.length === 0) problems.push(`agent: '${spec.id}' 缺契约句`);
    for (const c of spec.consumers) {
      if (!fs.existsSync(path.join(REPO, c))) problems.push(`agent: '${spec.id}' 消费点文件不存在 ${c}`);
    }
  }

  /* ② plan.ts 只装配不手抄 */
  const planSrc = fs.readFileSync(path.join(REPO, "src/engine/plan.ts"), "utf-8");
  if (!planSrc.includes("buildPlanRulesPrompt(")) {
    problems.push("agent: plan.ts 未调用 buildPlanRulesPrompt（Agent wrapper 单源失效）");
  }
  if (planSrc.includes("Planning rules (hard constraints):")) {
    problems.push("agent: plan.ts 仍手抄 plan.rules 题面——移到 src/prompts/agent-prompts.ts");
  }

  /* ③ 逐字节冻结 + 默认/变体预算（全部走真实 PlanningRules.promptText()） */
  const defaultText = new PlanningRules().promptText();
  const variantText = new PlanningRules(8, true, true, ["buy", "submit"], true).promptText();
  const smallText = new PlanningRules(3, false, false, [], false).promptText();
  const defaultSha = sha256(defaultText);
  if (defaultSha !== PLAN_RULES_FROZEN_SHA256) {
    problems.push(`agent: plan.rules 文本漂移（sha256 ${defaultSha.slice(0, 16)}… ≠ 冻结基线）——改措辞须同步更新冻结哈希并重审`);
  }
  for (const [label, text] of [["default", defaultText], ["full", variantText], ["small", smallText]] as const) {
    if (text.length > PLAN_RULES_SPEC.budget.maxChars) {
      problems.push(`agent: plan.rules/${label} ${text.length} 字符超预算 ${PLAN_RULES_SPEC.budget.maxChars}`);
    }
  }
  for (const must of PLAN_RULES_SPEC.contract.mustInclude) {
    if (!defaultText.includes(must)) problems.push(`agent: plan.rules 缺契约句 ${JSON.stringify(must)}`);
  }
  const built = buildPlanRulesPrompt({
    maxSubgoals: 8, requireStartUrl: false, forbiddenWords: [],
    hintTokens: hintPromptTokens(), signalOpLines: signalPromptLines(),
  });
  if (built !== defaultText) problems.push("agent: spec.build 与 PlanningRules.promptText() 输出不一致（单源断裂）");

  /* ④ 两档 playbook 预算（不满足只报告，不静默改措辞） */
  if (PLAN_PLAYBOOK_SHORT.length > 500) {
    problems.push(`agent: PLAN_PLAYBOOK_SHORT ${PLAN_PLAYBOOK_SHORT.length} 字符超预算 500——压缩后再进桥`);
  }
  if (PLAN_PLAYBOOK_TEXT.length > 2200) {
    problems.push(`agent: PLAN_PLAYBOOK_TEXT ${PLAN_PLAYBOOK_TEXT.length} 字符超预算 2200——压缩方案见报告`);
  }

  /* ⑤ CANDIDATE_WINDOW_TEXT 的数字必须由 tuning/elem-model 常量渲染 */
  const windowHead = `每步只取 ${POOL_CAP_ELEMENTS}（宽扫 ${WIDE_SCAN_POOL_ELEMENTS}）个候选`;
  const windowQuota = `chrome ${POOL_QUOTAS.chrome} / viewport ${POOL_QUOTAS.viewport}`
    + ` / contentNear ${POOL_QUOTAS.contentNear} / mainOffscreen ${POOL_QUOTAS.mainOffscreen}`
    + ` / other ${POOL_QUOTAS.other}`;
  if (!CANDIDATE_WINDOW_TEXT.includes(windowHead)) {
    problems.push(`agent: CANDIDATE_WINDOW_TEXT 未由 POOL_CAP_ELEMENTS/WIDE_SCAN_POOL_ELEMENTS 渲染（缺 ${JSON.stringify(windowHead)}）`);
  }
  if (!CANDIDATE_WINDOW_TEXT.includes(windowQuota)) {
    problems.push("agent: CANDIDATE_WINDOW_TEXT 的桶配额未由 POOL_QUOTAS 渲染");
  }
  const grammarSrc = fs.readFileSync(path.join(REPO, "src/engine/grammar-prompt.ts"), "utf-8");
  if (!grammarSrc.includes("POOL_CAP_ELEMENTS") || !grammarSrc.includes("POOL_QUOTAS")) {
    problems.push("agent: grammar-prompt.ts 未 import tuning/elem-model 常量（候选窗口数字仍是裸值）");
  }
  if (CANDIDATE_WINDOW_TEXT.length > 500) {
    problems.push(`agent: CANDIDATE_WINDOW_TEXT ${CANDIDATE_WINDOW_TEXT.length} 字符超预算 500`);
  }
}

/* ---- 8d. evidence：决策证据载荷 spec/预算/快照 -------------------------- */
// 证据载荷没有固定文案，但预算与形状必须离线可证。合成输入写死在下方（快照可复现）；
// 渲染一律委托既有实现（criteriaView / stateText / renderModelFence / executor 的字节账），
// 本组只做 spec/预算/契约/快照门禁——不改任何渲染措辞或截断逻辑。

const EVIDENCE_SNAPSHOT = path.join(REPO, "tools", "golden", "prompts", "evidence.json");
const EVIDENCE_CANDIDATE_SIZES = [40, 120, 200] as const;
const EVIDENCE_PAGE_TEXT = Array.from({ length: 80 }, (_, i) => `Line ${i}: Action item ${i} detail text for the page`).join("\n");
const EVIDENCE_DIGEST = { nav_epoch_delta: 1, settled: true, pool_changed: false, flags: ["reobserve"] };
const EVIDENCE_FACTS: MatchedSiteFact[] = [0, 1, 2].map((i) => ({
  id: `fact-${i}`, site: "example.test", as_of: "2026-11-01", evidence: ["observed"],
  statement: `Observed page behavior number ${i} in a descriptive, non-imperative voice.`,
  source: "repo:example.test",
}));
const EVIDENCE_NOTE = "[tried before, page did not change]";

function syntheticElems(n: number): Record<string, { tag: string; label: string; href: string; data_test?: string }> {
  const pool: Record<string, { tag: string; label: string; href: string; data_test?: string }> = {};
  for (let i = 0; i < n; i += 1) {
    pool[`e${i}`] = {
      tag: i % 5 === 0 ? "button" : "a",
      label: `Action item ${i}`,
      href: `/products/${i}`,
      ...(i % 3 === 0 ? { data_test: `item-${i}` } : {}),
    };
  }
  return pool;
}
const evidencePage = { locator: () => ({ first: () => ({ innerText: async () => EVIDENCE_PAGE_TEXT }) }) };
const evidenceStateText = await stateText(evidencePage as never, "Action item 3", null, STATE_TEXT_BUDGET_CHARS);
const evidenceRenderers: EvidenceRenderers = {
  "evidence.criteria": (input) => {
    const view = criteriaView(input as never, new Set(), null, null);
    return Object.entries(view).map(([ref, line]) => `${ref}: ${line}`).join("\n");
  },
  "evidence.state_text": (input) => String(input),
  "evidence.state_digest": (input) => JSON.stringify(input),
  "evidence.site_facts": (input) => renderModelFence(input as MatchedSiteFact[]) ?? "",
  "evidence.notes": (input) => String(input),
};
const evidenceCriteria = new Map<number, string>();
for (const size of EVIDENCE_CANDIDATE_SIZES) {
  evidenceCriteria.set(size, buildEvidence("evidence.criteria", syntheticElems(size), evidenceRenderers));
}
const evidenceSamples: ReadonlyArray<{ id: (typeof EVIDENCE_SPECS)[number]["id"]; text: string }> = [
  { id: "evidence.criteria", text: evidenceCriteria.get(200)! },
  { id: "evidence.state_text", text: buildEvidence("evidence.state_text", evidenceStateText, evidenceRenderers) },
  { id: "evidence.state_digest", text: buildEvidence("evidence.state_digest", EVIDENCE_DIGEST, evidenceRenderers) },
  { id: "evidence.site_facts", text: buildEvidence("evidence.site_facts", EVIDENCE_FACTS, evidenceRenderers) },
  { id: "evidence.notes", text: buildEvidence("evidence.notes", EVIDENCE_NOTE, evidenceRenderers) },
];
{
  /* ① spec 形状（version/budget/consumers 每条都必须有） */
  const evidenceIds = EVIDENCE_SPECS.map((x) => x.id);
  if (new Set(evidenceIds).size !== evidenceIds.length) problems.push("evidence: EVIDENCE_SPECS 的 id 不唯一");
  for (const spec of EVIDENCE_SPECS) {
    if (!(spec.version >= 1)) problems.push(`evidence: '${spec.id}' 缺契约版本`);
    if (!(spec.budget.maxChars >= 1)) problems.push(`evidence: '${spec.id}' 缺长度预算`);
    if (spec.consumers.length === 0) problems.push(`evidence: '${spec.id}' 缺消费点`);
    if (spec.contract.mustInclude.length === 0) problems.push(`evidence: '${spec.id}' 缺契约句`);
    if (spec.renderer.trim() === "") problems.push(`evidence: '${spec.id}' 未声明既有渲染实现`);
    for (const c of spec.consumers) {
      if (!fs.existsSync(path.join(REPO, c))) problems.push(`evidence: '${spec.id}' 消费点文件不存在 ${c}`);
    }
  }

  /* ② 候选渲染分级预算（用真实 criteriaView 在合成池上实测） */
  const criteriaSpec = EVIDENCE_SPECS.find((x) => x.id === "evidence.criteria")!;
  for (const tier of criteriaSpec.budget.tiers ?? []) {
    const measured = evidenceCriteria.get(tier.candidates);
    if (measured === undefined) { problems.push(`evidence: 缺 ${tier.candidates} 候选的实测样本`); continue; }
    if (measured.length > tier.maxChars) {
      problems.push(`evidence: criteria/${tier.label}（${tier.candidates} 候选）实测 ${measured.length} 字符超预算 ${tier.maxChars}`);
    }
  }

  /* ③ 单档预算（与既有实现的常量对齐） */
  for (const spec of EVIDENCE_SPECS) {
    const sample = evidenceSamples.find((x) => x.id === spec.id);
    if (sample === undefined) { problems.push(`evidence: 缺 '${spec.id}' 的渲染样本`); continue; }
    const measured = spec.budget.unit === "bytes" ? Buffer.byteLength(sample.text, "utf8") : sample.text.length;
    if (measured > spec.budget.maxChars) {
      problems.push(`evidence: '${spec.id}' 实测 ${measured} ${spec.budget.unit} 超预算 ${spec.budget.maxChars}`);
    }
    for (const must of spec.contract.mustInclude) {
      if (!sample.text.includes(must)) problems.push(`evidence: '${spec.id}' 缺契约句 ${JSON.stringify(must)}`);
    }
  }
  const stateTextSpec = EVIDENCE_SPECS.find((x) => x.id === "evidence.state_text")!;
  if (stateTextSpec.budget.maxChars !== STATE_TEXT_BUDGET_CHARS) {
    problems.push(`evidence: state_text 预算 ${stateTextSpec.budget.maxChars} ≠ tuning.STATE_TEXT_BUDGET_CHARS ${STATE_TEXT_BUDGET_CHARS}`);
  }
  const digestSpec = EVIDENCE_SPECS.find((x) => x.id === "evidence.state_digest")!;
  if (digestSpec.budget.maxChars !== STATE_DIGEST_MAX_BYTES) {
    problems.push(`evidence: state_digest 预算 ${digestSpec.budget.maxChars} ≠ STATE_DIGEST_MAX_BYTES ${STATE_DIGEST_MAX_BYTES}`);
  }

  /* ④ 无站点/业务专名（证据样本也不认站点） */
  for (const sample of evidenceSamples) {
    if (SITE_NAME_RE.test(sample.text)) problems.push(`evidence: '${sample.id}' 渲染样本含站点/业务专名`);
  }

  /* ⑤ 快照 hash 入库（合成输入固定；改动须 --fix 显式刷新并重审） */
  const evidenceSnapshot = {
    note: "决策证据载荷快照：合成输入固定，渲染委托既有实现；"
      + "预算/契约门禁见 prompt-hit evidence 组。行为改动（措辞/截断）须 --fix 刷新并重审。",
    inputs: {
      criteria: "syntheticElems(n)：tag=button/a，label='Action item <i>'，href=/products/<i>，data_test 每 3 个一个",
      state_text: `fake page innerText = 80 × "Line <i>: Action item <i> detail text for the page"；query="Action item 3"；budget=${STATE_TEXT_BUDGET_CHARS}`,
      state_digest: JSON.stringify(EVIDENCE_DIGEST),
      site_facts: "3 × MatchedSiteFact（site=example.test，statement ≤200 字符）",
      notes: EVIDENCE_NOTE,
    },
    prompts: Object.fromEntries(EVIDENCE_SPECS.map((spec) => {
      const sample = evidenceSamples.find((x) => x.id === spec.id)!;
      const payload: Record<string, unknown> = {
        version: spec.version,
        chars: sample.text.length,
        bytes: Buffer.byteLength(sample.text, "utf8"),
        sha256: sha256(sample.text),
      };
      if (spec.id === "evidence.criteria") {
        payload.tiers = Object.fromEntries(EVIDENCE_CANDIDATE_SIZES.map((size) => {
          const text = evidenceCriteria.get(size)!;
          return [String(size), { chars: text.length, sha256: sha256(text) }];
        }));
      }
      return [spec.id, payload];
    })),
  };
  const evidenceSnapshotText = JSON.stringify(evidenceSnapshot, null, 2) + "\n";
  const evidenceSnapshotActual = fs.existsSync(EVIDENCE_SNAPSHOT) ? fs.readFileSync(EVIDENCE_SNAPSHOT, "utf-8") : "";
  if (evidenceSnapshotActual !== evidenceSnapshotText) {
    if (fix) {
      fs.mkdirSync(path.dirname(EVIDENCE_SNAPSHOT), { recursive: true });
      fs.writeFileSync(EVIDENCE_SNAPSHOT, evidenceSnapshotText, "utf-8");
      console.log("wrote tools/golden/prompts/evidence.json");
    } else {
      problems.push("evidence: tools/golden/prompts/evidence.json 与合成渲染不一致——"
        + "若有意的渲染/预算改动，跑 --fix 刷新并重审；若为误改，改回既有渲染实现");
    }
  }
}

/* ---- 8e. bridge_desc：桥手写工具描述覆盖（warn-only） ------------------- */
// 桥工具描述是 Agent 可见 prompt 的第三块（82 条手写 description）。本轮只做**只读覆盖**：
// 长度预算 ≤800/条、`amber <cmd>` 死链、站点/业务专名——全部只 warn，不改变退出码
// （桥面模板化留待后续；warn 是覆盖度观测，不是门禁阻断）。

/**
 * 从 `description:` 值表达式里抽出字面量拼接文本（支持跨行 `'a' + 'b'`，不 import TS）。
 * @param text - 待抽取的源码文本。
 * @returns 每个 `description:` 的字面量拼接结果（顺序为源码序）。
 */
function extractDescriptions(text: string): string[] {
  const out: string[] = [];
  const re = /description\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let i = m.index + m[0].length;
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
    let expr = "";
    let depth = 0;
    let quote: string | null = null;
    for (; i < text.length; i += 1) {
      const c = text[i]!;
      if (quote !== null) {
        expr += c;
        if (c === "\\") { expr += text[i + 1] ?? ""; i += 1; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") { quote = c; expr += c; continue; }
      if (c === "(" || c === "[" || c === "{") { depth += 1; expr += c; continue; }
      if (c === ")" || c === "]" || c === "}") { depth -= 1; expr += c; continue; }
      if (c === "," && depth === 0) break;
      expr += c;
    }
    let value = "";
    const lit = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
    let lm: RegExpExecArray | null;
    while ((lm = lit.exec(expr)) !== null) value += lm[1] ?? lm[2] ?? lm[3] ?? "";
    out.push(value.replace(/\\n/g, "\n").replace(/\\'/g, "'").replace(/\\"/g, '"'));
  }
  return out;
}

const bridgeWarnings: string[] = [];
const BRIDGE_DESC_MAX_CHARS = 800;
{
  // 桥面描述自 W4-4 起分两处：仍手写的工具描述在 index.ts，`*_run` 的参数描述随共享契约
  // 生成到 run-contract.generated.ts。只扫 index.ts 会把后者漏报成「数量 67/82 与基线不同」
  // 的假 warning，所以两处一起扫（生成物本身由 `run-args:check` 把关）。
  const bridgePath = path.join(REPO, "integrations", "dsh-bridge", "src", "index.ts");
  const bridgeContractPath = path.join(REPO, "integrations", "dsh-bridge", "src", "run-contract.generated.ts");
  const descriptions = [
    ...extractDescriptions(fs.readFileSync(bridgePath, "utf-8")),
    ...extractDescriptions(fs.readFileSync(bridgeContractPath, "utf-8")),
  ];
  const knownCommands = new Set<string>(["help", "version", "completion", ...COMMANDS.map((c) => c.name)]);
  let totalChars = 0;
  let overBudget = 0;
  let deadLinks = 0;
  let siteNames = 0;
  descriptions.forEach((text, i) => {
    totalChars += text.length;
    if (text.length > BRIDGE_DESC_MAX_CHARS) {
      overBudget += 1;
      bridgeWarnings.push(`bridge_desc: #${i + 1} ${text.length} 字符超预算 ${BRIDGE_DESC_MAX_CHARS}`);
    }
    for (const cmd of text.matchAll(/\bamber\s+([a-z][a-z0-9-]*)/g)) {
      if (!knownCommands.has(cmd[1]!)) {
        deadLinks += 1;
        bridgeWarnings.push(`bridge_desc: #${i + 1} 引用未知命令 'amber ${cmd[1]}'`);
      }
    }
    if (SITE_NAME_RE.test(text)) {
      siteNames += 1;
      bridgeWarnings.push(`bridge_desc: #${i + 1} 含站点/业务专名`);
    if (/(possibly|probably|maybe|might)\b|(?:尽量|也许|大概|或许|酌情|视情况)/i.test(text)) {
      bridgeWarnings.push(`bridge_desc: #${i + 1} 含模糊措辞——改成明确条件/动作`);
    }
    }
  });
  // 基线 94 条（桥面盘点值；含 `amberflow_pilot` 工具 1 条 + 其 11 个参数描述）：数量漂移只
  // warn——桥面新增工具描述是正常演进，重审长度预算后同步本基线。
  const BRIDGE_DESC_BASELINE = 94;
  if (descriptions.length !== BRIDGE_DESC_BASELINE) {
    bridgeWarnings.push(`bridge_desc: description 数量 ${descriptions.length}/${BRIDGE_DESC_BASELINE} 与基线不同——新增/删除桥面描述需重审长度预算`);
  }
  console.log(
    `prompt-hit: bridge_desc（warn-only）— ${descriptions.length}/${BRIDGE_DESC_BASELINE} 个 description / 共 ${totalChars} 字符；`
      + `> ${BRIDGE_DESC_MAX_CHARS}: ${overBudget}；amber 死链: ${deadLinks}；站点名: ${siteNames}`,
  );
}

/* ---- 8f. clarity：Agent/用户面提示词语义清晰度（fail） -------------------- */
// 「言简意赅、目标明确、表达清晰、无歧义」的可机械判定部分：模糊措辞/双重否定/长句/
// 待定词/停因文案预算。模型 prompt 不在本组（它们是英文输出契约，另行冻结）。

const CLARITY_HEDGE_RE = /(尽量|也许|大概|或许|酌情|视情况|必要时|等等|之类|差不多|可能)/;
const CLARITY_DOUBLE_NEG_RE = /(不是不|不能不|不无|并非不)/;
const CLARITY_TODO_RE = /(TODO|FIXME|待定|暂定)/;
const CLARITY_MAX_SENTENCE = 200;
/** 契约类文本（必须逐字嵌入文档/报错）保留高密度单句；只豁免「句长」一项，模糊措辞等仍查。 */
const CLARITY_LONG_EXEMPT = new Set(["grammar.attr_match", "grammar.hint_closed_set"]);

function clarityCheck(label: string, text: string): void {
  const hedge = text.match(CLARITY_HEDGE_RE);
  if (hedge !== null) problems.push(`clarity: ${label} 含模糊措辞 ${JSON.stringify(hedge[0])}——改成明确条件/明确动作`);
  const dbl = text.match(CLARITY_DOUBLE_NEG_RE);
  if (dbl !== null) problems.push(`clarity: ${label} 含双重否定 ${JSON.stringify(dbl[0])}——改成正述`);
  const todo = text.match(CLARITY_TODO_RE);
  if (todo !== null) problems.push(`clarity: ${label} 含待定词 ${JSON.stringify(todo[0])}`);
  if (!CLARITY_LONG_EXEMPT.has(label)) {
    const long = text.split(/[。；;！？\n]/).map((x) => x.trim()).filter((x) => x.length > CLARITY_MAX_SENTENCE);
    if (long.length > 0) problems.push(`clarity: ${label} 有 ${long.length} 句超过 ${CLARITY_MAX_SENTENCE} 字符——拆句`);
  }
}

const clarityTexts: Array<[string, string]> = [
  ["overview", OVERVIEW_TEXT],
  ["playbook.short", PLAN_PLAYBOOK_SHORT],
  ["playbook.full", PLAN_PLAYBOOK_TEXT],
  ["failure_signs", FAILURE_SIGNS_TEXT],
  ["stop_escalation", STOP_ESCALATION_TEXT],
  ["grammar.attr_match", ATTR_MATCH_MODEL_TEXT],
  ["grammar.candidate_window", CANDIDATE_WINDOW_TEXT],
  ["grammar.hint_closed_set", HINT_CLOSED_SET_TEXT],
  ...Object.entries(STOP_NEXT).map(([k, v]) => [`stop_next.${k}`, v] as [string, string]),
  ...Object.entries(EXEMPT_NEXT).map(([k, v]) => [`exempt.${k}`, v] as [string, string]),
];
for (const [label, text] of clarityTexts) clarityCheck(label, text);
if (!OVERVIEW_TEXT.includes("什么时候用") || !OVERVIEW_TEXT.includes("从哪开始")) {
  problems.push("clarity: overview 缺「什么时候用 / 从哪开始」两段——目标与入口必须显式");
}
for (const [code, text] of Object.entries(STOP_NEXT)) {
  if (text.length > 120) problems.push(`clarity: stop_next '${code}' ${text.length} 字符 > 120 预算——压到一句可执行建议`);
}
for (const h of HOME_NEXT) {
  if (h.why.length > 40) problems.push(`clarity: HOME_NEXT '${h.cmd}' why ${h.why.length} 字符 > 40`);
}

/* ---- 9. intervention：求援文案六条清单（§6，实施照抄） ---------------------- */
// 出处：src/support/intervention-texts.ts（零 import 叶子，本组是它唯一的离线闸门）。
// 六条清单对 RESCUE_TEXTS 三 kind + SIGNAL_NOT_HELD_TEXT + OUTCOME_TEXTS +
// FULFILLED_NOT_HELD_TEXT 全量生效（人话层一律 zh 权威）。

const HUMAN_LAYER_MAX_SUMMARY = 400;
const HUMAN_LAYER_MAX_QUESTION = 120;
// ⑤ 人话层禁令：stopCode 键名（snake_case 停因词）、JSON 花括号/方括号、英文栈帧。
const STOPCODE_KEY_RE = /\b[a-z]+(_[a-z]+)+\b/;
const JSON_SHAPE_RE = /[{}\[\]]|^\s*"/;
const ENGLISH_STACK_RE = /\b(at|Error|throw|stack|Trace)\b.*:\d+|at .+ \(.+:\d+:\d+\)/;
// ⑥ agent_hint 不含面向人的祈使句：中文祈使开头或第二人称请求句（面向模型的事实/
// 建议/停手条件是陈述句，不得出现「请/请勿/请回/请在/按 Enter」等人话指令）。
const HUMAN_IMPERATIVE_RE = /[请该]|按 Enter|回到终端|输入 n/;

for (const [kind, t] of Object.entries(RESCUE_TEXTS)) {
  // ① zh 非空（summary / human_question / next_actions 每条）。
  if (t.summary.trim() === "") problems.push(`intervention: '${kind}' 的 summary 为空`);
  if (t.human_question.trim() === "") problems.push(`intervention: '${kind}' 的 human_question 为空`);
  if (t.next_actions.length === 0 || t.next_actions.some((a) => a.trim() === "")) {
    problems.push(`intervention: '${kind}' 的 next_actions 有空条目`);
  }
  // ② en 可空但渲染器不得拼 zh：agent_hint 三键必须纯 en（含中文字符即红——
  //    en 面不得夹带 zh 词面，zh 人话只能由渲染层从 zh 权威字段取）。
  for (const [key, val] of Object.entries(t.agent_hint)) {
    if (/[\u4e00-\u9fff]/.test(val)) {
      problems.push(`intervention: '${kind}' 的 agent_hint.${key} 混入中文——机器层跟桥合同语言（en），渲染器不得拼 zh`);
    }
  }
  // ③ summary ≤400 字。
  if (t.summary.length > HUMAN_LAYER_MAX_SUMMARY) {
    problems.push(`intervention: '${kind}' 的 summary ${t.summary.length} 字超预算（≤${HUMAN_LAYER_MAX_SUMMARY}）`);
  }
  // ④ human_question ≤120 字。
  if (t.human_question.length > HUMAN_LAYER_MAX_QUESTION) {
    problems.push(`intervention: '${kind}' 的 human_question ${t.human_question.length} 字超预算（≤${HUMAN_LAYER_MAX_QUESTION}）`);
  }
  // ⑤ 人话层禁 stopCode 键名 / JSON / 英文栈。
  for (const [field, text] of [["summary", t.summary], ["human_question", t.human_question]] as const) {
    if (STOPCODE_KEY_RE.test(text) && Object.keys(STOPCODE_MEANING).some((c) => text.includes(c))) {
      problems.push(`intervention: '${kind}' 的 ${field} 含 stopCode 键名——人话层不写给工程师看的停因词`);
    }
    if (JSON_SHAPE_RE.test(text)) {
      problems.push(`intervention: '${kind}' 的 ${field} 含 JSON 形状（{}[]/"）——人话层禁结构化词面`);
    }
    if (ENGLISH_STACK_RE.test(text)) {
      problems.push(`intervention: '${kind}' 的 ${field} 含英文栈帧——人话层禁调试词面`);
    }
  }
  // ⑥ agent_hint 不含面向人的祈使句（禁令只查中文祈使/终端指令词——en 陈述句合法）。
  for (const [key, val] of Object.entries(t.agent_hint)) {
    if (HUMAN_IMPERATIVE_RE.test(val)) {
      problems.push(`intervention: '${kind}' 的 agent_hint.${key} 含面向人的祈使句——机器层只写事实/建议/停手条件`);
    }
  }
}
// 其余三面文案（SIGNAL_NOT_HELD / OUTCOME_TEXTS / FULFILLED_NOT_HELD）：同为 zh 人话层，
// ① 非空、③ ≤400、⑤ 禁 stopCode 键名/JSON/英文栈（没有 human_question 面）。
const otherHumanTexts: Array<[string, string]> = [
  ["SIGNAL_NOT_HELD_TEXT", SIGNAL_NOT_HELD_TEXT],
  ...Object.entries(OUTCOME_TEXTS).map(([k, v]) => [`OUTCOME_TEXTS.${k}`, v] as [string, string]),
  ["FULFILLED_NOT_HELD_TEXT", FULFILLED_NOT_HELD_TEXT],
];
for (const [label, text] of otherHumanTexts) {
  if (text.trim() === "") problems.push(`intervention: ${label} 为空`);
  if (text.length > HUMAN_LAYER_MAX_SUMMARY) {
    problems.push(`intervention: ${label} ${text.length} 字超预算（≤${HUMAN_LAYER_MAX_SUMMARY}）`);
  }
  if (JSON_SHAPE_RE.test(text)) {
    problems.push(`intervention: ${label} 含 JSON 形状——人话层禁结构化词面`);
  }
  if (ENGLISH_STACK_RE.test(text)) {
    problems.push(`intervention: ${label} 含英文栈帧——人话层禁调试词面`);
  }
}

/* ---- 汇总 ------------------------------------------------------------------ */

// warn-only 组（bridge_desc）只观测、不阻断：打印在问题块之前，退出码不受影响。
for (const w of bridgeWarnings) console.error(`prompt-hit: warn — ${w}`);

if (problems.length) {
  for (const p of problems) console.error(`prompt-hit: ${p}`);
  process.exit(1);
}
// 分组清单式输出：文档引用组名，不引用编号（插组不会让既有引用失准）。
console.log(
  `prompt-hit: OK — grammar/pool/plan/bridge/doc/overview/coverage/intervention/model/agent/evidence/bridge_desc/clarity 十三组全绿（bridge_desc 仅 warn）：`
    + `hint ${HINT_SHAPES.length} 形状全部可解析且示例可命中，`
    + `信号 ${Object.keys(SIGNAL_OPS).length} 算子提示词↔校验器一致，`
    + `桥 session signal 描述列全同一闭集、drive_command.note 承诺↔校验↔透传一致，`
    + `停因 ${Object.keys(STOPCODE_MEANING).length} 个 next/豁免全覆盖，`
    + `概述层多面一致（AGENTS.md/桥/长度预算），CLI next 无死链，`
    + `求援文案 ${Object.keys(RESCUE_TEXTS).length} kind 六条清单全过，`
    + `模型 prompt ${PROMPT_SPECS.length} 条唯一文本 × ${PROMPT_SPECS.reduce((s, x) => s + x.consumers.length, 0)} 处消费点单源（快照 hash 一致），`
    + `Agent plan.rules ${new PlanningRules().promptText().length} 字符（预算 ${PLAN_RULES_SPEC.budget.maxChars}；`
    + `playbook ${PLAN_PLAYBOOK_SHORT.length}/${PLAN_PLAYBOOK_TEXT.length} ≤500/2200；候选窗口 ${CANDIDATE_WINDOW_TEXT.length} 字符由常量渲染），`
    + `证据 spec ${EVIDENCE_SPECS.length} 条（候选 40/120/200 分级预算 + 快照 hash 一致），`
    + `clarity 0 违规（模糊措辞/双重否定/长句/停因预算/概述结构）`,
);
