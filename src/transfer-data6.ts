/**
 * 复刻站 #6（FareHaven）的数据与判分口径 —— `transfer/data6.py` 的 TS 孪生。
 *
 * 这个站点要证的是**条件子目标**（`when`）：它在部分日期上弹一个"国庆促销"遮罩层，
 * 遮罩盖住整页、不关掉就点不动列表；而其它日期根本没有这个遮罩。于是计划里那一步
 * 必须在"有遮罩"时真的执行、在"没遮罩"时被**跳过**——两个方向都要对。
 *
 * 判分口径照旧复用 `ctrip-data.ts` 里与数据集无关的那几个函数。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as base from "./ctrip-data.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

export const SITE = path.join(REPO, "transfer", "site6");
export const DATA_JS = path.join(SITE, "data6.js");

export const WINDOW = base.WINDOW;
export const nextWeekDates = base.nextWeekDates;
export const weekdayCn = base.weekdayCn;
export const inWindow = base.inWindow;
export { pyRound, pyRound1, addMinutes } from "./ctrip-data.ts";

export const CARRIERS: ReadonlyArray<readonly [string, string]> = [
  ["FH", "FareHaven Air"], ["NB2", "NorthBay Express"], ["SK", "Skyline"],
  ["MT", "Meridian Transit"], ["OR", "Orchid Wings"],
];
export const SCHEDULE: ReadonlyArray<readonly [string, string, string, number]> = [
  ["06:50", "3h20m", "A320", 500],
  ["07:55", "3h10m", "B737-800", 555],
  ["08:25", "3h25m", "A321", 670],
  ["09:45", "3h15m", "A320neo", 750],
  ["11:20", "3h30m", "B787-8", 810],
  ["12:55", "3h10m", "A330-200", 865],
  ["14:15", "3h20m", "B737 MAX", 925],
  ["15:45", "3h15m", "A321neo", 895],
  ["16:35", "3h30m", "A330-300", 850],
  ["17:20", "3h05m", "A320", 730],
  ["17:55", "3h20m", "B787-9", 690],
  ["18:30", "3h15m", "B737-800", 600],
  ["20:45", "3h25m", "A319", 535],
  ["22:20", "3h10m", "A320neo", 470],
];
export const HOTEL_AREAS: readonly string[] = [
  "Gulou", "Dongsi", "Baiziwan", "Xidan", "Caishikou", "Liuliqiao",
  "Zhongguancun", "Yonghegong", "Temple of Heaven", "Liangmaqiao",
];
export const HOTEL_BRANDS: readonly string[] = [
  "Alcove", "Birch", "Copper Beech", "Dune", "Elder", "Flint",
  "Ginkgo", "Hearth", "Iris", "Jade Walk",
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

/** 只有前三天下"国庆促销"遮罩 —— 后两天没有，条件步必须被跳过。 */
export function promoDates(dates?: readonly string[] | null): string[] {
  const ds = dates && dates.length ? dates : nextWeekDates();
  return ds.slice(0, 3);
}

export function buildFlights(dates?: readonly string[] | null): Flight[] {
  const ds = dates && dates.length ? dates : nextWeekDates();
  const out: Flight[] = [];
  for (let dayI = 0; dayI < ds.length; dayI++) {
    const date = ds[dayI]!;
    const rng = new base.PyRandom(`farehaven|KMG-BJS|${date}`);
    const factor = [1.15, 1.08, 1.03, 0.97, 0.93][dayI % 5]!;
    const inWin: number[] = [];
    const outWin: number[] = [];
    SCHEDULE.forEach(([dep], i) => (inWindow(dep) ? inWin : outWin).push(i));
    const promo = new Map<number, number>();
    promo.set(rng.choice(inWin), 0.74);
    promo.set(rng.choice(outWin), 0.72);
    SCHEDULE.forEach(([dep, dur, plane, basePrice], i) => {
      const [code, name] = CARRIERS[(i + 2 * dayI) % CARRIERS.length]!;
      const raw = basePrice * factor * (promo.get(i) ?? 1.0) + rng.randrange(-6, 7) * 10;
      out.push({
        date, no: `${code}${600 + ((i * 23 + dayI * 29) % 349)}`,
        airline: name, carrier: code, from: "KMG", to: "BJS",
        dep, arr: base.addMinutes(dep, dur), dur, plane,
        price: Math.max(285, Math.trunc(base.pyRound(raw / 10.0) * 10)), cabin: "Economy",
        promo: promo.has(i),
      });
    });
  }
  return out;
}

/** ≤300 的一共 11 家。 */
export function buildHotels(n = 38, _seed = "farehaven-beijing"): Hotel[] {
  const out: Hotel[] = [];
  let budget = 0;
  for (let i = 0; i < n; i++) {
    const name = `${HOTEL_BRANDS[i % HOTEL_BRANDS.length]!} Hotel Beijing ${HOTEL_AREAS[i % HOTEL_AREAS.length]!}`;
    let price: number;
    let star: number;
    if (i % 3 === 2 && budget < 11) {
      price = 155 + ((i * 17) % 140);
      star = 2 + (i % 3);
      budget += 1;
    } else {
      price = 350 + ((i * 79) % 580);
      star = price < 620 ? 4 : 5;
    }
    out.push({
      id: 100000 + i * 37, name, star,
      score: base.pyRound1(4.1 + ((i * 9) % 9) / 10.0),
      reviews: 150 + ((i * 331) % 4600), area: HOTEL_AREAS[i % HOTEL_AREAS.length]!,
      room: ["Queen", "Twin", "King", "Studio", "Suite"][i % 5]!,
      price: Math.trunc(base.pyRound(price / 5.0) * 5),
      tags: [...(i % 3 ? ["Free cancellation"] : []), ...(i % 4 === 0 ? ["Breakfast"] : [])],
    });
  }
  if (budget !== 11) throw new Error(`budget == 11 expected, got ${budget}`);
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
    promoDates: promoDates(ds),
    route: { from: "Kunming", fromCode: "KMG", to: "Beijing", toCode: "BJS" },
    dates: ds.map((d) => ({ date: d, wd: weekdayCn(d) })),
    flights: buildFlights(ds), hotels: buildHotels(),
  };
  return "// generated by transfer/data6.py --write: python3 transfer/data6.py --write\n"
    + "window.FAREHAVEN = " + pyJsonIndent1(payload) + ";\n";
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
  console.log(`FareHaven（复刻站 #6）  今天 ${todayIsoLocal()} -> 下周 ${dates[0]} ~ ${dates[dates.length - 1]}`
    + `；促销遮罩日期 ${promoDates(dates)}`);
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
