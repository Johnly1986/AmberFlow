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

/**
 * E2：歧义命中顺序的闭集（`decision.ambiguous_ordering`）。
 *   - `"dom-preorder"`（缺省）：候选按 live-DOM 前序遍历位置排序——同一帧内按文档序
 *     （提取扫描序 `scan` 即前序遍历位置），跨帧按帧序 → 帧内文档序；
 *   - `"pool-order"`：旧行为（可行动优先排序后的池序首个），仅作回退开关。
 */
export type AmbiguousOrdering = "dom-preorder" | "pool-order";

/**
 * E2：候选的**文档序排序键**（同一帧内按 `scan`（前序遍历位置），跨帧按 frame 下标优先）。
 * 平局（同位置，如同一元素重复收集）取池内首个——稳定排序保证不漂。
 */
export function domPreorderKey(e: Elem): number {
  const frame = Number.isFinite(Number(e.frame)) ? Number(e.frame) : 0;
  const scan = Number.isFinite(Number(e.scan)) ? Number(e.scan) : Number.MAX_SAFE_INTEGER;
  return frame * 1e9 + scan;
}

/**
 * E2：歧义候选按 DOM 前序重排（纯函数；不改谓词、不改可行动性判定）。
 *
 * 输入是 `resolveCommandRef` 已按"可行动优先"排好的 refs；这里只把**命中档内的顺序**
 * 改为文档序：跨帧先按 frame 下标、帧内按 `scan`（提取扫描序 = 前序遍历位置）。
 * `scan` 缺失（合成池 `pN` / 旧视图）时退回池内相对位置——仍确定性，绝不随机。
 */
export function orderCandidatesByDomPreorder(refs: readonly string[], elems: ElemPool): string[] {
  const posOf = new Map(refs.map((r, i) => [r, i]));
  return [...refs].sort((a, b) => {
    const ea = elems[a];
    const eb = elems[b];
    if (ea === undefined || eb === undefined) return (posOf.get(a) ?? 0) - (posOf.get(b) ?? 0);
    return domPreorderKey(ea) - domPreorderKey(eb)
      || (posOf.get(a) ?? 0) - (posOf.get(b) ?? 0);
  });
}

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
  /**
   * E2：歧义命中顺序（additive；旧消费方缺字段即旧行为）。`"dom-preorder"`（缺省）=
   * 命中 act 时刻 DOM 序首个 actionable 候选；`"pool-order"` = 旧池序（回退开关）。
   */
  ordering?: AmbiguousOrdering;
  /** E2：按 ordering 排序后实际选中的 ref（additive；便于诊断与断言）。 */
  selected_ref?: string;
  /** E2：选中候选的 `dsh_ref`（池元素才有；additive）。 */
  selected_dsh_ref?: string;
  /** E2：选中候选的排序键（文档序键；additive）。 */
  sort_key?: number;
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
  /**
   * E2：歧义命中顺序（`decision.ambiguous_ordering`；缺省 `"dom-preorder"`）。
   * 决定 `would_act_ref` 之外的 additive 证据字段与 `_resolveOne` 的实际命中顺序。
   */
  ordering?: AmbiguousOrdering;
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
 *
 * E2：`ordering:"dom-preorder"`（缺省）时按文档序重排命中档并输出 additive 证据
 * （ordering/selected_ref/selected_dsh_ref/sort_key）；`"pool-order"` = 旧行为，
 * additive 字段照给（`ordering:"pool-order"` + `selected_ref` = `would_act_ref`）。
 */
export function describeAmbiguity(input: AmbiguityInput): AmbiguityView | null {
  const cand = hintCandidates(input.target, input.elems);
  if (cand === null || cand.decided !== null || cand.refs.length <= 1) return null;
  const ordering: AmbiguousOrdering = input.ordering ?? "dom-preorder";
  const total = cand.refs.length;
  // E2：排序后的命中档（文档序或池序）；candidates 行按同序展示。
  const orderedRefs = ordering === "pool-order"
    ? [...input.orderedRefs]
    : orderCandidatesByDomPreorder(input.orderedRefs.length ? input.orderedRefs : cand.refs, input.elems);
  const rows = orderedRefs.slice(0, AMBIGUITY_MAX_CANDIDATES);
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
  // E2：排序依据与实际选中者（首个候选；无候选时退回 would_act_ref 词面）。
  const selectedRef = orderedRefs[0] ?? would;
  const selectedElem = selectedRef === undefined ? undefined : input.elems[selectedRef];
  const dshRef = selectedElem === undefined || typeof selectedElem.dsh_ref !== "string" || selectedElem.dsh_ref === ""
    ? undefined
    : clip(selectedElem.dsh_ref, AMBIGUITY_REF_MAX);
  const sortKey = selectedElem === undefined ? undefined : domPreorderKey(selectedElem);
  return {
    target: clip(input.target, AMBIGUITY_TARGET_MAX),
    source: input.source,
    tier: cand.tier,
    would_act_ref: clip(would === undefined ? String(cand.refs[0] ?? "") : String(would), AMBIGUITY_REF_MAX),
    ordering,
    ...(selectedRef === undefined ? {} : { selected_ref: clip(String(selectedRef), AMBIGUITY_REF_MAX) }),
    ...(dshRef === undefined ? {} : { selected_dsh_ref: dshRef }),
    ...(sortKey === undefined ? {} : { sort_key: sortKey }),
    candidates_total: total,
    truncated: total > candidates.length,
    candidates,
  };
}
