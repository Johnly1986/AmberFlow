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
import type { StateFingerprint, StepStateRecord } from "../engine/executor.ts";
import { validateObserveOptions, type ObserveResult } from "../engine/observe.ts";
import {
  declaredRunProblems,
  normalizeCommandIds, resolveCtxUrl, sameDeclaredPageHref, sameNavTarget, StopError,
  validateCollectRequest, validateExpandRequest, validateScrollListRequest, validateSetRangeRequest,
  validateSwitchTabMatch,
  type CollectResult, type Ctx, type CtxBudget, type ExpandOptions, type ExpandResult,
  type RangeValue, type ScrollListOptions, type ScrollListResult,
  type SetRangeOptions, type SetRangeResult, type SwitchTabResult, type TabInfo,
  type SourceObservationView, type StepRequest, type StepResult,
} from "./ctx.ts";
import type { TraceCall } from "./trace.ts";

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
  /** 声明过的槽位键（`validateCommands` 的 fill/select/upload/clickAt 绑定要对它查）。 */
  slotKeys: Set<string>;
  /**
   * S1：effect 读回开关（来自 `meta.policy.effect_readback`）。dry 用它决定 setRange 的
   * applied/accurate 是否出现——与真实面同一份声明，避免 check 盲区。
   */
  effectReadback?: { fill?: boolean; set_range?: boolean };
  /**
   * 导航纪律（`meta.policy.navigation`）：dry 与真实面同一判定——否则 `apps check`
   * 会放过一个真实运行必然 `navigation_forbidden` 的脚本（hosts 信封的同一条理由）。
   */
  navPolicy?: "entry-only" | "free";
  /**
   * P0-B：`meta.site.pages` 声明的页面 URL 清单（entry-only 的声明页再导航放行）。
   * dry 与真实面同一判定——否则 `ctx.openPage("home")` 回入口页的脚本在 check 期被假红。
   */
  declaredPages?: string[];
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
   * S3：**校验错误留痕**。dry 的校验器抛错前先落一条 `validation_error` 事件——脚本
   * `try/catch` 吞掉 config_error 时，`apps check` 仍能凭 trace 判 FAIL 并指出调用点
   * （r7 式盲区的修法）。未吞掉时 dryRunFlow 会去重，不产生重复 problem。
   */
  const validatePrimitive = (call: string, desc: string | undefined, check: () => void): void => {
    try {
      check();
    } catch (err) {
      pushEvent(trace, {
        call: "validation_error",
        ...(desc === undefined ? {} : { desc }),
        result: {
          call,
          desc: desc ?? null,
          message: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  };

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

  /**
   * dry 的导航纪律闸门（与真实 ctx 的 navGate 同一判定）：第一次直接导航 = 入口；
   * 之后目标须与当前 URL origin+path+query 全等（忽略 hash）。dry 没有真实 goto，
   * 每次过闸的调用即"成功落地"——过闸即计数。
   */
  const navOnly = deps.navPolicy === "entry-only";
  /** P0-B：声明页清单（与真实 ctx 同一口径：resolveCtxUrl + URL.href 全等）。 */
  const declaredPageHrefs = (deps.declaredPages ?? []).map(resolveCtxUrl);
  let dryDirectNavs = 0;
  const dryNavGate = (call: TraceCall, label: string, target: string): void => {
    if (!navOnly) return;
    if (dryDirectNavs === 0 || sameNavTarget(target, currentUrl)
      || sameDeclaredPageHref(target, declaredPageHrefs)) {
      dryDirectNavs += 1;
      return;
    }
    const diag = { policy: "entry-only", attempted: target, current: currentUrl };
    pushEvent(trace, { call, url: target, ok: false, stop_code: "navigation_forbidden", result: diag });
    throw new StopError("navigation_forbidden",
      `${label}: direct navigation to ${JSON.stringify(target)} is forbidden by meta.policy.navigation="entry-only"`
      + ` (current page ${JSON.stringify(currentUrl)}; only the first direct navigation of a run is the entry)`
      + ` ——导航必须经由页面元素（链接/按钮）完成；如确需直达请移除该 policy`);
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
    // F2：newTab 声明形状 dry 期就红（与真实面 assertAct 同文案）；dry 无浏览器，
    // 标签行为（新标签出现/采用/去重）只能在真实运行验证。
    if (req.newTab !== undefined && req.newTab !== null) {
      if (typeof req.newTab !== "object" || Array.isArray(req.newTab)) {
        p.push(`${where}: newTab must be an object like { urlContains: "p2" }`);
      } else {
        const uc = (req.newTab as Record<string, unknown>)["urlContains"];
        if (uc !== undefined && (typeof uc !== "string" || !uc.trim())) {
          p.push(`${where}: newTab.urlContains must be a non-empty string (case-insensitive URL substring used for tab adoption/dedup)`);
        }
      }
    }
    return p;
  };

  /**
   * S1 dry 合成状态：没有页面观察，epoch=0、struct 固定 "dry"、flags 恒空——
   * 形状与真实面同构（消费者不会因缺字段分叉），但**不假装**发生过状态推进。
   */
  const dryFingerprint = (): StateFingerprint => ({
    epoch: 0, navEpoch: 0, url: currentUrl, readyState: "complete", struct: "dry",
  });
  const dryState = (): StepStateRecord => {
    const fp = dryFingerprint();
    return { before: fp, after: fp, actions: { attempted: 0, executed: 0, changed: 0 }, flags: [] };
  };
  const recordStep = (desc: string, done?: unknown, ok = true, stopCode?: string, id?: string,
                      forceAct = false, force = false, staleRetry = false,
                      when?: unknown, newTab = false): StepResult => {
    checkBudget();
    budget.stepsUsed += 1;
    const state = dryState();
    pushEvent(trace, {
      call: "step", desc, url: currentUrl, ok,
      ...(id === undefined ? {} : { id }),
      ...(stopCode === undefined ? {} : { stop_code: stopCode }),
      // dry 的审计额外记**声明的完成条件**（它是计划数据，不是模型产出）：
      // `apps explain` 与"脚本 vs 既有 journey"对照都靠它。
      // A1：forceAct 是声明面——dry 只记录声明，不改变模拟（step 仍 ok:true，不重新决策）。
      // S4：force / staleRetry 同样是声明面——dry 只记 `forced` / `stale_retry`（布尔标记），
      //     不模拟重试、不改变 ok；真实面的重试证据是 trace 行上的数组，见 schema F22。
      // S1：state 是合成形状（见 dryState），保证 dry/真实消费者不分叉。
      result: {
        ...(done === undefined ? {} : { done }),
        // P0-E：when 声明进 dry 事件（weak_done lint 的对象面；运行期 when 求值不变）。
        ...(when === undefined || when === null ? {} : { when }),
        ...(forceAct ? { force_act: true } : {}),
        ...(force ? { forced: true } : {}),
        ...(staleRetry ? { stale_retry: true } : {}),
        // F2：newTab 是声明面——dry 只记 `new_tab: true`（不模拟标签行为：无浏览器，
        // 新标签出现/采用/去重只能真实运行验证）。
        ...(newTab ? { new_tab: true } : {}),
        state,
      },
    });
    return {
      ok, ...(id === undefined ? {} : { id }), ...(stopCode === undefined ? {} : { stopCode }),
      evidence: { url: currentUrl, attempts: 1, elapsedMs: 0 }, state,
    };
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
    // S1：dry 没有页面观察，epoch 是合成值 0（不假装有状态推进）。
    // dry:true（eval3 消歧义）：两面判据的契约值——真跑面（ctx.ts）恒 false，epoch 不作判据。
    runtime: Object.freeze({ ...runtime, epoch: 0, dry: true }),
    budget,
    log: (msg) => { pushEvent(trace, { call: "log", desc: msg }); },
    open: async (u) => {
      assertNotDone("ctx.open");
      assertNavigable(u, "ctx.open");
      const url = resolveCtxUrl(u);
      assertHost(u, "ctx.open");
      dryNavGate("open", "ctx.open", url);
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
      dryNavGate("openPage", `ctx.openPage(${JSON.stringify(role)})`, resolved);
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
      dryNavGate("arrive", "ctx.arrive", resolved);
      currentUrl = resolved;
      checkBudget();
      budget.stepsUsed += 1;
      pushEvent(trace, { call: "arrive", desc: req?.desc, url: resolved, ok: true, ...(req?.id === undefined ? {} : { id: req.id }) });
      return { ok: true, ...(req?.id === undefined ? {} : { id: req.id }), evidence: { url: resolved, attempts: 1, elapsedMs: 0 } };
    },
    // A5 dry 桩：不访问浏览器，只有一个合成标签页；匹配语义与真实面同一份
    // （validateSwitchTabMatch/switchTabMatches），只是"当前 context"被钉成这一页。
    tabs: async () => {
      const pages: TabInfo[] = [{ index: 0, url: "(dry)", title: "(dry)", active: true }];
      pushEvent(trace, { call: "tab", desc: "tabs()", action: "list", pages, ok: true });
      return pages;
    },
    switchTab: async (match) => {
      assertNotDone("ctx.switchTab");
      const desc = isObj(match) && typeof match["urlContains"] === "string" ? match["urlContains"] : undefined;
      // dry 纪律：只验**声明形状**（与 step 的恒 ok：不验观察值同源）——match 是否命中真实标签
      // 是观察事实，dry 没有标签列表，绝不据此把合法脚本判红。形状错（未知键/空 match/非法值）
      // 仍在这里结构化 config_error。
      validatePrimitive("ctx.switchTab", desc, () => {
        validateSwitchTabMatch(match);
      });
      checkBudget();
      budget.stepsUsed += 1;
      const target = { index: 0, url: "(dry)", title: "(dry)" };
      const from = currentUrl;
      currentUrl = target.url;
      const result: SwitchTabResult = { ok: true, ...target };
      pushEvent(trace, {
        call: "tab", desc: `switchTab(${JSON.stringify(match)})`, action: "switch",
        from: { url: from },
        to: target, pages: 1, args: match, ok: true,
        result: { dry: true, ...target },
      });
      return result;
    },
    // P0-A dry 桩：不访问浏览器；**参数形状真校验**（未知键/非法 max/空 selector 在 dry 期红），
    // 结果按文档合成形状返回（counts 全 0、elements []、dry:true）。非法 CSS 只有浏览器知道，
    // dry 不假装能判（与"dry 不验观察值"同一条纪律）。
    observe: async (opts = {}) => {
      validatePrimitive("ctx.observe", isObj(opts) && typeof opts["selector"] === "string" ? opts["selector"] : undefined,
        () => {
          const p = validateObserveOptions(opts);
          if (p.length) throw new StopError("config_error", p.join("；"));
        });
      const result: ObserveResult = {
        ok: true, dry: true, url: currentUrl,
        counts: { elements: 0, admitted: 0, omitted: 0 }, truncated: false, elements: [],
      };
      pushEvent(trace, {
        call: "observe", url: currentUrl, ok: true, counts: result.counts, truncated: false,
        result: { dry: true },
      });
      return result;
    },
    step: async (desc, req) => {
      const p = validateStep(`ctx.step(${JSON.stringify(desc)})`, req);
      if (p.length) throw new StopError("config_error", problems(p).join("；"));
      const effectiveUrl = req.url ?? (currentUrl === "about:blank" ? undefined : currentUrl);
      if (req.url !== undefined) assertNavigable(req.url, `ctx.step(${JSON.stringify(desc)})`);
      if (effectiveUrl !== undefined) assertHost(effectiveUrl, `ctx.step(${JSON.stringify(desc)})`);
      if (req.url !== undefined) {
        const resolved = resolveCtxUrl(req.url);
        dryNavGate("step", `ctx.step(${JSON.stringify(desc)})`, resolved);
        currentUrl = resolved;
      }
      return recordStep(desc, req.done, true, undefined, req.id,
        req.forceAct === true, req.force === true, req.staleRetry === true, req.when,
        req.newTab !== undefined && req.newTab !== null);
    },
    // A3 dry 桩：**参数校验真做**（未知形状/非法值在 dry 期红），动作与结果按文档形状确定性模拟。
    // S3：校验抛错前先落 `validation_error`（见 validatePrimitive），吞错也逃不过 apps check。
    scrollList: async (target, opts = {}) => {
      validatePrimitive("ctx.scrollList", typeof target === "string" ? target : undefined,
        () => validateScrollListRequest(target, opts));
      checkBudget();
      budget.stepsUsed += 1;
      const result: ScrollListResult = { ok: true };
      pushEvent(trace, { call: "scrollList", desc: target, ok: true, args: { target, opts }, result });
      return result;
    },
    expand: async (target, opts) => {
      validatePrimitive("ctx.expand", typeof target === "string" ? target : undefined,
        () => validateExpandRequest(target, opts));
      checkBudget();
      budget.stepsUsed += 1;
      const result: ExpandResult = {
        ok: true, clicks: 0, before: 0, after: 0, grew: false, stable: true, coverage: { rows: 0 },
      };
      pushEvent(trace, { call: "expand", desc: target, ok: true, args: { target, opts }, result });
      return result;
    },
    setRange: async (target, value, opts = {}) => {
      validatePrimitive("ctx.setRange", typeof target === "string" ? target : undefined,
        () => validateSetRangeRequest(target, value, opts));
      checkBudget();
      budget.stepsUsed += 1;
      // S1：effect 读回的合成值（dry 不动作，但字段形状必须与真实面同构）。
      // 策略关掉读回时同样不给字段——开关语义在 dry 面也成立。
      const readback = deps.effectReadback?.set_range !== false;
      const result: SetRangeResult = {
        ok: true,
        ...(readback ? { applied: true, accurate: true } : {}),
      };
      pushEvent(trace, { call: "setRange", desc: target, ok: true, args: { target, value, opts }, result });
      return result;
    },
    // S3 dry 桩：collect 计 1 flow step，参数校验真做，返回文档形状（stopReason 恒 "dry"）。
    collect: async (req) => {
      const desc = isObj(req) && typeof req["row"] === "string" ? req["row"] : undefined;
      validatePrimitive("ctx.collect", desc, () => validateCollectRequest(req));
      checkBudget();
      budget.stepsUsed += 1;
      const result: CollectResult = {
        rows: [],
        coverage: { rounds: 0, rowsSeen: 0, addedLastRound: 0 },
        stopReason: "dry",
      };
      pushEvent(trace, { call: "collect", desc: desc ?? "collect", ok: true, args: req, result });
      return result;
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
    // C2：dry 合成 {found:false, dry:true}——dry 没有页面，不假装命中。与 waitFor 的 dry
    // 「立即 true」口径不同：那是"信号已成立"的模拟，这里没有可模拟的命中事实，如实 not found
    // （差异写进 docs §4）。声明形状（hint 非空/visible 布尔）仍在这里红——dry 与真实面同文案。
    waitForTarget: async (hint, opts = {}) => {
      if (typeof hint !== "string" || !hint.trim()) {
        throw new StopError("config_error", "ctx.waitForTarget: hint must be a non-empty string");
      }
      if (opts.visible !== undefined && typeof opts.visible !== "boolean") {
        throw new StopError("config_error", "ctx.waitForTarget: visible must be a boolean");
      }
      const timeoutMs = Math.max(0, Number(opts.timeoutMs ?? 15_000));
      const pollMs = Math.max(1, Number(opts.pollMs ?? 200));
      pushEvent(trace, {
        call: "waitForTarget", desc: hint, ok: false,
        result: { dry: true, hint, visible: opts.visible === true, timeout_ms: timeoutMs, poll_ms: pollMs, count: 0 },
      });
      return { found: false, count: 0, dry: true };
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
      // T7：未知顶层键/`signal` 冲突/done 必需——与运行期 ctx.ts 共用唯一一份校验器
      // （dry 与真跑同文案；未知键点名 unknown + known，不静默忽略）。
      const declaredProblems = declaredRunProblems(step);
      if (declaredProblems.length) {
        throw new StopError("config_error", declaredProblems.join("；"));
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
        // T7：工具信号载荷（path/want 类型、exit code 整数、正则可编译、文件路径类型）
        // 在 dry 期校验；坏载荷 = config_error，不是运行期静默 false。
        const sigProblems = validateToolSignal(step["done"] as never, "ctx.run.done");
        if (sigProblems.length) throw new StopError("config_error", sigProblems.join("；"));
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
    // 08-A3：与运行期 ctx.ts 的同款校验**逐字同文案**（含 ctx.run: 前缀）——双拦面只差外层命名空间。
    p.push(`ctx.run: retries=${retries} needs idempotent: true (re-running a process can be irreversible)`);
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
