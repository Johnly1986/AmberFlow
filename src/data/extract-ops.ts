/**
 * 数据腿的路径语言 / 算子 / 抽取器 / 日期族 / 行选择算子（纯函数区）。
 *
 * 只读配置与响应文本，不碰 fs/子进程/网络。
 */
import { pyTruthy, pyStr, pyRepr, strOrEmpty, pyInt, pyLen, pyStrCmp, pyCompareTuple, hasOwn, getOr, pyIterate, isDict, pyTypeName } from "../support/pystr.ts";
import { ValueError, KeyError } from "./types.ts";
import type { Row, Page, Source, DateLike } from "./types.ts";

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

export const EXTRACT_KINDS = ["json_in_script", "html_regex", "json_stdout", "lines_regex"] as const;

export const OPS = ["time", "join", "len", "len-1", "int", "str", "strip"] as const;

 // join:<sep> 带参数
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

/**
 * 整个 stdout 就是一个 JSON 文档（`jq -c .`、`--print_format json` 这类工具的输出）。
 *
 * 与 `json_in_script` 的唯一区别是入口：那个从 HTML 里挖 `var X = {...}`，这个直接解析
 * 子进程的标准输出。`rows` 仍是必填的路径——"哪个数组是数据行"是配置知识，引擎不猜。
 */
function jsonStdout(text: string, spec: Record<string, any>): Page {
  if (!hasOwn(spec, "rows")) throw new KeyError(pyRepr("rows"));
  let state: unknown;
  try {
    state = JSON.parse(text);
  } catch (e) {
    const head = text.trim().split("\n")[0]?.slice(0, 120) ?? "";
    throw new ValueError(`stdout is not JSON (${e instanceof Error ? e.message : String(e)}; first line: ${head})`);
  }
  const fields = spec["fields"] as Record<string, unknown>;
  const rawRows = resolve(state, pyStr(spec["rows"]));
  const rows = (pyTruthy(rawRows) ? pyIterate(rawRows) : []).map((x) => rowOf(x, fields));
  return { date: "", strip: [], rows };
}

/**
 * 按行解析文本输出（`git log`、`ls -l`、`jq -r` 这类）。
 *
 * 为什么不复用 `html_regex`：它按 `split` 切块后 **`slice(1)` 丢掉第一块**（Python 参考的
 * 口径，正文前的表头），对行文本就是"永远丢第一行"——一个只为 HTML 成立、在 CLI 上变成
 * 陷阱的行为。行文本没有"表头块"这个概念，所以它有自己的抽取器：逐行匹配、空行跳过、
 * 全空字段的行不计入。
 */
function linesRegex(text: string, spec: Record<string, any>): Page {
  const sepRaw = spec["line_sep"];
  const sep = sepRaw === undefined || sepRaw === null || pyStr(sepRaw) === "" ? "\n" : pyStr(sepRaw);
  const fields = (spec["fields"] || {}) as Record<string, string>;
  const rows: Row[] = [];
  for (const line of text.split(sep)) {
    if (!line.trim()) continue;
    const row: Row = {};
    for (const [k, pat] of Object.entries(fields)) {
      const m = new RegExp(pat, "s").exec(line);
      row[k] = m && m[1] !== undefined ? m[1].trim() : "";
    }
    if (Object.values(row).some(pyTruthy)) rows.push(row);
  }
  return { date: "", strip: [], rows };
}

export const EXTRACTORS: Record<string, (html: string, spec: Record<string, any>) => Page> = {
  json_in_script: jsonInScript,
  html_regex: htmlRegex,
  json_stdout: jsonStdout,
  lines_regex: linesRegex,
};

export function extract(html: string, source: Source): Page {
  const ex = source["extract"] as Record<string, any>;
  if (!hasOwn(ex, "kind")) throw new KeyError(pyRepr("kind"));
  const fn = EXTRACTORS[pyStr(ex["kind"])];
  if (!fn) throw new KeyError(pyRepr(ex["kind"]));
  return fn(html, ex);
}

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
 * Today in local time as `YYYY-MM-DD`.显式 `override`（`--today` / `RunOptions.today`）PINS it。
 *
 * Why a pin exists: the frozen cross-runtime corpora contain a human-readable
 * 「执行日期」line, so a byte-comparison against them silently expires at midnight —
 * measured: the ctrip parity layer went 10/10 -> 9/10 on 2026-10-03 purely because the
 * reference corpus was generated on 2026-10-02. CI must not depend on the wall clock, so
 * the parity tools pass the day their corpus was generated **explicitly**（`--today`
 * / `RunOptions.today`）. It used to be an env var (`LAYA_TODAY`)，已按配置面收口删除：
 * 时钟不是机器配置，是本次调用的显式参数。A malformed pin is ignored rather than trusted.
 */
