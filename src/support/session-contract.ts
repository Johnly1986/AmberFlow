/**
 * session / pilot 协议**闭集与边界的唯一数据表**（L0，纯数据：只有 type 与 const）。
 *
 * 为什么要有它：同一批闭集与数值界原先在引擎请求线闭集、桥工具 op 表、工具 schema 的
 * enum、逐 op 形状校验四处各写一份，且四面并不对称——引擎请求集有协议内部 op `mark`，
 * 桥另有只在本地处理的 `list`；act op、drive 的 cmd/driver、max_steps 与 idle 界也是多写。
 * 任一处漏改就是「模型能传但引擎不认」或「引擎支持但桥推不出」的静默漂移。
 *
 * 桥包自带 tsconfig（`rootDir=src`）不能 import 仓库 `src`，所以桥只收
 * `tools/session-contract-gen.ts` 从本表生成的确定性投影
 * `integrations/dsh-bridge/src/session-contract.generated.ts`（check in，`--check` 判过期）。
 * 生成器同时把本表与引擎契约 `src/app/session-runtime-contract.ts` 交叉校验（请求 type 集、
 * act op 集、drive 的 driver/cmd 闭集与 max_steps / note 界、缺省 idle），两侧不等即红；
 * 因此本表是桥面闭集的**单源**，并被钉在引擎实现上。
 *
 * 改一个值 = 改本表 + `tools/session-contract-gen.ts --write`；引擎侧也变时同步改
 * `src/app/session-runtime-contract.ts`（生成器会拦住漏改）。生成物禁止手改。
 *
 * 纪律：本模块只放数据。判定/校验逻辑留在消费侧（引擎、桥、工具 schema 各自组装）。
 */
import { SESSION_IDLE_TIMEOUT_MS } from "./tuning.ts";

/* ------------------------------------------------------------ 请求 op（引擎协议 ↔ 桥工具面） */

/**
 * 引擎 session JSONL 请求线的 `type` 闭集（引擎序；唯一出处 = `SESSION_REQUEST_TYPES`）。
 *
 * 桥请求线使用其中除 `mark` 外的条目；`mark` 见 {@link SESSION_INTERNAL_OPS}。
 */
export const SESSION_ENGINE_REQUEST_TYPES = [
  "open", "goto", "observe", "act", "read", "extract", "waitFor", "signal", "snapshot", "mark", "tab",
  "drive", "driveCommand", "driveStatus", "driveClose", "close",
] as const;
export type SessionEngineRequestType = (typeof SESSION_ENGINE_REQUEST_TYPES)[number];

/** 引擎支持、桥工具面不暴露的协议内部 op（`mark` = 人工标记写轨迹）。 */
export const SESSION_INTERNAL_OPS = ["mark"] as const;

/**
 * 桥工具 `op` 闭集（桥序；工具 schema 的 enum、op 校验报错文案、`op:"list"` 语义共用）。
 *
 * 其中 `list` 只在桥本地枚举会话、不进引擎请求线（见 {@link SESSION_BRIDGE_ONLY_OPS}）。
 */
export const SESSION_BRIDGE_OPS = [
  "open", "goto", "observe", "act", "read", "extract", "signal", "wait_for", "snapshot", "tab",
  "drive", "drive_command", "drive_status", "drive_close", "close", "list",
] as const;
export type SessionBridgeOp = (typeof SESSION_BRIDGE_OPS)[number];

/** 桥本地处理、不进引擎请求线的 op。 */
export const SESSION_BRIDGE_ONLY_OPS = ["list"] as const;

/**
 * 桥 op → 引擎请求 `type` 的显式映射：**只登记两侧名字不同的条目**，未登记的桥 op 与引擎
 * type 同名（`open`/`goto`/`observe`/…）。桥发请求时经生成物里的映射取字面量，避免逐 op
 * 手写 wire 名。
 */
export const SESSION_OP_ENGINE_TYPE = {
  wait_for: "waitFor",
  drive_command: "driveCommand",
  drive_status: "driveStatus",
  drive_close: "driveClose",
} as const;

/* ------------------------------------------------------------ act / drive / tab 闭集 */

/** act op 闭集（与引擎执行器的 authoring MVP 能力面一致）。 */
export const SESSION_ACT_OPS = ["click", "check", "fill", "select", "hover", "scroll", "set_range"] as const;
export type SessionActOp = (typeof SESSION_ACT_OPS)[number];

