/**
 * 会话 act 面的 **DRF 段**（声明-DOM 解析）：`actOnce → _resolveOne` 在池 / `#id` 直查 / A3
 * 回退 / 重扫全落空之后调用本模块。
 *
 * 为什么单独成模块：run 面每步在 `executor.run()` 里建 resolver（`runDeclaredTargets` /
 * `runDeclaredHint`），会话 act 的解析链是 `_resolveOne`——两条链共用同一份解析与文案
 * （`declared-targets.tryDeclared` → `declared.ts`），但 `_resolveOne` 原本没有 DRF 段，
 * 于是 `ExecutorOptions.targetResolution` 对会话面是空转。本模块把会话面的那一段收在一处：
 *
 *   - `off`/未声明 = **一个字节都不多走**（第一句就 null：零页面往返、零新键、既有落空路径
 *     与 stopCode 不变）；
 *   - 每次调用建**一次性** resolver（去重集合只覆盖本次，不跨调用泄漏）；命中把
 *     `cleanupDeclared` 交给调用方（`actOnce` 收尾时 await，页面侧临时章不残留）；歧义/落空
 *     由 `declaredLookup` 内部自行清章；
 *   - 歧义 = 结构化 `target_ambiguous` 且**零动作**（绝不猜）；
 *   - 落空 = null，并带回页内 pass 求值失败事实（`declared.ts` 的诊断字段，供 reason 回显）。
 */
import { createDeclaredTargetsResolver } from "./declared-targets.ts";
import { _hintOpts } from "./executor-resolve-a.ts";
import type { AnyLoc, AnyPage } from "./executor-types.ts";
import type { Elem } from "./extraction.ts";
import type { BrowserMiddleware } from "./executor.ts";

export type DeclaredActAttempt =
  | { kind: "hit"; ref: string; el: Elem; loc: AnyLoc; cleanup: () => Promise<void> }
  | { kind: "ambiguous"; reason: string }
  | { kind: "miss"; evalFailed: ReadonlyArray<{ frame: number; reason: string }> };

/**
 * 一次会话 act 面的 DRF 尝试。返回值即调用方的分支依据；`null` = 没走（`off`/未声明）。
 * 调用方：命中必须把 `cleanup` 交给动作收尾（`actOnce` 已 await 该字段）。
 */
export async function _declaredActFallback(
  mw: BrowserMiddleware, page: AnyPage, target: string, op: string,
): Promise<DeclaredActAttempt | null> {
  if (!mw.targetResolutionDeclared) return null;
  const targets = createDeclaredTargetsResolver({
    pg: page,
    // 会话 act 面没有步序概念：不传 stepNo（停因文案不提步号，绝不编 0）。
    // 会话面没有 skipped 账本：歧义候选身份已经写在停因 reason 里（formatDeclaredCandidates）。
    noteSkipped: () => { /* no-op：本面不记 skipped */ },
    hintOpts: () => _hintOpts(mw), surfacePolicy: mw.surfacePolicy,
    frameHosts: mw._frameHosts, targetResolutionDeclared: true,
  });
  const got = await targets.tryDeclared(target, op);
  if (targets.declaredStop !== null) {
    await targets.cleanupDeclared();
    return { kind: "ambiguous", reason: targets.declaredStop.reason };
  }
  if (got === null) return { kind: "miss", evalFailed: targets.declaredMiss?.eval_failed ?? [] };
  const loc = await mw._locatorFor(page, got.el);
  if (loc === null) {
    await targets.cleanupDeclared();
    return { kind: "miss", evalFailed: [] };
  }
  return { kind: "hit", ref: got.ref, el: got.el, loc, cleanup: () => targets.cleanupDeclared() };
}

/** DRF 页内 pass 求值失败的 reason 尾缀（无失败 = 空串，不改变既有文案）。 */
export function _declaredEvalFailedNote(evalFailed: ReadonlyArray<{ frame: number; reason: string }>): string {
  if (evalFailed.length === 0) return "";
  return `；declared-DOM 解析的页内脚本在 ${evalFailed.length} 个帧里求值失败（`
    + evalFailed.map((f) => `frame=${f.frame} ${JSON.stringify(f.reason)}`).join("；")
    + "）——这些帧里 DRF 根本没跑起来，不是页面事实";
}
