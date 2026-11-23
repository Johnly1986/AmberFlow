/**
 * run 面选择段的**纯结构契约**：host = executor 侧原语面；ctx = 本步数据面；
 * acc/gateRecovery = 阶梯就地记账。
 *
 * 为什么单独成文件：统一入口（`decision-pick-unified.ts`）、对照臂（`decision-pick-phase.ts`）
 * 与询问实现（`decision-ask.ts`）必须共享同一份形状；类型面从对照臂里搬出来后，对照臂退役
 * 不牵动其余模块。`decision-pick-phase.ts` 保留兼容 re-export，既有 import 路径（parity lane）不破。
 *
 * 纪律：本文件无运行期符号（全 `import type`，模块零副作用），不 import 应用层。
 */
import type { TraceStep } from "./audit.ts";
import type { CandidateExtractRequest } from "./candidate-contract.ts";
import type { DeclaredTargetsResolver } from "./declared-targets.ts";
import type { WindowChainFact } from "./executor-pure.ts";
import type { AnyPage, EscalatorLike, Sig, StopCode } from "./executor-types.ts";
import type { Elem, ElemFamily, ElemPool } from "./extraction.ts";
import type { HintMatchOptions } from "./rules.ts";
import type { BrowserMiddleware } from "./executor.ts";
import type { DecisionAccounting, DecisionLayerReceipt } from "./decision-ask-contract.ts";
import type { ProviderCapabilities } from "../support/decision-provider-contract.ts";

/** executor 侧原语：本阶段唯一的外部能力面（全是 engine 类型，不触及应用层）。 */
export interface RunPickHost {
  pickElement: (goal: string, page: AnyPage, pool: ElemPool, blocked: Set<string>, notes: Record<string, string> | null) => Promise<[string | null, number, Record<string, number>]>;
  /** 排序先验（族软先验）；无参形式读调用方当前步视图，与既有调用点同义。 */
  orderedPool: (pool?: ElemPool) => ElemPool;
  settleBeforeExtract: (page: AnyPage) => Promise<unknown>;
  pruneForbids: (pool: ElemPool) => void;
  hintOpts: () => HintMatchOptions;
  frameHosts: string[] | null;
  stateTextFn: (page: AnyPage, instr: string) => Promise<string>;
  /** DC4 上文能力档（provider 自报；null = 未声明）。 */
  contextCapability: () => ProviderCapabilities["context"] | null;
  /** 执行器已注入的 L4 站点事实文本（null = 未注入）；回执如实记 L4 = sent/absent。 */
  siteFactsNotes: () => string | null;
  rowAnchorNote: (targets: readonly (string | null | undefined)[]) => string;
  declaredTargets: () => readonly (string | null | undefined)[];
  goalHeld: () => Promise<boolean>;
  goalSignalFn: ((page: AnyPage) => boolean | Promise<boolean>) | null;
  isTyping: (el: Elem) => boolean;
  modelLabel: () => string;
  degradedReasonSuffix: () => string;
  choiceLimitReason: () => string | null;
  clearChoiceLimitReason: () => void;
  stop: (code: StopCode, detail?: string, at?: number) => void;
  stopReason: () => string;
  stepTimeoutLeft: () => number;
  /** 宽扫抽池（executor 的 candidates.extract 单点；本模块不持 mw）。 */
  candidatesExtract: (req: CandidateExtractRequest) => Promise<ElemPool>;
}

/** 本步输入与就地记账数组（不可变面：只读；数组字段由调用方持有并共享同一份）。 */
export interface RunPickCtx {
  pg: AnyPage;
  stepNo: number;
  instruction: string;
  verbose: boolean;
  elems: ElemPool;
  ruleRef: string | null;
  curHint: string | null;
  commandMode: boolean;
  forbidden: Record<string, Sig>;
  noted: Record<string, string> | null;
  /** run 面 attempt 账本（禁选单源视图；缺省 = 无实例，退回就地 forbid 表）。 */
  decisionAccounting?: DecisionAccounting;
  targets: DeclaredTargetsResolver;
  trace: TraceStep[];
  adjudicate: boolean;
  reobserve: boolean;
  escalateFn: EscalatorLike | null;
  expectedFamily: ElemFamily | null;
  confFloor: number;
  candidatePriority: "bucketed" | "main-first";
  tieredHint: boolean;
  rulesOnly: boolean;
  decisionDegradedReasonClass: NonNullable<BrowserMiddleware["decisionDegraded"]>["reason_class"] | null;
  rejectedAskConfs: number[];
  warnings: string[];
  /** 本步是否已宽扫/已升级（run 级每步至多一次）；入口值由 run() 传入。 */
  reobserved: boolean;
  escalated: boolean;
  escalatedPick: string | null;
  /** 窗口递增链事实（run() 持有的本步数组；本阶段就地追加）。 */
  windowChainFacts: WindowChainFact[];
}

/** 阶梯滚动状态：ref/conf/method 与视图世代（elems 可能被宽扫替换）逐分支推进。 */
export interface PickAcc {
  elems: ElemPool;
  ref: string | null;
  conf: number;
  method: string;
  decisionKind: "rule" | "model" | "escalate";
  layaMargin: number | null;
  tierAsk: { n: number; tier: number } | null;
  reobserved: boolean;
  escalated: boolean;
  escalatedPick: string | null;
  nominatedRepair: boolean;
  /** 最近一次模型询问的逐层回执（证据面用；null = 本步还没有模型询问）。 */
  decisionContext: { layers: DecisionLayerReceipt[] } | null;
}

/** 低置信恢复的跨 helper 记账（原实现是同一分支里的三个局部变量）。 */
export interface GateRecovery {
  recovered: boolean;
  widePick: { ref: string; conf: number } | null;
  /** 本分支内被闸门丢掉的 ask conf（提交点见各出口；adjudicate 复用意见时撤回最后一笔）。 */
  gateRejected: number[];
}
