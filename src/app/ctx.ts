/**
 * L2 运行期 `ctx`（真实实现）——脚本应用**唯一**的运行期面。
 *
 * 分工（与 API 草案一致）：
 *   - **脚本**：控制流（循环/条件/重试/组合）；
 *   - **引擎**：一步之内的一切——元素池、规则/hint/模型选元素、置信度/风险闸门、
 *     可操作性探针、DOM 信号判定、绑定与数据腿、危险动作 dry-run+确认。
 *
 * 红线在 L2 的落法：
 *   - 脚本拿不到模型文本/分数、拿不到 `page`/`locator`、不能自报完成——只能拿到
 *     `{ok, stopCode, evidence}` 这种**结构化结果**；
 *   - 完成只认该面证据：`step`/`arrive` 的 `done` 由 `checkSignal`/`checkToolSignal` 裁决；
 *   - 值只来自声明/观察/派生：`read.*` 是只读观察，`source()` 是数据腿观察。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  disallowedHost, type BrowserMiddleware, type BrowserSession, type RunReport,
} from "../engine/executor.ts";
import { firstOf, locatorAnyFrame, type PageLike } from "../engine/extraction.ts";
import { checkSignal } from "../engine/signals.ts";
import { defaultDates, loadSource, runSource } from "../data/datasource.ts";
import { REPO } from "../flow/flow.ts";
import { createKit, type CommandDecl, type DomSignal, type TargetDecl, type ValueBinding } from "./kit.ts";
import { pushEvent, type AppTrace } from "./trace.ts";

/** 运行期**配置级**停因：脚本可以 `catch`，但默认直接结束运行（不是业务失败）。 */
export class StopError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StopError";
    this.code = code;
  }
}

export interface StepRequest {
  /** **必填**：完成只由引擎按信号裁决。 */
  done: DomSignal;
  /** **必填**：目标（kit.hint/hints）或命令闭集。纯导航步用 `arrive`。 */
  act: TargetDecl | CommandDecl[];
  /** 这一步的起点 URL（缺省 = 当前页）；相对仓库路径按仓库根解析成 `file://`。 */
  url?: string;
  slots?: Record<string, string>;
  /** 适用性守卫（在动作前判定；不成立 = 这一步不执行，返回 ok=false + stopCode="precondition_skipped"）。 */
  when?: DomSignal;
  id?: string;
  timeoutMs?: number;
}

export interface StepEvidence {
  url: string;
  attempts: number;
  elapsedMs: number;
}

export interface StepResult {
  ok: boolean;
  stopCode?: string;
  evidence: StepEvidence;
}

export interface SourceObservationView {
  counts: Record<string, number>;
  selects: Record<string, Record<string, string> | null>;
  rows: Array<Record<string, string>>;
  version?: string;
}

export interface CtxBudget {
  maxSteps: number;
  stepsUsed: number;
  deadline: number;
}

export interface Ctx {
  readonly app: Readonly<{ id: string; label?: string; goal: string }>;
  readonly slots: Readonly<Record<string, string>>;
  readonly runtime: Readonly<{ outDir: string; runId: string; today: string }>;
  readonly budget: CtxBudget;
  log(msg: string, data?: unknown): void;
  open(url: string, opts?: { timeoutMs?: number }): Promise<void>;
  openPage(role: string): Promise<void>;
  arrive(url: string, req: { done: DomSignal; desc?: string; timeoutMs?: number }): Promise<StepResult>;
  step(desc: string, req: StepRequest): Promise<StepResult>;
  url(): string;
  readonly read: {
    text(selector: string): Promise<string | null>;
    value(selector: string): Promise<string | null>;
    count(selector: string): Promise<number>;
  };
  holds(sig: DomSignal): Promise<boolean>;
  source(name: string): Promise<SourceObservationView>;
  readonly data: {
    min<T extends Record<string, unknown>>(rows: T[], by: string): T | null;
    max<T extends Record<string, unknown>>(rows: T[], by: string): T | null;
  };
  // 纯构造器（与 L1 kit 同一份实现；脚本里 `ctx.judge.*` / `ctx.hint()` / `ctx.command()`）
  readonly judge: ReturnType<typeof createKit>["judge"];
  readonly tool: ReturnType<typeof createKit>["tool"];
  hint(hint: string): TargetDecl;
  hints(...hints: string[]): TargetDecl;
  command(op: string, target?: string, value?: ValueBinding): CommandDecl;
  readonly value: ReturnType<typeof createKit>["value"];
  run(source: string, args: string[], req: { done: DomSignal }): Promise<StepResult>;
  dangerous(req: Record<string, unknown>): Promise<StepResult>;
  done(): Promise<void>;
}

