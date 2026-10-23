/**
 * 迁移层的 TS 离线测试 —— 与 `transfer/test_transfer.py` 对应，外加两条 Python 版没有的：
 *
 *  1. **六个站点的逐字节相等**（最重要）：`dumpJs()` 必须和提交进仓库的
 *     `transfer/site{N}/data{N}.js` 一个字节都不差 —— 这是 Python 生成物，是迁移的
 *     确定性硬指标；两套实现只要有一处随机数顺序/取整/序列化不同，这里立刻红。
 *  2. **端到端**：用生产执行循环 `runSite()`（真浏览器 + 脚本模型，不加载 1.7GB ONNX）
 *     跑 SkyBook 判分 7/7、`blocked=null`；FareHaven 的 `--no-when` 消融必须阻塞在
 *     第一个没有遮罩的日期上（对照 Python 记录的 1/7）。
 *
 * 另外覆盖：spec 加载/展开长度、迁移度量（与 Python 报告同数）、消融只改运行时策略
 * 不改计划形状、各站点判分口径（库存各不相同）。
 */
// **冻结展开日期**：spec 的 `per_date` 阶段按"下周"算，所以"今天是哪天"会改变展开结果——
// 而本文件对拍的是**冻结语料**（提交进仓库的 Python 生成物、迁移度量、端到端判分），
// 它们对应"下周 = 2026-10-05..09"那一周。不钉住的话，周日→周一跨过边界后
// `nextWeekDates()` 会换成 10-12..16，整个文件集体变红（实测 15 条）。
// 与 `tests/app-packs-authored.test.ts` 的 `emitted()`、`tools/spec-to-pack.ts` 的 FROZEN_TODAY 同一口径。
import "./frozen-today.ts";               // 钉住展开日期（常量与理由见该文件）

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as C from "../src/data/ctrip-data.ts";
import * as CT from "../src/data/ctrip-oracle.ts";
import {
  deriveFlightSubgoals, deriveHotelSubgoals, deriveSubgoals, loadSpec, migrationMetrics,
  shape, specRoles, validateSpec, type FlowSpec,
} from "../src/flow/flow.ts";
import * as TT from "../src/flow/transfer-flow.ts";
import type { Oracle, OracleFlight, OracleHotel } from "../src/flow/transfer-flow.ts";
import * as D2 from "../src/data/transfer-data2.ts";
import * as D3 from "../src/data/transfer-data3.ts";
import * as D4 from "../src/data/transfer-data4.ts";
import * as D5 from "../src/data/transfer-data5.ts";
import * as D6 from "../src/data/transfer-data6.ts";
import * as D7 from "../src/data/transfer-data7.ts";
import type { MiddlewareLike } from "../src/engine/planner.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime } from "../src/model/model.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..");
const DATES = C.nextWeekDates();

/** 一个站点数据模块对测试暴露的面（比 `TT.Oracle` 宽一点：还要 dump/形状）。 */
interface SiteModule extends Oracle {
  SITE: string;
  DATA_JS: string;
  dumpJs(dates?: readonly string[] | null): string;
  inWindow(dep: string, lo?: string, hi?: string): boolean;
  WINDOW: readonly [string, string];
  SCHEDULE: ReadonlyArray<readonly [string, string, string, number]>;
  buildFlights(dates?: readonly string[] | null): OracleFlight[];
  buildHotels(n?: number, seed?: string): OracleHotel[];
}

interface SiteRow { n: number; label: string; mod: SiteModule; hotelsUnder: number; nHotels: number }

const SITES: SiteRow[] = [
  { n: 2, label: "skybook", mod: D2, hotelsUnder: 15, nHotels: 36 },
  { n: 3, label: "trekly", mod: D3, hotelsUnder: 12, nHotels: 32 },
  { n: 4, label: "flyquest", mod: D4, hotelsUnder: 14, nHotels: 30 },
  { n: 5, label: "voyagio", mod: D5, hotelsUnder: 13, nHotels: 40 },
  { n: 6, label: "farehaven", mod: D6, hotelsUnder: 11, nHotels: 38 },
  { n: 7, label: "slowjet", mod: D7, hotelsUnder: 10, nHotels: 36 },
];

