/**
 * 数据源引擎 — `datasource.py` 的 TypeScript 逐语义移植。
 *
 * 把"从站点取数"变成**配置**（`<site>/sources/*.json`）而不是脚本：URL 模板、
 * 日期参数怎么算、从哪取行、每个字段的路径与算子、时间窗、选优规则、报告列与
 * 说明，全部是配置。引擎自己**不认识任何站点**（见 tests/datasource.test.ts 的
 * "引擎无站点知识"测试：读本文件源码、剥掉块注释后 grep 站点词）。
 *
 * 结构（与 Python 版一一对应）：
 *   - 传输：`curl` 走子进程、`httpx` 走 Node 18+ 全局 fetch；
 *   - 路径语言 `resolve`：`a.b` / `[0]` / `[-1]` / `[]`（对列表逐项继续）；
 *   - 七算子 `applyOps`：`time|join:<sep>|len|len-1|int|str|strip`；
 *   - 两个抽取器：`jsonInScript`（HTML 里的 `var/window.X = {...}`）与
 *     `htmlRegex`（`split` 分组 + 每字段单捕获组）；
 *   - 日期表达式 `date|day_offset|weekday_cn`、`date±Nday`、`nextWeekDates`、
 *     `defaultDates`；`urlFor` / `fetchSource` / `blocked`；
 *   - `inWindow` / `matches` / `selectBest` / `countRows` / `auditRows`；
 *   - `reportMarkdown` / `runSource` / `main`(CLI)。
 *
 * ## 为什么 curl 仍然是子进程（不换成 fetch/浏览器）
 *
 * m.ctrip.com 的 WhaleGuard 按**客户端指纹**打分，实测同一 URL：
 * curl（默认 UA）200、curl+iPhone UA 200、curl+Chrome UA 432、httpx 432、
 * Chromium / Playwright `context.request` 432。所以"能取到页面"这件事恰好只
 * 发生在 curl 的默认指纹上 —— 这是站点事实，但**传输实现本身是通用的**：
 * 引擎只知道"有一种客户端叫 curl"。`httpx` 那一档在 Node 里就是全局 fetch
 * （Python 版是 `httpx.get(..., follow_redirects=True)`，Node fetch 默认跟随重定向）。
 *
 * ## 与 Python 的有意偏差（详见 parity 报告）
 *
 * 1. 本文件在 `ts/src/` 下，所以仓库根是 `HERE/../..`（Python 的 `HERE` 就是仓库根）。
 *    两者都用"发现制"扫描仓库根下每个站点目录里的 sources 子目录，语义相同。
 * 2. ESM 里 `import.meta.url` 一定是绝对路径，所以 `_path` / `listSources` 路径是绝对
 *    路径；Python 用 `python3 datasource.py` 调用时给的是相对路径。语料生成器把两边的
 *    `_path` 都固定成仓库相对串，避免路径形态污染对拍。
 * 3. `JSON.parse` 不接受 `NaN` / `Infinity` 字面量，而 Python `json.loads` 接受。
 *    真实 fixture 不含这两者。
 * 4. JS number 不区分 int/float：`str(1.0)` 在 Python 是 `"1.0"`、在这里是 `"1"`；
 *    超过 2^53 的整数也会掉精度。配置里的字段都是字符串或小整数，不受影响。
 * 5. Python `\d`/`\w`/`\s` 默认匹配 Unicode；JS 正则的 `\d` 只匹配 ASCII 数字，
 *    `\s` 集合略有差异。配置文件里的正则都只用 `\d` 匹配 ASCII 数字。
 * 6. `str.format` 只实现了 `{name}`、`{name!r}`、`{name!s}` 与 `{{`/`}}` 转义；
 *    位置参数、属性/下标访问与 `:format_spec` 未实现（配置模板未用到）。
 * 7. Python `re.escape` 与本地 `escapeRegExp` 转义集合不同（都保证字面量语义）。
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { pyJsonDumps } from "./laya-format.ts";

/** 本文件所在目录（`ts/src`）。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根：Python 版 `HERE = pathlib.Path(__file__).parent` 就是仓库根。 */
const REPO = path.resolve(HERE, "..");

/* ---------------------------------------------------------------- 类型 */

export type Row = Record<string, unknown>;

/** 一份数据源配置（`<site>/sources/<name>.json`），加 `_path`。 */
export interface Source {
  name?: string;
  label?: string;
  transport?: Record<string, any>;
  constants?: Record<string, any>;
  default_dates?: unknown;
  date?: { params?: Record<string, any> };
  extract?: Record<string, any>;
  filters?: Record<string, any>;
  counts?: Array<Record<string, any>>;
  audits?: Array<Record<string, any>>;
  selects?: Array<Record<string, any>>;
  report?: Record<string, any>;
  _path?: string;
  [k: string]: unknown;
}

/** 抽取结果：日期、可点日期条、行。 */
export interface Page {
  date: unknown;
  strip: unknown;
  rows: Row[];
}

export interface Rendered {
  elements: number;
  snapshot: string;
  text?: string;
  title: string;
}

export interface DateEntry {
  url: string;
  page_date?: unknown;
  strip?: unknown;
  rows?: Row[];
  counts?: Record<string, number>;
  audits?: Record<string, number>;
  selects?: Record<string, Row | null>;
  error?: string;
}

export interface RunResult {
  source: unknown;
  fetched_at: string;
  dates: Record<string, DateEntry>;
  rendered: Record<string, unknown>;
}

/* ---------------------------------------------------------------- 错误（对齐 Python 异常类型） */

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileNotFoundError";
  }
}

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

/* ---------------------------------------------------------------- Python 语义小工具 */

function hasOwn(o: unknown, k: string): boolean {
  return o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k);
}

/** Python `dict.get(k, d)`：键存在（哪怕是 null）就取它。 */
function getOr<T>(o: unknown, k: string, dflt: T): unknown {
  return hasOwn(o, k) ? (o as Record<string, unknown>)[k] : dflt;
}

function isDict(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Python 真值判断：NaN 是**真**，0/-0/""/[]/{} 是假。 */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return true;
}

/** Python `str()`。 */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return String(v);
  }
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (isDict(v)) {
    return "{" + Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ") + "}";
  }
  return String(v);
}

