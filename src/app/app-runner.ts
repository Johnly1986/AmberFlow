/**
 * 应用运行器 —— `apps/<app>/app.mjs` 的 `flow(ctx)` 跑完一条完整链路：
 *
 *   数据腿（`sources`，同一套 datasource 引擎）
 *        ↓
 *   脚本（`flow`）：`ctx.step` / `ctx.arrive` → 唯一的生产执行器
 *                   `ctx.run` / `ctx.dangerous` → 进程观察面信号 + 干跑/确认/幂等
 *        ↓
 *   验收（`ctx.done()` 在同一浏览器会话的结束状态上断言 `meta.invariants`）
 *
 * 它**不分叉执行器**：浏览器步就是 `runSubgoalWithRetries`（执行循环始终是 `BrowserMiddleware.run`），
 * 只是把会话的生命周期握在自己手里——会话在**第一个**浏览器步时才创建，并且推迟 `close()`，好让旅程结束后的不变量还能在同一页面/cookie 上求值。
 * 之所以不再整段交给 `runPlan`：旅程现在混了两种面（DOM / 进程），`runPlan` 只认识 DOM 步。
 *
 * 工具步的三条纪律（都来自"浏览器里重点一次很便宜、命令行重跑可能不可逆"）：
 *   1. **默认不重试**：`retries > 0` 必须显式 `idempotent: true`（加载期校验）；
 *   2. **不可逆先干跑**：`dangerous: true` 必须有 `dry_run_args`，干跑不成功就不 apply；
 *   3. **确认才动手**：`dangerous` 步默认**拒绝**，只有 `--allow-dangerous`（或注入的
 *      `confirmToolStep`）点头才执行；拒绝会作为显式结果上报，不是静默跳过。
 *
 *   node --experimental-strip-types src/app/app-runner.ts --list
 *   node --experimental-strip-types src/app/app-runner.ts --app <id>                  # 真模型（默认）
 *   node --experimental-strip-types src/app/app-runner.ts --app <id> --ablate stub     # 消融：脚本桩
 *   node --experimental-strip-types src/app/app-runner.ts --app <id> --dry             # 只展开计划
 */
import { type EffectivePolicy, declaredPageUrls, preflightConfig, probeCompatDecisionPlane, promptManualOnTty, resolvePace, resolveRunPolicy } from "./app-runner-policy.ts";
import { runToolStep } from "./app-runner-tool-step.ts";
import { type AppInvariantResult, type AppRunOptions, type AppRunResult, type AppSourceResult, type ToolStepResult, asAfterSignature, cleanStampAttrs, refusalLine, summarizeDecisions, invariantsFromTrace } from "./app-runner-types.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { MockAuditor, type TraceStep } from "../engine/audit.ts";
import { createHintMemory, type HintMemoryLike } from "../model/hint-memory.ts";
// task-14（D1）：起跑探测（与 doctor 共享单一出处）。
import { probeDecisionPlane } from "../model/decision-probe.ts";
// task-15（D2）：SITE_FACTS 边缘注入（run 起跑提示 + result.site_facts；仅命中出现）。
import { loadSiteFacts, matchSiteFacts, renderModelFence, renderSiteFactLines } from "./site-facts.ts";
import { ensureDir, userAppsDir } from "../support/amberflow-home.ts";
import { appOptions, cliBool, cliString, cliStrings, parseCliArgs } from "../support/cli-args.ts";
import { DEFAULT_CONF_FLOOR } from "../support/config-schema.ts";
import { applyConfiguredEnv } from "../support/apply-config-env.ts";
import { parseRunDefaults } from "../support/run-defaults.ts";
import { readString } from "../support/env.ts";
import { DONE_POLL_INTERVAL_MS, NAVIGATION_GOTO_TIMEOUT_MS, SETTLE_QUIET_MS, SETTLE_TIMEOUT_MS } from "../support/tuning.ts";
import { decisionServiceConfigured } from "../support/decision-env.ts";
// B1 节奏统一：语义与 env 口径的唯一来源在 support/pace.ts（engine/app/online 三脸共用，无环）。
import { PaceConfigError, paceNonDefault, paceRemainder, resolvePace as paceResolve } from "../support/pace.ts";
import { sleepMs } from "../support/sleep.ts";
// §8 步 2 影子模式接线：记录器 + 开关（仅 AMBERFLOW_RESCUE_SHADOW=1 创建；缺省零行为变化）。
import { createShadowRecorder, isRescueShadowEnabled, type ShadowRecorder } from "./intervention-shadow.ts";
import { pickManualApprover, shadowManualOutcome, RescueRequestBuilder, journeyRescueInput, lastManualFactsFromTrace, rescueField, type RescueRequest } from "./intervention-adapter.ts";
import type {  PaceSource, ResolvedPace  } from "../support/pace.ts";
import { cliRunDetailed, defaultDates, loadSource, previewTable, runSource, urlFor, ValueError, type CliObservation, type PreviewTable } from "../data/datasource.ts";
import { type CachedRuntime, type DecisionCacheStats } from "../model/decision-cache.ts";
import { checkArtifacts, missingPieces, modelConfigError } from "../model/model-artifacts.ts";
import { resolveLocalCheckpoint } from "../model/checkpoint.ts";
import { activeProviderInfo, applySpecToRuntime, resolveProviderSpec, type ProviderInfo } from "../model/decision-provider.ts";
import { BrowserMiddleware, browserSession, disallowedHost, type BrowserSession, type DecisionStateMetrics, type DecisionStatePolicy, type ExecutedAction, type SkippedAction, type StepStateRecord } from "../engine/executor.ts";
import { urlOf } from "../engine/extraction.ts";
import { REPO } from "../flow/flow.ts";
import { installLayaRuntime } from "../model/model.ts";
import { runSubgoalWithRetries } from "../engine/planner.ts";
import { checkSignal } from "../engine/signals.ts";
import { checkToolSignal, explainToolSignal, type ToolSignal } from "../browser/tool-signals.ts";
import { channelFromEnv } from "../browser/browser-env.ts";
import { captureStateView } from "../flow/signal-induction.ts";
import { captureStepStateView, type StepStateView } from "../model/page-context.ts";
import { runExecution } from "../engine/run-execution.ts";
import type {  StateView  } from "../engine/signals.ts";
import { expandPack, listAppDirs, resolveSourceSlots, type AppPack, type ExpandedStep, type PackPace, type PackPolicy, type SourceObservation } from "./app-pack.ts";
import { extractProcessReturns, getAppAdapter, substituteDatasetPlaceholders, type AdapterRunContext, type ManualStepDecl, type ManualStepRequest, type ManualStepRun } from "./app-adapters.ts";
import { validateApp } from "./cross-ref.ts";
import { MASKED_SLOT, SECRET_SLOT_NAME, maskSecretSlots, scrubSecrets, secretSlotKeys, secretValuesFromSlots } from "./redaction.ts";
import { dryRunFlow, loadScriptApp, type LoadedScriptApp } from "./app-script.ts";
import { StopError, createCtx } from "./ctx.ts";
import { createScriptToolRunner } from "./app-runner-script-tools.ts";
import type {  CtxDeps  } from "./ctx-types.ts";
import type {  MiddlewareOptions  } from "../engine/executor-types.ts";
import { createReplayCtx } from "./ctx-replay.ts";
import { buildMiddleware } from "./middleware-factory.ts";
import { finishTrace, inputsSha256, newTrace, readTrace, replayCompatibility, writeTrace, type AppTrace, type TraceEvent } from "./trace.ts";
import { DatasetStore, type DatasetEntry } from "../engine/dataset.ts";
import { capToolText, writeToolStepArtifact } from "./tool-artifact.ts";
import { createPathWalk, DEFAULT_MAX_STEP_VISITS } from "../engine/plan.ts";
// 规划引导：run 失败时按停因给一行「下一步建议」（唯一出处 planning-playbook.ts，
// 只进 report.md 与 stdout，不动 result JSON 契约——桥解析零风险）。
import { nextForStop, STOP_ESCALATION_TEXT } from "../engine/planning-playbook.ts";
// 报告渲染区（appReportMarkdown/appReportHtml/invariantVerdictMd 等）拆到 app-report-view.ts（F7）；
// re-export 维持既有导出面不变（session-runtime/main 等调用方零改动）。
export { appReportMarkdown, appReportHtml } from "./app-report-view.ts";
import { appReportMarkdown, appReportHtml } from "./app-report-view.ts";

