/**
 * P2 命令层（docs/ARCHITECTURE_REVIEW.md §6.1/§7-P2）：把 `run()` 里揉在一起的
 * "实例化动作空间 / 选择 / 应用动作"显式切开的**声明半 + 实例化半**。
 *
 * 三段各自钉死，且证明"这是重新装箱、不是新能力"：
 *   ① 加载期：`validateCommands` 对着引擎能力面 `COMMAND_OPS` 校（未知 op/重复 id/
 *      缺参跳参/参数来源非 slot ⇒ 红）；红线②——参数只能 `{"from":"slot"}`。
 *   ② 运行期纯函数：`instantiateSpace` = 声明 × 当次观察；解析不到的候选出局、
 *      被禁的出局、`skip` 恒可选。**不退回全池、不问模型**。
 *   ③ 执行：命令式 `fill` 用**具名绑定**的值，不再走 `_slotValue` 子串猜测
 *      （radio 反例那类"把值交给错元素"在闭集里不可能发生）。
 *
 * 落地用例 = SkyBook"勾选 + 提交"放进**一个子目标**（ARCHITECTURE.md §七.9 的未解边界）：
 * 点 `#select-all`（onchange 触发导航到 `selected=all`）后，池重扫，第二条 `#record-selected`
 * 对新池解析、点击、账本落字、`#hotel-recorded` 信号成立——两步动作、一个子目标、零模型调用。
 * 缺省等价：不写 `commands` 时 space 永不构造，整循环逐字节同今天（负例④）。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import * as browserEnv from "../src/browser-env.ts";
import { BrowserMiddleware, type AnyPage, type PwLike } from "../src/executor.ts";
import type { Elem, ElemPool } from "../src/extraction.ts";
import {
  COMMAND_OPS, instantiateSpace, resolveCommandValue, validateCommands, type CommandDecl,
} from "../src/actions.ts";
import { installLayaRuntime, scriptedRuntime, scriptedAgent } from "../src/model.ts";
import { PlanningRules, TaskPlan } from "../src/plan.ts";
import { checkSignal } from "../src/signals.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const pw: PwLike = { chromium: chromium as unknown as PwLike["chromium"] };
const asPage = (p: Page): AnyPage => p as unknown as AnyPage;

function el(ref: string, tag = "button", label = "", kw: Partial<Elem> = {}): Elem {
  return { ref, scan: Number(ref.replace(/\D/g, "")) || 0, tag, label, data_test: "", name: "", id: "", input_type: "", href: "", ...kw };
}
const pool = (...es: Elem[]): ElemPool => Object.fromEntries(es.map((e) => [e.ref!, e]));

let browser: Browser;
beforeAll(async () => { browser = (await browserEnv.launch(pw)) as unknown as Browser; }, 120_000);
afterAll(async () => { await browser?.close(); installLayaRuntime(null); });

/* ------------------------------------------------------------------ ① 加载期 */

describe("命令层声明半：对着引擎能力面校验", () => {
  const problems = (cmds: unknown, slots?: Set<string>): string[] => {
    const p: string[] = [];
    validateCommands(cmds, "sg", p, slots);
    return p;
  };

  it("合法闭集全过：click + fill（slot 绑定）+ skip", () => {
    const cmds: CommandDecl[] = [
      { id: "fill-q", op: "fill", target: "#q", value: { from: "slot", key: "query" } },
      { id: "submit", op: "click", target: "input[type=submit]" },
      { id: "maybe", op: "skip" },
    ];
    expect(problems(cmds, new Set(["query"]))).toEqual([]);
  });

  it("未知 op ⇒ 红（能力面只认 COMMAND_OPS）", () => {
    const p0 = problems([{ id: "x", op: "teleport", target: "#a" }])[0]!;
    expect(p0).toMatch(/unknown command op "teleport"/);
    expect(p0).toContain(COMMAND_OPS.join("|"));
  });

  it("重复 id ⇒ 红（闭集要一个名字一个候选）", () => {
    const cmds = [{ id: "a", op: "click", target: "#1" }, { id: "a", op: "click", target: "#2" }];
    expect(problems(cmds).some((p) => /duplicate command id 'a'/.test(p))).toBe(true);
  });

  it("fill 缺 value ⇒ 红；参数来源不在能力面上 ⇒ 红（红线②落地）", () => {
    expect(problems([{ id: "f", op: "fill", target: "#q" }])[0]).toMatch(/needs value/);
    // P3 把来源面从 slot 扩到 slot|option|list，NL Flow S1 再扩到 dataset（bindings.BINDING_SOURCES），
    // 但"谁选值"一个字没松：`model` 仍然不是一条来源。
    expect(problems([{ id: "f", op: "fill", target: "#q", value: { from: "model", key: "x" } as never }])
      .some((p) => /value\.from must be one of slot\|option\|list\|dataset \(got "model"\)/.test(p))).toBe(true);
  });

  it("参数键必须声明过（给了 slotKeys 就顺带校）", () => {
    const p = problems([{ id: "f", op: "fill", target: "#q", value: { from: "slot", key: "nope" } }], new Set(["query"]));
    expect(p.some((x) => /value.key "nope" is not a declared slot/.test(x))).toBe(true);
  });

  it("click 不许带 value、skip 不许带 target", () => {
    expect(problems([{ id: "c", op: "click", target: "#a", value: { from: "slot", key: "k" } }])
      .some((p) => /op 'click' takes no value/.test(p))).toBe(true);
    expect(problems([{ id: "s", op: "skip", target: "#a" }])[0]).toMatch(/op 'skip' takes no target/);
  });

  it("PlanningRules 也走同一个校验器（冻结计划不新开第三套语法）", () => {
    const plan = new TaskPlan("g", [{ desc: "x", signal: { url_contains: "y" },
      commands: [{ id: "b", op: "fly", target: "#a" }] }], ":memory:");
    const issues = new PlanningRules().problems(plan);
    expect(issues.some((i) => /unknown command op "fly"/.test(i))).toBe(true);
  });
});

