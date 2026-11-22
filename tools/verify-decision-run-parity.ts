/**
 * run 面选择段 parity lane（非门禁）：把**同一份 host/ctx 输入**分别喂给
 *   - 对照臂：`executor-phases-b.ts` 的 `runModelPick`（deprecated；执行路径已切到新实现，本 lane 仍驱动它做对照）；
 *   - 新臂：`decision-pick-phase.ts` 的 `runDecisionPick`（按分支拆分后的实现），
 * 逐字段比较 `ModelPickPhase` 全字段、桩侧请求投影、`windowChainFacts`、`rejectedAskConfs`、
 * `warnings` 与结构化停因（code/reason）。差异必须为零；首现差异逐条打印并 exit 1。
 *
 * 为什么能这样对照：`runModelPick` 的 executor 原语全部经参数注入（只有宽扫抽取读 `mw.candidates`），
 * 因此本 lane 用 `buildMiddleware` 真实装配 mw，并把同一批原语（pickElement/orderedPool/
 * settleBeforeExtract/pruneForbids/hintOpts/stateText/停因记账…）同时交给两臂。两臂共享页面、
 * 共享桩剧本；每臂各自一份 `RunAccounting`（forbidden/停因/窗口链事实互不污染）。
 *
 * 用法：node --experimental-strip-types tools/verify-decision-run-parity.ts [--list]
 * 退出码：0 全场景零差异 / 1 有差异 / 2 用法或环境错误。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { browserSession, type BrowserMiddleware, type ModelPickPhase } from "../src/engine/executor.ts";
import { buildMiddleware } from "../src/app/middleware-factory.ts";
import { installLayaRuntime } from "../src/model/model.ts";
import { installDecisionProvider } from "../src/model/decision-provider.ts";
import { runModelPick } from "../src/engine/executor-phases-b.ts";
import type { RunPickArgs } from "../src/engine/decision-pick-host.ts";
import { runDecisionPick, type RunPickCtx, type RunPickHost } from "../src/engine/decision-pick-phase.ts";
import { createRunAccounting } from "../src/engine/run-context.ts";
import { _hintOpts } from "../src/engine/executor-resolve-a.ts";
import { stateText, type Elem, type ElemFamily, type ElemPool, orderElemsByFamily } from "../src/engine/extraction.ts";
import type { WindowChainFact } from "../src/engine/executor-pure.ts";
import type { DeclaredTargetsResolver } from "../src/engine/declared-targets.ts";
import { makeStubProvider, type StubRequestSnapshot, type StubTurn } from "./stub-decision-provider.ts";
import type { AnyPage } from "../src/engine/executor-types.ts";

const USAGE = "usage: node --experimental-strip-types tools/verify-decision-run-parity.ts [--list]";

/* ------------------------------------------------------------------ 页面 */

const CARDS_HTML = `<!doctype html><html><body>
<button id="b1">确认</button><button id="b2">取消</button><button id="b3">详情</button>
<a id="help" href="/help">帮助</a><input id="q" name="q">
</body></html>`;

const WIDE_HTML = `<!doctype html><html><body>${Array.from({ length: 100 }, (_, i) =>
  `<button id="b${i + 1}">按钮 ${i + 1}</button>`).join("")}</body></html>`;

/** 180 个候选：64 池 → 128 档 → 硬顶（256 档预算内实际 180）仍低于 MAX_CHOICES=200，三次问票都发得出去。 */
const WIDE180_HTML = `<!doctype html><html><body>${Array.from({ length: 180 }, (_, i) =>
  `<button id="w${i + 1}">宽按钮 ${i + 1}</button>`).join("")}</body></html>`;

const FAMILY_HTML = `<!doctype html><html><body>
<button id="go">继续</button>
<label>甲<input type="checkbox" id="c1"></label>
<label>乙<input type="checkbox" id="c2"></label>
</body></html>`;

const EMPTY_HTML = `<!doctype html><html><body></body></html>`;

