/**
 * verify-frame-budget —— **非门禁**的「帧预算 / 跨帧饥饿」证据 lane（不改引擎行为）。
 *
 * 回答一个具体问题：**同一页面上，主帧候选数超过 act 池预算时，子帧（iframe）里的按钮
 * 还进不进候选池？** 元素池是模型的整个可见世界；窗口是全局的、按帧串行填充（主帧在前），
 * 于是主帧填满后子帧分到 0 个名额——目标"找不到"可能只是**窗口外**，不是页面没有。
 * BACKLOG 的 `frame:<origin>` 后续立项 #6「>6 帧 / 每帧池配额」此前只标注"需先测量"，
 * 本 lane 就是那份测量证据。
 *
 * 为什么是证据 lane 而不是门禁：需要 chromium 与真实 `browserSession`，PR 门禁保持纯离线、
 * 不启浏览器；本工具只在本地跑，用来把"两种池预算下的子帧可见性差异"变成可复现事实，
 * 不改引擎行为、不改任何常量、不调模型、不联网（只连 127.0.0.1 上自己起的静态服务）。
 *
 * 测量对象：
 *   ① act 池预算 = `POOL_CAP_ELEMENTS`（`src/support/tuning.ts`；`extraction.MAX_ELEMENTS` 与
 *      `executor.actPoolCap` 同源）——执行器每步决策用的池；
 *   ② snapshot 池预算 = `SessionRuntime.doSnapshot` 的 `poolMax ?? 120`（交互会话快照面；
 *      请求字段可覆盖 1..200）——桥/GUI 观察用的池。
 * 同一份夹具页面（主帧 70 个可交互 `<button>` + 同源 iframe 内 Cancel / Sign In 两个按钮），
 * 用真实 `extractElements` 分别按两种预算抽池，断言：act 帽下主帧先填满、子帧 0 行；
 * snapshot 120 帽下主帧全入池、子帧 2 行。真站对应证据：`pool-27.json`
 * （Google Maps 会话快照池 111 行 = 109 主帧 + 2 子帧，含 `f1:e0` Cancel / `f1:e1` Sign In）
 * 与同会话里 `click Cancel` 的 `target_not_found`——act 64 帽下子帧按钮不在池。
 *
 * 只读纪律：不写仓库文件、不写 /tmp、不落证据文件——JSON 证据只进 stdout（`--json`），
 * 端口在输出里归一为 `<LOCAL>`，同一页面状态下逐字节可复现。
 *
 * 用法：
 *   node --experimental-strip-types tools/verify-frame-budget.ts            # 人类可读证据
 *   node --experimental-strip-types tools/verify-frame-budget.ts --json    # 单 JSON 到 stdout
 *   node --experimental-strip-types tools/verify-frame-budget.ts --repeat 3 # 每档重复抽取次数（默认 3）
 *   node --experimental-strip-types tools/verify-frame-budget.ts --headful # 可见窗口调试
 * 退出码：0 绿（全部断言通过且重复稳定）/ 1 红（证据不符、常量来源漂移、环境错误如实报）。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { browserSession } from "../src/engine/executor.ts";
import { extractElements } from "../src/app/candidate-scan.ts";
import { framesOf } from "../src/engine/page-shapes.ts";
import { POOL_CAP_ELEMENTS } from "../src/support/tuning.ts";
import type { BrowserSession } from "../src/engine/executor-types.ts";
import type { ElemPool } from "../src/engine/elem-model.ts";
import type { FrameLike, PageLike } from "../src/support/page-like.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURE_DIR = path.join(REPO, "fixtures", "engine", "frames");
const MAIN_FIXTURE = "main-70.html";
const CHILD_FIXTURE = "child-dialog.html";
/** 夹具事实（改夹具必须同步这里；断言失败会直说"夹具不再能证明饥饿"）。 */
const MAIN_BUTTONS = 70;
const CHILD_BUTTONS = ["Cancel", "Sign In"] as const;
/** 夹具路径相对仓库根（证据里不用绝对路径）。 */
const MAIN_FIXTURE_REL = "fixtures/engine/frames/main-70.html";
const CHILD_FIXTURE_REL = "fixtures/engine/frames/child-dialog.html";
const SESSION_RUNTIME_REL = "src/app/session-runtime.ts";
/**
 * snapshot 池预算缺省值：唯一出处 = `SessionRuntime.doSnapshot` 的
 * `intIn(req["poolMax"], 1, 200) ?? 120`。该 120 是内联字面量、未导出常量，所以本 lane
 * 只能镜像一份；`checkSnapshotBudgetSource()` 运行期回读源文件，源漂移即红，不让镜像悄悄过期。
 */
