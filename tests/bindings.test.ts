/**
 * P3 数据槽层（docs/ARCHITECTURE_REVIEW.md §6.1 的"数据槽层"行 + §7-P3 行）。
 *
 * 三件事各钉一组：
 *   ① 声明半：规则**必须声明**（没有 match/order 就是加载期红）；来源面四种
 *      （NL Flow S1 起加 `dataset`）；`option` 只能挂在看得见候选的 op 上；`list` 只接数据腿。
 *   ② 运行期解析：分档匹配、**档内歧义即弃权**；没有候选 / 全空列 / 空行集都是结构化失败，
 *      绝不"挑一个"。
 *   ③ 端到端：真 `<select>` 上走 `commands` 的 `option` 绑定（机器值 ≠ 人读标签），
 *      规则命中 ⇒ 执行并落信号；规则命不中 ⇒ `needs_value` 结构化停，页面**一个字都没改**，
 *      且**零模型选择提问**（红线②：模型不参与选值）。
 *
 * 缺省等价（§8.4）由既有语料钉：不写 `commands`/绑定，执行路径逐字节同今天
 * （`tests/parity.test.ts` + `tools/executor-parity.ts` + `apps:gen --check`）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import * as browserEnv from "../src/browser/browser-env.ts";
import { BrowserMiddleware, type AnyPage, type PwLike } from "../src/engine/executor.ts";
import {
  OPTION_MATCHES, LIST_ORDERS, optionCandidatesFrom, resolveBinding, validateBinding,
  type OptionBinding, type ValueBinding,
} from "../src/engine/bindings.ts";
import { validateCommands, type CommandDecl } from "../src/engine/actions.ts";
import { expandPack, loadPack } from "../src/app/app-pack.ts";
import { installLayaRuntime, scriptedRuntime, scriptedAgent } from "../src/model/model.ts";
import { checkSignal } from "../src/engine/signals.ts";
import { selectIndex } from "../src/data/datasource.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const pw: PwLike = { chromium: chromium as unknown as PwLike["chromium"] };
const asPage = (p: Page): AnyPage => p as unknown as AnyPage;
const CHECKIN = pathToFileURL(path.join(REPO, "testpages", "checkin.html")).href;

const problems = (v: unknown, opts?: Parameters<typeof validateBinding>[3]): string[] => {
  const p: string[] = [];
  validateBinding(v, "sg.value", p, opts);
  return p;
};

let browser: Browser;
beforeAll(async () => { browser = (await browserEnv.launch(pw)) as unknown as Browser; }, 120_000);
afterAll(async () => { await browser?.close(); installLayaRuntime(null); });

/* ------------------------------------------------------------------ ① 声明半 */

