/**
 * SemanticFlow —— 语义模板 + 站点档案 + 三级解析回填环（docs/SEMANTIC_FLOW_TRANSFER_PLAN.md）。
 *
 * 钉住的验收（M1）：
 *   - 同一模板同站二跑：escalate/laya 次数 → 0（全部规则/list 命中，零模型成本）；
 *   - 回填有门：新条目 replays_ok=0 起步，真的被重放命中才 +1；
 *   - 跨站迁移：两站 DOM/页名/标签完全不同，hint 档案按站点隔离、互不泄漏；
 *   - "判断最低价"是数据规则：list_step 对价格列求 min，与手算一致；
 *   - ③老师点名只在 DOM 信号成立时才回填；dangerous 步默认拒绝。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  compileFlow, flowReportMarkdown, listFlowApps, loadSiteProfile, loadTemplate,
  runFlow, validateProfile, validateTemplate,
} from "../src/semantic-flow.ts";
import {
  LearnedStore, SiteProfileMemory, matchSemanticTarget, semanticToHint,
} from "../src/semantic.ts";
import {
  installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer, type Question,
} from "../src/model.ts";
import { BrowserMiddleware, browserSession } from "../src/executor.ts";
import { selectBest, selectIndex, type Source } from "../src/datasource.ts";
import { observeLocale } from "../src/semantic.ts";
import { checkSignal } from "../src/signals.ts";

afterAll(() => installLayaRuntime(null));

const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "semantic-"));

/* ---------------------------------------------------------------- 匹配器 */

describe("matchSemanticTarget — 语义目标在 criteria view 上的分层匹配", () => {
  const crit = {
    e0: 'a "机票预订" -> search.html',
    e1: 'a "酒店住宿" -> index.html',
    e2: 'input "出发城市"',
    e3: 'button "5月18日" [test=chip-may18]',
    e4: 'button "5月17日" [test=chip-may17]',
    e5: 'link "Flights" [test=tab-flights]',
  };

  it("文案等值优先于包含（跨语言站点的等值词赢），role 过滤生效", () => {
    // 双语候选里 "Flights" 与 e5 等值 → 等值档先赢；"机票" 只是 e0 的包含档。
    expect(matchSemanticTarget({ role: "link", text: ["机票", "Flights"] }, crit)).toBe("e5");
    expect(matchSemanticTarget({ role: "link", text: "机票" }, crit)).toBe("e0");
    // role=input 不会命中 a 标签。
    expect(matchSemanticTarget({ role: "input", text: "机票" }, crit)).toBeNull();
  });

  it("唯一性：多档命中要落在最强非空档里", () => {
    // "5月18日" 等值唯一。
    expect(matchSemanticTarget({ role: "button", text: "5月18日" }, crit)).toBe("e3");
    // "5月" 包含两档（e3/e4）→ 歧义如实返回 null，绝不猜。
    expect(matchSemanticTarget({ role: "button", text: "5月" }, crit)).toBeNull();
  });

  it("data_test 是最强档：命中即唯一，落空即 null（不猜文案）", () => {
    expect(matchSemanticTarget({ data_test: "chip-may18" }, crit)).toBe("e3");
    expect(matchSemanticTarget({ data_test: "nope" }, crit)).toBeNull();
  });

  it("near 是过滤器：不满足即淘汰", () => {
    expect(matchSemanticTarget({ role: "link", text: "机票", near: "search.html" }, crit)).toBe("e0");
    expect(matchSemanticTarget({ role: "link", text: "机票", near: "不存在" }, crit)).toBeNull();
  });

  it("未知 role 宁可空手也不猜", () => {
    expect(matchSemanticTarget({ role: "wizard", text: "机票" }, crit)).toBeNull();
  });
});

describe("semanticToHint — 只认稳定句柄，绝不发明选择器", () => {
  it("data_test → [data-test=…]", () => {
    expect(semanticToHint({ data_test: "search-submit" })).toBe("[data-test=search-submit]");
  });
  it("纯语义目标（role/text）不产生 hint —— hint 由运行时学习产生", () => {
    expect(semanticToHint({ role: "button", text: "搜索" })).toBeNull();
  });
});

/* ---------------------------------------------------------------- 档案存储 */

