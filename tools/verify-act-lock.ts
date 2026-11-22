/**
 * verify-act-lock —— 决策 ref 执行锁（`actOnce` 的 `opts.lock`）的**离线自证** lane（非门禁）。
 *
 * 定位：本地静态页 + 无头 chromium + `BrowserMiddleware` 直驱，零模型、零外部请求
 * （只连 127.0.0.1 上自己起的静态服务）。回答一个具体问题：决策面按**池 ref** 选中的元素，
 * 执行面能不能按同一身份直接动作，而不是把 ref 还原成 label 再解析一次。
 *
 * 场景（页面两枚同 label 按钮 `4.5`，click 处理器把各自 `data-id` 追加进 `#log`）：
 *   1. 抽池拿到两枚候选的不同 ref；
 *   2. 无锁解析 → `target_ambiguous` 且零动作（既有语义）；
 *   3. 带锁执行第二枚 → `ok` / `resolved_via:"ref-lock"` / `#log` 只记 B；
 *   4. stale 锁（第二枚已从 DOM 移除，旧 pool/ref/sig 原样带上）→ 锁不冒充命中：
 *      **硬断言**用第二枚的唯一身份 `[data-test=pick-b]` 作 target（锁失效后既有链 miss、
 *      零点击）；同一状态下 `target:"4.5"` 只作**信息性**观察——B 移除后池里只剩 A，既有
 *      `actOnce` 语义会按 label 唯一命中并点击 A；那是既有解析链的行为，不是锁的承诺。
 *
 * 锁的承诺只有一条：**元素还活着且身份（esig + 活章）相符时按决策 ref 执行；否则退回既有
 * 解析链，绝不按位置序/data-test 别名猜测执行**。stale 回退的语义完全等于既有 `actOnce`。
 *
 * 用法：node --experimental-strip-types tools/verify-act-lock.ts
 * 退出码：0 全 PASS / 1 任一断言失败 / 2 环境错误（chromium 缺失等）。
 */
import http from "node:http";
import { buildMiddleware } from "../src/app/middleware-factory.ts";
import { esig, type ElemPool } from "../src/engine/extraction.ts";
import { browserSession } from "../src/engine/executor.ts";
import type { AnyPage } from "../src/engine/executor-types.ts";
import { installDecisionProvider } from "../src/model/decision-provider.ts";
import { installLayaRuntime } from "../src/model/model.ts";

/** 两枚同 label 按钮放在不同区域（避开池的"一区域一候选"去重）：header 的 A、footer 的 B。 */
const PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>act lock</title></head>
<body>
  <header><button type="button" data-id="A" data-test="pick-a">4.5</button></header>
  <main><p>act-lock fixture</p><pre id="log"></pre></main>
  <footer><button type="button" data-id="B" data-test="pick-b">4.5</button></footer>
  <script>
    for (const button of document.querySelectorAll("button[data-id]")) {
      button.addEventListener("click", () => {
        document.getElementById("log").textContent += button.dataset.id;
      });
    }
  </script>
</body>
</html>`;

/* ------------------------------------------------------------------ 本地静态服务 */

interface PageServer {
  origin: string;
  close(): Promise<void>;
}

async function startPageServer(): Promise<PageServer> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== "/lock.html") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("本地服务没有拿到端口");
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

/* ------------------------------------------------------------------ 页面/池读数 */

/** 页面 `#log` 的当前内容（click 处理器追加 `data-id`；空串 = 一次都没点）。 */
async function logText(page: AnyPage): Promise<string> {
  return String(await page.evaluate(() => {
    const g = globalThis as unknown as {
      document: { getElementById(id: string): { textContent: string | null } | null };
    };
    return g.document.getElementById("log")?.textContent ?? "";
  }));
}

/** 抽一次池（与决策面同一入口），返回 ref → 元素。 */
async function extractPool(mw: ReturnType<typeof buildMiddleware>, page: AnyPage): Promise<ElemPool> {
  const { elems } = await mw._extractPoolSettled(page, "bucketed");
  return elems;
}

/** 按 `data-test` 找池内 ref（两枚按钮靠它区分身份，不依赖池编号顺序）。 */
function refOfDataTest(elems: ElemPool, dataTest: string): string | null {
  for (const [ref, el] of Object.entries(elems)) {
    if (el.data_test === dataTest) return ref;
  }
  return null;
}

/* ------------------------------------------------------------------ 断言记账 */

let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

/* ------------------------------------------------------------------ 主流程 */

