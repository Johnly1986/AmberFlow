/**
 * 执行器实现模块（从 executor.ts 切分，大文件拆分 X1）：本文件函数都是
 * `BrowserMiddleware` 的实现片段，显式接收 `mw` 实例（唯一执行循环仍在 executor.ts）。
 */
import { induceHint } from "../model/hint-memory.ts";
import { sleep } from "../support/sleep.ts";
import { type TraceStep } from "./audit.ts";
import { contextPageCount, deniedContextUrl, disallowedHost, round3 } from "./executor-pure.ts";
import { contextNavError, navErrorStopReason } from "./nav-error.ts";
import { type AnyPage, type HintMemoryLike, type OutcomeMemoryLike, type StopCode } from "./executor-types.ts";
import { type Elem, type ElemPool, esig, urlOf } from "./extraction.ts";
import type { BrowserMiddleware, PostActionPhase } from "./executor.ts";

  /** 4d 阶段：动作后阶段（日志 → host/popup 信封复核 → learned-hint → done 评估/学习 →
   * SPA settle → manual → noul → 重复守卫 → inert/anti-repeat）。早停 stop()/日志已在此记账；
   * 返回 control 决定调用点 continue/break。run 级 epilogue（_runFlags/stepState）留在 run()。 */
export async function runPostAction(mw: BrowserMiddleware, a: {
    pg: AnyPage; stepNo: number; verbose: boolean; instruction: string; elems: ElemPool; ref: string; el: Elem;
    desc: string; how: string; method: string; conf: number; inert: boolean; executed: boolean; mm: string;
    decisionKind: "rule" | "model" | "escalate";
    post: { url: string }; hostGate: string[] | null; trace: TraceStep[];
    setPendingAfterIdx: (idx: number) => void; done: boolean; manualDone: boolean; donePreheld: boolean | null;
    manualGoal: boolean; manualConfirmFn: ((desc: string, stateExcerpt: string) => boolean | Promise<boolean>) | null;
    goalSignalFn: ((page: AnyPage) => boolean | Promise<boolean>) | null; goalHeld: () => Promise<boolean>;
    cmdWalkComplete: () => boolean; flagSuspectedAsync: () => void; forbid: (ref: string, el: Elem, why: string) => void;
    outcomeMemory: OutcomeMemoryLike | null; effectiveRuns: Record<string, number>; hintMemory: HintMemoryLike | null;
    doneTimeoutMs: number; donePollMs: number; stepStartUrl: string; stepStartTabs: number;
    stop: (code: StopCode, detail?: string, at?: number) => void; stopReason: () => string;
    isDone: (instruction: string, page: AnyPage) => Promise<number>;
  }): Promise<PostActionPhase> {
    const { pg, stepNo, verbose, instruction, elems, ref, el, desc, how, method, conf, inert, executed, mm, decisionKind, post,
      hostGate, trace, donePreheld, manualGoal, manualConfirmFn, goalSignalFn, goalHeld, cmdWalkComplete,
      flagSuspectedAsync, forbid, outcomeMemory, effectiveRuns, hintMemory, doneTimeoutMs, donePollMs,
      stepStartUrl, stepStartTabs, stop, stopReason, isDone, setPendingAfterIdx,
      done: done0, manualDone: manualDone0 } = a;
    let done = done0; let manualDone = manualDone0;
    setPendingAfterIdx(trace.length - 1);
    if (verbose) console.log(`  step ${stepNo}: ${desc} (${how}, ${method}, conf=${conf.toFixed(2)}${inert ? ", inert" : ""})`);
    // 导航失败先于信封判定：Chrome 错误页的 URL host 是 `chromewebdata`，直接判信封会把
    // 「网络不通」说成「越界/popup 越界」。run 面停因闭集不加 `unreachable`（冻结契约），
    // 分类与处置建议由 `navErrorStopReason` 写进 reason，与 pilot 面的建议同源不打架。
    const navFailure = await contextNavError(pg);
    if (navFailure !== null) {
      stop("config_error", `${navErrorStopReason(navFailure)} on step ${stepNo}`, stepNo);
      if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
      return { control: "break", done, manualDone };
    }
    // NAVIGATION ENVELOPE, post-action half: an executed action must not land
    const landed = disallowedHost(post.url, hostGate);
    if (landed !== null) {
      stop("host_not_allowed",
        `navigated off the envelope to '${landed}' — not among the declared hosts (${hostGate!.join(", ")}) on step ${stepNo}`, stepNo);
      if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
      return { control: "break", done, manualDone };
    }
    if (hostGate && hostGate.length) {
      const landedPopup = deniedContextUrl(pg, hostGate);
      if (landedPopup !== null) {
        stop("popup_not_allowed",
          `action opened ${landedPopup} outside the declared hosts envelope (${hostGate.join(", ")}) on step ${stepNo}`, stepNo);
        if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
        return { control: "break", done, manualDone };
      }
    }

    if (executed && !inert && mw._learnedHintApplied && method === "rule:match") {
      (hintMemory as HintMemoryLike | null)?.countUsed?.(1);
    }
    if (executed && !inert) mw._advanceHint();
    // A1：多动作闭集（N≥2）未走完时，中间动作不评估 done（goalSignalFn 不付这次页面往返）；
    // 同时上面"信号成立才学的 hint"也自然不会学到中间态。单命令/无命令步恒真，逐字节原行为。
    if (goalSignalFn && cmdWalkComplete() && (await goalHeld())) {
      // A MODEL pick that actually advanced the subgoal is a hint we EARNED: record
      if (hintMemory && mw._hintKey && (decisionKind === "model" || decisionKind === "escalate")) {
        // F84（批 3）首项：记忆产物带行锚——池在手（elems）时 dup 成员且普通形状
        // 不自证唯一 ⇒ suggestHints 第 5 档**内容**行锚候选（复用，不发明第二套生成
        // 逻辑）；评审收口：单用 row-index 位置性 hint 不进记忆（见 hint-memory.ts）。
        // F84 面覆盖补齐：run 面的 `hint_token_allow` 同批下传到记忆生成面（词元护栏
        // 放行表在 record 面与歧义证据面同口径）。
        const learned = induceHint(el, elems,
          mw.hintTokenAllow !== undefined ? { tokenAllow: mw.hintTokenAllow } : undefined);
        if (learned) {
          hintMemory.record(mw._hintKey, learned);
          if (verbose) console.log(`  step ${stepNo}: learned hint ${learned} for this page+subgoal`);
        }
      }
      done = true;
      flagSuspectedAsync();
      stop("dom_goal_signal", "dom goal signal", stepNo);
      return { control: "break", done, manualDone };
    }
    // ---- SPA settle ------------------------------------------------------
    if (goalSignalFn && executed) {
      // A1：闭集未走完时中间动作不进入 done 轮询（评估推迟到最后一个命令之后；单命令步不变）。
      // popup 复扫不 gate：它不是 done 评估，是导航信封的安全复扫，逐动作都该付。
      if (cmdWalkComplete()) {
        const settleDeadline = Date.now() + Math.max(0, doneTimeoutMs);
        let poll = 0;
        while (Date.now() < settleDeadline) {
          await sleep(Math.max(1, donePollMs));
          poll++;
          if (await goalHeld()) {
            done = true;
            flagSuspectedAsync();
            stop("dom_goal_signal", "dom goal signal", stepNo);
            if (verbose) console.log(`  step ${stepNo}: -> done (dom goal signal, settled after ${poll * Math.max(1, donePollMs)} ms)`);
            break;
          }
        }
      }
      // Popup 可能在 action 之后几十/几百 ms 才 commit；done 轮询结束后再扫一次 context，
      if (hostGate && hostGate.length) {
        // 同一口径：错误页不是 popup 越界（原文优先，按既有 config_error 收口）。
        const settledNav = await contextNavError(pg);
        if (settledNav !== null) {
          done = false;
          stop("config_error", `${navErrorStopReason(settledNav)} on step ${stepNo}`, stepNo);
          if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
          return { control: "break", done, manualDone };
        }
        const settledPopup = deniedContextUrl(pg, hostGate);
        if (settledPopup !== null) {
          done = false;
          stop("popup_not_allowed",
            `action opened ${settledPopup} outside the declared hosts envelope (${hostGate.join(", ")}) on step ${stepNo}`, stepNo);
          if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
          return { control: "break", done, manualDone };
        }
      }
      if (done) return { control: "break", done, manualDone };
    }
    // `{manual: true}`: no DOM fact can confirm this step, so the human is asked
    if (manualGoal && executed && !inert) {
      const excerpt = JSON.stringify(post).slice(0, 300);
      if (!manualConfirmFn) {
        stop("manual_needs_human",
          "manual step needs a human: no manualConfirmFn configured", stepNo);
        return { control: "break", done, manualDone };
      }
      const attested = await manualConfirmFn(instruction, excerpt);
      trace.push({ step: stepNo, desc, how: attested ? "manual_confirmed" : "manual_declined",
        executed: true, method: "manual", conf: round3(conf), manual: true,
        url: urlOf(pg), state: excerpt,
      });
      if (attested) {
        done = true;
        manualDone = true;
        stop("manual_confirmation", "manual confirmation (human oracle)", stepNo);
        return { control: "break", done, manualDone };
      }
    }
    // DOM signals are the only truth, so the model's noul is consulted ONLY
    if (goalSignalFn === null) {
      const doneP = await isDone(instruction, pg);
      if (doneP >= mw.doneThreshold) {
        done = false;
        stop("noul_unverified",
          `laya claims done (p=${doneP.toFixed(2)}) but no DOM signal to verify`, stepNo);
        return { control: "break", done, manualDone };
      }
    }
    // D3/R-4：同一元素在本 subgoal 内被有效驱动多次而信号始终不成立 = 死目标（按元素签名
    // 计数，ref 位置性会重编号）；有倒计时/轮播的页面永远 inert，噪声不能只靠 max_steps 收尾。
    {
      const repeatKey = JSON.stringify(esig(el));
      const ran = (effectiveRuns[repeatKey] ?? 0) + 1;
      effectiveRuns[repeatKey] = ran;
      if (mw.maxEffectiveRepeats > 0 && ran > mw.maxEffectiveRepeats) {
        // eval3 曝光面（_blank 连点 4 次重复标签 3/3 轮）：URL 没动 + context 里多出了
        // 标签 = 动作八成开进了新标签而引擎还留在原页——当场把 newTab opts 指给作者。
        // 替身拿不到页数（-1）或拿不到 URL 时不提示，绝不误报。
        const nowUrl = urlOf(pg);
        const nowTabs = contextPageCount(pg);
        const newTabHint = nowTabs > stepStartTabs && stepStartTabs >= 0
          && typeof nowUrl === "string" && nowUrl !== "" && nowUrl === stepStartUrl
          ? ` — 动作疑似打开新标签：用 step opts newTab:{urlContains} 自动采用并去重`
          : "";
        stop("no_progress",
          `${el.tag} "${el.label}" was executed ${ran} time(s) in this subgoal and the done-signal never held — the target looks dead (or the signal can never fire); stopping here instead of blaming the step budget (max_steps=${mw.maxSteps}) on step ${stepNo}`
          + newTabHint,
          stepNo);
        if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
        return { control: "break", done, manualDone };
      }
    }
    // Inert action on this element -> forbid it for the rest of the subgoal
    // regardless of method (this is what killed the Sign-in loops).
    // A1 §2.2.5：**done 在动作前已成立**（done_preheld）时，click 快照没变不能判死元素——
    // 动作可能是异步生效，或 done 本来就成立、这次动作只是搭便车。记 suspected_async 警告，
    // 不 forbid、不写 outcome memory inert（否则会把一次有效动作记成死元素，跨运行继续误伤）。
    // 动作后 done 成立的路径在这之前已 break，不会走到这里。
    if (inert) {
      if (how === "clicked" && donePreheld === true) {
        flagSuspectedAsync();
        return { control: "continue", done, manualDone };
      }
      forbid(ref, el, "inert");
      outcomeMemory?.record(outcomeMemory.key(urlOf(pg), instruction), JSON.stringify(esig(el)), "inert");
      return { control: "continue", done, manualDone };
    }
    // It worked: forget any earlier inert mark for this exact element (pages
    outcomeMemory?.record(outcomeMemory.key(urlOf(pg), instruction), JSON.stringify(esig(el)), "effective");
    if (mw.antiRepeat) {
      // Forbid after a *semantic* (laya) pick that missed the signal, or
      if (method === mm || how === "filled") forbid(ref, el, "anti-repeat");
    }
    // A2′：裁决过一次的元素不配第二次机会——声明说"错了白跑"，白跑一次就是它的全部代价。
    // 不挂在 antiRepeat 下（那是循环通用卫生），因为"一次裁决"是 A2′ 的语义本身：
    // 走到这里 = 执行了、非惰性、信号没成立 ⇒ 这一格裁判已给出"不算"，禁掉换下一个候选。
    if (method === `${mm}:adjudicated` && executed) forbid(ref, el, "adjudicated-missed");
    // 动作间最小等待：只在实际执行过动作、且还要继续要下一个动作时付。
    if (executed && mw.actionDelayMs > 0) await sleep(mw.actionDelayMs);
    return { control: "next", done, manualDone };
  }
