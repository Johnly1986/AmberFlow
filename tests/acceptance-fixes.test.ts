/**
 * 子代理验收发现的问题的**回归测试**（HEAD 0ed6087 → 修复批次）。
 *
 * 每条都先被独立验收复现过：
 *   1. flow 声明了不变量却从不调 `ctx.done()` → 以前 ok=true/套件"通过"（0/1 自相矛盾）；
 *   2. dry（`apps check`）的 hosts 信封只守 `open`，`openPage`/`arrive`/`step(url)` 漏检 → dry 假绿；
 *   3. flow 应用的 web 不变量 signal 从不校验（`signal: { url_containz: ... }` check 全绿）；
 *   4. `ctx.arrive` 误走 step 路径（记录成 step、还可能 no_model_runtime）→ 三实现漂移；
 *   5. `ctx.url()` 在相对 `open` 后 dry/replay/真实解析不一致；
 *   6. `ctx.command()` 不带 id 时 dry 拒/真实静默丢弃；
 *   7. cli 工具步 `retries>0` 未要求 `idempotent`（声明式有，flow 绕过）；
 *   8. dry 允许 `ctx.done()` 两次（真实报错）；
 *   9. `sameEventStructure` 完全忽略 result（文档说含结果）；
 *  10. `AMBERFLOW_NO_SCRIPTS=1` 挡不住 `apps explain/emit` 直接 import 脚本；
 *  11. 同时导出 `app` 与 `flow` 时静默取 flow（另一个永不校验）；
 *  12. 最小脚本缺 `label` 被拒（label 现在回落 id）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { dryRunFlow, loadScriptApp } from "../src/app/app-script.ts";
import { runScriptApp } from "../src/app/app-runner.ts";
import { readTrace, sameEventStructure } from "../src/app/trace.ts";
import { normalizeCommandIds } from "../src/app/ctx.ts";
import { validateSignalSpec } from "../src/engine/signals.ts";
import { REPO } from "../src/flow/flow.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-acceptance-fixes-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const prevNoScripts = process.env.AMBERFLOW_NO_SCRIPTS;
afterEach(() => {
  if (prevNoScripts === undefined) delete process.env.AMBERFLOW_NO_SCRIPTS;
  else process.env.AMBERFLOW_NO_SCRIPTS = prevNoScripts;
});

function writeScript(tag: string, body: string): string {
  const dir = path.join(tmp, tag);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "app.mjs");
  fs.writeFileSync(file, body, "utf-8");
  return file;
}

describe("1) 不变量没验收 = 不能报绿", () => {
  it("runScriptApp：声明 invariants 但从不 ctx.done() → ok=false, stop_code=missing_done", async () => {
    const loaded = await loadScriptApp(path.join(REPO, "tests/fixtures/scripts/flow-missing-done.mjs"));
    const outDir = fs.mkdtempSync(path.join(tmp, "nodone-"));
    const res = await runScriptApp(loaded, { verbose: false, outDir });
    expect(res.ok).toBe(false);
    expect(res.script?.stop_code).toBe("missing_done");
    expect(res.script?.stop_reason).toMatch(/never verified|ctx\.done/);
    expect(res.invariants.every((i) => !i.held)).toBe(true);
  }, 120_000);
});

describe("2) dry 也执行 hosts 信封（openPage / arrive / step(url)）", () => {
  function scriptFor(body: string): string {
    return `export const meta = (kit) => ({
  id: "hosts-app", label: "x", goal: "g", hosts: ["example.com"], slots: [],
  site: { pages: { home: "https://example.com/home", evil: "https://evil.test/x" } },
});
export async function flow(ctx) {
${body}
}`;
  }
  async function problems(body: string, tag: string): Promise<string> {
    const loaded = await loadScriptApp(writeScript(tag, scriptFor(body)));
    return (await dryRunFlow(loaded)).problems.join(" | ");
  }

  it("openPage 越界 → dry 红", async () => {
    expect(await problems('  await ctx.openPage("evil");', "h-openpage"))
      .toMatch(/host_not_allowed.*outside the declared hosts envelope/);
  });
  it("arrive 越界 → dry 红", async () => {
    expect(await problems('  await ctx.arrive("https://evil.test/x", { done: ctx.judge.url("x") });', "h-arrive"))
      .toMatch(/host_not_allowed/);
  });
  it("step({url}) 越界 → dry 红", async () => {
    expect(await problems('  await ctx.step("s", { url: "https://evil.test/x", act: ctx.hint("#a"), done: ctx.judge.url("x") });', "h-step"))
      .toMatch(/host_not_allowed/);
  });
  it("正面：hosts 内 / 仓库相对路径不误报", async () => {
    const p = await problems('  await ctx.openPage("home");\n  await ctx.open("testpages/portal.html");\n  await ctx.done();', "h-ok");
    expect(p).toBe("");
  });
});

describe("3) flow 的 web 不变量 signal 加载期校验", () => {
  it("未知算子 → 加载/校验失败，消息列 known", async () => {
    const file = writeScript("inv-bad", `export const meta = (kit) => ({
  id: "inv-bad", label: "x", goal: "g", hosts: [], slots: [],
  invariants: [{ id: "i", signal: { url_containz: "x" } }],
});
export async function flow(ctx) { await ctx.done(); }`);
    await expect(loadScriptApp(file)).rejects.toThrow(/url_containz.*known:/);
  });

  it("空 signal → 拒绝", async () => {
    const file = writeScript("inv-empty", `export const meta = (kit) => ({
  id: "inv-empty", label: "x", goal: "g", hosts: [], slots: [],
  invariants: [{ id: "i", signal: {} }],
});
export async function flow(ctx) { await ctx.done(); }`);
    await expect(loadScriptApp(file)).rejects.toThrow(/empty signal/);
  });
});

describe("4/5) ctx.arrive 是纯导航；ctx.url 三实现一致", () => {
  it("dry：调用序列是 open→arrive→done，open 的 URL 已解析成 file://", async () => {
    const loaded = await loadScriptApp(path.join(REPO, "tests/fixtures/scripts/flow-arrive-url.mjs"));
    const dry = await dryRunFlow(loaded);
    expect(dry.problems).toEqual([]);
    expect(dry.trace.events.map((e) => e.call)).toEqual(["open", "arrive", "done"]);
    expect(dry.trace.events[0]!.url).toMatch(/^file:\/\//);
  });

  it("真实跑：trace 里是 arrive（不是 step），replay 通过（三实现不漂移）", async () => {
    const loaded = await loadScriptApp(path.join(REPO, "tests/fixtures/scripts/flow-arrive-url.mjs"));
    const outDir = fs.mkdtempSync(path.join(tmp, "arrive-"));
    const tracePath = path.join(outDir, "trace.json");
    const res = await runScriptApp(loaded, { verbose: false, outDir, emitTrace: tracePath });
    expect(res.ok).toBe(true);
    const trace = readTrace(tracePath);
    expect(trace.events.map((e) => e.call)).toEqual(["open", "arrive", "done"]);
    expect(trace.events[1]!.ok).toBe(true);
    expect(trace.events[0]!.url).toMatch(/^file:\/\//);
    const replay = await runScriptApp(loaded, { verbose: false, replayTrace: tracePath });
    expect(replay.ok).toBe(true);
  }, 120_000);
});

describe("6) ctx.command 缺省 id 可用（稳定补名）", () => {
  it("normalizeCommandIds：稳定、唯一、保留已有 id", () => {
    const out = normalizeCommandIds([
      { op: "click", target: "#a" } as never,
      { op: "click", target: "#b" } as never,
      { op: "skip", id: "keep" } as never,
    ]);
    expect(out.map((c) => (c as unknown as { id: string }).id)).toEqual(["cmd1_click", "cmd2_click", "keep"]);
  });

  it("dry：ctx.command 组成的闭集不再因缺 id 报错", async () => {
    const file = writeScript("cmd-ids", `export const meta = (kit) => ({ id: "cmd-ids", label: "x", goal: "g", hosts: [], slots: [] });
export async function flow(ctx) {
  await ctx.step("点两次", {
    act: [ctx.command("click", "[data-test=entry-fixed]"), ctx.command("click", "[data-test=entry-ptz]")],
    done: ctx.judge.url("portal.html"),
  });
  await ctx.done();
}`);
    const dry = await dryRunFlow(await loadScriptApp(file));
    expect(dry.problems).toEqual([]);
  });
});

describe("7/8) 工具步纪律与 done 纪律在 dry 也红", () => {
  it("retries>0 但没 idempotent → dry problems 点名", async () => {
    const file = writeScript("retry-no-idem", `export const meta = (kit) => ({ id: "retry-no-idem", label: "x", goal: "g", hosts: [], slots: [] });
export async function flow(ctx) {
  await ctx.run("demo-tool", [], { retries: 2, done: ctx.tool.exitOk(0) });
}`);
    const dry = await dryRunFlow(await loadScriptApp(file));
    expect(dry.problems.join(" | ")).toMatch(/retries=2 needs idempotent: true/);
  });

  it("ctx.done() 两次 → dry 红（真实本来就是 config_error）", async () => {
    const file = writeScript("double-done", `export const meta = (kit) => ({ id: "double-done", label: "x", goal: "g", hosts: [], slots: [] });
export async function flow(ctx) { await ctx.done(); await ctx.done(); }`);
    const dry = await dryRunFlow(await loadScriptApp(file));
    expect(dry.problems.join(" | ")).toMatch(/ctx\.done called twice/);
  });
});

describe("9) sameEventStructure 纳入 result（剥离耗时）", () => {
  function t(result: unknown) {
    return {
      schema_version: 1 as const, app: "x", script_sha256: "a".repeat(64),
      inputs_sha256: "b".repeat(64), done: true,
      events: [{ i: 1, call: "read" as const, desc: "text(#a)", result }],
    };
  }
  it("耗时不同 → 仍算结构相同；结果值被篡改 → 结构不同", () => {
    expect(sameEventStructure(t({ ok: true, elapsed_ms: 1 }), t({ ok: true, elapsed_ms: 99 }))).toBe(true);
    expect(sameEventStructure(t({ ok: true }), t({ ok: false }))).toBe(false);
  });
});

describe("10/11/12) 契约收紧", () => {
  it("AMBERFLOW_NO_SCRIPTS=1 时 loadScriptApp 拒绝 import（apps explain/emit 也挡得住）", async () => {
    process.env.AMBERFLOW_NO_SCRIPTS = "1";
    await expect(loadScriptApp(path.join(REPO, "tests/fixtures/scripts/camera-entry.mjs")))
      .rejects.toThrow(/scripts are disabled \(AMBERFLOW_NO_SCRIPTS=1\)/);
  });

  it("同时导出 app 与 flow → 响亮拒绝", async () => {
    const file = writeScript("both", `export const meta = () => ({ id: "both", label: "x", goal: "g" });
export const app = () => ({ exec: [] });
export async function flow(ctx) { await ctx.done(); }`);
    await expect(loadScriptApp(file)).rejects.toThrow(/exports both "app" and "flow"/);
  });

  it("最小脚本缺 label：回落 id（不再 'label is required'）", async () => {
    const file = writeScript("no-label", `export const meta = () => ({ id: "no-label", goal: "g" });
export async function flow(ctx) { await ctx.done(); }`);
    const loaded = await loadScriptApp(file);
    expect(loaded.pack.label).toBe("no-label");
  });

  it("DOM 未知信号算子：消息列出 known（与 tool/command 口径一致）", () => {
    const p = validateSignalSpec({ url_containz: "x" }, "signal");
    expect(p.join(" | ")).toMatch(/unknown signal op 'url_containz' \(known: /);
  });
});