export function todayIso(override?: string | null): string {
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
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

/** `2026-13-01` 这类形状合法但日历不存在的日期在这里响亮拒绝（round-trip 校验）。 */
function isoDateOrThrow(s: string): string {
  const iso = epochDayToIso(dateToEpochDay(s));
  if (iso !== s) throw new ValueError(`invalid calendar date ${pyRepr(s)}`);
  return s;
}

/**
 * 日期参数值 → ISO 日期列表。三种写法：单日 `2026-11-02`、闭区间范围
 * `2026-11-02..2026-11-06`（含两端，最多 31 天）、具名表达式 `next_week`。
 * 这是槽位/`--slot`/`ctx.source({dates})` 的统一值文法——坏值响亮抛 ValueError。
 * `today` 是相对表达式（next_week）的锚（`--today` 钉住的时钟）；缺省 = 系统日期。
 */
export function parseDatesValue(raw: string, today?: DateLike | null): string[] {
  const t = raw.trim();
  if (t === "next_week") return nextWeekDates(today ?? undefined);
  const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(t);
  if (range) {
    const a = dateToEpochDay(isoDateOrThrow(range[1]!));
    const b = dateToEpochDay(isoDateOrThrow(range[2]!));
    if (b < a) throw new ValueError(`date range ${pyRepr(t)}: start is after end`);
    if (b - a > 30) throw new ValueError(`date range ${pyRepr(t)}: spans ${b - a + 1} days (max 31)`);
    return Array.from({ length: b - a + 1 }, (_, i) => epochDayToIso(a + i));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return [isoDateOrThrow(t)];
  throw new ValueError(`unrecognized dates value ${pyRepr(t)} (known: ISO date, 'A..B' range, 'next_week')`);
}

/** 整串恰好是 `{name}` 占位符时返回 name，否则 null（槽位键与 `{slot}` 占位符同一文法）。 */
function slotPlaceholder(raw: string): string | null {
  const m = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw.trim());
  return m ? m[1]! : null;
}

/** 收集一段 default_dates 声明里引用的全部 `{slot}` 名（应用层环封口校验用）。 */
export function defaultDatesSlotNames(source: Source): string[] {
  const d = source["default_dates"];
  const names = new Set<string>();
  const scan = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const ph = slotPlaceholder(raw);
    if (ph !== null) names.add(ph);
  };
  if (typeof d === "string" && d !== "next_week") scan(d);
  if (Array.isArray(d)) for (const x of d) scan(x);
  return [...names].sort();
}

/**
 * `default_dates`：省略 -> 今天；`"next_week"` -> 下个工作日；字符串 -> ISO 日期 /
 * `A..B` 范围 / `{slot}` 槽位占位符（从 `slots` 值袋解析；没给 `slots` 而源声明了
 * `{slot}` = 缺值，响亮抛）；列表 -> 逐项展开后拼接。
 * 给了 `slots` 的调用方（应用数据腿）能把声明槽位接进来；`today` 是所有相对表达式
 * （next_week）与"今天"缺省值的锚——调用方必须把 `--today` 钉住的时钟传进来，
 * 否则钉时钟只对 day_offset 生效、next_week 仍走墙钟（那就是"看似钉了"）。
 */
export function defaultDates(
  source: Source, slots?: Record<string, unknown> | null, today?: DateLike | null,
): string[] {
  const d = source["default_dates"];
  const resolve = (raw: unknown): string[] => {
    if (typeof raw !== "string") return [pyStr(raw)];
    const ph = slotPlaceholder(raw);
    if (ph !== null) {
      const v = slots?.[ph];
      if (v === undefined || v === null || String(v) === "") {
        throw new ValueError(`default_dates {${ph}}: slot ${pyRepr(ph)} has no value`
          + `（--slot ${ph}=<ISO 日期 | A..B | next_week>，或在应用 meta.slots 里给默认值）`);
      }
      return parseDatesValue(String(v), today);
    }
    // 非占位符：ISO 日期/范围就地校验；其它（模板片段等）原样透传，与旧行为一致。
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) || /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
      return parseDatesValue(raw, today);
    }
    return [raw];
  };
  if (typeof d === "string") {
    if (d === "next_week") return nextWeekDates(today ?? undefined);
    return resolve(d);
  }
  if (Array.isArray(d)) return d.flatMap(resolve);
  return [todayIso(typeof today === "string" ? today : undefined)];
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

