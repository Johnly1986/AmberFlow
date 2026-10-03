/**
 * 从**一个能过携程风控的网络**上，把真实页面抓成"可以照着写计划"的快照。
 *
 * 为什么需要这个文件：本环境访问携程机票页会被 WhaleGuard 直接 432（见 `live-probe.ts`
 * 的实测矩阵：浏览器 UA、curl 客户端、五种入口形态、手机模拟、Trip.com 三个区域域名 ——
 * 全部 432），所以"真实 DOM 长什么样"在这里**看不到**，也就写不出可信的 hint/signal。
 * 这个工具把"看真实 DOM"这一步做成一条命令：在有权限的网络里跑一次，输出
 * `ctrip/results/live_capture/<name>.md`（模型/人写计划时的**同一套渲染**：
 * `snapshotText` 复用执行器的 `criteriaView`，与执行器看到的元素空间完全一致），
 * 以及原始元素 JSON。
 *
 * 被挡住时它**如实报告**而不是抛栈：状态码、正文特征、以及该怎么办（换出口 IP /
 * 用已登录的账号配置 / 走官方 API）。
 *
 *     node --experimental-strip-types src/live-capture.ts                 # 机票列表 + 酒店列表
 *     node --experimental-strip-types src/live-capture.ts --date 2026-10-08
 *     node --experimental-strip-types src/live-capture.ts --only flights
 *
 * 退出码：0 = 命令跑完（不论抓到还是被挡，结果都写进 summary.json）；
 * 1 = 两个目标都没能进入（全部被挡/失败）—— 供上层脚本判断"这个网络现在能不能跑真实用例"。
 *
 * **判定顺序是 load-bearing 的**：先 `looksBlocked`，再 `looksLoginRedirect`，最后才是
 * `captured`。第一版工具把「被重定向到 passport.ctrip.com/user/login 的登录表单」当成
 * "captured"（40 个元素），那是自欺 —— 区分"页面打开了"和"我要的页面打开了"，与把
 * `whaleguard` 正文当内容是同一种错误。这里的四种判决（captured / blocked /
 * login_required / unreachable）是纯函数 `verdictFor()`，离线可测。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as D from "./datasource.ts";
import * as browserEnv from "./browser-env.ts";
import { criteriaView, extractElements, pageText, urlOf, type ElemPool, type PageLike } from "./extraction.ts";

import { addDays as psAddDays, fillProbeDate, loadProbeSet, markerList, type ProbeSet } from "./probe-set.ts";

/**
 * 站点知识（URL 模板、风控/登录墙特征、登录重定向主机、结果目录）全在
 * `apps/ctrip-live/pack.json`；本文件只剩"怎么抓、怎么判"。判决顺序是 load-bearing 的：
 * unreachable → blocked → login_required → captured。
 */
export const SET: ProbeSet = loadProbeSet("ctrip-live");

const RESULTS = SET.resultsDir;
export const OUT = path.join(RESULTS, "live_capture");

export const BLOCK_MARKERS: readonly string[] = markerList(SET, "block_text");
export const LOGIN_MARKERS: readonly string[] = markerList(SET, "login_text");

export const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
  + "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
export const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const BLOCK_ADVICE = "换一个能过携程风控的出口 IP（本环境实测：任何 UA/设备/区域组合都 432），"
  + "或改用携程官方/商务 API；拿到可访问的网络后重跑本命令即可";
export const LOGIN_ADVICE = "这个页面要求已登录：用 `--profile <dir>` 指向一个已登录的浏览器配置目录，"
  + "或先手工登录一次把会话留在该目录里，再重跑本命令";

export type CaptureVerdict = "captured" | "blocked" | "login_required" | "unreachable";

