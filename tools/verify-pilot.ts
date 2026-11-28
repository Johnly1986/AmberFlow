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
import {
  LOW_CONFIDENCE_KINDS, PILOT_STOP_CODES, drivingGoalText, unblockHintsFor,
  type ObservationFacts, type PilotHandoff, type PilotOptions,
} from "../src/app/pilot-contract.ts";
import {
  handoffWhyEvidence, lowConfidenceKindOf, observationFactsOf, stopFactsOf, topHandoffFacts, topLocatorFacts, topStopFacts,
  weakPicksFrom, whyStuckSummary, HANDOFF_FACT_TEXT_MAX,
} from "../src/app/pilot-evidence.ts";
import { BROWSER_STATE_IDS, BROWSER_TREE, askViewOf, identityLabelOf } from "../src/app/pilot-tree.ts";
import { TREE_EXIT, validateTree, walkTree, type DecisionTree, type StateOutcome } from "../src/engine/decision-tree.ts";
import { DEFAULT_CONF_FLOOR } from "../src/support/config-schema.ts";
import { projectHandoff } from "../src/app/session-driver.ts";
import {
  bindValueFor, countValueTargetId, findPoolRefBySig, slotKeyFor, valueAliasKeyOf,
  valueKeyOf, valueNeedOf, valueSigOf, valueTargetIdOf,
} from "../src/app/pilot-value-need.ts";
import { browserSession } from "../src/engine/executor.ts";
import { criteriaView } from "../src/engine/extraction.ts";
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
    // 决策端点 403（凭证/权益类失败的现场复现：这是**服务在回应**，不是不可达）。
    if (rel.startsWith("/decision-403")) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { code: "AccessDenied.Unpurchased", message: "AccessDenied.Unpurchased: the model is not purchased" } }));
      return;
    }
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
function laneEnv(decisionBaseUrl: string = UNREACHABLE_PROVIDER): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "af-verify-pilot-home-"));
  Object.assign(process.env, {
    AMBERFLOW_HOME: home,
    AMBERFLOW_DECISION_BASE_URL: decisionBaseUrl,
    AMBERFLOW_DECISION_API_KEY: "unused-lane-key",
    AMBERFLOW_DECISION_MODEL: "unused-lane-model",
  });
  return process.env;
}

interface Booted {
  rt: PilotRuntime;
  events: SinkEvent[];
}

async function boot(
  opts: Omit<PilotOptions, "env" | "outDir">,
  decisionBaseUrl: string = UNREACHABLE_PROVIDER,
): Promise<Booted> {
  const events: SinkEvent[] = [];
  const sink: PilotSink = { respond: (obj) => { events.push(obj as SinkEvent); } };
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-verify-pilot-out-"));
  const rt = new PilotRuntime({ ...opts, env: laneEnv(decisionBaseUrl), outDir }, sink);
  await rt.start();
  return { rt, events };
}

function drivesOf(events: SinkEvent[]): SinkEvent[] {
  return events.filter((e) => e["type"] === "drive");
}

/** 最后一次交接块本身（顶层字段断言的入口；交接事件是 `{type:"handoff", handoff:{...}}`）。 */
function lastHandoff(events: SinkEvent[]): Record<string, unknown> {
  const handoffs = events.filter((e) => e["type"] === "handoff");
  assert.ok(handoffs.length > 0, "a handoff event exists");
  return handoffs[handoffs.length - 1]!["handoff"] as Record<string, unknown>;
}

/** 停因专属事实的顶层键闭集（顺序 = `topStopFacts` 的展开序；跨停因断言共用）。 */
const STOP_FACT_KEYS = ["observation", "model_abstain", "nav_error", "off_envelope"] as const;

/** 一个交接块上出现了哪些停因专属事实（空数组 = 旧形状，键一个都没有）。 */
function stopFactKeysOf(handoff: Record<string, unknown>): string[] {
  return STOP_FACT_KEYS.filter((k) => k in handoff);
}

/**
 * 三档低置信的处置方向标记：摘要进 Agent 上下文，措辞就是行动面——
 * 改这里等于改契约（`whyStuckSummary` 的人话必须仍然说得出下一步查什么）。
 */
const LOW_CONFIDENCE_DIRECTION_MARK: Record<(typeof LOW_CONFIDENCE_KINDS)[number], string> = {
  "observation-empty": "先查抽取/等渲染",
  "observation-all-forbidden": "先查为什么都被排除",
  "model-unsure": "该调题面或换问法",
};

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
    assert.equal(end!["conf_floor"], DEFAULT_CONF_FLOOR,
      "the terminal summary carries the effective floor scale (single source = DEFAULT_CONF_FLOOR)");
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
    // 非低置信停因的旧形状逐字节不变：不是 low_confidence 就不出现分类键（原文 + 会话投影两层）。
    const handoff = lastHandoff(events);
    assert.equal("low_confidence_kind" in handoff, false, "a non-low-confidence handoff carries no classification key");
    assert.equal("low_confidence_kind" in projectHandoff(handoff as unknown as PilotHandoff), false,
      "the session projection invents no key the engine did not give");
    // 停因专属事实只在对应停因出现：needs_value 的顶层键集与引入它们之前完全相同。
    assert.deepEqual(stopFactKeysOf(handoff), [], "needs_value owns none of the stop-specific facts");
    // 现场定位键则相反：值需求是这条停因的判据，必须自己在顶层（桥面丢 evidence）。
    const need = handoff["needs_value"] as Record<string, unknown>;
    assert.equal(need["key"], "Search term", "the value need is a top-level fact (not evidence-only)");
    assert.equal(typeof need["target"], "string", "and it names the target");
    assert.equal(typeof need["ref"], "string", "and carries the pool ref for evidence");
    assert.equal("resume_hint" in handoff, false, "no missed hint yet = no resume_hint key");
    assert.deepEqual(Object.keys(projectHandoff(handoff as unknown as PilotHandoff)), [
      "stop_code", "needs_value", "step_id", "goal_digest", "why_stuck", "what_would_unblock", "evidence_refs", "url", "final_signal",
    ], "the needs_value projection carries exactly its own locator key");
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
    assert.equal("resume_hint" in lastHandoff(events), false, "no miss yet = no resume_hint on the first handoff");
    assert.equal(await rt.handleLine('{"cmd":"resume","hint":"#nope"}'), "drive");
    assert.equal(await rt.drive(), "needs_value", "the missed hint falls back to the same value-needing target");
    const ev = lastHandoffEvidence(events);
    assert.deepEqual(ev["resume_hint"], { hint: "#nope", missed: true },
      "the missed hint is explicit evidence on the next handoff");
    assert.equal((ev["needs_value"] as Record<string, unknown>)["key"], "Search term",
      "the value need is still named alongside the missed hint");
    // 顶层同源：Agent 看不到 evidence（桥面丢弃），"上次点名落空"必须自己在顶层。
    const handoff = lastHandoff(events);
    assert.deepEqual(handoff["resume_hint"], { hint: "#nope", missed: true },
      "the missed hint is a top-level fact — it is why the Agent is being asked again");
    assert.deepEqual(projectHandoff(handoff as unknown as PilotHandoff)["resume_hint"],
      { hint: "#nope", missed: true }, "the session projection keeps the same shape");
    assert.deepEqual((handoff["needs_value"] as Record<string, unknown>)["key"], "Search term",
      "the value need rides along on the same handoff");
  } finally {
    await rt.closeBrowser();
  }
}

