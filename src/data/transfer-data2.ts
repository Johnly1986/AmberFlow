/**
 * 复刻站 #2（SkyBook）的数据与判分口径 —— `transfer/data2.py` 的 TS 孪生。
 *
 * 迁移要证明的是「**流程**可迁移」，所以这里刻意跟携程复刻站分家：
 *   * 自己的库存（虚构航司 SkyWise/NorthExpress/…，价格与携程那套不同）；
 *   * 自己的生成种子与航班时刻表 —— 所以"五天里最便宜的那天"和"≤300 的酒店"都不一样；
 *   * 但**判分口径直接复用** `ctrip-data.ts` 里那几个与数据集无关的函数
 *     （`inWindow` / `lowestFlight` / `bestOverall` / `hotelsUnder` 都只吃"数据"参数）。
 *     这本身就是一个结论：**判分语义是站点的、库存是站点的、流程是共用的**。
 *
 * ## 逐字节复刻 Python 的随机数（与 `ctrip-data.ts` 同一套已验证的机器）
 *
 * `transfer/site2/data2.js` 是 Python 生成的已提交文件；`dumpJs()` 必须与它逐字节
 * 相等，所以这里复用 `ctrip-data.ts` 的 `PyRandom`（MT19937 + v2 字符串种子 +
 * `_randbelow` 拒绝采样）、`pyRound` / `pyRound1`（CPython 取整）与 `addMinutes`，
 * 并且 `buildFlights`/`buildHotels` 的调用顺序与 Python 完全一致：
 * 先 `choice(inWin)` 再 `choice(outWin)`，然后每个时刻一次 `randrange`。
 *
 * ## 与 Python 的有意偏差
 *   * `build_hotels(n, seed)` 的 `seed` 参数在 Python 里**未被使用**（纯算术生成），
 *     这里保留同名参数以对齐签名，同样不使用。
 *   * Python 的 `assert budget_slots == 15` 在 TS 里变成显式抛错（同一条不变式，
 *     只是 TS 没有 `assert` 语句）。
 *   * 判分函数是薄包装：转成 `ctrip-data.ts` 的判分口径执行，只换数据类型。
 */
import * as fs from "node:fs";
import { REPO } from "../support/paths.ts";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as base from "./ctrip-data.ts";


export const SITE = path.join(REPO, "transfer", "site2");
export const DATA_JS = path.join(SITE, "data2.js");

/** 判分口径（与数据集无关，原样复用 ctrip 的实现）。 */
export const WINDOW = base.WINDOW;
export const nextWeekDates = base.nextWeekDates;
export const weekdayCn = base.weekdayCn;
export const inWindow = base.inWindow;
export { pyRound, pyRound1, addMinutes } from "./ctrip-data.ts";

export const CARRIERS: ReadonlyArray<readonly [string, string]> = [
  ["SW", "SkyWise Air"], ["NE", "NorthExpress"], ["PB", "PacificBridge"],
  ["LM", "LuckyMoon"], ["AJ", "Aurora Jet"], ["SR", "SilkRoad Wings"],
];

/** (出发, 时长, 机型, 基准价) —— 时刻表与携程那套错开，最低价落在别的班次上。 */
export const SCHEDULE: ReadonlyArray<readonly [string, string, string, number]> = [
  ["05:55", "3h20m", "A320neo", 470],
  ["07:10", "3h05m", "B737 MAX", 520],
  ["07:55", "3h35m", "A321", 575],
  ["08:35", "3h15m", "B787-8", 700],
  ["09:40", "3h25m", "A330-300", 815],
  ["11:05", "3h10m", "A320", 880],
  ["12:20", "3h30m", "B737-800", 935],
  ["13:45", "3h15m", "A321neo", 1010],
  ["14:50", "3h20m", "B787-9", 965],
  ["16:15", "3h05m", "A320", 890],
  ["17:30", "3h25m", "A321", 760],
  ["17:55", "3h15m", "B737-800", 705],
  ["18:20", "3h30m", "A330-200", 610],
  ["20:05", "3h10m", "A320neo", 545],
  ["22:15", "3h20m", "B787-8", 455],
];

