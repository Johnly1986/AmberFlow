/**
 * 执行器实现模块（从 executor.ts 切分，大文件拆分 X1）：本文件函数都是
 * `BrowserMiddleware` 的实现片段，显式接收 `mw` 实例（唯一执行循环仍在 executor.ts）。
 */
import { sleep } from "../support/sleep.ts";
import { type CommandDecl } from "./actions.ts";
import { type TraceStep } from "./audit.ts";
import { type DeclaredTargetsResolver } from "./declared-targets.ts";
import { declaredHiddenSuffix, declaredMissSuffix, drfHintSuffix, identityHiddenSuffix } from "./evidence.ts";
import { cmdDiscrimination, contextPageCount, firstPoolText, frameTargetStopReason } from "./executor-pure.ts";
import { type AnyPage, type Readiness, type RunOptions, type Sig, type SkippedAction, type StateFingerprint, type StopCode } from "./executor-types.ts";
import { declaresRowAnchor } from "./executor.ts";
import { type Elem, type ElemPool, frameGateOf, frameHintFailureEvidence, framesScopedPage, hintLookup, probeExcludedHint, urlOf, viewportUnderload } from "./extraction.ts";
import { HINT_CLOSED_SET_TEXT } from "./grammar-prompt.ts";
import { type HintMatchOptions, hintCandidates, hintMatch } from "./rules.ts";
import { type SettleResult } from "./settle.ts";
import { type SignalSpec, checkSignal } from "./signals.ts";
import { type SurfacePolicy, admitSelectorWithJsFor } from "./surface.ts";
import type { BrowserMiddleware } from "./executor.ts";
import type { FrameGatePhase, PoolGatePhase, DeclaredTargetsPhase, DeclaredHintPhase } from "./executor.ts";


  /** 4d 阶段：帧门禁与适用性（导航/弹窗信封由 run() 处理；本阶段只读）。返回早停报告或循环所需状态。 */
