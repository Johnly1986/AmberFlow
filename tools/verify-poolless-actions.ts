/**
 * verify-poolless-actions —— 池外回退面**单动作分派**的自证 lane（非门禁）。
 *
 * 定位：本地静态夹具（`fixtures/engine/poolless/`）+ 无头 chromium + `BrowserMiddleware.actOnce`
 * 直驱，零模型、零外部请求（只连 127.0.0.1 上自己起的静态服务）。回答一个具体问题：
 * 解析面只能给出 locator（`el === null`：`#id` live-DOM 直查 / A3 DOM 回退合成行）时，
 * fill/select/hover 会不会被执行成一次点击。
 *
 * 夹具里 `#target`（input）与 `#pick`（select）都在准入面内，但被池构成规则剔出池
 * （空名子 / 同 label 子让位）——它们只存在于 DOM，`#id` 只能经池外回退解析；`[name=q]`
 * 只能经 A3 DOM 回退面的合成行命中（要求合成行与池行同样投影 `name`）。
 *
 * 断言（每条 = 一次真实页面动作 + 页面事实读数）：
 *   A. 池外 `#target` fill → `how:"filled"`、inputValue 真的写入、事件日志没有 click；
 *   B. `[name=q]` A3 回退命中并填值（合成 ref `pN`），不得误 click；
 *   C. 池外 `#target` click 仍 `clicked`（既有行为回归），click 事件真的到达目标；
 *   D. 池外 `#pick` select → `filled` 且选中值写入（同为 el===null 分派）；
 *   E. 池外 `#target` hover → `hovered`，不点击、日志不变；
 *   F. 不支持的 op（drag）→ 结构化 `action_unsupported`，零动作（绝不退化成点击）；
 *   G. 池内成功路径（`#pool-btn` click）行为不变（不走回退分派）。
 *
 * 用法：node --experimental-strip-types tools/verify-poolless-actions.ts
 * 退出码：0 全 PASS / 1 任一断言失败 / 2 环境错误（chromium 缺失等）。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { buildMiddleware } from "../src/app/middleware-factory.ts";
import { browserSession } from "../src/engine/executor.ts";
import type { AnyPage } from "../src/engine/executor-types.ts";
import { installDecisionProvider } from "../src/model/decision-provider.ts";
import { installLayaRuntime } from "../src/model/model.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(REPO, "fixtures", "engine", "poolless");
const PAGE_PATH = "/index.html";

/* ------------------------------------------------------------------ 本地静态服务 */

interface PageServer {
  origin: string;
  close(): Promise<void>;
}

