/**
 * verify-session-drive —— **非门禁**的本地 lane：session 子进程内托管 pilot 驾驶（零模型）。
 *
 * 驾驶者用 `driver:"agent"`（每步等兜底指令点名、零模型票），在本地静态夹具上把协议走通：
 * open → observe → drive（等交接）→ driveCommand resume{hint} → act（人工补一步）→
 * driveCommand resume → driveStatus → driveClose → close。断言：
 *   - drive 附着在宿主会话上：page 对象身份不变、起步不重新导航（goto 计数不增）、
 *     JS 标记在未导航的驾驶后仍存活；
 *   - 停驶等兜底时 session 的 act/read/observe 照常可用（两条面共用同一 page 的互证）；
 *   - pilot 证据目录独立于会话证据目录（不写会话 --record 流）；
 *   - 响应带 `session_id` join key，events 有界（≤40 条/单条 ≤2KB）且不含池/候选/槽值；
 *   - driveClose 只收尾驾驶、不关宿主浏览器：此后 session 仍可 observe/act，直到会话 close；
 *   - 已终态再 drive 返回结构化 `drive_terminal`；坏参数都是结构化 config_error；
 *   - 交接（off_task_page handoff）打开时 session 仍可用，finish 信号不成立只是单行被拒；
 *   - 校验先于浏览器惰性创建：未 open 的会话收到坏 drive 不启动浏览器。
 *
 * 不依赖决策服务与外部网络：决策源指向不可达本地端点（agent 驾驶不发模型票）。
 * 用法：node --experimental-strip-types tools/verify-session-drive.ts
 * 退出码：0 全过 / 1 任一断言红 / 2 环境错误（chromium 缺失等）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { SessionRuntime } from "../src/app/session-runtime.ts";
import type { SessionSink } from "../src/app/session-runtime-contract.ts";
import type { SessionPilotDriver } from "../src/app/session-driver.ts";
import type { PilotRuntime } from "../src/app/pilot-runtime.ts";
import type { AnyPage, BrowserSession } from "../src/engine/executor.ts";

const UNREACHABLE_PROVIDER = "http://127.0.0.1:1";
const RUN_ID = "verify-session-drive";

/* ------------------------------------------------------------------ 静态夹具 */

const PAGES: Record<string, string> = {
  "/home.html": `<!doctype html><html><head><meta charset="utf-8"><title>session drive home</title></head><body>
<h1>Home</h1>
<form id="f"><label for="name">Name</label><input id="name" name="name"></form>
<button id="go" onclick="location.href='/detail.html'">Continue</button>
</body></html>`,
  "/detail.html": `<!doctype html><html><head><meta charset="utf-8"><title>session drive detail</title></head><body>
<div id="detail">detail</div>
<label for="note">Note</label><input id="note" name="note">
<button id="finish" onclick="location.href='/done.html'">Finish</button>
</body></html>`,
  "/done.html": `<!doctype html><html><head><meta charset="utf-8"><title>session drive done</title></head><body>
<div id="done">done</div>
<button id="again" onclick="document.body.dataset.clicked='1'">Again</button>
</body></html>`,
};

async function startFixtureServer(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const html = PAGES[pathname];
    if (html === undefined) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e === undefined ? resolve() : reject(e)))),
  };
}

/**
 * 决策源统一不可达：在线 provider 档零模型加载（agent 驾驶本就不发投票；这里只保证
 * pilot 起步的决策源装配不落到本机 laya 工件）。`resolveProviderSpec` 读进程 env，
 * 所以直接写 process.env；`AMBERFLOW_HOME` 指到临时目录，证据不落用户主目录。
 */
function laneEnv(): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "af-verify-session-drive-home-"));
  Object.assign(process.env, {
    AMBERFLOW_HOME: home,
    AMBERFLOW_DECISION_BASE_URL: UNREACHABLE_PROVIDER,
    AMBERFLOW_DECISION_API_KEY: "unused-lane-key",
    AMBERFLOW_DECISION_MODEL: "unused-lane-model",
  });
  return process.env;
}

/* ------------------------------------------------------------------ 测试侧注入面 */

/** 测试侧只读窥视：只断言身份/状态，不改会话面行为（与 close 收口 lane 同一做法）。 */
interface SessionInternals {
  holder: { session: BrowserSession | null };
  driver: SessionPilotDriver | null;
}

