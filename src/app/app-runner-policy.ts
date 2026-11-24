/**
 * app-runner 的运行策略面（从 app-runner.ts/app-runner-types.ts 纯搬移，大文件拆分 A1a）：
 * `AppRunConfigError` / `EffectivePolicy` / `resolveRunPolicy` / `preflightConfig` /
 * `resolvePace` 与两条运行面共用的策略探测。既有 importer 经 app-runner re-export 不变。
 */
import { resolvePace as paceResolve } from "../support/pace.ts";
import { channelFromEnv } from "../browser/browser-env.ts";
import { BrowserMiddleware, type DecisionStatePolicy } from "../engine/executor.ts";

import { probeDecisionPlane } from "../model/decision-probe.ts";

import { modelConfigError } from "../model/model-artifacts.ts";

import { DEFAULT_CONF_FLOOR } from "../support/config-schema.ts";
import { decisionServiceConfigured } from "../support/decision-env.ts";
import { PaceConfigError, type ResolvedPace } from "../support/pace.ts";
import { DONE_POLL_INTERVAL_MS, SETTLE_QUIET_MS, SETTLE_TIMEOUT_MS } from "../support/tuning.ts";
import { type ManualStepRequest } from "./app-adapters.ts";
import { type AppPack, type PackPolicy } from "./app-pack.ts";
import { type AppRunOptions } from "./app-runner-types.ts";
import { createInterface } from "node:readline/promises";
/** 配置类错误的专用类型：它**不是**一次失败的旅程，是"这次运行根本不该开始"。
 *  调用方（CLI 的 try/catch、桥、套件）看到它就退出 2，**永不重试**（P0-5 / backlog I-1）。 */
export class AppRunConfigError extends Error {}

/**
 * 启动期预检（P0-5）：
 * `LAYA_ONNX_MODEL=/tmp/definitely-missing.onnx npm run apps -- --app <id>` 之前会
 * 把**数据腿与第一个工具步都执行掉**，然后在第一个需要模型的步被同一个配置错误挡住，
 * 并且**重试了 2 次**——配置错误是瞬时的，重跑一百遍还是同一句话，副作用却已经落了盘。
 *
 * 预检只拦"**显式指了一个不存在的产物/目录**"（`model-artifacts.modelConfigError`），
 * 环境变量没设、产物本来就缺的情形仍归 `off(missing)` 层级，照旧如实 block 需要模型的步。
 * 必须在**数据腿之前**跑——函数开头这一处就是"0 步、0 副作用"的那个"0"。
 */
export function preflightConfig(opts: AppRunOptions = {}): void {
  // 消融臂不该被产物齐不齐拦住（它就是不装/装桩），前缀匹配即可。
  if (typeof opts.modelStatus === "string"
    && (opts.modelStatus === "off(rules-only)" || opts.modelStatus === "off(scripted)"
      || opts.modelStatus.startsWith("off(ablation:"))) return;
  const cfg = modelConfigError();
  if (cfg !== null) {
    throw new AppRunConfigError(`model-unavailable: ${cfg}`);
  }
}

/**
 * P0-B：`meta.site.pages` 声明页的 URL 清单（entry-only 的「声明页可再导航」放行清单）。
 * 缺省/空 = undefined（不产生任何行为差异）。
 */
export function declaredPageUrls(pack: unknown): string[] | undefined {
  const pages = (pack as { site?: { pages?: Record<string, string> } } | null)?.site?.pages;
  if (pages === undefined || pages === null) return undefined;
  const urls = Object.values(pages).filter((u): u is string => typeof u === "string" && u.trim() !== "");
  return urls.length ? urls : undefined;
}

