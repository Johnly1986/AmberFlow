/**
 * 执行器实现模块（从 executor.ts 切分，大文件拆分 X1）：本文件函数都是
 * `BrowserMiddleware` 的实现片段，显式接收 `mw` 实例（唯一执行循环仍在 executor.ts）。
 */
import { sleep } from "../support/sleep.ts";
import { type AmbiguityView, describeAmbiguity, orderCandidatesByDomPreorder } from "./ambiguity.ts";
import { type ActMissDiagnostics, type ActMissRow, actMissDiagnostics, actMissDiscrimination, nearCandidates } from "./executor-pure.ts";
import { _hintOpts, resolveCommandRef } from "./executor-resolve-a.ts";
import { type AnyLoc, type AnyPage } from "./executor-types.ts";
import { PASS_DOM_FALLBACK, PASS_ID_FALLBACK, ambiguityStopReason } from "./executor.ts";
import { type Elem, type ElemPool, type FrameLike, actionCapabilities, frameHintFailureEvidence, framesOf } from "./extraction.ts";
import { elemFrameStamp, frameGateExcludes, frameScopeMatchesFrame } from "./frame-scope.ts";
import { parseHint } from "./hint.ts";
import { anchorChainMatch } from "./rules.ts";
import { admitSelectorWithJsFor } from "./surface.ts";
import type { BrowserMiddleware } from "./executor.ts";

  /**
   * 解析一个 hint 目标到单个可动作元素（actOnce/scrollContainer/setRange 共用）。
   *
   * A2：`onAmbiguous` 只在**单动作面**（actOnce，缺省 fail）传入。"fail" 且命令步同一个
   * 歧义谓词成立（`hintCandidates` 非空 && `decided === null` && `refs.length > 1`）时，
   * 不动作、返回结构化 `target_ambiguous` + 有界 `ambiguity` 证据；"act"/缺省把
   * `resolveCommandRef` 排出的 refs[0] 照旧交给动作层（既有 run 原语与 scrollList 内部点击
   * 完整保持今日行为）。解析/排序/回退逻辑本身零改动。
   *
   * A4：`wantDiagnostics` 只在**会话 act** 面为 true（actOnce 的 `opts.diagnostics`）。落空
   * （`target_not_found`）时构造 `diagnostics`（同档候选 / 词面近似 / 池外近似但不可见）并在
   * `reason` 末尾追加一行纯内存判别；false/缺省 = 返回值与 reason **逐字节不变**
   * （scrollContainer / setRange / ctx.expand 等既有调用面不受影响）。
   *
   * F72-①：settle 结论不再就地丢弃——落空诊断在"页面未静默"（timedOut）时 additive
   * `settle_timed_out`/`settle_waited_ms` 两键 + reason 尾缀一行渲染提示（同在诊断面）。
   * F72-②：`rehydrateRescan` 只在**会话 act** 面可开——首次解析落空且抽池时页面未静默时做
   * 一次有界重扫（等 2s → 重抽池 → 同一 hint 重解析，纯 hintMatch 不重走决策面，至多 1 次）；
   * 命中 = `resolved_via:"rehydrate-rescan"`；仍未命中 = 既有诊断 + `rescan` 事实。缺省逐字节不变。
   */
