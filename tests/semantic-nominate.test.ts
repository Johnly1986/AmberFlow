/**
 * NL Flow S2 试点（docs/NL_FLOW_DESIGN.md §4/§10-S2）——提名步的**编译面**。
 *
 * 五组钉子：
 *   ① 校验：`instr` 必须在闭集内；`instr` 锁要求 `nominate: true`；提名步不许 dangerous
 *      （不可逆步永不进提名闭集——它永远是显式声明的 dangerous 步）。
 *   ② 编译：`nominate` 步把 `list_step` **降格为 list_pick 候选参数**（kind 仍是 browser、
 *      携带 `list_candidate`）；缺档案 list_extract = 编译期红（行选择器是站点知识）。
 *   ③ 缺省等价：不声明 nominate/instr 的模板，编译结果与今天同形（无新字段）；
 *      声明了 list_step 的普通步照旧走 kind "list"。
 *   ④ 候选序：`instr` 锁坍缩候选集；list_pick 只在候选参数齐备时在序内；缺省序 = S0 那张。
 *   ⑤ 提名梯级在编译产物上端到端：①规则弃权的 desc → ⑤枚举头；②档案命中 → learned。
 */
import { describe, expect, it } from "vitest";
import {
  compileFlow, executableInstructionOrder, validateTemplate,
  type CompiledStep, type FlowTemplate, type SiteProfile,
} from "../src/semantic-flow.ts";
import { createInstructionMemory } from "../src/semantic-instructions.ts";
import { LearnedStore } from "../src/semantic.ts";
import { nominateInstruction } from "../src/nominate.ts";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const template = (steps: unknown[]): FlowTemplate => ({
  spec_version: 2,
  id: "nom-app",
  label: "nom-app",
  goal: "nom-app",
  model: "english",
  slots: {},
  sites: { "site-x": { label: "site-x", start_url: "file:///home.html" } },
  pages: { home: "home.html", done: "done.html" },
  steps: steps as FlowTemplate["steps"],
  invariants: [],
});

const PROFILE: SiteProfile = {
  spec_version: 2,
  site: "site-x",
  list_extract: {
    "pick": { row_sel: "tr.flight-item", fields: { price: { sel: ".price", op: "int" } }, act_sel: ".btn-pick" },
    "lp": { row_sel: "tr.flight-item", fields: { price: { sel: ".price", op: "int" } }, act_sel: ".btn-pick" },
  },
} as never;

const problemsOf = (steps: unknown[]): string[] => validateTemplate(template(steps));

describe("①校验：instr 闭集、锁要求 nominate、提名步不许 dangerous", () => {
  it("instr 不在闭集内 ⇒ 红（列出闭集）", () => {
    const p = problemsOf([{ id: "s", desc: "d", page: "home", signal: { page: "done" }, nominate: true, instr: "delete_all" }]);
    expect(p.some((x) => /instr must be one of click\|fill\|select\|check\|list_pick/.test(x))).toBe(true);
  });

  it("instr 没有 nominate: true ⇒ 红（锁挂在一个没开的梯级上）", () => {
    const p = problemsOf([{ id: "s", desc: "d", page: "home", signal: { page: "done" }, instr: "click" }]);
    expect(p.some((x) => /instr locks the nomination ladder/.test(x))).toBe(true);
  });

  it("nominate + dangerous ⇒ 红（不可逆步永不进提名闭集）", () => {
    const p = problemsOf([{ id: "s", desc: "d", page: "home", signal: { page: "done" }, nominate: true, dangerous: true }]);
    expect(p.some((x) => /nominating step cannot be dangerous/.test(x))).toBe(true);
  });

  it("nominate 非布尔 ⇒ 红；合法组合（nominate + instr）无问题", () => {
    expect(problemsOf([{ id: "s", desc: "d", page: "home", signal: { page: "done" }, nominate: "yes" }]))
      .toEqual(["steps[0].nominate must be a boolean"]);
    expect(problemsOf([{ id: "s", desc: "d", page: "home", signal: { page: "done" }, nominate: true, instr: "click" }]))
      .toEqual([]);
  });

  it("锁到不可执行的指令 ⇒ 红（复核实测：曾经放行 → 运行期静默降级 + 谎报提名）", () => {
    // `list_pick` 的参数（op/by/act）是声明的；没有 list_step 候选就执行不了这条指令。
    const p = problemsOf([{ id: "s", desc: "d", page: "home", signal: { page: "done" },
      nominate: true, instr: "list_pick" }]);
    expect(p.some((x) => /instr "list_pick" needs a list_step candidate/.test(x))).toBe(true);
    // 带候选参数就合法（行选择器仍在档案里，运行期由 list_extract 提供）
    expect(problemsOf([{ id: "s", desc: "d", page: "home", signal: { page: "done" },
      nominate: true, instr: "list_pick", list_step: { op: "min", by: "price", act: "row" } }])).toEqual([]);
  });
});

