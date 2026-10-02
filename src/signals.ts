/**
 * The verifiable-signal language, in ONE place.
 *
 * `checkSignal` answers two different questions with the same five operators:
 * "is this subgoal DONE?" (completion) and "does this subgoal APPLY?" (a
 * precondition / `when` guard). Layering mirrors the Python module:
 * signals -> extraction (only); planner and executor both import it.
 *
 * Port note: the Python implementation is synchronous because Playwright's sync
 * API is; the port is ASYNC (browser I/O in Node). Callers await it either way.
 */
import { firstOf, locatorAnyFrame, urlOf, type PageLike } from "./extraction.ts";

export type SignalSpec = Record<string, unknown>;

/** Values may be scalars or 1/2-element lists (the CLI parses them as lists). */
function arg(v: unknown): unknown {
  return Array.isArray(v) && v.length === 1 ? v[0] : v;
}

/**
 * Tiny verifiable-signal language for subgoal completion.
 *
 * `css_text_contains` is the workhorse on REAL pages: exact equality breaks the
 * moment a heading carries a badge or an edit link (zh.wikipedia's <h1> reads
 * "艾伦·图灵编辑", so `css_text_equals` can never fire there), while contains
 * survives cosmetic chrome. It reads the first match rather than insisting on a
 * single one: css selectors on production pages legitimately match many nodes.
 */
export async function checkSignal(page: PageLike, spec: SignalSpec): Promise<boolean> {
  try {
    if ("url_contains" in spec) return urlOf(page).includes(String(arg(spec.url_contains)));
    // CSS ops look in the main frame AND same-origin children: a done-signal
    // frequently lives inside an iframe (embedded form field, status banner).
    if ("css_exists" in spec) return (await locatorAnyFrame(page, String(arg(spec.css_exists)))) !== null;
    if ("css_text_contains" in spec) {
      const [sel, want] = (spec.css_text_contains as unknown[]).map(arg);
      const loc = await locatorAnyFrame(page, String(sel));
      return loc !== null && String(await firstOf(loc).innerText({ timeout: 2000 })).includes(String(want));
    }
    if ("css_text_equals" in spec) {
      const [sel, want] = (spec.css_text_equals as unknown[]).map(arg);
      const loc = await locatorAnyFrame(page, String(sel));
      return loc !== null && String(await firstOf(loc).innerText({ timeout: 2000 })).trim() === String(want);
    }
    if ("css_value_equals" in spec) {
      const [sel, want] = (spec.css_value_equals as unknown[]).map(arg);
      const loc = await locatorAnyFrame(page, String(sel));
      return loc !== null && String(await firstOf(loc).inputValue({ timeout: 2000 })) === String(want);
    }
  } catch {
    return false;
  }
  throw new Error(`unknown signal spec: ${JSON.stringify(spec)}`);
}

export const SIGNAL_OPS: Readonly<Record<string, number>> = {
  url_contains: 1,
  css_exists: 1,
  css_text_equals: 2,
  css_text_contains: 2,
  css_value_equals: 2,
};

/**
 * Normalise a signal value to its argument list.
 *
 * Runtime values may be a scalar or a 1/2-element list: `checkSignal` unwraps a
 * single-element list, plan_cli parses `op=value` into a list, and
 * bench/cases.json — the frozen-plan format — writes bare scalars. Validation
 * must accept the same shapes the executor accepts (and must not call `.length`
 * on a number).
 */
export function signalArgs(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}
