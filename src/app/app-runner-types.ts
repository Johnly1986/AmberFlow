/**
 * app-runner 的运行面**类型与纯助手**（从 app-runner.ts 纯搬移，大文件拆分 A1a）。
 *
 * 只放数据契约（AppRunOptions/AppRunResult/子结果类型/EffectivePolicy/AppDecisions）与
 * 无状态助手（startUrl/resolvePace/cleanStampAttrs/summarizeDecisions/refusalLine/
 * asAfterSignature）；两个运行面的编排仍在 `app-runner.ts`（runScriptApp）与
 * `app-runner-declared.ts`（runApp，后续批次外搬）。既有 importer 经 app-runner re-export 不变。
 */
import type {  ToolSignal  } from "../browser/tool-signals.ts";
import type {  PreviewTable  } from "../data/datasource.ts";
import type {  TraceStep  } from "../engine/audit.ts";
import type {  DatasetEntry, DatasetStore  } from "../engine/dataset.ts";
import type {  BrowserSession, DecisionStateMetrics, ExecutedAction, SkippedAction, StepStateRecord  } from "../engine/executor.ts";
import { REPO } from "../flow/flow.ts";
import type {  DecisionCacheStats  } from "../model/decision-cache.ts";
import type {  ProviderInfo  } from "../model/decision-provider.ts";
import type {  HintMemoryLike  } from "../model/hint-memory.ts";
import { captureStepStateView } from "../model/page-context.ts";
import type {  StepStateView  } from "../model/page-context.ts";
import { type ResolvedPace } from "../support/pace.ts";

import type {  PaceSource  } from "../support/pace.ts";
import type {  StateView  } from "../engine/signals.ts";

import type {  ManualStepRequest  } from "./app-adapters.ts";
import type { PackPace } from "./app-pack.ts";
import type {  RescueRequest  } from "./intervention-adapter.ts";
import path from "node:path";
import type {  AppTrace  } from "./trace.ts";
import type {  EffectivePolicy  } from "./app-runner-policy.ts";
export function startUrl(u: string): string {
  if (u.includes("://")) return u;
  return new URL(`file://${path.resolve(REPO, u)}`).href;
}

