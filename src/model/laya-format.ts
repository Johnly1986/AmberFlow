/**
 * laya's inference-side formatting and calibration — ported from `laya/common.py`.
 *
 * These are the pure parts of "turning a state + question into one forward pass's
 * inputs" (sequence layout, option rendering, truncation budgets) plus the
 * post-processing the project measured its way into (temperature buckets,
 * clamping, entropy confidence). No torch, no onnxruntime: the ONNX session
 * plugs into `model.ts` on top of this.
 */

/** Question types as the checkpoint was trained on them. */
export const QTYPES = { choice: 0, score: 1, noul: 2 } as const;
export const QTYPE_NAMES: Record<number, string> = { 0: "choice", 1: "score", 2: "noul" };

export type StateLike = string | Record<string, unknown> | unknown[];

/** Python `json.dumps(..., ensure_ascii=False, separators=(", ", ": "), default=str)`.
 *
 * The separators matter twice over: they change the serialized STATE (token
 * count) and the rendered option text, and a divergence silently shifts every
 * downstream token position.
 */
import { pyJsonDumps } from "../support/pystr.ts";
import { LAYA_EVIDENCE_CHARS_PER_TOKEN } from "../support/tuning.ts";
export { pyJsonDumps };

export function serializeState(state: StateLike): string {
  return typeof state === "string" ? state : pyJsonDumps(state);
}

/** Render one criterion value as text (strings pass through, structures become JSON). */
export function renderCriterion(value: unknown): string {
  return typeof value === "string" ? value : pyJsonDumps(value);
}

export interface QuestionDef {
  type: "choice" | "score" | "noul";
  ins?: string;
  instructions?: string;
  criteria?: Record<string, unknown> | unknown[] | { false?: string; true?: string } | null;
  /** laya's internal field name for `instructions`. */
  crit?: Record<string, unknown> | unknown[] | { false?: string; true?: string } | null;
}

/** Render option texts in label-index order. Noul is always [false, true]. */
export function renderOptions(q: QuestionDef): string[] {
  const crit = q.criteria ?? q.crit ?? null;
  if (q.type === "choice") {
    const c = (crit ?? {}) as Record<string, unknown>;
    // only null/"" mean "no description"; 0 and false are legitimate criterion values
    return Object.entries(c).map(([k, v]) =>
      (v === null || v === undefined || v === "" ? k : `${k}: ${renderCriterion(v)}`));
  }
  if (q.type === "score") {
    const c = (crit ?? []) as unknown[];
    return c.map((v, i) => `level ${i}: ${renderCriterion(v)}`);
  }
  const c = (crit ?? {}) as { false?: string; true?: string };
  const f = c.false;
  const t = c.true;
  return [
    "false: " + (f !== null && f !== undefined && f !== "" ? renderCriterion(f) : "no, the statement does not hold"),
    "true: " + (t !== null && t !== undefined && t !== "" ? renderCriterion(t) : "yes, the statement holds"),
  ];
}

/** The tokenizer surface `buildSequence` needs (satisfied by transformers.js or a fake). */
export interface SeqTokenizer {
  maskToken: string;
  clsTokenId: number;
  sepTokenId: number;
  maskTokenId: number;
  encode(text: string, opts?: { addSpecialTokens?: boolean }): number[];
}

/** 每条选项渲染文本的 token 名额（checkpoint 训练时的选项上限，序列布局的一部分）。 */
export const OPTION_TOKEN_BUDGET = 48;

/** 一次文本装载的裁剪事实：字符级预算裁剪与 token 安全网分开记账，互不重叠。 */
export interface TextTruncation {
  /** 是否发生任何裁剪（字符级预算裁剪或 token 安全网）。 */
  truncated: boolean;
  /** 字符级预算裁剪丢弃的字符数（按字符边界裁，不切断代理对）。 */
  droppedChars: number;
  /** 字符级预算裁剪后编码仍超名额时，token 安全网丢弃的 token 数。 */
  droppedTokens: number;
  /** 字符级预算裁剪发生在文本左侧（`truncateLeft` 的 tail 保留模式）。 */
  fromLeft?: boolean;
}

