/**
 * **Host 信封（navigation envelope）—— 单一实现**（F2/L2 合并）。
 *
 * 历史：同一语义（URL 是否落在声明的 hosts 信封内）在 `extraction.ts`（`urlInHostsEnvelope`
 * 布尔视图）与 `executor-pure.ts`（`disallowedHost` 拒绝视图）各写一遍，修一处漏一处——
 * 而这是**安全语义**（导航/iframe 门禁），两份实现一旦漂移就有真实越权面。
 *
 * 这里收敛为一个核心判定 `hostEnvelopeViolation`，两个 API 从它派生，行为逐字节不变：
 *   - `disallowedHost`     → 拒绝视图：返回越界 host 或 null（executor 门禁用）。
 *   - `urlInHostsEnvelope` → 布尔视图：true = 在信封内（extraction/池抽帧用）。
 *
 * 判定规则（有意与合并前逐字节一致，勿改）：
 *   - 无 hosts / 空 → 不设防（true / null）。
 *   - URL 解析失败 → 放行（不可判 origin 时绝不擅自排除）。
 *   - `file:`/`about:`/`data:` → 放行（信封只管网络，不管 fixture）。
 *   - 否则精确 host 或任意子域匹配 → 放行。
 */
export function hostMatchesEnv(host: string, hosts: string[]): boolean {
  const h = String(host).toLowerCase();
  return hosts.some((raw) => {
    const e = String(raw).toLowerCase().replace(/^\.+/, "");
    if (!e) return false;
    return h === e || h.endsWith("." + e);
  });
}

