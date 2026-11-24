/**
 * Pluggable final auditor — TS twin of `layaapp/audit.py`.
 *
 * The audit is a System-2 job: read the whole action trace once and judge whether
 * the goal was achieved and whether anything unsafe happened. laya cannot do this
 * honestly (each call is one calibrated classification, not a reasoning pass over
 * a trajectory), so this stays an LLM-shaped interface.
 *
 * Port note: `audit()` is async here (fetch), while Python's httpx call is sync.
 */
import { readOptionalString, readString } from "../support/env.ts";
import { AUDIT_SYSTEM_PROMPT } from "../prompts/model-prompts.ts";

export interface TraceStep {
  desc?: string;
  risky?: boolean;
  executed?: boolean;
  confirmed?: boolean;
  /** 粗分类（聚合口径）：rule=规则/闭集解析，model=provider 决策票，escalate=老师点名。 */
  decision_kind?: "rule" | "model" | "escalate";
  /* ---- A1 动作执行证据（全部可选；由 executor 落账，app-runner 投影进 step_traces） ---- */
  /** pre/post 快照是否变化（诚实字段：动作执行成功但页面没动时是 false）。 */
  changed?: boolean;
  /** 解析到/尝试过但未执行（与 executed:false 配套；原因见 skip_reason）。 */
  skipped?: boolean;
  skip_reason?: string;
  /** 动作元素的 ref（位置性编号，对账用）。 */
  ref?: string;
  /** 归一后的动作 op（click/clickAt/fill/select/scroll/drag/hover/upload）。 */
  op?: string;
  /** 命令声明的目标（决策步/无命令声明时不出现）。 */
  target?: string | null;
  /* ---- S4 执行韧性证据（全部可选；缺字段 = 该事实不适用） ---- */
  /**
   * stale 重解析重试记录：动作失败且疑似 stale 时，重抽池→重解析同一声明目标→重试。
   * 每次重试一条 `{attempt, reason, ref}`；失败终态仍按既有 stopCode 诚实报告。
   */
  stale_retry?: Array<{ attempt: number; reason: string; ref: string }>;
  /** 本次动作按步级 `force` 声明执行（Playwright force：跳过 actionability，仍要求可定位）。 */
  forced?: boolean;
  /**
   * 超时对账：探针报 `action-timeout` 但动作前 URL 已变 ⇒ 点击已在途中生效，按已动作记。
   * 缺字段 = 未发生（既有跳过的 action-timeout 行形状不变）。
   */
  navigated_after_timeout?: true;
  [k: string]: unknown;
}

export interface AuditVerdict {
  verdict: "APPROVE" | "REJECT";
  reasons: string[];
  auditor: string;
}

export interface Auditor {
  audit(goal: string, trace: TraceStep[], done: boolean): AuditVerdict | Promise<AuditVerdict>;
}

/** Approves only if no risky step executed unconfirmed and a goal signal exists. */
export class MockAuditor implements Auditor {
  audit(_goal: string, trace: TraceStep[], done: boolean): AuditVerdict {
    const problems: string[] = [];
    for (const step of trace) {
      if (step.risky && step.executed && !step.confirmed) {
        problems.push(`risky step executed without confirmation: ${step.desc}`);
      }
    }
    if (!done) problems.push("goal-completion signal never fired");
    return {
      verdict: problems.length ? "REJECT" : "APPROVE",
      reasons: problems.length ? problems : ["trace clean, goal signal present"],
      auditor: "mock",
    };
  }
}

/** Calls an OpenAI-compatible chat endpoint with the full trace. */
export class LLMAuditor implements Auditor {
  static SYSTEM = AUDIT_SYSTEM_PROMPT;

  baseUrl: string;
  apiKey: string;
  model: string;
  timeout: number;

  constructor(baseUrl?: string, apiKey?: string, model?: string, timeout = 30.0) {
    const b = baseUrl ?? readOptionalString("OPENAI_BASE_URL");
    const k = apiKey ?? readOptionalString("OPENAI_API_KEY");
    if (!b) throw new Error("LLMAuditor needs OPENAI_BASE_URL");
    if (!k) throw new Error("LLMAuditor needs OPENAI_API_KEY");
    this.baseUrl = b.replace(/\/+$/, "");
    this.apiKey = k;
    this.model = model ?? readString("AUDIT_MODEL");
    this.timeout = timeout;
  }

  async audit(goal: string, trace: TraceStep[], done: boolean): Promise<AuditVerdict> {
    const user = JSON.stringify({ goal, goal_signal_detected: done, trace }, null, 2);
    const ctrl = AbortSignal.timeout(this.timeout * 1000);
    const r = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model, temperature: 0,
        messages: [{ role: "system", content: LLMAuditor.SYSTEM }, { role: "user", content: user }],
      }),
      signal: ctrl,
    });
    if (!r.ok) throw new Error(`auditor endpoint ${r.status}`);
    const body = (await r.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null;
    // 空 choices / 缺 message 是网关兼容面的真实形状——按不可解析处理（REJECT + 原文留痕），
    // 不让一次 TypeError 把整个 run 的收尾打崩（两个调用点都没有 try/catch）。
    const content = body?.choices?.[0]?.message?.content ?? "";
    let verdict: AuditVerdict;
    try {
      const from = content.indexOf("{");
      const to = content.lastIndexOf("}");
      verdict = JSON.parse(content.slice(from, to + 1)) as AuditVerdict;
    } catch {
      return { verdict: "REJECT", reasons: [`unparseable auditor reply: ${content.slice(0, 200)}`], auditor: this.model };
    }
    // 枚举校验：模型回 "approve"（小写）/ 其他字符串时不能当 APPROVE 落产物——审计语义
    // 只有 APPROVE/REJECT 两个值，其余一律按不可判读处理（fail-closed 到 REJECT + 留痕）。
    if (verdict.verdict !== "APPROVE" && verdict.verdict !== "REJECT") {
      return {
        verdict: "REJECT",
        reasons: [`invalid verdict ${JSON.stringify(verdict.verdict ?? null)} (expected "APPROVE"|"REJECT"): ${content.slice(0, 200)}`],
        auditor: this.model,
      };
    }
    if (!Array.isArray(verdict.reasons)) verdict.reasons = [JSON.stringify(verdict.reasons ?? "")];
    verdict.auditor = this.model;
    return verdict;
  }
}

/** LLM when the endpoint is configured, mock otherwise (offline runs stay green). */
export function getAuditor(): Auditor {
  if (readOptionalString("OPENAI_API_KEY")) {
    try {
      return new LLMAuditor();
    } catch (e) {
      // 半配置（有 key 却缺 base URL 等）不是「审计面没配」：判定照旧降级 Mock（离线/部署
      // 继续可跑），但必须留下证据——否则只填了 key 的部署会静默退回 Mock 审计而不自知。
      console.warn(
        `auditor: LLM auditor unavailable, falling back to MockAuditor: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return new MockAuditor();
}
