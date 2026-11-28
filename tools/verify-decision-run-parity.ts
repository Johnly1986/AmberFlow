/**
 * run 面选择段 parity lane（**门禁**：随 `npm run check` 经 `verify:decision-run-parity` 运行；
 * chromium 必需）：`decision-pick-phase.runDecisionPick` 对 **golden** 的
 * 单腿逐字段比对——`ModelPickPhase` 全字段、桩侧请求投影、`windowChainFacts`、`rejectedAskConfs`、
 * `warnings` 与结构化停因（code/reason）。
 *
 * golden 的来源（顺序不可颠倒）：旧实现退役**之前**，本 lane 曾把同一份 host/ctx 输入喂给
 *   - 对照臂：旧 `runModelPick`；
 *   - 新臂：`runDecisionPick`，
 * 两臂 16 场景逐字段零差异；随后先由对照臂 `--record` 快照成
 * `tools/golden/decision-run-parity/cases.json`（URL 端口归一 `<LOCAL>`、键序稳定、录两次
 * 逐字节一致才入盘），再删除旧实现。此后 `--check` 即"新实现 vs 退役前实现的事实"。
 *
 * 为什么 golden 可信：两臂共享页面与桩剧本，executor 原语全部经参数注入（只有宽扫抽取读
 * `mw.candidates`），因此本 lane 用 `buildMiddleware` 真实装配 mw，并把同一批原语
 * （pickElement/orderedPool/settleBeforeExtract/pruneForbids/hintOpts/stateText/停因记账…）
 * 交给被测实现；每场景一份 `RunAccounting`（forbidden/停因/窗口链事实互不污染）。
 * `--record` 在旧实现退役后**拒绝执行**——golden 不得由被检实现自行重录。
 *
 * **评审换基（`--rebase-reviewed`）**：唯一允许刷新 golden 的路径，且只换"评审过的差异"——
 * 逐场景算差异路径，任一非允许路径（缺失/新增场景、goal 以外的任何字段）即拒绝并打印；
 * 全部落在 `.asks[<i>].goal`（run 面 L0 尾巴追加「当前页」，ADR-001 R3）才写新 golden，并在
 * 顶层写 `_rebase` provenance（原因 + 允许差异路径闭集 + 换基场景；不写日期戳）。
 * 该旗标不取代断言：`--record` 仍按设计拒绝（被检实现不得自证）。
 *
 * **宽化止损场景**（`IDENTITY_CASES`，同 lane 同装配、不录 golden）：断"宽池没引入新元素身份
 * 就不重问"——ask 数 / 停因 / 归因尾缀逐条写死在场景里，golden 仍只覆盖退役前的事实快照。
 *
 * **门禁口径**：本 lane 挂在 `npm run check` 末尾（`check:ci` 自然继承），所以跑门禁的机器
 * **必须**有 chromium（`npx playwright install chromium`；CI 的 check job 已装同款）。
 * 浏览器缺失/启动失败是环境错误：入口打印修复提示并 exit 2，**不 self-skip**（门禁不许假绿）。
 * 本机实测本 lane ≈11.9s（16 场景；每场景一次真实 browserSession 装配）。
 *
 * 用法：node --experimental-strip-types tools/verify-decision-run-parity.ts
 *         [--check | --self-test | --list | --rebase-reviewed [--golden <path>]]
 * 退出码：0 零差异（或换基成功） / 1 有差异（或换基被拒） / 2 用法或环境错误（含 chromium 缺失）。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { browserSession, type BrowserMiddleware, type ModelPickPhase } from "../src/engine/executor.ts";
import { buildMiddleware } from "../src/app/middleware-factory.ts";
import { installLayaRuntime } from "../src/model/model.ts";
import { installDecisionProvider } from "../src/model/decision-provider.ts";
import { runDecisionPick, type RunPickCtx, type RunPickHost } from "../src/engine/decision-pick-phase.ts";
import { createRunAccounting } from "../src/engine/run-context.ts";
import { _hintOpts } from "../src/engine/executor-resolve-a.ts";
import { stateText, type Elem, type ElemFamily, type ElemPool, orderElemsByFamily } from "../src/engine/extraction.ts";
import { WIDER_ELEMENTS, WIDER_ELEMENTS_MAX, type WindowChainFact } from "../src/engine/executor-pure.ts";
import { PILOT_STOP_CODES } from "../src/app/pilot-contract.ts";
import type { DeclaredTargetsResolver } from "../src/engine/declared-targets.ts";
import { makeStubProvider, type StubRequestSnapshot, type StubTurn } from "./stub-decision-provider.ts";
import type { AnyPage } from "../src/engine/executor-types.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const GOLDEN_DIR = path.join(REPO, "tools", "golden", "decision-run-parity");
const GOLDEN_FILE = path.join(GOLDEN_DIR, "cases.json");
const USAGE = "usage: node --experimental-strip-types tools/verify-decision-run-parity.ts "
  + "[--check | --self-test | --list | --rebase-reviewed [--golden <path>]]";

/**
 * 评审换基允许的差异路径闭集（`$` = 单场景投影根；`<i>` = 第 i 次询问）。
 * 只允许模型询问的 L0 文本变化：run 面的 goal 尾部追加「当前页」段（ADR-001 R3，与 pilot 面
 * 同源渲染 `drivingGoalText`）。新增允许路径必须在这里登记并在文档/CHANGELOG 说明原因。
 */
