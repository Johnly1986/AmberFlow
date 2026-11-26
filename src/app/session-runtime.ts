/**
 * `amber session` 运行时——**交互式试错 authoring 面**的核心实现（task-33 / Phase 1）。
 *
 * 定位（与 design.md §0/§3/§6 同一份口径）：session 是**规划/调试面**，正式执行仍是
 * 「冻结计划 + 运行时消歧」。所以这里**不**调用 `mw.run()`（决策循环/判 done/占预算），
 * 也**不**评估完成信号；它只回答「这一行命令现在发生了什么」。
 *
 * 同源纪律（本文件的存在理由）：
 *   - open / observe / read / extract / waitFor / holds 全部经 `createCtx` —— 与 `flow(ctx)`
 *      脚本应用拿到的**同一个 ctx 实现**（`src/app/ctx.ts`），不是"照抄一套语义"；
 *   - act 经 `BrowserMiddleware.actOnce` —— 与命令步/原语同一条解析链
 *      （`_extractPoolSettled` 抽池 + settle 门 + `resolveCommandRef` → `hintMatch` +
 *      池外 `_domFallbackResolve`）与同一条执行器（`_executeElement`）；
 *   - signal 经 `checkSignal`、形状校验经 `validateSignalSpec`（同一个加载期校验器）；
 *   - snapshot 经 `mw.snapshot` + `extractElements`（正式池）+ Playwright 截图；
 *   - 会话构造/关闭模板照搬 `runScriptApp`（browserSession + BrowserMiddleware + createCtx
 *      + finally close）。**不** import 任何决策 provider（auditor 用 MockAuditor）。
 *
 * 未在契约里的东西一律不假装：读不到 = null，超时 = held:false，动作失败 = 结构化 code，
 * 会话没碰过浏览器就不启动浏览器。
 */
import fs from "node:fs";
import path from "node:path";

import { createCtx, StopError, type Ctx } from "./ctx.ts";
// S1：行容器滚动（rows 寻址）与 scroll 分支执行体在独立模块（主文件只减不增）。
import { doActScroll } from "./session-act-scroll.ts";
// A3 范围原语的会话面：act set_range 分支执行体在独立模块（doAct 存量行数只减不增）。
import { doActSetRange } from "./session-act-range.ts";
import { wideScanCandidates } from "./session-wide-scan.ts";
import { observeReadiness } from "./session-readiness.ts";
// F76/P3：tab 请求处理体（校验/匹配/切页）在独立模块（主文件只减不增）。
import { doTabRequest, type TabOpDeps } from "./session-ops-extra.ts";
// 会话内托管 pilot 驾驶：附着式 driver（状态机/响应投影在独立模块，主文件只加接线）。
import { SessionPilotDriver } from "./session-driver.ts";
import { buildMiddleware } from "./middleware-factory.ts";
import { amberflowHome, ensureDir } from "../support/amberflow-home.ts";
import { sleepMs } from "../support/sleep.ts"; import { NAVIGATION_GOTO_TIMEOUT_MS } from "../support/tuning.ts";
import { parseRunDefaults } from "../support/run-defaults.ts";
import { inputsSha256, newTrace, sha256, writeTrace, type AppTrace } from "./trace.ts";
import { MockAuditor } from "../engine/audit.ts";
import { BrowserMiddleware, browserSession, disallowedHost, type AnyPage, type BrowserSession } from "../engine/executor.ts";
import { rowStatsAnyFrame, urlOf, windowAudit, type ElemPool, type PageLike } from "../engine/extraction.ts";
import { extractElements } from "./candidate-scan.ts";
// task-34（B1 旁路复用）：与 run 面**同一个**弱档命中诊断（`rules.hintMatchImpl` 的模块态）， 会话只 take 出来回显，不改选择语义、不改 run 面任何代码。
import { takeHintMatchOthers } from "../engine/rules.ts";
import { DEFAULT_SETTLE } from "../engine/settle.ts";
import { hostsEnvelopeLogLine, normalizeHostsEnvelope, type HostsEnvelopeNormalization } from "../engine/host-envelope.ts";

import { actAmbiguity, actionabilityResponse, ambiguityMode, ambiguityRecord, ambiguityResponse, closedSetReasonSuffix, displayHow, doRead, doSignal, doWaitFor, executionStateResponse, extractSettleEvidence, failureScreenshot, missDiagnosticsResponse, navProbeFacts, observeAfter, RecentResolutions, shapeProblemResponse } from "./session-runtime-evidence.ts";
import { extractFieldsReason, normalizeExtractFields } from "./session-extract-fields.ts";
import { assertPageAlive, browserStartupProblem, FLAP_HEAL_SETTLE_MS, landedNavigationFacts, FLAP_QUIET_EXIT_MS, FLAP_WINDOW_MS, SESSION_ACT_OPS, SESSION_DEFAULT_MAX_REQUEST_BYTES, encodedFormUrl, errMsg, SESSION_REQUEST_TYPES, intIn, isDeadPageError, isObj, judgeFlapNavs, nonEmpty, sessionTargetResolution, type FlapHealResult, type FlapJudgement, type NavEvent, type SessionActOp, type SessionExit, type SessionOptions, type SessionSink } from "./session-runtime-contract.ts";
export * from "./session-runtime-contract.ts";
export { runSession } from "./session-runtime-entry.ts";

export class SessionRuntime {
  readonly runId: string;
  readonly outDir: string;
  private readonly opts: SessionOptions;
  private readonly sink: SessionSink;
  private readonly hosts: string[] | null;
  /** `hosts` 入参的归一化结果：`hosts` 本身只留规范形，这里保留"声明了什么、改写了什么"以便回显。 */
  private readonly hostsNorm: HostsEnvelopeNormalization;
  private readonly maxRequestBytes: number;

  private readonly holder: { session: BrowserSession | null } = { session: null };
  private readonly mwHolder: { current: BrowserMiddleware | null } = { current: null };
  private readonly ctxHolder: { current: Ctx | null } = { current: null };
  /**
   * C1：extract 的总量观测口（**只有会话面注入**；run/dry/replay 不注入、产物不变）。
   * `ctx.extract` 的返回类型仍是行数组，分页所需的 `total` 经这个对象回写。
   */
  private readonly extractStats: { total: number } = { total: 0 };
  private traceRef: AppTrace | null = null;
  private recordStream: fs.WriteStream | null = null;
  /** 记录流写失败（ENOSPC/EIO，如 `--record /dev/full`）后永久停用：不再写、不再重建。 */
  private recordWriteFailed = false;

  private readonly startedAt = Date.now();
  private requestCount = 0;
  private actionCount = 0;
  private snapshotCount = 0;
  private readonly urls: string[] = [];
  private finished = false;
  /**
   * S4：最近成功解析记录（evidence 模块的 RecentResolutions）。`target_not_found`
   * 时若同 hint 在 ≤10 个动作内命中过，落空诊断带 `recently_resolved`——"行内容
   * 可能已变，建议重新 observe" 的引导事实。纯内存零页面往返；只影响会话面。
   */
  private readonly recentResolutions = new RecentResolutions();
  /** 惰性单驾驶员：驾驶请求才构造；同一会话复用同一个 pilot（driveClose 后不再复用）。 */
  private driver: SessionPilotDriver | null = null;

