/**
 * verify-runtime-offline —— **非门禁**的运行期等价 lane：本地静态夹具 + 无头 chromium + `BrowserMiddleware.run`。
 *
 * 定位（为什么不进 `npm run check`）：本 lane 需要 chromium，而 PR 门禁是纯离线、不启浏览器；
 * 它只在本地/运行期重构前后跑，用来回答"同一条真实执行循环在夹具上的 **运行期事实** 有没有变"。
 * 与 `tools/verify-offline.ts` 的分工：那一层只观察页面/元素池/hint 事实（不执行 run），
 * 这一层真正跑执行器循环（导航 → 抽池 → 规则/声明解析 → 动作 → done/停因 → 报告）。
 * 真正的完成裁决仍在 `amber run` / `online/` 套件；本工具不调模型、不联网
 * （只连 127.0.0.1 上自己起的静态服务，外部请求数必须恒为 0）。
 *
 * 场景纪律（确定性优先）：
 *   - 每个场景一个**全新无头会话**（不共享会话级限速/计数状态），浏览器侧只读夹具页；
 *   - 引擎强制规则面：`installLayaRuntime(null)` + `installDecisionProvider(null)` ⇒ `rules-only`，
 *     没有任何模型调用；目标由声明 hint / 命令闭集决定，解析路径不依赖模型；
 *   - 覆盖成功 / 结构化停因 / 遮挡失败证据 / precondition 跳过四条路径；
 *   - `overlay` 场景先导航并确定性等待遮罩出现，再 `skipNavigation` 跑 run()，避免与 2.5s
 *     定时器赛跑；其余场景由 run() 自己导航。
 *
 * 记录口径（只记稳定事实，跨运行可重复）：
 *   - status：`done` / `skipped` / `stop_code` / `stop_step` / `stop_reason`（URL 归一 `<LOCAL>`；
 *     `stop_reason` 是引擎稳定文案，按原样入库）；
 *   - step 序列：`how` / `op` / `desc` / `executed` / `skipped` / `skip_reason` / `method` /
 *     `decision_kind` / `target` / `changed` / `url` / `actionability`（遮挡证据：reason/blocker/
 *     requery/是否有 bbox）；位置性 `ref` **不入库**（池编号随窗口/分桶时序漂移，不是行为契约）；
 *   - 动作账：`executed_actions`（op/target/how/changed）与 `skipped_actions`（reason/command_id/
 *     target + 从 detail 解析出的 blocker/requery/bbox 事实）；
 *   - 状态记录：`state.before/after` 的 epoch/navEpoch/url/readyState + actions 计数 + flags
 *     （结构/内容指纹与 settleMs/耗时/timing 类字段**不入库**，它们在桶边界/字体度量上会抖）；
 *   - 诊断：`diagnostics.pool_size` / `diagnostics.target`（限速警告随会话历史抖动，不入库）；
 *   - `external_requests` 必须是 `[]`（本 lane 的不联网自证，随 golden 一起入库）。
 *
 * 归一化：`http://127.0.0.1:<随机端口>` → `<LOCAL>`；对象键递归排序后比对；同场景在
 * `--record` 时**连跑两次**，两次归一化结果一致才允许写 golden（不稳定 = 退出码 1，不入库）。
 *
 * 用法：
 *   node --experimental-strip-types tools/verify-runtime-offline.ts            # 比对（默认 --check）
 *   node --experimental-strip-types tools/verify-runtime-offline.ts --check    # 显式
 *   node --experimental-strip-types tools/verify-runtime-offline.ts --record   # 写基线 tools/golden/runtime/**
 *   node --experimental-strip-types tools/verify-runtime-offline.ts --list
 * 退出码：0 绿 / 1 红（观测不一致、外部请求非 0、--record 两次不一致）/ 2 用法或环境错误（如 chromium 缺失）。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { browserSession } from "../src/engine/executor.ts";
import { buildMiddleware } from "../src/app/middleware-factory.ts";
import { installLayaRuntime } from "../src/model/model.ts";
import { installDecisionProvider } from "../src/model/decision-provider.ts";
import type { MiddlewareOptions } from "../src/engine/executor-middleware-types.ts";
import type { RunReport } from "../src/engine/executor-types.ts";
import type { BrowserMiddleware } from "../src/engine/executor.ts";
import type { AnyPage } from "../src/engine/executor-types.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(REPO, "fixtures", "engine");
const GOLDEN_DIR = path.join(REPO, "tools", "golden", "runtime");
const USAGE = "usage: node --experimental-strip-types tools/verify-runtime-offline.ts [--check | --record | --list]";
const GOLDEN_DOC =
  "verify-runtime-offline 基线（非门禁）：本地 fixtures + 无头 chromium + BrowserMiddleware.run 的运行期事实。"
  + "只用于运行期重构前后的等价对比：--record 显式更新（同场景连跑两次一致才入库）；端口已归一为 <LOCAL>；"
  + "位置性 ref / 耗时 / timing 类字段不入库，不得手改。";
const SCHEMA_VERSION = 1;
const REQUIRED_FIXTURES = 4;

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

/* ------------------------------------------------------------------ 等待工具 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询浏览器侧真值直到成立（确定性等待，不靠固定 sleep 猜时机）。 */
async function waitTrue(page: AnyPage, expression: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(`等待超时：${expression.slice(0, 120)}`);
}

