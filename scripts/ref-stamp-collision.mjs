/**
 * A4 引用盖章唯一化 —— 离线回归脚本（本地 page.setContent，不联网）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/ref-stamp-collision.mjs
 * 退出码：0 = 全部断言 PASS；1 = 有断言 FAIL（逐条打印）；2 = 环境/依赖错误（浏览器起不来等）。
 *
 * 为什么需要这个脚本：`ref` 是位置性编号（eN），旧实现把 `data-dshref` 直接写成
 * `eN`——页面元素换位后（列表插队/重排、SPA 复用 DOM），旧章还留在原元素上，新元素
 * 又拿到同名章，同一个 `[data-dshref="e2"]` 命中两个节点：按章取元素要么 strict mode
 * 报错，要么点错元素。A4 在提取开头清旧章 + 章值加批次 nonce（af<批>-e<位>）后，
 * 章必须"一轮一批、全页唯一"。
 *
 * 断言形状（与 docs/IMPLEMENTATION-PLAN-TIER-A-v2.md §1 对齐）：
 *   1. 每轮提取后 `[data-dshref]` 总数 === 池大小，且章值互不相同；
 *   2. 换位后的第二轮里旧批次章 af1-* 计数为 0、新批次 af2-* 全就位；
 *   3. 每个返回元素的 dsh_ref 都能用 `[data-dshref="..."]` 唯一命中（count === 1）；
 *   4. 返回的 `ref` 字段仍是位置编号 eN（forbidden/日志语义不被 nonce 改变）；
 *   5. hint 回捞同法：清旧 [data-hintref] 章、新章唯一、旧批次不命中；
 *   6. 执行器 `_locatorFor`：引用章唯一才返回 locator；多命中不返回（回退 scan，
 *      回退不到返回 null），并把选择器/匹配计数/回退结果记成 ref_collision 诊断。
 *
 * 阶段 B 用**原地 DOM 插队**而不是整页重写：只有保留元素节点，旧章才会真的残留——
 * 这正是线上列表重排的形状（整页重写会把旧节点连同旧章一起丢掉，测不出问题）。
 */
import { chromium } from "playwright";
import { extractElements, hintLookup } from "../src/engine/extraction.ts";
import { BrowserMiddleware } from "../src/engine/executor.ts";

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${label}${detail ? `  (${detail})` : ""}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label}${detail ? `  (${detail})` : ""}`);
  }
};
const eq = (label, actual, expected) =>
  ok(label, JSON.stringify(actual) === JSON.stringify(expected),
    `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

/** 页面上的章计数与 X 元素当前章（一次 evaluate，避免多次往返读数不一致）。 */
const domStats = (page) => page.evaluate(() => {
  const stamps = [...document.querySelectorAll("[data-dshref]")]
    .map((e) => e.getAttribute("data-dshref"));
  const hints = [...document.querySelectorAll("[data-hintref]")]
    .map((e) => e.getAttribute("data-hintref"));
  const x = document.querySelector("#x");
  return {
    stamps,
    hints,
    total: stamps.length,
    hintTotal: hints.length,
    uniqueStamps: new Set(stamps).size,
    uniqueHints: new Set(hints).size,
    xStamp: x ? x.getAttribute("data-dshref") : null,
    xHint: x ? x.getAttribute("data-hintref") : null,
  };
});

/** 每个返回元素的引用章都必须唯一命中；返回违规清单（空 = 全过）。 */
const badSanity = async (page, rows, key, attr) => {
  const bad = [];
  for (const row of rows) {
    const stamp = row[key];
    if (!stamp) {
      bad.push({ ref: row.ref, [key]: null, count: 0 });
      continue;
    }
    const count = await page.locator(`[${attr}="${stamp}"]`).count();
    if (count !== 1) bad.push({ ref: row.ref, [key]: stamp, count });
  }
  return bad;
};

const HTML_STAGE_A = `<!doctype html>
<html><body>
  <div id="list">
    <button id="a">Alpha</button>
    <button id="b">Bravo</button>
    <button id="x">X-Ray</button>
    <button id="c">Charlie</button>
  </div>
</body></html>`;

let browser = null;
try {
  browser = await chromium.launch();
} catch (e) {
  console.error(`环境错误：Chromium 起不来（${String(e?.message ?? e)}）——先跑 npx playwright install chromium`);
  process.exit(2);
}

