/**
 * The ONNX Runtime implementation of the `laya` decision engine — the plug for
 * the `LayaRuntime` seam in `model.ts`.
 *
 * The Python executor calls the pip package; this module reproduces the parts of
 * it that decide an answer, on top of the exported graph (`laya_dec.onnx` +
 * `.onnx.data`) and the checkpoint's own `tokenizer.json`:
 *
 *   ids/markers        `buildSequence` (laya-format.ts, already parity-tested) fed
 *                      by a tokenizer.json adapter whose special-token ids come
 *                      from `added_tokens` — transformers.js does not map `[CLS]`
 *   one forward pass   `input_ids/attention_mask/marker_pos/marker_mask/qtype`
 *                      collated exactly like `laya.common.collate_items`
 *   calibration        `temp_bucket` → `clamp_temperature` → softmax →
 *                      `confidence_from_probs` (all in laya-format.ts)
 *
 * Everything here is lazy: constructing a runtime touches nothing, `load()`
 * checks the artifacts, and the 1.7 GB session/weights are only mapped on the
 * first `predict`. That keeps `npm test` green and fast on a box without the
 * checkpoint (see tests/laya-onnx.test.ts, which skips the heavy cases).
 *
 * `node-port-poc/laya.mjs` proved the numbers (probs max|diff| 2.98e-5 vs Python
 * ORT); this file is that proof turned into a module, reusing `laya-format.ts`
 * instead of re-porting the pure parts (the POC's `serializeState` was the one
 * place it hand-rolled Python's `", "`/`": "` separators — that lives there now).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MODELS_DIR } from "../support/paths.ts";
import {
  QTYPES, buildSequence, clampTemperature, confidenceFromProbs, pyJsonDumps,
  renderOptions, serializeState, softmaxWithTemperature, tempBucket,
  type QuestionDef, type SeqTokenizer, type StateLike,
} from "./laya-format.ts";
import type {
  Answer, ChoiceAnswer, DecisionAgent, LayaRuntime, ModelState, PredictResult,
  Question,
} from "./model.ts";

/* ----------------------------------------------------------------- discovery */

/** HF cache repo directory for the checkpoint. */
const HF_REPO_DIR = "models--convaiinnovations--laya";

/**
 * Where the ONNX graph lives unless `opts.onnxPath` says otherwise
 * (`LAYAA_ONNX_MODEL` / `LAYA_ONNX_MODEL` env).
 *
 * 默认落点是**项目目录 `models/`**（`src/support/paths.ts` 的 `MODELS_DIR`）：模型产物
 * 统一在这一处——`npm run model:fetch` 往这儿写，运行期从这儿读，不再一半在 `/tmp`、
 * 一半在 HF 缓存里。
 */
export const DEFAULT_ONNX_PATH = path.join(MODELS_DIR, "laya_dec.onnx");

/** Python's `DEFAULT_SHORTLIST_K` is 20; the executor's pick ladder asks for 8. */
export const DEFAULT_SHORTLIST_K = 8;

function hfHubRoots(): string[] {
  const roots: string[] = [];
  const hubCache = process.env.HF_HUB_CACHE ?? process.env.HUGGINGFACE_HUB_CACHE;
  if (hubCache) roots.push(hubCache);
  if (process.env.HF_HOME) roots.push(path.join(process.env.HF_HOME, "hub"));
  roots.push(path.join(os.homedir(), ".cache", "huggingface", "hub"));
  return [...new Set(roots)];
}

/**
 * The `tokenizer/` directory of the cached `convaiinnovations/laya` snapshot.
 *
 * The snapshot hash is NOT hard-coded: every snapshot that actually ships a
 * `tokenizer/tokenizer.json` is a candidate, newest first (ties broken by path,
 * so the choice is deterministic). `LAYAA_TOKENIZER_DIR` overrides the search.
 * Returns null when the checkpoint was never downloaded.
 */