  constructor(opts: SessionOptions, sink: SessionSink, runId?: string) {
    this.opts = opts;
    this.sink = sink;
    this.runId = runId ?? `${Date.now().toString(36)}-${process.pid}`;
    this.hostsNorm = normalizeHostsEnvelope(opts.hosts);
    this.hosts = this.hostsNorm.hosts.length > 0 ? this.hostsNorm.hosts : null;
    this.maxRequestBytes = intIn(opts.maxRequestBytes, 1_024, 16 * 1_048_576) ?? SESSION_DEFAULT_MAX_REQUEST_BYTES;
    this.outDir = opts.outDir && opts.outDir.trim() !== ""
      ? path.resolve(opts.outDir)
      : path.join(amberflowHome(opts.env ?? process.env), "session", this.runId);
  }

  /* ---------------------------------------------------------------- 构造面 */

  private log(line: string): void {
    if (this.opts.quiet === true) return;
    this.sink.log(line);
  }

  /** 浏览器惰性创建：`close` 之前没碰过页面，就不启动浏览器（0 进程）。 */
  private async ensureSession(): Promise<BrowserSession> {
    if (this.holder.session === null) {
      this.log(`starting ${this.opts.headful === true ? "headful" : "headless"} browser${this.opts.window !== undefined && this.opts.window !== null ? ` (${this.opts.window})` : ""}`);
      try {
        this.holder.session = await browserSession(
          this.opts.headful !== true, null, null, this.opts.window ?? null,
        );
      } catch (e) {
        // 启动期失败 = 环境/配置问题（如 headed 但没有 XServer），不是"页面已死"：归
        // config_error 并给出可行动建议，会话保持存活（下一次请求可换 headless 重试）。
        // 判据吃**完整**错误文本：XServer 提示不在 errMsg 的首行截断里。`browser_startup`
        // 标记让入口把这条错误当成"本次 open 失败"，而不是会话级死亡（会话仍可换档重试）。
        const startup = browserStartupProblem(e instanceof Error ? e.message : String(e), this.opts.headful === true);
        if (startup !== null) {
          throw new StopError(startup.code, `${startup.reason} — ${startup.suggestion}`, { browser_startup: true });
        }
        throw e;
      }
    }
    return this.holder.session;
  }

  /** 执行器：经 buildMiddleware 单点构造；不注入决策 provider（auditor 是 Mock），确认询问保持执行器缺省拒绝。 */
  private mw(): BrowserMiddleware {
    if (this.mwHolder.current === null) {
      // E2/E1-c/E1-a/E1-b：决策开关（decision.*）从配置层默认值解析（非法值已在 CLI 入口报错）。
      const { defaults } = parseRunDefaults(this.opts.env ?? process.env);
      this.mwHolder.current = buildMiddleware({ face: "session", confirmPolicy: { kind: "default-deny" }, options: {
        modelId: "english",
        auditor: new MockAuditor(),
        hosts: this.hosts, maxSteps: 8,
        reobserve: true,
        // S2 稳定门：与 run 的缺省档一致（抽池前等页面静默）。
        settle: DEFAULT_SETTLE,
        targetResolution: sessionTargetResolution(this.opts),
        ...(defaults.ambiguousOrdering === undefined ? {} : { ambiguousOrdering: defaults.ambiguousOrdering }),
        ...(defaults.idFallback === undefined ? {} : { idFallback: defaults.idFallback }),
        ...(defaults.actPoolCap === undefined ? {} : { actPoolCap: defaults.actPoolCap }),
        ...(defaults.poolQuotaMode === undefined ? {} : { poolQuotaMode: defaults.poolQuotaMode }),
      } });
    }
    return this.mwHolder.current;
  }

  /** 运行期面：`createCtx` 是 flow 脚本同一个对象（open/observe/read/extract/waitFor/holds 同源）。 */
  private ctx(): Ctx {
    if (this.ctxHolder.current !== null) return this.ctxHolder.current;
    const trace = newTrace({
      app: `session:${this.runId}`,
      script_sha256: sha256("amber-session"),
      inputs_sha256: inputsSha256({}, this.hosts ?? []),
    });
    this.traceRef = trace;
    this.ctxHolder.current = createCtx({
      pack: { id: `session:${this.runId}`, goal: "(interactive authoring session)", hosts: this.hosts },
      slots: {},
      runtime: { outDir: this.outDir, runId: this.runId, today: "" },
      ensureSession: () => this.ensureSession(),
      mw: () => this.mw(),
      trace,
      verbose: this.opts.verbose === true,
      // C1：总量观测口只在这里注入（Flow 运行面/ dry / replay 都没有这条线）。
      extractStats: this.extractStats,
    });
    return this.ctxHolder.current;
  }

  private async page(): Promise<AnyPage> {
    return (await this.ensureSession()).page;
  }

  /** 标题读取有界（2s）：卡死页面不能拖住一行响应（与 observe 的 title 同口径）。 */
  private async titleOf(): Promise<string | undefined> {
    try {
      const p = await this.page();
      const raw = await Promise.race([
        Promise.resolve().then(() => p.title()),
        new Promise<string>((r) => setTimeout(() => r(""), 2000)),
      ]);
      const s = String(raw ?? "").trim();
      return s === "" ? undefined : s;
    } catch {
      return undefined;
    }
  }

  /* ---------------------------------------------------------------- 输出面 */

  private respond(obj: Record<string, unknown>): void {
    this.sink.respond(obj);
  }

  /**
   * 轨迹文件句柄（懒创建；`--record` 没给 = no-op）。Phase 2：一条轨迹要能被 export 还原成骨架。
   *
   * 写目标满/坏（`/dev/full`）时流会**异步** emit "error"——必须在这里接管：记录是旁路产物，
   * 失败只降级为一条日志并永久停用该流，绝不能变成未捕获异常把会话打断成裸栈崩溃。
   */
  private recordStreamFor(): fs.WriteStream | null {
    if (this.opts.record === null || this.opts.record === undefined) return null;
    if (this.recordWriteFailed) return null;
    if (this.recordStream !== null) return this.recordStream;
    try {
      ensureDir(path.dirname(path.resolve(this.opts.record)));
      const stream = fs.createWriteStream(path.resolve(this.opts.record), { flags: "a", encoding: "utf8" });
      stream.on("error", (e) => { this.abandonRecord(e); });
      this.recordStream = stream;
      return stream;
    } catch (e) {
      this.log(`record open failed: ${errMsg(e)}`);
      return null;
    }
  }

