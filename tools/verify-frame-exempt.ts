/**
 * verify-frame-exempt —— 帧门禁「同主域免检」口径的证据 lane（非门禁）。
 *
 * 口径（唯一出处 `src/engine/frame-scope.ts` 的 `frameGateExcludes`）：子 frame 与任一
 * 声明条目**同注册域**（不引入 PSL，双向取最后两段近似；IPv4/IPv6 只认精确相等；
 * 大小写折叠，协议/端口不参与）就不需要声明进 hosts、天然进解析面；跨注册域子帧仍排除。
 * 本 lane 四层取证：
 *   ① 纯函数边界表——`frameGateExcludes` 直测，逐条钉住免检/排除边界（无需浏览器）；
 *   ② 集成现状不反转——127.0.0.1 主帧 + 127.0.0.2 iframe 仍排除（IP 精确相等口径）；
 *   ③ 集成新行为——同 hostname 不同端口（127.0.0.1:PORT_A 主帧 + 127.0.0.1:PORT_B iframe）
 *      免检进池：端口不参与判定，这是新行为的核心断言；
 *   ④ 免检进池走的是门禁放行路径本身（`frameGateOf` 的 allowed/excluded 分类与
 *      `extractElements` 池构成一致），不是池通道碰巧绕过门禁。
 *
 * 用法：node --experimental-strip-types tools/verify-frame-exempt.ts [--json] [--headful]
 * 退出码：0 绿（全部断言通过）/ 1 红。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { extractElements } from "../src/app/candidate-scan.ts";
import { frameGateExcludes, frameGateOf } from "../src/engine/frame-scope.ts";
import { browserSession } from "../src/engine/executor.ts";
import { framesOf } from "../src/engine/page-shapes.ts";
import type { BrowserSession } from "../src/engine/executor-middleware-types.ts";
import type { FrameLike, PageLike } from "../src/support/page-like.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const PORT_DIR = path.join(REPO, "fixtures", "engine", "frames-port");
const CHILD_BUTTONS = ["Cancel", "Sign In"] as const;
const USAGE = [
  "usage: node --experimental-strip-types tools/verify-frame-exempt.ts [--json] [--headful]",
].join("\n");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 纯函数边界直测的 FrameLike 替身：只暴露 url（帧门禁只读它）。 */
function fakeFrame(url: string): FrameLike {
  return { locator: (() => { throw new Error("not used"); }) as FrameLike["locator"], evaluate: (() => { throw new Error("not used"); }) as FrameLike["evaluate"], url };
}

interface BoundaryCase {
  declared: string;
  frameUrl: string;
  /** true = 免检（frameGateExcludes === false）。 */
  exempt: boolean;
  why: string;
}

/** 边界表（与 docs/APP_SCRIPT_AUTHORING.md §frame 门禁同一组边界；改口径先同步这里）。 */
export function boundaryCases(): BoundaryCase[] {
  return [
    { declared: "google.com", frameUrl: "https://ogs.google.com/x", exempt: true, why: "子域帧免检（双向注册域近似的主向）" },
    { declared: "google.com", frameUrl: "https://google.com/x", exempt: true, why: "精确相等免检" },
    { declared: "www.google.com", frameUrl: "https://ogs.google.com/x", exempt: true, why: "用户原始场景：hostMatchesEnv 对它是 false（ogs.google.com 不以 .www.google.com 结尾），注册域都是 google.com ⇒ 免检" },
    { declared: "google.com", frameUrl: "https://notgoogle.com/x", exempt: false, why: "跨注册域仍排除" },
    { declared: "evil.io", frameUrl: "https://google.com.evil.io/x", exempt: true, why: "宽域声明 = 信任其全部子域（两段近似下声明的注册域就是 evil.io，该帧是它的下挂）" },
    { declared: "google.com", frameUrl: "https://google.com.evil.io/x", exempt: false, why: "注册域近似 evil.io ≠ google.com ⇒ 排除（免检方向必须双向，子域包含不能放它）" },
    { declared: "localhost", frameUrl: "http://localhost/x", exempt: true, why: "单标签无两段，退化为精确相等" },
    { declared: "127.0.0.1", frameUrl: "http://127.0.0.2/x", exempt: false, why: "IP 只认精确相等（现状场景不反转）" },
    { declared: "127.0.0.1", frameUrl: "http://127.0.0.1/x", exempt: true, why: "IP 精确相等免检" },
    { declared: "127.0.0.1", frameUrl: "http://127.0.0.1:8443/x", exempt: true, why: "端口不参与判定" },
    { declared: "google.com", frameUrl: "https://google.co.uk/x", exempt: false, why: "PSL 缺失的已知近似下仍排除（google.com vs co.uk 两段不等）" },
    { declared: "172.16.1.1", frameUrl: "http://10.16.1.1/x", exempt: false, why: "IP 精确相等反例：两段近似会把 16.1 === 16.1 误判同注册域" },
    { declared: "10.1.0.1", frameUrl: "http://10.1.0.2/x", exempt: false, why: "IP 精确相等（同网段不同主机）" },
    { declared: "GOOGLE.com", frameUrl: "https://OGS.GOOGLE.COM/x", exempt: true, why: "大小写折叠" },
  ];
}