describe("LearnedStore + SiteProfileMemory — 回填环的证据面", () => {
  it("record 落盘、reload 可读、重放计数只增", () => {
    const dir = tmpDir();
    const store = new LearnedStore(dir);
    const mem = new SiteProfileMemory(store, "site-a");
    mem.registerSteps([["打开首页", "open-flights"], ["搜索", "submit-search"]]);
    const key = mem.key("file:///x/index.html", "打开首页");
    expect(mem.lookup(key)).toBeNull();          // 未学：稳态路径不存在
    mem.record(key, "[id=nav-flight]");          // ③回填（执行器在 DOM 信号成立时调用）
    expect(mem.recordedThisRun.has("open-flights")).toBe(true);
    // 落盘 + 重读
    const mem2 = new SiteProfileMemory(store, "site-a");
    mem2.registerSteps([["打开首页", "open-flights"]]);
    expect(mem2.lookup(mem2.key("file:///y/index.html", "打开首页"))).toBe("[id=nav-flight]");
    expect(mem2.getSteps()["open-flights"]!.replays_ok).toBe(0);   // 还没被重放验证
    mem2.countReplay("open-flights");                              // 二跑真的靠它规则命中
    expect(new LearnedStore(dir).load("site-a").steps["open-flights"]!.replays_ok).toBe(1);
    // 覆写同值不重置计数；改 hint 才重新从 0 计数（改版自愈）。
    mem2.record(mem2.key("u", "打开首页"), "[id=nav-flight]");
    expect(mem2.getSteps()["open-flights"]!.replays_ok).toBe(1);
    mem2.record(mem2.key("u", "打开首页"), "[data-test=nav]");
    expect(mem2.getSteps()["open-flights"]!.replays_ok).toBe(0);
  });

  it("authored 先验可见、learned 覆盖 authored", () => {
    const dir = tmpDir();
    const store = new LearnedStore(dir);
    store.save("s", { host: "s", steps: { "a-step": { hint: "[data-test=learned]", replays_ok: 2 } } });
    const mem = new SiteProfileMemory(store, "s", { "a-step": { hint: "[id=authored]", replays_ok: 0 } });
    mem.registerSteps([["desc-a", "a-step"]]);
    expect(mem.lookup(mem.key("u", "desc-a"))).toBe("[data-test=learned]");
  });

  it("坏档案响亮报错（证据面不许静默损坏）", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "bad.profile.json"), JSON.stringify({
      host: "bad", steps: { x: { hint: "", replays_ok: 0 } },
    }), "utf-8");
    expect(() => new LearnedStore(dir).load("bad")).toThrow(/hint must be a non-empty string/);
    fs.writeFileSync(path.join(dir, "bad2.profile.json"), "{not json");
    expect(() => new LearnedStore(dir).load("bad2")).toThrow(/not valid JSON/);
  });
});

/* ---------------------------------------------------------------- 编译 */

describe("compileFlow — 模板 + 站点档案 → 各站真步骤（信号建在页面角色契约上）", () => {
  const template = loadTemplate("flight-cheapest");

  it("模板与两站档案都过校验", () => {
    expect(validateTemplate(template)).toEqual([]);
    for (const site of ["site-a", "site-b"]) {
      expect(validateProfile(loadSiteProfile("flight-cheapest", site), template)).toEqual([]);
    }
  });

  it("同一步的完成信号按站点解析为该站的落点页 URL 子串", () => {
    const a = compileFlow(template, "site-a", loadSiteProfile("flight-cheapest", "site-a"));
    const b = compileFlow(template, "site-b", loadSiteProfile("flight-cheapest", "site-b"));
    const pickDate = (c: typeof a): unknown => c.steps.find((s) => s.id === "pick-date")!.signal;
    // 落点页 = results 角色：site-a 是 results.html，site-b 是档案覆盖的 fare-list.html。
    expect(JSON.stringify(pickDate(a))).toContain("results.html");
    expect(JSON.stringify(pickDate(b))).toContain("fare-list.html");
    // 查询契约含日期槽位（值来自数据袋）。
    expect(JSON.stringify(pickDate(a))).toContain("date=05-18");
    // open-flights 的落点页是 search 角色，不是本步出发的 home——这是"信号页 ≠ 出发页"的回归钉。
    expect((a.steps[0]!.signal as Record<string, string>).url_contains).toBe("search.html");
  });

  it("fill_keys 把站点字段键绑到模板槽位（值绑定是站点知识）", () => {
    const a = compileFlow(template, "site-a", loadSiteProfile("flight-cheapest", "site-a"));
    const b = compileFlow(template, "site-b", loadSiteProfile("flight-cheapest", "site-b"));
    expect(a.steps[1]!.sg!.slots).toEqual({ "出发城市": "昆明", "到达城市": "北京" });
    expect(b.steps[1]!.sg!.slots).toEqual({ "dep-city": "昆明", "arr-city": "北京" });
  });

  it("语义目标里的日期文案是槽位（编译期替换）", () => {
    const a = compileFlow(template, "site-a", loadSiteProfile("flight-cheapest", "site-a"));
    const pickDate = a.steps.find((s) => s.id === "pick-date")!;
    expect(pickDate.targets[0]!.text).toContain("5月18日");
  });

  it("槽位覆盖必须指向已声明的槽位；坏档案/缺配置在编译期响亮报错", () => {
    const prof = loadSiteProfile("flight-cheapest", "site-a");
    expect(() => compileFlow(template, "site-a", prof, { coupn: "X" }))
      .toThrow(/not declared by template/);
    const broken: typeof prof = { ...prof, fill_keys: {} };
    expect(() => compileFlow(template, "site-a", broken)).toThrow(/fill_keys\.submit-search/);
    const noExtract: typeof prof = { ...prof, list_extract: {} };
    expect(() => compileFlow(template, "site-a", noExtract)).toThrow(/list_extract\.pick-cheapest/);
    expect(() => compileFlow(template, "ghost", prof)).toThrow(/not declared by template/);
  });

  it("页面角色档案覆盖生效（site-b 的五页全部不同名）", () => {
    const b = compileFlow(template, "site-b", loadSiteProfile("flight-cheapest", "site-b"));
    expect(b.steps.map((s) => s.url.split("/").pop()!.split("?")[0])).toEqual([
      "home.html", "fare-query.html", "fare-list.html", "fare-list.html", "fare-buy.html",
    ]);
  });
});

