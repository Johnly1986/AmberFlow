#!/usr/bin/env node
/**
 * Teach a step by doing it once, and get a plan-ready completion signal back.
 *
 *   node --experimental-strip-types tools/induce_signal.ts \
 *        --url testpages/product.html --click "[data-test=add-to-cart]" --replays 2
 *
 * `--url` accepts a fixture path (resolved against the repo root) or an absolute
 * URL. `--click` is optional: without it the tool just captures the page (useful
 * for validating an existing signal). With `--replays N` the same predicate must
 * hold on N independent runs before it is reported as ADOPTABLE; otherwise it is
 * reported as REVIEW (and `no-signal` means: declare the step `{manual: true}`).
 */
import path from "node:path";
import { isParseUsageError, usageErrorLine } from "../src/cli-args.ts";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import * as browserEnv from "../src/browser-env.ts";
import { extractElements, type PageLike } from "../src/extraction.ts";
import { hintMatch } from "../src/rules.ts";
import {
  captureStateView, induceSignals, signalReproducible, type StateView,
} from "../src/signal-induction.ts";
import { evalSignalOnState } from "../src/signals.ts";
import { REPO } from "../src/flow.ts";

type Page = PageLike & {
  goto(u: string, o?: unknown): Promise<void>;
  click(s: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
};

async function snapshot(page: Page): Promise<StateView> {
  return captureStateView(page as never, { interactive: await extractElements(page as never) });
}

async function runOnce(url: string, click: string | null, replays: number): Promise<{
  runs: Array<[StateView, StateView]>;
  browser: { close(): Promise<void> };
}> {
  const browser = (await browserEnv.launch({ chromium } as never, true)) as never as {
    newPage(): Promise<unknown>; close(): Promise<void>;
  };
  const page = (await browser.newPage()) as unknown as Page;
  const runs: Array<[StateView, StateView]> = [];
  for (let i = 0; i < replays; i++) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const before = await snapshot(page);
    if (click) {
      // a hint (`#id`, `[data-test=x]`, bare token…) resolved the same way the executor does
      const elems = await extractElements(page as never);
      const ref = hintMatch(click, elems);
      const target = ref ? elems[ref] : undefined;
      const sel = target?.data_test ? `[data-test=${target.data_test}]`
        : target?.id ? `#${target.id}` : click;
      await page.click(sel);
      await page.waitForTimeout(400);
    }
    runs.push([before, await snapshot(page)]);
  }
  return { runs, browser };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let values;
  // 打错的参数 → 一行点名，绝不甩 parseArgs 的堆栈（src/cli-args.ts 的体例）。
  try {
    ({ values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" }, click: { type: "string" },
      replays: { type: "string" }, json: { type: "boolean" },
    },
  }));
  } catch (err) {
    if (!isParseUsageError(err)) throw err;
    console.error(usageErrorLine(err));
    return 2;
  }
  const raw = values.url;
  if (!raw) {
    console.error("usage: induce_signal.ts --url <page|url> [--click <hint>] [--replays 2] [--json]");
    return 2;
  }
  const url = raw.includes("://") ? raw : `file://${path.resolve(REPO, raw)}`;
  const replays = Math.max(1, Number(values.replays ?? "1"));
  const { runs, browser } = await runOnce(url, values.click ?? null, replays);
  try {
    const [before, after] = runs[0]!;
    const result = induceSignals(before, after);
    const adoptable = result.candidates.filter((c) => signalReproducible(c.signal, runs));
    if (values.json) {
      console.log(JSON.stringify({
        url, effect: result.effect, verdict: result.verdict,
        recommended: adoptable[0]?.signal ?? null,
        candidates: adoptable.map((c) => ({ signal: c.signal, kind: c.kind, stability: c.stability, why: c.why })),
        rejected: result.rejected,
      }, null, 1));
      return result.verdict === "discriminating" ? 0 : 1;
    }
    console.log(`page   : ${url}${values.click ? `   click: ${values.click}` : ""}   runs: ${replays}`);
    console.log(`effect : ${result.effect.length ? result.effect.join(" | ") : "(no observable transition)"}`);
    if (result.verdict === "no-signal") {
      console.log("verdict: NO SIGNAL — nothing discriminates the two states.");
      console.log("         declare the step `\"signal\": {\"manual\": true}`: the human attests it");
      console.log("         (the recorded transition is what a later induction run consumes).");
      return 1;
    }
    console.log(`verdict: ${adoptable.length ? "ADOPTABLE" : "REVIEW"}`
      + ` (${adoptable.length}/${result.candidates.length} survive ${replays} run(s))`);
    adoptable.slice(0, 3).forEach((c, i) => {
      console.log(`  ${i === 0 ? "→" : " "} ${JSON.stringify(c.signal)}`);
      console.log(`      ${c.kind} / stability ${c.stability} — ${c.why}`);
    });
    if (!adoptable.length) {
      console.log("  (nothing reproduced across runs — keep it manual, or raise --replays after a stable run)");
    }
    // sanity: the recommendation is discriminating on every captured pair
    const rec = adoptable[0]?.signal;
    if (rec) {
      const ok = runs.every(([b, a]) => evalSignalOnState(rec, b) === false && evalSignalOnState(rec, a) === true);
      console.log(`check  : discriminating on all ${runs.length} captured pair(s): ${ok}`);
    }
    return 0;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
