/**
 * `amber pilot` 运行时——**模型驾驶走查面**（PW2；方案见 docs/PILOTED_WALKTHROUGH_PLAN.md）。
 *
 * 定位（与 session 同一份纪律的第三种面）：
 *   - session 是「人一行一行试探」（authoring 面，决策模型零参与）；
 *   - run   是「冻结计划 + 运行时消歧」（执行面，模型只票元素）；
 *   - pilot 是「决策模型逐步投票驾驶 + Agent 兜底接管」——走查阶段的模型主控面。
 *
 * 同源纪律（红线①：模型只投票不生成）：
 *   - 驾驶问句 = `mw.pickProposal`（池内闭集 ref 投票；绝不生成自由文本动作）；
 *   - 规则档先行：`affordanceRule`/`navRule` 命中即确定性执行（零模型），与 run 同一序；
 *   - 低置信回流与 run 同序（红线②「不提前弹人」）：gated 意见先付一次宽扫重问
 *     （WIDER_ELEMENTS/WIDE_QUOTAS，宽池真变大才重问），仍不过闸才 low_confidence 交接；
 *     弃权（choiceRef=null）与 run 的 abstain 判定同源，直接停、不走宽扫；
 *   - 执行 = `mw.actOnce`（与 session.act / run 命令步同一条解析与执行链）；
 *   - 完成只认信号：`checkSignal`（--final-signal 每轮判 + finish 指令声明后验证，
 *     成立才记 final_signal_held）；产物恒带 `pilot:true`——走查证据，不冒充 run 结论；
 *   - 值不猜：fill/select 缺值 = `needs_value` 停 → 只接受 Agent resume 显式给值。
 *
 * 兜底协议（红线②：触发确定性）：停因闭集见 pilot-contract.ts；停止时投影
 * `PilotHandoff`（intervention 合同形状），stdin JSONL 只认 resume/redirect/finish/abort。
 * 单行失败纪律与 session 同源：坏 JSON/未知指令/被拒指令都只回执一条错误、继续等
 * 下一条，不杀会话；只有 finish(验证成立)/abort/EOF 关闭会话。
 */
import fs from "node:fs";
import path from "node:path";
import { buildMiddleware } from "./middleware-factory.ts";
import { createCtx, type Ctx } from "./ctx.ts";
import { amberflowHome, ensureDir } from "../support/amberflow-home.ts";
import { NAVIGATION_GOTO_TIMEOUT_MS } from "../support/tuning.ts";
import { parseRunDefaults } from "../support/run-defaults.ts";
import { inputsSha256, newTrace, sha256, writeTrace, type AppTrace } from "./trace.ts";
import { MockAuditor } from "../engine/audit.ts";
import {
  BrowserMiddleware, browserSession, disallowedHost,
  type AnyPage, type BrowserSession,
} from "../engine/executor.ts";
import { elemFamily, esig, urlOf } from "../engine/extraction.ts";
import type { Elem, ElemPool } from "../engine/elem-model.ts";
import { checkSignal, type SignalSpec } from "../engine/signals.ts";
import { affordanceRule, DESTRUCTIVE_PATTERNS, hintCandidates, hintMatch, navRule } from "../engine/rules.ts";
import { foldNestedDuplicates, pickRejection } from "../engine/executor-actionability.ts";
import { DEFAULT_SETTLE, settle } from "../engine/settle.ts";
import { resolveLocalCheckpoint } from "../model/checkpoint.ts";
import {
  activeProviderInfo, applySpecToRuntime, resolveProviderSpec, type AppliedSpec,
} from "../model/decision-provider.ts";
import { errMsg, isDeadPageError, isObj } from "./session-runtime-contract.ts";
import { modelVote } from "./pilot-vote.ts";
import { PilotAskAdapter } from "./pilot-ask-adapter.ts";
import { PilotLedger } from "./pilot-ledger.ts";
import {
  bindValueFor, valueKeyOf, valueNeedOf,
  type ValueNeed,
} from "./pilot-value-need.ts";
import { clipText } from "../support/text.ts";
import {
  emitStepRequest as emitStepRequestEvidence, finalSignalFact, frameExclusionsOf, handoffEvidence,
  handoffWhyEvidence, weakPicksFrom,
} from "./pilot-evidence.ts";
import { handlePilotLine, type PilotCommandTarget } from "./pilot-commands.ts";
import { PILOT_AWAIT_PICK, PILOT_DEFAULT_MAX_STEPS, PILOT_INERT_LIMIT, drivingGoalText, pilotExitCode, unblockHintsFor, type PilotHandoff, type PilotOptions, type PilotRecordLine, type PilotStopCode } from "./pilot-contract.ts";

/** 驾驶日志/交接的输出面（CLI 注入 stdout JSONL；测试可替换）。 */
export interface PilotSink {
  respond(obj: Record<string, unknown>): void;
}

interface DrivingStep {
  op: "click" | "check" | "fill" | "select";
  target: string;
  ref: string | null;
  how: string | null;
  ok: boolean;
  changed: boolean;
  /** 票面事实（低置信 `weak_picks` 的取数口；不参与驾驶问句/裁决）。 */
  step: number; picked_by?: "rule" | "model"; conf?: number;
}

const MAX_LABEL = 40;
/** 动作目标上限：与 hint 匹配口径一致（`full_label` ≤200）。`label` 只是模型视图的 40 字前缀，
 *  拿它当动作目标会在长标签上精确匹配落空——跨 frame/AX 长标签元素尤其常见。 */
const MAX_HINT = 200;