async function main(): Promise<number> {
  // 零模型：规则/声明面都没有决策票；本 lane 只碰解析与执行。
  installLayaRuntime(null);
  installDecisionProvider(null);

  const server = await startPageServer();
  let session: Awaited<ReturnType<typeof browserSession>> | null = null;
  try {
    try {
      session = await browserSession(true);
    } catch (err) {
      console.error(`verify-act-lock: 启动无头 chromium 失败：${err instanceof Error ? err.message : String(err)}`);
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
    await page.goto(`${server.origin}/lock.html`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const mw = buildMiddleware({
      face: "session",
      confirmPolicy: { kind: "default-deny" },
      options: { hosts: ["127.0.0.1"], maxSteps: 1, gotoTimeout: 15_000 },
    });

    // ---- 1. 抽池：两枚同 label 候选各自一个不同 ref ---------------------------
    const elems = await extractPool(mw, page);
    const refA = refOfDataTest(elems, "pick-a");
    const refB = refOfDataTest(elems, "pick-b");
    check(
      "抽池：两枚同 label 候选进池且 ref 不同",
      refA !== null && refB !== null && refA !== refB,
      `pool=${Object.keys(elems).length} a=${String(refA)} b=${String(refB)}`,
    );
    if (refA === null || refB === null) {
      console.error("verify-act-lock: 池里没有两枚同 label 按钮，后续断言无法进行（夹具/准入面异常）");
      return 1;
    }

    // ---- 2. 无锁：既有解析链按 label 判歧义、零动作 ---------------------------
    const bare = await mw.actOnce(page, "4.5", "click", null, "fail");
    const logAfterBare = await logText(page);
    check(
      "无锁解析 → target_ambiguous 且零动作",
      bare.ok === false && bare.stopCode === "target_ambiguous" && logAfterBare === "",
      `ok=${String(bare.ok)} stopCode=${String(bare.stopCode)} log=${JSON.stringify(logAfterBare)}`,
    );

    // ---- 3. 带锁：按决策 ref 执行第二枚（锁必须在重新抽池前生效）-------------
    // 锁必须与抽池同一轮：上一步的既有解析会重抽池并清掉旧 `data-dshref` 章，所以这里
    // 重新抽一次池，紧接着带锁执行——模拟驾驶面"这一轮抽池 → 这一轮投票 → 执行"的时序。
    const pool = await extractPool(mw, page);
    const refB2 = refOfDataTest(pool, "pick-b");
    const elB2 = refB2 === null ? undefined : pool[refB2];
    if (refB2 === null || elB2 === undefined) {
      check("带锁执行第二枚", false, "重新抽池后找不到 data-test=pick-b，无法构造锁");
      return 1;
    }
    const locked = await mw.actOnce(page, "4.5", "click", null, "fail", undefined, {
      lock: { pool, ref: refB2, sig: esig(elB2) },
    });
    const logAfterLock = await logText(page);
    check(
      "带锁执行第二枚 → ok / resolved_via=ref-lock / #log 只记 B",
      locked.ok === true && locked.resolved_via === "ref-lock" && logAfterLock === "B",
      `ok=${String(locked.ok)} resolved_via=${String(locked.resolved_via)} ref=${String(locked.ref)} log=${JSON.stringify(logAfterLock)}`,
    );

    // ---- 4. stale 锁：第二枚已从 DOM 移除，锁不得冒充命中 --------------------
    await page.evaluate(() => {
      const g = globalThis as unknown as {
        document: { querySelector(selector: string): { remove(): void } | null };
      };
      g.document.querySelector("button[data-test='pick-b']")?.remove();
    });
    const staleLock = { pool, ref: refB2, sig: esig(elB2) };
    // 硬断言用第二枚的唯一身份作 target：锁失效后既有链 miss、零点击——证明锁没有按
    // 位置序/data-test 别名把 A 当成 B 执行。
    const stale = await mw.actOnce(page, "[data-test=pick-b]", "click", null, "fail", undefined, {
      lock: staleLock,
    });
    const logAfterStale = await logText(page);
    check(
      "stale 锁（元素已移除）→ 不冒充 ref-lock / 不崩 / miss / 零点击",
      stale.resolved_via !== "ref-lock" && stale.ok === false
        && stale.stopCode === "target_not_found" && logAfterStale === "B",
      `ok=${String(stale.ok)} stopCode=${String(stale.stopCode)} resolved_via=${String(stale.resolved_via)} log=${JSON.stringify(logAfterStale)}`,
    );

    // ---- 信息性观察（不判 PASS/FAIL）：stale 回退 = 既有 actOnce 语义 ---------
    // 同一状态下换回 label target：池里只剩 A，既有链按唯一命中点击 A。这是既有解析链的
    // 行为，不是锁的承诺——锁只保证"不按 stale 身份执行"，不保证"回退后不再动作"。
    const fallback = await mw.actOnce(page, "4.5", "click", null, "fail");
    const logAfterFallback = await logText(page);
    console.log(
      `INFO stale 回退（target="4.5"，池里只剩 A）：` +
      `ok=${String(fallback.ok)} stopCode=${String(fallback.stopCode)} ` +
      `resolved_via=${String(fallback.resolved_via)} ref=${String(fallback.ref)} ` +
      `log=${JSON.stringify(logAfterFallback)}（既有 actOnce 语义；ref-lock 未参与）`,
    );

    // ---- 自证：本 lane 不联网 -------------------------------------------------
    check("零外部请求（只连本机静态页）", external.length === 0, external.slice(0, 3).join(", "));

    if (failures === 0) {
      console.log("verify-act-lock: OK — 锁命中/stale 回退/既有歧义三条路径均符合契约（零模型，零外部请求）");
      return 0;
    }
    console.error(`verify-act-lock: FAIL — ${failures} 条断言未通过`);
    return 1;
  } finally {
    if (session !== null) await session.close();
    await server.close();
  }
}

process.exitCode = await main();