export async function runFrameGate(mw: BrowserMiddleware, a: {
    instruction: string; pg: AnyPage; hostGate: string[] | null;
    goalSignalFn: ((page: AnyPage) => Promise<boolean> | boolean) | null;
    precondition: SignalSpec | null; warnings: string[]; verbose: boolean;
  }): Promise<FrameGatePhase> {
    const { instruction, pg, hostGate, goalSignalFn, precondition, warnings, verbose } = a;
    let doneInExcluded = false;
    // P0-D：声明 hosts 信封外的第三方 iframe 默认**只排除出解析面**（池/hint/FW8/DRF/locatorAnyFrame/
    // done/when 都不读），不再是整步 REJECT；只有声明 target/done 仅存在于被排除帧才 frame_not_allowed。
    const frameGate = hostGate && hostGate.length ? frameGateOf(pg, hostGate) : null;
    const excludedView = frameGate === null
      ? null : framesScopedPage(pg, frameGate.excluded.map((e) => e.frame));
    /** 允许帧视图：所有读面（done/when/池…）都只看它；无排除帧时就是真 page（零行为差）。 */
    const readPage: AnyPage = frameGate === null
      ? pg : (framesScopedPage(pg, frameGate.allowed) as unknown as AnyPage);
    if (frameGate !== null) {
      warnings.push(
        `frames_excluded: [${frameGate.origins.join(", ")}] — ${frameGate.excluded.length} third-party `
        + `frame(s) outside the declared hosts envelope (${hostGate!.join(", ")}) are EXCLUDED from the `
        + `read surface (pool / hint / identity / declared-DOM / done / when / locatorAnyFrame); `
        + `已排除、不影响页面其余操作。Only if a declared target or done signal truly needs one of these `
        + `frames is frame_not_allowed raised — at that point decide whether to add its origin to meta.hosts`,
      );
    }
    // P0-D：done/when 求值唯一入口——allowed 帧先判，不成立再**只读**探 excluded 帧一次；只在那里
    // 成立 = done 依赖被排除帧（doneInExcluded），收尾升级 frame_not_allowed。E4：css_* 的 ` frame:<链>`
    // 尾缀由 locatorAnyFrame/countAnyFrame 的帧过滤底座继承（双面天然 suffix-aware；非法尾缀按原 CSS）。
    const goalHeld = async (): Promise<boolean> => {
      if (goalSignalFn === null) return false;
      if ((await goalSignalFn(readPage)) === true) return true;
      if (excludedView !== null) {
        try {
          if ((await goalSignalFn(excludedView as unknown as AnyPage)) === true) doneInExcluded = true;
        } catch { /* 排除帧求值失败不改变判定：仍按未成立 */ }
      }
      return false;
    };
    // P0-D：声明目标解析失败后的**只读**复核——目标是否只存在于被排除 frame；命中 = 结构化
    // frame_not_allowed（reason/证据文案唯一出处 executor-pure.frameTargetStopReason），绝不宽化、绝不操作排除帧。
    const frameTargetStop = async (
      target: string,
    ): Promise<{ code: StopCode; reason: string } | null> => {
      if (target === "" || hostGate === null || hostGate.length === 0) return null;
      const probe = await probeExcludedHint(pg, hostGate, target, admitSelectorWithJsFor(mw.surfacePolicy));
      if (probe === null) return null;
      return { code: "frame_not_allowed", reason: frameTargetStopReason(target, hostGate, probe) };
    };
    // "Does this step apply?" — asked before spending a step; a skipped subgoal reports done.
    if (precondition !== null && precondition !== undefined && !(await checkSignal(readPage, precondition))) {
      // P0-D/E4：when 只在被排除 frame 上成立 ⇒ 结构化 frame_not_allowed（frame: 尾缀双面同样生效）。
      if (excludedView !== null && (await checkSignal(excludedView as never, precondition))) {
        const why = `when/precondition signal ${JSON.stringify(precondition)} holds only inside frame(s) `
          + `${frameGate === null ? "-" : frameGate.origins.join(", ")} excluded by the declared hosts envelope `
          + `(${hostGate!.join(", ")}) — the step does not apply on the allowed frames; `
          + `frames_excluded 只是默认排除第三方非交互 frame，不需要为此加 hosts；仅当该 when 确需此 frame 时才评估把它加进 meta.hosts`;
        if (verbose) console.log(`  -> REFUSED: ${why}`);
        return { kind: "early", report: {
          goal: instruction, done: false,
          stop_reason: why, stop_code: "frame_not_allowed", steps: [],
          audit: { verdict: "REJECT", reasons: [why], auditor: "frame-gate" },
        } };
      }
      if (verbose) console.log(`    -> SKIPPED (precondition not met: ${JSON.stringify(precondition)})`);
      return { kind: "early", report: {
        goal: instruction, done: true, skipped: true,
        stop_reason: "precondition not met -> skipped", stop_code: "precondition_skipped", steps: [],
        audit: { verdict: "SKIPPED", reasons: ["precondition not met"], auditor: "n/a" },
      } };
    }
    return { kind: "ready", frameGate, goalHeld, frameTargetStop, doneInExcluded: () => doneInExcluded };
  }

  /** 4d 阶段：步首抽池与就绪闸门（poolReady 轮询 / 池空判档 / after 补签 / before 指纹）。stopped = 页面未就绪。 */
