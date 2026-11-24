/**
 * 介入 / 救援 —— `--rescue` 的 **result.rescue 生产面**（stop 模式）。
 *
 * 分类器而非触发器：只在**最终停因**命中映射表时把一个结构化求援请求序列化进 result；
 * `needs_value` / 危险动作拒绝只分类，不改控制流、不挂起、不调任何通道。
 * `opts.rescue !== true`（默认）时调用方传 null builder，本模块零调用、产物键集逐字节不变。
 *
 * 红线：
 *   - 每个请求都必须过 `validateRescueRequest`（形状/大小/条数）；不过 = 不写字段（fail-closed）。
 *   - `why_stuck.evidence` 只放人读事实，不含敏感值：页面 URL 去掉 query/hash。
 *   - `request_id = `${run_id}:${seq}``；seq 由每个 run 自己的 `RescueRequestBuilder` 计数
 *     （禁模块级计数器——同进程多 run 会串扰）。
 */
import { validateRescueRequest } from "../intervention/index.ts";
import type { RescueKind, RescueRequest } from "../support/intervention-contract.ts";
import { RESCUE_TEXTS } from "../support/intervention-texts.ts";
import { clipText } from "../support/text.ts";

export type { RescueRequest } from "../support/intervention-contract.ts";

/** 人工步现场事实（从 trace / `manual_steps` 取；取不到就省略对应字段，不猜）。 */
export interface LastManualFacts {
  readonly desc?: string;
  readonly stepId?: string;
  readonly pageUrl?: string | null;
}

/** 一次结果装配的输入：最终停因 + 可选的最后一个人工步事实。 */
export interface RescueInput {
  readonly stopCode: string | undefined;
  readonly lastManualFacts?: LastManualFacts;
  /** 结束页 URL（evidence 会剥掉 query/hash）。 */
  readonly pageUrl?: string | null;
}

/** 映射结果字段的包装：`{}` = 请求缺席（默认关 / 停因不映射 / 校验不过）。 */
export type RescueField = { rescue?: RescueRequest };

const ACTION_KIND = "action" as RescueKind;
const VALUE_KIND = "value" as RescueKind;
const AUTHORIZATION_KIND = "authorization" as RescueKind;

/**
 * 停因 → kind 的唯一映射表（集中此处；未知/空 = 不求援）。
 *
 * 只引用**既有**停因（零新增 stop code）：人工步 = needs_human / manual_*（含 journey
 * 声明步的 needs_interactive_terminal）；缺值 = needs_value；危险动作拒绝 = 工具侧
 * refused `dangerous` / `declined`（默认拒绝是安全语义，这里只分类）。
 */
const STOP_CODE_KIND: Readonly<Record<string, RescueKind>> = {
  needs_human: ACTION_KIND,
  needs_interactive_terminal: ACTION_KIND,
  manual_declined: ACTION_KIND,
  manual_handler_error: ACTION_KIND,
  manual_signal_not_held: ACTION_KIND,
  needs_value: VALUE_KIND,
  dangerous: AUTHORIZATION_KIND,
  declined: AUTHORIZATION_KIND,
};

/** 停因 → 求援 kind；空/不命中 → null（默认产物零变化）。 */
export function rescueKindForStopCode(stopCode: string | undefined | null): RescueKind | null {
  if (stopCode === undefined || stopCode === null || stopCode === "") return null;
  return STOP_CODE_KIND[stopCode] ?? null;
}

