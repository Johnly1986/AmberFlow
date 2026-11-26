/**
 * `amber session` 运行时 · act scroll 分支的**执行体**（S 组拆分）。
 *
 * 从 session-runtime.ts 提取（maintain 门禁：主文件与 doAct 是只减不增的存量基线）：
 * B2 的三种语义（容器/滚入视口/文档滚动）与 S1 的 rows 行容器寻址**整段**搬到这里，
 * 会话类只保留参数校验与一次委托调用——语义、证据字段、轨迹键逐字节不变。
 *
 * 本模块另外收口两件「滚的是谁」的事：
 *   - **容器寻址有两个写法**：`rows`（行选择器）与 `selector`（CSS 容器选择器）走**同一条**
 *     容器路径（最近可滚动祖先 + 帧序 + 信封 + 几何证据）。`selector` 在 act 面是 CSS 查询面，
 *     不是 hint；把它当 hint 或忽略它都会让「按指定容器滚动」退化成别的容器。
 *   - **证据必须点名容器**：`scroll_target` + `scroll_target_source`
 *     （`explicit` = 调用方点名 / `rows` = 按 rows 派生 / `fallback` = 引擎自己挑的）；
 *     兜底在多个候选里挑一个时再带 `ambiguous_candidates`，让「引擎替我挑了个容器」无法被
 *     读成「按我说的滚了」。
 */
import { isSyntheticScrollTarget } from "./ctx.ts";
import { scrollRowsToImpl, type RowsScrollProbe } from "./ctx-runtime.ts";
import { takeHintMatchOthers } from "../engine/rules.ts";
import { urlOf } from "../engine/extraction.ts";
import { sleepMs } from "../support/sleep.ts";
import type { AmbiguityView } from "../engine/ambiguity.ts";
import type { BrowserMiddleware, AnyPage } from "../engine/executor.ts";
import { type SessionActOp, type SessionScrollOut } from "./session-runtime-contract.ts";
import { actAmbiguity, ambiguityRecord, ambiguityResponse, failureScreenshot, missDiagnosticsResponse, observeAfter, scrollStrategyFacts } from "./session-runtime-evidence.ts";
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

/** 滚动面来源闭集（证据字段 `scroll_target_source` 的唯一取值面）。 */
export type ScrollTargetSource = "explicit" | "rows" | "fallback";

/** act scroll 的两种容器寻址写法（同一实现；`selector` 是 CSS 容器面，`rows` 是行面）。 */
type ContainerField = "rows" | "selector";

/** 一次容器滚动的入参（校验已在 doActScroll 完成；这里只执行与回显）。 */
interface ContainerScrollArgs {
  req: Record<string, unknown>;
  actOp: SessionActOp;
  toDir: "bottom" | "top" | "page" | undefined;
  by: number | undefined;
  /** 已归一（去空白）的容器选择器 + 它来自哪个字段。 */
  container: { selector: string; field: ContainerField };
  recordHints: string[];
  deps: ScrollDeps;
}

/** `SessionScrollOut` + 引擎在合成目标路径上会回带的容器事实（`container` 仅兜底时出现）。 */
type ScrollOutWithSurface = SessionScrollOut & { container?: string };

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
 *
 * 循环的最后一轮**总是**"停在原地的停滞步"（`moved:false`/`delta:0`：已经到头了，再写一次
 * scrollTop 不动）。把那一轮原样当结果回显，一次真的滚到底就会被报成"没滚"——所以证据按
 * **首轮起点 → 最终位置**合成：`moved`/`delta` 是整段动作的实测位移，几何取最终读数。
 */
