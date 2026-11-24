/**
 * 执行器实现模块（从 executor.ts 切分，大文件拆分 X1）：本文件函数都是
 * `BrowserMiddleware` 的实现片段，显式接收 `mw` 实例（唯一执行循环仍在 executor.ts）。
 */
import { sleep } from "../support/sleep.ts";
import { type AmbiguityView } from "./ambiguity.ts";
import { type ActMissDiagnostics, describeActionError, firstLoc } from "./executor-pure.ts";
import { takeAncestorRetarget } from "./executor-actionability.ts";
import { executePoollessAction } from "./executor-poolless-ops.ts";
import { _executeElement } from "./executor-resolve-a.ts";
import { _resolveOne, _resolveOneWithLock, type ActLock } from "./executor-resolve-b.ts";
import { type ActionabilityDetail, type AnyLoc, type AnyPage } from "./executor-types.ts";
import { scrollGeoOf } from "./executor.ts";
import { type Elem, urlOf } from "./extraction.ts";
import { type RangeOptions, type RangeOutcome, type RangeValue, applyRange } from "./range.ts";
import type { BrowserMiddleware } from "./executor.ts";
import type { ScrollEvidence } from "./executor.ts";

/** B1 探针失败的结构化结果（`classifyProbeOutcome` 的返回形状；`actionOnce` 直接消费）。 */
interface ProbeStop {
  code: string;
  reason: string;
  detail: ActionabilityDetail | null;
  /** 超时收尾且 URL 未变：点击**可能已派发**（未知）——调用方回 `execution_state:"unknown"`。 */
  dispatch?: "unknown";
}

/**
 * 可动作性探针的**结果分类**（`actOnce` 的 `occlusionProbe` 分支唯一实现体）。
 *
 * 为什么单独成函数：探针返回串有四种命运（已点击 / 已派发但报异常 / 已知失败 / 超时），
 * 每种背后是不同的事实归属，混在动作主流程里既读不懂也数不清。这里只做分类，不做动作。
 *
 * 超时对账（`action-timeout`）：URL 已变 = 点击已在途中生效 → 按已点击返回（不补点）；
 * URL 未变 = **未知**（`dispatch:"unknown"`），绝不把"不知道"说成没执行——破坏性动作会
 * 因此被重复执行。URL 基线由调用方给（`null` = 未测，按未知处置）。
 */
async function classifyProbeOutcome(
  mw: BrowserMiddleware, page: AnyPage, loc: AnyLoc, probe: string | null, urlBefore: string | null,
): Promise<{ how: "clicked" | null; navigated: boolean; stop: ProbeStop | null }> {
  if (probe === "__clicked__") {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 });
    } catch {
      /* the page may never fire it; the action already happened */
    }
    return { how: "clicked", navigated: false, stop: null };
  }
  if (probe === null) {
    // 非 timeout 异常：click 可能已派发——**不补点**；URL 变了就按已点击记。
    if (urlBefore !== null && urlOf(page) !== urlBefore) return { how: "clicked", navigated: true, stop: null };
    return {
      how: null, navigated: false,
      stop: { code: "action_failed", reason: mw._lastProbeError ?? "click failed (probe returned no result)", detail: null },
    };
  }
  if (probe === "stale_ref") {
    return { how: null, navigated: false, stop: { code: "stale_ref", reason: "stale_ref", detail: null } };
  }
  // 失败串是既有 skip_reason 词面：`code` 取冒号前 token，`reason` 保留原文。
  const cut = probe.indexOf(":");
  const code = cut > 0 ? probe.slice(0, cut) : probe;
  const detail = code === "not-actionable-or-covered"
    ? mw._takeActionabilityDetail()
    : await mw._readActionabilityDetail(loc, probe);
  if (code === "action-timeout" && mw._lastTimeoutNavigated === true) {
    return { how: "clicked", navigated: true, stop: null };
  }
  return {
    how: null, navigated: false,
    stop: { code, reason: probe, detail, ...(code === "action-timeout" ? { dispatch: "unknown" as const } : {}) },
  };
}


  /**
   * A3 `mw.actOnce`：**单动作**解析 + 执行（不评估 done、不占 flow 预算、不写 trace）。
   *
   * 列表展开/滚动这类原语内部要重复"点一次"，每次点击都走完整 `run()` 会重新判完成、
   * 重新承担子目标停因，既贵又语义错位。actOnce 只做"解析一个可动作候选并执行一次"，
   * 证据口径与 A1 的动作 trace 一致（stale_ref/needs_value/action_failed… 都是结构化结果）。
   */
