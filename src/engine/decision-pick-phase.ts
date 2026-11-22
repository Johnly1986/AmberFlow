/**
 * run 面选择段的独立实现（4d pick phase）：把选择段阶梯逐分支实现到
 * 本模块，按"规则 → 窄问 → 低置信宽扫 → 升级 → 裁决 → R2b → 族修复"拆成
 * 独立 helper（每个 ≤150 行），顶层 `runDecisionPick(host, ctx)` 只做编排。
 *
 * 纪律（与执行器实现片段同一套）：
 *   - `host` 是**纯结构接口**（executor 侧原语显式注入：pickElement/orderedPool/宽扫抽取/
 *     结算/剪枝/停因/预算…），engine 不 import 应用层；本模块不持 `BrowserMiddleware`；
 *   - `ctx` 是纯数据（本步的输入与就地记账数组），视图世代（elems 池 / forbidden / 窗口链
 *     事实）只有一份，随 `PickAcc` 滚动；
 *   - 分支顺序、错误分支、返回字段序与 run 面选择段的既有语义逐项一致——搬移不改行为。
 */
import { decisionDegradedAdvice } from "../model/decision-probe.ts";
import { type TraceStep } from "./audit.ts";
import type { CandidateExtractRequest } from "./candidate-contract.ts";
import { type DeclaredTargetsResolver } from "./declared-targets.ts";
import { declaredHiddenSuffix, declaredMissSuffix, identityHiddenSuffix } from "./evidence.ts";
import { WIDER_ELEMENTS, describeActionError, lowConfDiscrimination, topTwoMargin, windowChainMissSuffix, type WindowChainFact } from "./executor-pure.ts";
import { runWindowEscalationRung } from "./window-escalation.ts";
import { type AnyPage, type EscalatorLike, type Sig, type StopCode } from "./executor-types.ts";
import { type Elem, type ElemFamily, type ElemPool, WIDE_QUOTAS, ariaInteractiveLines, criteriaView, elemFamily, filterElemsByFamily, lexicalOverlap, urlOf } from "./extraction.ts";
import { HINT_CLOSED_SET_TEXT } from "./grammar-prompt.ts";
import { type HintMatchOptions, affordanceRule, hintCandidates, navRule } from "./rules.ts";
import type { BrowserMiddleware, ModelPickPhase } from "./executor.ts";

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
interface PickAcc {
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
}

/** 低置信恢复的跨 helper 记账（原实现是同一分支里的三个局部变量）。 */
interface GateRecovery {
  recovered: boolean;
  widePick: { ref: string; conf: number } | null;
  /** 本分支内被闸门丢掉的 ask conf（提交点见各出口；adjudicate 复用意见时撤回最后一笔）。 */
  gateRejected: number[];
}

/** 阶梯入口：规则 → 窄问 → 停因/闸门 → R2b → 族修复；返回值即 `ModelPickPhase`。 */
export async function runDecisionPick(host: RunPickHost, ctx: RunPickCtx): Promise<ModelPickPhase> {
  // 方法标签跟着决策源走：provider 自报其名（decision-service / 基线名…），全阶段只取一次。
  const mm = host.modelLabel();
  const st: PickAcc = {
    elems: ctx.elems,
    ref: null,
    conf: 0,
    method: mm,
    // 粗分类（聚合用）：rule=规则/闭集解析，model=provider 决策票，escalate=老师点名。
    decisionKind: "model",
    layaMargin: null,
    tierAsk: null,
    reobserved: ctx.reobserved,
    escalated: ctx.escalated,
    escalatedPick: ctx.escalatedPick,
    nominatedRepair: false,
  };
  if (ctx.ruleRef && !(ctx.ruleRef in ctx.forbidden)) {
    pickByRules(ctx, st);
  } else {
    await askNarrow(host, ctx, st, mm);
  }
  if (st.ref === null) {
    await stopOnNoRef(host, ctx, st);
    return assemblePhase(st, mm, true);
  }
  // PORT FIX: a model answer can name a ref that is no longer in THIS step's
  // pool (the screen changed between the scan and the pick, or the answer is nonsense).
  if (st.elems[st.ref] === undefined) {
    stopOnUnknownRef(host, ctx, st);
    return assemblePhase(st, mm, true);
  }
  // The confidence floor decays as failed elements are forbidden: a
  // shrunken action space legitimately lowers the margin.
  const floor = floorOf(ctx);
  if (st.conf < floor) {
    if (await floorGate(host, ctx, st, mm, floor)) return assemblePhase(st, mm, true);
  }
  await r2bReopen(host, ctx, st, mm, floor);
  if (ctx.expectedFamily !== null && await familyRepair(host, ctx, st, mm)) {
    return assemblePhase(st, mm, true);
  }
  return assemblePhase(st, mm, false);
}