export class PilotRuntime implements PilotCommandTarget {
  readonly runId: string;
  readonly outDir: string;
  readonly opts: PilotOptions;
  readonly sink: PilotSink;
  readonly hosts: string[] | null;
  private readonly maxSteps: number;
  /** floor 优先级与 run 同链（app-runner-policy conf_floor）：CLI > provider 自报 > 缺省。 */
  private confFloor: number;
  readonly slots: Record<string, string>;

  private session: BrowserSession | null = null;
  private mwHolder: BrowserMiddleware | null = null;
  private ctxHolder: Ctx | null = null;
  private traceRef: AppTrace | null = null;
  private recordStream: fs.WriteStream | null = null;
  private recordPath: string | null = null;
  /** 记录流写失败（ENOSPC/EIO）后永久停用：不再写、不再重建（重建只会反复失败）。 */
  private recordFailed = false;
  resumeHint: string | null = null;
  private lastError: string | null = null;
  /** 驾驶者：model = 决策模型投票（缺省）；agent = 每步等 Agent resume{hint} 点名（零模型票）。 */
  readonly driverMode: "model" | "agent";
  /** 本地 laya checkpoint 名（配置 > 缺省 english；在线 provider 档不消费它）。 */
  private readonly checkpointId: string;
  /** 发起方声明的任务页 URL 子串（null = 不判；见 PilotOptions.expectUrl）。 */
  private readonly expectUrl: string | null;
  /** 附着模式（内部 seam）：驾驶宿主已打开的页面，不重新导航。started 与终态摘要都带 attached。 */
  private readonly attached: boolean;
  /** 最近一轮被 hosts 信封排除的子 frame（交接证据与解锁建议用；每轮重算）。 */
  private excludedFrames: Array<{ origin: string; index: number }> = [];
  /** 决策源装配结果（结束摘要的 asks/cache 取数口；装配失败 = null，摘要走本面计数兜底）。 */
  private applied: AppliedSpec | null = null;
  /** 最近一次驾驶轮用的池（交接时落池快照；改道/换页即失效置 null）。 */
  lastPool: ElemPool | null = null;
  /** 最近一次驾驶选中的 ref（resume.skip 禁选的对象）。 */
  lastPickedRef: string | null = null;
  /** 未决值需求（needs_value 的选中目标；resume 字符串值的确定性绑定键 + 键漂移回放身份）。 */
  valueNeed: ValueNeed | null = null;
  /** 已消费值的目标：同控件下轮换键时记录值仍可回放（换页/改道即清）。 */
  private lastValueNeed: ValueNeed | null = null;
  /** resume 字符串值：hint 命中时注入**命中目标**的值袋键（值跟着 hint 目标走）。 */
  pendingValue: string | null = null;
  /** 上一次 resume 的 hint 落空（下次交接 evidence 可见；落交接后清空，不粘）。 */
  private missedHint: string | null = null;
  aborted = false;

  stepCount = 0;
  inertRun = 0;
  /** 本面口径的模型咨询数兜底（applied.asks 在场时以 provider 计数为准）。 */
  private modelAsks = 0;
  private rulePicks = 0;
  private modelPicks = 0;
  private handoffCount = 0;
  fallbackCount = 0;
  private readonly history: DrivingStep[] = [];
  /** 守卫账本（单源，见 pilot-ledger）：禁选/守停/证据都从它派生。 */
  readonly ledger = new PilotLedger();
  private readonly askAdapter = new PilotAskAdapter(() => this.mw(), this.ledger, () => this.hosts); // 模型询问单点（pilot-ask-adapter；改道换 leg）
  /** 本轮 ref 键禁选视图（每轮抽池后由账本按新 esig 重算；模型票/证据消费）。 */
  readonly forbidden = new Set<string>();
  handoffOpen: PilotHandoff | null = null;
  finished = false;
  stopCode: PilotStopCode | null = null;

  constructor(opts: PilotOptions, sink: PilotSink, runId?: string) {
    this.opts = opts;
    this.sink = sink;
    this.runId = runId ?? `${Date.now().toString(36)}-${process.pid}`;
    let hosts: string[] | null = null;
    try {
      const h = new URL(opts.url).hostname;
      hosts = [h];
    } catch { /* 非法 URL 在 start() 里结构化报错，不在这里猜 */ }
    if (opts.hosts && opts.hosts.length > 0) hosts = [...opts.hosts];
    this.hosts = hosts;
    this.maxSteps = Math.max(1, Math.min(200, opts.maxSteps ?? PILOT_DEFAULT_MAX_STEPS));
    this.confFloor = typeof opts.confFloor === "number" && Number.isFinite(opts.confFloor)
      ? Math.max(0, Math.min(1, opts.confFloor)) : 0.25;
    this.slots = { ...(opts.slots ?? {}) };
    this.driverMode = opts.driver === "agent" ? "agent" : "model";
    this.expectUrl = typeof opts.expectUrl === "string" && opts.expectUrl.trim() !== ""
      ? opts.expectUrl.trim() : null;
    this.attached = opts.skipStartNavigation === true;
    try {
      this.checkpointId = resolveLocalCheckpoint(opts.env ?? process.env);
    } catch {
      // 非法 AMBERFLOW_DECISION_MODEL 由决策源装配面（resolveProviderSpec）如实报；
      // 这里保底缺省档，mw 构造面不崩成未结构化错误。
      this.checkpointId = "english";
    }
    this.outDir = opts.outDir && opts.outDir.trim() !== ""
      ? path.resolve(opts.outDir)
      : path.join(amberflowHome(opts.env ?? process.env), "pilot", this.runId);
  }

