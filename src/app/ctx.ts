/**
 * L2 运行期 `ctx`（真实实现）——脚本应用**唯一**的运行期面。
 *
 * 分工（与 API 草案一致）：
 *   - **脚本**：控制流（循环/条件/重试/组合）；
 *   - **引擎**：一步之内的一切——元素池、规则/hint/模型选元素、置信度/风险闸门、
 *     可操作性探针、DOM 信号判定、绑定与数据腿、危险动作 dry-run+确认。
 *
 * 红线在 L2 的落法：
 *   - 脚本拿不到模型文本/分数、拿不到 `page`/`locator`、不能自报完成——只能拿到
 *     `{ok, stopCode, evidence}` 这种**结构化结果**；
 *   - 完成只认该面证据：`step`/`arrive` 的 `done` 由 `checkSignal`/`checkToolSignal` 裁决；
 *   - 值只来自声明/观察/派生：`read.*` 是只读观察，`source()` 是数据腿观察。
 */
import path from "node:path";
import {
  disallowedHost, type BrowserMiddleware, type BrowserSession, type ExecutedAction,
  type RunReport, type SkippedAction, type StepStateRecord,
} from "../engine/executor.ts";
import { NAVIGATION_GOTO_TIMEOUT_MS } from "../support/tuning.ts"; import { validateCommands } from "../engine/actions.ts"; import { frameGateExcludes } from "../engine/frame-scope.ts";
import {
  firstOf, framesOf, locatorAnyFrame, urlOf, poolSniff,
  splitFrameSuffixFromSelector, frameScopeEvidenceOf, frameScopeMatchesFrame,
  type FrameScopeEvidence,
  type FrameLike, type PageLike,
} from "../engine/extraction.ts";
import { extractElements } from "./candidate-scan.ts";
// arrive 侧限速判据的嗅探面选择器（与执行器同口径的准入面）。
import { admitSelectorWithJsFor } from "../engine/surface.ts";
// 限速判据阈值单一出处（step 侧与 arrive 侧共用）。
import { THROTTLE_BODY_FLOOR, THROTTLE_COLLAPSE_RATIO } from "../engine/throttle-signature.ts";
// C2 waitForTarget：hint 语义核对与规则面同一份语法（hintCandidates → hintMatch 单一出处）。
import { hintCandidates } from "../engine/rules.ts";
import { observePage, validateObserveOptions, type ObserveOptions, type ObserveResult } from "../engine/observe.ts";
import { checkSignal, signalHasFrameSuffix } from "../engine/signals.ts";
import { defaultDates, defaultDatesSlotNames, loadSource, parseDatesValue, runSource, ValueError } from "../data/datasource.ts";
import {
  validateReturns, type ReturnExtractor,
} from "./app-adapters.ts";
import type { DatasetStore } from "../engine/dataset.ts";
import { capToolText, stderrTail } from "./tool-artifact.ts";
import { REPO } from "../flow/flow.ts";
import { PageStateStore, type PageState } from "./page-state.ts";
import { createKit, type CommandDecl, type DomSignal, type TargetDecl, type ValueBinding } from "./kit.ts";
import { pushEvent, type AppTrace, type TraceCall } from "./trace.ts";
import { validateToolSignal, type ToolSignal } from "../browser/tool-signals.ts";
// B1 节奏统一：最小步间距（start-to-start）的核心计算在三脸共用的 support/pace.ts。
import { paceRemainder } from "../support/pace.ts";
import { sleepMs } from "../support/sleep.ts";
/** L2 运行期 ctx 的类型面与 StopError —— 拆到 ctx-types.ts（F1）。 */
import {
  StopError,
  type StepRequest, type StepEvidence, type ToolStepOutput, type StepResult,
  type ScrollListOptions, type ScrollListResult, type ExpandCount, type ExpandOptions,
  type ExpandResult, type RangeValue, type SetRangeOptions, type SetRangeResult,
  type CollectStopReason, type CollectRequest, type CollectCoverage, type CollectResult,
  type SourceObservationView, type ManualRequest, type TabInfo, type SwitchTabMatch,
  type SwitchTabResult, type CtxBudget, type ToolRunRequest, type ToolRunResult,
  type Ctx, type CtxDeps, type ExtractOptions,
} from "./ctx-types.ts";
export {
  StopError,
  type StepRequest, type StepEvidence, type ToolStepOutput, type StepResult,
  type ScrollListOptions, type ScrollListResult, type ExpandCount, type ExpandOptions,
  type ExpandResult, type RangeValue, type SetRangeOptions, type SetRangeResult,
  type CollectStopReason, type CollectRequest, type CollectCoverage, type CollectResult,
  type SourceObservationView, type ManualRequest, type TabInfo, type SwitchTabMatch,
  type SwitchTabResult, type CtxBudget, type ToolRunRequest, type ToolRunResult,
  type Ctx, type CtxDeps, type ExtractOptions,
};

