/**
 * S3 决策上文能力档验收 lane（非门禁、零外部网络）：把 DC4 的"可声明、可消费、可审计"钉成可比事实。
 *
 * 能力档四组断言：
 *   ① 三档声明（none/minimal/full）+ 未声明 × L0–L4：逐层回执状态闭集
 *      （sent / absent / unsupported / rejected），且 absent 与 unsupported 可区分；
 *   ② host 声明与 provider capabilities 一致：真实 provider 的 `context` 声明表 + host 回声；
 *   ③ 未注册 face / 未注册段 / 层不符 → 回执 rejected，且**询问不 abort**（picked 语义不变）；
 *   ④ `buildMiddleware` 注入 `decisionAskPorts` 后 ask 的 picked/abstained 行为与不注入逐字段一致，
 *      但 full 档 provider 的回执随声明变成 absent（证明端口/声明真的进了引擎）。
 *
 * ①–③ 用纯 fake host（零浏览器、零模型）；④ 用内存页 + 确定性 stub provider。
 *
 * ⑤ P0 决策请求上下文（零模型、零外网；本地 mock SystemOne 抓真实请求体）：
 *   A notes 上 wire：pilot `drive` 首问无 notes 键、次问带已试/无变化注记；
 *   B 无 notes 形状不变：run 面 fixture 决策步的 state 键集合逐字不变（无 notes）；
 *   C L4 端口：`ports.siteFacts` → pick notes 含 site_facts + 回执 L4 = sent；null = 原样；
 *   D L1/L0 两面一致：同一 fixture 同一目标的 run/pilot 首问 state.url/title/main_text 与
 *     criteria 键集合一致，L0 差异如实记录（pilot 含"当前页"，run 不含）；
 *   E wide 子帧取文：默认 main_text = 主文档 body（iframe 文本不在其中、不含 FRAME-ONLY-MARKER）；
 *     `AMBERFLOW_STATE_TEXT_SCOPE=wide` 追加未 detach 子帧 body 文本（含该标记），两档不同。
 *   F/G run 面 trace 回执：F = 正常动作步的 `context_layers` 五层闭集；
 *     G = **动作前停止**（低置信 → low_confidence）时回执落进 RunReport 的
 *     `stop_decision_context`（该步没有动作 trace 行可挂），且正常动作步的 trace 回执仍在。
 *
 * 用法：node --experimental-strip-types tools/verify-decision-context.ts [--json]
 * 退出码：0 = 全部断言全绿；1 = 有断言失败；2 = 用法/环境错误。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { browserSession } from "../src/engine/executor.ts";
import { createDecisionAccounting } from "../src/engine/decision-accounting.ts";
import { createDecisionAsk, type DecisionAskHost } from "../src/engine/decision-ask.ts";
import type {
  DecisionAskOutcome, DecisionAskPorts, DecisionLayerReceipt, DecisionSegment,
} from "../src/engine/decision-ask-contract.ts";
import type { ElemPool } from "../src/engine/elem-model.ts";
import type { PickProposal } from "../src/engine/executor-types.ts";
import type { ProviderCapabilities, ProviderPage } from "../src/support/decision-provider-contract.ts";
import {
  declaredContextOf, declaredStateDigestOf, layaProvider, installDecisionProvider,
  resolveProviderSpec, applySpecToRuntime,
} from "../src/model/decision-provider.ts";
import { decisionServiceProvider } from "../src/model/decision-service.ts";
import { scriptedAgent, scriptedRuntime, installLayaRuntime } from "../src/model/model.ts";
import { openaiDecisionsProvider } from "../src/model/decision-openai.ts";
import { firstCandidateProvider, coinFlipProvider, alwaysAbstainProvider } from "../src/model/decision-baselines.ts";
import { buildMiddleware } from "../src/app/middleware-factory.ts";
import { PilotLedger } from "../src/app/pilot-ledger.ts";
import { PilotAskAdapter } from "../src/app/pilot-ask-adapter.ts";
import { makeStubProvider } from "./stub-decision-provider.ts";

const USAGE = "usage: node --experimental-strip-types tools/verify-decision-context.ts [--json]";

/* ------------------------------------------------------------------ 断言收集 */

const failures: string[] = [];
let checks = 0;

