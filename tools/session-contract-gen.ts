/**
 * `session-contract-gen` —— 把共享契约 `src/support/session-contract.ts` 的桥侧子集生成为
 * `integrations/dsh-bridge/src/session-contract.generated.ts`（check in）。
 *
 * 为什么要有生成物：桥包自带 tsconfig（`rootDir=src`），不能 import 仓库 `src`；而会话协议
 * 闭集与数值界必须单源，所以桥只收一份**确定性**投影。生成物的任何手改都会在 `--check` 下判红。
 *
 * 用法：
 *   node --experimental-strip-types tools/session-contract-gen.ts --write   # 重新生成（改契约后）
 *   node --experimental-strip-types tools/session-contract-gen.ts --check   # 校验生成物是否过期
 *
 * 生成物是唯一写点；`--check` 顺带做契约自检（引擎请求 type 集 / act op 集 / drive 的
 * driver·cmd 闭集与 max_steps·note 界 / 缺省 idle 与 `src/app/session-runtime-contract.ts`
 * 逐值相等；桥 op ↔ 引擎 type 为双射，`mark` internal、`list` bridgeOnly）。退出码：
 * 0 = 一致；1 = 过期/契约自检失败；2 = 用法。
 */
import fs from "node:fs";
import path from "node:path";
import {
  SESSION_ACT_OPS as ENGINE_SESSION_ACT_OPS,
  SESSION_DEFAULT_IDLE_TIMEOUT_MS as ENGINE_SESSION_DEFAULT_IDLE_TIMEOUT_MS,
  SESSION_DRIVE_COMMANDS as ENGINE_SESSION_DRIVE_COMMANDS,
  SESSION_DRIVE_DRIVERS as ENGINE_SESSION_DRIVE_DRIVERS,
  SESSION_DRIVE_MAX_STEPS as ENGINE_SESSION_DRIVE_MAX_STEPS,
  SESSION_DRIVE_NOTE_MAX_CHARS as ENGINE_SESSION_DRIVE_NOTE_MAX_CHARS,
  SESSION_REQUEST_TYPES as ENGINE_SESSION_REQUEST_TYPES,
} from "../src/app/session-runtime-contract.ts";
import {
  SESSION_ACT_OPS,
  SESSION_AMBIGUITY_MODES,
  SESSION_BRIDGE_OPS,
  SESSION_BRIDGE_ONLY_OPS,
  SESSION_CONCURRENCY,
  SESSION_DRIVE_COMMANDS,
  SESSION_DRIVE_DRIVERS,
  SESSION_DRIVE_LIMITS,
  SESSION_ENGINE_REQUEST_TYPES,
  SESSION_IDLE,
  SESSION_INTERNAL_OPS,
  SESSION_OP_ENGINE_TYPE,
  SESSION_READ_WHATS,
  SESSION_SCROLL_TARGETS,
  SESSION_TAB_ACTIONS,
  SESSION_TIMEOUTS,
  SESSION_WINDOW_MODES,
  SESSION_ELEMENT_VIEW_FACES,
  SESSION_ELEMENT_VIEW_FIELDS,
  SESSION_ELEMENT_VIEW_LIMITS,
  SESSION_EVIDENCE_CAP_TABLE,
  SESSION_HANDOFF_CAP_TABLE,
} from "../src/support/session-contract.ts";
import {
  AMBIGUITY_HINT_MAX as ENGINE_AMBIGUITY_HINT_MAX,
  AMBIGUITY_LABEL_MAX as ENGINE_AMBIGUITY_LABEL_MAX,
  AMBIGUITY_MAX_CANDIDATES as ENGINE_AMBIGUITY_MAX_CANDIDATES,
  AMBIGUITY_ORIGIN_MAX as ENGINE_AMBIGUITY_ORIGIN_MAX,
} from "../src/engine/ambiguity.ts";
import { FULL_LABEL_MAX as ENGINE_FULL_LABEL_MAX } from "../src/engine/elem-model.ts";
import { frameChainValueProblem } from "../src/engine/hint.ts";
import { OBSERVE_HARD_MAX as ENGINE_OBSERVE_HARD_MAX, OBSERVE_DEFAULT_MAX as ENGINE_OBSERVE_DEFAULT_MAX } from "../src/engine/observe.ts";
import { EXTRACT_JS, OBSERVE_JS, ROW_CLIMB_JS, STRUCTURE_HELPERS_JS } from "../src/engine/pool-js.ts";
import { suggestHints } from "../src/engine/rules.ts";
import { projectHandoff } from "../src/app/session-driver.ts";
import { WEAK_PICKS_MAX, finalSignalFact, weakPicksFrom } from "../src/app/pilot-evidence.ts";
import { PILOT_STOP_CODES, unblockHintsFor } from "../src/app/pilot-contract.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const GENERATED_PATH = path.join(REPO, "integrations", "dsh-bridge", "src", "session-contract.generated.ts");
const ELEMENT_VIEW_GENERATED_PATH = path.join(
  REPO, "integrations", "dsh-bridge", "src", "element-view.constants.generated.ts",
);
/** 字段合同的三个对端源码（双向交叉校验的数据源；只做源码文本扫描，不求值类型）。 */
const OBSERVE_SRC_PATH = path.join(REPO, "src", "engine", "observe.ts");
const INSPECT_SRC_PATH = path.join(REPO, "src", "cli", "commands", "inspect.ts");
const POOL_VIEW_SRC_PATH = path.join(REPO, "src", "engine", "pool-view.ts");
const ELEMENT_VIEW_SRC_PATH = path.join(REPO, "integrations", "dsh-bridge", "src", "element-view.ts");
const AGENT_INTERFACE_PATH = path.join(REPO, "docs", "AGENT_INTERFACE.md");

type Value = string | number;
type Entries = ReadonlyArray<readonly [string, Value]>;

const isStringArray = (v: readonly unknown[]): boolean => v.every((x) => typeof x === "string" && x !== "");
const hasNoDuplicates = (v: readonly string[]): boolean => new Set(v).size === v.length;
const sameArray = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** 桥 op → 引擎 type 的完整映射（未登记别名 = 同名），按桥序。 */
function opEngineTypes(): Map<string, string> {
  const map = new Map<string, string>();
  for (const op of SESSION_BRIDGE_OPS) {
    if ((SESSION_BRIDGE_ONLY_OPS as readonly string[]).includes(op)) continue;
    const alias = (SESSION_OP_ENGINE_TYPE as Record<string, string>)[op];
    map.set(op, alias ?? op);
  }
  return map;
}

