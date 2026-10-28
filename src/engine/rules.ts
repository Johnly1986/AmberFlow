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
import { firstIfSame, type Elem, type ElemPool } from "./extraction.ts";
import { parseHint, poolAttr } from "./hint.ts";

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

/**
 * target_hint grammar (frozen-plan disambiguation):
 *     id           #searchInput
 *     css-ish      input[type=submit] / [data-test=x] / a[href=/news]
 *     tag class    button | link | input | textarea | select
 *     bare token   login-btn | 标题 | ...
 * attr selectors match the *extracted attribute* of each candidate; a `tag[...]`
 * prefix also constrains the tag.
 */
/**
 * The tiered candidate set a `target_hint` resolves to, WITHOUT the ambiguity
 * collapse. `refs` is the strongest non-empty tier's hit list (the exact set
 * `hintMatch` would feed `firstIfSame`); `tier` is which rung won (grammar-local);
 * `decided` is a candidate `hintMatch` already settles to on its own (the
 * submit-preference on a bare `input`/`button` tag). `hintMatch` is
 * `decided ?? firstIfSame(refs)` — so the two views are the SAME single
 * implementation and can never drift into a second hint grammar (both the
 * engine review and this guide charge for that mistake).
 *
 * Why this exists (P1 tieredHint): in-tier
 * ambiguity used to collapse to `null`, degrading "pick one of these few" back
 * into "pick one of the whole pool" — measured 17 candidates → 0.23 BLOCKED,
 * 0.29 coin-flip. `hintCandidates` hands the DECIDER the narrowed subset.
 */
export interface HintCandidates {
  refs: string[];
  /** Tier index that produced these refs (see the branch comments). */
  tier: number;
  /** A ref `hintMatch` already resolves unambiguously (submit-preference); else null. */
  decided: string | null;
}

/** The 6 hint grammars, single-parsed; `sink` (if given) records the candidate set. */
function hintMatchImpl(hint: string, elems: ElemPool, sink?: HintCandidates | null): string | null {
  const parsed = parseHint(hint);
  const entries = Object.entries(elems);
  /** Record the strongest tier's refs, then resolve exactly as before. */
  const emit = (refs: string[], tier: number): string | null => {
    if (sink) { sink.refs = refs; sink.tier = tier; sink.decided = null; }
    return firstIfSame(new Set(refs), elems);
  };

  if (parsed.kind === "id") {
    return emit(entries.filter(([, e]) => String(e.id ?? "").toLowerCase() === parsed.value).map(([r]) => r), 0);
  }
  if (parsed.kind === "attrSubstr") {
    const pre = parsed.tag;
    const k = poolAttr(parsed.attr);
    const v = parsed.value;
    const cf = (x: unknown): string => String(x ?? "").toLowerCase();
    const hitList = entries.filter(([, e]) => (!pre || e.tag === pre) && cf(e[k]).includes(v));
    // TIERED resolution, measured on live pages. A substring hint that names a
    // page slug also matches every RELATED page: on today's en.wikipedia search
    // results `a[href~Alan_Turing]` hits 17 links (Alan_Turing, Alan_Turing_law,
    // Alan_Turing_Institute, Legacy_of_Alan_Turing, ...). Same-signature
    // ambiguity then gives up and hands the step to laya — measured: confidence
    // 0.23 < 0.25 floor -> the subgoal BLOCKED. Prefer, in order:
    //   1. exact attribute equality                (`href` == "Alan_Turing")
    //   2. a whole LAST PATH SEGMENT               (`.../wiki/Alan_Turing`)
    //   3. the old behaviour over all substring hits (still None when the
    //      candidates are genuinely different — the bbc.com two-identical-links
    //      rule is unchanged).
    const exact = hitList.filter(([, e]) => cf(e[k]) === v);
    if (exact.length) return emit(exact.map(([r]) => r), 1);
    const slug = hitList.filter(([, e]) => cf(e[k]).split("/").pop() === v);
    if (slug.length) return emit(slug.map(([r]) => r), 2);
    return emit(hitList.map(([r]) => r), 3);
  }
  if (parsed.kind === "nearToken") {
    // near~token: the container identity line (add_near_context) disambiguates
    // grids of identical labels — e.g. button[near~onesie] when six
    // "Add to cart" buttons share the DOM and only their product names differ.
    const refs = entries
      .filter(([, e]) => (!parsed.tag || e.tag === parsed.tag) && String(e.near ?? "").toLowerCase().includes(parsed.token))
      .map(([r]) => r);
    return emit(refs, 0);
  }
  if (parsed.kind === "attrEq") {
    const k = poolAttr(parsed.attr);
    // case-FOLDED comparison: the hint is lower-cased on entry but device ids
    // are routinely upper-case (data-test="net-CAM-1001"); a raw `==` silently
    // missed and the plan-named target fell back to laya (~0.03 conf).
    const refs = entries
      .filter(([, e]) => (!parsed.tag || e.tag === parsed.tag) && String(e[k] ?? "").toLowerCase() === parsed.value)
      .map(([r]) => r);
    return emit(refs, 0);
  }
  if (parsed.kind === "tag") {
    const h = parsed.tag;
    const want: Record<string, string[]> = {
      button: ["button"], link: ["a"], input: ["input"], textarea: ["textarea"], select: ["select"],
    };
    const hits = new Set(entries.filter(([, e]) => want[h]!.includes(e.tag)).map(([r]) => r));
    // "input"/"button" as target for a *click*: prefer submit-type widgets
    if ((h === "input" || h === "button") && hits.size > 1) {
      const submits = [...hits].filter((r) =>
        ["submit", "button"].includes(String(elems[r]!.input_type ?? "")) || elems[r]!.tag === "button");
      if (submits.length === 1) {
        if (sink) { sink.refs = submits; sink.tier = 0; sink.decided = submits[0]!; }
        return submits[0]!;
      }
    }
    return emit([...hits], 0);
  }
  // bare token: unique label/data-test word — TIERED for the same reason as
  // `attr~value`: on a live page the exact label ("艾伦·图灵") is one candidate
  // among many titles that merely CONTAIN it (the language sidebar ships ~100 of
  // them, each titled "艾伦·图灵 – 古吉拉特语" — where the token is even its own
  // WORD, so word-equality alone is not discriminating). Tiers, strongest first:
  //   0. the WHOLE label equals the hint      ("艾伦·图灵")
  //   1. a label/data-test word equals it
  //   2. a word starts with it
  //   3. a word contains it
  // Only the strongest non-empty tier is considered; genuine ambiguity inside it
  // still returns null.
  const h = parsed.token;
  const whole = new Set<string>();
  const tiers: Array<Set<string>> = [new Set(), new Set(), new Set()];
  for (const [r, e] of entries) {
    const label = String(e.label ?? "").trim().toLowerCase();
    if (label === h) whole.add(r);
    const ws = `${e.data_test ?? ""} ${e.label}`.toLowerCase().replace(/-/g, " ").split(/\s+/);
    if (ws.some((w) => w === h)) tiers[0]!.add(r);
    else if (ws.some((w) => w.startsWith(h))) tiers[1]!.add(r);
    else if (ws.some((w) => w.includes(h))) tiers[2]!.add(r);
  }
  const ladder = [whole, ...tiers];
  for (let t = 0; t < ladder.length; t++) {
    const hits = ladder[t]!;
    if (hits.size) return emit([...hits], t);
  }
  if (sink) { sink.refs = []; sink.tier = -1; sink.decided = null; }
  return null;
}

