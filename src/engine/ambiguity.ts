/**
 * A2：**歧义证据**（`AmbiguityView`）与它的唯一构造点。
 *
 * 事故形状（已核实）：`amber session` 的 `act` 走 `actOnce → _resolveOne → resolveCommandRef`，
 * 后者按「可行动优先」排序后**取 refs[0] 直接执行**，歧义只留一条弱档旁路诊断——于是在
 * `div "搜索关闭" | button "关闭"` 上点 "关闭" 命中的是搜索框清除按钮，整条搜索链路退出。
 * `run` 的命令步对同一形状是结构化停因 `target_ambiguous`（executor.ts 命令空间），从不动手。
 *
 * 本模块把命令步的**同一个谓词**搬到单动作面：
 *   `hintCandidates(target, elems) !== null && cand.decided === null && cand.refs.length > 1`
 * 判据的唯一出处仍是 `rules.hintCandidates`（与 `hintMatch` 同一份解析器），这里不复制语法。
 *
 * 纪律：
 *   - **零页面 I/O**：只读传入的池对象，不抽池、不定位、不动作、不猜；
 *   - 证据有界：候选 ≤5 行（`candidates_total` 记总集、`truncated` 标截断），label/class/near
 *     ≤40、ref/tag/role ≤16、suggested_hint ≤80、target ≤120 字符；
 *   - `near` 只**复制** `elem.near`（不重算、不格式化）；`suggested_hint` 调既有
 *     `suggestHints(elem, elems)[0]`——它内部已用同一个 `hintMatch` 自证「恰好唯一命中」，
 *     为空（没有可自证的形状）时**省略该键**，绝不发明；
 *   - `source:"dom_fallback"`（池外 A3 回退）只给候选身份：合成池自证 ≠ 真池，所以
 *     **不提供** `near` / `suggested_hint`（也不做任何池外可见性推断）。
 *
 * `suggestHints` 内部的 `hintMatch` 会写 `rules.ts` 的 B1 旁路模块态（`takeHintMatchOthers`）。
 * 本函数只在**歧义停**的路径上被调用，末尾再用同 target 的 `hintCandidates` 复原该旁路——
 * 于是会话面 task-34 的 `ambiguous`/`matched_others` 回显仍指向本条 target 的解析。
 */
import { hintCandidates, suggestHints } from "./rules.ts";
import type { Elem, ElemPool } from "./extraction.ts";

/** 证据里最多列出的候选行数（总集大小另记 `candidates_total`）。 */
export const AMBIGUITY_MAX_CANDIDATES = 5;
/** 单字段字符上限（超长按 `clip` 截断，保留末尾省略号）。 */
export const AMBIGUITY_REF_MAX = 16;
export const AMBIGUITY_TAG_MAX = 16;
export const AMBIGUITY_ROLE_MAX = 16;
export const AMBIGUITY_LABEL_MAX = 40;
export const AMBIGUITY_CLASS_MAX = 40;
export const AMBIGUITY_NEAR_MAX = 40;
export const AMBIGUITY_HINT_MAX = 80;
export const AMBIGUITY_TARGET_MAX = 120;

/** 一条歧义候选（只陈述池里的事实；缺的键就不出现）。 */
export interface AmbiguityCandidate {
  /** 池 ref（`eN` / `f<fi>:eN`；DOM 回退面是合成 `pN`）。 */
  ref: string;
  tag: string;
  role?: string;
  /** 归一标签（`full_label` 优先）≤40。 */
  label: string;
  /** class 首段（仅当池元素带 `class_names`——inspect/显式开启时；缺省没有该键）。 */
  class?: string;
  /** 原样复制 `elem.near`（池面才有）。 */
  near?: string;
  /** frame 下标（0 = 主 frame / 合成池）。 */
  frame: number;
  /** 该候选的归一 label 在**本次池内**出现 >1 次（label 本身不足以区分）。 */
  same_label: boolean;
  /** 既有 `suggestHints` 自证唯一的第一条（池面才有；自证不唯一就省略）。 */
  suggested_hint?: string;
}

/** 歧义证据（会话 act / 单动作解析的失败面）。 */
export interface AmbiguityView {
  /** 原 hint 字符串（≤120）。 */
  target: string;
  /** `pool` = 可见准入池；`dom_fallback` = A3 池外 DOM 回退的合成池。 */
  source: "pool" | "dom_fallback";
  /** `hintCandidates` 胜出档（与命令步同一判据；-1 不会出现在歧义里）。 */
  tier: number;
  /** 旧行为会执行的那个 ref（`resolveCommandRef` 可行动优先排序后的 refs[0]）。 */
  would_act_ref: string;
  /** 歧义档的总候选数（可能 > `candidates.length`）。 */
  candidates_total: number;
  /** `candidates_total > candidates.length`。 */
  truncated: boolean;
  candidates: AmbiguityCandidate[];
}

