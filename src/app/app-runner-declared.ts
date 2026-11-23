/**
 * 声明式运行面 `runApp`（从 app-runner.ts 纯搬移，大文件拆分 A1b）：journey 展开 → 数据腿 →
 * web/cli/manual 适配器 → 不变量验收 → 结果装配。`app-runner.ts` re-export 保持既有导出面。
 */
import { defaultDates, loadSource, previewTable, runSource, selectMainValue } from "../data/datasource.ts";
import { MockAuditor, type TraceStep } from "../engine/audit.ts";
import { DatasetStore } from "../engine/dataset.ts";
import { type MiddlewareOptions } from "../engine/executor-types.ts";
import { type BrowserSession, type StepStateRecord, browserSession, disallowedHost } from "../engine/executor.ts";
import { DEFAULT_MAX_STEP_VISITS, createPathWalk } from "../engine/plan.ts";
import { runSubgoalWithRetries } from "../engine/planner.ts";
import { runExecution } from "../engine/run-execution.ts";
import { type StateView, checkSignal } from "../engine/signals.ts";
import { captureStateView } from "../flow/signal-induction.ts";
import { type StepStateView, captureStepStateView } from "../model/page-context.ts";
import { paceNonDefault, paceRemainder } from "../support/pace.ts";
import { parseRunDefaults } from "../support/run-defaults.ts";
import { sleepMs } from "../support/sleep.ts";
import { NAVIGATION_GOTO_TIMEOUT_MS } from "../support/tuning.ts";
import { type AdapterRunContext, type ManualStepDecl, type ManualStepRequest, type ManualStepRun, getAppAdapter } from "./app-adapters.ts";
import { type AppPack, type ExpandedStep, type SourceObservation, expandPack, resolveSourceSlots } from "./app-pack.ts";
import { AppRunConfigError, preflightConfig, probeCompatDecisionPlane, promptManualOnTty, resolvePace, resolveRunPolicy } from "./app-runner-policy.ts";
import { runToolStep } from "./app-runner-tool-step.ts";
import { appStopContextFields, rememberAppStopContext } from "./app-stop-context.ts";
import { type AppInvariantResult, type AppRunOptions, type AppRunResult, type AppSourceResult, type ToolStepResult, asAfterSignature, startUrl, summarizeDecisions } from "./app-runner-types.ts";
import { createAppCandidateProducer } from "./candidate-source.ts";
import { validateApp } from "./cross-ref.ts";
import { RescueRequestBuilder, journeyRescueInput, pickManualApprover, rescueField, shadowManualOutcome } from "./intervention-adapter.ts";
import { createShadowRecorder, isRescueShadowEnabled } from "./intervention-shadow.ts";
import { buildMiddleware } from "./middleware-factory.ts";
import { MASKED_SLOT, maskSecretSlots, secretSlotKeys } from "./redaction.ts";
import { loadSiteFacts, matchSiteFacts, renderSiteFactLines } from "./site-facts.ts";
/**
 * 数据腿 selects → 观测面（整行 + 配置驱动主值）。
 *
 * 主值字段映射来自数据源配置（`selects[].value_fields/value_field`），引擎不猜业务字段；
 * 空串不写入 `selectValues`（回写槽位继续看通用回退，与既有口径一致）。
 */
function buildSelectObservation(
  src: Record<string, any>, rawSelects: Record<string, any>,
): {
  selects: Record<string, string>;
  selectsFull: Record<string, Record<string, string> | null>;
  selectValues: Record<string, string>;
} {
  const selects: Record<string, string> = {};
  const selectsFull: Record<string, Record<string, string> | null> = {};
  const selectValues: Record<string, string> = {};
  const selectSpecs = new Map(
    ((src["selects"] || []) as Array<Record<string, any>>)
      .map((s) => [String(s["key"] ?? ""), s] as const),
  );
  for (const [k, row] of Object.entries(rawSelects)) {
    // 回写槽位要能取到**具体字段**（`selects` 只留"主值"给报告看；声明点名 `field` 时要有整行）。
    selectsFull[k] = row === null || row === undefined
      ? null
      : Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([f, v]) => [f, String(v ?? "")]));
    if (row === null || row === undefined) continue;
    const spec = selectSpecs.get(k);
    const main = spec === undefined ? undefined : selectMainValue(row, spec);
    selects[k] = String(main ?? "");
    if (main !== undefined && main !== null && String(main) !== "") selectValues[k] = String(main);
  }
  return { selects, selectsFull, selectValues };
}