interface PageServer { origin: string; close(): Promise<void> }

async function startServer(pages: Record<string, string>): Promise<PageServer> {
  const server = http.createServer((req, res) => {
    const body = pages[new URL(req.url ?? "/", "http://127.0.0.1").pathname];
    if (body === undefined) { res.statusCode = 404; res.end("not found"); return; }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(body);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("页面服务没有拿到端口");
  return { origin: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => { server.close(() => r()); }) };
}

/* ------------------------------------------------------------------ 装配 */

interface Stub { requests: StubRequestSnapshot[]; reset(): void }

async function withMw<T>(turns: (snap: StubRequestSnapshot) => StubTurn,
  run: (ctx: { mw: BrowserMiddleware; page: AnyPage; stub: Stub }) => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "af-parity-home-"));
  Object.assign(process.env, { AMBERFLOW_HOME: home });
  installLayaRuntime(null);
  const stub = makeStubProvider(turns);
  installDecisionProvider(stub.provider);
  const session = await browserSession(true);
  const page = session.page;
  const mw = buildMiddleware({
    face: "online", confirmPolicy: { kind: "allow-all" },
    options: { hosts: ["127.0.0.1"], maxSteps: 3, gotoTimeout: 15_000, confFloor: 0.5 },
  });
  try {
    return await run({ mw, page, stub });
  } finally {
    await session.close();
    installDecisionProvider(null);
  }
}

/** 两臂共用的输入形状（host 原语之外的本步输入）。 */
interface DriveSpec {
  instruction: string;
  elems: ElemPool;
  ruleRef?: string | null;
  curHint?: string | null;
  adjudicate?: boolean;
  reobserve?: boolean;
  escalate?: boolean;
  expectedFamily?: ElemFamily | null;
  tieredHint?: boolean;
  /** 模拟"无模型运行时"：mw.rulesOnly 与 ctx.rulesOnly 同时置真（与 run() 降级同构）。 */
  rulesOnly?: boolean;
}

interface ArmResult {
  phase: ModelPickPhase;
  asks: unknown[];
  windowChainFacts: WindowChainFact[];
  rejectedAskConfs: number[];
  warnings: string[];
  stopCode: string;
  stopReason: string;
}

/** 本 lane 不验证 FW8/DRF：只提供被测分支会读的字段（缺省证据 = null）。 */
function fakeTargets(): DeclaredTargetsResolver {
  return {
    identity: null, identityStop: null, identityHidden: null, declaredStop: null,
    declaredHidden: null, declaredMiss: null,
    getDeclaredHidden: () => null,
  } as unknown as DeclaredTargetsResolver;
}

/** 用真实 mw 原语装配 host（与 run() 闭包里的注入面同源）。 */
function makeHost(mw: BrowserMiddleware, acct: ReturnType<typeof createRunAccounting>, spec: DriveSpec): RunPickHost {
  const orderedPool = (pool?: ElemPool): ElemPool => {
    const base = pool ?? spec.elems;
    return spec.expectedFamily == null ? base : orderElemsByFamily(base, spec.expectedFamily);
  };
  return {
    pickElement: (g, p, pool, blocked, notes) => mw.pickElement(g, p, pool, blocked, notes),
    orderedPool,
    settleBeforeExtract: (p) => mw._settleBeforeExtract(p),
    pruneForbids: (pool) => acct.pruneForbids(pool),
    hintOpts: () => _hintOpts(mw),
    frameHosts: null,
    stateTextFn: (p, instr) => stateText(p, instr, null),
    rowAnchorNote: () => "",
    declaredTargets: () => [],
    goalHeld: async () => false,
    goalSignalFn: null,
    isTyping: (el) => mw._isTyping(el),
    modelLabel: () => mw.modelLabel(),
    degradedReasonSuffix: () => mw.degradedReasonSuffix(),
    choiceLimitReason: () => mw._choiceLimitReason,
    clearChoiceLimitReason: () => { mw._choiceLimitReason = null; },
    stop: (code, detail, at) => acct.stop(code, detail, at),
    stopReason: () => acct.stopReason,
    stepTimeoutLeft: () => 30_000,
    candidatesExtract: (req) => mw.candidates!.extract(req),
  };
}