  /** 记录流失效即旁路降级：一条日志 + 永久停用（不重建——重建只会反复失败）。 */
  private abandonRecord(e: unknown): void {
    this.recordWriteFailed = true;
    this.recordStream = null;
    this.log(`record write failed: ${errMsg(e)}`);
  }

  /** 轨迹行落盘：写前判可用（失败后不再写）；写抛错也只降级，不打断会话。 */
  private writeRecordLine(line: string): void {
    const stream = this.recordStreamFor();
    if (stream === null || !stream.writable) return;
    try {
      stream.write(line);
    } catch (e) {
      this.abandonRecord(e);
    }
  }

  /** 轨迹里的非动作事件（open / mark）：`export` 需要入口页与人工标记。 */
  private recordEvent(entry: Record<string, unknown>): void {
    this.writeRecordLine(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  }

  /** 动作轨迹（`--record`）：只记**已发生的事实**；fill/select 的值只落 hash（design §5/Q5）。 */
  private recordAction(entry: Record<string, unknown>): void {
    this.writeRecordLine(`${JSON.stringify({ i: this.actionCount, ts: new Date().toISOString(), ...entry })}\n`);
  }

  private recordMark(note: string): void {
    this.recordEvent({ type: "mark", note: note.slice(0, 300) });
  }

  /**
   * `--record` 时的**观察侧 hint 候选**（Phase 2 export 的每步 `observe_hints`）：
   * 动作用的是 hint 闭集，而 `ctx.observe` 的 `hint_candidates` 已被同一个 `hintMatch`
   * 在本次观察集合上自证过——比作者手抄的字符串更可交付。只读、只在开记录时付一次观察。
   */
  private async hintsForRecord(target: string | undefined): Promise<string[]> {
    if (this.opts.record === null || this.opts.record === undefined) return [];
    if (target === undefined || target.trim() === "") return [];
    try {
      const obs = await this.ctx().observe({ max: 120 });
      const want = target.trim().toLowerCase();
      const out: string[] = [];
      for (const el of obs.elements) {
        const hs = Array.isArray(el.hint_candidates) ? el.hint_candidates : [];
        const label = String(el.label ?? "").trim().toLowerCase();
        const hit = label === want || label.includes(want) || hs.some((h) => h.toLowerCase() === want);
        if (!hit) continue;
        for (const h of hs) if (!out.includes(h)) out.push(h);
        if (out.length >= 6) break;
      }
      return out.slice(0, 6);
    } catch {
      return []; // 观察失败不阻断动作；轨迹里如实缺这条字段
    }
  }

  /* ---------------------------------------------------------------- 请求处理 */

  /** 启动：给了 `--url` 就先 open（失败只报一行，不杀会话——人还可以再发 open）。 */
  async start(): Promise<void> {
    this.log(`session ${this.runId} — evidence dir ${this.outDir}`);
    const hostsLog = hostsEnvelopeLogLine(this.hostsNorm);
    if (hostsLog !== null) this.log(hostsLog);
    if (this.hostsNorm.warning !== null) this.log(this.hostsNorm.warning);
    if (nonEmpty(this.opts.url)) {
      const resp = await this.dispatch({ type: "open", url: this.opts.url });
      // 自动 open 的响应没有请求 id（它不是某一行请求的回显），但形状与普通响应一致。
      this.respond({ id: null, type: "open", ...resp });
    }
  }

  /**
   * 处理一行请求。返回 `true` = 会话应当结束（close / 页面已死）。
   * 空行/坏 JSON/未知类型都只是单行失败，不结束会话。
   */
  async handleLine(raw: string): Promise<boolean> {
    this.requestCount += 1;
    if (Buffer.byteLength(raw, "utf8") > this.maxRequestBytes) {
      this.respond({
        id: null, type: "error", ok: false, code: "config_error",
        reason: `request line exceeds --max-request-bytes (${this.maxRequestBytes})`,
      });
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      this.respond({
        id: null, type: "error", ok: false, code: "bad_json",
        line_no: this.requestCount, reason: errMsg(e),
      });
      return false;
    }
    if (!isObj(parsed)) {
      this.respond({
        id: null, type: "error", ok: false, code: "config_error",
        reason: "a request must be a JSON object like {\"type\":\"observe\"}",
      });
      return false;
    }
    const id = parsed["id"] === undefined ? null : parsed["id"];
    const type = typeof parsed["type"] === "string" ? parsed["type"] : "";
    if (!(SESSION_REQUEST_TYPES as readonly string[]).includes(type)) {
      this.respond({
        id, type: type || "error", ok: false, code: "config_error",
        reason: `unknown request type ${JSON.stringify(parsed["type"])}`,
        allowed_types: [...SESSION_REQUEST_TYPES],
      });
      return false;
    }
    let resp: Record<string, unknown>;
    try {
      resp = await this.dispatch({ ...parsed, type });
    } catch (e) {
      const msg = errMsg(e);
      if (e instanceof StopError) {
        resp = { ok: false, code: e.code, reason: e.message };
      } else if (isDeadPageError(msg)) {
        this.respond({ id, type, ok: false, code: "browser_dead", reason: msg });
        this.respond({ type: "session_end", unsolicited: true, ok: false, code: "browser_dead", reason: msg });
        return true;
      } else {
        resp = { ok: false, code: "internal_error", reason: msg };
      }
    }
    this.respond({ id, type, ...resp });
    return type === "close" && resp["ok"] === true;
  }

  private async dispatch(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertPageAlive(this.holder.session, req["type"]);
    switch (req["type"]) {
      case "open": return this.doOpen(req);
      case "goto": return this.doGoto(req);
      case "observe": return this.doObserve(req);
      case "act": return this.doAct(req);
      case "read": return doRead(this.ctx(), req);
      case "extract": return this.doExtract(req);
      case "waitFor": return doWaitFor(this.ctx(), (l) => this.log(l), req);
      case "signal": return doSignal(this.ctx(), (l) => this.log(l), req);
      case "snapshot": return this.doSnapshot(req);
      case "mark": return this.doMark(req);
      case "tab": return doTabRequest(req, this.tabOpDeps());
      case "drive": return this.driverFor().drive(req);
      case "driveCommand": return this.driverFor().command(req);
      case "driveStatus": return this.driverFor().status();
      case "driveClose": return this.driverFor().close();
      case "close": return this.doClose();
      default:
        return { ok: false, code: "config_error", reason: "unknown request type" };
    }
  }

  private doOpen(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.openInner(req, "open");
  }

  /**
   * goto：受控导航原语——与 open **同一条实现**（openInner → `ctx.open` →
   * `CtxRuntime.navigate` 单一判定：hosts 信封前置检查、goto(domcontentloaded)、
   * unreachable/config_error 结构化分类、落地后 302 跨主机拒绝、PageState settled）。
   * 不带 referer 参数（`page.goto` 的 referer 选项不用）：同源导航浏览器按自身策略自动带
   * referer；跨源 goto 携带旧页 referer 无收益还可能污染目标站的来源基线——保持与 open
   * 相同的裸 goto 形态。会话无 meta，entry-only 闸门对会话面恒放行（与 open 同口径）；
   * task-38 的 flap 监听与有界自愈对 goto 同样生效（同一 openInner 路径）。
   * 轨迹记 `type:"goto"`（session export 只认 open/mark/act 行，goto 行被如实跳过，
   * 导出的骨架不含导航步——作者按现场手写 `ctx.open`/`ctx.arrive`）。
   */
  private doGoto(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.openInner(req, "goto");
  }

  private async openInner(req: Record<string, unknown>, op: "open" | "goto"): Promise<Record<string, unknown>> {
    const url = req["url"];
    if (!nonEmpty(url)) {
      return { ok: false, code: "config_error", reason: `${op} needs a non-empty url string` };
    }
    const timeoutMs = intIn(req["timeoutMs"], 1, 120_000);
    const ctx = this.ctx();
    const page = await this.page();
    // task-38：主 frame 导航监听。挂在 ctx.open **之前**——flap 若在 goto 返回与挂监听
    // 之间的几毫秒里启动，挂晚了就看不见第一批事件；判定按 ts>=openEnd 过窗，goto 期间的
    // 正常重定向天然不计入（「正常重定向 1-2 次绝不触发」）。没有 .on 的页面对象（非 Playwright 替身）
    // 直接跳过检测，响应形状不变。启动自动 open 与每次显式 open 走同一条路径。
    const navs: NavEvent[] = [];
    const pw = page as unknown as {
      on?: (ev: string, fn: (frame: unknown) => void) => unknown;
      off?: (ev: string, fn: (frame: unknown) => void) => unknown;
      mainFrame?: () => unknown;
    };
    const onNav = (frame: unknown): void => {
      try {
        if (typeof pw.mainFrame !== "function" || frame !== pw.mainFrame()) return;
        const f = frame as { url?: () => string } | null;
        if (f === null || typeof f.url !== "function") return;
        navs.push({ ts: Date.now(), url: f.url() });
      } catch { /* 事件回调里绝不抛 */ }
    };
    if (typeof pw.on === "function") pw.on("framenavigated", onNav);
    try {
      await ctx.open(url, timeoutMs === undefined ? {} : { timeoutMs });
      const openEnd = Date.now();
      const flap = await this.watchFlap(navs, openEnd);
      let heal: FlapHealResult | null = null;
      if (flap !== null) heal = await this.healFlap(page, flap, navs);
      const landed = urlOf(page) || ctx.url() || String(url);
      // A5：落地路径形状事实（additive；形状保留 = 零新键）。只陈述、不改 ok 语义。
      const landing = landedNavigationFacts(String(url), landed);
      const landingFacts = landing.reason === "" ? landing.facts : { ...landing.facts, reason: landing.reason };
      this.urls.push(landed);
      const title = await this.titleOf();
      this.log(`${op} ${landed}${title === undefined ? "" : ` — ${title}`}`);
      // Phase 2：入口页是导出骨架的 `meta.site.pages.entry` 来源（open 也是轨迹的一部分）。
      this.recordEvent({
        type: op, url: landed, ...(title === undefined ? {} : { title }),
        ...(flap === null ? {} : { flap: { navigations: flap.navigations, healed: heal?.healed === true } }),
      });
      // 正常页（未判定 flap）：响应与改动前**逐字节一致**——零新字段、除静默早退窗口外零额外等待。
      if (flap === null) {
        return { ok: true, url: landed, ...(title === undefined ? {} : { title }), hosts: this.hosts ?? [], ...landingFacts };
      }
      // 判定 flap → 只增诊断字段（healed:false → ok:false 如实报；有界自愈只试一次，不再重试）。
      const healed = heal?.healed === true;
      this.log(`${op} flap detected: ${flap.navigations} main-frame navigations in ${flap.window_ms}ms, healed=${healed}`);
      return {
        ok: healed,
        url: landed,
        ...(title === undefined ? {} : { title }),
        hosts: this.hosts ?? [],
        code: "navigation_flapping",
        navigations: flap.navigations,
        window_ms: flap.window_ms,
        urls_sample: flap.urls_sample,
        healed,
        ...(heal === null ? {} : { heal_url: heal.heal_url }),
        reason: healed
          ? `主 frame 在 ${flap.window_ms}ms 内导航 ${flap.navigations} 次、URL 在 ${flap.urls_sample.length} 种形态间反复（客户端 URL flap，期间 DOM 读取不可靠）；已自愈：重新导航到 ${heal?.heal_url} 后复察窗口无 flap`
          : `主 frame 在 ${flap.window_ms}ms 内导航 ${flap.navigations} 次、URL 在 ${flap.urls_sample.length} 种形态间反复（客户端 URL flap，期间 DOM 读取不可靠）${heal?.reason === undefined ? "" : `；${heal.reason}`}`,
        suggestion: "改用编码标题 URL 直开（把标题百分比编码进路径）或稍后重试；flap 期间 read/signal 可能读到空 DOM",
      };
    } finally {
      if (typeof pw.off === "function") { try { pw.off("framenavigated", onNav); } catch { /* 收尾失败不影响结论 */ } }
    }
  }

  /**
   * task-38：flap 观察窗口。open 返回后观察 `FLAP_WINDOW_MS`：
   * - 窗口内一条主 frame 导航都没有 → 静默早退（稳定页：零新字段，只付静默等待）；
   * - 一旦出现 post-open 导航（可疑）→ 观察满整个窗口，再判 `judgeFlapNavs` 严格签名。
   * 返回 null = 不是 flap（open 响应零新字段）。
   */
  private async watchFlap(navs: NavEvent[], openEnd: number): Promise<FlapJudgement | null> {
    const deadline = openEnd + FLAP_WINDOW_MS;
    for (;;) {
      const now = Date.now();
      if (now >= deadline) break;
      if (navs.some((n) => n.ts >= openEnd)) { await sleepMs(deadline - now); break; }
      if (now >= openEnd + FLAP_QUIET_EXIT_MS) return null;
      await sleepMs(Math.min(50, deadline - now));
    }
    const postOpen = navs.filter((n) => n.ts >= openEnd);
    return judgeFlapNavs(postOpen, FLAP_WINDOW_MS);
  }

  /**
   * task-38：一次**有界**自愈——导航到编码形态 URL（判不出就用最后一次 framenavigated
   * 的 URL），等 DCL + settle，再观察一个完整复察窗口；仍 flap → healed:false 如实报
   * （**不再重试**）。自愈走裸 `page.goto`（不经 ctx.navigate）：目标 URL 来自本页刚观察
   * 到的导航形态并过 hosts 信封检查；它是有界诊断动作，不改写 ctx 的导航账。
   */
  private async healFlap(page: AnyPage, flap: FlapJudgement, navs: NavEvent[]): Promise<FlapHealResult> {
    const healUrl = encodedFormUrl(flap.urls_sample) ?? flap.last_url;
    const deny = disallowedHost(healUrl, this.hosts);
    if (deny !== null) {
      return { healed: false, heal_url: healUrl, reason: `自愈目标 ${healUrl} 在 hosts 信封外（${deny}），不尝试` };
    }
    try {
      await page.goto(healUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_GOTO_TIMEOUT_MS });
    } catch (e) {
      return { healed: false, heal_url: healUrl, reason: `自愈导航失败: ${errMsg(e)}` };
    }
    await sleepMs(FLAP_HEAL_SETTLE_MS);
    const rewatchStart = Date.now();
    await sleepMs(FLAP_WINDOW_MS);
    const still = judgeFlapNavs(navs.filter((n) => n.ts >= rewatchStart), FLAP_WINDOW_MS);
    return still === null
      ? { healed: true, heal_url: healUrl }
      : { healed: false, heal_url: healUrl, reason: `自愈后仍 flap（复察窗口再次命中签名，navigations=${still.navigations}）——有界自愈只试一次，不再重试` };
  }

