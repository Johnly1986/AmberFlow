/**
 * 介入 / 救援中断模块 —— 唯一 app ↔ 模块适配层（§2 分层表钦点位）。
 *
 * 设计出处：docs/INTERVENTION_RESCUE_MODULE.md（v2）§2/§3/§8 步 3。
 * 职责（严格限定）：
 *   - 把「谁能应答人工步」的**通道顺序链**（显式 handler > TTY > 无）收敛成单一解析函数，
 *     journey `runManualStep` 与 flow `ctx.manual` 共用同一份选路——「只换确认提供者，
 *     不改判定」的落点；判定（approved→done / declined→原文 / handler 抛错→
 *     `manual_handler_error: ` 原文前缀）全部留在既有调用点，本文件零停因知识。
 *   - 影子模式旁路（§8 步 2 三决定）：开关默认关；开启时只构造 RescueRequest + 记录
 *     计算 outcome，不调任何交互通道、不改任何返回值（recorder 见 intervention-shadow.ts）。
 * 红线（§1）：模块不感知浏览器/meta/flow/DSH；本文件不解释 kind 语义、不渲染文案、
 * 不装信号处理器；StopError 由调用点抛，本文件零停因映射。
 */

import type { RescueKind, RescueRequest } from "../support/intervention-contract.ts";
import { RESCUE_TEXTS } from "../support/intervention-texts.ts";
import { shadowRescue } from "../intervention/index.ts";
import type { ShadowRecorder } from "./intervention-shadow.ts";

/** RescueKind 品牌化 string——app 层以受控断言落地（与契约注册表同键集）。 */
const ACTION_KIND = "action" as RescueKind;

/** evidence 里 instructions 的摘要上限（≤120 字；红线：evidence 无敏感值）。 */
const INSTRUCTIONS_EVIDENCE_MAX = 120;

function clipInstructionsEvidence(instructions: string): string {
  const s = instructions.replace(/\s+/g, " ").trim();
  return s.length <= INSTRUCTIONS_EVIDENCE_MAX ? s : `${s.slice(0, INSTRUCTIONS_EVIDENCE_MAX - 1)}…`;
}

/** 人工步现场事实（adapter 视角的最小形状——通道接口不得收 `index`（§7 冻结约束））。 */
export interface ManualStepFacts {
  /** 声明点描述（desc；journey 是声明步、flow 是 ctx.manual 第一参）。 */
  readonly desc: string;
  /** 声明步 id（journey 声明步号/id；flow 恒缺省空——去重键 (run_id, kind, step_id) 用）。 */
  readonly stepId: string;
  /** 指引原文（可为空）。 */
  readonly instructions: string;
  /** 现场页面 URL（可为 null——无 start_url 且未开浏览器）。 */
  readonly pageUrl: string | null;
}

/** 确认提供者解析结果：§4 顺序链（handler > TTY > none）的 app 层投影。 */
export interface ManualApprover {
  /** 通道 id：`handler`（显式注入）/ `tty`（终端在）/ `none`（批处理——立即停，绝不 sleep 等人）。 */
  readonly channel: "handler" | "tty" | "none";
  /** 是否可应答：none = 不可（调用点按既有 needs_human 路径停）。 */
  readonly answerable: boolean;
}

/**
 * 解析人工步的可应答通道（§4 顺序链的 app 层投影；纯函数、无副作用）。
 *
 * 与既有代码的对应关系（不改判定，只收敛选路来源）：
 *   - 显式注入 handler → `handler`（journey 1492-1494 / flow ctx.manual 现状）；
 *   - 无 handler 且 stdin 是 TTY → `tty`（promptManualOnTty 内部自检不变）；
 *   - 都没有 → `none`（非 TTY 无 handler 的既有 needs_human 路径，绝不 sleep 等人）。
 */
export function pickManualApprover(hasHandler: boolean, isTty: boolean): ManualApprover {
  if (hasHandler) return { channel: "handler", answerable: true };
  if (isTty) return { channel: "tty", answerable: true };
  return { channel: "none", answerable: false };
}

/** 影子记录的现场结局（computed outcome 五态映射的输入——由调用点在**既有判定之后**填）。 */
export interface ManualShadowOutcome {
  status: "fulfilled" | "declined" | "timeout" | "cancelled" | "unavailable";
  by: string;
  /** 既有停因原样透传（needs_human / manual_declined / manual_signal_not_held / manual_handler_error）。 */
  legacyStopCode?: string;
}

/**
 * 影子旁路：构造 RescueRequest + 记录计算 outcome（§8 步 2 ①②——不调通道、不改行为）。
 * 开关未开启时 recorder 为 null，本函数为完全空操作（零开销、零产物）。
 * 去重键 = (run_id, kind, step_id)：同一声明点重复记录（幂等重放/handler 重试）只记第一条。
 */
export function shadowManualOutcome(
  recorder: ShadowRecorder | null,
  facts: ManualStepFacts,
  outcome: ManualShadowOutcome,
): void {
  if (recorder === null) return;
  const state = recorder.chain.state;
  if (state.dry) return; // dry/replay 红线：不产生真实求援（双保险；recorder 构造时 dry 恒 false）。
  const stepId = facts.stepId !== "" ? facts.stepId : facts.desc.slice(0, 80);
  if (state.dedupe(ACTION_KIND, stepId) !== null) return; // 同一声明点只记第一条。
  const unblock: string[] = [];
  const instructions = facts.instructions.trim();
  if (instructions !== "") unblock.push(`按说明完成该步后确认：${instructions.slice(0, 80)}`);
  else unblock.push(`完成「${facts.desc.slice(0, 40)}」后在交互终端确认`);
  if (unblock.length < 2) unblock.push("无法完成时放弃（输入 n）：已完成的步骤与证据保留，流程如实停止");
  const seq = state.nextSeq();
  const legacy = outcome.legacyStopCode !== undefined && outcome.legacyStopCode !== "" ? outcome.legacyStopCode : undefined;
  const req: RescueRequest = {
    request_id: `${state.run_id}:${seq}`,
    run_id: state.run_id,
    seq,
    kind: ACTION_KIND,
    mode: "suspend",
    why_stuck: {
      summary: RESCUE_TEXTS.action.summary.length <= 400
        ? RESCUE_TEXTS.action.summary
        : RESCUE_TEXTS.action.summary.slice(0, 400),
      ...(legacy !== undefined ? { stop_code: legacy } : {}),
      step_id: stepId,
      evidence: {
        ...(facts.pageUrl !== null && facts.pageUrl !== "" ? { url: facts.pageUrl } : {}),
        desc: facts.desc.slice(0, 120),
        ...(instructions !== "" ? { instructions: clipInstructionsEvidence(instructions) } : {}),
      },
    },
    what_would_unblock: unblock,
  };
  shadowRescue(recorder.chain, req, { status: outcome.status, by: outcome.by }, legacy);
  state.register(req);
}
