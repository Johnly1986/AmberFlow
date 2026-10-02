/**
 * 线上可达性实测：携程的机票/酒店页面在本环境到底能拿到什么。
 *
 * 跑法：`node --experimental-strip-types src/live-probe.ts`（写 ctrip/results/live_probe.json）
 *
 * 测三件事，每件都用可复现的原始观测说话：
 *   1. HTTP 层：同一 URL 用「普通 UA（curl/httpx）」和「浏览器 UA」各取一次，
 *      记状态码/字节数/标题 —— 携程的 WhaleGuard 就对 UA+TLS 指纹打分；
 *   2. 浏览器层：Playwright 真浏览器（含首页预热拿 cookie、点「机票」入口）访问，
 *      记状态码与正文是否只剩 `whaleguard block`；
 *   3. 有没有**数据**：机票列表页是 Next.js 空壳（列表走 XHR），老的数据接口
 *      `/itinerary/api/12808/products` 已下线；酒店列表页能把 6000+ 家北京酒店的
 *      名称/星级 SSR 出来，但未登录访客的价格节点 `.price-line` 是空的
 *      （页面只给「登录以查看会员价」），因此「≤300 元」这个筛选条件拿不到。
 *
 * 结论写在 JSON 的 verdict 字段里 —— 判决逻辑是**纯函数** `verdictOf()`，可以用
 * 已提交的原始观测离线重算（`ts/tests/probes.test.ts` 就是拿
 * `ctrip/results/live_probe.json` 的 http/browser/flight_alt_shapes/mobile_and_regional
 * 重算 verdict，并要求与提交的 verdict 逐字段相等）。
 *
 * PORT NOTE（有意偏差，均有注释）：
 *   * `environment.python` 在 TS 版里没有意义 —— 改为 `runtime`/`node`，并保留
 *     `python: null` 让"这份 JSON 是哪个运行时产出的"显式可查；
 *   * CLI 多了 `--out` / `--no-browser` / `--no-mobile`（Python 版无参数），
 *     只为让"只跑 HTTP 层"和"写到别处"不必改代码。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as D from "./datasource.ts";
import * as browserEnv from "./browser-env.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.resolve(HERE, "..", "ctrip", "results");

export const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
export const PLAIN_UA = "curl/8.10.0";

export const TARGETS: ReadonlyArray<readonly [string, string, string]> = [
  ["flight_list_cn", "携程 PC 机票列表（昆明→北京 2026-10-05）",
    "https://flights.ctrip.com/online/list/oneway-kmg-bjs?depdate=2026-10-05"],
  ["flight_mobile_cn", "携程手机版机票（KMG→BJS 2026-10-05）",
    "https://m.ctrip.com/html5/flight/swift/domestic/KMG/BJS/2026-10-05"],
  ["flight_trip_com", "Trip.com 机票搜索（携程集团海外站）",
    "https://www.trip.com/flights/showfarefirst?dcity=kmg&acity=bjs&ddate=2026-10-05"
    + "&triptype=ow&class=y&quantity=1&locale=zh-CN&curr=CNY"],
  ["flight_api_retired", "老机票数据接口 /itinerary/api/12808/products",
    "https://flights.ctrip.com/itinerary/api/12808/products"],
  ["hotel_list_cn", "携程 PC 酒店列表（北京 2026-10-05 入住）",
    "https://hotels.ctrip.com/hotels/list?city=1&checkin=2026/10/05&checkout=2026/10/06"],
  ["hotel_home_cn", "携程首页（酒店搜索入口）", "https://www.ctrip.com/"],
];

/** 一条探测记录的 Python-dict 等价物（字段随客户端不同而变化）。 */
export type ProbeRecord = Record<string, any>;

const TITLE_RE = /<title>(.*?)<\/title>/s;
const PRICE_RE = /[¥￥]\s?\d[\d,]*/g;
const EMPTY_PRICE_RE = /class="price-line">\s*<\/div>/g;
const HOTEL_NAME_RE = /class="hotelName">([^<]{2,40})<\/span>/g;
const HOTEL_TOTAL_RE = /找到([\d,]+)家酒店/;

