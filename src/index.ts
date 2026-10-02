/** Public surface — the TS twin of `layaapp/__init__.py` (plus the migrated drivers). */
export * from "./extraction.ts";
export * from "./rules.ts";
export * from "./signals.ts";
// Signal induction (teach a step once -> a plan-ready, discriminating signal) and
// the witness capture it needs. See README: a human should not have to author
// signals by hand, but nothing here weakens what counts as evidence.
export {
  captureStateView, diffStates, induceSignals, isVolatile, selectorFor,
  signalReproducible, stableToken, WITNESS_SEL,
} from "./signal-induction.ts";
export * as signalInduction from "./signal-induction.ts";
// Decision memory: exact-key memoisation of a deterministic model + a JSONL
// decision log (retries/replans/resumes re-ask what was already answered).
export { withDecisionCache, type CachedRuntime, type DecisionCacheStats } from "./decision-cache.ts";
export * as decisionCache from "./decision-cache.ts";
// Outcome memory: the other half — remember elements that proved INERT on a
// page+subgoal so a retry/resume does not repeat a dead action.
export { OutcomeMemory, createOutcomeMemory, type OutcomeMemoryLike, type OutcomeMemoryStats } from "./outcome-memory.ts";
export * as outcomeMemory from "./outcome-memory.ts";
export * from "./plan.ts";
export * from "./model.ts";
export * from "./audit.ts";
export * from "./picker.ts";
export * from "./browser-env.ts";
export * from "./laya-format.ts";
export * from "./laya-onnx.ts";
export * from "./executor.ts";
export * from "./planner.ts";
export * from "./flow.ts";
export * from "./plan-cli.ts";
// The drivers below each export a CLI `main`, which would collide under
// `export *`: re-export their named pieces and keep the module under a namespace.
export { BenchMiddleware, runCase, startUrl, type BenchCase, type BenchCaseResult } from "./bench.ts";
export * as bench from "./bench.ts";
export {
  DEMO_ROWS, PORTAL, XLSX, buildPlan, configureAll, ensureXlsx, readXlsx, settingsUrl,
  type IpResult, type IpRow,
} from "./ip-config.ts";
export * as ipConfig from "./ip-config.ts";
export { FORMS, TYPE_TO_FORM, decideForm, fillForm, ensureXlsx as ensureCameraXlsx, maxLoaded } from "./camera-entry.ts";
export * as cameraEntry from "./camera-entry.ts";
// transfer migration layer: 6 replica inventories + the migration runner (namespaced `main`s).
export * as transferData2 from "./transfer-data2.ts";
export * as transferData3 from "./transfer-data3.ts";
export * as transferData4 from "./transfer-data4.ts";
export * as transferData5 from "./transfer-data5.ts";
export * as transferData6 from "./transfer-data6.ts";
export * as transferData7 from "./transfer-data7.ts";
export {
  discoverSpecs, emitPlan, migrationMetricsForAll, oracleFor, runSite,
  runSubgoals as runTransferSubgoals, writeResultMd,
} from "./transfer-task.ts";
export * as transferTask from "./transfer-task.ts";
// Path A (fixed-action picker) + the flagship demo + the guard measurement.
export { ATTACK_THRESHOLD, PAGES, SCENES, extractState } from "./path-a.ts";
export * as pathA from "./path-a.ts";
export { GOAL as LONG_TASK_GOAL } from "./long-task.ts";
export * as longTask from "./long-task.ts";
export { VARIANTS, measure } from "./tune-guard.ts";
export * as tuneGuard from "./tune-guard.ts";
// Path B: the local model service the MV3 extension talks to (namespaced `main`).
export { createPickerServer, startPickerServer } from "./picker-server.ts";
export * as pickerServer from "./picker-server.ts";
// ctrip/transfer network + probe tools (each exports a CLI `main` -> namespaced).
export * as h5Flights from "./h5-flights.ts";
export * as liveProbe from "./live-probe.ts";
export * as liveCapture from "./live-capture.ts";
export * as otaProbe from "./ota-probe.ts";
export { CTRIP, SKYBOOK, PROFILES } from "./profiles.ts";
// qunar: the ctrip flow skeleton replayed on a real site (plan + oracle + probe).
export { HOME as QUNAR_HOME, buildChecks as buildQunarChecks, buildPlan as buildQunarPlan } from "./qunar-task.ts";
export * as qunarTask from "./qunar-task.ts";
export * as qunarProbe from "./qunar-probe.ts";
export * as datasource from "./datasource.ts";
// ctrip scenario: data + oracle + task (its `main` joins the namespaced set).
export * as ctrip from "./ctrip-data.ts";
export {
  GOAL, demoUser, flightSubgoals, harvest, hotelSubgoals, makePlan, pageUrl,
} from "./ctrip-task.ts";
export * as ctripTask from "./ctrip-task.ts";
