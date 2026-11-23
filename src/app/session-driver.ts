/**
 * `amber session` 内托管的 pilot 驾驶（SessionPilotDriver）——attach 驾驶面的组合层。
 *
 * 定位：session 是「人一行一行试探」的 authoring 面（act/observe 零模型）；pilot 是
 * 「决策模型逐步投票 + Agent 兜底」的走查面。本模块让 pilot 运行时**附着在会话自己的
 * page 上**驾驶，而不是像一次性 pilot 那样自建浏览器：
 *   - 宿主拥有浏览器（`ownsSession:false`）、起步不导航（`skipStartNavigation:true`），
 *     驾驶与 session 的 act/observe 共用同一个 page（停驶等兜底时人仍可手动补步，这是
 *     两条面的互证）；
 *   - pilot 事件经捕获式 sink 收成**有界** `events`（≤40 条、单条 ≤2KB），投影时剔除
 *     池/候选明细与槽值——会话响应不是证据文件的替代品，证据仍落 pilot 自己的目录；
 *   - 停因交接复用 pilot-contract 的闭集字段（stop_code/step_id/why_stuck/
 *     what_would_unblock），不在这里新增停因；
 *   - 每个响应都带 `session_id`（= SessionRuntime.runId），作为 session/桥/pilot 三面
 *     关联的 join key；同一 session 只托管一个 driver，driveUser 复用、driveClose 终结。
 *
 * 驾驶语义（模型只投票不生成、default-deny、值不猜、完成只认信号）全部仍在 PilotRuntime
 * 内生效；本层只做协议校验（契约面 helper）、生命周期状态机与响应投影。
 */
import path from "node:path";
import { amberflowHome } from "../support/amberflow-home.ts";
import type { AnyPage, BrowserSession } from "../engine/executor.ts";
import { urlOf } from "../engine/extraction.ts";
import {
  PILOT_AWAIT_PICK, type PilotHandoff, type PilotOptions, type PilotStopCode,
} from "./pilot-contract.ts";
import { PilotRuntime, type PilotSink } from "./pilot-runtime.ts";
import {
  driveCommandProblem, driveStartProblem, errMsg, isObj, nonEmpty,
} from "./session-runtime-contract.ts";

/** driver 的宿主面：由 SessionRuntime 注入（会话持有浏览器与 runId，本模块不另存一份）。 */
export interface SessionPilotDeps {
  /** 会话 runId（响应里的 `session_id` join key）。 */
  runId: string;
  /** 会话导航信封（null = 未声明，pilot 按当前页 host 推断）。 */
  hosts: string[] | null;
  env?: NodeJS.ProcessEnv;
  /** 宿主会话（惰性创建；会话当前的 page 就是驾驶现场）。 */
  session: () => Promise<BrowserSession>;
}

/** 事件缓冲上限与单条上限（会话响应里的事件是**有界证据**，不是完整轨迹）。 */
const MAX_EVENT_COUNT = 40;
const MAX_EVENT_BYTES = 2048;
const MAX_TEXT = 200;
const MAX_WHY = 400;
const MAX_HANDOFF_EVIDENCE_CHARS = 900;