/* ------------------------------------------------------------------ 归一化 */

const LOCAL_RE = /http:\/\/127\.0\.0\.1:\d+/g;

/** 递归归一：端口地址 → `<LOCAL>`；对象键排序（同内容 = 同字节）。 */
function normalize(value: unknown): unknown {
  if (typeof value === "string") return value.replace(LOCAL_RE, "<LOCAL>");
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

/* ------------------------------------------------------------------ 运行期投影 */

type Dict = Record<string, unknown>;

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Dict)[key] : undefined;
}

function nullable(value: unknown): unknown {
  return value === undefined ? null : value;
}

/** 从 `skipped_actions[].detail`（`bbox=x,y WxH; blocker=…; requery=…`）抽取稳定事实。 */
function skippedDetailFacts(detail: unknown): Dict | null {
  if (typeof detail !== "string") return null;
  const blocker = /blocker=([^;]+)/.exec(detail);
  const requery = /requery=([^;]+)/.exec(detail);
  return {
    has_bbox: detail.startsWith("bbox="),
    blocker: blocker === null ? null : blocker[1]!.trim(),
    requery: requery === null ? null : requery[1]!.trim(),
  };
}

/** 单个 trace 步的投影：动作路径 + 失败证据；位置性 ref 不入库。 */
function projectStep(step: unknown): Dict {
  const actionability = field(step, "actionability");
  return {
    step: field(step, "step"),
    desc: nullable(field(step, "desc")),
    how: nullable(field(step, "how")),
    op: nullable(field(step, "op")),
    target: nullable(field(step, "target")),
    executed: nullable(field(step, "executed")),
    skipped: nullable(field(step, "skipped")),
    skip_reason: nullable(field(step, "skip_reason")),
    method: nullable(field(step, "method")),
    decision_kind: nullable(field(step, "decision_kind")),
    changed: nullable(field(step, "changed")),
    url: nullable(field(step, "url")),
    ...(actionability === undefined
      ? {}
      : {
        actionability: {
          reason: nullable(field(actionability, "reason")),
          blocker: nullable(field(actionability, "blocker")),
          requery: nullable(field(actionability, "requery")),
          has_bbox: field(actionability, "bbox") !== null && field(actionability, "bbox") !== undefined,
        },
      }),
  };
}

/** 状态记录的投影：只留构造事实（指纹/耗时类字段会因桶边界与时机抖动）。 */
function projectState(state: unknown): Dict | null {
  if (state === undefined || state === null) return null;
  const before = field(state, "before");
  const after = field(state, "after");
  const side = (value: unknown): Dict | null => value === undefined || value === null ? null : {
    epoch: nullable(field(value, "epoch")),
    navEpoch: nullable(field(value, "navEpoch")),
    url: nullable(field(value, "url")),
    readyState: nullable(field(value, "readyState")),
  };
  return {
    before: side(before),
    after: side(after),
    actions: nullable(field(state, "actions")),
    flags: nullable(field(state, "flags")),
  };
}

