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
 *   - 执行 = `mw.actOnce`（与 session.act / run 命令步同一条解析与执行链）；
 *   - 完成只认信号：`checkSignal`（与 run 的 done 面、session 的 signal 面同一实现）；
 *   - 值不猜：fill/select 缺值 = `needs_value` 停 → 只接受 Agent resume 显式给值。
 *
 * 兜底协议（红线②：触发确定性）：停因闭集见 pilot-contract.ts；停止时投影
 * `PilotHandoff`（intervention 合同形状），stdin JSONL 只认 resume/redirect/finish/abort。
 * 产物恒带 `pilot:true`——它是走查证据，不冒充 run 结论。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
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
import { urlOf } from "../engine/extraction.ts";
import type { Elem, ElemPool } from "../engine/elem-model.ts";
import { checkSignal, type SignalSpec } from "../engine/signals.ts";
import { affordanceRule, hintMatch, navRule } from "../engine/rules.ts";
import { DEFAULT_SETTLE, settle } from "../engine/settle.ts";
import { applySpecToRuntime, resolveProviderSpec } from "../model/decision-provider.ts";
import { bounded, errMsg, isDeadPageError, isObj, nonEmpty } from "./session-runtime-contract.ts";
import {
  PILOT_AGENT_COMMANDS, PILOT_DEFAULT_MAX_STEPS, PILOT_HISTORY_STEPS,
  PILOT_INERT_LIMIT, pilotExitCode, unblockHintsFor,
  type PilotAgentCommand, type PilotHandoff, type PilotOptions, type PilotRecordLine, type PilotStopCode,
} from "./pilot-contract.ts";

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
}

const MAX_LABEL = 40;
const buf = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** 决策票的置信判定（pickProposal 的 shape 分档闸门；与 run 的 low_confidence 同一认识论）。 */
function gateOf(shape: { kind: "full" | "shortlist" | "none" }): "full" | "shortlist" | null {
  if (shape.kind === "full") return "full";
  if (shape.kind === "shortlist") return "shortlist";
  return null;
}

export class PilotRuntime {
  readonly runId: string;
  readonly outDir: string;
  private readonly opts: PilotOptions;
  private readonly sink: PilotSink;
  private readonly hosts: string[] | null;
  private readonly maxSteps: number;
  private readonly confFloor: number;
  private readonly slots: Record<string, string>;

  private session: BrowserSession | null = null;
  private mwHolder: BrowserMiddleware | null = null;
  private ctxHolder: Ctx | null = null;
  private traceRef: AppTrace | null = null;
  private recordStream: fs.WriteStream | null = null;
  private recordPath: string | null = null;
  private resumeHint: string | null = null;
  private lastError: string | null = null;

