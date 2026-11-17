/**
 * 数据源报告的**渲染视图**（`datasource.ts` 的报告区拆出，F7）。
 *
 * 拆出的理由：`previewTable` / `reportMarkdown` 只读 `Source`/`DateEntry` 配置数据并
 * 产出 Markdown 字符串，不参与取数/抽取/校验；应用运行器（`app-runner.appReportMarkdown`）
 * 也读 `previewTable`——视图独立成模块后，报告口径单点维护。
 * 行为与搬移前逐字节一致（`npm run check` + 任一数据腿 report.md 对比兜底）。
 */

/** Python `dict.get(k, d)`：键存在（哪怕是 null）就取它。 */
function getOr<T>(o: unknown, k: string, dflt: T): unknown {
  return hasOwn(o, k) ? (o as Record<string, unknown>)[k] : dflt;
}

function hasOwn(o: unknown, k: string): boolean {
  return o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k);
}

/** Python 元组比较（逐项，先到先判）。 */
function pyCompareTuple(a: readonly unknown[], b: readonly unknown[]): number {
  const cmp = (x: unknown, y: unknown): number => {
    const num = (v: unknown): number | null =>
      typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? v : null;
    const nx = num(x);
    const ny = num(y);
    if (nx !== null && ny !== null) return nx < ny ? -1 : nx > ny ? 1 : 0;
    if (typeof x === "string" && typeof y === "string") {
      const A = Array.from(x);
      const B = Array.from(y);
      const n = Math.min(A.length, B.length);
      for (let i = 0; i < n; i++) {
        const ca = A[i]!.codePointAt(0)!;
        const cb = B[i]!.codePointAt(0)!;
        if (ca !== cb) return ca < cb ? -1 : 1;
      }
      return A.length === B.length ? 0 : A.length < B.length ? -1 : 1;
    }
    return 0;
  };
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmp(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Python `len()`：只对 list/str 有值（str 按码点计数）。 */
function pyLen(v: unknown): number | null {
  if (typeof v === "string") return Array.from(v).length;
  if (Array.isArray(v)) return v.length;
  return null;
}

/** Python `str()`。 */
function pyStr(v: unknown): string {
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
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return "{" + Object.entries(v as Record<string, unknown>).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ") + "}";
  }
  return String(v);
}

