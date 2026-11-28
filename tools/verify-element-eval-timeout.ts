/**
 * verify-element-eval-timeout —— 元素级只读求值的**限时自证** lane（非门禁）。
 *
 * 为什么有这条 lane：`locator.evaluate` 不传 `options.timeout` 时吃 Playwright 默认
 * `DEFAULT_PLAYWRIGHT_TIMEOUT = 3e4`。动作后的取证读取（面板正文 / hit-test / 锁身份复核）
 * 常常发生在元素**已把自己卸载**之后（点击关弹层、React 重渲染换节点），于是"读不到"要等满
 * 30s 才抛，调用方再 `catch` 成 null —— 表现为"这一步慢了 30 秒但结果正确"，
 * 事后完全无法与"页面真的慢"区分。
 *
 * 现场证据（本仓 pilot 轨迹）：150 次驾驶动作里 15 次耗时恰好 30.6s，合计占动作总时间 94%，
 * 且这 15 次 `changed` 全部为 true —— 目标都是"点完即关面板"的按钮。
 *
 * 本 lane 断言四条不变量（全部离线、无头 chromium、零模型、零外部请求）：
 *   1. 正常元素的面板取证是毫秒级（限时不把快路径拖慢）；
 *   2. **目标在读取前被卸载**时，`snapshot(page, scope)` 在约定窗口内返回（不再等 30s）；
 *   3. 卸载后的取证两键如实（`snapshot_scope` 退回 document、不造假文本）；
 *   4. `actOnce` 点击"点完即卸载自己"的按钮仍然成功（限时不改变动作语义），
 *      且整步耗时落在窗口内。
 *
 * 用法：node --experimental-strip-types tools/verify-element-eval-timeout.ts
 * 退出码：0 全 PASS / 1 任一断言失败 / 2 环境错误（chromium 缺失等）。
 */
import http from "node:http";
import { buildMiddleware } from "../src/app/middleware-factory.ts";
import { browserSession } from "../src/engine/executor.ts";
import type { AnyPage } from "../src/engine/executor-types.ts";
import { installDecisionProvider } from "../src/model/decision-provider.ts";
import { installLayaRuntime } from "../src/model/model.ts";

/** 约定窗口：限时 1500ms + 页面往返余量。超过它 = 退回 Playwright 默认 30s。 */
const BOUND_MS = 4000;

const PAGE = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>eval-timeout</title></head>
<body>
  <main>
    <div id="panel"><p>面板正文 STABLE_PANEL_TEXT</p></div>
    <button id="self-destruct" type="button">Done</button>
    <button id="stable" type="button">稳定按钮</button>
  </main>
  <script>
    document.getElementById('self-destruct').addEventListener('click', function () {
      // 真实站点的形态：点击后把按钮自己（连同所在面板）从 DOM 摘掉。
      this.remove();
    });
  </script>
</body></html>`;

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

async function main(): Promise<number> {
  installLayaRuntime(null);
  installDecisionProvider(null);
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") return 2;
  const origin = `http://127.0.0.1:${addr.port}`;
  let session: Awaited<ReturnType<typeof browserSession>> | null = null;
  try {
    session = await browserSession(true);
    const page: AnyPage = session.page;
    await page.goto(`${origin}/x.html`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const mw = buildMiddleware({
      face: "session",
      confirmPolicy: { kind: "default-deny" },
      options: { hosts: ["127.0.0.1"], maxSteps: 1, gotoTimeout: 15_000 },
    });

    // ---- ① 快路径：正常元素的面板取证是毫秒级（限时不拖慢常规读取）
    const panelLoc = await mw.snapshot(page, page.locator("#panel") as never);
    const panelMs = 0;   // 计时见下（snapshot 已返回，单独重测一次读面）
    void panelMs;
    const t1 = Date.now();
    const okSnap = await mw.snapshot(page, page.locator("#panel") as never);
    const fastMs = Date.now() - t1;
    check("① 正常元素面板取证是毫秒级", fastMs < 1000, `${fastMs}ms`);
    check("① 快路径读到真实面板文本（限时不改变语义）",
      okSnap.text.includes("STABLE_PANEL_TEXT"), `scope=${okSnap.snapshot_scope} chars=${okSnap.text.length}`);
    check("① 快路径 scope 仍是 element", okSnap.snapshot_scope === "element", okSnap.snapshot_scope);
    void panelLoc;

    // ---- ②③ 目标在读取前被卸载：snapshot 必须限时返回，且两键如实
    const goneLoc = page.locator("#self-destruct");
    await page.evaluate(() => {
      const el = (globalThis as unknown as { document: { getElementById: (s: string) => { remove: () => void } | null } })
        .document.getElementById("self-destruct");
      if (el !== null) el.remove();
    });
    const t2 = Date.now();
    const goneSnap = await mw.snapshot(page, goneLoc as never);
    const goneMs = Date.now() - t2;
    check("② 元素已卸载时 snapshot 在窗口内返回（不等 30s 默认超时）",
      goneMs < BOUND_MS, `${goneMs}ms（窗口 ${BOUND_MS}ms）`);
    check("③ 卸载后 snapshot_scope 如实退回 document（不假称 element）",
      goneSnap.snapshot_scope === "document", goneSnap.snapshot_scope);
    check("③ 卸载后不造假面板文本（scoped 读不到就走整页口径）",
      goneSnap.text.includes("STABLE_PANEL_TEXT"), `chars=${goneSnap.text.length}`);

    // ---- ④ 动作语义不变：点击"点完即卸载自己"的按钮仍然成功，且整步限时
    // 重新载入（上一段把按钮删了）
    await page.goto(`${origin}/x.html`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const t3 = Date.now();
    const out = await mw.actOnce(page, "Done", "click", null, "fail", undefined,
      { occlusionProbe: true, diagnostics: true });
    const actMs = Date.now() - t3;
    check("④ 点完即卸载自己的按钮点击仍成功（限时不改动作语义）",
      out.ok === true && out.changed === true, `ok=${String(out.ok)} changed=${String(out.changed)} stopCode=${String(out.stopCode ?? "-")}`);
    check("④ 整步耗时落在窗口内（含动作后取证）", actMs < BOUND_MS, `${actMs}ms`);

    // ---- ⑤ 稳定目标不受影响（对照组：证明限时只作用于读不到的情形）
    const t4 = Date.now();
    const stable = await mw.actOnce(page, "稳定按钮", "click", null, "fail", undefined,
      { occlusionProbe: true, diagnostics: true });
    const stableMs = Date.now() - t4;
    check("⑤ 稳定目标点击正常且明显快于窗口", stable.ok === true && stableMs < 2000,
      `ok=${String(stable.ok)} ${stableMs}ms`);
  } catch (err) {
    console.error(`verify-element-eval-timeout: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  } finally {
    if (session !== null) await session.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
  console.log(failures === 0 ? "verify-element-eval-timeout: OK" : `verify-element-eval-timeout: ${failures} FAILED`);
  return failures === 0 ? 0 : 1;
}

process.exit(await main());