/* ---------------------------------------------------------------- 回填环（真浏览器） */

const reportOf = async (site: string, profileDir: string, opts: Parameters<typeof runFlow>[2] = {}) =>
  runFlow("flight-cheapest", site, {
    laya: "scripted", allowDangerous: true, profileDir, verbose: false, ...opts,
  });

describe("三级解析回填环 — 复刻站 A/B（真 chromium，离线 scripted 决策面）", () => {
  it("首跑：语义步由 laya 现场选、回填，且新条目必须过整跑重放门才落盘（replays_ok=1）", { timeout: 180_000 }, async () => {
    const dir = tmpDir();
    const r = await reportOf("site-a", dir, { fresh: true });
    expect(r.ok).toBe(true);
    expect(r.counts.laya).toBeGreaterThanOrEqual(3);
    expect(r.counts.backfilled).toBe(3);
    // 红线 2：3 条全部在**同一次运行内**的零模型整跑重放里被验证过，才落盘。
    expect(r.backfill_gate).toBe("verified");
    expect(r.verified_backfill.sort()).toEqual(["open-flights", "pick-date", "purchase"]);
    expect(r.unverified_backfill).toEqual([]);
    // "判断最低价"是数据规则：05-18 的价格列 [1280,1150,980,1330,1060]，min=F3 ¥980。
    const list = r.steps.find((s) => s.id === "pick-cheapest")!;
    expect(list.status).toBe("done");
    expect(list.detail!.chosen).toEqual({ price: "¥980", flight: "F3" });
    // 落盘的条目 replays_ok=1：重放门通过了一次，不是"先写下来以后再验"。
    const learned = JSON.parse(fs.readFileSync(path.join(dir, "site-a.profile.json"), "utf-8")) as
      { steps: Record<string, { hint: string; replays_ok: number }> };
    expect(learned.steps["open-flights"]).toEqual({ hint: "[id=nav-flight]", replays_ok: 1, method: "laya" });
  });

  it("二跑（M1 验收）：全部规则/list 命中，零模型；已学 hint 的重放计数 +1", { timeout: 180_000 }, async () => {
    const dir = tmpDir();
    const r1 = await reportOf("site-a", dir, { fresh: true });
    const backfilled = r1.steps.filter((s) => s.backfilled).map((s) => s.id);
    expect(backfilled).toContain("open-flights");
    const r2 = await reportOf("site-a", dir);
    expect(r2.ok).toBe(true);
    expect(r2.counts.laya).toBe(0);
    expect(r2.counts.escalate).toBe(0);
    expect(r2.counts.rule).toBeGreaterThanOrEqual(4);
    expect(r2.counts.list).toBe(1);
    // 首跑回填过的步，二跑必须真的以规则命中（重放证据），不许再问模型。
    for (const id of backfilled) {
      expect(r2.steps.find((s) => s.id === id)!.hint_used).toBe(true);
    }
    // 二跑没有新回填 → 没有新门要过；重放计数从 1 累到 2。
    expect(r2.backfill_gate).toBe("none");
    const learned = JSON.parse(fs.readFileSync(path.join(dir, "site-a.profile.json"), "utf-8")) as
      { steps: Record<string, { replays_ok: number }> };
    expect(learned.steps["open-flights"]!.replays_ok).toBe(2);
    expect(learned.steps["purchase"]!.replays_ok).toBe(2);
  });

  it("跨站迁移：第二站的 DOM/页名/标签完全不同，档案按站点隔离、hint 互不相同", { timeout: 120_000 }, async () => {
    const dirA = tmpDir();
    const dirB = tmpDir();
    const ra1 = await reportOf("site-a", dirA, { fresh: true });
    const rb1 = await reportOf("site-b", dirB, { fresh: true });
    expect(ra1.ok).toBe(true);
    expect(rb1.ok).toBe(true);
    // 迁移到新站：语义步现场决策并回填本站自己的 hint。
    expect(rb1.counts.backfilled).toBeGreaterThanOrEqual(2);
    const la = JSON.parse(fs.readFileSync(path.join(dirA, "site-a.profile.json"), "utf-8")) as
      { steps: Record<string, { hint: string }> };
    const lb = JSON.parse(fs.readFileSync(path.join(dirB, "site-b.profile.json"), "utf-8")) as
      { steps: Record<string, { hint: string }> };
    expect(la.steps["open-flights"]!.hint).toBe("[id=nav-flight]");
    expect(lb.steps["open-flights"]!.hint).toBe("[data-test=tab-flights]");
    // 第二站二跑同样收敛为零模型（这就是"模板迁移一次，站点收敛一次"）。
    const rb2 = await reportOf("site-b", dirB);
    expect(rb2.ok).toBe(true);
    expect(rb2.counts.laya).toBe(0);
    expect(rb2.counts.escalate).toBe(0);
    // 两站选中的最低价一致（同一 URL 契约、同一日期数据）：F3 ¥980。
    const chosenB = rb2.steps.find((s) => s.id === "pick-cheapest")!.detail!.chosen as Record<string, string>;
    expect(chosenB["flight"]).toBe("F3");
    expect(chosenB["price"]).toMatch(/980/);
  });

  it("③老师通道：laya 永不过闸时 escalate 点名，信号成立才回填", { timeout: 120_000 }, async () => {
    const dir = tmpDir();
    const r = await reportOf("site-a", dir, { fresh: true, laya: "unsure", escalate: "scripted" });
    expect(r.ok).toBe(true);
    expect(r.counts.escalate).toBeGreaterThanOrEqual(3);
    expect(r.counts.laya).toBe(0);
    expect(r.counts.backfilled).toBe(3);
    const learned = JSON.parse(fs.readFileSync(path.join(dir, "site-a.profile.json"), "utf-8")) as
      { steps: Record<string, { method?: string }> };
    expect(learned.steps["open-flights"]!.method).toBe("escalate");
    // 老师的提名也要过重放门：二跑同样零模型。
    const r2 = await reportOf("site-a", dir, { laya: "unsure", escalate: "scripted" });
    expect(r2.counts.escalate).toBe(0);
    expect(r2.counts.rule).toBeGreaterThanOrEqual(4);
  });

  it("红线 3：dangerous 步默认拒绝——显式 refused 结果，旅程不算通过", { timeout: 120_000 }, async () => {
    const dir = tmpDir();
    const r = await reportOf("site-a", dir, { fresh: true, allowDangerous: false });
    expect(r.ok).toBe(false);
    const purchase = r.steps.find((s) => s.id === "purchase")!;
    expect(purchase.status).toBe("refused");
    expect(purchase.attempts).toBe(0);
    expect(purchase.obstacle).toMatch(/危险步未放行/);
    expect(r.counts.refused).toBe(1);
  });

  it("危险步放行后，购买动作的真实完成由 done 页信号验收（不变量）", { timeout: 120_000 }, async () => {
    const dir = tmpDir();
    const r = await reportOf("site-a", dir, { fresh: true });
    expect(r.ok).toBe(true);
    expect(r.invariants).toHaveLength(1);
    expect(r.invariants[0]!.held).toBe(true);
  });

  it("报告面：解析级行与逐步表格如实呈现（rule/laya/escalate/backfill 四列计数）", { timeout: 120_000 }, async () => {
    const dir = tmpDir();
    const r = await reportOf("site-b", dir, { fresh: true });
    const md = flowReportMarkdown(r);
    expect(md).toMatch(/解析级：rule \d+ · laya \d+ · escalate \d+ \(written back \d+\) · list 1 · blocked 0/);
    expect(md).toContain("判断最低价机票并选中最低价的航班");
    expect(md).toContain("list_step 细节");
  });
});

