/**
 * Flow-spec tests — ported from `transfer/test_transfer.py`'s structural suite.
 * The numbers here are the ones the project's own reports quote (19/23/24/24/19
 * subgoals, extra roles per replica), so they pin the expansion, not just shapes.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REPO, SPECS, deriveFlightSubgoals, deriveHotelSubgoals, deriveSubgoals, loadSpec,
  migrationMetrics, roles, shape, specRoles, stagePhases, stepUrl, validateSpec,
  type FlowSpec,
} from "../src/flow.ts";
import type { Subgoal } from "../src/plan.ts";

const DATES = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"];
const WD: Record<string, string> = {
  "2026-10-05": "周一", "2026-10-06": "周二", "2026-10-07": "周三",
  "2026-10-08": "周四", "2026-10-09": "周五",
};
const weekdayCn = (d: string): string => WD[d] ?? d;
const specNames = fs.readdirSync(SPECS).filter((f) => f.endsWith(".json")).sort();
const load = (name: string): FlowSpec => loadSpec(path.join(SPECS, name));

describe("specs load and validate (7 sites)", () => {
  it("finds seven specs", () => {
    expect(specNames).toHaveLength(7);
  });

  it.each(specNames)("%s loads, validates and expands", (name) => {
    const spec = load(name);
    expect(validateSpec(spec)).toEqual([]);
    expect(spec._path).toBeTruthy();
    const sgs = deriveSubgoals(spec, DATES, "2026-10-08", weekdayCn);
    expect(sgs.length).toBeGreaterThan(0);
    expect(sgs.length).toBe(specRoles(spec, DATES).length);   // roles align with the expansion
    for (const sg of sgs) {
      expect(sg.desc).toBeTruthy();
      expect(sg.start_url).toMatch(/^file:\/\//);
      expect(Object.keys(sg.signal).length).toBeGreaterThan(0);
      const hints = sg.target_hints ?? (sg.target_hint ? [sg.target_hint] : []);
      expect(hints.length).toBeGreaterThan(0);
      expect(Boolean(sg.target_hints) && Boolean(sg.target_hint)).toBe(false);   // never both
    }
  });

  it("reproduces the documented subgoal counts (3 flight steps × 5 dates + hotel + collect)", () => {
    const counts = Object.fromEntries(specNames.map((n) => {
      const spec = load(n);
      return [n, deriveSubgoals(spec, DATES, "2026-10-08", weekdayCn).length];
    }));
    expect(counts["ctrip.json"]).toBe(19);
    expect(counts["skybook.json"]).toBe(23);
    expect(counts["voyagio.json"]).toBe(24);
    expect(counts["farehaven.json"]).toBe(24);
    expect(counts["slowjet.json"]).toBe(19);
    expect(counts["trekly.json"]).toBe(19);
    expect(counts["flyquest.json"]).toBe(19);
  });
});

describe("the skeleton SHAPE is config", () => {
  it("voyagio is a two-page wizard: a second per_date phase, no new keyword", () => {
    const spec = load("voyagio.json");
    expect(shape(spec)).toContain("wizard_date[per_date]×1");
    expect(shape(spec)).toContain("wizard_options[per_date]×1");
    expect(shape(spec)).toContain("results[per_date]×2");
    expect(stagePhases(spec, "flight")).toHaveLength(4);
  });

  it("farehaven's promo dismissal is a guarded (when) subgoal, present 5×", () => {
    const spec = load("farehaven.json");
    const sgs = deriveSubgoals(spec, DATES, "2026-10-08", weekdayCn);
    const guarded = sgs.filter((s) => s.when);
    expect(guarded).toHaveLength(5);
    expect(guarded[0]!.when).toHaveProperty("css_exists");
  });

  it("slowjet's cold page declares retries (whole-step retry, shape unchanged)", () => {
    const spec = load("slowjet.json");
    const sgs = deriveFlightSubgoals(spec, DATES, weekdayCn);
    const retried = sgs.filter((s) => s.retries);
    expect(retried).toHaveLength(5);
    expect(retried[0]!.retries).toBe(1);
    expect(shape(spec)).toEqual(shape(load("ctrip.json")));   // runtime policy, not structure
  });
});

describe("expansion details", () => {
  it("per_date repeats the phase per date and fills {date}/{wd}", () => {
    const spec = load("ctrip.json");
    const sgs = deriveFlightSubgoals(spec, DATES, weekdayCn);
    // entry[once]×1 + flights[per_date]×3 × 5 dates = 16 (entry also runs in the flight stage)
    expect(sgs).toHaveLength(16);
    const perDate = sgs.filter((s) => s.start_url?.includes("2026-10-05"));
    expect(perDate).toHaveLength(3);
    expect(perDate[0]!.desc).toContain("2026-10-05");
    expect(perDate[0]!.desc).toContain("周一");
  });

  it("step_url keeps the site directory and urlencodes CJK query values", () => {
    const spec = load("ctrip.json");
    const step = stagePhases(spec, "flight").find((p) => p.repeat === "per_date")!.steps[0]!;
    const url = stepUrl(spec, step, { date: DATES[0], wd: "周一", checkin: "" });
    expect(url).toContain(path.resolve(REPO, spec.site_dir).replace(/^\//, "file:///"));
    const q = new URL(url).searchParams;
    expect(q.get("date")).toBe(DATES[0]);
    const city = q.get("city") ?? q.get("from") ?? "";
    expect(city === "" || !city.includes(" ")).toBe(true);
  });

  it("unknown placeholders fail loudly at expansion", () => {
    const spec = load("ctrip.json");
    const broken = structuredClone(spec) as FlowSpec;
    broken.phases[0]!.steps[0]!.desc = "go to {nowhere}";
    expect(() => deriveFlightSubgoals(broken, DATES, weekdayCn)).toThrow(/unknown placeholder/);
  });

  it("hotel subgoals repeat per_checkin and carry a checkin-based url", () => {
    const spec = load("ctrip.json");
    const hotel = deriveHotelSubgoals(spec, "2026-10-08");
    expect(hotel).toHaveLength(3);                       // hotel[per_checkin]×2 + collect[per_checkin]×1
    expect(hotel.filter((s) => s.start_url?.includes("2026-10-08")).length).toBeGreaterThan(0);
  });
});

describe("validation catches the mistakes that would break a run", () => {
  const broken = (mutate: (s: FlowSpec) => void): string[] => {
    const spec = structuredClone(load("ctrip.json")) as FlowSpec;
    mutate(spec);
    return validateSpec(spec);
  };

  it("missing top-level fields, bad site_dir", () => {
    expect(broken((s) => { delete (s as Record<string, unknown>).name; })).toContain("missing 'name'");
    expect(broken((s) => { s.site_dir = "nowhere/at/all"; })).toContain("site_dir does not exist: 'nowhere/at/all'");
  });

  it("bad repeat / stage", () => {
    expect(broken((s) => { s.phases[0]!.repeat = "weekly" as never; }).join("\n")).toContain("repeat must be one of");
    expect(broken((s) => { s.phases[0]!.stage = "bus" as never; }).join("\n")).toContain("stage must be one of");
  });

  it("step-level: desc/path/hints/signal/retries", () => {
    const strip = (s: FlowSpec, key: string): void => {
      delete (s.phases[0]!.steps[0] as unknown as Record<string, unknown>)[key];
    };
    expect(broken((s) => strip(s, "desc"))).toContain("entry[0]: missing desc");
    expect(broken((s) => strip(s, "path"))).toContain("entry[0]: missing path");
    expect(broken((s) => { delete s.phases[0]!.steps[0]!.hint; }).join("\n")).toContain("missing hint/hints");
    expect(broken((s) => { s.phases[0]!.steps[0]!.hints = [s.phases[0]!.steps[0]!.hint!]; })
      .join("\n")).toContain("use hint OR hints, not both");
    expect(broken((s) => { s.phases[0]!.steps[0]!.retries = -1; })
      .join("\n")).toContain("retries must be a non-negative integer");
    expect(broken((s) => { s.phases[0]!.steps[0]!.signal = { nope: "1" }; })
      .join("\n")).toContain("unknown signal op 'nope'");
  });

  it("signal arity is enforced with the executor's shapes", () => {
    expect(broken((s) => { s.phases[0]!.steps[0]!.signal = { css_text_equals: "#only-selector" }; })
      .join("\n")).toContain("signal css_text_equals needs 2 argument(s)");
    // a `when` guard is validated with the same language and arity
    expect(broken((s) => { s.phases[0]!.steps[0]!.when = { css_value_equals: "#x" }; })
      .join("\n")).toContain("when css_value_equals needs 2 argument(s)");
  });
});

describe("migration metrics (role-aligned)", () => {
  const expand = (name: string): Subgoal[] => {
    const spec = load(name);
    return deriveSubgoals(spec, DATES, "2026-10-08", weekdayCn);
  };
  const metrics = (base: string, other: string) => migrationMetrics(expand(base), expand(other), {
    baselineSpec: load(base), otherSpec: load(other), dates: DATES,
  });

  it("counts shared roles and reports the shape on both sides", () => {
    const m = metrics("ctrip.json", "skybook.json");
    expect(m.shared_roles).toBe(18);
    expect(m.subgoals).toEqual({ baseline: 19, other: 23 });
    expect(m.shape.baseline).toContain("collect[per_checkin]×1");
    expect(m.shape.other).toContain("collect[per_checkin]×5");
    expect(m.desc_identical_normalized).toBe("18/18");
  });

  it("attributes the extra steps to the site's own collect roles, not to shared ones", () => {
    // skybook's extra collect steps live in `collect_roles`, so they are NOT "extra roles"
    expect(metrics("ctrip.json", "skybook.json").extra_roles).toEqual({});
  });

  it("sees the conditional replica's extra role and the form-search action count", () => {
    const farehaven = metrics("ctrip.json", "farehaven.json");
    expect(farehaven.extra_roles).toEqual({ dismiss_promo: 5 });
    expect(farehaven.extra_subgoals).toBe(5);

    const flyquest = metrics("ctrip.json", "flyquest.json");
    expect(flyquest.shared_roles).toBe(18);
    expect(flyquest.actions.baseline).toBe(18);
    expect(flyquest.actions.other).toBeGreaterThan(flyquest.actions.baseline);   // form: 3 hints/steps
  });

  it("voyagio's wizard adds filtered steps as extra roles", () => {
    expect(metrics("ctrip.json", "voyagio.json").extra_roles).toEqual({ filter_window_apply: 5 });
  });

  it("normalises dates, weekdays, site names and the cap phrasing", () => {
    const m = metrics("ctrip.json", "skybook.json");
    expect(m.normalized_away.join("")).toContain("日期/星期");
    expect(m.desc_identical_normalized).toBe("18/18");
  });
});

describe("roles / slots helpers", () => {
  it("roles() mirrors specRoles()", () => {
    const spec = load("trekly.json");
    expect(roles(spec, DATES)).toEqual(specRoles(spec, DATES));
    expect(specRoles(spec)).toHaveLength(specRoles(spec, [DATES[0]!]).length);   // n=1 default
  });

  it("shape() summarises phases and repeats", () => {
    expect(shape(load("ctrip.json"))).toEqual([
      "entry[once]×1", "flights[per_date]×3", "hotel[per_checkin]×2", "collect[per_checkin]×1",
    ]);
    expect(shape(null)).toEqual([]);
  });
});