export async function _resolveOne(mw: BrowserMiddleware, page: AnyPage, target: string, op: string,
    onAmbiguous?: "fail" | "act", wantDiagnostics?: boolean, rehydrateRescan?: boolean,): Promise<
    | {
      ref: string; el: Elem | null; loc: AnyLoc; poolSize: number; fallback: boolean; cleanup?: () => Promise<void>;
      /** E1-c：`#id` 直查兜底命中时出现（additive；其余路径不出现 = 键集与之前一致）。 */
      resolvedVia?: "live-dom-id-fallback" | "rehydrate-rescan";
    }
    | {
      error: string; poolSize: number; stopCode?: "target_ambiguous"; ambiguity?: AmbiguityView;
      /** A4：仅 `wantDiagnostics` 且落空（target_not_found）时出现。 */
      diagnostics?: ActMissDiagnostics;
    }
  > {
    // F72-①：settle 结论不再就地丢弃——落空诊断与重扫门控要用它（零新增页面往返）。
    const headExtract = await mw._extractPoolSettled(page, mw.candidatePriority);
    const elems = headExtract.elems;
    const settleRes = headExtract.settle;
    /** F72-②：显式重扫未命中的事实（仅 rehydrateRescan 开启且走满一次重扫后才有）。 */
    let rescanFact: { waited_ms: number; pool_size: number } | undefined;
    const poolSize = Object.keys(elems).length;
    if (typeof target !== "string" || !target.trim()) {
      return { error: "target must be a non-empty hint string (path_id / bare label / [data-test=…])", poolSize };
    }
    const refs = resolveCommandRef(mw, target, elems, op, null);
    if (onAmbiguous === "fail") {
      const ambiguity = describeAmbiguity({
        target, source: "pool", elems, orderedRefs: refs, ordering: mw.ambiguousOrdering,
        ...(mw.hintTokenAllow !== undefined ? { hintTokenAllow: mw.hintTokenAllow } : {}),
      });
      if (ambiguity !== null) {
        return {
          error: ambiguityStopReason(target, poolSize, ambiguity), poolSize,
          stopCode: "target_ambiguous", ambiguity,
        };
      }
    }
    // E2：歧义模式（onAmbiguous:"act"）的命中顺序确定性化——命中档按 act 时刻 live-DOM
    // 文档序重排（跨帧按帧序 → 帧内文档序；scan 缺失退回池内相对位置），取首个 actionable。
    // 谓词与"actionable"判定不变（仍是 resolveCommandRef 的可行动优先排序结果）；
    // `"pool-order"`（回退开关）= 旧行为，跳过重排。单候选（refs.length <= 1）不进本路径。
    let ordered = refs;
    if (onAmbiguous === "act" && mw.ambiguousOrdering === "dom-preorder" && refs.length > 1) {
      ordered = orderCandidatesByDomPreorder(refs, elems);
    }
    if (ordered.length) {
      const ref = ordered[0]!;
      const el = elems[ref]!;
      const loc = await mw._locatorFor(page, el);
      if (loc !== null) return { ref, el, loc, poolSize, fallback: false };
    }
    // E1-c：`#id` hint 的 **live-DOM 单点直查兜底**（decision.id_fallback，缺省开）。
    // 背景：诊断-收编一致性 defect——扫描器能报出 stable handle（id 在页面上），act 却因
    // 元素未收编进池（配额逐出/准入面不含它）而 target_not_found。兜底只限形态 1（`#id`）：
    //   - 命中 → 打探针属性、复用同一可交互性检查（可见盒 + actionCapabilities），证据块
    //     `resolved_via:"live-dom-id-fallback"`（additive；调用方回显）；
    //   - 未命中/不可交互 → 维持既有 target_not_found 语义（继续走 A3 池外回退面）；
    //   - 其余 5 种 hint 形态**不做**直查（封闭集边界不变，任意 CSS 仍拒绝）。
    const idFallback = await _liveDomIdFallback(mw, page, target, op);
    if (idFallback !== null) {
      return {
        ref: idFallback.ref, el: null, loc: idFallback.loc, poolSize,
        fallback: true, cleanup: idFallback.cleanup,
        resolvedVia: "live-dom-id-fallback",
      };
    }
    // A3 回退面：目标可能是**池外元素**——典型是 0×0 的自绘 slider 手柄（提取按可见盒过滤，
    // 它永远进不了池），或滚轮容器内的不可见控件。这里做一次 DOM 侧候选收集（含 0×0），
    // 用同一套 hint 语义（hintMatch/可行动优先排序）解析，并给命中的元素打临时探针属性，
    // 让 locator 能稳定指到它；调用方用完负责 cleanup。
    const fallback = await _domFallbackResolve(mw, page, target, op, onAmbiguous, wantDiagnostics);
    if ("scan" in fallback) {
      // F72-②：rehydrate_rescan（opt-in）——首次解析落空且抽池时页面未静默 ⇒ 池可能是水合
      // 中间态。等一小段有界时间重抽池、用**同一 hint**（纯 hintMatch 语义，不重走决策面）
      // 重解析一次：命中 = resolved_via:"rehydrate-rescan"；重扫后歧义照旧结构化（同一谓词，
      // 不绕过零动作承诺）；仍未命中 = 落到既有诊断（rescan 事实 additive）。
      if (rehydrateRescan === true && settleRes !== null && settleRes.timedOut === true) {
        const rescan = await _rehydrateRescanOnce(mw, page, target, op, onAmbiguous);
        if ("ok" in rescan) {
          return { ...rescan.ok, fallback: false, resolvedVia: "rehydrate-rescan" as const };
        }
        if ("ambiguous" in rescan) {
          return {
            error: rescan.ambiguous.error, poolSize: rescan.ambiguous.poolSize,
            stopCode: "target_ambiguous", ambiguity: rescan.ambiguous.ambiguity,
          };
        }
        rescanFact = rescan.fact;
      }
      const base = `target ${JSON.stringify(target)} matched nothing in a pool of ${poolSize} element(s)`;
      if (wantDiagnostics !== true) return { error: base, poolSize };
      // A4：落空诊断（纯内存；唯一的页面读取是池外回退扫描行里 ≤5 行的可见性，已在上一步完成）。
      const diagnostics = actMissDiagnostics({
        target, pool: elems, op, hintOpts: _hintOpts(mw, ), rejected: fallback.scan.rejected,
        poolCap: mw.actPoolCap,   // E1-a：观测面回显（不改池构成）
        // F72-①：settle 未静默（渲染可疑）与 F72-② 显式重扫事实（additive；缺省/静默正常时键不出现）。
        ...(settleRes !== null && settleRes.timedOut === true
          ? { settleTimedOut: { waitedMs: settleRes.waitedMs } } : {}),
        ...(rescanFact === undefined ? {} : { rescan: rescanFact }),
      });
      // C 批（B8）：会话 act 的失败 reason 同样追加 frame: 尾缀诊断 + 页面可用 origin
      // （只有 `opts.diagnostics:true` 的会话 act 面走这里；scrollContainer/setRange 等既有
      // 调用面不传 ⇒ reason 逐字节不变）。diagnostics 结构体本身不改形状。
      // F82：池在手 = 追加 in-row 三案证据（token 无匹配列真实行词元 / 行已定位改 base）。
      const frameNote = frameHintFailureEvidence(page, mw._frameHosts, [target], elems);
      // F72-①：页面未静默时把"渲染可能未完成"写进 reason（让调用方第一时间知道"该等"而不是
      // 绕路换目标）；F72-②：显式重扫跑过且仍未命中时如实记重扫事实。两者都只在诊断面出现。
      const renderNote = settleRes !== null && settleRes.timedOut === true
        ? `；页面在 ${Math.max(0, Math.round(settleRes.waitedMs))}ms 内未静默（可能仍在水合/渲染）——`
          + `目标缺失可能因渲染未完成，建议 wait_for/ctx.waitForTarget 锚定后重试而非换目标`
        : "";
      const rescanNote = rescanFact === undefined
        ? ""
        : `；rehydrate_rescan 已等 ${rescanFact.waited_ms}ms 重抽池（${rescanFact.pool_size} 项）仍未命中`;
      return {
        error: `${base}\n判别: ${actMissDiscrimination(diagnostics, elems, op)}`
          + (frameNote ? ` — ${frameNote}` : "") + renderNote + rescanNote,
        poolSize, diagnostics,
      };
    }
    if ("ambiguity" in fallback) {
      return {
        error: ambiguityStopReason(target, poolSize, fallback.ambiguity), poolSize,
        stopCode: "target_ambiguous", ambiguity: fallback.ambiguity,
      };
    }
    return { ref: fallback.ref, el: null, loc: fallback.loc, poolSize, fallback: true, cleanup: fallback.cleanup };
  }

  /**
   * F72-②：声明目标解析落空后的**有界重扫**（`rehydrateRescan`，opt-in；至多 1 次）。
   *
   * 只在首次解析落空且抽池时页面未静默（settle timedOut——轮播/水合页抽到中间态池的信号）
   * 后调用：等一小段有界时间（2s）→ 重抽池（**不再 settle**——刚等过的墙钟就是给水合的
   * 窗口，settle 在轮播页只会再白等满 5s）→ 用**同一 hint** 走 `resolveCommandRef`（与首次
   * 解析同一套语义，`on_ambiguous:"fail"` 时重过同一歧义谓词——重扫不绕过零动作承诺）。
   * 命中返回可动作元素；重扫池上歧义照旧结构化；仍未命中只回事实（waited_ms/pool_size），
   * 由调用方落进既有诊断。不猜、不换目标、不重走决策面。
   */