function pyRound1(x: number): number {
  return Math.round(x * 10) / 10;
}

function squashed(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(" ");
}

function head(s: string, n: number): string {
  return s.slice(0, n);
}

/** `time.strftime("%Y-%m-%d %H:%M:%S")`（本地时区）。 */
export function strftimeNow(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 把一次抓取压成可比较的形状（状态/大小/标题/关键标志/正文头）。 */
export function shape(ua: string, status: number, body: string, secs: number, url: string): ProbeRecord {
  const low = body.toLowerCase();
  const title = TITLE_RE.exec(body);
  const first = (re: RegExp, s: string): string => {
    const m = new RegExp(re.source, re.flags.replace("g", "")).exec(s);
    return m ? m[1]! : "";
  };
  return {
    ua,
    status,
    bytes: body.length,
    secs: pyRound1(secs),
    title: head(title ? title[1]! : "", 90),
    whaleguard: low.includes("whaleguard"),
    challenge: body.includes("Challenge Validation"),
    prices_yen: [...new Set(body.match(PRICE_RE) ?? [])].sort().slice(0, 8),
    body_head: head(squashed(body), 160),
    flight_rows: body.split("flight-card").length - 1 + (body.split("flight-list").length - 1),
    hotel_cards: body.split("hotelName").length - 1 + (body.split('class="hotel-card"').length - 1),
    empty_price_nodes: (body.match(EMPTY_PRICE_RE) ?? []).length,
    // 线上**确实能拿到**的那部分真实数据：酒店名/星级（价格拿不到）
    hotel_names_sample: [...body.matchAll(HOTEL_NAME_RE)].map((m) => m[1]!).slice(0, 12),
    hotel_total_tip: first(HOTEL_TOTAL_RE, body),
    login_wall: body.includes("以查看会员价") || body.includes("登录首页"),
    final_url: url,
  };
}

/**
 * 真 curl 命令行：TLS 指纹和 UA 都跟 fetch 不同。WhaleGuard 对这两者一起打分，
 * 所以「换个客户端就不一样」这件事本身必须被测出来，而不是口头声称。
 */
export function curlProbe(url: string, timeout = 25.0): ProbeRecord {
  const t0 = Date.now();
  const out = path.join(os.tmpdir(), `dsh-curl-probe-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    const cp = spawnSync("curl", [
      "-s", "-o", out, "-w", "%{http_code} %{size_download}",
      "-A", "curl/8.10.0", "-H", "Accept-Language: zh-CN,zh;q=0.9",
      "--max-time", String(Math.trunc(timeout)), url,
    ], { encoding: "utf8", timeout: (timeout + 5) * 1000 });
    if (cp.error) throw cp.error;
    const stdout = typeof cp.stdout === "string" ? cp.stdout : "";
    const sp = stdout.indexOf(" ");
    const code = sp === -1 ? stdout : stdout.slice(0, sp);
    const body = fs.existsSync(out) ? fs.readFileSync(out, "utf-8") : "";
    return shape("curl-cli", Number(code || 0), body, (Date.now() - t0) / 1000, url);
  } catch (e) {
    return {
      ua: "curl-cli",
      error: `${e instanceof Error ? e.name : typeof e}: ${head(e instanceof Error ? e.message : String(e), 160)}`,
      secs: pyRound1((Date.now() - t0) / 1000),
    };
  } finally {
    try { fs.rmSync(out, { force: true }); } catch { /* best effort */ }
  }
}

/** httpx 那一档在 Node 里就是全局 fetch（跟随重定向）。 */
export async function httpProbe(url: string, ua: string, timeout = 25.0): Promise<ProbeRecord> {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": ua, "Accept-Language": "zh-CN,zh;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeout * 1000),
    });
    const tag = ua === PLAIN_UA ? "httpx-普通UA" : "httpx-浏览器UA";
    const out = shape(tag, r.status, await r.text(), (Date.now() - t0) / 1000, r.url);
    out["ua"] = tag;
    return out;
  } catch (e) {                                   // 网络层失败也要留证据
    return {
      ua,
      error: `${e instanceof Error ? e.name : typeof e}: ${head(e instanceof Error ? e.message : String(e), 160)}`,
      secs: pyRound1((Date.now() - t0) / 1000),
    };
  }
}

// 机票还有别的入口形态（行程页 / 低价频道 / 手机版低价页）——"我只试了列表页"是
// 站不住脚的，所以这些也逐一实测记下来。
export const ALT_SHAPES: ReadonlyArray<readonly [string, string]> = [
  ["itinerary-oneway", "https://flights.ctrip.com/itinerary/oneway/kmg-bjs?date=2026-10-05"],
  ["itinerary-sortbyprice", "https://flights.ctrip.com/itinerary/oneway/KMG-BJS?date=2026-10-05&sortByPrice=true"],
  ["lowestprice-channel", "https://flights.ctrip.com/lowestprice/oneway-kmg-bjs"],
  ["mobile-lowestprice", "https://m.ctrip.com/html5/flight/lowestprice/KMG/BJS"],
  ["list-lowprice-param", "https://flights.ctrip.com/online/list/oneway-kmg-bjs?depdate=2026-10-05&lowprice_value=1"],
];

// 手机模拟与区域域名：UA/设备/区域任意组合都试一遍 —— 这些都没试过的话，
// "被封了"这个结论就不完整（机房 IP 封锁 vs UA 指纹，是两种完全不同的原因）。
export const MOBILE_TARGETS: ReadonlyArray<readonly [string, string]> = [
  ["ctrip-mobile-flight", "https://m.ctrip.com/html5/flight/swift/domestic/KMG/BJS/{date}"],
  ["trip-hk-flight", "https://hk.trip.com/flights/showfarefirst?dcity=kmg&acity=bjs"
    + "&ddate={date}&triptype=ow&class=y&quantity=1&locale=zh-HK&curr=CNY"],
  ["trip-us-flight", "https://us.trip.com/flights/showfarefirst?dcity=kmg&acity=bjs"
    + "&ddate={date}&triptype=ow&class=y&quantity=1&locale=en-US&curr=CNY"],
  ["trip-sg-flight", "https://sg.trip.com/flights/showfarefirst?dcity=kmg&acity=bjs"
    + "&ddate={date}&triptype=ow&class=y&quantity=1&locale=en-SG&curr=CNY"],
];

export const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
  + "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
export const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) "
  + "Chrome/126.0.0.0 Mobile Safari/537.36";

/** 同一批 URL，用 iPhone / Android 的 UA + 视口 + 触摸再试一遍。 */
export async function mobileProbe(dates: string[], verbose = true): Promise<ProbeRecord[]> {
  const pw: any = await import("playwright");
  const out: ProbeRecord[] = [];
  const b: any = await browserEnv.launch(pw, true);
  for (const [uaName, ua] of [["iphone", IPHONE_UA], ["android", ANDROID_UA]] as const) {
    const ctx: any = await b.newContext({
      locale: "zh-CN", timezoneId: "Asia/Shanghai", userAgent: ua,
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    });
    for (const [key, tpl] of MOBILE_TARGETS) {
      const url = tpl.replace("{date}", dates[0] ?? "");
      const pg: any = await ctx.newPage();
      const rec: ProbeRecord = { ua: uaName, key, url };
      try {
        const r = await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
        await pg.waitForTimeout(5000);
        const t: string = await pg.evaluate("()=>document.body?document.body.innerText:''");
        rec["status"] = r ? r.status() : null;
        rec["text_len"] = t.length;
        rec["whaleguard"] = t.toLowerCase().includes("whaleguard");
        rec["prices"] = (t.match(PRICE_RE) ?? []).length;
        rec["text_head"] = head(t.split("\n").map((x) => x.trim()).filter(Boolean).join(" | "), 90);
      } catch (e) {
        rec["error"] = `${e instanceof Error ? e.name : typeof e}: ${head(e instanceof Error ? e.message : String(e), 80)}`;
      }
      out.push(rec);
      if (verbose) {
        console.log(`  [mobile:${uaName}] ${key.padEnd(20)} status=${rec["status"]} `
          + `whaleguard=${pyBool(rec["whaleguard"])} ${rec["error"] ?? ""}`);
      }
      await pg.close();
    }
    await ctx.close();
  }
  await b.close();
  return out;
}

/** 真浏览器：首页预热 → 直接访问机票列表，看是否只剩 whaleguard block。 */
export async function browserProbe(verbose = true): Promise<ProbeRecord[]> {
  const pw: any = await import("playwright");
  const out: ProbeRecord[] = [];
  const b: any = await browserEnv.launch(pw, true);
  const ctx: any = await b.newContext({
    locale: "zh-CN", timezoneId: "Asia/Shanghai",
    userAgent: BROWSER_UA, viewport: { width: 1440, height: 900 },
  });
  const pg: any = await ctx.newPage();
  const home: ProbeRecord = { url: "https://www.ctrip.com/" };
  try {
    const r = await pg.goto(home["url"], { waitUntil: "domcontentloaded", timeout: 45000 });
    await pg.waitForTimeout(3000);
    home["status"] = r ? r.status() : null;
    home["title"] = head(await pg.title(), 90);
    home["cookies"] = (await ctx.cookies()).length;
    home["text_head"] = head(await pg.evaluate("()=>document.body.innerText"), 120);
  } catch (e) {
    home["error"] = `${e instanceof Error ? e.name : typeof e}: ${head(e instanceof Error ? e.message : String(e), 120)}`;
  }
  out.push(home);

  for (const [key, label, url] of [...TARGETS.slice(0, 1), ...TARGETS.slice(2, 3)]) {
    const rec: ProbeRecord = { key, label, url, browser: true };
    try {
      const r = await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await pg.waitForTimeout(6000);
      const txt: string = await pg.evaluate("()=>document.body?document.body.innerText:''");
      rec["status"] = r ? r.status() : null;
      rec["title"] = head(await pg.title(), 90);
      rec["bytes_text"] = txt.length;
      rec["whaleguard"] = txt.toLowerCase().includes("whaleguard");
      rec["text_head"] = head(txt.split("\n").map((x) => x.trim()).filter(Boolean).join(" | "), 160);
    } catch (e) {
      rec["error"] = `${e instanceof Error ? e.name : typeof e}: ${head(e instanceof Error ? e.message : String(e), 120)}`;
    }
    out.push(rec);
  }
  if (verbose) {
    for (const r of out) {
      console.log(`  [browser] ${String(r["key"] ?? "home").padEnd(16)} `
        + `status=${r["status"]} whaleguard=${pyBool(r["whaleguard"])} `
        + `title=${String(r["title"] ?? "").slice(0, 40)}`);
    }
  }
  await b.close();
  return out;
}

function pick(http: Record<string, ProbeRecord[]>, key: string, prefix: string): ProbeRecord {
  return (http[key] ?? []).find((x) => String(x["ua"] ?? "").startsWith(prefix)) ?? {};
}

function nonEmpty(r: ProbeRecord): boolean {
  return Object.keys(r).length > 0;
}

/** Python f-string 里的 bool 渲染是 `True`/`False` —— verdict 文本要与提交结果逐字一致。 */
function pyBool(v: unknown): string {
  return v ? "True" : "False";
}

/**
 * 判决：只用**已经观测到的原始数据**说话，是纯函数（可离线重算已提交的 verdict）。
 *
 * 注意这里对应 Python `main()` 里的 verdict 块，逐字段一致 —— `probes.test.ts`
 * 拿提交的 live_probe.json 重算并要求全等。
 */
export function verdictOf(
  http: Record<string, ProbeRecord[]>,
  browser: ProbeRecord[],
  alts: ProbeRecord[],
  mobile: ProbeRecord[],
): ProbeRecord {
  const flCurl = pick(http, "flight_list_cn", "curl-cli");
  const flChrome = pick(http, "flight_list_cn", "httpx-浏览器");
  const brFlight = browser.find((x) => x["key"] === "flight_list_cn") ?? {};
  const hotel = (() => {
    const a = pick(http, "hotel_list_cn", "curl-cli");
    return nonEmpty(a) ? a : pick(http, "hotel_list_cn", "httpx");
  })();
  const api = pick(http, "flight_api_retired", "curl-cli");
  const trip = pick(http, "flight_trip_com", "httpx-浏览器");

  return {
    flight_search: (flChrome["whaleguard"] || brFlight["whaleguard"]) ? "BLOCKED" : "OK",
    flight_reason: `flights.ctrip.com：浏览器 UA 走 httpx 得到 HTTP ${flChrome["status"]} `
      + `\`whaleguard block\`（${flChrome["bytes"]} B），真浏览器同样 `
      + `${brFlight["status"]} \`whaleguard block\`；换 curl-cli 才拿到 `
      + `${flCurl["bytes"]} B，但那是 Next.js 空壳（flight-card/list 标记 `
      + `${flCurl["flight_rows"]} 个，列表数据走 XHR），而老数据接口 `
      + `/itinerary/api/12808/products 已下线（${String(api["body_head"] ?? "").slice(0, 60)}）。`
      + `Trip.com 机票：httpx 浏览器 UA ${trip["status"]} `
      + `${trip["challenge"] ? "Challenge Validation" : ""}，真浏览器 `
      + "`whaleguard block`。",
    hotel_price: hotel["login_wall"] ? "LOGIN_REQUIRED" : "UNKNOWN",
    hotel_reason: `hotels.ctrip.com 列表页 SSR 出 ${hotel["hotel_cards"]} 个酒店名/星级标记，`
      + `但未登录访客的价格节点为空（${hotel["empty_price_nodes"]} 个空 .price-line），`
      + `正文含「登录以查看会员价」=${pyBool(hotel["login_wall"])}——`
      + "「¥300 以内」这个筛选条件拿不到数据来判定。",
    real_data_available: {
      hotel_names: hotel["hotel_names_sample"] ?? [],
      hotel_total_tip: hotel["hotel_total_tip"] ?? "",
      note: "酒店名/星级是真的（SSR），价格/房态不是（登录墙）",
    },
    flight_alt_shapes_all_432: alts.every((a) => a["status"] === 432),
    mobile_and_regional_all_432: mobile.every((m) => m["status"] === 432),
    usable_for_case: false,
    fallback: "ctrip/site/ 本地复刻站（同一交互路径 / 同一用例口径），见 ctrip/ctrip_task.py",
  };
}

export interface LiveProbeDeps {
  curlProbe?: (url: string, timeout?: number) => ProbeRecord;
  httpProbe?: (url: string, ua: string, timeout?: number) => Promise<ProbeRecord>;
  mobileProbe?: (dates: string[], verbose?: boolean) => Promise<ProbeRecord[]>;
  browserProbe?: (verbose?: boolean) => Promise<ProbeRecord[]>;
  nextWeekDates?: () => string[];
}

const USAGE = `usage: live-probe [-h] [--out OUT] [--no-browser] [--no-mobile]

线上可达性实测（携程机票/酒店），写 ctrip/results/live_probe.json`;

export function parseArgv(argv: readonly string[]): {
  out: string | null; noBrowser: boolean; noMobile: boolean; help: boolean;
} {
  let out: string | null = null;
  let noBrowser = false;
  let noMobile = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "-h":
      case "--help": help = true; break;
      case "--out": out = String(argv[++i]); break;
      case "--no-browser": noBrowser = true; break;
      case "--no-mobile": noMobile = true; break;
      default:
        if (a.startsWith("--out=")) out = a.slice(6);
        else throw new Error(`unrecognized argument: ${a}`);
    }
  }
  return { out, noBrowser, noMobile, help };
}

