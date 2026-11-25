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
import { weakPicksFrom } from "../src/app/pilot-evidence.ts";
import { projectHandoff } from "../src/app/session-driver.ts";
import type { PilotHandoff } from "../src/app/pilot-contract.ts";
import {
  bindValueFor, countValueTargetId, findPoolRefBySig, slotKeyFor, valueAliasKeyOf,
  valueKeyOf, valueNeedOf, valueSigOf, valueTargetIdOf,
} from "../src/app/pilot-value-need.ts";
import { browserSession } from "../src/engine/executor.ts";
import type { Elem } from "../src/engine/elem-model.ts";

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

/** 最后一次交接的 `why_stuck.evidence`（值需求/落空 hint 等现场事实的断言入口）。 */
function lastHandoffEvidence(events: SinkEvent[]): Record<string, unknown> {
  const handoffs = events.filter((e) => e["type"] === "handoff");
  assert.ok(handoffs.length > 0, "a handoff event exists");
  const handoff = handoffs[handoffs.length - 1]!["handoff"] as Record<string, unknown>;
  return (handoff["why_stuck"] as Record<string, unknown>)["evidence"] as Record<string, unknown>;
}

/** 读出页面元素的值（断言"值真的落在输入框上"，而不只是写进了值袋）。 */
async function pageValue(rt: PilotRuntime, selector: string): Promise<string> {
  const page = await rt.page();
  return await page.evaluate(((sel: string) => (globalThis as unknown as {
    document: { querySelector(s: string): { value: string } | null };
  }).document.querySelector(sel)?.value ?? "") as unknown, selector) as string;
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
    const started = events.find((e) => e["type"] === "started");
    assert.ok(started !== undefined, "started line exists");
    assert.equal("attached" in started!, false, "the non-attach path keeps its old shape (no attached key)");
    await rt.finish(null);
    const end = events.find((e) => e["type"] === "pilot_end");
    assert.ok(end !== undefined, "single terminal line exists");
    assert.equal(end!["ok"], true);
    assert.equal(end!["stop_code"], "final_signal_held");
    assert.equal(end!["model_asks"], 0, "no model ask on the rules path");
    assert.equal(end!["conf_floor"], 0.25, "the terminal summary carries the effective floor scale (default 0.25)");
    assert.equal("attached" in end!, false, "the non-attach summary keeps its old shape (attached only in attach mode)");
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

/**
 * 值绑定（M1）：`needs_value` 交接必须点名「哪个目标/哪个键要值」；裸字符串 resume
 * （无 hint/target）绑定到该键（而不是不可达的 "resumed"）→ 值落地 → 信号成立、零模型。
 */
async function scenarioNeedsValueString(origin: string): Promise<void> {
  const { rt, events } = await boot({
    url: `${origin}/home.html`, goal: "Search term",
    finalSignal: { css_value_equals: ["#q", "amber"] }, maxSteps: 4,
  });
  try {
    assert.equal(await rt.drive(), "needs_value", "fill without a slot stops honestly");
    const ev = lastHandoffEvidence(events);
    const need = ev["needs_value"] as Record<string, unknown> | undefined;
    assert.ok(need !== undefined, "the handoff names which target needs a value");
    assert.equal(need!["key"], "Search term", "the value key is the target label");
    assert.equal(typeof need!["target"], "string", "the value need carries a readable target");
    assert.equal(typeof need!["ref"], "string", "the value need carries the pool ref for evidence");
    const handoff = events.filter((e) => e["type"] === "handoff").pop()!["handoff"] as Record<string, unknown>;
    const unblock = handoff["what_would_unblock"] as string[];
    assert.ok(unblock[0]!.includes('"Search term"'), "the first unblock hint is the exact resume shape");
    // 裸字符串 resume（无 hint/target）：键取 needs_value 记录的目标键（不是 "resumed"）。
    assert.equal(await rt.handleLine('{"cmd":"resume","value":"amber"}'), "drive");
    assert.equal(rt.slots["Search term"], "amber", "a bare string binds to the needs_value target key");
    assert.equal(await rt.drive(), "final_signal_held", "the explicit value + signal check = arrival");
    const drives = drivesOf(events);
    assert.equal(drives.length, 1, "the fill executed once");
    assert.equal(drives[0]!["op"], "fill");
    assert.equal(drives[0]!["ok"], true);
    assert.equal(await pageValue(rt, "#q"), "amber", "the value landed on the real input");
    await rt.finish(null);
    const end = events.find((e) => e["type"] === "pilot_end");
    assert.equal(end!["model_asks"], 0, "the rules path asks no model");
  } finally {
    await rt.closeBrowser();
  }
}

/**
 * 值绑定（M1）：resume 同时带 hint + 字符串值时，值跟着 **hint 目标** 走
 * （旧值需求键也保留，但命中目标的键由 hint 目标推导，不死守旧目标）。
 */
async function scenarioNeedsValueHintTarget(origin: string): Promise<void> {
  const { rt, events } = await boot({
    url: `${origin}/value-targets.html`, goal: "Search term",
    finalSignal: { css_value_equals: ["#note", "amber"] }, maxSteps: 4,
  });
  try {
    assert.equal(await rt.drive(), "needs_value", "the goal's fill target needs a value first");
    assert.equal(rt.valueNeed?.key, "Search term", "the recorded need is the goal's fill target");
    assert.equal(await rt.handleLine('{"cmd":"resume","hint":"#note","value":"amber"}'), "drive");
    assert.equal(await rt.drive(), "final_signal_held", "the hint target takes the value and arrives");
    const drives = drivesOf(events);
    assert.equal(drives.length, 1, "exactly the hint target was filled");
    assert.equal(drives[0]!["op"], "fill");
    assert.equal(await pageValue(rt, "#note"), "amber", "the value followed the hint target");
    assert.equal(await pageValue(rt, "#search"), "", "the original value-needing target was not filled");
  } finally {
    await rt.closeBrowser();
  }
}

/** 诊断（M1）：resume hint 落空 → 下一次交接 evidence 带 `resume_hint.missed`（不再逐字相同）。 */
async function scenarioResumeHintMissed(origin: string): Promise<void> {
  const { rt, events } = await boot({
    url: `${origin}/home.html`, goal: "Search term",
    finalSignal: { css_value_equals: ["#q", "amber"] }, maxSteps: 4,
  });
  try {
    assert.equal(await rt.drive(), "needs_value");
    assert.equal(await rt.handleLine('{"cmd":"resume","hint":"#nope"}'), "drive");
    assert.equal(await rt.drive(), "needs_value", "the missed hint falls back to the same value-needing target");
    const ev = lastHandoffEvidence(events);
    assert.deepEqual(ev["resume_hint"], { hint: "#nope", missed: true },
      "the missed hint is explicit evidence on the next handoff");
    assert.equal((ev["needs_value"] as Record<string, unknown>)["key"], "Search term",
      "the value need is still named alongside the missed hint");
  } finally {
    await rt.closeBrowser();
  }
}

/** 值键推导纯函数：空 label 回落 name/id、空键不参与匹配、签名回找同一目标。 */
async function scenarioValueKeyPure(_origin: string): Promise<void> {
  assert.equal(valueKeyOf({ tag: "input", label: "", name: "q" } as Elem), "q",
    "an empty label falls back to name (never an empty key)");
  assert.equal(valueKeyOf({ tag: "input", label: "", name: "", id: "ucc-1" } as Elem), "ucc-1", "id is the next fallback");
  assert.equal(valueKeyOf({ tag: "input", label: "Search term" } as Elem), "Search term");
  assert.equal(valueKeyOf({ tag: "textarea" } as Elem), "textarea", "tag is the last resort (never empty)");
  assert.equal(slotKeyFor("", { resumed: "x" }), null, "an empty key never matches a slot (includes('') trap closed)");
  assert.equal(slotKeyFor("Search Google Maps", { search: "v" }), "search", "the legacy two-way includes stays");
  assert.equal(slotKeyFor("Note", { "Search term": "v" }), null, "a different key does not match");
  const need = valueNeedOf({ tag: "input", label: "", name: "q", id: "a" } as Elem, "e4");
  assert.equal(need.ref, "e4", "the pool ref is passed through");
  assert.equal(need.key, "q");
  assert.equal(need.sig, valueSigOf({ tag: "input", label: "", name: "q", id: "a" } as Elem), "the need carries its identity signature");
  const pool = {
    e1: { tag: "input", label: "", name: "q", id: "a" } as Elem,
    e2: { tag: "input", label: "", name: "q", id: "b" } as Elem,
  };
  assert.equal(findPoolRefBySig(pool, valueSigOf(pool.e2)), "e2", "the signature identifies the same target across pools");
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
  const { rt } = await boot({
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
    const block = handoff!["handoff"] as Record<string, unknown>;
    assert.equal(block["final_signal"], null, "no declared completion signal = an explicit unverified end-state fact");
    assert.equal("weak_picks" in block, false, "no sub-floor model vote = no weak_picks key (old handoff shape)");
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

/**
 * 结束态可见性纯函数（evidence-only）：`weakPicksFrom` 只收 **model** 票且 `conf < 0.25`
 * （静态默认刻度），有界 ≤6、无票 = undefined（旧交接形状不变）；`conf_floor` 由终态摘要给出。
 * 不判错、不阻断——这里只钉"票面事实怎么筛"，不钉"应不应该回退"（那是调用方的声明信号）。
 */
async function scenarioWeakPicksPure(_origin: string): Promise<void> {
  const picks = weakPicksFrom([
    { step: 1, target: "Rating 4.5+", picked_by: "model", conf: 0.88 },
    { step: 2, target: "Rating 4.0", picked_by: "model", conf: 0.24 },
    { step: 3, target: "Open 24 hours", picked_by: "rule", conf: 0.1 },
  ]);
  assert.deepEqual(picks, [{ step: 2, target: "Rating 4.0", conf: 0.24, picked_by: "model" }],
    "only model votes below the default floor are reported (rules and high-confidence votes never are)");
  assert.equal(weakPicksFrom([]), undefined, "no driving history = no key (old shape unchanged)");
  assert.equal(weakPicksFrom([{ step: 1, target: "x", picked_by: "model", conf: 0.88 }]), undefined,
    "an empty weak set is undefined, not an empty array");
  assert.equal(weakPicksFrom([{ step: 1, target: "x", picked_by: "model", conf: 0.25 }]), undefined,
    "the threshold is strict (< floor): a vote exactly at the floor is not weak");
  const many = Array.from({ length: 9 }, (_, i) => ({
    step: i + 1, target: `t-${String(i)}`, picked_by: "model" as const, conf: 0.1,
  }));
  const bounded = weakPicksFrom(many);
  assert.ok(bounded !== undefined && bounded.length === 6, "weak_picks are bounded to 6");
  assert.equal(bounded[0]!.step, 4, "the most recent weak picks are kept");
  assert.deepEqual(weakPicksFrom([{ step: 1, target: "x", picked_by: "model", conf: 0.3 }], { floor: 0.4 }),
    [{ step: 1, target: "x", conf: 0.3, picked_by: "model" }],
    "an explicit floor overrides the documented default (the default is static 0.25)");
  const long = weakPicksFrom([{ step: 1, target: "x".repeat(200), picked_by: "model", conf: 0.1 }]);
  assert.ok(long !== undefined && long[0]!.target.length <= 40, "the target is bounded like the driving trace");
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
    // 信封显式声明：本场景断言的正是「声明了 hosts 之后跨源 frame 被排除」。
    url: `${hostOrigin}/frame-host.html`, goal: "zerblonix frobnicate", maxSteps: 2, hosts: ["127.0.0.1"],
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

/**
 * attach seam（宿主会话内托管 pilot 的前置缝）：注入会话 + 跳过启动导航 + 不关闭宿主浏览器。
 * 断言三件事：started 带 attached:true 且**没有重新导航**；驾驶跑在注入的同一 page 上并到达
 * final_signal；`closeBrowser()`（ownsSession:false）后宿主 page 仍可 evaluate。
 */
async function scenarioAttachSession(origin: string): Promise<void> {
  const env = laneEnv();
  const session = await browserSession(true);
  try {
    const homeUrl = `${origin}/home.html`;
    await session.page.goto(homeUrl, { waitUntil: "domcontentloaded" });
    // 非附着路径的起步导航唯一入口是 page.goto：计数即「没有重新导航」的直接证据
    // （点击导航由执行器发出，不经过这个方法）。
    const page = session.page;
    const realGoto = page.goto.bind(page);
    let gotoCalls = 0;
    page.goto = async (...args: Parameters<typeof realGoto>) => {
      gotoCalls += 1;
      return await realGoto(...args);
    };

    const events: SinkEvent[] = [];
    const sink: PilotSink = { respond: (obj) => { events.push(obj as SinkEvent); } };
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-verify-pilot-out-"));
    const rt = new PilotRuntime({
      url: homeUrl, goal: "Open the detail page",
      finalSignal: { url_contains: "detail.html" }, maxSteps: 3,
      sessionFactory: async () => session, ownsSession: false, skipStartNavigation: true,
      env, outDir,
    }, sink);
    await rt.start();
    const started = events.find((e) => e["type"] === "started");
    assert.ok(started !== undefined, "attach start emits started");
    assert.equal(started!["ok"], true, "the attached page is inside the hosts envelope");
    assert.equal(started!["attached"], true, "started marks the attach mode");
    assert.equal(started!["url"], homeUrl, "started reports the host page as-is");
    assert.equal(gotoCalls, 0, "attach start must not navigate");
    assert.equal(await rt.page(), page, "pilot drives the injected session page");
    const stop = await rt.drive();
    assert.equal(stop, "final_signal_held", "driving the attached page reaches the declared signal");
    const drives = drivesOf(events);
    assert.equal(drives.length, 1, "one driving step on the host page");
    assert.equal(drives[0]!["picked_by"], "rule", "zero-model rule pick");
    assert.ok(String(drives[0]!["url"]).includes("detail.html"), "the click navigated the host page");
    assert.equal(gotoCalls, 0, "driving uses page controls, never a fresh start navigation");
    await rt.finish(null);
    const end = events.find((e) => e["type"] === "pilot_end");
    assert.ok(end !== undefined, "single terminal line exists");
    assert.equal(end!["attached"], true, "terminal summary carries attached (additive)");
    assert.equal(end!["stop_code"], "final_signal_held");
    await rt.closeBrowser();
    const title = await page.evaluate(
      () => (globalThis as unknown as { document: { title: string } }).document.title,
    );
    assert.ok(typeof title === "string" && title.includes("pilot"), "host page survives rt.closeBrowser()");

    // 信封不合规的附着 = 结构化 config_error（不抛裸栈、不驾驶）；宿主页仍存活。
    const badEvents: SinkEvent[] = [];
    const badRt = new PilotRuntime({
      url: homeUrl, goal: "Open the detail page", hosts: ["not-the-host.invalid"],
      sessionFactory: async () => session, ownsSession: false, skipStartNavigation: true,
      env, outDir,
    }, { respond: (obj) => { badEvents.push(obj as SinkEvent); } });
    await badRt.start();
    const badStarted = badEvents.find((e) => e["type"] === "started");
    assert.ok(badStarted !== undefined, "attach start is always a structured line");
    assert.equal(badStarted!["ok"], false);
    assert.equal(badStarted!["code"], "config_error", "an out-of-envelope attach page is a config error, not a throw");
    assert.equal("attached" in badStarted!, false, "a failed start does not claim the attach mode");
    assert.equal(await badRt.drive(), null, "a config error ends the driving loop before any action");
    assert.equal(gotoCalls, 0, "a failed attach start must not navigate either");
  } finally {
    await session.close();
  }
}

/**
 * 值键漂移纯函数：稳定身份（name/id）跨轮不变 ⇒ 记录值可回放到本轮键；身份变了 ⇒ 不回放（不粘）。
 */
async function scenarioValueDriftPure(_origin: string): Promise<void> {
  const s: Record<string, string> = { "Search term": "amber" };
  const el = { tag: "input", label: "", name: "q", id: "ucc-1" } as Elem;
  // 稳定身份：name 优先于 id（表单提交身份比文档句柄稳）；两者皆空 = 不声称同一控件。
  assert.equal(valueTargetIdOf({ tag: "input", label: "x", name: "q", id: "a" } as Elem), "input\u0000name:q");
  assert.equal(valueTargetIdOf({ tag: "input", label: "x", id: "a" } as Elem), "input\u0000id:a");
  assert.equal(valueTargetIdOf({ tag: "input", label: "x" } as Elem), null,
    "only a tag = no proveable identity (fail-closed: never replay across it)");
  const pool = { e1: el, e2: { tag: "input", label: "", name: "q" } as Elem };
  assert.equal(countValueTargetId(pool, "input\u0000name:q"), 2,
    "two controls with the same name are not distinguishable; the count gates the replay");

  // ① 直接命中：本轮键在值袋里（既有语义，逐字节不变）。
  const direct = bindValueFor({
    slots: { "Search term": "amber" }, el: { tag: "input", label: "Search term", name: "q" } as Elem,
    pool: { e1: { tag: "input", label: "Search term", name: "q" } as Elem }, prev: null,
    need: valueNeedOf({ tag: "input", label: "Search term", name: "q" } as Elem, "e1"),
  });
  assert.equal(direct.kind, "ready");
  assert.equal(direct.value, "amber");
  assert.equal(direct.drift, null, "a direct key hit records no drift fact");

  // ② name/id 精确别名：预声明 `--slots q=…`（表单身份，不是可读标签）命中，不扩建子串语义。
  assert.equal(valueAliasKeyOf(el, { q: "amber" }), "q", "an exact name matches a declared slot key");
  assert.equal(valueAliasKeyOf(el, { note: "amber" }), null, "the alias face is exact-only (no substring)");
  const alias = bindValueFor({
    slots: {}, el, pool: { e1: el }, prev: null, need: valueNeedOf(el, "e1"),
  });
  assert.equal(alias.kind, "needs_value", "an empty bag has no alias to hit");
  assert.equal(valueAliasKeyOf(el, { "ucc-1": "amber" }), "ucc-1", "the id is the second alias candidate");

  // ③ 漂移回放：同一控件本轮键从 label 变 name（label 丢失）⇒ 记录值回放到本轮键。
  const prev = valueNeedOf({ tag: "input", label: "Search term", name: "q" } as Elem, "e1");
  const drift = bindValueFor({ slots: s, el, pool: { e1: el }, prev, need: valueNeedOf(el, "e1") });
  assert.equal(drift.kind, "ready", "the recorded value replays onto the current key");
  assert.equal(drift.value, "amber");
  assert.deepEqual(drift.drift, { from: "Search term", to: "q" }, "the drift fact names both keys (never the value)");
  assert.equal(s["q"], "amber", "the replay writes the current key (the action面 then consumes it)");
  assert.equal(s["Search term"], "amber", "the recorded key is kept (no destructive rewrite)");

  // ④ 身份明确不同 = 不回放（值不跟到另一个控件），只记 stale 事实。
  const other = { tag: "input", label: "Note", name: "note" } as Elem;
  const stale = bindValueFor({
    slots: { "Search term": "amber" }, el: other, pool: { e1: other }, prev, need: valueNeedOf(other, "e1"),
  });
  assert.equal(stale.kind, "needs_value", "a different control never inherits the recorded value");
  assert.deepEqual(stale.stale, { from: "Search term", to: "Note" }, "the stale fact names the keys only");
  assert.equal("note" in s, false, "nothing leaked into the new control's key");

  // ⑤ 同 name 多控件（池内不唯一）= 证明不了「哪个要值」⇒ 不回放。
  const pool2 = { e1: el, e2: { tag: "input", label: "", name: "q", id: "ucc-2" } as Elem };
  const ambiguous = bindValueFor({
    slots: { "Search term": "amber" }, el, pool: pool2, prev, need: valueNeedOf(el, "e1"),
  });
  assert.equal(ambiguous.kind, "needs_value", "a non-unique identity is not enough evidence to replay");

  // ⑥ 本轮键已有值 ⇒ 键命中档直接消费它（回放不覆盖已有值，两条值来源不打架）。
  const existing = bindValueFor({
    slots: { "Search term": "amber", q: "other" }, el, pool: { e1: el }, prev, need: valueNeedOf(el, "e1"),
  });
  assert.equal(existing.kind, "ready", "the key already present in the bag wins (no replay overwrite)");
  assert.equal(existing.value, "other", "the declared value at the current key is used, not the recorded one");
}

/**
 * 值键漂移（真链路）：首轮 `needs_value` 记 label 键 → 裸字符串 resume 值进值袋 → 次轮抽池该输入
 * label 丢失（真实站点上 label 由第三方 UI 状态动态给出/撤销，规则面再也匹配不到它的词面）⇒
 * 只点名目标、**不重发值**，记录值凭 name/id 稳定身份回放到本轮键，值落地且到达。
 */
async function scenarioNeedsValueKeyDrift(origin: string): Promise<void> {
  const { rt, events } = await boot({
    url: `${origin}/home.html`, goal: "Search term",
    finalSignal: { css_value_equals: ["#q", "amber"] }, maxSteps: 6,
  });
  try {
    assert.equal(await rt.drive(), "needs_value", "the first round needs a value");
    const need = lastHandoffEvidence(events)["needs_value"] as Record<string, unknown>;
    assert.equal(need["key"], "Search term", "the first handoff keys the need by the readable label");
    assert.equal(await rt.handleLine('{"cmd":"resume","value":"amber"}'), "drive");
    assert.equal(rt.slots["Search term"], "amber", "a bare string binds to the recorded key");

    // 抽池形状变化：同一 input 的 label 消失（规则面已无法再靠词面匹配它）。
    const page = await rt.page();
    await page.evaluate(((sel: string) => {
      const d = (globalThis as unknown as { document: {
        querySelector(s: string): { removeAttribute(a: string): void } | null } }).document;
      d.querySelector(sel)?.removeAttribute("aria-label");
    }) as unknown, "#q");

    // 次轮：词面命中不了 ⇒ 决策源不可达如实停；交接重开，记录值需求仍在。
    // 次轮：词面已匹配不到该目标 ⇒ 不可能自动到达（停因具体码取决于决策源降级档）。
    const secondStop = await rt.drive();
    assert.notEqual(secondStop, "final_signal_held", "the drifted target is not reached without the recorded value");
    assert.equal(drivesOf(events).length, 0, "nothing executed before the value replay");
    // 只点名目标（hint 不带值）：值只能来自上一轮记录 —— 正是漂移回放要证明的那条路。
    assert.equal(await rt.handleLine('{"cmd":"resume","hint":"#q"}'), "drive");
    assert.equal(await rt.drive(), "final_signal_held", "the recorded value replays onto the drifted key and arrives");
    const drives = drivesOf(events);
    assert.equal(drives.length, 1, "exactly one fill executed (the label-less round executed none)");
    const drift = drives[0]!["value_target_drift"] as Record<string, unknown> | undefined;
    assert.deepEqual(drift, { from: "Search term", to: "q" }, "the drive line carries the drift fact (keys only)");
    assert.equal(await pageValue(rt, "#q"), "amber", "the value landed on the real input");
    assert.equal(rt.slots["q"], "amber", "the replay wrote the current key into the bag");
    assert.equal(rt.valueNeed, null, "the value was consumed (no need left open)");
  } finally {
    await rt.closeBrowser();
  }
}

/**
 * 驾驶面的**导航信封**：动作把页面带出 hosts ⇒ `host_not_allowed`（与 run 面 hostGate 同一判定），
 * 交接块带 `off_envelope` 落地 URL，解锁建议指向 redirect。
 *
 * 造法同 frame 场景：同一台服务器绑两个 host（127.0.0.1 / 127.0.0.2）——信封按 hostname 判，
 * 端口不算跨源。入口在信封内，点一下跳到信封外。
 */
async function scenarioHostEnvelope(origin: string): Promise<void> {
  void origin;
  const away = await startFixtureServer("127.0.0.2");
  const here = http.createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://127.0.0.1").pathname === "/envelope.html") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>envelope</title></head><body>
        <main><a id="escape" href="${away.origin}/home.html">Cross host page</a></main></body></html>`);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => here.listen(0, "127.0.0.1", resolve));
  const hereOrigin = `http://127.0.0.1:${(here.address() as { port: number }).port}`;
  // driver:"agent" = 每步由 Agent 点名（resume 无需先开交接），本场景不花模型票。
  const { rt, events } = await boot({
    url: `${hereOrigin}/envelope.html`, goal: "zerblonix frobnicate", hosts: ["127.0.0.1"], maxSteps: 3,
    driver: "agent",
  });
  try {
    assert.equal(await rt.handleLine(`{"cmd":"resume","hint":"Cross host page"}`), "drive");
    const stop = await rt.drive();
    assert.equal(stop, "host_not_allowed", "walking out of the hosts envelope is a deterministic stop");
    const handoff = events.find((e) => e["type"] === "handoff") as Record<string, unknown> | undefined;
    assert.ok(handoff !== undefined, "handoff projected for the envelope stop");
    const h = handoff!["handoff"] as Record<string, unknown>;
    const ev = (h["why_stuck"] as Record<string, unknown>)["evidence"] as Record<string, unknown>;
    assert.ok(String(ev["off_envelope"] ?? "").startsWith(away.origin), "handoff names the URL that left the envelope");
    assert.ok((h["what_would_unblock"] as string[]).some((w) => w.includes("redirect")), "unblock says redirect back inside");
    // 同一信封内改道 = 不再拦（守卫只对信封外生效）。
    assert.equal(await rt.handleLine(`{"cmd":"redirect","url":"${hereOrigin}/envelope.html"}`), "drive");
    assert.notEqual(await rt.drive(), "host_not_allowed", "back inside the envelope the gate releases");
    await rt.finish(null);
  } finally {
    await rt.closeBrowser();
    await new Promise<void>((resolve) => here.close(() => resolve()));
    await away.close();
  }
}

/**
 * 信封只来自声明（纯构造面）：未声明/null/[]/全空串 = `hosts === null`（不设防），
 * 显式声明原样生效。取消入口 URL 推断后，「未声明」不再悄悄变成「只准待在入口 host」。
 */
async function scenarioHostEnvelopeDefaults(_origin: string): Promise<void> {
  const env = laneEnv();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-verify-pilot-out-"));
  const build = (hosts: string[] | null | undefined): PilotRuntime => new PilotRuntime({
    url: "http://entry.example/home", goal: "g",
    ...(hosts === undefined ? {} : { hosts }), env, outDir,
  }, { respond: () => { /* 纯构造面：不驾驶 */ } });
  for (const [label, hosts, want] of [
    ["omitted", undefined, null],
    ["null", null, null],
    ["empty array", [], null],
    ["blank entries only", ["", "  "], null],
    ["declared", ["a.example"], ["a.example"]],
    ["declared with blanks", ["", "b.example", " "], ["b.example"]],
  ] as Array<[string, string[] | null | undefined, string[] | null]>) {
    assert.deepEqual(build(hosts).hosts, want, `hosts ${label}: envelope comes from the declaration only`);
  }
}

/**
 * 信封优先于完成裁决：起点 302 到信封外，且越界页恰好满足 `finalSignal`。
 * 越界页上的「信号成立」不得被判成完成（否则第三方/SSO 页会冒充 ok:true 收尾）。
 */
async function scenarioEnvelopeBeforeFinalSignal(_origin: string): Promise<void> {
  const away = await startFixtureServer("127.0.0.2");
  const entry = http.createServer((_req, res) => {
    res.statusCode = 302;
    res.setHeader("location", `${away.origin}/home.html`);
    res.end();
  });
  await new Promise<void>((resolve) => entry.listen(0, "127.0.0.1", resolve));
  const entryOrigin = `http://127.0.0.1:${(entry.address() as { port: number }).port}`;
  // 越界页（away/home.html）上 #detail-link 存在 ⇒ 信号在信封外也成立：完成裁决不得抢在信封之前。
  const { rt, events } = await boot({
    url: `${entryOrigin}/start.html`, goal: "zerblonix frobnicate", hosts: ["127.0.0.1"],
    finalSignal: { css_exists: "#detail-link" }, maxSteps: 3, driver: "agent",
  });
  try {
    assert.equal(await rt.drive(), "host_not_allowed", "an off-envelope page never satisfies the final signal");
    const handoff = events.find((e) => e["type"] === "handoff") as Record<string, unknown> | undefined;
    assert.ok(handoff !== undefined, "handoff projected for the envelope stop");
    const h = handoff!["handoff"] as Record<string, unknown>;
    assert.equal(h["stop_code"], "host_not_allowed", "handoff stop code is the envelope one");
    assert.equal(h["step_id"], 0, "the stop happens before any driving step (no pool, no vote)");
    assert.equal(drivesOf(events).length, 0, "zero actions were executed on the off-envelope page");
    assert.ok(String(h["url"]).startsWith(away.origin), "handoff anchors the landing page that left the envelope");

    // finish 也必须在同一判定下被拒：交接保持打开，改道回信封内才能收尾。
    assert.equal(await rt.handleLine('{"cmd":"finish","signal":{"css_exists":"#detail-link"}}'), "stay");
    const rejected = events.filter((e) => e["type"] === "command_result").pop();
    assert.ok(rejected !== undefined, "finish got a single-line receipt");
    assert.equal(rejected!["ok"], false, "finish off the envelope is rejected");
    assert.equal(rejected!["code"], "host_not_allowed", "the rejection reuses the existing code");
    assert.equal(rt.done, false, "a rejected finish does not end the driving loop");
    assert.equal(rt.stoppedAt, "host_not_allowed", "the stop code is unchanged");
    assert.notEqual(rt.handoffOpen, null, "the handoff stays open for redirect/resume");
    await rt.finish(null);
    const end = events.find((e) => e["type"] === "pilot_end");
    assert.equal(end!["ok"], false, "wrapping up does not claim success");
    assert.equal(end!["stop_code"], "host_not_allowed");
  } finally {
    await rt.closeBrowser();
    await new Promise<void>((resolve) => entry.close(() => resolve()));
    await away.close();
  }
}

/**
 * attach 在 `about:blank` 起步：未声明 hosts = 不设防，宿主随后导航到真实页仍可驾驶。
 * 推断入口 hostname 时 `about:blank` 会造出 `[""]` 信封——那会把一切 http(s) 页判成越界。
 */
async function scenarioAttachAboutBlank(origin: string): Promise<void> {
  const env = laneEnv();
  const session = await browserSession(true);
  const events: SinkEvent[] = [];
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-verify-pilot-out-"));
  const rt = new PilotRuntime({
    url: "about:blank", goal: "zerblonix frobnicate", maxSteps: 2, driver: "agent",
    sessionFactory: async () => session, ownsSession: false, skipStartNavigation: true, env, outDir,
  }, { respond: (obj) => { events.push(obj as SinkEvent); } });
  try {
    await rt.start();
    assert.equal(rt.hosts, null, "an about:blank entry declares no envelope");
    const started = events.find((e) => e["type"] === "started");
    assert.equal(started!["ok"], true, "attaching on about:blank is a normal start");
    assert.equal(started!["attached"], true, "started marks the attach mode");
    // 宿主把页导航到真实站点：未声明信封 ⇒ 不拦（入口 hostname 推断出的空串信封会每轮拦下）。
    await session.page.goto(`${origin}/home.html`, { waitUntil: "domcontentloaded" });
    const stop = await rt.drive();
    assert.notEqual(stop, "host_not_allowed", "no envelope was declared, so nothing is out of it");
    assert.equal(stop, "await_pick", "driving continues on the real page");
    await rt.finish(null);
  } finally {
    await rt.closeBrowser();
    await session.close();
  }
}

/**
 * P0-1：改道即换语境必须包括 **未消费的 resume 点名**。
 *
 * 序列：点击走出信封 → 停 `host_not_allowed` → 越界页上 Agent 发 `resume{hint}`（守卫在
 * hint 消费之前命中，hint 留在队列）→ `redirect` 到信封内、且含该 hint 目标的新页 →
 * 再驾驶一步。改道后的新页**不得**执行旧语境点名：`resumeHint` 必须已被 `redirectReset`
 * 清空，因此新页只走正常驾驶（agent 档 = 投影候选等点名），不会出现那一步点击。
 */
async function scenarioRedirectDropsResumeHint(origin: string): Promise<void> {
  void origin;
  const away = await startFixtureServer("127.0.0.2");
  const here = http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const html = p === "/envelope.html"
      ? `<!doctype html><html><head><meta charset="utf-8"><title>envelope</title></head><body>
        <main><a id="escape" href="${away.origin}/home.html">Cross host page</a></main></body></html>`
      : p === "/restart.html"
        ? `<!doctype html><html><head><meta charset="utf-8"><title>restart</title></head><body>
          <button id="restart" onclick="document.body.dataset.clicked='1'">Restart account</button></body></html>`
        : null;
    if (html === null) { res.statusCode = 404; res.end("not found"); return; }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  });
  await new Promise<void>((resolve) => here.listen(0, "127.0.0.1", resolve));
  const hereOrigin = `http://127.0.0.1:${(here.address() as { port: number }).port}`;
  const { rt, events } = await boot({
    url: `${hereOrigin}/envelope.html`, goal: "zerblonix frobnicate", hosts: ["127.0.0.1"], maxSteps: 8,
    driver: "agent",
  });
  try {
    // ① 走出信封：步尾停 host_not_allowed。
    assert.equal(await rt.handleLine('{"cmd":"resume","hint":"Cross host page"}'), "drive");
    assert.equal(await rt.drive(), "host_not_allowed", "the click walks out of the envelope");
    // ② 越界页上再点名：轮首信封守卫先命中，hint 进队列但本轮不会被消费。
    assert.equal(await rt.handleLine('{"cmd":"resume","hint":"Restart account"}'), "drive");
    assert.equal(await rt.drive(), "host_not_allowed", "the envelope guard still stops before consuming the hint");
    assert.equal(rt.resumeHint, "Restart account", "the queued hint is still pending before the redirect");
    const before = drivesOf(events).length;
    // ③ 改道到信封内、且确实含该 hint 目标的新页：旧语境的点名必须失效。
    assert.equal(await rt.handleLine(`{"cmd":"redirect","url":"${hereOrigin}/restart.html"}`), "drive");
    assert.equal(rt.resumeHint, null, "redirect drops the stale resume point (the new page is a different context)");
    const stop = await rt.drive();
    assert.equal(stop, "await_pick", "the new page drives normally instead of executing the stale hint");
    const after = drivesOf(events).slice(before);
    assert.equal(after.length, 0, "no action was executed on the new page");
    const clickedFlag = await (await rt.page()).evaluate(
      () => (globalThis as unknown as { document: { body: { dataset: Record<string, string | undefined> } } })
        .document.body.dataset["clicked"] ?? "",
    ) as string;
    assert.equal(clickedFlag, "", "the stale hint's target was never clicked on the new page");
    await rt.finish(null);
  } finally {
    await rt.closeBrowser();
    await new Promise<void>((resolve) => here.close(() => resolve()));
    await away.close();
  }
}

/**
 * 导航失败 ≠ 越界：点击一个指向不可达站点的链接后，浏览器落在 `chrome-error://chromewebdata/`。
 * 该页 URL 的 host 是 `chromewebdata`，拿它判 hosts 信封会谎报 `host_not_allowed`。
 *
 * 断言两件事：① 连接类原文（`ERR_NAME_NOT_RESOLVED`）= `unreachable`、端口被拒原文
 * （`ERR_UNSAFE_PORT`）= `config_error`，两者的交接证据 `nav_error` 都带**浏览器原文**；
 * ② 同一 hosts 信封下真正跨 host 的链接仍是 `host_not_allowed`（正常语义不变）。
 */
async function scenarioNavFailureNotEnvelope(origin: string): Promise<void> {
  void origin;
  const away = await startFixtureServer("127.0.0.2");
  const here = http.createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/nav-error.html") {
      res.statusCode = 404; res.end("not found"); return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>nav error</title></head><body>
      <main>
        <a id="dns" href="http://nope-af.invalid/">Dns fail target</a>
        <a id="port" href="http://127.0.0.1:1/">Unsafe port target</a>
        <a id="cross" href="${away.origin}/home.html">Cross host target</a>
      </main></body></html>`);
  });
  await new Promise<void>((resolve) => here.listen(0, "127.0.0.1", resolve));
  const hereOrigin = `http://127.0.0.1:${(here.address() as { port: number }).port}`;
  const { rt, events } = await boot({
    url: `${hereOrigin}/nav-error.html`, goal: "zerblonix frobnicate", hosts: ["127.0.0.1"], maxSteps: 8,
    driver: "agent",
  });
  const lastEvidence = (): Record<string, unknown> => {
    const handoff = events.filter((e) => e["type"] === "handoff").pop();
    assert.ok(handoff !== undefined, "a handoff was projected");
    const block = handoff!["handoff"] as Record<string, unknown>;
    return ((block["why_stuck"] as Record<string, unknown>)["evidence"] ?? {}) as Record<string, unknown>;
  };
  const lastStop = (): string => {
    const block = (events.filter((e) => e["type"] === "handoff").pop() as Record<string, unknown>)["handoff"];
    return String((block as Record<string, unknown>)["stop_code"]);
  };
  try {
    // ① DNS 失败：原文 = net::ERR_NAME_NOT_RESOLVED ⇒ unreachable，且不是越界。
    assert.equal(await rt.handleLine('{"cmd":"resume","hint":"Dns fail target"}'), "drive");
    assert.equal(await rt.drive(), "unreachable", "a DNS failure is unreachable, not an envelope escape");
    assert.notEqual(lastStop(), "host_not_allowed", "the error page URL is never reported as an out-of-envelope host");
    const dnsEvidence = lastEvidence();
    assert.ok(String(dnsEvidence["nav_error"] ?? "").includes("net::ERR_NAME_NOT_RESOLVED"),
      "the handoff keeps the browser's original net::ERR_* text");
    // ② 端口被浏览器拒绝：ERR_UNSAFE_PORT 不是「网络不可达」——改端口，不是重试。
    assert.equal(await rt.handleLine(`{"cmd":"redirect","url":"${hereOrigin}/nav-error.html"}`), "drive");
    assert.equal(await rt.handleLine('{"cmd":"resume","hint":"Unsafe port target"}'), "drive");
    assert.equal(await rt.drive(), "config_error", "a browser-refused port is a config error, not unreachable");
    const portEvidence = lastEvidence();
    assert.ok(String(portEvidence["nav_error"] ?? "").includes("net::ERR_UNSAFE_PORT"),
      "the handoff keeps the port rejection text");
    // ③ 反证：同一信封下真正跨 host 的跳转仍是 host_not_allowed（正常语义没被放宽）。
    assert.equal(await rt.handleLine(`{"cmd":"redirect","url":"${hereOrigin}/nav-error.html"}`), "drive");
    assert.equal(await rt.handleLine('{"cmd":"resume","hint":"Cross host target"}'), "drive");
    assert.equal(await rt.drive(), "host_not_allowed", "a real cross-host navigation stays an envelope stop");
    assert.ok(String(lastEvidence()["off_envelope"] ?? "").startsWith(away.origin),
      "the envelope stop still names the landing URL that left the envelope");
    await rt.finish(null);
  } finally {
    await rt.closeBrowser();
    await new Promise<void>((resolve) => here.close(() => resolve()));
    await away.close();
  }
}

/**
 * 交接 evidence 超限退化清单（纯函数，可失败）：**保现场**优先于原插入序。
 *
 * `off_envelope` 在 evidence 里恰是第 9 个键；纯按插入序截前 8 键会把「是哪一步走出信封」这条
 * 真实停驶现场切掉（40 条 forbidden + 6 个 excluded frame 的真实量级 = 900+ 字符）。
 */
async function scenarioEvidenceKeysPriority(_origin: string): Promise<void> {
  const project = (evidence: Record<string, unknown>): Record<string, unknown> => {
    const handoff: PilotHandoff = {
      stop_code: "host_not_allowed", step_id: 1, goal_digest: "g",
      why_stuck: { summary: "s", evidence }, what_would_unblock: [], evidence_refs: {}, url: "u",
    };
    return (((projectHandoff(handoff)["why_stuck"] as Record<string, unknown>)["evidence"]) ?? {}) as Record<string, unknown>;
  };
  const longText = "x".repeat(1200);
  // ① 真实停驶现场量级：9 键、off_envelope 第 9 —— 退化清单必须含它。
  const realScene = project({
    inert_run: 3, forbidden: Array.from({ length: 40 }, (_, i) => `e${String(i)}`),
    ledger: [{ key: "k", tries: 3, last_outcome: longText }],
    loop_stop: { desc: longText, tries: 3 },
    frames_excluded: Array.from({ length: 6 }, (_, i) => ({ origin: `http://f${String(i)}.test`, index: i })),
    expect_url: "/maps", needs_value: { target: longText, key: "k", ref: "e1" },
    resume_hint: { hint: longText, missed: true }, off_envelope: "http://away.invalid/x",
  });
  assert.equal(realScene["truncated"], true, "an oversized evidence block degrades to a key list");
  const realKeys = realScene["keys"] as string[];
  for (const key of ["off_envelope", "expect_url", "needs_value", "resume_hint"]) {
    assert.ok(realKeys.includes(key), `the locator key ${key} survives truncation`);
  }
  assert.ok(realKeys.length <= 8, "the degraded key list stays bounded to 8");
  // ② 10 键、off_envelope 末尾：仍 ≤8 且保它（定位键优先于插入序）。
  const tail = project(Object.fromEntries([
    ...Array.from({ length: 9 }, (_, i) => [`k${String(i)}`, longText] as const),
    ["off_envelope", "http://away.invalid/x"] as const,
  ]));
  const tailKeys = tail["keys"] as string[];
  assert.equal(tailKeys.length, 8, "a 10-key block degrades to exactly 8");
  assert.ok(tailKeys.includes("off_envelope"), "off_envelope at the tail is still kept");
  // ③ 未超限：投影逐字节等于原 evidence，且不出现 truncated。
  const small = { inert_run: 0, forbidden: ["a"], off_envelope: "http://away.invalid/x" };
  assert.deepEqual(project(small), small, "an in-budget evidence block is projected byte-identically");
}

const SCENARIOS: Array<[string, (origin: string) => Promise<void>]> = [
  ["arrival(rules 零模型到达)", scenarioArrival],
  ["needs_value→resume 值+点名", scenarioNeedsValue],
  ["needs_value→裸字符串值绑定目标键", scenarioNeedsValueString],
  ["needs_value→hint+值跟随 hint 目标", scenarioNeedsValueHintTarget],
  ["hint 落空→下次交接 missed 证据", scenarioResumeHintMissed],
  ["值键推导纯函数（空 label/空键/签名）", scenarioValueKeyPure],
  ["值键漂移纯函数（稳定身份/别名/回放/不粘）", scenarioValueDriftPure],
  ["值键漂移：label 丢失后裸字符串值仍落地", scenarioNeedsValueKeyDrift],
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
  ["结束态可见性：weak_picks 筛选 + conf_floor", scenarioWeakPicksPure],
  ["交接 evidence 超限保现场（off_envelope 不被切）", scenarioEvidenceKeysPriority],
  ["任务页漂移→off_task_page", scenarioOffTaskPage],
  ["信封只来自声明：未声明/空串=不设防", scenarioHostEnvelopeDefaults],
  ["导航信封：走出 hosts→host_not_allowed", scenarioHostEnvelope],
  ["改道丢弃旧 resume 点名（不在新页执行）", scenarioRedirectDropsResumeHint],
  ["导航失败≠越界（unreachable/config_error 带原文）", scenarioNavFailureNotEnvelope],
  ["信封优先于完成裁决：越界页信号成立≠完成", scenarioEnvelopeBeforeFinalSignal],
  ["attach：about:blank 起步不造空串信封", scenarioAttachAboutBlank],
  ["frame 排除→显式证据+加入 hosts 建议", scenarioFrameExcluded],
  ["attach：注入会话+跳过导航+不关宿主", scenarioAttachSession],
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
