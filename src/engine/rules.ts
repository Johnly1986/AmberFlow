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
  opts?: HintMatchOptions,
): string | null {
  // A frozen plan that NAMES its target wins over label matching: the planner
  // saw the DOM snapshot and the hint costs zero model calls. When a hint
  // exists it is authoritative even if it matches nothing: the caller falls
  // through to laya rather than gambling on a token.
  if (targetHint) return hintMatch(targetHint, elems, opts);

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

/**
 * A2：`[aria-label~x]` / `[aria-label=y]` 的**池侧别名**。
 *
 * DOM 的 aria-label 在提取期已并进 label（labelOf 优先读 aria-label），池字段模型里没有
 * 独立的 aria_label 字段——所以这类属性选择器按 `label` 匹配。提示词面的属性白名单
 * （grammar-prompt.MATCHABLE_POOL_ATTRS）与本函数同一口径，改一处必须改另一处。
 * task-10 起导出：check 面的 hint 语义 lint（declaration-scan）用它判定
 * 「attrSubstr 是否落在 label 上」——别名口径只有这一份实现，不复制第二份。
 */
export function poolFieldFor(attr: string): string {
  const k = poolAttr(attr);
  return k === "aria-label" || k === "aria_label" || k === "ariaLabel" ? "label" : k;
};

/**
 * A1：属性值匹配底座的口径（`meta.policy.attr_value_match`）。
 *
 * - `full_label`（缺省）：`aria-label` 的池字段 `label` 用 `[full_label, label]` 双底座——
 *   模型视图的 label 只有前 40 字，>40 字的属性值要靠 `full_label`（≤200）才等得上；
 * - `display`：A1 之前的行为（只比 label 前 40 字，>40 的值永不命中）。
 *
 * 只作用于池侧 hint 匹配：run 面按 policy 传，inspect/observe/session 无 policy，恒 `full_label`。
 */
export type AttrValueMatch = "full_label" | "display";

/** hint 匹配的可选口径（缺省 = A1 修复后的行为；见 `AttrValueMatch`）。 */
export interface HintMatchOptions {
  attrValueMatch?: AttrValueMatch;
  /**
   * A4：是否写 B1 弱档命中旁路（`lastHintOthersDiag`），缺省 `true`。
   *
   * `false` = `hintMatchImpl` **完全不碰**该模块态（不写、不清）——会话 `act` 落空诊断要用
   * `hintCandidates` 取候选，但那次调用**不得**污染 task-34 的 `matched_others` 回显
   * （模块态是"最后一次解析者写"，一次诊断查询就会把真正的解析记录顶掉）。
   * 缺省 true = 既有调用点逐字节不变。
   */
  diag?: boolean;
}

/**
 * T9/A1：一个属性 hint 的匹配底座（已大小写折叠的候选值列表）。
 *
 * `href` 是**双底座**属性：展示投影 `href`（旧路径型 hint 依赖它，今天逐字节不变）
 * + 原始属性 `href_full`（query/fragment/origin 都在，T9 新增）。两个值都非空才算候选、
 * 同值去重；空 href 返回 `[""]`，与 T9 之前「空串照旧参与比较」的语义一致。
 *
 * A1：`label` 同样是双底座 `[full_label, label]`——`poolFieldFor` 把 aria-label 别名成
 * `label`，而 label 是**模型视图**的前 40 字（不变量：label === full_label 前 40 字，构造点见
 * extraction/declared/observe/executor 的同名注释）；只比 label 时 >40 字的属性值永远等不上。
 * `attr_value_match:"display"` 回到 A1 之前的单字段 label。attrEq 与 attrSubstr 共用本函数，
 * 一处改两形状（只改 attrEq 会让 `[aria-label~尾串]` 仍落空）。
 * 其它属性仍是单字段底座，行为与 T9 之前逐字节一致。
 */
function attrMatchValues(e: Elem, k: string, opts?: HintMatchOptions): string[] {
  const cf = (x: unknown): string => String(x ?? "").toLowerCase();
  const keys = k === "href"
    ? ["href_full", "href"]
    : k === "label" && opts?.attrValueMatch !== "display"
      ? ["full_label", "label"]
      : [k];
  if (keys.length === 1) return [cf(e[keys[0]!])];
  const vals: string[] = [];
  for (const kk of keys) {
    const v = e[kk];
    if (typeof v !== "string" || v === "") continue;
    const s = cf(v);
    if (!vals.includes(s)) vals.push(s);
  }
  return vals.length ? vals : [""];
}

/**
 * A2：完整标签上的**词边界/前缀**命中（多词裸词的落点）。
 * `Sort by` 必须能命中 `Sort by, Not selected`（逗号边界）；裸词整体仍是"宁缺勿错"的
 * 档内歧义语义，只是新增了这一档边界证据（此前只有按空白切词的 全等/前缀/包含）。
 */
function boundaryHit(label: string, token: string): boolean {
  if (!label || !token) return false;
  if (label === token) return true;
  if (label.startsWith(`${token} `)) return true;
  if (label.includes(` ${token} `)) return true;
  if (label.endsWith(` ${token}`)) return true;
  for (const sep of [",", ".", ":", ";", "!", "?"]) if (label.includes(`${token}${sep}`)) return true;
  return false;
}

/* ---- task-9（评审 #2）：弱档命中的**旁路**诊断（不改任何公开签名与选择语义） ----
 * bare 与 attrSubstr 的弱档胜出（词前缀/词包含/loose 子串）是"误点容器/同缀元素"的高发
 * 形状——实测现场：裸词"价格"前缀命中 label="价格评分时间所有过滤条件…" 的整块结果容器
 * （class Vo5ZAe），reason 只有 step_timeout，靠人工比对 URL 才定位。这里在解析时把
 * 全部撞词候选记进模块态，执行器在自己的解析调用后 take 走、写成 step warning
 * matched_others。返回值/sink/选择语义逐字节不变；hintMatchImpl 是纯同步函数，
 * "最后写入者 = 最后一次解析"，执行器配 hint 相等性校验消费，无陈旧风险。 */

export interface HintMatchCandidate {
  ref: string;
  tag: string;
  /** class 首段（仅当池元素带 class_names——inspect 面/显式开启时；缺省 null）。 */
  class: string | null;
  /** label 截断 ≤40 字符（full_label 优先）。 */
  label: string;
}

export interface HintMatchOthersDiag {
  hint: string;
  kind: "bare" | "attrSubstr";
  /** 命中档：bare ladder 0..4（0=整 label 全等，3=词前缀，4=词包含）；attrSubstr 1..3。 */
  tier: number;
  /** 弱档胜出（bare t≥3 / attrSubstr t=3）= 误命中高发形状，执行器据此决定是否告警。 */
  suspicious: boolean;
  /** 实际裁决的 ref（firstIfSame 结果；全落空为 null）。 */
  decided: string | null;
  /** 全部撞词候选（池序 ≤8；decided 在其中）。 */
  candidates: HintMatchCandidate[];
}

let lastHintOthersDiag: HintMatchOthersDiag | null = null;

/** 执行器在解析调用后取走（take 一次即清；非 bare/attrSubstr 的解析不写、不清）。 */
export function takeHintMatchOthers(): HintMatchOthersDiag | null {
  const d = lastHintOthersDiag;
  lastHintOthersDiag = null;
  return d;
}

function diagCandidate(ref: string, e: Elem): HintMatchCandidate {
  const cn = Array.isArray(e.class_names) && e.class_names.length > 0 ? e.class_names[0] : undefined;
  return {
    ref,
    tag: String(e.tag ?? ""),
    class: typeof cn === "string" && cn !== "" ? cn : null,
    label: String(e.full_label ?? e.label ?? "").trim().slice(0, 40),
  };
}

/** The 6 hint grammars, single-parsed; `sink` (if given) records the candidate set. */
function hintMatchImpl(
  hint: string, elems: ElemPool, sink?: HintCandidates | null, opts?: HintMatchOptions,
): string | null {
  const parsed = parseHint(hint);
  const entries = Object.entries(elems);
  /** A4：`diag:false` = 只读解析，不写 B1 旁路模块态（不写不清，见 HintMatchOptions.diag）。 */
  const recordDiag = opts?.diag !== false;
  /**
   * E3：`within:#id` 尾缀的池侧限定（纯内存）——命中集 ⊆ 锚子树（anchor_ids 含锚 id）。
   * 解析层已保证 within 只能是单个 `#id`（链式/多 within = 解析期拒绝，不进这里）。
   * 包一层让所有形状共用：限定发生在各形状的命中集上，不改变档位语义本身。
   */
  const inAnchor = (refs: string[]): string[] =>
    parsed.within === undefined ? refs
      : refs.filter((r) => (elems[r]!.anchor_ids ?? []).includes(parsed.within!));
  /** Record the strongest tier's refs, then resolve exactly as before. */
  const emit = (refs: string[], tier: number): string | null => {
    const limited = inAnchor(refs);
    if (sink) { sink.refs = limited; sink.tier = tier; sink.decided = null; }
    return firstIfSame(new Set(limited), elems);
  };

  if (parsed.kind === "id") {
    return emit(entries.filter(([, e]) => String(e.id ?? "").toLowerCase() === parsed.value).map(([r]) => r), 0);
  }
  if (parsed.kind === "attrSubstr") {
    const pre = parsed.tag;
    const k = poolFieldFor(parsed.attr);
    const v = parsed.value;
    // T9：href 走 [href_full, href] 双底座（任一字段命中即算）；A1：aria-label 别名的
    // label 走 [full_label, label] 双底座；其它属性单字段。底座口径见 attrMatchValues。
    const hitList = entries.filter(([, e]) => (!pre || e.tag === pre) && attrMatchValues(e, k, opts).some((x) => x.includes(v)));
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
    // task-9：每次 attrSubstr 解析都旁路记录撞词候选（含 loose 档的 suspicious 标记）——
    // 返回值与 sink 语义逐字节不变；记录被执行器 take 走（见 takeHintMatchOthers）。
    const finishSubstr = (refs: string[], tier: number): string | null => {
      const decided = firstIfSame(new Set(refs), elems);
      if (recordDiag) {
        lastHintOthersDiag = {
          hint, kind: "attrSubstr", tier, suspicious: tier >= 3, decided,
          candidates: hitList.slice(0, 8).map(([r, e]) => diagCandidate(r, e)),
        };
      }
      if (sink) { sink.refs = refs; sink.tier = tier; sink.decided = null; }
      return decided;
    };
    const exact = hitList.filter(([, e]) => attrMatchValues(e, k, opts).some((x) => x === v));
    if (exact.length) return finishSubstr(inAnchor(exact.map(([r]) => r)), 1);
    const slug = hitList.filter(([, e]) => attrMatchValues(e, k, opts).some((x) => x.split("/").pop() === v));
    if (slug.length) return finishSubstr(inAnchor(slug.map(([r]) => r)), 2);
    return finishSubstr(inAnchor(hitList.map(([r]) => r)), 3);
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
    const k = poolFieldFor(parsed.attr);
    // case-FOLDED comparison: the hint is lower-cased on entry but device ids
    // are routinely upper-case (data-test="net-CAM-1001"); a raw `==` silently
    // missed and the plan-named target fell back to laya (~0.03 conf).
    const refs = entries
      .filter(([, e]) => (!parsed.tag || e.tag === parsed.tag) && attrMatchValues(e, k, opts).some((x) => x === parsed.value))
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
  // A2：完整 label（≤200）优先——模型视图的 label 是前 40 字，遇到
  // aria-label="Sort by, Not selected" 这类长标签会把判据截掉。
  const boundary = new Set<string>();
  const tiers: Array<Set<string>> = [new Set(), new Set(), new Set()];
  for (const [r, e] of entries) {
    const label = String(e.full_label ?? e.label ?? "").trim().toLowerCase();
    if (label === h) whole.add(r);
    if (boundaryHit(label, h)) boundary.add(r);
    const ws = `${e.data_test ?? ""} ${label}`.toLowerCase().replace(/-/g, " ").split(/\s+/);
    if (ws.some((w) => w === h)) tiers[0]!.add(r);
    else if (ws.some((w) => w.startsWith(h))) tiers[1]!.add(r);
    else if (ws.some((w) => w.includes(h))) tiers[2]!.add(r);
  }
  // 档位顺序：整 label 全等 → 词全等 → **词边界/前缀**（A2 新增档，纯加档不挪旧档语义）
  // → 词前缀 → 词包含。旧档位内仍"宁缺勿错"（真歧义 null）。
  const ladder = [whole, tiers[0]!, boundary, tiers[1]!, tiers[2]!];
  // task-9：全部撞词候选 = 五档并集（含最终选中者），供 matched_others 旁路诊断。
  const allBareHits = new Set<string>();
  for (const s of ladder) for (const r of s) allBareHits.add(r);
  for (let t = 0; t < ladder.length; t++) {
    const hits = ladder[t]!;
    if (hits.size) {
      const refs = inAnchor([...hits]);
      // 锚限定后本档可能清空（全部命中在锚外）——继续落下一档？不：档位语义是
      // "最强非空档"，限定是命中集的后置过滤；限定后为空 = 本档无锚内候选，
      // 视为落空继续下一档会让"锚内更弱档"越级顶上（跨档混选）。正确语义：
      // 限定后空 → 直接跳到全落空记录（锚内没有任何档命中）。
      if (refs.length === 0) break;
      const decided = firstIfSame(new Set(refs), elems);
      // 弱档（词前缀 t=3 / 词包含 t=4）胜出 = 容器撞车/同缀误中的高发形状（实测：
      // 裸词"价格"前缀命中整块结果容器 div.Vo5ZAe）。记录不改返回值/选择语义。
      if (recordDiag) {
        lastHintOthersDiag = {
          hint, kind: "bare", tier: t, suspicious: t >= 3, decided,
          candidates: entries
            .filter(([r]) => allBareHits.has(r))
            .slice(0, 8)
            .map(([r, e]) => diagCandidate(r, e)),
        };
      }
      if (sink) { sink.refs = refs; sink.tier = t; sink.decided = null; }
      return decided;
    }
  }
  // 全落空也记录（suspicious:false、空候选）——消掉"上一次弱档诊断滞留"的陈旧风险。
  if (sink) { sink.refs = []; sink.tier = -1; sink.decided = null; }
  if (recordDiag) {
    lastHintOthersDiag = { hint, kind: "bare", tier: -1, suspicious: false, decided: null, candidates: [] };
  }
  return null;
}

/**
 * Resolve a frozen plan's `target_hint` to a single ref (see `hintMatchImpl`).
 * This is the pool-side half of the hint grammar; `extraction.hintLookup` is the
 * DOM-side half and re-queries live elements the budget evicted. Both are driven
 * by the same tier semantics documented on `hintMatchImpl`.
 */
export function hintMatch(
  hint: string, elems: ElemPool, opts?: HintMatchOptions,
): string | null {
  return hintMatchImpl(hint, elems, null, opts);
}

/**
 * The tiered candidate set for a `target_hint` (see `HintCandidates`). Returns null
 * only when the hint matches NOTHING (an empty pool-wide miss); a hint that hits a
 * tier always yields that tier's refs — including an ambiguous tier, which is the
 * whole point: the decider gets "these k elements" instead of "null → the full pool".
 */
export function hintCandidates(
  hint: string, elems: ElemPool, opts?: HintMatchOptions,
): HintCandidates | null {
  const sink: HintCandidates = { refs: [], tier: -1, decided: null };
  hintMatchImpl(hint, elems, sink, opts);
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
  // T9：href 建议用**原始属性值**（空则退回投影）——投影值可能被 hintMatch 命中但 DOM
  // 回捞面（活页面原始属性）永远比不到；仍经同一个 push→hintMatch 自证，中不了就不建议。
  const hrefHint = elem.href_full || elem.href;
  if (hrefHint) {
    push(`${elem.tag}[href=${hrefHint}]`);
  }
  const label = String(elem.label ?? "").trim();
  if (label.length >= 2 && label.length <= 80) push(label);
  return out.slice(0, 4);
}
