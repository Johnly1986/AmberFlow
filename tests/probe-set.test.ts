/**
 * 探针集测试 —— 站点知识从驱动搬进 `apps/<id>/pack.json` 之后，这条"数据驱动"的路必须被钉住：
 *
 *   1. 声明面：目标/标记/角色/重复次数都从数据来（驱动里一个主机名都没有）；
 *   2. 加载期校验：未知键、未知占位符、**URL 主机没在 `hosts` 里**（防泄漏门禁会漏掉它）都报错；
 *   3. 日期占位符：{date} / {date_slash} / {checkout} / {checkout_slash} 的纯日历语义；
 *   4. 债归零：`apps:matrix` 的债计数为空——包括"声明无关"的那一半（非核心层里写死的主机）。
 */
import { describe, expect, it } from "vitest";
import { fillProbeDate, addDays, hostOfUrl, listProbeSets, loadProbeSet, markerList, shortOf, validateProbeBlock } from "../src/app/probe-set.ts";
import { matrix } from "../tools/apps_matrix.ts";

const hosts = ["m.ctrip.com", "flights.ctrip.com", "hotels.ctrip.com", "passport.ctrip.com", "www.ctrip.com"];

describe("探针集：声明面（站点知识是数据，不是代码）", () => {
  it("apps/ctrip-live：目标 / 浏览器复验 / 重复 / 其它入口 / 手机模拟 / 抓取 / 角色 全部从数据来", () => {
    const s = loadProbeSet("ctrip-live");
    expect(s.app).toBe("ctrip-live");
    expect(s.http.map((t) => t.id)).toEqual([
      "flight_list_cn", "flight_mobile_cn", "flight_trip_com", "flight_api_retired",
      "hotel_list_cn", "hotel_home_cn"]);
    expect(s.browser).toEqual(["flight_list_cn", "flight_api_retired"]);
    expect(s.alts).toHaveLength(5);
    expect(s.mobile.map((t) => t.id)).toEqual([
      "ctrip-mobile-flight", "trip-hk-flight", "trip-us-flight", "trip-sg-flight"]);
    expect(s.capture.map((t) => t.id)).toEqual(["flights", "hotels"]);
    expect(s.repeat).toEqual({ id: "flight_mobile_cn", times: 5 });
    expect(s.roles["flight"]).toBe("flight_list_cn");
    // resultsDir 是给文件系统用的原生路径（Windows 带反斜杠），断言先归一化分隔符
    expect(s.resultsDir.split(/[\\/]/).join("/").endsWith("ctrip/results")).toBe(true);
    // 每个目标 URL 的主机都在 hosts 里（校验期也是这么要求的）
    for (const t of [...s.http, ...s.alts, ...s.mobile, ...s.capture, ...(s.home ? [s.home] : [])]) {
      expect(s.markers, t.id).toBeTruthy();
      expect(hostOfUrl(t.url), t.id).not.toBeNull();
    }
    // 判决文本用的短名也是数据（原来是写死的主机名）
    expect(shortOf(s, "flight_list_cn")).toBe("flights.ctrip.com");
    expect(shortOf(s, "hotel_list_cn")).toBe("hotels.ctrip.com");
    expect(shortOf(s, "flight_trip_com")).toBe("Trip.com");     // 品牌名，不是主机
    expect(markerList(s, "gate_text")).toEqual(["whaleguard"]);
    expect(markerList(s, "login_text").length).toBeGreaterThan(2);
  });

  it("发现制：三个探针集都在 apps/ 下被认出来（没有清单文件）", () => {
    const ids = listProbeSets().map(([id]) => id);
    expect(ids).toEqual(["ctrip-live", "ota-live", "qunar-live"]);
  });

  it("qunar-live：冻结计划也是数据（journey 里两步，驱动不再写 URL）", () => {
    const s = loadProbeSet("qunar-live");
    expect(s.http.map((t) => t.id)).toEqual(["qunar-flight-h5", "qunar-flight-list"]);
    expect(s.login.paths).toEqual(["passport.", "/login"]);
    expect(markerList(s, "block_text")).toContain("captcha");
  });

  it("ota-live：8 家候选站点 + 挑战页/下线公告/价格记号都是声明", () => {
    const s = loadProbeSet("ota-live");
    expect(s.http).toHaveLength(8);
    expect(markerList(s, "challenge_text")).toContain("Bot or Not");
    expect(markerList(s, "notice_text")).toEqual(["停止提供"]);
    expect(s.resultsDir.split(/[\\/]/).join("/").endsWith("transfer/results")).toBe(true);
  });
});

