/**
 * createCtx 的**运行期底座**：闭包状态（budget / currentUrl / closed / 页面状态仓库）、
 * 会话与页面访问、导航闸门、节奏/预算/记账等共享原语。真实/dry/replay 三面不共享本文件，
 * 它只服务真实运行期面 ctx.ts 的分组工厂。
 */
import { disallowedHost } from "../engine/executor.ts";
import type { BrowserSession } from "../engine/executor.ts";
import { NAVIGATION_GOTO_TIMEOUT_MS } from "../support/tuning.ts";
import { frameGateExcludes } from "../engine/frame-scope.ts";
import { framesOf, urlOf, splitFrameSuffixFromSelector, frameScopeMatchesFrame } from "../engine/extraction.ts";
import type { PageLike } from "../engine/extraction.ts";
import { signalHasFrameSuffix } from "../engine/signals.ts";
import { NAV_ERROR_PATTERN } from "../engine/nav-error.ts";
import { PageStateStore } from "./page-state.ts";
import { pushEvent } from "./trace.ts";
import type { TraceCall } from "./trace.ts";
import { paceRemainder } from "../support/pace.ts";
import { sleepMs } from "../support/sleep.ts";
import { StopError } from "./ctx-types.ts";
import type { TabInfo, CtxBudget, CtxDeps } from "./ctx-types.ts";
import { resolveCtxUrl, sameNavTarget, sameDeclaredPageHref } from "./ctx-validate.ts";

/**
 * A5：标签页枚举。Playwright 的 Page 在两条会话构造路径（`browser.newPage()` 的隐式
 * context / 设备声明的 `newContext`）上都能 `page.context().pages()` 枚举；替身可能
 * 把 context/pages 给成属性，两种形状都认。`isClosed()` 不可用或抛错的页面按关闭处理
 * （绝不对关掉的页做 title 读取/切换）。
 */
export type TabPage = PageLike & {
  title?(): Promise<string>;
  isClosed?(): boolean;
  bringToFront?(): Promise<void>;
  waitForLoadState?(state?: string, opts?: { timeout?: number }): Promise<void>;
};

/* ---------- S1（盲测复盘）：行容器滚动的模块级实现 ----------
 * 从闭包提为模块级（依赖只有 getPage/hosts，都是参数）：会话 `act scroll rows` 与
 * `ctx.collect` 走同一份容器判定（最近可滚动祖先 + 帧序 + 信封 + 剥离后 base），
 * 不是第二套语义。闭包内保留薄包装（collect 消费面调用点零改动）。 */

/** 行元素所在滚动容器探测结果（步进/绝对两种滚动共用）。 */
export interface RowsScrollProbe {
  ok: boolean;
  /** 行零命中（所有帧都没匹配到 rows 选择器）。 */
  zeroRows?: boolean;
  /** 行在但容器不可滚（含主滚动器兜底也不可滚）。 */
  notScrollable?: boolean;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  moved?: boolean;
  delta?: number;
  atBottom?: boolean;
}

/**
 * 行容器滚动底座：`stepPx:true` = 推进一屏（collect 的步进语义，返回 `atBottom`）；
 * `to/by` = 绝对寻址（S1 的 `scrollTop` 直写语义）。单次 evaluate 完成容器判定 +
 * 滚动 + 实测；该帧无行继续下一帧，全部帧零命中 = `zeroRows`（调用方按 miss 处理）。
 */
