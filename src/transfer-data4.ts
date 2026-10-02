/**
 * 复刻站 #4（FlyQuest）的数据与判分口径 —— `transfer/data4.py` 的 TS 孪生。
 *
 * 这个站点的意义不在数据，而在**交互形状**：它的搜索是一个真正的 `<form>`
 * （填日期 → 选出发时段 → 点 Search），结果页只能通过提交表单到达。
 * "一个子目标一个 hint"表达不了它，所以 spec 用有序 hint 序列（`target_hints`）
 * 与子目标级数据袋（`slots`）——这个 spec 就是第一个用户。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as base from "./ctrip-data.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

export const SITE = path.join(REPO, "transfer", "site4");
export const DATA_JS = path.join(SITE, "data4.js");

export const WINDOW = base.WINDOW;
export const nextWeekDates = base.nextWeekDates;
export const weekdayCn = base.weekdayCn;
export const inWindow = base.inWindow;
export { pyRound, pyRound1, addMinutes } from "./ctrip-data.ts";

export const CARRIERS: ReadonlyArray<readonly [string, string]> = [
  ["FQ", "FlyQuest Air"], ["NB", "NorthBay"], ["CT", "CloudTrail"],
  ["SV", "Silverwing"], ["GP", "GoldPeak"],
];
export const SCHEDULE: ReadonlyArray<readonly [string, string, string, number]> = [
  ["06:05", "3h20m", "A320", 480],
  ["07:20", "3h15m", "B737-800", 530],
  ["08:05", "3h25m", "A321", 645],
  ["09:30", "3h10m", "B787-8", 725],
  ["10:55", "3h30m", "A330-300", 790],
  ["12:15", "3h15m", "A320neo", 845],
  ["13:40", "3h20m", "B737-800", 905],
  ["15:00", "3h10m", "A321neo", 870],
  ["16:20", "3h25m", "B787-9", 815],
  ["17:25", "3h15m", "A320", 705],
  ["17:55", "3h30m", "A330-200", 675],
  ["18:40", "3h10m", "B737 MAX", 570],
  ["20:15", "3h20m", "A321", 515],
  ["22:05", "3h15m", "A320neo", 450],
];
export const HOTEL_AREAS: readonly string[] = [
  "Qianmen", "Gulou", "Hepingli", "Tuanjiehu", "Shuangjing",
  "Wukesong", "Fengtai", "Xizhimen", "Anzhen", "Panjiayuan",
];
export const HOTEL_BRANDS: readonly string[] = [
  "Aria", "Bramble", "Copper", "Dune", "Ember", "Fern",
  "Gable", "Haven", "Ivory", "Juniper",
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
    const rng = new base.PyRandom(`flyquest|KMG-BJS|${date}`);
    const factor = [0.92, 1.14, 1.06, 1.00, 0.97][dayI % 5]!;
    const inWin: number[] = [];
    const outWin: number[] = [];
    SCHEDULE.forEach(([dep], i) => (inWindow(dep) ? inWin : outWin).push(i));
    const promo = new Map<number, number>();
    promo.set(rng.choice(inWin), 0.73);
    promo.set(rng.choice(outWin), 0.74);
    SCHEDULE.forEach(([dep, dur, plane, basePrice], i) => {
      const [code, name] = CARRIERS[(i + 3 * dayI) % CARRIERS.length]!;
      const raw = basePrice * factor * (promo.get(i) ?? 1.0) + rng.randrange(-5, 6) * 10;
      out.push({
        date, no: `${code}${400 + ((i * 29 + dayI * 31) % 599)}`,
        airline: name, carrier: code, from: "KMG", to: "BJS",
        dep, arr: base.addMinutes(dep, dur), dur, plane,
        price: Math.max(275, Math.trunc(base.pyRound(raw / 10.0) * 10)), cabin: "Economy",
        promo: promo.has(i),
      });
    });
  }
  return out;
}

/** ≤300 的一共 14 家。 */
export function buildHotels(n = 30, _seed = "flyquest-beijing"): Hotel[] {
  const out: Hotel[] = [];
  let budget = 0;
  for (let i = 0; i < n; i++) {
    const name = `${HOTEL_BRANDS[i % HOTEL_BRANDS.length]!} Hotel Beijing ${HOTEL_AREAS[i % HOTEL_AREAS.length]!}`;
    let price: number;
    let star: number;
    if (i % 2 === 0 && budget < 14) {
      price = 140 + ((i * 13) % 155);
      star = 2 + (i % 3);
      budget += 1;
    } else {
      price = 340 + ((i * 67) % 600);
      star = price < 620 ? 4 : 5;
    }
    out.push({
      id: 600000 + i * 59, name, star,
      score: base.pyRound1(4.0 + ((i * 11) % 10) / 10.0),
      reviews: 110 + ((i * 389) % 5400), area: HOTEL_AREAS[i % HOTEL_AREAS.length]!,
      room: ["Queen", "Twin XL", "King", "Family", "Studio"][i % 5]!,
      price: Math.trunc(base.pyRound(price / 5.0) * 5),
      tags: [...(i % 3 ? ["Free cancellation"] : []), ...(i % 6 === 0 ? ["Breakfast"] : [])],
    });
  }
  if (budget !== 14) throw new Error(`budget == 14 expected, got ${budget}`);
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
  return "// generated by transfer/data4.py --write: python3 transfer/data4.py --write\n"
    + "window.FLYQUEST = " + pyJsonIndent1(payload) + ";\n";
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
  console.log(`FlyQuest（复刻站 #4）  今天 ${todayIsoLocal()} -> 下周 ${dates[0]} ~ ${dates[dates.length - 1]}`);
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
