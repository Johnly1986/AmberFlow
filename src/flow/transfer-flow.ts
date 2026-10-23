/**
 * 迁移执行器 —— `transfer/transfer_task.py` 的 TS 孪生：配置（`specs/<site>.json`）→
 * 冻结计划 → 生产循环 → 判分 → 迁移度量。
 *
 *     （原驱动 CLI 已于 2026-10-21 删除；用例统一走 apps/<id>/pack.json。本文件只留机器。）
 *
 * 这个文件里**没有**任何站点知识：站点来自 `transfer/specs/*.json`，数据模块名写在
 * spec 的 `data_module` 里（TS 侧用注册表映射到已移植模块），判分复用携程的判分口径
 * 只换数据源。所以"支持一个布局相似的新站点"= 加一个 spec + 一个数据生成器。
 *
 * ## 与 Python 的有意偏差
 *
 *   1. **判分换数据源的机制不同，语义相同。** Python 版 `verify` 读模块全局
 *      `CT.C`，`run_site` 用 `CT.C = oracle` 临时换掉它（`finally` 换回）。
 *      TS 的 ESM 命名空间绑定是**只读**的，运行期无法替换 `ctrip-task.ts` 里的 `C`，
 *      所以这里把 `verify` 逐行移植成 `verifyWith(oracle, records, checkin)`：
 *      同一个算法、同一批检查项，只把数据源作为参数传入。`tests/transfer.test.ts`
 *      用 `verifyWith(ctripData, …) === CT.verify(…)` 钉住"换了机制没换语义"。
 *   2. **`_harvest` 传函数不传字符串。** Playwright 的 TS `page.evaluate(string)`
 *      把字符串当**表达式**求值（`"() => window.x"` 只会得到一个函数对象），
 *      和 Python 同步 API 的字符串入口语义不同。这里从 `ledger_js` 里解析出
 *      `window.__XXX` 名字，再把真正的函数交给 `evaluate`。
 *   3. `main()` 是 async 的（浏览器 API 在 Node 里全是 Promise），并且惰性装 ONNX
 *      runtime；离线测试用 `installLayaRuntime(scriptedRuntime(...))`，不碰 1.7GB 模型。
 *   4. `runSite` 用 options 对象收 `verbose/dropWhen/dropRetries`（Python 是三个位置参数），
 *      返回值是带字段名的对象（Python 是 dict，本就直接对应）。
 */
import * as fs from "node:fs";
import { REPO } from "../support/paths.ts";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPECS, deriveFlightSubgoals, deriveHotelSubgoals, loadSpec, migrationMetrics, shape,
  type FlowSpec,
} from "../flow/flow.ts";
import * as C from "../data/ctrip-data.ts";
import * as CT from "../data/ctrip-oracle.ts";
import * as D2 from "../data/transfer-data2.ts";
import * as D3 from "../data/transfer-data3.ts";
import * as D4 from "../data/transfer-data4.ts";
import * as D5 from "../data/transfer-data5.ts";
import * as D6 from "../data/transfer-data6.ts";
import * as D7 from "../data/transfer-data7.ts";
import { TaskPlan, type Subgoal } from "../engine/plan.ts";
import { browserSession, BrowserMiddleware } from "../engine/executor.ts";
import type { AuditVerdict, Auditor, TraceStep } from "../engine/audit.ts";

export const RESULTS = path.join(REPO, "transfer", "results");

/* ---------------------------------------------------------------- 数据源注册表 */

/** 站点库存里执行器/判分会读到的字段（比具体站点类型窄，够用即可）。 */
export interface OracleFlight {
  date: string;
  no: string;
  price: number;
  dep: string;
  airline?: string;
  arr?: string;
}
export interface OracleHotel {
  id: number;
  price: number;
  name?: string;
  star?: number;
  score?: number;
  area?: string;
  room?: string;
  tags?: string[];
}

