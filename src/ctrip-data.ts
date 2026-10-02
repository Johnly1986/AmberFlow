/**
 * 携程用例的数据层 —— `ctrip/data.py` 的 TS 孪生：航班/酒店清单 + 独立判分口径（oracle）。
 *
 * 为什么有这个文件（照抄 Python 的动机说明）：
 *   用例要在携程网上「搜出 08:00-18:00 最低价机票」和「300 元以内的酒店」。线上站点
 *   对本环境是硬封锁的（WhaleGuard 432 + 酒店价格需登录），所以用一份**本地复刻站**
 *   （`ctrip/site/`）承载同一个用例：DOM 结构、交互路径、URL 形态照携程列表页写，
 *   只有数据是本地生成的。
 *
 *   数据必须与判分口径解耦：
 *     * `buildFlights()/buildHotels()` —— 生成站点展示用的数据（确定性，被 `dumpJs()`
 *       写成 `site/ctrip_data.js`，提交进仓库供复刻站离线加载）；
 *     * `lowestFlight()/bestOverall()/hotelsUnder()` —— **判分口径**，只从这里读数据，
 *       不碰浏览器页面。执行器在页面上点出来的记录要跟这里的期望值对上，才算用例通过。
 *
 * ## 逐字节复刻 Python 的随机数（这是本文件最重要的约束）
 *
 * `ctrip/site/ctrip_data.js` 是 Python 生成的并已提交；Python 测试
 * `test_build_is_deterministic_and_matches_committed_site_data` 断言重新生成的结果与
 * 提交文件逐字节一致。所以这里必须精确复刻 CPython 的随机数：
 *
 *   1. MT19937（`init_genrand` / `init_by_array` / `genrand_uint32`），32 位无符号语义
 *      用 `>>> 0` + `Math.imul` 逐位对齐（`Math.imul` 给的是低 32 位，正是 C 的
 *      `uint32_t` 乘法）；
 *   2. `random.Random(seed_str)` 的 **version=2 种子路径**：
 *        `a = s.encode() + sha512(s.encode()).digest()` -> `int.from_bytes(a, "big")`
 *      -> C 层 `init_by_array`：把该整数按**小端 32 位字**拆成 `ceil(bitlen/32)` 个字；
 *   3. `getrandbits(k)` 的 C 实现（k<=32 取一个 `genrand_uint32` 的**高 k 位**；k>32 时
 *      小端拼字、末字右移 (32-k)），以及 `_randbelow` 的拒绝采样（`k = n.bit_length()`，
 *      `r >= n` 就重抽）；
 *   4. `randrange` / `choice` 的调用**顺序**（`buildFlights` 里先 `choice(inWin)` 再
 *      `choice(outWin)`，然后每个时刻一次 `_jitter`）——顺序错了整份数据就错。
 *
 * ## 与 Python 的有意偏差
 *
 *   * `round()`：Python 是「就近取整、.5 取偶」（对 double 的精确值），JS 的
 *     `Math.round` 是「.5 向上」。这里用 `pyRound()` 复刻前者，`pyRound1()` 复刻
 *     `round(x, 1)`。本数据集的取值（价格、评分）都不是 .5 平局，验证见
 *     `tools/ctrip-parity.ts` 的逐字节对拍。
 *   * JSON 序列化：Python `json.dumps(..., ensure_ascii=False, indent=1)` 与
 *     `JSON.stringify(payload, null, 1)` 在本数据集的取值域上输出一致（键序 = 插入序，
 *     非 ASCII 原样输出，浮点都是 `float.__repr__` 意义下的最短往返表示）。空容器两边
 *     都是 `[]` / `{}`。所有整数都在安全整数范围内。
 *   * `buildHotels(n, seed)` 的 `seed` 参数在 Python 里**未被使用**（纯算术生成），
 *     这里保留同名参数以对齐签名，同样不使用。
 *   * `writeJs()` / `main()` 的默认结果目录按 TS 侧习惯从本文件位置反推仓库根，语义相同。
 */
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { nextWeekDates } from "./datasource.ts";

/** Python `data.py` 从引擎侧 re-export `next_week_dates`（日期语义只有一个实现）。 */
export { nextWeekDates };

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根：Python 版 `HERE = pathlib.Path(__file__).parent` 是 `ctrip/`。 */
const REPO = path.resolve(HERE, "..");
export const SITE = path.join(REPO, "ctrip", "site");
export const DATA_JS = path.join(SITE, "ctrip_data.js");