describe("②编译：nominate 步把 list_step 降格为 list_pick 候选参数", () => {
  const step = {
    id: "pick", desc: "处理航班列表", page: "home",
    semantic_target: { role: "button", text: "选择" },
    signal: { page: "done" },
    nominate: true,
    list_step: { op: "min", by: "price", act: "row" },
  };

  it("kind 仍是 browser，list_candidate 携带声明参数（不是 kind list）", () => {
    expect(validateTemplate(template([step]))).toEqual([]);
    const compiled: CompiledStep = compileFlow(template([step]), "site-x", PROFILE).steps[0]!;
    expect(compiled.kind).toBe("browser");
    expect(compiled.nominate).toBe(true);
    expect(compiled.list_candidate).toMatchObject({ op: "min", by: "price" });
    expect(compiled.list).toBeUndefined();
  });

  it("候选参数缺档案 list_extract ⇒ 编译期红（与 list 步同一纪律）", () => {
    const noProfile: SiteProfile = { spec_version: 2, site: "site-x" } as never;
    let threw = "";
    try { compileFlow(template([step]), "site-x", noProfile); } catch (e) { threw = String((e as Error).message); }
    expect(threw).toMatch(/list_extract\.pick/);
  });

  it("缺省等价：无新键的模板照旧编译（无 nominate 字段）；普通 list_step 照旧 kind list", () => {
    const plain: unknown[] = [
      { id: "go", desc: "打开", page: "home", semantic_target: { role: "button", text: "前往" }, signal: { page: "done" } },
      { id: "lp", desc: "最低价", page: "home", signal: { page: "done" }, list_step: { op: "min", by: "price", act: "row" } },
    ];
    expect(validateTemplate(template(plain))).toEqual([]);
    const compiled = compileFlow(template(plain), "site-x", PROFILE).steps;
    expect(compiled[0]!.kind).toBe("browser");
    expect("nominate" in compiled[0]!).toBe(false);      // 新字段整个不出现（缺省等价纪律）
    expect("instr" in compiled[0]!).toBe(false);
    expect(compiled[1]!.kind).toBe("list");              // 普通 list_step 不受影响
    expect("list_candidate" in compiled[1]!).toBe(false);
  });
});

describe("④⑤候选序与梯级端到端（编译产物上）", () => {
  const step = (over: Partial<CompiledStep>): CompiledStep => ({
    id: "pick", desc: "处理航班列表", kind: "browser", url: "file:///home.html", sg: null,
    dangerous: false, targets: [], pageFile: "home.html",
    signal: { url_contains: "done" }, signal_source: "contract", nominate: true, ...over,
  });

  it("instr 锁坍缩候选集；list_pick 只在候选参数齐备时在序内；非提名步 = 空序", () => {
    expect(executableInstructionOrder(step({ instr: "list_pick" }))).toEqual(["list_pick"]);
    expect(executableInstructionOrder(step({}))).toEqual(["click", "fill", "select", "check"]);
    expect(executableInstructionOrder(step({
      list_candidate: { cfg: PROFILE.list_extract!["pick"]!, op: "min", by: "price" },
    }))).toEqual(["click", "fill", "select", "check", "list_pick"]);
    expect(executableInstructionOrder(step({ nominate: false }))).toEqual([]);
  });

  it("梯级端到端：①弃权的 desc → ⑤枚举头（click）；②档案命中 → learned（list_pick）", async () => {
    const nom = await nominateInstruction({ desc: "处理航班列表" });
    expect(nom).toMatchObject({ instruction: "click", via: "enumerate" });
    // 同一步换到②档：学到的 list_pick 映射被命中（学习环接上之后这就是二跑的稳态）
    const { store } = { store: new LearnedStore(fs.mkdtempSync(path.join(os.tmpdir(), "nom-e2e-"))) };
    const mem = createInstructionMemory(store, "site-x");
    mem.recordInstruction("nom-app/site-x/pick", "list_pick", "teacher");
    const learned = await nominateInstruction({
      desc: "处理航班列表", stepKey: "nom-app/site-x/pick", memory: mem,
    });
    expect(learned).toMatchObject({ instruction: "list_pick", via: "learned" });
  });
});

