/**
 * **决策提供者层**（provider seam；接口类型已下沉 `src/support/decision-provider-contract.ts`）——把"问哪个决策模型"从执行器里分出来。
 *
 * 为什么要多这一层（2026-10-13）：项目方要**换不同的决策模型做测试**，而原来的缝
 * （`src/model/model.ts` 的 `LayaRuntime`）是 **laya 形状的**：它要求一个 laya `DecisionAgent`、
 * 要求调用方自己构造 `criteria_view`、并把"两种含义共用一个 `confidence`"这个坑写死在返回里
 * （passthrough 时 `conf = 1 − H/log k`，短名单时 `conf = max(子集概率)`——W0 实测两者方向相反）。
 * 于是任何非 laya 的决策模型想进来，都得先**假装自己是 laya**。
 *
 * 三条设计规矩（都是本轮实测换来的，不是审美）：
 *
 * 1. **provider 自报家底**（`capabilities`）。闸门与报告只能读它声明会给的信号。
 *    横评的结论是：
 *    "枚举候选 + 选一个"是市场通用形状，但**每个候选上的概率不是**——browser-use 那类
 *    纯生成式 agent 的输出里根本没有概率字段。所以概率必须是**可选**的。
 * 2. **`score_kind` 说明那个数该怎么读**，跨 kind 不许比。`rank_only` 的 provider 给不出
 *    `pTop1/margin` 时必须是 `null`，**不许填 0**——0 会被任何阈值判成"最没把握"，
 *    等于把"provider 不给概率"伪装成"模型很不确定"。这是最容易犯也最难发现的错。
 * 3. **`undefined` 与 `null` 是两种结果**：`undefined` = 答了但没有可用元素（该说人话：
 *    hint 没命中 / 这一步没点名），`null` = 根本没答（action space exhausted）。
 *    这条区别是承重的——把两者抹平成 `null`，会让"答了但没给出可用元素"的步骤
 *    被误报成 action space exhausted。
 *
 * 与旧缝的关系：`LayaRuntime` **保留**，它是 laya 的实现细节；`layaProvider()` 把它包成
 * provider。`installLayaRuntime()` 仍是 51 个文件在用的那扇门，两扇门最终汇到同一处
 * （见 `resolveForMiddleware`）。
 */
import { ariaInteractiveLines, criteriaView, stateText, urlOf, type PageLike } from "../engine/extraction.ts";
import { withDecisionCache, type DecisionCacheStats } from "./decision-cache.ts";
import { decisionServiceConfigured } from "../support/decision-env.ts";
import * as layaModelModule from "./model.ts";
import {
  getLayaRuntime, installLayaRuntime, countingRuntime,
  type DecisionAgent, type LayaRuntime, type ModelState,
} from "./model.ts";
import { choiceInstructions, RISK_INSTRUCTIONS_LONG, doneInstructionsLong } from "../prompts/model-prompts.ts";

import type {
  ChoiceOutcome,
  ChoiceRequest,
  ClosedSetChoice,
  ClosedSetRequest,
  DecisionProvider,
  ProviderCapabilities,
  ProviderFactory,
  ProviderInfo,
  ProviderPage,
  StateDigestPayload,
} from "../support/decision-provider-contract.ts";

/** 接口类型单源在 L0（`src/support/decision-provider-contract.ts`）；这里 re-export 保持既有 importer 不变。 */
export type {
  ChoiceOutcome,
  ChoiceRequest,
  ClosedSetChoice,
  ClosedSetRequest,
  DecisionProvider,
  ProviderCapabilities,
  ProviderFactory,
  ProviderInfo,
  ProviderPage,
  StateDigestPayload,
} from "../support/decision-provider-contract.ts";


const registry = new Map<string, ProviderFactory>();
let active: DecisionProvider | null = null;

/** 注册一个 provider（幂等；重名覆盖并警告——静默覆盖会让"我在测哪个模型"变成猜谜）。 */
export function registerDecisionProvider(name: string, factory: ProviderFactory): void {
  if (registry.has(name)) {
    console.warn(`决策提供者 ${JSON.stringify(name)} 被重复注册：后一个覆盖前一个`);
  }
  registry.set(name, factory);
}

