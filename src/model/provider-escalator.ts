/**
 * **Escalation 梯级的 provider 适配器**——低置信恢复的最后一级（C3-R deliberative path）。
 *
 * 前身是 `src/engine/planner.ts` 的 `llmEscalator`：一条直读 `OPENAI_*`、硬编码
 * OpenAI `/chat/completions` 协议的裸 chat 调用，与执行侧的 provider 缝（capabilities /
 * `score_kind` / 咨询计数 / 审计）完全脱节；且从未被接线（全仓没有 `escalateFn`
 * 的构造点）。BACKLOG #1 的落点：梯级经 `DecisionProvider.askChoice`（闭集窄问，
 * 池外答案 → null）进执行侧同一条缝——
 *   - 决策源由 `resolveProviderSpec` / `applySpecToRuntime` 唯一解析（三件套 / 本地
 *     laya / `--provider`），escalation 服从同一个覆盖，不再有第二个配置面；
 *   - 闭集校验是**双层**的：provider 实现方保证返回 ref 在 criteria 内，执行器
 *     （`executor.ts` 的 escalation 分支）还会再验一次——fail-closed 语义不变；
 *   - 咨询计数由 `countedProvider` 记账（`askChoice` 也算一次真咨询）。
 *
 * 前提（2026-11）：**规划归 Agent**——引擎内不再有 LLM 规划/重规划面。escalation 是
 * **步级决策**（在已有候选里点名一个 ref，不发明元素/值/动作，不提案步骤），所以它
 * 保留并走 provider 缝，而不是跟规划一起被摘除。
 */
import type { EscalatorLike } from "../engine/executor.ts";
import { decisionProviderOrNull, type ClosedSetRequest } from "./decision-provider.ts";

/**
 * 梯级题面：原 `llmEscalator` system 提示词的语义核心逐字保留（可比性）；末尾
 * "Reply ONLY with JSON" 一句**有意不保留**——choice 题的输出契约现在归 provider
 * 协议层所有（SystemOne / laya / OpenAI-decisions 各自定义），题面再硬编码格式
 * 会跟协议层打架。
 */
export const ESCALATOR_INSTRUCTIONS =
  "You are a stronger reasoner consulted by a browser-automation harness when its local "
  + "decision model is unsure. You are given the same candidate elements the local model "
  + "saw, and they ALREADY EXIST on the page. Choose the single element that best advances "
  + "the goal. You may NOT invent elements, values or actions, and you may not propose "
  + "steps. If none of the candidates advances the goal, answer none.";

/**
 * 从**当前已装**的决策源构造 escalation 梯级。
 *
 * 返回 `null` = 梯级缺席：没有装 provider，或该 provider 不支持 `askChoice` 闭集窄问。
 * 调用方按"没有更强推理者在场"处理（低置信步照原样阻塞），**必须把缺席说出口**，
 * 不许悄悄降级成一个每步都抛错的梯级。
 */
export function providerEscalator(): EscalatorLike | null {
  const p = decisionProviderOrNull();
  if (!p || typeof p.askChoice !== "function") return null;
  const ask = p.askChoice.bind(p);
  return async (req) => {
    const closed: ClosedSetRequest = {
      goal: req.instruction,
      instructions: ESCALATOR_INSTRUCTIONS,
      criteria: req.criteria,
      state: { url: req.url, title: req.title, main_text: req.main_text, why: req.why },
    };
    let res;
    try {
      res = await ask(closed);
    } catch {
      return null;                       // fail closed：梯级异常 = 弃权，绝不猜
    }
    if (!res) return null;               // 没答（协议层已做闭集校验）
    // 双保险：provider 声称 ref 在池内，这里仍以调用方给的 criteria 为准再验一次。
    return typeof res.ref === "string" && req.criteria[res.ref] !== undefined ? res.ref : null;
  };
}
