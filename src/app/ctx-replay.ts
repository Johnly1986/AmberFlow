/**
 * L2 `ctx` 的 **replay 实现**：按一条已记录的 trace 重放，不重新决策。
 *
 * 用途：回归/审计（"这一版脚本在记录下来的那次运行里到底做了什么"）。
 * 纪律：**只重放、不猜**——调用序列、说明、URL 与 trace 不一致就结构化停因
 * （`trace_mismatch`），版本/输入不一致由 `replayCompatibility` 在进入前拒绝。
 */
import {
  StopError, validateCollectRequest, validateExpandRequest, validateExtractOptions,
  validateScrollListRequest, validateSetRangeRequest,
  validateSwitchTabMatch,
  type CollectCoverage, type CollectRequest, type CollectResult, type CollectStopReason,
  type Ctx, type CtxBudget, type ExpandOptions, type ExpandResult,
  type RangeValue, type ScrollListOptions, type ScrollListResult,
  type SetRangeOptions, type SetRangeResult, type SwitchTabResult, type TabInfo,
  type SourceObservationView, type StepResult,
} from "./ctx.ts";
import { createKit } from "./kit.ts";
import type { TraceCall, TraceEvent, AppTrace } from "./trace.ts";
import { canonicalJson } from "./trace.ts";
import { validateObserveOptions, type ObserveResult } from "../engine/observe.ts";
import { pickRow } from "./ctx-tool.ts";

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
    const rec = isObj(ev.result) ? ev.result : {};
    const recorded = typeof rec["reason"] === "string" ? rec["reason"] as string : undefined;
    // A1：动作执行证据按**录制值**回放（不重新决策）——旧 trace 没有这些键时整组省略，
    // 与记录那次运行的产物形状一致。
    const recExecuted = rec["executed"];
    const recActions = rec["executed_actions"];
    const recSkipped = rec["skipped_actions"];
    const recPreheld = rec["done_preheld"];
    const recWarnings = rec["warnings"];
    return {
      ok,
      ...(ev.id === undefined ? {} : { id: ev.id }),
      ...(ev.stop_code === undefined ? {} : { stopCode: ev.stop_code }),
      ...(recorded === undefined ? {} : { reason: recorded }),
      evidence: { url: ev.url ?? currentUrl, attempts: 1, elapsedMs: 0 },
      ...(typeof recExecuted === "boolean" ? { executed: recExecuted } : {}),
      ...(Array.isArray(recActions) ? { executed_actions: recActions as StepResult["executed_actions"] } : {}),
      ...(Array.isArray(recSkipped) ? { skipped_actions: recSkipped as StepResult["skipped_actions"] } : {}),
      ...(typeof recPreheld === "boolean" ? { done_preheld: recPreheld } : {}),
      ...(Array.isArray(recWarnings) ? { warnings: recWarnings as string[] } : {}),
    };
  };

  const consume = (): void => {
    budget.stepsUsed += 1;
    if (budget.stepsUsed > budget.maxSteps) {
      throw new StopError("budget_exceeded", `step budget exhausted while replaying: ${budget.stepsUsed}/${budget.maxSteps}`);
    }
  };

  /** A3 原语重放的参数一致性：录制 args 与脚本调用逐字段比对，不一致即 trace_mismatch。 */
  const assertPrimitiveArgs = (ev: TraceEvent, want: unknown): void => {
    const got = ev.args;
    if (canonicalJson(got) !== canonicalJson(want)) {
      throw new StopError("trace_mismatch",
        `replay: ${String(ev.call)} args differ at event #${ev.i}: recorded ${canonicalJson(got)} ≠ script ${canonicalJson(want)}`
        + "（重放不重新决策：改参数等于另一条流程，请重新录制）");
    }
  };

  /** 按录制值还原原语结果（不造假：ok/stopCode/指标全部来自录制事件）。 */
  const primitiveResult = <T extends { ok: boolean }>(ev: TraceEvent): T => {
    const rec = isObj(ev.result) ? ev.result : {};
    return { ...(rec as object), ok: ev.ok === true } as T;
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
    // S1：replay 没有活页面观察，epoch 给 0（同 dry 的合成口径——不伪造状态推进）。
    // dry:true（eval3 消歧义）：replay 与 dry 同属非真跑面，两面判据看 runtime.dry。
    runtime: Object.freeze({ ...runtime, epoch: 0, dry: true }),
    budget,
    log: (msg, data) => { nextEvent("log", { desc: msg }); void data; },
    open: async (u) => {
      // trace 里记的是**解析后**的 URL（file://），脚本给的是仓库相对路径——调用序列只比调用本身；
      // currentUrl 用 trace 里的值，保证 `ctx.url()` 在 dry/真实/replay 三处一致。
      const ev = nextEvent("open");
      currentUrl = typeof ev.url === "string" && ev.url ? ev.url : u;
    },
    openPage: async (role) => {
      const ev = nextEvent("openPage", { desc: role });
      if (typeof ev.url === "string" && ev.url) currentUrl = ev.url;
    },
    arrive: async (u, req) => {
      const ev = nextEvent("arrive", req.desc === undefined ? {} : { desc: req.desc });
      currentUrl = typeof ev.url === "string" && ev.url ? ev.url : u;
      consume();
      return stepResult(ev);
    },
    // A5：标签页事件按录制值回放——`tabs()`（action=list）免费；`switchTab`（action=switch）
    // 计 1 步并核对调用参数（录了什么就回放什么，不重新匹配页面）。
    tabs: async () => {
      const ev = nextEvent("tab");
      if (ev.action !== "list") {
        throw new StopError("trace_mismatch",
          `replay: event #${ev.i} is a tab ${JSON.stringify(ev.action ?? "?")} event, script now calls ctx.tabs()`);
      }
      const raw = Array.isArray(ev.pages) ? ev.pages : [];
      return raw.map((item, index): TabInfo => {
        const rec = isObj(item) ? item : {};
        return {
          index: typeof rec["index"] === "number" ? rec["index"] : index,
          url: typeof rec["url"] === "string" ? rec["url"] : "",
          title: typeof rec["title"] === "string" ? rec["title"] : "",
          active: rec["active"] === true,
        };
      });
    },
    switchTab: async (match) => {
      validateSwitchTabMatch(match);
      const ev = nextEvent("tab");
      if (ev.action !== "switch") {
        throw new StopError("trace_mismatch",
          `replay: event #${ev.i} is a tab ${JSON.stringify(ev.action ?? "?")} event, script now calls ctx.switchTab()`);
      }
      if (ev.args !== undefined) assertPrimitiveArgs(ev, match);
      consume();
      const to = isObj(ev.to) ? ev.to : {};
      const result: SwitchTabResult = {
        ok: true,
        index: typeof to["index"] === "number" ? to["index"] : -1,
        url: typeof to["url"] === "string" ? to["url"] : currentUrl,
        title: typeof to["title"] === "string" ? to["title"] : "",
      };
      currentUrl = result.url;
      return result;
    },
    // P0-A：observe 是免费只读事件——按录制值还原 `counts`/`truncated`（元素明细没进
    // trace，故 `elements: []`，不伪造观察值也不中断回放）。声明形状仍校验（坏脚本在
    // 重放期同样红）。
    observe: async (opts = {}) => {
      const problems = validateObserveOptions(opts);
      if (problems.length) throw new StopError("config_error", problems.join("；"));
      const ev = nextEvent("observe");
      if (typeof ev.url === "string" && ev.url) currentUrl = ev.url;
      const c: Record<string, unknown> = isObj(ev.counts) ? ev.counts : {};
      const counts = {
        elements: Number(c["elements"] ?? 0) || 0,
        admitted: Number(c["admitted"] ?? 0) || 0,
        omitted: Number(c["omitted"] ?? 0) || 0,
      };
      // 录制时是结构化错误（非法 selector）就照实回放：重放不猜、不把失败洗成成功。
      const recorded = isObj(ev.result) ? ev.result : {};
      if (ev.ok === false) {
        return {
          ok: false, replay: true, url: currentUrl, counts,
          truncated: ev.truncated === true, elements: [],
          ...(recorded["error"] === "bad_selector" ? { error: "bad_selector" as const } : {}),
          ...(typeof recorded["reason"] === "string" ? { reason: recorded["reason"] } : {}),
        };
      }
      const result: ObserveResult = {
        ok: true, replay: true, url: currentUrl, counts,
        truncated: ev.truncated === true || counts.omitted > 0,
        elements: [],
      };
      return result;
    },
    step: async (desc, req) => {
      void req;
      const ev = nextEvent("step", { desc });
      if (typeof ev.url === "string" && ev.url) currentUrl = ev.url;
      consume();
      return stepResult(ev);
    },
    // A3 原语重放：参数必须与录制一致（trace_mismatch），结果按录制值回放，不重新决策。
    scrollList: async (target, opts = {}) => {
      validateScrollListRequest(target, opts);
      const ev = nextEvent("scrollList", { desc: target });
      assertPrimitiveArgs(ev, { target, opts });
      consume();
      return primitiveResult<ScrollListResult>(ev);
    },
    expand: async (target, opts) => {
      validateExpandRequest(target, opts);
      const ev = nextEvent("expand", { desc: target });
      assertPrimitiveArgs(ev, { target, opts });
      consume();
      return primitiveResult<ExpandResult>(ev);
    },
    setRange: async (target, value: RangeValue, opts: SetRangeOptions = {}) => {
      validateSetRangeRequest(target, value, opts);
      const ev = nextEvent("setRange", { desc: target });
      assertPrimitiveArgs(ev, { target, value, opts });
      consume();
      return primitiveResult<SetRangeResult>(ev);
    },
    // S3：collect 也按录制值回放——参数（row/fields/until/dedupe/maxRounds）必须与录制一致，
    // 行数据来自 trace（不重新抽页面）；旧 trace 缺字段时给诚实空覆盖，不硬造。
    collect: async (req: CollectRequest) => {
      validateCollectRequest(req);
      const ev = nextEvent("collect", { desc: req.row });
      assertPrimitiveArgs(ev, req);
      consume();
      const rec = isObj(ev.result) ? ev.result : {};
      const rows = Array.isArray(rec["rows"]) ? (rec["rows"] as Array<Record<string, string>>) : [];
      const cov = isObj(rec["coverage"]) ? rec["coverage"] : {};
      const coverage: CollectCoverage = {
        rounds: Number(cov["rounds"] ?? 0) || 0,
        rowsSeen: Number(cov["rowsSeen"] ?? rows.length) || 0,
        addedLastRound: Number(cov["addedLastRound"] ?? 0) || 0,
      };
      const stopReason = typeof rec["stopReason"] === "string"
        ? rec["stopReason"] as CollectStopReason : "stable";
      return { rows, coverage, stopReason } as CollectResult;
    },
    manual: async (desc, req) => {
      const ev = nextEvent("manual", { desc });
      if (typeof ev.url === "string" && ev.url) currentUrl = ev.url;
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
      attr: async (sel, attr) => {
        const ev = nextEvent("read", { desc: `attr(${sel}, ${attr})` });
        return ev.result === null || ev.result === undefined ? null : String(ev.result);
      },
    },
    holds: async (sig) => {
      void sig;
      const ev = nextEvent("holds");
      return ev.ok === true;
    },
    waitFor: async (sig, opts) => {
      void sig; void opts;
      const ev = nextEvent("waitFor");
      return ev.ok === true;
    },
    // C2：重放按 (call, desc=hint) 对齐事件；found/count 从录制的事件原样还原。
    waitForTarget: async (hint, opts) => {
      void opts;
      const ev = nextEvent("waitForTarget", { desc: hint });
      const res = isObj(ev.result) ? ev.result : {};
      return { found: ev.ok === true, count: Number(res["count"] ?? 0) };
    },
    source: async (name, opts) => {
      void opts;
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
    rows: async () => {
      throw new StopError("config_error", "ctx.rows is closed in v1 (Q5: no new extraction grammar); "
        + "declare named row extraction in meta.site.listExtract and call ctx.extract(name)");
    },
    extract: async (nameOrSpec, extractOpts) => {
      // C1：第二参只做声明校验（与真实/dry 同一份文案）；重放仍按 (call, desc) 对齐，
      // 不因 offset 改变事件匹配（录制的行数据原样回放，不重新抽页面）。
      validateExtractOptions(nameOrSpec, extractOpts);
      const desc = typeof nameOrSpec === "string"
        ? nameOrSpec
        : isObj(nameOrSpec) && typeof nameOrSpec["rows"] === "string"
          ? `inline:${nameOrSpec["rows"]}`
          : "";
      const ev = nextEvent("extract", { desc });
      const rec = isObj(ev.result) ? ev.result : {};
      const rows = Array.isArray(rec["rows"]) ? (rec["rows"] as Array<Record<string, string>>) : [];
      return rows;
    },
    run: (async (sourceOrStep: unknown, args?: string[], req?: unknown): Promise<StepResult> => {
      void args;
      const desc = typeof sourceOrStep === "string"
        ? (req as { desc?: string } | undefined)?.desc
        : (typeof (sourceOrStep as Record<string, unknown>)["desc"] === "string"
            ? String((sourceOrStep as Record<string, unknown>)["desc"])
            : undefined);
      const ev = nextEvent("run", desc === undefined ? {} : { desc });
      consume();
      return stepResult(ev);
    }) as Ctx["run"],
    dangerous: async (req) => {
      const ev = nextEvent("dangerous", { desc: req.desc });
      consume();
      return stepResult(ev);
    },
    fail: (code, reason) => {
      throw new StopError(typeof code === "string" && code.trim() ? code : "flow_failed", reason ?? "");
    },
    done: async () => { nextEvent("done"); },
  };
  return { ctx, remaining: () => trace.events.length - cursor };
}
