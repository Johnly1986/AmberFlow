/**
 * 执行器实现模块（从 executor.ts 切分，大文件拆分 X1）：本文件函数都是
 * `BrowserMiddleware` 的实现片段，显式接收 `mw` 实例（唯一执行循环仍在 executor.ts）。
 */
import { sleep } from "../support/sleep.ts";
import { type CommandDecl } from "./actions.ts";
import { type AuditVerdict, type TraceStep } from "./audit.ts";
import { type DeclaredTargetsResolver } from "./declared-targets.ts";
import { FN_GUARD } from "./eval-snippets.ts";
import { declaredEvidence, identityEvidence, rowEvidence } from "./evidence.ts";
import { _scrollContainerForElement } from "./executor-actions.ts";
import { contentDigest, deniedContextUrl, disallowedHost, redactValue, round3, structDigest } from "./executor-pure.ts";
import { _executeElement, _hintOpts, _missingRequired, resolveCommandRef } from "./executor-resolve-a.ts";
import { type ActionabilityDetail, type AnyPage, type BrowserHandle, type ExecutedAction, type PwLike, type ReadyState, type RunReport, type Sig, type SkippedAction, type StateEffect, type StateFingerprint, type StateFlag, type StepStateRecord, type StopCode, type ThrottleSuspect } from "./executor-types.ts";
import { type ActionCapability, type Elem, type ElemPool, actionCapabilities, poolSniff, urlInHostsEnvelope, urlOf } from "./extraction.ts";
import { parseHint } from "./hint.ts";
import { hintMatch } from "./rules.ts";
import { type SettlePage, installSettle } from "./settle.ts";
import { LOGIN_WALL_URL_RE, isWeakNegativeSignal } from "./signals.ts";
import { admitSelectorWithJsFor } from "./surface.ts";
import { THROTTLE_BODY_FLOOR, THROTTLE_COLLAPSE_RATIO, THROTTLE_POOL_HIGH_MIN } from "./throttle-signature.ts";
import type { BrowserMiddleware } from "./executor.ts";
import type { ActionPhaseResult, SetupPhase, RunReportTailCtx, RehydrateRescanFact } from "./executor.ts";

import * as browserEnv from "../browser/browser-env.ts";

  /** 4d 阶段：动作准备（ActionAdapter 能力面/命令文案/DRY-RUN/needs_value 早停/pre-fill/风险闸门）；
   * 准备通过后交给 runActionExecute（stale 重试/执行/证据/trace.push）。 */