export function listDecisionProviders(): string[] {
  return [...registry.keys()].sort();
}

/** 装上当前 provider（`null` = 不装，执行器进 rules-only）。 */
export function installDecisionProvider(p: DecisionProvider | null): void {
  active = p;
}

export class DecisionNotConfiguredError extends Error {
  constructor(what: string) {
    super(`decision provider not configured (${what}): call installDecisionProvider() first`);
    this.name = "DecisionNotConfiguredError";
  }
}

export function getDecisionProvider(): DecisionProvider {
  if (!active) throw new DecisionNotConfiguredError("getDecisionProvider");
  return active;
}

export function decisionProviderOrNull(): DecisionProvider | null {
  return active;
}

/** 当前 provider 的身份（报告/doctor/matrix 读它；没装就是 null）。 */
export function activeProviderInfo(): ProviderInfo | null {
  if (!active) return null;
  const { name, version, capabilities, floor } = active;
  return { name, version, capabilities: { ...capabilities }, ...(floor !== undefined ? { floor } : {}) };
}

/* ── 决策面「两条通道」恢复指引（A5） ─────────────────────────────────────── */

/*
 * 同一份三件套有两个注入面（见 docs/DECISION_SERVICE_CONFIG.md §7）：
 *   - 桥通道：DSH 插件配置页 → 桥注入子进程环境变量（部署配置，最高优先）；
 *   - CLI 直跑：本机用户配置层叠（~/.amberflow/config.json 等）。
 * 两边喂进同一个装配路径，所以「桥能用、CLI 直跑 403」不是引擎分叉，而是凭据不同。
 * 失败时用户要做的第一步不同：走桥的改用桥工具（桥用部署配置），直跑的改用户配置。
 *
 * 纪律：只提示、**不自动切换通道**、**不打印任何凭据**。这句指引由 provider 的 ask
 * 失败、解析期配置失败、doctor 与 run 的出口共用，避免每个入口各说各话。
 */
export const DECISION_CHANNEL_GUIDANCE =
  "本机若通过 DSH 桥运行：改用桥工具 amberflow_run（桥使用部署配置）；"
  + "或 amber config set AMBERFLOW_DECISION_* 更新用户配置（见 docs/DECISION_SERVICE_CONFIG.md）";

/** 追加指引时的分隔符：保持单行「事实 —— 指引」，报告/停因的排版不被多行破坏。 */
const DECISION_GUIDANCE_SEP = " —— ";
/** 判重/剥离用的稳定片段（只用于文案判重，不参与任何决策逻辑）。 */
const DECISION_GUIDANCE_MARK = "本机若通过 DSH 桥运行";

/** 这段文案是否已经带过通道指引（doctor 的 JSON 诊断要剥掉，避免同一句出现两次）。 */
export function hasDecisionChannelGuidance(text: string): boolean {
  return text.includes(DECISION_GUIDANCE_MARK);
}

/**
 * 给 ask 失败 / 解析期配置失败的原因统一追加恢复指引；空原因或已带过的不重复追加。
 * 事实（HTTP 状态码、服务错误关键句）保持在前：排查先看事实，再看指引。
 */
export function withDecisionChannelGuidance(reason: string): string {
  const text = reason.trim();
  if (text === "" || hasDecisionChannelGuidance(text)) return text;
  return `${text}${DECISION_GUIDANCE_SEP}${DECISION_CHANNEL_GUIDANCE}`;
}

/**
 * 从错误里取「事实部分」：剥掉统一追加的指引。doctor 的 JSON 字段要的是可比较的
 * HTTP 事实（旧字段语义不变），指引只在人类文本/`next[]` 里出现。
 */
export function decisionFailureFact(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
  const at = text.indexOf(DECISION_GUIDANCE_MARK);
  return (at < 0 ? text : text.slice(0, at).replace(/[ \t—\-]+$/, "")).trim();
}