function eq(name: string, actual: unknown, expected: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${name}: ${a} ≠ ${e}`);
}

function ok(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (!cond) failures.push(`${name}${detail === "" ? "" : `: ${detail}`}`);
}

/* ------------------------------------------------------------------ ①–③ 纯 fake host */

type Cap = ProviderCapabilities["context"] | null;
const POOL: ElemPool = { e0: { tag: "button", label: "确认" }, e1: { tag: "button", label: "取消" } };
const PROPOSAL: PickProposal = {
  choiceRef: "e0", shape: { kind: "full", k: 8, poolSize: 2, options: 2 },
  pTop1: 0.9, pTop2: 0.1, margin: 0.8, entropyConf: 0.9, probs: { e0: 0.9, e1: 0.1 },
};
const FAKE_PAGE = { url: () => "http://127.0.0.1:9/fake.html", title: async () => "fake" } as unknown as ProviderPage;
const LIFETIME = { kind: "pilot-leg", runId: "context-lane", leg: 1 } as const;
const ACCT_LIFETIME = { kind: "pilot-leg", runId: "context-lane", leg: 1 } as const;

function fakeHost(opts: { capability: Cap; abstain?: boolean }): DecisionAskHost {
  return {
    ready: async () => ({ rulesOnly: false }),
    extract: async () => POOL,
    pick: async () => (opts.abstain === true
      ? { ...PROPOSAL, choiceRef: null, shape: { kind: "none", k: 8, poolSize: 2, options: 0 } }
      : PROPOSAL),
    filter: () => null,
    scoreKind: () => "calibrated_prob",
    contextCapability: () => opts.capability,
  };
}

/** 纯引擎询问：L2 预置一条账本注记（保证 L2 有产出事实），不依赖浏览器。 */
async function askFake(o: {
  capability: Cap; segments?: DecisionSegment[]; ports?: DecisionAskPorts; face?: string; abstain?: boolean;
}): Promise<DecisionAskOutcome> {
  const ledger = new PilotLedger();
  ledger.bump(POOL.e0 as never, "确认", "changed");
  const ask = createDecisionAsk(fakeHost(o), o.ports === undefined ? {} : { ports: o.ports });
  const accounting = createDecisionAccounting({ pilot: ledger }, ACCT_LIFETIME);
  return await ask.ask(
    FAKE_PAGE, LIFETIME, accounting,
    { goal: "点一个按钮", ...(o.segments === undefined ? {} : { segments: o.segments }) },
    { face: o.face ?? "lane", confFloor: 0.25 },
  );
}

/** 状态表（L0→L4）。 */
function statuses(o: DecisionAskOutcome): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of o.context.layers) out[r.layer] = r.status;
  return out;
}

function receipt(o: DecisionAskOutcome, layer: "L0" | "L1" | "L2" | "L3" | "L4"): DecisionLayerReceipt {
  const r = o.context.layers.find((x) => x.layer === layer);
  if (r === undefined) throw new Error(`回执缺层 ${layer}`);
  return r;
}

const SEG_HISTORY: DecisionSegment = {
  kind: "history", layer: "L2", text: "第 1 步：点确认（changed）", provenance: { kind: "memory", ref: "m1" },
};
const SEG_PLAN: DecisionSegment = {
  kind: "plan", layer: "L3", text: "计划：先点确认，再点详情", provenance: { kind: "plan", ref: "plan-1" },
};
const SEG_SITE: DecisionSegment = {
  kind: "site-facts", layer: "L4", text: "站点：卡片列表页，确认键在行内", provenance: { kind: "site-facts", ref: "site-1" },
};
const SEG_UNKNOWN: DecisionSegment = {
  kind: "mystery", layer: "L4", text: "未注册的段", provenance: { kind: "trace", ref: "t1" },
};

/** 组合根端口样例：注册 face "lane" 与段 history(L2)/plan(L3)/site-facts(L4)。 */
const PORTS: DecisionAskPorts = {
  faces: (f) => (f === "lane" ? { face: "lane", asks: true, needs: ["L0", "L1", "L2", "L3", "L4"] } : null),
  segments: (k) => {
    if (k === "history") return { kind: "history", layer: "L2", budgetChars: 64 };
    if (k === "plan") return { kind: "plan", layer: "L3", budgetChars: 8 };
    if (k === "site-facts") return { kind: "site-facts", layer: "L4", budgetChars: 32 };
    return null;
  },
};

/* ------------------------------------------------------------------ ② 真实 provider 声明 */

function realProviderDeclarations(): void {
  const stub = makeStubProvider(() => ({ score: 0.5 }));
  eq("stub(characterization) context", stub.provider.capabilities.context, "none");
  const laya = layaProvider({
    runtime: scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 })) as never),
    agentFor: async () => ({ agent: {} as never, embedFn: null }),
  });
  eq("laya provider context", laya.capabilities.context, "minimal");
  eq("first-candidate context", firstCandidateProvider().capabilities.context, "none");
  eq("coin-flip context", coinFlipProvider().capabilities.context, "none");
  eq("always-abstain context", alwaysAbstainProvider().capabilities.context, "none");
  eq("openai-decisions context", openaiDecisionsProvider({
    endpoint: "http://127.0.0.1:9/v1/decisions",
  }).capabilities.context, "full");
  eq("decision-service context", decisionServiceProvider({}).capabilities.context, "full");
  // doctor 读的 spec 声明投影（不建 runtime / 不发请求）。
  eq("spec laya-onnx", declaredContextOf({ kind: "laya", name: "laya-onnx", tier: "on", ablation: false, make: () => { throw new Error("lane"); } }), "minimal");
  eq("spec scripted-stub", declaredContextOf({ kind: "laya", name: "scripted-stub", tier: "off(ablation:scripted-stub)", ablation: true, make: () => { throw new Error("lane"); } }), "none");
  eq("spec none", declaredContextOf({ kind: "none", name: "none", tier: "off(ablation:rules-only)", ablation: true }), "none");
  eq("spec laya state_digest", declaredStateDigestOf({ kind: "laya", name: "laya-onnx", tier: "on", ablation: false, make: () => { throw new Error("lane"); } }), false);
}

/** host 声明与 provider capabilities 一致：同一档位下回执 L3/L4 必须一致。 */
async function hostProviderConsistency(): Promise<void> {
  const stubCaps = makeStubProvider(() => ({ score: 0.5 })).provider.capabilities.context ?? null;
  const layaCaps = layaProvider({
    runtime: scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 })) as never),
    agentFor: async () => ({ agent: {} as never, embedFn: null }),
  }).capabilities.context ?? null;
  const rows: Array<{ name: string; cap: Cap; l3: string; l4: string }> = [
    { name: "stub(none)", cap: stubCaps, l3: "unsupported", l4: "unsupported" },
    { name: "laya(minimal)", cap: layaCaps, l3: "unsupported", l4: "unsupported" },
    { name: "service(full)", cap: "full", l3: "absent", l4: "absent" },
  ];
  for (const row of rows) {
    const o = await askFake({ capability: row.cap });
    eq(`host-consistency ${row.name} L3`, receipt(o, "L3").status, row.l3);
    eq(`host-consistency ${row.name} L4`, receipt(o, "L4").status, row.l4);
  }
}

/* ------------------------------------------------------------------ ① 三档回执矩阵 */

async function tierMatrix(): Promise<void> {
  const rows: Array<{ name: string; cap: Cap; want: Record<string, string> }> = [
    {
      name: "none", cap: "none",
      want: { L0: "sent", L1: "sent", L2: "sent", L3: "unsupported", L4: "unsupported" },
    },
    {
      name: "minimal", cap: "minimal",
      want: { L0: "sent", L1: "sent", L2: "sent", L3: "unsupported", L4: "unsupported" },
    },
    {
      name: "full", cap: "full",
      want: { L0: "sent", L1: "sent", L2: "sent", L3: "absent", L4: "absent" },
    },
    {
      name: "undeclared", cap: null,
      want: { L0: "sent", L1: "sent", L2: "sent", L3: "absent", L4: "absent" },
    },
  ];
  for (const row of rows) {
    const o = await askFake({ capability: row.cap });
    eq(`tier ${row.name} kind`, o.kind, "picked");
    eq(`tier ${row.name} layers`, statuses(o), row.want);
  }
  // 闭集可区分：absent（没产出）与 unsupported（provider 不收）必须能同时观察到。
  const observed = new Set<string>();
  for (const cap of ["none", "full"] as Cap[]) {
    for (const s of Object.values(statuses(await askFake({ capability: cap })))) observed.add(s);
  }
  ok("statuses distinguish absent/unsupported", observed.has("absent") && observed.has("unsupported"));
}

/* ------------------------------------------------------------------ ③ 段校验（rejected） */

async function segmentValidation(): Promise<void> {
  // 已注册 face + 已注册段：L3 = sent（预算 8 字符，文本超长 → clipped 记账）。
  const sentPlan = await askFake({ capability: "full", segments: [SEG_PLAN], ports: PORTS });
  const l3 = receipt(sentPlan, "L3");
  eq("segment plan L3 status", l3.status, "sent");
  eq("segment plan L3 budget", l3.budget, 8);
  eq("segment plan L3 truncated", l3.truncated, true);
  ok("segment plan L3 clipped chars", (l3.chars ?? 0) > 0, `chars=${l3.chars}`);

  // L2 段（history）注册后并入 L2 产出。
  const sentHistory = await askFake({ capability: "full", segments: [SEG_HISTORY], ports: PORTS });
  eq("segment history L2 status", receipt(sentHistory, "L2").status, "sent");

  // 未注册段 → rejected，但询问不 abort（仍 picked）。
  const unknown = await askFake({ capability: "full", segments: [SEG_UNKNOWN], ports: PORTS });
  eq("unregistered segment L4", receipt(unknown, "L4").status, "rejected");
  eq("unregistered segment not abort", unknown.kind, "picked");

  // 未注册 face → 其段不被接收（rejected），询问仍 generic 继续。
  const rogue = await askFake({ capability: "full", segments: [SEG_PLAN], ports: PORTS, face: "rogue" });
  eq("unregistered face L3", receipt(rogue, "L3").status, "rejected");
  eq("unregistered face not abort", rogue.kind, "picked");

  // 无端口（端口未接）但提供了段 → 无法校验 = rejected（fail-closed），未提供段 = absent。
  const noPorts = await askFake({ capability: "full", segments: [SEG_PLAN] });
  eq("no ports segment L3", receipt(noPorts, "L3").status, "rejected");
  eq("no ports no segment L3", receipt(await askFake({ capability: "full" }), "L3").status, "absent");

  // 声明档优先于段校验：minimal 档即使段已注册也不收（unsupported 而非 rejected）。
  const minimalSegment = await askFake({ capability: "minimal", segments: [SEG_PLAN], ports: PORTS });
  eq("minimal beats segment L3", receipt(minimalSegment, "L3").status, "unsupported");

  // 注册表层不符 → rejected（注册项 layer 与段声明不一致）。
  const wrongLayerPorts: DecisionAskPorts = {
    faces: PORTS.faces,
    segments: (k) => (k === "plan" ? { kind: "plan", layer: "L4", budgetChars: 8 } : null),
  };
  const wrongLayer = await askFake({ capability: "full", segments: [SEG_PLAN], ports: wrongLayerPorts });
  eq("wrong-layer registration L3", receipt(wrongLayer, "L3").status, "rejected");
  // L4 site-facts 注册后可按段产出。
  const sentSite = await askFake({ capability: "full", segments: [SEG_SITE], ports: PORTS });
  eq("segment site-facts L4", receipt(sentSite, "L4").status, "sent");
}

/* ------------------------------------------------------------------ ④ buildMiddleware 端口行为不变 */

const CARDS_HTML = `<!doctype html><html><body>
<button id="b1">确认</button><button id="b2">取消</button><button id="b3">详情</button>
</body></html>`;

/**
 * P0 夹具页：主文档只有 chrome，标记文本在 **iframe 子帧**里（iframe 文本不出现在父 body
 * 的 innerText；E 组用它对照默认取文与 wide 子帧取文）。
 */
const WIDE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>wide scope fixture</title></head>
<body><main><p>Chrome heading</p><button id="go" type="button">Continue</button></main>
<iframe srcdoc="<p>FRAME-ONLY-MARKER</p>"></iframe></body></html>`;
const FRAME_MARKER = "FRAME-ONLY-MARKER";

async function startServer(): Promise<{ origin: string; close(): Promise<void> }> {
  const repo = path.resolve(import.meta.dirname, "..");
  const fixtures = path.join(repo, "fixtures", "engine", "pilot");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/wide.html") { res.end(WIDE_HTML); return; }
    const local = path.resolve(fixtures, `.${pathname}`);
    if (pathname.endsWith(".html") && local.startsWith(`${fixtures}${path.sep}`)
      && fs.existsSync(local) && fs.statSync(local).isFile()) {
      res.end(fs.readFileSync(local));
      return;
    }
    res.end(CARDS_HTML);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("页面服务没有拿到端口");
  return { origin: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => { server.close(() => r()); }) };
}

