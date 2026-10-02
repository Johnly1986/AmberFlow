/**
 * Decision rules: the literal mappings that run BEFORE the model.
 *
 * `navRule` (href match, gated on navigation verbs), `affordanceRule` (unique
 * data-test / label token match) and `hintMatch` (a frozen plan's target_hint:
 * `#id` / `tag[attr=value]` / `tag[attr~substr]` / `tag[near~token]` / bare
 * token) are pure functions over an element pool — no page, no model, no state.
 * The token sets and the destructive-verb list live here because they are their
 * vocabulary. First rung of the pick ladder (rule/hint -> laya -> stop).
 *
 * Ported 1:1 from `layaapp/rules.py`; the Python unit tests are the spec.
 */
import { firstIfSame, type ElemPool } from "./extraction.ts";

export const STOP_TOKENS = new Set([
  "page", "open", "click", "then", "with", "this", "that", "into", "from",
  "the", "and", "for", "now", "type", "enter", "fill", "input", "field",
]);
/** Interaction-role words: they name the widget class, never a specific element. */
export const ROLE_TOKENS = new Set([
  "button", "link", "submit", "textarea", "select", "checkbox",
  "radio", "icon", "menu", "tab", "box", "btn", "press", "hit",
]);
/** Function words that name no element at all. */
export const FILLER_TOKENS = new Set([
  "to", "the", "a", "an", "of", "on", "in", "at", "by", "is",
  "it", "its", "this", "that", "form", "page", "field", "code",
]);
export const NAV_VERBS = new Set(["open", "navigate", "visit", "goto", "switch", "return", "back"]);

export const DESTRUCTIVE_PATTERNS: readonly string[] = [
  "pay", "checkout", "purchase", "place order",
  "delete", "remove", "submit", "send", "confirm payment",
];

const words = (s: string, re: RegExp): string[] => s.match(re) ?? [];
const ASCII4 = /[a-z]{4,}/g;
const ASCII2 = /[a-z0-9]{2,}/g;
const CJK2 = /[\u4e00-\u9fff]{2,}/g;
const CJK1 = /[\u4e00-\u9fff]+/g;

export function navRule(instruction: string, elems: ElemPool): string | null {
  const toks = new Set(words(instruction.toLowerCase(), ASCII4));
  if (![...toks].some((t) => NAV_VERBS.has(t))) return null; // href rule only for navigation-style goals
  for (const t of [...toks]) if (STOP_TOKENS.has(t) || ROLE_TOKENS.has(t) || FILLER_TOKENS.has(t)) toks.delete(t);
  const hits = new Set(
    Object.entries(elems)
      .filter(([, e]) => e.href && [...toks].some((t) => (e.href as string).toLowerCase().includes(t)))
      .map(([r]) => r),
  );
  if (hits.size === 1) return [...hits][0]!;
  // Role narrowing also serves NAV: "open the login page" href-matches both the
  // nav link and the submit input's form action; only the anchor is navigable.
  const low = instruction.toLowerCase();
  const wantLink = ["link", "page", "navigate", "open", "goto"].some((r) => low.includes(r));
  if (wantLink && hits.size > 1) {
    const narrowed = [...hits].filter((r) => elems[r]!.tag === "a");
    if (narrowed.length === 1) return narrowed[0]!;
  }
  return null;
}

