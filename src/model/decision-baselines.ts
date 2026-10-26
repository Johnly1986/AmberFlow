/**
 * **基线决策提供者**（`src/model/decision-baselines.ts`）——不是"另一个模型"，是**尺子**。
 *
 * 为什么要专门写三个不像模型的 provider：抽象这个东西，只有拿**不是原本形状**的实现去套，
 * 才知道套不套得住。这三个都不 import 任何 laya 类型、都不加载权重：
 *
 * | provider | 行为 | 它用来测什么 |
 * |---|---|---|
 * | `first-candidate` | 永远选扫描顺序里第一个未禁候选，只有名次没有概率 | `rank_only` 路径：闸门/报告**不许**把"没有概率"读成"零把握" |
 * | `coin-flip` | 在候选里均匀随机（**可复现**：种子 = goal + 候选指纹） | 模型的**下界**：任何决策模型打不过它，就不值得留在关键路径上 |
 * | `always-abstain` | 永远不选（`ref = null`） | 兜底缺席时会发生什么：block 路径、梯级账单、退出码——不靠"关掉模型"这种副作用来测 |
 *
 * 第三个尤其重要：以前要测"没有模型兜底"只能跑 `--ablate rules-only`，那同时改变了
 * 好几件事（不装 runtime、风险头、完成投票）。`always-abstain` 只改一件事。
 *
 * 注册在 `registerBaselines()`（幂等）。用 `--provider coin-flip` 选中（仅实验/对照，
 * 不写进配置），见 `applyDecisionSelection`。
 */
import {
  registerDecisionProvider, type ChoiceOutcome, type ChoiceRequest, type DecisionProvider,
} from "./decision-provider.ts";

/** 可复现的小哈希（FNV-1a）：同一 (goal, 候选集) 永远给同一个"随机"选择。 */
function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const openRefs = (req: ChoiceRequest): string[] => {
  const pool = req.narrow ?? Object.keys(req.elems);
  return pool.filter((r) => !req.forbidden.has(r) && req.elems[r] !== undefined);
};

/** 只有名次：`signals` 一律 null（**不是 0**——那是契约里最要紧的一条）。 */
export function firstCandidateProvider(): DecisionProvider {
  return {
    name: "first-candidate", version: "1",
    capabilities: { choice: true, risk: false, done: false, shortlist: false, score_kind: "rank_only" },
    async pick(req: ChoiceRequest): Promise<ChoiceOutcome> {
      const refs = openRefs(req);
      const ref = refs[0] ?? null;
      return {
        ref, score: ref === null ? 0 : 1, scoreKind: "rank_only",
        signals: { pTop1: null, pTop2: null, margin: null },
        options: refs.length, passthrough: true, probs: {},
      };
    },
  };
}

/** 均匀随机，可复现。有概率（所以是 `calibrated_prob`），但那些概率是**真**均匀的。 */
export function coinFlipProvider(): DecisionProvider {
  return {
    name: "coin-flip", version: "1",
    capabilities: { choice: true, risk: false, done: false, shortlist: false, score_kind: "calibrated_prob" },
    async pick(req: ChoiceRequest): Promise<ChoiceOutcome> {
      const refs = openRefs(req);
      if (!refs.length) {
        return { ref: null, score: 0, scoreKind: "calibrated_prob",
          signals: { pTop1: null, pTop2: null, margin: null }, options: 0, passthrough: true, probs: {} };
      }
      const sorted = [...refs].sort();
      const pick = sorted[seedOf(`${req.goal}|${sorted.join(",")}`) % sorted.length]!;
      const p = 1 / refs.length;
      return {
        ref: pick, score: p, scoreKind: "calibrated_prob",
        signals: { pTop1: p, pTop2: refs.length > 1 ? p : null, margin: refs.length > 1 ? 0 : null },
        options: refs.length, passthrough: true,
        probs: Object.fromEntries(refs.map((r) => [r, p])),
      };
    },
  };
}

/** 永远弃权：测"兜底不存在"这一件事，其它都不动。 */
export function alwaysAbstainProvider(): DecisionProvider {
  return {
    name: "always-abstain", version: "1",
    capabilities: { choice: true, risk: false, done: false, shortlist: false, score_kind: "rank_only" },
    async pick(req: ChoiceRequest): Promise<ChoiceOutcome> {
      const refs = openRefs(req);
      return { ref: null, score: 0, scoreKind: "rank_only",
        signals: { pTop1: null, pTop2: null, margin: null },
        options: refs.length, passthrough: true, probs: {} };
    },
  };
}

/** 基线名字（CLI 的补全/校验用这一份，别在别处再列一遍）。 */
export const BASELINE_PROVIDERS = ["first-candidate", "coin-flip", "always-abstain"] as const;

let registered = false;
export function registerBaselines(): void {
  if (registered) return;
  registered = true;
  registerDecisionProvider("first-candidate", firstCandidateProvider);
  registerDecisionProvider("coin-flip", coinFlipProvider);
  registerDecisionProvider("always-abstain", alwaysAbstainProvider);
}