const SNAPSHOT_POOL_BUDGET_DEFAULT = 120;
const ACT_BUDGET_SOURCE = `src/support/tuning.ts POOL_CAP_ELEMENTS（extraction.MAX_ELEMENTS / executor.actPoolCap 同源）`;
const SNAPSHOT_BUDGET_SOURCE = `${SESSION_RUNTIME_REL} SessionRuntime.doSnapshot 的 \`poolMax ?? 120\`（请求字段可覆盖 1..200）`;
const DEFAULT_REPEATS = 3;
const USAGE = [
  "usage: node --experimental-strip-types tools/verify-frame-budget.ts [--json] [--headful] [--repeat N]",
  "  --json      stdout 只输出一个 JSON 证据对象（诊断走 stderr）",
  "  --repeat N  每档预算重复抽取次数（>=2，默认 3；用来证明同一页面状态结果可复现）",
  "  --headful   显示浏览器窗口（调试用；缺省无头）",
].join("\n");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ 静态夹具服务 */

interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

/** 只服务 `fixtures/engine/frames/` 下的 .html；监听 127.0.0.1 随机端口（同源才能逐帧 evaluate）。 */
async function startFixtureServer(root: string): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    const abs = path.resolve(root, `.${rel}`);
    const inside = abs === root || abs.startsWith(`${root}${path.sep}`);
    if (!inside || !abs.endsWith(".html") || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(fs.readFileSync(abs));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("夹具服务没有拿到端口");
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

/* ------------------------------------------------------------------ 页面事实 */

/** 轮询浏览器侧真值直到成立（确定性等待，不靠固定 sleep 猜时机）。 */
async function waitForTrue(label: string, check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
}

/** 每帧 DOM 里的可交互 `<button>` 文案（只读 evaluate；不含引擎池/不含聋章）。 */
async function domButtons(frame: FrameLike): Promise<string[]> {
  const rows = (await frame.evaluate(
    "Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim())",
  )) as unknown;
  return Array.isArray(rows) ? rows.map((v) => String(v)) : [];
}

interface DomFacts {
  frame_count: number;
  per_frame_buttons: Array<{ frame: number; count: number; labels: string[] }>;
}

async function readDomFacts(frames: FrameLike[]): Promise<DomFacts> {
  const per: DomFacts["per_frame_buttons"] = [];
  for (let i = 0; i < frames.length; i++) {
    const labels = await domButtons(frames[i]!);
    per.push({ frame: i, count: labels.length, labels });
  }
  return { frame_count: frames.length, per_frame_buttons: per };
}

/* ------------------------------------------------------------------ 池测量 */

interface Measurement {
  cap: number;
  source: string;
  pool_total: number;
  per_frame: Record<string, number>;
  frame_origins: Record<string, string>;
  iframe_buttons: Array<{ ref: string; label: string; frame: number }>;
  /** 每次重复的稳定指纹（perFrame + 子帧按钮标签）；长度 = repeats。 */
  signatures: string[];
  stable: boolean;
}

/** 池行 → 每帧行数 / 子帧按钮 / 帧 origin（origins 归一为 <LOCAL>，保证 JSON 可复现）。 */
function summarizePool(pool: ElemPool, cap: number, source: string, origin: string): Omit<Measurement, "signatures" | "stable"> {
  const perFrame: Record<string, number> = {};
  const frameOrigins: Record<string, string> = {};
  const iframeButtons: Array<{ ref: string; label: string; frame: number }> = [];
  for (const row of Object.values(pool)) {
    const frame = typeof row.frame === "number" ? row.frame : 0;
    perFrame[String(frame)] = (perFrame[String(frame)] ?? 0) + 1;
    if (frame !== 0) {
      const fo = typeof row.frame_origin === "string" && row.frame_origin.length > 0 ? row.frame_origin : "";
      if (fo.length > 0 && frameOrigins[String(frame)] === undefined) {
        frameOrigins[String(frame)] = fo.split(origin).join("<LOCAL>");
      }
      if (row.tag === "button" || (CHILD_BUTTONS as readonly string[]).includes(row.label)) {
        iframeButtons.push({ ref: String(row.ref ?? ""), label: String(row.label ?? ""), frame });
      }
    }
  }
  return {
    cap, source, pool_total: Object.keys(pool).length,
    per_frame: perFrame, frame_origins: frameOrigins,
    iframe_buttons: iframeButtons.sort((a, b) => a.ref.localeCompare(b.ref)),
  };
}

function signatureOf(m: Omit<Measurement, "signatures" | "stable">): string {
  return JSON.stringify({ total: m.pool_total, per_frame: m.per_frame, iframe: m.iframe_buttons.map((b) => `${b.ref}|${b.label}`) });
}

/**
 * 同一页面状态、同一预算重复抽池 N 次：行数/子帧标签必须逐次一致，否则"证据"不可复现，
 * 直接红（不把一次性读数包装成事实）。`extractElements` 每趟开头清旧章，重复抽取不改池构成。
 */
async function measure(page: PageLike, cap: number, source: string, origin: string, repeats: number): Promise<Measurement> {
  const signatures: string[] = [];
  let first: Omit<Measurement, "signatures" | "stable"> | null = null;
  for (let i = 0; i < repeats; i++) {
    const pool = await extractElements(page, true, cap);
    const m = summarizePool(pool, cap, source, origin);
    if (first === null) first = m;
    signatures.push(signatureOf(m));
  }
  const stable = first !== null && signatures.every((s) => s === signatures[0]);
  return { ...(first as Omit<Measurement, "signatures" | "stable">), signatures, stable };
}

/* ------------------------------------------------------------------ 常量来源断言 */

interface SourceCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/** 回读 session-runtime 的 snapshot 池预算字面量：镜像常量必须与真源一致（防静默漂移）。 */
function checkSnapshotBudgetSource(): SourceCheck {
  const abs = path.join(REPO, SESSION_RUNTIME_REL);
  if (!fs.existsSync(abs)) {
    return { id: "snapshot-budget-source", ok: false, detail: `${SESSION_RUNTIME_REL} 不存在——snapshot 池预算唯一出处缺失` };
  }
  const text = fs.readFileSync(abs, "utf8");
  const m = /req\["poolMax"\][^;\n]*\?\?\s*(\d+)/.exec(text);
  if (m === null) {
    return {
      id: "snapshot-budget-source", ok: false,
      detail: `${SESSION_RUNTIME_REL} 里没找到 \`req["poolMax"] … ?? <默认值>\` 形状——doSnapshot 的池预算来源已变，先核真源再更新本 lane 的镜像常量`,
    };
  }
  const value = Number(m[1]);
  return {
    id: "snapshot-budget-source",
    ok: value === SNAPSHOT_POOL_BUDGET_DEFAULT,
    detail: `源文件字面量 = ${value}，本 lane 镜像 = ${SNAPSHOT_POOL_BUDGET_DEFAULT}`,
  };
}

/* ------------------------------------------------------------------ 断言 */

interface Assertion {
  id: string;
  ok: boolean;
  detail: string;
}

function buildAssertions(
  dom: DomFacts, act: Measurement, snapshot: Measurement, sourceChecks: SourceCheck[],
): Assertion[] {
  const mainDom = dom.per_frame_buttons.find((f) => f.frame === 0);
  const childDom = dom.per_frame_buttons.find((f) => f.frame === 1);
  const actChild = act.per_frame["1"] ?? 0;
  const snapChild = snapshot.per_frame["1"] ?? 0;
  const snapMain = snapshot.per_frame["0"] ?? 0;
  const actMain = act.per_frame["0"] ?? 0;
  const childLabels = snapshot.iframe_buttons.map((b) => b.label);
  const expectChild = [...CHILD_BUTTONS];
  const budgetsDiffer = Number(POOL_CAP_ELEMENTS) !== Number(SNAPSHOT_POOL_BUDGET_DEFAULT);
  const fixtureCanStarve = MAIN_BUTTONS > POOL_CAP_ELEMENTS;
  return [
    {
      id: "fixture-main-buttons",
      ok: mainDom !== undefined && mainDom.count === MAIN_BUTTONS,
      detail: `主帧 DOM <button> = ${mainDom?.count ?? "?"}（期望 ${MAIN_BUTTONS}）`,
    },
    {
      id: "fixture-child-buttons",
      ok: childDom !== undefined && childDom.count === expectChild.length
        && expectChild.every((label, i) => childDom.labels[i] === label),
      detail: `子帧 DOM <button> = ${JSON.stringify(childDom?.labels ?? [])}（期望 ${JSON.stringify(expectChild)}）`,
    },
    {
      id: "budgets-differ",
      ok: budgetsDiffer,
      detail: `act 帽 ${POOL_CAP_ELEMENTS} vs snapshot 帽 ${SNAPSHOT_POOL_BUDGET_DEFAULT}——两种池预算本就不是同一口径`,
    },
    {
      id: "fixture-can-starve",
      ok: fixtureCanStarve,
      detail: `主帧候选 ${MAIN_BUTTONS} > act 帽 ${POOL_CAP_ELEMENTS}：夹具能证明饥饿；若常量变大，需加大主帧按钮数再测`,
    },
    {
      id: "act-main-fills-window",
      ok: actMain === POOL_CAP_ELEMENTS,
      detail: `act 帽下主帧入池 = ${actMain}（期望 ${POOL_CAP_ELEMENTS}：主帧先把窗口填满）`,
    },
    {
      id: "act-child-starved",
      ok: actChild === 0 && act.iframe_buttons.length === 0,
      detail: `act 帽下子帧入池 = ${actChild}、子帧按钮在池 = ${JSON.stringify(act.iframe_buttons.map((b) => b.label))}（期望 0 / []）`,
    },
    {
      id: "snapshot-main-all",
      ok: snapMain === MAIN_BUTTONS,
      detail: `snapshot 帽下主帧入池 = ${snapMain}（期望 ${MAIN_BUTTONS}：预算够，主帧候选全进）`,
    },
    {
      id: "snapshot-child-visible",
      ok: snapChild === expectChild.length && expectChild.every((label, i) => childLabels[i] === label),
      detail: `snapshot 帽下子帧入池 = ${snapChild}、按钮 = ${JSON.stringify(childLabels)}（期望 ${JSON.stringify(expectChild)}）`,
    },
    {
      id: "starvation-is-budget-caused",
      ok: snapChild > actChild && actMain === POOL_CAP_ELEMENTS && snapMain === MAIN_BUTTONS,
      detail: `子帧可见性差 = act ${actChild} 行 vs snapshot ${snapChild} 行——同为同一页面，差异只来自池预算`,
    },
    {
      id: "snapshot-budget-source",
      ok: sourceChecks.every((c) => c.ok),
      detail: sourceChecks.map((c) => `${c.id}: ${c.ok ? "一致" : "漂移"}（${c.detail}）`).join("；"),
    },
    {
      id: "repeatable",
      ok: act.stable && snapshot.stable,
      detail: `重复 ${act.signatures.length} 次：act ${act.stable ? "稳定" : "抖动"}、snapshot ${snapshot.stable ? "稳定" : "抖动"}`,
    },
  ];
}

/* ------------------------------------------------------------------ 输出 */

interface Evidence {
  lane: "verify-frame-budget";
  schema_version: number;
  fixture: { main: string; child: string; origin: string };
  dom: DomFacts;
  budgets: { act: Measurement; snapshot: Measurement };
  source_checks: SourceCheck[];
  assertions: Assertion[];
  ok: boolean;
}

function renderHuman(evidence: Evidence): string {
  const { dom, budgets, assertions } = evidence;
  const act = budgets.act;
  const snap = budgets.snapshot;
  const perFrame = (m: Measurement): string =>
    `主帧=${m.per_frame["0"] ?? 0} 子帧=${m.per_frame["1"] ?? 0}`;
  const childDetail = (m: Measurement): string =>
    m.iframe_buttons.length === 0 ? "否" : m.iframe_buttons.map((b) => `${b.ref} ${b.label}`).join(" / ");
  const lines = [
    "verify-frame-budget（非门禁证据 lane：本地 fixture + 真实 browserSession + extractElements；不改引擎行为）",
    `fixture     ${evidence.fixture.main}（主帧 ${MAIN_BUTTONS} 个可交互 <button> + 同源 iframe ${evidence.fixture.child}）`,
    `帧事实     帧数=${dom.frame_count}；每帧 DOM <button> = ${dom.per_frame_buttons.map((f) => `帧${f.frame}:${f.count}`).join("，")}`,
    `act 池      cap=${act.cap}（来源：${act.source}）`,
    `            perFrame ${perFrame(act)}；池行数=${act.pool_total}；子帧按钮在池：${childDetail(act)}`,
    `snapshot 池 cap=${snap.cap}（来源：${snap.source}）`,
    `            perFrame ${perFrame(snap)}；池行数=${snap.pool_total}；子帧按钮在池：${childDetail(snap)}`,
    `饥饿事实    act 帽 ${act.cap} < 主帧候选 ${MAIN_BUTTONS} ⇒ 主帧先填满、子帧 ${act.per_frame["1"] ?? 0} 行；`
      + `snapshot 帽 ${snap.cap} ⇒ 子帧 ${snap.per_frame["1"] ?? 0} 行——同一页面，差异只来自池预算`,
    `常量来源    act=${POOL_CAP_ELEMENTS}（${ACT_BUDGET_SOURCE}）；snapshot=${SNAPSHOT_POOL_BUDGET_DEFAULT}（${SNAPSHOT_BUDGET_SOURCE}）`,
    `源文件核对  ${evidence.source_checks.map((c) => `${c.id}: ${c.ok ? "一致" : "漂移"}`).join("；")}`,
    `可复现性    每档重复抽取 ${act.signatures.length} 次：act ${act.stable ? "稳定" : "抖动"}、snapshot ${snap.stable ? "稳定" : "抖动"}`,
  ];
  const failed = assertions.filter((a) => !a.ok);
  lines.push(`断言        ${assertions.length - failed.length}/${assertions.length} 通过${failed.length === 0 ? "" : `；失败：${failed.map((a) => a.id).join(", ")}`}`);
  if (failed.length > 0) for (const a of failed) lines.push(`  FAIL ${a.id}: ${a.detail}`);
  lines.push(evidence.ok ? "OK" : "FAIL");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ 入口 */

function has(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

/** `--repeat N`：>=2 才有稳定性证据；非法值按用法错误报 1。 */
function parseRepeat(argv: string[]): number | null {
  const i = argv.indexOf("--repeat");
  if (i === -1) return DEFAULT_REPEATS;
  const raw = argv[i + 1];
  const n = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(n) || n < 2 || n > 10) return null;
  return n;
}

async function run(): Promise<number> {
  const argv = process.argv.slice(2);
  if (has(argv, "--help") || has(argv, "-h")) {
    console.log(USAGE);
    return 0;
  }
  const wantJson = has(argv, "--json");
  const headful = has(argv, "--headful");
  const repeats = parseRepeat(argv);
  const log = (line: string): void => { (wantJson ? console.error : console.log)(line); };
  if (repeats === null) {
    console.error(USAGE);
    return 1;
  }
  for (const rel of [MAIN_FIXTURE, CHILD_FIXTURE]) {
    if (!fs.existsSync(path.join(FIXTURE_DIR, rel))) {
      console.error(`verify-frame-budget: 夹具缺失 fixtures/engine/frames/${rel}`);
      return 1;
    }
  }
  let server: FixtureServer | null = null;
  let session: BrowserSession | null = null;
  try {
    server = await startFixtureServer(FIXTURE_DIR);
    const origin = server.origin;
    session = await browserSession(!headful);
    const pageLike = session.page as unknown as PageLike;
    await session.page.goto(`${origin}/${MAIN_FIXTURE}`, { waitUntil: "load", timeout: 30_000 });
    // 就绪 = 两帧都在、主帧 70 个按钮、子帧按钮文案齐、主帧 load 完成（同源 iframe 已加载）。
    await waitForTrue("主帧 70 按钮 + 同源 iframe 的 Cancel/Sign In 就绪", async () => {
      const frames = framesOf(pageLike);
      if (frames.length < 2) return false;
      const ready = await frames[0]!.evaluate("document.readyState");
      if (ready !== "complete") return false;
      const main = await domButtons(frames[0]!);
      if (main.length !== MAIN_BUTTONS) return false;
      const child = await domButtons(frames[1]!);
      return child.length === CHILD_BUTTONS.length
        && CHILD_BUTTONS.every((label, i) => child[i] === label);
    });
    const frames = framesOf(pageLike);
    const dom = await readDomFacts(frames);
    log(`verify-frame-budget: 夹具就绪（帧数=${dom.frame_count}，origin 已归一）`);
    const act = await measure(pageLike, POOL_CAP_ELEMENTS, ACT_BUDGET_SOURCE, origin, repeats);
    log(`act 池测量完成：cap=${act.cap}，perFrame=${JSON.stringify(act.per_frame)}`);
    const snapshot = await measure(pageLike, SNAPSHOT_POOL_BUDGET_DEFAULT, SNAPSHOT_BUDGET_SOURCE, origin, repeats);
    log(`snapshot 池测量完成：cap=${snapshot.cap}，perFrame=${JSON.stringify(snapshot.per_frame)}`);
    const sourceChecks = [checkSnapshotBudgetSource()];
    const assertions = buildAssertions(dom, act, snapshot, sourceChecks);
    const ok = assertions.every((a) => a.ok);
    const evidence: Evidence = {
      lane: "verify-frame-budget",
      schema_version: 1,
      fixture: {
        main: MAIN_FIXTURE_REL, child: CHILD_FIXTURE_REL,
        origin: "<LOCAL>",
      },
      dom,
      budgets: { act, snapshot },
      source_checks: sourceChecks,
      assertions,
      ok,
    };
    if (wantJson) {
      console.log(JSON.stringify(evidence, null, 2));
    } else {
      console.log(renderHuman(evidence));
    }
    return ok ? 0 : 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`verify-frame-budget: ${message}`);
    if (!wantJson) console.error("环境/工具失败——chromium 缺失先跑：npx playwright install chromium（诊断：npm run doctor）");
    return 1;
  } finally {
    if (session !== null) { try { await session.close(); } catch { /* 关闭失败不覆盖主结果 */ } }
    if (server !== null) { try { await server.close(); } catch { /* 同上 */ } }
  }
}

process.exitCode = await run();