/* ------------------------------------------------- 试点 e2e：学 → 摊销 → drift → 再学 */

import { runFlow, type FlowRunResult } from "../src/semantic-flow.ts";

const PAGE = (body: string): string =>
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;

/** 提名试点夹具：一张票价表 + act 按钮 → done 页；act_sel 可注入坏值（drift 臂用）。 */
function nominateApp(opts: { actSel: string; instr?: string }): { appsDir: string; site: string; profileDir: string; fixAct: () => void } {
  const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-nom-"));
  const dir = path.join(appsDir, "flight-nominate");
  const pagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-nom-pages-"));
  const rows = [[980, "F3"], [1150, "F5"], [1280, "F1"]].map(([p, fno]) =>
    `<tr class="flight-item"><td class="fno">${fno}</td><td class="price">${p}</td>`
    + `<td><button class="btn-pick" data-pick="${p}" onclick="location.href='done.html?p=${p}'">选择</button></td></tr>`)
    .join("");
  fs.writeFileSync(path.join(pagesDir, "home.html"),
    PAGE(`<table id="fares">${rows}</table>`), "utf-8");
  fs.writeFileSync(path.join(pagesDir, "done.html"), PAGE("<h1>done</h1>"), "utf-8");
  fs.mkdirSync(path.join(dir, "sites"), { recursive: true });
  fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({
    spec_version: 2, id: "flight-nominate", label: "flight-nominate", goal: "flight-nominate",
    model: "english", slots: {},
    sites: { "site-x": { label: "site-x", start_url: `file://${path.join(pagesDir, "home.html")}` } },
    pages: { home: "home.html", done: "done.html" },
    steps: [{
      id: "pick", desc: "记录当前列表最低价航班", page: "home", nominate: true,
      list_step: { op: "min", by: "price", act: "row" },
      ...(opts.instr ? { instr: opts.instr } : {}),
      signal: { page: "done" },
    }],
    invariants: [],
  }, null, 2), "utf-8");
  const profilePath = path.join(dir, "sites", "site-x.profile.json");
  const writeProfile = (actSel: string, instructions?: Record<string, unknown>): void => {
    fs.writeFileSync(profilePath, JSON.stringify({
      spec_version: 2, site: "site-x",
      list_extract: { pick: { row_sel: "tr.flight-item", fields: { price: { sel: ".price", op: "int" } }, act_sel: actSel } },
      ...(instructions ? { instructions } : {}),
    }, null, 2), "utf-8");
  };
  writeProfile(opts.actSel);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-nom-prof-"));
  return {
    appsDir, site: "site-x", profileDir,
    fixAct: (): void => writeProfile(".btn-pick"),
  };
}

