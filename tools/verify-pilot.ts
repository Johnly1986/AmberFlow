/**
 * verify-pilot —— **§3.2 走查验收矩阵 lane**（PILOTED_WALKTHROUGH_PLAN §3.2；非门禁）。
 *
 * 定位：本地静态夹具（fixtures/engine/pilot/）+ 无头 chromium + `PilotRuntime` 直驱，
 * 逐条断言 §3.2 的验收项——① rules 面零模型到达最终信号；② 每类停因各触发一次交接并
 * `resume` 成功（needs_value / stuck_inert / target_ambiguous / budget_exceeded）；③ 危险
 * 动作 default-deny 且兜底指令闭集里没有 confirm 可越过；④ 终态摘要不丢停因；⑤ 决策源
 * 不可达时如实停 `no_model_runtime`。非 TTY/idle 的 CLI 退出码语义由冒烟面覆盖（本 lane
 * 直驱运行时，不起 CLI 进程）。
 *
 * 场景纪律（确定性优先，与 verify-runtime-offline 同源）：
 *   - 每个场景一个**全新 PilotRuntime**（新 outDir / 新 AMBERFLOW_HOME），浏览器侧只连
 *     127.0.0.1 自起静态服务，外部请求数恒为 0；
 *   - 决策源统一指向不可达的 127.0.0.1:1（在线 provider 档、零模型加载）：rules 命中的
 *     场景不花模型票；规则落空的场景走 degrade 探针 → `no_model_runtime` 如实停——
 *     不依赖本机 laya 工件，任何机器上可复跑；
 *   - 断言直判（pass/fail），无 golden 基线：本 lane 是验收矩阵，不是等价对比面。
 *
 * 用法：npm run verify:pilot
 * 退出码：0 全过 / 1 任一场景红 / 2 环境错误（chromium 缺失等）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PilotRuntime, type PilotSink } from "../src/app/pilot-runtime.ts";
import { drivingGoalText, unblockHintsFor, type PilotOptions } from "../src/app/pilot-contract.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(REPO, "fixtures", "engine", "pilot");
const UNREACHABLE_PROVIDER = "http://127.0.0.1:1";

interface SinkEvent extends Record<string, unknown> { type?: string }

/* ------------------------------------------------------------------ 静态服务 */

/** 只服务 `fixtures/engine/pilot/` 下 .html 的本地服务（随机端口；默认绑定 127.0.0.1，
 *  frame 场景用 127.0.0.2 造**不同 host** 的跨源帧——信封按 hostname 判，端口不算跨源）。 */
async function startFixtureServer(bindHost = "127.0.0.1"): Promise<{ origin: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    const abs = path.resolve(FIXTURES, `.${rel}`);
    const inside = abs === FIXTURES || abs.startsWith(`${FIXTURES}${path.sep}`);
    if (!inside || !fs.existsSync(abs) || !fs.statSync(abs).isFile() || !abs.endsWith(".html")) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(fs.readFileSync(abs));
  });
  await new Promise<void>((resolve) => server.listen(0, bindHost, resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://${bindHost}:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e === undefined ? resolve() : reject(e)))),
  };
}

/* ------------------------------------------------------------------ 场景基建 */

/**
 * 决策源统一不可达：在线 provider 档零模型加载；rules 命中场景不花票，落空场景走降级。
 * 注意 `resolveProviderSpec` 读的是**进程 env**（CLI 面即 process.env）——lane 在进程内直驱
 * 运行时，所以这里直接改 process.env，`opts.env` 只承载 AMBERFLOW_HOME 落点。
 */
function laneEnv(): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "af-verify-pilot-home-"));
  Object.assign(process.env, {
    AMBERFLOW_HOME: home,
    AMBERFLOW_DECISION_BASE_URL: UNREACHABLE_PROVIDER,
    AMBERFLOW_DECISION_API_KEY: "unused-lane-key",
    AMBERFLOW_DECISION_MODEL: "unused-lane-model",
  });
  return process.env;
}

interface Booted {
  rt: PilotRuntime;
  events: SinkEvent[];
}

async function boot(opts: Omit<PilotOptions, "env" | "outDir">): Promise<Booted> {
  const events: SinkEvent[] = [];
  const sink: PilotSink = { respond: (obj) => { events.push(obj as SinkEvent); } };
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-verify-pilot-out-"));
  const rt = new PilotRuntime({ ...opts, env: laneEnv(), outDir }, sink);
  await rt.start();
  return { rt, events };
}