/* ------------------------------------------------------------------ ② 实例化半 */

describe("命令层实例化半：纯函数，声明 × 当次观察", () => {
  it("解析不到的候选出局；被禁的出局；skip 恒可选", () => {
    const elems = pool(el("e0", "button", "Go", { id: "go" }), el("e1", "button", "Later", { id: "later" }));
    const cmds: CommandDecl[] = [
      { id: "record", op: "click", target: "#ghost" },   // 池里没有 ⇒ unresolved
      { id: "check", op: "check", target: "#go" },       // 解析到 e0
      { id: "skip-step", op: "skip" },                    // 恒 live
      { id: "submit", op: "click", target: "#later" },    // 解析到 e1，但下面禁掉它
    ];
    const space = instantiateSpace(cmds, elems, new Set(["e1"]));
    expect(space.unresolved).toEqual(["record"]);
    expect(space.forbidden).toEqual(["submit"]);
    expect(space.live.map((c) => c.decl.id)).toEqual(["check", "skip-step"]);  // 声明顺序、去禁、去未解析
    expect(space.live[0]!.ref).toBe("e0");
    expect(space.live[1]!.ref).toBe("");                                       // skip 无落点
  });

  it("resolveCommandValue：值只从计划槽位按名字来；缺键 ⇒ needs_value（不是猜）", () => {
    const cmd: CommandDecl = { id: "f", op: "fill", target: "#q", value: { from: "slot", key: "query" } };
    expect(resolveCommandValue(cmd, { query: "asyncio" })).toEqual({ ok: true, value: "asyncio" });
    const miss = resolveCommandValue(cmd, {});
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.reason).toMatch(/never invented/);
  });
});

/* ------------------------------------------------------------------ ③ 执行用例 */

