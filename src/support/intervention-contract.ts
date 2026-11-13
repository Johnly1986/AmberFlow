/**
 * 介入 / 救援中断模块 —— 合同**类型**（零 import 叶子）。
 *
 * 设计出处：docs/INTERVENTION_RESCUE_MODULE.md（v2）。
 * 红线：本文件是 L1.5 叶子——不 import 任何东西（连 node:* 都不用），
 * 才能被 src/cli/schema-gen.ts、tools/prompt-hit.ts 与桥生成物共同消费。
 *
 * 模块四红线（§1）：
 *   1. done_criteria 属于请求，通道无权削弱验证；
 *   2. 证据对模块不透明——模块不解析 kind 语义，只校验 JSON-safe / 大小；
 *   3. 通道只能应答，不能改计划、不能写 result；
 *   4. 模块不感知浏览器 / meta / flow / DSH。
 *
 * 已知边界坑（§2）：`StopError` 在 src/app/ctx-types.ts（应用层）——模块**不得**抛它；
 * outcome 一律由 adapter（src/app/intervention-adapter.ts）映射成 app 层停因。
 */

/** 求援模式：stop = 序列化进结果；suspend = 调用栈内等待（必须显式）。 */
export type RescueMode = "suspend" | "stop";

/** 求援 kind：RESCUE_KINDS 注册表键的 union（编译期穷尽；二期可加 credential / external-task / captcha）。 */
export type RescueKind = string & { readonly __rescueKind: unique symbol };

/** 每个 kind 绑定三件事（§3）：既有停因（零新增）/ 谁能修 / 文案词面。纯数据，不挂函数。 */
export interface RescueKindSpec {
  /** 只引用**既有**停因（needs_human / needs_value / manual_declined 等），零新 stop code。 */
  readonly stop_code: string;
  /** 谁能修：human-action / human-value / human-authorization；二期可扩展 vault / external（非人应答者）。 */
  readonly who_can_fix: string;
  /** 文案词面键（intervention-texts.ts 的键集与之同步）。 */
  readonly text: string;
}

/**
 * kind 注册表形状：实现侧以 `as const` 对象给出，键集 = RescueKind 的事实来源。
 * v1 注册三个 kind：action / value / authorization。
 * credential 依赖凭据保险箱（未建）——不注册、不生成文案（§3 二期依赖声明）。
 */
export interface RescueKindRegistry {
  readonly [kind: string]: RescueKindSpec;
}

/** 求援请求：一次结构化求援的完整事实（模块只校验形状与大小，不解释语义）。 */
export interface RescueRequest {
  /** 幂等键 = `${run_id}:${seq}`；去重键 = (run_id, kind, step_id)（§5.5）。 */
  readonly request_id: string;
  readonly run_id: string;
  readonly seq: number;
  readonly kind: RescueKind;
  /** stop = 序列化进结果（不产生 Outcome）；suspend = 调用栈内等待。 */
  readonly mode: RescueMode;
  readonly why_stuck: {
    /** ≤400 字人话事实；通道唯一可展示的人话（zh 权威，见语言矩阵）。 */
    readonly summary: string;
    /** 既有停因（不新增）。 */
    readonly stop_code?: string;
    readonly step_id?: string;
    /** JSON-safe ≤2KB；生产方声明已脱敏，模块只校验大小/可序列化（证据不透明红线）。 */
    readonly evidence: unknown;
  };
  /** 需要外界做什么（≤3 条，一次一问；超限模块拒收 config_error，不静默截断）。 */
  readonly what_would_unblock: readonly string[];
  /** 完成判据；由 app 层解释（fulfilled 后复核用它），模块只透传。 */
  readonly done_criteria?: unknown;
}

/** 求援结局：五态必须可区分（拒绝/超时/取消/无人 ≠ 失败的同义词）。 */
export interface RescueOutcome {
  readonly status: "fulfilled" | "declined" | "timeout" | "cancelled" | "unavailable";
  /** 通道 id / 应答者标识（不回传敏感信息）。 */
  readonly by?: string;
  readonly reason?: string;
  readonly at: number;
}

/** 求援通道：只能应答，不能改计划、不能写 result（红线 3）。 */
export interface RescueChannel {
  readonly id: string;
  /** 只有 synchronous:true 的通道允许 suspend 模式。 */
  readonly synchronous: boolean;
  /** 抛异常时由模块兜底 catch 转 unavailable + reason 截获（§3 通道抛错闭环），不信任实现。 */
  resolve(req: RescueRequest, signal?: AbortSignal): Promise<RescueOutcome>;
}

/** 影子模式记录（§8 步 2 影子三决定）：影子期只构造请求 + 计算值，不调任何交互通道。 */
export interface RescueShadowRecord {
  readonly request: RescueRequest;
  /** 影子期计算的「本会产出什么 outcome」——只写 sidecar，不影响真实产物。 */
  readonly computed_outcome: Pick<RescueOutcome, "status" | "by">;
  /** 旧路径实际产出的停因（对账用）；旧路径权威。 */
  readonly legacy_stop_code?: string;
  /** 影子与旧路径的分歧描述（有分歧只记录，以旧路径为准）。 */
  readonly divergence?: string;
  readonly at: number;
}