// S0 上下文实验用：页面状态采集的**单一出处**在 `src/model/page-context.ts`（实验台与运行期共用）；
// 这里保留同名导出，既有导入面不用改。
export { captureStepStateView, type StepStateView };
export interface AppRunOptions {
  /** 覆盖包的槽位（`--slot k=v`）。值仍然只来自计划。 */
  slots?: Record<string, unknown>;
  /**
   * 决策开关（decision.*）等配置层默认值的解析环境（缺省 process.env）。
   * CLI 入口已用 parseRunDefaults 报过非法值；这里只是让解析环境可注入（测试缝）。
   */
  env?: NodeJS.ProcessEnv;
  /**
   * 时钟缝：把"今天"钉成 `YYYY-MM-DD`（CLI `--today`）。影响数据腿的相对日期表达式
   * （`day_offset` / `next_week` / `weekday_cn`）与 flow 脚本的 `ctx.runtime.today`。
   * 空缺 = 系统日期。（不是环境变量 `LAYA_TODAY`——时钟不是机器配置，
   * 是本次调用的显式参数。）
   */
  today?: string;
  /**
   * 数据腿/工具步日期参数的**完整值袋**（包默认 + CLI `--slot`；调用方负责合并）。
   * 缺省回落到 `slots`（只有 CLI 覆盖）——两个调用方（runApp 的旅程与脚本 toolRunner）
   * 都显式传合并后的袋，source JSON 里的 `{slot}` 占位符从这解析。
   */
  slotBag?: Record<string, unknown>;
  /** 计划 checkpoint 的落盘位置。 */
  planPath?: string;
  /** 跑数据腿（默认跑）。 */
  sources?: boolean;
  /** 浏览器步：危险动作一律拒绝（默认允许并在日志里标注 RISKY）。 */
  confirmSafe?: boolean;
  /** 工具步：允许 `dangerous` 步真跑（默认拒绝）。 */
  allowDangerous?: boolean;
  /** 本次实际用的决策提供者身份（CLI 解析后传入；未提供则产物里没有这个字段）。 */
  providerInfo?: ProviderInfo;
  /** 工具步：注入确认钩子（拿到干跑证据）；返回 false 则拒绝。 */
  confirmToolStep?: (desc: string, evidence: ToolStepEvidence) => boolean | Promise<boolean>;
  verbose?: boolean;
  /** 本次运行的输出目录：工具步的 `{out_dir}` 占位符用它替换（运行期值，不是计划数据）。 */
  outDir?: string;
  /** 本次运行唯一标识：`{run_id}`（默认时间戳 + pid；测试可注入固定值以复现）。 */
  runId?: string;
  /** 测试缝：注入会话工厂。 */
  sessionFactory?: () => Promise<BrowserSession>;
  /**
   * **有头运行**：浏览器窗口可见（CLI `--headful`）。默认关 = 与不传时逐字节等价（headless）。
   * 窗口开在**跑引擎的那台机器**上：本机要有真实显示器，或用虚拟显示（`xvfb-run -a npm run apps ...`）
   * 再配 VNC/noVNC 才能被人看见。
   */
  headful?: boolean;
  /**
   * 把旅程**结束时的页面状态**一并返回（`end_state`）：给"不变量归纳"用
   * （`tools/apps-induce.ts` 拿它与"还没动手时的状态"比，挑出真正被这条旅程改变的、稳定的 DOM 事实）。
   * 默认关：普通运行不需要多付一次页面扫描。
   */
  captureState?: boolean;
  /**
   * `--force-hints off`：**只在内存里**剥掉计划点名的
   * `target_hint`/`target_hints`，让本来被规则包办的步改由决策层回答——"模型到底行不行"
   * 的对照跑法。**包文件一个字节不动**（它是被审计的冻结产物，剥完不许落回去）。
   * 结果 JSON 会写 `hint_ablation: true`：消融跑的产物不许冒充普通跑。
   */
  forceHints?: boolean;
  /**
   * S0（NL Flow）：把每个浏览器子目标的执行证据带进结果
   * （`step_traces`：desc / 状态 / 每一步的 how、desc、method）。提名实验台用它从
   * **已验收语料的实际执行**里取真值指令（truth = 这一步真的执行了什么动作）。
   * 默认关：不开时结果 JSON 与今天逐字节相同（缺省等价纪律，`end_state` 同款）。
   */
  captureTraces?: boolean;
  /**
   * S0 上下文实验：把**每步开始时**的页面状态
   * 采进 `step_traces[i].state_view`（URL/标题/正文摘要/控件能力摘要）。**缺省关**：
   * 不开时与 captureTraces 既有行为逐字节不变（只在需要时多付一次导航 + 一次提取）。
   */
  captureStateView?: boolean;
  modelId?: string;
  /**
   * 本次运行跑在哪个模型层级：`on`（真模型，**默认**）/ `off(missing)`（产物不齐，如实降级）/
   * `off(ablation:scripted-stub)` 与 `off(ablation:rules-only)`（**消融实验臂**，`--ablate` 显式才出现）。
   * 旧名字 `off(rules-only)` 指"装了个脚本桩"——名实不符，随 `--no-model` 统一改名。
   * 由**调用方**（CLI / 套件 / 桥的桩）判定并传入——运行器自己不猜：装进 `installLayaRuntime`
   * 的东西对这里透明，而"真模型在不在"的判定出处在 `src/model/model-artifacts.ts`。
   * 结果 JSON 与桥的 summary 都念这一个值（LAYA_VALUE_PLAN P0：用户先要知道此刻跑在哪层）。
   */
  modelStatus?: string;
  /**
   * 运行级数据集（Slice 2：返回值传递）。缺省 = 本次运行新建一个；注入 = 调用方要
   * 在运行前预置值（测试）/复用同一份（同一进程连跑）。`{dataset:NAME}` 只认它。
   */
  dataset?: DatasetStore;
  /** 决策缓存统计的取数口（调用方装了缓存就给；`runApp` 在旅程跑完后读一次）。 */
  runtimeStats?: () => DecisionCacheStats;
  /** 模型咨询计数的取数口（`countingRuntime` 包一层就给；同样是跑完读一次）。 */
  pickAsks?: () => number;
  /** A3：ask 抛错计数的取数口（`countedProvider` 的失败账；在线 provider 档才有）。 */
  pickFailedAsks?: () => number;
  /**
   * P1 `tieredHint` 的出口（默认关 = 今天逐字节）：hint 档内歧义变成对模型的更小提问。
   * 由 `--tiered-hint` / 桥的 `tiered_hint` 打开，用于线上包 A/B。
   */
  tieredHint?: boolean;
  /**
   * R2：**学习环接主链路**——把"模型选对且推进了子目标"的观察
   * 变成规则（`src/model/hint-memory.ts` 的既有纪律：authored 恒优先、句柄必须稳定、
   * 键 =（精确 url, 子目标））。**学到的永不进被审计的包**——它是 sidecar，
   * 与 plan-cli `--learn-hints` 同一形状；不开这个口时运行器与产物逐字节不变。
   */
  hintMemory?: HintMemoryLike | null;
  /** sidecar 的落点（仅报告用；`--hint-memory FILE` / 默认 `$AMBERFLOW_HOME/hint-memory/<app>.json`）。 */
  hintMemoryPath?: string | null;
  /**
   * 置信度闸门的**本次覆盖**（`--conf-floor N`）。不传 = 让 pack.policy / provider 自报 / 0.25 接管。
   * 为什么需要它：闸门比的是 provider 的 `score`，换 provider（score_kind 不同）时缺省刻度不再成立——
   * 实测 token-plan 在 camera-entry 上有一枪 0.20 被 0.25 硬阻塞。
   */
  confFloor?: number;
  /** provider 自报的闸门刻度（`ProviderInfo.floor`；CLI 装了 provider 就传进来）。 */
  providerFloor?: number;
  /** 非交互调用遇到 manual 步时：不启动浏览器，直接返回 needs_human 结果。 */
  manualFailFast?: boolean;
  /**
   * 介入/救援开关（设计 §8 步 2/5，v1 真实生产路径）：`--rescue` = 本次运行允许 result.rescue
   * 键出现（真实人工停因的结构化求援，mode=stop）；默认关 = 产物逐字节不变。
   * 分类器语义：只映射 kind（action/value/authorization），不改 stopCode/status/控制流。
   */
  rescue?: boolean;
  /** 分段运行：只跑第 N 步（1-based，`expanded.steps` 的声明序号）。不能与 fromStep 同用。 */
  onlyStep?: number;
  /** 分段运行：从第 N 步开始（1-based）。 */
  fromStep?: number;
  /** 分段运行：本次最多执行几步（与脚本应用的 ctx maxSteps 区分）。 */
  segmentMaxSteps?: number;
  /**
   * `confFloor` 的来源：`cli`（本次命令旗标）或 `config`（配置文件默认值）。
   * 只影响 `effective_policy` 的账，不改变数值；缺省按 `cli` 记（兼容既有调用）。
   */
  confFloorSource?: "cli" | "config";
  /**
   * 人工步的接入钩子（测试/嵌入方）。缺省 = 终端交互提示；返回 false = 人放弃。
   * CLI 不提供"自动 yes"：人工步必须真的有人；这是它与"自动登录"的分界。
   */
  manualHandler?: (req: ManualStepRequest) => boolean | Promise<boolean>;
  /** 运行节奏覆盖（本次显式；缺省 = pack.pace > 环境变量 > 0）。 */
  pace?: PackPace;
}