export async function actOnce(mw: BrowserMiddleware, // task-33（`amber session` authoring 面）：op 类型**加宽** `"hover"`——`_executeElement`
    // 的 hover 分支早已存在（hover 原语只移动指针、不点击），这里只是让单动作面能透传它。
    // 纯类型加宽、零行为变化：所有既有调用点只传原有字面量，hover 在加宽前不可达。
    page: AnyPage, target: string, op: "click" | "check" | "fill" | "select" | "scroll" | "drag" | "hover" = "click",
    bind?: { value: unknown; byValue?: boolean } | null,
    // A2：单动作面的歧义策略（只影响**解析失败面**的形状）。缺省/`"act"` = 既有行为
    // （可行动优先取 refs[0] 直接执行）——run 原语与 ctx.scrollList 内部点击都不传它；
    // `"fail"` = 命令步同一个歧义谓词成立时零动作 + 结构化 target_ambiguous + `ambiguity` 证据。
    onAmbiguous?: "fail" | "act",
    /**
     * B2：`op:"scroll"` 的方向原语。**给 to/by = 容器滚动**（元素自身或最近可滚动祖先，
     * 走 `_scrollContainerForElement`→`_scrollWithLoc`，与 `ctx.scrollList` 同一条实现）；
     * **省略 = 旧语义「把元素滚入视口」**（`scrollIntoViewIfNeeded`），但 moved/delta 是
     * 实测的。与 A2 正交：歧义判定仍在解析阶段（`_resolveOne`）先发生，零动作语义不变。
     */
    scroll?: { to?: "bottom" | "top" | "page"; by?: number },
    /**
     * B1：单动作面的**被遮挡证据**（只有会话 `act` 的 click/check 传 `{occlusionProbe:true}`）。
     * 打开时点击本身走 `occludedReason`（探针即点击，800ms 快路径 + 5s 慢元素重试），不再调
     * `_clickOnly`——不存在"预检后再点"的双点窗口。省略 = 缺省 `_clickOnly` 路径逐字节不变
     * （run 命令步 / `ctx.expand` / `ctx.scrollList` 都不传）。
     *
     * A4：`diagnostics:true` 只在**会话 act** 面传——落空（`target_not_found`）时多带
     * `diagnostics` 并在 reason 末尾追加一行判别。省略 = 返回值与 reason 逐字节不变
     * （`ctx.expand` 等既有调用面不传）。
     *
     * F72：重扫**缺省自动**——首次解析落空且页面未静默（settle timedOut）时做一次有界
     * 重扫（等 2s 重抽池重解析同一 hint，至多 1 次）；命中 = `resolved_via:"rehydrate-rescan"`。
     * `rehydrateRescan:true` 声明仍被接受（兼容，不再有额外效果）；settle 关闭/结论缺失
     * 时门控信号不存在，重扫永不触发。
     */
    opts?: { occlusionProbe?: boolean; diagnostics?: boolean; rehydrateRescan?: boolean; lock?: ActLock },): Promise<{
    ok: boolean; how?: string; ref?: string; changed?: boolean;
    moved?: boolean; delta?: number; scrollTop?: number; scrollHeight?: number; clientHeight?: number;
    stopCode?: string; reason?: string; ambiguity?: AmbiguityView;
    /** A4：落空（`target_not_found`）判别证据；只有 `opts.diagnostics` 才出现。 */
    diagnostics?: ActMissDiagnostics;
    /** B1：失败现场（`not-actionable-or-covered` / `action-timeout` 才有）。 */
    actionability?: ActionabilityDetail;
    /** B1：非 timeout 异常后 URL 已变 = 点击已发生（不补点，如实记）。 */
    probe_navigated?: boolean;
    /**
     * 动作派发的**真相**（不是 ok 的同义词）：`executed` = 已派发并观察到；
     * `unknown` = 超时收尾且 URL 未变（派发与否都可能）——调用方必须把它当未知，
     * 绝不据此重试破坏性动作，也绝不冒充 `executed:false`。
     */
    execution_state?: "executed" | "unknown";
    /** E1-c/F72/AX 回退：`#id` 直查兜底 / rehydrate 重扫 / AX 回退命中时出现（additive；其余路径键集不变）。 */
    resolved_via?: "live-dom-id-fallback" | "rehydrate-rescan" | "ax-fallback" | "actionable-ancestor" | "nested-fold" | "ref-lock";
  }> {
    const resolved = await _resolveOneWithLock(mw, page, target, op, onAmbiguous, opts);
    if ("error" in resolved) {
      return {
        ok: false,
        stopCode: resolved.stopCode ?? "target_not_found",
        reason: resolved.error,
        ...(resolved.ambiguity === undefined ? {} : { ambiguity: resolved.ambiguity }),
        ...(resolved.diagnostics === undefined ? {} : { diagnostics: resolved.diagnostics }),
      };
    }
    const { ref, el, loc, cleanup } = resolved;
    // E1-c：解析通道证据（additive）——只有 `#id` 直查兜底命中的那次动作才带。
    const resolvedVia = "resolvedVia" in resolved ? resolved.resolvedVia : undefined;
    // B2：滚动请求是否走容器语义（to/by 任一给值）。其余 op 不认 scroll 参数。
    const wantContainer = op === "scroll" && scroll !== undefined
      && (scroll.to !== undefined || scroll.by !== undefined);
    // 快照 diff 只服务非 scroll 的 changed；scroll 的 changed 是实测的 moved（不做两次无用的
    // innerText/values 快照——那正是旧路径"只能硬编码 true"的原因）。
    const pre = op === "scroll" ? null : await mw.snapshot(page);
    let how: string | null = null;
    let arg: unknown = null;
    let scrollFact: { moved: boolean; delta: number; scrollTop?: number; scrollHeight?: number; clientHeight?: number } | null = null;
    let scrollStop: { stopCode: string; reason: string } | null = null;
    /** B1：被遮挡/超时的结构化失败（只有 `opts.occlusionProbe` 会产生）。 */
    let probeStop: ProbeStop | null = null;
    /** B1：探针返回 null 后 URL 已变 ⇒ 点击已发生（不补点）。 */
    let probeNavigated = false;
    try {
      if (op === "scroll") {
        // 元素目标的两种滚动语义（B2）：
        //   - 带 to/by = 容器滚动（自身或最近可滚动祖先；找不到可滚动容器 = not_scrollable，
        //     不静默无操作）；
        //   - 不带 to/by = 滚入视口（旧语义），moved/delta 实测。
        // 池外回退（el === null，如 0×0 目标）没有 Elem，但有已定位的 locator：容器面走
        // `_scrollWithLoc`、视口面走 `_scrollIntoViewWithEvidence`——同一实现，不猜元素。
        const sr = wantContainer
          ? (el === null
            ? await _scrollWithLoc(mw, page, loc, scroll!.to ?? "bottom", scroll!.by)
            : await _scrollContainerForElement(mw, page, el, scroll!.to ?? "bottom", scroll!.by))
          : (el === null
            ? await _scrollIntoViewWithEvidence(mw, page, loc)
            : await scrollIntoView(mw, page, el));
        if (sr.ok !== true) {
          scrollStop = {
            stopCode: sr.stopCode ?? (wantContainer ? "not_scrollable" : "action_failed"),
            reason: sr.reason ?? "scroll failed",
          };
        } else {
          how = "scrolled";
          scrollFact = {
            moved: sr.moved === true,
            delta: typeof sr.delta === "number" ? sr.delta : 0,
            ...scrollGeoOf(sr),
          };
        }
      } else if (el === null) {
        [how, arg] = await executePoollessAction(mw, page, loc, op, bind);   // 池外回退：按 op 分派
      } else if (op === "click" || op === "check") {
        if (opts?.occlusionProbe === true) {
          // B1：探针即点击——`occludedReason` 的快路径本身就是一次真点击，成功即"已点"，
          // 绝不再调 `_clickOnly`（无双点）。被遮挡 ~0.8s 报；未遮挡慢元素仍留 5s 重试。
          // 结果分类（含超时对账）在 classifyProbeOutcome（唯一实现体）。
          const classified = await classifyProbeOutcome(mw, page, loc,
            await mw.occludedReason(page, el, 800, 5000), pre === null ? null : pre.url);
          if (classified.how !== null) {
            how = classified.how;
            probeNavigated = classified.navigated;
          } else {
            probeStop = classified.stop;
          }
        } else {
          [how, arg] = await mw._clickOnly(page, el);
        }
      } else {
        [how, arg] = await _executeElement(mw, page, el,
          (bind?.value === undefined ? {} : { value: bind.value }), bind ?? null, op);
      }
    } catch (e) {
      if (cleanup !== undefined) await cleanup();
      return { ok: false, ref, stopCode: "action_failed", reason: describeActionError(e) };
    }
    if (cleanup !== undefined) await cleanup();
    // 容器面/视口面的失败在自己的闭集里（not_scrollable / stale_ref / action_failed），
    // 不进下面的 `how` 判定（那里只认动作执行器的既有关键词）。
    if (scrollStop !== null) {
      return { ok: false, ref, how: scrollStop.stopCode, stopCode: scrollStop.stopCode, reason: scrollStop.reason };
    }
    // B1：被遮挡 / 超时 / 探针异常的结构化失败——code 是既有 skip_reason 词面，不新增停因。
    if (probeStop !== null) {
      return {
        ok: false, ref, how: probeStop.code, stopCode: probeStop.code, reason: probeStop.reason,
        ...(probeStop.detail === null ? {} : { actionability: probeStop.detail }),
        ...(probeStop.dispatch === undefined ? {} : { execution_state: probeStop.dispatch }),
      };
    }
    const ok = how !== "stale_ref" && how !== "needs_value" && how !== "action_failed"
      && how !== "action_unsupported" && how !== null;
    const retargeted = takeAncestorRetarget(mw), viaField = resolvedVia !== undefined ? { resolved_via: resolvedVia } : (retargeted === null ? {} : { resolved_via: "actionable-ancestor" as const });
    if (!ok) return { ok: false, ref, how: String(how), stopCode: String(how ?? "action_failed"), reason: describeActionError(arg), ...viaField };
    if (op === "scroll") {
      const moved = scrollFact?.moved === true;
      const delta = scrollFact?.delta ?? 0;
      void loc;
      return {
        ok: true, how: String(how), ref, changed: moved, moved, delta,
        ...scrollGeoOf(scrollFact ?? {}),
        ...viaField,
      };
    }
    const post = await mw.snapshot(page);
    void loc;
    return {
      ok: true, how: String(how), ref, changed: JSON.stringify(pre) !== JSON.stringify(post),
      ...(probeNavigated ? { probe_navigated: true } : {}),
      ...viaField,
    };
  }

  /**
   * B2：元素目标的「滚入视口」**实测证据**。
   *
   * 旧路径（`_executeElement` 的 scroll 分支）调完 `scrollIntoViewIfNeeded` 就返回
   * `["scrolled", null]`——页面到底动没动没人知道，会话层只能硬编码 `changed:true`。
   * 这里在**同一次 page.evaluate** 里取滚动容器 scrollTop 前后差（元素自身/最近可滚动
   * 祖先 → 最后退回主滚动器），把 moved/delta 变成观察事实。
   *
   * 只加测量、不改滚动行为：调用的仍是同一个 `scrollIntoViewIfNeeded({block:"center",
   * behavior:"instant"})`（缺省）→ `scrollIntoView` 兜底，与 `_executeElement` 的 scroll
   * 分支是**同一次页面调用**；没有可滚动的容器/祖先时 moved:false（这不是失败——元素本来
   * 就在视口里）。
   */