export function affordanceRule(
  instruction: string,
  elems: ElemPool,
  targetHint?: string | null,
): string | null {
  // A frozen plan that NAMES its target wins over label matching: the planner
  // saw the DOM snapshot and the hint costs zero model calls. When a hint
  // exists it is authoritative even if it matches nothing: the caller falls
  // through to laya rather than gambling on a token.
  if (targetHint) return hintMatch(targetHint, elems);

  const toks = new Set(words(instruction.toLowerCase(), ASCII2));
  for (const t of [...toks]) if (STOP_TOKENS.has(t) || ROLE_TOKENS.has(t) || FILLER_TOKENS.has(t)) toks.delete(t);
  const cjk = words(instruction, CJK2);
  const hits = new Set<string>();

  for (const [ref, e] of Object.entries(elems)) {
    if (e.js_events) {
      // JS-only widget: its 'js:eN' data_test is an executor handle, never
      // model-facing text; match it only by visible label.
      const labWords = e.label.toLowerCase().split(/\s+/);
      if (
        [...toks].some((t) => labWords.includes(t)) ||
        cjk.some((c) => e.label.includes(c))
      ) hits.add(ref);
      continue;
    }
    const dtWords = ((e.data_test as string) ?? "").toLowerCase().replace(/-/g, " ").split(/\s+/);
    if ([...toks].some((t) => dtWords.some((w) => t === w || (t.length >= 4 && w.startsWith(t))))) {
      hits.add(ref);
      continue;
    }
    const labWords = e.label.toLowerCase().split(/\s+/);
    // multi-word labels ("Apply coupon") are also one matchable phrase
    const labPhrases = new Set(labWords);
    for (let i = 0; i + 1 < labWords.length; i++) labPhrases.add(`${labWords[i]} ${labWords[i + 1]}`);
    if ([...toks].some((t) => labPhrases.has(t))) {
      hits.add(ref);
      continue;
    }
    // CJK: the label must be a *contiguous token* of the instruction
    // (whitespace-delimited or at either end). Substring-anywhere would let
    // "提交登记表单" hit the "提交登记" button — but it also lets "填写 标题"
    // match nothing when the writer glues 标题输入框 together.
    const raw = instruction.toLowerCase();
    const labL = e.label.toLowerCase();
    const cjkTok = words(labL, CJK1);
    if (
      cjkTok.length > 0 &&
      cjkTok.some((c) => ` ${raw} `.includes(` ${c} `) || raw.startsWith(c) || raw.endsWith(c))
    ) hits.add(ref);
  }

  if (hits.size === 1) return [...hits][0]!;
  // Ambiguous hits may still resolve on container context: an instruction token
  // that is a word of EXACTLY one candidate's near line is a literal mapping.
  if (hits.size > 1) {
    const nearWords = new Map<string, Set<string>>(
      [...hits].map((r) => [r, new Set(words(((elems[r]!.near as string) ?? "").toLowerCase(), ASCII2))]),
    );
    const narrowed = new Set(
      [...hits].filter((r) =>
        [...toks].some((t) => nearWords.get(r)!.has(t) &&
          [...hits].every((o) => o === r || !nearWords.get(o)!.has(t)))),
    );
    const cjkN = new Set(
      [...hits].filter((r) =>
        cjk.some((c) => ((elems[r]!.near as string) ?? "").includes(c) &&
          [...hits].every((o) => o === r || !((elems[o]!.near as string) ?? "").includes(c)))),
    );
    for (const cand of [narrowed, cjkN]) if (cand.size === 1) return [...cand][0]!;
  }
  // Ambiguous label hits are still decisive when the instruction names a widget
  // role: "click the Login button" may only take clickables.
  const low = instruction.toLowerCase();
  const wantButton = ["button", "btn", "press"].some((r) => low.includes(r));
  if (wantButton && hits.size > 1) {
    const narrowed = [...hits].filter((r) => ["button", "input"].includes(elems[r]!.tag));
    if (narrowed.length === 1) return narrowed[0]!;
  }
  return null;
}

const ATTR_ALIASES: Record<string, string> = {
  test: "data_test", "data-test": "data_test", type: "input_type",
};
const alias = (k: string): string => ATTR_ALIASES[k] ?? k;

/**
 * target_hint grammar (frozen-plan disambiguation):
 *     id           #searchInput
 *     css-ish      input[type=submit] / [data-test=x] / a[href=/news]
 *     tag class    button | link | input | textarea | select
 *     bare token   login-btn | 标题 | ...
 * attr selectors match the *extracted attribute* of each candidate; a `tag[...]`
 * prefix also constrains the tag.
 */
