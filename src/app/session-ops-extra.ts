/**
 * `amber session` 的 `tab` 请求处理体（从 session-runtime.ts **纯搬移**）。
 *
 * 状态（会话 holder / 动作计数 / 轨迹流 / URL 账）不进本模块：全部经 `TabOpDeps` 显式回调由
 * `SessionRuntime` 注入，请求/响应形状、错误码、日志文案、轨迹与计数口径与搬移前逐字节一致。
 *
 * F76/P3：`action:"list"`（缺省，免费只读）枚举标签页；`action:"switch"` 显式切到恰好一个
 * 匹配的标签页。匹配语义/校验/现场描述**全部复用** ctx-validate 的纯函数
 * （`validateSwitchTabMatch`/`switchTabMatches`/`describeTabs`），不发明第二套语义：
 *   - match 缺失/空对象/未知键/类型非法 ⇒ `config_error`（文案同 ctx-validate.ts）；
 *   - 0 个或 >1 个匹配 ⇒ `config_error`（reason 带 describeTabs 现场，不回退随便选一个）；
 *   - 目标 URL 在 open 时声明的 hosts 信封外 ⇒ `host_not_allowed`，且**不切换**；
 *   - 命中：会话当前 page 指向目标页 + bringToFront（有界 2s）+ domcontentloaded（有界 5s，
 *     均失败不致命——照抄 ctx.switchTab 的处理）+ settle（有界、失败不致命）；switch 写一条
 *     JSONL 动作记录（与 act 的 record 同一条流），list 不写。
 */
import { disallowedHost, type AnyPage, type BrowserSession } from "../engine/executor.ts";
import { urlOf } from "../engine/extraction.ts";
import { settle } from "../engine/settle.ts";
import { StopError } from "./ctx.ts";
import { describeTabs, switchTabMatches, validateSwitchTabMatch } from "./ctx-validate.ts";
import type { SwitchTabMatch, TabInfo } from "./ctx-types.ts";
import { bounded, tabTitleOf } from "./session-runtime-contract.ts";

/** `tab` 处理体需要的会话状态：由 `SessionRuntime` 显式注入（生命周期/计数仍归会话所有）。 */
export interface TabOpDeps {
  /** open 时声明的 hosts 信封（null = 未声明；switch 的导航信封判定用）。 */
  hosts: string[] | null;
  ensureSession: () => Promise<BrowserSession>;
  /** 会话 URL 账（switch 落地后追加，与 open/act 同一份）。 */
  urls: string[];
  /** 切页算一次动作：递增计数器；`recordAction` 的 `i` 取递增后的值。 */
  bumpActionCount: () => void;
  recordAction: (entry: Record<string, unknown>) => void;
  log: (line: string) => void;
}

/**
 * F76：枚举当前 browser context 里**未关闭**的标签页（与 ctx.ts 的 `listTabs` 同形状同序：
 * `context.pages()` 序 = index 序，0-based；`active` = 会话当前页）。Playwright 的 page 在
 * 两条会话构造路径上都能 `page.context().pages()` 枚举；替身可能把 context/pages 给成属性，
 * 两种形状都认；`isClosed()` 不可用或抛错的页面按关闭处理（绝不对关掉的页做 title 读取/切换）。
 */
async function listTabs(session: BrowserSession): Promise<Array<TabInfo & { page: AnyPage }>> {
  const active = session.page;
  const contextValue = (active as unknown as { context?: unknown }).context;
  const context = (typeof contextValue === "function"
    ? contextValue.call(active)
    : contextValue) as { pages?: ArrayLike<AnyPage> | (() => ArrayLike<AnyPage>) } | undefined;
  const raw = typeof context?.pages === "function" ? context.pages() : context?.pages;
  const pages = Array.from(raw ?? []).filter((p) => {
    try { return p.isClosed?.() !== true; } catch { return false; }
  });
  const out: Array<TabInfo & { page: AnyPage }> = [];
  for (const [index, p] of pages.entries()) {
    let url = "";
    try { url = urlOf(p) || ""; } catch { url = ""; }
    out.push({ index, url, title: await tabTitleOf(p), active: p === active, page: p });
  }
  return out;
}

