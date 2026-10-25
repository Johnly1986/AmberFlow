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
    // Composition. Each leaf is still a DOM fact, so a composed signal cannot be
    // more permissive than its parts: `all_of` adds discrimination, `any_of` only
    // accepts alternatives a human verified one by one, `not` expresses "the
    // spinner is gone" without inventing a positive claim.
    if ("all_of" in spec) {
      for (const part of spec.all_of as SignalSpec[]) {
        if (!(await checkSignal(page, part))) return false;
      }
      return true;
    }
    if ("any_of" in spec) {
      for (const part of spec.any_of as SignalSpec[]) {
        if (await checkSignal(page, part)) return true;
      }
      return false;
    }
    if ("not" in spec) return !(await checkSignal(page, spec.not as SignalSpec));
    // A human attestation is not a DOM fact: it can never be verified here, so a
    // `manual` signal is false for the automated loop and the executor asks the
    // human explicitly (see RunOptions.manualGoal). With no human, the step blocks.
    if ("manual" in spec) return false;
  } catch {
    return false;
  }
  throw new Error(`unknown signal spec: ${JSON.stringify(spec)}`);
}

/**
 * Evaluate a signal OFFLINE, against a captured page view.
 *
 * The live `checkSignal` needs a browser; signal INDUCTION needs to test hundreds
 * of candidate predicates against a recorded before/after pair, so the same
 * semantics are available over the extracted element pool. Returns `null` when the
 * selector cannot be decided from the pool (classes, `:nth-child`, shadow paths):
 * induction treats that as "needs live verification" instead of guessing.
 */
export function evalSignalOnState(spec: SignalSpec, view: StateView): boolean | null {
  const one = (s: SignalSpec): boolean | null => evalSignalOnState(s, view);
  if ("all_of" in spec) return andAll((spec.all_of as SignalSpec[]).map(one));
  if ("any_of" in spec) return orAny((spec.any_of as SignalSpec[]).map(one));
  if ("not" in spec) {
    const v = one(spec.not as SignalSpec);
    return v === null ? null : !v;
  }
  if ("manual" in spec) return null;                       // human attestation: not decidable here
  if ("url_contains" in spec) return view.url.includes(String(arg(spec.url_contains)));
  if ("css_exists" in spec) {
    const hits = matchSelector(view.elems, String(arg(spec.css_exists)));
    return hits === null ? null : hits.length > 0;
  }
  const textOps: Array<[string, (got: string, want: string) => boolean]> = [
    ["css_text_contains", (g, w) => g.includes(w)],
    ["css_text_equals", (g, w) => g.trim() === w],
    ["css_value_equals", (g, w) => g === w],
  ];
  for (const [op, cmp] of textOps) {
    if (!(op in spec)) continue;
    const pair = (Array.isArray(spec[op]) ? (spec[op] as unknown[]) : [spec[op]]).map(arg);
    const hits = matchSelector(view.elems, String(pair[0]));
    if (hits === null) return null;                        // selector is not pool-expressible
    if (!hits.length) return false;
    const el = hits[0]!;
    const got = op === "css_value_equals"
      ? String(el.value ?? el.label ?? "")
      : String(el.label ?? "");
    return cmp(got, String(pair[1]));
  }
  return null;                                             // unknown op: undecidable offline
}

function andAll(vs: Array<boolean | null>): boolean | null {
  if (vs.some((v) => v === false)) return false;
  return vs.some((v) => v === null) ? null : true;
}

function orAny(vs: Array<boolean | null>): boolean | null {
  if (vs.some((v) => v === true)) return true;
  return vs.some((v) => v === null) ? null : false;
}

/** A captured page state: enough to decide pool-expressible signals offline. */
export interface StateView {
  url: string;
  elems: Record<string, { tag: string; label?: string; value?: unknown;
    data_test?: string; name?: string; id?: string; input_type?: string;
    href?: string; near?: string; scan?: number; [k: string]: unknown }>;
}

const ATTR_ALIAS: Record<string, string> = {
  test: "data_test", "data-test": "data_test", type: "input_type",
};

/**
 * Match the SUBSET of CSS that the element pool can express: `#id`, `tag`,
 * `[attr=value]`, `[attr~substr]`, `tag[attr=v]`, comma lists, and `[data-test=x]`.
 * Anything else (classes, `:nth-child`, descendant combinators) returns null —
 * induction must not pretend it can evaluate what the offline view cannot see.
 */
