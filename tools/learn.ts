/**
 * **三类入口，一个引擎。** 这个文件是无参 `learn`（人）与一次调用（外层 Agent）背后的同一件事：
 * 让流程从"写出来"变成**跑出来**。
 *
 *   人：      npm run learn                       # 连上你正开着的浏览器；你做一遍，或我按 goal 跑一遍
 *   批量：    npm run apps:gen -- --spec/--source # 上游数据/代码 → 包（已有，另一扇门）
 *   Agent：   npm run agent -- --goal "…" --url <页面> --json   # 一次调用，返回结构化结果 + 验收候选
 *
 * 设计原则（都来自使用者反馈，不是我的偏好）：
 *   1. **零必填参数**：URL 从当前标签页取、目标默认用页面标题、id 从域名+标题生成、输出默认临时目录；
 *   2. **能推导的不问**：完成信号由"动作前 / 动作后"两个状态**归纳**出来（`induceSignals`），
 *      而不是让人写 `--verify 'url_contains=…'`；不变量由结束态归纳（`apps:induce` 的口径）；
 *   3. **不能推导的只让人确认**：每一步给一行"做了什么 → 归纳出的信号"，回一个 y/n，不用学信号语法；
 *   4. **落盘门槛是"零前向回放"**：写文件前用规则模式重跑一遍，要求**0 次模型调用**且通过——
 *      这样"方便"不会换来"不可复现"；回放不过 → 不写文件 + 报 exit 1。
 *
 * 边界（诚实写在这里）：`when`/`retries` 目前**不录制**（跳过与重试是运行时策略，不是演示出来的东西）；
 * 只录"点一下"和"填一个值"两类动作（其余形状要等动作模型扩展）。
 */
import crypto from "node:crypto";
import { isParseUsageError, usageErrorLine } from "../src/support/cli-args.ts";
import { applyRcToEnv } from "../src/support/rcfile.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadPack, validatePack, type AppPack } from "../src/app/app-pack.ts";
import { ensureDir, userAppsDir } from "../src/app/amberflow-home.ts";
import { runApp, startUrl } from "../src/app/app-runner.ts";
import { browserSession } from "../src/engine/executor.ts";
import { extractElements } from "../src/engine/extraction.ts";
import { hintMatch } from "../src/engine/rules.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime } from "../src/model/model.ts";
import { captureStateView, induceSignals } from "../src/flow/signal-induction.ts";
import { evalSignalOnState, type SignalSpec, type StateView } from "../src/engine/signals.ts";
import { serializePack } from "./spec-to-pack.ts";

export const REPO = path.resolve(import.meta.dirname, "..");

/* ------------------------------------------------------------------ 录制 */

export interface RecordedAction {
  op: "click" | "type";
  /** 稳定句柄：`[data-test=x]` / `#id` / `[name=x]`（波动量一律不录）。 */
  hint: string;
  /** `type` 的值；敏感字段只记形状，不记明文。 */
  value?: string;
  label?: string;
  secret?: boolean;
}

/** 页面里注入的录制器：点一下、填一个值，都按**稳定句柄**记下来，录不到就明说。 */
export const RECORDER_JS = `(() => {
  if (window.__learnInstalled) return; window.__learnInstalled = true;
  window.__learn = [];
  const stable = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const dt = el.getAttribute && el.getAttribute("data-test");
    if (dt) return "[data-test=" + dt + "]";
    if (el.id) return "#" + el.id;
    const nm = el.getAttribute && el.getAttribute("name");
    if (nm) return el.tagName.toLowerCase() + "[name=" + nm + "]";
    return null;
  };
  const label = (el) => (el && (el.getAttribute("aria-label") || el.innerText || el.value || el.tagName) || "").toString().trim().slice(0, 80);
  document.addEventListener("click", (e) => {
    const el = e.target.closest && e.target.closest("a,button,input,select,textarea,[data-test],[role=button]");
    const h = stable(el);
    window.__learn.push(h
      ? { op: "click", hint: h, label: label(el) }
      : { op: "skip", why: "点击的元素没有稳定句柄（data-test / id / name）", label: label(el) });
  }, true);
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!el || !("value" in el)) return;
    const h = stable(el);
    const type = (el.getAttribute && el.getAttribute("type")) || "";
    const secret = type === "password" || type === "file";
    if (!h) { window.__learn.push({ op: "skip", why: "输入框没有稳定句柄", label: label(el) }); return; }
    window.__learn.push({ op: "type", hint: h, value: secret ? "" : String(el.value), label: label(el), secret });
  }, true);
})()`;

