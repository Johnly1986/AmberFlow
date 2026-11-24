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
import { exportSessionRecord } from "../src/app/session-export.ts";

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
<!-- 一对耦合手柄：同容器内两个 range = 多柄事实（percent 无唯一目标）。 -->
<div id="dual"><input id="dual-lo" type="range" min="0" max="100" step="10" value="20">
<input id="dual-hi" type="range" min="0" max="100" step="10" value="80"></div>
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
    // 格点吸附（step=10）：11 物理上不存在 → 吸附到 10，applied:true / accurate:false /
    // snapped_to:10，页面值读回 "10"（不报 slider_not_settable、不白等满超时）。
    { id: 13, request: { type: "act", op: "set_range", target: "input[type=range]", value: { value: 11 } } },
    { id: 14, request: { type: "read", what: "value", selector: "input[type=range]" } },
    // 同一 hint 连续设值（滑块身份 = 稳定句柄，不是活值）：70 → 11 → 30 都命中同一元素。
    { id: 15, request: { type: "act", op: "set_range", target: "input[type=range]", value: { value: 30 } } },
    { id: 16, request: { type: "read", what: "value", selector: "input[type=range]" } },
    // 多柄用例（页面上另有两个耦合 range）：percent 无唯一目标 → 结构化拒绝、零动作。
    { id: 17, request: { type: "act", op: "set_range", target: "#dual-lo", value: { percent: 50 } } },
    { id: 18, request: { type: "read", what: "value", selector: "#dual-lo" } },
    // 形状判别（P0-1 端到端）：「角色词 + 文本」是合法裸词但零命中 → target_not_found +
    // shape_problem（role-word-plus-text），且 reason 尾部带闭集提示（与命令步同一份文案）。
    { id: 19, request: { type: "act", op: "click", target: "button 音量" } },
    // 真 label 反例：整段裸词「音量」应正常命中（形状判别不得把真 label 误杀）。
    { id: 20, request: { type: "act", op: "click", target: "音量" } },
    { id: 21, request: { type: "close" } },
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
async function runSession(steps: Step[], dir: string, record: string | null = null): Promise<SessionRun> {
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
    ...(record === null ? [] : ["--record", record]),
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

  // #13/#14 格点吸附：11 不在 step=10 的格点上 → 吸附到 10 并**成功**（不报不可设置）。
  const snapped = expectResponse(run, steps, 13, problems);
  if (snapped !== undefined) {
    check(problems, snapped["ok"] === true,
      `#13 set_range {value:11}（step=10）应吸附后成功（code=${JSON.stringify(snapped["code"])}）`);
    check(problems, snapped["applied"] === true, "#13 吸附后应 applied:true");
    check(problems, snapped["accurate"] === false, "#13 吸附后 accurate 必须为 false（精确值不在值域里）");
    check(problems, numberField(snapped, "snapped_to") === 10,
      `#13 snapped_to 应为 10（拿到 ${JSON.stringify(snapped["snapped_to"])}）`);
    check(problems, numberField(snapped, "requested") === 11,
      `#13 requested 应如实保留原请求 11（拿到 ${JSON.stringify(snapped["requested"])}）`);
    check(problems, snapped["strategy"] === "fill", `#13 吸附仍走 fill（拿到 ${JSON.stringify(snapped["strategy"])}）`);
  }
  const readSnapped = expectResponse(run, steps, 14, problems);
  if (readSnapped !== undefined) {
    check(problems, String(readSnapped["value"]) === "10", `#14 页面值应为 "10"（拿到 ${JSON.stringify(readSnapped["value"])}）`);
  }

  // #15/#16 同一 hint 连续设值：滑块身份是稳定句柄（#id），不是活值。
  const set30 = expectResponse(run, steps, 15, problems);
  if (set30 !== undefined) {
    check(problems, set30["ok"] === true,
      `#15 同一 hint 第三次设值应仍命中（code=${JSON.stringify(set30["code"])}）`);
    check(problems, numberField(set30, "achieved") === 30,
      `#15 achieved 应为 30（拿到 ${JSON.stringify(set30["achieved"])}）`);
    check(problems, set30["accurate"] === true, "#15 30 在格点上，应 accurate:true");
  }
  const read30 = expectResponse(run, steps, 16, problems);
  if (read30 !== undefined) {
    check(problems, String(read30["value"]) === "30", `#16 页面值应为 "30"（拿到 ${JSON.stringify(read30["value"])}）`);
  }

  // #17/#18 多柄：percent 在耦合范围上无唯一目标 → 结构化拒绝、零动作、页面值不变。
  const dual = expectResponse(run, steps, 17, problems);
  if (dual !== undefined) {
    check(problems, dual["ok"] === false, "#17 多柄 percent 必须 ok:false（不猜目标）");
    check(problems, dual["code"] === "config_error",
      `#17 多柄 percent 应 code:"config_error"（拿到 ${JSON.stringify(dual["code"])}）`);
    check(problems, dual["executed"] === false, "#17 多柄 percent 应 executed:false（零动作）");
    check(problems, numberField(dual, "handles") === 2,
      `#17 应如实带出手柄数 2（拿到 ${JSON.stringify(dual["handles"])}）`);
  }
  const readDual = expectResponse(run, steps, 18, problems);
  if (readDual !== undefined) {
    check(problems, String(readDual["value"]) === "20", `#18 多柄拒绝后页面值应仍是 "20"（拿到 ${JSON.stringify(readDual["value"])}）`);
  }

  // #19 形状判别：`button 音量` 是合法裸词但零命中 → 形状可疑 + 闭集提示；停因仍是既有码。
  const miss = expectResponse(run, steps, 19, problems);
  if (miss !== undefined) {
    check(problems, miss["ok"] === false, "#19 形状可疑的落空应 ok:false");
    check(problems, miss["code"] === "target_not_found",
      `#19 停因应仍是 target_not_found（拿到 ${JSON.stringify(miss["code"])}）`);
    const shape = miss["shape_problem"] as Record<string, unknown> | undefined;
    check(problems, shape !== undefined, "#19 应带回 shape_problem（否则 agent 无法区分写错与页面没有）");
    check(problems, shape?.["kind"] === "role-word-plus-text",
      `#19 形状种类应为 role-word-plus-text（拿到 ${JSON.stringify(shape?.["kind"])}）`);
    check(problems, String(miss["reason"] ?? "").includes("形状闭集"),
      "#19 落空 reason 应带闭集提示（与命令步同一份文案）");
  }
  // #20 反例：真 label（整段裸词）照样命中——形状判别只在落空后判，不误杀。
  const realLabel = expectResponse(run, steps, 20, problems);
  if (realLabel !== undefined) {
    check(problems, realLabel["ok"] === true,
      `#20 真 label「音量」应正常命中（code=${JSON.stringify(realLabel["code"])}）`);
    check(problems, !("shape_problem" in realLabel), "#20 成功路径不得带 shape_problem（键集不变）");
  }

  // #21 close：干净收尾。
  const close = expectResponse(run, steps, 21, problems);
  if (close !== undefined) check(problems, close["ok"] === true, "#21 close 应 ok:true");

  return problems;
}