/** F76/P3：`tab` 请求处理体（语义见模块头注释）。 */
export async function doTabRequest(req: Record<string, unknown>, deps: TabOpDeps): Promise<Record<string, unknown>> {
  const action = req["action"] === undefined ? "list" : req["action"];
  if (action !== "list" && action !== "switch") {
    return {
      ok: false, code: "config_error",
      reason: `tab.action must be one of list | switch (got ${JSON.stringify(action)})`,
      allowed_actions: ["list", "switch"],
    };
  }
  // switch 的形状校验先于浏览器惰性创建（StopError 由 handleLine 统一转结构化失败）——
  // match 缺失/空对象的 config_error 不该付出一次浏览器启动的代价。
  if (action === "switch") validateSwitchTabMatch(req["match"]);
  const session = await deps.ensureSession();
  const listed = await listTabs(session);
  if (action === "list") {
    // 免费只读：不切页、不写轨迹、不记动作；列表可以包含 hosts 信封外的页面（与 ctx.tabs 同一判定）。
    return {
      ok: true,
      action: "list",
      tabs: listed.map(({ index, url, title, active }) => ({ index, url, title, active })),
      active: listed.find((t) => t.active === true)?.index ?? -1,
    };
  }
  const match = req["match"] as SwitchTabMatch;
  const matched = listed.filter((t) => switchTabMatches(t, match));
  if (matched.length !== 1) {
    const why = matched.length === 0 ? "no tab matches" : `${matched.length} tabs match`;
    throw new StopError("config_error",
      `tab switch: ${why} ${JSON.stringify(match)} — expected exactly 1; current tabs: ${describeTabs(listed)}`
      + ' (tab action "list" shows the same tabs; no implicit fallback to an arbitrary tab)');
  }
  const target = matched[0]!;
  // 导航信封：列表可以只读看到信封外页面，切过去不行（与 ctx.switchTab / open 同一判定）。
  if (deps.hosts !== null && deps.hosts.length > 0 && disallowedHost(target.url, deps.hosts) !== null) {
    throw new StopError("host_not_allowed",
      `tab switch: ${JSON.stringify(target.url)} is outside the declared hosts envelope (${deps.hosts.join(", ")})`
      + " — the tab was not activated");
  }
  const before = urlOf(session.page) || "";
  // 换页：holder 里的 BrowserSession 是同一个对象，ctx 面/执行器后续都经 ensureSession().page
  // 拿当前页——指向目标页即全会话生效（ctx.switchTab 同一条事实路径）。
  session.page = target.page as unknown as AnyPage;
  // Playwright 成熟做法：置前 + 有界等 domcontentloaded；两者失败都不致命（切页已是事实）。
  await bounded(() => (target.page as unknown as { bringToFront?: () => Promise<void> }).bringToFront?.(), 2000);
  await bounded(() => target.page.waitForLoadState?.("domcontentloaded", { timeout: 5000 }), 5000);
  // settle（有界、永不抛、失败不致命）：给下一个 observe/extract 一个已装好传感器的静默页。
  try { await settle(target.page); } catch { /* settle 不抛；防御性 no-op */ }
  deps.urls.push(target.url);
  deps.bumpActionCount();
  deps.recordAction({
    op: "tab", action: "switch", target: null,
    ok: true, ref: null, how: "switched", changed: true,
    from: { url: before },
    to: { index: target.index, url: target.url, title: target.title },
    url: target.url,
  });
  deps.log(`tab switch → #${target.index} ${target.url}`);
  return {
    ok: true,
    action: "switch",
    switched: { index: target.index, url: target.url, title: target.title },
  };
}