/** Python `repr()`（字符串的引号选择与 Python 一致）。 */
function pyRepr(v: unknown): string {
  if (typeof v === "string") {
    if (v.includes("'") && !v.includes('"')) {
      return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    }
    return "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  }
  return pyStr(v);
}

/** Python 真值判断：NaN 是**真**，0/-0/""/[]/{} 是假。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v !== null && typeof v === "object" && !Array.isArray(v)) return Object.keys(v).length > 0;
  return true;
}

import type { DateEntry, Rendered, Row, Source } from "./datasource.ts";
import { cliBinOf, transportClient } from "./datasource.ts";
import { firstNonEmptyScalar, selectSortKeys, selectValueField } from "./extract-ops.ts";

/**
 * 报告里的"前 N 条原始行"（数据源的 `report.preview`）的**单一实现**。
 *
 * 为什么要单独拎出来：这段"取最早一天、按 `columns` 投影、截 `limit` 行"只写在
 * `reportMarkdown` 里时，应用运行器的数据腿**没有** preview 可展示——同一份声明在两个
 * 出口长出两个形状（一个看得到原始行、一个只看得到 counts/selects）。现在报告（`reportMarkdown`）
 * 与应用报告（`app-runner.appReportMarkdown`）都读这一个函数。
 */
export interface PreviewTable {
  /** 展示哪一天（取最早的一天：与报告表格同一口径）。 */
  date: string;
  columns: string[];
  /** 已按 `columns` 投影成字符串（报告只负责排版，不再各扫一遍行）。 */
  rows: Array<Record<string, string>>;
}

export function previewTable(source: Source, perDate: Record<string, DateEntry>): PreviewTable | null {
  const rep = (source["report"] || {}) as Record<string, any>;
  if (!pyTruthy(rep["preview"]) || !pyTruthy(perDate)) return null;
  const pv = rep["preview"] as Record<string, any>;
  const columns = (getOr(pv, "columns", []) as unknown[]).map(pyStr);
  const limit = Number(pyStr(getOr(pv, "limit", 8)));
  const date = Object.keys(perDate).sort()[0]!;
  const take = Number.isFinite(limit) && limit >= 0 ? limit : 0;
  const rows = ((getOr(perDate[date]!, "rows", []) as Row[]) || []).slice(0, take)
    .map((r) => Object.fromEntries(columns.map((c) => [c, pyStr(getOr(r, c, ""))])));
  return { date, columns, rows };
}

/** 配置里的字符串字段名列表（过滤非字符串/空白；未配 = []）。 */
function stringFields(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

/** 按声明顺序取第一个真值字段（pyTruthy 口径，与既有渲染一致）。 */
function firstDeclaredValue(row: Row, fields: readonly string[]): string {
  for (const f of fields) {
    if (pyTruthy(row[f])) return pyStr(row[f]);
  }
  return "";
}

/** 行标识文本（报告表格的 select 单元格与 CLI 摘要共用）：`report.value_fields` 顺序；未配 = 通用回退。 */
export function selectIdentityText(source: Source, row: Row): string {
  const rep = (source["report"] || {}) as Record<string, any>;
  const fields = stringFields(rep["value_fields"]);
  if (fields.length > 0) return firstDeclaredValue(row, fields);
  const generic = firstNonEmptyScalar(row);
  return generic === undefined ? "" : pyStr(generic);
}

/**
 * 值文本（报告加粗值与 CLI 摘要的唯一实现）：字段 = select 的 `value_field`（缺省 `sort_by[0]`）；
 * 只有显式 `report.currency_field` 命中该字段时才加货币前缀。
 */
export function selectValueText(source: Source, sel: Record<string, any>, row: Row): string {
  const rep = (source["report"] || {}) as Record<string, any>;
  const field = selectValueField(sel);
  if (field === null) return "";
  const raw = row[field];
  if (raw !== undefined && raw !== null) {
    const curField = pyTruthy(rep["currency_field"]) ? pyStr(rep["currency_field"]) : null;
    const cur = curField !== null && curField === field ? pyStr(getOr(rep, "currency", "")) : "";
    return `${cur}${pyStr(raw)}`;
  }
  return pyStr(getOr(row, field, ""));
}

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
    `- 抓取通道：\`${pyStr(client)}\``
      + (pyStr(client) === "cli"
        ? `（\`${cliBinOf(source)}\``
          + (pyTruthy(tr["version_pin"]) ? `，版本 pin \`${pyStr(tr["version_pin"])}\`` : "")
          + "）"
        : "")
      + (pyTruthy(tr["note"]) ? ` —— ${pyStr(tr["note"])}` : ""),
  ];
  const f = (source["filters"] || {}) as Record<string, any>;
  if (pyTruthy(f["window"])) {
    L.push(`- 出发时段口径：[${pyStr(f["window"][0])}, ${pyStr(f["window"][1])}] 闭区间（字段 \`${pyStr(f["time_field"])}\`）`);
  }
  if (pyTruthy(rep["source_note"])) L.push(`- 数据来源：${pyStr(rep["source_note"])}`);

  const repFields = stringFields(rep["value_fields"]);
  const selects = (source["selects"] || []) as Array<Record<string, any>>;
  const counts = (source["counts"] || []) as Array<Record<string, any>>;
  const audits = (source["audits"] || []) as Array<Record<string, any>>;
  if (pyTruthy(perDate)) {
    const label = (x: Record<string, any>): string => pyStr(getOr(x, "label", x["key"]));
    const head = "| 日期 | " + [...counts.map(label), ...selects.map(label), ...audits.map(label)].join(" | ") + " |";
    L.push("", head, "|" + "---|".repeat(1 + counts.length + selects.length + audits.length));
    const timeFieldRaw = hasOwn(f, "time_field") ? f["time_field"] : null;
    const timeField = timeFieldRaw === null || timeFieldRaw === undefined ? null : pyStr(timeFieldRaw);
    for (const date of Object.keys(perDate).sort()) {
      const d = perDate[date]!;
      const cells: string[] = counts.map((c) => pyStr(getOr(d["counts"] || {}, pyStr(c["key"]), "")));
      for (const s of selects) {
        const b = ((d["selects"] || {}) as Record<string, Row | null>)[pyStr(s["key"])];
        if (b) {
          // 标识列 = `report.value_fields` 声明顺序（未配 = 行内首个非空标量）；
          // 时间列 = `filters.time_field`（未配 = 不渲染）；值列 = `selects[].value_field`。
          const no = repFields.length > 0 ? firstDeclaredValue(b, repFields) : selectIdentityText(source, b);
          const dep = timeField === null ? "" : pyStr(getOr(b, timeField, ""));
          cells.push(`${pyStr(no)} ${dep} **${selectValueText(source, s, b)}**`.trim());
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
      const cmpField = selectValueField(s);
      const detailFields = stringFields(s["detail_fields"]);
      const fallbackFields = stringFields(rep["detail_fallback_fields"]);
      let best: [string, Row] | null = null;
      for (const date of Object.keys(perDate)) {
        const b = ((perDate[date]!["selects"] || {}) as Record<string, Row | null>)[pyStr(s["key"])];
        if (!pyTruthy(b)) continue;
        const val = cmpField !== null && pyTruthy(b![cmpField]) ? b![cmpField] : 1 << 30;
        if (best === null) { best = [date, b!]; continue; }
        const bestVal = cmpField !== null && pyTruthy(best[1][cmpField]) ? best[1][cmpField] : 1 << 30;
        if (pyCompareTuple([val, date], [bestVal, best[0]]) < 0) best = [date, b!];
      }
      if (best) {
        const [date, b] = best;
        const desc = detailFields.filter((k) => pyTruthy(b[k])).map((k) => pyStr(b[k])).join(" ");
        const hasValue = cmpField !== null && b[cmpField] !== undefined && b[cmpField] !== null;
        const shown = hasValue ? selectValueText(source, s, b) : pyStr(getOr(b, cmpField ?? "", ""));
        const ident = hasValue || desc !== ""
          ? desc
          : (fallbackFields.length > 0 ? firstDeclaredValue(b, fallbackFields) : selectIdentityText(source, b));
        L.push("", `**${pyStr(getOr(s, "label", s["key"]))}（真实数据）**：${date} ${ident} **${shown}**`);
      }
    }
  }
  const pv = previewTable(source, perDate);
  if (pv) {
    L.push("", `## ${pv.date} 前 ${pv.rows.length} 条（原始行）`, "",
      "| " + pv.columns.join(" | ") + " |", "|" + "---|".repeat(pv.columns.length));
    for (const r of pv.rows) L.push("| " + pv.columns.map((c) => pyStr(getOr(r, c, ""))).join(" | ") + " |");
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