/** §3 生效策略的形状（`effective_policy` 产物字段的单一出处）。 */
export interface EffectivePolicy {
  tiered_hint: { value: boolean; source: "cli" | "app" | "default" };
  risk_ask: { value: "always" | "rules-only"; source: "app" | "default" };
  reobserve: { value: boolean; source: "app" | "default" };
  max_effective_repeats: { value: number; source: "app" | "default" };
  conf_floor: { value: number; source: "cli" | "config" | "app" | "provider" | "default" };
  done_timeout_ms: { value: number; source: "app" | "default" };
  done_poll_ms: { value: number; source: "app" | "default" };
  pool_ready_timeout_ms: { value: number; source: "app" | "default" };
  pool_ready_poll_ms: { value: number; source: "app" | "default" };
  /** A2：候选窗口排序策略（缺省 bucketed；main-first 是旧排序回退面）。 */
  candidate_priority: { value: "bucketed" | "main-first"; source: "app" | "default" };
  /** S1：pre-held done 处置（缺省 warn = 只记录，不拦）。 */
  done_preheld: { value: "warn" | "fail" | "allow"; source: "app" | "default" };
  /** P0-E：done 成立后的只读复核 guard（false_done）处置（缺省 warn = 只记录）。 */
  done_guard: { value: "warn" | "fail"; source: "app" | "default" };
  /** S1：fill/setRange 的 effect 读回（缺省两项都开）。 */
  effect_readback: {
    value: { fill: boolean; set_range: boolean };
    source: "app" | "default";
  };
  /** S2：抽池前的稳定门（缺省开启；`null` = meta.policy.settle:"off"）。 */
  settle: {
    value: { quietMs: number; timeoutMs: number } | null;
    source: "app" | "default";
  };
  /** U3：池空判档（缺省 fact；strict = U3 之前的 page_not_ready 快败）。 */
  pool_gate: { value: "fact" | "strict"; source: "app" | "default" };
  /** U3：surface 类目策略（缺省 native_activation="window"；"off" = 池构成回到 U3 之前）。 */
  surface: { value: { native_activation: "window" | "resolve" | "off" }; source: "app" | "default" };
  /**
   * S5：状态接入决策（缺省两项 off）。`source: "app"` 表示 meta 显式声明过——
   * 应用产物的 `decisions.asks_saved/gate_waits/context_sent/context_skipped` 只在这一档出现（默认全缺席 = 逐字节不变）。
   */
  decision_state: { value: DecisionStatePolicy; source: "app" | "default" };
  /**
   * 导航纪律（**仅声明时出现** = 缺省产物逐字节不变；`"free"` 是显式不约束，也进账）。
   * 执行面只在 flow 脚本面：入口之外的直接 URL 导航 → `navigation_forbidden`。
   */
  navigation?: { value: "entry-only" | "free"; source: "app" };
  /**
   * P0-B act hint 档位（**仅声明时出现** = 缺省产物逐字节不变；显式 "widen" 也进账）。
   * "strict" = 声明目标解析链全落空时禁止模型回退，结构化 target_not_found。
   */
  act_hint?: { value: "widen" | "strict"; source: "app" };
  /**
   * A3 弱档命中算不算命中（**仅声明时出现** = 缺省产物逐字节不变；显式 "any" 也进账）。
   * "strong" = bare 词前缀/词包含档（t≥3）与 attrSubstr loose 子串档（t=3）改判未命中，
   * 随后按 `act_hint` 既有语义继续。与 `act_hint` 正交。
   */
  act_hint_tier?: { value: "any" | "strong"; source: "app" };
  /**
   * P0-C 声明目标解析链（**恒在账**：缺省 `"declared"` = 批准的默认翻转；显式声明进
   * `source:"app"`，显式 `"off"` = opt-out 也进账）。"declared" = 命令 target / act hint
   * 在池/ADMIT/FW8 之后走 DRF（attr/text 两模式、恰好一个可见、click 前 hit-test；
   * 能力面 click/scroll/hover，单点在 declared-targets.tryDeclared）。
   */
  target_resolution: { value: "off" | "declared"; source: "app" | "default" };
  /**
   * F74 决策步 act hint 的 DOM 回退跳（**仅声明时出现** = 缺省产物逐字节不变）。
   * true = 声明 act hint 解析链全落空后补一次主帧 ADMIT_SEL DOM 回退面（A3 对称）。
   */
  act_hint_dom_fallback?: { value: boolean; source: "app" };
  /**
   * A1 属性值匹配底座（**仅声明时出现** = 缺省产物逐字节不变；缺省 `full_label` 是修复后行为）。
   * `"display"` = A1 之前只看模型视图前 40 字 label（>40 的 aria-label 值永不命中）。
   */
  attr_value_match?: { value: "full_label" | "display"; source: "app" };
  /**
   * F84 批 3（deny-list 可配化）：第 5 档词元护栏的放行词元表（**仅声明时出现** = 缺省
   * 产物逐字节不变）。生效面 = run 面歧义证据 suggested_hint + ctx.observe 自证池
   * hint_candidates；inspect CLI / session / 桥面缺省（F58 attr_value_match 同款面边界）。
   */
  hint_token_allow?: { value: readonly string[]; source: "app" };
  /**
   * task-43 浏览器通道（**仅 env/meta 任一存在时出现** = 缺省产物逐字节不变）。
   * 生效值按 env(AMBERFLOW_BROWSER_CHANNEL) > meta.policy.browser 记账；真实二进制以
   * `env.browser.binary_basename`（D-1 启动事实）为准——那是 channel 解析后的地面真相。
   */
  browser?: { value: "chrome" | "headless-shell"; source: "env" | "app" };
}

