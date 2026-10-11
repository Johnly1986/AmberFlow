/**
 * Signal induction — "teach the flow by doing the step once".
 *
 * The signal language is deliberately hand-authorable (`css_text_equals ["[data-test=cart-count]", "1"]`),
 * but a human cannot be expected to predict a page's post-state DOM, and an LLM
 * planner gets it wrong on real sites (measured: both wikipedia cases needed two
 * tries before the hint/signal pair matched the live DOM). So instead of asking
 * for the signal, the flow WATCHES the transition and compiles one.
 *
 * The accuracy argument, and the whole reason this does not weaken the design:
 * the output is still a static predicate over the SAME five DOM operators (plus
 * `all_of`/`any_of`/`not`), and a candidate is only offered when it is
 * **false in the captured pre-state and true in the post-state**. Nothing here is
 * model-inferred, and nothing is adopted on faith:
 *
 *   1. DISCRIMINATING — false before, true after (proves it captures the effect,
 *      not a page constant);
 *   2. STABLE HANDLE — a `data-test`/`id`/`name`/`near` identity, never an
 *      `:nth-child`/class-hash path, and never a volatile literal (ids, dates,
 *      prices, UUIDs, hex tokens);
 *   3. REPRODUCIBLE (caller's job, `--replays`) — the same predicate must hold on
 *      a second, independent run before it is adopted without review.
 *
 * When nothing survives (1)+(2) the honest answer is NOT a looser signal, it is a
 * `{manual: true}` step: the human attests completion and the captured transition
 * is exactly what induction consumes to automate the step next time.
 */
import { evalSignalOnState, matchSelector, type SignalSpec, type StateView } from "./signals.ts";
import { urlOf } from "./extraction.ts";

export type { SignalSpec, StateView };

export interface InducedCandidate {
  signal: SignalSpec;
  kind: "url" | "text_equals" | "value_equals" | "all_of" | "text_contains" | "exists" | "gone";
  /** 3 = data-test/id handle, 2 = name/near, 1 = text-derived, 0 = url-only. */
  stability: number;
  why: string;
}

export interface InductionResult {
  verdict: "discriminating" | "no-signal";
  /** Ranked, best first. `candidates[0]` is the recommendation. */
  candidates: InducedCandidate[];
  /** Human-readable description of the observed transition. */
  effect: string[];
  rejected: Array<{ signal: SignalSpec; reason: string }>;
}

type Pool = StateView["elems"];
type El = Pool[string];

const KINDS: InducedCandidate["kind"][] = [
  "url", "text_equals", "value_equals", "all_of", "text_contains", "exists", "gone",
];
const KIND_RANK: Record<InducedCandidate["kind"], number> =
  Object.fromEntries(KINDS.map((k, i) => [k, i])) as Record<InducedCandidate["kind"], number>;

/** Identity of an element across two states (positional refs are useless for this). */
function identity(e: El): string {
  // The TAG is part of the identity: two nodes can share a `data-test` (a link and
  // its sibling button), and collapsing them hid a real appearance — the selector
  // then is not unique, which is exactly the case induction must refuse rather
  // than paper over with a non-discriminating predicate.
  const tag = String(e.tag ?? "").toLowerCase();
  const dt = String(e.data_test ?? "");
  if (dt) return `t:${dt}|${tag}`;
  const id = String(e.id ?? "");
  if (id) return `i:${id}|${tag}`;
  const nm = String(e.name ?? "");
  if (nm) return `n:${nm}|${tag}`;
  return `x:${tag}|${String(e.near ?? "").slice(0, 40)}|${String(e.label ?? "").slice(0, 40)}`;
}

/** Volatile literals must never become signal arguments: they differ every run. */
export function isVolatile(text: string): boolean {
  const s = String(text ?? "");
  if (!s.trim()) return true;
  if (/\d{4,}/.test(s)) return true;                       // counts, years, prices, ids
  if (/[0-9a-f]{8,}/i.test(s)) return true;                // uuid / hash / token
  if (/\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(s)) return true;    // dates
  if (/\d{1,2}:\d{2}/.test(s)) return true;                       // clock times
  if (/([a-z])\1{4,}/i.test(s)) return true;               // lorem-ish filler
  return false;
}

