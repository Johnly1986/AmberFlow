/**
 * 执行器实现模块（从 executor.ts 切分，大文件拆分 X1）：本文件函数都是
 * `BrowserMiddleware` 的实现片段，显式接收 `mw` 实例（唯一执行循环仍在 executor.ts）。
 */
import { sleep } from "../support/sleep.ts";
import { type AmbiguityView, describeAmbiguity, orderCandidatesByDomPreorder } from "./ambiguity.ts";
import { type ActMissDiagnostics, type ActMissRow, actMissDiagnostics, actMissDiscrimination, nearCandidates, sigEq } from "./executor-pure.ts";
import { _hintOpts, resolveCommandRef } from "./executor-resolve-a.ts";
import { foldNestedDuplicates } from "./executor-actionability.ts";
import { _declaredActFallback, _declaredEvalFailedNote } from "./executor-resolve-declared.ts";
import { type AnyLoc, type AnyPage } from "./executor-types.ts";
import { PASS_DOM_FALLBACK, PASS_ID_FALLBACK, ambiguityStopReason } from "./executor.ts";
import { type Elem, type ElemPool, type FrameLike, actionCapabilities, esig, frameHintFailureEvidence, framesOf, probeHintInDom, probeTextBbox } from "./extraction.ts";
import { elemFrameStamp, frameGateExcludes, frameScopeMatchesFrame } from "./frame-scope.ts";
import { parseHint } from "./hint.ts";
import { anchorChainMatch } from "./rules.ts";
import { admitSelectorWithJsFor } from "./surface.ts";
import { matchAxNames, stampAxProbe, snapshotAxForResolve, type AxPageLike } from "./ax.ts";
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
   * F72-②：**缺省自动**——首次解析落空且抽池时页面未静默（settle timedOut）即做一次有界
   * 重扫（等 2s → 重抽池 → 同一 hint 重解析，纯 hintMatch 不重走决策面，至多 1 次）；
   * 命中 = `resolved_via:"rehydrate-rescan"`；仍未命中 = 既有诊断 + `rescan` 事实。
   * settle:"off"（或传感器失败）时 settle 结论为 null，门控信号不存在，重扫永不触发；
   * 显式 `rehydrateRescan:true` 声明仍被接受（兼容，不再有额外效果）。
   *
   * P0-C：本函数此前**没有 DRF 段**（DRF 只在 run 面 `runDeclaredTargets`/`runDeclaredHint`
   * 的步内 resolver 里），于是 `ExecutorOptions.targetResolution` 对会话 act 面完全空转——
   * `amber session` 里的 class-only 控件永远 target_not_found。DRF 现排在 A3 回退/重扫之后、
   * AX 之前（见 `_declaredActFallback` 的纪律段）。
   */
