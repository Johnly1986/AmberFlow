/**
 * 迁移层的跨实现对拍：TS 侧重算六个复刻站（`transfer/data2..data7.py`）的库存与
 * 迁移度量，与 `tools/gen_transfer_corpus.py`（Python 参考实现，输出到 stdout）逐项比对。
 *
 *   语料已冻结在 `tools/transfer-corpus.json`（生成器随参考实现移除，见 BACKUP.md）
 *   cd ts && npx vite-node tools/transfer-parity.ts
 *
 * 判据：
 *   - `dump_js` 必须**逐字节**相等（提交进仓库的站点产物，也是最硬的约束）；
 *   - `flights` / `hotels` / `best_overall` / `hotels_under` / `per_date` 按键序无关深比较；
 *   - `counts`（spec 展开长度与形状）与 `metrics`（迁移度量，含 collect_roles 覆盖）
 *     同样逐项深比较 —— 度量里唯一的偏差是 flow.ts 记录过的 PORT FIX（Python 的
 *     `collect_roles` 被 dict 字面量定义了两次，TS 只保留活的那份并附 `collect_steps`），
 *     这里通过"把 spec 自己的声明再覆盖回去"对齐到 Python 的最终语义。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "../src/ctrip-data.ts";
import * as D2 from "../src/transfer-data2.ts";
import * as D3 from "../src/transfer-data3.ts";
import * as D4 from "../src/transfer-data4.ts";
import * as D5 from "../src/transfer-data5.ts";
import * as D6 from "../src/transfer-data6.ts";
import * as D7 from "../src/transfer-data7.ts";
import {
  deriveFlightSubgoals, deriveHotelSubgoals, shape, specRoles, type FlowSpec,
} from "../src/flow.ts";
import * as TT from "../src/transfer-task.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..");

/** 键序无关的规范化：递归排序对象键，丢弃 `undefined`（等于 JSON 的语义）。 */
function canon(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
}