/** 闸门线：禁选越多、可用动作越少，过闸线越低（与 run 面选择段的既有公式/时机一致）。 */
function floorOf(ctx: RunPickCtx): number {
  return Math.max(0.10, ctx.confFloor - 0.05 * Object.keys(ctx.forbidden).length);
}

/** 分支①：规则/闭集命中即规则票，不再向模型询问。 */
function pickByRules(ctx: RunPickCtx, st: PickAcc): void {
  st.ref = ctx.ruleRef;
  st.conf = 1.0;
  st.method = "rule:match";
  st.decisionKind = "rule";
}

/**
 * 分支②：窄问优先（可选 tiered hint 子集），弃权则全池重问。
 * tier 只是**更小的问法**，不是裁决者：低于 floor 或无答案即回退全池，后续阶梯不变。
 */
async function askNarrow(host: RunPickHost, ctx: RunPickCtx, st: PickAcc, mm: string): Promise<void> {
  const forbiddenSet = new Set(Object.keys(ctx.forbidden));
  let askPool = host.orderedPool();
  if (ctx.tieredHint && ctx.curHint !== null && ctx.ruleRef === null) {
    const cand = hintCandidates(ctx.curHint, st.elems, host.hintOpts());
    if (cand !== null && cand.decided === null && cand.refs.length > 1) {
      const subset: ElemPool = {};
      for (const r of cand.refs) {
        if (st.elems[r] !== undefined && !forbiddenSet.has(r)) subset[r] = st.elems[r]!;
      }
      if (Object.keys(subset).length > 1) {
        askPool = subset;
        st.tierAsk = { n: Object.keys(subset).length, tier: cand.tier };
      }
    }
  }
  let [picked, pconf, pprobs] = await host.pickElement(ctx.instruction, ctx.pg, askPool, forbiddenSet, ctx.noted);
  if (askPool !== st.elems && st.tierAsk !== null && (picked === null || pconf < ctx.confFloor)) {
    // narrowed ask abstained: today's full-pool ask still gets its turn
    if (ctx.verbose) console.log(`  step ${ctx.stepNo}: tiered hint (${st.tierAsk.n} candidates) abstained -> full pool`);
    st.tierAsk = null;
    [picked, pconf, pprobs] = await host.pickElement(ctx.instruction, ctx.pg, st.elems, forbiddenSet, ctx.noted);
  }
  st.ref = picked;
  st.conf = pconf;
  st.method = mm;
  st.layaMargin = topTwoMargin(pprobs);
}

/**
 * 分支③：没有任何可用提名时的结构化停因（choice-limit → rules-only → 动作空间耗尽）。
 * rules-only 且"这一步什么都没声明"时当场评估一次信号，把"缺模型"的谎言换成实况。
 */
