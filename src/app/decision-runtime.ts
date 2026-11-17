/**
 * 决策运行时组合根（S5/W5-3）：把 model 层的 provider 装配实现包成 engine 侧的注入契约。
 *
 * 为什么需要这一层：`BrowserMiddleware` 是唯一执行循环，它要「显式 provider / 包装 legacy
 * `LayaRuntime` / ask 失败事实文案」这三个装配动作，但不该 import 具体实现模块——否则
 * engine→model 反向边永远收不干净。engine 只认 `DecisionRuntimeHooks` 类型（L0 契约 +
 * `executor-middleware-types.ts`），model 实现只在这里被引用一次。
 *
 * 注入点：`src/app/middleware-factory.ts` 的 `buildMiddleware` 缺省注入本实现
 * （显式 `options.decisionRuntime` 优先）。所有入口都经工厂构造执行器，因此缺省档的
 * 行为与注入前逐字段一致；`installDecisionProvider` / `installLayaRuntime` 的模块级
 * 装配语义不变（仍是进程内单点，按 run 由入口解析/安装）。
 */
import {
  decisionFailureFact,
  decisionProviderOrNull,
  layaProvider as wrapLayaRuntime,
  type ProviderCapabilities,
} from "../model/decision-provider.ts";
import type { DecisionAgent, LayaRuntime, ModelState } from "../model/model.ts";
import type { DecisionRuntimeHooks } from "../engine/executor-middleware-types.ts";

/** 与 `src/model/model.ts` 的能力面声明同形（`layaProvider` 的入参形状）。 */
interface LayaWrapOptions {
  runtime: LayaRuntime;
  agentFor: (state: ModelState) => Promise<{ agent: DecisionAgent; embedFn: unknown }>;
  name?: string;
  version?: string;
  capabilities?: Partial<ProviderCapabilities>;
}

export const appDecisionRuntime: DecisionRuntimeHooks = {
  providerOrNull: () => decisionProviderOrNull(),
  // 注入契约把 runtime 声明为 unknown（engine 不 import model 的运行期类型）；
  // 实现侧在这里收窄——唯一的调用点就是执行器的 legacy LayaRuntime 分支。
  layaProvider: (opts) => wrapLayaRuntime(opts as LayaWrapOptions),
  failureFact: (err) => decisionFailureFact(err),
};
