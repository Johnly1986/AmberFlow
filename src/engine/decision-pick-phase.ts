/**
 * run 面选择段的**对照臂编排**（旧序列；与 `decision-pick-unified.ts` 共享 helper 单源）。
 * 默认路径已切统一入口；本文件只经 `AMBERFLOW_DECISION_LADDER=phase` 作 A/B 对照。
 *
 * 结构契约（host/ctx/acc/recovery）在 `decision-pick-types.ts`；本文件保留兼容 re-export，
 * 既有从本文件 type-import 的调用方/parity lane 不需要改路径。
 */
import type { ModelPickPhase } from "./executor.ts";
import type { PickAcc, RunPickCtx, RunPickHost } from "./decision-pick-types.ts";
import {
  assemblePhase, askNarrow, familyRepair, floorGate, floorOf, pickByRules, r2bReopen, stopOnNoRef, stopOnUnknownRef,
} from "./decision-pick-unified.ts";

export type { GateRecovery, PickAcc, RunPickCtx, RunPickHost } from "./decision-pick-types.ts";

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