/** 闭集自身自检：非空、字符串、无重复。 */
function checkSets(): string[] {
  const problems: string[] = [];
  const sets: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["SESSION_ENGINE_REQUEST_TYPES", SESSION_ENGINE_REQUEST_TYPES],
    ["SESSION_BRIDGE_OPS", SESSION_BRIDGE_OPS],
    ["SESSION_INTERNAL_OPS", SESSION_INTERNAL_OPS],
    ["SESSION_BRIDGE_ONLY_OPS", SESSION_BRIDGE_ONLY_OPS],
    ["SESSION_ACT_OPS", SESSION_ACT_OPS],
    ["SESSION_DRIVE_DRIVERS", SESSION_DRIVE_DRIVERS],
    ["SESSION_DRIVE_COMMANDS", SESSION_DRIVE_COMMANDS],
    ["SESSION_TAB_ACTIONS", SESSION_TAB_ACTIONS],
    ["SESSION_WINDOW_MODES", SESSION_WINDOW_MODES],
    ["SESSION_AMBIGUITY_MODES", SESSION_AMBIGUITY_MODES],
    ["SESSION_SCROLL_TARGETS", SESSION_SCROLL_TARGETS],
    ["SESSION_READ_WHATS", SESSION_READ_WHATS],
  ];
  for (const [name, values] of sets) {
    if (values.length === 0) problems.push(`${name}: 闭集为空`);
    if (!isStringArray(values)) problems.push(`${name}: 闭集只能是字符串（不允许空串/非字符串）`);
    if (!hasNoDuplicates(values)) problems.push(`${name}: 闭集有条目重复`);
  }
  for (const [key, value] of Object.entries(SESSION_OP_ENGINE_TYPE)) {
    if (!(SESSION_BRIDGE_OPS as readonly string[]).includes(key)) problems.push(`SESSION_OP_ENGINE_TYPE: 键 ${key} 不在桥 op 闭集`);
    if (!(SESSION_ENGINE_REQUEST_TYPES as readonly string[]).includes(value)) problems.push(`SESSION_OP_ENGINE_TYPE: 值 ${value} 不在引擎请求 type 闭集`);
    if (key === value) problems.push(`SESSION_OP_ENGINE_TYPE: ${key} 是同名映射，不应登记（未登记即同名）`);
  }
  return problems;
}

/** 引擎契约交叉校验：表里每个引擎面值都必须与 `session-runtime-contract.ts` 逐值相等。 */
function checkEngineContract(): string[] {
  const problems: string[] = [];
  const expectSame = (name: string, table: readonly string[], engine: readonly string[]): void => {
    if (!sameArray(table, engine)) problems.push(`${name}: 表 ${JSON.stringify(table)} ≠ 引擎 ${JSON.stringify(engine)}`);
  };
  expectSame("SESSION_ENGINE_REQUEST_TYPES", SESSION_ENGINE_REQUEST_TYPES, ENGINE_SESSION_REQUEST_TYPES);
  expectSame("SESSION_ACT_OPS", SESSION_ACT_OPS, ENGINE_SESSION_ACT_OPS);
  expectSame("SESSION_DRIVE_DRIVERS", SESSION_DRIVE_DRIVERS, ENGINE_SESSION_DRIVE_DRIVERS);
  expectSame("SESSION_DRIVE_COMMANDS", SESSION_DRIVE_COMMANDS, ENGINE_SESSION_DRIVE_COMMANDS);
  if (SESSION_DRIVE_LIMITS.maxStepsMin !== ENGINE_SESSION_DRIVE_MAX_STEPS.min
    || SESSION_DRIVE_LIMITS.maxStepsMax !== ENGINE_SESSION_DRIVE_MAX_STEPS.max) {
    problems.push(`SESSION_DRIVE_LIMITS.maxSteps*: 表 ${SESSION_DRIVE_LIMITS.maxStepsMin}..${SESSION_DRIVE_LIMITS.maxStepsMax} `
      + `≠ 引擎 SESSION_DRIVE_MAX_STEPS ${ENGINE_SESSION_DRIVE_MAX_STEPS.min}..${ENGINE_SESSION_DRIVE_MAX_STEPS.max}`);
  }
  if (SESSION_DRIVE_LIMITS.noteMaxChars !== ENGINE_SESSION_DRIVE_NOTE_MAX_CHARS) {
    problems.push(`SESSION_DRIVE_LIMITS.noteMaxChars: 表 ${SESSION_DRIVE_LIMITS.noteMaxChars} ≠ 引擎 ${ENGINE_SESSION_DRIVE_NOTE_MAX_CHARS}`);
  }
  if (SESSION_IDLE.defaultMs !== ENGINE_SESSION_DEFAULT_IDLE_TIMEOUT_MS) {
    problems.push(`SESSION_IDLE.defaultMs: 表 ${SESSION_IDLE.defaultMs} ≠ 引擎 ${ENGINE_SESSION_DEFAULT_IDLE_TIMEOUT_MS}`);
  }
  return problems;
}

/** op 两侧映射自检：internal 只在引擎侧、bridgeOnly 只在桥侧，其余桥 op ↔ 引擎 type 为双射。 */
function checkOpMapping(): string[] {
  const problems: string[] = [];
  const engine = SESSION_ENGINE_REQUEST_TYPES as readonly string[];
  const bridge = SESSION_BRIDGE_OPS as readonly string[];
  const internal = SESSION_INTERNAL_OPS as readonly string[];
  const bridgeOnly = SESSION_BRIDGE_ONLY_OPS as readonly string[];
  for (const op of internal) {
    if (!engine.includes(op)) problems.push(`SESSION_INTERNAL_OPS: ${op} 不在引擎请求 type 闭集`);
    if (bridge.includes(op)) problems.push(`SESSION_INTERNAL_OPS: ${op} 不应出现在桥 op 闭集`);
  }
  for (const op of bridgeOnly) {
    if (!bridge.includes(op)) problems.push(`SESSION_BRIDGE_ONLY_OPS: ${op} 不在桥 op 闭集`);
    if (engine.includes(op)) problems.push(`SESSION_BRIDGE_ONLY_OPS: ${op} 不应出现在引擎请求 type 闭集`);
  }
  const mapping = opEngineTypes();
  const targets = new Set<string>();
  for (const [op, type] of mapping) {
    if (internal.includes(type)) problems.push(`${op}: 映射目标 ${type} 是 internal op（桥不得发协议内部请求）`);
    if (!engine.includes(type)) problems.push(`${op}: 映射目标 ${type} 不在引擎请求 type 闭集`);
    if (targets.has(type)) problems.push(`${op}: 映射目标 ${type} 与其它桥 op 重复`);
    targets.add(type);
  }
  const expected = engine.filter((type) => !internal.includes(type));
  const missing = expected.filter((type) => !targets.has(type));
  if (missing.length > 0) problems.push(`桥 op 未覆盖引擎请求 type：${missing.join(", ")}`);
  if (targets.size !== expected.length) problems.push(`桥 op → 引擎 type 映射不是双射（${targets.size} vs ${expected.length}）`);
  return problems;
}