/**
 * B1 节奏统一：实现整体迁入 `src/support/pace.ts`（engine/app/online 三脸共用同一份
 * 语义与 env 口径），这里保留**转口**——既有导出面与消费方零感知：`Pick<AppPack,…>`
 * 签名不变，坏 env 值仍以 `AppRunConfigError` 报出（走 :runCmd 的「未开跑」配置类错误分支）。
 */
export type { PaceSource, ResolvedPace };

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
export const cleanStampAttrs = (): void => {
  const doc = (globalThis as unknown as {
    document?: { querySelectorAll(sel: string): ArrayLike<{ removeAttribute(name: string): void }> };
  }).document;
  if (!doc) return;
  const els = doc.querySelectorAll("[data-dshref],[data-hintref]");
  for (let i = 0; i < els.length; i++) {
    els[i].removeAttribute("data-dshref");
    els[i].removeAttribute("data-hintref");
  }
};

/**
 * 一次运行的"决策来源"汇总（LAYA_VALUE_PLAN P1）——把散在 step 日志里的判定方式变成三组数：
 * 出场率（模型步/总步 + conf）、reobserve 挽回、缓存节约。**纯汇总口径，无新机制**：
 * 数据就是执行器 trace 里已有的 `method`/`conf`，这里只是数一遍。
 */
export interface AppDecisions {
  /** 浏览器动作腿里"有判定"的步数（trace 条目数；跳过的子目标不产生判定）。 */
  total_steps: number;
  /** 各判定方式的计数：`rule:match` / 决策源真名（`decision-service`、本地档 `laya`）+ `:reobserve`/`:adjudicated` 后缀 / `escalate` / 其他。 */
  by_method: Record<string, number>;
  /**
   * 模型被咨询的决策数（运行时缝上数的，含没过置信闸门的那些）。
   * 模型票只统计**过关并执行了**的咨询；咨询而没过闸门不在 trace 里留
   * `method`（执行器在 `low confidence` 处直接 break），所以"保险碰没碰过"必须看这个数。
   */
  model_asks: number;
  /**
   * task-24/4：模型面参与度（评审 A.4 因果纠正——strict/rules-only 不改变模型参与度，只改
   * 未命中兜底与风险票来源）。`idle` = 本次 run 0 模型咨询 + 0 模型梯级（规则面全命中或全
   * 未命中都算 idle——它只描述参与度，不是异常）；`engaged` = 模型面真被咨询过。
   */
  model_face: "idle" | "engaged";
  /**
   * A3：ask **抛错**的次数（HTTP 403/超时/DNS 等基础设施失败）。它与"未过闸门"是两回事：
   * 闸门是对模型意见打分，抛错说明根本没拿到意见——混在一起会把一次 403 伪装成
   * 「模型很没把握」。只统计在线 provider 档（countedProvider 的失败账；laya 档恒 0）。
   */
  failed_asks: number;
  /** 过关执行的模型步（含 :reobserve/:adjudicated 变体；escalate 是老师点名，另列）。 */
  model_steps: number;
  /** 加宽重看（`<provider>:reobserve`）的步数——从"低置信要停"边缘救回来的那一步。 */
  reobserve: number;
  /** escalate 步数（LLM 老师点名，非本地模型）。 */
  escalate: number;
  /** 过关模型步的 conf 分布（n/min/max；n=0 时 min/max 为 null）。 */
  conf: { n: number; min: number | null; max: number | null };
  /**
   * U8：被置信闸门拒绝的 ask 子集的 conf 分布（n=0 或无被拒时字段缺席）。口径与既有
   * `conf`（过关模型步的 trace 分布）互补并存：这里记的是**模型意见在 floor 处被丢弃**
   * 的 ask——主闸门拒绝后 reobserve/escalate 换意见或 low_confidence 停（R8 p3-broad
   * 的 ask1 形状）；adjudicate/priorHit 复用的意见不算（它们的 conf 走 trace 进 `conf`）。
   * R8 J3（幸存者偏差）：校准 floor 前必须补这个观测量。计数在执行器闸门分支
   * （`rejectedAskConfMetrics`），这里只投影。
   */
  rejected_conf?: { n: number; min: number | null; max: number | null };
  /** 决策缓存（装了才有）：命中数与提问总数。 */
  cache: { hits: number, misses: number } | null;
  /**
   * 梯级账单：每一级"到达 / 决定 / 问了但没过闸门"。
   * **救回**的诚实定义 = 该级独立决定的步数（低一级没决定的那一步才轮得到它——
   * trace 里 `method` 就是这么记的，所以不需要反事实重跑）。整条梯级在语料上决定 0 步
   * 就是 `dead rung`，由套件在**聚合层**判定（单应用看不出全貌，见 tools/apps_suite.ts）。
   */
  ladder: { rule: number; model: number; reobserve: number; escalate: number; adjudicated: number; asked_not_passed: number };
  /**
   * S5 状态接入决策的指标（`meta.policy.decision_state` 声明了才出现——
   * 两项都 off 时**这四个键全部缺席**，默认档产物逐字节不变）。计数在执行器决策路径
   * （`DecisionStateMetrics`），这里只做投影，不重算：
   *   asks_saved / gate_waits = 状态闸门省掉的 ask 数 / settle 实际等待次数；
   *   context_sent / context_skipped = 带 state_digest 的请求数 / provider 不支持而跳过的请求数。
   */
  asks_saved?: number;
  gate_waits?: number;
  context_sent?: number;
  context_skipped?: number;
  /** 一行汇总，人读与机器读同一份：`rule 19 · model 1 (decision-service, conf 0.31) · 咨询 5 · reobserve 1 · cache 6/12`。 */
  line: string;
}

