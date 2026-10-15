/**
 * **阿里百炼（Model Studio / DashScope）决策模型 provider** —— `decision-model-preview`。
 *
 * 为什么它接得上、且不改执行器：百炼的决策模型走的是 **TypeSafe System One** 协议
 * （`POST /compatible-mode/v1/systemone`），请求 `{model, state, questions:{qid:{type:
 * choice|noul|score, instructions, criteria}}}`、响应 `{answers:{qid:{choice|noul|score,
 * confidence, probabilities}}}`——一次前向返回概率分布与置信度、**不生成文本**。这与
 * JevK5 的 `/v1/systemone`、与我们 `LayaRuntime.predictShortlist` 是同一类形状，所以能
 * 落在 provider 层（见 `decision-provider.ts`），执行循环零改动。
 * API 契约：https://help.aliyun.com/zh/model-studio/decision-model-api
 *
 * 三处与 JevK5 的关键差异（都在这份适配里处理）：
 *   1. **认证**：`Authorization: Bearer $DASHSCOPE_API_KEY`。token **只从环境变量按名读取**，
 *      绝不写进代码、产物或提交（凭据不进被审计的东西里——这是仓库既有的硬规矩）。
 *   2. **`confidence` ≠ `max(probabilities)`**：官方示例里 choice 的 confidence=0.88 而
 *      max(prob)=0.94——它是**独立标定的把握数**，不是分布的最大值（JevK5 里两者相等）。
 *      所以 `score = confidence`（provider 自己的"把握"），`pTop1/pTop2/margin` 从
 *      `probabilities` 取；`score_kind = "calibrated_prob"`。跨 provider 比这些数无意义。
 *   3. **`choice` 支持 1–255 项**（JevK5 要求 ≥2）：所以单候选也能问；只有 0 候选才是
 *      "结构上没得选"。返回的 choice 不在本次问过的 ref 里（比如模型给了 `other`）⇒ 当作
 *      没答（ref=null），不拿它去点一个不存在的元素。
 *
 * 端点是 workspace 作用域的（`https://{WorkspaceId}.{region}.maas.aliyuncs.com/...`），
 * 没有免 workspace 的公共端点，所以 `BAILIAN_ENDPOINT`（全 URL）或
 * `BAILIAN_WORKSPACE_ID`(+`BAILIAN_REGION`，默认 cn-beijing) 必须给一个。
 * 注册不需要 key/端点（doctor 能列出它）；真调用缺 key/端点时**报错指路**，不静默退回。
 */
import type { ChoiceOutcome, ChoiceRequest, DecisionProvider, ProviderCapabilities } from "./decision-provider.ts";

const MODEL_DEFAULT = "decision-model-preview";
const REGION_DEFAULT = "cn-beijing";

/** 百炼 systemone 的一个答案。 */
interface BailianAnswer {
  type?: "choice" | "noul" | "score";
  choice?: string;
  noul?: number;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}
interface BailianReply {
  model?: string;
  request_id?: string;
  answers?: Record<string, BailianAnswer>;
  usage?: { input_tokens?: number };
  latency_ms?: number;
  // 错误体形状官方未固定：429/401 的 message/error/code 可能是**字符串，也可能是对象**
  // （实测 429 返回 `{"error":{"code":..,"message":..}}`）。用 unknown，交给 errorText 抽可读串。
  code?: unknown;
  message?: unknown;
  error?: unknown;
}

/** 从错误体里抽一句人读的原因——对象字段要展开，绝不 [object Object]（实测踩过 429）。 */
function errorText(json: BailianReply, status: number): string {
  const pick = (v: unknown): string | null => {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const inner = o.message ?? o.code;
      if (typeof inner === "string" && inner.trim()) return inner.trim();
      return JSON.stringify(v);
    }
    return null;
  };
  return pick(json.message) ?? pick(json.error) ?? pick(json.code) ?? `(HTTP ${status}，无 error 字段)`;
}

export interface BailianOptions {
  /** 完整端点；默认 `BAILIAN_ENDPOINT`，否则由 workspace+region 拼。 */
  endpoint?: string;
  /** API key；默认按名读 `DASHSCOPE_API_KEY`（回退 `BAILIAN_API_KEY`）。绝不内联。 */
  apiKey?: string;
  model?: string;
  region?: string;
  workspaceId?: string;
  version?: string;
  /** 注入 fetch（测试用假服务；也便于走代理）。 */
  fetchImpl?: typeof fetch;
  /** 单次请求超时（毫秒）。 */
  timeoutMs?: number;
}

/** 解析端点：显式 > BAILIAN_ENDPOINT > workspace+region 拼。缺则 null（调用时再报错指路）。 */
function resolveEndpoint(o: BailianOptions, env: NodeJS.ProcessEnv): string | null {
  if (o.endpoint) return o.endpoint;
  if (env.BAILIAN_ENDPOINT) return env.BAILIAN_ENDPOINT;
  const ws = o.workspaceId ?? env.BAILIAN_WORKSPACE_ID;
  if (ws) {
    const region = o.region ?? env.BAILIAN_REGION ?? REGION_DEFAULT;
    return `https://${ws}.${region}.maas.aliyuncs.com/compatible-mode/v1/systemone`;
  }
  return null;
}