/** 整份 RunReport 的稳定投影（lane 的唯一记录口径）。 */
function projectRunReport(report: RunReport): Dict {
  const steps = (report.steps ?? []).map(projectStep);
  const executedActions = (report.executed_actions ?? []).map((action) => ({
    op: nullable(field(action, "op")),
    target: nullable(field(action, "target")),
    how: nullable(field(action, "how")),
    changed: nullable(field(action, "changed")),
  }));
  const skippedActions = (report.skipped_actions ?? []).map((action) => ({
    reason: nullable(field(action, "reason")),
    command_id: nullable(field(action, "command_id")),
    target: nullable(field(action, "target")),
    detail: skippedDetailFacts(field(action, "detail")),
  }));
  const diagnostics = report.diagnostics === undefined ? null : {
    pool_size: nullable(field(report.diagnostics, "pool_size")),
    target: nullable(field(report.diagnostics, "target")),
  };
  return {
    goal: report.goal,
    done: report.done === true,
    skipped: report.skipped === true,
    stop_code: nullable(report.stop_code),
    stop_step: nullable(report.stop_step),
    stop_reason: report.stop_reason,
    steps,
    executed: nullable(report.executed),
    executed_actions: executedActions,
    skipped_actions: skippedActions,
    diagnostics,
    audit_verdict: nullable(field(report.audit, "verdict")),
    state: projectState(report.state),
  };
}

/* ------------------------------------------------------------------ 场景 */

interface ScenarioContext {
  mw: BrowserMiddleware;
  page: AnyPage;
  origin: string;
}

interface Scenario {
  name: string;
  run(ctx: ScenarioContext): Promise<RunReport>;
}

/** 成功路径：`#filter_item_airline` 由规则面命中 → 点击 → `window.__hits` 记账 → done 信号成立。 */
const GOAL_AIRLINE_CLICKED =
  `(() => (Array.isArray(window.__hits) ? window.__hits : []).includes("filter_item_airline"))()`;

/** 遮挡出现判据（`overlay.html` 的 2.5s 定时器把 `#modal-overlay` 去掉 hidden）。 */
const OVERLAY_VISIBLE =
  `(() => { const el = document.getElementById("modal-overlay"); return !!el && !el.hidden; })()`;

const SCENARIOS: Scenario[] = [
  {
    name: "success-filter-bar",
    run: async ({ mw, page, origin }) => await mw.run("点击航空公司筛选", `${origin}/filter-bar.html`, {
      targetHint: "#filter_item_airline",
      goalSignalFn: async (p) => Boolean(await p.evaluate(GOAL_AIRLINE_CLICKED)),
      page,
      verbose: false,
    }),
  },
  {
    // 停因路径：命令闭集点名一个池里不存在的目标 ⇒ 规则面结构化 stop（不回落模型、不猜）。
    name: "stop-missing-target",
    run: async ({ mw, page, origin }) => await mw.run("点击一个不存在的目标", `${origin}/ambiguity-order.html`, {
      commands: [{ id: "c1", op: "click", target: "#not-exist" }],
      goalSignalFn: async () => false,
      page,
      verbose: false,
    }),
  },
  {
    // 遮挡失败证据：先确定性等到遮罩可见，再在同页跑 run（skipNavigation），
    // 点击被遮目标 ⇒ not-actionable-or-covered + blocker/requery 证据（不消散、不自动关遮罩）。
    name: "overlay-occluded",
    run: async ({ mw, page, origin }) => {
      const url = `${origin}/overlay.html`;
      await page.goto(url, { waitUntil: "load", timeout: 15_000 });
      await waitTrue(page, OVERLAY_VISIBLE);
      return await mw.run("点击确认提交", url, {
        targetHint: "#under-btn",
        goalSignalFn: async () => false,
        page,
        skipNavigation: true,
        verbose: false,
      });
    },
  },
  {
    // 跳过路径：when/precondition 不成立 ⇒ done + skipped（零动作、零模型调用）。
    name: "precondition-skip",
    run: async ({ mw, page, origin }) => await mw.run("这一步不适用", `${origin}/filter-bar.html`, {
      precondition: { css_exists: "#nope" },
      goalSignalFn: async () => false,
      page,
      verbose: false,
    }),
  },
];