/**
 * 给一次真咨询的失败套上统一指引。保留错误名与 `cause` 链（A3 的失败透传靠它解包
 * HTTP 事实）；已是同一条（带过指引）的错误原样返回，不重复包装。
 */
function annotateAskFailure(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  const annotated = withDecisionChannelGuidance(message);
  if (annotated === message) return err;
  const wrapped = new Error(annotated, { cause: err });
  if (err instanceof Error && err.name) wrapped.name = err.name;
  return wrapped;
}

/* ── 选择：三件套 / 显式名字 → 哪扇门（CLI 与配置都走这一个函数） ─────────── */

/*
 * 选择规则（2026-10-26 项目方纠正）：
 *   - 线上：有 `AMBERFLOW_DECISION_BASE_URL` 就是线上服务，地址/密钥/模型三件套足够，
 *     **不再需要 provider 键**；协议按 URL 推断，必要时用 `AMBERFLOW_DECISION_PROTOCOL` 覆盖。
 *   - 本地：没有服务地址时用本地模型，`AMBERFLOW_DECISION_MODEL` 选 checkpoint。
 *   - `--provider NAME` 只保留为实验/消融/兼容旧适配器的**命令行**入口，不写进配置。
 */

/** 内建名字：走旧的 `LayaRuntime` 门（checkpoint 路由、换入换出都在执行器那边）。 */
export const BUILTIN_LAYA_PROVIDERS = ["laya-onnx", "scripted-stub", "none"] as const;

export interface Selection {
  /** 实际生效的 provider 名字（写进产物，供报告与 A/B 对照）。 */
  provider: string;
  /** 层级：**有决策层在场就是 `on`**，基线 provider 也算 on（它确实被咨询了）。 */
  tier: string;
  /** 是不是消融臂（`scripted-stub` / `none`）——只有消融臂的"过关 0"不算证据。 */
  ablation: boolean;
}

/** 解析结果：调用方拿到"该装什么"，自己决定要不要再包缓存/计数（app-runner 必须包）。 */
export type ProviderSpec =
  | { kind: "laya"; name: string; tier: string; ablation: boolean; make: () => Promise<LayaRuntime> | LayaRuntime }
  | { kind: "provider"; name: string; tier: "on"; ablation: false; provider: DecisionProvider }
  | { kind: "none"; name: string; tier: string; ablation: true };

/**
 * 给 provider 套一层咨询计数（基线 provider 也要出场数，否则梯级账单会把它算成零咨询）。
 * A3 补了一本**失败账**：ask 抛错（HTTP 403/超时/DNS……）是基础设施失败，不是"模型给的意见
 * 没过闸门"——闸门是对意见打分，抛错说明根本没拿到意见。旧行为把抛错的 ask 也计进 asks，
 * 让「模型被咨询 1 次（1 次未过闸门）」去掩盖一次 403；现在失败单独记 `failedAsks`，
 * 汇总行如实分开（「N 次未过闸门，K 次失败」）。计数仍先于调用：无论服务答没答，
 * 敲门这个动作本身发生了。
 *
 * A5：失败原因在这里统一附上「两条通道」恢复指引——执行器把这次失败的 message 原样编进
 * `provider_degraded` 与 `no_model_runtime` 停因，所以入口（run/start/doctor/桥）不必各自补。
 * 事实在前、指引在后；不打印凭据、不自动切换通道。
 */
export function countedProvider(p: DecisionProvider): {
  provider: DecisionProvider; asks: () => number; failedAsks: () => number;
} {
  let n = 0;
  let failed = 0;
  return {
    asks: () => n,
    failedAsks: () => failed,
    provider: {
      ...p,
      async pick(req) {
        n += 1;
        try { return await p.pick(req); }
        catch (e) { failed += 1; throw annotateAskFailure(e); }
      },
      ...(p.risk ? { risk: (g: string, d: string) => p.risk!(g, d) } : {}),
      ...(p.doneVote ? { doneVote: (g: string, st: ModelState) => p.doneVote!(g, st) } : {}),
      // escalation（askChoice 闭集窄问）也是一次真咨询：不记账的话，"老师点名"会
      // 在梯级账单里记成零出场。askChoice 缺席（能力未声明）时什么都不加。
      ...(p.askChoice
        ? {
            askChoice: async (req: ClosedSetRequest) => {
              n += 1;
              try { return await p.askChoice!(req); }
              catch (e) { failed += 1; throw annotateAskFailure(e); }
            },
          }
        : {}),
    },
  };
}