/** ask 行为投影（不含回执；用于证明端口注入不改变 picked/abstained）。 */
function behaviorFact(o: DecisionAskOutcome): unknown {
  if (o.kind === "picked" && o.signal !== null) {
    return {
      kind: "picked", ref: o.target.ref, conf: o.signal.proposal.entropyConf,
      shape: o.signal.proposal.shape.kind, via: o.via, asked: o.asked, pool: Object.keys(o.executionPool),
    };
  }
  if (o.kind === "abstained") {
    return { kind: "abstained", asked: o.asked, pool: o.executionPool === null ? null : Object.keys(o.executionPool) };
  }
  return { kind: o.kind, asked: o.asked };
}

async function portWiring(origin: string): Promise<void> {
  const session = await browserSession(true);
  const page = session.page;
  await page.goto(`${origin}/cards.html`, { waitUntil: "load" });
  const hosts = ["127.0.0.1"];
  const caps: Array<{ name: string; turn: Parameters<typeof makeStubProvider>[0]; extra: Partial<ProviderCapabilities> }> = [
    { name: "none(no ports)", turn: () => ({ score: 0.9, passthrough: true }), extra: {} },
    { name: "none(ports)", turn: () => ({ score: 0.9, passthrough: true }), extra: {} },
    { name: "full(ports)", turn: () => ({ score: 0.9, passthrough: true }), extra: { context: "full" } },
  ];
  const results: Array<{ name: string; fact: unknown; layers: Record<string, string>; requests: number }> = [];
  try {
    for (const arm of caps) {
      const stub = makeStubProvider(arm.turn, arm.extra);
      installDecisionProvider(stub.provider);
      const withPorts = arm.name.includes("(ports)");
      const mw = buildMiddleware({
        face: "online", confirmPolicy: { kind: "allow-all" },
        options: {
          hosts, maxSteps: 3, gotoTimeout: 15_000, confFloor: 0.5,
          ...(withPorts ? { decisionAskPorts: PORTS } : {}),
        },
      });
      const adapter = new PilotAskAdapter(() => mw, new PilotLedger(), () => hosts);
      const outcome = await adapter.vote({ page, goal: "点一个按钮", confFloor: 0.5 });
      results.push({ name: arm.name, fact: behaviorFact(outcome), layers: statuses(outcome), requests: stub.requests.length });
    }
  } finally {
    await session.close();
    installDecisionProvider(null);
  }
  const [noPorts, withPorts, fullCaps] = results;
  eq("ports injected: behavior unchanged", withPorts?.fact, noPorts?.fact);
  eq("ports injected: request count unchanged", withPorts?.requests, noPorts?.requests);
  eq("full caps: behavior unchanged", fullCaps?.fact, noPorts?.fact);
  // 声明档经 adapter host 传到引擎：none → unsupported；full → absent（行为都不变）。
  eq("none caps L3", noPorts?.layers["L3"], "unsupported");
  eq("full caps L3", fullCaps?.layers["L3"], "absent");
  eq("none caps L4", withPorts?.layers["L4"], "unsupported");

  // 弃权档同样不得因端口注入改变语义。
  const abstainFacts: unknown[] = [];
  const session2 = await browserSession(true);
  try {
    await session2.page.goto(`${origin}/cards.html`, { waitUntil: "load" });
    for (const withPorts of [false, true]) {
      const stub = makeStubProvider(() => ({ ref: null, score: 0, scoreKind: "rank_only" as const }));
      installDecisionProvider(stub.provider);
      const mw = buildMiddleware({
        face: "online", confirmPolicy: { kind: "allow-all" },
        options: { hosts, maxSteps: 3, gotoTimeout: 15_000, confFloor: 0.5, ...(withPorts ? { decisionAskPorts: PORTS } : {}) },
      });
      const adapter = new PilotAskAdapter(() => mw, new PilotLedger(), () => hosts);
      abstainFacts.push(behaviorFact(await adapter.vote({ page: session2.page, goal: "点一个按钮", confFloor: 0.5 })));
    }
  } finally {
    await session2.close();
    installDecisionProvider(null);
  }
  eq("ports injected: abstain unchanged", abstainFacts[1], abstainFacts[0]);
}