/** The longest stable token of a text — what `css_text_contains` should look for. */
export function stableToken(text: string): string | null {
  const parts = String(text ?? "").split(/[\s|·•,，。/、:：()（）\[\]【】—–-]+/).filter(Boolean);
  const ok = parts.filter((p) => p.length >= 3 && !isVolatile(p));
  if (!ok.length) return null;
  return ok.sort((a, b) => b.length - a.length)[0]!;
}

/**
 * A selector for an element, ONLY when the element has a stable identity.
 * Returns null rather than inventing `:nth-child` paths: a positional selector
 * silently binds to the wrong node on the next load.
 */
export function selectorFor(e: El): { sel: string; stability: number } | null {
  const dt = String(e.data_test ?? "").trim();
  if (dt && !isVolatile(dt)) return { sel: `[data-test=${dt}]`, stability: 3 };
  const id = String(e.id ?? "").trim();
  if (id && !isVolatile(id)) return { sel: `#${id}`, stability: 3 };
  const nm = String(e.name ?? "").trim();
  if (nm && !isVolatile(nm)) return { sel: `${e.tag}[name=${nm}]`, stability: 2 };
  const near = String(e.near ?? "").trim();
  const tok = stableToken(near);
  if (tok) return { sel: `${e.tag}[near~${tok}]`, stability: 2 };
  return null;
}

export interface StateDiff {
  urlChanged: boolean;
  appeared: El[];
  changed: Array<{ before: El; after: El }>;
  gone: El[];
}

export function diffStates(before: StateView, after: StateView): StateDiff {
  const index = (v: StateView): Map<string, El> => {
    const m = new Map<string, El>();
    for (const e of Object.values(v.elems)) if (!m.has(identity(e))) m.set(identity(e), e);
    return m;
  };
  const b = index(before);
  const a = index(after);
  const appeared: El[] = [];
  const changed: Array<{ before: El; after: El }> = [];
  const gone: El[] = [];
  for (const [k, e] of a) {
    const prev = b.get(k);
    if (!prev) { appeared.push(e); continue; }
    const moved = String(prev.label ?? "") !== String(e.label ?? "")
      || String(prev.value ?? "") !== String(e.value ?? "")
      || String(prev.href ?? "") !== String(e.href ?? "");
    if (moved) changed.push({ before: prev, after: e });
  }
  for (const [k, e] of b) if (!a.has(k)) gone.push(e);
  return { urlChanged: before.url !== after.url, appeared, changed, gone };
}

function kindOf(signal: SignalSpec): InducedCandidate["kind"] {
  if ("url_contains" in signal) return "url";
  if ("all_of" in signal) return "all_of";
  if ("not" in signal) return "gone";
  if ("css_text_equals" in signal) return "text_equals";
  if ("css_value_equals" in signal) return "value_equals";
  if ("css_text_contains" in signal) return "text_contains";
  return "exists";
}

/** Candidates a stable-handle element can carry, strongest literal first. */
function candidatesForEl(e: El, selector: { sel: string; stability: number }, effect: string): InducedCandidate[] {
  const out: InducedCandidate[] = [];
  const label = String(e.label ?? "").trim();
  const value = e.value === undefined || e.value === null ? "" : String(e.value).trim();
  if (value && !isVolatile(value)) {
    out.push({
      signal: { css_value_equals: [selector.sel, value] }, kind: "value_equals",
      stability: selector.stability, why: `${effect}: value → "${value}"`,
    });
  }
  if (label && label.length <= 60 && !isVolatile(label)) {
    out.push({
      signal: { css_text_equals: [selector.sel, label] }, kind: "text_equals",
      stability: selector.stability, why: `${effect}: text → "${label}"`,
    });
  }
  const tok = stableToken(label);
  if (tok && tok !== label) {
    out.push({
      signal: { css_text_contains: [selector.sel, tok] }, kind: "text_contains",
      stability: Math.max(1, selector.stability - 1),
      why: `${effect}: text contains "${tok}" (full text volatile)`,
    });
  }
  out.push({
    signal: { css_exists: [selector.sel] }, kind: "exists",
    stability: selector.stability, why: `${effect}: ${selector.sel} present`,
  });
  return out;
}

