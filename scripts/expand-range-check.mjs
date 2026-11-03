#!/usr/bin/env node
/**
 * expand-range-check.mjs —— A3「列表展开与范围控件原语」离线验证脚本
 *
 * 依据：docs/IMPLEMENTATION-PLAN-TIER-A-v2.md §4.3（测试四项）
 * 依赖：A3（ctx.expand / ctx.scrollList / ctx.setRange 真实实现 + ctx-dry 三方法桩；
 *        引擎侧 range.ts、mw.actOnce / mw.scrollContainer / mw.setRange）。
 *        A1/A2 是 A3 的前置（actOnce 复用其解析与证据面），本脚本不直接断言 A1/A2 字段。
 *
 * 运行（不联网、不调模型）：
 *   node --experimental-strip-types scripts/expand-range-check.mjs
 *
 * 做法：
 *   - 用 page.setContent 构造 DOM，再用 createCtx 装配一个真实 ctx（注入同一 page）；
 *   - 显式 installLayaRuntime(null) + installDecisionProvider(null) ⇒ rules-only，
 *     目标全部由 hint 解析（expand 的按钮 / scrollList 的 listbox / setRange 的控件句柄）；
 *   - 每个方法计 1 个 flow step：用 ctx.budget.stepsUsed 断言计费语义；
 *   - dry 桩用 createDryCtx 直接断言返回结构与确定性（不动作、不开浏览器）。
 *
 * 输出约定：PASS / FAIL（断言名+期望+实际 / 异常信息）/ DEP（依赖未实现）。
 * 退出码：0 全过；2 有依赖未实现（A3 落地后复跑应 0）；1 断言失败。
 *
 * 基线（HEAD 702accc，A3 未落地）预期：全部 DEP（ctx 上还没有 expand/scrollList/setRange）。
 */
import util from "node:util";

import { chromium } from "playwright";
import { createCtx } from "../src/app/ctx.ts";
import { createDryCtx } from "../src/app/ctx-dry.ts";
import { BrowserMiddleware } from "../src/engine/executor.ts";
import { installDecisionProvider } from "../src/model/decision-provider.ts";
import { installLayaRuntime } from "../src/model/model.ts";
import { launchKwargs } from "../src/browser/browser-env.ts";

/* ------------------------------------------------------------------ 断言面 */

const failures = [];
const deps = [];
let passed = 0;

function check(name, cond, expected, actual) {
  if (cond) {
    passed += 1;
    console.log(`[PASS] ${name}`);
    return true;
  }
  const detail = `期望 ${expected}；实际 ${util.inspect(actual, { depth: 5, breakLength: 120 })}`;
  failures.push({ name, detail });
  console.log(`[FAIL] ${name}\n        ${detail}`);
  return false;
}

/** 依赖未实现：打印 DEP 并计入「待复跑」，不算失败。 */
function depend(name, implemented, note) {
  if (implemented) {
    console.log(`[ OK ] ${name}（依赖已就位）`);
    return true;
  }
  deps.push({ name, note });
  console.log(`[DEP ] ${name}：${note}`);
  return false;
}

const newTrace = (app) => ({
  schema_version: 1,
  app,
  script_sha256: "dev-script",
  inputs_sha256: "dev-inputs",
  events: [],
  done: false,
});

/* ------------------------------------------------------------------ 浏览器 */

installLayaRuntime(null);
installDecisionProvider(null);

let browser;
try {
  browser = await chromium.launch(launchKwargs(true));   // headless（本机无显示也能跑）
} catch (e) {
  console.error(`[ENV ] Chromium 启动失败（headless）：${e instanceof Error ? e.message : String(e)}`);
  console.error("       先跑 `npx playwright install chromium` 或检查 PLAYWRIGHT_BROWSERS_PATH。");
  process.exit(2);
}
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const mw = new BrowserMiddleware({ maxSteps: 20, riskAsk: "rules-only" });

