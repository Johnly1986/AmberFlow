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
} from "../src/support/session-contract.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const GENERATED_PATH = path.join(REPO, "integrations", "dsh-bridge", "src", "session-contract.generated.ts");

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
  return parts.join("\n");
}

function main(argv: readonly string[]): number {
  const write = argv.includes("--write");
  const check = argv.includes("--check");
  if (write === check) {
    console.error("usage: session-contract-gen (--write | --check)");
    return 2;
  }
  const problems = [...checkSets(), ...checkEngineContract(), ...checkOpMapping(), ...checkBounds()];
  if (problems.length > 0) {
    for (const problem of problems) console.error(`session-contract: ${problem}`);
    console.error("session-contract: 契约自检失败——先修 src/support/session-contract.ts（或引擎契约）");
    return 1;
  }
  const source = renderGenerated();
  const current = fs.existsSync(GENERATED_PATH) ? fs.readFileSync(GENERATED_PATH, "utf8") : "";
  if (write) {
    fs.writeFileSync(GENERATED_PATH, source);
    console.log(`session-contract-gen: 已写入 ${path.relative(REPO, GENERATED_PATH)}`);
    return 0;
  }
  if (current !== source) {
    console.error(`session-contract: ${path.relative(REPO, GENERATED_PATH)} 与契约不一致——运行 node --experimental-strip-types tools/session-contract-gen.ts --write`);
    return 1;
  }
  console.log(`session-contract: 生成物与契约一致（${path.relative(REPO, GENERATED_PATH)}）`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(main(process.argv.slice(2)));
}
