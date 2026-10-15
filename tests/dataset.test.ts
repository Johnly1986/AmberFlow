/**
 * NL Flow S1（docs/NL_FLOW_DESIGN.md §2.3/§5/§10-S1）：具名数据集 + 第四种绑定来源。
 *
 * 四组验收（对齐设计文档 §10-S1 的验收列）：
 *   ① 存储语义：具名写入 / 溯源（written_by）/ generation 单调 / 重跑失效（invalidateStep）。
 *   ② 失效负例：**陈旧世代不可读**——失效后 `read` ⇒ null，下游绑定 `needs_value`
 *      （错误停在当步，不级联）；重写后复活且世代继续单调。
 *   ③ 绑定解析：`{from:"dataset"}` 现读最新 generation；运行方没给数据集 / 键没写过 /
 *      已失效，都是结构化缺值；加载期校验（datasetKeys / 空键 / `model` 仍不是来源）。
 *   ④ 端到端：真执行器（chromium）上 `fill` 命令的值从数据集绑定——
 *      有值 ⇒ 执行并落信号、零模型提问；无值 ⇒ `needs_value` 停、页面一个字不改。
 *
 * 缺省等价（§8.4 纪律）：不声明 dataset 绑定的包不传 `RunOptions.dataset`，
 * 执行路径与今天逐字节相同（由既有语料与 parity 钉住，不在本文件重复）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import * as browserEnv from "../src/browser-env.ts";
import { BrowserMiddleware, type AnyPage, type PwLike } from "../src/executor.ts";
import { DatasetStore, createDataset } from "../src/dataset.ts";
import { resolveBinding, validateBinding } from "../src/bindings.ts";
import { resolveCommandValue, type CommandDecl } from "../src/actions.ts";
import { installLayaRuntime, scriptedRuntime, scriptedAgent } from "../src/model.ts";
import { checkSignal } from "../src/signals.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const pw: PwLike = { chromium: chromium as unknown as PwLike["chromium"] };
const asPage = (p: Page): AnyPage => p as unknown as AnyPage;

const problems = (v: unknown, opts?: Parameters<typeof validateBinding>[3]): string[] => {
  const p: string[] = [];
  validateBinding(v, "sg.value", p, opts);
  return p;
};

let browser: Browser;
beforeAll(async () => { browser = (await browserEnv.launch(pw)) as unknown as Browser; }, 120_000);
afterAll(async () => { await browser?.close(); installLayaRuntime(null); });

/* ------------------------------------------------------- ① 存储语义：具名/溯源/世代 */

