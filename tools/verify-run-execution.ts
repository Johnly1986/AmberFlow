/**
 * verify-run-execution —— **非门禁**的 S1 执行内核三源等价 lane：
 * 本地静态夹具 + 无头 chromium + rules-only（零模型调用），分别跑
 *   flow   : `runScriptApp(loadScriptApp(...))`
 *   plan   : `runPlan(TaskPlan.load(...))`
 *   suite  : `runSuite([case], sites)`
 * 并把三份**归一化产物**与入库 golden 比对。
 *
 * 定位（为什么不进 `npm run check`）：本 lane 需要 chromium，PR 门禁保持纯离线；
 * 与 `tools/verify-runtime-offline.ts` 的分工：那一层验证**唯一执行循环**
 * `BrowserMiddleware.run` 的场景事实，这一层验证**四条编排迁到内核之后，三源产物
 * 与迁前逐字节等价**（S1 共享职责：SessionLease / RunScope / mw 装配入口 / pace 时钟 /
 * attempt 记账 / 停因分类 / artifact 目录交接）。等价裁决只看归一化产物，不看实现。
 *
 * 三源覆盖（每源一条确定性路径）：
 *   flow  : 决策语句（authored hint + DOM done）+ 结束态不变量 → AppRunResult + emit-trace 轨迹；
 *   plan  : 子目标循环 + 重试（配置类停因 2 次尝试后 blocked）+ when 不成立跳过 → RunPlanResult +
 *           plan 落盘文件（`plan.save()` 的 checkpoint 事实）；
 *   suite : 用例 preflight + 子目标 + 结束态不变量 + oracle + 证据落盘 → CaseOutcome + 套件退出码。
 *
 * 归一化（跨机器可重复）：`127.0.0.1:<端口>` → `<LOCAL>`；仓库根 → `<REPO>`；lane 工作目录 →
 * `<WORK>`；系统临时目录 → `<TMP>`；对象键递归排序。只剔除**易变字段**（`secs`/`duration_ms`/
 * `started_at`/`finished_at`/`run_id`/`saved_at`/`user_agent`/`browser`），行为字段一个不剔。
 * 外部请求必须恒为 `[]`（三源都注入 sessionFactory 以便在页面上记账；本 lane 只连本机
 * 127.0.0.1 静态服务）。
 *
 * 记录口径：`--record` 时每个源连跑两次，两次归一化结果一致才写 golden；不一致 = 退出码 1。
 *
 * 用法：
 *   node --experimental-strip-types tools/verify-run-execution.ts            # 比对（默认 --check）
 *   node --experimental-strip-types tools/verify-run-execution.ts --check    # 显式
 *   node --experimental-strip-types tools/verify-run-execution.ts --record   # 写基线 tools/golden/run-execution/**
 *   node --experimental-strip-types tools/verify-run-execution.ts --list
 * 退出码：0 绿 / 1 红（观测不一致、外部请求非 0、--record 两次不一致）/ 2 用法或环境错误（如 chromium 缺失）。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { browserSession } from "../src/engine/executor.ts";
import { installLayaRuntime } from "../src/model/model.ts";
import { installDecisionProvider } from "../src/model/decision-provider.ts";
import { loadScriptApp } from "../src/app/app-script.ts";
import { runScriptApp } from "../src/app/app-runner.ts";
import { runApp } from "../src/app/app-runner-declared.ts";
import type { AppPack } from "../src/app/app-pack.ts";
import { TaskPlan } from "../src/engine/plan.ts";
import { runPlan } from "../src/engine/planner.ts";
import { runSuite } from "../src/online/runner.ts";
import { buildMiddleware } from "../src/app/middleware-factory.ts";
import type { BrowserSession } from "../src/engine/executor.ts";
import type { OnlineCase, OnlineSite } from "../src/online/types.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(REPO, "fixtures", "engine");
const LANE_FIXTURES = path.join(FIXTURES, "run-execution");
const GOLDEN_DIR = path.join(REPO, "tools", "golden", "run-execution");
const USAGE = "usage: node --experimental-strip-types tools/verify-run-execution.ts "
  + "[--check | --record | --list] [--source flow|plan|suite]";
const GOLDEN_DOC =
  "verify-run-execution 基线（非门禁）：本地 fixtures + 无头 chromium + rules-only，三源 "
  + "（flow runScriptApp / plan runPlan / suite runSuite）的归一化产物。只用于四条编排迁到 "
  + "runExecution 内核前后的等价对比：--record 显式更新（同源连跑两次一致才入库）；"
  + "端口/仓库根/工作目录/临时目录已归一，时间/run_id/UA 类易变字段已剔除，不得手改。";
const SCHEMA_VERSION = 1;
const REQUIRED_FIXTURES = 7;   // 与 verify-runtime-offline 共用 fixtures/engine 的页面集

/* ------------------------------------------------------------------ 静态 HTTP */

interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

/** 只服务 `fixtures/engine/` 下 .html 的本地服务（监听随机端口，绑定 127.0.0.1）。 */
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

/* ------------------------------------------------------------------ 归一化 */

/** 易变字段（时间/身份/UA/浏览器版本事实 + 位置性 ref）：宿主/时序相关，不是行为契约。 */
const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  "secs", "duration_ms", "started_at", "finished_at", "run_id", "saved_at",
  "user_agent", "browser", "elapsed_ms", "elapsedMs",
  // 位置性池编号（`e8` / `dom:0`）随抽池顺序/窗口漂移，与 verify-runtime-offline 同口径不入库。
  "ref",
  // 页面句柄编号（`p1`/`p2`）与 settle 等待毫秒数是运行时事实，不是行为契约。
  "page_id", "settleMs",
  // 声明目标的恢复链标记（池命中 / FW8 身份回捞 / DRF）：同一条路径的**解析证据**会随
  // 进程内浏览器冷/热启动在池命中与身份回捞之间摆动（页面事实相同），不是内核行为契约。
  "resolved_by",
  // `inputs_sha256` 含本机静态服务入口（随机端口）→ 跨运行 hash 不同；输入确定性由
  // 槽位与 fixture 文本本身保证，不在等价口径内。
  "inputs_sha256",
  // `plan_sha256` 是 lowering 后 IR 的 hash，含脚本绝对路径（`pack._path`）→ 仓库落点不同
  // hash 就不同；脚本内容由 `script_sha256` 单独钉住。
  "plan_sha256",
]);
const LOCAL_RE = /http:\/\/127\.0\.0\.1:\d+/g;

/** 递归归一：端口/仓库根/工作目录/临时目录 → 稳定占位；对象键排序（同内容 = 同字节）。 */
function normalize(value: unknown, workDir: string): unknown {
  if (typeof value === "string") {
    return value
      .replace(LOCAL_RE, "<LOCAL>")
      .replaceAll(REPO, "<REPO>")
      .replaceAll(workDir, "<WORK>")
      .replaceAll(os.tmpdir(), "<TMP>")
      // 状态指纹的内容/结构 hash 由页面文本与盖章属性算出（与 URL/时序相关），只留形状：
      // 纯 hash（`c895b40f`）与「元素数:hash」（`40:f390c967`）归一成可跨运行比较的形状。
      .replace(/^[0-9a-f]{8}$/, "<HASH>")
      .replace(/^(\d+):[0-9a-f]{8}$/, "$1:<HASH>");
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, workDir));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = normalize((value as Record<string, unknown>)[key], workDir);
    }
    return out;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

/** 把夹具里的 `{ENTRY}` 占位符替换成本次静态服务的真实入口页。 */
function withEntry<T>(template: T, origin: string): T {
  const entry = `${origin}/filter-bar.html`;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.replaceAll("{ENTRY}", entry);
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(template) as T;
}

/* ------------------------------------------------------------------ 会话观察 */

type Dict = Record<string, unknown>;

/** 页面请求记账：只允许本服务 origin / data: / about:blank，其余都算外部请求。 */
function watchRequests(session: BrowserSession, origin: string, external: string[]): BrowserSession {
  const withOn = session.page as unknown as { on(event: string, cb: (req: { url(): string }) => void): void };
  withOn.on("request", (req) => {
    const url = req.url();
    if (url.startsWith(origin) || url.startsWith("data:") || url === "about:blank") return;
    external.push(url);
  });
  return session;
}

/* ------------------------------------------------------------------ 三源观察 */

type SourceObservation = {
  source: "flow" | "declared" | "plan" | "suite";
  /** 归一化后的产物事实（golden 的 expected 内容）。 */
  expected: Dict;
  /** 外部请求清单（必须为空）。 */
  external: string[];
};