/* ---------------------------------------------------------------- 执行器硬化 */

describe("执行器硬化：不回答 act 的运行时必须阻塞而不是崩", () => {
  // 页面故意让 affordance 规则打不中（指令无 CJK、标签是中文、token 不相交），
  // 这样才会真的问到模型——硬化测的是"模型缺席/乱答"时的行为。
  const hardPage = (): string => {
    const p = path.join(os.tmpdir(), `semantic-hard-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
    fs.writeFileSync(p, '<button data-test=go onclick="document.title=\'DONE\'">确认</button>', "utf-8");
    return `file://${p}`;
  };
  const GOAL = "press the confirm control";
  const SIGNAL = { css_text_equals: ["[data-test=go]", "确认"] };

  it("scripted 运行时只答 r/d（无 act 提名）→ 子目标 blocked，带明确 stop_reason", { timeout: 60_000 }, async () => {
    installLayaRuntime(scriptedRuntime(scriptedAgent((_key: string): Answer | undefined => undefined)));
    const mw = new BrowserMiddleware({ maxSteps: 2, confirmFn: () => true });
    const rep = await mw.run(GOAL, hardPage(), {
      goalSignalFn: (p) => checkSignal(p as never, SIGNAL), verbose: false,
    });
    expect(rep.done).toBe(false);
    expect(rep.stop_reason).toMatch(/exhausted|no target|no model/);
  });

  it("act 提名了不存在的 ref 时同样如实阻塞（fail closed）", { timeout: 60_000 }, async () => {
    installLayaRuntime(scriptedRuntime(scriptedAgent((key: string, _s: unknown, q: Record<string, Question>): Answer | undefined => {
      if (key !== "act") return { noul: 0.05 };
      const keys = Object.keys((q["act"]!.criteria ?? {}) as Record<string, unknown>);
      return { choice: "e999", probabilities: Object.fromEntries(keys.map((k) => [k, 1 / keys.length])), confidence: 0.9 };
    })));
    const mw = new BrowserMiddleware({ maxSteps: 2, confirmFn: () => true });
    const rep = await mw.run(GOAL, hardPage(), {
      goalSignalFn: (p) => checkSignal(p as never, SIGNAL), verbose: false,
    });
    expect(rep.done).toBe(false);
    expect(rep.stop_reason).toMatch(/names no target/);
  });
});

/* ---------------------------------------------------------------- §3 文字系统路由 */

describe("observeLocale — 文字系统结论落成档案数据（§3）", () => {
  it("<html lang> 的声明优先（站点自己的陈述最强）", () => {
    expect(observeLocale("zh-CN", "Hello world")).toEqual({ locale: "zh-cn", checkpoint: "multilingual" });
    expect(observeLocale("en", "你好世界")).toEqual({ locale: "en", checkpoint: "english" });
    expect(observeLocale("ja", "")).toEqual({ locale: "ja", checkpoint: "multilingual" });
  });

  it("没有声明时按 CJK 占比（> 0.2）——Router 的脚本判据", () => {
    expect(observeLocale(null, "在携程订一张5月18日的机票")).toEqual({ locale: "zh", checkpoint: "multilingual" });
    expect(observeLocale(null, "book the cheapest flight")).toEqual({ locale: "en", checkpoint: "english" });
    expect(observeLocale(undefined, "")).toEqual({ locale: "en", checkpoint: "english" });
  });

  it("档案的 checkpoint 真的决定模型面（不是死字段）", { timeout: 180_000 }, async () => {
    const a = await reportOf("site-a", tmpDir(), { fresh: true });
    expect(a.checkpoint).toBe("multilingual");
    expect(a.locale).toBe("zh");
    const b = await reportOf("site-b", tmpDir(), { fresh: true });
    expect(b.checkpoint).toBe("english");
    expect(b.locale).toBe("en");
  });

  it("坏 checkpoint / 空 locale 在加载期响亮报错", () => {
    const t = loadTemplate("flight-cheapest");
    const prof = loadSiteProfile("flight-cheapest", "site-a");
    expect(validateProfile({ ...prof, checkpoint: "turkish" as never }, t))
      .toEqual([expect.stringContaining("checkpoint must be one of")]);
    expect(validateProfile({ ...prof, locale: "  " }, t))
      .toEqual([expect.stringContaining("locale must be a non-empty string")]);
  });
});

/* ---------------------------------------------------------------- 回填门（红线 2） */

describe("SiteProfileMemory — 回填门：不可复现即不存", () => {
  it("staged：record 只进内存；commitVerified 只放行验证过的，其余撤回", () => {
    const dir = tmpDir();
    const store = new LearnedStore(dir);
    const mem = new SiteProfileMemory(store, "s", {}, { staged: true });
    mem.registerSteps([["a", "step-a"], ["b", "step-b"]]);
    mem.record(mem.key("u", "a"), "[id=a]");
    mem.record(mem.key("u", "b"), "[id=b]");
    // 门还没过：磁盘上一个字节都没有。
    expect(fs.existsSync(store.pathFor("s"))).toBe(false);
    expect(mem.stagedSteps().sort()).toEqual(["step-a", "step-b"]);
    const { committed, dropped } = mem.commitVerified(new Set(["step-a"]));
    expect(committed).toEqual(["step-a"]);
    expect(dropped).toEqual(["step-b"]);
    const file = new LearnedStore(dir).load("s");
    expect(file.steps["step-a"]!.replays_ok).toBe(1);      // 重放通过才 +1
    expect(file.steps["step-b"]).toBeUndefined();          // 没通过 → 一个字节都不落
  });

  it("staged：撤回时把**原来的**条目还原，不是删掉了事", () => {
    const dir = tmpDir();
    new LearnedStore(dir).save("s", { host: "s", steps: { "step-a": { hint: "[id=old]", replays_ok: 3 } } });
    const mem = new SiteProfileMemory(new LearnedStore(dir), "s", {}, { staged: true });
    mem.registerSteps([["a", "step-a"]]);
    mem.record(mem.key("u", "a"), "[id=new]");            // 改版：新 hint 还没过门
    mem.discardPending();
    expect(new LearnedStore(dir).load("s").steps["step-a"])
      .toEqual({ hint: "[id=old]", replays_ok: 3 });
  });

  it("连续失败计数 + drift 撤下；一次重放成功即清零（自愈）", () => {
    const dir = tmpDir();
    new LearnedStore(dir).save("s", { host: "s", steps: { "step-a": { hint: "[id=a]", replays_ok: 1 } } });
    const mem = new SiteProfileMemory(new LearnedStore(dir), "s", {});
    mem.registerSteps([["a", "step-a"]]);
    expect(mem.countFailure("step-a")).toBe(1);
    expect(mem.countFailure("step-a")).toBe(2);
    expect(new LearnedStore(dir).load("s").steps["step-a"]!.failures).toBe(2);
    mem.countReplay("step-a");
    expect(new LearnedStore(dir).load("s").steps["step-a"]!.failures).toBeUndefined();
    expect(mem.dropHint("step-a")).toBe("[id=a]");
    expect(new LearnedStore(dir).load("s").steps["step-a"]).toBeUndefined();
  });

  it("readOnly（writeProfile=false）：一切改动只留在内存", () => {
    const dir = tmpDir();
    const store = new LearnedStore(dir);
    const mem = new SiteProfileMemory(store, "s", {}, { staged: true, readOnly: true });
    mem.registerSteps([["a", "step-a"]]);
    mem.record(mem.key("u", "a"), "[id=a]");
    mem.commitVerified(new Set(["step-a"]));
    mem.flush();
    expect(fs.existsSync(store.pathFor("s"))).toBe(false);
  });
});

/* ---------------------------------------------------------------- 回填门 / drift 的端到端 */

/** 一个临时语义应用：模板 + 站点档案 + file:// 页面，全部落在临时目录。 */
function tempApp(opts: {
  id: string;
  pages: Record<string, string>;
  steps: unknown[];
  files: Record<string, string>;
  profile?: Record<string, unknown>;
  slots?: Record<string, string>;
}): { appsDir: string; site: string; home: string } {
  const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-app-"));
  const dir = path.join(appsDir, opts.id);
  const pagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-pages-"));
  fs.mkdirSync(path.join(dir, "sites"), { recursive: true });
  for (const [name, html] of Object.entries(opts.files)) {
    fs.writeFileSync(path.join(pagesDir, name), html, "utf-8");
  }
  const home = `file://${path.join(pagesDir, "home.html")}`;
  const site = "site-x";
  fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({
    spec_version: 2, id: opts.id, label: opts.id, goal: opts.id,
    model: "english", slots: opts.slots ?? {},
    sites: { [site]: { label: site, start_url: home } },
    pages: opts.pages, steps: opts.steps, invariants: [],
  }, null, 2), "utf-8");
  fs.writeFileSync(path.join(dir, "sites", `${site}.profile.json`),
    JSON.stringify({ spec_version: 2, site, ...(opts.profile ?? {}) }, null, 2), "utf-8");
  return { appsDir, site, home };
}