export async function runPoolGate(mw: BrowserMiddleware, a: {
    pg: AnyPage; stepNo: number; candidatePriority: "bucketed" | "main-first"; poolReady: boolean; poolReadyTimeoutMs: number;
    poolReadyPollMs: number; poolGate: RunOptions["poolGate"]; verbose: boolean;
    observeState: (elems: ElemPool | null) => Promise<StateFingerprint>; trace: TraceStep[]; warnings: string[];
    pendingAfterIdx: number | null; beforeFp: StateFingerprint | null; lastPoolSize: number; lastPoolWaitedMs: number;
    lastReadiness: Readiness | null; poolEmptyThisStep: boolean; readyEmptyWarned: boolean; stop: (code: StopCode, detail?: string, at?: number) => void;
  }): Promise<PoolGatePhase> {
    const { pg, stepNo, candidatePriority, poolReady, poolReadyTimeoutMs, poolReadyPollMs, poolGate, verbose, observeState, trace, warnings } = a;
    let { pendingAfterIdx, beforeFp, lastPoolSize, lastPoolWaitedMs, lastReadiness, poolEmptyThisStep, readyEmptyWarned } = a;
    // eval3 曝光面：no_progress 的 newTab 提示基线——步首 URL 与 context 页数（只读，零动作）。
    const stepStartUrl = urlOf(pg); const stepStartTabs = contextPageCount(pg);
    // P0 pool ready gate：SPA 的 domcontentloaded 可能先于交互元素渲染；这里只做“pool 非空”，目标/可执行性由后面分支判断。
    let elems: ElemPool; let poolWaitedMs = 0;
    let gateSettle: SettleResult | null = null; let gateBudgetMs = 0;
    if (poolReady) {
      const readyStarted = Date.now();
      gateBudgetMs = Math.max(0, poolReadyTimeoutMs);
      const readyDeadline = readyStarted + gateBudgetMs;
      // C8：每轮 settle 的 timeout 都被 _extractPoolSettled 钳到剩余预算 ⇒ 总等待有真上限。
      let ex = await mw._extractPoolSettled(pg, candidatePriority, readyDeadline);
      elems = ex.elems; gateSettle = ex.settle;
      while (Object.keys(elems).length === 0 && Date.now() < readyDeadline) {
        const remaining = readyDeadline - Date.now();
        await sleep(Math.max(0, Math.min(poolReadyPollMs, remaining)));
        if (Date.now() >= readyDeadline) break;   // 预算耗尽：不再起一轮会越界的 settle
        ex = await mw._extractPoolSettled(pg, candidatePriority, readyDeadline);
        elems = ex.elems; gateSettle = ex.settle;
      }
      poolWaitedMs = Date.now() - readyStarted;
    } else {
      // 步首 settle 结论保留——重扫自动触发的门控要用（settle timedOut 即触发）。
      const headExtract = await mw._extractPoolSettled(pg, candidatePriority);
      elems = headExtract.elems; gateSettle = headExtract.settle;
    }
    lastPoolSize = Object.keys(elems).length;
    // task-11（B3）：会话池高峰基线——池大小本来就算好了，记账零成本。
    if (mw._sessionFirstPoolTs === 0) mw._sessionFirstPoolTs = Date.now();
    if (lastPoolSize > mw._sessionPoolHigh) mw._sessionPoolHigh = lastPoolSize; lastPoolWaitedMs = poolWaitedMs;
    // S1：before 指纹取**第一次已有观察**（步首池），零新增页面往返。
    if (beforeFp === null) beforeFp = await observeState(elems);
    // A1 子改动③：上一动作的 after 签名在此落账（本步首提取 = 上一动作后页面状态；先于 walk/hintLookup 与空池停因，清空也照实记）。
    if (pendingAfterIdx !== null) {
      const prev = trace[pendingAfterIdx];
      if (prev !== undefined && prev.after === undefined) {
        const ft = firstPoolText(elems);
        prev.after = { url: urlOf(pg), pool_size: lastPoolSize, ...(ft === null ? {} : { first_text: ft }) };
      }
      pendingAfterIdx = null;
    }
    if (poolReady && Object.keys(elems).length === 0) {
      // U3 四档判档（§5.3，唯一出处）：池空 ≠ 未就绪（not_ready 保留 run 级停因；ready_empty = 步级事实+warning 后继续；strict = 改判 not_ready）。
      const readiness = await mw._poolReadiness(pg, gateSettle, poolWaitedMs, gateBudgetMs, 0); lastReadiness = readiness; const strict = poolGate === "strict";
      if (readiness.verdict === "not_ready" || strict) {
        if (strict && readiness.verdict === "ready_empty") readiness.verdict = "not_ready";
        const ev = readiness.evidence; const why = `page not ready: element pool stayed empty after ${ev.waited_ms}ms (budget_ms=${ev.budget_ms}, `
          + `settled=${String(ev.settled)}, settle_timed_out=${String(ev.settle_timed_out)}, readyState=${ev.ready_state}`
          + `${strict ? ", pool_gate=strict" : ""}) on step ${stepNo}`;
        a.stop("page_not_ready", why, stepNo); if (verbose) console.log(`  step ${stepNo}: ${why}`);
        return { stopped: true, stepStartUrl, stepStartTabs, elems, gateSettle, lastPoolSize, lastPoolWaitedMs, beforeFp, pendingAfterIdx, lastReadiness, poolEmptyThisStep, readyEmptyWarned };
      }
      // ready_empty：池空但页面已就绪 = 页面事实，不是未就绪证据；记证据后继续，让后续给出真正失败原因。
      poolEmptyThisStep = true;
      if (!readyEmptyWarned) {
        readyEmptyWarned = true;
        warnings.push(
          `pool_empty: the pool stayed empty although the page is settled and readyState=complete `
          + `(step ${stepNo}; sniff admitted=${readiness.evidence.sniff?.admitted ?? 0} visible ADMIT_SEL element(s), `
          + `focusable=${readiness.evidence.sniff?.focusable ?? 0}, aria=${readiness.evidence.sniff?.aria ?? 0}, `
          + `frames=${readiness.evidence.sniff?.frames ?? 0}, body_text=${readiness.evidence.sniff?.body_text ?? 0}) — continuing; pool_gate:"strict" would stop with page_not_ready；用 ctx.observe() 在会话内看准入面与 why_not_admitted`,
        );
      }
    }
    return { stopped: false, stepStartUrl, stepStartTabs, elems, gateSettle, lastPoolSize, lastPoolWaitedMs, beforeFp, pendingAfterIdx, lastReadiness, poolEmptyThisStep, readyEmptyWarned };
  }

  /**
   * 4d 阶段：声明目标（**命令空间 walk**）——按当前观察在闭合集上走一遍；找不到 = 结构化
   * target_not_found（永不回退全池/模型）。覆盖范围仅命令 walk；act-hint 解析面仍在 run()。
   * 早停由本方法 stop() 记账（stopReason 回调保证日志与调用点一致）。
   */