/** Python `repr()`（字符串的引号选择与 Python 一致：含单引号且不含双引号时用双引号）。 */
export function pyRepr(v: unknown): string {
  if (typeof v === "string") {
    if (v.includes("'") && !v.includes('"')) {
      return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    }
    return "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  }
  return pyStr(v);
}

/** Python 元组 repr：`('curl', 'httpx')`。 */
function pyTuple(items: readonly unknown[]): string {
  const body = items.map(pyRepr).join(", ");
  return "(" + body + (items.length === 1 ? "," : "") + ")";
}

/** Python `str(value or "")`：先真值判断（假值 -> ""），再 `str`。 */
export function strOrEmpty(v: unknown): string {
  return pyTruthy(v) ? pyStr(v) : "";
}

/** Python `int(value)`：失败返回 null（对应 Python 抛 TypeError/ValueError 被吞）。 */
export function pyInt(v: unknown): number | null {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!/^[+-]?\d(?:_?\d)*$/.test(s)) return null;
    const parsed = Number(s.replace(/_/g, ""));
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

/** Python `len()`：只对 list/str 有值（str 按码点计数）。 */
export function pyLen(v: unknown): number | null {
  if (typeof v === "string") return Array.from(v).length;
  if (Array.isArray(v)) return v.length;
  return null;
}

/** Python 迭代：list -> 项，str -> 字符，dict -> 键，None -> 空。 */
function pyIterate(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return Array.from(v);
  if (isDict(v)) return Object.keys(v);
  return []; // 数字/布尔在 Python 会抛 TypeError；这里退化为空序列（配置不会走到）
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  if (isDict(v)) return "dict";
  return typeof v;
}

/** Python 字符串比较：按 Unicode 码点。 */
export function pyStrCmp(a: string, b: string): number {
  const A = Array.from(a);
  const B = Array.from(b);
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const ca = A[i]!.codePointAt(0)!;
    const cb = B[i]!.codePointAt(0)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return A.length === B.length ? 0 : A.length < B.length ? -1 : 1;
}

/** Python `<` 的比较语义（数值含 bool；字符串按码点；其余抛 TypeError）。 */
function pyCompare(a: unknown, b: unknown): number {
  const num = (v: unknown): number | null =>
    typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? v : null;
  const na = num(a);
  const nb = num(b);
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") return pyStrCmp(a, b);
  throw new TypeError(`'<' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/** Python 元组比较（逐项，先到先判）。 */
function pyCompareTuple(a: readonly unknown[], b: readonly unknown[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = pyCompare(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/* ---------------------------------------------------------------- 源目录发现 */

/**
 * 引擎不认识任何站点：仓库根下每个站点目录里的 sources 子目录都是合法的源配置目录
 * （发现制），新增站点目录零引擎改动。要指向别处时给 `loadSource`/`listSources`
 * 显式传 dirs。
 */
export function sourceDirs(): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(REPO);
  } catch {
    entries = [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const p = path.join(REPO, name, "sources");
    try {
      if (fs.statSync(p).isDirectory()) out.push(p);
    } catch {
      /* 不是目录 */
    }
  }
  return out.sort();
}

/* ---------------------------------------------------------------- 传输 */

export type Client = (url: string, timeout?: number) => Promise<[number, string]>;

/**
 * 用 curl 子进程取页面。
 *
 * **不要换成 fetch/浏览器**：WhaleGuard 按客户端指纹打分，实测同一 URL ——
 * curl（默认 UA）200、curl+iPhone UA 200、curl+Chrome UA 432、httpx 432、
 * Chromium / Playwright `context.request` 432。传输实现本身是通用的：引擎只知道
 * "有一种客户端叫 curl"，为什么必须是它写在注释里，而不是写进代码分支。
 */
export async function curlGet(url: string, timeout = 60.0): Promise<[number, string]> {
  const res = spawnSync(
    "curl",
    ["-s", "-o", "-", "-w", "\n%{http_code}", "--max-time", String(Math.trunc(timeout)), url],
    { encoding: "utf8", maxBuffer: 1 << 28, timeout: (timeout + 10) * 1000 },
  );
  if (res.error) throw res.error;                  // 对应 Python TimeoutExpired / FileNotFoundError
  const stdout = typeof res.stdout === "string" ? res.stdout : "";
  // Python: body, _, code = stdout.rpartition("\n")
  const idx = stdout.lastIndexOf("\n");
  const body = idx === -1 ? "" : stdout.slice(0, idx);
  const codeStr = idx === -1 ? stdout : stdout.slice(idx + 1);
  const code = codeStr === "" ? 0 : Number(codeStr);
  if (!Number.isFinite(code) || !Number.isInteger(code)) {
    throw new ValueError(`invalid literal for int() with base 10: ${pyRepr(codeStr)}`);
  }
  return [code, body];
}

/** httpx 那一档在 Node 里就是全局 fetch（默认跟随重定向）。 */
export async function httpxGet(url: string, timeout = 60.0): Promise<[number, string]> {
  const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeout * 1000) });
  return [r.status, await r.text()];
}

export const CLIENTS: Record<string, Client> = { curl: curlGet, httpx: httpxGet };

/* ---------------------------------------------------------------- 路径语言 */

const HEAD = /^([A-Za-z0-9_-]*)((?:\[-?\d*\])*)$/;
const INDEX = /\[(-?\d*)\]/g;

function nn(v: unknown): unknown {
  return v === undefined ? null : v;
}

/** `a.b.c` / `[0]` / `[-1]` / `[]`（对列表逐项继续）。取不到就返回 null。 */
export function resolve(obj: unknown, p: string): unknown {
  if (!p) return nn(obj);
  const dot = p.indexOf(".");
  const head = dot === -1 ? p : p.slice(0, dot);
  const rest = dot === -1 ? "" : p.slice(dot + 1);
  const m = HEAD.exec(head);
  if (!m) return null;
  const name = m[1]!;
  const idx = m[2]!;
  let cur: unknown = obj;
  if (name) {
    if (!isDict(cur)) return null;
    cur = hasOwn(cur, name) ? nn(cur[name]) : null;      // dict.get[name] -> None
  }
  for (const im of idx.matchAll(INDEX)) {
    const raw = im[1]!;
    if (raw === "") {                                    // [] -> 映射到每一项
      if (!Array.isArray(cur)) return null;
      return rest ? cur.map((x) => resolve(x, rest)) : cur;
    }
    if (!Array.isArray(cur)) return null;
    const i = Number(raw);
    const picked = i < 0 ? cur[cur.length + i] : cur[i];
    if (picked === undefined) return null;               // IndexError
    cur = picked;
  }
  return rest ? resolve(cur, rest) : nn(cur);
}

/* ---------------------------------------------------------------- 算子 */

export const TRANSPORTS = ["curl", "httpx"] as const;
export const EXTRACT_KINDS = ["json_in_script", "html_regex"] as const;
export const OPS = ["time", "join", "len", "len-1", "int", "str", "strip"] as const; // join:<sep> 带参数
export const DATE_EXPRS = ["date", "day_offset", "weekday_cn"] as const;

/** 七算子（`join:<sep>` 带参）。未知算子抛 ValueError。 */
export function applyOps(value: unknown, ops: readonly unknown[]): unknown {
  let v = value;
  for (const rawOp of ops) {
    const op = pyStr(rawOp);
    if (op === "time") {                                  // "2026-10-09 15:30:00" -> "15:30"
      v = strOrEmpty(v).slice(11, 16);
    } else if (op === "strip") {
      v = strOrEmpty(v).trim();
    } else if (op === "int") {
      v = pyInt(v);
    } else if (op === "str") {
      v = v === null || v === undefined ? "" : pyStr(v);
    } else if (op === "len") {
      v = Array.isArray(v) || typeof v === "string" ? pyLen(v) : null;
    } else if (op === "len-1") {
      v = Array.isArray(v) && v.length > 0 ? v.length - 1 : null;
    } else if (op.startsWith("join:")) {
      const sep = op.slice(op.indexOf(":") + 1);
      v = Array.isArray(v) ? v.map(pyStr).join(sep) : v;
    } else {
      throw new ValueError(`unknown op ${pyRepr(op)} (known: ${OPS.join(", ")})`);
    }
  }
  return v;
}

/** 字段说明：`"path|ops"` 字符串，或 `{"path","ops","compare_day_with"}`。 */
export function fieldValue(row: unknown, spec: unknown): unknown {
  if (typeof spec === "string") {
    const bar = spec.indexOf("|");
    const p = bar === -1 ? spec : spec.slice(0, bar);
    const rest = bar === -1 ? "" : spec.slice(bar + 1);
    return applyOps(resolve(row, p), rest ? rest.split("|") : []);
  }
  if (!isDict(spec)) throw new TypeError(`field spec must be str or dict, got ${pyTypeName(spec)}`);
  if (!hasOwn(spec, "path")) throw new KeyError(pyRepr("path"));
  const p = pyStr(spec["path"]);
  let val = applyOps(resolve(row, p), (getOr(spec, "ops", []) as unknown[]) || []);
  const ref = spec["compare_day_with"];
  if (pyTruthy(ref)) {                                    // 到达日期与出发日期不同 -> 标 +1
    const a = strOrEmpty(resolve(row, p));
    const b = strOrEmpty(resolve(row, pyStr(ref)));
    if (a.slice(0, 10) && b.slice(0, 10) && a.slice(0, 10) !== b.slice(0, 10)) {
      val = `${pyStr(val)}+1`;
    }
  }
  return val;
}

export function rowOf(obj: unknown, fields: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(fields)) out[k] = fieldValue(obj, v);
  return out;
}

/* ---------------------------------------------------------------- 抽取器 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsonInScript(html: string, spec: Record<string, any>): Page {
  if (!hasOwn(spec, "var")) throw new KeyError(pyRepr("var"));   // 不给默认值：站点知识只能来自配置
  const varName = pyStr(spec["var"]);
  const m = new RegExp(escapeRegExp(varName) + "\\s*=\\s*(\\{.*?\\});", "s").exec(html);
  if (!m) {
    throw new ValueError(`${varName} not found in page (blocked, or a different page shape?)`);
  }
  const state: unknown = JSON.parse(m[1]!);
  if (!hasOwn(spec, "fields")) throw new KeyError(pyRepr("fields"));
  if (!hasOwn(spec, "rows")) throw new KeyError(pyRepr("rows"));
  const fields = spec["fields"] as Record<string, unknown>;
  const rawRows = resolve(state, pyStr(spec["rows"]));
  const rows = (pyTruthy(rawRows) ? pyIterate(rawRows) : []).map((x) => rowOf(x, fields));
  const rawDate = resolve(state, pyStr(getOr(spec, "date", "")));
  const rawStrip = resolve(state, pyStr(getOr(spec, "strip", "")));
  return { date: pyTruthy(rawDate) ? rawDate : "", strip: pyTruthy(rawStrip) ? rawStrip : [], rows };
}

function htmlRegex(html: string, spec: Record<string, any>): Page {
  const split = spec["split"];
  const blocks: string[] = pyTruthy(split) ? html.split(pyStr(split)).slice(1) : [html];
  const fields = (spec["fields"] || {}) as Record<string, string>;
  const rows: Row[] = [];
  for (const b of blocks) {
    const row: Row = {};
    for (const [k, pat] of Object.entries(fields)) {
      const m = new RegExp(pat, "s").exec(b);
      if (!m) {
        row[k] = "";
      } else if (m[1] === undefined) {
        throw new ValueError(`regex group 1 did not participate for field ${pyRepr(k)}`);
      } else {
        row[k] = m[1].trim();
      }
    }
    if (Object.values(row).some(pyTruthy)) rows.push(row);
  }
  return { date: getOr(spec, "date", "") as unknown, strip: [], rows };
}

export const EXTRACTORS: Record<string, (html: string, spec: Record<string, any>) => Page> = {
  json_in_script: jsonInScript,
  html_regex: htmlRegex,
};

export function extract(html: string, source: Source): Page {
  const ex = source["extract"] as Record<string, any>;
  if (!hasOwn(ex, "kind")) throw new KeyError(pyRepr("kind"));
  const fn = EXTRACTORS[pyStr(ex["kind"])];
  if (!fn) throw new KeyError(pyRepr(ex["kind"]));
  return fn(html, ex);
}

/* ---------------------------------------------------------------- 日期与 URL */

export type DateLike = string | Date;

const WEEKDAYS_CN = "周一周二周三周四周五周六周日";

function dateToEpochDay(d: DateLike): number {
  if (d instanceof Date) {
    const ms = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.floor(ms / 86400000);
  }
  const s = String(d).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) throw new ValueError(`Invalid isoformat string: ${pyRepr(String(d))}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  if (mo < 1 || mo > 12) throw new ValueError("month must be in 1..12");
  const ms = Date.UTC(y, mo - 1, day);
  const probe = new Date(ms);
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== day) {
    throw new ValueError("day is out of range for month");
  }
  return Math.floor(ms / 86400000);
}

function epochDayToIso(n: number): string {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

function todayEpochDay(): number {
  const now = new Date();
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000);
}

/**
 * Today in local time as `YYYY-MM-DD`. `LAYA_TODAY=YYYY-MM-DD` PINS it.
 *
 * Why a pin exists: the frozen cross-runtime corpora contain a human-readable
 * 「执行日期」line, so a byte-comparison against them silently expires at midnight —
 * measured: the ctrip parity layer went 10/10 -> 9/10 on 2026-10-03 purely because the
 * reference corpus was generated on 2026-10-02. CI must not depend on the wall clock, so
 * the parity tools pin the clock to the day their corpus was generated. A malformed pin
 * is ignored rather than trusted.
 */
export function todayIso(override?: string | null): string {
  const pinned = override ?? process.env.LAYA_TODAY;
  if (pinned && /^\d{4}-\d{2}-\d{2}$/.test(pinned)) return pinned;
  return epochDayToIso(todayEpochDay());
}

/** Python `date.weekday()`：周一 0 … 周日 6。 */
function pyWeekday(epochDay: number): number {
  return (((epochDay + 3) % 7) + 7) % 7;
}

/** `date` | `date+Nday` | `date-Nday` | `day_offset` | `weekday_cn`。 */
export function dateExpr(expr: string, date: string, today: DateLike): string | number {
  const d = dateToEpochDay(date);                        // 先解析日期（Python 亦然）
  if (expr === "date") return date;
  if (expr === "day_offset") return d - dateToEpochDay(today);
  if (expr === "weekday_cn") {
    const w = pyWeekday(d);
    return WEEKDAYS_CN.slice(w * 2, w * 2 + 2);
  }
  const m = /^date([+-])(\d+)day$/.exec(expr);
  if (m) {
    const days = Number(m[2]) * (m[1] === "+" ? 1 : -1);
    return epochDayToIso(d + days);
  }
  throw new ValueError(`unknown date expression ${pyRepr(expr)} (known: ${DATE_EXPRS.join(", ")}, date±Nday)`);
}

export function dateParams(source: Source, date: string, today?: DateLike | null): Record<string, unknown> {
  const t: DateLike = today === undefined || today === null ? new Date() : today;
  const params: Record<string, unknown> = {};
  const decl = ((source["date"] as any) || {}).params || {};
  for (const [k, v] of Object.entries(decl as Record<string, string>)) {
    params[k] = dateExpr(v, date, t);
  }
  return { ...((source["constants"] as Record<string, unknown>) || {}), ...params };
}

/**
 * 今天所在周的下一个自然周的周一..周五（「下周工作日」的通用语义）。
 *
 * 今天是周五 -> 下周一..下周五。周日（weekday()==6）的下周一按次日算，与中文
 * 「下周」直觉一致。这是纯日历数学，所以是引擎级日期表达式。
 */
export function nextWeekDates(today?: DateLike | null): string[] {
  const t = today === undefined || today === null ? dateToEpochDay(todayIso()) : dateToEpochDay(today);
  const wd = pyWeekday(t);
  const daysToMon = wd !== 6 ? 7 - wd : 1;
  const mon = t + daysToMon;
  return [0, 1, 2, 3, 4].map((i) => epochDayToIso(mon + i));
}

/** `default_dates`：省略 -> 今天；列表 -> 原样；`"next_week"` -> 上面的具名表达式。 */
export function defaultDates(source: Source): string[] {
  const d = source["default_dates"];
  if (Array.isArray(d)) return d.map(pyStr);
  if (d === "next_week") return nextWeekDates();
  return [todayIso()];
}

class MissingKey extends Error {
  key: string;
  constructor(key: string) {
    super(key);
    this.name = "MissingKey";
    this.key = key;
  }
}

/** Python `str.format` 的最小实现：`{name}` / `{name!r}` / `{name!s}` / `{{` `}}`。 */
function pyFormat(tpl: string, mapping: Record<string, unknown>): string {
  let out = "";
  let i = 0;
  while (i < tpl.length) {
    const c = tpl[i]!;
    if (c === "{") {
      if (tpl[i + 1] === "{") { out += "{"; i += 2; continue; }
      const end = tpl.indexOf("}", i + 1);
      if (end === -1) throw new ValueError("Single '{' encountered in format string");
      let field = tpl.slice(i + 1, end);
      const bang = field.search(/[!]/);
      let conv: string | null = null;
      if (bang !== -1) {
        conv = field.slice(bang + 1, bang + 2);
        field = field.slice(0, bang);
      }
      const colon = field.indexOf(":");
      if (colon !== -1) field = field.slice(0, colon);
      const key = field.split(/[.[]/)[0]!;
      if (key === "") throw new ValueError("Format string contains positional fields, which are not supported");
      if (!hasOwn(mapping, key)) throw new MissingKey(key);
      const v = mapping[key];
      out += conv === "r" ? pyRepr(v) : conv === "s" ? pyStr(v) : pyStr(v);
      i = end + 1;
      continue;
    }
    if (c === "}") {
      if (tpl[i + 1] === "}") { out += "}"; i += 2; continue; }
      throw new ValueError("Single '}' encountered in format string");
    }
    out += c;
    i++;
  }
  return out;
}

export function urlFor(source: Source, date: string, today?: DateLike | null): string {
  const tr = source["transport"] as Record<string, unknown>;
  if (!hasOwn(tr, "url_template")) throw new KeyError(pyRepr("url_template"));
  const tpl = pyStr(tr["url_template"]);
  try {
    return pyFormat(tpl, dateParams(source, date, today));
  } catch (e) {
    if (e instanceof MissingKey) {
      throw new ValueError(`url_template needs a value for ${pyRepr(e.key)} (add it to constants/date.params)`);
    }
    throw e;
  }
}

/** Python `transport.client` 的默认值语义（键存在时即使为 null 也不算默认）。 */
function transportClient(source: Source): unknown {
  const tr = (source["transport"] as Record<string, unknown> | undefined) || {};
  return hasOwn(tr, "client") ? tr["client"] : "curl";
}

export async function fetchSource(source: Source, url: string, timeout = 60.0): Promise<[number, string]> {
  const client = transportClient(source);
  const fn = CLIENTS[pyStr(client)];
  if (!fn) throw new KeyError(pyRepr(client));
  return fn(url, timeout);
}

/**
 * HTTP 非 200，或响应体开头命中该 source 配置的 `transport.block_markers`。
 *
 * 哪个特征词代表「被风控挡住」是站点知识，归配置；引擎只做通用判断（非 200 即挡）。
 */
export function blocked(source: Source, code: number, body: string): boolean {
  const tr = (source["transport"] as Record<string, unknown> | undefined) || {};
  const raw = (tr["block_markers"] as unknown) || [];
  const markers = Array.isArray(raw) ? raw : [];
  const low = (body || "").slice(0, 400).toLowerCase();
  return code !== 200 || markers.some((m) => low.includes(pyStr(m).toLowerCase()));
}

/* ---------------------------------------------------------------- 筛选与选优 */

/** 闭区间（用例：早 8 点至晚 6 点）。 */
export function inWindow(t: unknown, lo: string, hi: string): boolean {
  if (!pyTruthy(t)) return false;
  const s = pyStr(t);
  return pyStrCmp(s, lo) >= 0 && pyStrCmp(s, hi) <= 0;
}

export function matches(row: Row, where: unknown): boolean {
  const w = (where || {}) as Record<string, unknown>;
  return Object.entries(w).every(([k, v]) => pyStr(row[k]) === pyStr(v));
}

function windowOf(source: Source): [string, string] {
  const f = (source["filters"] || {}) as Record<string, unknown>;
  const win = (hasOwn(f, "window") ? f["window"] : ["00:00", "23:59"]) as string[];
  return [win[0]!, win[1]!];
}

function poolOf(rows: Row[], source: Source, spec: Record<string, any>): Row[] {
  const f = (source["filters"] || {}) as Record<string, unknown>;
  const tf = f["time_field"];
  let pool = rows.filter((r) => matches(r, spec["where"]));
  if (pyTruthy(tf) && !pyTruthy(spec["ignore_window"])) {
    const [lo, hi] = windowOf(source);
    pool = pool.filter((r) => inWindow(r[pyStr(tf)], lo, hi));
  }
  return pool;
}

export function selectBest(rows: Row[], source: Source, sel: Record<string, any>): Row | null {
  const pool = poolOf(rows, source, sel);
  const keys = (sel["sort_by"] as string[] | undefined) || ["price"];
  let best: Row | null = null;
  let bestKey: unknown[] | null = null;
  for (const r of pool) {
    const key = keys.map((k) => (r[k] === null || r[k] === undefined ? 1 << 30 : r[k]));
    if (bestKey === null || pyCompareTuple(key, bestKey) < 0) {
      best = r;
      bestKey = key;
    }
  }
  return best;
}

/** 按配置核查数据质量：`{"field": "price", "empty": true}` -> 有多少行为空。 */
export function auditRows(rows: Row[], spec: Record<string, any>): number {
  const f = pyStr(spec["field"]);
  if (pyTruthy(spec["empty"])) {
    return rows.filter((r) => !strOrEmpty(getOr(r, f, "")).trim()).length;
  }
  const want = pyStr(getOr(spec, "equals", ""));
  return rows.filter((r) => pyStr(getOr(r, f, "")) === want).length;
}

export function countRows(rows: Row[], source: Source, spec: Record<string, any>): number {
  return poolOf(rows, source, spec).length;
}

/* ---------------------------------------------------------------- 渲染（真实 DOM → 执行器） */

/**
 * 把抓到的真实 HTML 交给真浏览器渲染，再让执行器的抽取层看一眼。
 *
 * 证明的是"执行器能在真实 DOM 上工作"：抓取走 curl（唯一能过风控的客户端），
 * 渲染与元素抽取走 harness 自己。playwright 只在调用时动态载入。
 *
 * `snapshot` 就是 `layaapp.snapshot_text` 的等价物：复用执行器自己的
 * `criteria_view` 渲染空间（`planner.snapshotText` 是同一个三行函数；这里直接
 * 复用 `extraction.criteriaView` 是为了让 `--render` 在 Node 的 strip-only 模式下
 * 也能跑 —— planner.ts 用了 Node 不支持剥离的参数属性）。
 */
export async function renderAndSnapshot(html: string): Promise<Rendered> {
  const pw: any = await import("playwright");
  const browserEnv: any = await import("./browser-env.ts");
  const extraction: any = await import("./extraction.ts");
  const b: any = await browserEnv.launch(pw, true);
  try {
    const pg: any = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await pg.setContent(html, { waitUntil: "domcontentloaded" });
    await pg.waitForTimeout(1500);
    const elems = await extraction.extractElements(pg);
    const snapshot = !elems || Object.keys(elems).length === 0
      ? ""
      : Object.values(extraction.criteriaView(elems, new Set(), null)).slice(0, 40).join("\n");
    return {
      elements: Object.keys(elems).length,
      snapshot,
      text: await extraction.pageText(pg),
      title: await pg.title(),
    };
  } finally {
    await b.close();
  }
}

/* ---------------------------------------------------------------- 报告 */

export function reportMarkdown(
  source: Source,
  perDate: Record<string, DateEntry>,
  rendered?: Rendered | Record<string, unknown> | null,
): string {
  const rep = (source["report"] || {}) as Record<string, any>;
  const title = pyTruthy(rep["title"]) ? rep["title"] : source["name"];
  const cur = getOr(rep, "currency", "");
  const tr = source["transport"] as Record<string, any>;
  const client = transportClient(source);
  const L: string[] = [
    `# ${pyStr(title)}`,
    "",
    `- 数据源配置：\`${pyStr(getOr(source, "_path", source["name"]))}\``,
    `- 抓取通道：\`${pyStr(client)}\`` + (pyTruthy(tr["note"]) ? ` —— ${pyStr(tr["note"])}` : ""),
  ];
  const f = (source["filters"] || {}) as Record<string, any>;
  if (pyTruthy(f["window"])) {
    L.push(`- 出发时段口径：[${pyStr(f["window"][0])}, ${pyStr(f["window"][1])}] 闭区间（字段 \`${pyStr(f["time_field"])}\`）`);
  }
  if (pyTruthy(rep["source_note"])) L.push(`- 数据来源：${pyStr(rep["source_note"])}`);

  const selects = (source["selects"] || []) as Array<Record<string, any>>;
  const counts = (source["counts"] || []) as Array<Record<string, any>>;
  const audits = (source["audits"] || []) as Array<Record<string, any>>;
  if (pyTruthy(perDate)) {
    const label = (x: Record<string, any>): string => pyStr(getOr(x, "label", x["key"]));
    const head = "| 日期 | " + [...counts.map(label), ...selects.map(label), ...audits.map(label)].join(" | ") + " |";
    L.push("", head, "|" + "---|".repeat(1 + counts.length + selects.length + audits.length));
    const timeFieldRaw = hasOwn(f, "time_field") ? f["time_field"] : "dep";
    const timeField = timeFieldRaw === null || timeFieldRaw === undefined ? null : pyStr(timeFieldRaw);
    for (const date of Object.keys(perDate).sort()) {
      const d = perDate[date]!;
      const cells: string[] = counts.map((c) => pyStr(getOr(d["counts"] || {}, pyStr(c["key"]), "")));
      for (const s of selects) {
        const b = ((d["selects"] || {}) as Record<string, Row | null>)[pyStr(s["key"])];
        if (b) {
          const no = pyTruthy(b["flight_no"]) ? b["flight_no"] : pyTruthy(b["name"]) ? b["name"] : "";
          const dep = timeField === null ? "" : pyStr(getOr(b, timeField, ""));
          cells.push(`${pyStr(no)} ${dep} **${pyStr(cur)}${pyStr(b["price"])}**`.trim());
        } else {
          cells.push("-");
        }
      }
      const rowsVal = d.rows;
      const total = pyTruthy(rowsVal) ? pyLen(rowsVal)! : 0;
      for (const a of audits) {
        cells.push(`${pyStr(getOr(d["audits"] || {}, pyStr(a["key"]), ""))}/${total}`);
      }
      L.push(`| ${date} | ` + cells.join(" | ") + " |");
    }
    for (const s of selects) {                       // 跨日期结论
      let best: [string, Row] | null = null;
      for (const date of Object.keys(perDate)) {
        const b = ((perDate[date]!["selects"] || {}) as Record<string, Row | null>)[pyStr(s["key"])];
        if (!pyTruthy(b)) continue;
        const price = pyTruthy(b!["price"]) ? b!["price"] : 1 << 30;
        if (best === null) {
          best = [date, b!];
          continue;
        }
        const bestPrice = pyTruthy(best[1]["price"]) ? best[1]["price"] : 1 << 30;
        if (pyCompareTuple([price, date], [bestPrice, best[0]]) < 0) best = [date, b!];
      }
      if (best) {
        const [date, b] = best;
        const desc = ["flight_no", "airline", "dep", "arr", "dep_port", "arr_port", "cabin", "discount"]
          .filter((k) => pyTruthy(b[k]))
          .map((k) => pyStr(b[k]))
          .join(" ");
        L.push("", `**${pyStr(getOr(s, "label", s["key"]))}（真实数据）**：${date} ${desc} **${pyStr(cur)}${pyStr(b["price"])}**`);
      }
    }
  }
  if (pyTruthy(rep["preview"]) && pyTruthy(perDate)) {
    const pv = rep["preview"] as Record<string, any>;
    const cols = (getOr(pv, "columns", []) as unknown[]).map(pyStr);
    const limit = pyStr(getOr(pv, "limit", 8));
    const first = Object.keys(perDate).sort()[0]!;
    const rows = ((getOr(perDate[first], "rows", []) as Row[]) || []).slice(0, Number(limit));
    L.push("", `## ${first} 前 ${rows.length} 条（原始行）`, "",
      "| " + cols.join(" | ") + " |", "|" + "---|".repeat(cols.length));
    for (const r of rows) L.push("| " + cols.map((c) => pyStr(getOr(r, c, ""))).join(" | ") + " |");
  }
  if (pyTruthy(rendered)) {
    const r = rendered as Record<string, any>;
    L.push("", "## 渲染验证：执行器看得到真实 DOM", "",
      `- 抓到的 HTML 交给真浏览器渲染后，抽取层得到 **${pyStr(r["elements"])}** 个可交互元素，`
      + `页面标题：${pyStr(r["title"]).slice(0, 60)}`, "", "```", pyStr(r["snapshot"]).slice(0, 700), "```");
  }
  if (pyTruthy(rep["notes"])) {
    L.push("", "## 说明", "");
    for (const n of rep["notes"] as unknown[]) L.push(`- ${pyStr(n)}`);
  }
  return L.join("\n") + "\n";
}

/* ---------------------------------------------------------------- 配置加载与校验 */

export function loadSource(name: string, dirs?: string[] | null): Source {
  let p = name;
  let isFile = false;
  try {
    isFile = fs.statSync(p).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {                                    // 也接受裸名：在 sources 目录里找
    const ds = dirs === undefined || dirs === null ? sourceDirs() : dirs;
    const cands = [...ds.map((d) => path.join(d, `${name}.json`)), ...ds.map((d) => path.join(d, name))];
    const found = cands.find((c) => {
      try {
        return fs.statSync(c).isFile();
      } catch {
        return false;
      }
    });
    if (found === undefined) {
      throw new FileNotFoundError(`source ${pyRepr(name)} not found in ` + ds.map(String).join(", "));
    }
    p = found;
  }
  const src = JSON.parse(fs.readFileSync(p, "utf-8")) as Source;
  src["_path"] = p;
  return src;
}

export function listSources(dirs?: string[] | null): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  const ds = dirs === undefined || dirs === null ? sourceDirs() : dirs;
  for (const d of ds) {
    let files: string[] = [];
    try {
      if (fs.statSync(d).isDirectory()) {
        files = fs.readdirSync(d).filter((f) => f.endsWith(".json")).sort();
      }
    } catch {
      files = [];
    }
    for (const f of files) {
      const full = path.join(d, f);
      const stem = f.replace(/\.json$/, "");
      try {
        const s = JSON.parse(fs.readFileSync(full, "utf-8")) as unknown;
        if (!isDict(s)) throw new Error(`'${pyTypeName(s)}' object has no attribute 'get'`);
        out.push([stem, pyStr(getOr(s, "label", "")), full]);
      } catch (e) {
        out.push([stem, `<invalid: ${e instanceof Error ? e.message : String(e)}>`, full]);
      }
    }
  }
  return out;
}

/** 数一个 Python 正则里的**捕获组**个数（`re.compile(pat).groups` 的等价物）。 */
export function countGroups(pat: string): number {
  new RegExp(pat);                                  // 语法不合法就抛（等价 re.error）
  let n = 0;
  let i = 0;
  let inClass = false;
  while (i < pat.length) {
    const c = pat[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      i++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      i++;
      continue;
    }
    if (c === "(") {
      if (pat[i + 1] === "?") {
        const c2 = pat[i + 2];
        if (c2 === ":" || c2 === "=" || c2 === "!") { i += 2; continue; }          // (?: (?= (?! 
        if (c2 === "<" && (pat[i + 3] === "=" || pat[i + 3] === "!")) { i += 3; continue; }  // (?<= (?<!
        // (?<name> 是捕获组
      }
      n++;
    }
    i++;
  }
  return n;
}

/** 配置错了就在加载时炸，不要静默抽出一堆错数据。 */
export function validateSource(src: Source): string[] {
  const p: string[] = [];
  if (!pyTruthy(src["name"])) p.push("name is required");
  const tr = (src["transport"] || {}) as Record<string, unknown>;
  const client = hasOwn(tr, "client") ? tr["client"] : "curl";
  if (!(TRANSPORTS as readonly unknown[]).includes(client)) {
    p.push(`transport.client must be one of ${pyTuple(TRANSPORTS)}`);
  }
  const bm = hasOwn(tr, "block_markers") ? tr["block_markers"] : null;
  if (!Array.isArray(pyTruthy(bm) ? bm : [])) {
    p.push("transport.block_markers must be a list of body substrings");
  }
  if (!pyTruthy(tr["url_template"])) p.push("transport.url_template is required");
  const dd = src["default_dates"];
  if (typeof dd === "string" && dd !== "next_week") {
    p.push(`default_dates ${pyRepr(dd)}: unknown named expression (known: 'next_week'; `
      + "or use a list of ISO dates)");
  }
  const dparams = (((src["date"] as any) || {}).params || {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(dparams)) {
    try {
      dateExpr(v as string, "2026-01-01", "2026-01-01");
    } catch (e) {
      if (e instanceof ValueError) p.push(`date.params.${k}: ${e.message}`);
      else throw e;
    }
  }
  const ex = (src["extract"] || {}) as Record<string, unknown>;
  const kind = ex["kind"];
  if (!(EXTRACT_KINDS as readonly unknown[]).includes(kind)) {
    p.push(`extract.kind must be one of ${pyTuple(EXTRACT_KINDS)}`);
  } else if (!pyTruthy(ex["fields"])) {
    p.push("extract.fields must not be empty");
  } else if (kind === "json_in_script") {
    if (!pyTruthy(ex["var"])) p.push("extract.var is required for json_in_script");
    if (!pyTruthy(ex["rows"])) p.push("extract.rows is required for json_in_script");
  } else if (kind === "html_regex") {
    if (!pyTruthy(ex["split"])) p.push("extract.split is required for html_regex");
    for (const [k, pat] of Object.entries((ex["fields"] || {}) as Record<string, string>)) {
      if (countGroups(pat) !== 1) p.push(`extract.fields.${k}: regex needs exactly one capture group`);
    }
  }
  for (const [k, spec] of Object.entries((ex["fields"] || {}) as Record<string, unknown>)) {
    const ops: unknown[] = typeof spec === "string"
      ? (spec.includes("|") ? spec.slice(spec.indexOf("|") + 1).split("|") : [])
      : (((spec as Record<string, unknown>)["ops"] as unknown[]) || []);
    for (const op of ops) {
      const base = pyStr(op).split(":")[0]!;        // join:+ 这类带参数
      if (!(OPS as readonly unknown[]).includes(base)) {
        p.push(`extract.fields.${k}: unknown op ${pyRepr(op)} (known: ${OPS.join(", ")})`);
      }
    }
  }
  for (const a of ((src["audits"] as Array<Record<string, any>>) || [])) {
    if (!pyTruthy(a["key"]) || !pyTruthy(a["field"])) p.push("every audit needs a key and a field");
  }
  for (const s of ((src["selects"] as Array<Record<string, any>>) || [])) {
    if (!pyTruthy(s["key"])) p.push("every select needs a key");
    const sb = hasOwn(s, "sort_by") ? s["sort_by"] : null;
    for (const k of (pyTruthy(sb) ? pyIterate(sb) : ["price"])) {
      if (typeof k !== "string") p.push(`select ${pyStr(s["key"])}: sort_by must be field names`);
    }
  }
  return p;
}

/* ---------------------------------------------------------------- CLI / JSON 输出 */

function isoNowSeconds(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Python `json.dumps(v, ensure_ascii=False, indent=2)`。 */
export function pyJsonDumpsIndent(value: unknown, indent = 2, level = 0): string {
  const pad = " ".repeat(indent * level);
  const padIn = " ".repeat(indent * (level + 1));
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return "[\n" + value.map((v) => padIn + pyJsonDumpsIndent(v, indent, level + 1)).join(",\n") + "\n" + pad + "]";
  }
  if (isDict(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    return "{\n" + entries
      .map(([k, v]) => padIn + JSON.stringify(k) + ": " + pyJsonDumpsIndent(v, indent, level + 1))
      .join(",\n") + "\n" + pad + "}";
  }
  return pyJsonDumps(value);
}

export interface RunOptions {
  today?: DateLike | null;
  saveRaw?: string | null;
  render?: boolean;
  verbose?: boolean;
}

export async function runSource(source: Source, dates: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { today = null, saveRaw = null, render = false, verbose = true } = opts;
  const perDate: Record<string, DateEntry> = {};
  let rawFirst: string | null = null;
  for (const date of dates) {
    const url = urlFor(source, date, today);
    const [code, body] = await fetchSource(source, url);
    if (blocked(source, code, body)) {
      if (verbose) {
        console.log(`${date}: HTTP ${code} —— 被风控挡住（${pyStr(transportClient(source))}）`);
      }
      perDate[date] = { error: `HTTP ${code}`, url };
      continue;
    }
    if (rawFirst === null) rawFirst = body;
    const page = extract(body, source);
    const rows = page.rows;
    const counts: Record<string, number> = {};
    for (const c of (source["counts"] || []) as Array<Record<string, any>>) {
      counts[pyStr(c["key"])] = countRows(rows, source, c);
    }
    const audits: Record<string, number> = {};
    for (const a of (source["audits"] || []) as Array<Record<string, any>>) {
      audits[pyStr(a["key"])] = auditRows(rows, a);
    }
    const selects: Record<string, Row | null> = {};
    for (const s of (source["selects"] || []) as Array<Record<string, any>>) {
      selects[pyStr(s["key"])] = selectBest(rows, source, s);
    }
    perDate[date] = { url, page_date: page.date, strip: page.strip, rows, counts, audits, selects };
    if (verbose) {
      const bits = ((source["counts"] || []) as Array<Record<string, any>>)
        .map((c) => `${pyStr(c["label"])} ${counts[pyStr(c["key"])]}`).join(" | ");
      const best = selects["best"];
      console.log(`${date}: ${rows.length} 条` + (bits ? ` | ${bits}` : "")
        + (best ? ` | 最低 ${pyStr(pyTruthy(best["flight_no"]) ? best["flight_no"] : best["name"])} `
          + `${pyStr(getOr(best, "dep", ""))} ${pyStr(getOr(source["report"] || {}, "currency", ""))}`
          + `${pyStr(best["price"])}` : ""));
    }
    if (saveRaw) {
      fs.mkdirSync(saveRaw, { recursive: true });
      fs.writeFileSync(path.join(saveRaw, `${pyStr(source["name"])}-${date}.html`), body, "utf-8");
    }
  }
  const rendered = render && rawFirst !== null ? await renderAndSnapshot(rawFirst) : null;
  const renderedOut: Record<string, unknown> = {};
  if (rendered) {
    for (const [k, v] of Object.entries(rendered)) if (k !== "text") renderedOut[k] = v;
  }
  return { source: source["name"], fetched_at: isoNowSeconds(), dates: perDate, rendered: renderedOut };
}

const USAGE = `usage: datasource [-h] [--source SOURCE] [--list] [--sources-dir DIR]
                  [--dates [DATES ...]] [--render] [--save-raw DIR] [--json JSON]
                  [--out OUT]

按配置从站点取数（数据源引擎）`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let sourceArg: string | undefined;
  let doList = false;
  let sourcesDir: string[] | null = null;
  let dates: string[] | null = null;
  let render = false;
  let saveRaw: string | null = null;
  let jsonPath: string | null = null;
  let outPath: string | null = null;

  const takesValue: Record<string, (v: string) => void> = {
    "--source": (v) => { sourceArg = v; },
    "--sources-dir": (v) => { (sourcesDir ||= []).push(v); },
    "--save-raw": (v) => { saveRaw = v; },
    "--json": (v) => { jsonPath = v; },
    "--out": (v) => { outPath = v; },
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? null : a.slice(eq + 1);
    if (flag === "-h" || flag === "--help") { console.log(USAGE); return 0; }
    if (flag === "--list") { doList = true; continue; }
    if (flag === "--render") { render = true; continue; }
    if (flag === "--dates") {
      const vals: string[] = [];
      if (inline !== null) vals.push(inline);
      while (i + 1 < argv.length && !/^-{1,2}[A-Za-z]/.test(argv[i + 1]!)) vals.push(argv[++i]!);
      dates = vals;
      continue;
    }
    const setter = takesValue[flag];
    if (setter) {
      let v = inline;
      if (v === null) {
        if (i + 1 >= argv.length) { console.log(`${USAGE}\ndatasource: error: argument ${flag}: expected one argument`); return 2; }
        v = argv[++i]!;
      }
      setter(v);
      continue;
    }
    console.log(`${USAGE}\ndatasource: error: unrecognized arguments: ${a}`);
    return 2;
  }

  const dirs = sourcesDir;
  if (doList || !sourceArg) {
    for (const [name, label, p] of listSources(dirs)) {
      console.log(`${name.padEnd(24)} ${label.padEnd(28)} ${p}`);
    }
    return 0;
  }

  let source: Source;
  try {
    source = loadSource(sourceArg, dirs);
  } catch (e) {
    if (e instanceof FileNotFoundError) {
      console.log(e.message);
      return 2;
    }
    throw e;
  }
  const problems = validateSource(source);
  if (problems.length) {
    console.log("配置有问题：");
    for (const x of problems) console.log("  -", x);
    return 2;
  }

  const useDates = dates && dates.length ? dates : defaultDates(source);
  const res = await runSource(source, useDates, { saveRaw, render });
  // 报告跟着 source 走：<sources 目录>/../results —— 引擎不指名任何站点目录
  const srcPath = pyStr(source["_path"]);
  const outdir = outPath ? path.resolve(outPath) : path.join(path.dirname(path.dirname(srcPath)), "results");
  fs.mkdirSync(outdir, { recursive: true });
  const jpath = jsonPath ? path.resolve(jsonPath) : path.join(outdir, `${pyStr(source["name"])}.json`);
  fs.writeFileSync(jpath, pyJsonDumpsIndent(res), "utf-8");
  const mpath = path.join(outdir, `${pyStr(source["name"])}.md`);
  const reportDates: Record<string, DateEntry> = {};
  for (const [d, v] of Object.entries(res.dates)) if (v.rows !== undefined) reportDates[d] = v;
  fs.writeFileSync(mpath, reportMarkdown(source, reportDates, Object.keys(res.rendered).length ? res.rendered : null), "utf-8");
  console.log(`\n写入 ${jpath} 与 ${mpath}`);
  return Object.values(res.dates).some((v) => v.rows !== undefined) ? 0 : 1;
}

/* 直接 `node --experimental-strip-types src/datasource.ts --list` 时执行。 */
const ARGV1 = process.argv[1];
if (ARGV1 && fileURLToPath(import.meta.url) === path.resolve(ARGV1)) {
  main().then((code) => { process.exitCode = code; });
}