function drivesOf(events: SinkEvent[]): SinkEvent[] {
  return events.filter((e) => e["type"] === "drive");
}

/* ------------------------------------------------------------------ 场景表 */

/** §3.2①：rules 面零模型到达——goal 词面命中、声明信号成立、零咨询。 */
async function scenarioArrival(origin: string): Promise<void> {
  const { rt, events } = await boot({
    url: `${origin}/home.html`, goal: "Open the detail page",
    finalSignal: { css_exists: "#detail" }, maxSteps: 4,
  });
  try {
    const stop = await rt.drive();
    assert.equal(stop, "final_signal_held", "rules hit must reach the declared signal");
    assert.equal(rt.done, true);
    const drives = drivesOf(events);
    assert.equal(drives.length, 1, "one driving step");
    assert.equal(drives[0]["picked_by"], "rule", "zero-model rule pick");
    assert.equal(drives[0]["ok"], true);
    assert.ok(String(drives[0]["url"]).includes("detail.html"), "navigation happened");
    await rt.finish(null);
    const end = events.find((e) => e["type"] === "pilot_end");
    assert.ok(end !== undefined, "single terminal line exists");
    assert.equal(end!["ok"], true);
    assert.equal(end!["stop_code"], "final_signal_held");
    assert.equal(end!["model_asks"], 0, "no model ask on the rules path");
  } finally {
    await rt.closeBrowser();
  }
}

/** §3.2② needs_value：缺值如实停 → resume{value{k:v}, hint} 显式给值 → 信号成立。 */
async function scenarioNeedsValue(origin: string): Promise<void> {
  const { rt, events } = await boot({
    url: `${origin}/home.html`, goal: "Search term",
    finalSignal: { css_value_equals: ["#q", "amber"] }, maxSteps: 4,
  });
  try {
    const stop = await rt.drive();
    assert.equal(stop, "needs_value", "fill without a slot must stop honestly");
    const outcome = await rt.handleLine('{"cmd":"resume","hint":"#q","value":{"Search term":"amber"}}');
    assert.equal(outcome, "drive", "resume with explicit value re-enters driving");
    const stop2 = await rt.drive();
    assert.equal(stop2, "final_signal_held", "explicit value + signal check = arrival");
    const drives = drivesOf(events);
    assert.equal(drives.length, 1, "the fill executed once");
    assert.equal(drives[0]["op"], "fill");
    assert.equal(drives[0]["ok"], true);
  } finally {
    await rt.closeBrowser();
  }
}

/** §3.2② stuck_inert：连续无变化如实停 → resume{hint} 点名换目标 → 到达。 */
async function scenarioStuckInert(origin: string): Promise<void> {
  const { rt, events } = await boot({
    url: `${origin}/home.html`, goal: "Dead end",
    finalSignal: { css_exists: "#detail" }, maxSteps: 6,
  });
  try {
    const stop = await rt.drive();
    assert.equal(stop, "stuck_inert", "three no-change clicks must stop honestly");
    const drives = drivesOf(events);
    assert.equal(drives.length, 3, "inert threshold is 3");
    assert.ok(drives.every((d) => d["changed"] === false), "every inert click changed nothing");
    const outcome = await rt.handleLine('{"cmd":"resume","hint":"#detail-link"}');
    assert.equal(outcome, "drive");
    const stop2 = await rt.drive();
    assert.equal(stop2, "final_signal_held", "resume hint re-targets and arrives");
  } finally {
    await rt.closeBrowser();
  }
}

/**
 * §3.2② target_ambiguous：同 label 双候选（跨区域进池）——resume{hint:"Same label"} 走
 * actOnce 词面解析即歧义、只停不选；再 resume{hint:"#detail-link"} 收窄到达。
 */
/** 嵌套同目标折叠：卡片容器与其内部链接同 label——resume 点名命中两候选，折叠取后代执行
 *  （不判 target_ambiguous）并到达 detail；兄弟重复组（header/footer）仍只停不选。
 */
/** 同卡片兄弟同 label（Maps 结果卡同构）：覆盖链接（aria-label）与标题 div 互不包含、
 *  共享 role=article 卡片——共同交互祖先 + 组内唯一 native 判据折叠到链接执行。
 */