/**
 * 一个站点数据模块对 `transfer_task` 暴露的面。
 *
 * 方法签名（而不是属性签名）是有意的：TS 在 `strictFunctionTypes` 下对方法参数做
 * **双变**检查，而"站点自己的 Flight"（多一个 carrier、没有 tax）与"判分口径的
 * ctrip Flight"互相只在一边可赋值 —— 换成一堆接口按位置对齐会平白飘红。
 */
export interface Oracle {
  buildFlights(dates?: readonly string[] | null): OracleFlight[];
  buildHotels(n?: number, seed?: string): OracleHotel[];
  lowestFlight(flights: readonly OracleFlight[], date: string, lo?: string, hi?: string): OracleFlight | null;
  lowestAnyTime(flights: readonly OracleFlight[], date: string): OracleFlight | null;
  bestOverall(flights: readonly OracleFlight[], dates: readonly string[], lo?: string, hi?: string): [string, OracleFlight] | null;
  hotelsUnder(hotels: readonly OracleHotel[], cap?: number): OracleHotel[];
  nextWeekDates(today?: string | null): string[];
  weekdayCn(iso: string): string;
}

/** `spec.data_module` -> 已移植模块（Python 侧是 `importlib.import_module`）。 */
export const ORACLES: Readonly<Record<string, Oracle>> = {
  "ctrip.data": C,
  "transfer.data2": D2,
  "transfer.data3": D3,
  "transfer.data4": D4,
  "transfer.data5": D5,
  "transfer.data6": D6,
  "transfer.data7": D7,
};

export function discoverSpecs(): Record<string, FlowSpec> {
  const out: Record<string, FlowSpec> = {};
  for (const p of fs.readdirSync(SPECS).filter((f) => f.endsWith(".json")).sort()) {
    out[path.basename(p, ".json")] = loadSpec(path.join(SPECS, p));
  }
  return out;
}

/** spec 里的 `data_module` 决定用哪套库存/判分口径（判分代码本身不变）。 */
export function oracleFor(spec: FlowSpec): Oracle {
  const key = String(spec.data_module ?? "");
  const mod = ORACLES[key];
  if (!mod) {
    throw new Error(`unknown data_module '${key}' (known: ${JSON.stringify(Object.keys(ORACLES).sort())})`);
  }
  return mod;
}

/* ---------------------------------------------------------------- 记录类型 */

export interface FlightRecord extends OracleFlight {
  window?: string;
  sort?: string;
  [k: string]: unknown;
}
export interface HotelRecord extends OracleHotel {
  checkin?: string;
  [k: string]: unknown;
}
export interface Ledger {
  flights: FlightRecord[];
  hotels: HotelRecord[];
  skipped: number;
  retried: number;
}

/* ---------------------------------------------------------------- 消融 */

/** 消融用：把条件子目标退化成无条件子目标。 */
export function _stripWhen(sgs: Subgoal[]): Subgoal[] {
  for (const sg of sgs) delete sg.when;
  return sgs;
}

/** 消融用：去掉重试策略，让瞬时失败直接变成 BLOCKED。 */
export function _stripRetries(sgs: Subgoal[]): Subgoal[] {
  for (const sg of sgs) delete sg.retries;
  return sgs;
}

export function _prepare(sgs: Subgoal[], dropWhen: boolean, dropRetries: boolean): Subgoal[] {
  if (dropWhen) _stripWhen(sgs);
  if (dropRetries) _stripRetries(sgs);
  return sgs;
}

/* ---------------------------------------------------------------- 判分 */

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

/**
 * `ctrip-task.verify` 的逐行移植，唯一的差别是数据源由参数传入 —— 这是 TS 侧
 * 无法替换 ESM 命名空间绑定的直接后果（见文件头偏差说明 1）。
 * `verifyWith(C, …)` 与 `CT.verify(…)` 必须逐字段相等。
 */
