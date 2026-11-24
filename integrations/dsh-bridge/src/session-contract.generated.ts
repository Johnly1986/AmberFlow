/**
 * 生成物（勿手改）：由 tools/session-contract-gen.ts 从 src/support/session-contract.ts 生成。
 * 重新生成：node --experimental-strip-types tools/session-contract-gen.ts --write
 * 校验：node --experimental-strip-types tools/session-contract-gen.ts --check
 *
 * 桥包自带 tsconfig（rootDir=src）不能 import 仓库 src，所以会话协议闭集与数值界以常量投影
 * 到这里；引擎契约（src/app/session-runtime-contract.ts）与表的一致性由生成器交叉校验。
 */

/** 桥工具 op 闭集（桥序；工具 schema enum 与 op 校验共用）。 */
export const BRIDGE_SESSION_OPS = ["open", "goto", "observe", "act", "read", "extract", "signal", "wait_for", "snapshot", "tab", "drive", "drive_command", "drive_status", "drive_close", "close", "list"] as const;

/** 桥工具 op。 */
export type BridgeSessionOp = (typeof BRIDGE_SESSION_OPS)[number];

/** 桥 op → 引擎请求线 type（`list` 是桥本地 op，不在映射里）。 */
export const BRIDGE_OP_ENGINE_TYPE = {
  open: "open",
  goto: "goto",
  observe: "observe",
  act: "act",
  read: "read",
  extract: "extract",
  signal: "signal",
  wait_for: "waitFor",
  snapshot: "snapshot",
  tab: "tab",
  drive: "drive",
  drive_command: "driveCommand",
  drive_status: "driveStatus",
  drive_close: "driveClose",
  close: "close",
} as const;

/** act op 闭集。 */
export const BRIDGE_ACT_OPS = ["click", "check", "fill", "select", "hover", "scroll", "set_range"] as const;

/** act op。 */
export type BridgeActOp = (typeof BRIDGE_ACT_OPS)[number];

/** drive 的驾驶者闭集。 */
export const BRIDGE_DRIVE_DRIVERS = ["model", "agent"] as const;

/** drive 驾驶者。 */
export type BridgeDriveDriver = (typeof BRIDGE_DRIVE_DRIVERS)[number];

/** drive_command 的兜底指令闭集。 */
export const BRIDGE_DRIVE_COMMANDS = ["resume", "redirect", "finish", "abort"] as const;

/** 兜底指令。 */
export type BridgeDriveCommand = (typeof BRIDGE_DRIVE_COMMANDS)[number];

/** tab op 的动作闭集。 */
export const BRIDGE_TAB_ACTIONS = ["list", "switch"] as const;

/** tab 动作。 */
export type BridgeTabAction = (typeof BRIDGE_TAB_ACTIONS)[number];

/** open 的有头窗口尺寸闭集。 */
export const BRIDGE_WINDOW_MODES = ["maximized", "fullscreen"] as const;

/** 有头窗口尺寸。 */
export type BridgeWindowMode = (typeof BRIDGE_WINDOW_MODES)[number];

/** act 的歧义策略闭集。 */
export const BRIDGE_AMBIGUITY_MODES = ["fail", "act"] as const;

/** 歧义策略。 */
export type BridgeAmbiguousMode = (typeof BRIDGE_AMBIGUITY_MODES)[number];

/** act scroll 的 `to` 闭集。 */
export const BRIDGE_SCROLL_TARGETS = ["bottom", "top", "page"] as const;

/** scroll 目标。 */
export type BridgeScrollTarget = (typeof BRIDGE_SCROLL_TARGETS)[number];

/** read 的 `what` 闭集。 */
export const BRIDGE_READ_WHATS = ["text", "value", "count", "attr"] as const;

/** read 读取面。 */
export type BridgeReadWhat = (typeof BRIDGE_READ_WHATS)[number];

/** drive 请求的形状边界（max_steps / conf_floor / note）。 */
export const BRIDGE_DRIVE_LIMITS = {
  maxStepsMin: 1,
  maxStepsMax: 200,
  confFloorMin: 0,
  confFloorMax: 1,
  noteMaxChars: 300,
} as const;

/** 会话 idle TTL 的全部边界（缺省 / 显式下界 / CLI / 孤儿兜底 / 部署配置）。 */
export const BRIDGE_SESSION_IDLE = {
  defaultMs: 300000,
  minExplicitMs: 1000,
  engineCliMinMs: 0,
  engineCliMaxMs: 86400000,
  orphanDefaultMs: 600000,
  orphanFactor: 2,
  orphanCapMs: 86400000,
  configMinMs: 1000,
  configMaxMs: 3600000,
} as const;

/** 在册会话上限与部署配置 `maxSessions` 接受区间。 */
export const BRIDGE_SESSION_CONCURRENCY = {
  defaultMaxSessions: 2,
  configMinSessions: 1,
  configMaxSessions: 8,
} as const;

/** 读超时缺省与工具面数值界（goto / wait_for）。 */
export const BRIDGE_SESSION_TIMEOUTS = {
  opDefaultMs: 60000,
  openDefaultMs: 120000,
  reaperDefaultMs: 5000,
  timeoutFloorMs: 1000,
  reaperFloorMs: 50,
  gotoMinMs: 1,
  gotoMaxMs: 120000,
  waitMinMs: 0,
  waitMaxMs: 120000,
  waitDefaultMs: 15000,
} as const;
