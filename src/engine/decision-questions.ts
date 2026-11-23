/**
 * provider 询问面收口（question kind 闭集 `pick` / `risk` / `done` 的 risk/done 两档）。
 *
 * pick 归选择平面（`DecisionAsk` / `decision-pick-unified.ts`）；本模块只把 risk/done 的
 * provider 直调收成单点：capability 声明判断在入口做，**异常归调用方 catch**（既有降级语义
 * 不变——风险头挂了退关键词规则、完成票缺失按 0 读）。
 */
import type { DecisionProvider } from "../support/decision-provider-contract.ts";
import type { DecisionQuestionKind } from "./decision-ask-contract.ts";

export type { DecisionQuestionKind };

/** risk 询问：未声明能力/无风险头 = null（调用方走确定性回退），否则返回概率。 */
export async function askRiskProvider(
  decision: DecisionProvider | null, goal: string, desc: string,
): Promise<number | null> {
  if (decision?.capabilities.risk !== true || decision.risk === undefined) return null;
  return await decision.risk(goal, desc);
}

/** done 询问：未声明能力/无完成头 = null；返回票值（advisory，DOM 信号仍是完成真相）。 */
export async function askDoneProvider(
  decision: DecisionProvider | null, goal: string, state: Record<string, unknown>,
): Promise<number | null> {
  if (decision?.capabilities.done !== true || decision.doneVote === undefined) return null;
  return await decision.doneVote(goal, state);
}
