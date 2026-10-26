/**
 * **OpenAI Decisions API 适配器**（`POST /v1/decisions`，2026 GA，当前唯一原生模型 `gpt-6-luna`）。
 *
 * 与 System One 的差异（这是两个协议，不是一种协议的两个方言）：
 *   - 题型叫 `predicate`（≈ noul）、`choice`、`score`；题目是**数组**（`name` 标识），不是 map；
 *   - 请求是 `input`（字符串或消息数组）+ `questions[]`；响应是 `answers[]`；
 *   - choice/score 的 `probabilities` 是**数组** `[{value, probability}]`，System One 是 map；
 *   - 显式的 `refusal` 答案：我们把它映射成"没答"（pick 返回 null），不拿它当低置信。
 *
 * 本文件只实现本项目用到的三种能力：pick（choice）/ risk（predicate）/ doneVote（predicate）/
 * askChoice（闭集 choice）。协议差异全部收在这里；执行器仍只认 `DecisionProvider`。
 */
import type {
  ChoiceOutcome, ChoiceRequest, ClosedSetChoice, ClosedSetRequest, DecisionProvider,
  ProviderCapabilities,
} from "./decision-provider.ts";
import { stateText, urlOf } from "../engine/extraction.ts";

const CAPABILITIES: ProviderCapabilities = {
  choice: true,
  risk: true,
  done: true,
  shortlist: false,
  score_kind: "calibrated_prob",
};

/** 当前 OpenAI 原生 Decisions 唯一的模型；留空时用它。 */
export const OPENAI_DECISIONS_DEFAULT_MODEL = "gpt-6-luna";

export interface OpenAIDecisionsOptions {
  /** 完整端点（已归一成 `…/v1/decisions`）。 */
  endpoint: string;
  model?: string;
  apiKey?: string;
  floor?: number;
  timeoutMs?: number;
  /** 解析期健康检查（缺地址/缺 key 等）；由统一配置层传入。 */
  configError?: () => string | null;
  fetchImpl?: typeof fetch;
}

/** OpenAI Decisions 端点归一化：host → `/v1/decisions`；`…/v1` → `…/v1/decisions`。 */
export function normalizeOpenAIDecisionsEndpoint(raw: string): string {
  const text = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  const url = new URL(withScheme);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`服务地址必须是 http(s) URL（收到 ${JSON.stringify(raw)}）`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(`服务地址不能带查询串/片段（收到 ${JSON.stringify(raw)}）`);
  }
  let pathname = url.pathname.replace(/\/+$/, "");
  if (!/\/decisions$/i.test(pathname)) {
    pathname = /\/v1$/i.test(pathname) ? `${pathname}/decisions` : `${pathname}/v1/decisions`;
  }
  url.pathname = pathname;
  return url.toString().replace(/\/$/, "");
}

type OpenAIDecisionType = "predicate" | "choice" | "score" | "refusal";
interface OpenAIDecisionAnswer {
  type?: OpenAIDecisionType;
  name?: string;
  choice?: string | boolean;
  probability?: number;
  score?: number;
  confidence?: number;
  probabilities?: Array<{ value?: string | number | boolean; label?: string; probability?: number }>;
}
interface OpenAIDecisionsReply {
  answers?: OpenAIDecisionAnswer[];
  usage?: { input_tokens?: number };
  error?: { message?: string; type?: string; code?: string } | string;
}

function errorText(reply: OpenAIDecisionsReply | null, status: number): string {
  const e = reply?.error;
  if (typeof e === "string" && e.trim()) return e.trim();
  if (e && typeof e === "object") {
    return [e.message, e.code, e.type].filter((x): x is string => typeof x === "string" && x.trim() !== "").join(" · ")
      || `(HTTP ${status})`;
  }
  return `(HTTP ${status}，无 error 字段)`;
}

function probRecord(answer: OpenAIDecisionAnswer | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of answer?.probabilities ?? []) {
    if (item.value === undefined) continue;
    if (typeof item.probability === "number") out[String(item.value)] = item.probability;
  }
  return out;
}

function outcomeFromChoice(
  answer: OpenAIDecisionAnswer | undefined, asked: string[], scoreKind: ProviderCapabilities["score_kind"],
): ChoiceOutcome {
  const probs = probRecord(answer);
  const sorted = Object.values(probs).sort((a, b) => b - a);
  const rawChoice = answer?.choice;
  const ref = typeof rawChoice === "string" && asked.includes(rawChoice) ? rawChoice : null;
  return {
    ref,
    score: answer?.confidence ?? sorted[0] ?? 0,
    scoreKind,
    signals: {
      pTop1: sorted[0] ?? null,
      pTop2: sorted[1] ?? null,
      margin: sorted.length >= 2 ? sorted[0]! - sorted[1]! : (sorted[0] ?? null),
    },
    options: sorted.length || asked.length,
    passthrough: true,
    probs,
  };
}

const emptyChoiceOutcome = (scoreKind: ProviderCapabilities["score_kind"], asked: number): ChoiceOutcome => ({
  ref: null, score: 0, scoreKind,
  signals: { pTop1: null, pTop2: null, margin: null },
  options: asked, passthrough: true, probs: {},
});