async function scrollRowsBase(
  getPage: () => Promise<PageLike>, hosts: string[] | null,
  rowSelector: string,
  mode: { stepPx: true } | { to: "bottom" | "top" | "page"; by?: number },
): Promise<RowsScrollProbe> {
  const p = await getPage();
  // E4：声明了合法 ` frame:` 尾缀的行选择器只滚声明帧（链匹配 + 信封过滤；查询用剥离后
  // base——原始串对 querySelectorAll 是非法 CSS，一帧都找不到）。无尾缀 = 原样逐帧探测。
  // E7（B1 修复）：evaluate 实参必须是**剥离后**的 base——原始串带 ` frame:` 尾缀时对
  // querySelectorAll 是非法 CSS，逐帧 catch continue 会让声明帧滚动恒 not_scrollable。
  // 无尾缀/被拒尾缀时 split.selector 与原串逐字节相同（split 是唯一出口）。
  const split = splitFrameSuffixFromSelector(rowSelector);
  for (const [fi, fr] of framesOf(p).entries()) {
    if (split.frameChain !== undefined && !frameScopeMatchesFrame(split.frameChain, fr)) continue;
    if (split.frameChain !== undefined && frameGateExcludes(fi, fr, hosts)) continue;
    try {
      const raw = await fr.evaluate((arg: { sel: string; step: boolean; to?: string; by?: number }) => {
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
        if (!doc) return { zero: true };
        const rows = doc.querySelectorAll(arg.sel);
        if (!rows.length) return { zero: true };
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
        if (container === null) return { found: true, notScrollable: true };
        const before = Number(container.scrollTop) || 0;
        const max = Math.max(0, Number(container.scrollHeight) - Number(container.clientHeight));
        let next = before;
        if (arg.step) {
          const stepPx = Math.max(200, Math.floor((Number(container.clientHeight) || 0) * 0.8));
          next = Math.min(max, before + stepPx);
        } else if (typeof arg.by === "number") next = before + arg.by;
        else if (arg.to === "bottom") next = max;
        else if (arg.to === "top") next = 0;
        else if (arg.to === "page") next = Math.min(max, before + Math.max(1, Math.round(Number(container.clientHeight) * 0.9)));
        next = Math.max(0, Math.min(max, next));
        container.scrollTop = next;
        const after = Number(container.scrollTop) || 0;
        return { found: true, before, scrollTop: after, scrollHeight: Number(container.scrollHeight) || 0, clientHeight: Number(container.clientHeight) || 0 };
      }, { sel: split.selector, step: "stepPx" in mode, ...("to" in mode ? { to: mode.to } : {}), ...("by" in mode && mode.by !== undefined ? { by: mode.by } : {}) });
      const stepped = "stepPx" in mode;
      if (raw !== null && typeof raw === "object") {
        const rec = raw as Record<string, unknown>;
        if (rec["zero"] === true) continue;   // 该帧无行，试下一帧
        if (rec["notScrollable"] === true) {
          return { ok: false, notScrollable: true, ...(stepped ? { atBottom: true } : {}) };
        }
        const scrollTop = Number(rec["scrollTop"] ?? 0);
        const before = Number(rec["before"] ?? 0);
        const scrollHeight = Number(rec["scrollHeight"] ?? 0);
        const clientHeight = Number(rec["clientHeight"] ?? 0);
        if (stepped) {
          return { ok: true, scrollTop, scrollHeight, clientHeight, moved: scrollTop !== before, delta: scrollTop - before, atBottom: scrollTop >= Math.max(0, scrollHeight - clientHeight) - 2 };
        }
        return { ok: true, scrollTop, scrollHeight, clientHeight, moved: scrollTop !== before, delta: scrollTop - before };
      }
    } catch {
      continue;   // 跨源 frame：evaluate 抛错，跳过
    }
  }
  // 所有帧都零命中：行不存在（与旧 collect 的 found:false 同判）。
  return { ok: false, zeroRows: true };
}

/**
 * S3 collect：把行元素所在容器的滚动推进一屏（最近可滚动祖先；否则页面滚动元素）。
 * 逐 frame 探测（行可能在可达的子 frame 里，同源/跨源均可定位）；找不到行 = found:false。
 * 返回形状与既有 collect 消费面逐字段一致（薄包装，不改判定）。
 */
async function scrollRowsStep(
  getPage: () => Promise<PageLike>, hosts: string[] | null, rowSelector: string,
): Promise<{ found: boolean; scrollable: boolean; moved: boolean; atBottom: boolean }> {
  const r = await scrollRowsBase(getPage, hosts, rowSelector, { stepPx: true });
  if (r.ok === true) return { found: true, scrollable: true, moved: r.moved === true, atBottom: r.atBottom === true };
  if (r.notScrollable === true) return { found: true, scrollable: false, moved: false, atBottom: true };
  return { found: false, scrollable: false, moved: false, atBottom: true };
}

