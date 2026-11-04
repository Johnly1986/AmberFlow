/**
 * **SystemOne 客户端**——本项目对决策服务的全部知识。
 *
 * laya、JevK5、百炼 decision-model-preview 说的是同一种协议（TypeSafe System One）：
 *   请求 `{ [extra...], state, questions: { qid: { type: choice|noul|score, instructions, criteria } } }`
 *   响应 `{ answers: { qid: { type, choice|noul|score, confidence?, probabilities? } }, usage?, latency_ms? }`
 * 一次前向、返回概率分布与置信度、**不生成文本**。模型加载、checkpoint 路由、shortlist 重问、
 * 温度标定、多语言权重——**全是服务侧的事**，本项目只做这一层适配。
 *
 * 所以这里只有**一份**线协议实现；服务之间的差异（认证、model 字段、选项下限、池外答案是否拒绝、
 * 提示词、错误指路串）全部走 `SystemOneProfile`。加一个 SystemOne 服务 = 给一份 profile，不写新适配器。
 *
 * 抽象的判据是"同一份考卷"：历史回归 与 历史回归
 * 各自钉住自己 provider 的线协议映射，Stage 1 把它们重写到本客户端上时**一字不改仍全绿**——
 * 这保证"抽取"没有偷改行为。
 */
import type {
  ChoiceOutcome, ChoiceRequest, ClosedSetChoice, ClosedSetRequest, DecisionProvider, ProviderCapabilities,
} from "./decision-provider.ts";

/** SystemOne 的一个答案（choice/noul/score 共用一个形状，字段按类型出现）。 */
export interface SystemOneAnswer {
  type?: "choice" | "noul" | "score";
  choice?: string;
  noul?: number;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}
export interface SystemOneReply {
  answers?: Record<string, SystemOneAnswer>;
  usage?: { input_tokens?: number };
  latency_ms?: number;
  // 错误体形状各家不同：可能是字符串，也可能是嵌套对象（实测百炼 429 返回 `{"error":{...}}`）。
  code?: unknown;
  message?: unknown;
  error?: unknown;
}

export interface SystemOneProfile {
  /** provider id（注册表用，如 "bailian"）。 */
  name: string;
  version: string;
  /** 错误串里的显示名（如 "百炼决策模型" / "JevK5"）。 */
  label: string;
  capabilities: ProviderCapabilities;
  /** 解析端点；返回 null = 未配置（客户端抛 endpointHint 指路）。每次调用现读，便于测试注入。 */
  resolveEndpoint(): string | null;
  /** 端点缺失时的指路串。 */
  endpointHint: string;
  /** 认证 token（返回串→`Authorization: Bearer <串>`；抛错=缺凭据自报指路；undefined=不发认证头）。 */
  resolveAuth?(): string;
  /** 每个请求都带的额外字段（如百炼的 `{model:"decision-model-preview"}`；JevK5 给 `{}`）。 */
  extraBody(): Record<string, unknown>;
  /** choice 的选项下限；候选数不足则**不发请求**、直接"结构上没得选"（JevK5=2，百炼=1）。 */
  minOptions: number;
  /** 池外答案（如 other）是否拒绝为 null（百炼 true；JevK5 信任服务端 false）。 */
  validateChoiceInPool: boolean;
  /** 三段的提示词（各家措辞不同，会影响模型行为，故由 profile 提供、不在客户端硬编码）。 */
  choiceInstructions(goal: string): string;
  /**
   * choice 题的 `state` 构造（可异步读页面：url/标题/正文窗口）。
   * 缺省不声明 ⇒ `{goal}` 逐字节照旧（默认等价纪律；jevk5/bailian 今天就是这形状）。
   * 存在的理由（2026-10-20 实测）：token-plan 的 choice conf 0.03、风险票 0.47——而它
   * 被问时**看不见页面**（state 只有 goal、criteria 只有 label）。本地 laya 分支从来带
   * `url/title/main_text`（decision-provider.ts 的 layaProvider.pick）——同一个决策问题，
   * 两条分支的信息量不该不对称；"pool 是模型的全世界"这条认识论同样适用于观察侧。
   * 服务端把 state 当不透明包（risk/done 题的 `{action, user_goal}` 已被同一网关接受）。
   */
  stateBuilder?(req: ChoiceRequest): Promise<Record<string, unknown>>;
  /**
   * S5b：是否接受结构化 `state_digest`（缺省 false = 执行器整段跳过并记 `context_skipped`）。
   * SystemOne 的 `state` 本来就是不透明包（risk/done 的 `{action,user_goal}` 同一条通道），
   * 所以支持的服务只是多一个可选键：`state.state_digest = {...}`，无协议版本字段可升，
   * 老服务忽略未知键即向后兼容。
   */
  stateDigest?: boolean;
  riskInstructions(goal: string, actionDesc: string): string;
  doneInstructions(goal: string): string;
  /** 服务不可达时的指路串。 */
  unreachableHint: string;
  /** 是否已配置到可用（缺凭据/端点→一句指路串；就绪→null）。供 resolveProviderSpec 解析时判定显式/默认。 */
  configError?(): string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * 从错误体抽一句人读的原因——对象字段先挖 .message/.code，再兜底 stringify，绝不 [object Object]。
 * A3（2026-11-02 实测 token-plan 403）：`.code`（AccessDenied.Unpurchased）与 `.message`（人话）
 * 是两句话，message-first 的旧口径会把可检索的 machine code 整个丢掉——负路径排查靠的就是
 * 这个 code。现在 code 与人话并排透出；非 JSON 错误体（网关 HTML/纯文本兜底页）也把原文
 * 关键句带回来，不再输出「(HTTP 403，无 error 字段)」这种没内容的行。
 * 密钥纪律：这里只碰**响应体**与状态码——请求头（Authorization）永不进入错误文本。
 */
export function systemOneErrorText(json: SystemOneReply, status: number, rawBody = ""): string {
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
  const code = pick(json.code) ?? pick((json.error as Record<string, unknown> | undefined)?.code) ?? "";
  let text = pick(json.message) ?? pick(json.error) ?? pick(json.code)
    ?? (rawBody.trim() ? rawBody.trim().slice(0, 200) : `(HTTP ${status}，无 error 字段)`);
  if (code !== "" && !text.includes(code)) text = `${code}：${text}`;
  return text.slice(0, 200);
}

/** Node 的 fetch 网络失败把真话放在 `cause` 链里（getaddrinfo ENOTFOUND / ECONNREFUSED /
 *  TimeoutError）——只透出顶层 "fetch failed" 等于没说。沿 cause 走到底，把每层 message
 *  拼成一行（有深度上限，防循环引用）；首层带 Error.name（TimeoutError 这类机器可查的名字）。 */
function netErrorText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; depth < 4; depth++) {
    if (!(cur instanceof Error)) {
      if (typeof cur === "string" && cur.trim()) parts.push(cur.trim());
      break;
    }
    const m = cur.message.trim();
    const withName = cur.name && cur.name !== "Error" ? `${cur.name}: ${m}` : m;
    if (withName && !parts.includes(withName)) parts.push(withName);
    cur = cur.cause;
    if (cur === undefined || cur === null) break;
  }
  return (parts.length ? parts.join(" ← ") : "未知网络错误").slice(0, 200);
}

