/**
 * 数据源引擎测试 —— 与 Python 参考实现 `datasource.py`（ctrip/test_ctrip.py 里的
 * "数据源引擎（配置驱动）" 一节）逐条对应，并加一层跨实现语料护栏：
 * `tools/gen_datasource_corpus.py` 用 Python 引擎算出的 161 项结果（含完整
 * report_markdown 文本）在 `npm test` 里被 TS 引擎重算比对。
 *
 * 三条口径值得单独说：
 *  1. "引擎不认识站点"是源码级测试：读 `src/datasource.ts` 的文本、剥掉块注释，
 *     再 grep 站点/用例词（Python 版剥的是 docstring，同理）。
 *  2. 真实夹具（从真实抓取裁剪）必须过：H5 线路页 6 条真实票价、酒店页 3 家酒店
 *     但价格节点为空（"价格需登录"）。
 *  3. 两个提交的 source 配置都必须能通过 validateSource —— 第二个配置是"同一引擎
 *     零代码改动"的证明。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  auditRows, applyOps, blocked, countRows, dateExpr, dateParams, defaultDates,
  extract, fieldValue, FileNotFoundError, inWindow, listSources, loadSource, main,
  matches, nextWeekDates, reportMarkdown, resolve, selectBest, sourceDirs, urlFor,
  validateSource, type Source,
} from "../src/datasource.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..");
const FLIGHTS_FIXTURE = path.join(REPO, "bench", "fixtures", "ctrip_h5_route.html");
const HOTELS_FIXTURE = path.join(REPO, "bench", "fixtures", "ctrip_hotels_pc.html");

const flights = (): Source => loadSource("ctrip-flights-h5");
const hotels = (): Source => loadSource("ctrip-hotels-pc");

function clone<T>(v: T): T {
  return structuredClone(v);
}

/* ---------------------------------------------------------------- 路径语言与算子 */

describe("路径语言与七算子", () => {
  const obj = { a: { b: [{ c: "x" }, { c: "y" }, { c: "z" }] } };

  it("a.b / [0] / [-1] / [] / 取不到 -> null", () => {
    expect(resolve(obj, "a.b[0].c")).toBe("x");
    expect(resolve(obj, "a.b[-1].c")).toBe("z");
    expect(resolve(obj, "a.b[].c")).toEqual(["x", "y", "z"]);
    expect(resolve(obj, "a.nope.c")).toBeNull();
    expect(resolve(obj, "a.b[9].c")).toBeNull();
    expect(resolve(obj, "a.b[-9].c")).toBeNull();
    expect(resolve(obj, "")).toBe(obj);                // 空路径 = 原对象
    expect(resolve({ a: "not-a-list" }, "a[0]")).toBeNull();
    expect(resolve([{ x: 1 }, { x: 2 }], "[].x")).toEqual([1, 2]);
    expect(resolve({ a: { b: [{ c: [1, 2] }, { c: [3] }] } }, "a.b[].c[]")).toEqual([[1, 2], [3]]);
  });

  it("七算子：time|join:<sep>|len|len-1|int|str|strip", () => {
    expect(applyOps("2026-10-09 15:30:00", ["time"])).toBe("15:30");
    expect(applyOps(["A", "B"], ["join:+"])).toBe("A+B");
    expect(applyOps(["A", "B"], ["join:"])).toBe("AB");
    expect(applyOps("AB", ["join:+"])).toBe("AB");      // 非列表原样
    expect(applyOps([1, 2, 3], ["len"])).toBe(3);
    expect(applyOps("abc", ["len"])).toBe(3);
    expect(applyOps([1, 2, 3], ["len-1"])).toBe(2);
    expect(applyOps([], ["len-1"])).toBeNull();
    expect(applyOps(1150, ["len-1"])).toBeNull();
    expect(applyOps("42", ["int"])).toBe(42);
    expect(applyOps("4.2", ["int"])).toBeNull();        // Python int("4.2") 抛错 -> null
    expect(applyOps(" 42 ", ["int"])).toBe(42);
    expect(applyOps(1150, ["str"])).toBe("1150");
    expect(applyOps(null, ["str"])).toBe("");
    expect(applyOps(null, ["int"])).toBeNull();
    expect(applyOps("  padded  ", ["strip"])).toBe("padded");
    expect(applyOps("2026-10-09 15:30:00", ["time", "strip"])).toBe("15:30");
    expect(applyOps("x", ["str", "len"])).toBe(1);
  });

  it("未知算子报错文案与 Python 一致（校验阶段就炸）", () => {
    expect(() => applyOps(1, ["sqrtt"])).toThrowError(
      "unknown op 'sqrtt' (known: time, join, len, len-1, int, str, strip)");
  });

  it("跨天到达标 +1（配置里用 compare_day_with 声明）", () => {
    const row = { s: [{ t: "2026-10-09 21:05:00" }, { t: "2026-10-10 00:30:00" }] };
    const spec = { path: "s[-1].t", ops: ["time"], compare_day_with: "s[0].t" };
    expect(fieldValue(row, spec)).toBe("00:30+1");
    expect(fieldValue(row, { path: "s[0].t", ops: ["time"] })).toBe("21:05");
    // 同一天不标 +1
    const same = { s: [{ t: "2026-10-09 21:05:00" }, { t: "2026-10-09 23:30:00" }] };
    expect(fieldValue(same, spec)).toBe("23:30");
    // 字符串形态 `path|ops`
    expect(fieldValue(row, "s[0].t|time")).toBe("21:05");
    expect(fieldValue({ items: [{ n: "a" }, { n: "b" }] }, "items[].n|join:+")).toBe("a+b");
  });
});

