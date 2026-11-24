/**
 * `amber session` 运行时 · act scroll 分支的**执行体**（S 组拆分）。
 *
 * 从 session-runtime.ts 提取（maintain 门禁：主文件与 doAct 是只减不增的存量基线）：
 * B2 的三种语义（容器/滚入视口/文档滚动）与 S1 的 rows 行容器寻址**整段**搬到这里，
 * 会话类只保留参数校验与一次委托调用——语义、证据字段、轨迹键逐字节不变。
 */
import { isSyntheticScrollTarget } from "./ctx.ts";
import { scrollRowsToImpl, type RowsScrollProbe } from "./ctx-runtime.ts";
import { takeHintMatchOthers } from "../engine/rules.ts";
import { urlOf } from "../engine/extraction.ts";
import { sleepMs } from "../support/sleep.ts";
import type { AmbiguityView } from "../engine/ambiguity.ts";
import type { BrowserMiddleware, AnyPage } from "../engine/executor.ts";
import { type SessionActOp, type SessionScrollOut } from "./session-runtime-contract.ts";
import {
  actAmbiguity, ambiguityRecord, ambiguityResponse, displayHow, failureScreenshot, missDiagnosticsResponse, observeAfter,
} from "./session-runtime-evidence.ts";
import type { Ctx } from "./ctx.ts";

/** scroll 分支的会话侧依赖（会话类的窄接口投影，不把整个类拖进模块）。 */
export interface ScrollDeps {
  page: AnyPage;
  hosts: string[] | null;
  outDir: string;
  actionCount: number;
  startedAt: number;
  log(line: string): void;
  recordAction(entry: Record<string, unknown>): void;
  mw(): BrowserMiddleware;
  ctx(): Ctx;
}

/** S1 rows 滚动的探测结果（单步直写或有界循环后的最终事实）。 */
export interface RowsScrollOutcome {
  probe: RowsScrollProbe;
  rounds?: number;
}

/**
 * S1：rows 形态的单次滚动（单步直写；bottom 的有界循环在 `scrollRowsBottomBounded`）。
 * 行零命中/不可滚原样返回 probe，调用方按既有停因码闭环。
 */
export async function scrollRowsOnce(
  page: AnyPage, hosts: string[] | null, rowsSel: string,
  to: "bottom" | "top" | "page", by?: number,
): Promise<RowsScrollProbe> {
  return scrollRowsToImpl(() => Promise.resolve(page), hosts, rowsSel, to, by);
}

/**
 * S1：`to:"bottom"` 的有界循环步进——每轮 ~0.9 屏 + 150ms settle，滚到 `atBottom`
 * 即停；≤50 轮上限防懒加载无限流挂死。懒加载页滚到中途会加载新行，单次直写
 * 到底会跳过中途内容。
 */
export async function scrollRowsBottomBounded(
  page: AnyPage, hosts: string[] | null, rowsSel: string,
): Promise<RowsScrollOutcome> {
  let rounds = 0;
  let probe: RowsScrollProbe = { ok: false, zeroRows: true };
  while (rounds < 50) {
    rounds += 1;
    const step = await scrollRowsOnce(page, hosts, rowsSel, "page");
    if (step.zeroRows === true) return { probe: step, rounds };
    if (step.notScrollable === true) return { probe: step, rounds };
    probe = step;
    if (step.atBottom === true || step.moved === false) break;
    await sleepMs(150);   // 与容器滚动 settle 同款间隔，给懒加载一拍
  }
  return { probe, rounds };
}

/**
 * act scroll 分支的完整执行体（B2 三语义 + S1 rows）。会话层的校验（to/by 合法性、
 * rows 互斥）已在此前完成；这里只执行与回显，返回值即 HTTP 面的一行响应。
 */
