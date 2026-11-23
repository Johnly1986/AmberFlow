/**
 * 决策询问 characterization lane（S0a；非门禁）：用**确定性 stub provider**把引擎询问路径的
 * 请求/返回序列钉成可比事实，供后续 S0b/S1/S2 的"行为等价"声明做度量基准。
 *
 * 为什么每档都要新建 mw：`BrowserMiddleware` 在 `ready()` 时**只解析一次** decision provider，
 * 同一 mw 内换 `installDecisionProvider` 不生效——score_kind/shape 矩阵必须每档一个 mw
 * （浏览器 session/page 可复用）。
 *
 * 钉住的投影：桩侧请求快照（goal/候选 ref+tag+label/forbidden/notes/k）+ 请求 goal 序列
 * （`goals`——run/pilot 场景的 L0 文本「当前页/已执行」由此钉住）+ 桩侧返回投影
 * （ref/score/scoreKind/signals/options/passthrough/probs）+ 执行期 step 的 phase 字段
 * （`decision_kind`/`method`/`conf`/`executed`/`changed`）与 `stop_code`。位置性 ref 只在本页
 * 内可比（同页 DOM 确定性），端口归一为 `<LOCAL>`。
 *
 * 覆盖现状（缺一条即未钉住，后续批次补齐）：
 *   ✔ pick-full / pick-shortlist / pick-none（shape 三档 + scoreKind 透传）
 *   ✔ run-rule（规则分支：零模型票 + method=rule:match + conf=1）
 *   ✔ run-wide-reobserve（低置信宽扫：第二池更大 + method 带 :reobserve）
 *   ✔ run-adjudicate（裁决档：method 以 :adjudicated 结尾）
 *   ✔ run-escalate（升级票：decision_kind=escalate、method=escalate、不产生第二次 provider 询问）
 *   ✔ run-family-repair（族不符：族空停因或 nominated_family_repair）
 *   ✔ run-r2b（词面零重叠提名：conf∈[floor,0.9) + 零重叠 → 第二次宽扫；按 conf/重叠判定进入条件）
 *   ✔ run-retry-memory（同 memory 实例两次 attempt：记忆键稳定 + rank 档第二次带注记）
 *   ✔ run-two-step-history（同一次 run 两步：第二步的 L0 goals 带「当前页」+「已执行: …[no_change]」）
 *   ✔ pilot-leg 生命周期（leg 派生 = redirect 事件计数：初始 0、redirect 后 +1、resume 不变；
 *      停因经 PilotRuntime 驾驶循环实测，非伪造）
 *
 * 用法：
 *   node --experimental-strip-types tools/verify-decision-characterization.ts [--check | --record | --list]
 * 退出码：0 绿 / 1 红（断言失败或 --record 两次不一致）/ 2 用法或环境错误。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { browserSession, type BrowserMiddleware } from "../src/engine/executor.ts";
import { buildMiddleware } from "../src/app/middleware-factory.ts";
import { installLayaRuntime } from "../src/model/model.ts";
import { installDecisionProvider } from "../src/model/decision-provider.ts";
import { makeStubProvider, type StubRequestSnapshot, type StubTurn } from "./stub-decision-provider.ts";
import { PilotRuntime, type PilotSink } from "../src/app/pilot-runtime.ts";
import type { PilotOptions } from "../src/app/pilot-contract.ts";
import type { AnyPage, RunReport } from "../src/engine/executor-types.ts";
import type { ElemPool } from "../src/engine/extraction.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const GOLDEN_DIR = path.join(REPO, "tools", "golden", "decision-characterization");
const GOLDEN_FILE = path.join(GOLDEN_DIR, "cases.json");
const USAGE = "usage: node --experimental-strip-types tools/verify-decision-characterization.ts [--check | --record | --list]";

/* ------------------------------------------------------------------ 页面 */

const CARDS_HTML = `<!doctype html><html><body>
<button id="b1">确认</button><button id="b2">取消</button><button id="b3">详情</button>
</body></html>`;

const WIDE_HTML = `<!doctype html><html><body>${Array.from({ length: 100 }, (_, i) =>
  `<button id="b${i + 1}">按钮 ${i + 1}</button>`).join("")}</body></html>`;

/** 内存页服务（随机端口，绑 127.0.0.1；只回这两条路径）。 */
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

/* ------------------------------------------------------------------ 装配 */