export const WINDOW: readonly [string, string] = ["08:00", "18:00"];   // 出发时段，闭区间
export const FROM_CITY = "昆明";
export const FROM_CODE = "KMG";
export const TO_CITY = "北京";
export const TO_CODE = "BJS";
export const CITY_ID: Readonly<Record<string, number>> = { 北京: 1 };

/** 2026 国庆假期尾巴（10/1-10/7）票价高，10/8 起回落：让「周一至周五随便哪天」
 *  真的变成一个需要比较的决策，而不是五天同价。 */
export const HOLIDAY_DAYS: ReadonlySet<string> = new Set(["2026-10-05", "2026-10-06", "2026-10-07"]);

export const AIRLINES: ReadonlyArray<readonly [string, string]> = [
  ["CA", "中国国航"], ["MU", "东方航空"], ["CZ", "南方航空"], ["HU", "海南航空"],
  ["3U", "四川航空"], ["KY", "昆明航空"], ["HO", "吉祥航空"], ["9C", "春秋航空"],
];

/** (出发, 到达?, 机型, 舱位基准价元) —— 到达时间按 KMG->BJS 约 3h10m-3h35m 推算。 */
export const SCHEDULE: ReadonlyArray<readonly [string, string, string, number]> = [
  ["06:20", "3h25m", "空客A320", 520],
  ["07:05", "3h15m", "波音737-800", 560],
  ["07:40", "3h20m", "空客A321", 610],
  ["08:20", "3h10m", "波音787-9", 780],
  ["09:15", "3h30m", "空客A330", 860],
  ["10:30", "3h15m", "波音737-800", 940],
  ["11:45", "3h20m", "空客A320", 1010],
  ["13:10", "3h25m", "波音787-9", 1080],
  ["14:25", "3h10m", "空客A321", 1020],
  ["15:40", "3h30m", "波音737-800", 980],
  ["16:55", "3h15m", "空客A320", 900],
  ["17:50", "3h20m", "波音787-9", 830],
  ["18:05", "3h25m", "空客A321", 640],
  ["19:30", "3h10m", "波音737-800", 590],
  ["21:50", "3h30m", "空客A320", 505],
];

export const WEEKDAY_CN: readonly string[] = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** 品牌名里不能带地名：否则会生成「北京王府井王府井酒店」这种假名字。 */
export const HOTEL_BRANDS: readonly string[] = [
  "如家", "汉庭", "全季", "桔子", "亚朵", "麗枫", "维也纳", "锦江之星",
  "希尔顿欢朋", "智选假日", "万豪", "索菲特", "凯宾斯基", "丽亭",
  "馨乐庭", "和颐", "格林豪泰", "城市便捷", "开元名都", "君亭",
  "喆啡", "尚客优", "派柏云", "康莱德", "诺富特", "华美达",
  "美居", "朗廷",
];
export const HOTEL_AREAS: readonly string[] = [
  "王府井", "国贸CBD", "三里屯", "西单", "中关村", "望京", "首都机场",
  "北京南站", "五道口", "亚运村", "亦庄", "丰台科技园", "天安门", "鸟巢",
];

export interface Flight {
  date: string;
  no: string;
  airline: string;
  from: string;
  to: string;
  dep: string;
  arr: string;
  dur: string;
  plane: string;
  price: number;
  tax: number;
  cabin: string;
  promo: boolean;
}

export interface Hotel {
  id: number;
  name: string;
  star: number;
  score: number;
  reviews: number;
  area: string;
  room: string;
  price: number;
  tags: string[];
}

/* ================================================================ 日期推断 */

/** 纯日历数学 + 中文星期。`nextWeekDates` 复用引擎侧实现（日期语义的唯一实现）。 */
export function weekdayCn(iso: string): string {
  return WEEKDAY_CN[pyWeekday(iso)]!;
}

export function shortCn(iso: string): string {
  const [, m, d] = iso.split("-").map((x) => Number(x));
  return `${m}月${d}日`;
}

/** Python `dt.date.fromisoformat(iso).weekday()`：周一 = 0，周日 = 6。 */
function pyWeekday(iso: string): number {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return (new Date(t).getUTCDay() + 6) % 7;
}

/* ================================================================ Python 取整 */

/** Python `round(x)`：就近取整、.5 取偶（对 double 的精确值），与 `Math.round` 不同。 */
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Python `round(x, 1)`。 */
export function pyRound1(x: number): number {
  return pyRound(x * 10) / 10;
}

/* ================================================================ MT19937 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;
const U32 = 0x100000000;

/**
 * `random.Random(seed_str)` 的 C 层种子整数：
 * `int.from_bytes(s.encode() + sha512(s.encode()).digest(), "big")`。
 */