export async function runActionPhase(mw: BrowserMiddleware, a: {
    pg: AnyPage; stepNo: number; instruction: string; verbose: boolean; elems: ElemPool; ref: string; el: Elem;
    cmdPick: { cmd: CommandDecl; ref: string; index: number; cands: string[] } | null; commandMode: boolean;
    commandValue: unknown; commandByValue: boolean; commandBindMissing: string | null;
    dryRun: boolean; force: boolean; effect: { irreversible?: boolean } | null | undefined;
    slots: Record<string, unknown>; values: Record<string, unknown>; candidatePriority: "bucketed" | "main-first";
    curHint: string | null; method: string; conf: number; mm: string; decisionKind: "rule" | "model" | "escalate";
    layaMargin: number | null; tierAsk: { n: number; tier: number } | null; nominatedRepair: boolean;
    escalatedPick: string | null; prevented: number; noted: Record<string, string> | null;
    staleRetry: boolean; rehydrateRescanFact: unknown;
    targets: DeclaredTargetsResolver; trace: TraceStep[]; cmdAttempts: Record<string, number>;
    blockedRetry: Record<string, [number, number]>; reAdmitted: Set<string>;
    forbidden: Record<string, Sig>; forbid: (ref: string, el: Elem, why: string) => void;
    noteSkipped: (s: SkippedAction) => void; pruneForbids: (pool: ElemPool) => void;
    stop: (code: StopCode, detail?: string, at?: number) => void; stopReason: () => string;
    domFallbackCleanup: () => Promise<void>; markDryRan: () => void;
    getPendingAfterIdx: () => number | null; warnings: string[];
    actionDeclEvidence: () => Record<string, unknown>; refCollision: () => Record<string, unknown>;
    domFallbackEvidence: () => Record<string, unknown>;
  }): Promise<ActionPhaseResult> {
    const { pg, stepNo, instruction, verbose, elems, ref, el, cmdPick, commandMode, commandValue, commandByValue,
      commandBindMissing, dryRun, force, effect, slots, values, candidatePriority, curHint, method, conf, mm,
      decisionKind, layaMargin, tierAsk, nominatedRepair, escalatedPick, prevented, noted, staleRetry,
      rehydrateRescanFact, targets, trace, cmdAttempts, blockedRetry, reAdmitted, forbidden, forbid, noteSkipped,
      pruneForbids, stop, stopReason, domFallbackCleanup, markDryRan, getPendingAfterIdx, warnings,
      actionDeclEvidence, refCollision, domFallbackEvidence } = a;
    // ActionAdapter 能力面：命令闭集声明的 op 必须是当前元素已声明的能力。
    if (commandMode && cmdPick) {
      const caps = actionCapabilities(el);
      const op = String(cmdPick.cmd.op);
      if (op !== "skip" && !caps.includes(op as ActionCapability)) {
        // A2：这个候选不满足 op 能力面，但命令还有其他候选 ⇒ 记跳过、禁用本候选、下一步
        const alt = cmdPick.cands.some((r) => r !== ref && !(r in forbidden)
          && actionCapabilities(elems[r]!).includes(op as ActionCapability));
        if (alt) {
          forbid(ref, el, "action_unsupported");
          noteSkipped({ command_id: cmdPick.cmd.id, target: cmdPick.cmd.target ?? null, ref, reason: "action_unsupported",
            detail: `element declares [${caps.join(", ")}] but the command op is '${op}'; trying the next candidate` });
          cmdAttempts[cmdPick.cmd.id] = (cmdAttempts[cmdPick.cmd.id] ?? 0) + 1;
          if (verbose) console.log(`  step ${stepNo}: command ${cmdPick.cmd.id} candidate ${ref} lacks '${op}' -> next candidate`);
          return { control: "continue", ref, el, elems };
        }
        // B1：fill（命令闭集里唯一的取值/打字 op）被拒时点名出路——只说"元素不声明这个 op"
        const remedy = op === "fill"
          ? (caps.includes("upload")
            // U6：file input 归 upload 族——fill 被拒时直接点名正确的 op，别把作者引向决策语句。
            ? `。该目标是文件输入（input[type=file]）——上传用命令 op 'upload'（值走声明绑定），不是 fill`
            : `。该输入族不支持命令 ${op}——改用决策语句（省略 act，值经 slots 绑定）或深链直达目标 URL`)
          : op === "upload"
            ? "。upload 只对 input[type=file] 成立——检查目标 hint 是否指到了文件输入"
            : op === "clickAt"
              ? "。clickAt 只对 click 族元素成立（如 canvas）——检查目标 hint 是否指到了非点击控件"
              : "";
        await targets.cleanupIdentity();   // FW8：能力守门在动作前停——章到此已无用途
        await domFallbackCleanup();   // F75：DOM 回退跳的章同样只服务本次动作定位
        stop("action_unsupported",
          `command ${JSON.stringify(cmdPick.cmd.id)} declares op '${op}', but element ${ref} (${el.tag} "${el.label}") only declares [${caps.join(", ")}] on step ${stepNo}`
          + remedy, stepNo);
        if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
        return { control: "break", ref, el, elems };
      }
    }
    // 05-B：动作文案按命令 op 派生（此前只有 typing/click 两态，scroll 步
    const cmdOpName = commandMode && cmdPick ? String(cmdPick.cmd.op) : "";
    const verb = cmdOpName === "scroll" ? "scroll to"
      : cmdOpName === "drag" ? "drag"
      : cmdOpName === "check" ? "check"
      : cmdOpName === "hover" ? "hover"
      : cmdOpName === "clickAt" ? "click at"
      : cmdOpName === "upload" ? "upload"
      : cmdOpName === "fill" ? (mw._isTyping(el) ? "type text into" : "fill")
      : cmdOpName === "select" ? "select"
      : mw._isTyping(el) ? "type text into" : "click";
    const desc = el.clickxy !== undefined
      ? `click at (${el.clickxy.x}, ${el.clickxy.y}) text "${el.label}"`
      : `${verb} ${el.tag} "${el.label}"`;
    // DRY RUN stops HERE: the target is resolved (rule hint / local model /
    if (dryRun) {
      const probe = await mw.dryRunProbe(pg, el, force);
      markDryRan();
      await targets.cleanupIdentity();   // FW8：干跑探测结束，章不再需要
      await domFallbackCleanup();   // F75：DOM 回退跳的章同样只服务本次动作定位
      if (probe.actionable) {
        stop("dry_run", `dry-run: would ${desc}${force ? " (force)" : ""} (${method}, conf=${conf.toFixed(2)})`, stepNo);
      } else {
        stop("dry_run_not_actionable",
          `dry-run: target not actionable (${probe.reason ?? "unknown"})`, stepNo);
      }
      trace.push({ step: stepNo, desc, method, conf: round3(conf), executed: false, dry_run: true, actionable: probe.actionable, ...(probe.reason === null ? {} : { reason: probe.reason }), ...(force ? { forced: true } : {}),
        would: `${el.tag} "${el.label}"`, url: urlOf(pg),
        ...actionDeclEvidence(), ...refCollision(), ...identityEvidence(targets.identity), ...declaredEvidence(targets.getDeclared()), ...domFallbackEvidence(),
      });
      if (verbose) {
        console.log(`  step ${stepNo}: DRY-RUN `
          + (probe.actionable ? `would ${desc}${force ? " (force)" : ""}` : `not actionable (${probe.reason ?? "unknown"})`));
      }
      return { control: "break", ref, el, elems };
    }
    // P2: a fill/select whose DECLARED binding has no value stops here — honestly,
    if (commandMode && commandBindMissing !== null) {
      noteSkipped({ command_id: cmdPick!.cmd.id, target: cmdPick!.cmd.target ?? null, ref: cmdPick!.ref, reason: "needs_value", detail: commandBindMissing });
      trace.push({ step: stepNo, desc, how: "needs_value", executed: false, method, conf: 1.0, command: cmdPick!.cmd.id, ref: cmdPick!.ref, skipped: true, skip_reason: "needs_value",
        url: urlOf(pg), ...actionDeclEvidence(), ...refCollision(), ...identityEvidence(targets.identity), ...declaredEvidence(targets.getDeclared()), ...domFallbackEvidence(),
      });
      await targets.cleanupIdentity();   // FW8：缺值在动作前停——章到此已无用途
      await domFallbackCleanup();   // F75：DOM 回退跳的章同样只服务本次动作定位
      stop("needs_value",
        `command ${JSON.stringify(cmdPick!.cmd.id)}: ${commandBindMissing} — a declared binding either has its value in the plan or the step stops (红线②: never guessed) on step ${stepNo}`, stepNo);
      if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
      return { control: "break", ref, el, elems };
    }
    // Pre-fill guard: a click whose form has empty fields that the plan's
    if (!mw._isTyping(el) && cmdOpName !== "hover") {
      // Pre-fill before ANY click, including clicks on a submit-type input.
      for (const pe of await _missingRequired(mw, pg, slots, elems, values, candidatePriority)) {
        const [phow] = await _executeElement(mw, pg, pe, slots, null, undefined, false, values);
        if (verbose) console.log(`  step ${stepNo}.pre: fill required ${JSON.stringify(pe.label)} -> ${phow}`);
      }
    } else if (method === "rule:match" && !commandMode) {
      // A rule-picked field with no slot value cannot be filled; forbid it so
      if (mw._slotValue(el, slots, values) === null && !mw._isSubmit(el)) {
        forbid(ref, el, "needs_value");
        noteSkipped({ ref, reason: "needs_value", ...(cmdPick ? { command_id: cmdPick.cmd.id, target: cmdPick.cmd.target ?? null } : {}) });
        trace.push({ step: stepNo, desc, how: "needs_value", executed: false, method, conf: round3(conf), ref, skipped: true, skip_reason: "needs_value", url: urlOf(pg),
          ...actionDeclEvidence(), ...refCollision(), ...identityEvidence(targets.identity), ...declaredEvidence(targets.getDeclared()), ...domFallbackEvidence(),
        });
        await targets.cleanupIdentity();   // FW8：本步不再动作（needs_value）——章清零
        await domFallbackCleanup();   // F75：DOM 回退跳的章同样只服务本次动作定位
        if (verbose) console.log(`  step ${stepNo}: (needs_value, rule) -> skip ${ref}`);
        return { control: "continue", ref, el, elems };
      }
    }
    // §4：可逆性是**声明**，不该靠关键词猜。写了 effect.irreversible 就以它为准
    let risky: boolean, riskP: number;
    // clickxy：坐标点击（clickxy 合成行）是**危险动作**——强制走确认闸门（confirmFn；
    // 缺省拒绝、非交互恒拒绝，`--confirm-unsafe` 才放行）。位置在动作描述里可见。
    if (el.clickxy !== undefined) {
      risky = true;
      riskP = 1.0;
    } else if (cmdOpName === "upload") {
      risky = false;
      riskP = 0;
    } else if (effect?.irreversible !== undefined) {
      risky = effect.irreversible;
      riskP = effect.irreversible ? 1.0 : 0.0;
    } else {
      [risky, riskP] = await mw.isRisky(instruction, desc);
    }
    let confirmed = false;
    if (risky) {
      if (verbose) console.log(`  step ${stepNo}: RISKY ${desc} (p=${riskP.toFixed(2)}) -> asks for confirmation`);
      confirmed = await mw.confirmFn(desc);
      if (!confirmed) {
        forbid(ref, el, "risk-declined");
        noteSkipped({ ref, reason: "risk-declined", ...(cmdPick ? { command_id: cmdPick.cmd.id, target: cmdPick.cmd.target ?? null } : {}) });
        trace.push({ step: stepNo, desc, risky: true, executed: false, confirmed: false, url: urlOf(pg), ref, skipped: true, skip_reason: "risk-declined",
          ...actionDeclEvidence(), ...refCollision(), ...identityEvidence(targets.identity), ...declaredEvidence(targets.getDeclared()), ...domFallbackEvidence(),
        });
        await targets.cleanupIdentity();   // FW8：风险闸门拒绝 = 本步不动作——章清零
        await domFallbackCleanup();   // F75：DOM 回退跳的章同样只服务本次动作定位
        return { control: "continue", ref, el, elems };
      }
    }
    return runActionExecute(mw, {
      pg, stepNo, instruction, verbose, elems, ref, el, desc, cmdOpName, risky, confirmed, force, method, conf, mm,
      decisionKind, layaMargin, tierAsk, nominatedRepair, escalatedPick, prevented, noted, cmdPick, commandMode,
      commandValue, commandByValue, slots, values, candidatePriority, curHint, staleRetry, rehydrateRescanFact,
      targets, trace, cmdAttempts, blockedRetry, reAdmitted, forbidden, forbid, noteSkipped, pruneForbids,
      stop, stopReason, domFallbackCleanup, getPendingAfterIdx, warnings, actionDeclEvidence, refCollision,
      domFallbackEvidence,
    });
  }

  /** 4d 阶段：动作执行（stale 重试/分派/证据/trace.push）；返回 run 级回写字段。 */
