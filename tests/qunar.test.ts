/**
 * qunar migration test (offline half): the frozen plan, the four-item oracle and
 * the reachability verdicts. The live half is `src/qunar-task.ts` itself — its
 * measured boundary (touchInnerList code:1999) is data, not something a unit test
 * can re-derive offline.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HOME, buildChecks, buildPlan, renderReport, type QunarRecords } from "../src/qunar-task.ts";
import { IPHONE_UA, TARGET, looksBlocked, looksLoginRedirect, verdict } from "../src/qunar-probe.ts";
import { PlanningRules } from "../src/plan.ts";
import { REPO } from "../src/flow.ts";

describe("the frozen qunar plan", () => {
  const plan = buildPlan();

  it("is two clicks with URL signals, hints and retries (the ctrip shape)", () => {
    expect(plan.subgoals).toHaveLength(2);
    expect(plan.subgoals.map((s) => s.target_hint)).toEqual(["北京", "搜索"]);
    expect(plan.subgoals.map((s) => s.retries)).toEqual([2, 2]);
    expect(plan.subgoals.every((s) => s.start_url === HOME)).toBe(true);
    expect(plan.subgoals[0]!.signal).toEqual({ url_contains: "#cityselect" });
    expect(plan.subgoals[1]!.signal).toEqual({ url_contains: "ncs/page/flightlist?depCity=" });
  });

  it("passes the planner's own rules and writes under qunar/results", () => {
    expect(new PlanningRules(8).problems(plan)).toEqual([]);
    expect(plan.path).toBe(path.join(REPO, "qunar", "results", "qunar_plan.json"));
  });

  it("keeps the hints that make it rule-resolvable (zero model calls on step 1)", () => {
    expect(String(plan.goal)).toContain("北京→上海");
  });
});

describe("reachability verdicts (qunar-probe)", () => {
  it("classifies the four outcomes", () => {
    expect(verdict(TARGET, 0, "")).toBe("unreachable");
    expect(verdict(TARGET, 200, "whaleguard challenge")).toBe("blocked");
    expect(verdict(TARGET, 432, "anything")).toBe("blocked");
    expect(verdict("https://passport.qunar.com/user/login", 200, "请登录")).toBe("login_required");
    expect(verdict(TARGET, 200, "<html>搜索</html>")).toBe("captured");
  });

  it("checks blocked BEFORE login_required (the live_capture lesson)", () => {
    expect(verdict("https://passport.qunar.com/user/login", 200, "captcha")).toBe("blocked");
  });

  it("knows the bot-block markers", () => {
    expect(looksBlocked("Access Denied")).toBe(true);
    expect(looksBlocked("请稍候")).toBe(false);
    expect(looksLoginRedirect("https://x/login?next=/a", "")).toBe(true);
    expect(looksLoginRedirect(TARGET, "")).toBe(false);
  });

  it("uses an iPhone UA for the mobile H5 route", () => {
    expect(IPHONE_UA).toContain("iPhone");
  });
});

/** Records shaped like a successful run (what the live script should produce here). */
const goodRecords: QunarRecords = {
  home: { elements: 3 },
  subgoals: [
    {
      desc: "打开出发城市选择器", done: true, stop_reason: "dom goal signal", attempts: 1,
      final_url: `${HOME}#cityselect`, methods: ["rule:match"],
    },
    {
      desc: "点击搜索，跳转航班列表页", done: true, stop_reason: "dom goal signal", attempts: 1,
      final_url: "https://touch.qunar.com/ncs/page/flightlist?depCity=北京", methods: ["rule:match"],
    },
  ],
  api: [{ status: 200, body: '{"code":1999,"msg":"没有查询到符合条件的航班"}' }],
  list_direct: { api_seen: 1, no_flight_banner: true, elements: 0 },
};

describe("the four-item oracle", () => {
  it("passes when the skeleton ran AND the data boundary is reproduced", () => {
    const checks = buildChecks(goodRecords);
    expect(checks.map((c) => c.ok)).toEqual([true, true, true, true]);
    expect(checks.map((c) => c.what.length > 5)).toEqual([true, true, true, true]);
  });

  it("fails the skeleton check when laya (not a rule) had to pick the first target", () => {
    const rec: QunarRecords = {
      ...goodRecords,
      subgoals: [{ ...goodRecords.subgoals[0]!, methods: ["laya"] }, goodRecords.subgoals[1]!],
    };
    expect(buildChecks(rec)[0]!.ok).toBe(false);
  });

  it("fails the boundary check when the gate was never observed", () => {
    const rec: QunarRecords = { ...goodRecords, api: [], list_direct: { api_seen: 0 } };
    expect(buildChecks(rec)[3]!.ok).toBe(false);
  });

  it("accepts the no-flight banner as evidence even without a captured API body", () => {
    const rec: QunarRecords = { ...goodRecords, api: [], list_direct: { no_flight_banner: true } };
    expect(buildChecks(rec)[3]!.ok).toBe(true);
  });
});

describe("the report", () => {
  it("leads with the score and lists every check", () => {
    const checks = buildChecks(goodRecords);
    const md = renderReport(goodRecords, checks);
    expect(md).toContain("判分 **4/4**");
    for (const c of checks) expect(md).toContain(c.expected.slice(0, 12));
    expect(md).toContain("touchInnerList");
  });
});

describe("the Python run's recorded results still exist (the migration keeps its evidence)", () => {
  it("has qunar/results/QUNAR_RESULT.md", () => {
    expect(fs.existsSync(path.join(REPO, "qunar", "results", "QUNAR_RESULT.md"))).toBe(true);
  });
});
