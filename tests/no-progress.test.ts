/**
 * D3 + backlog R-4：**`inert` 不该是循环唯一的终止依据**，而"卡住"必须与"步数预算用完了"
 * 说出不同的话（`no_progress` vs `max_steps`）。
 *
 * 重审 §8.5 给的验收方式就是这个文件的第一条测试：**同一份"死元素当目标"的夹具**跑两遍，
 * 一遍关掉新上界（`maxEffectiveRepeats: 0` = 今天的行为），一遍用缺省值——前者烧到 `max_steps`，
 * 后者早停且理由不同。数字进断言，不是叙述。
 *
 * 夹具 testpages/dead-target.html 让两件事同时成立：
 *   ① 确认按钮是**死的**（handler 存在但什么都不改）；
 *   ② 页面是**吵的**（50 ms 一跳的倒计时 → 整页快照在前/后采样之间必然不同 → inert 永远为假）。
 * 所以今天 anti-repeat 不触发、同一个死按钮被反复点。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import * as browserEnv from "../src/browser-env.ts";
import { BrowserMiddleware, type AnyPage, type PwLike } from "../src/executor.ts";
import { installLayaRuntime, scriptedRuntime, scriptedAgent } from "../src/model.ts";
import { checkSignal } from "../src/signals.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const DEAD = pathToFileURL(path.join(REPO, "testpages", "dead-target.html")).href;
const pw: PwLike = { chromium: chromium as unknown as PwLike["chromium"] };
const asPage = (p: Page): AnyPage => p as unknown as AnyPage;

let browser: Browser;
beforeAll(async () => {
  browser = (await browserEnv.launch(pw)) as unknown as Browser;
  installLayaRuntime(scriptedRuntime(scriptedAgent(() => ({ noul: 0.0 }))));
}, 120_000);
afterAll(async () => { await browser?.close(); installLayaRuntime(null); });

/** 每一步都点同一个死按钮的子目标：信号永远不会成立。 */
async function deadRun(maxEffectiveRepeats: number, maxSteps = 8) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const mw = new BrowserMiddleware({ maxSteps, maxEffectiveRepeats });
  const rep = await mw.run("确认下单", DEAD, {
    page: asPage(page), pw, verbose: false,
    targetHint: "[data-test=confirm]",
    goalSignalFn: (p: unknown) => checkSignal(p as never, { css_text_equals: ["[data-test=status]", "已确认"] }),
  });
  await ctx.close();
  return rep;
}

/** 一个"点第 N 次才成立"的页面：用来证明这个上界不会误杀合法的重复驱动。 */
function countingPage(needed: number, dead = false): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amber-noprogress-"));
  const file = path.join(dir, "counting.html");
  fs.writeFileSync(file, `<!DOCTYPE html><html lang="zh"><body>
    <button data-test="go">下一步</button>
    <p data-test="count">0</p>
    <script>
      let n = 0;
      document.querySelector('[data-test=go]').addEventListener('click', () => {
        ${dead ? "/* 死按钮：什么都不做 */" : `
        n += 1;
        document.querySelector('[data-test=count]').textContent = String(n);`}
      });
    </script></body></html>`, "utf-8");
  return pathToFileURL(file).href;
}

async function clickUntil(url: string, signal: Record<string, unknown>, maxSteps = 8) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const mw = new BrowserMiddleware({ maxSteps });
  const rep = await mw.run("推进", url, {
    page: asPage(page), pw, verbose: false,
    targetHint: "[data-test=go]",
    goalSignalFn: (p: unknown) => checkSignal(p as never, signal as never),
  });
  await ctx.close();
  return rep;
}

describe("D3/R-4：死元素当目标 —— 早停且理由与 max_steps 分开", () => {
  it("同一份夹具 A/B：关掉上界烧到 max_steps；缺省上界在更少的步数上给出 no_progress", async () => {
    const before = await deadRun(0);                       // 今天的行为
    expect(before.done).toBe(false);
    expect(before.stop_code).toBe("max_steps");
    expect(before.steps.length).toBe(8);                   // 8 步全花在同一个死按钮上
    expect(before.steps.every((s) => s.executed)).toBe(true);

    const after = await deadRun(3);                        // 缺省
    expect(after.done).toBe(false);
    expect(after.stop_code).toBe("no_progress");           // 理由与 max_steps **不同**
    expect(after.steps.length).toBeLessThan(before.steps.length);   // 而且更早
    expect(after.stop_step).toBe(4);                       // 第 4 次驱动时喊停
    expect(String(after.stop_reason)).toMatch(/executed 4 time\(s\) in this subgoal/);
    expect(String(after.stop_reason)).toMatch(/instead of blaming the step budget \(max_steps=8\)/);
  }, 90_000);          // A/B 两遍真浏览器、8+4 步：默认 5 s 不够，这与被测行为无关

  it("上界按**元素签名**计数：位置性 ref 每次重扫都变，签名不变（所以不能被 ref 骗过去）", async () => {
    const rep = await deadRun(3);
    // 四次执行落在同一个签名上：`desc` 里的标签与元素一致，且都记了 executed
    expect(rep.steps.filter((s) => s.executed).length).toBe(4);
  });

  it("不误杀合法重复：点到第 3 次才成立的信号，第 3 次就 done（上界是 3）", async () => {
    const rep = await clickUntil(countingPage(3), { css_text_equals: ["[data-test=count]", "3"] });
    expect(rep.done).toBe(true);
    expect(rep.stop_code).toBe("dom_goal_signal");
    expect(rep.steps.filter((s) => s.executed).length).toBe(3);
  });

  it("边界：信号要第 5 次才成立 ⇒ 第 4 次驱动时喊停（上界数的是**信号没成立**的那几次）", async () => {
    const rep = await clickUntil(countingPage(5), { css_text_equals: ["[data-test=count]", "5"] });
    expect(rep.done).toBe(false);
    expect(rep.stop_code).toBe("no_progress");
    expect(rep.steps.filter((s) => s.executed).length).toBe(4);
  });

  it("`maxEffectiveRepeats: 0` 是显式消融口（逐字节回到今天的行为）", async () => {
    const rep = await deadRun(0, 5);
    expect(rep.stop_code).toBe("max_steps");
    expect(rep.steps.length).toBe(5);
  });
});
