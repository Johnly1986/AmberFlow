/**
 * 执行器**装配面**类型（`BrowserSession` / `MiddlewareOptions`）——纯类型，无运行时。
 *
 * 为什么单独一个文件：这两组类型是各入口装配执行器时唯一要看的契约（工厂
 * `middleware-factory.ts` 只接收 `MiddlewareOptions`），与执行期产物类型（`RunReport` /
 * `StepStateRecord` 等）分开后，改装配面不必触碰产物面，反之亦然。`executor-types.ts`
 * 保 facade re-export，既有 `from ".../executor-types.ts"` 的调用点零改动。
 *
 * 本文件只允许 `import type`：它被 facade 以 `export *` 反向依赖，值 import 会造运行期环。
 */
import type { Auditor } from "./audit.ts";
import type { DecisionAgent, RouterLike } from "../model/model.ts";
import type { AmbiguousOrdering } from "./ambiguity.ts";
import type { DatasetReader } from "./dataset.ts";
import type { AttrValueMatch } from "./rules.ts";
import type { SurfacePolicy } from "./surface.ts";
import type { CandidateProducer } from "./candidate-contract.ts";
import type {
  AnyPage, BrowserHandle, DecisionStatePolicy, EscalatorLike, HintMemoryLike,
  OutcomeMemoryLike, PwLike,
} from "./executor-types.ts";

export interface BrowserSession {
  pw: PwLike;
  browser: BrowserHandle;
  page: AnyPage;
  close(): Promise<void>;
  /**
   * task-21/D-1：本次会话的浏览器事实（env.browser 一等证据；只增字段）。
   * binary_basename = 实际启动的 chromium 变体（chrome vs chrome-headless-shell——渲染退化
   * 判定的第一块事实）；headless = 是否无头；persistent_profile = 是否持久化 profile。
   * 缺省不出现 = 会话不是本进程 browserSession() 创建的（sessionFactory 注入等）。
   */
  envBrowser?: { binary_basename: string; headless: boolean; persistent_profile: boolean };
}