  private log(line: string): void {
    this.sink.respond({ type: "log", unsolicited: true, line });
  }

  /** 兜底指令分派面的回执出口（pilot-commands 只经接口回调，不直接碰 sink）。 */
  respond(obj: Record<string, unknown>): void {
    this.sink.respond(obj);
  }

  /** 未决值需求的值袋键（pilot-commands 字符串值键序：target ?? 本键 ?? "resumed"）。 */
  valueNeedKey(): string | null {
    return this.valueNeed === null ? null : this.valueNeed.key;
  }

  /** resume 字符串值跟随 hint 目标：把待注入值写进命中元素的值袋键（fill/select 随即消费）。 */
  private bindPendingValue(el: Elem, value: string | null): void {
    if (value !== null) this.slots[valueKeyOf(el)] = value;
  }

  private mw(): BrowserMiddleware {
    if (this.mwHolder === null) {
      const { defaults } = parseRunDefaults(this.opts.env ?? process.env);
      this.mwHolder = buildMiddleware({ face: "pilot", confirmPolicy: { kind: "default-deny" }, options: {
        modelId: this.checkpointId,
        auditor: new MockAuditor(),
        hosts: this.hosts,
        maxSteps: this.maxSteps,
        reobserve: true,
        settle: DEFAULT_SETTLE,
        confFloor: this.confFloor,
        ...(defaults.ambiguousOrdering === undefined ? {} : { ambiguousOrdering: defaults.ambiguousOrdering }),
        ...(defaults.idFallback === undefined ? {} : { idFallback: defaults.idFallback }),
        ...(defaults.actPoolCap === undefined ? {} : { actPoolCap: defaults.actPoolCap }),
        ...(defaults.poolQuotaMode === undefined ? {} : { poolQuotaMode: defaults.poolQuotaMode }),
      } });
    }
    return this.mwHolder;
  }

  private ctx(): Ctx {
    if (this.ctxHolder !== null) return this.ctxHolder;
    const trace = newTrace({
      app: `pilot:${this.runId}`,
      script_sha256: sha256("amber-pilot"),
      inputs_sha256: inputsSha256({ goal: this.opts.goal }, this.hosts ?? []),
    });
    this.traceRef = trace;
    this.ctxHolder = createCtx({
      pack: { id: `pilot:${this.runId}`, goal: this.opts.goal, hosts: this.hosts },
      slots: {},
      runtime: { outDir: this.outDir, runId: this.runId, today: "" },
      ensureSession: async () => this.ensureSession(),
      mw: () => this.mw(),
      trace,
      verbose: this.opts.verbose === true,
    });
    return this.ctxHolder;
  }

  private async ensureSession(): Promise<BrowserSession> {
    if (this.session === null) {
      // 注入会话 = 宿主已经起好浏览器：不打印启动行，也不把启动失败算成 pilot 的导航失败。
      if (this.opts.sessionFactory !== undefined) {
        this.session = await this.opts.sessionFactory();
      } else {
        this.log(`starting ${this.opts.headful === true ? "headful" : "headless"} browser`);
        this.session = await browserSession(this.opts.headful !== true, null, null, null);
      }
    }
    return this.session;
  }

  async page(): Promise<AnyPage> {
    const s = await this.ensureSession();
    return s.page as AnyPage;
  }

  record(line: PilotRecordLine): void {
    if (this.recordPath === null || this.recordFailed) return;
    try {
      let stream = this.recordStream;
      if (stream === null) {
        stream = fs.createWriteStream(this.recordPath, { flags: "a", encoding: "utf8" });
        // 旁路记录写坏（如 /dev/full）时流会异步 emit "error"：接管降级，不打断驾驶。
        stream.on("error", (e) => { this.recordFailed = true; this.recordStream = null; this.log(`record write failed: ${errMsg(e)}`); });
        this.recordStream = stream;
      }
      stream.write(`${JSON.stringify(line)}\n`);
    } catch (e) {
      this.recordFailed = true;
      this.recordStream = null;
      this.log(`record write failed: ${errMsg(e)}`);
    }
  }

  /**
   * 停驶现场四件套（截图/DOM/池快照/observe）：实现拆在 pilot-evidence.ts
   * （每件独立失败、独立缺字段——一件失败不掩盖停因本身）。
   */
  private async evidenceRefs(page: AnyPage): Promise<PilotHandoff["evidence_refs"]> {
    return await handoffEvidence({
      page, outDir: this.outDir, stepCount: this.stepCount,
      lastPool: this.lastPool, observe: (o) => this.ctx().observe(o),
    });
  }

  /** 驾驶问句的 goal 底座（总目标 + 当前页/期望页 + 有界步史；实现见 pilot-contract.drivingGoalText）。 */
  private drivingGoal(url = ""): string {
    return drivingGoalText(this.opts.goal, this.history, url, this.expectUrl ?? "");
  }