/** flow 源：runScriptApp（决策语句 + 不变量 + emit-trace 轨迹）。 */
async function observeFlow(origin: string, workDir: string): Promise<SourceObservation> {
  installLayaRuntime(null);
  installDecisionProvider(null);
  const app = await loadScriptApp(path.join(LANE_FIXTURES, "flow-app", "app.mjs"));
  const outDir = path.join(workDir, "flow-out");
  const tracePath = path.join(workDir, "flow-trace.json");
  const external: string[] = [];
  const result = await runScriptApp(app, {
    outDir,
    runId: "lane-flow",
    slots: { entry: `${origin}/filter-bar.html` },
    emitTrace: tracePath,
    verbose: false,
    sessionFactory: async () => watchRequests(await browserSession(true), origin, external),
  });
  const trace = fs.existsSync(tracePath) ? readJson(tracePath) : null;
  return { source: "flow", expected: { result, trace }, external: [...external].sort() };
}

/** declared 源：runApp（数据腿外的声明式旅程：走步循环 + 结束态不变量 + 步证据）。 */
async function observeDeclared(origin: string, workDir: string): Promise<SourceObservation> {
  installLayaRuntime(null);
  installDecisionProvider(null);
  const pack = readJson(path.join(LANE_FIXTURES, "declared-app.json")) as AppPack;
  const external: string[] = [];
  const result = await runApp(pack, {
    slots: { entry: `${origin}/filter-bar.html` },
    sources: false,
    planPath: path.join(workDir, "declared-plan.json"),
    verbose: false,
    captureTraces: true,
    sessionFactory: async () => watchRequests(await browserSession(true), origin, external),
  });
  return { source: "declared", expected: { result }, external: [...external].sort() };
}

/** plan 源：runPlan（子目标循环 + retries + when 跳过 + plan checkpoint 落盘）。 */
async function observePlan(origin: string, workDir: string): Promise<SourceObservation> {
  installLayaRuntime(null);
  installDecisionProvider(null);
  const planPath = path.join(workDir, "plan.json");
  const template = readJson(path.join(LANE_FIXTURES, "plan.json"));
  fs.writeFileSync(planPath, JSON.stringify(withEntry(template, origin), null, 2), "utf8");
  const plan = TaskPlan.load(planPath);
  if (plan === null) throw new Error("lane plan 夹具加载失败");
  const mw = buildMiddleware({
    face: "plan",
    confirmPolicy: { kind: "caller", confirmFn: () => true },
  });
  const external: string[] = [];
  const rep = await runPlan(mw as never, plan, {
    startUrl: `${origin}/filter-bar.html`,
    verbose: false,
    sessionFactory: async () => watchRequests(await browserSession(true), origin, external),
  });
  // plan.save() 在每次状态变化时落盘：checkpoint 文件同样是产物（去掉 saved_at 后逐字节可比）。
  const savedPlan = fs.existsSync(planPath) ? readJson(planPath) : null;
  return {
    source: "plan",
    expected: {
      completed: rep.completed,
      replans: rep.replans,
      skipped: rep.skipped,
      retried: rep.retried,
      traces: rep.traces,
      plan: savedPlan,
    },
    external: [...external].sort(),
  };
}

/** suite 源：runSuite（用例 preflight + 子目标 + 不变量 + oracle + 证据落盘 + 套件退出码）。 */
async function observeSuite(origin: string, workDir: string): Promise<SourceObservation> {
  installLayaRuntime(null);
  installDecisionProvider(null);
  const template = readJson(path.join(LANE_FIXTURES, "case.json")) as OnlineCase;
  const c = withEntry(template, origin);
  const site: OnlineSite = {
    id: "lane-fixtures",
    hosts: ["127.0.0.1"],
    home: `${origin}/filter-bar.html`,
    allow_local: true,
    timeout_ms: 30_000,
  };
  const external: string[] = [];
  const out = path.join(workDir, "suite-out");
  const { suite, code } = await runSuite([c], new Map([[site.id, site]]), {
    out,
    tier: "core",
    provider: "none",
    verbose: false,
    maxSteps: 8,
    sessionFactory: async () => watchRequests(await browserSession(true), origin, external),
  });
  return {
    source: "suite",
    expected: {
      code,
      tier: suite.tier,
      passed: suite.passed,
      failed: suite.failed,
      skipped: suite.skipped,
      cases: suite.cases,
    },
    external: [...external].sort(),
  };
}

const SOURCES: ReadonlyArray<{
  name: SourceObservation["source"];
  observe(origin: string, workDir: string): Promise<SourceObservation>;
}> = [
  { name: "flow", observe: observeFlow },
  { name: "declared", observe: observeDeclared },
  { name: "plan", observe: observePlan },
  { name: "suite", observe: observeSuite },
];

