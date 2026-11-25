/**
 * verify-walk-r1 —— **非门禁**的走查第一轮修复验收 lane（本地 fixtures，零站点、零模型）。
 *
 * 一张表七组断言，每组都对应一次真实走查暴露的缺陷；每组的判据都是**可失败**的观测
 * （子进程会话协议行 / 纯函数返回），不是"能跑就算过"：
 *
 *   A1 `act` 的 `ok` 与 `ambiguous` 不得同时为真（弱档旁路不得把已执行动作说成歧义）；
 *      四场景全跑：强档唯一+弱档相似 / 同 label 同签名 / 同 label 异 href / 单候选。
 *   A2 耦合双柄 `set_range` 越界拒绝必须点名"命中的是哪一个柄"与各柄自己的 min/max；
 *      单柄越界 reason **逐字节不变**（`SINGLE_RANGE_REASON` 是改动前的原文）。
 *   A3 CSS 属性操作符（`*=`/`^=`/`$=`/`|=`）出 `css-attr-operator` 形态诊断；
 *      `~=`（含带引号写法）是合法闭集操作符、不得误报；`#outer input` 仍是 `selector-syntax`。
 *   A4 无显示器时 headful 启动失败 = `config_error` + headless/xvfb 建议，**会话不终结**
 *      （后续 close 正常）；运行期被杀浏览器仍归 `browser_dead`。
 *   A5 `goto` 落地后路径形状被改写（丢段/空段）时回传 additive 三键 + reason 提示；
 *      形状保留的合法重定向**键集逐字节不变**；判据九个 URL 形状逐条钉死。
 *   A6 标准滚动器找不到但存在"内容溢出 + overflow:hidden"祖先时回退 programmatic 滚动
 *      （`strategy:"programmatic"`）；标准 `overflow:auto` 容器**不出现**该键；
 *      会话面 `act scroll target=page` 是合成目标（滚整页），不再当 hint 撞能力墙。
 *   B15 `moved:false` 与"已在底部"可分：到底时带 `at_bottom:true`。
 *
 * 用法：node --experimental-strip-types tools/verify-walk-r1.ts [--json]
 * 退出码：0 = 全部断言绿；1 = 有断言红；2 = 用法错误。
 * 需要 chromium（起真实会话子进程）；不进 `npm run check`。
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { parseHint, hintShapeProblem } from "../src/engine/hint.ts";
import { landedPathShapeChanged } from "../src/app/session-runtime-contract.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const USAGE = "usage: node --experimental-strip-types tools/verify-walk-r1.ts [--json]";
const FLAGS = process.argv.slice(2);
for (const f of FLAGS) if (f !== "--json") { console.error(USAGE); process.exit(2); }
const JSON_OUT = FLAGS.includes("--json");
const SESSION_TIMEOUT_MS = 240_000;
const UNREACHABLE_PROVIDER = "http://127.0.0.1:1";

/** 单柄滑杆越界 reason 的**改动前原文**（本 lane 的逐字节基线）。 */
const SINGLE_RANGE_REASON = "requested value 170 is outside the slider range [0, 100] "
  + "(would clamp to 100) — refused without any interaction (never pretend success; "
  + "narrow the request or pick a control whose range covers the target)";

/* ------------------------------------------------------------------ 本地夹具 */

const PAGE_HEAD = "<!doctype html><html><head><meta charset=\"utf-8\"><title>walk-r1</title></head><body>";
const PAGE_TAIL = "</body></html>";

const STRONG_WEAK = `${PAGE_HEAD}
<button id="exact">See more</button>
<button id="weak">Open 24 hours · See more hours</button>
${PAGE_TAIL}`;
const DUP_SAME = `${PAGE_HEAD}<button>See more</button><button>See more</button>${PAGE_TAIL}`;
const DUP_HREF = `${PAGE_HEAD}<a href="/a">Details</a><a href="/b">Details</a>${PAGE_TAIL}`;
const SINGLE_BUTTON = `${PAGE_HEAD}<button>See more</button>${PAGE_TAIL}`;

const DUAL_RANGE = `${PAGE_HEAD}
<div id="dual">
  <input id="lo" type="range" min="0" max="10" value="0">
  <input id="hi" type="range" min="1" max="11" value="11">
</div>
${PAGE_TAIL}`;
const SINGLE_RANGE = `${PAGE_HEAD}<input id="vol" type="range" min="0" max="100" step="10" value="10">${PAGE_TAIL}`;