/** 数值界自检：区间有序、缺省落在区间内、派生孤儿兜底与因子自洽。 */
function checkBounds(): string[] {
  const problems: string[] = [];
  const range = (name: string, min: number, max: number): void => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) problems.push(`${name}: 区间非法 ${min}..${max}`);
  };
  range("SESSION_DRIVE_LIMITS.maxSteps", SESSION_DRIVE_LIMITS.maxStepsMin, SESSION_DRIVE_LIMITS.maxStepsMax);
  range("SESSION_DRIVE_LIMITS.confFloor", SESSION_DRIVE_LIMITS.confFloorMin, SESSION_DRIVE_LIMITS.confFloorMax);
  range("SESSION_TIMEOUTS.goto", SESSION_TIMEOUTS.gotoMinMs, SESSION_TIMEOUTS.gotoMaxMs);
  range("SESSION_TIMEOUTS.wait", SESSION_TIMEOUTS.waitMinMs, SESSION_TIMEOUTS.waitMaxMs);
  range("SESSION_IDLE.engineCli", SESSION_IDLE.engineCliMinMs, SESSION_IDLE.engineCliMaxMs);
  range("SESSION_IDLE.config", SESSION_IDLE.configMinMs, SESSION_IDLE.configMaxMs);
  range("SESSION_CONCURRENCY.config", SESSION_CONCURRENCY.configMinSessions, SESSION_CONCURRENCY.configMaxSessions);
  if (SESSION_IDLE.minExplicitMs < 1) problems.push("SESSION_IDLE.minExplicitMs 必须 ≥ 1（`0` 是独立的“不限”语义）");
  if (!(SESSION_IDLE.defaultMs >= SESSION_IDLE.minExplicitMs)) problems.push("SESSION_IDLE.defaultMs 必须 ≥ minExplicitMs");
  if (SESSION_IDLE.orphanDefaultMs !== SESSION_IDLE.defaultMs * SESSION_IDLE.orphanFactor) {
    problems.push(`SESSION_IDLE.orphanDefaultMs 应为 defaultMs × orphanFactor（${SESSION_IDLE.defaultMs * SESSION_IDLE.orphanFactor}）`);
  }
  if (SESSION_IDLE.orphanCapMs < SESSION_IDLE.orphanDefaultMs) problems.push("SESSION_IDLE.orphanCapMs 必须 ≥ orphanDefaultMs");
  if (SESSION_IDLE.defaultMs > SESSION_IDLE.engineCliMaxMs || SESSION_IDLE.defaultMs > SESSION_IDLE.configMaxMs) {
    problems.push("SESSION_IDLE.defaultMs 必须落在引擎 CLI / 部署配置的接受区间内");
  }
  if (SESSION_TIMEOUTS.waitDefaultMs < SESSION_TIMEOUTS.waitMinMs || SESSION_TIMEOUTS.waitDefaultMs > SESSION_TIMEOUTS.waitMaxMs) {
    problems.push("SESSION_TIMEOUTS.waitDefaultMs 必须落在 wait 区间内");
  }
  if (SESSION_TIMEOUTS.timeoutFloorMs > SESSION_TIMEOUTS.opDefaultMs
    || SESSION_TIMEOUTS.timeoutFloorMs > SESSION_TIMEOUTS.openDefaultMs) {
    problems.push("SESSION_TIMEOUTS.timeoutFloorMs 不能高于 op/open 读超时缺省");
  }
  if (SESSION_TIMEOUTS.reaperFloorMs > SESSION_TIMEOUTS.reaperDefaultMs) {
    problems.push("SESSION_TIMEOUTS.reaperFloorMs 不能高于 reaper 间隔缺省");
  }
  if (SESSION_DRIVE_LIMITS.noteMaxChars < 1) problems.push("SESSION_DRIVE_LIMITS.noteMaxChars 必须 ≥ 1");
  return problems;
}

/** 桥侧投影需要的常量文本（生成物 = 这些片段的拼接，顺序固定）。 */
function tupleSource(name: string, values: readonly string[], doc: string): string {
  return `/** ${doc} */\nexport const ${name} = [${values.map((v) => JSON.stringify(v)).join(", ")}] as const;\n`;
}

function typeSource(name: string, tupleName: string, doc: string): string {
  return `/** ${doc} */\nexport type ${name} = (typeof ${tupleName})[number];\n`;
}

function objectSource(name: string, doc: string, entries: Entries): string {
  const lines = entries.map(([key, value]) => `  ${key}: ${typeof value === "number" ? String(value) : JSON.stringify(value)},`);
  return `/** ${doc} */\nexport const ${name} = {\n${lines.join("\n")}\n} as const;\n`;
}

/** 全部生成片段；`main` 只负责比对/落盘，便于 `--check` 与 `--write` 共用同一份文本。 */
function renderGenerated(): string {
  const mapping = opEngineTypes();
  const mapEntries: Entries = [...mapping].map(([op, type]) => [op, type] as const);
  const parts: string[] = [];
  parts.push(
    "/**\n"
    + " * 生成物（勿手改）：由 tools/session-contract-gen.ts 从 src/support/session-contract.ts 生成。\n"
    + " * 重新生成：node --experimental-strip-types tools/session-contract-gen.ts --write\n"
    + " * 校验：node --experimental-strip-types tools/session-contract-gen.ts --check\n"
    + " *\n"
    + " * 桥包自带 tsconfig（rootDir=src）不能 import 仓库 src，所以会话协议闭集与数值界以常量投影\n"
    + " * 到这里；引擎契约（src/app/session-runtime-contract.ts）与表的一致性由生成器交叉校验。\n"
    + " */\n",
  );
  parts.push(tupleSource("BRIDGE_SESSION_OPS", SESSION_BRIDGE_OPS, "桥工具 op 闭集（桥序；工具 schema enum 与 op 校验共用）。"));
  parts.push(typeSource("BridgeSessionOp", "BRIDGE_SESSION_OPS", "桥工具 op。"));
  parts.push(objectSource("BRIDGE_OP_ENGINE_TYPE", "桥 op → 引擎请求线 type（`list` 是桥本地 op，不在映射里）。", mapEntries));
  parts.push(tupleSource("BRIDGE_ACT_OPS", SESSION_ACT_OPS, "act op 闭集。"));
  parts.push(typeSource("BridgeActOp", "BRIDGE_ACT_OPS", "act op。"));
  parts.push(tupleSource("BRIDGE_DRIVE_DRIVERS", SESSION_DRIVE_DRIVERS, "drive 的驾驶者闭集。"));
  parts.push(typeSource("BridgeDriveDriver", "BRIDGE_DRIVE_DRIVERS", "drive 驾驶者。"));
  parts.push(tupleSource("BRIDGE_DRIVE_COMMANDS", SESSION_DRIVE_COMMANDS, "drive_command 的兜底指令闭集。"));
  parts.push(typeSource("BridgeDriveCommand", "BRIDGE_DRIVE_COMMANDS", "兜底指令。"));
  parts.push(tupleSource("BRIDGE_TAB_ACTIONS", SESSION_TAB_ACTIONS, "tab op 的动作闭集。"));
  parts.push(typeSource("BridgeTabAction", "BRIDGE_TAB_ACTIONS", "tab 动作。"));
  parts.push(tupleSource("BRIDGE_WINDOW_MODES", SESSION_WINDOW_MODES, "open 的有头窗口尺寸闭集。"));
  parts.push(typeSource("BridgeWindowMode", "BRIDGE_WINDOW_MODES", "有头窗口尺寸。"));
  parts.push(tupleSource("BRIDGE_AMBIGUITY_MODES", SESSION_AMBIGUITY_MODES, "act 的歧义策略闭集。"));
  parts.push(typeSource("BridgeAmbiguousMode", "BRIDGE_AMBIGUITY_MODES", "歧义策略。"));
  parts.push(tupleSource("BRIDGE_SCROLL_TARGETS", SESSION_SCROLL_TARGETS, "act scroll 的 `to` 闭集。"));
  parts.push(typeSource("BridgeScrollTarget", "BRIDGE_SCROLL_TARGETS", "scroll 目标。"));
  parts.push(tupleSource("BRIDGE_READ_WHATS", SESSION_READ_WHATS, "read 的 `what` 闭集。"));
  parts.push(typeSource("BridgeReadWhat", "BRIDGE_READ_WHATS", "read 读取面。"));
  parts.push(objectSource("BRIDGE_DRIVE_LIMITS", "drive 请求的形状边界（max_steps / conf_floor / note）。", [
    ["maxStepsMin", SESSION_DRIVE_LIMITS.maxStepsMin],
    ["maxStepsMax", SESSION_DRIVE_LIMITS.maxStepsMax],
    ["confFloorMin", SESSION_DRIVE_LIMITS.confFloorMin],
    ["confFloorMax", SESSION_DRIVE_LIMITS.confFloorMax],
    ["noteMaxChars", SESSION_DRIVE_LIMITS.noteMaxChars],
  ]));
  parts.push(objectSource("BRIDGE_SESSION_IDLE", "会话 idle TTL 的全部边界（缺省 / 显式下界 / CLI / 孤儿兜底 / 部署配置）。", [
    ["defaultMs", SESSION_IDLE.defaultMs],
    ["minExplicitMs", SESSION_IDLE.minExplicitMs],
    ["engineCliMinMs", SESSION_IDLE.engineCliMinMs],
    ["engineCliMaxMs", SESSION_IDLE.engineCliMaxMs],
    ["orphanDefaultMs", SESSION_IDLE.orphanDefaultMs],
    ["orphanFactor", SESSION_IDLE.orphanFactor],
    ["orphanCapMs", SESSION_IDLE.orphanCapMs],
    ["configMinMs", SESSION_IDLE.configMinMs],
    ["configMaxMs", SESSION_IDLE.configMaxMs],
  ]));
  parts.push(objectSource("BRIDGE_SESSION_CONCURRENCY", "在册会话上限与部署配置 `maxSessions` 接受区间。", [
    ["defaultMaxSessions", SESSION_CONCURRENCY.defaultMaxSessions],
    ["configMinSessions", SESSION_CONCURRENCY.configMinSessions],
    ["configMaxSessions", SESSION_CONCURRENCY.configMaxSessions],
  ]));
  parts.push(objectSource("BRIDGE_SESSION_TIMEOUTS", "读超时缺省与工具面数值界（goto / wait_for）。", [
    ["opDefaultMs", SESSION_TIMEOUTS.opDefaultMs],
    ["openDefaultMs", SESSION_TIMEOUTS.openDefaultMs],
    ["reaperDefaultMs", SESSION_TIMEOUTS.reaperDefaultMs],
    ["timeoutFloorMs", SESSION_TIMEOUTS.timeoutFloorMs],
    ["reaperFloorMs", SESSION_TIMEOUTS.reaperFloorMs],
    ["gotoMinMs", SESSION_TIMEOUTS.gotoMinMs],
    ["gotoMaxMs", SESSION_TIMEOUTS.gotoMaxMs],
    ["waitMinMs", SESSION_TIMEOUTS.waitMinMs],
    ["waitMaxMs", SESSION_TIMEOUTS.waitMaxMs],
    ["waitDefaultMs", SESSION_TIMEOUTS.waitDefaultMs],
  ]));
  parts.push(handoffCapsSource());
  parts.push(evidenceCapsSource());
  return parts.join("\n");
}

