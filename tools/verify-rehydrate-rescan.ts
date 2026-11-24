/**
 * verify-rehydrate-rescan —— 非门禁证据 lane：F72 strict-miss 的 `rehydrate_rescan` 事实落盘。
 *
 * 回答的问题（BACKLOG「2026-11-16 架构评审后续立项」#3，评审 P2）：页面 settle 超时 +
 * 声明 hint 全链 miss + `policy.act_hint:"strict"` 时，重抽池/重解析**已经执行**
 * （`resolved:false` 事实存在），但 strict 分支在动作行之前就 `stop("target_not_found")`，
 * trace 里没有任何行能承载这份事实 ⇒ RunReport 也丢了归因链。
 *
 * 本 lane 用本地夹具页（127.0.0.1 随机端口，零外部网络）构造真实触发条件：
 *   - 慢水合/持续突变：`#tick` 每 40ms 改文本 ⇒ 步首 settle 结论恒 `timedOut:true`；
 *   - 永不命中的声明 hint（`#never-appears`）+ `actHint:"strict"` ⇒ strict 早停；
 *   - `settle:{quietMs:400,timeoutMs:1000}` 让等待/重扫窗口确定且短（重扫固定等 2s，
 *     由 `min(2000, stepTimeoutLeft-250)` 决定；不传 `stepTimeoutMs` ⇒ 恰为 2000）。
 *
 * 三条断言场景：
 *   ① strict-miss-rescan-evidence：stop=target_not_found；RunReport.rehydrate_rescan 必须存在，
 *      waited_ms=2000 / pool 前后一致 / resolved:false；trace **没有**任何承载行（证明走的是
 *      run() 直传的退化字段，而不是旧 trace 查找）；strict reason 尾缀点名这次重扫；
 *      墙钟 ≥1.9s（等待真的发生）；外部请求 0。
 *   ② rescan-hit-trace-unchanged：`#late-btn` 在 3s 后才出现 ⇒ 步首池/宽扫池落空、2s 重扫池命中
 *      （resolved:true、池 +1）⇒ 动作执行、done 成立；RunReport.rehydrate_rescan 与 trace 行上的
 *      同一份事实**逐字段一致**（旧 trace 查找路径形状/口径不变）。
 *   ③ settle-off-no-key-old-shape：同一页面 `settle:null`（稳定门关闭 ⇒ 门控信号不存在，重扫永不
 *      触发）⇒ strict 停因不变，RunReport/trace/reason 里都没有 `rehydrate_rescan`
 *      （additive 键仅在发生时出现，旧报告形状不变）。
 *
 * 决策面：`installLayaRuntime(null)` + `installDecisionProvider(null)` ⇒ rules-only，
 * 零模型调用；目标由声明 hint 决定，判定只认页面/报告事实。
 *
 * 用法：node --experimental-strip-types tools/verify-rehydrate-rescan.ts [--verbose]
 * 退出码：0 绿 / 1 红（断言失败或环境不可用，如 chromium 缺失）/ 2 用法错误。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { browserSession } from "../src/engine/executor.ts";
import { buildMiddleware } from "../src/app/middleware-factory.ts";
import { installDecisionProvider } from "../src/model/decision-provider.ts";
import { installLayaRuntime } from "../src/model/model.ts";
import type { AnyPage, MiddlewareOptions, RunReport } from "../src/engine/executor-types.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(REPO, "fixtures", "engine", "rehydrate-rescan");
const USAGE = "usage: node --experimental-strip-types tools/verify-rehydrate-rescan.ts [--verbose]";
const SETTLE = { quietMs: 400, timeoutMs: 1000 };
/** 重扫等待 = `min(2000, stepTimeoutLeft-250)`；不传 stepTimeoutMs ⇒ 恰为 2000。 */
const RESCAN_WAIT_MS = 2000;

/* ------------------------------------------------------------------ 静态 HTTP */

interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

/** 只服务 `fixtures/engine/rehydrate-rescan/` 下 .html 的本地服务（随机端口，绑 127.0.0.1）。 */
async function startFixtureServer(root: string): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    const abs = path.resolve(root, `.${rel}`);
    const inside = abs === root || abs.startsWith(`${root}${path.sep}`);
    if (!inside || !fs.existsSync(abs) || !fs.statSync(abs).isFile() || !abs.endsWith(".html")) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
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