/** 装配真实 ctx（注入同一 page；ctx 的方法操作当前页，不导航）。 */
function makeCtx(opts = {}) {
  return createCtx({
    pack: { id: "dev-expand-range", label: "dev", goal: "expand/range 离线验证" },
    slots: {},
    runtime: { outDir: "/tmp/amberflow-dev-scripts", runId: "dev", today: "2026-11-03" },
    ensureSession: async () => ({ pw: { chromium }, browser, page, close: async () => {} }),
    mw: () => mw,
    trace: newTrace("dev-expand-range"),
    maxSteps: opts.maxSteps ?? 10,
    ...opts,
  });
}

console.log("== expand-range-check: A3 expand/scrollList/setRange（离线 page.setContent）==\n");

try {
  /* ================================================================ 用例 1
   * load-more 列表：点击一次追加 10 行（初始 10 行，最多 10 批 = 100 行）。
   * 断言：expand 到 rows=100、clicks 合理、stable=true、coverage 正确、计 1 个 flow step。
   */
  {
    await page.setContent(
      `<!doctype html><html><body>
         <ul id="list"></ul>
         <button id="load-more">Load more</button>
         <script>
           function addRows(n) {
             const ul = document.getElementById('list');
             if (ul.children.length >= 100) return;   // 10 批 × 10 行后封顶，expand 才能判 stable
             for (let i = 0; i < n; i++) {
               const li = document.createElement('li');
               li.textContent = 'Item ' + (ul.children.length + 1);
               ul.appendChild(li);
             }
           }
           document.getElementById('load-more').addEventListener('click', function () { addRows(10); });
         </script>
       </body></html>`,
      { waitUntil: "domcontentloaded" },
    );
    const ctx = makeCtx({ maxSteps: 10 });
    const supportsExpand = typeof ctx.expand === "function";
    depend(
      "A3-1a ctx.expand 存在",
      supportsExpand,
      "ctx 上还没有 expand 方法（依赖 A3 §4.1）",
    );
    if (supportsExpand) {
      const before = await page.evaluate(() => document.querySelectorAll("#list li").length);
      const r = await ctx.expand("Load more", {
        count: { rows: "#list li", fields: { text: "." } },
        settleMs: 150,
        maxClicks: 15,
        stableRounds: 2,
        timeoutMs: 30_000,
      });
      check("A3-1b expand 返回 ok=true", r?.ok === true, true, r);
      check("A3-1c expand 后行数 after=100", r?.after === 100, 100, r?.after);
      check(
        "A3-1d 返回 before 与实际初始行数一致（初始 0 行）",
        r?.before === before && before === 0,
        `before=${before}=0`,
        { beforeReturned: r?.before, beforeActual: before },
      );
      check(
        "A3-1e clicks 合理（10 次有效点击；多出的只允许是稳定轮）",
        typeof r?.clicks === "number" && r.clicks >= 10 && r.clicks <= 15,
        "10 ≤ clicks ≤ 15",
        r?.clicks,
      );
      check("A3-1f grew=true（确实增长过）", r?.grew === true, true, r?.grew);
      check("A3-1g stable=true（连续 stableRounds 轮无增长后停）", r?.stable === true, true, r?.stable);
      check(
        "A3-1h coverage.rows=100",
        r?.coverage?.rows === 100,
        100,
        r?.coverage,
      );
      const finalRows = await page.evaluate(() => document.querySelectorAll("#list li").length);
      check("A3-1i DOM 事实：列表最终 100 行", finalRows === 100, 100, finalRows);
      check(
        "A3-1j expand 计 1 个 flow step（ctx.budget.stepsUsed=1）",
        ctx.budget.stepsUsed === 1,
        1,
        ctx.budget.stepsUsed,
      );
    }
  }

  /* ================================================================ 用例 2
   * 无限滚动容器（role=listbox + overflow-y:auto，内容 2000px）。
   * 断言：scrollList({to:"bottom"}) 到 scrollTop === scrollHeight - clientHeight、moved=true、计 1 步。
   */
  {
    await page.setContent(
      `<!doctype html><html><body>
         <div id="feed" role="listbox" aria-label="Feed list"
              style="height: 200px; overflow-y: auto; border: 1px solid #ccc">
           <div style="height: 2000px">long content</div>
         </div>
       </body></html>`,
      { waitUntil: "domcontentloaded" },
    );
    const ctx = makeCtx({ maxSteps: 10 });
    const supportsScrollList = typeof ctx.scrollList === "function";
    depend(
      "A3-2a ctx.scrollList 存在",
      supportsScrollList,
      "ctx 上还没有 scrollList 方法（依赖 A3 §4.1）",
    );
    if (supportsScrollList) {
      const r = await ctx.scrollList("Feed list", { to: "bottom", settleMs: 50 });
      const dom = await page.evaluate(() => {
        const el = document.getElementById("feed");
        return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      });
      const target = dom.scrollHeight - dom.clientHeight;
      check("A3-2b scrollList 返回 ok=true", r?.ok === true, true, r);
      check(
        "A3-2c scrollList 返回 scrollTop 到达底部（scrollHeight-clientHeight，容差 2）",
        typeof r?.scrollTop === "number" && Math.abs(r.scrollTop - target) <= 2,
        `scrollTop≈${target}`,
        { returned: r?.scrollTop, dom },
      );
      check(
        "A3-2d DOM 事实：scrollTop 到达底部",
        Math.abs(dom.scrollTop - target) <= 2,
        `scrollTop≈${target}`,
        dom,
      );
      check("A3-2e moved=true", r?.moved === true, true, r?.moved);
      check(
        "A3-2f scrollList 计 1 个 flow step（ctx.budget.stepsUsed=1）",
        ctx.budget.stepsUsed === 1,
        1,
        ctx.budget.stepsUsed,
      );
    }
  }

  /* ================================================================ 用例 3a
   * input[type=range]：fill 策略设到 42。
   */
  {
    await page.setContent(
      `<!doctype html><html><body>
         <input id="vol" type="range" aria-label="Volume" min="0" max="100" step="1" value="0">
       </body></html>`,
      { waitUntil: "domcontentloaded" },
    );
    const ctx = makeCtx({ maxSteps: 10 });
    const supportsSetRange = typeof ctx.setRange === "function";
    depend(
      "A3-3a ctx.setRange 存在",
      supportsSetRange,
      "ctx 上还没有 setRange 方法（依赖 A3 §4.1）",
    );
    if (supportsSetRange) {
      const r = await ctx.setRange("Volume", { value: 42 });
      const domValue = await page.evaluate(() => document.getElementById("vol").value);
      check("A3-3b setRange(input[type=range]) 返回 ok=true", r?.ok === true, true, r);
      check("A3-3c achieved=42", r?.achieved === 42, 42, r?.achieved);
      check("A3-3d strategy=fill（原生 range 走 fill）", r?.strategy === "fill", "fill", r?.strategy);
      check("A3-3e DOM 事实：input.value=42", domValue === "42", "42", domValue);

      /* ============================================================== 用例 3b
       * div[role=slider]：键盘策略 Home + ArrowRight×n，校验 aria-valuenow。
       */
      await page.setContent(
        `<!doctype html><html><body>
           <div role="slider" aria-label="Price" aria-valuemin="0" aria-valuemax="100"
                aria-valuenow="0" tabindex="0"
                style="width: 200px; height: 20px; background: #eee"></div>
           <script>
             // 真实 ARIA slider 的键盘行为：Home=min、ArrowRight=+step、ArrowLeft=-step。
             (function () {
               var h = document.querySelector('[role="slider"]');
               var min = Number(h.getAttribute('aria-valuemin'));
               var max = Number(h.getAttribute('aria-valuemax'));
               h.addEventListener('keydown', function (ev) {
                 var v = Number(h.getAttribute('aria-valuenow'));
                 if (ev.key === 'Home') v = min;
                 else if (ev.key === 'ArrowRight') v = Math.min(max, v + 1);
                 else if (ev.key === 'ArrowLeft') v = Math.max(min, v - 1);
                 else return;
                 h.setAttribute('aria-valuenow', String(v));
               });
             })();
           </script>
         </body></html>`,
        { waitUntil: "domcontentloaded" },
      );
      const r2 = await ctx.setRange("Price", { value: 70 });
      const now2 = await page.evaluate(() =>
        document.querySelector('[role="slider"]').getAttribute("aria-valuenow"),
      );
      check("A3-3f setRange(div[role=slider]) 返回 ok=true", r2?.ok === true, true, r2);
      check("A3-3g achieved=70", r2?.achieved === 70, 70, r2?.achieved);
      check(
        "A3-3h strategy=keyboard（role=slider 走键盘）",
        r2?.strategy === "keyboard",
        "keyboard",
        r2?.strategy,
      );
      check("A3-3i DOM 事实：aria-valuenow=70", now2 === "70", "70", now2);

      /* ============================================================== 用例 3c
       * 0×0 手柄：role=slider 自身 bbox 为 0×0，最近有尺寸祖先（track）响应指针事件。
       * 键盘策略在这里不生效（页面只响应指针），必须走「最近有尺寸祖先」的指针拖拽。
       */
      await page.setContent(
        `<!doctype html><html><body>
           <div id="bed-track" style="position: relative; width: 200px; height: 20px; background: #eee">
             <div role="slider" aria-label="Bedrooms" aria-valuemin="1" aria-valuemax="5"
                  aria-valuenow="1" tabindex="0"
                  style="position: absolute; left: 0; top: 0; width: 0; height: 0"></div>
           </div>
           <script>
             (function () {
               var h = document.querySelector('[role="slider"]');
               var track = document.getElementById('bed-track');
               function setter(ev) {
                 var r = track.getBoundingClientRect();
                 var f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
                 h.setAttribute('aria-valuenow', String(Math.round(1 + f * 4)));
               }
               track.addEventListener('mousedown', setter);
             })();
           </script>
         </body></html>`,
        { waitUntil: "domcontentloaded" },
      );
      const r3 = await ctx.setRange("Bedrooms", { value: 4 });
      const now3 = await page.evaluate(() =>
        document.querySelector('[role="slider"]').getAttribute("aria-valuenow"),
      );
      check("A3-3j setRange(0×0 手柄) 返回 ok=true", r3?.ok === true, true, r3);
      check("A3-3k achieved=4（用最近有尺寸祖先的 bbox 完成拖拽）", r3?.achieved === 4, 4, r3?.achieved);
      check(
        "A3-3l strategy ∈ {keyboard,pointer} 且 DOM 事实 aria-valuenow=4",
        ["keyboard", "pointer"].includes(r3?.strategy) && now3 === "4",
        "strategy=keyboard|pointer 且 aria-valuenow=4",
        { strategy: r3?.strategy, aria_valuenow: now3 },
      );
      check(
        "A3-3m setRange 三次调用计 3 个 flow step（ctx.budget.stepsUsed=3）",
        ctx.budget.stepsUsed === 3,
        3,
        ctx.budget.stepsUsed,
      );

      /* ============================================================== 用例 3d
       * 失败不假装成功：角色 slider 但 aria-valuenow 永不更新 + 无指针响应。
       * 期望 ok=false + stopCode=slider_not_settable（结构化失败，不抛裸栈）。
       */
      await page.setContent(
        `<!doctype html><html><body>
           <div role="slider" aria-label="Stuck slider" aria-valuemin="0" aria-valuemax="100"
                aria-valuenow="0" tabindex="0"
                style="width: 200px; height: 20px; background: #eee"></div>
         </body></html>`,
        { waitUntil: "domcontentloaded" },
      );
      let stuck = null;
      let stuckThrew = null;
      try {
        stuck = await ctx.setRange("Stuck slider", { value: 50, timeoutMs: 2_000 });
      } catch (e) {
        stuckThrew = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
      check(
        "A3-3n 不可设置的 slider：结构化失败 ok=false + stopCode=slider_not_settable",
        stuckThrew === null && stuck?.ok === false && stuck?.stopCode === "slider_not_settable",
        "ok=false, stopCode=slider_not_settable（不抛裸栈、不假装成功）",
        stuckThrew === null ? stuck : stuckThrew,
      );
    }
  }

  /* ================================================================ 用例 4
   * dry 桩结构：createDryCtx 的三方法返回文档规定的确定性桩形状，且计 1 step/次。
   */
  {
    const dry = createDryCtx({
      pack: { id: "dev-dry", label: "dev", goal: "dry 桩检查" },
      slots: {},
      runtime: { outDir: "/tmp/amberflow-dev-scripts", runId: "dry", today: "2026-11-03" },
      trace: newTrace("dev-dry"),
      slotKeys: new Set(),
      maxSteps: 10,
    });
    const dryExpand = typeof dry.expand === "function";
    const dryScroll = typeof dry.scrollList === "function";
    const dryRange = typeof dry.setRange === "function";
    depend(
      "A3-4a dry ctx.expand 存在",
      dryExpand,
      "ctx-dry 上还没有 expand 桩（依赖 A3 §4.1）",
    );
    if (dryExpand) {
      const r = await dry.expand("Load more", { count: { rows: "#list li", fields: { text: "." } } });
      check(
        "A3-4b dry expand 桩结构 {ok:true,clicks:0,before:0,after:0,grew:false,stable:true,coverage:{rows:0}}",
        r?.ok === true &&
          r?.clicks === 0 &&
          r?.before === 0 &&
          r?.after === 0 &&
          r?.grew === false &&
          r?.stable === true &&
          r?.coverage?.rows === 0,
        "文档规定的确定性桩",
        r,
      );
    }
    depend(
      "A3-4c dry ctx.scrollList 存在",
      dryScroll,
      "ctx-dry 上还没有 scrollList 桩（依赖 A3 §4.1）",
    );
    if (dryScroll) {
      const r = await dry.scrollList("Feed list", { to: "bottom" });
      check("A3-4d dry scrollList 桩 {ok:true}", r?.ok === true, "ok=true", r);
    }
    depend(
      "A3-4e dry ctx.setRange 存在",
      dryRange,
      "ctx-dry 上还没有 setRange 桩（依赖 A3 §4.1）",
    );
    if (dryRange) {
      const r = await dry.setRange("Volume", { value: 42 });
      check("A3-4f dry setRange 桩 {ok:true}", r?.ok === true, "ok=true", r);
    }
    if (dryExpand && dryScroll && dryRange) {
      check(
        "A3-4g dry 三方法各计 1 flow step（stepsUsed=3）",
        dry.budget.stepsUsed === 3,
        3,
        dry.budget.stepsUsed,
      );
    }
  }
} catch (e) {
  failures.push({
    name: "脚本执行",
    detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
  });
  console.log(`[FAIL] 脚本执行异常：${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
} finally {
  try {
    await browser.close();
  } catch {
    /* 关闭失败不影响断言结论 */
  }
}

/* ------------------------------------------------------------------ 汇总 */

console.log("\n== 汇总 ==");
console.log(`PASS ${passed} / FAIL ${failures.length} / 依赖未实现 ${deps.length}`);
for (const f of failures) console.log(`  FAIL ${f.name}：${f.detail}`);
for (const d of deps) console.log(`  DEP  ${d.name}：${d.note}`);
if (failures.length) {
  console.log("结果：FAIL（见上）");
  process.exit(1);
}
if (deps.length) {
  console.log("结果：DEPENDENCY-NOT-READY（A3 落地后复跑本脚本应 PASS）");
  process.exit(2);
}
console.log("结果：PASS（A3 expand/scrollList/setRange 全部断言通过）");
process.exit(0);