export async function _rehydrateRescanOnce(mw: BrowserMiddleware, page: AnyPage, target: string, op: string, onAmbiguous?: "fail" | "act",): Promise<
    | { ok: { ref: string; el: Elem; loc: AnyLoc; poolSize: number } }
    | { ambiguous: { error: string; poolSize: number; ambiguity: AmbiguityView } }
    | { fact: { waited_ms: number; pool_size: number } }
  > {
    const RESCAN_WAIT_MS = 2000;
    const started = Date.now();
    await sleep(RESCAN_WAIT_MS);
    const fresh = await mw.candidates!.extract({
      page, jsProbe: true, candidatePriority: mw.candidatePriority, surface: mw.surfacePolicy, hosts: mw._frameHosts,
      ...(mw.poolQuotaMode === "quota" ? { poolQuotaMode: "quota" } : {}),
    });
    const freshSize = Object.keys(fresh).length;
    const refs = resolveCommandRef(mw, target, fresh, op, null);
    if (onAmbiguous === "fail") {
      const ambiguity = describeAmbiguity({
        target, source: "pool", elems: fresh, orderedRefs: refs, ordering: mw.ambiguousOrdering,
        ...(mw.hintTokenAllow !== undefined ? { hintTokenAllow: mw.hintTokenAllow } : {}),
      });
      if (ambiguity !== null) {
        return {
          ambiguous: {
            error: ambiguityStopReason(target, freshSize, ambiguity),
            poolSize: freshSize, ambiguity,
          },
        };
      }
    }
    let ordered = refs;
    if (onAmbiguous === "act" && mw.ambiguousOrdering === "dom-preorder" && refs.length > 1) {
      ordered = orderCandidatesByDomPreorder(refs, fresh);
    }
    if (ordered.length) {
      const ref = ordered[0]!;
      const el = fresh[ref]!;
      const loc = await mw._locatorFor(page, el);
      if (loc !== null) return { ok: { ref, el, loc, poolSize: freshSize } };
    }
    return { fact: { waited_ms: Date.now() - started, pool_size: freshSize } };
  }

  /**
   * E1-c：`#id` hint 的 live-DOM 单点直查兜底（`decision.id_fallback`，缺省开）。
   *
   * 只在池内解析（含可行动优先排序）**零命中**且 hint 形状是 `#id` 时尝试：
   *   1. `document.getElementById(id)` 单点直查（跨可达子 frame 逐帧尝试，主 frame 优先）；
   *   2. 命中后做**同一套可交互性检查**（可见盒 + `actionCapabilities` 含当前 op）——
   *      不可交互 = 返回 null（维持既有 target_not_found，交给后续 A3 回退面统一诊断）；
   *   3. 可交互 = 打带批次的临时探针属性 `data-af-probe="<批次>-id"`，返回可重复求值的
   *      locator（调用方 cleanup）。
   *
   * 纪律：**兜底仅限形态 1（`#id`）**；其余 5 种 hint 形态不做直查（封闭集边界不变，
   * 任意 CSS 仍拒绝）。`idFallback === false`（回退开关）= 本方法恒 null，逐字节旧行为。
   */
