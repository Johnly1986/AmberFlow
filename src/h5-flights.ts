/**
 * 携程 H5 线路页 —— 真实机票价格（配置驱动，本文件只剩一层薄壳）。
 *
 * **这个文件里没有任何携程知识**：URL 模板、"从哪个 JSON 路径取航班"、"哪个字段是
 * 出发时刻/价格"、时间窗、选优规则 —— 全部在 `ctrip/sources/ctrip-flights-h5.json`
 * 里，由通用引擎 `datasource.ts` 执行。换一个站点 = 加一份配置（酒店那半就是同一个
 * 引擎跑的 `ctrip/sources/ctrip-hotels-pc.json`）。
 *
 * 发现过程（第 10 轮）：`m.ctrip.com/html5/` 在**浏览器里**是 432，用 **curl** 却是
 * 200；顺着它找到真正的数据页 `https://m.ctrip.com/html5/flight/<dcity>-<acity>-day-<N>.html`
 * （N = 目标日期 − 今天）。风控矩阵（同一 URL）：
 *
 * | 客户端 | 结果 |
 * |---|---|
 * | `curl`（默认 UA）/ `curl` + iPhone Safari UA | **200 / 1.5 MB** |
 * | `curl` + Chrome UA | 432 `whaleguard block` |
 * | Python `httpx`（任意 UA） | 432 |
 * | Chromium / Playwright `context.request` | 432 |
 *
 * 即 WhaleGuard 按 **TLS/HTTP2 指纹 + UA** 打分（"非浏览器"放行、浏览器一律拦），
 * 所以取数必须走 `curl`（`datasource.curlGet`），渲染与决策仍走 harness。
 *
 *     node --experimental-strip-types src/h5-flights.ts                      # = datasource.ts --source ctrip-flights-h5
 *     node --experimental-strip-types src/h5-flights.ts --window 06:00 12:00 # 覆盖配置里的时间窗（内存里改，不落盘）
 *     node --experimental-strip-types src/datasource.ts --source ctrip-hotels-pc --dates 2026-10-09   # 同一引擎：酒店源
 *
 * **边界**：酒店侧匿名拿不到价格节点（`.price-line` 为空 + 「登录以查看会员价」），
 * 所以"出发当日 ≤300 元的酒店"仍需登录态。
 *
 * PORT NOTE：与 Python `ctrip/h5_flights.py` 逐函数对齐；唯一的有意偏差是
 * `parsePage` 在抽取到 **0 行** 时抛 `ValueError`（Python 版会把空列表交出去）。
 * 理由就是那条测试的名字 —— `test_h5_parse_fails_loudly_on_a_blocked_body`：
 * WhaleGuard 的 432 正文有时仍是 200 的空壳，"零结果"绝不能被当成"这天没有航班"。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as D from "./datasource.ts";
import type { DateEntry, DateLike, Rendered, Row, Source } from "./datasource.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SOURCE = "ctrip-flights-h5";
/** 默认值来自配置；这里只是给调用方一个可读常量。 */
export const WINDOW: readonly [string, string] = ["08:00", "18:00"];
export const RESULTS = path.resolve(HERE, "..", "ctrip", "results");

export interface H5Page {
  date: unknown;
  strip: unknown;
  itineraries: Row[];
}

export function source(): Source {
  return D.loadSource(SOURCE);
}

/**
 * 按配置抽取当天航班。返回 `{date, strip, itineraries}`（形状与第一版一致）。
 *
 * 解析失败（正文是 `whaleguard block`、或没有 `window.__INITIAL_STATE__`）时
 * `datasource.extract` 抛 `ValueError`；即便状态码是 200 但抽到 0 行，这里也抛 ——
 * 「静默空数据」比报错危险得多。
 */
export function parsePage(html: string): H5Page {
  const page = D.extract(html, source());
  if (page.rows.length === 0) {
    throw new D.ValueError(
      `${SOURCE}: parsed 0 itineraries from ${html.length} B body `
      + "(blocked, an empty shell, or a different page shape?)",
    );
  }
  return { date: page.date, strip: page.strip, itineraries: page.rows };
}

/** 用例口径：出发时刻在 `[lo, hi]` 闭区间内取最低价（同价取更早起飞）。 */
export function lowest(
  rows: Row[],
  lo: string = WINDOW[0],
  hi: string = WINDOW[1],
  nonstopOnly = false,
): Row | null {
  const src = source();
  src["filters"] = { ...((src["filters"] as Record<string, unknown>) || {}), window: [lo, hi] };
  const sel: Record<string, unknown> = { key: "best", sort_by: ["price", "dep"] };
  if (nonstopOnly) sel["where"] = { stops: 0 };
  return D.selectBest(rows, src, sel);
}