export function matchSelector(elems: StateView["elems"], selector: string): StateView["elems"][string][] | null {
  const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  // Pool-expressible only: `/^tag?(\[attr[=~]value\])?$/`. Classes, pseudos,
  // descendant/child combinators and `*` are NOT decidable from the pool, so the
  // caller is told `null` instead of getting a confident wrong answer.
  const PART = /^([a-z0-9]*)(?:#([^\[\]]+))?(?:\[([^\]=~]+)([=~])([^\]]*)\])?$/i;
  const ordered = Object.entries(elems).sort((a, b) => Number(a[1].scan ?? 0) - Number(b[1].scan ?? 0));
  const out: StateView["elems"][string][] = [];
  for (const part of parts) {
    const m = PART.exec(part);
    if (!m) return null;
    const [, tag, id, rawKey, op, rawVal] = m;
    if (!tag && !rawKey && !id) return null;
    const key = rawKey ? (ATTR_ALIAS[rawKey.toLowerCase()] ?? rawKey.toLowerCase()) : "";
    const val = (rawVal ?? "").replace(/^['"]|['"]$/g, "").toLowerCase();
    for (const [, e] of ordered) {
      if (tag && String(e.tag).toLowerCase() !== tag.toLowerCase()) continue;
      if (id && String(e.id ?? "") !== id) continue;
      if (key) {
        const got = String((e as Record<string, unknown>)[key] ?? "").toLowerCase();
        if (op === "=" && got !== val) continue;
        if (op === "~" && !got.includes(val)) continue;
      }
      out.push(e);
    }
  }
  return out;
}

export const SIGNAL_OPS: Readonly<Record<string, number>> = {
  // composition (leaves stay DOM facts, so composing cannot weaken them)
  all_of: 1,
  any_of: 1,
  not: 1,
  // a human attestation: never verifiable from the DOM, so it blocks without a human
  manual: 0,
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

/* ------------------------------------------------------------------ 语法校验 */

/**
 * 一个**观察面**的语法描述：算子表 + 报错措辞。
 *
 * 语法只有一份（下面的 `validateSignalSpec`）；DOM 面与进程面的差别**只有**叶子算子表，
 * 组合算子（`all_of`/`any_of`/`not`）与递归/路径/arity 规则必须同构——否则"同一套语言"
 * 只是口号（两套校验器漂移过一次：`when` 漏校验，见 `plan.ts` 的注释）。
 */
export interface SignalGrammar {
  /** 算子 → 参数个数；**0 = 无参叶子**（DOM 的 `manual`、进程面的 `exit_ok`），值不参与校验。 */
  readonly ops: Readonly<Record<string, number>>;
  /** 报错里的面名：`signal` / `tool signal`（保留既有消息措辞，测试按原文断言）。 */
  readonly label: string;
  /** 未知算子是否附上已知算子表（进程面是给人配 CLI 的，附上更好；DOM 面保持原文）。 */
  readonly listKnown?: boolean;
}

/** 浏览器/DOM 观察面的语法（`signal` 与 `when` 共用）。 */
export const DOM_SIGNAL_GRAMMAR: SignalGrammar = { ops: SIGNAL_OPS, label: "signal", listKnown: true };

/**
 * **唯一**的信号语法走查器。返回 problem 字符串（与 `PlanningRules.problems` 同款口径：
 * 错误是数据，由调用方汇总），不抛、不依赖浏览器。
 *
 * - 组合算子递归校验（`all_of` 空列表、`not` 不是对象、嵌套坏算子都要在**加载期**红）；
 * - 无参叶子（arity 0）只看键、不看值；
 * - `allowEmpty`：DOM 面把"空信号"的措辞放在调用方（`missing done-signal` /
 *   `must be a non-empty signal`），进程面则要求"empty signal"——两种都必须保留，所以做成选项。
 */
export function validateSignalSpec(
  spec: unknown,
  where: string,
  grammar: SignalGrammar = DOM_SIGNAL_GRAMMAR,
  opts: { allowEmpty?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      problems.push(`${at}: signal must be an object`);
      return;
    }
    const entries = Object.entries(node as Record<string, unknown>);
    if (!entries.length && !opts.allowEmpty) problems.push(`${at}: empty signal`);
    for (const [op, args] of entries) {
      if (!(op in grammar.ops)) {
        const known = grammar.listKnown ? ` (known: ${Object.keys(grammar.ops).join(", ")})` : "";
        problems.push(`${at}: unknown ${grammar.label} op '${op}'${known}`);
        continue;
      }
      if (op === "all_of" || op === "any_of") {
        if (!Array.isArray(args) || args.length === 0) {
          problems.push(`${at}: ${op} needs a non-empty list of signals`);
          continue;
        }
        args.forEach((child, i) => walk(child, `${at}.${op}[${i}]`));
        continue;
      }
      if (op === "not") {
        if (typeof args !== "object" || args === null || Array.isArray(args)) {
          problems.push(`${at}: not needs one signal`);
          continue;
        }
        walk(args, `${at}.not`);
        continue;
      }
      const arity = grammar.ops[op]!;
      if (arity === 0) continue;
      if (signalArgs(args).length !== arity) {
        problems.push(`${at}: ${op} needs ${arity} argument(s)`);
      }
    }
  };
  walk(spec, where);
  return problems;
}
