/**
 * 介入 / 救援中断模块 —— 编排：状态、顺序链、幂等（§2 分层表）。
 *
 * 设计出处：docs/INTERVENTION_RESCUE_MODULE.md（v2）§3/§4/§7。
 * 允许依赖：node:* + support 两叶子（intervention-contract / intervention-texts）。
 * 禁止依赖：app / engine / model / cli / browser / data / integrations。
 *
 * 模块红线落地：
 *   - 通道抛错兜底 catch → unavailable + reason 截获（不信任通道实现）；
 *   - 幂等：request_id = (run_id, seq)，first-answer-wins；去重键 (run_id, kind, step_id)；
 *   - 状态全部实例化（createRescueState(run_id)），禁止模块级变量（同进程多 run 串扰）；
 *   - suspend 前落盘 rescue-request.json 由宿主注入的 onSuspend 钩子完成（模块不碰文件系统
 *     之外的任何 app 概念；落盘回调由 adapter 提供，模块只保证「调通道前同步调用」）。
 */

import type {
  RescueChannel, RescueKind, RescueMode, RescueOutcome, RescueRequest, RescueShadowRecord,
} from "../support/intervention-contract.ts";

/** kind 注册表实例（v1 三 kind；credential 依赖保险箱未建——不注册）。 */
export const RESCUE_KINDS = {
  action:       { stop_code: "needs_human", who_can_fix: "human-action",        text: "action",        },
  value:        { stop_code: "needs_value", who_can_fix: "human-value",         text: "value",         },
  authorization:{ stop_code: "needs_human", who_can_fix: "human-authorization", text: "authorization"  },
} as const;

export type KnownRescueKind = keyof typeof RESCUE_KINDS;

/** 结构化拒收（形状/大小校验失败）：宿主把它映射成 config_error，不抛裸栈。 */
export class RescueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RescueValidationError";
  }
}

/** 入口校验：JSON-safe / 大小 / 条数（证据不透明红线的落地方式——只校形状不解释语义）。 */
export function validateRescueRequest(req: RescueRequest): void {
  if (typeof req.request_id !== "string" || req.request_id === "") {
    throw new RescueValidationError("rescue: request_id is required");
  }
  if (typeof req.run_id !== "string" || req.run_id === "") {
    throw new RescueValidationError("rescue: run_id is required");
  }
  if (typeof req.seq !== "number" || !Number.isInteger(req.seq) || req.seq < 0) {
    throw new RescueValidationError("rescue: seq must be a non-negative integer");
  }
  if (typeof req.kind !== "string" || req.kind === "") {
    throw new RescueValidationError("rescue: kind is required");
  }
  if (req.mode !== "suspend" && req.mode !== "stop") {
    throw new RescueValidationError(`rescue: mode must be 'suspend' | 'stop' (got ${JSON.stringify(req.mode)})`);
  }
  if (typeof req.why_stuck?.summary !== "string" || req.why_stuck.summary === "") {
    throw new RescueValidationError("rescue: why_stuck.summary is required");
  }
  if (req.why_stuck.summary.length > 400) {
    throw new RescueValidationError(`rescue: why_stuck.summary exceeds 400 chars (${req.why_stuck.summary.length})`);
  }
  if (!Array.isArray(req.what_would_unblock) || req.what_would_unblock.length === 0) {
    throw new RescueValidationError("rescue: what_would_unblock must be a non-empty array");
  }
  if (req.what_would_unblock.length > 3) {
    // §5.5：超限即拒收（config_error），不静默截断——生产方必须拆成多次求援或收敛为一条主问。
    throw new RescueValidationError(
      `rescue: what_would_unblock has ${req.what_would_unblock.length} items (max 3); split into multiple requests or converge`,
    );
  }
  const evidenceJson = JSON.stringify(req.why_stuck.evidence ?? null);
  if (evidenceJson.length > 2048) {
    throw new RescueValidationError(`rescue: why_stuck.evidence exceeds 2KB (${evidenceJson.length} bytes)`);
  }
  if (evidenceJson === undefined) {
    // JSON.stringify 循环引用返回 undefined：证据必须 JSON-safe。
    throw new RescueValidationError("rescue: why_stuck.evidence is not JSON-safe");
  }
}

/** 实例化救援状态：一个 run 一份；禁止模块级变量（§4 升级计数 / §7 并发）。 */
export interface RescueState {
  readonly run_id: string;
  /** 请求序号（幂等键 seq 来源）。 */
  nextSeq(): number;
  /** 去重键 (run_id, kind, step_id)：同一声明点重复弹问（handler 重试/幂等重放）吞掉并返回旧记录。 */
  dedupe(kind: RescueKind, stepId: string): RescueRequest | null;
  /** 登记一次求援请求（此后该 (kind, step_id) 去重命中）。 */
  register(req: RescueRequest): void;
  /** 同一停因的原始计数（阈值与文案在引擎层 planning-playbook 单源；模块只持数不渲染）。 */
  countFor(stopCode: string): number;
  /** 记录一次停因出现（升级计数用）。 */
  noteStop(stopCode: string): void;
  /** 本 run 是否 dry/replay 面（dry 红线：不产生真实求援）。 */
  readonly dry: boolean;
}