export async function runDeclaredTargets(mw: BrowserMiddleware, a: {
    pg: AnyPage; stepNo: number; verbose: boolean; elems: ElemPool; cmdSpace: CommandDecl[]; cmdDone: Set<string>;
    cmdI: number; cmdAttempts: Record<string, number>; noteSkipped: (s: SkippedAction) => void;
    zeroExecSummary: () => string; goalHeld: () => Promise<boolean>;
    goalSignalFn: ((page: AnyPage) => boolean | Promise<boolean>) | null;
    frameTargetStop: (target: string) => Promise<{ code: StopCode; reason: string } | null>;
    targets: DeclaredTargetsResolver; stop: (code: StopCode, detail?: string, at?: number) => void;
    stopReason: () => string; forbidden: Record<string, Sig>; pruneForbids: (pool: ElemPool) => void;
    hintOpts: () => HintMatchOptions; surfacePolicy: SurfacePolicy; frameHosts: string[] | null;
    targetResolutionDeclared: boolean; candidateAttempts: number;
    resolveCommandRef: (target: string, pool: ElemPool, op: string, blocked: Set<string>) => string[];
    setDone: () => void;
    setViewportUnderloaded: (v: { tag: string; id: string; scrollHeight: number; clientHeight: number; rendered: number }[] | null) => void;
  }): Promise<DeclaredTargetsPhase> {
    const { pg, stepNo, verbose, elems, cmdSpace, cmdDone, cmdAttempts, noteSkipped, zeroExecSummary,
      goalHeld, goalSignalFn, frameTargetStop, targets, stop, stopReason, forbidden, pruneForbids, hintOpts,
      frameHosts, targetResolutionDeclared, candidateAttempts, resolveCommandRef,
      setDone, setViewportUnderloaded } = a;
    let cmdI = a.cmdI;
    let cmdPick: { cmd: CommandDecl; ref: string; index: number; cands: string[] } | null = null;
    let rowAmbStop: { code: StopCode; reason: string } | null = null;
    // P2 COMMAND SPACE — the step's action is chosen ON THE CLOSED SET, not on the pool:
    if (cmdSpace.length) {
      let pendingUnresolved: string[] = [];
      for (let i = cmdI; i < cmdSpace.length; i++) {
        const c = cmdSpace[i]!;
        if (cmdDone.has(c.id)) continue;
        if (c.op === "skip") {          // skip: resolves by definition, moves the page not at all
          cmdDone.add(c.id);
          cmdI = i + 1;
          continue;
        }
        const target = c.target ?? "";
        if ((cmdAttempts[c.id] ?? 0) >= candidateAttempts) {
          // A2：一条命令最多试前 4 个可行动候选；到顶仍没成 = 这条命令在本步 OUT
          //（记 attempt_limit 证据；后续 done 成立/不成立都有零执行摘要，不静默 done）。
          noteSkipped({
            command_id: c.id, target: c.target ?? null, reason: "attempt_limit",
            detail: `${candidateAttempts} candidate(s) tried without success`,
          });
          cmdDone.add(c.id);
          cmdI = i + 1;
          continue;
        }
        // A2：可行动优先的候选列表（`null` 起 = 池里没有这个目标，先做一次 DOM 回捞）。
        let candRefs = resolveCommandRef(target, elems, String(c.op), new Set(Object.keys(forbidden)));
        if (candRefs.length === 0 && target !== "" && hintCandidates(target, elems, hintOpts()) === null) {
          for (const [ref, e] of Object.entries(await hintLookup(pg, target, admitSelectorWithJsFor(mw.surfacePolicy), { hosts: frameHosts }))) {
            if (!e.dsh_ref) elems[ref] = e;
          }
          pruneForbids(elems);
          candRefs = resolveCommandRef(target, elems, String(c.op), new Set(Object.keys(forbidden)));
        }
        if (candRefs.length === 0 && target !== "" && hintCandidates(target, elems, hintOpts()) === null) {
          const attempt = await targets.tryIdentity(target, {
            reasonPrefix: `command ${JSON.stringify(c.id)} identity target ${JSON.stringify(target)}`,
            narrowNoun: "declaration", commandId: c.id,
          });
          if (attempt.kind === "ambiguous") break;
          if (attempt.kind === "row") {
            const { ref, el } = attempt;
            elems[ref] = el;
            pruneForbids(elems);
            const pickedRefs = resolveCommandRef(target, elems, String(c.op),
              new Set(Object.keys(forbidden)));
            cmdPick = {
              cmd: c, ref: pickedRefs[0] ?? ref, index: i,
              cands: (pickedRefs.length ? pickedRefs : [ref]).slice(0, candidateAttempts),
            };
            break;
          }
        }
        if (candRefs.length === 0 && target !== "" && targetResolutionDeclared
            && hintCandidates(target, elems, hintOpts()) === null) {
          // op 门在 tryDeclared 单点（DECLARED_TARGET_OPS）：能力面外的 op（fill/select/
          // drag/upload/clickAt）拿到 null，落到下方 pendingUnresolved → 既有
          // target_not_found——绝不"先解析再拒绝成 action_unsupported"。
          const got = await targets.tryDeclared(target, String(c.op));
          if (targets.declaredStop !== null) break;
          if (got !== null) {
            elems[got.ref] = got.el;
            pruneForbids(elems);
            cmdPick = { cmd: c, ref: got.ref, index: i, cands: [got.ref] };
            break;
          }
        }
        pruneForbids(elems);
        if (candRefs.length > 1 && declaresRowAnchor(target)) {
          const cand = hintCandidates(target, elems, hintOpts());
          if (cand !== null && cand.refs.length > 1) {
            for (const candRef of cand.refs) {
              noteSkipped({
                command_id: c.id, target, ref: candRef, reason: "target_ambiguous",
                detail: `${cand.refs.length} row-anchor candidate(s) for ${JSON.stringify(target)}; `
                  + "row anchors never act on the first of several rows",
              });
            }
            rowAmbStop = {
              code: "target_ambiguous",
              reason: `command ${JSON.stringify(c.id)} target ${JSON.stringify(target)} declares a row anchor and matches ${cand.refs.length} candidate(s) (${cand.refs.join(", ")}) on step ${stepNo} — row anchors are fail-closed: several distinct rows never resolve to "the first one"; narrow in-row:<token> to a content token unique to one row or fix the row being pointed at`,
            };
            break;
          }
        }
        if (candRefs.length > 0) {
          cmdPick = { cmd: c, ref: candRefs[0]!, index: i, cands: candRefs.slice(0, candidateAttempts) };
          break;
        }
        if (hintCandidates(target, elems, hintOpts()) === null) {
          pendingUnresolved.push(c.id);
          noteSkipped({ command_id: c.id, target: c.target ?? null, reason: "target_not_found" });
          continue;
        }
        noteSkipped({
          command_id: c.id, target: c.target ?? null, reason: "forbidden",
          detail: `${cmdAttempts[c.id] ?? 0} candidate(s) tried, remaining candidates are forbidden`,
        });
        cmdDone.add(c.id);
        cmdI = i + 1;
      }
      if (targets.identityStop !== null) {
        stop(targets.identityStop.code, targets.identityStop.reason, stepNo);
        if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
        return { stopped: true, cmdPick, rowAmbStop, cmdI };
      }
      if (targets.declaredStop !== null) {
        stop(targets.declaredStop.code, targets.declaredStop.reason, stepNo);
        if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
        return { stopped: true, cmdPick, rowAmbStop, cmdI };
      }
      if (rowAmbStop !== null) {
        stop(rowAmbStop.code, rowAmbStop.reason, stepNo);
        if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
        return { stopped: true, cmdPick, rowAmbStop, cmdI };
      }
      if (cmdPick === null) {
        let cmdFrameStop: { code: StopCode; reason: string } | null = null;
        for (const cid of pendingUnresolved) {
          const c = cmdSpace.find((x) => x.id === cid);
          if (c === undefined || !c.target) continue;
          cmdFrameStop = await frameTargetStop(c.target);
          if (cmdFrameStop !== null) break;
        }
        if (cmdFrameStop !== null) {
          stop(cmdFrameStop.code, cmdFrameStop.reason, stepNo);
          if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
          return { stopped: true, cmdPick, rowAmbStop, cmdI };
        }
        // 区分“目标不存在”和“目标存在但歧义”：歧义不是空间为空，而是候选集 > 1。
        const ambiguous = cmdSpace.find((c) => {
          if (c.op === "skip" || !c.target) return false;
          if ((cmdAttempts[c.id] ?? 0) > 0) return false;
          const cand = hintCandidates(c.target, elems, hintOpts());
          return cand !== null && cand.decided === null && cand.refs.length > 1;
        });
        if (ambiguous?.target) {
          const cand = hintCandidates(ambiguous.target, elems, hintOpts())!;
          // A1：歧义的每个候选都进 skipped_actions——零执行不能只剩一句停因文案。
          for (const candRef of cand.refs) {
            noteSkipped({
              command_id: ambiguous.id, target: ambiguous.target, ref: candRef,
              reason: "target_ambiguous",
              detail: `${cand.refs.length} distinct candidates for ${JSON.stringify(ambiguous.target)}; never guessed`,
            });
          }
          stop("target_ambiguous",
            `command ${JSON.stringify(ambiguous.id)} matches ${cand.refs.length} distinct candidates (${cand.refs.join(", ")}) for target ${JSON.stringify(ambiguous.target)} on step ${stepNo}`
            + zeroExecSummary(), stepNo);
          if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
          return { stopped: true, cmdPick, rowAmbStop, cmdI };
        }
        if (cmdDone.size >= cmdSpace.length) {
          if (goalSignalFn && (await goalHeld())) {
            setDone();
            stop("dom_goal_signal",
              `dom goal signal (commands resolved without action; signal held)${zeroExecSummary()}`, stepNo);
            if (verbose) console.log(`  step ${stepNo}: -> done (signal held after exhausted commands, 04-A)`);
            return { stopped: true, cmdPick, rowAmbStop, cmdI };
          }
          stop("done_not_held",
            `commands exhausted (${cmdDone.size}/${cmdSpace.length} acted) but the done-signal never held on step ${stepNo}`
            + zeroExecSummary(), stepNo);
        } else {
          const under = await viewportUnderload(pg);
          setViewportUnderloaded(under.length ? under : null);
          const underNote = under.length
            ? ` — viewport_underloaded: `
              + under.map((h) => `${h.tag}${h.id ? `#${h.id}` : ""} scrollHeight=${h.scrollHeight} `
                + `> clientHeight=${h.clientHeight}, rendered children=${h.rendered}`).join("; ")
              + `（目标可能在未渲染/视口外的滚动内容里；不自动滚动，按六步法② 用滚动/展开原语或收窄窗口取证）`
            : "";
          const frameTargets = pendingUnresolved
            .map((id) => cmdSpace.find((c) => c.id === id)?.target)
            .filter((t): t is string => typeof t === "string" && t !== "");
          const frameNote = frameHintFailureEvidence(pg, frameHosts, frameTargets, elems);
          stop("target_not_found",
            `command space matches nothing on this page — pending unresolved: ${pendingUnresolved.join(", ") || "-"} (unresolvable candidates are OUT; the space never falls back to the full pool) on step ${stepNo}. `
            + HINT_CLOSED_SET_TEXT
            + cmdDiscrimination(cmdSpace, pendingUnresolved, elems)
            + identityHiddenSuffix(targets.identityHidden)
            + declaredHiddenSuffix(targets.getDeclaredHidden())
            + declaredMissSuffix(targets.declaredMiss)
            + drfHintSuffix(targetResolutionDeclared)
            + underNote
            + (frameNote ? ` — ${frameNote}` : ""), stepNo);
        }
        if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
        return { stopped: true, cmdPick, rowAmbStop, cmdI };
      }
    }
    return { stopped: false, cmdPick, rowAmbStop, cmdI };
  }

  /**
   * 4d 阶段：声明目标（**act-hint 解析面**）——恢复/回捞/DRF 把声明 hint 变成可引用元素；
   * dead hint 沿有序 targetHints 前进；身份/DRF 结构化停因与 row-anchor 歧义在此早停。
   * 覆盖范围仅 act-hint 解析；commandValue binding 之后逻辑仍在 run()。
   */