/**
 * 期望页可见性：`--expect-url` 声明后，交接块顶层必须给出同一份值——
 * `off_task_page` 的解锁建议说「偏离 --expect-url」，不给值 Agent 无从判断偏离了多少。
 * 这里用 `needs_value` 停因（同一个声明在任何停因都可见）造交付。
 */
async function scenarioExpectUrlVisible(origin: string): Promise<void> {
  const { rt, events } = await boot({
    url: `${origin}/home.html`, goal: "Search term", expectUrl: "/home.html",
    finalSignal: { css_value_equals: ["#q", "amber"] }, maxSteps: 4,
  });
  try {
    assert.equal(await rt.drive(), "needs_value", "a declared expect_url does not change the stop cause");
    const handoff = lastHandoff(events);
    assert.equal(handoff["expect_url"], "/home.html",
      "the declared task-page substring is a top-level fact, not evidence-only");
    assert.equal(lastHandoffEvidence(events)["expect_url"], "/home.html",
      "the evidence block carries the same raw value (single source, two visible faces)");
    assert.equal(projectHandoff(handoff as unknown as PilotHandoff)["expect_url"], "/home.html",
      "the session projection keeps it");
    assert.equal("resume_hint" in handoff, false, "an expect_url fact does not drag the other locator keys in");
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
    // 规则档命中一个"点了没用"的目标：**只试一次**就把它从规则档排除，转由模型档接手
    // （本 lane 无模型 → 如实 no_model_runtime）。复读三次白烧预算是缺陷，不是安全网。
    assert.equal(stop, "no_model_runtime", "a dead rule target falls through to the model lane");
    const drives = drivesOf(events);
    assert.equal(drives.length, 1, "the dead rule target is tried exactly once");
    assert.equal(drives[0]!["changed"], false, "that single attempt changed nothing");
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
    assert.notEqual(stop, null, "the run stops before the resume (its code is not this scenario's subject)");
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
    // 观测体检：低置信交接必须能回答"当时有多少候选、多少被禁"。
    const obs = ev?.["observation"] as Record<string, unknown> | undefined;
    assert.ok(obs !== undefined, "the low-confidence handoff carries observation facts");
    assert.equal(typeof obs?.["pool_size"], "number", "pool_size is a real reading");
    // 该场景唯一候选被拒后池已耗尽——这**不是**模型判断，分类必须落在观测档。
    assert.ok(["observation-empty", "observation-all-forbidden"].includes(String(ev?.["low_confidence_kind"])),
      `an exhausted pool is an observation problem, not a model judgement (got ${String(ev?.["low_confidence_kind"])})`);
    assert.ok(String(ledger[0]!["last_outcome"]).startsWith("unhittable"), "outcome names the cover relation");
    // 分类是**顶层**字段：桥面只投影交接块白名单字段（evidence 整块被丢弃），档位必须自己能到 Agent。
    assert.ok(handoff !== undefined, "the low-confidence stop is reported as a handoff");
    const block = handoff["handoff"] as Record<string, unknown>;
    const kind = String(block["low_confidence_kind"]);
    assert.ok((LOW_CONFIDENCE_KINDS as readonly string[]).includes(kind),
      `the classification is a top-level handoff field (got ${JSON.stringify(block["low_confidence_kind"])})`);
    assert.ok((PILOT_STOP_CODES as readonly string[]).includes(String(block["stop_code"])),
      "the stop code stays inside the frozen 12-code closed set");
    const view = projectHandoff(block as unknown as PilotHandoff);
    assert.equal(view["low_confidence_kind"], kind, "the session projection keeps the classification (evidence is not a carrier)");
    const summary = String((view["why_stuck"] as Record<string, unknown>)["summary"]);
    assert.ok(summary.startsWith("low_confidence @ step "), "the stop-code prefix stays parsable");
    assert.ok(summary.includes(LOW_CONFIDENCE_DIRECTION_MARK[kind as (typeof LOW_CONFIDENCE_KINDS)[number]]),
      `the summary points at the direction for ${kind} (got ${summary})`);
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
    assert.notEqual(stop, null, "the run stops before the resume (its code is not this scenario's subject)");
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
    assert.deepEqual(stopFactKeysOf(block), [], "budget_exceeded owns none of the stop-specific facts");
    assert.deepEqual(Object.keys(projectHandoff(block as unknown as PilotHandoff)), [
      "stop_code", "step_id", "goal_digest", "why_stuck", "what_would_unblock", "evidence_refs", "url", "final_signal",
    ], "the budget_exceeded projection keeps its pre-existing top-level key set");
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
    // 决策源降级**当轮**就如实报 no_model_runtime——"模型不在位"不能伪装成"模型没把握"。
    assert.equal(stop, "no_model_runtime", "an unreachable decision source stops as no_model_runtime at once");
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
 * 模型**显式弃权**的事实面（evidence-only）：`handoffWhyEvidence.modelAbstain` 只在模型真的
 * 看了候选说「都不推进」时出现；引擎侧没拿到选择（ref=null 但不是弃权）不出现该键。
 * 两者同落 `low_confidence` 交 Agent 兜底，但只有前者能回答「模型看着 N 个候选说不行」。
 */
/**
 * `low_confidence` 三义分离（观测体检）：同一个码背后是完全不同的处境，处置方向相反——
 * 「池里一个候选都没有」要去查抽取/等渲染，「全被禁选」要查为什么都被排除，
 * 「有可用候选、模型没把握」才该调题面。纯函数钉分类，现场钉证据真的带出来。
 */
async function scenarioObservationHealth(_origin: string): Promise<void> {
  // ① 分类：空池 / 全禁选 / 有可用候选。
  assert.equal(lowConfidenceKindOf({ pool_size: 0, forbidden: 0, empty_labels: 0 }), "observation-empty",
    "an empty pool is an observation problem, not a model judgement");
  assert.equal(lowConfidenceKindOf({ pool_size: 3, forbidden: 3, empty_labels: 0 }), "observation-all-forbidden",
    "everything forbidden is still not a model judgement");
  assert.equal(lowConfidenceKindOf({ pool_size: 3, forbidden: 1, empty_labels: 0 }), "model-unsure",
    "available candidates + low score is the only real model-unsure case");
  // ② 取数：空标签计数与禁选计数取自当场读数。
  const pool = {
    "@e1": { tag: "input", label: "" } as Elem,
    "@e2": { tag: "button", label: "Go" } as Elem,
  };
  assert.deepEqual(observationFactsOf(pool, new Set(["@e2"])), { pool_size: 2, forbidden: 1, empty_labels: 1 },
    "facts are read from the pool and the forbidden set");
  assert.deepEqual(observationFactsOf(null, new Set()), { pool_size: 0, forbidden: 0, empty_labels: 0 },
    "no pool yet is still reported honestly (zero)");
  // ③ 闭集：停因码仍是冻结的 12 码，分类是三值闭集（新增值 = 改契约）。
  assert.equal(PILOT_STOP_CODES.length, 12, "the stop-code closed set stays frozen at 12 codes");
  assert.equal(new Set(PILOT_STOP_CODES).size, PILOT_STOP_CODES.length, "stop codes are unique");
  assert.deepEqual([...LOW_CONFIDENCE_KINDS], ["observation-empty", "observation-all-forbidden", "model-unsure"],
    "the classification closed set has exactly three values");
  // ④ 摘要：停因码恒在行首（结构可解析），三档各自给出人话方向，档位名不再进摘要。
  const factsOf = {
    "observation-empty": { pool_size: 0, forbidden: 0, empty_labels: 0 },
    "observation-all-forbidden": { pool_size: 3, forbidden: 3, empty_labels: 2 },
    "model-unsure": { pool_size: 4, forbidden: 1, empty_labels: 0 },
  } as const;
  for (const kind of LOW_CONFIDENCE_KINDS) {
    const summary = whyStuckSummary({
      stop: "low_confidence", step: 3, url: "https://a.test/list", observation: factsOf[kind], loopTrip: null,
    });
    assert.ok(summary.startsWith("low_confidence @ step 3 (https://a.test/list)"),
      "the stop code + step + url prefix stays byte-stable");
    assert.ok(!summary.includes(kind), "the classification is carried by the top-level key, not by a bracket tag");
    assert.ok(summary.includes(LOW_CONFIDENCE_DIRECTION_MARK[kind]),
      `the ${kind} summary says what to look at next (got ${summary})`);
  }
  // 桥面摘要上限 300 字符：最长 URL（120）+ 死目标事实 + 方向句的最坏拼装也不越界。
  const worst = whyStuckSummary({
    stop: "low_confidence", step: 200, url: `https://a.test/${"x".repeat(400)}`,
    observation: factsOf["model-unsure"], loopTrip: { desc: "y".repeat(200), tries: 3 },
  });
  assert.ok(worst.length <= 300, `the summary fits the bridge cap of 300 chars (got ${worst.length})`);
  // ⑤ 非低置信停因的摘要逐字节不变（不新增方向句，旧消费者照旧解析）。
  assert.equal(
    whyStuckSummary({ stop: "needs_value", step: 2, url: "https://a.test/x", observation: null, loopTrip: null }),
    "needs_value @ step 2 (https://a.test/x)",
    "a non-low-confidence summary keeps its old shape",
  );
  assert.equal(
    whyStuckSummary({ stop: "stuck_inert", step: 5, url: "", observation: null, loopTrip: { desc: "Retry", tries: 3 } }),
    'stuck_inert @ step 5 — dead target: "Retry" driven 3 time(s) without the signal holding',
    "the dead-target suffix is unchanged",
  );
}

/**
 * 决策源降级一次就停：服务**在回应** 403（不是不可达）时，驾驶面必须当轮就如实停成
 * `no_model_runtime`，而不是先报一个误导性的 `low_confidence`、等下一轮才翻。
 * 同一条规则也覆盖不可达端点——"模型不在位"与"模型没把握"必须是两个停因。
 */
async function scenarioProviderDownStopsOnce(origin: string): Promise<void> {
  // 现场：goal 不命中规则 → 必须问模型 → 服务回 403 → 当轮停。
  const { rt, events } = await boot(
    { url: `${origin}/home.html`, goal: "zerblonix frobnicate", maxSteps: 6 },
    `${origin}/decision-403`,
  );
  try {
    const stop = await rt.drive();
    assert.equal(stop, "no_model_runtime", "an auth failure stops honestly on the same round");
    const drives = drivesOf(events);
    assert.equal(drives.length, 0, "no action is executed after an auth failure");
    const handoff = events.filter((e) => e["type"] === "handoff").pop() as Record<string, unknown> | undefined;
    assert.ok(handoff !== undefined, "the stop is reported as a handoff");
    const code = (handoff!["handoff"] as Record<string, unknown>)["stop_code"];
    assert.equal(code, "no_model_runtime", "the handoff carries the typed stop code");
  } finally {
    await rt.closeBrowser();
  }

  // 同一条规则覆盖**不可达**端点（不是鉴权问题，同样不能伪装成低置信）。
  const unreachable = await boot({ url: `${origin}/home.html`, goal: "zerblonix frobnicate", maxSteps: 6 });
  try {
    const stop = await unreachable.rt.drive();
    assert.equal(stop, "no_model_runtime", "an unreachable provider also stops as no_model_runtime");
  } finally {
    await unreachable.rt.closeBrowser();
  }
}

/**
 * 空标签身份兜底（浏览器树的注入段）：池里有 role/name/input_type 而渲染只给 label 时，
 * 模型看到的是 `input ""`——等于让它在无法区分的行里投票。钉住三件事：
 * ① 只补空标签（有标签的行逐字节不变，无身份字段的行也不补）；② 无空标签可补时返回同一对象
 * （题面逐字节不变）；③ 真实抽取链上空标签候选渲染出身份 token。
 */
async function scenarioAskIdentityFallback(origin: string): Promise<void> {
  // ① 纯函数：只对空标签生效，且不制造无谓分配。
  const labeled = { "@e3": { tag: "button", label: "Search" } as Elem };
  assert.equal(askViewOf(labeled), labeled, "no empty label → the same pool object (byte-identical ask)");
  const anonymous = { "@e1": { tag: "input", label: "" } as Elem };
  assert.equal(askViewOf(anonymous), anonymous, "empty label without identity fields → not rewritten");
  assert.equal(identityLabelOf({ tag: "input", label: "" } as Elem), null, "no identity fields → no fallback text");
  const mixed = {
    "@e1": { tag: "input", label: "" } as Elem,
    "@e2": { tag: "input", label: "", role: "combobox", name: "q", input_type: "search" } as Elem,
    "@e3": { tag: "button", label: "Search" } as Elem,
  };
  const view = askViewOf(mixed);
  assert.notEqual(view, mixed, "a mixed pool produces a rewritten ask view");
  assert.equal(view["@e1"], mixed["@e1"], "a row without identity is passed through untouched");
  assert.equal(view["@e3"], mixed["@e3"], "a labeled row is passed through untouched");
  assert.equal(view["@e2"]!["label"], "combobox [name=q] [type=search]", "identity tokens use the fixed order");
  // 渲染面：空标签行不再是 `input ""`。
  const crit = criteriaView(view, new Set(), null, null);
  assert.ok(crit["@e2"]!.includes("[name=q]"), "the rendered line carries the pool identity");
  assert.ok(!crit["@e2"]!.includes('""'), "the rendered line is no longer an empty label");

  // ② 真实抽取链：fixture 的 input 只有 name/type，抽取后 label 为空 → 兜底补出身份。
  const { rt } = await boot({ url: `${origin}/unlabeled-target.html`, goal: "搜索", maxSteps: 2 });
  try {
    const page = await rt.page();
    const { elems } = await rt.mw()._extractPoolSettled(page, "bucketed");
    const empty = Object.entries(elems).filter(([, e]) => e.label === "");
    assert.ok(empty.length > 0, "the fixture really produces label-less candidates");
    const realView = askViewOf(elems);
    const realCrit = criteriaView(realView, new Set(), null, null);
    const rendered = Object.entries(realCrit).filter(([, line]) => line.includes("[name=q]"));
    assert.equal(rendered.length, 1, "the unlabeled input renders its name identity");
    const rawCrit = criteriaView(elems, new Set(), null, null);
    assert.ok(
      Object.values(rawCrit).some((line) => line.includes('""')),
      "without the fallback the same pool would render an empty label",
    );
  } finally {
    await rt.closeBrowser();
  }
}

/**
 * 决策树契约（纯函数）：树的加载期校验真的会拒绝结构错误，且 walker 按数据路由。
 * 钉住三件事：① 浏览器树自身合法且状态 id 与实现绑定闭集一致；② 缺出边/kind 越界/悬空终点
 * 三类结构错误都被拒（不是靠运行时炸）；③ walker 走的是**数据里的边**，不是写死的分支。
 */
async function scenarioTreeContract(_origin: string): Promise<void> {
  assert.deepEqual(validateTree(BROWSER_TREE), [], "the browser tree validates clean");
  assert.equal(
    BROWSER_TREE.states.map((s) => s.id).sort().join(","),
    [...BROWSER_STATE_IDS].sort().join(","),
    "declared state ids match the implementation-binding closed set",
  );
  // 缺出边：删掉一条边后，该结果必须被报为"没有出边"。
  const missingEdge: DecisionTree = {
    ...BROWSER_TREE, edges: BROWSER_TREE.edges.filter((e) => e.result !== "abstain"),
  };
  assert.ok(
    validateTree(missingEdge).some((x) => x.includes("abstain") && x.includes("没有出边")),
    "a declared result without an edge is rejected at load",
  );
  // kind 越界：应用不能自铸状态类型。
  const badKind = {
    ...BROWSER_TREE,
    states: BROWSER_TREE.states.map((s) => (s.id === "verify" ? { id: "verify", kind: "magic" as never } : s)),
  } as DecisionTree;
  assert.ok(validateTree(badKind).some((x) => x.includes("不在闭集")), "an unknown state kind is rejected");
  // 悬空终点。
  const dangling: DecisionTree = {
    ...BROWSER_TREE,
    edges: BROWSER_TREE.edges.map((e) => (e.from === "select" && e.result === "picked" ? { ...e, to: "nowhere" } : e)),
  };
  assert.ok(validateTree(dangling).some((x) => x.includes("边终点不存在")), "an edge to a missing state is rejected");
  // walker 按数据路由：同一份 board，改边即改行为（合成树用闭集内的 kind 与结果）。
  const board = { seen: [] as string[] };
  const handlers = {
    a: async (): Promise<StateOutcome> => ({ result: "picked" }),
    b: async (): Promise<StateOutcome> => ({ result: "bound" }),
  };
  const straight: DecisionTree = {
    name: "t", entry: "a",
    states: [{ id: "a", kind: "select-tool" }, { id: "b", kind: "resolve-param" }],
    edges: [
      { from: "a", result: "picked", to: "b" },
      { from: "a", result: "below-floor", to: TREE_EXIT },
      { from: "a", result: "abstain", to: TREE_EXIT },
      { from: "a", result: "no-model", to: TREE_EXIT },
      { from: "a", result: "ambiguous", to: TREE_EXIT },
      { from: "b", result: "bound", to: TREE_EXIT },
      { from: "b", result: "needs-value", to: TREE_EXIT },
    ],
  };
  assert.equal((await walkTree(straight, handlers, board)).kind, "exit", "walker follows the declared edge to the exit");
  // 停因出口不经过边：状态直接 stop 即终止（停因闭集归调用方）。
  const stopAt = {
    a: async (): Promise<StateOutcome> => ({ stop: "low_confidence" }),
  };
  const stopped = await walkTree(straight, { ...handlers, a: stopAt.a }, board);
  assert.deepEqual(stopped, { kind: "stop", code: "low_confidence" }, "a state can stop without an edge");
  // 预算边界由调用方兜住：shouldContinue 为假时连入口都不求值。
  let entered = 0;
  const counted = { a: async (): Promise<StateOutcome> => { entered += 1; return { result: "picked" }; } };
  const capped = await walkTree(straight, { ...handlers, ...counted }, board, { shouldContinue: () => false });
  assert.equal(capped.kind, "exit", "budget boundary exits before evaluating a state");
  assert.equal(entered, 0, "no state is evaluated once the caller's budget is exhausted");
}

/**
 * 停因专属事实的纯函数面：`stopFactsOf` 按停因装配、`topStopFacts` 有界投影、
 * `handoffWhyEvidence` 的 evidence 形状不变、`projectHandoff` 的顶层键集与取值。
 *
 * 钉四件事：① 只在对应停因出现（其它停因的完整 JSON 逐字节不变）；② 四项各自在顶层出现；
 * ③ 文本项有界；④ 整数项只带固定键（多出的键不进投影，桥不补键）。
 */
async function scenarioStopFactsPure(_origin: string): Promise<void> {
  const pool = {
    "@e1": { tag: "input", label: "" } as Elem,
    "@e2": { tag: "button", label: "Go" } as Elem,
    "@e3": { tag: "a", label: "More" } as Elem,
  };
  const forbidden = new Set(["@e2"]);
  const gate = { stop: "host_not_allowed" as const, offEnvelope: "http://away.test/x", reason: "navigation failed: net::ERR_NAME_NOT_RESOLVED" };
  const abstain = { pool_size: 3, asks: 1 };
  // ① 非低置信/信封/导航停因：即使 gate 与弃权事实都在场，也一个键都不出。
  for (const stop of ["needs_value", "budget_exceeded", "stuck_inert", "target_ambiguous",
    "off_task_page", "no_model_runtime", "browser_dead", "final_signal_held"] as const) {
    const facts = stopFactsOf({ stop, gate, modelAbstain: abstain, pool, forbidden });
    assert.deepEqual(facts, {}, `${stop} owns no stop-specific facts (old handoff shape unchanged)`);
    assert.deepEqual(topStopFacts(facts), {}, `${stop} projects no top-level facts`);
  }
  // ② 四项各自在对应停因出现在顶层。
  const low = stopFactsOf({ stop: "low_confidence", gate: null, modelAbstain: abstain, pool, forbidden });
  assert.deepEqual(low.observation, { pool_size: 3, forbidden: 1, empty_labels: 1 },
    "low_confidence carries the observation counts read from the pool");
  assert.deepEqual(low.model_abstain, abstain, "an explicit abstain rides with the observation");
  assert.deepEqual(stopFactKeysOf(topStopFacts(low)), ["observation", "model_abstain"],
    "both low-confidence facts are top-level");
  const noVote = stopFactsOf({ stop: "low_confidence", gate: null, modelAbstain: null, pool, forbidden });
  assert.deepEqual(stopFactKeysOf(topStopFacts(noVote)), ["observation"],
    "no abstain (the engine never got a choice) = observation counts only");
  assert.deepEqual(stopFactsOf({ stop: "host_not_allowed", gate, modelAbstain: null, pool, forbidden }),
    { off_envelope: "http://away.test/x" }, "the envelope stop carries the landing URL");
  assert.deepEqual(stopFactsOf({ stop: "unreachable", gate, modelAbstain: null, pool, forbidden }),
    { nav_error: gate.reason }, "the unreachable stop carries the original nav error");
  assert.deepEqual(stopFactsOf({ stop: "config_error", gate: { ...gate, reason: "navigation failed: net::ERR_UNSAFE_PORT" }, modelAbstain: null, pool, forbidden }),
    { nav_error: "navigation failed: net::ERR_UNSAFE_PORT" }, "the config-error stop carries it too");
  // ③ 文本项有界（超长裁到表界，不把一条 4000 字的浏览器原文塞进 Agent 上下文）。
  const longText = "x".repeat(4000);
  const bounded = topStopFacts({ nav_error: longText, off_envelope: longText });
  assert.equal(String(bounded["nav_error"]).length, HANDOFF_FACT_TEXT_MAX, "nav_error is bounded at the cap");
  assert.equal(String(bounded["off_envelope"]).length, HANDOFF_FACT_TEXT_MAX, "off_envelope is bounded at the cap");
  // ④ evidence 与顶层同源（同一份事实，两种可见面）。
  const base = {
    inertRun: 0, forbidden: new Set<string>(), ledgerEvidence: {}, framesExcluded: [],
    expectUrl: null, valueNeed: null, missedHint: null,
  };
  const evidence = handoffWhyEvidence({ ...base, stopFacts: low });
  assert.deepEqual(evidence["model_abstain"], abstain, "the abstain fact is in the evidence block");
  assert.deepEqual(evidence["observation"], low.observation, "the observation counts are in the evidence block");
  assert.equal(evidence["low_confidence_kind"], "model-unsure",
    "the classification still travels with the observation in evidence");
  assert.equal(handoffWhyEvidence({ ...base })["model_abstain"], undefined,
    "no stop facts = key absent in evidence (old shape unchanged)");
  // ⑤ 会话投影：顶层透传 + 只重建固定键 + 文本按表界裁剪。
  const head = { step_id: 2, goal_digest: "g", why_stuck: { summary: "s", evidence: {} }, what_would_unblock: [], evidence_refs: {}, url: "http://a.test/x" };
  const projected = projectHandoff({ stop_code: "low_confidence", ...head, ...topStopFacts(low) } as PilotHandoff);
  assert.deepEqual(projected["observation"], low.observation, "the engine projection keeps the observation counts");
  assert.deepEqual(projected["model_abstain"], low.model_abstain, "the engine projection keeps the abstain fact");
  const injected = projectHandoff({
    stop_code: "low_confidence", ...head,
    model_abstain: { pool_size: 1, asks: 1, extra: 9 } as unknown as { pool_size: number; asks: number },
    observation: { pool_size: 1, forbidden: 0, empty_labels: 0, extra: 9 } as unknown as ObservationFacts,
  } as PilotHandoff);
  assert.deepEqual(Object.keys(injected["model_abstain"] as object), ["pool_size", "asks"], "only the registered keys are projected");
  assert.deepEqual(Object.keys(injected["observation"] as object), ["pool_size", "forbidden", "empty_labels"],
    "the observation shape is rebuilt from its registered keys");
  const clipped = projectHandoff({ stop_code: "unreachable", ...head, nav_error: longText } as PilotHandoff);
  assert.equal(String(clipped["nav_error"]).length, HANDOFF_FACT_TEXT_MAX, "the engine projection clips the original text too");
  // ⑥ 至少两条非相关停因的**完整 JSON** 逐字节不变（顶层键集 + 键序都不引入新键）。
  const untouched = (stop: "needs_value" | "budget_exceeded"): string =>
    JSON.stringify(projectHandoff({ stop_code: stop, ...head, ...topStopFacts(stopFactsOf({ stop, gate, modelAbstain: abstain, pool, forbidden })) } as PilotHandoff));
  for (const stop of ["needs_value", "budget_exceeded"] as const) {
    assert.equal(untouched(stop), JSON.stringify({
      stop_code: stop, step_id: 2, goal_digest: "g", why_stuck: { summary: "s", evidence: {} },
      what_would_unblock: [], evidence_refs: {}, url: "http://a.test/x",
    }), `${stop} projects byte-identically to the shape without the stop facts`);
  }
}

/**
 * 现场定位键（值需求 / 落空点名 / 期望页）的纯函数面：只在对应情形出现、顶层有界、
 * 引擎投影只重建固定键。
 *
 * 钉四件事：① 缺省 = 三键都不出（两条非对应停因的**完整 JSON** 逐字节不变）；
 * ② 三项各自出现且形状固定；③ 文本项按表界裁剪；④ 投影只认固定键（多出的键与半截
 * 对象都不进投影），顶层与 evidence 同源。
 */
async function scenarioLocatorFactsPure(_origin: string): Promise<void> {
  const none = { expectUrl: null, valueNeed: null, missedHint: null };
  assert.deepEqual(topLocatorFacts(none), {}, "no locator fact = no top-level key");
  const head = {
    step_id: 2, goal_digest: "g", why_stuck: { summary: "s", evidence: {} },
    what_would_unblock: [], evidence_refs: {}, url: "http://a.test/x",
  };
  // ① 非对应情形逐字节不变：最宽的预声明（expect_url）也没有，投影键集与键序都不动。
  for (const stop of ["budget_exceeded", "target_ambiguous"] as const) {
    assert.equal(JSON.stringify(projectHandoff({ stop_code: stop, ...head, ...topHandoffFacts({}, none) } as PilotHandoff)),
      JSON.stringify({ stop_code: stop, ...head }),
      `${stop} projects byte-identically when no locator fact exists`);
  }
  // ② 三项各自出现（顶层，互不牵连）。
  const need = { target: "Search term", key: "Search term", ref: "e4" };
  assert.deepEqual(topLocatorFacts({ ...none, valueNeed: need }), { needs_value: need },
    "the value need alone is a top-level fact");
  assert.deepEqual(topLocatorFacts({ ...none, expectUrl: "/maps" }), { expect_url: "/maps" },
    "a declared expect_url is top-level on its own");
  assert.deepEqual(topLocatorFacts({ ...none, missedHint: "#nope" }),
    { resume_hint: { hint: "#nope", missed: true } }, "a missed hint is top-level with missed:true");
  // ③ 有界：三处文本都裁到表界（Agent 上下文里不放原始长文本）。
  const longText = "x".repeat(4000);
  const bounded = topLocatorFacts({
    expectUrl: longText, valueNeed: { target: longText, key: longText, ref: longText }, missedHint: longText,
  });
  assert.equal(String(bounded["expect_url"]).length, HANDOFF_FACT_TEXT_MAX, "expect_url is bounded at the cap");
  for (const text of Object.values(bounded["needs_value"] as Record<string, string>)) {
    assert.equal(text.length, HANDOFF_FACT_TEXT_MAX, "each value-need text is bounded at the cap");
  }
  assert.equal(String((bounded["resume_hint"] as Record<string, unknown>)["hint"]).length, HANDOFF_FACT_TEXT_MAX,
    "the missed hint is bounded too");
  // ④ 引擎投影只重建固定键。
  const dirty = projectHandoff({
    stop_code: "needs_value", ...head, expect_url: longText,
    needs_value: { ...need, sig: "SECRET", targetId: "s" } as unknown as PilotHandoff["needs_value"],
    resume_hint: { hint: "#nope", missed: true, extra: 1 } as unknown as PilotHandoff["resume_hint"],
  } as PilotHandoff);
  assert.deepEqual(Object.keys(dirty["needs_value"] as object), ["target", "key", "ref"],
    "only the registered value-need keys are projected");
  assert.deepEqual(Object.keys(dirty["resume_hint"] as object), ["hint", "missed"],
    "only the registered missed-hint keys are projected");
  assert.equal(String(dirty["expect_url"]).length, HANDOFF_FACT_TEXT_MAX,
    "the engine projection clips the declared URL too");
  const partial = projectHandoff({
    stop_code: "needs_value", ...head,
    needs_value: { target: "t", key: "k" } as unknown as PilotHandoff["needs_value"],
    resume_hint: { hint: "#nope", missed: false } as unknown as PilotHandoff["resume_hint"],
  } as PilotHandoff);
  assert.equal("needs_value" in partial, false, "a partial value need is not padded into a shape");
  assert.equal("resume_hint" in partial, false, "missed:false is not a missed hint (the bridge invents nothing)");
  // ⑤ 顶层与 evidence 同源（同一份事实，两种可见面）。
  const evidence = handoffWhyEvidence({
    inertRun: 0, forbidden: new Set<string>(), ledgerEvidence: {}, framesExcluded: [],
    expectUrl: "/maps", valueNeed: need, missedHint: "#nope",
  });
  assert.deepEqual(evidence["needs_value"], need, "the evidence block keeps the same value need");
  assert.deepEqual(evidence["resume_hint"], { hint: "#nope", missed: true }, "and the same missed hint");
  assert.equal(evidence["expect_url"], "/maps", "and the same declared URL");
}

/**
 * 决策桩：按剧本回一条 OpenAI Decisions 形状的答案（`null` = 空答案表）。
 * 只服务本 lane 的"模型说不行 / 模型没答"两个对照臂——不启模型、不外呼。
 */
async function startDecisionStub(answer: Record<string, unknown> | null): Promise<{ origin: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/v1/decisions") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ answers: answer === null ? [] : [answer] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}/v1/decisions`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * `low_confidence` 的两个顶层事实（运行时面，真决策桩）：模型**看了 N 个候选说不行**与
 * **引擎根本没拿到选择**同落一个码，只有顶层 `model_abstain` 能把它们分开；`observation`
 * 给出池计数（档位在 `low_confidence_kind`，没有计数就无从核对档位说的是不是真的）。
 *
 * 两个臂停因码相同、分类相同——差异只在 `model_abstain` 有没有出现，这正是它存在的理由。
 */
async function scenarioLowConfidenceFacts(origin: string): Promise<void> {
  const base = { url: `${origin}/home.html`, goal: "zerblonix frobnicate", maxSteps: 2 };
  // ① 模型显式弃权（choice:"none"）：顶层带 observation + model_abstain。
  const abstainStub = await startDecisionStub({ type: "choice", name: "act", choice: "none", confidence: 0.2 });
  const voted = await boot(base, abstainStub.origin);
  try {
    assert.equal(await voted.rt.drive(), "low_confidence", "an explicit abstain is still a low-confidence stop");
    const h = lastHandoff(voted.events);
    assert.deepEqual(stopFactKeysOf(h), ["observation", "model_abstain"], "an abstain carries both low-confidence facts");
    const counts = h["observation"] as { pool_size: number; forbidden: number; empty_labels: number };
    const abstained = h["model_abstain"] as { pool_size: number; asks: number };
    assert.equal(h["low_confidence_kind"], "model-unsure", "candidates were available, so the model is the bottleneck");
    assert.deepEqual(Object.keys(counts), ["pool_size", "forbidden", "empty_labels"], "the counts are the registered shape");
    assert.equal(abstained.pool_size, counts.pool_size,
      "the abstain pool size is the same reading as the observation count (one pool, not two)");
    assert.ok(abstained.asks >= 1, "an abstain costs at least one model ask");
    const summary = String((h["why_stuck"] as Record<string, unknown>)["summary"]);
    assert.ok(summary.includes(`至少 ${counts.pool_size - counts.forbidden} 个可用候选`),
      `the summary's candidate count agrees with the observation counts (got ${summary})`);
    const view = projectHandoff(h as unknown as PilotHandoff);
    assert.deepEqual(view["model_abstain"], abstained, "the session projection passes the abstain fact through");
    assert.deepEqual(view["observation"], counts, "and the observation counts");
    await voted.rt.finish(null);
    const end = voted.events.filter((e) => e["type"] === "pilot_end").pop();
    assert.ok(end !== undefined, "the terminal summary is emitted");
    assert.equal(abstained.asks, end!["model_asks"], "the ask count agrees with the run summary");
  } finally {
    await voted.rt.closeBrowser();
    await abstainStub.close();
  }
  // ② 引擎没拿到选择（空答案表）：同一个码同一个档位，但**没有** model_abstain。
  const quietStub = await startDecisionStub(null);
  const quiet = await boot(base, quietStub.origin);
  try {
    assert.equal(await quiet.rt.drive(), "low_confidence", "no answer from the model is the same stop code");
    const h = lastHandoff(quiet.events);
    assert.deepEqual(stopFactKeysOf(h), ["observation"], "no choice from the model = counts only, no abstain fact");
    assert.equal(h["low_confidence_kind"], "model-unsure", "same classification: only the abstain fact separates the two arms");
    assert.equal("model_abstain" in projectHandoff(h as unknown as PilotHandoff), false,
      "the session projection invents nothing the engine did not give");
    await quiet.rt.finish(null);
  } finally {
    await quiet.rt.closeBrowser();
    await quietStub.close();
  }
}

/**
 * 结束态可见性纯函数（evidence-only）：`weakPicksFrom` 只收 **model** 票且 `conf < DEFAULT_CONF_FLOOR`
 * （全局缺省刻度），有界 ≤6、无票 = undefined（旧交接形状不变）；`conf_floor` 由终态摘要给出。
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
  assert.equal(weakPicksFrom([{ step: 1, target: "x", picked_by: "model", conf: DEFAULT_CONF_FLOOR }]), undefined,
    "the threshold is strict (< floor): a vote exactly at the floor is not weak");
  const many = Array.from({ length: 9 }, (_, i) => ({
    step: i + 1, target: `t-${String(i)}`, picked_by: "model" as const, conf: 0.1,
  }));
  const bounded = weakPicksFrom(many);
  assert.ok(bounded !== undefined && bounded.length === 6, "weak_picks are bounded to 6");
  assert.equal(bounded[0]!.step, 4, "the most recent weak picks are kept");
  assert.deepEqual(weakPicksFrom([{ step: 1, target: "x", picked_by: "model", conf: 0.3 }], { floor: 0.4 }),
    [{ step: 1, target: "x", conf: 0.3, picked_by: "model" }],
    "an explicit floor overrides the documented default");
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
    // 顶层同源（桥面丢 evidence，只有顶层到得了 Agent）：真实 URL + 只此一键。
    assert.ok(String(h["off_envelope"] ?? "").startsWith(away.origin),
      "the landing URL is a top-level fact (the bridge drops why_stuck.evidence wholesale)");
    assert.doesNotThrow(() => new URL(String(h["off_envelope"])), "the top-level off_envelope is a real URL");
    assert.deepEqual(stopFactKeysOf(h), ["off_envelope"], "an envelope stop carries only the envelope fact");
    const view = projectHandoff(h as unknown as PilotHandoff);
    assert.equal(view["off_envelope"], h["off_envelope"], "the session projection passes it through unchanged");
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
    // 顶层同源：经桥的交接块里既没有 reason 也没有 evidence，原文必须自己在顶层。
    const dnsHandoff = lastHandoff(events);
    assert.ok(String(dnsHandoff["nav_error"] ?? "").includes("net::ERR_NAME_NOT_RESOLVED"),
      "the original nav error is a top-level fact, not evidence-only");
    assert.deepEqual(stopFactKeysOf(dnsHandoff), ["nav_error"], "an unreachable stop carries only the nav error");
    assert.ok((dnsHandoff["what_would_unblock"] as string[]).some((w) => w.includes("顶层") && w.includes("nav_error")),
      "the unblock hint points at the field the Agent can actually read");
    assert.equal("off_envelope" in dnsEvidence, false, "unreachable is never reported as an envelope escape");
    // ② 端口被浏览器拒绝：ERR_UNSAFE_PORT 不是「网络不可达」——改端口，不是重试。
    assert.equal(await rt.handleLine(`{"cmd":"redirect","url":"${hereOrigin}/nav-error.html"}`), "drive");
    assert.equal(await rt.handleLine('{"cmd":"resume","hint":"Unsafe port target"}'), "drive");
    assert.equal(await rt.drive(), "config_error", "a browser-refused port is a config error, not unreachable");
    const portEvidence = lastEvidence();
    assert.ok(String(portEvidence["nav_error"] ?? "").includes("net::ERR_UNSAFE_PORT"),
      "the handoff keeps the port rejection text");
    const portHandoff = lastHandoff(events);
    assert.ok(String(portHandoff["nav_error"] ?? "").includes("net::ERR_UNSAFE_PORT"),
      "the config-error original text is top-level too");
    assert.ok((portHandoff["what_would_unblock"] as string[]).some((w) => w.includes("顶层") && w.includes("nav_error")),
      "the config-error hint also names the top-level field");
    assert.equal(projectHandoff(portHandoff as unknown as PilotHandoff)["nav_error"], portHandoff["nav_error"],
      "the session projection passes the original text through");
    assert.deepEqual(stopFactKeysOf(portHandoff), ["nav_error"], "a config-error stop carries only the nav error");
    // ③ 反证：同一信封下真正跨 host 的跳转仍是 host_not_allowed（正常语义没被放宽）。
    assert.equal(await rt.handleLine(`{"cmd":"redirect","url":"${hereOrigin}/nav-error.html"}`), "drive");
    assert.equal(await rt.handleLine('{"cmd":"resume","hint":"Cross host target"}'), "drive");
    assert.equal(await rt.drive(), "host_not_allowed", "a real cross-host navigation stays an envelope stop");
    assert.ok(String(lastEvidence()["off_envelope"] ?? "").startsWith(away.origin),
      "the envelope stop still names the landing URL that left the envelope");
    const escapeHandoff = lastHandoff(events);
    assert.deepEqual(stopFactKeysOf(escapeHandoff), ["off_envelope"],
      "the envelope stop carries the envelope fact and no nav-error fact");
    assert.equal("nav_error" in escapeHandoff, false, "an out-of-envelope landing has no navigation failure text");
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
  ["规则档死目标不复读→resume 换目标", scenarioStuckInert],
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
  ["决策树契约：加载期校验 + walker 按数据路由", scenarioTreeContract],
  ["空标签身份兜底：只补空标签且不制造新分配", scenarioAskIdentityFallback],
  ["决策源降级一次就停（403/不可达都不伪装成低置信）", scenarioProviderDownStopsOnce],
  ["观测体检：low_confidence 三义分离", scenarioObservationHealth],
  ["停因专属事实纯函数：只在对应停因出现（顶层/证据/投影三层）", scenarioStopFactsPure],
  ["现场定位键纯函数：只在对应情形出现（顶层/投影/证据三层）", scenarioLocatorFactsPure],
  ["期望页可见性：声明后交接块顶层带 expect_url", scenarioExpectUrlVisible],
  ["低置信停因事实：弃权/没拿到选择两臂（顶层 observation+model_abstain）", scenarioLowConfidenceFacts],
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
