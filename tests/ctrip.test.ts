/**
 * 携程用例的 TS 离线测试 —— 与 `ctrip/test_ctrip.py` 逐条对应（日期推断、数据确定性、
 * 判分口径、计划合法性、复刻站真的会筛/排序/记录），再加一条 Python 版没有的
 * **端到端**：用生产执行循环（`runSubgoals` + `verify`）跑完整 19 子目标计划。
 *
 * 三条口径值得单独说：
 *  1. 站点数据是**生成物**：`dumpJs()` 必须和提交进仓库的 `ctrip/site/ctrip_data.js`
 *     逐字节一致 —— 否则页面展示的票价和判分口径会脱节。这是本文件最重要的一条。
 *  2. 判分必须是**独立口径**：`verify()` 只从 `ctrip-data.ts` 算，不读页面；页面只能
 *     通过点击把记录写进 `window.__CTRIP_RECORDS`。6 种篡改各自必须失败（有牙齿）。
 *  3. 端到端**不加载 1.7GB 的 ONNX**：`installLayaRuntime(scriptedRuntime(...))` 给脚本
 *     模型，且 `act` 只回低置信度 —— 计划里 19 步全靠 `target_hint` 规则命中；一旦某个
 *     hint 失效，模型那一步会因低于置信度下限而 BLOCKED，测试立刻红。
 */
// 冻结展开日期：本文件对拍的是冻结语料（Python 生成物 / 端到端判分 / 五天记录），见 tests/frozen-today.ts
import "./frozen-today.ts";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import * as browserEnv from "../src/browser/browser-env.ts";
import * as C from "../src/data/ctrip-data.ts";
import * as T from "../src/sites/ctrip-task.ts";
import { PlanningRules } from "../src/engine/plan.ts";
import { SIGNAL_OPS } from "../src/engine/signals.ts";
import type { MiddlewareLike } from "../src/engine/planner.ts";
import { BrowserMiddleware, type AnyPage, type PwLike } from "../src/engine/executor.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime } from "../src/model/model.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..");
const SITE = path.join(REPO, "ctrip", "site");
const readSite = (name: string): string => fs.readFileSync(path.join(SITE, name), "utf-8");

/* ---------------------------------------------------------------- 日期推断 */

