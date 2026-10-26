/**
 * **阿里百炼（Model Studio / DashScope）决策模型 provider** —— `decision-model-preview`。
 *
 * 它是 `systemOneClient` 的一份 profile（见 docs/DECISION_LAYER_SYSTEMONE.md）：百炼走 TypeSafe
 * System One（`POST /compatible-mode/v1/systemone`），本项目只适配这一层协议，模型加载/推理在服务侧。
 * API 契约：https://help.aliyun.com/zh/model-studio/decision-model-api
 *
 * profile 吸收的百炼特有差异：
 *   - 认证 `Authorization: Bearer $DASHSCOPE_API_KEY`（别名 BAILIAN_API_KEY）——**只从环境按名读，绝不内联**；
 *   - 每个请求带 `model: decision-model-preview`；
 *   - 端点是 workspace 作用域的（BAILIAN_ENDPOINT 全 URL，或 BAILIAN_WORKSPACE_ID + 可选 BAILIAN_REGION）；
 *   - choice 支持 1–255 项（minOptions=1，单候选也问）；
 *   - 池外答案（如 other）拒绝为 null（validateChoiceInPool=true）；
 *   - confidence 是独立标定值（≠max(prob)）→ score=confidence，pTop1/pTop2/margin 从 probabilities 取，
 *     score_kind=calibrated_prob（跨 provider 比这些数无意义）。
 * 注册不需要 key/端点（doctor 能列出）；真调用缺了才报错指路，绝不静默退回 laya。
 */
import type { DecisionProvider, ProviderCapabilities } from "./decision-provider.ts";
import { systemOneClient, type SystemOneProfile } from "./system-one-client.ts";

const MODEL_DEFAULT = "decision-model-preview";
const REGION_DEFAULT = "cn-beijing";

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
  timeoutMs?: number;
}

const CAPABILITIES: ProviderCapabilities = {
  choice: true, risk: true, done: true, shortlist: false, score_kind: "calibrated_prob",
};

export function bailianProvider(opts: BailianOptions = {}): DecisionProvider {
  const env = process.env;
  const model = opts.model ?? env.AMBERFLOW_DECISION_MODEL ?? env.BAILIAN_MODEL ?? MODEL_DEFAULT;
  const profile: SystemOneProfile = {
    name: "bailian",
    version: opts.version ?? model,
    label: "百炼决策模型",
    capabilities: CAPABILITIES,
    resolveEndpoint() {
      if (opts.endpoint) return opts.endpoint;
      if (env.BAILIAN_ENDPOINT) return env.BAILIAN_ENDPOINT;
      const ws = opts.workspaceId ?? env.BAILIAN_WORKSPACE_ID;
      if (ws) {
        const region = opts.region ?? env.BAILIAN_REGION ?? REGION_DEFAULT;
        return `https://${ws}.${region}.maas.aliyuncs.com/compatible-mode/v1/systemone`;
      }
      return null;
    },
    endpointHint: "设 BAILIAN_ENDPOINT（全 URL），或 BAILIAN_WORKSPACE_ID（+可选 BAILIAN_REGION，"
      + `默认 ${REGION_DEFAULT}）。端点是 workspace 作用域的，起法与契约见 docs/DECISION_PROVIDER_BAILIAN.md`,
    // key 每次现读（不缓存进闭包）：测试可临时注入，也不会有"启动时没配、之后配了读不到"的坑。
    resolveAuth() {
      const key = (opts.apiKey ?? env.DASHSCOPE_API_KEY ?? env.BAILIAN_API_KEY ?? "").trim();
      if (!key) {
        throw new Error("缺 API key：设环境变量 DASHSCOPE_API_KEY（或 BAILIAN_API_KEY）。"
          + "token 只从环境读，绝不写进代码/产物/提交。");
      }
      return key;
    },
    // 解析期判定（不抛）：缺 key 或缺端点各给一句指路。供 resolveProviderSpec 区分显式/默认。
    configError() {
      const key = (opts.apiKey ?? env.DASHSCOPE_API_KEY ?? env.BAILIAN_API_KEY ?? "").trim();
      const hasEndpoint = !!(opts.endpoint || env.BAILIAN_ENDPOINT || opts.workspaceId || env.BAILIAN_WORKSPACE_ID);
      const missing: string[] = [];
      if (!key) missing.push("API key（DASHSCOPE_API_KEY）");
      if (!hasEndpoint) missing.push("端点（BAILIAN_ENDPOINT 或 BAILIAN_WORKSPACE_ID）");
      return missing.length ? `缺 ${missing.join(" 与 ")}。` : null;
    },
    extraBody: () => ({ model }),
    minOptions: 1,
    validateChoiceInPool: true,
    choiceInstructions: (goal) => `Goal: ${goal}. Which single element should be interacted with next `
      + "to make progress on this goal? Ignore branding, navigation and decoration unless the goal requires them.",
    riskInstructions: () => "Judge ONLY the action itself: would performing it trigger an irreversible or "
      + "externally-visible effect (payment, order placement, deletion, sending a message, final submission)? "
      + "Typing into a form field, opening pages, or navigating is NOT risky.",
    doneInstructions: (goal) => `User goal: ${goal}. Does this page explicitly CONFIRM the goal is complete `
      + "(a success message, a confirmation page, the requested item now present)? Answer false if it is "
      + "merely a starting or intermediate page.",
    unreachableHint: "检查网络/端点/workspace id；没配好就别选 --provider bailian。",
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  };
  return systemOneClient(profile);
}

let registered = false;
/** 注册进 provider 注册表（`--provider bailian`）。幂等。 */
export async function registerBailian(): Promise<void> {
  if (registered) return;
  registered = true;
  const { registerDecisionProvider } = await import("./decision-provider.ts");
  registerDecisionProvider("bailian", () => bailianProvider());
}
