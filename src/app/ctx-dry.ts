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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { disallowedHost } from "../engine/executor.ts";
import { REPO } from "../flow/flow.ts";
import { validateSignalSpec } from "../engine/signals.ts";
import { validateCommands } from "../engine/actions.ts";
import { validateToolSignal } from "../browser/tool-signals.ts";
import { createKit, type CommandDecl } from "./kit.ts";
import { pushEvent, type AppTrace } from "./trace.ts";
import { getAppAdapter, listAppAdapters, requireAppAdapter } from "./app-adapters.ts";
import { defaultDates, defaultDatesSlotNames, loadSource, parseDatesValue, ValueError } from "../data/datasource.ts";
import {
  normalizeCommandIds, resolveCtxUrl, StopError,
  type Ctx, type CtxBudget, type SourceObservationView, type StepRequest, type StepResult,
} from "./ctx.ts";

export interface DryCtxDeps {
  pack: {
    id: string; label?: string; goal: string; hosts?: string[] | null;
    invariants?: Array<Record<string, unknown>>;
    site?: { pages?: Record<string, string>; listExtract?: Record<string, { rows: string; fields: Record<string, string> }> };
    /** 数据腿回写槽位的键集（环封口校验用，与 live ctx 同一规则）。 */
    source_slots?: Record<string, unknown> | null;
  };
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
  let doneCalled = false;

  /**
   * dry 也执行 **hosts 信封**（与真实 ctx 同一判定）：否则 `apps check` 会放过一个
   * 真实运行必然 `host_not_allowed` 的脚本——那是"dry 假绿"（实测：openPage/arrive/step 都漏）。
   */
  const assertNotDone = (label: string): void => {
    if (doneCalled) throw new StopError("config_error", `${label}: ctx.done() was already called; no actions after the end-state acceptance`);
  };