export const USAGE = `usage: app-runner [--list] [--app ID] [--dry] [--slot k=v ...] [--slot-file FILE] [--out DIR]
                  [--provider NAME] [--ablate stub|rules-only]
                  [--conf-floor N] [--no-sources] [--confirm-safe | --confirm-unsafe] [--headful] [--allow-dangerous]
                  [--tiered-hint] [--trace] [--max-steps N] [--manual-fail-fast] [--rescue | --no-rescue]
                  [--learn-hints | --hint-memory FILE] [--emit-trace FILE] [--replay FILE] [--quiet]

按 apps/<app>/app.mjs 的 flow(ctx) 跑一条应用：数据腿 → 脚本产生的浏览器/工具步 → 结束状态不变量
应用只有一种格式：flow 脚本（没有 pack.json / 声明式数据脚本 / 语义模板）。
--ablate       消融臂：stub = 脚本桩，rules-only = 规则档
--conf-floor N 置信度闸门刻度（0<N≤1）：换 provider（score_kind 不同）时缺省 0.25 不再成立，
               本旗标 = 本次覆盖；meta.policy.conf_floor 可声明；provider 可自报 floor
--tiered-hint  P1 实验开关：hint 档内歧义向模型问更小的问题（默认关 = 行为逐字节不变）
--trace        结果 JSON 带每步执行证据（step_traces）
--max-steps N  本次运行的 ctx.step/arrive 执行预算（调试用；用满后结果 partial，不是跳步）
--walk         A6 调试：单会话走查/取证——ctx.step 的「起点 URL=当前页」重锚（origin+path 同）
               不再重导航，SPA 状态跨步保留；跨页显式 url 与 open/openPage/arrive 照常。
               结果带 walk:true；与 --dry 互斥（dry 无浏览器）
--learn-hints  R2 学习环：模型选对的步变成规则（sidecar，永不写进被审计的脚本；authored 恒优先）
               落点默认 $AMBERFLOW_HOME/hint-memory/<app>.json，--hint-memory FILE 显式指定
--emit-trace F 把本次执行轨迹（app/script/inputs 三个 sha + 逐次 ctx 调用）写成 F
--replay F     按 F 里的轨迹重放（不重新决策；脚本版本或输入槽位不一致直接拒跑）
--today DATE   把"今天"钉成 YYYY-MM-DD：数据腿相对日期表达式（next_week/day_offset/weekday_cn）
               与 ctx.runtime.today 都用它；空缺 = 系统日期
--slot-file F  从 JSON 对象读槽位（避免明文进 argv/进程列表）；与 --slot 同名时 --slot 优先
               敏感槽位建议用 meta.secretSlots 声明：产物/报告/stdout 会自动掩码

数据腿的结果按 meta.sources 按需加载（ctx.source(name, { dates? })）；--no-sources 时不跑网络/进程。
数据腿的日期参数走声明槽位：source JSON 的 default_dates 写 "{slot}"（如 "{dates}"），
值从 包默认 slots + CLI --slot 解析（单日 / A..B 范围 / next_week）；不许引用 source_slots 产物（环）。
--dry 只跑 dry 调用序列（不开浏览器、不调模型）；--list 列出发现的 flow 应用。`;

/**
 * app-runner 默认产物目录（**调用时**读 env，测试可隔离）。
 * 单源在 support/amberflow-home.ts（cli/run 同用这一个出处）。
 */
import { appsOutDir } from "../support/amberflow-home.ts";
export { appsOutDir };

/**
 * 跑一个 `flow(ctx)` 应用。运行时仍然只认数据与证据面：
 * 复用 `browserSession` / `BrowserMiddleware` / `runSource` / `checkSignal`。
 * 脚本负责控制流；一步之内的一切仍归引擎（见 `src/app/ctx.ts` 的注释）。
 */
/* app-runner 是运行面的**稳定入口/facade**（bridge 按路径 spawn 本文件，不得移动/改名）：
 * 运行逻辑在 app-runner-types/policy/tool-step/declared 与本文的 runScriptApp；这里只
 * re-export 既有导出面 + 保留 CLI 入口 guard（main 也在 app-runner-cli.ts）。 */
export * from "./app-runner-types.ts";
export * from "./app-runner-policy.ts";
export { runToolStep } from "./app-runner-tool-step.ts";
export { runApp } from "./app-runner-declared.ts";

export interface ScriptRunOptions extends AppRunOptions {
  /** `ctx.step`/`arrive` 的执行预算（`--max-steps`；用满后结果 partial）。 */
  maxSteps?: number;
  /** 把本次执行轨迹写成 JSON（审计/交接）。 */
  emitTrace?: string;
  /** 按一条已记录的轨迹重放（不重新决策；版本/输入不一致直接拒跑）。 */
  replayTrace?: string;
  /**
   * A6 walk 调试模式（`--walk`，默认关 = 逐字节不变）：单会话走查/取证——`ctx.step` 的
   * 「起点 URL=当前页」重锚（origin+path 相同；query/hash 忽略）不再重导航，SPA 状态跨步
   * 保留；跨页显式 url 与 `open`/`openPage`/`arrive` 照常导航。与 dry 互斥（dry 无浏览器）。
   * 结果 JSON 带 `walk: true`——walk 产物不得冒充正式 run。
   */
  walk?: boolean;
}