export async function _scrollIntoViewWithEvidence(_mw: BrowserMiddleware, _page: AnyPage, loc: AnyLoc): Promise<ScrollEvidence> {
    let box: Record<string, unknown> | null = null;
    try {
      box = await firstLoc(loc).evaluate((node: any) => {
        // 浏览器侧执行（Node strip-types 下类型注释被擦除，源码原样进页面）。
        const g = globalThis as unknown as {
          document: { scrollingElement: any; documentElement: any; body: any };
          getComputedStyle: (x: any) => { overflowY: string; overflowX: string };
        };
        const doc = g.document;
        const scrollable = (x: any) => {
          if (!x || x === doc.body || x === doc.documentElement) return false;
          const cs = g.getComputedStyle(x);
          const oy = cs.overflowY, ox = cs.overflowX;
          const canY = (oy === "auto" || oy === "scroll" || oy === "overlay") && x.scrollHeight > x.clientHeight + 2;
          const canX = (ox === "auto" || ox === "scroll" || ox === "overlay") && x.scrollWidth > x.clientWidth + 2;
          return canY || canX;
        };
        // 观测面 = 元素自身到根的候选滚动器链（最近优先），最后兜底主滚动器：
        // 滚入视口可能滚祖先容器，也可能滚整个文档——哪个变了就报哪个。
        const chain: any[] = [];
        for (let p: any = node, k = 0; p && k < 32; k++, p = p.parentElement) {
          if (scrollable(p)) chain.push(p);
          if (p === doc.documentElement || p === doc.body) break;
        }
        const se = doc.scrollingElement ?? doc.documentElement ?? doc.body;
        if (se) chain.push(se);
        const before = chain.map((x) => Number(x.scrollTop) || 0);
        const el = node as { scrollIntoView(o?: unknown): void };
        const anyEl = node as { scrollIntoViewIfNeeded?: (o?: unknown) => void };
        if (typeof anyEl.scrollIntoViewIfNeeded === "function") {
          anyEl.scrollIntoViewIfNeeded({ block: "center", behavior: "instant" });
        } else {
          el.scrollIntoView({ block: "center", behavior: "instant" });
        }
        let picked: any = null;
        let delta = 0;
        for (let i = 0; i < chain.length; i++) {
          const now = Number(chain[i].scrollTop) || 0;
          if (now !== before[i]) { picked = chain[i]; delta = now - (before[i] as number); break; }
        }
        // 没有任何滚动发生：如实 moved:false；若链上确实有可滚动容器（最近的那个）就把它
        // 此刻的几何带出（"滚不动"是因为已到边界/已在视口，几何是证据不是猜测）。
        if (picked === null && chain.length > 0) picked = chain[0];
        return picked === null
          ? { ok: true, moved: false, delta: 0 }
          : {
            ok: true, moved: delta !== 0, delta,
            scrollTop: Number(picked.scrollTop) || 0,
            scrollHeight: Number(picked.scrollHeight) || 0,
            clientHeight: Number(picked.clientHeight) || 0,
          };
      }) as Record<string, unknown> | null;
    } catch (e) {
      return { ok: false, stopCode: "action_failed", reason: describeActionError(e) };
    }
    if (box === null || box["ok"] !== true) {
      return { ok: false, stopCode: "action_failed", reason: String(box?.["reason"] ?? "scrollIntoView failed") };
    }
    return {
      ok: true,
      moved: box["moved"] === true,
      delta: Number(box["delta"] ?? 0),
      ...(box["scrollTop"] === undefined ? {} : {
        scrollTop: Number(box["scrollTop"]),
        scrollHeight: Number(box["scrollHeight"] ?? 0),
        clientHeight: Number(box["clientHeight"] ?? 0),
      }),
    };
  }

  /**
   * B2 `mw.scrollIntoView`：把元素滚入视口并**如实**回有没有动（moved/delta + 容器几何）。
   *
   * 只服务会话单动作面（`actOnce`）；run 的命令步/原语路径仍走 `_executeElement` 的
   * scroll 分支，产物逐字节不变。
   */
