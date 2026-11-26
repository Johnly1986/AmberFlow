/**
 * `amber session` 运行时 · act **失败面**的证据组装（从 `doAct` 抽出）。
 *
 * 独立成模块而非写进 `doAct`：主文件与 doAct 是只减不增的存量基线（maintain 门禁）。
 * 本模块只做"把引擎已经判定的事实投影进一行响应"，**不重算、不补键、不改判定**——
 * 与 `session-act-range.ts` / `session-act-scroll.ts` 同一抽法。
 *
 * 证据的发放按停因收窄，不是一律全发（每次页面往返都要付得起）：
 *   - `overlay`：target_not_found / not-actionable-or-covered 两类与"遮罩挡着"有归因关系；
 *   - `wide_scan`：target_not_found / target_ambiguous，以及遮挡类里 blocker 为真实第三方元素的
 *     情形（"页面上还有哪些可点的"）；offscreen / zero-size 不发，见 `wantsWideForCovered`；
 *   - `recent`：只有 target_not_found 才查（S4 最近命中提示，纯内存）。
 */
import { urlOf } from "../engine/extraction.ts";
import type { AnyPage, BrowserMiddleware } from "../engine/executor.ts";
import type { ActMissDiagnostics, ActMissRow } from "../engine/executor-pure.ts";
import { wideScanCandidates } from "./session-wide-scan.ts";
import {
  actionabilityResponse, ambiguityResponse, closedSetReasonSuffix, executionStateResponse,
  failureScreenshot, missDiagnosticsResponse, shapeProblemResponse,
} from "./session-runtime-evidence.ts";

/** 轨迹行里候选行的字段上限（ref/tag/label 与歧义证据同口径，便于两处对照读）。 */
const RECORD_ROW_CAP = 3;
const RECORD_LABEL_MAX = 40;

/** 候选行的有界投影（ref 缺省不补；tag/label 截断）。 */
function recordRows(rows: readonly ActMissRow[] | undefined): Record<string, unknown>[] {
  return (rows ?? []).slice(0, RECORD_ROW_CAP).map((r) => ({
    ...(r.ref === undefined ? {} : { ref: String(r.ref).slice(0, 16) }),
    tag: String(r.tag ?? "").slice(0, 16),
    label: String(r.label ?? "").slice(0, RECORD_LABEL_MAX),
  }));
}

/**
 * 落空判别的**轨迹归档投影**（`--record` 的 actions.jsonl 行，`diag` 键）。
 *
 * 为什么需要：响应面本来就有完整 `diagnostics`（调用方当场能读），但轨迹面只留一个
 * `code` 字符串——事后复盘时分不清"hint 写法不对"与"目标真的不在页/已滚出视口"，
 * 只能重跑或读源码。归因证据必须与判定证据同寿命。
 *
 * 只取判别所需的最小集（其余低频字段如 rejected / ax_weak_rejected / rescan / settle_*
 * 各有专门键，全记会让轨迹膨胀且与 overlay / actionability 重复）。
 */
export function missDiagRecord(diag: ActMissDiagnostics | undefined): Record<string, unknown> {
  if (diag === undefined) return {};
  const out: Record<string, unknown> = {};
  // 写法层：区分"我写错了吗"（css-attr-operator / selector-syntax / tag-plus-text…）。
  if (typeof diag.shape_problem?.kind === "string") out["shape_problem"] = diag.shape_problem.kind;
  // 规模层：判断目标是否可能被池帽挤出。
  if (typeof diag.pool_size === "number") out["pool_size"] = diag.pool_size;
  // 否定性核心：在 DOM 却未入池（"存在但不可达"与"不存在"是两种完全不同的下一步）。
  if (diag.in_dom_but_not_admitted !== undefined) {
    out["in_dom_but_not_admitted"] = {
      total: diag.in_dom_but_not_admitted.total,
      note: String(diag.in_dom_but_not_admitted.note ?? "").slice(0, 120),
    };
  }
  // 替代锚点：同档候选与词面近似（各 ≤3 行，够看出"池里到底有什么"）。
  const candidates = recordRows(diag.candidates);
  if (candidates.length > 0) out["candidates"] = candidates;
  const near = recordRows(diag.near);
  if (near.length > 0) out["near"] = near;
  return out;
}

/**
 * `actOnce` 失败返回面的窄投影：只声明本模块真正消费的键（多一个键都不读，避免与引擎
 * 内部形状耦合）。`diagnostics` 在成功面也可能出现（no_op_click），这里只关心失败面。
 */
export interface ActFailureOut {
  stopCode?: string;
  reason?: string;
  ref?: string;
  diagnostics?: ActMissDiagnostics;
  actionability?: Parameters<typeof actionabilityResponse>[0];
  execution_state?: Parameters<typeof executionStateResponse>[0];
  ambiguity?: Parameters<typeof ambiguityResponse>[0];
}