  private async doObserve(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const opts = {
      ...(req["max"] === undefined ? {} : { max: req["max"] as number }),
      ...(req["selector"] === undefined || req["selector"] === null ? {} : { selector: req["selector"] as string }),
      ...(req["includeHidden"] === undefined ? {} : { includeHidden: req["includeHidden"] as boolean }),
      ...(req["includeFrames"] === undefined ? {} : { includeFrames: req["includeFrames"] as boolean }),
      // B 批：结构证据 opt-in（桥 `include_structure` → 请求字段 includeStructure）。
      ...(req["includeStructure"] === undefined ? {} : { includeStructure: req["includeStructure"] as boolean }),
    };
    // 形状校验与 $ 上下文同一份实现（非法值 = config_error，不做静默截断）。
    const result = await this.ctx().observe(opts as never);
    // task-34：elements 本来就包含可达子 frame 的行（每行带 `frame` 下标）；这里在多 frame
    // 时补一条**只增**的 per-frame 计数摘要（单 frame 页面不出现 → 缺省产物逐字节不变）。
    const extra: Record<string, unknown> = {};
    if (result.ok && Array.isArray(result.frames) && result.frames.length > 1) {
      const rows = Array.isArray(result.elements) ? result.elements : [];
      extra["frame_counts"] = result.frames.map((url, index) => ({
        index, url, elements: rows.filter((e) => (e as { frame?: number }).frame === index).length,
      }));
    }
    // 空元素时的就绪事实（additive）：有元素 = 零探测零新键，缺省响应逐字节不变。
    Object.assign(extra, await observeReadiness(await this.page(), result));
    return { ...result, ...extra };
  }

