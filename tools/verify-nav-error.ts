/**
 * verify-nav-error —— **非门禁** lane：导航失败与 hosts 信封的区分（两端同一条判据）。
 *
 * 验收的事只有一件：落在 Chrome 内部错误页（`chrome-error://chromewebdata/`）**不是**越界。
 * 错误页 URL 的 host 是 `chromewebdata`，拿它判信封会把「网络不通」谎报成安全类停因
 * （pilot = `host_not_allowed`、run 面 popup 扫描 = `popup_not_allowed`），把兜底方引去改 hosts。
 *
 * 断言组：
 *   ① 纯函数分类表：连接/DNS/超时类原文 → `unreachable`；端口被拒/畸形 URL/未知 → `config_error`；
 *      `isChromeErrorPage` 只认 `chrome-error:` 前缀（站点页绝不误判）；
 *   ② pilot 面（`PilotRuntime`，agent 驾驶零模型票）：点不可达链接 → `unreachable` /
 *      `config_error`，交接证据 `nav_error` 带浏览器原文 `net::ERR_*`，**不是** `host_not_allowed`；
 *   ③ run 面（`BrowserMiddleware.run`，rules-only）：同一组链接 → `config_error` + 原文，
 *      **不是** `host_not_allowed`/`popup_not_allowed`；
 *   ④ 反证：同一信封下真正跨 host 的跳转，两面都仍停 `host_not_allowed`（正常语义没被放宽）。
 *
 * 零外部网络：页面都来自本进程起的 127.0.0.1 静态服务；两个失败用例指向浏览器拒绝的端口与
 * `.invalid` 保留域名（RFC 6761 保证永不解析），不发出真实互联网请求。
 *
 * 用法：node --experimental-strip-types tools/verify-nav-error.ts
 * 退出码：0 全过 / 1 任一断言红 / 2 环境错误（chromium 缺失等）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PilotRuntime, type PilotSink } from "../src/app/pilot-runtime.ts";
import { buildMiddleware } from "../src/app/middleware-factory.ts";
import { browserSession } from "../src/engine/executor.ts";
import { urlOf } from "../src/engine/page-shapes.ts";
import {
  NAV_ERROR_DIRECTIVE, classifyNavError, contextNavError, isChromeErrorPage, navErrorStopReason, navErrorText,
  type NavFailure,
} from "../src/engine/nav-error.ts";
import { installLayaRuntime } from "../src/model/model.ts";
import { installDecisionProvider } from "../src/model/decision-provider.ts";

const UNREACHABLE_PROVIDER = "http://127.0.0.1:1";

/** 不可达与跨 host 的落点（`.invalid` = RFC 6761 保留域名，保证永不解析）。 */
const DNS_FAIL_URL = "http://nope-af.invalid/";
const UNSAFE_PORT_URL = "http://127.0.0.1:1/";

function navPage(crossOrigin: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>nav error</title></head><body>
    <main>
      <a id="dns" href="${DNS_FAIL_URL}">Dns fail target</a>
      <a id="port" href="${UNSAFE_PORT_URL}">Unsafe port target</a>
      <a id="cross" href="${crossOrigin}/away.html">Cross host target</a>
    </main></body></html>`;
}

const AWAY_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>away</title></head><body>
  <div id="away">away</div></body></html>`;

async function startServer(bindHost: string, pages: Record<string, string>): Promise<{ origin: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", `http://${bindHost}`).pathname;
    const html = pages[p];
    if (html === undefined) { res.statusCode = 404; res.end("not found"); return; }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, bindHost, resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://${bindHost}:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e === undefined ? resolve() : reject(e)))),
  };
}

/** 规则面执行器：无 LayaRuntime / 无 provider ⇒ 零模型调用、不花票。 */
function laneEnv(): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "af-verify-nav-error-home-"));
  Object.assign(process.env, {
    AMBERFLOW_HOME: home,
    AMBERFLOW_DECISION_BASE_URL: UNREACHABLE_PROVIDER,
    AMBERFLOW_DECISION_API_KEY: "unused-lane-key",
    AMBERFLOW_DECISION_MODEL: "unused-lane-model",
  });
  return process.env;
}

/* ------------------------------------------------------------------ ① 纯函数分类表 */