export async function _resolveOne(mw: BrowserMiddleware, page: AnyPage, target: string, op: string,
    onAmbiguous?: "fail" | "act", wantDiagnostics?: boolean,): Promise<
    | {
      ref: string; el: Elem | null; loc: AnyLoc; poolSize: number; fallback: boolean; cleanup?: () => Promise<void>;
      /** E1-c：`#id` 直查兜底 / 第五档 AX 回退 / 嵌套同目标折叠命中时出现（additive）。 */
      resolvedVia?: "live-dom-id-fallback" | "rehydrate-rescan" | "ax-fallback" | "nested-fold";
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
    /** F72-②：重扫未命中的事实（走满一次重扫且仍未命中才有）。 */
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
        // 嵌套同目标折叠：同 label 候选存在 DOM 包含关系 = 同一可动作单元（容器 vs 它自己的
        // 链接/控件）——取可动作后代执行（`resolved_via:"nested-fold"`，additive）；互不包含
        // 的同 label（兄弟重复组）仍零动作真歧义；探测失败 = fail-open 回既有谓词。
        const folded = await foldNestedDuplicates(mw, page, elems, target, op);
        if (folded !== null && elems[folded[0]!] !== undefined) {
          const el = elems[folded[0]!]!;
          const loc = await mw._locatorFor(page, el);
          if (loc !== null) {
            return { ref: folded[0]!, el, loc, poolSize, fallback: false, resolvedVia: "nested-fold" };
          }
        }
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
      // rehydrate_rescan（缺省自动）——首次解析落空且抽池时页面未静默 ⇒ 池可能是水合
      // 中间态。等一小段有界时间重抽池、用**同一 hint**（纯 hintMatch 语义，不重走决策面）
      // 重解析一次：命中 = resolved_via:"rehydrate-rescan"；重扫后歧义照旧结构化（同一谓词，
      // 不绕过零动作承诺）；仍未命中 = 落到既有诊断（rescan 事实 additive）。
      if (settleRes !== null && settleRes.timedOut === true) {
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
      // P0-C：DRF（声明目标解析）——池 / `#id` 直查 / A3 回退 / 重扫全落空后的 DOM 结构面，
      // 排在 AX 之前（AX 是最后手段）。`off` = 第一句就 return null：零页面往返、零新键、
      // 既有落空路径与 stopCode 逐字节不变。
      const declaredAttempt = await _declaredActFallback(mw, page, target, op);
      if (declaredAttempt !== null) {
        if (declaredAttempt.kind === "hit") {
          return {
            ref: declaredAttempt.ref, el: declaredAttempt.el, loc: declaredAttempt.loc,
            poolSize, fallback: true, cleanup: declaredAttempt.cleanup,
          };
        }
        if (declaredAttempt.kind === "ambiguous") {
          // 与命令步同一歧义口径：结构化 target_ambiguous + **零动作**，绝不猜。
          return { error: declaredAttempt.reason, poolSize, stopCode: "target_ambiguous" as const };
        }
      }
      /** 防御线：DRF 脚本在页内没跑起来时不留"静默归零"（无失败 = 空串，reason 不变）。 */
      const declaredEvalNote = declaredAttempt !== null && declaredAttempt.kind === "miss"
        ? _declaredEvalFailedNote(declaredAttempt.evalFailed) : "";
      // 第五档 AX 回退（解析链末端、全链真落空后的最后手段；本解析至多 1 次）——
      // AX 可交互有名节点与 hint 词面匹配，命中反解 DOM 盖临时探针章（FW8/A3 同纪律：
      // 身份寻址 + 用完清理）；>1 候选走同一 describeAmbiguity 谓词零动作。快照不可用/
      // 无词面匹配/反解全败 = null → 既有 miss 诊断路径（含 DOM 探测）逐字节不变。
      const ax = await _resolveAxFallback(mw, page, target, onAmbiguous, { strong: mw.actHintTier === "strong" });
      /** A3 同款弱档纪律的事实面（act_hint_tier:"strong" 判弱档未命中 → 拒绝后进诊断）。 */
      let axWeakRejected: { probe: string } | null = null;
      if (ax !== null && "hit" in ax) {
        return { ref: ax.hit.ref, el: null, loc: ax.hit.loc, poolSize, fallback: true, cleanup: ax.hit.cleanup, resolvedVia: "ax-fallback" as const };
      }
      if (ax !== null && "rejected_weak" in ax) {
        axWeakRejected = ax.rejected_weak;
      }
      if (ax !== null && "ambiguity" in ax) {
        return {
          error: ambiguityStopReason(target, poolSize, ax.ambiguity), poolSize,
          stopCode: "target_ambiguous" as const, ambiguity: ax.ambiguity,
        };
      }
      const base = `target ${JSON.stringify(target)} matched nothing in a pool of ${poolSize} element(s)`;
      if (wantDiagnostics !== true) return { error: base + declaredEvalNote, poolSize };
      // DOM 等价探测（只读，主帧；单一出处 = extraction.probeHintInDom）——命中 =
      // 元素在 DOM 却未进池的事实块 + reason 改写为"在 DOM 但未进池"级文案；未命中/探测
      // 异常/不适用形状 = null → base 与 reason 逐字节不变。处方按**会话面**给
      // （`--target-resolution declared`；`meta.policy` 是 app 概念，会话没有 meta）。
      const inDom = await probeHintInDom(page, target, "session");
      const missBase = inDom === null
        ? base
        : `target ${JSON.stringify(target)} exists in the DOM (${inDom.total} match(es)) but none entered `
          + `the pool of ${poolSize} element(s) — ${inDom.note}`;
      // A4：落空诊断（纯内存；唯一的页面读取是池外回退扫描行里 ≤5 行的可见性，已在上一步完成）。
      const diagnostics = {
        ...actMissDiagnostics({
          target, pool: elems, op, hintOpts: _hintOpts(mw, ), rejected: fallback.scan.rejected,
          poolCap: mw.actPoolCap,   // E1-a：观测面回显（不改池构成）
          // F72-①：settle 未静默（渲染可疑）与 F72-② 重扫事实（additive；静默正常时键不出现）。
          ...(settleRes !== null && settleRes.timedOut === true
            ? { settleTimedOut: { waitedMs: settleRes.waitedMs } } : {}),
          ...(rescanFact === undefined ? {} : { rescan: rescanFact }),
        }),
        // DOM 探测命中才出现的键（additive；未命中 = 键集与之前一致）。
        ...(inDom === null ? {} : { in_dom_but_not_admitted: inDom }),
        // strong 拒掉 AX 弱档命中的事实（additive；未发生 = 键集与之前一致）。
        ...(axWeakRejected === null ? {} : { ax_weak_rejected: axWeakRejected }),
      };
      // C 批（B8）：会话 act 的失败 reason 同样追加 frame: 尾缀诊断 + 页面可用 origin
      // （只有 `opts.diagnostics:true` 的会话 act 面走这里；scrollContainer/setRange 等既有
      // 调用面不传 ⇒ reason 逐字节不变）。diagnostics 结构体本身不改形状。
      // F82：池在手 = 追加 in-row 三案证据（token 无匹配列真实行词元 / 行已定位改 base）。
      const frameNote = frameHintFailureEvidence(page, mw._frameHosts, [target], elems);
      // F72-①：页面未静默时把"渲染可能未完成"写进 reason（让调用方第一时间知道"该等"而不是
      // 绕路换目标）；F72-②：重扫跑过且仍未命中时如实记重扫事实。两者都只在诊断面出现。
      const renderNote = settleRes !== null && settleRes.timedOut === true
        ? `；页面在 ${Math.max(0, Math.round(settleRes.waitedMs))}ms 内未静默（可能仍在水合/渲染）——`
          + `目标缺失可能因渲染未完成，建议 wait_for/ctx.waitForTarget 锚定后重试而非换目标`
        : "";
      const rescanNote = rescanFact === undefined
        ? ""
        : `；rehydrate_rescan 已等 ${rescanFact.waited_ms}ms 重抽池（${rescanFact.pool_size} 项）仍未命中`;
      return {
        error: `${missBase}\n判别: ${actMissDiscrimination(diagnostics, elems, op)}`
          + (frameNote ? ` — ${frameNote}` : "") + renderNote + rescanNote + declaredEvalNote,
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
   * 决策 ref 执行锁（`actOnce` 的 `opts.lock`）：决策面已经按**池 ref** 选中元素，
   * 执行面就按同一轮抽池的身份直接定位，不再把 ref 还原成 label 重新解析——同名重复
   * 候选（两个 `"4.5"`）在重新解析里是 `target_ambiguous`，而决策票本身已经给了唯一身份。
   *
   * 契约：`pool`/`ref` 必须来自**同一轮抽池**，`sig` = `esig` 的该元素签名。ref 是位置键
   * （重抽池会重编号），只有签名可比，所以锁命中要签名 + 活章双证；任一环不成立都回退既有
   * 解析链（零新停因）——锁是消歧与加速，不是绕过解析的强制通道。
   */
export interface ActLock {
  pool: ElemPool;
  ref: string;
  sig: [string, string, string];
}

  /**
   * `_resolveOne` 的带锁入口：先试决策 ref 锁，锁不成立再走既有解析链。
   *
   * 必须在 `_resolveOne` **重新抽池之前**试锁：抽池开头会清掉上一轮 `data-dshref` 章
   * （章是批次-位置的），重抽后旧 ref 的句柄必然失效，锁就永远是 stale。
   *
   * 锁命中要求**唯一章仍指向同一个元素**：`_locatorFor` 在章缺失时会退到 data-test /
   * 位置序等可重复句柄，页面删掉/复制节点后可能指到别的元素——那正是误点来源，所以这里
   * 先用一次只读 evaluate 复核元素身上的章值；章不符 / 元素已卸载 = 锁 stale，回退既有链。
   * 跨 frame 元素由 `_locatorFor` 按 `el.frame` 收窄作用域，`loc.evaluate` 在所属 frame
   * 求值，无需另写帧处理。
   */
export async function _resolveOneWithLock(mw: BrowserMiddleware, page: AnyPage, target: string, op: string,
    onAmbiguous?: "fail" | "act", opts?: { diagnostics?: boolean; lock?: ActLock },): Promise<
    | Awaited<ReturnType<typeof _resolveOne>>
    | {
      ref: string; el: Elem; loc: AnyLoc; poolSize: number; fallback: false;
      cleanup?: () => Promise<void>; resolvedVia: "ref-lock";
    }
  > {
    const lock = opts?.lock;
    if (lock !== undefined) {
      const el = lock.pool[lock.ref];
      if (el !== undefined && sigEq(esig(el), lock.sig)) {
        const loc = await mw._locatorFor(page, el);
        if (loc !== null && await _lockStampIsLive(loc, el.dsh_ref)) {
          return {
            ref: lock.ref, el, loc, poolSize: Object.keys(lock.pool).length,
            fallback: false, resolvedVia: "ref-lock",
          };
        }
      }
    }
    return await _resolveOne(mw, page, target, op, onAmbiguous, opts?.diagnostics === true);
  }

  /**
   * 锁的身份复核：元素身上仍挂着自己被锁时的那枚 `data-dshref` 章才算锁成立。
   *
   * 为什么不只看 `loc.count()`：`_locatorFor` 已经计过数；这里要回答的是**句柄是不是
   * 唯一章**——章值本身必须等于 `dsh_ref`（元素无章、章被新一轮抽池清掉、或 locator
   * 落到位置序别名都算 stale）。`loc.evaluate` 在 Playwright strict mode 下多命中会抛，
   * 因此这一条读数同时覆盖"章撞车"。
   */
async function _lockStampIsLive(loc: AnyLoc, dshRef: string | undefined): Promise<boolean> {
  if (typeof dshRef !== "string" || dshRef === "") return false;
  try {
    const live = await loc.evaluate((node: any) => String(node.getAttribute("data-dshref") ?? ""));
    return live === dshRef;
  } catch {
    return false;   // 0 命中（元素已卸载）/ 多命中 / 跨源 frame 读不到 = 锁不可用
  }
}

  /**
   * F72-②：声明目标解析落空后的**有界重扫**（缺省自动；至多 1 次）。
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
   * 第五档 AX 回退（解析链末端；run 决策步与会话 act 共用的**单一出处**编排）：
   * AX 快照（可交互有名节点，带 backendDOMNodeId）→ hint 词面匹配（裸词归一化全等优先，
   * 词前缀/词包含标弱档；attr 形状 = AX name 全等；其余形状不参与）→ 逐候选反解 DOM 并
   * 盖临时探针章（`data-af-probe="<token>-ax<N>"`，有界 ≤5，失败节点丢弃）→ 命中返回
   * 探针 locator + 合成行（declared:true 旁路标记，绝不进 ChoiceRequest；af_probe 供
   * `_locatorFor` 首分支重建 locator）→ 用完由调用方 cleanup（_probeCleanup 前缀移除）。
   * >1 候选 = 同一 describeAmbiguity 谓词结构化 target_ambiguous（先清理再零动作返回，
   * 不绕过零动作承诺）。**强档门（单点）**：`opts.strong === true`（= act_hint_tier:"strong"）
   * 且最强档命中是弱档（词前缀/词包含）→ 清章返回 `{rejected_weak}`（declaredAllow 同门：
   * 强档判弱档未命中，宁显式落空不做静默弱配）；两面调用点只消费事实（session 进
   * diagnostics.ax_weak_rejected、run 进 step warning + strict 落因）。快照不可用/无词面
   * 匹配/反解全败 = null（第五档静默跳过）。
   * 合成候选的歧义 source 暂落 "dom_fallback" 同款口径（合成池自证 ≠ 真池：只给候选身份、
   * 不给 near/suggested_hint——AX 合成行同理）；union 扩 "ax_fallback" 由账本统一登记。
   */
export async function _resolveAxFallback(mw: BrowserMiddleware, page: AnyPage, target: string,
    onAmbiguous?: "fail" | "act", opts?: { strong?: boolean }): Promise<
    | { hit: { ref: string; loc: AnyLoc; cleanup: () => Promise<void>; elem: Elem; weak: boolean } }
    | { ambiguity: AmbiguityView }
    | { rejected_weak: { probe: string } }
    | null
  > {
    // AnyPage.context 的类型面是 unknown——AX 面的页形转换在此收口一次（observe 同款先例）。
    const axPage = page as unknown as AxPageLike;
    const candidates = await snapshotAxForResolve(axPage);
    if (candidates === null) return null;
    const matched = matchAxNames(candidates, target);
    if (matched === null || matched.length === 0) return null;
    const token = `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const resolved: Array<{ idx: number; name: string; role: string; tag: string; id: string; weak: boolean }> = [];
    for (let i = 0; i < matched.length; i++) {
      const m = matched[i]!;
      const stamped = await stampAxProbe(axPage, m.candidate.backendDOMNodeId, `${token}-ax${i}`);
      if (stamped === null) continue;   // 节点已卸载/跨执行上下文不可达：丢弃该候选
      resolved.push({ idx: i, name: m.candidate.name, role: m.candidate.role, tag: stamped.tag, id: stamped.id, weak: m.weak });
    }
    if (resolved.length === 0) return null;
    const synthetic: ElemPool = {};
    for (const r of resolved) {
      synthetic[`ax${r.idx}`] = {
        ref: `ax${r.idx}`, tag: r.tag, label: r.name, full_label: r.name, role: r.role,
        ...(r.id ? { id: r.id } : {}),
        af_probe: `${token}-ax${r.idx}`,
        // 旁路标记：模型投影剥离（executor-pure.modelProjectionOf），绝不进 ChoiceRequest。
        declared: true,
      } as Elem;
    }
    const orderedRefs = resolved.map((r) => `ax${r.idx}`);
    if (onAmbiguous === "fail" && resolved.length > 1) {
      const ambiguity = describeAmbiguity({
        target, source: "dom_fallback", elems: synthetic, orderedRefs, ordering: mw.ambiguousOrdering,
        ...(mw.hintTokenAllow !== undefined ? { hintTokenAllow: mw.hintTokenAllow } : {}),
      });
      if (ambiguity !== null) {
        await _probeCleanup(mw, page, token);
        return { ambiguity };
      }
    }
    const first = resolved[0]!;
    // 强档门（单点）：strong 下弱档命中不采纳——清章 + 显式事实（两面各落各的证据面）。
    if (opts?.strong === true && first.weak) {
      await _probeCleanup(mw, page, token);
      return { rejected_weak: { probe: `${token}-ax${first.idx}` } };
    }
    return {
      hit: {
        ref: `ax${first.idx}`,
        loc: page.locator(`[data-af-probe="${token}-ax${first.idx}"]`),
        cleanup: async () => { await _probeCleanup(mw, page, token); },
        elem: synthetic[`ax${first.idx}`]!,
        weak: first.weak,
      },
    };
  }

  /**
   * clickxy：**最后手段**——文本 bbox 中心坐标点击的解析面（run 面第六档，排在 AX 回退之后）。
   *
   * 何时才用：声明的 act hint 走完 池→ADMIT→FW8→DRF→U5/F72/F74/F75→AX 全链仍落空，
   * 而页面上存在**文本全等且唯一可见**的元素（`extraction.probeTextBbox` 同一底座）——
   * 这类元素没有任何可寻址句柄（否则前几档早就命中），唯一剩下的动作方式是坐标点击。
   *
   * 纪律：
   *   - **只读解析**（不动作）：返回合成行 `clickxy:{x,y}`，执行单点 = `_clickOnly` 的
   *     clickxy 分支（`page.mouse.click`），**不经 locator**；
   *   - **危险门控**在 run 面的风险闸门（clickxy 行强制 `risky=true` → `confirmFn`，缺省
   *     拒绝、非交互恒拒绝）；本函数不做门控判断，只给事实；
   *   - 文本**>1 可见 → 歧义**（`refused`，调用方零动作落 strict target_not_found——
   *     绝不猜坐标）；0 可见/探测异常 = null（既有路径逐字节不变）；
   *   - 仅裸词 hint 参与（attr/#id 形状另有 DRF/直查面；坐标点击对它们无增益）。
   */
export async function _resolveClickxyFallback(page: AnyPage, target: string): Promise<
    | { hit: { ref: string; elem: Elem } }
    | { refused: { reason: "ambiguous"; total: number } }
    | null
  > {
    let parsed: ReturnType<typeof parseHint>;
    try { parsed = parseHint(target); } catch { return null; }
    if (parsed.kind !== "bare" || parsed.token === "") return null;
    if (parsed.within !== undefined || parsed.inRow !== undefined || parsed.rowIndex !== undefined
        || parsed.frameChain !== undefined) return null;
    const probe = await probeTextBbox(page, parsed.token);
    if (probe === null) return null;
    if ("ambiguous" in probe) return { refused: { reason: "ambiguous", total: probe.total } };
    return {
      hit: {
        ref: "cx0",
        elem: {
          ref: "cx0",
          tag: probe.hit.tag,
          label: parsed.token,
          full_label: parsed.token,
          ...(probe.hit.id ? { id: probe.hit.id } : {}),
          clickxy: { x: probe.hit.x, y: probe.hit.y },
          // 旁路标记：模型投影剥离（同 declared/af_probe 合成行纪律）。
          declared: true,
        } as Elem,
      },
    };
  }

  /**
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
export async function _probeCleanup(_mw: BrowserMiddleware, page: AnyPage, token: string): Promise<void> {
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
        ...a3AttrProjection(r),
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

/**
 * A3 合成行的属性投影（与池行同构的 additive 补全）：`name`/`href` 是池行的属性匹配底座，
 * 缺它们时 `[name=…]` / `[href=…]` 在池外回退面恒落空；`href_full` 只在原始属性非空时出现
 * （池行同一条省略口径，见 EXTRACT_JS 的 href_full 投影）。字段来源 = DOM_FALLBACK_COLLECT_JS
 * 的行投影，两处键名一一对应。
 */
function a3AttrProjection(r: Record<string, unknown>): { name: string; href: string; href_full?: string } {
  const hrefFull = String(r["href_full"] ?? "");
  return {
    name: String(r["name"] ?? ""),
    href: String(r["href"] ?? ""),
    ...(hrefFull === "" ? {} : { href_full: hrefFull }),
  };
}