  private async doAct(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const op = req["op"];
    if (typeof op !== "string" || !(SESSION_ACT_OPS as readonly string[]).includes(op)) {
      return {
        ok: false, code: "config_error",
        reason: `act.op must be one of ${SESSION_ACT_OPS.join(" | ")} (got ${JSON.stringify(op)})`,
        allowed_ops: [...SESSION_ACT_OPS],
      };
    }
    const actOp = op as SessionActOp;
    // A2：本行歧义策略 = 请求字段 onAmbiguous（桥逐调用透传）> 会话旗标/缺省 fail。
    // 非法值 = 结构化 config_error（与其它请求字段同一形状校验纪律，不静默取缺省）。
    const ambiguousMode = ambiguityMode(req, this.opts.onAmbiguous);
    if (ambiguousMode === null) {
      return {
        ok: false, code: "config_error",
        reason: `act.onAmbiguous must be one of fail | act (got ${JSON.stringify(req["onAmbiguous"])})`,
        allowed_modes: ["fail", "act"],
      };
    }
    // F72：rehydrateRescan 是显式 opt-in（缺省不出现 = 既有行为逐字节不变）；非法值 = 结构化
    // config_error（与 onAmbiguous 同一纪律，不静默取缺省）。
    if (req["rehydrateRescan"] !== undefined && req["rehydrateRescan"] !== true) {
      return {
        ok: false, code: "config_error",
        reason: `act.rehydrateRescan must be true when present (got ${JSON.stringify(req["rehydrateRescan"])})`,
      };
    }
    const rehydrateRescan = req["rehydrateRescan"] === true;
    const targetRaw = req["target"];
    const page = await this.page();
    this.actionCount += 1;
    const started = Date.now();
    // Phase 2：开记录时先做一次**只读**观察，取"同一个 hintMatch 自证"的候选（export 的每步
    // observe_hints 来源）。没开记录 = 一次也不多付；观察失败/未命中就如实缺字段。
    const recordHints = await this.hintsForRecord(nonEmpty(targetRaw) ? String(targetRaw) : undefined);

    // ---- scroll：合成目标（document/body/html/window）走 mw.scrollDocument；元素目标走 actOnce
    //      （B2：带 to/by = 容器滚动，不带 = 滚入视口且 changed 实测 moved）；
    //      S1：`rows` 字段 = 行容器寻址（匹配行的最近可滚动祖先，与 collect 同一份判定）。
    //      执行体整段在 session-act-scroll.ts（doAct 的存量行数只减不增）。----
    if (actOp === "scroll") {
      const to = req["to"];
      if (to !== undefined && to !== "bottom" && to !== "top" && to !== "page") {
        return { ok: false, code: "config_error", reason: `scroll.to must be one of bottom | top | page (got ${JSON.stringify(to)})` };
      }
      const toDir = to as "bottom" | "top" | "page" | undefined;
      const by = req["by"] === undefined ? undefined : intIn(req["by"], -1_000_000, 1_000_000);
      // S1：rows 与 target 互斥（滚动语义的第三种 target 形态，不是 hint；缺省不出现 = 行为不变）。
      const rowsSel = req["rows"];
      if (rowsSel !== undefined) {
        if (!nonEmpty(rowsSel)) {
          return { ok: false, code: "config_error", reason: "scroll.rows must be a non-empty CSS selector string when present" };
        }
        if (nonEmpty(targetRaw)) {
          return { ok: false, code: "config_error", reason: "scroll takes either target (hint) or rows (CSS selector), not both" };
        }
        if (toDir === undefined && by === undefined) {
          return { ok: false, code: "config_error", reason: "scroll.rows needs to (bottom|top|page) or by (pixels)" };
        }
      }
      return await doActScroll(req, actOp, toDir, by,
        rowsSel === undefined ? undefined : String(rowsSel), targetRaw, ambiguousMode,
        rehydrateRescan, recordHints, {
          page, hosts: this.hosts, outDir: this.outDir, actionCount: this.actionCount,
          startedAt: started, log: (l) => this.log(l),
          recordAction: (e) => this.recordAction(e),
          mw: () => this.mw(), ctx: () => this.ctx(),
        });
    }

    if (!nonEmpty(targetRaw)) {
      return { ok: false, code: "config_error", reason: `act op '${actOp}' needs a non-empty target (hint string)` };
    }
    const target = String(targetRaw);

    // ---- set_range：滑杆设值原语（与 ctx.setRange 同一条 mw.setRange / range.ts 三策略；
    //      越界 = value_out_of_range 零动作，绝不假装成功）。执行体在 session-act-range.ts
    //      （doAct 存量行数只减不增）。----
    if (actOp === "set_range") {
      return await doActSetRange(target, req["value"], {
        page, startedAt: started, mw: () => this.mw(), log: (l) => this.log(l),
        recordAction: (e) => this.recordAction(e), actionCount: () => this.actionCount,
      });
    }

    // 值只来自请求本身（authoring 面的"人给的决定"）；不发明取值（红线②的同一条纪律：
    // 缺值 = needs_value，绝不猜）。
    let bind: { value: unknown; byValue?: boolean } | null = null;
    if (actOp === "fill" || actOp === "select") {
      if (req["value"] === undefined) {
        return { ok: false, code: "needs_value", reason: `act op '${actOp}' needs a value`, op: actOp, target, executed: false };
      }
      bind = { value: req["value"] };
    }

    const mw = this.mw();
    // task-34：清场后执行（B1 旁路只在本次解析写；见 scroll 分支同一注释）。
    takeHintMatchOthers();
    // B1：click/check 的缺失证据由动作本身给出（`occludedReason` 探针即点击，无双点窗口）。
    // fill/select/hover 与 run 面走同一条既有路径（不传第 7 参）。
    const wantOcclusion = actOp === "click" || actOp === "check";
    const out = actOp === "hover"
      ? await mw.actOnce(page, target, "hover", null, ambiguousMode, undefined,
        { diagnostics: true, ...(rehydrateRescan ? { rehydrateRescan: true } : {}) })
      : await mw.actOnce(page, target, actOp, bind, ambiguousMode, undefined,
        wantOcclusion
          ? { occlusionProbe: true, diagnostics: true, ...(rehydrateRescan ? { rehydrateRescan: true } : {}) }
          : { diagnostics: true, ...(rehydrateRescan ? { rehydrateRescan: true } : {}) });
    // 解析证据在 take 后立刻读取（observeAfter 会再次触发 hintMatch，不能放在它之后）。
    const amb = actAmbiguity(target, out.ref, out.stopCode);
    this.recordAction({
      op: actOp, target,
      ...(actOp === "fill" || actOp === "select"
        ? {
          value_hash: sha256(String(req["value"])).slice(0, 12),
          value_len: String(req["value"]).length,
          ...(this.opts.recordValues === true ? { value: String(req["value"]) } : {}),
        }
        : {}),
      ok: out.ok === true,
      ...(out.ok === true ? {} : { code: String(out.stopCode ?? "action_failed") }),
      ref: out.ref ?? null,
      how: out.how ?? null,
      changed: out.changed === true,
      url: urlOf(page),
      ...ambiguityRecord(out.ambiguity),
      ...(recordHints.length > 0 ? { observe_hints: recordHints } : {}),
    });
    if (out.ok !== true) {
      // E4：落空/被遮挡失败时的 overlay 证据（只读一次；不消散——是否关遮罩由作者决定）。
      // 仅这两个停因做归因探测：target_not_found（目标可能被遮罩挡在池外/视口外）、
      // not-actionable-or-covered（中心点已被盖住）。其余停因（stale_ref、action_failed…）
      // 与遮罩无归因关系，不多付这次页面往返。
      const wantOverlay = out.stopCode === "target_not_found" || out.stopCode === "not-actionable-or-covered";
      const overlay = wantOverlay ? await this.mw().overlayEvidence(page) : null;
      // S4：落空时的最近命中提示（纯内存；独立键 recently_resolved，不覆盖引擎 A4 的
      // diagnostics；无记录 = 键不出现，响应键集不变）。
      const recent = out.stopCode === "target_not_found" ? this.recentResolutions.hint(target, this.actionCount) : { diag: {}, reasonLine: "" };
      // F6：歧义/落空时**一次**有界宽扫（≤128；零动作）——把全量候选与自证 hint 回传给作者
      // 再决定（收窄 hint / 换锚点 / 滚动取证）。additive 证据面：键只在这两个停因出现，
      // 其余响应键集与旧产物逐字节不变；绝不点击/滚动/重试（宽扫不是动作，不改变页面）。
      const wantWide = out.stopCode === "target_not_found" || out.stopCode === "target_ambiguous";
      const wide = wantWide ? await wideScanCandidates(page, this.hosts) : null;
      return {
        ok: false, code: String(out.stopCode ?? "action_failed"),
        reason: String(out.reason ?? "") + recent.reasonLine + closedSetReasonSuffix(out.stopCode),
        op: actOp, target, executed: false,
        ...actionabilityResponse(out.actionability),
        ...executionStateResponse(out.execution_state),
        ...(out.ref === undefined ? {} : { ref: out.ref }),
        url: urlOf(page), elapsed_ms: Date.now() - started,
        ...(await failureScreenshot(this.outDir, (l) => this.log(l), page, this.actionCount, req)),
        ...(overlay !== null && overlay.length > 0 ? { overlay } : {}),
        ...(wide !== null ? { wide_scan: wide } : {}),
        ...amb,
        ...ambiguityResponse(out.ambiguity),
        ...missDiagnosticsResponse(out.diagnostics), ...shapeProblemResponse(out.diagnostics?.shape_problem),
        ...recent.diag,
      };
    }
    this.log(`act ${actOp} ${JSON.stringify(target)} → ${String(out.how)} changed=${out.changed === true}`);
    // S4：成功解析进 LRU——同 target 后续落空时的"最近命中过"引导事实。
    this.recentResolutions.remember(target, this.actionCount, actOp, String(out.how ?? ""));
    // S3：opt-in 的同标签页导航事实探测（缺省不出现 = 零额外等待、键集不变）。
    // 只报事实不判完成——`same_tab_navigation` 不是 done 信号，与 waitFor/signal 不冒充。
    // 成功路径专属：失败现场证据已有自己的归因面，不做这次探测。
    if (req["navProbeMs"] !== undefined && (typeof req["navProbeMs"] !== "number" || !Number.isInteger(req["navProbeMs"]) || req["navProbeMs"] < 100 || req["navProbeMs"] > 3000)) {
      return { ok: false, code: "config_error", reason: `act.navProbeMs must be an integer in [100, 3000] (got ${JSON.stringify(req["navProbeMs"])})` };
    }
    const navProbeMs = typeof req["navProbeMs"] === "number" ? req["navProbeMs"] : undefined;
    let navFacts: Record<string, unknown> = {};
    if (navProbeMs !== undefined && out.probe_navigated !== true) {
      const probe = await navProbeFacts(page, (p) => urlOf(p), navProbeMs, sleepMs);
      navFacts = probe.facts;
      if (probe.to !== probe.from) {
        this.urls.push(probe.to);
        // S3：导航事实进轨迹（recordEvent 与 mark 同流；这是动作的**后续观察**，不是第二个动作）。
        this.recordEvent({ type: "nav_probe", target, nav_from: probe.from, nav_to: probe.to });
      }
    }
    return {
      ok: true, op: actOp, target, executed: true,
      ref: out.ref ?? null, how: displayHow(actOp, out.how), changed: out.changed === true,
      url: urlOf(page), elapsed_ms: Date.now() - started,
      ...(out.probe_navigated === true ? { probe_navigated: true } : {}),
      ...navFacts,
      // E1-c：`#id` 直查兜底命中的解析通道证据（additive；其余路径键集不变）。
      ...(out.resolved_via === undefined ? {} : { resolved_via: out.resolved_via }),
      ...missDiagnosticsResponse(out.diagnostics), ...amb,
      ...(await observeAfter(this.ctx(), req)),
    };
  }