/* ------------------------------------------------------------------ 观测 */

interface ScenarioObservation {
  expected: Dict;
  external: string[];
}

/** 跑一个场景：全新会话 + 规则面执行器 + 外部请求记账；返回归一化预期值。 */
async function observeScenario(scenario: Scenario, origin: string): Promise<ScenarioObservation> {
  // 强制规则面：无 LayaRuntime / 无显式 provider ⇒ rules-only，零模型调用（确定性前提）。
  installLayaRuntime(null);
  installDecisionProvider(null);
  const session = await browserSession(true);
  const page = session.page;
  const external: string[] = [];
  const withOn = page as unknown as { on(event: string, cb: (req: { url(): string }) => void): void };
  withOn.on("request", (req) => {
    const url = req.url();
    if (url.startsWith(origin) || url.startsWith("data:") || url === "about:blank") return;
    external.push(url);
  });
  // 构造面唯一落点是工厂（源码里禁止 new BrowserMiddleware）；face/confirmPolicy 显式声明。
  const options: Omit<MiddlewareOptions, "confirmFn"> = {
    hosts: ["127.0.0.1"],
    maxSteps: 1,
    gotoTimeout: 15_000,
  };
  const mw = buildMiddleware({ face: "online", confirmPolicy: { kind: "allow-all" }, options });
  try {
    const report = await scenario.run({ mw, page, origin });
    return { expected: projectRunReport(report), external: [...external].sort() };
  } finally {
    await session.close();
  }
}

/* ------------------------------------------------------------------ golden I/O */

function goldenPath(name: string): string {
  return path.join(GOLDEN_DIR, `${name}.json`);
}

function goldenOf(scenario: Scenario, expected: Dict, external: string[]): Dict {
  return {
    _doc: GOLDEN_DOC,
    schema_version: SCHEMA_VERSION,
    scenario: scenario.name,
    expected: { ...expected, external_requests: external },
  };
}

/** 记录全部 golden：每个场景连跑两次，归一化结果一致才写；先清掉不属于当前场景集的旧文件。 */
async function record(origin: string): Promise<number> {
  if (!fs.existsSync(GOLDEN_DIR)) fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  let unstable = 0;
  for (const scenario of SCENARIOS) {
    const first = await observeScenario(scenario, origin);
    const second = await observeScenario(scenario, origin);
    const firstText = stableStringify(first);
    const secondText = stableStringify(second);
    if (firstText !== secondText) {
      unstable += 1;
      console.error(`verify-runtime-offline: ${scenario.name} 两次运行不一致，拒绝入库（先让场景确定性化）`);
      const a = firstText.split("\n");
      const b = secondText.split("\n");
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] === b[i]) continue;
        console.error(`    首个差异第 ${i + 1} 行\n        第一次: ${a[i] ?? "<无>"}\n        第二次: ${b[i] ?? "<无>"}`);
        break;
      }
      continue;
    }
    fs.writeFileSync(goldenPath(scenario.name), stableStringify(goldenOf(scenario, first.expected, first.external)), "utf8");
    console.log(`verify-runtime-offline: 记录 ${scenario.name}（两次一致；外部请求 ${first.external.length}）`);
  }
  const keep = new Set(SCENARIOS.map((s) => `${s.name}.json`));
  for (const file of fs.readdirSync(GOLDEN_DIR)) {
    if (file.endsWith(".json") && !keep.has(file)) {
      fs.rmSync(path.join(GOLDEN_DIR, file));
      console.log(`verify-runtime-offline: 删除过期 golden ${file}`);
    }
  }
  if (unstable > 0) {
    console.error(`verify-runtime-offline: FAIL — ${unstable} 个场景不稳定，未入库`);
    return 1;
  }
  console.log(`verify-runtime-offline: 已记录 ${SCENARIOS.length} 个场景基线 → tools/golden/runtime/`);
  return 0;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

