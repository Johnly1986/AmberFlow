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
import readline from "node:readline";
import { createCtx, isSyntheticScrollTarget, StopError, type Ctx } from "./ctx.ts";
import { amberflowHome, ensureDir } from "./amberflow-home.ts";
import { inputsSha256, newTrace, sha256, writeTrace, type AppTrace } from "./trace.ts";
import { MockAuditor } from "../engine/audit.ts";
import {
  BrowserMiddleware, browserSession, type AnyPage, type BrowserSession,
} from "../engine/executor.ts";
import {
  extractElements, urlOf, type ElemPool, type PageLike,
} from "../engine/extraction.ts";
import { validateSignalSpec } from "../engine/signals.ts";
import { DEFAULT_SETTLE } from "../engine/settle.ts";

/** `act` 的 MVP 能力面（执行器里 drag/upload/clickAt 也有，但 authoring MVP 不暴露）。 */
export const SESSION_ACT_OPS = ["click", "check", "fill", "select", "hover", "scroll"] as const;
export type SessionActOp = (typeof SESSION_ACT_OPS)[number];

/** 请求类型闭集（未知 type = 结构化 config_error + 这张表）。 */
export const SESSION_REQUEST_TYPES = [
  "open", "observe", "act", "read", "extract", "waitFor", "signal", "snapshot", "mark", "close",
] as const;

/** 缺省 idle 超时（两次请求之间的静默上限）。 */
export const SESSION_DEFAULT_IDLE_TIMEOUT_MS = 300_000;
/** 单行请求上限。 */
export const SESSION_DEFAULT_MAX_REQUEST_BYTES = 1_048_576;

export interface SessionOptions {
  /** 启动后自动 open 的入口页（`--url`）。 */
  url?: string | null;
  /** 导航信封（`--host`/`--hosts`；缺省从 `--url` 推断）。 */
  hosts?: string[] | null;
  headful?: boolean;
  /** 证据落点（缺省 `$AMBERFLOW_HOME/session/<runId>`）。 */
  outDir?: string | null;
  /** 动作轨迹 JSONL 落点（`--record`；给了才写）。 */
  record?: string | null;
  /** 从文件读请求而不是 stdin（`--input`；Windows 管道不可靠时用）。 */
  inputFile?: string | null;
  idleTimeoutMs?: number;
  maxRequestBytes?: number;
  verbose?: boolean;
  quiet?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** 输出面：`respond` 一行一个 JSON 对象（stdout）；`log` 人话（stderr）。 */
export interface SessionSink {
  respond(obj: Record<string, unknown>): void;
  log(line: string): void;
}

/** 会话收尾原因（决定退出码）。 */
export type SessionExit = "closed" | "eof" | "idle_timeout" | "browser_dead" | "interrupted";

/** 退出码：0 干净关闭 / 1 不可恢复 / 3 被挡住（idle 超时）。用完即弃的会话不是"失败"。 */
export function sessionExitCode(exit: SessionExit): number {
  if (exit === "closed" || exit === "eof") return 0;
  if (exit === "idle_timeout") return 3;
  return 1;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split("\n")[0]!.slice(0, 400);
}

/** 浏览器/页面已不可复用（唯一的会话级升级判据；其余失败都只是单行失败）。 */
function isDeadPageError(msg: string): boolean {
  return /Target page, context or browser has been closed|Target closed|browser has been closed|Browser has been closed|Session closed|Page closed|has been disconnected/i.test(msg);
}

function intIn(v: unknown, lo: number, hi: number): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

/**
 * 一条持续会话。生命周期：`start()`（可选自动 open）→ `handleLine()` 逐行 →
 * `finish()`（写 trace/轨迹收尾 + 关浏览器）。每条失败只产出一个 `ok:false` 响应，
 * 只有"页面已死"会把会话升级终止。
 */
export class SessionRuntime {
  readonly runId: string;
  readonly outDir: string;
  private readonly opts: SessionOptions;
  private readonly sink: SessionSink;
  private readonly hosts: string[] | null;
  private readonly maxRequestBytes: number;