async function stopOnNoRef(host: RunPickHost, ctx: RunPickCtx, st: PickAcc): Promise<void> {
  // A2：候选窗口超过决策服务上限——结构化停因，绝不把 200+ 选项硬塞过去。
  if (host.choiceLimitReason() !== null) {
    const why = host.choiceLimitReason()!;
    host.clearChoiceLimitReason();
    host.stop("decision_service_choice_limit", why, ctx.stepNo);
    if (ctx.verbose) console.log(`  step ${ctx.stepNo}: ${host.stopReason()}`);
    return;
  }
  // In rules-only mode a null ref usually means "no runtime to ask", which is not an
  if (ctx.rulesOnly) {
    // 被降级吞掉的步（本需要模型选点）在 step warning 记 decision_degraded——停因保留
    // （诚实机制不变），留痕说明这是配置面问题而非模型缺席，并给分类建议。
    if (ctx.decisionDegradedReasonClass !== null) {
      ctx.warnings.push(`decision_degraded: 决策面已降级（${ctx.decisionDegradedReasonClass}）——`
        + `本步需要模型选点，规则面无法替代；${decisionDegradedAdvice(
          ctx.decisionDegradedReasonClass === "midrun_death" ? "unknown" : ctx.decisionDegradedReasonClass)}`);
    }
    // 诚实停因：这一步**什么动作都没声明**（无 target_hint、无命令空间）时，"缺模型"是个谎言
    // ——真正的问题要么是"信号已成立但这步没声明零动作命令，引擎不肯替作者宣布完成"，
    // 要么是"信号根本不成立"。当场评估一次信号（只在走向停止时付这一次）。
    if (ctx.curHint === null && !ctx.commandMode) {
      const held = host.goalSignalFn ? (await host.goalHeld()) : false;
      host.stop("no_model_runtime",
        `step ${ctx.stepNo} declares no action (no target_hint, no commands) and rules-only has no model `
        + `to pick one — its done-signal ${held ? "ALREADY holds on this page: declare a zero-action "
            + 'command (commands: [{"op":"skip"}]) on this subgoal, or name a target_hint, so the '
            + "signal can be honored"
          : "does not hold on this page either: name a target_hint, declare commands, "
            + "or provide a decision model"}`
        + host.degradedReasonSuffix(), ctx.stepNo);
      if (ctx.verbose) console.log(`  step ${ctx.stepNo}: ${host.stopReason()}`);
      return;
    }
    host.stop("no_model_runtime",
      `no model runtime: this step needs a model pick (rules-only mode) on step ${ctx.stepNo}`
      // 规划引导：计划点了名、规则没解出来、模型又不在/弃权——当场送闭集。
      + (ctx.curHint !== null && ctx.ruleRef === null
          ? ` — target_hint "${ctx.curHint}" 未被规则命中，${HINT_CLOSED_SET_TEXT}`
          : "")
      // provider 是抛错降级（而非本来就没装）时，把 HTTP 事实带上——排查不必再猜。
      + host.degradedReasonSuffix() + identityHiddenSuffix(ctx.targets.identityHidden)
      // 规划面停因的行锚证据（无行锚声明 = 空串）。
      + host.rowAnchorNote(host.declaredTargets()), ctx.stepNo);
  } else {
    host.stop("action_space_exhausted",
      `action space exhausted on step ${ctx.stepNo}`
      + (ctx.curHint !== null && ctx.ruleRef === null
          ? ` — target_hint "${ctx.curHint}" 未被规则命中，${HINT_CLOSED_SET_TEXT}`
          : "") + identityHiddenSuffix(ctx.targets.identityHidden)
      + host.rowAnchorNote(host.declaredTargets()), ctx.stepNo);
  }
  if (ctx.verbose && ctx.rulesOnly) console.log(`  step ${ctx.stepNo}: ${host.stopReason()}`);
}

/** 分支④：提名 ref 不在本步池里（页面在扫描与提问之间变了，或答复是胡话）。 */
function stopOnUnknownRef(host: RunPickHost, ctx: RunPickCtx, st: PickAcc): void {
  const poolSize = Object.keys(st.elems).length;
  if (ctx.curHint) {
    host.stop("hint_matched_nothing",
      `target_hint ${JSON.stringify(ctx.curHint)} matched nothing in a pool of ${poolSize} element(s) on step ${ctx.stepNo}`
      // DRF 计数事实（实跑且零命中才非空；缺省 declared 关 = 恒空串，逐字节不变）。
      + declaredHiddenSuffix(ctx.targets.getDeclaredHidden()) + declaredMissSuffix(ctx.targets.declaredMiss)
      // 规划面停因的行锚证据（无行锚声明 = 空串）。
      + host.rowAnchorNote(host.declaredTargets()), ctx.stepNo);
  } else {
    host.stop("step_names_no_target",
      `step ${ctx.stepNo} names no target: no target_hint(s), no rule matched any of the ${poolSize} element(s), and the picker returned no usable element（给这一步加 target_hint，或在页面上点名一个稳定句柄）`, ctx.stepNo);
  }
  if (ctx.verbose) console.log(`  step ${ctx.stepNo}: ${host.stopReason()}`);
}