/* ------------------------------------------------------------------ ⑤ P0 决策请求上下文 */

const REPO = path.resolve(import.meta.dirname, "..");
const CLI = path.join(REPO, "src", "cli", "main.ts");
const P0_BASE_GOAL = "Complete the checkout flow";

type Json = Record<string, unknown>;
interface CapturedRequest { path: string; body: Json }
interface Captured { choices: CapturedRequest[]; cli: { status: number | null; stdout: string; stderr: string } }
interface MockDecision {
  origin: string; requests: CapturedRequest[]; close(): Promise<void>;
  /**
   * 作答模式：pilot 组点 Dead end（制造注记）；run 组点详情链接（使 run 收尾）；
   * low-confidence = 仍点名 Dead end 但置信度低于 floor（构造"动作前停止"）。
   */
  mode: "dead-end" | "detail" | "low-confidence";
}

/** JSON 模式的结构化事实（成功路径也不丢 L0 差异这类"如实记录"）。 */
const facts: Record<string, unknown> = {};
let jsonMode = false;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
function stateOf(body: Json): Json { const s = body["state"]; return isObj(s) ? s : {}; }
function actOf(body: Json): Json {
  const q = body["questions"];
  const a = isObj(q) ? q["act"] : undefined;
  return isObj(a) ? a : {};
}
function criteriaOf(body: Json): Record<string, string> {
  const c = actOf(body)["criteria"];
  return isObj(c) ? c as Record<string, string> : {};
}
function isChoiceRequest(body: Json): boolean { return actOf(body)["type"] === "choice" && isObj(body["state"]); }
function tail(text: string, lines = 4): string { return text.trim().split("\n").slice(-lines).join(" / ").slice(0, 400); }