export async function runActionExecute(mw: BrowserMiddleware, a: {
    pg: AnyPage; stepNo: number; instruction: string; verbose: boolean; elems: ElemPool; ref: string; el: Elem;
    desc: string; cmdOpName: string; risky: boolean; confirmed: boolean; force: boolean; method: string; conf: number;
    mm: string; decisionKind: "rule" | "model" | "escalate"; layaMargin: number | null;
    tierAsk: { n: number; tier: number } | null; nominatedRepair: boolean; escalatedPick: string | null;
    prevented: number; noted: Record<string, string> | null;
    cmdPick: { cmd: CommandDecl; ref: string; index: number; cands: string[] } | null; commandMode: boolean;
    commandValue: unknown; commandByValue: boolean; slots: Record<string, unknown>; values: Record<string, unknown>;
    candidatePriority: "bucketed" | "main-first"; curHint: string | null; staleRetry: boolean;
    rehydrateRescanFact: unknown; targets: DeclaredTargetsResolver; trace: TraceStep[];
    cmdAttempts: Record<string, number>; blockedRetry: Record<string, [number, number]>; reAdmitted: Set<string>;
    forbidden: Record<string, Sig>; forbid: (ref: string, el: Elem, why: string) => void;
    noteSkipped: (s: SkippedAction) => void; pruneForbids: (pool: ElemPool) => void;
    stop: (code: StopCode, detail?: string, at?: number) => void; stopReason: () => string;
    domFallbackCleanup: () => Promise<void>; getPendingAfterIdx: () => number | null; warnings: string[];
    actionDeclEvidence: () => Record<string, unknown>; refCollision: () => Record<string, unknown>;
    domFallbackEvidence: () => Record<string, unknown>;
  }): Promise<ActionPhaseResult> {
    const { pg, stepNo, instruction, verbose, elems: elems0, ref: ref0, el: el0, desc, cmdOpName, risky, confirmed,
      force, method, conf, mm, decisionKind, layaMargin, tierAsk, nominatedRepair, escalatedPick, prevented, noted,
      cmdPick, commandMode, commandValue, commandByValue, slots, values, candidatePriority, curHint, staleRetry,
      rehydrateRescanFact, targets, trace, cmdAttempts, blockedRetry, reAdmitted, forbidden, forbid, noteSkipped,
      pruneForbids, stop, stopReason, domFallbackCleanup, getPendingAfterIdx, warnings, actionDeclEvidence,
      refCollision, domFallbackEvidence } = a;
    let elems = elems0; let ref = ref0; let el = el0;
    let executedDelta = 0; let lastEffectOut: StateEffect | undefined; let cmdDoneId: string | null = null;
    let nextCmdI: number | null = null;
    // S4：stale 重解析重试的账户（本步内最多 STALE_RETRY_MAX 次；trace 每次记录一条）。
    const STALE_RETRY_MAX = 2;
    const staleRetries: Array<{ attempt: number; reason: string; ref: string }> = [];
    const staleEvidence = (): Record<string, unknown> => (staleRetries.length ? { stale_retry: staleRetries.slice() } : {});
    /** S4：步级 force 声明的执行证据（动作 trace 行上 forced=true）。 */
    const forcedEvidence = (): Record<string, unknown> => (force ? { forced: true } : {});
    /** F72-②：显式重扫事实（trace 行 additive；本步至多一次，没跑 = 键不出现）。 */
    const rehydrateRescanEvidence = (): Record<string, unknown> => (rehydrateRescanFact === null ? {} : { rehydrate_rescan: rehydrateRescanFact });
    /**
     * 重试只能对着**可复现的声明**重新解析：命令 target 优先，其次 act hint（规则命中）。
     * 纯模型挑元素的决策步没有声明目标 ⇒ 不重试（重解析必须复现，不能猜一个"看起来像"的）。
     */
    const declaredStaleTarget = commandMode && cmdPick
      && typeof cmdPick.cmd.target === "string" && cmdPick.cmd.target.trim()
      ? cmdPick.cmd.target
      : (method === "rule:match" && curHint !== null ? curHint : null);
    let pre = await mw.snapshot(pg);
    // Click path goes through the actionability probe: a free element is
    let how: string | null = null;
    let arg: unknown = null;
    /** S1：本动作的 effect 读回（只有 fill 会产生；最后一次非空值进 StepStateRecord）。 */
    let fillEffect: StateEffect | undefined;
    const isScrollCommand = cmdOpName === "scroll";
    const isDragCommand = cmdOpName === "drag";
    const isHoverCommand = cmdOpName === "hover";
    const isClickAtCommand = cmdOpName === "clickAt";
    let actionability: ActionabilityDetail | null = null;
    /** 本条动作（含重试）最后一次 actionability 探针给出的失败原因。 */
    let probeFailure: string | null = null;
    for (let attempt = 0; ; attempt++) {
      how = null; arg = null; fillEffect = undefined; actionability = null; probeFailure = null;
      // force：跳过 actionability 探针，直接按 Playwright force 语义动作（仍要求可定位）。
      // 不点击，如实记 hit_test 证据（绝不静默成功）。命中通过后仍走既有 actionability 探针。
      const declaredNow = targets.getDeclared();
      if (!force && declaredNow !== null && declaredNow.ref === ref && !mw._isTyping(el)
          && !isScrollCommand && !isDragCommand && !isHoverCommand && !isClickAtCommand) {
        const ht = await mw._declaredHitTest(pg, el);
        if (!ht.ok) {
          probeFailure = `hit_test:${ht.kind}`;
          declaredNow.hit_test = ht.kind;
          declaredNow.blocker = ht.blocker;
          actionability = { reason: probeFailure, bbox: null, blocker: ht.blocker, requery: "present" };
        }
      }
      if (probeFailure === null && !force && !mw._isTyping(el) && !isScrollCommand
          && !isDragCommand && !isHoverCommand && !isClickAtCommand) {
        probeFailure = await mw.occludedReason(pg, el);
        // S1：actionability 失败现场（bbox/覆盖者/重查是否还在）；非该原因时保持 null。
        actionability = mw._takeActionabilityDetail();
        if (probeFailure === "__clicked__") {
          try {
            await pg.waitForLoadState("domcontentloaded", { timeout: 3000 });
          } catch {
            /* nothing to wait for */
          }
          how = "clicked";
          arg = null;
        }
      }
      if (probeFailure === null && how === null) {
        // Submit-type inputs carry their label in `value` and must be clicked,
        if (isHoverCommand) {
          // S4：hover 原语——只移动指针（:hover 展开菜单/图层面板），不点击、不导航。
          [how, arg, fillEffect] = await _executeElement(mw, pg, el, slots, null, "hover", force);
        } else if (isClickAtCommand) {
          // U7：坐标点击原语——走 _executeElement 的 clickAt 分支（含坐标解析与 bbox 越界校验），
          [how, arg, fillEffect] = await _executeElement(mw, pg, el, slots, commandMode ? { value: commandValue, byValue: commandByValue } : null, "clickAt", force);
        } else if (isScrollCommand || isDragCommand) {
          // A3：`scroll` 命令可带方向原语 `to`（ctx.command("scroll", sel, {to:"bottom"})）——
          const scrollTo = isScrollCommand ? cmdPick?.cmd.to : undefined;
          if (scrollTo !== undefined) {
            const sr = await _scrollContainerForElement(mw, pg, el, scrollTo);
            how = sr.ok ? "scrolled" : "action_failed";
            arg = sr.ok ? sr.scrollTop : (sr.stopCode ?? "not_scrollable");
          } else {
            [how, arg, fillEffect] = await _executeElement(mw, pg, el, slots, commandMode ? { value: commandValue, byValue: commandByValue } : null, isDragCommand ? "drag" : "scroll", force);
          }
        } else if (!mw._isTyping(el)) {
          [how, arg] = await mw._clickOnly(pg, el, force);
        } else {
          [how, arg, fillEffect] = await _executeElement(mw, pg, el, slots, commandMode ? { value: commandValue, byValue: commandByValue } : null, commandMode ? String(cmdPick!.cmd.op) : undefined, force,
            // U1：决策路径的显式值袋（命令步的具名绑定 `bound` 恒优先，values 不参与）。
            commandMode ? undefined : values);
        }
      }
      // S4 stale 判据（只有这三类；action-timeout / 有覆盖者且节点仍在都不算 stale）。
      const staleReason = probeFailure !== null && probeFailure !== "__clicked__"
        ? (probeFailure === "stale_ref"
          || (probeFailure.startsWith("not-actionable-or-covered") && actionability?.requery === "detached")
          ? probeFailure : null)
        : (how === "stale_ref" || how === "action_failed" ? how : null);
      if (!staleRetry || staleReason === null || attempt >= STALE_RETRY_MAX || declaredStaleTarget === null) break;
      // 重抽池：先给重渲染一个短拍（settle 在脏页上会再等静默），再用**同一声明目标**
      await sleep(120);
      const fresh = (await mw._extractPoolSettled(pg, candidatePriority)).elems;
      pruneForbids(fresh);
      // 命令目标：按 op 的能力面重新排候选并剔除已禁；act hint：同一 hint 语义重解析。
      let freshRef: string | null = null;
      if (commandMode) {
        freshRef = resolveCommandRef(mw, declaredStaleTarget, fresh, cmdOpName || "click", new Set(Object.keys(forbidden)))[0] ?? null;
      } else {
        const r = hintMatch(declaredStaleTarget, fresh, _hintOpts(mw, ));
        if (r !== null && !(r in forbidden)) freshRef = r;
      }
      if (freshRef === null || fresh[freshRef] === undefined) break;   // 此刻仍解析不到：不猜、按原失败报
      const prevDeclared = targets.getDeclared();
      if (prevDeclared !== null && prevDeclared.ref !== freshRef) targets.setDeclared(null);   // 证据只跟同一元素
      staleRetries.push({ attempt: attempt + 1, reason: staleReason, ref: freshRef });
      if (verbose) console.log(`  step ${stepNo}: stale retry ${attempt + 1} (${staleReason}) -> ${freshRef}`);
      elems = fresh;
      ref = freshRef;
      el = fresh[freshRef]!;
      pre = await mw.snapshot(pg);   // 重试动作的 pre 快照 = 此刻页面
    }
    // FW8：身份回捞的章只服务本次动作定位——动作尝试（含 stale 重试）一结束就清，
    await targets.cleanupIdentity();
    await domFallbackCleanup();   // F75：DOM 回退跳的章同样只服务本次动作定位
    // U6/U7：upload 的文件/声明值非法、clickAt 的坐标坏格式/越界都是**配置错误**，
    // 不是页面问题——结构化停在这里，不落成"跳过这个候选继续猜下一个"
    if (how === "config_error") {
      const detail = String(arg ?? `${cmdOpName || "command"} configuration error`);
      forbid(ref, el, "config_error");
      noteSkipped({ ref, reason: "config_error", ...(cmdPick ? { command_id: cmdPick.cmd.id, target: cmdPick.cmd.target ?? null } : {}), detail });
      trace.push({ step: stepNo, desc, how: "config_error", executed: false, method, conf: round3(conf), ref, skipped: true, skip_reason: "config_error", url: urlOf(pg), ...(cmdPick ? { command: cmdPick.cmd.id } : {}),
        ...actionDeclEvidence(), ...forcedEvidence(), ...staleEvidence(), ...rehydrateRescanEvidence(), ...refCollision(), ...identityEvidence(targets.identity), ...declaredEvidence(targets.getDeclared()), ...domFallbackEvidence(),
      });
      stop("config_error", detail, stepNo);
      if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
      return { control: "break", ref, el, elems };
    }
    if (fillEffect !== undefined) {
      lastEffectOut = fillEffect;
      // S5b：摘要只留 kind/applied（值本身可能是凭据/隐私，进模型上文的面只要事实）。
      mw._lastEffectSeen = { kind: fillEffect.kind, applied: fillEffect.applied };
    }
    const executed = how === "clicked" || how === "filled" || how === "scrolled"
      || how === "dragged" || how === "hovered" || how === "uploaded";
    if (!executed) {
      // 末次失败原因：actionability 探针给出的，或动作本身返回的（stale_ref/needs_value/
      const reason = probeFailure !== null && probeFailure !== "__clicked__" ? probeFailure : String(how);
      // needs_value / stale_ref: this element cannot advance the plan right
      forbid(ref, el, reason);
      if (reason.startsWith("not-actionable-or-covered") && !reAdmitted.has(ref)) {
        blockedRetry[ref] = [stepNo, trace.length];
      }
      // A1：动作阶段没执行成 —— skipped_actions 记原因与命令身份（零执行步骤的证据）。
      // S1：not-actionable-or-covered 另附结构化现场（bbox/覆盖者/重查节点是否还在）。
      noteSkipped({
        ref, reason, ...(cmdPick ? { command_id: cmdPick.cmd.id, target: cmdPick.cmd.target ?? null } : {}), ...(actionability === null ? {} : {
          detail: `bbox=${actionability.bbox === null ? "?" : `${actionability.bbox.x},${actionability.bbox.y} ${actionability.bbox.width}x${actionability.bbox.height}`}`
            + `; blocker=${actionability.blocker ?? "none"}; requery=${actionability.requery}`,
        }),
      });
      // A2：命令步的候选尝试计数（前 4 个为止；失败的候选已被 forbid，下一步换下一个）。
      if (cmdPick) cmdAttempts[cmdPick.cmd.id] = (cmdAttempts[cmdPick.cmd.id] ?? 0) + 1;
      trace.push({ step: stepNo, desc, how: reason, executed: false, method, conf: round3(conf), ref, skipped: true, skip_reason: reason, url: urlOf(pg), ...(cmdPick ? { command: cmdPick.cmd.id } : {}), ...(actionability === null ? {} : { actionability }),
        ...actionDeclEvidence(), ...forcedEvidence(), ...staleEvidence(), ...rehydrateRescanEvidence(), ...refCollision(), ...identityEvidence(targets.identity), ...declaredEvidence(targets.getDeclared()), ...domFallbackEvidence(),
      });
      if (verbose) console.log(`  step ${stepNo}: (${reason}, ${method}) -> skip ${ref}`);
      return { control: "continue", ref, el, elems };
    }
    const post = await mw.snapshot(pg);
    // U7：clickAt 的实际点击坐标进证据（trace 行 position + executed_actions.position）；
    const clickRaw = cmdOpName === "clickAt" && typeof arg === "object" && arg !== null
      ? (arg as { position?: unknown }).position
      : undefined;
    const clickPosition = typeof clickRaw === "object" && clickRaw !== null
      && typeof (clickRaw as { x?: unknown }).x === "number"
      && typeof (clickRaw as { y?: unknown }).y === "number"
      ? { x: (clickRaw as { x: number }).x, y: (clickRaw as { y: number }).y }
      : null;
    // U6：upload 的 changed 是**动作结果**而不是快照 diff——文件写进 input 不一定改
    const upload = how === "uploaded" && typeof arg === "object" && arg !== null ? arg as { files?: unknown; count?: unknown; expected?: unknown } : null;
    const uploadFiles = upload !== null && Array.isArray(upload.files)
      ? upload.files.filter((f): f is string => typeof f === "string")
      : null;
    // A1：changed = pre/post 快照是否变化（诚实字段，供审查判"点击成功但页面没动"）。
    const changed = upload !== null
      ? Number(upload.count) >= Number(upload.expected)
      : JSON.stringify(pre) !== JSON.stringify(post);
    // scroll 改变的是 viewport，不是 url/text/input 快照；不能把“快照没变”误判成 inert。
    const inert = (how === "scrolled" || how === "dragged" || how === "hovered") ? false : !changed;
    // A1：本子目标真的执行了几个动作（零执行步骤的判据）。
    executedDelta = 1;
    // P2: an executed command is ACTED whether or not the page moved — the walk
    if (executed && cmdPick) {
      cmdDoneId = cmdPick.cmd.id; nextCmdI = cmdPick.index + 1;
    }
    // A1：动作身份（op/ref/target）落 trace —— executed_actions / skipped_actions 从这里对账。
    const actionOp = commandMode && cmdPick ? String(cmdPick.cmd.op)
      : how === "filled" ? (el.tag === "select" ? "select" : "fill")
      : how === "scrolled" ? "scroll"
      : how === "dragged" ? "drag"
      : how === "hovered" ? "hover"
      : "click";
    // A1 §2.2.5：click 执行了、但 pre/post 快照没变，随后 done 却成立 —— 这不是"死元素"，
    const flagSuspectedAsync = (): void => {
      if (how !== "clicked" || changed) return;
      const idx = getPendingAfterIdx();
      const row = idx === null ? undefined : trace[idx];
      if (row !== undefined) {
        row.inert = false;            // 不是 inert：效果在快照之后到达
        row.suspected_async = true;
      }
      const warning = `suspected_async: click on ${el.tag} "${el.label}" did not change the pre/post snapshot, but the done signal held afterwards (step ${stepNo})`;
      warnings.push(warning);
      if (verbose) console.log(`  step ${stepNo}: ${warning}`);
    };
    // F83：行证据（row_evidence，v1.0 §3.7 目标⑤）——声明 row-index/in-row 的目标解析
    const rowDeclaredHint = commandMode && cmdPick ? String(cmdPick.cmd.target ?? "") : curHint;
    const rowParsed = rowDeclaredHint ? parseHint(rowDeclaredHint) : null;
    const rowEvidenceOut = rowEvidence(el, rowParsed);
    trace.push({ step: stepNo, desc, how, value: redactValue(el, uploadFiles ?? (clickPosition !== null ? null : arg)), risky, executed, confirmed, method, decision_kind: decisionKind, conf: round3(conf), ...(cmdPick ? { command: cmdPick.cmd.id } : {}),
      ref, op: actionOp, ...(cmdPick?.cmd.target !== undefined && cmdPick.cmd.target !== "" ? { target: cmdPick.cmd.target } : {}), changed, ...(uploadFiles !== null ? { files: uploadFiles } : {}),
      ...(clickPosition !== null ? { position: clickPosition } : {}), ...(nominatedRepair ? { nominated_family_repair: true } : {}), ...(decisionKind === "model" && layaMargin !== null
        ? { margin: Math.round(layaMargin * 1000) / 1000 } : {}), ...(method === "escalate" && escalatedPick ? { escalated: true } : {}), ...(prevented ? { prevented } : {}), ...(noted ? { noted: Object.keys(noted).length } : {}),
      ...(tierAsk ? { hint_tier: tierAsk } : {}),   // P1: this pick answered a NARROWED question
      ...(decisionKind === "model" && mw.lastPickEvidence !== null ? { evidence_truncated: mw.lastPickEvidence } : {}),
      inert, url: urlOf(pg), ...actionDeclEvidence(), ...forcedEvidence(), ...staleEvidence(), ...rehydrateRescanEvidence(), ...refCollision(),
      ...identityEvidence(targets.identity), ...declaredEvidence(targets.getDeclared()), ...domFallbackEvidence(), ...rowEvidenceOut,
    });
    // A1 子改动③：这个已执行动作的 after 签名等下一次观察落账（见循环头部的落账点）。
    return { control: "next", ref, el, elems, desc, how, executed, inert, post, lastEffect: lastEffectOut,
      flagSuspectedAsync, cmdDoneId, nextCmdI, executedDelta };
  }

  /** 4d 阶段：active setup（重置/ready/config+信封早返回/launch+newPage/goto+settle/observeState 闭包）。 */
