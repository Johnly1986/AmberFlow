/**
 * **token-plan MaaS 网关的决策模型 provider** —— `decision-model-preview`（SystemOne 线协议）。
 *
 * 端点：阿里云 MaaS 的**共享网关**（不是 workspace 作用域），`<base>/systemone` 上跑的是
 * `decision-model-preview`，与百炼 workspace 端点**同一种协议**；同一个 base 上还挂着 OpenAI
 * 兼容的 chat 模型（qwen3.x / glm-5.x / deepseek-v4.x，`/chat/completions`）——那是 SystemTwo
 * （规划/审计/老师）的通道，不归本 provider 管。
 * **端点只从环境读（`TOKEN_PLAN_ENDPOINT`）**：共享层的"外部主机不许写死"纪律（apps:matrix 的
 * 泄漏门禁）与 LLM 的 `OPENAI_BASE_URL` 同一条——完整 URL 见 docs/DECISION_PROVIDER_TOKENPLAN.md。
 *
 * 2026-10-15 实测（`POST …/compatible-mode/v1/systemone`，token 只从环境读）：
 *   - choice 3 选项：`{answers:{act:{type:"choice",choice,confidence:0.97,probabilities:{e1:0.98,e2:0.02,e3:0}}}}`
 *     —— **confidence(0.97) ≠ max(prob)(0.98)**，与百炼同族标定语义（score 取 confidence，
 *     pTop1/pTop2/margin 取分布，score_kind=calibrated_prob）；
 *   - **单候选可问**（1 项 OK；0 项才 400 `criteria` 非空）⇒ `minOptions=1`；
 *   - noul 问句（风险/完成票）返回 `{type:"noul",noul:0.07}`；
 *   - 池外答案与百炼同族：`validateChoiceInPool=true`（不拿池外 ref 去点元素）；
 *   - 错误带机器可读 code：401 `invalid_api_key` / 404 `model_not_found` / 400 `InvalidParameter`。
 *
 * 凭据纪律：`Authorization: Bearer $TOKEN_PLAN_API_KEY`（回退 `DASHSCOPE_API_KEY`）——
 * **只从环境按名读，绝不内联**；缺 key 时显式点名 ⇒ 响亮报错，环境默认档 ⇒ 干净落 rules-only。
 */
import type { DecisionProvider, ProviderCapabilities } from "./decision-provider.ts";
import { systemOneClient, type SystemOneProfile } from "./system-one-client.ts";

const MODEL_DEFAULT = "decision-model-preview";

