/**
 * 携程用例的跨实现对拍：TS 侧重算 `ctrip/data.py` + `ctrip/ctrip_task.py` 的每项结果，
 * 与 `tools/gen_ctrip_corpus.py`（Python 参考实现，输出到 stdout）逐项比对。
 *
 *   语料已冻结在 `tools/ctrip-corpus.json`（生成器留在 Python 备份里，见 BACKUP.md）
 *   cd ts && npx vite-node tools/ctrip-parity.ts
 *
 * 为什么用 vite-node 而不是 `node --experimental-strip-types`：本工具要 import
 * `src/ctrip-task.ts` -> `src/plan.ts`，而 Node 的 strip-only 模式不支持 TS 的
 * **构造器参数属性**（`constructor(public maxSubgoals = 8, ...)`），会在加载时直接报
 * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。vite-node 走完整转译，其他对拍工具（executor-parity）
 * 的依赖链没有用到这个语法，所以仍可用 strip-types。
 *
 * 判据：
 *   - `dump_js` 必须**逐字节**相等（这是提交进仓库的站点产物，也是本用例最硬的约束）；
 *   - 其余项按键序无关的深比较（`flights`/`hotels`/子目标/`verify`/篡改判定）；
 *   - `report`（CTRIP_RESULT.md 正文）必须逐字节相等。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "../src/ctrip-data.ts";
import * as T from "../src/ctrip-task.ts";

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

// 冻结的 Python 参考语料。生成器 `tools/gen_ctrip_corpus.py` 属已移出的参考实现（见 BACKUP.md）：
// 用被测实现自己生成期望值就不再是独立参考，所以语料入库、生成器留在备份里。
const corpusPath = path.join(here, "ctrip-corpus.json");
if (!fs.existsSync(corpusPath)) {
  console.error(`缺少冻结语料 ${corpusPath}；重新生成需回到 Python 备份（见 BACKUP.md）`);
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

const dates = C.nextWeekDates();
const records = py["records"] as T.Records;
const checkin = py["checkin"] as string;
const ver = T.verify(records, checkin);

check("dates", dates, py["dates"]);
check("flights", C.buildFlights(dates), py["flights"]);
check("hotels", C.buildHotels(), py["hotels"]);
check("dump_js (逐字节)", C.dumpJs(dates), py["dump_js"], true);
check("flight_subgoals", T.flightSubgoals(dates), py["flight_subgoals"]);
check("hotel_subgoals", T.hotelSubgoals("2026-10-08"), py["hotel_subgoals"]);
check("GOAL", T.GOAL, py["goal"], true);
check("verify(忠实记录)", ver, py["verify"]);

// 6 种篡改 -> 各自失败（对齐 Python 的 parametrize 用例）
const mutations: Record<string, (r: T.Records) => void> = {
  "wrong-flight": (r) => { r.flights[0] = { ...r.flights[0]!, no: "XX0000" }; },
  "wrong-price": (r) => { r.flights[0] = { ...r.flights[0]!, price: 1 }; },
  "missing-day": (r) => { r.flights.pop(); },
  "extra-hotel": (r) => { r.hotels.push({ ...r.hotels[0]!, id: 1, price: 999 }); },
  "missing-hotel": (r) => { r.hotels.pop(); },
  "unsorted-hotels": (r) => { r.hotels.reverse(); },
};
const tampered: Record<string, boolean> = {};
for (const [k, mutate] of Object.entries(mutations)) {
  const r = structuredClone(records) as T.Records;
  mutate(r);
  tampered[k] = T.verify(r, checkin).ok;
}
check("tampered(6 种)", tampered, py["tampered"]);

// 报告正文：writeReport 落盘后再读回，逐字节比对
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctrip-parity-"));
const out = T.writeReport(records, ver, tmp);
const reportText = fs.readFileSync(out, "utf-8");
check("CTRIP_RESULT.md (逐字节)", reportText, py["report"], true);
fs.rmSync(tmp, { recursive: true, force: true });

if (failed) {
  console.log(`\nVERDICT: ${failed} 项与 Python 参考实现不一致（${passed} 项一致）`);
  process.exit(1);
}
console.log(`\nVERDICT: ${passed} 项全部与 Python 参考实现一致（含 dump_js 与报告的逐字节相等）`);