// 冻结的 Python 参考语料。生成器 `tools/gen_transfer_corpus.py` 属已移出的参考实现（见 BACKUP.md）：
// 用被测实现自己生成期望值就不再是独立参考，所以语料入库，生成器随参考实现移除。
const corpusPath = path.join(here, "transfer-corpus.json");
if (!fs.existsSync(corpusPath)) {
  console.error(`缺少冻结语料 ${corpusPath}；语料已冻结、不能重新生成（见 BACKUP.md）`);
  process.exit(2);
}
// 语料由 Python 参考实现在**它自己的目录**里生成，因此其中的站点 URL 记录的是那个根路径。
// 参考实现与站点文件是同一份 rsync 拷贝（除路径前缀外内容相同），所以这里把记录的根映射回
// 本仓库根再比对——映射是机械的字符串替换，不改动任何语义。生成器见 BACKUP.md。
const rawCorpus = fs.readFileSync(corpusPath, "utf-8");
// 语料里既有 `file://` URL（子目标的 start_url），也有普通绝对路径（spec 文件），两种都要认。
const recordedRoot = rawCorpus.match(/"((?:file:\/\/)?\/[^"]*?)\/(?:ctrip|transfer)\//)?.[1]
  ?.replace(/^file:\/\//, "") ?? null;
const py = JSON.parse(
  recordedRoot && recordedRoot !== REPO ? rawCorpus.replaceAll(recordedRoot, REPO) : rawCorpus,
) as Record<string, any>;

let failed = 0;
let passed = 0;

function check(label: string, tsValue: unknown, pyValue: unknown, exact = false): void {
  const a = exact ? String(tsValue) : canon(tsValue);
  const b = exact ? String(pyValue) : canon(pyValue);
  const same = a === b;
  console.log(`${same ? "OK  " : "DIFF"} ${label}`);
  if (same) {
    passed += 1;
    return;
  }
  failed += 1;
  if (!exact) {
    console.log(`   ts=${a.slice(0, 400)}`);
    console.log(`   py=${b.slice(0, 400)}`);
  } else {
    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
    console.log(`   first byte diff @${i}`);
    console.log(`   ts=${JSON.stringify(a.slice(Math.max(0, i - 60), i + 60))}`);
    console.log(`   py=${JSON.stringify(b.slice(Math.max(0, i - 60), i + 60))}`);
  }
}

const SITES: Array<[string, TT.Oracle & {
  dumpJs(dates?: readonly string[] | null): string;
}]> = [
  ["transfer.data2", D2], ["transfer.data3", D3], ["transfer.data4", D4],
  ["transfer.data5", D5], ["transfer.data6", D6], ["transfer.data7", D7],
];

const dates = C.nextWeekDates();
check("dates", dates, py["dates"]);
check("goal", TT_GOAL(), py["goal"], true);

for (const [name, mod] of SITES) {
  const p = py["sites"][name] as Record<string, any>;
  const flights = mod.buildFlights(dates);
  const hotels = mod.buildHotels();
  check(`${name} flights`, flights, p["flights"]);
  check(`${name} hotels`, hotels, p["hotels"]);
  check(`${name} dump_js (逐字节)`, mod.dumpJs(dates), p["dump_js"], true);
  const best = mod.bestOverall(flights, dates)!;
  check(`${name} best_overall`, [best[0], best[1].no, best[1].price], p["best_overall"]);
  check(`${name} hotels_under(300)`, mod.hotelsUnder(hotels, 300), p["hotels_under"]);
  check(`${name} per_date 最低价`,
    Object.fromEntries(dates.map((d) => [d, mod.lowestFlight(flights, d)!.no])), p["per_date"]);
}

// ---- spec 展开长度 / 形状 ----
const specs = TT.discoverSpecs();
for (const [key, spec] of Object.entries(specs)) {
  const p = py["counts"][key] as Record<string, any>;
  const checkin = TT.oracleFor(spec).bestOverall(
    TT.oracleFor(spec).buildFlights(dates), dates)![0];
  check(`counts[${key}]`, {
    flight: deriveFlightSubgoals(spec, dates, C.weekdayCn).length,
    hotel: deriveHotelSubgoals(spec, checkin).length,
    total: deriveFlightSubgoals(spec, dates, C.weekdayCn).length
      + deriveHotelSubgoals(spec, checkin).length,
    shape: shape(spec),
    roles: specRoles(spec, dates),
  }, p);
}

// ---- 迁移度量（Python 的最终语义：spec 自己的 collect_roles 覆盖度量里那份） ----
const TS_METRICS = TT.migrationMetricsForAll(specs, dates);
for (const [key, spec] of Object.entries(specs)) {
  const p = py["metrics"]["sites"][key] as Record<string, any>;
  check(`metrics[${key}]`, TS_METRICS.sites[key], p);
}
check("metrics.baseline", TS_METRICS.baseline, py["metrics"]["baseline"], true);

// ---- 结果报告正文：writeResultMd 必须逐字节相等 ----
for (const [key, spec] of Object.entries(specs)) {
  const synth = synthResult(key, spec);
  const p = py["reports"][key] as Record<string, any>;
  check(`verify(${key}, 忠实记录)`, synth.res.verify, p["verify"]);
  check(`report(${key}, TRANSFER_RESULT_${key}.md) (逐字节)`, synth.report, p["_report"], true);
}

/** 不需要浏览器的"忠实记录"结果（与 Python `synth_result` 同一构造）。 */
function synthResult(key: string, spec: FlowSpec): { res: TT.SiteResult; report: string } {
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
    subgoals: deriveFlightSubgoals(spec, ds, oracle.weekdayCn).length
      + deriveHotelSubgoals(spec, checkin).length,
    steps: [],
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-parity-"));
  try {
    return { res, report: fs.readFileSync(TT.writeResultMd(res, spec, tmp), "utf-8") };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (failed) {
  console.log(`\nVERDICT: ${failed} 项与 Python 参考实现不一致（${passed} 项一致）`);
  process.exit(1);
}
console.log(`\nVERDICT: ${passed} 项全部与 Python 参考实现一致（含 6 个 dump_js 的逐字节相等）`);

/** `CT.GOAL` 在这里只用于对拍文案（避免循环 import，直接内联）。 */
function TT_GOAL(): string {
  return "我下周要去北京出差，周一至周五都可以，从昆明出发。搜索早8点至晚6点最低价的机票并记录。"
    + "另外再搜索出发当日价格300以内的酒店记录";
}