  /**
   * 一步驾驶：规则档先行（零模型）→ 池内闭集投票（pickProposal）→ 闸门 → actOnce 执行。
   * 返回 null = 正常继续；PilotStopCode = 停止（兜底协议接管）；
   * PILOT_AWAIT_PICK = agent 驾驶的步间等待（候选已投影，等 resume{hint} 点名）。
   */
  private async driveOnce(): Promise<PilotStopCode | typeof PILOT_AWAIT_PICK | null> {
    const mw = this.mw();
    const page = await this.page();
    const urlNow = urlOf(page);
    this.excludedFrames = [];
    // 任务页守卫（确定性）：发起方声明了 --expect-url 而当前 URL 不含它 = 页面已漂移。
    // 守卫在抽池/模型票之前——漂走后的候选与模型决策都不是任务语境，继续只会烧预算。
    if (this.expectUrl !== null && !urlNow.includes(this.expectUrl)) return "off_task_page";
    const goal = this.drivingGoal(urlNow);

    // ① 抽池（settle 门 + 与 run 同一条抽取链）。
    const { elems } = await mw._extractPoolSettled(page, "bucketed");
    const poolSize = Object.keys(elems).length;
    this.lastPool = elems;
    this.excludedFrames = frameExclusionsOf(page, this.hosts);
    this.forbidden.clear();
    for (const r of this.ledger.forbiddenRefs(elems)) this.forbidden.add(r);

    // ①′ resume 带 hint 的确定性执行（Agent 兜底点名）：hint 唯一命中即执行，
    //    与 run 声明目标同一认识论——hint 是作者/兜底方的显式决定，不花模型票。
    //    裁决视图 = hintMatch（firstIfSame：同签名重复组任选其一）；裁决为 null 且
    //    候选证据 >1（hintCandidates，签名互异不合并）= target_ambiguous 只停不选
    //    （与 run/session 同一份谓词），不静默回落；真正落空才回落规则档/模型路径。
    //    用后即清（一次性）。
    const resumeHint = this.resumeHint;
    this.resumeHint = null;
    // 待注入值随本轮消费：它只服务 resume 之后的第一轮驾驶（不粘到更晚的点名上）。
    const hintValue = this.pendingValue;
    this.pendingValue = null;
    if (resumeHint !== null) {
      const hintRef = hintMatch(resumeHint, elems, {});
      if (hintRef !== null && elems[hintRef] !== undefined) {
        this.bindPendingValue(elems[hintRef]!, hintValue);
        return await this.executePicked(page, elems, hintRef, "rule", null, poolSize, goal);
      }
      const cands = hintCandidates(resumeHint, elems, {});
      if (cands !== null && cands.refs.length > 1) {
        // 嵌套同目标折叠（与 actOnce 同一谓词面）：容器 vs 它自己的链接 = 同一单元，取后代执行；
        // 互不包含的同 label 仍只停不选。
        const folded = await foldNestedDuplicates(this.mw(), page, elems, resumeHint, "click");
        if (folded !== null && elems[folded[0]!] !== undefined) {
          this.bindPendingValue(elems[folded[0]!]!, hintValue);
          return await this.executePicked(page, elems, folded[0]!, "rule", null, poolSize, goal);
        }
        return "target_ambiguous";
      }
      // 落空（无命中、无可裁决歧义）：记一次证据，下次交接 evidence 带 resume_hint.missed。
      this.missedHint = resumeHint;
    }

    // ② 规则档先行：导航规则（nav 词面）→ affordance 规则（与 run 的 hybrid picking 同一序）。
    //    规则只吃发起方的原始 goal——步史摘要若进规则匹配面，已执行过的标签词面会被灌回
    //    匹配目标里，一次误选可被规则反复复读（不该把「做过什么」当「要做什么」）。
    const navRef = navRule(this.opts.goal, elems);
    const ruleRef = navRef !== null ? navRef : affordanceRule(this.opts.goal, elems, null, {});
    // 规则档 exclude（判据见 pilot-ledger.changedLoop：只排除 toggle/乒乓形态的复读）。
    const ruleEl = ruleRef !== null ? elems[ruleRef] : undefined;
    const ruleSkip = ruleEl !== undefined && (this.ledger.changedLoop(ruleEl) || this.ledger.unhittable(ruleEl)
      || PilotLedger.aggregateContainer(ruleEl));
    if (ruleRef !== null && elems[ruleRef] !== undefined && !ruleSkip) {
      return await this.executePicked(page, elems, ruleRef, "rule", null, poolSize, goal);
    }

    // ③′ agent 驾驶（--driver agent，消融对照臂）：决策权交还 Agent——不发模型票，
    //     无 hint 待选时以步间等待（await_pick）投影候选并等 resume{hint} 点名。
    if (this.driverMode === "agent") {
      return PILOT_AWAIT_PICK;
    }

    // ③ 模型投票（闭集 ref；模型不在位 = 如实停，绝不装会抛的 runtime）。阶梯拆在
    //    pilot-vote.ts：floor 闸门 + 低置信宽扫重问一次（run 4d 同序，不提前弹人）。
    const vote = await modelVote({
      mw, page, goal, elems, forbidden: this.forbidden, notes: this.ledger.notesFor(elems),
      confFloor: this.confFloor, hosts: this.hosts, ask: this.askAdapter,
    });
    if (vote.kind === "no_model_runtime") return "no_model_runtime";
    this.modelAsks += vote.asked;
    if (vote.pool !== null) this.lastPool = vote.pool;
    if (vote.kind === "low_confidence") return "low_confidence";
    const pickEvidence = {
      ref: vote.ref, conf: vote.conf, shape: vote.shape,
      pool_size: Object.keys(vote.pool).length, via: vote.via,
    };
    return await this.executePicked(page, vote.pool, vote.ref, "model", pickEvidence, Object.keys(vote.pool).length, goal);
  }

