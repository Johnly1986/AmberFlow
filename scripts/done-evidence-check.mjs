#!/usr/bin/env node
/**
 * done-evidence-check.mjs —— A1「动作执行证据与 done 诚实性」离线验证脚本
 *
 * 依据：docs/IMPLEMENTATION-PLAN-TIER-A-v2.md §2.3（测试四项）
 * 依赖：A1（executor.ts 的 TraceStep.after/changed/skipped/skip_reason、
 *        done_preheld / forceAct / suspected_async / skipped_actions）。
 *        A2（同 label div+button 的候选可行动优先）——本脚本第四项会用到。
 * 前置：A4 已完成（引用盖章唯一化）——本脚本不直接断言盖章，但依赖 A4 的 trace 口径。
 *
 * 运行（不联网、不调模型）：
 *   node --experimental-strip-types scripts/done-evidence-check.mjs
 *
 * 设计纪律：
 *   - page.setContent 构造 DOM，注入已打开的 page，skipNavigation=true，rules-only；
 *   - 显式 installLayaRuntime(null) + installDecisionProvider(null)，任何环境变量都不会
 *     让本脚本发出一次模型/网络请求；
 *   - 断言名 + 期望 + 实际 三者都打印，失败不是裸栈；
 *   - 依赖未实现 → 打印「依赖未实现」并以退出码 2 结束（实现后应 PASS，退出码 0）；
 *     断言失败 → 退出码 1。
 *   - A1 单独 commit 的验收口径：本脚本里只有 A1-4a/b/c（同 label div+button 的候选可行动
 *     优先）依赖 A2 §3.2，A2 未落地时那一条是 DEP ⇒ 退出码 2 表示「上游 A2 未实现」，不是 A1
 *     失败；A1 的验收看 PASS/FAIL 与具体 DEP 明细（A1 面应 FAIL 0）。A2 落地后复跑应退出码 0。
 *
 * 当前基线（HEAD 702accc，A1 未落地）预期：唯一确定能过的是「done 已成立仍执行声明动作」，
 * 其余 done_preheld / changed / suspected_async / skipped_actions 断言打印依赖未实现。
 */
import util from "node:util";

import { chromium } from "playwright";
import { BrowserMiddleware } from "../src/engine/executor.ts";
import { extractElements } from "../src/engine/extraction.ts";
import { installDecisionProvider } from "../src/model/decision-provider.ts";
import { installLayaRuntime } from "../src/model/model.ts";
import { launchKwargs } from "../src/browser/browser-env.ts";

/* ------------------------------------------------------------------ 断言面 */

const failures = [];
const deps = [];
let passed = 0;

/** 普通断言：失败时给出断言名 + 期望 + 实际。 */
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

/** 依赖断言：API 尚未落地时不算失败，但也不假装通过。 */
function depend(name, implemented, note) {
  if (implemented) {
    console.log(`[ OK ] ${name}（依赖已就位）`);
    return true;
  }
  deps.push({ name, note });
  console.log(`[DEP ] ${name}：${note}`);
  return false;
}

/** 递归找对象里第一个带某字段的节点（trace 字段可能挂在 step、report 或 step.result 上）。 */
function findDeep(node, pred, seen = new Set()) {
  if (node === null || typeof node !== "object" || seen.has(node)) return null;
  seen.add(node);
  if (pred(node)) return node;
  for (const v of Object.values(node)) {
    const hit = findDeep(v, pred, seen);
    if (hit !== null) return hit;
  }
  return null;
}

const json = (x) => JSON.stringify(x ?? null);
const traceOf = (rep) => (Array.isArray(rep?.steps) ? rep.steps : []);
const executedSteps = (rep) => traceOf(rep).filter((s) => s?.executed === true);

/** report 是否已带 A1 证据（trace 的 changed 字段是 A1 新增面的最小判别）。 */
function hasA1ChangedEvidence(rep) {
  return traceOf(rep).some((s) => Object.prototype.hasOwnProperty.call(s ?? {}, "changed"));
}
function hasDonePreheldEvidence(rep) {
  return findDeep(rep, (n) => n.done_preheld === true) !== null;
}
function skippedEvidence(rep) {
  const step = findDeep(rep, (n) => n.skipped === true || typeof n.skip_reason === "string");
  const arr = findDeep(
    rep,
    (n) => Array.isArray(n.skipped_actions) && n.skipped_actions.length > 0,
  );
  return { step, arr };
}