const PAGE = (body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;

describe("回填门的端到端证据（真 chromium）", () => {
  // 目标只在**第 1 次加载**存在：现场那一次能点（laya 选中、信号成立、回填），
  // 但门控的整跑零模型重放是第 2 次加载 —— hint 命不中 → 这一步不可复现。
  const ONCE = tempApp({
    id: "once-app",
    pages: { home: "home.html", second: "second.html" },
    steps: [{
      id: "go", desc: "open the second page", page: "home",
      semantic_target: { role: "button", text: "前往" },
      signal: { page: "second" },
    }],
    files: {
      "home.html": PAGE('<button id="go" data-test="go-btn" onclick="location.href=\'second.html\'">前往</button>'
        + "<script>var n=Number(sessionStorage.getItem('loads')||'0')+1;sessionStorage.setItem('loads',String(n));"
        + "if(n>1){var b=document.getElementById('go');if(b)b.remove();}</script>"),
      "second.html": PAGE("<h1>second</h1>"),
    },
  });
  const onceRun = (profileDir: string, extra: Parameters<typeof runFlow>[2] = {}) =>
    runFlow("once-app", ONCE.site, {
      appsDir: ONCE.appsDir, profileDir, laya: "scripted", verbose: false, ...extra,
    });

  it("回填了但重放不可复现 → 撤回、不落盘（红线 2）", { timeout: 120_000 }, async () => {
    const dir = tmpDir();
    const r = await onceRun(dir, { fresh: true });
    // 现场那一次是成功的：第 1 次加载有目标，laya 选中、信号成立。
    expect(r.ok).toBe(true);
    expect(r.steps.find((s) => s.id === "go")!.status).toBe("done");
    expect(r.counts.laya).toBe(1);
    // 但整跑零模型重放（第 2 次加载，目标已消失）过不了 → 条目撤回。
    expect(r.backfill_gate).toBe("unverified");
    expect(r.unverified_backfill).toEqual(["go"]);
    expect(r.verified_backfill).toEqual([]);
    expect(r.counts.backfilled).toBe(0);
    const learned = JSON.parse(fs.readFileSync(path.join(dir, `${ONCE.site}.profile.json`), "utf-8")) as
      { steps: Record<string, unknown> };
    expect(learned.steps).toEqual({});
  });

  it("显式关掉门（--no-verify-backfill）= 按现状落盘，replays_ok 停在 0（消融对照）", { timeout: 120_000 }, async () => {
    const dir = tmpDir();
    const r = await onceRun(dir, { fresh: true, verifyBackfill: false });
    expect(r.backfill_gate).toBe("skipped");
    expect(r.counts.backfilled).toBe(1);
    const learned = JSON.parse(fs.readFileSync(path.join(dir, `${ONCE.site}.profile.json`), "utf-8")) as
      { steps: Record<string, { hint: string; replays_ok: number }> };
    expect(learned.steps["go"]!.hint).toBe("[data-test=go-btn]");
    expect(learned.steps["go"]!.replays_ok).toBe(0);        // 没验过，档案里如实可见
  });

  // 目标只在头两次加载里存在：现场（1）→ 门控重放（2）→ 之后消失 → 连续失败 → drift。
  const STATEFUL = tempApp({
    id: "drift-app",
    pages: { home: "home.html", second: "second.html" },
    steps: [{
      id: "go", desc: "open the second page", page: "home",
      semantic_target: { role: "button", text: "前往" },
      signal: { page: "second" },
    }],
    files: {
      "home.html": PAGE('<button id="go" data-test="go-btn" onclick="location.href=\'second.html\'">前往</button>'
        + "<script>var n=Number(sessionStorage.getItem('loads')||'0')+1;sessionStorage.setItem('loads',String(n));"
        + "if(n>2){var b=document.getElementById('go');if(b)b.remove();}</script>"),
      "second.html": PAGE("<h1>second</h1>"),
    },
  });

  it("已学 hint 连续失败到阈值 → 报 drift 并撤下（§5）", { timeout: 240_000 }, async () => {
    const dir = tmpDir();
    const session = await browserSession(true);
    const run = (extra: Parameters<typeof runFlow>[2] = {}) =>
      runFlow("drift-app", STATEFUL.site, {
        appsDir: STATEFUL.appsDir, profileDir: dir, laya: "scripted",
        sessionFactory: async () => session, verbose: false, ...extra,
      });
    try {
      const r1 = await run({ fresh: true });
      expect(r1.ok).toBe(true);
      expect(r1.backfill_gate).toBe("verified");                 // 门控重放（第 2 次加载）通过
      const r2 = await run();
      expect(r2.steps.find((s) => s.id === "go")!.status).toBe("blocked");
      expect(r2.drift).toEqual([]);                              // 第 1 次失败：只计数
      const mid = JSON.parse(fs.readFileSync(path.join(dir, `${STATEFUL.site}.profile.json`), "utf-8")) as
        { steps: Record<string, { failures?: number }> };
      expect(mid.steps["go"]!.failures).toBe(1);
      const r3 = await run();
      expect(r3.drift).toHaveLength(1);
      expect(r3.drift[0]!.step).toBe("go");
      expect(r3.line).toContain("drift 1");
      expect(flowReportMarkdown(r3)).toContain("drift（§5）");
      const after = JSON.parse(fs.readFileSync(path.join(dir, `${STATEFUL.site}.profile.json`), "utf-8")) as
        { steps: Record<string, unknown> };
      expect(after.steps["go"]).toBeUndefined();                 // 撤下了，下次重新学
    } finally {
      await session.close();
    }
  });
});

/* ---------------------------------------------------------------- 危险步干跑（红线 3） */

describe("危险步：先干跑取证，再要人确认", () => {
  it("执行器 dry-run：解析+只读探针，页面一动不动", { timeout: 60_000 }, async () => {
    const p = path.join(os.tmpdir(), `semantic-dry-${Date.now()}.html`);
    fs.writeFileSync(p, '<button data-test="go" onclick="document.querySelector(\'[data-test=status]\').textContent=\'DONE\'">Proceed</button>'
      + '<div data-test="status">IDLE</div>', "utf-8");
    const signal = { css_text_equals: ["[data-test=status]", "DONE"] };
    installLayaRuntime(scriptedRuntime(scriptedAgent((key: string, _s: unknown, q: Record<string, Question>): Answer | undefined => {
      if (key === "r") return { noul: 0.05 };
      if (key === "d") return { noul: 0.0 };
      if (key !== "act") return undefined;
      const keys = Object.keys((q["act"]!.criteria ?? {}) as Record<string, unknown>);
      return { choice: keys[0]!, probabilities: { [keys[0]!]: 0.9 }, confidence: 0.9 };
    })));
    const session = await browserSession(true);
    try {
      const url = `file://${p}`;
      await session.page.goto(url, { waitUntil: "domcontentloaded" });
      const mw = new BrowserMiddleware({ maxSteps: 2, confirmFn: () => true });
      const rep = await mw.run("press the confirm control", url, {
        page: session.page, pw: session.pw, dryRun: true, verbose: false,
      });
      expect(rep.done).toBe(false);
      expect(rep.dry_run).toBe(true);
      expect(rep.stop_reason).toMatch(/^dry-run: would /);
      const t = rep.steps.find((s) => s["dry_run"] === true)!;
      expect(t["actionable"]).toBe(true);
      expect(t["executed"]).toBe(false);
      expect(t["would"]).toBe('button "Proceed"');
      // 没点：信号仍然 false（点一下就会 true）。
      expect(await checkSignal(session.page as never, signal)).toBe(false);
    } finally {
      await session.close();
    }
  });

  it("拒绝里有干跑证据（会点到什么、停在购买页），且没有下单", { timeout: 180_000 }, async () => {
    const r = await reportOf("site-a", tmpDir(), { fresh: true, allowDangerous: false });
    const purchase = r.steps.find((s) => s.id === "purchase")!;
    expect(purchase.status).toBe("refused");
    expect(purchase.attempts).toBe(0);
    expect(purchase.obstacle).toMatch(/危险步未放行/);
    const ev = purchase.detail!.dry_run as Record<string, unknown>;
    expect(ev.actionable).toBe(true);
    expect(String(ev.would)).toContain("购买");
    expect(String(ev.url)).toContain("purchase.html");   // 干跑停在购买页，没跳到 done.html
    expect(r.counts.refused).toBe(1);
  });

  it("confirmDangerous 拿到证据才放行；放行后购买步真执行、不变量成立", { timeout: 180_000 }, async () => {
    const dir = tmpDir();
    const seen: Array<Record<string, unknown>> = [];
    const r = await reportOf("site-a", dir, {
      fresh: true, allowDangerous: false,
      confirmDangerous: (_step, ev) => { seen.push(ev as unknown as Record<string, unknown>); return true; },
    });
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.actionable).toBe(true);
    expect(String(seen[0]!.would)).toContain("购买");
    expect(r.steps.find((s) => s.id === "purchase")!.status).toBe("done");
    expect(r.invariants.every((i) => i.held)).toBe(true);
  });

  it("二跑的干跑走已学 hint（rule:match）——干跑复用同一套三级解析", { timeout: 240_000 }, async () => {
    const dir = tmpDir();
    await reportOf("site-a", dir, { fresh: true });
    const r2 = await reportOf("site-a", dir, { allowDangerous: false });
    const ev = r2.steps.find((s) => s.id === "purchase")!.detail!.dry_run as Record<string, unknown>;
    expect(ev.method).toBe("rule:match");
    expect(ev.actionable).toBe(true);
  });
});