/** 把一次 pick 请求组装成 SystemOne 的 choice 题；候选不足下限则返回 empty。
 *  async 只为 `stateBuilder` 读页面而存在；profile 不带 builder 时是纯同步形状 `{goal}`。 */
async function buildChoiceBody(p: SystemOneProfile, req: ChoiceRequest):
  Promise<{ body: object; asked: string[] } | { empty: true; asked: number }> {
  const refs = (req.narrow ?? Object.keys(req.elems)).filter(
    (r) => !req.forbidden.has(r) && req.elems[r] !== undefined,
  );
  if (refs.length < p.minOptions) return { empty: true, asked: refs.length };
  const criteria = Object.fromEntries(refs.map((r) => [r, String(req.elems[r]?.["label"] ?? r)]));
  const state = p.stateBuilder ? await p.stateBuilder(req) : { goal: req.goal };
  // S5b：结构化状态摘要挂在 state 包内的可选键上（不并入正文、不改 questions、不发明协议字段）。
  // 只有 profile 声明 stateDigest 才会走到这里；执行器端已按能力过滤，双保险。
  if (req.state_digest !== undefined && p.stateDigest === true) {
    state["state_digest"] = req.state_digest;
  }
  return {
    asked: refs,
    body: {
      ...p.extraBody(),
      state,
      questions: { act: { type: "choice", instructions: p.choiceInstructions(req.goal), criteria } },
    },
  };
}

const emptyOutcome = (scoreKind: ProviderCapabilities["score_kind"], asked: number): ChoiceOutcome => ({
  // 候选不足下限：结构上的没得选，不是"模型没把握"——signals 一律 null。
  ref: null, score: 0, scoreKind,
  signals: { pTop1: null, pTop2: null, margin: null },
  options: asked, passthrough: true, probs: {},
});