/* ------------------------------------------------------------------ 差异报告 */

/** 首个差异行 + 前后文（定位归一化口径/行为漂移用；不写文件）。 */
function firstDiff(aLabel: string, aText: string, bLabel: string, bText: string): string {
  const a = aText.split("\n");
  const b = bText.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const from = Math.max(0, i - 3);
    const to = Math.min(Math.max(a.length, b.length), i + 4);
    const lines: string[] = [`  首个差异第 ${i + 1} 行（含前后文）`];
    for (let k = from; k < to; k++) {
      lines.push(`    ${String(k + 1).padStart(5)} ${aLabel}: ${a[k] ?? "<无>"}`);
      lines.push(`    ${String(k + 1).padStart(5)} ${bLabel}: ${b[k] ?? "<无>"}`);
    }
    return lines.join("\n");
  }
  return "  （文本不同但逐行相同？）";
}

function reportFirstDiff(aLabel: string, aText: string, bLabel: string, bText: string): void {
  console.error(firstDiff(aLabel, aText, bLabel, bText));
}

/* ------------------------------------------------------------------ golden I/O */

function goldenPath(name: string): string {
  return path.join(GOLDEN_DIR, `${name}.json`);
}

function goldenOf(observation: SourceObservation, workDir: string): Dict {
  return {
    _doc: GOLDEN_DOC,
    schema_version: SCHEMA_VERSION,
    source: observation.source,
    expected: normalize({ ...observation.expected, external_requests: observation.external }, workDir),
  };
}

/** 记录全部 golden：每个源连跑两次，归一化结果一致才写；先清掉不属于当前源集的旧文件。 */
async function record(origin: string, workDir: string, sources: typeof SOURCES = SOURCES): Promise<number> {
  if (!fs.existsSync(GOLDEN_DIR)) fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  let unstable = 0;
  for (const source of sources) {
    const first = await source.observe(origin, workDir);
    const second = await source.observe(origin, workDir);
    const firstText = stableStringify(normalize(first.expected, workDir));
    const secondText = stableStringify(normalize(second.expected, workDir));
    if (process.env.AMBERFLOW_LANE_DUMP === "1") {
      fs.writeFileSync(`/tmp/lane-${source.name}-1.json`, firstText);
      fs.writeFileSync(`/tmp/lane-${source.name}-2.json`, secondText);
    }
    if (firstText !== secondText) {
      unstable += 1;
      console.error(`verify-run-execution: ${source.name} 两次运行不一致，拒绝入库（先让源确定性化）`);
      reportFirstDiff("第一次", firstText, "第二次", secondText);
      continue;
    }
    fs.writeFileSync(goldenPath(source.name), stableStringify(goldenOf(first, workDir)), "utf8");
    console.log(`verify-run-execution: 记录 ${source.name}（两次一致；外部请求 ${first.external.length}）`);
  }
  // 只有全量记录才清理过期文件：`--source X` 是局部重录，不能删掉别的源的基线。
  if (sources.length === SOURCES.length) {
    const keep = new Set(SOURCES.map((s) => `${s.name}.json`));
    for (const file of fs.readdirSync(GOLDEN_DIR)) {
      if (file.endsWith(".json") && !keep.has(file)) {
        fs.rmSync(path.join(GOLDEN_DIR, file));
        console.log(`verify-run-execution: 删除过期 golden ${file}`);
      }
    }
  }
  if (unstable > 0) {
    console.error(`verify-run-execution: FAIL — ${unstable} 个源不稳定，未入库`);
    return 1;
  }
  console.log(`verify-run-execution: 已记录 ${sources.length} 个源基线 → tools/golden/run-execution/`);
  return 0;
}

