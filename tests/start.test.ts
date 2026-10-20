/**
 * `npm start` — the onboarding path, executed.
 *
 * The complaint this answers: getting from a fresh checkout to a running job took too many
 * steps, and the hard step was AUTHORING the plan (its completion signal and target). So the
 * entry point either runs a bundled job with zero configuration, or WATCHES one transition on
 * the user's page and compiles the plan from it.
 *
 * These tests pin both promises, plus the safety property the first draft got wrong: when
 * nobody can answer the picker, it must NOT act on a guess.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { demoSucceeded, doctorReport, main, preflight, type Io, type Preflight } from "../src/start.ts";
import type { ModelArtifacts } from "../src/model-artifacts.ts";
import { BrowserMiddleware } from "../src/executor.ts";
import { checkSignal } from "../src/signals.ts";
import { installLayaRuntime } from "../src/model.ts";

afterAll(() => installLayaRuntime(null));

const REPO = new URL("..", import.meta.url).pathname;
const PRODUCT = `file://${REPO}testpages/product.html`;

function recording(): { io: Io; lines: string[] } {
  const lines: string[] = [];
  return { lines, io: { out: (l) => lines.push(l), ask: async () => null } };
}

describe("doctor — say what is ready and what is missing", () => {
  it("reports every prerequisite in plain language", () => {
    const r = doctorReport(preflight());
    const text = r.lines.join("\n");
    expect(text).toMatch(/Node\s+\d+\./);
    expect(text).toMatch(/chromium/);
    expect(text).toMatch(/决策模型/);
    expect(text).toMatch(/LLM/);
    // whatever the state, it either explains the fix or points at the first command
    expect(text).toMatch(/playwright install chromium|npm start/);
    expect(r.ok || /✗/.test(text)).toBe(true);
  });

  it("缺件报告带操作：点名缺哪件，并给出一条补齐命令（P0 的『缺 → 一条命令补』）", () => {
    const mk = (a: Partial<ModelArtifacts>): Preflight => {
      const artifacts = {
        onnxPath: "/tmp/laya_dec.onnx", dataPath: "/tmp/laya_dec.onnx.data",
        graph: false, weights: false, tokenizerDir: null, ready: false, ...a,
      };
      // 与 `preflight()` 同一规则：model 就是"三件齐"（旧版只看两个文件，tokenizer 缺了也说真模型）。
      return {
        node: "22.6.0", nodeOk: true, chromium: "/bin/chromium", llm: false, browserPath: null,
        model: artifacts.ready, artifacts,
      };
    };
    const all = doctorReport(mk({})).lines.join("\n");
    expect(all).toContain("缺 ONNX 图 / 外置权重 .onnx.data / tokenizer");
    expect(all).toContain("npm run model:fetch -- --from");
    expect(all).toContain("[--tokenizer <path|url>]");
    // 只缺 tokenizer 时，补齐命令同样点名 tokenizer（它就是要补的那一件），不误报缺图。
    const tokOnly = doctorReport(mk({ graph: true, weights: true })).lines.join("\n");
    expect(tokOnly).toContain("缺 tokenizer");
    expect(tokOnly).toContain("[--tokenizer <path|url>]");
    expect(tokOnly).not.toContain("ONNX 图");
    // 齐了就说齐了——同一行的 ✓ 不许骗人（旧版只看两个文件，tokenizer 缺了也报"真模型"）。
    const ready = doctorReport(mk({ graph: true, weights: true, tokenizerDir: "/tok", ready: true })).lines.join("\n");
    expect(ready).toMatch(/决策模型.*✓ 真模型（图 \+ 权重 \+ tokenizer 齐）/);
    expect(ready).not.toContain("model:fetch");
  });
});

describe("demo 完成判定 — 只认子目标状态（2026-10-14 审查修的双向缺陷）", () => {
  const rep = (statuses: string[], traces: number) => ({
    plan: { subgoals: statuses.map((status) => ({ status })) },
    traces: Array.from({ length: traces }, () => ({})),
  });
  it("1/2（第二步阻塞）不是绿：旧 startsWith(String(traces.length)) 会判成 0", () => {
    expect(demoSucceeded(rep(["done", "blocked"], 1) as never)).toBe(false);
  });
  it("2/2 但带重试（traces 比子目标多）仍是绿：旧口径会判成红", () => {
    expect(demoSucceeded(rep(["done", "done"], 4) as never)).toBe(true);
  });
  it("空计划不算成功（无子目标 = 没有发生过任何验收）", () => {
    expect(demoSucceeded(rep([], 0) as never)).toBe(false);
  });
  it("skipped 的条件步不自动等于失败？——开箱 demo 没有条件步，状态表按 done 全等判", () => {
    expect(demoSucceeded(rep(["done", "skipped"], 2) as never)).toBe(false);
  });
});

describe("npm start — the bundled job needs no configuration", () => {
  it("a typo'd flag gets a one-liner + usage and exit 2 — no raw parseArgs stack", async () => {
    // 实测缺陷（2026-10-14 开箱测试轮）：`npm start -- --out /tmp/x` 直接把
    // ERR_PARSE_ARGS_UNKNOWN_OPTION 整段堆栈打给第一次用的人。
    const { io, lines } = recording();
    const code = await main(["--out", "/tmp/x"], io, { noModel: true });
    expect(code).toBe(2);
    const text = lines.join("\n");
    expect(text).toContain("参数用法不对");
    expect(text).toContain("--out");
    expect(text).toContain("npm start —");      // USAGE 跟在后面，给下一步可抄的命令
    expect(text).not.toMatch(/ at .*\.(ts|js):\d+/);   // 没有堆栈
  });

  it("REALLY works with no model runtime installed (the rules-only promise)", async () => {
    // This is the claim `npm run doctor` makes in rules mode, and the first version of the
    // entry point was false: the executor called getLayaRuntime() during setup and blocked
    // before any rule could fire. Now an unconfigured runtime is a MODE, not a crash.
    installLayaRuntime(null);
    const { io, lines } = recording();
    const plan = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "start-rulesonly-")), "plan.json");
    const code = await main(["--demo", "--plan", plan], io, { noModel: true });
    const text = lines.join("\n");
    expect(code).toBe(0);
    expect(text).toMatch(/结果：2\/2/);
    expect(text).toMatch(/rule:match, rule:match/);
  }, 180_000);

  it("and when a step DOES need the model it says so, instead of blaming confidence", async () => {
    installLayaRuntime(null);
    const mw = new BrowserMiddleware({ maxSteps: 1, confirmFn: () => true });
    // no hint in the plan and a goal no rule can match → nothing but a model pick is left
    const rep = await mw.run("做点什么", PRODUCT, {
      slots: {}, goalSignalFn: (p) => checkSignal(p as never, { css_exists: "#nope" }), verbose: false,
    });
    expect(rep.done).toBe(false);
    expect(rep.stop_reason).toMatch(/rules-only mode/);
    expect(rep.stop_reason).not.toMatch(/low confidence/);
  }, 120_000);

  it("runs the two-subgoal plan on the bundled pages, resolved by plan-named targets", async () => {
    const { io, lines } = recording();
    const plan = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "start-demo-")), "plan.json");
    const code = await main(["--demo", "--plan", plan], io, { noModel: true });
    const text = lines.join("\n");
    expect(code).toBe(0);
    expect(text).toMatch(/结果：2\/2/);
    expect(text).toMatch(/rule:match, rule:match/);       // zero model picks
  }, 180_000);
});

describe("npm start -- --goal ... --url ... — demonstrate once, then run", () => {
  it("induces the completion signal and names the target, then completes", async () => {
    const { io, lines } = recording();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "start-job-"));
    const planPath = path.join(dir, "plan.json");
    const code = await main([
      "--goal", "把无线鼠标加入购物车", "--url", PRODUCT,
      "--target", "[data-test=add-to-cart]", "--plan", planPath,
    ], io, { noModel: true });
    const text = lines.join("\n");

    expect(code).toBe(0);
    expect(text).toMatch(/归纳出完成信号/);
    expect(text).toMatch(/结果：1\/1/);

    // the compiled plan is exactly the shape a hand-written one would have been
    const plan = JSON.parse(fs.readFileSync(planPath, "utf-8")) as {
      goal: string; subgoals: Array<Record<string, unknown>>;
    };
    expect(plan.goal).toBe("把无线鼠标加入购物车");
    expect(plan.subgoals[0]!["signal"]).toEqual({ css_text_equals: ["[data-test=cart-count]", "1"] });
    expect(plan.subgoals[0]!["target_hint"]).toBe("[data-test=add-to-cart]");   // → zero model calls
    expect(plan.subgoals[0]!["status"]).toBe("done");
  }, 180_000);

  it("--dry-run stops after writing the plan", async () => {
    const { io, lines } = recording();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "start-dry-"));
    const planPath = path.join(dir, "plan.json");
    const code = await main([
      "--goal", "把无线鼠标加入购物车", "--url", PRODUCT,
      "--target", "[data-test=add-to-cart]", "--plan", planPath, "--dry-run",
    ], io, { noModel: true });
    expect(code).toBe(0);
    expect(fs.existsSync(planPath)).toBe(true);
    expect(lines.join("\n")).toMatch(/--dry-run/);
    expect(lines.join("\n")).not.toMatch(/结果：/);          // nothing was executed
  }, 180_000);

  it("REFUSES to act when nobody can answer the picker (no accidental click)", async () => {
    const { io, lines } = recording();                        // ask() always returns null
    const planPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "start-noask-")), "plan.json");
    // the goal is in Chinese and the page is in English, so no rule can pick for us
    const code = await main([
      "--goal", "把无线鼠标加入购物车", "--url", PRODUCT, "--plan", planPath,
    ], io, { noModel: true });
    const text = lines.join("\n");
    expect(code).toBe(2);
    expect(text).not.toMatch(/执行演示/);                     // it did NOT click anything
    expect(text).toMatch(/--target/);                         // it says how to name the target
    expect(fs.existsSync(planPath)).toBe(false);              // and wrote no plan
  }, 180_000);
});

describe("--provider：与 apps/suite/bench 同一扇决策源的门", () => {
  it("拼错的 provider 名在浏览器起之前就被用法错误点名（不静默退回缺省）", async () => {
    const { io, lines } = recording();
    const code = await main(["--provider", "no-such-decision-provider"], io);
    expect(code).toBe(2);
    expect(lines.join("\n")).toMatch(/no-such-decision-provider/);
  });
});