/* ---------------------------------------------------------------- 校验 */

describe("validateSource 在加载时炸", () => {
  it("两个提交的配置都通过（第二个站点=同一引擎零代码改动）", () => {
    for (const name of ["ctrip-flights-h5", "ctrip-hotels-pc"]) {
      const cfg = loadSource(name);
      expect(validateSource(cfg), name).toEqual([]);
      expect(cfg.name).toBe(name);
    }
    expect(hotels().extract!.kind).toBe("html_regex");
    expect(flights().extract!.kind).toBe("json_in_script");
  });

  it("每类坏配置的问题文案都包含关键片段", () => {
    const good = flights();
    const cases: Array<[string, (c: any) => void, string]> = [
      ["client", (c) => { c.transport.client = "wget"; }, "transport.client must be one of ('curl', 'httpx')"],
      ["no transport", (c) => { delete c.transport; }, "transport.url_template is required"],
      ["kind", (c) => { c.extract.kind = "magic"; }, "extract.kind must be one of ('json_in_script', 'html_regex')"],
      ["empty fields", (c) => { c.extract.fields = {}; }, "extract.fields must not be empty"],
      ["unknown op", (c) => { c.extract.fields.price = "price|sqrtt"; }, "unknown op"],
      ["unknown op in dict", (c) => { c.extract.fields.price = { path: "price", ops: ["sqrt"] }; }, "unknown op 'sqrt'"],
      ["rows", (c) => { c.extract.rows = ""; }, "extract.rows is required for json_in_script"],
      ["var", (c) => { delete c.extract.var; }, "extract.var is required for json_in_script"],
      ["date param", (c) => { c.date.params.n = "next_friday"; }, "date.params.n:"],
      ["audit", (c) => { c.audits = [{ key: "x" }]; }, "every audit needs a key and a field"],
      ["default_dates", (c) => { c.default_dates = "next_month"; }, "default_dates 'next_month'"],
      ["block_markers", (c) => { c.transport.block_markers = "whaleguard"; }, "block_markers must be a list"],
      ["url_template", (c) => { delete c.transport.url_template; }, "url_template is required"],
      ["select key", (c) => { c.selects = [{ sort_by: ["price"] }]; }, "every select needs a key"],
      ["sort_by", (c) => { c.selects = [{ key: "best", sort_by: [1] }]; }, "select best: sort_by must be field names"],
    ];
    for (const [label, mutate, snippet] of cases) {
      const c = clone(good);
      mutate(c);
      const problems = validateSource(c).join(" | ");
      expect(problems, label).toContain(snippet);
    }
  });

  it("html_regex 的捕获组数必须恰好为 1", () => {
    const two = clone(hotels());
    two.extract!.fields.id = "^(\\d+)-(\\d+)";
    expect(validateSource(two).join(" | ")).toContain(
      "extract.fields.id: regex needs exactly one capture group");
    const zero = clone(hotels());
    zero.extract!.fields.name = 'hotelName">[^<]+';
    expect(validateSource(zero).join(" | ")).toContain(
      "extract.fields.name: regex needs exactly one capture group");
    const noSplit = clone(hotels());
    delete noSplit.extract!.split;
    expect(validateSource(noSplit).join(" | ")).toContain(
      "extract.split is required for html_regex");
  });

  it("name 是必填", () => {
    const c = clone(flights());
    delete c.name;
    expect(validateSource(c)).toContain("name is required");
  });
});

