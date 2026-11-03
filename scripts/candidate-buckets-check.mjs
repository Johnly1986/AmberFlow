#!/usr/bin/env node
/**
 * candidate-buckets-check.mjs —— A2「候选分桶配额 + hint 可寻址 + 窗口透明化」离线验证脚本
 *
 * 依据：docs/IMPLEMENTATION-PLAN-TIER-A-v2.md §3.5（测试四项）
 * 依赖：
 *   - A2（extraction.ts 的 bucket / prio / full_label / rect / inViewport；rules.ts 的
 *     aria-label 别名与裸词词边界；executor.ts 的 viewport_underloaded advisory）；
 *   - A3（可选，`mw.scrollContainer`；没有时退化为 page.evaluate 滚动，仅影响「新行进入
 *     窗口」这条用哪条通道，不影响 A2 的窗口事实断言）。
 *
 * 运行（不联网、不调模型）：
 *   node --experimental-strip-types scripts/candidate-buckets-check.mjs
 *
 * 输出约定：PASS / FAIL（断言名+期望+实际）/ DEP（依赖未实现）。
 * 退出码：0 全过；2 有依赖未实现（实现后复跑应 0）；1 断言失败。
 *
 * 基线（HEAD 702accc，A2 未落地）预期：默认 40 池含页头与视口行可过；bucket/full_label、
 * 裸词 Sort by、button[aria-label~sort]、mainOffscreen、viewport_underloaded 打印依赖未实现。
 */
import util from "node:util";

import { chromium } from "playwright";
import { BrowserMiddleware } from "../src/engine/executor.ts";
import { extractElements, hintLookup } from "../src/engine/extraction.ts";
import { hintCandidates, hintMatch } from "../src/engine/rules.ts";
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
  const detail = `期望 ${expected}；实际 ${util.inspect(actual, { depth: 4, breakLength: 120 })}`;
  failures.push({ name, detail });
  console.log(`[FAIL] ${name}\n        ${detail}`);
  return false;
}

function depend(name, implemented, note) {
  if (implemented) {
    console.log(`[ OK ] ${name}（依赖已就位）`);
    return true;
  }
  deps.push({ name, note });
  console.log(`[DEP ] ${name}：${note}`);
  return false;
}

const json = (x) => JSON.stringify(x ?? null);
const valuesOf = (pool) => Object.values(pool ?? {});
const labelsOf = (pool) => valuesOf(pool).map((e) => String(e?.label ?? ""));
const hasLabel = (pool, re) => labelsOf(pool).some((l) => re.test(l));
const refOf = (pool, re) => Object.entries(pool ?? {}).find(([, e]) => re.test(String(e?.label ?? "")))?.[0] ?? null;

/** A2 的桶是闭集；出现其它值按「未按文档实现」处理。 */
const BUCKETS = new Set(["chrome", "viewport", "contentNear", "mainOffscreen", "other"]);

/* ------------------------------------------------------------------ 浏览器/执行器 */

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
const mw = new BrowserMiddleware({ maxSteps: 2, riskAsk: "rules-only" });

console.log("== candidate-buckets-check: A2 候选分桶/可寻址（离线 page.setContent）==\n");

