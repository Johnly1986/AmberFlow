/**
 * run 视图 parity lane —— 两条模型可见 run 状态投影的对账（离线、零网络、零浏览器、零模型）。
 *
 * 同一份运行产物被两个消费面各投影一次：
 *   - `src/app/agent-view.ts` 的 `toAgentRunView`：CLI `amber run --json` 的 `data`，状态是
 *     `AgentRunStatus` 闭集；
 *   - `integrations/dsh-bridge/src/bridge.ts` 的 `summarizeRun`：DSH 桥 `…_run` 工具的输出，
 *     `RunSummary.status?: string`（类型上无闭集）。
 * 本 lane 用固定 result JSON（按真实产物形状）走两条投影，逐字段比较语义；比较的项固定为：
 * status / ok / verified / dry / partial / completed / invariants / failure（presence + step /
 * desc / stop_code / obstacle）/ 步数 / 截断标注 / 截断总数 / MAX_STEPS 预算，另加 status 词表闭集
 * 与 `MAX_STEPS` 两处写的一致性。任何一条**未登记**的差异 = exit 1。
 *
 * 白名单纪律：当前已存在的差异必须逐条登记（场景 + 字段 + 两侧取值 + 判断：audience 语义差异 /
 * 缺陷 + 依据）。登记键包含两侧取值，所以差异若**变形**（同一字段换了取值）一样按新差异处理；
 * 若差异**消失**（修好或一侧改了语义）则白名单过期、同样报红——修复后必须收窄登记，避免
 * 白名单变成永久静音。
 *
 * 桥侧读法：`summarizeRun` 是 `bridge.ts` 的公开导出（纯函数：读 `<app>-result.json` 与
 * `ProcessOutcome`，不 spawn），因此 in-process 直接调用即等于桥的真实投影路径。桥包是自包含
 * 构建、不在根 tsconfig 的 program 内，故这里用运行期动态 import（非字面量 specifier）避免把
 * 桥源码并进根类型检查；桥侧类型按用到的字段结构本地声明，不复制整份 `RunSummary`。
 *
 * MAX_STEPS：两侧常量都未导出（本 lane 只读源码、不做行为改动）。预算对账靠两件事：
 * ① 行为边界夹具（20 行不截断 / 21 行两侧同截断）；② 对两份源码的 `const MAX_STEPS` 声明做静态
 * 对账——两处写必须同值且等于本 lane 落地的契约值 20（`agent-view.ts` 头注释「步骤最多 20 条」）。
 *
 * 用法：node --experimental-strip-types tools/verify-run-view-parity.ts [--list | --json]
 * 退出码：0 绿（差异全部按登记值命中、白名单无过期、静态检查与负向自测通过）/ 1 新差异或自测失败 /
 *         2 用法或环境错误。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { toAgentRunView } from "../src/app/agent-view.ts";
import type { AppRunResult } from "../src/app/app-runner-types.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const AGENT_VIEW_SOURCE = path.join(REPO, "src", "app", "agent-view.ts");
const BRIDGE_SOURCE = path.join(REPO, "integrations", "dsh-bridge", "src", "bridge.ts");
const APP_ID = "run-view-parity";
const SCRIPT_SHA = "0".repeat(64);
const PLAN_SHA = "1".repeat(64);

/** 两侧文档共同承诺的模型可见状态（`AgentRunStatus` 里的其余值是预留位，见 docs/AGENT_INTERFACE.md）。 */
const DOCUMENTED_STATUSES = ["passed", "partial", "failed", "blocked", "needs_human", "dry"] as const;

/** `agent-view.ts` 头注释的步数预算（两个投影共用；常量本身未导出，见文件头说明）。 */
const DOCUMENTED_MAX_STEPS = 20;

/* ------------------------------------------------------------------ 类型 */

/** 参与对账的字段。`failure.*` 与 `steps.*` 只在两侧都给出该块时才逐项比较。 */
type Field =
  | "status"
  | "ok"
  | "verified"
  | "dry"
  | "partial"
  | "completed"
  | "invariants"
  | "failure"
  | "failure.step"
  | "failure.desc"
  | "failure.stop_code"
  | "failure.obstacle"
  | "steps.count"
  | "steps.truncated"
  | "steps.total"
  | "steps.bridge_cap";

interface FailureView {
  step: number;
  desc: string;
  stop_code: string | null;
  obstacle: string | null;
}

interface InvariantView {
  held: number;
  total: number;
  failed: string[];
}

/** 固定 result JSON 场量：一个场景代表一种真实产物形状 + 真实进程退出码。 */
interface Scenario {
  id: string;
  /** 供 `--list` 分组阅读的运行形态。 */
  shape: "passed" | "failed" | "blocked" | "manual" | "partial" | "refused" | "dry" | "truncation";
  /** 固定 result JSON；`null` = dry 运行没有 result 产物（只有 app-runner `--dry` 打印的文档）。 */
  result: Record<string, unknown> | null;
  /** app-runner `--dry` 直接打印的 JSON 文档——桥的 `readDryRun` 读的就是这一形状。 */
  dryDoc?: Record<string, unknown>;
  exitCode: number;
  /**
   * 给 agent-view 投影的参数，与 CLI `run` 的调用形态一致（`partial` 由 `result.partial` 决定）。
   * dry 分支不走 run view（CLI dry 信封直接给 events），这里显式传 `dry:true` 读 status 分支。
   */
  agentOptions: { partial?: boolean; dry?: boolean };
  /** 该产物未被截断前的步表行数（独立于两个投影的期望值，用于对账截断总数）。 */
  sourceStepCount: number;
}