/* ---------------------------------------------------------------- 引擎无站点知识 */

describe("引擎无站点知识", () => {
  it("剥掉块注释后的引擎源码里没有站点/用例词", () => {
    const src = fs.readFileSync(path.join(here, "..", "src", "datasource.ts"), "utf-8");
    // 块注释 = Python 的 docstring（承载"为什么是 curl"这类站点事实），代码与
    // 字符串照查 —— 与 ctrip/test_ctrip.py::test_the_engine_knows_no_site 同口径。
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, " ");
    expect(codeOnly.length).toBeLessThan(src.length);          // 确认真的剥掉了注释
    for (const leak of ["ctrip.com", "__INITIAL_STATE__", "flightItem", "listData",
                        "price-line", "hotelName", "trip.com", "kmg", "bjs",
                        "08:00", "18:00", "¥"]) {
      expect(codeOnly, `引擎代码里出现了站点/用例知识：${leak}`).not.toContain(leak);
    }
  });
});

/* ---------------------------------------------------------------- 传输/风控判定 */

describe("blocked：非 200 或命中配置的 block_markers", () => {
  const src = { transport: { block_markers: ["WhaleGuard"] } } as Source;
  it("两个触发条件", () => {
    expect(blocked(src, 200, "whaleguard block")).toBe(true);   // 大小写不敏感
    expect(blocked(src, 200, "<html>ok</html>")).toBe(false);
    expect(blocked(src, 432, "<html>ok</html>")).toBe(true);    // 非 200 即挡
    expect(blocked({ transport: {} } as Source, 200, "whaleguard")).toBe(false);
  });
  it("只看响应体开头 400 字符", () => {
    expect(blocked(src, 200, "x".repeat(400) + "whaleguard")).toBe(false);
    expect(blocked(src, 200, "whaleguard" + "x".repeat(400))).toBe(true);
  });
});

/* ---------------------------------------------------------------- 日期 */

describe("日期表达式与 default_dates", () => {
  it("nextWeekDates：今天所在周的下一个自然周周一..周五", () => {
    const want = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"];
    expect(nextWeekDates("2026-10-02")).toEqual(want);   // 周五
    expect(nextWeekDates("2026-10-04")).toEqual(want);   // 周日 -> 次日算下周一
    expect(nextWeekDates("2026-10-05")).toEqual(
      ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]);
  });

  it("date / day_offset / weekday_cn / date±Nday", () => {
    expect(dateExpr("date", "2026-10-05", "2026-10-02")).toBe("2026-10-05");
    expect(dateExpr("day_offset", "2026-10-05", "2026-10-02")).toBe(3);
    expect(dateExpr("day_offset", "2026-10-02", "2026-10-02")).toBe(0);
    expect(dateExpr("weekday_cn", "2026-10-05", "2026-10-02")).toBe("周一");
    expect(dateExpr("weekday_cn", "2026-10-11", "2026-10-02")).toBe("周日");
    expect(dateExpr("date+1day", "2026-10-09", "2026-10-02")).toBe("2026-10-10");
    expect(dateExpr("date-1day", "2026-10-01", "2026-10-02")).toBe("2026-09-30");
    expect(dateExpr("date+0day", "2026-10-05", "2026-10-02")).toBe("2026-10-05");
  });

  it("未知日期表达式抛 ValueError（文案与 Python 一致）", () => {
    expect(() => dateExpr("next_friday", "2026-10-05", "2026-10-02")).toThrowError(
      "unknown date expression 'next_friday' (known: date, day_offset, weekday_cn, date±Nday)");
    expect(() => dateExpr("date+1week", "2026-10-05", "2026-10-02")).toThrowError(/unknown date expression/);
    expect(() => dateExpr("date", "2026-1-1", "2026-10-02")).toThrowError(/Invalid isoformat string/);
  });

  it("default_dates 三种形态：省略->今天；列表->原样；next_week->具名表达式", () => {
    expect(defaultDates({ default_dates: ["2026-10-05", "2026-10-06"] } as Source))
      .toEqual(["2026-10-05", "2026-10-06"]);
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    expect(defaultDates({} as Source)).toEqual([today]);
    expect(defaultDates({ default_dates: "next_week" } as Source)).toEqual(nextWeekDates());
    // 提交的配置用的就是具名表达式
    expect(defaultDates(flights())).toEqual(nextWeekDates());
  });
});