  /**
   * task-34：把 B1 的弱档命中旁路（`rules.takeHintMatchOthers`，与 run 面 matched_others 警告
   * **同一份**收集逻辑）摊到 act 响应上——歧义与否 / 其余撞词候选（≤3，池 ref + tag + class 首段
   * + label≤40）/ 弱档形状标记。只读诊断：不改解析结果、不改选择语义。
   *
   * 纪律：模块态由"最后一次解析者"写，所以调用方必须**先清场、再执行、立刻 take**，并用
   * `diag.hint === target` 做同一条 hint 的相等性校验（与执行器消费 B1 时同款防陈旧）。
   * `chosenRef` = 会话实际执行的那个元素：从 matched_others 里排除（别人 = "除选中者外的撞词
   * 候选"）；池外回退时 diag/ref 都是合成 ref（`pN`），仍如实回显并在文档写明。
   */
  private async doExtract(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const rows = req["rows"];
    if (!nonEmpty(rows)) {
      return { ok: false, code: "config_error", reason: "extract needs a non-empty rows CSS selector string" };
    }
    const fields = req["fields"];
    if (!isObj(fields) || Object.keys(fields).length === 0) {
      return { ok: false, code: "config_error", reason: "extract needs a non-empty fields object {name: css | \".\" | \"@attr\" | \"@self\"}" };
    }
    // `@` 取属性是闭集（真实 HTML 属性 + 伪属性 @self，`@self` = 行可见文本并归一成 "."）：
    // 未知名字在入口就是 config_error，不再静默给空串（区分「页面没内容」与「字段名写错」）。
    const fieldsCheck = normalizeExtractFields(fields as Record<string, unknown>);
    if (!fieldsCheck.ok) {
      return { ok: false, code: "config_error", reason: extractFieldsReason(fieldsCheck.problems), problems: fieldsCheck.problems };
    }
    const cellFields = fieldsCheck.fields;
    const maxItems = intIn(req["maxItems"], 1, 500);
    const cap = maxItems ?? 500;
    // C1：offset = 续页起点（0-based 整数 0..10000）。非整数/越界 = config_error，
    // 绝不 clamp——悄悄改分页起点会让「续页不重不漏」变成假话。
    const rawOffset = req["offset"];
    if (rawOffset !== undefined
      && (typeof rawOffset !== "number" || !Number.isInteger(rawOffset) || rawOffset < 0 || rawOffset > 10_000)) {
      return {
        ok: false, code: "config_error",
        reason: `extract.offset must be an integer in [0, 10000] (got ${JSON.stringify(rawOffset)})`,
      };
    }
    const offset = typeof rawOffset === "number" ? rawOffset : 0;
    // 稳定读证据（三态编排与门本身都在 session-runtime-evidence；这里只接线）：
    // 缺省双指标门 → settled（判不了 = false + settle_reason:"read_failed"）、opt-out → 仅
    // scroll_settled、settle:"off" → 两键都不出现。抽取照常发生，超窗/判不了不无界等。
    if (req["waitSettled"] !== undefined && typeof req["waitSettled"] !== "boolean") {
      return { ok: false, code: "config_error", reason: `extract.waitSettled must be a boolean (got ${JSON.stringify(req["waitSettled"])})` };
    }
    this.extractStats.total = 0;
    const settle = await extractSettleEvidence(this.settleDisabled(), req["waitSettled"] as boolean | undefined,
      () => this.page(), this.hosts, String(rows));
    // inline 形态：与 meta.site.listExtract 的声明走同一个 `ctx.extract` → `readRows` 实现
    //（MVP 只接 inline；named 需要 app pack，见 design §7）。
    let out: Array<Record<string, string>>;
    try {
      out = await this.ctx().extract({
        rows, fields: cellFields, maxItems: cap,
      }, { offset });
    } catch (e) {
      // C2：非法选择器在 readRows 入口以 config_error + diagnostics.bad_selector 抛出。
      // 会话面**复用 observe 的口径**：响应带 error:"bad_selector"（不新增 stopCode；
      // 合法但零命中仍走下面的 [] 成功响应）。
      const diag = e instanceof StopError && isObj(e.diagnostics) ? e.diagnostics["bad_selector"] : undefined;
      if (diag === undefined) throw e;
      return {
        ok: false, code: (e as StopError).code, error: "bad_selector", reason: (e as StopError).message,
        diagnostics: { bad_selector: diag },
      };
    }
    const count = out.length;
    const capped = count >= cap;
    const total = this.extractStats.total;
    // S2：空行事实（恒带——只是"本页返回行里所有字段都是空串的行数"，不猜骨架/未渲染，
    // 判读权在调用方）。先在本页行集合上数（零页面往返）；rowStats 读不到时再探测一次。
    let blankRows = out.filter((r) => Object.values(r).every((v) => String(v ?? "").trim() === "")).length;
    if (settle.settled === false) {
      const stats = await rowStatsAnyFrame(await this.page(), String(rows),
        this.hosts === null ? undefined : { hosts: this.hosts });
      if (stats !== null) blankRows = stats.blank;
    }
    return {
      ok: true, rows: out, count, capped, max_items: cap,
      // 空行事实（恒带——懒渲染页与"真没有值"的判别面；settled:false 时以全帧
      // rowStats 的空行数为准，不只数本页已 cap 的行）。
      blank_rows: blankRows,
      // 稳定读证据（引擎给才有：缺省门恒带 settled；判不了另带 settle_reason；opt-out 只有
      // scroll_settled；settle:"off" 两键都不出现——键集与既有各路径一致）。
      ...(settle.settled === undefined ? {} : { settled: settle.settled }),
      ...(settle.settle_reason === undefined ? {} : { settle_reason: settle.settle_reason }),
      ...(settle.scroll_settled === undefined ? {} : { scroll_settled: settle.scroll_settled }),
      // C1：分页事实只在「本页被 cap 挡住」或「offset>0」时出现——旧响应键集不变。
      ...(capped || offset > 0
        ? { offset, total, has_more: offset + count < total }
        : {}),
    };
  }