export async function runSetup(mw: BrowserMiddleware, a: {
    instruction: string; startUrl: string; hostGate: string[] | null; verbose: boolean;
    pageIn: AnyPage | null; pwIn: PwLike | null; skipNavigation: boolean; settleMs: number | undefined;
  }): Promise<SetupPhase> {
    const { instruction, startUrl, hostGate, verbose, pageIn, pwIn, skipNavigation, settleMs } = a;
  let browser: BrowserHandle | null = null; const ownsBrowser = pageIn === null; let page: AnyPage | null = pageIn;
    mw._state = { epoch: 0, navEpoch: 0, current: null }; mw._lastActionabilityDetail = null;
    mw._settleWaitMs = 0;
    // S5：上次 ask 的题面/答复与 run 内 flags 都是 run 内口径（refs 会重编号）；指标不重置。
    mw._lastAsk = null; mw._askedPools.clear();
    mw._runFlags = []; mw._lastEffectSeen = null;
    await mw.ready();
    // A config error is not a transient failure: acting on rules-only anyway would
    // silently downgrade what the operator explicitly configured, and retrying it
    // just repeats the same error with more side effects (D6). Refuse cleanly,
    // BEFORE the navigation envelope and before a single step.
    if (mw.configError !== null) {
      const why = `model runtime config error: ${mw.configError}`;
      if (verbose) console.log(`  -> REFUSED before navigation: ${why}（配置类错误不重试、不降级跑）`);
      return { kind: "early", browser, report: {
        goal: instruction, done: false,
        stop_reason: why, stop_code: "config_error",
        steps: [],
        audit: { verdict: "REJECT", reasons: [why], auditor: "preflight" },
      } };
    }
    // NAVIGATION ENVELOPE (P0-4): refuse BEFORE the browser opens the page. A
    // refused subgoal has touched nothing — zero steps, zero side effects.
    const deniedHost = disallowedHost(startUrl, hostGate);
    if (deniedHost !== null) {
      const why = `host not allowed: '${deniedHost}' is not among the declared hosts `
        + `(${hostGate!.join(", ")}) — add it to the pack's hosts list if this step is meant to leave for it`;
      if (verbose) console.log(`  -> REFUSED before navigation: ${why}`);
      return { kind: "early", browser, report: {
        goal: instruction, done: false,
        stop_reason: why, stop_code: "host_not_allowed",
        steps: [],
        audit: { verdict: "REJECT", reasons: [why], auditor: "navigation-envelope" },
      } };
    }
    if (ownsBrowser) {
      // PORT NOTE 5: `sync_playwright()` has no twin; the module IS the
      // connection. Use the injected pw when given, else the imported one.
      let pw = pwIn;
      if (pw === null) { const mod = await import("playwright"); pw = { chromium: mod.chromium as unknown as PwLike["chromium"] }; }
      browser = (await browserEnv.launch(pw, true)) as unknown as BrowserHandle;
      page = (await browser.newPage()) as AnyPage;
    }
    const pg = page as AnyPage;
    /**
     * S1：生成一次状态指纹并推进 cursor。`elems` 用**已有观察**（步首池）传进来；
     * 收尾处才允许传 null（此时由调用方决定是否先重新抽池）。只读，不发动作。
     */
    const observeState = async (elems: ElemPool | null): Promise<StateFingerprint> => {
      mw._state.epoch += 1;
      let url = "";
      try { url = String(urlOf(pg as never) ?? ""); } catch { url = ""; }
      let readyState: ReadyState = "complete";
      try {
        const rs = await pg.evaluate(() => (globalThis as unknown as { document?: { readyState?: unknown } }).document?.readyState);
        if (rs === "loading" || rs === "interactive" || rs === "complete") readyState = rs;
      } catch { /* 页面已关闭：readyState 只是诊断，不阻塞收尾 */ }
      const struct = structDigest(elems); const content = contentDigest(elems);
      const fp: StateFingerprint = { epoch: mw._state.epoch, navEpoch: mw._state.navEpoch, url, readyState, struct, ...(content === undefined ? {} : { content }) };
      mw._state.current = fp; return fp;
    };
    if (!skipNavigation) {
      await pg.goto(startUrl, { waitUntil: "domcontentloaded", timeout: mw.gotoTimeout }); mw._state.navEpoch += 1;
      // S2：导航会丢掉 window 上下文——observer 在 goto 后重装（幂等；只作传感器）。
      if (mw.settlePolicy !== null) await installSettle(pg as unknown as SettlePage);
      if (typeof settleMs === "number" && settleMs > 0) {
        await new Promise((r) => setTimeout(r, settleMs));
      }
    }
    if (hostGate && hostGate.length) {
      const deniedPopup = deniedContextUrl(pg, hostGate);
      if (deniedPopup !== null) {
        const why = `popup not allowed: ${deniedPopup} is outside the declared hosts envelope (${hostGate.join(", ")}) — popup/new-tab origins are part of the same host gate`;
        if (verbose) console.log(`  -> REFUSED before navigation: ${why}`);
        return { kind: "early", browser, report: {
          goal: instruction, done: false, stop_reason: why, stop_code: "popup_not_allowed",
          steps: [], audit: { verdict: "REJECT", reasons: [why], auditor: "navigation-envelope" },
        } };
      }
    }
  return { kind: "ready", pg, browser, observeState };
  }

  /**
   * F3：run() 报告尾（原 run 内 finally 之后的收尾块）。只读执行循环留下的
   * 状态快照（RunReportTailCtx），产出最终 RunReport。零行为差异——逻辑逐行
   * 平移，仅把 run() 局部变量改为 ctx.xxx；`ctx.stop` 由 run() 包装原 stop
   * 闭包并同步 ctx.stopCode/stopReason/stopStep（false_done 档需要）。
   */
  /** 4d 阶段：循环后 run 级 epilogue（after 指纹 / 前进性 / flags / _runFlags / stepState）。 */