/* ---------------------------------------------------------------- 配置驱动的 URL */

describe("url_for / date_params 完全由配置驱动", () => {
  it("H5 线路页：day-N = 目标日期 − 今天", () => {
    const cfg = flights();
    expect(urlFor(cfg, "2026-10-05", "2026-10-02")).toMatch(/kmg-bjs-day-3\.html$/);
    expect(urlFor(cfg, "2026-10-09", "2026-10-02")).toMatch(/kmg-bjs-day-7\.html$/);
    expect(dateParams(cfg, "2026-10-05", "2026-10-02")).toMatchObject({ dcity: "kmg", acity: "bjs", n: 3 });
  });

  it("酒店页：date / date+1day 与 constants 合并", () => {
    const p = dateParams(hotels(), "2026-10-09", "2026-10-02");
    expect(p).toMatchObject({ city: 1, checkin: "2026-10-09", checkout: "2026-10-10" });
    expect(urlFor(hotels(), "2026-10-09", "2026-10-02")).toContain("checkin=2026-10-09");
  });

  it("模板缺参数时报错（不会静默产出错 URL）", () => {
    const cfg = clone(flights());
    delete cfg.constants!.dcity;
    expect(() => urlFor(cfg, "2026-10-05", "2026-10-02")).toThrowError(
      "url_template needs a value for 'dcity' (add it to constants/date.params)");
  });
});

/* ---------------------------------------------------------------- 筛选与选优 */