/* ------------------------------------------------------------- 三张 cap 表的交叉校验 */

/** 表里某行的引擎列（缺行 = 交叉校验无法进行，判红）。 */
function capRow(field: string): (typeof SESSION_HANDOFF_CAP_TABLE)[number] | undefined {
  return SESSION_HANDOFF_CAP_TABLE.find((row) => row.field === field);
}

/** 引擎列是否等于表值（`null` = 该层不设界，调用方不该出现）。 */
function expectEngineCap(problems: string[], field: string, actual: number): void {
  const row = capRow(field);
  if (row === undefined) { problems.push(`SESSION_HANDOFF_CAP_TABLE 缺行 ${JSON.stringify(field)}`); return; }
  if (row.engine !== actual) problems.push(`handoff ${field}: 表里 engine=${String(row.engine)}，引擎实测 ${actual}`);
}

/** handoff 三层 cap 表：引擎列按实测行为校验，producer 列按可导入的生成侧校验。 */
function checkHandoffCaps(): string[] {
  const problems: string[] = [];
  const longText = "x".repeat(1200);
  const evidence: Record<string, unknown> = {};
  for (let i = 0; i < 12; i += 1) evidence[`k${i}`] = longText;
  const picks = Array.from({ length: 8 }, (_, i) => ({
    step: i + 1, target: longText, conf: 0.1, picked_by: "model" as const,
  }));
  const view = projectHandoff({
    stop_code: PILOT_STOP_CODES[0], step_id: 3, goal_digest: longText,
    why_stuck: { summary: longText, evidence },
    what_would_unblock: Array.from({ length: 5 }, () => longText),
    evidence_refs: { screenshot: longText, dom: longText, pool_snapshot: longText, observe: longText },
    url: longText, weak_picks: picks, final_signal: longText,
  });
  const why = view["why_stuck"] as Record<string, unknown>;
  const bounded = why["evidence"] as Record<string, unknown>;
  const keys = bounded["keys"];
  expectEngineCap(problems, "goal_digest", String(view["goal_digest"]).length);
  expectEngineCap(problems, "why_stuck.summary", String(why["summary"]).length);
  const rowEvidenceKeys = capRow("why_stuck.evidence.keys");
  if (rowEvidenceKeys === undefined || rowEvidenceKeys.engine === null || !Array.isArray(keys)
    || keys.length > rowEvidenceKeys.engine) {
    problems.push("handoff why_stuck.evidence.keys：超限退化清单必须 ≤ 表列（8 条）");
  }
  if (bounded["truncated"] !== true) problems.push("handoff why_stuck.evidence：整块超表列时必须退化为 truncated 清单");
  problems.push(...checkEvidenceKeyPriority());
  const unblock = view["what_would_unblock"] as string[];
  const rowUnblock = capRow("what_would_unblock");
  if (rowUnblock === undefined || rowUnblock.engine !== unblock.length) problems.push("handoff what_would_unblock：引擎列与投影条数不等");
  for (const item of unblock) expectEngineCap(problems, "what_would_unblock[]", item.length);
  const refs = view["evidence_refs"] as Record<string, string>;
  for (const ref of Object.values(refs)) expectEngineCap(problems, "evidence_refs[]", ref.length);
  expectEngineCap(problems, "url", String(view["url"]).length);
  expectEngineCap(problems, "final_signal", String(view["final_signal"]).length);
  const viewPicks = view["weak_picks"] as Array<Record<string, unknown>>;
  const rowPicks = capRow("weak_picks");
  if (rowPicks === undefined || rowPicks.engine !== viewPicks.length) problems.push("handoff weak_picks：引擎列与投影条数不等");
  for (const pick of viewPicks) expectEngineCap(problems, "weak_picks[].target", String(pick["target"]).length);
  // producer 列：可由 pilot-evidence / pilot-contract 直接校验的两项。
  const rowWeak = capRow("weak_picks");
  if (rowWeak === undefined || rowWeak.producer !== WEAK_PICKS_MAX) problems.push("handoff weak_picks：producer 列必须等于 WEAK_PICKS_MAX");
  const weak = weakPicksFrom([{ step: 1, target: longText, picked_by: "model", conf: 0.01 }]);
  const weakTarget = weak === undefined ? 0 : weak[0]!.target.length;
  const rowWeakTarget = capRow("weak_picks[].target");
  if (rowWeakTarget === undefined || rowWeakTarget.producer !== weakTarget) problems.push("handoff weak_picks[].target：producer 列与 weakPicksFrom 实测不等");
  const finalFact = finalSignalFact({ goal: longText });
  const rowFinal = capRow("final_signal");
  if (rowFinal === undefined || rowFinal.producer !== (finalFact === null ? 0 : finalFact.length)) {
    problems.push("handoff final_signal：producer 列与 finalSignalFact 缺省界不等");
  }
  const rowUnblockProducer = capRow("what_would_unblock");
  // 现场事实（被排除帧 / 值需求）会让建议条数变多，故按最宽上下文取实测上界。
  const widest = {
    framesExcluded: ["http://frame-a.test", "http://frame-b.test"],
    needsValueKey: "value_key",
    needsValueTarget: "target label",
  };
  const unblockCount = Math.max(...PILOT_STOP_CODES.map((stop) => unblockHintsFor(stop, widest).length));
  if (rowUnblockProducer === undefined || rowUnblockProducer.producer !== unblockCount || unblockCount > 3) {
    problems.push("handoff what_would_unblock：producer 列必须等于闭集生成上限（≤3）");
  }
  return problems;
}

