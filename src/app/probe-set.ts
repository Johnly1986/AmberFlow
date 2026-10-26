/**
 * **探针集（probe set）**：把"线上到底能不能打开、能拿到什么"这套测量做成声明式数据。
 *
 * 站点知识属于站点档案；共享层代码不许出现站点标识。
 * 探针声明（hosts / URL / 风控与登录标记 / 判决角色）属于用户应用或 `online/`，
 * 驱动只剩"怎么测"的机械动作。
 *
 * `probe` 块与 `journey` **互斥可选**：一个应用可以只声明探针（测量型应用），也可以
 * 探针 + 旅程都有。加载期校验两件事（都为了不让声明"写了没用"）：
 *   1. 未知键报错（`probe` / 目标 / markers / login 各自的白名单）；
 *      （markers 的每个键都是**一个被观测的量**，不是装饰：`gate_text` 是风控品牌词、
 *      `block_text` 是"被挡"的正文特征、`challenge_text` 是人机校验词——它们的集合
 *      故意不合并，因为合并会悄悄改变已提交测量字段的含义。）
 *   2. **每个 URL 的主机必须在 `hosts` 里**——否则这个主机就不在防泄漏门禁的覆盖范围内，
 *      等于偷偷把站点知识藏起来。
 */
import fs from "node:fs";
import { REPO } from "../support/paths.ts";
import { appDataFileInDir, readDataFile } from "./declarative.ts";

export { REPO };
import path from "node:path";

export const APPS_DIR = path.join(REPO, "apps");

export const SPEC_VERSION = 1;

export const PROBE_KEYS = [
  "date", "results_dir", "home", "http", "browser", "alts", "mobile", "repeat", "capture",
  "roles", "markers", "login", "notes", "baseline",
] as const;
export const TARGET_KEYS = ["id", "label", "short", "url"] as const;
export const MARKER_KEYS = [
  "gate_text", "block_text", "login_text", "challenge_text", "notice_text", "price_re", "title_re",
  "flight_rows", "hotel_cards", "empty_price_re", "hotel_name_re", "hotel_total_re",
] as const;
export const LOGIN_KEYS = ["hosts", "paths", "titles"] as const;

export interface ProbeTarget {
  id: string;
  label: string;
  /** 判决文本里当"这个站点"用的短名（原来是写死的主机名）——数据，不是代码。 */
  short?: string;
  url: string;
}

export interface ProbeSet {
  app: string;
  path: string;
  date: string;
  resultsDir: string;
  home: ProbeTarget | null;
  http: ProbeTarget[];
  browser: string[];
  alts: ProbeTarget[];
  mobile: ProbeTarget[];
  repeat: { id: string; times: number } | null;
  capture: ProbeTarget[];
  roles: Record<string, string>;
  markers: Record<string, string | string[]>;
  login: { hosts: string[]; paths: string[]; titles: string[] };
  notes: string[];
}

/** 目标 URL 里允许的占位符（数据里能写的"参数"就这四个：日期与离店日）。 */
export const DATE_PLACEHOLDERS = ["date", "date_slash", "checkout", "checkout_slash"] as const;

export function hostOfUrl(url: string): string | null {
  const m = /^https?:\/\/([^/]+)/.exec(String(url ?? ""));
  return m ? m[1]!.toLowerCase() : null;
}

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

const strList = (v: unknown): string[] => asList(v).map((x) => String(x));

/** `{date}` / `{date_slash}` / `{checkout}` / `{checkout_slash}` → 真实日期；未知占位符不动（校验期已报错）。 */
export function fillProbeDate(url: string, date: string): string {
  const slash = date.replace(/-/g, "/");
  const checkout = addDays(date, 1);
  const map: Record<string, string> = {
    date, date_slash: slash, checkout, checkout_slash: checkout.replace(/-/g, "/"),
  };
  return url.replace(/\{([a-z_]+)\}/g, (all, k: string) => (k in map ? map[k]! : all));
}