/** A6：overflow:hidden + 内容溢出（程序可滚面板）。 */
const HIDDEN_SCROLL = `${PAGE_HEAD}
<style>#panel{height:200px;overflow:hidden;border:1px solid #000}
#inner{height:2000px;background:linear-gradient(red,blue)}</style>
<div id="panel"><div id="inner"><button id="deep">Deep</button></div></div>
${PAGE_TAIL}`;
/** A6/B15 反例：标准 overflow:auto 滚动器。 */
const STD_SCROLL = `${PAGE_HEAD}
<style>#std{height:120px;overflow:auto;border:1px solid #333}#stdin{height:1200px}</style>
<div id="std"><div id="stdin">x</div></div>
${PAGE_TAIL}`;
/** A6：会话面 `target=page` 合成目标（整页可滚）。 */
const TALL_DOC = `${PAGE_HEAD}<div style="height:3000px">tall</div>${PAGE_TAIL}`;


/** A8/R2-SCROLL：文档自身不可滚，内容装在内层滚动容器里（`overflow:hidden` 的 body + 内层 auto）。 */
const INNER_SCROLL = `${PAGE_HEAD}<style>html,body{height:100%;margin:0;overflow:hidden}#panel{height:600px;overflow:auto}#deep{height:3000px}</style><div id="panel"><div id="deep">tall</div></div>${PAGE_TAIL}`;

const ROUTES: Record<string, { body?: string; redirect?: string }> = {
  "/strong": { body: STRONG_WEAK },
  "/dup": { body: DUP_SAME },
  "/dup-href": { body: DUP_HREF },
  "/single": { body: SINGLE_BUTTON },
  "/range-dual": { body: DUAL_RANGE },
  "/range-single": { body: SINGLE_RANGE },
  "/hidden": { body: HIDDEN_SCROLL },
  "/std": { body: STD_SCROLL },
  "/tall": { body: TALL_DOC },
  "/inner-scroll": { body: INNER_SCROLL },
  // A5：丢段（实体段清空）与"追加 query 的合法重定向"两条对照夹具。
  "/place/X/data=!4m8": { redirect: "/place//@1.3,103.8,11z" },
  "/place//@1.3,103.8,11z": { body: SINGLE_BUTTON },
  "/a/b/c": { redirect: "/a/b" },
  "/a/b": { body: SINGLE_BUTTON },
  "/same/path": { body: SINGLE_BUTTON },
};

async function startFixtureServer(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const route = ROUTES[pathname];
    if (route === undefined) { res.statusCode = 404; res.end("not found"); return; }
    if (route.redirect !== undefined) {
      res.statusCode = 302;
      res.setHeader("location", route.redirect);
      res.end();
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(route.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/* ------------------------------------------------------------------ 会话子进程 */

interface Step { id: number; request: Record<string, unknown> }

interface SessionRun {
  exitCode: number;
  responses: Map<number, Record<string, unknown>>;
  sessionEnds: Array<Record<string, unknown>>;
  stderrTail: string;
}

async function runSession(steps: Step[], dir: string, env: NodeJS.ProcessEnv): Promise<SessionRun> {
  const inputFile = path.join(dir, "requests.jsonl");
  fs.writeFileSync(inputFile, `${steps.map((s) => JSON.stringify({ id: s.id, ...s.request })).join("\n")}\n`);
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, [
    "--experimental-strip-types", "src/cli/main.ts", "session",
    "--input", inputFile, "--out", path.join(dir, "session-evidence"),
    "--idle-timeout-ms", String(SESSION_TIMEOUT_MS),
  ], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AMBERFLOW_HOME: home, ...env },
  });
  const responses = new Map<number, Record<string, unknown>>();
  const sessionEnds: Array<Record<string, unknown>> = [];
  let stderrTail = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      const text = line.trim();
      if (text === "") continue;
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { continue; }
      if (typeof parsed !== "object" || parsed === null) continue;
      const obj = parsed as Record<string, unknown>;
      if (obj["type"] === "session_end") { sessionEnds.push(obj); continue; }
      if (typeof obj["id"] === "number") responses.set(obj["id"], obj);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderrTail = (stderrTail + chunk).slice(-4_000); });
  const exitCode = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => { try { child.kill(); } catch { /* dead */ } resolve(-99); }, SESSION_TIMEOUT_MS);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code ?? -1); });
  });
  return { exitCode, responses, sessionEnds, stderrTail };
}

/** 零模型的会话环境（决策源不可达：本 lane 只走确定性解析/动作面）。 */
const SESSION_ENV: NodeJS.ProcessEnv = {
  AMBERFLOW_DECISION_BASE_URL: UNREACHABLE_PROVIDER,
  AMBERFLOW_DECISION_API_KEY: "unused-lane-key",
  AMBERFLOW_DECISION_MODEL: "unused-lane-model",
};

/* ------------------------------------------------------------------ 断言收集 */

const problems: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) problems.push(message);
}