function scenarioClassificationTable(): void {
  assert.equal(isChromeErrorPage("chrome-error://chromewebdata/"), true, "the internal error page is recognized");
  assert.equal(isChromeErrorPage("CHROME-ERROR://chromewebdata/"), true, "the protocol check is case-insensitive");
  assert.equal(isChromeErrorPage("http://127.0.0.1:9/x"), false, "an ordinary http page is never an error page");
  assert.equal(isChromeErrorPage(""), false, "an empty url is not an error page");

  assert.equal(navErrorText("page.reload: net::ERR_UNSAFE_PORT"), "net::ERR_UNSAFE_PORT", "the browser text is extracted verbatim");
  assert.equal(navErrorText("plain failure"), "plain failure", "text without net:: is passed through");

  const cases: Array<[string, "unreachable" | "config_error"]> = [
    ["net::ERR_NAME_NOT_RESOLVED", "unreachable"],
    ["net::ERR_CONNECTION_REFUSED", "unreachable"],
    ["net::ERR_CONNECTION_TIMED_OUT", "unreachable"],
    ["net::ERR_CONNECTION_RESET", "unreachable"],
    ["net::ERR_INTERNET_DISCONNECTED", "unreachable"],
    ["net::ERR_NAVIGATION_ABORTED", "unreachable"],
    ["net::ERR_UNSAFE_PORT", "config_error"],
    ["net::ERR_INVALID_URL", "config_error"],
    ["net::ERR_DISALLOWED_URL_SCHEME", "config_error"],
    ["something unexpected", "config_error"],
  ];
  for (const [text, want] of cases) {
    assert.equal(classifyNavError(text), want, `${text} classifies as ${want}`);
  }

  // 两面口径一致：run 面不解码（stop_code 恒 config_error），但 reason 必须说清是哪一类，
  // 且与 pilot 面的解锁建议同向（不可达 → 验证可达；声明问题 → 改声明）。
  const unavailable: NavFailure = { code: "unreachable", reason: "navigation failed: net::ERR_NAME_NOT_RESOLVED", url: "chrome-error://chromewebdata/" };
  const config: NavFailure = { code: "config_error", reason: "navigation failed: net::ERR_UNSAFE_PORT", url: "chrome-error://chromewebdata/" };
  assert.ok(navErrorStopReason(unavailable).includes("net::ERR_NAME_NOT_RESOLVED"), "the run-side reason keeps the original text");
  assert.ok(navErrorStopReason(unavailable).includes(NAV_ERROR_DIRECTIVE.unreachable), "the unreachable directive is appended verbatim");
  assert.ok(navErrorStopReason(config).includes(NAV_ERROR_DIRECTIVE.config_error), "the config directive is appended verbatim");
  assert.notEqual(NAV_ERROR_DIRECTIVE.unreachable, NAV_ERROR_DIRECTIVE.config_error,
    "the two classes never share a directive (the whole point: opposite remedies)");
  assert.ok(NAV_ERROR_DIRECTIVE.unreachable.includes("不可达"), "the unreachable directive says the site is unreachable");
  assert.ok(!NAV_ERROR_DIRECTIVE.unreachable.includes("改 meta 有效") && NAV_ERROR_DIRECTIVE.unreachable.includes("不是声明错误"),
    "the unreachable directive explicitly denies a declaration fix");
  assert.ok(NAV_ERROR_DIRECTIVE.config_error.includes("改声明"), "the config directive points at the declaration");
}

/* ------------------------------------------------------------------ ② pilot 面 */

interface Booted {
  rt: PilotRuntime;
  events: Array<Record<string, unknown>>;
}

async function bootPilot(url: string, hosts: string[]): Promise<Booted> {
  const events: Array<Record<string, unknown>> = [];
  const sink: PilotSink = { respond: (obj) => { events.push(obj as Record<string, unknown>); } };
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-verify-nav-error-out-"));
  const rt = new PilotRuntime({
    url, goal: "zerblonix frobnicate", hosts, maxSteps: 8, driver: "agent", env: laneEnv(), outDir,
  }, sink);
  await rt.start();
  return { rt, events };
}

function lastHandoff(events: Array<Record<string, unknown>>): Record<string, unknown> {
  const handoff = events.filter((e) => e["type"] === "handoff").pop();
  assert.ok(handoff !== undefined, "a handoff was projected");
  return handoff["handoff"] as Record<string, unknown>;
}