async function scenarioRowUnitFold(origin: string): Promise<void> {
  const { rt } = await boot({
    url: `${origin}/row-unit-card.html`, goal: "zerblonix frobnicate",
    finalSignal: { css_exists: "#detail" }, maxSteps: 4,
  });
  try {
    const stop = await rt.drive();
    assert.equal(stop, "low_confidence", "unreachable decision source stops honestly first");
    const outcome = await rt.handleLine('{"cmd":"resume","hint":"提交申请"}');
    assert.equal(outcome, "drive");
    const stop2 = await rt.drive();
    assert.equal(stop2, "final_signal_held", "same-card siblings fold to the native control and arrive");
  } finally {
    await rt.closeBrowser();
  }
}

/** P0 守卫·死目标：goal 词面 = 按钮名（"Hours"），点击只开关面板（每步 changed=true、URL 不变）。
 *  规则档命中一次即入账本，第二轮起不再复读（降级档无模型 ⇒ 1 步后 low_confidence 交接），
 *  此前同形态会连续复读烧满 8 步预算（budget_exceeded）。
 */
/** 族推导回归：textarea（fill 族）缺值必须落 needs_value；若被动作前闸门按 click 判
 *  unsupported，它会被永久禁选、退化成 low_confidence——两种结果可区分。
 */
async function scenarioFillFamily(origin: string): Promise<void> {
  const { rt, events } = await boot({
    url: `${origin}/fill-family.html`, goal: "备注", maxSteps: 4,
  });
  try {
    const stop = await rt.drive();
    assert.equal(stop, "needs_value", "fill 族元素要值，不是被闸门拒");
    const handoff = events.filter((e) => e["type"] === "handoff").pop() as Record<string, unknown> | undefined;
    const ev = ((handoff?.["handoff"] as Record<string, unknown> | undefined)
      ?.["why_stuck"] as Record<string, unknown> | undefined)?.["evidence"] as Record<string, unknown> | undefined;
    const ledger = (ev?.["ledger"] ?? []) as Array<Record<string, unknown>>;
    const rejected = ledger.filter((e) => String(e["last_outcome"]).startsWith("unsupported"));
    assert.equal(rejected.length, 0, "fill 族不得被动作前闸门判 unsupported");
  } finally {
    await rt.closeBrowser();
  }
}

/** 准确率闸门·被覆盖目标：goal 词面命中被第三方覆盖层的按钮——动作前快速拒绝（不执行、
 *  不耗步、不烧 5.8s 遮挡探针），账本记 unhittable:covered 后规则档跳过；降级档无模型 ⇒
 *  low_confidence 交接，**零执行步**（此前同形态每次选中都计 1 步并烧满慢探针）。
 */
async function scenarioPickRejected(origin: string): Promise<void> {
  const { rt, events } = await boot({
    url: `${origin}/covered-target.html`, goal: "确认筛选", maxSteps: 8,
  });
  try {
    const stop = await rt.drive();
    assert.equal(stop, "low_confidence", "degraded face stops honestly after the pick is rejected");
    assert.equal(drivesOf(events).length, 0, "no step is spent on an unhittable pick");
    const handoff = events.filter((e) => e["type"] === "handoff").pop() as Record<string, unknown> | undefined;
    const ev = ((handoff?.["handoff"] as Record<string, unknown> | undefined)
      ?.["why_stuck"] as Record<string, unknown> | undefined)?.["evidence"] as Record<string, unknown> | undefined;
    const ledger = (ev?.["ledger"] ?? []) as Array<Record<string, unknown>>;
    assert.equal(ledger.length, 1, "the rejection is recorded in the single-source ledger");
    assert.ok(String(ledger[0]!["last_outcome"]).startsWith("unhittable"), "outcome names the cover relation");
  } finally {
    await rt.closeBrowser();
  }
}

async function scenarioToggleLoop(origin: string): Promise<void> {
  const { rt, events } = await boot({
    url: `${origin}/toggle-loop.html`, goal: "Hours", maxSteps: 8,
  });
  try {
    const stop = await rt.drive();
    assert.equal(stop, "low_confidence", "rules must not re-pick a ledgered element; the degraded face stops honestly");
    const drives = drivesOf(events);
    assert.equal(drives.length, 1, "the toggle button is executed exactly once (no budget-burning loop)");
    assert.equal(drives[0]["picked_by"], "rule");
    const handoff = events.filter((e) => e["type"] === "handoff").pop() as Record<string, unknown> | undefined;
    const block = (handoff?.["handoff"] as Record<string, unknown> | undefined)?.["why_stuck"] as Record<string, unknown> | undefined;
    const ev = (block?.["evidence"] ?? {}) as Record<string, unknown>;
    const ledger = (ev["ledger"] ?? []) as Array<Record<string, unknown>>;
    assert.equal(ledger.length, 1, "the handoff carries the single-source ledger");
    assert.equal(ledger[0]!["tries"], 1, "the ledger counts the executed attempt");
    assert.ok(String(ledger[0]!["last_outcome"]).startsWith("changed"), "the outcome records a state change (toggle)");
  } finally {
    await rt.closeBrowser();
  }
}

