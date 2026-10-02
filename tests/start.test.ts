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
import { doctorReport, main, preflight, type Io } from "../src/start.ts";
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
});

describe("npm start — the bundled job needs no configuration", () => {
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
