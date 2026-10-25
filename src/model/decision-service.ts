/**
 * **统一决策服务配置层** —— 用「服务地址 + 模型名 + 密钥」（+ 可选协议/刻度）替代
 * 每家 provider 各一套环境变量（`TOKEN_PLAN_*` / `BAILIAN_*` / `JEVK5_*` / `DASHSCOPE_*`）。
 *
 * 为什么需要它（2026-10-25 项目方提出）：调研发现决策模型已经收敛成两条协议
 * （TypeSafe **System One**、OpenAI **Decisions API**），而本仓接一家服务就要记一套变量名、
 * 还要额外指定 `AMBERFLOW_DEFAULT_DECISION_PROVIDER`——配置面先于协议面分裂了。
 * 统一层把"接一个新服务"变成改三个值（地址/模型/密钥），provider 细节交给协议适配器。
 *
 * 本轮支持：
 *   - `AMBERFLOW_DECISION_BASE_URL`  服务地址（host、`…/v1`、`…/compatible-mode/v1` 或完整
 *                                   `…/v1/systemone` 都行；System One 会自动补 `/v1/systemone`）
 *   - `AMBERFLOW_DECISION_MODEL`     模型名（随请求体 `model` 发；服务不要求时可空）
 *   - `AMBERFLOW_DECISION_API_KEY`   密钥（Bearer；本地自托管无认证可留空）
 *   - 可选：`AMBERFLOW_DECISION_PROTOCOL`（默认 `systemone`；`openai-decisions` 预留未实现）、
 *     `AMBERFLOW_DECISION_FLOOR`（闸门刻度）、`AMBERFLOW_DECISION_SCORE_KIND`、
 *     `AMBERFLOW_DECISION_TIMEOUT_MS`、`AMBERFLOW_DECISION_STATE_CONTEXT`（`0` 关闭带上文）、
 *     `AMBERFLOW_DECISION_MIN_OPTIONS`（choice 选项下限，自托管 JevK5 需要 2）
 *
 * 设计纪律（与旧 provider 相同）：
 *   1. 端点/密钥**每次现读**（测试可临时注入；启动后改配置也生效）；
 *   2. 缺配置分两种——显式点名 ⇒ 解析期响亮报错；环境默认 ⇒ 干净落 rules-only；
 *   3. 错误消息点名缺什么、怎么补；不把外部主机/密钥写进代码或默认值。
 */
import type { DecisionProvider, ProviderCapabilities } from "./decision-provider.ts";
import { stateText, urlOf } from "../engine/extraction.ts";
import { systemOneClient, type SystemOneProfile } from "./system-one-client.ts";

/** 统一配置键（同时登记进 `rcfile.ts` 的白名单，`amber config` 才能读写）。 */
export const DECISION_SERVICE_KEYS = [
  "AMBERFLOW_DECISION_BASE_URL",
  "AMBERFLOW_DECISION_MODEL",
  "AMBERFLOW_DECISION_API_KEY",
  "AMBERFLOW_DECISION_PROTOCOL",
  "AMBERFLOW_DECISION_FLOOR",
  "AMBERFLOW_DECISION_SCORE_KIND",
  "AMBERFLOW_DECISION_TIMEOUT_MS",
  "AMBERFLOW_DECISION_STATE_CONTEXT",
  "AMBERFLOW_DECISION_MIN_OPTIONS",
] as const;

export type DecisionServiceProtocol = "systemone" | "openai-decisions";
export const SUPPORTED_PROTOCOLS: readonly DecisionServiceProtocol[] = ["systemone"];

const CAPABILITIES: ProviderCapabilities = {
  choice: true,
  risk: true,
  done: true,
  shortlist: false,
  score_kind: "calibrated_prob",
};

function envOf(v: string | undefined): string {
  return (v ?? "").trim();
}

/** `AMBERFLOW_DECISION_BASE_URL`，空串 = 未配置。 */
export function serviceBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return envOf(env.AMBERFLOW_DECISION_BASE_URL);
}

export function serviceModel(env: NodeJS.ProcessEnv = process.env): string {
  return envOf(env.AMBERFLOW_DECISION_MODEL);
}

export function serviceApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return envOf(env.AMBERFLOW_DECISION_API_KEY);
}

/** 是否配置了统一决策服务（只看服务地址；密钥是否缺失由 `serviceConfigError` 回答）。 */
export function decisionServiceConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return serviceBaseUrl(env) !== "";
}

