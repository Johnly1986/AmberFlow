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

/**
 * `step_traces` 的原始行（可能缺字段：旧产物 / replay 没有步表）。
 * 它是 flow 产物的**唯一步表**——每个 `ctx.step`/`arrive`/`manual`/`run`/`dangerous` 调用一行，
 * `index` 是调用序（0 基）。
 */
function traceRows(result: AppRunResult): Array<Record<string, unknown>> {
  return (result as unknown as { step_traces?: Array<Record<string, unknown>> }).step_traces ?? [];
}

/**
 * 工具步（`ctx.run` / `ctx.dangerous`）的**行标记与拒绝分类**。
 *
 * `src/app/ctx-tools.ts` 把一次进程观察写进 trace 事件的 `result`：`source` 是工具步独有的键
 * （浏览器步/人工步的 result 没有它），`refused` 是拒绝原因。行 `status` 只有
 * done/failed/recovered/skipped——不补 refused 这一层，一次「危险步被拒」会被读成普通失败。
 * 非工具步返回 null。
 */
function toolTraceRow(t: Record<string, unknown>): { refused: string | null } | null {
  const r = t["result"];
  if (typeof r !== "object" || r === null || Array.isArray(r)) return null;
  const rec = r as Record<string, unknown>;
  if (typeof rec["source"] !== "string") return null;
  const refused = typeof rec["refused"] === "string" && rec["refused"] !== "" ? rec["refused"] : null;
  return { refused };
}

/** browser/工具/人工步的 trace（`captureTraces` 打开时才有）；缺字段时用 subgoals 兜底。 */
function traceSteps(result: AppRunResult): AgentStepView[] {
  const traces = traceRows(result);
  const meta = new Map(subgoalSteps(result).map((s) => [s.index, s]));
  return traces.map((t, i) => {
    const methods = Array.isArray(t["methods"]) ? t["methods"].map(String).filter(Boolean) : [];
    const index = typeof t["index"] === "number" ? t["index"] + 1 : i + 1;
    const sg = meta.get(index);
    const tool = toolTraceRow(t);
    const stop = (typeof t["stop_code"] === "string" ? t["stop_code"] : "") || sg?.stop_code || "";
    return {
      index,
      ...(typeof t["id"] === "string" ? { id: t["id"] } : {}),
      desc: text(t["desc"]) || `step ${i + 1}`,
      status: tool?.refused !== undefined && tool.refused !== null ? "refused" : (text(t["status"]) || "unknown"),
      ...(methods.length ? { method: methods[methods.length - 1] } : {}),
      ...(tool?.refused !== undefined && tool.refused !== null
        ? { stop_code: tool.refused, obstacle: tool.refused }
        : { ...(stop ? { stop_code: stop } : {}), ...(sg?.obstacle ? { obstacle: sg.obstacle } : {}) }),
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

/** `tool_steps` 的投影（声明式/无 trace 面的步表补充；flow 面见 `agentStepViews` 的契约）。 */
function toolSteps(result: AppRunResult): AgentStepView[] {
  return (result.tool_steps ?? []).map((t) => ({
    index: t.index + 1,
    desc: t.desc,
    status: t.refused ? "refused" : t.ok ? "done" : "failed",
    ...(t.refused ? { stop_code: t.refused, obstacle: t.refused } : {}),
    ...(!t.ok && !t.refused ? { stop_code: "tool_failed" } : {}),
  }));
}

/**
 * 步表契约（与桥 `summarizeRun` 同一张表、同一 1-based 步序）：
 *
 *   - **flow 产物**（`script.mode === "flow"`）的 `step_traces` 是**唯一步表**：`app-runner` 的
 *     step 事件过滤本来就包含 `run` / `dangerous`（工具事件），所以每个 `ctx.step` / `ctx.arrive` /
 *     `ctx.manual` / `ctx.run` / `ctx.dangerous` 调用都在表内各占一行，`index` 是调用序（0 基）。
 *     这里**不再叠加** `tool_steps`：那是同一批工具步的第二份投影（按工具序号而非调用序编号），
 *     叠加会让同一个工具步出现两行、并让 `failure.step` 落到另一套 index 空间（桥只从 `step_traces`
 *     投影一次，两面的步号必须同源）。工具步的 refused/failed 分类由该行的 `status`/`stop_code`
 *     表达（拒绝原因从事件 `result.refused` 取，见 `toolTraceRow`）。
 *   - **声明式产物**的浏览器步在 `subgoals`、工具步在 `tool_steps`，两张表都不含对方 ⇒ 照旧合并
 *     （合并后按 1-based 步序排序；`step_traces` 只在 `captureTraces` 打开时存在，有就优先用它）。
 *   - `tool_steps` 只在声明式分支参与合并：flow 的 `step_traces` 已含工具行，而桥 `summarizeRun`
 *     对 flow 产物同样只读 `step_traces`——两面用同一张表，才能既不重复、又让步号同源。
 */
export function agentStepViews(result: AppRunResult): AgentStepView[] {
  const traced = traceSteps(result);
  // flow：直接返回步表（顺序即调用序，不排序——排序会把"表本身乱序"这类漂移盖掉）。
  if (result.script?.mode === "flow") return traced;
  // 声明式：两张表都不含对方，合并后按 1-based 步序排序（工具步在旅程里的位置就是它的步号）。
  const steps = traced.length > 0 ? traced : subgoalSteps(result);
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
  if (result.script?.stop_code === "needs_human") return "needs_human";
  const blocked = (result.subgoals ?? []).some((s) => (s as Record<string, unknown>)["status"] === "blocked");
  // FW3：flow 脚本路径的工具步失败由**脚本**决定是否致命（`ctx.run` 返回 ok:false，不抛）。
  // 脚本已经处理并跑绿时，不能仅凭"有过一个失败工具步"把整次运行报成 blocked——声明式
  // 路径上 toolsOk 直接决定 ok，所以 `result.ok` 这个前置条件不改变它的语义。
  const failedTools = !result.ok && (result.tool_steps ?? []).some((t) => !t.ok && !t.refused);
  const refused = !result.ok && (result.tool_steps ?? []).some((t) => t.refused !== undefined);
  if (blocked || failedTools) return "blocked";
  if (refused) return "blocked";
  // 执行预算用满 = 主动停在半路：不变量没求值不是“失败”，是这次只跑了前 N 步。
  if (partial) return "partial";
  const invariantFailed = (result.invariants ?? []).some((i) => !i.held);
  if (invariantFailed) return "failed";
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
  else if (status === "passed") next.push(`amber test --tier smoke`, `amber apps show ${app}`);
  else if (status === "partial") next.push(`amber run ${app} --trace`, `amber apps explain ${app}`);
  else if (status === "needs_human") next.push(`amber run ${app} --headful`, `amber apps show ${app}`);
  else if (status === "blocked" || status === "failed") {
    next.push(`amber apps explain ${app}`, `amber apps check ${app}`, `amber apps show ${app}`);
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