function resp(run: SessionRun, id: number, what: string): Record<string, unknown> | undefined {
  const r = run.responses.get(id);
  if (r === undefined) problems.push(`#${id}（${what}）没有协议响应`);
  return r;
}

/** A2：单柄越界 reason 逐字节基线（reason 里除正文外不许有新增尾巴）。 */
function checkReasonPrefix(actual: unknown, expected: string, what: string): void {
  const text = String(actual ?? "");
  check(text.startsWith(expected), `${what}：reason 前言应逐字节等于基线（实际 ${JSON.stringify(text.slice(0, 260))}）`);
  check(text === expected, `${what}：单柄 reason 应逐字节不变（尾部出现新增内容：${JSON.stringify(text.slice(expected.length))}）`);
}

/* ------------------------------------------------------------------ 剧本 */

function script(origin: string): { steps: Step[]; index: Record<string, number> } {
  const steps: Step[] = [];
  const index: Record<string, number> = {};
  let id = 0;
  const add = (key: string, request: Record<string, unknown>): void => {
    id += 1;
    index[key] = id;
    steps.push({ id, request });
  };
  const open = (key: string, page: string): void => add(key, { type: "open", url: `${origin}${page}` });

  // ---- A1：四场景 --------------------------------------------------------
  open("a1-open-strong", "/strong");
  add("a1-strong", { type: "act", op: "click", target: "See more" });          // 强档唯一+弱档相似
  add("a1-open-dup", { type: "open", url: `${origin}/dup` });
  add("a1-dup", { type: "act", op: "click", target: "See more" });             // 同 label 同签名
  add("a1-open-href", { type: "open", url: `${origin}/dup-href` });
  add("a1-href", { type: "act", op: "click", target: "Details" });             // 同 label 异 href
  add("a1-open-single", { type: "open", url: `${origin}/single` });
  add("a1-single", { type: "act", op: "click", target: "See more" });          // 单候选
  // 非 click 的 op 也各跑一次（不变量要覆盖能产出 ambiguous 的所有路径）。
  add("a1-fill-strong", { type: "open", url: `${origin}/strong` });
  add("a1-fill", { type: "act", op: "fill", target: "See more", value: "x" });
  add("a1-check-dup", { type: "open", url: `${origin}/dup` });
  add("a1-check", { type: "act", op: "check", target: "See more" });
  add("a1-select", { type: "act", op: "select", target: "See more", value: "x" });

  // ---- A2：双柄/单柄 set_range -----------------------------------------
  add("a2-open-dual", { type: "open", url: `${origin}/range-dual` });
  add("a2-dual-out", { type: "act", op: "set_range", target: "input[type=range]", value: { value: 11 } });
  add("a2-dual-percent", { type: "act", op: "set_range", target: "input[type=range]", value: { percent: 50 } });
  add("a2-open-single", { type: "open", url: `${origin}/range-single` });
  add("a2-single-out", { type: "act", op: "set_range", target: "input[type=range]", value: { value: 170 } });

  // ---- A5：goto 落地形状 -----------------------------------------------
  add("a5-goto-drop", { type: "goto", url: `${origin}/place/X/data=!4m8` });
  add("a5-goto-lose", { type: "goto", url: `${origin}/a/b/c` });
  add("a5-goto-ok", { type: "goto", url: `${origin}/same/path?entry=ttu` });

  // ---- A6 + B15：滚动 ---------------------------------------------------
  add("a6-open-hidden", { type: "open", url: `${origin}/hidden` });
  add("a6-hidden", { type: "act", op: "scroll", target: "#deep", to: "bottom" });
  add("a6-open-std", { type: "open", url: `${origin}/std` });
  add("a6-std", { type: "act", op: "scroll", target: "#std", to: "bottom" });
  add("b15-std-again", { type: "act", op: "scroll", target: "#std", to: "bottom" });
  add("a6-open-tall", { type: "open", url: `${origin}/tall` });
  add("a6-page", { type: "act", op: "scroll", target: "page", to: "bottom" });
  // ---- A8：文档不可滚时回退到内部滚动容器 ---------------------------------
  add("a8-open", { type: "open", url: `${origin}/inner-scroll` });
  add("a8-doc", { type: "act", op: "scroll", target: "document", to: "bottom" });

  add("close", { type: "close" });
  return { steps, index };
}

/* ------------------------------------------------------------------ A7：死页不得被吞成空结果 */

/**
 * A7 走**进程内**会话（不是 CLI 子进程）：需要先拿到 page 再把它关掉，请求面没有"关页"原语。
 * 断言的是诚实性：page 关闭后 `observe` / `snapshot` / `read` 必须报 `browser_dead`，
 * 而不是 `ok:true` + 空元素 / 全空 snapshot / `value:null`（死页信号被吞成"页面没内容"）。
 */
