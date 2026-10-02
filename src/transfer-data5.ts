/**
 * 复刻站 #5（Voyagio）的数据与判分口径 —— `transfer/data5.py` 的 TS 孪生。
 *
 * 这个站点的意义在**骨架形状**：它的机票搜索是两页向导（第 1 页填日期 → 第 2 页选时段
 * 并搜索），所以在 spec 里 per_date 上开了**两个阶段**。旧的"入口 / 逐日期三元组 /
 * 酒店 / 收集"固定骨架表达不了它 —— 阶段列表本身变成了配置，加载器不知道"向导"。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as base from "./ctrip-data.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

export const SITE = path.join(REPO, "transfer", "site5");
export const DATA_JS = path.join(SITE, "data5.js");

export const WINDOW = base.WINDOW;
export const nextWeekDates = base.nextWeekDates;
export const weekdayCn = base.weekdayCn;
export const inWindow = base.inWindow;
export { pyRound, pyRound1, addMinutes } from "./ctrip-data.ts";

export const CARRIERS: ReadonlyArray<readonly [string, string]> = [
  ["VG", "Voyagio Air"], ["HJ", "Horizon Jet"], ["MC", "Meridian Coach"],
  ["OP", "Opal Wings"], ["TR", "Terra Flights"],
];
export const SCHEDULE: ReadonlyArray<readonly [string, string, string, number]> = [
  ["06:30", "3h15m", "A319", 490],
  ["07:45", "3h25m", "B737-800", 540],
  ["08:15", "3h10m", "A320", 655],
  ["09:50", "3h30m", "B787-8", 740],
  ["11:10", "3h15m", "A321", 805],
  ["12:45", "3h20m", "A320neo", 860],
  ["14:05", "3h10m", "B737 MAX", 915],
  ["15:35", "3h25m", "A330-300", 885],
  ["16:40", "3h15m", "B787-9", 840],
  ["17:35", "3h30m", "A321neo", 715],
  ["17:50", "3h20m", "A320", 700],
  ["18:25", "3h10m", "B737-800", 580],
  ["20:30", "3h25m", "A319", 525],
  ["21:55", "3h15m", "A320", 455],
];
export const HOTEL_AREAS: readonly string[] = [
  "Houhai", "Sanlitun SOHO", "Jianguomen", "Chaoyang Park", "Beixinqiao",
  "Liufang", "Fengtai", "Shijingshan", "Songjiazhuang", "Wangjing",
];
export const HOTEL_BRANDS: readonly string[] = [
  "Anchor", "Beacon", "Clove", "Drift", "Elm", "Fjord",
  "Grove", "Harbor", "Ink", "Jetty",
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
    const rng = new base.PyRandom(`voyagio|KMG-BJS|${date}`);
    const factor = [1.12, 0.86, 1.02, 1.08, 1.00][dayI % 5]!;
    const inWin: number[] = [];
    const outWin: number[] = [];
    SCHEDULE.forEach(([dep], i) => (inWindow(dep) ? inWin : outWin).push(i));
    const promo = new Map<number, number>();
    promo.set(rng.choice(inWin), 0.75);
    promo.set(rng.choice(outWin), 0.73);
    SCHEDULE.forEach(([dep, dur, plane, basePrice], i) => {
      const [code, name] = CARRIERS[(i + 4 * dayI) % CARRIERS.length]!;
      const raw = basePrice * factor * (promo.get(i) ?? 1.0) + rng.randrange(-6, 7) * 10;
      out.push({
        date, no: `${code}${500 + ((i * 31 + dayI * 19) % 499)}`,
        airline: name, carrier: code, from: "KMG", to: "BJS",
        dep, arr: base.addMinutes(dep, dur), dur, plane,
        price: Math.max(280, Math.trunc(base.pyRound(raw / 10.0) * 10)), cabin: "Economy",
        promo: promo.has(i),
      });
    });
  }
  return out;
}

/** ≤300 的一共 13 家。 */
export function buildHotels(n = 40, _seed = "voyagio-beijing"): Hotel[] {
  const out: Hotel[] = [];
  let budget = 0;
  for (let i = 0; i < n; i++) {
    const name = `${HOTEL_BRANDS[i % HOTEL_BRANDS.length]!} Hotel Beijing ${HOTEL_AREAS[i % HOTEL_AREAS.length]!}`;
    let price: number;
    let star: number;
    if (i % 3 === 1 && budget < 13) {
      price = 150 + ((i * 11) % 145);
      star = 3 + (i % 2);
      budget += 1;
    } else {
      price = 330 + ((i * 73) % 620);
      star = price < 640 ? 4 : 5;
    }
    out.push({
      id: 800000 + i * 47, name, star,
      score: base.pyRound1(4.0 + ((i * 13) % 10) / 10.0),
      reviews: 130 + ((i * 277) % 5100), area: HOTEL_AREAS[i % HOTEL_AREAS.length]!,
      room: ["Queen", "Twin", "King", "Studio", "Suite"][i % 5]!,
      price: Math.trunc(base.pyRound(price / 5.0) * 5),
      tags: [...(i % 3 ? ["Free cancellation"] : []), ...(i % 5 === 0 ? ["Breakfast"] : [])],
    });
  }
  if (budget !== 13) throw new Error(`budget == 13 expected, got ${budget}`);
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
  return "// generated by transfer/data5.py --write: python3 transfer/data5.py --write\n"
    + "window.VOYAGIO = " + pyJsonIndent1(payload) + ";\n";
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
  console.log(`Voyagio（复刻站 #5）  今天 ${todayIsoLocal()} -> 下周 ${dates[0]} ~ ${dates[dates.length - 1]}`);
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