describe("in_window / matches / select_best", () => {
  const src = { filters: { time_field: "dep", window: ["08:00", "18:00"] } } as Source;
  const rows = [
    { flight_no: "A", dep: "07:30", stops: 0, price: 900 },
    { flight_no: "B", dep: "09:30", stops: 1, price: 700 },
    { flight_no: "C", dep: "18:00", stops: 0, price: 1200 },
    { flight_no: "D", dep: "18:30", stops: 0, price: 300 },
    { flight_no: "E", dep: "12:00", stops: 0, price: 700 },
    { flight_no: "F", dep: "", stops: 0, price: 500 },
    { flight_no: "G", dep: "10:00", stops: 2, price: null },
  ];

  it("闭区间，缺时刻不算", () => {
    expect(inWindow("08:00", "08:00", "18:00")).toBe(true);
    expect(inWindow("18:00", "08:00", "18:00")).toBe(true);
    expect(inWindow("07:59", "08:00", "18:00")).toBe(false);
    expect(inWindow("18:01", "08:00", "18:00")).toBe(false);
    expect(inWindow("", "08:00", "18:00")).toBe(false);
    expect(inWindow(null, "08:00", "18:00")).toBe(false);
  });

  it("matches 走 Python str() 相等口径", () => {
    expect(matches({ stops: 0 }, { stops: 0 })).toBe(true);
    expect(matches({ stops: 1 }, { stops: 0 })).toBe(false);
    expect(matches({ stops: null }, { stops: 0 })).toBe(false);
    expect(matches({ a: "1150" }, { a: 1150 })).toBe(true);
    expect(matches({ a: 1 }, {})).toBe(true);
    expect(matches({ a: 1 }, null)).toBe(true);
  });

  it("select_best：窗口内按 sort_by 排序，同价取更早起飞；ignore_window 放开窗口", () => {
    expect(selectBest(rows, src, { sort_by: ["price", "dep"] })!.flight_no).toBe("B");
    expect(selectBest(rows, src, { sort_by: ["price", "dep"], where: { stops: 0 } })!.flight_no).toBe("E");
    expect(selectBest(rows, src, { sort_by: ["price", "dep"], ignore_window: true })!.flight_no).toBe("D");
    expect(selectBest(rows, src, { sort_by: ["price", "dep"], where: { stops: 9 } })).toBeNull();
    // 缺失/None 的 price 用 1<<30 兜底，不会因为 None 炸掉
    expect(selectBest([{ flight_no: "G", price: null }, { flight_no: "H", price: 10 }],
      { filters: {} } as Source, { sort_by: ["price"] })!.flight_no).toBe("H");
  });

  it("缺 filters 时默认窗口 [00:00,23:59] 与默认 sort_by=[price]", () => {
    expect(selectBest([{ price: 5 }, { price: 1 }], { filters: {} } as Source, {})).toEqual({ price: 1 });
    expect(selectBest([], src, {})).toBeNull();
  });

  it("count_rows / audit_rows 按配置计数", () => {
    expect(countRows(rows, src, {})).toBe(4);                       // 窗口内 4 条
    expect(countRows(rows, src, { ignore_window: true })).toBe(7);
    expect(countRows(rows, src, { where: { stops: 0 } })).toBe(2);
    expect(auditRows(rows, { field: "price", empty: true })).toBe(1);
    expect(auditRows(rows, { field: "stops", equals: 0 })).toBe(5); // str(0) == str(0)
    expect(countRows(rows, src, { where: { stops: 0 }, ignore_window: true })).toBe(5);
  });
});

/* ---------------------------------------------------------------- 真实夹具 */