export async function runTail(mw: BrowserMiddleware, a: {
    pg: AnyPage; candidatePriority: "bucketed" | "main-first";
    observeState: (elems: ElemPool | null) => Promise<StateFingerprint>;
    trace: TraceStep[]; beforeFp: StateFingerprint | null; lastEffect: StateEffect | null;
    poolEmptyThisStep: boolean; donePreheldSeen: boolean; done: boolean; warnings: string[];
  }): Promise<StepStateRecord | undefined> {
    const { pg, candidatePriority, observeState, trace, beforeFp, lastEffect, poolEmptyThisStep, donePreheldSeen, done, warnings } = a;
    let afterFp: StateFingerprint | undefined;
    try { afterFp = await observeState((await mw._extractPoolSettled(pg, candidatePriority)).elems); } catch { afterFp = undefined; }
    const actionRows = trace.filter((t) => t.executed === true || t.skipped === true);
    const attempted = actionRows.length;
    const executedN = actionRows.filter((t) => t.executed === true).length;
    const changedN = actionRows.filter((t) => t.executed === true && t.changed === true).length;
    const observed = beforeFp !== null && afterFp !== undefined; // 没看见 ≠ 没前进
    const progressed = beforeFp !== null && afterFp !== undefined && (afterFp.struct !== beforeFp.struct || afterFp.url !== beforeFp.url || afterFp.navEpoch !== beforeFp.navEpoch);
    const lastActionStep = actionRows.length ? Number((actionRows[actionRows.length - 1] as Record<string, unknown>)["step"] ?? 0) || undefined : undefined;
    const flags: StateFlag[] = [];
    if (poolEmptyThisStep) flags.push("pool_empty");
    if (donePreheldSeen) flags.push("done_preheld");
    if (done && observed && attempted > 0 && executedN > 0 && changedN === 0 && !progressed) {
      flags.push("no_state_progress");
      warnings.push(
        `no_state_progress: done held after ${executedN} executed action(s) but the page snapshot `
        + `did not change and the state fingerprint did not advance`
        + (lastActionStep === undefined ? "" : ` (step ${lastActionStep})`)
        + ` — the signal may not be evidence of the action`,
      );
    }
    mw._runFlags = [...flags]; // S5b：下一次 ask 的 state_digest 只带已发生的 flags
    if (beforeFp === null) return undefined;
    return {
      before: beforeFp,
      ...(afterFp === undefined ? {} : { after: afterFp }),
      ...(mw.settlePolicy === null ? {} : { settleMs: mw._settleWaitMs }),
      actions: { attempted, executed: executedN, changed: changedN },
      flags,
      ...(lastEffect === null ? {} : { effect: lastEffect }),
    };
  }