export interface CtxDeps {
  pack: { id: string; label?: string; goal: string; hosts?: string[] | null; invariants?: Array<Record<string, unknown>> };
  slots: Record<string, string>;
  runtime: { outDir: string; runId: string; today: string };
  ensureSession(): Promise<BrowserSession>;
  mw(): BrowserMiddleware;
  trace: AppTrace;
  maxSteps?: number;
  deadline?: number;
  verbose?: boolean;
  /** 数据腿：与 `runApp` 的同一实现（`runSource` + `defaultDates`）。 */
  sourceRunner?: (name: string) => Promise<SourceObservationView>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 相对仓库路径 → `file://`（与 app/bench 同一口径：包写仓库内路径，不写死绝对路径）。 */
function resolveUrl(u: string): string {
  if (/^(https?|file):/i.test(u)) return u;
  return pathToFileURL(path.isAbsolute(u) ? u : path.join(REPO, u)).href;
}

function assertAct(req: StepRequest): void {
  if (req === null || typeof req !== "object") throw new StopError("config_error", "ctx.step needs a request object");
  if (req.done === undefined || req.done === null || !isObj(req.done) || !Object.keys(req.done).length) {
    throw new StopError("config_error", "ctx.step: done signal is required (completion only comes from the evidence surface)");
  }
  if (req.act === undefined || req.act === null) {
    throw new StopError("config_error", "ctx.step: act is required (declare kit.hint()/kit.hints()/commands; pure navigation uses ctx.arrive)");
  }
}

/** 把 `StepRequest` 的目标声明摊成 `RunOptions` 的字段。 */
function targetOptions(act: TargetDecl | CommandDecl[]): {
  targetHint?: string | null; targetHints?: string[] | null; commands?: CommandDecl[] | null;
} {
  if (Array.isArray(act)) {
    for (const [i, c] of act.entries()) {
      if (!isObj(c) || typeof c.op !== "string" || !c.op) {
        throw new StopError("config_error", `ctx.step: act[${i}] is not a command (needs {op, ...}; build it with kit.command())`);
      }
    }
    return { commands: act };
  }
  if (!isObj(act) || (act.kind !== "hint" && act.kind !== "hints")) {
    throw new StopError("config_error", "ctx.step: act must be kit.hint()/kit.hints() or an array of kit.command(...)");
  }
  if (act.kind === "hint") {
    if (typeof act.hint !== "string" || !act.hint.trim()) throw new StopError("config_error", "ctx.step: hint must be a non-empty string");
    return { targetHint: act.hint };
  }
  if (!Array.isArray(act.hints) || !act.hints.length || act.hints.some((h) => typeof h !== "string" || !h.trim())) {
    throw new StopError("config_error", "ctx.step: hints must be a non-empty list of strings");
  }
  return { targetHints: act.hints };
}

/** 构造真实 ctx（一个运行一个实例；会话惰性创建、由驱动关闭）。 */
export function createCtx(deps: CtxDeps): Ctx {
  const { pack, slots, runtime, trace } = deps;
  const budget: CtxBudget = {
    maxSteps: deps.maxSteps ?? 100,
    stepsUsed: 0,
    deadline: deps.deadline ?? Number.POSITIVE_INFINITY,
  };
  const hosts = (pack.hosts ?? null) as string[] | null;
  let currentUrl = "about:blank";
  let closed = false;

  const page = async (): Promise<PageLike> => {
    const s = await deps.ensureSession();
    return s.page as unknown as PageLike;
  };

  const checkBudget = (): void => {
    if (Date.now() > budget.deadline) throw new StopError("budget_exceeded", "run deadline exceeded (ctx.budget.deadline)");
    if (budget.stepsUsed >= budget.maxSteps) {
      throw new StopError("budget_exceeded", `step budget exhausted: ${budget.stepsUsed}/${budget.maxSteps} (raise --max-steps or fix the loop)`);
    }
  };

  const record = (ok: boolean | undefined, extra: Record<string, unknown> = {}): void => {
    pushEvent(trace, { call: "step", ok, ...extra });
  };

  const runOneStep = async (desc: string, req: {
    url?: string; done: DomSignal | Record<string, unknown>; act?: TargetDecl | CommandDecl[];
    slots?: Record<string, string>; when?: DomSignal | null; timeoutMs?: number;
  }): Promise<StepResult> => {
    checkBudget();
    const started = Date.now();
    const startUrl = resolveUrl(req.url ?? currentUrl);
    if (hosts && hosts.length && disallowedHost(startUrl, hosts)) {
      throw new StopError("host_not_allowed", `ctx.step: ${JSON.stringify(startUrl)} is outside the declared hosts envelope (${hosts.join(", ")})`);
    }
    const session = await deps.ensureSession();
    if (req.url !== undefined) currentUrl = startUrl;
    const opts: Record<string, unknown> = {
      goalSignalFn: (p: unknown) => checkSignal(p as never, req.done as never),
      page: session.page,
      pw: session.pw,
      slots: { ...slots, ...(req.slots ?? {}) },
      verbose: deps.verbose === true,
    };
    if (req.when !== undefined && req.when !== null) opts["precondition"] = req.when;
    Object.assign(opts, req.act === undefined ? {} : targetOptions(req.act));
    let rep: RunReport;
    try {
      rep = await deps.mw().run(desc, startUrl, opts as never);
    } catch (e) {
      // 执行器把"动作失败"当结果而不是异常（既有语义）；走到这里只可能是配置级错误。
      throw new StopError("config_error", `ctx.step ${JSON.stringify(desc)} crashed: ${e instanceof Error ? e.message : String(e)}`);
    }
    budget.stepsUsed += 1;
    const result: StepResult = {
      ok: rep.done === true,
      ...(rep.stop_code === undefined ? {} : { stopCode: rep.stop_code }),
      evidence: { url: startUrl, attempts: 1, elapsedMs: Date.now() - started },
    };
    record(result.ok, {
      desc, url: startUrl,
      ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
      result: { ok: result.ok, stop_code: result.stopCode ?? null, elapsed_ms: result.evidence.elapsedMs },
    });
    return result;
  };

  const kit = createKit();
  const ctx: Ctx = {
    judge: kit.judge,
    tool: kit.tool,
    hint: kit.hint,
    hints: kit.hints,
    command: kit.command,
    value: kit.value,
    app: { id: pack.id, ...(pack.label === undefined ? {} : { label: pack.label }), goal: pack.goal },
    slots: Object.freeze({ ...slots }),
    runtime: Object.freeze({ ...runtime }),
    budget,
    log: (msg, data) => {
      pushEvent(trace, { call: "log", desc: msg, ...(data === undefined ? {} : { result: data }) });
      if (deps.verbose) console.log(`  [flow] ${msg}`);
    },
    open: async (u, o = {}) => {
      const url = resolveUrl(u);
      if (hosts && hosts.length && disallowedHost(url, hosts)) {
        throw new StopError("host_not_allowed", `ctx.open: ${JSON.stringify(url)} is outside the declared hosts envelope (${hosts.join(", ")})`);
      }
      const p = await page();
      try {
        await (p as unknown as { goto(u: string, o?: unknown): Promise<unknown> }).goto(
          url, { waitUntil: "domcontentloaded", timeout: o.timeoutMs ?? 30_000 },
        );
      } catch (e) {
        throw new StopError("config_error", `ctx.open(${JSON.stringify(url)}) failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      currentUrl = url;
      pushEvent(trace, { call: "open", url });
    },
    openPage: async (role) => {
      throw new StopError("config_error", `ctx.openPage(${JSON.stringify(role)}) is not available in this build: `
        + "site page maps (meta.site.pages) are not wired yet; use ctx.open(url)");
    },
    arrive: async (u, req) => {
      if (!isObj(req) || !isObj(req.done) || !Object.keys(req.done).length) {
        throw new StopError("config_error", "ctx.arrive: done signal is required");
      }
      const r = await runOneStep(req.desc ?? `到达 ${u}`, { url: u, done: req.done });
      return r;
    },
    step: async (desc, req) => {
      assertAct(req);
      return runOneStep(desc, { ...req, when: req.when ?? null });
    },
    url: () => currentUrl,
    read: {
      text: async (sel) => {
        try {
          const loc = await locatorAnyFrame(await page(), sel);
          if (loc === null) return null;
          return String(await firstOf(loc).innerText({ timeout: 1500 }));
        } catch {
          return null;
        }
      },
      value: async (sel) => {
        try {
          const loc = await locatorAnyFrame(await page(), sel);
          if (loc === null) return null;
          return String(await firstOf(loc).inputValue({ timeout: 1500 }));
        } catch {
          return null;
        }
      },
      count: async (sel) => {
        try {
          const loc = await locatorAnyFrame(await page(), sel);
          return loc === null ? 0 : Number(await loc.count());
        } catch {
          return 0;
        }
      },
    },
    holds: async (sig) => {
      if (!isObj(sig) || !Object.keys(sig).length) throw new StopError("config_error", "ctx.holds needs a non-empty signal");
      const ok = await checkSignal(await page(), sig as never);
      pushEvent(trace, { call: "holds", ok });
      return ok;
    },
    source: async (name) => {
      if (deps.sourceRunner) {
        const obs = await deps.sourceRunner(name);
        pushEvent(trace, { call: "source", desc: name, result: { counts: obs.counts, rows: obs.rows.length } });
        return obs;
      }
      const src = loadSource(name);
      const res = await runSource(src, defaultDates(src), { verbose: false });
      const day = Object.values(res.dates)[0] as unknown as Record<string, unknown> | undefined;
      const counts = (day?.["counts"] ?? {}) as Record<string, number>;
      const selects = (day?.["selects"] ?? {}) as Record<string, Record<string, string> | null>;
      const rows = (day?.["rows"] ?? []) as Array<Record<string, string>>;
      const obs: SourceObservationView = { counts, selects, rows, ...(res.tool_version ? { version: res.tool_version } : {}) };
      pushEvent(trace, { call: "source", desc: name, result: { counts, rows: rows.length } });
      return obs;
    },
    data: {
      min: (rows, by) => pickRow(rows, by, "min"),
      max: (rows, by) => pickRow(rows, by, "max"),
    },
    run: async () => {
      throw new StopError("config_error", "ctx.run (tool steps) is not available in this L2 build yet");
    },
    dangerous: async () => {
      throw new StopError("config_error", "ctx.dangerous is not available in this L2 build yet");
    },
    done: async () => {
      if (closed) throw new StopError("config_error", "ctx.done called twice");
      closed = true;
      const invs = (pack.invariants ?? []) as Array<Record<string, unknown>>;
      if (!invs.length) {
        pushEvent(trace, { call: "done", ok: true });
        return;
      }
      let p: PageLike;
      try {
        p = await page();
      } catch {
        throw new StopError("invariant_failed", "ctx.done: no browser session, but web invariants need the end state");
      }
      const failed: string[] = [];
      const details: Array<{ id: string; held: boolean }> = [];
      for (const inv of invs) {
        const sig = inv["signal"];
        const held = isObj(sig) ? await checkSignal(p, sig as never) : false;
        details.push({ id: String(inv["id"] ?? "?"), held });
        if (!held) failed.push(String(inv["id"] ?? "?"));
      }
      pushEvent(trace, {
        call: "done", ok: failed.length === 0,
        ...(failed.length ? { stop_code: "invariant_failed" } : {}),
        result: { invariants: details },
      });
      if (failed.length) {
        throw new StopError("invariant_failed", `ctx.done: invariants failed on the end state: ${failed.join(", ")}`);
      }
    },
  };
  return ctx;
}

/** 选一行：`min|max` 按字段的数值比较（非数值回落到字符串比较；空集合 → null）。 */
function pickRow<T extends Record<string, unknown>>(rows: T[], by: string, order: "min" | "max"): T | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  let best: T | null = null;
  for (const row of rows) {
    if (best === null) { best = row; continue; }
    const a = num(row[by]);
    const b = num(best[by]);
    const cmp = a !== null && b !== null ? a - b : String(row[by] ?? "").localeCompare(String(best[by] ?? ""));
    if (order === "min" ? cmp < 0 : cmp > 0) best = row;
  }
  return best;
}