  /** E5：`meta.policy.settle === "off"`（会话构造时已知）= 跳过滚动稳定判定。 */
  private settleDisabled(): boolean {
    return this.opts.settle === "off";
  }

  private async doSnapshot(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const page = await this.page();
    this.snapshotCount += 1;
    const n = this.snapshotCount;
    ensureDir(this.outDir);
    const snap = await this.mw().snapshot(page);
    const poolMax = intIn(req["poolMax"], 1, 200) ?? 120;
    let pool: ElemPool = {};
    try {
      pool = await extractElements(page as unknown as PageLike, true, poolMax, this.hosts === null ? {} : { hosts: this.hosts });
    } catch (e) {
      this.log(`snapshot pool extraction failed: ${errMsg(e)}`);
    }
    const snapshotFile = path.join(this.outDir, `snapshot-${n}.json`);
    // §15 断言面：快照响应 additive 带 `window`（windowAudit 一次只读 evaluate 的有界证据）
    // ——池外可见交互与被剔账（dedup_dropped）经会话面可达，桥面据此透传。评估失败 =
    // windowAudit 内部兜底返回零值事实（池证据文件仍在，计数如实为 0）。
    let windowAuditBlock: Record<string, unknown> | undefined;
    try {
      windowAuditBlock = await windowAudit(page as unknown as PageLike, Object.keys(pool).length, 10) as unknown as Record<string, unknown>;
    } catch {
      windowAuditBlock = undefined;
    }
    // B3：可勾选控件状态签名一并落盘（有界；无此类控件时字段缺席 ⇒ 旧产物逐字节不变）。
    const checks = snap.checks === undefined ? "" : snap.checks.slice(0, 4000);
    const snapFrames = snap.frames.map((f) => (
      f.checks === undefined ? f : { ...f, checks: f.checks.slice(0, 1200) }
    ));
    fs.writeFileSync(snapshotFile, `${JSON.stringify({
      url: snap.url, title: snap.title, text: snap.text, vals: snap.vals,
      ...(checks ? { checks } : {}), frames: snapFrames,
    }, null, 2)}\n`, "utf-8");
    const poolFile = path.join(this.outDir, `pool-${n}.json`);
    fs.writeFileSync(poolFile, `${JSON.stringify(pool, null, 2)}\n`, "utf-8");
    let screenshotFile: string | undefined;
    if (req["screenshot"] !== false) {
      const target = path.join(this.outDir, `snapshot-${n}.png`);
      try {
        const shot = (page as unknown as { screenshot?: (o: Record<string, unknown>) => Promise<unknown> }).screenshot;
        if (typeof shot === "function") {
          await shot.call(page, { path: target, fullPage: false });
          screenshotFile = target;
        }
      } catch (e) {
        this.log(`snapshot screenshot failed: ${errMsg(e)}`);
      }
    }
    this.log(`snapshot #${n} → ${snapshotFile}`);
    return {
      ok: true, n, url: snap.url, title: snap.title,
      snapshot_file: snapshotFile, pool_file: poolFile,
      ...(screenshotFile === undefined ? {} : { screenshot_file: screenshotFile }),
      ...(windowAuditBlock !== undefined ? { window: windowAuditBlock } : {}),
      counts: { pool: Object.keys(pool).length, text_chars: snap.text.length, frames: snap.frames.length },
    };
  }