/**
 * 分支⑤：低置信闸门。走到这里 ref/conf 都有效但 conf 低于过闸线。
 * 三种早停（重驱/无模型/动作空间耗尽）+ 恢复阶梯（宽扫 → 升级 → 裁决），裁决/停之外
 * 都会把被丢弃的 ask conf 记账提交。
 */
async function floorGate(host: RunPickHost, ctx: RunPickCtx, st: PickAcc, mm: string, floor: number): Promise<boolean> {
  const pending = st.elems[st.ref!]!;
  const wantDesc = (host.isTyping(pending) ? "type text into" : "click")
    + ` ${pending.tag} "${pending.label}"`;
  const priorHit = ctx.trace.some((t) => t.desc === wantDesc && t.executed);
  if (priorHit && st.conf >= 0.10) {
    // re-drive: proceed despite floor
    return false;
  }
  if (ctx.rulesOnly) {
    // No runtime installed and no rule/hint resolved this step: say exactly that.
    host.stop("no_model_runtime",
      `no model runtime: this step needs a model pick (rules-only mode) on step ${ctx.stepNo}`
      // 同 low_confidence：hint 被点名却没解出来时，当场送闭集（规划引导）。
      + (ctx.curHint !== null && ctx.ruleRef === null
          ? ` — target_hint "${ctx.curHint}" 未被规则命中，${HINT_CLOSED_SET_TEXT}`
          : "")
      // 同上——降级原因（HTTP 状态码 + 服务错误关键句）随停因透出。
      + host.degradedReasonSuffix(), ctx.stepNo);
    if (ctx.verbose) console.log(`  step ${ctx.stepNo}: ${host.stopReason()}`);
    return true;
  }
  if (!(ctx.adjudicate && st.ref !== null)
    && Object.keys(ctx.forbidden).length >= Math.max(0, Object.keys(st.elems).length - 1)) {
    // A2′：`adjudicate` 开着且还有活着的候选时，不能用"动作空间耗尽"抢在裁决前面——
    // 那最后一个低置信候选正是该被信号裁决的那一个。没开裁决时这个提前停原样保留。
    host.stop("action_space_exhausted",
      `action space exhausted (${Object.keys(ctx.forbidden).length} forbidden) on step ${ctx.stepNo}`, ctx.stepNo);
    return true;
  }
  // 走到恢复分支 = 原 ask 的意见已被闸门丢弃（reobserve/escalate 换别的意见、
  // low_confidence 停；唯一例外是 adjudicate 复用原意见——下面 pop 撤回）。
  const rec: GateRecovery = { recovered: false, widePick: null, gateRejected: [st.conf] };
  await reobserveWide(host, ctx, st, mm, floor, rec);
  await escalatePick(host, ctx, st, floor, rec);
  if (rec.recovered) {
    // 恢复意见本身走 trace 进既有 `conf` 聚合；被丢弃的意见照记（确实在 floor 处被拒过）。
    ctx.rejectedAskConfs.push(...rec.gateRejected);
    return false;
  }
  return adjudicatePick(host, ctx, st, mm, floor, rec);
}

/**
 * 分支⑤c：低置信宽扫（OBSERVATION-BOTTLENECK RECOVERY）。宽视图**成为本步视图**，
 * 即使本地提问仍不过闸；第二档由共享的窗口递增链 helper 扩到硬顶重问一次（命中即停）。
 */
