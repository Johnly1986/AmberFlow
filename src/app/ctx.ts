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
  disallowedHost, type BrowserMiddleware, type BrowserSession, type ExecutedAction,
  type RunReport, type SkippedAction, type StepStateRecord,
} from "../engine/executor.ts";
import { validateCommands } from "../engine/actions.ts";
import { firstOf, framesOf, locatorAnyFrame, urlOf, extractElements, poolSniff, type FrameLike, type PageLike } from "../engine/extraction.ts";
// task-16（B3+）：arrive 侧限速判据的嗅探面选择器（与执行器同口径的准入面）。
import { admitSelectorWithJsFor } from "../engine/surface.ts";
// task-24/6a：限速判据阈值单一出处（step 侧与 arrive 侧共用）。
import { THROTTLE_BODY_FLOOR, THROTTLE_COLLAPSE_RATIO } from "../engine/throttle-signature.ts";
// C2 waitForTarget：hint 语义核对与规则面同一份语法（hintCandidates → hintMatch 单一出处）。
import { hintCandidates } from "../engine/rules.ts";
import { observePage, validateObserveOptions, type ObserveOptions, type ObserveResult } from "../engine/observe.ts";
import { checkSignal } from "../engine/signals.ts";
import { defaultDates, defaultDatesSlotNames, loadSource, parseDatesValue, runSource, ValueError } from "../data/datasource.ts";
import {
  validateReturns, type ReturnExtractor,
} from "./app-adapters.ts";
import type { DatasetStore } from "../engine/dataset.ts";
import { capToolText, stderrTail } from "./tool-artifact.ts";
import { REPO } from "../flow/flow.ts";
import { PageStateStore, type PageState } from "./page-state.ts";
import { createKit, type CommandDecl, type DomSignal, type TargetDecl, type ValueBinding } from "./kit.ts";
import { pushEvent, type AppTrace, type TraceCall } from "./trace.ts";
import { validateToolSignal, type ToolSignal } from "../browser/tool-signals.ts";
// B1 节奏统一：最小步间距（start-to-start）的核心计算在三脸共用的 support/pace.ts。
import { paceRemainder } from "../support/pace.ts";
import { sleepMs } from "../support/sleep.ts";
/** L2 运行期 ctx 的类型面与 StopError —— 拆到 ctx-types.ts（F1）。 */
import {
  StopError,
  type StepRequest, type StepEvidence, type ToolStepOutput, type StepResult,
  type ScrollListOptions, type ScrollListResult, type ExpandCount, type ExpandOptions,
  type ExpandResult, type RangeValue, type SetRangeOptions, type SetRangeResult,
  type CollectStopReason, type CollectRequest, type CollectCoverage, type CollectResult,
  type SourceObservationView, type ManualRequest, type TabInfo, type SwitchTabMatch,
  type SwitchTabResult, type CtxBudget, type ToolRunRequest, type ToolRunResult,
  type Ctx, type CtxDeps, type ExtractOptions,
} from "./ctx-types.ts";
export {
  StopError,
  type StepRequest, type StepEvidence, type ToolStepOutput, type StepResult,
  type ScrollListOptions, type ScrollListResult, type ExpandCount, type ExpandOptions,
  type ExpandResult, type RangeValue, type SetRangeOptions, type SetRangeResult,
  type CollectStopReason, type CollectRequest, type CollectCoverage, type CollectResult,
  type SourceObservationView, type ManualRequest, type TabInfo, type SwitchTabMatch,
  type SwitchTabResult, type CtxBudget, type ToolRunRequest, type ToolRunResult,
  type Ctx, type CtxDeps, type ExtractOptions,
};