interface PageLike {
  addInitScript(s: string): Promise<void>;
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  goto(u: string, o?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/** Playwright 的 `page.url` 在不同类型定义里既可能是方法也可能是属性——两种都认。 */
export function pageUrl(page: unknown): string {
  const u = (page as { url?: unknown }).url;
  return typeof u === "function" ? String((u as () => string).call(page)) : String(u ?? "");
}

export async function startRecorder(page: unknown): Promise<void> {
  const p = page as unknown as PageLike;
  await p.addInitScript(RECORDER_JS);          // 跨导航仍然有效
  await p.evaluate(RECORDER_JS);
}

export async function readRecorded(page: unknown): Promise<Array<Record<string, unknown>>> {
  return (await (page as unknown as PageLike).evaluate("window.__learn || []")) as Array<Record<string, unknown>>;
}

/** 录下来的一串动作里，可执行的部分（`skip` 单独报出来，不静默丢）。 */
export function executableActions(bag: Array<Record<string, unknown>>): {
  actions: RecordedAction[]; skipped: string[];
} {
  const actions: RecordedAction[] = [];
  const skipped: string[] = [];
  for (const a of bag) {
    if (a["op"] === "skip") { skipped.push(String(a["why"] ?? "unrecordable")); continue; }
    const hint = String(a["hint"] ?? "");
    if (!hint) { skipped.push("空句柄"); continue; }
    actions.push({
      op: a["op"] === "type" ? "type" : "click", hint,
      ...(a["value"] === undefined ? {} : { value: String(a["value"]) }),
      ...(a["label"] === undefined ? {} : { label: String(a["label"]) }),
      ...(a["secret"] === true ? { secret: true } : {}),
    });
  }
  return { actions, skipped };
}

/* ------------------------------------------------------------------ 学习 */

export interface LearnedStep {
  desc: string;
  start_url: string;
  target_hint: string;
  signal: SignalSpec;
  effect: string[];
  /** 归纳出的前 3 个候选（给"确认"界面用；`signal` 就是第一个）。 */
  alternatives: SignalSpec[];
}

export interface Learning {
  url: string;
  goal: string;
  steps: LearnedStep[];
  /** 结束态不变量候选（区分性 + 稳定句柄；措辞仍要人过一眼）。 */
  invariants: Array<{ id: string; desc: string; signal: SignalSpec }>;
  effect: string[];
}

/** 仓库相对路径（执行器与包里都用这个口径）。
 * Windows 有两处会把纯字符串口径咬掉：① file URL 的路径是 "/E:/…"，盘符前多一个斜杠，
 * 不归一掉就永远匹配不上前缀、把机器绝对路径录进包（回放器 path.resolve 出 E:\E:\…，
 * 每一步都打不开页面）；② REPO 自己是反斜杠的。查询串照旧原样保留（冻结语料的口径）。 */
export function relUrl(u: string): string {
  const m = /^file:\/\/(.*)$/.exec(u);
  if (!m) return u;
  let p = m[1]!;
  if (/^\/[A-Za-z]:(\/|\\)/.test(p)) p = p.slice(1);
  const repo = REPO.split(path.sep).join("/");
  return p.startsWith(repo + "/") ? p.slice(repo.length + 1) : p;
}

export interface LearnIO {
  /** 问一句（非交互时返回默认值）。 */
  askYesNo(question: string, dflt: boolean): Promise<boolean>;
  out(line: string): void;
}

/**
 * **核心**：把一串动作跑一遍并逐步归纳信号。
 * `page` 已经停在起点；每个动作前/后各抓一份状态视图，`induceSignals` 从中挑完成信号。
 */
export async function learnFromActions(
  page: unknown,
  actions: RecordedAction[],
  io: LearnIO,
): Promise<Learning> {
  const pg = page as unknown as PageLike & {
    click(sel: string, o?: unknown): Promise<void>;
    fill(sel: string, value: string, o?: unknown): Promise<void>;
    waitForTimeout(ms: number): Promise<void>;
  };
  const startUrl0 = pageUrl(pg);
  const startState = await captureStateView(pg as never);
  const steps: LearnedStep[] = [];

  for (const [i, action] of actions.entries()) {
    const before = await captureStateView(pg as never);
    const beforeUrl = pageUrl(pg);
    try {
      if (action.op === "click") await pg.click(action.hint, { timeout: 10_000 });
      else await pg.fill(action.hint, action.value ?? "", { timeout: 10_000 });
    } catch (e) {
      throw new Error(`第 ${i + 1} 步（${action.op} ${action.hint}）执行失败：${e instanceof Error ? e.message : String(e)}`);
    }
    await pg.waitForTimeout(300);                      // 让页面把反应做完（菜单/局部刷新）
    const after = await captureStateView(pg as never);
    const ind = induceSignals(before, after, { max: 3 });
    // 稳定句柄（data-test/id/name，stability ≥ 2）**或** URL 变化（`url_contains` 是我们五个算子里
    // 的一个；它的 stability 记 0 只表示"仅凭 URL"，不是"不可靠"）。
    const good = ind.candidates.filter((c) => c.stability >= 2 || c.kind === "url")
      .filter((c) => evalSignalOnState(c.signal, before) === false && evalSignalOnState(c.signal, after) === true);
    if (!good.length) {
      throw new Error(`第 ${i + 1} 步（${action.op} ${action.hint}）没有可判定的完成信号：`
        + `页面在这个动作前后没有稳定变化（${ind.effect.join("；") || "无变化"}）。`
        + "这一步要么什么都不做，要么变化只体现在波动量上——都不该写进流程。");
    }
    const desc = action.op === "click"
      ? `点击${action.label ? `「${action.label}」` : ""}`
      : `在${action.label ? `「${action.label}」` : "输入框"}填入一个值`;
    const step: LearnedStep = {
      desc, start_url: relUrl(beforeUrl), target_hint: action.hint,
      signal: good[0]!.signal as SignalSpec,
      alternatives: good.map((c) => c.signal as SignalSpec),
      effect: ind.effect,
    };
    steps.push(step);
    io.out(`  ${i + 1}. ${desc} → ${JSON.stringify(step.signal)}`);
    io.out(`     （${ind.effect.join("；") || "无变化"}）`);
  }

  // 结束态不变量：与"还没动手时"比，且必须落在稳定句柄上
  const end = await captureStateView(pg as never);
  const ind = induceSignals(startState, end, { max: 8 });
  const kept = ind.candidates
    .filter((c) => c.stability >= 2 || c.kind === "url")
    .filter((c) => evalSignalOnState(c.signal, startState) === false && evalSignalOnState(c.signal, end) === true);
  // 去重：① URL 候选只留**最短**的（`/cart.html`、`/testpages/cart.html`、`/AmberFlow/testpages/cart.html`
  // 说的是同一件事，短的那个还是判别力最强的）；② 同一选择器的只剩一条。
  const urls = kept.filter((c) => c.kind === "url")
    .map((c) => String((c.signal as { url_contains?: string }).url_contains ?? ""))
    .filter(Boolean).sort((a, b) => a.length - b.length);
  const shortestUrl = urls[0];
  const seen = new Set<string>();
  const invariants = kept
    .filter((c) => {
      if (c.kind === "url") return String((c.signal as { url_contains?: string }).url_contains ?? "") === shortestUrl;
      const sel = JSON.stringify(c.signal);
      if (seen.has(sel)) return false;
      seen.add(sel);
      return true;
    })
    .slice(0, 3)
    .map((c) => {
      const key = JSON.stringify(c.signal).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).toLowerCase();
      return { id: `learned-${key}`, desc: `（录制：跑完这条流程后必须成立）${c.why}`, signal: c.signal as SignalSpec };
    });

  return { url: relUrl(startUrl0), goal: "", steps, invariants, effect: ind.effect };
}

/* ------------------------------------------------------------ 写成应用包 */

/**
 * 应用 id：**ASCII 安全**、稳定、不依赖时钟。
 *
 * `file://` 页面没有 hostname，中文目标也不适合当目录名——所以：主机名（或页面文件名）打头，
 * 目标只保留 ASCII 部分；如果目标一个 ASCII 字符都没有（纯中文），缀上目标的短哈希，
 * 这样两个不同的中文目标不会撞到同一个 id。
 */
export function slugOf(url: string, goal: string): string {
  let host = "";
  try {
    const u = new URL(url.includes("://") ? url : startUrl(url));
    host = u.hostname || path.basename(u.pathname).replace(/\.[a-z0-9]+$/i, "");
  } catch { host = ""; }
  const ascii = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const head = ascii(host) || "learned-flow";
  const tail = ascii(goal);
  if (tail) return `${head}-${tail}`.slice(0, 48);
  const short = crypto.createHash("sha256").update(goal || url).digest("hex").slice(0, 6);
  return `${head}-${short}`;
}

export function learningSha(l: Learning): string {
  const semantic = {
    url: l.url,
    steps: l.steps.map((s) => ({
      desc: s.desc, start_url: s.start_url, target_hint: s.target_hint, signal: s.signal,
    })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
}

/** 学习结果 → 应用包（`journey` 是录下来的，`invariants` 是归纳出来的候选）。 */
export function packFromLearning(l: Learning, id: string): AppPack {
  const hosts = [...new Set(l.steps.map((s) => {
    try { return new URL(startUrl(s.start_url)).hostname; } catch { return ""; }
  }).filter((h) => h && h !== ""))];
  return {
    spec_version: 1,
    id,
    label: `录制的流程（${l.steps.length} 步，来自 ${l.url}）`,
    goal: l.goal || `在 ${l.url} 上完成演示的那条流程`,
    model: "english",
    max_subgoals: Math.max(4, l.steps.length + 2),
    hosts,
    slots: {},
    required_slots: [],
    sources: [],
    journey: l.steps.map((s) => ({
      desc: s.desc, start_url: s.start_url, target_hint: s.target_hint, signal: s.signal,
    })),
    invariants: l.invariants,
    notes: [
      "本文件由 `npm run learn` 从**一次真实演示**录制：`journey` 是录下来的，`invariants` 是结束态归纳出来的候选。",
      "`when` / `retries` 不录制（它们是运行时策略，不是演示出来的东西）；要加就手写这两项。",
      "回放不成立时会报 `recorded-flow drift`——那时重新演示一次，而不是改信号让它变绿。",
      ...l.steps.flatMap((s, i) => s.effect.length ? [`第 ${i + 1} 步观察到的变化：${s.effect.join("；")}`] : []),
    ],
    recorded_from: { url: l.url, steps: l.steps.length, sha256: learningSha(l) },
  } as unknown as AppPack;
}

/* ------------------------------------------- 不变量：从**回放形状的运行**里归纳

  为什么不能从"人演示的那一次"里归纳：演示是**一个连续会话**（页面上会累积状态），而回放是
  **每个子目标重新导航**（执行器的既定语义，为的是"一步 = 一个确定性状态"）。两者结束态可以不同——
  实测过一次：演示里购物车角标走到 2，回放只走到 1，于是"角标=2"这条不变量在回放里不成立。
  结论：**演示只用来学动作；验收必须从将要被重复的那次运行里归纳**。 */

/** 只打开一个 URL、不做动作，抓一份状态（回放意义的"动手前"）。 */
async function captureFirstStep(pack: AppPack): Promise<StateView> {
  const first = (pack.journey ?? []).find((s) => (s as { source?: unknown }).source === undefined) as
    { start_url?: string } | undefined;
  const raw = first?.start_url;
  if (!raw) throw new Error("包里的旅程没有浏览器步，无法归纳结束态不变量");
  const session = await browserSession(true, (pack.device ?? null) as never);
  try {
    await (session.page as unknown as { goto(u: string, o?: unknown): Promise<unknown> })
      .goto(startUrl(raw), { waitUntil: "domcontentloaded", timeout: 30_000 });
    return await captureStateView(session.page as never);
  } finally {
    await session.close();
  }
}

/** 归纳结束态不变量：起点 = 只打开第一步，终点 = **回放形状运行**留下的状态。 */
export async function induceInvariantsFromRunner(
  pack: AppPack, outDir: string,
): Promise<{ invariants: Array<{ id: string; desc: string; signal: SignalSpec }>; run: ReplayResult }> {
  const asked: string[] = [];
  installLayaRuntime(scriptedRuntime(scriptedAgent((key) => { asked.push(key); return { noul: 0.05 }; })));
  let end: StateView | undefined;
  let ok = false, completed = "", held = "0/0";
  try {
    const res = await runApp(pack, {
      verbose: false, sources: false, outDir, captureState: true,
      planPath: path.join(outDir, `${pack.id}-plan.json`),
    });
    ok = res.ok; completed = res.completed; end = res.end_state;
    held = `${res.invariants.filter((i) => i.held).length}/${res.invariants.length}`;
  } finally {
    installLayaRuntime(null);
  }
  if (!end) throw new Error("回放形状的运行没有抓到结束状态（它可能没跑到浏览器步）");
  const start = await captureFirstStep(pack);
  const ind = induceSignals(start, end, { max: 8 });
  const kept = ind.candidates
    .filter((c) => c.stability >= 2 || c.kind === "url")
    .filter((c) => evalSignalOnState(c.signal, start) === false && evalSignalOnState(c.signal, end) === true);
  const urls = kept.filter((c) => c.kind === "url")
    .map((c) => String((c.signal as { url_contains?: string }).url_contains ?? "")).filter(Boolean)
    .sort((a, b) => a.length - b.length);
  const shortestUrl = urls[0];
  const seen = new Set<string>();
  const invariants = kept.filter((c) => {
    if (c.kind === "url") return String((c.signal as { url_contains?: string }).url_contains ?? "") === shortestUrl;
    const sig = JSON.stringify(c.signal);
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  }).slice(0, 3).map((c) => {
    const key = JSON.stringify(c.signal).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).toLowerCase();
    return { id: `learned-${key}`, desc: `（录制：跑完这条流程后必须成立）${c.why}`, signal: c.signal as SignalSpec };
  });
  return {
    invariants,
    run: { ok, forwards: asked.filter((k) => k === "act").length, asked, completed, invariants: held, failing: [] },
  };
}

/* ------------------------------------------------------- 零前向回放（落盘门槛） */

export interface ReplayResult {
  ok: boolean; forwards: number; asked: string[]; completed: string; invariants: string;
  /** 具体哪几条不变量在这一次运行里不成立（写回/剔除要精确到 id）。 */
  failing: string[];
}

/** 用规则模式重跑一遍：**0 次模型调用**且通过，才算这份录制的流程可复现。 */
export async function replayCheck(pack: AppPack, outDir: string): Promise<ReplayResult> {
  const asked: string[] = [];
  installLayaRuntime(scriptedRuntime(scriptedAgent((key) => { asked.push(key); return { noul: 0.05 }; })));
  try {
    const res = await runApp(pack, {
      verbose: false, sources: false, outDir, planPath: path.join(outDir, `${pack.id}-plan.json`),
    });
    return {
      ok: res.ok, forwards: asked.filter((k) => k === "act").length, asked,
      completed: res.completed,
      invariants: `${res.invariants.filter((i) => i.held).length}/${res.invariants.length}`,
      failing: res.invariants.filter((i) => !i.held).map((i) => String(i.id)),
    };
  } finally {
    installLayaRuntime(null);
  }
}

/* ------------------------------------------------------------------ CLI */

const USAGE = `usage: learn [--url <页面>] [--goal "<一句话>"] [--id <应用名>] [--cdp <ws://…>]
             [--script <录好的动作.json>] [--yes] [--json] [--pack-dir DIR] [--out DIR] [--headful]

  不做任何参数也能用：连上你正在用的浏览器，用当前页；目标回车即用页面标题。
  --script   用一串录好的动作代替人现场演示（CI/测试用；格式见 README）
  --yes      不再逐条确认（外层 Agent 用；等价于 npm run agent）
  --json     输出结构化结果（一次调用的形状）
  --pack-dir 包的落点；默认 $AMBERFLOW_HOME/apps（用户作用域，不写进 checkout）
退出码：0=已录制且零前向回放通过 ｜ 1=录了但回放不过（**不落盘**）｜ 2=用法/环境问题`;

/** id 的唯一出处（演示前后来回用，避免两处算法漂移）。 */
function id0(l: Learning, goal: string, explicit?: string): string {
  return explicit ?? slugOf(l.url, goal);
}

async function connectPage(opts: {
  cdp?: string; url?: string; headless: boolean;
}): Promise<{ page: unknown; close: () => Promise<void>; attached: boolean; url: string; title: string }> {
  const pw = await import("playwright");
  if (opts.cdp) {
    const browser = await pw.chromium.connectOverCDP(opts.cdp);
    const ctx = browser.contexts()[0] ?? await browser.newContext();
    const page = ctx.pages()[0] ?? await ctx.newPage();
    // 挂载模式**也认 `--url`**：给了就导航到那一页（实测过一次：不给会停在 about:blank，
    // 然后拿着用户给的选择器点不到东西，报出来的是"找不到元素"而不是"你其实在空白页"）。
    if (opts.url) {
      await (page as unknown as { goto(u: string, o?: unknown): Promise<unknown> })
        .goto(startUrl(opts.url), { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    return {
      page, attached: true,
      url: pageUrl(page),
      title: await page.title().catch(() => ""),
      // 挂上去的浏览器**不关**：只断开连接（别人的窗口里有别人的会话）
      close: async () => { await browser.close().catch(() => {}); },
    };
  }
  if (!opts.url) throw new Error("没有可用的页面：给 --url，或用 --cdp 连上你正在用的浏览器");
  const session = await browserSession(opts.headless);
  const page = session.page;
  await (page as unknown as { goto(u: string, o?: unknown): Promise<unknown> })
    .goto(startUrl(opts.url), { waitUntil: "domcontentloaded", timeout: 30_000 });
  return {
    page, attached: false,
    url: pageUrl(page), title: await page.title().catch(() => ""),
    close: () => session.close(),
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // rc 文件坏 = 配置类用法错误：在任何腿出场之前逐行点名并 exit 2（src/support/rcfile.ts）。
  { const rc = applyRcToEnv(); if (rc.errors.length) { for (const e of rc.errors) console.error(e); return 2; } }
  let values;
  // 打错的参数 → 一行点名 + usage，绝不甩 parseArgs 的堆栈（src/support/cli-args.ts 的体例）。
  try {
    ({ values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" }, goal: { type: "string" }, id: { type: "string" },
      cdp: { type: "string" }, script: { type: "string" }, yes: { type: "boolean" },
      json: { type: "boolean" }, "pack-dir": { type: "string" }, out: { type: "string" },
      headful: { type: "boolean" }, quiet: { type: "boolean" }, help: { type: "boolean" },
    },
  }));
  } catch (err) {
    if (!isParseUsageError(err)) throw err;
    console.error(usageErrorLine(err));
    console.error();
    console.error(USAGE);
    return 2;
  }
  if (values.help) { console.log(USAGE); return 0; }

  const interactive = Boolean(process.stdin.isTTY) && !values.yes;
  const say = (l: string): void => { if (!values.json) console.log(l); };
  const io: LearnIO = {
    out: say,
    askYesNo: async (q, dflt) => {
      if (values.yes) return true;
      if (!process.stdin.isTTY) {
        throw new Error(`需要确认但没有终端：${q}（CI/Agent 请加 --yes）`);
      }
      const rl = await import("node:readline/promises");
      const r = rl.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const a = (await r.question(`${q} [${dflt ? "y" : "n"}] `)).trim().toLowerCase();
        return a === "" ? dflt : a.startsWith("y");
      } finally { r.close(); }
    },
  };

  const outDir = path.resolve(values.out ?? fs.mkdtempSync(path.join(os.tmpdir(), "learn-")));
  fs.mkdirSync(outDir, { recursive: true });

  let conn;
  try {
    conn = await connectPage({
      ...(values.cdp ? { cdp: values.cdp } : {}),
      ...(values.url ? { url: values.url } : {}),
      headless: !values.headful,
    });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    console.error(USAGE);
    return 2;
  }

  try {
    say(`页面：${conn.url}${conn.attached ? "（连的是你正在用的浏览器，退出只断开不关闭）" : ""}`);
    const goal = values.goal ?? conn.title ?? "";
    if (!goal && !interactive) {
      console.error("没有目标：给 --goal，或在终端里跑（默认用页面标题）");
      return 2;
    }
    if (interactive && !values.goal) {
      const rl = await import("node:readline/promises");
      const r = rl.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const a = (await r.question(`你要做什么？（直接回车 = 「${conn.title}」）\n> `)).trim();
        if (a) values.goal = a;
      } finally { r.close(); }
    }
    const finalGoal = values.goal ?? conn.title ?? "完成演示的那条流程";

    // 动作来源：录好的脚本（Agent/CI）或人现场演示
    let recorded: RecordedAction[];
    let skipped: string[] = [];
    if (values.script) {
      const bag = JSON.parse(fs.readFileSync(path.resolve(values.script), "utf-8")) as Array<Record<string, unknown>>;
      ({ actions: recorded, skipped } = executableActions(bag));
    } else {
      if (!interactive) {
        console.error("没有动作来源：给 --script <录好的动作.json>，或在终端里现场演示给 learn 看");
        return 2;
      }
      await startRecorder(conn.page);
      say("");
      say("现在请你在页面上按正常方式把这件事做一遍（我只能录「点击」和「填值」两种动作，");
      say("元素没有 data-test / id / name 的话我会拒绝录制并告诉你）。做完回到这里按回车。");
      const rl = await import("node:readline/promises");
      const r = rl.createInterface({ input: process.stdin, output: process.stdout });
      try { await r.question("做完按回车 > "); } finally { r.close(); }
      // 重新回到起点，按录下来的动作"正式"跑一遍并逐步抓状态
      const bag = await readRecorded(conn.page);
      ({ actions: recorded, skipped } = executableActions(bag));
      const back = await connectPage({
        ...(values.cdp ? { cdp: values.cdp } : {}),
        ...(values.url ? { url: values.url } : {}),
        headless: !values.headful,
      });
      await conn.close();
      conn = back;
      await (conn.page as unknown as { goto(u: string, o?: unknown): Promise<unknown> })
        .goto(startUrl(values.url ?? conn.url), { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    for (const s of skipped) say(`（跳过一条录不下来的动作：${s}）`);
    if (!recorded.length) {
      console.error("没有录到任何可执行动作——检查元素是否有 data-test / id / name 稳定句柄");
      return 2;
    }

    say("");
    say(`按 ${recorded.length} 个动作跑一遍（本地决策模型只在需要时兜底）：`);
    let learning: Learning;
    try {
      learning = await learnFromActions(conn.page, recorded, io);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return 1;
    }
    learning.goal = finalGoal;

    // 不变量改从"回放形状的运行"归纳（演示只学动作）——见文件上方那段注释的实测理由
    const provisional = packFromLearning({ ...learning, invariants: [] }, id0(learning, finalGoal, values.id));
    const induced = await induceInvariantsFromRunner(provisional, outDir);
    learning.invariants = induced.invariants;

    // 人只做确认，不写信号语法
    if (learning.invariants.length) {
      say("");
      say("结束状态不变量候选（跑完这条流程后必须成立）：");
      const kept: typeof learning.invariants = [];
      for (const inv of learning.invariants) {
        const ok = await io.askYesNo(`  + ${inv.desc}\n    ${JSON.stringify(inv.signal)} —— 收下？`, true);
        if (ok) kept.push(inv);
      }
      learning.invariants = kept;
    }

    const id = id0(learning, finalGoal, values.id);
    const pack = packFromLearning(learning, id);
    const problems = validatePack(pack);
    if (problems.length) {
      console.error(`生成的包不合法（这是工具的 bug，不是你的输入）：\n  - ${problems.join("\n  - ")}`);
      return 1;
    }

    // **落盘门槛**：规则模式零前向回放必须通过。
    // 若某条不变量在**第二次运行**里不成立，说明它不可复现（第一次是归纳用的那次）——
    // 按"区分性 / 稳定句柄 / 复跑一致"三关，把它剔除并写进 notes，而不是留着或改信号。
    let replay = await replayCheck(pack, outDir);
    const dropped: string[] = [];
    if (replay.failing.length) {
      for (const id of replay.failing) {
        const idx = (pack.invariants ?? []).findIndex((i) => i.id === id);
        if (idx < 0) continue;
        const inv = (pack.invariants as Array<{ id: string; signal: unknown }>)[idx]!;
        dropped.push(`${id} ${JSON.stringify(inv.signal)}`);
        (pack.invariants as unknown[]).splice(idx, 1);
      }
      if (dropped.length) {
        say("");
        say(`复跑里不成立的候选不变量已剔除（不可复现，按三关纪律不该留在包里）：`);
        for (const d of dropped) say(`  - ${d}`);
        (pack.notes as string[]).push(
          `演示/归纳时出现过、但复跑不成立的候选（**故意不写进 invariants**，因为复现不了）：${dropped.join("；")}`);
        replay = await replayCheck(pack, outDir);
      }
    }
    const verified = replay.ok && replay.forwards === 0;
    const result = {
      app: id, url: learning.url, goal: finalGoal, steps: learning.steps.length,
      signals: learning.steps.map((s) => s.signal),
      invariants: learning.invariants.map((i) => ({ id: i.id, signal: i.signal })),
      replay: { ok: replay.ok, forwards: replay.forwards, completed: replay.completed, invariants: replay.invariants },
      verified,
      saved: false as boolean | string,
    };

    if (!verified) {
      console.error(`回放没通过（${replay.completed}，不变量 ${replay.invariants}`
        + `${replay.failing.length ? `，不成立：${replay.failing.join(", ")}` : ""}，`
        + `模型调用 ${replay.forwards} 次）`
        + "：这次录制**没有落盘**——流程要么不稳定，要么某一步的信号不是真正判据。重新演示一次。");
      if (values.json) console.log(JSON.stringify({ ...result, status: "replay-failed" }, null, 2));
      return 1;
    }

    // 落点默认移出 checkout（P0-⑥ / 前提 A）：应用是用户本地产物，录一次不该写进
    // 引擎的安装目录。`--pack-dir` 仍可显式指到任意目录（含仓库 apps/，开发夹具用）。
    const packDir = ensureDir(path.resolve(values["pack-dir"] ?? userAppsDir()));
    const dir = path.join(packDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "pack.json");
    fs.writeFileSync(file, serializePack(pack));
    const rel = path.relative(REPO, file);
    result.saved = rel.startsWith("..") ? file : rel;   // 用户作用域的包显示绝对路径，仓库内的保持相对

    if (values.json) {
      console.log(JSON.stringify({ ...result, status: "ok" }, null, 2));
    } else {
      say("");
      say(`✓ 已写 ${result.saved}`);
      say(`✓ 规则模式回放：**0 次模型调用**，${replay.completed} 完成，不变量 ${replay.invariants}`);
      say(`  跑它：npm run apps -- --app ${id} --no-sources`);
      say("  要加条件/重试就手写 `when`/`retries`（这两项不录制）；页面变了会报 recorded-flow drift，重新演示即可。");
    }
    return 0;
  } finally {
    await conn.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exit(await main());
}
