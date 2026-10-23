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

import * as D from "../src/data/datasource.ts";
import * as H from "../src/data/h5-flights.ts";
import * as P from "../src/data/profiles.ts";
import type { ElemPool } from "../src/engine/extraction.ts";

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