describe("真实夹具（从真实抓取裁剪）", () => {
  it("H5 线路页：6 条真实票价，字段/联程/跨天都对", () => {
    const cfg = flights();
    const page = extract(fs.readFileSync(FLIGHTS_FIXTURE, "utf-8"), cfg);
    expect(page.date).toBe("2026-10-05");
    expect(page.strip).toEqual(["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(page.rows).toHaveLength(6);
    const byNo = new Map(page.rows.map((r) => [String(r.flight_no), r]));
    expect(byNo.get("CA4171")).toMatchObject({
      dep: "07:00", price: 1150, stops: 0, airline: "中国国航",
    });
    // 联程票：航班号用 + 连接；跨天到达标 +1
    expect(byNo.get("MU5749+MU2012")!.stops).toBe(1);
    expect(String(byNo.get("CZ6160")!.arr).endsWith("+1")).toBe(true);
    // 行里不能有 undefined（否则 JSON/报告会静默丢字段）
    for (const r of page.rows) for (const v of Object.values(r)) expect(v).not.toBeUndefined();
    // 用例口径：时段内 + 最低价
    expect(countRows(page.rows, cfg, cfg.counts![0])).toBe(4);
    expect(countRows(page.rows, cfg, cfg.counts![1])).toBe(3);
    expect(selectBest(page.rows, cfg, cfg.selects![0])!.flight_no).toBe("MU5749+MU2012");
    expect(selectBest(page.rows, cfg, cfg.selects![1])!.stops).toBe(0);
  });

  it("酒店页：同一引擎抽到酒店名/星级/评分，但价格为空（价格需登录）", () => {
    const cfg = hotels();
    const page = extract(fs.readFileSync(HOTELS_FIXTURE, "utf-8"), cfg);
    expect(page.rows).toHaveLength(3);
    expect(page.rows[0]!.name).toBe("麗枫酒店(北京国贸四惠地铁站店)");
    expect(page.rows[0]!.star).toBe("3");
    expect(page.rows[0]!.score).toBe("4.8");
    expect(page.rows.every((r) => r.price === "")).toBe(true);
    expect(auditRows(page.rows, cfg.audits![0])).toBe(3);     // 3/3 价格为空
    expect(countRows(page.rows, cfg, cfg.counts![0])).toBe(3); // counts 用 ignore_window
  });
});

/* ---------------------------------------------------------------- 源目录发现 */

describe("源配置是发现制（不是硬编码目录表）", () => {
  it("sourceDirs 扫到 <repo>/*/sources；loadSource/listSources 支持显式目录", () => {
    expect(sourceDirs().some((d) => d.endsWith(path.join("ctrip", "sources")))).toBe(true);
    const dir = path.join(REPO, "ctrip", "sources");
    expect(listSources([dir]).map(([n]) => n)).toEqual(["ctrip-flights-h5", "ctrip-hotels-pc"]);
    const all = listSources().map(([n]) => n);
    expect(all).toContain("ctrip-flights-h5");
    expect(all).toContain("ctrip-hotels-pc");
    // 裸名与显式路径都接受
    expect(loadSource("ctrip-flights-h5").name).toBe("ctrip-flights-h5");
    expect(loadSource(path.join(dir, "ctrip-hotels-pc.json")).name).toBe("ctrip-hotels-pc");
    expect(() => loadSource("no-such-source-xyz")).toThrowError(FileNotFoundError);
  });
});

/* ---------------------------------------------------------------- 跨实现语料护栏 */

const corpus = JSON.parse(
  fs.readFileSync(path.join(here, "..", "tools", "datasource-corpus.json"), "utf-8"),
) as any;

/** 规范化深比较（对象键排序；null/undefined 等价）。 */
function canon(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

function exactThrow(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "<no error>";
}

describe("跨实现对拍（Python 引擎生成的语料）", () => {
  const E = corpus.engine;

  it("路径语言 / 算子 / field_value 逐项一致", () => {
    for (const c of E.resolve) expect(canon(resolve(c.obj, c.path)), c.path).toBe(canon(c.expected));
    for (const c of E.apply_ops) {
      expect(canon(applyOps(c.value, c.ops)), JSON.stringify(c.ops)).toBe(canon(c.expected));
    }
    for (const c of E.field_value) expect(canon(fieldValue(c.row, c.spec))).toBe(canon(c.expected));
  });

  it("算子/日期表达式的报错文案逐字一致", () => {
    for (const c of E.apply_ops_errors) expect(exactThrow(() => applyOps(c.value, c.ops))).toBe(c.error);
    for (const c of E.date_expr_errors) {
      expect(exactThrow(() => dateExpr(c.expr, c.date, c.today))).toBe(c.error);
    }
  });

  it("日期表达式 / next_week_dates / default_dates(列表) 一致", () => {
    for (const c of E.date_expr) expect(canon(dateExpr(c.expr, c.date, c.today)), c.expr).toBe(canon(c.expected));
    for (const c of E.next_week_dates) expect(canon(nextWeekDates(c.today)), c.today).toBe(canon(c.expected));
    for (const c of E.default_dates) expect(canon(defaultDates(c.source))).toBe(canon(c.expected));
  });

  it("in_window / matches / blocked / select_best / count_rows / audit_rows 一致", () => {
    for (const c of E.in_window) expect(inWindow(c.t, c.lo, c.hi), `${c.t} in [${c.lo},${c.hi}]`).toBe(c.expected);
    for (const c of E.matches) expect(matches(c.row, c.where)).toBe(c.expected);
    for (const c of E.blocked) expect(blocked(c.source, c.code, c.body), `code=${c.code}`).toBe(c.expected);
    for (const c of E.select_best) {
      expect(canon(selectBest(c.rows, c.source, c.sel)), JSON.stringify(c.sel)).toBe(canon(c.expected));
    }
    for (const c of E.count_rows) expect(countRows(c.rows, c.source, c.spec)).toBe(c.expected);
    for (const c of E.audit_rows) expect(auditRows(c.rows, c.spec)).toBe(c.expected);
  });

  it("validate_source 对 21 份配置逐条问题一致（含文案与顺序）", () => {
    for (const c of E.validate) expect(validateSource(c.source), c.name).toEqual(c.expected);
  });

  it("两个真实 source 配置：url / date_params / extract / counts / audits / selects 一致", () => {
    for (const sc of corpus.sources) {
      const cfg = sc.config as Source;
      const html = fs.readFileSync(path.join(REPO, sc.fixture), "utf-8");
      for (const u of sc.url_for) expect(urlFor(cfg, u.date, sc.today), `${sc.name} url ${u.date}`).toBe(u.url);
      for (const dp of sc.date_params) {
        expect(canon(dateParams(cfg, dp.date, sc.today)), `${sc.name} params ${dp.date}`).toBe(canon(dp.params));
      }
      const page = extract(html, cfg);
      const first = sc.pages[0];
      expect(canon(page.date), `${sc.name} page.date`).toBe(canon(first.page_date));
      expect(canon(page.strip), `${sc.name} page.strip`).toBe(canon(first.strip));
      expect(page.rows.length, `${sc.name} rows`).toBe(first.rows_count);
      expect(canon(page.rows), `${sc.name} rows`).toBe(canon(first.rows));
      for (const p of sc.pages) {
        const counts: Record<string, number> = {};
        for (const c of (cfg.counts || [])) counts[String(c.key)] = countRows(page.rows, cfg, c);
        const audits: Record<string, number> = {};
        for (const a of (cfg.audits || [])) audits[String(a.key)] = auditRows(page.rows, a);
        const selects: Record<string, unknown> = {};
        for (const s of (cfg.selects || [])) selects[String(s.key)] = selectBest(page.rows, cfg, s);
        expect(canon(counts), `${sc.name} counts ${p.date}`).toBe(canon(p.counts));
        expect(canon(audits), `${sc.name} audits ${p.date}`).toBe(canon(p.audits));
        expect(canon(selects), `${sc.name} selects ${p.date}`).toBe(canon(p.selects));
      }
    }
  });

  it("report_markdown 全文逐字符一致（含表格、跨日期结论、预览、说明）", () => {
    for (const sc of corpus.sources) {
      const cfg = sc.config as Source;
      const html = fs.readFileSync(path.join(REPO, sc.fixture), "utf-8");
      const page = extract(html, cfg);
      const perDate: Record<string, Record<string, unknown>> = {};
      for (const p of sc.pages) {
        const counts: Record<string, number> = {};
        for (const c of (cfg.counts || [])) counts[String(c.key)] = countRows(page.rows, cfg, c);
        const audits: Record<string, number> = {};
        for (const a of (cfg.audits || [])) audits[String(a.key)] = auditRows(page.rows, a);
        const selects: Record<string, unknown> = {};
        for (const s of (cfg.selects || [])) selects[String(s.key)] = selectBest(page.rows, cfg, s);
        perDate[p.date] = { rows: page.rows, counts, audits, selects };
      }
      expect(reportMarkdown(cfg, perDate as never), sc.name).toBe(sc.report_markdown);
      // --render 报告段（elements/title[:60]/snapshot[:700]）也用确定性输入对齐
      expect(reportMarkdown(cfg, perDate as never, corpus.fake_rendered), `${sc.name} rendered`)
        .toBe(sc.report_markdown_rendered);
    }
  });

  it("报告段：渲染验证小节按 title[:60] / snapshot[:700] 截断", () => {
    expect(corpus.fake_rendered.title.length).toBeGreaterThan(60);
    expect(corpus.fake_rendered.snapshot.length).toBeGreaterThan(700);
    expect(corpus.sources[0].report_markdown_rendered).toContain("## 渲染验证：执行器看得到真实 DOM");
    expect(corpus.sources[0].report_markdown_rendered).toContain("**29** 个可交互元素");
  });
});

/* ---------------------------------------------------------------- CLI（离线路径） */

describe("main() CLI（不碰网络的分支）", () => {
  it("--list / 无参数：列出所有发现的 source 并返回 0", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      expect(await main(["--list"])).toBe(0);
      expect(await main([])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const text = lines.join("\n");
    expect(text).toContain("ctrip-flights-h5");
    expect(text).toContain("ctrip-hotels-pc");
  });

  it("找不到的 source 返回 2；坏配置在加载时返回 2（不发请求）", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ds-sources-"));
    try {
      expect(await main(["--source", "no-such-source-xyz"])).toBe(2);
      fs.writeFileSync(path.join(tmp, "broken.json"), JSON.stringify({
        name: "broken",
        transport: { client: "wget", url_template: "https://example.invalid/{x}" },
        extract: { kind: "magic", fields: { a: "b|sqrtt" } },
      }), "utf-8");
      expect(await main(["--source", "broken", "--sources-dir", tmp])).toBe(2);
    } finally {
      spy.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    const text = lines.join("\n");
    expect(text).toContain("配置有问题：");
    expect(text).toContain("transport.client must be one of ('curl', 'httpx')");
    expect(text).toContain("extract.kind must be one of ('json_in_script', 'html_regex')");
  });

  it("端到端（本地 http 服务，httpx 通道）：counts/selects/audits + json + md + save-raw，被挡日期记 error", async () => {
    const page = [
      '<div data-id="1"><span class="name">甲酒店</span></div>',
      '<div data-id="2"><span class="name">乙酒店</span></div>',
    ].join("");
    const server = http.createServer((req, res) => {
      const blocked = (req.url || "").includes("d=2026-10-06");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(blocked ? "<html>whaleguard block</html>" : page);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ds-e2e-"));
    const out = path.join(tmp, "results");
    const raw = path.join(tmp, "raw");
    try {
      fs.writeFileSync(path.join(tmp, "local-test.json"), JSON.stringify({
        name: "local-test",
        label: "本地夹具",
        transport: {
          client: "httpx",
          url_template: `http://127.0.0.1:${port}/list?d={d}`,
          note: "本地服务，只为端到端跑通引擎",
          block_markers: ["whaleguard"],
        },
        date: { params: { d: "date" } },
        extract: {
          kind: "html_regex",
          split: 'data-id="',
          fields: { id: "^(\\d+)", name: 'name">([^<]+)' },
        },
        counts: [{ key: "hotels", label: "酒店数", ignore_window: true }],
        audits: [{ key: "empty_name", label: "名字为空", field: "name", empty: true }],
        selects: [{ key: "best", label: "第一个", sort_by: ["id"] }],
        report: {
          title: "本地端到端",
          preview: { columns: ["id", "name"], limit: 2 },
          notes: ["离线"],
        },
      }), "utf-8");

      const code = await main(["--source", "local-test", "--sources-dir", tmp,
        "--dates", "2026-10-05", "2026-10-06", "--out", out, "--save-raw", raw]);
      expect(code).toBe(0);                                   // 至少一天有行

      const res = JSON.parse(fs.readFileSync(path.join(out, "local-test.json"), "utf-8"));
      expect(res.source).toBe("local-test");
      expect(res.dates["2026-10-05"].counts).toEqual({ hotels: 2 });
      expect(res.dates["2026-10-05"].audits).toEqual({ empty_name: 0 });
      expect(res.dates["2026-10-05"].selects.best).toMatchObject({ id: "1", name: "甲酒店" });
      expect(res.dates["2026-10-05"].rows).toHaveLength(2);
      // 被 block_markers 命中的那天：记 error，不进报告
      expect(res.dates["2026-10-06"].error).toBe("HTTP 200");
      expect(res.dates["2026-10-06"].rows).toBeUndefined();

      const md = fs.readFileSync(path.join(out, "local-test.md"), "utf-8");
      expect(md).toContain("# 本地端到端");
      expect(md).toContain("| 2026-10-05 | 2 |");
      expect(md).not.toContain("2026-10-06");
      // 报告跟着 source 走：只写了抓到的第一页
      expect(fs.readdirSync(raw)).toEqual(["local-test-2026-10-05.html"]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