/** 遮挡类停因里"不是视野不够"的两类 blocker：处置分别是滚入视口与换目标/等渲染。 */
const NON_VISUAL_BLOCKERS = new Set(["offscreen", "zero-size"]);

/**
 * 遮挡类停因是否值得付一次宽扫：只有 `blocker` 是**真实第三方元素描述**
 * （如 `div#cookie-banner`）时才有替代路径可给——作者需要知道"遮罩上还有哪些能点的"。
 * `null`（中心点无覆盖者，只是短预算不够）与 `offscreen`/`zero-size`（元素不可达而非被盖住）
 * 都不发：这两类的正确处置是滚动/换目标/等渲染，与"页面上还有哪些可点的"无关。
 */
function wantsWideForCovered(out: ActFailureOut): boolean {
  if (out.stopCode !== "not-actionable-or-covered") return false;
  const blocker = out.actionability?.blocker;
  return typeof blocker === "string" && blocker !== "" && !NON_VISUAL_BLOCKERS.has(blocker);
}

/**
 * 宽扫发放判据的唯一出处（overlay 不看它——overlay 覆盖全部遮挡类，宽扫只看"有没有替代路径"）。
 */
function wantsWideScan(out: ActFailureOut): boolean {
  return out.stopCode === "target_not_found"
    || out.stopCode === "target_ambiguous"
    || wantsWideForCovered(out);
}

/** 失败分支的会话侧依赖（窄接口投影，不把整个会话类拖进模块）。 */
export interface ActFailureEvidenceDeps {
  page: AnyPage;
  target: string;
  actOp: string;
  req: Record<string, unknown>;
  startedAt: number;
  actionCount: number;
  outDir: string;
  hosts?: string[] | null;
  mw(): BrowserMiddleware;
  log(line: string): void;
  /** S4 最近命中提示（调用方给闭包，由本模块按停因决定要不要查）。 */
  recentHint(): { diag: Record<string, unknown>; reasonLine: string };
  /**
   * 歧义证据（调用方在 `recordAction` 之前已算好）。**必须传入而不是在这里重算**——
   * `actAmbiguity` 读的是"最后一次解析者"写入的模块态，重算会拿到已清场的空结果。
   */
  amb: Record<string, unknown>;
}

/**
 * 组装 act 失败响应（返回值即会话协议的一行响应）。
 *
 * 键集纪律：除本模块按停因增补的证据键外，其余键与既有失败响应同形；停因不匹配时
 * 对应键**不出现**（不是空对象），调用方据此判断"引擎这次没给这份事实"。
 */
export async function actFailureEvidence(
  out: ActFailureOut, deps: ActFailureEvidenceDeps,
): Promise<Record<string, unknown>> {
  const { page } = deps;
  // E4：落空/被遮挡失败时的 overlay 证据（只读一次；不消散——是否关遮罩由作者决定）。
  const wantOverlay = out.stopCode === "target_not_found" || out.stopCode === "not-actionable-or-covered";
  const overlay = wantOverlay ? await deps.mw().overlayEvidence(page) : null;
  // S4：落空时的最近命中提示（纯内存；独立键 recently_resolved，不覆盖引擎 A4 的 diagnostics）。
  const recent = out.stopCode === "target_not_found" ? deps.recentHint() : { diag: {}, reasonLine: "" };
  // F6/F87：歧义/落空时**一次**有界宽扫（≤128；零动作）——把全量候选与自证 hint 回传给
  // 作者再决定（收窄 hint / 换锚点 / 滚动取证）。绝不点击/滚动/重试。
  const wide = wantsWideScan(out) ? await wideScanCandidates(page, deps.hosts) : null;
  return {
    ok: false, code: String(out.stopCode ?? "action_failed"),
    reason: String(out.reason ?? "") + recent.reasonLine + closedSetReasonSuffix(out.stopCode),
    op: deps.actOp, target: deps.target, executed: false,
    ...actionabilityResponse(out.actionability),
    ...executionStateResponse(out.execution_state),
    ...(out.ref === undefined ? {} : { ref: out.ref }),
    url: urlOf(page), elapsed_ms: Date.now() - deps.startedAt,
    ...(await failureScreenshot(deps.outDir, deps.log, page, deps.actionCount, deps.req)),
    ...(overlay !== null && overlay.length > 0 ? { overlay } : {}),
    ...(wide !== null ? { wide_scan: wide } : {}),
    ...deps.amb,
    ...ambiguityResponse(out.ambiguity),
    ...missDiagnosticsResponse(out.diagnostics), ...shapeProblemResponse(out.diagnostics?.shape_problem),
    ...recent.diag,
  };
}