/** 把页面/目标压成 `input` 字符串（OpenAI Decisions 的 input 可以是字符串）。 */
async function pickInput(req: ChoiceRequest): Promise<string> {
  const parts = [`Goal: ${req.goal}`];
  try {
    const url = urlOf(req.page);
    if (url) parts.push(`URL: ${url}`);
  } catch { /* fake page 无 url */ }
  try {
    const title = await req.page.title();
    if (title) parts.push(`Title: ${title}`);
  } catch { /* 同上 */ }
  try {
    const text = await stateText(req.page, req.goal);
    if (text) parts.push(`Page:\n${text}`);
  } catch { /* fake page/死页：少正文 */ }
  return parts.join("\n");
}

/**
 * 一个 OpenAI Decisions 服务 → 一个 `DecisionProvider`。
 * 名字固定 `decision-service`（和 System One 的统一配置层共用 provider id），
 * 具体协议由统一配置的 `AMBERFLOW_DECISION_PROTOCOL` 决定。
 */
export function openaiDecisionsProvider(opts: OpenAIDecisionsOptions): DecisionProvider {
  const endpoint = opts.endpoint;
  const model = opts.model?.trim() || OPENAI_DECISIONS_DEFAULT_MODEL;
  const apiKey = opts.apiKey?.trim() ?? "";
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const doFetch = opts.fetchImpl ?? fetch;

  async function ask(input: string, questions: Array<Record<string, unknown>>): Promise<OpenAIDecisionsReply> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey !== "") headers.authorization = `Bearer ${apiKey}`;
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: "POST", headers,
        body: JSON.stringify({ model, input, questions }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`统一决策服务（OpenAI Decisions）不可达（${endpoint}）：`
        + `${(e as Error).message}。检查网络与 AMBERFLOW_DECISION_BASE_URL。`);
    }
    const json = (await res.json().catch(() => null)) as OpenAIDecisionsReply | null;
    if (!res.ok) throw new Error(`统一决策服务（OpenAI Decisions）返回 ${res.status}：${errorText(json, res.status)}`);
    return json ?? {};
  }

  async function predicate(state: string, instructions: string): Promise<number | null> {
    const reply = await ask(state, [{ type: "predicate", name: "q", instructions }]);
    const answer = reply.answers?.find((a) => a.name === "q");
    if (!answer || answer.type === "refusal") return null;
    return typeof answer.probability === "number" ? answer.probability : null;
  }

  return {
    name: "decision-service",
    version: model,
    capabilities: CAPABILITIES,
    ...(opts.floor === undefined ? {} : { floor: opts.floor }),
    ...(opts.configError === undefined ? {} : { configError: opts.configError }),

    async pick(req: ChoiceRequest): Promise<ChoiceOutcome> {
      const refs = (req.narrow ?? Object.keys(req.elems)).filter(
        (r) => !req.forbidden.has(r) && req.elems[r] !== undefined,
      );
      if (refs.length < 1) return emptyChoiceOutcome(CAPABILITIES.score_kind, refs.length);
      const reply = await ask(await pickInput(req), [{
        type: "choice",
        name: "act",
        instructions: `Goal: ${req.goal}. Which single element should be interacted with next `
          + "to make progress on this goal? Ignore branding, navigation and decoration unless the goal requires them.",
        choices: refs.map((ref) => ({
          value: ref,
          description: String(req.elems[ref]?.["label"] ?? ref),
        })),
      }]);
      const answer = reply.answers?.find((a) => a.name === "act");
      if (!answer || answer.type === "refusal") return emptyChoiceOutcome(CAPABILITIES.score_kind, refs.length);
      return outcomeFromChoice(answer, refs, CAPABILITIES.score_kind);
    },

    async askChoice(req: ClosedSetRequest): Promise<ClosedSetChoice | null> {
      const refs = Object.keys(req.criteria);
      if (refs.length < 1) return null;
      const reply = await ask(JSON.stringify({ ...(req.state ?? {}), goal: req.goal }), [{
        type: "choice", name: "act", instructions: req.instructions,
        choices: refs.map((ref) => ({ value: ref, description: req.criteria[ref] })),
      }]);
      const answer = reply.answers?.find((a) => a.name === "act");
      if (!answer || answer.type === "refusal") return null;
      const probs = probRecord(answer);
      const sorted = Object.values(probs).sort((a, b) => b - a);
      const choice = typeof answer.choice === "string" && refs.includes(answer.choice) ? answer.choice : null;
      return {
        ref: choice,
        score: answer.confidence ?? sorted[0] ?? 0,
        scoreKind: CAPABILITIES.score_kind,
        probs,
      };
    },

    risk: async (goal: string, actionDesc: string) => {
      const p = await predicate(
        JSON.stringify({ action: actionDesc, user_goal: goal }),
        "Judge ONLY the action itself: would performing it trigger an irreversible or externally-visible "
        + "effect (payment, order placement, deletion, sending a message, final submission)? "
        + "Typing into a form field, opening pages, or navigating is NOT risky.",
      );
      if (p === null) throw new Error("统一决策服务（OpenAI Decisions）拒绝回答风险题（refusal）");
      return p;
    },

    doneVote: async (goal: string, state: unknown) => {
      const p = await predicate(
        typeof state === "string" ? state : JSON.stringify(state),
        `User goal: ${goal}. Does this page explicitly CONFIRM the goal is complete `
        + "(a success message, a confirmation page, the requested item now present)? Answer false if it is "
        + "merely a starting or intermediate page.",
      );
      return p ?? 0;
    },
  };
}