type Request = (type: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** 按 CLI 协议逐行发请求：id 匹配响应，且除 close 外的请求都不得结束会话。 */
function makeClient(rt: SessionRuntime, responses: Array<Record<string, unknown>>): Request {
  let seq = 0;
  return async (type, args = {}) => {
    const id = ++seq;
    const before = responses.length;
    const ended = await rt.handleLine(JSON.stringify({ id, type, ...args }));
    assert.equal(ended, false, `${type} must not end the session`);
    const resp = responses.slice(before).find((r) => r["id"] === id);
    assert.ok(resp !== undefined, `${type} must answer request ${id}`);
    return resp!;
  };
}

/** events 的有界与不泄露断言：≤40 条、单条 ≤2KB、不带池/候选/槽值，且每条标 pilot。 */
function assertBoundedEvents(raw: unknown, label: string): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(raw), `${label}: events must be an array`);
  const events = raw as Array<Record<string, unknown>>;
  assert.ok(events.length <= 40, `${label}: events bounded to 40 (got ${events.length})`);
  for (const event of events) {
    assert.equal(event["pilot"], true, `${label}: every event is marked pilot`);
    const json = JSON.stringify(event);
    const bytes = Buffer.byteLength(json, "utf8");
    assert.ok(bytes <= 2048, `${label}: event ${String(event["type"])} must be ≤2KB (got ${bytes})`);
    assert.ok(!/"candidates"\s*:/.test(json), `${label}: candidate rows must not leave the pilot face`);
    assert.ok(!/"slots"\s*:/.test(json), `${label}: slot values must not leave the pilot face`);
    assert.ok(!/"pool"\s*:/.test(json), `${label}: the element pool must not leave the pilot face`);
  }
  return events;
}

const evaluator = <T>(page: AnyPage, fn: () => T): Promise<unknown> =>
  page.evaluate(fn as unknown) as Promise<unknown>;

/* ------------------------------------------------------------------ 场景 1：附着驾驶全链 */