export const HOTEL_AREAS: readonly string[] = [
  "Wangfujing", "Guomao CBD", "Sanlitun", "Xidan", "Zhongguancun", "Wangjing",
  "Capital Airport", "Beijing South", "Wudaokou", "Yayuncun", "Yizhuang", "Tiananmen",
];
export const HOTEL_BRANDS: readonly string[] = [
  "Sunrise", "Jade Garden", "Harbor Inn", "Lantern", "North Gate", "Plaza View",
  "Willow", "Compass", "Silk Tree", "Blue Pine", "Courtyard 9", "Meridian",
];

/** 站点自己的库存形状：比携程多一个 `carrier`，没有 `tax`。 */
export interface Flight {
  date: string;
  no: string;
  airline: string;
  carrier: string;
  from: string;
  to: string;
  dep: string;
  arr: string;
  dur: string;
  plane: string;
  price: number;
  cabin: string;
  promo: boolean;
}
export type Hotel = base.Hotel;

export function buildFlights(dates?: readonly string[] | null): Flight[] {
  const ds = dates && dates.length ? dates : nextWeekDates();
  const out: Flight[] = [];
  for (let dayI = 0; dayI < ds.length; dayI++) {
    const date = ds[dayI]!;
    const rng = new base.PyRandom(`skybook|KMG-BJS|${date}`);
    // 与携程不同的调价节奏：周中便宜、周一/周五贵
    const factor = [1.22, 1.04, 0.96, 0.99, 1.12][dayI % 5]!;
    const inWin: number[] = [];
    const outWin: number[] = [];
    SCHEDULE.forEach(([dep], i) => (inWindow(dep) ? inWin : outWin).push(i));
    // Python 字典字面量的求值顺序：键1 -> 值1 -> 键2 -> 值2
    const promo = new Map<number, number>();
    promo.set(rng.choice(inWin), 0.74);
    promo.set(rng.choice(outWin), 0.72);
    SCHEDULE.forEach(([dep, dur, plane, basePrice], i) => {
      const [code, name] = CARRIERS[(i + 2 * dayI) % CARRIERS.length]!;
      const raw = basePrice * factor * (promo.get(i) ?? 1.0) + rng.randrange(-5, 6) * 10;
      out.push({
        date, no: `${code}${200 + ((i * 53 + dayI * 17) % 799)}`,
        airline: name, carrier: code, from: "KMG", to: "BJS",
        dep, arr: base.addMinutes(dep, dur), dur, plane,
        price: Math.max(280, Math.trunc(base.pyRound(raw / 10.0) * 10)), cabin: "Economy",
        promo: promo.has(i),
      });
    });
  }
  return out;
}