describe("数据槽层声明半：规则必须声明，来源面四种（S1 起 dataset）", () => {
  it("四条来源的合法形状全过；能力面就是这四个名字", () => {
    expect(problems({ from: "slot", key: "q" }, { slotKeys: new Set(["q"]) })).toEqual([]);
    expect(problems({ from: "option", key: "checkin", match: "value" }, { slotKeys: new Set(["checkin"]), op: "select" })).toEqual([]);
    expect(problems({ from: "list", by: "price", order: "min" }, { allowList: true })).toEqual([]);
    expect(problems({ from: "dataset", key: "chosen_fare" }, { datasetKeys: new Set(["chosen_fare"]) })).toEqual([]);
  });

  it("未知来源 ⇒ 红（`model` 不是一条来源——红线②）", () => {
    expect(problems({ from: "model", key: "x" })[0])
      .toMatch(/value\.from must be one of slot\|option\|list\|dataset \(got "model"\)/);
  });

  it("option 必须声明 match（不声明规则 = 猜），未知 match 也红", () => {
    expect(problems({ from: "option", key: "k", match: undefined }, { op: "select" })
      .some((p) => /value\.match must be declared/.test(p))).toBe(true);
    expect(problems({ from: "option", key: "k", match: "vibes" }, { op: "select" })
      .some((p) => new RegExp(`value\\.match must be one of ${OPTION_MATCHES.join("\\|")}`).test(p))).toBe(true);
  });

  it("option 只能挂在看得见候选的 op 上（fill 上没有候选列表可看）", () => {
    expect(problems({ from: "option", key: "k", match: "value" }, { op: "fill" })
      .some((p) => /needs an op that can see options \(got 'fill'/.test(p))).toBe(true);
  });

  it("list 只接数据腿（命令闭集里没有 op 消费『行』）", () => {
    expect(problems({ from: "list", by: "price", order: "min" })
      .some((p) => /no command op consumes — declare it on a list_step/.test(p))).toBe(true);
    expect(problems({ from: "list", by: "price", order: "max" }, { allowList: true })).toEqual([]);
  });

  it("list 的 order/by 也要声明；合法面来自一处（LIST_ORDERS）", () => {
    expect(problems({ from: "list", by: "price" }, { allowList: true })
      .some((p) => /value\.order must be declared/.test(p))).toBe(true);
    expect(problems({ from: "list", by: "", order: "median" }, { allowList: true }).length).toBe(2);
    expect([...LIST_ORDERS]).toEqual(["min", "max"]);
  });

  it("命令层的那一个校验器直接委托过来（不新开第三套语法）", () => {
    const p: string[] = [];
    validateCommands(
      [{ id: "s", op: "select", target: "#d", value: { from: "option", key: "d" } }],
      "sg", p, new Set(["d"]),
    );
    expect(p.some((x) => /value\.match must be declared/.test(x))).toBe(true);
  });
});

/* ------------------------------------------------------------------ ② 运行期解析 */

describe("数据槽层运行期：分档匹配，档内歧义即弃权", () => {
  const options = [
    { value: "", label: "请选择" },
    { value: "2026-10-12", label: "10月12日 周一" },
    { value: "2026-10-13", label: "10月13日 周二" },
  ];

  it("match:value 用机器值；match:label 用人读标签——两条规则都只认自己那一档", () => {
    const byValue: OptionBinding = { from: "option", key: "checkin", match: "value" };
    expect(resolveBinding(byValue, { slots: { checkin: "2026-10-13" }, options }))
      .toMatchObject({ ok: true, value: "2026-10-13", via: "option:value" });
    const byLabel: ValueBinding = { from: "option", key: "checkin", match: "label" };
    expect(resolveBinding(byLabel, { slots: { checkin: "10月13日 周二" }, options }))
      .toMatchObject({ ok: true, value: "2026-10-13", via: "option:label" });
  });

  it("命不中 ⇒ 结构化缺值原因（列出观察到的候选数），绝不挑一个", () => {
    const r = resolveBinding({ from: "option", key: "checkin", match: "value" },
      { slots: { checkin: "2026-12-24" }, options });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/none of the observed candidates matched "2026-12-24".*3 candidate\(s\) observed/);
  });

  it("档内歧义 ⇒ 弃权（不是掷硬币）", () => {
    const many = [
      { value: "a", label: "4MP 广角" },
      { value: "b", label: "4MP 长焦" },
      { value: "c", label: "4K" },
    ];
    const r = resolveBinding({ from: "option", key: "res", match: "contains" }, { slots: { res: "4MP" }, options: many });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/'option:contains' matched 2 candidates/);
  });

  it("没有观察到候选 / 袋里没有那个键 ⇒ 各自说清楚，都不猜", () => {
    const r0 = resolveBinding({ from: "option", key: "k", match: "value" }, { slots: { k: "x" }, options: [] });
    expect(r0.ok).toBe(false);
    if (!r0.ok) expect(r0.reason).toMatch(/no option candidates were observed/);
    const r1 = resolveBinding({ from: "option", key: "k", match: "value" }, { slots: {}, options });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toMatch(/not in the plan's data bag/);
  });

  it("list 来源走 datasource 的同一个 selectIndex（一份实现，不是第二套）", () => {
    const rows = [{ p: 300 }, { p: 120 }, { p: 260 }];
    expect(resolveBinding({ from: "list", by: "p", order: "min" }, { rows }))
      .toMatchObject({ ok: true, index: selectIndex(rows, { sort_by: ["p"], order: "min" }), via: "list:min(p)" });
    expect(resolveBinding({ from: "list", by: "p", order: "max" }, { rows }))
      .toMatchObject({ ok: true, index: selectIndex(rows, { sort_by: ["p"], order: "max" }) });
  });

  it("全空列 / 空行集 ⇒ 失败（'没有数据时挑第一行'不是声明式选择）", () => {
    const empty = resolveBinding({ from: "list", by: "p", order: "min" }, { rows: [{ p: null }, { p: undefined }] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toMatch(/is empty on all 2 observed row\(s\)/);
    const none = resolveBinding({ from: "list", by: "p", order: "min" }, { rows: [] });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toMatch(/no rows were observed/);
  });

  it("混类型的列不是排序结果奇怪，而是**没法排序**：给结构化理由，不抛异常（独立复核 D3）", () => {
    const mixed = [
      { p: 1 }, { p: "abc" }, { p: 2 },
    ];
    for (const order of ["min", "max"] as const) {
      const r = resolveBinding({ from: "list", by: "p", order }, { rows: mixed });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/mixes value types \(number, string\).*not comparable/);
    }
    // 同类型照旧能选（缺值仍排最后，由 selectIndex 的既有语义决定）
    expect(resolveBinding({ from: "list", by: "p", order: "min" }, { rows: [{ p: 5 }, { p: null }, { p: 2 }] }))
      .toMatchObject({ ok: true, index: 2 });
  });

  it("槽位名打错不再拖到运行期（加载期红：应用包把已知的袋键喂给同一个走查器）", () => {
    const { pack } = (() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amber-bind-slotkey-"));
      fs.writeFileSync(path.join(dir, "pack.json"), JSON.stringify({
        spec_version: 1, id: "typo", label: "typo", goal: "g", hosts: [],
        slots: { checkin: "2026-10-13" },
        journey: [{
          id: "s", desc: "选日期", start_url: "testpages/checkin.html",
          commands: [{ id: "pick", op: "select", target: "[data-test=checkin]", value: { from: "slot", key: "checkin2" } }],
          signal: { css_exists: "body" },
        }],
      }), "utf-8");
      return { pack: path.join(dir, "pack.json") };
    })();
    expect(() => expandPack(loadPack(pack), {}, ":memory:"))
      .toThrow(/value\.key "checkin2" is not a declared slot/);
  });

  it("optionCandidatesFrom 只认 {value,label} 形状的观察结果", () => {
    expect(optionCandidatesFrom([{ value: "1", label: " 一 " }, null, "x", { value: 2, label: 3 }]))
      .toEqual([{ value: "1", label: "一" }, { value: "2", label: "3" }]);
    expect(optionCandidatesFrom(undefined)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ ③ 端到端 */

describe("P3 端到端：真 <select> 上的命令式绑定（机器值 ≠ 人读标签）", () => {
  const cmds: CommandDecl[] = [
    { id: "pick-date", op: "select", target: "[data-test=checkin]", value: { from: "option", key: "checkin", match: "value" } },
    { id: "confirm", op: "click", target: "[data-test=confirm]" },
  ];
  const signal = { css_text_equals: ["[data-test=summary]", "入住 2026-10-13"] };

  it("规则命中 ⇒ 选中 + 确认，一个子目标、零模型选择提问", async () => {
    let choiceAsked = false;
    installLayaRuntime(scriptedRuntime(scriptedAgent((key, _s, q) => {
      if (q[key] && q[key].type === "choice") choiceAsked = true;
      return { noul: 0.0 };
    })));
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const mw = new BrowserMiddleware({ maxSteps: 6 });
    const rep = await mw.run("pick the check-in date and confirm", CHECKIN, {
      page: asPage(page), pw, verbose: false,
      slots: { checkin: "2026-10-13" },
      commands: cmds,
      goalSignalFn: (p: unknown) => checkSignal(p as never, signal),
    });
    await ctx.close();
    expect(rep.done).toBe(true);
    expect(rep.stop_code).toBe("dom_goal_signal");
    expect(choiceAsked, "绑定不许把'选哪个值'变成一次模型提问").toBe(false);
    const acted = rep.steps.filter((s) => s.executed);
    expect(acted.map((s) => s.command)).toEqual(["pick-date", "confirm"]);
    expect(acted.every((s) => s.method === "rule:match")).toBe(true);
    // 进入页面的值是**机器值**，页面自己把它渲染成人读摘要（人读标签只是候选的匹配面之一）
    expect(acted[0]!.value).toBe("2026-10-13");
  });

  it("规则命不中 ⇒ needs_value 结构化停；页面一个字没改（不是拿近似的顶上）", async () => {
    installLayaRuntime(scriptedRuntime(scriptedAgent(() => ({ noul: 0.0 }))));
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const mw = new BrowserMiddleware({ maxSteps: 4 });
    const rep = await mw.run("pick the check-in date and confirm", CHECKIN, {
      page: asPage(page), pw, verbose: false,
      slots: { checkin: "2026-12-24" },          // 页面上没有这一天
      commands: cmds,
    });
    const summary = await page.textContent("[data-test=summary]");
    const value = await page.inputValue("[data-test=checkin]");
    await ctx.close();
    expect(rep.done).toBe(false);
    expect(rep.stop_code).toBe("needs_value");
    expect(rep.stop_reason).toMatch(/none of the observed candidates matched/);
    expect(summary).toBe("未选择");               // 没有把"最近的一天"填进去
    expect(value).toBe("");
  });

  it("按值解出来的绑定就按值选：label 恰好等于那个机器值的**另一个** option 不会被误选", async () => {
    // 真实站点的经典陷阱：两个 option，第一个的**人读标签**就是我们要的机器值。
    // label 优先的探测会选错（选中 value="A"），声明式绑定必须按值落。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amber-bind-value-"));
    const file = path.join(dir, "trap.html");
    fs.writeFileSync(file, `<!DOCTYPE html><html lang="zh"><body>
      <select data-test="s">
        <option value="A">2026-10-12</option>
        <option value="2026-10-12">10月12日 周一</option>
        <option value="B">10月13日 周二</option>
      </select>
      <p data-test="picked">-</p>
      <button data-test="ok">好</button>
      <script>document.querySelector('[data-test=ok]').onclick = () => {
        document.querySelector('[data-test=picked]').textContent =
          document.querySelector('[data-test=s]').value; };</script>
    </body></html>`, "utf-8");
    installLayaRuntime(scriptedRuntime(scriptedAgent(() => ({ noul: 0.0 }))));
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const mw = new BrowserMiddleware({ maxSteps: 4 });
    const rep = await mw.run("pick the date", pathToFileURL(file).href, {
      page: asPage(page), pw, verbose: false,
      slots: { checkin: "2026-10-12" },
      commands: [
        { id: "pick", op: "select", target: "[data-test=s]", value: { from: "option", key: "checkin", match: "value" } },
        { id: "ok", op: "click", target: "[data-test=ok]" },
      ],
      goalSignalFn: (p: unknown) => checkSignal(p as never, { css_text_equals: ["[data-test=picked]", "2026-10-12"] }),
    });
    const picked = await page.textContent("[data-test=picked]");
    await ctx.close();
    expect(rep.done).toBe(true);
    expect(picked).toBe("2026-10-12");       // 不是 "A"（那个 option 的标签才是这个字符串）
  });

  it("非法绑定组合在加载期就红（命令层 → 数据槽层同一个校验器）", () => {
    const p: string[] = [];
    validateCommands([
      { id: "a", op: "select", target: "#s", value: { from: "option", key: "k", match: "maybe" } } as never,
      { id: "b", op: "fill", target: "#f", value: { from: "list", by: "p", order: "min" } } as never,
    ], "sg", p);
    expect(p.some((x) => /value\.match must be one of/.test(x))).toBe(true);
    // fill 既看不到候选列表（option 不合法），也不是数据腿（list 不合法）——两条都点名
    expect(p.length).toBe(2);
  });
});