/* ---------------------------------------------------------------- M2 对拍（§6） */

describe("M2 对拍：list_step 的'选哪一行'== datasource 引擎对同一列的选择", () => {
  /** 测试侧**独立**读复刻站结果页里的票价表（页面自己生成行的那份脚本数据）。 */
  const faresOf = (dateCode: string): Array<Record<string, unknown>> => {
    const html = fs.readFileSync(
      fileURLToPath(new URL("../semantic/site-a/results.html", import.meta.url)), "utf-8");
    const line = html.split("\n").find((l) => l.includes(`"${dateCode}":`)) ?? "";
    return [...line.matchAll(/\["(F\d)","[\d:]+",(\d+)\]/g)]
      .map((m) => ({ flight: m[1]!, price: Number(m[2]!) }));
  };

  it("05-18 的最低价：浏览器步选中的行 == 引擎算出的行（不是硬编码期望）", { timeout: 180_000 }, async () => {
    const rows = faresOf("05-18");
    expect(rows).toHaveLength(5);
    const best = selectBest(rows, { filters: {} } as Source, { sort_by: ["price"] })!;
    expect(best["flight"]).toBe("F3");
    // min/max 是同一个实现的两个 order 值（list_step 与 selects 共用 selectIndex）。
    expect(selectIndex(rows, { sort_by: ["price"] })).toBe(2);
    expect(selectIndex(rows, { sort_by: ["price"], order: "max" })).toBe(3);

    const r = await reportOf("site-a", tmpDir(), { fresh: true });
    const chosen = r.steps.find((s) => s.id === "pick-cheapest")!.detail!.chosen as Record<string, unknown>;
    expect(chosen["flight"]).toBe(best["flight"]);
    expect(Number(String(chosen["price"]).replace(/[^\d]/g, ""))).toBe(best["price"]);
  });
});