/**
 * 超限退化清单的**保现场**断言（可失败回归）：定位键优先保留，其余按原序补足到 8 条；
 * 未超限时投影逐字节等于原 evidence（`truncated` 键不出现）。
 *
 * `off_envelope` 在 evidence 里恰是第 9 个键（inert_run/forbidden/ledger/... 之后），纯按插入序
 * 截前 8 键会把它切掉——那正是真实停驶现场最需要的「是哪一步走出信封」的事实。
 */
function checkEvidenceKeyPriority(): string[] {
  const problems: string[] = [];
  const pad = "x".repeat(200);
  const longText = "x".repeat(1200);
  const project = (evidence: Record<string, unknown>): Record<string, unknown> => {
    const view = projectHandoff({
      stop_code: "host_not_allowed", step_id: 1, goal_digest: "g",
      why_stuck: { summary: "s", evidence }, what_would_unblock: [], evidence_refs: {}, url: "u",
    });
    return ((view["why_stuck"] as Record<string, unknown>)["evidence"] ?? {}) as Record<string, unknown>;
  };
  const padded = (keys: string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = pad;
    return out;
  };
  // ① 真实停驶现场量级（9 键，off_envelope 第 9）：定位键必须在退化清单里。
  const scene = project({
    inert_run: 3, forbidden: Array.from({ length: 40 }, (_, i) => `e${String(i)}`),
    ledger: [{ key: "k", tries: 3, last_outcome: longText }],
    loop_stop: { desc: longText, tries: 3 },
    frames_excluded: Array.from({ length: 6 }, (_, i) => ({ origin: `http://f${String(i)}.test`, index: i })),
    expect_url: "/maps", needs_value: { target: longText, key: "k", ref: "e1" },
    resume_hint: { hint: longText, missed: true }, off_envelope: "http://away.invalid/x",
  });
  if (scene["truncated"] !== true) problems.push("evidence 键优先级：9 键超限必须退化为 truncated 清单");
  const sceneKeys = Array.isArray(scene["keys"]) ? scene["keys"] as string[] : [];
  if (!sceneKeys.includes("off_envelope")) {
    problems.push("evidence 键优先级：真实停驶现场量级下 off_envelope 被截掉（截断须保定位键）");
  }
  for (const required of ["expect_url", "needs_value", "resume_hint"]) {
    if (!sceneKeys.includes(required)) problems.push(`evidence 键优先级：定位键 ${required} 被截掉`);
  }
  if (sceneKeys.length > 8) problems.push(`evidence 键优先级：退化清单 ${String(sceneKeys.length)} 条 > 8`);
  // ② 10 键且 off_envelope 在末尾：仍 ≤8 且保留它。
  const tail = project(padded([...Array.from({ length: 9 }, (_, i) => `k${String(i)}`), "off_envelope"]));
  const tailKeys = Array.isArray(tail["keys"]) ? tail["keys"] as string[] : [];
  if (tailKeys.length !== 8) problems.push(`evidence 键优先级：10 键退化清单应恰 8 条（实际 ${String(tailKeys.length)}）`);
  if (!tailKeys.includes("off_envelope")) problems.push("evidence 键优先级：off_envelope 在末尾时被截掉");
  // ③ 未超限：投影逐字节等于原 evidence，且不出现 truncated 键。
  const small = { inert_run: 0, forbidden: ["a"], off_envelope: "http://away.invalid/x" };
  const smallView = project(small);
  if (JSON.stringify(smallView) !== JSON.stringify(small)) {
    problems.push("evidence 键优先级：未超限时投影必须逐字节等于原 evidence");
  }
  return problems;
}

/** 证据块表：白名单非空 + 引擎侧可导入的界逐项相等（`frame_origin` 两层不同值在此钉住）。 */
function checkEvidenceCaps(): string[] {
  const problems: string[] = [];
  const ambiguity = SESSION_EVIDENCE_CAP_TABLE.ambiguity;
  if (ambiguity.matchedOthersMax !== 3) problems.push("evidence ambiguity.matchedOthersMax 必须为 3（引擎旁路与桥面同界）");
  if (ambiguity.matchedOthersMax > ENGINE_AMBIGUITY_MAX_CANDIDATES) problems.push("evidence ambiguity.matchedOthersMax 不得超过引擎候选上限");
  if (ambiguity.labelMaxChars !== ENGINE_AMBIGUITY_LABEL_MAX) problems.push("evidence ambiguity.labelMaxChars 与引擎 AMBIGUITY_LABEL_MAX 不等");
  if (ambiguity.frameOriginEngineMaxChars !== ENGINE_AMBIGUITY_ORIGIN_MAX) problems.push("evidence ambiguity.frameOriginEngineMaxChars 与引擎 AMBIGUITY_ORIGIN_MAX 不等");
  if (ambiguity.frameOriginMaxChars >= ambiguity.frameOriginEngineMaxChars) problems.push("evidence ambiguity.frameOriginMaxChars 必须窄于引擎界（两层界不同的现状）");
  for (const [name, block] of Object.entries(SESSION_EVIDENCE_CAP_TABLE)) {
    if ((block as { fields: readonly string[] }).fields.length === 0) problems.push(`evidence ${name}.fields 白名单为空`);
  }
  return problems;
}

