/**
 * Plan-CLI tests: signal parsing, the CRUD surface, validation, and the port's
 * M3 fix (a SKIPPED conditional subgoal counts as finished, not as failure).
 * The run path is exercised with an injected middleware + session factory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FILE, cmdAdd, cmdCheck, cmdDel, cmdEdit, cmdMove, cmdNew, cmdReset, cmdRun, cmdShow,
  main, parseSignal, type CliIO,
} from "../src/cli/plan-cli.ts";
import { TaskPlan } from "../src/engine/plan.ts";
import { amberflowHome } from "../src/app/amberflow-home.ts";
import type { BrowserSession } from "../src/engine/executor.ts";
import type { MiddlewareLike, MiddlewareReport } from "../src/engine/planner.ts";

let tmp: string;
let file: string;
let out: string[];
const io: CliIO = { out: (s) => out.push(s), ask: async () => true };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "layacli-"));
  file = path.join(tmp, "plan.json");
  out = [];
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_API_KEY;
});

describe("parseSignal", () => {
  it("parses single-argument operators", () => {
    expect(parseSignal("url_contains=cart.html")).toEqual({ url_contains: ["cart.html"] });
    expect(parseSignal("css_exists=#done")).toEqual({ css_exists: ["#done"] });
  });

  it("parses selector|value operators, keeping '|' inside the value", () => {
    expect(parseSignal("css_text_equals=#total|42")).toEqual({ css_text_equals: ["#total", "42"] });
    expect(parseSignal("css_text_contains=h1|a|b")).toEqual({ css_text_contains: ["h1", "a|b"] });
  });

  it("rejects unknown operators and missing selector|value", () => {
    expect(() => parseSignal("nope=1")).toThrow(/unknown signal op/);
    expect(() => parseSignal("css_text_equals=#only")).toThrow(/needs 'selector\|value'/);
  });
});

describe("CRUD surface", () => {
  it("new (manual skeleton) saves a file that check accepts once filled", async () => {
    await cmdNew({ goal: "buy a mouse", file, llm: false, url: "https://shop/p", max: 8 }, io);
    expect(fs.existsSync(file)).toBe(true);
    let plan = TaskPlan.load(file)!;
    expect(plan.goal).toBe("buy a mouse");
    expect(plan.subgoals).toHaveLength(0);

    cmdAdd(file, 0, "add to cart", "css_text_contains=[data-test=cart-count]|1",
      "https://shop/p", "button[data-test=add-to-cart]", io);
    plan = TaskPlan.load(file)!;
    expect(plan.subgoals[0]!.target_hint).toBe("button[data-test=add-to-cart]");
    expect(plan.subgoals[0]!.start_url).toBe("https://shop/p");

    expect(cmdCheck(file, 8, io)).toBe(true);
    expect(out.join("\n")).toContain("pass the planning rules");

    cmdShow(file, io);
    expect(out.join("\n")).toContain("target_hint=button[data-test=add-to-cart]");
  });

  it("check rejects a plan whose subgoal has no signal", async () => {
    await cmdNew({ goal: "g", file, llm: false, url: null, max: 8 }, io);
    const plan = TaskPlan.load(file)!;
    plan.insert(0, "no signal", {}, null);
    plan.save();
    expect(cmdCheck(file, 8, io)).toBe(false);
    expect(out.join("\n")).toContain("missing done-signal");
  });

  it("edit keeps the hint, move/del/reset rewrite the plan", async () => {
    await cmdNew({ goal: "g", file, llm: false, url: null, max: 8 }, io);
    cmdAdd(file, 0, "a", "css_exists=#a", null, null, io);
    cmdAdd(file, 1, "b", "css_exists=#b", null, null, io);

    cmdEdit(file, 0, { hint: "input[type=submit]", desc: "a2" }, io);
    let plan = TaskPlan.load(file)!;
    expect(plan.subgoals[0]!.target_hint).toBe("input[type=submit]");
    expect(plan.subgoals[0]!.desc).toBe("a2");

    cmdMove(file, 0, 1, io);
    plan = TaskPlan.load(file)!;
    expect(plan.subgoals.map((s) => s.desc)).toEqual(["b", "a2"]);

    cmdDel(file, 0, io);
    expect(TaskPlan.load(file)!.subgoals.map((s) => s.desc)).toEqual(["a2"]);

    plan = TaskPlan.load(file)!;
    plan.subgoals[0]!.status = "blocked";
    plan.subgoals[0]!.obstacle = "stuck";
    plan.save();
    cmdReset(file, io);
    plan = TaskPlan.load(file)!;
    expect(plan.subgoals[0]!.status).toBe("pending");
    expect(plan.subgoals[0]!.obstacle).toBeNull();
  });

  it("the default plan file lives in the user's home, not in the checkout", () => {
    // 运行产物不写 checkout：`npm start` 与 plan-cli 共用同一个默认落点（`defaultPlanPath`）。
    expect(DEFAULT_FILE).toBe(path.join(amberflowHome(), "task_plan.json"));
  });
});

describe("main() argument surface", () => {
  it("routes subcommands and reports usage", async () => {
    expect(await main([], io)).toBe(1);
    expect(out.join("\n")).toContain("Plan CLI");
    out = [];
    await main(["new", "g", "--file", file], io);
    await main(["add", "0", "a", "--signal", "css_exists=#a", "--file", file], io);
    expect(await main(["check", "--file", file], io)).toBe(0);
    expect(await main(["bogus"], io)).toBe(2);
  });
});

/* --------------------------------------------------------------- run (M3 fix) */

