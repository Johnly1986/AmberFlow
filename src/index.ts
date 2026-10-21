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
// The drivers below each export a CLI `main`, which would collide under
// `export *`: re-export their named pieces and keep the module under a namespace.
export { BenchMiddleware, runCase, startUrl, type BenchCase, type BenchCaseResult } from "./cli/bench.ts";
export * as bench from "./cli/bench.ts";
export {
  DEMO_ROWS, PORTAL, XLSX, buildPlan, configureAll, ensureXlsx, readXlsx, settingsUrl,
  type IpResult, type IpRow,
} from "./cli/ip-config.ts";
export * as ipConfig from "./cli/ip-config.ts";
export { FORMS, TYPE_TO_FORM, decideForm, fillForm, ensureXlsx as ensureCameraXlsx, maxLoaded } from "./cli/camera-entry.ts";
export * as cameraEntry from "./cli/camera-entry.ts";
// transfer migration layer: 6 replica inventories + the migration runner (namespaced `main`s).
export * as transferData2 from "./data/transfer-data2.ts";
export * as transferData3 from "./data/transfer-data3.ts";
export * as transferData4 from "./data/transfer-data4.ts";
export * as transferData5 from "./data/transfer-data5.ts";
export * as transferData6 from "./data/transfer-data6.ts";
export * as transferData7 from "./data/transfer-data7.ts";
export {
  discoverSpecs, emitPlan, migrationMetricsForAll, oracleFor, runSite,
  runSubgoals as runTransferSubgoals, writeResultMd,
} from "./sites/transfer-task.ts";
export * as transferTask from "./sites/transfer-task.ts";
// Path A (fixed-action picker) + the flagship demo + the guard measurement.
export { ATTACK_THRESHOLD, PAGES, SCENES, extractState } from "./cli/path-a.ts";
export * as pathA from "./cli/path-a.ts";
export { GOAL as LONG_TASK_GOAL } from "./cli/long-task.ts";
export * as longTask from "./cli/long-task.ts";
export { VARIANTS, measure } from "./cli/tune-guard.ts";
export * as tuneGuard from "./cli/tune-guard.ts";
// Path B: the local model service the MV3 extension talks to (namespaced `main`).
export { createPickerServer, startPickerServer } from "./cli/picker-server.ts";
export * as pickerServer from "./cli/picker-server.ts";
// ctrip/transfer network + probe tools (each exports a CLI `main` -> namespaced).
export * as h5Flights from "./data/h5-flights.ts";
export * as liveProbe from "./sites/live-probe.ts";
export * as liveCapture from "./sites/live-capture.ts";
export * as otaProbe from "./sites/ota-probe.ts";
export { CTRIP, SKYBOOK, PROFILES } from "./data/profiles.ts";
// qunar: the ctrip flow skeleton replayed on a real site (plan + oracle + probe).
export { HOME as QUNAR_HOME, buildChecks as buildQunarChecks, buildPlan as buildQunarPlan } from "./sites/qunar-task.ts";
export * as qunarTask from "./sites/qunar-task.ts";
export * as qunarProbe from "./sites/qunar-probe.ts";
export * as datasource from "./data/datasource.ts";
// ctrip scenario: data + oracle + task (its `main` joins the namespaced set).
export * as ctrip from "./data/ctrip-data.ts";
export {
  GOAL, demoUser, flightSubgoals, harvest, hotelSubgoals, makePlan, pageUrl,
} from "./sites/ctrip-task.ts";
export * as ctripTask from "./sites/ctrip-task.ts";
