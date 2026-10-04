/** Plan-contract tests — ported from test_middleware.py, plus the port's M2 fix. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PlanningRules, TaskPlan } from "../src/plan.ts";
import { extractSlots } from "../src/extraction.ts";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "layaplan-"));
});

describe("TaskPlan — disk round-trips preserve every contract field", () => {
  it("keeps target_hint through the constructor and the file", () => {
    // Measured bug: the constructor whitelist dropped target_hint, so every hint
    // vanished after one disk round-trip while unit tests stayed green.
    const p = path.join(tmp, "plan.json");
    const plan = new TaskPlan("goal", [{
      desc: "d", signal: { url_contains: "x" }, start_url: "u", target_hint: "input[type=submit]",
    }], p);
    plan.save();
    expect(TaskPlan.load(p)!.subgoals[0]!.target_hint).toBe("input[type=submit]");
    expect(JSON.parse(fs.readFileSync(p, "utf-8")).subgoals[0].target_hint).toBe("input[type=submit]");
  });

  it("keeps hint lists and per-step slots (form search contract)", () => {
    const p = path.join(tmp, "plan2.json");
    const plan = new TaskPlan("g", [{
      desc: "fill and submit", signal: { css_exists: "#results" },
      target_hints: ["input[name=date]", "button[type=submit]"],
      slots: { date: "2026-10-06" },
    }], p);
    plan.save();
    const back = TaskPlan.load(p)!.subgoals[0]!;
    expect(back.target_hints).toEqual(["input[name=date]", "button[type=submit]"]);
    expect(back.slots).toEqual({ date: "2026-10-06" });
  });

  it("keeps when and retries, and rejects a bad retries value at validation", () => {
    const p = path.join(tmp, "plan3.json");
    const plan = new TaskPlan("g", [{
      desc: "conditional", signal: { css_exists: "#ok" },
      when: { css_exists: ".promo-overlay" }, retries: 2,
    }], p);
    plan.save();
    const back = TaskPlan.load(p)!.subgoals[0]!;
    expect(back.when).toEqual({ css_exists: ".promo-overlay" });
    expect(back.retries).toBe(2);

    const bad = new TaskPlan("g", [{ desc: "x", signal: { css_exists: "#x" } }]);
    bad.subgoals[0]!.retries = -1;
    expect(new PlanningRules().problems(bad)).toContain("subgoal[0]: retries must be a non-negative integer");
  });
});

describe("TaskPlan — manual editing surface", () => {
  it("keeps target_hint through insert() and update()", () => {
    const plan = new TaskPlan("g", [], path.join(tmp, "p.json"));
    plan.insert(0, "add item", { css_text_equals: ["#n", "1"] }, null, "button[near~onesie]");
    expect(plan.subgoals[0]!.target_hint).toBe("button[near~onesie]");
    plan.update(0, { target_hint: "input[type=submit]" });
    expect(plan.subgoals[0]!.target_hint).toBe("input[type=submit]");
    plan.save();
    expect(TaskPlan.load(plan.path)!.subgoals[0]!.target_hint).toBe("input[type=submit]");
  });

  it("PORT FIX (Python audit M2): insert() carries when/retries too", () => {
    // Python's insert() had no when/retries parameters, so a replan amendment
    // lost its guard and retry policy. The TS port closes the gap.
    const plan = new TaskPlan("g", [], path.join(tmp, "p2.json"));
    plan.insert(0, "dismiss overlay", { css_exists: "#gone" }, null, null, null, null,
      { css_exists: ".overlay" }, 3);
    expect(plan.subgoals[0]!.when).toEqual({ css_exists: ".overlay" });
    expect(plan.subgoals[0]!.retries).toBe(3);
    plan.save();
    const back = TaskPlan.load(plan.path)!.subgoals[0]!;
    expect(back.when).toEqual({ css_exists: ".overlay" });
    expect(back.retries).toBe(3);
  });

  it("keeps status/obstacle on disk (resume semantics) and exposes pending()/summary()", () => {
    const p = path.join(tmp, "p3.json");
    const plan = new TaskPlan("g", [
      { desc: "a", signal: { css_exists: "#a" } },
      { desc: "b", signal: { css_exists: "#b" } },
    ], p);
    plan.subgoals[0]!.status = "done";
    plan.subgoals[1]!.status = "blocked";
    plan.subgoals[1]!.obstacle = "no DOM signal to verify";
    plan.save();
    const back = TaskPlan.load(p)!;
    expect(back.subgoals[0]!.status).toBe("done");
    expect(back.subgoals[1]!.obstacle).toBe("no DOM signal to verify");
    expect(back.pending()).toHaveLength(0);
    expect(back.summary()).toContain("done:a");
  });
});

describe("PlanningRules — the same rules validate LLM output and manual edits", () => {
  it("requires a done-signal and accepts the executor's signal shapes", () => {
    const rules = new PlanningRules(2);
    const bad = new TaskPlan("g", [{ desc: "x", signal: {} }]);
    expect(rules.problems(bad).some((i) => i.includes("missing done-signal"))).toBe(true);

    for (const sig of [
      { url_contains: "ok" },                    // cases.json style
      { url_contains: ["ok"] },                  // plan_cli style
      { css_exists: "#done" },
      { css_text_equals: ["#total", "42"] },
      { css_text_contains: ["#h1", "Turing"] },
      { css_value_equals: ["#qty", 3] },         // non-str scalar must not crash
    ]) {
      expect(rules.problems(new TaskPlan("g", [{ desc: "x", signal: sig }]))).toEqual([]);
    }
  });

  it("reports arity and unknown ops with the Python suite's exact messages", () => {
    const rules = new PlanningRules(2);
    expect(rules.problems(new TaskPlan("g", [{ desc: "x", signal: { css_text_equals: "#x" } }])))
      .toEqual(["subgoal[0]: css_text_equals needs 2 argument(s)"]);
    expect(rules.problems(new TaskPlan("g", [{ desc: "x", signal: { nope: "1" } }])))
      .toEqual(["subgoal[0]: unknown signal op 'nope'"]);
  });

  it("caps subgoal count and validates hint shapes", () => {
    const rules = new PlanningRules(1);
    expect(rules.problems(new TaskPlan("g", [
      { desc: "a", signal: { css_exists: "#a" } }, { desc: "b", signal: { css_exists: "#b" } },
    ]))).toContain("2 subgoals exceed max 1");
    expect(rules.problems(new TaskPlan("g", [{ desc: "x", signal: { css_exists: "#x" }, target_hints: [] }])))
      .toContain("subgoal[0]: target_hints must be a non-empty list of strings");
    expect(rules.problems(new TaskPlan("g", [{ desc: "x", signal: { css_exists: "#x" }, target_hint: "  " }])))
      .toContain("subgoal[0]: target_hint must be a non-empty string");
  });

  it("renders the prompt rules it enforces", () => {
    const txt = new PlanningRules(4, true, true, ["pay"]).promptText();
    expect(txt).toContain("at most 4 subgoals");
    expect(txt).toContain("css_text_contains");
    expect(txt).toContain("every subgoal needs an explicit start_url");
    expect(txt).toContain("forbidden in descriptions: pay");
  });
});

describe("extractSlots", () => {
  it("parses ASCII keys only — CJK keys are the slots bag's job", () => {
    expect(extractSlots("add item=Wireless Mouse X200")).toEqual({ item: "Wireless" });
    expect(extractSlots("填写 序列号: GC-8801")).toEqual({});
  });
});

describe("PlanningRules：`when` 与 `signal` 同一套语言、同一套校验", () => {
  it("未知算子/空 when 都在 plan 校验期被抓到（不再等到运行期 BLOCKED）", () => {
    const rules = new PlanningRules(10, true, false);
    const plan = new TaskPlan("g", [
      { desc: "d", start_url: "file:///x.html", target_hint: "a", signal: { css_exists: "#a" },
        when: { magic_op: "#x" } },
      { desc: "d2", start_url: "file:///x.html", target_hint: "a", signal: { css_exists: "#a" },
        when: {} as never },
    ] as never, ":memory:", {});
    const issues = rules.problems(plan).join(" | ");
    expect(issues).toContain("subgoal[0].when: unknown signal op 'magic_op'");
    expect(issues).toContain("subgoal[1].when: must be a non-empty signal");
  });

  it("合法的 when 零问题，且 when 是 null/缺省时不许报错", () => {
    const rules = new PlanningRules(10, true, false);
    const plan = new TaskPlan("g", [
      { desc: "d", start_url: "file:///x.html", target_hint: "a",
        signal: { css_exists: "#a" }, when: { css_exists: "#promo" } },
      { desc: "d2", start_url: "file:///x.html", target_hint: "a",
        signal: { css_exists: "#a" }, when: null as never },
    ] as never, ":memory:", {});
    expect(rules.problems(plan)).toEqual([]);
  });
});
