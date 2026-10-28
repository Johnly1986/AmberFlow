/**
 * **JevK5 决策提供者**（https://github.com/allebee/jevk5，Apache-2.0）——`systemOneClient` 的一份 profile。
 *
 * JevK5 与 laya/百炼是**同一类东西**：给一个状态和一道类型化的题，一次前向返回每个选项的概率，
 * 不生成 token。它的 `/v1/systemone` 就是 System One 协议，所以本项目只做这一层适配
 * ，模型加载/推理在服务侧。
 *
 * profile 吸收的 JevK5 特有差异（与百炼不同处，实测钉在 历史回归）：
 *   - 无认证、body 不带 `model` 字段；
 *   - choice 要求**至少两个选项**（`server.py:normalized` 会 400）⇒ minOptions=2，单候选不发请求；
 *   - 信任服务端返回的 choice（validateChoiceInPool=false）；
 *   - `confidence` 就是 `max(probs)`（`jevk5/prompt.py:answer`）——score 读 confidence，
 *     pTop1/pTop2/margin 从 probabilities 取；score_kind=calibrated_prob。
 *
 * 本机跑不动它（4B bf16 要 ~9GB GPU），所以对着服务端线协议写，契约测试用假 `/v1/systemone`（CI 不需权重）。
 * 起真服务见 docs/DECISION_PROVIDER_JEVK5.md。
 */
import type { DecisionProvider, ProviderCapabilities } from "./decision-provider.ts";
import { systemOneClient, type SystemOneProfile } from "./system-one-client.ts";

const ENDPOINT_DEFAULT = "http://127.0.0.1:8090/v1/systemone";

export interface JevK5Options {
  /** 覆盖端点（默认 `JEVK5_ENDPOINT`，再默认 `http://127.0.0.1:8090/v1/systemone`）。 */
  endpoint?: string;
  version?: string;
  /** 注入 fetch（测试用假服务；也便于走代理）。 */
  fetchImpl?: typeof fetch;
  /** 单次请求超时（毫秒）。JevK5 的 knockout 对 40 个选项要 4 次前向，别给太短。 */
  timeoutMs?: number;
}

const CAPABILITIES: ProviderCapabilities = {
  choice: true, risk: true, done: true, shortlist: false, score_kind: "calibrated_prob",
};

export function jevk5Provider(opts: JevK5Options = {}): DecisionProvider {
  const env = process.env;
  const profile: SystemOneProfile = {
    name: "jevk5",
    version: opts.version ?? "0.3.x",
    label: "JevK5",
    capabilities: CAPABILITIES,
    resolveEndpoint: () => opts.endpoint ?? env.JEVK5_ENDPOINT ?? ENDPOINT_DEFAULT,
    endpointHint: "设 JEVK5_ENDPOINT 指向 /v1/systemone；起服务见 docs/DECISION_PROVIDER_JEVK5.md",
    // JevK5 本地服务无认证。
    extraBody: () => ({}),
    minOptions: 2,               // choice 要 ≥2 个选项，否则服务端 400
    validateChoiceInPool: false, // 信任服务端返回的 choice
    choiceInstructions: (goal) => `Goal: ${goal}. Which single element should be interacted with next `
      + "to make progress on this goal? Ignore branding, navigation and decoration unless the goal requires them.",
    riskInstructions: (goal) => "The user goal is given for context only. Judge ONLY the action itself: would performing "
      + "it trigger an irreversible or externally-visible effect (payment, order placement, deletion, sending a message, "
      + "final submission)? Typing text into a visible form field, opening pages, or navigating is NOT risky. "
      + `{action} (context: ${goal})`,
    doneInstructions: (goal) => `User goal: ${goal}. Look at this page: does it explicitly CONFIRM the goal is complete `
      + "(a success message, a confirmation page, the requested item now present)? Answer false "
      + "if the page is merely a starting or intermediate page.",
    unreachableHint: "起服务见 docs/DECISION_PROVIDER_JEVK5.md；没起就别选 --provider jevk5。",
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  };
  return systemOneClient(profile);
}

let registered = false;
/** 注册进 provider 注册表（`--provider jevk5`）。幂等。 */
export async function registerJevK5(): Promise<void> {
  if (registered) return;
  registered = true;
  const { registerDecisionProvider } = await import("./decision-provider.ts");
  registerDecisionProvider("jevk5", () => jevk5Provider());
}