/** L2 ctx 的原语参数校验面 —— 拆到 ctx-validate.ts（F1；真实/dry/replay 共用）。 */
import {
  isObj, resolveCtxUrl, assertAct, samePage, sameNavTarget, sameDeclaredPageHref,
  normalizeCommandIds, DECLARED_RUN_KEYS, declaredRunProblems, validateSwitchTabMatch,
  switchTabMatches, describeTabs, isSyntheticScrollTarget, validateScrollListRequest,
  validateExpandRequest, validateSetRangeRequest, validateCollectRequest, validateExtractOptions,
  validateWaitForTargetArgs, waitTiming, resolveRunAdapter, targetOptions,
} from "./ctx-validate.ts";
export {
  isObj, resolveCtxUrl, assertAct, samePage, sameNavTarget, sameDeclaredPageHref,
  normalizeCommandIds, DECLARED_RUN_KEYS, declaredRunProblems, validateSwitchTabMatch,
  switchTabMatches, describeTabs, isSyntheticScrollTarget, validateScrollListRequest,
  validateExpandRequest, validateSetRangeRequest, validateCollectRequest, validateExtractOptions,
  validateWaitForTargetArgs, waitTiming, resolveRunAdapter, targetOptions,
};

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
  /**
   * 导航纪律（`meta.policy.navigation:"entry-only"`；缺省/`"free"` 关 = 逐字节不变）。
   * 计数在**成功落地**时建立入口（`directNavs === 0` ⇒ 下一次直接导航按入口放行）：
   * 失败的直接导航不烧掉入口槽——同目标的下一次尝试仍按入口放行（重试语义保留）。
   * 页面驱动的跳转（点击/锚点/新标签页）不经过这里，永不拦截。
   */
  const navOnly = deps.navPolicy === "entry-only";
  /** P0-B：声明页清单（相对路径按 ctx URL 口径解析；仅 entry-only 参与判定）。 */
  const declaredPageHrefs = (deps.declaredPages ?? []).map(resolveCtxUrl);
  let directNavs = 0;
  const markDirectNavLanded = (): void => { if (navOnly && directNavs === 0) directNavs = 1; };
  /**
   * 入口之外的直接导航闸门：目标与当前页 origin+path+query 全等（忽略 hash）= 重试放行；
   * 其余 `navigation_forbidden`。先落 trace 证据事件，再抛带 `diagnostics` 的 StopError。
   * hosts 信封检查在其之前执行（既有优先级不变）。
   */
  const navGate = (call: TraceCall, label: string, target: string): void => {
    if (!navOnly) return;
    if (directNavs === 0 || sameNavTarget(target, currentUrl)
      || sameDeclaredPageHref(target, declaredPageHrefs)) return;
    const diag = { policy: "entry-only", attempted: target, current: currentUrl };
    pushEvent(trace, { call, url: target, ok: false, stop_code: "navigation_forbidden", result: diag });
    throw new StopError("navigation_forbidden",
      `${label}: direct navigation to ${JSON.stringify(target)} is forbidden by meta.policy.navigation="entry-only"`
      + ` (current page ${JSON.stringify(currentUrl)}; only the first direct navigation of a run is the entry,`
      + ` and later direct navigations must equal the current page's origin+path+query)`
      + ` ——导航必须经由页面元素（链接/按钮）完成；如确需直达请移除该 policy`,
      diag);
  };
  /** flow 运行期的单一 PageState 事实源（不是 Playwright page 对象的替代）。 */
  const pageState = new PageStateStore();
  /** `ctx.done()` 已验收：之后不许再有动作（结束态不变量必须在"结束"之后求值）。 */
  const assertOpen = (label: string): void => {
    if (closed) throw new StopError("config_error", `${label}: ctx.done() was already called; no actions after the end-state acceptance`);
  };

  const page = async (): Promise<PageLike> => {
    const s = await deps.ensureSession();
    return s.page as unknown as PageLike;
  };

  /**
   * A5：标签页枚举。Playwright 的 Page 在两条会话构造路径（`browser.newPage()` 的隐式
   * context / 设备声明的 `newContext`）上都能 `page.context().pages()` 枚举；替身可能
   * 把 context/pages 给成属性，两种形状都认。`isClosed()` 不可用或抛错的页面按关闭处理
   * （绝不对关掉的页做 title 读取/切换）。
   */
  type TabPage = PageLike & {
    title?(): Promise<string>;
    isClosed?(): boolean;
    bringToFront?(): Promise<void>;
    waitForLoadState?(state?: string, opts?: { timeout?: number }): Promise<void>;
  };
  const contextPages = async (session: BrowserSession): Promise<TabPage[]> => {
    const active = session.page as unknown as TabPage;
    const contextValue = (active as unknown as { context?: unknown }).context;
    const context = (typeof contextValue === "function"
      ? contextValue.call(active)
      : contextValue) as { pages?: ArrayLike<TabPage> | (() => ArrayLike<TabPage>) } | undefined;
    const raw = typeof context?.pages === "function" ? context.pages() : context?.pages;
    return Array.from(raw ?? []).filter((p) => {
      try { return p.isClosed?.() !== true; } catch { return false; }
    });
  };
  /** 标题读取有界（2s）：一个卡死的标签页不能拖住 tabs()/switchTab 的错误面。 */
  const titleOf = async (p: TabPage): Promise<string> => {
    if (typeof p.title !== "function") return "";
    const title = Promise.resolve().then(() => p.title!()).then((t) => String(t ?? "")).catch(() => "");
    return await Promise.race([title, sleepMs(2000).then(() => "")]);
  };
  const listTabs = async (session: BrowserSession): Promise<Array<TabInfo & { page: TabPage }>> => {
    const pages = await contextPages(session);
    const active = session.page as unknown as TabPage;
    const out: Array<TabInfo & { page: TabPage }> = [];
    for (const [index, p] of pages.entries()) {
      let url = "";
      try { url = urlOf(p) || ""; } catch { url = ""; }
      out.push({ index, url, title: await titleOf(p), active: p === active, page: p });
    }
    return out;
  };

  /** best-effort 的有界等待：超时/失败都不致命（切页事实已经发生）。 */
  const bounded = async (fn: () => Promise<unknown> | undefined, ms: number): Promise<void> => {
    try { await Promise.race([Promise.resolve().then(fn), sleepMs(ms)]); } catch { /* best effort */ }
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

  /**
   * B1 最小步间距（`meta.pace.between_steps_ms` / env 层）：相邻两次引擎单元
   * （step/arrive/manual/run/scrollList/expand/setRange/collect）**开始时刻**至少隔 gap
   * ——上一步耗时长则本步不补等（start-to-start ≥ gap，不是无条件 sleep）；首个单元之前
   * 不等（时钟未启动 = remainder 0）。等待量由 support/pace.ts 的 paceRemainder 计算。
   */
  let lastUnitStartTs: number | undefined;
  const paceBeforeStep = async (): Promise<void> => {
    const gap = deps.stepDelayMs ?? 0;
    if (gap <= 0) return;
    const now = Date.now();
    const wait = paceRemainder(gap, lastUnitStartTs, now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastUnitStartTs = now + wait;
  };

  /** 所有导航的唯一实现（open / openPage / arrive 共用；hosts 信封与导航纪律闸门在打开之前强制）。 */
  const navigate = async (
    rawUrl: string, call: "open" | "openPage" | "arrive", label: string,
    timeoutMs?: number, desc?: string, traceIt = true,
  ): Promise<void> => {
    assertOpen(label);
    const url = resolveCtxUrl(rawUrl);
    if (hosts && hosts.length && disallowedHost(url, hosts)) {
      throw new StopError("host_not_allowed", `${label}: ${JSON.stringify(url)} is outside the declared hosts envelope (${hosts.join(", ")})`);
    }
    navGate(call, label, url);
    const p = await page();
    try {
      await (p as unknown as { goto(u: string, o?: unknown): Promise<unknown> }).goto(
        url, { waitUntil: "domcontentloaded", timeout: timeoutMs ?? 30_000 },
      );
    } catch (e) {
      // 网络/可达性失败 ≠ 声明错误：DNS 解析失败、连接拒绝、导航超时都是「站点此刻
      // 不可达」，正确动作是验证可达后重试/放宽 --timeout，不是改声明。只有其余
      // 异常（如畸形 URL）才归 config_error（改声明，不要重试）。
      const msg = e instanceof Error ? e.message : String(e);
      if (/Timeout .*ms exceeded|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED|ERR_NAVIGATION_ABORTED/.test(msg)) {
        throw new StopError("unreachable",
          `${label}(${JSON.stringify(url)}) unreachable: ${msg}——先验证站点可达（curl/fetch），再放宽 --timeout 或稍后重试；不是声明错误，改 meta 无效`);
      }
      throw new StopError("config_error", `${label}(${JSON.stringify(url)}) failed: ${msg}`);
    }
    // 落地检查：请求 URL 过了信封不代表**最终页面**也过了（302/重定向可以跨主机）。
    const landed = urlOf(p);
    if (landed && hosts && hosts.length && disallowedHost(landed, hosts)) {
      throw new StopError("host_not_allowed",
        `${label}: landed on ${JSON.stringify(landed)} outside the declared hosts envelope (${hosts.join(", ")})`);
    }
    currentUrl = landed || url;
    markDirectNavLanded();
    pageState.update(p, "settled");
    if (traceIt) pushEvent(trace, { call, url: currentUrl, ...(desc === undefined ? {} : { desc }) });
  };

  const runOneStep = async (desc: string, req: {
    url?: string; done: DomSignal | Record<string, unknown>; act?: TargetDecl | CommandDecl[];
    slots?: Record<string, string>; values?: Record<string, string>;
    when?: DomSignal | null; id?: string; timeoutMs?: number;
    forceAct?: boolean; force?: boolean; staleRetry?: boolean;
    newTab?: { urlContains?: string };
  }): Promise<StepResult> => {
    assertOpen(`ctx.step(${JSON.stringify(desc)})`);
    checkBudget();
    await paceBeforeStep();
    const started = Date.now();
    const startUrl = resolveCtxUrl(req.url ?? currentUrl);
    if (hosts && hosts.length && disallowedHost(startUrl, hosts)) {
      throw new StopError("host_not_allowed", `ctx.step: ${JSON.stringify(startUrl)} is outside the declared hosts envelope (${hosts.join(", ")})`);
    }
    const session = await deps.ensureSession();
    // A6 walk 调试模式：步声明的 url 与当前页**同页**（origin+path 相同）=「起点 URL=当前页」
    // 的重锚，折叠成缺省「当前页」语义——不重导航（SPA 客户端状态跨步保留）；指向另一页的
    // 显式 url 仍然导航。默认（walk 关）逐字节不变：带 url 就导航。
    const walkKeepPage = deps.walk === true && req.url !== undefined
      && samePage(startUrl, urlOf(session.page) || currentUrl);
    // 导航纪律闸门（entry-only）：step 级 url 重锚是引擎发起的直接导航（执行器在
    // skipNavigation 关闭时 `pg.goto(startUrl)`）；walk 的同页重锚没有 goto，不进闸门。
    if (req.url !== undefined && !walkKeepPage) navGate("step", `ctx.step(${JSON.stringify(desc)})`, startUrl);
    if (req.url !== undefined && !walkKeepPage) currentUrl = startUrl;
    // ---- F2 newTab（缺省不声明 = 本块整体不存在，行为逐字节不变）----
    // ① 去重采用：动作前已存在 URL 命中 urlContains 的标签（此前尝试开的）→ 直接切过去、
    //    不再点击（act/决策动作整体跳过），done 在该标签上判定——消重复标签。
    //    信封外的命中标签不采用（与 switchTab/popup 同一判定），照常走动作路径。
    const nt = req.newTab;
    const ntActive = nt !== undefined && nt !== null;
    const ntContains = ntActive && typeof (nt as { urlContains?: unknown })["urlContains"] === "string"
      ? String((nt as { urlContains: string })["urlContains"]) : undefined;
    type NtTab = { index: number; url: string; title: string; adopted: "existing" | "opened" };
    let ntAdopted: NtTab | null = null;
    let ntAdoptedPage: TabPage | null = null;
    let ntSkipAction = false;
    let ntBeforePages: Set<unknown> | null = null;
    if (ntActive) {
      const listed = await listTabs(session);
      if (ntContains !== undefined && ntContains.trim()) {
        const hit = listed.find((t) => t.url.toLowerCase().includes(ntContains.toLowerCase()));
        if (hit && !(hosts && hosts.length && disallowedHost(hit.url, hosts))) {
          ntAdopted = { index: hit.index, url: hit.url, title: hit.title, adopted: "existing" };
          ntAdoptedPage = hit.page;
          ntSkipAction = true;
        }
      }
      if (!ntSkipAction) ntBeforePages = new Set<unknown>(await contextPages(session));
    }
    if (ntSkipAction && ntAdopted !== null && ntAdoptedPage !== null) {
      // 去重采用路径：不进执行器（零动作），done 只在采用的标签上求值（如实，不假装成功）。
      const before = urlOf(session.page as unknown as PageLike) || currentUrl;
      session.page = ntAdoptedPage as unknown as typeof session.page;
      currentUrl = ntAdopted.url;
      await bounded(() => (ntAdoptedPage as { bringToFront?: () => Promise<void> }).bringToFront?.(), 2000);
      await bounded(() => (ntAdoptedPage as { waitForLoadState?: (s?: string, o?: { timeout?: number }) => Promise<void> })
        .waitForLoadState?.("domcontentloaded", { timeout: 5000 }), 5000);
      let held = false;
      try {
        held = (await checkSignal(ntAdoptedPage as never, req.done as never)) === true;
      } catch (e) {
        throw new StopError("config_error",
          `ctx.step newTab dedup: done signal evaluation failed on the adopted tab: ${e instanceof Error ? e.message : String(e)}`);
      }
      budget.stepsUsed += 1;
      try { pageState.update(ntAdoptedPage, "settled"); } catch { /* 记录面让位事实 */ }
      const result: StepResult = {
        ok: held,
        ...(req.id === undefined ? {} : { id: req.id }),
        ...(held ? {} : { stopCode: "done_not_held" }),
        ...(held
          ? { reason: `newTab dedup: adopted existing tab ${JSON.stringify(ntAdopted.url)} (was ${JSON.stringify(before)}); done-signal held on it, no click performed` }
          : { reason: `newTab dedup: adopted existing tab ${JSON.stringify(ntAdopted.url)} (no click performed — a tab matching urlContains already existed) but the done-signal never held on it` }),
        newTab: ntAdopted,
        evidence: { url: ntAdopted.url, attempts: 1, elapsedMs: Date.now() - started },
      };
      record(held, {
        desc, url: ntAdopted.url,
        ...(req.id === undefined ? {} : { id: req.id }),
        ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
        result: {
          ok: held,
          ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          elapsed_ms: result.evidence.elapsedMs,
          new_tab: ntAdopted,
        },
      });
      return result;
    }
    const opts: Record<string, unknown> = {
      goalSignalFn: (p: unknown) => checkSignal(p as never, req.done as never),
      page: session.page,
      // 不带 url = 决策语句在当前页上执行；带 url 才先导航。整页重载会丢 SPA 状态。
      // walk 的同页重锚（walkKeepPage）走同一条「当前页」路径（A6）。
      ...(req.url === undefined || walkKeepPage ? { skipNavigation: true } : {}),
      poolReady: true,
      ...(deps.poolReadyTimeoutMs === undefined ? {} : { poolReadyTimeoutMs: deps.poolReadyTimeoutMs }),
      ...(deps.poolReadyPollMs === undefined ? {} : { poolReadyPollMs: deps.poolReadyPollMs }),
      ...(deps.poolGate === undefined ? {} : { poolGate: deps.poolGate }),
      ...(deps.surfacePolicy === undefined ? {} : { surfacePolicy: deps.surfacePolicy }),
      ...(req.timeoutMs === undefined
        // 04-F：步级 timeoutMs 以前声明了却从未接进执行器——现在映射到该步的 done 等待上限
        // （本次显式 > meta.policy.done_timeout_ms）。它约束的是"动作后等信号成立"的窗口，
        // 不约束整步挂钟时长（模型咨询/导航耗时不在其内）。
        // F3：显式 timeoutMs 同时是该步的**整步挂钟帽**（stepTimeoutMs）——reobserve/升级
        // 循环的每轮与总时长受它约束，超时 = 结构化 stop_timeout。未声明 = 无帽，不变。
        ? (deps.doneTimeoutMs === undefined ? {} : { doneTimeoutMs: deps.doneTimeoutMs })
        : { doneTimeoutMs: req.timeoutMs, stepTimeoutMs: req.timeoutMs }),
      ...(deps.donePollMs === undefined ? {} : { donePollMs: deps.donePollMs }),
      // 带 url 的步：domcontentloaded 对 SPA 太早，给面板一个短稳定窗口再抽取。
      // walk 同页重锚没有 goto（页面早已就位），与不带 url 的步同待遇。
      ...(req.url === undefined || walkKeepPage ? {} : { settleMs: 700 }),
      pw: session.pw,
      slots: { ...slots, ...(req.slots ?? {}) },
      // U1：步级显式值袋（缺省不出现 = 既有行为逐字节不变；执行器只在决策步值请求里用）。
      ...(req.values === undefined ? {} : { values: req.values }),
      verbose: deps.verbose === true,
    };
    if (req.when !== undefined && req.when !== null) opts["precondition"] = req.when;
    // P0-E：原始 done 声明进执行器（只读；false_done guard 的「弱 done 零前进」判定用）。
    opts["doneSpec"] = req.done as never;
    // A1 forceAct：只把声明透传给执行器（缺省不出现 = 既有行为不变；执行器只记录、不改变顺序）。
    if (req.forceAct === true) opts["forceAct"] = true;
    // S4：步级 force / staleRetry 同样是显式声明（缺省不出现 = 既有行为逐字节不变）。
    if (req.force === true) opts["force"] = true;
    if (req.staleRetry === true) opts["staleRetry"] = true;
    if (ntActive && !ntSkipAction && req.act !== undefined && !Array.isArray(req.act)
        && (req.act as { kind?: string }).kind === "hint") {
      // F2：newTab + 单条 act hint → 收敛为**恰好一次点击**的单命令闭集：点完即判 done，
      // done 不成立 = done_not_held（不再重试连点，避免同一动作开出一串重复标签）。
      // 命令 target 走既有声明解析链（池/ADMIT/FW8/DRF），hint 语义不变。
      const hint = String((req.act as { hint: string }).hint);
      const one: CommandDecl[] = normalizeCommandIds([{ id: "newtab_open", op: "click", target: hint }]);
      const problems: string[] = [];
      validateCommands(one, "ctx.step", problems);
      if (problems.length) throw new StopError("config_error", problems.join("；"));
      opts["commands"] = one;
    } else {
      Object.assign(opts, req.act === undefined ? {} : targetOptions(req.act));
    }
    let rep: RunReport;
    try {
      rep = await deps.mw().run(desc, startUrl, opts as never);
    } catch (e) {
      // 执行器把"动作失败"当结果而不是异常（既有语义）；走到这里只可能是配置级错误。
      throw new StopError("config_error", `ctx.step ${JSON.stringify(desc)} crashed: ${e instanceof Error ? e.message : String(e)}`);
    }
    deps.onRunReport?.(rep);
    budget.stepsUsed += 1;
    // ---- F2 newTab ②：动作后短暂等待新标签并自动采用（读面 + 动作面），done 在新标签上判定 ----
    // 声明了 newTab 且没有命中已存标签时执行；没有新标签出现 = rep 原样（正常 done 判定，
    // 如实失败）。已在途的 executor 轮询即"短暂等待"（动作后 done 窗口内新 tab 已 commit）。
    if (ntActive && !ntSkipAction) {
      try {
        const listed = await listTabs(session);
        const fresh = ntBeforePages === null ? [] : listed.filter((t) => !ntBeforePages!.has(t.page));
        if (fresh.length > 0) {
          const pick = (ntContains !== undefined && ntContains.trim()
            ? fresh.find((t) => t.url.toLowerCase().includes(ntContains.toLowerCase()))
            : undefined) ?? fresh[fresh.length - 1]!;
          // 信封外的新标签不采用（既有 popup 门禁已在执行器侧拒绝；这里只是不再重复处理）。
          if (!(hosts && hosts.length && disallowedHost(pick.url, hosts))) {
            session.page = pick.page as unknown as typeof session.page;
            await bounded(() => pick.page.bringToFront?.(), 2000);
            await bounded(() => pick.page.waitForLoadState?.("domcontentloaded", { timeout: 5000 }), 5000);
            ntAdopted = { index: pick.index, url: pick.url, title: pick.title, adopted: "opened" };
            ntAdoptedPage = pick.page;
            try {
              if ((await checkSignal(pick.page as never, req.done as never)) === true) {
                rep = { ...rep, done: true, stop_code: "dom_goal_signal",
                  stop_reason: "dom goal signal (new tab adopted; done judged on the adopted tab)" };
              } else {
                rep = { ...rep, done: false, stop_code: "done_not_held",
                  stop_reason: `new tab ${JSON.stringify(pick.url)} was opened and adopted (read+action face follow it), `
                    + `but the done-signal never held on the adopted tab — judged honestly there` };
              }
            } catch (e) {
              throw new StopError("config_error",
                `ctx.step newTab: done signal evaluation failed on the adopted tab: ${e instanceof Error ? e.message : String(e)}`);
            }
            try { pageState.update(pick.page, "settled"); } catch { /* 记录面让位事实 */ }
          }
        }
      } catch (e) {
        if (e instanceof StopError) throw e;
        // 标签枚举失败不吞掉执行器的既有结论（如实按 rep 判定）。
      }
    }
    // 动作可能导航到另一个页面；`ctx.step` 之后的下一条语句必须从**落地页**开始，
    // 否则 `ctx.step({url?})` 会把上一页当成当前页（实测：Maps 已打开，下一步却又回到 google.com）。
    const landed = urlOf(session.page) || startUrl;
    currentUrl = landed;
    // 入口只在**真的发生直接导航**时建立（无 url 的步没有 goto，不烧入口槽）。
    if (req.url !== undefined && !walkKeepPage) markDirectNavLanded();
    const landedState = pageState.update(session.page as unknown as PageLike, "settled");
    const reason = typeof rep.stop_reason === "string" && rep.stop_reason ? rep.stop_reason : undefined;
    // when 守卫不成立的步（rep.skipped）= “不适用”，不是“完成”：执行器在计划层把它记成
    // done 让流程前进，但 ctx.step 对作者返回 ok:false + stopCode="precondition_skipped"
    // （与 §4 文档和本文件 when 字段注释一致），脚本据 stopCode 分支。跳过步同样消耗预算。
    const skipped = rep.skipped === true;
    const result: StepResult = {
      ok: rep.done === true && !skipped,
      ...(req.id === undefined ? {} : { id: req.id }),
      ...(rep.stop_code === undefined ? {} : { stopCode: rep.stop_code }),
      ...(reason === undefined ? {} : { reason }),
      evidence: { url: landed, attempts: 1, elapsedMs: Date.now() - started, pageState: landedState },
      // A1 动作执行证据：执行器只在有事实时给字段，这里原样透出（缺省不硬造）。
      ...(rep.executed === undefined ? {} : { executed: rep.executed }),
      ...(rep.executed_actions === undefined ? {} : { executed_actions: rep.executed_actions }),
      ...(rep.skipped_actions === undefined ? {} : { skipped_actions: rep.skipped_actions }),
      ...(rep.stale_retries === undefined ? {} : { stale_retries: rep.stale_retries }),
      ...(rep.forced === undefined ? {} : { forced: rep.forced }),
      ...(rep.done_preheld === undefined ? {} : { done_preheld: rep.done_preheld }),
      ...(rep.warnings === undefined ? {} : { warnings: rep.warnings }),
      ...(rep.diagnostics === undefined ? {} : { diagnostics: rep.diagnostics }),
      // S1 状态记录：执行器只在本 run 有观察时给；原样透出（dry 面另有合成值）。
      ...(rep.state === undefined ? {} : { state: rep.state }),
      // F2 newTab：本步采用的新标签事实（缺字段 = 没声明 newTab 或没有标签被采用）。
      ...(ntAdopted === null ? {} : { newTab: ntAdopted }),
    };
    record(result.ok, {
      desc, url: landed,
      ...(req.id === undefined ? {} : { id: req.id }),
      ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
      result: {
        ok: result.ok,
        // 成功步不写 stop_code：`dom_goal_signal` 这类是执行器的“完成依据”停因，不是失败分类，
        // 放在名为 stop_code 的字段里会把成功读成失败（01 轮 B6）。完成动作证据在 hows/methods 行里。
        ...(result.ok ? {} : { stop_code: result.stopCode ?? null }),
        ...(reason === undefined ? {} : { reason }),
        elapsed_ms: result.evidence.elapsedMs,
        // PageState 的紧凑证据；不记 observedAt（每次运行都会变，不属于结构）。
        page_state: {
          page_id: landedState.pageId,
          readiness: landedState.readiness,
          pool_version: landedState.poolVersion,
          frame_origins: landedState.frameOrigins,
        },
        // A1：动作执行证据同样进 trace event 的 result——app-runner 的 step_traces 与
        // report.md 的动作证据小节都从这一份投影（缺省不出现，旧产物形状不变）。
        ...(result.executed === undefined ? {} : { executed: result.executed }),
        ...(result.executed_actions === undefined ? {} : { executed_actions: result.executed_actions }),
        ...(result.skipped_actions === undefined ? {} : { skipped_actions: result.skipped_actions }),
        ...(result.stale_retries === undefined ? {} : { stale_retries: result.stale_retries }),
        ...(result.forced === undefined ? {} : { forced: result.forced }),
        ...(result.done_preheld === undefined ? {} : { done_preheld: result.done_preheld }),
        ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
        ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
        ...(result.state === undefined ? {} : { state: result.state }),
        ...(ntAdopted === null ? {} : { new_tab: ntAdopted }),
      },
    });
    return result;
  };

  /**
   * 工具步结果的**唯一收口**（命令行/声明两形式共用）：有界 output、失败诊断、数据集回写、
   * trace 事件。三条纪律都在这里，脚本面无法绕过：
   *   - 返回值只在**信号成立**后写（`ok !== true` 一个都不写）；
   *   - `writtenBy = <id|desc>#<attempts>`（与声明式路径同一形状，审计能数到第几次尝试）；
   *   - 失败原因带底层证据（exit code + stderr 尾行），不是 `refusalLine` 空壳。
   */
  const finishToolRun = (
    r: ToolRunResult, started: number, call: "run" | "dangerous",
    desc: string, req: { source: string; id?: string; adapter?: string },
  ): StepResult => {
    const ok = r.ok === true;
    const stopCode = r.stopCode ?? (ok ? undefined : (r.refused ?? "tool_failed"));
    const attempts = r.attempts ?? 1;
    const elapsedMs = Date.now() - started;
    const out = capToolText(r.stdout);
    const err = capToolText(r.stderr);
    const tail = stderrTail(r.stderr);
    const reason = stopCode === undefined
      ? r.reason
      : toolFailureReason(stopCode, r.code, tail, r.reason);
    // 数据集回写（T2）：步标识必须是**稳定非空**字符串；`desc` 在两条入口都有缺省，不会空。
    const written: string[] = [];
    const stepKey = (req.id !== undefined && req.id.trim() ? req.id.trim() : desc).trim();
    if (ok && r.returns !== undefined && deps.dataset !== undefined && stepKey) {
      const writtenBy = `${stepKey}#${attempts}`;
      for (const [name, value] of Object.entries(r.returns)) {
        deps.dataset.write(name, value, writtenBy);
        written.push(name);
      }
    }
    const hasOutput = out.text.length > 0 || err.text.length > 0
      || (r.code !== null && r.code !== undefined);
    const isCli = req.adapter === undefined || req.adapter === "cli";
    const result: StepResult = {
      ok,
      ...(stepKey && req.id !== undefined ? { id: stepKey } : {}),
      ...(stopCode === undefined ? {} : { stopCode }),
      ...(reason === undefined ? {} : { reason }),
      ...(hasOutput ? {
        output: {
          code: r.code ?? null, stdout: out.text, stderr: err.text,
          ...(out.truncated || err.truncated ? { truncated: true as const } : {}),
        },
      } : {}),
      ...(r.artifact === undefined ? {} : { artifact: r.artifact }),
      evidence: { url: currentUrl, attempts, elapsedMs },
    };
    pushEvent(trace, {
      call, desc, ok,
      ...(stopCode === undefined ? {} : { stop_code: stopCode }),
      // 08-C：attempts/code/refused 进事件 result（投影面从这里读，不再只有脚本侧 evidence）。
      // T6：工具步至少带 code/ok（事件顶层 ok）/artifact/stderr_tail——失败不再是空壳。
      result: {
        source: req.source,
        ...(isCli ? {} : { adapter: req.adapter }),
        ...(stepKey && req.id !== undefined ? { id: stepKey } : {}),
        attempts, code: r.code ?? null, refused: r.refused ?? null,
        ...(isCli ? { dry_run: r.dryRun ?? null } : (r.dryRun === undefined ? {} : { dry_run: r.dryRun })),
        elapsed_ms: elapsedMs,
        ...(r.artifact === undefined ? {} : { artifact: r.artifact }),
        ...(tail === undefined ? {} : { stderr_tail: tail }),
        // T4：信号不成立的结构化诊断（path/类型/值摘要）也进 trace——投影面/报告从
        // 同一份事件重建，不再只剩「signal not held」。
        ...(stopCode !== undefined && r.reason !== undefined ? { reason: r.reason } : {}),
        ...(written.length > 0 ? { dataset_written: written } : {}),
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
    // T7：工具信号载荷的运行期兜底（与 dry 同一份校验器）。坏载荷是配置错误，
    // 不能落到 `checkToolSignal` 里静默 false。
    const signalProblems = validateToolSignal(req.done as ToolSignal, `ctx.run(${JSON.stringify(req.desc ?? source)}).done`);
    if (signalProblems.length) {
      throw new StopError("config_error", signalProblems.join("；"));
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
    // `returns` 只认既有 `ReturnExtractor` 声明面（缺失/形状错 = fail closed，不给模型开口子）。
    const returns = toolReturns(req.returns, `ctx.run(${JSON.stringify(req.desc ?? source)})`);
    assertOpen(`ctx.run` + (req.desc ? ` ${JSON.stringify(req.desc)}` : ""));
    checkBudget();
    await paceBeforeStep();
    const started = Date.now();
    let r: ToolRunResult;
    try {
      r = await deps.toolRunner({
        ...req, desc: req.desc ?? (dangerous ? `dangerous ${source}` : `run ${source}`),
        ...(req.id === undefined ? {} : { id: req.id.trim() || undefined }),
        returns, source, args, ...(dangerous ? { dangerous: true } : {}),
      });
    } catch (e) {
      // 工具源名/配置错（如 loadSource 抛）不能变成裸栈：给结构化 config_error。
      throw new StopError("config_error",
        `ctx.run: ${e instanceof Error ? e.message : String(e)}`);
    }
    budget.stepsUsed += 1;
    return finishToolRun(r, started, dangerous ? "dangerous" : "run",
      req.desc ?? source, { source, ...(req.id === undefined ? {} : { id: req.id }) });
  };
  /** 声明形式：挑适配器 → 交给驱动（与声明式 journey 同一套适配器实现）。 */
  const runDeclaredTool = async (step: Record<string, unknown>, dangerous: boolean): Promise<StepResult> => {
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      throw new StopError("config_error", "ctx.run: the declaration form needs an object like { stdio: {...}, done: {...} }");
    }
    const done = step["done"];
    // T7：未知顶层键/`signal` 冲突/done 必需在真实与 dry 两面念同一段文案
    // （`declaredRunProblems` 是唯一出处）。
    const declaredProblems = declaredRunProblems(step);
    if (declaredProblems.length) {
      throw new StopError("config_error", declaredProblems.join("；"));
    }
    const adapter = resolveRunAdapter(step);
    // `returns`/`id` 在两条分支（cli 委托 / 其它适配器直跑）前统一规范化一次。
    const declaredSource = typeof step["source"] === "string" ? step["source"] : "";
    const declaredDesc = typeof step["desc"] === "string" && step["desc"]
      ? step["desc"]
      : adapter === "cli" ? `cli:${declaredSource || "declared"}` : `${adapter} step`;
    const declaredReturns = toolReturns(step["returns"], `ctx.run(${JSON.stringify(declaredDesc)})`);
    const declaredId = typeof step["id"] === "string" && step["id"].trim() ? step["id"].trim() : undefined;
    if (adapter === "cli") {
      // 声明形式的 cli 步与命令行形式完全等价（args/dryRunArgs/idempotent/retries 都认）。
      const cliArgs = Array.isArray(step["args"]) ? (step["args"] as unknown[]).map(String) : [];
      const cliReq: ToolRunRequest = {
        desc: declaredDesc,
        source: declaredSource, done: done as Record<string, unknown>, adapter: "cli", rawStep: step,
        ...(declaredId === undefined ? {} : { id: declaredId }),
        ...(declaredReturns === null ? {} : { returns: declaredReturns }),
        ...(Array.isArray(step["dryRunArgs"]) ? { dryRunArgs: (step["dryRunArgs"] as unknown[]).map(String) } : {}),
        ...(step["idempotent"] === true ? { idempotent: true } : {}),
        ...(typeof step["retries"] === "number" ? { retries: step["retries"] } : {}),
        ...(dangerous ? { dangerous: true } : {}),
      };
      return runTool(declaredSource, cliArgs, cliReq, dangerous);
    }
    if (deps.toolRunner === undefined) throw new StopError("config_error", "ctx.run: no tool runner wired in this build");
    checkBudget();
    await paceBeforeStep();
    const started = Date.now();
    const desc = declaredDesc;
    let r: ToolRunResult;
    try {
      r = await deps.toolRunner({
        desc, source: declaredSource || `${adapter}:declared`,
        done: done as Record<string, unknown>, adapter, rawStep: step,
        ...(declaredId === undefined ? {} : { id: declaredId }),
        ...(declaredReturns === null ? {} : { returns: declaredReturns }),
        ...(dangerous ? { dangerous: true } : {}),
      });
    } catch (e) {
      throw new StopError("config_error", `ctx.run: ${e instanceof Error ? e.message : String(e)}`);
    }
    budget.stepsUsed += 1;
    return finishToolRun(r, started, dangerous ? "dangerous" : "run", desc, {
      source: declaredSource || `${adapter}:declared`,
      adapter,
      ...(declaredId === undefined ? {} : { id: declaredId }),
    });
  };

  /**
   * C2：抽取选择器的**唯一预检**（`ctx.extract` / `ctx.collect` 共用；每个调用入口一次，
   * 不逐字段逐行）。判定放在 `readRows` 入口（collect 先校验一次再在循环里跳过）。
   *
   * 为什么必须真付一次往返：CSS 由 Playwright 原生执行，`locator(sel)` 本身**不解析**
   * 选择器（解析在 driver 侧），所以只有一次 `count()` 才能把「非法选择器」与「合法但
   * 零命中」分开——前者此前被吞成 `""`/`[]`（假数据，最危险的静默形态），后者必须继续
   * 是 `""`/`[]`。代价：每次抽取 ≤ 1 + 字段数 次往返。
   *
   * 只把**解析错误**当配置错：掉帧/超时/页面已关闭等异常维持旧行为（绝不把执行面故障
   * 误报成选择器错）。`"."`（行自身）/`:scope`/`@attr` 不是子选择器，跳过。
   */
  const SELECTOR_PARSE_ERROR_RE =
    /(parsing (?:css )?selector|unexpected token|unknown engine|invalid (?:css )?selector|not a valid (?:css )?selector)/i;

  const selectorParseProblem = async (frame: FrameLike, selector: string): Promise<string | null> => {
    if (typeof frame.locator !== "function") return null;   // 替身页没有 locator：维持旧行为
    try {
      await frame.locator(selector).count();
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return SELECTOR_PARSE_ERROR_RE.test(msg) ? msg : null;
    }
  };

  const checkExtractSelectors = async (
    p: PageLike, rowSelector: string, fields: Record<string, string>, call: string,
  ): Promise<void> => {
    const frame = framesOf(p)[0]!;
    const rowBad = await selectorParseProblem(frame, rowSelector);
    if (rowBad !== null) {
      throw new StopError("config_error",
        `${call}: row selector ${JSON.stringify(rowSelector)} is not valid: ${rowBad}`,
        { bad_selector: { selector: rowSelector } });
    }
    for (const [field, cellSel] of Object.entries(fields)) {
      if (cellSel === "." || cellSel === ":scope" || (cellSel.startsWith("@") && cellSel.length > 1)) continue;
      const bad = await selectorParseProblem(frame, cellSel);
      if (bad !== null) {
        throw new StopError("config_error",
          `${call}: field ${JSON.stringify(field)} selector ${JSON.stringify(cellSel)} is not valid: ${bad}`,
          { bad_selector: { selector: cellSel, field } });
      }
    }
  };

  /**
   * 行抽取的**唯一实现**（`ctx.extract` 与 `ctx.collect` 共用）：对当前 DOM 取行对象。
   * 字段值 = 行内相对选择器的文本投影（表单控件回退 inputValue；"." = 行自身文本）。
   * 返回 `{ rows, total, truncated }`：`rows` = `all.slice(offset, offset + cap)`，
   * `total` = 当前匹配行总数，`truncated` = 本页之后还有行（`offset + rows.length < total`）。
   * C1：`offset` 只改读取起点；`offset = 0` 与引入分页之前逐字节一致（同一段 slice）。
   * C2：入口先做一次选择器解析预检（`opts.prevalidated` = 调用方已在入口校验过，如 collect
   * 的循环）；非法选择器 = 结构化 `config_error` + `diagnostics.bad_selector`。
   */
  const readRows = async (
    rowSelector: string, fields: Record<string, string>, cap = 500, offset = 0,
    opts: { call?: string; prevalidated?: boolean } = {},
  ): Promise<{ rows: Array<Record<string, string>>; total: number; truncated: boolean }> => {
    const call = opts.call ?? "ctx.extract";
    const p = await page();
    if (opts.prevalidated !== true) await checkExtractSelectors(p, rowSelector, fields, call);
    const rowsLoc = await locatorAnyFrame(p, rowSelector);
    const rows: Array<Record<string, string>> = [];
    if (rowsLoc === null) return { rows, total: 0, truncated: false };
    const all = rowsLoc.all === undefined ? null : await rowsLoc.all();
    if (all === null) {
      throw new StopError("config_error", "ctx.extract needs a Playwright locator (locator.all() is not available here)");
    }
    for (const row of all.slice(offset, offset + cap)) {
      const locators = row as {
        locator?: (s: string) => { first(): { innerText(o?: { timeout?: number }): Promise<string>; inputValue(o?: { timeout?: number }): Promise<string> } };
        innerText?: (o?: { timeout?: number }) => Promise<string>;
        getAttribute?: (name: string) => Promise<string | null>;
      };
      const rec: Record<string, string> = {};
      for (const [field, cellSel] of Object.entries(fields)) {
        let value = "";
        try {
          if (cellSel === "." || cellSel === ":scope") {
            if (typeof locators.innerText === "function") value = await locators.innerText({ timeout: 1500 });
          } else if (cellSel.startsWith("@") && cellSel.length > 1) {
            // task-24/3c：属性投影（opt-in——"@" 前缀）——读**行元素自身**的 attribute
            //（如 fields:{rating:"@aria-label"}；无子选择器、无行内回退；读不到 → "" 与现行为一致）。
            // 旧 fields（无 @ 前缀）逐字节不变。
            if (typeof locators.getAttribute === "function") {
              value = (await locators.getAttribute(cellSel.slice(1))) ?? "";
            }
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
    return { rows, total: all.length, truncated: offset + rows.length < all.length };
  };

  /**
   * S3 collect：把行元素所在容器的滚动推进一屏（最近可滚动祖先；否则页面滚动元素）。
   * 逐 frame 探测（行可能在可达的子 frame 里，同源/跨源均可定位）；找不到行 = found:false。
   */
  const scrollRowsContainer = async (
    rowSelector: string,
  ): Promise<{ found: boolean; scrollable: boolean; moved: boolean; atBottom: boolean }> => {
    const p = await page();
    for (const fr of framesOf(p)) {
      try {
        const raw = await fr.evaluate((sel: string) => {
          // 只用结构类型：本仓库 tsconfig 不含 DOM lib（页面侧形状走 structural cast）。
          type DomNode = {
            scrollTop: number; scrollHeight: number; clientHeight: number;
            parentElement: DomNode | null;
          };
          const g = globalThis as unknown as {
            document?: {
              querySelectorAll(s: string): { length: number; [index: number]: DomNode };
              documentElement: DomNode;
              scrollingElement?: DomNode | null;
              body: unknown;
            };
            getComputedStyle(e: DomNode): { overflowY?: string | null } | null;
          };
          const doc = g.document;
          if (!doc) return { found: false, scrollable: false, moved: false, atBottom: true };
          const rows = doc.querySelectorAll(sel);
          if (!rows.length) return { found: false, scrollable: false, moved: false, atBottom: true };
          let node: DomNode | null = rows[rows.length - 1]!;
          let container: DomNode | null = null;
          while (node !== null) {
            const cs = g.getComputedStyle(node);
            const oy = cs === null || cs === undefined ? "" : String(cs.overflowY || "");
            if ((oy === "auto" || oy === "scroll" || oy === "overlay")
              && node.scrollHeight > node.clientHeight + 2) { container = node; break; }
            node = node.parentElement;
          }
          if (container === null) {
            const se = doc.scrollingElement || doc.documentElement;
            if (se && se.scrollHeight > se.clientHeight + 2) container = se;
          }
          if (container === null) return { found: true, scrollable: false, moved: false, atBottom: true };
          const before = Number(container.scrollTop) || 0;
          const max = Math.max(0, Number(container.scrollHeight) - Number(container.clientHeight));
          const stepPx = Math.max(200, Math.floor((Number(container.clientHeight) || 0) * 0.8));
          container.scrollTop = Math.min(max, before + stepPx);
          const after = Number(container.scrollTop) || 0;
          return { found: true, scrollable: true, moved: after !== before, atBottom: after >= max - 2 };
        }, rowSelector);
        if (raw !== null && typeof raw === "object") {
          const rec = raw as Record<string, unknown>;
          if (rec["found"] === true) {
            return {
              found: true,
              scrollable: rec["scrollable"] === true,
              moved: rec["moved"] === true,
              atBottom: rec["atBottom"] === true,
            };
          }
        }
      } catch {
        continue;   // 跨源 frame：evaluate 抛错，跳过
      }
    }
    return { found: false, scrollable: false, moved: false, atBottom: true };
  };

  const kit = createKit();
  // S1：`runtime.epoch` 是**执行器游标**的只读投影（不自建第二份状态来源）。
  // `dry:false`（eval3 消歧义）：这是真跑面——dry/replay 的 ctx（ctx-dry/ctx-replay）自己给 true。
  const runtimeView = Object.freeze({
    outDir: runtime.outDir, runId: runtime.runId, today: runtime.today,
    get epoch(): number { return deps.mw().stateEpoch(); },
    dry: false,
  });
  const ctx: Ctx = {
    judge: kit.judge,
    tool: kit.tool,
    hint: kit.hint,
    hints: kit.hints,
    command: kit.command,
    value: kit.value,
    app: { id: pack.id, ...(pack.label === undefined ? {} : { label: pack.label }), goal: pack.goal },
    slots: Object.freeze({ ...slots }),
    runtime: runtimeView,
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
      await paceBeforeStep();
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
      // task-16（B3+）：in-arrive 塌缩读数——从首个非 held 轮次**之后**才开始（首个轮次即
      // held = 零新增读取），只留首/末两个读数（有界内存）。成功路径零新增。
      let seenNonHeld = false;
      let inArriveFirst: number | null = null;
      let inArriveLast: number | null = null;
      try {
        const p = await page();
        const pAny = p as unknown as { waitForTimeout?(ms: number): Promise<void>; evaluate(script: string): Promise<unknown> };
        do {
          const landed = urlOf(p);
          if (landed) {
            if (hosts && hosts.length && disallowedHost(landed, hosts)) { hostViolation = landed; break; }
            currentUrl = landed;
            pageState.update(p as PageLike, "settled");
          }
          try {
            if (await checkSignal(p as never, req.done as never)) { held = true; break; }
          } catch (e) { waitErr = e; break; }        // 坏信号 = 配置错误，别轮询到超时
          if (!seenNonHeld) seenNonHeld = true;
          else {
            try {
              const bl = Number(await pAny.evaluate("document.body ? document.body.innerText.length : 0"));
              if (Number.isFinite(bl)) {
                if (inArriveFirst === null) inArriveFirst = bl;
                inArriveLast = bl;
              }
            } catch { /* 观察让位事实 */ }
          }
          if (typeof pAny.waitForTimeout === "function") await pAny.waitForTimeout(200);
          else await new Promise((r) => setTimeout(r, 200));
        } while (Date.now() < deadline);
      } catch (e) { waitErr = e; }
      budget.stepsUsed += 1;
      const stopCode = held ? undefined : (hostViolation !== null ? "host_not_allowed" : "arrive_signal_not_held");
      const failReason = held ? undefined
        : hostViolation !== null
          ? `arrive: landed on ${JSON.stringify(hostViolation)} outside the declared hosts envelope (${hosts?.join(", ")})`
          : `arrive: navigation finished but done-signal never held within ${timeout}ms`
            + (waitErr instanceof Error ? ` (${waitErr.message})` : "");
      // 06-D：与 ctx.step 记录面同形——成功也留"到达依据"文案，嵌套 result 带 page_state；
      // 不为 arrive 伪造 method/hows（它没有决策流水，差异是语义不是缺陷）。
      // task-16（B3+）：arrive 失败路径的限速判据（与 B3 step 侧同构：峰值基线 + 骤降比例；
      // 成功路径零改动——held=true 不嗅探/无字段/无 warning）。基线 = executor 会话正文峰值
      // （B3 失败嗅探记账，零成功路径成本）。无峰值基线（本会话首个失败即 arrive）→ 如实
      // 不判：字段缺席，判读走 docs §10；该签名由知识层 site-facts 承载（两层分工）。
      let throttle: {
        evidence: {
          body_text: number; body_text_peak: number; ready_state: string;
          elapsed_ms: number; url: string; in_arrive_first?: number; in_arrive_last?: number;
        };
      } | null = null;
      if (!held && hostViolation === null && waitErr === undefined) {
        try {
          const p = await page();
          const s = await poolSniff(p as never, admitSelectorWithJsFor(deps.surfacePolicy));
          const peak = deps.mw().sessionBodyTextPeak();
          // task-24/6a：阈值单源化（throttle-signature.ts——step 侧与 arrive 侧共用）。
          const crossCollapse = peak >= THROTTLE_BODY_FLOOR
            && s.body_text * THROTTLE_COLLAPSE_RATIO <= peak;
          const inArriveCollapse = inArriveFirst !== null && inArriveFirst >= THROTTLE_BODY_FLOOR
            && inArriveLast !== null && inArriveLast * THROTTLE_COLLAPSE_RATIO <= inArriveFirst;
          if (crossCollapse || inArriveCollapse) {
            throttle = {
              evidence: {
                body_text: s.body_text,
                body_text_peak: peak,
                ready_state: String(s.ready_state ?? "unknown"),
                elapsed_ms: Date.now() - started,
                url: currentUrl,
                ...(inArriveFirst !== null ? { in_arrive_first: inArriveFirst } : {}),
                ...(inArriveLast !== null ? { in_arrive_last: inArriveLast } : {}),
              },
            };
          }
        } catch { /* 观察让位事实 */ }
      }
      const reason = held ? "arrive signal held" : failReason;
      let arrivedState: ReturnType<typeof pageState.update> | null = null;
      if (held) {
        try { arrivedState = pageState.update((await page()) as PageLike, "settled"); } catch { /* 记录面让位事实 */ }
      }
      const result: StepResult = {
        ok: held,
        ...(req.id === undefined ? {} : { id: req.id }),
        ...(stopCode === undefined ? {} : { stopCode }),
        ...(reason === undefined ? {} : { reason }),
        // task-16（B3+）：限速判据留痕（仅组合判据命中时出现；不新增 stopCode）。
        ...(throttle !== null ? { diagnostics: { throttle_suspect: throttle } } : {}),
        ...(throttle !== null ? {
          warnings: [`throttle_suspect: arrive 信号不成立且观测到正文塌缩`
            + `（峰值 ${throttle.evidence.body_text_peak} → 当前 ${throttle.evidence.body_text}）`
            + "——疑似站点限速/降频/风控分批。已知处置：冷却后重试、降频（拉大 meta.pace）、分批跑，"
            + "不绕过反爬；证据见 diagnostics.throttle_suspect"],
        } : {}),
        evidence: { url: currentUrl, attempts: 1, elapsedMs: Date.now() - started },
      };
      pushEvent(trace, {
        call: "arrive", desc: req.desc ?? label, url: currentUrl, ok: held,
        ...(req.id === undefined ? {} : { id: req.id }),
        ...(stopCode === undefined ? {} : { stop_code: stopCode }),
        result: { ok: held, ...(stopCode === undefined ? {} : { stop_code: stopCode }),
          ...(reason === undefined ? {} : { reason }), elapsed_ms: result.evidence.elapsedMs,
          ...(throttle !== null ? { diagnostics: { throttle_suspect: throttle } } : {}),
          ...(arrivedState === null ? {} : {
            page_state: {
              page_id: arrivedState.pageId,
              readiness: arrivedState.readiness,
              pool_version: arrivedState.poolVersion,
              frame_origins: arrivedState.frameOrigins,
            },
          }) },
      });
      return result;
    },
    // ---- P0-A observe：免费只读（不占预算/不 pace/不写盘/不进模型面/不改页面）----
    observe: async (opts = {}) => {
      // 声明面先校验（形状错误 = config_error；非法 CSS 不在这里判——那要浏览器才知道，
      // 且 observe 用结构化 {ok:false,error:"bad_selector"} 回报，不中断 flow）。
      const problems = validateObserveOptions(opts);
      if (problems.length) throw new StopError("config_error", problems.join("；"));
      const started = Date.now();
      const session = await deps.ensureSession();
      const result = await observePage(session.page as unknown as PageLike, opts, deps.surfacePolicy);
      // 只记摘要：counts + truncated + 判分样例（task-21/D-1：前 5 个元素 tag/label≤40/
      // hints≤3 的有界投影——0/5 判分所需字段的流式可见；全量明细仍只在 observe 返回值里，
      // result 装配时经 scrubSecrets 掩码）。
      const obsSample = (result.elements ?? []).slice(0, 5).map((e) => ({
        tag: String(e.tag ?? ""),
        label: String(e.label ?? "").slice(0, 40),
        ...(Array.isArray(e.hint_candidates) && e.hint_candidates.length > 0
          ? { hints: e.hint_candidates.slice(0, 3) } : {}),
      }));
      pushEvent(trace, {
        call: "observe", url: result.url, ok: result.ok,
        counts: result.counts, truncated: result.truncated,
        ...(result.ok && obsSample.length > 0 ? { elements_sample: obsSample } : {}),
        ...(result.ok ? {} : { result: { error: result.error, reason: result.reason } }),
      });
      if (deps.verbose === true) {
        // verbose 只打计数（不打印元素），与 trace 同一口径。
        console.log(`  [observe] ${result.url} elements=${result.counts.elements} admitted=${result.counts.admitted} omitted=${result.counts.omitted} (${Date.now() - started}ms)`);
      }
      return result;
    },
    // ---- A5 标签页：tabs() 免费只读；switchTab 计 1 flow step 且走 pace（与 step/arrive 同单元语义）----
    tabs: async () => {
      const session = await deps.ensureSession();
      const listed = await listTabs(session);
      const view: TabInfo[] = listed.map(({ index, url, title, active }) => ({ index, url, title, active }));
      pushEvent(trace, { call: "tab", desc: "tabs()", action: "list", pages: view, ok: true });
      return view;
    },
    switchTab: async (match) => {
      assertOpen("ctx.switchTab");
      validateSwitchTabMatch(match);
      checkBudget();
      await paceBeforeStep();
      const started = Date.now();
      const session = await deps.ensureSession();
      const before = urlOf(session.page as unknown as PageLike) || currentUrl;
      const listed = await listTabs(session);
      const matched = listed.filter((t) => switchTabMatches(t, match));
      if (matched.length !== 1) {
        const why = matched.length === 0
          ? "no tab matches"
          : `${matched.length} tabs match`;
        throw new StopError("config_error",
          `ctx.switchTab: ${why} ${JSON.stringify(match)} — expected exactly 1; current tabs: ${describeTabs(listed)}`
          + " (use ctx.tabs() to inspect; no implicit fallback to an arbitrary tab)");
      }
      const target = matched[0]!;
      // 导航信封：列表可以只读看到信封外页面，切过去不行（与 open/openPage 同一判定）。
      if (hosts && hosts.length && disallowedHost(target.url, hosts) !== null) {
        throw new StopError("host_not_allowed",
          `ctx.switchTab: ${JSON.stringify(target.url)} is outside the declared hosts envelope (${hosts.join(", ")})`
          + " — the tab was not activated");
      }
      session.page = target.page as unknown as typeof session.page;
      currentUrl = target.url;
      // Playwright 成熟做法：置前 + 有界等 domcontentloaded；两者失败都不致命（切页已是事实）。
      await bounded(() => target.page.bringToFront?.(), 2000);
      await bounded(() => target.page.waitForLoadState?.("domcontentloaded", { timeout: 5000 }), 5000);
      budget.stepsUsed += 1;
      try { pageState.update(target.page, "settled"); } catch { /* 记录面让位事实 */ }
      pushEvent(trace, {
        call: "tab", desc: `switchTab(${JSON.stringify(match)})`, action: "switch",
        from: { url: before },
        to: { index: target.index, url: target.url, title: target.title },
        pages: listed.length,
        args: match,
        ok: true,
        result: {
          index: target.index, url: target.url, title: target.title,
          elapsed_ms: Date.now() - started,
        },
      });
      return { ok: true as const, index: target.index, url: target.url, title: target.title };
    },
    step: async (desc, req) => {
      assertAct(req);
      return runOneStep(desc, { ...req, when: req.when ?? null });
    },
    // ---- A3 列表/范围原语：各计 1 flow step；内部 click/滚动不占预算（由 maxClicks/timeoutMs 兜底）----
    scrollList: async (target, opts = {}) => {
      validateScrollListRequest(target, opts);
      assertOpen("ctx.scrollList");
      checkBudget();
      await paceBeforeStep();
      const p = await page();
      budget.stepsUsed += 1;
      // F1：合成滚动目标（"document"/"body"/"html"/"window"，大小写不敏感）不进池、
      // 不做 hint 匹配——直接解析主滚动器执行同一套滚动语义；其余目标走既有容器路径
      // （池外回退 + 最近可滚动祖先），行为逐字节不变。
      const r = isSyntheticScrollTarget(target)
        ? await deps.mw().scrollDocument(
          p as never, opts.to ?? "bottom",
          { ...(opts.by === undefined ? {} : { by: opts.by }), ...(opts.settleMs === undefined ? {} : { settleMs: opts.settleMs }) },
        )
        : await deps.mw().scrollContainer(
          p as never, target, opts.to ?? "bottom",
          { ...(opts.by === undefined ? {} : { by: opts.by }), ...(opts.settleMs === undefined ? {} : { settleMs: opts.settleMs }) },
        );
      const result: ScrollListResult = {
        ok: r.ok,
        ...(r.scrollTop === undefined ? {} : { scrollTop: r.scrollTop }),
        ...(r.scrollHeight === undefined ? {} : { scrollHeight: r.scrollHeight }),
        ...(r.clientHeight === undefined ? {} : { clientHeight: r.clientHeight }),
        ...(r.moved === undefined ? {} : { moved: r.moved }),
        ...(r.stopCode === undefined ? {} : { stopCode: r.stopCode }),
        ...(r.reason === undefined ? {} : { reason: r.reason }),
      };
      pushEvent(trace, {
        call: "scrollList", desc: target, ok: result.ok,
        args: { target, opts },
        ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
        result,
      });
      try { pageState.update(p, "interactive"); } catch { /* 记录面让位事实 */ }
      return result;
    },
    expand: async (target, opts) => {
      validateExpandRequest(target, opts);
      assertOpen("ctx.expand");
      checkBudget();
      await paceBeforeStep();
      const p = await page();
      budget.stepsUsed += 1;
      // 行数只用 rows/selector 计数（`count.fields` 仅形状校验，不参与 expand 判定）：直接 DOM 计数
      // 而不走 ctx.read/extract——内部观察不应写成独立 trace 事件（否则 replay 要额外消费，
      // extract 还有 maxItems 截断）。coverage.rows = 最终 DOM 行数。
      const rowSelector = "rows" in opts.count ? opts.count.rows : opts.count.selector;
      const maxClicks = opts.maxClicks ?? 20;
      const stableRounds = opts.stableRounds ?? 2;
      const settleMs = opts.settleMs ?? 800;
      const timeoutMs = opts.timeoutMs ?? 60_000;
      const started = Date.now();
      const countRows = async (): Promise<number> => {
        try {
          const n = await p.evaluate!((sel: string) => {
            const g = globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } };
            return g.document.querySelectorAll(sel).length;
          }, rowSelector);
          return Number(n) || 0;
        } catch (e) {
          throw new StopError("config_error",
            `ctx.expand: row selector ${JSON.stringify(rowSelector)} is invalid (${e instanceof Error ? e.message : String(e)})`);
        }
      };
      const before = await countRows();
      let after = before;
      let clicks = 0;
      let grew = false;
      let stable = false;
      let stableCount = 0;
      let stopCode: string | undefined;
      let reason: string | undefined;
      let clickFailures = 0;
      let lastClickError: string | undefined;
      const mw = deps.mw();
      while (clicks < maxClicks && Date.now() - started < timeoutMs) {
        const act = await mw.actOnce(p as never, target, "click");
        clicks += 1;
        // 点击失败不立即判死：真站的"展开更多"在**到达展开上限**后会变成不可点
        //（Maps See more 实测：行数稳定后按钮仍在、但点击 timeout）。此时以"行数
        // 是否还在长"为准——等一拍重读，长出来的算异步到达，连续 stableRounds 轮
        // 不再长才算稳定（plateau 是这次调用的目标，grew/clicks 仍如实暴露）。
        if (!act.ok) {
          clickFailures += 1;
          lastClickError = act.reason ?? act.stopCode ?? "click failed";
        }
        if (settleMs > 0) await sleepMs(settleMs);
        const now = await countRows();
        if (now > after) { grew = true; stableCount = 0; } else { stableCount += 1; }
        after = now;
        if (stableCount >= stableRounds) { stable = true; break; }
      }
      if (!stable && stopCode === undefined) {
        stopCode = "expand_not_stable";
        reason = `stopped after ${clicks} click(s)/${Date.now() - started}ms without ${stableRounds} consecutive stable round(s) `
          + `(maxClicks=${maxClicks}, timeoutMs=${timeoutMs}, rows=${after})`
          + (clickFailures ? `; ${clickFailures} click(s) failed (last: ${lastClickError ?? "-"})` : "");
      } else if (stable && clickFailures > 0) {
        // 稳定但有点击失败：说明到顶后控件不可点（不是本调用的失败，但必须可解释）。
        reason = `rows stabilized at ${after} after ${clicks} click(s); ${clickFailures} click(s) failed `
          + `(last: ${lastClickError ?? "-"}) — the expand control no longer accepts clicks`;
      }
      const result: ExpandResult = {
        ok: stable, clicks, before, after, grew, stable,
        coverage: { rows: after },
        ...(stopCode === undefined ? {} : { stopCode }),
        ...(reason === undefined ? {} : { reason }),
      };
      pushEvent(trace, {
        call: "expand", desc: target, ok: result.ok,
        args: { target, opts },
        ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
        result,
      });
      try { pageState.update(p, "interactive"); } catch { /* 记录面让位事实 */ }
      return result;
    },
    setRange: async (target, value, opts = {}) => {
      validateSetRangeRequest(target, value, opts);
      assertOpen("ctx.setRange");
      checkBudget();
      await paceBeforeStep();
      const p = await page();
      budget.stepsUsed += 1;
      const r = await deps.mw().setRange(p as never, target, value, opts);
      // S1 effect 读回：`applied`/`accurate` 只在开关开着时出现（缺省开）。
      const readback = deps.effectReadback?.set_range !== false;
      const result: SetRangeResult = {
        ok: r.ok,
        ...(r.achieved === undefined ? {} : { achieved: r.achieved }),
        ...(r.strategy === undefined ? {} : { strategy: r.strategy }),
        ...(r.stopCode === undefined ? {} : { stopCode: r.stopCode }),
        ...(r.reason === undefined ? {} : { reason: r.reason }),
        ...(!readback || r.applied === undefined ? {} : { applied: r.applied }),
        ...(!readback || r.accurate === undefined ? {} : { accurate: r.accurate }),
        ...(!readback || r.target === undefined ? {} : { target: r.target }),
        // task-21/1a：requested/clamped_from/probe 透传（越界拒绝与键盘 probe 的证据链；
        // SetRangeResult 类型同步扩展）。
        ...(!readback || r.requested === undefined ? {} : { requested: r.requested }),
        ...(!readback || r.clamped_from === undefined ? {} : { clamped_from: r.clamped_from }),
        ...(!readback || r.probe === undefined ? {} : { probe: r.probe }),
      };
      pushEvent(trace, {
        call: "setRange", desc: target, ok: result.ok,
        args: { target, value, opts },
        ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
        result,
      });
      try { pageState.update(p, "interactive"); } catch { /* 记录面让位事实 */ }
      return result;
    },
    manual: async (desc, req) => {
      assertOpen(`ctx.manual(${JSON.stringify(desc)})`);
      if (req === null || typeof req !== "object" || req.done === undefined || req.done === null) {
        throw new StopError("config_error", "ctx.manual: done signal is required");
      }
      if (deps.manualFailFast === true) {
        const stopCode = "needs_human";
        const reason = "manual step needs a human; --manual-fail-fast is set";
        // 影子旁路（§8 步 2）：旧路径权威——只记录，不改下方任何语句。
        deps.rescueShadow?.noteShadow({
          desc, id: req.id, instructions: typeof req.instructions === "string" ? req.instructions : "",
          pageUrl: currentUrl, computed: { status: "unavailable", by: "fail-fast" }, legacyStopCode: stopCode,
        });
        pushEvent(trace, {
          call: "manual", desc, ...(req.id === undefined ? {} : { id: req.id }),
          url: currentUrl, ok: false, stop_code: stopCode,
          result: { needs_human: true, reason },
        });
        return {
          ok: false, ...(req.id === undefined ? {} : { id: req.id }), stopCode, reason,
          evidence: { url: currentUrl, attempts: 0, elapsedMs: 0 },
        };
      }
      if (deps.manualRunner === undefined) {
        if (!process.stdin.isTTY) {
          const stopCode = "needs_human";
          const reason = "manual step needs an interactive terminal (non-TTY)";
          // 影子旁路（§8 步 2）：旧路径权威——只记录，不改下方任何语句。
          deps.rescueShadow?.noteShadow({
            desc, id: req.id, instructions: typeof req.instructions === "string" ? req.instructions : "",
            pageUrl: currentUrl, computed: { status: "unavailable", by: "none" }, legacyStopCode: stopCode,
          });
          pushEvent(trace, {
            call: "manual", desc, ...(req.id === undefined ? {} : { id: req.id }),
            url: currentUrl, ok: false, stop_code: stopCode,
            result: { needs_human: true, reason },
          });
          return {
            ok: false, ...(req.id === undefined ? {} : { id: req.id }),
            stopCode, reason,
            evidence: { url: currentUrl, attempts: 0, elapsedMs: 0 },
          };
        }
        throw new StopError("config_error", "ctx.manual: no manual runner wired in this build");
      }
      checkBudget();
      await paceBeforeStep();
      const started = Date.now();
      const session = await deps.ensureSession();
      const pageUrl = urlOf(session.page) || currentUrl;
      if (pageUrl) pageState.update(session.page as unknown as PageLike, "interactive");
      let approved = false;
      try {
        approved = await deps.manualRunner({
          desc,
          instructions: typeof req.instructions === "string" ? req.instructions : "",
          url: pageUrl,
        });
      } catch (e) {
        const reason = `manual handler failed: ${e instanceof Error ? e.message : String(e)}`;
        // 影子旁路（§8 步 2）：旧路径权威——只记录，不改下方任何语句。
        deps.rescueShadow?.noteShadow({
          desc, id: req.id, instructions: typeof req.instructions === "string" ? req.instructions : "",
          pageUrl, computed: { status: "unavailable", by: "handler" }, legacyStopCode: "manual_handler_error",
        });
        pushEvent(trace, {
          call: "manual", desc, ...(req.id === undefined ? {} : { id: req.id }),
          url: pageUrl, ok: false, stop_code: "manual_handler_error", result: { reason },
        });
        return {
          ok: false, ...(req.id === undefined ? {} : { id: req.id }),
          stopCode: "manual_handler_error", reason,
          evidence: { url: pageUrl, attempts: 0, elapsedMs: Date.now() - started },
        };
      }
      budget.stepsUsed += 1;
      const manualLeaf = isObj(req.done) && Object.prototype.hasOwnProperty.call(req.done, "manual");
      let ok = approved;
      let stopCode: string | undefined = approved ? undefined : "manual_declined";
      let reason: string | undefined = approved ? undefined : "human declined the manual step";
      if (approved) {
        if (!manualLeaf) {
          try {
            ok = await checkSignal(session.page as never, req.done as never);
          } catch (e) {
            throw new StopError("config_error", `ctx.manual(${JSON.stringify(desc)}) signal: ${e instanceof Error ? e.message : String(e)}`);
          }
          if (!ok) {
            stopCode = "manual_signal_not_held";
            reason = "human confirmed, but the declared DOM signal is not held";
          }
        }
      }
      const result: StepResult = {
        ok,
        ...(req.id === undefined ? {} : { id: req.id }),
        ...(stopCode === undefined ? {} : { stopCode }),
        ...(reason === undefined ? {} : { reason }),
        evidence: { url: pageUrl, attempts: 1, elapsedMs: Date.now() - started },
      };
      // 影子旁路（§8 步 2）：approved 判定后按三种结局各记一次（declined/fulfilled/signal_not_held）；
      // 旧路径权威——只记录，不改下方任何语句。by 与顺序链同口径：显式 handler > TTY。
      {
        const shadowBy = deps.manualRunner !== undefined ? "handler" : "tty";
        if (!approved) {
          deps.rescueShadow?.noteShadow({
            desc, id: req.id, instructions: typeof req.instructions === "string" ? req.instructions : "",
            pageUrl, computed: { status: "declined", by: shadowBy }, legacyStopCode: "manual_declined",
          });
        } else if (stopCode === "manual_signal_not_held") {
          // 信号复核不过：计算值仍是 fulfilled，legacy_stop_code 表达「旧路径停 manual_signal_not_held」。
          deps.rescueShadow?.noteShadow({
            desc, id: req.id, instructions: typeof req.instructions === "string" ? req.instructions : "",
            pageUrl, computed: { status: "fulfilled", by: shadowBy }, legacyStopCode: "manual_signal_not_held",
          });
        } else {
          // approved 且信号成立/manualLeaf：计算值 fulfilled，无 legacy 停因（省略不硬造）。
          deps.rescueShadow?.noteShadow({
            desc, id: req.id, instructions: typeof req.instructions === "string" ? req.instructions : "",
            pageUrl, computed: { status: "fulfilled", by: shadowBy },
          });
        }
      }
      pushEvent(trace, {
        call: "manual", desc, ...(req.id === undefined ? {} : { id: req.id }),
        url: pageUrl, ok,
        ...(stopCode === undefined ? {} : { stop_code: stopCode }),
        result: { approved, attested: manualLeaf, ...(reason === undefined ? {} : { reason }) },
      });
      return result;
    },
    fail: (code, reason) => {
      throw new StopError(typeof code === "string" && code.trim() ? code : "flow_failed", reason ?? "");
    },
    url: () => currentUrl,
    read: {
      text: async (sel) => {
        let value: string | null = null;
        try {
          const loc = await locatorAnyFrame(await page(), sel, { hosts });
          if (loc !== null) value = String(await firstOf(loc).innerText({ timeout: 1500 }));
        } catch { value = null; }
        pushEvent(trace, { call: "read", desc: `text(${sel})`, result: value });
        return value;
      },
      value: async (sel) => {
        let value: string | null = null;
        try {
          const loc = await locatorAnyFrame(await page(), sel, { hosts });
          if (loc !== null) value = String(await firstOf(loc).inputValue({ timeout: 1500 }));
        } catch { value = null; }
        pushEvent(trace, { call: "read", desc: `value(${sel})`, result: value });
        return value;
      },
      count: async (sel) => {
        let value = 0;
        try {
          const loc = await locatorAnyFrame(await page(), sel, { hosts });
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
          const loc = await locatorAnyFrame(await page(), sel, { hosts });
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
      const ok = await checkSignal(await page(), sig as never, { hosts });
      pushEvent(trace, { call: "holds", ok });
      return ok;
    },
    waitFor: async (sig, opts = {}) => {
      if (!isObj(sig) || !Object.keys(sig).length) throw new StopError("config_error", "ctx.waitFor needs a non-empty signal");
      const { timeoutMs, pollMs } = waitTiming(opts);
      const started = Date.now();
      const deadline = started + timeoutMs;
      const p = await page();
      let held = false;
      // 轮询语义：至少检查一次；最后一次 sleep 裁到 deadline，不让“下一次会越界”提前退出。
      while (true) {
        try {
          if (await checkSignal(p as never, sig as never, { hosts })) { held = true; break; }
        } catch (e) {
          throw new StopError("config_error", `ctx.waitFor: ${e instanceof Error ? e.message : String(e)}`);
        }
        const now = Date.now();
        if (now >= deadline) break;
        await new Promise((r) => setTimeout(r, Math.max(1, Math.min(pollMs, deadline - now))));
      }
      if (held) pageState.update(p as PageLike, "settled");
      pushEvent(trace, {
        call: "waitFor", ok: held,
        result: { timeout_ms: timeoutMs, poll_ms: pollMs, elapsed_ms: Date.now() - started },
      });
      return held;
    },
    // C2：observe + hintMatch 轮询（免费只读；池 = 可见准入面，hidden 期元素不进池 →
    // count 0 → 可见后才命中，visible 语义由此成立）。返回 {found, count}，超时如实 false。
    waitForTarget: async (hint, opts = {}) => {
      validateWaitForTargetArgs(hint, opts);
      const { timeoutMs, pollMs } = waitTiming(opts);
      const started = Date.now();
      const deadline = started + timeoutMs;
      let count = 0;
      let found = false;
      // 轮询语义与 ctx.waitFor 同款：至少查一次；最后一次 sleep 裁到 deadline。
      while (true) {
        const p = await page();
        const elems = await extractElements(p as never, true, 120, { ...(hosts ? { hosts } : {}) });
        const cand = hintCandidates(hint, elems, {
          ...(deps.attrValueMatch === undefined ? {} : { attrValueMatch: deps.attrValueMatch }),
        });
        count = cand === null ? 0 : cand.refs.length;
        if (count > 0) { found = true; break; }
        const now = Date.now();
        if (now >= deadline) break;
        await new Promise((r) => setTimeout(r, Math.max(1, Math.min(pollMs, deadline - now))));
      }
      if (found) pageState.update(await page() as PageLike, "settled");
      pushEvent(trace, {
        call: "waitForTarget", desc: hint, ok: found,
        result: {
          hint, visible: opts.visible === true, timeout_ms: timeoutMs, poll_ms: pollMs,
          count, elapsed_ms: Date.now() - started,
        },
      });
      return { found, count };
    },
    source: async (name, sourceOpts = {}) => {
      if (deps.allowSources === false) {
        throw new StopError("config_error", `ctx.source(${JSON.stringify(name)})：本次运行带 --skip-data，数据腿被显式跳过`);
      }
      if (deps.sourceRunner) {
        const obs = await deps.sourceRunner(name, sourceOpts);
        // T6：sources 观测面不只记行数——名字 + counts + selects 都进事件（result 投影同源）。
        pushEvent(trace, {
          call: "source", desc: name,
          result: { name, counts: obs.counts, selects: obs.selects, rows: obs.rows.length },
        });
        return obs;
      }
      const src = loadSource(name);
      // 环封口：数据腿的日期参数只能来自包默认/CLI 槽位——引用 source_slots 产物
      // 是循环依赖（那些值要等数据腿跑完才存在），加载已知就拒绝。
      const producerSlots = new Set(Object.keys(deps.pack.source_slots ?? {}));
      for (const ph of defaultDatesSlotNames(src)) {
        if (producerSlots.has(ph)) {
          throw new StopError("config_error", `source ${JSON.stringify(name)} 的 default_dates 引用 {${ph}}，`
            + `但 ${ph} 由数据腿回写（source_slots）——数据腿参数不允许引用数据腿产物`);
        }
      }
      let dates: string[];
      try {
        if (sourceOpts.dates !== undefined) {
          const raws = Array.isArray(sourceOpts.dates) ? sourceOpts.dates : [sourceOpts.dates];
          dates = raws.flatMap((r) => parseDatesValue(String(r), deps.runtime.today || undefined));
        } else {
          dates = defaultDates(src, slots, deps.runtime.today || undefined);
        }
      } catch (e) {
        // 坏日期参数/缺槽位值是配置类错误：ValueError → 结构化 StopError，不裸抛。
        if (e instanceof ValueError) {
          throw new StopError("config_error", `ctx.source(${JSON.stringify(name)}): ${e.message}`);
        }
        throw e;
      }
      const res = await runSource(src, dates, { verbose: false, today: deps.runtime.today || undefined });
      const day = Object.values(res.dates)[0] as unknown as Record<string, unknown> | undefined;
      const counts = (day?.["counts"] ?? {}) as Record<string, number>;
      const selects = (day?.["selects"] ?? {}) as Record<string, Record<string, string> | null>;
      const rows = (day?.["rows"] ?? []) as Array<Record<string, string>>;
      const byDate: NonNullable<SourceObservationView["byDate"]> = {};
      for (const [dateKey, entry] of Object.entries(res.dates)) {
        const e = entry as unknown as Record<string, unknown>;
        if (e["error"] !== undefined) continue;
        byDate[dateKey] = {
          ...(e["url"] !== undefined ? { url: String(e["url"]) } : {}),
          counts: (e["counts"] ?? {}) as Record<string, number>,
          selects: (e["selects"] ?? {}) as Record<string, Record<string, string> | null>,
          rows: (e["rows"] ?? []) as Array<Record<string, string>>,
        };
      }
      const obs: SourceObservationView = {
        counts, selects, rows,
        ...(res.tool_version ? { version: res.tool_version } : {}),
        ...(Object.keys(byDate).length ? { byDate } : {}),
      };
      pushEvent(trace, {
        call: "source", desc: name,
        result: { name, counts, selects, rows: rows.length, dates: Object.keys(byDate) },
      });
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
      // C1：offset 只认第二参（写进 spec 在 validateExtractOptions 里结构化指路）。
      const offset = validateExtractOptions(nameOrSpec, extractOpts);
      let spec: { rows: string; fields: Record<string, string>; maxItems?: number };
      if (typeof nameOrSpec === "string") {
        if (!nameOrSpec.trim()) throw new StopError("config_error", "ctx.extract: name must be a non-empty string");
        const named = pack.site?.listExtract?.[nameOrSpec];
        if (named === undefined) {
          const known = Object.keys(pack.site?.listExtract ?? {});
          throw new StopError("config_error",
            `ctx.extract(${JSON.stringify(nameOrSpec)}): meta.site.listExtract has no such entry`
            + ` (known: ${known.length ? known.join(", ") : "none declared"})`);
        }
        spec = named;
      } else if (isObj(nameOrSpec) && typeof nameOrSpec["rows"] === "string" && nameOrSpec["rows"].trim()
          && isObj(nameOrSpec["fields"])) {
        spec = { rows: nameOrSpec["rows"], fields: nameOrSpec["fields"] as Record<string, string> };
        if (typeof nameOrSpec["maxItems"] === "number") spec.maxItems = nameOrSpec["maxItems"];
      } else {
        throw new StopError("config_error",
          "ctx.extract needs a declared name or { rows, fields, maxItems? } structure");
      }
      const extractName = typeof nameOrSpec === "string" ? nameOrSpec : `inline:${spec.rows}`;
      const cap = Math.max(1, Math.min(500, Math.floor(spec.maxItems ?? 500)));
      const found = await readRows(spec.rows, spec.fields, cap, offset);
      // C1：total 经注入的观测口回写（返回类型不变）；未注入 = 不写（run/dry/replay 零影响）。
      if (deps.extractStats !== undefined) deps.extractStats.total = found.total;
      pushEvent(trace, {
        call: "extract", desc: extractName,
        result: {
          rows: found.rows,
          // offset=0 时与分页之前逐字节一致（`rows.length < total` ⇔ 旧的 `total > cap`）。
          truncated: found.truncated,
          ...(offset > 0 ? { offset } : {}),
        },
      });
      return found.rows;
    },
    collect: async (req) => {
      validateCollectRequest(req);
      assertOpen("ctx.collect");
      checkBudget();
      await paceBeforeStep();
      const p = await page();
      budget.stepsUsed += 1;
      const fields = req.fields ?? { text: "." };
      const until = req.until ?? { stableRounds: 2 };
      const stableRounds = "stableRounds" in until ? (until.stableRounds ?? 2) : 2;
      const maxRows = "maxRows" in until ? (until.maxRows ?? 500) : 500;
      const dedupe = req.dedupe !== false;
      const maxRounds = req.maxRounds ?? 30;
      // C2：行/字段选择器的唯一预检就在**入口这一处**（循环内不重复、每次轮询零额外往返）。
      // 旧实现在这里用 DOM `querySelectorAll` 预检，会把 Playwright 自己的选择器扩展
      //（`:has-text(...)` 等）误判成非法——现在与 extract 走同一个 Playwright 解析面
      //（`locator(sel).count()`），顺带修掉那个旧行为。
      await checkExtractSelectors(p, req.row, fields, "ctx.collect");
      const rows: Array<Record<string, string>> = [];
      const seen = new Set<string>();
      let rounds = 0;
      let addedLastRound = 0;
      let stableCount = 0;
      /**
       * 是否已确认"滚到底/滚不动"。滚动没到底时"本轮没新增"是正常的（还没滚到新内容），
       * 不能算进 plateau；只有到底后连续 stableRounds 轮无新增才是 stable。
       */
      let atBottomKnown = false;
      let stopReason: CollectStopReason = "budget";
      while (rounds < maxRounds) {
        rounds += 1;
        const found = await readRows(req.row, fields, maxRows, 0, { call: "ctx.collect", prevalidated: true });
        addedLastRound = 0;
        for (const row of found.rows) {
          const key = JSON.stringify(row);
          if (dedupe && seen.has(key)) continue;
          seen.add(key);
          rows.push(row);
          addedLastRound += 1;
          if (rows.length >= maxRows) break;
        }
        if (rows.length >= maxRows) { stopReason = "maxRows"; break; }
        if (addedLastRound > 0) stableCount = 0;
        else if (atBottomKnown) stableCount += 1;
        if (stableCount >= stableRounds) { stopReason = "stable"; break; }
        if (rounds >= maxRounds) break;                    // 内部轮数用尽 → budget
        const scroll = await scrollRowsContainer(req.row);
        if (!scroll.found || !scroll.scrollable) { stopReason = "not_scrollable"; break; }
        atBottomKnown = scroll.atBottom || !scroll.moved;
        // 给懒加载/无限滚动一点时间再读下一轮；这段等待**不占** flow 预算。
        await sleepMs(300);
      }
      const coverage: CollectCoverage = { rounds, rowsSeen: rows.length, addedLastRound };
      const result: CollectResult = { rows, coverage, stopReason };
      pushEvent(trace, {
        call: "collect", desc: req.row, ok: true,
        args: req,
        result,
      });
      return result;
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

/**
 * `ctx.run` 的 `returns` 规范化：只认既有 `ReturnExtractor` 声明面（`validateReturns` 是
 * 加载期与运行期**同一份**校验）。坏声明 = 结构化 `config_error`，绝不"猜一个抽取方式"。
 */
/** L2 ctx 的纯工具函数 —— 拆到 ctx-tool.ts（F1；toolReturns/toolFailureReason/pickRow）。 */
import { toolReturns, toolFailureReason, pickRow } from "./ctx-tool.ts";
export { toolReturns, toolFailureReason, pickRow };