describe("数据集存储：具名写入、溯源、generation 单调", () => {
  it("写入即可读；覆盖写 generation+1 且换溯源——两次写入是两个世代", () => {
    const ds = createDataset();
    const e1 = ds.write("chosen_fare", { fno: "F1", price: 1280 }, "pick-cheapest#1");
    expect(e1).toMatchObject({ key: "chosen_fare", generation: 1, writtenBy: "pick-cheapest#1", stale: false });
    expect(ds.read("chosen_fare")!.value).toEqual({ fno: "F1", price: 1280 });
    const e2 = ds.write("chosen_fare", { fno: "F3", price: 980 }, "pick-cheapest#2");
    expect(e2.generation).toBe(2);
    expect(ds.read("chosen_fare")).toMatchObject({ value: { fno: "F3", price: 980 }, generation: 2 });
    // 审计面看得见全部（read 只给最新——但历史不假装没发生过）
    expect(ds.entriesView().length).toBe(1);
  });

  it("重跑失效（invalidateStep）：该步的条目世代+1、清值、置陈旧；别人的条目不动", () => {
    const ds = createDataset();
    ds.write("mine", "v1", "step-a#1");
    ds.write("theirs", "w1", "step-b#1");
    const hit = ds.invalidateStep("step-a#1");
    expect(hit).toEqual(["mine"]);
    expect(ds.read("mine")).toBeNull();                       // 陈旧世代不可读
    expect(ds.read("theirs")).toMatchObject({ value: "w1" }); // 别人的值照常可读
    const view = ds.entriesView().find((e) => e.key === "mine")!;
    expect(view.generation).toBe(2);                          // 单调
    expect(view.stale).toBe(true);
    expect(view.writtenBy).toBe("step-a#1");                  // 溯源是历史事实，不清掉
  });

  it("重复清场幂等；重写复活且世代继续单调（失效→重写 = 两个事件 = 两个世代）", () => {
    const ds = createDataset();
    ds.write("k", "v1", "step-a#1");
    expect(ds.invalidateStep("step-a#1")).toEqual(["k"]);
    expect(ds.invalidateStep("step-a#1")).toEqual([]);        // 已陈旧的不重复失效
    ds.write("k", "v2", "step-a#2");
    expect(ds.read("k")).toMatchObject({ value: "v2", generation: 3, stale: false });
  });

  it("stats / toJSON / fromJSON：审计数对得上；坏档案响亮报错（不静默损坏）", () => {
    const ds = createDataset();
    ds.write("a", 1, "s#1");
    ds.write("b", 2, "s#1");
    ds.invalidateStep("s#1");
    expect(ds.stats()).toEqual({ entries: 2, live: 0, invalidations: 2 });
    const json = JSON.parse(JSON.stringify(ds.toJSON()));
    const back = DatasetStore.fromJSON(json);
    expect(back.entriesView().length).toBe(2);
    expect(back.entriesView().every((e) => e.stale)).toBe(true);
    expect(() => DatasetStore.fromJSON({ entries: [{ key: "", generation: 1 }] })).toThrow(/non-empty string/);
    expect(() => DatasetStore.fromJSON({ entries: [{ key: "k", generation: 0 }] })).toThrow(/positive integer/);
    expect(() => DatasetStore.fromJSON(null)).toThrow(/expected/);
    expect(() => ds.write("", 1, "s#1")).toThrow(/non-empty/);
    expect(() => ds.write("k", 1, "")).toThrow(/non-empty/);
  });
});

/* ------------------------------------------------- ②③ dataset 绑定：第四来源的解析纪律 */

describe("dataset 绑定（第四来源）：现读最新 generation，陈旧不可读", () => {
  it("命中 ⇒ 值 + via 带世代与溯源（证据面可查）", () => {
    const ds = createDataset();
    ds.write("code", "SAVE10", "get-code#1");
    const r = resolveBinding({ from: "dataset", key: "code" }, { dataset: ds });
    expect(r).toMatchObject({ ok: true, value: "SAVE10", via: "dataset:code(gen 1 by get-code#1)" });
  });

  it("覆盖写后现读的是**最新**世代（绑定不记旧账）", () => {
    const ds = createDataset();
    ds.write("code", "OLD", "a#1");
    ds.write("code", "NEW", "a#2");
    expect(resolveBinding({ from: "dataset", key: "code" }, { dataset: ds }))
      .toMatchObject({ ok: true, value: "NEW" });
  });

  it("运行方没给数据集 / 键没写过 / 已被重跑失效 ⇒ 三种结构化缺值，各说各话", () => {
    const none = resolveBinding({ from: "dataset", key: "k" }, {});
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toMatch(/no dataset was provided in this context/);

    const ds = createDataset();
    const never = resolveBinding({ from: "dataset", key: "k" }, { dataset: ds });
    expect(never.ok).toBe(false);
    if (!never.ok) expect(never.reason).toMatch(/dataset key "k" has no readable value.*never written/);

    ds.write("k", "v", "s#1");
    ds.invalidateStep("s#1");
    const stale = resolveBinding({ from: "dataset", key: "k" }, { dataset: ds });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toMatch(/invalidated by a rerun — stale generations are unreadable/);
  });

  it("声明半：空键红；datasetKeys 给了就校『键必须声明过』；`model` 仍不是来源", () => {
    expect(problems({ from: "dataset", key: "" })[0]).toMatch(/non-empty dataset entry name/);
    expect(problems({ from: "dataset", key: "ghost" }, { datasetKeys: new Set(["real"]) })[0])
      .toMatch(/value\.key "ghost" is not a declared dataset entry \(known: real\)/);
    expect(problems({ from: "model", key: "x" })[0])
      .toMatch(/value\.from must be one of slot\|option\|list\|dataset/);
  });

  it("命令层透传（fill 的值可以从数据集来）；没透传就是 needs_value 理由，不是猜", () => {
    const decl: CommandDecl = {
      id: "f", op: "fill", target: "#code", value: { from: "dataset", key: "code" },
    };
    const ds = createDataset();
    ds.write("code", "SAVE10", "s#1");
    expect(resolveCommandValue(decl, {}, { dataset: ds })).toEqual({ ok: true, value: "SAVE10" });
    const miss = resolveCommandValue(decl, {}, {});
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.reason).toMatch(/no dataset was provided/);
  });
});