async function scenarioNestedFold(origin: string): Promise<void> {
  const { rt } = await boot({
    url: `${origin}/nested-card.html`, goal: "zerblonix frobnicate",
    finalSignal: { css_exists: "#detail" }, maxSteps: 4,
  });
  try {
    const stop = await rt.drive();
    assert.equal(stop, "low_confidence", "unreachable decision source stops honestly first");
    const outcome = await rt.handleLine('{"cmd":"resume","hint":"确认订单"}');
    assert.equal(outcome, "drive");
    const stop2 = await rt.drive();
    assert.equal(stop2, "final_signal_held", "nested same-label candidates fold to the descendant and arrive");
  } finally {
    await rt.closeBrowser();
  }
}

async function scenarioAmbiguous(origin: string): Promise<void> {
  const { rt, events } = await boot({
    url: `${origin}/home.html`, goal: "Same label",
    finalSignal: { css_exists: "#detail" }, maxSteps: 6,
  });
  try {
    await rt.drive();   // 首轮停因随规则档行为（命中歧义或低置信），不做口径假设
    const outcome = await rt.handleLine('{"cmd":"resume","hint":"Same label"}');
    assert.equal(outcome, "drive");
    const stop2 = await rt.drive();
    assert.equal(stop2, "target_ambiguous", "a same-label hint must stop on ambiguity, not guess");
    const narrowed = await rt.handleLine('{"cmd":"resume","hint":"#detail-link"}');
    assert.equal(narrowed, "drive");
    const stop3 = await rt.drive();
    assert.equal(stop3, "final_signal_held", "narrowed hint arrives");
  } finally {
    await rt.closeBrowser();
  }
}

/** §3.2② budget_exceeded：预算用尽如实停，终态摘要不丢停因（P2-1 面）。 */
async function scenarioBudget(origin: string): Promise<void> {
  const { rt, events } = await boot({
    url: `${origin}/home.html`, goal: "Dead end", maxSteps: 1,
  });
  try {
    const stop = await rt.drive();
    assert.equal(stop, "budget_exceeded", "one step of budget, one honest handoff");
    const handoff = events.find((e) => e["type"] === "handoff");
    assert.ok(handoff !== undefined, "handoff projected before waiting");
    // 预算用尽 = 终态：续驾驶指令（resume/redirect）一律结构化拒绝，不再重试。
    const refused = await rt.handleLine('{"cmd":"resume","hint":"#detail-link"}');
    assert.equal(refused, "stay", "budget_exhausted is terminal: resume is refused");
    const rejected = events.filter((e) => e["type"] === "command_result" && e["code"] === "budget_exhausted");
    assert.equal(rejected.length, 1, "the refusal is a structured command_result");
    assert.equal(await rt.drive(), "budget_exceeded", "driving stays terminal after the budget");
    await rt.finish(null);
    const end = events.find((e) => e["type"] === "pilot_end");
    assert.ok(end !== undefined);
    assert.equal(end!["stop_code"], "budget_exceeded", "terminal summary keeps the stop cause");
    assert.equal(end!["ok"], false);
  } finally {
    await rt.closeBrowser();
  }
}

/**
 * §3.2③ 危险动作：default-deny 拒绝且不可越过——点击被拒（无导航）、连续拒 = inert 停，
 * 兜底指令闭集里不存在 confirm（未知指令 = 单行失败）。
 */
async function scenarioDangerous(origin: string): Promise<void> {
  const { rt, events } = await boot({
    url: `${origin}/home.html`, goal: "删除全部数据", maxSteps: 6,
  });
  try {
    const stop = await rt.drive();
    const drives = drivesOf(events);
    assert.ok(drives.length >= 1, "the risky target was attempted");
    assert.ok(drives.every((d) => String(d["url"]).includes("home.html")), "no navigation: the deny held");
    assert.ok(drives.every((d) => d["ok"] !== true), "every risky click was refused");
    assert.equal(stop, "stuck_inert", "repeated refusals end in the honest inert stop");
    // 闭集里没有 confirm：Agent 无指令可越过 default-deny（未知指令 = 单行失败继续等）。
    const outcome = await rt.handleLine('{"cmd":"confirm","target":"删除全部数据"}');
    assert.equal(outcome, "stay", "no confirm command exists in the closed set");
    const rejected = events.filter((e) => e["type"] === "error");
    assert.ok(rejected.length >= 1, "the unknown command got a structured rejection");
  } finally {
    await rt.closeBrowser();
  }
}