async function reobserveWide(host: RunPickHost, ctx: RunPickCtx, st: PickAcc, mm: string, floor: number, rec: GateRecovery): Promise<void> {
  if (!(ctx.reobserve && !st.reobserved && st.ref !== null && host.stepTimeoutLeft() > 0)) return;
  st.reobserved = true;
  await host.settleBeforeExtract(ctx.pg);
  const wide = await host.candidatesExtract({ page: ctx.pg, jsProbe: true, maxElements: WIDER_ELEMENTS, widgets: true, quotas: WIDE_QUOTAS, candidatePriority: ctx.candidatePriority, hosts: host.frameHosts });
  if (!(Object.keys(wide).length > Object.keys(st.elems).length)) return;
  // refs are positional: re-prune forbids whose ref now names a different element.
  host.pruneForbids(wide);
  // 宽视图同样只做**排序先验**（不丢元素：加宽看到的东西不该被族过滤掉）。
  const wideAsk = host.orderedPool(wide);
  const [ref2, conf2] = await host.pickElement(ctx.instruction, ctx.pg, wideAsk, new Set(Object.keys(ctx.forbidden)), ctx.noted);
  // The wider view BECOMES the step's view even when the local model still abstains.
  st.elems = wide;
  if (ref2 !== null && conf2 >= floor) {
    st.ref = ref2;
    st.conf = conf2;
    st.method = `${mm}:reobserve`;
    rec.recovered = true;
    ctx.windowChainFacts.push({ window: WIDER_ELEMENTS, miss: 1, resolved: true, ref: ref2 });
    if (ctx.verbose) console.log(`  step ${ctx.stepNo}: re-observed wider (${Object.keys(wide).length} elements) -> ${st.ref} conf=${conf2.toFixed(2)}`);
    return;
  }
  if (ref2 !== null) {
    rec.widePick = { ref: ref2, conf: conf2 };
    rec.gateRejected.push(conf2);   // 宽看重问的意见也未过 floor（adjudicate 复用时撤回）
  }
  ctx.windowChainFacts.push({ window: WIDER_ELEMENTS, miss: 1, resolved: false });
  if (ctx.verbose) console.log(`  step ${ctx.stepNo}: re-observed wider (${Object.keys(wide).length} elements) -> still below floor`);
  // 窗口递增链第二档：120 档重问仍未过 floor → 扩到硬顶再重问一次（命中即停）；
  // widePick/"最后一次观察到的意见"语义随档位滚动（硬顶档成为最后一次观察）。
  const rung = await runWindowEscalationRung(rungCarrier(host), { pg: ctx.pg, stepNo: ctx.stepNo, instruction: ctx.instruction, verbose: ctx.verbose, elems: st.elems, floor, forbidden: ctx.forbidden, noted: ctx.noted, candidatePriority: ctx.candidatePriority, frameHosts: host.frameHosts, stepTimeoutLeft: host.stepTimeoutLeft, pickElement: host.pickElement, orderedPool: host.orderedPool, pruneForbids: host.pruneForbids, windowChainFacts: ctx.windowChainFacts, logTag: "re-observed wider",
    hitNote: (poolSize, ref3, conf3) => `(${poolSize} elements) -> ${ref3} conf=${conf3.toFixed(2)}`, missNote: () => "still below floor" });
  if (rung.grew) {
    st.elems = rung.pool;
    if (rung.adopted && rung.ref !== null) { st.ref = rung.ref; st.conf = rung.conf; st.method = `${mm}:reobserve`; rec.recovered = true; }
    else if (rung.ref !== null) { rec.widePick = { ref: rung.ref, conf: rung.conf }; rec.gateRejected.push(rung.conf); }
  }
}

/**
 * 分支⑤d：升级票（C3-R 的深思路径）。更强的推理者只能从**本轮展示过的候选**里点名
 * （不在视图里的答案一律拒收），所以它无法发明元素、值或动作。
 * 决策面已降级（起跑探判死/中途死亡）→ 升级链规则兜底，不再咨询死服务。
 */
