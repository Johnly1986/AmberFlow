/**
 * run 面选择段的**统一编排入口**（P3）：序列与对照臂一致——
 * 规则 → 窄问 → 停因/闸门（恢复阶梯）→ R2b → 族修复 → 组装结果。
 *
 * 与 phase 的关系：恢复三档 rung 的实现单源在 `decision-ask.ts`（P2），本模块持有编排与其余
 * 分支；`decision-pick-phase.ts` 保留旧编排作 A/B 对照臂（`AMBERFLOW_DECISION_LADDER=phase`）。
 */
import { decisionDegradedAdvice } from "../model/decision-probe.ts";

import type { CandidateExtractRequest } from "./candidate-contract.ts";

import { declaredHiddenSuffix, declaredMissSuffix, identityHiddenSuffix } from "./evidence.ts";
import { WIDER_ELEMENTS, lowConfDiscrimination, topTwoMargin, windowChainMissSuffix } from "./executor-pure.ts";
import { runWindowEscalationRung } from "./window-escalation.ts";

import { type ElemPool, WIDE_QUOTAS, elemFamily, filterElemsByFamily, lexicalOverlap } from "./extraction.ts";
import { introducesNewIdentity } from "./elem-model.ts";
import { HINT_CLOSED_SET_TEXT } from "./grammar-prompt.ts";
import { affordanceRule, hintCandidates, navRule } from "./rules.ts";
import type { BrowserMiddleware, ModelPickPhase } from "./executor.ts";
import { askGoalOf, askPick, forbiddenOf, runRecoveryLadder } from "./decision-ask.ts";

import type { GateRecovery, PickAcc, RunPickCtx, RunPickHost } from "./decision-pick-types.ts";