export function hintMatch(hint: string, elems: ElemPool): string | null {
  const h = hint.trim().toLowerCase();
  const entries = Object.entries(elems);

  if (h.startsWith("#")) {
    const hits = new Set(entries.filter(([, e]) => String(e.id ?? "").toLowerCase() === h.slice(1)).map(([r]) => r));
    return firstIfSame(hits, elems);
  }
  if (h.includes("[") && h.split("[", 2)[1]!.includes("~")) {
    // attr~substr: substring attribute match, e.g. a[href~travel_2]
    const [pre, restRaw] = [h.slice(0, h.indexOf("[")), h.slice(h.indexOf("[") + 1)];
    const rest = restRaw.replace(/\]$/, "");
    const tilde = rest.indexOf("~");
    const k = alias(rest.slice(0, tilde));
    const v = rest.slice(tilde + 1);
    const hits = new Set(entries
      .filter(([, e]) => (!pre || e.tag === pre) && String(e[k] ?? "").toLowerCase().includes(v))
      .map(([r]) => r));
    return firstIfSame(hits, elems);
  }
  if (h.split("[").pop()!.includes("~")) {
    // near~token: the container identity line (add_near_context) disambiguates
    // grids of identical labels — e.g. button[near~onesie] when six
    // "Add to cart" buttons share the DOM and only their product names differ.
    const pre = h.slice(0, h.indexOf("[") >= 0 ? h.indexOf("[") : 0);
    const after = h.includes("[") ? h.slice(h.indexOf("[") + 1) : h;
    const tok = after.replace(/\]$/, "").split("~").slice(-1)[0]!;
    const hits = new Set(entries
      .filter(([, e]) => (!pre || e.tag === pre) && String(e.near ?? "").toLowerCase().includes(tok))
      .map(([r]) => r));
    return firstIfSame(hits, elems);
  }
  if (h.includes("[")) {
    const pre = h.slice(0, h.indexOf("["));
    const rest = h.slice(h.indexOf("[") + 1);
    const eq = rest.indexOf("=");
    const k = alias(eq >= 0 ? rest.slice(0, eq) : rest);
    // case-FOLDED comparison: the hint is lower-cased on entry but device ids
    // are routinely upper-case (data-test="net-CAM-1001"); a raw `==` silently
    // missed and the plan-named target fell back to laya (~0.03 conf).
    const v = (eq >= 0 ? rest.slice(eq + 1) : "").replace(/\]$/, "").replace(/^['"]|['"]$/g, "");
    const hits = new Set(entries
      .filter(([, e]) => (!pre || e.tag === pre) && String(e[k] ?? "").toLowerCase() === v)
      .map(([r]) => r));
    return firstIfSame(hits, elems);
  }
  if (["button", "link", "input", "textarea", "select"].includes(h)) {
    const want: Record<string, string[]> = {
      button: ["button"], link: ["a"], input: ["input"], textarea: ["textarea"], select: ["select"],
    };
    const hits = new Set(entries.filter(([, e]) => want[h]!.includes(e.tag)).map(([r]) => r));
    // "input"/"button" as target for a *click*: prefer submit-type widgets
    if ((h === "input" || h === "button") && hits.size > 1) {
      const submits = [...hits].filter((r) =>
        ["submit", "button"].includes(String(elems[r]!.input_type ?? "")) || elems[r]!.tag === "button");
      if (submits.length === 1) return submits[0]!;
    }
    return firstIfSame(hits, elems);
  }
  // bare token: unique label/data-test word
  const hits = new Set<string>();
  for (const [r, e] of entries) {
    const ws = `${e.data_test ?? ""} ${e.label}`.toLowerCase().replace(/-/g, " ").split(/\s+/);
    if (ws.some((w) => w === h || w.startsWith(h) || w.includes(h))) hits.add(r);
  }
  return firstIfSame(hits, elems);
}
