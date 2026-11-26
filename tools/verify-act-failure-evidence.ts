/**
 * verify-act-failure-evidence —— act 失败面证据的**离线自证** lane（非门禁）。
 *
 * 定位：本地静态页 + 无头 chromium + `BrowserMiddleware` 直驱，零模型、零外部请求。
 * 回答两个具体问题：
 *   1. **宽扫发放判据**（F87 ③）：被第三方元素遮挡时，失败响应要带 `wide_scan` 且候选里
 *      含遮罩上的可点控件，作者才有替代路径可选；`offscreen` / `zero-size`（处置是滚动/
 *      换目标，不是"视野不够"）与 `stale_ref` 等其余停因一律不发。
 *   2. **落空诊断的轨迹归档**（F72 ③）：`missDiagRecord` 把 pool_size / 候选有界投影出来，
 *      使"写法不对"与"目标不在页"在事后可分；无相近候选时不造键（不补空数组）。
 *
 * 边界事实（不判 PASS/FAIL）：在 DOM 但不可见的目标会被 DRF/身份回捞解析到 locator，
 * 结果是 `action_failed` 而非 `target_not_found` —— 所以 `in_dom_but_not_admitted` 的
 * 触发窗口比字面窄，这里只作 INFO 记录。
 *
 * 用法：node --experimental-strip-types tools/verify-act-failure-evidence.ts
 * 退出码：0 全 PASS / 1 任一断言失败 / 2 环境错误（chromium 缺失等）。
 */
import http from "node:http";
import { actFailureEvidence, missDiagRecord } from "../src/app/session-act-failure-evidence.ts";
import { buildMiddleware } from "../src/app/middleware-factory.ts";
import { browserSession } from "../src/engine/executor.ts";
import type { AnyPage } from "../src/engine/executor-types.ts";
import { installDecisionProvider } from "../src/model/decision-provider.ts";
import { installLayaRuntime } from "../src/model/model.ts";

const PAGE = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>covered</title></head>
<body>
  <main><button type="button" data-test="submit">提交申请</button></main>
  <div id="hidden-panel" style="display:none"><button id="ghost" type="button">幽灵按钮</button></div>
  <div id="banner" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999">
    <button type="button" data-test="consent">同意</button>
  </div>
</body></html>`;

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

/** 反向断言用的 mock 会话面：不抽池、不真开页面（offscreen/zero-size 本就不该走到宽扫）。 */
function mockDeps(): Parameters<typeof actFailureEvidence>[1] {
  return {
    page: { url: () => "https://example.test/" } as unknown as AnyPage,
    target: "t", actOp: "click", req: {}, startedAt: Date.now(), actionCount: 1,
    outDir: "", hosts: null,
    mw: () => ({ overlayEvidence: async () => null }) as never,
    log: () => {}, recentHint: () => ({ diag: {}, reasonLine: "" }), amb: {},
  };
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

    // ---- 正向：被 fixed 背板盖住 → 遮挡停因 + blocker 是真实第三方元素
    const out = await mw.actOnce(page, "提交申请", "click", null, "fail", undefined,
      { occlusionProbe: true, diagnostics: true });
    check("遮挡场景 → not-actionable-or-covered",
      out.ok === false && out.stopCode === "not-actionable-or-covered",
      `ok=${String(out.ok)} stopCode=${String(out.stopCode)}`);
    const blocker = out.actionability?.blocker ?? null;
    check("blocker 是真实第三方元素（非 offscreen/zero-size）",
      typeof blocker === "string" && blocker !== ""
        && blocker !== "offscreen" && blocker !== "zero-size", `blocker=${String(blocker)}`);

    const resp = await actFailureEvidence(out, {
      page, target: "提交申请", actOp: "click", req: {}, startedAt: Date.now(),
      actionCount: 1, outDir: "", hosts: ["127.0.0.1"],
      mw: () => mw, log: () => {},
      recentHint: () => ({ diag: {}, reasonLine: "" }), amb: {},
    });
    const wide = resp["wide_scan"] as { candidates?: Array<{ label?: string }> } | undefined;
    check("遮挡 → 响应带 wide_scan", wide !== undefined, `keys=${Object.keys(resp).join(",")}`);
    const labels = (wide?.candidates ?? []).map((c) => String(c.label ?? ""));
    check("wide_scan 候选里含遮罩上的可点控件（同意）",
      labels.some((l) => l.includes("同意")), `labels=${JSON.stringify(labels.slice(0, 8))}`);

    // ---- 反向：offscreen / zero-size / stale_ref 都不发放
    const off = await actFailureEvidence({
      stopCode: "not-actionable-or-covered", reason: "offscreen",
      actionability: { reason: "offscreen", bbox: null, blocker: "offscreen", requery: "present" },
    }, mockDeps());
    check("offscreen → 不发 wide_scan", off["wide_scan"] === undefined,
      `keys=${Object.keys(off).join(",")}`);

    const zero = await actFailureEvidence({
      stopCode: "not-actionable-or-covered", reason: "zero-size",
      actionability: { reason: "zero-size", bbox: null, blocker: "zero-size", requery: "present" },
    }, mockDeps());
    check("zero-size → 不发 wide_scan", zero["wide_scan"] === undefined,
      `keys=${Object.keys(zero).join(",")}`);

    const stale = await actFailureEvidence({ stopCode: "stale_ref", reason: "stale" }, mockDeps());
    check("stale_ref → 不发 wide_scan", stale["wide_scan"] === undefined,
      `keys=${Object.keys(stale).join(",")}`);

    // ---- C 边界观察（诚实，不作判据）：在 DOM 但不可见的目标会被 DRF/身份回捞解析到
    //      locator，结果是 action_failed 而非 target_not_found。
    const ghost = await mw.actOnce(page, "幽灵按钮", "click", null, "fail", undefined,
      { occlusionProbe: true, diagnostics: true });
    console.log(`INFO 在 DOM 不可见目标 → stopCode=${String(ghost.stopCode)}（回捞接管即 action_failed）`);

    // ---- C：连 DOM 都没有 → target_not_found，且轨迹 diag 有界落盘
    const absent = await mw.actOnce(page, "#definitely-not-here", "click", null, "fail", undefined,
      { occlusionProbe: true, diagnostics: true });
    const absentReason = String(absent.reason ?? "");
    check("完全不存在 → reason 不带 DOM 前置（既有形状不变）",
      absent.ok === false && absent.stopCode === "target_not_found"
        && !absentReason.includes("exists in the DOM"), `reason=${absentReason.slice(0, 110)}`);
    const absentDiag = missDiagRecord(absent.diagnostics);
    check("轨迹 diag 落盘 pool_size（归因可读，不必重跑）",
      typeof absentDiag["pool_size"] === "number", JSON.stringify(absentDiag).slice(0, 160));
    check("无相近候选时 diag 不造键（candidates/near 缺省，不补空数组）",
      absentDiag["candidates"] === undefined && absentDiag["near"] === undefined,
      JSON.stringify(absentDiag).slice(0, 160));
  } catch (err) {
    console.error(`verify-act-failure-evidence: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  } finally {
    if (session !== null) await session.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
  console.log(failures === 0 ? "verify-act-failure-evidence: OK" : `verify-act-failure-evidence: ${failures} FAILED`);
  return failures === 0 ? 0 : 1;
}

process.exit(await main());