  /**
   * 执行被选中的池元素：族判定动作类型（红线①——动作类型来自 affordance 族，不是模型生成），
   * fill/select 缺值 = needs_value 停（值不猜）；连续 inert 达阈值 = stuck_inert 停。
   */
  private async executePicked(
    page: AnyPage, elems: ElemPool, ref: string,
    pickedBy: "rule" | "model", pick: { ref: string; conf: number; shape: string; pool_size: number; via?: "ask" | "reobserve" } | null,
    poolSize: number, goal: string,
  ): Promise<PilotStopCode | null> {
    const el = elems[ref] as Elem | undefined;
    if (el === undefined) return "low_confidence";
    this.lastPickedRef = ref;
    if (pickedBy === "model") this.modelPicks += 1; else this.rulePicks += 1;
    const urlBefore = urlOf(page);

    // 族判定（引擎单源 `elemFamily`）：textarea/contenteditable/role=textbox|combobox|listbox
    // 都归 fill/select，不能只看原生 tag——否则这些元素被推成 click，在能力面上不可执行。
    const fam = elemFamily(el);
    const op: "click" | "check" | "fill" | "select" =
      fam === "check" ? "check" : fam === "fill" ? "fill" : fam === "select" ? "select" : "click";

    // 值不猜（红线②）：值只来自预声明 slots 或 resume 显式 value；键/别名/漂移回放裁决单源在 `bindValueFor`。
    let bind: { value: unknown } | null = null;
    let need: ValueNeed | null = null;
    let drift: { from: string; to: string } | null = null;   // 本步键漂移回放（只键名，无值）
    if (op === "fill" || op === "select") {
      need = valueNeedOf(el, ref);
      const prev = this.valueNeed ?? this.lastValueNeed;
      const gate = bindValueFor({ slots: this.slots, need, el, pool: elems, prev });
      if (gate.kind === "needs_value") { this.valueNeed = need; return "needs_value"; }
      drift = gate.drift;
      bind = { value: gate.value };
    }

    // 执行：与 session.act 同一条链（歧义 fail 档、click/check 带遮挡探针）。
    const started = Date.now();
    // 动作解析口径 = hint 匹配口径（`full_label`）：40 字前缀当目标会在长标签上精确匹配落空。
    const targetFull = clipText(String(el.full_label ?? el.label ?? el.text ?? el.tag ?? ref), MAX_HINT);
    const target = clipText(targetFull, MAX_LABEL);
    // 危险闸门（红线⑥）：actOnce 不经 run 的风险闸门、default-deny face 不装 confirmFn——
    // 驾驶面对每个动作做确定性关键词判定（单源 DESTRUCTIVE_PATTERNS）；拒绝 = 结构化失败 +
    // 禁选 + inert 记账，连续拒绝达阈值 = stuck_inert 如实停。
    if (this.ledger.guardStop(el, target)) return "stuck_inert";
    // 动作前快速拒绝（pickRejection）：被覆盖/离屏的选中不执行、不耗步、不烧探针。
    const rejected = await pickRejection(this.mw(), page, elems, ref, op);
    if (rejected !== null) { this.forbidden.add(ref); this.ledger.bump(el, target, rejected); return null; }
    const denyDesc = `${op} ${targetFull}`.toLowerCase();
    if (DESTRUCTIVE_PATTERNS.some((x) => denyDesc.includes(x))) {
      this.history.push({ op, target, ref: null, how: null, ok: false, changed: false,
        step: this.stepCount + 1, picked_by: pickedBy, ...(pick === null ? {} : { conf: pick.conf }) });
      this.stepCount += 1;
      const deniedAction = { op, target, ref: null, how: null, ok: false, changed: false, elapsed_ms: 0, code: "risk_declined" };
      this.record({
        i: this.stepCount - 1, ts: new Date().toISOString(), type: "drive", goal,
        picked_by: pickedBy, ...(pick === null ? {} : { pick }),
        action: deniedAction, url_before: urlBefore, url_after: urlBefore,
      });
      this.sink.respond({
        type: "drive", ok: false, step: this.stepCount, picked_by: pickedBy,
        op, target, ref: null, changed: false, url: urlBefore, elapsed_ms: 0,
        ...(pick === null ? {} : { conf: pick.conf, shape: pick.shape, pool_size: pick.pool_size, via: pick.via }),
      });
      this.forbidden.add(ref);
      this.ledger.bump(el, target, "risk_declined");
      this.inertRun += 1;
      if (this.inertRun >= PILOT_INERT_LIMIT) return "stuck_inert";
      return null;
    }
    // 决策 ref 执行锁（engine `ActLock`）：票已经按池 ref 选中元素，执行面按同一轮抽池的
    // 身份定位（签名 + 活章双证），不再把 ref 还原成 label 重解析——同名重复候选
    // （两个 "4.5"）必撞 target_ambiguous，高置信票会被丢弃。锁失效自动回退既有解析链。
    const out = await this.mw().actOnce(page, targetFull, op, bind, "fail", undefined, {
      ...(op === "click" || op === "check" ? { occlusionProbe: true } : {}),
      diagnostics: true,
      lock: { pool: elems, ref, sig: esig(el) },
    });
    const elapsedMs = Date.now() - started;
    const urlAfter = urlOf(page);
    const step: DrivingStep = {
      op, target, ref: out.ref ?? null, how: out.how ?? null,
      ok: out.ok === true, changed: out.changed === true,
      step: this.stepCount + 1, picked_by: pickedBy, ...(pick === null ? {} : { conf: pick.conf }),
    };
    this.history.push(step);
    this.stepCount += 1;
    this.record({
      i: this.stepCount - 1, ts: new Date().toISOString(), type: "drive", goal,
      picked_by: pickedBy, ...(pick === null ? {} : { pick }),
      action: {
        ...step, elapsed_ms: elapsedMs,
        ...(out.ok === true ? {} : { code: String(out.stopCode ?? "action_failed") }),
        ...(out.resolved_via === undefined ? {} : { resolved_via: out.resolved_via }),
        ...(drift === null ? {} : { value_target_drift: drift }),
      },
      url_before: urlBefore, url_after: urlAfter,
    });
    this.sink.respond({
      type: "drive", ok: out.ok === true, step: this.stepCount, picked_by: pickedBy,
      op, target, ref: step.ref, changed: step.changed, url: urlAfter, elapsed_ms: elapsedMs,
      ...(drift === null ? {} : { value_target_drift: drift }),   // 只出现在 fill/select 步
      ...(out.resolved_via === undefined ? {} : { resolved_via: out.resolved_via }),
      ...(pick === null ? {} : { conf: pick.conf, shape: pick.shape, pool_size: poolSize, via: pick.via }),
    });

    if (out.ok !== true) {
      // 执行失败不立即停：连续落空由 inert 判定兜住（同一元素禁再选）。
      const code = String(out.stopCode ?? "action_failed");
      this.ledger.bump(el, target, `failed:${code}`);
      if (code === "target_ambiguous") return "target_ambiguous";
      if (code === "needs_value") {
        if (need !== null) this.valueNeed = need;
        return "needs_value";
      }
      if (step.ref !== null) this.forbidden.add(step.ref);
    } else {
      this.ledger.bump(el, target, step.changed === true ? "changed" : "no_change");
      if (step.ref !== null && step.changed !== true) {
        this.forbidden.add(step.ref);
      }
      // 值已消费：值需求与待注入值一起清（下一次 needs_value 会重新记录目标）。
      if (need !== null) {
        this.pendingValue = null; this.valueNeed = null;
        this.lastValueNeed = urlBefore === urlAfter ? need : null;   // 换页后同 id 不是同一控件
      }
    }

    // anti-repeat：连续无变化（ok 但 changed=false，或连续失败）达阈值 = stuck_inert。
    const inert = !step.ok || step.changed !== true;
    this.inertRun = inert ? this.inertRun + 1 : 0;
    if (this.inertRun >= PILOT_INERT_LIMIT) return "stuck_inert";
    return null;
  }

