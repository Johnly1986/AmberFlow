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
import { amberflowHome, ensureDir } from "../support/amberflow-home.ts";
import { sleepMs } from "../support/sleep.ts";
import { inputsSha256, newTrace, sha256, writeTrace, type AppTrace } from "./trace.ts";
import { MockAuditor } from "../engine/audit.ts";
import {
  BrowserMiddleware, browserSession, disallowedHost,
  type ActionabilityDetail, type ActMissDiagnostics, type AnyPage, type BrowserSession,
} from "../engine/executor.ts";
import {
  extractElements, urlOf, type ElemPool, type PageLike,
} from "../engine/extraction.ts";
import { signalProblemText, validateSignalSpec } from "../engine/signals.ts";
// task-34（B1 旁路复用）：与 run 面**同一个**弱档命中诊断（`rules.hintMatchImpl` 的模块态），
// 会话只 take 出来回显，不改选择语义、不改 run 面任何代码。
import { takeHintMatchOthers } from "../engine/rules.ts";
import { DEFAULT_SETTLE } from "../engine/settle.ts";
import type { AmbiguityView } from "../engine/ambiguity.ts";

/** `act` 的 MVP 能力面（执行器里 drag/upload/clickAt 也有，但 authoring MVP 不暴露）。 */
export const SESSION_ACT_OPS = ["click", "check", "fill", "select", "hover", "scroll"] as const;
export type SessionActOp = (typeof SESSION_ACT_OPS)[number];

/**
 * `act scroll` 两条路径（合成目标 = `mw.scrollDocument`，元素目标 = `mw.actOnce`）的共同
 * 返回形状（B2 起含实测滚动证据）。两边都是"引擎给什么就有什么"，所以全部可选——会话层
 * 只**回显**，不补算 moved/delta。
 */
interface SessionScrollOut {
  ok: boolean;
  stopCode?: string;
  reason?: string;
  ref?: string;
  moved?: boolean;
  delta?: number;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  ambiguity?: AmbiguityView;
  /** A4：落空（`target_not_found`）判别证据；引擎给才有。 */
  diagnostics?: ActMissDiagnostics;
}

/** 请求类型闭集（未知 type = 结构化 config_error + 这张表）。 */
export const SESSION_REQUEST_TYPES = [
  "open", "observe", "act", "read", "extract", "waitFor", "signal", "snapshot", "mark", "close",
] as const;

/** 缺省 idle 超时（两次请求之间的静默上限）。 */
export const SESSION_DEFAULT_IDLE_TIMEOUT_MS = 300_000;
/** 单行请求上限。 */
export const SESSION_DEFAULT_MAX_REQUEST_BYTES = 1_048_576;

/* ---------------------- task-38：导航 flap 检测与有界自愈 ---------------------- */

/** flap 观察窗口（open 返回后 / 自愈落地后各观察一次的时长）。 */
export const FLAP_WINDOW_MS = 1_500;
/**
 * 静默早退：open 返回后这么久仍**没有**主 frame 导航 → 稳定页，立刻放行响应（零新字段）。
 * 阈值必须大于「flap 页首次客户端导航的延迟」——zh.wikipedia 文章页实测 ~0.37–0.9s
 * （task38/ROOT-CAUSE.md probe-nav）、本地 fixture 250ms——取 600ms 可盖住两者实测下界；
 * 代价是稳定页 open 多等 ~600ms（任务书原文写 ≤100ms，实测对照见 task38/assert-results，
 * 常数是单点可调项，由 lead 裁决）。稳定页一旦在窗口内出现任何 post-open 导航，
 * 就放弃早退、观察满整个窗口再判严格签名。
 */
export const FLAP_QUIET_EXIT_MS = 600;
/** 自愈导航落地（DCL）后的 settle 等待，之后开复察窗口。 */
export const FLAP_HEAL_SETTLE_MS = 500;

/** 一条主 frame 导航事件（flap 检测的原始观察）。 */
export interface NavEvent { ts: number; url: string }

/** flap 判定结果（严格签名，见 `judgeFlapNavs`）。 */
export interface FlapJudgement {
  navigations: number;
  window_ms: number;
  /** 去重后的导航形态样例（≤5，保持首次出现顺序）。 */
  urls_sample: string[];
  /** 窗口内最后一次主 frame 导航的 URL（自愈兜底目标）。 */
  last_url: string;
}

