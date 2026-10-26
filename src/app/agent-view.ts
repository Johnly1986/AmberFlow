/**
 * **Agent 视图**：把 `AppRunResult` 投影成模型可见的稳定、有界结构。
 *
 * 为什么需要这一层：CLI 的 `amber run --json` 与 DSH 桥都从同一次运行读结果，
 * 但一个给人类报告、一个给模型摘要；各自投影会漂移。这里只做“选择字段 + 截断 +
 * 状态判定”，不重新解释执行语义（`AppRunResult` 仍是唯一真相）。
 *
 * 纪律：
 *   - 步骤最多 20 条；超出标 `truncated`，并给完整结果文件路径；
 *   - 不把整页文本/截图塞进来，只给路径；
 *   - `ok` = 本次请求范围成功；`verified` = 完整旅程 + 不变量成立；
 *   - `status` 是模型可分支的一等字段，不要求它从多个布尔字段猜。
 */
import type { AppRunResult } from "./app-runner.ts";

export type AgentRunStatus =
  | "passed"
  | "partial"
  | "failed"
  | "blocked"
  | "invalid"
  | "skipped"
  | "needs_human"
  | "infra_error"
  | "dry";

export interface AgentStepView {
  index: number;
  id?: string;
  desc: string;
  status: string;
  method?: string;
  confidence?: number;
  stop_code?: string;
  obstacle?: string | null;
}

export interface AgentRunView {
  schema_version: 1;
  ok: boolean;
  status: AgentRunStatus;
  verified: boolean;
  partial: boolean;
  completed: string;
  steps: AgentStepView[];
  truncated: boolean;
  failure: {
    step: number;
    desc: string;
    stop_code?: string;
    obstacle?: string;
  } | null;
  invariants: { held: number; total: number; failed: string[] };
  artifacts: {
    out_dir?: string;
    result_json?: string;
    report_md?: string;
  };
  next: string[];
}

const MAX_STEPS = 20;

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** browser 步的 trace（`captureTraces` 打开时才有）；缺字段时用 subgoals 兜底。 */
function traceSteps(result: AppRunResult): AgentStepView[] {
  const traces = (result as unknown as { step_traces?: Array<Record<string, unknown>> }).step_traces ?? [];
  const meta = new Map(subgoalSteps(result).map((s) => [s.index, s]));
  return traces.map((t, i) => {
    const status = text(t["status"]) || "unknown";
    const methods = Array.isArray(t["methods"]) ? t["methods"].map(String).filter(Boolean) : [];
    const index = typeof t["index"] === "number" ? t["index"] + 1 : i + 1;
    const sg = meta.get(index);
    return {
      index,
      ...(typeof t["id"] === "string" ? { id: t["id"] } : {}),
      desc: text(t["desc"]) || `step ${i + 1}`,
      status,
      ...(methods.length ? { method: methods[methods.length - 1] } : {}),
      ...(sg?.stop_code ? { stop_code: sg.stop_code } : {}),
      ...(sg?.obstacle ? { obstacle: sg.obstacle } : {}),
    };
  });
}

function subgoalSteps(result: AppRunResult): AgentStepView[] {
  return (result.subgoals ?? []).map((raw, i) => {
    const sg = raw as Record<string, unknown>;
    const status = text(sg["status"]) || "unknown";
    const obstacle = typeof sg["obstacle"] === "string" ? sg["obstacle"] : null;
    return {
      index: i + 1,
      ...(typeof sg["id"] === "string" ? { id: sg["id"] } : {}),
      desc: text(sg["desc"]) || `subgoal ${i + 1}`,
      status,
      ...(typeof sg["stop_code"] === "string" ? { stop_code: sg["stop_code"] } : {}),
      ...(obstacle === null ? {} : { obstacle }),
    };
  });
}