/* ---------------------------------------------------------------- 仓库不变量（产物不许静默漂移） */

describe("出厂语义模板/档案的不变量（apps/*/flow.json）", () => {
  it("每个 flow.json 与它的每份站点档案都过加载期校验，且每个声明站点都有档案", () => {
    const appsDir = path.join(fileURLToPath(new URL("..", import.meta.url)), "apps");
    const apps = fs.readdirSync(appsDir).filter((n) => fs.existsSync(path.join(appsDir, n, "flow.json")));
    expect(apps.length).toBeGreaterThanOrEqual(2);          // flight-cheapest + planned
    for (const app of apps) {
      const template = loadTemplate(app, appsDir);
      expect(validateTemplate(template), app).toEqual([]);
      for (const site of Object.keys(template.sites)) {
        const profile = loadSiteProfile(app, site, appsDir);
        expect(profile.site, `${app}/${site}`).toBe(site);
        expect(validateProfile(profile, template), `${app}/${site}`).toEqual([]);
        // 能编译成步骤表 = 档案里的角色/提取/信号真的对得上模板。
        expect(compileFlow(template, site, profile).steps.length, `${app}/${site}`)
          .toBe(template.steps.length);
      }
    }
  });
});

describe("模板发现跨两个根 —— plan:flow 的落点 = runner 的扫面（2026-10-14 开箱测试轮修的缝）", () => {
  // 缺陷实测：plan:flow 把 v2 模板落进 $AMBERFLOW_HOME/apps（P0 前提 A 的纪律），
  // 但 semantic-flow 的发现只扫仓库 apps/ —— 生成的模板"落得下、跑不起"。
  // 修好后的性质：两个根都扫；同 id 用户目录赢；显式传目录仍然只听那一个。
  it("用户目录的 flow.json 被发现；同 id 用户赢；仓库夹具仍可见", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "af-sem-home-"));
    const userApps = path.join(home, "apps", "flight-cheapest");
    fs.mkdirSync(path.join(userApps, "sites"), { recursive: true });
    const repoApps = path.join(fileURLToPath(new URL("..", import.meta.url)), "apps");
    const t = JSON.parse(fs.readFileSync(path.join(repoApps, "flight-cheapest", "flow.json"), "utf-8"));
    t.label = "USER-DIR-COPY";
    fs.writeFileSync(path.join(userApps, "flow.json"), JSON.stringify(t));
    process.env.AMBERFLOW_HOME = home;
    try {
      const tpl = loadTemplate("flight-cheapest");
      expect(tpl.label).toBe("USER-DIR-COPY");
      expect(tpl._path!.startsWith(home)).toBe(true);
      const rows = listFlowApps();
      expect(rows.map(([id]) => id)).not.toContain("oob-not-here-xyz");  // 不存在的不混进来（否定对照）
      // 用户目录赢之后，仓库独有的另一个模板依然可见（多根，不是替换）。
      expect(rows.map(([id]) => id)).toContain("flight-cheapest-planned");
      const seen = rows.filter(([id]) => id === "flight-cheapest");
      expect(seen.length).toBe(1);                                   // 同 id 只报一次
    } finally {
      delete process.env.AMBERFLOW_HOME;
    }
  });

  it("显式 appsDir 保持单根语义（测试/工具传目录的既有契约不破）", () => {
    const repoApps = path.join(fileURLToPath(new URL("..", import.meta.url)), "apps");
    expect(loadTemplate("flight-cheapest", repoApps)._path!.startsWith(repoApps)).toBe(true);
    expect(() => loadTemplate("flight-cheapest", "/nonexistent-dir")).toThrow(/searched/);
  });
});
