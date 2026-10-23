/**
 * **探针基线**：把"上一次真实探测测出来的判决"写进应用包，并检查它有没有漂移。
 *
 * 为什么需要它：探针集（`apps/*-live/pack.json` 的 `probe` 块）声明的是**输入**——要测哪些 URL、
 * 哪些文本算风控词、怎么认登录墙。判决（`BLOCKED` / `LOGIN_REQUIRED` / `captured`）是**测出来的**，
 * 以前只活在探针驱动打印的 reason 里和一份复测报告里。于是"站点变了"这件事只能靠人再读一遍报告。
 *
 * 现在：基线把判决记进包里，`--check` 拿它与**已入库的探测记录**比。漂移只有两种可能——站点变了
 * （该重新跑一次探针、更新基线），或者有人手改了包（那就更该变红）。
 *
 *   npm run probes:baseline -- --check                       # 门禁口径（对已入库的复测记录）
 *   npm run probes:baseline -- --write                       # 用记录刷新基线
 *   npm run probes:baseline -- --from <新的探针结果.json> --write   # 用一次新探测刷新
 *
 * 基线只存**标量观察**（判决 / 布尔 / 计数 / 一句短事实），不存 `*_reason`：那是测量叙述，已经在
 * `bench/live-retest/REPORT.md` 的冻结语料里；把它复制进包只会制造第二份会漂移的散文。
 */
import fs from "node:fs";
import { isParseUsageError, stripArgSeparators, usageErrorLine } from "../src/support/cli-args.ts";
import path from "node:path";
import { parseArgs } from "node:util";
import { appDirs, loadPack, type AppPack } from "../src/app/app-pack.ts";

export const REPO = path.resolve(import.meta.dirname, "..");
/** 默认的探测记录：已入库的线上复测（2026-10-03）。 */
export const DEFAULT_FROM = "bench/live-retest/2026-10-03/summary.json";

type Scalar = string | number | boolean;

/** 一个探针驱动的结果 → `{判决键: 值}`。四种驱动的形状不同，各自抽取，规则写在这里。 */
export function verdictsOf(entryKey: string, entry: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown): void => {
    if (/reason/i.test(k)) return;                       // 叙述不进基线（见文件头）
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = String(v);
    }
  };
  if (entryKey.includes("(qunar-probe)")) {
    // 形如 { "0": "curl-default-ua    captured       {\"code\":200,…,\"verdict\":\"captured\"}" }
    for (const [i, line] of Object.entries(entry as Record<string, unknown>)) {
      const text = String(line);
      const label = text.trim().split(/\s+/)[0] ?? `row-${i}`;
      const m = /\{.*\}/.exec(text);
      let v: unknown = null;
      try { v = m ? (JSON.parse(m[0]) as Record<string, unknown>)["verdict"] : null; } catch { v = null; }
      put(label, v ?? text.trim().split(/\s+/)[1] ?? "");
    }
    return out;
  }
  if (entryKey.includes("(live-capture)")) {
    const e = entry as { captured?: unknown; total?: unknown; verdicts?: Record<string, unknown> };
    put("captured", e.captured);
    put("total", e.total);
    for (const [k, v] of Object.entries(e.verdicts ?? {})) put(k, v);
    return out;
  }
  // live-probe / ota-probe：一个 verdict 对象，取标量
  const v = (entry as { verdict?: Record<string, unknown> }).verdict ?? {};
  for (const [k, val] of Object.entries(v)) {
    if (val !== null && typeof val === "object") continue;   // 嵌套结构（如 real_data_available）不进基线
    put(k, val);
  }
  return out;
}

export interface ProbeEntry { key: string; app: string; verdicts: Record<string, string> }