export async function runDeclaredHint(_mw: BrowserMiddleware, a: {
    pg: AnyPage; stepNo: number; verbose: boolean; elems: ElemPool; commandMode: boolean; targets: DeclaredTargetsResolver;
    warnings: string[]; stop: (code: StopCode, detail?: string, at?: number) => void; stopReason: () => string;
    noteSkipped: (s: SkippedAction) => void; hintMatch: typeof hintMatch; hintLookup: typeof hintLookup;
    hintCandidates: typeof hintCandidates; declaresRowAnchor: typeof declaresRowAnchor;
    frameTargetStop: (target: string) => Promise<{ code: StopCode; reason: string } | null>;
    pruneForbids: (pool: ElemPool) => void; forbidden: Record<string, Sig>;
    advanceHint: () => void; currentHint: () => string | null; hintIndex: () => number; hintCount: number;
    hintOpts: () => HintMatchOptions; surfacePolicy: SurfacePolicy; frameHosts: string[] | null;
    targetResolutionDeclared: boolean; isTyping: (el: Elem) => boolean;
  }): Promise<DeclaredHintPhase> {
    const { pg, stepNo, verbose, elems, commandMode, targets, warnings, stop, stopReason, noteSkipped,
      hintMatch, hintLookup, hintCandidates, declaresRowAnchor, frameTargetStop, pruneForbids, forbidden,
      advanceHint, currentHint, hintIndex, hintCount, hintOpts, surfacePolicy, frameHosts,
      targetResolutionDeclared, isTyping } = a;
    let curHint = commandMode ? null : currentHint();
    for (let guard = 0; curHint !== null && guard < 8; guard++) {
      if (hintMatch(curHint, elems, hintOpts()) === null) {
        // U3/C10：节点身份去重（见命令路径同一处注释）。
        for (const [ref, e] of Object.entries(await hintLookup(pg, curHint, admitSelectorWithJsFor(surfacePolicy), { hosts: frameHosts }))) if (!e.dsh_ref) elems[ref] = e;
        // FW8：act hint 声明面身份回捞（池+ADMIT 都落空后；决策步不走、命中只进本步局部池）。
        if (hintMatch(curHint, elems, hintOpts()) === null) {
          const attempt = await targets.tryIdentity(curHint, {
            reasonPrefix: `target_hint ${JSON.stringify(curHint)} identity declaration`, narrowNoun: "hint",
          });
          if (attempt.kind === "row") elems[attempt.ref] = attempt.el;
        }
        // P0-C：DRF 是声明目标解析链最后一段。能力面纪律在**解析资格侧**（不在命中后拒绝）：
        // typing 形元素（isTyping）= DRF 不参与救援——立即清章与账（如同未命中），落回既有
        // widen/strict 路径；缺省 declared 下绝不把能力面外的解析结果变成新硬停。
        if (hintMatch(curHint, elems, hintOpts()) === null && targetResolutionDeclared) {
          const got = await targets.tryDeclared(curHint, "click");
          if (targets.declaredStop !== null) break;
          if (got !== null && isTyping(got.el)) {
            await targets.cleanupDeclared();
            targets.setDeclared(null);
          } else if (got !== null) {
            elems[got.ref] = got.el;
          }
        }
      }
      // drop forbids whose ref now points at a different element
      pruneForbids(elems);
      // dead hint（有序声明）= 前进一步到下一条声明，而不是烧掉这个 subgoal。
      const dead = hintMatch(curHint, elems, hintOpts());
      if (dead !== null && dead in forbidden && hintIndex() < hintCount - 1) {
        advanceHint();
        curHint = currentHint();
        continue;
      }
      break;
    }
    // FW8：身份歧义是结构化停因，绝不回退"随便选一个"或交给模型猜。
    if (targets.identityStop !== null) {
      stop(targets.identityStop.code, targets.identityStop.reason, stepNo);
      if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`); return { stopped: true, curHint };
    }
    // P0-C：DRF 歧义/首版能力面同样是结构化停因。
    if (targets.declaredStop !== null) {
      stop(targets.declaredStop.code, targets.declaredStop.reason, stepNo);
      if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
      return { stopped: true, curHint };
    }
    // F82/F83：行锚声明 = 多候选零动作——widen 之前落成结构化歧义（候选进 skipped，绝不取首行）。
    if (!commandMode && curHint !== null && declaresRowAnchor(curHint)) {
      const cand = hintCandidates(curHint, elems, hintOpts());
      if (cand !== null && cand.refs.length > 1) {
        for (const candRef of cand.refs) {
          noteSkipped({ ref: candRef, reason: "target_ambiguous", detail: `${cand.refs.length} row-anchor candidate(s) for ${JSON.stringify(curHint)}; ` + "row anchors never act on the first of several rows", });
        }
        stop("target_ambiguous",
          `target_hint ${JSON.stringify(curHint)} declares a row anchor and matches ${cand.refs.length} candidate(s) (${cand.refs.join(", ")}) on step ${stepNo} — row anchors are fail-closed: several distinct rows never resolve to "the first one"; narrow in-row:<token> to a content token unique to one row, or narrow within:/frame: on step ${stepNo}`, stepNo);
        if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`); return { stopped: true, curHint };
      }
    }
    if (targets.identityHidden !== null) warnings.push(`identity_hidden: target ${JSON.stringify(targets.identityHidden.target)} matched ${targets.identityHidden.total} element(s) in the DOM but ${targets.identityHidden.hidden} are hidden (checkVisibility CSS / zero box) — not acted on; the step continues on the declared failure path`);
    const declaredHiddenNow = targets.getDeclaredHidden();
    if (declaredHiddenNow !== null) warnings.push(`declared_hidden: target ${JSON.stringify(declaredHiddenNow.target)} matched ${declaredHiddenNow.total} element(s) in the DOM but ${declaredHiddenNow.hidden} are hidden (checkVisibility CSS / zero box) — not acted on; the step continues on the declared failure path`);
    // P0-D：声明 act hint 只在被排除 frame 里存在 → frame_not_allowed（只读探测，不回退模型）。
    if (!commandMode && curHint !== null && hintMatch(curHint, elems, hintOpts()) === null) {
      const hintFrameStop = await frameTargetStop(curHint);
      if (hintFrameStop !== null) {
        stop(hintFrameStop.code, hintFrameStop.reason, stepNo);
        if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`); return { stopped: true, curHint };
      }
    }
    return { stopped: false, curHint };
  }