const clip = (v: unknown, max = MAX_TEXT): string => {
  const text = typeof v === "string" ? v : String(v ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};

/** pilot_end 摘要里值得回给会话的字段（其余键不进事件投影）。 */
const PILOT_END_KEYS = [
  "ok", "stop_code", "steps", "max_steps", "model_asks", "rule_picks", "model_picks",
  "handoffs", "fallbacks", "driver", "aborted", "failed_asks", "cache", "url", "attached",
  "expect_url", "out_dir", "code", "reason", "last_error",
] as const;

/** 交接块的有界投影：只保留 pilot-contract 闭集字段；evidence 超限退化为键名清单。 */
export function projectHandoff(h: PilotHandoff): Record<string, unknown> {
  const why = h.why_stuck;
  const evidence = why.evidence ?? {};
  let boundedEvidence: Record<string, unknown> = evidence;
  try {
    if (JSON.stringify(evidence).length > MAX_HANDOFF_EVIDENCE_CHARS) {
      boundedEvidence = { truncated: true, keys: Object.keys(evidence).slice(0, 8) };
    }
  } catch {
    boundedEvidence = {};
  }
  const refs = h.evidence_refs ?? {};
  return {
    stop_code: h.stop_code,
    step_id: h.step_id,
    goal_digest: clip(h.goal_digest),
    why_stuck: { summary: clip(why.summary, MAX_WHY), evidence: boundedEvidence },
    what_would_unblock: (h.what_would_unblock ?? []).slice(0, 3).map((s) => clip(s, MAX_WHY)),
    evidence_refs: {
      ...(refs.screenshot === undefined ? {} : { screenshot: clip(refs.screenshot, MAX_WHY) }),
      ...(refs.dom === undefined ? {} : { dom: clip(refs.dom, MAX_WHY) }),
      ...(refs.pool_snapshot === undefined ? {} : { pool_snapshot: clip(refs.pool_snapshot, MAX_WHY) }),
      ...(refs.observe === undefined ? {} : { observe: clip(refs.observe, MAX_WHY) }),
    },
    url: clip(h.url),
  };
}

/** `started` 事件的有界投影（开车现场：附着与否、落在哪一页、证据目录）。 */
function projectStarted(obj: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "started",
    ok: obj["ok"] === true,
    ...(obj["attached"] === true ? { attached: true } : {}),
    ...(nonEmpty(obj["url"]) ? { url: clip(obj["url"]) } : {}),
    ...(nonEmpty(obj["out_dir"]) ? { out_dir: clip(obj["out_dir"], MAX_WHY) } : {}),
    ...(nonEmpty(obj["expect_url"]) ? { expect_url: clip(obj["expect_url"]) } : {}),
    ...(obj["code"] === undefined ? {} : { code: clip(obj["code"], 120) }),
    ...(obj["reason"] === undefined ? {} : { reason: clip(obj["reason"], MAX_WHY) }),
  };
}

/** `pilot_end` 摘要的有界投影（只回驱动事实，不回轨迹/证据内容）。 */
function projectPilotEnd(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PILOT_END_KEYS) {
    const value = obj[key];
    if (value === undefined) continue;
    if (typeof value === "string") out[key] = clip(value, 300);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (isObj(value) && JSON.stringify(value).length <= 300) out[key] = value;
  }
  return out;
}

/**
 * 单条 pilot 事件 → 会话事件投影。三条硬约束：不回池/候选/槽值、每条带 `pilot:true`、
 * 超过单条上限时退化为「类型 + 截断标记」而不是把大对象塞进响应。
 */
function projectEvent(obj: Record<string, unknown>): Record<string, unknown> {
  const type = typeof obj["type"] === "string" ? obj["type"] : "event";
  let out: Record<string, unknown>;
  if (type === "handoff") {
    const handoff = obj["handoff"];
    out = {
      type, pilot: true, unsolicited: true,
      ...(isObj(handoff) ? { handoff: projectHandoff(handoff as unknown as PilotHandoff) } : {}),
    };
  } else if (type === "step_request") {
    // agent 驾驶的候选投影：只回候选**条数**，明细留在 pilot 证据目录/会话 observe 面。
    out = {
      type, pilot: true, driver: obj["driver"], step: obj["step"], url: clip(obj["url"]),
      pool_size: obj["pool_size"],
      candidate_count: Array.isArray(obj["candidates"]) ? obj["candidates"].length : 0,
    };
  } else if (type === "started") {
    out = { ...projectStarted(obj), pilot: true };
  } else if (type === "pilot_end") {
    out = { type, pilot: true, ...projectPilotEnd(obj) };
  } else if (type === "log") {
    out = { type, pilot: true, line: clip(obj["line"], 300) };
  } else {
    out = { ...obj, pilot: true };
  }
  const bytes = Buffer.byteLength(JSON.stringify(out), "utf8");
  if (bytes <= MAX_EVENT_BYTES) return out;
  return { type, pilot: true, truncated: true, bytes };
}

/** 捕获式 sink：把 pilot 运行时写出的 JSONL 事件收成有界缓冲区（按拍取走给响应）。 */
class CaptureSink implements PilotSink {
  private readonly buffer: Array<Record<string, unknown>> = [];

  respond(obj: Record<string, unknown>): void {
    this.buffer.push(projectEvent(obj));
    if (this.buffer.length > MAX_EVENT_COUNT) this.buffer.shift();
  }

  /** 取走自上次取走以来的事件（响应里的事件是「本次调用产生的」，不是整段轨迹）。 */
  take(): Array<Record<string, unknown>> {
    return this.buffer.splice(0, this.buffer.length);
  }
}

/** 取 driver 的模型咨询数：provider 在场走它自己的计数，否则走 pilot 本面计数兜底。 */
interface PilotAskCounters {
  applied?: { asks?: (() => number) | null } | null;
  modelAsks?: number;
}
function askCountOf(rt: PilotRuntime): number {
  try {
    const src = rt as unknown as PilotAskCounters;
    const asks = src.applied?.asks;
    if (typeof asks === "function") {
      const n = asks();
      return Number.isFinite(n) ? n : 0;
    }
    return typeof src.modelAsks === "number" && Number.isFinite(src.modelAsks) ? src.modelAsks : 0;
  } catch {
    return 0;
  }
}