function evidenceOf(handoff: Record<string, unknown>): Record<string, unknown> {
  return ((handoff["why_stuck"] as Record<string, unknown>)["evidence"] ?? {}) as Record<string, unknown>;
}

async function scenarioPilotFace(origin: string): Promise<void> {
  const { rt, events } = await bootPilot(`${origin}/nav-error.html`, ["127.0.0.1"]);
  try {
    // DNS 失败：连接类原文 ⇒ unreachable，交接带原文，绝不是越界。
    assert.equal(await rt.handleLine('{"cmd":"resume","hint":"Dns fail target"}'), "drive");
    assert.equal(await rt.drive(), "unreachable", "a DNS failure is unreachable, not an envelope escape");
    const dnsHandoff = lastHandoff(events);
    assert.equal(dnsHandoff["stop_code"], "unreachable", "the handoff stop code carries the classification");
    assert.ok(String(evidenceOf(dnsHandoff)["nav_error"] ?? "").includes("net::ERR_NAME_NOT_RESOLVED"),
      "the handoff keeps the browser's original net::ERR_* text");
    assert.equal("off_envelope" in evidenceOf(dnsHandoff), false,
      "a navigation failure never claims an out-of-envelope landing");

    // 端口被浏览器拒绝：改端口，不是重试网络 ⇒ config_error。
    assert.equal(await rt.handleLine(`{"cmd":"redirect","url":"${origin}/nav-error.html"}`), "drive");
    assert.equal(await rt.handleLine('{"cmd":"resume","hint":"Unsafe port target"}'), "drive");
    assert.equal(await rt.drive(), "config_error", "a browser-refused port is a config error, not unreachable");
    assert.ok(String(evidenceOf(lastHandoff(events))["nav_error"] ?? "").includes("net::ERR_UNSAFE_PORT"),
      "the port rejection text is kept");

    // 反证：真正跨 host 的跳转仍是 host_not_allowed，并带落地 URL。
    assert.equal(await rt.handleLine(`{"cmd":"redirect","url":"${origin}/nav-error.html"}`), "drive");
    assert.equal(await rt.handleLine('{"cmd":"resume","hint":"Cross host target"}'), "drive");
    assert.equal(await rt.drive(), "host_not_allowed", "a real cross-host navigation stays an envelope stop");
    assert.ok(String(evidenceOf(lastHandoff(events))["off_envelope"] ?? "").includes("127.0.0.2"),
      "the envelope stop still names the landing URL");
    await rt.finish(null);
  } finally {
    await rt.closeBrowser();
  }
}

/* ------------------------------------------------------------------ ③ run 面 */

async function runOnce(origin: string, target: string): Promise<{ stop_code?: string; stop_reason: string }> {
  installLayaRuntime(null);
  installDecisionProvider(null);
  const session = await browserSession(true);
  const mw = buildMiddleware({
    face: "online", confirmPolicy: { kind: "allow-all" },
    options: { hosts: ["127.0.0.1"], maxSteps: 1, gotoTimeout: 15_000 },
  });
  try {
    return await mw.run("点击链接", `${origin}/nav-error.html`, {
      commands: [{ id: "c1", op: "click", target }],
      goalSignalFn: async () => false,
      page: session.page,
      verbose: false,
    });
  } finally {
    await session.close();
  }
}

async function scenarioRunFace(origin: string): Promise<void> {
  const dns = await runOnce(origin, "#dns");
  assert.equal(dns.stop_code, "config_error", "run face: a DNS failure is a config error (no unreachable in the run StopCode set)");
  assert.ok(dns.stop_reason.includes("net::ERR_NAME_NOT_RESOLVED"), "run face: the original error text reaches stop_reason");
  assert.ok(dns.stop_reason.includes(NAV_ERROR_DIRECTIVE.unreachable),
    "run face: a DNS failure still carries the unreachable remedy (same advice as the pilot face, code unchanged)");
  assert.notEqual(dns.stop_code, "host_not_allowed", "run face: the error page is never reported as an envelope escape");
  assert.notEqual(dns.stop_code, "popup_not_allowed", "run face: the error page is never reported as a popup escape");

  const port = await runOnce(origin, "#port");
  assert.equal(port.stop_code, "config_error", "run face: a browser-refused port is a config error");
  assert.ok(port.stop_reason.includes("net::ERR_UNSAFE_PORT"), "run face: the port rejection text reaches stop_reason");
  assert.ok(port.stop_reason.includes(NAV_ERROR_DIRECTIVE.config_error), "run face: the port rejection carries the declaration remedy");

  const cross = await runOnce(origin, "#cross");
  assert.equal(cross.stop_code, "host_not_allowed", "run face: a real cross-host navigation stays an envelope stop");
  assert.ok(cross.stop_reason.includes("127.0.0.2"), "run face: the envelope stop still names the landing host");
}

