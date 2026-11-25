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
import type { RangeValue } from "../engine/range.ts";
import type { LaunchWindowMode } from "../browser/browser-env.ts";
import { signalProblemText, validateSignalSpec } from "../engine/signals.ts";

/** `act` 的 MVP 能力面（执行器里 drag/upload/clickAt 也有，但 authoring MVP 不暴露）。 */
export const SESSION_ACT_OPS = ["click", "check", "fill", "select", "hover", "scroll", "set_range"] as const;
export type SessionActOp = (typeof SESSION_ACT_OPS)[number];

/** `act set_range` 的目标值形状：`ctx.setRange` 与执行器共用 `engine/range.ts` 的闭集，type-only 引用。 */
export type SessionSetRangeValue = RangeValue;

/**
 * `act set_range` 的 value 形状校验（返回 null = 合法；否则给人读的 config_error 文案）。
 *
 * 只判**声明面**形状：恰好一个键、数值有限、percent 在 [0,100]。数值是否落在页面滑杆的
 * [min,max] 内是页面事实，由 range.ts 结构化拒绝（`value_out_of_range`，零动作）——这里
 * 不猜值域、不钳制（与 ctx.setRange 的 validateSetRangeRequest 同一口径）。
 */
export function sessionSetRangeProblem(value: unknown): string | null {
  if (value === undefined || value === null) {
    return "act op 'set_range' needs a value: { value: <number> } or { percent: <0..100> }";
  }
  if (!isObj(value)) {
    return `act set_range value must be an object: { value: <number> } or { percent: <0..100> } (got ${JSON.stringify(value)})`;
  }
  const hasValue = value["value"] !== undefined;
  const hasPercent = value["percent"] !== undefined;
  if (hasValue === hasPercent) {
    return "act set_range value must have EXACTLY one of {value} | {percent} (got both or neither)";
  }
  if (hasValue) {
    const v = value["value"];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return `act set_range value.value must be a finite number (got ${JSON.stringify(v)})`;
    }
    return null;
  }
  const p = value["percent"];
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 100) {
    return `act set_range value.percent must be a number in [0, 100] (got ${JSON.stringify(p)})`;
  }
  return null;
}

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
  /** A6：非标准滚动器回退策略（`"programmatic"`）；标准滚动路径不出现。 */
  strategy?: "programmatic";
  /** B15：`moved:false` 且容器已在底部（几何可读时出现）。 */
  at_bottom?: true;
}

/**
 * 请求类型闭集（未知 type = 结构化 config_error + 这张表）。
 *
 * `drive*` 是「会话内托管 pilot 驾驶」的协议面：`drive` 起/继续驾驶，`driveCommand`
 * 递兜底指令（resume/redirect/finish/abort 闭集），`driveStatus` 只读状态，`driveClose`
 * 终结驾驶（**不关宿主浏览器**——会话仍是会话）。驾驶语义本身在 `SessionPilotDriver`。
 */
