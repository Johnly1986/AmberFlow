/**
 * `amber pilot` 的模型投票阶梯（pilot-runtime 第③段拆分；方案见 docs/PILOTED_WALKTHROUGH_PLAN.md §PW2）。
 *
 * 两条通道：
 *   - `modelVote`（执行路径）：委托引擎 `DecisionAsk` seam（经 `PilotAskAdapter` 注入面的观察与
 *     投票原语）。窄问 → floor 闸门 → 低置信宽扫重问 → 弃权即停的阶梯由
 *     `src/engine/decision-ask.ts` 单点实现，候选池/禁选/注记归引擎自取；
 *   - `modelVoteLegacy`（对照臂）：逐字节阶梯实现——只用于 S1 双臂等价度量，
 *     不接执行路径。
 *
 * floor 闸门（`gateOf`/`passesFloor`）唯一出处已上收到引擎（`decision-ask.ts`），本模块只
 * re-export 供既有 import 面继续使用（不保留第二份判据）。
 */
import { esig, WIDE_QUOTAS } from "../engine/extraction.ts";
import { PilotLedger } from "./pilot-ledger.ts";
import { WIDER_ELEMENTS } from "../engine/executor-pure.ts";
import { gateOf, passesFloor } from "../engine/decision-ask.ts";
import type { AnyPage, BrowserMiddleware } from "../engine/executor.ts";
import type { Elem, ElemPool } from "../engine/elem-model.ts";
import type { PilotAskAdapter } from "./pilot-ask-adapter.ts";

export { gateOf, passesFloor };

/** 宽扫视图（执行期 4d 同款参数）：settle 后按 WIDER_ELEMENTS/WIDE_QUOTAS 重抽；失败如实 null。 */
export async function widePool(
  mw: BrowserMiddleware, page: AnyPage, hosts: string[] | null,
): Promise<ElemPool | null> {
  try {
    await mw._settleBeforeExtract(page);
    return await mw.candidates!.extract({
      page, jsProbe: true, maxElements: WIDER_ELEMENTS, widgets: true,
      quotas: WIDE_QUOTAS, candidatePriority: "bucketed", hosts: hosts ?? undefined,
    });
  } catch {
    return null;
  }
}

/**
 * 宽池重编号后的禁选平移：ref 是位置键，抽池重扫后同一 ref 指向的元素会换人——
 * 按元素签名（esig）在宽视图里重建禁选集合（与执行器 pruneForbids 同一认识论）。
 * 旧视图里已不存在的禁选 ref（更早换页的残留）无法平移，如实丢弃。
 */
export function carryForbidden(
  forbidden: Set<string>, oldPool: ElemPool, newPool: ElemPool,
): void {
  const sigs = new Set(
    [...forbidden]
      .filter((r) => oldPool[r] !== undefined)
      .map((r) => esig(oldPool[r] as Elem).join("\u0000")),
  );
  forbidden.clear();
  for (const [r, el] of Object.entries(newPool)) {
    if (sigs.has(esig(el).join("\u0000"))) forbidden.add(r);
  }
}

/** 模型投票一轮的结果：asked = 本轮真实咨询数（含宽扫重问）；pool = 最终视图（交接快照用）。 */
export type PilotVote =
  | { kind: "no_model_runtime"; asked: 0; pool: null }
  /**
   * `abstained` = 模型**显式弃权**（看过候选说都不行），缺省不出现 = 引擎侧没拿到可用选择。
   * 两者同落 low_confidence 交 Agent 兜底，但前者是可归因的负面证据（调计策树的输入）。
   */
  | { kind: "low_confidence"; asked: number; pool: ElemPool | null; abstained?: boolean }
  | {
    kind: "picked"; asked: number; pool: ElemPool; ref: string;
    conf: number; shape: string; via: "ask" | "reobserve";
  };

/** 阶梯入参（两条通道共用形状；`ask` 只由新路径消费）。 */
interface ModelVoteArgs {
  mw: BrowserMiddleware;
  page: AnyPage;
  goal: string;
  elems: ElemPool;
  forbidden: Set<string>;
  /** L2 上文注记（ref → 人读负面证据；null = 不注入，题面逐字节不变）。 */
  notes?: Record<string, string> | null;
  confFloor: number;
  hosts: string[] | null;
}