function makeCtx(page: AnyPage, spec: DriveSpec, host: RunPickHost, acct: ReturnType<typeof createRunAccounting>): RunPickCtx {
  return {
    pg: page, stepNo: 1, instruction: spec.instruction, verbose: false, elems: spec.elems,
    ruleRef: spec.ruleRef ?? null, curHint: spec.curHint ?? null, commandMode: false,
    forbidden: acct.forbidden, noted: null, targets: fakeTargets(), trace: [],
    adjudicate: spec.adjudicate === true, reobserve: spec.reobserve !== false,
    escalateFn: spec.escalate === true ? (req) => Object.keys(req.criteria)[0] ?? null : null,
    expectedFamily: spec.expectedFamily ?? null, confFloor: 0.5, candidatePriority: "bucketed",
    tieredHint: spec.tieredHint === true, rulesOnly: spec.rulesOnly === true, decisionDegradedReasonClass: null,
    rejectedAskConfs: [], warnings: [], reobserved: false, escalated: false, escalatedPick: null,
    windowChainFacts: [],
  };
}

const LOCAL_RE = /http:\/\/127\.0\.0\.1:\d+/g;

function normalize(v: unknown): unknown {
  if (typeof v === "string") return v.replace(LOCAL_RE, "<LOCAL>");
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) out[key] = normalize((v as Record<string, unknown>)[key]);
    return out;
  }
  return v;
}

/** 桩侧请求投影（候选只留前 4 条；数量单列）。 */
function requestFact(snap: StubRequestSnapshot): Record<string, unknown> {
  return {
    seq: snap.seq, goal: snap.goal, url: snap.url, k: snap.k, narrow: snap.narrow,
    candidate_count: snap.candidates.length,
    candidates_head: snap.candidates.slice(0, 4),
    forbidden: snap.forbidden, notes: snap.notes,
  };
}

/** `ModelPickPhase` 全字段投影（elems 只投影 ref 序 + tag/label）。 */
function phaseFact(p: ModelPickPhase): Record<string, unknown> {
  return {
    stopped: p.stopped, ref: p.ref, conf: p.conf, method: p.method, decisionKind: p.decisionKind,
    layaMargin: p.layaMargin, tierAsk: p.tierAsk, nominatedRepair: p.nominatedRepair,
    escalatedPick: p.escalatedPick, label: p.label,
    elems: Object.entries(p.elems).map(([ref, el]) => ({ ref, tag: el.tag, label: el.label })),
  };
}

function armFact(a: ArmResult): Record<string, unknown> {
  return {
    phase: phaseFact(a.phase),
    asks: a.asks,
    windowChainFacts: a.windowChainFacts,
    rejectedAskConfs: a.rejectedAskConfs,
    warnings: a.warnings,
    stop: { code: a.stopCode, reason: a.stopReason },
  };
}

/* ------------------------------------------------------------------ 双驱动 */

function collectArm(phase: ModelPickPhase, ctx: RunPickCtx, acct: ReturnType<typeof createRunAccounting>, stub: Stub): ArmResult {
  return {
    phase,
    asks: stub.requests.map(requestFact),
    windowChainFacts: [...ctx.windowChainFacts],
    rejectedAskConfs: [...ctx.rejectedAskConfs],
    warnings: [...ctx.warnings],
    stopCode: acct.stopCode,
    stopReason: acct.stopReason,
  };
}