  /** checkSignal 验证一条信号声明在当前页是否成立（--final-signal 每轮判与 finish 指令共用）。 */
  async signalHeld(spec: Record<string, unknown>): Promise<boolean> {
    try {
      return await checkSignal(await this.page() as never, spec as SignalSpec, { hosts: this.hosts });
    } catch {
      return false;
    }
  }

  private async finalSignalHeld(): Promise<boolean> {
    const spec = this.opts.finalSignal;
    if (spec === null || spec === undefined || !isObj(spec) || Object.keys(spec).length === 0) return false;
    return await this.signalHeld(spec);
  }

  /* ---------------------------------------------------------------- 兜底协议 */

  /** 停止时投影交接块（intervention 合同形状）并写记录；返回交接块。
   *  停因同时钉进 this.stopCode：无人应答（EOF/idle）时终态摘要不失停因。 */
  private async handoff(stop: PilotStopCode): Promise<PilotHandoff> {
    this.stopCode = stop;
    this.handoffCount += 1;
    let page: AnyPage | null = null;
    try { page = await this.page(); } catch { /* 浏览器已死：证据缺字段 */ }
    const url = page === null ? "" : urlOf(page);
    const valueNeed = stop === "needs_value" ? this.valueNeed : null;
    const missedHint = this.missedHint;
    this.missedHint = null;
    // 结束态可见性（evidence-only）：低置信模型票 + 完成信号声明事实，都是顶层字段
    //（桥面丢 why_stuck.evidence，只有顶层到得了 Agent 面前；无事实时键不出现/null）。
    const weakPicks = weakPicksFrom(this.history);
    const h: PilotHandoff = {
      stop_code: stop,
      step_id: this.stepCount,
      goal_digest: clipText(this.opts.goal, 200),
      why_stuck: {
        summary: `${stop} @ step ${this.stepCount}${url === "" ? "" : ` (${clipText(url, 120)})`}`
          + (this.ledger.loopTrip === null ? "" : ` — dead target: "${clipText(this.ledger.loopTrip.desc, 40)}"`
            + ` driven ${String(this.ledger.loopTrip.tries)} time(s) without the signal holding`),
        evidence: handoffWhyEvidence({
          inertRun: this.inertRun, forbidden: this.forbidden, ledgerEvidence: this.ledger.evidence(),
          framesExcluded: this.excludedFrames, expectUrl: this.expectUrl, valueNeed, missedHint,
        }),
      },
      what_would_unblock: unblockHintsFor(stop, {
        framesExcluded: this.excludedFrames.map((f) => f.origin),
        ...(valueNeed === null ? {} : { needsValueKey: valueNeed.key, needsValueTarget: valueNeed.target }),
      }),
      evidence_refs: page === null ? {} : await this.evidenceRefs(page),
      url,
      ...(weakPicks === undefined ? {} : { weak_picks: weakPicks }),
      final_signal: finalSignalFact(this.opts.finalSignal),
    };
    this.handoffOpen = h;
    this.record({ i: this.stepCount, ts: new Date().toISOString(), type: "handoff", handoff: h, resolved_by: null });
    this.sink.respond({ type: "handoff", unsolicited: true, pilot: true, handoff: h });
    return h;
  }