/** trace + 咨询计数 → 汇总。口径写死在这一个函数里，套件/矩阵/桥/报告四处念同一份数。
 *  A3：`failedAsks` 是 ask 抛错（基础设施失败）的次数——它算「被咨询」（敲门发生了），
 *  但**不算**「未过闸门」（没有意见可打分）。 */
export function summarizeDecisions(
  steps: TraceStep[], cache: DecisionCacheStats | null, modelAsks = 0, failedAsks = 0,
  decisionState: DecisionStateMetrics | null = null,
  /** U8：执行器闸门分支记的被拒 ask conf 分布；n=0/缺省 ⇒ 字段缺席（dry 面同构）。 */
  rejectedConf: { n: number; min: number | null; max: number | null } | null = null,
): AppDecisions {
  const byMethod: Record<string, number> = {};
  const modelConfs: number[] = [];
  const modelBases = new Set<string>();   // 本次出现过的决策源名（去重；进汇总行）
  const bucketed = new Set<string>();     // 已进 rule/model/escalate 桶的 method 名；其余进 extra
  let rule = 0, model = 0, reobserve = 0, adjudicated = 0, escalate = 0;
  for (const t of steps) {
    const m = typeof t["method"] === "string" ? t["method"] : "other";
    byMethod[m] = (byMethod[m] ?? 0) + 1;
    // 粗分类读 trace 自带的 decision_kind（method 显示名跟着 provider 走，
    // 聚合不能跟着显示名漂）；无该字段的旧 trace（replay 的历史证据）按旧精确串回退。
    const kind = t["decision_kind"];
    const isModel = kind === "model"
      || (kind === undefined && (m === "laya" || m === "laya:reobserve" || m === "laya:adjudicated"));
    if (isModel) {
      model += 1;
      bucketed.add(m);
      modelBases.add(m.replace(/:(reobserve|adjudicated)$/, ""));
      if (m.endsWith(":reobserve")) reobserve += 1;
      if (m.endsWith(":adjudicated")) adjudicated += 1;
      if (typeof t["conf"] === "number") modelConfs.push(t["conf"]);
    } else if (kind === "rule" || (kind === undefined && m === "rule:match")) {
      rule += 1;
      bucketed.add(m);
    } else if (kind === "escalate" || (kind === undefined && m === "escalate")) {
      escalate += 1;
      bucketed.add(m);
    }
  }
  // 汇总行里模型票内联决策源真名（单源时）；混源/未知就不点名，明细在 by_method/traces。
  const baseTag = modelBases.size === 1 ? [...modelBases][0]! : "";
  const confTag = modelConfs.length ? `conf ${Math.max(...modelConfs).toFixed(2)}` : "";
  const modelTags = [baseTag, confTag].filter(Boolean).join(", ");
  const parts = [
    `rule ${rule}`,
    `model ${model}` + (modelTags ? ` (${modelTags})` : ""),
    `reobserve ${reobserve}`,
    // A2′：只有真发生过裁决才出现在这一行（缺省等价的纪律，同 path_visits）。
    ...(adjudicated ? [`adjudicated ${adjudicated}`] : []),
    `escalate ${escalate}`,
  ];
  // 咨询数与过关数并排放：差值就是"问了但没过闸门"的那几次——它们不在 trace 里，
  // 但它们是保险被碰过的直接证据（slowjet 的冷加载正是这一形状）。
  // A2′：裁决过的也算"过了"（被执行了，只是没过置信闸门、改由信号裁决），否则会把
  // 一次真救回来的裁决错记成"问了没用"。
  // A3：抛错的 ask 单独成账（"K 次失败"）——它是基础设施故障，不是模型意见没过闸门；
  // 把它混进「未过闸门」会把一次 403 说成「模型很没把握」（R3/R8 排查被这句话带偏）。
  const passed = model;
  const gateMissed = Math.max(0, modelAsks - passed - failedAsks);
  if (modelAsks !== passed || failedAsks > 0) {
    const detail = [
      ...(gateMissed > 0 ? [`${gateMissed} 次未过闸门`] : []),
      ...(failedAsks > 0 ? [`${failedAsks} 次失败`] : []),
    ].join("，");
    parts.push(`模型被咨询 ${modelAsks} 次` + (detail ? `（${detail}）` : ""));
  }
  for (const [m, n] of Object.entries(byMethod)) {
    if (!bucketed.has(m)) parts.push(`${m} ${n}`);
  }
  if (cache !== null) {
    parts.push(`cache 命中 ${cache.hits}/${cache.hits + cache.misses} forwards`);
  }
  // S5：状态接入决策的账（只在策略声明时打印——全 0 也打印，说明这一臂真的跑过）。
  if (decisionState !== null) {
    const bits = [
      `asks_saved ${decisionState.asks_saved}`,
      `gate_waits ${decisionState.gate_waits}`,
      `digest ${decisionState.context_sent}`,
    ];
    if (decisionState.context_skipped > 0) bits.push(`digest_skipped ${decisionState.context_skipped}`);
    parts.push(`state ${bits.join(", ")}`);
  }
  return {
    total_steps: steps.length,
    by_method: byMethod,
    model_asks: modelAsks,
    failed_asks: failedAsks,
    model_steps: model,
    reobserve,
    escalate,
    ladder: {
      rule,
      // 梯级账单（键名 model）：决策源真名进 trace.method，聚合按粗分类。
      model,
      reobserve, escalate,
      // A2′：裁决级单独计数（梯级账单要能看见"这一级今天兜回过没有"）。
      adjudicated,
      // A3：`asked_not_passed` 只数"问了、模型真给了意见、但没过闸门"的——抛错的那几次
      // 挪进 `failed_asks`（顶层字段），不再把基础设施失败伪装成低置信。
      asked_not_passed: gateMissed,
    },
    conf: {
      n: modelConfs.length,
      min: modelConfs.length ? Math.min(...modelConfs) : null,
      max: modelConfs.length ? Math.max(...modelConfs) : null,
    },
    // U8：被拒 ask 的 conf 分布（只在真发生过被拒时出现 = 产物缺省等价；dry 面无 ask ⇒ 缺席）。
    ...(rejectedConf !== null && rejectedConf.n > 0 ? { rejected_conf: rejectedConf } : {}),
    cache: cache === null ? null : { hits: cache.hits, misses: cache.misses },
    // task-24/4：模型面参与度（评审 A.4——"strict×rules-only 空转"的因果纠正：模型唯一入口
    // 是 ruleRef===null 的 pickElement，与 strict 无关）。idle = 0 咨询 + 0 模型梯级
    // （规则面全命中或全未命中都算 idle——它只描述参与度，不是异常）。
    model_face: modelAsks === 0 && model === 0 ? "idle" : "engaged",
    // S5：默认档（两项 off）这四个键全部缺席 = 产物逐字节不变（声明了才投影，全 0 也写）。
    ...(decisionState === null ? {} : {
      asks_saved: decisionState.asks_saved,
      gate_waits: decisionState.gate_waits,
      context_sent: decisionState.context_sent,
      context_skipped: decisionState.context_skipped,
    }),
    line: parts.join(" · "),
  };
}

