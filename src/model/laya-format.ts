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
export function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NaN";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return "[" + value.map(pyJsonDumps).join(", ") + "]";
  if (typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${JSON.stringify(k)}: ${pyJsonDumps(v)}`).join(", ") + "}";
  }
  return JSON.stringify(String(value));
}

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

/**
 * Format: `[CLS] <type> instructions [SEP] [MASK] opt0 [MASK] opt1 ... [SEP] state [SEP]`.
 * Marker positions are the indices of each option's `[MASK]`.
 */
export function buildSequence(
  tok: SeqTokenizer,
  state: StateLike,
  q: QuestionDef,
  maxLen = 512,
  headMaxLen = 192,
  optionOrder: number[] | null = null,
  truncateLeft = false,
): { ids: number[]; markers: number[] } {
  const mask = tok.maskToken;
  const opts = renderOptions(q);
  const order = optionOrder ?? opts.map((_o, i) => i);
  const ins = String(q.instructions ?? q.ins ?? "").replaceAll(mask, " ");
  let headIds = tok.encode(`${q.type} question: ${ins}`, { addSpecialTokens: false });
  let optIds: number[][] = [];
  for (const i of order) {
    optIds.push([
      tok.maskTokenId,
      ...tok.encode(" " + opts[i]!.replaceAll(mask, " "), { addSpecialTokens: false }).slice(0, 48),
    ]);
  }
  let optBudget = headMaxLen - optIds.reduce((a, o) => a + o.length, 0);
  if (optBudget < 16) {
    const per = Math.max(4, Math.floor((headMaxLen - 16) / Math.max(1, optIds.length)));
    optIds = optIds.map((o) => o.slice(0, per));
    optBudget = headMaxLen - optIds.reduce((a, o) => a + o.length, 0);
  }
  headIds = headIds.slice(0, Math.max(8, optBudget));
  let ids = [tok.clsTokenId, ...headIds, tok.sepTokenId];
  const markers: number[] = [];
  for (const o of optIds) {
    markers.push(ids.length);
    ids = ids.concat(o);
  }
  ids.push(tok.sepTokenId);
  const room = Math.max(0, maxLen - ids.length - 1);
  let st = tok.encode(serializeState(state).replaceAll(mask, " "), { addSpecialTokens: false });
  st = truncateLeft ? st.slice(-room) : st.slice(0, room);
  ids = ids.concat(st, [tok.sepTokenId]);
  return { ids: ids.slice(0, maxLen), markers: markers.filter((m) => m < maxLen) };
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