export async function scrollIntoView(mw: BrowserMiddleware, page: AnyPage, el: Elem): Promise<ScrollEvidence> {
    const loc = await mw._locatorFor(page, el);
    if (loc === null) return { ok: false, stopCode: "stale_ref", reason: "the resolved element could not be located anymore" };
    return _scrollIntoViewWithEvidence(mw, page, loc);
  }

  /** A3：把元素（或最近可滚动祖先）滚到 to/by；纯 DOM scrollTop，不做滚轮模拟。 */
export async function _scrollContainerForElement(mw: BrowserMiddleware, page: AnyPage, el: Elem, to: "bottom" | "top" | "page", by?: number, settleMs = 150,): Promise<ScrollEvidence> {
    const loc = await mw._locatorFor(page, el);
    if (loc === null) return { ok: false, stopCode: "stale_ref", reason: "the resolved element could not be located anymore" };
    return _scrollWithLoc(mw, page, loc, to, by, settleMs);
  }

  /**
   * A3：对一个已定位的容器执行滚动（scrollContainer 的池外回退面也走它）。
   * B2：成功时如实带 `delta`（after - before，与 `moved` 同一对读数）——会话层要能
   * 回显「滚了多少」，而不是只知道"滚过"。
   */
export async function _scrollWithLoc(_mw: BrowserMiddleware, _page: AnyPage, loc: AnyLoc, to: "bottom" | "top" | "page", by?: number, settleMs = 150,): Promise<ScrollEvidence> {
    let box: Record<string, unknown> | null = null;
    try {
      box = await firstLoc(loc).evaluate((node: any, arg: { to: string; by?: number }) => {
        // `document`/`getComputedStyle` 跑在浏览器里，不在本仓 TS lib 面上：只就地声明用到的形状
        // （类型注释在 Node strip-types 下被擦除，函数源码进浏览器仍可执行）。
        const g = globalThis as unknown as {
          document: { body: unknown; documentElement: unknown };
          getComputedStyle: (x: any) => { overflowY: string; overflowX: string };
        };
        const doc = g.document;
        const scrollable = (x: any) => {
          if (!x || x === doc.body || x === doc.documentElement) return false;
          const cs = g.getComputedStyle(x);
          const oy = cs.overflowY, ox = cs.overflowX;
          const canY = (oy === "auto" || oy === "scroll" || oy === "overlay") && x.scrollHeight > x.clientHeight + 2;
          const canX = (ox === "auto" || ox === "scroll" || ox === "overlay") && x.scrollWidth > x.clientWidth + 2;
          return canY || canX;
        };
        let t: any = node;
        if (!scrollable(t)) {
          let p = node.parentElement;
          for (let k = 0; k < 32 && p; k++, p = p.parentElement) {
            if (scrollable(p)) { t = p; break; }
            if (p === doc.body) break;
          }
        }
        if (!t || !scrollable(t)) {
          // F49 风格的能力提示：not_scrollable 不是沉默失败——把祖先的 overflow 事实带出来，
          // 让 Agent 能区分「没有可滚动祖先」/「最近 overflow 祖先内容不溢出」/「页面用
          // overflow:hidden 程序化 scrollTop 的自定义滚动面板」。判据与 stopCode 语义不变
          // （标准滚动器只认 overflow:auto/scroll/overlay + 内容溢出）。
          const diag: Array<{ tag: string; cls: string; oy: string; sh: number; ch: number; prog: boolean }> = [];
          let p2: any = node.parentElement;
          for (let k = 0; k < 32 && p2 && diag.length < 3; k++, p2 = p2.parentElement) {
            if (p2 === doc.body || p2 === doc.documentElement) break;
            const cs2 = g.getComputedStyle(p2);
            if (cs2.overflowY === "visible") continue;
            const sh2 = Number(p2.scrollHeight) || 0;
            const ch2 = Number(p2.clientHeight) || 0;
            diag.push({
              tag: String(p2.tagName || "").toLowerCase(),
              cls: String(p2.className || "").split(/\s+/)[0] || "",
              oy: cs2.overflowY, sh: sh2, ch: ch2,
              prog: sh2 > ch2 + 2 && cs2.overflowY !== "clip",
            });
          }
          const fmt = diag.map((d) =>
            `${d.tag}${d.cls ? "." + d.cls : ""} overflow:${d.oy} ${d.sh}/${d.ch}`
            + (d.prog ? " (programmatically scrollable, not a standard scroller)" : "")).join("; ");
          const prog = diag.some((d) => d.prog);
          const why = diag.length === 0
            ? "no overflow ancestor (every ancestor is overflow:visible)"
            : `ancestors: ${fmt}`;
          const hint = prog
            ? " — the page likely uses a custom overflow:hidden scroll panel; the engine scrolls standard overflow:auto/scroll containers only (scroll a target inside one, or use ctx.scrollList(\"document\"))"
            : "";
          return {
            ok: false,
            reason: `no standard scrollable container found on the element or its ancestors — ${why}${hint}`,
          };
        }
        const before = t.scrollTop;
        const max = Math.max(0, t.scrollHeight - t.clientHeight);
        let next = before;
        if (typeof arg.by === "number") next = before + arg.by;
        else if (arg.to === "bottom") next = max;
        else if (arg.to === "top") next = 0;
        else if (arg.to === "page") next = Math.min(max, before + Math.max(1, Math.round(t.clientHeight * 0.9)));
        next = Math.max(0, Math.min(max, next));
        t.scrollTop = next;
        return { ok: true, before, scrollTop: t.scrollTop, scrollHeight: t.scrollHeight, clientHeight: t.clientHeight };
      }, { to, ...(by === undefined ? {} : { by }) }) as Record<string, unknown> | null;
    } catch (e) {
      return { ok: false, stopCode: "not_scrollable", reason: describeActionError(e) };
    }
    if (box === null || box["ok"] !== true) {
      return { ok: false, stopCode: "not_scrollable", reason: String(box?.["reason"] ?? "scroll failed") };
    }
    if (settleMs > 0) await sleep(settleMs);
    const scrollTop = Number(box["scrollTop"] ?? 0);
    const before = Number(box["before"] ?? 0);
    return {
      ok: true, scrollTop,
      scrollHeight: Number(box["scrollHeight"] ?? 0),
      clientHeight: Number(box["clientHeight"] ?? 0),
      moved: scrollTop !== before,
      delta: scrollTop - before,
    };
  }

  /**
   * A3 `mw.scrollContainer`：解析目标 hint → 元素自身或最近可滚动祖先 → 滚到 to/by。
   * 找不到可滚动容器 = 结构化 `not_scrollable`（不是静默无操作）。
   */