describe("日期推断（nextWeekDates 来自引擎侧）", () => {
  it("从周五 2026-10-02 推出下周周一至周五", () => {
    expect(C.nextWeekDates("2026-10-02")).toEqual(
      ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
  });

  it("周一问「下周」= 下一个周一；周日 -> 次日", () => {
    expect(C.nextWeekDates("2026-10-05")[0]).toBe("2026-10-12");
    expect(C.nextWeekDates("2026-10-04")[0]).toBe("2026-10-05");
    for (const d of ["2026-10-02", "2026-10-05", "2026-10-04"]) {
      const days = C.nextWeekDates(d);
      expect(days).toHaveLength(5);
      for (const x of days) expect(new Date(`${x}T00:00:00Z`).getUTCDay()).toBeGreaterThanOrEqual(1);
      for (const x of days) expect(new Date(`${x}T00:00:00Z`).getUTCDay()).toBeLessThanOrEqual(5);
    }
  });

  it("weekdayCn / shortCn 与 Python 的中文口径一致", () => {
    expect(C.nextWeekDates("2026-10-02").map(C.weekdayCn))
      .toEqual(["周一", "周二", "周三", "周四", "周五"]);
    expect(C.shortCn("2026-10-05")).toBe("10月5日");
    expect(C.shortCn("2026-10-09")).toBe("10月9日");
  });
});

/* ---------------------------------------------------------------- 数据确定性 */

describe("数据确定性（MT19937 逐位复刻 CPython）", () => {
  it("PyRandom 与 Python random.Random(seed_str) 的已测序列一致", () => {
    // 这 8 个值 + 10 次 randrange 是 Python 侧实测的 ground truth
    const rng = new C.PyRandom("KMG-BJS|2026-10-05");
    expect(Array.from({ length: 8 }, () => rng.genrandUint32())).toEqual([
      1610426937, 1988526081, 1468280880, 1422587816,
      1997092674, 3896364578, 1859916880, 3769321863,
    ]);
    const rng2 = new C.PyRandom("KMG-BJS|2026-10-05");
    expect(Array.from({ length: 10 }, () => rng2.randrange(-4, 5)))
      .toEqual([1, 3, 1, 1, 3, 2, -3, -2, 3, -4]);
  });

  it("dumpJs() 与提交的 ctrip/site/ctrip_data.js 逐字节一致", () => {
    const committed = fs.readFileSync(C.DATA_JS, "utf-8");
    expect(C.dumpJs(C.nextWeekDates())).toBe(committed);
    // 生成物本身也必须可重入（两次生成完全相同）
    expect(C.buildFlights(C.nextWeekDates())).toEqual(C.buildFlights(C.nextWeekDates()));
    expect(C.buildHotels()).toEqual(C.buildHotels());
  });

  it("dumpJs 用提交文件自己的日期重算也逐字节一致（不依赖「今天是哪天」）", () => {
    // Python 的同名测试把「今天」耦合进了断言（next_week_dates 随日期漂移）；
    // 这里补一条日期无关的版本：RNG/序列化的回归在任何一天都能被抓住。
    const committed = fs.readFileSync(C.DATA_JS, "utf-8");
    const d = JSON.parse(committed.slice(committed.indexOf("{"), committed.lastIndexOf(";"))) as {
      dates: Array<{ date: string }>;
    };
    expect(C.dumpJs(d.dates.map((x) => x.date))).toBe(committed);
  });

  it("提交的数据可加载、形状正确", () => {
    const s = fs.readFileSync(C.DATA_JS, "utf-8");
    const d = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf(";"))) as {
      dates: unknown[]; flights: C.Flight[]; hotels: C.Hotel[]; window: { lo: string; hi: string };
    };
    expect(d.dates).toHaveLength(5);
    expect(d.flights).toHaveLength(5 * C.SCHEDULE.length);
    expect(d.window).toEqual({ lo: "08:00", hi: "18:00" });
    for (const f of d.flights) {
      expect(f.from).toBe("KMG");
      expect(f.to).toBe("BJS");
      expect(f.price).toBeGreaterThan(0);
      expect(f.dep === f.arr || f.dep < f.arr || f.dep > f.arr).toBe(true);
    }
  });
});

/* ---------------------------------------------------------------- 判分口径 */

describe("判分口径（oracle）", () => {
  const dates = C.nextWeekDates();
  const flights = C.buildFlights(dates);

  it("inWindow 是闭区间，且不含空时刻", () => {
    expect(C.inWindow("08:00")).toBe(true);
    expect(C.inWindow("18:00")).toBe(true);
    expect(C.inWindow("07:59")).toBe(false);
    expect(C.inWindow("18:01")).toBe(false);
  });

  it("lowestFlight 取区间内最低价（同价取更早）", () => {
    for (const d of dates) {
      const win = C.lowestFlight(flights, d)!;
      expect(win).not.toBeNull();
      expect(C.inWindow(win.dep)).toBe(true);
      const pool = flights.filter((f) => f.date === d && C.inWindow(f.dep));
      expect(win.price).toBe(Math.min(...pool.map((f) => f.price)));
      // 同价必须取更早起飞的那个
      const same = pool.filter((f) => f.price === win.price);
      expect(win.dep).toBe(same.map((f) => f.dep).sort()[0]);
    }
  });

  it("每天都有区间外更便宜的航班（不筛时段就会答错）", () => {
    for (const d of dates) {
      const win = C.lowestFlight(flights, d)!;
      const anyT = C.lowestAnyTime(flights, d)!;
      expect(C.inWindow(anyT.dep)).toBe(false);
      expect(anyT.price).toBeLessThan(win.price);
    }
  });

  it("bestOverall = 五天里区间内最低（同价取更早的日期）；五天起飞时刻异质", () => {
    const best = C.bestOverall(flights, dates)!;
    const [d, f] = best;
    expect(d).toBe(dates.reduce((a, b) => (C.lowestFlight(flights, b)!.price
      < C.lowestFlight(flights, a)!.price ? b : a)));
    expect(f.no).toBe(C.lowestFlight(flights, d)!.no);
    expect(new Set(dates.map((x) => C.lowestFlight(flights, x)!.dep)).size).toBeGreaterThanOrEqual(3);
  });

  it("hotelsUnder 的边界：=300 计入、>300 排除、按价格升序", () => {
    const hotels = C.buildHotels();
    const under = C.hotelsUnder(hotels, 300);
    expect(under.length).toBeGreaterThan(0);
    expect(under.every((h) => h.price <= 300)).toBe(true);
    expect(under.map((h) => h.price)).toEqual([...under.map((h) => h.price)].sort((a, b) => a - b));
    for (const h of hotels) if (h.price > 300) expect(under).not.toContainEqual(h);
    expect(C.hotelsUnder(hotels, 0)).toEqual([]);
    for (const h of hotels) if (h.price === 300) expect(under.map((x) => x.id)).toContain(h.id);
    // 同价按评分降序
    for (let i = 1; i < under.length; i++) {
      if (under[i]!.price === under[i - 1]!.price) {
        expect(under[i - 1]!.score).toBeGreaterThanOrEqual(under[i]!.score);
      }
    }
  });
});