export const SESSION_REQUEST_TYPES = [
  "open", "goto", "observe", "act", "read", "extract", "waitFor", "signal", "snapshot", "mark", "tab",
  "drive", "driveCommand", "driveStatus", "driveClose", "close",
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
/**
 * 会话当前页**已经关掉**时的判别（`null` = 还活着）。
 *
 * 为什么要前置判：页面被关闭后 `observe` / `snapshot` / `read` 这些面在底层会**静默拿到空**——
 * `observe` 返回 `ok:true` + `counts` 全 0、`snapshot` 写出全空的文件、`read` 返回 `value:null`，
 * 调用方无法区分「页面真的没内容」与「页面/上下文已经没了」。只有 `goto`/`act` 才会抛
 * `Target page... closed`。死页信号被吞成空结果是诚实性缺口，所以在这里统一收口成
 * `browser_dead`（与运行期死亡的既有码一致，不新增码）。
 *
 * `isClosed()` 不可用或抛错的页面按关闭处理（绝不对关掉的页做读数）。
 */
export function pageClosedReason(session: { page?: unknown } | null): string | null {
  if (session === null || session === undefined) return null;
  const page = session.page as { isClosed?: () => boolean } | undefined;
  if (page === undefined || page === null) return null;
  try {
    return page.isClosed?.() === true ? "the session page has been closed (no tab left to read)" : null;
  } catch {
    return "the session page is no longer reachable (isClosed() threw)";
  }
}

/**
 * 死页前置守卫：会话当前页已关闭时，除 `close` 外的请求一律按既有 `browser_dead` 收口。
 *
 * 抛出的消息**刻意**包含 `Target page, context or browser has been closed`——它是
 * `isDeadPageError` 的判据串，于是 `handleLine` 的既有分支会同时发出 `browser_dead` 响应与
 * `session_end`（与运行期死亡的收口路径完全一致，不新增码、不新增分支）。
 */
export function assertPageAlive(session: { page?: unknown } | null, reqType: unknown): void {
  if (reqType === "close") return;
  const reason = pageClosedReason(session);
  if (reason !== null) throw new Error(`Target page, context or browser has been closed — ${reason}`);
}

export function isDeadPageError(msg: string): boolean {
  return /Target page, context or browser has been closed|Target closed|browser has been closed|Browser has been closed|Session closed|Page closed|has been disconnected/i.test(msg);
}

/**
 * 浏览器**启动期**失败的归类（`ensureSession()` 抛错时用；运行期死亡归 `browser_dead`）。
 *
 * 为什么必须与"运行期死亡"分开：Playwright 的 headed 启动在无 XServer 时抛的正是
 * `browserType.launch: Target page, context or browser has been closed`（**首行**就是这个
 * 串，XServer 提示在后面几行）——它命中 `isDeadPageError` 的正则，于是"缺显示器"这条
 * **配置错误**被报成"浏览器死了"并终结会话（本可改 headless 继续）。判据只认启动期错误串
 * 与 headful 旗标里的环境事实，不含站点或调用面知识。返回 null = 不是启动期环境问题。
 *
 * `raw` 必须是**完整**错误文本（不是 `errMsg` 的首行截断）——XServer 提示不在首行。
 */
export function browserStartupProblem(
  raw: string, headful: boolean,
): { code: "config_error"; reason: string; suggestion: string } | null {
  const xserver = /XServer|Missing X server|\$DISPLAY/i.test(raw);
  const launch = /browserType\.launch|Failed to launch|Chromium distribution|Executable doesn't exist/i.test(raw);
  if (!xserver && !launch) return null;
  const headlessAdvice = headful
    ? "retry without --headful (headless) or run under `xvfb-run -a`"
    : "reinstall the pinned build (`npx playwright install chromium`) and retry; if it still fails, run under `xvfb-run -a`";
  return {
    code: "config_error",
    reason: `browser start-up failed (the browser process never became usable): ${errMsg(raw)}`,
    suggestion: xserver
      ? `the environment has no usable XServer/DISPLAY for a headed browser — ${headlessAdvice}; the session is still alive`
      : `the browser could not start (missing executable or system dependency?) — ${headlessAdvice}; the session is still alive`,
  };
}

export function intIn(v: unknown, lo: number, hi: number): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

/**
 * A5：导航**落地后路径形状**是否被站点改写（纯 URL 形状比较，零站点知识）。
 *
 * 为什么需要：`goto` 的 `ok:true` 只代表"导航命令已发出并 load 完成"，不代表"停在目标"。
 * 站点重定向/规范化可以把实体段清空（`/place/<实体>/data=…` 落地成 `/place//@…`），
 * 页面随即渲染空态，而调用方只看 `ok` 会以为到了。判定"是不是同一实体"需要站点知识
 * （不可做），能做的是**形状**事实：请求的非空路径段是否被落地 URL 按序保留。
 *
 * 只认两种形状信号（不做实体识别，也不把正常重定向判成失败）：
 *   ① 请求里某位非空、落地同位置变空（`/place/X` → `/place//`）；
 *   ② 请求的非空段数多于落地（丢段）。
 * query/fragment/trailing-slash 的追加与 SPA 重写不在判据里（`sameNavTarget` 式的严格比较
 * 会把 `?entry=ttu` 这类正常追加误判）。URL 不可解析 = 不判（null）。
 */
export function landedPathShapeChanged(requested: string, landed: string): { changed: boolean; why: string } | null {
  /** URL 的路径段。绝对 URL 取 `pathname`；解析不了的串按"裸路径"处理（去掉 query/fragment），
   *  仍解析不出 = null（不判）。落地 URL 来自活页面，通常是绝对的；请求侧允许写相对路径。 */
  const segs = (u: string): string[] | null => {
    const raw = u.trim();
    if (raw === "") return null;
    try { return new URL(raw).pathname.split("/"); } catch { /* 相对路径/裸串：按字面路径处理 */ }
    const bare = raw.replace(/[?#].*$/, "");
    if (!bare.startsWith("/")) return null;
    return bare.split("/");
  };
  const req = segs(requested), got = segs(landed);
  if (req === null || got === null) return null;
  for (let i = 1; i < Math.min(req.length, got.length); i += 1) {
    if (req[i] !== "" && got[i] === "") {
      return { changed: true, why: `the landing path has an empty segment where the requested one had ${JSON.stringify(req[i])} (segment ${i})` };
    }
  }
  const reqN = req.filter((x) => x !== "").length;
  const gotN = got.filter((x) => x !== "").length;
  if (reqN > gotN) return { changed: true, why: `the landing path dropped segments: requested ${reqN} non-empty segment(s), landed ${gotN}` };
  return { changed: false, why: "" };
}

/**
 * A5：`open`/`goto` 响应上的落地形状事实（additive；形状未变 = 零新键、零 reason）。
 *
 * 只陈述事实、不改 `ok` 语义——合法重定向不能被判成失败；但风险要可见：站点重定向可能已经
 * 换掉了目标实体，落地后应读回 URL/title 复核。
 */
export function landedNavigationFacts(requested: string, landed: string): { facts: Record<string, unknown>; reason: string } {
  const shape = landedPathShapeChanged(requested, landed);
  if (shape === null || !shape.changed) return { facts: {}, reason: "" };
  return {
    facts: { requested_url: requested, landed_url: landed, landed_path_shape_changed: true },
    reason: `landed path shape changed from the request (${shape.why}) — the site may have redirected/normalised the target entity away; read back url/title before acting on the landed page`,
  };
}

/**
 * F76：best-effort 的有界等待（与 ctx.ts 的同名 helper 同语义）：超时/失败都不致命——
 * 切页事实已经发生，置前/等载失败只是"没等到"，不是错误。
 */
export async function bounded(fn: () => Promise<unknown> | undefined, ms: number): Promise<void> {
  try { await Promise.race([Promise.resolve().then(fn), sleepMs(ms)]); } catch { /* best effort */ }
}

/**
 * 任意标签页的标题读取有界（2s）：一个卡死的标签页不能拖住 tab list/switch 的响应
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

/* ---------------------------------------------- 会话内托管驾驶（drive 协议） */

/** `drive.driver` 闭集（与 pilot 驾驶者同源；agent = 每步等兜底指令点名，零模型票）。 */
export const SESSION_DRIVE_DRIVERS = ["model", "agent"] as const;
export type SessionDriveDriver = (typeof SESSION_DRIVE_DRIVERS)[number];
/** `driveCommand.cmd` 闭集（与 pilot 兜底指令同源，不在这里发明第二套指令）。 */
export const SESSION_DRIVE_COMMANDS = ["resume", "redirect", "finish", "abort"] as const;
export type SessionDriveCommand = (typeof SESSION_DRIVE_COMMANDS)[number];
/** 驾驶步预算边界（与 pilot --max-steps 同口径）。 */
export const SESSION_DRIVE_MAX_STEPS = { min: 1, max: 200 } as const;
/**
 * `driveCommand.note` 上界（桥描述口径 "short note"）：有界是为了调用方别把 pilot 轨迹写爆；
 * 非空/上界都在形状校验里拒绝，pilot 侧不再二次截断（唯一出处 = `driveCommandProblem`）。
 */
export const SESSION_DRIVE_NOTE_MAX_CHARS = 300;

/**
 * `drive` 请求的形状校验（返回 null = 合法；否则为给人读的 config_error 文案）。
 *
 * 只校验**协议形状**：值不猜、不补缺省；合法性口径与 pilot 面一致——`final_signal` 走
 * 同一个 `validateSignalSpec`（signal/waitFor 的加载期校验器），不合法即 config_error。
 */
export function driveStartProblem(req: Record<string, unknown>): string | null {
  if (!nonEmpty(req["goal"])) return "drive needs a non-empty goal string";
  const maxSteps = req["max_steps"];
  if (maxSteps !== undefined) {
    const { min, max } = SESSION_DRIVE_MAX_STEPS;
    if (typeof maxSteps !== "number" || !Number.isInteger(maxSteps) || maxSteps < min || maxSteps > max) {
      return `drive.max_steps must be an integer in [${min}, ${max}] (got ${JSON.stringify(maxSteps)})`;
    }
  }
  const driver = req["driver"];
  if (driver !== undefined && !(SESSION_DRIVE_DRIVERS as readonly unknown[]).includes(driver)) {
    return `drive.driver must be one of ${SESSION_DRIVE_DRIVERS.join(" | ")} (got ${JSON.stringify(driver)})`;
  }
  const floor = req["conf_floor"];
  if (floor !== undefined && (typeof floor !== "number" || !Number.isFinite(floor) || floor < 0 || floor > 1)) {
    return `drive.conf_floor must be a number in [0, 1] (got ${JSON.stringify(floor)})`;
  }
  const expectUrl = req["expect_url"];
  if (expectUrl !== undefined && !nonEmpty(expectUrl)) {
    return "drive.expect_url must be a non-empty string when present";
  }
  const signal = req["final_signal"];
  if (signal !== undefined && signal !== null) {
    if (!isObj(signal)) return "drive.final_signal must be a JSON object when present";
    const problems = validateSignalSpec(signal, "drive.final_signal");
    if (problems.length > 0) return signalProblemText(problems, "json");
  }
  const slots = req["slots"];
  if (slots !== undefined && slots !== null) {
    if (!isObj(slots)) return "drive.slots must be a JSON object of slot name → string value";
    for (const [k, v] of Object.entries(slots)) {
      if (typeof v !== "string") return `drive.slots.${k} must be a string value`;
    }
  }
  return null;
}

/** `driveCommand` 请求的形状校验（cmd 闭集 + 各指令参数的类型；语义仍归 pilot 兜底分派）。 */
export function driveCommandProblem(req: Record<string, unknown>): string | null {
  const cmd = req["cmd"];
  if (typeof cmd !== "string" || !(SESSION_DRIVE_COMMANDS as readonly string[]).includes(cmd)) {
    return `driveCommand.cmd must be one of ${SESSION_DRIVE_COMMANDS.join(" | ")} (got ${JSON.stringify(cmd)})`;
  }
  if (req["hint"] !== undefined && !nonEmpty(req["hint"])) {
    return "driveCommand.hint must be a non-empty string when present";
  }
  // resume 字符串值的显式值袋键（对象键/字符串+target 两条文档化路径必须真可达；桥与
  // session-driver 都透传它，这里只做形状校验，语义归 pilot 兜底分派）。
  if (req["target"] !== undefined && !nonEmpty(req["target"])) {
    return "driveCommand.target must be a non-empty string when present";
  }
  if (req["url"] !== undefined && !nonEmpty(req["url"])) {
    return "driveCommand.url must be a non-empty string when present";
  }
  if (req["goal"] !== undefined && !nonEmpty(req["goal"])) {
    return "driveCommand.goal must be a non-empty string when present";
  }
  const value = req["value"];
  if (value !== undefined && !(typeof value === "string" || isObj(value))) {
    return "driveCommand.value must be a string or a JSON object of slot name → scalar";
  }
  // `note` 是调用方备注（桥 schema/描述承诺「recorded」）：放行前必须在入口验有界非空，
  // 否则超长备注会原样写进 pilot 轨迹；它只进 pilot 自身 trace/record，不进响应。
  const note = req["note"];
  if (note !== undefined) {
    if (!nonEmpty(note)) return "driveCommand.note must be a non-empty string when present";
    if (note.length > SESSION_DRIVE_NOTE_MAX_CHARS) {
      return `driveCommand.note must be at most ${SESSION_DRIVE_NOTE_MAX_CHARS} characters (got ${note.length})`;
    }
  }
  return null;
}

/**
 * `driveCommand` 请求 → pilot 兜底指令 JSONL 行（**唯一出处**；session-driver 不再手写白名单）。
 *
 * 白名单只放协议字段：新增可透传字段必须在这里显式加入，否则会被静默丢弃。
 * `note` 随该行进 pilot 自身 trace/record，不进会话/桥响应投影。
 */
export function driveCommandLine(req: Record<string, unknown>): string {
  return JSON.stringify({
    cmd: String(req["cmd"]),
    ...(nonEmpty(req["hint"]) ? { hint: String(req["hint"]) } : {}),
    ...(nonEmpty(req["target"]) ? { target: String(req["target"]) } : {}),
    ...(req["value"] === undefined ? {} : { value: req["value"] }),
    ...(nonEmpty(req["goal"]) ? { goal: String(req["goal"]) } : {}),
    ...(nonEmpty(req["url"]) ? { url: String(req["url"]) } : {}),
    ...(req["skip"] === true ? { skip: true } : {}),
    ...(nonEmpty(req["note"]) ? { note: String(req["note"]) } : {}),
  });
}

