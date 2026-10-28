/**
 * **线上用例的加载与校验**（离线、无浏览器、无网络）。
 *
 * 这一层是新的“门禁”：case 一旦退化成 file://、引用旧夹具、写死密钥或缺少
 * 完成信号，在 PR 阶段就红，而不是等线上跑到一半才说。
 */
import fs from "node:fs";
import path from "node:path";
import { REPO } from "../support/paths.ts";
import { validateSignalSpec } from "../engine/signals.ts";
import { isSecretKey } from "../support/config-schema.ts";
import type {
  OnlineBundle, OnlineCase, OnlineOracle, OnlineSite, OnlineSubgoal, OnlineTier,
} from "./types.ts";

const TIERS: readonly OnlineTier[] = ["smoke", "core", "deep", "probe"];
const FORBIDDEN_URL = /(^|[/:])(testpages|bench\/fixtures|transfer\/site|ctrip\/site|semantic\/site|qunar\/results)(\/|$)|^file:/i;

export function onlineRoot(root: string = REPO): string {
  return path.join(root, "online");
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function jsonFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...jsonFiles(p));
    else if (ent.isFile() && ent.name.endsWith(".json")) out.push(p);
  }
  return out.sort();
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

function nextMonday(d: Date): Date {
  const day = d.getDay(); // 0 Sun .. 6 Sat
  let diff = (8 - day) % 7;
  if (diff === 0) diff = 7;
  return addDays(d, diff);
}

function expandDates(text: string, now: Date): string {
  return text
    .replace(/\{\{today\+(\d+)d\}\}/g, (_, n: string) => ymd(addDays(now, Number(n))))
    .replace(/\{\{today\}\}/g, () => ymd(now))
    .replace(/\{\{next_monday\}\}/g, () => ymd(nextMonday(now)));
}

function expandEnv(text: string, env: NodeJS.ProcessEnv): string {
  return text.replace(/\{\{env:([A-Z0-9_]+)(?:\|([^}]*))?\}\}/g, (_, name: string, dflt?: string) => {
    const v = env[name];
    return v !== undefined && v !== "" ? v : (dflt ?? "");
  });
}

/** 递归替换日期占位符；**不**替换 env（加载期校验要看到 `{{env:…}}` 才知道它不是明文）。 */
export function expandDatesValue(value: unknown, now = new Date()): unknown {
  if (typeof value === "string") return expandDates(value, now);
  if (Array.isArray(value)) return value.map((v) => expandDatesValue(v, now));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = expandDatesValue(v, now);
    return out;
  }
  return value;
}

/** 运行期替换 `{{env:NAME|default}}`；只在真正执行前调用，校验/列出时不解析凭据。 */
export function expandEnvValue(value: unknown, env = process.env): unknown {
  if (typeof value === "string") return expandEnv(value, env);
  if (Array.isArray(value)) return value.map((v) => expandEnvValue(v, env));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = expandEnvValue(v, env);
    return out;
  }
  return value;
}

export function loadSites(root: string = REPO): Map<string, OnlineSite> {
  const dir = path.join(onlineRoot(root), "sites");
  const sites = new Map<string, OnlineSite>();
  for (const file of jsonFiles(dir)) {
    const site = readJson(file) as OnlineSite;
    if (site && typeof site.id === "string" && site.id !== "") sites.set(site.id, { ...site, id: site.id });
  }
  return sites;
}

export function loadCases(root: string = REPO, opts: { now?: Date } = {}): OnlineCase[] {
  const dir = path.join(onlineRoot(root), "cases");
  const now = opts.now ?? new Date();
  const cases: OnlineCase[] = [];
  for (const file of jsonFiles(dir)) {
    cases.push(expandDatesValue(readJson(file), now) as OnlineCase);
  }
  return cases.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function loadBundle(root: string = REPO): OnlineBundle {
  return { sites: loadSites(root), cases: loadCases(root) };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkUrl(url: string, site: OnlineSite, where: string): string[] {
  const problems: string[] = [];
  if (!/^https?:\/\//i.test(url)) {
    problems.push(`${where}: start_url 必须是 http(s) URL（收到 ${JSON.stringify(url)}）`);
    return problems;
  }
  if (FORBIDDEN_URL.test(url)) problems.push(`${where}: start_url 引用了已删除的离线夹具：${url}`);
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { problems.push(`${where}: 不是合法 URL：${url}`); return problems; }
  if (!site.hosts.map((h) => h.toLowerCase()).includes(host)) {
    problems.push(`${where}: 主机 ${host} 不在 site ${JSON.stringify(site.id)} 的 hosts 白名单里`);
  }
  if ((host === "localhost" || host === "127.0.0.1" || host === "::1") && site.allow_local !== true) {
    problems.push(`${where}: localhost 需要 site.allow_local=true`);
  }
  return problems;
}

function checkSecrets(value: unknown, where: string, problems: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkSecrets(v, `${where}[${i}]`, problems));
    return;
  }
  if (!isObject(value)) return;
  for (const [k, v] of Object.entries(value)) {
    if (isSecretKey(k)) {
      if (typeof v !== "string" || !v.includes("{{env:")) {
        problems.push(`${where}.${k}: 凭据只能写成 {{env:NAME}} 或 {{env:NAME|default}}，不能是明文`);
      }
    }
    checkSecrets(v, `${where}.${k}`, problems);
  }
}