export async function scrollRowsBottomBounded(
  page: AnyPage, hosts: string[] | null, rowsSel: string,
): Promise<RowsScrollOutcome> {
  let rounds = 0;
  let probe: RowsScrollProbe = { ok: false, zeroRows: true };
  let startTop: number | undefined;
  while (rounds < 50) {
    rounds += 1;
    const step = await scrollRowsOnce(page, hosts, rowsSel, "page");
    if (step.zeroRows === true) return { probe: step, rounds };
    if (step.notScrollable === true) return { probe: step, rounds };
    probe = step;
    // 首轮起点 = 本轮 scrollTop - delta（`delta` 就是 after-before，同一个读数对）。
    if (startTop === undefined && typeof step.scrollTop === "number" && typeof step.delta === "number") {
      startTop = step.scrollTop - step.delta;
    }
    if (step.atBottom === true || step.moved === false) break;
    await sleepMs(150);   // 与容器滚动 settle 同款间隔，给懒加载一拍
  }
  if (startTop === undefined || typeof probe.scrollTop !== "number") return { probe, rounds };
  return { probe: { ...probe, moved: probe.scrollTop !== startTop, delta: probe.scrollTop - startTop }, rounds };
}

/**
 * 容器滚动（`rows` / `selector` 同一条路径）的完整执行体与证据。
 *
 * 两条失败分支的文案以 `container.field` 起头（`rows selector …` / `selector …`）：
 * 报错必须点名**调用方实际写的那个字段**，否则读者会去改一个没写过的参数。
 */
async function scrollViaContainer(args: ContainerScrollArgs): Promise<Record<string, unknown>> {
  const { req, actOp, toDir, by, container, recordHints, deps } = args;
  const { page, hosts } = deps;
  const started = deps.startedAt;
  const target = container.selector;
  const label = `${container.field} selector`;
  // 两种写法都不走 hint 解析，但清场纪律与其它路径一致。
  takeHintMatchOthers();
  const outcome = toDir === "bottom" && by === undefined
    ? await scrollRowsBottomBounded(page, hosts, target)
    : { probe: await scrollRowsOnce(page, hosts, target, toDir ?? "bottom", by) };
  const probe = outcome.probe;
  // 证据：谁被滚 + 谁点的（rows 是"按行派生"，selector 是"调用方直接点名 CSS 容器"）。
  const surface = {
    scroll_target: target,
    scroll_target_source: (container.field === "rows" ? "rows" : "explicit") as ScrollTargetSource,
  };
  if (probe.zeroRows === true) {
    deps.recordAction({
      op: "scroll", target, ok: false, code: "target_not_found",
      ref: null, how: null, changed: false, ...surface, url: urlOf(page),
      ...(recordHints.length > 0 ? { observe_hints: recordHints } : {}),
    });
    return {
      ok: false, code: "target_not_found", executed: false,
      reason: `${label} ${JSON.stringify(target)} matched no elements (in any reachable frame)`,
      op: actOp, target, ...surface,
      ...(await failureScreenshot(deps.outDir, deps.log, page, deps.actionCount, req)),
    };
  }
  if (probe.notScrollable === true) {
    deps.recordAction({
      op: "scroll", target, ok: false, code: "not_scrollable",
      ref: null, how: null, changed: false, ...surface, url: urlOf(page),
      ...(recordHints.length > 0 ? { observe_hints: recordHints } : {}),
    });
    return {
      ok: false, code: "not_scrollable", executed: false,
      reason: `${label} ${JSON.stringify(target)} matched elements but no scrollable container found (nearest scrollable ancestor and document scrolling element are both not scrollable)`,
      op: actOp, target, ...surface,
      ...(await failureScreenshot(deps.outDir, deps.log, page, deps.actionCount, req)),
    };
  }
  const moved = probe.moved === true;
  const scroll = typeof probe.scrollTop === "number"
    && typeof probe.scrollHeight === "number" && typeof probe.clientHeight === "number"
    ? { scrollTop: probe.scrollTop, scrollHeight: probe.scrollHeight, clientHeight: probe.clientHeight }
    : undefined;
  deps.recordAction({
    op: "scroll", target,
    scroll_mode: "rows_container",
    ...(toDir === undefined ? {} : { to: toDir }), ...(by === undefined ? {} : { by }),
    ok: true, ref: null, how: "scrolled", changed: moved,
    moved,
    ...(probe.delta === undefined ? {} : { delta: probe.delta }),
    ...(typeof probe.scrollTop === "number" ? { scrollTop: probe.scrollTop } : {}),
    ...surface,
    url: urlOf(page),
    ...(recordHints.length > 0 ? { observe_hints: recordHints } : {}),
  });
  return {
    ok: true, op: actOp, target,
    executed: true, ref: null, how: "scrolled", changed: moved,
    moved,
    ...(probe.delta === undefined ? {} : { delta: probe.delta }),
    ...(scroll === undefined ? {} : { scroll }),
    ...surface,
    url: urlOf(page), elapsed_ms: Date.now() - started,
    ...(await observeAfter(deps.ctx(), req)),
  };
}