/** `date + n` 天（探针的 `{checkout}` 用它；纯日历运算，不碰时钟）。 */
export function addDays(date: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date).trim());
  if (!m) throw new Error(`invalid ISO date: ${JSON.stringify(date)}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  const p = (x: number): string => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function targetProblems(t: unknown, where: string, hosts: Set<string>, p: string[]): void {
  if (!isDict(t)) { p.push(`${where}: target must be an object`); return; }
  for (const k of Object.keys(t)) {
    if (!(TARGET_KEYS as readonly string[]).includes(k)) {
      p.push(`${where}.${k}: unknown target key (known: ${TARGET_KEYS.join(", ")})`);
    }
  }
  // G-F：id 必须是**字符串**。以前 `String(id)` 会把数字 id 静默接受，而
  // `roles`/`browser`/`repeat` 的引用校验与 `shortOf` 查找都在另一个命名空间里，
  // 数字 1 与字符串 "1" 会在那里对不上——加载期就该拒绝。
  if (!t["id"]) p.push(`${where}: target needs an id`);
  else if (typeof t["id"] !== "string") {
    // G-F：数字 id 以前被静默 `String()`。`roles`/`browser`/`repeat` 的引用校验和 `shortOf`
    // 查找用的是字符串命名空间，数字 1 与 "1" 在那里对不上——加载期拒绝，不留到运行期。
    p.push(`${where}.id must be a string (ids are referenced by roles/browser/repeat)`);
  }
  if (!t["url"]) p.push(`${where}: target needs a url`);
  const url = String(t["url"] ?? "");
  const h = hostOfUrl(url);
  if (url && h === null) p.push(`${where}.url: not an http(s) URL: ${JSON.stringify(url)}`);
  if (h !== null && !hosts.has(h)) {
    // **包括 `hosts` 缺失/为空时**：原来这里是 `hosts.size && !hosts.has(h)`，于是
    // `hosts: []` 成了一道后门 —— 探针可以打着任意主机而门禁看不见它（"声明了就覆盖到"
    // 这句话必须双向成立：没声明的主机就是错误）。
    p.push(`${where}.url host ${JSON.stringify(h)} is not declared in pack.hosts (the leak gate would miss it)`);
  }
  for (const ph of new Set([...url.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]!))) {
    if (!(DATE_PLACEHOLDERS as readonly string[]).includes(ph)) {
      p.push(`${where}.url: unknown placeholder {${ph}} (known: ${DATE_PLACEHOLDERS.join(", ")})`);
    }
  }
}

/**
 * 加载期校验探针块。`hosts` 是应用声明的站点清单（防泄漏门禁的输入）——
 * 这里强制"声明了就覆盖到"，所以不可能出现"探针打着一个没被门禁覆盖的主机"。
 */
export function validateProbeBlock(probe: unknown, hostsRaw: unknown, where = "probe"): string[] {
  const p: string[] = [];
  if (!isDict(probe)) { p.push(`${where}: must be an object`); return p; }
  const hosts = new Set(strList(hostsRaw ?? []).map((h) => h.toLowerCase()));
  // `hosts` 必须是字符串列表（门禁逐项遍历它；裸字符串会被按字符建 token）。
  if (hostsRaw !== undefined && (!Array.isArray(hostsRaw) || hostsRaw.some((h) => typeof h !== "string"))) {
    p.push(`${where}: hosts must be a list of strings (the leak gate iterates it)`);
  }
  for (const k of Object.keys(probe)) {
    if (!(PROBE_KEYS as readonly string[]).includes(k)) {
      p.push(`${where}.${k}: unknown key (known: ${PROBE_KEYS.join(", ")})`);
    }
  }
  const date = probe["date"];
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    p.push(`${where}.date must be YYYY-MM-DD`);
  }
  if (probe["results_dir"] !== undefined && typeof probe["results_dir"] !== "string") {
    p.push(`${where}.results_dir must be a repo-relative path`);
  }
  if (probe["home"] !== undefined) targetProblems(probe["home"], `${where}.home`, hosts, p);
  // G-E：四类目标共享一个 id 命名空间（`roles`/`browser`/`repeat` 都按 id 引用，
  // `shortOf` 也是全局查找），所以重复 id 必须**跨列表**检测，而不只是列表内。
  const seenIds = new Map<string, string>();
  for (const key of ["http", "alts", "mobile", "capture"] as const) {
    const list = probe[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || !list.length) { p.push(`${where}.${key} must be a non-empty list`); continue; }
    list.forEach((t, i) => targetProblems(t, `${where}.${key}[${i}]`, hosts, p));
    const ids = list.map((t) => String((t as Record<string, unknown>)["id"] ?? ""));
    if (new Set(ids).size !== ids.length) p.push(`${where}.${key}: duplicate target ids`);
    list.forEach((t, i) => {
      const id = (t as Record<string, unknown>)["id"];
      if (typeof id !== "string" || !id) return;          // 已在 targetProblems 里报过
      const at = seenIds.get(id);
      if (at !== undefined && !at.startsWith(`${where}.${key}[`)) {
        p.push(`${where}.${key}[${i}]: duplicate target id ${JSON.stringify(id)}`
          + ` (already declared at ${at}); ids are one namespace across the target lists`);
      } else if (at === undefined) {
        seenIds.set(id, `${where}.${key}[${i}]`);
      }
    });
  }
  if (probe["browser"] !== undefined) {
    const known = new Set((Array.isArray(probe["http"]) ? probe["http"] : [])
      .map((t) => String((t as Record<string, unknown>)["id"] ?? "")));
    for (const id of strList(probe["browser"])) {
      if (!known.has(id)) p.push(`${where}.browser: ${JSON.stringify(id)} is not an http target id`);
    }
  }
  const repeat = probe["repeat"];
  if (repeat !== undefined) {
    if (!isDict(repeat) || !repeat["id"]) p.push(`${where}.repeat needs an http target id`);
    else {
      const known = new Set((Array.isArray(probe["http"]) ? probe["http"] : [])
        .map((t) => String((t as Record<string, unknown>)["id"] ?? "")));
      if (!known.has(String(repeat["id"]))) {
        p.push(`${where}.repeat.id ${JSON.stringify(String(repeat["id"]))} is not an http target id`);
      }
      const times = Number(repeat["times"] ?? 0);
      if (!Number.isFinite(times) || times < 1) p.push(`${where}.repeat.times must be a positive integer`);
      for (const k of Object.keys(repeat)) if (!["id", "times"].includes(k)) p.push(`${where}.repeat.${k}: unknown key`);
    }
  }
  const roles = probe["roles"];
  if (roles !== undefined) {
    if (!isDict(roles)) p.push(`${where}.roles must be an object`);
    else {
      const ids = new Set((Array.isArray(probe["http"]) ? probe["http"] : [])
        .map((t) => String((t as Record<string, unknown>)["id"] ?? "")));
      for (const [role, id] of Object.entries(roles)) {
        if (!ids.has(String(id))) p.push(`${where}.roles.${role}: ${JSON.stringify(String(id))} is not an http target id`);
      }
    }
  }
  // `baseline`：上一次真实探测测出来的**判决**（不是输入）。见 tools/probe-baseline.ts——
  // 它让"站点变了"从"再读一遍报告"变成一条会变红的检查；只存标量判决，不存 reason。
  const baseline = probe["baseline"];
  if (baseline !== undefined) {
    if (!isDict(baseline)) {
      p.push(`${where}.baseline must be an object {verdicts}`);
    } else {
      for (const k of Object.keys(baseline)) {
        if (k !== "verdicts") p.push(`${where}.baseline.${k}: unknown key (known: verdicts)`);
      }
      const v = (baseline as Record<string, unknown>)["verdicts"];
      if (!isDict(v)) {
        p.push(`${where}.baseline.verdicts must be an object of scalars`);
      } else {
        for (const [k, val] of Object.entries(v)) {
          if (typeof val !== "string") p.push(`${where}.baseline.verdicts.${k} must be a string`);
        }
      }
    }
  }
  const markers = probe["markers"];
  if (markers !== undefined) {
    if (!isDict(markers)) p.push(`${where}.markers must be an object`);
    else {
      for (const [k, v] of Object.entries(markers)) {
        if (!(MARKER_KEYS as readonly string[]).includes(k)) {
          p.push(`${where}.markers.${k}: unknown marker (known: ${MARKER_KEYS.join(", ")})`);
        }
        if (typeof v !== "string" && !Array.isArray(v)) p.push(`${where}.markers.${k} must be a string or a list`);
      }
    }
  }
  const login = probe["login"];
  if (login !== undefined) {
    if (!isDict(login)) p.push(`${where}.login must be an object`);
    else {
      for (const [k, v] of Object.entries(login)) {
        if (!(LOGIN_KEYS as readonly string[]).includes(k)) {
          p.push(`${where}.login.${k}: unknown key (known: ${LOGIN_KEYS.join(", ")})`);
        }
        if (!Array.isArray(v)) p.push(`${where}.login.${k} must be a list`);
      }
      for (const h of strList(login["hosts"] ?? [])) {
        const hh = h.toLowerCase();
        if (!hosts.has(hh)) {
          p.push(`${where}.login.hosts ${JSON.stringify(h)} is not declared in pack.hosts`);
        }
      }
    }
  }
  return p;
}

function dirsWithData(): string[] {
  if (!fs.existsSync(APPS_DIR)) return [];
  return fs.readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && appDataFileInDir(path.join(APPS_DIR, e.name)) !== null)
    .map((e) => path.join(APPS_DIR, e.name))
    .sort();
}

export function listProbeSets(): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  for (const dir of dirsWithData()) {
    const p = appDataFileInDir(dir)!;
    try {
      const raw = readDataFile(p);
      if (raw["probe"] === undefined) continue;
      out.push([String(raw["id"] ?? path.basename(dir)), String(raw["label"] ?? ""), p]);
    } catch {
      /* 坏包由 loadProbeSet / 矩阵报错 */
    }
  }
  return out;
}

/** 按应用目录名或数据文件路径加载探针集（发现制：没有清单文件）。 */
export function loadProbeSet(nameOrPath: string): ProbeSet {
  let p = nameOrPath;
  const isFile = (x: string): boolean => { try { return fs.statSync(x).isFile(); } catch { return false; } };
  if (!isFile(p)) {
    const dirOfPath = path.dirname(p);
    let f: string | null = null;
    try { if (fs.statSync(dirOfPath).isDirectory()) f = appDataFileInDir(dirOfPath); } catch { /* 按 id 找 */ }
    if (f === null) {
      const hit = dirsWithData().find((d) => path.basename(d) === nameOrPath);
      if (hit === undefined) {
        throw new Error(`probe set ${JSON.stringify(nameOrPath)} not found under ${APPS_DIR}`);
      }
      f = appDataFileInDir(hit);
    }
    if (f === null) throw new Error(`probe set ${JSON.stringify(nameOrPath)} has no data file`);
    p = f;
  }
  const pack = readDataFile(p);
  const probe = pack["probe"];
  if (!isDict(probe)) throw new Error(`${p}: no probe block (this app is not a probe set)`);
  const problems = validateProbeBlock(probe, pack["hosts"], "probe");
  if (problems.length) throw new Error(`probe set ${p} is invalid:\n  - ${problems.join("\n  - ")}`);

  const targets = (key: string): ProbeTarget[] => (Array.isArray(probe[key]) ? probe[key] : [])
    .map((t) => {
      const o = t as Record<string, unknown>;
      return { id: String(o["id"]), label: String(o["label"] ?? o["id"]),
        ...(o["short"] === undefined ? {} : { short: String(o["short"]) }), url: String(o["url"]) };
    });
  const resultsDir = path.resolve(REPO, String(probe["results_dir"] ?? path.join("apps", "results")));
  const homeRaw = probe["home"];
  const home = isDict(homeRaw)
    ? { id: String(homeRaw["id"] ?? "home"), label: String(homeRaw["label"] ?? "home"),
      ...(homeRaw["short"] === undefined ? {} : { short: String(homeRaw["short"]) }),
      url: String(homeRaw["url"]) }
    : null;
  const markers: Record<string, string | string[]> = {};
  if (isDict(probe["markers"])) {
    for (const [k, v] of Object.entries(probe["markers"] as Record<string, unknown>)) {
      markers[k] = typeof v === "string" ? v : strList(v);
    }
  }
  const loginRaw = isDict(probe["login"]) ? probe["login"] : {};
  return {
    app: String(pack["id"] ?? path.basename(path.dirname(p))),
    path: p,
    date: String(probe["date"] ?? "2026-10-05"),
    resultsDir,
    home,
    http: targets("http"),
    browser: strList(probe["browser"] ?? []),
    alts: targets("alts"),
    mobile: targets("mobile"),
    repeat: isDict(probe["repeat"])
      ? { id: String(probe["repeat"]["id"]), times: Number(probe["repeat"]["times"] ?? 1) } : null,
    capture: targets("capture"),
    roles: isDict(probe["roles"])
      ? Object.fromEntries(Object.entries(probe["roles"] as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : {},
    markers,
    login: {
      hosts: strList(loginRaw["hosts"] ?? []), paths: strList(loginRaw["paths"] ?? []),
      titles: strList(loginRaw["titles"] ?? []),
    },
    notes: (Array.isArray(pack["notes"]) ? pack["notes"] : []).map((x) => String(x)),
  };
}

/** markers 的取值统一成列表（`block_text` 这类既可以是字符串也可以是列表）。 */
export function markerList(set: ProbeSet, key: string): string[] {
  const v = set.markers[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** 目标短名（判决文本用）：没声明就退回 id。 */
export function shortOf(set: ProbeSet, id: string): string {
  const t = [...set.http, ...set.alts, ...set.mobile, ...set.capture,
    ...(set.home ? [set.home] : [])].find((x) => x.id === id);
  return t?.short ?? t?.id ?? id;
}
