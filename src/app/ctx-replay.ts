/**
 * L2 `ctx` 的 **replay 实现**：按一条已记录的 trace 重放，不重新决策。
 *
 * 用途：回归/审计（"这一版脚本在记录下来的那次运行里到底做了什么"）。
 * 纪律：**只重放、不猜**——调用序列、说明、URL 与 trace 不一致就结构化停因
 * （`trace_mismatch`），版本/输入不一致由 `replayCompatibility` 在进入前拒绝。
 */
import { StopError, type Ctx, type CtxBudget, type SourceObservationView, type StepResult } from "./ctx.ts";
import { createKit } from "./kit.ts";
import type { TraceCall, TraceEvent, AppTrace } from "./trace.ts";

export interface ReplayCtxDeps {
  pack: { id: string; label?: string; goal: string; hosts?: string[] | null; invariants?: Array<Record<string, unknown>> };
  slots: Record<string, string>;
  runtime: { outDir: string; runId: string; today: string };
  trace: AppTrace;
  maxSteps?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 构造函数返回 `{ctx, remaining}`：driver 用 `remaining` 判断"脚本少走了记录下来的调用"。 */
export function createReplayCtx(deps: ReplayCtxDeps): { ctx: Ctx; remaining: () => number } {
  const { pack, slots, runtime, trace } = deps;
  const budget: CtxBudget = { maxSteps: deps.maxSteps ?? 100, stepsUsed: 0, deadline: Number.POSITIVE_INFINITY };
  let cursor = 0;
  let currentUrl = "about:blank";

  const nextEvent = (call: TraceCall, expect: { desc?: string; url?: string } = {}): TraceEvent => {
    const ev = trace.events[cursor];
    if (ev === undefined) {
      throw new StopError("trace_mismatch", `replay: script calls ${call} at #${cursor + 1}, but the trace has only ${trace.events.length} event(s)`);
    }
    if (ev.call !== call) {
      throw new StopError("trace_mismatch", `replay: event #${cursor + 1} was ${JSON.stringify(ev.call)}, script now calls ${JSON.stringify(call)}`);
    }
    if (expect.desc !== undefined && ev.desc !== expect.desc) {
      throw new StopError("trace_mismatch", `replay: event #${cursor + 1} desc ${JSON.stringify(ev.desc)} ≠ script ${JSON.stringify(expect.desc)}`);
    }
    if (expect.url !== undefined && ev.url !== expect.url) {
      throw new StopError("trace_mismatch", `replay: event #${cursor + 1} url ${JSON.stringify(ev.url)} ≠ script ${JSON.stringify(expect.url)}`);
    }
    cursor += 1;
    return ev;
  };

  const stepResult = (ev: TraceEvent): StepResult => {
    const ok = ev.ok === true;
    return {
      ok,
      ...(ev.stop_code === undefined ? {} : { stopCode: ev.stop_code }),
      evidence: { url: ev.url ?? currentUrl, attempts: 1, elapsedMs: 0 },
    };
  };

  const consume = (): void => {
    budget.stepsUsed += 1;
    if (budget.stepsUsed > budget.maxSteps) {
      throw new StopError("budget_exceeded", `step budget exhausted while replaying: ${budget.stepsUsed}/${budget.maxSteps}`);
    }
  };

  const kitCtx = createKit();
  const ctx: Ctx = {
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
    log: (msg, data) => { nextEvent("log", { desc: msg }); void data; },
    open: async (u) => {
      // trace 里记的是**解析后**的 URL（file://），脚本给的是仓库相对路径——调用序列只比调用本身。
      nextEvent("open");
      currentUrl = u;
    },
    openPage: async (role) => {
      throw new StopError("config_error", `ctx.openPage(${JSON.stringify(role)}) is not available in this build; use ctx.open(url)`);
    },
    arrive: async (u, req) => {
      const ev = nextEvent("arrive", req.desc === undefined ? {} : { desc: req.desc });
      currentUrl = u;
      consume();
      return stepResult(ev);
    },
    step: async (desc, req) => {
      void req;
      const ev = nextEvent("step", { desc });
      consume();
      return stepResult(ev);
    },
    url: () => currentUrl,
    read: {
      text: async (sel) => {
        const ev = nextEvent("read", { desc: `text(${sel})` });
        return ev.result === null || ev.result === undefined ? null : String(ev.result);
      },
      value: async (sel) => {
        const ev = nextEvent("read", { desc: `value(${sel})` });
        return ev.result === null || ev.result === undefined ? null : String(ev.result);
      },
      count: async (sel) => {
        const ev = nextEvent("read", { desc: `count(${sel})` });
        return Number(ev.result ?? 0);
      },
    },
    holds: async (sig) => {
      void sig;
      const ev = nextEvent("holds");
      return ev.ok === true;
    },
    source: async (name) => {
      const ev = nextEvent("source", { desc: name });
      // trace 只记摘要（counts/行数），不记整张表：重放能对齐"调用发生过"，不重放数据内容。
      const summary = isObj(ev.result) ? ev.result : {};
      const obs: SourceObservationView = {
        counts: isObj(summary["counts"]) ? summary["counts"] as Record<string, number> : {},
        selects: {},
        rows: [],
      };
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
    done: async () => { nextEvent("done"); },
  };
  return { ctx, remaining: () => trace.events.length - cursor };
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
