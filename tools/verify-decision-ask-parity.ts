/**
 * S1 ask seam 双臂对照 lane（非门禁，零网络/零真站）：把 pilot 的模型询问路径切到引擎
 * `DecisionAsk` 后，用**确定性 stub provider** 证明新旧两臂在可比投影上等价。
 *
 * 三条臂（同一场景、同一剧本、同一页）：
 *   - legacy   = `modelVoteLegacy`（迁移前的阶梯实现）；
 *   - ask      = `DecisionAsk`（经 `PilotAskAdapter` 注入面观察/投票原语）；
 *   - newPath  = `modelVote`（执行路径：委托 adapter，回 `PilotVote` 逐字段映射）。
 *
 * 比较投影（任一字段不同 = 差异，逐条打印并以退出码 1 结束）：
 *   - stub 侧请求快照：goal/url/k/narrow/候选 ref+tag+label/forbidden/notes（活集合入口即拍平）；
 *   - stub 侧返回投影：ref/score/scoreKind/options/passthrough；
 *   - 最终结果：picked 的 ref/conf/shape/via、执行池 ref 序、命中元素签名；abstained 的
 *     asked/执行池；降级档的 no_model 与 asked。
 *
 * 场景：
 *   ① 窄问高置信命中；② 低置信 → 宽扫命中；③ 弃权（ref null）；④ 宽扫未变大 → 弃权；
 *   ⑤ 降级（provider 不在位）→ 两臂都应 no_model。
 *
 * 用法：node --experimental-strip-types tools/verify-decision-ask-parity.ts [--json]
 * 退出码：0 = 5 场景三臂零差异；1 = 有差异/场景意图不成立；2 = 用法或环境错误。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { browserSession, type BrowserMiddleware } from "../src/engine/executor.ts";
import { esig } from "../src/engine/elem-model.ts";
import { buildMiddleware } from "../src/app/middleware-factory.ts";
import { installLayaRuntime } from "../src/model/model.ts";
import { installDecisionProvider } from "../src/model/decision-provider.ts";
import { PilotLedger } from "../src/app/pilot-ledger.ts";
import { PilotAskAdapter } from "../src/app/pilot-ask-adapter.ts";
import { modelVote, modelVoteLegacy, type PilotVote } from "../src/app/pilot-vote.ts";
import type { DecisionAskOutcome } from "../src/engine/decision-ask-contract.ts";
import type { StubProvider, StubRequestSnapshot, StubTurn } from "./stub-decision-provider.ts";
import { makeStubProvider } from "./stub-decision-provider.ts";
import type { AnyPage } from "../src/engine/executor-types.ts";

const USAGE = "usage: node --experimental-strip-types tools/verify-decision-ask-parity.ts [--json]";
const GOAL = "点一个按钮";
const FLOOR = 0.5;
const HOSTS = ["127.0.0.1"];

/* ------------------------------------------------------------------ 页面服务 */

const CARDS_HTML = `<!doctype html><html><body>
<button id="b1">确认</button><button id="b2">取消</button><button id="b3">详情</button>
</body></html>`;

const WIDE_HTML = `<!doctype html><html><body>${Array.from({ length: 100 }, (_, i) =>
  `<button id="b${i + 1}">按钮 ${i + 1}</button>`).join("")}</body></html>`;

