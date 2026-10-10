/**
 * SemanticFlow M3 —— plan 端到端（goal + seed → 模板 + 站点档案 → 重放门控落盘）。
 * 钉住的红线与指标（docs/SEMANTIC_FLOW_TRANSFER_PLAN.md §4/§6/§7）：
 *   - 参数提取按中文句式（日期是城市的左边界——两个都被实测打过脸）；
 *   - 判据 = 观察 + 判别 + **两次独立演示可复现**；选不出来 = manual = 停，绝不放宽；
 *   - 归纳回来的信号里等于槽位值的字面量泛化成 {slot}（换 --slot 判据仍成立）；
 *   - plan 不写 hint（steps 恒空）——hint 属于运行期回填环；
 *   - 门控失败 = 不写文件；dangerous 步自动标注；
 *   - LLM 规划器 fail-closed（不像话的回答 = 停止规划）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractParams, generalizeQuery, generalizeSignalValues, goalRecipePlanner,
  llmFlowPlanner, pickInducedSignal, planFlow, templatePlanner,
  type PlanProposal, type PlanStepRequest,
} from "../src/plan-flow.ts";
import { loadTemplate, runFlow } from "../src/semantic-flow.ts";
import type { StateView } from "../src/signal-induction.ts";

const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "plan-flow-"));

const REQ: PlanStepRequest = {
  goal: "g", slots: {}, completed: [], url: "file:///x/index.html", title: "t", criteria: {},
};

/* ---------------------------------------------------------------- 参数提取 */

describe("extractParams — 中文句式的参数提取", () => {
  it("诉求原文：日期是城市的左边界（实测踩过 日昆明 / 上订一张昆明 两个坑）", () => {
    const p = extractParams("在携程上订一张5月18日昆明到北京价格最低的机票");
    expect(p.date_label).toBe("5月18日");
    expect(p.date_code).toBe("05-18");
    expect(p.date_label_en).toBe("May 18");
    expect(p.from).toBe("昆明");
    expect(p.to).toBe("北京");
    expect(p.cheapest).toBe(true);
    expect(p.buy).toBe(true);          // "订一张" 也是下单意图
  });

  it("显式 `从X到Y` 句式优先", () => {
    const p = extractParams("帮我查从昆明到北京5月20日的最低价航班");
    expect(p.from).toBe("昆明");
    expect(p.to).toBe("北京");
    expect(p.date_code).toBe("05-20");
  });

  it("没有购买词 = 不生成 dangerous 步", () => {
    expect(extractParams("看看5月18日昆明到北京航班的价格").buy).toBe(false);
  });

  it("配方规划器按意图裁剪步骤序列", () => {
    const planner = goalRecipePlanner("g", extractParams("在携程上订一张5月18日昆明到北京价格最低的机票"));
    const ids: string[] = [];
    for (;;) {
      const p = planner(REQ) as PlanProposal | null;
      if (p === null) break;
      ids.push(p.id);
      if (ids.length > 10) break;
    }
    expect(ids).toEqual(["open-flights", "submit-search", "pick-date", "pick-cheapest", "purchase"]);
    expect(planner(REQ)).toBeNull();
  });

  it("迁移规划器把模板步还原成提议（fills 的 word 用槽位名，靠词表桥接）", () => {
    const template = loadTemplate("flight-cheapest");
    const planner = templatePlanner(template);
    const first = planner(REQ) as { id: string; desc: string; targets: unknown[] };
    expect(first.id).toBe("open-flights");
    expect(first.desc).toBe(template.steps[0]!.desc);
    const search = planner(REQ) as { fills?: Array<{ slot: string; word: string }> };
    expect(search.fills).toEqual([{ slot: "from", word: "from" }, { slot: "to", word: "to" }]);
  });
});

/* ---------------------------------------------------------------- 泛化与归纳 */

describe("generalizeQuery / generalizeSignalValues — 值只来自数据袋", () => {
  const slots = { from: "昆明", to: "北京", date_code: "05-18" };

  it("查询参数按值对回槽位；对不上槽位的参数（订单号）不进模板", () => {
    const q = generalizeQuery(
      "file:///x/results.html?from=%E6%98%86%E6%98%8E&to=%E5%8C%97%E4%BA%AC&date=05-18&order=A1024", slots,
    );
    expect(q).toBe("from={from}&to={to}&date={date_code}");
  });

  it("信号里的槽位值（原样或 URL 编码）换成 {slot}", () => {
    const sig = generalizeSignalValues(
      { url_contains: "/results.html?from=%E6%98%86%E6%98%8E&date=05-18" }, slots,
    );
    expect(sig.url_contains).toBe("/results.html?from={from}&date={date_code}");
    const css = generalizeSignalValues({ css_text_equals: ["#state", "列表已更新 05-18"] }, slots);
    expect((css.css_text_equals as string[])[1]).toBe("列表已更新 {date_code}");
  });
});