/** SkyBook 的北京酒店：≤300 的一共 15 家（正好跨两页，每页 8 家）。 */
export function buildHotels(n = 36, _seed = "skybook-beijing"): Hotel[] {
  const out: Hotel[] = [];
  let budgetSlots = 0;
  for (let i = 0; i < n; i++) {
    const name = `${HOTEL_BRANDS[i % HOTEL_BRANDS.length]!} Hotel Beijing ${HOTEL_AREAS[i % HOTEL_AREAS.length]!}`;
    let price: number;
    let star: number;
    if (i % 2 === 0 && budgetSlots < 15) {
      price = 135 + ((i * 19) % 165);          // 135..295
      star = 2 + (i % 3);
      budgetSlots += 1;
    } else {
      price = 320 + ((i * 71) % 700);
      star = price < 620 ? 4 : 5;
    }
    out.push({
      id: 700000 + i * 91, name, star,
      score: base.pyRound1(4.0 + ((i * 5) % 10) / 10.0),
      reviews: 120 + ((i * 431) % 7800), area: HOTEL_AREAS[i % HOTEL_AREAS.length]!,
      room: ["Double", "Twin", "Deluxe King", "Family", "Studio"][i % 5]!,
      price: Math.trunc(base.pyRound(price / 5.0) * 5),
      tags: [...(i % 3 ? ["Free cancellation"] : []), ...(i % 4 === 0 ? ["Breakfast"] : [])],
    });
  }
  if (budgetSlots !== 15) throw new Error(`budget_slots == 15 expected, got ${budgetSlots}`);
  out.sort((a, b) => (b.score - a.score) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** 只在 score 字段上出现：整数型浮点的 Python repr 是 `4.0`，JS 是 `4`。 */
const PY_FLOAT = "@@pyfloat@@";

/** Python `json.dumps(payload, ensure_ascii=False, indent=1)` 的等价物（见文件头偏差说明）。 */
function pyJsonIndent1(payload: unknown): string {
  return JSON.stringify(payload, (key, value) =>
    (key === "score" && typeof value === "number" && Number.isInteger(value)
      ? PY_FLOAT + value.toFixed(1) : value), 1)
    .replace(new RegExp(`"${PY_FLOAT}(-?\\d+\\.\\d+)"`, "g"), "$1");
}

export function dumpJs(dates?: readonly string[] | null): string {
  const ds = dates && dates.length ? dates : nextWeekDates();
  const payload = {
    window: { lo: WINDOW[0], hi: WINDOW[1] },
    perPage: 8,
    route: { from: "Kunming", fromCode: "KMG", to: "Beijing", toCode: "BJS" },
    dates: ds.map((d) => ({ date: d, wd: weekdayCn(d) })),
    flights: buildFlights(ds), hotels: buildHotels(),
  };
  return "// generated by transfer/data2.py --write: python3 transfer/data2.py --write\n"
    + "window.SKYBOOK = " + pyJsonIndent1(payload) + ";\n";
}

export function writeJs(dates?: readonly string[] | null): string {
  fs.mkdirSync(SITE, { recursive: true });
  fs.writeFileSync(DATA_JS, dumpJs(dates), "utf-8");
  return DATA_JS;
}

/* ------------------------------------------------ 判分口径（薄包装，语义不变） */

export function lowestFlight(
  flights: readonly Flight[], date: string, lo: string = WINDOW[0], hi: string = WINDOW[1],
): Flight | null {
  return base.lowestFlight(flights as unknown as readonly base.Flight[], date, lo, hi) as unknown as Flight | null;
}

export function lowestAnyTime(flights: readonly Flight[], date: string): Flight | null {
  return base.lowestAnyTime(flights as unknown as readonly base.Flight[], date) as unknown as Flight | null;
}

export function bestOverall(
  flights: readonly Flight[], dates: readonly string[],
  lo: string = WINDOW[0], hi: string = WINDOW[1],
): [string, Flight] | null {
  return base.bestOverall(flights as unknown as readonly base.Flight[], dates, lo, hi) as unknown as [string, Flight] | null;
}

export function hotelsUnder(hotels: readonly Hotel[], cap = 300): Hotel[] {
  return base.hotelsUnder(hotels, cap);
}

/* ------------------------------------------------------------------ main */

export interface ExpectedAnswer {
  dates: string[];
  departure_date: string;
  flight: Flight;
  per_date: Record<string, Flight | null>;
  hotels: Hotel[];
}

/** 这条路线在 SkyBook 上的正确答案（判分用，不进页面）。 */
export function expectedAnswer(dates?: readonly string[] | null): ExpectedAnswer {
  const ds = dates && dates.length ? dates : nextWeekDates();
  const flights = buildFlights(ds);
  const hotels = buildHotels();
  const best = bestOverall(flights, ds)!;
  const perDate: Record<string, Flight | null> = {};
  for (const d of ds) perDate[d] = lowestFlight(flights, d);
  return {
    dates: [...ds], departure_date: best[0], flight: best[1],
    per_date: perDate, hotels: hotelsUnder(hotels, 300),
  };
}

function todayIsoLocal(): string {
  const d = new Date();
  const p = (x: number): string => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function main(argv?: readonly string[]): number {
  const args = argv === undefined ? process.argv.slice(2) : [...argv];
  const dates = nextWeekDates();
  const ans = expectedAnswer(dates);
  console.log(`SkyBook（复刻站 #2）  今天 ${todayIsoLocal()} -> 下周 ${dates[0]} ~ ${dates[dates.length - 1]}`);
  for (const d of dates) {
    const f = ans.per_date[d]!;
    console.log(`  ${d} ${weekdayCn(d)}  08:00-18:00 最低 ${f.no.padStart(6)} ${f.dep} ¥${f.price}`);
  }
  const b = ans.flight;
  console.log(`结论：${ans.departure_date} ${b.no} ${b.airline} ${b.dep}-${b.arr} ¥${b.price}`);
  console.log(`${ans.departure_date} 入住 ≤300 的酒店 ${ans.hotels.length} 家`
    + `（¥${ans.hotels[0]!.price} - ¥${ans.hotels[ans.hotels.length - 1]!.price}）`);
  if (args.includes("--write")) console.log("wrote", writeJs(dates));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