async function assertDeadPageHonest(): Promise<void> {
  const { SessionRuntime } = await import("../src/app/session-runtime.ts");
  const { installDecisionProvider } = await import("../src/model/decision-provider.ts");
  const { installLayaRuntime } = await import("../src/model/model.ts");
  installLayaRuntime(null);
  installDecisionProvider(null);
  const fixture = await startFixtureServer();
  const out: Array<Record<string, unknown>> = [];
  const sink = { respond: (obj: Record<string, unknown>) => { out.push(obj); }, log: () => { /* quiet */ } };
  const rt = new SessionRuntime({
    url: `${fixture.origin}/std`, hosts: ["127.0.0.1"], headful: false, quiet: true,
  } as never, sink as never, "walk-r1-dead");
  try {
    await rt.start();
    const page = await (rt as unknown as { page(): Promise<{ close(): Promise<void> }> }).page();
    await page.close();
    for (const [key, request] of [
      ["observe", { id: 90, type: "observe", max: 20 }],
      ["snapshot", { id: 91, type: "snapshot" }],
      ["read", { id: 92, type: "read", selector: "body", what: "text" }],
    ] as const) {
      out.length = 0;
      await rt.handleLine(JSON.stringify(request));
      const r = out.find((o) => o["id"] === request.id);
      check(r !== undefined, `A7 ${key}：死页后应有响应（不是静默无输出）`);
      check(r?.["ok"] === false, `A7 ${key}：死页后不得回 ok:true（拿到 ${JSON.stringify(r?.["ok"])}，完整=${JSON.stringify(r).slice(0, 160)}）`);
      check(r?.["code"] === "browser_dead", `A7 ${key}：死页应报 browser_dead（拿到 ${JSON.stringify(r?.["code"])}）`);
    }
  } finally {
    try { await rt.handleLine(JSON.stringify({ id: 99, type: "close" })); } catch { /* 已死 */ }
    await fixture.close();
  }
}

/* ------------------------------------------------------------------ A1/A2/A5/A6 断言 */

