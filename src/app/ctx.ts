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
import {
  disallowedHost, type BrowserMiddleware, type BrowserSession, type RunReport,
} from "../engine/executor.ts";
import { firstOf, locatorAnyFrame, urlOf, type PageLike } from "../engine/extraction.ts";
import { checkSignal } from "../engine/signals.ts";
import { defaultDates, loadSource, runSource } from "../data/datasource.ts";
import { listAppAdapters, requireAppAdapter } from "./app-adapters.ts";
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
  /** 引擎给出的人可读原因（与 `stopCode` 配对；排障/分支用，**不是**模型自由文本）。 */
  reason?: string;
  evidence: StepEvidence;
}

export interface SourceObservationView {
  counts: Record<string, number>;
  selects: Record<string, Record<string, string> | null>;
  rows: Array<Record<string, string>>;
  version?: string;
}

/** 工具步的请求（进程观察面；完成真值 = exit/stdout/stderr/产物）。 */
export interface ToolRunRequest {
  desc: string;
  source: string;
  done: Record<string, unknown>;
  /**
   * 应用支持器：`cli`（默认）/ `ssh` / `stdio`。非 cli 时用 `rawStep` 里的声明块
   * （`{ssh:{...}}` / `{stdio:{...}}`），由对应适配器校验、展开、执行——与声明式
   * 应用的支持器是**同一份实现**（不另写一套）。
   */
  adapter?: string;
  rawStep?: Record<string, unknown>;
  args?: string[];
  dryRunArgs?: string[];
  idempotent?: boolean;
  dangerous?: boolean;
  retries?: number;
}

export interface ToolRunResult {
  ok: boolean;
  stopCode?: string;
  reason?: string;
  refused?: string;
  code: number | null;
  stdout: string;
  stderr: string;
  attempts: number;
  dryRun?: unknown;
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
    /** 读一个属性（不存在/超时 → null）。 */
    attr(selector: string, attr: string): Promise<string | null>;
  };
  /**
   * Q5 的决定：v1 **不开放**行抽取的新语法；调用会给结构化 `config_error`。
   * 命名行抽取用 `ctx.extract(name)`（走 `meta.site.listExtract` 声明）。
   */
  rows(spec: { row: string; fields: Record<string, string> }): Promise<Array<Record<string, string>>>;
  /** 用 `meta.site.listExtract[name]` 抽行（行选择器 + 字段选择器；字段值 `"."` = 行自身文本）。 */
  extract(name: string): Promise<Array<Record<string, string>>>;
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
  /** ① 命令行形式：`ctx.run("demo-tool", ["--flag"], { done })`。 */
  run(source: string, args: string[], req: {
    done: Record<string, unknown>; desc?: string; adapter?: string;
    idempotent?: boolean; retries?: number; dryRunArgs?: string[];
  }): Promise<StepResult>;
  /**
   * ② 声明形式（任意应用支持器）：`ctx.run({ adapter?: "cli"|"ssh"|"stdio", ssh?: {...}, stdio?: {...}, done })`。
   * 与声明式应用的 `journey` 步是同一套声明面（同一份校验/展开/执行实现），
   * 所以"声明式能表达的进程类型，flow 脚本也表达得了"。
   */
  run(step: Record<string, unknown> & { done: Record<string, unknown> }): Promise<StepResult>;
  dangerous(req: {
    desc: string; source: string; args: string[]; dryRunArgs: string[];
    done: Record<string, unknown>; idempotent?: boolean; retries?: number;
  }): Promise<StepResult>;
  done(): Promise<void>;
}