/**
 * §3：运行策略的**生效值与来源**（CLI 本次显式 > meta.policy > provider 自报 > 缺省）。
 *
 * 为什么抽成函数：旧的 `runApp` 与脚本驱动（`runScriptApp`）是两条执行入口——
 * 同名的 `policy.conf_floor` 必须在两条路上生效成**同一个值**，否则"meta 里写了策略"
 * 会随应用形态（数据脚本 vs flow 脚本）时灵时不灵。构造与报告读同一个对象，不分头各猜。
 */
export function resolveRunPolicy(pack: AppPack, opts: AppRunOptions = {}): {
  policy: EffectivePolicy; anyDeclared: boolean;
} {
  // §3：运行策略的**生效值与来源**在这里一次算清（构造与报告读同一个对象，不分两头各猜一遍）。
  // 优先级：CLI(本次显式) > meta.policy(声明) > 缺省(= 今天)。缺省一个都没动。
  const declaredPolicy = ((pack as unknown as Record<string, unknown>)["policy"] ?? {}) as PackPolicy;
  const policy: EffectivePolicy = {
    tiered_hint: {
      value: opts.tieredHint ?? declaredPolicy.tiered_hint ?? false,
      source: opts.tieredHint !== undefined ? "cli" as const
        : declaredPolicy.tiered_hint !== undefined ? "app" as const : "default" as const,
    },
    risk_ask: {
      value: declaredPolicy.risk_ask ?? "always",
      source: declaredPolicy.risk_ask !== undefined ? "app" as const : "default" as const,
    },
    reobserve: {
      value: declaredPolicy.reobserve ?? true,
      source: declaredPolicy.reobserve !== undefined ? "app" as const : "default" as const,
    },
    max_effective_repeats: {
      value: declaredPolicy.max_effective_repeats ?? 3,
      source: declaredPolicy.max_effective_repeats !== undefined ? "app" as const : "default" as const,
    },
    // 闸门刻度：CLI（本次显式）> meta.policy > provider 自报 > 0.25。
    // 换 provider 时缺省刻度不再成立（score_kind 不可比）——这是这条声明面的存在理由。
    conf_floor: opts.confFloor !== undefined
      ? { value: opts.confFloor, source: (opts.confFloorSource ?? "cli") as "cli" | "config" }
      : declaredPolicy.conf_floor !== undefined
        ? { value: declaredPolicy.conf_floor, source: "app" as const }
        : opts.providerFloor !== undefined
          ? { value: opts.providerFloor, source: "provider" as const }
          : { value: DEFAULT_CONF_FLOOR, source: "default" as const },
    done_timeout_ms: {
      value: declaredPolicy.done_timeout_ms ?? 2000,
      source: declaredPolicy.done_timeout_ms !== undefined ? "app" as const : "default" as const,
    },
    done_poll_ms: {
      value: declaredPolicy.done_poll_ms ?? DONE_POLL_INTERVAL_MS,
      source: declaredPolicy.done_poll_ms !== undefined ? "app" as const : "default" as const,
    },
    pool_ready_timeout_ms: {
      value: declaredPolicy.pool_ready_timeout_ms ?? 700,
      source: declaredPolicy.pool_ready_timeout_ms !== undefined ? "app" as const : "default" as const,
    },
    pool_ready_poll_ms: {
      value: declaredPolicy.pool_ready_poll_ms ?? 100,
      source: declaredPolicy.pool_ready_poll_ms !== undefined ? "app" as const : "default" as const,
    },
    // A2：缺省 bucketed（行为变更面）；显式 main-first 才回退旧排序。
    candidate_priority: {
      value: declaredPolicy.candidate_priority ?? "bucketed",
      source: declaredPolicy.candidate_priority !== undefined ? "app" as const : "default" as const,
    },
    // S1 状态层：缺省 warn（行为不变）；显式声明才进 effective_policy 的“非缺省”账。
    done_preheld: {
      value: declaredPolicy.done_preheld ?? "warn",
      source: declaredPolicy.done_preheld !== undefined ? "app" as const : "default" as const,
    },
    // P0-E：false_done guard（缺省 warn = 行为不变；显式声明才进 effective_policy 的账）。
    done_guard: {
      value: declaredPolicy.done_guard ?? "warn",
      source: declaredPolicy.done_guard !== undefined ? "app" as const : "default" as const,
    },
    effect_readback: {
      value: {
        fill: declaredPolicy.effect_readback?.fill !== false,
        set_range: declaredPolicy.effect_readback?.set_range !== false,
      },
      source: declaredPolicy.effect_readback !== undefined ? "app" as const : "default" as const,
    },
    // U3：池空判档缺省 fact（唯一有意改变默认的项）；strict 是逃生口。
    pool_gate: {
      value: declaredPolicy.pool_gate === "strict" ? "strict" : "fact",
      source: declaredPolicy.pool_gate !== undefined ? "app" as const : "default" as const,
    },
    surface: {
      value: { native_activation: declaredPolicy.surface?.native_activation ?? "window" },
      source: declaredPolicy.surface?.native_activation !== undefined ? "app" as const : "default" as const,
    },
    // S2：稳定门缺省开（方案 §2.5）；"off" 是显式声明，仍进 effective_policy 的账。
    settle: {
      value: declaredPolicy.settle === "off"
        ? null
        : {
            quietMs: declaredPolicy.settle?.quiet_ms ?? SETTLE_QUIET_MS,
            timeoutMs: declaredPolicy.settle?.timeout_ms ?? SETTLE_TIMEOUT_MS,
          },
      source: declaredPolicy.settle !== undefined ? "app" as const : "default" as const,
    },
    // S5：状态接入决策（两项缺省 off = 今天的行为）。声明了任一档（即便是 "off"）就进
    // effective_policy 的账——报告要说得出"这一跑是不是 A/B 臂"。
    decision_state: {
      value: {
        gate: declaredPolicy.decision_state?.gate === "stable_only" ? "stable_only" : "off",
        context: declaredPolicy.decision_state?.context === "delta" ? "delta" : "off",
      },
      source: declaredPolicy.decision_state !== undefined ? "app" as const : "default" as const,
    },
    // P0-C：DRF **恒在账**（缺省 declared = 批准的默认翻转；显式声明进 source:"app"，
    // 显式 "off" = opt-out 也进账）——报告要说得出"这一跑 DRF 是否启用"。缺省值不参与
    // anyDeclared：effective_policy 只在包声明过任一策略时出现，无声明包产物逐字节不变。
    target_resolution: {
      value: declaredPolicy.target_resolution ?? "declared",
      source: declaredPolicy.target_resolution !== undefined ? "app" as const : "default" as const,
    },
  };
  // 导航纪律：**仅声明时出现**（缺省键不写进 policy 对象 = 产物逐字节不变）。
  // 必须在 anyDeclared 之前挂上——只声明 navigation 的包也要能进 effective_policy 的账。
  if (declaredPolicy.navigation !== undefined) {
    policy.navigation = { value: declaredPolicy.navigation, source: "app" as const };
  }
  // P0-B：act_hint 同样**仅声明时出现**（缺省 widen = 今天；"widen" 显式声明也进账）。
  if (declaredPolicy.act_hint !== undefined) {
    policy.act_hint = { value: declaredPolicy.act_hint, source: "app" as const };
  }
  // A3：act_hint_tier 同样**仅声明时出现**（缺省 any = 今天；"any" 显式声明也进账）。
  if (declaredPolicy.act_hint_tier !== undefined) {
    policy.act_hint_tier = { value: declaredPolicy.act_hint_tier, source: "app" as const };
  }
  // F74：DOM 回退跳（布尔；仅显式声明时进账，缺省 false = 逐字节不变）。
  if (declaredPolicy.act_hint_dom_fallback !== undefined) {
    policy.act_hint_dom_fallback = { value: declaredPolicy.act_hint_dom_fallback === true, source: "app" as const };
  }
  // A1：属性值匹配底座**仅声明时出现**（缺省 full_label = 修复后；"display" 显式声明才进账）。
  if (declaredPolicy.attr_value_match !== undefined) {
    policy.attr_value_match = { value: declaredPolicy.attr_value_match, source: "app" as const };
  }
  // F84 批 3（deny-list 可配化）：放行词元表**仅声明时出现**（缺省 = 护栏行为逐字节不变）。
  if (declaredPolicy.hint_token_allow !== undefined) {
    policy.hint_token_allow = { value: declaredPolicy.hint_token_allow, source: "app" as const };
  }
  // task-43：浏览器通道——env(AMBERFLOW_BROWSER_CHANNEL) > meta.policy.browser，任一存在才
  // 进账（缺省产物逐字节不变）。最终二进制由 launchKwargs 同一优先级解析，env.browser
  // .binary_basename（D-1）记录地面真相；meta 指定 chrome 但主机没有时 launch 如实报错
  // （不静默回退——要回退请删 meta 或改 env）。
  const envChannel = channelFromEnv();
  if (envChannel !== null) {
    policy.browser = { value: envChannel, source: "env" as const };
  } else if (declaredPolicy.browser !== undefined) {
    policy.browser = { value: declaredPolicy.browser, source: "app" as const };
  }
  const anyDeclared = Object.values(policy).some((p2) => p2.source !== "default");
  return { policy, anyDeclared };
}

