/**
 * Long-task demo — TS twin of `long_task.py`.
 *
 * The planner splits a multi-page goal into verified subgoals, the executor runs
 * each in ONE browser session, and the plan checkpoints to `.task_state.json`:
 * "add the Wireless Mouse X200 to the cart, open the cart page, and enter coupon
 * code SAVE10" — three subgoals across two pages, each with a DOM done-signal
 * (never laya's own done-judgment).
 */
import { BrowserMiddleware } from "./executor.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPlan } from "./planner.ts";
import { ScriptedPlanner } from "./planner.ts";
import { PAGES } from "./path-a.ts";
import type { MiddlewareLike } from "./planner.ts";

const uri = (f: string): string => new URL(`file://${PAGES}/${f}`).href;

export const GOAL =
  "In the Example Shop: add the Wireless Mouse X200 to the shopping cart, "
  + "then open the cart page, then enter coupon code coupon=SAVE10";

export interface LongTaskDeps {
  middleware?: MiddlewareLike & { auditor: { audit(g: string, t: unknown[], d: boolean): unknown | Promise<unknown> } };
}

export async function main(_argv: string[] = process.argv.slice(2), deps: LongTaskDeps = {}): Promise<number> {
  // Mock user: confirms ordinary navigation/fills, denies anything payment-like.
  const mockUser = (desc: string): boolean => {
    const deny = ["checkout", "pay", "purchase"].some((k) => desc.toLowerCase().includes(k));
    console.log(`    [confirm] ${deny ? "DENY" : "allow"}: ${desc}`);
    return !deny;
  };

  const mw = (deps.middleware ?? new BrowserMiddleware({ confirmFn: mockUser })) as never as
    BrowserMiddleware & { auditor: { audit(g: string, t: unknown[], d: boolean): { verdict: string; reasons: string[] } | Promise<{ verdict: string; reasons: string[] }> } };
  console.log("middleware ready\n");

  const planner = new ScriptedPlanner([
    {
      desc: "add the Wireless Mouse X200 to the shopping cart",
      signal: { css_text_equals: ["[data-test='cart-count']", "1"] },
      start_url: uri("product.html"),
    },
    {
      desc: "open the cart page",
      signal: { url_contains: "cart.html" },
      start_url: uri("product.html"),
    },
    {
      desc: "type the coupon code into the coupon field",
      signal: { css_value_equals: ["[data-test='coupon']", "SAVE10"] },
      start_url: uri("cart.html"),
    },
  ]);
  const plan = planner.makePlan(GOAL);

  console.log("=== long task ===");
  const rep = await runPlan(mw as never, plan, { startUrl: uri("product.html") });
  console.log("\ncheckpoint saved to .task_state.json");
  console.log(`plan status  : ${rep.plan.summary()}`);
  console.log(`steps taken  : ${rep.traces.length}`);
  const verdict = await mw.auditor.audit(GOAL, rep.traces, rep.completed === "3/3");
  console.log(`final audit  : ${verdict.verdict} ${JSON.stringify(verdict.reasons)}`);
  return rep.completed === "3/3" && verdict.verdict === "APPROVE" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