/**
 * S1：`rows` 选择器 → 行元素所在滚动容器的**绝对寻址**滚动（`scrollTop` 直写，不走
 * "推进一屏"）。返回与 `_scrollWithLoc` 同口径的实测证据；行零命中 = `{ok:false,
 * zeroRows:true}`（调用方按 `target_not_found` 报，点名 rows 选择器）；行在但不可滚 =
 * `notScrollable`。内部名 `scrollRowsToImpl`——闭包包装与模块导出双消费，避免同名遮蔽。
 */
export async function scrollRowsToImpl(
  getPage: () => Promise<PageLike>, hosts: string[] | null, rowSelector: string,
  to: "bottom" | "top" | "page", by?: number,
): Promise<RowsScrollProbe> {
  return scrollRowsBase(getPage, hosts, rowSelector, { to, ...(by === undefined ? {} : { by }) });
}

export function createCtxRuntime(deps: CtxDeps) {
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

  /**
   * E7（N7）：done/invariant 信号树的**尾缀条件信封**——仅当树里含合法 ` frame:` 尾缀时
   * 传 `{hosts}`（与 arrive/manual 同口径：声明帧不在信封 = miss，避免尾缀把 E4 前必失败
   * 的串在无信封面上命中被排除帧）；无尾缀 = undefined ⇒ 既有不设防口径逐字节不变。
   */
  const signalHosts = (sig: unknown): { hosts: string[] | null } | undefined =>
    signalHasFrameSuffix(sig as never) ? { hosts } : undefined;

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
        url, { waitUntil: "domcontentloaded", timeout: timeoutMs ?? NAVIGATION_GOTO_TIMEOUT_MS },
      );
    } catch (e) {
      // 网络/可达性失败 ≠ 声明错误：DNS 解析失败、连接拒绝、导航超时都是「站点此刻 不可达」，正确动作是验证可达后重试/放宽 --timeout，不是改声明。只有其余
      // 异常（如畸形 URL）才归 config_error（改声明，不要重试）。
      const msg = e instanceof Error ? e.message : String(e);
      if (NAV_ERROR_PATTERN.test(msg)) {
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

  /**
   * S3 collect：把行元素所在容器的滚动推进一屏（最近可滚动祖先；否则页面滚动元素）。
   * 逐 frame 探测（行可能在可达的子 frame 里，同源/跨源均可定位）；找不到行 = found:false。
   * 实现在模块级 `scrollRowsStep`（S1 起与 `scrollRowsTo` 共用同一份容器判定）。
   */
  const scrollRowsContainer = (rowSelector: string) => scrollRowsStep(page, hosts, rowSelector);

  /**
   * S1：`rows` 选择器 → 行元素所在滚动容器的**绝对寻址**（`scrollTop` 直写，不走
   * "推进一屏"）。模块级 `scrollRowsTo` 的闭包包装（collect 不消费；会话面经
   * 模块级导出直接用，不经过这里）。
   */
  const scrollRowsToClosure = (rowSelector: string, to: "bottom" | "top" | "page", by?: number) =>
    scrollRowsToImpl(page, hosts, rowSelector, to, by);

  return {
    deps,
    pack,
    slots,
    runtime,
    trace,
    budget,
    hosts,
    pageState,
    get currentUrl() { return currentUrl; },
    set currentUrl(v: string) { currentUrl = v; },
    get closed() { return closed; },
    set closed(v: boolean) { closed = v; },
    signalHosts,
    markDirectNavLanded,
    navGate,
    assertOpen,
    page,
    contextPages,
    titleOf,
    listTabs,
    bounded,
    checkBudget,
    record,
    paceBeforeStep,
    navigate,
    scrollRowsContainer,
    scrollRowsTo: scrollRowsToClosure,
  };
}

export type CtxRuntime = ReturnType<typeof createCtxRuntime>;