export async function runScriptApp(loaded: LoadedScriptApp, opts: ScriptRunOptions = {}): Promise<AppRunResult> {
  const pack = loaded.pack;
  const t0 = Date.now();
  const slots: Record<string, unknown> = { ...(pack.slots ?? {}), ...(opts.slots ?? {}) };
  const secretKeys = secretSlotKeys(
    [...Object.keys(slots), ...((pack.required_slots ?? []) as string[])],
    pack.secret_slots,
  );
  const secretValues = secretValuesFromSlots(slots, secretKeys);
  const own = opts.sessionFactory === undefined;
  // 内核交给本 run 的产物落点（RunScope 投影；在 runExecution 里解析一次）。
  let planPath = "";
  let outDir = "";
  let runId = "";
  let rescueBuilder: RescueRequestBuilder | null = null;
  const inputs = inputsSha256(slots, (pack.hosts ?? []) as string[]);
  const trace = newTrace({ app: pack.id, script_sha256: loaded.scriptSha256, inputs_sha256: inputs });
  const verbose = opts.verbose !== false;
  // 节奏：CLI 显式 > meta.pace > 环境变量 > 0；与 runApp 共用同一个解析实现。
  const pace = resolvePace(pack, opts);
  /**
   * T2：运行级数据集**在脚本路径也有一份**（与声明式旅程共用同一份 DatasetStore 纪律）——`ctx.run` 的 `returns` 写这里、`ctx.step` 的命令值 `{from:"dataset"}` 从这里现读。
   * 与 `runApp` 同一个 `DatasetStore` 实现、同一条 generation/失效纪律（不另造一套）。
   */
  const dataset = opts.dataset ?? new DatasetStore();


  let ok = false;
  /** 预算用满 = partial 执行事实（内核的停因分类单点判定；不是配置错误）。 */
  let partial = false;
  let stopCode: string | undefined;
  let stopReason: string | undefined;
  /** navigation_forbidden 的结构化证据（StopError.diagnostics 原样透出；缺省 undefined）。 */
  let stopDiagnostics: Record<string, unknown> | undefined;
  let invariants: AppInvariantResult[] = [];
  // §3：策略在两条分支外声明（重放分支不构造执行器，但产物字段的形状要一致）。
  let policy: EffectivePolicy | null = null;
  let anyDeclared = false;
  /**
   * A3：在线 provider 掉线/没配好 ⇒ pick 抛错、本次降级 rules-only 的原因。
   * **管道修复**：runApp（声明式路径）一直把 `mw.providerDegraded` 写进 result，
   * 但 flow 脚本路径的执行器是惰性创建的局部 `mw`，旧代码从没把它读出来——
   * R3/R8 实测 result 的 provider_degraded 一直是空。收尾时读一次，两条路径同账。
   */
  let providerDegraded: string | null = null;
  // task-14（D1）：降级留痕（起跑探测失败/中途死亡；仅 degraded 时进 result.decision）。
  let decisionDegraded: NonNullable<BrowserMiddleware["decisionDegraded"]> | null = null;
  // task-24/4：strict 旗标存活到报告点（resolvedPolicy 在步循环分支里声明，报告点够不着）。
  let actHintStrictForWarn = false;
  // task-15（D2）：site_facts 命中集（步循环外的报告点要读——存活到结果装配）。
  let siteFacts: import("./site-facts.ts").MatchedSiteFact[] = [];
  // task-26（D2 A/B）：模型面注入计数（opt-in；仅 ON 且有命中时 >0，进 result 顶层只增字段）。
  let d2Injected = 0;
  /**
   * S5：状态接入决策的指标（与 providerDegraded 同一个「收尾读一次」先例）。执行器是
   * 惰性创建的，脚本可能一步都不跑 ⇒ 保持 null，报告按声明档补零（不硬造"跑过"）。
   */
  let decisionStateMetrics: DecisionStateMetrics | null = null;
  /** U8：被拒 ask 的 conf 分布（与 decisionStateMetrics 同一处收尾读；n=0 ⇒ null ⇒ 字段缺席）。 */
  let rejectedConfMetrics: { n: number; min: number | null; max: number | null } | null = null;
  /**
   * B2（P5）：会话收尾的环境/会话事实（final_url/viewport/user_agent）。与 providerDegraded
   * 同一个「收尾读一次」先例——区别是这三样必须读在**会话关闭之前**（关了就读不到 URL 了）；
   * 拿不到就保持 undefined，结果里键省略（缺省等价：不硬造）。
   */
  let finalUrl: string | undefined;
  let envViewport: { width: number; height: number } | undefined;
  let envUserAgent: string | undefined;
  // task-21/D-1：浏览器启动事实（env.browser 一等证据；会话收尾时从 liveSession 读）。
  let envBrowser: NonNullable<BrowserSession["envBrowser"]> | undefined;
  /** 每次 ctx.step/arrive 的执行报告 → 决策账（与 runApp 同一份 `summarizeDecisions`）。 */
  const decisionSteps: TraceStep[] = [];
  /** 每个 `ctx.step` 一次 mw.run；这里按调用顺序保留它的动作 trace，供 step_traces 补 hows/descs/methods。 */
  const decisionStepGroups: TraceStep[][] = [];
  // §8 步 2 影子模式记录器：仅 AMBERFLOW_RESCUE_SHADOW=1 创建；收尾 flush 到
  // outDir/rescue-shadow.json（sidecar 不进 result/trace/report；失败静默）。
  let rescueShadow: ShadowRecorder | null = null;
  /**
   * 内核回调里赋值的运行结果事实：TS 的控制流分析看不见闭包内的赋值，收尾读取经这个
   * holder（与既有 `mwHolder` 同一个理由），避免 `let` 被收窄成 never。
   */
  const captured: {
    policy: EffectivePolicy | null;
    anyDeclared: boolean;
    actHintStrictForWarn: boolean;
    decisionDegraded: NonNullable<BrowserMiddleware["decisionDegraded"]> | null;
    rescueShadow: ShadowRecorder | null;
  } = { policy: null, anyDeclared: false, actHintStrictForWarn: false, decisionDegraded: null, rescueShadow: null };

  // S1 执行内核组合根：RunScope（flow 面接受显式 outDir/runId 注入）+ 惰性会话租约 +
  // 执行器装配入口。脚本控制流与结束态验收留在本适配器（`ctx.done` 仍在页面上裁决）。
  await runExecution({
    source: "flow",
    appId: pack.id,
    planPath: opts.planPath,
    outDir: opts.outDir,
    runId: opts.runId,
    today: opts.today,
    maxSteps: opts.maxSteps,
    createSession: async () => {
      const device = (pack.device ?? null) as Parameters<typeof browserSession>[1];
      return own
        ? browserSession(opts.headful !== true, device, pack.policy?.browser ?? null)
        : opts.sessionFactory!();
    },
  }, async (run) => {
    ({ planPath, outDir, runId } = run.artifacts);
    rescueBuilder = opts.rescue === true ? new RescueRequestBuilder(runId) : null;
    rescueShadow = isRescueShadowEnabled() ? createShadowRecorder(runId) : null;
    if (opts.replayTrace !== undefined) {
      const recorded = readTrace(opts.replayTrace);
    const problems = replayCompatibility(recorded, {
      app: pack.id, script_sha256: loaded.scriptSha256, inputs_sha256: inputs,
    });
    if (problems.length) throw new Error(`replay refused:\n  - ${problems.join("\n  - ")}`);
    const { ctx, remaining } = createReplayCtx({
      pack: pack as never, slots: slots as Record<string, string>,
      runtime: run.scope.runtime,
      trace: recorded, maxSteps: opts.maxSteps,
    });
    try {
      await loaded.flow(ctx);
      ok = true;
      if (remaining() > 0) throw new StopError("trace_mismatch", `replay: script stopped but ${remaining()} recorded event(s) were not consumed`);
    } catch (e) {
      if (e instanceof StopError) { stopCode = e.code; stopReason = e.message; }
      else throw e;
    }
    invariants = invariantsFromTrace(recorded, pack);
    // 轨迹本身记录的是失败运行：重放的结论也必须失败（"结构一致"不等于"那次运行成功"）。
    if (recorded.done !== true) {
      ok = false;
      stopCode = recorded.stop_code ?? "replay_recorded_failure";
      stopReason = recorded.stop_reason ?? "the recorded run did not complete successfully";
    }
  } else {
    preflightConfig(opts);
    for (const n of pack.sources ?? []) loadSource(String(n));
    // §3：与 `runApp` 共用同一份策略解析——否则脚本应用会静默忽略 meta.policy
    // （同一个 `policy.conf_floor` 在数据脚本上生效、在 flow 脚本上不生效）。
    const resolvedPolicy = resolveRunPolicy(pack, opts);
    // E2/E1-c/E1-a/E1-b：决策开关与声明式路径同一份解析（decision.* 配置层默认值）。
    const decisionDefaults = parseRunDefaults(opts.env ?? process.env).defaults;
    policy = resolvedPolicy.policy;
    anyDeclared = resolvedPolicy.anyDeclared;
    // task-24/4：strict 旗标存活到报告点（runWarnings 的 model_face_idle 判定用）。
    actHintStrictForWarn = resolvedPolicy.policy.act_hint?.value === "strict";
    // 执行器装配入口：本 run 唯一实例，首个 getMw() 调用时经内核装配一次；收尾事实也经内核读。
    const getMw = (): BrowserMiddleware => run.middleware(() => {
      {
        const mwOptions: Omit<MiddlewareOptions, "confirmFn"> = {
          modelId: pack.model ?? "english",
          auditor: new MockAuditor(),
          // T2：命令步的 `{from:"dataset",key:…}` 从这里现读（与声明式旅程同一份 store）。
          dataset,
          hosts: (pack.hosts ?? null) as string[] | null,
          maxSteps: 8,
          confFloor: resolvedPolicy.policy.conf_floor.value,
          candidatePriority: resolvedPolicy.policy.candidate_priority.value,
          riskyThreshold: 0.6,
          doneThreshold: 0.5,
          tieredHint: resolvedPolicy.policy.tiered_hint.value,
          // P0-B：act hint 档位（缺省 widen；strict = 声明目标解析链全落空时禁模型回退）。
          actHint: resolvedPolicy.policy.act_hint?.value,
          // A3：弱档算不算命中（缺省 any；strong = 弱档改判未命中，再按 actHint 语义走）。
          actHintTier: resolvedPolicy.policy.act_hint_tier?.value,
          // P0-C：DRF（缺省 off = 今天；declared = 声明目标解析链启用 DOM 兜底）。
          targetResolution: resolvedPolicy.policy.target_resolution?.value,
          // F74：DOM 回退跳（缺省 false = 今天；true = 声明 hint 全链落空后补 A3 对称跳）。
          actHintDomFallback: resolvedPolicy.policy.act_hint_dom_fallback?.value === true,
          // A1：aria-label 属性 hint 的池侧匹配底座（缺省 full_label；display = A1 之前）。
          attrValueMatch: resolvedPolicy.policy.attr_value_match?.value,
          // F84 批 3（deny-list 可配化）：词元护栏放行表（缺省不写 = 护栏行为逐字节不变）。
          hintTokenAllow: resolvedPolicy.policy.hint_token_allow?.value,
          riskAsk: resolvedPolicy.policy.risk_ask.value === "rules-only" ? "rules-only" : "always",
          reobserve: resolvedPolicy.policy.reobserve.value,
          maxEffectiveRepeats: resolvedPolicy.policy.max_effective_repeats.value,
          // S1 状态层：pre-held done 处置 + fill effect 读回（与声明式路径同一份策略解析）。
          donePreheldPolicy: resolvedPolicy.policy.done_preheld.value,
          doneGuardPolicy: resolvedPolicy.policy.done_guard.value,
          fillReadback: resolvedPolicy.policy.effect_readback.value.fill,
          // W8：敏感槽位键名单交给执行器——fill effect 读回在**源头**掩码（执行器构造
          // effect 一次，step_traces 与 result.state 两条投影同源同掩）。只传键不传值：
          // 步级 slots 的真值只在执行器可见（R3 案例 S：runScriptApp 的 secretValues
          // 从不包含步级值，收尾 scrubSecrets 对 effect 读回里的这类值天然失明）。
          secretSlotKeys: secretKeys,
          // S2：稳定门（缺省开；null = meta.policy.settle:"off"）。
          settle: resolvedPolicy.policy.settle.value,
          // S5：状态接入决策（与声明式路径同一份策略解析；缺省两项 off）。
          decisionState: resolvedPolicy.policy.decision_state.value,
          actionDelayMs: pace.between_actions_ms,
          hintMemory: opts.hintMemory ?? null,
          // E2/E1-c/E1-a/E1-b：决策开关与声明式路径同一份解析（decisionDefaults 在 runScriptApp 顶部解析）。
          ...(decisionDefaults.ambiguousOrdering === undefined ? {} : { ambiguousOrdering: decisionDefaults.ambiguousOrdering }),
          ...(decisionDefaults.idFallback === undefined ? {} : { idFallback: decisionDefaults.idFallback }),
          ...(decisionDefaults.actPoolCap === undefined ? {} : { actPoolCap: decisionDefaults.actPoolCap }),
          ...(decisionDefaults.poolQuotaMode === undefined ? {} : { poolQuotaMode: decisionDefaults.poolQuotaMode }),
        };
        return buildMiddleware({
          face: "app-script",
          confirmPolicy: { kind: "safe-browser", confirmSafe: opts.confirmSafe !== false },
          options: mwOptions,
        });
      }
    });
    await probeCompatDecisionPlane(getMw);
    // task-15（D2）：SITE_FACTS 按 meta.hosts 匹配 → stderr 提示（运行前一次；仅命中出现；
    // 事实不进模型请求面）。无命中 = 零输出（默认等价）。命中集提到函数层（结果装配在分支外）。
    siteFacts = matchSiteFacts(loadSiteFacts((m) => console.error(m)), (pack.hosts ?? []) as string[]);
    for (const line of renderSiteFactLines(siteFacts)) console.error(line);
    // task-26（D2 A/B）：模型面注入（opt-in env；缺省 OFF = notes 原样逐字节不变）。
    // fenced block 渲染唯一出处 renderModelFence（stub 通道断言共用同一函数——"送达已验证"
    // 由此成立）；计数进 result 顶层 site_facts_injected（只增字段）。
    let d2Notes: string | null = null;
    d2Injected = 0;
    if (readString("AMBERFLOW_SITE_FACTS_INTO_MODEL") === "1") {
      d2Notes = renderModelFence(siteFacts);
      d2Injected = d2Notes === null ? 0 : Math.min(3, siteFacts.length);
      if (d2Notes !== null) {
        console.error(`[d2] 站点事实已注入模型请求面（${d2Injected} 条，fenced；安全四件见 design-D2-model-injection-ab.md）`);
      }
    }
    getMw().siteFactsNotes = d2Notes;
    // 工具步适配（ctx.run 的唯一实现）：runToolStep 干跑/确认/幂等重试 + 工件 + returns 抽取。
    const toolRunner = createScriptToolRunner({
      opts, outDir, runId, verbose, slots, dataset, secretValues,
    });
    const ctx = createCtx({
      pack: pack as never,
      slots: slots as Record<string, string>,
      runtime: run.scope.runtime,
      ensureSession: () => run.session(), mw: getMw, trace, toolRunner,
      // T2：脚本路径与声明式旅程共享同一份运行级数据集（ctx.run 的 returns 写这里）。
      dataset,
      allowSources: opts.sources !== false,
      manualRunner: opts.manualHandler !== undefined || process.stdin.isTTY
        ? async (req) => {
            const handler = opts.manualHandler ?? promptManualOnTty;
            return handler({ index: 0, desc: req.desc, instructions: req.instructions, url: req.url });
          }
        : undefined,
      manualFailFast: opts.manualFailFast === true,
      stepDelayMs: pace.between_steps_ms,
      // S1：ctx.setRange 的 applied/accurate 读回开关（fill 侧在执行器构造参数）。
      effectReadback: policy.effect_readback.value,
      doneTimeoutMs: policy.done_timeout_ms.value,
      donePollMs: policy.done_poll_ms.value,
      poolReadyTimeoutMs: policy.pool_ready_timeout_ms.value,
      poolReadyPollMs: policy.pool_ready_poll_ms.value,
      // U3：池空判档 + surface 类目策略（flow 面；executor 的 MiddlewareOptions 同类选项位）。
      poolGate: policy.pool_gate.value,
      surfacePolicy: policy.surface.value,
      // 导航纪律（缺省 undefined = 现行为逐字节不变；"entry-only" 才有闸门）。
      navPolicy: policy.navigation?.value,
      // A1：ctx.waitForTarget 的命中口径（缺省 undefined = full_label；与执行器同一 policy）。
      attrValueMatch: policy.attr_value_match?.value,
      // F84 批 3（deny-list 可配化）：ctx.observe 自证池的词元护栏放行表（缺省不写 = 逐字节不变；
      // 与执行器歧义面同一 policy）。
      hintTokenAllow: policy.hint_token_allow?.value,
      // P0-B：声明页放行清单（仅 entry-only 用它；缺省 undefined = 逐字节不变）。
      declaredPages: declaredPageUrls(pack),
      onRunReport: (rep) => {
        const steps = rep.steps as TraceStep[];
        decisionSteps.push(...steps);
        decisionStepGroups.push(steps);
      },
      ...(opts.maxSteps === undefined ? {} : { maxSteps: opts.maxSteps }),
      // A6 walk：旗标只进 flow 应用路径；缺省关 = ctx 与产物逐字节不变。
      ...(opts.walk === true ? { walk: true } : {}),
      // §8 步 2/3 影子模式：开关开启才注入 noteShadow 旁路（缺省不传 = ctx 行为零变化）。
      // 步 3 起统一走 intervention-adapter 的 shadowManualOutcome（与 journey 面同一份构造）。
      ...(rescueShadow !== null ? {
        rescueShadow: {
          noteShadow: (f: Parameters<NonNullable<NonNullable<CtxDeps["rescueShadow"]>["noteShadow"]>>[0]) =>
            shadowManualOutcome(rescueShadow, {
              desc: f.desc, stepId: f.id ?? "", instructions: f.instructions, pageUrl: f.pageUrl,
            }, { status: f.computed.status, by: f.computed.by, ...(f.legacyStopCode !== undefined ? { legacyStopCode: f.legacyStopCode } : {}) }),
        },
      } : {}),
      verbose,
    });
    try {
      await loaded.flow(ctx);
      ok = true;
    } catch (e) {
      if (e instanceof StopError) {
        stopCode = e.code; stopReason = e.message;
        // navigation_forbidden 的 {policy, attempted, current} 原样透出（缺省 undefined）。
        if (e.diagnostics !== undefined) stopDiagnostics = e.diagnostics;
      }
      else throw e;
    } finally {
      // B2（P5）：先读会话事实再关会话（关了就读不到 final_url 了）；读失败按缺键处理，
      // 不让证据采集影响运行结果本身。字段语义见 `AppRunEnv`。
      const liveSession = run.peekSession();
      if (liveSession !== null) {
        // task-21/D-1：浏览器启动事实（binary_basename/headless/persistent_profile）——
        // 会话关闭前读一次（与 final_url/viewport 同一先例；sessionFactory 注入的会话缺字段省略）。
        if (liveSession.envBrowser !== undefined) envBrowser = liveSession.envBrowser;
        try {
          const u = urlOf(liveSession.page);
          if (u) finalUrl = String(u);
        } catch { /* 拿不到就省略 */ }
        try {
          const vp = (liveSession.page as unknown as { viewportSize?: () => unknown }).viewportSize?.();
          if (typeof vp === "object" && vp !== null
            && Number.isFinite((vp as { width?: unknown }).width)
            && Number.isFinite((vp as { height?: unknown }).height)) {
            envViewport = {
              width: Number((vp as { width: unknown }).width),
              height: Number((vp as { height: unknown }).height),
            };
          }
        } catch { /* 拿不到就省略 */ }
        try {
          const ua = await (liveSession.page as unknown as {
            evaluate?: (fn: () => unknown) => Promise<unknown>;
          }).evaluate?.(() => navigator.userAgent);
          if (typeof ua === "string" && ua.trim()) envUserAgent = ua;
        } catch { /* 拿不到就省略 */ }
        // A4：关会话前清章（复用会话时旧章不该跨运行残留）。best-effort，失败吞掉。
        try { await liveSession.page.evaluate(cleanStampAttrs); } catch { /* 清理失败不影响结果 */ }
      }
      // 会话关闭与 runApp 同一位置：不变量/结束态/环境事实都读完之后；未创建 = no-op。
      await run.close();
      // 收尾事实（A3 降级原因 / D1 决策面降级 / S5 指标 / U8 被拒 ask）经内核一次取齐；
      // 重放分支没有执行器 ⇒ 全 null（字段缺席 = 没降级，与 runApp 同口径）。
      const facts = run.middlewareFacts();
      providerDegraded = facts.providerDegraded;
      decisionDegraded = facts.decisionDegraded;
      decisionStateMetrics = facts.decisionStateMetrics;
      rejectedConfMetrics = facts.rejectedAskConf;
    }
  }
    invariants = invariantsFromTrace(trace, pack ?? {});
    partial = run.budgetExhausted(stopCode);
    captured.policy = policy;
    captured.anyDeclared = anyDeclared;
    captured.actHintStrictForWarn = actHintStrictForWarn;
    captured.decisionDegraded = decisionDegraded;
    captured.rescueShadow = rescueShadow;
  });

  const finalPolicy = captured.policy;
  const finalAnyDeclared = captured.anyDeclared;
  const finalStrict = captured.actHintStrictForWarn;
  const finalDecisionDegraded = captured.decisionDegraded;
  const finalRescueShadow = captured.rescueShadow;

  // 人工步不能因为脚本“没 ctx.fail 就继续走”而变绿：人工没完成是全局未完成，
  // 即使后续步骤和结束态不变量都成立。脚本可以吞异常，但产物不能吞事实。
  const failedManual = trace.events.find((e) => e.call === "manual" && e.ok !== true);
  if (failedManual !== undefined) {
    ok = false;
    stopCode = stopCode ?? failedManual.stop_code ?? "needs_human";
    stopReason = stopReason ?? `manual step did not complete: ${failedManual.desc ?? failedManual.id ?? "?"}`;
  }

  // 声明了结束态不变量却从未调用 ctx.done()：**验收根本没发生**。
  // ok 不得在这种情况下仍为 true（suite 会打"0/1 不变量 · 通过"——那是最坏的一类假绿）。
  const declaredInvariants = (pack.invariants ?? []).length;
  if (opts.replayTrace === undefined && ok && declaredInvariants > 0
    && !trace.events.some((e) => e.call === "done")) {
    ok = false;
    stopCode = "missing_done";
    stopReason = "flow ended without ctx.done(): declared end-state invariants were never verified";
  }
  // done 的失败判决**粘住**：脚本可以 `try { await ctx.done() } catch {}` 吞掉异常，
  // 但产物不能因此报绿——不变量没成立就是没通过（否则报告同页会写"不变量不成立"+"通过"）。
  if (ok && declaredInvariants > 0 && !invariants.every((i) => i.held)) {
    ok = false;
    stopCode = "invariant_failed";
    stopReason = "declared end-state invariants did not hold: "
      + invariants.filter((i) => !i.held).map((i) => i.id).join(", ");
  }
  // `--max-steps N` 是执行预算：用满时已经执行的步骤是事实，不是“配置错误”。
  finishTrace(trace, {
    done: ok,
    ...(stopCode === undefined ? {} : { stop_code: stopCode }),
    ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
    invariants_ok: invariants.every((i) => i.held),
  });
  const tracePath = opts.emitTrace === undefined ? undefined : writeTrace(opts.emitTrace, scrubSecrets(trace, secretValues));
  if (verbose) {
    console.log(`=== app ${pack.id} (script/flow) ===`);
    for (const ev of trace.events) {
      if (ev.call === "log") continue;
      console.log(`  ${String(ev.i).padStart(2, " ")}. ${ev.call}${ev.desc ? ` ${ev.desc}` : ""}${ev.url ? ` → ${ev.url}` : ""}`
        + `${ev.ok === false ? ` [${ev.stop_code ?? "failed"}]` : ""}`);
    }
  }

  // 08-C：flow 路径的进程步（run/dangerous）同样进 step_traces——记录层一直有事件
  // （ctx.ts runTool/声明形式各有 pushEvent），缺的只是这里的投影准入；成功步嵌套
  // result 无 stop_code（B6 口径），失败行带 stop_code，作者不再只能靠脚本自 log。
  // A3/S3：四原语（scrollList/expand/setRange/collect）各计 1 个 flow step——投影口径必须与
  // `ctx.budget.stepsUsed` 一致，否则"用了预算的 flow"会在产物里显示成 0 step。
  // A5：`tab` 事件里只有 `action="switch"` 计步；`action="list"`（ctx.tabs）是免费只读观察。
  const FLOW_STEP_CALLS = new Set(["step", "arrive", "scrollList", "expand", "setRange", "collect"]);
  const isFlowStepEvent = (e: TraceEvent): boolean =>
    FLOW_STEP_CALLS.has(e.call) || (e.call === "tab" && e.action === "switch");
  const stepEvents = trace.events.filter((e) =>
    isFlowStepEvent(e)
    || e.call === "manual" || e.call === "run" || e.call === "dangerous");
  const stepCount = trace.events.filter(isFlowStepEvent).length;
  const manualSteps = trace.events.filter((e) => e.call === "manual").map((e, i) => ({
    index: i,
    desc: e.desc ?? "",
    done: e.ok === true,
    ...(e.ok === true && typeof e.result === "object" && e.result !== null
      && (e.result as Record<string, unknown>)["attested"] === true ? { attested: true } : {}),
    ...(e.stop_code === undefined ? {} : { reason: e.stop_code }),
  }));
  const TRANSIENT_STOP_CODES = new Set([
    "page_not_ready", "space_empty", "action_space_exhausted", "low_confidence",
    "no_progress", "stale_ref", "hint_matched_nothing",
  ]);
  let stepActionCursor = 0;
  const stepTraces: NonNullable<AppRunResult["step_traces"]> = stepEvents.map((e, i) => {
    const laterOk = stepEvents.slice(i + 1).find((s) => s.ok === true);
    const recovered = e.ok === false
      && e.stop_code !== undefined && TRANSIENT_STOP_CODES.has(e.stop_code)
      && laterOk !== undefined;
    // 只给 `ctx.step` 补动作证据；`ctx.arrive` / `ctx.manual` 不走 mw.run，没有动作 trace。
    const group = e.call === "step" ? decisionStepGroups[stepActionCursor++] ?? [] : [];
    const executed = group.filter((s) => s.executed === true);
    // A1 子改动③：after 签名与 hows 一一对齐；全 null 时整字段省略（产物最小纪律）。
    const afters = executed.map((s) => asAfterSignature(s.after));
    // A1：动作执行证据来自该步的 trace event result（ctx 从 RunReport 原样透出；缺省不出现）。
    const evResult = (typeof e.result === "object" && e.result !== null && !Array.isArray(e.result))
      ? e.result as Record<string, unknown>
      : {};
    const evExecuted = evResult["executed"];
    const evExecActions = evResult["executed_actions"];
    const evSkipped = evResult["skipped_actions"];
    const evPreheld = evResult["done_preheld"];
    const evWarnings = evResult["warnings"];
    const evState = evResult["state"];
    // when 守卫跳过的步（ok:false + precondition_skipped）不是失败：与声明式路径同一口径记成
    // "skipped"（见上方 rep.skipped 分支），审计者扫表即可分清“执行完成/不适用/失败”。
    const skippedStep = e.ok === false && e.stop_code === "precondition_skipped";
    return {
      index: i,
      id: e.id ?? null,
      desc: e.desc ?? "",
      status: recovered ? "recovered" : (e.ok === false ? (skippedStep ? "skipped" : "failed") : "done"),
      hows: executed.map((s) => String(s.how ?? "")),
      descs: executed.map((s) => String(s.desc ?? "")),
      methods: group.map((s) => String(s.method ?? "")).filter(Boolean),
      ...(afters.some((a) => a !== null) ? { afters } : {}),
      ...(e.url === undefined ? {} : { url: e.url }),
      // `dom_goal_signal` 这类是“done 已成立”的执行事实，不是失败；成功步不把它渲染成停因。
      ...(e.ok === false && e.stop_code !== undefined ? { stop_code: e.stop_code } : {}),
      ...(e.result === undefined ? {} : { result: e.result }),
      ...(recovered ? { recovered: true, recovered_by: laterOk!.id ?? laterOk!.desc ?? null } : {}),
      ...(typeof evExecuted === "boolean" ? { executed: evExecuted } : {}),
      ...(Array.isArray(evExecActions) && evExecActions.length
        ? { executed_actions: evExecActions as ExecutedAction[] } : {}),
      ...(Array.isArray(evSkipped) && evSkipped.length
        ? { skipped_actions: evSkipped as SkippedAction[] } : {}),
      ...(typeof evPreheld === "boolean" ? { done_preheld: evPreheld } : {}),
      ...(Array.isArray(evWarnings) && evWarnings.length
        ? { warnings: evWarnings.map(String) } : {}),
      ...(evState !== null && typeof evState === "object" && !Array.isArray(evState)
        ? { state: evState as StepStateRecord } : {}),
    };
  });
  /**
   * S1 run summary warnings：执行器已把前进性 flags 写成 step warnings（单一出处），
   * 这里只做**跨步去重/汇总**——不重新判 flags、不改完成真值。
   */
  const runWarnings: string[] = [];
  {
    const seen = new Set<string>();
    for (const t of stepTraces) {
      for (const w of t.warnings ?? []) {
        if (seen.has(w)) continue;
        seen.add(w);
        // task-21/D-1：警告步号修正——flow 面每个 ctx.step 是独立 mw.run，执行器 stepNo
        // 每步从 1 重数（审核报告 D-3：7 条警告全写 "step 1" 无法定位）。汇总面把
        // step_traces 的步位/稳定 id 注入前缀，报告与 JSON 的警告从此可定位。
        runWarnings.push(`[step ${t.index + 1}${t.id ? `:${t.id}` : ""}] ${w}`);
      }
    }
    // task-14（D1）：决策面兼容降级时保底一条 run warning（即使没有步被吞掉——
    // probe 失败本身就该在 result.warnings 里可见）。
    if (finalDecisionDegraded !== null) {
      runWarnings.push(`decision_degraded: 决策面已降级（${finalDecisionDegraded.reason_class}）`
        + `——本次 run 停发模型调用，规则面继续（${finalDecisionDegraded.message.slice(0, 200)}）`);
    }
    // task-24/4：模型面参与度提示（评审 A.4 因果纠正——strict/rules-only 不改变模型参与度，
    // 只改未命中兜底与风险票来源；0 咨询的因是规则面全命中）。决策面已配置 + strict + 0 咨询
    // = idle：不是故障，一句话点明（免得"模型面坏了？"的误诊）；D1 降级场景已有
    // decision_degraded 覆盖，不重复。
    {
      const planeConfigured = decisionServiceConfigured();
      const strictOn = finalStrict;
      const asksSoFar = opts.pickAsks ? opts.pickAsks() : 0;
      if (planeConfigured && strictOn && asksSoFar === 0 && finalDecisionDegraded === null) {
        runWarnings.push("model_face_idle: 决策面已配置且 act_hint=\"strict\"，但本次 run 零模型咨询"
          + "（规则面全命中或全未命中）——这是策略预期行为不是故障；strict/rules-only 不改变模型参与度，"
          + "只改未命中兜底与风险票来源");
      }
    }
  }
  const logs = trace.events.filter((e) => e.call === "log").map((e) => ({
    i: e.i, desc: e.desc ?? "", ...(e.result === undefined ? {} : { result: e.result }),
  }));
  // task-21/D-1：流式 observation 投影（判分面）——read/extract/observe 的**行样例+计数+
  // 选中 hint**（每行值截断 ≤40 字符、样例 ≤3 行、observe 元素样例 ≤5），从既有 trace 事件
  // 重建（不另存状态）。0/5 判分所需字段从此可见（此前 extract 行数据不进 step_traces、
  // observe 不落 result、无 trace_path 时永久丢失）。只增字段：无此类调用 = 键缺席。
  const isClip = (v: unknown): string => {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    return s.length <= 40 ? s : `${s.slice(0, 39)}…`;
  };
  const clipRow = (row: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (typeof row === "object" && row !== null) {
      for (const [k, v] of Object.entries(row as Record<string, unknown>)) out[k] = isClip(v);
    }
    return out;
  };
  const observations = trace.events
    .filter((e) => e.call === "read" || e.call === "extract" || e.call === "observe")
    .map((e) => {
      const res = (typeof e.result === "object" && e.result !== null && !Array.isArray(e.result))
        ? e.result as Record<string, unknown> : {};
      if (e.call === "extract") {
        const rows = Array.isArray(res["rows"]) ? res["rows"] as unknown[] : [];
        return {
          i: e.i, call: "extract", desc: e.desc ?? "",
          rows_count: rows.length,
          ...(rows.length > 0 ? { rows_sample: rows.slice(0, 3).map(clipRow) } : {}),
          ...(res["truncated"] === true ? { truncated: true } : {}),
        };
      }
      if (e.call === "observe") {
        return {
          i: e.i, call: "observe", desc: e.desc ?? "", url: e.url ?? "",
          ...(e.counts !== undefined ? { counts: e.counts } : {}),
          ...(e.elements_sample !== undefined ? { elements_sample: e.elements_sample } : {}),
          ...(e.truncated === true ? { truncated: true } : {}),
        };
      }
      // read：值投影（result 即读到的值——text/value 截断 ≤40；count/attr 为标量原样）。
      return { i: e.i, call: "read", desc: e.desc ?? "", result: isClip(e.result) };
    });
  // P0-E：失败步计账（口径 = step_traces 中 status:"failed"；skipped/recovered 不算失败）。
  // 仅 >0 才进 result——clean run 的键集与基线逐字节一致。
  const stepsFailed = stepTraces.filter((t) => t.status === "failed").length;
  const stats = opts.runtimeStats ? opts.runtimeStats() : null;
  const decisions = summarizeDecisions(decisionSteps, stats, opts.pickAsks ? opts.pickAsks() : 0,
    opts.pickFailedAsks ? opts.pickFailedAsks() : 0,
    // S5：与声明式路径同一条范围判定——finalPolicy 声明了 decision_state 才投影指标；
    // 声明了但脚本一步没跑 = 全 0（这一臂确实跑过，只是没发生决策）。
    finalPolicy !== null && finalPolicy.decision_state.source === "app"
      ? (decisionStateMetrics ?? { asks_saved: 0, gate_waits: 0, context_sent: 0, context_skipped: 0 })
      : null,
    // U8：被拒 ask 的 conf 分布（脚本跑过才有执行器可读；n=0 ⇒ null ⇒ 字段缺席）。
    rejectedConfMetrics);
  // B2（P5）：页面属性拿不到时退回 `meta.device` 的声明值（声明了才有；都没有就省略键，
  // 不硬造）。有设备声明时页面属性本来就是同一个值，这条兜底只服务无页面属性的替身会话。
  const envDevice = (pack.device ?? {}) as { viewport?: { width: number; height: number }; user_agent?: string };
  if (envViewport === undefined && envDevice.viewport !== undefined) envViewport = envDevice.viewport;
  if (envUserAgent === undefined && envDevice.user_agent !== undefined) envUserAgent = envDevice.user_agent;
  // ---- T1/T6：工具步与数据腿的投影（只从既有 trace 事件重建，不另存一份状态） ----
  // 只从脚本局部变量读会让 `tool_steps`/`sources` 恒空：工具跑过但产物读不到（T1），
  // 工具失败也只留在局部变量里（T6）。事件本来就是这两条腿的唯一记录面——投影它。
  const toolStepProjection: ToolStepResult[] = trace.events
    .filter((e) => e.call === "run" || e.call === "dangerous")
    .map((e, i) => {
      const r = (typeof e.result === "object" && e.result !== null && !Array.isArray(e.result))
        ? e.result as Record<string, unknown>
        : {};
      const refused = typeof r["refused"] === "string" ? r["refused"] as ToolStepResult["refused"] : undefined;
      return {
        index: i,
        desc: e.desc ?? "",
        source: typeof r["source"] === "string" ? r["source"] : "",
        attempts: typeof r["attempts"] === "number" ? r["attempts"] : 1,
        done: e.ok === true,
        ok: e.ok === true,
        code: typeof r["code"] === "number" ? r["code"] : null,
        ...(refused === undefined ? {} : { refused }),
        ...(typeof r["artifact"] === "string" ? { artifact: r["artifact"] } : {}),
        ...(typeof r["elapsed_ms"] === "number" ? { elapsed_ms: r["elapsed_ms"] } : {}),
        ...(typeof r["stderr_tail"] === "string" ? { stderr_tail: r["stderr_tail"] } : {}),
        ...(typeof r["reason"] === "string" ? { reason: r["reason"] } : {}),
      };
    });
  const sourceProjection: AppSourceResult[] = trace.events
    .filter((e) => e.call === "source")
    .map((e) => {
      const r = (typeof e.result === "object" && e.result !== null && !Array.isArray(e.result))
        ? e.result as Record<string, unknown>
        : {};
      return {
        name: e.desc ?? (typeof r["name"] === "string" ? r["name"] : "?"),
        rows: typeof r["rows"] === "number" ? r["rows"] : 0,
        counts: (typeof r["counts"] === "object" && r["counts"] !== null
          ? r["counts"] as Record<string, number> : {}),
        selects: (typeof r["selects"] === "object" && r["selects"] !== null
          ? r["selects"] as Record<string, string> : {}),
      };
    });
  const finishedAtIso = new Date().toISOString();
  // §8 步 2 影子模式收尾：sidecar 落盘放在写 result 的收尾路径（正常/异常都到得了这里）；
  // 开关关时 recorder 为 null（零字节不变）。失败静默——影子不掩盖运行结果。
  if (finalRescueShadow !== null) finalRescueShadow.flush(outDir);
  const result: AppRunResult = {
    app: pack.id,
    label: pack.label ?? pack.id,
    goal: pack.goal,
    pack_path: loaded.scriptPath,
    plan_path: planPath,
    // flow 脚本路径没有角色模板（01 轮 B7）：空字段整条省略，产物不再带无解释的 roles_used:[]。
    slots: maskSecretSlots(slots, secretKeys),
    // 步数只计 step/arrive（预算面）；只读观察调用免费不占预算（F10 口径），
    // 但审计上照样发生了——一行标注，避免「步骤 0」被误读成「什么都没跑」。
    completed: `${trace.events.filter(isFlowStepEvent).length} step(s) via flow(ctx)`
      + `${(() => {
        const free = trace.events.filter((e) =>
          e.call === "read" || e.call === "extract" || e.call === "holds" || e.call === "waitFor"
          || e.call === "waitForTarget"
          || e.call === "observe"
          || (e.call === "tab" && e.action === "list")).length;
        const navs = trace.events.filter((e) => e.call === "open" || e.call === "openPage").length;
        return free > 0 ? ` + ${free} 只读观察调用（waitFor/extract/read/observe 等，免费不占预算）${navs > 0 ? ` + ${navs} 导航` : ""}` : "";
      })()}`,
    subgoals: [],
    tool_steps: toolStepProjection,
    invariants,
    sources: sourceProjection,
    ok,
    // P0-E：失败步计账（仅 >0 时出现；n=0 键集与基线逐字节一致）。
    ...(stepsFailed > 0 ? { steps_failed: stepsFailed } : {}),
    // eval3 曝光面：警告一等公民（与 steps_failed 同口径，仅 >0 出现）。
    ...(runWarnings.length > 0 ? { warnings_count: runWarnings.length } : {}),
    // T2：返回值写进数据集后的审计视图（含 writtenBy/generation；没有 returns ⇒ 键缺席，与声明式路径同一字段名/形状，不另造一套）。
    ...(dataset.entriesView().length > 0 ? { dataset_view: [...dataset.entriesView()] } : {}),
    ...(partial ? { partial: true as const } : {}),
    // A6：walk 调试跑显式自报——缺字段 = 正式语义；walk 产物不冒充正式 run。
    ...(opts.walk === true ? { walk: true as const } : {}),
    ...(manualSteps.length ? { manual_steps: manualSteps } : {}),
    ...(paceNonDefault(pace) ? { pace } : {}),
    secs: (Date.now() - t0) / 1000,
    // B2（P5 证据增强）：环境与会话——run_id/时间戳必有；final_url/viewport/user_agent
    // 只在真会话上收（收不到的键省略；replay 无会话自然缺键）。secret 值若出现在
    // final_url/UA 里由收尾的 scrubSecrets 统一掩码。
    env: {
      run_id: runId,
      started_at: new Date(t0).toISOString(),
      finished_at: finishedAtIso,
      ...(finalUrl === undefined ? {} : { final_url: finalUrl }),
      ...(envViewport === undefined ? {} : { viewport: envViewport }),
      ...(envUserAgent === undefined ? {} : { user_agent: envUserAgent }),
      // task-21/D-1：浏览器启动事实（env.browser 一等证据——渲染退化判定第一块事实；
      // sessionFactory 注入的会话缺字段省略）。
      ...(envBrowser === undefined ? {} : { browser: envBrowser }),
    },
    // §3：生效策略只在非缺省时进产物（与 runApp 同一纪律）；模型层级照写（脚本应用同样要能说清）。
    ...(finalAnyDeclared && finalPolicy !== null ? { effective_policy: finalPolicy } : {}),
    // 导航纪律拦下的直接导航证据（缺省不出现 = 产物逐字节不变）。
    ...(stopDiagnostics !== undefined ? { diagnostics: stopDiagnostics } : {}),
    ...(opts.modelStatus === undefined ? {} : { model_status: opts.modelStatus }),
    decisions,
    // A3：与 runApp（声明式路径）同账——降级发生过就必须出现在产物里。
    ...(providerDegraded ? { provider_degraded: providerDegraded } : {}),
    // task-14（D1）：决策面兼容降级留痕（仅 degraded 时出现，只增字段——healthy/无决策面
    // 的 run 键集与基线逐字节一致）。
    ...(finalDecisionDegraded !== null ? { decision: { degraded: finalDecisionDegraded } } : {}),
    // task-15（D2）：site_facts 仅命中时出现（只增字段；无命中 = 键集与基线逐字节一致）。
    ...(siteFacts.length > 0 ? {
      site_facts: siteFacts.map((f) => ({ site: f.site, id: f.id, as_of: f.as_of, evidence: f.evidence, statement: f.statement })),
    } : {}),
    // task-26（D2 A/B）：注入计数（仅 ON 且命中时 >0；OFF/未命中 = 键缺席，逐字节不变）。
    ...(d2Injected > 0 ? { site_facts_injected: d2Injected } : {}),
    step_traces: stepTraces,
    ...(runWarnings.length ? { warnings: runWarnings } : {}),
    ...rescueField(rescueBuilder, { stopCode, lastManualFacts: lastManualFactsFromTrace(trace.events), pageUrl: finalUrl }),
    ...(logs.length ? { logs } : {}),
    // task-21/D-1：流式 observation 投影（判分面；只增字段——无 read/extract/observe 调用
    // 时键缺席，clean 键集与基线逐字节一致）。result 装配后经 scrubSecrets 统一掩码。
    ...(observations.length > 0 ? { observations } : {}),
    script: {
      mode: "flow",
      script_path: loaded.scriptPath,
      steps: stepCount,
      script_sha256: loaded.scriptSha256,
      plan_sha256: loaded.planSha256,
      ...(tracePath === undefined ? {} : { trace_path: tracePath }),
      ...(stopCode === undefined ? {} : { stop_code: stopCode }),
      ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
    },
  };
  return scrubSecrets(result, secretValues);
}


/* ---------------------------------------------------------------- CLI 入口（拆到 app-runner-cli.ts，F7） */

// `amber run` 以子进程直跑本文件（cli/commands/run.ts 的 runEntry("src/app/app-runner.ts")），
// CLI 解析与装配在 app-runner-cli.ts；这里 re-export main 维持「直跑本文件」的既有契约。
export { main, runNextHint } from "./app-runner-cli.ts";

import { main as cliMain } from "./app-runner-cli.ts";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await cliMain());
}