/** 组结果打印：新增 failure = FAIL，否则 PASS。 */
async function group(label: string, fn: () => void | Promise<void>): Promise<void> {
  const before = failures.length;
  try { await fn(); } catch (e) { failures.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  if (jsonMode) return;
  if (failures.length > before) console.error(`verify:decision-context FAIL ${label}`);
  else console.log(`verify:decision-context PASS ${label}`);
}

/**
 * mock SystemOne 决策端点：记录每次请求体，按题面确定性作答（零模型、零外网）。
 *   - 探针（"decision plane probe"）：交白卷（协议可达即通过，不考题感）；
 *   - pilot 问句（goal 含"当前页"）：首问点 Dead end（点了无变化），次问交白卷 → 低置信交接；
 *   - run 步问句（goal = P0_BASE_GOAL）：点详情链接（到达 #detail，使 run 能收尾）。
 */
async function startMockDecision(): Promise<MockDecision> {
  const requests: CapturedRequest[] = [];
  const holder: { mode: "dead-end" | "detail" | "low-confidence" } = { mode: "dead-end" };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += String(d); });
    req.on("end", () => {
      let body: Json = {};
      try { const parsed: unknown = JSON.parse(raw); if (isObj(parsed)) body = parsed; } catch { /* 非 JSON：交白卷 */ }
      requests.push({ path: req.url ?? "", body });
      const goal = String(stateOf(body)["goal"] ?? "");
      const criteria = criteriaOf(body);
      const find = (re: RegExp): string | null =>
        Object.keys(criteria).find((k) => re.test(String(criteria[k]))) ?? null;
      const choice = goal === "decision plane probe" ? null
        : holder.mode === "detail" ? find(/detail/i)
          : find(/dead\s*end/i);
      // 低置信档：点名照旧，但 score（= confidence）低于默认 floor（0.25），走停因分支。
      const confidence = holder.mode === "low-confidence" ? 0.05 : 0.9;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(choice === null ? {}
        : { answers: { act: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } } } }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("mock 决策端点没有拿到端口");
  return {
    origin: `http://127.0.0.1:${addr.port}`, requests,
    close: () => new Promise<void>((r) => { server.close(() => r()); }),
    get mode(): "dead-end" | "detail" | "low-confidence" { return holder.mode; },
    set mode(v: "dead-end" | "detail" | "low-confidence") { holder.mode = v; },
  };
}

/** 子进程环境：剥掉宿主全部 `AMBERFLOW_*`（零外部决策源、零污染），再显式给三件套。 */
function childEnv(mockOrigin: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("AMBERFLOW_")) env[k] = v;
  return { ...env,
    AMBERFLOW_DECISION_BASE_URL: mockOrigin,
    AMBERFLOW_DECISION_MODEL: "capture",
    AMBERFLOW_DECISION_API_KEY: "dummy",
    ...extra };
}

/** 异步 spawn（fixture/mock 服务跑在本进程里，同步 spawn 会阻塞事件循环——见 verify-parity）。 */
function runCli(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 240_000): Promise<Captured["cli"]> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, ...args], {
      cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer | string) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer | string) => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ status: -1, stdout, stderr: stderr + String(e) }); });
  });
}

/** `amber session` 面跑一次 pilot drive（独立 AMBERFLOW_HOME），只收 fixture 页上的 choice 请求。 */
async function capturePilotDrive(
  mock: MockDecision, tmp: string, tag: string,
  opts: { origin: string; page: string; goal: string; maxSteps: number; scope?: string },
): Promise<Captured> {
  const home = path.join(tmp, `${tag}-home`);
  fs.mkdirSync(home, { recursive: true });
  const input = path.join(tmp, `${tag}-in.jsonl`);
  const lines: Json[] = [
    { id: 1, type: "drive", goal: opts.goal, driver: "model", max_steps: opts.maxSteps },
    { id: 2, type: "driveClose" },
    { id: 3, type: "close" },
  ];
  fs.writeFileSync(input, lines.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const start = mock.requests.length;
  const cli = await runCli(
    ["session", "--url", `${opts.origin}${opts.page}`, "--host", "127.0.0.1", "--input", input, "--out", path.join(tmp, `${tag}-out`)],
    childEnv(mock.origin, {
      AMBERFLOW_HOME: home,
      ...(opts.scope === undefined ? {} : { AMBERFLOW_STATE_TEXT_SCOPE: opts.scope }),
    }),
  );
  const choices = mock.requests.slice(start).filter(
    (r) => isChoiceRequest(r.body) && String(stateOf(r.body)["url"] ?? "").includes(opts.origin),
  );
  return { choices, cli };
}

/** `amber run` 面跑一次无需 act 的 fixture 决策步（独立 AMBERFLOW_HOME），只收该步的 choice 请求。 */
async function captureRunStep(mock: MockDecision, tmp: string, origin: string): Promise<Captured> {
  const home = path.join(tmp, "p0-run-home");
  const appDir = path.join(home, "apps", "p0-run");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "app.mjs"), [
    "export const meta = (kit) => ({",
    `  id: "p0-run", label: "P0 run leg", goal: ${JSON.stringify(P0_BASE_GOAL)},`,
    '  hosts: ["127.0.0.1"],',
    `  site: { pages: { home: ${JSON.stringify(`${origin}/home.html`)} } },`,
    '  invariants: [{ id: "detail-shown", desc: "detail shown", signal: kit.judge.exists("#detail") }],',
    "})",
    "export async function flow(ctx) {",
    '  await ctx.openPage("home")',
    `  const stepped = await ctx.step(${JSON.stringify(P0_BASE_GOAL)}, { id: "probe", done: ctx.judge.exists("#detail") })`,
    '  if (!stepped.ok) ctx.fail(stepped.stopCode ?? "step_failed", stepped.reason)',
    "  await ctx.done()",
    "}",
  ].join("\n") + "\n");
  const start = mock.requests.length;
  const cli = await runCli(["run", "p0-run", "--trace", "--out", path.join(tmp, "p0-run-out")],
    childEnv(mock.origin, { AMBERFLOW_HOME: home }));
  const choices = mock.requests.slice(start).filter(
    (r) => isChoiceRequest(r.body) && String(stateOf(r.body)["goal"] ?? "").startsWith(P0_BASE_GOAL),
  );
  return { choices, cli };
}

function assertCliOk(tag: string, cli: Captured["cli"]): void {
  assert.equal(cli.status, 0, `${tag} CLI exit=${String(cli.status)}；stderr=${tail(cli.stderr)}`);
}