function mergeEvents(a: Array<Record<string, unknown>>, b: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out = [...a, ...b];
  return out.length <= MAX_EVENT_COUNT ? out : out.slice(out.length - MAX_EVENT_COUNT);
}

/**
 * 会话内托管驾驶的状态机：持有附着式 PilotRuntime，跨调用保留账本/步史/预算/交接。
 * 方法是协议的四个入口（drive/start、command、status、close）+ 单步 step；
 * 每个响应 `ok:true` 表示**请求被接受**，驾驶去向看 `status`/`stop_code`。
 */
export class SessionPilotDriver {
  readonly runId: string;
  readonly hosts: string[] | null;
  /** pilot 证据目录（独立于会话证据目录；不写会话 --record 流）。 */
  readonly outDir: string;

  private readonly deps: SessionPilotDeps;
  private sink: CaptureSink | null = null;
  private rt: PilotRuntime | null = null;
  private closed = false;
  private lastStatusName = "idle";

  constructor(deps: SessionPilotDeps) {
    this.deps = deps;
    this.runId = deps.runId;
    this.hosts = deps.hosts;
    this.outDir = path.join(amberflowHome(deps.env ?? process.env), "pilot", deps.runId);
  }

  /** 会话面 join key（三面响应都带）。 */
  get sessionId(): string {
    return this.deps.runId;
  }

  private get terminal(): boolean {
    if (this.closed) return true;
    const rt = this.rt;
    if (rt === null) return false;
    return rt.done || rt.aborted || rt.stopCode === "final_signal_held"
      || rt.stopCode === "budget_exceeded" || rt.stopCode === "browser_dead";
  }

  private statusName(): string {
    if (this.closed) return "closed";
    const rt = this.rt;
    if (rt === null) return "idle";
    if (rt.aborted) return "aborted";
    if (rt.stopCode === "final_signal_held" || rt.done) return "done";
    if (rt.stopCode === "browser_dead") return "browser_dead";
    if (rt.handoffOpen !== null) return "handoff";
    return this.lastStatusName;
  }

  private takeEvents(): Array<Record<string, unknown>> {
    return this.sink === null ? [] : this.sink.take();
  }

  private async urlNow(): Promise<string> {
    const rt = this.rt;
    if (rt === null) return "";
    try {
      return urlOf(await rt.page()) || "";
    } catch {
      return "";
    }
  }

  private statusBody(rt: PilotRuntime): Record<string, unknown> {
    return {
      status: this.statusName(),
      ...(rt.stopCode === null ? {} : { stop_code: rt.stopCode }),
      steps: rt.stepCount,
      model_asks: askCountOf(rt),
      out_dir: rt.outDir,
      ...(rt.handoffOpen === null ? {} : { handoff_open: projectHandoff(rt.handoffOpen) }),
    };
  }