const SPEC_NAMES = ["ctrip", "skybook", "trekly", "flyquest", "voyagio", "farehaven", "slowjet"];
const load = (name: string): FlowSpec => loadSpec(path.join(REPO, "transfer", "specs", `${name}.json`));
const weekdayCn = (d: string): string => C.weekdayCn(d);

/** 由 spec 自己的阶段/repeat 定义算出的展开长度（不是抄下来的数字）。 */
function countsFromSpec(spec: FlowSpec, nDates: number): { flight: number; hotel: number; total: number } {
  let flight = 0;
  let hotel = 0;
  for (const ph of spec.phases ?? []) {
    const times = { once: 1, per_date: nDates, per_checkin: 1 }[ph.repeat ?? "once"];
    const n = times * (ph.steps ?? []).length;
    if ((ph.stage ?? "flight") === "flight") flight += n;
    else hotel += n;
  }
  return { flight, hotel, total: flight + hotel };
}

/* ================================================================ 逐字节一致性 */

describe("六个复刻站：dumpJs() 与提交的 Python 生成物逐字节相等", () => {
  it.each(SITES)("site$n/$label data$n.js 逐字节相等", (row) => {
    const committed = fs.readFileSync(row.mod.DATA_JS, "utf-8");
    // 1) 用「今天」推出来的下周 —— 与 Python `write_js(next_week_dates())` 同一条路径
    expect(row.mod.dumpJs(row.mod.nextWeekDates())).toBe(committed);
    // 2) 日期无关：用提交文件自己的日期重算，RNG/序列化的回归在任何一天都能抓住
    const payload = JSON.parse(committed.slice(committed.indexOf("{"), committed.lastIndexOf(";"))) as {
      dates: Array<{ date: string }>;
    };
    expect(row.mod.dumpJs(payload.dates.map((x) => x.date))).toBe(committed);
  });

  it.each(SITES)("site$n/$label 生成器可重入且形状正确", (row) => {
    const dates = row.mod.nextWeekDates();
    expect(row.mod.buildFlights(dates)).toEqual(row.mod.buildFlights(dates));
    expect(row.mod.buildHotels()).toEqual(row.mod.buildHotels());
    const committed = JSON.parse(fs.readFileSync(row.mod.DATA_JS, "utf-8")
      .slice(fs.readFileSync(row.mod.DATA_JS, "utf-8").indexOf("{")).replace(/;\s*$/, "")) as {
      window: { lo: string; hi: string };
      route: Record<string, string>;
      dates: unknown[];
      flights: OracleFlight[];
      hotels: OracleHotel[];
    };
    expect(committed.dates).toHaveLength(5);
    expect(committed.flights).toHaveLength(5 * row.mod.SCHEDULE.length);
    expect(committed.hotels).toHaveLength(row.nHotels);
    expect(committed.window).toEqual({ lo: row.mod.WINDOW[0], hi: row.mod.WINDOW[1] });
    expect(committed.route.fromCode).toBe("KMG");
    expect(committed.route.toCode).toBe("BJS");
    for (const f of committed.flights) {
      expect(f.date).toBeTruthy();
      expect(f.price).toBeGreaterThan(0);
      expect(String(f.no)).toMatch(/^[A-Z0-9]+\d{3}$/);
    }
    // 酒店按 (-score, name) 排序：这是判分口径读数据的前提
    for (let i = 1; i < committed.hotels.length; i++) {
      const a = committed.hotels[i - 1]!;
      const b = committed.hotels[i]!;
      expect(a.score! > b.score! || (a.score === b.score && a.name! <= b.name!)).toBe(true);
    }
  });

  it("站点产物带自己的 payload 键（data2 的 perPage / data6 的 promoDates / data7 的 coldFirst）", () => {
    const head = (m: { DATA_JS: string }): Record<string, unknown> =>
      JSON.parse(fs.readFileSync(m.DATA_JS, "utf-8")
        .slice(fs.readFileSync(m.DATA_JS, "utf-8").indexOf("{")).replace(/;\s*$/, "")) as Record<string, unknown>;
    expect(head(D2).perPage).toBe(8);
    expect(head(D6).promoDates).toEqual(DATES.slice(0, 3));
    expect(head(D7).coldFirst).toBe(true);
    expect(D6.promoDates(DATES)).toEqual(DATES.slice(0, 3));
    expect((head(D2) as { window: unknown }).window).toEqual({ lo: "08:00", hi: "18:00" });
  });
});