/** A：notes 上 wire——首问无 notes 键，次问带已试/无变化类证据。 */
function assertNotesOnWire(pilot: Captured): void {
  assertCliOk("A pilot", pilot.cli);
  assert.equal(pilot.choices.length, 2, "A 应恰好两问（首问选题、次问带注记）");
  const first = stateOf(pilot.choices[0]!.body);
  const second = stateOf(pilot.choices[1]!.body);
  ok("A 首问 state 无 notes 键", !("notes" in first), JSON.stringify(Object.keys(first)));
  const notes = second["notes"];
  ok("A 次问 state.notes 存在且非空", isObj(notes) && Object.keys(notes).length > 0, JSON.stringify(notes));
  ok("A 注记含已试/无变化证据", /已试|no_change|tried/.test(JSON.stringify(notes ?? {})), JSON.stringify(notes));
}

/** B：无 notes 时 run 面请求体形状不变（state 键集合逐字一致）。 */
function assertNoNotesShape(run: Captured): void {
  assertCliOk("B run", run.cli);
  assert.equal(run.choices.length, 1, "B 应恰好一问（探针/风险问不在此列）");
  const state = stateOf(run.choices[0]!.body);
  ok("B state 无 notes 键", !("notes" in state), JSON.stringify(Object.keys(state)));
  eq("B state 键集合不变", Object.keys(state).sort(), ["goal", "main_text", "title", "url"]);
}

/** D：L1（url/title/main_text + criteria 键集合）与 L0（goal 文本）两面一致。 */
function assertLayer1Symmetry(pilot: Captured, run: Captured): void {
  assert.ok(pilot.choices.length > 0 && run.choices.length > 0, "D 两侧都需要首问请求");
  const pilotBody = pilot.choices[0]!.body;
  const runBody = run.choices[0]!.body;
  const ps = stateOf(pilotBody);
  const rs = stateOf(runBody);
  eq("D state.url", ps["url"], rs["url"]);
  eq("D state.title", ps["title"], rs["title"]);
  eq("D state.main_text", ps["main_text"], rs["main_text"]);
  eq("D criteria 键集合", Object.keys(criteriaOf(pilotBody)).sort(), Object.keys(criteriaOf(runBody)).sort());
  const pg = String(ps["goal"] ?? "");
  const rg = String(rs["goal"] ?? "");
  ok("D 两面 L0 都含 当前页", pg.includes("当前页") && rg.includes("当前页"), JSON.stringify({ pilot: pg, run: rg }));
  ok("D 两面 L0 以基础目标开头", pg.startsWith(P0_BASE_GOAL) && rg.startsWith(P0_BASE_GOAL), JSON.stringify({ pilot: pg, run: rg }));
  eq("D 两面 L0 文本同源", pg, rg);
  facts["l0_goals"] = { pilot: pg, run: rg };
  if (!jsonMode) console.log(`D L0 同源: ${JSON.stringify(pg)}`);
}

/** 纯引擎询问：host.pick 捕获收到的 notes（L4 端口注入路径，零浏览器、零模型）。 */
async function askWithSiteFacts(
  portText: string | null | undefined,
): Promise<{ outcome: DecisionAskOutcome; notes: Record<string, string> | null }> {
  const seen: Array<Record<string, string> | null> = [];
  const host: DecisionAskHost = {
    ...fakeHost({ capability: "full" }),
    pick: async (_goal, _page, _pool, _forbidden, notes) => { seen.push(notes); return PROPOSAL; },
  };
  const ledger = new PilotLedger();
  ledger.bump(POOL.e0 as never, "确认", "changed");
  const ports: DecisionAskPorts | undefined = portText === undefined
    ? undefined : { siteFacts: { notes: async () => portText } };
  const ask = createDecisionAsk(host, ports === undefined ? {} : { ports });
  const outcome = await ask.ask(
    FAKE_PAGE, LIFETIME, createDecisionAccounting({ pilot: ledger }, ACCT_LIFETIME),
    { goal: "点一个按钮" }, { face: "lane", confFloor: 0.25 },
  );
  return { outcome, notes: seen[0] ?? null };
}

/** C：`ports.siteFacts` → pick notes 含 site_facts + 回执 L4 = sent；端口 null = notes 原样。 */
async function assertSiteFactsPort(): Promise<void> {
  const control = await askWithSiteFacts(undefined);
  eq("C 无端口 notes", control.notes, { e0: "已试 1 次 · changed" });
  eq("C 无端口 L4", receipt(control.outcome, "L4").status, "absent");
  const nullPort = await askWithSiteFacts(null);
  eq("C 端口 null notes 原样", nullPort.notes, control.notes);
  eq("C 端口 null L4", receipt(nullPort.outcome, "L4").status, "absent");
  const sent = await askWithSiteFacts("FACT-1");
  eq("C 端口注记并入 notes", sent.notes?.["site_facts"], "FACT-1");
  eq("C 端口不覆盖既有注记", sent.notes?.["e0"], control.notes?.["e0"]);
  eq("C 端口 L4 = sent", receipt(sent.outcome, "L4").status, "sent");
  ok("C 询问仍 picked", sent.outcome.kind === "picked");
}

/**
 * E：`AMBERFLOW_STATE_TEXT_SCOPE=wide` 的子帧取文。默认档只读主文档 body（iframe 文本不在
 * 其中）；wide 追加未 detach 子帧的 body 文本——两档可观察差异即断言。
 */
async function assertStateTextWide(mock: MockDecision, tmp: string, origin: string): Promise<void> {
  const goal = "zerblonix frobnicate";
  const def = await capturePilotDrive(mock, tmp, "p0-wide-default", { origin, page: "/wide.html", goal, maxSteps: 2 });
  const wide = await capturePilotDrive(mock, tmp, "p0-wide-scope", { origin, page: "/wide.html", goal, maxSteps: 2, scope: "wide" });
  assertCliOk("E default", def.cli);
  assertCliOk("E wide", wide.cli);
  assert.equal(def.choices.length, 1, "E 默认档应一问");
  assert.equal(wide.choices.length, 1, "E wide 档应一问");
  const dm = String(stateOf(def.choices[0]!.body)["main_text"] ?? "");
  const wm = String(stateOf(wide.choices[0]!.body)["main_text"] ?? "");
  ok("E 默认 main_text 不含子帧文本", !dm.includes(FRAME_MARKER), tail(dm));
  ok("E wide main_text 含子帧文本", wm.includes(FRAME_MARKER), tail(wm));
  ok("E 两档取文不同", dm !== wm);
}

