/**
 * P4 声明式后继（docs/ARCHITECTURE_REVIEW.md §7-P4 行 + §5.1 的硬约束）。
 *
 * 三组：
 *   ① 纯函数 `plan.createPathWalk`：声明顺序、自然顺序回退、**路径上界/环检测**。
 *   ② 加载期：`next` 的落点必须在同一个旅程/计划里存在、步 id 唯一（指向空气的边
 *      拖到运行期才发现 = 一步都不走的静默分支）。
 *   ③ 端到端（真 chromium）：
 *      - 承重：`apps/cold-search-next` 的冷启动回边真的把 search 走了两遍，然后走下去；
 *        **删掉 `next` 即红**（同一条旅程，record 因 `when` 不成立被 skipped，不变量不成立）；
 *      - 环：无条件自环必须跑出显式 `path_stop`（不是挂死、不是栈溢出），步数有界；
 *      - 缺省等价：不声明 `next` 的包，走向仍是自然顺序；
 *      - 计划级 runner 对 `next` **响亮拒绝**，而不是静默忽略（否则"写了分支"与"跑了计划"分不清）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runApp, type AppRunResult } from "../src/app-runner.ts";
import { expandPack, loadPack, type AppPack } from "../src/app-pack.ts";
import { PlanningRules, TaskPlan, createPathWalk, DEFAULT_MAX_STEP_VISITS } from "../src/plan.ts";
import { runPlan } from "../src/planner.ts";
import { installLayaRuntime, scriptedRuntime, scriptedAgent } from "../src/model.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURE = pathToFileURL(path.join(REPO, "testpages", "cold-search.html")).href;

beforeAll(() => { installLayaRuntime(scriptedRuntime(scriptedAgent(() => ({ noul: 0.0 })))); });
afterAll(() => { installLayaRuntime(null); });

/** 展开一个内存里的包（写进临时目录，`loadPack` 才认）。 */
function packInTmp(id: string, pack: Record<string, unknown>): { pack: AppPack; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `amber-p4-${id}-`));
  const p = { spec_version: 1, id, label: id, goal: id, hosts: [], ...pack };
  fs.writeFileSync(path.join(dir, "pack.json"), JSON.stringify(p, null, 2), "utf-8");
  return { pack: loadPack(path.join(dir, "pack.json")), dir };
}

async function run(id: string, pack: Record<string, unknown>): Promise<AppRunResult> {
  const { pack: loaded, dir } = packInTmp(id, pack);
  return await runApp(loaded, {
    sources: false, verbose: false,
    planPath: path.join(dir, "plan.json"),
    outDir: dir,
  });
}

/* ------------------------------------------------------------------ ① 纯函数 */

describe("走向的唯一实现：声明顺序 → 自然顺序，且带路径上界", () => {
  const steps = [
    { id: "a", next: ["c", "b"] },
    { id: "b", next: null },
    { id: "c", next: ["a"] },
  ];

  it("声明顺序里第一个『此刻适用』的候选胜出；都不适用走自然顺序", async () => {
    const w = createPathWalk(steps);
    // c 适用 ⇒ 直接跳 c（声明在 b 前面）
    expect(await w.after(0, (j) => j === 2)).toBe(2);
    // c 不适用、b 适用 ⇒ b
    expect(await w.after(0, (j) => j === 1)).toBe(1);
    // 都不适用 ⇒ 自然顺序
    expect(await w.after(0, () => false)).toBe(1);
    // 没声明 next 的步 ⇒ 永远自然顺序
    expect(await w.after(1, () => true)).toBe(2);
  });

  it("进入计数到顶就是显式事实（默认上界 3 = 同一步最多进 3 次）", () => {
    const w = createPathWalk(steps);
    expect(DEFAULT_MAX_STEP_VISITS).toBe(3);
    expect(w.enter(2)).toBeNull();                       // 1
    expect(w.enter(2)).toBeNull();                       // 2
    expect(w.enter(2)).toBeNull();                       // 3
    expect(w.enter(2)).toEqual({ id: "c", visits: 4 });  // 4 ⇒ 停
    expect(w.visits()).toEqual({ c: 4 });
  });

  it("没有名字的步不进计数（自然顺序本就单调，不会重入）", () => {
    const w = createPathWalk([{ next: ["anon"] }, { id: "anon" }]);
    expect(w.enter(0)).toBeNull();
    expect(w.visits()).toEqual({});
  });

  it("落点 id 不存在 ⇒ 当『不适用的候选』处理，绝不抛栈", async () => {
    const w = createPathWalk([{ id: "a", next: ["ghost", "b"] }, { id: "b" }]);
    expect(await w.after(0, () => true)).toBe(1);
  });
});

