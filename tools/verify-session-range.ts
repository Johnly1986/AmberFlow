/**
 * verify-session-range —— **非门禁**的本地 lane：session act `set_range` 的端到端验收。
 *
 * 起本地静态夹具（`<input type=range min=0 max=100 step=10>`）后跑**真实 `amber session`
 * 子进程**（`--input` JSONL），断言这一条新 op 的协议事实：
 *   - 合法请求 `{value:70}` → ok / executed / applied / accurate 全真，strategy=fill，
 *     target_value=requested=70；页面值读回 "70"（**读的是页面事实，不是回包自证**）；
 *   - 越界请求 `{value:170}` → 结构化 `value_out_of_range`（零动作：无 strategy、applied/
 *     accurate 恒 false），页面值仍是 "70"——**不钳制、不伪造成功、会话不崩**；
 *   - `{percent:50}` → 50（percent 折算路径）；缺 value / 非法 value → config_error 且会话存活；
 *   - observe 回包仍能以同一条 hint（`input[type=range]`）自证滑杆元素（action 后目标可再定位）。
 *
 * 与 verify-session-drive 同定位：需要 chromium，不进 `npm run check`。完成裁决仍在
 * `amber run` / `online/` 套件；本工具只做这一条会话 op 的进程级事实断言。
 *
 * 用法：node --experimental-strip-types tools/verify-session-range.ts
 * 退出码：0 全过 / 1 任一断言红或环境错误（chromium 缺失等）。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const SESSION_TIMEOUT_MS = 180_000;
const UNREACHABLE_PROVIDER = "http://127.0.0.1:1";

/* ------------------------------------------------------------------ 本地夹具 */

/**
 * 确定性 range 夹具：native range（fill 族）+ input/change 同步的可见读数。
 * `#state` 让「动作真的触发了页面事件」可读回（而不只是 input.value 被写）。
 */
const RANGE_PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>verify session set_range</title></head>
<body>
<label for="vol">音量</label>
<input id="vol" type="range" min="0" max="100" step="10" value="10">
<div id="state" aria-live="polite"></div>
<script>
  const el = document.getElementById('vol');
  const state = document.getElementById('state');
  const sync = () => { state.textContent = el.value; };
  el.addEventListener('input', sync);
  el.addEventListener('change', sync);
  sync();
</script>
</body></html>`;

async function startFixtureServer(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== "/range.html") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(RANGE_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/* ------------------------------------------------------------------ 请求剧本 */

interface Step { id: number; request: Record<string, unknown> }

/**
 * 一次会话内的完整剧本（id 顺序即断言顺序）。值只来自本工具显式给出——与 authoring 面
 * 「值只来自人给的决定」同纪律，不从页面猜。
 */
function script(origin: string): Step[] {
  return [
    { id: 1, request: { type: "open", url: `${origin}/range.html` } },
    { id: 2, request: { type: "act", op: "set_range", target: "input[type=range]", value: { value: 70 } } },
    { id: 3, request: { type: "observe" } },
    { id: 4, request: { type: "read", what: "value", selector: "input[type=range]" } },
    // 页面事件读数：只有真的派发了 input/change，`#state` 才会跟上（写 DOM 属性不会触发）。
    { id: 5, request: { type: "read", what: "text", selector: "#state" } },
    // 越界用例：70 已在控件上；170 超出 [0,100] → 零动作结构化拒绝，值必须仍是 70。
    { id: 6, request: { type: "act", op: "set_range", target: "input[type=range]", value: { value: 170 } } },
    { id: 7, request: { type: "read", what: "value", selector: "input[type=range]" } },
    { id: 8, request: { type: "act", op: "set_range", target: "input[type=range]", value: { percent: 50 } } },
    { id: 9, request: { type: "read", what: "value", selector: "input[type=range]" } },
    // 形状错误面：缺 value / 非法 value 都是 config_error（零动作）且不结束会话。
    { id: 10, request: { type: "act", op: "set_range", target: "input[type=range]" } },
    { id: 11, request: { type: "act", op: "set_range", target: "input[type=range]", value: { value: "70" } } },
    { id: 12, request: { type: "read", what: "value", selector: "input[type=range]" } },
    { id: 13, request: { type: "close" } },
  ];
}