async function startServer(): Promise<{ origin: string; close(): Promise<void> }> {
  const pages: Record<string, string> = { "/cards.html": CARDS_HTML, "/wide.html": WIDE_HTML };
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

let ORIGIN = "";

/* ------------------------------------------------------------------ 投影 */

type StubScript = (snap: StubRequestSnapshot) => StubTurn;

interface PickedNorm {
  kind: "picked"; asked: number; ref: string; conf: number; shape: string; via: string;
  poolKeys: string[]; sig: string;
}
interface AbstainedNorm { kind: "abstained"; asked: number; poolKeys: string[] | null }
interface NoModelNorm { kind: "no_model"; asked: number }
type Norm = PickedNorm | AbstainedNorm | NoModelNorm;

interface RequestFact {
  seq: number; goal: string; url: string; k: number; narrow: string[] | null;
  candidate_count: number; candidates: Array<{ ref: string; tag: string; label: string }>;
  forbidden: string[]; notes: Record<string, string> | null;
}
interface ResponseFact {
  ref: string | null | undefined; score: number; scoreKind: string; options: number; passthrough: boolean;
}
interface ArmFact { outcome: Norm; requests: RequestFact[]; responses: ResponseFact[] }

const LOCAL_RE = /http:\/\/127\.0\.0\.1:\d+/g;
const localize = (s: string): string => s.replace(LOCAL_RE, "<LOCAL>");

function requestFacts(stub: StubProvider | null): RequestFact[] {
  if (stub === null) return [];
  return stub.requests.map((r) => ({
    seq: r.seq, goal: r.goal, url: localize(r.url), k: r.k, narrow: r.narrow,
    candidate_count: r.candidates.length, candidates: r.candidates,
    forbidden: [...r.forbidden].sort(), notes: r.notes,
  }));
}

function responseFacts(stub: StubProvider | null): ResponseFact[] {
  if (stub === null) return [];
  return stub.responses.map((r) => ({
    ref: r.ref, score: r.score, scoreKind: r.scoreKind, options: r.options, passthrough: r.passthrough,
  }));
}

/** legacy/newPath 两臂共用：`PilotVote` → 可比投影。 */
function voteNorm(v: PilotVote): Norm {
  switch (v.kind) {
    case "no_model_runtime":
      return { kind: "no_model", asked: 0 };
    case "low_confidence":
      return { kind: "abstained", asked: v.asked, poolKeys: v.pool === null ? null : Object.keys(v.pool) };
    case "picked": {
      const el = v.pool[v.ref];
      assert.ok(el !== undefined, `picked ref ${v.ref} 不在执行池（投影不成立）`);
      return {
        kind: "picked", asked: v.asked, ref: v.ref, conf: v.conf, shape: v.shape, via: v.via,
        poolKeys: Object.keys(v.pool), sig: JSON.stringify(esig(el)),
      };
    }
  }
}

/** ask 臂：`DecisionAskOutcome` → 可比投影（picked 只接模型档，其余按弃权投影）。 */
function outcomeNorm(o: DecisionAskOutcome): Norm {
  switch (o.kind) {
    case "no_model":
      return { kind: "no_model", asked: o.asked };
    case "limit":
      return { kind: "abstained", asked: o.asked, poolKeys: null };
    case "abstained":
      return { kind: "abstained", asked: o.asked, poolKeys: o.executionPool === null ? null : Object.keys(o.executionPool) };
    case "picked": {
      if (o.origin !== "model") {
        return { kind: "abstained", asked: o.asked, poolKeys: Object.keys(o.executionPool) };
      }
      return {
        kind: "picked", asked: o.asked, ref: o.target.ref, conf: o.signal.proposal.entropyConf,
        shape: o.signal.proposal.shape.kind, via: o.via,
        poolKeys: Object.keys(o.executionPool), sig: JSON.stringify(o.target.sig),
      };
    }
  }
}

/* ------------------------------------------------------------------ 装配 */

interface ArmRun {
  mw: BrowserMiddleware;
  page: AnyPage;
  stub: StubProvider | null;
  hosts: string[];
}

/** 单臂装配：每臂一个 middleware + 一个 stub（provider 在 `ready()` 只解析一次）。 */
async function withArm(
  opts: { turns: StubScript | null; urlPath: string | null },
  run: (ctx: ArmRun) => Promise<Norm>,
): Promise<ArmFact> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "af-parity-home-"));
  Object.assign(process.env, { AMBERFLOW_HOME: home });
  installLayaRuntime(null);
  const stub = opts.turns === null ? null : makeStubProvider(opts.turns);
  installDecisionProvider(stub === null ? null : stub.provider);
  const session = await browserSession(true);
  const mw = buildMiddleware({
    face: "online", confirmPolicy: { kind: "allow-all" },
    options: { hosts: HOSTS, maxSteps: 3, gotoTimeout: 15_000, confFloor: FLOOR },
  });
  try {
    const page = session.page;
    if (opts.urlPath !== null) await page.goto(`${ORIGIN}${opts.urlPath}`, { waitUntil: "load" });
    const outcome = await run({ mw, page, stub, hosts: HOSTS });
    return { outcome, requests: requestFacts(stub), responses: responseFacts(stub) };
  } finally {
    await session.close();
    installDecisionProvider(null);
  }
}

/* ------------------------------------------------------------------ 三臂 */

/** 对照臂：迁移前阶梯（驾驶面自己抽池并自传禁选/注记）。 */
function legacyArm(script: StubScript, urlPath: string): Promise<ArmFact> {
  return withArm({ turns: script, urlPath }, async ({ mw, page, stub }) => {
    assert.ok(stub !== null, "legacy 臂必须有 provider");
    const ledger = new PilotLedger();
    const { elems } = await mw._extractPoolSettled(page, "bucketed");
    const vote = await modelVoteLegacy({
      mw, page, goal: GOAL, elems,
      forbidden: ledger.forbiddenRefs(elems), notes: ledger.notesFor(elems),
      confFloor: FLOOR, hosts: HOSTS,
    });
    return voteNorm(vote);
  });
}