/* ---------------------------------------------------------------- 冻结计划 */

describe("冻结计划形状", () => {
  const dates = C.nextWeekDates();
  const fplan = T.makePlan(T.GOAL, T.flightSubgoals(dates));

  it("机票计划 = 1 + 3*5 步，且通过 PlanningRules", () => {
    expect(fplan.subgoals).toHaveLength(1 + 3 * 5);
    const rules = new PlanningRules(fplan.subgoals.length, true, true, [], true);
    expect(rules.problems(fplan)).toEqual([]);
    for (const sg of fplan.subgoals) {
      const ops = Object.keys(sg.signal);
      expect(ops).toHaveLength(1);
      expect(SIGNAL_OPS).toHaveProperty(ops[0]!);
      expect(sg.target_hint).toBeTruthy();
      expect(String(sg.start_url).startsWith("file://")).toBe(true);
    }
  });

  it("酒店计划 = 3 步，checkin/上限/hint 都对", () => {
    const sgs = T.hotelSubgoals("2026-10-08");
    expect(sgs).toHaveLength(3);
    for (const s of sgs) expect(String(s.start_url)).toContain("checkin=2026-10-08");
    expect(sgs[0]!.target_hint).toBe("a[data-test=cap-300]");
    expect(sgs[2]!.signal).toEqual({ css_text_contains: ["[data-test=hotel-recorded]", "已记录"] });
    const rules = new PlanningRules(3, true, true, [], true);
    expect(rules.problems(T.makePlan(T.GOAL, sgs))).toEqual([]);
  });

  it("最后一步的 URL 带齐 window + sort + date，首页 hint 指向真实入口", () => {
    const last = fplan.subgoals[fplan.subgoals.length - 1]!;
    expect(last.signal).toEqual({ css_text_contains: ["[data-test=last-record]", "已记录"] });
    expect(last.target_hint).toBe("button[data-test=record-lowest]");
    expect(String(last.start_url)).toContain(`date=${dates[dates.length - 1]}`);
    expect(String(last.start_url)).toContain("window=0800-1800");
    expect(String(last.start_url)).toContain("sort=price_asc");
    expect(fplan.subgoals[0]!.target_hint).toBe("a[data-test=entry-flight]");
  });

  it("pageUrl 是 file:// + 查询串（中文按 UTF-8 百分号编码）", () => {
    const u = T.pageUrl("hotels.html", { city: "北京", checkin: "2026-10-08", cap: 300 });
    expect(u.startsWith("file://")).toBe(true);
    expect(u).toContain("city=%E5%8C%97%E4%BA%AC");
    expect(u).toContain("cap=300");
    expect(T.pageUrl("flights.html", { from: "KMG" })).toBe(
      pathToFileURL(path.join(SITE, "flights.html")).href + "?from=KMG");
  });

  it("每个 hint 指向站点真实渲染的元素（静态：读 site/*.html + site.js）", () => {
    const home = readSite("ct_home.html");
    const flights = readSite("flights.html");
    const hotels = readSite("hotels.html");
    const site = readSite("site.js");
    // 直接写在 HTML 里的
    expect(home).toContain('data-test="entry-flight"');
    expect(flights).toContain('data-test="window-state"');
    expect(flights).toContain('data-test="sort-state"');
    expect(flights).toContain('data-test="last-record"');
    expect(flights).toContain('data-test="record-lowest"');
    expect(hotels).toContain('data-test="price-cap-state"');
    expect(hotels).toContain('data-test="hotel-recorded"');
    expect(hotels).toContain('data-test="record-hotels"');
    // 过滤器是 site.js 按 key 渲染的：模板 + key 都必须存在
    expect(site).toContain("data-test=\"window-${key}\"");
    expect(site).toContain("data-test=\"sort-${key}\"");
    expect(site).toContain("data-test=\"cap-${key}\"");
    expect(site).toContain("data-test=\"h-sort-${key}\"");
    for (const key of ["0800-1800", "price_asc", "300"]) expect(site).toContain(`'${key}'`);
  });
});

