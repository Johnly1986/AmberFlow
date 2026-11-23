/**
 * verify-app-stop-context —— **非门禁**的 app 层停因回执透出 lane。
 *
 * 验收的事只有一件：`AppRunResult.stop_decision_context` 把引擎的
 * `RunReport.stop_decision_context` **additive** 地透出到 app 层结果，且其它 run 的形状不变。
 *
 * 断言组（零外部网络：页面与决策端点都在本进程的 127.0.0.1 随机端口上）：
 *   ① flow 停因：`ctx.step` 无 act（引擎决策）+ 目标无规则命中 → 本地 mock SystemOne
 *      返回低置信点名 → 动作前停止。result 必须带 `stop_decision_context`：五层闭集
 *      （L0–L4，无重复/无缺层）、每层 status 在 `DecisionLayerReceipt` 闭集内、L0/L1 = sent；
 *      同时 `script.stop_code = low_confidence`（说明停因确实走的是选择段闸门）。
 *   ② 形状回归（flow 正常完成）：模型正常点名并动作、done 成立 → result **不含**该键。
 *   ③ 形状回归（flow 规则步）：authored hint 规则命中、零模型询问 → result **不含**该键，
 *      且本次 run 只有起跑探测请求、没有 choice 询问（证明「没问过模型 = 键不出现」）。
 *   ④ declared 停因：`runApp` 的 journey 步无 target_hint（引擎决策）低置信停 → result 同样
 *      带该键（同一份回执键跨两条运行路径同形）。
 *   ⑤ declared 形状回归：规则命中正常完成 → result **不含**该键。
 *
 * 隔离纪律：临时 `AMBERFLOW_HOME` + 全部产物/轨迹/计划落 `mkdtemp(os.tmpdir())` 下；
 * 不写仓库、不读仓库夹具（HTML 由本工具的本地服务就地提供）。默认跑完删除临时目录，
 * 失败时保留并打印路径作为证据。
 *
 * 用法：node --experimental-strip-types tools/verify-app-stop-context.ts [--keep]
 * 退出码：0 = 全部断言绿；1 = 有断言失败；2 = 用法/环境错误（如 chromium 未安装）。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadScriptApp } from "../src/app/app-script.ts";
import { runScriptApp } from "../src/app/app-runner.ts";
import { runApp } from "../src/app/app-runner-declared.ts";
import type { AppPack } from "../src/app/app-pack.ts";
import { applySpecToRuntime, resolveProviderSpec } from "../src/model/decision-provider.ts";
import type { DecisionLayerReceipt } from "../src/engine/decision-ask-contract.ts";

const USAGE = "usage: node --experimental-strip-types tools/verify-app-stop-context.ts [--keep]";
const PROBE_GOAL = "decision plane probe";
const LAYERS = ["L0", "L1", "L2", "L3", "L4"] as const;
const LAYER_STATUSES = new Set(["sent", "clipped", "unsupported", "absent", "rejected"]);

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const stateOf = (body: Json): Json => (isObj(body["state"]) ? body["state"] : {});
const actOf = (body: Json): Json => {
  const q = body["questions"];
  const a = isObj(q) ? q["act"] : undefined;
  return isObj(a) ? a : {};
};
const criteriaOf = (body: Json): Record<string, string> => {
  const c = actOf(body)["criteria"];
  return isObj(c) ? c as Record<string, string> : {};
};
const isChoiceRequest = (body: Json): boolean => actOf(body)["type"] === "choice" && isObj(body["state"]);
const goalOf = (body: Json): string => String(stateOf(body)["goal"] ?? "");

/* ------------------------------------------------------------------ 断言收集 */

const failures: string[] = [];
let checks = 0;

