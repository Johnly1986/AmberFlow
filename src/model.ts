/**
 * The model seam: everything the executor needs from laya, as an interface.
 *
 * The Python executor calls the pip package directly (`laya.load`,
 * `laya.predict_shortlist`, `laya.embed_fn_from_agent`, `laya.Router`). The port
 * keeps the same call shape behind an installable runtime so that:
 *   - the executor never imports onnxruntime (the ONNX implementation lands in
 *     its own module and installs itself here);
 *   - tests script answers without a 421M-parameter checkpoint.
 *
 * `node-port-poc/` already proved the ONNX path produces bit-comparable
 * decisions; this file is the seam it will plug into.
 */

export type QType = "choice" | "score" | "noul";

export interface Question {
  type: QType;
  /** Python calls this field `ins`; kept for parity with the presets. */
  ins?: string;
  instructions?: string;
  criteria?: Record<string, unknown> | unknown[] | { false?: string; true?: string } | null;
}

export interface ChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface NoulAnswer {
  noul: number;
}
export interface ScoreAnswer {
  score: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}
export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export interface PredictResult {
  answers: Record<string, Answer>;
  shortlist?: Record<string, { passthrough?: boolean; kept?: string[] }>;
}

export type ModelState = string | Record<string, unknown> | unknown[];

/** One loaded checkpoint. Mirrors the parts of laya's `Agent` the executor uses. */
export interface DecisionAgent {
  predict(state: ModelState, questions: Record<string, Question>): Promise<PredictResult>;
  /** Identity of the loaded checkpoint (router bookkeeping). */
  modelId?: string;
}

/** Router: script/language-based checkpoint choice (microseconds, no forward pass). */
export interface RouterLike {
  default?: string;
  loaded?: Set<string> | string[];
  route(state: ModelState): Record<string, unknown> | Promise<Record<string, unknown>>;
  load(model: string): Promise<DecisionAgent>;
  unload(): void | Promise<void>;
  attach?(model: string, agent: DecisionAgent): void;
}

export interface LayaRuntime {
  load(modelId: string, opts?: { subfolder?: string | null }): Promise<DecisionAgent>;
  embedFnFromAgent(agent: DecisionAgent): unknown;
  /** Shortlist (k) prediction: keeps the calibrated-confidence passthrough rule. */
  predictShortlist(
    agent: DecisionAgent, state: ModelState, questions: Record<string, Question>,
    opts?: { embedFn?: unknown; k?: number },
  ): Promise<PredictResult>;
  /** Optional factory for the router (routing is opt-in). */
  createRouter?(opts?: { maxLoaded?: number }): RouterLike;
}

let runtime: LayaRuntime | null = null;

/** Install the model runtime (ONNX port, or a fake in tests). */
export function installLayaRuntime(impl: LayaRuntime | null): void {
  runtime = impl;
}

export class LayaNotConfiguredError extends Error {
  constructor(what: string) {
    super(`laya runtime not configured (${what}): call installLayaRuntime() first`);
    this.name = "LayaNotConfiguredError";
  }
}

export function getLayaRuntime(): LayaRuntime {
  if (!runtime) throw new LayaNotConfiguredError("getLayaRuntime");
  return runtime;
}

/*
 * ------------------------------------------------------------------ test doubles
 */

export interface ScriptedAnswer {
  /** matched against the question key the executor asks (`act`, `r`, `d`, ...) */
  [questionKey: string]: Answer | ((state: ModelState) => Answer);
}

/**
 * A scripted agent: answers come from a function, so executor tests can drive
 * every branch (pick / risk / done) without a checkpoint. Shape-compatible with
 * the Python fakes in test_middleware.py (`_FakeAgent`).
 */
export function scriptedAgent(
  answer: (questionKey: string, state: ModelState, questions: Record<string, Question>) => Answer | undefined,
  modelId = "scripted",
): DecisionAgent {
  return {
    modelId,
    async predict(state, questions) {
      const answers: Record<string, Answer> = {};
      for (const key of Object.keys(questions)) {
        const a = answer(key, state, questions);
        if (a !== undefined) answers[key] = a;
      }
      return { answers };
    },
  };
}

/** Runtime wrapping a single scripted agent (no router, no real load). */
export function scriptedRuntime(agent: DecisionAgent, opts: { passthrough?: boolean } = {}): LayaRuntime {
  return {
    async load() {
      return agent;
    },
    embedFnFromAgent() {
      return null;
    },
    async predictShortlist(_agent, state, questions, o) {
      const res = await agent.predict(state, questions);
      const shortlist: Record<string, { passthrough?: boolean }> = {};
      const labels = Object.keys((questions["act"]?.criteria as Record<string, unknown>) ?? {});
      const pass = opts.passthrough ?? labels.length <= (o?.k ?? 8);
      for (const key of Object.keys(questions)) shortlist[key] = { passthrough: pass };
      return { answers: res.answers, shortlist };
    },
  };
}
