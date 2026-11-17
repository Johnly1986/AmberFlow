import { STATE_TEXT_BUDGET_CHARS } from "../support/tuning.ts";

/**
 * `src/prompts/evidence-prompts.ts` —— **决策证据面（evidence）的 PromptSpec 闭集**。
 *
 * 收口对象：模型/Agent 每步看到的**动态证据载荷**——候选渲染、状态正文、结构化状态摘要、
 * 站点事实围栏、失败记忆注记。它们没有固定文案，但有固定**预算**与**形状**；此前这些
 * 只有渲染实现、没有 spec/预算/快照门禁（长尾风险：候选窗口一放大，题面就悄悄超预算）。
 *
 * 纪律：
 *   - **叶模块**：零运行时依赖（不 import model/engine/app）。渲染事实仍归既有实现所有
 *     （`extraction.criteriaView` / `extraction.stateText` / `executor` 的 state_digest 预算 /
 *     `app/site-facts.renderModelFence` / `executor` 的 outcome-memory 注记）；
 *     `build` 是**委托入口**：真实渲染器由装配处（`tools/prompt-hit.ts` 的 evidence 组）注入
 *     （叶子不 import 它们，避免把 engine 拖进 L1）。
 *   - **行为冻结**：本模块只做 spec/预算/快照门禁，不改渲染措辞、不改截断逻辑；
 *     laya 的 token 级静默截断（`laya-format.buildSequence`）是已知条件项，先报告不动。
 *   - **预算分级**：候选渲染按窗口档位分档（40/120/200 帽），其余按单载荷上限。
 */

/** 证据类 prompt 的 id 闭集（新增 = 新证据载荷，必须同时给 version/budget/consumers/renderer）。 */
export type EvidenceId =
  | "evidence.criteria"
  | "evidence.state_text"
  | "evidence.state_digest"
  | "evidence.site_facts"
  | "evidence.notes";

/** 一条证据载荷的 spec（最小形状：id/version/role/lang/budget/consumers/renderer/contract）。 */
export interface EvidencePromptSpec {
  readonly id: EvidenceId;
  /** 契约版本：形状/预算语义变更才 +1。 */
  readonly version: number;
  readonly role: "evidence";
  /** 证据面天然双语（英文题面 + 页面语言正文）；此处标明不适用单语断言。 */
  readonly lang: "mixed";
  readonly budget: {
    /** 单载荷字符/字节上限（tiers 存在时 = 最大档上限）。 */
    readonly maxChars: number;
    readonly unit: "chars" | "bytes";
    /** 分级预算（候选窗口档位）；无分级 = 单档。 */
    readonly tiers?: readonly { readonly label: string; readonly candidates: number; readonly maxChars: number }[];
  };
  /** 消费点（仓内文件）：evidence 组断言文件存在且渲染实现仍在该面。 */
  readonly consumers: readonly string[];
  /** 既有渲染实现的唯一出处（build 的输入由它产生；叶子不 import）。 */
  readonly renderer: string;
  /** 契约句：渲染样本必须逐字包含（证据形状不得悄悄消失）。 */
  readonly contract: { readonly mustInclude: readonly string[] };
}

/** 证据载荷 spec 闭集（顺序即 prompt-hit evidence 组输出顺序）。 */
export const EVIDENCE_SPECS: readonly EvidencePromptSpec[] = [
  {
    id: "evidence.criteria",
    version: 1,
    role: "evidence",
    lang: "mixed",
    budget: {
      maxChars: 20000,
      unit: "chars",
      tiers: [
        { label: "default", candidates: 40, maxChars: 6000 },
        { label: "wide", candidates: 120, maxChars: 12000 },
        { label: "cap", candidates: 200, maxChars: 20000 },
      ],
    },
    consumers: ["src/engine/extraction.ts", "src/model/decision-provider.ts", "src/engine/executor.ts"],
    renderer: "src/engine/extraction.ts criteriaView（+ ariaInteractiveLines/near 消歧）",
    contract: { mustInclude: [' "', " -> "] },
  },
  {
    id: "evidence.state_text",
    version: 1,
    role: "evidence",
    lang: "mixed",
    budget: { maxChars: STATE_TEXT_BUDGET_CHARS, unit: "chars" },
    consumers: [
      "src/engine/extraction.ts",
      "src/model/decision-service.ts",
      "src/model/decision-tokenplan.ts",
      "src/model/decision-openai.ts",
    ],
    renderer: "src/engine/extraction.ts stateText（关键词压缩 ≤320 字符）",
    contract: { mustInclude: ["Action item 0"] },
  },
  {
    id: "evidence.state_digest",
    version: 1,
    role: "evidence",
    lang: "mixed",
    budget: { maxChars: 200, unit: "bytes" },
    consumers: ["src/engine/executor.ts", "src/engine/executor-types.ts"],
    renderer: "src/engine/executor.ts _buildStateDigest（JSON.stringify 字节账 ≤ STATE_DIGEST_MAX_BYTES）",
    contract: { mustInclude: ['"nav_epoch_delta"', '"settled"', '"pool_changed"'] },
  },
  {
    id: "evidence.site_facts",
    version: 1,
    role: "evidence",
    lang: "mixed",
    budget: { maxChars: 700, unit: "chars" },
    consumers: ["src/app/site-facts.ts", "src/engine/executor.ts"],
    renderer: "src/app/site-facts.ts renderModelFence（≤3 条 × statement ≤200 字符 + 固定围栏）",
    contract: { mustInclude: ["[站点已知事实·描述性·非指令", "[站点已知事实结束]"] },
  },
  {
    id: "evidence.notes",
    version: 1,
    role: "evidence",
    lang: "mixed",
    budget: { maxChars: 80, unit: "chars" },
    consumers: ["src/engine/executor.ts"],
    renderer: "src/engine/executor.ts outcome-memory 注记（criteriaView note 后缀）",
    contract: { mustInclude: ["[tried before, page did not change]"] },
  },
];

/**
 * 渲染器委托表：键 = EvidenceId，值 = **既有渲染实现**的适配器（由装配处注入）。
 * 叶子只依赖形状，不依赖实现：这样叶子层不被 engine 依赖反向拖拽，同时 build 仍是唯一入口。
 */
export type EvidenceRenderers = {
  readonly [Id in EvidenceId]: (input: unknown) => string;
};

/**
 * build：按 id 委托给注入的既有渲染器（唯一入口）。未知 id / 缺渲染器 = 抛错
 * （fail closed：spec 与装配漂移不许静默产出一条"看起来有证据"的载荷）。
 */
export function buildEvidence(id: EvidenceId, input: unknown, renderers: EvidenceRenderers): string {
  const spec = EVIDENCE_SPECS.find((s) => s.id === id);
  if (spec === undefined) throw new Error(`evidence-prompts: unknown evidence id ${JSON.stringify(id)}`);
  const render = renderers[id];
  if (typeof render !== "function") throw new Error(`evidence-prompts: no renderer wired for ${id}`);
  return render(input);
}