export async function _liveDomIdFallback(mw: BrowserMiddleware, page: AnyPage, target: string, op: string,): Promise<{ ref: string; loc: AnyLoc; cleanup: () => Promise<void> } | null> {
    if (mw.idFallback !== true) return null;
    const parsed = parseHint(target);
    if (parsed.kind !== "id" || !parsed.value) return null;
    // F82/F83 评审收口（fail-closed）：F64 是 `#id` 单点直查，没有行上下文底座——声明行锚
    // 时不参与直查，避免按 id 命中后静默丢掉行约束（落回既有 target_not_found + 行锚证据）。
    if (parsed.inRow !== undefined || parsed.rowIndex !== undefined) return null;
    // A 批（frame:<origin>）：声明链过滤帧循环；并补 `frameInHostsEnvelope` hosts 检查
    // （既有缺陷修正——F64 的跨帧直查此前不查 hosts 信封，`#id` 可能落在排除帧里被动作；
    // 现在与池/hintLookup/FW8 同口径：主帧恒允许，子帧不在信封内跳过。CHANGELOG 记录行为变更）。
    const frameChain = parsed.frameChain;
    const frames = framesOf(page as never);
    const token = `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const probeAttr = `data-af-probe="${token}-id"`;
    for (let fi = 0; fi < frames.length; fi++) {
      const fr = frames[fi]!;
      if (frameGateExcludes(fi, fr, mw._frameHosts)) continue;
      if (frameChain !== undefined && !frameScopeMatchesFrame(frameChain, fr)) continue;
      try {
        // E1（within 权威对等）：一次 evaluate 返回 anchors + TS 判定（inline TS arrow →
        // PASS_ID_FALLBACK，compile() 常量 + ANCHOR_JS 内插）——二次求值多一次跨源往返且
        // 原子性差；anchors 还能区分「找到但在锚外」与「找不到」。
        const hit = (await (fr as unknown as {
          evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
        }).evaluate(PASS_ID_FALLBACK, { id: parsed.value, attr: probeAttr })) as Record<string, unknown> | null;
        if (hit === null) continue;
        // E1：within 存在时命中后校验 anchors（与池侧 inAnchor 同口径）。不在锚内 =
        // 该帧不命中——「找到但在锚外」与「找不到」在 evaluate 结果里可区分（hit 非 null
        // 且 anchors 不含 within vs hit 为 null）；清探针章后尝试下一帧（锚内命中可能在
        // 另一帧）。两帧都不命中 → 返回 null → 维持既有 target_not_found 语义走 A3。
        // E2：within = 链（外→内），校验走 anchorChainMatch 嵌套序包含（唯一出处 rules.ts）
        // ——单层 membership 逐字节不变；链任一段缺失/序错 = 该帧不命中（尝试下一帧）。
        if (parsed.within !== undefined) {
          const anchors = Array.isArray(hit["anchors"]) ? (hit["anchors"] as string[]) : [];
          if (!anchorChainMatch(anchors, parsed.within)) {
            await _probeCleanup(mw, page, token);
            continue;
          }
        }
        // 可交互性：可见 + 动作能力面含当前 op（与池内 actionable 同一判据的 DOM 侧投影）。
        if (hit["visible"] !== true) {
          await _probeCleanup(mw, page, token);
          return null;
        }
        const cap = actionCapabilities({
          tag: String(hit["tag"] ?? ""),
          role: "",
          label: String(hit["label"] ?? ""),
          input_type: "",
        } as Elem);
        if (!(cap as readonly string[]).includes(op)) {
          await _probeCleanup(mw, page, token);
          return null;
        }
        return {
          ref: `id:${parsed.value}`,
          loc: (fr as unknown as { locator(s: string): AnyLoc }).locator(`[${probeAttr}]`),
          cleanup: async () => { await _probeCleanup(mw, page, token); },
        };
      } catch {
        continue;   // 跨源 frame：evaluate 抛错，尝试下一帧
      }
    }
    return null;
  }

  /** E1-c：探针属性清理（`_liveDomIdFallback` 与后续复用共用；失败静默）。 */
export async function _probeCleanup(mw: BrowserMiddleware, page: AnyPage, token: string): Promise<void> {
    for (const fr of framesOf(page as never)) {
      try {
        await (fr as unknown as { evaluate(fn: (tok: string) => void, tok: string): Promise<void> }).evaluate((tok: string) => {
          const g = globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<any> } };
          const all = g.document.querySelectorAll(`[data-af-probe^="${tok}-"]`);
          for (let i = 0; i < all.length; i++) all[i].removeAttribute("data-af-probe");
        }, token);
      } catch { /* 跨源 frame 清理失败不影响结论 */ }
    }
  }

  /**
   * A3 池外回退解析：DOM 侧收集**全部**匹配选择器的元素（不按可见性过滤），用同一套
   * hint 语义（rules.hintMatch / resolveCommandRef 的可行动优先）挑一个，给它打一个带
   * 批次的临时属性 `data-af-probe="<批次>-<序号>"`，返回可重复求值的 locator。
   *
   * A2：`onAmbiguous:"fail"` 时合成池上同样要过命令步的歧义谓词——歧义 → 先 cleanup 再返回
   * `{ambiguity}`（`source:"dom_fallback"`，不给 near/suggested_hint）；其余情况行为不变。
   *
   * A4：解析落空时把**扫描行**一并回传（`{scan:{rows,rejected}}`，< 本次行为 null 的等效形状）：
   * `rows` 是词面近似的合成行（`nearCandidates` ≤5，纯内存），`rejected` 是其中**不可见**的行
   * （≤3，`why:"not visible"`，措辞与 observe 的 `why_not_admitted` 同源）。只对这几行做一次
   * 可见性判定（仍是本回退路径内的页面读取）；不扫面外元素、不新造 why 分支、不改变任何
   * 解析结果（命中/歧义两个分支的返回形状与语义逐字节不变）。
   */
export async function _domFallbackResolve(mw: BrowserMiddleware, page: AnyPage, target: string, op: string, onAmbiguous?: "fail" | "act", wantDiagnostics?: boolean,): Promise<
    | { ref: string; loc: AnyLoc; cleanup: () => Promise<void>; elem: Elem }
    | { ambiguity: AmbiguityView }
    | { scan: { rows: ActMissRow[]; rejected: ActMissRow[] } }
  > {
    // A3 修正：scrollList 的目标常常是**非交互容器**（`div[role="feed"]`、`main`…），
    // 它们不在扫描面里。滚动语义只需要"能定位到容器"，所以 scroll 操作把回退面扩到
    // 常见容器角色（仍只在池解析失败时走；正常路径零变化）。
    //
    // U3/C11：本路径是 **grandfathered** 的——它按**身份**（hint 语义 + data-af-probe 盖章）
    // 寻址，不是位置序号，所以这里用准入面 ADMIT_SEL（window ∪ resolve），不用池基准。
    // 既有语义刻意保持不变：仅主 frame、**不做可见性过滤**（0×0 的自绘 slider 手柄只能靠
    // 这条路径被点到）。任何收紧（可见性/子 frame/池基准）都会打断既有 flow 应用。
    const admitAll = admitSelectorWithJsFor(mw.surfacePolicy);
    const fallbackSel = op === "scroll"
      ? `${admitAll}, [role='feed'], [role='list'], [role='main'], [role='region'], [role='article'], [role='listitem'], main`
      : admitAll;
    const token = `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    let rows: Array<Record<string, unknown>> = [];
    try {
      // E1（within 权威对等）：inline TS arrow → PASS_DOM_FALLBACK（compile() 常量，行补 anchors；
      // 闭包不跨——共享 ANCHOR_JS 必须 ${} 内插进 pass 源码）。
      // F82：in-row 声明随 arg 下发（inRow）——回退面每行补 row_texts（A3 半链缺口闭合）；
      // F83：row-index 声明随 arg 下发（rowIndex）——回退面每行补 row_index（对等）。
      // 未声明时 arg 不带键，pass 内零计算、行形状逐字节不变。
      const parsedTarget = parseHint(target);
      const inRowTok = parsedTarget.inRow;
      const rowIdxTok = parsedTarget.rowIndex;
      rows = (await page.evaluate(PASS_DOM_FALLBACK,
        { sel: fallbackSel, tok: token,
          ...(inRowTok !== undefined ? { inRow: inRowTok } : {}),
          ...(rowIdxTok !== undefined ? { rowIndex: rowIdxTok } : {}),
        })) as Array<Record<string, unknown>>;
    } catch {
      rows = [];
    }
    const cleanup = async (): Promise<void> => {
      try {
        await page.evaluate((tok: string) => {
          const g = globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<any> } };
          const all = g.document.querySelectorAll(`[data-af-probe^="${tok}-"]`);
          for (let i = 0; i < all.length; i++) all[i].removeAttribute("data-af-probe");
        }, token);
      } catch { /* 清理失败不影响结论 */ }
    };
    if (!rows.length) { await cleanup(); return { scan: { rows: [], rejected: [] } }; }
    // A 批（frame:<origin>，B3）：A3 回退面是**仅主帧**（page.evaluate）——合成行按主帧
    // 链打点（elemFrameStamp 对 page-as-FrameLike = 主帧，frame_path 省略）。声明链指向
    // 子帧时这些行不会命中链过滤 ⇒ 如实落空（绝不越帧动作）；frame_origin/frame_path 不进
    // 模型面（pickInner.modelProjectionOf 剥离）。
    const mainStamp = elemFrameStamp(page as unknown as FrameLike);
    const synthetic: ElemPool = {};
    for (const r of rows) {
      const idx = Number(r["i"]);
      // A1 不变量：label === full_label 的前 40 字（同一 label 截断；合成池与真池同构）。
      synthetic[`p${idx}`] = {
        ref: `p${idx}`, tag: String(r["tag"] ?? ""), label: String(r["label"] ?? "").slice(0, 40),
        full_label: String(r["label"] ?? "").slice(0, 200),
        role: String(r["role"] ?? ""), id: String(r["id"] ?? ""), data_test: String(r["dt"] ?? ""),
        input_type: String(r["type"] ?? ""),
        ...(r["draggable"] === true ? { draggable: true } : {}),
        // E1（within 权威对等）：合成主帧行补 anchor_ids（与真池行同构，additive）——
        // resolveCommandRef → hintMatch.inAnchor 据此消费 within（与池/回捞面同语义）。
        ...(Array.isArray(r["anchors"]) && (r["anchors"] as string[]).length > 0
          ? { anchor_ids: (r["anchors"] as string[]).map((x) => String(x).toLowerCase()) } : {}),
        // F82（A3 半链缺口闭合）：fallback 行补 row_texts（additive，与真池行同构）——
        // 合成行并入主池后二次 hintMatch 的 inRow 过滤才有底座；缺字段 = 过滤清零 = 死路。
        ...(Array.isArray(r["row_texts"]) && (r["row_texts"] as string[]).length > 0
          ? { row_texts: (r["row_texts"] as string[]).map((x) => String(x)) } : {}),
        // F83（A3 row-index 对等）：fallback 行补 row_index（additive）——rowIdx 过滤底座。
        ...(typeof r["row_index"] === "number" ? { row_index: r["row_index"] } : {}),
        ...(mainStamp.frame_origin !== undefined ? { frame_origin: mainStamp.frame_origin } : {}),
        ...(mainStamp.frame_path !== undefined ? { frame_path: mainStamp.frame_path } : {}),
      } as Elem;
    }
    const refs = resolveCommandRef(mw, target, synthetic, op, null);
    if (!refs.length) {
      // A4：只对**词面近似**行（≤5）做一次可见性判定——池外扫描面本来就含隐藏元素，
      // "扫描到了但不可见"是这条回退唯一能诚实回答的落空原因。措辞复用 observe 的
      // `not visible`（不新造 why_not_admitted 分支，也不扫面外元素）。
      // 只有要判别证据的调用面（会话 act）才做这次读取：run 面/原语路径零新增页面往返。
      if (wantDiagnostics !== true) {
        await cleanup();
        return { scan: { rows: [], rejected: [] } };
      }
      const near = nearCandidates(target, synthetic, 5);
      let rejected: ActMissRow[] = [];
      if (near.length > 0) {
        let visible: Record<string, boolean> = {};
        try {
          visible = (await page.evaluate((arg: { tok: string; refs: string[] }) => {
            const g = globalThis as unknown as {
              document: { querySelector(s: string): any };
              getComputedStyle(x: any): { display: string; visibility: string };
            };
            const out: Record<string, boolean> = {};
            for (const ref of arg.refs) {
              const el = g.document.querySelector(`[data-af-probe="${arg.tok}-${ref.slice(1)}"]`);
              if (el === null) { out[ref] = false; continue; }
              const rect = el.getBoundingClientRect();
              const cs = g.getComputedStyle(el);
              out[ref] = rect.width > 0 && rect.height > 0
                && cs.display !== "none" && cs.visibility !== "hidden";
            }
            return out;
          }, {
            tok: token,
            refs: near.map((r) => r.ref ?? "").filter((r) => r !== ""),
          })) as Record<string, boolean>;
        } catch {
          visible = {};
        }
        rejected = near
          .filter((r) => r.ref === undefined || visible[r.ref] !== true)
          .map((r) => ({ ref: r.ref, tag: r.tag, label: r.label, why: "not visible" }))
          .slice(0, 3);
      }
      await cleanup();
      return { scan: { rows: near, rejected } };
    }
    if (onAmbiguous === "fail") {
      // A2：合成池自证 ≠ 真池——只停动作、如实给合成候选身份，不提供 near/suggested_hint。
      const ambiguity = describeAmbiguity({
        target, source: "dom_fallback", elems: synthetic, orderedRefs: refs,
        ordering: mw.ambiguousOrdering,
        ...(mw.hintTokenAllow !== undefined ? { hintTokenAllow: mw.hintTokenAllow } : {}),
      });
      if (ambiguity !== null) { await cleanup(); return { ambiguity }; }
    }
    // E2：池外回退面的歧义模式同样按 DOM 序重排（合成池的 `pN` ref 序即 DOM 收集序，
    // 本已确定；重排只在 scan 缺失时退回池序——即与旧行为一致）。缺省路径与旧行为同序。
    let fallbackOrdered = refs;
    if (onAmbiguous === "act" && mw.ambiguousOrdering === "dom-preorder" && refs.length > 1) {
      fallbackOrdered = orderCandidatesByDomPreorder(refs, synthetic);
    }
    const ref = fallbackOrdered[0]!;
    const idx = ref.slice(1);
    // F75：run 决策步复用本回退面时需要 Elem + 探针句柄（`_locatorFor` 的 af_probe 首分支
    // 据此重建 locator）；会话 act 路径不用该字段（additive，既有调用点键集不变）。
    const elem = { ...synthetic[ref]!, af_probe: `${token}-${idx}` } as Elem;
    return {
      ref,
      loc: page.locator(`[data-af-probe="${token}-${idx}"]`),
      cleanup,
      elem,
    };
  }

