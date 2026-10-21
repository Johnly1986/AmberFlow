/**
 * IP-plan driver tests: sheet reading, plan shape, URL/portal wiring, and the
 * full four-row run (3 configured + 1 rejected by the device page's own check)
 * through the production executor with a scripted model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEMO_ROWS, PORTAL, XLSX, buildPlan, configureAll, ensureXlsx, main, readXlsx, settingsUrl,
} from "../src/cli/ip-config.ts";
import { PlanningRules } from "../src/engine/plan.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer, type Question } from "../src/model/model.ts";

afterAll(() => installLayaRuntime(null));

function installScripted(): void {
  const agent = scriptedAgent((key: string, _s: unknown, questions: Record<string, Question>): Answer | undefined => {
    if (key === "r") return { noul: 0.05 };            // the save action is asked, the demo user allows
    if (key === "act") {
      // the criteria keys ARE element refs: a fake must answer with one of them
      // (an invented ref is a stale answer and stops the subgoal by design)
      const refs = Object.keys((questions[key]!.criteria ?? {}) as Record<string, unknown>);
      const choice = refs[0] ?? "";
      const rest = 0.1 / Math.max(1, refs.length - 1);
      return {
        choice,
        probabilities: Object.fromEntries(refs.map((r) => [r, r === choice ? 0.9 : rest])),
        confidence: 0.9,
      };
    }
    return undefined;
  });
  installLayaRuntime(scriptedRuntime(agent));
}

describe("sheet reading", () => {
  it("reads the committed camera_ips.xlsx with its four columns", async () => {
    const rows = await readXlsx(XLSX);
    expect(rows).toHaveLength(4);
    expect(Object.keys(rows[0]!)).toEqual(["序列号", "ip", "子网掩码", "网关"]);
    expect(rows[0]!.序列号).toBe("CAM-1001");
    expect(rows[2]!.序列号).toBe("PTZ-2001");
  });

  it("creates the demo sheet when the file is missing", async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "layaip-")), "ips.xlsx");
    const rows = await ensureXlsx(tmp);
    expect(fs.existsSync(tmp)).toBe(true);
    expect(rows.map((r) => r.序列号)).toEqual(DEMO_ROWS.map((r) => r.序列号));
    expect(await readXlsx(tmp)).toHaveLength(4);
  });
});

describe("plan building", () => {
  it("makes one frozen plan per device with the row as its data bag", () => {
    const row = DEMO_ROWS[2]!;
    const plan = buildPlan(String(row.序列号), row);
    expect(plan.goal).toContain("PTZ-2001");
    expect(plan.subgoals).toHaveLength(2);
    expect(plan.subgoals[0]!.start_url).toBe(PORTAL);
    expect(plan.subgoals[0]!.target_hint).toBe("a[data-test=net-PTZ-2001]");
    expect(plan.subgoals[0]!.signal).toEqual({ css_text_contains: ["[data-test=sn]", "PTZ-2001"] });
    expect(plan.subgoals[1]!.target_hint).toBe("button[data-test=net-save]");
    expect(plan.slots).toEqual({ ip: "10.0.2.21", mask: "255.255.255.0", gw: "10.0.2.1" });
    expect(new PlanningRules(8).problems(plan)).toEqual([]);
  });

  it("settings_url carries the serial so the page can echo it", () => {
    expect(settingsUrl("CAM-1001")).toContain("net_settings.html?sn=CAM-1001");
  });
});

describe("configureAll — the whole sheet through the production loop", () => {
  it("configures three devices and reports the fourth as rejected by the page", async () => {
    installScripted();
    const { results, exitCode } = await configureAll(await readXlsx(XLSX));

    expect(results.map((r) => r.status)).toEqual(["OK", "OK", "OK", "REJECTED"]);
    expect(results[0]!.sn).toBe("CAM-1001");
    expect(results[0]!.detail).toContain("已保存");
    expect(results[3]!.detail.length).toBeGreaterThan(0);   // the device page's own error text
    expect(exitCode).toBe(0);                               // demo contract: 3 OK + 1 rejected
    installLayaRuntime(null);
  }, 120_000);

  it("main() runs the same path and returns the demo exit code", async () => {
    installScripted();
    const code = await main([], {});
    expect(code).toBe(0);
    installLayaRuntime(null);
  }, 120_000);
});
