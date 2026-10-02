/**
 * 网络/探针工具的 TS 离线测试 —— 对应 `ctrip/test_ctrip.py` 的
 * "线上抓取工具"/"真实 H5 线路页" 两节，外加两条 Python 版没有的护栏：
 *
 *  1. **判决可离线重算**：`live-probe` 与 `ota-probe` 的 verdict 是纯函数，测试直接
 *     读**已提交**的 `ctrip/results/live_probe.json` / `transfer/results/ota_probe.json`
 *     的原始观测，重算 verdict 并要求与提交值逐字段相等。这证明 TS 判决与 Python
 *     判决在真实观测上一致，而不需要打真实站点。
 *  2. **登录重定向 ≠ captured**：`live-capture` 的四种判决里，被跳到
 *     `passport.ctrip.com/user/login` 的页面必须判 `login_required`（CLAUDE.md 记的
 *     第一版教训），用假 page 复现。
 *
 * **本文件不发任何真实网络请求**：传输在需要时全部注入成假函数。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import * as D from "../src/datasource.ts";
import * as H from "../src/h5-flights.ts";
import * as LC from "../src/live-capture.ts";
import * as LP from "../src/live-probe.ts";
import * as OTA from "../src/ota-probe.ts";
import * as P from "../src/profiles.ts";
import type { ElemPool } from "../src/extraction.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..");
const H5_FIXTURE = path.join(REPO, "bench", "fixtures", "ctrip_h5_route.html");
const LIVE_PROBE = path.join(REPO, "ctrip", "results", "live_probe.json");
const LIVE_CAPTURE = path.join(REPO, "ctrip", "results", "live_capture", "summary.json");
const OTA_PROBE = path.join(REPO, "transfer", "results", "ota_probe.json");

const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, "utf-8"));

const tmpDirs: string[] = [];
function tmpdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "probes-test-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/* ================================================================ H5 线路页 */

