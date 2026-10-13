/**
 * **决策提供者层**（provider seam）——把"问哪个决策模型"从执行器里分出来。
 *
 * 为什么要多这一层（2026-10-13）：项目方要**换不同的决策模型做测试**，而原来的缝
 * （`src/model.ts` 的 `LayaRuntime`）是 **laya 形状的**：它要求一个 laya `DecisionAgent`、
 * 要求调用方自己构造 `criteria_view`、并把"两种含义共用一个 `confidence`"这个坑写死在返回里
 * （passthrough 时 `conf = 1 − H/log k`，短名单时 `conf = max(子集概率)`——W0 实测两者方向相反）。
 * 于是任何非 laya 的决策模型想进来，都得先**假装自己是 laya**。
 *
 * 三条设计规矩（都是本轮实测换来的，不是审美）：
 *
 * 1. **provider 自报家底**（`capabilities`）。闸门与报告只能读它声明会给的信号。
 *    横评（docs/DECISION_INTERFACE_SURVIEWS.md…见 DECISION_INTERFACE_SURVEY.md）的结论是：
 *    "枚举候选 + 选一个"是市场通用形状，但**每个候选上的概率不是**——browser-use 那类
 *    纯生成式 agent 的输出里根本没有概率字段。所以概率必须是**可选**的。
 * 2. **`score_kind` 说明那个数该怎么读**，跨 kind 不许比。`rank_only` 的 provider 给不出
 *    `pTop1/margin` 时必须是 `null`，**不许填 0**——0 会被任何阈值判成"最没把握"，
 *    等于把"provider 不给概率"伪装成"模型很不确定"。这是最容易犯也最难发现的错。
 * 3. **`undefined` 与 `null` 是两种结果**：`undefined` = 答了但没有可用元素（该说人话：
 *    hint 没命中 / 这一步没点名），`null` = 根本没答（action space exhausted）。
 *    这条区别是承重的——本轮把它抹平成 `null` 时，两条 UX 测试当场打红
 *    （见 `tests/executor.test.ts` 里那条"§2 答了但没给出可用元素"）。
 *
 * 与旧缝的关系：`LayaRuntime` **保留**，它是 laya 的实现细节；`layaProvider()` 把它包成
 * provider。`installLayaRuntime()` 仍是 51 个文件在用的那扇门，两扇门最终汇到同一处
 * （见 `resolveForMiddleware`）。
 */
import { ariaInteractiveLines, criteriaView, stateText, urlOf, type PageLike } from "./extraction.ts";
import * as layaModelModule from "./model.ts";
import { getLayaRuntime, type DecisionAgent, type LayaRuntime, type ModelState } from "./model.ts";

/** 一个决策提供者的身份与能力声明。 */
export interface ProviderCapabilities {
  /** 能不能从枚举候选里选一个（几乎所有 provider 都能；不能的只能做打分）。 */
  choice: boolean;
  /** 有没有"这个动作是否不可逆"的头（laya 的 noul）。没有 ⇒ 执行器不该为它花一次前向。 */
  risk: boolean;
  /** 有没有"子目标是否已完成"的投票（advisory，永远不能单独判完成——红线③）。 */
  done: boolean;
  /** 支持不支持"先收窄再问"（laya 的 shortlist）。不支持的 provider，`narrow` 请求会被原样拒绝。 */
  shortlist: boolean;
  /**
   * `score` 这个数**该怎么读**：
   *   - `calibrated_prob`：就是概率（可跨 k 比的 max-prob / margin 都属此类）；
   *   - `entropy_conf`：`1 − H/log k` 这种归一化熵——**随选项数变形，跨桶不可比**（laya 出厂值）；
   *   - `rank_only`：只有名次，没有概率 ⇒ `pTop1/pTop2/margin` 必须为 null。
   */
  score_kind: "calibrated_prob" | "entropy_conf" | "rank_only";
}

export interface ProviderInfo {
  name: string;
  version: string;
  capabilities: ProviderCapabilities;
}

