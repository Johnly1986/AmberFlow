/**
 * run 面选择段的**装配层**：把 `BrowserMiddleware.run()` 的既有实参面（本步数据 + executor 原语）
 * 折成 `runDecisionPick(host, ctx)` 需要的两个纯结构输入。
 *
 * 为什么单独成文件：`decision-pick-phase.ts` 只认 engine 侧纯结构（不 import app、不持 mw），
 * run() 侧的原语是私有字段/局部闭包——两者的唯一合法汇合点就是本文件。放在这里之后：
 *   - executor.ts 调用点只做一次装配（形状与 `ModelPickPhase` 返回值不变）；
 *   - 装配映射是**一对一搬运**，不含任何分支/默认值改写（行为等价由 parity lane 与既有
 *     runtime/pilot/characterization 三条 lane 共同钉住）；
 *   - 本实参面与 run 面选择段的调用点逐字段同形（结构漂移由 tsc 强制）。
 *
 * 纪律：
 *   - 本文件不 import app，也不 import 任何运行期符号（全为 `import type`，模块零副作用）；
 *   - `candidatesExtract` 惰性读 `mw.candidates`（与既往实现同一点位：只在宽扫时读，缺省 null
 *     的调用方会先撞同一个错误，这里不额外兜底、不改语义）；
 *   - 映射表逐字段对齐 `decision-pick-phase.RunPickHost` / `RunPickCtx`，不新增、不改名。
 */
import type { CandidateExtractRequest } from "./candidate-contract.ts";
import type { DeclaredTargetsResolver } from "./declared-targets.ts";
import type { RunPickCtx, RunPickHost } from "./decision-pick-phase.ts";
import type { TraceStep } from "./audit.ts";
import type { WindowChainFact } from "./executor-pure.ts";
import type { AnyPage, EscalatorLike, Sig, StopCode } from "./executor-types.ts";
import type { Elem, ElemFamily, ElemPool } from "./extraction.ts";
import type { HintMatchOptions } from "./rules.ts";
import type { BrowserMiddleware } from "./executor.ts";

/** `run()` 侧的选择段实参面（run 面选择段 a-bag 逐字段同形；装配层与 parity lane 共用）。 */
export interface RunPickArgs {
  pg: AnyPage; stepNo: number; instruction: string; verbose: boolean; elems: ElemPool; ruleRef: string | null;
  curHint: string | null; commandMode: boolean; forbidden: Record<string, Sig>; noted: Record<string, string> | null;
  targets: DeclaredTargetsResolver;
  trace: TraceStep[]; adjudicate: boolean; reobserve: boolean; escalateFn: EscalatorLike | null;
  expectedFamily: ElemFamily | null; confFloor: number; candidatePriority: "bucketed" | "main-first";
  tieredHint: boolean; rulesOnly: boolean;
  decisionDegradedReasonClass: NonNullable<BrowserMiddleware["decisionDegraded"]>["reason_class"] | null;
  rejectedAskConfs: number[]; warnings: string[];
  reobserved: boolean; escalated: boolean; escalatedPick: string | null;
  /** 窗口递增链事实（run() 持有的本步数组；两臂共享同一份就地追加语义）。 */
  windowChainFacts: WindowChainFact[];
  stepTimeoutLeft: () => number;
  stop: (code: StopCode, detail?: string, at?: number) => void;
  stopReason: () => string;
  pickElement: (goal: string, page: AnyPage, pool: ElemPool, blocked: Set<string>, notes: Record<string, string> | null) => Promise<[string | null, number, Record<string, number>]>;
  orderedPool: (pool?: ElemPool) => ElemPool;
  settleBeforeExtract: (page: AnyPage) => Promise<unknown>;
  pruneForbids: (pool: ElemPool) => void;
  hintOpts: () => HintMatchOptions;
  frameHosts: string[] | null;
  stateTextFn: (page: AnyPage, instr: string) => Promise<string>;
  rowAnchorNote: (targets: readonly (string | null | undefined)[]) => string;
  declaredTargets: () => readonly (string | null | undefined)[];
  goalHeld: () => Promise<boolean>;
  goalSignalFn: ((page: AnyPage) => boolean | Promise<boolean>) | null;
  isTyping: (el: Elem) => boolean;
  modelLabel: () => string;
  degradedReasonSuffix: () => string;
  choiceLimitReason: () => string | null;
  clearChoiceLimitReason: () => void;
}

/**
 * 一次选择段的两个纯结构输入（host = 原语面；ctx = 本步数据面），按位置成对返回：
 * 调用点用 `runDecisionPick(...createRunPickWiring(...))` 单表达式装配，`run()` 行数不增
 * （存量函数只减不增）。
 */
export type RunPickWiring = [host: RunPickHost, ctx: RunPickCtx];

/**
 * 把 run() 实参折成 `(host, ctx)`：host 只取原语，ctx 只取数据，两边字段一一对应。
 * `mw` 只用于宽扫抽池的注入点（`candidates.extract`），不进入任何结构体。
 */
export function createRunPickWiring(mw: BrowserMiddleware, a: RunPickArgs): RunPickWiring {
  const host: RunPickHost = {
    pickElement: a.pickElement,
    orderedPool: a.orderedPool,
    settleBeforeExtract: a.settleBeforeExtract,
    pruneForbids: a.pruneForbids,
    hintOpts: a.hintOpts,
    frameHosts: a.frameHosts,
    stateTextFn: a.stateTextFn,
    rowAnchorNote: a.rowAnchorNote,
    declaredTargets: a.declaredTargets,
    goalHeld: a.goalHeld,
    goalSignalFn: a.goalSignalFn,
    isTyping: a.isTyping,
    modelLabel: a.modelLabel,
    degradedReasonSuffix: a.degradedReasonSuffix,
    choiceLimitReason: a.choiceLimitReason,
    clearChoiceLimitReason: a.clearChoiceLimitReason,
    stop: a.stop,
    stopReason: a.stopReason,
    stepTimeoutLeft: a.stepTimeoutLeft,
    candidatesExtract: (req: CandidateExtractRequest) => mw.candidates!.extract(req),
  };
  const ctx: RunPickCtx = {
    pg: a.pg,
    stepNo: a.stepNo,
    instruction: a.instruction,
    verbose: a.verbose,
    elems: a.elems,
    ruleRef: a.ruleRef,
    curHint: a.curHint,
    commandMode: a.commandMode,
    forbidden: a.forbidden,
    noted: a.noted,
    targets: a.targets,
    trace: a.trace,
    adjudicate: a.adjudicate,
    reobserve: a.reobserve,
    escalateFn: a.escalateFn,
    expectedFamily: a.expectedFamily,
    confFloor: a.confFloor,
    candidatePriority: a.candidatePriority,
    tieredHint: a.tieredHint,
    rulesOnly: a.rulesOnly,
    decisionDegradedReasonClass: a.decisionDegradedReasonClass,
    rejectedAskConfs: a.rejectedAskConfs,
    warnings: a.warnings,
    reobserved: a.reobserved,
    escalated: a.escalated,
    escalatedPick: a.escalatedPick,
    windowChainFacts: a.windowChainFacts,
  };
  return [host, ctx];
}