/** L2 ctx 的原语参数校验面 —— 拆到 ctx-validate.ts（F1；真实/dry/replay 共用）。 */
import {
  isObj, resolveCtxUrl, assertAct, samePage, sameNavTarget, sameDeclaredPageHref,
  normalizeCommandIds, DECLARED_RUN_KEYS, declaredRunProblems, validateSwitchTabMatch,
  switchTabMatches, describeTabs, isSyntheticScrollTarget, validateScrollListRequest,
  validateExpandRequest, validateSetRangeRequest, validateCollectRequest, validateExtractOptions,
  validateWaitForTargetArgs, waitTiming, resolveRunAdapter, targetOptions,
} from "./ctx-validate.ts";
export {
  isObj, resolveCtxUrl, assertAct, samePage, sameNavTarget, sameDeclaredPageHref,
  normalizeCommandIds, DECLARED_RUN_KEYS, declaredRunProblems, validateSwitchTabMatch,
  switchTabMatches, describeTabs, isSyntheticScrollTarget, validateScrollListRequest,
  validateExpandRequest, validateSetRangeRequest, validateCollectRequest, validateExtractOptions,
  validateWaitForTargetArgs, waitTiming, resolveRunAdapter, targetOptions,
};
import { createCtxRuntime } from "./ctx-runtime.ts";
import { createCtxNav } from "./ctx-nav.ts";
import { createCtxRead } from "./ctx-read.ts";
import { createCtxScroll } from "./ctx-scroll.ts";
import { createCtxManual } from "./ctx-manual.ts";
import { createCtxTools } from "./ctx-tools.ts";

export function createCtx(deps: CtxDeps): Ctx {
  const rt = createCtxRuntime(deps);
  const { pack, slots, runtime, trace, budget, page, signalHosts, hosts } = rt;
  const kit = createKit();
    // S1：`runtime.epoch` 是**执行器游标**的只读投影（不自建第二份状态来源）。
  // `dry:false`（eval3 消歧义）：这是真跑面——dry/replay 的 ctx（ctx-dry/ctx-replay）自己给 true。
  const runtimeView = Object.freeze({
    outDir: runtime.outDir, runId: runtime.runId, today: runtime.today,
    get epoch(): number { return deps.mw().stateEpoch(); },
    dry: false,
  });
  const ctx: Ctx = {
    ...createCtxNav(rt),
    ...createCtxRead(rt),
    ...createCtxScroll(rt),
    ...createCtxManual(rt),
    ...createCtxTools(rt),
    judge: kit.judge,
    tool: kit.tool,
    hint: kit.hint,
    hints: kit.hints,
    command: kit.command,
    value: kit.value,
    app: { id: pack.id, ...(pack.label === undefined ? {} : { label: pack.label }), goal: pack.goal },
    slots: Object.freeze({ ...slots }),
    runtime: runtimeView,
    budget,
    log: (msg, data) => {
      pushEvent(trace, { call: "log", desc: msg, ...(data === undefined ? {} : { result: data }) });
      if (deps.verbose) console.log(`  [flow] ${msg}`);
    },
    fail: (code, reason) => {
      throw new StopError(typeof code === "string" && code.trim() ? code : "flow_failed", reason ?? "");
    },
    url: () => rt.currentUrl,
    done: async () => {
      if (rt.closed) throw new StopError("config_error", "ctx.done called twice");
      rt.closed = true;
      const invs = (pack.invariants ?? []) as Array<Record<string, unknown>>;
      if (!invs.length) {
        pushEvent(trace, { call: "done", ok: true });
        return;
      }
      let p: PageLike;
      try {
        p = await page();
      } catch {
        throw new StopError("invariant_failed", "ctx.done: no browser session, but web invariants need the end state");
      }
      const failed: string[] = [];
      const details: Array<{ id: string; held: boolean }> = [];
      for (const inv of invs) {
        const sig = inv["signal"];
        const held = isObj(sig) ? await checkSignal(p, sig as never, signalHosts(sig)) : false;
        details.push({ id: String(inv["id"] ?? "?"), held });
        if (!held) failed.push(String(inv["id"] ?? "?"));
      }
      pushEvent(trace, {
        call: "done", ok: failed.length === 0,
        ...(failed.length ? { stop_code: "invariant_failed" } : {}),
        result: { invariants: details },
      });
      if (failed.length) {
        throw new StopError("invariant_failed", `ctx.done: invariants failed on the end state: ${failed.join(", ")}`);
      }
    },
  };
  return ctx;
}

/**
 * `ctx.run` 的 `returns` 规范化：只认既有 `ReturnExtractor` 声明面（`validateReturns` 是
 * 加载期与运行期**同一份**校验）。坏声明 = 结构化 `config_error`，绝不"猜一个抽取方式"。
 */
/** L2 ctx 的纯工具函数 —— 拆到 ctx-tool.ts（F1；toolReturns/toolFailureReason/pickRow）。 */
import { toolReturns, toolFailureReason, pickRow, pickRowMin, pickRowMax } from "./ctx-tool.ts";
export { toolReturns, toolFailureReason, pickRow };