interface AgentProjection {
  status: string;
  ok: boolean;
  verified: boolean;
  dry: boolean;
  partial: boolean;
  completed: string;
  invariants: InvariantView;
  failure: FailureView | null;
  stepCount: number;
  truncated: boolean;
}

interface BridgeProjection {
  status: string;
  ok: boolean;
  verified: boolean;
  dry: boolean;
  partial: boolean;
  completed: string;
  invariants: InvariantView;
  failure: FailureView | null;
  stepCount: number;
  truncated: boolean;
  stepsTotal: number | null;
}

interface Pair {
  scenario: Scenario;
  agent: AgentProjection;
  bridge: BridgeProjection;
}

/** 一条两侧取值不同的观测。 */
interface Diff {
  scenario: string;
  field: Field;
  agent: string;
  bridge: string;
}

/**
 * 已登记差异。`agent`/`bridge` 是两侧取值的显示串（`show()` 口径）：登记的是**具体取值对**，
 * 不是「这个字段允许不同」——取值变了照样算新差异。
 */
interface KnownDifference {
  scenario: string;
  field: Field;
  agent: string;
  bridge: string;
  /** audience = 两个受众面的表达差异（同一事实、同一结论）；defect = 投影缺陷。 */
  kind: "audience" | "defect";
  /** 判断依据（`--list` 与失败报告会打印）。 */
  why: string;
}

interface Evaluation {
  /** 未登记（或登记取值不匹配）的差异——唯一判红来源。 */
  unexpected: Diff[];
  /** 按登记值命中的已知差异。 */
  known: Diff[];
  /** 已登记但本次未出现的差异（修复后未收窄白名单）——判红。 */
  stale: KnownDifference[];
}

interface BridgeModule {
  summarizeRun(
    outDir: string,
    app: string,
    outcome: ProcessOutcome,
    runTool?: string,
  ): Record<string, unknown>;
}

interface ProcessOutcome {
  code: number | null;
  stdout: string;
  stdoutFull: string;
  stderr: string;
  timedOut: boolean;
}

/* ------------------------------------------------------------------ 固定 result JSON */

const HELD_INVARIANT = { id: "done-visible", desc: "结束态不变量成立", held: true };
const FAILED_INVARIANT = { id: "done-visible", desc: "结束态不变量成立", held: false };

/** 一条 flow 步的 step_traces 行（`app-runner` 的 `stepTraces` 形状；index 0 基）。 */
function traceRow(index: number, status: string, desc: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { index, id: `step-${index + 1}`, desc, status, hows: [], descs: [], methods: [], ...extra };
}

/** 一条工具步的 `tool_steps` 投影行（`app-runner` 的 `toolStepProjection` 形状；index 0 基）。 */
function toolRow(index: number, desc: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { index, desc, source: "fixture-cli", attempts: 1, done: false, ok: false, code: null, ...extra };
}

function scriptRecord(steps: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "flow", script_path: "<fixture>/app.mjs", steps,
    script_sha256: SCRIPT_SHA, plan_sha256: PLAN_SHA, ...overrides,
  };
}

/** flow 应用的 result JSON 骨架；各场景只覆盖自己那一段事实。 */
function flowResult(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    app: APP_ID,
    label: "run-view parity",
    goal: "固定 result JSON 的两套 run 视图对账",
    pack_path: "<fixture>/app.mjs",
    plan_path: "<fixture>/plan.json",
    slots: {},
    completed: "2 step(s) via flow(ctx)",
    subgoals: [],
    tool_steps: [],
    invariants: [HELD_INVARIANT],
    sources: [],
    ok: true,
    secs: 1,
    step_traces: [traceRow(0, "done", "打开首页"), traceRow(1, "done", "确认结果")],
    script: scriptRecord(2),
    ...overrides,
  };
}

/** 声明式（plan 源）result JSON 骨架：没有 step_traces，步表在 subgoals 里。 */
function declaredResult(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    app: APP_ID,
    label: "run-view parity",
    goal: "固定 result JSON 的两套 run 视图对账",
    pack_path: "",
    plan_path: "<fixture>/declared-plan.json",
    slots: {},
    completed: "1/1",
    subgoals: [{ desc: "点击筛选", status: "done", attempts: 1, obstacle: null }],
    tool_steps: [],
    invariants: [HELD_INVARIANT],
    sources: [],
    ok: true,
    secs: 1,
    ...overrides,
  };
}