function ok(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (!cond) failures.push(`${name}${detail === "" ? "" : `: ${detail}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
}

/** 停因回执的五层闭集形状断言（两条运行路径共用）。 */
function assertReceiptShape(tag: string, receipt: { layers: DecisionLayerReceipt[] } | undefined): void {
  ok(`${tag} result.stop_decision_context 存在`, receipt !== undefined, JSON.stringify(receipt));
  const layers = receipt?.layers ?? [];
  eq(`${tag} 五层闭集（L0–L4 各一次）`, layers.map((l) => l.layer), [...LAYERS]);
  ok(`${tag} 每层 status 在闭集内`, layers.every((l) => LAYER_STATUSES.has(l.status)),
    JSON.stringify(layers.map((l) => `${l.layer}:${l.status}`)));
  eq(`${tag} L0 = sent`, layers.find((l) => l.layer === "L0")?.status, "sent");
  eq(`${tag} L1 = sent`, layers.find((l) => l.layer === "L1")?.status, "sent");
  ok(`${tag} chars 是非负数`, layers.every((l) => typeof l.chars === "number" && l.chars >= 0),
    JSON.stringify(layers.map((l) => l.chars)));
}

/** 形状回归：键不出现（additive 纪律；不是 false/空对象顶替）。 */
function assertNoReceipt(tag: string, result: object): void {
  const wire = JSON.parse(JSON.stringify(result)) as Json;
  ok(`${tag} result 不含 stop_decision_context`, !("stop_decision_context" in result),
    JSON.stringify(Object.keys(result)));
  ok(`${tag} 线格式也不含该键`, !("stop_decision_context" in wire), JSON.stringify(Object.keys(wire)));
}

/* ------------------------------------------------------------------ 本地页面 + mock 决策端点 */

const PAGES: Record<string, string> = {
  // 引擎决策步：目标文本与页面标签无词面交集 → 规则面不命中，必须问模型。
  "/pick.html": `<!doctype html><html><head><meta charset="utf-8"><title>pick</title></head><body>
<main><button id="confirm" type="button">Confirm order</button>
<button id="keep" type="button">Keep browsing</button></main></body></html>`,
  // 模型正常点名 → 点击详情链接 → 到达含 #detail-done 的页，done 成立。
  "/open.html": `<!doctype html><html><head><meta charset="utf-8"><title>open</title></head><body>
<main><a id="go" href="/detail-done.html">Open details</a>
<button id="cancel" type="button">Cancel</button></main></body></html>`,
  "/detail-done.html": `<!doctype html><html><head><meta charset="utf-8"><title>detail done</title></head>
<body><main id="detail-done">detail</main></body></html>`,
  // 规则步：authored hint 直接命中 → 零模型询问。
  "/rule.html": `<!doctype html><html><head><meta charset="utf-8"><title>rule</title></head><body>
<main><a id="rule-go" href="/rule-done.html">Continue</a></main></body></html>`,
  "/rule-done.html": `<!doctype html><html><head><meta charset="utf-8"><title>rule done</title></head>
<body><main id="rule-done">done</main></body></html>`,
};

async function startPageServer(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const html = PAGES[pathname];
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html ?? "<!doctype html><html><body>not found</body></html>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("页面服务没有拿到端口");
  return { origin: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => { server.close(() => r()); }) };
}

interface MockDecision {
  origin: string;
  requests: Array<{ path: string; body: Json }>;
  mode: "low-confidence" | "normal";
  close(): Promise<void>;
}

/**
 * mock SystemOne 决策端点（与 `src/model/decision-service.ts` 的线协议同形）：
 *   - 起跑探测（goal = `decision plane probe`）：交白卷（协议可达即通过）；
 *   - 步询问：按 `criteria`（ref → 标签）找目标标签。`normal` = 点名并给高置信（动作会发生），
 *     `low-confidence` = 同样点名但 confidence 0.05 < 缺省 floor 0.25（选择段闸门后动作前停止）。
 */