export async function doActScroll(
  req: Record<string, unknown>,
  actOp: SessionActOp,
  toDir: "bottom" | "top" | "page" | undefined,
  by: number | undefined,
  rowsSel: string | undefined,
  targetRaw: unknown,
  ambiguousMode: "fail" | "act",
  rehydrateRescan: boolean,
  recordHints: string[],
  deps: ScrollDeps,
): Promise<Record<string, unknown>> {
  const { page, hosts } = deps;
  const started = deps.startedAt;
  const wantRowsScroll = rowsSel !== undefined;
  const synthetic = !wantRowsScroll && (!nonEmpty(targetRaw) || isSyntheticScrollTarget(String(targetRaw)));
  // B2：to/by 是**容器滚动**语义（元素自身或最近可滚动祖先，与 ctx.scrollList 同一条实现
  // `_scrollWithLoc`；找不到可滚动容器 = not_scrollable，不静默无操作）。不给 to/by =
  // 滚入视口语义，moved/delta 由引擎实测。
  const wantsContainer = toDir !== undefined || by !== undefined;
  // task-34：B1 旁路是**模块态**（最后一次解析者写）——先清场，避免把 record 观察或
  // 上一次动作的诊断算到本次头上。元素 scroll 仍走 hint 解析，故同样回显歧义。
  takeHintMatchOthers();
  // S1：rows 形态走模块级 scrollRowsToImpl（与 ctx.collect 同一份容器判定；不进池、
  // 不做 hint 匹配）。
  if (wantRowsScroll) {
    const rowsSelStr = String(rowsSel);
    takeHintMatchOthers();   // rows 不走 hint 解析，但清场纪律与其它路径一致
    const outcome = toDir === "bottom" && by === undefined
      ? await scrollRowsBottomBounded(page, hosts, rowsSelStr)
      : { probe: await scrollRowsOnce(page, hosts, rowsSelStr, toDir ?? "bottom", by) };
    const probe = outcome.probe;
    if (probe.zeroRows === true) {
      deps.recordAction({
        op: "scroll", target: rowsSelStr, ok: false, code: "target_not_found",
        ref: null, how: null, changed: false, url: urlOf(page),
        ...(recordHints.length > 0 ? { observe_hints: recordHints } : {}),
      });
      return {
        ok: false, code: "target_not_found", executed: false,
        reason: `rows selector ${JSON.stringify(rowsSelStr)} matched no elements (in any reachable frame)`,
        op: actOp, target: rowsSelStr,
        ...(await failureScreenshot(deps.outDir, deps.log, page, deps.actionCount, req)),
      };
    }
    if (probe.notScrollable === true) {
      deps.recordAction({
        op: "scroll", target: rowsSelStr, ok: false, code: "not_scrollable",
        ref: null, how: null, changed: false, url: urlOf(page),
        ...(recordHints.length > 0 ? { observe_hints: recordHints } : {}),
      });
      return {
        ok: false, code: "not_scrollable", executed: false,
        reason: `rows selector ${JSON.stringify(rowsSelStr)} matched elements but no scrollable container found (nearest scrollable ancestor and document scrolling element are both not scrollable)`,
        op: actOp, target: rowsSelStr,
        ...(await failureScreenshot(deps.outDir, deps.log, page, deps.actionCount, req)),
      };
    }
    const rowsMoved = probe.moved === true;
    const rowsScroll = typeof probe.scrollTop === "number"
      && typeof probe.scrollHeight === "number" && typeof probe.clientHeight === "number"
      ? { scrollTop: probe.scrollTop, scrollHeight: probe.scrollHeight, clientHeight: probe.clientHeight }
      : undefined;
    deps.recordAction({
      op: "scroll", target: rowsSelStr,
      scroll_mode: "rows_container",
      ...(toDir === undefined ? {} : { to: toDir }), ...(by === undefined ? {} : { by }),
      ok: true, ref: null, how: "scrolled", changed: rowsMoved,
      moved: rowsMoved,
      ...(probe.delta === undefined ? {} : { delta: probe.delta }),
      ...(typeof probe.scrollTop === "number" ? { scrollTop: probe.scrollTop } : {}),
      url: urlOf(page),
      ...(recordHints.length > 0 ? { observe_hints: recordHints } : {}),
    });
    return {
      ok: true, op: actOp, target: rowsSelStr,
      executed: true, ref: null, how: "scrolled", changed: rowsMoved,
      moved: rowsMoved,
      ...(probe.delta === undefined ? {} : { delta: probe.delta }),
      ...(rowsScroll === undefined ? {} : { scroll: rowsScroll }),
      url: urlOf(page), elapsed_ms: Date.now() - started,
      ...(await observeAfter(deps.ctx(), req)),
    };
  }
  const out: SessionScrollOut = synthetic
    ? await deps.mw().scrollDocument(
      page, toDir ?? "bottom",
      { ...(by === undefined ? {} : { by }) },
    )
    : await deps.mw().actOnce(page, String(targetRaw), "scroll", null, ambiguousMode,
      wantsContainer ? { ...(toDir === undefined ? {} : { to: toDir }), ...(by === undefined ? {} : { by }) } : undefined,
      { diagnostics: true, ...(rehydrateRescan ? { rehydrateRescan: true } : {}) });
  const scrollAmb = synthetic ? {} : actAmbiguity(String(targetRaw), out.ref ?? null);
  // A2：只有元素 scroll（actOnce 分支）可能带歧义证据；合成目标走 scrollDocument，没有该键。
  const scrollAmbiguity: AmbiguityView | undefined = out.ambiguity;
  const scrollTarget = nonEmpty(targetRaw) ? String(targetRaw) : "document";
  // B2：滚动语义进轨迹（export 按它还原成哪种原语）。
  const scrollMode: "container" | "into_view" = synthetic || wantsContainer ? "container" : "into_view";
  // B2：changed = **实测** moved（没有 moved 证据 = false，不假装滚过）。
  const moved = typeof out.moved === "boolean" ? out.moved : undefined;
  const delta = typeof out.delta === "number" ? out.delta : undefined;
  const scrollTop = typeof out.scrollTop === "number" ? out.scrollTop : undefined;
  deps.recordAction({
    op: "scroll", target: scrollTarget,
    // B2：只记**实际发生的事实**——没走通的滚动不记方向/语义；没请求 to/by 的元素滚动
    // 不伪记 to:"bottom"（"滚入视口"不是一次方向滚动）。
    ...(out.ok === true ? { scroll_mode: scrollMode } : {}),
    ...(out.ok === true && wantsContainer
      ? { ...(toDir === undefined ? {} : { to: toDir }), ...(by === undefined ? {} : { by }) }
      : {}),
    ok: out.ok === true,
    ...(out.ok === true ? {} : { code: String(out.stopCode ?? "not_scrollable") }),
    ref: null, how: out.ok === true ? "scrolled" : null,
    changed: moved === true,
    ...(moved === undefined ? {} : { moved }),
    ...(delta === undefined ? {} : { delta }),
    ...(scrollTop === undefined ? {} : { scrollTop }),
    url: urlOf(page),
    ...ambiguityRecord(scrollAmbiguity),
    ...(recordHints.length > 0 ? { observe_hints: recordHints } : {}),
  });
  if (out.ok !== true) {
    return {
      ok: false, code: String(out.stopCode ?? "not_scrollable"), reason: String(out.reason ?? "scroll failed"),
      op: actOp, target: scrollTarget, executed: false,
      ...scrollAmb,
      ...ambiguityResponse(scrollAmbiguity),
      ...missDiagnosticsResponse(out.diagnostics),
      ...(await failureScreenshot(deps.outDir, deps.log, page, deps.actionCount, req)),
    };
  }
  const scroll = typeof scrollTop === "number"
    && typeof out.scrollHeight === "number" && typeof out.clientHeight === "number"
    ? { scrollTop, scrollHeight: out.scrollHeight, clientHeight: out.clientHeight }
    : undefined;
  return {
    ok: true, op: actOp, target: scrollTarget,
    executed: true, ref: null, how: "scrolled",
    changed: moved === true,
    ...(moved === undefined ? {} : { moved }),
    ...(delta === undefined ? {} : { delta }),
    ...(scroll === undefined ? {} : { scroll }),
    url: urlOf(page), elapsed_ms: Date.now() - started,
    ...scrollAmb,
    ...(await observeAfter(deps.ctx(), req)),
  };
}

/** 与会话契约同判的非空字符串（局部复刻，避免循环依赖；语义与 nonEmpty 逐字节一致）。 */
function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** displayHow/actAmbiguity 等证据 helper 的再导出（消费面单一 import 口）。 */
export { displayHow, actAmbiguity } from "./session-runtime-evidence.ts";