const SCENARIOS: readonly Scenario[] = [
  {
    // 正常完成：flow 应用两条 step_traces 全 done、不变量成立。
    id: "passed-flow",
    shape: "passed",
    result: flowResult({}),
    exitCode: 0,
    agentOptions: {},
    sourceStepCount: 2,
  },
  {
    // FW3 形态：工具步失败但脚本已经处理、result.ok 仍为 true —— 失败步是数据不是判死。
    id: "tolerated-failed-tool",
    shape: "passed",
    result: flowResult({
      completed: "1 step(s) via flow(ctx)",
      tool_steps: [toolRow(0, "同步一次记录", { code: 3, reason: "signal not held" })],
      step_traces: [
        traceRow(0, "done", "打开首页"),
        traceRow(1, "failed", "同步一次记录", { stop_code: "tool_failed" }),
      ],
      script: scriptRecord(1),
    }),
    exitCode: 0,
    agentOptions: {},
    sourceStepCount: 2,
  },
  {
    // 不变量没成立：没有失败步，结论由不变量裁决。
    id: "failed-invariant",
    shape: "failed",
    result: flowResult({
      ok: false,
      invariants: [FAILED_INVARIANT],
      step_traces: [traceRow(0, "done", "打开首页"), traceRow(1, "failed", "确认结果", { stop_code: "false_done" })],
    }),
    exitCode: 1,
    agentOptions: {},
    sourceStepCount: 2,
  },
  {
    // 声明式产物：子目标被阻塞，步表只在 subgoals 里（两条投影都需要走 fallback 分支）。
    id: "blocked-declared",
    shape: "blocked",
    result: declaredResult({
      completed: "0/1",
      subgoals: [{ desc: "点击筛选", status: "blocked", attempts: 1, obstacle: "target_not_found" }],
      invariants: [FAILED_INVARIANT],
      ok: false,
    }),
    exitCode: 1,
    agentOptions: {},
    sourceStepCount: 1,
  },
  {
    // 声明式产物正常完成：verify fallback 的通过面。
    id: "passed-declared",
    shape: "passed",
    result: declaredResult({}),
    exitCode: 0,
    agentOptions: {},
    sourceStepCount: 1,
  },
  {
    // 人工步未完成：manual_steps 标记 + script.stop_code 双事实都指向 needs_human。
    id: "needs-human-flow",
    shape: "manual",
    result: flowResult({
      ok: false,
      completed: "1 step(s) via flow(ctx)",
      manual_steps: [{ index: 0, desc: "人工确认提交", done: false, reason: "needs_human" }],
      step_traces: [
        traceRow(0, "done", "打开首页"),
        traceRow(1, "failed", "人工确认提交", { stop_code: "needs_human" }),
      ],
      script: scriptRecord(1, { stop_code: "needs_human", stop_reason: "非 TTY 不假装有人" }),
    }),
    exitCode: 3,
    agentOptions: {},
    sourceStepCount: 2,
  },
  {
    // 只有 script.stop_code=needs_human（没有 manual_steps 记录）：另一条 needs_human 判定路径。
    id: "needs-human-script",
    shape: "manual",
    result: flowResult({
      ok: false,
      completed: "0 step(s) via flow(ctx)",
      step_traces: [traceRow(0, "failed", "人工确认提交", { stop_code: "needs_human" })],
      script: scriptRecord(0, { stop_code: "needs_human", stop_reason: "非 TTY 不假装有人" }),
    }),
    exitCode: 3,
    agentOptions: {},
    sourceStepCount: 1,
  },
  {
    // 执行预算用满：主动停在半路，不是失败。
    id: "partial-budget",
    shape: "partial",
    result: flowResult({ partial: true }),
    exitCode: 0,
    agentOptions: { partial: true },
    sourceStepCount: 2,
  },
  {
    // 危险工具步被拒（refused）：result.ok=false，工具步没执行。
    id: "refused-tool",
    shape: "refused",
    result: flowResult({
      ok: false,
      completed: "1 step(s) via flow(ctx)",
      tool_steps: [toolRow(0, "下载报表", { refused: "dangerous" })],
      step_traces: [
        traceRow(0, "done", "打开首页"),
        traceRow(1, "failed", "下载报表", { stop_code: "dangerous" }),
      ],
      script: scriptRecord(1),
    }),
    exitCode: 1,
    agentOptions: {},
    sourceStepCount: 2,
  },
  {
    // 工具步跑了但信号不成立（failedTools）：与 refused 分属两类。
    id: "failed-tool",
    shape: "failed",
    result: flowResult({
      ok: false,
      completed: "1 step(s) via flow(ctx)",
      tool_steps: [toolRow(0, "同步一次记录", { code: 7, reason: "signal not held" })],
      step_traces: [
        traceRow(0, "done", "打开首页"),
        traceRow(1, "failed", "同步一次记录", { stop_code: "tool_failed" }),
      ],
      script: scriptRecord(1),
    }),
    exitCode: 1,
    agentOptions: {},
    sourceStepCount: 2,
  },
  {
    // MAX_STEPS 边界之上：步表 21 行，两侧都必须截到同一预算并标注。
    id: "truncated-21",
    shape: "truncation",
    result: flowResult({
      completed: "21 step(s) via flow(ctx)",
      step_traces: Array.from({ length: 21 }, (_, i) => traceRow(i, "done", `步骤 ${i + 1}`)),
      script: scriptRecord(21),
    }),
    exitCode: 0,
    agentOptions: {},
    sourceStepCount: 21,
  },
  {
    // MAX_STEPS 边界之内：20 行不截断（与 21 行一起把两处写的常量钉在 20）。
    id: "boundary-20",
    shape: "truncation",
    result: flowResult({
      completed: "20 step(s) via flow(ctx)",
      step_traces: Array.from({ length: 20 }, (_, i) => traceRow(i, "done", `步骤 ${i + 1}`)),
      script: scriptRecord(20),
    }),
    exitCode: 0,
    agentOptions: {},
    sourceStepCount: 20,
  },
  {
    // dry：只有 app-runner --dry 直接打印的文档，没有 result 产物；桥的 readDryRun 读它。
    id: "dry",
    shape: "dry",
    result: null,
    dryDoc: {
      mode: "flow",
      dry_run: true,
      slots: {},
      problems: [],
      events: [
        { i: 1, call: "open", id: null, desc: null, url: "https://fixture.invalid/", ok: null },
        { i: 2, call: "step", id: "step-1", desc: "打开首页", url: "https://fixture.invalid/", ok: true },
      ],
    },
    exitCode: 0,
    agentOptions: { dry: true },
    sourceStepCount: 2,
  },
];