function toolSteps(result: AppRunResult): AgentStepView[] {
  return (result.tool_steps ?? []).map((t) => ({
    index: t.index + 1,
    desc: t.desc,
    status: t.refused ? "refused" : t.ok ? "done" : "failed",
    ...(t.refused ? { stop_code: t.refused, obstacle: t.refused } : {}),
    ...(!t.ok && !t.refused ? { stop_code: "tool_failed" } : {}),
  }));
}

export function agentStepViews(result: AppRunResult): AgentStepView[] {
  const traced = traceSteps(result);
  const steps = traced.length ? traced : subgoalSteps(result);
  return [...steps, ...toolSteps(result)].sort((a, b) => a.index - b.index);
}

/**
 * 一次运行的 Agent 状态。
 * `partial` 由调用方声明（单步/分段跑）；`dry` = 只展开、没执行。
 */
export function agentRunStatus(result: AppRunResult, partial: boolean, dry: boolean): AgentRunStatus {
  if (dry) return "dry";
  const manual = (result.manual_steps ?? []).some((m) => !m.done);
  if (manual) return "needs_human";
  const blocked = (result.subgoals ?? []).some((s) => (s as Record<string, unknown>)["status"] === "blocked");
  const failedTools = (result.tool_steps ?? []).some((t) => !t.ok && !t.refused);
  const refused = (result.tool_steps ?? []).some((t) => t.refused !== undefined);
  if (blocked || failedTools) return "blocked";
  if (refused) return "blocked";
  const invariantFailed = (result.invariants ?? []).some((i) => !i.held);
  if (invariantFailed) return "failed";
  if (partial) return "partial";
  return result.ok ? "passed" : "failed";
}

export function toAgentRunView(
  result: AppRunResult,
  opts: {
    outDir?: string;
    resultPath?: string;
    reportPath?: string;
    partial?: boolean;
    dry?: boolean;
  } = {},
): AgentRunView {
  const partial = opts.partial === true;
  const dry = opts.dry === true;
  const status = agentRunStatus(result, partial, dry);
  const all = agentStepViews(result);
  const steps = all.slice(0, MAX_STEPS);
  const failedStep = all.find((s) => s.status === "blocked" || s.status === "failed" || s.status === "refused");
  const invariants = result.invariants ?? [];
  const verified = !dry && !partial && result.ok === true && invariants.every((i) => i.held);
  const ok = dry
    ? true
    : status === "passed" || status === "partial"
      ? true
      : false;

  const app = result.app || "app";
  const next: string[] = [];
  if (dry) next.push(`amber run ${app}`, `amber apps show ${app}`);
  else if (status === "passed") next.push(`amber online --tier smoke`, `amber apps show ${app}`);
  else if (status === "partial") next.push(`amber run ${app} --from-step ${(failedStep?.index ?? 1) + 1}`);
  else if (status === "needs_human") next.push(`amber run ${app} --headful`, `amber apps show ${app}`);
  else if (status === "blocked" || status === "failed") {
    if (failedStep) next.push(`amber run ${app} --only-step ${failedStep.index} --headful`);
    next.push(`amber apps show ${app}`, `amber apps check ${app}`);
  } else next.push(`amber apps show ${app}`, `amber apps check ${app}`);

  return {
    schema_version: 1,
    ok,
    status,
    verified,
    partial,
    completed: result.completed,
    steps,
    truncated: all.length > MAX_STEPS,
    failure: failedStep
      ? {
        step: failedStep.index,
        desc: failedStep.desc,
        ...(failedStep.stop_code ? { stop_code: failedStep.stop_code } : {}),
        ...(failedStep.obstacle ? { obstacle: failedStep.obstacle } : {}),
      }
      : null,
    invariants: {
      held: invariants.filter((i) => i.held).length,
      total: invariants.length,
      failed: invariants.filter((i) => !i.held).map((i) => i.id),
    },
    artifacts: {
      ...(opts.outDir ? { out_dir: opts.outDir } : {}),
      ...(opts.resultPath ? { result_json: opts.resultPath } : {}),
      ...(opts.reportPath ? { report_md: opts.reportPath } : {}),
    },
    next,
  };
}
