/**
 * 携程测试用例执行器 —— `ctrip/ctrip_task.py` 的 TS 孪生：冻结计划 → 生产执行循环 →
 * 记录 → 独立判分。
 *
 * 测试用例（原文）：
 *     我下周要去北京出差，周一至周五都可以，从昆明出发。搜索早8点至晚6点最低价的
 *     机票并记录。另外再搜索出发当日价格300以内的酒店记录。
 *
 * 本文件把这句话变成一份**冻结计划**（每个子目标一次点击 + 一条 DOM 完成信号 +
 * 一个 target_hint），交给 `src/engine/executor.ts` 的生产执行循环跑在本地复刻站上
 * （`ctrip/site/`），然后把站点自己的记账（`window.__CTRIP_RECORDS`）跟
 * `src/data/ctrip-data.ts` 的判分口径对比。
 *
 *      子目标                                            完成信号（DOM）
 *      ---------------------------------------------------------------
 *      1  首页 → 点「机票」                              page-title 含「机票」
 *      2  把 10-05 列表的出发时段筛成 08:00-18:00          window-state 含「08:00-18:00」
 *      3  按价格从低到高排序                              sort-state 含「价格从低到高」
 *      4  记录该列表最低价航班                            last-record 含「已记录」
 *      ...  10-06 / 10-07 / 10-08 / 10-09 重复 2-4
 *      n  把北京 <出发当日> 入住的价格上限设为 ¥300以下   price-cap-state 含「300」
 *      n+1 按价格从低到高排序                             sort-state 含「价格从低到高」
 *      n+2 记录全部符合条件的酒店                         hotel-recorded 含「已记录」
 *
 * 关键设计：
 *   * 日期由 `nextWeekDates()` 从「今天」推出来，不写死；
 *   * 出发当日 = 五天里区间内最低价的那天 —— 由**机票阶段的执行结果**决定，再据此生成
 *     酒店阶段的 start_url（值只来自执行结果，不来自模型）；
 *   * 每个子目标只做一次点击，筛选/排序状态走 URL（真实列表页的行为），否则执行器每步
 *     都会重新点 hint 指向的同一个元素；
 *   * 完成只认 DOM 信号；记录只认站点自己的账本，判分只认独立口径（`ctrip-data.ts`）。
 *
 * ## 与 Python 的有意偏差
 *
 *   1. `runSubgoals` 走 `planner.ts` 的 `runSubgoalWithRetries`（Python 版手写了一次
 *      `mw.run` 调用）。没有 `retries` 的子目标两者等价，但 TS 版顺带支持了 `retries`
 *      ——用例要求「别新写重试循环」。
 *   2. 返回值用对象而不是 Python 的元组（`{traces, blocked, records}`）：TS 没有
 *      元组解构的同一套惯用法，字段名与 Python 的三元组逐位对应。
 *   3. `main()` 是 async 的（浏览器 API 在 Node 里全是 Promise），并且在没有安装模型
 *      runtime 时会**惰性**动态 import `laya-onnx.ts` 装一个 —— 这样离线测试可以直接
 *      `installLayaRuntime(scriptedRuntime(...))`，不会去碰 1.7GB 的 ONNX。
 *   4. 判分（`verify`）只从 `ctrip-data.ts` 读数据，不碰页面 —— 与 Python 同一条独立口径。
 */
import * as fs from "node:fs";
import { REPO } from "../support/paths.ts";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import * as C from "../data/ctrip-data.ts";
import { todayIso } from "../data/datasource.ts";
import { TaskPlan, type Subgoal } from "../engine/plan.ts";
import { DESTRUCTIVE_PATTERNS } from "../engine/rules.ts";
import { checkSignal } from "../engine/signals.ts";
import type { TraceStep } from "../engine/audit.ts";

export const SITE = path.join(REPO, "ctrip", "site");
export const RESULTS = path.join(REPO, "ctrip", "results");

export const GOAL = "我下周要去北京出差，周一至周五都可以，从昆明出发。搜索早8点至晚6点最低价的机票并记录。"
  + "另外再搜索出发当日价格300以内的酒店记录";

/* ---------------------------------------------------------------- 记录类型 */

export interface FlightRecord {
  date: string;
  no: string;
  price: number;
  dep: string;
  airline?: string;
  arr?: string;
  window?: string;
  sort?: string;
}