/** 一条 laya 序列三个证据面的裁剪事实。 */
export interface SequenceTruncation {
  state: TextTruncation;
  head: TextTruncation;
  options: TextTruncation;
}

/** 无裁剪事实（共享只读常量：调用方不得原地改）。 */
const NO_TRUNCATION: TextTruncation = Object.freeze({
  truncated: false, droppedChars: 0, droppedTokens: 0,
});

/**
 * 按字符预算裁剪文本，且不切断代理对：切点落在代理对的中间时，整对码点一起裁掉
 * （前缀模式后退切点，tail 模式前移起点）——宁可少留一个码点，也不产出孤立代理。
 */
export function truncateTextToChars(
  text: string,
  maxChars: number,
  fromLeft = false,
): { text: string; droppedChars: number } {
  const keep = Math.max(0, Math.floor(maxChars));
  if (text.length <= keep) return { text, droppedChars: 0 };
  let start = 0;
  let end = text.length;
  if (fromLeft) {
    start = text.length - keep;
    const first = text.charCodeAt(start);
    if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  } else {
    end = keep;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return { text: text.slice(start, end), droppedChars: text.length - (end - start) };
}

interface FittedIds {
  ids: number[];
  truncation: TextTruncation;
}

/**
 * 按 token 名额装载一段文本。口径（`buildSequence` 三个证据面共用）：
 *   1. 未超名额 ⇒ 原样编码返回——默认路径的 ids 与既有实现逐字节一致；
 *   2. 超名额 ⇒ **先按字符预算裁文本**（名额 × `LAYA_EVIDENCE_CHARS_PER_TOKEN`，常量单源），
 *      再编码裁过的文本；模型面从此看不到超预算的整段原文；
 *   3. 字符预算下编码仍超名额（更密的 tokenizer：CJK / byte-level）⇒ 才在 token 边界做
 *      最终安全网，并如实记 `droppedTokens`。
 */
function fitText(
  tok: SeqTokenizer,
  text: string,
  tokenBudget: number,
  fromLeft = false,
): FittedIds {
  const cap = Math.max(0, tokenBudget);
  const full = tok.encode(text, { addSpecialTokens: false });
  if (full.length <= cap) return { ids: full, truncation: NO_TRUNCATION };
  const cut = truncateTextToChars(text, cap * LAYA_EVIDENCE_CHARS_PER_TOKEN, fromLeft);
  let ids = tok.encode(cut.text, { addSpecialTokens: false });
  let droppedTokens = 0;
  if (ids.length > cap) {
    droppedTokens = ids.length - cap;
    ids = fromLeft ? ids.slice(-cap) : ids.slice(0, cap);
  }
  return {
    ids,
    truncation: {
      truncated: true, droppedChars: cut.droppedChars, droppedTokens,
      ...(fromLeft ? { fromLeft: true } : {}),
    },
  };
}

/**
 * Format: `[CLS] <type> instructions [SEP] [MASK] opt0 [MASK] opt1 ... [SEP] state [SEP]`.
 * Marker positions are the indices of each option's `[MASK]`.
 *
 * 三个证据面（head/options/state）都走 `fitText`：超名额时先裁文本再编码，并把裁剪事实
 * 放进返回值的 `truncation`；调用方经 `prepareQuestionSequences` 聚合成 `evidence_truncated`。
 */
export function buildSequence(
  tok: SeqTokenizer,
  state: StateLike,
  q: QuestionDef,
  maxLen = 512,
  headMaxLen = 192,
  optionOrder: number[] | null = null,
  truncateLeft = false,
): { ids: number[]; markers: number[]; truncation: SequenceTruncation } {
  const mask = tok.maskToken;
  const opts = renderOptions(q);
  const order = optionOrder ?? opts.map((_o, i) => i);
  const ins = String(q.instructions ?? q.ins ?? "").replaceAll(mask, " ");
  let optionChars = 0;
  let optionTokens = 0;
  let optIds: number[][] = [];
  for (const i of order) {
    const fitted = fitText(tok, " " + opts[i]!.replaceAll(mask, " "), OPTION_TOKEN_BUDGET);
    optIds.push([tok.maskTokenId, ...fitted.ids]);
    optionChars += fitted.truncation.droppedChars;
    optionTokens += fitted.truncation.droppedTokens;
  }
  let optBudget = headMaxLen - optIds.reduce((a, o) => a + o.length, 0);
  if (optBudget < 16) {
    const per = Math.max(4, Math.floor((headMaxLen - 16) / Math.max(1, optIds.length)));
    optIds = optIds.map((o) => {
      if (o.length <= per) return o;
      optionTokens += o.length - per;
      return o.slice(0, per);
    });
    optBudget = headMaxLen - optIds.reduce((a, o) => a + o.length, 0);
  }
  const head = fitText(tok, `${q.type} question: ${ins}`, Math.max(8, optBudget));
  let ids = [tok.clsTokenId, ...head.ids, tok.sepTokenId];
  const markers: number[] = [];
  for (const o of optIds) {
    markers.push(ids.length);
    ids = ids.concat(o);
  }
  ids.push(tok.sepTokenId);
  const room = Math.max(0, maxLen - ids.length - 1);
  const st = fitText(tok, serializeState(state).replaceAll(mask, " "), room, truncateLeft);
  ids = ids.concat(st.ids, [tok.sepTokenId]);
  return {
    ids: ids.slice(0, maxLen),
    markers: markers.filter((m) => m < maxLen),
    truncation: {
      state: st.truncation,
      head: head.truncation,
      options: optionChars > 0 || optionTokens > 0
        ? { truncated: true, droppedChars: optionChars, droppedTokens: optionTokens }
        : NO_TRUNCATION,
    },
  };
}

/* ---------------------------------------------------------------- calibration */

/**
 * A fitted temperature below 1 SHARPENS the logits. The shipped `choice:11+`
 * bucket is 0.1006 (~10x sharpening): a 0.24 top probability is published as
 * 0.99, so a caller gating on confidence is told a coin flip is a certainty.
 * No honest calibration needs that, so refuse to apply one that does.
 */
export const TEMP_MIN = 0.5;
export const TEMP_MAX = 5.0;

/** A usable temperature: `t` confined to [lo, hi], falling back to 1.0 if it is not a number.
 *
 * Python's `float(t)` semantics: numbers and non-empty numeric strings parse,
 * while null/undefined/objects/dicts raise and fall back to 1.0 — JS `Number(null)`
 * would silently become 0 and clamp to the floor instead.
 */
export function clampTemperature(t: unknown, lo = TEMP_MIN, hi = TEMP_MAX): number {
  let v: number;
  if (typeof t === "number") v = t;
  else if (typeof t === "string" && t.trim() !== "") v = Number(t);
  else return 1.0;
  if (!Number.isFinite(v)) return 1.0;      // NaN / ±inf / non-numeric string
  return Math.min(hi, Math.max(lo, v));
}

/** Bucket key the checkpoint's fitted temperatures are indexed by. */
export function tempBucket(qtype: number, k: number): string {
  const size = k <= 2 ? "2" : k <= 5 ? "3-5" : k <= 10 ? "6-10" : "11+";
  return `${QTYPE_NAMES[qtype]}:${size}`;
}

/** Normalized Shannon entropy confidence: 1 - H(p) / log(k). */
export function confidenceFromProbs(p: readonly number[], k: number): number {
  if (k < 2) return 1.0;
  let ent = 0;
  for (let i = 0; i < k; i++) {
    const pi = Math.min(Math.max(p[i] ?? 0, 1e-12), 1.0);
    ent -= pi * Math.log(pi);
  }
  return Math.min(1.0, Math.max(0.0, 1 - ent / Math.log(k)));
}

/** Softmax with a temperature, for turning logits into reported distributions. */
export function softmaxWithTemperature(logits: readonly number[], temperature: number): number[] {
  const t = temperature === 0 ? 1e-9 : temperature;
  const mx = Math.max(...logits.map((l) => l / t));
  const exps = logits.map((l) => Math.exp(l / t - mx));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}
