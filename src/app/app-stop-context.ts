/**
 * 应用层停因回执（`stop_decision_context`）的 additive 透出。
 *
 * 引擎只在**动作前停止且问过模型**的 run 上挂 `RunReport.stop_decision_context`；app 层的
 * result 把它单列成一个键，只在该事实成立时出现（缺省键不出现 ⇒ 既有产物逐字节不变）。
 * 字段的权威声明在 `AppRunResult`（app-runner-types.ts），本模块只做运行期的「记一次、取一次」。
 *
 * 记账用 WeakMap 而不是在运行器里加局部变量：键是运行器自己的每 run 对象（flow 路径的
 * `captured` holder / 声明式旅程的 `adapterCtx`），键对象一换旧回执即不可达——不形成跨 run
 * 的可变状态，也不破两个运行器的存量行数预算。
 */
import type { DecisionLayerReceipt } from "../engine/decision-ask-contract.ts";

/**
 * 回执来源的**宽视图**：flow 路径的 `RunReport` 是宽视图的子集；声明式路径经
 * `runSubgoalWithRetries` 拿到的是 `MiddlewareReport`（planner 的结构性视图，字段藏在
 * index signature 里）。用 `unknown` 接住再按形状收窄，避免在两处各自强转。
 */
type StopContextSource = { stop_decision_context?: unknown };

const stopContexts = new WeakMap<object, { layers: DecisionLayerReceipt[] }>();

/** 形状收窄：只有 `{ layers: [...] }` 才是回执；其余（缺失/宽视图里的别的东西）都当没有。 */
function stopContextOf(source: StopContextSource): { layers: DecisionLayerReceipt[] } | undefined {
  const value = source.stop_decision_context;
  if (value === null || typeof value !== "object") return undefined;
  const layers = (value as { layers?: unknown }).layers;
  return Array.isArray(layers) ? { layers: layers as DecisionLayerReceipt[] } : undefined;
}

/**
 * 记下一次执行报告的停因回执（**最后一次报告为准**）：报告不带回执时清掉旧值——回执只描述
 * 「本次停因」那一步，不能让前面被脚本容忍的失败步冒充最终停因。
 * `report` 收 `object` 而不是具名类型：flow 传 `RunReport`、声明式传 `MiddlewareReport`，
 * 两条路径的静态面不同（后者字段藏在 index signature 里），形状统一在 `stopContextOf` 收窄。
 */
export function rememberAppStopContext(key: object, report: object): void {
  const context = stopContextOf(report as StopContextSource);
  if (context === undefined) stopContexts.delete(key);
  else stopContexts.set(key, context);
}

/** result 装配用的投影：没有回执 = 空对象（等价于从不写这个键）。 */
export function appStopContextFields(key: object): { stop_decision_context?: { layers: DecisionLayerReceipt[] } } {
  const context = stopContexts.get(key);
  return context === undefined ? {} : { stop_decision_context: context };
}