/**
 * `act scroll` 收到 `selector` 时的形状与互斥校验（返回 null = 按容器路径执行）。
 *
 * 只拒绝**语义冲突**，不发明第二种滚动语义：`selector` 与 `rows` 指同一件事（CSS 命中的
 * 元素的滚动容器），同时给两条不同选择器 = 声明歧义，不静默择一；`selector` 也不是
 * 「滚入视口」的目标，所以没有 `to`/`by` 时如实报 config_error 并把正确写法写进 reason。
 */
function containerSelectorProblem(
  req: Record<string, unknown>, actOp: SessionActOp, rowsSel: string | undefined,
  targetRaw: unknown, toDir: "bottom" | "top" | "page" | undefined, by: number | undefined,
): Record<string, unknown> | null {
  const raw = req["selector"];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      ok: false, code: "config_error", executed: false, op: actOp,
      reason: `act scroll.selector must be a non-empty CSS selector string when present (got ${JSON.stringify(raw)})`,
    };
  }
  const sel = raw.trim();
  if (rowsSel !== undefined && rowsSel.trim() !== sel) {
    return {
      ok: false, code: "config_error", executed: false, op: actOp, target: sel,
      reason: `act scroll takes one container, not two spellings of it: rows=${JSON.stringify(rowsSel)} vs selector=${JSON.stringify(sel)} — rows and selector are the same container path (nearest scrollable ancestor of the matched elements), so give only one`,
    };
  }
  if (nonEmpty(targetRaw)) {
    return {
      ok: false, code: "config_error", executed: false, op: actOp, target: sel,
      reason: `act scroll takes either target (hint) or selector/rows (CSS container), not both (got target=${JSON.stringify(targetRaw)}, selector=${JSON.stringify(sel)}) — a hint names an element, selector names the container to scroll`,
    };
  }
  if (by === undefined && req["by"] !== undefined) {
    return {
      ok: false, code: "config_error", executed: false, op: actOp, target: sel,
      reason: `act scroll.by must be a finite integer number of pixels (got ${JSON.stringify(req["by"])})`,
    };
  }
  if (toDir === undefined && by === undefined) {
    return {
      ok: false, code: "config_error", executed: false, op: actOp, target: sel,
      reason: "act scroll with selector needs to (bottom|top|page) or by (pixels): selector names the scroll container, it is not a scroll-into-view target — e.g. `act scroll selector=\"div[role=main]\" by=-400` (rows is the same field; omit selector to scroll the document)",
    };
  }
  return null;
}

/**
 * P1-D-2 兜底候选计数（只读、不滚动、不改页面）。
 *
 * 判据与 `scrollDocument` 的兜底同一条：`overflowY ∈ auto|scroll|overlay|hidden` 且
 * `scrollHeight-clientHeight > 2` 的前 4000 个元素。数不出来（evaluate 抛错/页面已走）
 * = undefined（缺键，绝不编一个数字）。
 */
