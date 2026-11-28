/**
 * DecisionProvider 接口契约（L0 叶子）：**类型唯一出处**，engine 只消费这里、model 实现。
 *
 * 为什么不放 `src/model/`：engine（L4）需要 `DecisionProvider` 类型来装配决策面，而
 * L4→L3 是登记为「只减不增」的反向边。类型下沉 L0 后 engine 不再 import model 的接口，
 * 实现（laya/服务/基线）仍在 `src/model/*`，装配仍在组合根。
 *
 * `ProviderModelState` 与 `model.ModelState` 是同一联合形状；L0 不能反向 import model，
 * 所以这里保留独立别名（provider 只声明「能收什么形状」，不依赖 model 的具体类型）。
 */
import type { PageLike } from "./page-like.ts";

export type ProviderModelState = string | Record<string, unknown> | unknown[];

/** 一个决策提供者的身份与能力声明。 */
export interface ProviderCapabilities {
  /** 能不能从枚举候选里选一个（几乎所有 provider 都能；不能的只能做打分）。 */
  choice: boolean;
  /** 有没有"这个动作是否不可逆"的头（laya 的 noul）。没有 ⇒ 执行器不该为它花一次前向。 */
  risk: boolean;
  /** 有没有"子目标是否已完成"的投票（advisory，永远不能单独判完成——红线③）。 */
  done: boolean;
  /** 支持不支持"先收窄再问"（laya 的 shortlist）。不支持的 provider，`narrow` 请求会被原样拒绝。 */
  shortlist: boolean;
  /**
   * `score` 这个数**该怎么读**：
   *   - `calibrated_prob`：就是概率（可跨 k 比的 max-prob / margin 都属此类）；
   *   - `entropy_conf`：`1 − H/log k` 这种归一化熵——**随选项数变形，跨桶不可比**（laya 出厂值）；
   *   - `rank_only`：只有名次，没有概率 ⇒ `pTop1/pTop2/margin` 必须为 null。
   */
  score_kind: "calibrated_prob" | "entropy_conf" | "rank_only";
  /**
   * DC4 上文能力档：该 provider **消费哪些上文层**（声明 ≠ 协议；只决定询问面怎么记回执）：
   *   - `none`    = 不消费分层上文（请求方无需装配，回执 L3/L4 记 unsupported）；
   *   - `minimal` = L0–L2（本地 laya 档：goal / 候选池 / 账本注记，受既有 token 单源约束）；
   *   - `full`    = L0–L4（决策服务档：另含 L3 计划叙事 / L4 站点知识）。
   * 缺省不声明 = 未声明（询问面不得据此推断"不支持"，按未声明处理）。**只声明能力**：
   * 本字段不改变任何 provider 的输入协议，也不把新字段塞进决策请求。
   */
  context?: "none" | "minimal" | "full";
  /**
   * 支持在决策请求里带结构化 `state_digest`（S5b；缺省/不声明 = 不支持）。
   * 只有观测面是**不透明包**的 provider（SystemOne 的 `state`）才能附加这个可选键；
   * 输入 schema 固定或协议严格的 provider（本地 laya-onnx、OpenAI Decisions 的 `input`）
   * 必须保持不声明——执行器会整段跳过并记 `context_skipped`，不把 JSON 硬塞进自然语言。
   */
  state_digest?: boolean;
}

export interface ProviderInfo {
  name: string;
  version: string;
  capabilities: ProviderCapabilities;
  /**
   * provider 自报的**闸门刻度**（可选）：它的 `score` 落在哪个值以上才算"够把握"。
   * 为什么必须由 provider 说：闸门比的是 `score`，而 `score_kind` 不同的两支不可比
   * （laya 的归一化熵 vs 在线服务的标定概率）——同一个数在两种刻度上不是同一件事。
   * 缺省不声明 = 用全局缺省 `DEFAULT_CONF_FLOOR`（单源，缺省值以它为准）。优先级：CLI > pack.policy > 本字段 > 全局缺省。
   */
  floor?: number;
}

