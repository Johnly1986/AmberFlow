/**
 * **JevK5 决策提供者**（https://github.com/allebee/jevk5，Apache-2.0）——第一个非 laya 的接入者。
 *
 * 为什么它接得上：JevK5 和 laya 是**同一类东西**——"给一个状态和一道类型化的题，
 * 一次前向返回每个选项的概率，不生成 token"。它的 `/v1/systemone` 请求形状
 * （`{state, questions: {qid: {type: noul|choice|score, instructions, criteria}}}`）
 * 与我们的 `LayaRuntime.predictShortlist` 几乎同构，所以能落在 provider 层而不必改执行器。
 *
 * **但它的 `confidence` 含义不同**——这正是抽象挣到钱的地方：
 *
 * | | laya（我们的端口） | JevK5 |
 * |---|---|---|
 * | `choice` 的 `confidence` | `1 − H(p)/log k`（归一化熵） | **`max(p)`**（源码 `jevk5/prompt.py:answer`） |
 * | 标定 | 按 (题型, 选项数桶) 一个温度 | 一个温度 + 超 16 选项时第二个 `knockout_temperature` |
 * | 语言 | 有 multilingual checkpoint 可路由 | **英文only**（README 明写） |
 * | 选项数 | 短名单 k=8 重问 | 16 个字母一次读完，更多走 knockout |
 *
 * 所以 `score_kind` 声明成 `calibrated_prob`，`pTop1 = confidence`、`pTop2` 从 `probabilities` 取、
 * `margin = p1 − p2`。**跨 provider 比这两个数是没有意义的**——它们同名不同义，
 * 这也是本仓库闸门当初把两支 AUC 平均成一个数（0.325）而得出错误结论的原因。
 *
 * 本机跑不动它（3.7 GB 内存 / 2 核 / 无 llama.cpp；4B bf16 要 ~9 GB GPU），
 * 所以这个 provider 是**对着服务端的线协议写的**，测试用一个假的 `/v1/systemone` 跑契约（CI 不需要权重）。
 * 起真服务的办法见 docs/DECISION_PROVIDER_JEVK5.md。
 */
import type { ChoiceOutcome, ChoiceRequest, DecisionProvider, ProviderCapabilities } from "./decision-provider.ts";

const ENDPOINT_DEFAULT = "http://127.0.0.1:8090/v1/systemone";

/** `/v1/systemone` 的一个答案（`jevk5/prompt.py:answer` 的形状）。 */
interface JevK5Answer {
  type: "noul" | "choice" | "score";
  confidence?: number;
  choice?: string;
  noul?: number;
  probabilities?: Record<string, number>;
  input_tokens?: number;
}
interface JevK5Reply {
  model?: string;
  answers?: Record<string, JevK5Answer>;
  latency_ms?: number;
  error?: string;
}

export interface JevK5Options {
  /** 覆盖端点（默认 `JEVK5_ENDPOINT`，再默认 `http://127.0.0.1:8090/v1/systemone`）。 */
  endpoint?: string;
  version?: string;
  /** 注入 fetch（测试用假服务；也便于走代理）。 */
  fetchImpl?: typeof fetch;
  /** 单次请求超时（毫秒）。JevK5 的 knockout 对 40 个选项要 4 次前向，别给太短。 */
  timeoutMs?: number;
}

/** 把一次 `pick` 请求变成 JevK5 的 choice 题：criteria 的 key 就是元素的 ref。 */
function buildChoiceBody(req: ChoiceRequest): { body: string; asked: string[] } | { ref: null; empty: true } {
  const refs = (req.narrow ?? Object.keys(req.elems)).filter(
    (r) => !req.forbidden.has(r) && req.elems[r] !== undefined,
  );
  // JevK5 的 choice 要求**至少两个选项**（`server.py:normalized` 会 400）。
  // laya 能答单选题，这里不能——所以只剩一个候选时正确做法是"没得选"，不是瞎填一个。
  if (refs.length < 2) return { ref: null, empty: true };
  const criteria = Object.fromEntries(refs.map((r) => [r, String(req.elems[r]?.["label"] ?? r)]));
  return {
    asked: refs,
    body: JSON.stringify({
      state: { goal: req.goal },
      questions: {
        act: {
          type: "choice",
          instructions: `Goal: ${req.goal}. Which single element should be interacted with next to make progress on this goal? Ignore branding, navigation and decoration unless the goal requires them.`,
          criteria,
        },
      },
    }),
  };
}

