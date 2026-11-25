/**
 * 导航失败的**错误页识别与原文还原**（单一出处：正则与分类表都在这里）。
 *
 * 为什么需要单独一层：Chrome 把导航失败落成 `chrome-error://chromewebdata/` 的内部错误页。
 * 该页 URL **不是**站点 URL——拿它去判 hosts 信封会得到 host `chromewebdata`，
 * 于是「网络不通」被误报成「越界」（pilot 停 `host_not_allowed`、run 面停 `popup_not_allowed`）。
 * 两个都是**安全语义**的码，误报会让兜底方去改声明，而真正该做的是验证可达/改端口。
 *
 * 取证事实（Chromium 1.58 / headless 实测）：
 *   - 落在错误页后 `body.innerText` 为空、`content()` 是空壳 ⇒ **事后读不到原文**；
 *   - `reload()` 会重新发起同一导航并抛出原始 `net::ERR_*` ⇒ 唯一的原文来源，因此有界调用。
 *
 * 归码（沿用仓库既有分类口径，不新增码）：
 *   - `unreachable`：连接/DNS/超时类 `net::ERR_*`（`ctx-runtime` 的 navigate 同一判据）——
 *     站点此刻不可达，正确动作是验证可达后重试/放宽超时，不是改声明；
 *   - `config_error`：其余（如 `ERR_UNSAFE_PORT` = 端口被浏览器拒绝、畸形 URL）——改声明/改端口，不要重试。
 */
import { urlOf } from "./page-shapes.ts";
import type { PageLike } from "../support/page-like.ts";

/** Chrome 内部错误页的协议前缀（`chrome-error://chromewebdata/`）。 */
export const CHROME_ERROR_PROTOCOL = "chrome-error:";

/**
 * 连接/DNS/超时类导航失败（`unreachable`）的判据。
 *
 * **与 `src/app/ctx-runtime.ts` 的 navigate 同一条**：那边 import 本常量，不再内联手抄。
 * 改动本正则 = 同时改变 flow 脚本面与 pilot/run 面的停因分类，需按行为变更处理。
 */
export const NAV_ERROR_PATTERN =
  /Timeout .*ms exceeded|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED|ERR_NAVIGATION_ABORTED/;

/**
 * 明确的**声明/配置类**导航失败：命中也走 `config_error`，列出来是为了留下「为什么不是
 * unreachable」的判据（`ERR_UNSAFE_PORT` 是端口被浏览器拒绝——改端口，不是重试网络）。
 */
export const NAV_CONFIG_ERROR_PATTERN = /ERR_UNSAFE_PORT|ERR_INVALID_URL|ERR_DISALLOWED_URL_SCHEME/;

/** 还原错误原文的 reload 有界上限：错误页上 reload 立刻抛错，3s 只是防真卡死。 */
export const NAV_ERROR_RELOAD_TIMEOUT_MS = 3_000;

/** 一次导航失败的分类结果（码 + 带原文的 reason；url = 出错页的地址）。 */
export interface NavFailure {
  code: "unreachable" | "config_error";
  reason: string;
  url: string;
}

/** URL 是否是 Chrome 内部错误页（不是站点页，不能进 hosts 信封判定）。 */
export function isChromeErrorPage(url: string): boolean {
  return typeof url === "string" && url.toLowerCase().startsWith(CHROME_ERROR_PROTOCOL);
}

/** 错误对象 → 原文行（只取首行；`net::ERR_*` 段原样保留）。 */
function errLine(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return message.split("\n")[0]!.trim();
}

/** 从浏览器错误文本里取出 `net::ERR_*` 段（原文是判定与解锁建议的唯一依据）。 */
export function navErrorText(message: string): string {
  const match = /net::[A-Z0-9_]+/.exec(message);
  return match === null ? message : match[0];
}

/** 错误原文 → 分类码（`unreachable` 优先，其余含显式配置类与非 `net::` 文本一律 `config_error`）。 */
export function classifyNavError(message: string): "unreachable" | "config_error" {
  if (NAV_ERROR_PATTERN.test(message)) return "unreachable";
  if (NAV_CONFIG_ERROR_PATTERN.test(message)) return "config_error";
  return "config_error";
}