  /**
   * 起驾驶（首次）或复用已存在的 driver：同一 session 只托管一个 pilot，重复 drive 不
   * 新建第二份账本/浏览器；已终态则返回结构化 `drive_terminal`（不静默重启）。
   */
  async start(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const invalid = driveStartProblem(req);
    if (invalid !== null) {
      return { ok: false, session_id: this.sessionId, code: "config_error", reason: invalid };
    }
    if (this.closed) {
      return {
        ok: false, session_id: this.sessionId, code: "drive_closed",
        reason: "the pilot driver was closed by driveClose; start a new session to drive again",
      };
    }
    if (this.rt !== null) {
      if (this.terminal) {
        return {
          ok: false, session_id: this.sessionId, code: "drive_terminal",
          reason: "the pilot driver is terminal; start a new session to drive again",
          stop_code: this.rt.stopCode,
        };
      }
      return { ok: true, session_id: this.sessionId, reused: true, ...this.statusBody(this.rt) };
    }
    try {
      const session = await this.deps.session();
      const page = session.page as AnyPage;
      const url = urlOf(page) || "about:blank";
      const sink = new CaptureSink();
      this.sink = sink;
      const opts: PilotOptions = {
        url,
        goal: String(req["goal"]).trim(),
        hosts: this.hosts !== null && this.hosts.length > 0 ? [...this.hosts] : undefined,
        finalSignal: isObj(req["final_signal"]) ? req["final_signal"] as Record<string, unknown> : null,
        expectUrl: nonEmpty(req["expect_url"]) ? String(req["expect_url"]) : null,
        maxSteps: typeof req["max_steps"] === "number" ? req["max_steps"] : undefined,
        confFloor: typeof req["conf_floor"] === "number" ? req["conf_floor"] : undefined,
        driver: req["driver"] === "agent" ? "agent" : "model",
        slots: isObj(req["slots"]) ? { ...(req["slots"] as Record<string, string>) } : {},
        outDir: this.outDir,
        sessionFactory: this.deps.session,
        ownsSession: false,
        skipStartNavigation: true,
        env: this.deps.env,
      };
      this.rt = new PilotRuntime(opts, sink, `${this.sessionId}-pilot`);
      await this.rt.start();
      const events = this.takeEvents();
      const started = events.find((e) => e["type"] === "started");
      if (started === undefined || started["ok"] !== true) {
        this.lastStatusName = "browser_dead";
        return {
          ok: false,
          session_id: this.sessionId,
          code: typeof started?.["code"] === "string" ? started["code"] : "browser_dead",
          reason: typeof started?.["reason"] === "string" ? started["reason"] : "pilot could not attach to the session page",
          out_dir: this.outDir,
          events,
        };
      }
      this.lastStatusName = "driving";
      return {
        ok: true,
        session_id: this.sessionId,
        attached: true,
        started,
        url: started["url"],
        out_dir: this.outDir,
        steps: 0,
        model_asks: 0,
        events,
      };
    } catch (e) {
      this.lastStatusName = "browser_dead";
      return { ok: false, session_id: this.sessionId, code: "browser_dead", reason: errMsg(e), out_dir: this.outDir };
    }
  }

  /** 驾驶一步（一次 `PilotRuntime.drive()`：直到停因/交接/步间等待/终态）。 */
  async step(): Promise<Record<string, unknown>> {
    const rt = this.rt;
    if (rt === null) {
      return { ok: false, session_id: this.sessionId, code: "config_error", reason: "drive has not been started; send drive first" };
    }
    if (this.closed) {
      return { ok: false, session_id: this.sessionId, code: "drive_closed", reason: "the pilot driver is already closed" };
    }
    if (this.terminal) {
      return {
        ok: false, session_id: this.sessionId, code: "drive_terminal",
        reason: "the pilot driver is terminal; start a new session to drive again",
        stop_code: rt.stopCode,
      };
    }
    let stop: PilotStopCode | typeof PILOT_AWAIT_PICK | null;
    try {
      stop = await rt.drive();
    } catch (e) {
      this.lastStatusName = "browser_dead";
      return { ok: false, session_id: this.sessionId, code: "browser_dead", reason: errMsg(e), events: this.takeEvents() };
    }
    this.lastStatusName = stop === PILOT_AWAIT_PICK ? "await_pick"
      : stop === "final_signal_held" ? "done"
        : stop === "browser_dead" ? "browser_dead"
          : stop !== null ? "handoff"
            : rt.done ? "done" : "driving";
    return {
      ok: true,
      session_id: this.sessionId,
      pilot: true,
      attached: true,
      status: this.statusName(),
      ...(stop === null || stop === PILOT_AWAIT_PICK ? {} : { stop_code: stop }),
      url: await this.urlNow(),
      steps: rt.stepCount,
      model_asks: askCountOf(rt),
      out_dir: rt.outDir,
      ...(rt.handoffOpen === null ? {} : { handoff: projectHandoff(rt.handoffOpen) }),
      terminal: this.terminal,
      events: this.takeEvents(),
    };
  }