/* ------------------------------------------------------------------ 浏览器/执行器 */

installLayaRuntime(null);         // 没有模型运行时 ⇒ executor 进 rules-only
installDecisionProvider(null);    // 显式清空决策 provider：环境变量也改变不了决策源

let browser;
try {
  browser = await chromium.launch(launchKwargs(true));   // headless（本机无显示也能跑）
} catch (e) {
  console.error(`[ENV ] Chromium 启动失败（headless）：${e instanceof Error ? e.message : String(e)}`);
  console.error("       先跑 `npx playwright install chromium` 或检查 PLAYWRIGHT_BROWSERS_PATH。");
  process.exit(2);
}
const page = await browser.newPage();
// 页面 textContent 不变时也保留行：本脚本只做规则/命令解析，不依赖模型。
const mw = new BrowserMiddleware({ maxSteps: 3, riskAsk: "rules-only" });

/**
 * 在同一个 page 上换 DOM 并直跑一个命令步。
 * done 信号是 Node 侧函数，作用在注入的 page 上（不产生网络请求）。
 */
async function runStep(html, runOpts) {
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  return mw.run(runOpts.goal ?? "dev: done evidence check", "about:blank", {
    page,
    skipNavigation: true,
    verbose: false,
    maxSteps: runOpts.maxSteps ?? 3,
    donePollMs: runOpts.donePollMs ?? 100,
    doneTimeoutMs: runOpts.doneTimeoutMs ?? 3000,
    ...runOpts,
  });
}

function pageMarker(name) {
  return page.evaluate((key) => window[key] ?? null, name);
}

console.log("== done-evidence-check: A1 动作执行证据（离线 page.setContent）==\n");