function assertSession(run: SessionRun, index: Record<string, number>): void {
  for (const end of run.sessionEnds) problems.push(`出现非预期 session_end（${JSON.stringify(end)}）`);
  check(run.exitCode === 0, `会话子进程 exit=${run.exitCode}（应 0）`);

  /* A1：不变量 + 四场景 */
  const a1Keys = ["a1-strong", "a1-dup", "a1-href", "a1-single", "a1-fill", "a1-check", "a1-select"];
  for (const key of a1Keys) {
    const r = resp(run, index[key]!, key);
    if (r === undefined) continue;
    check(!(r["ok"] === true && r["ambiguous"] === true), `A1 ${key}：ok 与 ambiguous 不得同时为真（${JSON.stringify(r)}）`);
    // 恒等式：ambiguous 恰等于"结果码是 target_ambiguous"。
    check((r["ambiguous"] === true) === (r["code"] === "target_ambiguous"),
      `A1 ${key}：ambiguous 必须恰等于 code===target_ambiguous（ok=${JSON.stringify(r["ok"])} code=${JSON.stringify(r["code"])} ambiguous=${JSON.stringify(r["ambiguous"])}）`);
  }
  const strong = resp(run, index["a1-strong"]!, "a1-strong");
  if (strong !== undefined) {
    check(strong["ok"] === true, `A1 强档唯一+弱档相似应 ok:true（code=${JSON.stringify(strong["code"])}）`);
    check(strong["ambiguous"] !== true, `A1 强档唯一命中时不得报 ambiguous（拿到 ${JSON.stringify(strong["ambiguous"])}）`);
    // 弱档旁路的"还有相似候选"提示照旧回显（它不是歧义判决）。
    check(Array.isArray(strong["matched_others"]), "A1 成功响应仍应回显 matched_others（相似候选提示）");
  }
  const dup = resp(run, index["a1-dup"]!, "a1-dup");
  if (dup !== undefined) {
    check(dup["ok"] === false && dup["code"] === "target_ambiguous",
      `A1 同 label 同签名应 ok:false code=target_ambiguous（拿到 ok=${JSON.stringify(dup["ok"])} code=${JSON.stringify(dup["code"])}）`);
    check(dup["ambiguous"] === true, `A1 同 label 同签名应 ambiguous:true（拿到 ${JSON.stringify(dup["ambiguous"])}）`);
  }
  const href = resp(run, index["a1-href"]!, "a1-href");
  if (href !== undefined) {
    check(href["ok"] === false && href["code"] === "target_ambiguous", "A1 同 label 异 href 仍是零动作歧义");
    check(href["ambiguous"] === true, "A1 同 label 异 href 应 ambiguous:true");
  }
  const single = resp(run, index["a1-single"]!, "a1-single");
  if (single !== undefined) {
    check(single["ok"] === true, "A1 单候选应 ok:true");
    check(single["ambiguous"] !== true, "A1 单候选不得报 ambiguous");
  }

  /* A2：双柄越界补事实 / 单柄 reason 逐字节不变 */
  const dual = resp(run, index["a2-dual-out"]!, "a2-dual-out");
  if (dual !== undefined) {
    check(dual["ok"] === false && dual["code"] === "value_out_of_range",
      `A2 双柄越界仍是 value_out_of_range（拿到 ${JSON.stringify(dual["code"])}）`);
    const reason = String(dual["reason"] ?? "");
    check(/matched 2 same-shaped range handles/.test(reason),
      `A2 双柄越界 reason 应点名"命中 N 个同形手柄"（拿到 ${JSON.stringify(reason.slice(0, 400))}）`);
    check(/handle #1/.test(reason), `A2 reason 应点名本次作用于第几个手柄（拿到 ${JSON.stringify(reason.slice(0, 400))}）`);
    check(/min=0 max=10/.test(reason) && /min=1 max=11/.test(reason),
      `A2 reason 应带各柄自己的 min/max（拿到 ${JSON.stringify(reason.slice(0, 400))}）`);
    // peers 结构化事实（多柄才有）：各柄 min/max 都齐，不靠解析 reason。
    const peers = Array.isArray(dual["peers"]) ? dual["peers"] as Array<Record<string, unknown>> : [];
    check(peers.length === 2, `A2 双柄响应应带 2 条 peers（拿到 ${peers.length}）`);
    check(peers.some((p) => p["min"] === 0 && p["max"] === 10) && peers.some((p) => p["min"] === 1 && p["max"] === 11),
      `A2 peers 应带出两个柄各自的值域（拿到 ${JSON.stringify(peers)}）`);
    check(dual["handle_index"] === 1, `A2 handle_index 应如实为 1（拿到 ${JSON.stringify(dual["handle_index"])}）`);
    check(typeof dual["row_index"] === "number",
      `A2 池侧 row_index 也应带出（与 handle_index 是两条不同的序；拿到 ${JSON.stringify(dual["row_index"])}）`);
  }
  const dualPct = resp(run, index["a2-dual-percent"]!, "a2-dual-percent");
  if (dualPct !== undefined) {
    check(dualPct["code"] === "config_error" && /percent is not applicable/.test(String(dualPct["reason"] ?? "")),
      "A2 percent 在双柄仍是 config_error（现状保持）");
    check(/row-index:N/.test(String(dualPct["reason"] ?? "")),
      `A2 percent 拒绝 reason 应点名 row-index:N 解法（拿到 ${JSON.stringify(String(dualPct["reason"] ?? "").slice(0, 300))}）`);
  }
  const singleOut = resp(run, index["a2-single-out"]!, "a2-single-out");
  if (singleOut !== undefined) checkReasonPrefix(singleOut["reason"], SINGLE_RANGE_REASON, "A2 单柄越界");
  if (singleOut !== undefined) {
    check(!("peers" in singleOut) && !("handle_index" in singleOut),
      `A2 单柄响应不得出现 peers/handle_index（键集不变；拿到 ${JSON.stringify(Object.keys(singleOut))}）`);
  }

  /* A5：落地形状变化 = additive 三键 + reason；形状保留 = 键集不变 */
  const drop = resp(run, index["a5-goto-drop"]!, "a5-goto-drop");
  if (drop !== undefined) {
    check(drop["ok"] === true, "A5 形状变化不得改 ok 语义（合法重定向不能判失败）");
    check(drop["landed_path_shape_changed"] === true, `A5 丢段应带 landed_path_shape_changed:true（拿到 ${JSON.stringify(drop["landed_path_shape_changed"])}）`);
    check(typeof drop["requested_url"] === "string" && typeof drop["landed_url"] === "string",
      "A5 应同时回传 requested_url / landed_url");
    check(/landed path shape changed/.test(String(drop["reason"] ?? "")), "A5 应在 reason 尾追加落地形状提示");
  }
  const lose = resp(run, index["a5-goto-lose"]!, "a5-goto-lose");
  if (lose !== undefined) {
    check(lose["landed_path_shape_changed"] === true, "A5 丢段（/a/b/c → /a/b）应被识别");
  }
  const okNav = resp(run, index["a5-goto-ok"]!, "a5-goto-ok");
  if (okNav !== undefined) {
    const keys = Object.keys(okNav).sort().join(",");
    check(keys === "hosts,id,ok,title,type,url", `A5 形状保留的合法重定向键集应逐字节不变（拿到 ${keys}）`);
    check(!("reason" in okNav), "A5 形状保留时不得追加 reason");
  }

  /* A8：文档不可滚 → 回退内部容器，并如实带回用了哪个容器（标准路径不带 container） */
  const a8 = resp(run, index["a8-doc"]!, "a8-doc");
  if (a8 !== undefined) {
    check(a8["ok"] === true, `A8 文档不可滚时应回退内部容器（code=${JSON.stringify(a8["code"])} reason=${JSON.stringify(String(a8["reason"] ?? "").slice(0, 200))}）`);
    check(a8["moved"] === true, `A8 回退滚动应真的移动（moved=${JSON.stringify(a8["moved"])}）`);
    check(a8["container"] === "div#panel", `A8 应如实带回回退用的容器（拿到 ${JSON.stringify(a8["container"])}）`);
  }

  /* A6：programmatic 回退 / 标准滚动器不带 strategy / page 是合成目标 */
  const hidden = resp(run, index["a6-hidden"]!, "a6-hidden");
  if (hidden !== undefined) {
    check(hidden["ok"] === true, `A6 overflow:hidden 面板应可滚（code=${JSON.stringify(hidden["code"])} reason=${JSON.stringify(String(hidden["reason"] ?? "").slice(0, 200))}）`);
    check(hidden["strategy"] === "programmatic", `A6 回退策略应标 strategy:"programmatic"（拿到 ${JSON.stringify(hidden["strategy"])}）`);
    check(hidden["moved"] === true, `A6 moved 应实测为 true（拿到 ${JSON.stringify(hidden["moved"])}）`);
  }
  const std = resp(run, index["a6-std"]!, "a6-std");
  if (std !== undefined) {
    check(std["ok"] === true, "A6 标准 overflow:auto 容器应可滚");
    check(!("strategy" in std), `A6 标准滚动器不得出现 strategy 键（拿到 ${JSON.stringify(Object.keys(std))}）`);
  }
  // B15：第二次滚同一个标准容器 = 已在底部 → moved:false + at_bottom:true。
  const again = resp(run, index["b15-std-again"]!, "b15-std-again");
  if (again !== undefined) {
    check(again["moved"] === false, `B15 已在底部时 moved 应为 false（拿到 ${JSON.stringify(again["moved"])}）`);
    check(again["at_bottom"] === true, `B15 已在底部应带 at_bottom:true（拿到 ${JSON.stringify(again["at_bottom"])}，键集 ${JSON.stringify(Object.keys(again))}）`);
  }
  const pageScroll = resp(run, index["a6-page"]!, "a6-page");
  if (pageScroll !== undefined) {
    check(pageScroll["ok"] === true, `A6 会话面 target=page 应是合成目标（拿到 code=${JSON.stringify(pageScroll["code"])} reason=${JSON.stringify(String(pageScroll["reason"] ?? "").slice(0, 240))}）`);
    check(pageScroll["moved"] === true, "A6 target=page 应真的滚了（moved 实测）");
  }
}

/* ------------------------------------------------------------------ A3 纯函数 */

function assertHintShape(): void {
  const cssOperators: Array<[string, string]> = [
    ["a[href*=\"maps.google\"]", "*="],
    ["a[href^=\"https\"]", "^="],
    ["a[href$=\".com\"]", "$="],
    ["a[lang|=\"en\"]", "|="],
  ];
  for (const [hint, op] of cssOperators) {
    const problem = hintShapeProblem(hint);
    check(problem !== null && problem.kind === "css-attr-operator",
      `A3 ${op} 应出 css-attr-operator 诊断（拿到 ${JSON.stringify(problem?.kind ?? null)}）`);
    if (problem !== null) {
      check(/CSS/.test(problem.reason) || /操作符/.test(problem.reason),
        `A3 ${op} reason 应说明这是 CSS 选择器操作符`);
      check(/\[.*~/.test(problem.suggestion), `A3 ${op} suggestion 应给出可照抄的 `+"`tag[attr~substr]`"+` 写法`);
    }
  }
  // 反例：`~=`（含带引号写法）是闭集合法操作符，不得误报；解析出的值也不得带 `="` 前缀。
  for (const hint of ["a[href~maps.google]", "a[href~=\"maps.google\"]"]) {
    check(hintShapeProblem(hint) === null, `A3 \`${hint}\` 是闭集合法形状，不得出形态诊断`);
    const parsed = parseHint(hint);
    check(parsed.kind === "attrSubstr" && parsed.value === "maps.google",
      `A3 \`${hint}\` 应解析成 attrSubstr 且值为 maps.google（拿到 ${JSON.stringify(parsed)}）`);
  }
  check(hintShapeProblem("a[href=Alan_Turing]") === null, "A3 等值形状不得出形态诊断");
  check(hintShapeProblem("#outer input")?.kind === "selector-syntax",
    "A3 `#outer input` 仍应出 selector-syntax（既有诊断不回归）");
}

/* ------------------------------------------------------------------ A5 纯函数九例 */

function assertLandedShape(): void {
  const rows: Array<{ requested: string; landed: string; changed: boolean; note: string }> = [
    { requested: "/maps/place/6ix+6ix/data=!4m8", landed: "/maps/place//@1.314,103.84425,11z", changed: true, note: "落地位变空" },
    { requested: "/maps/place/X/data=!4m8", landed: "/maps/place/X/data=!4m8?entry=ttu", changed: false, note: "追加 query 的合法重定向" },
    { requested: "/a/b", landed: "/a/b", changed: false, note: "原样" },
    { requested: "/a/b", landed: "/a/b/", changed: false, note: "trailing slash" },
    { requested: "/list?page=1", landed: "/list?page=1&lang=en", changed: false, note: "追加 query 参数" },
    { requested: "/place/A/x", landed: "/place/B/x", changed: false, note: "换实体但不丢段（不做实体识别）" },
    { requested: "/a/b/c", landed: "/a/b", changed: true, note: "丢段" },
    { requested: "/", landed: "/home", changed: false, note: "首页重定向不判" },
    { requested: "not a url", landed: "/a/b", changed: false, note: "不可解析 = 不判" },
  ];
  for (const row of rows) {
    const shape = landedPathShapeChanged(row.requested, row.landed);
    // null = 不可解析 ⇒ 不判（等价于"不报形状变化"，且不打 additive 键）。
    const actual = shape === null ? false : shape.changed;
    check(actual === row.changed,
      `A5 形状判据 ${JSON.stringify(row.requested)} → ${JSON.stringify(row.landed)} 应 changed=${row.changed}（${row.note}；拿到 ${JSON.stringify(shape)}）`);
  }
}

/* ------------------------------------------------------------------ A4 子进程（无 DISPLAY） */

interface ChildOut { code: number | null; stdout: string; stderr: string }

function runCli(args: string[], env: NodeJS.ProcessEnv, dir: string): Promise<ChildOut> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/cli/main.ts", ...args], {
    cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AMBERFLOW_HOME: path.join(dir, "home"), ...SESSION_ENV, ...env },
  });
  let stdout = "", stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (c: string) => { stdout += c; });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (c: string) => { stderr += c; });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill(); } catch { /* dead */ } }, SESSION_TIMEOUT_MS);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** 无 DISPLAY 时 headful 启动失败：config_error + 建议 + 会话不终结。 */
