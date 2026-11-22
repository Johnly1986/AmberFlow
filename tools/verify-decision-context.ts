/**
 * S3 决策上文能力档验收 lane（非门禁、零外部网络）：把 DC4 的"可声明、可消费、可审计"钉成可比事实。
 *
 * 四组断言：
 *   ① 三档声明（none/minimal/full）+ 未声明 × L0–L4：逐层回执状态闭集
 *      （sent / absent / unsupported / rejected），且 absent 与 unsupported 可区分；
 *   ② host 声明与 provider capabilities 一致：真实 provider 的 `context` 声明表 + host 回声；
 *   ③ 未注册 face / 未注册段 / 层不符 → 回执 rejected，且**询问不 abort**（picked 语义不变）；
 *   ④ `buildMiddleware` 注入 `decisionAskPorts` 后 ask 的 picked/abstained 行为与不注入逐字段一致，
 *      但 full 档 provider 的回执随声明变成 absent（证明端口/声明真的进了引擎）。
 *
 * ①–③ 用纯 fake host（零浏览器、零模型）；④ 用内存页 + 确定性 stub provider。
 *
 * 用法：node --experimental-strip-types tools/verify-decision-context.ts [--json]
 * 退出码：0 = 四组全绿；1 = 有断言失败；2 = 用法/环境错误。
 */
import http from "node:http";
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

async function startServer(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
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

/* ------------------------------------------------------------------ 主流程 */

async function main(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  installLayaRuntime(null);
  realProviderDeclarations();
  await hostProviderConsistency();
  await tierMatrix();
  await segmentValidation();
  const server = await startServer();
  try {
    await portWiring(server.origin);
  } finally {
    await server.close();
  }
  const okAll = failures.length === 0;
  if (json) {
    console.log(JSON.stringify({ ok: okAll, checks, failures }, null, 2));
  } else {
    console.log("S3 决策上下文能力档验收（①三档回执矩阵 ②host/provider 声明一致 ③段校验 rejected ④端口注入行为不变）");
    if (okAll) console.log(`verify-decision-context: OK — ${checks} 项断言全绿`);
    else {
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