export interface ToolStepEvidence {
  desc: string;
  source: string;
  argv: string[];
  dry_run: { code: number; ok: boolean; stdout: string; stderr: string } | null;
}

export interface ToolStepResult {
  index: number;
  desc: string;
  source: string;
  /** 声明式 journey 的 cli/ssh/stdio 步有完整进程事实；flow 脚本路径的投影从 trace 事件
   *  重建，只有声明面拿到的那部分（`signal`/`argv`/`dry_run` 不硬造，缺省缺席）。 */
  signal?: ToolSignal;
  argv?: string[];
  attempts: number;
  done: boolean;
  /** 显式拒绝的原因：`dangerous`（没允许）/ `declined`（确认函数说不）/ `dry-run-failed` */
  /**
   * 显式拒绝/失败的原因：
   *   dangerous        —— 危险步没拿到许可（默认行为）
   *   declined         —— 确认钩子说不
   *   dry-run-failed   —— 干跑不成功，所以不 apply
   *   tool-unavailable —— 命令根本起不来（缺二进制 / 超时被杀 / argv 非法）：
   *                       这是**结果**不是崩溃——上层要能在结果 JSON 里读到它。
   */
  refused?: "dangerous" | "declined" | "dry-run-failed" | "tool-unavailable" | "needs_value" | "config_error";
  dry_run?: { code: number; ok: boolean; stdout: string; argv: string[] } | null;
  code: number | null;
  ok: boolean;
  stdout?: string;
  stderr?: string;
  /** Slice 2：本步信号成立后抽取出的返回值（runner 同时写进运行级数据集）。 */
  returns?: Record<string, unknown>;
  /** T1：工具步工件在 outDir 内的相对路径（`tool-steps/01-….json`；缺省 = 没有工件）。 */
  artifact?: string;
  /** T1/T6：本步耗时（毫秒；flow 脚本路径的投影必有，声明式路径缺省）。 */
  elapsed_ms?: number;
  /** T6：stderr 尾部摘要（有界；失败诊断与 trace 的 `stderr_tail` 同源）。 */
  stderr_tail?: string;
  /** T4：信号不成立时的结构化诊断（path/类型/值摘要、exit/stdout 期望与实测），
   *  由 `explainToolSignal` 生成；信号成立或缺省时不出该字段。 */
  reason?: string;
}

export interface AppInvariantResult {
  id: string;
  desc: string;
  held: boolean;
  /** Slice 4：非 web 不变量的类型（web 不变量不写此字段，既有产物逐字节不变）。 */
  adapter?: string;
}

