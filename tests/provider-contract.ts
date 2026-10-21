/**
 * **provider 契约**（tests/provider-contract.ts）——任何决策提供者都必须满足的四条。
 * 从 `tests/decision-provider.test.ts` 抽出来是为了给第二个 provider（JevK5）复用同一份契约，
 * 而不是每人一套松紧：抽象的判据是"同一份考卷"。
 */
import { expect, it } from "vitest";
import type { ChoiceRequest, ChoiceOutcome, DecisionProvider } from "../src/model/decision-provider.ts";

/** 由调用方给的页面夹具（契约本身不关心页面从哪来）。 */
export type PageOf = () => ChoiceRequest["page"];
export type PoolOf = () => ChoiceRequest["elems"];

export function providerContract(name: string, make: () => DecisionProvider, pageOf: PageOf, poolOf: PoolOf): void {
  it(`${name}：声明了能力，且 score_kind 与 signals 一致`, async () => {
    const p = make();
    expect(p.name).toBeTruthy();
    expect(p.version).toBeTruthy();
    expect(typeof p.capabilities.choice).toBe("boolean");
    const out: ChoiceOutcome = await p.pick({
      goal: "add to cart", page: pageOf(), elems: poolOf(),
      forbidden: new Set(), notes: null, narrow: null, k: 8,
    });
    expect(out.scoreKind).toBe(p.capabilities.score_kind);
    if (p.capabilities.score_kind === "rank_only") {
      // 只有名次的 provider：**必须**是 null。写成 0 就是"不给概率"冒充"没把握"。
      expect(out.signals.pTop1).toBeNull();
      expect(out.signals.pTop2).toBeNull();
      expect(out.signals.margin).toBeNull();
    }
    expect(Number.isFinite(out.score)).toBe(true);
    expect(out.options).toBeGreaterThanOrEqual(0);
    if (!p.capabilities.risk) expect(p.risk).toBeUndefined();
    if (!p.capabilities.done) expect(p.doneVote).toBeUndefined();
  });

  it(`${name}：没有候选时返回 null 而不是瞎选`, async () => {
    const p = make();
    const out = await p.pick({
      goal: "g", page: pageOf(), elems: poolOf(),
      forbidden: new Set(Object.keys(poolOf())), notes: null, narrow: null, k: 8,
    });
    expect(out.ref).toBeNull();
  });
}