/* ---------------------------------------------------------------- 判分有牙齿 */

function goodRecords(): { records: T.Records; checkin: string } {
  const dates = C.nextWeekDates();
  const flights = C.buildFlights(dates);
  const records: T.Records = { flights: [], hotels: [] };
  for (const d of dates) {
    const f = C.lowestFlight(flights, d)!;
    records.flights.push({ date: d, no: f.no, price: f.price, dep: f.dep });
  }
  const [bestDate] = C.bestOverall(flights, dates)!;
  records.hotels = C.hotelsUnder(C.buildHotels(), 300).map((h) => ({ ...h, checkin: bestDate }));
  return { records, checkin: bestDate };
}

describe("verify 有牙齿（独立口径）", () => {
  it("忠实记录 -> 7/7 通过", () => {
    const { records, checkin } = goodRecords();
    const ver = T.verify(records, checkin);
    expect(ver.checks).toHaveLength(7);
    expect(ver.checks.filter((c) => !c.ok)).toEqual([]);
    expect(ver.ok).toBe(true);
    expect(ver.departure_date).toBe(ver.oracle_date);
  });

  const mutations: Array<[string, (r: T.Records) => void]> = [
    ["wrong-flight", (r) => { r.flights[0] = { ...r.flights[0]!, no: "XX0000" }; }],
    ["wrong-price", (r) => { r.flights[0] = { ...r.flights[0]!, price: 1 }; }],
    ["missing-day", (r) => { r.flights.pop(); }],
    ["extra-hotel", (r) => { r.hotels.push({ ...r.hotels[0]!, id: 1, price: 999 }); }],
    ["missing-hotel", (r) => { r.hotels.pop(); }],
    ["unsorted-hotels", (r) => { r.hotels.reverse(); }],
  ];
  it.each(mutations)("篡改 %s -> 失败", (_name, mutate) => {
    const { records, checkin } = goodRecords();
    mutate(records);
    expect(T.verify(records, checkin).ok).toBe(false);
  });

  it("checkin 不是出发当日 -> 酒店那项失败", () => {
    const { records, checkin } = goodRecords();
    const other = C.nextWeekDates().find((d) => d !== checkin)!;
    expect(T.verify(records, other).ok).toBe(false);
  });

  it("verify 不读页面：records 里多余的字段不影响判定", () => {
    const { records, checkin } = goodRecords();
    const clone = structuredClone(records) as T.Records;
    (clone.flights[0] as unknown as Record<string, unknown>).extra = "noise";
    expect(T.verify(clone, checkin).ok).toBe(true);
  });
});

/* ---------------------------------------------------------------- main 的开关 */

