/**
 * 三类入口之一：**无参 `learn`**（人演示 / 连他开着的浏览器）与**外层 Agent 的一次调用**（同引擎 `--json --yes`）。
 *
 * 这个文件钉的是它凭什么可信，而不是它好不好用：
 *   1. 录不下来的动作要**明说**（不静默丢），敏感字段只记形状；
 *   2. 落盘门槛是"**零前向回放通过**"，回放不过就**不落盘**（门槛有牙齿：改坏一个信号必须红）；
 *   3. 血统要活着落进文件（`recorded_from`）——不然矩阵只能把它当"手写"；
 *   4. id 必须 ASCII 安全且确定（`file://` 页面没有 hostname、中文目标不能当目录名）；
 *   5. 生成器/检查器的展开日期是**钉住的**（spec 的 `per_date` 按"下周"算，否则每周一门禁自己变红）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPack, validatePack } from "../src/app-pack.ts";
import { browserSession } from "../src/executor.ts";
import { extractElements } from "../src/extraction.ts";
import {
  executableActions, main as learnMain, packFromLearning, replayCheck, slugOf, startRecorder,
  readRecorded, type Learning,
} from "../tools/learn.ts";
import { checkAgainstFlow, flowFor, generatedApps } from "../tools/spec-to-pack.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const TMP: string[] = [];
function tmp(tag = "learn"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
  TMP.push(d);
  return d;
}
afterEach(() => { while (TMP.length) fs.rmSync(TMP.pop()!, { recursive: true, force: true }); });

const ACTIONS = [
  { op: "click", hint: "[data-test=add-to-cart]", label: "Add to cart" },
  { op: "click", hint: "[data-test=cart-link]", label: "Cart" },
];

describe("learn：录制下来的动作与句柄", () => {
  it("录不下来的动作明说、不静默丢；敏感字段只记形状", () => {
    const { actions, skipped } = executableActions([
      { op: "click", hint: "[data-test=a]", label: "A" },
      { op: "skip", why: "点击的元素没有稳定句柄" },
      { op: "type", hint: "#pwd", value: "", secret: true, label: "Password" },
      { op: "click", hint: "" },
    ]);
    expect(actions.map((a) => a.hint)).toEqual(["[data-test=a]", "#pwd"]);
    expect(actions[1]!.secret).toBe(true);
    expect(actions[1]!.value).toBe("");
    expect(skipped).toEqual(["点击的元素没有稳定句柄", "空句柄"]);
  });

  it("id 是 ASCII 安全、确定的，两个不同的中文目标不会撞车", () => {
    const a = slugOf("testpages/product.html", "把无线鼠标加入购物车");
    const b = slugOf("testpages/product.html", "把键盘加入购物车");
    expect(a).toMatch(/^[a-z0-9-]+$/);
    expect(a).toBe(slugOf("testpages/product.html", "把无线鼠标加入购物车"));   // 确定
    expect(a).not.toBe(b);                                                      // 不撞车
    expect(slugOf("https://shop.example.com/p/1", "buy a mouse")).toContain("shop-example-com");
  });

  it("页面里的录制器按稳定句柄记账（拿不到句柄就记一条 skip）", async () => {
    const session = await browserSession(true);
    try {
      const page = session.page as never as {
        goto(u: string, o?: unknown): Promise<unknown>;
        fill(sel: string, v: string): Promise<void>;
        click(sel: string): Promise<void>;
      };
      await page.goto(new URL(`file://${path.join(REPO, "testpages/net_settings.html")}`).href,
        { waitUntil: "domcontentloaded" });
      await startRecorder(page);
      const elems = await extractElements(page as never);
      const typing = Object.values(elems).find((e) => e.tag === "input" || e.tag === "textarea");
      expect(typing, "夹具里应该有可输入的字段").toBeTruthy();
      const sel = typing!.data_test ? `[data-test=${typing!.data_test}]` : `#${typing!.id}`;
      await page.fill(sel, "10.0.1.77");
      await page.click("[data-test=net-save]");
      const bag = await readRecorded(page);
      const { actions, skipped } = executableActions(bag);
      expect(skipped).toEqual([]);
      expect(actions.map((a) => a.op)).toEqual(["type", "click"]);
      expect(actions[0]!.hint).toBe(sel);
      expect(actions[0]!.value).toBe("10.0.1.77");
      expect(actions[1]!.hint).toBe("[data-test=net-save]");
    } finally {
      await session.close();
    }
  }, 300_000);
});

describe("learn：落盘门槛（零前向回放）与血统", () => {
  it("从动作脚本学到包：写文件、带 recorded_from，且回放 0 次模型调用", async () => {
    const dir = tmp("learn-e2e");
    const script = path.join(dir, "actions.json");
    fs.writeFileSync(script, JSON.stringify(ACTIONS));
    const packDir = path.join(dir, "packs");
    const code = await learnMain([
      "--url", "testpages/product.html", "--goal", "把无线鼠标加入购物车并打开购物车页",
      "--script", script, "--yes", "--id", "learned-test", "--pack-dir", packDir, "--out", dir, "--quiet",
    ]);
    expect(code).toBe(0);
    const file = path.join(packDir, "learned-test", "pack.json");
    expect(fs.existsSync(file)).toBe(true);
    const pack = loadPack(file);
    expect(validatePack(pack)).toEqual([]);
    expect(pack.recorded_from).toMatchObject({ url: "testpages/product.html", steps: 2 });
    expect(String(pack.recorded_from!.sha256)).toMatch(/^[0-9a-f]{64}$/);
    // 血统必须活着落进文件（serializePack 漏键会让矩阵把它当"手写"——这曾经真的发生过）
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).recorded_from).toBeTruthy();
    const replay = await replayCheck(pack, dir);
    expect({ ok: replay.ok, forwards: replay.forwards }).toEqual({ ok: true, forwards: 0 });
    expect(replay.invariants).toMatch(/^2\/2$/);
  }, 600_000);

  it("门槛有牙齿：把一个信号改坏，回放必须红（而不是照旧通过）", async () => {
    const pack = loadPack(path.join(REPO, "apps", "learned-cart", "pack.json"));
    const doctored = JSON.parse(JSON.stringify(pack)) as typeof pack;
    (doctored.journey[0] as Record<string, unknown>)["signal"] =
      { css_text_equals: ["[data-test=cart-count]", "99"] };
    const replay = await replayCheck(doctored, tmp("learn-drift"));
    // 改坏的是**步信号**：门禁的表现是"这一步不再完成、整包不通过"（失败的不变量列表是空的）
    expect(replay.ok).toBe(false);
    expect(replay.completed).not.toBe("2/2");
    expect(replay.forwards).toBe(0);              // 而且它是被规则/信号挡住的，不是靠模型救回来的
  }, 600_000);

  it("没有终端又没有 --script/--yes 时干净拒绝（不猜、不写文件）", async () => {
    const dir = tmp("learn-non-tty");
    const packDir = path.join(dir, "packs");
    const code = await learnMain([
      "--url", "testpages/product.html", "--goal", "x", "--pack-dir", packDir, "--out", dir, "--quiet",
    ]);
    expect(code).toBe(2);
    expect(fs.existsSync(packDir)).toBe(false);
  }, 300_000);

  it("包结构：journey 是录下来的、invariants 是归纳出来的（而且是 runner 形状那次运行归纳的）", () => {
    const pack = loadPack(path.join(REPO, "apps", "learned-cart", "pack.json"));
    expect(pack.journey).toHaveLength(2);
    expect(pack.journey[0]).toMatchObject({
      start_url: "testpages/product.html", target_hint: "[data-test=add-to-cart]",
    });
    expect((pack.invariants ?? []).length).toBeGreaterThan(0);
    for (const inv of pack.invariants ?? []) expect(inv.id).toMatch(/^learned-/);
    expect((pack.notes ?? []).join("\n")).toMatch(/复跑不成立|不录制/);
  });
});

describe("生成器：展开日期被钉住（否则每周一门禁自己变红）", () => {
  it("环境里的 LAYA_TODAY 不会改变 --check 的结论（只有显式 --today 能移动那一周）", async () => {
    const prev = process.env.LAYA_TODAY;
    try {
      const apps = generatedApps();
      expect(apps.length).toBeGreaterThanOrEqual(8);
      for (const today of ["2026-03-01", "2027-01-15", undefined]) {
        if (today === undefined) delete process.env.LAYA_TODAY; else process.env.LAYA_TODAY = today;
        for (const a of apps.filter((x) => "spec" in x.ref)) {
          const flow = await flowFor(a.ref);
          expect({ id: a.id, problems: checkAgainstFlow(a, flow) }).toEqual({ id: a.id, problems: [] });
        }
      }
    } finally {
      if (prev === undefined) delete process.env.LAYA_TODAY; else process.env.LAYA_TODAY = prev;
    }
  }, 300_000);
});

describe("learn：包的形状与 replayCheck 的接口", () => {
  it("packFromLearning：hosts 从 URL 提取，max_subgoals 有下限，notes 带每一步的观察", () => {
    const learning: Learning = {
      url: "https://a.example/x", goal: "g",
      steps: [{
        desc: "点击「A」", start_url: "https://a.example/x", target_hint: "[data-test=a]",
        signal: { css_exists: ["[data-test=a]"] }, alternatives: [], effect: ["appeared: [data-test=a]"],
      }],
      invariants: [{ id: "learned-x", desc: "d", signal: { url_contains: "/x" } }],
      effect: [],
    };
    const pack = packFromLearning(learning, "a-example");
    expect(pack.hosts).toEqual(["a.example"]);
    expect(pack.max_subgoals).toBeGreaterThanOrEqual(4);
    expect((pack.notes ?? []).join("\n")).toContain("appeared: [data-test=a]");
    expect(validatePack(pack)).toEqual([]);
  });
});