/** evidence 里的 URL：只保留 http(s) 的 origin+path（query/hash 可能带 token；无页面时 urlOf 会给出哨兵串）。 */
function urlWithoutQuery(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

/**
 * 纯映射：一次停因事实 → RescueRequest（或 null）。`seq` 由调用方给（builder 持有 run 级计数）。
 * 生成后**当场**过 `validateRescueRequest`；校验失败返回 null，绝不把坏请求写进产物。
 */
export function buildRescueRequest(input: {
  readonly runId: string;
  readonly seq: number;
  readonly stopCode: string | undefined;
  readonly lastManualFacts?: LastManualFacts;
  readonly pageUrl?: string | null;
}): RescueRequest | null {
  const kind = rescueKindForStopCode(input.stopCode);
  if (kind === null) return null;
  const texts = RESCUE_TEXTS[kind];
  if (texts === undefined) return null;
  const facts = input.lastManualFacts;
  const evidence: Record<string, unknown> = {};
  if (facts?.desc !== undefined && facts.desc !== "") evidence["desc"] = clipText(facts.desc.replace(/\s+/g, " ").trim(), 120);
  const url = urlWithoutQuery(facts?.pageUrl ?? input.pageUrl ?? null);
  if (url !== null) evidence["url"] = url;
  const summary = texts.summary.length <= 400 ? texts.summary : `${texts.summary.slice(0, 399)}…`;
  const request: RescueRequest = {
    request_id: `${input.runId}:${input.seq}`,
    run_id: input.runId,
    seq: input.seq,
    kind,
    mode: "stop",
    why_stuck: {
      summary,
      ...(input.stopCode === undefined ? {} : { stop_code: input.stopCode }),
      ...(facts?.stepId === undefined || facts.stepId === "" ? {} : { step_id: facts.stepId }),
      evidence,
    },
    what_would_unblock: [...texts.next_actions].slice(0, 3),
  };
  try {
    validateRescueRequest(request);
  } catch {
    return null;
  }
  return request;
}

/** 每个 run 实例一个：持有 seq 计数（禁模块级计数器）。 */
export class RescueRequestBuilder {
  private seq = 0;
  private readonly runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  build(input: RescueInput): RescueRequest | null {
    const seq = this.seq + 1;
    const request = buildRescueRequest({ runId: this.runId, seq, ...input });
    if (request !== null) this.seq = seq;
    return request;
  }
}

/** 结果装配面：默认关（builder=null）或停因不映射 → `{}`（字段完全缺席）。 */
export function rescueField(builder: RescueRequestBuilder | null, input: RescueInput): RescueField {
  if (builder === null) return {};
  const request = builder.build(input);
  return request === null ? {} : { rescue: request };
}

/** flow 路径：从 trace 取**最后一条** manual 事件的 desc/id/url（取不到返回 undefined）。 */
export function lastManualFactsFromTrace(
  events: readonly { readonly call?: string; readonly desc?: string; readonly id?: unknown; readonly url?: string }[],
): LastManualFacts | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.call !== "manual") continue;
    const stepId = typeof event.id === "string" && event.id !== "" ? event.id : undefined;
    return {
      ...(event.desc === undefined || event.desc === "" ? {} : { desc: event.desc }),
      ...(stepId === undefined ? {} : { stepId }),
      ...(event.url === undefined || event.url === "" ? {} : { pageUrl: event.url }),
    };
  }
  return undefined;
}

/** journey 面最小事实形状（与 `AppRunResult.manual_steps` / `ToolStepResult` 的子集同构）。 */
export interface JourneyManualFact {
  readonly index: number;
  readonly desc: string;
  readonly done: boolean;
  readonly reason?: string;
}

export interface JourneyToolFact {
  readonly index: number;
  readonly desc: string;
  readonly done: boolean;
  readonly refused?: string;
}

/** journey 人工步 reason → 既有停因（只认可归类的；host/navigation/config 类不许求援）。 */
function manualReasonStopCode(reason: string | undefined): string {
  if (reason === undefined || reason === "" || reason === "needs_interactive_terminal") return "needs_human";
  if (reason === "declined") return "manual_declined";
  if (reason === "manual_signal_not_held") return "manual_signal_not_held";
  if (reason.startsWith("manual_handler_error")) return "manual_handler_error";
  return "";
}

/**
 * journey 路径的最终停因 + 最后人工步事实：
 * 人工步失败优先（与 `ok` 同口径：人工没完成就是全局未完成），其次工具步的结构化拒绝
 * （needs_value / dangerous / declined），最后看路径上界停因（不可归类 = 不求援）。
 */
export function journeyRescueInput(
  manualSteps: readonly JourneyManualFact[],
  toolSteps: readonly JourneyToolFact[],
  pathStop: { readonly code: string } | undefined,
): RescueInput {
  const failedManual = manualSteps.find((m) => !m.done);
  if (failedManual !== undefined) {
    return {
      stopCode: manualReasonStopCode(failedManual.reason),
      lastManualFacts: { desc: failedManual.desc, stepId: String(failedManual.index) },
    };
  }
  const failedTool = toolSteps.find((t) => !t.done && t.refused !== undefined);
  if (failedTool !== undefined) {
    return {
      stopCode: failedTool.refused,
      lastManualFacts: { desc: failedTool.desc, stepId: String(failedTool.index) },
    };
  }
  return { stopCode: pathStop?.code };
}
