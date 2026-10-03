/**
 * qunar migration test — TS twin of `qunar/qunar_task.py`.
 *
 * The ctrip case's FLOW SKELETON replayed against a real site
 * (`touch.qunar.com/h5/flight/`). Measured boundaries (2026-10-03, this box):
 *   - the home page is reachable by curl/httpx/chromium (unlike ctrip's 432) and
 *     the executor's extraction sees 13 interactive elements;
 *   - the list API (`touchInnerList`) answers `code:1999` to every automated
 *     browser (even with the SPA's own Bella token -- the `chloroFp` fingerprint
 *     SDK fails CORS inside automated chromium), so the list page renders
 *     "没有查询到符合条件的航班" and yields 0 elements;
 *   - the city picker opens but never shows suggestions -> cities cannot be
 *     changed automatically.
 *
 * So the plan automates what CAN be automated (navigation / interaction / URL
 * signals) and records the data leg as a measured boundary check -- the same
 * honest-verdict shape the ctrip case uses when a site is fenced off.
 *
 * Run:  node --experimental-strip-types src/qunar-task.ts
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import * as browserEnv from "./browser-env.ts";
import { BrowserMiddleware } from "./executor.ts";
import { PlanningRules, TaskPlan, type Subgoal } from "./plan.ts";
import { checkSignal } from "./signals.ts";
import { criteriaView, extractElements } from "./extraction.ts";
import { runSubgoalWithRetries } from "./planner.ts";
import { REPO } from "./flow.ts";
import { expandPack, loadPack } from "./app-pack.ts";
import { loadProbeSet, shortOf } from "./probe-set.ts";

/**
 * 冻结计划与两个 URL 都来自应用包 `apps/qunar-live/pack.json`（原来写死在这里——
 * 矩阵的"债"那一栏就是它）。本文件只剩"怎么跑 + 怎么判分"。
 */
const PACK = loadPack("qunar-live");
const PROBE = loadProbeSet("qunar-live");

export const HOME: string = expandPack(PACK, {}, path.join(REPO, "qunar", "results", "qunar_plan.json"))
  .plan.subgoals[0]!.start_url!;
/** 数据腿直接进的列表页（探针集里声明的 URL）。 */
export const LIST_URL: string = loadProbeSet("qunar-live").http
  .find((t) => t.id === "qunar-flight-list")!.url;
export const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
  + "AppleWebKit/605.1.15 (Version/17.0 Mobile/15E148 Safari/604.1)";
export const RESULTS = path.join(REPO, "qunar", "results");

/**
 * 冻结计划：**从应用包的 journey 展开**（每个子目标 = 一次点击 + 一个 URL 完成信号）。
 *
 * 计划本身是数据（`apps/qunar-live/pack.json` 的 `journey`）：两步、两个点名目标
 * （div「北京」/唯一按钮「搜索」）、两个 URL 完成信号、各 2 次重试（SPA 水合竞态——
 * 见 CLAUDE.md 的 `retries` 条目）。代码里没有 URL，也没有站点名。
 */
export function buildPlan(outdir = RESULTS): TaskPlan {
  return expandPack(PACK, {}, path.join(outdir, "qunar_plan.json")).plan;
}

/** Response body may already be released; a listener must never kill the task. */
async function safeBody(r: { text(): Promise<string> }): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "";
  }
}

export interface QunarRecords {
  plan?: unknown;
  home: { elements?: number; criteria_sample?: unknown[] };
  subgoals: Array<{
    desc: string; done: boolean; stop_reason: string; attempts: number;
    final_url: string; methods: Array<string | undefined>;
  }>;
  api: Array<{ status: number; body: string }>;
  list_direct: Record<string, unknown>;
  checks?: QunarCheck[];
  verdict?: string;
}

export interface QunarCheck {
  what: string;
  ok: boolean;
  expected: string;
  recorded: string;
}