async function escalatePick(host: RunPickHost, ctx: RunPickCtx, st: PickAcc, floor: number, rec: GateRecovery): Promise<void> {
  if (rec.recovered || !ctx.escalateFn || st.escalated || ctx.decisionDegradedReasonClass !== null
      || host.stepTimeoutLeft() <= 0) return;
  st.escalated = true;
  // 显式传当前（宽化后的）池：orderedPool 无参形式读到的是 run() 闭包的旧窄视图
  // ——低置信恢复刚把 elems 换成宽视图时，升级题面必须与 pickElement 看到的是同一份。
  // noted 同步传入：升级题面不带 = 更强的推理者反而看不见"这个候选已白跑过"的事实。
  const crit = criteriaView(host.orderedPool(st.elems), new Set(Object.keys(ctx.forbidden)), await ariaInteractiveLines(ctx.pg), ctx.noted);
  const state = { url: urlOf(ctx.pg), title: await ctx.pg.title(), main_text: await host.stateTextFn(ctx.pg, ctx.instruction) };
  try {
    const pick = await ctx.escalateFn({ instruction: ctx.instruction, criteria: crit, why: `low confidence ${st.conf.toFixed(2)} < floor ${floor.toFixed(2)}`, ...state });
    if (pick && crit[pick] !== undefined && !(pick in ctx.forbidden)) {
      st.ref = pick;
      st.method = "escalate";
      st.decisionKind = "escalate";
      st.escalatedPick = pick;
      rec.recovered = true;
      if (ctx.verbose) console.log(`  step ${ctx.stepNo}: escalated -> ${pick}`);
    } else if (ctx.verbose) console.log(`  step ${ctx.stepNo}: escalation rejected (${pick === null ? "no answer" : `'${pick}' is not a shown candidate`})`);
  } catch (e) {
    if (ctx.verbose) console.log(`  step ${ctx.stepNo}: escalation failed (${describeActionError(e)})`);
  }
}

/**
 * 分支⑤f：裁决票 vs 低置信停。声明了"错了白跑"（adjudicate）时，低置信不再是阻塞理由——
 * 把模型此刻的选择执行，让这一步自己的 DOM 信号事后裁决；否则 low_confidence 结构化停。
 */
function adjudicatePick(host: RunPickHost, ctx: RunPickCtx, st: PickAcc, mm: string, floor: number, rec: GateRecovery): boolean {
  const bestPick = rec.widePick ?? (st.ref !== null ? { ref: st.ref, conf: st.conf } : null);
  if (ctx.adjudicate && bestPick !== null && !ctx.rulesOnly) {
    // 被裁决执行的那份意见（原 ask 或宽看重问）不算被拒——撤回最后一笔暂存。
    rec.gateRejected.pop();
    st.ref = bestPick.ref;
    st.conf = bestPick.conf;
    st.method = `${mm}:adjudicated`;
    if (ctx.verbose) console.log(`  step ${ctx.stepNo}: adjudicating below gate (${st.ref} conf=${st.conf.toFixed(2)} < floor ${floor.toFixed(2)}) — the step's own signal judges`);
  } else {
    // 提交点①——low_confidence 停，暂存的意见确被丢弃。
    ctx.rejectedAskConfs.push(...rec.gateRejected);
    host.stop("low_confidence",
      `low confidence ${st.conf.toFixed(2)} < floor ${floor.toFixed(2)} on step ${ctx.stepNo}`
      // 规划引导：计划点了名、规则却没解出来——当场把闭集送给作者，省一次读源码确诊
      + (ctx.curHint !== null && ctx.ruleRef === null
          ? ` — target_hint "${ctx.curHint}" 未被规则命中，${HINT_CLOSED_SET_TEXT}`
          : "")
      // eval3 曝光面：observe 是会话内的免费侦察通道
      + `；用 ctx.observe() 在会话内看准入面与 why_not_admitted`
      // 分数不过闸门 ≠ 目标不存在——用内存里的池把两种问题分开说
      // （候选在而置信度低 = 闸门问题；池里没有词面相关候选 = 目标可能不在本页面）。
      + lowConfDiscrimination(ctx.instruction, st.elems, st.ref)
      // 规划面停因的行锚证据（无行锚声明 = 空串，reason 逐字节不变）。
      + host.rowAnchorNote(host.declaredTargets())
      // 窗口递增链跑满且全档未命中时的事实尾缀（additive；链没跑/命中过 = 空串）。
      + windowChainMissSuffix(ctx.windowChainFacts), ctx.stepNo);
    if (ctx.verbose) console.log(`  step ${ctx.stepNo}: ${host.stopReason()}`);
    return true;
  }
  // 提交点②——reobserve/escalate 挽回了这一步，但被丢弃的意见照记。
  ctx.rejectedAskConfs.push(...rec.gateRejected);
  return false;
}

