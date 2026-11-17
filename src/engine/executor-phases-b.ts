/**
 * 执行器实现模块（从 executor.ts 切分，大文件拆分 X1）：本文件函数都是
 * `BrowserMiddleware` 的实现片段，显式接收 `mw` 实例（唯一执行循环仍在 executor.ts）。
 */
import { decisionDegradedAdvice } from "../model/decision-probe.ts";
import { induceHint } from "../model/hint-memory.ts";
import { sleep } from "../support/sleep.ts";
import { type TraceStep } from "./audit.ts";
import { type DeclaredTargetsResolver } from "./declared-targets.ts";
import { declaredHiddenSuffix, declaredMissSuffix, identityHiddenSuffix } from "./evidence.ts";
import { WIDER_ELEMENTS, WIDER_ELEMENTS_MAX, windowChainMissSuffix, contextPageCount, deniedContextUrl, describeActionError, disallowedHost, lowConfDiscrimination, round3, topTwoMargin, type WindowChainFact } from "./executor-pure.ts";
import { runWindowEscalationRung } from "./window-escalation.ts";
import { type AnyPage, type EscalatorLike, type HintMemoryLike, type OutcomeMemoryLike, type Sig, type StopCode } from "./executor-types.ts";
import { type Elem, type ElemFamily, type ElemPool, WIDE_QUOTAS, ariaInteractiveLines, criteriaView, elemFamily, esig, filterElemsByFamily, lexicalOverlap, urlOf } from "./extraction.ts";
import { HINT_CLOSED_SET_TEXT } from "./grammar-prompt.ts";
import { type HintMatchOptions, affordanceRule, hintCandidates, navRule } from "./rules.ts";
import type { BrowserMiddleware } from "./executor.ts";
import type { ModelPickPhase, PostActionPhase } from "./executor.ts";


  /** 4d 阶段：模型选择（rule → ask → floor → reobserve → escalate → adjudicate → R2b → nominated-family 修复）；
   * 早停/日志已在此记账；宽扫替换本步视图（elems 随返回值交回）。动作执行仍在 run()。 */