  private readonly holder: { session: BrowserSession | null } = { session: null };
  private readonly mwHolder: { current: BrowserMiddleware | null } = { current: null };
  private readonly ctxHolder: { current: Ctx | null } = { current: null };
  private traceRef: AppTrace | null = null;
  private recordStream: fs.WriteStream | null = null;

  private readonly startedAt = Date.now();
  private requestCount = 0;
  private actionCount = 0;
  private snapshotCount = 0;
  private readonly urls: string[] = [];
  private finished = false;

  constructor(opts: SessionOptions, sink: SessionSink, runId?: string) {
    this.opts = opts;
    this.sink = sink;
    this.runId = runId ?? `${Date.now().toString(36)}-${process.pid}`;
    this.hosts = opts.hosts && opts.hosts.length > 0 ? [...opts.hosts] : null;
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
      this.log(`starting ${this.opts.headful === true ? "headful" : "headless"} browser`);
      this.holder.session = await browserSession(this.opts.headful !== true, null);
    }
    return this.holder.session;
  }

  /** 执行器：与 `runScriptApp` 同一个构造模板；不注入任何决策 provider（auditor 是 Mock）。 */
  private mw(): BrowserMiddleware {
    if (this.mwHolder.current === null) {
      this.mwHolder.current = new BrowserMiddleware({
        modelId: "english",
        auditor: new MockAuditor(),
        hosts: this.hosts,
        maxSteps: 8,
        reobserve: true,
        // S2 稳定门：与 run 的缺省档一致（抽池前等页面静默）。
        settle: DEFAULT_SETTLE,
      });
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

  /** 轨迹文件句柄（懒创建；`--record` 没给 = no-op）。Phase 2：一条轨迹要能被 export 还原成骨架。 */
  private recordStreamFor(): fs.WriteStream | null {
    if (this.opts.record === null || this.opts.record === undefined) return null;
    if (this.recordStream !== null) return this.recordStream;
    try {
      ensureDir(path.dirname(path.resolve(this.opts.record)));
      this.recordStream = fs.createWriteStream(path.resolve(this.opts.record), { flags: "a", encoding: "utf8" });
      return this.recordStream;
    } catch (e) {
      this.log(`record open failed: ${errMsg(e)}`);
      return null;
    }
  }

  /** 轨迹里的非动作事件（open / mark）：`export` 需要入口页与人工标记。 */
  private recordEvent(entry: Record<string, unknown>): void {
    const stream = this.recordStreamFor();
    if (stream === null) return;
    try {
      stream.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
    } catch (e) {
      this.log(`record write failed: ${errMsg(e)}`);
    }
  }

  /** 动作轨迹（`--record`）：只记**已发生的事实**；fill/select 的值只落 hash（design §5/Q5）。 */
  private recordAction(entry: Record<string, unknown>): void {
    const stream = this.recordStreamFor();
    if (stream === null) return;
    try {
      stream.write(`${JSON.stringify({ i: this.actionCount, ts: new Date().toISOString(), ...entry })}\n`);
    } catch (e) {
      this.log(`record write failed: ${errMsg(e)}`);
    }
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
    if (this.hosts !== null) this.log(`hosts envelope: ${this.hosts.join(", ")}`);
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
    switch (req["type"]) {
      case "open": return this.doOpen(req);
      case "observe": return this.doObserve(req);
      case "act": return this.doAct(req);
      case "read": return this.doRead(req);
      case "extract": return this.doExtract(req);
      case "waitFor": return this.doWaitFor(req);
      case "signal": return this.doSignal(req);
      case "snapshot": return this.doSnapshot(req);
      case "mark": return this.doMark(req);
      case "close": return this.doClose();
      default:
        return { ok: false, code: "config_error", reason: "unknown request type" };
    }
  }

  private doOpen(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.openInner(req);
  }

  private async openInner(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = req["url"];
    if (!nonEmpty(url)) {
      return { ok: false, code: "config_error", reason: "open needs a non-empty url string" };
    }
    const timeoutMs = intIn(req["timeoutMs"], 1, 120_000);
    const ctx = this.ctx();
    await ctx.open(url, timeoutMs === undefined ? {} : { timeoutMs });
    const landed = ctx.url();
    if (landed) this.urls.push(landed);
    const title = await this.titleOf();
    this.log(`open ${landed}${title === undefined ? "" : ` — ${title}`}`);
    // Phase 2：入口页是导出骨架的 `meta.site.pages.entry` 来源（open 也是轨迹的一部分）。
    this.recordEvent({ type: "open", url: landed, ...(title === undefined ? {} : { title }) });
    return { ok: true, url: landed, ...(title === undefined ? {} : { title }), hosts: this.hosts ?? [] };
  }

  private async doObserve(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const opts = {
      ...(req["max"] === undefined ? {} : { max: req["max"] as number }),
      ...(req["selector"] === undefined || req["selector"] === null ? {} : { selector: req["selector"] as string }),
      ...(req["includeHidden"] === undefined ? {} : { includeHidden: req["includeHidden"] as boolean }),
      ...(req["includeFrames"] === undefined ? {} : { includeFrames: req["includeFrames"] as boolean }),
    };
    // 形状校验与 $ 上下文同一份实现（非法值 = config_error，不做静默截断）。
    const result = await this.ctx().observe(opts as never);
    return { ...result };
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
    const targetRaw = req["target"];
    const page = await this.page();
    const hosts = this.hosts ?? undefined;
    this.actionCount += 1;
    const started = Date.now();
    // Phase 2：开记录时先做一次**只读**观察，取"同一个 hintMatch 自证"的候选（export 的每步
    // observe_hints 来源）。没开记录 = 一次也不多付；观察失败/未命中就如实缺字段。
    const recordHints = await this.hintsForRecord(nonEmpty(targetRaw) ? String(targetRaw) : undefined);

    // ---- scroll：合成目标（document/body/html/window）走 mw.scrollDocument，元素目标走 actOnce ----
    if (actOp === "scroll") {
      const to = req["to"];
      if (to !== undefined && to !== "bottom" && to !== "top" && to !== "page") {
        return { ok: false, code: "config_error", reason: `scroll.to must be one of bottom | top | page (got ${JSON.stringify(to)})` };
      }
      const by = req["by"] === undefined ? undefined : intIn(req["by"], -1_000_000, 1_000_000);
      const synthetic = !nonEmpty(targetRaw) || isSyntheticScrollTarget(String(targetRaw));
      const out = synthetic
        ? await this.mw().scrollDocument(
          (await this.ensureSession()).page, (to as "bottom" | "top" | "page" | undefined) ?? "bottom",
          { ...(by === undefined ? {} : { by }) },
        )
        : await this.mw().actOnce(page, String(targetRaw), "scroll", null);
      const scrollTarget = nonEmpty(targetRaw) ? String(targetRaw) : "document";
      this.recordAction({
        op: "scroll", target: scrollTarget, to: (to as string | undefined) ?? "bottom",
        ...(by === undefined ? {} : { by }),
        ok: out.ok === true,
        ...(out.ok === true ? {} : { code: String(out.stopCode ?? "not_scrollable") }),
        ref: null, how: out.ok === true ? "scrolled" : null,
        changed: "moved" in out ? out.moved === true : out.ok === true,
        url: urlOf(page),
        ...(recordHints.length > 0 ? { observe_hints: recordHints } : {}),
      });
      if (out.ok !== true) {
        return {
          ok: false, code: String(out.stopCode ?? "not_scrollable"), reason: String(out.reason ?? "scroll failed"),
          op: actOp, target: scrollTarget, executed: false,
        };
      }
      const scroll = "scrollTop" in out
        ? { scrollTop: out.scrollTop, scrollHeight: out.scrollHeight, clientHeight: out.clientHeight }
        : undefined;
      return {
        ok: true, op: actOp, target: scrollTarget,
        executed: true, ref: null, how: "scrolled",
        changed: "moved" in out ? out.moved === true : true,
        ...(scroll === undefined ? {} : { scroll }),
        url: urlOf(page), elapsed_ms: Date.now() - started,
        ...(await this.observeAfter(req)),
      };
    }

    if (!nonEmpty(targetRaw)) {
      return { ok: false, code: "config_error", reason: `act op '${actOp}' needs a non-empty target (hint string)` };
    }
    const target = String(targetRaw);

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
    const out = actOp === "hover"
      ? await mw.actOnce(page, target, "hover", null)
      : await mw.actOnce(page, target, actOp, bind);
    this.recordAction({
      op: actOp, target,
      ...(actOp === "fill" || actOp === "select"
        ? { value_hash: sha256(String(req["value"])).slice(0, 12), value_len: String(req["value"]).length }
        : {}),
      ok: out.ok === true,
      ...(out.ok === true ? {} : { code: String(out.stopCode ?? "action_failed") }),
      ref: out.ref ?? null,
      how: out.how ?? null,
      changed: out.changed === true,
      url: urlOf(page),
      ...(recordHints.length > 0 ? { observe_hints: recordHints } : {}),
    });
    if (out.ok !== true) {
      return {
        ok: false, code: String(out.stopCode ?? "action_failed"),
        reason: String(out.reason ?? ""), op: actOp, target, executed: false,
        ...(out.ref === undefined ? {} : { ref: out.ref }),
        url: urlOf(page), elapsed_ms: Date.now() - started,
      };
    }
    this.log(`act ${actOp} ${JSON.stringify(target)} → ${String(out.how)} changed=${out.changed === true}`);
    return {
      ok: true, op: actOp, target, executed: true,
      ref: out.ref ?? null, how: out.how ?? null, changed: out.changed === true,
      url: urlOf(page), elapsed_ms: Date.now() - started,
      ...(await this.observeAfter(req)),
    };
  }

  /** 动作后的有界回读（缺省开）：只给 counts/url/title，不返回元素明细（明细请显式 observe）。 */
  private async observeAfter(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (req["observeAfter"] === false) return {};
    try {
      const result = await this.ctx().observe({ max: 40 });
      return {
        after: {
          url: result.url,
          counts: result.counts,
          truncated: result.truncated,
          ...(result.title === undefined ? {} : { title: result.title }),
        },
      };
    } catch {
      return {}; // 回读失败不影响动作事实（动作已经发生）
    }
  }

  private async doRead(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const what = req["what"];
    if (what !== "text" && what !== "value" && what !== "count" && what !== "attr") {
      return {
        ok: false, code: "config_error",
        reason: `read.what must be one of text | value | count | attr (got ${JSON.stringify(what)})`,
      };
    }
    const selector = req["selector"];
    if (!nonEmpty(selector)) {
      return { ok: false, code: "config_error", reason: "read needs a non-empty selector string" };
    }
    const ctx = this.ctx();
    if (what === "count") {
      const value = await ctx.read.count(selector);
      return { ok: true, what, selector, value };
    }
    if (what === "attr") {
      const attr = req["attr"];
      if (!nonEmpty(attr)) {
        return { ok: false, code: "config_error", reason: "read.what='attr' needs a non-empty attr string" };
      }
      const value = await ctx.read.attr(selector, attr);
      return { ok: true, what, selector, attr, value };
    }
    const value = what === "text" ? await ctx.read.text(selector) : await ctx.read.value(selector);
    return { ok: true, what, selector, value };
  }

  private async doExtract(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const rows = req["rows"];
    if (!nonEmpty(rows)) {
      return { ok: false, code: "config_error", reason: "extract needs a non-empty rows CSS selector string" };
    }
    const fields = req["fields"];
    if (!isObj(fields) || Object.keys(fields).length === 0) {
      return { ok: false, code: "config_error", reason: "extract needs a non-empty fields object {name: css | \".\" | \"@attr\"}" };
    }
    const maxItems = intIn(req["maxItems"], 1, 500);
    const cap = maxItems ?? 500;
    // inline 形态：与 meta.site.listExtract 的声明走同一个 `ctx.extract` → `readRows` 实现
    //（MVP 只接 inline；named 需要 app pack，见 design §7）。
    const out = await this.ctx().extract({
      rows, fields: fields as Record<string, string>, maxItems: cap,
    });
    return { ok: true, rows: out, count: out.length, capped: out.length >= cap, max_items: cap };
  }

  private signalSpec(req: Record<string, unknown>): { ok: true; spec: Record<string, unknown> } | { ok: false; resp: Record<string, unknown> } {
    const spec = req["signal"];
    const problems = validateSignalSpec(spec, "signal");
    if (problems.length > 0) {
      return { ok: false, resp: { ok: false, code: "config_error", reason: problems.join("；"), problems } };
    }
    return { ok: true, spec: spec as Record<string, unknown> };
  }

  private async doSignal(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const parsed = this.signalSpec(req);
    if (!parsed.ok) return parsed.resp;
    const started = Date.now();
    const held = await this.ctx().holds(parsed.spec as never);
    this.log(`signal held=${held}`);
    return { ok: true, held, elapsed_ms: Date.now() - started };
  }

  private async doWaitFor(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const parsed = this.signalSpec(req);
    if (!parsed.ok) return parsed.resp;
    const timeoutMs = intIn(req["timeoutMs"], 0, 600_000) ?? 15_000;
    const pollMs = intIn(req["pollMs"], 1, 60_000) ?? 200;
    const started = Date.now();
    const held = await this.ctx().waitFor(parsed.spec as never, { timeoutMs, pollMs });
    this.log(`waitFor held=${held} (${Date.now() - started}ms)`);
    return { ok: true, held, timeout_ms: timeoutMs, poll_ms: pollMs, elapsed_ms: Date.now() - started };
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
    fs.writeFileSync(snapshotFile, `${JSON.stringify({
      url: snap.url, title: snap.title, text: snap.text, vals: snap.vals, frames: snap.frames,
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

  private async doClose(): Promise<Record<string, unknown>> {
    const summary = {
      ok: true, closed: true,
      requests: this.requestCount, actions: this.actionCount, snapshots: this.snapshotCount,
      duration_ms: Date.now() - this.startedAt,
      urls: this.urls.slice(-20),
      evidence_dir: this.outDir,
      ...(this.opts.record === null || this.opts.record === undefined ? {} : { record: path.resolve(this.opts.record) }),
    };
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

/** 起会话 + 逐行驱动 + 收尾（stdin 或 `--input` 文件）。返回进程退出码。 */
export async function runSession(opts: SessionOptions, sink: SessionSink): Promise<number> {
  const rt = new SessionRuntime(opts, sink);
  const idleMs = intIn(opts.idleTimeoutMs, 0, 24 * 60 * 60 * 1000) ?? SESSION_DEFAULT_IDLE_TIMEOUT_MS;
  let exit: SessionExit = "eof";
  let idleFired = false;
  let interrupted = false;
  let rl: readline.Interface | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onInterrupt = (): void => { interrupted = true; rl?.close(); };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  try {
    await rt.start();
    const input = opts.inputFile !== null && opts.inputFile !== undefined
      ? fs.createReadStream(path.resolve(opts.inputFile), { encoding: "utf8" })
      : process.stdin;
    rl = opts.inputFile !== null && opts.inputFile !== undefined
      ? readline.createInterface({ input, crlfDelay: Infinity })
      : readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });

    const arm = (): void => {
      if (idleMs <= 0) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { idleFired = true; rl?.close(); }, idleMs);
    };
    arm();
    for await (const line of rl) {
      if (line.trim() === "") { arm(); continue; }
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      const stop = await rt.handleLine(line);
      if (stop) { exit = "closed"; break; }
      arm();
    }
    if (idleFired) {
      exit = "idle_timeout";
      sink.respond({
        type: "session_end", unsolicited: true, ok: false, code: "idle_timeout",
        reason: `no request for ${idleMs}ms (--idle-timeout-ms); closing`,
      });
    } else if (interrupted) {
      exit = "interrupted";
      sink.respond({ type: "session_end", unsolicited: true, ok: false, code: "interrupted", reason: "signal received" });
    }
  } catch (e) {
    exit = "browser_dead";
    sink.respond({
      type: "session_end", unsolicited: true, ok: false, code: "browser_dead",
      reason: errMsg(e),
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    rl?.close();
    await rt.finish(exit);
  }
  return sessionExitCode(exit);
}