/**
 * 分支⑥：R2b 词面零重叠守卫（宽扫的第二个触发器）。模型提名（非规则命中、非满置信）的
 * label 与指令零词面重叠（CJK 二元组/ASCII 词）时，是"自信地错"的典型形态——执行前强制
 * 一次宽扫重问；重问结果照常过闸，无更优则保留原提名。R2b 是质量守卫，不是停因路径。
 */
async function r2bReopen(host: RunPickHost, ctx: RunPickCtx, st: PickAcc, mm: string, floor: number): Promise<void> {
  if (!(st.ref !== null && !st.reobserved && st.method === mm && st.conf < 0.9
    && host.stepTimeoutLeft() > 0
    && !lexicalOverlap(ctx.instruction, String(st.elems[st.ref]?.label ?? "")))) return;
  st.reobserved = true;
  await host.settleBeforeExtract(ctx.pg);
  const wideR2b = await host.candidatesExtract({ page: ctx.pg, jsProbe: true, maxElements: WIDER_ELEMENTS, widgets: true, quotas: WIDE_QUOTAS, candidatePriority: ctx.candidatePriority, hosts: host.frameHosts });
  if (!(Object.keys(wideR2b).length > Object.keys(st.elems).length)) return;
  host.pruneForbids(wideR2b);
  const wideAskR2b = host.orderedPool(wideR2b);
  const [ref2, conf2] = await host.pickElement(ctx.instruction, ctx.pg, wideAskR2b, new Set(Object.keys(ctx.forbidden)), ctx.noted);
  st.elems = wideR2b;
  if (ref2 !== null && conf2 >= floor) {
    st.ref = ref2;
    st.conf = conf2;
    st.method = `${mm}:reobserve`;
    ctx.windowChainFacts.push({ window: WIDER_ELEMENTS, miss: 1, resolved: true, ref: ref2 });
    if (ctx.verbose) console.log(`  step ${ctx.stepNo}: R2b relevance widen -> ${st.ref} conf=${conf2.toFixed(2)}`);
    return;
  }
  ctx.windowChainFacts.push({ window: WIDER_ELEMENTS, miss: 1, resolved: false });
  if (ctx.verbose) {
    console.log(`  step ${ctx.stepNo}: R2b relevance widen -> keep original `
      + `(${ref2 === null ? "no pick" : `conf ${conf2.toFixed(2)}`} below floor)`);
  }
  // 窗口递增链第二档：仍未过 floor → 扩到硬顶再重问一次；仍未过 = 保留原提名。超时/零增长
  // 在 helper 内零动作返回。
  const rungR2b = await runWindowEscalationRung(rungCarrier(host), { pg: ctx.pg, stepNo: ctx.stepNo, instruction: ctx.instruction, verbose: ctx.verbose, elems: st.elems, floor, forbidden: ctx.forbidden, noted: ctx.noted, candidatePriority: ctx.candidatePriority, frameHosts: host.frameHosts, stepTimeoutLeft: host.stepTimeoutLeft, pickElement: host.pickElement, orderedPool: host.orderedPool, pruneForbids: host.pruneForbids, windowChainFacts: ctx.windowChainFacts, logTag: "R2b relevance widen",
    hitNote: (_n, ref3, conf3) => `-> ${ref3} conf=${conf3.toFixed(2)}`,
    missNote: (p) => `keep original (${p.ref === null ? "no pick" : `conf ${p.conf.toFixed(2)}`} below floor)` });
  if (rungR2b.grew) {
    st.elems = rungR2b.pool;
    if (rungR2b.adopted && rungR2b.ref !== null) { st.ref = rungR2b.ref; st.conf = rungR2b.conf; st.method = `${mm}:reobserve`; }
  }
}