/**
 * 轨迹完整性（P0-3）：`--record` 里 `set_range` 必须**逐次成行**（含失败），且
 * `session export` 能把它还原成 `ctx.setRange` 骨架并过 `apps check`。
 */
function assertRecord(record: string, dir: string): string[] {
  const problems: string[] = [];
  const actions: Array<Record<string, unknown>> = [];
  try {
    for (const line of fs.readFileSync(record, "utf-8").split(/\r?\n/)) {
      const text = line.trim();
      if (text === "") continue;
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed["op"] === "string") actions.push(parsed);
    }
  } catch (e) {
    return [`轨迹文件不可读/坏行：${e instanceof Error ? e.message : String(e)}`];
  }
  const rangeRows = actions.filter((a) => a["op"] === "set_range");
  // 剧本里 6 次真正进入 mw.setRange 的请求（#2/#6/#8/#13/#15/#17）；#10/#11 是形状错，零动作不记账。
  check(problems, rangeRows.length === 6, `轨迹里 set_range 行数应为 6（拿到 ${rangeRows.length}：${JSON.stringify(actions.map((a) => a["op"]))}）`);
  check(problems, rangeRows.some((a) => a["ok"] === false && a["code"] === "value_out_of_range"),
    "轨迹里应记下越界失败行（ok:false + code:value_out_of_range）——失败也是事实");
  check(problems, rangeRows.some((a) => typeof a["snapped_to"] === "number" && a["snapped_to"] === 10),
    "轨迹里应记下吸附事实（snapped_to:10）");
  check(problems, rangeRows.every((a) => typeof a["target"] === "string" && a["target"] !== ""),
    "轨迹里每条 set_range 行都应带 target（hint）");
  // export：骨架必须包含 ctx.setRange 且能过 apps check。
  try {
    const out = path.join(dir, "exported", "app.mjs");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const exported = exportSessionRecord({ record, out, id: "verify-range-export", force: true });
    check(problems, exported.ok === true, `session export 应成功（problems=${exported.problems.join("；")}）`);
    const src = fs.readFileSync(out, "utf-8");
    check(problems, src.includes("ctx.setRange("), "导出的骨架应包含 ctx.setRange 调用（否则重放必挂滑杆）");
    check(problems, !src.includes("TODO_VALUE") || !src.includes("set_range"), "set_range 不应落进 TODO_VALUE 注释块");
  } catch (e) {
    problems.push(`session export 抛错：${e instanceof Error ? e.message : String(e)}`);
  }
  return problems;
}

/* ------------------------------------------------------------------ 入口 */

async function main(): Promise<number> {
  const server = await startFixtureServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-verify-session-range-"));
  try {
    const steps = script(server.origin);
    const record = path.join(dir, "actions.jsonl");
    const run = await runSession(steps, dir, record);
    const problems = [...assertScript(run, steps), ...assertRecord(record, dir)];
    if (problems.length > 0) {
      for (const p of problems) console.error(`verify-session-range: FAIL — ${p}`);
      if (run.stderrTail.trim() !== "") console.error(`verify-session-range: session stderr tail:\n${run.stderrTail.trim()}`);
      return 1;
    }
    assert.equal(run.exitCode, 0);
    console.log("verify-session-range: OK — set_range 合法/percent/越界/形状错/格点吸附/多柄/轨迹录制+导出/形状判别 八条路径全部对上");
    return 0;
  } catch (e) {
    console.error(`verify-session-range: FAIL — ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await server.close();
  }
}

process.exitCode = await main();