  /**
   * dry 的静态可判定项：**仓库内相对路径**必须存在（真跑 `goto` 会 ERR_FILE_NOT_FOUND）。
   * 带 scheme 的 URL（http/file 绝对路径/运行时产物）不做存在性检查——它们可能由前序步骤生成。
   */
  const assertNavigable = (rawUrl: string, label: string): void => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(rawUrl)) return;
    // 与真实导航同口径：`?query`/`#hash` 是查询，不是文件名的一部分。
    let file: string;
    try {
      file = fileURLToPath(new URL(`file://${path.resolve(REPO, rawUrl)}`));
    } catch {
      return;
    }
    if (!fs.existsSync(file)) {
      throw new StopError("config_error",
        `${label}: ${JSON.stringify(rawUrl)} does not exist under the repo root (dry check; the real run would fail to open it)`);
    }
  };

  const assertHost = (rawUrl: string, label: string): void => {
    if (!hosts || hosts.length === 0) return;
    const url = resolveCtxUrl(rawUrl);
    if (disallowedHost(url, hosts)) {
      throw new StopError("host_not_allowed",
        `${label}: ${JSON.stringify(url)} is outside the declared hosts envelope (${hosts.join(", ")})`);
    }
  };

  const validateStep = (where: string, req: StepRequest): string[] => {
    const p: string[] = [];
    if (req.done === undefined || req.done === null || !isObj(req.done) || !Object.keys(req.done).length) {
      p.push(`${where}: done signal is required`);
    } else {
      p.push(...validateSignalSpec(req.done, where));
    }
    if (req.act !== undefined && req.act !== null) {
      if (Array.isArray(req.act)) {
        for (const c of req.act) {
          if (!isObj(c) || typeof c.op !== "string") { p.push(`${where}: command needs {op, ...} (build with kit.command())`); continue; }
        }
        validateCommands(normalizeCommandIds(req.act as CommandDecl[]), where, p, deps.slotKeys);
      } else if (!isObj(req.act) || (req.act.kind !== "hint" && req.act.kind !== "hints")) {
        p.push(`${where}: act must be kit.hint()/kit.hints() or an array of kit.command(...)`);
      } else if (req.act.kind === "hint") {
        if (typeof req.act.hint !== "string" || !req.act.hint.trim()) p.push(`${where}: hint must be a non-empty string`);
      } else if (!Array.isArray(req.act.hints) || !req.act.hints.length) {
        p.push(`${where}: hints must be a non-empty list`);
      }
    }
    if (req.when !== undefined && req.when !== null) p.push(...validateSignalSpec(req.when, `${where}.when`));
    return p;
  };

  const recordStep = (desc: string, done?: unknown, ok = true, stopCode?: string, id?: string): StepResult => {
    checkBudget();
    budget.stepsUsed += 1;
    pushEvent(trace, {
      call: "step", desc, url: currentUrl, ok,
      ...(id === undefined ? {} : { id }),
      ...(stopCode === undefined ? {} : { stop_code: stopCode }),
      // dry 的审计额外记**声明的完成条件**（它是计划数据，不是模型产出）：
      // `apps explain` 与"脚本 vs 既有 journey"对照都靠它。
      ...(done === undefined ? {} : { result: { done } }),
    });
    return { ok, ...(id === undefined ? {} : { id }), ...(stopCode === undefined ? {} : { stopCode }), evidence: { url: currentUrl, attempts: 1, elapsedMs: 0 } };
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
      assertNotDone("ctx.open");
      assertNavigable(u, "ctx.open");
      const url = resolveCtxUrl(u);
      assertHost(u, "ctx.open");
      currentUrl = url;
      pushEvent(trace, { call: "open", url });
    },
    openPage: async (role) => {
      assertNotDone("ctx.openPage");
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
      assertNavigable(url, `ctx.openPage(${JSON.stringify(role)})`);
      assertHost(url, `ctx.openPage(${JSON.stringify(role)})`);
      const resolved = resolveCtxUrl(url);
      currentUrl = resolved;
      pushEvent(trace, { call: "openPage", desc: role, url: resolved });
    },
    arrive: async (u, req) => {
      assertNotDone("ctx.arrive");
      const p = [
        ...(isObj(req?.done) && Object.keys(req.done).length ? [] : [`ctx.arrive: done signal is required`]),
        ...(isObj(req?.done) && Object.keys(req.done).length ? validateSignalSpec(req.done, "ctx.arrive") : []),
      ];
      if (p.length) throw new StopError("config_error", p.join("；"));
      assertNavigable(u, "ctx.arrive");
      assertHost(u, "ctx.arrive");
      const resolved = resolveCtxUrl(u);
      currentUrl = resolved;
      checkBudget();
      budget.stepsUsed += 1;
      pushEvent(trace, { call: "arrive", desc: req?.desc, url: resolved, ok: true, ...(req?.id === undefined ? {} : { id: req.id }) });
      return { ok: true, ...(req?.id === undefined ? {} : { id: req.id }), evidence: { url: resolved, attempts: 1, elapsedMs: 0 } };
    },
    step: async (desc, req) => {
      const p = validateStep(`ctx.step(${JSON.stringify(desc)})`, req);
      if (p.length) throw new StopError("config_error", problems(p).join("；"));
      const effectiveUrl = req.url ?? (currentUrl === "about:blank" ? undefined : currentUrl);
      if (req.url !== undefined) assertNavigable(req.url, `ctx.step(${JSON.stringify(desc)})`);
      if (effectiveUrl !== undefined) assertHost(effectiveUrl, `ctx.step(${JSON.stringify(desc)})`);
      if (req.url !== undefined) currentUrl = resolveCtxUrl(req.url);
      return recordStep(desc, req.done, true, undefined, req.id);
    },
    manual: async (desc, req) => {
      assertNotDone(`ctx.manual(${JSON.stringify(desc)})`);
      if (req === null || typeof req !== "object" || req.done === undefined || req.done === null) {
        throw new StopError("config_error", "ctx.manual: done signal is required");
      }
      const p = validateSignalSpec(req.done, `ctx.manual(${JSON.stringify(desc)})`);
      if (p.length) throw new StopError("config_error", p.join("；"));
      checkBudget();
      budget.stepsUsed += 1;
      pushEvent(trace, {
        call: "manual", desc, url: currentUrl, ok: true,
        ...(req.id === undefined ? {} : { id: req.id }),
        result: { dry: true, instructions: req.instructions ?? "" },
      });
      return { ok: true, ...(req.id === undefined ? {} : { id: req.id }), evidence: { url: currentUrl, attempts: 1, elapsedMs: 0 } };
    },
    url: () => currentUrl,
    read: {
      text: async (sel) => { pushEvent(trace, { call: "read", desc: `text(${sel})`, result: null }); return null; },
      value: async (sel) => { pushEvent(trace, { call: "read", desc: `value(${sel})`, result: null }); return null; },
      count: async (sel) => { pushEvent(trace, { call: "read", desc: `count(${sel})`, result: 0 }); return 0; },
      attr: async (sel, attr) => {
        pushEvent(trace, { call: "read", desc: `attr(${sel}, ${attr})`, result: null });
        return null;
      },
    },
    holds: async (sig) => {
      const p = isObj(sig) && Object.keys(sig).length ? validateSignalSpec(sig, "ctx.holds") : ["ctx.holds needs a non-empty signal"];
      if (p.length) throw new StopError("config_error", problems(p).join("；"));
      pushEvent(trace, { call: "holds", ok: true, result: true });
      return true;
    },
    waitFor: async (sig, opts = {}) => {
      const p = isObj(sig) && Object.keys(sig).length
        ? validateSignalSpec(sig, "ctx.waitFor")
        : ["ctx.waitFor needs a non-empty signal"];
      if (p.length) throw new StopError("config_error", problems(p).join("；"));
      const timeoutMs = Math.max(0, Number(opts.timeoutMs ?? 15_000));
      const pollMs = Math.max(1, Number(opts.pollMs ?? 200));
      pushEvent(trace, { call: "waitFor", ok: true, result: { dry: true, timeout_ms: timeoutMs, poll_ms: pollMs } });
      return true;
    },
    source: async (name, sourceOpts = {}) => {
      if (typeof name !== "string" || !name.trim()) throw new StopError("config_error", "ctx.source: name must be a non-empty string");
      try {
        loadSource(name);        // 数据源配置在加载期校验（未知源名在这里就红，不等真跑）
      } catch (e) {
        throw new StopError("config_error", `ctx.source(${JSON.stringify(name)}): ${e instanceof Error ? e.message : String(e)}`);
      }
      // dry 也把日期参数过一遍：坏值/缺槽位/环引用在这里就红（与真跑同一文法），不等起腿。
      const src = loadSource(name);
      try {
        const producerSlots = new Set(Object.keys(deps.pack.source_slots ?? {}));
        for (const ph of defaultDatesSlotNames(src)) {
          if (producerSlots.has(ph)) {
            throw new ValueError(`source 的 default_dates 引用 {${ph}}，但 ${ph} 由数据腿回写`
              + `（source_slots）——数据腿参数不允许引用数据腿产物`);
          }
        }
        if (sourceOpts.dates !== undefined) {
          const raws = Array.isArray(sourceOpts.dates) ? sourceOpts.dates : [sourceOpts.dates];
          for (const r of raws) parseDatesValue(String(r), deps.runtime.today || undefined);
        } else {
          defaultDates(src, deps.slots, deps.runtime.today || undefined);
        }
      } catch (e) {
        throw new StopError("config_error", `ctx.source(${JSON.stringify(name)}): ${e instanceof Error ? e.message : String(e)}`);
      }
      const obs: SourceObservationView = { counts: {}, selects: {}, rows: [] };
      pushEvent(trace, { call: "source", desc: name, result: { counts: {}, rows: 0 } });
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
    extract: async (nameOrSpec) => {
      let extractName: string;
      if (typeof nameOrSpec === "string") {
        if (!nameOrSpec.trim()) throw new StopError("config_error", "ctx.extract: name must be a non-empty string");
        const spec = pack.site?.listExtract?.[nameOrSpec];
        if (spec === undefined) {
          const known = Object.keys(pack.site?.listExtract ?? {});
          throw new StopError("config_error",
            `ctx.extract(${JSON.stringify(nameOrSpec)}): meta.site.listExtract has no such entry`
            + ` (known: ${known.length ? known.join(", ") : "none declared"})`);
        }
        extractName = nameOrSpec;
      } else if (isObj(nameOrSpec) && typeof nameOrSpec["rows"] === "string" && nameOrSpec["rows"].trim()
          && isObj(nameOrSpec["fields"])) {
        extractName = `inline:${nameOrSpec["rows"]}`;
      } else {
        throw new StopError("config_error",
          "ctx.extract needs a declared name or { rows, fields, maxItems? } structure");
      }
      pushEvent(trace, { call: "extract", desc: extractName, result: { rows: [], truncated: false } });
      return [];
    },
    run: (async (sourceOrStep: unknown, args?: string[], req?: unknown): Promise<StepResult> => {
      if (typeof sourceOrStep === "string") {
        const p = validateToolRun(sourceOrStep, args ?? [], req as never, false);
        if (p.length) throw new StopError("config_error", problems(p).join("；"));
        try { loadSource(sourceOrStep); } catch (e) {
          throw new StopError("config_error", `ctx.run(${JSON.stringify(sourceOrStep)}): ${e instanceof Error ? e.message : String(e)}`);
        }
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
      if (adapter === "web") {
        throw new StopError("config_error", "ctx.run: the web adapter is not a process step; use ctx.step() for browser steps");
      }
      try { requireAppAdapter(adapter); } catch {
        throw new StopError("config_error", `ctx.run: unknown app adapter ${JSON.stringify(adapter)} (known: ${listAppAdapters().join(", ")})`);
      }
      // 让适配器自己的声明面校验跑一遍（ssh 缺 host / stdio 坏 script / 未知键都在 check 期红）。
      const adapterObj = getAppAdapter(adapter)!;
      if (adapter !== "cli") {
        const ap: string[] = [];
        adapterObj.validateStep({ ...step, signal: step["done"] }, "ctx.run", ap);
        if (ap.length) throw new StopError("config_error", ap.join("；"));
      } else {
        const src = typeof step["source"] === "string" ? step["source"] : "";
        if (!src.trim()) throw new StopError("config_error", "ctx.run: the cli form needs a non-empty source");
        try { loadSource(src); } catch (e) {
          throw new StopError("config_error", `ctx.run: ${e instanceof Error ? e.message : String(e)}`);
        }
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
    fail: (code, reason) => {
      throw new StopError(typeof code === "string" && code.trim() ? code : "flow_failed", reason ?? "");
    },
    done: async () => {
      if (doneCalled) throw new StopError("config_error", "ctx.done called twice");
      doneCalled = true;
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
  const retries = Number((req as { retries?: unknown })?.retries ?? 0);
  if (retries > 0 && (req as { idempotent?: unknown })?.idempotent !== true) {
    p.push(`retries=${retries} needs idempotent: true (re-running a process can be irreversible)`);
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