/* ------------------------------------------------------------------ 子进程驱动 */

interface SessionRun {
  exitCode: number;
  responses: Map<number, Record<string, unknown>>;
  sessionEnd: Record<string, unknown> | undefined;
  stdoutLines: number;
  stderrTail: string;
}

/** 写 `--input` 文件并跑真实 `amber session`；按 id 收集协议响应。 */
async function runSession(steps: Step[], dir: string): Promise<SessionRun> {
  const inputFile = path.join(dir, "requests.jsonl");
  fs.writeFileSync(inputFile, `${steps.map((s) => JSON.stringify({ id: s.id, ...s.request })).join("\n")}\n`);
  const outDir = path.join(dir, "session-evidence");
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, [
    "--experimental-strip-types", "src/cli/main.ts", "session",
    "--input", inputFile,
    "--out", outDir,
    "--idle-timeout-ms", String(SESSION_TIMEOUT_MS),
  ], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AMBERFLOW_HOME: home,
      // 决策源统一不可达：本 lane 零模型（set_range/observe/read 全走确定性路径），
      // 避免装配本机 laya 工件。
      AMBERFLOW_DECISION_BASE_URL: UNREACHABLE_PROVIDER,
      AMBERFLOW_DECISION_API_KEY: "unused-lane-key",
      AMBERFLOW_DECISION_MODEL: "unused-lane-model",
    },
  });
  const responses = new Map<number, Record<string, unknown>>();
  const rawLines: string[] = [];
  let stderrTail = "";
  let sessionEnd: Record<string, unknown> | undefined;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      const text = line.trim();
      if (text === "") continue;
      rawLines.push(text);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue; // 非协议行不该出现在 stdout；不打断收集，最后按 id 缺失判红
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      const obj = parsed as Record<string, unknown>;
      if (obj["type"] === "session_end") { sessionEnd = obj; continue; }
      const id = typeof obj["id"] === "number" ? obj["id"] : null;
      if (id !== null) responses.set(id, obj);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderrTail = (stderrTail + chunk).slice(-4_000); });
  const exitCode = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already dead */ } resolve(-99); }, SESSION_TIMEOUT_MS);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code ?? -1); });
  });
  return { exitCode, responses, sessionEnd, stdoutLines: rawLines.length, stderrTail };
}

/* ------------------------------------------------------------------ 断言 */

/**
 * 断言一条响应存在且形状如预期。所有失败进 problems 汇总（一次跑完给全貌，不首红即停）。
 */
function expectResponse(
  run: SessionRun, steps: Step[], id: number, problems: string[],
): Record<string, unknown> | undefined {
  const resp = run.responses.get(id);
  if (resp === undefined) {
    problems.push(`request #${id}（${String(steps.find((s) => s.id === id)?.request["type"])}）没有协议响应`);
    return undefined;
  }
  return resp;
}

function check(problems: string[], condition: boolean, message: string): void {
  if (!condition) problems.push(message);
}

const numberField = (resp: Record<string, unknown>, key: string): number | undefined =>
  typeof resp[key] === "number" && Number.isFinite(resp[key]) ? resp[key] as number : undefined;