/* ------------------------------------------------------------------ 运行期观测 */

interface Observation {
  name: string;
  report: RunReport;
  external: string[];
  elapsedMs: number;
  /** 运行后页面事实（夹具页自己的只读账本；用于证明「页面真的在突变/动作真的点到了」）。 */
  pageFacts: Record<string, unknown>;
}

interface ScenarioSpec {
  name: string;
  /** 夹具文件名（`fixtures/engine/rehydrate-rescan/` 下）。 */
  fixture: string;
  goal: string;
  targetHint: string;
  /** `null` = 显式关闭稳定门（F72 门控信号不存在）。 */
  settle: { quietMs: number; timeoutMs: number } | null;
  /** 运行后页面事实读取脚本（可选；只读）。 */
  pageFacts?: string;
  /** done 信号（页面上的只读 JS 表达式；缺省 = 恒不成立）。 */
  goalSignal?: string;
}

/** 一个场景 = 全新无头会话 + 规则面执行器 + 外部请求记账。 */
async function observeScenario(spec: ScenarioSpec, origin: string, verbose: boolean): Promise<Observation> {
  // 强制规则面：无 provider / 无 LayaRuntime ⇒ rules-only，零模型调用（确定性前提）。
  installLayaRuntime(null);
  installDecisionProvider(null);
  const session = await browserSession(true);
  const page = session.page;
  const external: string[] = [];
  const withOn = page as unknown as { on(event: string, cb: (req: { url(): string }) => void): void };
  withOn.on("request", (req) => {
    const url = req.url();
    if (url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:") || url === "about:blank") return;
    external.push(url);
  });
  const options: Omit<MiddlewareOptions, "confirmFn"> = {
    hosts: ["127.0.0.1"],
    maxSteps: 1,
    gotoTimeout: 15_000,
    actHint: "strict",
    settle: spec.settle,
  };
  const mw = buildMiddleware({ face: "online", confirmPolicy: { kind: "allow-all" }, options });
  const started = Date.now();
  try {
    const report = await mw.run(spec.goal, `${origin}/${spec.fixture}`, {
      targetHint: spec.targetHint,
      goalSignalFn: async (readPage) => spec.goalSignal !== undefined
        && Boolean(await (readPage as unknown as { evaluate(js: string): Promise<unknown> }).evaluate(spec.goalSignal)),
      page,
      verbose,
    });
    const pageFacts = spec.pageFacts === undefined
      ? {}
      : (await (page as unknown as { evaluate(js: string): Promise<Record<string, unknown>> }).evaluate(spec.pageFacts));
    return { name: spec.name, report, external, elapsedMs: Date.now() - started, pageFacts };
  } finally {
    await session.close();
  }
}

/* ------------------------------------------------------------------ 断言 */

class Checker {
  private readonly scenario: string;
  private readonly failures: string[] = [];
  private readonly passed: string[] = [];
  constructor(scenario: string) { this.scenario = scenario; }
  check(label: string, ok: boolean, detail?: string): void {
    if (ok) this.passed.push(label);
    else this.failures.push(`${label}${detail === undefined ? "" : ` — ${detail}`}`);
  }
  /** 场景收尾：打印逐条结果；返回本场景失败数。 */
  report(): number {
    for (const label of this.passed) console.log(`  ✓ ${label}`);
    for (const label of this.failures) console.error(`  ✗ [${this.scenario}] ${label}`);
    return this.failures.length;
  }
}

const hasKey = (obj: unknown, key: string): boolean =>
  typeof obj === "object" && obj !== null && Object.prototype.hasOwnProperty.call(obj, key);

const traceRowsWithRescan = (report: RunReport): Array<Record<string, unknown>> =>
  report.steps.filter((step) => hasKey(step, "rehydrate_rescan"));

interface RescanFact {
  waited_ms: number;
  pool_size_before: number;
  pool_size: number;
  resolved: boolean;
  ref?: string;
}

const rescanFactOf = (report: RunReport): RescanFact | null =>
  hasKey(report, "rehydrate_rescan") ? (report as unknown as { rehydrate_rescan: RescanFact }).rehydrate_rescan : null;

/** ① strict-miss：证据必须由 run() 直传字段退化提供（trace 无承载行）。 */
function checkStrictMiss(obs: Observation): number {
  const c = new Checker(obs.name);
  const { report } = obs;
  const fact = rescanFactOf(report);
  c.check("stop_code = target_not_found", report.stop_code === "target_not_found", `实际 ${String(report.stop_code)}`);
  c.check("done = false", report.done === false);
  c.check("RunReport.rehydrate_rescan 存在（strict 早停仍落盘）", fact !== null);
  if (fact !== null) {
    c.check(`waited_ms = ${RESCAN_WAIT_MS}（固定重扫窗口）`, fact.waited_ms === RESCAN_WAIT_MS, `实际 ${fact.waited_ms}`);
    c.check("resolved = false（重扫池仍未命中）", fact.resolved === false);
    c.check("pool_size_before = pool_size（池没有换出目标）", fact.pool_size === fact.pool_size_before,
      `${fact.pool_size_before} → ${fact.pool_size}`);
    c.check("pool_size_before = 步首池大小（diagnostics.pool_size）",
      report.diagnostics?.pool_size === fact.pool_size_before,
      `diagnostics=${String(report.diagnostics?.pool_size)} / fact=${fact.pool_size_before}`);
    c.check("键集 = waited_ms/pool_size_before/pool_size/resolved（落空不带 ref）",
      Object.keys(fact).sort().join(",") === "pool_size,pool_size_before,resolved,waited_ms",
      Object.keys(fact).join(","));
  }
  c.check("trace 无承载行（证据来自退化字段而非旧 trace 查找）", traceRowsWithRescan(report).length === 0,
    `steps=${report.steps.length}`);
  c.check("strict reason 尾缀点名重扫等待",
    typeof report.stop_reason === "string"
      && report.stop_reason.includes(`rehydrate_rescan 已等 ${RESCAN_WAIT_MS}ms 重抽池`),
    String(report.stop_reason).slice(-120));
  c.check("墙钟覆盖了 2s 重扫等待（≥1900ms）", obs.elapsedMs >= 1900, `实际 ${obs.elapsedMs}ms`);
  c.check("外部请求 0（只连本地夹具服务）", obs.external.length === 0, JSON.stringify(obs.external));
  const tick = Number(obs.pageFacts["tick"]);
  c.check("页面确实持续突变（settle timedOut 信号为真，tick > 20）", Number.isFinite(tick) && tick > 20, `tick=${String(obs.pageFacts["tick"])}`);
  return c.report();
}

/** ② rescan-hit：命中走既有 trace 行证据面，RunReport 与 trace 逐字段一致（形状不变）。 */
function checkRescanHit(obs: Observation): number {
  const c = new Checker(obs.name);
  const { report } = obs;
  const fact = rescanFactOf(report);
  c.check("done = true（重扫命中后动作执行）", report.done === true);
  c.check("stop_code = dom_goal_signal", report.stop_code === "dom_goal_signal", `实际 ${String(report.stop_code)}`);
  c.check("RunReport.rehydrate_rescan 存在", fact !== null);
  if (fact !== null) {
    c.check("resolved = true", fact.resolved === true);
    c.check("命中 ref 为池内引用（字符串）", typeof fact.ref === "string" && fact.ref !== "", String(fact.ref));
    c.check(`waited_ms = ${RESCAN_WAIT_MS}`, fact.waited_ms === RESCAN_WAIT_MS, `实际 ${fact.waited_ms}`);
    c.check("重扫池比首池多 1（迟到按钮出现）", fact.pool_size === fact.pool_size_before + 1,
      `${fact.pool_size_before} → ${fact.pool_size}`);
  }
  const rows = traceRowsWithRescan(report);
  c.check("trace 恰有 1 行承载 rehydrate_rescan", rows.length === 1, `实际 ${rows.length}`);
  c.check("RunReport 与 trace 行是同一份事实（逐字段一致）",
    rows.length === 1 && JSON.stringify(rows[0]!["rehydrate_rescan"]) === JSON.stringify(fact),
    `trace=${JSON.stringify(rows[0]?.["rehydrate_rescan"])} / report=${JSON.stringify(fact)}`);
  const hits = obs.pageFacts["hits"];
  c.check("页面账本记录 late-btn 点击（动作真的落在迟到目标上）",
    Array.isArray(hits) && hits.includes("late-btn"), JSON.stringify(hits));
  c.check("外部请求 0（只连本地夹具服务）", obs.external.length === 0, JSON.stringify(obs.external));
  return c.report();
}

/** ③ settle 关闭：门控信号不存在 ⇒ 重扫永不触发，报告/证据面回到旧形状（无新键）。 */
function checkSettleOff(obs: Observation): number {
  const c = new Checker(obs.name);
  const { report } = obs;
  c.check("stop_code = target_not_found（strict 停因不变）", report.stop_code === "target_not_found", `实际 ${String(report.stop_code)}`);
  c.check("RunReport 无 rehydrate_rescan 键（旧形状不变）", !hasKey(report, "rehydrate_rescan"));
  c.check("trace 无承载行", traceRowsWithRescan(report).length === 0, `steps=${report.steps.length}`);
  c.check("strict reason 不提 rehydrate_rescan", !String(report.stop_reason ?? "").includes("rehydrate_rescan"));
  c.check("外部请求 0", obs.external.length === 0, JSON.stringify(obs.external));
  return c.report();
}

/* ------------------------------------------------------------------ 主流程 */

const TICK_FACTS = "(() => ({ tick: Number(String(document.getElementById('tick')?.textContent ?? '')) }))()";
const HIT_FACTS = `(() => ({
  hits: (Array.isArray(window.__hits) ? window.__hits : []).map(String),
  out: String(document.getElementById("out")?.textContent ?? ""),
}))()`;
const LATE_HIT_HELD = `(() => (Array.isArray(window.__hits) ? window.__hits : []).includes("late-btn"))()`;

async function main(argv: string[]): Promise<number> {
  const known = new Set(["--verbose"]);
  for (const arg of argv) {
    if (!known.has(arg)) {
      console.error(`verify-rehydrate-rescan: 未知参数 ${JSON.stringify(arg)}`);
      console.error(USAGE);
      return 2;
    }
  }
  const verbose = argv.includes("--verbose");
  if (!fs.existsSync(FIXTURES)) {
    console.error(`verify-rehydrate-rescan: 夹具目录不存在：${path.relative(REPO, FIXTURES)}`);
    return 1;
  }
  const server = await startFixtureServer(FIXTURES);
  try {
    let probe: Awaited<ReturnType<typeof browserSession>>;
    try {
      probe = await browserSession(true);
    } catch (err) {
      console.error(`verify-rehydrate-rescan: 启动无头 chromium 失败：${err instanceof Error ? err.message : String(err)}`);
      console.error("  补齐环境：npm ci && npx playwright install chromium；体检：npm run doctor");
      return 1;
    }
    await probe.close();
    const specs: Array<{ spec: ScenarioSpec; check: (obs: Observation) => number }> = [
      {
        spec: {
          name: "strict-miss-rescan-evidence", fixture: "strict-miss.html",
          goal: "点击永远不出现的目标", targetHint: "#never-appears", settle: SETTLE, pageFacts: TICK_FACTS,
        },
        check: checkStrictMiss,
      },
      {
        spec: {
          name: "rescan-hit-trace-unchanged", fixture: "late-hit.html",
          goal: "点击 3s 后才出现的迟到按钮", targetHint: "#late-btn", settle: SETTLE,
          pageFacts: HIT_FACTS, goalSignal: LATE_HIT_HELD,
        },
        check: checkRescanHit,
      },
      {
        spec: {
          name: "settle-off-no-key-old-shape", fixture: "strict-miss.html",
          goal: "点击永远不出现的目标", targetHint: "#never-appears", settle: null,
        },
        check: checkSettleOff,
      },
    ];
    let failed = 0;
    for (const { spec, check } of specs) {
      console.log(`verify-rehydrate-rescan: 场景 ${spec.name}（${spec.fixture} / ${spec.targetHint} / settle=${spec.settle === null ? "off" : `${spec.settle.timeoutMs}ms`}）`);
      const obs = await observeScenario(spec, server.origin, verbose);
      failed += check(obs);
    }
    if (failed > 0) {
      console.error(`verify-rehydrate-rescan: FAIL — ${failed} 条断言不成立（外部请求必须为 0；本 lane 不联网、不调模型）`);
      return 1;
    }
    console.log(`verify-rehydrate-rescan: OK — 3 个场景全部通过（strict-miss 证据落盘 / 命中 trace 形状不变 / settle-off 旧形状不变；零模型调用、零外部网络）`);
    return 0;
  } finally {
    await server.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