/**
 * run 面起跑面（`runSetup` 的 popup 扫描）：宿主页已在 Chrome 错误页时，`skipNavigation` 起跑
 * 不得把错误页说成 `popup_not_allowed`（popup 是安全码，错误页是网络失败）。
 */
async function scenarioRunSetupFace(origin: string): Promise<void> {
  installLayaRuntime(null);
  installDecisionProvider(null);
  const session = await browserSession(true);
  try {
    const page = session.page;
    await page.goto(`${origin}/nav-error.html`, { waitUntil: "domcontentloaded" });
    await page.locator("#port").click({ timeout: 5000 }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(isChromeErrorPage(urlOf(page)), true, "the host page landed on the browser error page");
    const mw = buildMiddleware({
      face: "online", confirmPolicy: { kind: "allow-all" },
      options: { hosts: ["127.0.0.1"], maxSteps: 1, gotoTimeout: 15_000 },
    });
    const report = await mw.run("点击链接", `${origin}/nav-error.html`, {
      commands: [{ id: "c1", op: "click", target: "#dns" }],
      goalSignalFn: async () => false,
      page, skipNavigation: true, verbose: false,
    });
    assert.equal(report.stop_code, "config_error", "the start-up scan reports a config error, not a popup escape");
    assert.ok(report.stop_reason.includes("net::ERR_UNSAFE_PORT"), "the start-up scan keeps the original error text");
  } finally {
    await session.close();
  }
}

/* ------------------------------------------------------------------ ④ context 扫描 */

async function scenarioContextScan(origin: string): Promise<void> {
  const session = await browserSession(true);
  try {
    const page = session.page;
    assert.equal(await contextNavError(page), null, "a healthy context reports no navigation failure");
    await page.goto(`${origin}/nav-error.html`, { waitUntil: "domcontentloaded" });
    // 点击一个不可达链接：主页面落到 Chrome 错误页（直接 goto 不会落地，只有页面驱动导航会）。
    await page.locator("#port").click({ timeout: 5000 }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const failure = await contextNavError(page);
    assert.ok(failure !== null, "a context with a Chrome error page reports the failure");
    assert.equal(failure!.code, "config_error", "the port rejection is classified as a config error");
    assert.ok(failure!.reason.includes("net::ERR_UNSAFE_PORT"), "the recovered text is the browser's original one");
  } finally {
    await session.close();
  }
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<number> {
  const away = await startServer("127.0.0.2", { "/away.html": AWAY_PAGE });
  const here = await startServer("127.0.0.1", { "/nav-error.html": navPage(away.origin) });
  const failures: string[] = [];
  const scenarios: Array<[string, () => Promise<void> | void]> = [
    ["纯函数分类表（unreachable/config_error/错误页识别）", scenarioClassificationTable],
    ["pilot 面：错误页→unreachable/config_error 带原文，跨 host 仍越界", () => scenarioPilotFace(here.origin)],
    ["run 面：错误页→config_error 带原文，跨 host 仍越界", () => scenarioRunFace(here.origin)],
    ["run 起跑面：错误页→config_error 不是 popup 越界", () => scenarioRunSetupFace(here.origin)],
    ["context 扫描：错误页先于 popup 归属", () => scenarioContextScan(here.origin)],
  ];
  try {
    for (const [name, run] of scenarios) {
      try {
        await run();
        console.log(`verify:nav-error PASS ${name}`);
      } catch (e) {
        failures.push(name);
        console.error(`verify:nav-error FAIL ${name}: ${(e as Error).message}`);
      }
    }
  } finally {
    await here.close();
    await away.close();
  }
  if (failures.length > 0) {
    console.error(`verify:nav-error: ${failures.length}/${String(scenarios.length)} 场景未过（${failures.join("、")}）`);
    return 1;
  }
  console.log(`verify:nav-error: ${scenarios.length}/${scenarios.length} 场景全过`);
  return 0;
}

process.exit(await main());