/* ------------------------------------------------------------------ 白名单 */

/**
 * 当前已存在的差异（逐条给判断）。判红规则：白名单外的差异 = exit 1；登记取值对不上 = exit 1；
 * 登记了但本次没观测到 = exit 1（白名单过期，必须收窄）。
 *
 * 两个缺陷族的共同根因：`agentStepViews` 把 `traceSteps(result)` 与 `toolSteps(result)` 相加，而
 * flow 产物的 `step_traces` 本身**已经包含** `run`/`dangerous` 工具事件行（`app-runner` 的
 * `stepEvents` 过滤条件），于是工具步在 agent 视图里出现两次、且两条记录用的 index 空间不同
 * （一条按 step_traces 位置 +1，一条按工具步序号 +1）。桥侧只从 step_traces 投影一次。修复要改
 * 投影行为，不在对账 lane 的行为面内——这里登记为缺陷并保持判红能力。
 */
const KNOWN_DIFFERENCES: readonly KnownDifference[] = [
  {
    scenario: "refused-tool",
    field: "status",
    agent: "blocked",
    bridge: "failed",
    kind: "audience",
    why: "audience 语义差异，不是执行语义缺陷：两侧都判 ok=false 且都点名原因（agent 走 failure.stop_code/obstacle"
      + " = dangerous，桥走 refused[] 列表 + failure.stop_code）。agent-view 没有 refused[]/failedTools[] 这类"
      + " 分类数组，把「工具步没走成（refused 或 failed）」折叠进 blocked 作为「去查应用」的信号；"
      + " `RunSummary.status` 的 blocked 有 blocked[] 支撑、failed 表示「没有 blocked 子目标的失败」，"
      + " refused 是独立列表。分支口径不一致值得后续统一，但同一事实的结论（未通过）一致。",
  },
  {
    scenario: "refused-tool",
    field: "steps.count",
    agent: "3",
    bridge: "2",
    kind: "defect",
    why: "agent 视图把同一个工具步登记了两行（step_traces 的 run 事件行 + tool_steps 投影行，"
      + "两行 index 都是 1 但 status 一个 refused 一个 failed）；桥侧只有 step_traces 一行。根因见白名单头注释。",
  },
  {
    scenario: "refused-tool",
    field: "failure.step",
    agent: "1",
    bridge: "2",
    kind: "defect",
    why: "同一根因：failure 取的是第一条失败行，两侧的行序/index 空间不同，于是同一步被标成 1 和 2。",
  },
  {
    scenario: "refused-tool",
    field: "failure.obstacle",
    agent: "dangerous",
    bridge: "null",
    kind: "audience",
    why: "同一拒绝事实的两种呈现：agent 的工具投影把 refused 同时写成 stop_code 与 obstacle；"
      + "桥的 failure 块不写 obstacle（规范化后 null），拒绝原因在 refused[]（{\"下载报表: dangerous\"}）。事实没有丢。",
  },
  {
    scenario: "failed-tool",
    field: "status",
    agent: "blocked",
    bridge: "failed",
    kind: "audience",
    why: "与 refused-tool.status 同一条 audience 语义差异：agent 侧 failedTools 触发 blocked，桥侧 failedTools"
      + " 触发 failed；两侧都 ok=false、都列出失败工具步与停因。",
  },
  {
    scenario: "failed-tool",
    field: "steps.count",
    agent: "3",
    bridge: "2",
    kind: "defect",
    why: "同 refused-tool.steps.count 的重复登记根因（工具步在 agent 视图出现两行）。",
  },
  {
    scenario: "failed-tool",
    field: "failure.step",
    agent: "1",
    bridge: "2",
    kind: "defect",
    why: "同 refused-tool.failure.step 的 index 空间根因。",
  },
  {
    scenario: "tolerated-failed-tool",
    field: "steps.count",
    agent: "3",
    bridge: "2",
    kind: "defect",
    why: "同 refused-tool.steps.count 的重复登记根因；FW3（脚本已处理失败工具步、result.ok=true）"
      + "两侧结论都仍是 passed，只有步表登记数不同。",
  },
  {
    scenario: "tolerated-failed-tool",
    field: "failure.step",
    agent: "1",
    bridge: "2",
    kind: "defect",
    why: "同 refused-tool.failure.step 的 index 空间根因；两侧 failure.desc/stop_code 一致。",
  },
  {
    scenario: "dry",
    field: "steps.count",
    agent: "0",
    bridge: "2",
    kind: "audience",
    why: "by design：dry 的调用序列只存在于 app-runner --dry 文档的 events[]，桥从 stdout 读它并投影成 steps；"
      + "agent-view 的 dry 分支只回答 status=dry/ok/verified 三个判定，不承接调用序列（CLI dry 信封另发 events）。",
  },
];