/** provider 需要读页面（渲染视图、取 URL/标题）；执行器传的是它自己那个 page。 */
export type ProviderPage = PageLike & { title(): Promise<string> };

/** 一次"选元素"的请求。`narrow` 是收窄后的候选（窄问），null = 全池。 */
export interface ChoiceRequest {
  goal: string;
  page: ProviderPage;
  /** 元素池（provider 自己决定怎么渲染成它的视图）。 */
  elems: Record<string, { tag: string; label: string; data_test?: string; [k: string]: unknown }>;
  forbidden: Set<string>;
  notes: Record<string, string> | null;
  narrow: string[] | null;
  /** 短名单粒度（laya 用 8）。provider 可以忽略它，但忽略时要说。 */
  k: number;
}

/** 一次"选元素"的完整结果：选择 + 所有可用信号 + 这次问的是什么形状。 */
export interface ChoiceOutcome {
  /** `undefined` = 答了但没可用元素；`null` = 没答/没得选。两者语义不同，不许归一。 */
  ref: string | null | undefined;
  /** provider 自己那个"把握"数，含义由 `info.capabilities.score_kind` 解释。 */
  score: number;
  scoreKind: ProviderCapabilities["score_kind"];
  /** 与选项数无关的信号；provider 给不出时**必须是 null**（不是 0）。 */
  signals: { pTop1: number | null; pTop2: number | null; margin: number | null };
  /** 这次实际问了多少个选项——分档要按它，不是按池子大小。 */
  options: number;
  /** 是否发生了"重问子集"（laya 的 shortlist 分支）。 */
  passthrough: boolean;
  /** 原始分布（诊断用；闸门不该依赖它的存在）。 */
  probs: Record<string, number>;
}

/** 一个决策提供者。`pick` 是必须的，其余按能力声明。 */
export interface DecisionProvider extends ProviderInfo {
  pick(req: ChoiceRequest): Promise<ChoiceOutcome>;
  /** `capabilities.risk` 为真时才会被调用。返回 `[0,1]` 的风险概率。 */
  risk?(goal: string, actionDesc: string): Promise<number>;
  /** `capabilities.done` 为真时才会被调用。永远只是参考（红线③）。 */
  doneVote?(goal: string, state: ModelState): Promise<number>;
  /** 释放权重/连接。可选。 */
  close?(): void | Promise<void>;
}

/* ── 注册表 ─────────────────────────────────────────────────────────────── */

export type ProviderFactory = () => DecisionProvider | Promise<DecisionProvider>;

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

export function hasDecisionProvider(name: string): boolean {
  return registry.has(name);
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
  const { name, version, capabilities } = active;
  return { name, version, capabilities: { ...capabilities } };
}

/** 一行给人看的身份串：`laya-onnx 0.3.5（entropy_conf，支持短名单）`。 */
export function describeActiveProvider(): string {
  const i = activeProviderInfo();
  if (!i) return "无（规则模式）";
  const cap = [
    i.capabilities.shortlist ? "短名单" : null,
    i.capabilities.risk ? "风险头" : null,
    i.capabilities.done ? "完成投票" : null,
  ].filter(Boolean).join("/");
  return `${i.name} ${i.version}（score=${i.capabilities.score_kind}${cap ? `，${cap}` : ""}）`;
}

/**
 * 从环境变量/参数解析要用的 provider。
 * `AMBERFLOW_DECISION_PROVIDER=<name>`；未注册的名字**响亮报错**（拼错 provider 名
 * 却静默退回默认，是换模型测试里最难查的一类错——和"CI 的绿来自脚本桩"同一族）。
 */
export async function installProviderFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const want = env.AMBERFLOW_DECISION_PROVIDER;
  if (!want) return null;
  const factory = registry.get(want);
  if (!factory) {
    throw new Error(`未知的决策提供者 ${JSON.stringify(want)}（已注册：${listDecisionProviders().join(", ") || "无"}）`);
  }
  active = await factory();
  return active.name;
}