async function countFallbackCandidates(page: AnyPage): Promise<number | undefined> {
  try {
    const raw = await page.evaluate(() => {
      type El = { scrollHeight: number; clientHeight: number };
      const g = globalThis as unknown as {
        document?: { querySelectorAll(s: string): { length: number; [i: number]: El } };
        getComputedStyle(el: El): { overflowY?: string | null } | null;
      };
      const doc = g.document;
      if (!doc) return null;
      const all = Array.prototype.slice.call(doc.querySelectorAll("*"), 0, 4000) as El[];
      let candidates = 0;
      for (const el of all) {
        const cs = g.getComputedStyle(el);
        const oy = String(cs === null || cs === undefined ? "" : cs.overflowY || "");
        if (oy !== "auto" && oy !== "scroll" && oy !== "overlay" && oy !== "hidden") continue;
        if ((Number(el.scrollHeight) || 0) - (Number(el.clientHeight) || 0) > 2) candidates += 1;
      }
      return { candidates };
    });
    const n = raw !== null && typeof raw === "object" ? Number((raw as Record<string, unknown>)["candidates"]) : NaN;
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * P1-D-2：合成/元素滚动路径的容器身份与来源。
 *
 * - `explicit`：调用方点名（`target` hint，或 page/document/body/html/window 合成名——
 *   后者滚的都是**主滚动器**，`scroll_target` 统一写成 `"document"`；调用方的原拼写仍由
 *   响应的 `target` 保留）；
 * - `fallback`：**引擎自己挑的**——调用方没给 target，或点名了文档但文档不可滚、引擎回退到
 *   内部容器。回退时 `scroll_target` 是实际滚动那个容器的稳定描述（`div#panel`），而响应里
 *   的 `target` 仍是调用方点名的名字：两条事实同时可见，不会被读成「按我说的滚了」。
 */
function scrollSurfaceFacts(out: SessionScrollOut, explicitName: string | undefined): Record<string, unknown> {
  const container = (out as ScrollOutWithSurface).container;
  if (typeof container === "string" && container !== "") {
    return { scroll_target: container, scroll_target_source: "fallback" as ScrollTargetSource };
  }
  if (explicitName === undefined) {
    return { scroll_target: "document", scroll_target_source: "fallback" as ScrollTargetSource };
  }
  if (isSessionSyntheticScrollTarget(explicitName)) {
    return { scroll_target: "document", scroll_target_source: "explicit" as ScrollTargetSource };
  }
  return { scroll_target: explicitName, scroll_target_source: "explicit" as ScrollTargetSource };
}

/**
 * P1-D-2：滚动面证据 + 兜底歧义计数。
 *
 * 只有**真的在候选里挑了一个**（引擎回带 `container`）才去数候选：文档自身滚了的时候
 * 候选只有一个（`document`），不是歧义，也就不该出现 `ambiguous_candidates`。
 */
async function scrollSurfaceEvidence(
  page: AnyPage, out: SessionScrollOut, explicitName: string | undefined,
): Promise<Record<string, unknown>> {
  const facts = scrollSurfaceFacts(out, explicitName);
  const container = (out as ScrollOutWithSurface).container;
  if (typeof container !== "string" || container === "") return facts;
  const candidates = await countFallbackCandidates(page);
  return candidates !== undefined && candidates > 1 ? { ...facts, ambiguous_candidates: candidates } : facts;
}

/**
 * act scroll 分支的完整执行体（B2 三语义 + S1 容器寻址）。会话层的校验（to/by 合法性、
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
  const { page } = deps;
  const started = deps.startedAt;
  // 容器寻址：`rows` 与 `selector` 是同一个面的两个名字（selector 是 CSS 容器选择器）。
  const selectorProblem = containerSelectorProblem(req, actOp, rowsSel, targetRaw, toDir, by);
  if (selectorProblem !== null) return selectorProblem;
  const selectorSel = nonEmpty(req["selector"]) ? String(req["selector"]).trim() : undefined;
  const container = rowsSel !== undefined
    ? { selector: String(rowsSel), field: "rows" as const }
    : selectorSel === undefined ? undefined : { selector: selectorSel, field: "selector" as const };
  const synthetic = container === undefined && (!nonEmpty(targetRaw) || isSessionSyntheticScrollTarget(String(targetRaw)));
  // B2：to/by 是**容器滚动**语义（元素自身或最近可滚动祖先，与 ctx.scrollList 同一条实现
  // `_scrollWithLoc`；找不到可滚动容器 = not_scrollable，不静默无操作）。不给 to/by =
  // 滚入视口语义，moved/delta 由引擎实测。
  const wantsContainer = toDir !== undefined || by !== undefined;
  // task-34：B1 旁路是**模块态**（最后一次解析者写）——先清场，避免把 record 观察或
  // 上一次动作的诊断算到本次头上。元素 scroll 仍走 hint 解析，故同样回显歧义。
  takeHintMatchOthers();
  // S1：容器形态走模块级 scrollRowsToImpl（与 ctx.collect 同一份容器判定；不进池、
  // 不做 hint 匹配）。
  if (container !== undefined) {
    return scrollViaContainer({ req, actOp, toDir, by, container, recordHints, deps });
  }
  const out: SessionScrollOut = synthetic
    ? await deps.mw().scrollDocument(
      page, toDir ?? "bottom",
      { ...(by === undefined ? {} : { by }) },
    )
    : await deps.mw().actOnce(page, String(targetRaw), "scroll", null, ambiguousMode,
      wantsContainer ? { ...(toDir === undefined ? {} : { to: toDir }), ...(by === undefined ? {} : { by }) } : undefined,
      { diagnostics: true, ...(rehydrateRescan ? { rehydrateRescan: true } : {}) });
  const scrollAmb = synthetic ? {} : actAmbiguity(String(targetRaw), out.ref ?? null, out.stopCode);
  // A2：只有元素 scroll（actOnce 分支）可能带歧义证据；合成目标走 scrollDocument，没有该键。
  const scrollAmbiguity: AmbiguityView | undefined = out.ambiguity;
  const scrollTarget = nonEmpty(targetRaw) ? String(targetRaw) : "document";
  // P1-D-2：滚的是谁 + 谁点的（兜底路径带 ambiguous_candidates）。
  const surface = out.ok === true
    ? await scrollSurfaceEvidence(page, out, nonEmpty(targetRaw) ? String(targetRaw) : undefined)
    : {};
  // B2：滚动语义进轨迹（export 按它还原成哪种原语）。
  const scrollMode: "container" | "into_view" = synthetic || wantsContainer ? "container" : "into_view";
  // B2：changed = **实测** moved（没有 moved 证据 = false，不假装滚过）。
  const moved = typeof out.moved === "boolean" ? out.moved : undefined;
  const delta = typeof out.delta === "number" ? out.delta : undefined;
  const scrollTop = typeof out.scrollTop === "number" ? out.scrollTop : undefined;
  const scrollFacts = scrollStrategyFacts(out);
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
    ...scrollFacts,
    ...surface,
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
    ...scrollFacts,
    ...surface,
    url: urlOf(page), elapsed_ms: Date.now() - started,
    ...scrollAmb,
    ...(await observeAfter(deps.ctx(), req)),
  };
}

/**
 * 会话面的合成滚动目标 = `ctx.scrollList` 的闭集 **加上 `page`**。
 *
 * 为什么只加在会话面：authoring 会话里"滚整页"是最常见的请求，而 `page` 不是元素池里的
 * 名字；把它当 hint 解析只会撞出某个不相干的 `.page` 容器并在其祖先上找滚动器（实测报告
 * `not_scrollable` 的能力墙）。flow 面的 `ctx.scrollList("page")` 语义**不动**——那里
 * 有 `document`/`body`/`html`/`window` 就够，改它会让既有脚本的目标变义。
 * 代价：会话面无法再用裸词 `page` 点名一个 label 恰为 "page" 的元素——那类元素用
 * `#id`/`[data-test=…]`/完整 label 形状寻址（与合成名的取舍在所有合成目标上一致）。
 */
function isSessionSyntheticScrollTarget(target: string): boolean {
  return target.trim().toLowerCase() === "page" || isSyntheticScrollTarget(target);
}

/** 与会话契约同判的非空字符串（局部复刻，避免循环依赖；语义与 nonEmpty 逐字节一致）。 */
function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** displayHow/actAmbiguity 等证据 helper 的再导出（消费面单一 import 口）。 */
export { displayHow, actAmbiguity } from "./session-runtime-evidence.ts";
