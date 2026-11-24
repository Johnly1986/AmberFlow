/**
 * verify-record-failure —— 记录流写失败路径的**进程级**验收 lane（非门禁，需 chromium）。
 *
 * 审计复现形态：`amber session --record /dev/full` 时写流异步 emit ENOSPC，不接管会变成
 * 未捕获异常——会话在 close 前裸栈崩溃。本 lane 断言失败路径被接管后的三件事：
 *   - 会话仍正常收尾：子进程 exit 0，open/mark/close 响应齐全；
 *   - 失败有日志：stderr 出现 `record write failed:`，且没有未捕获异常的崩溃尾巴；
 *   - pilot 同款：驾驶轨迹流写失败只降级为日志，终态 `pilot_end` 照常发出，不崩进程。
 * 反向断言（成功路径不变）：正常 `--record` 仍逐行 JSONL、exit 0，会话轨迹文件照落。
 *
 * `/dev/full` 的截图：会话收尾会把 `${record}.trace.json` 写到 `/dev/full.trace.json`
 * （既有行为，本 lane 不改），用例结束按 best-effort 清理这一个自己制造的旁路文件。
 *
 * 用法：node --experimental-strip-types tools/verify-record-failure.ts
 * 退出码：0 绿 / 1 红 / 2 环境错误（非 Linux、缺 /dev/full 或 chromium）。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PilotRuntime, type PilotSink } from "../src/app/pilot-runtime.ts";
import type { PilotRecordLine } from "../src/app/pilot-contract.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const DEV_FULL = "/dev/full";
/** /dev/full 的 `--record` 会顺带落 `${record}.trace.json`——测试自己制造，自己清理。 */
const DEV_FULL_TRACE = `${DEV_FULL}.trace.json`;
const EXIT_BUDGET_MS = 60_000;

type Json = Record<string, unknown>;

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 本地静态夹具：只有会话打开这一页，外部请求零依赖。 */
async function startFixture(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end('<!doctype html><html lang="zh"><body><button id="next-btn">下一步</button>'
      + '<a id="detail-link" href="#detail">详情</a></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}/probe.html`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e === undefined ? resolve() : reject(e)))),
  };
}

interface SessionRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * 真实 `amber session` 子进程（`--input` 文件喂协议行，与审计复现同一条 CLI 路径）。
 * `record` 传 `/dev/full` = 写失败路径；传普通文件 = 成功路径对照。
 */
async function runSession(origin: string, record: string, requests: string[]): Promise<SessionRun> {
  const home = tmp("af-record-failure-home-");
  const outDir = tmp("af-record-failure-out-");
  const input = path.join(outDir, "requests.jsonl");
  fs.writeFileSync(input, `${requests.join("\n")}\n`);
  const child = spawn(process.execPath, [
    "--experimental-strip-types", "src/cli/main.ts", "session",
    "--url", origin, "--record", record, "--out", outDir, "--input", input,
    "--idle-timeout-ms", "20000",
  ], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AMBERFLOW_HOME: home } });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c: string) => { stdout += c; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => { stderr += c; });
  const code = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already dead */ } resolve(-99); }, EXIT_BUDGET_MS);
    child.on("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode ?? -1); });
  });
  return { exitCode: code, stdout, stderr };
}

/** stdout 协议行解析（一行一个 JSON；坏行如实计红，不跳过）。 */
function protocolLines(stdout: string): Json[] {
  const out: Json[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    out.push(JSON.parse(t) as Json);
  }
  return out;
}

function crashMarkers(stderr: string): string[] {
  const hits: string[] = [];
  if (/Unhandled 'error' event/.test(stderr)) hits.push("Unhandled 'error' event");
  if (/Emitted 'error' event on WriteStream/.test(stderr)) hits.push("Emitted 'error' event on WriteStream");
  if (/^Node\.js v\d/m.test(stderr)) hits.push("Node.js 崩溃页脚");
  if (/\bat process\.processTicksAndRejections\b/.test(stderr)) hits.push("未捕获异常栈");
  return hits;
}

function isChromiumMissing(stderr: string): boolean {
  return /Executable doesn't exist|playwright install chromium|Failed to launch browser/.test(stderr);
}

/** 等一个轮询条件成立（记录文件落盘/流错误异步 emit 用；有界，不无限等）。 */
async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(25);
  }
  return check();
}

const problems: string[] = [];