/**
 * **拒绝原因的唯一定义**。同一个状态若有三处说法会漂移：CLI 说 `REFUSED (dangerous)`、
 * 单应用报告的表里写 `**dangerous**`（那是类别，不是结论）、套件说"待放行(未执行)"——
 * 单独把 .md 发给别人看，它像一次成功的干跑。现在三个界面都念这一张表，
 * 并且一律把"怎么补救"和"有没有落盘"写在同一句里。
 */
export const REFUSAL_LABELS: Record<string, string> = {
  dangerous: "未执行（危险步未放行；加 `--allow-dangerous` 可放行，本次未落盘）",
  declined: "未执行（确认函数拒绝；未落盘）",
  "dry-run-failed": "未执行（干跑没通过，所以没有 apply）",
  "tool-unavailable": "未执行（命令起不来：缺二进制 / 超时 / argv 非法）",
  "needs_value": "未执行（{dataset:NAME} 引用的数据没有值——前序步骤没产生它或已失效；不猜）",
  "config_error": "未执行（source 日期参数配置错：default_dates/槽位值非法或缺值——补 --slot 或修 source JSON）",
};

/** 给 CLI 用的一行短语（不带 Markdown 反引号）。 */
export function refusalLine(refused: string): string {
  return (REFUSAL_LABELS[refused] ?? `未执行（${refused}）`).replace(/`/g, "");
}

export interface AppSourceResult {
  name: string;
  rows: number;
  counts: Record<string, number>;
  selects: Record<string, string>;
  /**
   * 数据源声明了 `report.preview` 时的"前 N 条原始行"（`previewTable` 算，与数据源
   * 报告同一个实现）。counts/selects 是**结论**，原始行是**证据**——报告两者都要有，
   * 否则"为什么是这个数"只能靠信。
   */
  preview?: PreviewTable;
  tool_version?: string;
  /**
   * 按日期键控的完整观察（声明了 `default_dates: "{slot}"` / 范围且解析出多日期时）。
   * `rows`/`counts` 仍是第一天的快照（与 source_slots 回写同一口径）；被风控挡住的
   * 日期不进这张表（错误进数据源报告）。
   */
  byDate?: Record<string, {
    url?: string;
    counts: Record<string, number>;
    selects: Record<string, Record<string, string> | null>;
    rows: Array<Record<string, string>>;
  }>;
}

/**
 * A1 子改动③：executor 已执行动作的 after 内容签名（`TraceStep.after`，DOM diff 的最小形态：
 * 动作后一次观察的 {url, pool_size, first_text?}）。executor 侧形状是数据性的（`TraceStep` 带
 * 索引签名），透传前在这里收口成显式形状——形状不对按 null 记，不透传垃圾。
 */
export interface AfterSignature {
  url: string;
  pool_size: number;
  first_text?: string;
}

export function asAfterSignature(v: unknown): AfterSignature | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o["url"] !== "string" || typeof o["pool_size"] !== "number") return null;
  return {
    url: o["url"],
    pool_size: o["pool_size"],
    ...(typeof o["first_text"] === "string" ? { first_text: o["first_text"] as string } : {}),
  };
}

/**
 * B2（P5 证据增强）：本次运行的**环境与会话**事实。数据类任务的结论（如「最低价」）受
 * 会话/日期/币种影响（R5 会话缓存、R6 两轮 2/8 变动、R8 三会话刻画），结果不带这些字段时
 * Agent 每轮都要自建判别实验。口径**只增不改**：run_id/时间戳必有；会话页面上拿不到的键
 * 省略（不硬造）——replay 等无会话路径自然缺 final_url/viewport/user_agent。
 */
export interface AppRunEnv {
  /** 与 `{run_id}` 占位符 / trace 同源的本次运行唯一标识。 */
  run_id: string;
  /** 运行开始/结束时刻（ISO 8601 UTC）。 */
  started_at: string;
  finished_at: string;
  /** 会话收尾时的页面 URL（在会话关闭**前**读；读不到/无会话省略）。 */
  final_url?: string;
  /** 会话视口（页面 `viewportSize()` 优先，`meta.device` 声明兜底；拿不到省略）。 */
  viewport?: { width: number; height: number };
  /** 会话的实际 User-Agent（页面 `navigator.userAgent`；拿不到省略）。 */
  user_agent?: string;
}

export interface AppRunResult {
  app: string;
  label: string;
  goal: string;
  pack_path: string;
  plan_path: string;
  /** 角色模板出场（01 轮 B7：flow 脚本路径恒空——空则整字段省略，产物不再带无解释的 `[]`）。 */
  roles_used?: string[];
  slots: Record<string, unknown>;
  completed: string;
  subgoals: Array<Record<string, unknown>>;
  tool_steps: ToolStepResult[];
  invariants: AppInvariantResult[];
  /** Slice 4：混用 ≥2 种应用类型时，按旅程声明的类型计数（缺字段 = 单一类型）。 */
  step_types?: Record<string, number>;
  sources: AppSourceResult[];
  /** 人工步骤的执行记录（缺字段 = 旅程里没有人工步，既有产物逐字节不变）。 */
  manual_steps?: Array<{
    index: number;
    desc: string;
    done: boolean;
    /** 人自证（`{manual:true}`），不是 DOM 验证。 */
    attested?: boolean;
    reason?: string;
  }>;
  /** 结构化求援（stop 模式）：仅 --rescue 开且最终停因命中映射时出现；缺字段 = 产物逐字节不变。 */ rescue?: RescueRequest;
  /** 本次生效的节奏（B1：任一键非 0 或来源非 default 才出现；默认档逐字节不变）。 */  pace?: ResolvedPace;
  /**
   * 数据腿**真的写回槽位**的那部分（`source_slots` 的回写结果）。缺字段 = 没有回写
   * （缺省等价纪律）。有了它，报告才说得出"这个值是查出来的，还是人写死的"。
   */
  source_slots?: Record<string, string>;
  ok: boolean;
  /**
   * P0-E 完成语义诚实：**失败步计账**——`step_traces` 里 `status:"failed"` 的步数
   * （仅 **>0 时出现**；`skipped`（when 不适用）/`recovered`（瞬断后挽回）不算失败）。
   * `ok`/`verified` 语义**不变**：脚本容忍的步失败是数据不是判死——受阻交付
   * （run 绿但数据 null）必须用交付 JSON + notes 表达，报告摘要点名「失败步 n」。
   */
  steps_failed?: number;
  /**
   * eval3 曝光面：run summary 警告计数（`warnings` 数组的长度）——**仅 n>0 时出现**
   * （与 steps_failed 同口径：clean run 键集与基线逐字节一致）。警告是执行期诚实性
   * 证据（false_done guard / frames_excluded / pool_empty / suspected_async…），
   * 不是完成判死；report.md 摘要行同步带「警告 n」（仅 n>0）。
   */
  warnings_count?: number;
  /**
   * 停因决策回执（additive）：**仅**在该 run 于动作前停止、且选择段确实问过模型时出现；
   * 缺字段 = 没有这个事实（无询问 / 已发生动作 / 正常完成 ⇒ 键不出现，既有产物逐字节不变）。
   * 形状与引擎 `RunReport.stop_decision_context` 同源（type-only 复用 `DecisionLayerReceipt`）。
   */
  stop_decision_context?: { layers: import("../engine/decision-ask-contract.ts").DecisionLayerReceipt[] };
  /** 本次是分段运行：`ok` 只代表段内步骤成功，不代表整条旅程验收。 */
  partial?: true;
  /**
   * A6：本次是 walk 调试跑（`--walk`：ctx.step 同页重锚不重导航，SPA 状态跨步保留）。
   * 缺字段 = 正式语义（默认模式逐字节不变）。walk 是调试面——walk 产物不得冒充正式 run。
   */
  walk?: true;
  /** 完整旅程且不变量成立；分段跑为 false。 */
  verified?: boolean;
  /** 本次实际执行的声明步骤区间（1-based，闭区间）。 */
  segment?: { from: number; to: number };
  secs: number;
  /**
   * B2（P5）：环境与会话（见 `AppRunEnv`）。flow 路径（`runScriptApp`）恒有
   * （run_id/时间戳必有）；旧声明式路径不带 ⇒ 报告同节也整体省略，排版不变。
   */
  env?: AppRunEnv;
  /**
   * P4 走向的显式停因：`next` 边把同一个步 id 走进了环，路径上界到顶就停在这里——
   * 结构化的 code（不是散文），点名哪一步、进入了几次（§7-P4 的验收台：不是挂死、不是栈溢出）。
   */
  path_stop?: { code: "next_cycle"; step_id: string; visits: number; detail: string };
  /**
   * P4 走向的实数：每个**有名字**的步被进入了几次（`next` 回边会 >1）。
   * `completed` 数的是步数（计划形状），这里数的是**走法**——一次旅程走回来过，
   * 报告必须说得出这件事，否则回边是隐形的。
   */
  path_visits?: Record<string, number>;
  /**
   * P4 走向的另一半事实：被声明式边**跨过去**的步（记成 `skipped`，这里点名是谁跨的）。
   * 与"`when` 不成立所以跳过"分开报——两者的原因不同，报告不该把它们混成一句话。
   */
  path_crossed?: string[];
  /**
   * 生效的运行策略与它的来源（§3）：让"这次跑的是什么策略"成为产物的一部分——
   * 否则同一个包含义随命令行变，而报告看不出来。
   */
  /** 本次实际用的决策提供者（名字/版本/能力）。换模型 A/B 的对照就靠它。 */
  decision_provider?: ProviderInfo;
  /**
   * 运行期结构化证据（缺字段 = 没有需要留证的事件，产物逐字节不变）。
   * 目前只有 `navigation`：`meta.policy.navigation:"entry-only"` 拦下的直接导航
   * `{policy:"entry-only", attempted, current}`（stop_code=navigation_forbidden 的配套证据）。
   */
  diagnostics?: { navigation?: { policy: string; attempted: string; current: string } };
  /** §3 生效策略（单一出处 `EffectivePolicy`；缺省键不出现 = 与今天一致）。 */
  effective_policy?: EffectivePolicy;
  /** 本次实际用的决策提供者身份（CLI 解析后传进来；未提供则缺字段）。 */
  providerInfo?: ProviderInfo;
  /** 模型层级（`on` / `off(missing)` / `off(ablation:…)`；未提供则缺字段）。 */
  model_status?: string;
  /**
   * 风险判定退化的原因（provider 的风险头调用失败 ⇒ 本次只用了关键词规则）。
   * 缺字段 = 没退化过。见 `src/engine/executor.ts` 的 `riskDegraded`。
   */
  risk_degraded?: string;
  /** 在线 provider 掉线/没配好 ⇒ 本次降级到 rules-only 的原因。缺字段 = 没降级。 */
  provider_degraded?: string;
  /** 决策来源汇总（见 `AppDecisions`；LAYA_VALUE_PLAN P1 的"出场率/挽回/缓存"三组数）。 */
  decisions?: AppDecisions;
  /**
   * R2：本次开了学习环时的账（sidecar 落点 + 已知/复用/被拒的条数）。
   * **缺字段 = 没开**——不开时产物逐字节不变（path_visits/effective_policy 的同一条纪律）。
   */
  hint_memory?: { path: string | null; entries: number; used: number; rejected: number };
  /** `captureState: true` 时的旅程结束状态（见 `RunOptions.captureState`）。 */
  end_state?: StateView;
  /** Slice 2：运行级数据集的审计视图（含陈旧世代与溯源；缺字段 = 没有 returns）。 */
  dataset_view?: DatasetEntry[];
  /**
   * S0（NL Flow）：`captureTraces: true` 时的每浏览器步执行证据。缺字段 = 没开
   * （缺省等价的纪律：新字段不该只是"多一行没人看的数"）。
   */
  step_traces?: Array<{
    index: number;
    id: string | null;
    desc: string;
    status: string;
    /** 每个执行过的动作的 `how`（clicked / filled / …）。 */
    hows: string[];
    /** 每个执行过的动作的人读描述（`click button "…"` / `type text into select …`）。 */
    descs: string[];
    /** 全部 trace 行的判定方式（与 `decisions.ladder` 同一口径）。 */
    methods: string[];
    /**
     * 每个已执行动作的 after 内容签名（与 `hows` 一一对齐；该动作无签名记 null；
     * **整步所有动作都没有签名时整个字段省略**）。A1 子改动③：动作后一次观察的
     * `{url, pool_size, first_text?}`——相邻动作的 `after.first_text` 对比即可判
     * 「点击后列表是否前进」。done 立即成立的收尾动作没有下一次观察，不补签名。
     */
    afters?: Array<AfterSignature | null>;
    /** step/arrive 的落地 URL；tool 步没有。 */
    url?: string;
    /** 失败时的结构化停因。 */
    stop_code?: string;
    /** 该次调用的结构化结果摘要（与 trace event 的 result 同一口径）。 */
    result?: unknown;
    /** `captureStateView: true` 时这一步**开始时**的页面状态（缺字段 = 没开，缺省等价纪律）。 */
    state_view?: StepStateView;
    /** 该 step transient failed，但后续 step / done 信号成立（仅引擎/驱动观察，不改变完成真值）。 */
    recovered?: boolean;
    /** 恢复它的后续 step 标识/描述（仅 recovered=true 时出现）。 */
    recovered_by?: string | null;
    /**
     * A1 动作执行证据（全部缺省省略）：`executed=false` + `skipped_actions` 是"完成裁决为真、
     * 但一个动作都没执行"的显式证据——让"信号本来就成立"与"动作推进了页面"分得开。
     */
    executed?: boolean;
    executed_actions?: ExecutedAction[];
    skipped_actions?: SkippedAction[];
    /** 命令步动作前对 done 的预评估结果。 */
    done_preheld?: boolean;
    /** 运行期诚实性警告（如 suspected_async）。 */
    warnings?: string[];
    /**
     * S1 状态记录：before/after 指纹、动作计数、前进性 flags、effect 读回。
     * 缺字段 = 没有页面观察（replay/旧产物）；dry 面给合成值（epoch=0、flags=[]）。
     */
    state?: StepStateRecord;
  }>;
  /**
   * S1 run summary warnings：跨步汇总的执行期诚实警告（如 suspected_async、
   * done_preheld/no_state_progress）。缺字段 = 没有警告。
   */
  warnings?: string[];
  /** `ctx.log` 摘要（Agent 不必再读 emit-trace 就能看到业务事实）。 */
  logs?: Array<{ i: number; desc: string; result?: unknown }>;
  /**
   * L2 脚本应用的运行账（缺字段 = 旧 `pack.json` 应用，产物逐字节不变）。
   * 脚本应用的"完成了什么"在**轨迹**里，不在静态计划里——这三样是审计最小集。
   */
  script?: {
    mode: "flow";
    script_path: string;
    /** 执行了多少个 `ctx.step`/`ctx.arrive`（含未完成的尝试；flow 的"步骤总数"只能是运行期事实）。 */
    steps: number;
    script_sha256: string;
    plan_sha256: string;
    trace_path?: string;
    stop_code?: string;
    stop_reason?: string;
  };
}

/** 跑一个工具步：干跑（若声明）→ 确认（若不可逆）→ apply（按幂等性决定重试）。 */

/** 从 trace 的 `done` 事件里取不变量结果（脚本应用的验收事实）。 */
export function invariantsFromTrace(
  trace: AppTrace,
  pack: { invariants?: ReadonlyArray<{ id?: string; desc?: string }> },
): AppInvariantResult[] {
  const done = [...trace.events].reverse().find((e) => e.call === "done");
  const raw = done !== undefined && typeof done.result === "object" && done.result !== null
    ? (done.result as { invariants?: unknown }).invariants
    : undefined;
  const details = Array.isArray(raw) ? raw as Array<{ id?: unknown; held?: unknown }> : [];
  return (pack.invariants ?? []).map((inv) => {
    const id = String(inv.id ?? "?");
    const hit = details.find((d) => String(d.id ?? "?") === id);
    return { id, desc: String(inv.desc ?? ""), held: hit?.held === true };
  });
}
