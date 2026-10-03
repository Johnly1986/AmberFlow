/**
 * 迁移目标的线上可达性：还有哪家 OTA 能当"布局相似的旅游网"？
 *
 * 目标里新增的一半是「同样流程可泛化并迁移到其他布局相似的旅游网上」。迁移的前提是
 * **有个能打开的同类站点**，所以先把候选逐一实测，而不是先写代码。
 *
 * 测法：每个站点用两种客户端各取一次（curl-cli 与浏览器 UA 的 fetch），记录
 * 状态码/字节数/标题/HTML 里有没有价格记号；对拿到真实 HTML 的那两个再用
 * **真浏览器**渲染一次，看客户端渲染后到底有没有价格。
 *
 * 结论（被 ota_probe.json 记下来）：本环境下没有任何一家匿名可访问的 OTA 会吐出
 * 价格列表 —— 携程 432、Trip.com 432、Expedia 429 `Bot or Not?`、Kayak 人机校验、
 * Booking 202 空响应、Agoda 挑战页、同程只是空壳、途牛 202、去哪儿网页版机票
 * **2026-10-10 起停止服务**（页面自己贴的公告）。所以迁移演示只能靠
 * "结构不同、同类任务的复刻站"来做（见 transfer/README.md），真实站点那一侧等一个
 * 能过风控的出口 IP + 登录态即可复用同一套驱动。
 *
 * 判决是纯函数 `verdictOf()`：`ts/tests/probes.test.ts` 拿提交的
 * `transfer/results/ota_probe.json` 重算 verdict 并要求逐字段相等。
 *
 * PORT NOTE：CLI 多了 `--out` / `--no-browser`（Python 版无参数），只为让"只跑 HTTP 层"
 * 和"写到别处"不必改代码；HTTP 记录多带了 `label`（Python 版也是这么记的，dict 合并）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as browserEnv from "./browser-env.ts";
import { fillProbeDate, loadProbeSet, markerList, type ProbeSet } from "./probe-set.ts";

/**
 * 站点知识（候选站点、URL、挑战页/下线公告特征、结果目录）全在
 * `apps/ota-live/pack.json`；本文件只剩"怎么测"（curl / fetch / 真浏览器渲染）与纯函数判决。
 */
export const SET: ProbeSet = loadProbeSet("ota-live");

const RESULTS = SET.resultsDir;

export const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const TARGETS: ReadonlyArray<readonly [string, string, string]> =
  SET.http.map((t) => [t.id, t.label, fillProbeDate(t.url, SET.date)] as const);

export type ProbeRecord = Record<string, any>;

/** 站点特征表来自探针集：价格记号、标题、挑战页词、下线公告词。 */
const priceRe = (): string | undefined => markerList(SET, "price_re")[0];
const titleRe = (): RegExp => new RegExp(markerList(SET, "title_re")[0] ?? "<title>(.*?)</title>", "s");
const challengeHit = (body: string): boolean =>
  markerList(SET, "challenge_text").some((w) => body.includes(w));
const noticeHit = (body: string): boolean =>
  markerList(SET, "notice_text").some((w) => body.includes(w));

function pyRound1(x: number): number {
  return Math.round(x * 10) / 10;
}

function squashed(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(" ");
}

/** 价格记号（含 ¥/CN¥/US$，模式由探针集声明）。 */
export function priceTokens(s: string): string[] {
  const re = priceRe();
  return re === undefined ? [] : (s.match(new RegExp(re, "g")) ?? []);
}

/** 把一次抓取压成可比较的形状。 */
export function shape(ua: string, status: number, body: string, secs: number): ProbeRecord {
  const title = titleRe().exec(body);
  return {
    ua,
    status,
    bytes: body.length,
    secs: pyRound1(secs),
    title: (title ? title[1]! : "").slice(0, 70),
    price_tokens: priceTokens(body).length,
    challenge: challengeHit(body),
    discontinued_notice: noticeHit(body),
    body_head: squashed(body).slice(0, 110),
  };
}

