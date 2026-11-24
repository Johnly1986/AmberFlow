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

/** 交接块桥面 cap（`bridge` 列；字段×各层全表见 src/support/session-contract.ts 的 SESSION_HANDOFF_CAP_TABLE）。 */
export const BRIDGE_HANDOFF_CAPS = {
  goalDigestMaxChars: 300,
  summaryMaxChars: 300,
  unblockMaxItems: 3,
  unblockItemMaxChars: 200,
  urlMaxChars: 300,
  finalSignalMaxChars: 200,
  weakPicksMax: 6,
  weakPickTargetMaxChars: 120,
  weakPickPickedByMaxChars: 20,
} as const;

/** scroll 证据块白名单（引擎给了才出现）。 */
export const BRIDGE_EVIDENCE_SCROLL_FIELDS = ["moved", "delta", "scroll"] as const;

/** range 证据块白名单（引擎给了才出现）。 */
export const BRIDGE_EVIDENCE_RANGE_FIELDS = ["applied", "accurate", "strategy", "achieved", "requested", "target_value", "clamped_from", "probe"] as const;

/** ambiguity 证据块白名单（引擎给了才出现）。 */
export const BRIDGE_EVIDENCE_AMBIGUITY_FIELDS = ["ambiguous", "matched_others", "hint_kind", "hint_tier", "hint_suspicious"] as const;

/** ambiguity 证据块的字段 cap（白名单见 BRIDGE_EVIDENCE_AMBIGUITY_FIELDS）。 */
export const BRIDGE_EVIDENCE_AMBIGUITY_CAPS = {
  matchedOthersMax: 3,
  labelMaxChars: 40,
  frameOriginMaxChars: 60,
  frameOriginEngineMaxChars: 120,
} as const;

/** miss 证据块白名单（引擎给了才出现）。 */
export const BRIDGE_EVIDENCE_MISS_FIELDS = ["target", "pool_size", "hint_shape", "hint_len", "settle_timed_out", "settle_waited_ms", "rescan", "candidates", "near", "rejected"] as const;

/** miss 证据块的字段 cap（白名单见 BRIDGE_EVIDENCE_MISS_FIELDS）。 */
export const BRIDGE_EVIDENCE_MISS_CAPS = {
  candidatesMax: 3,
  nearMax: 3,
  rejectedMax: 2,
  refMaxChars: 16,
  tagMaxChars: 16,
  labelMaxChars: 40,
  whyMaxChars: 40,
  hintShapeMaxChars: 32,
} as const;

/** wide 证据块白名单（引擎给了才出现）。 */
export const BRIDGE_EVIDENCE_WIDE_FIELDS = ["candidates", "window", "pool_size"] as const;

/** wide 证据块的字段 cap（白名单见 BRIDGE_EVIDENCE_WIDE_FIELDS）。 */
export const BRIDGE_EVIDENCE_WIDE_CAPS = {
  candidatesMax: 40,
  tagMaxChars: 16,
  labelMaxChars: 40,
  hintMaxChars: 200,
} as const;