export interface TokenPlanOptions {
  /** 完整端点（要带 `/…/v1/systemone`）；默认 `TOKEN_PLAN_ENDPOINT` 或内建默认。 */
  endpoint?: string;
  /** API key；默认按名读 `TOKEN_PLAN_API_KEY`（回退 `DASHSCOPE_API_KEY`）。绝不内联。 */
  apiKey?: string;
  model?: string;
  version?: string;
  /** 注入 fetch（测试用假服务；也便于走代理）。 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const CAPABILITIES: ProviderCapabilities = {
  choice: true, risk: true, done: true, shortlist: false, score_kind: "calibrated_prob",
};

/**
 * 自报闸门刻度（`ProviderInfo.floor`）：**实测边界** 2026-10-15 —— camera-entry（hintless 包）
 * 上模型对某个元素的把握是 0.20，在全局缺省 0.25 下被硬阻塞；floor≤0.20 即恢复 4/4 且不变量全绿
 * （0.20/0.15/0.10 三档同形，松闸没带来错点——每步仍由该步信号裁决）。
 * **边界**：这是单包单点测出来的刻度，不是普适校准；包可用 `policy.conf_floor` 覆盖、CLI 可本次覆盖。
 * 见 docs/DECISION_PROVIDER_TOKENPLAN.md §闸门刻度。
 */
const SUGGESTED_FLOOR = 0.2;

export function tokenPlanProvider(opts: TokenPlanOptions = {}): DecisionProvider {
  const env = process.env;
  const model = opts.model ?? env.TOKEN_PLAN_MODEL ?? MODEL_DEFAULT;
  const keyOf = (): string =>
    (opts.apiKey ?? env.TOKEN_PLAN_API_KEY ?? env.DASHSCOPE_API_KEY ?? "").trim();
  const profile: SystemOneProfile = {
    name: "token-plan",
    version: opts.version ?? model,
    label: "token-plan 决策模型",
    capabilities: CAPABILITIES,
    resolveEndpoint() {
      return opts.endpoint ?? env.TOKEN_PLAN_ENDPOINT ?? null;
    },
    endpointHint: "设 TOKEN_PLAN_ENDPOINT（完整 URL，要带 …/compatible-mode/v1/systemone；"
      + "共享层的泄漏门禁不许把外部主机写进代码/默认值）。完整示例见 docs/DECISION_PROVIDER_TOKENPLAN.md",
    // key 每次现读（不缓存进闭包）：测试可临时注入，也没有"启动时没配、之后配了读不到"的坑。
    resolveAuth() {
      const key = keyOf();
      if (!key) {
        throw new Error("缺 API key：设环境变量 TOKEN_PLAN_API_KEY（或 DASHSCOPE_API_KEY）。"
          + "token 只从环境读，绝不写进代码/产物/提交。");
      }
      return key;
    },
    configError() {
      const missing: string[] = [];
      if (!keyOf()) missing.push("API key（TOKEN_PLAN_API_KEY 或 DASHSCOPE_API_KEY）");
      const ep = opts.endpoint ?? env.TOKEN_PLAN_ENDPOINT ?? "";
      if (!ep) missing.push("端点（TOKEN_PLAN_ENDPOINT，完整 URL）");
      // 形状错误同样属于启动期就能判定的配置错误（实测 2026-10-20：endpoint 抄到 /v1 为止、
      // 少了 /systemone 后缀 ⇒ 网关 400 "url error"，风险闸门悄悄退化成关键词规则——
      // 那是一次**不正常**的闸门运行，不该等跑到一半才由退化警告说明）。
      else if (!/\/systemone\/?$/.test(ep)) {
        const extra = missing.length ? `；另缺 ${missing.join(" 与 ")}` : "";
        return `TOKEN_PLAN_ENDPOINT=${JSON.stringify(ep)} 不是 SystemOne 的完整 URL——`
          + "要以 /compatible-mode/v1/systemone 结尾（POST 到 /v1 或 chat 路径，网关回 400 url error）。"
          + "完整形状见 docs/DECISION_PROVIDER_TOKENPLAN.md" + extra;
      }
      return missing.length ? `缺 ${missing.join(" 与 ")}` : null;
    },
    extraBody: () => ({ model }),
    minOptions: 1,
    validateChoiceInPool: true,
    // 问法与百炼同族（同一 decision-model-preview 后端；措辞是实测过的那套）。
    choiceInstructions: (goal) => `Goal: ${goal}. Which single element should be interacted with next `
      + "to make progress on this goal? Ignore branding, navigation and decoration unless the goal requires them.",
    riskInstructions: () => "Judge ONLY the action itself: would performing it trigger an irreversible or "
      + "externally-visible effect (payment, order placement, deletion, sending a message, final submission)? "
      + "Typing into a form field, opening pages, or navigating is NOT risky.",
    doneInstructions: (goal) => `User goal: ${goal}. Does this page explicitly CONFIRM the goal is complete `
      + "(a success message, a confirmation page, the requested item now present)? Answer false if it is "
      + "merely a starting or intermediate page.",
    unreachableHint: "检查网络与 TOKEN_PLAN_ENDPOINT；token 只从环境读：TOKEN_PLAN_API_KEY。",
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  };
  return { ...systemOneClient(profile), floor: SUGGESTED_FLOOR };
}

let registered = false;
/** 注册进 provider 注册表（`--provider token-plan`）。幂等。 */
export async function registerTokenPlan(): Promise<void> {
  if (registered) return;
  registered = true;
  const { registerDecisionProvider } = await import("./decision-provider.ts");
  registerDecisionProvider("token-plan", () => tokenPlanProvider());
}