export function validateSite(site: OnlineSite, where = "site"): string[] {
  const p: string[] = [];
  if (!site || typeof site !== "object") return [`${where}: site must be an object`];
  if (typeof site.id !== "string" || site.id.trim() === "") p.push(`${where}: id must be a non-empty string`);
  if (!Array.isArray(site.hosts) || site.hosts.length === 0) p.push(`${where}: hosts must be a non-empty list`);
  else for (const [i, h] of site.hosts.entries()) {
    if (typeof h !== "string" || h.trim() === "" || /[/:]/.test(h)) p.push(`${where}.hosts[${i}]: 只能是主机名`);
  }
  if (typeof site.home !== "string" || !/^https?:\/\//i.test(site.home)) p.push(`${where}: home must be http(s) URL`);
  if (site.timeout_ms !== undefined && (!Number.isFinite(site.timeout_ms) || site.timeout_ms! < 1000)) {
    p.push(`${where}: timeout_ms must be >= 1000`);
  }
  if (site.blocked_markers !== undefined && !Array.isArray(site.blocked_markers)) p.push(`${where}: blocked_markers must be a list`);
  if (site.login_markers !== undefined && !Array.isArray(site.login_markers)) p.push(`${where}: login_markers must be a list`);
  return p;
}

export function validateOracle(oracle: OnlineOracle, where: string): string[] {
  if (!isObject(oracle)) return [`${where}: oracle must be an object`];
  const kind = (oracle as { kind?: unknown }).kind;
  if (kind === "url_contains") return typeof (oracle as { value?: unknown }).value === "string" ? [] : [`${where}: url_contains.value must be a string`];
  if (kind === "css_count") {
    const o = oracle as { selector?: unknown; min?: unknown; max?: unknown };
    return typeof o.selector === "string" ? [] : [`${where}: css_count.selector must be a string`];
  }
  if (kind === "text_order") {
    const o = oracle as { selector?: unknown; direction?: unknown };
    return typeof o.selector === "string" && (o.direction === "asc" || o.direction === "desc")
      ? [] : [`${where}: text_order needs selector + direction asc|desc`];
  }
  if (kind === "text_set") {
    const o = oracle as { selector?: unknown; values?: unknown };
    return typeof o.selector === "string" && Array.isArray(o.values)
      ? [] : [`${where}: text_set needs selector + values[]`];
  }
  if (kind === "attr_equals") {
    const o = oracle as { selector?: unknown; attr?: unknown; value?: unknown };
    return typeof o.selector === "string" && typeof o.attr === "string" && typeof o.value === "string"
      ? [] : [`${where}: attr_equals needs selector + attr + value`];
  }
  return [`${where}: unknown oracle kind ${JSON.stringify(kind)}`];
}

export function validateCase(c: OnlineCase, sites: Map<string, OnlineSite>, where = "case"): string[] {
  const p: string[] = [];
  if (!isObject(c)) return [`${where}: case must be an object`];
  if (typeof c.id !== "string" || c.id.trim() === "") p.push(`${where}: id must be a non-empty string`);
  if (typeof c.goal !== "string" || c.goal.trim() === "") p.push(`${where}: goal must be a non-empty string`);
  if (!TIERS.includes(c.tier)) p.push(`${where}: tier must be one of ${TIERS.join(", ")}`);
  const site = sites.get(String(c.site));
  if (!site) p.push(`${where}: unknown site ${JSON.stringify(c.site)}`);
  if (site) p.push(...validateSite(site, `${where}.site`));
  if (c.start_url !== undefined && site) p.push(...checkUrl(c.start_url, site, `${where}.start_url`));
  if (c.timeout_ms !== undefined && (!Number.isFinite(c.timeout_ms) || c.timeout_ms < 1000)) {
    p.push(`${where}: timeout_ms must be >= 1000`);
  }
  checkSecrets(c.slots ?? {}, `${where}.slots`, p);

  const subgoals = c.subgoals ?? [];
  if (!Array.isArray(subgoals)) p.push(`${where}: subgoals must be a list`);
  else for (const [i, sg] of subgoals.entries()) {
    const at = `${where}.subgoals[${i}]`;
    if (!isObject(sg)) { p.push(`${at}: subgoal must be an object`); continue; }
    if (typeof sg.desc !== "string" || sg.desc.trim() === "") p.push(`${at}: desc must be a non-empty string`);
    if (!isObject(sg.signal) || !Object.keys(sg.signal).length) p.push(`${at}: missing done-signal`);
    else p.push(...validateSignalSpec(sg.signal, `${at}.signal`));
    if (typeof sg.start_url !== "string" || sg.start_url.trim() === "") p.push(`${at}: start_url must be a non-empty string`);
    else if (site) p.push(...checkUrl(sg.start_url, site, `${at}.start_url`));
    if (sg.when !== undefined) p.push(...validateSignalSpec(sg.when, `${at}.when`));
    if (sg.retries !== undefined && (!Number.isInteger(sg.retries) || sg.retries < 0 || sg.retries > 5)) {
      p.push(`${at}: retries must be an integer 0..5`);
    }
    checkSecrets(sg.slots ?? {}, `${at}.slots`, p);
  }

  const inv = c.invariants ?? [];
  if (!Array.isArray(inv)) p.push(`${where}: invariants must be a list`);
  else for (const [i, x] of inv.entries()) {
    const at = `${where}.invariants[${i}]`;
    if (!isObject(x)) { p.push(`${at}: invariant must be an object`); continue; }
    if (typeof x.id !== "string" || x.id.trim() === "") p.push(`${at}: id must be a non-empty string`);
    if (typeof x.desc !== "string" || x.desc.trim() === "") p.push(`${at}: desc must be a non-empty string`);
    p.push(...validateSignalSpec(x.signal, `${at}.signal`));
  }

  if (c.oracle !== undefined) p.push(...validateOracle(c.oracle, `${where}.oracle`));
  if (c.expect !== undefined) {
    if (c.tier !== "probe") p.push(`${where}: expect 只允许在 probe 用例`);
    if (!Array.isArray(c.expect) || c.expect.length === 0) p.push(`${where}: expect 必须是非空列表`);
  }
  if (c.tier !== "probe") {
    if (!subgoals.length && !c.start_url) p.push(`${where}: 非 probe 用例至少要有 subgoals 或 start_url`);
    if (!inv.length) p.push(`${where}: 非 probe 用例至少要有 1 条结束态 invariant`);
  }
  return p;
}

export function validateBundle(bundle: OnlineBundle): string[] {
  const p: string[] = [];
  const ids = new Set<string>();
  for (const [id, site] of bundle.sites) {
    p.push(...validateSite(site, `site[${JSON.stringify(id)}]`));
  }
  for (const [i, c] of bundle.cases.entries()) {
    const where = `case[${i}] ${JSON.stringify(c?.id ?? "?")}`;
    p.push(...validateCase(c, bundle.sites, where));
    if (ids.has(c.id)) p.push(`${where}: duplicate case id`);
    ids.add(c.id);
  }
  return p;
}

/** 按 tier / case / site 过滤；默认只跑 smoke+core，probe 必须显式选。 */
export function selectCases(
  cases: OnlineCase[], opts: { tier?: string; id?: string; site?: string } = {},
): OnlineCase[] {
  const tier = opts.tier ?? "default";
  return cases.filter((c) => {
    if (opts.id !== undefined && c.id !== opts.id) return false;
    if (opts.site !== undefined && c.site !== opts.site) return false;
    if (tier === "all") return c.tier !== "probe";
    if (tier === "default") return c.tier === "smoke" || c.tier === "core";
    return c.tier === tier;
  });
}

export function tierOf(value: string): OnlineTier | "all" | "default" | null {
  if (value === "all" || value === "default") return value;
  return (TIERS as readonly string[]).includes(value) ? value as OnlineTier : null;
}