export function findDefaultTokenizerDir(): string | null {
  const override = process.env.LAYAA_TOKENIZER_DIR ?? process.env.LAYA_TOKENIZER_DIR;
  if (override && fs.existsSync(path.join(override, "tokenizer.json"))) return override;

  // 项目目录 `models/tokenizer/`：`npm run model:fetch` 的默认落点（与图同处一地），
  // 优先于 HF 缓存——"下载到哪就读哪"不该靠两次猜测。HF 快照仍是既有安装的回退。
  const local = path.join(MODELS_DIR, "tokenizer");
  if (fs.existsSync(path.join(local, "tokenizer.json"))) return local;

  const found: Array<{ dir: string; mtime: number }> = [];
  for (const root of hfHubRoots()) {
    const snapshots = path.join(root, HF_REPO_DIR, "snapshots");
    let names: string[];
    try {
      names = fs.readdirSync(snapshots);
    } catch {
      continue;                       // no cache under this root
    }
    for (const name of names) {
      const dir = path.join(snapshots, name, "tokenizer");
      if (!fs.existsSync(path.join(dir, "tokenizer.json"))) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(dir).mtimeMs;
      } catch { /* unreadable snapshot: still a candidate at mtime 0 */ }
      found.push({ dir, mtime });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime || (a.dir < b.dir ? -1 : 1));
  return found.length ? found[0]!.dir : null;
}

/* ------------------------------------------------------------------ config */

/** The shipped `rl_agent_config.json` values, used when the file cannot be read. */
const BUILTIN_TEMPERATURE = [1.6369030475616455, 1.2514300346374512, 1.983399510383606];
const BUILTIN_TEMPERATURE_BY_OPTIONS: Record<string, number> = {
  "choice:2": 1.9063563346862793,
  "choice:3-5": 1.7601518630981445,
  "choice:6-10": 1.0000158548355103,
  // Fitted to sharpen x10; clampTemperature floors it at TEMP_MIN (0.5) on use.
  "choice:11+": 0.10058280825614929,
  "score:3-5": 1.2514300346374512,
  "noul:2": 1.983399510383606,
};

const DEFAULT_MAX_LEN = 512;
const DEFAULT_HEAD_MAX_LEN = 192;

/** Per-agent inference config, already resolved (raw temperatures, clamped on use). */
export interface ResolvedLayaConfig {
  maxLen: number;
  headMaxLen: number;
  /** `tempBucket(qtype, k)` -> temperature. */
  temperatureByOptions: Record<string, number>;
  /** `[choice, score, noul]` fallback when a bucket is missing. */
  temperatureByType: number[];
}

interface RawConfig {
  max_len?: unknown;
  head_max_len?: unknown;
  temperature?: unknown;
  temperature_by_options?: unknown;
}

function positiveInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : fallback;
}

function numberRecord(v: unknown): Record<string, number> | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
  }
  return out;
}

/** Read `rl_agent_config.json` next to the tokenizer (or in the subfolder). */
function readRawConfig(tokenizerDir: string | null, subfolder: string | null | undefined): RawConfig | null {
  if (!tokenizerDir) return null;
  const snapshotDir = path.dirname(tokenizerDir);
  const candidates = [
    ...(subfolder ? [path.join(snapshotDir, subfolder, "rl_agent_config.json")] : []),
    path.join(snapshotDir, "rl_agent_config.json"),
  ];
  for (const file of candidates) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8")) as RawConfig;
    } catch {
      // try the next candidate; a missing/invalid config falls back to builtins
    }
  }
  return null;
}