const REBASE_ALLOWED_PATHS: ReadonlyArray<{ pattern: string; re: RegExp }> = [
  { pattern: "$.asks[<i>].goal", re: /^\$\.asks\[\d+\]\.goal$/ },
];

/** golden 顶层 provenance 键（评审换基来源；不含日期戳）。 */
const REBASE_KEY = "_rebase";

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

/** 180 个同文案按钮：宽化抽取只会让同一批元素重编号（身份集合恒为 1，计数却变大）。 */
const DUP180_HTML = `<!doctype html><html><body>${Array.from({ length: 180 }, () =>
  "<button>更多</button>").join("")}</body></html>`;

/** 128 个互异 + 52 个同文案重复（重复文案已在前 128 个里出现过）：只有硬顶档才只剩重编号。 */
const DUP_TAIL_HTML = `<!doctype html><html><body>${Array.from({ length: 128 }, (_, i) =>
  `<button>按钮 ${i + 1}</button>`).join("")}${Array.from({ length: 52 }, () => "<button>按钮 1</button>").join("")}</body></html>`;

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
  contextCapability: () => null,
  siteFactsNotes: () => null,
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

function makeCtx(page: AnyPage, spec: DriveSpec, _host: RunPickHost, acct: ReturnType<typeof createRunAccounting>): RunPickCtx {
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

const stable = (v: unknown): string => `${JSON.stringify(normalize(v), null, 2)}\n`;

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

/** 一次驱动：新账本/新 host/新 ctx，桩请求在驱动前清零（与 golden 录制时的输入完全同构）。 */
async function drivePick(mw: BrowserMiddleware, page: AnyPage, stub: Stub, spec: DriveSpec): Promise<ArmResult> {
  // run() 在 runSetup 就解析过 provider；必须在"已 ready"状态下取 modelLabel（与录制 golden 时同序）。
  await mw.ready();
  stub.reset();
  mw._choiceLimitReason = null;
  mw.rulesOnly = spec.rulesOnly === true;
  const acct = createRunAccounting({ maxSteps: 3 });
  const host = makeHost(mw, acct, spec);
  const ctx = makeCtx(page, spec, host, acct);
  return collectArm(await runDecisionPick(host, ctx), ctx, acct, stub);
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
  /** 场景自检直接断在本次驱动结果上；与 golden 的逐字段比对由主流程统一做。 */
  run(ctx: { mw: BrowserMiddleware; page: AnyPage; stub: Stub; origin: string; drive: (spec: DriveSpec) => Promise<ArmResult> }): Promise<ArmResult>;
}

const CASES: Case[] = [
  {
    name: "rule-hit",
    page: "/cards.html",
    turns: () => ({ score: 0.1 }),
    run: async ({ mw, page, origin, drive }) => {
      await page.goto(`${origin}/cards.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const ruleRef = Object.keys(elems)[0] ?? null;
      const r = await drive({ instruction: "点击确认", elems: elems as ElemPool, ruleRef, curHint: "#b1" });
      assertRuleClean(r);
      return r;
    },
  },
  {
    name: "tiered-narrow-fallback",
    page: "/cards.html",
    turns: (snap) => (snap.seq === 0 ? { score: 0.05, passthrough: false, probs: { p: 0.05 } } : { score: 0.9, passthrough: true }),
    run: async ({ mw, page, origin, drive }) => {
      await page.goto(`${origin}/cards.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await drive({ instruction: "选一个", elems: elems as ElemPool, curHint: "button", tieredHint: true });
      // 窄问弃权 → 全池重问：第二问的候选数必须更大（否则档位没被触发）。
      const n0 = (r.asks[0] as { candidate_count: number }).candidate_count;
      const n1 = (r.asks[1] as { candidate_count: number }).candidate_count;
      if (!(n1 > n0)) throw new Error(`tiered 档位未触发：${n0} -> ${n1}`);
      if (r.phase.tierAsk !== null) throw new Error("窄问弃权后 tierAsk 必须清空");
      return r;
    },
  },
  {
    name: "tiered-narrow-hit",
    page: "/cards.html",
    turns: () => ({ score: 0.9, passthrough: false, probs: { p: 0.9 } }),
    run: async ({ mw, page, origin, drive }) => {
      await page.goto(`${origin}/cards.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await drive({ instruction: "选一个", elems: elems as ElemPool, curHint: "button", tieredHint: true });
      // 窄问一次过闸：只问一次，tierAsk 随返回值交回（诊断字段的命中路径）。
      if (r.asks.length !== 1) throw new Error(`窄问命中不应回退全池（实际 ${r.asks.length} 问）`);
      if (r.phase.tierAsk === null) throw new Error("窄问命中后 tierAsk 必须非空");
      return r;
    },
  },
  {
    name: "low-conf-wide-reobserve",
    page: "/wide.html",
    turns: (snap) => (snap.seq === 0 ? { score: 0.05, passthrough: false, probs: { p: 0.05 } } : { score: 0.95, passthrough: true }),
    run: async ({ mw, page, origin, drive }) => {
      await page.goto(`${origin}/wide.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await drive({ instruction: "点一个按钮", elems: elems as ElemPool });
      if (!String(r.phase.method).includes("reobserve")) throw new Error("低置信宽扫未触发");
      if (r.windowChainFacts.length === 0) throw new Error("窗口链事实缺失");
      return r;
    },
  },
  {
    name: "escalate",
    page: "/wide.html",
    turns: () => ({ score: 0.05, passthrough: false, probs: { p: 0.05 } }),
    run: async ({ mw, page, origin, drive }) => {
      await page.goto(`${origin}/wide.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await drive({ instruction: "点一个按钮", elems: elems as ElemPool, reobserve: false, escalate: true });
      if (r.phase.decisionKind !== "escalate") throw new Error("升级票未命中");
      return r;
    },
  },
  {
    name: "adjudicate",
    page: "/wide.html",
    turns: () => ({ score: 0.05, passthrough: false, probs: { p: 0.05 } }),
    run: async ({ mw, page, origin, drive }) => {
      await page.goto(`${origin}/wide.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await drive({ instruction: "点一个按钮", elems: elems as ElemPool, reobserve: false, adjudicate: true });
      if (!String(r.phase.method).endsWith(":adjudicated")) throw new Error("裁决档未触发");
      return r;
    },
  },
  {
    name: "r2b",
    page: "/wide.html",
    turns: (snap) => (snap.seq === 0 ? { score: 0.6, passthrough: true } : { score: 0.95, passthrough: true }),
    run: async ({ mw, page, origin, drive }) => {
      await page.goto(`${origin}/wide.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await drive({ instruction: "zzz qqq", elems: elems as ElemPool });
      if (r.asks.length !== 2) throw new Error(`R2b 应触发一次宽扫重问（实际 ${r.asks.length} 问）`);
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
    run: async ({ mw, page, origin, drive }) => {
      await page.goto(`${origin}/family.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await drive({ instruction: "选一个", elems: elems as ElemPool, expectedFamily: "check" });
      if (!r.phase.nominatedRepair) throw new Error("族修复未触发");
      return r;
    },
  },
  {
    name: "family-empty",
    page: "/cards.html",
    turns: () => ({ score: 0.9, passthrough: true }),
    run: async ({ mw, page, origin, drive }) => {
      await page.goto(`${origin}/cards.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await drive({ instruction: "选一个", elems: elems as ElemPool, expectedFamily: "check" });
      if (r.stopCode !== "nominated_family_empty") throw new Error(`族空停因缺失（实际 ${r.stopCode}）`);
      return r;
    },
  },
  {
    name: "choice-limit",
    page: "/empty.html",
    turns: () => ({ score: 0.9, passthrough: true }),
    run: async ({ drive }) => {
      // 决策服务候选上限 255（引擎 MAX_CHOICES=200）：合成超限池直接打到结构化停因分支。
      const elems: ElemPool = {};
      for (let i = 0; i < 250; i += 1) elems[`e${i}`] = { tag: "button", label: `选项 ${i}` } as unknown as Elem;
      const r = await drive({ instruction: "选一个", elems });
      if (r.stopCode !== "decision_service_choice_limit") throw new Error(`候选超限停因缺失（实际 ${r.stopCode}）`);
      return r;
    },
  },
  {
    name: "low-confidence-stop",
    page: "/wide.html",
    turns: () => ({ score: 0.05, passthrough: false, probs: { p: 0.05 } }),
    run: async ({ mw, page, origin, drive }) => {
      await page.goto(`${origin}/wide.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await drive({ instruction: "点一个按钮", elems: elems as ElemPool, reobserve: false });
      if (r.stopCode !== "low_confidence") throw new Error(`低置信停因缺失（实际 ${r.stopCode}）`);
      return r;
    },
  },
  {
    name: "unknown-ref",
    page: "/cards.html",
    turns: () => ({ score: 0.9, passthrough: true }),
    run: async ({ mw, page, origin, drive }) => {
      await page.goto(`${origin}/cards.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await drive({ instruction: "点击确认", elems: elems as ElemPool, ruleRef: "e999", curHint: "#b1" });
      if (r.stopCode !== "hint_matched_nothing") throw new Error(`未知 ref 停因缺失（实际 ${r.stopCode}）`);
      return r;
    },
  },
  {
    name: "rules-only-no-model",
    page: "/cards.html",
    turns: () => ({ score: 0.9, passthrough: true }),
    run: async ({ mw, page, origin, drive }) => {
      await page.goto(`${origin}/cards.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await drive({ instruction: "选一个", elems: elems as ElemPool, rulesOnly: true });
      if (r.stopCode !== "no_model_runtime") throw new Error(`无模型停因缺失（实际 ${r.stopCode}）`);
      if (r.asks.length !== 0) throw new Error("无模型运行时不得问票");
      return r;
    },
  },
  {
    name: "rules-only-hint-unmatched",
    page: "/cards.html",
    turns: () => ({ score: 0.9, passthrough: true }),
    run: async ({ mw, page, origin, drive }) => {
      await page.goto(`${origin}/cards.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      // curHint 非空 ⇒ 走"计划点了名但规则没解出来"的闭集引导文案分支。
      const r = await drive({ instruction: "选一个", elems: elems as ElemPool, curHint: "#nope", rulesOnly: true });
      if (r.stopCode !== "no_model_runtime") throw new Error(`无模型停因缺失（实际 ${r.stopCode}）`);
      return r;
    },
  },
  {
    name: "wide-hard-cap-rung-hit",
    page: "/wide180.html",
    turns: (snap) => (snap.seq < 2 ? { score: 0.05, passthrough: false, probs: { p: 0.05 } } : { score: 0.95, passthrough: true }),
    run: async ({ mw, page, origin, drive }) => {
      await page.goto(`${origin}/wide180.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await drive({ instruction: "点一个按钮", elems: elems as ElemPool });
      // 64 池 → 128 档未命中 → 硬顶档命中：两档窗口链事实 + 第三次问票。
      if (r.asks.length !== 3) throw new Error(`硬顶档应产生第三次问票（实际 ${r.asks.length}）`);
      if (r.windowChainFacts.length !== 2) throw new Error(`窗口链应记两档（实际 ${r.windowChainFacts.length}）`);
      return r;
    },
  },
  {
    name: "window-chain-all-miss",
    page: "/wide180.html",
    turns: () => ({ score: 0.05, passthrough: false, probs: { p: 0.05 } }),
    run: async ({ mw, page, origin, drive }) => {
      await page.goto(`${origin}/wide180.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await drive({ instruction: "点一个按钮", elems: elems as ElemPool });
      // 全档未命中 ⇒ 停因尾缀 window escalation #1@128 -> #2@256 still no match。
      if (r.stopCode !== "low_confidence") throw new Error(`全档未命中应停 low_confidence（实际 ${r.stopCode}）`);
      if (!r.stopReason.includes("window escalation")) throw new Error("窗口链全未命中尾缀缺失");
      return r;
    },
  },
];

/* ------------------------------------------------------------------ 宽化止损（身份判据） */

/**
 * 宽化止损场景（**不录 golden**）：钉"宽池有没有引入新的元素身份"如何决定 ask 数。
 * 不进 golden 的理由：golden 是退役前的事实快照，被检实现不得自录；这三条钉的正是判据
 * 本身，就地断言（ask 数 / 停因 / 归因尾缀）比快照更直接（每条一次真实页面装配）。
 */
const IDENTITY_CASES: Case[] = [
  {
    name: "wide-identity-flat",
    page: "/dup180.html",
    turns: () => ({ score: 0.05, passthrough: false, probs: { p: 0.05 } }),
    run: async ({ mw, page, origin, drive }) => {
      await page.goto(`${origin}/dup180.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await drive({ instruction: "点一个按钮", elems: elems as ElemPool });
      // 宽池只是同一批元素的 64→128 重编号（身份集合恒为 1）：不重问 = 只有窄问那一次。
      if (r.asks.length !== 1) throw new Error(`无新身份时不得重问（实际 ${r.asks.length} 问）`);
      if (r.stopCode !== "low_confidence") throw new Error(`停因应仍为 low_confidence（实际 ${r.stopCode}）`);
      if (r.windowChainFacts.length !== 0) throw new Error(`窗口链不该开档（实际 ${r.windowChainFacts.length} 档）`);
      if (!r.stopReason.includes(`wide recovery stopped at window ${WIDER_ELEMENTS}`)) {
        throw new Error(`停因缺少宽化止损归因：${r.stopReason}`);
      }
      return r;
    },
  },
  {
    name: "wide-identity-flat-hard-cap",
    page: "/duptail180.html",
    turns: () => ({ score: 0.05, passthrough: false, probs: { p: 0.05 } }),
    run: async ({ mw, page, origin, drive }) => {
      await page.goto(`${origin}/duptail180.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await drive({ instruction: "点一个按钮", elems: elems as ElemPool });
      // 128 档真引入新身份（重问一次）→ 硬顶档只有前 128 个文案的重编号 → 停在硬顶档。
      if (r.asks.length !== 2) throw new Error(`硬顶档止损应只问两次（实际 ${r.asks.length} 问）`);
      if (r.windowChainFacts.length !== 1 || r.windowChainFacts[0]?.window !== WIDER_ELEMENTS) {
        throw new Error(`只应记宽扫档未命中事实（实际 ${JSON.stringify(r.windowChainFacts)}）`);
      }
      if (r.stopCode !== "low_confidence") throw new Error(`停因应仍为 low_confidence（实际 ${r.stopCode}）`);
      if (!r.stopReason.includes(`wide recovery stopped at window ${WIDER_ELEMENTS_MAX}`)) {
        throw new Error(`停因缺少硬顶档止损归因：${r.stopReason}`);
      }
      return r;
    },
  },
  {
    name: "wide-identity-grows",
    page: "/wide180.html",
    turns: () => ({ score: 0.05, passthrough: false, probs: { p: 0.05 } }),
    run: async ({ mw, page, origin, drive }) => {
      await page.goto(`${origin}/wide180.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const r = await drive({ instruction: "点一个按钮", elems: elems as ElemPool });
      // 每档都真引入新身份（180 个互异候选）：阶梯逐档照走 = 三次询问 + 两档窗口链事实。
      if (r.asks.length !== 3) throw new Error(`有身份增长时阶梯应照走（实际 ${r.asks.length} 问）`);
      if (r.windowChainFacts.length !== 2) throw new Error(`窗口链应记两档（实际 ${r.windowChainFacts.length}）`);
      if (r.stopCode !== "low_confidence") throw new Error(`停因应仍为 low_confidence（实际 ${r.stopCode}）`);
      if (r.stopReason.includes("wide recovery stopped")) throw new Error("有身份增长时不得写宽化止损归因");
      return r;
    },
  },
];

/** 宽化止损场景逐条断言（失败计入 lane 失败，不静默跳过）。 */
async function checkIdentityStop(origin: string): Promise<number> {
  let failures = 0;
  for (const c of IDENTITY_CASES) {
    try {
      const got = await observeCase(c, origin);
      const asks = (got["asks"] as unknown[]).length;
      const code = String((got["stop"] as Record<string, unknown>)["code"]);
      // 停因闭集：判据只减 ask，不得造出 12 码之外的新停因。
      if (!(PILOT_STOP_CODES as readonly string[]).includes(code)) throw new Error(`停因 ${code} 不在冻结 12 码内`);
      console.log(`identity OK  ${c.name.padEnd(24)} asks=${asks} stop=${code}`);
    } catch (e) {
      failures += 1;
      console.error(`identity FAIL ${c.name} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return failures;
}

/** 规则分支的零模型票纪律（场景自检；两臂都断言）。 */
function assertRuleClean(a: ArmResult): void {
  if (a.asks.length !== 0) throw new Error("规则分支不得向模型问票");
  if (a.phase.method !== "rule:match" || a.phase.decisionKind !== "rule" || a.phase.conf !== 1) {
    throw new Error("规则分支字段不符");
  }
}

/* ------------------------------------------------------------------ 负向自测 */

/** 负向自测：新臂对 golden 零差异，再逐处扰动投影，确认 diff 抓得住（不是空对照）。 */
async function selfTest(origin: string, goldenPath = GOLDEN_FILE): Promise<number> {
  const golden = readGolden(goldenPath);
  const c = CASES.find((x) => x.name === "low-conf-wide-reobserve");
  if (c === undefined) throw new Error("自测场景缺失");
  const got = await observeCase(c, origin);
  const base = golden.cases[c.name];
  if (base === undefined) { console.error(`self-test: FAIL — golden 缺场景 ${c.name}`); return 1; }
  const noise = diff(normalize(base), normalize(got));
  if (noise.length !== 0) { console.error(`self-test: FAIL — 新臂与 golden 已有差异 ${noise.length} 处`); return 1; }
  const mutations: Array<[string, (m: Record<string, unknown>) => void]> = [
    ["phase.conf", (m) => { const ph = m["phase"] as Record<string, unknown>; ph["conf"] = Number(ph["conf"] ?? 0) + 1; }],
    ["asks[0].candidate_count", (m) => { const asks = m["asks"] as Array<Record<string, unknown>>; if (asks[0] !== undefined) asks[0]["candidate_count"] = Number(asks[0]["candidate_count"]) + 1; }],
    ["windowChainFacts", (m) => { (m["windowChainFacts"] as unknown[]).push({ window: 1, miss: 1, resolved: true }); }],
    ["stop.reason", (m) => { const st = m["stop"] as Record<string, unknown>; st["reason"] = `${String(st["reason"])}x`; }],
  ];
  for (const [label, mutate] of mutations) {
    const copy = structuredClone(normalize(got)) as Record<string, unknown>;
    mutate(copy);
    if (diff(normalize(base), copy).length === 0) { console.error(`self-test: FAIL — 扰动 ${label} 未被 diff 抓住`); return 1; }
  }
  const rebaseError = rebaseSelfTest(golden);
  if (rebaseError !== null) { console.error(`self-test: FAIL — ${rebaseError}`); return 1; }
  console.log(`verify-decision-run-parity: self-test OK — 新臂对 golden 零差异，${mutations.length} 类扰动均被抓住，`
    + "换基守卫（正例写入 / 非 goal 拒绝 / 缺场景拒绝 / 拒绝时零改写）全部符合");
  return 0;
}

/* ------------------------------------------------------------------ 评审换基 */

interface RebaseProvenance {
  /** 换基原因（说明哪条评审过的变更导致 golden 重录）。 */
  reason: string;
  /** 换基纪律：只换允许路径，其余差异一律拒绝；`--record` 仍拒。 */
  policy: string;
  /** 允许的差异路径闭集（`<i>` = 第 i 次询问；`$` = 单场景投影根）。 */
  allowed_diff_paths: string[];
  /** 本次实际换基的场景名（按字典序）。 */
  changed_cases: string[];
}

interface GoldenFile {
  schema: number;
  note: string;
  cases: Record<string, unknown>;
  _rebase?: RebaseProvenance;
}

interface RebaseDiff {
  name: string;
  /** `path: old !== new` 行（与 `diff()` 同格式）。 */
  lines: string[];
  /** 不在允许闭集的行（非空 = 该场景拒绝换基）。 */
  violations: string[];
}

interface RebasePlan {
  diffs: RebaseDiff[];
  /** 全部拒绝行（跨场景汇总；非空 = 整体拒绝）。 */
  violations: string[];
  changedCases: string[];
  observed: Record<string, unknown>;
  allowed: boolean;
}

function isAllowedRebasePath(p: string): boolean {
  return REBASE_ALLOWED_PATHS.some((x) => x.re.test(p));
}

/** `path: old !== new` → `path`（`diff()` 的行格式固定，值里不会出现路径分隔）。 */
function pathOfDiffLine(line: string): string {
  const i = line.indexOf(": ");
  return i < 0 ? line : line.slice(0, i);
}

/** 差异分类（纯函数）：唯一判据 = 每条差异行是否落在允许路径闭集。 */
function classifyRebase(golden: GoldenFile, observed: Record<string, unknown>): RebasePlan {
  const names = [...new Set([...Object.keys(golden.cases), ...Object.keys(observed)])].sort();
  const diffs: RebaseDiff[] = [];
  const violations: string[] = [];
  const changedCases: string[] = [];
  for (const name of names) {
    const want = golden.cases[name];
    const got = observed[name];
    if (want === undefined || got === undefined) {
      const line = want === undefined ? `${name}: 观测有场景但 golden 缺失` : `${name}: golden 有场景但观测缺失`;
      violations.push(line);
      continue;
    }
    const lines = diff(normalize(want), normalize(got));
    if (lines.length === 0) continue;
    const bad = lines.filter((l) => !isAllowedRebasePath(pathOfDiffLine(l)));
    diffs.push({ name, lines, violations: bad });
    if (bad.length > 0) violations.push(...bad.map((l) => `${name} ${l}`));
    else changedCases.push(name);
  }
  return { diffs, violations, changedCases, observed, allowed: violations.length === 0 };
}

function rebaseProvenance(changedCases: string[]): RebaseProvenance {
  return {
    reason: "L0 改写评审换基：run 面模型询问 goal 尾部追加「| 当前页: <url>」段"
      + "（ADR-001 R3，与 pilot 面同源渲染 drivingGoalText）；原 golden 是旧实现退役前的事实快照，不含该段。",
    policy: "--rebase-reviewed 只换允许路径闭集内的差异；任一非 goal 差异（含缺失/新增场景）拒绝且不改写 golden。"
      + " --record 仍按设计拒绝（被检实现不得自证）。",
    allowed_diff_paths: REBASE_ALLOWED_PATHS.map((x) => x.pattern),
    changed_cases: changedCases,
  };
}

/** 写换基 golden（`plan.allowed` 之外的调用一律拒绝且不触碰文件）。 */
function writeRebaseGolden(goldenPath: string, golden: GoldenFile, plan: RebasePlan): boolean {
  if (!plan.allowed) return false;
  // 幂等重跑：无差异时保留既有 provenance 的换基场景（不让二次换基抹掉首次评审换基的清单）。
  const prior = golden[REBASE_KEY]?.changed_cases ?? [];
  const changedCases = [...new Set([...prior, ...plan.changedCases])].sort();
  const next: GoldenFile = {
    schema: 1,
    note: golden.note,
    [REBASE_KEY]: rebaseProvenance(changedCases),
    cases: plan.observed,
  };
  fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
  fs.writeFileSync(goldenPath, stable(next));
  return true;
}

/** 换基负向自测（离屏、纯本地、零浏览器）：临时副本 + 允许/拒绝两路。 */
function rebaseSelfTest(golden: GoldenFile): string | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-parity-rebase-"));
  const tmp = path.join(dir, "cases.json");
  const original = stable(golden);
  fs.writeFileSync(tmp, original);
  const base = normalize(golden.cases) as Record<string, Record<string, unknown>>;

  const goalCase = "tiered-narrow-hit";
  const positive = structuredClone(base);
  const positiveAsks = positive[goalCase]?.["asks"] as Array<Record<string, unknown>> | undefined;
  if (positiveAsks?.[0] === undefined) return "换基自测缺 goal 样本（tiered-narrow-hit.asks[0]）";
  positiveAsks[0]["goal"] = `${String(positiveAsks[0]["goal"])} | 当前页: <LOCAL>/cards.html`;
  const okPlan = classifyRebase(golden, positive);
  if (!okPlan.allowed || !okPlan.changedCases.includes(goalCase)) {
    return `换基正例（仅 .goal 差异）被误拒：${okPlan.violations.join("; ") || "未识别为换基场景"}`;
  }
  if (!writeRebaseGolden(tmp, golden, okPlan)) return "换基正例写入被拒";
  const written = JSON.parse(fs.readFileSync(tmp, "utf8")) as GoldenFile;
  if (written[REBASE_KEY] === undefined) return "换基写入缺 provenance";
  if (written[REBASE_KEY]!.allowed_diff_paths.join() !== REBASE_ALLOWED_PATHS.map((x) => x.pattern).join()) {
    return "换基 provenance 的允许路径闭集不符";
  }
  if (!written[REBASE_KEY]!.changed_cases.includes(goalCase)) return "换基 provenance 缺换基场景";

  fs.writeFileSync(tmp, original);
  const negative = structuredClone(base);
  const negativeCase = "adjudicate";
  const negPhase = negative[negativeCase]?.["phase"] as Record<string, unknown> | undefined;
  if (negPhase === undefined) return "换基自测缺非 goal 样本（adjudicate.phase）";
  negPhase["conf"] = Number(negPhase["conf"] ?? 0) + 1;
  const badPlan = classifyRebase(golden, negative);
  if (badPlan.allowed) return "换基负例（非 goal 字段）未被拒绝";
  if (badPlan.violations.length === 0) return "换基负例未产出拒绝行";
  if (writeRebaseGolden(tmp, golden, badPlan)) return "换基负例写入未被拒绝";
  if (fs.readFileSync(tmp, "utf8") !== original) return "换基负例拒绝时改写了 golden";

  const missing = structuredClone(base);
  delete missing[goalCase];
  if (classifyRebase(golden, missing).allowed) return "换基负例（缺场景）未被拒绝";

  fs.rmSync(dir, { recursive: true, force: true });
  return null;
}

/**
 * `--rebase-reviewed`：逐场景算差异路径 → 全部落在允许闭集才写新 golden（附 provenance）。
 * 任一非允许差异 → 打印并拒绝（exit 1），golden 逐字节不变。
 */
async function rebaseReviewed(origin: string, goldenPath: string): Promise<number> {
  const golden = readGolden(goldenPath);
  const observed: Record<string, unknown> = {};
  for (const c of CASES) observed[c.name] = await observeCase(c, origin);
  const plan = classifyRebase(golden, observed);
  for (const d of plan.diffs) {
    console.log(`rebase ${d.violations.length === 0 ? "goal   " : "REFUSED"} ${d.name} — ${d.lines.length} 处差异`);
    for (const line of d.lines.slice(0, 20)) {
      console.log(`  ${d.violations.includes(line) ? "!" : " "} ${line}`);
    }
    if (d.lines.length > 20) console.log(`  … 其余 ${d.lines.length - 20} 处省略`);
  }
  if (!plan.allowed) {
    console.error(`verify-decision-run-parity: 评审换基被拒 — ${plan.violations.length} 处差异不在允许路径闭集`
      + `（${REBASE_ALLOWED_PATHS.map((x) => x.pattern).join(" / ")}）；golden 未改写。`);
    for (const line of plan.violations.slice(0, 20)) console.error(`  ${line}`);
    return 1;
  }
  if (!writeRebaseGolden(goldenPath, golden, plan)) {
    console.error("verify-decision-run-parity: 评审换基被拒 — 写入门拒绝（plan.allowed=false）");
    return 1;
  }
  console.log(`verify-decision-run-parity: 评审换基 OK — 改写 ${plan.changedCases.length} 个场景`
    + `（${plan.changedCases.join(", ") || "无差异（仅补 provenance）"}）；差异全部落在 `
    + `${REBASE_ALLOWED_PATHS.map((x) => x.pattern).join(" / ")}；provenance 键 ${REBASE_KEY} → ${path.relative(REPO, goldenPath)}`);
  return 0;
}

/* ------------------------------------------------------------------ golden 与主流程 */

function goldenPathOf(argv: string[]): string {
  const i = argv.indexOf("--golden");
  if (i < 0) return GOLDEN_FILE;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error("--golden 缺路径");
  return path.resolve(value);
}

function readGolden(goldenPath = GOLDEN_FILE): GoldenFile {
  if (!fs.existsSync(goldenPath)) throw new Error(`缺少 golden ${path.relative(REPO, goldenPath)}（旧实现存续时用 --record 录制）`);
  const parsed = JSON.parse(fs.readFileSync(goldenPath, "utf8")) as GoldenFile;
  if (parsed.schema !== 1 || typeof parsed.cases !== "object") throw new Error("golden 形状不符（schema 1）");
  return parsed;
}

/** 单场景驱动一臂并投影（页面级装配：每场景一个 mw，桩剧本随场景）。 */
async function observeCase(c: Case, origin: string): Promise<Record<string, unknown>> {
  const result = await withMw(c.turns, async ({ mw, page, stub }) => c.run({ mw, page, stub, origin, drive: (spec) => drivePick(mw, page, stub, spec) }));
  return normalize(armFact(result)) as Record<string, unknown>;
}

/** `--record` 在旧实现退役后拒绝执行：golden 只由退役前的对照臂录制，被检实现不得自行重录。 */
function refuseRecord(goldenPath: string): number {
  console.error(`verify-decision-run-parity: 拒绝 --record — 对照臂已退役；golden ${path.relative(REPO, goldenPath)} `
    + "是退役前录制的事实快照，重录等同自证。确需刷新时，走评审：--rebase-reviewed（只换允许路径闭集并写 provenance），"
    + "附新旧 golden 差异一并评审。");
  return 2;
}

/** `--check`（缺省）：新臂逐场景对 golden。 */
async function check(origin: string, goldenPath: string): Promise<number> {
  const golden = readGolden(goldenPath);
  let failures = 0;
  for (const c of CASES) {
    const got = await observeCase(c, origin);
    const want = golden.cases[c.name];
    if (want === undefined) {
      failures += 1;
      console.error(`parity MISSING ${c.name} — golden 无此场景`);
      continue;
    }
    const d = diff(normalize(want), got);
    if (d.length === 0) {
      const phase = (got["phase"] as Record<string, unknown>);
      const asks = got["asks"] as unknown[];
      console.log(`parity OK  ${c.name.padEnd(24)} asks=${asks.length} stop=${(got["stop"] as Record<string, unknown>)["code"]} method=${phase["method"]}`);
    } else {
      failures += 1;
      console.error(`parity DIFF ${c.name} — ${d.length} 处差异`);
      for (const line of d.slice(0, 20)) console.error(`  ${line}`);
    }
  }
  failures += await checkIdentityStop(origin);
  if (failures > 0) {
    console.error(`verify-decision-run-parity: FAIL — ${failures} 处失败（golden 差异 + 宽化止损断言）`);
    return 1;
  }
  console.log(`verify-decision-run-parity: OK — ${CASES.length} 个场景与 golden 逐字段一致（ModelPickPhase + 桩请求 + windowChainFacts + 停因）`
    + `；${IDENTITY_CASES.length} 个宽化止损场景按元素身份断言通过（ask 数/停因/归因）`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--list")) {
    for (const c of CASES) console.log(c.name);
    for (const c of IDENTITY_CASES) console.log(`${c.name}  (identity, no golden)`);
    return 0;
  }
  const goldenPath = goldenPathOf(argv);
  const server = await startServer({
    "/cards.html": CARDS_HTML, "/wide.html": WIDE_HTML, "/wide180.html": WIDE180_HTML,
    "/family.html": FAMILY_HTML, "/empty.html": EMPTY_HTML,
    "/dup180.html": DUP180_HTML, "/duptail180.html": DUP_TAIL_HTML,
  });
  try {
    if (argv.includes("--self-test")) return await selfTest(server.origin, goldenPath);
    if (argv.includes("--record")) return refuseRecord(goldenPath);
    if (argv.includes("--rebase-reviewed")) return await rebaseReviewed(server.origin, goldenPath);
    return await check(server.origin, goldenPath);
  } finally {
    await server.close();
  }
}

/**
 * chromium 缺失/不可启动的归类：门禁 lane 依此给可操作提示并 exit 2——既不 self-skip，也不把
 * 环境问题伪装成 parity 差异（后者会误导金标评审）。
 */
function isBrowserLaunchFailure(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /no chromium binary found|Executable doesn't exist|playwright install chromium|browserType\.launch/i.test(msg);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (isBrowserLaunchFailure(e)) {
    console.error("verify-decision-run-parity: 浏览器启动失败 — 本 lane 随 `npm run check` 运行，门禁需要 chromium。");
    console.error(`  ${e instanceof Error ? e.message : String(e)}`);
    console.error("  修复：npx playwright install chromium（或把 PLAYWRIGHT_BROWSERS_PATH 指向含 chromium-*/ 的目录）后重跑；"
      + "本 lane 不跳过、不假绿。");
  } else {
    console.error(USAGE);
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  }
  process.exitCode = 2;
}