describe("探针集：加载期校验（坏数据响亮地失败）", () => {
  it.each([
    ["URL 主机没声明", { http: [{ id: "a", url: "https://not-declared.example/" }] },
      "is not declared in pack.hosts"],
    ["未知键", { nope: 1 }, "unknown key"],
    ["未知占位符", { http: [{ id: "a", url: "https://m.ctrip.com/x?d={tomorrow}" }] },
      "unknown placeholder {tomorrow}"],
    ["不是 http URL", { http: [{ id: "a", url: "file:///tmp/x" }] }, "not an http(s) URL"],
    ["目标缺 id", { http: [{ url: "https://m.ctrip.com/x" }] }, "target needs an id"],
    ["http 空列表", { http: [] }, "must be a non-empty list"],
    ["重复 id", { http: [{ id: "a", url: "https://m.ctrip.com/1" }, { id: "a", url: "https://m.ctrip.com/2" }] },
      "duplicate target ids"],
    ["browser 指向不存在的目标", { http: [{ id: "a", url: "https://m.ctrip.com/1" }], browser: ["b"] },
      "is not an http target id"],
    ["repeat 指向不存在的目标", { http: [{ id: "a", url: "https://m.ctrip.com/1" }], repeat: { id: "z", times: 2 } },
      "is not an http target id"],
    ["repeat.times 非正", { http: [{ id: "a", url: "https://m.ctrip.com/1" }], repeat: { id: "a", times: 0 } },
      "times must be a positive integer"],
    ["roles 指向不存在的目标", { http: [{ id: "a", url: "https://m.ctrip.com/1" }], roles: { flight: "b" } },
      "is not an http target id"],
    ["未知 marker", { markers: { magic_text: "x" } }, "unknown marker"],
    ["登录主机没声明", { login: { hosts: ["elsewhere.example"] } }, "is not declared in pack.hosts"],
    ["日期格式错", { date: "2026/10/05" }, "must be YYYY-MM-DD"],
  ])("%s", (_label, probe, snippet) => {
    expect(validateProbeBlock(probe, hosts).join(" | ")).toContain(snippet);
  });

  it("合法的探针块零问题（四类目标 + markers + login）", () => {
    expect(validateProbeBlock({
      date: "2026-10-05", results_dir: "x/results",
      http: [{ id: "a", label: "A", url: "https://m.ctrip.com/a?d={date}" }],
      browser: ["a"], repeat: { id: "a", times: 3 }, roles: { flight: "a" },
      markers: { gate_text: ["whaleguard"], price_re: "\\d+" },
      login: { hosts: ["passport.ctrip.com"], paths: ["/login"], titles: ["登录首页"] },
    }, hosts)).toEqual([]);
  });

  it("加载不存在的探针集 -> 报错（不是静默返回空）", () => {
    expect(() => loadProbeSet("no-such-app")).toThrow(/not found/);
  });
});

describe("探针集：日期占位符", () => {
  it("四个占位符都是纯日历运算（不碰时钟）", () => {
    expect(fillProbeDate("https://m.ctrip.com/x?d={date}", "2026-10-05"))
      .toBe("https://m.ctrip.com/x?d=2026-10-05");
    expect(fillProbeDate("https://h/x?ci={date_slash}&co={checkout_slash}", "2026-10-05"))
      .toBe("https://h/x?ci=2026/10/05&co=2026/10/06");
    expect(fillProbeDate("https://h/x?co={checkout}", "2026-12-31")).toBe("https://h/x?co=2027-01-01");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");       // 平年
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");       // 闰年
    expect(() => addDays("2026/10/05", 1)).toThrow(/invalid ISO date/);
  });
});

describe("债归零：应用层纪律的终点线", () => {
  it("apps:matrix 的债计数为空（声明无关的写死主机也一并算）", () => {
    const { rows, leaks, debt } = matrix();
    expect(leaks).toEqual([]);
    expect(debt).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(9);
    // 探针应用也进矩阵：声明行数 > 0，代码行数 0（应用是数据）
    const probeApps = rows.filter((r) => ["ctrip-live", "ota-live", "qunar-live"].includes(r.app));
    expect(probeApps).toHaveLength(3);
    for (const r of probeApps) {
      expect(r.declared).toBeGreaterThan(40);
      expect(r.code).toBe(0);
      expect(r.tokens.length).toBeGreaterThan(0);   // 主机进了防泄漏清单
    }
    // 站点标识进了清单，而核心层一个都没有 => 那 5 个驱动已加入核心层
    const declared = new Set(rows.flatMap((r) => r.tokens));
    expect(declared.has("m.ctrip.com")).toBe(true);
    expect(declared.has("touch.qunar.com")).toBe(true);
    expect(declared.has("www.kayak.com")).toBe(true);
  });
});
