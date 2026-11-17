/**
 * 数据腿 discovery / 加载 / 校验 / 运行 / CLI 入口（loadSource、validateSource、runSource、main）。
 *
 * 语义与既有 datasource.py 移植保持一致：发现制、逐项点名错误、取不到就是取不到。
 */
import { REPO } from "../support/paths.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { pyJsonDumpsIndent, pyTruthy, pyStr, pyRepr, hasOwn, getOr, pyIterate, pyTuple, isDict, pyTypeName } from "../support/pystr.ts";
import { reportMarkdown, selectIdentityText, selectValueText } from "./report-view.ts";
import { FileNotFoundError, ValueError } from "./types.ts";
import type { Rendered, Source, RunOptions, RunResult, DateEntry, Row } from "./types.ts";
import type { ElemPool, PageLike } from "../engine/extraction.ts";
import { TRANSPORTS, CLI_KEYS, checkVersion, transportClient, fetchSource, blocked, cliBinOf } from "./transport.ts";
import { dateExpr, EXTRACT_KINDS, OPS, urlFor, extract, countRows, auditRows, selectBest, defaultDates } from "./extract-ops.ts";

/* ---------------------------------------------------------------- 源目录发现 */

/**
 * 引擎不认识任何站点：仓库根下每个站点目录里的 sources 子目录都是合法的源配置目录
 * （发现制），新增站点目录零引擎改动。要指向别处时给 `loadSource`/`listSources`
 * 显式传 dirs。
 */
export function sourceDirs(): string[] {
  const out: string[] = [];
  const push = (p: string): void => {
    try {
      if (fs.statSync(p).isDirectory()) out.push(p);
    } catch {
      /* 不是目录 */
    }
  };
  const readdir = (p: string): string[] => {
    try {
      return fs.readdirSync(p);
    } catch {
      return [];
    }
  };
  for (const name of readdir(REPO)) push(path.join(REPO, name, "sources"));
  // 应用包：一个应用一个目录，`apps/<id>/sources` 同样是配置目录。发现制，不维护目录表
  // —— 新接一个应用/工具 = 新目录 + source JSON，引擎不加一行站点知识。
  for (const name of readdir(path.join(REPO, "apps"))) push(path.join(REPO, "apps", name, "sources"));
  return out.sort();
}

/* ---------------------------------------------------------------- 渲染（真实 DOM → 执行器） */

/**
 * 把抓到的真实 HTML 交给真浏览器渲染，再让执行器的抽取层看一眼。
 *
 * 证明的是"执行器能在真实 DOM 上工作"：抓取走 curl（唯一能过风控的客户端），
 * 渲染与元素抽取走 harness 自己。playwright 只在调用时动态载入。
 *
 * `snapshot` 就是 `layaapp.snapshot_text` 的等价物：复用执行器自己的
 * `criteria_view` 渲染空间（这里直接复用 `extraction.criteriaView`，是为了让
 * `--render` 在 Node 的 strip-only 模式下也能跑）。
 */
export async function renderAndSnapshot(
  html: string,
  /** 扫描注入点：Data 层只消费池（扫描实现归应用层；2.2b 迁移后引擎不再被 data 反向依赖）。 */
  scan: (page: PageLike) => Promise<ElemPool>,
): Promise<Rendered> {
  const pw: any = await import("playwright");
  const browserEnv: any = await import("../browser/browser-env.ts");
  const b: any = await browserEnv.launch(pw, true);
  try {
    const pg: any = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await pg.setContent(html, { waitUntil: "domcontentloaded" });
    await pg.waitForTimeout(1500);
    const elems = await scan(pg as PageLike);
    const snapshot = !elems || Object.keys(elems).length === 0
      ? ""
      : Object.values(renderCriteriaView(elems)).slice(0, 40).join("\n");
    return {
      elements: Object.keys(elems).length,
      snapshot,
      text: await renderPageText(pg),
      title: await pg.title(),
    };
  } finally {
    await b.close();
  }
}

/**
 * render 展示面（`criteriaView` 的 null-ARIA 分支）：`--render` 无仓内调用方，
 * 这里只保留原显示口径（tag/label/属性 + 重复标签 near 消歧）；2.2b 扫描迁入 app 时统一收敛。
 */