/**
 * 线路页的 `day-N` = 今天 + N 天（实测：今天 2026-10-02 时 day-3 的列表是 10-05）。
 *
 * 返回 `[url, n]`（Python 版返回 tuple，语义相同）。
 */
export function dayUrl(
  date: string,
  today: DateLike | null = null,
  dcity = "kmg",
  acity = "bjs",
): [string, number] {
  const src = source();
  src["constants"] = { ...((src["constants"] as Record<string, unknown>) || {}), dcity, acity };
  const n = D.dateParams(src, date, today)["n"];
  return [D.urlFor(src, date, today), Number(n)];
}

export function inWindow(t: unknown, lo: string = WINDOW[0], hi: string = WINDOW[1]): boolean {
  return D.inWindow(t, lo, hi);
}

/** curl-only 传输：WhaleGuard 只认这个客户端（见文件头矩阵）。 */
export function curlGet(url: string, timeout = 60.0): Promise<[number, string]> {
  return D.curlGet(url, timeout);
}

/** `--render`：抓到真实 HTML 后交给执行器抽取层渲染（复用 `datasource.renderAndSnapshot`）。 */
export function renderAndSnapshot(html: string): Promise<Rendered> {
  return D.renderAndSnapshot(html);
}

export function toMarkdown(
  perDate: Record<string, DateEntry>,
  _today: DateLike,
  rendered?: Rendered | Record<string, unknown> | null,
): string {
  return D.reportMarkdown(source(), perDate, rendered ?? null);
}

const USAGE = `usage: h5-flights [-h] [--dates [DATES ...]] [--window LO HI] [--render]
                  [--save-raw DIR]

抓携程 H5 线路页，给出真实机票价格（配置驱动）`;

export function parseArgv(argv: readonly string[]): {
  dates: string[] | null;
  window: [string, string] | null;
  render: boolean;
  saveRaw: string | null;
  help: boolean;
} {
  let dates: string[] | null = null;
  let win: [string, string] | null = null;
  let render = false;
  let saveRaw: string | null = null;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "-h":
      case "--help": help = true; break;
      case "--dates": {
        // argparse nargs="*"：吃到下一个开关为止
        const out: string[] = [];
        while (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) out.push(argv[++i]!);
        dates = out;
        break;
      }
      case "--window": {
        const lo = argv[++i];
        const hi = argv[++i];
        if (lo === undefined || hi === undefined) throw new Error("--window requires two values");
        win = [lo, hi];
        break;
      }
      case "--render": render = true; break;
      case "--save-raw": saveRaw = String(argv[++i]); break;
      default:
        if (a.startsWith("--dates=")) dates = a.slice(8).split(",").filter(Boolean);
        else if (a.startsWith("--window=")) {
          const [lo, hi] = a.slice(9).split(",");
          if (!lo || !hi) throw new Error("--window requires two values");
          win = [lo, hi];
        } else if (a.startsWith("--save-raw=")) saveRaw = a.slice(11);
        else throw new Error(`unrecognized argument: ${a}`);
    }
  }
  return { dates, window: win, render, saveRaw, help };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let args;
  try {
    args = parseArgv(argv);
  } catch (e) {
    console.error(`h5-flights: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const src = source();
  if (args.window) {
    src["filters"] = { ...((src["filters"] as Record<string, unknown>) || {}), window: [...args.window] };
  }
  const dates = args.dates && args.dates.length ? args.dates : D.nextWeekDates();

  const res = await D.runSource(src, dates, { saveRaw: args.saveRaw, render: args.render });

  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, "real_flights.json"),
    JSON.stringify(res, null, 2), "utf-8");
  const rowsForReport: Record<string, DateEntry> = {};
  for (const [d, v] of Object.entries(res.dates)) if (v.rows) rowsForReport[d] = v;
  const md = D.reportMarkdown(src, rowsForReport, res.rendered || null);
  fs.writeFileSync(path.join(RESULTS, "real_flights.md"), md, "utf-8");
  console.log(`\n写入 ${path.join(RESULTS, "real_flights.json")} 与 ${path.join(RESULTS, "real_flights.md")}`);
  console.log(`（字段映射来自 ${String(src["_path"])}；通用入口：node src/datasource.ts --source ${SOURCE}）`);
  return Object.values(res.dates).some((v) => "rows" in v) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
