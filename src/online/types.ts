/**
 * **线上测试套件的声明面**。
 *
 * 与旧 bench 的根本区别：这里没有 fixture / file:// / 冻结语料。一个 case 只声明
 *   - 哪个真实站点（site）
 *   - 要做什么（subgoals，复用执行器的计划语法）
 *   - 什么算完成（signal + 结束态 invariants + 可选独立 oracle）
 * 运行结果永远落在仓库外（`$AMBERFLOW_HOME/online-runs`），不提交任何 golden 文件。
 */
import type { SignalSpec } from "../engine/signals.ts";

export type OnlineTier = "smoke" | "core" | "deep" | "probe";

export interface OnlineDevice {
  user_agent?: string;
  viewport?: { width: number; height: number };
  is_mobile?: boolean;
  has_touch?: boolean;
  locale?: string;
  timezone?: string;
  device_scale_factor?: number;
}

export interface OnlineSite {
  id: string;
  /** 允许访问的主机白名单（不含协议/路径）。 */
  hosts: string[];
  home: string;
  locale?: string;
  device?: OnlineDevice;
  timeout_ms?: number;
  /** 正文命中这些串 ⇒ 风控/封禁，不当成业务失败。 */
  blocked_markers?: string[];
  /** URL 或正文命中这些串 ⇒ 需要登录。 */
  login_markers?: string[];
  /** 允许 http://localhost / 127.0.0.1（自托管调试用；默认 false）。 */
  allow_local?: boolean;
}

/** 一个子目标：执行器计划语法的一个子集；`start_url` 必须是真实 http(s) URL。 */
export interface OnlineSubgoal {
  desc: string;
  signal: SignalSpec;
  start_url: string;
  target_hint?: string;
  target_hints?: string[];
  slots?: Record<string, unknown>;
  when?: SignalSpec;
  retries?: number;
  /** 与 `Subgoal` 的开放字段对齐：TaskPlan 的构造签名接受 Partial<Subgoal>。 */
  [k: string]: unknown;
}

export interface OnlineInvariant {
  id: string;
  desc: string;
  signal: SignalSpec;
}

/**
 * 独立 oracle：不读执行器的 signal / trace，直接读页面事实。
 * 首批只支持几种足够稳定的形状，避免再造一套表达式语言。
 */
export type OnlineOracle =
  | { kind: "url_contains"; value: string }
  | { kind: "css_count"; selector: string; min?: number; max?: number }
  | { kind: "text_order"; selector: string; direction: "asc" | "desc" }
  | { kind: "text_set"; selector: string; values: string[] }
  | { kind: "attr_equals"; selector: string; attr: string; value: string };

export interface OnlineCase {
  id: string;
  site: string;
  tier: OnlineTier;
  goal: string;
  /** 没有 subgoals 的 smoke case 用这个（缺省 = site.home）。 */
  start_url?: string;
  timeout_ms?: number;
  model?: string;
  device?: OnlineDevice;
  slots?: Record<string, unknown>;
  subgoals?: OnlineSubgoal[];
  invariants?: OnlineInvariant[];
  oracle?: OnlineOracle;
  /** 只允许 probe 用例：这些结果不是失败，而是“本次线上环境观测到的事实”。 */
  expect?: ProbeExpectMember[];
  /**
   * **声明面可证伪的零动作断言**（fail-closed 正向证明；任意 tier 可用，语义是“这次执行
   * 一条动作都不许有”，典型用途是 probe）。
   *
   * 与 probe 的 `expect` 正交：`expect` 只比最终 status，闭集里含 `failed` 时“点错行 +
   * done 失败”也会被记 skipped（跳过 ≠ 通过，但也没有“零动作”这个断言载体）。声明
   * `expect_zero_actions: true` 后，执行期从 trace 的已执行动作行汇总实际动作数：
   *   - 0 条动作 ⇒ 仍按 probe 语义记 skipped（环境观测，不是通过）；
   *   - N>0 条动作 ⇒ 本 case 判**真失败**（status=failed，套件退出码 1），reason 写明
   *     `expected zero actions, N executed`——不因 `expect` 含 `failed` 被吞成 skipped。
   * 纯观察 probe（无 subgoals）声明它是未来漂移的护栏：以后若有人加了会动作的步，执行期会红。
   */
  expect_zero_actions?: boolean;
  tags?: string[];
}

/**
 * probe `expect` 的观测值闭集（批 2 遗留收编 D 项：`"failed"` 入联合——fail-closed 正向证明
 * 的 probe 用例（声明行锚落空 = 零动作 + 诚实落空）在规划面停因可落 `low_confidence`/`failed`
 * （ROW_INDEX_HINT_PLAN §3.9 可达面矩阵；runner.probeOutcome 的运行时比较本就以 as never
 * 放行任意观测值，本联合收编让类型面与运行时一致）。加载期成员校验在 case.ts（非法成员
 * config_error，与 F61 信号形态纪律一致）。
 */
export type ProbeExpectMember = "blocked" | "unreachable" | "login_required" | "captured" | "failed";

/** probe `expect` 的成员闭集（case.ts 加载期校验的唯一出处引用）。 */
export const PROBE_EXPECT_MEMBERS: readonly ProbeExpectMember[] =
  ["blocked", "unreachable", "login_required", "captured", "failed"];

export interface OnlineBundle {
  sites: Map<string, OnlineSite>;
  cases: OnlineCase[];
}

export type CaseStatus =
  | "passed"
  | "failed"
  | "blocked"
  | "unreachable"
  | "login_required"
  | "skipped";

export interface SubgoalOutcome {
  desc: string;
  done: boolean;
  attempts: number;
  stop_reason: string;
  stop_code?: string;
  steps: number;
  method?: string;
  confidence?: number;
}

export interface CaseOutcome {
  id: string;
  site: string;
  tier: OnlineTier;
  status: CaseStatus;
  duration_ms: number;
  reason?: string;
  subgoals: SubgoalOutcome[];
  invariants: Array<{ id: string; desc: string; held: boolean }>;
  oracle?: { ok: boolean; detail: string };
  /**
   * 本次用例**实际执行**的动作总数：从本次全部子目标 attempt 的 trace 汇总“已执行动作行”
   * （`executed === true` 且动作词 ∈ clicked/filled/scrolled/dragged/hovered/uploaded，
   * 与执行器 `executed_actions` 同一口径；manual 确认不算动作）。0 = 零动作。
   * 证据面用它承载 `expect_zero_actions` 的正向证明；没有声明也照记（诚实字段，不硬造）。
   */
  actions_executed: number;
  /** 声明了 `expect_zero_actions` 却执行了动作：判真失败（probe 也不降级成 skipped）。 */
  zero_action_violation?: true;
  evidence_dir?: string;
}

/** B1 节奏标注：套件跟随 env 节奏时才出现（全 0 省略 = 默认档产物不变）。 */
export interface SuitePace {
  /** 生效的子目标/用例间最小步间距（毫秒）。 */
  between_steps_ms: number;
  /** 生效来源（套件无 pack/meta 声明面，只可能是 env 或 default）。 */
  source: "env" | "default";
  /** 套件全程为满足最小间距**实际等待**的累计毫秒（含重试间）。 */
  total_waited_ms: number;
}

export interface SuiteOutcome {
  run_id: string;
  started_at: string;
  tier: string;
  cases: CaseOutcome[];
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number;
  /** B1 节奏标注（拍板：跟随 env + 标注）；全 0 时省略。 */
  pace?: SuitePace;
}