/* ================================================================ 判分口径 */

describe("各站点的独立判分口径（库存是各自的）", () => {
  it.each(SITES)("site$n/$label：区间外最低价更便宜，≤300 的酒店数量与价格序正确", (row) => {
    const dates = row.mod.nextWeekDates();
    const flights = row.mod.buildFlights(dates);
    for (const d of dates) {
      const win = row.mod.lowestFlight(flights, d)!;
      const anyT = row.mod.lowestAnyTime(flights, d)!;
      expect(row.mod.inWindow(win.dep)).toBe(true);
      expect(win.price).toBe(Math.min(...flights.filter((f) => f.date === d
        && row.mod.inWindow(f.dep)).map((f) => f.price)));
      // 不筛时段就会答错：每天全天最低都在 08:00-18:00 之外
      expect(row.mod.inWindow(anyT.dep)).toBe(false);
      expect(anyT.price).toBeLessThan(win.price);
    }
    const hotels = row.mod.buildHotels();
    const under = row.mod.hotelsUnder(hotels, 300);
    expect(under).toHaveLength(row.hotelsUnder);
    expect(under.map((h) => h.price)).toEqual([...under.map((h) => h.price)].sort((a, b) => a - b));
    expect(under.every((h) => h.price <= 300)).toBe(true);
    expect(row.mod.hotelsUnder(hotels, 0)).toEqual([]);
    // 边界：=300 计入（skybook 的 300 元档就是靠这条跨页的）
    for (const h of hotels) {
      if (h.price === 300) expect(under.map((x) => x.id)).toContain(h.id);
      if (h.price > 300) expect(under.map((x) => x.id)).not.toContain(h.id);
    }
  });

  it("bestOverall 取五天区间内最低（同价取更早日期），六个站点答案互不相同", () => {
    const answers: Array<[string, string, number]> = [];
    for (const row of SITES) {
      const dates = row.mod.nextWeekDates();
      const flights = row.mod.buildFlights(dates);
      const [d, f] = row.mod.bestOverall(flights, dates)!;
      const min = dates.reduce((a, b) => (row.mod.lowestFlight(flights, b)!.price
        < row.mod.lowestFlight(flights, a)!.price ? b : a));
      expect(d).toBe(min);
      answers.push([d, f.no, f.price]);
    }
    const ctripBest = C.bestOverall(C.buildFlights(DATES), DATES)!;
    answers.push([ctripBest[0], ctripBest[1].no, ctripBest[1].price]);
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(7);
    expect(new Set(answers.map((a) => a[0])).size).toBe(5);
  });

  it("SkyBook 的 ≤300 酒店正好跨两页 8+7；≤300 的集合与携程完全不同", () => {
    const under = D2.hotelsUnder(D2.buildHotels(), 300);
    expect(under).toHaveLength(15);
    expect(under.slice(0, 8)).toHaveLength(8);
    expect(under.slice(8)).toHaveLength(7);
    expect(new Set(D2.buildHotels().map((h) => h.name)))
      .not.toEqual(new Set(C.buildHotels().map((h) => h.name)));
  });
});

/* ================================================================ spec / 展开 */

