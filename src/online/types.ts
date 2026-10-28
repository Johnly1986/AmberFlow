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
  expect?: Array<"blocked" | "unreachable" | "login_required" | "captured">;
  tags?: string[];
}

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
  evidence_dir?: string;
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
}