/** provider 需要读页面（渲染视图、取 URL/标题）；执行器传的是它自己那个 page。 */
export type ProviderPage = PageLike & { title(): Promise<string> };

/**
 * 一次"选元素"的请求。`narrow` 是收窄后的候选（窄问），null = 全池。
 *
 * S5b：`state_digest` 是**结构化**状态摘要（≤200B；只有 `capabilities.state_digest === true`
 * 的 provider 会收到）。形状写在这里而不是从执行器 import，避免 model ← engine 的反向依赖；
 * 结构是封闭的五键，字段语义见 execution 层 `StateDigest` 与 schema F25。
 */
export interface StateDigestPayload {
  nav_epoch_delta: number;
  last_effect?: { kind: string; applied: boolean };
  settled: boolean;
  pool_changed: boolean;
  flags?: string[];
}

export interface ChoiceRequest {
  goal: string;
  page: ProviderPage;
  /** 元素池（provider 自己决定怎么渲染成它的视图）。 */
  elems: Record<string, { tag: string; label: string; data_test?: string; [k: string]: unknown }>;
  forbidden: Set<string>;
  notes: Record<string, string> | null;
  narrow: string[] | null;
  /** 短名单粒度（laya 用 8）。provider 可以忽略它，但忽略时要说。 */
  k: number;
  /**
   * S5b：可选的 ≤200B **结构化**状态摘要（`meta.policy.decision_state.context: "delta"`；
   * 只有 `capabilities.state_digest === true` 的 provider 会收到这个键）。缺省不出现
   * ⇒ 默认档的请求体逐字节不变。它只带观测事实（导航代数差 / 最近 effect / 是否静默 /
   * 池是否变化 / flags），**不是建议、更不是动作**——模型仍只在一组 ref 里投票。
   */
  state_digest?: StateDigestPayload;
}

/** 一次"选元素"的完整结果：选择 + 所有可用信号 + 这次问的是什么形状。 */
export interface ChoiceOutcome {
  /** `undefined` = 答了但没可用元素；`null` = 没答/没得选。两者语义不同，不许归一。 */
  ref: string | null | undefined;
  /** provider 自己那个"把握"数，含义由 `info.capabilities.score_kind` 解释。 */
  score: number;
  scoreKind: ProviderCapabilities["score_kind"];
  /** 与选项数无关的信号；provider 给不出时**必须是 null**（不是 0）。 */
  signals: { pTop1: number | null; pTop2: number | null; margin: number | null };
  /** 这次实际问了多少个选项——分档要按它，不是按池子大小。 */
  options: number;
  /** 是否发生了"重问子集"（laya 的 shortlist 分支）。 */
  passthrough: boolean;
  /** 原始分布（诊断用；闸门不该依赖它的存在）。 */
  probs: Record<string, number>;
  /**
   * 证据截断记账（**可选**）：provider 若裁剪过模型看到的证据，必须如实报告裁剪面与规模。
   * 缺省不出现 = 没裁剪，或该 provider 不做这条记账——两种 provider 的既有字段/语义不变。
   * 尺寸口径见 `EvidenceTruncationFact`：`dropped_chars` 是字符预算裁剪、`dropped_tokens`
   * 是 token 安全网兜底，两者互不重叠。
   */
  evidence_truncated?: EvidenceTruncation;
  /**
   * **显式弃权**（可选；缺省不出现 = 模型没弃权）。
   *
   * 与 `ref: null` 的差别是承重的，两者**不得归一**：
   *   - `ref: null` = 这次没拿到可用选择（候选为空 / 答复在池外被判无效 / 没答）——
   *     这是**引擎侧的事实**，模型并没有对页面发表意见；
   *   - `abstained: true` = 模型**看了候选并明确表示「这些都不是下一步」**——
   *     这是**模型侧的判断**，是可归因的负面证据。
   *
   * 为什么必须分开：两者都会落到 `low_confidence` 停因交 Agent 兜底，但只有后者能回答
   * 「模型看着 N 个候选说不行」，是调计策树的输入；前者只说明「题没问出结果」。
   * provider 只有声明能力后才需要填它——不填的 provider 语义逐字节不变。
   */
  abstained?: boolean;
}