/** R1：`--record /dev/full`——不裸栈崩溃、有日志、会话正常收尾（exit 语义不变）。 */
async function caseSessionRecordFailure(origin: string): Promise<void> {
  const r = await runSession(origin, DEV_FULL, [
    JSON.stringify({ id: 1, type: "mark", note: "record-failure" }),
    JSON.stringify({ id: 2, type: "close" }),
  ]);
  if (isChromiumMissing(r.stderr)) {
    problems.push("R1: chromium 缺失（`npx playwright install chromium`）");
    return;
  }
  const events = protocolLines(r.stdout);
  const byType = new Map(events.map((e) => [String(e["type"]), e]));
  if (r.exitCode !== 0) problems.push(`R1: 子进程 exit ${r.exitCode}（期望 0：失败路径不影响会话退出语义）`);
  for (const type of ["open", "mark", "close"]) {
    if (!byType.has(type)) problems.push(`R1: 缺少 ${type} 响应（会话在收尾前被打断）`);
  }
  for (const type of ["open", "mark", "close"]) {
    if (byType.get(type)?.["ok"] !== true) problems.push(`R1: ${type} 响应 ok!==true`);
  }
  if (!/record write failed:/.test(r.stderr)) problems.push("R1: 缺少 `record write failed:` 日志");
  const markers = crashMarkers(r.stderr);
  if (markers.length > 0) problems.push(`R1: 仍有未捕获异常痕迹（${markers.join(" / ")}）`);
  try { fs.unlinkSync(DEV_FULL_TRACE); } catch { /* 没写出来（非 root / 不可写）也正常 */ }
  console.log(`R1(/dev/full): exit=${r.exitCode} responses=${[...byType.keys()].join(",")} `
    + `log=${/record write failed:/.test(r.stderr) ? "yes" : "no"} crash=${markers.length === 0 ? "no" : "yes"}`);
}

/** R2：成功路径逐项不变——正常 `--record` 仍逐行 JSONL、exit 0、轨迹文件照落。 */
async function caseSessionRecordSuccess(origin: string): Promise<void> {
  const outDir = tmp("af-record-ok-out-");
  const record = path.join(outDir, "session-record.jsonl");
  const r = await runSession(origin, record, [
    JSON.stringify({ id: 1, type: "mark", note: "record-success" }),
    JSON.stringify({ id: 2, type: "close" }),
  ]);
  if (isChromiumMissing(r.stderr)) {
    problems.push("R2: chromium 缺失（`npx playwright install chromium`）");
    return;
  }
  if (r.exitCode !== 0) problems.push(`R2: 成功路径 exit ${r.exitCode}（期望 0）`);
  if (/record write failed:/.test(r.stderr)) problems.push("R2: 成功路径不应出现 record write failed");
  const types = protocolLines(r.stdout).map((e) => String(e["type"]));
  if (types.join(",") !== "open,mark,close") problems.push(`R2: 响应序列变化（${types.join(",")}）`);
  let lines: Json[] = [];
  try {
    lines = fs.readFileSync(record, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Json);
  } catch (e) {
    problems.push(`R2: 轨迹文件不可读（${e instanceof Error ? e.message : String(e)}）`);
  }
  const lineTypes = lines.map((l) => String(l["type"]));
  if (lineTypes.join(",") !== "open,mark") problems.push(`R2: 轨迹行变化（${lineTypes.join(",") || "(空)"}）`);
  if (!String(lines[0]?.["url"] ?? "").startsWith(origin.replace(/\/[^/]*$/, ""))) {
    problems.push("R2: open 轨迹行缺少入口 url");
  }
  if (typeof lines[0]?.["ts"] !== "string") problems.push("R2: open 轨迹行缺少 ts");
  const traceFile = `${record}.trace.json`;
  if (!fs.existsSync(traceFile)) problems.push("R2: 会话轨迹文件（record.trace.json）缺失");
  console.log(`R2(success): exit=${r.exitCode} lines=${lineTypes.join(",")} trace=${fs.existsSync(traceFile) ? "yes" : "no"}`);
}

