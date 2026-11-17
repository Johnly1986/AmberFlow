/**
 * `amber session` 运行时的**契约面**（选项/输出/退出码/小工具函数）。
 *
 * 从 session-runtime.ts 纯搬移（本轮大文件拆分）：类型与纯 helper 独立成模块后，
 * 运行时类、入口（runSession）与证据 helper 共用同一份声明；原文件 re-export，
 * 既有 importer（`src/cli/commands/session.ts` 等）零改动。
 */
import { sleepMs } from "../support/sleep.ts";
import { SESSION_IDLE_TIMEOUT_MS } from "../support/tuning.ts";
import type { ActMissDiagnostics, AnyPage } from "../engine/executor.ts";
import type { AmbiguityView } from "../engine/ambiguity.ts";
import type { LaunchWindowMode } from "../browser/browser-env.ts";

/** `act` 的 MVP 能力面（执行器里 drag/upload/clickAt 也有，但 authoring MVP 不暴露）。 */
export const SESSION_ACT_OPS = ["click", "check", "fill", "select", "hover", "scroll"] as const;
export type SessionActOp = (typeof SESSION_ACT_OPS)[number];

/**
 * `act scroll` 两条路径（合成目标 = `mw.scrollDocument`，元素目标 = `mw.actOnce`）的共同
 * 返回形状（B2 起含实测滚动证据）。两边都是"引擎给什么就有什么"，所以全部可选——会话层
 * 只**回显**，不补算 moved/delta。
 */
export interface SessionScrollOut {
  ok: boolean;
  stopCode?: string;
  reason?: string;
  ref?: string;
  moved?: boolean;
  delta?: number;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  ambiguity?: AmbiguityView;
  /** A4：落空（`target_not_found`）判别证据；引擎给才有。 */
  diagnostics?: ActMissDiagnostics;
}

/** 请求类型闭集（未知 type = 结构化 config_error + 这张表）。 */
export const SESSION_REQUEST_TYPES = [
  "open", "observe", "act", "read", "extract", "waitFor", "signal", "snapshot", "mark", "tab", "close",
] as const;

/** 缺省 idle 超时（两次请求之间的静默上限）。 */
export const SESSION_DEFAULT_IDLE_TIMEOUT_MS = SESSION_IDLE_TIMEOUT_MS;
/** 单行请求上限。 */
export const SESSION_DEFAULT_MAX_REQUEST_BYTES = 1_048_576;

/* ---------------------- task-38：导航 flap 检测与有界自愈 ---------------------- */

/** flap 观察窗口（open 返回后 / 自愈落地后各观察一次的时长）。 */
export const FLAP_WINDOW_MS = 1_500;
/**
 * 静默早退：open 返回后这么久仍**没有**主 frame 导航 → 稳定页，立刻放行响应（零新字段）。
 * 阈值必须大于「flap 页首次客户端导航的延迟」——zh.wikipedia 文章页实测 ~0.37–0.9s
 * 本地 fixture 250ms——取 600ms 可盖住两者实测下界；
 * 代价是稳定页 open 多等 ~600ms（任务书原文写 ≤100ms，实测对照见 task38/assert-results，
 * 常数是单点可调项，由 lead 裁决）。稳定页一旦在窗口内出现任何 post-open 导航，
 * 就放弃早退、观察满整个窗口再判严格签名。
 */
export const FLAP_QUIET_EXIT_MS = 600;
/** 自愈导航落地（DCL）后的 settle 等待，之后开复察窗口。 */
export const FLAP_HEAL_SETTLE_MS = 500;

/** 一条主 frame 导航事件（flap 检测的原始观察）。 */
export interface NavEvent { ts: number; url: string }

/** flap 判定结果（严格签名，见 `judgeFlapNavs`）。 */
export interface FlapJudgement {
  navigations: number;
  window_ms: number;
  /** 去重后的导航形态样例（≤5，保持首次出现顺序）。 */
  urls_sample: string[];
  /** 窗口内最后一次主 frame 导航的 URL（自愈兜底目标）。 */
  last_url: string;
}

/** 一次有界自愈的结果。 */
export interface FlapHealResult {
  healed: boolean;
  heal_url: string;
  reason?: string;
}

const urlOriginOf = (u: string): string => { try { return new URL(u).origin; } catch { return ""; } };
const urlPathOf = (u: string): string => { try { return new URL(u).pathname; } catch { return ""; } };
const stripFragment = (u: string): string => { const i = u.indexOf("#"); return i >= 0 ? u.slice(0, i) : u; };

/**
 * 共同 path 前缀：逐字符 LCP，完全相同则原样返回，否则回退到最后一个 "/"。
 * 返回 null = 没有非平凡前缀（如 "/a" 与 "/b" 只共出 "/"——那不是同一页面在翻形态）。
 */
function commonPathPrefix(paths: string[]): string | null {
  if (paths.length === 0) return null;
  let lcp = paths[0]!;
  for (const p of paths.slice(1)) {
    let i = 0;
    while (i < lcp.length && i < p.length && lcp[i] === p[i]) i += 1;
    lcp = lcp.slice(0, i);
    if (lcp === "") return null;
  }
  if (paths.every((p) => p === lcp)) return lcp;
  const cut = lcp.lastIndexOf("/");
  return cut > 0 ? lcp.slice(0, cut + 1) : null;
}

/**
 * task-38：主 frame 导航序列是否构成「URL flap」（**严格**触发签名）：
 *   1.5s 窗口内 ≥4 次主 frame 导航，且 URL 在 ≥2 种形态间反复交替——
 *   同一 origin、同一 path 前缀、去重后 ≥2 个 URL、至少一个形态出现 ≥2 次
 *   （A↔B 交替满足；正常重定向 1-2 次不满足次数；单向重定向链每个 URL 只出现一次，
 *   不满足「反复」；刷新同一 URL 不满足「≥2 形态」）。
 * 返回 null = 不是 flap。
 */