/** 一次有界自愈的结果。 */
export interface FlapHealResult {
  healed: boolean;
  heal_url: string;
  reason?: string;
}

const urlOriginOf = (u: string): string => { try { return new URL(u).origin; } catch { return ""; } };
const urlPathOf = (u: string): string => { try { return new URL(u).pathname; } catch { return ""; } };
const stripFragment = (u: string): string => { const i = u.indexOf("#"); return i >= 0 ? u.slice(0, i) : u; };

/**
 * 共同 path 前缀：逐字符 LCP，完全相同则原样返回，否则回退到最后一个 "/"。
 * 返回 null = 没有非平凡前缀（如 "/a" 与 "/b" 只共出 "/"——那不是同一页面在翻形态）。
 */
function commonPathPrefix(paths: string[]): string | null {
  if (paths.length === 0) return null;
  let lcp = paths[0]!;
  for (const p of paths.slice(1)) {
    let i = 0;
    while (i < lcp.length && i < p.length && lcp[i] === p[i]) i += 1;
    lcp = lcp.slice(0, i);
    if (lcp === "") return null;
  }
  if (paths.every((p) => p === lcp)) return lcp;
  const cut = lcp.lastIndexOf("/");
  return cut > 0 ? lcp.slice(0, cut + 1) : null;
}

/**
 * task-38：主 frame 导航序列是否构成「URL flap」（**严格**触发签名）：
 *   1.5s 窗口内 ≥4 次主 frame 导航，且 URL 在 ≥2 种形态间反复交替——
 *   同一 origin、同一 path 前缀、去重后 ≥2 个 URL、至少一个形态出现 ≥2 次
 *   （A↔B 交替满足；正常重定向 1-2 次不满足次数；单向重定向链每个 URL 只出现一次，
 *   不满足「反复」；刷新同一 URL 不满足「≥2 形态」）。
 * 返回 null = 不是 flap。
 */
export function judgeFlapNavs(seq: NavEvent[], windowMs: number): FlapJudgement | null {
  if (seq.length < 4) return null;
  const urls = seq.map((n) => stripFragment(n.url));
  const distinct = [...new Set(urls)];
  if (distinct.length < 2) return null;
  if (new Set(distinct.map(urlOriginOf)).size !== 1) return null;
  const prefix = commonPathPrefix(distinct.map(urlPathOf));
  if (prefix === null || prefix.length <= 1) return null;
  if (!distinct.some((u) => urls.filter((x) => x === u).length >= 2)) return null;
  return {
    navigations: seq.length,
    window_ms: windowMs,
    urls_sample: distinct.slice(0, 5),
    last_url: urls[urls.length - 1]!,
  };
}

/**
 * task-38：自愈目标 URL——优先「编码形态」（path 含百分比编码，如 zh.wikipedia 的
 * /wiki/%E8…；实测编码标题 URL 直开是稳定的），判不出编码形态就用最后一次
 * framenavigated 的 URL。
 */