  /**
   * agent 驾驶的步间投影（--driver agent）：候选行拆在 pilot-evidence.ts
   * （observe 契约行的有界子集，hint_candidates 经 hintMatch 自证唯一命中，Agent 照抄进
   * resume.hint 即确定性执行）。不进驾驶轨迹记录（记录的是已执行动作）。
   */
  private async emitStepRequest(): Promise<void> {
    let page: AnyPage | null = null;
    try { page = await this.page(); } catch { /* 浏览器已死：空候选投影 */ }
    await emitStepRequestEvidence({
      respond: (o) => this.sink.respond(o), page,
      observe: (o) => this.ctx().observe(o), lastPool: this.lastPool,
      goal: this.drivingGoal(page === null ? "" : urlOf(page)), step: this.stepCount,
    });
  }

  /**
   * 兜底指令分派（stdin JSONL 闭集）。返回 "drive" = 回驾驶轮；"close" = 会话收尾；
   * "stay" = 单行被拒/失败（回执已发，继续等下一条——session 的单行失败纪律）。
   */
  /** 改道即换语境：步史与禁选清段重新累计（预算不清零——它是已执行驾驶步的事实）。 */
  redirectReset(): void {
    this.history.length = 0;
    this.forbidden.clear();
    this.ledger.clear();
    this.askAdapter.noteRedirect();
    this.lastPool = null;
    this.excludedFrames = [];
    this.inertRun = 0;
    this.handoffOpen = null;
    // 改道即换语境：值需求/待注入值/落空 hint/键漂移现场都失效（新页面的目标不是同一目标）。
    this.valueNeed = null;
    this.pendingValue = null;
    this.missedHint = null;
    this.lastValueNeed = null;
  }

  /** 起飞：解析决策源 → 开入口页 → 驾驶直到停因/预算/信号。 */
  async start(): Promise<void> {
    ensureDir(this.outDir);
    this.recordPath = this.opts.record !== null && this.opts.record !== undefined
      ? path.resolve(this.opts.record)
      : path.join(this.outDir, "pilot-trace.jsonl");
    ensureDir(path.dirname(this.recordPath));

    // 决策源装配（与 run 面同一序列：resolveProviderSpec → applySpecToRuntime）。
    // floor 优先级与 run 同链（app-runner-policy 的 conf_floor）：CLI --conf-floor >
    // provider 自报（ProviderInfo.floor）> 0.25 缺省——mw 惰性构造，此处改写后首个驾驶轮才读。
    try {
      const spec = await resolveProviderSpec(undefined, undefined);
      this.applied = await applySpecToRuntime(spec);
      if (this.opts.confFloor === undefined) {
        const pf = activeProviderInfo()?.floor;
        if (typeof pf === "number" && pf >= 0 && pf <= 1) this.confFloor = pf;
      }
    } catch (e) {
      this.log(`决策源装配失败（继续以 rules-only 探路）：${errMsg(e)}`);
    }

    if (this.attached) {
      await this.startAttached();
      return;
    }

    try {
      const page = await this.page();
      const bad = disallowedHost(this.opts.url, this.hosts ?? undefined);
      if (bad !== null) throw new Error(bad);
      await page.goto(this.opts.url, { timeout: NAVIGATION_GOTO_TIMEOUT_MS, waitUntil: "domcontentloaded" });
      try { await settle(page as never); } catch { /* settle 不抛 */ }
      this.excludedFrames = frameExclusionsOf(page, this.hosts);
      this.sink.respond({
        type: "started", ok: true, url: urlOf(page), out_dir: this.outDir,
        ...(this.excludedFrames.length === 0 ? {} : { frames_excluded: this.excludedFrames }),
        ...(this.expectUrl === null ? {} : { expect_url: this.expectUrl }),
      });
    } catch (e) {
      this.finished = true;
      this.stopCode = "browser_dead";
      this.sink.respond({ type: "started", ok: false, code: "browser_dead", reason: errMsg(e) });
      return;
    }
  }

  /**
   * 附着起步（attach seam）：宿主已打开页面——不导航、不 settle，只校验当前页在 hosts
   * 信封内后如实发 `started(attached)`。越界 = 结构化 `config_error` 且不再驾驶：动作/导航
   * 守卫都会拒绝越界 host，继续只会把配置错误拖成驾驶停因，误导兜底方。
   */
  private async startAttached(): Promise<void> {
    let page: AnyPage;
    let currentUrl: string;
    try {
      page = await this.page();
      currentUrl = urlOf(page);
    } catch (e) {
      this.finished = true;
      this.stopCode = "browser_dead";
      this.sink.respond({ type: "started", ok: false, code: "browser_dead", reason: errMsg(e) });
      return;
    }
    const bad = disallowedHost(currentUrl, this.hosts ?? undefined);
    if (bad !== null) {
      this.finished = true;
      this.sink.respond({
        type: "started", ok: false, code: "config_error",
        reason: `attached page is outside the hosts envelope: ${bad} (${clipText(currentUrl, 120)})`,
      });
      return;
    }
    this.excludedFrames = frameExclusionsOf(page, this.hosts);
    this.sink.respond({
      type: "started", ok: true, attached: true, url: currentUrl, out_dir: this.outDir,
      ...(this.excludedFrames.length === 0 ? {} : { frames_excluded: this.excludedFrames }),
      ...(this.expectUrl === null ? {} : { expect_url: this.expectUrl }),
    });
  }