/** 安装的结果：梯级账单与缓存命中率要的数（app-runner/start/online 共用同一口径）。
 *  可空性是承重的：报告里 `cache 命中 …` 这一行**只在 stats 在场时打印**（app-runner 的
 *  summarizeDecisions 判 `cache !== null`），非 laya 档返回零值闭包会多出整行字——逐字节等价纪律。 */
export interface AppliedSpec {
  /** 决策缓存的实时统计（仅 laya 档；其余档为 null=报告不打这一行）。 */
  stats: (() => DecisionCacheStats) | null;
  /** 模型被真咨询了几次（laya 与在线 provider 都有——计在缓存外面，命中也算咨询；none 为 null）。 */
  asks: (() => number) | null;
  /**
   * A3：ask **抛错**的次数（在线 provider 档；laya/none 为 null——laya 的失败走
   * configError/产物路径，不按"每次咨询"记账）。汇总时与 asks 分开报：
   * 「未过闸门」只算模型真给过意见的，基础设施失败进 failed_asks。
   */
  failedAsks?: (() => number) | null;
}

/**
 * 按 `ProviderSpec` 安装决策源的**唯一**序列。
 * 前身是两处手抄（app-runner main 的缓存/计数安装与 tools/apps_suite.ts 的同一段），
 * start 与 online 接智能缺省是后续安装者——按本仓库"两份实现各扫各的"的复发教训，
 * 先收敛成一个函数再让四个门都用它。每次先清空两扇全局（provider 与 runtime），
 * 任何残留都不许悄悄改变这一跑的决策来源。
 */
export async function applySpecToRuntime(spec: ProviderSpec): Promise<AppliedSpec> {
  installDecisionProvider(null);
  installLayaRuntime(null);
  if (spec.kind === "none") return { stats: null, asks: null, failedAsks: null };
  if (spec.kind === "provider") {
    // 在线 provider 不套决策缓存（缓存键是 laya 的 state+questions 形状，对别的 provider
    // 不成立——套错会静默复用别的模型的决策），但咨询计数必须在场，否则梯级账单会把它记成零出场。
    const counted = countedProvider(spec.provider);
    installDecisionProvider(counted.provider);
    return { stats: null, asks: counted.asks, failedAsks: counted.failedAsks };
  }
  const inner = await spec.make();
  const cached = withDecisionCache(inner);
  const counted = countingRuntime(cached);
  installLayaRuntime(counted);
  return { stats: () => cached.decisionStats(), asks: () => counted.pickAsks(), failedAsks: null };
}

/**
 * 注册全部**内置** provider（幂等）。新增 provider 只需：adapter 文件 + 在本函数加一行
 * import/register——`resolveProviderSpec`、`amber doctor` 与 `start --doctor` 三面都走这里，
 * 不再各自维护注册清单（扩展演练实测过清单漂移的代价）。
 *
 * 条件注册的除外：`decision-service` 只在真要解析线上档时才注册（见 resolveProviderSpec），
 * 这里不注册它，保持三面可见集合与既有行为一致。
 */
export async function registerAllProviders(): Promise<void> {
  const [{ registerBaselines }, { registerJevK5 }, { registerBailian }, { registerTokenPlan }] = await Promise.all([
    import("./decision-baselines.ts"),
    import("./decision-jevk5.ts"),
    import("./decision-bailian.ts"),
    import("./decision-tokenplan.ts"),
  ]);
  registerBaselines();
  await registerJevK5();
  await registerBailian();
  await registerTokenPlan();
}

