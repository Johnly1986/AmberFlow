/**
 * The README's "在代码里用" example, executed. Documentation that cannot run is
 * worse than no documentation: this test runs the SAME flow the README shows
 * (`TaskPlan` -> `runPlan` with `target_hint` + DOM signals) and fails if the API
 * or the example drifts. It also pins the trap the example had to be fixed for:
 * `mw.run(...)` does NOT read the plan's `target_hint` — the plan-level entry
 * points (`runPlan` / `runSubgoalWithRetries`) pass it for you.
 */
import { afterAll, describe, expect, it } from "vitest";
import { BrowserMiddleware, TaskPlan, runPlan } from "../src/index.ts";
import {
  installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer, type Question,
} from "../src/model.ts";

const REPO = new URL("..", import.meta.url).pathname;
const base = `file://${REPO}testpages`;

afterAll(() => installLayaRuntime(null));

describe("README example", () => {
  it("runs the two-subgoal plan to completion through runPlan", async () => {
    installLayaRuntime(scriptedRuntime(scriptedAgent((key, _s, qs): Answer | undefined => {
      if (key === "r") return { noul: 0.05 };
      if (key === "act") {
        const refs = Object.keys((qs[key]!.criteria ?? {}) as Record<string, unknown>);
        return { choice: refs[0] ?? "", probabilities: {}, confidence: 0.9 };
      }
      if (key === "d") return { noul: 0.0 };
      return undefined;
    })));

    const plan = new TaskPlan(
      "在示例商店把无线鼠标加入购物车并打开购物车页",
      [
        {
          desc: "把 Wireless Mouse X200 加入购物车",
          signal: { css_text_equals: ["[data-test=cart-count]", "1"] },
          start_url: `${base}/product.html`,
          target_hint: "[data-test=add-to-cart]",
        },
        {
          desc: "打开购物车页",
          signal: { url_contains: "cart.html" },
          start_url: `${base}/product.html`,
          target_hint: "[data-test=cart-link]",
        },
      ],
      "/tmp/readme-example-plan.json",
      {},
    );

    const mw = new BrowserMiddleware({ confirmFn: () => true });
    const rep = await runPlan(mw as never, plan, { startUrl: plan.subgoals[0]!.start_url! });

    expect(rep.completed).toBe("2/2");
    expect(rep.traces).toHaveLength(2);
    // both steps were resolved by the plan's own hint, i.e. zero model picks
    expect(rep.traces.map((t) => t.method)).toEqual(["rule:match", "rule:match"]);
    installLayaRuntime(null);
  }, 120_000);
});