/** 一个证据面的裁剪事实：字符级预算裁剪与 token 安全网分开记，互不重叠。 */
export interface EvidenceTruncationFact {
  /** 该面是否发生任何裁剪（字符级预算裁剪或 token 安全网）。 */
  truncated: boolean;
  /** 字符级预算裁剪丢弃的字符数（不切断代理对）。 */
  dropped_chars: number;
  /** 字符级预算裁剪后仍超名额时，token 安全网丢弃的 token 数。 */
  dropped_tokens: number;
}

/**
 * 一次决策请求里的证据截断记账。三个证据面与 laya 序列布局一一对应：
 * `head` = 题面指令，`options` = 各选项渲染文本之和，`state` = 状态正文。
 * 各面数字是本次请求内受影响题目的**最大单题规模**（同一批前向可能问多题）。
 */
export interface EvidenceTruncation {
  state: EvidenceTruncationFact;
  head: EvidenceTruncationFact;
  options: EvidenceTruncationFact;
  /** 发生裁剪的题号（按提问顺序；空数组不在正常路径出现——无裁剪时不填该字段）。 */
  questions: string[];
}

/**
 * 一次"闭集选择"请求（S2 ③ 提名梯级的模型窄问形状）：**不依赖页面元素池**——
 * 选项与题面都由调用方给。与 `pick` 的区别就在这：pick 的选项来自页面池，askChoice 的选项
 * 是调用方声明的闭集（如指令闭集）。
 */
export interface ClosedSetRequest {
  /** 题面里的目标（通常是这一步的自然语言描述）。 */
  goal: string;
  /** 给模型的指令。措辞影响行为——由调用方提供它测过的那一版，不在 provider 里硬编码。 */
  instructions: string;
  /** 闭集选项：ref → 描述。返回值保证在池内（池外答案一律当没答）。 */
  criteria: Record<string, string>;
  /** 可选：额外的 state 字段（运行期提名器可以把当次页面状态带上；缺省只有 goal）。 */
  state?: Record<string, unknown>;
}

/** 闭集选择结果。`ref` 已做闭集校验（池外 → null）。 */
export interface ClosedSetChoice {
  ref: string | null;
  /** 把握数，含义由 `ProviderCapabilities.score_kind` 解释。 */
  score: number;
  scoreKind: ProviderCapabilities["score_kind"];
  probs: Record<string, number>;
}

/** 一个决策提供者。`pick` 是必须的，其余按能力声明。 */
export interface DecisionProvider extends ProviderInfo {
  pick(req: ChoiceRequest): Promise<ChoiceOutcome>;
  /**
   * 能力：对**调用方给定的闭集**做一次 choice（S2 ③ 提名）。
   * 不实现 = 该 provider 不能做提名窄问；梯级按"③ 弃权"往下走（fail closed，不猜）。
   * 实现方必须自己保证返回的 ref 在 `criteria` 内（池外答案 → null）。
   */
  askChoice?(req: ClosedSetRequest): Promise<ClosedSetChoice | null>;
  /** `capabilities.risk` 为真时才会被调用。返回 `[0,1]` 的风险概率。 */
  risk?(goal: string, actionDesc: string): Promise<number>;
  /** `capabilities.done` 为真时才会被调用。永远只是参考（红线③）。 */
  doneVote?(goal: string, state: ProviderModelState): Promise<number>;
  /**
   * 这个服务是否**已配置到可用**（缺凭据/端点等）。返回一句指路串 = 未配置；返回 null = 就绪。
   * 解析时（`resolveProviderSpec`）用它区分：显式点名却没配 ⇒ 响亮报错；
   * 环境默认却没配 ⇒ 干净落到 rules-only（不装一个每步都抛的 provider）。
   * 不实现 = 视为已配置（本地基线、有默认端点的服务）。
   */
  configError?(): string | null;
  /** 释放权重/连接。可选。 */
  close?(): void | Promise<void>;
}

/* ── 注册表 ─────────────────────────────────────────────────────────────── */

export type ProviderFactory = () => DecisionProvider | Promise<DecisionProvider>;