/** 人工步的默认接入方式：终端里由人确认；非 TTY 不假装有人。 */

/** 人工步的默认接入方式：终端里由人确认；非 TTY 不假装有人。 */
export async function promptManualOnTty(req: ManualStepRequest): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error("manual step needs an interactive terminal (TTY)；"
      + "测试/嵌入方请注入 manualHandler，或直接在终端里运行");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n[manual] ${req.desc}`);
    if (req.instructions) console.log(`  ${req.instructions}`);
    if (req.url) console.log(`  页面：${req.url}`);
    const answer = await rl.question("  完成后按 Enter 继续；输入 n 放弃：");
    return answer.trim().toLowerCase() !== "n";
  } finally {
    rl.close();
  }
}

/**
 * 起跑探测一次默认决策面：`AMBERFLOW_DECISION_BASE_URL` 配置面在才探；失败 = 兼容降级
 * （规则面继续、本次 run 停发模型调用），mw 上留痕（收尾进 result）并给 stderr 一行；
 * 探测通过 = 零字段零输出（result 逐字节不变，唯一差异是起跑多付一次最小 ask）。
 * 传 thunk：未配置决策面时不构造执行器（两个 app 面的调用点语义一致）。
 */
export async function probeCompatDecisionPlane(getMw: () => BrowserMiddleware): Promise<void> {
  if (!decisionServiceConfigured()) return;
  const mw = getMw();
  mw.decisionCompat = true;
  const probe = await probeDecisionPlane();
  if (probe.ok || probe.reasonClass === undefined) return;
  mw.markDecisionDegraded({
    reason_class: probe.reasonClass,
    message: probe.error ?? "",
    config_source: "AMBERFLOW_DECISION_BASE_URL",
  });
  console.error(`decision_degraded: 决策面探测失败（${probe.reasonClass}）——本次 run 停发模型调用，`
    + `规则面继续；${probe.advice ?? ""}`);
}

/** 环境默认节奏（可被 pack/本次覆盖；坏值 = 配置类错误，响亮而不是静默当 0）。 */
export function resolvePace(
  pack: Pick<AppPack, "pace">,
  opts: Pick<AppRunOptions, "pace"> = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPace {
  try {
    return paceResolve(pack.pace, opts.pace, env);
  } catch (e) {
    if (e instanceof PaceConfigError) throw new AppRunConfigError(e.message);
    throw e;
  }
}

/**
 * A4：运行收尾清理提取期写在页面上的两类盖章属性。
 *
 * 为什么要在关会话前做：`_locatorFor` 按 `[data-dshref]` / `[data-hintref]` 取元素，
 * 章值（`af<批>-e<位>`）只在本轮提取内唯一。注入的 `sessionFactory` 可能把同一个页面
 * 复用给下一次运行/下一个应用，残留旧章会让后续解析多命中。这是**会话卫生**，不是
 * 结果的一部分：页面已崩、已导航或替身没有 evaluate 都吞掉，绝不影响 result/trace。
 *
 * 写成真函数（不是字符串）：Playwright 的 Node 绑定的 `evaluate(string)` 只把字符串
 * 当表达式求值，箭头函数串不会被调用（见执行器 PORT NOTE 3）。`document` 不在本仓的
 * TS lib 面上（lib 只有 ES2022），所以只就地声明用到的这一小块形状。
 */