/** 逐条核对剧本的协议事实（失败汇总成 problems）。 */
function assertScript(run: SessionRun, steps: Step[]): string[] {
  const problems: string[] = [];
  if (run.exitCode !== 0) {
    problems.push(`amber session 子进程 exit=${run.exitCode}（应 0；关闭会话是干净收尾）`);
  }
  if (run.sessionEnd !== undefined) {
    problems.push(`出现非预期 session_end（${JSON.stringify(run.sessionEnd)}）——会话中途异常结束`);
  }
  const expectedIds = steps.length;
  if (run.responses.size !== expectedIds) {
    problems.push(`协议响应数 ${run.responses.size} ≠ 请求数 ${expectedIds}（缺/多行）`);
  }

  // #1 open：入口页落地。
  const open = expectResponse(run, steps, 1, problems);
  if (open !== undefined) {
    check(problems, open["ok"] === true, `#1 open 应 ok:true（拿到 ${JSON.stringify(open["code"])}）`);
    check(problems, String(open["url"] ?? "").includes("/range.html"), `#1 open 落地 URL 应含 /range.html（拿到 ${String(open["url"])}）`);
  }

  // #2 合法 set_range 70：applied/accurate/strategy/数值事实全真。
  const set70 = expectResponse(run, steps, 2, problems);
  if (set70 !== undefined) {
    check(problems, set70["ok"] === true, `#2 set_range {value:70} 应 ok:true（code=${JSON.stringify(set70["code"])} reason=${JSON.stringify(set70["reason"])}）`);
    check(problems, set70["executed"] === true, "#2 set_range 应 executed:true");
    check(problems, set70["applied"] === true, "#2 set_range 应 applied:true（控件值事实已是目标）");
    check(problems, set70["accurate"] === true, "#2 set_range 应 accurate:true（achieved === requested）");
    check(problems, set70["strategy"] === "fill", `#2 native range 应走 fill 策略（拿到 ${JSON.stringify(set70["strategy"])}）`);
    check(problems, numberField(set70, "target_value") === 70, `#2 target_value 应为 70（拿到 ${JSON.stringify(set70["target_value"])}）`);
    check(problems, numberField(set70, "requested") === 70, `#2 requested 应为 70（拿到 ${JSON.stringify(set70["requested"])}）`);
  }

  // #3 observe：动作后滑杆仍被观察面准入（admitted + 自证 hint），#id 仍在候选里——
  // 「act 之后目标还能被重新寻址」；值的页面事实由 #4/#7/#9 的 read 承担（observe 的
  // label 取自 HTML `value` **属性**，不是活值，不能当值证据用）。
  const observe = expectResponse(run, steps, 3, problems);
  if (observe !== undefined) {
    check(problems, observe["ok"] === true, "#3 observe 应 ok:true");
    const rows = Array.isArray(observe["elements"]) ? observe["elements"] as Array<Record<string, unknown>> : [];
    const slider = rows.find((row) => row["tag"] === "input" && row["type"] === "range");
    check(problems, slider !== undefined,
      `#3 observe 应包含滑杆行（input/type=range；共 ${rows.length} 行）`);
    if (slider !== undefined) {
      check(problems, slider["admitted"] === true, "#3 滑杆应仍在观察面准入池（admitted:true）");
      const hints = Array.isArray(slider["hint_candidates"]) ? slider["hint_candidates"] as unknown[] : [];
      check(problems, hints.includes("#vol"),
        `#3 滑杆行应带稳定自证 hint "#vol"（拿到 ${JSON.stringify(hints)}）`);
      check(problems, slider["id"] === "vol", "#3 滑杆行 id 应为 vol（观察面与页面同构）");
    }
  }

  // #4/#5 页面值 + 事件读数：读页面事实，不拿回包自证。
  const read70 = expectResponse(run, steps, 4, problems);
  if (read70 !== undefined) {
    check(problems, read70["ok"] === true, "#4 read value 应 ok:true");
    check(problems, String(read70["value"]) === "70", `#4 页面值应读回 "70"（拿到 ${JSON.stringify(read70["value"])}）`);
  }
  const state70 = expectResponse(run, steps, 5, problems);
  if (state70 !== undefined) {
    check(problems, state70["ok"] === true, "#5 read #state 应 ok:true");
    check(problems, String(state70["value"]).trim() === "70",
      `#5 #state 文本应为 "70"（说明 input/change 事件真的派发了；拿到 ${JSON.stringify(state70["value"])}）`);
  }

  // #6 越界：结构化 value_out_of_range、零动作、不伪造成功。
  const outOfRange = expectResponse(run, steps, 6, problems);
  if (outOfRange !== undefined) {
    check(problems, outOfRange["ok"] === false, "#6 越界请求必须 ok:false（绝不假装成功）");
    check(problems, outOfRange["code"] === "value_out_of_range",
      `#6 越界请求应 code:"value_out_of_range"（拿到 ${JSON.stringify(outOfRange["code"])}）`);
    check(problems, outOfRange["executed"] === false, "#6 越界请求应 executed:false（零动作）");
    check(problems, outOfRange["applied"] !== true, "#6 越界请求不得 applied:true");
    check(problems, outOfRange["accurate"] !== true, "#6 越界请求不得 accurate:true");
    check(problems, outOfRange["strategy"] === undefined, "#6 越界请求不得带 strategy（零交互证据）");
    check(problems, numberField(outOfRange, "requested") === 170,
      `#6 requested 应如实带出 170（拿到 ${JSON.stringify(outOfRange["requested"])}）`);
    check(problems, numberField(outOfRange, "clamped_from") === 100,
      `#6 clamped_from 应记录被拒的钳制值 100（拿到 ${JSON.stringify(outOfRange["clamped_from"])}）`);
  }
  const readAfterOutOfRange = expectResponse(run, steps, 7, problems);
  if (readAfterOutOfRange !== undefined) {
    check(problems, String(readAfterOutOfRange["value"]) === "70",
      `#7 越界请求后页面值必须仍是 "70"（不钳制、不写入；拿到 ${JSON.stringify(readAfterOutOfRange["value"])}）`);
  }

  // #8 percent 折算：区间 50% → 50（step=10 格点上）。
  const setPercent = expectResponse(run, steps, 8, problems);
  if (setPercent !== undefined) {
    check(problems, setPercent["ok"] === true, `#8 set_range {percent:50} 应 ok:true（code=${JSON.stringify(setPercent["code"])}）`);
    check(problems, setPercent["accurate"] === true, "#8 percent 请求应 accurate:true");
    check(problems, numberField(setPercent, "target_value") === 50,
      `#8 percent:50 折算值应为 50（拿到 ${JSON.stringify(setPercent["target_value"])}）`);
  }
  const read50 = expectResponse(run, steps, 9, problems);
  if (read50 !== undefined) {
    check(problems, String(read50["value"]) === "50", `#9 页面值应读回 "50"（拿到 ${JSON.stringify(read50["value"])}）`);
  }

  // #10/#11 形状错误面：config_error（零动作）+ 会话存活。
  for (const id of [10, 11] as const) {
    const bad = expectResponse(run, steps, id, problems);
    if (bad === undefined) continue;
    check(problems, bad["ok"] === false, `#${id} 非法请求应 ok:false`);
    check(problems, bad["code"] === "config_error", `#${id} 非法请求应 code:"config_error"（拿到 ${JSON.stringify(bad["code"])}）`);
    check(problems, bad["executed"] === false, `#${id} 非法请求应 executed:false（形状校验先于动作）`);
  }
  const finalRead = expectResponse(run, steps, 12, problems);
  if (finalRead !== undefined) {
    check(problems, finalRead["ok"] === true, "#12 会话应存活（非法请求后 read 仍可用）");
    check(problems, String(finalRead["value"]) === "50", `#12 页面值应仍是 "50"（拿到 ${JSON.stringify(finalRead["value"])}）`);
  }

  // #13 close：干净收尾。
  const close = expectResponse(run, steps, 13, problems);
  if (close !== undefined) check(problems, close["ok"] === true, "#13 close 应 ok:true");

  return problems;
}

/* ------------------------------------------------------------------ 入口 */

async function main(): Promise<number> {
  const server = await startFixtureServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-verify-session-range-"));
  try {
    const steps = script(server.origin);
    const run = await runSession(steps, dir);
    const problems = assertScript(run, steps);
    if (problems.length > 0) {
      for (const p of problems) console.error(`verify-session-range: FAIL — ${p}`);
      if (run.stderrTail.trim() !== "") console.error(`verify-session-range: session stderr tail:\n${run.stderrTail.trim()}`);
      return 1;
    }
    assert.equal(run.exitCode, 0);
    console.log("verify-session-range: OK — act set_range 合法/percent/越界/形状错误四条路径的协议事实与页面值全部对上");
    return 0;
  } catch (e) {
    console.error(`verify-session-range: FAIL — ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await server.close();
  }
}

process.exitCode = await main();