/** 断言组①：纯函数边界表（无需浏览器）。 */
function boundaryAssertions(): string[] {
  const problems: string[] = [];
  for (const c of boundaryCases()) {
    // 帧 URL 不带端口时补主帧端口无关紧要：门禁只认 hostname；这里用同形 URL 让 fi>0 生效。
    // 双跑：hosts 传数组与传 readonly 视图（消费点都是 readonly 形）都必须同判定。
    const excluded = frameGateExcludes(1, fakeFrame(c.frameUrl), [c.declared]);
    const excludedRO = frameGateExcludes(1, fakeFrame(c.frameUrl), Object.freeze([c.declared]));
    if (excluded !== excludedRO) problems.push(`边界「${c.declared} + ${c.frameUrl}」：数组面与 readonly 面判定不一致（${excluded} vs ${excludedRO}）`);
    if (excluded === c.exempt) problems.push(`边界「${c.declared} + ${c.frameUrl}」：期望${c.exempt ? "免检" : "排除"}，实测${excluded ? "排除" : "免检"}——${c.why}`);
  }
  // 主帧短路：fi === 0 恒不排除（跨注册域也不排——导航信封已强制过主帧）。
  if (frameGateExcludes(0, fakeFrame("https://notgoogle.com/x"), ["google.com"]) !== false) {
    problems.push("主帧短路：fi=0 的跨注册域帧被排除（应恒允许）");
  }
  // 缺省不设防：无 hosts = 旧行为，子帧不排除。
  if (frameGateExcludes(1, fakeFrame("https://notgoogle.com/x"), null) !== false
    || frameGateExcludes(1, fakeFrame("https://notgoogle.com/x"), []) !== false) {
    problems.push("缺省不设防：hosts=null/[] 时子帧被排除（应零新行为）");
  }
  // 不可解析/非 http(s) 协议的帧仍走信封白名单放行（与 F45 既有口径一致，本批不收紧）：
  // 这是免检谓词**之前**的短路，不是免检分支的判定结果。
  for (const url of ["about:blank", "about:srcdoc", "data:text/html,x", ""]) {
    if (frameGateExcludes(1, fakeFrame(url), ["google.com"]) !== false) {
      problems.push(`信封白名单面：子帧 ${JSON.stringify(url)} 被排除（F45 既有口径放行，不许收紧）`);
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ 静态夹具服务 */

interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

/** 跨源帧服务：绑定指定回环 host（127.0.0.2 造不同 hostname；127.0.0.1 造同 hostname 异端口）。 */
async function startFixtureServerOnHost(root: string, bindHost: string): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    const abs = path.resolve(root, `.${rel}`);
    const inside = abs === root || abs.startsWith(`${root}${path.sep}`);
    if (!inside || !abs.endsWith(".html") || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(fs.readFileSync(abs));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, bindHost, () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("夹具服务没有拿到端口");
  return {
    origin: `http://${bindHost}:${addr.port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

/** 与 `startFixtureServerOnHost(root, "127.0.0.1")` 同形的主帧服务别名。 */
const startFixtureServer = (root: string): Promise<FixtureServer> =>
  startFixtureServerOnHost(root, "127.0.0.1");

/** 轮询浏览器侧真值直到成立（确定性等待，不靠固定 sleep 猜时机）。 */
async function waitForTrue(label: string, check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
}

/** 两帧页面的门禁/池分类证据：frameGateOf 分类 + extractElements 池构成（hosts 直传）。 */
async function poolFacts(pageLike: PageLike, hosts: string[]): Promise<{
  /** false = frameGateOf 返回 null（没有任何帧被排除——免检成立的直接证据；不是 0 allowed）。 */
  gate_present: boolean;
  gate_allowed: number; gate_excluded: number;
  pool_rows: number; pool_by_frame: Record<string, number>;
}> {
  const gate = frameGateOf(pageLike, hosts);
  const pool = await extractElements(pageLike, true, 200, { hosts });
  const byFrame: Record<string, number> = {};
  for (const row of Object.values(pool)) {
    const f = String(typeof row.frame === "number" ? row.frame : 0);
    byFrame[f] = (byFrame[f] ?? 0) + 1;
  }
  return {
    gate_present: gate !== null,
    gate_allowed: gate ? gate.allowed.length : 0,
    gate_excluded: gate ? gate.excluded.length : 0,
    pool_rows: Object.keys(pool).length,
    pool_by_frame: byFrame,
  };
}

/* ------------------------------------------------------------------ 集成场景 */

interface IntegrationResult {
  id: string;
  ok: boolean;
  detail: string;
}

/** ② 现状不反转：127.0.0.1 声明 + 127.0.0.2 iframe（?child= 动态注入绝对 URL）→ 仍排除。 */
async function integrationExcluded(session: BrowserSession): Promise<IntegrationResult> {
  const child = await startFixtureServerOnHost(PORT_DIR, "127.0.0.2");
  const host = await startFixtureServer(PORT_DIR);
  try {
    const pageLike = session.page as unknown as PageLike;
    // host.html 的 iframe 默认相对 src（= 同 hostname 同端口，是免检面）；跨注册域对照
    // 必须 ?child= 动态注入 127.0.0.2 的绝对 origin（端口写死会撞随机端口）。
    await session.page.goto(
      `${host.origin}/host.html?child=${encodeURIComponent(child.origin + "/port-child.html")}`,
      { waitUntil: "load", timeout: 30_000 },
    );
    await waitForTrue("跨 hostname iframe 载入（帧数 ≥2）", async () => framesOf(pageLike).length >= 2);
    const frames = framesOf(pageLike);
    const childOrigin = await frames[1]!.evaluate("location.origin") as string;
    const facts = await poolFacts(pageLike, ["127.0.0.1"]);
    const ok = childOrigin.startsWith("http://127.0.0.2:")
      && facts.gate_excluded === 1 && facts.gate_allowed === 1
      && (facts.pool_by_frame["1"] ?? 0) === 0 && (facts.pool_by_frame["0"] ?? 0) > 0;
    return {
      id: "integrated-cross-registration-still-excluded",
      ok,
      detail: `childOrigin=${childOrigin}；gate allowed=${facts.gate_allowed} excluded=${facts.gate_excluded}；池 perFrame=${JSON.stringify(facts.pool_by_frame)}（期望帧 0 有行、帧 1 为 0）`,
    };  } finally {
    await child.close();
    await host.close();
  }
}

/**
 * ③ 集成断言：同 hostname 不同端口（127.0.0.1:PORT_A 主帧 + 127.0.0.1:PORT_B iframe）
 * → 进池且贯通抽到帧内元素。它钉「端口不参与帧判定」（`hostMatchesEnv` 语义在集成面的
 * 保持）；「免检谓词是放行原因」的核心反证由边界表第 3 条（声明 `www.google.com` +
 * 帧 `ogs.google.com`——信封不放过、只有免检放它）承担：反证期禁用免检时该边界红、
 * 本集成不变绿不变红（信封独立放行）。用 70 按钮主帧 + act 默认 64 帽：子帧按钮能在
 * 池里数出来，才证明"帧被放行且抽到了帧内元素"。
 */
async function integrationSameHostDifferentPort(session: BrowserSession): Promise<IntegrationResult> {
  const child = await startFixtureServerOnHost(PORT_DIR, "127.0.0.1");   // iframe 的 PORT_B
  const host = await startFixtureServer(PORT_DIR);                        // 主帧的 PORT_A
  try {
    const pageLike = session.page as unknown as PageLike;
    // host.html 用 ?child=<绝对 origin> 让唯一的 iframe 指到另一个端口（相对 src 只会同端口）。
    await session.page.goto(
      `${host.origin}/main-70.html?child=${encodeURIComponent(`${child.origin}/child-dialog.html`)}`,
      { waitUntil: "load", timeout: 30_000 },
    );
    await waitForTrue("异端口 iframe 的 Cancel/Sign In 就绪", async () => {
      const frames = framesOf(pageLike);
      if (frames.length < 2) return false;
      const childButtons = await frames[1]!.evaluate(
        "Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim())",
      ) as unknown;
      return Array.isArray(childButtons) && CHILD_BUTTONS.every((l) => childButtons.includes(l));
    });
    const facts = await poolFacts(pageLike, ["127.0.0.1"]);
    const childRows = facts.pool_by_frame["1"] ?? 0;
    // 全免检时 frameGateOf 返回 null（= 没有帧被排除）——那是免检成立的直接证据，不是 0 allowed。
    const ok = facts.gate_present === false && facts.gate_excluded === 0
      && (facts.pool_by_frame["0"] ?? 0) > 0 && childRows > 0;
    return {
      id: "integrated-same-host-different-port-exempt",
      ok,
      detail: `gate present=${facts.gate_present} excluded=${facts.gate_excluded}；池 perFrame=${JSON.stringify(facts.pool_by_frame)}（期望两帧都有行、无排除）`,
    };
  } finally {
    await child.close();
    await host.close();
  }
}

/* ------------------------------------------------------------------ 输出 */

interface Evidence {
  lane: "verify-frame-exempt";
  schema_version: number;
  boundary_cases: Array<{ declared: string; frame_host: string; expect: string; ok: boolean }>;
  integrations: IntegrationResult[];
  ok: boolean;
}

function renderHuman(evidence: Evidence): string {
  const lines = [
    "verify-frame-exempt（非门禁证据 lane：帧门禁同主域免检口径；纯函数边界表 + 本地 fixture 集成）",
    ...evidence.boundary_cases.map((c) => `  边界 ${c.declared} + ${c.frame_host} → ${c.expect} ${c.ok ? "✓" : "✗"}`),
    ...evidence.integrations.map((r) => `  集成 ${r.id}: ${r.ok ? "✓" : "✗"}（${r.detail}）`),
    `断言 ${evidence.boundary_cases.filter((c) => c.ok).length}/${evidence.boundary_cases.length} 边界 + ${evidence.integrations.filter((r) => r.ok).length}/${evidence.integrations.length} 集成`,
    evidence.ok ? "OK" : "FAIL",
  ];
  return lines.join("\n");
}

function frameHostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

async function run(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const wantJson = argv.includes("--json");
  const headful = argv.includes("--headful");
  const log = (line: string): void => { (wantJson ? console.error : console.log)(line); };
  for (const rel of ["host.html", "port-child.html", "main-70.html", "child-dialog.html"]) {
    if (!fs.existsSync(path.join(PORT_DIR, rel))) {
      console.error(`verify-frame-exempt: 夹具缺失 fixtures/engine/frames-port/${rel}`);
      return 1;
    }
  }
  const boundaryProblems = boundaryAssertions();
  const cases = boundaryCases();
  // ok 按「边界行自己有没有被点名」判——problems 数组还含表外的追加断言（主帧短路/缺省/about:blank），
  // 按下标对齐会把追加断言的失败错标到第一行边界上。
  const boundary = cases.map((c) => ({
    declared: c.declared, frame_host: frameHostOf(c.frameUrl),
    expect: c.exempt ? "免检" : "排除",
    ok: !boundaryProblems.some((p) => p.includes(`「${c.declared} + ${c.frameUrl}」`)),
  }));
  for (const p of boundaryProblems) log(`boundary FAIL: ${p}`);
  if (boundaryProblems.length > 0 && !wantJson) {
    // 纯函数面红就足以判红，但集成面仍跑（新行为的核心断言必须每次真跑取证）。
  }

  let session: BrowserSession | null = null;
  let integrations: IntegrationResult[] = [];
  try {
    session = await browserSession(!headful);
    integrations.push(await integrationExcluded(session));
    log(`集成 ①（跨注册域仍排除）：${integrations[0]!.ok ? "绿" : "红"} ${integrations[0]!.detail}`);
    integrations.push(await integrationSameHostDifferentPort(session));
    log(`集成 ②（同 hostname 异端口免检）：${integrations[1]!.ok ? "绿" : "红"} ${integrations[1]!.detail}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`verify-frame-exempt: ${message}`);
    if (!wantJson) log("环境/工具失败——chromium 缺失先跑：npx playwright install chromium（诊断：npm run doctor）");
    integrations.push({ id: "environment", ok: false, detail: message });
  } finally {
    if (session !== null) { try { await session.close(); } catch { /* 关闭失败不覆盖主结果 */ } }
  }
  const ok = boundaryProblems.length === 0 && integrations.every((r) => r.ok);
  const evidence: Evidence = {
    lane: "verify-frame-exempt",
    schema_version: 1,
    boundary_cases: boundary,
    integrations,
    ok,
  };
  if (wantJson) console.log(JSON.stringify(evidence, null, 2));
  else console.log(renderHuman(evidence));
  return ok ? 0 : 1;
}

process.exitCode = await run();