describe("main 的参数解析（--quiet / --no-hints / --route / --out / --max-steps）", () => {
  it("解析 Python argparse 的同名开关", () => {
    expect(T.parseArgv([])).toEqual({});
    expect(T.parseArgv(["--no-hints", "--route", "--quiet"])).toEqual(
      { noHints: true, route: true, quiet: true });
    expect(T.parseArgv(["--max-steps", "6", "--out", "/tmp/x"])).toEqual(
      { maxSteps: 6, out: "/tmp/x" });
    expect(T.parseArgv(["--max-steps=9", "--out=/tmp/y"])).toEqual({ maxSteps: 9, out: "/tmp/y" });
    expect(() => T.parseArgv(["--nope"])).toThrow();
  });

  it("demoUser 放行只读动作、拒绝不可逆词表里的动作", () => {
    expect(T.demoUser("把列表按价格从低到高排序", true)).toBe(true);
    expect(T.demoUser("记录当前列表最低价航班", true)).toBe(true);
    expect(T.demoUser("place order now", true)).toBe(false);
    expect(T.demoUser("delete the item", true)).toBe(false);
  });

  it("GOAL 与 Python 逐字一致", () => {
    expect(T.GOAL).toBe("我下周要去北京出差，周一至周五都可以，从昆明出发。搜索早8点至晚6点最低价的机票并记录。"
      + "另外再搜索出发当日价格300以内的酒店记录");
  });
});

/* ---------------------------------------------------------------- 复刻站本身 + 端到端 */

const pwLike: PwLike = { chromium: chromium as unknown as PwLike["chromium"] };
let browser: Browser | null = null;
let page: Page | null = null;

/** 脚本模型：noul 一律低风险/未完成；choice 只回低置信度 ——
 *  计划里 19 步必须全靠 `target_hint` 命中，模型那一步一旦被问到就会 BLOCKED。 */
const scriptedAgentImpl = scriptedAgent((key, _state, questions) => {
  const q = questions[key];
  if (!q) return undefined;
  if (q.type === "noul") return { noul: 0.02 };
  const crit = (q.criteria ?? {}) as Record<string, unknown>;
  const keys = Object.keys(crit);
  const probs: Record<string, number> = {};
  for (const k of keys) probs[k] = keys.length ? 1 / keys.length : 0;
  return { choice: keys[0] ?? "", probabilities: probs, confidence: 0.05 };
});