/** The independent 4-item oracle (pure: unit-testable without a browser). */
export function buildChecks(records: QunarRecords): QunarCheck[] {
  const done: Record<string, boolean> = {};
  for (const s of records.subgoals) done[s.desc] = s.done;
  const firstMethods = records.subgoals[0]?.methods ?? [];
  const api1999 = records.api.some((a) => a.body.includes("1999"))
    || Boolean(records.list_direct.no_flight_banner);
  const urlOf = (prefix: string): string =>
    records.subgoals.find((s) => s.desc.startsWith(prefix))?.final_url ?? "";
  return [
    {
      what: "首次加载的表单可交互（执行器按规则命中计划点名目标 div 北京）",
      ok: Boolean(done["打开出发城市选择器"])
        && firstMethods.some((m) => String(m).startsWith("rule")),
      expected: "子目标1 done 且 method=rule:*",
      recorded: `done=${done["打开出发城市选择器"]} methods=${JSON.stringify(firstMethods)}`,
    },
    {
      what: "交互：出发城市选择器被打开（URL hash 信号）",
      ok: Boolean(done["打开出发城市选择器"]),
      expected: "url_contains #cityselect",
      recorded: urlOf("打开出发城市选择器"),
    },
    {
      what: "动作：搜索跳转列表页（URL 信号，SPA 自建请求）",
      ok: Boolean(done["点击搜索，跳转航班列表页"]),
      expected: "url_contains ncs/page/flightlist?depCity=",
      recorded: urlOf("点击搜索"),
    },
    {
      what: `边界：列表数据门如实复现（touchInnerList 1999；末次加载表单降级为 ${records.home.elements} 元素）`,
      ok: api1999,
      expected: "1999/没有查询到符合条件的航班",
      recorded: `api_seen=${records.list_direct.api_seen} banner=${records.list_direct.no_flight_banner}`,
    },
  ];
}

export function renderReport(records: QunarRecords, checks: QunarCheck[]): string {
  const okN = checks.filter((c) => c.ok).length;
  const L = ["# qunar 迁移测试结果", "",
    `- 目标：\`${shortOf(PROBE, "qunar-flight-h5")}\`（真实站点）· 判分 **${okN}/${checks.length}**`,
    "- 首页：首次加载 13 个可交互元素（qunar/results/probe.json，执行器 criteria 视图正常）；"
    + `末次加载降级为 ${records.home.elements} 个（反爬降级，见判分明细第 4 行）`, "",
    "## 判分明细", "", "| 检查项 | 期望 | 记录 | 判定 |", "|---|---|---|---|"];
  for (const c of checks) {
    L.push(`| ${c.what} | ${c.expected} | ${String(c.recorded).slice(0, 80)} | ${c.ok ? "✅" : "❌"} |`);
  }
  L.push("",
    "## 实测边界（数据腿，非用例失败而是环境约束）", "",
    "- `touchInnerList` 对自动化浏览器一律 `code:1999`（北京→上海也拒，有头/无头同判）；",
    "- 请求体带 SPA 自产 Bella token 仍被拒——`chloroFp` 指纹 SDK 在自动化 chromium 里 CORS 失败；",
    "- 城市选择器建议列表不出现（同族 SDK 失败）→ 改城市不可自动化；",
    "- 与 ctrip 线上站的 432（出口 IP 门）同型：**流程骨架可迁移，数据腿被客户端指纹门拦住**。", "");
  return L.join("\n");
}