function pyRound1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** `time.strftime("%Y-%m-%d %H:%M:%S")`（本地时区）。 */
export function checkedAt(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 被风控挡住的判定：状态码 403/429/432，或正文里出现已知的挑战页特征。
 *
 * 单独抽成纯函数是为了能离线测试 —— 判定逻辑不该依赖"现在这个网络恰好被挡"。
 */
export function looksBlocked(status: number | null, text: string): boolean {
  if (status === 403 || status === 429 || status === 432) return true;
  const low = (text || "").toLowerCase();
  return BLOCK_MARKERS.some((m) => low.includes(m));
}

/** 页面能打开、但关键数据在登录墙后面（酒店价格就是这样）。 */
export function looksLoggedOut(text: string): boolean {
  return LOGIN_MARKERS.some((m) => (text || "").includes(m));
}

/**
 * **被重定向到登录页**与"抓到了"必须区分开。
 *
 * 实测（本环境）：带浏览器 UA 打开 `hotels.ctrip.com/hotels/list?...` 会跳到
 * `passport.ctrip.com/user/login?backurl=...`（title「登录首页」），只抓到一个登录表单的
 * 40 个元素 —— 第一版工具把这当成 "captured"，那是自欺。
 */
export function looksLoginRedirect(finalUrl: string, title = ""): boolean {
  const url = (finalUrl || "").toLowerCase();
  const t = title || "";
  if (SET.login.hosts.some((h) => url.includes(h.toLowerCase()))) return true;
  if (SET.login.paths.some((p) => url.includes(p.toLowerCase()))) return true;
  return SET.login.titles.some((x) => t.includes(x) || t.toLowerCase().includes(x.toLowerCase()));
}

export interface CaptureObservation {
  status?: number | null;
  body?: string;
  finalUrl?: string;
  title?: string;
  error?: unknown;
}

/**
 * 四种判决的**唯一**实现（顺序：unreachable → blocked → login_required → captured）。
 *
 * 纯函数，不碰网络也不碰浏览器；`captureOne` 只负责取证，判决全在这里。
 */
export function verdictFor(obs: CaptureObservation): CaptureVerdict {
  if (obs.error !== undefined && obs.error !== null && obs.error !== false && obs.error !== "") {
    return "unreachable";
  }
  if (looksBlocked(obs.status ?? null, obs.body ?? "")) return "blocked";
  if (looksLoginRedirect(obs.finalUrl ?? "", obs.title ?? "")) return "login_required";
  return "captured";
}

/**
 * (key, 说明, URL) —— 只列**用例真正需要**的两个页面。
 *
 * 用 `\n` 分隔的字符串换成了三个字段的元组，语义与 Python 版相同。
 */
export function targets(date: string): Array<[string, string, string]> {
  return SET.capture.map((t) => [t.id, t.label, fillProbeDate(t.url, date)] as const as [string, string, string]);
}

/**
 * `date + n` 天，ISO 字符串（唯一实现在 `probe-set.addDays`，这里保留导出以免调用方破坏）。
 * 非法日期仍然响亮报错（`ValueError`，与数据源那一档同口径）。
 */
export function addDays(date: string, n: number): string {
  try {
    return psAddDays(date, n);
  } catch {
    throw new D.ValueError(`Invalid isoformat string: ${JSON.stringify(date)}`);
  }
}

/** `layaapp.snapshot_text` 的三行等价物（与 `datasource.renderAndSnapshot` 同一渲染空间）。 */
export function snapshotText(elems: ElemPool, limit = 40): string {
  if (!elems || Object.keys(elems).length === 0) return "";
  return Object.values(criteriaView(elems, new Set(), null)).slice(0, limit).join("\n");
}

/** 抓页面时要用的最小 page 面。 */
export interface CapturePage extends PageLike {
  goto?(url: string, opts?: Record<string, unknown>): Promise<{ status(): number } | null | undefined>;
  waitForTimeout?(ms: number): Promise<void>;
  title?(): Promise<string> | string;
}

export interface CaptureDeps {
  extractElements?: (page: PageLike) => Promise<ElemPool>;
  snapshotText?: (elems: ElemPool, limit?: number) => string;
  pageText?: (page: any, head?: number, tail?: number) => Promise<string>;
  outDir?: string;
}

async function titleOf(page: CapturePage): Promise<string> {
  if (typeof page.title !== "function") return "";
  return String(await page.title());
}

/**
 * 抓一个页面：被挡 → 报清楚；能进 → 存下模型/人写计划要用的快照。
 *
 * `deps` 只为离线测试存在（默认就是真实实现）—— 这样"登录重定向不得判 captured"
 * 这类判决可以拿假 page 复现，而不是等一个恰好被重定向的网络。
 */
export async function captureOne(
  page: CapturePage,
  key: string,
  label: string,
  url: string,
  mobile = false,
  deps: CaptureDeps = {},
): Promise<Record<string, any>> {
  const extract = deps.extractElements ?? ((p: PageLike) => extractElements(p));
  const snap = deps.snapshotText ?? snapshotText;
  const readText = deps.pageText ?? ((p: any, h?: number, t?: number) => pageText(p, h, t));
  const outDir = deps.outDir ?? OUT;

  const rec: Record<string, any> = { key, label, url, mobile };
  const t0 = Date.now();
  let body = "";
  let status: number | null = null;
  let finalUrl = url;
  let title = "";
  try {
    const resp = page.goto
      ? await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 })
      : null;
    if (page.waitForTimeout) await page.waitForTimeout(6000);
    body = String(await page.evaluate!("() => (document.body && document.body.innerText) || ''"));
    status = resp && typeof resp.status === "function" ? resp.status() : null;
    finalUrl = urlOf(page);
    title = (await titleOf(page)).slice(0, 120);
    rec["status"] = status;
    rec["secs"] = pyRound1((Date.now() - t0) / 1000);
    rec["bytes_text"] = body.length;
    rec["final_url"] = finalUrl;
    rec["title"] = title;
  } catch (e) {
    rec["error"] = `${e instanceof Error ? e.name : typeof e}: `
      + `${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
    rec["secs"] = pyRound1((Date.now() - t0) / 1000);
    rec["verdict"] = "unreachable";
    return rec;
  }

  const verdict = verdictFor({ status, body, finalUrl, title });
  rec["verdict"] = verdict;
  if (verdict === "blocked") {
    rec["evidence"] = body.slice(0, 200).trim();
    rec["advice"] = BLOCK_ADVICE;
    return rec;
  }
  if (verdict === "login_required") {
    rec["evidence"] = `redirected to ${finalUrl.slice(0, 120)}`;
    rec["advice"] = LOGIN_ADVICE;
    return rec;
  }

  rec["logged_out_hint"] = looksLoggedOut(body);
  const elems = await extract(page);
  rec["elements"] = Object.keys(elems).length;
  fs.mkdirSync(outDir, { recursive: true });
  const snapPath = path.join(outDir, `${key}.md`);
  fs.writeFileSync(snapPath,
    `# ${label}\n\n`
    + `- URL: ${finalUrl}\n- HTTP: ${status} · title: ${title}\n`
    + `- 元素数：${Object.keys(elems).length}（下面这份快照与执行器看到的元素空间**完全一致**，`
    + "`plan_cli add --hint` / LLM 规划器都照它写 hint 与 signal）\n"
    + `${rec["logged_out_hint"] ? "- ⚠️ 页面疑似在登录墙后：价格类数据可能为空\n" : ""}\n`
    + "## 可选元素（criteria_view 渲染）\n\n```\n" + snap(elems) + "\n```\n\n"
    + "## 页面文本（前 300 + 后 150 字）\n\n```\n" + (await readText(page)) + "\n```\n",
    "utf-8");
  fs.writeFileSync(path.join(outDir, `${key}.json`),
    JSON.stringify(Object.entries(elems).map(([r, e]) => ({
      ref: r,
      ...Object.fromEntries(Object.entries(e).filter(([k]) => k !== "ref")),
    })), null, 1), "utf-8");
  rec["snapshot"] = snapPath;
  return rec;
}