export async function scrollContainer(mw: BrowserMiddleware, page: AnyPage, target: string, to: "bottom" | "top" | "page" = "bottom",
    opts?: { by?: number; settleMs?: number },): Promise<ScrollEvidence> {
    const resolved = await _resolveOne(mw, page, target, "scroll");
    if ("error" in resolved) return { ok: false, stopCode: "target_not_found", reason: resolved.error };
    if (resolved.el !== null) {
      return _scrollContainerForElement(mw, page, resolved.el, to, opts?.by, opts?.settleMs ?? 150);
    }
    try {
      return await _scrollWithLoc(mw, page, resolved.loc, to, opts?.by, opts?.settleMs ?? 150);
    } finally {
      if (resolved.cleanup !== undefined) await resolved.cleanup();
    }
  }

  /**
   * F1：`ctx.scrollList` 的**合成滚动目标**（`"document" | "body" | "html" | "window"`，
   * 大小写不敏感）。这些名字不进元素池、不占池位：统一解析为 `document.scrollingElement`
   * （兜底 body → documentElement），执行与容器目标同一套滚动语义（to top/bottom/page
   * 或 by 像素 + settle 等待），如实返回 moved——不可滚（scrollHeight <= clientHeight，
   * 如短页）= `{ok:false, moved:false, stopCode:"not_scrollable"}`，绝不假成功。
   * 容器目标的既有路径（`scrollContainer` → `_scrollWithLoc`）逐字节不变。
   * B2：成功时带 `delta`（after - before），与 `_scrollWithLoc` 同一口径。
   */