try {
  /* ================================================================ 场景 1
   * 页头 Sort by + 无限滚动 feed（初始 10 行，滚到底再追加 10 行）。
   * 断言：
   *   1a 默认 40 池同时含页头按钮与视口行（A2 前后都应成立，守不退化）；
   *   1b A2：候选带 bucket/prio/full_label 字段；
   *   1c 滚动后，视口内的新行（序号 > 40）进入元素池（窗口随视口移动）。
   */
  await page.setContent(
    `<!doctype html><html><head><style>
       body { margin: 0; font: 14px sans-serif; }
       header { height: 50px; border-bottom: 1px solid #ddd; display: flex; align-items: center; }
       #feed { height: 250px; overflow-y: auto; border: 1px solid #ccc; }
       .row { height: 30px; display: flex; align-items: center; }
     </style></head><body>
       <header><button id="sort" aria-label="Sort by, Not selected">Sort by</button></header>
       <main><div id="feed" role="listbox" aria-label="Feed list"></div></main>
       <script>
         const feed = document.getElementById('feed');
         function addRows(n) {
           for (let i = 0; i < n; i++) {
             const idx = feed.children.length + 1;
             const d = document.createElement('div');
             d.className = 'row';
             const b = document.createElement('button');
             b.textContent = 'Row ' + idx + ' open';
             d.appendChild(b);
             feed.appendChild(d);
           }
         }
         addRows(10);
         feed.addEventListener('scroll', () => {
           if (feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 40 && feed.children.length < 60) {
             addRows(10);
           }
         });
         window.__feedInfo = () => ({
           rows: feed.children.length,
           scrollTop: feed.scrollTop,
           scrollHeight: feed.scrollHeight,
           clientHeight: feed.clientHeight,
         });
       </script>
     </body></html>`,
    { waitUntil: "domcontentloaded" },
  );

  const pool1 = await extractElements(page);
  const pool1Size = Object.keys(pool1).length;
  const sortRef = refOf(pool1, /^Sort by/);
  check(
    "A2-1a 默认 40 池同时含页头按钮与视口行",
    sortRef !== null && hasLabel(pool1, /^Row \d+ open$/) && pool1Size <= 40,
    "池内含 label 以 'Sort by' 开头的元素 + 至少一条 'Row N open'，且池大小 ≤ 40",
    { pool_size: pool1Size, sort_ref: sortRef, labels: labelsOf(pool1).slice(0, 12) },
  );

  const bucketFields = valuesOf(pool1);
  const allHaveBucket =
    bucketFields.length > 0 &&
    bucketFields.every(
      (e) =>
        typeof e?.bucket === "string" &&
        BUCKETS.has(e.bucket) &&
        typeof e?.prio === "number" &&
        typeof e?.full_label === "string" &&
        e.full_label.length <= 200,
    );
  depend(
    "A2-1b 候选带 bucket/prio/full_label（闭集桶 + 完整 label ≤200）",
    allHaveBucket,
    "extractElements 的候选缺少 bucket/prio/full_label（依赖 A2 §3.1）",
  );
  const a2Ready = allHaveBucket;   // A2 落地判别：extraction 面是否已产出分桶字段
  if (allHaveBucket) {
    const visible = valuesOf(pool1).filter((e) => e.inViewport === true);
    check(
      "A2-1c 视口内候选 inViewport=true 且 bucket=viewport",
      visible.length > 0 && visible.every((e) => e.bucket === "viewport" || e.bucket === "chrome"),
      "至少一个 inViewport=true 且 bucket 属于 viewport/chrome",
      visible.map((e) => ({ label: e.label, bucket: e.bucket, inViewport: e.inViewport })),
    );
  }

  // 滚到底：优先用 A3 的 mw.scrollContainer；没有就 page.evaluate 直接滚（同一条 DOM 事实）。
  let scrollChannel = "page.evaluate（A3 mw.scrollContainer 未实现时的回退通道）";
  if (typeof mw.scrollContainer === "function") {
    try {
      for (let i = 0; i < 12 && (await page.evaluate(() => window.__feedInfo().rows)) < 60; i++) {
        await mw.scrollContainer(page, "#feed", "bottom");
        await new Promise((r) => setTimeout(r, 60));
      }
      scrollChannel = "mw.scrollContainer（A3）";
    } catch {
      scrollChannel = "page.evaluate（mw.scrollContainer 调用失败后的回退）";
    }
  }
  // 兜底：无论上面的通道是否成功，都用 page.evaluate 把 feed 滚到「新行区」，
  // 保证这条断言检验的是「视口窗口跟随」而不是某条滚动通道的可用性（后者由 expand-range 脚本覆盖）。
  await page.evaluate(async () => {
    const feed = document.getElementById("feed");
    for (let i = 0; i < 100 && feed.children.length < 60; i++) {
      feed.scrollTop = feed.scrollHeight;
      await new Promise((r) => setTimeout(r, 30));
    }
  });
  await new Promise((r) => setTimeout(r, 150));
  const feedInfo = await page.evaluate(() => window.__feedInfo());
  console.log(`[INFO] 滚动通道：${scrollChannel}；feed rows=${feedInfo.rows}, scrollTop=${feedInfo.scrollTop}/${feedInfo.scrollHeight - feedInfo.clientHeight}`);

  const pool2 = await extractElements(page);
  const visibleRows = await page.evaluate(() => {
    const feed = document.getElementById("feed");
    const fr = feed.getBoundingClientRect();
    return [...feed.querySelectorAll(".row")]
      .filter((r) => {
        const b = r.getBoundingClientRect();
        return b.bottom > fr.top && b.top < fr.bottom;
      })
      .map((r) => r.textContent.trim());
  });
  const farVisible = visibleRows.filter((l) => {
    const m = /^Row (\d+) open$/.exec(l);
    return m !== null && Number(m[1]) > 40;
  });
  const farInPool = farVisible.filter((l) => labelsOf(pool2).includes(l));
  if (a2Ready) {
    check(
      "A2-1d 滚动后视口内新行（序号>40）进入元素池",
      farVisible.length > 0 && farInPool.length > 0,
      "至少一条「Row N open」(N>40) 同时出现在视口与元素池",
      { far_visible: farVisible, far_in_pool: farInPool, pool2_size: Object.keys(pool2).length },
    );
  } else {
    deps.push({
      name: "A2-1d 滚动后视口内新行（序号>40）进入元素池",
      note: "候选尚无 bucket 分桶（依赖 A2 §3.1 的视口优先取池）；基线池按 DOM 序只含前 40",
    });
    console.log(`[DEP ] A2-1d 滚动后视口内新行进入元素池：依赖 A2 §3.1（远视口行=${JSON.stringify(farVisible)}）`);
  }

  /* ================================================================ 场景 2
   * 长正文页：main 内容在视口外（0 视口行），页头按钮在视口内。
   * 断言：mainOffscreen 桶存在、hint 能命中页外元素（池内 + DOM 回捞两面）。
   */
  await page.setContent(
    `<!doctype html><html><body>
       <header><button id="top-action">Top action</button></header>
       <div style="height: 2200px"></div>
       <main><button id="deep-action" aria-label="Deep action">Deep action</button></main>
     </body></html>`,
    { waitUntil: "domcontentloaded" },
  );
  const poolLong = await extractElements(page);
  const deepRef = refOf(poolLong, /^Deep action$/);
  const deepEl = deepRef === null ? null : poolLong[deepRef];
  const deepLookup = await hintLookup(page, "Deep action");
  check(
    "A2-2a 页外 main 元素可被 hint 命中（池内）",
    deepRef !== null && hintMatch("Deep action", poolLong) !== null,
    "池内含 label=Deep action，且 hintMatch('Deep action') 非 null",
    { deep_ref: deepRef, labels: labelsOf(poolLong) },
  );
  check(
    "A2-2b 页外 main 元素可被 hintLookup 回捞（DOM 面）",
    Object.keys(deepLookup).length > 0,
    "hintLookup('Deep action') 返回非空",
    deepLookup,
  );
  if (allHaveBucket) {
    check(
      "A2-2c 页外 main 元素落 mainOffscreen 桶且 inViewport=false",
      deepEl !== null && deepEl.bucket === "mainOffscreen" && deepEl.inViewport === false,
      "Deep action: bucket=mainOffscreen, inViewport=false",
      deepEl === null ? null : { bucket: deepEl.bucket, inViewport: deepEl.inViewport, rect: deepEl.rect },
    );
  } else {
    deps.push({
      name: "A2-2c 页外 main 元素落 mainOffscreen 桶",
      note: "候选尚无 bucket/inViewport 字段（依赖 A2 §3.1）",
    });
    console.log("[DEP ] A2-2c 页外 main 元素落 mainOffscreen 桶：依赖 A2 §3.1 的 bucket/inViewport");
  }

  /* ================================================================ 场景 3
   * 虚拟列表只渲染 10 行（scrollHeight 很大）：对第 50 行 hint。
   * 断言：target_not_found 停因 + viewport_underloaded advisory（不是静默 low_confidence）。
   */
  await page.setContent(
    `<!doctype html><html><body>
       <div id="vlist" role="listbox" aria-label="Virtual results"
            style="height: 300px; overflow-y: auto; border: 1px solid #ccc">
         <div style="height: 6000px; position: relative">
           <div id="vitems" style="position: absolute; top: 0; left: 0; right: 0">
             ${Array.from({ length: 10 }, (_, i) => `<div style="height:30px"><button>Row ${i + 1} open</button></div>`).join("")}
           </div>
         </div>
       </div>
     </body></html>`,
    { waitUntil: "domcontentloaded" },
  );
  const row50Lookup = await hintLookup(page, "Row 50");
  check(
    "A2-3a 虚拟列表缺行：hintLookup 找不到第 50 行（DOM 事实）",
    Object.keys(row50Lookup).length === 0,
    "hintLookup('Row 50') 返回空（只渲染了 1..10）",
    row50Lookup,
  );
  const vrep = await mw.run("虚拟列表缺行检查", "about:blank", {
    page,
    skipNavigation: true,
    verbose: false,
    maxSteps: 1,
    goalSignalFn: () => false,
    commands: [{ id: "row50", op: "click", target: "Row 50" }],
  });
  check(
    "A2-3b 缺行停因是 target_not_found",
    vrep.stop_code === "target_not_found",
    "stop_code=target_not_found",
    { stop_code: vrep.stop_code, stop_reason: vrep.stop_reason },
  );
  depend(
    "A2-3c viewport_underloaded advisory 可见（窗口外/未渲染的判别）",
    json(vrep).includes("viewport_underloaded"),
    "stop_reason/diagnostics 未出现 viewport_underloaded（依赖 A2/A3 的窗口透明化）",
  );

  /* ================================================================ 场景 4
   * hint 形状：裸词 `Sort by` 命中 aria-label="Sort by, Not selected"；
   * `button[aria-label~sort]` 命中（A2 的 aria-label 别名 + 完整 label 匹配）。
   */
  await page.setContent(
    `<!doctype html><html><body>
       <header><button id="sort" aria-label="Sort by, Not selected">Sort by</button></header>
       <main><div style="height: 1200px">content</div></main>
     </body></html>`,
    { waitUntil: "domcontentloaded" },
  );
  const poolHint = await extractElements(page);
  const bareRef = hintMatch("Sort by", poolHint);
  const bareCand = hintCandidates("Sort by", poolHint);
  if (a2Ready) {
    check(
      "A2-4a 裸词 'Sort by' 命中 aria-label='Sort by, Not selected'",
      bareRef !== null,
      "hintMatch('Sort by') 返回非 null（A2 的逗号/词边界归一并匹配完整 label）",
      {
        hit: bareRef,
        labels: labelsOf(poolHint),
        candidates: bareCand === null ? null : bareCand.refs,
      },
    );
  } else {
    deps.push({
      name: "A2-4a 裸词 'Sort by' 命中 aria-label 完整值",
      note: "hintMatch('Sort by') 返回 null（依赖 A2 §3.1 的 full_label/词边界归一）",
    });
    console.log(`[DEP ] A2-4a 裸词 'Sort by' 命中 aria-label：依赖 A2 §3.1（当前 labels=${JSON.stringify(labelsOf(poolHint))}）`);
  }
  if (bareRef !== null) {
    const el = poolHint[bareRef];
    check(
      "A2-4b 命中的是 button，完整 label 含 'sort by'",
      el?.tag === "button" && String(el?.full_label ?? el?.label ?? "").toLowerCase().includes("sort by"),
      "bare 命中 button，full_label 含 'sort by'",
      el === null || el === undefined ? null : { tag: el.tag, label: el.label, full_label: el.full_label },
    );
  }
  const attrRef = hintMatch("button[aria-label~sort]", poolHint);
  if (a2Ready) {
    check(
      "A2-4c 'button[aria-label~sort]' 命中（aria-label 别名进池侧匹配）",
      attrRef !== null && poolHint[attrRef]?.tag === "button",
      "hintMatch('button[aria-label~sort]') 返回 button 的 ref",
      { hit: attrRef, labels: labelsOf(poolHint) },
    );
  } else {
    deps.push({
      name: "A2-4c 'button[aria-label~sort]' 命中（aria-label 别名）",
      note: "池侧 attrSubstr 无 aria-label 别名（依赖 A2 §3.1）",
    });
    console.log(`[DEP ] A2-4c 'button[aria-label~sort]' 命中：依赖 A2 §3.1 的 aria-label 别名（hit=${String(attrRef)}）`);
  }
  const domLookup = await hintLookup(page, "Sort by");
  if (a2Ready) {
    check(
      "A2-4d DOM 侧 hintLookup('Sort by') 也能回捞该按钮",
      Object.keys(domLookup).length > 0,
      "hintLookup('Sort by') 返回非空",
      domLookup,
    );
  } else {
    deps.push({
      name: "A2-4d DOM 侧 hintLookup('Sort by') 回捞",
      note: "回捞面裸词仍是整串匹配（依赖 A2 §3.1 的 HINT_HEAD 词边界归一）",
    });
    console.log("[DEP ] A2-4d DOM 侧 hintLookup('Sort by')：依赖 A2 §3.1 的 HINT_HEAD 词边界归一");
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
  console.log("结果：DEPENDENCY-NOT-READY（A2 落地后复跑本脚本应 PASS）");
  process.exit(2);
}
console.log("结果：PASS（A2 候选分桶/可寻址全部断言通过）");
process.exit(0);