  /**
   * 驾驶主循环：每步先判最终信号 → 驾驶一步 → 停因投影交接 → 等兜底指令。
   * 由入口（runPilot）在 stdin 就绪时调用；返回最终停因（null = 被中断/abort）；
   * agent 模式另返回 PILOT_AWAIT_PICK（步间等待：候选已投影，等 resume{hint} 点名）。
   */
  async drive(): Promise<PilotStopCode | typeof PILOT_AWAIT_PICK | null> {
    while (!this.finished && this.stepCount < this.maxSteps) {
      // 完成只认信号（每步动作后判一次；动作前不判——forceAct 语义）。
      if (await this.finalSignalHeld()) {
        this.stopCode = "final_signal_held";
        // 正因收尾即终态：外层循环不再进兜底等待（无人需要接管一次成功）。
        this.finished = true;
        return this.stopCode;
      }
      let stop: PilotStopCode | typeof PILOT_AWAIT_PICK | null = null;
      try {
        stop = await this.driveOnce();
      } catch (e) {
        const msg = errMsg(e);
        if (isDeadPageError(msg)) stop = "browser_dead";
        else {
          // 未预期错误如实投影（不吞）：错误细节进交接块 evidence，停因按兜底档处理。
          this.lastError = msg;
          stop = "stuck_inert";
        }
      }
      if (stop === PILOT_AWAIT_PICK) {
        // agent 驾驶的步间等待：投影候选（step_request）后回入口等 resume{hint}；不是停因。
        await this.emitStepRequest();
        return stop;
      }
      if (stop !== null) {
        if (stop === "browser_dead") { this.stopCode = stop; return stop; }
        await this.handoff(stop);
        // 交接后回到等待：入口层把 stdin 交给 command 分派；驾驶暂停由 awaiting 标志表达。
        return stop; // 首个停因即返回；兜底指令经 resumePilot 再进下一轮
      }
    }
    if (this.stepCount >= this.maxSteps) {
      this.stopCode = "budget_exceeded";
      await this.handoff(this.stopCode);
      return this.stopCode;
    }
    return this.stopCode;
  }

  /**
   * 兜底指令入口（外部 readline 循环把每行递进来）。单行失败纪律与 session 同源：
   * 空行/坏 JSON/未知指令/被拒指令都只是**单行失败**——回执已发、继续等下一条，不杀会话。
   * 返回 "stay"（继续等）| "drive"（回驾驶轮）| "close"（收尾）。
   */
  async handleLine(line: string): Promise<"stay" | "drive" | "close"> {
    return await handlePilotLine(this, line);
  }

  /**
   * 收尾：产物落盘（trace + 汇总）。终态行 `pilot_end` 只在这里发一条——入口层的
   * idle/中断/异常路径把 {code, reason} 作为 note 并进来，不各自再发一条。
   * 浏览器关闭由入口层负责。
   */
  async finish(stop: PilotStopCode | null, note: { code: string; reason: string } | null = null): Promise<void> {
    const finalStop = this.stopCode ?? stop;
    const cache = this.applied !== null && this.applied.stats !== null ? this.applied.stats() : null;
    // 模型咨询数：provider 在场走它自己的计数（缓存命中也算咨询，与 run 摘要同口径）；
    // 装配失败（rules-only 探路）走本面计数兜底。
    const asks = this.applied !== null && this.applied.asks !== null ? this.applied.asks() : this.modelAsks;
    const failedAsks = this.applied !== null && this.applied.failedAsks != null ? this.applied.failedAsks() : null;
    const summary: Record<string, unknown> = {
      type: "pilot_end", unsolicited: true, pilot: true,
      ok: finalStop === "final_signal_held" && !this.aborted,
      stop_code: finalStop, steps: this.stepCount, max_steps: this.maxSteps, conf_floor: this.confFloor,
      model_asks: asks, rule_picks: this.rulePicks, model_picks: this.modelPicks,
      handoffs: this.handoffCount, fallbacks: this.fallbackCount,
      ...(this.driverMode === "agent" ? { driver: "agent" } : {}),
      ...(this.aborted ? { aborted: true } : {}),
      ...(failedAsks !== null && failedAsks > 0 ? { failed_asks: failedAsks } : {}),
      ...(cache !== null ? { cache: { hits: cache.hits, misses: cache.misses } } : {}),
      url: (() => { try { return urlOf(this.session?.page as never); } catch { return ""; } })(),
      ...(this.attached ? { attached: true } : {}),
      ...(this.expectUrl === null ? {} : { expect_url: this.expectUrl }),
      out_dir: this.outDir,
      ...(note !== null ? { code: note.code, reason: note.reason } : {}),
      ...(this.lastError !== null ? { last_error: this.lastError } : {}),
    };
    if (this.traceRef !== null) {
      try { writeTrace(path.join(this.outDir, "pilot-trace.json"), this.traceRef); } catch { /* 落盘失败不掩盖停因 */ }
    }
    try { this.recordStream?.end(); } catch { /* 关流失败不影响结论 */ }
    try { this.recordStream?.close?.(); } catch { /* already closed */ }
    this.sink.respond(summary);
  }

  async closeBrowser(): Promise<void> {
    // 宿主拥有浏览器（attach seam）：pilot 的收尾不得关掉宿主仍在用的会话。
    if (this.opts.ownsSession === false) return;
    try { await this.session?.close(); } catch { /* 幂等收尾 */ }
  }

  /** 驾驶是否已被 finish/abort 终结。 */
  get done(): boolean { return this.finished; }
  get stoppedAt(): PilotStopCode | null { return this.stopCode; }
  get exitCode(): number {
    if (this.stopCode !== null) return pilotExitCode(this.stopCode);
    return 3;
  }
}

/** 选项面校验的单一实现在契约模块（本文件只 re-export，公开面不变）。 */
export { validatePilotOptions } from "./pilot-contract.ts";