describe("pickInducedSignal — 判别 + 复现，选不出来就 manual（不猜）", () => {
  const view = (u: string): StateView => ({ url: u, elems: {} });

  it("查询参数差分候选：date 参数新增且两次演示一致 → induced", () => {
    const runs: Array<[StateView, StateView]> = [
      [view("file:///x/results.html?from=A&to=B"), view("file:///x/results.html?from=A&to=B&date=05-18")],
      [view("file:///x/results.html?from=A&to=B"), view("file:///x/results.html?from=A&to=B&date=05-18")],
    ];
    const s = pickInducedSignal(runs, "results", "results.html");
    expect(s.kind).toBe("induced");
    expect(JSON.stringify(s.signal)).toContain("date=05-18");
  });

  it("什么都没变 → manual（调用方据此停止规划）", () => {
    const runs: Array<[StateView, StateView]> = [
      [view("file:///x/p.html"), view("file:///x/p.html")],
      [view("file:///x/p.html"), view("file:///x/p.html")],
    ];
    const s = pickInducedSignal(runs, "purchase", "p.html");
    expect(s.kind).toBe("manual");
    expect(s.signal).toEqual({ manual: true });
  });

  it("页名变化但不复现（第二次演示落到不同 query）→ 只采纳两跑都成立的那部分", () => {
    const runs: Array<[StateView, StateView]> = [
      [view("file:///x/a.html"), view("file:///x/b.html?k=1")],
      [view("file:///x/a.html"), view("file:///x/b.html?k=2")],
    ];
    const s = pickInducedSignal(runs, "b", "b.html");
    // 判别且可复现的是页名本身；k=1/k=2 两次不同 → 不进判据。
    expect(s.kind).toBe("induced");
    expect(s.signal).toEqual({ url_contains: "/b.html" });
    expect(JSON.stringify(s.signal)).not.toContain("k=1");
  });
});

/* ---------------------------------------------------------------- LLM 规划器 */

describe("llmFlowPlanner — 与老师同一条 fail-closed 纪律", () => {
  it("合法 JSON → 提议", async () => {
    const planner = llmFlowPlanner({
      chatFn: async () => '{"id":"open","desc":"进入机票频道","page":"home","lands":"search",'
        + '"targets":[{"role":"link","text":["机票"]}]}',
    });
    const p = await planner(REQ);
    expect(p).not.toBeNull();
    expect(p!.id).toBe("open");
    expect(p!.targets[0]!.text).toEqual(["机票"]);
  });

  it("done / 垃圾回答 → null（停止规划，绝不猜）", async () => {
    expect(await llmFlowPlanner({ chatFn: async () => '{"done":true}' })(REQ)).toBeNull();
    expect(await llmFlowPlanner({ chatFn: async () => "sure thing!" })(REQ)).toBeNull();
    expect(await llmFlowPlanner({ chatFn: async () => { throw new Error("endpoint down"); } })(REQ)).toBeNull();
  });
});

/* ---------------------------------------------------------------- E2E：plan → 首迁 → 零模型 */