export function createRescueState(run_id: string, dry = false): RescueState {
  let seq = 0;
  let requestCounter = 0;
  const byDedupeKey = new Map<string, RescueRequest>();
  const stopCounts = new Map<string, number>();
  return {
    run_id,
    dry,
    nextSeq: () => {
      const s = seq;
      seq += 1;
      return s;
    },
    dedupe: (kind, stepId) => byDedupeKey.get(`${run_id}::${kind}::${stepId}`) ?? null,
    register: (req) => {
      requestCounter += 1;
      byDedupeKey.set(`${run_id}::${req.kind}::${String(req.why_stuck.step_id ?? "")}`, req);
    },
    countFor: (stopCode) => stopCounts.get(stopCode) ?? 0,
    noteStop: (stopCode) => {
      stopCounts.set(stopCode, (stopCounts.get(stopCode) ?? 0) + 1);
    },
  };
}

/** 通道顺序链（§4）：显式 handler > TTY > FailFast/StructuredStop > none。 */
export interface RescueChain {
  readonly run_id: string;
  readonly state: RescueState;
  /** suspend 前同步回调（宿主落盘 rescue-request.json；模块不碰文件系统语义）。 */
  readonly onSuspend?: (req: RescueRequest) => void;
  /** 影子模式记录器（影子期只构造 + 计算，不调任何交互通道）。 */
  readonly onShadow?: (record: RescueShadowRecord) => void;
}

/** 内建通道注册（channels.ts 提供；宿主可注入自定义通道）。 */
export interface ResolveOptions {
  /** 显式注入的同步 handler（最高优先级；来自 ctx.manual 的 manualRunner / journey manualHandler）。 */
  readonly handler?: (req: RescueRequest, signal?: AbortSignal) => Promise<RescueOutcome> | RescueOutcome;
  /** TTY 交互通道是否可用（process.stdin.isTTY 由宿主判定，模块不读进程状态）。 */
  readonly ttyAvailable?: boolean;
  /** 宿主提供的 TTY 交互实现（保留 Enter/n 习惯；久无输入只提醒不杀）。 */
  readonly ttyPrompt?: (req: RescueRequest, signal?: AbortSignal) => Promise<RescueOutcome>;
  /** AbortSignal（宿主生命周期；进程退出 = 挂起丢失，绝不 fulfilled）。 */
  readonly signal?: AbortSignal;
}

/**
 * 解析一次求援：按顺序链选通道 → suspend 落盘 → 调通道 → Outcome。
 *
 * stop 模式不产生 Outcome（调用方只把 request 序列化进 result.rescue）；
 * suspend 模式在调通道前同步触发 onSuspend（崩溃取证；outcome 落定后不删除）。
 * 通道实现抛异常 → 兜底 catch 转 unavailable（不信任通道、不允许冒泡）。
 */
export async function resolveRescue(
  chain: RescueChain,
  req: RescueRequest,
  opts: ResolveOptions,
): Promise<RescueOutcome | null> {
  validateRescueRequest(req);
  if (req.mode === "stop") return null;
  // suspend 红线：只有同步通道可等待；无可应答通道 = 立即 unavailable，绝不 sleep 等人。
  const channel: RescueChannel | null = pickChannel(opts);
  if (channel === null || !channel.synchronous) {
    return {
      status: "unavailable",
      reason: "no answerable channel in this environment (batch / non-TTY)",
      at: Date.now(),
    };
  }
  chain.onSuspend?.(req);
  try {
    const outcome = await channel.resolve(req, opts.signal);
    if (outcome.status === "fulfilled" && opts.signal?.aborted === true) {
      // 迟到的 fulfilled（应答后取消已到）：first-answer-wins 的取消侧——取消优先。
      return { status: "cancelled", reason: "aborted before fulfilment landed", at: outcome.at };
    }
    return outcome;
  } catch (e) {
    // §3 通道抛错闭环：不信任通道实现，异常不得冒泡绕过 Outcome 映射。
    return {
      status: "unavailable",
      by: channel.id,
      reason: `channel '${channel.id}' threw: ${e instanceof Error ? e.message : String(e)}`,
      at: Date.now(),
    };
  }
}

/** 顺序链选通道（§4）：显式 handler > TTY > 无（FailFast/StructuredStop 是 stop 模式，不进这里）。 */
function pickChannel(opts: ResolveOptions): RescueChannel | null {
  if (opts.handler !== undefined) {
    return {
      id: "handler",
      synchronous: true,
      resolve: (req, signal) => Promise.resolve(opts.handler!(req, signal)),
    };
  }
  if (opts.ttyAvailable === true && opts.ttyPrompt !== undefined) {
    return {
      id: "tty",
      synchronous: true,
      resolve: (req, signal) => opts.ttyPrompt!(req, signal),
    };
  }
  return null;
}

/**
 * 影子模式求援（§8 步 2 三决定）：
 *   ① 影子期旧路径权威——只构造 RescueRequest 并记录「本会产出什么 outcome」的**计算值**，
 *      不调任何交互通道（杜绝 TTY 问两次人）；
 *   ② 影子差异只写 sidecar（onShadow 回调；默认产物零字节不变）；
 *   ③ 切默认门槛 = 影子期零分歧 + golden A 组逐字节——由宿主在验收期判定。
 */
export function shadowRescue(
  chain: RescueChain,
  req: RescueRequest,
  computed: Pick<RescueOutcome, "status" | "by">,
  legacyStopCode?: string,
): void {
  try {
    validateRescueRequest(req);
  } catch {
    // 影子期构造失败本身就是分歧：记录后由旧路径兜底。
    chain.onShadow?.({
      request: req,
      computed_outcome: computed,
      ...(legacyStopCode !== undefined ? { legacy_stop_code: legacyStopCode } : {}),
      divergence: "request construction failed validation in shadow mode",
      at: Date.now(),
    });
    return;
  }
  chain.onShadow?.({
    request: req,
    computed_outcome: computed,
    ...(legacyStopCode !== undefined ? { legacy_stop_code: legacyStopCode } : {}),
    at: Date.now(),
  });
}