/* ------------------------------------------------------------------ ② 加载期 */

describe("加载期：边必须落在真实存在的步上", () => {
  it("落点不存在 / 步 id 重复 ⇒ 应用包加载期红", () => {
    const { pack } = packInTmp("p4-bad", {
      journey: [
        { id: "a", desc: "a", start_url: "testpages/cold-search.html", next: ["nope"],
          signal: { css_exists: "body" } },
        { id: "a", desc: "b", start_url: "testpages/cold-search.html",
          signal: { css_exists: "body" } },
      ],
    });
    const p = new PlanningRules(12, true, false).problems(
      new TaskPlan(pack.goal, pack.journey as never, ":memory:", {}));
    expect(p.some((x) => /duplicate step id 'a'/.test(x))).toBe(true);
  });

  it("计划校验器（同一个走查器）点名落点不存在的边", () => {
    const plan = new TaskPlan("g", [
      { desc: "a", signal: { url_contains: "x" }, id: "a", next: ["ghost"] },
      { desc: "b", signal: { url_contains: "y" }, id: "b" },
    ], ":memory:");
    const issues = new PlanningRules().problems(plan);
    expect(issues.some((x) => /subgoal\[0\]\.next: "ghost" names no step in this plan/.test(x))).toBe(true);
  });

  it("`next`/`max_step_visits` 走磁盘往返不丢（合同面完整）", () => {
    const plan = new TaskPlan("g", [
      { desc: "a", signal: { url_contains: "x" }, id: "a", next: ["b"] },
      { desc: "b", signal: { url_contains: "y" }, id: "b" },
    ], ":memory:");
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "amber-p4-plan-")), "p.json");
    plan.path = tmp;
    plan.save();
    const back = TaskPlan.load(tmp)!;
    expect(back.subgoals[0]!.id).toBe("a");
    expect(back.subgoals[0]!.next).toEqual(["b"]);
  });
});

/* ------------------------------------------------------------------ ③ 端到端 */

