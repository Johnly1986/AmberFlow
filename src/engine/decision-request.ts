/**
 * 决策请求构造单点：把「发给决策提供者的请求体」从执行器/各面收口到一处。
 *
 * 边界（与 `decision-ask-contract.ts` 的 DC7 同源）：
 *   - 只做**纯组装**：不做页面 I/O、不抽池、不裁决；入参已是执行面事实；
 *   - 形状与既有 `ChoiceRequest` 逐字段一致：新增键只在显式输入出现（缺省不出现，
 *     请求体形状不变由 lane 镜像断言）；
 *   - notes 的「实际发送值」单点：site-facts 的合并（run 面 D2 注入与 pilot 面 L4 端口）
 *     一律经 `effectiveNotes`。回执观察（逐层 L4 记 sent/absent）必须与真实 wire 用同一份
 *     计算，否则合并规则一改回执就会说谎。
 */
import type { StateDigestPayload } from "../support/decision-provider-contract.ts";
import type { ChoiceRequest } from "../support/decision-provider-contract.ts";
import type { AnyPage } from "./executor-types.ts";
import type { ElemPool } from "./extraction.ts";

/** 组装一次 choice 请求所需的执行面事实（与 `ChoiceRequest` 字段一一对应）。 */
export interface ChoiceRequestInput {
  goal: string;
  page: AnyPage;
  elems: ElemPool;
  forbidden: Set<string>;
  notes: Record<string, string> | null;
  narrow: string[] | null;
  k: number;
  /** 可选结构化状态摘要（仅在调用方显式传入时出现；缺省 = 不带该键）。 */
  stateDigest?: StateDigestPayload | null;
}

/** 组装 choice 请求：`state_digest` 缺省不出现（与既有请求体逐字节一致）。 */
export function buildChoiceRequest(input: ChoiceRequestInput): ChoiceRequest {
  return {
    goal: input.goal,
    page: input.page as unknown as ChoiceRequest["page"],
    elems: input.elems as unknown as ChoiceRequest["elems"],
    forbidden: input.forbidden,
    notes: input.notes,
    narrow: input.narrow,
    k: input.k,
    ...(input.stateDigest === undefined || input.stateDigest === null
      ? {} : { state_digest: input.stateDigest }),
  };
}

/**
 * 把 L4 站点知识文本并入 notes（单点合并）：空/缺省文本 = 原样返回（不新增键）。
 * 既有 `site_facts` 由调用方先检查（已是权威来源时不覆盖）。
 */
export function mergeSiteFactsNotes(
  notes: Record<string, string> | null | undefined,
  siteFactsText: string | null | undefined,
): Record<string, string> | null {
  const text = typeof siteFactsText === "string" ? siteFactsText.trim() : "";
  if (text === "") return notes ?? null;
  return { ...(notes ?? {}), site_facts: text };
}

/**
 * 一次决策询问**实际发送**的 notes（回执观察与 wire 的同一份计算）。
 *
 * 消费点（不得各写一份合并规则）：`executor.ts#pickInner`（真正发给 provider 的请求体）、
 * `decision-ask.ts#askPick`（逐层回执的 L4 产出事实）、`createDecisionAsk` 的 L4 端口注入。
 * 入参/输出形状与 `mergeSiteFactsNotes` 同义；默认路径下空文本 = notes 原样，wire 字节不变。
 */
export function effectiveNotes(
  notes: Record<string, string> | null | undefined,
  siteFactsText: string | null | undefined,
): Record<string, string> | null {
  return mergeSiteFactsNotes(notes, siteFactsText);
}

/** notes 是否已带 site-facts（端口/执行器只注入一次）。 */
export function hasSiteFactsNotes(notes: Record<string, string> | null | undefined): boolean {
  if (notes === null || notes === undefined) return false;
  const text = notes["site_facts"];
  return typeof text === "string" && text.trim() !== "";
}