/**
 * 对照臂：模型投票阶梯（模型不在位 = 如实停，绝不装会抛的 runtime）。
 * 保留它的唯一目的是与 `modelVote` 做同场景双臂对照；新增行为不得只改这里。
 */
export async function modelVoteLegacy(a: ModelVoteArgs): Promise<PilotVote> {
  const { mw, page, goal, elems, forbidden, confFloor, hosts, notes } = a;
  await mw.ready();
  if (mw.rulesOnly) return { kind: "no_model_runtime", asked: 0, pool: null };
  // 候选窗剔除无角色聚合容器（零变化噪声；明细见 PilotLedger.filterAggregate）。
  const askBase = PilotLedger.filterAggregate(elems) ?? elems;
  let pool = askBase;
  let asked = 1;
  let proposal = await mw.pickProposal(goal, page, pool, forbidden, notes ?? null);
  if (proposal.choiceRef === null) {
    // 弃权与 run 的 abstain 判定同源（run 面弃权即停，不走宽扫）：直接交接。
    return { kind: "low_confidence", asked, pool: null };
  }
  let via: "ask" | "reobserve" = "ask";
  if (!passesFloor(proposal, confFloor)) {
    // 低置信回流（run 4d 同序，红线②「不提前弹人」）：gated 意见先付一次宽扫重问
    // （宽池真变大才重问；禁选集合按元素签名平移到宽视图）；仍不过闸才 low_confidence。
    const wideRaw = await widePool(mw, page, hosts);
    // 宽扫同样剔除聚合容器（宽度判定按剔除后的真实候选数，防"宽扫只多了噪声"）。
    const wide = wideRaw === null ? null : (PilotLedger.filterAggregate(wideRaw) ?? wideRaw);
    if (wide === null || Object.keys(wide).length <= Object.keys(pool).length) {
      return { kind: "low_confidence", asked, pool: null };
    }
    carryForbidden(forbidden, pool, wide);
    pool = wide;
    asked += 1;
    proposal = await mw.pickProposal(goal, page, pool, forbidden, notes ?? null);
    via = "reobserve";
    if (proposal.choiceRef === null || !passesFloor(proposal, confFloor)) {
      return { kind: "low_confidence", asked, pool };
    }
  }
  return {
    kind: "picked", asked, pool, ref: proposal.choiceRef as string,
    conf: proposal.entropyConf, shape: proposal.shape.kind, via,
  };
}

/**
 * 模型投票（执行路径）：委托 `PilotAskAdapter` → 引擎 `DecisionAsk`。
 * `ask` 由 pilot 运行时注入（唯一调用点已接线）；缺省退回对照臂，保证独立嵌入方不会因为
 * 少接线而静默换语义。回执映射保持 `PilotVote` 逐字段口径（conf = proposal.entropyConf）。
 */
export async function modelVote(a: ModelVoteArgs & { ask?: PilotAskAdapter }): Promise<PilotVote> {
  const { ask } = a;
  if (ask === undefined) return await modelVoteLegacy(a);
  const outcome = await ask.vote({ page: a.page, goal: a.goal, confFloor: a.confFloor });
  switch (outcome.kind) {
    case "no_model":
      return { kind: "no_model_runtime", asked: 0, pool: null };
    case "picked": {
      // S1 只接模型票分支（规则/升级票没有模型信号）：不冒充模型票，如实弃权交接。
      if (outcome.origin !== "model" || outcome.signal === null) {
        return { kind: "low_confidence", asked: outcome.asked, pool: outcome.executionPool };
      }
      return {
        kind: "picked", asked: outcome.asked, pool: outcome.executionPool, ref: outcome.target.ref,
        conf: outcome.signal.proposal.entropyConf, shape: outcome.signal.proposal.shape.kind, via: outcome.via,
      };
    }
    case "abstained": {
      const detail = outcome.reason.detail ?? "";
      return {
        kind: "low_confidence", asked: outcome.asked, pool: outcome.executionPool,
        ...(detail.startsWith("model-abstained") ? { abstained: true } : {}),
      };
    }
    case "limit":
      return { kind: "low_confidence", asked: outcome.asked, pool: null };
  }
}