/** drive 的驾驶者闭集：model = 每步决策模型投票；agent = 每步等兜底指令点名（零模型票）。 */
export const SESSION_DRIVE_DRIVERS = ["model", "agent"] as const;
export type SessionDriveDriver = (typeof SESSION_DRIVE_DRIVERS)[number];

/** drive_command 的兜底指令闭集（与 pilot 面同一套指令）。 */
export const SESSION_DRIVE_COMMANDS = ["resume", "redirect", "finish", "abort"] as const;
export type SessionDriveCommand = (typeof SESSION_DRIVE_COMMANDS)[number];

/** `drive` 请求的形状边界。`maxStepsMin/Max` 与引擎 `SESSION_DRIVE_MAX_STEPS`、pilot `--max-steps` 同口径。 */
export const SESSION_DRIVE_LIMITS = {
  maxStepsMin: 1,
  maxStepsMax: 200,
  confFloorMin: 0,
  confFloorMax: 1,
  /** `drive_command.note` 上界（引擎 `SESSION_DRIVE_NOTE_MAX_CHARS`）。 */
  noteMaxChars: 300,
} as const;

/** tab op 的动作闭集；缺省 `list`。 */
export const SESSION_TAB_ACTIONS = ["list", "switch"] as const;
/** open 的有头窗口尺寸闭集（仅 headful 会话可用）。 */
export const SESSION_WINDOW_MODES = ["maximized", "fullscreen"] as const;
/** act 的歧义策略闭集；缺省 `fail`（零动作 + 结构化 target_ambiguous）。 */
export const SESSION_AMBIGUITY_MODES = ["fail", "act"] as const;
/** act `scroll` 的 `to` 闭集。 */
export const SESSION_SCROLL_TARGETS = ["bottom", "top", "page"] as const;
/** read 的 `what` 闭集。 */
export const SESSION_READ_WHATS = ["text", "value", "count", "attr"] as const;

/* ------------------------------------------------------------ idle / 并发 / 超时界 */

/**
 * 会话 idle TTL 的全部边界（双层 idle：桥管理器 TTL + 引擎子进程孤儿兜底）。
 *
 * - `defaultMs` 同时是引擎 `--idle-timeout-ms` 缺省值与桥管理器缺省（同值同义）；
 * - 桥显式 `idle_timeout_ms` 只接受 `0` 或 ≥ `minExplicitMs` 的整数（`0` = 不限）；
 * - 引擎 CLI 的接受区间是 `[engineCliMinMs, engineCliMaxMs]`；
 * - 显式 ttl > 0 时下发给子进程的孤儿兜底 = clamp(`orphanFactor`×ttl, `orphanDefaultMs`, `orphanCapMs`)；
 * - 部署配置键 `sessionIdleMs` 的接受区间是 `[configMinMs, configMaxMs]`。
 */
export const SESSION_IDLE = {
  defaultMs: SESSION_IDLE_TIMEOUT_MS,
  minExplicitMs: 1_000,
  engineCliMinMs: 0,
  engineCliMaxMs: 24 * 60 * 60 * 1000,
  orphanDefaultMs: 2 * SESSION_IDLE_TIMEOUT_MS,
  orphanFactor: 2,
  orphanCapMs: 24 * 60 * 60 * 1000,
  configMinMs: 1_000,
  configMaxMs: 60 * 60 * 1000,
} as const;

/** 桥会话管理器的在册上限与部署配置 `maxSessions` 接受区间。 */
export const SESSION_CONCURRENCY = {
  defaultMaxSessions: 2,
  configMinSessions: 1,
  configMaxSessions: 8,
} as const;

/** 桥会话管理器的读超时缺省与工具面数值界（goto / wait_for）。 */
export const SESSION_TIMEOUTS = {
  /** 单 op 读超时缺省。 */
  opDefaultMs: 60_000,
  /** `open` 读超时缺省（首次启动浏览器 + 导航）。 */
  openDefaultMs: 120_000,
  /** idle reaper 扫描间隔缺省。 */
  reaperDefaultMs: 5_000,
  /** 管理器对 op/open 读超时的下界（低于它的配置值被抬到该值）。 */
  timeoutFloorMs: 1_000,
  /** reaper 间隔下界（测试可调小，但不低于该值）。 */
  reaperFloorMs: 50,
  gotoMinMs: 1,
  gotoMaxMs: 120_000,
  waitMinMs: 0,
  waitMaxMs: 120_000,
  waitDefaultMs: 15_000,
} as const;