export interface MiddlewareOptions {
  /** String -> `runtime.load(modelId)`; a DecisionAgent is used as-is. */
  modelId?: string | DecisionAgent;
  auditor?: Auditor;
  maxSteps?: number;
  confFloor?: number;
  riskyThreshold?: number;
  doneThreshold?: number;
  confirmFn?: (desc: string) => boolean | Promise<boolean>;
  /** Human oracle for `{manual: true}` subgoals (see RunOptions.manualGoal). */
  manualConfirmFn?: ((desc: string, stateExcerpt: string) => boolean | Promise<boolean>) | null;
  /**
   * 两次实际动作之间的最小等待（毫秒）；0/缺省 = 今天的行为。由应用配置表的
   * `pace.between_actions_ms` 传入——给需要降载的站点用，不是反爬对抗。
   */
  actionDelayMs?: number;
  /** See RunOptions.reobserve (default ON). */
  reobserve?: boolean;
  /** See RunOptions.escalateFn (default: none — the local model is the last word). */
  escalateFn?: EscalatorLike | null;
  /** See RunOptions.outcomeMemory (default: none — each run starts blind). */
  outcomeMemory?: OutcomeMemoryLike | null;
  /** See RunOptions.outcomeMemoryMode (default "forbid"). */
  outcomeMemoryMode?: "forbid" | "rank";
  /** BACKLOG #2：候选生产者 seam（缺省 null = 引擎默认实现 createEngineCandidateProducer）。 */
  candidateProducer?: CandidateProducer | null;
  /** See RunOptions.hintMemory (default: none — only authored hints are used). */
  hintMemory?: HintMemoryLike | null;
  gotoTimeout?: number;
  routeModels?: boolean;
  router?: RouterLike | null;
  /** Constructor-level default for `RunOptions.hosts` (the navigation envelope). */
  hosts?: string[] | null;
  /**
   * Constructor-level default for `RunOptions.dataset`（NL Flow S1 注入面的旅程级形态）：
   * 一整个旅程共用一个数据集时由构造方给；run 级 opts.dataset 仍可覆盖。
   * 不声明 dataset 绑定的计划：行为逐字节不变。
   */
  dataset?: DatasetReader | null;
  /**
   * D3/R-4：同一个元素（按**元素签名**，不是位置性 ref）在**一个子目标内**最多被有效执行几次。
   *
   * 为什么需要这个上界：`inert` 是整页快照比对，页面上有个倒计时/轮播/广告计时器时它
   * **永远不成立**（前/后两次采样之间页面必然变了），于是"这个元素没用了"的证据链断掉，
   * anti-repeat 不触发，同一个死按钮被反复点，最后报告把病因写成 `max_steps`——
   * 一个噪声信号不该是循环唯一的终止依据（重审 D3）。缺省 3；0 = 关闭（回到今天的行为）。
   */
  maxEffectiveRepeats?: number;
  /**
   * 风险问句花不花一次模型前向（§W1）。默认 `always` = 今天（关键词命中即定，
   * 没命中的**每一步**都问一次模型）。`rules-only` = 只信关键词规则，一步都不问。
   *
   * 为什么这条值得存在：批量运行里 `confirmFn` 默认是"一律放行"，于是这次前向的答案
   * **被丢掉**——它按每步一次的频率收费（实测整批语料 597 s vs 桩 160.7 s，
   * 而选目标只被问了 5 次），换来的东西在批模式下没人看。要省，就得**声明着省**，
   * 而不是让执行器偷偷少问（那会改变 trace 与拒绝行为）。
   */
  riskAsk?: "always" | "rules-only";
  /** Constructor-level default for `RunOptions.tieredHint` (P1 narrowed question, default OFF). */
  tieredHint?: boolean;
  /**
   * A2：constructor-level default for `RunOptions.candidatePriority`（来自
   * `meta.policy.candidate_priority`；缺省 "bucketed" = A2 行为变更面）。
   */
  candidatePriority?: "bucketed" | "main-first";
  /**
   * E2：constructor-level default for 歧义命中顺序（`decision.ambiguous_ordering`
   * 配置键；缺省 "dom-preorder" = 行为变更面，"pool-order" = 旧序回退开关）。
   */
  ambiguousOrdering?: AmbiguousOrdering;
  /**
   * E1-c：constructor-level default for `#id` 直查兜底（`decision.id_fallback`
   * 配置键；缺省 true）。
   */
  idFallback?: boolean;
  /**
   * E1-b：constructor-level default for 池配额模型（`decision.pool_quota_mode`
   * 配置键；缺省 "legacy"）。
   */
  poolQuotaMode?: "legacy" | "quota";
  /**
   * E1-a：constructor-level default for 池帽观测面（`decision.act_pool_cap`
   * 配置键；缺省 40；只观测）。
   */
  actPoolCap?: number;
  /**
   * S1：pre-held done 的处置（来自 `meta.policy.done_preheld`；缺省 "warn" = 只记录）。
   * 见 `PackPolicy.done_preheld`（app-pack.ts）的语义说明。
   */
  donePreheldPolicy?: "warn" | "fail" | "allow";
  /**
   * P0-E：步级 false_done guard 的处置（来自 `meta.policy.done_guard`；缺省 "warn" =
   * 只记 step warning、不改判定；"fail" = done 成立但 guard 命中时结构化停 false_done）。
   */
  doneGuardPolicy?: "warn" | "fail";
  /** S1：fill 后读回 value 并与写入值比对（缺省 true；不可读组件自动降级跳过）。 */
  fillReadback?: boolean;
  /**
   * W8：敏感槽位**键**名单（app-runner 从 `meta.secretSlots` + 名称启发算出后传入；
   * 缺省空 = 无敏感槽位，行为逐字节不变）。fill 的 effect 读回在「值来自这些槽位 /
   * 读回内容命中其值」时把 before/after 掩码为 `***`（applied 保留）。只传键不传值：
   * 值本体由执行器从当次 run 的 slots 袋现读——**步级 slots 合并后的真值只在执行器
   * 可见**（R3 案例 S 的泄漏根源：app-runner 的 secretValues 名单从不包含步级值，
   * 收尾 scrubSecrets 对 effect 读回里的这类值天然失明）。
   */
  secretSlotKeys?: ReadonlySet<string>;
  /**
   * S2：抽池前的稳定门策略（`meta.policy.settle`；缺省开启 `{quietMs:400,timeoutMs:5000}`，
   * `null` = 显式关闭）。只影响"抽池前是否等页面静默"，不改变完成判定/动作语义。
   */
  settle?: { quietMs: number; timeoutMs: number } | null;
  /** U3：池空判档（缺省 "fact"；"strict" = U3 之前的 page_not_ready 快败）。 */
  poolGate?: "fact" | "strict";
  /**
   * P0-B：声明目标（act hint）解析链全落空时是否允许模型自由选。
   * 缺省/`"widen"` = 今天（回退模型）；`"strict"` = **不回退**，结构化
   * `target_not_found`（reason 显式写明 act_hint="strict"）。只砍模型回退：
   * FW8 身份回捞先执行，命令步不受影响。缺省不出现 = 行为逐字节不变。
   */
  actHint?: "widen" | "strict";
  /**
   * A3：`meta.policy.act_hint_tier`（与 `actHint` **正交**；缺省/"any" = 今天逐字节不变）。
   * "strong" = 声明目标的**弱档胜出**（bare tier≥3 词前缀/词包含、attrSubstr tier=3 loose
   * 子串；判据复用 rules 的 `suspicious`，不另造档位表）改判**未命中**：ref 被清空、step
   * warning 换成 `weak_hint_rejected`，随后照 `actHint` 既有语义继续（widen → 交模型；
   * rules-only → 既有 `no_model_runtime`；strict → 结构化 `target_not_found`，reason 写明
   * 弱档被判未命中 + 候选 + 两条修法）。命令 target / learned hint（非作者声明）/ 决策步
   * 不受影响；只作用于声明目标的规则解析与 rules-only 宽扫两处（同一 `declaredAllow`）。
   */
  actHintTier?: "any" | "strong";
  /**
   * P0-C：`meta.policy.target_resolution`（缺省/`"off"` = 今天逐字节不变；`"declared"` =
   * 启用 DRF）。只在**声明目标**（命令 target / act hint）的解析链上生效：池 hintMatch →
   * ADMIT 回捞 → FW8 身份回捞 → **DRF**（attr/text 两模式、恰好一个可见、click 前 hit-test）。
   * 回捞元素只进本步局部池，绝不进模型候选（pickInner 剥离 `declared` 标记）。
   */
  targetResolution?: "off" | "declared";
  /**
   * F74：`meta.policy.act_hint_dom_fallback`（缺省 false = 今天逐字节不变）。true = 决策步
   * act hint 解析链真落空后补一次主帧 ADMIT_SEL DOM 回退跳（`_domFallbackResolve`，不过滤
   * 可见性）；命中 = 确定性 rule:match（不进模型投影）；歧义 = 同一谓词 target_ambiguous；
   * 落空 = 原停因 + strict reason 补"已试 DOM 回退"。与 targetResolution 正交：declared
   * 场景排在 DRF 之后。
   */
  actHintDomFallback?: boolean;
  /** U3：surface 类目策略（缺省 native_activation="window"）。 */
  surfacePolicy?: SurfacePolicy;
  /**
   * A1：`tag[aria-label=…]` / `tag[aria-label~…]` 的池侧属性值底座
   * （来自 `meta.policy.attr_value_match`；缺省 `full_label` = 用 ≤200 的 full_label 与
   * 模型视图 label 双底座，>40 字的 aria-label 才能命中；`display` = A1 之前只看前 40 字）。
   * 只作用于 hint 匹配；inspect/observe/session 不传 = 恒 `full_label`。
   */
  attrValueMatch?: AttrValueMatch;
  /**
   * F84 批 3（deny-list 可配化）：第 5 档词元护栏的放行词元表（来自
   * `meta.policy.hint_token_allow`；缺省不传 = 护栏行为逐字节不变）。生效面 = 歧义证据
   * suggested_hint（describeAmbiguity 下传 suggestHints 单点消费）与 ctx.observe 自证池
   * hint_candidates（CtxDeps 下传 observePage）；inspect CLI / session / 桥面缺省
   * （F58 attr_value_match 同款面边界）。
   */
  hintTokenAllow?: readonly string[];
  /**
   * S5：状态接入决策（来自 `meta.policy.decision_state`；缺省两项都 "off" = 今天的行为）。
   * 见 `DecisionStatePolicy`：gate 决定"stable_only 时先 settle + 同池同题不重复问"，
   * context 决定"决策请求是否带 ≤200B 结构化 state_digest"。
   */
  decisionState?: Partial<DecisionStatePolicy>;
}