/** 新 seam 臂：直接问引擎 `DecisionAsk`（引擎自取池/读账本）。 */
function askArm(script: StubScript, urlPath: string): Promise<ArmFact> {
  return withArm({ turns: script, urlPath }, async ({ mw, page, stub }) => {
    assert.ok(stub !== null, "ask 臂必须有 provider");
    const adapter = new PilotAskAdapter(() => mw, new PilotLedger(), () => HOSTS);
    return outcomeNorm(await adapter.vote({ page, goal: GOAL, confFloor: FLOOR }));
  });
}

/** 执行路径臂：`modelVote` 委托 adapter（含驾驶面预抽池 = 记录在案的重复抽取差异）。 */
function newPathArm(script: StubScript, urlPath: string): Promise<ArmFact> {
  return withArm({ turns: script, urlPath }, async ({ mw, page, stub }) => {
    assert.ok(stub !== null, "newPath 臂必须有 provider");
    const ledger = new PilotLedger();
    const { elems } = await mw._extractPoolSettled(page, "bucketed");
    const adapter = new PilotAskAdapter(() => mw, ledger, () => HOSTS);
    const vote = await modelVote({
      mw, page, goal: GOAL, elems,
      forbidden: ledger.forbiddenRefs(elems), notes: ledger.notesFor(elems),
      confFloor: FLOOR, hosts: HOSTS, ask: adapter,
    });
    return voteNorm(vote);
  });
}

/** 降级臂：provider 不在位（modelVoteLegacy / modelVote / ask 三档都应如实 no_model）。 */
type DegradedMode = "legacy" | "ask" | "newPath";
function degradedArm(mode: DegradedMode): Promise<ArmFact> {
  return withArm({ turns: null, urlPath: null }, async ({ mw, page, hosts }) => {
    if (mode === "legacy") {
      const vote = await modelVoteLegacy({
        mw, page, goal: GOAL, elems: {}, forbidden: new Set(), notes: null, confFloor: FLOOR, hosts,
      });
      return voteNorm(vote);
    }
    const adapter = new PilotAskAdapter(() => mw, new PilotLedger(), () => hosts);
    if (mode === "ask") return outcomeNorm(await adapter.vote({ page, goal: GOAL, confFloor: FLOOR }));
    const vote = await modelVote({
      mw, page, goal: GOAL, elems: {}, forbidden: new Set(), notes: null,
      confFloor: FLOOR, hosts, ask: adapter,
    });
    return voteNorm(vote);
  });
}

/* ------------------------------------------------------------------ 差异 */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 结构差异逐条列出（数组按长度 + 逐项；对象按键并查集）。 */
function diffFacts(label: string, left: unknown, right: unknown): string[] {
  const out: string[] = [];
  const walk = (l: unknown, r: unknown, at: string): void => {
    if (JSON.stringify(l) === JSON.stringify(r)) return;
    if (Array.isArray(l) && Array.isArray(r)) {
      if (l.length !== r.length) out.push(`${at}: 长度 ${l.length} ≠ ${r.length}`);
      for (let i = 0; i < Math.min(l.length, r.length); i += 1) walk(l[i], r[i], `${at}[${i}]`);
      return;
    }
    if (isObj(l) && isObj(r)) {
      for (const k of [...new Set([...Object.keys(l), ...Object.keys(r)])].sort()) walk(l[k], r[k], `${at}.${k}`);
      return;
    }
    out.push(`${at}: ${JSON.stringify(l)} ≠ ${JSON.stringify(r)}`);
  };
  walk(left, right, label);
  return out;
}

/* ------------------------------------------------------------------ 场景 */

interface Scenario {
  name: string;
  script: StubScript;
  urlPath: string;
  /** 场景意图检查（在 legacy 臂事实上断言：剧本真走到了目标分支）。 */
  expect(fact: ArmFact): void;
}

/**
 * shortlist 形状的低置信回答：`pickProposal` 的 `shape.options` 取的是**概率条数**，
 * 闸门判 shortlist 时要 `options > 1` 且 `pTop1 < floor`——故低置信剧本必须给出多条子集概率。
 */
const lowShortlist = (snap: StubRequestSnapshot): StubTurn => {
  const probs: Record<string, number> = {};
  for (const c of snap.candidates.slice(0, 3)) probs[c.ref] = 0.05;
  return { score: 0.05, passthrough: false, probs };
};

const HIGH_CONF: StubScript = () => ({ score: 0.9, passthrough: true });
const LOW_THEN_WIDE: StubScript = (snap) => (snap.seq === 0
  ? lowShortlist(snap)
  : { score: 0.95, passthrough: true });
const ABSTAIN: StubScript = () => ({ ref: null, score: 0, scoreKind: "rank_only" });
const LOW_ONLY: StubScript = lowShortlist;