/** 附着驾驶全链：drive 不新开浏览器/不重导航、session 与 pilot 共用 page、driveClose 不关宿主。 */
async function scenarioAttachDrive(env: NodeJS.ProcessEnv, origin: string): Promise<void> {
  const sessionOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-verify-session-drive-session-"));
  const responses: Array<Record<string, unknown>> = [];
  const sink: SessionSink = { respond: (o) => { responses.push(o); }, log: () => {} };
  const homeUrl = `${origin}/home.html`;
  const detailUrl = `${origin}/detail.html`;
  const doneUrl = `${origin}/done.html`;
  const rt = new SessionRuntime({
    url: homeUrl,
    hosts: [new URL(homeUrl).hostname],
    outDir: sessionOutDir,
    quiet: true,
    idleTimeoutMs: 0,
    env,
  }, sink, RUN_ID);
  let sessionClosed = false;
  try {
    await rt.start();   // --url 自动 open（响应 id:null，不是某一行请求的回显）
    const request = makeClient(rt, responses);
    const internals = rt as unknown as SessionInternals;
    const hostPage = (): AnyPage => {
      const session = internals.holder.session;
      assert.ok(session !== null, "host browser session exists");
      return session!.page;
    };
    const page0 = hostPage();

    // 起步导航的 goto 计数：附着驾驶不得再付一次入口导航（点击导航不经过 page.goto）。
    const realGoto = page0.goto.bind(page0);
    let gotoCalls = 0;
    page0.goto = async (...args: Parameters<typeof realGoto>) => {
      gotoCalls += 1;
      return await realGoto(...args);
    };
    // home 页 JS 标记：drive 只驾驶不重导航时它必须存活（新浏览器/重导航都会丢）。
    await evaluator(page0, () => {
      (globalThis as unknown as Record<string, unknown>)["__afDriveMarker"] = "home";
    });

    assert.equal(hostPage(), page0, "open keeps the host page object");

    // ---- 参数校验：坏请求都是结构化 config_error，且带 session_id join key ----
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, "empty goal"],
      [{ goal: "x", max_steps: 0 }, "max_steps out of range"],
      [{ goal: "x", max_steps: 201 }, "max_steps out of range"],
      [{ goal: "x", driver: "bogus" }, "driver closed set"],
      [{ goal: "x", final_signal: { bogus_op: 1 } }, "final_signal not valid"],
      [{ goal: "x", final_signal: "not-an-object" }, "final_signal must be object"],
      [{ goal: "x", conf_floor: 2 }, "conf_floor out of range"],
      [{ goal: "x", slots: { k: 1 } }, "slot value must be a string"],
    ];
    for (const [args, label] of cases) {
      const resp = await request("drive", args);
      assert.equal(resp["ok"], false, `drive/${label} must be rejected`);
      assert.equal(resp["code"], "config_error", `drive/${label} must be config_error`);
      assert.equal(resp["session_id"], RUN_ID, `drive/${label} keeps the join key`);
    }
    const badCmd = await request("driveCommand", { cmd: "confirm" });
    assert.equal(badCmd["ok"], false);
    assert.equal(badCmd["code"], "config_error");
    assert.equal(badCmd["session_id"], RUN_ID);
    const unknownType = await request("frobnicate");
    assert.equal(unknownType["ok"], false);
    assert.equal(unknownType["code"], "config_error");
    const allowedTypes = unknownType["allowed_types"] as string[];
    assert.ok(Array.isArray(allowedTypes)
      && ["drive", "driveCommand", "driveStatus", "driveClose"].every((t) => allowedTypes.includes(t)),
      "the drive ops join the closed request-type set");

    const idleStatus = await request("driveStatus");
    assert.equal(idleStatus["ok"], true);
    assert.equal(idleStatus["active"], false, "no driver is active before drive");
    assert.equal(idleStatus["status"], "idle");
    assert.equal(idleStatus["steps"], 0);
    assert.equal(idleStatus["session_id"], RUN_ID);

    // ---- drive：agent 驾驶（零模型）在宿主 page 上起步并停在步间等待 ----
    const drive1 = await request("drive", {
      goal: "zerblonix frobnicate", driver: "agent",
      final_signal: { url_contains: "/done.html" }, max_steps: 6,
    });
    assert.equal(drive1["ok"], true, `drive must start: ${JSON.stringify(drive1)}`);
    assert.equal(drive1["session_id"], RUN_ID);
    assert.equal(drive1["status"], "await_pick", "agent driving waits for a named pick");
    assert.equal(drive1["steps"], 0, "no step executed yet");
    assert.equal(drive1["model_asks"], 0, "agent driving asks no model");
    const started = drive1["started"] as Record<string, unknown>;
    assert.equal(started["ok"], true);
    assert.equal(started["attached"], true, "pilot attaches to the host session");
    assert.equal(started["url"], homeUrl, "started reports the host page as-is");
    const pilotOutDir = String(drive1["out_dir"]);
    assert.ok(fs.existsSync(pilotOutDir), "pilot evidence dir exists");
    assert.notEqual(path.resolve(pilotOutDir), path.resolve(sessionOutDir), "pilot evidence dir is independent");
    assert.equal(gotoCalls, 0, "attached start must not re-navigate");
    assert.equal(hostPage(), page0, "drive keeps the host page object");
    assert.equal(await evaluator(page0, () => (globalThis as unknown as Record<string, unknown>)["__afDriveMarker"]), "home",
      "a non-navigating drive keeps the page JS state");
    const events1 = assertBoundedEvents(drive1["events"], "drive#1");
    assert.ok(events1.some((e) => e["type"] === "started" && e["attached"] === true), "started event is captured and bounded");
    assert.ok(events1.some((e) => e["type"] === "step_request" && e["candidate_count"] !== undefined),
      "agent waiting projects candidate count only (never the rows)");
    const pilotRt = (internals.driver as unknown as { rt: PilotRuntime | null }).rt;
    assert.ok(pilotRt !== null, "pilot runtime exists after drive");
    assert.equal(await pilotRt!.page(), page0, "pilot drives the host session page object");

    // ---- 同一 session 只托管一个 driver：再次 drive 复用（不新建第二份账本） ----
    const driveAgain = await request("drive", { goal: "ignored while the driver is live", driver: "agent" });
    assert.equal(driveAgain["ok"], true);
    assert.equal(driveAgain["reused"], true, "a second drive reuses the live driver");
    assert.equal(driveAgain["status"], "await_pick");
    assert.equal(driveAgain["out_dir"], pilotOutDir, "the evidence dir does not change");
    assert.equal(hostPage(), page0);

    // ---- driveCommand resume{hint}：点名确定性命中 → 点击导航到 detail ----
    const resume1 = await request("driveCommand", { cmd: "resume", hint: "#go" });
    assert.equal(resume1["ok"], true, `resume must drive: ${JSON.stringify(resume1).slice(0, 400)}`);
    assert.equal(resume1["outcome"], "drive");
    assert.equal(resume1["session_id"], RUN_ID);
    assert.equal(resume1["status"], "await_pick", "after the pick the driver waits again (no final signal yet)");
    assert.equal(resume1["url"], detailUrl, "the hint pick navigated the host page");
    assert.equal(gotoCalls, 0, "driving uses page controls, never page.goto");
    assert.equal(hostPage(), page0, "navigation keeps the host page object");
    const resumeEvents = assertBoundedEvents(resume1["events"], "resume#1");
    assert.ok(resumeEvents.some((e) => e["type"] === "command_result" && e["ok"] === true), "resume receipt is projected");
    const executed = resumeEvents.filter((e) => e["type"] === "drive");
    assert.equal(executed.length, 1, "exactly one executed driving step");
    assert.equal(executed[0]!["picked_by"], "rule", "the named hint executes deterministically (zero model)");
    assert.equal(executed[0]!["op"], "click");

    // ---- 停驶等兜底时 session 照常可用：人工补一步，同一 page/URL/表单值保持 ----
    const filled = await request("act", { op: "fill", target: "#note", value: "人工值" });
    assert.equal(filled["ok"], true, `manual fill must work while the pilot waits: ${JSON.stringify(filled).slice(0, 300)}`);
    assert.equal(filled["executed"], true);
    const readValue = await request("read", { selector: "#note", what: "value" });
    assert.equal(readValue["value"], "人工值", "the form value set by the manual step is kept");
    assert.equal(hostPage(), page0);
    const midStatus = await request("driveStatus");
    assert.equal(midStatus["status"], "await_pick");
    assert.equal(midStatus["active"], true);
    assert.equal(midStatus["url"], detailUrl, "the pilot sees the same page the session is on");
    assert.equal(midStatus["model_asks"], 0);

    // ---- 第二个 resume 走到声明信号：final_signal_held → 终态 ----
    const resume2 = await request("driveCommand", { cmd: "resume", hint: "#finish" });
    assert.equal(resume2["ok"], true);
    assert.equal(resume2["outcome"], "drive");
    assert.equal(resume2["status"], "done");
    assert.equal(resume2["stop_code"], "final_signal_held", "completion is a verified signal, not a model vote");
    assert.equal(resume2["terminal"], true);
    assert.equal(resume2["url"], doneUrl);
    assert.equal(resume2["session_id"], RUN_ID);
    assert.equal(hostPage(), page0);

    // 终态再 drive：结构化拒绝，不静默重启第二个 pilot。
    const afterEnd = await request("drive", { goal: "zerblonix frobnicate" });
    assert.equal(afterEnd["ok"], false);
    assert.equal(afterEnd["code"], "drive_terminal");
    assert.equal(afterEnd["session_id"], RUN_ID);

    // ---- driveStatus：只读终态摘要 ----
    const status = await request("driveStatus");
    assert.equal(status["ok"], true);
    assert.equal(status["active"], false);
    assert.equal(status["terminal"], true);
    assert.equal(status["status"], "done");
    assert.equal(status["stop_code"], "final_signal_held");
    assert.equal(status["steps"], 2, "two executed driving steps");
    assert.equal(status["model_asks"], 0);
    assert.equal(status["out_dir"], pilotOutDir);
    assert.equal(status["session_id"], RUN_ID);
    assert.equal("handoff_open" in status, false, "a finished drive has no open handoff");

    // done 页 JS 标记：driveClose 之后必须还活着（宿主浏览器没被 pilot 收尾带走）。
    await evaluator(page0, () => {
      (globalThis as unknown as Record<string, unknown>)["__afDoneMarker"] = "survives";
    });

    // ---- driveClose：只终结驾驶，不关宿主浏览器 ----
    const droveClosed = await request("driveClose");
    assert.equal(droveClosed["ok"], true);
    assert.equal(droveClosed["closed"], true);
    assert.equal(droveClosed["session_id"], RUN_ID);
    assert.equal(droveClosed["stop_code"], "final_signal_held");
    const summary = droveClosed["summary"] as Record<string, unknown>;
    assert.ok(summary !== null && typeof summary === "object", "pilot_end summary is projected");
    assert.equal(summary["type"], "pilot_end");
    assert.equal(summary["attached"], true, "the terminal summary marks the attach mode");
    assert.equal(summary["stop_code"], "final_signal_held");
    assert.equal(summary["model_asks"], 0);
    assertBoundedEvents(droveClosed["events"], "driveClose");

    assert.equal(hostPage(), page0, "driveClose does not touch the host session");
    assert.equal(await evaluator(page0, () => (globalThis as unknown as Record<string, unknown>)["__afDoneMarker"]), "survives",
      "driveClose keeps the host page JS state");
    assert.equal(page0.isClosed?.() === true, false, "driveClose must not close the host page");

    const observed = await request("observe", { max: 20 });
    assert.equal(observed["ok"], true, "the session can observe after driveClose");
    assert.equal(observed["url"], doneUrl);
    const acted = await request("act", { op: "click", target: "#again" });
    assert.equal(acted["ok"], true, "the session can act after driveClose");
    assert.equal(acted["executed"], true);
    const clicked = await request("read", { selector: "body", what: "attr", attr: "data-clicked" });
    assert.equal(clicked["value"], "1");

    // ---- 会话自身 close：此刻才关宿主浏览器 ----
    const closeId = 9000;
    assert.equal(await rt.handleLine(JSON.stringify({ id: closeId, type: "close" })), true, "close ends the session");
    const closeResp = responses.find((r) => r["id"] === closeId);
    assert.ok(closeResp !== undefined);
    assert.equal(closeResp!["ok"], true);
    sessionClosed = true;
    assert.equal(internals.holder.session, null, "the session released its browser session");
    let pageClosed = false;
    try {
      pageClosed = page0.isClosed?.() === true;
    } catch {
      pageClosed = true;
    }
    assert.equal(pageClosed, true, "the host browser is closed by the session, not by driveClose");
  } finally {
    if (!sessionClosed) {
      try { await rt.finish("eof"); } catch { /* 收尾失败不掩盖断言 */ }
    }
  }
}