/** 只服务 `fixtures/engine/poolless/` 下 .html 的本地服务（随机端口、绑 127.0.0.1）。 */
async function startPageServer(): Promise<PageServer> {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    const abs = path.resolve(FIXTURES, `.${rel}`);
    const inside = abs === FIXTURES || abs.startsWith(`${FIXTURES}${path.sep}`);
    if (!inside || !fs.existsSync(abs) || !fs.statSync(abs).isFile() || !abs.endsWith(".html")) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(fs.readFileSync(abs));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("夹具服务没有拿到端口");
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

/* ------------------------------------------------------------------ 页面事实读数 */

type MwLike = ReturnType<typeof buildMiddleware>;

/** `#target` 的当前值（真值读回，不信任动作返回值）。 */
async function inputValue(page: AnyPage): Promise<string> {
  return String(await page.evaluate(() => {
    const g = globalThis as unknown as {
      document: { getElementById(id: string): { value?: string } | null };
    };
    return g.document.getElementById("target")?.value ?? "";
  }));
}

/** `#pick` 的当前值。 */
async function selectValue(page: AnyPage): Promise<string> {
  return String(await page.evaluate(() => {
    const g = globalThis as unknown as {
      document: { getElementById(id: string): { value?: string } | null };
    };
    return g.document.getElementById("pick")?.value ?? "";
  }));
}

/** 夹具的事件日志（点击 / 输入 / 选中 / 池内按钮点击的 token 串）。 */
async function logText(page: AnyPage): Promise<string> {
  return String(await page.evaluate(() => {
    const g = globalThis as unknown as {
      document: { getElementById(id: string): { textContent: string | null } | null };
    };
    return g.document.getElementById("log")?.textContent ?? "";
  }));
}

/** 元素在页面上的可见盒事实（池外回退只认可见目标；这里用于前置证明）。 */
async function visibleBox(page: AnyPage, id: string): Promise<{ width: number; height: number }> {
  const box = await page.evaluate((elId: string) => {
    const g = globalThis as unknown as {
      document: { getElementById(id: string): { getBoundingClientRect(): { width: number; height: number } } | null };
    };
    const el = g.document.getElementById(elId);
    if (el === null) return { width: 0, height: 0 };
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }, id) as { width: number; height: number } | null;
  return box ?? { width: 0, height: 0 };
}

/** 抽一次池（与解析面同一入口），返回 { ref → id } 与池大小。 */
async function poolIds(mw: MwLike, page: AnyPage): Promise<{ ids: Set<string>; size: number }> {
  const { elems } = await mw._extractPoolSettled(page, "bucketed");
  const ids = new Set<string>();
  for (const el of Object.values(elems)) {
    if (typeof el.id === "string" && el.id !== "") ids.add(el.id);
  }
  return { ids, size: Object.keys(elems).length };
}

/* ------------------------------------------------------------------ 断言记账 */

let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

function info(label: string, detail: string): void {
  console.log(`INFO ${label} — ${detail}`);
}

/* ------------------------------------------------------------------ 主流程 */

async function main(): Promise<number> {
  // 零模型：本 lane 只碰解析与执行，不产生任何决策票。
  installLayaRuntime(null);
  installDecisionProvider(null);

  const server = await startPageServer();
  let session: Awaited<ReturnType<typeof browserSession>> | null = null;
  try {
    try {
      session = await browserSession(true);
    } catch (err) {
      console.error(`verify-poolless-actions: 启动无头 chromium 失败：${err instanceof Error ? err.message : String(err)}`);
      console.error("  补齐环境：npm ci && npx playwright install chromium；体检：npm run doctor");
      return 2;
    }
    const page = session.page;
    const external: string[] = [];
    (page as unknown as { on(event: string, cb: (req: { url(): string }) => void): void }).on("request", (req) => {
      const url = req.url();
      if (url.startsWith(server.origin) || url.startsWith("data:") || url === "about:blank") return;
      external.push(url);
    });
    await page.goto(`${server.origin}${PAGE_PATH}`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const mw = buildMiddleware({
      face: "session",
      confirmPolicy: { kind: "default-deny" },
      options: { hosts: ["127.0.0.1"], maxSteps: 1, gotoTimeout: 15_000 },
    });

    // ---- 0. 前置事实：目标可见 #id / [name=q]，但都不在池内 ---------------------
    const targetBox = await visibleBox(page, "target");
    const pickBox = await visibleBox(page, "pick");
    const pool = await poolIds(mw, page);
    info("池构成", `pool_size=${pool.size} ids=[${[...pool.ids].sort().join(",")}]`);
    check(
      "前置：`#target` 可见但被剔出池（池外回退可达）",
      targetBox.width > 0 && targetBox.height > 0 && !pool.ids.has("target"),
      `box=${targetBox.width}x${targetBox.height} in_pool=${pool.ids.has("target")}`,
    );
    check(
      "前置：`#pick` 可见但被剔出池（池外回退可达）",
      pickBox.width > 0 && pickBox.height > 0 && !pool.ids.has("pick"),
      `box=${pickBox.width}x${pickBox.height} in_pool=${pool.ids.has("pick")}`,
    );

    // ---- A. 池外 #id fill：必须真正填值，不得变成 click -------------------------
    const caseA = await mw.actOnce(page, "#target", "fill", { value: "hello" });
    const aValue = await inputValue(page);
    const aLog = await logText(page);
    info("A 结果", `ok=${String(caseA.ok)} how=${String(caseA.how)} ref=${String(caseA.ref)} `
      + `resolved_via=${String(caseA.resolved_via)} value=${JSON.stringify(aValue)} log=${JSON.stringify(aLog)}`);
    check("A：池外 `#target` fill → how=filled（不得 clicked）",
      caseA.ok === true && caseA.how === "filled", `ok=${String(caseA.ok)} how=${String(caseA.how)}`);
    check("A：fill 的值真正写入（inputValue=hello）", aValue === "hello", `value=${JSON.stringify(aValue)}`);
    check("A：fill 没有触发一次 click", !aLog.includes("input-click"), `log=${JSON.stringify(aLog)}`);
    check("A：解析通道 = live-dom-id-fallback（`#id` 直查）",
      caseA.resolved_via === "live-dom-id-fallback", `resolved_via=${String(caseA.resolved_via)}`);

    // ---- B. `[name=q]`：只能经 A3 DOM 回退合成行命中并填值 ----------------------
    const caseB = await mw.actOnce(page, "[name=q]", "fill", { value: "world" });
    const bValue = await inputValue(page);
    const bLog = await logText(page);
    info("B 结果", `ok=${String(caseB.ok)} how=${String(caseB.how)} ref=${String(caseB.ref)} `
      + `stopCode=${String(caseB.stopCode)} value=${JSON.stringify(bValue)} log=${JSON.stringify(bLog)}`);
    check("B：`[name=q]` 池外回退命中并填值（how=filled / value=world）",
      caseB.ok === true && caseB.how === "filled" && bValue === "world",
      `ok=${String(caseB.ok)} how=${String(caseB.how)} value=${JSON.stringify(bValue)} stopCode=${String(caseB.stopCode)}`);
    check("B：走的是 A3 合成池（ref 形如 pN，不是池 ref eN）",
      typeof caseB.ref === "string" && /^p\d+$/.test(caseB.ref), `ref=${String(caseB.ref)}`);
    check("B：没有误 click", !bLog.includes("input-click"), `log=${JSON.stringify(bLog)}`);

    // ---- C. 池外 click 仍 clicked（回归） --------------------------------------
    const caseC = await mw.actOnce(page, "#target", "click");
    const cLog = await logText(page);
    info("C 结果", `ok=${String(caseC.ok)} how=${String(caseC.how)} ref=${String(caseC.ref)} log=${JSON.stringify(cLog)}`);
    check("C：池外 `#target` click 仍 clicked（回归）",
      caseC.ok === true && caseC.how === "clicked", `ok=${String(caseC.ok)} how=${String(caseC.how)}`);
    check("C：click 事件真的到达目标", cLog.includes("input-click"), `log=${JSON.stringify(cLog)}`);

    // ---- D. 池外 #id select：按值选中，不得变成 click --------------------------
    const caseD = await mw.actOnce(page, "#pick", "select", { value: "blue" });
    const dValue = await selectValue(page);
    const dLog = await logText(page);
    info("D 结果", `ok=${String(caseD.ok)} how=${String(caseD.how)} ref=${String(caseD.ref)} `
      + `resolved_via=${String(caseD.resolved_via)} value=${JSON.stringify(dValue)} log=${JSON.stringify(dLog)}`);
    check("D：池外 `#pick` select → how=filled 且选中 blue",
      caseD.ok === true && caseD.how === "filled" && dValue === "blue",
      `ok=${String(caseD.ok)} how=${String(caseD.how)} value=${JSON.stringify(dValue)} stopCode=${String(caseD.stopCode)}`);

    // ---- E. 池外 #id hover：只移动指针，不点击 --------------------------------
    const logBeforeHover = await logText(page);
    const caseE = await mw.actOnce(page, "#target", "hover");
    const logAfterHover = await logText(page);
    info("E 结果", `ok=${String(caseE.ok)} how=${String(caseE.how)} ref=${String(caseE.ref)} `
      + `log=${JSON.stringify(logAfterHover)}`);
    check("E：池外 `#target` hover → how=hovered",
      caseE.ok === true && caseE.how === "hovered", `ok=${String(caseE.ok)} how=${String(caseE.how)}`);
    check("E：hover 不产生点击/输入事件", logAfterHover === logBeforeHover,
      `before=${JSON.stringify(logBeforeHover)} after=${JSON.stringify(logAfterHover)}`);

    // ---- F. 不支持的 op：结构化 stopCode，零动作（绝不退化成 click）-----------
    const valueBeforeF = await inputValue(page);
    const logBeforeF = await logText(page);
    const caseF = await mw.actOnce(page, "#target", "drag", { value: "#color-region" });
    const valueAfterF = await inputValue(page);
    const logAfterF = await logText(page);
    info("F 结果", `ok=${String(caseF.ok)} stopCode=${String(caseF.stopCode)} reason=${String(caseF.reason)}`);
    check("F：池外不支持的 op（drag）→ 结构化 action_unsupported",
      caseF.ok === false && caseF.stopCode === "action_unsupported",
      `ok=${String(caseF.ok)} stopCode=${String(caseF.stopCode)}`);
    check("F：零动作（值/事件日志不变）",
      valueAfterF === valueBeforeF && logAfterF === logBeforeF,
      `value=${JSON.stringify(valueAfterF)} log=${JSON.stringify(logAfterF)}`);

    // ---- G. 池内成功路径回归（el !== null 不走回退分派） ----------------------
    const caseG = await mw.actOnce(page, "#pool-btn", "click");
    const gLog = await logText(page);
    info("G 结果", `ok=${String(caseG.ok)} how=${String(caseG.how)} ref=${String(caseG.ref)} `
      + `resolved_via=${String(caseG.resolved_via)} log=${JSON.stringify(gLog)}`);
    check("G：池内 `#pool-btn` click 行为不变（clicked / 无 resolved_via / 事件到达）",
      caseG.ok === true && caseG.how === "clicked" && caseG.resolved_via === undefined
        && gLog.includes("pool-click"),
      `ok=${String(caseG.ok)} how=${String(caseG.how)} resolved_via=${String(caseG.resolved_via)}`);

    // ---- 自证：本 lane 不联网 -------------------------------------------------
    check("零外部请求（只连本机静态页）", external.length === 0, external.slice(0, 3).join(", "));

    if (failures === 0) {
      console.log("verify-poolless-actions: OK — 池外 fill/select/hover 真实执行、click 回归、"
        + "不支持 op 结构化拒绝（零模型，零外部请求）");
      return 0;
    }
    console.error(`verify-poolless-actions: FAIL — ${failures} 条断言未通过`);
    return 1;
  } finally {
    if (session !== null) await session.close();
    await server.close();
  }
}

process.exitCode = await main();