describe("planFlow E2E（复刻站 A，真 chromium，staging 到临时 appsDir）", () => {
  it("危险步不演示就停：红线 3 的 plan 期形态，什么文件都不写", { timeout: 120_000 }, async () => {
    const appsDir = tmpDir();
    const err = await planFlow({
      goal: "g", seedUrl: "semantic/site-a/index.html",
      app: "planned-danger", site: "site-a", appsDir, yes: true, verbose: false,
      planner: () => ({
        id: "purchase", desc: "点击购买提交订单", page: "home", lands: "done",
        targets: [{ role: "link", text: ["机票"] }], dangerous: true,
      }),
    }).catch((e: unknown) => e as Error);
    // `planFlow` RESOLVES with a result too, so the union has no `message` — the same
    // cast the replay-gate case below uses (tsc --noEmit is part of `smoke.sh`).
    expect(String((err as Error).message ?? err)).toMatch(/dangerous step .*allowDangerousDemo/);
    expect(fs.existsSync(path.join(appsDir, "planned-danger"))).toBe(false);
  });
  it("一句话 → 模板+档案 → 重放门控 → 首跑学习 → 二跑零模型", { timeout: 420_000 }, async () => {
    const appsDir = tmpDir();
    const res = await planFlow({
      goal: "在携程上订一张5月18日昆明到北京价格最低的机票",
      seedUrl: "semantic/site-a/index.html",
      app: "planned-e2e", site: "site-a",
      appsDir, yes: true, verbose: false, allowDangerousDemo: true,
    });
    expect(res.ok).toBe(true);
    expect(res.gate.ok).toBe(true);

    // 模板：5 步，dangerous 自动落在购买步；档案：观察到的站点知识，steps 恒空（plan 不写 hint）。
    const template = JSON.parse(fs.readFileSync(path.join(appsDir, "planned-e2e", "flow.json"), "utf-8")) as {
      steps: Array<{ id: string; dangerous?: boolean; list_step?: unknown }>;
      slots: Record<string, unknown>;
    };
    expect(template.steps.map((s) => s.id)).toEqual(
      ["open-flights", "submit-search", "pick-date", "pick-cheapest", "purchase"]);
    expect(template.steps.find((s) => s.id === "purchase")!.dangerous).toBe(true);
    expect(template.steps.find((s) => s.id === "pick-cheapest")!.list_step).toEqual({ op: "min", by: "price" });
    expect(template.slots.from).toBe("昆明");

    const profilePath = path.join(appsDir, "planned-e2e", "sites", "site-a.profile.json");
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf-8")) as {
      fill_keys: Record<string, Record<string, string>>;
      list_extract: Record<string, { row_sel: string }>;
      frozen_signals: Record<string, Record<string, unknown>>;
      locale: string;
      checkpoint: string;
      steps: Record<string, unknown>;
    };
    expect(Object.keys(profile.fill_keys["submit-search"]!)).toEqual(["出发城市", "到达城市"]);
    expect(profile.list_extract["pick-cheapest"]!.row_sel).toBe("tr.flight-item");
    expect(JSON.stringify(profile.frozen_signals["pick-date"])).toContain("{date_code}");
    expect(profile.steps).toEqual({});          // plan 不种 hint
    // §3 文字系统路由：首访观察 <html lang="zh"> → 本站 checkpoint = multilingual（运行期真的用它）。
    expect(profile.locale).toBe("zh");
    expect(profile.checkpoint).toBe("multilingual");

    // 首迁（运行期回填环自己收第一站）→ 二跑零模型。
    const store = tmpDir();
    const r1 = await runFlow("planned-e2e", "site-a", {
      appsDir, profileDir: store, laya: "scripted", allowDangerous: true, verbose: false,
    });
    expect(r1.ok).toBe(true);
    expect(r1.counts.backfilled).toBeGreaterThanOrEqual(2);
    expect(r1.counts.list).toBe(1);
    const r2 = await runFlow("planned-e2e", "site-a", {
      appsDir, profileDir: store, laya: "unsure", escalate: "scripted",
      allowDangerous: true, verbose: false,
    });
    expect(r2.ok).toBe(true);
    expect(r2.counts.laya).toBe(0);
    expect(r2.counts.escalate).toBe(0);
  });

  it("M3 双站迁移（自动化）：同一模板 plan 两个站，两站的二跑都零模型", { timeout: 900_000 }, async () => {
    const appsDir = tmpDir();
    const goal = "在携程上订一张5月18日昆明到北京价格最低的机票";
    const plan = (seedUrl: string, site: string) => planFlow({
      goal, seedUrl, app: "planned-dual", site, appsDir,
      yes: true, verbose: false, allowDangerousDemo: true,
    });

    // ① 第一站：模板 + 本站档案（checkpoint 由首访观察得到）。
    const a = await plan("semantic/site-a/index.html", "site-a");
    expect(a.ok).toBe(true);
    const pa = JSON.parse(fs.readFileSync(
      path.join(appsDir, "planned-dual", "sites", "site-a.profile.json"), "utf-8")) as
      { locale: string; checkpoint: string; steps: Record<string, unknown>; pages: Record<string, string> };
    expect(pa.checkpoint).toBe("multilingual");
    expect(pa.steps).toEqual({});

    // ② 第二站：迁移模式——只为新站产档案，模板不动。
    const b = await plan("semantic/site-b/home.html", "site-b");
    expect(b.ok).toBe(true);
    const pb = JSON.parse(fs.readFileSync(
      path.join(appsDir, "planned-dual", "sites", "site-b.profile.json"), "utf-8")) as
      { locale: string; checkpoint: string; steps: Record<string, unknown>; pages: Record<string, string> };
    expect(pb.checkpoint).toBe("english");                 // <html lang="en">
    expect(pb.pages["home"]).toBe("home.html");            // 本站页名是观察来的
    expect(pb.steps).toEqual({});
    const tpl = JSON.parse(fs.readFileSync(path.join(appsDir, "planned-dual", "flow.json"), "utf-8")) as
      { steps: Array<{ id: string }>; sites: Record<string, unknown> };
    expect(tpl.steps.map((s) => s.id)).toEqual(
      ["open-flights", "submit-search", "pick-date", "pick-cheapest", "purchase"]);
    expect(Object.keys(tpl.sites).sort()).toEqual(["site-a", "site-b"]);

    // ③ 两站各自首迁（回填环收第一站）→ 二跑零模型。
    const store = tmpDir();
    for (const site of ["site-a", "site-b"]) {
      const r1 = await runFlow("planned-dual", site, {
        appsDir, profileDir: store, laya: "scripted", allowDangerous: true, verbose: false,
      });
      expect(r1.ok, site).toBe(true);
      expect(r1.counts.backfilled, site).toBeGreaterThanOrEqual(2);
      expect(r1.backfill_gate, site).toBe("verified");
      const r2 = await runFlow("planned-dual", site, {
        appsDir, profileDir: store, laya: "unsure", escalate: "scripted",
        allowDangerous: true, verbose: false,
      });
      expect(r2.ok, site).toBe(true);
      expect(r2.counts.laya, site).toBe(0);
      expect(r2.counts.escalate, site).toBe(0);
      expect(r2.counts.rule, site).toBeGreaterThanOrEqual(4);
    }
  });

  it("门控失败（信号不可复现）→ 不写任何文件", { timeout: 120_000 }, async () => {
    const appsDir = tmpDir();
    // 故意让规划器提议一个"点了也没任何可复现变化"的步：点击不存在的目标由 walk 自身报错，
    // 这里用一个永远停在同页的配方（lands == page 且无查询/文本变化）。
    const res = await planFlow({
      goal: "订5月18日昆明到北京的最低价机票",
      seedUrl: "semantic/site-a/index.html",
      app: "planned-fail", site: "site-a", appsDir,
      planner: () => ({
        id: "no-op", desc: "点一个什么都不会发生的链接", page: "home", lands: "home",
        targets: [{ role: "link", text: ["酒店住宿"] }],   // href=index.html：url 变化=自跳同页
      }),
      yes: true, verbose: false,
    }).catch((e: unknown) => e as Error);
    expect(String((res as Error).message ?? res)).toMatch(/did not advance|replay gate FAILED/);
    expect(fs.existsSync(path.join(appsDir, "planned-fail"))).toBe(false);
  });
});