/* ------------------------------------------------------------------ 场景 2：交接打开时的互证 */

/**
 * 交接（handoff）打开时 session 照常可用：零模型造一个确定性停因（任务页漂移
 * off_task_page）→ 停驶交接 → session 的 observe/act/read 在交接期间可用 →
 * finish（预声明信号不成立）= 单行被拒（outcome=stay，会话不杀）→ redirect 回任务页解除。
 */
async function scenarioHandoffPlay(env: NodeJS.ProcessEnv, origin: string): Promise<void> {
  const sessionOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-verify-session-drive-handoff-"));
  const responses: Array<Record<string, unknown>> = [];
  const sink: SessionSink = { respond: (o) => { responses.push(o); }, log: () => {} };
  const homeUrl = `${origin}/home.html`;
  const detailUrl = `${origin}/detail.html`;
  const rt = new SessionRuntime({
    url: homeUrl,
    hosts: [new URL(homeUrl).hostname],
    outDir: sessionOutDir,
    quiet: true,
    idleTimeoutMs: 0,
    env,
  }, sink, "verify-session-drive-handoff");
  let closed = false;
  try {
    await rt.start();
    const request = makeClient(rt, responses);
    const internals = rt as unknown as SessionInternals;
    const hostPage = (): AnyPage => {
      const session = internals.holder.session;
      assert.ok(session !== null, "handoff: host browser session exists");
      return session!.page;
    };
    const page0 = hostPage();

    const drive = await request("drive", {
      goal: "zerblonix frobnicate", driver: "agent",
      expect_url: "/home.html",
      final_signal: { url_contains: "/never-holds.html" },
      max_steps: 4,
    });
    assert.equal(drive["ok"], true);
    assert.equal(drive["status"], "await_pick");

    // 同 host 改道到非任务页：驾驶前的 expect_url 守卫确定性停 off_task_page 并交接。
    const drifted = await request("driveCommand", { cmd: "redirect", url: detailUrl });
    assert.equal(drifted["ok"], true);
    assert.equal(drifted["outcome"], "drive");
    assert.equal(drifted["status"], "handoff", "URL drift stops into a handoff");
    assert.equal(drifted["stop_code"], "off_task_page");
    const handoff = drifted["handoff"] as Record<string, unknown>;
    assert.ok(handoff !== null && typeof handoff === "object", "handoff block is projected");
    assert.equal(handoff["stop_code"], "off_task_page", "handoff reuses the pilot-contract stop codes");
    assert.equal(typeof handoff["step_id"], "number", "handoff carries the step id");
    assert.equal(typeof (handoff["why_stuck"] as Record<string, unknown>)["summary"], "string", "why_stuck summary is bounded text");
    const unblock = handoff["what_would_unblock"] as string[];
    assert.ok(Array.isArray(unblock) && unblock.length > 0 && unblock.length <= 3, "unblock hints are bounded");
    assert.ok(unblock.some((h) => h.includes("redirect")), "unblock names the deterministic recovery");
    assertBoundedEvents(drifted["events"], "handoff/drift");

    // 交接打开 = pilot 暂停；session 的 observe/act/read 必须照常可用（同一 page）。
    const observed = await request("observe", { max: 20 });
    assert.equal(observed["ok"], true, "the session can observe while a handoff is open");
    assert.equal(observed["url"], detailUrl);
    const filled = await request("act", { op: "fill", target: "#note", value: "交接中的人工步" });
    assert.equal(filled["ok"], true, "the session can act while a handoff is open");
    assert.equal(filled["executed"], true);
    assert.equal((await request("read", { selector: "#note", what: "value" }))["value"], "交接中的人工步");
    assert.equal(hostPage(), page0);
    const openStatus = await request("driveStatus");
    assert.equal(openStatus["status"], "handoff");
    assert.equal(openStatus["active"], true);
    assert.equal((openStatus["handoff_open"] as Record<string, unknown>)["stop_code"], "off_task_page",
      "status exposes the open handoff");

    // 预声明信号不成立时 finish 只是单行被拒（交接保持打开，不杀会话）。
    const refused = await request("driveCommand", { cmd: "finish" });
    assert.equal(refused["ok"], false);
    assert.equal(refused["outcome"], "stay");
    assert.equal(refused["code"], "signal_not_held", "finish without a held signal is a structured single-line failure");
    assert.equal((await request("driveStatus"))["status"], "handoff", "the handoff stays open after the refusal");

    // redirect 回任务页：守卫放行，驾驶重新可继续。
    const back = await request("driveCommand", { cmd: "redirect", url: homeUrl });
    assert.equal(back["ok"], true);
    assert.equal(back["outcome"], "drive");
    assert.notEqual(back["stop_code"], "off_task_page", "back on the task page the drift guard releases");
    assert.equal(hostPage(), page0);

    const droveClosed = await request("driveClose");
    assert.equal(droveClosed["ok"], true);
    assert.equal(droveClosed["closed"], true, "driveClose closes the driving face");
    assert.equal(hostPage(), page0, "driveClose keeps the host session alive");
    const afterClose = await request("observe", { max: 10 });
    assert.equal(afterClose["ok"], true, "the session still works after driveClose");

    closed = true;
    assert.equal(await rt.handleLine(JSON.stringify({ id: 9100, type: "close" })), true);
    assert.equal(internals.holder.session, null);
  } finally {
    if (!closed) {
      try { await rt.finish("eof"); } catch { /* 收尾失败不掩盖断言 */ }
    }
  }
}