/** 每档一个 mw：provider 在 ready() 只解析一次（见文件头）。 */
async function withMw<T>(turns: StubTurn[] | ((snap: StubRequestSnapshot) => StubTurn),
    run: (ctx: { mw: BrowserMiddleware; page: AnyPage; origin: string; stub: ReturnType<typeof makeStubProvider>; }) => Promise<T>,
    extraOptions: Record<string, unknown> = {},
): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "af-char-home-"));
  Object.assign(process.env, { AMBERFLOW_HOME: home });
  installLayaRuntime(null);
  const stub = makeStubProvider(typeof turns === "function" ? turns : (snap) => turns[Math.min(snap.seq, turns.length - 1)]!);
  installDecisionProvider(stub.provider);
  const session = await browserSession(true);
  const page = session.page;
  const mw = buildMiddleware({
    face: "online", confirmPolicy: { kind: "allow-all" },
    options: { hosts: ["127.0.0.1"], maxSteps: 1, gotoTimeout: 15_000, confFloor: 0.5, ...extraOptions },
  });
  try {
    return await run({ mw, page, origin: ORIGIN, stub });
  } finally {
    await session.close();
    installDecisionProvider(null);
  }
}

/* ------------------------------------------------------------------ pilot 装配 */

/** pilot 面装配（leg 生命周期场景用）：stub 在 `start()` 之后、首次 `drive()` 之前安装
 *  （`mw.decision` 在 ready() 才解析，安装顺序决定是否生效）。 */
async function withPilot<T>(
    origin: string,
    turns: StubTurn[],
    run: (ctx: { rt: PilotRuntime; events: Array<Record<string, unknown>>; stub: ReturnType<typeof makeStubProvider> }) => Promise<T>,
): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "af-char-pilot-home-"));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-char-pilot-out-"));
  installLayaRuntime(null);
  const events: Array<Record<string, unknown>> = [];
  const sink: PilotSink = { respond: (obj) => { events.push(obj as Record<string, unknown>); } };
  const stub = makeStubProvider((snap) => turns[Math.min(snap.seq, turns.length - 1)]!);
  const opts: Omit<PilotOptions, "env" | "outDir"> = {
    url: `${origin}/cards.html`, goal: "zzz-no-rule-match", maxSteps: 3,
  };
  const rt = new PilotRuntime({ ...opts, env: { ...process.env, AMBERFLOW_HOME: home }, outDir }, sink);
  await rt.start();
  installDecisionProvider(stub.provider);
  try {
    return await run({ rt, events, stub });
  } finally {
    await rt.closeBrowser();
    installDecisionProvider(null);
  }
}

/** leg 派生值 = 截至此刻的改道事件计数（引擎无 leg 字段；resume 不改变它）。 */
function redirectCountOf(events: Array<Record<string, unknown>>): number {
  return events.filter((e) => e["type"] === "command_result" && e["redirected"] === true).length;
}

/* ------------------------------------------------------------------ 投影 */

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

const stable = (v: unknown): string => `${JSON.stringify(normalize(v), null, 2)}\n`;

/** 桩侧请求投影：候选只留前 4 条（宽扫页 128 条全入 golden 无意义，数量单独钉）。 */
function requestFact(snap: StubRequestSnapshot): Record<string, unknown> {
  return {
    seq: snap.seq, goal: snap.goal, url: snap.url, k: snap.k, narrow: snap.narrow,
    candidate_count: snap.candidates.length,
    candidates_head: snap.candidates.slice(0, 4),
    forbidden: snap.forbidden, notes: snap.notes,
  };
}

/** 执行期 step 投影（7 个 phase 字段里的 5 个 + 动作事实；`label` 只在该步出现）。 */
function stepFact(step: Record<string, unknown>): Record<string, unknown> {
  return {
    decision_kind: step["decision_kind"] ?? null,
    method: step["method"] ?? null,
    conf: step["conf"] ?? null,
    layaMargin: step["layaMargin"] ?? null,
    tierAsk: step["tierAsk"] ?? null,
    nominatedRepair: step["nominatedRepair"] ?? null,
    executed: step["executed"] ?? null,
    changed: step["changed"] ?? null,
  };
}

function reportFact(report: RunReport): Record<string, unknown> {
  return { stop_code: report.stop_code ?? null, steps: (report.steps as Array<Record<string, unknown>>).map(stepFact) };
}

/** 桩侧请求 goal 序列（L0 文本的唯一载荷；键序稳定 = 数组按询问顺序）。 */
function goalsOf(stub: ReturnType<typeof makeStubProvider>): string[] {
  return stub.requests.map((r) => r.goal);
}

/* ------------------------------------------------------------------ 场景 */

interface Case { name: string; run(ctx: { origin: string }): Promise<Record<string, unknown>>; }