/** 协议：显式 `AMBERFLOW_DECISION_PROTOCOL` 优先；否则按 URL 形状推断（默认 systemone）。 */
export function serviceProtocol(env: NodeJS.ProcessEnv = process.env): DecisionServiceProtocol | string {
  const declared = envOf(env.AMBERFLOW_DECISION_PROTOCOL).toLowerCase() || null;
  if (declared !== null) return declared;
  const raw = serviceBaseUrl(env);
  if (raw === "") return "systemone";
  let pathname = "";
  try {
    pathname = new URL(withScheme(raw)).pathname.toLowerCase();
  } catch {
    return "systemone";
  }
  if (/\/(decisions)(\/)?$/.test(pathname) || pathname.includes("/v1/decisions")) return "openai-decisions";
  return "systemone";
}

/** 没写 scheme 时按 https 补（本地 http 必须显式写 `http://`——不要猜"localhost 是 http"）。 */
function withScheme(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/**
 * 把用户给的服务地址归一成 System One 端点：
 *   `<host>`（裸域名）                            → `https://<host>/v1/systemone`
 *   `http://localhost:8008`                      → `http://localhost:8008/v1/systemone`
 *   `<base>/compatible-mode/v1`                  → `<base>/compatible-mode/v1/systemone`
 *   `<base>/compatible-mode/v1/systemone`        → 原样（去掉尾部 `/`）
 * 其它自定义 base path（反代前缀）也按 `<base>/v1/systemone` 补。
 */
export function normalizeSystemOneEndpoint(raw: string): string {
  const url = new URL(withScheme(raw.trim()));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`服务地址必须是 http(s) URL（收到 ${JSON.stringify(raw)}）`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(`服务地址不能带查询串/片段（收到 ${JSON.stringify(raw)}）`);
  }
  let pathname = url.pathname.replace(/\/+$/, "");
  if (!/\/systemone$/i.test(pathname)) {
    if (/\/(compatible-mode\/)?v1$/i.test(pathname)) pathname += "/systemone";
    else if (/\/compatible-mode$/i.test(pathname)) pathname += "/v1/systemone";
    else pathname += "/v1/systemone";
  }
  url.pathname = pathname;
  return url.toString().replace(/\/$/, "");
}