/** 同一 spec 依次驱动两臂；每臂各自新账本/新 host/新 ctx，桩请求在臂间清零。 */
async function driveBoth(mw: BrowserMiddleware, page: AnyPage, stub: Stub, spec: DriveSpec): Promise<{ old: ArmResult; next: ArmResult }> {
  // run() 在 runSetup 就解析过 provider；两臂必须在同一"已 ready"状态下取 modelLabel，
  // 否则首臂的懒解析会让第二臂多出一个标签差异（与实现无关的装配噪声）。
  await mw.ready();
  // 对照臂：现状实现（executor 当前调用点用的就是它）。
  stub.reset();
  mw._choiceLimitReason = null;
  mw.rulesOnly = spec.rulesOnly === true;
  const acctOld = createRunAccounting({ maxSteps: 3 });
  const hostOld = makeHost(mw, acctOld, spec);
  const ctxOld = makeCtx(page, spec, hostOld, acctOld);
  // 用 `RunPickArgs`（装配层与两臂共用的实参面）显式标注：结构漂移会在此处编译期报错。
  const oldArgs: RunPickArgs = {
    pg: ctxOld.pg, stepNo: ctxOld.stepNo, instruction: ctxOld.instruction, verbose: ctxOld.verbose,
    elems: ctxOld.elems, ruleRef: ctxOld.ruleRef, curHint: ctxOld.curHint, commandMode: ctxOld.commandMode,
    forbidden: ctxOld.forbidden, noted: ctxOld.noted, targets: ctxOld.targets, trace: ctxOld.trace,
    adjudicate: ctxOld.adjudicate, reobserve: ctxOld.reobserve, escalateFn: ctxOld.escalateFn,
    expectedFamily: ctxOld.expectedFamily, confFloor: ctxOld.confFloor, candidatePriority: ctxOld.candidatePriority,
    tieredHint: ctxOld.tieredHint, rulesOnly: ctxOld.rulesOnly,
    decisionDegradedReasonClass: ctxOld.decisionDegradedReasonClass, rejectedAskConfs: ctxOld.rejectedAskConfs,
    warnings: ctxOld.warnings, reobserved: ctxOld.reobserved, escalated: ctxOld.escalated,
    escalatedPick: ctxOld.escalatedPick, windowChainFacts: ctxOld.windowChainFacts,
    stepTimeoutLeft: hostOld.stepTimeoutLeft, stop: hostOld.stop, stopReason: hostOld.stopReason,
    pickElement: hostOld.pickElement, orderedPool: hostOld.orderedPool,
    settleBeforeExtract: hostOld.settleBeforeExtract, pruneForbids: hostOld.pruneForbids,
    hintOpts: hostOld.hintOpts, frameHosts: hostOld.frameHosts, stateTextFn: hostOld.stateTextFn,
    rowAnchorNote: hostOld.rowAnchorNote, declaredTargets: hostOld.declaredTargets,
    goalHeld: hostOld.goalHeld, goalSignalFn: hostOld.goalSignalFn, isTyping: hostOld.isTyping,
    modelLabel: hostOld.modelLabel, degradedReasonSuffix: hostOld.degradedReasonSuffix,
    choiceLimitReason: hostOld.choiceLimitReason, clearChoiceLimitReason: hostOld.clearChoiceLimitReason,
  };
  const oldPhase = await runModelPick(mw, oldArgs);
  const oldArm = collectArm(oldPhase, ctxOld, acctOld, stub);

  // 新臂：同一 host/ctx 输入，直接驱动拆分后的实现。
  stub.reset();
  mw._choiceLimitReason = null;
  mw.rulesOnly = spec.rulesOnly === true;
  const acctNext = createRunAccounting({ maxSteps: 3 });
  const hostNext = makeHost(mw, acctNext, spec);
  const ctxNext = makeCtx(page, spec, hostNext, acctNext);
  const nextPhase = await runDecisionPick(hostNext, ctxNext);
  const nextArm = collectArm(nextPhase, ctxNext, acctNext, stub);
  return { old: oldArm, next: nextArm };
}

/* ------------------------------------------------------------------ 差异 */