try {
  const page = await browser.newPage();

  /* ---------------------------------------------------------- 阶段 A：X 在位置 2 */
  await page.setContent(HTML_STAGE_A);
  // jsProbe=false：本条回归只验盖章机制，CDP 监听器探针与本项无关（省一次 session）。
  const poolA = await extractElements(page, false);
  const rowsA = Object.values(poolA);
  const sA = await domStats(page);

  eq("阶段A 池大小", rowsA.length, 4);
  eq("阶段A [data-dshref] 总数 === 池大小", sA.total, rowsA.length);
  eq("阶段A 章值互不相同", sA.uniqueStamps, rowsA.length);
  eq("阶段A 本批章 af1-* 全就位", await page.locator('[data-dshref^="af1-"]').count(), rowsA.length);
  eq("阶段A 返回 ref 仍是位置编号 eN", rowsA.map((e) => e.ref), ["e0", "e1", "e2", "e3"]);
  eq("阶段A X 在位置 2（ref=e2、stamp=af1-e2、DOM 同值）",
    { ref: poolA["e2"]?.ref, stamp: poolA["e2"]?.dsh_ref, xStamp: sA.xStamp },
    { ref: "e2", stamp: "af1-e2", xStamp: "af1-e2" });
  eq("阶段A 每个 dsh_ref 唯一命中（count===1）", await badSanity(page, rowsA, "dsh_ref", "data-dshref"), []);

  /* --------------------------- 阶段 B：原地插队两个按钮，X 换到位置 4（节点保留） */
  await page.evaluate(() => {
    const x = document.querySelector("#x");
    const list = x.parentElement;
    for (const [id, label] of [["d", "Delta"], ["e", "Echo"]]) {
      const b = document.createElement("button");
      b.id = id;
      b.textContent = label;
      list.insertBefore(b, x);
    }
  });
  const poolB = await extractElements(page, false);
  const rowsB = Object.values(poolB);
  const sB = await domStats(page);

  eq("阶段B 池大小", rowsB.length, 6);
  eq("阶段B [data-dshref] 总数 === 池大小（旧章已清，无重复）", sB.total, rowsB.length);
  eq("阶段B 章值互不相同", sB.uniqueStamps, rowsB.length);
  eq("阶段B 旧批次 af1-* 不命中（count===0）", await page.locator('[data-dshref^="af1-"]').count(), 0);
  eq("阶段B 新批次 af2-* 全就位", await page.locator('[data-dshref^="af2-"]').count(), rowsB.length);
  eq("阶段B 旧 X 章 af1-e2 已从 DOM 消失", await page.locator('[data-dshref="af1-e2"]').count(), 0);
  eq("阶段B X 换到位置 4（ref=e4、stamp=af2-e4、DOM 同值）",
    { ref: poolB["e4"]?.ref, stamp: poolB["e4"]?.dsh_ref, xStamp: sB.xStamp },
    { ref: "e4", stamp: "af2-e4", xStamp: "af2-e4" });
  eq("阶段B 插队到位置 2 的元素拿到本轮新章 af2-e2（唯一）",
    await page.locator('[data-dshref="af2-e2"]').count(), 1);
  eq("阶段B 每个 dsh_ref 唯一命中（count===1）", await badSanity(page, rowsB, "dsh_ref", "data-dshref"), []);

  /* --------------------------------------------------- hint 回捞：同一个清理/唯一性契约 */
  const hintFirst = await hintLookup(page, "button");
  const hRowsFirst = Object.values(hintFirst);
  const hFirst = await domStats(page);

  eq("hint 第一轮回捞命中数（上限 5）", hRowsFirst.length, 5);
  eq("hint 第一轮 [data-hintref] 总数 === 命中数", hFirst.hintTotal, hRowsFirst.length);
  eq("hint 第一轮章值互不相同", hFirst.uniqueHints, hRowsFirst.length);
  eq("hint 第一轮批次 af3-* 全就位", await page.locator('[data-hintref^="af3-"]').count(), hRowsFirst.length);
  eq("hint 第一轮每个 hint_ref 唯一命中（count===1）",
    await badSanity(page, hRowsFirst, "hint_ref", "data-hintref"), []);

  // 再往最前插两个按钮：第二轮命中集合整体前移，第一轮被盖章但第二轮不再命中的元素
  // （e/x/c）必须被清掉旧章，否则 [data-hintref] 总数会大于本轮命中数。
  await page.evaluate(() => {
    const list = document.querySelector("#list");
    for (const [id, label] of [["f", "Foxtrot"], ["g", "Golf"]]) {
      const b = document.createElement("button");
      b.id = id;
      b.textContent = label;
      list.insertBefore(b, list.firstElementChild);
    }
  });
  const hintSecond = await hintLookup(page, "button");
  const hRowsSecond = Object.values(hintSecond);
  const hSecond = await domStats(page);

  eq("hint 第二轮回捞命中数（上限 5）", hRowsSecond.length, 5);
  eq("hint 第二轮 [data-hintref] 总数 === 命中数（旧 hint 章已清）",
    hSecond.hintTotal, hRowsSecond.length);
  eq("hint 第二轮章值互不相同", hSecond.uniqueHints, hRowsSecond.length);
  eq("hint 第二轮旧批次 af3-* 不命中（count===0）",
    await page.locator('[data-hintref^="af3-"]').count(), 0);
  eq("hint 第二轮批次 af4-* 全就位",
    await page.locator('[data-hintref^="af4-"]').count(), hRowsSecond.length);
  eq("hint 第二轮 #x 不再带 hint 章（第一轮命中、第二轮未命中）", hSecond.xHint, null);
  eq("hint 第二轮每个 hint_ref 唯一命中（count===1）",
    await badSanity(page, hRowsSecond, "hint_ref", "data-hintref"), []);

  /* --------------------------------- 执行器 _locatorFor：引用章唯一性闸门（A4 第二半） */
  const mw = new BrowserMiddleware({});

  const locUnique = await mw._locatorFor(page, poolB["e4"]);
  ok("_locatorFor 唯一章返回 locator", locUnique !== null);
  if (locUnique !== null) {
    eq("_locatorFor 唯一章 locator.count()===1", await locUnique.count(), 1);
  }
  eq("唯一命中不产生 ref_collision 诊断", mw._drainRefCollisions(), null);

  // 人为把 X 的章复制到 #a 上：模拟"旧章残留/页面复制节点"造成的多命中。
  const xStamp = poolB["e4"].dsh_ref;
  await page.evaluate((stamp) => {
    document.querySelector("#a").setAttribute("data-dshref", stamp);
  }, xStamp);
  eq("人为复制章后 [data-dshref] 命中 2 个（前提成立）",
    await page.locator(`[data-dshref="${xStamp}"]`).count(), 2);

  const locDup = await mw._locatorFor(page, { tag: "button", label: "", dsh_ref: xStamp });
  eq("_locatorFor 多命中不返回 locator（无回退 → null，交动作层 stale_ref）", locDup, null);
  const diagDup = mw._drainRefCollisions();
  ok("多命中记 ref_collision 诊断（1 条）", Array.isArray(diagDup) && diagDup.length === 1,
    JSON.stringify(diagDup));
  const d0 = String(diagDup?.[0] ?? "");
  ok("诊断含匹配计数", d0.includes("matched 2 elements"), d0);
  ok("诊断含最终回退结果（stale_ref）", d0.includes("stale_ref"), d0);

  // 同一冲突、但元素带 scan：仍不得返回冲突 locator，回退到位置扫描并记下回退结果。
  const locFallback = await mw._locatorFor(page, { tag: "button", label: "", dsh_ref: xStamp, scan: 4 });
  ok("_locatorFor 多命中回退 positional scan 返回 locator", locFallback !== null);
  if (locFallback !== null) {
    eq("回退 locator 是单个元素", await locFallback.count(), 1);
  }
  const diagFallback = mw._drainRefCollisions();
  const d1 = String(diagFallback?.[0] ?? "");
  ok("回退诊断点名冲突选择器与计数",
    d1.includes(`[data-dshref='${xStamp}']`) && d1.includes("matched 2 elements"), d1);
  ok("回退诊断含最终回退结果（positional scan）", d1.includes("fell back to positional scan"), d1);

  // hint_ref 走同一条闸门。
  const hintEntry = hRowsSecond[0];
  await page.evaluate((stamp) => {
    document.querySelector("#c").setAttribute("data-hintref", stamp);
  }, hintEntry.hint_ref);
  eq("人为复制 hint 章后命中 2 个（前提成立）",
    await page.locator(`[data-hintref="${hintEntry.hint_ref}"]`).count(), 2);
  const locHintDup = await mw._locatorFor(page, { tag: "button", label: "", hint_ref: hintEntry.hint_ref });
  eq("_locatorFor hint_ref 多命中不返回 locator", locHintDup, null);
  const diagHint = mw._drainRefCollisions();
  ok("hint_ref 冲突诊断点名 data-hintref",
    String(diagHint?.[0] ?? "").includes("data-hintref"), String(diagHint?.[0] ?? ""));

  await page.close();
} catch (e) {
  console.error(`\n运行异常（按环境错误处理）：${e?.stack ?? e}`);
  fail += 1;
} finally {
  try { await browser.close(); } catch { /* 关浏览器失败不该掩盖断言结果 */ }
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} 项通过 / ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