describe("spec 加载、校验与展开（配置即流程）", () => {
  it("七份 spec 全部 load 通过，展开长度由阶段/repeat 定义决定", () => {
    const specs = TT.discoverSpecs();
    expect(Object.keys(specs).sort()).toEqual([...SPEC_NAMES].sort());
    for (const name of SPEC_NAMES) {
      const spec = load(name);
      expect(validateSpec(spec)).toEqual([]);
      expect(spec.name && spec.site_dir).toBeTruthy();
      const c = countsFromSpec(spec, DATES.length);
      expect(deriveFlightSubgoals(spec, DATES, weekdayCn)).toHaveLength(c.flight);
      expect(deriveHotelSubgoals(spec, "2026-10-08")).toHaveLength(c.hotel);
      expect(deriveSubgoals(spec, DATES, "2026-10-08", weekdayCn)).toHaveLength(c.total);
      expect(specRoles(spec, DATES)).toHaveLength(c.total);
      for (const sg of deriveSubgoals(spec, DATES, "2026-10-08", weekdayCn)) {
        expect(sg.start_url).toMatch(/^file:\/\//);
        expect(Object.keys(sg.signal).length).toBeGreaterThan(0);
        expect(sg.target_hints ?? [sg.target_hint]).toBeTruthy();
      }
    }
  });

  it("Python 报告引用的子目标数：ctrip 19 / skybook 23 / voyagio 24 / farehaven 24 / slowjet 19", () => {
    const n = (name: string): number => deriveSubgoals(load(name), DATES, "2026-10-08", weekdayCn).length;
    expect(n("ctrip")).toBe(19);
    expect(n("skybook")).toBe(23);
    expect(n("voyagio")).toBe(24);
    expect(n("farehaven")).toBe(24);
    expect(n("slowjet")).toBe(19);
    expect(n("trekly")).toBe(19);
    expect(n("flyquest")).toBe(19);
    // 骨架形状 = 阶段列表；形状差异是"多开一个 per_date 阶段"表达出来的
    expect(shape(load("voyagio"))).toEqual([
      "entry[once]×1", "wizard_date[per_date]×1", "wizard_options[per_date]×1",
      "results[per_date]×2", "hotel[per_checkin]×2", "collect[per_checkin]×1",
    ]);
    expect(shape(load("slowjet"))).toEqual(shape(load("ctrip")));
    expect(shape(load("skybook"))).toEqual([
      "entry[once]×1", "flights[per_date]×3", "hotel[per_checkin]×2", "collect[per_checkin]×5",
    ]);
    expect(shape(load("farehaven"))).toEqual([
      "entry[once]×1", "flights[per_date]×4", "hotel[per_checkin]×2", "collect[per_checkin]×1",
    ]);
  });

  it("ctrip spec 展开 == 手写的 ctrip 计划（逐字段）", () => {
    const derived = deriveSubgoals(load("ctrip"), DATES, "2026-10-08", weekdayCn);
    const handwritten = [...CT.flightSubgoals(DATES), ...CT.hotelSubgoals("2026-10-08")];
    expect(derived).toHaveLength(19);
    expect(handwritten).toHaveLength(19);
    for (let i = 0; i < derived.length; i++) {
      expect(derived[i]!.desc).toBe(handwritten[i]!.desc);
      expect(derived[i]!.signal).toEqual(handwritten[i]!.signal);
      expect(derived[i]!.start_url).toBe(handwritten[i]!.start_url);
      expect(derived[i]!.target_hint).toBe(handwritten[i]!.target_hint);
    }
  });

  it("oracleFor 把 spec.data_module 映射到已移植模块；未知模块直接抛错", () => {
    const specs = TT.discoverSpecs();
    expect(TT.oracleFor(specs["skybook"]!)).toBe(D2);
    expect(TT.oracleFor(specs["slowjet"]!)).toBe(D7);
    expect(TT.oracleFor(specs["ctrip"]!)).toBe(C);
    expect(() => TT.oracleFor({ ...specs["skybook"]!, data_module: "transfer.data99" }))
      .toThrow(/unknown data_module/);
  });

  it("retries 与 when 是计划里的数据，不是运行期发明", () => {
    const slow = deriveSubgoals(load("slowjet"), DATES, "2026-10-07", weekdayCn);
    const retried = slow.filter((s) => s.retries);
    expect(retried).toHaveLength(5);
    expect(retried.every((s) => s.retries === 1)).toBe(true);
    expect(retried[0]!.start_url).toContain("summary.html");
    expect(retried[0]!.target_hint).toBe("#record-fare");

    const fare = deriveSubgoals(load("farehaven"), DATES, "2026-10-08", weekdayCn);
    const guarded = fare.filter((s) => s.when);
    expect(guarded).toHaveLength(5);
    expect(guarded[0]!.when).toEqual({ css_exists: ["#promo-modal"] });
    expect(guarded[0]!.target_hint).toBe("#promo-dismiss");

    const fly = deriveSubgoals(load("flyquest"), DATES, "2026-10-05", weekdayCn);
    expect(fly[1]!.target_hints).toEqual(["#date", "#window", "#search-btn"]);
    expect(fly[1]!.target_hint).toBeUndefined();
    expect(fly[1]!.slots).toEqual({ date: DATES[0] });
  });

  it("消融（_stripWhen / _stripRetries）只改运行时策略，不改计划形状", () => {
    const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

    const fare = deriveSubgoals(load("farehaven"), DATES, "2026-10-08", weekdayCn);
    const fareStripped = TT._prepare(clone(fare), true, false);
    expect(fare.some((s) => s.when)).toBe(true);
    expect(fareStripped.some((s) => s.when)).toBe(false);
    expect(fareStripped).toHaveLength(fare.length);
    expect(fareStripped.map((s) => s.desc)).toEqual(fare.map((s) => s.desc));
    expect(fareStripped.map((s) => s.start_url)).toEqual(fare.map((s) => s.start_url));

    const slow = deriveSubgoals(load("slowjet"), DATES, "2026-10-07", weekdayCn);
    const slowStripped = TT._prepare(clone(slow), false, true);
    expect(slow.some((s) => s.retries)).toBe(true);
    expect(slowStripped.some((s) => s.retries)).toBe(false);
    expect(slowStripped).toHaveLength(slow.length);
    expect(slowStripped.map((s) => s.desc)).toEqual(slow.map((s) => s.desc));

    // 两个一起剥：结构仍然一模一样（retries/when 不属于结构）
    const both = TT._prepare(clone(slow), true, true);
    expect(both).toHaveLength(slow.length);
    expect(shape(load("slowjet"))).toEqual(shape(load("ctrip")));
  });
});

/* ================================================================ 迁移度量 */

describe("migration_metrics：基准 = 携程手写计划（与 Python 报告同数）", () => {
  const specs = TT.discoverSpecs();
  const metrics = TT.migrationMetricsForAll(specs, DATES);

  /** Python `--metrics-only` 输出的关键列（2026-10-02 实测；与日期无关）。 */
  const EXPECTED: Record<string, {
    subgoals: [number, number]; raw: string; actions: [number, number];
    extra: Record<string, number>; changed: [number, number, number];
  }> = {
    ctrip: { subgoals: [19, 19], raw: "18/18", actions: [18, 18], extra: {}, changed: [0, 0, 0] },
    skybook: { subgoals: [19, 23], raw: "15/18", actions: [18, 18], extra: {}, changed: [18, 18, 18] },
    trekly: { subgoals: [19, 19], raw: "15/18", actions: [18, 18], extra: {}, changed: [18, 18, 18] },
    flyquest: { subgoals: [19, 19], raw: "15/18", actions: [18, 29], extra: {}, changed: [18, 18, 18] },
    voyagio: { subgoals: [19, 24], raw: "15/18", actions: [18, 23], extra: { filter_window_apply: 5 }, changed: [18, 18, 18] },
    farehaven: { subgoals: [19, 24], raw: "16/18", actions: [18, 18], extra: { dismiss_promo: 5 }, changed: [18, 18, 18] },
    slowjet: { subgoals: [19, 19], raw: "15/18", actions: [18, 18], extra: {}, changed: [18, 18, 18] },
  };

  it.each(SPEC_NAMES)("%s 的共享角色 / 多出角色 / 动作数 / 形状与 Python 一致", (name) => {
    const m = metrics.sites[name]! as Record<string, never>;
    const want = EXPECTED[name]!;
    expect(m.shared_roles).toBe(18);
    expect(m.desc_identical_normalized).toBe("18/18");
    expect(m.desc_identical_raw).toBe(want.raw);
    expect(m.subgoals).toEqual({ baseline: want.subgoals[0], other: want.subgoals[1] });
    expect(m.actions).toEqual({ baseline: want.actions[0], other: want.actions[1] });
    expect(m.extra_roles).toEqual(want.extra);
    expect(m.extra_subgoals).toBe(Object.values(want.extra).reduce((a, b) => a + b, 0));
    const ch = m.fields_changed as { target_hint: number; signal: number; start_url: number };
    expect([ch.target_hint, ch.signal, ch.start_url]).toEqual(want.changed);
    // 收集阶段是站点专有的尾巴：单独统计，不混进共享角色的复用率。
    // skybook 的收集阶段有 5 步（select_all/record_page/next_page/select_all/record_page）。
    expect(m.collect_steps).toEqual({ baseline: 1, other: name === "skybook" ? 5 : 1 });
    // collect_roles 被 spec 自己的声明覆盖（Python 的 dict 合并 `|` 也是这条语义）
    expect(m.collect_roles).toEqual(specs[name]!.collect_roles ?? []);
  });

  it("shape 报告两侧骨架；度量本身是纯函数（不改输入）", () => {
    const m = metrics.sites["skybook"]! as { shape: { baseline: string[]; other: string[] } };
    expect(m.shape.baseline).toEqual(shape(specs["ctrip"]!));
    expect(m.shape.other).toEqual(shape(specs["skybook"]!));
    const a = deriveSubgoals(specs["ctrip"]!, DATES, "2026-10-08", weekdayCn);
    const b = deriveSubgoals(specs["skybook"]!, DATES, "2026-10-07", weekdayCn);
    const snap = JSON.stringify([a, b]);
    const m2 = migrationMetrics(a, b, { baselineSpec: specs["ctrip"]!, otherSpec: specs["skybook"]!, dates: DATES });
    expect(JSON.stringify([a, b])).toBe(snap);
    expect(m2.shared_roles).toBe(18);
    // ctrip 对自己的度量是恒等用例
    const id = migrationMetrics(a, deriveSubgoals(specs["ctrip"]!, DATES, "2026-10-08", weekdayCn),
      { baselineSpec: specs["ctrip"]!, otherSpec: specs["ctrip"]!, dates: DATES });
    expect(id.fields_changed).toEqual({ target_hint: 0, signal: 0, start_url: 0 });
    expect(id.subgoals).toEqual({ baseline: 19, other: 19 });
  });

  it("基准就是 ctrip 手写计划（未经配置），每个站点都是 18 个共享角色", () => {
    expect(metrics.baseline).toContain("ctrip");
    expect(Object.keys(metrics.sites)).toHaveLength(7);
    for (const name of SPEC_NAMES) expect((metrics.sites[name] as { shared_roles: number }).shared_roles).toBe(18);
  });
});

/* ================================================================ emitPlan */

describe("emitPlan：配置 → 冻结计划 JSON", () => {
  it("skybook 的 23 个子目标、slots 与 hint 都落盘，可被 TaskPlan 读回", () => {
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-plan-"));
    try {
      const p = TT.emitPlan("skybook", load("skybook"), outdir);
      const d = JSON.parse(fs.readFileSync(p, "utf-8")) as {
        goal: string; subgoals: Array<{ desc: string; target_hint?: string }>; slots: Record<string, unknown>;
      };
      expect(d.goal).toBe(CT.GOAL);
      expect(d.subgoals).toHaveLength(23);
      expect(d.subgoals[0]!.target_hint).toBe("#nav-flights");
      expect(d.slots).toEqual({ window: "0800-1800", sort: "price_asc" });
    } finally {
      fs.rmSync(outdir, { recursive: true, force: true });
    }
  });
});

/* ================================================================ verifyWith */

describe("verifyWith：同一套判分口径，只把数据源作为参数传入", () => {
  function goodRecords(): { records: TT.Ledger; checkin: string } {
    const flights = C.buildFlights(DATES);
    const records: TT.Ledger = { flights: [], hotels: [], skipped: 0, retried: 0 };
    for (const d of DATES) {
      const f = C.lowestFlight(flights, d)!;
      records.flights.push({ date: d, no: f.no, price: f.price, dep: f.dep });
    }
    const bestDate = C.bestOverall(flights, DATES)![0];
    records.hotels = C.hotelsUnder(C.buildHotels(), 300).map((h) => ({ ...h, checkin: bestDate }));
    return { records, checkin: bestDate };
  }

  it("oracle=ctrip 时与 ctrip-task.verify 逐字段相等（换了机制没换语义）", () => {
    const { records, checkin } = goodRecords();
    expect(TT.verifyWith(C, records, checkin)).toEqual(CT.verify(records, checkin));
    // 有牙齿：篡改后两边同样失败
    const mutated = structuredClone(records);
    mutated.flights[0] = { ...mutated.flights[0]!, no: "XX0000" };
    expect(TT.verifyWith(C, mutated, checkin).ok).toBe(CT.verify(mutated, checkin).ok);
    expect(TT.verifyWith(C, mutated, checkin).ok).toBe(false);
    const wrongCheckin = DATES.find((d) => d !== checkin)!;
    expect(TT.verifyWith(C, records, wrongCheckin).ok).toBe(false);
  });

  it("换成站点 oracle 后，判分读的是那个站点的库存（这里用 skybook）", () => {
    const records: TT.Ledger = { flights: [], hotels: [], skipped: 0, retried: 0 };
    const flights = D2.buildFlights(DATES);
    for (const d of DATES) {
      const f = D2.lowestFlight(flights, d)!;
      records.flights.push({ date: d, no: f.no, price: f.price, dep: f.dep });
    }
    const bestDate = D2.bestOverall(flights, DATES)![0];
    records.hotels = D2.hotelsUnder(D2.buildHotels(), 300).map((h) => ({ ...h, checkin: bestDate }));
    const ver = TT.verifyWith(D2, records, bestDate);
    expect(ver.checks).toHaveLength(7);
    expect(ver.ok).toBe(true);
    expect(ver.departure_date).toBe(ver.oracle_date);
    // 同一份记录拿携程口径判（库存不同）必须失败
    expect(TT.verifyWith(C, records, bestDate).ok).toBe(false);
  });
});

/* ================================================================ argv */
describe("writeResultMd：忠实记录 → 报告（对齐 Python 的排版）", () => {
  function synth(key: string): { spec: FlowSpec; res: TT.SiteResult } {
    const spec = load(key);
    const oracle = TT.oracleFor(spec);
    const ds = oracle.nextWeekDates();
    const flights = oracle.buildFlights(ds);
    const checkin = oracle.bestOverall(flights, ds)![0];
    const records: TT.Ledger = { flights: [], hotels: [], skipped: 0, retried: 0 };
    for (const d of ds) {
      const f = oracle.lowestFlight(flights, d)!;
      records.flights.push({ date: d, no: f.no, price: f.price, dep: f.dep });
    }
    records.hotels = oracle.hotelsUnder(oracle.buildHotels(), 300).map((h) => ({ ...h }));
    const res: TT.SiteResult = {
      site: key, profile: String(spec.name), language: spec.language, spec: spec._path ?? "",
      dates: ds, checkin, records, skipped: 0, retried: 0,
      dropped_when: false, dropped_retries: false,
      verify: TT.verifyWith(oracle, records, checkin), blocked: null,
      audit: { verdict: "APPROVE", reasons: ["trace clean, goal signal present"], auditor: "mock" },
      subgoals: deriveSubgoals(spec, ds, checkin, oracle.weekdayCn).length,
      steps: [],
    };
    return { spec, res };
  }

  it("酒店评分按 float 打印（4.0）、blocked=null 打印成 Python 的 None", () => {
    const { spec, res } = synth("skybook");
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-md-"));
    try {
      const text = fs.readFileSync(TT.writeResultMd(res, spec, outdir), "utf-8");
      expect(text).toContain("# 迁移结果 · skybook-replica2（en）");
      expect(text).toContain("| 4.0 |");                    // Python float repr，不是 `4`
      expect(text).toContain("blocked=None");
      expect(text).toContain(`**最低价**：${res.checkin}`);
      expect(text).toContain("✅");
      expect(text).not.toContain("❌");
      // 阻塞时按原样打印 stop_reason
      const blocked = { ...res, blocked: "low confidence 0.05 < floor 0.25 on step 1" };
      expect(fs.readFileSync(TT.writeResultMd(blocked, spec, outdir), "utf-8"))
        .toContain("blocked=low confidence 0.05 < floor 0.25 on step 1");
    } finally {
      fs.rmSync(outdir, { recursive: true, force: true });
    }
  });

  it("报告只从独立口径读数据（页面记录与口径不符时表格打 ❌）", () => {
    const { spec, res } = synth("skybook");
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-md-"));
    try {
      const bad = structuredClone(res);
      bad.records.flights = bad.records.flights.map((f) => ({ ...f, no: "XX0000" }));
      const text = fs.readFileSync(TT.writeResultMd(bad, spec, outdir), "utf-8");
      expect(text).toContain("❌");
    } finally {
      fs.rmSync(outdir, { recursive: true, force: true });
    }
  });
});