describe("h5-flights：真实夹具（离线解析）", () => {
  const html = (): string => fs.readFileSync(H5_FIXTURE, "utf-8");

  it("解析出真实票价：日期 / 可点日期条 / 6 条航班行", () => {
    const page = H.parsePage(html());
    expect(page.date).toBe("2026-10-05");
    expect(page.strip).toEqual(["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]);
    const rows = page.itineraries;
    expect(rows).toHaveLength(6);
    const byNo = new Map(rows.map((r) => [String(r["flight_no"]), r]));
    expect(byNo.get("CA4171")).toMatchObject({
      dep: "07:00", price: 1150, stops: 0, airline: "中国国航",
    });
    // 联程票：航班号用 + 连接，跨天到达标 +1
    expect(byNo.get("MU5749+MU2012")!["stops"]).toBe(1);
    expect(String(byNo.get("CZ6160")!["arr"]).endsWith("+1")).toBe(true);
  });

  it("配置驱动：与引擎 datasource.extract 逐字段一致", () => {
    const cfg = H.source();
    const engine = D.extract(html(), cfg);
    const page = H.parsePage(html());
    expect(page.itineraries).toEqual(engine.rows);
    expect(cfg["name"]).toBe("ctrip-flights-h5");
  });

  it("窗口筛选是闭区间，最低价按 price/dep 排序", () => {
    const rows = H.parsePage(html()).itineraries;
    expect(H.inWindow("08:00")).toBe(true);
    expect(H.inWindow("18:00")).toBe(true);            // 闭区间
    expect(H.inWindow("07:59")).toBe(false);
    expect(H.inWindow("18:01")).toBe(false);
    expect(H.inWindow("")).toBe(false);                // 缺时刻不算
    const best = H.lowest(rows)!;
    expect(best["flight_no"]).toBe("MU5749+MU2012");
    expect(best["price"]).toBe(1264);
    const ns = H.lowest(rows, H.WINDOW[0], H.WINDOW[1], true)!;
    expect(ns["stops"]).toBe(0);
    expect(Number(ns["price"])).toBeGreaterThanOrEqual(1150);
    expect(H.inWindow(ns["dep"])).toBe(true);
  });

  it("day-N = 目标日期 − 今天（配置里的 day_offset）", () => {
    const [url, n] = H.dayUrl("2026-10-05", "2026-10-02");
    expect(n).toBe(3);
    expect(url.endsWith("kmg-bjs-day-3.html")).toBe(true);
    expect(H.dayUrl("2026-10-09", "2026-10-02")[1]).toBe(7);
    // 城市可被覆盖（内存里改配置，不落盘）
    expect(H.dayUrl("2026-10-05", "2026-10-02", "sha", "ctu")[0]).toContain("sha-ctu-day-3.html");
  });

  it("被风控/空壳正文必须大声报错，绝不静默返回空列表", () => {
    expect(() => H.parsePage("whaleguard block")).toThrow(D.ValueError);
    expect(() => H.parsePage("whaleguard block")).toThrow(/__INITIAL_STATE__/);
    expect(() => H.parsePage("<html><body>nothing here</body></html>")).toThrow(D.ValueError);
    // 状态码 200 的空壳：抽得到 var 但 0 行 —— 这条是 TS 版新增的护栏
    const emptyShell = '<script>window.__INITIAL_STATE__={"listData":{"ddate":"2026-10-05","flights":[]}};</script>';
    expect(() => H.parsePage(emptyShell)).toThrow(/parsed 0 itineraries/);
  });

  it("CLI 开关：--dates / --window / --render / --save-raw / --help", async () => {
    expect(H.parseArgv(["--dates", "2026-10-05", "2026-10-06", "--window", "06:00", "12:00", "--render"]))
      .toMatchObject({
        dates: ["2026-10-05", "2026-10-06"], window: ["06:00", "12:00"], render: true, saveRaw: null,
      });
    expect(H.parseArgv(["--save-raw", "/tmp/raw"]).saveRaw).toBe("/tmp/raw");
    expect(H.parseArgv(["--window=06:00,12:00"]).window).toEqual(["06:00", "12:00"]);
    expect(() => H.parseArgv(["--bogus"])).toThrow(/unrecognized argument/);
    expect(await H.main(["--help"])).toBe(0);           // --help 不碰网络
  });
});

/* ================================================================ live-probe */

describe("live-probe：判决是纯函数（离线重算已提交结果）", () => {
  const committed = (): any => readJson(LIVE_PROBE);

  it("用已提交的原始观测重算 verdict，必须与提交值全等", () => {
    const p = committed();
    const recomputed = LP.verdictOf(p.http, p.browser, p.flight_alt_shapes, p.mobile_and_regional);
    expect(recomputed).toEqual(p.verdict);
  });

  it("结构与关键结论：3 客户端 × 6 目标、8 个手机/区域组合全 432", () => {
    const p = committed();
    expect(Object.keys(p)).toEqual(expect.arrayContaining([
      "checked_at", "mobile_flight_repeat_status", "flight_alt_shapes",
      "mobile_and_regional", "environment", "http", "browser", "verdict",
    ]));
    expect(Object.keys(p.http)).toEqual([
      "flight_list_cn", "flight_mobile_cn", "flight_trip_com",
      "flight_api_retired", "hotel_list_cn", "hotel_home_cn",
    ]);
    for (const rows of Object.values(p.http) as Array<LP.ProbeRecord[]>) {
      expect(rows.map((r) => String(r["ua"]).slice(0, 5))).toEqual(["curl-", "httpx", "httpx"]);
    }
    expect(p.mobile_and_regional).toHaveLength(8);      // 2 UA × 4 目标
    expect(p.mobile_and_regional.every((m: LP.ProbeRecord) => m["status"] === 432)).toBe(true);
    expect(p.verdict.flight_search).toBe("BLOCKED");
    expect(p.verdict.hotel_price).toBe("LOGIN_REQUIRED");
    expect(p.verdict.flight_alt_shapes_all_432).toBe(true);
    expect(p.verdict.mobile_and_regional_all_432).toBe(true);
    expect(p.verdict.usable_for_case).toBe(false);
    // 真实可拿到的只有酒店名/星级（SSR），价格在登录墙后
    expect(p.verdict.real_data_available.hotel_names.length).toBeGreaterThan(0);
    expect(p.verdict.real_data_available.hotel_total_tip).toBe("6245");
  });

  it("_shape 把一次抓取压成可比较的形状", () => {
    const body = '<html><head><title>昆明到北京</title></head><body>'
      + "whaleguard block <span class=\"hotelName\">全季酒店</span></span>"
      + '找到6245家酒店 <div class="price-line"></div> ¥1,150</body></html>';
    const s = LP.shape("curl-cli", 200, body, 0.53, "https://x/");
    expect(s["ua"]).toBe("curl-cli");
    expect(s["status"]).toBe(200);
    expect(s["bytes"]).toBe(body.length);
    expect(s["secs"]).toBe(0.5);
    expect(s["title"]).toBe("昆明到北京");
    expect(s["whaleguard"]).toBe(true);
    expect(s["challenge"]).toBe(false);
    expect(s["flight_rows"]).toBe(0);
    expect(s["empty_price_nodes"]).toBe(1);
    expect(s["hotel_names_sample"]).toEqual(["全季酒店"]);
    expect(s["hotel_total_tip"]).toBe("6245");
    expect(s["login_wall"]).toBe(false);
    expect(s["final_url"]).toBe("https://x/");
    expect(s["prices_yen"]).toContain("¥1,150");
  });

  it("判决只看观测：whaleguard 200/432 都判 BLOCKED，酒店登录墙判 LOGIN_REQUIRED", () => {
    const rec = (ua: string, extra: LP.ProbeRecord): LP.ProbeRecord => ({ ua, ...extra });
    const http = {
      flight_list_cn: [
        rec("curl-cli", { status: 200, bytes: 621910, flight_rows: 0 }),
        rec("httpx-普通UA", { status: 432, whaleguard: true, bytes: 17 }),
        rec("httpx-浏览器UA", { status: 432, whaleguard: true, bytes: 17 }),
      ],
      flight_trip_com: [rec("httpx-浏览器UA", { status: 200, challenge: true })],
      flight_api_retired: [rec("curl-cli", { status: 200, body_head: "接口下线", bytes: 40 })],
      hotel_list_cn: [rec("curl-cli", { status: 200, login_wall: true, hotel_cards: 23, empty_price_nodes: 5,
        hotel_names_sample: ["全季酒店"], hotel_total_tip: "6245" })],
    };
    const browser = [{ key: "flight_list_cn", status: 432, whaleguard: true }];
    const alts = LP.ALT_SHAPES.map(() => ({ status: 432 }));
    const mobile = [{ status: 432 }, { status: 432 }];
    const v = LP.verdictOf(http, browser, alts, mobile);
    expect(v.flight_search).toBe("BLOCKED");
    expect(v.flight_reason).toContain("621910 B");
    expect(v.flight_reason).toContain("接口下线");
    expect(v.hotel_price).toBe("LOGIN_REQUIRED");
    expect(v.flight_alt_shapes_all_432).toBe(true);
    expect(v.mobile_and_regional_all_432).toBe(true);
  });

  it("CLI：--help 不碰网络；离线注入传输也能跑完整 main 并写 JSON", async () => {
    expect(await LP.main(["--help"])).toBe(0);
    const out = path.join(tmpdir(), "live_probe.json");
    const fakeCurl: LP.ProbeRecord = {
      ua: "curl-cli", status: 432, bytes: 17, whaleguard: true, challenge: false,
      flight_rows: 0, body_head: "whaleguard block",
    };
    const deps: LP.LiveProbeDeps = {
      curlProbe: () => ({ ...fakeCurl }),
      httpProbe: async (_url, ua) => ({
        ua: ua === LP.PLAIN_UA ? "httpx-普通UA" : "httpx-浏览器UA",
        status: 432, bytes: 17, whaleguard: true, challenge: false, flight_rows: 0,
        body_head: "whaleguard block",
      }),
      mobileProbe: async () => [{ ua: "iphone", status: 432, whaleguard: true }],
      browserProbe: async () => [{ key: "flight_list_cn", status: 432, whaleguard: true }],
      nextWeekDates: () => ["2026-10-05"],
    };
    expect(await LP.main(["--out", out], deps)).toBe(0);
    const payload = readJson(out);
    expect(Object.keys(payload.http)).toHaveLength(LP.TARGETS.length);
    expect(payload.verdict.flight_search).toBe("BLOCKED");
    expect(payload.mobile_flight_repeat_status).toEqual([432, 432, 432, 432, 432]);
    expect(payload.environment.browser_ua).toBe(LP.BROWSER_UA);
    expect(payload.environment.plain_ua).toBe(LP.PLAIN_UA);
    // PORT NOTE: Python 版写解释器版本，TS 版写 node 并保留 python=null
    expect(payload.environment.python).toBeNull();
    expect(payload.environment.node).toBe(process.versions.node);
  });
});

/* ================================================================ live-capture */

describe("live-capture：四种判决（纯函数 + 假 page）", () => {
  it("looks_blocked / looks_logged_out 的真值表", () => {
    expect(LC.looksBlocked(432, "whaleguard block")).toBe(true);
    expect(LC.looksBlocked(403, "")).toBe(true);
    expect(LC.looksBlocked(429, "")).toBe(true);
    expect(LC.looksBlocked(200, "Please verify that you are a real user")).toBe(true);
    expect(LC.looksBlocked(200, "<html><title>携程酒店</title>")).toBe(false);
    expect(LC.looksLoggedOut("登录以查看会员价")).toBe(true);
    expect(LC.looksLoggedOut("北京酒店")).toBe(false);
  });

  it("登录重定向 ≠ 抓到了", () => {
    expect(LC.looksLoginRedirect(
      "https://passport.ctrip.com/user/login?backurl=https%3A%2F%2Fhotels.ctrip.com%2Fhotels%2Flist", "")).toBe(true);
    expect(LC.looksLoginRedirect("https://hotels.ctrip.com/login?x=1", "")).toBe(true);
    expect(LC.looksLoginRedirect("https://hotels.ctrip.com/hotels/list", "登录首页")).toBe(true);
    expect(LC.looksLoginRedirect("https://hotels.ctrip.com/hotels/list", "北京酒店")).toBe(false);
  });

  it("verdictFor：captured / blocked / login_required / unreachable 四判决", () => {
    // 正常页 → captured
    expect(LC.verdictFor({
      status: 200, body: "<html><title>北京酒店</title>价格</html>",
      finalUrl: "https://hotels.ctrip.com/hotels/list?city=1", title: "北京酒店",
    })).toBe("captured");
    // 432 风控 → blocked
    expect(LC.verdictFor({ status: 432, body: "whaleguard block" })).toBe("blocked");
    // 200 但正文是挑战页 → blocked
    expect(LC.verdictFor({ status: 200, body: "Challenge Validation" })).toBe("blocked");
    // 重定向到登录页 → login_required，**不得**判 captured
    expect(LC.verdictFor({
      status: 200, body: "登录首页",
      finalUrl: "https://passport.ctrip.com/user/login?backurl=x", title: "登录首页",
    })).toBe("login_required");
    expect(LC.verdictFor({
      status: 200, body: "", finalUrl: "https://hotels.ctrip.com/login?x=1", title: "",
    })).toBe("login_required");
    // 异常 / 导航失败 → unreachable
    expect(LC.verdictFor({ error: new Error("net::ERR_NAME_NOT_RESOLVED") })).toBe("unreachable");
    // 顺序：blocked 压过 login_required（被挡的登录页仍是 blocked）
    expect(LC.verdictFor({
      status: 432, body: "whaleguard", finalUrl: "https://passport.ctrip.com/user/login",
    })).toBe("blocked");
  });

  it("targets 是用例真正需要的两个页面（次日离店）", () => {
    const tg = new Map(LC.targets("2026-10-05").map((t) => [t[0], t[2]]));
    expect([...tg.keys()]).toEqual(["flights", "hotels"]);
    expect(tg.get("flights")).toContain("flights.ctrip.com/online/list/oneway-kmg-bjs");
    expect(tg.get("flights")).toContain("depdate=2026-10-05");
    expect(tg.get("hotels")).toContain("hotels.ctrip.com/hotels/list");
    expect(tg.get("hotels")).toContain("checkin=2026/10/05");
    expect(tg.get("hotels")).toContain("checkout=2026/10/06");
    expect(LC.addDays("2026-10-31", 1)).toBe("2026-11-01");
  });

  it("capture_one：登录重定向假 page 判 login_required（第一版教训）", async () => {
    const page: LC.CapturePage = {
      url: () => "https://passport.ctrip.com/user/login?backurl=x",
      goto: async () => ({ status: () => 200 }),
      waitForTimeout: async () => {},
      evaluate: async () => "登录首页 账号密码登录",
      title: async () => "登录首页",
    };
    const rec = await LC.captureOne(page, "hotels", "酒店列表", "https://hotels.ctrip.com/hotels/list?city=1");
    expect(rec["verdict"]).toBe("login_required");
    expect(rec["elements"]).toBeUndefined();
    expect(rec["snapshot"]).toBeUndefined();
    expect(String(rec["evidence"])).toContain("passport.ctrip.com");
  });

  it("capture_one：导航异常判 unreachable（不抛栈）", async () => {
    const page: LC.CapturePage = {
      url: "https://flights.ctrip.com/online/list/oneway-kmg-bjs",
      goto: async () => { throw new Error("net::ERR_CONNECTION_RESET"); },
    };
    const rec = await LC.captureOne(page, "flights", "机票列表", "https://x/");
    expect(rec["verdict"]).toBe("unreachable");
    expect(String(rec["error"])).toContain("net::ERR_CONNECTION_RESET");
  });

  it("capture_one：能进的页面写出快照与元素 JSON（离线假 page + 临时目录）", async () => {
    const dir = tmpdir();
    const elems: ElemPool = { e1: { tag: "a", label: "机票" }, e2: { tag: "button", label: "搜索" } };
    const page: LC.CapturePage = {
      url: () => "https://hotels.ctrip.com/hotels/list?city=1",
      goto: async () => ({ status: () => 200 }),
      waitForTimeout: async () => {},
      evaluate: async () => "北京酒店 登录以查看会员价",
      title: async () => "北京酒店",
    };
    const rec = await LC.captureOne(page, "hotels", "酒店列表", "https://hotels.ctrip.com/hotels/list?city=1", false, {
      extractElements: async () => elems,
      snapshotText: (pool) => Object.keys(pool).join(","),
      pageText: async () => "页面文本",
      outDir: dir,
    });
    expect(rec["verdict"]).toBe("captured");
    expect(rec["elements"]).toBe(2);
    expect(rec["logged_out_hint"]).toBe(true);          // 价格在登录墙后
    expect(fs.existsSync(rec["snapshot"])).toBe(true);
    expect(fs.readFileSync(rec["snapshot"], "utf-8")).toContain("e1,e2");
    const raw = readJson(path.join(dir, "hotels.json"));
    expect(raw).toEqual([{ ref: "e1", tag: "a", label: "机票" }, { ref: "e2", tag: "button", label: "搜索" }]);
  });

  it("与已提交 summary.json 一致：0/2，机票 blocked、酒店 login_required", () => {
    const s = readJson(LIVE_CAPTURE);
    expect(s.captured).toBe(0);
    expect(s.total).toBe(2);
    expect(s.verdicts).toEqual({ flights: "blocked", hotels: "login_required" });
    // 用提交的原始观测重算每条判决
    for (const rec of s.results) {
      const recomputed = LC.verdictFor({
        status: rec.status,
        body: rec.evidence ?? "",                       // blocked 的正文证据
        finalUrl: rec.final_url,
        title: rec.title,
        error: rec.error,
      });
      expect(recomputed).toBe(rec.verdict);
    }
  });

  it("CLI：--only 只接受 flights/hotels；--help 不启动浏览器", async () => {
    expect(LC.parseArgv(["--date", "2026-10-08", "--only", "hotels", "--mobile"]))
      .toMatchObject({ date: "2026-10-08", only: "hotels", mobile: true, profile: null });
    expect(() => LC.parseArgv(["--only", "trains"])).toThrow(/invalid choice/);
    expect(() => LC.parseArgv(["--nope"])).toThrow(/unrecognized argument/);
    expect(await LC.main(["--help"])).toBe(0);
  });
});

/* ================================================================ ota-probe */

describe("ota-probe：候选站点枚举与判决（离线重算已提交结果）", () => {
  const committed = (): any => readJson(OTA_PROBE);

  it("枚举 8 家候选，key/URL 就是提交结果里的那些", () => {
    const p = committed();
    expect(OTA.TARGETS).toHaveLength(8);
    expect(OTA.TARGETS.map((t) => t[0])).toEqual(Object.keys(p.http));
    expect(OTA.TARGETS[0]![0]).toBe("qunar-flight");
    expect(OTA.TARGETS[0]![2]).toContain("flight.qunar.com/site/oneway_list.htm");
    expect(OTA.TARGETS[7]![0]).toBe("kayak-hotel");
  });

  it("用已提交的 http/browser_render 重算 verdict，必须与提交值全等", () => {
    const p = committed();
    expect(OTA.verdictOf(p.http, p.browser_render)).toEqual(p.verdict);
  });

  it("关键结论 + 值得渲染的目标 = 提交结果的前 3 个有内容的", () => {
    const p = committed();
    expect(p.verdict.anonymous_price_list_reachable).toBe(false);
    expect(p.verdict.usable_targets).toEqual([]);
    expect(p.verdict.reason).toContain("expedia-hotel 429/429（挑战页）");
    expect(OTA.worthTargets(p.http).map(([k]) => k))
      .toEqual(p.browser_render.map((r: OTA.ProbeRecord) => r["key"]));
    expect(p.browser_render.every((r: OTA.ProbeRecord) => r["prices"] === 0)).toBe(true);
  });

  it("_shape / priceTokens：价格记号与挑战页特征", () => {
    const body = '<html><head><title>Bot or Not</title></head><body>'
      + '请稍候 CN¥1,234 US$ 99 ¥300 —— 该服务停止提供</body></html>';
    const s = OTA.shape("curl-cli", 429, body, 1.06);
    expect(s["status"]).toBe(429);
    expect(s["bytes"]).toBe(body.length);
    expect(s["secs"]).toBe(1.1);
    expect(s["title"]).toBe("Bot or Not");
    expect(s["challenge"]).toBe(true);
    expect(s["discontinued_notice"]).toBe(true);
    expect(s["price_tokens"]).toBe(3);                  // CN¥1,234 / US$ 99 / ¥300
    expect(OTA.priceTokens("¥1,150 和 ￥ 300")).toEqual(["¥1,150", "￥ 300"]);
  });

  it("CLI：--help；离线注入传输也能跑 main 并写出 JSON", async () => {
    expect(await OTA.main(["--help"])).toBe(0);
    const out = path.join(tmpdir(), "ota_probe.json");
    const deps: OTA.OtaProbeDeps = {
      curlProbe: () => ({ ua: "curl-cli", status: 202, bytes: 0, price_tokens: 0, challenge: false }),
      httpxProbe: async () => ({ ua: "httpx-浏览器UA", status: 202, bytes: 0, price_tokens: 0, challenge: false }),
      browserRender: async (urls) => urls.map(([key]) => ({ key, status: 200, prices: 0 })),
    };
    expect(await OTA.main(["--out", out], deps)).toBe(0);
    const payload = readJson(out);
    expect(Object.keys(payload)).toEqual(["checked_at", "http", "browser_render", "verdict"]);
    expect(Object.keys(payload.http)).toHaveLength(OTA.TARGETS.length);
    expect(payload.verdict.anonymous_price_list_reachable).toBe(false);
    expect(payload.verdict.usable_targets).toEqual([]);
    expect(payload.verdict.reason).toContain("qunar-flight 202/202");
    expect(payload.browser_render).toEqual([]);         // 没有 >5000 B 的，不渲染
  });
});

/* ================================================================ profiles */

describe("profiles：站点清单只是「加载哪个 spec」", () => {
  it("ctrip / skybook 两份 spec 都能加载，PROFILES 就是这两个名字", () => {
    expect(Object.keys(P.PROFILES)).toEqual(["ctrip", "skybook"]);
    expect(P.PROFILES["ctrip"]).toBe(P.CTRIP);
    expect(P.PROFILES["skybook"]).toBe(P.SKYBOOK);
    expect(String(P.CTRIP._path).endsWith(path.join("specs", "ctrip.json"))).toBe(true);
    expect(String(P.SKYBOOK._path).endsWith(path.join("specs", "skybook.json"))).toBe(true);
    expect(P.CTRIP.phases.length).toBeGreaterThan(0);
    expect(P.SKYBOOK.site_dir).not.toBe(P.CTRIP.site_dir);
    expect(P.CTRIP.name).toBe("ctrip-replica");
    expect(P.SKYBOOK.name).toBe("skybook-replica2");
  });
});