function resolveConfig(
  tokenizerDir: string | null,
  subfolder: string | null | undefined,
  explicitTemperatures?: Record<string, number>,
): ResolvedLayaConfig {
  const raw = readRawConfig(tokenizerDir, subfolder);
  const fromFile = numberRecord(raw?.temperature_by_options);
  const temperatureByOptions = explicitTemperatures ?? fromFile ?? { ...BUILTIN_TEMPERATURE_BY_OPTIONS };

  let temperatureByType: number[];
  if (explicitTemperatures) {
    // An explicit table is authoritative: bucket keys select the temperature, and
    // plain qtype keys ("choice"/"score"/"noul") replace the per-type fallback.
    temperatureByType = ["choice", "score", "noul"].map((name) => explicitTemperatures[name] ?? 1.0);
  } else {
    const fileTemps = Array.isArray(raw?.temperature) ? raw.temperature : null;
    temperatureByType = [0, 1, 2].map((i) => {
      const v = fileTemps?.[i];
      return typeof v === "number" && Number.isFinite(v) ? v : BUILTIN_TEMPERATURE[i]!;
    });
  }

  return {
    maxLen: positiveInt(raw?.max_len, DEFAULT_MAX_LEN),
    headMaxLen: positiveInt(raw?.head_max_len, DEFAULT_HEAD_MAX_LEN),
    temperatureByOptions,
    temperatureByType,
  };
}

/* ---------------------------------------------------------------- tokenizer */

interface HfEncoding {
  input_ids: { data: ArrayLike<number | bigint> };
}
/** The callable surface transformers.js exposes at runtime (types omit `[CLS]`). */
interface HfTokenizerLike {
  (text: string, options?: { add_special_tokens?: boolean }): HfEncoding;
  mask_token?: string | null;
  cls_token_id?: number | null;
  sep_token_id?: number | null;
  mask_token_id?: number | null;
  pad_token_id?: number | null;
}