/**
 * §3.2⑤ 决策源不可达：首次咨询失败如实 low_confidence（failed_asks 记账 + 降级），
 * 复驶后 ready 判死面 → no_model_runtime 如实停，不假装驾驶。
 */
async function scenarioNoModel(origin: string): Promise<void> {
  const { rt, events } = await boot({
    url: `${origin}/home.html`, goal: "zerblonix frobnicate", maxSteps: 4,
  });
  try {
    const stop = await rt.drive();
    assert.equal(stop, "low_confidence", "the unreachable ask degrades into an honest low-confidence handoff");
    const outcome = await rt.handleLine('{"cmd":"resume"}');
    assert.equal(outcome, "drive");
    const stop2 = await rt.drive();
    assert.equal(stop2, "no_model_runtime", "the degraded face must report no model, not fake driving");
    const handoffs = events.filter((e) => e["type"] === "handoff");
    assert.ok(handoffs.length >= 2, "both stops projected handoffs");
    const last = handoffs[handoffs.length - 1] as Record<string, unknown>;
    const block = (last["handoff"] as Record<string, unknown>)["what_would_unblock"] as string[];
    assert.ok(block.some((w) => w.includes("amber doctor") || w.includes("hint")), "unblock hints point at the real cause");
    await rt.finish(null);
    const end = events.find((e) => e["type"] === "pilot_end");
    assert.ok(end !== undefined);
    assert.equal(end!["stop_code"], "no_model_runtime");
  } finally {
    await rt.closeBrowser();
  }
}

/* ------------------------------------------------------------------ main */

/** 驾驶上文（floor 根因实验的前提）：步史必须是"已执行 + outcome"，当前页/期望页可读，
 *  frame 排除是第一条解锁建议。 */
async function scenarioContextText(_origin: string): Promise<void> {
  const plain = drivingGoalText("打开详情", [], "https://a.test/list", "");
  assert.equal(plain, "打开详情 | 当前页: https://a.test/list");
  const text = drivingGoalText("打开详情", [
    { target: "Filter", ok: true, changed: false },
    { target: "Row", ok: true, changed: true },
    { target: "Boom", ok: false, changed: false },
  ], "https://a.test/list", "/list");
  assert.ok(text.includes("期望页: /list"), "expected page joins the driving question");
  assert.ok(text.includes("1.Filter[no_change]"), "a no-op click must not read as progress");
  assert.ok(text.includes("2.Row[changed]"), "changed outcome is recorded");
  assert.ok(text.includes("3.Boom[failed]"), "failed outcome is recorded");
  assert.ok(text.includes("已执行:"), "wording is executed, not completed");
  const hints = unblockHintsFor("low_confidence", { framesExcluded: ["https://ogs.google.com"] });
  assert.ok(hints.length <= 3 && hints[0]!.includes("https://ogs.google.com"), "frame exclusion is the first unblock hint");
  const budgetHints = unblockHintsFor("budget_exceeded", { framesExcluded: ["https://ogs.google.com"] });
  assert.ok(!budgetHints[0]!.includes("iframe"), "a budget terminal must not lead with a frame hint (it misleads)");
}

/** 任务页漂移：--expect-url 不含当前 URL → 确定性 off_task_page；redirect 回任务页即恢复。 */
async function scenarioOffTaskPage(origin: string): Promise<void> {
  const { rt, events } = await boot({
    url: `${origin}/home.html`, goal: "zerblonix frobnicate", expectUrl: "/home.html", maxSteps: 3,
  });
  try {
    // 同 host 改道到非任务页（信封允许，但任务页约束不允许）。
    assert.equal(await rt.handleLine(`{"cmd":"redirect","url":"${origin}/detail.html"}`), "drive");
    const stop = await rt.drive();
    assert.equal(stop, "off_task_page", "URL drift is a deterministic stop");
    const handoff = events.find((e) => e["type"] === "handoff") as Record<string, unknown> | undefined;
    assert.ok(handoff !== undefined, "handoff projected for the drift stop");
    const h = handoff!["handoff"] as Record<string, unknown>;
    assert.equal(h["stop_code"], "off_task_page");
    const ev = (h["why_stuck"] as Record<string, unknown>)["evidence"] as Record<string, unknown>;
    assert.equal(ev["expect_url"], "/home.html", "handoff carries the declared task page");
    assert.ok((h["what_would_unblock"] as string[]).some((w) => w.includes("redirect")), "unblock says redirect back");
    // redirect 回任务页 = 守卫放行（不再 off_task_page）。
    assert.equal(await rt.handleLine(`{"cmd":"redirect","url":"${origin}/home.html"}`), "drive");
    const next = await rt.drive();
    assert.notEqual(next, "off_task_page", "back on the task page the guard releases");
    await rt.finish(null);
  } finally {
    await rt.closeBrowser();
  }
}