  private doMark(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const note = req["note"];
    if (!nonEmpty(note)) {
      return Promise.resolve({ ok: false, code: "config_error", reason: "mark needs a non-empty note string" });
    }
    this.recordMark(note);
    this.log(`mark: ${note}`);
    return Promise.resolve({ ok: true, note });
  }

  /** `tab` 处理体的注入面（处理体在 session-ops-extra.ts；会话 holder/计数/轨迹流仍归本类）。 */
  private tabOpDeps(): TabOpDeps {
    return {
      hosts: this.hosts,
      ensureSession: () => this.ensureSession(),
      urls: this.urls,
      bumpActionCount: () => { this.actionCount += 1; },
      recordAction: (e) => this.recordAction(e),
      log: (l) => this.log(l),
    };
  }

  /** pilot 驾驶的注入面：宿主会话（同一 BrowserSession/page）+ 会话 runId（响应 join key）。 */
  private driverFor(): SessionPilotDriver {
    this.driver ??= new SessionPilotDriver({
      runId: this.runId,
      hosts: this.hosts,
      env: this.opts.env,
      session: () => this.ensureSession(),
    });
    return this.driver;
  }

  private async doClose(): Promise<Record<string, unknown>> {
    const summary = {
      ok: true, closed: true,
      requests: this.requestCount, actions: this.actionCount, snapshots: this.snapshotCount,
      duration_ms: Date.now() - this.startedAt,
      urls: this.urls.slice(-20),
      evidence_dir: this.outDir,
      ...(this.opts.record === null || this.opts.record === undefined ? {} : { record: path.resolve(this.opts.record) }),
    };
    // close 收口（BACKLOG §14）：close 请求本身即"会话终结"——摘要在本调用内先算好，
    // 随后完成浏览器终止与句柄清理，**不依赖外层有入口循环替它收尾**。泄漏形态核查结论：
    // CLI 行循环与桥子进程两条真实路径本就经入口 finally 走 finish（探针实证 exit 0、
    // chromium 零残留）；泄漏只存在于"无入口循环的直调 dispatch 驱动"（一次性 embedder，
    // 探针实证事件循环不退出）。把 finish 收进 close 语义后，三种驱动都自然收口；
    // finish 幂等（finished 旗标），入口 finally 的再次调用是无害 no-op，两条真实路径
    // 行为不变。
    await this.finish("closed");
    return summary;
  }

  /* ---------------------------------------------------------------- 收尾 */

  /** 会话结束：写 trace/轨迹收尾并关闭浏览器（幂等；所有退出路径都经过它）。 */
  async finish(exit: SessionExit): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    // trace 只在 --record 时落盘（避免交互会话在用户目录里留无主文件）。
    if (this.traceRef !== null && this.opts.record !== null && this.opts.record !== undefined) {
      try {
        const traceFile = `${path.resolve(this.opts.record)}.trace.json`;
        writeTrace(traceFile, this.traceRef);
        this.log(`session trace → ${traceFile}`);
      } catch (e) {
        this.log(`trace write failed: ${errMsg(e)}`);
      }
    }
    if (this.recordStream !== null) {
      try { this.recordStream.end(); } catch { /* 关流失败不影响结论 */ }
      this.recordStream = null;
    }
    const session = this.holder.session;
    this.holder.session = null;
    if (session !== null) {
      try {
        // 关会话前清章（与 runScriptApp 同一收尾纪律：旧章不该跨会话残留）。
        try { await session.page.evaluate(() => { /* no-op：保留收尾钩子的形状 */ }); } catch { /* 页面已死 */ }
        await session.close();
      } catch (e) {
        this.log(`browser close failed: ${errMsg(e)}`);
      }
    }
    this.log(`session closed (${exit}, ${this.requestCount} request(s), ${Date.now() - this.startedAt}ms)`);
  }
}