/** 从一份探测记录里读出每个应用的判决。 */
export function readRecord(file: string): ProbeEntry[] {
  const j = JSON.parse(fs.readFileSync(path.resolve(REPO, file), "utf-8")) as {
    probes?: Record<string, unknown>;
  };
  const out: ProbeEntry[] = [];
  for (const [key, entry] of Object.entries(j.probes ?? {})) {
    const app = key.replace(/^apps\//, "").replace(/ \(.*$/, "");
    const verdicts = verdictsOf(key, entry);
    const prev = out.find((x) => x.app === app);
    if (prev) Object.assign(prev.verdicts, verdicts);        // 同一个应用多个驱动 → 合并
    else out.push({ key, app, verdicts });
  }
  return out;
}

export function baselineOf(pack: AppPack): Record<string, string> {
  const b = (pack as { probe?: { baseline?: { verdicts?: Record<string, string> } } }).probe?.baseline;
  return b?.verdicts ?? {};
}

export interface Diff { app: string; missing: string[]; changed: string[]; extra: string[] }

/** 包里的基线与记录不一致的地方（`missing` = 记录里有、包里没有）。 */
export function diffPack(pack: AppPack, recorded: Record<string, string>): Diff {
  const declared = baselineOf(pack);
  const missing = Object.keys(recorded).filter((k) => !(k in declared));
  const changed = Object.keys(recorded).filter((k) => k in declared && declared[k] !== recorded[k]);
  const extra = Object.keys(declared).filter((k) => !(k in recorded));
  return { app: pack.id, missing, changed, extra };
}

export function renderDiff(d: Diff, recorded: Record<string, string>, declared: Record<string, string>): string[] {
  const lines: string[] = [];
  for (const k of d.missing) lines.push(`    + ${k}: 记录里是 ${JSON.stringify(recorded[k])}，包里的基线没有它`);
  for (const k of d.changed) lines.push(`    ≠ ${k}: 包里 ${JSON.stringify(declared[k])} → 记录 ${JSON.stringify(recorded[k])}`);
  for (const k of d.extra) lines.push(`    - ${k}: 包里有但记录里没有（探针已经不再产出这一项？）`);
  return lines;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let values;
  // 打错的参数 → 一行点名，绝不甩 parseArgs 的堆栈（src/support/cli-args.ts 的体例）。
  try {
    ({ values } = parseArgs({
    args: stripArgSeparators(argv),
    options: {
      write: { type: "boolean" }, check: { type: "boolean" }, from: { type: "string" },
      app: { type: "string" }, quiet: { type: "boolean" }, help: { type: "boolean" },
    },
  }));
  } catch (err) {
    if (!isParseUsageError(err)) throw err;
    console.error(usageErrorLine(err));
    return 2;
  }
  if (values.help || (!values.write && !values.check)) {
    console.log(`usage: probes-baseline [--check] [--write] [--from <探针结果.json>] [--app <id>] [--quiet]

  --check   包里记录的判决 vs 已入库的探测记录（漂移 = 站点变了，或有人手改了包）
  --write   用探测记录刷新包里 \`probe.baseline.verdicts\`
  --from    探测记录路径（默认 ${DEFAULT_FROM}）
  --app     只处理某个应用

退出码：0=一致 ｜ 1=有漂移 ｜ 2=用法错误`);
    return values.help ? 0 : 2;
  }
  const from = values.from ?? DEFAULT_FROM;
  const record = readRecord(from);
  const only = values.app ? [values.app] : null;
  const packs = appDirs()
    .map((dir) => loadPack(path.join(dir, "pack.json")))
    .filter((p) => (p as { probe?: unknown }).probe !== undefined)
    .filter((p) => !only || only.includes(p.id));

  if (values.write) {
    let wrote = 0;
    for (const pack of packs) {
      const rec = record.find((r) => r.app === pack.id);
      if (!rec) { if (!values.quiet) console.log(`- ${pack.id}：记录里没有它的探测结果，跳过`); continue; }
      const probe = (pack as { probe: Record<string, unknown> }).probe;
      probe["baseline"] = { verdicts: rec.verdicts };
      const file = path.join(REPO, "apps", pack.id, "pack.json");
      const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
      const rawProbe = raw["probe"] as Record<string, unknown>;
      rawProbe["baseline"] = { verdicts: rec.verdicts };
      fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
      wrote++;
      if (!values.quiet) {
        console.log(`已写入 apps/${pack.id}/pack.json ← ${from}（${Object.keys(rec.verdicts).length} 项判决）`);
      }
    }
    console.log(`probes:baseline：更新了 ${wrote} 个应用包`);
    return 0;
  }

  // --check
  let bad = 0;
  for (const pack of packs) {
    const rec = record.find((r) => r.app === pack.id);
    if (!rec) { console.error(`✗ ${pack.id}：探测记录里没有它（${from}）`); bad++; continue; }
    const d = diffPack(pack, rec.verdicts);
    if (d.missing.length || d.changed.length || d.extra.length) {
      bad++;
      console.error(`✗ ${pack.id}（记录：${from}）`);
      for (const l of renderDiff(d, rec.verdicts, baselineOf(pack))) console.error(l);
    } else if (!values.quiet) {
      console.log(`✓ ${pack.id.padEnd(14)} ${Object.keys(rec.verdicts).length} 项判决与记录一致`);
    }
  }
  console.log(`probes:baseline：${packs.length - bad}/${packs.length} 个探针应用与探测记录一致`
    + (bad ? "  ← 站点变了就重跑探针并 --write；有人手改了包也会在这里变红" : ""));
  return bad ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exit(await main());
}