/* ── 选择：一个名字 → 哪扇门（CLI / env 都走这一个函数，不分两头各猜一遍） ──── */

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

/** 给 provider 套一层咨询计数（基线 provider 也要出场数，否则梯级账单会把它算成零咨询）。 */
export function countedProvider(p: DecisionProvider): { provider: DecisionProvider; asks: () => number } {
  let n = 0;
  return {
    asks: () => n,
    provider: {
      ...p,
      async pick(req) { n += 1; return p.pick(req); },
      ...(p.risk ? { risk: (g: string, d: string) => p.risk!(g, d) } : {}),
      ...(p.doneVote ? { doneVote: (g: string, st: ModelState) => p.doneVote!(g, st) } : {}),
    },
  };
}

/**
 * 按名字**解析**该装什么（不安装）。三扇门，一个入口：
 *   `laya-onnx`      真 ONNX 端口（默认）；产物不齐时 tier 如实写 `off(missing)`
 *   `scripted-stub`  脚本桩（**消融臂**：它的"过关 0"是构造出来的）
 *   `none`           不装决策层（**消融臂**：执行器进 rules-only）
 *   其它             注册表里的 provider（基线 `coin-flip` 等，或嵌入方自己注册的）
 *
 * 未注册的名字**报错并列出可选项**——拼错 provider 名却静默退回默认，会让一整轮 A/B 白跑。
 */
export async function resolveProviderSpec(
  name?: string | null, env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderSpec> {
  const { registerBaselines, BASELINE_PROVIDERS } = await import("./decision-baselines.ts");
  registerBaselines();
  // 外部 provider 在这里注册（**注册不需要权重**，只有真调用才需要服务端在场——
  // 所以 doctor 能列出它，而没起服务时错误信息会指路，而不是"未知 provider"）。
  const { registerJevK5 } = await import("./decision-jevk5.ts");
  await registerJevK5();
  const extra = listDecisionProviders().filter(
    (n) => !(BASELINE_PROVIDERS as readonly string[]).includes(n)
      && !(BUILTIN_LAYA_PROVIDERS as readonly string[]).includes(n));
  const wanted = name ?? env.AMBERFLOW_DECISION_PROVIDER ?? "laya-onnx";
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
 * 这样 Stage 2 把执行器接过来时，行为不是"应该一样"而是**被测试钉住一样**
 * （`tests/decision-provider.test.ts` 拿同一份夹具比 `provider.pick()` 与
 * `mw.pickProposal()` 的每个字段）。
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
          instructions: `Goal: ${req.goal}. Which single element should be interacted with next to make progress on this goal? Ignore branding, navigation and decoration unless the goal requires them.`,
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
      if (sl.passthrough) {
        return { ref: a.choice as string | null | undefined, score: a.confidence ?? 0,
          scoreKind: caps.score_kind, signals, options: values.length, passthrough: true, probs };
      }
      return { ref: a.choice as string | null | undefined,
        score: values.length ? values[0]! : (a.confidence ?? 0),
        scoreKind: caps.score_kind, signals, options: values.length, passthrough: false, probs };
    },

    async risk(goal: string, actionDesc: string): Promise<number> {
      const { agent } = await agentFor({ action: actionDesc, user_goal: goal });
      const res = await agent.predict({ action: actionDesc, user_goal: goal }, {
        r: {
          type: "noul",
          instructions: "The user goal is given for context only. Judge ONLY the action itself: would performing it trigger an irreversible or externally-visible effect (payment, order placement, deletion, sending a message, final submission)? Typing text into a visible form field, opening pages, or navigating is NOT risky. {action} (context: {user_goal})",
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
          instructions: `User goal: ${goal}. Look at this page: does it explicitly CONFIRM the goal is complete (a success message, a confirmation page, the requested item now present)? Answer false if the page is merely a starting or intermediate page.`,
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