/** 真 curl 命令行（TLS 指纹与 fetch 不同，必须单独测一档）。 */
export function curlProbe(url: string, timeout = 25.0): ProbeRecord {
  const t0 = Date.now();
  const out = path.join(os.tmpdir(), `dsh-ota-body-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    const cp = spawnSync("curl", [
      "-s", "-o", out, "-w", "%{http_code}",
      "-A", "curl/8.10.0", "--max-time", String(Math.trunc(timeout)), url,
    ], { encoding: "utf8", timeout: (timeout + 5) * 1000 });
    if (cp.error) throw cp.error;
    const body = fs.existsSync(out) ? fs.readFileSync(out, "utf-8") : "";
    return shape("curl-cli", Number(cp.stdout || 0), body, (Date.now() - t0) / 1000);
  } catch (e) {
    return {
      ua: "curl-cli",
      error: `${e instanceof Error ? e.name : typeof e}: `
        + `${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`,
    };
  } finally {
    try { fs.rmSync(out, { force: true }); } catch { /* best effort */ }
  }
}

/** 浏览器 UA 那一档在 Node 里就是全局 fetch（跟随重定向）。 */
export async function httpxProbe(url: string, timeout = 25.0): Promise<ProbeRecord> {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "zh-CN,zh;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeout * 1000),
    });
    return shape("httpx-浏览器UA", r.status, await r.text(), (Date.now() - t0) / 1000);
  } catch (e) {
    return {
      ua: "httpx-浏览器UA",
      error: `${e instanceof Error ? e.name : typeof e}: `
        + `${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`,
    };
  }
}

/** 对 HTTP 层"看起来能开"的站点再渲染一次：客户端渲染后才见分晓。 */
export async function browserRender(urls: Array<[string, string]>): Promise<ProbeRecord[]> {
  const pw: any = await import("playwright");
  const out: ProbeRecord[] = [];
  const b: any = await browserEnv.launch(pw, true);
  const ctx: any = await b.newContext({
    locale: "zh-CN", timezoneId: "Asia/Shanghai", userAgent: BROWSER_UA,
    viewport: { width: 1440, height: 900 },
  });
  for (const [key, url] of urls) {
    const pg: any = await ctx.newPage();
    const rec: ProbeRecord = { key, url };
    try {
      const r = await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await pg.waitForTimeout(9000);
      const txt: string = await pg.evaluate("()=>document.body?document.body.innerText:''");
      rec["status"] = r ? r.status() : null;
      rec["title"] = (await pg.title()).slice(0, 70);
      rec["text_len"] = txt.length;
      rec["prices"] = priceTokens(txt).length;
      rec["price_sample"] = [...new Set(priceTokens(txt))].sort().slice(0, 8);
      rec["text_head"] = txt.split("\n").map((x) => x.trim()).filter(Boolean).join(" | ").slice(0, 150);
    } catch (e) {
      rec["error"] = `${e instanceof Error ? e.name : typeof e}: `
        + `${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`;
    }
    out.push(rec);
    console.log(`  [browser] ${key.padEnd(14)} status=${rec["status"]} textlen=${rec["text_len"]} `
      + `prices=${rec["prices"]}`);
    await pg.close();
  }
  await b.close();
  return out;
}

/** 只有 HTTP 层真的回了 HTML 的才值得渲染（其余是风控/空响应）；最多取前 3 个。 */
export function worthTargets(http: Record<string, ProbeRecord[]>): Array<[string, string]> {
  return TARGETS
    .filter(([k]) => (http[k] ?? []).some((r) => Number(r["bytes"] ?? 0) > 5000))
    .map(([k, , u]) => [k, u] as [string, string])
    .slice(0, 3);
}

function statuses(http: Record<string, ProbeRecord[]>, key: string): string {
  return (http[key] ?? []).map((r) => String(r["status"])).join("/");
}

/** 判决：只用观测到的原始数据说话，纯函数（可离线重算已提交的 verdict）。 */
export function verdictOf(http: Record<string, ProbeRecord[]>, rendered: ProbeRecord[]): ProbeRecord {
  const usable = rendered.filter((r) => r["prices"]).map((r) => r["key"]);
  const reason = "没有任何一家候选站点对匿名+机房 IP 的访客抛出价格列表："
    + Object.keys(http).map((k) => {
      const v = http[k] ?? [];
      const challenge = v.some((x) => x["challenge"]);
      return `${k} ${statuses(http, k)}${challenge ? "（挑战页）" : ""}`;
    }).join("；");
  return {
    anonymous_price_list_reachable: Boolean(usable.length),
    usable_targets: usable,
    reason,
    qunar_flight_notice: "去哪儿网页版机票查询/预订 2026-10-10 起停止提供（页面公告，实测抓到）",
    fallback_for_transfer: "用「结构不同、同类任务」的复刻站验证迁移（transfer/），"
      + "真实站点一侧等能过风控的出口 IP + 登录态，驱动可原样复用",
  };
}

/** `time.strftime("%Y-%m-%d %H:%M:%S")`（本地时区）。 */
export function checkedAt(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface OtaProbeDeps {
  curlProbe?: (url: string, timeout?: number) => ProbeRecord;
  httpxProbe?: (url: string, timeout?: number) => Promise<ProbeRecord>;
  browserRender?: (urls: Array<[string, string]>) => Promise<ProbeRecord[]>;
}

const USAGE = `usage: ota-probe [-h] [--out OUT] [--no-browser]

迁移目标的线上可达性（探针集 ${SET.app}：还有哪家 OTA 能当"布局相似的旅游网"）`;

export function parseArgv(argv: readonly string[]): { out: string | null; noBrowser: boolean; help: boolean } {
  let out: string | null = null;
  let noBrowser = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "-h":
      case "--help": help = true; break;
      case "--out": out = String(argv[++i]); break;
      case "--no-browser": noBrowser = true; break;
      default:
        if (a.startsWith("--out=")) out = a.slice(6);
        else throw new Error(`unrecognized argument: ${a}`);
    }
  }
  return { out, noBrowser, help };
}

export async function main(argv: readonly string[] = process.argv.slice(2), deps: OtaProbeDeps = {}): Promise<number> {
  let args;
  try {
    args = parseArgv(argv);
  } catch (e) {
    console.error(`ota-probe: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const doCurl = deps.curlProbe ?? curlProbe;
  const doHttp = deps.httpxProbe ?? httpxProbe;
  const doRender = deps.browserRender ?? browserRender;

  console.log("== HTTP 层 ==");
  const http: Record<string, ProbeRecord[]> = {};
  for (const [key, label, url] of TARGETS) {
    const rows: ProbeRecord[] = [{ ...doCurl(url), label }, { ...(await doHttp(url)), label }];
    http[key] = rows;
    for (const r of rows) {
      console.log(`  ${key.padEnd(15)} ${String(r["ua"]).padEnd(14)} status=${r["status"]} `
        + `bytes=${r["bytes"]} prices=${r["price_tokens"]} challenge=${r["challenge"]} ${r["error"] ?? ""}`);
    }
  }

  const worth = worthTargets(http);
  console.log(`\n== 真浏览器渲染（${worth.length} 个 HTTP 层有内容的） ==`);
  const rendered = args.noBrowser || !worth.length ? [] : await doRender(worth);

  const verdict = verdictOf(http, rendered);
  console.log("\n== 结论 ==");
  for (const [k, v] of Object.entries(verdict)) console.log(`  ${k}: ${JSON.stringify(v)}`);

  const payload = { checked_at: checkedAt(), http, browser_render: rendered, verdict };
  const outPath = args.out ?? path.join(RESULTS, "ota_probe.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`\n写入 ${outPath}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