try {
  /* ---------------------------------------------------------------- 用例 1
   * done 已成立 + 声明 click：默认仍执行（不改变既有行为），且必须留下 done_preheld 证据。
   * 期望：executed=true、done=true、trace/report 出现 done_preheld=true。
   */
  {
    const rep = await runStep(
      `<!doctype html><html><body>
         <div id="done-state">任务已完成</div>
         <button id="go" onclick="window.__clicked=(window.__clicked||0)+1">Go</button>
       </body></html>`,
      {
        goal: "A1-1 done 已成立仍执行声明动作",
        goalSignalFn: () => true,
        commands: [{ id: "click-go", op: "click", target: "#go" }],
        maxSteps: 2,
      },
    );
    const clicks = await pageMarker("__clicked");
    check(
      "A1-1a done 已成立时声明动作仍执行（executed=true）",
      executedSteps(rep).some((s) => s.how === "clicked"),
      "trace 中出现 how=clicked 且 executed=true 的步骤",
      { stop_code: rep.stop_code, steps: traceOf(rep) },
    );
    check("A1-1b 页面确实收到一次点击（click 事件计数=1）", clicks === 1, 1, clicks);
    check("A1-1c 完成裁决 done=true", rep.done === true, true, rep.done);
    depend(
      "A1-1d done_preheld 证据（done 已成立时预评估并记录）",
      hasDonePreheldEvidence(rep),
      "trace/report 未出现 done_preheld=true（依赖 A1 的 done_preheld 落账）",
    );
  }

  /* ---------------------------------------------------------------- 用例 2
   * forceAct:true + done 已成立：动作仍必须执行。
   * 本用例在 A1 之前也能过（默认就不改变执行）——它守的是「forceAct 不得引入提前 done 短路」。
   */
  {
    const rep = await runStep(
      `<!doctype html><html><body>
         <div id="done-state">任务已完成</div>
         <button id="go" onclick="window.__force_clicked=(window.__force_clicked||0)+1">Go</button>
       </body></html>`,
      {
        goal: "A1-2 forceAct done 已成立仍执行",
        goalSignalFn: () => true,
        forceAct: true,
        commands: [{ id: "click-go", op: "click", target: "#go" }],
        maxSteps: 2,
      },
    );
    const clicks = await pageMarker("__force_clicked");
    check(
      "A1-2a forceAct:true 下声明动作仍执行（executed=true）",
      executedSteps(rep).some((s) => s.how === "clicked"),
      "trace 中出现 executed=true 的点击步骤",
      { stop_code: rep.stop_code, steps: traceOf(rep) },
    );
    check("A1-2b forceAct 下页面收到点击", clicks === 1, 1, clicks);
    check("A1-2c forceAct 下 done=true", rep.done === true, true, rep.done);
  }

  /* ---------------------------------------------------------------- 用例 3
   * 点击后延迟 1s 增长行：pre/post 快照 changed=false，但 done 在 1s 后成立。
   * 期望（A1 §2.2.5）：记 suspected_async warning，不 forbid、不写 outcome memory inert。
   */
  {
    const inertRecords = [];
    const outcomeMemory = {
      key: () => "done-evidence-check",
      inertIn: () => new Set(),
      record: (_k, _sig, kind) => inertRecords.push(kind),
      countPrevented: () => {},
    };
    const rep = await runStep(
      `<!doctype html><html><body>
         <div id="rows"></div>
         <button id="grow" onclick="setTimeout(function(){
             var d = document.createElement('div');
             d.className = 'row';
             d.textContent = 'new row';
             document.getElementById('rows').appendChild(d);
           }, 1000)">增长</button>
       </body></html>`,
      {
        goal: "A1-3 异步增长",
        goalSignalFn: async (p) =>
          (await p.evaluate(() => document.querySelectorAll("#rows .row").length)) >= 1,
        commands: [{ id: "grow", op: "click", target: "#grow" }],
        outcomeMemory,
        maxSteps: 2,
        donePollMs: 100,
        doneTimeoutMs: 3000,
      },
    );
    const clickStep = executedSteps(rep).find((s) => s.how === "clicked");
    check("A1-3a 延迟增长最终使 done 成立", rep.done === true, true, rep.done);
    const a1Ready = hasA1ChangedEvidence(rep);
    depend(
      "A1-3b trace 带 changed 字段（A1 新增面）",
      a1Ready,
      "trace 步骤没有 changed 字段（依赖 A1 §2.1）",
    );
    if (a1Ready) {
      check(
        "A1-3c 异步增长时 pre/post 快照未变（changed=false）",
        clickStep !== undefined && clickStep.changed === false,
        "executed 步骤 changed=false",
        clickStep,
      );
    }
    depend(
      "A1-3d suspected_async warning 可见",
      json(rep).includes("suspected_async"),
      "report/trace 未出现 suspected_async（依赖 A1 §2.2.5）",
    );
    check(
      "A1-3e 不写 outcome memory inert",
      !inertRecords.includes("inert"),
      "outcomeMemory 的 record() 从不收到 kind=inert",
      inertRecords,
    );
  }

  /* ---------------------------------------------------------------- 用例 4
   * 同 label 的 div+button，且 div 被覆盖层挡住：目标必须落到 button。
   * 期望：被点的是 button（页面 marker 证明），done 成立；
   *       A2 按候选回退时，被跳过候选的原因要可见（skipped_actions / skip_reason）。
   */
  {
    const rep = await runStep(
      `<!doctype html><html><body>
         <div id="done-state">任务已完成</div>
         <!-- div 与 button 同 label；div 在上且被透明覆盖层挡住（覆盖层只盖 div，不盖 button） -->
         <div style="display:flex;gap:200px;align-items:flex-start">
           <div style="position:relative;width:120px;height:40px">
             <div role="button" id="div-sort" style="position:absolute;inset:0">Sort by</div>
             <div id="cover" style="position:absolute;inset:0;z-index:5;background:rgba(0,0,0,0.01)"></div>
           </div>
           <button id="btn-sort" onclick="window.__picked=(window.__picked||[]).concat('button')">Sort by</button>
         </div>
       </body></html>`,
      {
        goal: "A1-4 同 label div+button 选可行动者",
        goalSignalFn: async (p) =>
          (await p.evaluate(() => (window.__picked ?? []).includes("button"))) === true,
        commands: [{ id: "click-sortby", op: "click", target: "Sort by" }],
        maxSteps: 3,
      },
    );
    const picked = await pageMarker("__picked");
    // A2 是否已落地：候选带 bucket（extraction 面）或执行器出现 resolveCommandRef。
    // 未落地时本用例的「选 button」断言是依赖而不是失败（基线会 target_ambiguous）。
    await page.setContent(`<button aria-label="Sort by, Not selected">Sort by</button>`);
    const probePool = await extractElements(page);
    const a2Ready =
      Object.values(probePool).some((e) => typeof e?.bucket === "string") ||
      typeof mw.resolveCommandRef === "function";
    depend(
      "A1-4a A2 候选可行动优先已落地（同 label div+button 可解析）",
      a2Ready,
      "候选无 bucket 字段且无 mw.resolveCommandRef（依赖 A2 §3.1/§3.2）",
    );
    if (a2Ready) {
      check(
        "A1-4b 同 label div+button 最终点到 button（div 未被静默当成目标）",
        Array.isArray(picked) && picked.includes("button"),
        "window.__picked 包含 'button'",
        picked,
      );
      check("A1-4c 完成裁决 done=true（非静默 done）", rep.done === true, true, rep.done);
    } else {
      console.log(`[INFO] 基线行为（A2 未落地）：stop_code=${rep.stop_code} / done=${rep.done}`);
    }
    const sk = skippedEvidence(rep);
    if (a2Ready) {
      // A2 落地后两种合法行为都要接受：
      //   a) 候选回退路径：div 先被尝试 → 被覆盖 → 记 skipped 原因，再点 button；
      //   b) 可行动优先直接选中 button：没有候选被跳过，此时「无静默 done」由页面 marker 证明。
      const hasSkip = sk.step !== null || sk.arr !== null;
      if (hasSkip) {
        const reasonText = JSON.stringify(sk.arr ?? sk.step);
        check(
          "A1-4d 被跳过候选的显式证据含 div/覆盖原因（不是静默跳过）",
          /not-actionable|covered|ambiguous|inert|disabled/i.test(reasonText),
          "skipped 证据的 reason 含 not-actionable/covered/ambiguous/inert",
          sk.arr ?? sk.step,
        );
      } else {
        passed += 1;
        console.log("[PASS] A1-4d A2 直接选中可行动 button，无候选被跳过（无静默 done 由页面 marker 证明）");
      }
    } else {
      depend(
        "A1-4d 被跳过候选的显式证据（skipped/skip_reason/skipped_actions）",
        sk.step !== null || sk.arr !== null,
        "report 中没有 skipped=true / skip_reason / skipped_actions（依赖 A1 §2.1–§2.2）",
      );
    }
  }

  /* ---------------------------------------------------------------- 用例 5
   * 零执行步骤：done 已成立、唯一声明的目标被覆盖层挡住 ⇒ 一个动作都没执行。
   * 期望（A1 §2.2.1–§2.2.2）：executed=false、skipped 证据可见、stop 文案给出摘要，
   * 且 done 来自「信号本来就成立」而不是伪造的执行证据。
   */
  {
    const rep = await runStep(
      `<!doctype html><html><body>
         <div id="done-state">任务已完成</div>
         <div style="position:relative;width:160px;height:40px">
           <div role="button" id="covered-sort" style="position:absolute;inset:0">Sort by</div>
           <div id="cover" style="position:absolute;inset:0;z-index:5;background:rgba(0,0,0,0.01)"></div>
         </div>
       </body></html>`,
      {
        goal: "A1-5 零执行步骤的证据",
        goalSignalFn: () => true,
        commands: [{ id: "click-covered", op: "click", target: "Sort by" }],
        maxSteps: 2,
      },
    );
    const executed = executedSteps(rep);
    check(
      "A1-5a 被覆盖的目标没有被执行（executed=false）",
      executed.length === 0,
      "trace 中没有任何 executed=true 的步骤",
      executed,
    );
    check("A1-5b done=true 来自预成立信号", rep.done === true, true, rep.done);
    const sk = skippedEvidence(rep);
    depend(
      "A1-5c 零执行步骤有显式跳过证据",
      sk.step !== null || sk.arr !== null,
      "缺少 skipped=true / skip_reason / skipped_actions（依赖 A1 §2.2.2）",
    );
    depend(
      "A1-5d stop 文案追加零执行摘要（executed 0 action(s) / see skipped_actions）",
      /executed\s+0\s+action/i.test(String(rep.stop_reason ?? "")) || /skipped/i.test(String(rep.stop_reason ?? "")),
      "stop_reason 未出现零执行/skipped 摘要",
    );
  }
} catch (e) {
  failures.push({ name: "脚本执行", detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
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
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f.name}：${f.detail}`);
}
if (deps.length) {
  for (const d of deps) console.log(`  DEP  ${d.name}：${d.note}`);
}
if (failures.length) {
  console.log("结果：FAIL（见上）");
  process.exit(1);
}
if (deps.length) {
  console.log("结果：DEPENDENCY-NOT-READY（A1/A2 落地后复跑本脚本应 PASS）");
  process.exit(2);
}
console.log("结果：PASS（A1 动作执行证据与 done 诚实性全部断言通过）");
process.exit(0);