describe("P2 用例：SkyBook「勾选 + 提交」放进一个子目标（今天不可表达 → 可表达）", () => {
  beforeAll(() => {
    installLayaRuntime(scriptedRuntime(scriptedAgent(() => ({ noul: 0.0 }))));  // 装个桩，若真被问 model 步会显形
  });

  it("两步命令、一个子目标、零模型调用，结束状态落账", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const startUrl = pathToFileURL(path.join(REPO, "transfer", "site2", "hotels.html")).href
      + "?city=Beijing&checkin=2026-10-07&cap=300&sort=price_asc";
    // 只在"选目标"的问题（choice）上计数：风险闸门的 noul 是闸门不是选择器，
    // 闭集不许碰的是前者。
    let choiceAsked = false;
    installLayaRuntime(scriptedRuntime(scriptedAgent((key, _s, q) => {
      const qq = q[key];
      if (qq && qq.type === "choice") choiceAsked = true;
      return { noul: 0.0 };
    })));
    const mw = new BrowserMiddleware({ maxSteps: 6 });
    const rep = await mw.run("select all shown hotels and record them", startUrl, {
      page: asPage(page), pw, verbose: false,
      commands: [
        { id: "check", op: "click", target: "#select-all" },
        { id: "record", op: "click", target: "#record-selected" },
      ],
      // 完成真相仍是子目标信号（红线③）：账本落字才算 done。
      goalSignalFn: (p: unknown) => checkSignal(p as never, { css_text_contains: ["#hotel-recorded", "Recorded"] }),
    });
    await ctx.close();
    expect(rep.done).toBe(true);
    expect(rep.stop_code).toBe("dom_goal_signal");
    expect(choiceAsked, "the closed set must never ask the model to PICK").toBe(false);
    // 两个动作都真执行了，而且是在同一个子目标里（两次点击、两条 executed 痕迹）
    const acted = rep.steps.filter((s) => s.executed);
    expect(acted.map((s) => s.command)).toEqual(["check", "record"]);
    expect(acted.every((s) => s.method === "rule:match")).toBe(true);
  });

  it("命令式 fill：值走具名绑定（不是 _slotValue 子串猜测），trace 记 command", async () => {
    installLayaRuntime(scriptedRuntime(scriptedAgent(() => ({ noul: 0.0 }))));
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(path.join(REPO, "testpages", "cart.html")).href);
    const mw = new BrowserMiddleware({ maxSteps: 4 });
    const rep = await mw.run("enter the coupon", page.url(), {
      page: asPage(page), pw, verbose: false,
      slots: { coupon: "SAVE10" },
      commands: [{ id: "fill-coupon", op: "fill", target: "[data-test=coupon]", value: { from: "slot", key: "coupon" } }],
      goalSignalFn: (p: unknown) => checkSignal(p as never, { css_value_equals: ["[data-test=coupon]", "SAVE10"] }),
    });
    await ctx.close();
    expect(rep.done).toBe(true);
    const fill = rep.steps.find((s) => s.how === "filled");
    expect(fill).toBeTruthy();
    expect((fill as Record<string, unknown>).command).toBe("fill-coupon");
    expect(fill!.value).toBe("SAVE10");   // 非敏感字段：值如实记（红线②来自计划，不是猜）
  });

  it("缺值：命令式 fill 声明了却没绑到 ⇒ needs_value 结构化停，绝不猜", async () => {
    installLayaRuntime(scriptedRuntime(scriptedAgent(() => ({ noul: 0.0 }))));
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(path.join(REPO, "testpages", "cart.html")).href);
    const mw = new BrowserMiddleware({ maxSteps: 4 });
    const rep = await mw.run("enter the coupon", page.url(), {
      page: asPage(page), pw, verbose: false,
      slots: {},                            // 数据袋里没有 coupon
      commands: [{ id: "fill-coupon", op: "fill", target: "[data-test=coupon]", value: { from: "slot", key: "coupon" } }],
    });
    await ctx.close();
    expect(rep.done).toBe(false);
    expect(rep.stop_code).toBe("needs_value");
    expect(rep.stop_reason).toMatch(/never guessed|not in the plan/i);
  });

  it("闭集空 ⇒ space_empty 结构化停（不退回全池、不问模型）", async () => {
    let choiceAsked = false;
    installLayaRuntime(scriptedRuntime(scriptedAgent((k, _s, q) => {
      if (q[k] && q[k].type === "choice") choiceAsked = true;
      return { noul: 0.0 };
    })));
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(path.join(REPO, "testpages", "cart.html")).href);
    const mw = new BrowserMiddleware({ maxSteps: 4 });
    const rep = await mw.run("do the impossible", page.url(), {
      page: asPage(page), pw, verbose: false,
      commands: [{ id: "ghost", op: "click", target: "#does-not-exist-anywhere" }],
    });
    await ctx.close();
    expect(rep.done).toBe(false);
    expect(rep.stop_code).toBe("space_empty");
    expect(rep.stop_reason).toMatch(/never falls back to the full pool/);
    expect(choiceAsked).toBe(false);
  });
});

/* ------------------------------------------------------------------ ④ 缺省等价 */

describe("缺省等价：不写 commands 时 space 永不构造", () => {
  it("PlanningRules 对无 commands 的旧计划不产新 problem", () => {
    const plan = new TaskPlan("g", [{ desc: "x", signal: { url_contains: "y" }, target_hint: "#a" }], ":memory:");
    expect(new PlanningRules().problems(plan)).toEqual([]);
  });

  it("TaskPlan 往返保留 commands（disk 权威）", () => {
    const cmds: CommandDecl[] = [{ id: "c", op: "click", target: "#x" }];
    const plan = new TaskPlan("g", [{ desc: "x", signal: { url_contains: "y" }, commands: cmds }], ":memory:");
    expect(plan.subgoals[0]!.commands).toEqual(cmds);
  });
});