const CASES: Case[] = [
  {
    name: "pick-full",
    run: async () => await withMw([{ score: 0.9, scoreKind: "entropy_conf", passthrough: true, probs: { e0: 0.6, e1: 0.3, e2: 0.1 } }], async ({ mw, page, origin, stub }) => {
      await page.goto(`${origin}/cards.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const p = await mw.pickProposal("选一个", page, elems as ElemPool, new Set(), null);
      assert.equal(p.shape.kind, "full", "passthrough 询问应是 full shape");
      assert.notEqual(p.choiceRef, null, "full shape 必须选中一个");
      return { request: requestFact(stub.requests[0]!), response: stub.responses[0],
        proposal: { shape: p.shape.kind, choiceRef: p.choiceRef, pTop1: p.pTop1, pTop2: p.pTop2, margin: p.margin, entropyConf: p.entropyConf } };
    }),
  },
  {
    name: "pick-shortlist",
    run: async () => await withMw([{ score: 0.8, scoreKind: "calibrated_prob", passthrough: false, probs: { e0: 0.8 } }], async ({ mw, page, origin, stub }) => {
      await page.goto(`${origin}/cards.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const p = await mw.pickProposal("选一个", page, elems as ElemPool, new Set(), null);
      assert.equal(p.shape.kind, "shortlist", "passthrough=false 询问应是 shortlist shape");
      return { request: requestFact(stub.requests[0]!), response: stub.responses[0],
        proposal: { shape: p.shape.kind, choiceRef: p.choiceRef, entropyConf: p.entropyConf } };
    }),
  },
  {
    name: "pick-none",
    run: async () => await withMw([{ ref: null, score: 0, scoreKind: "rank_only" }], async ({ mw, page, origin, stub }) => {
      await page.goto(`${origin}/cards.html`, { waitUntil: "load" });
      const { elems } = await mw._extractPoolSettled(page as never, "bucketed");
      const p = await mw.pickProposal("选一个", page, elems as ElemPool, new Set(), null);
      assert.equal(p.shape.kind, "none", "弃权应是 none shape");
      assert.equal(p.choiceRef, null, "弃权不得返回 ref");
      return { request: requestFact(stub.requests[0]!), response: stub.responses[0],
        proposal: { shape: p.shape.kind, choiceRef: p.choiceRef } };
    }),
  },
  {
    name: "run-rule",
    run: async () => await withMw([{ score: 0.1 }], async ({ mw, page, origin, stub }) => {
      const report = await mw.run("点击确认", `${origin}/cards.html`, { targetHint: "#b1", page, verbose: false });
      assert.equal(stub.requests.length, 0, "规则分支不得向模型问票");
      const step = report.steps[0] as unknown as Record<string, unknown>;
      assert.equal(step["decision_kind"], "rule", "规则分支 decision_kind=rule");
      assert.equal(step["method"], "rule:match", "规则分支 method=rule:match");
      assert.equal(step["conf"], 1, "规则分支 conf=1");
      return { ...reportFact(report), goals: goalsOf(stub) };
    }),
  },
  {
    name: "run-wide-reobserve",
    run: async () => await withMw(
      (snap) => (snap.seq === 0 ? { score: 0.05, passthrough: false, probs: { e0: 0.05 } } : { score: 0.95, passthrough: true }),
      async ({ mw, page, origin, stub }) => {
        const report = await mw.run("点一个按钮", `${origin}/wide.html`, { page, verbose: false });
        assert.equal(stub.requests.length, 2, "低置信应触发一次宽扫重问");
        assert.ok(stub.requests[1]!.candidates.length > stub.requests[0]!.candidates.length, "宽扫池必须更大");
        const step = report.steps[0] as unknown as Record<string, unknown>;
        assert.ok(String(step["method"] ?? "").includes("reobserve"), "宽扫后 method 带 :reobserve");
        return { report: reportFact(report), goals: goalsOf(stub),
          first_count: stub.requests[0]!.candidates.length, second_count: stub.requests[1]!.candidates.length };
      }),
  },
  {
    name: "run-adjudicate",
    run: async () => await withMw(
      (snap) => (snap.seq === 0 ? { score: 0.05, passthrough: false } : { score: 0.95, passthrough: true }),
      async ({ mw, page, origin, stub }) => {
        const report = await mw.run("点一个按钮", `${origin}/wide.html`, { page, verbose: false, adjudicate: true, reobserve: false });
        const step = report.steps[0] as unknown as Record<string, unknown>;
        assert.ok(String(step["method"] ?? "").endsWith(":adjudicated"), "adjudicate 档 method 应以 :adjudicated 结尾");
        return { ...reportFact(report), goals: goalsOf(stub) };
      }),
  },
  {
    name: "run-escalate",
    run: async () => await withMw([{ score: 0.05, passthrough: false }], async ({ mw, page, origin, stub }) => {
      const report = await mw.run("点一个按钮", `${origin}/wide.html`, {
        page, verbose: false, reobserve: false,
        escalateFn: (req) => Object.keys(req.criteria)[0] ?? null,
      });
      const step = report.steps[0] as unknown as Record<string, unknown>;
      assert.equal(step["decision_kind"], "escalate", "升级票命中后 decision_kind=escalate");
      assert.equal(step["method"], "escalate", "升级票 method=escalate");
      assert.equal(stub.requests.length, 1, "升级票不产生第二次 provider 询问");
      return { report: reportFact(report), asks: stub.requests.length, goals: goalsOf(stub) };
    }),
  },
  {
    name: "run-family-repair",
    run: async () => await withMw([{ score: 0.9, passthrough: true, probs: { e0: 0.9 } }], async ({ mw, page, origin, stub }) => {
      const report = await mw.run("选一个", `${origin}/cards.html`, { page, verbose: false, expectedFamily: "check" });
      const step = report.steps[0] as unknown as Record<string, unknown> | undefined;
      const repair = Boolean(step?.["nominated_family_repair"]);
      assert.ok(report.stop_code === "nominated_family_empty" || repair,
        "族不符：走族修复或族空停因（cards 页无 check 候选）");
      return { report: reportFact(report), nominated_family_repair: repair, asks: stub.requests.length, goals: goalsOf(stub) };
    }),
  },
  {
    name: "run-r2b",
    run: async () => await withMw(
      (snap) => (snap.seq === 0 ? { score: 0.6, passthrough: true, probs: { e0: 0.6 } } : { score: 0.95, passthrough: true }),
      async ({ mw, page, origin, stub }) => {
        const report = await mw.run("zzz qqq", `${origin}/wide.html`, { page, verbose: false });
        const first = stub.requests[0]!;
        const firstRef = stub.responses[0]!.ref ?? null;
        const firstLabel = first.candidates.find((c) => c.ref === firstRef)?.label ?? "";
        const words = "zzz qqq".split(/\s+/).filter((w) => w !== "");
        const overlap = words.some((w) => firstLabel.includes(w));
        assert.equal(stub.requests.length, 2, "R2b：低词面重叠提名应触发一次宽扫重问");
        assert.equal(overlap, false, "R2b 进入条件 = 提名与指令词面零重叠");
        assert.ok(stub.responses[0]!.score >= 0.5 && stub.responses[0]!.score < 0.9, "R2b 进入条件 = conf∈[floor,0.9)");
        return {
          report: reportFact(report), first_conf: stub.responses[0]!.score, lexical_overlap: overlap,
          pool_counts: [stub.requests[0]!.candidates.length, stub.requests[1]!.candidates.length],
          goals: goalsOf(stub),
        };
      }),
  },
  {
    name: "run-retry-memory",
    run: async () => {
      const { createOutcomeMemory } = await import("../src/model/outcome-memory.ts");
      const memory = createOutcomeMemory({});
      const runs: Array<Record<string, unknown>> = [];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        runs.push(await withMw(
          () => ({ score: 0.9, passthrough: true, probs: { e0: 0.9 } }),
          async ({ mw, page, origin, stub }) => {
            const report = await mw.run("点一个按钮", `${origin}/cards.html`, {
              page, verbose: false, outcomeMemory: memory,
            });
            return {
              attempt, report: reportFact(report), asks: stub.requests.length,
              notes: stub.requests.map((r) => r.notes), goals: goalsOf(stub),
              memory_key: memory.key(`${origin}/cards.html`, "点一个按钮"),
            };
          },
          { outcomeMemoryMode: "rank" },
        ));
      }
      const key1 = String(runs[0]!["memory_key"]).replace(/127\.0\.0\.1:\d+/, "<LOCAL>");
      const key2 = String(runs[1]!["memory_key"]).replace(/127\.0\.0\.1:\d+/, "<LOCAL>");
      assert.equal(key1, key2, "同 url+instruction 的记忆键跨 attempt 稳定");
      assert.equal(runs.length, 2, "工具侧 attempt 计数 1→2");
      const secondNotes = runs[1]!["notes"] as Array<Record<string, string> | null>;
      const hasNote = secondNotes.some((n) => n !== null && Object.keys(n).length > 0);
      assert.equal(hasNote, true, "rank 档第二次 attempt 应带记忆注记");
      return { attempts: runs.length, keys_equal: true, first_notes: runs[0]!["notes"], second_notes: secondNotes,
        attempt_goals: runs.map((r) => r["goals"]) };
    },
  },
  {
    name: "run-two-step-history",
    run: async () => await withMw(
      () => ({ score: 0.9, passthrough: true, probs: { e0: 0.9 } }),
      async ({ mw, page, origin, stub }) => {
        const report = await mw.run("点一个按钮", `${origin}/cards.html`, { page, verbose: false });
        assert.equal(report.steps.length, 2, "两步预算应各执行一次动作");
        const goals = goalsOf(stub);
        assert.equal(goals.length, 2, "两步各问票一次");
        assert.ok(goals[0]!.includes("当前页"), "第一步 L0 带当前页");
        assert.equal(goals[0]!.includes("已执行"), false, "第一步前无步史");
        assert.ok(goals[1]!.includes("当前页"), "第二步 L0 仍带当前页");
        assert.ok(goals[1]!.includes("已执行:"), "第二步 L0 折入已执行步史");
        assert.ok(/\[no_change\]/.test(goals[1]!), "静态页点击后的步史 outcome 必须是 no_change");
        return { goals, stop_code: report.stop_code ?? null, steps: report.steps.length };
      },
      { maxSteps: 2 },
    ),
  },
  {
    name: "pilot-leg-lifecycle",
    run: async () => await withPilot(ORIGIN, [{ ref: null, score: 0 }], async ({ rt, events, stub }) => {
      const stop1 = await rt.drive();
      assert.equal(stop1, "low_confidence", "stub 弃权 → low_confidence 交接");
      const legs0 = redirectCountOf(events);
      assert.equal(legs0, 0, "初始 leg 计数为 0");
      const redirected = await rt.handleLine(`{"cmd":"redirect","url":"${ORIGIN}/wide.html"}`);
      assert.equal(redirected, "drive", "redirect 后回到驾驶轮");
      const legs1 = redirectCountOf(events);
      assert.equal(legs1, 1, "redirect = 换 leg（计数 +1）");
      const stop2 = await rt.drive();
      assert.equal(stop2, "low_confidence", "改道后仍是弃权停");
      assert.equal(redirectCountOf(events), 1, "驾驶轮不额外改道");
      const resumed = await rt.handleLine('{"cmd":"resume","hint":"#b1"}');
      assert.equal(resumed, "drive", "resume 回到驾驶轮");
      const stop3 = await rt.drive();
      assert.ok(typeof stop3 === "string", "resume 后仍返回结构化停因");
      assert.equal(redirectCountOf(events), 1, "resume 保留同 leg（计数不变）");
      return {
        stops: [stop1, stop2, stop3], legs: [legs0, legs1, redirectCountOf(events)],
        handoffs: events.filter((e) => e["type"] === "handoff").length, goals: goalsOf(stub),
      };
    }),
  },
];