  private stepCount = 0;
  private inertRun = 0;
  private readonly history: DrivingStep[] = [];
  private readonly forbidden = new Set<string>();
  private handoffOpen: PilotHandoff | null = null;
  private finished = false;
  private stopCode: PilotStopCode | null = null;

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
    this.outDir = opts.outDir && opts.outDir.trim() !== ""
      ? path.resolve(opts.outDir)
      : path.join(amberflowHome(opts.env ?? process.env), "pilot", this.runId);
  }

  /* ---------------------------------------------------------------- 构造面 */

  private log(line: string): void {
    this.sink.respond({ type: "log", unsolicited: true, line });
  }

  private mw(): BrowserMiddleware {
    if (this.mwHolder === null) {
      const { defaults } = parseRunDefaults(this.opts.env ?? process.env);
      this.mwHolder = buildMiddleware({ face: "pilot", confirmPolicy: { kind: "default-deny" }, options: {
        modelId: "english",
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
      this.log(`starting ${this.opts.headful === true ? "headful" : "headless"} browser`);
      this.session = await browserSession(this.opts.headful !== true, null, null, null);
    }
    return this.session;
  }

  private async page(): Promise<AnyPage> {
    const s = await this.ensureSession();
    return s.page as AnyPage;
  }

  /* ---------------------------------------------------------------- 记录面 */

  private record(line: PilotRecordLine): void {
    if (this.recordPath === null) return;
    try {
      this.recordStream ??= fs.createWriteStream(this.recordPath, { flags: "a", encoding: "utf8" });
      this.recordStream.write(`${JSON.stringify(line)}\n`);
    } catch (e) {
      this.log(`record write failed: ${errMsg(e)}`);
    }
  }

  private async evidenceRefs(page: AnyPage): Promise<PilotHandoff["evidence_refs"]> {
    const refs: PilotHandoff["evidence_refs"] = {};
    try {
      const shot = path.join(this.outDir, `handoff-${this.stepCount}.png`);
      await bounded(() => page.screenshot?.({ path: shot }), 5000);
      refs.screenshot = shot;
    } catch { /* 截图失败不掩盖停因 */ }
    try {
      const obs = await this.ctx().observe({ max: 120 });
      const p = path.join(this.outDir, `handoff-${this.stepCount}.observe.json`);
      fs.writeFileSync(p, JSON.stringify(obs, null, 2), "utf8");
      refs.observe = p;
      refs.pool_snapshot = p;
    } catch { /* observe 失败如实缺字段 */ }
    return refs;
  }

  /* ---------------------------------------------------------------- 驾驶循环 */

  /** 驾驶问句的 goal 底座：总目标 + 有界步史摘要（不是自由生成，是既有事实投影）。 */
  private drivingGoal(): string {
    const hist = this.history.slice(-PILOT_HISTORY_STEPS)
      .map((s, i) => `${i + 1}.${buf(s.target, MAX_LABEL)}${s.ok ? "" : "(失败)"}`)
      .join("; ");
    return hist === "" ? this.opts.goal : `${this.opts.goal} | 已完成: ${hist}`;
  }

  /**
   * 一步驾驶：规则档先行（零模型）→ 池内闭集投票（pickProposal）→ 闸门 → actOnce 执行。
   * 返回 null = 正常继续；PilotStopCode = 停止（兜底协议接管）。
   */
  private async driveOnce(): Promise<PilotStopCode | null> {
    const mw = this.mw();
    const page = await this.page();
    const goal = this.drivingGoal();

    // ① 抽池（settle 门 + 与 run 同一条抽取链）。
    const { elems } = await mw._extractPoolSettled(page, "bucketed");
    const poolSize = Object.keys(elems).length;

    // ①′ resume 带 hint 的确定性执行（Agent 兜底点名）：hint 在当前池唯一命中即执行，
    //    与 run 声明目标同一认识论——hint 是作者/兜底方的显式决定，不花模型票。
    //    用后即清（一次性），未命中 = 回落规则档/模型路径并如实记录。
    const resumeHint = this.resumeHint;
    this.resumeHint = null;
    if (resumeHint !== null) {
      const hintRef = hintMatch(resumeHint, elems, {});
      if (hintRef !== null && elems[hintRef] !== undefined) {
        return await this.executePicked(page, elems, hintRef, "rule", null, poolSize, goal);
      }
    }

    // ② 规则档先行：导航规则（nav 词面）→ affordance 规则（与 run 的 hybrid picking 同一序）。
    const navRef = navRule(goal, elems);
    const ruleRef = navRef !== null ? navRef : affordanceRule(goal, elems, null, {});
    if (ruleRef !== null && elems[ruleRef] !== undefined) {
      return await this.executePicked(page, elems, ruleRef, "rule", null, poolSize, goal);
    }

    // ③ 模型投票（闭集 ref；模型不在位 = 如实停，绝不装会抛的 runtime）。
    await mw.ready();
    if (mw.rulesOnly) {
      return "no_model_runtime";
    }
    const proposal = await mw.pickProposal(goal, page, elems, this.forbidden, null);
    if (proposal.choiceRef === null) {
      return "low_confidence";
    }
    const gate = gateOf(proposal.shape);
    if (gate === "full" && proposal.entropyConf < this.confFloor) return "low_confidence";
    if (gate === "shortlist" && proposal.shape.options > 1 && (proposal.pTop1 ?? 0) < this.confFloor) {
      return "low_confidence";
    }
    const pickEvidence = {
      ref: proposal.choiceRef, conf: proposal.entropyConf,
      shape: proposal.shape.kind, pool_size: poolSize,
    };
    return await this.executePicked(page, elems, proposal.choiceRef, "model", pickEvidence, poolSize, goal);
  }

  /**
   * 执行被选中的池元素：族判定动作类型（红线①——动作类型来自 affordance 族，不是模型生成），
   * fill/select 缺值 = needs_value 停（值不猜）；连续 inert 达阈值 = stuck_inert 停。
   */
  private async executePicked(
    page: AnyPage, elems: ElemPool, ref: string,
    pickedBy: "rule" | "model", pick: { ref: string; conf: number; shape: string; pool_size: number } | null,
    poolSize: number, goal: string,
  ): Promise<PilotStopCode | null> {
    const el = elems[ref] as Elem | undefined;
    if (el === undefined) return "low_confidence";
    const urlBefore = urlOf(page);

    // 族判定（与执行器 firstExecFamily 同一分类口径）。
    const tag = (el.tag ?? "").toLowerCase();
    const role = String(el.role ?? el.family ?? "").toLowerCase();
    let op: "click" | "check" | "fill" | "select" = "click";
    if (tag === "select" || role === "select") op = "select";
    else if (tag === "input" && ["text", "search", "email", "password", "tel", "url", "number"].includes(String(el.input_type ?? el.type ?? ""))) op = "fill";
    else if (tag === "input" && String(el.input_type ?? el.type ?? "") === "checkbox") op = "check";

    // 值不猜（红线②）：fill/select 的值来自预声明 slots 或 Agent resume 显式给值。
    let bind: { value: unknown } | null = null;
    if (op === "fill" || op === "select") {
      const labelKey = buf(String(el.label ?? el.text ?? ""), 40);
      const slotKey = Object.keys(this.slots).find((k) => k === labelKey || k.toLowerCase() === labelKey.toLowerCase()
        || labelKey.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(labelKey.toLowerCase()));
      if (slotKey === undefined) return "needs_value";
      bind = { value: this.slots[slotKey]! };
    }

    // 执行：与 session.act 同一条链（歧义 fail 档、click/check 带遮挡探针）。
    const started = Date.now();
    const target = buf(String(el.label ?? el.text ?? el.tag ?? ref), MAX_LABEL);
    const out = await this.mw().actOnce(page, target, op, bind, "fail", undefined, {
      ...(op === "click" || op === "check" ? { occlusionProbe: true } : {}),
      diagnostics: true,
    });
    const elapsedMs = Date.now() - started;
    const urlAfter = urlOf(page);
    const step: DrivingStep = {
      op, target, ref: out.ref ?? null, how: out.how ?? null,
      ok: out.ok === true, changed: out.changed === true,
    };
    this.history.push(step);
    this.stepCount += 1;
    this.record({
      i: this.stepCount - 1, ts: new Date().toISOString(), type: "drive", goal,
      picked_by: pickedBy, ...(pick === null ? {} : { pick }),
      action: { ...step, elapsed_ms: elapsedMs, ...(out.ok === true ? {} : { code: String(out.stopCode ?? "action_failed") }) },
      url_before: urlBefore, url_after: urlAfter,
    });
    this.sink.respond({
      type: "drive", ok: out.ok === true, step: this.stepCount, picked_by: pickedBy,
      op, target, ref: step.ref, changed: step.changed, url: urlAfter, elapsed_ms: elapsedMs,
      ...(pick === null ? {} : { conf: pick.conf, shape: pick.shape, pool_size: poolSize }),
    });

    if (out.ok !== true) {
      // 执行失败不立即停：连续落空由 inert 判定兜住（同一元素禁再选）。
      const code = String(out.stopCode ?? "action_failed");
      if (code === "target_ambiguous") return "target_ambiguous";
      if (code === "needs_value") return "needs_value";
      if (step.ref !== null) this.forbidden.add(step.ref);
    } else {
      if (step.ref !== null && step.changed !== true) {
        this.forbidden.add(step.ref);
      }
    }

    // anti-repeat：连续无变化（ok 但 changed=false，或连续失败）达阈值 = stuck_inert。
    const inert = !step.ok || step.changed !== true;
    this.inertRun = inert ? this.inertRun + 1 : 0;
    if (this.inertRun >= PILOT_INERT_LIMIT) return "stuck_inert";
    return null;
  }

  /* ---------------------------------------------------------------- 完成判定 */

  private async finalSignalHeld(): Promise<boolean> {
    const spec = this.opts.finalSignal;
    if (spec === null || spec === undefined || !isObj(spec) || Object.keys(spec).length === 0) return false;
    try {
      return await checkSignal(await this.page() as never, spec as SignalSpec, { hosts: this.hosts });
    } catch {
      return false;
    }
  }

  /* ---------------------------------------------------------------- 兜底协议 */

  /** 停止时投影交接块（intervention 合同形状）并写记录；返回交接块。 */
  private async handoff(stop: PilotStopCode): Promise<PilotHandoff> {
    let page: AnyPage | null = null;
    try { page = await this.page(); } catch { /* 浏览器已死：证据缺字段 */ }
    const url = page === null ? "" : urlOf(page);
    const h: PilotHandoff = {
      stop_code: stop,
      step_id: this.stepCount,
      goal_digest: buf(this.opts.goal, 200),
      why_stuck: {
        summary: `${stop} @ step ${this.stepCount}${url === "" ? "" : ` (${buf(url, 120)})`}`,
        evidence: { inert_run: this.inertRun, forbidden: [...this.forbidden].slice(0, 40) },
      },
      what_would_unblock: unblockHintsFor(stop),
      evidence_refs: page === null ? {} : await this.evidenceRefs(page),
      url,
    };
    this.handoffOpen = h;
    this.record({ i: this.stepCount, ts: new Date().toISOString(), type: "handoff", handoff: h, resolved_by: null });
    this.sink.respond({ type: "handoff", unsolicited: true, pilot: true, handoff: h });
    return h;
  }

  /**
   * 兜底指令分派（stdin JSONL 闭集）。返回 true = 驾驶继续；false = 会话收尾。
   */
  private async command(cmd: PilotAgentCommand, args: Record<string, unknown>): Promise<boolean> {
    this.record({ i: this.stepCount, ts: new Date().toISOString(), type: "command", command: cmd, args });
    switch (cmd) {
      case "resume": {
        if (this.handoffOpen === null) {
          this.sink.respond({ type: "command_result", ok: false, code: "config_error", reason: "resume without an open handoff" });
          return true;
        }
        // resume.value 显式给值（红线②：值只能从这里或预声明 slots 来）。
        const value = args["value"];
        if (value !== undefined && value !== null && nonEmpty(String(value))) {
          const key = buf(String(args["target"] ?? ""), 40) || "resumed";
          this.slots[key] = String(value);
        }
        // resume.hint 点名收窄：写进下一步的规则档（hint 命中即确定性执行，零模型）。
        const hint = args["hint"];
        if (typeof hint === "string" && hint.trim() !== "") {
          this.resumeHint = hint.trim();
        }
        this.inertRun = 0;
        this.handoffOpen = null;
        this.sink.respond({ type: "command_result", ok: true, resumed: true, step: this.stepCount });
        return true;
      }
      case "redirect": {
        const url = args["url"];
        const goal = args["goal"];
        if (typeof url === "string" && nonEmpty(url)) {
          try {
            const page = await this.page();
            const bad = disallowedHost(url, this.hosts ?? undefined);
            if (bad !== null) throw new Error(bad);
            await page.goto(url, { timeout: NAVIGATION_GOTO_TIMEOUT_MS, waitUntil: "domcontentloaded" });
            try { await settle(page as never); } catch { /* settle 不抛 */ }
            this.inertRun = 0;
            this.handoffOpen = null;
            this.sink.respond({ type: "command_result", ok: true, redirected: true, url: urlOf(page) });
            return true;
          } catch (e) {
            this.sink.respond({ type: "command_result", ok: false, code: "nav_failed", reason: errMsg(e) });
            return true;
          }
        }
        if (typeof goal === "string" && nonEmpty(goal)) {
          // redirect 只有 goal = 换总目标重驾驶（预算不清零；预算重置请起新 pilot）。
          this.opts.goal = buf(goal, 400);
          this.inertRun = 0;
          this.handoffOpen = null;
          this.sink.respond({ type: "command_result", ok: true, redirected: true, goal_digest: buf(goal, 200) });
          return true;
        }
        this.sink.respond({ type: "command_result", ok: false, code: "config_error", reason: "redirect needs url or goal" });
        return true;
      }
      case "finish": {
        this.finished = true;
        this.stopCode = "final_signal_held";
        this.sink.respond({ type: "command_result", ok: true, finished: true, pilot: true });
        return false;
      }
      case "abort": {
        this.finished = true;
        this.stopCode = null; // 非正因收尾：退出码 3 由 finish() 决定
        this.sink.respond({ type: "command_result", ok: true, aborted: true });
        return false;
      }
    }
  }

  /* ---------------------------------------------------------------- 主循环 */

  /** 起飞：解析决策源 → 开入口页 → 驾驶直到停因/预算/信号。 */
  async start(): Promise<void> {
    ensureDir(this.outDir);
    this.recordPath = this.opts.record !== null && this.opts.record !== undefined
      ? path.resolve(this.opts.record)
      : path.join(this.outDir, "pilot-trace.jsonl");
    ensureDir(path.dirname(this.recordPath));

    // 决策源装配（与 run 面同一序列：resolveProviderSpec → applySpecToRuntime）。
    try {
      const spec = await resolveProviderSpec(undefined, undefined);
      await applySpecToRuntime(spec);
    } catch (e) {
      this.log(`决策源装配失败（继续以 rules-only 探路）：${errMsg(e)}`);
    }

    try {
      const page = await this.page();
      const bad = disallowedHost(this.opts.url, this.hosts ?? undefined);
      if (bad !== null) throw new Error(bad);
      await page.goto(this.opts.url, { timeout: NAVIGATION_GOTO_TIMEOUT_MS, waitUntil: "domcontentloaded" });
      try { await settle(page as never); } catch { /* settle 不抛 */ }
      this.sink.respond({ type: "started", ok: true, url: urlOf(page), out_dir: this.outDir });
    } catch (e) {
      this.finished = true;
      this.stopCode = "browser_dead";
      this.sink.respond({ type: "started", ok: false, code: "browser_dead", reason: errMsg(e) });
      return;
    }
  }

  /**
   * 驾驶主循环：每步先判最终信号 → 驾驶一步 → 停因投影交接 → 等兜底指令。
   * 由入口（runPilot）在 stdin 就绪时调用；返回最终停因（null = 被中断/abort）。
   */
  async drive(): Promise<PilotStopCode | null> {
    while (!this.finished && this.stepCount < this.maxSteps) {
      // 完成只认信号（每步动作后判一次；动作前不判——forceAct 语义）。
      if (await this.finalSignalHeld()) {
        this.stopCode = "final_signal_held";
        // 正因收尾即终态：外层循环不再进兜底等待（无人需要接管一次成功）。
        this.finished = true;
        return this.stopCode;
      }
      let stop: PilotStopCode | null = null;
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
   * 兜底指令入口（外部 readline 循环把合法指令递进来）。非法输入 = 结构化 config_error，
   * 不杀会话。返回 true = 驾驶继续（重新进 drive 轮）。
   */
  async handleLine(line: string): Promise<{ handled: boolean; driveAgain: boolean }> {
    const raw = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
    if (raw.trim() === "") return { handled: false, driveAgain: false };
    let req: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isObj(parsed)) throw new Error("not an object");
      req = parsed;
    } catch (e) {
      this.sink.respond({ type: "error", ok: false, code: "config_error", reason: `bad JSONL: ${errMsg(e)}` });
      return { handled: false, driveAgain: false };
    }
    const cmd = req["cmd"] ?? req["type"];
    if (typeof cmd !== "string" || !(PILOT_AGENT_COMMANDS as readonly string[]).includes(cmd)) {
      this.sink.respond({
        type: "error", ok: false, code: "config_error",
        reason: `pilot commands are ${PILOT_AGENT_COMMANDS.join(" | ")} (got ${JSON.stringify(cmd)})`,
      });
      return { handled: false, driveAgain: false };
    }
    const again = await this.command(cmd as PilotAgentCommand, req);
    return { handled: true, driveAgain: again };
  }

  /** 收尾：产物落盘（trace + 汇总），浏览器关闭由入口层负责。 */
  async finish(stop: PilotStopCode | null): Promise<void> {
    const finalStop = this.stopCode ?? stop;
    const summary = {
      type: "pilot_end", unsolicited: true, pilot: true,
      ok: finalStop === "final_signal_held",
      stop_code: finalStop, steps: this.stepCount, max_steps: this.maxSteps,
      url: (() => { try { return urlOf(this.session?.page as never); } catch { return ""; } })(),
      out_dir: this.outDir,
      ...(this.lastError !== null ? { last_error: this.lastError } : {}),
    };
    if (this.traceRef !== null) {
      try { writeTrace(path.join(this.outDir, "pilot-trace.json"), this.traceRef); } catch { /* 落盘失败不掩盖停因 */ }
    }
    this.recordStream?.end();
    try { this.recordStream?.close?.(); } catch { /* already closed */ }
    this.sink.respond(summary);
  }

  async closeBrowser(): Promise<void> {
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

/** 一次性校验 pilot 选项面（CLI 入口先跑；非法 = 结构化错误，不猜）。 */
export function validatePilotOptions(opts: PilotOptions): string | null {
  if (typeof opts.url !== "string" || opts.url.trim() === "") return "pilot needs a non-empty --url";
  try { new URL(opts.url); } catch { return `pilot --url is not a valid URL: ${JSON.stringify(opts.url)}`; }
  if (typeof opts.goal !== "string" || opts.goal.trim() === "") return "pilot needs a non-empty --goal";
  if (opts.finalSignal != null && !isObj(opts.finalSignal)) return "pilot --final-signal must be a JSON object when present";
  if (opts.maxSteps !== undefined && (!Number.isInteger(opts.maxSteps) || opts.maxSteps! < 1 || opts.maxSteps! > 200)) {
    return "pilot --max-steps must be an integer in [1, 200]";
  }
  if (opts.confFloor !== undefined && (typeof opts.confFloor !== "number" || opts.confFloor! < 0 || opts.confFloor! > 1)) {
    return "pilot --conf-floor must be a number in [0, 1]";
  }
  return null;
}