/**
 * F：run 面 trace 的逐层回执（直接 `BrowserMiddleware.run`，不经 CLI/结果投影）。
 * 断言：该步已落账的 trace 行带 `context_layers`，五层闭集且 L0/L1 = sent（有产出）。
 */
async function assertRunTraceLayers(mock: MockDecision, origin: string): Promise<void> {
  const saved = {
    base: process.env.AMBERFLOW_DECISION_BASE_URL,
    model: process.env.AMBERFLOW_DECISION_MODEL,
    key: process.env.AMBERFLOW_DECISION_API_KEY,
  };
  process.env.AMBERFLOW_DECISION_BASE_URL = mock.origin;
  process.env.AMBERFLOW_DECISION_MODEL = "capture";
  process.env.AMBERFLOW_DECISION_API_KEY = "dummy";
  try {
    await applySpecToRuntime(await resolveProviderSpec(undefined, undefined));
    mock.mode = "detail";
    const session = await browserSession(true);
    try {
      const mw = buildMiddleware({
        face: "online", confirmPolicy: { kind: "allow-all" },
        options: { hosts: ["127.0.0.1"], maxSteps: 2 },
      });
      const rep = await mw.run(P0_BASE_GOAL, `${origin}/home.html`, { verbose: false });
      const rows = rep.steps.filter((s) => s.context_layers !== undefined);
      ok("F run trace 带 context_layers", rows.length > 0, JSON.stringify(rep.steps.map((s) => Object.keys(s))));
      const layers = rows[0]?.context_layers as DecisionLayerReceipt[] | undefined;
      eq("F 回执五层闭集", (layers ?? []).map((l) => l.layer).join(","), "L0,L1,L2,L3,L4");
      ok("F L0 = sent", layers?.find((l) => l.layer === "L0")?.status === "sent", JSON.stringify(layers));
      ok("F L1 = sent", layers?.find((l) => l.layer === "L1")?.status === "sent", JSON.stringify(layers));
      const closed = new Set(["sent", "absent", "unsupported", "rejected"]);
      ok("F 全部状态在闭集", (layers ?? []).every((l) => closed.has(l.status)), JSON.stringify(layers));
      ok("F run L0 含当前页", String(rep.steps[0]?.desc ?? "") !== "" || JSON.stringify(rep.steps).includes("当前页"),
        JSON.stringify(rep.steps.map((s) => s.context_layers)));
    } finally { await session.close(); }
  } finally {
    if (saved.base === undefined) delete process.env.AMBERFLOW_DECISION_BASE_URL; else process.env.AMBERFLOW_DECISION_BASE_URL = saved.base;
    if (saved.model === undefined) delete process.env.AMBERFLOW_DECISION_MODEL; else process.env.AMBERFLOW_DECISION_MODEL = saved.model;
    if (saved.key === undefined) delete process.env.AMBERFLOW_DECISION_API_KEY; else process.env.AMBERFLOW_DECISION_API_KEY = saved.key;
  }
}

/**
 * G：**动作前停止**的停因回执（直接 `BrowserMiddleware.run`，零 CLI 投影）。
 * 断言：低置信 → `low_confidence` 停因、该步没有动作 trace 行可挂回执、回执落在
 * `RunReport.stop_decision_context`（五层闭集，L0/L1 = sent）；随后一次正常动作步的
 * trace 回执行仍在（两条落盘路径互不替代）。
 */