/** 引擎常量/内嵌 JS 里的静态 pin：值必须与本表相等（漂移即红）。 */
function checkElementViewLimits(): string[] {
  const problems: string[] = [];
  const limits = SESSION_ELEMENT_VIEW_LIMITS;
  const at = (key: keyof typeof limits): number => (limits[key] as { value: number }).value;
  if (at("elementMax") !== ENGINE_OBSERVE_HARD_MAX) problems.push("ElementView elementMax 与引擎 OBSERVE_HARD_MAX 不等");
  if (at("elementDefaultMax") >= at("elementMax")) problems.push("ElementView elementDefaultMax 必须小于 elementMax");
  if (at("elementDefaultMax") !== ENGINE_OBSERVE_DEFAULT_MAX && at("elementDefaultMax") !== 60) problems.push("ElementView elementDefaultMax 只允许 60（桥/CLI 缺省）");
  if (at("hintMaxChars") !== ENGINE_AMBIGUITY_HINT_MAX) problems.push("ElementView hintMaxChars 与引擎 AMBIGUITY_HINT_MAX 不等");
  if (at("labelMaxChars") !== ENGINE_FULL_LABEL_MAX) problems.push("ElementView labelMaxChars 与引擎 FULL_LABEL_MAX 不等");
  const pins: ReadonlyArray<[string, string, string]> = [
    ["EXTRACT_JS", EXTRACT_JS, "slice(0, 8).map((c) => String(c).slice(0, 40))"],
    ["OBSERVE_JS", OBSERVE_JS, "slice(0, 8).map(function (c) { return String(c).slice(0, 40); })"],
    ["STRUCTURE_HELPERS_JS", STRUCTURE_HELPERS_JS, "__STRUCTURE_PATH_MAX = 160"],
    ["ROW_CLIMB_JS", ROW_CLIMB_JS, "rows.length < 6"],
  ];
  for (const [name, text, needle] of pins) {
    if (!text.includes(needle)) problems.push(`ElementView 静态 pin 丢失：${name} 不再包含 ${JSON.stringify(needle)}`);
  }
  if (!EXTRACT_JS.includes("slice(0, 8)") || !OBSERVE_JS.includes("slice(0, 8)")) problems.push("ElementView 类名条数 pin 失效");
  if (at("classNamesPerElement") !== 8) problems.push("ElementView classNamesPerElement 必须为 8（引擎内嵌 JS 口径）");
  if (at("classNameMaxChars") !== 40) problems.push("ElementView classNameMaxChars 必须为 40（引擎内嵌 JS 口径）");
  if (at("structurePathMaxChars") !== 160) problems.push("ElementView structurePathMaxChars 与引擎 __STRUCTURE_PATH_MAX 不等");
  if (at("rowTextsMaxLines") !== 6) problems.push("ElementView rowTextsMaxLines 必须为 6（引擎 row 爬上界）");
  if (at("rowTextsLineMaxChars") !== 40) problems.push("ElementView rowTextsLineMaxChars 必须为 40（引擎行过滤口径）");
  const fourSegments = "http://a.test>http://b.test>http://c.test>http://d.test";
  const fiveSegments = `${fourSegments}>http://e.test`;
  if (frameChainValueProblem(fourSegments) !== null) problems.push("ElementView framePathMaxItems 与 hint 帧链判定不符（4 段应合法）");
  const tooLong = frameChainValueProblem(fiveSegments);
  if (tooLong === null || tooLong.kind !== "too-long") problems.push("ElementView framePathMaxItems 与 hint 帧链判定不符（5 段应 too-long）");
  const hintCount = suggestHints(
    { ref: "e0", tag: "button", label: "Go", data_test: "go-x", id: "go-id", name: "go-name" },
    { e0: { ref: "e0", tag: "button", label: "Go", data_test: "go-x", id: "go-id", name: "go-name" }, e1: { ref: "e1", tag: "a", label: "Go" } },
  ).length;
  if (hintCount > at("hintsPerElement")) problems.push("ElementView hintsPerElement 小于引擎 suggestHints 实测条数");
  if (at("hintsPerElement") !== 6) problems.push("ElementView hintsPerElement 必须为 6（兼容性 cap，宽于引擎实际上限）");
  return problems;
}

/**
 * 字段合同的**双向交叉校验**：表 ↔ 三面源码（引擎 observe / inspect 元素行 / 桥投影）。
 *
 * 用源码文本扫描而不是类型：桥包 tsconfig（rootDir=src）不能 import 仓库 `src`，inspect 的元素
 * 行又是命令内的局部类型。表要钉的事实正是"某个键在那一面的源码里到底在不在"——漏登记/多登记
 * 一律红，键名漂移（引擎 `type` ↔ 桥 `input_type`）必须在表里显式写成不同列。
 */