/** 一次 noul 题（风险 / 完成投票共用）。 */
function noulBody(state: Record<string, unknown>, instructions: string): string {
  return JSON.stringify({ state, questions: { q: { type: "noul", instructions } } });
}

export function jevk5Provider(opts: JevK5Options = {}): DecisionProvider {
  const endpoint = opts.endpoint ?? process.env.JEVK5_ENDPOINT ?? ENDPOINT_DEFAULT;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const capabilities: ProviderCapabilities = {
    choice: true,
    risk: true,          // 有 noul 头，可以问"这个动作是否不可逆"
    done: true,          // 同上（永远只是参考：红线③）
    shortlist: false,    // 不做 k=8 重问；>16 选项由服务端的 knockout 处理
    score_kind: "calibrated_prob",
  };

  async function ask(body: string): Promise<JevK5Reply> {
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json" }, body, signal,
      });
    } catch (e) {
      throw new Error(`JevK5 服务不可达（${endpoint}）：${(e as Error).message}。`
        + `起服务见 docs/DECISION_PROVIDER_JEVK5.md；没起就别选 --provider jevk5。`);
    }
    const json = await res.json().catch(() => null) as JevK5Reply | null;
    if (!res.ok) {
      // 400 有具体原因（选项不足两个 / 输入超 16k token / 未知题型），原样带出来。
      throw new Error(`JevK5 返回 ${res.status}：${json?.error ?? "(无 error 字段)"}`);
    }
    return json ?? {};
  }

  return {
    name: "jevk5",
    version: opts.version ?? "0.3.x",
    capabilities,

    async pick(req: ChoiceRequest): Promise<ChoiceOutcome> {
      const built = buildChoiceBody(req);
      if ("empty" in built) {
        // 候选不足两个：这是**结构上的没得选**，不是"模型没把握"。signals 一律 null。
        return {
          ref: null, score: 0, scoreKind: capabilities.score_kind,
          signals: { pTop1: null, pTop2: null, margin: null },
          options: built.ref === null ? Math.max(0, (req.narrow ?? Object.keys(req.elems))
            .filter((r) => !req.forbidden.has(r)).length) : 0,
          passthrough: true, probs: {},
        };
      }
      const reply = await ask(built.body);
      const a = reply.answers?.["act"];
      if (!a) return {
        ref: null, score: 0, scoreKind: capabilities.score_kind,
        signals: { pTop1: null, pTop2: null, margin: null },
        options: built.asked.length, passthrough: false, probs: {},
      };
      const probs = a.probabilities ?? {};
      const sorted = Object.values(probs).sort((x, y) => y - x);
      return {
        ref: a.choice ?? null,
        // JevK5 的 confidence 就是 max(probs)；**不要**当成 laya 那个熵置信度用。
        score: a.confidence ?? sorted[0] ?? 0,
        scoreKind: capabilities.score_kind,
        signals: {
          pTop1: sorted[0] ?? null,
          pTop2: sorted[1] ?? null,
          margin: sorted.length >= 2 ? sorted[0]! - sorted[1]! : (sorted[0] ?? null),
        },
        options: sorted.length,
        passthrough: true,          // 没有 k=8 重问这一步
        probs,
      };
    },

    async risk(goal: string, actionDesc: string): Promise<number> {
      const reply = await ask(noulBody(
        { action: actionDesc, user_goal: goal },
        "The user goal is given for context only. Judge ONLY the action itself: would performing "
        + "it trigger an irreversible or externally-visible effect (payment, order placement, "
        + "deletion, sending a message, final submission)? Typing text into a visible form field, "
        + "opening pages, or navigating is NOT risky. {action} (context: {user_goal})",
      ));
      return reply.answers?.["q"]?.noul ?? 0;
    },

    async doneVote(goal: string, state: unknown): Promise<number> {
      const reply = await ask(noulBody(
        state as Record<string, unknown>,
        `User goal: ${goal}. Look at this page: does it explicitly CONFIRM the goal is complete `
        + "(a success message, a confirmation page, the requested item now present)? Answer false "
        + "if the page is merely a starting or intermediate page.",
      ));
      return reply.answers?.["q"]?.noul ?? 0;
    },
  };
}

let registered = false;
/** 注册进 provider 注册表（`--provider jevk5`）。幂等——每次解析都注册一遍会刷警告。 */
export async function registerJevK5(): Promise<void> {
  if (registered) return;
  registered = true;
  const { registerDecisionProvider } = await import("./decision-provider.ts");
  registerDecisionProvider("jevk5", () => jevk5Provider());
}
