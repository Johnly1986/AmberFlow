/**
 * 决策回执的两条落盘路径（都是 additive 字段；不新增 trace 行、不改既有字段）：
 *
 *   1. 已发生动作的步 → 挂到该步最后一条 trace 行的 `context_layers`（`attachDecisionContext`）；
 *   2. 动作前停止的步 → 该步没有可挂的 trace 行，回执随停因进 `RunReport.stop_decision_context`
 *      （`rememberStopDecisionContext` / `withStopDecisionContext`）。
 *
 * 回执只记「询问确实发生过」的审计事实：没问过模型（rules-only 早停等）→ 两条路径都不落键。
 */
import type { TraceStep } from "./audit.ts";
import type { DecisionLayerReceipt } from "./decision-ask-contract.ts";
import type { RunReport } from "./executor-types.ts";

/** 回执挂账：只写当前 step 的最后一条 trace 行；形状不符即 no-op。 */
export function attachDecisionContext(
  trace: TraceStep[], stepNo: number, context: { layers: DecisionLayerReceipt[] } | null | undefined,
): void {
  if (context === null || context === undefined || trace.length === 0) return;
  const last = trace[trace.length - 1];
  if (last === undefined || last.step !== stepNo) return;
  last.context_layers = context.layers;
}

/**
 * 停止路径回执的旁路槽：键 = 本次 run 的记账对象（`run()` 每次新建，随 run 回收）。
 * 用 WeakMap 而不是 `run()` 局部变量，是为了不动 `run()` 的行数预算（存量函数只减不增）；
 * 它不形成跨 run 的可变状态——键对象一换，旧回执即不可达。
 */
const stopContexts = new WeakMap<object, { layers: DecisionLayerReceipt[] }>();

/** 记下动作前停止那一步的最后一次询问回执；null/undefined = 停前没问过模型（不落字段）。 */
export function rememberStopDecisionContext(
  run: object, context: { layers: DecisionLayerReceipt[] } | null | undefined,
): void {
  if (context === null || context === undefined) return;
  stopContexts.set(run, context);
}

/** 报告尾 additive 落盘：没有回执 = 原引用返回（报告逐键不变）。 */
export function withStopDecisionContext(report: RunReport, run: object): RunReport {
  const context = stopContexts.get(run);
  if (context === undefined) return report;
  return { ...report, stop_decision_context: { layers: context.layers } };
}