/**
 * 分类 → 处置建议（**run 面的 reason 用**：run 面停因闭集是冻结契约，不加 `unreachable`，
 * 靠 reason 把「该验证可达还是该改声明」说清，避免两个面对同一个浏览器错误给出相反建议）。
 *
 * pilot 面不用它：那里两个码各自成立，建议走 `unblockHintsFor` 的查表。
 */
export const NAV_ERROR_DIRECTIVE: Readonly<Record<NavFailure["code"], string>> = {
  unreachable: "站点此刻不可达：先验证可达（curl/fetch）再重试或放宽 --timeout；不是声明错误，改 meta 无效",
  config_error: "导航被浏览器拒绝：核对入口 URL/端口/协议后改声明，重试同一地址无效",
};

/** run 面的导航失败 reason：原文事实 + 分类处置建议（单一出处，两面口径不打架）。 */
export function navErrorStopReason(failure: NavFailure): string {
  return `${failure.reason} — ${NAV_ERROR_DIRECTIVE[failure.code]}`;
}

/**
 * 还原**已落在错误页**的那个页面的导航原文：`reload()` 有界调用，抛错取 `net::ERR_*`。
 *
 * 不抛错（理论上不该发生：错误页 reload 会重放同一失败）时如实报「拿不到原文」，
 * 仍按 `config_error` 归类——绝不因为读不到原文就把它说成越界或不可达。
 */
export async function pageNavError(page: PageLike, timeoutMs = NAV_ERROR_RELOAD_TIMEOUT_MS): Promise<NavFailure | null> {
  let url = "";
  try {
    url = urlOf(page);
  } catch {
    return null;
  }
  if (!isChromeErrorPage(url)) return null;
  const reload = (page as unknown as { reload?: (opts?: { timeout?: number }) => Promise<unknown> }).reload;
  if (typeof reload !== "function") {
    return { code: "config_error", reason: "landed on a browser error page (no reload available to recover the error text)", url };
  }
  // reload 的 promise 自己吞掉 rejection：超时竞速后它可能仍以 throw 收尾，不能留下未处理拒绝。
  const attempt = Promise.resolve()
    .then(() => reload.call(page, { timeout: timeoutMs }))
    .then((): string | null => null, (e: unknown): string | null => errLine(e));
  const outcome = await Promise.race([
    attempt,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
  ]);
  if (outcome === null || outcome === undefined) {
    return {
      code: "config_error",
      reason: "landed on a browser error page (no error text available)",
      url,
    };
  }
  const text = navErrorText(outcome);
  const code = classifyNavError(outcome);
  return { code, reason: `navigation failed: ${text} (${url})`, url };
}

/** context 里除主页面外的页（Playwright `page.context()` 是方法，替身可能直接给对象）。 */
function contextPages(page: PageLike): PageLike[] {
  const contextValue = (page as unknown as { context?: unknown }).context;
  const context = (typeof contextValue === "function" ? contextValue.call(page) : contextValue) as
    | { pages?: ArrayLike<PageLike> | (() => ArrayLike<PageLike>) }
    | undefined;
  const rawPages = typeof context?.pages === "function" ? context.pages() : context?.pages;
  return Array.from(rawPages ?? []);
}

/**
 * popup/新标签的导航失败：扫描同 context 的页面，**第一个**落在错误页的还原原文。
 *
 * 与 `deniedContextUrl` 的扫描面一致，但错误页必须先于信封判定——否则「网络失败」
 * 会被说成「popup 越界」（`popup_not_allowed` 是安全码，误导兜底方去改 hosts）。
 */
export async function contextNavError(
  page: PageLike,
  timeoutMs = NAV_ERROR_RELOAD_TIMEOUT_MS,
): Promise<NavFailure | null> {
  for (const p of contextPages(page)) {
    let u = "";
    try { u = urlOf(p); } catch { continue; }
    if (!isChromeErrorPage(u)) continue;
    const failure = await pageNavError(p, timeoutMs);
    if (failure !== null) return failure;
  }
  return null;
}