describe("S2 试点 e2e（真 chromium）：学 → 摊销 → drift 撤下 → 再学", () => {
  it("首跑 ①规则提名 list_pick → 重放门落盘；二跑 ②档案命中（证据序）且 replays_ok 累加", { timeout: 180_000 }, async () => {
    const app = nominateApp({ actSel: ".btn-pick" });
    const run = async (): Promise<FlowRunResult> => runFlow("flight-nominate", app.site, {
      appsDir: app.appsDir, profileDir: app.profileDir, laya: "scripted", verbose: false,
    });
    const r1 = await run();
    expect(r1.ok).toBe(true);
    const s1 = r1.steps.find((s) => s.id === "pick")!;
    expect(s1.status).toBe("done");
    expect(s1.nominated).toEqual({ instruction: "list_pick", via: "rule" });
    const profPath = path.join(app.profileDir, "site-x.profile.json");
    const after1 = JSON.parse(fs.readFileSync(profPath, "utf-8"));
    expect(after1.instructions.pick).toMatchObject({ instruction: "list_pick", replays_ok: 1, method: "rule" });
    // S4：提名账单（dead-rung 自报——哪档从没出场一眼可见）
    expect(r1.nominate_bill).toMatchObject({ via: { rule: 1 }, committed: 1, dropped: 0 });
    // 二跑：②档案命中（证据序——学过的映射优先于全局关键词），重放计数累加
    const r2 = await run();
    expect(r2.ok).toBe(true);
    expect(r2.steps.find((s) => s.id === "pick")!.nominated).toEqual({ instruction: "list_pick", via: "learned" });
    const after2 = JSON.parse(fs.readFileSync(profPath, "utf-8"));
    expect(after2.instructions.pick.replays_ok).toBe(2);
  });

  it("漂移臂：坏映射（②命中但执行失败）×2 → drift 撤下；修好后 ① 接管并再学", { timeout: 180_000 }, async () => {
    // act_sel 指向不存在的按钮：②的已学映射（list_pick）命中了也执行不成——drift 的靶子
    const app = nominateApp({ actSel: ".btn-missing" });
    const profPath = path.join(app.profileDir, "site-x.profile.json");
    // 种子写进**学习档案**（profileDir），不是模板包的 authored 档案——两份文件别混
    fs.mkdirSync(app.profileDir, { recursive: true });
    fs.writeFileSync(profPath, JSON.stringify({
      host: "site-x", steps: {},
      instructions: { pick: { instruction: "list_pick", replays_ok: 3 } },
    }, null, 2), "utf-8");
    const run = async (): Promise<FlowRunResult> => runFlow("flight-nominate", app.site, {
      appsDir: app.appsDir, profileDir: app.profileDir, laya: "scripted", verbose: false,
    });
    // run1：②命中坏映射 → blocked，失败计数 1
    const r1 = await run();
    expect(r1.ok).toBe(false);
    expect(r1.steps.find((s) => s.id === "pick")!.nominated).toEqual({ instruction: "list_pick", via: "learned" });
    expect(r1.steps.find((s) => s.id === "pick")!.status).toBe("blocked");
    // run2：失败计数 2 → drift 撤下（报告点名），步如实仍 blocked（不是静默绿）
    const r2 = await run();
    expect(r2.ok).toBe(false);
    expect(r2.drift.length).toBe(1);
    expect(r2.drift[0]).toMatchObject({ step: "pick", hint: "list_pick", failures: 2 });
    // S4 账单：②档出场 1、drift 1——与报告行同一份账（不是另算一个数）
    expect(r2.nominate_bill).toMatchObject({ via: { learned: 1 }, drift: 1 });
    expect(JSON.parse(fs.readFileSync(profPath, "utf-8")).instructions.pick).toBeUndefined();
    // 修好 act_sel → run3：②已空、①规则接管 list_pick → done → 再学（重放门落盘）
    app.fixAct();
    const r3 = await run();
    expect(r3.ok).toBe(true);
    expect(r3.steps.find((s) => s.id === "pick")!.nominated).toEqual({ instruction: "list_pick", via: "rule" });
    const after3 = JSON.parse(fs.readFileSync(profPath, "utf-8"));
    expect(after3.instructions.pick).toMatchObject({ instruction: "list_pick", replays_ok: 1 });
  });

  it("`instr` 锁：跳过梯级（via locked）、仍过重放门落盘（method 如实记 locked）", { timeout: 180_000 }, async () => {
    const app = nominateApp({ actSel: ".btn-pick", instr: "list_pick" });
    const r = await runFlow("flight-nominate", app.site, {
      appsDir: app.appsDir, profileDir: app.profileDir, laya: "scripted", verbose: false,
    });
    expect(r.ok).toBe(true);
    expect(r.steps.find((s) => s.id === "pick")!.nominated).toEqual({ instruction: "list_pick", via: "locked" });
    const prof = JSON.parse(fs.readFileSync(path.join(app.profileDir, "site-x.profile.json"), "utf-8"));
    expect(prof.instructions.pick).toMatchObject({ instruction: "list_pick", replays_ok: 1, method: "locked" });
    expect(r.nominate_bill).toMatchObject({ via: { locked: 1 }, committed: 1 });
  });

  it("消融口 --no-verify-backfill 同款：按现状落盘但 replays_ok 停在 0（没验过如实可见）", { timeout: 180_000 }, async () => {
    const app = nominateApp({ actSel: ".btn-pick" });
    const r = await runFlow("flight-nominate", app.site, {
      appsDir: app.appsDir, profileDir: app.profileDir, laya: "scripted", verbose: false,
      verifyBackfill: false,
    });
    expect(r.ok).toBe(true);
    const prof = JSON.parse(fs.readFileSync(path.join(app.profileDir, "site-x.profile.json"), "utf-8"));
    expect(prof.instructions.pick).toMatchObject({ instruction: "list_pick", replays_ok: 0 });
    expect(r.nominate_bill).toMatchObject({ via: { rule: 1 }, committed: 1 });
  });

  it("已知边界（钉子）：元素动作提名**不约束**执行器的动作分类——试点只强制 list_pick 轴", { timeout: 180_000 }, async () => {
    // 锁 click、语义目标落到一个按钮：执行器照旧按元素类型执行。报告如实记
    // via=locked/instruction=click，但**这不是"指令被强制执行"的证据**——
    // 元素动作的指令约束要等 S3 组合层。本钉子防的是把这条边界读成"已强制"。
    const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-click-"));
    const dir = path.join(appsDir, "flight-nominate");
    const pagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-click-pages-"));
    fs.writeFileSync(path.join(pagesDir, "home.html"),
      PAGE('<button data-test="go" onclick="location.href=\'done.html\'">前往</button>'), "utf-8");
    fs.writeFileSync(path.join(pagesDir, "done.html"), PAGE("<h1>done</h1>"), "utf-8");
    fs.mkdirSync(path.join(dir, "sites"), { recursive: true });
    fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({
      spec_version: 2, id: "flight-nominate", label: "x", goal: "x", model: "english", slots: {},
      sites: { "site-x": { label: "site-x", start_url: `file://${path.join(pagesDir, "home.html")}` } },
      pages: { home: "home.html", done: "done.html" },
      steps: [{ id: "pick", desc: "open the result page", page: "home", nominate: true, instr: "click",
        semantic_target: { role: "button", text: "前往" }, signal: { page: "done" } }],
      invariants: [],
    }, null, 2), "utf-8");
    fs.writeFileSync(path.join(dir, "sites", "site-x.profile.json"),
      JSON.stringify({ spec_version: 2, site: "site-x" }, null, 2), "utf-8");
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-click-prof-"));
    const r = await runFlow("flight-nominate", "site-x", { appsDir, profileDir, laya: "scripted", verbose: false });
    expect(r.ok).toBe(true);
    expect(r.steps.find((s) => s.id === "pick")!.nominated).toEqual({ instruction: "click", via: "locked" });
    // 证据：这条锁 click 的步走的是**浏览器支线**（kind=browser，元素由既有梯级解析——
    // 这里没有已学 hint，所以是 scripted 语义替身那一档），不是被指令强制的列表腿。
    const s = r.steps.find((x) => x.id === "pick")!;
    expect(s.kind).toBe("browser");
    expect(s.methods.length).toBeGreaterThan(0);
    // 元素动作的提名**不进指令记忆**（没有可复现重放证据；它的摊销证据属 hint 环）。
    // 注意：hint 记忆的 flush 会落一份（可能是空的）档案——所以断的是**指令段**没有这条。
    const profPath = path.join(profileDir, "site-x.profile.json");
    const prof = fs.existsSync(profPath) ? JSON.parse(fs.readFileSync(profPath, "utf-8")) : {};
    expect(prof.instructions?.pick).toBeUndefined();
  });
});