/** 比对全部 golden；返回问题列表（空 = 绿）。 */
async function check(origin: string, workDir: string, sources: typeof SOURCES = SOURCES): Promise<number> {
  if (!fs.existsSync(GOLDEN_DIR)) {
    console.error("verify-run-execution: 缺少 tools/golden/run-execution/ 基线——运行 --record 生成（非门禁 lane，基线需入库）");
    return 1;
  }
  const expectedFiles = new Set(sources.map((s) => `${s.name}.json`));
  for (const file of fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json")).sort()) {
    if (!expectedFiles.has(file)) console.error(`verify-run-execution: 过期 golden：${file}（源已不存在；--record 会清理）`);
  }
  const problems: string[] = [];
  for (const source of sources) {
    const file = goldenPath(source.name);
    if (!fs.existsSync(file)) {
      problems.push(`缺少 golden：${path.relative(REPO, file)}（--record 生成）`);
      continue;
    }
    let golden: unknown;
    try {
      golden = readJson(file);
    } catch (err) {
      problems.push(`${source.name}: golden JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const observation = await source.observe(origin, workDir);
    if (observation.external.length > 0) {
      problems.push(`${source.name}: 外部请求必须为 0（本 lane 不联网），实际：${JSON.stringify(observation.external)}`);
    }
    const actualText = stableStringify(normalize({ ...observation.expected, external_requests: observation.external }, workDir));
    const expectedText = stableStringify((golden as Dict)["expected"]);
    if (actualText === expectedText) continue;
    problems.push(`${source.name}: 产物观测与 golden 不一致\n${firstDiff("golden", expectedText, "实际", actualText)}`);
  }
  for (const problem of problems) console.error(`verify-run-execution: ${problem}`);
  if (problems.length > 0) {
    console.error(`verify-run-execution: FAIL — ${problems.length} 个问题；行为变化时先确认是预期变更，再 --record 更新基线`);
    return 1;
  }
  console.log(`verify-run-execution: OK — ${sources.length} 个源的归一化产物与 golden 一致（无外部请求，未调模型）`);
  return 0;
}

function list(sources: typeof SOURCES = SOURCES): number {
  if (!fs.existsSync(GOLDEN_DIR)) {
    console.log("verify-run-execution: 没有 golden 目录（先 --record）");
    return 0;
  }
  const files = fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json")).sort();
  console.log(`verify-run-execution: 源 ${sources.map((s) => s.name).join(" / ")}；golden ${files.length} 个`);
  return 0;
}

/* ------------------------------------------------------------------ 主流程 */

async function main(argv: string[]): Promise<number> {
  const known = new Set(["--check", "--record", "--list"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--source") { i += 1; continue; }
    if (!known.has(arg)) {
      console.error(`verify-run-execution: 未知参数 ${JSON.stringify(arg)}`);
      console.error(USAGE);
      return 2;
    }
  }
  const sourceArg = argv.indexOf("--source");
  const sourceName = sourceArg === -1 ? null : argv[sourceArg + 1] ?? null;
  if (sourceArg !== -1 && !SOURCES.some((s) => s.name === sourceName)) {
    console.error(`verify-run-execution: --source 只接受 ${SOURCES.map((s) => s.name).join(" / ")}，收到 ${JSON.stringify(sourceName)}`);
    console.error(USAGE);
    return 2;
  }
  const sources = sourceName === null ? SOURCES : SOURCES.filter((s) => s.name === sourceName);
  if (argv.includes("--list")) return list(sources);
  for (const required of ["flow-app/app.mjs", "declared-app.json", "plan.json", "case.json"]) {
    if (!fs.existsSync(path.join(LANE_FIXTURES, required))) {
      console.error(`verify-run-execution: 缺少 lane 夹具 fixtures/engine/run-execution/${required}`);
      return 2;
    }
  }
  if (!fs.existsSync(FIXTURES)) {
    console.error(`verify-run-execution: 夹具目录不存在：${path.relative(REPO, FIXTURES)}`);
    return 2;
  }
  const htmlCount = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".html")).length;
  if (htmlCount < REQUIRED_FIXTURES) {
    console.error(`verify-run-execution: fixtures/engine 只有 ${htmlCount} 个 .html（基线要求 ${REQUIRED_FIXTURES} 个）`);
    return 2;
  }
  // 工作目录固定在仓库外：三源的 outDir / plan checkpoint / 证据目录都落这里，不污染 checkout。
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-run-execution-lane-"));
  const server = await startFixtureServer(FIXTURES);
  try {
    // 先探一次无头会话：chromium 缺失属于环境问题（退出码 2），不是等价性变红。
    try {
      const probe = await browserSession(true);
      await probe.close();
    } catch (err) {
      console.error(`verify-run-execution: 启动无头 chromium 失败：${err instanceof Error ? err.message : String(err)}`);
      console.error("  补齐环境：npm ci && npx playwright install chromium；体检：npm run doctor");
      return 2;
    }
    return argv.includes("--record")
      ? await record(server.origin, workDir, sources)
      : await check(server.origin, workDir, sources);
  } finally {
    await server.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

process.exitCode = await main(process.argv.slice(2));