/** frame 准入显式信号：被 hosts 信封排除的跨源 iframe → handoff 证据 + "加入 hosts" 建议。 */
async function scenarioFrameExcluded(origin: string): Promise<void> {
  const child = await startFixtureServer("127.0.0.2");
  const host = http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (p === "/frame-host.html") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html><body><iframe src="${child.origin}/home.html" width="400" height="300"></iframe></body></html>`);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  const hostOrigin = `http://127.0.0.1:${(host.address() as { port: number }).port}`;
  void origin;
  const { rt, events } = await boot({
    url: `${hostOrigin}/frame-host.html`, goal: "zerblonix frobnicate", maxSteps: 2,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 800));   // 等跨源 iframe 载入
    const stop = await rt.drive();
    assert.equal(stop, "low_confidence", "no model candidate inside the excluded frame ⇒ honest stop");
    const handoff = events.find((e) => e["type"] === "handoff") as Record<string, unknown> | undefined;
    assert.ok(handoff !== undefined, "handoff projected");
    const h = handoff!["handoff"] as Record<string, unknown>;
    const ev = (h["why_stuck"] as Record<string, unknown>)["evidence"] as Record<string, unknown>;
    const frames = ev["frames_excluded"] as Array<{ origin?: string }> | undefined;
    assert.ok(Array.isArray(frames) && frames.some((f) => f.origin === child.origin), "excluded frame origin is explicit evidence");
    assert.ok((h["what_would_unblock"] as string[]).some((w) => w.includes("hosts") && w.includes(child.origin)),
      "unblock names the origin to add to hosts");
    await rt.finish(null);
  } finally {
    await rt.closeBrowser();
    await new Promise<void>((resolve) => host.close(() => resolve()));
    await child.close();
  }
}

const SCENARIOS: Array<[string, (origin: string) => Promise<void>]> = [
  ["arrival(rules 零模型到达)", scenarioArrival],
  ["needs_value→resume 值+点名", scenarioNeedsValue],
  ["stuck_inert→resume 换目标", scenarioStuckInert],
  ["target_ambiguous→resume 收窄", scenarioAmbiguous],
  ["嵌套同目标折叠（容器vs链接）", scenarioNestedFold],
  ["同卡片兄弟同 label 折叠", scenarioRowUnitFold],
  ["P0 守卫：死目标不复读不烧预算", scenarioToggleLoop],
  ["准确率：被覆盖选中不耗步", scenarioPickRejected],
  ["族推导：fill 族不被永久拒", scenarioFillFamily],
  ["budget_exceeded 终态保停因", scenarioBudget],
  ["危险 default-deny 不可越过", scenarioDangerous],
  ["决策源不可达 no_model_runtime", scenarioNoModel],
  ["驾驶上文：已执行+outcome/当前页/期望页", scenarioContextText],
  ["任务页漂移→off_task_page", scenarioOffTaskPage],
  ["frame 排除→显式证据+加入 hosts 建议", scenarioFrameExcluded],
];

async function main(): Promise<number> {
  const server = await startFixtureServer();
  const failures: string[] = [];
  try {
    for (const [name, run] of SCENARIOS) {
      try {
        await run(server.origin);
        console.log(`verify:pilot PASS ${name}`);
      } catch (e) {
        failures.push(name);
        console.error(`verify:pilot FAIL ${name}: ${(e as Error).message}`);
      }
    }
  } finally {
    await server.close();
  }
  if (failures.length > 0) {
    console.error(`verify:pilot: ${failures.length}/${String(SCENARIOS.length)} 场景未过（${failures.join("、")}）`);
    return 1;
  }
  console.log(`verify:pilot: §3.2 验收矩阵 ${SCENARIOS.length}/${SCENARIOS.length} 场景全过`);
  return 0;
}

process.exit(await main());