/**
 * 按**三件套或显式名字**解析该装什么（不安装）。四个门，一个入口：
 *   有 `AMBERFLOW_DECISION_BASE_URL` → 统一决策服务（不需要 provider 键）
 *   `laya-onnx`      没有服务地址时的本地端口；产物不齐时 tier 如实写 `off(missing)`
 *   `scripted-stub`  脚本桩（**消融臂**：它的"过关 0"是构造出来的）
 *   `none`           不装决策层（**消融臂**：执行器进 rules-only）
 *   其它             `--provider NAME` 显式点名的实验/兼容 provider
 *
 * 未注册的名字**报错并列出可选项**——拼错 provider 名却静默退回默认，会让一整轮 A/B 白跑。
 */
export async function resolveProviderSpec(
  name?: string | null, env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderSpec> {
  // 外部 provider 的注册**不需要权重/服务在场**（只有真调用才需要）——单一清单见
  // `registerAllProviders()`；没起服务时错误信息会指路，而不是"未知 provider"。
  const { BASELINE_PROVIDERS } = await import("./decision-baselines.ts");
  await registerAllProviders();

  // 线上/本地是**三件套的有无**，不是另一个开关：有服务地址就走统一服务，
  // 没有就用本地 checkpoint。`--provider NAME` 只作为本次实验的显式覆盖。
  const explicitName = name ?? null;
  const serviceConfigured = decisionServiceConfigured(env);
  const wanted = explicitName ?? (serviceConfigured ? "decision-service" : "laya-onnx");

  if (wanted === "decision-service") {
    const { registerDecisionService, decisionServiceProvider } = await import("./decision-service.ts");
    await registerDecisionService();
    // 用调用方传进来的 env 构造（测试与嵌套入口可以传不同的配置面），
    // 而不是让 factory 去读 process.env 的另一份快照。
    const provider = decisionServiceProvider(env);
    const ce = provider.configError?.();
    // A5：配置失败是「两条通道」故障里最常见的一类（CLI 用户配置与桥部署配置不是同一份），
    // 解析期就带上恢复指引；事实（缺哪个键/什么错）在前，指引在后，绝不回显密钥。
    if (ce) throw new Error(withDecisionChannelGuidance(`决策服务未配置：${ce}`));
    return { kind: "provider", name: provider.name, tier: "on", ablation: false, provider };
  }

  const extra = listDecisionProviders().filter(
    (n) => !(BASELINE_PROVIDERS as readonly string[]).includes(n)
      && !(BUILTIN_LAYA_PROVIDERS as readonly string[]).includes(n));
  if (wanted === "none") {
    return { kind: "none", name: "none", tier: "off(ablation:rules-only)", ablation: true };
  }
  if (wanted === "scripted-stub") {
    return {
      kind: "laya", name: "scripted-stub", tier: "off(ablation:scripted-stub)", ablation: true,
      make: () => {
        const { scriptedAgent, scriptedRuntime } = require0();
        return scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 })) as never);
      },
    };
  }
  if (wanted === "laya-onnx") {
    const { checkArtifacts } = await import("./model-artifacts.ts");
    return {
      kind: "laya", name: "laya-onnx", ablation: false,
      tier: checkArtifacts().ready ? "on" : "off(missing)",
      make: async () => (await import("./laya-onnx.ts")).createLayaOnnxRuntime(),
    };
  }
  const factory = registry.get(wanted);
  if (!factory) {
    throw new Error(`未知的决策提供者 ${JSON.stringify(wanted)}。可用：${
      [...BUILTIN_LAYA_PROVIDERS, ...BASELINE_PROVIDERS, ...extra].join(", ")}`);
  }
  const p = await factory();
  // 实验/兼容 provider 只有在 `--provider NAME` 点名时才会走到这里；没配好就解析期报错，
  // 不装一个每步都抛的 provider，也不悄悄降级成"没人要模型"。
  const ce = p.configError?.();
  // A5：显式点名的 provider 没配好同样附两条通道指引（本次 `--provider` 只覆盖选择，不覆盖配置面）。
  if (ce) throw new Error(withDecisionChannelGuidance(`决策提供者 ${JSON.stringify(wanted)} 未配置：${ce}`));
  return { kind: "provider", name: p.name, tier: "on", ablation: false, provider: p };
}