/* --------------------------------------------------- ④ 端到端：真执行器上的数据集绑定 */

const FIXTURE = `<!DOCTYPE html><html lang="zh"><body>
  <input data-test="code" value="">
  <p data-test="summary">-</p>
  <button data-test="ok">好</button>
  <script>document.querySelector('[data-test=ok]').onclick = () => {
    document.querySelector('[data-test=summary]').textContent =
      'code=' + document.querySelector('[data-test=code]').value; };</script>
</body></html>`;

describe("S1 端到端：fill 命令的值从数据集绑定（RunOptions.dataset）", () => {
  const cmds: CommandDecl[] = [
    { id: "fill-code", op: "fill", target: "[data-test=code]", value: { from: "dataset", key: "code" } },
    { id: "confirm", op: "click", target: "[data-test=ok]" },
  ];

  it("数据集有值 ⇒ 执行并落信号；零模型选择提问（红线②：模型不参与选值）", async () => {
    let choiceAsked = false;
    installLayaRuntime(scriptedRuntime(scriptedAgent((key, _s, q) => {
      if (q[key] && q[key].type === "choice") choiceAsked = true;
      return { noul: 0.0 };
    })));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amber-ds-e2e-"));
    const file = path.join(dir, "code.html");
    fs.writeFileSync(file, FIXTURE, "utf-8");
    const ds = createDataset();
    ds.write("code", "SAVE10", "get-code#1");
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const mw = new BrowserMiddleware({ maxSteps: 6 });
    const rep = await mw.run("apply the code and confirm", pathToFileURL(file).href, {
      page: asPage(page), pw, verbose: false,
      commands: cmds,
      dataset: ds,
      goalSignalFn: (p: unknown) => checkSignal(p as never, { css_text_equals: ["[data-test=summary]", "code=SAVE10"] }),
    });
    await ctx.close();
    expect(rep.done).toBe(true);
    expect(rep.stop_code).toBe("dom_goal_signal");
    expect(choiceAsked, "数据集绑定不许把'取哪个值'变成一次模型提问").toBe(false);
    const acted = rep.steps.filter((s) => s.executed);
    expect(acted.map((s) => s.command)).toEqual(["fill-code", "confirm"]);
    expect(acted[0]!.value).toBe("SAVE10");
  });

  it("数据集没值 ⇒ needs_value 结构化停；页面一个字没改（不是拿近似值顶上）", async () => {
    installLayaRuntime(scriptedRuntime(scriptedAgent(() => ({ noul: 0.0 }))));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amber-ds-miss-"));
    const file = path.join(dir, "code.html");
    fs.writeFileSync(file, FIXTURE, "utf-8");
    const ds = createDataset();                        // 空数据集：键从未写入
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const mw = new BrowserMiddleware({ maxSteps: 4 });
    const rep = await mw.run("apply the code and confirm", pathToFileURL(file).href, {
      page: asPage(page), pw, verbose: false,
      commands: cmds,
      dataset: ds,
    });
    const summary = await page.textContent("[data-test=summary]");
    const value = await page.inputValue("[data-test=code]");
    await ctx.close();
    expect(rep.done).toBe(false);
    expect(rep.stop_code).toBe("needs_value");
    expect(rep.stop_reason).toMatch(/dataset key "code" has no readable value/);
    expect(summary).toBe("-");
    expect(value).toBe("");
  });
});