/* ------------------------------------------------------------------ 场景 3：校验先于浏览器 */

/** 校验先于浏览器惰性创建：未 open 的会话收到坏 drive 不启动浏览器（0 进程）。 */
async function scenarioValidationBeforeBrowser(env: NodeJS.ProcessEnv): Promise<void> {
  const responses: Array<Record<string, unknown>> = [];
  const rt = new SessionRuntime({
    quiet: true, idleTimeoutMs: 0, env,
  }, { respond: (o) => { responses.push(o); }, log: () => {} }, "verify-session-drive-bare");
  try {
    await rt.start();
    const request = makeClient(rt, responses);
    const rejected = await request("drive", { max_steps: 5 });
    assert.equal(rejected["ok"], false);
    assert.equal(rejected["code"], "config_error");
    const noDriver = await request("driveCommand", { cmd: "resume", hint: "#go" });
    assert.equal(noDriver["ok"], false);
    assert.equal(noDriver["code"], "config_error", "driveCommand before drive is a structured config error");
    assert.equal((rt as unknown as SessionInternals).holder.session, null,
      "an invalid drive must not launch the browser");
  } finally {
    await rt.finish("eof");
  }
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<number> {
  const env = laneEnv();
  const server = await startFixtureServer();
  try {
    await scenarioAttachDrive(env, server.origin);
    await scenarioHandoffPlay(env, server.origin);
    await scenarioValidationBeforeBrowser(env);
  } finally {
    await server.close();
  }
  console.log("verify-session-drive: OK — 附着驾驶全链 + 交接期间 session 互证 + 校验先于浏览器 三场景全过（零模型、同一 page、宿主浏览器不被 pilot 关闭）");
  return 0;
}

try {
  process.exit(await main());
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`verify-session-drive: FAIL — ${message}`);
  const environment = /Executable doesn't exist|Failed to launch|browserType\.launch|Executable path/i.test(message);
  process.exit(environment ? 2 : 1);
}