/**
 * 选择语义的**唯一实现**：按 `sort_by` 多键取胜者，`order: "max"` 翻转比较。
 * 缺值（null/undefined）在两种 order 下都排最后——它不是一个"极大值"。
 *
 * `selects`（本引擎）与 SemanticFlow 的 `list_step`（min/max）都走这里：一份实现，
 * 浏览器侧与数据侧的"选哪一行"不会各写一套而悄悄漂移。
 *
 * @returns 胜者在 `rows` 里的下标；空行集返回 -1。
 */
/**
 * `sort_by` 的配置解释（唯一出处）：只认非空字符串数组；未配 = 空数组（**不猜业务字段**）。
 * 空数组在 `selectIndex` 里表示"不排序、取池内第一行"——通用回退，不点名任何业务字段。
 */
export function selectSortKeys(sel: Record<string, any>): string[] {
  const raw = sel["sort_by"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is string => typeof k === "string" && k.trim() !== "");
}

/** 主值字段候选顺序：`value_fields` > `value_field` > `sort_by`；未配 = []（调用方用通用回退）。 */
export function selectValueFields(sel: Record<string, any>): string[] {
  const list = sel["value_fields"];
  if (Array.isArray(list)) {
    const fields = list.filter((k): k is string => typeof k === "string" && k.trim() !== "");
    if (fields.length > 0) return fields;
  }
  const single = sel["value_field"];
  if (typeof single === "string" && single.trim() !== "") return [single];
  return selectSortKeys(sel);
}

/** 报告里加粗显示的"主值字段"：`value_field` > `sort_by[0]`；未配 = null（调用方通用回退）。 */
export function selectValueField(sel: Record<string, any>): string | null {
  const single = sel["value_field"];
  if (typeof single === "string" && single.trim() !== "") return single;
  return selectSortKeys(sel)[0] ?? null;
}

/** 行的第一个非空标量值（通用回退；不点名任何业务字段；对象/数组跳过）。 */
export function firstNonEmptyScalar(row: Row | null | undefined): unknown {
  if (row === null || row === undefined) return undefined;
  for (const k of Object.keys(row)) {
    const v = (row as Record<string, unknown>)[k];
    if (v === null || v === undefined) continue;
    const t = typeof v;
    if (t !== "string" && t !== "number" && t !== "boolean") continue;
    if (String(v) !== "") return v;
  }
  return undefined;
}

/**
 * 行的"主值"：按声明字段顺序取第一个非空值；未声明任何字段才走通用回退
 * （行内首个非空标量）。声明了但全空 = undefined（不跨到配置外猜字段）。
 */
export function selectMainValue(row: Row | null | undefined, sel: Record<string, any>): unknown {
  if (row === null || row === undefined) return undefined;
  const fields = selectValueFields(sel);
  if (fields.length > 0) {
    for (const f of fields) {
      const v = (row as Record<string, unknown>)[f];
      if (v !== undefined && v !== null) return v;
    }
    return undefined;
  }
  return firstNonEmptyScalar(row);
}

export function selectIndex(rows: Row[], sel: Record<string, any>): number {
  const keys = selectSortKeys(sel);
  if (keys.length === 0) return rows.length > 0 ? 0 : -1;
  const wantMax = pyStr(sel["order"] ?? "min") === "max";
  let best = -1;
  let bestKey: unknown[] | null = null;
  let bestMissing = 0;
  rows.forEach((r, i) => {
    const missing = keys.filter((k) => r[k] === null || r[k] === undefined).length;
    const key = keys.map((k) => (r[k] === null || r[k] === undefined ? 0 : r[k]));
    if (bestKey === null) {
      best = i; bestKey = key; bestMissing = missing;
      return;
    }
    // 缺得少的先赢（缺值永远排最后），再按值比。
    if (missing !== bestMissing) {
      if (missing < bestMissing) { best = i; bestKey = key; bestMissing = missing; }
      return;
    }
    const cmp = pyCompareTuple(key, bestKey);
    if (wantMax ? cmp > 0 : cmp < 0) { best = i; bestKey = key; }
  });
  return best;
}

export function selectBest(rows: Row[], source: Source, sel: Record<string, any>): Row | null {
  const pool = poolOf(rows, source, sel);
  const i = selectIndex(pool, sel);
  return i < 0 ? null : pool[i]!;
}

/** 按配置核查数据质量：`{"field": "<字段>", "empty": true}` -> 有多少行为空。 */
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
