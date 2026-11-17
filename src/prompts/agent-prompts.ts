/**
 * `src/prompts/agent-prompts.ts` —— **Agent 规划面提示词的唯一出处**。
 *
 * 收口对象：`PlanningRules.promptText()`（原 `src/engine/plan.ts` 内联，默认 1,433 字符）。
 * 该文本是 Agent 写计划时看到的「硬约束」题面；本模块把它收成一条 PromptSpec
 * （id `plan.rules`，role `agent`），plan.ts 只做参数装配与委托。
 *
 * 纪律：
 *   - **叶模块**：零运行时依赖（不 import model/engine/support），可被 CLI、工具与
 *     离线门禁同时 import；hint 形状行、信号算子行由调用方注入（真源仍在
 *     `src/engine/grammar-prompt.ts`，本模块不复制词表）。
 *   - **逐字节冻结**：文本与收口前 `promptText()` 输出逐字节一致（prompt-hit agent 组
 *     与 /tmp 基线 sha256 对照）；要改措辞 = 改行为，须同时刷新快照并重审。
 *   - **预算**：默认 1,433 字符、加 requireStartUrl + forbidden 词后 1,518 字符；预算取
 *     1,600（含余量）。超预算 = prompt-hit agent 组红。
 */

/** `plan.rules` 的构建上下文：全部来自 `PlanningRules` 的构造参数 + 两个词表注入。 */
export interface PlanRulesPromptCtx {
  /** 最大 subgoal 数（`PlanningRules` 构造参数 1）。 */
  readonly maxSubgoals: number;
  /** 是否要求每个 subgoal 显式 start_url（构造参数 3）。 */
  readonly requireStartUrl: boolean;
  /** 描述里禁用的词（构造参数 4；调用方已归一为小写）。 */
  readonly forbiddenWords: readonly string[];
  /** hint 形状行（`grammar-prompt.hintPromptTokens()` 的输出，唯一真源在 grammar-prompt）。 */
  readonly hintTokens: string;
  /** 信号算子行（`grammar-prompt.signalPromptLines()` 的输出，唯一真源在 grammar-prompt）。 */
  readonly signalOpLines: readonly string[];
}

/** Agent 侧 PromptSpec 的最小形状（与 model-prompts.PromptSpec 同构，不跨层 import）。 */
export interface AgentPromptSpec {
  readonly id: "plan.rules";
  /** 契约版本：输出契约或语义变更才 +1。 */
  readonly version: number;
  readonly role: "agent";
  readonly lang: "en";
  /** 默认上下文渲染后的字符预算；超预算即 prompt-hit agent 组红。 */
  readonly budget: { readonly maxChars: number };
  /** 消费点（仓内文件路径）：model 组同款白名单，agent 组断言文件存在且不再手抄题面。 */
  readonly consumers: readonly string[];
  /** 输出契约关键句：渲染结果必须逐字包含（题面结构不得悄悄消失）。 */
  readonly contract: { readonly mustInclude: readonly string[] };
}

/** `plan.rules` 的元数据（prompt-hit agent 组校验的唯一来源）。 */
export const PLAN_RULES_SPEC: AgentPromptSpec = {
  id: "plan.rules",
  version: 1,
  role: "agent",
  lang: "en",
  budget: { maxChars: 1600 },
  consumers: ["src/engine/plan.ts"],
  contract: {
    mustInclude: [
      "Planning rules (hard constraints):",
      'add "target_hint" naming the element the',
      "- every subgoal MUST carry a done-signal, one of:",
    ],
  },
};

/** 全部 Agent prompt spec（当前闭集 1 条；新增题面 = 新 spec）。 */
export const AGENT_PROMPT_SPECS: readonly AgentPromptSpec[] = [PLAN_RULES_SPEC];

/**
 * 构建 `plan.rules` 题面：与收口前 `PlanningRules.promptText()` **逐字节一致**。
 *
 * 注意：`requireSignal` / `requireHint` 两个构造参数在既有题面里不参与（只影响
 * `problems()` 校验），这里同样不接收——不发明新行为。
 */
export function buildPlanRulesPrompt(ctx: PlanRulesPromptCtx): string {
  const lines = [
    "Planning rules (hard constraints):",
    `- at most ${ctx.maxSubgoals} subgoals, ordered, each independently verifiable`,
    '- when the page elements are given, add "target_hint" naming the element the',
    `  subgoal drives: ${ctx.hintTokens}. It is resolved by rule at zero model`,
    "  cost; omit it only when the target is genuinely ambiguous in the snapshot",
    "- every subgoal MUST carry a done-signal, one of:",
    ...ctx.signalOpLines.map((l) => `    ${l}`),
  ];
  if (ctx.requireStartUrl) lines.push("- every subgoal needs an explicit start_url");
  if (ctx.forbiddenWords.length) {
    lines.push(`- forbidden in descriptions: ${ctx.forbiddenWords.join(", ")}`);
  }
  return lines.join("\n") + "\n";
}
