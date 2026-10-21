/**
 * 数据源引擎跨实现对拍：用 **TS 引擎**在 Python 参考实现（`ts/tools/gen_datasource_corpus.py`）
 * 刚刚跑过的同一批 fixture + 同一批配置上重算，逐项比对。任何漂移都打印差异并以 1 退出。
 *
 *   python3 ts/tools/gen_datasource_corpus.py      # 先用 Python 引擎生成语料
 *   cd ts && node --experimental-strip-types tools/datasource-parity.ts
 *
 * 覆盖：路径语言 + 七算子、field_value、日期表达式（含报错文案）、next_week_dates、
 * default_dates(列表形态)、in_window / matches / blocked、select_best / count_rows /
 * audit_rows、validate_source（逐条问题文案），以及两个真实 source 配置的
 * url_for / date_params / extract / counts / audits / selects / report_markdown。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as D from "../src/data/datasource.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..");
const corpusPath = path.join(here, "datasource-corpus.json");
const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf-8")) as any;

let checks = 0;
let bad = 0;

/** 规范化深比较（对象键排序；null/undefined 等价）。 */
function canon(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

function short(v: unknown, n = 220): string {
  const s = JSON.stringify(v);
  if (s === undefined) return String(v);
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s;
}

function eq(label: string, got: unknown, want: unknown): void {
  checks++;
  if (canon(got) === canon(want)) return;
  bad++;
  console.log(`DIFF ${label}`);
  console.log(`  ts  = ${short(got)}`);
  console.log(`  py  = ${short(want)}`);
}

function eqStr(label: string, got: string, want: string): void {
  checks++;
  if (got === want) return;
  bad++;
  console.log(`DIFF ${label}`);
  const g = got.split("\n");
  const w = want.split("\n");
  for (let i = 0; i < Math.max(g.length, w.length); i++) {
    if (g[i] !== w[i]) {
      console.log(`  line ${i + 1} ts = ${JSON.stringify(g[i])}`);
      console.log(`  line ${i + 1} py = ${JSON.stringify(w[i])}`);
      break;
    }
  }
}

function throws(label: string, fn: () => unknown, wantMsg: string): void {
  checks++;
  try {
    const v = fn();
    bad++;
    console.log(`DIFF ${label}: 期待抛错 ${JSON.stringify(wantMsg)}，却返回 ${short(v)}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg !== wantMsg) {
      bad++;
      console.log(`DIFF ${label}\n  ts  = ${JSON.stringify(msg)}\n  py  = ${JSON.stringify(wantMsg)}`);
    }
  }
}

/* ---------------------------------------------------------------- engine cases */

const E = corpus.engine;

for (const c of E.resolve) eq(`resolve(${c.path})`, D.resolve(c.obj, c.path), c.expected);
for (const c of E.apply_ops) eq(`applyOps(${JSON.stringify(c.ops)})`, D.applyOps(c.value, c.ops), c.expected);
for (const c of E.apply_ops_errors) {
  throws(`applyOps-error ${JSON.stringify(c.ops)}`, () => D.applyOps(c.value, c.ops), c.error);
}
for (const c of E.field_value) {
  eq(`fieldValue(${short(c.spec, 60)})`, D.fieldValue(c.row, c.spec), c.expected);
}
for (const c of E.date_expr) eq(`dateExpr(${c.expr},${c.date})`, D.dateExpr(c.expr, c.date, c.today), c.expected);
for (const c of E.date_expr_errors) {
  throws(`dateExpr-error(${c.expr})`, () => D.dateExpr(c.expr, c.date, c.today), c.error);
}
for (const c of E.next_week_dates) eq(`nextWeekDates(${c.today})`, D.nextWeekDates(c.today), c.expected);
for (const c of E.default_dates) eq("defaultDates(list)", D.defaultDates(c.source as D.Source), c.expected);
for (const c of E.in_window) eq(`inWindow(${c.t},${c.lo},${c.hi})`, D.inWindow(c.t, c.lo, c.hi), c.expected);
for (const c of E.matches) eq(`matches(${short(c.where, 40)})`, D.matches(c.row, c.where), c.expected);
for (const c of E.blocked) {
  eq(`blocked(code=${c.code})`, D.blocked(c.source as D.Source, c.code, c.body), c.expected);
}
for (const c of E.select_best) {
  eq(`selectBest(${short(c.sel, 50)})`, D.selectBest(c.rows, c.source as D.Source, c.sel), c.expected);
}
for (const c of E.count_rows) {
  eq(`countRows(${short(c.spec, 40)})`, D.countRows(c.rows, c.source as D.Source, c.spec), c.expected);
}
for (const c of E.audit_rows) eq(`auditRows(${short(c.spec, 50)})`, D.auditRows(c.rows, c.spec), c.expected);
for (const c of E.validate) {
  const got = D.validateSource(c.source as D.Source);
  checks++;
  if (canon(got) !== canon(c.expected)) {
    bad++;
    console.log(`DIFF validate(${c.name})`);
    for (let i = 0; i < Math.max(got.length, c.expected.length); i++) {
      if (got[i] !== c.expected[i]) {
        console.log(`  [${i}] ts = ${JSON.stringify(got[i])}`);
        console.log(`  [${i}] py = ${JSON.stringify(c.expected[i])}`);
      }
    }
  }
}

/* ---------------------------------------------------------------- source cases */

for (const sc of corpus.sources) {
  const cfg = sc.config as D.Source;
  const html = fs.readFileSync(path.join(REPO, sc.fixture), "utf-8");
  const tag = sc.name;

  for (const u of sc.url_for) eq(`${tag} urlFor(${u.date})`, D.urlFor(cfg, u.date, sc.today), u.url);
  for (const dp of sc.date_params) {
    eq(`${tag} dateParams(${dp.date})`, D.dateParams(cfg, dp.date, sc.today), dp.params);
  }

  const page = D.extract(html, cfg);
  const first = sc.pages[0];
  eq(`${tag} extract.date`, page.date, first.page_date);
  eq(`${tag} extract.strip`, page.strip, first.strip);
  eq(`${tag} extract.rows_count`, page.rows.length, first.rows_count);
  eq(`${tag} extract.rows`, page.rows, first.rows);

  const perDate: Record<string, Record<string, unknown>> = {};
  for (const p of sc.pages) {
    const counts: Record<string, number> = {};
    for (const c of (cfg.counts || [])) counts[String(c.key)] = D.countRows(page.rows, cfg, c);
    const audits: Record<string, number> = {};
    for (const a of (cfg.audits || [])) audits[String(a.key)] = D.auditRows(page.rows, a);
    const selects: Record<string, unknown> = {};
    for (const s of (cfg.selects || [])) selects[String(s.key)] = D.selectBest(page.rows, cfg, s);
    eq(`${tag} counts[${p.date}]`, counts, p.counts);
    eq(`${tag} audits[${p.date}]`, audits, p.audits);
    eq(`${tag} selects[${p.date}]`, selects, p.selects);
    perDate[p.date] = { rows: page.rows, counts, audits, selects };
  }
  eqStr(`${tag} reportMarkdown`, D.reportMarkdown(cfg, perDate as never), sc.report_markdown);
  eqStr(`${tag} reportMarkdown(rendered)`,
    D.reportMarkdown(cfg, perDate as never, corpus.fake_rendered), sc.report_markdown_rendered);
}

/* ---------------------------------------------------------------- verdict */

const sourcePages = corpus.sources.reduce((n: number, s: any) => n + s.pages.length, 0);
if (bad) {
  console.log(`\nVERDICT: ${bad}/${checks} 项与 Python 参考不一致`);
  process.exit(1);
}
console.log(`VERDICT: datasource 引擎与 Python 参考在 ${checks} 项上逐项一致`
  + `（${corpus.sources.length} 个 source 配置 / ${sourcePages} 个日期页，含完整 report_markdown 文本）`);