async function assertHeadfulWithoutDisplay(dir: string): Promise<void> {
  // 显式 unset DISPLAY（env 里给空串等价于"没有可用 X"；这里用 delete 语义的子进程环境）。
  const env: NodeJS.ProcessEnv = { ...SESSION_ENV };
  delete env["DISPLAY"];
  const reqFile = path.join(dir, "headful.jsonl");
  fs.writeFileSync(reqFile, `${JSON.stringify({ id: 1, type: "open", url: "http://127.0.0.1:9/" })}\n${JSON.stringify({ id: 2, type: "close" })}\n`);
  const out = await runCli([
    "session", "--headful", "--input", reqFile, "--out", path.join(dir, "headful-out"),
    "--idle-timeout-ms", String(SESSION_TIMEOUT_MS),
  ], { ...env, DISPLAY: "" }, dir);
  const lines = out.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "")
    .flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
  const ends = lines.filter((o) => o["type"] === "session_end");
  const open = lines.find((o) => o["id"] === 1);
  const close = lines.find((o) => o["id"] === 2);
  check(ends.length === 0, `A4 无显示器 headful 启动失败不得终结会话（拿到 session_end: ${JSON.stringify(ends)}）`);
  check(open !== undefined && open["code"] === "config_error",
    `A4 启动期失败应归 config_error（拿到 ${JSON.stringify(open?.["code"])}）`);
  const reason = String(open?.["reason"] ?? "");
  check(/headless/i.test(reason) && /xvfb/i.test(reason),
    `A4 reason 应含 headless / xvfb 可行动建议（拿到 ${JSON.stringify(reason.slice(0, 300))}）`);
  check(close !== undefined && close["ok"] === true, "A4 会话应保持存活：后续 close 正常收尾");
  check(out.code === 0, `A4 会话进程应干净退出（exit=${out.code}）`);
}