export interface HotelRecord {
  id: number;
  price: number;
  name?: string;
  star?: number;
  score?: number;
  area?: string;
  room?: string;
  checkin?: string;
  tags?: string[];
}

export interface Records {
  flights: FlightRecord[];
  hotels: HotelRecord[];
}

export interface Check {
  what: string;
  ok: boolean;
  expected: string;
  recorded: string;
}

export interface Verdict {
  checks: Check[];
  ok: boolean;
  departure_date: string | null;
  oracle_date: string | null;
  checkin: string | null;
}

/* ---------------------------------------------------------------- 冻结计划 */

/** file:// URL + 查询串。筛选/排序状态全部走 URL —— 与真实列表页一致，这样每个子目标
 *  「一次点击 = 一个确定状态」，也让执行器每步重新 goto 不丢条件。 */
export function pageUrl(name: string, params?: Record<string, unknown> | null): string {
  const base = pathToFileURL(path.join(SITE, name)).href;
  if (!params || !Object.keys(params).length) return base;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.append(k, String(v));
  return `${base}?${q.toString()}`;
}

/** 首页 → 五天各（筛时段 / 排序 / 记录）—— 19 步里机票占 16 步。 */
export function flightSubgoals(dates: readonly string[]): Array<Partial<Subgoal>> {
  const sgs: Array<Partial<Subgoal>> = [{
    desc: "从携程首页进入机票搜索页（昆明 → 北京）",
    signal: { css_text_contains: ["[data-test=page-title]", "机票"] },
    start_url: pageUrl("ct_home.html"),
    target_hint: "a[data-test=entry-flight]",
  }];
  for (const d of dates) {
    const wd = C.weekdayCn(d);
    sgs.push(
      {
        desc: `打开 ${d}（${wd}）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00`,
        signal: { css_text_contains: ["[data-test=window-state]", "08:00-18:00"] },
        start_url: pageUrl("flights.html", { from: "KMG", to: "BJS", date: d }),
        target_hint: "a[data-test=window-0800-1800]",
      },
      {
        desc: `把 ${d}（${wd}）的航班列表按价格从低到高排序`,
        signal: { css_text_contains: ["[data-test=sort-state]", "价格从低到高"] },
        start_url: pageUrl("flights.html", { from: "KMG", to: "BJS", date: d, window: "0800-1800" }),
        target_hint: "a[data-test=sort-price_asc]",
      },
      {
        desc: `记录 ${d}（${wd}）08:00-18:00 区间内最低价的航班`,
        signal: { css_text_contains: ["[data-test=last-record]", "已记录"] },
        start_url: pageUrl("flights.html", {
          from: "KMG", to: "BJS", date: d, window: "0800-1800", sort: "price_asc",
        }),
        target_hint: "button[data-test=record-lowest]",
      },
    );
  }
  return sgs;
}

/** 出发当日入住、cap 元以内的酒店：设价格上限 → 排序 → 记录全部。 */
export function hotelSubgoals(checkin: string, city = "北京", cap = 300): Array<Partial<Subgoal>> {
  const base = { city, checkin };
  return [
    {
      desc: `打开 ${city} ${checkin} 入住的酒店列表，并把价格上限设为 ¥${cap}以下`,
      signal: { css_text_contains: ["[data-test=price-cap-state]", String(cap)] },
      start_url: pageUrl("hotels.html", base),
      target_hint: `a[data-test=cap-${cap}]`,
    },
    {
      desc: `把 ${city} ${checkin} 入住的酒店列表按价格从低到高排序`,
      signal: { css_text_contains: ["[data-test=sort-state]", "价格从低到高"] },
      start_url: pageUrl("hotels.html", { ...base, cap }),
      target_hint: "a[data-test=h-sort-price_asc]",
    },
    {
      desc: `记录 ${checkin} 入住、¥${cap}以内的全部酒店`,
      signal: { css_text_contains: ["[data-test=hotel-recorded]", "已记录"] },
      start_url: pageUrl("hotels.html", { ...base, cap, sort: "price_asc" }),
      target_hint: "button[data-test=record-hotels]",
    },
  ];
}

export function makePlan(
  goal: string, subgoals: Array<Partial<Subgoal>>, slots: Record<string, unknown> | null = null,
  planPath: string | null = null,
): TaskPlan {
  return new TaskPlan(goal, subgoals, planPath ?? path.join(RESULTS, "ctrip_task_state.json"), slots);
}

/* ---------------------------------------------------------------- 判分 */