export function verifyWith(oracle: Oracle, records: Partial<Ledger>, checkin: string | null): Verdict {
  const dates = oracle.nextWeekDates();
  const flights = oracle.buildFlights(dates);
  const hotels = oracle.buildHotels();
  const checks: Check[] = [];

  const byDate: Record<string, FlightRecord[]> = {};
  for (const r of records.flights ?? []) (byDate[r.date] ??= []).push(r);
  for (const d of dates) {
    const want = oracle.lowestFlight(flights, d)!;
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
  const [wantDate, wantFlight] = oracle.bestOverall(flights, dates)!;
  checks.push({
    what: "周一至周五的最低价（决定出发当日）",
    ok: pickedDate === wantDate,
    expected: `${wantDate} ${wantFlight.no} ¥${wantFlight.price}`,
    recorded: picked ? `${pickedDate} ${picked.no} ¥${picked.price}` : "未选出",
  });

  const wantHotels = oracle.hotelsUnder(hotels, 300);
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

export interface StepRecord {
  step?: unknown;
  desc?: unknown;
  how?: unknown;
  method?: unknown;
  conf?: unknown;
}

export interface SiteResult {
  site: string;
  profile: string;
  language: string | undefined;
  spec: string;
  dates: string[];
  checkin: string | null;
  records: Ledger;
  skipped: number;
  retried: number;
  dropped_when: boolean;
  dropped_retries: boolean;
  verify: Verdict;
  blocked: string | null;
  audit: AuditVerdict;
  subgoals: number;
  steps: StepRecord[];
}

/* ---------------------------------------------------------------- 产出 */

/** Python `str(list[str])` 的等价物（报告正文里用的是它，不是 JSON）。 */
function pyStrList(xs: readonly string[]): string {
  return `[${xs.map((x) => (x.includes("'") && !x.includes('"') ? `"${x}"` : `'${x}'`)).join(", ")}]`;
}

/** Python f-string 打印 float：整数型浮点带 `.0`（JS 的 `4` 在 Python 里是 `4.0`）。 */
function pyFloat(v: number | undefined): string {
  if (v === undefined) return "None";
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

/** Python f-string 打印 None。 */
function pyNone(v: string | null): string {
  return v === null ? "None" : v;
}

export function writeResultMd(res: SiteResult, spec: FlowSpec, outdir: string): string {
  const oracle = oracleFor(spec);
  const dates = res.dates;
  const flights = oracle.buildFlights(dates);
  const hotels = oracle.buildHotels();
  const byDate: Record<string, FlightRecord> = {};
  for (const r of res.records.flights) byDate[r.date] = r;
  const okn = res.verify.checks.filter((c) => c.ok).length;
  const L: string[] = [
    `# 迁移结果 · ${res.profile}（${res.language}）`, "",
    // 报告是**文档**（冻结语料按逐字节比），仓库相对路径必须按仓库口径（正斜杠）渲染，
    // 不能跟着文件分隔符走——Windows 上 path.relative 产出 "transfer\\specs\\…"（实测 14 项漂移）。
    `- 流程配置：\`${path.relative(REPO, res.spec).split(path.sep).join("/")}\`（流程零代码改动）`,
    `- 站点：${res.profile}；子目标 ${res.subgoals} 个；判分 ${okn}/${res.verify.checks.length}`,
    `- 出发当日（由机票阶段记录决定）：${res.checkin}`, "",
    "## 机票：五天 08:00-18:00 最低价", "",
    "| 日期 | 记录 | 价格 | 独立口径 | 判定 |", "|---|---|---|---|---|",
  ];
  for (const d of dates) {
    const r = byDate[d];
    const want = oracle.lowestFlight(flights, d)!;
    const ok = Boolean(r && r.no === want.no);
    L.push(`| ${d} | ${r ? `${r.no} ${String(r.dep)}` : "未记录"} | `
      + `${r ? `¥${r.price}` : "-"} | ${want.no} ${want.dep} `
      + `¥${want.price} | ${ok ? "✅" : "❌"} |`);
  }
  const best = oracle.bestOverall(flights, dates)!;
  L.push("", `**最低价**：${best[0]} **${best[1].no} ${best[1].airline}** `
    + `${best[1].dep}-${best[1].arr} **¥${best[1].price}**`, "",
  `## 酒店：${res.checkin} 入住、¥300 以内`, "",
  "| # | 酒店 | 星级 | 评分 | 位置 | 价格 |", "|---|---|---|---|---|---|");
  res.records.hotels.forEach((h, i) => {
    L.push(`| ${i + 1} | ${h.name} | ${"★".repeat(h.star ?? 0)} | ${pyFloat(h.score)} | ${h.area} | ¥${h.price} |`);
  });
  const wantH = oracle.hotelsUnder(hotels, 300);
  L.push("", `共记录 ${res.records.hotels.length} 家（独立口径 ${wantH.length} 家 ≤¥300）。`, "",
    "## 判分明细", "", "| 检查项 | 期望 | 记录 | 判定 |", "|---|---|---|---|");
  for (const c of res.verify.checks) {
    L.push(`| ${c.what} | ${c.expected} | ${c.recorded} | ${c.ok ? "✅" : "❌"} |`);
  }
  L.push("", `审计：\`${res.audit.verdict}\` ${pyStrList(res.audit.reasons)}；blocked=${pyNone(res.blocked)}`, "");
  const out = path.join(outdir, `TRANSFER_RESULT_${res.site}.md`);
  fs.mkdirSync(outdir, { recursive: true });
  fs.writeFileSync(out, L.join("\n"), "utf-8");
  return out;
}

/**
 * 配置 → 冻结计划 JSON（TaskPlan 的磁盘格式，plan_cli 可以直接 run）。
 *
 * 出发当日这里取独立口径算出的日期 —— 只是"离线出计划"用；真实跑的时候
 * 仍然由机票阶段的**执行结果**决定（runSite 就是这么做的）。
 */
export function emitPlan(key: string, spec: FlowSpec, outdir: string): string {
  const oracle = oracleFor(spec);
  const dates = oracle.nextWeekDates();
  const checkin = oracle.bestOverall(oracle.buildFlights(dates), dates)![0];
  const sgs = [
    ...deriveFlightSubgoals(spec, dates, oracle.weekdayCn),
    ...deriveHotelSubgoals(spec, checkin),
  ];
  const plan = new TaskPlan(CT.GOAL, sgs, path.join(outdir, `plan_${key}.json`), spec.slots ?? null);
  plan.save();
  return plan.path;
}

export interface MigrationMetricsFile {
  baseline: string;
  sites: Record<string, Record<string, unknown>>;
}

export function migrationMetricsForAll(
  specs: Record<string, FlowSpec>, dates: readonly string[],
): MigrationMetricsFile {
  const baselineSpec = specs["ctrip"]!;
  const oracle0 = oracleFor(baselineSpec);
  const baseline = [
    ...CT.flightSubgoals(dates),
    ...CT.hotelSubgoals(oracle0.bestOverall(oracle0.buildFlights(dates), dates)![0]),
  ] as Subgoal[];
  const sites: Record<string, Record<string, unknown>> = {};
  for (const [key, spec] of Object.entries(specs)) {
    const oracle = oracleFor(spec);
    const checkin = oracle.bestOverall(oracle.buildFlights(dates), dates)![0];
    const sgs = [
      ...deriveFlightSubgoals(spec, [...dates], oracle.weekdayCn),
      ...deriveHotelSubgoals(spec, checkin),
    ];
    sites[key] = {
      ...migrationMetrics(baseline, sgs, { baselineSpec, otherSpec: spec, dates: [...dates] }),
      language: spec.language, spec: spec._path, collect_roles: spec.collect_roles ?? [],
    };
  }
  return { baseline: "ctrip/ctrip_task.py 手写计划（未经配置）", sites };
}