/**
 * 运行期杀浏览器（Playwright 子进程）→ 仍是 browser_dead（现状保持）。
 *
 * 输入走 FIFO：先用 `--url` 让会话自动 open（拿到"浏览器已起"的证据），再杀掉它的 chromium
 * 孙进程，最后从 FIFO 递一条 observe——只有运行期死亡才该终结会话。
 */
async function assertRuntimeDeath(dir: string, origin: string): Promise<void> {
  const fifo = path.join(dir, "runtime.fifo");
  try { fs.unlinkSync(fifo); } catch { /* 不存在 */ }
  try { execFileSync("mkfifo", [fifo], { stdio: "ignore" }); } catch {
    problems.push("A4 运行期死亡：mkfifo 不可用，无法构造运行期死亡场景（未验证）");
    return;
  }
  const home = path.join(dir, "home-runtime");
  fs.mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, [
    "--experimental-strip-types", "src/cli/main.ts", "session",
    "--url", `${origin}/single`, "--input", fifo, "--out", path.join(dir, "runtime-out"),
    "--idle-timeout-ms", String(SESSION_TIMEOUT_MS),
  ], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AMBERFLOW_HOME: home, ...SESSION_ENV } });
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (c: string) => { stdout += c; });
  const lines = (): Array<Record<string, unknown>> => stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "")
    .flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
  const waitFor = async (predicate: () => boolean, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return predicate();
  };
  // FIFO 的写端：会话起来后才打开（读端由 CLI 打开；写端阻塞到读端就绪，正好当同步点）。
  const fifoWriter = fs.createWriteStream(fifo);
  try {
    if (!await waitFor(() => lines().some((o) => o["type"] === "open" && o["ok"] === true), 120_000)) {
      problems.push("A4 运行期死亡：会话没有完成自动 open（无法构造运行期死亡场景）");
      return;
    }
    // 杀掉该会话的 chromium 子进程（node 会话的子进程，带 --remote-debugging-pipe）。
    const chromiumPids = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name)).filter((pid) => {
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        return /--remote-debugging-pipe/.test(cmd) && /chrome|chromium|headless_shell/i.test(cmd);
      } catch { return false; }
    });
    if (chromiumPids.length === 0) {
      problems.push("A4 运行期死亡：没找到 chromium 子进程，场景未构造（未验证）");
      return;
    }
    for (const pid of chromiumPids) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* 已退出 */ } }
    // 必须发一条**会碰页面**的请求：read/observe/snapshot 的失败面各自兜底成成功，
    // 只有 act 的解析链会把 Playwright 的 "has been closed" 冒到 handleLine 的 catch。
    fifoWriter.write(`${JSON.stringify({ id: 2, type: "act", op: "click", target: "#deep" })}\n`);
    await waitFor(() => lines().some((o) => o["type"] === "session_end"), 60_000);
    const end = lines().find((o) => o["type"] === "session_end");
    check(end !== undefined && end["code"] === "browser_dead",
      `A4 运行期页面死亡仍应归 browser_dead（拿到 ${JSON.stringify(end?.["code"] ?? null)}；chromium 命中 ${chromiumPids.length} 个）`);
  } finally {
    try { fifoWriter.end(); } catch { /* 已关 */ }
    try { child.kill(); } catch { /* 已退 */ }
  }
}

