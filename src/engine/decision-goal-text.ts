/**
 * 决策面 L0 目标文本的唯一渲染（run/pilot 两面同源）。
 *
 * 步史是**已执行**（不是"已完成"）：每一步带 outcome 标记（changed / no_change / failed）——
 * 模型必须能看出「点了但页面没变」，否则 no-op 点击会被当成进展继续复读（Google apps /
 * Settings 连续无进展时尤其明显）。
 * 当前页/期望页是页面漂移的可读锚点（配合 pilot runtime 的 off_task_page 确定性停因）。
 * 每步 ≤`maxLabel` 字、URL ≤120 字、总步数 ≤DECISION_HISTORY_STEPS。
 *
 * 纯函数、无 I/O：run 面从 trace 折步史，pilot 面从驾驶步史折同类摘要，渲染只此一处。
 */

/** 已走步数摘要上限（两侧题面共用；有界，防题面膨胀）。 */
export const DECISION_HISTORY_STEPS = 6;

/** 一步已执行事实（只保留渲染需要的三项；不携带执行器内部字段）。 */
export interface DecisionHistoryStep {
  target: string;
  ok: boolean;
  changed?: boolean;
}

/** 驾驶/选择问句的 goal 底座：总目标 + 当前页/期望页 + 有界步史摘要。 */
export function drivingGoalText(goal: string,
    history: ReadonlyArray<DecisionHistoryStep>,
    currentUrl = "", expectUrl = "", maxLabel = 40): string {
  const clip = (text: string, max = maxLabel): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
  const hist = history.slice(-DECISION_HISTORY_STEPS)
    .map((s, i) => {
      const outcome = s.ok !== true ? "failed" : s.changed === true ? "changed" : s.changed === false ? "no_change" : "ok";
      return `${i + 1}.${clip(s.target)}[${outcome}]`;
    }).join("; ");
  const where = currentUrl === "" ? "" : `当前页: ${clip(currentUrl, 120)}`;
  const expect = expectUrl === "" ? "" : `期望页: ${clip(expectUrl, 120)}`;
  const head = [goal, where, expect].filter((s) => s !== "").join(" | ");
  return hist === "" ? head : `${head} | 已执行: ${hist}`;
}