/** 小工具：同步拿 model.ts 的替身工厂（它在 ESM 下已是静态依赖，这里只为避免顶层循环）。 */
function require0(): typeof import("./model.ts") {
  return layaModelModule;
}

/** 解析 + 安装（简单调用方用；需要包缓存/计数的用 `resolveProviderSpec`）。 */
export async function applyDecisionSelection(
  name?: string | null, env: NodeJS.ProcessEnv = process.env,
): Promise<Selection> {
  const spec = await resolveProviderSpec(name, env);
  const { installLayaRuntime } = await import("./model.ts");
  if (spec.kind === "none") { installLayaRuntime(null); installDecisionProvider(null); }
  else if (spec.kind === "laya") { installLayaRuntime(await spec.make()); installDecisionProvider(null); }
  else { installDecisionProvider(spec.provider); }
  return { provider: spec.name, tier: spec.tier, ablation: spec.ablation };
}

/* ── laya 适配器：把旧的 LayaRuntime 包成 provider ───────────────────────── */

/**
 * 把任意 `LayaRuntime`（真 ONNX 端口、脚本桩、`noneRuntime`）包成 provider。
 *
 * `pick()` **逐字照抄**今天 `BrowserMiddleware.pickInner` 的调用序列（criteria_view →
 * `agentFor(state)` → `predictShortlist(k=8)` → 两支各自的 conf 口径），
 * 这样执行器切到 provider 缝时行为不是"应该一样"而是**逐字段等价**
 * （同一 runtime 输入下 `pick()` 与 `mw.pickProposal()` 产出每个字段一致）。
 */