/* ------------------------------------------------------------------ 投影 */

function firstFailure(
  rows: ReadonlyArray<{ index: number; desc: string; status: string; stop_code?: unknown; obstacle?: unknown }>,
): FailureView | null {
  const hit = rows.find((r) => r.status === "blocked" || r.status === "failed" || r.status === "refused");
  if (hit === undefined) return null;
  return {
    step: hit.index,
    desc: hit.desc,
    stop_code: typeof hit.stop_code === "string" && hit.stop_code !== "" ? hit.stop_code : null,
    obstacle: typeof hit.obstacle === "string" && hit.obstacle !== "" ? hit.obstacle : null,
  };
}

function projectAgent(result: Record<string, unknown> | null, scenario: Scenario, outDir: string): AgentProjection {
  // dry 没有 result 产物：给最小形状，只读 agent-view 的 dry 分支（status/ok/verified）。
  const input = (result ?? {
    app: APP_ID, completed: "", ok: true, subgoals: [], tool_steps: [], invariants: [],
  }) as unknown as AppRunResult;
  const view = toAgentRunView(input, {
    outDir,
    resultPath: path.join(outDir, `${APP_ID}-result.json`),
    ...(scenario.agentOptions.partial === true ? { partial: true } : {}),
    ...(scenario.agentOptions.dry === true ? { dry: true } : {}),
  });
  const failure = view.failure === null || view.failure === undefined
    ? null
    : {
      step: view.failure.step,
      desc: view.failure.desc,
      stop_code: view.failure.stop_code ?? null,
      obstacle: view.failure.obstacle ?? null,
    };
  return {
    status: view.status,
    ok: view.ok,
    verified: view.verified,
    // AgentRunView 不单列 dry 旗标：dry 是 status 的一个取值。
    dry: view.status === "dry",
    partial: view.partial,
    completed: view.completed,
    invariants: view.invariants,
    failure,
    stepCount: view.steps.length,
    truncated: view.truncated,
  };
}

function projectBridge(summary: Record<string, unknown>): BridgeProjection {
  const steps = Array.isArray(summary["steps"]) ? summary["steps"] as Array<Record<string, unknown>> : [];
  const rawFailure = summary["failure"] as Record<string, unknown> | undefined;
  const invariants = summary["invariants"] as { held?: unknown; total?: unknown; failed?: unknown } | undefined;
  return {
    status: typeof summary["status"] === "string" ? summary["status"] : "",
    ok: summary["ok"] === true,
    verified: summary["verified"] === true,
    dry: summary["dry"] === true,
    partial: summary["partial"] === true,
    completed: typeof summary["completed"] === "string" ? summary["completed"] : "",
    invariants: {
      held: typeof invariants?.held === "number" ? invariants.held : -1,
      total: typeof invariants?.total === "number" ? invariants.total : -1,
      failed: Array.isArray(invariants?.failed) ? invariants.failed.map(String) : [],
    },
    failure: rawFailure === undefined
      ? null
      : {
        step: typeof rawFailure["step"] === "number" ? rawFailure["step"] : -1,
        desc: typeof rawFailure["desc"] === "string" ? rawFailure["desc"] : "",
        stop_code: typeof rawFailure["stop_code"] === "string" ? rawFailure["stop_code"] : null,
        obstacle: typeof rawFailure["obstacle"] === "string" ? rawFailure["obstacle"] : null,
      },
    stepCount: steps.length,
    truncated: summary["steps_truncated"] === true,
    stepsTotal: typeof summary["steps_total"] === "number" ? summary["steps_total"] : null,
  };
}

/* ------------------------------------------------------------------ 比较 */

/** 显示串：`absent` 与 `null` 分开（缺字段 ≠ 显式空），对象按键序稳定序列化。 */
function show(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value) || typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function comparePair(pair: Pair): Diff[] {
  const diffs: Diff[] = [];
  const push = (field: Field, agent: unknown, bridge: unknown): void => {
    diffs.push({ scenario: pair.scenario.id, field, agent: show(agent), bridge: show(bridge) });
  };
  const { agent, bridge, scenario } = pair;
  if (agent.status !== bridge.status) push("status", agent.status, bridge.status);
  if (agent.ok !== bridge.ok) push("ok", agent.ok, bridge.ok);
  if (agent.verified !== bridge.verified) push("verified", agent.verified, bridge.verified);
  if (agent.dry !== bridge.dry) push("dry", agent.dry, bridge.dry);
  if (agent.partial !== bridge.partial) push("partial", agent.partial, bridge.partial);
  if (agent.completed !== bridge.completed) push("completed", agent.completed, bridge.completed);
  if (show(agent.invariants) !== show(bridge.invariants)) push("invariants", agent.invariants, bridge.invariants);
  const agentFailure = agent.failure;
  const bridgeFailure = bridge.failure;
  if ((agentFailure === null) !== (bridgeFailure === null)) {
    push("failure", agentFailure, bridgeFailure);
  } else if (agentFailure !== null && bridgeFailure !== null) {
    if (agentFailure.step !== bridgeFailure.step) push("failure.step", agentFailure.step, bridgeFailure.step);
    if (agentFailure.desc !== bridgeFailure.desc) push("failure.desc", agentFailure.desc, bridgeFailure.desc);
    if (agentFailure.stop_code !== bridgeFailure.stop_code) {
      push("failure.stop_code", agentFailure.stop_code, bridgeFailure.stop_code);
    }
    if (agentFailure.obstacle !== bridgeFailure.obstacle) {
      push("failure.obstacle", agentFailure.obstacle, bridgeFailure.obstacle);
    }
  }
  if (agent.stepCount !== bridge.stepCount) push("steps.count", agent.stepCount, bridge.stepCount);
  if (agent.truncated !== bridge.truncated) push("steps.truncated", agent.truncated, bridge.truncated);
  // 截断总数与预算：期望值来自固定产物本身（sourceStepCount），不是某一侧投影的结果。
  const expectedTotal = scenario.sourceStepCount > DOCUMENTED_MAX_STEPS ? scenario.sourceStepCount : null;
  if (bridge.stepsTotal !== expectedTotal) push("steps.total", expectedTotal, bridge.stepsTotal);
  const expectedCapped = Math.min(scenario.sourceStepCount, DOCUMENTED_MAX_STEPS);
  if (bridge.stepCount !== expectedCapped) push("steps.bridge_cap", expectedCapped, bridge.stepCount);
  return diffs;
}

