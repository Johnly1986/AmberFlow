/**
 * F6 会话 act 宽扫回传（歧义/落空时的一次有界"放大视野"；**零动作**）。
 *
 * 为什么：会话 act 对同 label 多候选 fail-closed、对池外目标 target_not_found——两条都是
 * "零动作停因"，作者只能看到 ≤5 行歧义证据或落空诊断。正常操作卡住时人会"再看全一点"
 * 再决定：这里做**一次**有界宽扫（≤128 = 宽扫预算档），把全量候选与自证 hint 回传给作者，
 * 自己决定下一步（收窄 hint / 换锚点 / 滚动取证）。绝不点击、绝不滚动、绝不重试动作。
 *
 * 纪律：
 *   - **零动作**：只读抽池（extractElements 的既定盖章语义）+ 纯内存 hint 生成；响应是
 *     additive 证据面（旧响应键集不变），不是动作结果。
 *   - **hint 必须自证**：每条 hint 来自 `rules.suggestHints`（同一 push → hintMatch +
 *     hintCandidates 自证"恰好唯一命中"才保留，engine 不自造词面）；生成不出自证候选的
 *     行如实省略 hint 键。
 *   - **有界**：候选 ≤ 宽扫预算档（WIDE_POOL_ELEMENTS=128）；抽池失败 = 空 candidates
 *     如实返回（不抛——宽扫是失败路径的增强证据，不该把失败变成崩溃）。
 *   - 仅主路径失败（target_not_found / target_ambiguous）触发：其余停因（stale_ref、
 *     action_failed、needs_value…）与"视野不够"无归因关系，不多付这次页面往返。
 */
import { WIDE_POOL_ELEMENTS, type ElemPool, type PageLike } from "../engine/extraction.ts";
import { suggestHints } from "../engine/rules.ts";
import { extractElements } from "./candidate-scan.ts";

export interface WideScanCandidate {
  ref: string;
  tag: string;
  label: string;
  /** 自证 hint（suggestHints 首选；经同一 hintMatch 验证恰好唯一命中；生成不出则缺省）。 */
  hint?: string;
}

export interface WideScanReport {
  /** 本次宽扫的窗口档（宽扫预算常量；≤128）。 */
  window: number;
  /** 宽扫池行数（= candidates 长度；抽池失败为 0）。 */
  pool_size: number;
  candidates: WideScanCandidate[];
}

/** 一次有界宽扫：全量候选 + 每行首选自证 hint。永不抛、永不动作。 */
export async function wideScanCandidates(
  page: PageLike, hosts?: string[] | null,
): Promise<WideScanReport> {
  let pool: ElemPool = {};
  try {
    pool = await extractElements(page, true, WIDE_POOL_ELEMENTS,
      hosts === undefined || hosts === null ? {} : { hosts });
  } catch {
    pool = {};   // 抽池失败：空报告（宽扫是增强证据，不阻断失败路径本身）
  }
  const candidates: WideScanCandidate[] = [];
  for (const [ref, e] of Object.entries(pool)) {
    let hint: string | undefined = undefined;
    try {
      const suggestions = suggestHints(e, pool);
      if (suggestions.length > 0) hint = suggestions[0]!;
    } catch {
      hint = undefined;   // 生成失败 = 该行无 hint（宁可少给，不给不自证的词面）
    }
    candidates.push({ ref, tag: e.tag, label: e.label, ...(hint !== undefined ? { hint } : {}) });
  }
  return { window: WIDE_POOL_ELEMENTS, pool_size: candidates.length, candidates };
}