export function judgeFlapNavs(seq: NavEvent[], windowMs: number): FlapJudgement | null {
  if (seq.length < 4) return null;
  const urls = seq.map((n) => stripFragment(n.url));
  const distinct = [...new Set(urls)];
  if (distinct.length < 2) return null;
  if (new Set(distinct.map(urlOriginOf)).size !== 1) return null;
  const prefix = commonPathPrefix(distinct.map(urlPathOf));
  if (prefix === null || prefix.length <= 1) return null;
  if (!distinct.some((u) => urls.filter((x) => x === u).length >= 2)) return null;
  return {
    navigations: seq.length,
    window_ms: windowMs,
    urls_sample: distinct.slice(0, 5),
    last_url: urls[urls.length - 1]!,
  };
}

/**
 * task-38：自愈目标 URL——优先「编码形态」（path 含百分比编码，如 zh.wikipedia 的
 * /wiki/%E8…；实测编码标题 URL 直开是稳定的），判不出编码形态就用最后一次
 * framenavigated 的 URL。
 */
export function encodedFormUrl(urls: string[]): string | null {
  for (const u of urls) {
    try {
      const p = new URL(u).pathname;
      if (p.includes("%") && decodeURIComponent(p) !== p) return u;
    } catch { /* 坏 URL 不候选 */ }
  }
  return null;
}

export interface SessionOptions {
  /** 启动后自动 open 的入口页（`--url`）。 */
  url?: string | null;
  /** 导航信封（`--host`/`--hosts`；缺省从 `--url` 推断）。 */
  hosts?: string[] | null;
  headful?: boolean;
  /** 有头窗口尺寸模式（`--window`）：maximized | fullscreen；仅 headful 生效。 */
  window?: LaunchWindowMode | null;
  /** 证据落点（缺省 `$AMBERFLOW_HOME/session/<runId>`）。 */
  outDir?: string | null;
  /** 动作轨迹 JSONL 落点（`--record`；给了才写）。 */
  record?: string | null;
  /**
   * `--record-values`（缺省 false）：轨迹里 fill/select 除 `value_hash` 外**再记明文 `value`**。
   * 安全取舍：轨迹可能被复制进仓库/`app.mjs`，所以明文只由作者显式 opt-in；缺省恒 hash。
   */
  recordValues?: boolean;
  /** 从文件读请求而不是 stdin（`--input`；Windows 管道不可靠时用）。 */
  inputFile?: string | null;
  /**
   * A2：`act` 的缺省歧义策略（`--on-ambiguous`）。
   *   - `"fail"`（缺省）：命令步同一个歧义谓词成立时**零动作** → 结构化 `target_ambiguous`
   *     + 有界 `ambiguity` 证据（会话不再"随便点第一个候选"）；
   *   - `"act"`：恢复旧行为（`resolveCommandRef` 可行动优先取 refs[0] 直接执行）。
   * 单行请求可用 `onAmbiguous` 覆盖本次（见 `doAct`）。
   */
  onAmbiguous?: "fail" | "act";
  /**
   * S2/E5：稳定门（`--settle off` = 关）。关 = extract 不做滚动稳定判定
   * （响应不带 `scroll_settled`）、执行器抽池不等静默——与既有 settle 语义同源。
   */
  settle?: "off" | null;
  idleTimeoutMs?: number;
  maxRequestBytes?: number;
  verbose?: boolean;
  quiet?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** 输出面：`respond` 一行一个 JSON 对象（stdout）；`log` 人话（stderr）。 */
export interface SessionSink {
  respond(obj: Record<string, unknown>): void;
  log(line: string): void;
}

/** 会话收尾原因（决定退出码）。 */
export type SessionExit = "closed" | "eof" | "idle_timeout" | "browser_dead" | "interrupted";

/** 退出码：0 干净关闭 / 1 不可恢复 / 3 被挡住（idle 超时）。用完即弃的会话不是"失败"。 */
export function sessionExitCode(exit: SessionExit): number {
  if (exit === "closed" || exit === "eof") return 0;
  if (exit === "idle_timeout") return 3;
  return 1;
}

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split("\n")[0]!.slice(0, 400);
}

/** 浏览器/页面已不可复用（唯一的会话级升级判据；其余失败都只是单行失败）。 */
export function isDeadPageError(msg: string): boolean {
  return /Target page, context or browser has been closed|Target closed|browser has been closed|Browser has been closed|Session closed|Page closed|has been disconnected/i.test(msg);
}

export function intIn(v: unknown, lo: number, hi: number): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

/**
 * F76：best-effort 的有界等待（与 ctx.ts 的同名 helper 同语义）：超时/失败都不致命——
 * 切页事实已经发生，置前/等载失败只是"没等到"，不是错误。
 */
export async function bounded(fn: () => Promise<unknown> | undefined, ms: number): Promise<void> {
  try { await Promise.race([Promise.resolve().then(fn), sleepMs(ms)]); } catch { /* best effort */ }
}

/**
 * F76：任意标签页的标题读取有界（2s）：一个卡死的标签页不能拖住 tab list/switch 的响应
 * （与 ctx.ts 的 tabs titleOf 同口径；catch 在 race 之前挂上，race 输了也不产生未处理拒绝）。
 */
export async function tabTitleOf(p: AnyPage): Promise<string> {
  try {
    const title = Promise.resolve()
      .then(() => p.title())
      .then((t) => String(t ?? ""))
      .catch(() => "");
    return await Promise.race([title, sleepMs(2000).then(() => "")]);
  } catch {
    return "";
  }
}

