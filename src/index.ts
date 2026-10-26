/** Public surface — the TS twin of `layaapp/__init__.py` (plus the migrated drivers). */
export * from "./engine/extraction.ts";
export * from "./engine/rules.ts";
export * from "./engine/signals.ts";
// Signal induction (teach a step once -> a plan-ready, discriminating signal) and
// the witness capture it needs. See README: a human should not have to author
// signals by hand, but nothing here weakens what counts as evidence.
export {
  captureStateView, diffStates, induceSignals, isVolatile, selectorFor,
  signalReproducible, stableToken, WITNESS_SEL,
} from "./flow/signal-induction.ts";
export * as signalInduction from "./flow/signal-induction.ts";
// Decision memory: exact-key memoisation of a deterministic model + a JSONL
// decision log (retries/replans/resumes re-ask what was already answered).
export { withDecisionCache, type CachedRuntime, type DecisionCacheStats } from "./model/decision-cache.ts";
export * as decisionCache from "./model/decision-cache.ts";
// Outcome memory: the other half — remember elements that proved INERT on a
// page+subgoal so a retry/resume does not repeat a dead action.
export { OutcomeMemory, createOutcomeMemory, type OutcomeMemoryLike, type OutcomeMemoryStats } from "./model/outcome-memory.ts";
export * as outcomeMemory from "./model/outcome-memory.ts";
// Learned hints: turn an OBSERVED success into a rule for the next run (stable
// handles only), so a subgoal that needed the model once may cost nothing later.
export { HintMemory, createHintMemory, induceHint, type HintMemoryLike, type HintMemoryStats } from "./model/hint-memory.ts";
export * as hintMemory from "./model/hint-memory.ts";
export * from "./engine/plan.ts";
export * from "./model/model.ts";
export * from "./engine/audit.ts";
export * from "./engine/picker.ts";
export * from "./browser/browser-env.ts";
export * from "./model/laya-format.ts";
export * from "./model/laya-onnx.ts";
export * from "./engine/executor.ts";
export * from "./engine/planner.ts";
export * from "./flow/flow.ts";
export * from "./cli/plan-cli.ts";
// Path B：MV3 扩展用的本地模型服务（命名空间导出，避免 `main` 冲突）。
export { createPickerServer, startPickerServer } from "./cli/picker-server.ts";
export * as pickerServer from "./cli/picker-server.ts";
// 通用数据腿：站点知识在配置里，引擎本身不认识站点。
export * as datasource from "./data/datasource.ts";