/** OpenAI Decisions 端点（预留给下一步适配器；本文件暂不实现该协议）。 */
export function normalizeOpenAIDecisionsEndpoint(raw: string): string {
  const url = new URL(withScheme(raw.trim()));
  let pathname = url.pathname.replace(/\/+$/, "");
  if (!/\/decisions$/i.test(pathname)) {
    pathname = /\/v1$/i.test(pathname) ? `${pathname}/decisions` : `${pathname}/v1/decisions`;
  }
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function isLocalHost(raw: string): boolean {
  try {
    const host = new URL(withScheme(raw)).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.endsWith(".local");
  } catch {
    return false;
  }
}

function parseFloatInRange(raw: string | undefined, key: string): number | null {
  const text = envOf(raw);
  if (text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * 统一配置的可用性检查（`null` = 可用的；字符串 = 缺什么/错在哪）。
 * 与旧 provider 同一口径：**重配置错误在解析期就红**，不等到第一个需要模型的步。
 */
export function serviceConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = serviceBaseUrl(env);
  if (base === "") {
    return "缺服务地址：设 AMBERFLOW_DECISION_BASE_URL（如 https://<服务地址> 或 "
      + "http://localhost:8008；也可直接给完整 …/v1/systemone）";
  }
  const protocol = serviceProtocol(env);
  if (protocol === "openai-decisions") {
    return "AMBERFLOW_DECISION_PROTOCOL=openai-decisions 还没实现（当前只支持 systemone）；"
      + "可先用支持 System One 的网关，或等 OpenAI Decisions 适配器落地";
  }
  if (protocol !== "systemone") {
    return `AMBERFLOW_DECISION_PROTOCOL=${JSON.stringify(protocol)} 不支持（当前只支持 systemone）`;
  }
  try {
    normalizeSystemOneEndpoint(base);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  if (serviceApiKey(env) === "" && !isLocalHost(base)) {
    return "缺 API key：设 AMBERFLOW_DECISION_API_KEY（只从环境/配置按名读，不写进代码/产物）；"
      + "本地自托管（localhost/127.0.0.1）可留空";
  }
  const floor = parseFloatInRange(env.AMBERFLOW_DECISION_FLOOR, "AMBERFLOW_DECISION_FLOOR");
  if (envOf(env.AMBERFLOW_DECISION_FLOOR) !== "" && (floor === null || floor < 0 || floor > 1)) {
    return "AMBERFLOW_DECISION_FLOOR 必须是 0–1 的数字";
  }
  const kind = envOf(env.AMBERFLOW_DECISION_SCORE_KIND);
  if (kind !== "" && !["calibrated_prob", "entropy_conf", "rank_only"].includes(kind)) {
    return "AMBERFLOW_DECISION_SCORE_KIND 只能是 calibrated_prob / entropy_conf / rank_only";
  }
  const timeout = envOf(env.AMBERFLOW_DECISION_TIMEOUT_MS);
  if (timeout !== "" && (!Number.isFinite(Number(timeout)) || Number(timeout) <= 0)) {
    return "AMBERFLOW_DECISION_TIMEOUT_MS 必须是正整数";
  }
  const minOptions = envOf(env.AMBERFLOW_DECISION_MIN_OPTIONS);
  if (minOptions !== "" && (!Number.isInteger(Number(minOptions)) || Number(minOptions) < 1)) {
    return "AMBERFLOW_DECISION_MIN_OPTIONS 必须 ≥1 的整数";
  }
  return null;
}

/** 读统一配置的 profile；`systemOneClient(profile)` 就是 provider。 */
export function systemOneServiceProfile(env: NodeJS.ProcessEnv = process.env): SystemOneProfile {
  const base = serviceBaseUrl(env);
  const model = serviceModel(env);
  const floorKind = envOf(env.AMBERFLOW_DECISION_SCORE_KIND) || CAPABILITIES.score_kind;
  const scoreKind = floorKind as ProviderCapabilities["score_kind"];
  const timeout = Number(envOf(env.AMBERFLOW_DECISION_TIMEOUT_MS) || "30000");
  const minOptions = Number(envOf(env.AMBERFLOW_DECISION_MIN_OPTIONS) || "1");
  const stateContext = envOf(env.AMBERFLOW_DECISION_STATE_CONTEXT) !== "0";
  return {
    name: "decision-service",
    version: model !== "" ? model : "systemone",
    label: "统一决策服务",
    capabilities: { ...CAPABILITIES, score_kind: scoreKind },
    resolveEndpoint: () => {
      const raw = serviceBaseUrl(env);
      if (raw === "") return null;
      return normalizeSystemOneEndpoint(raw);
    },
    endpointHint: "设 AMBERFLOW_DECISION_BASE_URL（服务地址；System One 会自动补 /v1/systemone）",
    resolveAuth: () => {
      const key = serviceApiKey(env);
      if (!key) return "";          // 本地自托管可无认证：不发 Authorization 头
      return key;
    },
    extraBody: () => (model !== "" ? { model } : {}),
    minOptions: Number.isInteger(minOptions) && minOptions >= 1 ? minOptions : 1,
    validateChoiceInPool: true,
    choiceInstructions: (goal) => `Goal: ${goal}. Which single element should be interacted with next `
      + "to make progress on this goal? Ignore branding, navigation and decoration unless the goal requires them.",
    ...(stateContext ? {
      stateBuilder: async (req) => {
        const st: Record<string, unknown> = { goal: req.goal };
        try { st.url = urlOf(req.page); } catch { /* 无 url 就不带 */ }
        try { st.title = await req.page.title(); } catch { /* 同上 */ }
        try {
          const text = await stateText(req.page, req.goal);
          if (text) st.main_text = text;
        } catch { /* fake page/死页：少正文，题照问 */ }
        return st;
      },
    } : {}),
    riskInstructions: () => "Judge ONLY the action itself: would performing it trigger an irreversible or "
      + "externally-visible effect (payment, order placement, deletion, sending a message, final submission)? "
      + "Typing into a form field, opening pages, or navigating is NOT risky.",
    doneInstructions: (goal) => `User goal: ${goal}. Does this page explicitly CONFIRM the goal is complete `
      + "(a success message, a confirmation page, the requested item now present)? Answer false if it is "
      + "merely a starting or intermediate page.",
    unreachableHint: "检查网络与 AMBERFLOW_DECISION_BASE_URL；密钥只从环境/配置按名读："
      + "AMBERFLOW_DECISION_API_KEY。",
    configError: () => serviceConfigError(env),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30_000,
  };
}

/** 统一配置 → DecisionProvider（名字固定 `decision-service`，协议差异由 profile 决定）。 */
export function decisionServiceProvider(env: NodeJS.ProcessEnv = process.env): DecisionProvider {
  const profile = systemOneServiceProfile(env);
  const provider = systemOneClient(profile);
  const floor = parseFloatInRange(env.AMBERFLOW_DECISION_FLOOR, "AMBERFLOW_DECISION_FLOOR");
  return floor === null ? provider : { ...provider, floor };
}

let registered = false;
/** 注册进 provider 注册表（`--provider decision-service`）。幂等。 */
export async function registerDecisionService(): Promise<void> {
  if (registered) return;
  const { registerDecisionProvider } = await import("./decision-provider.ts");
  registerDecisionProvider("decision-service", () => decisionServiceProvider());
  registered = true;
}