export async function scrollDocument(_mw: BrowserMiddleware, page: AnyPage, to: "bottom" | "top" | "page" = "bottom",
    opts?: { by?: number; settleMs?: number },): Promise<ScrollEvidence> {
    let box: Record<string, unknown> | null = null;
    try {
      box = await page.evaluate((arg: { to: string; by?: number }) => {
        // 浏览器侧执行（Node strip-types 下类型注释被擦除，源码原样进页面）。
        const g = globalThis as unknown as {
          document?: {
            scrollingElement?: { scrollTop: number; scrollHeight: number; clientHeight: number; scrollWidth: number; clientWidth: number } | null;
            documentElement?: { scrollTop: number; scrollHeight: number; clientHeight: number; scrollWidth: number; clientWidth: number } | null;
            body?: { scrollTop: number; scrollHeight: number; clientHeight: number; scrollWidth: number; clientWidth: number } | null;
          } | null;
        };
        const doc = g.document;
        if (!doc) return { ok: false, reason: "no document" };
        // document.scrollingElement 即主滚动器（标准模式下 = documentElement，
        // quirks 模式下 = body）——"window"/"html"/"body"/"document" 四个合成名都落到它。
        const se = doc.scrollingElement ?? doc.documentElement ?? doc.body;
        if (!se) return { ok: false, reason: "no scrolling element found (document.scrollingElement/documentElement/body all null)" };
        const scrollHeight = Number(se.scrollHeight) || 0;
        const clientHeight = Number(se.clientHeight) || 0;
        const scrollWidth = Number(se.scrollWidth) || 0;
        const clientWidth = Number(se.clientWidth) || 0;
        const before = Number(se.scrollTop) || 0;
        const maxY = Math.max(0, scrollHeight - clientHeight);
        const maxX = Math.max(0, scrollWidth - clientWidth);
        if (maxY <= 2 && maxX <= 2) {
          return { ok: false, moved: false, scrollTop: before, scrollHeight, clientHeight,
            reason: `document is not scrollable (scrollHeight=${scrollHeight} <= clientHeight=${clientHeight})` };
        }
        let next = before;
        if (typeof arg.by === "number") next = before + arg.by;
        else if (arg.to === "bottom") next = maxY;
        else if (arg.to === "top") next = 0;
        else if (arg.to === "page") next = Math.min(maxY, before + Math.max(1, Math.round(clientHeight * 0.9)));
        next = Math.max(0, Math.min(maxY, next));
        se.scrollTop = next;
        return { ok: true, before, scrollTop: Number(se.scrollTop) || 0, scrollHeight, clientHeight };
      }, { to, ...(opts?.by === undefined ? {} : { by: opts.by }) }) as Record<string, unknown> | null;
    } catch (e) {
      return { ok: false, moved: false, stopCode: "not_scrollable", reason: describeActionError(e) };
    }
    if (box === null || box["ok"] !== true) {
      return {
        ok: false, moved: false,
        ...(box !== null && box["scrollTop"] !== undefined ? { scrollTop: Number(box["scrollTop"]) } : {}),
        ...(box !== null && box["scrollHeight"] !== undefined ? { scrollHeight: Number(box["scrollHeight"]) } : {}),
        ...(box !== null && box["clientHeight"] !== undefined ? { clientHeight: Number(box["clientHeight"]) } : {}),
        stopCode: "not_scrollable",
        reason: String(box?.["reason"] ?? "document scroll failed"),
      };
    }
    const settleMs = opts?.settleMs ?? 150;
    if (settleMs > 0) await sleep(settleMs);
    const scrollTop = Number(box["scrollTop"] ?? 0);
    const before = Number(box["before"] ?? 0);
    return {
      ok: true, scrollTop,
      scrollHeight: Number(box["scrollHeight"] ?? 0),
      clientHeight: Number(box["clientHeight"] ?? 0),
      moved: scrollTop !== before,
      delta: scrollTop - before,
    };
  }

  /**
   * A3 `mw.setRange`：解析目标 hint → 定位 → `range.ts` 三策略（fill/keyboard/pointer）。
   * 目标不存在 = `target_not_found`；存在但设不了 = `slider_not_settable`（绝不假装成功）。
   */