/** 纯函数：差异 × 白名单 → 未登记 / 命中 / 过期。负向自测直接复用它。 */
function evaluate(pairs: readonly Pair[], known: readonly KnownDifference[]): Evaluation {
  const diffs = pairs.flatMap(comparePair);
  const matched = new Set<number>();
  const unexpected: Diff[] = [];
  const knownHits: Diff[] = [];
  for (const diff of diffs) {
    const at = known.findIndex((entry, i) => !matched.has(i)
      && entry.scenario === diff.scenario
      && entry.field === diff.field
      && entry.agent === diff.agent
      && entry.bridge === diff.bridge);
    if (at >= 0) {
      matched.add(at);
      knownHits.push(diff);
    } else {
      unexpected.push(diff);
    }
  }
  const stale = known.filter((_, i) => !matched.has(i));
  return { unexpected, known: knownHits, stale };
}

/* ------------------------------------------------------------------ 静态面 */

/** 从 agent-view.ts 源码解析 `AgentRunStatus` 闭集（9 值在类型上，6 值在文档与实际发射面上）。 */
function declaredAgentStatuses(): string[] | null {
  const text = fs.readFileSync(AGENT_VIEW_SOURCE, "utf8");
  const union = /export type AgentRunStatus\s*=([\s\S]*?);/.exec(text);
  if (union === null) return null;
  const values = [...union[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
  return values.length === 0 ? null : values;
}

/**
 * 两处 `const MAX_STEPS` 的静态对账。
 * 为什么静态读：常量未导出，而本 lane 只在只读面（不新增导出）；行为夹具已从边界（20/21）钉住截断点，
 * 这里再把「两处写同值且等于文档契约值」变成显式断言，避免两边一起漂移时行为夹具仍绿。
 */
function checkMaxStepsConstants(): string[] {
  const problems: string[] = [];
  const read = (file: string, re: RegExp, label: string): number | null => {
    const text = fs.readFileSync(file, "utf8");
    const m = re.exec(text);
    if (m === null) {
      problems.push(`${label}：源码里找不到 const MAX_STEPS 声明（${path.relative(REPO, file)}）`);
      return null;
    }
    return Number(m[1]);
  };
  const agentView = read(AGENT_VIEW_SOURCE, /const MAX_STEPS = (\d+);/, "agent-view");
  const bridge = read(BRIDGE_SOURCE, /const MAX_STEPS = (\d+)/, "bridge");
  for (const [label, value] of [["agent-view", agentView], ["bridge", bridge]] as const) {
    if (value !== null && value !== DOCUMENTED_MAX_STEPS) {
      problems.push(`${label} 的 MAX_STEPS=${value} ≠ 文档契约值 ${DOCUMENTED_MAX_STEPS}`);
    }
  }
  if (agentView !== null && bridge !== null && agentView !== bridge) {
    problems.push(`两处 MAX_STEPS 写不一致：agent-view=${agentView} / bridge=${bridge}`);
  }
  return problems;
}

/** 桥的 `status` 类型是 string：这里用运行期发射面检查它始终落在 agent-view 的闭集/文档值内。 */
function checkStatusVocabulary(pairs: readonly Pair[], declared: readonly string[]): string[] {
  const problems: string[] = [];
  const declaredSet = new Set(declared);
  const documented = new Set<string>(DOCUMENTED_STATUSES);
  for (const status of DOCUMENTED_STATUSES) {
    if (!declaredSet.has(status)) {
      problems.push(`AgentRunStatus 闭集缺少文档承诺值 ${status}（声明值：${declared.join(" / ")}）`);
    }
  }
  const emitted = new Set<string>();
  for (const pair of pairs) {
    for (const [view, status] of [["agent-view", pair.agent.status], ["bridge", pair.bridge.status]] as const) {
      emitted.add(status);
      if (!declaredSet.has(status)) {
        problems.push(`${pair.scenario.id}: ${view} 发射了 AgentRunStatus 闭集外的 status=${JSON.stringify(status)}`);
      }
      if (!documented.has(status)) {
        problems.push(`${pair.scenario.id}: ${view} 发射了未在文档承诺面上登记的 status=${JSON.stringify(status)}`);
      }
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ 负向自测 */

interface NegativeCheck {
  name: string;
  /** 期望被发现的类别。 */
  expect: "unexpected" | "stale";
  mutate: (pairs: Pair[]) => void;
}

/**
 * 负向自测：临时注入/抹掉差异，`evaluate` 必须报红。覆盖三类失效模式——
 * 新字段漂移、白名单取值变形、已知差异消失但白名单还挂着。
 */
const NEGATIVE_CHECKS: readonly NegativeCheck[] = [
  {
    name: "正常场景不变量计数漂移",
    expect: "unexpected",
    mutate: (pairs) => {
      const pair = pairs.find((p) => p.scenario.id === "passed-flow");
      if (pair === undefined) throw new Error("passed-flow 场景缺失");
      pair.bridge.invariants.held += 1;
    },
  },
  {
    name: "正常场景 status 漂移",
    expect: "unexpected",
    mutate: (pairs) => {
      const pair = pairs.find((p) => p.scenario.id === "passed-flow");
      if (pair === undefined) throw new Error("passed-flow 场景缺失");
      pair.bridge.status = "failed";
    },
  },
  {
    name: "白名单登记的取值对变形",
    expect: "unexpected",
    mutate: (pairs) => {
      const pair = pairs.find((p) => p.scenario.id === "refused-tool");
      if (pair === undefined) throw new Error("refused-tool 场景缺失");
      pair.bridge.status = "partial";
    },
  },
  {
    name: "已知差异消失后白名单过期",
    expect: "stale",
    mutate: (pairs) => {
      const pair = pairs.find((p) => p.scenario.id === "refused-tool");
      if (pair === undefined) throw new Error("refused-tool 场景缺失");
      pair.bridge.status = pair.agent.status;
    },
  },
  {
    name: "failure.step 漂移",
    expect: "unexpected",
    mutate: (pairs) => {
      const pair = pairs.find((p) => p.scenario.id === "failed-invariant");
      if (pair === undefined || pair.bridge.failure === null) throw new Error("failed-invariant 场景缺失败行");
      pair.bridge.failure.step += 1;
    },
  },
];

function runNegativeChecks(pairs: readonly Pair[]): string[] {
  const problems: string[] = [];
  for (const check of NEGATIVE_CHECKS) {
    const clone = structuredClone(pairs) as Pair[];
    try {
      check.mutate(clone);
    } catch (error) {
      problems.push(`负向自测「${check.name}」无法注入：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const result = evaluate(clone, KNOWN_DIFFERENCES);
    const hit = check.expect === "unexpected" ? result.unexpected.length : result.stale.length;
    if (hit === 0) {
      problems.push(`负向自测「${check.name}」未被发现——${check.expect} 期望 >0，实际 0（判红能力失效）`);
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ 主流程 */

async function loadBridge(): Promise<BridgeModule> {
  // 非字面量 specifier：运行期读桥源码，但不把桥包并进根 tsconfig 的 program。
  const loaded = await import(pathToFileURL(BRIDGE_SOURCE).href);
  const summarize = (loaded as { summarizeRun?: unknown }).summarizeRun;
  if (typeof summarize !== "function") {
    throw new Error(`${path.relative(REPO, BRIDGE_SOURCE)} 没有导出 summarizeRun（桥的公开投影出口）`);
  }
  return loaded as BridgeModule;
}

/** 按真实产物形状落一个 result JSON；桥与 agent-view 各自从同一份输入投影。 */
async function buildPairs(bridge: BridgeModule): Promise<Pair[]> {
  const pairs: Pair[] = [];
  for (const scenario of SCENARIOS) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-run-view-parity-"));
    try {
      if (scenario.result !== null) {
        fs.writeFileSync(path.join(outDir, `${APP_ID}-result.json`), JSON.stringify(scenario.result));
      }
      const stdout = scenario.dryDoc === undefined ? "" : JSON.stringify(scenario.dryDoc);
      const outcome: ProcessOutcome = {
        code: scenario.exitCode,
        stdout,
        stdoutFull: stdout,
        stderr: "",
        timedOut: false,
      };
      const summary = bridge.summarizeRun(outDir, APP_ID, outcome, `${APP_ID}_run`);
      pairs.push({
        scenario,
        agent: projectAgent(scenario.result, scenario, outDir),
        bridge: projectBridge(summary),
      });
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
  return pairs;
}

function reportHuman(
  pairs: readonly Pair[],
  evaluation: Evaluation,
  staticProblems: readonly string[],
  negativeProblems: readonly string[],
  declaredStatuses: readonly string[],
): void {
  const defects = KNOWN_DIFFERENCES.filter((d) => d.kind === "defect").length;
  const audience = KNOWN_DIFFERENCES.length - defects;
  console.log(`verify-run-view-parity: 固定 result JSON × ${pairs.length} 场景（零浏览器/零模型/零网络）`);
  for (const diff of evaluation.known) {
    const entry = KNOWN_DIFFERENCES.find((k) => k.scenario === diff.scenario && k.field === diff.field
      && k.agent === diff.agent && k.bridge === diff.bridge);
    console.log(`  known[${entry?.kind ?? "?"}] ${diff.scenario}.${diff.field}: ${diff.agent} vs ${diff.bridge}`);
  }
  if (evaluation.unexpected.length > 0) {
    console.error(`\n新差异 ${evaluation.unexpected.length} 处（未登记 = 判红；确认语义后逐条登记或修复）：`);
    for (const diff of evaluation.unexpected) {
      console.error(`  NEW ${diff.scenario}.${diff.field}: agent-view=${diff.agent} / bridge=${diff.bridge}`);
    }
  }
  if (evaluation.stale.length > 0) {
    console.error(`\n过期白名单 ${evaluation.stale.length} 条（差异已按登记值匹配不到；修复后请收窄白名单）：`);
    for (const entry of evaluation.stale) {
      console.error(`  STALE ${entry.scenario}.${entry.field}: 登记值 ${entry.agent} vs ${entry.bridge}`);
    }
  }
  for (const problem of staticProblems) console.error(`  STATIC ${problem}`);
  for (const problem of negativeProblems) console.error(`  SELF-TEST ${problem}`);

  const ok = evaluation.unexpected.length === 0 && evaluation.stale.length === 0
    && staticProblems.length === 0 && negativeProblems.length === 0;
  const emitted = new Set<string>(pairs.flatMap((p) => [p.agent.status, p.bridge.status]));
  console.log(
    `\nverify-run-view-parity: ${ok ? "OK" : "FAIL"} — 场景 ${pairs.length}；已知差异 ${evaluation.known.length}`
    + `（audience ${audience} / defect ${defects}，全部按登记值命中）；白名单过期 ${evaluation.stale.length}；`
    + `新差异 ${evaluation.unexpected.length}；静态问题 ${staticProblems.length}；负向自测 ${NEGATIVE_CHECKS.length - negativeProblems.length}`
    + `/${NEGATIVE_CHECKS.length}；MAX_STEPS=${DOCUMENTED_MAX_STEPS}（两处写同值）；`
    + `status 闭集声明 ${declaredStatuses.length} 值 / 实际发射 ${emitted.size} 值。`,
  );
}

function reportList(pairs: readonly Pair[], declaredStatuses: readonly string[]): void {
  console.log(`场景（${SCENARIOS.length}）：`);
  for (const scenario of SCENARIOS) {
    console.log(`  ${scenario.id} [${scenario.shape}] exit=${scenario.exitCode}`
      + `${scenario.result === null ? " dry（无 result 产物）" : ` sourceSteps=${scenario.sourceStepCount}`}`);
  }
  console.log(`\nAgentRunStatus 闭集：${declaredStatuses.join(" / ")}`);
  console.log(`文档承诺 / 实际发射：${DOCUMENTED_STATUSES.join(" / ")}`);
  console.log(`\n已知差异（${KNOWN_DIFFERENCES.length}）：`);
  for (const entry of KNOWN_DIFFERENCES) {
    console.log(`  [${entry.kind}] ${entry.scenario}.${entry.field}: agent-view=${entry.agent} / bridge=${entry.bridge}`);
    console.log(`    ${entry.why}`);
  }
  console.log(`\n负向自测（${NEGATIVE_CHECKS.length}）：${NEGATIVE_CHECKS.map((c) => c.name).join(" / ")}`);
  console.log(`场景数 ${pairs.length}；静态契约 MAX_STEPS=${DOCUMENTED_MAX_STEPS}。`);
}

async function main(argv: readonly string[]): Promise<number> {
  const unknown = argv.filter((arg) => arg !== "--list" && arg !== "--json");
  if (unknown.length > 0) {
    console.error(`verify-run-view-parity: 未知参数 ${unknown.join(", ")}`);
    console.error("usage: node --experimental-strip-types tools/verify-run-view-parity.ts [--list | --json]");
    return 2;
  }
  const bridge = await loadBridge();
  const declaredStatuses = declaredAgentStatuses();
  if (declaredStatuses === null) {
    console.error(`verify-run-view-parity: 无法从 ${path.relative(REPO, AGENT_VIEW_SOURCE)} 解析 AgentRunStatus 闭集`);
    return 1;
  }
  const pairs = await buildPairs(bridge);
  const evaluation = evaluate(pairs, KNOWN_DIFFERENCES);
  const staticProblems = [...checkMaxStepsConstants(), ...checkStatusVocabulary(pairs, declaredStatuses)];
  const negativeProblems = runNegativeChecks(pairs);
  const ok = evaluation.unexpected.length === 0 && evaluation.stale.length === 0
    && staticProblems.length === 0 && negativeProblems.length === 0;

  if (argv.includes("--list")) {
    reportList(pairs, declaredStatuses);
    return ok ? 0 : 1;
  }
  if (argv.includes("--json")) {
    console.log(JSON.stringify({
      ok,
      scenarios: pairs.length,
      knownDifferences: KNOWN_DIFFERENCES,
      matchedKnown: evaluation.known,
      unexpected: evaluation.unexpected,
      stale: evaluation.stale,
      staticProblems,
      negativeProblems,
      statusVocabulary: { declared: declaredStatuses, documented: DOCUMENTED_STATUSES },
      maxSteps: DOCUMENTED_MAX_STEPS,
    }, null, 2));
    return ok ? 0 : 1;
  }
  reportHuman(pairs, evaluation, staticProblems, negativeProblems, declaredStatuses);
  return ok ? 0 : 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error("verify-run-view-parity: 投影或桥加载失败（本 lane 离线，不需要浏览器/模型/网络）");
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 2;
}