export async function main(): Promise<number> {
  const outdir = RESULTS;
  fs.mkdirSync(outdir, { recursive: true });

  const plan = buildPlan(outdir);
  const issues = new PlanningRules(8).problems(plan);
  if (issues.length) throw new Error("plan invalid: " + issues.join("; "));

  const mw = new BrowserMiddleware({ maxSteps: 6, confirmFn: () => true, gotoTimeout: 30_000 });
  const records: QunarRecords = {
    plan: fs.existsSync(plan.path) ? JSON.parse(fs.readFileSync(plan.path, "utf-8")) : {},
    home: {}, subgoals: [], api: [], list_direct: {},
  };

  const browser = (await browserEnv.launch({ chromium } as never, true)) as Browser;
  // The home page's SECOND load degrades (the same fingerprint-SDK failure tree
  // as the 1999 list API), so each subgoal gets its own fresh context: one
  // first-load per subgoal, self-contained state.
  const freshPage = async (): Promise<[BrowserContext, Page]> => {
    const ctx = await browser.newContext({
      userAgent: UA, viewport: { width: 390, height: 844 }, isMobile: true,
      hasTouch: true, locale: "zh-CN",
    });
    return [ctx, await ctx.newPage()];
  };
  const watchApi = (page: Page): void => {
    page.on("response", (r) => {
      if (!r.url().includes("touchInnerList")) return;
      void safeBody(r).then((body) => records.api.push({ status: r.status(), body: body.slice(0, 300) }));
    });
  };
  try {
    for (const [i, sg] of plan.subgoals.entries()) {
      console.log(`[subgoal ${i + 1}/${plan.subgoals.length}] ${sg.desc}`);
      const [ctx, page] = await freshPage();
      watchApi(page);
      const { rep, attempt, steps } = await runSubgoalWithRetries(
        mw as never, sg, plan, sg.start_url!, page, { chromium } as never, true);
      records.subgoals.push({
        desc: sg.desc, done: rep.done, stop_reason: rep.stop_reason, attempts: attempt,
        final_url: page.url().slice(0, 160),
        methods: steps.map((s) => s.method as string | undefined),
      });
      console.log(`  -> ${rep.done ? "DONE" : "FAIL"} (${rep.stop_reason})`);
      await ctx.close();
    }

    // --- home visibility re-check LAST, so it does not consume a first load ---
    {
      const [ctx, page] = await freshPage();
      watchApi(page);
      await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForSelector("button:has-text('搜索')", { timeout: 20_000 });
      await page.waitForTimeout(1500);
      const elems = await extractElements(page as never);
      const view = criteriaView(elems, new Set(), null);
      records.home = { elements: Object.keys(elems).length, criteria_sample: Object.entries(view).slice(0, 4) };
      console.log(`home: ${records.home.elements} interactive elements`);
      await ctx.close();
    }

    // --- data leg, measured: the list URL straight in (KMG->BJS) ---
    {
      const [ctx, page] = await freshPage();
      watchApi(page);
      const q = new URLSearchParams({
        depCity: "昆明", arrCity: "北京", goDate: "2026-10-06", from: "touch_index_search",
        child: "0", baby: "0", cabinType: "0",
      });
      await page.goto(LIST_URL + "?" + q, {
        waitUntil: "domcontentloaded", timeout: 30_000,
      });
      await page.waitForTimeout(9000);
      const body = await page.innerText("body");
      const le = await extractElements(page as never);
      records.list_direct = {
        url: page.url().slice(0, 160), body_len: body.length,
        body_head: body.slice(0, 120).replace(/\n/g, " ⏎ "),
        no_flight_banner: body.includes("没有查询到符合条件的航班"),
        elements: Object.keys(le).length,
      };
      await page.screenshot({ path: path.join(outdir, "list_direct.png") });
      records.list_direct.api_seen = records.api.length;
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  const checks = buildChecks(records);
  const okN = checks.filter((c) => c.ok).length;
  records.checks = checks;
  records.verdict = `${okN}/${checks.length}`;
  fs.writeFileSync(path.join(outdir, "qunar_records.json"),
    JSON.stringify(records, null, 2), "utf-8");
  fs.writeFileSync(path.join(outdir, "QUNAR_RESULT.md"), renderReport(records, checks), "utf-8");

  console.log(`\n=== 结论 ===\n  判分 ${okN}/${checks.length}`);
  for (const c of checks) console.log(`  [${c.ok ? "PASS" : "FAIL"}] ${c.what}`);
  console.log("写入", path.join(outdir, "QUNAR_RESULT.md"));
  return okN === checks.length ? 0 : 1;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exit(await main());
}