function encodedFormUrl(urls: string[]): string | null {
  for (const u of urls) {
    try {
      const p = new URL(u).pathname;
      if (p.includes("%") && decodeURIComponent(p) !== p) return u;
    } catch { /* 坏 URL 不候选 */ }
  }
  return null;
}

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
  /**
   * `--record-values`（缺省 false）：轨迹里 fill/select 除 `value_hash` 外**再记明文 `value`**。
   * 安全取舍：轨迹可能被复制进仓库/`app.mjs`，所以明文只由作者显式 opt-in；缺省恒 hash。
   */
  recordValues?: boolean;
  /** 从文件读请求而不是 stdin（`--input`；Windows 管道不可靠时用）。 */
  inputFile?: string | null;
  /**
   * A2：`act` 的缺省歧义策略（`--on-ambiguous`）。
   *   - `"fail"`（缺省）：命令步同一个歧义谓词成立时**零动作** → 结构化 `target_ambiguous`
   *     + 有界 `ambiguity` 证据（会话不再"随便点第一个候选"）；
   *   - `"act"`：恢复旧行为（`resolveCommandRef` 可行动优先取 refs[0] 直接执行）。
   * 单行请求可用 `onAmbiguous` 覆盖本次（见 `doAct`）。
   */
  onAmbiguous?: "fail" | "act";
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
  /**
   * C1：extract 的总量观测口（**只有会话面注入**；run/dry/replay 不注入、产物不变）。
   * `ctx.extract` 的返回类型仍是行数组，分页所需的 `total` 经这个对象回写。
   */
  private readonly extractStats: { total: number } = { total: 0 };
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
    const page = await this.page();
    // task-38：主 frame 导航监听。挂在 ctx.open **之前**——flap 若在 goto 返回与挂监听
    // 之间的几毫秒里启动，挂晚了就看不见第一批事件；判定按 ts>=openEnd 过窗，goto 期间的
    // 正常重定向天然不计入（「正常重定向 1-2 次绝不触发」）。没有 .on 的假页面（测试桩）
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
      this.urls.push(landed);
      const title = await this.titleOf();
      this.log(`open ${landed}${title === undefined ? "" : ` — ${title}`}`);
      // Phase 2：入口页是导出骨架的 `meta.site.pages.entry` 来源（open 也是轨迹的一部分）。
      this.recordEvent({
        type: "open", url: landed, ...(title === undefined ? {} : { title }),
        ...(flap === null ? {} : { flap: { navigations: flap.navigations, healed: heal?.healed === true } }),
      });
      // 正常页（未判定 flap）：响应与改动前**逐字节一致**——零新字段、除静默早退窗口外零额外等待。
      if (flap === null) {
        return { ok: true, url: landed, ...(title === undefined ? {} : { title }), hosts: this.hosts ?? [] };
      }
      // 判定 flap → 只增诊断字段（healed:false → ok:false 如实报；有界自愈只试一次，不再重试）。
      const healed = heal?.healed === true;
      this.log(`open flap detected: ${flap.navigations} main-frame navigations in ${flap.window_ms}ms, healed=${healed}`);
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
      await page.goto(healUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
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
    const ambiguousMode = this.ambiguityMode(req);
    if (ambiguousMode === null) {
      return {
        ok: false, code: "config_error",
        reason: `act.onAmbiguous must be one of fail | act (got ${JSON.stringify(req["onAmbiguous"])})`,
        allowed_modes: ["fail", "act"],
      };
    }
    const targetRaw = req["target"];
    const page = await this.page();
    const hosts = this.hosts ?? undefined;
    this.actionCount += 1;
    const started = Date.now();
    // Phase 2：开记录时先做一次**只读**观察，取"同一个 hintMatch 自证"的候选（export 的每步
    // observe_hints 来源）。没开记录 = 一次也不多付；观察失败/未命中就如实缺字段。
    const recordHints = await this.hintsForRecord(nonEmpty(targetRaw) ? String(targetRaw) : undefined);

    // ---- scroll：合成目标（document/body/html/window）走 mw.scrollDocument；元素目标走 actOnce
    //      （B2：带 to/by = 容器滚动，不带 = 滚入视口且 changed 实测 moved）----
    if (actOp === "scroll") {
      const to = req["to"];
      if (to !== undefined && to !== "bottom" && to !== "top" && to !== "page") {
        return { ok: false, code: "config_error", reason: `scroll.to must be one of bottom | top | page (got ${JSON.stringify(to)})` };
      }
      const toDir = to as "bottom" | "top" | "page" | undefined;
      const by = req["by"] === undefined ? undefined : intIn(req["by"], -1_000_000, 1_000_000);
      const synthetic = !nonEmpty(targetRaw) || isSyntheticScrollTarget(String(targetRaw));
      // B2：to/by 是**容器滚动**语义（元素自身或最近可滚动祖先，与 ctx.scrollList 同一条实现
      // `_scrollWithLoc`；找不到可滚动容器 = not_scrollable，不静默无操作）。不给 to/by =
      // 旧语义「把元素滚入视口」，但 moved/delta 由引擎实测（不再硬编码 changed:true）。
      const wantsContainer = toDir !== undefined || by !== undefined;
      // task-34：B1 旁路是**模块态**（最后一次解析者写）——先清场，避免把 record 观察或上一次
      // 动作的诊断算到本次头上。元素 scroll 仍走 hint 解析，故同样回显歧义。
      takeHintMatchOthers();
      const out: SessionScrollOut = synthetic
        ? await this.mw().scrollDocument(
          (await this.ensureSession()).page, toDir ?? "bottom",
          { ...(by === undefined ? {} : { by }) },
        )
        : await this.mw().actOnce(page, String(targetRaw), "scroll", null, ambiguousMode,
          wantsContainer ? { ...(toDir === undefined ? {} : { to: toDir }), ...(by === undefined ? {} : { by }) } : undefined,
          { diagnostics: true });
      const scrollAmb = synthetic ? {} : this.actAmbiguity(String(targetRaw), out.ref ?? null);
      // A2：只有元素 scroll（actOnce 分支）可能带歧义证据；合成目标走 scrollDocument，没有该键。
      const scrollAmbiguity: AmbiguityView | undefined = out.ambiguity;
      const scrollTarget = nonEmpty(targetRaw) ? String(targetRaw) : "document";
      // B2：滚动语义进轨迹（export 需要它才知道该还原成哪种原语；旧轨迹没有这个键）。
      const scrollMode: "container" | "into_view" = synthetic || wantsContainer ? "container" : "into_view";
      // B2：changed = **实测** moved（没有 moved 证据 = false，不假装滚过）。
      const moved = typeof out.moved === "boolean" ? out.moved : undefined;
      const delta = typeof out.delta === "number" ? out.delta : undefined;
      const scrollTop = typeof out.scrollTop === "number" ? out.scrollTop : undefined;
      this.recordAction({
        op: "scroll", target: scrollTarget,
        // B2：只记**实际发生的事实**——没走通的滚动不记方向/语义；没请求 to/by 的元素滚动
        // 不再伪记 to:"bottom"（旧实现把"滚入视口"记成一次方向滚动）。
        ...(out.ok === true ? { scroll_mode: scrollMode } : {}),
        ...(out.ok === true && wantsContainer
          ? { ...(toDir === undefined ? {} : { to: toDir }), ...(by === undefined ? {} : { by }) }
          : {}),
        ok: out.ok === true,
        ...(out.ok === true ? {} : { code: String(out.stopCode ?? "not_scrollable") }),
        ref: null, how: out.ok === true ? "scrolled" : null,
        changed: moved === true,
        ...(moved === undefined ? {} : { moved }),
        ...(delta === undefined ? {} : { delta }),
        ...(scrollTop === undefined ? {} : { scrollTop }),
        url: urlOf(page),
        ...this.ambiguityRecord(scrollAmbiguity),
        ...(recordHints.length > 0 ? { observe_hints: recordHints } : {}),
      });
      if (out.ok !== true) {
        return {
          ok: false, code: String(out.stopCode ?? "not_scrollable"), reason: String(out.reason ?? "scroll failed"),
          op: actOp, target: scrollTarget, executed: false,
          ...scrollAmb,
          ...this.ambiguityResponse(scrollAmbiguity),
          ...this.missDiagnosticsResponse(out.diagnostics),
          ...(await this.failureScreenshot(page, this.actionCount, req)),
        };
      }
      const scroll = typeof scrollTop === "number"
        && typeof out.scrollHeight === "number" && typeof out.clientHeight === "number"
        ? { scrollTop, scrollHeight: out.scrollHeight, clientHeight: out.clientHeight }
        : undefined;
      return {
        ok: true, op: actOp, target: scrollTarget,
        executed: true, ref: null, how: "scrolled",
        changed: moved === true,
        ...(moved === undefined ? {} : { moved }),
        ...(delta === undefined ? {} : { delta }),
        ...(scroll === undefined ? {} : { scroll }),
        url: urlOf(page), elapsed_ms: Date.now() - started,
        ...scrollAmb,
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
    // task-34：清场后执行（B1 旁路只在本次解析写；见 scroll 分支同一注释）。
    takeHintMatchOthers();
    // B1：click/check 的缺失证据由动作本身给出（`occludedReason` 探针即点击，无双点窗口）。
    // fill/select/hover 与 run 面走同一条既有路径（不传第 7 参）。
    const wantOcclusion = actOp === "click" || actOp === "check";
    const out = actOp === "hover"
      ? await mw.actOnce(page, target, "hover", null, ambiguousMode, undefined, { diagnostics: true })
      : await mw.actOnce(page, target, actOp, bind, ambiguousMode, undefined,
        wantOcclusion ? { occlusionProbe: true, diagnostics: true } : { diagnostics: true });
    // 解析证据在 take 后立刻读取（observeAfter 会再次触发 hintMatch，不能放在它之后）。
    const amb = this.actAmbiguity(target, out.ref);
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
      ...this.ambiguityRecord(out.ambiguity),
      ...(recordHints.length > 0 ? { observe_hints: recordHints } : {}),
    });
    if (out.ok !== true) {
      return {
        ok: false, code: String(out.stopCode ?? "action_failed"),
        reason: String(out.reason ?? ""), op: actOp, target, executed: false,
        ...(out.ref === undefined ? {} : { ref: out.ref }),
        url: urlOf(page), elapsed_ms: Date.now() - started,
        ...this.actionabilityResponse(out.actionability),
        ...(await this.failureScreenshot(page, this.actionCount, req)),
        ...amb,
        ...this.ambiguityResponse(out.ambiguity),
        ...this.missDiagnosticsResponse(out.diagnostics),
      };
    }
    this.log(`act ${actOp} ${JSON.stringify(target)} → ${String(out.how)} changed=${out.changed === true}`);
    return {
      ok: true, op: actOp, target, executed: true,
      ref: out.ref ?? null, how: this.displayHow(actOp, out.how), changed: out.changed === true,
      url: urlOf(page), elapsed_ms: Date.now() - started,
      ...(out.probe_navigated === true ? { probe_navigated: true } : {}),
      ...amb,
      ...(await this.observeAfter(req)),
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
  private actAmbiguity(target: string, chosenRef: string | null | undefined): Record<string, unknown> {
    const diag = takeHintMatchOthers();
    if (diag === null || diag.hint !== target) return {};
    const others = diag.candidates
      .filter((c) => c.ref !== diag.decided && c.ref !== chosenRef)
      .slice(0, 3);
    return {
      ambiguous: diag.candidates.length > 1,
      ...(others.length === 0
        ? {}
        : {
          matched_others: others.map((c) => ({
            ref: c.ref, tag: c.tag, class: c.class, label: c.label,
          })),
        }),
      // 只有弱档（词前缀/词包含、loose 子串）才值得提示"可能是容器/同缀元素"。
      ...(diag.suspicious ? { hint_kind: diag.kind, hint_tier: diag.tier, hint_suspicious: true } : {}),
    };
  }

  /**
   * A2：本行 `act` 的歧义策略（`"fail"` = 缺省，歧义即零动作；`"act"` = 旧行为）。
   * 优先级：请求字段 `onAmbiguous`（桥逐调用透传）> 会话旗标 `--on-ambiguous` > 缺省 fail。
   * 返回 null = 请求字段是非法值（调用方报结构化 config_error，不静默取缺省）。
   */
  private ambiguityMode(req: Record<string, unknown>): "fail" | "act" | null {
    const raw = req["onAmbiguous"];
    if (raw === undefined || raw === null) return this.opts.onAmbiguous === "act" ? "act" : "fail";
    return raw === "fail" || raw === "act" ? raw : null;
  }

  /**
   * A2：歧义停因进 `--record` 轨迹的最小记账（`code` 已由调用方记录）：
   * 候选 ref（≤5）+ 总集大小。没开记录时 `recordAction` 本身是 no-op。
   */
  private ambiguityRecord(amb: AmbiguityView | undefined): Record<string, unknown> {
    if (amb === undefined) return {};
    return {
      candidate_refs: amb.candidates.map((c) => c.ref).slice(0, 5),
      candidates_total: amb.candidates_total,
    };
  }

  /** A2：失败响应上的 `ambiguity` 证据（只有引擎真的给了才出现；成功响应键集不变）。 */
  private ambiguityResponse(amb: AmbiguityView | undefined): Record<string, unknown> {
    return amb === undefined ? {} : { ambiguity: amb };
  }

  /**
   * task-34：会话面的执行证据词按动作语义回显（`select` → `selected`）。
   *
   * 为什么只在会话面映射、不改执行器：`how` 是 run 的 `executed_actions`/trace 共享产物，
   * 改引擎词会让既有应用的产物变化（task-34 红线：缺省参数下产物逐字节不变）。所以引擎词
   * 保持 `filled`（选择/填写同一个动作结果词），会话这一层按 op 精确化——文档已写明。
   */
  private displayHow(op: SessionActOp, how: unknown): unknown {
    if (op === "select" && how === "filled") return "selected";
    return how ?? null;
  }

  /**
   * B1：act 失败响应上的 `actionability` 证据（引擎给才有；成功响应键集不变）。
   * 原样复用引擎的 `ActionabilityDetail`（reason/bbox/blocker/requery），会话层不重算、不补键。
   */
  private actionabilityResponse(detail: ActionabilityDetail | undefined): Record<string, unknown> {
    return detail === undefined ? {} : { actionability: detail };
  }

  /**
   * A4：act 落空（`target_not_found`）的判别证据在会话面的回显。
   *
   * 引擎已按上限构造（`candidates` ≤5 / `near` ≤5 / `rejected` ≤3、label ≤40、why 只在有原因
   * 时出现），会话层**原样**回显——与 `actionabilityResponse` 同一纪律：不重算、不补键。
   * 没有该字段（成功路径 / 非落空失败）= 响应键集与之前逐字节一致。
   */
  private missDiagnosticsResponse(diag: ActMissDiagnostics | undefined): Record<string, unknown> {
    return diag === undefined ? {} : { diagnostics: diag };
  }

  /**
   * B1：act 失败时的**opt-in**截图（请求 `screenshot:true` 才写；缺省不碰页面）。
   * 文件落会话证据目录 `act-<n>-failure.png`（n = 本次会话的动作序号），响应只回
   * `screenshot_file` 路径，不内联图片。截图失败只记日志，不改变动作失败事实。
   */
  private async failureScreenshot(page: AnyPage, n: number, req: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (req["screenshot"] !== true) return {};
    const file = path.join(this.outDir, `act-${n}-failure.png`);
    try {
      const shot = (page as unknown as {
        screenshot?: (o: Record<string, unknown>) => Promise<unknown>;
      }).screenshot;
      if (typeof shot !== "function") return {};
      ensureDir(this.outDir);
      await shot.call(page, { path: file, fullPage: false });
      this.log(`act failure screenshot #${n} → ${file}`);
      return { screenshot_file: file };
    } catch (e) {
      this.log(`act failure screenshot failed: ${errMsg(e)}`);
      return {};
    }
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
    this.extractStats.total = 0;
    // inline 形态：与 meta.site.listExtract 的声明走同一个 `ctx.extract` → `readRows` 实现
    //（MVP 只接 inline；named 需要 app pack，见 design §7）。
    let out: Array<Record<string, string>>;
    try {
      out = await this.ctx().extract({
        rows, fields: fields as Record<string, string>, maxItems: cap,
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
    return {
      ok: true, rows: out, count, capped, max_items: cap,
      // C1：分页事实只在「本页被 cap 挡住」或「offset>0」时出现——旧响应键集不变。
      ...(capped || offset > 0
        ? { offset, total, has_more: offset + count < total }
        : {}),
    };
  }

  private signalSpec(req: Record<string, unknown>): { ok: true; spec: Record<string, unknown> } | { ok: false; resp: Record<string, unknown> } {
    const spec = req["signal"];
    const problems = validateSignalSpec(spec, "signal");
    if (problems.length > 0) {
      // C3：reason 与 CLI/加载期**同一份**合法形态提示（json 版示例串）；problems 数组原样。
      return { ok: false, resp: { ok: false, code: "config_error", reason: signalProblemText(problems, "json"), problems } };
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
      // Windows/PowerShell 的 UTF-8 **带 BOM** 文件会让第一行的 JSON 解析失败（实测：
      // `Set-Content -Encoding UTF8` 的 --input 文件）。BOM 不是请求内容，剥掉它；
      // 只有行首这一个字符可能受影响，其余行逐字节不变。
      const raw = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
      if (raw.trim() === "") { arm(); continue; }
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      const stop = await rt.handleLine(raw);
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