/** 递归差异（排序键无关；数组按下标）；返回 `path: old !== new` 行。 */
function diff(a: unknown, b: unknown, at = "$"): string[] {
  if (Object.is(a, b)) return [];
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    return [`${at}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`];
  }
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return [`${at}: ${aArr ? "array" : "object"} !== ${bArr ? "array" : "object"}`];
  const out: string[] = [];
  if (aArr && bArr) {
    if (a.length !== b.length) out.push(`${at}.length: ${a.length} !== ${b.length}`);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) out.push(...diff(a[i], b[i], `${at}[${i}]`));
    return out;
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  for (const k of ka) {
    if (!(k in (b as Record<string, unknown>))) { out.push(`${at}.${k}: present !== missing`); continue; }
    out.push(...diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`));
  }
  for (const k of kb) if (!(k in (a as Record<string, unknown>))) out.push(`${at}.${k}: missing !== present`);
  return out;
}

/* ------------------------------------------------------------------ 场景 */

interface Case {
  name: string;
  page: string;
  turns: (snap: StubRequestSnapshot) => StubTurn;
  run(ctx: { mw: BrowserMiddleware; page: AnyPage; stub: Stub; origin: string }): Promise<{ old: ArmResult; next: ArmResult }>;
}

const CASES: Case[] = [
  {
    name: "rule-hit",
    page: "/cards.html",
    turns: () => ({ score: 0.1 }),
    run: async ({ mw, page, stub, origin }) => {
      await page.goto(`${origin}/cards.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const ruleRef = Object.keys(elems)[0] ?? null;
      const r = await driveBoth(mw, page, stub, { instruction: "点击确认", elems: elems as ElemPool, ruleRef, curHint: "#b1" });
      assertRuleClean(r.old);
      return r;
    },
  },
  {
    name: "tiered-narrow-fallback",
    page: "/cards.html",
    turns: (snap) => (snap.seq === 0 ? { score: 0.05, passthrough: false, probs: { p: 0.05 } } : { score: 0.9, passthrough: true }),
    run: async ({ mw, page, stub, origin }) => {
      await page.goto(`${origin}/cards.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await driveBoth(mw, page, stub, { instruction: "选一个", elems: elems as ElemPool, curHint: "button", tieredHint: true });
      // 窄问弃权 → 全池重问：第二问的候选数必须更大（否则档位没被触发）。
      const n0 = (r.old.asks[0] as { candidate_count: number }).candidate_count;
      const n1 = (r.old.asks[1] as { candidate_count: number }).candidate_count;
      if (!(n1 > n0)) throw new Error(`tiered 档位未触发：${n0} -> ${n1}`);
      if (r.old.phase.tierAsk !== null) throw new Error("窄问弃权后 tierAsk 必须清空");
      return r;
    },
  },
  {
    name: "tiered-narrow-hit",
    page: "/cards.html",
    turns: () => ({ score: 0.9, passthrough: false, probs: { p: 0.9 } }),
    run: async ({ mw, page, stub, origin }) => {
      await page.goto(`${origin}/cards.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await driveBoth(mw, page, stub, { instruction: "选一个", elems: elems as ElemPool, curHint: "button", tieredHint: true });
      // 窄问一次过闸：只问一次，tierAsk 随返回值交回（诊断字段的命中路径）。
      if (r.old.asks.length !== 1) throw new Error(`窄问命中不应回退全池（实际 ${r.old.asks.length} 问）`);
      if (r.old.phase.tierAsk === null) throw new Error("窄问命中后 tierAsk 必须非空");
      return r;
    },
  },
  {
    name: "low-conf-wide-reobserve",
    page: "/wide.html",
    turns: (snap) => (snap.seq === 0 ? { score: 0.05, passthrough: false, probs: { p: 0.05 } } : { score: 0.95, passthrough: true }),
    run: async ({ mw, page, stub, origin }) => {
      await page.goto(`${origin}/wide.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await driveBoth(mw, page, stub, { instruction: "点一个按钮", elems: elems as ElemPool });
      if (!String(r.old.phase.method).includes("reobserve")) throw new Error("低置信宽扫未触发");
      if (r.old.windowChainFacts.length === 0) throw new Error("窗口链事实缺失");
      return r;
    },
  },
  {
    name: "escalate",
    page: "/wide.html",
    turns: () => ({ score: 0.05, passthrough: false, probs: { p: 0.05 } }),
    run: async ({ mw, page, stub, origin }) => {
      await page.goto(`${origin}/wide.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await driveBoth(mw, page, stub, { instruction: "点一个按钮", elems: elems as ElemPool, reobserve: false, escalate: true });
      if (r.old.phase.decisionKind !== "escalate") throw new Error("升级票未命中");
      return r;
    },
  },
  {
    name: "adjudicate",
    page: "/wide.html",
    turns: () => ({ score: 0.05, passthrough: false, probs: { p: 0.05 } }),
    run: async ({ mw, page, stub, origin }) => {
      await page.goto(`${origin}/wide.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await driveBoth(mw, page, stub, { instruction: "点一个按钮", elems: elems as ElemPool, reobserve: false, adjudicate: true });
      if (!String(r.old.phase.method).endsWith(":adjudicated")) throw new Error("裁决档未触发");
      return r;
    },
  },
  {
    name: "r2b",
    page: "/wide.html",
    turns: (snap) => (snap.seq === 0 ? { score: 0.6, passthrough: true } : { score: 0.95, passthrough: true }),
    run: async ({ mw, page, stub, origin }) => {
      await page.goto(`${origin}/wide.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await driveBoth(mw, page, stub, { instruction: "zzz qqq", elems: elems as ElemPool });
      if (r.old.asks.length !== 2) throw new Error(`R2b 应触发一次宽扫重问（实际 ${r.old.asks.length} 问）`);
      return r;
    },
  },
  {
    name: "family-repair",
    page: "/family.html",
    turns: (snap) => {
      if (snap.seq === 0) {
        const btn = snap.candidates.find((c) => c.tag === "button");
        return { ref: btn?.ref ?? undefined, score: 0.9, passthrough: true, probs: { p: 0.9 } };
      }
      return { score: 0.9, passthrough: true };
    },
    run: async ({ mw, page, stub, origin }) => {
      await page.goto(`${origin}/family.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await driveBoth(mw, page, stub, { instruction: "选一个", elems: elems as ElemPool, expectedFamily: "check" });
      if (!r.old.phase.nominatedRepair) throw new Error("族修复未触发");
      return r;
    },
  },
  {
    name: "family-empty",
    page: "/cards.html",
    turns: () => ({ score: 0.9, passthrough: true }),
    run: async ({ mw, page, stub, origin }) => {
      await page.goto(`${origin}/cards.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await driveBoth(mw, page, stub, { instruction: "选一个", elems: elems as ElemPool, expectedFamily: "check" });
      if (r.old.stopCode !== "nominated_family_empty") throw new Error(`族空停因缺失（实际 ${r.old.stopCode}）`);
      return r;
    },
  },
  {
    name: "choice-limit",
    page: "/empty.html",
    turns: () => ({ score: 0.9, passthrough: true }),
    run: async ({ mw, page, stub }) => {
      // 决策服务候选上限 255（引擎 MAX_CHOICES=200）：合成超限池直接打到结构化停因分支。
      const elems: ElemPool = {};
      for (let i = 0; i < 250; i += 1) elems[`e${i}`] = { tag: "button", label: `选项 ${i}` } as unknown as Elem;
      const r = await driveBoth(mw, page, stub, { instruction: "选一个", elems });
      if (r.old.stopCode !== "decision_service_choice_limit") throw new Error(`候选超限停因缺失（实际 ${r.old.stopCode}）`);
      return r;
    },
  },
  {
    name: "low-confidence-stop",
    page: "/wide.html",
    turns: () => ({ score: 0.05, passthrough: false, probs: { p: 0.05 } }),
    run: async ({ mw, page, stub, origin }) => {
      await page.goto(`${origin}/wide.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await driveBoth(mw, page, stub, { instruction: "点一个按钮", elems: elems as ElemPool, reobserve: false });
      if (r.old.stopCode !== "low_confidence") throw new Error(`低置信停因缺失（实际 ${r.old.stopCode}）`);
      return r;
    },
  },
  {
    name: "unknown-ref",
    page: "/cards.html",
    turns: () => ({ score: 0.9, passthrough: true }),
    run: async ({ mw, page, stub, origin }) => {
      await page.goto(`${origin}/cards.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await driveBoth(mw, page, stub, { instruction: "点击确认", elems: elems as ElemPool, ruleRef: "e999", curHint: "#b1" });
      if (r.old.stopCode !== "hint_matched_nothing") throw new Error(`未知 ref 停因缺失（实际 ${r.old.stopCode}）`);
      return r;
    },
  },
  {
    name: "rules-only-no-model",
    page: "/cards.html",
    turns: () => ({ score: 0.9, passthrough: true }),
    run: async ({ mw, page, stub, origin }) => {
      await page.goto(`${origin}/cards.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await driveBoth(mw, page, stub, { instruction: "选一个", elems: elems as ElemPool, rulesOnly: true });
      if (r.old.stopCode !== "no_model_runtime") throw new Error(`无模型停因缺失（实际 ${r.old.stopCode}）`);
      if (r.old.asks.length !== 0) throw new Error("无模型运行时不得问票");
      return r;
    },
  },
  {
    name: "rules-only-hint-unmatched",
    page: "/cards.html",
    turns: () => ({ score: 0.9, passthrough: true }),
    run: async ({ mw, page, stub, origin }) => {
      await page.goto(`${origin}/cards.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      // curHint 非空 ⇒ 走"计划点了名但规则没解出来"的闭集引导文案分支。
      const r = await driveBoth(mw, page, stub, { instruction: "选一个", elems: elems as ElemPool, curHint: "#nope", rulesOnly: true });
      if (r.old.stopCode !== "no_model_runtime") throw new Error(`无模型停因缺失（实际 ${r.old.stopCode}）`);
      return r;
    },
  },
  {
    name: "wide-hard-cap-rung-hit",
    page: "/wide180.html",
    turns: (snap) => (snap.seq < 2 ? { score: 0.05, passthrough: false, probs: { p: 0.05 } } : { score: 0.95, passthrough: true }),
    run: async ({ mw, page, stub, origin }) => {
      await page.goto(`${origin}/wide180.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await driveBoth(mw, page, stub, { instruction: "点一个按钮", elems: elems as ElemPool });
      // 64 池 → 128 档未命中 → 硬顶档命中：两档窗口链事实 + 第三次问票。
      if (r.old.asks.length !== 3) throw new Error(`硬顶档应产生第三次问票（实际 ${r.old.asks.length}）`);
      if (r.old.windowChainFacts.length !== 2) throw new Error(`窗口链应记两档（实际 ${r.old.windowChainFacts.length}）`);
      return r;
    },
  },
  {
    name: "window-chain-all-miss",
    page: "/wide180.html",
    turns: () => ({ score: 0.05, passthrough: false, probs: { p: 0.05 } }),
    run: async ({ mw, page, stub, origin }) => {
      await page.goto(`${origin}/wide180.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await driveBoth(mw, page, stub, { instruction: "点一个按钮", elems: elems as ElemPool });
      // 全档未命中 ⇒ 停因尾缀 window escalation #1@128 -> #2@256 still no match。
      if (r.old.stopCode !== "low_confidence") throw new Error(`全档未命中应停 low_confidence（实际 ${r.old.stopCode}）`);
      if (!r.old.stopReason.includes("window escalation")) throw new Error("窗口链全未命中尾缀缺失");
      return r;
    },
  },
];

/** 规则分支的零模型票纪律（场景自检；两臂都断言）。 */
function assertRuleClean(a: ArmResult): void {
  if (a.asks.length !== 0) throw new Error("规则分支不得向模型问票");
  if (a.phase.method !== "rule:match" || a.phase.decisionKind !== "rule" || a.phase.conf !== 1) {
    throw new Error("规则分支字段不符");
  }
}

/* ------------------------------------------------------------------ 负向自测 */

/** 负向自测：真实跑一个场景证明两臂零差异，再逐处扰动投影，确认 diff 抓得住（不是空对照）。 */
async function selfTest(origin: string): Promise<number> {
  const c = CASES.find((x) => x.name === "low-conf-wide-reobserve");
  if (c === undefined) throw new Error("自测场景缺失");
  const { old, next } = await withMw(c.turns, async ({ mw, page, stub }) => c.run({ mw, page, stub, origin }));
  const base = normalize(armFact(old));
  const other = normalize(armFact(next));
  const noise = diff(base, other);
  if (noise.length !== 0) { console.error(`self-test: FAIL — 真实两臂已有差异 ${noise.length} 处`); return 1; }
  const mutations: Array<[string, (m: Record<string, unknown>) => void]> = [
    ["phase.conf", (m) => { const ph = m["phase"] as Record<string, unknown>; ph["conf"] = Number(ph["conf"] ?? 0) + 1; }],
    ["asks[0].candidate_count", (m) => { const asks = m["asks"] as Array<Record<string, unknown>>; if (asks[0] !== undefined) asks[0]["candidate_count"] = Number(asks[0]["candidate_count"]) + 1; }],
    ["windowChainFacts", (m) => { (m["windowChainFacts"] as unknown[]).push({ window: 1, miss: 1, resolved: true }); }],
    ["stop.reason", (m) => { const st = m["stop"] as Record<string, unknown>; st["reason"] = `${String(st["reason"])}x`; }],
  ];
  for (const [label, mutate] of mutations) {
    const copy = structuredClone(other) as Record<string, unknown>;
    mutate(copy);
    if (diff(base, copy).length === 0) { console.error(`self-test: FAIL — 扰动 ${label} 未被 diff 抓住`); return 1; }
  }
  console.log(`verify-decision-run-parity: self-test OK — 真实两臂零差异，且 ${mutations.length} 类扰动均被抓住`);
  return 0;
}

/* ------------------------------------------------------------------ 主流程 */

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--list")) {
    for (const c of CASES) console.log(c.name);
    return 0;
  }
  const server = await startServer({
    "/cards.html": CARDS_HTML, "/wide.html": WIDE_HTML, "/wide180.html": WIDE180_HTML,
    "/family.html": FAMILY_HTML, "/empty.html": EMPTY_HTML,
  });
  if (argv.includes("--self-test")) {
    try { return await selfTest(server.origin); } finally { await server.close(); }
  }
  let failures = 0;
  try {
    for (const c of CASES) {
      const { old, next } = await withMw(c.turns, async ({ mw, page, stub }) => c.run({ mw, page, stub, origin: server.origin }));
      const d = diff(normalize(armFact(old)), normalize(armFact(next)));
      if (d.length === 0) {
        console.log(`parity OK  ${c.name.padEnd(24)} asks=${old.asks.length} stop=${old.stopCode} method=${old.phase.method}`);
      } else {
        failures += 1;
        console.error(`parity DIFF ${c.name} — ${d.length} 处差异`);
        for (const line of d.slice(0, 20)) console.error(`  ${line}`);
      }
    }
  } finally {
    await server.close();
  }
  if (failures > 0) {
    console.error(`verify-decision-run-parity: FAIL — ${failures}/${CASES.length} 个场景有差异`);
    return 1;
  }
  console.log(`verify-decision-run-parity: OK — ${CASES.length} 个场景两臂逐字段一致（ModelPickPhase + 桩请求 + windowChainFacts + 停因）`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error(USAGE);
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 2;
}