  /**
   * 递一条兜底指令给 pilot 的闭集分派面（resume/redirect/finish/abort）。outcome=drive 时
   * 立刻再驾驶一步并把该步结果合并进同一响应；stay/close 原样回执（单行失败不杀会话）。
   */
  async command(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const invalid = driveCommandProblem(req);
    if (invalid !== null) {
      return { ok: false, session_id: this.sessionId, code: "config_error", reason: invalid };
    }
    if (this.closed) {
      return { ok: false, session_id: this.sessionId, code: "drive_closed", reason: "the pilot driver is already closed" };
    }
    const rt = this.rt;
    if (rt === null) {
      return {
        ok: false, session_id: this.sessionId, code: "config_error",
        reason: "driveCommand needs an active pilot driver; send drive first",
      };
    }
    const cmd = String(req["cmd"]);
    const line = JSON.stringify({
      cmd,
      ...(nonEmpty(req["hint"]) ? { hint: String(req["hint"]) } : {}),
      ...(req["value"] === undefined ? {} : { value: req["value"] }),
      ...(nonEmpty(req["goal"]) ? { goal: String(req["goal"]) } : {}),
      ...(nonEmpty(req["url"]) ? { url: String(req["url"]) } : {}),
      ...(req["skip"] === true ? { skip: true } : {}),
    });
    let outcome: "stay" | "drive" | "close";
    try {
      outcome = await rt.handleLine(line);
    } catch (e) {
      return { ok: false, session_id: this.sessionId, code: "browser_dead", reason: errMsg(e), events: this.takeEvents() };
    }
    const cmdEvents = this.takeEvents();
    const result = cmdEvents.find((e) => e["type"] === "command_result")
      ?? cmdEvents.find((e) => e["type"] === "error") ?? null;
    if (outcome === "drive") {
      const stepped = await this.step();
      const stepEvents = Array.isArray(stepped["events"]) ? stepped["events"] as Array<Record<string, unknown>> : [];
      return { ...stepped, cmd, outcome, command: result, events: mergeEvents(cmdEvents, stepEvents) };
    }
    if (outcome === "close") {
      return {
        ok: true, session_id: this.sessionId, pilot: true, attached: true, cmd, outcome,
        command: result, status: this.statusName(),
        ...(rt.stopCode === null ? {} : { stop_code: rt.stopCode }),
        steps: rt.stepCount,
        model_asks: askCountOf(rt),
        out_dir: rt.outDir,
        events: cmdEvents,
      };
    }
    const accepted = result !== null && result["ok"] === true;
    return {
      ok: accepted,
      session_id: this.sessionId,
      pilot: true,
      attached: true,
      cmd,
      outcome,
      ...(accepted || typeof result?.["code"] !== "string" ? {} : { code: result["code"] }),
      command: result,
      status: this.statusName(),
      events: cmdEvents,
    };
  }

  /** 只读状态（不驱动、不新建浏览器；未起驾驶时 status=idle）。 */
  async status(): Promise<Record<string, unknown>> {
    const rt = this.rt;
    const base = {
      ok: true,
      session_id: this.sessionId,
      pilot: true,
      attached: true,
      active: rt !== null && !this.terminal,
      terminal: this.terminal,
    };
    if (rt === null) {
      return { ...base, status: "idle", steps: 0, model_asks: 0, out_dir: this.outDir };
    }
    return { ...base, ...this.statusBody(rt), url: await this.urlNow() };
  }

  /** 收尾驾驶：只落 pilot 自己的产物，**不关宿主浏览器**（会话继续可用）。 */
  async close(): Promise<Record<string, unknown>> {
    const rt = this.rt;
    if (rt === null) {
      return { ok: true, session_id: this.sessionId, closed: false, note: "no pilot driver was started in this session" };
    }
    if (this.closed) {
      return { ok: true, session_id: this.sessionId, closed: true, already: true, out_dir: rt.outDir };
    }
    this.closed = true;
    try {
      // ownsSession:false 的兜底在 PilotRuntime.finish/closeBrowser；本层连 closeBrowser 都不调，
      // 宿主 page 必须活到会话自己 close。
      await rt.finish(null);
    } catch (e) {
      return { ok: false, session_id: this.sessionId, code: "internal_error", reason: errMsg(e), out_dir: rt.outDir };
    }
    this.lastStatusName = "closed";
    const events = this.takeEvents();
    const summary = events.find((e) => e["type"] === "pilot_end") ?? null;
    return {
      ok: true,
      session_id: this.sessionId,
      pilot: true,
      attached: true,
      closed: true,
      ...(rt.stopCode === null ? {} : { stop_code: rt.stopCode }),
      steps: rt.stepCount,
      model_asks: askCountOf(rt),
      out_dir: rt.outDir,
      summary,
      events,
    };
  }

  /** `drive` 协议入口：首次 = start + 一步驾驶；已有 driver = 复用并继续驾驶一步。 */
  async drive(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const started = await this.start(req);
    if (started["ok"] !== true) return started;
    if (started["reused"] === true) {
      const stepped = await this.step();
      return { ...stepped, reused: true };
    }
    const stepped = await this.step();
    const startEvents = Array.isArray(started["events"]) ? started["events"] as Array<Record<string, unknown>> : [];
    const stepEvents = Array.isArray(stepped["events"]) ? stepped["events"] as Array<Record<string, unknown>> : [];
    return { ...stepped, started: started["started"] ?? null, events: mergeEvents(startEvents, stepEvents) };
  }
}