/**
 * Resolve a frozen plan's `target_hint` to a single ref (see `hintMatchImpl`).
 * This is the pool-side half of the hint grammar; `extraction.hintLookup` is the
 * DOM-side half and re-queries live elements the budget evicted. Both are driven
 * by the same tier semantics documented on `hintMatchImpl`.
 */
export function hintMatch(hint: string, elems: ElemPool): string | null {
  return hintMatchImpl(hint, elems, null);
}

/**
 * The tiered candidate set for a `target_hint` (see `HintCandidates`). Returns null
 * only when the hint matches NOTHING (an empty pool-wide miss); a hint that hits a
 * tier always yields that tier's refs — including an ambiguous tier, which is the
 * whole point: the decider gets "these k elements" instead of "null → the full pool".
 */
export function hintCandidates(hint: string, elems: ElemPool): HintCandidates | null {
  const sink: HintCandidates = { refs: [], tier: -1, decided: null };
  hintMatchImpl(hint, elems, sink);
  return sink.refs.length ? sink : null;
}

/**
 * 给一个已观察到的元素生成**可验证的**候选 hint。
 *
 * 这不是第二套 hint 语法：每个候选都交给同一个 `hintMatch` 验证，只有
 * “恰好命中该元素（不是别的元素、不是多个元素）”的才保留。Agent 的 inspect
 * 因此拿到的是可直接写进 `target_hint` 的安全候选，而不是猜出来的选择器。
 *
 * 顺序：data-test / id / name / href 精确值，最后是唯一可见文本。最多 4 条。
 */
export function suggestHints(
  elem: Elem,
  elems: ElemPool,
): string[] {
  const out: string[] = [];
  const push = (hint: string): void => {
    if (!hint || out.includes(hint)) return;
    if (hintMatch(hint, elems) !== elem.ref) return;
    const cand = hintCandidates(hint, elems);
    if (cand === null || cand.refs.length !== 1) return;
    out.push(hint);
  };
  if (elem.data_test) {
    push(`[data-test=${elem.data_test}]`);
    push(`${elem.tag}[data-test=${elem.data_test}]`);
  }
  if (elem.id) push(`#${elem.id}`);
  if (elem.name) {
    push(`[name=${elem.name}]`);
    push(`${elem.tag}[name=${elem.name}]`);
  }
  if (elem.href) {
    push(`${elem.tag}[href=${elem.href}]`);
  }
  const label = String(elem.label ?? "").trim();
  if (label.length >= 2 && label.length <= 80) push(label);
  return out.slice(0, 4);
}