/* ------------------------------------------------------------------ 入口 */

async function main(): Promise<number> {
  assertHintShape();
  assertLandedShape();
  const server = await startFixtureServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-verify-walk-r1-"));
  let run: SessionRun | null = null;
  try {
    const { steps, index } = script(server.origin);
    run = await runSession(steps, dir, SESSION_ENV);
    assertSession(run, index);
    await assertHeadfulWithoutDisplay(dir);
    await assertRuntimeDeath(dir, server.origin);
    await assertDeadPageHonest();
  } catch (e) {
    problems.push(`lane 抛错：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await server.close();
  }
  if (problems.length > 0) {
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, problems }, null, 2));
    else for (const p of problems) console.error(`verify-walk-r1: FAIL — ${p}`);
    if (run !== null && run.stderrTail.trim() !== "") {
      console.error(`verify-walk-r1: session stderr tail:\n${run.stderrTail.trim()}`);
    }
    return 1;
  }
  assert.equal(true, true);
  if (JSON_OUT) console.log(JSON.stringify({ ok: true, problems: [] }));
  else console.log("verify-walk-r1: OK — A1 不变量/四场景、A2 双柄补事实+单柄原文字节不变、A3 四操作符+~=反例、"
    + "A4 无显示器 config_error 且会话存活+运行期 browser_dead、A5 九例形状+三键、A6 programmatic 回退+page 合成、B15 at_bottom、A7 死页不吞成空结果、A8 文档不可滚回退内部容器 全部对上");
  return 0;
}

process.exitCode = await main();