const SCENARIOS: Scenario[] = [
  {
    name: "① 窄问高置信命中", script: HIGH_CONF, urlPath: "/cards.html",
    expect: (f) => {
      assert.equal(f.requests.length, 1, "高置信不应宽扫");
      assert.equal(f.outcome.kind, "picked");
      assert.equal((f.outcome as PickedNorm).via, "ask");
    },
  },
  {
    name: "② 低置信 → 宽扫命中", script: LOW_THEN_WIDE, urlPath: "/wide.html",
    expect: (f) => {
      assert.equal(f.requests.length, 2, "低置信应触发一次宽扫重问");
      assert.ok(f.requests[1]!.candidate_count > f.requests[0]!.candidate_count, "宽扫池必须更大");
      assert.equal(f.outcome.kind, "picked");
      assert.equal((f.outcome as PickedNorm).via, "reobserve");
      assert.equal((f.outcome as PickedNorm).asked, 2);
    },
  },
  {
    name: "③ 弃权（ref null）", script: ABSTAIN, urlPath: "/cards.html",
    expect: (f) => {
      assert.equal(f.requests.length, 1, "弃权不走宽扫");
      assert.equal(f.outcome.kind, "abstained");
      assert.equal((f.outcome as AbstainedNorm).poolKeys, null);
    },
  },
  {
    name: "④ 宽扫未变大 → 弃权", script: LOW_ONLY, urlPath: "/cards.html",
    expect: (f) => {
      assert.equal(f.requests.length, 1, "宽池未变大不得重问");
      assert.equal(f.outcome.kind, "abstained");
      assert.equal((f.outcome as AbstainedNorm).asked, 1);
      assert.equal((f.outcome as AbstainedNorm).poolKeys, null);
    },
  },
];

/* ------------------------------------------------------------------ 主流程 */

interface Row { name: string; requests: number[]; outcome: string; diffs: string[] }

async function main(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const server = await startServer();
  ORIGIN = server.origin;
  const rows: Row[] = [];
  const problems: string[] = [];
  try {
    for (const s of SCENARIOS) {
      const [legacy, ask, newPath] = [await legacyArm(s.script, s.urlPath), await askArm(s.script, s.urlPath), await newPathArm(s.script, s.urlPath)];
      try {
        s.expect(legacy);
      } catch (e) {
        problems.push(`[${s.name}] 场景意图不成立：${e instanceof Error ? e.message : String(e)}`);
      }
      const diffs = [
        ...diffFacts("legacy↔ask", legacy, ask),
        ...diffFacts("legacy↔newPath", legacy, newPath),
      ];
      rows.push({ name: s.name, requests: [legacy.requests.length, ask.requests.length, newPath.requests.length], outcome: legacy.outcome.kind, diffs });
      problems.push(...diffs.map((d) => `[${s.name}] ${d}`));
    }

    // ⑤ 降级：provider 不在位，三档都必须如实 no_model 且不产生请求。
    const [legacy, ask, newPath] = [await degradedArm("legacy"), await degradedArm("ask"), await degradedArm("newPath")];
    const degradedDiffs = [
      ...diffFacts("legacy↔ask", legacy, ask),
      ...diffFacts("legacy↔newPath", legacy, newPath),
    ];
    if (legacy.outcome.kind !== "no_model") degradedDiffs.push(`legacy 降级档 kind=${legacy.outcome.kind}（应 no_model）`);
    if (legacy.requests.length !== 0) degradedDiffs.push(`降级档不得产生 provider 请求（${legacy.requests.length}）`);
    rows.push({ name: "⑤ 降级（provider 不在位）", requests: [legacy.requests.length, ask.requests.length, newPath.requests.length], outcome: legacy.outcome.kind, diffs: degradedDiffs });
    problems.push(...degradedDiffs.map((d) => `[⑤] ${d}`));
  } finally {
    await server.close();
  }

  if (json) {
    console.log(JSON.stringify({ ok: problems.length === 0, rows, problems }, null, 2));
  } else {
    console.log("S1 ask 双臂对照（5 场景 × 3 臂：legacy / ask / newPath；请求数按臂序）");
    for (const r of rows) {
      console.log(`  ${r.name.padEnd(22, " ")} requests=${r.requests.join("/")}  outcome=${r.outcome.padEnd(10, " ")} diff=${r.diffs.length}`);
    }
    if (problems.length === 0) {
      console.log("verify-decision-ask-parity: OK — 5 个场景三臂零差异");
    } else {
      for (const p of problems) console.error(`  DIFF ${p}`);
      console.error(`verify-decision-ask-parity: FAIL — ${problems.length} 处差异/意图不成立`);
    }
  }
  return problems.length === 0 ? 0 : 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error(USAGE);
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 2;
}