/* ---------------------------------------------------------------- 重放门本身（不是 walk 报错） */

describe("重放门真的会拦：walk 全绿、门控整跑不过 → 仍然什么都不写", () => {
  it("两步都演示成功、门控发现方案本身不合格（重复步 id）→ replay gate FAILED，磁盘上没有半成品", { timeout: 180_000 }, async () => {
    const appsDir = tmpDir();
    const pagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-gate-pages-"));
    fs.writeFileSync(path.join(pagesDir, "a.html"),
      '<!doctype html><html lang="en"><body><button data-test="to-b" onclick="location.href=\'b.html\'">去B</button></body></html>', "utf-8");
    fs.writeFileSync(path.join(pagesDir, "b.html"),
      '<!doctype html><html lang="en"><body><button data-test="to-c" onclick="location.href=\'c.html\'">去C</button></body></html>', "utf-8");
    fs.writeFileSync(path.join(pagesDir, "c.html"), "<!doctype html><html lang=\"en\"><body><h1>c</h1></body></html>", "utf-8");

    // walk 两次都成功（页面确实前进、判据归纳得出来）；坏在方案本身：两个步共用一个 id。
    // 这正是走 walk 全绿、整跑门控才拦得住的一类问题。
    let n = 0;
    const res = await planFlow({
      goal: "open the pages",
      seedUrl: `file://${path.join(pagesDir, "a.html")}`,
      app: "planned-gate-fail", site: "site-x", appsDir,
      planner: () => {
        n += 1;
        if (n === 1) {
          return {
            id: "go", desc: "open b", page: "home", lands: "b",
            targets: [{ role: "button", text: "去B" }],
          };
        }
        if (n === 2) {
          return {
            id: "go", desc: "open c", page: "b", lands: "c",
            targets: [{ role: "button", text: "去C" }],
          };
        }
        return null;
      },
      yes: true, verbose: false,
    }).catch((e: unknown) => e as Error);

    expect(String((res as Error).message ?? res)).toMatch(/replay gate FAILED/);
    expect(String((res as Error).message ?? res)).toContain("duplicated");
    expect(fs.existsSync(path.join(appsDir, "planned-gate-fail"))).toBe(false);
    expect(fs.existsSync(path.join(appsDir, ".plan-staging-planned-gate-fail"))).toBe(false);
  });
});