export async function runReportTail(mw: BrowserMiddleware, ctx: RunReportTailCtx): Promise<RunReport> {
    // P0-D：done 只在被排除 frame 上成立 = 完成依赖被排除帧，结构化停因（不留假成功，
    // 也不混成普通 done_not_held）。
    if (!ctx.done && ctx.doneInExcluded) {
      ctx.stopCode = "frame_not_allowed";
      ctx.stopReason = `done signal holds only inside frame(s) `
        + `${ctx.frameGate === null ? "-" : ctx.frameGate.origins.join(", ")} excluded by the declared hosts envelope `
        + `(${(ctx.hostGate ?? []).join(", ")}) — `
        + `frames_excluded 只是默认排除第三方非交互 frame，不需要为此加 hosts；`
        + `仅当声明 done 确需该 frame 时才评估把它的 origin 加进 meta.hosts，`
        + `否则把 done 锚到允许 frame 内的事实`;
    }
    // P0-E 完成语义诚实：done 成立后的**只读**复核 guard（false_done）。不改完成判定——
    // 除非 policy.done_guard:"fail"；缺省 warn 档只把证据记进 warnings（步骤仍 ok）。
    // 触发面：① 登录墙特征（主 frame URL 词边界命中 / title 或 h1-h3 登录文案 /
    // 跨出 meta.hosts 信封）；② 有动作但全部 changed=false 且 done 是否定式（零前进蹭成立）。
    if (ctx.done && !ctx.manualDone && !ctx.dryRan && ctx.goalSignalFn !== null && ctx.page !== null) {
      const liveUrl = (() => { try { return String(urlOf(ctx.page) ?? ""); } catch { return ""; } })();
      const ev = await (async (): Promise<Record<string, string> | null> => {
        const out: Record<string, string> = {};
        if (LOGIN_WALL_URL_RE.test(liveUrl)) out.url_hit = liveUrl;
        if (ctx.hostGate !== null && ctx.hostGate.length > 0 && liveUrl
          && !urlInHostsEnvelope(liveUrl, ctx.hostGate)) out.host_outside = liveUrl;
        try {
          const r = await (ctx.page as AnyPage).evaluate(FN_GUARD) as { hit?: string | null; where?: string | null };
          if (r && r.hit) out.text_hit = `${r.where}: "${r.hit}"`;
        } catch { /* 只读复核拿不到就跳过这一项，不影响判定 */ }
        return Object.keys(out).length ? out : null;
      })();
      const zeroProgress = ctx.doneSpec !== null && isWeakNegativeSignal(ctx.doneSpec)
        && ctx.executedCount > 0 && !ctx.trace.some((t) => t["executed"] === true && t["changed"] === true);
      if (ev !== null || zeroProgress) {
        const parts: string[] = [];
        if (ev?.url_hit) parts.push(`main-frame URL matches a login-wall feature`);
        if (ev?.text_hit) parts.push(`page text matches a login-wall feature (${ev.text_hit})`);
        if (ev?.host_outside) parts.push(`main frame is outside the declared hosts envelope`);
        if (zeroProgress) parts.push("done is negative-only and executed action(s) changed nothing (changed=false)");
        const why = `false_done guard: the done signal held but ${parts.join("; ")} `
          + `— completion may have been borrowed by unrelated navigation `
          + `(R11: a mis-click to a login page counted as success); current URL: ${liveUrl || "(unknown)"}; `
          + `evidence: ${JSON.stringify(ev ?? {})} `
          + `；修法：给 done 配正向锚（exists/holds/url），如 all_of(not(...), 正向锚)，必要时配 ctx.judge.loginWall()`
          + `；可直接抄的构造器：done: ctx.judge.all(not(ctx.judge.loginWall()), <正向锚>)`
          + `（信号语言的 all_of；loginWall 是 kit 一等构造器；<正向锚> 换成动作后才成立的 exists/holds/url 事实）`;
        if (mw.doneGuardPolicy === "fail") {
          ctx.done = false;
          ctx.stop("false_done", why);
          if (ctx.verbose) console.log(`  step: ${ctx.stopReason}`);
        } else {
          if (!ctx.warnings.some((w) => w.startsWith("false_done:"))) ctx.warnings.push(`false_done: ${why}`);
          if (ctx.verbose) console.log(`  step: warning false_done (done stays ok; policy.done_guard="warn")`);
        }
      }
    }
    const verdict = (await mw.auditor.audit(ctx.instruction, ctx.trace, ctx.done)) as AuditVerdict;
    const stoppedCode = ctx.stopCode as StopCode;
    // task-11（B3，评审 #8）：信号不成立时的会话级骤降嗅探——限速/降频判读证据。
    // 组合判据防误报（正常小页面本来元素就少，不触发）：本会话池高峰 ≥20 且当前池 ≤ 高峰/4
    // （probe3 现场 202→15），或两次失败嗅探之间正文塌缩（prev ≥2000 且 cur ≤ prev/4）。
    // 成本：只有失败路径付一次只读 sniff（U3 同款底座 poolSniff）；成功路径零改动。
    // 不新增 stopCode（stopCode 表是脚本分支契约）——warning + diagnostics 证据，判读
    // 指引见 docs/APP_SCRIPT_AUTHORING.md §10（已知处置：冷却/降频/分批，不绕过）。
    let throttleSuspect: ThrottleSuspect | null = null;
    if (ctx.done !== true && ctx.lastPageRef !== null) {
      let failSniff: Awaited<ReturnType<typeof poolSniff>> | null = null;
      try {
        failSniff = await poolSniff(ctx.lastPageRef as never, admitSelectorWithJsFor(mw.surfacePolicy));
      } catch { /* 观察让位事实：页面已不可读时不硬来 */ }
      const bodyPrev = mw._lastFailSniff?.body_text ?? null;
      const admittedPrev = mw._lastFailSniff?.admitted ?? null;
      // task-24/6a：阈值单源化（throttle-signature.ts——step 侧与 arrive 侧共用，标定改一处）。
      const poolDrop = mw._sessionPoolHigh >= THROTTLE_POOL_HIGH_MIN
        && ctx.lastPoolSize > 0
        && ctx.lastPoolSize * THROTTLE_COLLAPSE_RATIO <= mw._sessionPoolHigh;
      const bodyDrop = bodyPrev !== null && bodyPrev >= THROTTLE_BODY_FLOOR
        && failSniff !== null && failSniff.body_text * THROTTLE_COLLAPSE_RATIO <= bodyPrev;
      if (failSniff !== null && (poolDrop || bodyDrop)) {
        const dh = ctx.getLastDeclaredHidden();
        throttleSuspect = {
          evidence: {
            pool_size: ctx.lastPoolSize,
            pool_size_session_high: mw._sessionPoolHigh,
            body_text: failSniff.body_text,
            ...(bodyPrev !== null ? { body_text_prev: bodyPrev } : {}),
            admitted: failSniff.admitted,
            ...(admittedPrev !== null ? { admitted_prev: admittedPrev } : {}),
            ready_state: String(failSniff.ready_state ?? "unknown"),
            session_elapsed_ms: mw._sessionFirstPoolTs === 0
              ? 0 : Date.now() - mw._sessionFirstPoolTs,
            ...(dh !== null
              ? { declared_hidden: { target: dh.target, hidden: dh.hidden, total: dh.total } }
              : {}),
          },
        };
        ctx.warnings.push(`throttle_suspect: 信号不成立且观测到会话级骤降`
          + `（池 ${mw._sessionPoolHigh}→${ctx.lastPoolSize}${bodyDrop ? `；正文 ${bodyPrev}→${failSniff.body_text}` : ""}`
          + `；本会话已运行 ${throttleSuspect.evidence.session_elapsed_ms}ms）`
          + "——疑似站点限速/降频/风控分批。已知处置：冷却后重试、降频（拉大 meta.pace）、分批跑，不绕过反爬；"
          + "证据见 step_traces[].result.diagnostics.throttle_suspect");
      }
      // 失败嗅探即基线（无论是否触发）：下一次失败对比用它。正文峰值同步记账
      // （task-16/B3+：arrive 侧限速判据的基线来源——仍只在失败路径更新，成功路径零成本）。
      if (failSniff !== null && failSniff.body_text > mw._bodyTextPeak) {
        mw._bodyTextPeak = failSniff.body_text;
      }
      mw._lastFailSniff = failSniff === null
        ? null : { body_text: failSniff.body_text, admitted: failSniff.admitted };
    }
    const diagnostics: RunReport["diagnostics"] | undefined = (
      stoppedCode === "page_not_ready" || stoppedCode === "target_not_found"
      || stoppedCode === "target_ambiguous" || stoppedCode === "action_space_exhausted"
      // U3：ready_empty 没有停因（步级继续），但"池空且已就绪"是必须落盘的事实。
      || (ctx.lastReadiness !== null && ctx.lastReadiness.verdict !== "ready")
      // B3：限速判读证据落盘（该步信号不成立 + 会话级骤降）。
      || throttleSuspect !== null
    ) ? {
      pool_size: ctx.lastPoolSize,
      ...(ctx.poolReady ? { waited_ms: ctx.lastPoolWaitedMs } : {}),
      ...(ctx.viewportUnderloaded !== null ? { viewport_underloaded: ctx.viewportUnderloaded } : {}),
      ...(ctx.lastReadiness !== null && ctx.lastReadiness.verdict !== "ready" ? { readiness: ctx.lastReadiness } : {}),
      ...(throttleSuspect !== null ? { throttle_suspect: throttleSuspect } : {}),
    } : undefined;
    // A1 动作执行证据汇总（只从 trace 汇总一次，不新增页面往返）：
    //   executed        —— 本子目标是否有动作真的执行（有动作面时必答；缺字段 = 没有动作面）；
    //   executed_actions—— 每个已执行动作的 op/ref/target/how/changed；
    //   skipped_actions —— 每条"为什么没动作"的结构化原因（见 skippedActions）；
    //   done_preheld    —— 命令步动作前的 done 预评估（缺字段 = 本步不是命令步/没信号）；
    //   warnings        —— suspected_async 等运行期诚实话。
    // 动作行 = 有 changed（执行过）或有 skipped（尝试过但没执行）的行；manual 等非动作行不混进来。
    const actionRows = ctx.trace.filter((t) =>
      Object.prototype.hasOwnProperty.call(t, "changed") || t["skipped"] === true);
    const executedRows = actionRows.filter((t) => t["executed"] === true
      && ["clicked", "filled", "scrolled", "dragged", "hovered", "uploaded"].includes(String(t["how"] ?? "")));
    const hasActionFace = ctx.cmdSpace.length > 0 || actionRows.length > 0;
    const executedActions: ExecutedAction[] = executedRows.map((t) => {
      const rawHow = String(t["how"] ?? "clicked");
      const files = Array.isArray(t["files"])
        ? (t["files"] as unknown[]).filter((f): f is string => typeof f === "string")
        : null;
      // U7：clickAt 的元素相对坐标从 trace 行原样汇总（声明值与实测点击同源）。
      const p = t["position"] as { x?: unknown; y?: unknown } | undefined;
      const position = p !== undefined && typeof p.x === "number" && typeof p.y === "number"
        ? { x: p.x, y: p.y }
        : null;
      return {
        op: String(t["op"] ?? rawHow ?? "click"),
        target: typeof t["target"] === "string" ? t["target"] : null,
        ref: String(t["ref"] ?? ""),
        // U6：upload 的动作结果词是 uploaded，证据面按 Playwright 原语名记 setInputFiles。
        how: (rawHow === "uploaded" ? "setInputFiles" : rawHow) as ExecutedAction["how"],
        desc: String(t["desc"] ?? ""),
        changed: t["changed"] === true,
        ...(files !== null ? { files } : {}),
        ...(position !== null ? { position } : {}),
        ...(t["resolved_by"] === "dom_identity" ? { resolved_by: "dom_identity" as const } : {}),
        ...(t["resolved_by"] === "declared_dom" ? { resolved_by: "declared_dom" as const } : {}),
        // F75 评审收口：run 决策步 DOM 回退跳的解析事实此前只活在 raw trace，结果面丢失。
        ...(t["resolved_by"] === "dom_fallback" ? { resolved_by: "dom_fallback" as const } : {}),
        ...(typeof t["declared_resolve"] === "object" && t["declared_resolve"] !== null
          ? { declared_resolve: t["declared_resolve"] as NonNullable<ExecutedAction["declared_resolve"]> } : {}),
      };
    });
    // S4 证据汇总：stale 重试每次一条（trace 行本来就一次只落一行），force 只在真正执行时出现。
    const staleRetries: Array<{ attempt: number; reason: string; ref: string }> = [];
    for (const t of ctx.trace) {
      if (Array.isArray(t["stale_retry"])) {
        staleRetries.push(...(t["stale_retry"] as Array<{ attempt: number; reason: string; ref: string }>));
      }
    }
    const forcedExecuted = executedRows.some((t) => t["forced"] === true);
    // F72-②：重扫事实汇总——trace 行优先（既有形状不变）；strict 落空在动作行之前早停时
    // trace 没有承载行，退化为 run() 直传的本 run 事实（两者都没有 = 键不出现）。
    const tracedRescan = ctx.trace.map((t) => t["rehydrate_rescan"])
      .find((v) => v !== undefined) as RehydrateRescanFact | undefined;
    const rehydrateRescanFact: RehydrateRescanFact | null = tracedRescan ?? ctx.rehydrateRescanFact;
    return {
      goal: ctx.instruction, done: ctx.done, stop_reason: ctx.stopReason, steps: ctx.trace, audit: verdict,
      stop_code: ctx.stopCode,
      ...(hasActionFace ? { executed: executedRows.length > 0 } : {}),
      ...(executedActions.length ? { executed_actions: executedActions } : {}),
      ...(ctx.skippedActions.length ? { skipped_actions: ctx.skippedActions.slice(0, 20) } : {}),
      ...(staleRetries.length ? { stale_retries: staleRetries } : {}),
      ...(rehydrateRescanFact === null ? {} : { rehydrate_rescan: rehydrateRescanFact }),
      ...(forcedExecuted ? { forced: true } : {}),
      ...(ctx.donePreheld !== null ? { done_preheld: ctx.donePreheld } : {}),
      ...(ctx.warnings.length ? { warnings: ctx.warnings } : {}),
      ...(ctx.stepState === undefined ? {} : { state: ctx.stepState }),
      ...(diagnostics !== undefined ? { diagnostics } : {}),
      ...(ctx.stopStep !== undefined ? { stop_step: ctx.stopStep } : {}),
      ...(ctx.manualDone ? { manual: true } : {}),
      ...(ctx.dryRan ? { dry_run: true } : {}),
    };
  }