export interface CtxDeps {
  pack: {
    id: string; label?: string; goal: string; hosts?: string[] | null;
    invariants?: Array<Record<string, unknown>>;
    site?: { pages?: Record<string, string>; listExtract?: Record<string, { rows: string; fields: Record<string, string> }> };
  };
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
  /** 工具步：由驱动接到 `runToolStep`（干跑/确认/幂等重试的既有实现）。 */
  toolRunner?: (req: ToolRunRequest) => Promise<ToolRunResult>;
  /** `--skip-data`：数据腿被显式跳过时，`ctx.source()` 报结构化错误（不静默跑网络）。 */
  allowSources?: boolean;
  /** 每次 `ctx.step`/`arrive` 的实际执行报告（驱动用它汇总决策账，套件/矩阵念同一份数）。 */
  onRunReport?: (rep: RunReport) => void;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 相对仓库路径 → `file://`（与 app/bench 同一口径；dry/replay 也用这一份，host/URL 语义才同口径）。 */
export function resolveCtxUrl(u: string): string {
  if (/^(https?|file):/i.test(u)) return u;
  // 与 `app-runner.startUrl` 同一口径：用 `new URL("file://" + path)` 而不是 `pathToFileURL`，
  // 因为后者会把 `?sn=CAM-1001` 当成文件名百分号编码掉（实测 ERR_FILE_NOT_FOUND）。
  return new URL(`file://${path.resolve(REPO, u)}`).href;
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

/**
 * 命令闭集补 id：`ctx.command(...)` 不强制作者写 id，但执行器的闭集要求每个选项有名字。
 * 缺省补「序号 + op」的稳定 id（不随运行变化；重放/forbidden 语义仍稳定）。
 */
export function normalizeCommandIds(commands: CommandDecl[]): CommandDecl[] {
  return commands.map((c, i) => {
    const rec = c as unknown as Record<string, unknown>;
    if (typeof rec["id"] === "string" && String(rec["id"]).trim()) return c;
    return { ...(c as object), id: `cmd${i + 1}_${String(rec["op"] ?? "op")}` } as CommandDecl;
  });
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
    return { commands: normalizeCommandIds(act) };
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
  /** `ctx.done()` 已验收：之后不许再有动作（结束态不变量必须在"结束"之后求值）。 */
  const assertOpen = (label: string): void => {
    if (closed) throw new StopError("config_error", `${label}: ctx.done() was already called; no actions after the end-state acceptance`);
  };

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

  /** 所有导航的唯一实现（open / openPage 共用；hosts 信封在打开之前强制）。 */
  const navigate = async (
    rawUrl: string, call: "open" | "openPage" | "arrive", label: string,
    timeoutMs?: number, desc?: string, traceIt = true,
  ): Promise<void> => {
    assertOpen(label);
    const url = resolveCtxUrl(rawUrl);
    if (hosts && hosts.length && disallowedHost(url, hosts)) {
      throw new StopError("host_not_allowed", `${label}: ${JSON.stringify(url)} is outside the declared hosts envelope (${hosts.join(", ")})`);
    }
    const p = await page();
    try {
      await (p as unknown as { goto(u: string, o?: unknown): Promise<unknown> }).goto(
        url, { waitUntil: "domcontentloaded", timeout: timeoutMs ?? 30_000 },
      );
    } catch (e) {
      throw new StopError("config_error", `${label}(${JSON.stringify(url)}) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // 落地检查：请求 URL 过了信封不代表**最终页面**也过了（302/重定向可以跨主机）。
    const landed = urlOf(p);
    if (landed && hosts && hosts.length && disallowedHost(landed, hosts)) {
      throw new StopError("host_not_allowed",
        `${label}: landed on ${JSON.stringify(landed)} outside the declared hosts envelope (${hosts.join(", ")})`);
    }
    currentUrl = landed || url;
    if (traceIt) pushEvent(trace, { call, url: currentUrl, ...(desc === undefined ? {} : { desc }) });
  };

  const runOneStep = async (desc: string, req: {
    url?: string; done: DomSignal | Record<string, unknown>; act?: TargetDecl | CommandDecl[];
    slots?: Record<string, string>; when?: DomSignal | null; timeoutMs?: number;
  }): Promise<StepResult> => {
    assertOpen(`ctx.step(${JSON.stringify(desc)})`);
    checkBudget();
    const started = Date.now();
    const startUrl = resolveCtxUrl(req.url ?? currentUrl);
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
    const reason = typeof rep.stop_reason === "string" && rep.stop_reason ? rep.stop_reason : undefined;
    const result: StepResult = {
      ok: rep.done === true,
      ...(rep.stop_code === undefined ? {} : { stopCode: rep.stop_code }),
      ...(reason === undefined ? {} : { reason }),
      evidence: { url: startUrl, attempts: 1, elapsedMs: Date.now() - started },
    };
    record(result.ok, {
      desc, url: startUrl,
      ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
      result: {
        ok: result.ok, stop_code: result.stopCode ?? null,
        ...(reason === undefined ? {} : { reason }),
        elapsed_ms: result.evidence.elapsedMs,
      },
    });
    return result;
  };

  const runTool = async (source: string, args: string[], req: ToolRunRequest, dangerous: boolean): Promise<StepResult> => {
    if (typeof source !== "string" || !source.trim()) throw new StopError("config_error", "ctx.run: source must be a non-empty string");
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new StopError("config_error", "ctx.run: args must be a list of strings");
    if (req === null || typeof req !== "object" || req.done === undefined || req.done === null) {
      throw new StopError("config_error", "ctx.run: done signal is required (completion is the process observation)");
    }
    if (dangerous && (!Array.isArray(req.dryRunArgs) || req.dryRunArgs.length === 0)) {
      throw new StopError("config_error", "ctx.dangerous requires dryRunArgs (a failed dry run must never apply)");
    }
    if (deps.toolRunner === undefined) {
      throw new StopError("config_error", "ctx.run: no tool runner wired in this build");
    }
    // 与声明式适配器同一条纪律（load 期就该红；ctx 在运行期补一次，flow 也逃不掉）。
    if ((req.retries ?? 0) > 0 && req.idempotent !== true) {
      throw new StopError("config_error",
        `ctx.run: retries=${req.retries} needs idempotent: true (re-running a process can be irreversible)`);
    }
    assertOpen(`ctx.run` + (req.desc ? ` ${JSON.stringify(req.desc)}` : ""));
    checkBudget();
    const started = Date.now();
    let r: ToolRunResult;
    try {
      r = await deps.toolRunner({
        ...req, desc: req.desc ?? (dangerous ? `dangerous ${source}` : `run ${source}`),
        source, args, ...(dangerous ? { dangerous: true } : {}),
      });
    } catch (e) {
      // 工具源名/配置错（如 loadSource 抛）不能变成裸栈：给结构化 config_error。
      throw new StopError("config_error",
        `ctx.run: ${e instanceof Error ? e.message : String(e)}`);
    }
    budget.stepsUsed += 1;
    const ok = r.ok === true;
    const stopCode = r.stopCode ?? (ok ? undefined : (r.refused ?? "tool_failed"));
    const result: StepResult = {
      ok,
      ...(stopCode === undefined ? {} : { stopCode }),
      ...(r.reason === undefined ? {} : { reason: r.reason }),
      evidence: { url: currentUrl, attempts: r.attempts ?? 1, elapsedMs: Date.now() - started },
    };
    pushEvent(trace, {
      call: dangerous ? "dangerous" : "run",
      desc: req.desc ?? source, ok,
      ...(stopCode === undefined ? {} : { stop_code: stopCode }),
      result: { source, code: r.code, refused: r.refused ?? null, dry_run: r.dryRun ?? null },
    });
    return result;
  };
  /** 声明形式：挑适配器 → 交给驱动（与声明式 journey 同一套适配器实现）。 */
  const runDeclaredTool = async (step: Record<string, unknown>, dangerous: boolean): Promise<StepResult> => {
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      throw new StopError("config_error", "ctx.run: the declaration form needs an object like { stdio: {...}, done: {...} }");
    }
    const done = step["done"];
    if (done === undefined || done === null || typeof done !== "object") {
      throw new StopError("config_error", "ctx.run: done signal is required (completion is the process observation)");
    }
    const adapter = typeof step["adapter"] === "string" && step["adapter"]
      ? step["adapter"]
      : step["ssh"] !== undefined ? "ssh"
        : step["stdio"] !== undefined ? "stdio"
          : "cli";
    if (adapter === "web") {
      throw new StopError("config_error", "ctx.run: the web adapter is not a process step; use ctx.step() for browser steps");
    }
    try {
      requireAppAdapter(adapter);
    } catch {
      throw new StopError("config_error", `ctx.run: unknown app adapter ${JSON.stringify(adapter)} (known: ${listAppAdapters().join(", ")})`);
    }
    if (adapter === "cli") {
      // 声明形式的 cli 步与命令行形式完全等价（args/dryRunArgs/idempotent/retries 都认）。
      const source = typeof step["source"] === "string" ? step["source"] : "";
      const cliArgs = Array.isArray(step["args"]) ? (step["args"] as unknown[]).map(String) : [];
      const cliReq: ToolRunRequest = {
        desc: typeof step["desc"] === "string" && step["desc"] ? step["desc"] : `cli:${source || "declared"}`,
        source, done: done as Record<string, unknown>, adapter: "cli", rawStep: step,
        ...(Array.isArray(step["dryRunArgs"]) ? { dryRunArgs: (step["dryRunArgs"] as unknown[]).map(String) } : {}),
        ...(step["idempotent"] === true ? { idempotent: true } : {}),
        ...(typeof step["retries"] === "number" ? { retries: step["retries"] } : {}),
        ...(dangerous ? { dangerous: true } : {}),
      };
      return runTool(source, cliArgs, cliReq, dangerous);
    }
    if (deps.toolRunner === undefined) throw new StopError("config_error", "ctx.run: no tool runner wired in this build");
    checkBudget();
    const started = Date.now();
    const desc = typeof step["desc"] === "string" && step["desc"] ? step["desc"] : `${adapter} step`;
    let r: ToolRunResult;
    try {
      r = await deps.toolRunner({
        desc, source: typeof step["source"] === "string" ? step["source"] : `${adapter}:declared`,
        done: done as Record<string, unknown>, adapter, rawStep: step,
        ...(dangerous ? { dangerous: true } : {}),
      });
    } catch (e) {
      throw new StopError("config_error", `ctx.run: ${e instanceof Error ? e.message : String(e)}`);
    }
    budget.stepsUsed += 1;
    const ok = r.ok === true;
    const stopCode = r.stopCode ?? (ok ? undefined : (r.refused ?? "tool_failed"));
    const result: StepResult = {
      ok,
      ...(stopCode === undefined ? {} : { stopCode }),
      ...(r.reason === undefined ? {} : { reason: r.reason }),
      evidence: { url: currentUrl, attempts: r.attempts ?? 1, elapsedMs: Date.now() - started },
    };
    pushEvent(trace, {
      call: dangerous ? "dangerous" : "run", desc, ok,
      ...(stopCode === undefined ? {} : { stop_code: stopCode }),
      result: { adapter, code: r.code, refused: r.refused ?? null },
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
    open: async (u, o = {}) => { await navigate(u, "open", "ctx.open", o.timeoutMs); },
    openPage: async (role) => {
      if (typeof role !== "string" || !role.trim()) {
        throw new StopError("config_error", "ctx.openPage: role must be a non-empty string");
      }
      const pages = (pack.site?.pages ?? {}) as Record<string, string>;
      const url = pages[role];
      if (typeof url !== "string" || !url.trim()) {
        const known = Object.keys(pages);
        throw new StopError("config_error",
          `ctx.openPage(${JSON.stringify(role)}): no such page role in meta.site.pages`
          + ` (known: ${known.length ? known.join(", ") : "none declared"})${known.length ? "" : " — declare meta.site.pages or use ctx.open(url)"}`);
      }
      await navigate(url, "openPage", `ctx.openPage(${JSON.stringify(role)})`, undefined, role);
    },
    arrive: async (u, req) => {
      if (!isObj(req) || !isObj(req.done) || !Object.keys(req.done).length) {
        throw new StopError("config_error", "ctx.arrive: done signal is required");
      }
      checkBudget();
      const started = Date.now();
      const label = req.desc ?? `到达 ${u}`;
      // 纯导航：只 goto + 等信号，**不做元素选择、不花模型**（以前误走 step 路径：
      // 记录成 step、还会因选不到元素而 no_model_runtime —— 三实现漂移，replay 必 mismatch）。
      await navigate(u, "arrive", label, req.timeoutMs, req.desc, false);
      const timeout = req.timeoutMs ?? 15_000;
      const deadline = Date.now() + timeout;
      let held = false;
      let waitErr: unknown;
      let hostViolation: string | null = null;
      try {
        const p = await page();
        const pAny = p as unknown as { waitForTimeout?(ms: number): Promise<void> };
        do {
          const landed = urlOf(p);
          if (landed) {
            if (hosts && hosts.length && disallowedHost(landed, hosts)) { hostViolation = landed; break; }
            currentUrl = landed;
          }
          try {
            if (await checkSignal(p as never, req.done as never)) { held = true; break; }
          } catch (e) { waitErr = e; break; }        // 坏信号 = 配置错误，别轮询到超时
          if (typeof pAny.waitForTimeout === "function") await pAny.waitForTimeout(200);
          else await new Promise((r) => setTimeout(r, 200));
        } while (Date.now() < deadline);
      } catch (e) { waitErr = e; }
      budget.stepsUsed += 1;
      const stopCode = held ? undefined : (hostViolation !== null ? "host_not_allowed" : "arrive_signal_not_held");
      const reason = held ? undefined
        : hostViolation !== null
          ? `arrive: landed on ${JSON.stringify(hostViolation)} outside the declared hosts envelope (${hosts?.join(", ")})`
          : `arrive: navigation finished but done-signal never held within ${timeout}ms`
            + (waitErr instanceof Error ? ` (${waitErr.message})` : "");
      const result: StepResult = {
        ok: held,
        ...(stopCode === undefined ? {} : { stopCode }),
        ...(reason === undefined ? {} : { reason }),
        evidence: { url: currentUrl, attempts: 1, elapsedMs: Date.now() - started },
      };
      pushEvent(trace, {
        call: "arrive", desc: req.desc, url: currentUrl, ok: held,
        ...(stopCode === undefined ? {} : { stop_code: stopCode }),
        result: { ok: held, ...(stopCode === undefined ? {} : { stop_code: stopCode }),
          ...(reason === undefined ? {} : { reason }), elapsed_ms: result.evidence.elapsedMs },
      });
      return result;
    },
    step: async (desc, req) => {
      assertAct(req);
      return runOneStep(desc, { ...req, when: req.when ?? null });
    },
    url: () => currentUrl,
    read: {
      text: async (sel) => {
        let value: string | null = null;
        try {
          const loc = await locatorAnyFrame(await page(), sel);
          if (loc !== null) value = String(await firstOf(loc).innerText({ timeout: 1500 }));
        } catch { value = null; }
        pushEvent(trace, { call: "read", desc: `text(${sel})`, result: value });
        return value;
      },
      value: async (sel) => {
        let value: string | null = null;
        try {
          const loc = await locatorAnyFrame(await page(), sel);
          if (loc !== null) value = String(await firstOf(loc).inputValue({ timeout: 1500 }));
        } catch { value = null; }
        pushEvent(trace, { call: "read", desc: `value(${sel})`, result: value });
        return value;
      },
      count: async (sel) => {
        let value = 0;
        try {
          const loc = await locatorAnyFrame(await page(), sel);
          value = loc === null ? 0 : Number(await loc.count());
        } catch { value = 0; }
        pushEvent(trace, { call: "read", desc: `count(${sel})`, result: value });
        return value;
      },
      attr: async (sel, attr) => {
        if (typeof sel !== "string" || !sel.trim()) throw new StopError("config_error", "ctx.read.attr: selector must be a non-empty string");
        if (typeof attr !== "string" || !attr.trim()) throw new StopError("config_error", "ctx.read.attr: attribute name must be a non-empty string");
        let value: string | null = null;
        try {
          const loc = await locatorAnyFrame(await page(), sel);
          if (loc !== null) {
            const inner = firstOf(loc) as { getAttribute?(n: string, o?: { timeout?: number }): Promise<string | null> };
            if (typeof inner.getAttribute === "function") value = await inner.getAttribute(attr, { timeout: 1500 });
          }
        } catch { value = null; }
        pushEvent(trace, { call: "read", desc: `attr(${sel}, ${attr})`, result: value });
        return value;
      },
    },
    holds: async (sig) => {
      if (!isObj(sig) || !Object.keys(sig).length) throw new StopError("config_error", "ctx.holds needs a non-empty signal");
      const ok = await checkSignal(await page(), sig as never);
      pushEvent(trace, { call: "holds", ok });
      return ok;
    },
    source: async (name) => {
      if (deps.allowSources === false) {
        throw new StopError("config_error", `ctx.source(${JSON.stringify(name)})：本次运行带 --skip-data，数据腿被显式跳过`);
      }
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
    rows: async () => {
      throw new StopError("config_error", "ctx.rows is closed in v1 (Q5: no new extraction grammar); "
        + "declare named row extraction in meta.site.listExtract and call ctx.extract(name)");
    },
    extract: async (name) => {
      if (typeof name !== "string" || !name.trim()) throw new StopError("config_error", "ctx.extract: name must be a non-empty string");
      const spec = pack.site?.listExtract?.[name];
      if (spec === undefined) {
        const known = Object.keys(pack.site?.listExtract ?? {});
        throw new StopError("config_error",
          `ctx.extract(${JSON.stringify(name)}): meta.site.listExtract has no such entry`
          + ` (known: ${known.length ? known.join(", ") : "none declared"})`);
      }
      const p = await page();
      const rowsLoc = await locatorAnyFrame(p, spec.rows);
      const rows: Array<Record<string, string>> = [];
      let truncated = false;
      if (rowsLoc !== null) {
        const all = rowsLoc.all === undefined ? null : await rowsLoc.all();
        if (all === null) {
          throw new StopError("config_error", "ctx.extract needs a Playwright locator (locator.all() is not available here)");
        }
        const cap = 500;
        truncated = all.length > cap;
        for (const row of all.slice(0, cap)) {
          const locators = row as {
            locator?: (s: string) => { first(): { innerText(o?: { timeout?: number }): Promise<string>; inputValue(o?: { timeout?: number }): Promise<string> } };
            innerText?: (o?: { timeout?: number }) => Promise<string>;
          };
          const rec: Record<string, string> = {};
          for (const [field, cellSel] of Object.entries(spec.fields)) {
            let value = "";
            try {
              if (cellSel === "." || cellSel === ":scope") {
                if (typeof locators.innerText === "function") value = await locators.innerText({ timeout: 1500 });
              } else if (typeof locators.locator === "function") {
                const cell = locators.locator(cellSel).first();
                try { value = await cell.innerText({ timeout: 1500 }); }
                catch { value = await cell.inputValue({ timeout: 1500 }); }
              }
            } catch { value = ""; }
            rec[field] = String(value ?? "").trim();
          }
          rows.push(rec);
        }
      }
      pushEvent(trace, { call: "extract", desc: name, result: { rows, truncated } });
      return rows;
    },
    run: (async (sourceOrStep: unknown, args?: string[], req?: unknown): Promise<StepResult> => {
      if (typeof sourceOrStep === "string") {
        return runTool(sourceOrStep, args ?? [], req as ToolRunRequest, false);
      }
      const step = sourceOrStep as Record<string, unknown>;
      return runDeclaredTool(step, false);
    }) as Ctx["run"],
    dangerous: async (req) => {
      if (!Array.isArray(req?.dryRunArgs) || req.dryRunArgs.length === 0) {
        throw new StopError("config_error", "ctx.dangerous requires dryRunArgs (a failed dry run must never apply)");
      }
      return runTool(req.source, req.args, req as ToolRunRequest, true);
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