const USAGE = `usage: live-capture [-h] [--date DATE] [--only {flights,hotels}] [--mobile]
                     [--profile PROFILE]

抓真实页面（探针集 ${SET.app}），产出可照写的计划快照`;

export interface CaptureArgs {
  date: string | null;
  only: string | null;
  mobile: boolean;
  profile: string | null;
  help: boolean;
}

export function parseArgv(argv: readonly string[]): CaptureArgs {
  const o: CaptureArgs = { date: null, only: null, mobile: false, profile: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "-h":
      case "--help": o.help = true; break;
      case "--date": o.date = String(argv[++i]); break;
      case "--only": o.only = String(argv[++i]); break;
      case "--mobile": o.mobile = true; break;
      case "--profile": o.profile = String(argv[++i]); break;
      default:
        if (a.startsWith("--date=")) o.date = a.slice(7);
        else if (a.startsWith("--only=")) o.only = a.slice(7);
        else if (a.startsWith("--profile=")) o.profile = a.slice(10);
        else throw new Error(`unrecognized argument: ${a}`);
    }
  }
  if (o.only !== null && o.only !== "flights" && o.only !== "hotels") {
    throw new Error(`argument --only: invalid choice: ${JSON.stringify(o.only)} (choose from 'flights', 'hotels')`);
  }
  return o;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let args: CaptureArgs;
  try {
    args = parseArgv(argv);
  } catch (e) {
    console.error(`live-capture: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const date = args.date ?? D.nextWeekDates()[0]!;
  const todo = targets(date).filter((t) => !args.only || t[0] === args.only);

  const pw: any = await import("playwright");
  const results: Array<Record<string, any>> = [];
  let b: any = null;
  let ctx: any = null;
  if (args.profile) {
    // 已登录会话：持久化上下文，登录态留在用户目录里。
    // PORT NOTE：TS 的 browser-env 没有 `launch_persistent_context`（Python 版有），
    // 所以这里直接用同一套 launchKwargs 调 playwright。
    ctx = await pw.chromium.launchPersistentContext(args.profile, {
      ...browserEnv.launchKwargs(true), headless: true, locale: "zh-CN", timezoneId: "Asia/Shanghai",
    });
  } else {
    b = await browserEnv.launch(pw, true);
    ctx = await b.newContext({
      locale: "zh-CN", timezoneId: "Asia/Shanghai",
      userAgent: args.mobile ? IPHONE_UA : BROWSER_UA,
      viewport: args.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      isMobile: Boolean(args.mobile), hasTouch: Boolean(args.mobile),
    });
  }
  for (const [key, label, url] of todo) {
    const rec = await captureOne(await ctx.newPage(), key, label, url, Boolean(args.mobile));
    console.log(`[${key}] ${rec["verdict"]}`
      + (rec["status"] ? `  HTTP ${rec["status"]}` : "")
      + (rec["elements"] !== undefined ? `  elements=${rec["elements"]}` : "")
      + (rec["error"] ? `  ${rec["error"]}` : ""));
    if (rec["verdict"] === "blocked") {
      console.log(`       evidence: ${JSON.stringify(String(rec["evidence"]).slice(0, 60))}`);
      console.log(`       advice  : ${rec["advice"]}`);
    } else if (rec["verdict"] === "captured") {
      console.log(`       snapshot: ${rec["snapshot"]}`);
    }
    results.push(rec);
  }
  if (b !== null) await b.close();
  else await ctx.close();

  fs.mkdirSync(RESULTS, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const captured = results.filter((r) => r["verdict"] === "captured").length;
  const verdicts: Record<string, string> = {};
  for (const r of results) verdicts[r["key"]] = r["verdict"];
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({
    date,
    mobile: Boolean(args.mobile),
    profile: args.profile,
    checked_at: checkedAt(),
    captured,
    total: results.length,
    verdicts,
    results,
  }, null, 2), "utf-8");
  console.log(`\n可抓取 ${captured}/${results.length}`
    + (captured === 0 ? "   ← 这个网络现在跑不了真实用例（见上面 advice）"
      : "   ← 快照可用于写真实站点的计划（plan_cli / LLM 规划器）"));
  console.log(`写入 ${path.join(OUT, "summary.json")}`);
  return captured ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