describe("P4 端到端：冷启动回边（真 chromium，规则模式）", () => {
  const coldSearch = {
    slots: { q: "琥珀" },
    required_slots: ["q"],
    max_step_visits: 4,
    journey: [
      {
        id: "search",
        desc: "搜索 {q}（结果还没到位就再搜一遍）",
        start_url: FIXTURE,
        target_hints: ["[data-test=q]", "[data-test=search]"],
        slots: { q: "{q}" },
        when: { not: { css_text_contains: ["[data-test=results]", "结果 A"] } },
        next: ["search", "record"],
        signal: { css_text_contains: ["[data-test=status]", "搜索完成"] },
      },
      {
        id: "record",
        desc: "记录这一次搜索的结果",
        start_url: FIXTURE,
        target_hint: "[data-test=record]",
        when: { css_text_contains: ["[data-test=results]", "结果 A"] },
        signal: { css_text_equals: ["[data-test=recorded]", "已记录 2 条"] },
      },
    ],
    invariants: [{
      id: "results-recorded",
      desc: "结束状态下结果真的被记下来了",
      signal: { css_text_equals: ["[data-test=recorded]", "已记录 2 条"] },
    }],
  };

  it("回边真的走回来了：search 进入 2 次、record 1 次，旅程绿、零模型调用", async () => {
    const r = await run("p4-cold", coldSearch);
    expect(r.ok).toBe(true);
    expect(r.path_stop).toBeUndefined();
    expect(r.path_visits).toMatchObject({ search: 2, record: 1 });
    expect(r.invariants.every((i) => i.held)).toBe(true);
    expect(r.decisions?.model_asks ?? 0).toBe(0);        // 走向由声明与页面证据决定，不问模型
  });

  it("删 `next` 即红：没有回边时 record 被 `when` 跳过，结束状态不变量不成立", async () => {
    const stripped = {
      ...coldSearch,
      journey: coldSearch.journey.map((s) => {
        const { next: _drop, ...rest } = s as Record<string, unknown> & { next?: unknown };
        return rest;
      }),
    };
    const r = await run("p4-cold-nonext", stripped);
    expect(r.ok).toBe(false);                                  // 能力在承重，不是装饰
    expect(r.subgoals[1]!.status).toBe("skipped");             // record 没有被走到
    expect(r.invariants.find((i) => i.id === "results-recorded")!.held).toBe(false);
  });

  it("环：无条件自环跑到上界就停，给出结构化 `path_stop`（不挂死、不栈溢出）", async () => {
    const t0 = Date.now();
    const r = await run("p4-cycle", {
      slots: { q: "琥珀" },
      max_step_visits: 3,
      journey: [{
        id: "loop",
        desc: "搜索 {q} 然后无条件回到自己",
        start_url: FIXTURE,
        target_hints: ["[data-test=q]", "[data-test=search]"],
        slots: { q: "{q}" },
        next: ["loop"],
        signal: { css_text_contains: ["[data-test=status]", "搜索完成"] },
      }],
    });
    expect(r.ok).toBe(false);
    expect(r.path_stop).toMatchObject({ code: "next_cycle", step_id: "loop", visits: 4 });
    expect(r.path_stop!.detail).toMatch(/per-path bound max_step_visits=3/);
    expect(r.subgoals[0]!.status).toBe("blocked");
    expect(Date.now() - t0).toBeLessThan(60_000);              // 上界是真的，不是"等它自己停"
  });

  it("缺省等价：不声明 `next` 的包，走向仍是自然顺序（进入次数各 1）", async () => {
    const linear = {
      slots: { q: "琥珀" },
      // 一个两步直线旅程：第一步是暖启动（sessionStorage 里先塞一次），第二步记录
      journey: [
        {
          id: "s1",
          desc: "先搜一次",
          start_url: FIXTURE,
          target_hints: ["[data-test=q]", "[data-test=search]"],
          slots: { q: "{q}" },
          signal: { css_text_contains: ["[data-test=status]", "搜索完成"] },
        },
      ],
      invariants: [{ id: "searched", desc: "搜过", signal: { css_text_contains: ["[data-test=status]", "搜索完成"] } }],
    };
    const r = await run("p4-linear", linear);
    expect(r.ok).toBe(true);
    // 声明了 id 但**没有回边**：结果里连 `path_visits` 都不出现（新字段不该只是"多一行"）。
    expect(r.path_visits).toBeUndefined();
    expect(r.path_stop).toBeUndefined();
  });

  it("混合旅程：浏览器步的 `next` 可以指向工具步（边按整个旅程校验，不按计划的子集）", () => {
    const { pack } = packInTmp("p4-mixed", {
      journey: [
        { id: "search", desc: "搜索", start_url: "testpages/cold-search.html", next: ["archive"],
          signal: { css_exists: "body" } },
        { id: "archive", desc: "归档", source: "demo-tool", args: [], signal: { exit_ok: 0 } },
      ],
    });
    // 工具步不进计划；只看计划会说 "archive" 不存在——extraIds 让边按旅程校验。
    expect(() => expandPack(pack, {}, ":memory:")).not.toThrow();
    const { pack: bad } = packInTmp("p4-mixed-bad", {
      journey: [
        { id: "search", desc: "搜索", start_url: "testpages/cold-search.html", next: ["ghost"],
          signal: { css_exists: "body" } },
      ],
    });
    expect(() => expandPack(bad, {}, ":memory:")).toThrow(/names no step in this journey/);
  });

  it("前向分支能绿：被边跨过的步记成 skipped 并单列 `path_crossed`（不与 when 的跳过混为一谈）", async () => {
    // 注意 `when` 会被问**两次**：选边时问在来源页上，进入该步时问在它自己的 start_url 上。
    // 所以跨页分支的守卫要写成"页面角色级"的事实（两页都成立），而不是只在一页成立的东西。
    const forward = {
      journey: [
        { id: "add", desc: "把商品加入购物车", start_url: "testpages/product.html",
          target_hint: "[data-test=add-to-cart]", next: ["back"],
          signal: { css_text_equals: ["[data-test=cart-count]", "1"] } },
        { id: "crossed-arm", desc: "另一条臂：这一次不会被走到", start_url: "testpages/cart.html",
          target_hint: "[data-test=logo]", signal: { url_contains: "product.html" } },
        { id: "back", desc: "走这一条臂：从购物车页回到商品页", start_url: "testpages/cart.html",
          target_hint: "[data-test=logo]",
          when: { css_exists: "[data-test=logo]" },      // 两页都有：跨页守卫
          signal: { url_contains: "product.html" } },
      ],
      invariants: [{ id: "on-product", desc: "结束在商品页", signal: { url_contains: "product.html" } }],
    };
    const r = await run("p4-forward", forward);
    expect(r.ok).toBe(true);
    expect(r.subgoals.map((s) => s.status)).toEqual(["done", "skipped", "done"]);
    expect(r.path_crossed).toEqual(["crossed-arm (crossed by `next` from add)"]);
  });

  it("工具步的环也停在上界，且 `completed` 数的是**声明出来的步**（不是跑了几趟）", async () => {
    const r = await run("p4-tool-cycle", {
      max_step_visits: 2,
      journey: [{
        id: "t1", desc: "自环的工具步", source: "demo-tool", args: [], next: ["t1"],
        signal: { exit_ok: 0 },
      }],
    });
    expect(r.ok).toBe(false);
    expect(r.path_stop).toMatchObject({ code: "next_cycle", step_id: "t1", visits: 3 });
    expect(r.subgoals).toEqual([]);                       // 没有浏览器步
    expect(r.completed).toBe("1/1");                      // 不是 3/1
    expect(r.path_visits).toEqual({ t1: 3 });
  });

  it("计划级 runner 对 `next` 响亮拒绝（静默忽略一条边是最坏选项）", async () => {
    const plan = new TaskPlan("g", [
      { desc: "a", signal: { url_contains: "x" }, id: "a", next: ["b"] },
      { desc: "b", signal: { url_contains: "y" }, id: "b" },
    ], ":memory:");
    const fake = { run: async () => ({ done: true, steps: [], stop_reason: "dom goal signal" }) };
    await expect(runPlan(fake as never, plan, { replan: false, verbose: false }))
      .rejects.toThrow(/runPlan cannot honour `next` edges/);
  });

  it("展开出来的步带 id/next（走向按名字，不按位置）", () => {
    const { pack } = packInTmp("p4-expand", {
      journey: [
        { id: "a", desc: "a", start_url: "testpages/cold-search.html", next: ["b"],
          signal: { css_exists: "body" } },
        { id: "b", desc: "b", start_url: "testpages/cold-search.html",
          signal: { css_exists: "body" } },
      ],
    });
    const ex = expandPack(pack, {}, ":memory:");
    expect(ex.steps.map((s) => s.id)).toEqual(["a", "b"]);
    expect(ex.steps[0]!.next).toEqual(["b"]);
    expect(ex.steps[1]!.next).toEqual([]);
    // 浏览器步的 id/next 也落到计划里（同一个合同面）
    expect(ex.plan.subgoals[0]!.id).toBe("a");
    expect(ex.plan.subgoals[0]!.next).toEqual(["b"]);
  });

  it("`max_step_visits` 非法就是加载期红", () => {
    const { pack } = packInTmp("p4-visits", {
      max_step_visits: 0,
      journey: [{ id: "a", desc: "a", start_url: "testpages/cold-search.html", signal: { css_exists: "body" } }],
    });
    expect(() => expandPack(pack, {}, ":memory:")).toThrow(/max_step_visits must be a positive integer/);
  });
});