export async function setRange(mw: BrowserMiddleware, page: AnyPage, target: string, value: RangeValue, opts?: RangeOptions,): Promise<RangeOutcome> {
    // 真站实测：筛选面板是异步渲染的，刚打开时 DOM 会在一次 re-render 中换掉 slider 节点，
    // 回退解析打的临时探针属性会随旧节点消失（readState = null）。重解析一次即可恢复——
    // 这是**解析面**的瞬态，不是"设不了"；只有第二次仍读不到才按 slider_not_settable 报。
    let last: RangeOutcome | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(300);
      const resolved = await _resolveOne(mw, page, target, "slider");
      if ("error" in resolved) {
        const isSliderish = /matched nothing/i.test(resolved.error);
        last = {
          ok: false,
          stopCode: isSliderish ? "target_not_found" : "stale_ref",
          reason: resolved.error,
        };
        continue;
      }
      try {
        const r = await applyRange(page, resolved.loc, value, opts);
        if (r.ok || !/cannot read the slider state/i.test(String(r.reason ?? ""))) return r;
        last = r;
      } finally {
        if (resolved.cleanup !== undefined) await resolved.cleanup();
      }
    }
    return last ?? { ok: false, stopCode: "slider_not_settable", reason: "slider state could not be read" };
  }

  /* -- the loop ------------------------------------------------------------ */

