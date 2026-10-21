/**
 * 复刻站 #3（Trekly）的数据与判分口径 —— `transfer/data3.py` 的 TS 孪生。
 *
 * 这是"**新增一个同类站点 = 一个 spec + 一个数据生成器**"里的那个"数据生成器"：
 * 站点自己的航司/时刻/酒店清单，判分口径仍然复用 `ctrip-data.ts` 里与数据集无关的
 * 那几个函数。布局又是第三种：结果是**表格**、价格上限是**滑块**（`<input type=range>`）、
 * 记录是"一次记录当前全部行"、没有分页。
 *
 * 生成顺序与随机数调用顺序与 Python 逐行对齐（先 `choice(inWin)` 再 `choice(outWin)`），
 * 这样 `dumpJs()` 才能与提交的 `transfer/site3/data3.js` 逐字节相等。
 */
import * as fs from "node:fs";
import { REPO } from "../support/paths.ts";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as base from "./ctrip-data.ts";


export const SITE = path.join(REPO, "transfer", "site3");
export const DATA_JS = path.join(SITE, "data3.js");

export const WINDOW = base.WINDOW;
export const nextWeekDates = base.nextWeekDates;
export const weekdayCn = base.weekdayCn;
export const inWindow = base.inWindow;
export { pyRound, pyRound1, addMinutes } from "./ctrip-data.ts";

export const CARRIERS: ReadonlyArray<readonly [string, string]> = [
  ["TN", "Trekly Air"], ["VM", "Vermillion"], ["OS", "Orbit Sky"],
  ["HL", "Highland Air"], ["ZP", "Zephyr Jet"],
];
export const SCHEDULE: ReadonlyArray<readonly [string, string, string, number]> = [
  ["06:45", "3h25m", "A319", 495],
  ["07:35", "3h10m", "B737-700", 545],
  ["08:10", "3h30m", "A320", 660],
  ["09:25", "3h15m", "B737-800", 735],
  ["10:40", "3h20m", "A321", 800],
  ["12:05", "3h05m", "A320neo", 855],
  ["13:30", "3h25m", "B787-8", 920],
  ["14:55", "3h15m", "A330-200", 880],
  ["16:05", "3h30m", "B737-800", 830],
  ["17:15", "3h10m", "A320", 720],
  ["17:45", "3h20m", "A321neo", 690],
  ["18:35", "3h15m", "A319", 585],
  ["19:50", "3h25m", "B787-8", 530],
  ["21:30", "3h05m", "A320", 465],
];
export const HOTEL_AREAS: readonly string[] = [
  "Jinrongjie", "Dongzhimen", "Gongti", "Shuangjing", "Liufang",
  "Haidian", "Chaoyangmen", "Madian", "Sanyuanqiao", "Tuanjiehu",
];
export const HOTEL_BRANDS: readonly string[] = [
  "Aster", "Cedar", "Marble", "Quartz", "Lumen", "Rowan",
  "Sable", "Topaz", "Umber", "Vista",
];

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
    const rng = new base.PyRandom(`trekly|KMG-BJS|${date}`);
    const factor = [1.06, 1.18, 1.12, 0.96, 0.82][dayI % 5]!;
    const inWin: number[] = [];
    const outWin: number[] = [];
    SCHEDULE.forEach(([dep], i) => (inWindow(dep) ? inWin : outWin).push(i));
    const promo = new Map<number, number>();
    promo.set(rng.choice(inWin), 0.76);
    promo.set(rng.choice(outWin), 0.71);
    SCHEDULE.forEach(([dep, dur, plane, basePrice], i) => {
      const [code, name] = CARRIERS[(i + dayI) % CARRIERS.length]!;
      const raw = basePrice * factor * (promo.get(i) ?? 1.0) + rng.randrange(-6, 7) * 10;
      out.push({
        date, no: `${code}${300 + ((i * 41 + dayI * 23) % 699)}`,
        airline: name, carrier: code, from: "KMG", to: "BJS",
        dep, arr: base.addMinutes(dep, dur), dur, plane,
        price: Math.max(290, Math.trunc(base.pyRound(raw / 10.0) * 10)), cabin: "Economy",
        promo: promo.has(i),
      });
    });
  }
  return out;
}

/** ≤300 的一共 12 家（单页展示，不做分页）。 */
export function buildHotels(n = 32, _seed = "trekly-beijing"): Hotel[] {
  const out: Hotel[] = [];
  let budget = 0;
  for (let i = 0; i < n; i++) {
    const name = `${HOTEL_BRANDS[i % HOTEL_BRANDS.length]!} Hotel Beijing ${HOTEL_AREAS[i % HOTEL_AREAS.length]!}`;
    let price: number;
    let star: number;
    if (i % 2 === 1 && budget < 12) {
      price = 145 + ((i * 17) % 150);
      star = 2 + (i % 3);
      budget += 1;
    } else {
      price = 330 + ((i * 61) % 640);
      star = price < 600 ? 4 : 5;
    }
    out.push({
      id: 500000 + i * 73, name, star,
      score: base.pyRound1(4.1 + ((i * 3) % 9) / 10.0),
      reviews: 90 + ((i * 517) % 6200), area: HOTEL_AREAS[i % HOTEL_AREAS.length]!,
      room: ["Queen", "Twin", "King", "Loft", "Suite"][i % 5]!,
      price: Math.trunc(base.pyRound(price / 5.0) * 5),
      tags: [...(i % 4 ? ["Free cancellation"] : []), ...(i % 5 === 0 ? ["Breakfast"] : [])],
    });
  }
  if (budget !== 12) throw new Error(`budget == 12 expected, got ${budget}`);
  out.sort((a, b) => (b.score - a.score) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** 只在 score 字段上出现：整数型浮点的 Python repr 是 `4.0`，JS 是 `4`。 */
const PY_FLOAT = "@@pyfloat@@";

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
    route: { from: "Kunming", fromCode: "KMG", to: "Beijing", toCode: "BJS" },
    dates: ds.map((d) => ({ date: d, wd: weekdayCn(d) })),
    flights: buildFlights(ds), hotels: buildHotels(),
  };
  return "// generated by transfer/data3.py --write: python3 transfer/data3.py --write\n"
    + "window.TREKLY = " + pyJsonIndent1(payload) + ";\n";
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

function todayIsoLocal(): string {
  const d = new Date();
  const p = (x: number): string => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function main(argv?: readonly string[]): number {
  const args = argv === undefined ? process.argv.slice(2) : [...argv];
  const dates = nextWeekDates();
  const flights = buildFlights(dates);
  const hotels = buildHotels();
  console.log(`Trekly（复刻站 #3）  今天 ${todayIsoLocal()} -> 下周 ${dates[0]} ~ ${dates[dates.length - 1]}`);
  for (const d of dates) {
    const f = lowestFlight(flights, d)!;
    const a = lowestAnyTime(flights, d)!;
    console.log(`  ${d} ${weekdayCn(d)}  区间内最低 ${f.no.padStart(6)} ${f.dep} ¥${String(f.price).padEnd(5)}`
      + `| 全天最低 ${a.no.padStart(6)} ${a.dep} ¥${a.price}`);
  }
  const [d, f] = bestOverall(flights, dates)!;
  console.log(`结论：${d} ${f.no} ${f.airline} ${f.dep}-${f.arr} ¥${f.price}`);
  const hs = hotelsUnder(hotels, 300);
  console.log(`${d} 入住 ≤300 的酒店 ${hs.length} 家（¥${hs[0]!.price} - ¥${hs[hs.length - 1]!.price}）`);
  if (args.includes("--write")) console.log("wrote", writeJs(dates));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