export async function runModelPick(mw: BrowserMiddleware, a: {
    pg: AnyPage; stepNo: number; instruction: string; verbose: boolean; elems: ElemPool; ruleRef: string | null;
    curHint: string | null; commandMode: boolean; forbidden: Record<string, Sig>; noted: Record<string, string> | null;
    targets: DeclaredTargetsResolver;
    trace: TraceStep[]; adjudicate: boolean; reobserve: boolean; escalateFn: EscalatorLike | null;
    expectedFamily: ElemFamily | null; confFloor: number; candidatePriority: "bucketed" | "main-first";
    tieredHint: boolean; rulesOnly: boolean; decisionDegradedReasonClass: NonNullable<BrowserMiddleware["decisionDegraded"]>["reason_class"] | null; rejectedAskConfs: number[];
    warnings: string[];
    reobserved: boolean; escalated: boolean; escalatedPick: string | null;
    /** 窗口递增链事实（run() 持有的本步数组；本阶段就地追加，trace 行证据共享同一份）。 */
    windowChainFacts: WindowChainFact[];
    stepTimeoutLeft: () => number; stop: (code: StopCode, detail?: string, at?: number) => void; stopReason: () => string;
    pickElement: (goal: string, page: AnyPage, pool: ElemPool, blocked: Set<string>, notes: Record<string, string> | null) => Promise<[string | null, number, Record<string, number>]>;
    orderedPool: (pool?: ElemPool) => ElemPool; settleBeforeExtract: (page: AnyPage) => Promise<unknown>;
    pruneForbids: (pool: ElemPool) => void; hintOpts: () => HintMatchOptions; frameHosts: string[] | null;
    stateTextFn: (page: AnyPage, instr: string) => Promise<string>;
    rowAnchorNote: (targets: readonly (string | null | undefined)[]) => string;
    declaredTargets: () => readonly (string | null | undefined)[];
    goalHeld: () => Promise<boolean>; goalSignalFn: ((page: AnyPage) => boolean | Promise<boolean>) | null;
    isTyping: (el: Elem) => boolean; modelLabel: () => string; degradedReasonSuffix: () => string;
    choiceLimitReason: () => string | null; clearChoiceLimitReason: () => void;
  }): Promise<ModelPickPhase> {
    const { pg, stepNo, instruction, verbose, elems: elemsInit, ruleRef, curHint, commandMode, forbidden, noted, trace, targets,
      adjudicate, reobserve, escalateFn, expectedFamily, confFloor, candidatePriority, tieredHint, rulesOnly,
      decisionDegradedReasonClass, rejectedAskConfs, warnings, stepTimeoutLeft, stop, stopReason, pickElement, orderedPool,
      settleBeforeExtract, pruneForbids, hintOpts, frameHosts, stateTextFn, rowAnchorNote, declaredTargets,
      goalHeld, goalSignalFn, isTyping, modelLabel, degradedReasonSuffix, choiceLimitReason, clearChoiceLimitReason,
      reobserved: reobservedInit, escalated: escalatedInit, escalatedPick: escalatedPickInit, windowChainFacts } = a;
    let elems = elemsInit;
    let ref: string | null = null; let conf = 0;
    // 方法标签跟着决策源走：provider 自报其名（decision-service / 基线名…）；
    const mm = modelLabel();
    let method = mm;
    // 粗分类（聚合用）：rule=规则/闭集解析，model=provider 决策票，escalate=老师点名。
    let decisionKind: "rule" | "model" | "escalate" = "model";
    let layaMargin: number | null = null;      // C3-R top-two margin (diagnostic)
    let tierAsk: { n: number; tier: number } | null = null;   // P1 diagnostic: the narrowed question
    let reobserved = reobservedInit; let escalated = escalatedInit; let escalatedPick = escalatedPickInit;
    let nominatedRepair = false;
    if (ruleRef && !(ruleRef in forbidden)) {
      ref = ruleRef;
      conf = 1.0;
      method = "rule:match";
      decisionKind = "rule";
    } else {
      // the rule's target is forbidden (inert or tried) -> fall through to
      const forbiddenSet = new Set(Object.keys(forbidden));
      // P1 TIERED HINT (opt-in, `tieredHint`; OFF keeps today's behaviour byte-identical):
      // an ambiguous-in-tier plan hint used to collapse to null and become
      // "pick 1 of the whole 40" — now it becomes "pick 1 of THESE candidates".
      // The tier is a SMALLER QUESTION, never a decider: below floor or no answer,
      // the step re-asks the full pool and every later rung stays as today.
      let askPool = orderedPool();
      if (tieredHint && curHint !== null && ruleRef === null) {
        const cand = hintCandidates(curHint, elems, hintOpts());
        if (cand !== null && cand.decided === null && cand.refs.length > 1) {
          const subset: ElemPool = {};
          for (const r of cand.refs) {
            if (elems[r] !== undefined && !forbiddenSet.has(r)) subset[r] = elems[r]!;
          }
          if (Object.keys(subset).length > 1) {
            askPool = subset;
            tierAsk = { n: Object.keys(subset).length, tier: cand.tier };
          }
        }
      }
      let [picked, pconf, pprobs] = await pickElement(instruction, pg, askPool, forbiddenSet, noted);
      if (askPool !== elems && tierAsk !== null && (picked === null || pconf < confFloor)) {
        // narrowed ask abstained: today's full-pool ask still gets its turn
        if (verbose) console.log(`  step ${stepNo}: tiered hint (${tierAsk!.n} candidates) abstained -> full pool`);
        tierAsk = null;
        [picked, pconf, pprobs] = await pickElement(instruction, pg, elems, forbiddenSet, noted);
      }
      ref = picked;
      conf = pconf;
      method = mm;
      layaMargin = topTwoMargin(pprobs);
    }
    if (ref === null) {
      // A2：候选窗口超过决策服务上限——结构化停因，绝不把 200+ 选项硬塞过去。
      if (choiceLimitReason() !== null) {
        const why = choiceLimitReason()!;
        clearChoiceLimitReason();
        stop("decision_service_choice_limit", why, stepNo);
        if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
      return { stopped: true, ref, conf, method, decisionKind, layaMargin, tierAsk, nominatedRepair, escalatedPick, elems, label: mm };
      }
      // In rules-only mode a null ref usually means "no runtime to ask", which is not
      if (rulesOnly) {
        // task-14（D1）：被降级吞掉的步（本需要模型选点）在 step warning 记 decision_degraded
        // ——停因保留（诚实机制不变），留痕说明这是配置面问题而非模型缺席，并给分类建议。
        if (decisionDegradedReasonClass !== null) {
          warnings.push(`decision_degraded: 决策面已降级（${decisionDegradedReasonClass}）——`
            + `本步需要模型选点，规则面无法替代；${decisionDegradedAdvice(
              decisionDegradedReasonClass === "midrun_death" ? "unknown" : decisionDegradedReasonClass)}`);
        }
        // 诚实停因：这一步**什么动作都没声明**（无 target_hint、
        // 无命令空间）时，"缺模型"是个谎言——真正的问题要么是"信号已成立但这步没声明
        // 零动作命令，引擎不肯替作者宣布完成"，要么是"信号根本不成立"。当场评估一次
        // 信号（只在走向停止时付这一次），把实况和出路说出口，而不是把用户引去装模型。
        if (curHint === null && !commandMode) {
          const held = goalSignalFn ? (await goalHeld()) : false;
          stop("no_model_runtime",
            `step ${stepNo} declares no action (no target_hint, no commands) and rules-only has no model `
            + `to pick one — its done-signal ${held ? "ALREADY holds on this page: declare a zero-action "
                + 'command (commands: [{"op":"skip"}]) on this subgoal, or name a target_hint, so the '
                + "signal can be honored"
              : "does not hold on this page either: name a target_hint, declare commands, "
                + "or provide a decision model"}`
            + degradedReasonSuffix(), stepNo);
          if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
      return { stopped: true, ref, conf, method, decisionKind, layaMargin, tierAsk, nominatedRepair, escalatedPick, elems, label: mm };
        }
        stop("no_model_runtime",
          `no model runtime: this step needs a model pick (rules-only mode) on step ${stepNo}`
          // 规划引导：计划点了名、规则没解出来、模型又不在/弃权——当场送闭集。
          + (curHint !== null && ruleRef === null
              ? ` — target_hint "${curHint}" 未被规则命中，${HINT_CLOSED_SET_TEXT}`
              : "")
          // A3：provider 是抛错降级（而非本来就没装）时，把 HTTP 事实带上——排查不必再猜。
          + degradedReasonSuffix() + identityHiddenSuffix(targets.identityHidden)
          // F82/F83 批 2 遗留收编（E 项）：规划面停因的行锚证据（无行锚声明 = 空串）。
          + rowAnchorNote(declaredTargets()), stepNo);
      } else {
        stop("action_space_exhausted",
          `action space exhausted on step ${stepNo}`
          + (curHint !== null && ruleRef === null
              ? ` — target_hint "${curHint}" 未被规则命中，${HINT_CLOSED_SET_TEXT}`
              : "") + identityHiddenSuffix(targets.identityHidden)
          // F82/F83 批 2 遗留收编（E 项）：规划面停因的行锚证据（无行锚声明 = 空串）。
          + rowAnchorNote(declaredTargets()), stepNo);
      }
      if (verbose && rulesOnly) console.log(`  step ${stepNo}: ${stopReason()}`);
      return { stopped: true, ref, conf, method, decisionKind, layaMargin, tierAsk, nominatedRepair, escalatedPick, elems, label: mm };
    }
    // PORT FIX: a model answer can name a ref that is no longer in THIS
    // step's pool (the screen changed between the scan and the pick, or the
    // answer is nonsense). The Python reference reads `elems[ref]` unguarded
    // and dies with a KeyError; stop the subgoal with a reason instead.
    if (elems[ref] === undefined) {
      // 这条是最难懂的一句：`picked ref 'undefined' is not in the element
      const poolSize = Object.keys(elems).length;
      if (curHint) {
        stop("hint_matched_nothing",
          `target_hint ${JSON.stringify(curHint)} matched nothing in a pool of ${poolSize} element(s) on step ${stepNo}`
          // F73：DRF 计数事实（实跑且零命中才非空；缺省 declared 关 = 恒空串，逐字节不变）。
          + declaredHiddenSuffix(targets.getDeclaredHidden()) + declaredMissSuffix(targets.declaredMiss)
          // F82/F83 批 2 遗留收编（E 项）：规划面停因的行锚证据（无行锚声明 = 空串）。
          + rowAnchorNote(declaredTargets()), stepNo);
      } else {
        stop("step_names_no_target",
          `step ${stepNo} names no target: no target_hint(s), no rule matched any of the ${poolSize} element(s), and the picker returned no usable element（给这一步加 target_hint，或在页面上点名一个稳定句柄）`, stepNo);
      }
      if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
      return { stopped: true, ref, conf, method, decisionKind, layaMargin, tierAsk, nominatedRepair, escalatedPick, elems, label: mm };
    }
    // The confidence floor decays as failed elements are forbidden: a
    // shrunken action space legitimately lowers the margin.
    const floor = Math.max(0.10, confFloor - 0.05 * Object.keys(forbidden).length);
    if (conf < floor) {
      const pending = elems[ref]!;
      // U8：本次 ask 的 conf（后续恢复路径会改写 conf 变量；记账用分支入口的值）。
      const askConf = conf;
      /** U8：本分支内被闸门丢掉的 ask conf（暂存；提交点见各出口——adjudicate 复用意见时撤回）。 */
      const gateRejected: number[] = [];
      // A frozen plan may legitimately re-drive an element within one
      const wantDesc = (isTyping(pending) ? "type text into" : "click")
        + ` ${pending.tag} "${pending.label}"`;
      const priorHit = trace.some((t) => t.desc === wantDesc && t.executed);
      if (priorHit && conf >= 0.10) {
        /* re-drive: proceed despite floor */
      } else if (rulesOnly) {
        // No runtime installed and no rule/hint resolved this step: say exactly that.
        stop("no_model_runtime",
          `no model runtime: this step needs a model pick (rules-only mode) on step ${stepNo}`
          // 同 low_confidence：hint 被点名却没解出来时，当场送闭集（规划引导）。
          + (curHint !== null && ruleRef === null
              ? ` — target_hint "${curHint}" 未被规则命中，${HINT_CLOSED_SET_TEXT}`
              : "")
          // A3：同上——降级原因（HTTP 状态码 + 服务错误关键句）随停因透出。
          + degradedReasonSuffix(), stepNo);
        if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
      return { stopped: true, ref, conf, method, decisionKind, layaMargin, tierAsk, nominatedRepair, escalatedPick, elems, label: mm };
      } else if (!(adjudicate && ref !== null)
        && Object.keys(forbidden).length >= Math.max(0, Object.keys(elems).length - 1)) {
        // A2′：`adjudicate` 开着且还有活着的候选时，不能用"动作空间耗尽"抢在裁决前面——
        // 那最后一个低置信候选正是该被信号裁决的那一个（"错了白跑"是作者声明过的）。
        // 没开裁决时这个提前停原样保留（逐字节今天）。
        gateRejected.push(askConf);   // U8：意见在 floor 处被丢，动作空间也已耗尽——记一笔
        stop("action_space_exhausted",
          `action space exhausted (${Object.keys(forbidden).length} forbidden) on step ${stepNo}`, stepNo);
      return { stopped: true, ref, conf, method, decisionKind, layaMargin, tierAsk, nominatedRepair, escalatedPick, elems, label: mm };
      } else {
        // U8：走到恢复分支 = 原 ask 的意见已被闸门丢弃（reobserve/escalate 换别的意见、
        // low_confidence 停；唯一例外是 adjudicate 复用原意见——下面 pop 撤回）。
        gateRejected.push(askConf);
        // OBSERVATION-BOTTLENECK RECOVERY (browser-use's "the button is there, we
        let recovered = false;
        // A2′：加宽重看即便没过闸门，它看到的候选也可能比窄池那一个更好——
        // 记下来，若这一步声明了裁决资格，就用**最后一次观察到的**低置信选择（elems 已是宽视图）。
        let widePick: { ref: string; conf: number } | null = null;
        if (reobserve && !reobserved && ref !== null && stepTimeoutLeft() > 0) {
          // F3：步级 timeoutMs 过期后不再起新的宽扫重问（每轮受整步挂钟帽约束）。
          reobserved = true;
          await settleBeforeExtract(pg);
          const wide = await mw.candidates!.extract({ page: pg, jsProbe: true, maxElements: WIDER_ELEMENTS, widgets: true, quotas: WIDE_QUOTAS, candidatePriority, hosts: frameHosts });
          if (Object.keys(wide).length > Object.keys(elems).length) {
            // refs are positional: re-prune forbids whose ref now names a
            pruneForbids(wide);
            // 宽视图同样只做**排序先验**（不丢元素：加宽看到的东西不该被族过滤掉）。
            const wideAsk = orderedPool(wide);
            const [ref2, conf2] = await pickElement(instruction, pg, wideAsk, new Set(Object.keys(forbidden)), noted);
            // The wider view BECOMES the step's view even when the local model
            elems = wide;
            if (ref2 !== null && conf2 >= floor) {
              ref = ref2;
              conf = conf2;
              method = `${mm}:reobserve`;
              recovered = true;
              windowChainFacts.push({ window: WIDER_ELEMENTS, miss: 1, resolved: true, ref: ref2 });
              if (verbose) console.log(`  step ${stepNo}: re-observed wider (${Object.keys(wide).length} elements) -> ${ref} conf=${conf2.toFixed(2)}`);
            } else {
              if (ref2 !== null) {
                widePick = { ref: ref2, conf: conf2 };
                gateRejected.push(conf2);   // U8：宽看重问的意见也未过 floor（adjudicate 复用时撤回）
              }
              windowChainFacts.push({ window: WIDER_ELEMENTS, miss: 1, resolved: false });
              if (verbose) console.log(`  step ${stepNo}: re-observed wider (${Object.keys(wide).length} elements) -> still below floor`);
              // 窗口递增链第二档：120 档重问仍未过 floor → 扩到硬顶再重问一次（命中即停）；
              // widePick/"最后一次观察到的意见"语义随档位滚动（240 档成为最后一次观察）。
              const rung = await runWindowEscalationRung(mw, { pg, stepNo, instruction, verbose, elems, floor, forbidden, noted, candidatePriority, frameHosts, stepTimeoutLeft, pickElement, orderedPool, pruneForbids, windowChainFacts, logTag: "re-observed wider",
                hitNote: (poolSize, ref3, conf3) => `(${poolSize} elements) -> ${ref3} conf=${conf3.toFixed(2)}`, missNote: () => "still below floor" });
              if (rung.grew) {
                elems = rung.pool;
                if (rung.adopted && rung.ref !== null) { ref = rung.ref; conf = rung.conf; method = `${mm}:reobserve`; recovered = true; }
                else if (rung.ref !== null) { widePick = { ref: rung.ref, conf: rung.conf }; gateRejected.push(rung.conf); }
              }
            }
          }
        }
        // ESCALATION (C3-R's deliberative path): a stronger reasoner may still
        // name one of the elements the harness showed. It is a picker, not a
        // planner — an answer that is not a ref from THIS view is rejected, so
        // nothing it says can invent an element, a value or an action.
        // task-14（D1）：决策面已降级（起跑探判死/中途死亡）→ 升级链规则兜底，
        // 不再咨询死服务（死服务不重试超过 1 次：probe 1 次 / pickInner 捕获 1 次）。
        if (!recovered && escalateFn && !escalated && decisionDegradedReasonClass === null
            && stepTimeoutLeft() > 0) {
          // F3：步级 timeoutMs 过期后不再发起新的升级点名。
          escalated = true;
          const crit = criteriaView(orderedPool(), new Set(Object.keys(forbidden)), await ariaInteractiveLines(pg));
          const state = { url: urlOf(pg), title: await pg.title(), main_text: await stateTextFn(pg, instruction) };
          try {
            const pick = await escalateFn({ instruction, criteria: crit, why: `low confidence ${conf.toFixed(2)} < floor ${floor.toFixed(2)}`, ...state });
            if (pick && crit[pick] !== undefined && !(pick in forbidden)) {
              ref = pick;
              method = "escalate";
              decisionKind = "escalate";
              escalatedPick = pick;
              recovered = true;
              if (verbose) console.log(`  step ${stepNo}: escalated -> ${pick}`);
            } else if (verbose) console.log(`  step ${stepNo}: escalation rejected (${pick === null ? "no answer" : `'${pick}' is not a shown candidate`})`);
          } catch (e) {
            if (verbose) console.log(`  step ${stepNo}: escalation failed (${describeActionError(e)})`);
          }
        }
        if (!recovered) {
          // A2′：这一步声明了"错了白跑"（`adjudicate`，加载期已钉 `effect.irreversible:false`
          // + 可判定信号），于是"低置信"不再是阻塞理由——把模型此刻的选择**执行**，让这一步
          // 自己的 DOM 信号事后裁决（信号成立 = done；不成立 = 下面循环尾部禁掉这个元素，
          // 一次白跑就是它的全部代价）。这是老师的"提名被执行、信号定生死"同一认识论，
          // 只是爆炸半径由作者声明限定。没声明 ⇒ 逐字节今天（低置信即阻塞）。
          const bestPick = widePick ?? (ref !== null ? { ref, conf } : null);
          if (adjudicate && bestPick !== null && !rulesOnly) {
            // U8：被裁决执行的那份意见（原 ask 或宽看重问）不算被拒——撤回最后一笔暂存。
            gateRejected.pop();
            ref = bestPick.ref;
            conf = bestPick.conf;
            method = `${mm}:adjudicated`;
            if (verbose) console.log(`  step ${stepNo}: adjudicating below gate (${ref} conf=${conf.toFixed(2)} < floor ${floor.toFixed(2)}) — the step's own signal judges`);
          } else {
            // U8：提交点①——low_confidence 停，暂存的意见确被丢弃。
            rejectedAskConfs.push(...gateRejected);
            stop("low_confidence",
              `low confidence ${conf.toFixed(2)} < floor ${floor.toFixed(2)} on step ${stepNo}`
              // 规划引导：计划点了名、规则却没解出来——当场把闭集送给作者，省一次读源码确诊
              + (curHint !== null && ruleRef === null
                  ? ` — target_hint "${curHint}" 未被规则命中，${HINT_CLOSED_SET_TEXT}`
                  : "")
              // eval3 曝光面：observe 是会话内的免费侦察通道（R02 自发使用并获赞），
              + `；用 ctx.observe() 在会话内看准入面与 why_not_admitted`
              // A2 判别②：分数不过闸门 ≠ 目标不存在——用内存里的池把两种问题分开说
              // （候选在而置信度低 = 闸门问题；池里没有词面相关候选 = 目标可能不在本页面）。
              + lowConfDiscrimination(instruction, elems, ref)
              // F82/F83 批 2 遗留收编（E 项）：规划面停因的行锚证据（无行锚声明 = 空串，
              // reason 逐字节不变）。
              + rowAnchorNote(declaredTargets())
              // 窗口递增链跑满且全档未命中时的事实尾缀（additive；链没跑/命中过 = 空串）。
              + windowChainMissSuffix(windowChainFacts), stepNo);
      return { stopped: true, ref, conf, method, decisionKind, layaMargin, tierAsk, nominatedRepair, escalatedPick, elems, label: mm };
          }
        }
        // U8：提交点②——reobserve/escalate 挽回了这一步，但被丢弃的意见照记（它们
        // 确实在 floor 处被拒过；挽回意见本身走 trace 进既有 `conf` 聚合）。
        rejectedAskConfs.push(...gateRejected);
      }
    }
    // R2b：词面零重叠守卫（宽扫的第二个触发器）。模型提名（非规则命中、非满置信）
    // 的 label 与指令零词面重叠（CJK 二元组/ASCII 词）时，是"自信地错"的典型形态——
    // 低置信恢复等不到（模型不觉得自己错，m.ctrip 实证：指令"出发地" vs 提名
    // "组合交通出行"，conf 0.71 过闸点走页脚）。执行前强制一次宽扫重问（宽池含 R2/
    // R2c 启发式候选），重问结果照常过闸；无更优则保留原提名。规则命中与 conf=1.00
    // 的模型提名不触发（books/quotes/hn 全量 rule:match conf=1.00 实证零回归面）。
    if (ref !== null && !reobserved && method === mm && conf < 0.9
        && stepTimeoutLeft() > 0
        && !lexicalOverlap(instruction, String(elems[ref]?.label ?? ""))) {
      reobserved = true;
      await settleBeforeExtract(pg);
      const wideR2b = await mw.candidates!.extract({ page: pg, jsProbe: true, maxElements: WIDER_ELEMENTS, widgets: true, quotas: WIDE_QUOTAS, candidatePriority, hosts: frameHosts });
      if (Object.keys(wideR2b).length > Object.keys(elems).length) {
        pruneForbids(wideR2b);
        const wideAskR2b = orderedPool(wideR2b);
        const [ref2, conf2] = await pickElement(instruction, pg, wideAskR2b, new Set(Object.keys(forbidden)), noted);
        elems = wideR2b;
        if (ref2 !== null && conf2 >= floor) {
          ref = ref2;
          conf = conf2;
          method = `${mm}:reobserve`;
          windowChainFacts.push({ window: WIDER_ELEMENTS, miss: 1, resolved: true, ref: ref2 });
          if (verbose) console.log(`  step ${stepNo}: R2b relevance widen -> ${ref} conf=${conf2.toFixed(2)}`);
        } else {
          windowChainFacts.push({ window: WIDER_ELEMENTS, miss: 1, resolved: false });
          if (verbose) {
            console.log(`  step ${stepNo}: R2b relevance widen -> keep original `
              + `(${ref2 === null ? "no pick" : `conf ${conf2.toFixed(2)}`} below floor)`);
          }
          // 窗口递增链第二档：仍未过 floor → 扩到硬顶再重问一次；仍未过 = 保留原提名（R2b
          // 是质量守卫，不是停因路径）。超时/零增长在 helper 内零动作返回。
          const rungR2b = await runWindowEscalationRung(mw, { pg, stepNo, instruction, verbose, elems, floor, forbidden, noted, candidatePriority, frameHosts, stepTimeoutLeft, pickElement, orderedPool, pruneForbids, windowChainFacts, logTag: "R2b relevance widen",
            hitNote: (_n, ref3, conf3) => `-> ${ref3} conf=${conf3.toFixed(2)}`,
            missNote: (p) => `keep original (${p.ref === null ? "no pick" : `conf ${p.conf.toFixed(2)}`} below floor)` });
          if (rungR2b.grew) {
            elems = rungR2b.pool;
            if (rungR2b.adopted && rungR2b.ref !== null) { ref = rungR2b.ref; conf = rungR2b.conf; method = `${mm}:reobserve`; }
          }
        }
      }
    }
    // S2 ③ **有界修复**（只在走向停止时付一次成本）：第一轮用全池（软先验）解析出的动作族
    // 与提名不符 / 没解出目标时，才用"该族"再做一次解析；仍不成立 ⇒ 结构化停，
    // 绝不执行一个与提名矛盾的动作。
    // 为什么不是第一道过滤：结构族 ≠ 语义动作（div[role=combobox] = click 但语义 select、
    // contenteditable = click 但语义 fill、input[type=range] = fill 但语义设值），硬过滤会
    // 把真目标或关键上下文元素一并排掉（项目方推敲结论）。
    if (expectedFamily !== null) {
      const pickedFamily = ref !== null ? elemFamily(elems[ref]!) : null;
      if (ref === null || pickedFamily !== expectedFamily) {
        const narrow = filterElemsByFamily(elems, expectedFamily);
        if (Object.keys(narrow).length === 0) {
          stop("nominated_family_empty",
            `nominated instruction "${expectedFamily}" but this page has no ${expectedFamily} candidates on step ${stepNo}`, stepNo);
          if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
      return { stopped: true, ref, conf, method, decisionKind, layaMargin, tierAsk, nominatedRepair, escalatedPick, elems, label: mm };
        }
        const repairFloor = Math.max(0.10, confFloor - 0.05 * Object.keys(forbidden).length);
        const forbiddenSet = new Set(Object.keys(forbidden));
        const repairRule = navRule(instruction, narrow) ?? affordanceRule(instruction, narrow, null);
        let repaired: { ref: string; conf: number; method: string } | null = null;
        if (repairRule !== null && !(repairRule in forbidden)) {
          repaired = { ref: repairRule, conf: 1, method: "rule:match" };
        }
        if (repaired === null) {
          const [rp, rconf] = await pickElement(instruction, pg, narrow, forbiddenSet, noted);
          if (rp !== null && rconf >= repairFloor) repaired = { ref: rp, conf: rconf, method: mm };
        }
        if (repaired === null) {
          stop("nominated_family_mismatch",
            `nominated instruction "${expectedFamily}", but the page resolved ${pickedFamily ?? "nothing"} and no ${expectedFamily} candidate passed the floor on step ${stepNo}`, stepNo);
          if (verbose) console.log(`  step ${stepNo}: ${stopReason()}`);
      return { stopped: true, ref, conf, method, decisionKind, layaMargin, tierAsk, nominatedRepair, escalatedPick, elems, label: mm };
        }
        if (verbose) console.log(`  step ${stepNo}: nominated-family repair ${expectedFamily} -> ${repaired.ref} (${repaired.method})`);
        ref = repaired.ref;
        conf = repaired.conf;
        method = repaired.method;
        nominatedRepair = true;
      }
    }
    // S4：stale 重解析重试会换成本步重新解析出的元素，故 el 可重新绑定（ref 本就是 let）。
    return { stopped: false, ref, conf, method, decisionKind, layaMargin, tierAsk, nominatedRepair, escalatedPick, elems, label: mm };
  }

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