function readAddedTokens(tokenizerJson: string): Record<string, number> {
  try {
    const spec = JSON.parse(fs.readFileSync(tokenizerJson, "utf-8")) as {
      added_tokens?: Array<{ content?: unknown; id?: unknown }>;
    };
    const out: Record<string, number> = {};
    for (const t of spec.added_tokens ?? []) {
      if (typeof t.content === "string" && typeof t.id === "number") out[t.content] = t.id;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * `SeqTokenizer` backed by the checkpoint's `tokenizer.json` loaded through
 * transformers.js. The special-token ids prefer the live tokenizer property and
 * fall back to `added_tokens` — transformers.js leaves `cls_token_id` undefined
 * for this tokenizer, and a wrong CLS id shifts every marker position silently.
 */
export class LayaTokenizer implements SeqTokenizer {
  readonly maskToken: string;
  readonly clsTokenId: number;
  readonly sepTokenId: number;
  readonly maskTokenId: number;
  readonly padTokenId: number;
  private readonly tok: HfTokenizerLike;

  private constructor(tok: HfTokenizerLike, ids: {
    cls: number; sep: number; mask: number; pad: number;
  }) {
    this.tok = tok;
    this.maskToken = tok.mask_token ?? "[MASK]";
    this.clsTokenId = ids.cls;
    this.sepTokenId = ids.sep;
    this.maskTokenId = ids.mask;
    this.padTokenId = ids.pad;
  }

  static async fromDir(dir: string): Promise<LayaTokenizer> {
    const { AutoTokenizer } = await import("@huggingface/transformers");
    const tok = (await AutoTokenizer.from_pretrained(dir)) as unknown as HfTokenizerLike;
    const added = readAddedTokens(path.join(dir, "tokenizer.json"));
    const pick = (name: string, live: number | null | undefined): number => {
      if (typeof live === "number" && Number.isFinite(live)) return live;
      const id = added[name];
      if (typeof id !== "number") throw new Error(`tokenizer at ${dir} has no ${name} token id`);
      return id;
    };
    return new LayaTokenizer(tok, {
      cls: pick("[CLS]", tok.cls_token_id),
      sep: pick("[SEP]", tok.sep_token_id),
      mask: pick("[MASK]", tok.mask_token_id),
      pad: pick("[PAD]", tok.pad_token_id),
    });
  }

  /** Always `add_special_tokens: false`, the only mode `buildSequence` uses. */
  encode(text: string): number[] {
    const out = this.tok(text, { add_special_tokens: false });
    return Array.from(out.input_ids.data, (v) => Number(v));
  }
}

/* ------------------------------------------------------- sequence assembly */

/** One question turned into the graph's per-item inputs. */
export interface PreparedQuestion {
  qid: string;
  qtype: number;
  ids: number[];
  markers: number[];
  /** Label order for probability reporting: criteria keys, `0..k-1`, or false/true. */
  labels: string[];
}

/** Mirror of Python `Agent._to_internal`: choice list criteria become `{label: None}`. */
function normalizeQuestion(q: Question): QuestionDef {
  const rawIns = q.instructions ?? q.ins ?? "";
  const instructions = typeof rawIns === "string" ? rawIns : pyJsonDumps(rawIns);
  const criteria = q.criteria ?? null;
  if (q.type === "choice" && Array.isArray(criteria)) {
    return {
      type: "choice",
      instructions,
      criteria: Object.fromEntries(criteria.map((c) => [String(c), null])),
    };
  }
  return { type: q.type, instructions, criteria: criteria as QuestionDef["criteria"] };
}

/** The probability keys for a question, in option order. */
export function questionLabels(q: Question): string[] {
  if (q.type === "choice") {
    const crit = q.criteria ?? null;
    if (Array.isArray(crit)) return crit.map((c) => String(c));
    if (crit && typeof crit === "object") return Object.keys(crit);
    return [];
  }
  if (q.type === "score") return (Array.isArray(q.criteria) ? q.criteria : []).map((_c, i) => String(i));
  return ["false", "true"];
}

/**
 * Build the ids/markers for every question against one state, exactly the way
 * `Agent.system_one` does (same `build_sequence`, same option-count check).
 * Exported because it is the one place a wrong argument — a state passed where
 * the criteria belong — would silently shift every marker.
 */
export function prepareQuestionSequences(
  tok: SeqTokenizer,
  state: ModelState,
  questions: Record<string, Question>,
  maxLen = DEFAULT_MAX_LEN,
  headMaxLen = DEFAULT_HEAD_MAX_LEN,
): PreparedQuestion[] {
  const out: PreparedQuestion[] = [];
  for (const [qid, q] of Object.entries(questions)) {
    const def = normalizeQuestion(q);
    const { ids, markers } = buildSequence(tok, state as StateLike, def, maxLen, headMaxLen);
    const labels = questionLabels(q);
    if (markers.length !== labels.length) {
      throw new Error(
        `question ${qid} options exceed head_max_len=${headMaxLen} ` +
        `(${markers.length} markers for ${labels.length} options)`,
      );
    }
    out.push({ qid, qtype: QTYPES[q.type], ids, markers, labels });
  }
  return out;
}

/* --------------------------------------------------------------- ORT session */

interface OrtSessionLike {
  run(
    feeds: Record<string, unknown>,
    fetches: readonly string[],
  ): Promise<Record<string, { data: ArrayLike<number> }>>;
}
interface OrtModule {
  InferenceSession: {
    create(modelPath: string, options?: { executionProviders?: readonly string[] }): Promise<OrtSessionLike>;
  };
  Tensor: {
    new (type: "int64", data: BigInt64Array, dims: readonly number[]): unknown;
    new (type: "bool", data: Uint8Array, dims: readonly number[]): unknown;
  };
}

let ortModule: Promise<OrtModule> | null = null;
/** Imported lazily so a box without the checkpoint never loads the native binding. */
function loadOrt(): Promise<OrtModule> {
  if (!ortModule) {
    ortModule = import("onnxruntime-node").then((m) => m as unknown as OrtModule);
  }
  return ortModule;
}

/* -------------------------------------------------------------- the runtime */

export interface CreateLayaOnnxRuntimeOptions {
  /** Default `<repo>/models/laya_dec.onnx`; the `LAYAA_ONNX_MODEL` / `LAYA_ONNX_MODEL` env overrides it. */
  onnxPath?: string;
  /** Default: glob the HF cache snapshot's `tokenizer/` dir. */
  tokenizerDir?: string;
  /** Bucket/qtype -> temperature. Default: the checkpoint's `temperature_by_options`. */
  temperatures?: Record<string, number>;
}

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

/** The loaded checkpoint plus its inference config. */
class LayaOnnxAgent implements DecisionAgent {
  readonly modelId: string;
  readonly onnxPath: string;
  readonly tokenizerDir: string;
  readonly config: ResolvedLayaConfig;
  private sessionPromise: Promise<OrtSessionLike> | null = null;
  private tokenizerPromise: Promise<LayaTokenizer> | null = null;

  constructor(
    onnxPath: string,
    tokenizerDir: string,
    config: ResolvedLayaConfig,
    modelId: string,
  ) {
    this.onnxPath = onnxPath;
    this.tokenizerDir = tokenizerDir;
    this.config = config;
    this.modelId = modelId;
  }

  private session(): Promise<OrtSessionLike> {
    if (!this.sessionPromise) {
      this.sessionPromise = (async () => {
        if (!fs.existsSync(this.onnxPath)) {
          throw new Error(
            `laya ONNX graph not found: ${this.onnxPath} ` +
            `(set LAYA_ONNX_MODEL or pass onnxPath; external weights .onnx.data must sit beside it)`,
          );
        }
        const ort = await loadOrt();
        return ort.InferenceSession.create(this.onnxPath, { executionProviders: ["cpu"] });
      })();
    }
    return this.sessionPromise;
  }

  /** Temperature for one question: bucket table first, per-qtype fallback second. */
  private temperatureFor(qtype: number, k: number): number {
    const bucket = tempBucket(qtype, k);
    const raw = this.config.temperatureByOptions[bucket];
    if (typeof raw === "number" && Number.isFinite(raw)) return clampTemperature(raw);
    return clampTemperature(this.config.temperatureByType[qtype] ?? 1.0);
  }

  private tokenizer(): Promise<LayaTokenizer> {
    if (!this.tokenizerPromise) this.tokenizerPromise = LayaTokenizer.fromDir(this.tokenizerDir);
    return this.tokenizerPromise;
  }

  async predict(state: ModelState, questions: Record<string, Question>): Promise<PredictResult> {
    const tok = await this.tokenizer();
    // PORT FIX: the exported graph's TopK is STATIC (k=2), so a `choice` question
    // with a single option fails at inference — "k argument [2] should not be
    // greater than specified axis dim value [1]". Torch has no such limit, so the
    // Python reference answers it fine. Here the answer is trivial (one option is
    // the argmax, and the entropy confidence of a 1-option distribution is 1.0),
    // so it is answered without a forward pass. Found by the fixture bench matrix
    // (`spa-overlay-dismiss`: the overlay leaves exactly one pickable element).
    const answers: Record<string, Answer> = {};
    const runnable: Record<string, Question> = {};
    for (const [qid, q] of Object.entries(questions)) {
      const labels = questionLabels(q);
      if (q.type === "choice" && labels.length === 1) {
        answers[qid] = {
          choice: labels[0]!, probabilities: { [labels[0]!]: 1 }, confidence: 1,
        } as Answer;
        continue;
      }
      runnable[qid] = q;
    }
    if (!Object.keys(runnable).length) return { answers };
    const prepared = prepareQuestionSequences(
      tok, state, runnable, this.config.maxLen, this.config.headMaxLen,
    );
    if (!prepared.length) return { answers };
    const rows = await this.runLogits(prepared, tok);
    prepared.forEach((p, r) => {
      answers[p.qid] = this.answerFor(p, rows[r] ?? []);
    });
    return { answers };
  }

  /**
   * One collated forward pass for every question, mirroring
   * `laya.common.collate_items`: pad ids with `[PAD]`, zero the attention mask,
   * pad markers with pos 0 / mask false. Only `logits` is fetched — `act_logits`
   * is not part of this port and its exported shape is static `[1, 2]`.
   */
  private async runLogits(prepared: PreparedQuestion[], tok: LayaTokenizer): Promise<number[][]> {
    const session = await this.session();
    if (prepared.some((p) => p.markers.length === 0)) {
      throw new Error("every question must render at least one option marker");
    }
    const n = prepared.length;
    let len = 0;
    let kmax = 0;
    for (const p of prepared) {
      len = Math.max(len, p.ids.length);
      kmax = Math.max(kmax, p.markers.length);
    }

    const ids = new BigInt64Array(n * len);
    const attention = new BigInt64Array(n * len);
    const markerPos = new BigInt64Array(n * kmax);
    const markerMask = new Uint8Array(n * kmax);
    const qtype = new BigInt64Array(n);
    const pad = BigInt(tok.padTokenId);

    prepared.forEach((p, r) => {
      const base = r * len;
      for (let i = 0; i < len; i++) {
        if (i < p.ids.length) {
          ids[base + i] = BigInt(p.ids[i]!);
          attention[base + i] = 1n;
        } else {
          ids[base + i] = pad;
          attention[base + i] = 0n;
        }
      }
      const mbase = r * kmax;
      p.markers.forEach((m, j) => {
        markerPos[mbase + j] = BigInt(m);
        markerMask[mbase + j] = 1;
      });
      qtype[r] = BigInt(p.qtype);
    });

    const ort = await loadOrt();
    const feeds = {
      input_ids: new ort.Tensor("int64", ids, [n, len]),
      attention_mask: new ort.Tensor("int64", attention, [n, len]),
      marker_pos: new ort.Tensor("int64", markerPos, [n, kmax]),
      marker_mask: new ort.Tensor("bool", markerMask, [n, kmax]),
      qtype: new ort.Tensor("int64", qtype, [n]),
    };
    const out = await session.run(feeds, ["logits"]);
    const logits = out["logits"];
    if (!logits) throw new Error("ONNX session returned no `logits` output");

    const rows: number[][] = [];
    for (let r = 0; r < n; r++) {
      const row = new Array<number>(kmax);
      for (let j = 0; j < kmax; j++) row[j] = Number(logits.data[r * kmax + j]);
      rows.push(row);
    }
    return rows;
  }

  /** Python `Agent.system_one`'s post-processing for one question. */
  private answerFor(p: PreparedQuestion, rawLogits: readonly number[]): Answer {
    const k = p.markers.length;
    const probs = softmaxWithTemperature(rawLogits.slice(0, k), this.temperatureFor(p.qtype, k));
    const confidence = round4(confidenceFromProbs(probs, k));

    if (p.qtype === QTYPES.choice) {
      let best = 0;
      for (let i = 1; i < k; i++) if ((probs[i] ?? 0) > (probs[best] ?? 0)) best = i;
      const probabilities: Record<string, number> = {};
      for (let i = 0; i < k; i++) probabilities[p.labels[i]!] = round4(probs[i] ?? 0);
      return { choice: p.labels[best]!, probabilities, confidence } satisfies ChoiceAnswer;
    }
    if (p.qtype === QTYPES.score) {
      // Python reports the expected level, `sum(i * p_i)`, plus the distribution.
      let expected = 0;
      const probabilities: Record<string, number> = {};
      for (let i = 0; i < k; i++) {
        expected += i * (probs[i] ?? 0);
        probabilities[String(i)] = round4(probs[i] ?? 0);
      }
      return { score: round4(expected), probabilities, confidence };
    }
    // noul: p[1] is P(true).
    return { noul: round4(probs[1] ?? 0) };
  }
}

/* ---------------------------------------------------------------- shortlist */

function isPositiveInt(k: unknown): k is number {
  return typeof k === "number" && Number.isInteger(k) && k >= 1;
}

function queryText(state: ModelState, rawIns: unknown): string {
  const body = serializeState(state as StateLike);
  if (rawIns === null || rawIns === undefined || rawIns === "") return body;
  const ins = typeof rawIns === "string" ? rawIns : pyJsonDumps(rawIns);
  return `${ins}\n${body}`;
}

/** Python `shortlist._rank`'s embedding path: cosine vs the state/instruction query. */
function cosineRank(
  embedFn: (texts: string[]) => unknown,
  state: ModelState,
  q: Question,
  k: number,
): string[] {
  const labels = questionLabels(q);
  const texts = [queryText(state, q.instructions ?? q.ins), ...renderOptions(normalizeQuestion(q))];
  const raw = embedFn(texts);
  if (!Array.isArray(raw) || raw.length !== texts.length) {
    throw new Error(`embed_fn must return ${texts.length} rows, got ${Array.isArray(raw) ? raw.length : typeof raw}`);
  }
  const rows = raw.map((row) => {
    if (!Array.isArray(row) || row.length < 1) throw new Error("embed_fn must return a 2-D array");
    return row.map((v) => Number(v));
  });
  const query = rows[0]!;
  const qNorm = Math.sqrt(query.reduce((a, v) => a + v * v, 0));
  const sims = rows.slice(1).map((row) => {
    if (qNorm === 0) return 0;
    const dot = row.reduce((a, v, i) => a + v * (query[i] ?? 0), 0);
    const norm = Math.sqrt(row.reduce((a, v) => a + v * v, 0)) * qNorm;
    const sim = norm > 0 ? dot / norm : 0;
    return Number.isFinite(sim) ? sim : 0;              // Python nan_to_num
  });
  return labels
    .map((label, i) => ({ label, sim: sims[i] ?? 0 }))
    .sort((a, b) => b.sim - a.sim || labels.indexOf(a.label) - labels.indexOf(b.label))
    .slice(0, k)
    .map((e) => e.label);
}

/** Rebuild a choice question over just `kept` (Python `shortlist._subset_criteria`). */
function subsetChoice(q: Question, kept: readonly string[]): Question {
  const crit = q.criteria;
  if (Array.isArray(crit)) {
    return { ...q, criteria: kept.map((label) => crit.find((c) => String(c) === label) ?? label) };
  }
  const obj = (crit ?? {}) as Record<string, unknown>;
  return { ...q, criteria: Object.fromEntries(kept.map((label) => [label, obj[label]])) };
}

/** Rank the labels of a shortlisted choice. */
function rankLabels(
  agent: DecisionAgent,
  state: ModelState,
  ranking: Record<string, Question>,
  embedFn: unknown,
  k: number,
): Promise<Record<string, string[]>> | Record<string, string[]> {
  if (typeof embedFn === "function") {
    const out: Record<string, string[]> = {};
    for (const [qid, q] of Object.entries(ranking)) {
      out[qid] = cosineRank(embedFn as (texts: string[]) => unknown, state, q, k);
    }
    return out;
  }
  // No embed_fn (the TS runtime returns null — state text is keyword-compressed,
  // not embedded): rank by the model's own first pass over the full option set.
  // Python would rank by cosine here; with k=8 the executor only needs a top-8,
  // and a model pass ranks it with the signal that actually decides the answer.
  return agent.predict(state, ranking).then((probe) => {
    const out: Record<string, string[]> = {};
    for (const [qid, q] of Object.entries(ranking)) {
      const labels = questionLabels(q);
      const probs = (probe.answers[qid] as ChoiceAnswer | undefined)?.probabilities ?? {};
      const order = labels.map((label, i) => ({ label, i }));
      order.sort((a, b) => (probs[b.label] ?? -Infinity) - (probs[a.label] ?? -Infinity) || a.i - b.i);
      out[qid] = order.slice(0, k).map((e) => e.label);
    }
    return out;
  });
}

/**
 * The installable `LayaRuntime`. Nothing is loaded until `load()`/`predict()`;
 * `embedFnFromAgent` returns null because this port's state text is deterministic
 * (the executor's `stateText` compresses by keyword overlap, not embeddings).
 */
export function createLayaOnnxRuntime(opts: CreateLayaOnnxRuntimeOptions = {}): LayaRuntime {
  const onnxPath = opts.onnxPath
    // Precedence must match the single-source detector `model-artifacts.onnxModelPath`:
    // `LAYA_ONNX_MODEL` is canonical, `LAYAA_ONNX_MODEL` is the legacy typo kept for
    // compatibility. The two orders disagreed once — doctor checked `LAYA_*` while this
    // runtime loaded `LAYAA_*` first, so an env setting both (or only the typo name) made
    // "artifacts complete" mean different files in two places. Keep them identical.
    ?? process.env.LAYA_ONNX_MODEL ?? process.env.LAYAA_ONNX_MODEL
    ?? DEFAULT_ONNX_PATH;
  const tokenizerDir = opts.tokenizerDir ?? findDefaultTokenizerDir();

  return {
    async load(modelId: string, loadOpts?: { subfolder?: string | null }): Promise<DecisionAgent> {
      if (!fs.existsSync(onnxPath)) {
        throw new Error(
          `laya ONNX graph not found: ${onnxPath} ` +
          `(set LAYA_ONNX_MODEL, or pass createLayaOnnxRuntime({ onnxPath }))`,
        );
      }
      if (!tokenizerDir || !fs.existsSync(path.join(tokenizerDir, "tokenizer.json"))) {
        throw new Error(
          "laya tokenizer not found: download convaiinnovations/laya or set LAYA_TOKENIZER_DIR " +
          "(expected <snapshot>/tokenizer/tokenizer.json)",
        );
      }
      const config = resolveConfig(tokenizerDir, loadOpts?.subfolder, opts.temperatures);
      return new LayaOnnxAgent(onnxPath, tokenizerDir, config, modelId);
    },

    embedFnFromAgent(): unknown {
      return null;
    },

    async predictShortlist(
      agent: DecisionAgent,
      state: ModelState,
      questions: Record<string, Question>,
      shortlistOpts?: { embedFn?: unknown; k?: number },
    ): Promise<PredictResult> {
      const k = shortlistOpts?.k ?? DEFAULT_SHORTLIST_K;
      if (!isPositiveInt(k)) throw new Error(`k must be a positive integer, got ${String(k)}`);

      const reduced: Record<string, Question> = {};
      const meta: Record<string, { passthrough?: boolean; kept?: string[] }> = {};
      const ranking: Record<string, Question> = {};

      for (const [qid, q] of Object.entries(questions)) {
        if (q.type !== "choice") {
          reduced[qid] = q;
          continue;
        }
        const labels = questionLabels(q);
        if (!labels.length) throw new Error(`question ${qid} is a choice but has no criteria`);
        if (k >= labels.length) {
          // Nothing dropped: forward unchanged and keep the model's own calibrated
          // confidence. Re-normalising over the full set would inflate it.
          meta[qid] = { passthrough: true, kept: labels };
          reduced[qid] = q;
          continue;
        }
        ranking[qid] = q;
      }

      if (Object.keys(ranking).length) {
        const ranked = await rankLabels(agent, state, ranking, shortlistOpts?.embedFn, k);
        for (const [qid, q] of Object.entries(ranking)) {
          const kept = ranked[qid] ?? questionLabels(q).slice(0, k);
          meta[qid] = { passthrough: false, kept };
          reduced[qid] = subsetChoice(q, kept);
        }
      }

      const result = await agent.predict(state, reduced);
      return { answers: result.answers, shortlist: meta };
    },
  };
}