class OneShotMW implements MiddlewareLike {
  _planVerbose = false;
  report: MiddlewareReport;
  constructor(report: MiddlewareReport) { this.report = report; }
  async run(): Promise<MiddlewareReport> {
    return this.report;
  }
}

const sessionFactory = async (): Promise<BrowserSession> =>
  ({ pw: "PW", page: "PAGE", browser: {}, close: async () => {} }) as unknown as BrowserSession;

describe("cmdRun — completion semantics (Python audit M3 fixed in the port)", () => {
  it("exits 0 when a conditional subgoal was SKIPPED (Python exited 1 here)", async () => {
    const plan = new TaskPlan("g", [
      { desc: "dismiss overlay if present", signal: { css_exists: "#gone" }, when: { css_exists: ".overlay" }, start_url: "https://shop/p" },
    ], file);
    plan.save();
    const mw = new OneShotMW({ done: true, skipped: true, steps: [], stop_reason: "precondition not met" });
    const res = await cmdRun({ file, max: 8, reset: false, confirm: "allow", replan: false }, io, {
      middleware: mw, sessionFactory,
    });
    expect(res.completed).toBe("0/1 (+1 skipped)");
    expect(res.finished).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.audit.verdict).toBe("APPROVE");
  });

  it("exits 1 when a subgoal is blocked", async () => {
    new TaskPlan("g", [{ desc: "click buy", signal: { css_exists: "#ok" }, start_url: "https://shop/p" }], file).save();
    const mw = new OneShotMW({ done: false, steps: [], stop_reason: "stuck" });
    const res = await cmdRun({ file, max: 8, reset: false, confirm: "allow", replan: false }, io, {
      middleware: mw, sessionFactory,
    });
    expect(res.completed).toBe("0/1");
    expect(res.finished).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.audit.verdict).toBe("REJECT");
  });

  it("refuses an invalid plan before opening anything", async () => {
    new TaskPlan("g", [{ desc: "no signal", signal: {} }], file).save();
    await expect(cmdRun({ file, max: 8, reset: false, confirm: "allow", replan: false }, io, {
      middleware: new OneShotMW({ done: true, steps: [], stop_reason: "x" }), sessionFactory,
    })).rejects.toThrow(/plan is invalid/);
  });
});
