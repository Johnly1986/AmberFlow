/**
 * L2 `ctx` 的 **dry 实现**（不动作、不开浏览器）——`amber apps check/explain` 的落法之一。
 *
 * 它把每一次调用都**校验一遍**（与真实执行同一套语法/命令校验），把意图记进 trace，
 * 然后返回"假装成功"的结果。所以：
 *   - `check`：坏脚本（未知信号算子、命令 op 错、act 缺失、hosts 外导航）在这里就红；
 *   - `explain`：把 trace 渲染成人话计划（与真实运行同一套调用序列）。
 *
 * 不做的事：不验证页面状态、不判完成（那必须有真页面）。dry 的成功**不代表**运行会成功。
 */
import { disallowedHost } from "../engine/executor.ts";
import { validateSignalSpec } from "../engine/signals.ts";
import { validateCommands } from "../engine/actions.ts";
import { validateToolSignal } from "../browser/tool-signals.ts";
import { createKit, type CommandDecl } from "./kit.ts";
import { pushEvent, type AppTrace } from "./trace.ts";
import { listAppAdapters, requireAppAdapter } from "./app-adapters.ts";
import { StopError, type Ctx, type CtxBudget, type SourceObservationView, type StepRequest, type StepResult } from "./ctx.ts";

export interface DryCtxDeps {
  pack: { id: string; label?: string; goal: string; hosts?: string[] | null; invariants?: Array<Record<string, unknown>> };
  slots: Record<string, string>;
  runtime: { outDir: string; runId: string; today: string };
  trace: AppTrace;
  maxSteps?: number;
  /** 声明过的槽位键（`validateCommands` 的 fill/select 绑定要对它查）。 */
  slotKeys: Set<string>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 构造 dry ctx。调用方负责把 `trace` 落盘/渲染。 */
export function createDryCtx(deps: DryCtxDeps): Ctx {
  const { pack, slots, runtime, trace } = deps;
  const budget: CtxBudget = { maxSteps: deps.maxSteps ?? 100, stepsUsed: 0, deadline: Number.POSITIVE_INFINITY };
  const hosts = (pack.hosts ?? null) as string[] | null;
  let currentUrl = "about:blank";

  const checkBudget = (): void => {
    if (budget.stepsUsed >= budget.maxSteps) {
      throw new StopError("budget_exceeded", `step budget exhausted: ${budget.stepsUsed}/${budget.maxSteps} (dry run)`);
    }
  };

  const problems = (p: string[]): string[] => p.map((x) => `flow: ${x}`);

  const validateStep = (where: string, req: StepRequest): string[] => {
    const p: string[] = [];
    if (req.done === undefined || req.done === null || !isObj(req.done) || !Object.keys(req.done).length) {
      p.push(`${where}: done signal is required`);
    } else {
      p.push(...validateSignalSpec(req.done, where));
    }
    if (req.act === undefined || req.act === null) {
      p.push(`${where}: act is required (pure navigation uses ctx.arrive)`);
    } else if (Array.isArray(req.act)) {
      for (const c of req.act) {
        if (!isObj(c) || typeof c.op !== "string") { p.push(`${where}: command needs {op, ...} (build with kit.command())`); continue; }
      }
      validateCommands(req.act as CommandDecl[], where, p, deps.slotKeys);
    } else if (!isObj(req.act) || (req.act.kind !== "hint" && req.act.kind !== "hints")) {
      p.push(`${where}: act must be kit.hint()/kit.hints() or an array of kit.command(...)`);
    } else if (req.act.kind === "hint") {
      if (typeof req.act.hint !== "string" || !req.act.hint.trim()) p.push(`${where}: hint must be a non-empty string`);
    } else if (!Array.isArray(req.act.hints) || !req.act.hints.length) {
      p.push(`${where}: hints must be a non-empty list`);
    }
    if (req.when !== undefined && req.when !== null) p.push(...validateSignalSpec(req.when, `${where}.when`));
    return p;
  };

  const recordStep = (desc: string, done?: unknown, ok = true, stopCode?: string): StepResult => {
    checkBudget();
    budget.stepsUsed += 1;
    pushEvent(trace, {
      call: "step", desc, url: currentUrl, ok,
      ...(stopCode === undefined ? {} : { stop_code: stopCode }),
      // dry 的审计额外记**声明的完成条件**（它是计划数据，不是模型产出）：
      // `apps explain` 与"脚本 vs 既有 journey"对照都靠它。
      ...(done === undefined ? {} : { result: { done } }),
    });
    return { ok, ...(stopCode === undefined ? {} : { stopCode }), evidence: { url: currentUrl, attempts: 1, elapsedMs: 0 } };
  };

  const kitCtx = createKit();
  return {
    judge: kitCtx.judge,
    tool: kitCtx.tool,
    hint: kitCtx.hint,
    hints: kitCtx.hints,
    command: kitCtx.command,
    value: kitCtx.value,
    app: { id: pack.id, ...(pack.label === undefined ? {} : { label: pack.label }), goal: pack.goal },
    slots: Object.freeze({ ...slots }),
    runtime: Object.freeze({ ...runtime }),
    budget,
    log: (msg) => { pushEvent(trace, { call: "log", desc: msg }); },
    open: async (u) => {
      const url = /^(https?|file):/i.test(u) ? u : u;
      if (hosts && hosts.length && disallowedHost(url, hosts)) {
        throw new StopError("host_not_allowed", `ctx.open: ${JSON.stringify(url)} is outside the declared hosts envelope (${hosts.join(", ")})`);
      }
      currentUrl = url;
      pushEvent(trace, { call: "open", url });
    },
    openPage: async (role) => {
      throw new StopError("config_error", `ctx.openPage(${JSON.stringify(role)}) is not available in this build; use ctx.open(url)`);
    },
    arrive: async (u, req) => {
      const p = [
        ...(isObj(req?.done) && Object.keys(req.done).length ? [] : [`ctx.arrive: done signal is required`]),
        ...(isObj(req?.done) && Object.keys(req.done).length ? validateSignalSpec(req.done, "ctx.arrive") : []),
      ];
      if (p.length) throw new StopError("config_error", p.join("；"));
      currentUrl = u;
      checkBudget();
      budget.stepsUsed += 1;
      pushEvent(trace, { call: "arrive", desc: req?.desc, url: u, ok: true });
      return { ok: true, evidence: { url: u, attempts: 1, elapsedMs: 0 } };
    },
    step: async (desc, req) => {
      const p = validateStep(`ctx.step(${JSON.stringify(desc)})`, req);
      if (p.length) throw new StopError("config_error", problems(p).join("；"));
      currentUrl = req.url ?? currentUrl;
      return recordStep(desc, req.done);
    },
    url: () => currentUrl,
    read: {
      text: async (sel) => { pushEvent(trace, { call: "read", desc: `text(${sel})`, result: null }); return null; },
      value: async (sel) => { pushEvent(trace, { call: "read", desc: `value(${sel})`, result: null }); return null; },
      count: async (sel) => { pushEvent(trace, { call: "read", desc: `count(${sel})`, result: 0 }); return 0; },
    },
    holds: async (sig) => {
      const p = isObj(sig) && Object.keys(sig).length ? validateSignalSpec(sig, "ctx.holds") : ["ctx.holds needs a non-empty signal"];
      if (p.length) throw new StopError("config_error", problems(p).join("；"));
      pushEvent(trace, { call: "holds", ok: true, result: true });
      return true;
    },
    source: async (name) => {
      const obs: SourceObservationView = { counts: {}, selects: {}, rows: [] };
      pushEvent(trace, { call: "source", desc: name, result: { counts: {}, rows: 0 } });
      return obs;
    },
    data: {
      min: (rows, by) => pickRow(rows, by, "min"),
      max: (rows, by) => pickRow(rows, by, "max"),
    },
    run: (async (sourceOrStep: unknown, args?: string[], req?: unknown): Promise<StepResult> => {
      if (typeof sourceOrStep === "string") {
        const p = validateToolRun(sourceOrStep, args ?? [], req as never, false);
        if (p.length) throw new StopError("config_error", problems(p).join("；"));
        checkBudget();
        budget.stepsUsed += 1;
        pushEvent(trace, { call: "run", desc: (req as { desc?: string } | undefined)?.desc ?? sourceOrStep, ok: true, result: { source: sourceOrStep } });
        return { ok: true, evidence: { url: currentUrl, attempts: 1, elapsedMs: 0 } };
      }
      const step = sourceOrStep as Record<string, unknown>;
      if (step === null || typeof step !== "object" || Array.isArray(step)) {
        throw new StopError("config_error", "ctx.run: the declaration form needs an object");
      }
      if (step["done"] === undefined || typeof step["done"] !== "object" || step["done"] === null) {
        throw new StopError("config_error", "ctx.run: done signal is required");
      }
      const adapter = typeof step["adapter"] === "string" && step["adapter"]
        ? step["adapter"]
        : step["ssh"] !== undefined ? "ssh" : step["stdio"] !== undefined ? "stdio" : "cli";
      try { requireAppAdapter(adapter); } catch {
        throw new StopError("config_error", `ctx.run: unknown app adapter ${JSON.stringify(adapter)} (known: ${listAppAdapters().join(", ")})`);
      }
      checkBudget();
      budget.stepsUsed += 1;
      pushEvent(trace, { call: "run", desc: String(step["desc"] ?? `${adapter} step`), ok: true, result: { adapter } });
      return { ok: true, evidence: { url: currentUrl, attempts: 1, elapsedMs: 0 } };
    }) as Ctx["run"],
    dangerous: async (req) => {
      const p = validateToolRun(req?.source, req?.args, req as never, true);
      if (p.length) throw new StopError("config_error", problems(p).join("；"));
      checkBudget();
      budget.stepsUsed += 1;
      pushEvent(trace, { call: "dangerous", desc: req.desc, ok: true, result: { source: req.source } });
      return { ok: true, evidence: { url: currentUrl, attempts: 1, elapsedMs: 0 } };
    },
    done: async () => {
      pushEvent(trace, { call: "done", ok: true });
      return;
    },
  };
}

/** 工具步的声明面校验（dry 也要查：未知信号算子 / 危险步缺干跑，都该在 check 里红）。 */
function validateToolRun(
  source: unknown, args: unknown, req: { done?: unknown; dryRunArgs?: unknown },
  dangerous: boolean,
): string[] {
  const p: string[] = [];
  if (typeof source !== "string" || !source.trim()) p.push("source must be a non-empty string");
  if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) p.push("args must be a list of strings");
  if (req === null || typeof req !== "object" || req.done === undefined || req.done === null) {
    p.push("done signal is required");
  } else if (typeof req.done !== "object" || Array.isArray(req.done)) {
    p.push("done signal must be an object");
  } else {
    p.push(...validateToolSignal(req.done as never, "ctx.run"));
  }
  if (req !== null && typeof req === "object" && req.dryRunArgs !== undefined
    && (!Array.isArray(req.dryRunArgs) || req.dryRunArgs.some((a) => typeof a !== "string"))) {
    p.push("dryRunArgs must be a list of strings");
  }
  if (dangerous && (!Array.isArray(req?.dryRunArgs) || (req.dryRunArgs as unknown[]).length === 0)) {
    p.push("ctx.dangerous requires dryRunArgs (a failed dry run must never apply)");
  }
  return p;
}

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