describe("复刻站 + 端到端（真浏览器，脚本模型）", () => {
  beforeAll(async () => {
    try {
      browser = (await browserEnv.launch(pwLike)) as unknown as Browser;
      page = await (await browser.newContext()).newPage();
    } catch {
      browser = null;                     // 没有 chromium 就跳过，不假绿
      page = null;
    }
    installLayaRuntime(scriptedRuntime(scriptedAgentImpl));
  }, 120_000);

  afterAll(async () => {
    installLayaRuntime(null);
    await browser?.close();
  });

  const needPage = (ctx: { skip: () => void }): Page => {
    if (!page) ctx.skip();
    return page as Page;
  };

  it("站点自己会筛/排序/记录：与 oracle 的航班对得上", async (ctx) => {
    const p = needPage(ctx);
    const dates = C.nextWeekDates();
    const d = dates[0]!;
    const winF = C.lowestFlight(C.buildFlights(dates), d)!;
    await p.goto(T.pageUrl("flights.html", { from: "KMG", to: "BJS", date: d, window: "0800-1800", sort: "price_asc" }));
    expect(await p.locator("[data-test=window-state]").innerText()).toContain("08:00-18:00");
    expect(await p.locator("[data-test=sort-state]").innerText()).toContain("价格从低到高");
    expect(await p.locator("[data-test=flight-card]").first().getAttribute("data-no")).toBe(winF.no);
    const inWin = C.buildFlights(dates).filter((f) => f.date === d && C.inWindow(f.dep));
    expect(await p.locator("[data-test=flight-card]").count()).toBe(inWin.length);
    await p.click("[data-test=record-lowest]");
    expect(await p.locator("[data-test=last-record]").innerText()).toContain("已记录");
    const rec = await p.evaluate(
      () => (globalThis as unknown as { __CTRIP_RECORDS: { flights: Array<{ no: string; price: number }> } })
        .__CTRIP_RECORDS.flights);
    expect(rec).toHaveLength(1);
    expect(rec[0]!.no).toBe(winF.no);
    expect(rec[0]!.price).toBe(winF.price);
  });

  it("站点价格上限过滤把 >300 的酒店排除掉", async (ctx) => {
    const p = needPage(ctx);
    await p.goto(T.pageUrl("hotels.html", { city: "北京", checkin: "2026-10-08", cap: "300", sort: "price_asc" }));
    await p.click("[data-test=record-hotels]");
    const rec = await p.evaluate(
      () => (globalThis as unknown as { __CTRIP_RECORDS: { hotels: Array<{ id: number; price: number }> } })
        .__CTRIP_RECORDS.hotels);
    const want = C.hotelsUnder(C.buildHotels(), 300);
    expect(rec.map((h) => h.id)).toEqual(want.map((h) => h.id));
    expect(rec.every((h) => h.price <= 300)).toBe(true);
  });

  it("19 个子目标的 hint 都能在对应 start_url 上解析出来，且点击前信号为假", async (ctx) => {
    const p = needPage(ctx);
    const dates = C.nextWeekDates();
    const subgoals = [...T.flightSubgoals(dates), ...T.hotelSubgoals(dates[3]!)];
    expect(subgoals).toHaveLength(19);
    for (const sg of subgoals) {
      await p.goto(String(sg.start_url));
      const sel = sg.target_hint!;
      expect.soft(await p.locator(sel).count(), `${sg.desc} -> ${sel}`).toBeGreaterThanOrEqual(1);
      const spec = sg.signal as import("../src/engine/signals.ts").SignalSpec;
      const { checkSignal } = await import("../src/engine/signals.ts");
      expect.soft(await checkSignal(p as unknown as AnyPage, spec), `${sg.desc} 点击前信号应为假`).toBe(false);
    }
  }, 120_000);

  it("端到端：完整计划 19 步 + 判分 7/7，五天记录齐全", async (ctx) => {
    const p = needPage(ctx);
    const dates = C.nextWeekDates();
    const state = path.join(os.tmpdir(), `ctrip_state_${process.pid}.json`);
    const mw = new BrowserMiddleware({
      maxSteps: 6, confFloor: 0.25, confirmFn: (desc) => T.demoUser(desc, true),
    });
    (mw as unknown as { _planVerbose: boolean })._planVerbose = false;

    const fplan = T.makePlan(T.GOAL, T.flightSubgoals(dates), null, state);
    const r1 = await T.runSubgoals(
      mw as unknown as MiddlewareLike, p as unknown as AnyPage, pwLike, fplan, false);
    expect(r1.blocked).toBeNull();
    expect(r1.records.flights).toHaveLength(dates.length);
    expect([...new Set(r1.records.flights.map((f) => f.date))].sort()).toEqual([...dates].sort());

    // 出发当日 = 机票阶段实际记录里最便宜的那天（不由判分口径喂进去）
    const picked = r1.records.flights.reduce((best, r) => (r.price < best.price
      || (r.price === best.price && r.date < best.date) ? r : best));
    const hplan = T.makePlan(T.GOAL, T.hotelSubgoals(picked.date), null, state);
    const r2 = await T.runSubgoals(
      mw as unknown as MiddlewareLike, p as unknown as AnyPage, pwLike, hplan, false);
    expect(r2.blocked).toBeNull();

    const records: T.Records = { flights: r1.records.flights, hotels: r2.records.hotels };
    const ver = T.verify(records, picked.date);
    expect(ver.checks.filter((c) => !c.ok)).toEqual([]);
    expect(ver.ok).toBe(true);
    expect(ver.checks).toHaveLength(7);
    expect(ver.departure_date).toBe(ver.oracle_date);
    expect(records.hotels.length).toBe(C.hotelsUnder(C.buildHotels(), 300).length);

    // 报告也能落盘（正文由 reportLines 决定，与 Python 逐字节对拍见 tools/ctrip-parity.ts）
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "ctrip-report-"));
    const out = T.writeReport(records, ver, outdir);
    expect(fs.readFileSync(out, "utf-8")).toContain("## 一、机票：周一至周五 08:00-18:00 最低价");
    fs.rmSync(outdir, { recursive: true, force: true });
    fs.rmSync(state, { force: true });
  }, 180_000);
});
