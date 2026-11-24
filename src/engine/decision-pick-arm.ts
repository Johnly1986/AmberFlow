/**
 * 选择段执行臂：默认走统一入口 `decision-pick-unified.ts`；`AMBERFLOW_DECISION_LADDER=phase`
 * 切到 `decision-pick-phase.ts` 的旧编排作 A/B 对照（一版后退役）。
 *
 * 只做装配 + 分派：两臂共用 `createRunPickWiring` 的 (host, ctx) 形状，返回 `ModelPickPhase`
 * 不变；环境变量只用于本地 A/B lane，不进入任何产物。
 */
import { readString } from "../support/env.ts";
import type { BrowserMiddleware, ModelPickPhase } from "./executor.ts";
import type { RunPickArgs } from "./decision-pick-host.ts";
import { createRunPickWiring } from "./decision-pick-host.ts";
import { runDecisionPick } from "./decision-pick-phase.ts";
import { runDecisionPickUnified } from "./decision-pick-unified.ts";

/** 执行一次选择段（默认统一入口；`phase` = 对照臂）。 */
export async function runPickPhase(mw: BrowserMiddleware, a: RunPickArgs): Promise<ModelPickPhase> {
  const [host, ctx] = createRunPickWiring(mw, a);
  return readString("AMBERFLOW_DECISION_LADDER") === "phase"
    ? await runDecisionPick(host, ctx)
    : await runDecisionPickUnified(host, ctx);
}