/** Navigation evidence: the most specific stable fragment of the new URL. */
function urlCandidates(before: StateView, after: StateView): InducedCandidate[] {
  const out: InducedCandidate[] = [];
  const path = after.url.replace(/^[a-z]+:\/\/[^/]+/i, "").split(/[?#]/)[0]!;
  const segs = path.split("/").filter(Boolean).filter((s) => !isVolatile(s));
  const frags = new Set<string>();
  for (let i = Math.max(0, segs.length - 3); i < segs.length; i++) {
    frags.add("/" + segs.slice(i).join("/"));
  }
  for (const f of [...frags].sort((a, b) => b.length - a.length)) {
    if (before.url.includes(f)) continue;                  // must be false before
    out.push({
      signal: { url_contains: f }, kind: "url", stability: 0,
      why: `URL → ${f}`,
    });
  }
  return out;
}

/**
 * Induce signals for an observed transition. Pure: no browser, no model.
 * Returns `verdict: "no-signal"` when nothing discriminates — the caller then
 * declares the step `{manual: true}` instead of weakening the predicate.
 */
export function induceSignals(
  before: StateView, after: StateView, opts: { max?: number; allOf?: boolean } = {},
): InductionResult {
  const { max = 5, allOf = true } = opts;
  const diff = diffStates(before, after);
  const effect: string[] = [];
  if (diff.urlChanged) effect.push(`URL ${before.url} -> ${after.url}`);
  for (const e of diff.appeared) effect.push(`appeared: ${selectorFor(e)?.sel ?? identity(e)}`);
  for (const c of diff.changed) {
    effect.push(`changed: ${selectorFor(c.after)?.sel ?? identity(c.after)} `
      + `"${String(c.before.label ?? c.before.value ?? "")}" -> "${String(c.after.label ?? c.after.value ?? "")}"`);
  }
  for (const e of diff.gone) effect.push(`gone: ${selectorFor(e)?.sel ?? identity(e)}`);

  const raw: InducedCandidate[] = [];
  if (diff.urlChanged) raw.push(...urlCandidates(before, after));
  for (const e of diff.appeared) {
    const sel = selectorFor(e);
    if (sel) raw.push(...candidatesForEl(e, sel, "appeared"));
  }
  for (const c of diff.changed) {
    const sel = selectorFor(c.after);
    if (sel) raw.push(...candidatesForEl(c.after, sel, "changed"));
  }
  for (const e of diff.gone) {
    const sel = selectorFor(e);
    if (sel) {
      raw.push({
        signal: { not: { css_exists: [sel.sel] } }, kind: "gone",
        stability: sel.stability, why: `gone: ${sel.sel} absent`,
      });
    }
  }
  // Composition: two INDEPENDENT discriminating facts are stronger than either
  // alone (spinner gone AND result appeared), and `all_of` costs one extra check.
  const independent = new Map<string, InducedCandidate>();
  for (const c of raw) {
    const sel = JSON.stringify(c.signal);
    if (!independent.has(sel)) independent.set(sel, c);
  }
  const discriminating: InducedCandidate[] = [];
  const rejected: InductionResult["rejected"] = [];
  for (const c of independent.values()) {
    const b = evalSignalOnState(c.signal, before);
    const a = evalSignalOnState(c.signal, after);
    if (b === null || a === null) { rejected.push({ signal: c.signal, reason: "selector not decidable offline" }); continue; }
    if (b !== false || a !== true) {
      rejected.push({ signal: c.signal, reason: `not discriminating (before=${b}, after=${a})` });
      continue;
    }
    discriminating.push(c);
  }
  const parts = discriminating.filter((c) => c.kind !== "all_of");
  if (allOf && parts.length >= 2) {
    const picks = [parts[0]!, parts.find((p) => p.kind !== parts[0]!.kind) ?? parts[1]!];
    const both: SignalSpec = { all_of: picks.map((p) => p.signal) };
    if (evalSignalOnState(both, before) === false && evalSignalOnState(both, after) === true) {
      discriminating.push({
        signal: both, kind: "all_of",
        stability: Math.max(...picks.map((p) => p.stability)),
        why: picks.map((p) => p.why).join(" AND "),
      });
    }
  }

  discriminating.sort((x, y) =>
    (KIND_RANK[x.kind] - KIND_RANK[y.kind]) || (y.stability - x.stability)
    || JSON.stringify(x.signal).length - JSON.stringify(y.signal).length);
  return {
    verdict: discriminating.length ? "discriminating" : "no-signal",
    candidates: discriminating.slice(0, max),
    effect,
    rejected,
  };
}

/**
 * Replay gate: the SAME predicate must be false on every pre-state and true on
 * every post-state of N independent runs before a signal is adopted unreviewed.
 */
export function signalReproducible(signal: SignalSpec, runs: Array<[StateView, StateView]>): boolean {
  if (!runs.length) return false;
  return runs.every(([b, a]) => evalSignalOnState(signal, b) === false && evalSignalOnState(signal, a) === true);
}

export { matchSelector };

/* ------------------------------------------------------------------ capture */

/**
 * Signal-bearing NON-interactive nodes: badges, counters, toasts, status lines.
 *
 * The executor's element pool holds what can be ACTED ON; completion signals very
 * often live one node away from the action (the fixture's own step writes
 * `css_text_equals ["[data-test=cart-count]", "1"]` on a `<span>` inside a link).
 * Induction — and any offline validation of a hand-written signal — therefore
 * captures a second, bounded witness pass. Container-ish nodes are excluded by
 * the text-length cap so `[id]` on a big `<div>` cannot flood the pool.
 */
export const WITNESS_SEL =
  "[data-test], [id], [role=status], [role=alert], [aria-live], output, progress";

const WITNESS_JS = String.raw`(arg) => {
  const out = [];
  const nodes = [...document.querySelectorAll(arg.sel)];
  for (const e of nodes) {
    if (out.length >= arg.max) break;
    const text = (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > 160) continue;                       // a container, not a status node
    const t = (e.getAttribute('type') || '').toLowerCase();
    const raw = (e.value !== undefined && e.value !== null) ? String(e.value) : '';
    // SECRET REDACTION (P0-3): a witness node CAN be a credential field (data-test
    // on an input is routine), and an induced css_value_equals candidate would write
    // the typed value into a pack file. Mask secret-shaped fields by length so nothing
    // sensitive is ever proposed as a completion value.
    const value = (t === 'password' || t === 'file' || t === 'hidden') ? '*'.repeat(raw.length) : raw;
    if (!text && !value) continue;
    out.push({
      tag: e.tagName.toLowerCase(),
      label: text || value,
      value,
      data_test: e.getAttribute('data-test') || '',
      id: e.id || '',
      name: e.getAttribute('name') || '',
      href: e.getAttribute('href') || '',
    });
  }
  return out;
}`;

/** One captured page state = interactive elements + witness nodes. */
export async function captureStateView(
  page: { evaluate?(fn: unknown, arg?: unknown): Promise<unknown> },
  opts: { maxWitness?: number; interactive?: Pool } = {},
): Promise<StateView> {
  const { maxWitness = 150, interactive } = opts;
  const elems: Pool = { ...(interactive ?? {}) };
  const start = Object.keys(elems).length;
  const js = WITNESS_FN;
  const found = (await page.evaluate!(js, { sel: WITNESS_SEL, max: maxWitness })) as Array<Record<string, unknown>>;
  found.forEach((e, i) => {
    const key = `w${i}`;
    // never shadow an interactive element that already owns the same identity
    const dup = Object.values(elems).some((x) =>
      String(x.data_test ?? "") === String(e.data_test) && String(x.id ?? "") === String(e.id ?? ""));
    if (dup) return;
    elems[key] = { ...(e as El), scan: start + i + 1000 };
  });
  return { url: urlOf(page as never), elems };
}

/** `evaluate` with a real function: a string body is not reliably called (see PORTING.md). */
const WITNESS_FN = new Function("arg", `return (${WITNESS_JS})(arg);`) as (arg: unknown) => unknown;