async function startMockDecision(): Promise<MockDecision> {
  const requests: Array<{ path: string; body: Json }> = [];
  const holder: { mode: "low-confidence" | "normal" } = { mode: "low-confidence" };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += String(d); });
    req.on("end", () => {
      let body: Json = {};
      try { const parsed: unknown = JSON.parse(raw); if (isObj(parsed)) body = parsed; } catch { /* 非 JSON：交白卷 */ }
      requests.push({ path: req.url ?? "", body });
      const goal = goalOf(body);
      const criteria = criteriaOf(body);
      const find = (re: RegExp): string | null =>
        Object.keys(criteria).find((k) => re.test(String(criteria[k]))) ?? null;
      const choice = goal === PROBE_GOAL ? null
        : holder.mode === "normal" ? (find(/open\s*details/i) ?? find(/confirm\s*order/i))
          : find(/confirm\s*order/i);
      const confidence = holder.mode === "low-confidence" ? 0.05 : 0.95;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(choice === null ? {}
        : { answers: { act: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } } } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("mock 决策端点没有拿到端口");
  return {
    origin: `http://127.0.0.1:${addr.port}`, requests,
    get mode(): "low-confidence" | "normal" { return holder.mode; },
    set mode(v: "low-confidence" | "normal") { holder.mode = v; },
    close: () => new Promise<void>((r) => { server.close(() => r()); }),
  };
}

/* ------------------------------------------------------------------ 临时 AMBERFLOW_HOME / app */

function writeFlowApp(home: string, id: string, source: string): string {
  const dir = path.join(home, "apps", id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "app.mjs");
  fs.writeFileSync(file, source, "utf8");
  return file;
}

const FLOW_HEAD = (id: string, goal: string): string => [
  "export const meta = (kit) => ({",
  `  id: ${JSON.stringify(id)}, label: ${JSON.stringify(`stop-context lane · ${id}`)}, goal: ${JSON.stringify(goal)},`,
  '  hosts: ["127.0.0.1"], slots: { entry: "" }, invariants: [],',
  "});",
].join("\n");

/** ① 停因：无 act 的引擎决策步，done 永不成立 → 选择段闸门在动作前停。 */
const FLOW_STOP_APP = `${FLOW_HEAD("sc-stop", "Complete the checkout flow")}
export async function flow(ctx) {
  const arrived = await ctx.arrive(ctx.slots.entry, { id: "arrive", done: ctx.judge.exists("#confirm") });
  if (!arrived.ok) ctx.fail(arrived.stopCode ?? "arrive_failed", arrived.reason);
  const stepped = await ctx.step("Complete the checkout flow", { id: "ask", done: ctx.judge.exists("#never") });
  if (!stepped.ok) ctx.fail(stepped.stopCode ?? "step_failed", stepped.reason);
  await ctx.done();
}
`;

/** ② 正常完成：模型正常点名 → 点击 → done 成立。 */
const FLOW_NORMAL_APP = `${FLOW_HEAD("sc-normal", "Open the details section")}
export async function flow(ctx) {
  const arrived = await ctx.arrive(ctx.slots.entry, { id: "arrive", done: ctx.judge.exists("#go") });
  if (!arrived.ok) ctx.fail(arrived.stopCode ?? "arrive_failed", arrived.reason);
  const stepped = await ctx.step("把页面推进到详情区域", { id: "go-detail", done: ctx.judge.exists("#detail-done") });
  if (!stepped.ok) ctx.fail(stepped.stopCode ?? "step_failed", stepped.reason);
  await ctx.done();
}
`;

/** ③ 规则步：authored hint 命中即动作，零模型询问。 */
const FLOW_RULE_APP = `${FLOW_HEAD("sc-rule", "Click continue")}
export async function flow(ctx) {
  const arrived = await ctx.arrive(ctx.slots.entry, { id: "arrive", done: ctx.judge.exists("#rule-go") });
  if (!arrived.ok) ctx.fail(arrived.stopCode ?? "arrive_failed", arrived.reason);
  const stepped = await ctx.step("Continue", {
    id: "rule-go", act: ctx.hint("#rule-go"), done: ctx.judge.exists("#rule-done"),
  });
  if (!stepped.ok) ctx.fail(stepped.stopCode ?? "step_failed", stepped.reason);
  await ctx.done();
}
`;

/** declared 包：journey 步无 target_hint（引擎决策）；signal 永不成立 → 低置信停。 */
function declaredStopPack(): AppPack {
  return {
    spec_version: 1,
    id: "sc-declared-stop",
    label: "stop-context lane · declared stop",
    goal: "Complete the checkout flow",
    hosts: ["127.0.0.1"],
    slots: { entry: "" },
    journey: [{
      id: "ask", desc: "Complete the checkout flow", start_url: "{entry}",
      signal: { css_exists: "#never" },
    }],
    invariants: [],
  } as unknown as AppPack;
}

/** declared 包：authored target_hint 规则命中 → 正常完成。 */
function declaredRulePack(): AppPack {
  return {
    spec_version: 1,
    id: "sc-declared-rule",
    label: "stop-context lane · declared rule",
    goal: "Click continue",
    hosts: ["127.0.0.1"],
    slots: { entry: "" },
    journey: [{
      id: "rule-go", desc: "Continue", start_url: "{entry}",
      target_hint: "#rule-go", signal: { css_exists: "#rule-done" },
    }],
    invariants: [],
  } as unknown as AppPack;
}

/* ------------------------------------------------------------------ 主流程 */

interface Env {
  origin: string;
  tmp: string;
  home: string;
  apps: Map<string, string>;
}

async function installDecision(mock: MockDecision): Promise<void> {
  process.env.AMBERFLOW_DECISION_BASE_URL = mock.origin;
  process.env.AMBERFLOW_DECISION_MODEL = "capture";
  process.env.AMBERFLOW_DECISION_API_KEY = "dummy";
  applySpecToRuntime(await resolveProviderSpec(undefined, process.env));
}

/** 本次 run 期间的 choice 询问（排除起跑探测）；用于「规则步零询问」证明。 */
function stepAsksSince(env: Env, mock: MockDecision, start: number): Array<{ path: string; body: Json }> {
  return mock.requests.slice(start).filter((r) => {
    if (!isChoiceRequest(r.body)) return false;
    const goal = goalOf(r.body);
    if (goal === PROBE_GOAL) return false;
    const url = String(stateOf(r.body)["url"] ?? "");
    return url.startsWith(env.origin) || goal !== "";
  });
}

async function runGroups(env: Env, mock: MockDecision): Promise<void> {
  /* ① flow 停因 */
  mock.mode = "low-confidence";
  const stopOut = path.join(env.tmp, "out-flow-stop");
  const stopAskStart = mock.requests.length;
  const stopApp = await loadScriptApp(env.apps.get("flow-stop")!);
  const stopResult = await runScriptApp(stopApp, {
    slots: { entry: `${env.origin}/pick.html` },
    outDir: stopOut, runId: "lane-flow-stop", verbose: false,
  });
  const stopWire = JSON.parse(JSON.stringify(stopResult)) as Json;
  const stopReceipt = (stopWire["stop_decision_context"] ?? undefined) as { layers: DecisionLayerReceipt[] } | undefined;
  assertReceiptShape("① flow 停因", stopReceipt);
  eq("① flow 停因 script.stop_code", (stopWire["script"] as Json | undefined)?.["stop_code"], "low_confidence");
  ok("① 停因前确实发生过 choice 询问", stepAsksSince(env, mock, stopAskStart).length > 0,
    `requests=${mock.requests.length - stopAskStart}`);
  ok("① 产物写在临时目录内", path.resolve(stopOut).startsWith(path.resolve(env.tmp)), stopOut);
  console.log(`  ① flow stop_decision_context = ${(stopReceipt?.layers ?? []).map((l) => `${l.layer}:${l.status}`).join(" ")}`);

  /* ② flow 正常完成（模型点名并动作） */
  mock.mode = "normal";
  const normalOut = path.join(env.tmp, "out-flow-normal");
  const normalAskStart = mock.requests.length;
  const normalApp = await loadScriptApp(env.apps.get("flow-normal")!);
  const normalResult = await runScriptApp(normalApp, {
    slots: { entry: `${env.origin}/open.html` },
    outDir: normalOut, runId: "lane-flow-normal", verbose: false,
  });
  ok("② 正常完成 runOk", normalResult.ok === true, JSON.stringify((normalResult as unknown as Json)["script"] ?? null));
  ok("② 正常完成有 choice 询问（证明键缺省不是因为没问模型）",
    stepAsksSince(env, mock, normalAskStart).length > 0);
  assertNoReceipt("② flow 正常完成", normalResult);

  /* ③ flow 规则步（authored hint；零 choice 询问） */
  mock.mode = "normal";
  const ruleOut = path.join(env.tmp, "out-flow-rule");
  const ruleAskStart = mock.requests.length;
  const ruleApp = await loadScriptApp(env.apps.get("flow-rule")!);
  const ruleResult = await runScriptApp(ruleApp, {
    slots: { entry: `${env.origin}/rule.html` },
    outDir: ruleOut, runId: "lane-flow-rule", verbose: false,
  });
  ok("③ 规则步 runOk", ruleResult.ok === true, JSON.stringify((ruleResult as unknown as Json)["script"] ?? null));
  eq("③ 规则步零 choice 询问", stepAsksSince(env, mock, ruleAskStart).length, 0);
  assertNoReceipt("③ flow 规则步", ruleResult);

  /* ④ declared 停因 */
  mock.mode = "low-confidence";
  const dStopOut = path.join(env.tmp, "out-declared-stop");
  const dStopAskStart = mock.requests.length;
  const dStop = await runApp(declaredStopPack(), {
    slots: { entry: `${env.origin}/pick.html` },
    sources: false, outDir: dStopOut, planPath: path.join(env.tmp, "declared-stop-plan.json"),
    runId: "lane-declared-stop", verbose: false, captureTraces: true,
  });
  const dStopWire = JSON.parse(JSON.stringify(dStop)) as Json;
  const dStopReceipt = (dStopWire["stop_decision_context"] ?? undefined) as { layers: DecisionLayerReceipt[] } | undefined;
  assertReceiptShape("④ declared 停因", dStopReceipt);
  ok("④ declared 停因确有 choice 询问", stepAsksSince(env, mock, dStopAskStart).length > 0);
  ok("④ declared 产出在临时目录内", path.resolve(dStopOut).startsWith(path.resolve(env.tmp)), dStopOut);
  console.log(`  ④ declared stop_decision_context = ${(dStopReceipt?.layers ?? []).map((l) => `${l.layer}:${l.status}`).join(" ")}`);

  /* ⑤ declared 规则步正常完成 */
  mock.mode = "normal";
  const dRuleOut = path.join(env.tmp, "out-declared-rule");
  const dRuleAskStart = mock.requests.length;
  const dRule = await runApp(declaredRulePack(), {
    slots: { entry: `${env.origin}/rule.html` },
    sources: false, outDir: dRuleOut, planPath: path.join(env.tmp, "declared-rule-plan.json"),
    runId: "lane-declared-rule", verbose: false, captureTraces: true,
  });
  ok("⑤ declared 规则步 ok", dRule.ok === true, JSON.stringify(dRule.subgoals));
  eq("⑤ declared 规则步零 choice 询问", stepAsksSince(env, mock, dRuleAskStart).length, 0);
  assertNoReceipt("⑤ declared 规则步", dRule);
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); return 0; }
  if (argv.some((a) => !["--keep"].includes(a))) { console.error(USAGE); return 2; }
  const keep = argv.includes("--keep");
  let tmp = "";
  let page: { origin: string; close(): Promise<void> } | null = null;
  let mock: MockDecision | null = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-verify-app-stop-context-"));
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    page = await startPageServer();
    mock = await startMockDecision();
    process.env.AMBERFLOW_HOME = home;
    await installDecision(mock);
    const apps = new Map<string, string>([
      ["flow-stop", writeFlowApp(home, "sc-stop", FLOW_STOP_APP)],
      ["flow-normal", writeFlowApp(home, "sc-normal", FLOW_NORMAL_APP)],
      ["flow-rule", writeFlowApp(home, "sc-rule", FLOW_RULE_APP)],
    ]);
    const env: Env = { origin: page.origin, tmp, home, apps };
    await runGroups(env, mock);
  } catch (e) {
    failures.push(`lane crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  } finally {
    await mock?.close().catch(() => undefined);
    await page?.close().catch(() => undefined);
    if (tmp !== "") {
      if (failures.length === 0 && !keep) {
        fs.rmSync(tmp, { recursive: true, force: true });
      } else {
        console.error(`证据目录（保留）：${tmp}`);
      }
    }
  }
  for (const f of failures) console.error(`verify:app-stop-context FAIL ${f}`);
  if (failures.length > 0) {
    console.error(`verify:app-stop-context: FAIL — ${failures.length} 个断言失败（共 ${checks} 项）`);
    return 1;
  }
  console.log(`verify:app-stop-context: OK — ${checks} 项断言全绿（flow 停因/正常完成/规则步 + declared 停因/规则步；零外部网络）`);
  return 0;
}

if (process.argv[1]?.endsWith("verify-app-stop-context.ts") === true) {
  process.exit(await main(process.argv.slice(2)));
}