/** 阶梯入口：规则 → 窄问 → 停因/闸门 → R2b → 族修复；返回值即 `ModelPickPhase`。 */
export async function runDecisionPickUnified(host: RunPickHost, ctx: RunPickCtx): Promise<ModelPickPhase> {
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
    decisionContext: null,
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
export function floorOf(ctx: RunPickCtx): number {
  return Math.max(0.10, ctx.confFloor - 0.05 * Object.keys(ctx.forbidden).length);
}

/** 分支①：规则/闭集命中即规则票，不再向模型询问。 */
export function pickByRules(ctx: RunPickCtx, st: PickAcc): void {
  st.ref = ctx.ruleRef;
  st.conf = 1.0;
  st.method = "rule:match";
  st.decisionKind = "rule";
}

/**
 * 分支②：窄问优先（可选 tiered hint 子集），弃权则全池重问。
 * tier 只是**更小的问法**，不是裁决者：低于 floor 或无答案即回退全池，后续阶梯不变。
 */
export async function askNarrow(host: RunPickHost, ctx: RunPickCtx, st: PickAcc, mm: string): Promise<void> {
  // 禁选单源：账本视图（缺省退回就地 forbid 表）——与 askPick 的入参是同一份计算。
  const forbiddenSet = forbiddenOf(ctx, st.elems);
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
  let [picked, pconf, pprobs] = await askPick(host, ctx, st, askGoalOf(ctx), askPool, forbiddenSet, ctx.noted);
  if (askPool !== st.elems && st.tierAsk !== null && (picked === null || pconf < ctx.confFloor)) {
    // narrowed ask abstained: today's full-pool ask still gets its turn
    if (ctx.verbose) console.log(`  step ${ctx.stepNo}: tiered hint (${st.tierAsk.n} candidates) abstained -> full pool`);
    st.tierAsk = null;
    [picked, pconf, pprobs] = await askPick(host, ctx, st, askGoalOf(ctx), st.elems, forbiddenOf(ctx, st.elems), ctx.noted);
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
export async function stopOnNoRef(host: RunPickHost, ctx: RunPickCtx, _st: PickAcc): Promise<void> {
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
export function stopOnUnknownRef(host: RunPickHost, ctx: RunPickCtx, st: PickAcc): void {
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
export async function floorGate(host: RunPickHost, ctx: RunPickCtx, st: PickAcc, mm: string, floor: number): Promise<boolean> {
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
  await runRecoveryLadder(host, ctx, st, mm, floor, rec);
  if (rec.recovered) {
    // 恢复意见本身走 trace 进既有 `conf` 聚合；被丢弃的意见照记（确实在 floor 处被拒过）。
    ctx.rejectedAskConfs.push(...rec.gateRejected);
    return false;
  }
  return adjudicatePick(host, ctx, st, mm, floor, rec);
}

/**
 * 宽化止损的事实尾缀（additive）：本轮低置信恢复因宽池没引入新元素身份而提前停止时，
 * 把"少掉的 ask 是为什么"写进停因；未发生时返回空串（既有 reason 逐字节不变）。
 */
function identityFlatSuffix(window: number | null | undefined): string {
  if (window === null || window === undefined) return "";
  return `; wide recovery stopped at window ${window}: the wider pool added no new element identity`;
}

/**
 * 分支⑤f：裁决票 vs 低置信停。声明了"错了白跑"（adjudicate）时，低置信不再是阻塞理由——
 * 把模型此刻的选择执行，让这一步自己的 DOM 信号事后裁决；否则 low_confidence 结构化停。
 */
export function adjudicatePick(host: RunPickHost, ctx: RunPickCtx, st: PickAcc, mm: string, floor: number, rec: GateRecovery): boolean {
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
      + windowChainMissSuffix(ctx.windowChainFacts)
      // 宽化止损事实尾缀（additive；无新身份提前停止才有，未发生 = 空串）。
      + identityFlatSuffix(rec.identityFlat), ctx.stepNo);
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
export async function r2bReopen(host: RunPickHost, ctx: RunPickCtx, st: PickAcc, mm: string, floor: number): Promise<void> {
  if (!(st.ref !== null && !st.reobserved && st.method === mm && st.conf < 0.9
    && host.stepTimeoutLeft() > 0
    && !lexicalOverlap(ctx.instruction, String(st.elems[st.ref]?.label ?? "")))) return;
  st.reobserved = true;
  await host.settleBeforeExtract(ctx.pg);
  const wideR2b = await host.candidatesExtract({ page: ctx.pg, jsProbe: true, maxElements: WIDER_ELEMENTS, widgets: true, quotas: WIDE_QUOTAS, candidatePriority: ctx.candidatePriority, hosts: host.frameHosts });
  // 增长门按**元素身份**判（与宽扫/窗口链同一判据）：池变大但只是同批元素重编号时，
  // 再问一次只会看到同一批候选，白付一次 ask。
  if (!introducesNewIdentity(wideR2b, st.elems)) return;
  host.pruneForbids(wideR2b);
  const wideAskR2b = host.orderedPool(wideR2b);
  const [ref2, conf2] = await askPick(host, ctx, st, askGoalOf(ctx), wideAskR2b, forbiddenOf(ctx, wideAskR2b), ctx.noted);
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
  const rungR2b = await runWindowEscalationRung(rungCarrier(host), { pg: ctx.pg, stepNo: ctx.stepNo, instruction: askGoalOf(ctx), verbose: ctx.verbose, elems: st.elems, floor, forbidden: ctx.forbidden, noted: ctx.noted, candidatePriority: ctx.candidatePriority, frameHosts: host.frameHosts, stepTimeoutLeft: host.stepTimeoutLeft, pickElement: (g, _page, pool, blocked, notes) => askPick(host, ctx, st, g, pool, blocked, notes), orderedPool: host.orderedPool, pruneForbids: host.pruneForbids, windowChainFacts: ctx.windowChainFacts, logTag: "R2b relevance widen",
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
export async function familyRepair(host: RunPickHost, ctx: RunPickCtx, st: PickAcc, mm: string): Promise<boolean> {
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
  const forbiddenSet = forbiddenOf(ctx, narrow);
  const repairRule = navRule(ctx.instruction, narrow) ?? affordanceRule(ctx.instruction, narrow, null);
  let repaired: { ref: string; conf: number; method: string } | null = null;
  if (repairRule !== null && !forbiddenSet.has(repairRule)) {
    repaired = { ref: repairRule, conf: 1, method: "rule:match" };
  }
  if (repaired === null) {
    const [rp, rconf] = await askPick(host, ctx, st, askGoalOf(ctx), narrow, forbiddenSet, ctx.noted);
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
export function assemblePhase(st: PickAcc, mm: string, stopped: boolean): ModelPickPhase {
  return {
    stopped, ref: st.ref, conf: st.conf, method: st.method, decisionKind: st.decisionKind,
    layaMargin: st.layaMargin, tierAsk: st.tierAsk, nominatedRepair: st.nominatedRepair,
    escalatedPick: st.escalatedPick, elems: st.elems, label: mm,
    ...(st.decisionContext === null ? {} : { context: st.decisionContext }),
  };
}

/**
 * `runWindowEscalationRung` 的首参只被读 `candidates.extract`（见该 helper 实现）；本模块不持
 * `BrowserMiddleware`，故用 host 的宽扫原语构造最小替身——两处递增链仍只有**同一份**实现。
 */
function rungCarrier(host: RunPickHost): BrowserMiddleware {
  return { candidates: { extract: (req: CandidateExtractRequest) => host.candidatesExtract(req) } } as unknown as BrowserMiddleware;
}

