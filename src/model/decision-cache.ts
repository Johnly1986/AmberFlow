/**
 * Decision cache + decision log — "decision memory" for a DETERMINISTIC model.
 *
 * Reference application: agent-memory caches like `muscle-mem` (replay what was
 * already decided) and the "stateless decision memory" pattern. Here the argument
 * is stronger than usual, because laya is deterministic: the same (state,
 * question, option set, temperature bucket) always yields the same answer, so
 * re-asking is pure waste — and it happens on every retried subgoal, every replan,
 * every resumed run and every ablation re-run of the same plan.
 *
 * What this is NOT: a policy that learns across pages. Keys are exact
 * (state + questions fingerprints), so a changed page is a miss, not a stale hit;
 * the cache can be disabled wholesale and its effect is always visible in stats.
 *
 * The optional JSONL log is the other half of the idea: every decision — hit or
 * miss — with the state size and the answer, which is what makes a run replayable
 * and what signal induction / auditing consume afterwards.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type { DecisionAgent, LayaRuntime, ModelState, PredictResult, Question } from "./model.ts";

export interface DecisionCacheStats {
  hits: number;
  misses: number;
  entries: number;
}

export interface DecisionCacheOptions {
  /** Bounded LRU-ish size (insertion order eviction). Default 2000. */
  max?: number;
  /** Append every decision as one JSON line to this path. */
  logPath?: string | null;
}

export interface CachedRuntime extends LayaRuntime {
  decisionStats(): DecisionCacheStats;
  /** Drop everything (e.g. between unrelated runs). */
  resetDecisionCache(): void;
}

/** Stable JSON: object keys sorted, so equal content ⇒ equal fingerprint. */
function canon(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
}

function fingerprint(...parts: unknown[]): string {
  return crypto.createHash("sha1").update(parts.map(canon).join("|")).digest("hex").slice(0, 20);
}

/**
 * Wrap a runtime with exact-key memoisation. The wrapped agents and
 * `predictShortlist` share one store, so a pick that the shortlist path already
 * answered is never forwarded again.
 */
export function withDecisionCache(rt: LayaRuntime, opts: DecisionCacheOptions = {}): CachedRuntime {
  const max = Math.max(1, opts.max ?? 2000);
  const logPath = opts.logPath ?? null;
  const store = new Map<string, unknown>();
  const stats: DecisionCacheStats = { hits: 0, misses: 0, entries: 0 };

  const log = (model: string, key: string, cached: boolean, questions: string[], answer: unknown): void => {
    if (!logPath) return;
    try {
      fs.appendFileSync(logPath, JSON.stringify({
        ts: new Date().toISOString(), model, fingerprint: key, cached,
        questions, answer,
      }) + "\n", "utf-8");
    } catch {
      /* the log is diagnostic: never let it break a run */
    }
  };

  const remember = (key: string, value: unknown): void => {
    if (store.size >= max) {
      const oldest = store.keys().next().value as string | undefined;
      if (oldest !== undefined) store.delete(oldest);
    }
    store.set(key, value);
    stats.entries = store.size;
  };

  const wrapAgent = (agent: DecisionAgent, modelId: string): DecisionAgent => ({
    ...agent,
    async predict(state: ModelState, questions: Record<string, Question>): Promise<PredictResult> {
      const key = `p:${modelId}:${fingerprint(state, questions)}`;
      const cached = store.get(key) as PredictResult | undefined;
      if (cached) {
        stats.hits += 1;
        log(modelId, key, true, Object.keys(questions), cached.answers);
        return cached;
      }
      stats.misses += 1;
      const res = await agent.predict(state, questions);
      remember(key, res);
      log(modelId, key, false, Object.keys(questions), res.answers);
      return res;
    },
  });

  return {
    ...rt,
    async load(modelId, loadOpts) {
      const agent = await rt.load(modelId, loadOpts);
      return wrapAgent(agent, `${modelId}/${loadOpts?.subfolder ?? ""}`);
    },
    async predictShortlist(agent, state, questions, o) {
      const modelId = (agent as { modelId?: string }).modelId ?? "unknown";
      const key = `s:${modelId}:${o?.k ?? ""}:${fingerprint(state, questions)}`;
      const cached = store.get(key) as PredictResult | undefined;
      if (cached) {
        stats.hits += 1;
        log(modelId, key, true, Object.keys(questions), cached.answers);
        return cached;
      }
      stats.misses += 1;
      const res = await rt.predictShortlist(agent, state, questions, o);
      remember(key, res);
      log(modelId, key, false, Object.keys(questions), res.answers);
      return res;
    },
    decisionStats: () => ({ ...stats }),
    resetDecisionCache: () => {
      store.clear();
      stats.entries = 0;
    },
  };
}