/* ------------------------------------------------------------------ 主流程 */

async function observeAll(): Promise<Record<string, unknown>> {
  const cases: Record<string, unknown> = {};
  for (const c of CASES) cases[c.name] = await c.run({ origin: ORIGIN });
  return { schema: 1, cases };
}

let ORIGIN = "";

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--list")) {
    for (const c of CASES) console.log(c.name);
    return 0;
  }
  const recordMode = argv.includes("--record");
  const server = await startServer();
  ORIGIN = server.origin;
  try {
    const first = await observeAll();
    if (!recordMode) {
      if (!fs.existsSync(GOLDEN_FILE)) { console.error(`verify-decision-characterization: 缺少金标 ${GOLDEN_FILE}（--record 生成）`); return 1; }
      const golden = fs.readFileSync(GOLDEN_FILE, "utf8");
      if (golden !== stable(first)) { console.error("verify-decision-characterization: FAIL — 观测与金标不一致"); return 1; }
      console.log(`verify-decision-characterization: OK — ${CASES.length} 个场景与金标一致`);
      return 0;
    }
    const second = await observeAll();
    if (stable(first) !== stable(second)) { console.error("verify-decision-characterization: FAIL — --record 两次不一致（不稳定，不入库）"); return 1; }
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(GOLDEN_FILE, stable(first));
    console.log(`verify-decision-characterization: 已记录 ${CASES.length} 个场景 → ${path.relative(REPO, GOLDEN_FILE)}`);
    return 0;
  } finally {
    await server.close();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error(USAGE);
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 2;
}