function sourceFieldNames(text: string, iface: string): string[] {
  const body = new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`).exec(text)?.[1];
  if (body === undefined) return [];
  return [...body.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1]!);
}

/** 对象字面量里出现的键（`{ k: …` / `, k: …` / `{ k }` 简写）。 */
function objectKeysIn(text: string): string[] {
  return [...new Set([...text.matchAll(/(?:^|[{,]\s*)([a-z][a-z0-9_]*)\s*[:,}]/gm)].map((m) => m[1]!))];
}

/**
 * inspect 元素行的键：行字面量本身的键 + `PoolView.extras` 的键。
 *
 * extras 的键名唯一出处是 `PoolElemView.extras` 的类型声明（`Partial<Record<…>>`）——行里用
 * `...e.extras` 整块展开，字面量扫描看不见这些键。
 */
function inspectRowKeys(inspectText: string, poolViewText: string): string[] {
  const start = inspectText.indexOf("const elements: InspectElement[] = view.elements.map((e) => {");
  const end = start < 0 ? -1 : inspectText.indexOf("const text = wantText", start);
  if (start < 0 || end < 0) return [];
  const extras = /extras: Partial<Record<([\s\S]*?)>>/.exec(poolViewText)?.[1] ?? "";
  const extrasKeys = [...extras.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
  return [...new Set([...objectKeysIn(inspectText.slice(start, end)), ...extrasKeys])];
}

/** 桥 `projectElementView` 的函数体（读引擎键 + 组装桥行的唯一写点）。 */
function bridgeProjectionBody(elementViewText: string): string {
  const start = elementViewText.indexOf("export function projectElementView(raw: unknown): ElementView | null {");
  const end = start < 0 ? -1 : elementViewText.indexOf("\nexport function projectElementViews", start);
  return start < 0 || end < 0 ? "" : elementViewText.slice(start, end);
}

function checkElementViewFields(): string[] {
  const problems: string[] = [];
  const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
  const observeText = read(OBSERVE_SRC_PATH);
  const inspectKeys = inspectRowKeys(read(INSPECT_SRC_PATH), read(POOL_VIEW_SRC_PATH));
  const elementViewText = read(ELEMENT_VIEW_SRC_PATH);
  const projection = bridgeProjectionBody(elementViewText);

  const engineObserve = sourceFieldNames(observeText, "ObserveElement");
  const bridgeFields = sourceFieldNames(elementViewText, "ElementView");
  if (engineObserve.length === 0) problems.push("字段合同：src/engine/observe.ts 的 ObserveElement 接口扫不到字段（源码形状变了，断言空转）");
  if (bridgeFields.length === 0) problems.push("字段合同：element-view.ts 的 ElementView 接口扫不到字段（源码形状变了，断言空转）");
  if (inspectKeys.length === 0) problems.push("字段合同：inspect 元素行扫不到键（源码形状变了，断言空转）");
  if (projection === "") problems.push("字段合同：element-view.ts 的 projectElementView 函数体扫不到（源码形状变了，断言空转）");

  const tableFields = SESSION_ELEMENT_VIEW_FIELDS.map((row) => row.field);
  const dups = tableFields.filter((f, i) => tableFields.indexOf(f) !== i);
  if (dups.length > 0) problems.push(`字段合同：字段重复登记 ${[...new Set(dups)].join(", ")}`);

  const engineObserveInTable = new Set(SESSION_ELEMENT_VIEW_FIELDS.map((row) => row.engineObserve).filter((v): v is string => v !== null));
  const engineInspectInTable = new Set(SESSION_ELEMENT_VIEW_FIELDS.map((row) => row.engineInspect).filter((v): v is string => v !== null));
  const bridgeInTable = new Set(SESSION_ELEMENT_VIEW_FIELDS.map((row) => row.bridge).filter((v): v is string => v !== null));

  // ① 表 → 源码：每个登记的键必须真的在那一面存在。
  for (const row of SESSION_ELEMENT_VIEW_FIELDS) {
    if (row.engineObserve !== null && !engineObserve.includes(row.engineObserve)) {
      problems.push(`字段合同：${row.field}.engineObserve=${row.engineObserve} 不在 ObserveElement`);
    }
    if (row.engineInspect !== null && !inspectKeys.includes(row.engineInspect)) {
      problems.push(`字段合同：${row.field}.engineInspect=${row.engineInspect} 不在 inspect 元素行`);
    }
    if (row.bridge !== null && !bridgeFields.includes(row.bridge)) {
      problems.push(`字段合同：${row.field}.bridge=${row.bridge} 不在 ElementView`);
    }
  }
  // ② 源码 → 表：三面里的每个键都必须在表里有行（任一方向漏登记 = 红）。
  for (const name of engineObserve) {
    if (!engineObserveInTable.has(name)) problems.push(`字段合同：ObserveElement.${name} 未登记进 SESSION_ELEMENT_VIEW_FIELDS`);
  }
  for (const name of inspectKeys) {
    if (!engineInspectInTable.has(name)) problems.push(`字段合同：inspect 元素行 ${name} 未登记进 SESSION_ELEMENT_VIEW_FIELDS`);
  }
  for (const name of bridgeFields) {
    if (!bridgeInTable.has(name)) problems.push(`字段合同：ElementView.${name} 未登记进 SESSION_ELEMENT_VIEW_FIELDS`);
  }

  // ③ 核心不变量：地址只来自 hint_candidates（全表 address:true 有且只有它）。
  const addressFields = SESSION_ELEMENT_VIEW_FIELDS.filter((row) => row.address).map((row) => row.field);
  if (addressFields.length !== 1 || addressFields[0] !== "hint_candidates") {
    problems.push(`字段合同：address:true 必须恰好是 hint_candidates（实际 ${JSON.stringify(addressFields)}）——地址只来自自证 hint 候选`);
  }

  // ③b. `shape_problem.kind` 闭集必须与引擎侧 union 一致（新增类别忘了同步表 = 桥面静默丢诊断）。
  const declaredKinds = SESSION_EVIDENCE_CAP_TABLE.miss.shapeProblemKinds;
  const hintSrc = fs.readFileSync(path.join(REPO, "src/engine/hint.ts"), "utf-8");
  const unionBlock = hintSrc.split("export type HintShapeProblemKind")[1]?.split(";")[0] ?? "";
  for (const k of declaredKinds) {
    if (!unionBlock.includes(`"${k}"`)) problems.push(`证据块 miss.shapeProblemKinds 含 ${JSON.stringify(k)}，但 HintShapeProblemKind union 里没有`);
  }
  for (const m of unionBlock.matchAll(/"([a-z-]+)"/g)) {
    if (!(declaredKinds as readonly string[]).includes(m[1]!)) {
      problems.push(`HintShapeProblemKind 有 ${JSON.stringify(m[1])}，但 miss.shapeProblemKinds 未登记（桥面会丢掉该类别）`);
    }
  }

  // ④ 出现面自洽：只有一面产出的键不能声称另一面有；桥侧派生位（截断标记等）要显式登记。
  for (const row of SESSION_ELEMENT_VIEW_FIELDS) {
    const only = row.engineOnly ?? [];
    const derived = row.derived ?? [];
    const bridgedObserve = (row.engineObserve !== null && !only.includes("observe")) || derived.includes("observe");
    const bridgedInspect = (row.engineInspect !== null && !only.includes("inspect")) || derived.includes("inspect");
    const expected = bridgedObserve && bridgedInspect ? "both" : bridgedObserve ? "observe" : bridgedInspect ? "inspect" : null;
    if (expected === null) {
      problems.push(`字段合同：${row.field} 在两面桥输出里都不会出现（登记它没有意义）`);
    } else if (row.faces !== expected) {
      problems.push(`字段合同：${row.field} 的 faces=${row.faces}，按键名与派生位推导应为 ${expected}`);
    }
    for (const face of [row.faces, ...derived]) {
      if (!(SESSION_ELEMENT_VIEW_FACES as readonly string[]).includes(face)) {
        problems.push(`字段合同：${row.field} 的出现面 ${face} 不在闭集`);
      }
    }
  }

  // ⑤ 桥投影赋值点：每个引擎键都要么被桥读、要么在表里显式登记为「引擎有桥不给」。
  for (const row of SESSION_ELEMENT_VIEW_FIELDS) {
    const only = row.engineOnly ?? [];
    for (const [face, key] of [["observe", row.engineObserve], ["inspect", row.engineInspect]] as const) {
      if (key === null) continue;
      const readByBridge = projection.includes(`raw['${key}']`);
      if (only.includes(face) && readByBridge) {
        problems.push(`字段合同：${row.field} 登记了 engineOnly:${face}（引擎有桥不给），但桥投影确实读了 raw['${key}']`);
      }
      if (!only.includes(face) && !readByBridge) {
        problems.push(`字段合同：${row.field} 在 ${face} 面有引擎键 ${key}，但桥投影没有读它（要么接线，要么登记 engineOnly:${face}）`);
      }
    }
    if (row.bridge !== null && !new RegExp(`(?:^|[{,]\\s*)${row.field}\\s*[:,}]`, "m").test(projection)) {
      problems.push(`字段合同：${row.field} 在 ElementView 合同里，但 projectElementView 没有赋值点（字段名出现性检查）`);
    }
  }

  // ⑥ caps 必须指向真实上限键，且每个上限键至少被一处引用（不留死引用；行数上限键除外）。
  const limitKeys = Object.keys(SESSION_ELEMENT_VIEW_LIMITS);
  const usedCaps = new Set(SESSION_ELEMENT_VIEW_FIELDS.flatMap((row) => [...(row.caps ?? [])]));
  for (const cap of usedCaps) {
    if (!limitKeys.includes(cap)) problems.push(`字段合同：caps 引用了不存在的上限键 ${cap}`);
  }
  for (const key of limitKeys) {
    if (!usedCaps.has(key) && key !== "elementDefaultMax" && key !== "elementMax") {
      problems.push(`字段合同：上限键 ${key} 没有被任何字段行引用（行数上限键除外）`);
    }
  }

  // ⑦ 文档表 = 本表的渲染，不许手写漂移：§3.2 的行集合与地址标记必须逐行一致。
  const section = read(AGENT_INTERFACE_PATH).split("### 3.2 观察面元素投影合同")[1]?.split("\n### ")[0] ?? "";
  if (section === "") problems.push("字段合同：docs/AGENT_INTERFACE.md §3.2 锚点丢失（文档表断言失去锚点）");
  else {
    const rows = new Map([...section.matchAll(/^\| `([a-z_]+)` \|([^\n]*)$/gm)].map((m) => [m[1]!, m[2]!]));
    for (const row of SESSION_ELEMENT_VIEW_FIELDS) {
      const cells = rows.get(row.field);
      if (cells === undefined) { problems.push(`字段合同：§3.2 表缺 ${row.field} 行`); continue; }
      if ((cells.split("|")[3] ?? "").includes("✅") !== row.address) {
        problems.push(`字段合同：§3.2 表 ${row.field} 的「可作地址」标记与表不一致`);
      }
    }
    for (const name of rows.keys()) {
      if (!SESSION_ELEMENT_VIEW_FIELDS.some((r) => r.field === name)) problems.push(`字段合同：§3.2 表多出未登记字段 ${name}`);
    }
  }
  return problems;
}

/** handoff 三层 cap 表的桥侧投影：只取有 `bridgeKey` 的行（桥透出条目的桥列为准）。 */
function handoffCapsSource(): string {
  const rows = SESSION_HANDOFF_CAP_TABLE.filter((row) => "bridgeKey" in row);
  const entries: Entries = rows.map((row) => {
    const key = (row as { bridgeKey: string }).bridgeKey;
    return [key, (row as { bridge: number }).bridge] as const;
  });
  return objectSource(
    "BRIDGE_HANDOFF_CAPS",
    "交接块桥面 cap（`bridge` 列；字段×各层全表见 src/support/session-contract.ts 的 SESSION_HANDOFF_CAP_TABLE）。",
    entries,
  );
}

/** 证据块白名单与 cap 的桥侧投影（五个投影各自一块）。 */
function evidenceCapsSource(): string {
  const blocks: string[] = [];
  for (const [name, block] of Object.entries(SESSION_EVIDENCE_CAP_TABLE)) {
    const table = block as Record<string, unknown>;
    const fields = table["fields"] as readonly string[];
    const tupleName = `BRIDGE_EVIDENCE_${name.toUpperCase()}_FIELDS`;
    blocks.push(tupleSource(tupleName, fields, `${name} 证据块白名单（引擎给了才出现）。`));
    const caps: Entries = Object.entries(table)
      .filter(([key, value]) => key !== "fields" && key !== "bridgeKey" && key !== "note" && typeof value === "number")
      .map(([key, value]) => [key, value as number] as const);
    // 闭集列（字符串数组，如 shape_problem.kind）：投影成 tuple，桥按它过滤——引擎新增
    // 类别必须同步契约表，否则桥面会静默丢掉该类别（诊断变哑）。
    for (const [key, value] of Object.entries(table)) {
      if (!Array.isArray(value)) continue;
      if (key === "fields" || key === "strategies" || key === "probes") continue;  // 已由各自的 tuple 覆盖
      blocks.push(tupleSource(
        `BRIDGE_EVIDENCE_${name.toUpperCase()}_${key.toUpperCase()}`,
        value as readonly string[],
        `${name} 证据块 ${key} 的闭集。`,
      ));
    }
    if (caps.length === 0) continue; // 无字符/条数界的块只投影白名单（像素/数值类不受界）
    blocks.push(objectSource(
      `BRIDGE_EVIDENCE_${name.toUpperCase()}_CAPS`,
      `${name} 证据块的字段 cap（白名单见 ${tupleName}）。`,
      caps,
    ));
  }
  return blocks.join("\n");
}

/** ElementView 常量生成物文本（独立文件；桥 `element-view.ts` 从这里读值）。 */
function renderElementViewConstants(): string {
  const lines: string[] = [
    "/**",
    " * 生成物（勿手改）：tools/session-contract-gen.ts 从 src/support/session-contract.ts 的",
    " * SESSION_ELEMENT_VIEW_LIMITS 与 SESSION_ELEMENT_VIEW_FIELDS 生成（check in）。",
    " * 重新生成 / 校验：session-contract-gen --write | --check。",
    " * 桥包 tsconfig（rootDir=src）不能 import 仓库 src，故上限与字段合同以常量投影到这里。",
    " */",
    "",
  ];
  for (const [key, spec] of Object.entries(SESSION_ELEMENT_VIEW_LIMITS)) {
    const { value, note } = spec as { value: number; note: string };
    lines.push(`/** ${note} */`);
    lines.push(`export const ${key} = ${value};`);
    lines.push("");
  }
  lines.push(...elementViewFieldsSource());
  return lines.join("\n");
}

/**
 * 字段合同投影：桥侧只需要「字段名 + 出现面 + 能否作地址 + cap 键」这四件事实。
 * 语义/差异说明留在仓库表里（`src/support/session-contract.ts`），桥侧不重复一份散文——
 * 散文一进生成物就会和权威表说法对不上。
 */
function elementViewFieldsSource(): string[] {
  const lines: string[] = [
    "/* ----------------------------------------------------- 字段合同（生成） */",
    "",
    "/**",
    " * 元素行字段的出现面闭集（与仓库表 `SESSION_ELEMENT_VIEW_FIELDS.faces` 同值域）。",
    " * `both` = inspect 与 session `observe` 两面都带；另两值表示只有该面带。",
    " */",
    `export const ELEMENT_VIEW_FACES = [${SESSION_ELEMENT_VIEW_FACES.map((f) => JSON.stringify(f)).join(", ")}] as const;`,
    "export type ElementViewFace = (typeof ELEMENT_VIEW_FACES)[number];",
    "",
    "/** 一个元素行字段的桥侧合同事实（键名以桥面为准）。 */",
    "export interface ElementViewFieldSpec {",
    "  field: string;",
    "  faces: ElementViewFace;",
    "  /** 能否直接作为 act/read 的动作地址（全表有且只有 `hint_candidates`）。 */",
    "  address: boolean;",
    "  /** 关联的上限键（`null` = 无字符/条数界）。 */",
    "  caps: readonly string[] | null;",
    "}",
    "",
    "/**",
    " * 元素行字段合同（唯一出处 = src/support/session-contract.ts 的 SESSION_ELEMENT_VIEW_FIELDS）。",
    " *",
    " * **地址只来自 `hint_candidates`**：`address` 字段在整张表里恰好一条为 `true`，生成器断言。",
    " * `ref` 是展示/对账锚，`structure_path` 是诊断证据，`label`/`bbox`/`class_names` 是人读信息——",
    " * 它们都不可当 target；act/read/extract 的 target 只认 hint 字符串或 CSS。",
    " */",
    "export const ELEMENT_VIEW_FIELDS: readonly ElementViewFieldSpec[] = [",
  ];
  for (const row of SESSION_ELEMENT_VIEW_FIELDS) {
    const caps = row.caps === null ? "null" : `[${row.caps.map((c) => JSON.stringify(c)).join(", ")}]`;
    lines.push(`  { field: ${JSON.stringify(row.field)}, faces: ${JSON.stringify(row.faces)}, address: ${row.address ? "true" : "false"}, caps: ${caps} },`);
  }
  lines.push("];");
  lines.push("");
  return lines;
}

function main(argv: readonly string[]): number {
  const write = argv.includes("--write");
  const check = argv.includes("--check");
  if (write === check) {
    console.error("usage: session-contract-gen (--write | --check)");
    return 2;
  }
  const problems = [
    ...checkSets(), ...checkEngineContract(), ...checkOpMapping(), ...checkBounds(),
    ...checkHandoffCaps(), ...checkEvidenceCaps(), ...checkElementViewLimits(), ...checkElementViewFields(),
  ];
  // 生成物快照先算齐（契约自检失败时也要能报错，故 render 只在通过后调用）。
  if (problems.length > 0) {
    for (const problem of problems) console.error(`session-contract: ${problem}`);
    console.error("session-contract: 契约自检失败——先修 src/support/session-contract.ts（或引擎契约）");
    return 1;
  }
  const artifacts: ReadonlyArray<{ path: string; source: string }> = [
    { path: GENERATED_PATH, source: renderGenerated() },
    { path: ELEMENT_VIEW_GENERATED_PATH, source: renderElementViewConstants() },
  ];
  if (write) {
    for (const artifact of artifacts) {
      fs.writeFileSync(artifact.path, artifact.source);
      console.log(`session-contract-gen: 已写入 ${path.relative(REPO, artifact.path)}`);
    }
    return 0;
  }
  const stale = artifacts.filter((artifact) => {
    const current = fs.existsSync(artifact.path) ? fs.readFileSync(artifact.path, "utf8") : "";
    return current !== artifact.source;
  });
  if (stale.length > 0) {
    for (const artifact of stale) {
      console.error(`session-contract: ${path.relative(REPO, artifact.path)} 与契约不一致——运行 node --experimental-strip-types tools/session-contract-gen.ts --write`);
    }
    return 1;
  }
  console.log(`session-contract: 生成物与契约一致（${artifacts.map((a) => path.relative(REPO, a.path)).join(" / ")}）`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(main(process.argv.slice(2)));
}
