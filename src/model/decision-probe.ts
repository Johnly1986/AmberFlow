/**
 * task-14（D1·用户裁决重定 scope）：决策面**起跑探测**——配置兼容性提升的唯一实现。
 *
 * 背景（run4 连锁实证）：decision plane 配了不可达 endpoint → 升级链反复咨询死服务 →
 * no_model_runtime 毒化后续步骤（12 步全灭）。根因是**配置问题**，解法是兼容性三件：
 *   ① 起跑探测一次 + 分类诊断（unreachable / auth / protocol，各给针对性建议——含
 *      「移除该配置键回退本地模型/规则面」）；
 *   ② 探测失败 → 本次 run 停发模型调用（规则面继续、升级链规则兜底、死服务不重试超过 1 次）；
 *   ③ 诚实留痕（result.decision.degraded + run/step warning）——由 app-runner/executor 落。
 *
 * 复用 doctor 的探针底座（同一协议端点 resolveProviderSpec → spec.provider 的最小 pick——
 * task-26 实证修正：不 applySpecToRuntime，重装会以未计数 provider 覆盖 run.ts 的计数安装）。
 * 探测通过 = 一切照旧（调用方不落任何字段，online 时行为与今天逐字节一致，唯一差异是
 * 起跑多付一次最小 ask——已写进 F52 与 docs）。
 */
import {
  decisionFailureFact, resolveProviderSpec,
} from "./decision-provider.ts";

export type DecisionDegradedClass = "unreachable" | "auth" | "protocol" | "unknown";

export interface DecisionProbeResult {
  /** 实际装配的决策源名。 */
  provider: string;
  ok: boolean;
  ref?: string | null;
  conf?: number;
  /** ok=false：decisionFailureFact 单行事实（无凭据）。 */
  error?: string;
  /** ok=false：失败分类（advice 的键）。 */
  reasonClass?: DecisionDegradedClass;
  /** ok=false：分类建议文案（app-runner 的 warning/留痕直接引用）。 */
  advice?: string;
}

/** 失败分类：网络层不可达 / 鉴权失败 / 非 200 或响应非协议形状；判不出 = unknown（不硬猜）。
 * 现场标定（8090 网关回 400、其上游 llama-server 8080 连接拒绝）：拒绝语义优先于 HTTP 表层
 * 状态码——网关活着但模型后端拒绝连接 = 决策面整体不可达。中文 Windows 的套接字错误文案
 * （积极拒绝/无法连接）一并覆盖。 */
export function classifyDecisionFailure(err: unknown): DecisionDegradedClass {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur instanceof Error && depth < 4; depth++) {
    parts.push(`${cur.name}: ${cur.message}`);
    cur = (cur as Error & { cause?: unknown }).cause;
  }
  parts.push(typeof err === "string" ? err : String(err));
  const text = parts.join(" | ");
  const flat = text.replace(/\s+/g, " ");
  // ① 连接被拒/不可达（任何一层；含中文 Windows 套接字文案）——拒绝语义优先于表层状态码。
  if (/(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|network|socket|DNS|AggregateError|aborted|WinError 10061|积极拒绝|连接拒绝|拒绝连接|无法连接|连接超时)/i.test(flat)) {
    return "unreachable";
  }
  // ② 上游后端不可用（网关答了但模型后端挂了 = 决策面整体不在服务）。
  if (/backend failed|upstream|后端/i.test(text)) return "unreachable";
  // ③ 鉴权失败。
  if (/\b(401|403)\b|Unauthorized|AccessDenied|Forbidden|鉴权|凭据|API[- _]?key/i.test(text)) {
    return "auth";
  }
  // ④ 非 200 / 响应非协议形状。
  if (/返回 \d{3}|HTTP \d{3}|status\D*\d{3}|响应|protocol|JSON|Unexpected token|content-type/i.test(text)) {
    return "protocol";
  }
  return "unknown";
}

/** 三类（+unknown）的针对性建议（唯一文案出处；result/warning 直接引用）。 */
export function decisionDegradedAdvice(cls: DecisionDegradedClass): string {
  switch (cls) {
    case "unreachable":
      return "决策服务未启动或地址不可达；检查服务，或移除该配置键（AMBERFLOW_DECISION_BASE_URL）回退本地模型/规则面";
    case "auth":
      return "凭据/鉴权失败；检查 AMBERFLOW_DECISION_API_KEY";
    case "protocol":
      return "服务响应不符合决策协议；检查 base_url 路径与服务版本";
    default:
      return "决策源探测失败；检查 AMBERFLOW_DECISION_* 三件套，或移除该配置键回退本地模型/规则面";
  }
}

/**
 * 起跑探测一次：解析决策源并对**同一协议端点**真实发一次最小 pick（doctor 的考卷）。
 * 只测 HTTP 层能不能过、服务答不答协议——不考模型的题感。超时沿用运行时超时配置
 * （AMBERFLOW_DECISION_TIMEOUT_MS）：localhost 停服是连接拒绝（即时），黑洞地址付一次超时。
 * task-26 实证修正：**不再 applySpecToRuntime**——重装会以未计数 provider 覆盖 run.ts 已
 * 安装的计数包装（model_asks 恒 0，A/B 前提误判）。探测改用 spec.provider（同一端点/协议的
 * 原话实例，未包装未安装）——wire 请求与运行时逐字节相同，计数包装与安装序列零扰动。
 */
export async function probeDecisionPlane(): Promise<DecisionProbeResult> {
  let name = "unknown";
  try {
    const spec = await resolveProviderSpec(undefined);
    name = spec.name;
    if (spec.kind !== "provider") {
      // 默认决策源不是在线 HTTP 服务（本地 laya/基线）——探测对象不存在，调用方不该降级。
      return { provider: name, ok: false,
        error: `当前默认决策源是 ${spec.name}（tier=${spec.tier}）——没有在线 HTTP 决策源可探测` };
    }
    const p = spec.provider;
    const page = { url: "https://amberflow.ask-probe.invalid/", title: async () => "amberflow ask probe" };
    const out = await p.pick({
      goal: "decision plane probe", page,
      elems: {
        e1: { tag: "button", label: "搜索" },
        e2: { tag: "textbox", label: "出发地" },
        e3: { tag: "link", label: "下一页" },
      },
      forbidden: new Set(), notes: null, narrow: null, k: 8,
    });
    return { provider: p.name, ok: true, ref: out.ref ?? null, conf: out.score };
  } catch (err) {
    const fact = decisionFailureFact(err).slice(0, 300);
    const reasonClass = classifyDecisionFailure(err);
    return { provider: name, ok: false, error: fact, reasonClass, advice: decisionDegradedAdvice(reasonClass) };
  }
}