export function layaProvider(opts: {
  runtime: LayaRuntime;
  /** 由执行器提供：checkpoint 路由/换入换出是它的职责，不是 provider 的。 */
  agentFor: (state: ModelState) => Promise<{ agent: DecisionAgent; embedFn: unknown }>;
  name?: string;
  version?: string;
  capabilities?: Partial<ProviderCapabilities>;
}): DecisionProvider {
  const { runtime, agentFor } = opts;
  const caps: ProviderCapabilities = {
    choice: true, risk: true, done: true, shortlist: true, score_kind: "entropy_conf",
    ...opts.capabilities,
  };
  return {
    name: opts.name ?? "laya",
    version: opts.version ?? "unknown",
    capabilities: caps,

    async pick(req: ChoiceRequest): Promise<ChoiceOutcome> {
      const view = req.narrow
        ? Object.fromEntries(req.narrow.map((r) => [r, (req.elems[r] as { label?: string })?.label ?? ""]))
        : criteriaView(req.elems as never, req.forbidden, await ariaInteractiveLines(req.page), req.notes);
      if (!Object.keys(view).length) {
        return { ref: null, score: 0, scoreKind: caps.score_kind,
          signals: { pTop1: null, pTop2: null, margin: null }, options: 0, passthrough: true, probs: {} };
      }
      const state = {
        goal: req.goal, url: urlOf(req.page), title: await req.page.title(),
        main_text: await stateText(req.page, req.goal),
      };
      const { agent, embedFn } = await agentFor(state);
      const res = await runtime.predictShortlist(agent, state, {
        act: {
          type: "choice",
          instructions: choiceInstructions(req.goal),
          criteria: view,
        },
      }, { embedFn, k: req.k });
      const a = res.answers["act"] as { choice?: string; confidence?: number; probabilities?: Record<string, number> } | undefined;
      if (a === undefined) {
        return { ref: null, score: 0, scoreKind: caps.score_kind,
          signals: { pTop1: null, pTop2: null, margin: null }, options: Object.keys(view).length,
          passthrough: false, probs: {} };
      }
      const probs = a.probabilities ?? {};
      const sl = res.shortlist?.["act"] ?? {};
      const values = Object.values(probs).sort((x, y) => y - x);
      const signals = {
        pTop1: values[0] ?? null, pTop2: values[1] ?? null,
        margin: values.length >= 2 ? values[0]! - values[1]! : (values[0] ?? null),
      };
      // 证据截断记账只做透传：运行时（laya-onnx）没裁过证据就不出现该键，
      // 其他 provider 不填 ⇒ outcome 形状与既有消费点不变。
      const evidence: Pick<ChoiceOutcome, "evidence_truncated"> =
        res.evidence_truncated === undefined ? {} : { evidence_truncated: res.evidence_truncated };
      if (sl.passthrough) {
        return { ref: a.choice as string | null | undefined, score: a.confidence ?? 0,
          scoreKind: caps.score_kind, signals, options: values.length, passthrough: true, probs,
          ...evidence };
      }
      return { ref: a.choice as string | null | undefined,
        score: values.length ? values[0]! : (a.confidence ?? 0),
        scoreKind: caps.score_kind, signals, options: values.length, passthrough: false, probs,
        ...evidence };
    },

    async askChoice(req: ClosedSetRequest): Promise<ClosedSetChoice | null> {
      const { agent } = await agentFor({ goal: req.goal });
      const res = await agent.predict(
        { ...(req.state ?? {}), goal: req.goal } as ModelState,
        { act: { type: "choice", instructions: req.instructions, criteria: req.criteria } },
      );
      const a = res.answers["act"] as
        { choice?: string; confidence?: number; probabilities?: Record<string, number> } | undefined;
      if (a === undefined) return null;
      const probs = a.probabilities ?? {};
      const sorted = Object.values(probs).sort((x, y) => y - x);
      // 闭集校验是**实现方**的责任（与 systemOneClient 同一条纪律）：池外名字不采纳。
      const ref = typeof a.choice === "string" && a.choice in req.criteria ? a.choice : null;
      return { ref, score: a.confidence ?? sorted[0] ?? 0, scoreKind: caps.score_kind, probs };
    },

    async risk(goal: string, actionDesc: string): Promise<number> {
      const { agent } = await agentFor({ action: actionDesc, user_goal: goal });
      const res = await agent.predict({ action: actionDesc, user_goal: goal }, {
        r: {
          type: "noul",
          instructions: RISK_INSTRUCTIONS_LONG,
        },
      });
      const r = res.answers["r"] as { noul?: number } | undefined;
      return r ? r.noul ?? 0 : 0;
    },

    async doneVote(goal: string, state: ModelState): Promise<number> {
      const { agent } = await agentFor(state);
      const res = await agent.predict(state, {
        d: {
          type: "noul",
          // **逐字照抄** `BrowserMiddleware.isDone` 的问法：换缝不该换问题——
          // 这条 noul 分数会进报告（advisory），文案变了它就不可比。
          instructions: doneInstructionsLong(goal),
        },
      });
      const d = res.answers["d"] as { noul?: number } | undefined;
      return d ? d.noul ?? 0 : 0;
    },
  };
}

/**
 * 执行器解析自己该用哪个 provider：
 *   ① 显式装了 provider ⇒ 用它（换模型测试走这条路）；
 *   ② 只装了旧的 `LayaRuntime`（那 51 个文件的做法）⇒ 就地包一层，行为不变；
 *   ③ 什么都没装 ⇒ null，执行器进 rules-only。
 */
export function resolveForMiddleware(ctx: {
  agentFor: (state: ModelState) => Promise<{ agent: DecisionAgent; embedFn: unknown }>;
}): DecisionProvider | null {
  if (active) return active;
  try {
    return layaProvider({ runtime: getLayaRuntime(), agentFor: ctx.agentFor,
      name: "laya(legacy-runtime)", capabilities: { score_kind: "entropy_conf" } });
  } catch {
    return null;                      // 没有 runtime：调用方按 rules-only 处理
  }
}