export async function main(argv: readonly string[] = process.argv.slice(2), deps: LiveProbeDeps = {}): Promise<number> {
  let args;
  try {
    args = parseArgv(argv);
  } catch (e) {
    console.error(`live-probe: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const doCurl = deps.curlProbe ?? curlProbe;
  const doHttp = deps.httpProbe ?? httpProbe;
  const doMobile = deps.mobileProbe ?? mobileProbe;
  const doBrowser = deps.browserProbe ?? browserProbe;
  const doNextWeek = deps.nextWeekDates ?? (() => D.nextWeekDates());

  console.log("== HTTP 层（同一 URL，两种 UA） ==");
  const http: Record<string, ProbeRecord[]> = {};
  for (const [key, label, url] of TARGETS) {
    http[key] = [{ ...doCurl(url), label }];
    for (const ua of [PLAIN_UA, BROWSER_UA]) {
      http[key]!.push({ ...(await doHttp(url, ua)), label });
    }
    for (const r of http[key]!) {
      console.log(`  ${key.padEnd(20)} ${String(r["ua"]).padEnd(14)} -> status=${r["status"]} `
        + `bytes=${r["bytes"]} whaleguard=${pyBool(r["whaleguard"])} `
        + `challenge=${pyBool(r["challenge"])} ${r["error"] ?? ""}`);
    }
  }
  // 手机版机票页曾经偶然回过一次 200（82 KB）—— 是边缘缓存漏网还是稳定可达，
  // 必须用重复请求说话，不能拿一次偶然当结论。
  console.log("\n== 重复请求（手机版机票页 ×5，浏览器 UA） ==");
  const flaky: Array<number | undefined> = [];
  for (let i = 0; i < 5; i++) flaky.push((await doHttp(TARGETS[1]![2], BROWSER_UA, 20))["status"]);
  console.log(`  status 序列: [${flaky.join(", ")}]`);

  console.log("\n== 机票的其他入口形态（浏览器 UA） ==");
  const alts: ProbeRecord[] = [];
  for (const [key, url] of ALT_SHAPES) {
    const r: ProbeRecord = { ...(await doHttp(url, BROWSER_UA, 20)), key };
    alts.push(r);
    console.log(`  ${key.padEnd(22)} status=${r["status"]} bytes=${r["bytes"]} whaleguard=${pyBool(r["whaleguard"])}`);
  }
  console.log(`  五种入口全部被挡 = ${alts.every((a) => a["status"] === 432)}`);

  console.log("\n== 手机模拟 + 区域域名（UA/设备/区域都换一遍） ==");
  const mobile = args.noMobile ? [] : await doMobile(doNextWeek());

  console.log("\n== 浏览器层（Playwright + Chrome UA） ==");
  const browser = args.noBrowser ? [] : await doBrowser();

  const hotelForPrint = (() => {
    const a = pick(http, "hotel_list_cn", "curl-cli");
    return nonEmpty(a) ? a : pick(http, "hotel_list_cn", "httpx");
  })();
  console.log(`  线上可拿到的真实数据：酒店名 ${JSON.stringify(hotelForPrint["hotel_names_sample"])} `
    + `（页面自报 ${hotelForPrint["hotel_total_tip"]} 家）`);

  const verdict = verdictOf(http, browser, alts, mobile);
  console.log("\n== 结论 ==");
  for (const [k, v] of Object.entries(verdict)) console.log(`  ${k}: ${JSON.stringify(v)}`);

  const payload = {
    checked_at: strftimeNow(),
    mobile_flight_repeat_status: flaky,
    flight_alt_shapes: alts,
    mobile_and_regional: mobile,
    environment: {
      // PORT NOTE: Python 版在这里写解释器版本；TS 版如实写 node，并保留 python=null。
      runtime: `node ${process.versions.node}`,
      node: process.versions.node,
      python: null,
      browser_ua: BROWSER_UA,
      plain_ua: PLAIN_UA,
    },
    http,
    browser,
    verdict,
  };
  const outPath = args.out ?? path.join(RESULTS, "live_probe.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`\n写入 ${outPath}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
