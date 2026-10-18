/**
 * P0 硬化负例（docs/ARCHITECTURE_REVIEW.md §7.2「要钉的负例」里 P0 那批）。
 *
 * 这批不是"顺手补的测试"，是重审判定的四条健壮性缺陷（D1/D2/D4/D5①/D5②/D6）各自的
 * **执法点**：形状改了，行为没改，但少了这些测试，下一次重构就会把单出口/结构化停因/
 * 遮蔽/导航信封重新拆散。每条都钉一个"改坏了会红"的口径：
 *
 *   D1/D2  禁元素只有一个出口、re-prune 只有一处实现（源码结构守卫）
 *   D4     stop_reason 的人读串照旧 + 新增可分支的 stop_code
 *   D5①    password/file/hidden 的值不落进快照比对、trace、报告
 *   D5②    hosts 运行期强制（导航信封）：goto 前拒绝、动作后越界即停、空声明不启用
 *   D6     配置类错误启动期预检、永不重试、0 副作用
 *
 * 模型一律用 scriptedRuntime，不碰权重。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import * as browserEnv from "../src/browser-env.ts";
import { BrowserMiddleware, disallowedHost, type AnyPage, type PwLike } from "../src/executor.ts";
import { NEVER_RETRY_CODES, runSubgoalWithRetries, runOnce } from "../src/planner.ts";
import { TaskPlan } from "../src/plan.ts";
import type { Subgoal } from "../src/plan.ts";
import { extractSlots } from "../src/extraction.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer, type Question } from "../src/model.ts";
import { checkSignal } from "../src/signals.ts";
import { modelConfigError } from "../src/model-artifacts.ts";
import { AppRunConfigError, preflightConfig } from "../src/app-runner.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const fixture = (...p: string[]): string => pathToFileURL(path.join(REPO, ...p)).href;
const dataUrl = (html: string): string => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

const pw: PwLike = { chromium: chromium as unknown as PwLike["chromium"] };
const asPage = (p: Page): AnyPage => p as unknown as AnyPage;

let browser: Browser;

beforeAll(async () => {
  browser = (await browserEnv.launch(pw)) as unknown as Browser;
}, 120_000);

afterAll(async () => {
  await browser?.close();
  installLayaRuntime(null);
});

/** A model that picks the first criterion containing `want`, at `confidence`. */
function chooser(want: string, confidence: number): void {
  installLayaRuntime(scriptedRuntime(scriptedAgent(
    (key: string, _state: unknown, questions: Record<string, Question>): Answer | undefined => {
      const q = questions[key];
      if (!q) return undefined;
      if (q.type === "noul") return { noul: 0.0 };
      const crit = (q.criteria ?? {}) as Record<string, unknown>;
      const keys = Object.keys(crit);
      const pick = keys.find((k) => String(crit[k] ?? "").toLowerCase().includes(want.toLowerCase())) ?? keys[0]!;
      return { choice: pick, probabilities: Object.fromEntries(keys.map((k) => [k, k === pick ? confidence : 0.01])), confidence };
    },
  )));
}

/* ------------------------------------------------------------------ D1/D2: source-shape guards */