/** 核心判定：URL 越出信封返回被拒 host，否则返回 null。单一实现。 */
export function hostEnvViolation(url: string, hosts: string[] | null | undefined): string | null {
  if (!hosts || hosts.length === 0) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // unparseable: whatever the page does next, it is checked again post-action.
    return null;
  }
  if (["file:", "about:", "data:"].includes(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (!host) return null;
  return hostMatchesEnv(host, hosts) ? null : host;
}

/** 拒绝视图：返回越界 host 或 null（导航/帧门禁）。 */
export function disallowedHost(url: string, hosts: string[] | null | undefined): string | null {
  return hostEnvViolation(url, hosts);
}

/** 信封布尔视图：true = 在信封内（放行）。 */
export function urlInHostsEnvelope(url: string, hosts: string[] | null | undefined): boolean {
  return hostEnvViolation(url, hosts) === null;
}

/* ------------------------------------------------------------------ 声明期归一化 */

/**
 * **声明期**（hosts 入参解析处）的归一化 —— 匹配语义的第二个面，不是第二个匹配器。
 *
 * 为什么必须有：`hostMatchesEnv` 只做「全等 / 子域后缀」，所以一条带 path/query/port 的声明
 * （`www.google.com/maps`、`maps.google.com:443`）**永远不可能**命中任何页面 URL 的 hostname
 * ——它是"声明了一条永假的规则"，且缺了这一步时没有任何告警，调用方会以为自己声明了那个
 * 站点。这里把每条声明解释成它想说的 **host**（剥离 scheme/userinfo/port/path/query/fragment，
 * 小写、去首尾点），逐条留下"原文 → 结果 + 原因"，并汇成**一条**人读告警（不阻断）。
 *
 * 安全边界不动：匹配仍走 `hostMatchesEnv` 的全等/子域后缀，剥离只发生在**声明**这一侧；
 * 归一化后的 host 就是原声明里的 host 部分，因此不会把 `www.google.com/maps` 变成
 * "匹配 www.google.com 之外的东西"。
 */
export interface HostsAdjustment {
  /** 入参原文（非字符串按 JSON 呈现）。 */
  raw: string;
  /** 归一化后的 host（null = 该条被丢弃）。 */
  host: string | null;
  /** 人读原因（`carried a path` / `carried a port` / `not a valid hostname` / …）。 */
  problem: string;
}

/** `normalizeHostsEnvelope` 的结果（归一化后的信封 + 逐条解释 + 单条告警）。 */
export interface HostsEnvelopeNormalization {
  /** 解释后的信封：小写 host、去重、保持首次出现顺序；空数组 = 未声明（不设防）。 */
  hosts: string[];
  /** 入参条目数（含非字符串/空串，用于"传了 N 条"的回显）。 */
  declared: number;
  /** 被改写或丢弃的条目（原样通过的条目不出现）。 */
  adjusted: HostsAdjustment[];
  /** **单条**人读告警（无改写/丢弃 = null）。 */
  warning: string | null;
}

/** 告警里逐条列举的条目上限（其余折成计数，保证始终是一行）。 */
const HOSTS_WARNING_MAX_ITEMS = 6;

/**
 * 一个 host 字面量的归一：小写、去首尾点；合法性交给 URL 解析（顺带处理 IDN →
 * punycode、IPv6 方括号）。解析不了 = null（该条不可用）。
 */
function bareHostOf(value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  let host: string;
  try {
    // 只借 URL 的 hostname 解析：路径已被调用方切掉，这里再包一层只为拿到规范化结果
    // （顺带 IDN → punycode、小写化）。
    host = new URL(`http://${v}/`).hostname;
  } catch {
    return null;
  }
  const out = host.toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
  if (out === "" || out.includes("..")) return null;
  // IPv6 字面量（方括号 + 十六进制/冒号/点）是合法 hostname 形态，单独放行。
  if (out.startsWith("[") && out.endsWith("]")) return /^\[[0-9a-f:.]+\]$/.test(out) ? out : null;
  // URL 解析器对 `*` 之类的字符是宽容的，但页面 URL 的 hostname 永远不含它们 —— 这类声明
  // 同样"永假"，必须在这里点名丢弃，而不是留一个永远不命中的条目。
  if (/[*?#@/\\:\s]/.test(out)) return null;
  return out;
}

/** 把一条声明解释成 host；`problems` 非空 = 该条被改写（host 非 null）或丢弃（null）。 */
function hostEntryToHost(raw: unknown): { host: string | null; problems: string[] } {
  if (typeof raw !== "string") return { host: null, problems: ["not a string"] };
  let s = raw.trim();
  if (s === "") return { host: null, problems: ["empty entry"] };
  const problems: string[] = [];
  // 完整 URL（带 scheme）：URL 已经把 userinfo/port/path/query 拆开，hostname 就是 host。
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    problems.push("carried a scheme");
    try {
      return { host: bareHostOf(new URL(s).hostname), problems };
    } catch {
      return { host: null, problems: [...problems, "unparseable URL"] };
    }
  }
  // 裸 authority：userinfo 在 host 之前，path/query/fragment 在 host 之后。
  const at = s.lastIndexOf("@");
  if (at >= 0) { problems.push("carried userinfo"); s = s.slice(at + 1); }
  const cut = s.search(/[/?#]/);
  if (cut >= 0) {
    const tail = s.slice(cut);
    problems.push(tail.startsWith("?") ? "carried a query" : tail.startsWith("#") ? "carried a fragment" : "carried a path");
    s = s.slice(0, cut);
  }
  // 端口：IPv6 字面量在 `]` 之后，其余在最后一个 `:` 之后（非数字端口 = 不是 host，丢弃）。
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close < 0) return { host: null, problems: [...problems, "unterminated IPv6 literal"] };
    if (s.slice(close + 1).startsWith(":")) { problems.push("carried a port"); s = s.slice(0, close + 1); }
  } else {
    const colon = s.lastIndexOf(":");
    if (colon >= 0) {
      if (!/^\d+$/.test(s.slice(colon + 1))) return { host: null, problems: [...problems, "carried a non-numeric port"] };
      problems.push("carried a port");
      s = s.slice(0, colon);
    }
  }
  const host = bareHostOf(s);
  return host === null ? { host: null, problems: [...problems, "not a valid hostname"] } : { host, problems };
}

/** 单条告警：只在有条目被改写/丢弃时出现（0 条 = null），始终一行。 */
function hostsWarning(adjusted: HostsAdjustment[], declared: number, kept: number): string | null {
  if (adjusted.length === 0) return null;
  const shown = adjusted.slice(0, HOSTS_WARNING_MAX_ITEMS).map((a) => a.host === null
    ? `${JSON.stringify(a.raw)} dropped (${a.problem})`
    : `${JSON.stringify(a.raw)} → ${JSON.stringify(a.host)} (${a.problem})`);
  const rest = adjusted.length - shown.length;
  return `hosts envelope: ${adjusted.length} of ${declared} declared entries were not bare hostnames and were normalised before use — `
    + `${shown.join("; ")}${rest > 0 ? `; … (${rest} more)` : ""}; `
    + `${kept} host(s) in effect. Matching still requires the exact normalised host or a subdomain of it, `
    + "so declare bare hosts (e.g. \"www.google.com\") to make the intent explicit.";
}

/**
 * hosts 声明的**唯一**归一化入口（声明期调用一次；纯函数、无副作用）。
 * 调用方把 `hosts` 存进信封、把 `warning` 打到人读日志、把 `hostsEnvelopeLogLine` 的整行
 * 回显出来 —— 于是"我传的 N 条被解释成了什么"对调用方可见。
 */
export function normalizeHostsEnvelope(raw: unknown): HostsEnvelopeNormalization {
  const entries: unknown[] = Array.isArray(raw) ? raw : [];
  const hosts: string[] = [];
  const adjusted: HostsAdjustment[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const rawText = typeof entry === "string" ? entry : (JSON.stringify(entry) ?? String(entry));
    const parsed = hostEntryToHost(entry);
    if (parsed.host === null) {
      adjusted.push({ raw: rawText, host: null, problem: parsed.problems.join(", ") });
      continue;
    }
    if (seen.has(parsed.host)) {
      adjusted.push({ raw: rawText, host: parsed.host, problem: [...parsed.problems, "duplicate of an earlier entry"].join(", ") });
      continue;
    }
    seen.add(parsed.host);
    hosts.push(parsed.host);
    if (parsed.problems.length > 0) adjusted.push({ raw: rawText, host: parsed.host, problem: parsed.problems.join(", ") });
  }
  return { hosts, declared: entries.length, adjusted, warning: hostsWarning(adjusted, entries.length, hosts.length) };
}

/**
 * 声明期**回显行**："传了 N 条 → 生效 M 个 host（其中 K 条被归一化）"+ 生效列表。
 * 未声明 = null（不打无内容的人读日志）。与 `warning` 分两行：一行是解释结果，一行是
 * 需要用户注意的改写事实（无改写时只有前者）。
 */
export function hostsEnvelopeLogLine(norm: HostsEnvelopeNormalization): string | null {
  if (norm.declared === 0) return null;
  const listed = norm.hosts.length === 0 ? "(no usable host — the envelope is unset)" : norm.hosts.join(", ");
  const tail = norm.adjusted.length === 0 ? ""
    : `, ${norm.adjusted.length} normalised — see the hosts envelope warning`;
  return `hosts envelope: ${listed} (declared ${norm.declared} → ${norm.hosts.length} host(s)${tail})`;
}