export interface AmbiguityInput {
  /** 本次解析的 hint（原样）。 */
  target: string;
  source: AmbiguityView["source"];
  /** 解析用的池（只读；不会被修改）。 */
  elems: ElemPool;
  /** `resolveCommandRef` 的返回（可行动优先排序；空数组 = 池内零命中）。 */
  orderedRefs: readonly string[];
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** 池内归一 label（`full_label` 优先；大小写折叠、空白折叠）。 */
function normalizedLabel(e: Elem): string {
  return String(e.full_label ?? e.label ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** 池面候选行的单行证据（`source:"dom_fallback"` 关掉 near / suggested_hint）。 */
function candidateView(
  ref: string, e: Elem, labelCounts: ReadonlyMap<string, number>,
  opts: { suggestions: boolean; near: boolean }, elems: ElemPool,
): AmbiguityCandidate {
  const label = clip(String(e.full_label ?? e.label ?? "").replace(/\s+/g, " ").trim(), AMBIGUITY_LABEL_MAX);
  const cls = Array.isArray(e.class_names) && typeof e.class_names[0] === "string" && e.class_names[0] !== ""
    ? clip(e.class_names[0], AMBIGUITY_CLASS_MAX)
    : undefined;
  const near = opts.near && typeof e.near === "string" && e.near !== ""
    ? clip(e.near, AMBIGUITY_NEAR_MAX)
    : undefined;
  const role = typeof e.role === "string" && e.role !== "" ? clip(e.role, AMBIGUITY_ROLE_MAX) : undefined;
  const hint = opts.suggestions ? suggestHints(e, elems)[0] : undefined;
  const norm = normalizedLabel(e);
  return {
    ref: clip(ref, AMBIGUITY_REF_MAX),
    tag: clip(String(e.tag ?? ""), AMBIGUITY_TAG_MAX),
    ...(role === undefined ? {} : { role }),
    label,
    ...(cls === undefined ? {} : { class: cls }),
    ...(near === undefined ? {} : { near }),
    frame: Number.isFinite(Number(e.frame)) ? Number(e.frame) : 0,
    same_label: norm !== "" && (labelCounts.get(norm) ?? 0) > 1,
    ...(hint === undefined || hint === "" ? {} : { suggested_hint: clip(hint, AMBIGUITY_HINT_MAX) }),
  };
}

/**
 * 判定并构造歧义证据：**返回 null = 不是歧义**（解析照旧进行）。
 *
 * 谓词与命令步 `target_ambiguous` 逐条同源（`hintCandidates` + `decided === null` +
 * `refs.length > 1`）；`orderedRefs` 只用来取 `would_act_ref`（旧行为的执行目标），不参与判定。
 */
export function describeAmbiguity(input: AmbiguityInput): AmbiguityView | null {
  const cand = hintCandidates(input.target, input.elems);
  if (cand === null || cand.decided !== null || cand.refs.length <= 1) return null;
  const total = cand.refs.length;
  const rows = cand.refs.slice(0, AMBIGUITY_MAX_CANDIDATES);
  // 池内归一 label 计数：same_label = 该 label 在本池出现 >1 次（label 不足以区分）。
  const labelCounts = new Map<string, number>();
  for (const e of Object.values(input.elems)) {
    const norm = normalizedLabel(e);
    if (norm === "") continue;
    labelCounts.set(norm, (labelCounts.get(norm) ?? 0) + 1);
  }
  const withSuggestions = input.source === "pool";
  const candidates: AmbiguityCandidate[] = [];
  for (const ref of rows) {
    const e = input.elems[ref];
    if (e === undefined) continue;
    candidates.push(candidateView(ref, e, labelCounts, { suggestions: withSuggestions, near: withSuggestions }, input.elems));
  }
  // 复原 B1 旁路模块态（suggestHints 内部 hintMatch 会重写它）：让会话面 task-34 的
  // ambiguous/matched_others 仍对应本条 target 的解析。对 bare/attrSubstr 的 target 这正是
  // resolveCommandRef 刚写下的那份；其它形状本来不写旁路（残留诊断会被 hint 相等性校验挡住）。
  if (withSuggestions) void hintCandidates(input.target, input.elems);
  const would = input.orderedRefs[0];
  return {
    target: clip(input.target, AMBIGUITY_TARGET_MAX),
    source: input.source,
    tier: cand.tier,
    would_act_ref: clip(would === undefined ? String(cand.refs[0] ?? "") : String(would), AMBIGUITY_REF_MAX),
    candidates_total: total,
    truncated: total > candidates.length,
    candidates,
  };
}