describe("禁元素/re-prune 收敛为单一出口（D1/D2 的结构守卫）", () => {
  const src = fs.readFileSync(path.join(REPO, "src", "executor.ts"), "utf-8");

  it("`forbidden[ref] = esig(el)` 的直接写入只剩 forbid 助手内部那一处", () => {
    const direct = (src.match(/forbidden\[[^\]]+\]\s*=\s*esig\(/g) ?? []);
    expect(direct.length).toBe(1);            // 曾经 7 处各写各的
  });

  it("re-prune（陈旧 forbid 修剪）只有一处实现", () => {
    // 曾经的三处独立实现都以 `!sigEq(forbidden[r]` 开头；现在只有 pruneForbids 内部一处。
    const prunes = (src.match(/!sigEq\(forbidden\[r\]/g) ?? []);
    expect(prunes.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ D4: structured stop codes */

describe("停因是数据：stop_code + 人读串照旧（D4）", () => {
  it("低置信阻塞给出 low_confidence 码，人读串与冻结语料逐字节相同", async () => {
    chooser("Nothing", 0.10);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(dataUrl(`<button>Nope A</button><button>Nope B</button>`));
    const mw = new BrowserMiddleware({ maxSteps: 2, confFloor: 0.25, reobserve: false });
    const rep = await mw.run("click the missing thing", page.url(), {
      page: asPage(page), pw, targetHint: null, verbose: false,
    });
    await ctx.close();
    expect(rep.done).toBe(false);
    expect(rep.stop_code).toBe("low_confidence");
    expect(rep.stop_step).toBe(1);
    // 人读串格式没变（parity 语料钉的是它）
    expect(rep.stop_reason).toMatch(/^low confidence \d\.\d\d < floor 0\.25 on step 1$/);
  });

  it("hint 落空给出 hint_matched_nothing，步号在内", async () => {
    // A model answer naming a ref OUTSIDE this step's pool (PORT FIX): with a hint set,
    // that is exactly the "hint matched nothing" fact.
    installLayaRuntime(scriptedRuntime(scriptedAgent((key, _s, questions) => {
      const q = questions[key];
      if (!q) return undefined;
      if (q.type === "noul") return { noul: 0 };
      return { choice: "zz-bogus", probabilities: { "zz-bogus": 0.99 }, confidence: 0.99 };
    })));
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(dataUrl(`<button>Only thing</button>`));
    const mw = new BrowserMiddleware({ maxSteps: 2, reobserve: false });
    const rep = await mw.run("open it", page.url(), {
      page: asPage(page), pw, targetHint: "#nope", verbose: false,
    });
    await ctx.close();
    expect(rep.stop_code).toBe("hint_matched_nothing");
    expect(rep.stop_step).toBe(1);
    expect(rep.stop_reason).toContain("matched nothing");
  });

  it("`when` 不成立给出 precondition_skipped（done=true，不是失败）", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(dataUrl(`<div>hi</div>`));
    const mw = new BrowserMiddleware({ maxSteps: 2 });
    const rep = await mw.run("dismiss", page.url(), {
      page: asPage(page), pw, verbose: false,
      precondition: { css_exists: ["#never-there"] },
    });
    await ctx.close();
    expect(rep.done).toBe(true);
    expect(rep.skipped).toBe(true);
    expect(rep.stop_code).toBe("precondition_skipped");
  });

  it("DOM 信号命中给出 dom_goal_signal", async () => {
    chooser("Add", 0.99);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(fixture("testpages", "product.html"));
    const mw = new BrowserMiddleware({ maxSteps: 4 });
    const rep = await mw.run("add the Wireless Mouse X200 to the shopping cart", page.url(), {
      page: asPage(page), pw, verbose: false,
      goalSignalFn: (p: unknown) => checkSignal(p as never, { css_text_equals: ["[data-test='cart-count']", "1"] }),
      targetHint: "button[near~Wireless Mouse X200]",
    });
    await ctx.close();
    expect(rep.done).toBe(true);
    expect(rep.stop_code).toBe("dom_goal_signal");
    expect(rep.stop_reason).toBe("dom goal signal");
  });

  it("rules-only 无运行时给出 no_model_runtime，不是把没存在的模型说成\"低置信\"", async () => {
    // 不装 runtime：getLayaRuntime() 抛 LayaNotConfigured -> rulesOnly
    installLayaRuntime(null);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(dataUrl(`<button data-test="x">Target</button>`));
    const mw = new BrowserMiddleware({ maxSteps: 2 });
    const rep = await mw.run("click the ambiguous thing", page.url(), {
      page: asPage(page), pw, targetHint: null, verbose: false,
    });
    await ctx.close();
    expect(rep.stop_code).toBe("no_model_runtime");
    expect(rep.stop_reason).toContain("no model runtime");
    expect(rep.stop_reason).not.toContain("low confidence");
  });
});

/* ------------------------------------------------------------------ D5①: secret redaction */

describe("敏感字段遮蔽：值不落进快照/trace/报告（D5①）", () => {
  it("密码框被填后，trace 里的 value 是掩码不是明文", async () => {
    chooser("password", 0.99);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(dataUrl(`
      <input type="password" id="pw" name="password" placeholder="Password">
      <button id="go">Sign in</button>`));
    const mw = new BrowserMiddleware({ maxSteps: 4 });
    const rep = await mw.run("type the password", page.url(), {
      page: asPage(page), pw, verbose: false,
      targetHint: "#pw", slots: { password: "Sup3rS3cret" },
    });
    await ctx.close();
    const filled = rep.steps.find((s) => s.how === "filled");
    expect(filled).toBeTruthy();   // the password field should have been filled
    expect(JSON.stringify(filled)).not.toContain("Sup3rS3cret");
    expect(String(filled!.value)).toMatch(/^\*\*\*\(\d+\)$/);   // masked with a length digest
  });

  it("input[type=password/file/hidden] 的值不进 inert 快照比对（只留长度掩码）", () => {
    // VALS_JS 的源码守卫：password/file/hidden 三分支都在，且原值被 '*' 掩掉。
    const src = fs.readFileSync(path.join(REPO, "src", "executor.ts"), "utf-8");
    expect(/t === 'password'\s*\|\|\s*t === 'file'\s*\|\|\s*t === 'hidden'/.test(src)).toBe(true);
    // 遮蔽后仍保留长度，否则"改密码"这种动作会被误判成 inert。
    expect(/\*'\.repeat\(raw\.length\)/.test(src)).toBe(true);
  });

  it("信号读的是真实 DOM 值（掩码不挡住 css_value_equals 判完成）", async () => {
    chooser("password", 0.99);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(dataUrl(`<input type="password" id="pw" name="password">`));
    const mw = new BrowserMiddleware({ maxSteps: 4 });
    const rep = await mw.run("type the password", page.url(), {
      page: asPage(page), pw, verbose: false, targetHint: "#pw",
      slots: { password: "hunter2" },
      goalSignalFn: (p: unknown) => checkSignal(p as never, { css_value_equals: ["#pw", "hunter2"] }),
    });
    await ctx.close();
    expect(rep.done).toBe(true);
    expect(rep.stop_code).toBe("dom_goal_signal");
    // 完成了，但报告里查不到明文
    expect(JSON.stringify(rep)).not.toContain("hunter2");
  });
});

/* ------------------------------------------------------------------ D5②: navigation envelope */

describe("导航信封：hosts 运行期强制（D5②）", () => {
  it("disallowedHost 纯函数：子域放行、精确匹配、file/data 不拦、空列表关闸", () => {
    expect(disallowedHost("https://m.ctrip.com/x", ["ctrip.com"])).toBeNull();      // 子域
    expect(disallowedHost("https://ctrip.com/x", ["ctrip.com"])).toBeNull();        // 精确
    expect(disallowedHost("https://evil.example/x", ["ctrip.com"])).toBe("evil.example");
    expect(disallowedHost("file:///tmp/a.html", ["ctrip.com"])).toBeNull();          // 夹具
    expect(disallowedHost("https://anything/x", [])).toBeNull();                     // 空声明 = 不启用
    expect(disallowedHost("https://anything/x", undefined)).toBeNull();
    expect(disallowedHost("https://x.ctrip.com.evil.example/", ["ctrip.com"])).toBe("x.ctrip.com.evil.example");
  });

  it("goto 未声明主机：拒绝、0 步、0 副作用", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const mw = new BrowserMiddleware({ maxSteps: 2, hosts: ["allowed.example"] });
    let navigated = false;
    await page.route("**/*", () => { navigated = true; });
    const rep = await mw.run("go", "http://evil.example/page", { page: asPage(page), pw, verbose: false });
    await ctx.close();
    expect(rep.done).toBe(false);
    expect(rep.stop_code).toBe("host_not_allowed");
    expect(rep.steps.length).toBe(0);
    expect(navigated).toBe(false);   // refusal must happen BEFORE any navigation
  });

  it("动作后落到未声明主机：结构化停止（不是继续在上面点）", async () => {
    chooser("Leave", 0.99);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(dataUrl(`<a id="leave" href="http://evil.example/landed">Leave now</a>`));
    await page.route("http://evil.example/landed", (r) => r.fulfill({ status: 200, body: "<button>Offsite</button>" }));
    const mw = new BrowserMiddleware({ maxSteps: 4, hosts: ["good.example"] });
    const rep = await mw.run("click Leave now", page.url(), {
      page: asPage(page), pw, verbose: false, targetHint: "#leave",
    });
    await ctx.close();
    expect(rep.done).toBe(false);
    expect(rep.stop_code).toBe("host_not_allowed");
    // 动作真的执行了（诚实：不是假装没点），但停在这里、不再在越界页面上行动
    expect(rep.steps.some((s) => s.executed)).toBe(true);
    expect(rep.stop_reason).toContain("navigated off the envelope");
  });

  it("空 hosts 声明：行为与从前逐字节相同（夹具包不受影响）", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(dataUrl(`<button data-test="x">Only</button>`));
    const mw = new BrowserMiddleware({ maxSteps: 2, hosts: null });
    const rep = await mw.run("noop", page.url(), {
      page: asPage(page), pw, verbose: false, targetHint: "#nomatch", precondition: { css_exists: ["#ghost"] },
    });
    await ctx.close();
    expect(rep.skipped).toBe(true);
  });
});

/* ------------------------------------------------------------------ D6: config-class, never retried */

describe("配置类错误：启动期预检、永不重试（D6 / backlog I-1）", () => {
  it("NEVER_RETRY_CODES 含 config_error / host_not_allowed / needs_value / nominated_family_empty（确定性停因）", () => {
    expect([...NEVER_RETRY_CODES].sort()).toEqual([
      "config_error", "host_not_allowed", "needs_value", "nominated_family_empty",
    ]);
  });

  it("带 config_error 停因的子目标 retries=2 也**只跑一次**（重试同一个错 = 同一句话 N 遍）", async () => {
    let runs = 0;
    const mw = {
      async run() {
        runs += 1;
        return { done: false, steps: [], stop_reason: "model runtime config error: nope", stop_code: "config_error" };
      },
    };
    const plan = new TaskPlan("g", [], path.join("/tmp", `p0-cfg-${Date.now()}.json`));
    const sg = { desc: "x", signal: { url_contains: "y" }, retries: 2 } as Subgoal;
    const { rep, attempt } = await runSubgoalWithRetries(mw as never, sg, plan, "u", {}, {});
    expect(attempt).toBe(1);
    expect(runs).toBe(1);
    expect(rep.stop_code).toBe("config_error");
  });

  it("瞬时失败（无 config 码）照旧走满 retries——这次改动只掐配置类", async () => {
    let runs = 0;
    const mw = {
      async run() {
        runs += 1;
        return { done: false, steps: [], stop_reason: "low confidence", stop_code: "low_confidence" };
      },
    };
    const plan = new TaskPlan("g", [], path.join("/tmp", `p0-trans-${Date.now()}.json`));
    const sg = { desc: "x", signal: { url_contains: "y" }, retries: 2 } as Subgoal;
    const { attempt } = await runSubgoalWithRetries(mw as never, sg, plan, "u", {}, {});
    expect(attempt).toBe(3);
    expect(runs).toBe(3);
  });

  it("preflightConfig 拦下\"显式指向不存在的产物\"，但没配环境变量就放行", () => {
    const saved = process.env.LAYA_ONNX_MODEL;
    try {
      process.env.LAYA_ONNX_MODEL = "/tmp/definitely-missing-p0.onnx";
      expect(modelConfigError()).toContain("does not exist");
      expect(() => preflightConfig({ modelStatus: "on" })).toThrow(AppRunConfigError);
      // 规则层/桩层不看模型产物：预检不该拦住它们
      expect(() => preflightConfig({ modelStatus: "off(rules-only)" })).not.toThrow();
      expect(() => preflightConfig({ modelStatus: "off(scripted)" })).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.LAYA_ONNX_MODEL; else process.env.LAYA_ONNX_MODEL = saved;
    }
    expect(modelConfigError()).toBeNull();     // 没显式坏配置 = 层级归 off(missing)，照常跑
  });

  it("执行器自己遇到 config 级 runtime 故障 → 结构化 config_error，0 步 0 导航", async () => {
    // 装一个"load 就炸"的运行时：这不是"没产物走规则层"（LayaNotConfigured），是使用方指错了东西。
    installLayaRuntime({
      async load() { throw new Error("laya ONNX graph not found: /tmp/broken.onnx"); },
      embedFnFromAgent: () => null,
      async predictShortlist() { throw new Error("unreachable"); },
    });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    let navigated = false;
    await page.route("**/*", () => { navigated = true; });
    const mw = new BrowserMiddleware({ maxSteps: 2 });
    const rep = await mw.run("x", dataUrl(`<b>y</b>`), { page: asPage(page), pw, verbose: false });
    await ctx.close();
    expect(rep.done).toBe(false);
    expect(rep.stop_code).toBe("config_error");
    expect(rep.steps.length).toBe(0);
    expect(navigated).toBe(false);   // config refusal must happen BEFORE navigation
    expect(rep.stop_reason).toContain("/tmp/broken.onnx");
  });

  it("runOnce 的异常兜底保留 error: 前缀（真瞬时错误仍走重试）", async () => {
    const mw = { async run() { throw new Error("page died"); } };
    const plan = new TaskPlan("g", [], path.join("/tmp", `p0-err-${Date.now()}.json`));
    const sg = { desc: "x", signal: { url_contains: "y" } } as Subgoal;
    const rep = await runOnce(mw as never, sg, plan, "u", {}, {});
    expect(rep.stop_reason).toContain("error: Error: page died");
  });
});

/* ------------------------------------------------------------------ extractSlots 未回归 */

describe("既有行为不因 P0 形状改动漂移", () => {
  it("extract_slots 仍解析 ASCII key=value（数据袋归属计划）", () => {
    expect(extractSlots("shop: coupon=SAVE10")).toEqual({ shop: "coupon=SAVE10" });
  });
});