/** R3：pilot 轨迹流写失败——只降级为日志、不打断驾驶收尾（终态行照发）。 */
async function casePilotRecordFailure(origin: string): Promise<void> {
  const events: Json[] = [];
  const sink: PilotSink = { respond: (obj) => { events.push(obj as Json); } };
  const rt = new PilotRuntime({
    url: origin, goal: "record stream failure path", record: DEV_FULL,
    outDir: tmp("af-record-failure-pilot-"),
    // 注入会话工厂抛错：本用例只关心记录流失败，不启动浏览器（停因如实投影 browser_dead）。
    sessionFactory: () => { throw new Error("lane: no browser in record-failure case"); },
  }, sink, "lane-record-failure");
  await rt.start();
  const line = { i: 0, ts: new Date().toISOString(), type: "command", command: { op: "resume" }, args: {} } as unknown as PilotRecordLine;
  rt.record(line);
  rt.record(line);
  await waitFor(() => events.some((e) => e["type"] === "log" && /record write failed:/.test(String(e["line"]))));
  const failLogs = events.filter((e) => e["type"] === "log" && /record write failed:/.test(String(e["line"])));
  if (failLogs.length === 0) problems.push("R3: pilot 轨迹写失败没有 `record write failed:` 日志");
  const before = events.length;
  rt.record(line); // 已停用：不再写、不再重建
  await sleep(100);
  if (events.length !== before) problems.push("R3: 写失败后记录流仍在重建/写入");
  await rt.finish(null);
  const end = events.find((e) => e["type"] === "pilot_end");
  if (end === undefined) problems.push("R3: 缺少 pilot_end 终态行");
  if (end?.["stop_code"] !== "browser_dead") problems.push(`R3: 终态 stop_code 变化（${String(end?.["stop_code"])}）`);
  console.log(`R3(pilot /dev/full): fail_logs=${failLogs.length} end=${end !== undefined ? "yes" : "no"} `
    + `stop=${String(end?.["stop_code"])}`);
}

/** R4：pilot 轨迹成功路径不变——正常 record 仍落单行 JSONL。 */
async function casePilotRecordSuccess(origin: string): Promise<void> {
  const events: Json[] = [];
  const sink: PilotSink = { respond: (obj) => { events.push(obj as Json); } };
  const record = path.join(tmp("af-record-ok-pilot-"), "pilot-trace.jsonl");
  const rt = new PilotRuntime({
    url: origin, goal: "record stream success path", record,
    outDir: tmp("af-record-ok-pilot-out-"),
    sessionFactory: () => { throw new Error("lane: no browser in record-success case"); },
  }, sink, "lane-record-ok");
  await rt.start();
  const line = { i: 0, ts: new Date().toISOString(), type: "command", command: { op: "resume" }, args: {} } as unknown as PilotRecordLine;
  rt.record(line);
  await waitFor(() => fs.existsSync(record) && fs.readFileSync(record, "utf8").includes("\n"));
  await rt.finish(null);
  await waitFor(() => fs.existsSync(record));
  const lines = fs.existsSync(record)
    ? fs.readFileSync(record, "utf8").split("\n").filter((l) => l.trim() !== "")
    : [];
  if (lines.length !== 1) problems.push(`R4: pilot 轨迹行数变化（${lines.length}）`);
  else {
    const parsed = JSON.parse(lines[0]!) as Json;
    if (parsed["type"] !== "command" || parsed["i"] !== 0 || typeof parsed["ts"] !== "string") {
      problems.push("R4: pilot 轨迹行格式变化");
    }
  }
  if (/record write failed:/.test(JSON.stringify(events))) problems.push("R4: 成功路径不应出现写失败日志");
  console.log(`R4(pilot success): lines=${lines.length} end=${events.some((e) => e["type"] === "pilot_end") ? "yes" : "no"}`);
}

async function main(): Promise<number> {
  if (process.platform !== "linux" || !fs.existsSync(DEV_FULL)) {
    console.error(`verify-record-failure: 需要 Linux 的 ${DEV_FULL}（当前平台 ${process.platform}）`);
    return 2;
  }
  // pilot 用例在进程内跑：决策源统一指向不可达地址（零模型加载；记录流用例不花模型票）。
  const home = tmp("af-record-failure-lane-home-");
  Object.assign(process.env, {
    AMBERFLOW_HOME: home,
    AMBERFLOW_DECISION_BASE_URL: "http://127.0.0.1:1",
    AMBERFLOW_DECISION_API_KEY: "unused-lane-key",
    AMBERFLOW_DECISION_MODEL: "unused-lane-model",
  });
  const fixture = await startFixture();
  try {
    await caseSessionRecordFailure(fixture.origin);
    await caseSessionRecordSuccess(fixture.origin);
    await casePilotRecordFailure(fixture.origin);
    await casePilotRecordSuccess(fixture.origin);
  } finally {
    await fixture.close();
    try { fs.unlinkSync(DEV_FULL_TRACE); } catch { /* 已清理或没写出来 */ }
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`verify-record-failure: FAIL — ${p}`);
    return 1;
  }
  console.log("verify-record-failure: OK — /dev/full 会话/pilot 记录流失败均降级不崩，成功路径格式与退出码不变");
  return 0;
}

process.exitCode = await main();