export function pySeedIntFromString(s: string): bigint {
  const body = Buffer.from(s, "utf-8");
  const digest = crypto.createHash("sha512").update(body).digest();
  const combined = Buffer.concat([body, digest]);
  let a = 0n;
  for (const byte of combined) a = (a << 8n) | BigInt(byte);
  return a;
}

function bitLength(n: number): number {
  return Math.max(1, Math.trunc(n).toString(2).length);
}

/**
 * CPython `_random.Random`（MT19937）的最小复刻。
 *
 * 只实现本用例用到的接口：v2 字符串种子 / 整数种子、`getrandbits`、`randbelow`
 * （拒绝采样）、`randrange`、`choice`。所有内部运算保持 32 位无符号语义。
 */
export class PyRandom {
  private mt = new Uint32Array(N);
  private index = N;

  constructor(seed: string | number | bigint) {
    if (typeof seed === "string") this.seedFromBigInt(pySeedIntFromString(seed));
    else if (typeof seed === "bigint") this.seedFromBigInt(seed);
    else this.seedFromBigInt(BigInt(Math.trunc(seed)));
  }

  /** `init_genrand(19650218U)` + `init_by_array(key)`。 */
  private seedFromBigInt(raw: bigint): void {
    const v = raw < 0n ? -raw : raw;
    const bits = v === 0n ? 0 : v.toString(2).length;
    const keymax = Math.max(1, Math.floor((bits + 31) / 32));
    const key = new Uint32Array(keymax);
    for (let i = 0; i < keymax; i++) key[i] = Number((v >> BigInt(32 * i)) & 0xffffffffn);
    this.initByArray(key);
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      mt[i] = (Math.imul(1812433253, mt[i - 1]! ^ (mt[i - 1]! >>> 30)) + i) >>> 0;
    }
    this.index = N;
  }

  private initByArray(key: Uint32Array): void {
    this.initGenrand(19650218);
    const mt = this.mt;
    const keyLength = key.length;
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, keyLength); k; k--) {
      mt[i] = (((mt[i]! ^ Math.imul(mt[i - 1]! ^ (mt[i - 1]! >>> 30), 1664525)) >>> 0)
        + key[j]! + j) >>> 0;
      i += 1;
      j += 1;
      if (i >= N) { mt[0] = mt[N - 1]!; i = 1; }
      if (j >= keyLength) j = 0;
    }
    for (let k = N - 1; k; k--) {
      mt[i] = (((mt[i]! ^ Math.imul(mt[i - 1]! ^ (mt[i - 1]! >>> 30), 1566083941)) >>> 0)
        - i) >>> 0;
      i += 1;
      if (i >= N) { mt[0] = mt[N - 1]!; i = 1; }
    }
    mt[0] = 0x80000000;
  }

  /** `genrand_uint32()`：twist + temper。 */
  genrandUint32(): number {
    const mt = this.mt;
    let y = 0;
    if (this.index >= N) {
      let kk = 0;
      for (; kk < N - M; kk++) {
        y = (mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK);
        mt[kk] = (mt[kk + M]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      for (; kk < N - 1; kk++) {
        y = (mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK);
        mt[kk] = (mt[kk + (M - N)]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      y = (mt[N - 1]! & UPPER_MASK) | (mt[0]! & LOWER_MASK);
      mt[N - 1] = (mt[M - 1]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      this.index = 0;
    }
    y = mt[this.index]!;
    this.index += 1;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** `getrandbits(k)`：k<=32 取高 k 位；k>32 小端拼字、末字右移 (32-k)。 */
  getrandbits(k: number): number | bigint {
    if (k <= 32) return this.genrandUint32() >>> (32 - k);
    const words = Math.floor((k - 1) / 32) + 1;
    let res = 0n;
    let rem = k;
    for (let i = 0; i < words; i++, rem -= 32) {
      let r = this.genrandUint32();
      if (rem < 32) r = r >>> (32 - rem);
      res |= BigInt(r) << BigInt(32 * i);
    }
    return res;
  }

  /** `_randbelow(n)`：`k = n.bit_length()` 的拒绝采样。 */
  randbelow(n: number): number {
    if (!(n > 0)) throw new Error(`randbelow requires n > 0 (got ${n})`);
    const k = bitLength(n);
    let r = this.getrandbits(k);
    while (typeof r === "bigint" ? r >= BigInt(n) : r >= n) r = this.getrandbits(k);
    return Number(r);
  }

  randrange(lo: number, hi: number): number {
    return lo + this.randbelow(hi - lo);
  }

  choice<T>(seq: readonly T[]): T {
    if (!seq.length) throw new Error("choice from an empty sequence");
    return seq[this.randbelow(seq.length)]!;
  }
}

/* ================================================================ 生成 */

/** `'08:20' + '3h10m' -> '11:30'`（跨天按 24h 取模）。 */
export function addMinutes(hhmm: string, dur: string): string {
  const [h, m] = hhmm.split(":").map((x) => Number(x));
  const body = dur.endsWith("m") ? dur.slice(0, -1) : dur;
  const [dh, dm] = body.includes("h")
    ? body.split("h").map((x) => Number(x))
    : [0, Number(body || "0")];
  const total = h! * 60 + m! + dh! * 60 + dm!;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function jitter(rng: PyRandom, lo: number, hi: number): number {
  return rng.randrange(lo, hi + 1) * 10;
}

/**
 * 确定性航班清单：每个日期一组，覆盖 06:20-21:50，含区间外低价航班。
 *
 * 每天再随机挂 1 张区间内 + 1 张区间外的「特价票」：这样「区间内最低价」不总是最早
 * 那班，五天里最便宜的那天也要比出来。
 */
export function buildFlights(dates?: readonly string[] | null): Flight[] {
  const ds = dates && dates.length ? dates : nextWeekDates();
  const out: Flight[] = [];
  for (let dayI = 0; dayI < ds.length; dayI++) {
    const date = ds[dayI]!;
    const rng = new PyRandom(`KMG-BJS|${date}`);
    const factor = HOLIDAY_DAYS.has(date) ? 1.35 : 1.0 - 0.03 * dayI;
    const inWin: number[] = [];
    const outWin: number[] = [];
    SCHEDULE.forEach(([dep], i) => (inWindow(dep) ? inWin : outWin).push(i));
    // Python 的求值顺序：键1 -> 值1 -> 键2 -> 值2，所以两次 choice 依次是 inWin / outWin
    const promo = new Map<number, number>();
    promo.set(rng.choice(inWin), 0.72);
    promo.set(rng.choice(outWin), 0.70);
    SCHEDULE.forEach(([dep, dur, plane, base], i) => {
      const [code, name] = AIRLINES[(i + dayI) % AIRLINES.length]!;
      const raw = base * factor * (promo.get(i) ?? 1.0) + jitter(rng, -4, 4);
      const price = Math.max(300, Math.trunc(pyRound(raw / 10.0) * 10));
      out.push({
        date,
        no: `${code}${1000 + ((i * 37 + dayI * 11) % 8999)}`,
        airline: `${name}(${code})`,
        from: FROM_CODE, to: TO_CODE,
        dep, arr: addMinutes(dep, dur), dur, plane,
        price, tax: 50, cabin: "经济舱",
        promo: promo.has(i),
      });
    });
  }
  return out;
}

/**
 * 确定性北京酒店清单：三成是 128-298 的经济型（用例的 ≤300 命中区），其余 320-1180。
 * 整体按评分降序，和携程默认的「欢迎度排序」观感一致。
 *
 * Python 的 `seed` 参数从未被使用（纯算术）；这里保留同名参数以对齐签名。
 */
export function buildHotels(n = 44, _seed = "beijing-hotels"): Hotel[] {
  const out: Hotel[] = [];
  for (let i = 0; i < n; i++) {
    const budget = i % 3 === 0;
    const price0 = budget ? 128 + ((i * 23) % 170) : 320 + ((i * 97) % 860);
    const price = Math.trunc(pyRound(price0 / 10.0) * 10);
    const star = budget ? 2 + (i % 3) : (price < 600 ? 4 : 5);
    out.push({
      id: 900000 + i * 137,
      name: `北京${HOTEL_AREAS[i % HOTEL_AREAS.length]!}${HOTEL_BRANDS[i % HOTEL_BRANDS.length]!}酒店`,
      star,
      score: pyRound1(4.1 + ((i * 7) % 9) / 10.0),
      reviews: 180 + ((i * 613) % 9000),
      area: HOTEL_AREAS[i % HOTEL_AREAS.length]!,
      room: ["大床房", "高级双床间", "行政大床房", "家庭房", "商务双床房"][i % 5]!,
      price,
      tags: ["免费取消", ...(i % 3 === 0 ? ["包早餐"] : [])],
    });
  }
  out.sort((a, b) => (b.score - a.score) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/* ================================================================ 站点产物 */

/** Python `json.dumps(payload, ensure_ascii=False, indent=1)` 的等价物（见文件头偏差说明）。 */
function pyJsonIndent1(payload: unknown): string {
  return JSON.stringify(payload, null, 1);
}

export function dumpJs(dates?: readonly string[] | null): string {
  const ds = dates && dates.length ? dates : nextWeekDates();
  const payload = {
    window: { lo: WINDOW[0], hi: WINDOW[1] },
    route: { from: FROM_CITY, from_code: FROM_CODE, to: TO_CITY, to_code: TO_CODE },
    dates: ds.map((d) => ({ date: d, wd: weekdayCn(d), short: shortCn(d) })),
    flights: buildFlights(ds),
    hotels: buildHotels(),
  };
  return "// 由 ctrip/data.py 生成，请勿手改：python3 ctrip/data.py --write\n"
    + "window.CTRIP = " + pyJsonIndent1(payload) + ";\n";
}

export function writeJs(dates?: readonly string[] | null): string {
  fs.mkdirSync(SITE, { recursive: true });
  fs.writeFileSync(DATA_JS, dumpJs(dates), "utf-8");
  return DATA_JS;
}

/* ================================================================ 判分口径 */

export function inWindow(dep: string, lo: string = WINDOW[0], hi: string = WINDOW[1]): boolean {
  return lo <= dep && dep <= hi;
}

/** 某天 08:00-18:00 内最低价航班（同价取更早起飞）。 */
export function lowestFlight(
  flights: readonly Flight[], date: string,
  lo: string = WINDOW[0], hi: string = WINDOW[1],
): Flight | null {
  const pool = flights.filter((f) => f.date === date && inWindow(f.dep, lo, hi));
  if (!pool.length) return null;
  // Python 的 `min(key=(price, dep))` 在并列时保留**先出现**的那个
  return pool.reduce((best, f) => (f.price < best.price
    || (f.price === best.price && f.dep < best.dep) ? f : best));
}

export function lowestAnyTime(flights: readonly Flight[], date: string): Flight | null {
  const pool = flights.filter((f) => f.date === date);
  if (!pool.length) return null;
  return pool.reduce((best, f) => (f.price < best.price
    || (f.price === best.price && f.dep < best.dep) ? f : best));
}

/** 周一至周五里 08:00-18:00 最低价的那张票（同价取更早的日期）。 */
export function bestOverall(
  flights: readonly Flight[], dates: readonly string[],
  lo: string = WINDOW[0], hi: string = WINDOW[1],
): [string, Flight] | null {
  const cands: Array<[string, Flight]> = [];
  for (const d of dates) {
    const f = lowestFlight(flights, d, lo, hi);
    if (f) cands.push([d, f]);
  }
  if (!cands.length) return null;
  return cands.reduce((best, cur) => (cur[1].price < best[1].price
    || (cur[1].price === best[1].price && cur[0] < best[0]) ? cur : best));
}

/** 出发当日 ≤cap 元的酒店，按价格升序（同价按评分降序）。 */
export function hotelsUnder(hotels: readonly Hotel[], cap = 300): Hotel[] {
  return hotels.filter((h) => h.price <= cap)
    .slice()
    .sort((a, b) => (a.price - b.price) || (b.score - a.score));
}

/* ================================================================ main */

function todayIsoLocal(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function main(argv?: readonly string[]): number {
  const args = argv === undefined ? process.argv.slice(2) : [...argv];
  const dates = nextWeekDates();
  console.log(`今天 ${todayIsoLocal()} -> 测试用例的「下周周一至周五」: ${dates}`);
  const flights = buildFlights(dates);
  for (const d of dates) {
    const win = lowestFlight(flights, d)!;
    const anyT = lowestAnyTime(flights, d)!;
    const mark = anyT.dep !== win.dep ? "  <- 全场最低在时段外" : "";
    console.log(`  ${d} ${weekdayCn(d)}  区间内最低 ${win.no.padStart(7)} ${win.dep} `
      + `¥${String(win.price).padEnd(5)} | 全天最低 ${anyT.no.padStart(7)} ${anyT.dep} `
      + `¥${anyT.price}${mark}`);
  }
  const [d, f] = bestOverall(flights, dates)!;
  console.log(`结论：${d}（${weekdayCn(d)}）${f.no} ${f.airline} ${f.dep}-${f.arr} ¥${f.price}`);
  const hotels = hotelsUnder(buildHotels());
  console.log(`${d} 入住 ≤300 元酒店 ${hotels.length} 家，最低 ${hotels[0]!.name} ¥${hotels[0]!.price}`);
  if (args.includes("--write")) {
    console.log("wrote", writeJs(dates));
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