/** 一个 SystemOne 服务 → 一个 DecisionProvider。这是本项目对决策服务的全部适配。 */
export function systemOneClient(p: SystemOneProfile): DecisionProvider {
  const doFetch = p.fetchImpl ?? fetch;
  const timeoutMs = p.timeoutMs ?? 30_000;

  async function ask(body: object): Promise<SystemOneReply> {
    const url = p.resolveEndpoint();
    if (!url) throw new Error(`${p.label} 缺端点：${p.endpointHint}`);
    // 认证在 fetch 之前解析：缺 key 时不该去敲门（测试据此断言"根本没发请求"）。
    const auth = p.resolveAuth?.();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth) headers.authorization = `Bearer ${auth}`;
    let res: Response;
    try {
      res = await doFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      // A3：网络层失败（DNS/拒连/超时）把 cause 链里的真话带出去，不再只有笼统的 "fetch failed"。
      throw new Error(`${p.label} 服务不可达（${url}）：${netErrorText(e)}。${p.unreachableHint}`);
    }
    // A3：响应体先按文本读一次再解析——非 JSON 的 2xx 不再静默变成"没答/低分"
    // （那是把基础设施故障伪装成模型意见），非 JSON 的错误体原文也能进错误消息。
    const raw = await res.text().catch(() => "");
    let json: SystemOneReply | null = null;
    try { json = raw === "" ? null : (JSON.parse(raw) as SystemOneReply); } catch { /* 非 JSON：走下方透传 */ }
    if (!res.ok) throw new Error(`${p.label} 返回 ${res.status}：${systemOneErrorText(json ?? {}, res.status, raw)}`);
    if (json === null) {
      throw new Error(`${p.label} 返回 ${res.status}，但响应体不是 JSON：${raw.trim().slice(0, 200) || "（空 body）"}`);
    }
    return json;
  }

  async function noul(state: object, instructions: string): Promise<number> {
    const reply = await ask({ ...p.extraBody(), state, questions: { q: { type: "noul", instructions } } });
    return reply.answers?.["q"]?.noul ?? 0;
  }

  return {
    name: p.name,
    version: p.version,
    // S5b：能力与 profile 的声明一致——profile 不收 digest 时，执行器看到的就是"不支持"。
    capabilities: p.stateDigest === true ? { ...p.capabilities, state_digest: true } : p.capabilities,
    ...(p.configError ? { configError: () => p.configError!() } : {}),

    async pick(req: ChoiceRequest): Promise<ChoiceOutcome> {
      const built = await buildChoiceBody(p, req);
      if ("empty" in built) return emptyOutcome(p.capabilities.score_kind, built.asked);
      const reply = await ask(built.body);
      const a = reply.answers?.["act"];
      if (!a) return {
        ref: null, score: 0, scoreKind: p.capabilities.score_kind,
        signals: { pTop1: null, pTop2: null, margin: null },
        options: built.asked.length, passthrough: false, probs: {},
      };
      const probs = a.probabilities ?? {};
      const sorted = Object.values(probs).sort((x, y) => y - x);
      const chosen = a.choice
        && (!p.validateChoiceInPool || built.asked.includes(a.choice)) ? a.choice : null;
      return {
        ref: chosen,
        // score 一律读 confidence（三家代码路径一致）；缺则退回 max(prob)。含义由 score_kind 声明。
        score: a.confidence ?? sorted[0] ?? 0,
        scoreKind: p.capabilities.score_kind,
        signals: {
          pTop1: sorted[0] ?? null,
          pTop2: sorted[1] ?? null,
          margin: sorted.length >= 2 ? sorted[0]! - sorted[1]! : (sorted[0] ?? null),
        },
        options: sorted.length || built.asked.length,
        passthrough: true,          // 客户端不问子集；收窄/shortlist 是服务侧的事
        probs,
      };
    },

    async askChoice(req: ClosedSetRequest): Promise<ClosedSetChoice | null> {
      const refs = Object.keys(req.criteria);
      // 与 pick 同一条候选下限：结构上没得选就不发请求（JevK5 会 400）。
      if (refs.length < p.minOptions) return null;
      const reply = await ask({
        ...p.extraBody(),
        state: { ...(req.state ?? {}), goal: req.goal },
        questions: { act: { type: "choice", instructions: req.instructions, criteria: req.criteria } },
      });
      const a = reply.answers?.["act"];
      if (!a) return null;
      const probs = a.probabilities ?? {};
      const sorted = Object.values(probs).sort((x, y) => y - x);
      const ref = typeof a.choice === "string"
        && (!p.validateChoiceInPool || refs.includes(a.choice)) ? a.choice : null;
      return {
        ref,
        score: a.confidence ?? sorted[0] ?? 0,
        scoreKind: p.capabilities.score_kind,
        probs,
      };
    },

    risk: p.capabilities.risk
      ? async (goal: string, actionDesc: string) => noul({ action: actionDesc, user_goal: goal }, p.riskInstructions(goal, actionDesc))
      : undefined,

    doneVote: p.capabilities.done
      ? async (goal: string, state: unknown) => noul(state as object, p.doneInstructions(goal))
      : undefined,
  };
}