function renderCriteriaView(elems: ElemPool): Record<string, string> {
  const crit: Record<string, string> = {};
  const ordered = Object.entries(elems)
    .sort((a, b) => (a[1].scan ?? Number(a[0].slice(1))) - (b[1].scan ?? Number(b[0].slice(1))));
  for (const [ref, e] of ordered) {
    const attrs = (e.data_test ? ` [test=${e.data_test}]` : "") + (e.href ? ` -> ${e.href}` : "");
    crit[ref] = `${e.tag} "${e.label}"${attrs}`;
  }
  const counts = new Map<string, number>();
  for (const v of Object.values(crit)) counts.set(v, (counts.get(v) ?? 0) + 1);
  for (const [ref, v] of Object.entries(crit)) {
    const near = elems[ref]?.near;
    if ((counts.get(v) ?? 0) > 1 && near) crit[ref] = `${v} [near=${near}]`;
  }
  return crit;
}

/** render 展示面：等价引擎 `pageText`（main/body 文本，首 300 + 末 150）。 */
async function renderPageText(page: any): Promise<string> {
  const loc = page.locator("main, body");
  const target = typeof loc.first === "function" ? loc.first() : loc;
  const text = String(await target.innerText()).trim();
  return text.length <= 450 ? text : text.slice(0, 300) + "\n...\n" + text.slice(-150);
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
      // 08-A1/08-B 明示：空搜索面不能以空格截尾；源注册表的发现面只有 checkout（REPO 根各
      // */sources + REPO/apps/*/sources），用户作用域应用永远找不到——一行把出路说清。
      const where = ds.length
        ? ds.map(String).join(", ")
        : "(no sources dirs discovered — the registry scans the checkout's site dirs and apps/*/sources only)";
      throw new FileNotFoundError(
        `source ${pyRepr(name)} not found in ${where}`
        + (ds.length ? "" : " — user-scope apps have no cli source registry; for process steps use the declared form ctx.run({stdio|ssh: ..., done: ...})"),
      );
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
function validateCliTransport(tr: Record<string, unknown>, client: unknown, p: string[]): void {
  // cli 那一档的配置：argv 数组（不是命令字符串）、env 白名单、退出码白名单、cwd。
  // 未知键直接报错——配置写错了要在加载时炸，而不是运行时静默少跑一个参数。
  if (client === "cli") {
    const spec = tr["cli"];
    if (!isDict(spec)) {
      p.push("transport.cli is required for client 'cli' (bin + argv)");
    } else {
      for (const k of Object.keys(spec as Record<string, unknown>)) {
        if (!(CLI_KEYS as readonly string[]).includes(k)) {
          p.push(`transport.cli.${k}: unknown key (known: ${CLI_KEYS.join(", ")})`);
        }
      }
      const bin = (spec as Record<string, unknown>)["bin"];
      const argv = (spec as Record<string, unknown>)["argv"];
      if (typeof bin !== "string" || !bin.trim()) {
        p.push("transport.cli.bin is required (the executable name or path, never a shell string)");
      }
      if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === "string")) {
        p.push("transport.cli.argv must be a non-empty list of strings (an argv array, never a shell string)");
      }
      const ea = (spec as Record<string, unknown>)["env_allow"];
      if (ea !== undefined && ea !== null && !(Array.isArray(ea) && ea.every((x) => typeof x === "string"))) {
        p.push("transport.cli.env_allow must be a list of environment variable names");
      }
      const eo = (spec as Record<string, unknown>)["exit_ok"];
      if (eo !== undefined && eo !== null && !(Array.isArray(eo) && eo.every((x) => Number.isInteger(x)))) {
        p.push("transport.cli.exit_ok must be a list of integer exit codes (default [0])");
      }
      const cwd = (spec as Record<string, unknown>)["cwd"];
      if (cwd !== undefined && cwd !== null && typeof cwd !== "string") {
        p.push("transport.cli.cwd must be a string (relative paths resolve from the repo root)");
      }
      const stdin = (spec as Record<string, unknown>)["stdin"];
      if (stdin !== undefined && stdin !== null && typeof stdin !== "string") {
        p.push("transport.cli.stdin must be a string");
      }
    }
    const vp = tr["version_pin"];
    if (vp !== undefined && vp !== null && typeof vp !== "string") {
      p.push("transport.version_pin must be a string (a substring of the tool's version output)");
    }
    const va = tr["version_argv"];
    if (va !== undefined && va !== null
      && !(Array.isArray(va) && va.length && va.every((x) => typeof x === "string"))) {
      p.push("transport.version_argv must be a non-empty list of strings (default ['--version'])");
    }
  } else if (tr["cli"] !== undefined && tr["cli"] !== null) {
    p.push("transport.cli only applies to transport.client 'cli'");
  }
  if (client !== "cli" && pyTruthy(tr["version_pin"])) {
    p.push("transport.version_pin only applies to transport.client 'cli'");
  }
}

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
  validateCliTransport(tr, client, p);
  const dd = src["default_dates"];
  if (typeof dd === "string" && dd !== "next_week") {
    // 字符串形态：具名表达式 / ISO 日期 / A..B 范围 / {slot} 占位符（应用数据腿在
    // 运行期从槽位值袋解析）。其它字符串仍然响亮拒绝——配了却像没配就是配置错误。
    const ph = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(dd.trim());
    if (ph === null && !/^\d{4}-\d{2}-\d{2}(\.\.\d{4}-\d{2}-\d{2})?$/.test(dd.trim())) {
      p.push(`default_dates ${pyRepr(dd)}: unknown named expression (known: 'next_week', ISO date, `
        + "'A..B' range, '{slot}' placeholder; or use a list of ISO dates)");
    }
  }
  if (Array.isArray(dd)) {
    for (const [i, item] of dd.entries()) {
      if (typeof item !== "string") continue;
      const ph = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(item.trim());
      if (ph === null && !/^\d{4}-\d{2}-\d{2}(\.\.\d{4}-\d{2}-\d{2})?$/.test(item.trim())) {
        p.push(`default_dates[${i}] ${pyRepr(item)}: expected an ISO date, an 'A..B' range `
          + "or a '{slot}' placeholder");
      }
    }
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
  } else if (kind === "json_stdout") {
    if (!pyTruthy(ex["rows"])) p.push("extract.rows is required for json_stdout");
  } else if (kind === "lines_regex") {
    const sep = ex["line_sep"];
    if (sep !== undefined && sep !== null && typeof sep !== "string") {
      p.push("extract.line_sep must be a string (default a newline)");
    }
    for (const [k, pat] of Object.entries((ex["fields"] || {}) as Record<string, string>)) {
      if (countGroups(pat) !== 1) p.push(`extract.fields.${k}: regex needs exactly one capture group`);
    }
  }
  // 只有"路径 + 算子"口径的抽取器才检查算子：html_regex / lines_regex 的字段是**正则**，
  // 里面的 `|` 是交替而不是"路径|算子"分隔符（早期版本对正则字段也查算子，于是任何带交替
  // 的正则都被误报成 `unknown op`）。
  const regexKind = kind === "html_regex" || kind === "lines_regex";
  for (const [k, spec] of Object.entries((ex["fields"] || {}) as Record<string, unknown>)) {
    if (regexKind) break;
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
  const fieldName = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
  const fieldNameList = (v: unknown): boolean => Array.isArray(v) && v.length > 0 && v.every(fieldName);
  for (const s of ((src["selects"] as Array<Record<string, any>>) || [])) {
    if (!pyTruthy(s["key"])) p.push("every select needs a key");
    const sb = s["sort_by"];
    if (sb !== undefined && sb !== null) {
      const keys = pyTruthy(sb) ? pyIterate(sb) : [];
      if (keys.length === 0) p.push(`select ${pyStr(s["key"])}: sort_by must be a non-empty list of field names`);
      for (const k of keys) {
        if (typeof k !== "string") p.push(`select ${pyStr(s["key"])}: sort_by must be field names`);
      }
    }
    const ord = s["order"];
    if (ord !== undefined && ord !== "min" && ord !== "max") {
      p.push(`select ${pyStr(s["key"])}: order must be min|max (got ${pyRepr(ord)})`);
    }
    // 主值/展示字段映射是**数据源配置**（引擎不猜业务字段名）。
    const vf = s["value_field"];
    if (vf !== undefined && vf !== null && !fieldName(vf)) {
      p.push(`select ${pyStr(s["key"])}: value_field must be a non-empty field name`);
    }
    for (const key of ["value_fields", "detail_fields"] as const) {
      const list = s[key];
      if (list !== undefined && list !== null && !fieldNameList(list)) {
        p.push(`select ${pyStr(s["key"])}: ${key} must be a non-empty list of field names`);
      }
    }
  }
  const rep = (src["report"] || {}) as Record<string, unknown>;
  for (const key of ["value_fields", "detail_fallback_fields"] as const) {
    const list = rep[key];
    if (list !== undefined && list !== null && !fieldNameList(list)) {
      p.push(`report.${key} must be a non-empty list of field names`);
    }
  }
  const curField = rep["currency_field"];
  if (curField !== undefined && curField !== null && !fieldName(curField)) {
    p.push("report.currency_field must be a non-empty field name");
  }
  const timeField = ((src["filters"] || {}) as Record<string, unknown>)["time_field"];
  if (timeField !== undefined && timeField !== null && !fieldName(timeField)) {
    p.push("filters.time_field must be a non-empty field name");
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

/** 2.2b：render 需要的注入扫描器（Data 层 RunOptions 的本地扩展；不引 data→app import）。 */
export type RenderScan = (page: PageLike) => Promise<ElemPool>;
type RunOptionsWithScan = RunOptions & { scan?: RenderScan };

export async function runSource(source: Source, dates: string[], opts: RunOptionsWithScan = {}): Promise<RunResult> {
  const { today = null, saveRaw = null, render = false, verbose = true, scan } = opts;
  // 版本 pin：工具输出随版本漂移，pin 不住就响亮失败（同「冻结语料不能依赖墙上时钟」）。
  const toolVersion = checkVersion(source);
  const isCli = pyStr(transportClient(source)) === "cli";
  const perDate: Record<string, DateEntry> = {};
  let rawFirst: string | null = null;
  for (const date of dates) {
    const url = urlFor(source, date, today);
    const [code, body] = await fetchSource(source, url);
    if (blocked(source, code, body)) {
      if (verbose) {
        console.log(isCli
          ? `${date}: 命令退出码 ${code} —— 没有成功拿到数据（\`${cliBinOf(source)}\`，看 stderr 是否命中 block_markers）`
          : `${date}: HTTP ${code} —— 被风控挡住（${pyStr(transportClient(source))}）`);
      }
      perDate[date] = { error: isCli ? `exit ${code}` : `HTTP ${code}`, url };
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
      const bestSpec = ((source["selects"] || []) as Array<Record<string, any>>)
        .find((x) => pyStr(x["key"]) === "best");
      const fdef = (source["filters"] || {}) as Record<string, unknown>;
      const timeField = hasOwn(fdef, "time_field") ? pyStr(fdef["time_field"]) : "";
      console.log(`${date}: ${rows.length} 条` + (bits ? ` | ${bits}` : "")
        + (best && bestSpec
          ? ` | ${pyStr(getOr(bestSpec, "label", bestSpec["key"]))} ${selectIdentityText(source, best)} `
            + `${pyStr(getOr(best, timeField, ""))} ${selectValueText(source, bestSpec, best)}`
          : ""));
    }
    if (saveRaw) {
      fs.mkdirSync(saveRaw, { recursive: true });
      fs.writeFileSync(path.join(saveRaw, `${pyStr(source["name"])}-${date}.html`), body, "utf-8");
    }
  }
  if (render && rawFirst !== null && scan === undefined) {
    throw new ValueError("render 需要注入扫描器（P2 2.2b 迁移中）：runSource(..., { render: true, scan }) —— 不静默丢 render");
  }
  const rendered = render && rawFirst !== null ? await renderAndSnapshot(rawFirst, scan!) : null;
  const renderedOut: Record<string, unknown> = {};
  if (rendered) {
    for (const [k, v] of Object.entries(rendered)) if (k !== "text") renderedOut[k] = v;
  }
  return {
    source: source["name"], fetched_at: isoNowSeconds(), dates: perDate, rendered: renderedOut,
    ...(toolVersion ? { tool_version: toolVersion } : {}),
  };
}

const USAGE = `usage: datasource [-h] [--source SOURCE] [--list] [--sources-dir DIR]
                  [--dates [DATES ...]] [--render] [--save-raw DIR] [--json JSON]
                  [--out OUT]

按配置从站点取数（数据源引擎）`;

export async function main(argv: string[] = process.argv.slice(2), scan?: RenderScan): Promise<number> {
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

  if (render && scan === undefined) {
    console.log("datasource: render 需要注入扫描器（P2 2.2b 迁移中）—— --render 暂无默认实现");
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
  const res = await runSource(source, useDates, { saveRaw, render, scan });
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