/** 比对全部 golden；返回问题列表（空 = 绿）。 */
async function check(origin: string): Promise<number> {
  if (!fs.existsSync(GOLDEN_DIR)) {
    console.error("verify-runtime-offline: 缺少 tools/golden/runtime/ 基线——运行 --record 生成（非门禁 lane，基线需入库）");
    return 1;
  }
  const expectedFiles = new Set(SCENARIOS.map((s) => `${s.name}.json`));
  for (const file of fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json")).sort()) {
    if (!expectedFiles.has(file)) console.error(`verify-runtime-offline: 过期 golden：${file}（场景已不存在；--record 会清理）`);
  }
  const problems: string[] = [];
  for (const scenario of SCENARIOS) {
    const file = goldenPath(scenario.name);
    if (!fs.existsSync(file)) {
      problems.push(`缺少 golden：${path.relative(REPO, file)}（--record 生成）`);
      continue;
    }
    let golden: unknown;
    try {
      golden = readJson(file);
    } catch (err) {
      problems.push(`${scenario.name}: golden JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const observation = await observeScenario(scenario, origin);
    if (observation.external.length > 0) {
      problems.push(`${scenario.name}: 外部请求必须为 0（本 lane 不联网），实际：${JSON.stringify(observation.external)}`);
    }
    const actualText = stableStringify({ ...observation.expected, external_requests: observation.external });
    const expectedText = stableStringify(field(golden, "expected"));
    if (actualText === expectedText) continue;
    const expLines = expectedText.split("\n");
    const actLines = actualText.split("\n");
    for (let i = 0; i < Math.max(expLines.length, actLines.length); i++) {
      if (expLines[i] === actLines[i]) continue;
      problems.push(`${scenario.name}: 运行期观测与 golden 不一致（首个差异第 ${i + 1} 行）\n    golden: ${expLines[i] ?? "<无>"}\n    实际:   ${actLines[i] ?? "<无>"}`);
      break;
    }
  }
  for (const problem of problems) console.error(`verify-runtime-offline: ${problem}`);
  if (problems.length > 0) {
    console.error(`verify-runtime-offline: FAIL — ${problems.length} 个问题；运行期行为变化时先确认是预期变更，再 --record 更新基线`);
    return 1;
  }
  console.log(`verify-runtime-offline: OK — ${SCENARIOS.length} 个场景的运行期事实与 golden 一致（无外部请求，未调模型）`);
  return 0;
}

function list(): number {
  if (!fs.existsSync(GOLDEN_DIR)) {
    console.log("verify-runtime-offline: 没有 golden 目录（先 --record）");
    return 0;
  }
  const files = fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json")).sort();
  console.log(`verify-runtime-offline: 场景 ${SCENARIOS.map((s) => s.name).join(" / ")}；golden ${files.length} 个`);
  return 0;
}

/* ------------------------------------------------------------------ 主流程 */

async function main(argv: string[]): Promise<number> {
  const known = new Set(["--check", "--record", "--list"]);
  for (const arg of argv) {
    if (!known.has(arg)) {
      console.error(`verify-runtime-offline: 未知参数 ${JSON.stringify(arg)}`);
      console.error(USAGE);
      return 2;
    }
  }
  if (argv.includes("--list")) return list();
  if (!fs.existsSync(FIXTURES)) {
    console.error(`verify-runtime-offline: 夹具目录不存在：${path.relative(REPO, FIXTURES)}`);
    return 2;
  }
  const htmlCount = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".html")).length;
  if (htmlCount < REQUIRED_FIXTURES) {
    console.error(`verify-runtime-offline: fixtures/engine 只有 ${htmlCount} 个 .html（基线要求 ${REQUIRED_FIXTURES} 个）`);
    return 2;
  }
  const server = await startFixtureServer(FIXTURES);
  try {
    // 先探一次无头会话：chromium 缺失属于环境问题（退出码 2），不是等价性变红。
    try {
      const probe = await browserSession(true);
      await probe.close();
    } catch (err) {
      console.error(`verify-runtime-offline: 启动无头 chromium 失败：${err instanceof Error ? err.message : String(err)}`);
      console.error("  补齐环境：npm ci && npx playwright install chromium；体检：npm run doctor");
      return 2;
    }
    return argv.includes("--record") ? await record(server.origin) : await check(server.origin);
  } finally {
    await server.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