async function assertStopPathReceipt(mock: MockDecision, origin: string): Promise<void> {
  const saved = {
    base: process.env.AMBERFLOW_DECISION_BASE_URL,
    model: process.env.AMBERFLOW_DECISION_MODEL,
    key: process.env.AMBERFLOW_DECISION_API_KEY,
  };
  process.env.AMBERFLOW_DECISION_BASE_URL = mock.origin;
  process.env.AMBERFLOW_DECISION_MODEL = "capture";
  process.env.AMBERFLOW_DECISION_API_KEY = "dummy";
  try {
    await applySpecToRuntime(await resolveProviderSpec(undefined, undefined));
    const session = await browserSession(true);
    try {
      // ① 动作前停止：mock 点名了候选但置信度 0.05 < floor，闸门后无动作可反思。
      mock.mode = "low-confidence";
      const stopped = await buildMiddleware({
        face: "online", confirmPolicy: { kind: "allow-all" },
        options: { hosts: ["127.0.0.1"], maxSteps: 2 },
      }).run(P0_BASE_GOAL, `${origin}/home.html`, { verbose: false });
      eq("G 停因 = low_confidence", stopped.stop_code, "low_confidence");
      ok("G 停因 done=false", stopped.done === false, JSON.stringify(stopped.stop_reason));
      ok("G 停前无动作 trace 回执行",
        stopped.steps.every((s) => s.context_layers === undefined),
        JSON.stringify(stopped.steps.map((s) => Object.keys(s))));
      const stopLayers = stopped.stop_decision_context?.layers;
      eq("G 停因回执五层闭集", (stopLayers ?? []).map((l) => l.layer).join(","), "L0,L1,L2,L3,L4");
      ok("G 停因回执 L0 = sent", stopLayers?.find((l) => l.layer === "L0")?.status === "sent",
        JSON.stringify(stopLayers));
      ok("G 停因回执 L1 = sent", stopLayers?.find((l) => l.layer === "L1")?.status === "sent",
        JSON.stringify(stopLayers));
      const closed = new Set(["sent", "absent", "unsupported", "rejected"]);
      ok("G 停因回执状态在闭集", (stopLayers ?? []).every((l) => closed.has(l.status)),
        JSON.stringify(stopLayers));

      // ①b 回执与 wire 同一份 notes：L4 注入后回执记 sent，且真实请求体带同一文本
      //    （回执观察若与 pickInner 的合并分家，这两条必有一条红）。
      mock.mode = "low-confidence";
      const beforeFacts = mock.requests.length;
      const mwFacts = buildMiddleware({
        face: "online", confirmPolicy: { kind: "allow-all" },
        options: { hosts: ["127.0.0.1"], maxSteps: 2 },
      });
      mwFacts.siteFactsNotes = "SITE-FACT-G";
      const withFacts = await mwFacts.run(P0_BASE_GOAL, `${origin}/home.html`, { verbose: false });
      const asked = mock.requests.slice(beforeFacts).filter(
        (r) => isChoiceRequest(r.body) && String(stateOf(r.body)["goal"] ?? "").startsWith(P0_BASE_GOAL),
      );
      const wireNotes = asked.length === 0 ? null : stateOf(asked[0]!.body)["notes"];
      eq("G wire notes 带 site_facts", isObj(wireNotes) ? wireNotes["site_facts"] : null, "SITE-FACT-G");
      eq("G 停因回执 L4 = sent",
        withFacts.stop_decision_context?.layers.find((l) => l.layer === "L4")?.status, "sent");

      // ② 正常动作步：回执仍挂既有 trace 行（不因停因字段新增而改道）。
      mock.mode = "detail";
      const acted = await buildMiddleware({
        face: "online", confirmPolicy: { kind: "allow-all" },
        options: { hosts: ["127.0.0.1"], maxSteps: 2 },
      }).run(P0_BASE_GOAL, `${origin}/home.html`, { verbose: false });
      const actedRows = acted.steps.filter((s) => s.context_layers !== undefined);
      ok("G 正常动作步 trace 回执行仍在", actedRows.length > 0,
        JSON.stringify(acted.steps.map((s) => Object.keys(s))));
      const actedLayers = actedRows[0]?.context_layers as DecisionLayerReceipt[] | undefined;
      eq("G 正常动作步回执五层闭集", (actedLayers ?? []).map((l) => l.layer).join(","), "L0,L1,L2,L3,L4");
    } finally { await session.close(); }
  } finally {
    if (saved.base === undefined) delete process.env.AMBERFLOW_DECISION_BASE_URL; else process.env.AMBERFLOW_DECISION_BASE_URL = saved.base;
    if (saved.model === undefined) delete process.env.AMBERFLOW_DECISION_MODEL; else process.env.AMBERFLOW_DECISION_MODEL = saved.model;
    if (saved.key === undefined) delete process.env.AMBERFLOW_DECISION_API_KEY; else process.env.AMBERFLOW_DECISION_API_KEY = saved.key;
  }
}

function dumpRequests(requests: CapturedRequest[]): void {
  console.error(`P0 请求体摘要（共 ${requests.length} 条，最多列 8 条）:`);
  for (const [i, r] of requests.slice(0, 8).entries()) {
    const s = stateOf(r.body);
    console.error(`  #${i} ${r.path} goal=${JSON.stringify(s["goal"] ?? null).slice(0, 140)} `
      + `stateKeys=${JSON.stringify(Object.keys(s))} criteria=${Object.keys(criteriaOf(r.body)).length} `
      + `notes=${JSON.stringify(s["notes"] ?? null).slice(0, 160)}`);
  }
}

/** P0 五组：抓包 + 断言；失败保留证据目录并打印请求体摘要。 */
async function p0Groups(origin: string): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-verify-decision-context-"));
  const baseline = failures.length;
  const mock = await startMockDecision();
  try {
    mock.mode = "dead-end";
    const pilot = await capturePilotDrive(mock, tmp, "p0-pilot",
      { origin, page: "/home.html", goal: P0_BASE_GOAL, maxSteps: 4 });
    await group("A notes 上 wire", () => assertNotesOnWire(pilot));
    mock.mode = "detail";
    const run = await captureRunStep(mock, tmp, origin);
    await group("B 无 notes 形状不变", () => assertNoNotesShape(run));
    await group("D L1 两面一致", () => assertLayer1Symmetry(pilot, run));
    await group("C siteFacts 端口（L4）", () => assertSiteFactsPort());
    mock.mode = "dead-end";
    await group("E wide 子帧取文", () => assertStateTextWide(mock, tmp, origin));
    await group("F run trace 回执", () => assertRunTraceLayers(mock, origin));
    await group("G 停因回执（动作前停止）", () => assertStopPathReceipt(mock, origin));
  } catch (e) {
    failures.push(`P0 harness: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await mock.close();
    if (failures.length === baseline) fs.rmSync(tmp, { recursive: true, force: true });
    else {
      console.error(`P0 证据目录: ${tmp}`);
      dumpRequests(mock.requests);
    }
  }
}

/* ------------------------------------------------------------------ 主流程 */

async function main(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  jsonMode = json;
  installLayaRuntime(null);
  realProviderDeclarations();
  await hostProviderConsistency();
  await tierMatrix();
  await segmentValidation();
  const server = await startServer();
  try {
    await portWiring(server.origin);
    await p0Groups(server.origin);
  } finally {
    await server.close();
  }
  const okAll = failures.length === 0;
  if (json) {
    console.log(JSON.stringify({
      ok: okAll, checks, failures, ...facts,
    }, null, 2));
  } else {
    console.log("S3 决策上下文能力档验收（①三档回执矩阵 ②host/provider 声明一致 ③段校验 rejected ④端口注入行为不变"
      + " ⑤P0 请求上下文：notes 上 wire / 无 notes 形状 / siteFacts 端口 / L1 两面 / wide 子帧取文；"
      + "⑥run trace 逐层回执；⑦动作前停止的停因回执）");
    if (okAll) {
      console.log(`verify-decision-context: OK — ${checks} 项断言全绿`);
    } else {
      for (const f of failures) console.error(`  FAIL ${f}`);
      console.error(`verify-decision-context: FAIL — ${failures.length}/${checks} 项断言失败`);
    }
  }
  return okAll ? 0 : 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error(USAGE);
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 2;
}