/**
 * 分支⑦：有界族修复（只在走向停止时付一次成本）。第一轮用全池（软先验）解析出的动作族与
 * 提名不符 / 没解出目标时，才用"该族"再做一次解析；仍不成立 ⇒ 结构化停，绝不执行一个与
 * 提名矛盾的动作。
 * 为什么不是第一道过滤：结构族 ≠ 语义动作（div[role=combobox] = click 但语义 select、
 * contenteditable = click 但语义 fill、input[type=range] = fill 但语义设值），硬过滤会把
 * 真目标或关键上下文元素一并排掉。
 */
async function familyRepair(host: RunPickHost, ctx: RunPickCtx, st: PickAcc, mm: string): Promise<boolean> {
  const expectedFamily = ctx.expectedFamily;
  if (expectedFamily === null) return false;
  const pickedFamily = st.ref !== null ? elemFamily(st.elems[st.ref]!) : null;
  if (st.ref !== null && pickedFamily === expectedFamily) return false;
  const narrow = filterElemsByFamily(st.elems, expectedFamily);
  if (Object.keys(narrow).length === 0) {
    host.stop("nominated_family_empty",
      `nominated instruction "${expectedFamily}" but this page has no ${expectedFamily} candidates on step ${ctx.stepNo}`, ctx.stepNo);
    if (ctx.verbose) console.log(`  step ${ctx.stepNo}: ${host.stopReason()}`);
    return true;
  }
  const repairFloor = Math.max(0.10, ctx.confFloor - 0.05 * Object.keys(ctx.forbidden).length);
  const forbiddenSet = new Set(Object.keys(ctx.forbidden));
  const repairRule = navRule(ctx.instruction, narrow) ?? affordanceRule(ctx.instruction, narrow, null);
  let repaired: { ref: string; conf: number; method: string } | null = null;
  if (repairRule !== null && !(repairRule in ctx.forbidden)) {
    repaired = { ref: repairRule, conf: 1, method: "rule:match" };
  }
  if (repaired === null) {
    const [rp, rconf] = await host.pickElement(ctx.instruction, ctx.pg, narrow, forbiddenSet, ctx.noted);
    if (rp !== null && rconf >= repairFloor) repaired = { ref: rp, conf: rconf, method: mm };
  }
  if (repaired === null) {
    host.stop("nominated_family_mismatch",
      `nominated instruction "${expectedFamily}", but the page resolved ${pickedFamily ?? "nothing"} and no ${expectedFamily} candidate passed the floor on step ${ctx.stepNo}`, ctx.stepNo);
    if (ctx.verbose) console.log(`  step ${ctx.stepNo}: ${host.stopReason()}`);
    return true;
  }
  if (ctx.verbose) console.log(`  step ${ctx.stepNo}: nominated-family repair ${expectedFamily} -> ${repaired.ref} (${repaired.method})`);
  st.ref = repaired.ref;
  st.conf = repaired.conf;
  st.method = repaired.method;
  st.nominatedRepair = true;
  return false;
}

/** 把阶梯结果折成 `ModelPickPhase`（字段序与旧返回值一致；`label` 恒为决策源标签）。 */
function assemblePhase(st: PickAcc, mm: string, stopped: boolean): ModelPickPhase {
  return {
    stopped, ref: st.ref, conf: st.conf, method: st.method, decisionKind: st.decisionKind,
    layaMargin: st.layaMargin, tierAsk: st.tierAsk, nominatedRepair: st.nominatedRepair,
    escalatedPick: st.escalatedPick, elems: st.elems, label: mm,
  };
}

/**
 * `runWindowEscalationRung` 的首参只被读 `candidates.extract`（见该 helper 实现）；本模块不持
 * `BrowserMiddleware`，故用 host 的宽扫原语构造最小替身——两处递增链仍只有**同一份**实现。
 */
function rungCarrier(host: RunPickHost): BrowserMiddleware {
  return { candidates: { extract: (req: CandidateExtractRequest) => host.candidatesExtract(req) } } as unknown as BrowserMiddleware;
}