/** choice 请求：criteria 的 key 就是元素 ref（与 JevK5 同一约定）。0 候选 = 没得选。 */
function buildChoiceBody(model: string, req: ChoiceRequest):
  { body: object; asked: string[] } | { empty: true } {
  const refs = (req.narrow ?? Object.keys(req.elems)).filter(
    (r) => !req.forbidden.has(r) && req.elems[r] !== undefined,
  );
  if (refs.length === 0) return { empty: true };
  const criteria = Object.fromEntries(refs.map((r) => [r, String(req.elems[r]?.["label"] ?? r)]));
  return {
    asked: refs,
    body: {
      model,
      state: { goal: req.goal },
      questions: {
        act: {
          type: "choice",
          instructions: `Goal: ${req.goal}. Which single element should be interacted with next to make progress on this goal? Ignore branding, navigation and decoration unless the goal requires them.`,
          criteria,
        },
      },
    },
  };
}

function noulBody(model: string, state: object, instructions: string): object {
  return { model, state, questions: { q: { type: "noul", instructions } } };
}

export function bailianProvider(opts: BailianOptions = {}): DecisionProvider {
  const env = process.env;
  const endpoint = opts.endpoint ?? resolveEndpoint(opts, env);
  const model = opts.model ?? env.BAILIAN_MODEL ?? MODEL_DEFAULT;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const capabilities: ProviderCapabilities = {
    choice: true,
    risk: true,          // 有 noul 头，可问"这个动作是否不可逆"
    done: true,          // 同上（永远只是参考：红线③）
    shortlist: false,    // 不做 k=8 重问；choice 一次给全量（≤255）
    score_kind: "calibrated_prob",
  };

  // key 每次调用现读（不缓存进闭包）：这样测试可临时注入、也不会有"进程启动时没配、
  // 之后配了却读不到"的坑。缺 key 是**用法错误**，不是"模型没把握"。
  function requireAuth(): string {
    const key = opts.apiKey ?? env.DASHSCOPE_API_KEY ?? env.BAILIAN_API_KEY ?? "";
    if (!key.trim()) {
      throw new Error("百炼决策模型缺 API key：设环境变量 DASHSCOPE_API_KEY（或 BAILIAN_API_KEY）。"
        + "token 只从环境读，绝不写进代码/产物/提交。");
    }
    return key.trim();
  }
  function requireEndpoint(): string {
    if (!endpoint) {
      throw new Error("百炼决策模型缺端点：设 BAILIAN_ENDPOINT（全 URL），或 BAILIAN_WORKSPACE_ID"
        + `（+可选 BAILIAN_REGION，默认 ${REGION_DEFAULT}）。端点是 workspace 作用域的，`
        + "起法与契约见 docs/DECISION_PROVIDER_BAILIAN.md");
    }
    return endpoint;
  }

  async function ask(body: object): Promise<BailianReply> {
    const url = requireEndpoint();
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${requireAuth()}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      throw new Error(`百炼决策模型服务不可达（${url}）：${(e as Error).message}。`
        + "检查网络/端点/workspace id；没配好就别选 --provider bailian。");
    }
    const json = await res.json().catch(() => null) as BailianReply | null;
    if (!res.ok) {
      // 401/403（key 无效）、400（选项/输入超限）、429（限流）都带原因，原样带出来。
      throw new Error(`百炼决策模型返回 ${res.status}：${errorText(json ?? {}, res.status)}`);
    }
    return json ?? {};
  }

  return {
    name: "bailian",
    version: opts.version ?? model,
    capabilities,

    async pick(req: ChoiceRequest): Promise<ChoiceOutcome> {
      const built = buildChoiceBody(model, req);
      if ("empty" in built) {
        // 0 候选：结构上的没得选，不是"模型没把握"——signals 一律 null。
        return {
          ref: null, score: 0, scoreKind: capabilities.score_kind,
          signals: { pTop1: null, pTop2: null, margin: null },
          options: 0, passthrough: true, probs: {},
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
      // 只认本次问过、且没被禁的 ref；模型给了 `other` 等池外答案 = 没答（不拿它点一个不存在的元素）。
      const chosen = a.choice && built.asked.includes(a.choice) ? a.choice : null;
      return {
        ref: chosen,
        // 百炼的 confidence 是独立标定值（示例里 ≠ max prob）；它就是 provider 的"把握"数。
        score: a.confidence ?? sorted[0] ?? 0,
        scoreKind: capabilities.score_kind,
        signals: {
          pTop1: sorted[0] ?? null,
          pTop2: sorted[1] ?? null,
          margin: sorted.length >= 2 ? sorted[0]! - sorted[1]! : (sorted[0] ?? null),
        },
        options: sorted.length || built.asked.length,
        passthrough: true,          // 没有 k=8 重问这一步
        probs,
      };
    },

    async risk(goal: string, actionDesc: string): Promise<number> {
      const reply = await ask(noulBody(model,
        { action: actionDesc, user_goal: goal },
        "Judge ONLY the action itself: would performing it trigger an irreversible or "
        + "externally-visible effect (payment, order placement, deletion, sending a message, "
        + "final submission)? Typing into a form field, opening pages, or navigating is NOT risky.",
      ));
      return reply.answers?.["q"]?.noul ?? 0;
    },

    async doneVote(goal: string, state: unknown): Promise<number> {
      const reply = await ask(noulBody(model,
        state as object,
        `User goal: ${goal}. Does this page explicitly CONFIRM the goal is complete (a success `
        + "message, a confirmation page, the requested item now present)? Answer false if it is "
        + "merely a starting or intermediate page.",
      ));
      return reply.answers?.["q"]?.noul ?? 0;
    },
  };
}

let registered = false;
/** 注册进 provider 注册表（`--provider bailian`）。幂等。 */
export async function registerBailian(): Promise<void> {
  if (registered) return;
  registered = true;
  const { registerDecisionProvider } = await import("./decision-provider.ts");
  registerDecisionProvider("bailian", () => bailianProvider());
}