/** 独立口径判分：执行器记的东西必须跟 `ctrip-data.ts` 算出来的完全一致。 */
export function verify(records: Partial<Records>, checkin: string | null): Verdict {
  const dates = C.nextWeekDates();
  const flights = C.buildFlights(dates);
  const hotels = C.buildHotels();
  const checks: Check[] = [];

  const byDate: Record<string, FlightRecord[]> = {};
  for (const r of records.flights ?? []) (byDate[r.date] ??= []).push(r);
  for (const d of dates) {
    const want = C.lowestFlight(flights, d)!;
    const got = byDate[d] ?? [];
    const ok = got.length === 1 && got[0]!.no === want.no && got[0]!.price === want.price;
    checks.push({
      what: `${d} 区间内最低价航班`,
      ok,
      expected: `${want.no} ${want.dep} ¥${want.price}`,
      recorded: got.map((g) => `${g.no} ${g.dep} ¥${g.price}`).join("; ") || "未记录",
    });
  }

  // 出发当日 = 五天记录里价格最低的那天（执行结果决定，不由判分口径喂进去）
  let pickedDate: string | null = null;
  let picked: FlightRecord | null = null;
  for (const [d, rows] of Object.entries(byDate)) {
    for (const r of rows) {
      if (picked === null
          || r.price < picked.price
          || (r.price === picked.price && d < pickedDate!)) {
        pickedDate = d;
        picked = r;
      }
    }
  }
  const [wantDate, wantFlight] = C.bestOverall(flights, dates)!;
  checks.push({
    what: "周一至周五的最低价（决定出发当日）",
    ok: pickedDate === wantDate,
    expected: `${wantDate} ${wantFlight.no} ¥${wantFlight.price}`,
    recorded: picked ? `${pickedDate} ${picked.no} ¥${picked.price}` : "未选出",
  });

  const wantHotels = C.hotelsUnder(hotels, 300);
  const gotHotels = records.hotels ?? [];
  const gotIds = gotHotels.map((h) => h.id);
  const wantIds = wantHotels.map((h) => h.id);
  checks.push({
    what: `${wantDate} 入住、¥300以内酒店（数量/集合/价格升序）`,
    ok: checkin === wantDate
      && gotIds.length === wantIds.length
      && gotIds.every((id, i) => id === wantIds[i])
      && gotHotels.every((h) => h.price <= 300),
    expected: `${wantHotels.length} 家 ¥${wantHotels[0]!.price}-¥${wantHotels[wantHotels.length - 1]!.price}`,
    recorded: `${gotHotels.length} 家` + (gotHotels.length
      ? ` ¥${gotHotels[0]!.price}-¥${gotHotels[gotHotels.length - 1]!.price}` : ""),
  });

  return {
    checks,
    ok: checks.every((c) => c.ok),
    departure_date: pickedDate,
    oracle_date: wantDate,
    checkin,
  };
}

/* ---------------------------------------------------------------- 报告 */

/** 今天的日期：复用引擎实现（`LAYA_TODAY` 可钉住，见 datasource.todayIso）。 */
function todayIsoLocal(): string {
  return todayIso();
}