export async function runApp(pack: AppPack, opts: AppRunOptions = {}): Promise<AppRunResult> {
  const {
    slots = {}, sources = true, confirmSafe = true, verbose = true,
    modelId = pack.model ?? "english",
  } = opts;
  const t0 = Date.now();
  // E2/E1-c/E1-a/E1-b：决策开关（decision.*）的配置层默认值（非法值已在 CLI 入口报错；这里只取已解析的强类型值，run/dry/replay 共用）。
  const decisionDefaults = parseRunDefaults(opts.env ?? process.env).defaults;
  const secretKeys = secretSlotKeys(
    [...Object.keys(pack.slots ?? {}), ...((pack.required_slots ?? []) as string[]), ...Object.keys(slots)],
    pack.secret_slots,
  );
  // 预检在**任何**腿之前：坏配置不该先跑数据腿再报错（I-1 的"0 副作用"就是这个位置）。
  preflightConfig(opts);
  // 节奏：本次显式 > pack.pace > 环境变量 > 0。缺省全 0 = 与今天逐字节一致。
  const pace = resolvePace(pack, opts);
  // 数据源的**配置**也在跑之前全部加载：`loadSource` 会在加载期跑 `validate_source`
  // （未知抽取器/op/transport 键、错的捕获组数……）。不在加载期校验，第 2 个源的坏配置就要等
  // 第 1 个源真的打完网络才浮出来——网络副作用已经发生，报错却在半路。加载不产生副作用。
  {
    const cfgNames = new Set<string>();
    const isObj = (x: unknown): x is Record<string, unknown> =>
      typeof x === "object" && x !== null && !Array.isArray(x);
    for (const n of pack.sources ?? []) cfgNames.add(String(n));
    // 工具步引用的数据源同样在这一段加载（不再等展开之后——展开现在要等数据腿跑完，
    // 因为数据腿的结果要回写槽位）。
    for (const e of pack.journey ?? []) {
      if (!isObj(e)) continue;
      const rn = e["role"];
      const tpl = rn !== undefined && isObj(pack.roles?.[String(rn)]) ? pack.roles![String(rn)]! : {};
      const merged = { ...tpl, ...e };
      if (merged["source"] !== undefined) cfgNames.add(String(merged["source"]));
    }
    for (const n of cfgNames) loadSource(n);
  }
  // 坏包在**任何网络动作之前**就炸：校验是纯函数，放在数据腿之前是"0 副作用"纪律的另一半
  // （否则坏包要等数据腿打完一圈网络才被发现）。
  {
    const problems = validateApp(pack, { slots: { ...(pack.slots ?? {}), ...slots } });
    if (problems.length) {
      throw new Error(`app pack ${pack.id} is invalid:\n  - ${problems.join("\n  - ")}`);
    }
  }
  let endState: StateView | undefined;
  // ---- 数据腿：同一套数据源引擎（HTTP 或 CLI 通道） -------------------------
  // 它跑在**展开之前**：数据腿的结果要回写槽位（`source_slots`），而槽位替换发生在展开期。
  // 顺序是"校验 → 数据腿 → 展开"，坏包仍然在任何网络动作之前就被拒
  // （校验已在上面单独跑过一遍）。
  const sourceResults: AppSourceResult[] = [];
  /** 数据腿的观察面（回写槽位的输入；与报告里的 counts/selects 同一份数据）。 */
  const observed: Record<string, SourceObservation> = {};
  /** 数据源配置决定的主值（source → select → 值）：`resolveSourceSlots` 的唯一输入。 */
  const selectValuesBySource: Record<string, Record<string, string>> = {};
  if (sources) {
    // 数据腿的日期参数值袋 = 包默认槽位 + 本次 CLI 槽位（**不含** source_slots 产物——
    // 环封口由 validateApp 在上面校验：default_dates 引用数据腿产物 = 加载期拒绝）。
    const legSlots: Record<string, unknown> = { ...(pack.slots ?? {}), ...slots };
    for (const name of pack.sources ?? []) {
      const src = loadSource(String(name));
      const dates = defaultDates(src, legSlots, opts.today);
      const res = await runSource(src, dates, { verbose: false, today: opts.today });
      const day = Object.values(res.dates)[0] as Record<string, any> | undefined;
      const counts = (day?.counts ?? {}) as Record<string, number>;
      const obs = buildSelectObservation(src, (day?.selects ?? {}) as Record<string, any>);
      observed[String(name)] = { selects: obs.selectsFull, counts };
      selectValuesBySource[String(name)] = obs.selectValues;
      const pv = previewTable(src, res.dates);
      // 多日期范围在这里保留完整观察（`dates` 键控）；回写槽位仍取第一天，口径不变。
      const byDate: NonNullable<AppSourceResult["byDate"]> = {};
      for (const [dateKey, entry] of Object.entries(res.dates)) {
        const e = entry as Record<string, any>;
        if (e?.error !== undefined) continue;
        byDate[dateKey] = {
          ...(e.url !== undefined ? { url: String(e.url) } : {}),
          counts: (e.counts ?? {}) as Record<string, number>,
          selects: (e.selects ?? {}) as Record<string, Record<string, string> | null>,
          rows: (e.rows ?? []) as Array<Record<string, string>>,
        };
      }
      sourceResults.push({
        name: String(name), rows: (day?.rows ?? []).length, counts, selects: obs.selects,
        ...(pv ? { preview: pv } : {}),
        ...(res.tool_version ? { tool_version: res.tool_version } : {}),
        ...(Object.keys(byDate).length ? { byDate } : {}),
      });
      if (verbose) console.log(`  source ${name}: ${(day?.rows ?? []).length} 条 ${JSON.stringify(counts)}`);
    }
  }

  // 内核组合根：RunScope + 会话租约 + 执行器装配入口 + attempt 账本；旅程语义留在本适配器。
  let manualInSegment = false;
  return await runExecution({
    source: "declared-flow",
    appId: pack.id,
    planPath: opts.planPath,
    createSession: async () => {
      if (opts.sessionFactory !== undefined) return opts.sessionFactory();
      // 包声明了设备就用它（只有手机版页面存在的站点，桌面 DOM 里 hint 必然落空）
      const device = (pack.device ?? null) as Parameters<typeof browserSession>[1];
      // 人工步默认开可见窗口：人要在里面登录/过验证码；`--headful` 只是显式同义。
      const headless = opts.headful !== true && !manualInSegment;
      // task-43：meta.policy.browser 通道随 pack 下传（env 盖 meta 语义见 launchKwargs 单源）。
      return browserSession(headless, device, pack.policy?.browser ?? null);
    },
  }, async (exec) => {
    const { planPath, outDir, runId } = exec.artifacts;

  // ---- 数据腿 → 槽位（回写的唯一实现在 `app-pack.resolveSourceSlots`） --------
  // 优先级：包里的默认值 < **数据腿查到的观测值** < CLI 显式 `--slot`。
  // 观测值压过默认值正是这条声明存在的理由（"打开榜首"的 URL 不该是人抄进包里的过期字面量）；
  // 而人这次显式给的值压过观测值——那是"这次就用这个"的显式意图。
  const sourceSlots = resolveSourceSlots(pack, observed, selectValuesBySource);
  const expanded = expandPack(pack, { ...sourceSlots, ...slots }, planPath);
  const plan = expanded.plan;
  // R3/U2b：**计划文件也是产物**——敏感槽位的明文只留在内存里的运行袋，落盘的 plan 一律
  // 掩码。plan.save() 在每一步状态变化时都会被调，这里包一层：只在写盘那一刻换成掩码副本，
  // 写完立刻还原（执行器解析 `{from:"slot"}` 绑定时读的仍是真值）。
  if (secretKeys.size > 0) {
    const originalSave = plan.save.bind(plan);
    plan.save = (): void => {
      const live = plan.slots;
      const masked: Record<string, unknown> = { ...live };
      for (const key of secretKeys) if (key in masked) masked[key] = MASKED_SLOT;
      try {
        plan.slots = masked;
        originalSave();
      } finally {
        plan.slots = live;
      }
    };
  }
  // 人工步默认开可见窗口：人在里面登录/过验证码；未选中的段内人工步不影响本次 headless 选择。
  // 相对 start_url 按仓库根解析成 file://：应用包写仓库内路径，
  // 不写死绝对路径，换机器/换 checkout 目录仍然可跑。
  for (const sg of plan.subgoals) {
    if (sg.start_url) sg.start_url = startUrl(sg.start_url);
  }
  // 消融臂：剥的是**展开后的计划**，包文件从头到尾没被碰过（缺省等价：不声明=零动作）。
  if (opts.forceHints === true) {
    for (const sg of plan.subgoals) {
      delete (sg as { target_hint?: string }).target_hint;
      delete (sg as { target_hints?: string[] }).target_hints;
    }
  }
  if (verbose) {
    const kinds = expanded.steps.map((s) => s.adapter).join(",");
    console.log(`=== app ${pack.id} (${pack.label}) ===`);
    console.log(`  journey: ${expanded.steps.length} step(s) [${kinds}], roles: ${expanded.rolesUsed.join(", ") || "-"}`);
    if (expanded.steps.length === 0 && pack.probe !== undefined) {
      const sets = pack.probe as Record<string, unknown>;
      const n = ["http", "alts", "mobile", "capture"]
        .reduce((k, key) => k + (Array.isArray(sets[key]) ? (sets[key] as unknown[]).length : 0), 0);
      console.log(`  测量型应用（探针集）：${n} 个目标；测量入口见 apps/README.md 的探针一节`);
    }
  }

  // ---- 旅程：逐步骤按类型执行（浏览器步走执行器，工具步走命令行） -----------
  // §3：运行策略的生效值与来源见 `resolveRunPolicy`（脚本驱动共用同一份）。
  const { policy, anyDeclared } = resolveRunPolicy(pack, opts);
  // Slice 2（应用支持器）：运行级数据集——步骤信号成立后写入 `returns`，后续步骤以
  // `{dataset:NAME}` 消费；重跑（next 回边）前先失效，下游不会读到陈旧世代。
  const dataset = opts.dataset ?? new DatasetStore();
  const returnsByStep = new Map<string, string[]>();
  const runOpts: AppRunOptions = {
    ...opts, dataset,
    // 工具步的 source JSON 日期参数用同一个值袋（包默认 + CLI 覆盖）。
    slotBag: { ...(pack.slots ?? {}), ...(opts.slots ?? {}) },
  };
  const mwOptions: Omit<MiddlewareOptions, "confirmFn"> = {
    modelId,
    auditor: new MockAuditor(),
    // Slice 2：浏览器命令步可以 `{"from":"dataset","key":"NAME"}` 消费前序步骤的返回值。
    dataset,
    maxSteps: 8,
    confFloor: policy.conf_floor.value,
    candidatePriority: policy.candidate_priority.value,
    riskyThreshold: 0.6,
    doneThreshold: 0.5,
    // P0-4（导航信封）：`hosts` 若只在**加载期**校验类型、给防泄漏门禁当输入，
    // 运行期不参与检查——包就可以导航到任何主机；包声明的 hosts 就是这次旅程的信封：未声明的主机在 goto 前拒绝、动作后落到未声明主机即停（结构化理由）。
    // 空列表/未声明 = 不启用信封：离线夹具包逐字节不受影响。
    hosts: (pack.hosts ?? null) as string[] | null,
    // P1 窄问开关（默认关；开了也只影响"档内歧义的 hint 步"问模型的范围，阶梯与 method 不动；§3 优先级 CLI(本次) > pack.policy(声明) > 缺省(false)，不写 policy 的包逐字节不变）。
    tieredHint: policy.tiered_hint.value,
    // A3：弱档算不算命中（缺省 any；strong = 弱档改判未命中，再按 actHint 语义走——声明式
    // 路径本就不传 actHint，故 strong 在此等于"交模型"，与 flow 面 widen+strong 同语义）。
    actHintTier: policy.act_hint_tier?.value,
    // P0-C：DRF（缺省 declared = 批准的默认翻转；"off" = 显式 opt-out）——journey 面与
    // flow 面消费同一份生效账：effective_policy 记 declared，执行器就开着（账实一致）。
    targetResolution: policy.target_resolution.value,
    // F74：DOM 回退跳（缺省 false = 逐字节不变；true = 声明 hint 全链落空后补 A3 对称跳）。
    actHintDomFallback: policy.act_hint_dom_fallback?.value === true,
    // A1：aria-label 属性 hint 的池侧匹配底座（缺省 full_label = 修复后；display = A1 之前）。
    attrValueMatch: policy.attr_value_match?.value,
    // F84 批 3（deny-list 可配化）：词元护栏放行表（缺省不写 = 护栏行为逐字节不变）。
    hintTokenAllow: policy.hint_token_allow?.value,
    // §W1：`risk_ask: rules-only` 让"要不要拦"不再花一次每步的前向（批模式下它的答案本来就被丢掉）。
    riskAsk: policy.risk_ask.value === "rules-only" ? "rules-only" : "always",
    reobserve: policy.reobserve.value,
    maxEffectiveRepeats: policy.max_effective_repeats.value,
    // S1 状态层：pre-held done 默认 warn（行为不变），fill 读回默认开。
    donePreheldPolicy: policy.done_preheld.value,
    // P0-E：done 成立后的只读复核 guard（缺省 warn = 只记录，行为不变）。
    doneGuardPolicy: policy.done_guard.value,
    fillReadback: policy.effect_readback.value.fill,
    // S2：稳定门（缺省开；null = meta.policy.settle:"off"）。
    settle: policy.settle.value,
    // S5：状态接入决策（两项缺省 off = 今天的行为；见 PackPolicy.decision_state）。
    decisionState: policy.decision_state.value,
    // R2：学习环（不开 = null = 今天逐字节；authored hint 恒优先于学到的）。
    hintMemory: opts.hintMemory ?? null,
    // 动作间最小等待（应用配置表 `pace.between_actions_ms` / 环境变量；0 = 今天的行为）。
    actionDelayMs: pace.between_actions_ms,
    // E2/E1-c/E1-a/E1-b：决策开关（decision.*）从配置层默认值解析（非法值已在 CLI 入口报错）。
    ...(decisionDefaults.ambiguousOrdering === undefined ? {} : { ambiguousOrdering: decisionDefaults.ambiguousOrdering }),
    ...(decisionDefaults.idFallback === undefined ? {} : { idFallback: decisionDefaults.idFallback }),
    ...(decisionDefaults.actPoolCap === undefined ? {} : { actPoolCap: decisionDefaults.actPoolCap }),
    ...(decisionDefaults.poolQuotaMode === undefined ? {} : { poolQuotaMode: decisionDefaults.poolQuotaMode }),
  };
  const mw = exec.middleware(() => buildMiddleware({
    face: "app-declared",
    confirmPolicy: { kind: "safe-browser", confirmSafe },
    options: mwOptions,
  }));
  await probeCompatDecisionPlane(() => mw);
  // task-15（D2）：声明式路径同账——SITE_FACTS 按 meta.hosts 匹配（stderr 提示 + result.site_facts）。
  const siteFacts = matchSiteFacts(loadSiteFacts((m) => console.error(m)), (pack.hosts ?? []) as string[]);
  for (const line of renderSiteFactLines(siteFacts)) console.error(line);

  // 会话由内核租约持有（首个浏览器步才建；收尾关一次）。执行器拿到的是**壳**：
  // 它关掉的是这个壳，真正的 page 留到结束态不变量之后。
  const getShell = async (): Promise<BrowserSession> => {
    const s = await exec.session();
    return { page: s.page, pw: s.pw, browser: s.browser, close: async () => {} };
  };

  const runManualStep = async (decl: ManualStepDecl, st: ExpandedStep): Promise<ManualStepRun> => {
    let page: BrowserSession["page"] | null = null;
    let url: string | null = null;
    if (decl.start_url !== null) {
      const target = startUrl(decl.start_url);
      const denied = disallowedHost(target, pack.hosts ?? null);
      if (denied !== null) {
        return { done: false, reason: `host_not_allowed: '${denied}' is not among the declared hosts` };
      }
      const shell = await getShell();
      try {
        await (shell.page as unknown as { goto(u: string, o?: unknown): Promise<unknown> })
          .goto(target, { waitUntil: "domcontentloaded", timeout: NAVIGATION_GOTO_TIMEOUT_MS });
      } catch (e) {
        return { done: false, reason: `navigation_failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      page = shell.page;
      url = target;
    } else if (exec.peekSession() !== null) {
      page = exec.peekSession()!.page;
      try { url = String((page as unknown as { url(): string }).url()); } catch { url = null; }
    }
    if (verbose) {
      console.log(`  [manual] step ${st.index}: ${decl.desc}`);
      if (decl.instructions) console.log(`    ${decl.instructions}`);
      if (url) console.log(`    页面：${url}`);
    }
    let approved: boolean;
    const req: ManualStepRequest = {
      index: st.index, desc: decl.desc,
      instructions: decl.instructions ?? "", url,
    };
    // §8 步 3「只换确认提供者，不改判定」：选路收敛进 intervention-adapter（handler > TTY >
    // none）；判定（approved→done / declined 原文 / handler 抛错原文前缀）原样留在下面。
    const approver = pickManualApprover(opts.manualHandler !== undefined, process.stdin.isTTY);
    try {
      approved = opts.manualHandler !== undefined
        ? await opts.manualHandler(req)
        : await promptManualOnTty(req);
    } catch (e) {
      // 影子旁路（默认关）：handler 抛错 = unavailable/by=approver 通道（§3 通道抛错闭环）。
      shadowManualOutcome(rescueShadowRecorder, {
        desc: decl.desc, stepId: String(st.id ?? st.index), instructions: decl.instructions ?? "", pageUrl: url,
      }, { status: "unavailable", by: approver.channel, legacyStopCode: "manual_handler_error" });
      return { done: false, reason: `manual_handler_error: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!approved) {
      shadowManualOutcome(rescueShadowRecorder, {
        desc: decl.desc, stepId: String(st.id ?? st.index), instructions: decl.instructions ?? "", pageUrl: url,
      }, { status: "declined", by: approver.channel, legacyStopCode: "manual_declined" });
      return { done: false, reason: "declined" };
    }
    // `{manual:true}` = 人自证（报告记 attested）；任何 DOM 信号都要引擎再验一遍。
    if ("manual" in decl.signal) {
      shadowManualOutcome(rescueShadowRecorder, {
        desc: decl.desc, stepId: String(st.id ?? st.index), instructions: decl.instructions ?? "", pageUrl: url,
      }, { status: "fulfilled", by: approver.channel });
      return { done: true, attested: true };
    }
    if (page === null) {
      return { done: false, reason: "manual DOM signal needs a page (declare start_url or run after a browser step)" };
    }
    const held = await checkSignal(page as never, decl.signal, { hosts: pack.hosts ?? null });
    if (!held) {
      shadowManualOutcome(rescueShadowRecorder, {
        desc: decl.desc, stepId: String(st.id ?? st.index), instructions: decl.instructions ?? "", pageUrl: url,
      }, { status: "fulfilled", by: approver.channel, legacyStopCode: "manual_signal_not_held" });
    }
    return held ? { done: true, attested: false } : { done: false, reason: "manual_signal_not_held" };
  };

  const toolSteps: ToolStepResult[] = [];
  const manualSteps: NonNullable<AppRunResult["manual_steps"]> = [];
  const invariantResults: AppInvariantResult[] = [];
  /** 每一步的判定方式（trace 原样收集）——P1 的出场率/挽回数从这儿数出来，不另造机制。 */
  const decisionSteps: TraceStep[] = [];
  /** 每个 `ctx.step` 一次 mw.run；这里按调用顺序保留它的动作 trace，供 step_traces 补 hows/descs/methods。 */
  const decisionStepGroups: TraceStep[][] = [];
  // S0（NL Flow）：`captureTraces` 开着才收集（见 AppRunOptions.captureTraces）。
  const stepTraces: NonNullable<AppRunResult["step_traces"]> = [];
  // 浏览器步在 `plan.subgoals` 里的下标：`next` 允许跳步，所以不能再靠一个自增计数器
  // （那是"位置即身份"，而边是按**名字**声明的）。
  const browserIndexOf: number[] = [];
  {
    let k = 0;
    for (const s of expanded.steps) browserIndexOf.push(s.adapter === "web" ? k++ : -1);
  }
  // P4 走向：一份实现（`plan.createPathWalk`），带**路径上界**——`maxSteps=8` 是每步的预算，
  // 不是每一条路径的（X4）。环到顶就是显式停因，不是挂死、不是栈溢出。
  const walk = createPathWalk(expanded.steps, pack.max_step_visits ?? DEFAULT_MAX_STEP_VISITS);
  const pathCrossed: string[] = [];
  let pathStopOut: AppRunResult["path_stop"];
  // 应用支持器运行上下文：web/cli 两个内建适配器
  // **迁移桥**——执行委托回下面两个服务（执行循环本身不搬进适配器）；新类型自己实现 run。
  const rescueBuilder = opts.rescue === true ? new RescueRequestBuilder(runId) : null;
  // §8 步 3 影子旁路（journey 声明式人工步）：仅 AMBERFLOW_RESCUE_SHADOW=1 创建；判定逻辑
  // 零变化，收尾 flush 到 outDir/rescue-shadow.json（sidecar 不进 result/trace/report）。
  const rescueShadowRecorder = isRescueShadowEnabled() ? createShadowRecorder(runId) : null;
  const adapterCtx: AdapterRunContext = {
    outDir,
    verbose,
    dataset,
    runId,
    runWebStep: async (st: ExpandedStep): Promise<{ done: boolean }> => {
      const sg = plan.subgoals[browserIndexOf[st.index]!]!;
      const shell = await getShell();
      // S0 上下文实验：快照这一步**开始时**的页面（只读；本开关打开才多付一次导航）。
      let stateView: StepStateView | null = null;
      if (opts.captureTraces && opts.captureStateView && sg.start_url) {
        try {
          await (shell.page as unknown as { goto(u: string, o?: unknown): Promise<unknown> }).goto(sg.start_url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_GOTO_TIMEOUT_MS });
          stateView = await captureStepStateView(shell.page as never, (p) => createAppCandidateProducer().extract({ page: p }));
        } catch { stateView = null; }
      }
      const { rep, attempt, steps } = await runSubgoalWithRetries(
        mw as never, sg, plan, sg.start_url ?? "", shell.page, shell.pw, verbose);
      decisionSteps.push(...steps); rememberAppStopContext(adapterCtx, rep);
      if (opts.captureTraces) {
        const executed = rep.steps.filter((t) => t.executed);
        // A1 子改动③：after 签名与 hows 一一对齐；全 null 时整字段省略（产物最小纪律）。
        const afters = executed.map((t) => asAfterSignature(t.after));
        stepTraces.push({
          index: st.index ?? 0,
          id: st.id ?? null,
          desc: sg.desc,
          status: rep.done ? (rep.skipped ? "skipped" : "done") : "blocked",
          hows: executed.map((t) => String(t.how ?? "")),
          descs: executed.map((t) => String(t.desc ?? "")),
          methods: rep.steps.map((t) => String(t.method ?? "")).filter(Boolean),
          ...(afters.some((a) => a !== null) ? { afters } : {}),
          ...(stateView ? { state_view: stateView } : {}),
          // S1：状态记录与 flow 路径同一字段（声明式路径 captureTraces 时才收集）。
          ...(rep.state === undefined || rep.state === null
            ? {} : { state: rep.state as StepStateRecord }),
        });
      }
      sg.status = rep.done ? (rep.skipped ? "skipped" : "done") : "blocked";
      sg.attempts = exec.attempts.record(`step:${String(sg.id ?? sg.desc)}`, attempt);   // attempt 记账单点（与 flow/suite 同源）
      sg.obstacle = rep.done ? null : rep.stop_reason;
      if (!rep.done && rep.stop_code) (sg as Record<string, unknown>).stop_code = rep.stop_code;
      plan.save();
      return { done: rep.done };
    },
    runCliStep: async (st: ExpandedStep) => runToolStep(st, runOpts),
    runManualStep,
  };
  // ---- 分段调试：只跑一段声明步骤（Phase 3）。完整跑保持原逻辑。 -----------------
  const segmentRequested = opts.onlyStep !== undefined || opts.fromStep !== undefined
    || opts.segmentMaxSteps !== undefined;
  if (opts.onlyStep !== undefined && opts.fromStep !== undefined) {
    throw new AppRunConfigError("only_step 与 from_step 不能同时使用");
  }
  for (const [name, n] of [["only_step", opts.onlyStep], ["from_step", opts.fromStep], ["max_steps", opts.segmentMaxSteps]] as const) {
    if (n !== undefined && (!Number.isInteger(n) || n < 1)) {
      throw new AppRunConfigError(`${name} 需要正整数（收到 ${String(n)}）`);
    }
  }
  const segmentStart = opts.onlyStep !== undefined ? opts.onlyStep - 1
    : opts.fromStep !== undefined ? opts.fromStep - 1 : 0;
  if (segmentStart >= expanded.steps.length) {
    throw new AppRunConfigError(`step ${segmentStart + 1} 超出范围：这次展开只有 ${expanded.steps.length} 步`);
  }
  const segmentLimit = opts.onlyStep !== undefined ? 1
    : opts.segmentMaxSteps ?? Number.POSITIVE_INFINITY;
  const segmentEnd = Math.min(expanded.steps.length, segmentStart + segmentLimit);
  const segmentSteps = expanded.steps.slice(segmentStart, segmentEnd);
  manualInSegment = segmentSteps.some((st) => st.adapter === "manual");
  // 非交互调用（桥）遇到本段的 manual 步：不猜、不假装有人在，也不在没有显示器时硬拉
  // headed 浏览器（那会变成一句 Playwright 启动失败）。直接返回结构化 needs_human。
  if (manualInSegment && opts.manualFailFast === true && opts.manualHandler === undefined && !process.stdin.isTTY) {
    const manualSteps = segmentSteps
      .filter((st) => st.adapter === "manual")
      .map((st) => ({ index: st.index, desc: st.desc, done: false, attested: false, reason: "needs_interactive_terminal" }));
    const selectedBrowserIndices = new Set(segmentSteps
      .map((st, i) => browserIndexOf[segmentStart + i] ?? -1)
      .filter((j) => j >= 0));
    return {
      app: pack.id, label: pack.label, goal: pack.goal,
      pack_path: pack._path ?? "", plan_path: planPath,
      ...(expanded.rolesUsed.length ? { roles_used: expanded.rolesUsed } : {}),
      slots: maskSecretSlots(expanded.slots, secretKeys),
      completed: `0/${segmentSteps.length}`,
      subgoals: plan.subgoals.map((sg, j) => ({
        desc: sg.desc,
        status: selectedBrowserIndices.has(j) ? (sg.status ?? "pending") : "skipped",
        attempts: sg.attempts ?? 0, obstacle: sg.obstacle ?? null,
      })),
      tool_steps: [], invariants: [], manual_steps: manualSteps,
      ...rescueField(rescueBuilder, journeyRescueInput(manualSteps, [], undefined)),
      sources: [], ok: false, secs: 0,
      decisions: summarizeDecisions([], null, 0),
      ...(segmentRequested ? { partial: true as const, segment: { from: segmentStart + 1, to: segmentEnd } } : {}),
    };
  }
  const executedIndices = new Set<number>();
  let executedCount = 0;
  // B1 最小步间距：相邻两个 journey 步**开始时刻**至少隔 pace.between_steps_ms
  // （start-to-start ≥ gap；上一步耗时长则不补等；undefined = 首个单元之前不等）。
  let lastStepStartTs: number | undefined;
  try {
    let i = segmentStart;
    while (i < expanded.steps.length && i < segmentEnd && executedCount < segmentLimit) {
      if (i < segmentStart) break;
      const step = expanded.steps[i]!;
      executedIndices.add(i);
      executedCount++;
      // 进入这一步：同一个步 id 走太多遍 = 声明的 `next` 边成了环。
      const over = walk.enter(i);
      if (over !== null) {
        pathStopOut = {
          code: "next_cycle",
          step_id: over.id,
          visits: over.visits,
          detail: `step ${JSON.stringify(over.id)} was entered ${over.visits} time(s) in one run`
            + ` (per-path bound max_step_visits=${pack.max_step_visits ?? DEFAULT_MAX_STEP_VISITS})`
            + ` — a declared \`next\` edge forms a cycle; stopping instead of looping forever`,
        };
        const sg = browserIndexOf[i]! >= 0 ? plan.subgoals[browserIndexOf[i]!] : undefined;
        if (sg) { sg.status = "blocked"; sg.obstacle = pathStopOut.detail; plan.save(); }
        if (verbose) console.log(`  [journey] ${pathStopOut.detail}`);
        break;
      }
      // 应用支持器分派：一种类型 = 一个适配器（web/cli 走迁移桥，新类型原生执行）。
      const adapter = getAppAdapter(step.adapter);
      if (adapter === undefined) {
        throw new AppRunConfigError(`unknown app adapter ${JSON.stringify(step.adapter)} `
          + `on step #${step.index} (known: web, cli)`);
      }
      // `next` 回边/重跑：这一步上次写过的返回值在重新执行前先失效（数据集纪律：
      // 陈旧世代不可读，下游会以 needs_value 结构化停，而不是静默使用旧值）。
      const stepKey = step.id ?? `#${step.index}`;
      for (const by of returnsByStep.get(stepKey) ?? []) dataset.invalidateStep(by);
      returnsByStep.delete(stepKey);
      // B1 最小步间距（应用配置表 `pace.between_steps_ms` / 环境变量；0 = 今天的行为）：
      // 本步开始时刻与上一步开始时刻至少隔 gap——等待量 = paceRemainder(...)，
      // 不是「上一步 outcome 后无条件 sleep」（也不会在最后一步之后补等）。
      if (pace.between_steps_ms > 0) {
        const now = Date.now();
        const wait = paceRemainder(pace.between_steps_ms, lastStepStartTs, now);
        if (wait > 0) await sleepMs(wait);
        lastStepStartTs = now + wait;
      }
      const outcome = await adapter.run(step.decl, step, adapterCtx);
      if (step.adapter === "manual") {
        manualSteps.push({
          index: step.index, desc: step.desc, done: outcome.done,
          // 显式写 false：报告能区分"DOM 验过"与"人自证"，缺字段会让两种证据看起来一样。
          attested: outcome.attested === true,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        });
        if (verbose) {
          console.log(`  [manual] step ${step.index}: ${outcome.done ? "done" : `not done (${outcome.reason ?? "unknown"})`}`
            + `${outcome.attested === true ? " [human attestation]" : ""}`);
        }
      }
      // （B1：步间等待已移到本步开始前的最小间距点——见上面 paceRemainder 处。）
      if (outcome.tool) {
        if (outcome.done && outcome.returns !== undefined) {
          // 声明的抽取执行过了：哪怕一个都没抽到，也在证据面留 {}（"执行了，只是没抽到"）。
          outcome.tool.returns = outcome.returns;
          if (Object.keys(outcome.returns).length > 0) {
            const writtenBy = `${stepKey}#${outcome.tool.attempts || 1}`;
            for (const [name, value] of Object.entries(outcome.returns)) {
              dataset.write(name, value, writtenBy);
            }
            returnsByStep.set(stepKey, [writtenBy]);
          }
        }
        toolSteps.push(outcome.tool);
      }
      // 声明式后继：按序取第一个"此刻适用"的候选；都没声明/都不适用 ⇒ 自然顺序。
      // 适用性问的是该步**自己的 `when`**（"这一步适不适用"），问在当次页面上——
      // 这一步没有模型参与，走向由声明与页面证据决定（红线①）。
      const from = i;
      i = await walk.after(i, async (j) => {
        const cand = expanded.steps[j]!;
        if (cand.adapter !== "web") return true;             // 非 web 步没有 `when`：声明了就适用（Slice 1 边界）
        const sg = plan.subgoals[browserIndexOf[j]!];
        const when = sg?.when;
        if (when === undefined || when === null) return true;
        if (exec.peekSession() === null) {
          // 还没有页面可问（旅程第一步是工具步、候选却在浏览器步上）：此刻无法成立，
          // 如实当作"不适用"，继续看下一个候选——不为了让分支走通去偷偷开一个浏览器。
          if (verbose) console.log(`  [journey] next candidate ${JSON.stringify(cand.id ?? j)} not evaluated (no page yet)`);
          return false;
        }
        return await checkSignal(exec.peekSession()!.page as never, when, { hosts: pack.hosts ?? null });
      });
      // 被声明式边**跨过去**的步：这条边就是作者对"这条路径上它不适用"的声明，
      // 所以记成 `skipped`（不是留在 pending——那会让任何前向分支都红）。
      // 记的是"跨过"这件事本身，报告里单列（`path_crossed`），不与 `when` 自然的跳过混为一谈。
      if (i > from + 1) {
        for (let k = from + 1; k < i; k++) {
          const crossed = expanded.steps[k]!;
          if (crossed.adapter === "web") {
            const sg = plan.subgoals[browserIndexOf[k]!]!;
            if (sg.status === "pending") { sg.status = "skipped"; plan.save(); }
          }
          pathCrossed.push(`${crossed.id ?? `#${crossed.index}`} (crossed by \`next\` from ${expanded.steps[from]!.id ?? `#${expanded.steps[from]!.index}`})`);
          if (verbose) console.log(`  [journey] step ${crossed.id ?? `#${crossed.index}`} crossed by a declared next edge -> skipped`);
        }
      }
    }
    // ---- 验收：结束状态上的不变量（同一会话、同一 cookie/页面） -------------
    // 分段跑不验收整条旅程：它不是“完整流程通过”，只是“这一段通过”。
    if (!segmentRequested) {
    // 结束态/不变量要读的会话（惰性未建 = null：web 不变量按"未成立"处理）。
    const live = exec.peekSession();
    // `expanded.invariants`（不是 pack.invariants）：展开期已做槽位替换，与 journey 同一套规则。
    for (const inv of expanded.invariants) {
      const kind = inv.adapter ?? "web";
      let held = false;
      if (kind === "web") {
        // web 不变量：在浏览器会话的结束状态上求值（既有语义，逐字节不变）。
        held = live === null ? false : await checkSignal(live.page as never, inv.signal as never, { hosts: pack.hosts ?? null });
      } else {
        // 进程族不变量：用该类型的**只读观察探针**在旅程结束后再验一次（如 ssh 看远端文件还在）。
        const adapter = getAppAdapter(kind);
        if (adapter !== undefined) {
          const probe: ExpandedStep = {
            index: -1, adapter: adapter.kind, kind: adapter.legacyKind,
            desc: inv.desc ?? inv.id, role: null, id: inv.id, next: [], decl: inv.decl,
          };
          const out = await adapter.run(inv.decl, probe, adapterCtx);
          held = out.done;
        }
      }
      invariantResults.push({
        id: inv.id, desc: inv.desc ?? inv.id, held,
        ...(kind !== "web" ? { adapter: kind } : {}),
      });
      if (verbose) console.log(`  invariant ${inv.id}${kind === "web" ? "" : ` [${kind}]`}: ${held ? "held" : "VIOLATED"}`);
    }
    // 结束态必须在 session 关掉**之前**抓（否则抓到的是一个已关闭的页面）。
    // 捕获失败不该让一条本来成功的旅程变红，但也不能静默——verbose 下说明原因。
    if (opts.captureState && live !== null) {
      try {
        endState = await captureStateView(live.page as never);
      } catch (e) {
        if (verbose) console.log(`  end-state capture failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    }
  } finally {
    await exec.close();
  }

  // Slice 4：类型账（只在**混用 ≥2 种类型**的旅程里出现，单一类型产物逐字节不变）。
  const typeCounts: Record<string, number> = {};
  for (const st of expanded.steps) typeCounts[st.adapter] = (typeCounts[st.adapter] ?? 0) + 1;
  const stepTypes = Object.keys(typeCounts).length > 1 ? typeCounts : undefined;
  // 分段跑：没进入的浏览器步不是“阻塞”，而是“本次没走”；标成 skipped，避免摘要把
  // `from_step` 之前的 pending 误报成 blocked。
  const selectedBrowserSubgoals = plan.subgoals.filter((_, j) => {
    for (const idx of executedIndices) if (browserIndexOf[idx] === j) return true;
    return false;
  });
  if (segmentRequested) {
    const selected = new Set(selectedBrowserSubgoals);
    for (const sg of plan.subgoals) {
      if (!selected.has(sg) && sg.status === "pending") sg.status = "skipped";
    }
  }
  const subgoals = plan.subgoals.map((s) => ({
    desc: s.desc, status: s.status, attempts: s.attempts ?? 1, obstacle: s.obstacle ?? null,
  }));
  const browserOk = (segmentRequested ? selectedBrowserSubgoals : subgoals)
    .every((s) => s.status === "done" || s.status === "skipped");
  const toolsOk = toolSteps.every((t) => t.done);
  const manualOk = manualSteps.every((m) => m.done);
  // 路径上界到顶 = 这次旅程没有走完（即使被环卷进去的那一步恰好是工具步，也不能算绿）。
  const ok = browserOk && toolsOk && manualOk
    && (segmentRequested ? true : invariantResults.every((i) => i.held))
    && pathStopOut === undefined;
  // 数的是**声明出来的步**，不是"跑了几趟"：`next` 回边会让同一个工具步跑很多遍，
  // 那样 `completed` 会写出 `100/2` 这种读不通的数（真要读趟数看 `path_visits`）。
  const doneCount = (segmentRequested ? selectedBrowserSubgoals : subgoals)
    .filter((s) => s.status === "done" || s.status === "skipped").length
    + new Set(toolSteps.filter((t) => t.done).map((t) => t.index)).size
    + new Set(manualSteps.filter((m) => m.done).map((m) => m.index)).size;
  const stats = opts.runtimeStats ? opts.runtimeStats() : null;
  // §8 步 3 影子旁路收尾：journey 面的 sidecar（开关默认关 = 零产物；失败静默不影响结果）。
  if (rescueShadowRecorder !== null) {
    rescueShadowRecorder.flush(outDir);
  }
  return {
    app: pack.id, label: pack.label, goal: pack.goal,
    pack_path: pack._path ?? "", plan_path: planPath,
    ...(expanded.rolesUsed.length ? { roles_used: expanded.rolesUsed } : {}),
    slots: maskSecretSlots(expanded.slots, secretKeys),
    completed: `${doneCount}/${segmentRequested ? executedIndices.size : expanded.steps.length}`,
    subgoals, tool_steps: toolSteps, invariants: invariantResults,
    ...(manualSteps.length ? { manual_steps: manualSteps } : {}),
    ...rescueField(rescueBuilder, journeyRescueInput(manualSteps, toolSteps, pathStopOut)),
    ...(paceNonDefault(pace) ? { pace } : {}),
    ...(stepTypes !== undefined ? { step_types: stepTypes } : {}),
    ...(opts.captureTraces ? { step_traces: stepTraces } : {}),
    // Slice 2：返回值传递的审计面（缺省不出现——没有 returns 的包产物逐字节不变）。
    ...(dataset.entriesView().length > 0 ? { dataset_view: [...dataset.entriesView()] } : {}),
    // 只在**真的走回来过**时才写这个字段：声明了 id 但没走边的包，结果 JSON 与今天一模一样
    // （缺省等价的纪律：新字段不该只是"多一行没人看的数"）。
    ...(Object.values(walk.visits()).some((n) => n > 1) ? { path_visits: walk.visits() } : {}),
    ...(pathCrossed.length ? { path_crossed: pathCrossed } : {}),
    ...(pathStopOut ? { path_stop: pathStopOut } : {}), ...appStopContextFields(adapterCtx),
    ...(endState ? { end_state: endState } : {}),
    // §3：生效策略**只在非缺省时写进产物**（与 path_visits 同一纪律）。
    // 来源三态要说清：CLI 本次覆盖 / 包声明 / 都没写——否则报告看不出这次跑的和上次是不是同一件事。
    ...(anyDeclared && policy !== null ? { effective_policy: policy } : {}),
    // 换模型测试的对照靠这个字段：层级只说"有没有决策层"，身份才说"是哪一家"。
    ...(opts.providerInfo ? { decision_provider: opts.providerInfo } : {}),
    ...(opts.modelStatus !== undefined ? { model_status: opts.modelStatus } : {}),
    // 消融跑要能被产物读出来（不声明 ⇒ 字段缺席，逐字节与今天相同）。
    ...(opts.forceHints === true ? { hint_ablation: true } : {}),
    decisions: summarizeDecisions(decisionSteps, stats, opts.pickAsks ? opts.pickAsks() : 0,
      opts.pickFailedAsks ? opts.pickFailedAsks() : 0,
      // S5：policy 声明了 decision_state 才投影指标（缺省 ⇒ null ⇒ 字段缺席，产物不变）。
      policy.decision_state.source === "app" ? mw.decisionStateMetrics() : null,
      // U8：被拒 ask 的 conf 分布（执行器闸门分支记账；n=0 ⇒ null ⇒ 字段缺席）。
      mw.rejectedAskConfMetrics()),
    // R2：学习环的账——只在**开了**的时候写字段（缺省等价纪律，同 path_visits）。
    // `rejected` 要 cast：接口只承诺 entries/used，它是 HintMemory 实现多给的——
    // 跨实现注入（别的记忆实现）时不能假设它在。
    ...(opts.hintMemory ? {
      hint_memory: {
        path: opts.hintMemoryPath ?? null,
        entries: opts.hintMemory.stats?.().entries ?? 0,
        used: opts.hintMemory.stats?.().used ?? 0,
        rejected: (opts.hintMemory.stats?.() as { rejected?: number } | undefined)?.rejected ?? 0,
      },
    } : {}),
    // 风险头掉线时执行器退回到关键词规则——**这件事必须出现在产物里**，
    // 否则一次"退化的运行"和一次正常的运行会共用同一个绿色。
    ...(mw.riskDegraded ? { risk_degraded: mw.riskDegraded } : {}),
    // 在线 provider 掉线/没配好 ⇒ 本次跑降级到 rules-only——同样必须出现在产物里（同 risk_degraded）。
    ...(mw.providerDegraded ? { provider_degraded: mw.providerDegraded } : {}),
    // task-14（D1）：决策面兼容降级留痕（仅 degraded 时出现，只增字段——两条路径同账）。
    ...(mw.decisionDegraded !== null ? { decision: { degraded: mw.decisionDegraded } } : {}),
    // task-15（D2）：site_facts 仅命中时出现（只增字段——两条路径同账）。
    ...(siteFacts.length > 0 ? {
      site_facts: siteFacts.map((f) => ({ site: f.site, id: f.id, as_of: f.as_of, evidence: f.evidence, statement: f.statement })),
    } : {}),
    sources: sourceResults,
    // 数据腿**真的写回**了哪些槽位（缺省等价：没回写就不出现这个字段）。
    ...(Object.keys(sourceSlots).length > 0
      ? { source_slots: maskSecretSlots(sourceSlots, secretKeys) as Record<string, string> }
      : {}),
    ok,
    verified: !segmentRequested && ok,
    ...(segmentRequested ? { partial: true as const, segment: { from: segmentStart + 1, to: segmentEnd } } : {}),
    secs: Math.round((Date.now() - t0) / 100) / 10,
  };
  });
}
