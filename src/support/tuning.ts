/**
 * 引擎调参常量（L1）——**同一概念只写一次**。
 *
 * 收口口径（P1 批 1.1）：只收跨模块多写、且不可由配置键覆盖的数值；每个常量一行注释标明
 * 唯一出处与消费面。L0 配置键/默认值仍由 `src/support/config-schema.ts` 唯一声明，本模块
 * 不复制配置面语义（唯一例外 `DECISION_REQUEST_TIMEOUT_MS` 是配置默认值的引擎别名）。
 *
 * 纪律：
 *   - **不合并同值不同义**：HTTP 400 ≠ 文本预算 400；导航 goto 30s ≠ ssh 子进程 30s ≠ 数据腿 30s；
 *     稳定门 400/5000 与工具步超时 5000 也不共用（后者是每动作超时，不在本模块收口范围）。
 *   - 消费点一律 import 本模块常量；`tools/maintain/constants.ts` 对 11 个 token 在其它 src
 *     文件出现给 warn（防止回写裸数字；同值不同义的合法用法在门禁里按上下文豁免）。
 */
import { DEFAULT_DECISION_TIMEOUT_MS } from "./config-schema.ts";

/** 页面导航 `goto(..., {timeout})` 的超时（毫秒）；只用于导航缺口，不用于任意请求。 */
export const NAVIGATION_GOTO_TIMEOUT_MS = 30_000;

/**
 * 决策请求超时（毫秒）。语义/默认值唯一出处 = `config-schema.ts` 的
 * `DEFAULT_DECISION_TIMEOUT_MS`（配置键 `AMBERFLOW_DECISION_TIMEOUT_MS` 可覆盖）。
 */
export const DECISION_REQUEST_TIMEOUT_MS = DEFAULT_DECISION_TIMEOUT_MS;

/** done 信号轮询间隔（毫秒）：执行器缺省参数 + `effective_policy.done_poll_ms` 缺省账共用。 */
export const DONE_POLL_INTERVAL_MS = 120;

/** 默认元素池名额（每页 40）：`extraction.MAX_ELEMENTS` 与 `executor.actPoolCap` 缺省值共用。 */
export const POOL_CAP_ELEMENTS = 40;

/** 低置信恢复/宽扫的元素预算（120）：`extraction.WIDE_POOL_ELEMENTS` 唯一出处（inspect --wide 共用）。 */
export const WIDE_SCAN_POOL_ELEMENTS = 120;

/** 稳定门（`meta.policy.settle`）缺省静默判定时长（毫秒）。 */
export const SETTLE_QUIET_MS = 400;

/** 稳定门（`meta.policy.settle`）缺省总等待上限（毫秒）。 */
export const SETTLE_TIMEOUT_MS = 5000;

/** `stateText` 状态压缩的字符预算（默认值；调用方可用 budget 参数覆盖）。 */
export const STATE_TEXT_BUDGET_CHARS = 320;

/** 工具步失败诊断里 stderr 摘要的字符上限：`tool-artifact.TOOL_STDERR_TAIL_CAP` 唯一出处。 */
export const TOOL_STDERR_TAIL_CAP_CHARS = 400;

/** 交互会话两次请求之间的缺省静默上限（毫秒）：`session-runtime.SESSION_DEFAULT_IDLE_TIMEOUT_MS` 唯一出处。 */
export const SESSION_IDLE_TIMEOUT_MS = 300_000;

/**
 * CLI 命令 `--timeout` 的旗标缺省值（毫秒）：inspect / apps rehearsal 共用。
 * 与 `NAVIGATION_GOTO_TIMEOUT_MS` 同值不同义（这里是命令旗标兜底，那里是导航调用缺口）。
 */
export const CLI_COMMAND_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 门禁视图：本模块收口的 11 个概念 → 值（供 `tools/maintain/constants.ts` 派生 token，
 * 不复制字面量）。新增/调整常量时同步本表，门禁与单源保持同一步。
 */
export const TUNING_VALUES = {
  NAVIGATION_GOTO_TIMEOUT_MS,
  DECISION_REQUEST_TIMEOUT_MS,
  DONE_POLL_INTERVAL_MS,
  POOL_CAP_ELEMENTS,
  WIDE_SCAN_POOL_ELEMENTS,
  SETTLE_QUIET_MS,
  SETTLE_TIMEOUT_MS,
  STATE_TEXT_BUDGET_CHARS,
  TOOL_STDERR_TAIL_CAP_CHARS,
  SESSION_IDLE_TIMEOUT_MS,
  CLI_COMMAND_DEFAULT_TIMEOUT_MS,
} as const;

export type TuningConcept = keyof typeof TUNING_VALUES;