export function reportLines(records: Partial<Records>, ver: Verdict): string[] {
  const dates = C.nextWeekDates();
  const flights = C.buildFlights(dates);
  const hotels = C.buildHotels();
  const byDate: Record<string, FlightRecord> = {};
  for (const r of records.flights ?? []) byDate[r.date] = r;
  const L: string[] = [];
  L.push(
    "# 携程测试用例执行结果", "",
    "**测试用例**：我下周要去北京出差，周一至周五都可以，从昆明出发。搜索早8点至晚6点最低价的机票并记录。",
    "另外再搜索出发当日价格300以内的酒店记录。", "",
    `- 执行日期：${todayIsoLocal()}（用例里的「下周周一至周五」= `
      + `${dates[0]} ~ ${dates[dates.length - 1]}，${dates.map((d) => C.weekdayCn(d)).join("、")}）`,
    `- 出发时段口径：[${C.WINDOW[0]}, ${C.WINDOW[1]}] 闭区间（含 08:00 与 18:00 整点）`,
    `- 判分：${ver.checks.length} 项全部通过 = ${ver.ok ? "是" : "否"}`, "",
    "## 一、机票：周一至周五 08:00-18:00 最低价", "",
    "| 日期 | 星期 | 记录到的最低价航班 | 时刻 | 价格 | 全天最低（对照） | 判定 |",
    "|---|---|---|---|---|---|---|",
  );
  for (const d of dates) {
    const r = byDate[d];
    const anyT = C.lowestAnyTime(flights, d)!;
    const want = C.lowestFlight(flights, d)!;
    const ok = r && r.no === want.no;
    L.push(`| ${d} | ${C.weekdayCn(d)} | ${r ? `${r.no} ${r.airline ?? ""}`.trim() : "未记录"} `
      + `| ${r ? `${r.dep}-${r.arr}` : "-"} `
      + `| ${r ? `¥${r.price}` : "-"} `
      + `| ${anyT.no} ${anyT.dep} ¥${anyT.price}（时段外） | ${ok ? "✅" : "❌"} |`);
  }
  const best = C.bestOverall(flights, dates)!;
  L.push(
    "", `**最低价结论**：${best[0]}（${C.weekdayCn(best[0])}）**${best[1].no} `
      + `${best[1].airline}** ${best[1].dep}-${best[1].arr} `
      + `**¥${best[1].price}**（经济舱；五天里区间内最低）。`,
    "注意：每天「全天最低价」的航班都在 08:00-18:00 之外（06:20/07:05/07:40/18:05/21:50），"
      + "出发时段筛选确实改变了答案，不是摆设。", "",
    `## 二、酒店：${ver.departure_date} 入住、¥300 以内`, "",
    "| # | 酒店 | 星级 | 评分 | 位置 | 房型 | 价格 |", "|---|---|---|---|---|---|---|",
  );
  (records.hotels ?? []).forEach((h, i) => {
    L.push(`| ${i + 1} | ${h.name} | ${"★".repeat(h.star ?? 0)} | ${h.score} | ${h.area} `
      + `| ${h.room} | ¥${h.price} |`);
  });
  const oracleH = C.hotelsUnder(hotels, 300);
  L.push(
    "", `共记录 ${(records.hotels ?? []).length} 家（独立口径：${oracleH.length} 家 ≤¥300）。`, "",
    "## 三、判分明细（执行器记录 vs 独立口径）", "",
    "| 检查项 | 期望 | 实际记录 | 判定 |", "|---|---|---|---|",
  );
  for (const c of ver.checks) {
    L.push(`| ${c.what} | ${c.expected} | ${c.recorded} | ${c.ok ? "✅" : "❌"} |`);
  }
  L.push(
    "", "## 四、真实性说明", "",
    "- 本结果跑在**本地复刻站** `ctrip/site/` 上：DOM 结构、交互路径（首页→机票/酒店列表→"
      + "筛选→排序→记录）与 URL 形态照携程列表页写，只有票价/房态数据由 `ctrip/data.py` 生成。",
    "- 线上真实站点在本环境**不可用**（WhaleGuard 432 + 酒店价格需登录），实测证据见 "
      + "`ctrip/results/live_probe.json`，复现命令 `python3 ctrip/live_probe.py`。",
    "- 判分用 `ctrip/data.py` 的独立口径，执行器只能通过页面点击记录，不能读数据源。", "",
  );
  return L;
}

export function writeReport(
  records: Partial<Records>, ver: Verdict, outdir: string = RESULTS,
): string {
  fs.mkdirSync(outdir, { recursive: true });
  const out = path.join(outdir, "CTRIP_RESULT.md");
  fs.writeFileSync(out, reportLines(records, ver).join("\n"), "utf-8");
  return out;
}

/* ---------------------------------------------------------------- main */

/** 演示用户：本用例全是查询/筛选/排序/记录，没有任何对外生效的动作。
 *
 *  风险闸门照常逐条提问（风险分由执行器打印、进 trace），这里放行；但一旦描述的动作
 *  命中不可逆词表（支付/下单/删除/提交…），就**拒绝** —— 闸门不是摆设，只是本用例不该
 *  被它挡住。真实跑起来时换成 readline 或外部确认即可。 */
export function demoUser(desc: string, quiet = false): boolean {
  const hit = DESTRUCTIVE_PATTERNS.find((p) => desc.toLowerCase().includes(p));
  if (hit) {
    console.log(`    [demo-user] 拒绝不可逆动作（命中 ${JSON.stringify(hit)}）：${desc}`);
    return false;
  }
  if (!quiet) console.log(`    [demo-user] 允许（只读/查询类）：${desc}`);
  return true;
}
