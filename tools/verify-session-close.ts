/**
 * verify-session-close —— **非门禁**的 close 收口 lane（BACKLOG §14 验收）：真实浏览器 +
 * 真实 `amber session` 子进程的进程级观测。
 *
 * 与 verify:offline 同定位：需要 chromium，不进 `npm run check`，本地/定时跑。真正的完成
 * 裁决仍在 `amber run` / `online/` 套件，本工具只做进程事实断言：
 *   - C1（CLI + close 请求）：auto-open → close → 子进程在时限内自然退出（exit 0）；
 *   - C2（CLI + EOF，不发 close）：finish("eof") 路径同验收；
 *   - C3（一次性 embedder，直调 dispatch 不经入口循环）：close 自收口后进程自然退出——
 *     §14 的泄漏形态本体（修复前事件循环不退出）；
 *   - 每形态 chromium 进程数回基线（连续循环不残留）。
 *
 * 用法：node --experimental-strip-types tools/verify-session-close.ts [--loops N]
 * 退出码：0 绿 / 1 红 / 2 用法或环境错误（chromium 缺失）。
 */
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const EXIT_BUDGET_MS = 30_000;
const SETTLE_MS = 2_500;

function usage(): number {
  console.error("usage: node --experimental-strip-types tools/verify-session-close.ts [--loops N]");
  return 2;
}

function chromeCount(): number {
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq chrome.exe", "/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 15_000 });
  if (r.status !== 0) return -1;
  return r.stdout.split("\n").filter((line) => line.toLowerCase().includes("chrome.exe")).length;
}

/** 等本地静态服务起来的夹具页（只有这一个文件需要被会话打开）。 */
function startFixtureServer(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="zh"><body><button id="checkout-btn">结账</button></body></html>`);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({ origin: `http://127.0.0.1:${port}/probe.html`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

interface FormResult {
  form: string;
  exitCode: number;
  elapsedMs: number;
  chromeDelta: number | null;
}

/** C1/C2：真实 `amber session` 子进程——auto-open 后按形态收尾，观测退出与 chromium 残留。 */
async function runCliForm(origin: string, mode: "close" | "eof"): Promise<FormResult> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-session-close-"));
  const before = chromeCount();
  const started = Date.now();
  const child = spawn(process.execPath,
    ["--experimental-strip-types", "src/cli/main.ts", "session", "--url", origin, "--out", outDir, "--idle-timeout-ms", "20000"],
    { cwd: REPO, stdio: ["pipe", "pipe", "pipe"], env: process.env });
  let openSeen = false;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (c: string) => {
    if (!openSeen && c.includes('"type":"open"')) {
      openSeen = true;
      if (mode === "close") {
        child.stdin?.write(`${JSON.stringify({ id: 7, type: "close" })}\n`);
        child.stdin?.end();
      } else {
        child.stdin?.end();
      }
    }
  });
  const code = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already dead */ } resolve(-99); }, EXIT_BUDGET_MS);
    child.on("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode ?? -1); });
  });
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const after = chromeCount();
  return {
    form: mode === "close" ? "C1-close" : "C2-eof",
    exitCode: code,
    elapsedMs: Date.now() - started,
    chromeDelta: before >= 0 && after >= 0 ? after - before : null,
  };
}
function runEmbedderForm(origin: string): Promise<FormResult> {
  const driver = `
import { SessionRuntime } from "file:///${REPO.replace(/\\/g, "/")}/src/app/session-runtime.ts";
import type { SessionSink } from "file:///${REPO.replace(/\\/g, "/")}/src/app/session-runtime-contract.ts";
const sink: SessionSink = { respond: () => {}, log: () => {} };
const rt = new SessionRuntime({ url: process.env.AF_URL, outDir: process.env.AF_OUT, quiet: true, env: process.env }, sink, "embedder");
const dispatch = (rt as unknown as { dispatch(req: Record<string, unknown>): Promise<Record<string, unknown>> }).dispatch.bind(rt);
await dispatch({ type: "open", url: process.env.AF_URL });
await dispatch({ type: "close" });
// 故意不 process.exit：close 语义必须自收口（BACKLOG §14 的验收本体）
`;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-session-close-"));
  const driverPath = path.join(outDir, "driver.ts");
  fs.writeFileSync(driverPath, driver);
  const before = chromeCount();
  const started = Date.now();
  const child = spawn(process.execPath, ["--experimental-strip-types", driverPath],
    { cwd: REPO, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, AF_URL: origin, AF_OUT: path.join(outDir, "ev") } });
  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (c: string) => { stderrTail = (stderrTail + c).slice(-300); });
  const exitPromise = new Promise<number>((resolve) => {
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already dead */ } resolve(-99); }, EXIT_BUDGET_MS);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code ?? -1); });
  });
  return exitPromise.then(async (code) => {
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const after = chromeCount();
    return { form: "C3-embedder", exitCode: code, elapsedMs: Date.now() - started, chromeDelta: before >= 0 && after >= 0 ? after - before : null, _stderr: stderrTail.trim().slice(-200) } as FormResult & { _stderr: string };
  });
}

async function main(argv: string[]): Promise<number> {
  let loops = 1;
  const args = [...argv];
  while (args.length > 0) {
    const a = args.shift()!;
    if (a === "--loops") {
      const n = Number(args.shift());
      if (!Number.isInteger(n) || n < 1 || n > 10) return usage();
      loops = n;
    } else return usage();
  }
  const server = await startFixtureServer();
  const problems: string[] = [];
  try {
    const baseline = chromeCount();
    if (baseline < 0) { console.error("verify-session-close: chromium 进程枚举失败（tasklist 不可用）"); return 1; }
    // C1：连续 loops 次 open/close——进程数每次回基线（BACKLOG §14 验收本体）。
    for (let i = 1; i <= loops; i++) {
      const r = await runCliForm(server.origin, "close");
      if (r.exitCode !== 0) problems.push(`C1#${i}: 子进程未自然退出（exit ${r.exitCode}）`);
      if (r.chromeDelta !== null && r.chromeDelta !== 0) problems.push(`C1#${i}: chromium 残留 ${r.chromeDelta} 个进程`);
      console.log(`C1#${i}/${loops}: exit=${r.exitCode} delta=${r.chromeDelta}`);
    }
    const c2 = await runCliForm(server.origin, "eof");
    if (c2.exitCode !== 0) problems.push(`C2(eof): 子进程未自然退出（exit ${c2.exitCode}）`);
    if (c2.chromeDelta !== null && c2.chromeDelta !== 0) problems.push(`C2(eof): chromium 残留 ${c2.chromeDelta} 个进程`);
    console.log(`C2(eof): exit=${c2.exitCode} delta=${c2.chromeDelta}`);
    const c3 = await runEmbedderForm(server.origin);
    if (c3.exitCode !== 0) problems.push(`C3(embedder): 直调 dispatch 后进程未自然退出（exit ${c3.exitCode}）——§14 泄漏形态回归`);
    if (c3.chromeDelta !== null && c3.chromeDelta !== 0) problems.push(`C3(embedder): chromium 残留 ${c3.chromeDelta} 个进程`);
    console.log(`C3(embedder): exit=${c3.exitCode} delta=${c3.chromeDelta}`);
    if (problems.length > 0) {
      for (const p of problems) console.error(`verify-session-close: FAIL — ${p}`);
      return 1;
    }
    console.log(`verify-session-close: OK — C1×${loops} + C2(eof) + C3(embedder) 全部自然收口、chromium 零残留（基线 ${baseline}）`);
    return 0;
  } finally {
    await server.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
