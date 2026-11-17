/**
 * AmberFlow bridge — the harness side of "the engine is called, not embedded".
 *
 * AmberFlow runs **flow apps**: one JS script per app (`apps/<id>/app.mjs` exporting `meta` and
 * `flow(ctx)`), where the script owns the control flow and the engine owns each step's target, gate,
 * action and completion signal. DOM signals are the only completion truth. This plugin turns the
 * checkout's CLIs into model-facing tools so a DSH session can drive them — and it deliberately adds
 * **no app logic of its own**:
 *
 * - `…_apps`      — list flow apps through `amber apps list --json` (no browser, no model).
 * - `…_app_show`  — metadata + the current `app.mjs` source + version anchors.
 * - `…_app_check` — load the script and dry-run its call sequence (no browser).
 * - `…_app_create`— generate a flow skeleton; the Agent edits the file itself.
 * - `…_run`       — run one flow app and return a compact summary of its artifacts.
 * - `…_inspect` / `…_status` / `…_online` — read-only page observation, environment facts, real-site
 *                   regression suite.
 * - `…_learn`     — one recording: induce signals and write a flow app only when a rules-only replay
 *                   of the generated script passes.
 *
 * Trust boundary, stated out loud: the bridge spawns a foreign process from `repoPath`. It does not
 * route through the harness sandbox policy, so enabling this plugin means trusting that checkout.
 * @module @deepseek-ai/dsh-amberflow-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Volatile } from '@deepseek-ai/cordis'
// Type-only Context merges: `loader/volatile-update` (loader) and `ctx.settings` (settings).
// Erased at runtime — the running host provides both services.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import { fillArgMessage, listApps, normalizeDecisionEndpoint, type BridgeOptions, type JsonValue } from './bridge.ts'
import {
  appCheck, appShow, createApp, inspect, learn, runApp, status, test,
  createService, type AmberFlowRunArgs, type AmberFlowService,
} from './service.ts'
import { RUN_BRIDGE_MESSAGES, RUN_TOOL_FIELDS, RUN_TOOL_PARAMETERS } from './run-contract.generated.ts'
// 语法/规划引导/概述层生成物（勿手改）：唯一出处是引擎的 grammar-prompt.ts、
// planning-playbook.ts 与 help-map.ts，这里只收字符串（桥不 import 引擎代码）；
// 漂移由 `npm run prompt-hit` 校验。
import { HINT_LEARN_NOTE, OVERVIEW_TEXT, PLAN_PLAYBOOK_SHORT, STOP_ESCALATION_TEXT } from './grammar.generated.ts'
import {
  DEFAULT_MAX_SESSIONS, DEFAULT_SESSION_IDLE_MS, handleSessionTool, SessionManager, type SessionToolArgs,
} from './session.ts'

/**
 * C1：会话结果的模型可见渲染只给有界行数（完整形状在结构化 value 里，模型看不到）。
 * observe / extract 各显示 20 行；只有**溢出**时才追加两行（无溢出零新增文本）。
 * observe **没有 offset**（元素序随水合/动画变化，无稳定锚）：收窄用 selector/max，
 * 全量用 snapshot（pool-<n>.json）。
 */
const OBSERVE_DISPLAY = 20
const EXTRACT_DISPLAY = 20

// The package root is the consumer surface: another plugin imports these without reaching into `src/`
// (a published package ships only `lib/`).
export {
  appCheck, appShow, createApp, inspect, learn, newOutDir, runApp, status, test,
  type AmberFlowAppCheck, type AmberFlowAppDetail, type AmberFlowCreateArgs, type AmberFlowInspect,
  type AmberFlowInspectArgs, type AmberFlowLearnArgs, type AmberFlowTest, type AmberFlowTestArgs,
  type AmberFlowRunArgs, type AmberFlowService, type AmberFlowStatus,
} from './service.ts'
export {
  buildEnv, diagnoseFailure, firstLines, learnArgs, listApps, parseJsonDocument, parseSource,
  pruneRunDirs, runArgs, runProcess, stripAnsi, summarizeLearn, summarizeRun,
  type AppSummary, type BridgeOptions, type LearnSummary, type ProcessOutcome, type RunStep,
  type RunSummary,
} from './bridge.ts'

export const name = 'amberflow-bridge'
export const inject = ['tools']

/** Read one field of an opaque JSON object (CLI data, tool output) for rendering. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as { [key: string]: unknown })[key]
    : undefined
}

/** Deployment configuration for the bridge. */
export interface Config {
  /**
   * Absolute path of the AmberFlow checkout (the one holding `src/app/app-runner.ts`). Optional:
   * precedence is config > `AMBERFLOW_REPO` > the checkout this plugin module lives in
   * (a git-installed bundle contains the whole engine, so it self-locates).
   */
  repoPath?: string
  /** Node binary used for the external CLI; defaults to the running interpreter. */
  nodeBin?: string
  /** Hard wall-clock cap per call, ms (default 15 min: live runs are slow by nature). */
  timeoutMs?: number
  /** Whether this deployment permits dangerous tool steps (`--allow-dangerous`, dry-run gated). */
  allowDangerous?: boolean
  /** Model-visible tool-name prefix (default `amberflow`). */
  toolPrefix?: string
  /**
   * Environment policy for the engine child process: `inherit` (default) forwards everything, which
   * assumes the checkout is trusted with the session's environment; `allowlist` forwards only the
   * keys an engine run needs (PATH/HOME/certs/proxies/playwright) plus AMBERFLOW_* and `forwardEnv`.
   */
  envMode?: 'inherit' | 'allowlist'
  /** Extra environment variable NAMES forwarded when `envMode` is `allowlist` (exact keys). */
  forwardEnv?: string[]
  /**
   * How many newest per-call artifact directories (`$TMPDIR/dsh-amberflow-*`) to keep. Directories
   * stay removable only after an hour of age, so a live run is never pruned; 0 disables housekeeping.
   */
  keepRuns?: number
  /**
   * Override for the USER-scope apps root (`$AMBERFLOW_HOME`): the listing call runs with this
   * `AMBERFLOW_HOME`, so `amber apps list` resolves the same scope the CLI's runs write into.
   */
  appsHome?: string
  /**
   * Unified **decision service** endpoint (System One protocol).
   *
   * These three fields plus {@link Config.stepGapMs} and {@link Config.headful} are the ONLY
   * `.volatile()` fields in this Config, so the plugin's configuration page (`plugins.row.config`)
   * shows exactly them. They are
   * forwarded to the engine child process as `AMBERFLOW_DECISION_BASE_URL` / `_API_KEY` / `_MODEL`,
   * and when the URL + token are both set the bridge defaults runs to the `decision-service`
   * provider. Empty means "not configured": runs keep the local ONNX decision model (or rules-only).
   */
  modelBaseUrl?: Volatile<string>
  /** Bearer token for {@link modelBaseUrl}. Secret: the settings surface never reads it back. */
  modelApiKey?: Volatile<string | undefined>
  /** Decision model id (`AMBERFLOW_DECISION_MODEL`; empty = the provider's default). */
  modelName?: Volatile<string>
  /**
   * 步间距 (step gap, ms): minimum wait between two engine steps (`ctx.step` / `arrive` / `manual` /
   * `run`), forwarded to the engine child process as `AMBERFLOW_STEP_DELAY_MS`. The engine resolves
   * pace by precedence "explicit > `meta.pace` > env > 0", so an app that declares its own
   * `meta.pace` keeps winning over this machine-level default. `0` (default) adds nothing.
   */
  stepGapMs?: Volatile<number>
  /**
   * headful 开关（配置页）：浏览器窗口只有一个开关维度，所以只有一个 HEADFUL 布尔——勾选后
   * 引擎子进程一律注入 `AMBERFLOW_HEADFUL=1`（显示浏览器窗口），压过引擎配置层的
   * `runDefaults.headful=false`（env 层 > 配置文件层）；不勾选（默认）= 不注入任何东西，引擎按
   * 它自己的层叠走（CLI 旗标 > env > 配置文件，逐字节现状；想常驻无窗口在引擎 rc 里配
   * `AMBERFLOW_HEADFUL=0` 即可，工具调用显式给的 headful 参数是 CLI 旗标层，永远最优先）。
   */
  headful?: Volatile<boolean>
  /**
   * Idle TTL for `amberflow_session` sessions, ms (default 300_000). The BRIDGE owns this
   * semantic: the engine child is started with `--idle-timeout-ms 600000` as an orphan backstop
   * only (double-layer idle, Q3). `0`/absent = use the default; never creates a child by itself.
   */
  sessionIdleMs?: number
  /** Max concurrent `amberflow_session` sessions in this process (default 2). Q1: no identity binding. */
  maxSessions?: number
}

/** Schemastery schema for {@link Config}. */
export const Config = z.object({
  repoPath: z.string(),
  // No schema default on purpose: resolveOptions must tell "unset" from "set" to decide whether
  // the node_modules checkout needs the tsx launcher; `?? process.execPath` applies the fallback.
  nodeBin: z.string(),
  timeoutMs: z.natural().min(1000).default(900_000),
  allowDangerous: z.boolean().default(false),
  toolPrefix: z.string().default('amberflow'),
  envMode: z.union([z.const('inherit'), z.const('allowlist')]).default('inherit'),
  forwardEnv: z.array(z.string()).default([]),
  keepRuns: z.natural().default(30),
  appsHome: z.string(),
  // The plugin's configuration page shows exactly these three fields (settings projects only
  // volatile fields). They configure the unified decision service (System One): URL is normalized
  // to the /systemone endpoint, token/key/model become AMBERFLOW_DECISION_* for the engine CLI,
  // and a fully configured pair makes app runs default to the `decision-service` provider.
  modelBaseUrl: z.string().default('').volatile(),
  // No schema default: the settings secret-presence marker is `value !== undefined`, so a default
  // would make an unset token read as "configured" in the configuration page.
  modelApiKey: z.string().role('secret').volatile(),
  modelName: z.string().default('').volatile(),
  // 步间距 (step gap): the pace field on the configuration page. Forwarded to the engine as
  // AMBERFLOW_STEP_DELAY_MS — the engine's `env` pace layer, which an app's own meta.pace still
  // overrides. 0..60000 ms like meta.pace; 0 (default) forwards nothing.
  stepGapMs: z.natural().max(60_000).default(0).volatile(),
  // headful 开关（取代本版本线里未发布的 headless 布尔与 windowMode 三态实验项）：勾选 → 子进程
  // 注入 AMBERFLOW_HEADFUL=1（显示窗口）；不勾选 → 不注入（引擎配置层叠决定）。工具显式 headful
  // 参数是 CLI 旗标层，仍最优先。
  headful: z.boolean().default(false).volatile(),
  // `amberflow_session` limits. Plain (non-volatile) fields on purpose: changing them means the
  // deployment restarts the session manager, while the tools themselves stay stateless per call.
  // Defaults never spawn anything: a session exists only after an explicit `open` op.
  sessionIdleMs: z.natural().min(1_000).max(3_600_000).default(DEFAULT_SESSION_IDLE_MS),
  maxSessions: z.natural().min(1).max(8).default(DEFAULT_MAX_SESSIONS),
})

/**
 * Walk up from a directory looking for a AmberFlow checkout (one holding `src/app/app-runner.ts`).
 * Used when no repoPath was configured: a git-installed bundle contains the whole engine, so the
 * plugin can locate its own checkout — a link/path install resolves to the same tree it always used.
 * @param fromDir - the directory to start from (typically this module's).
 * @returns the checkout root, or undefined when no ancestor is one.
 */
export function findCheckout(fromDir: string): string | undefined {
  let dir = path.resolve(fromDir)
  for (;;) {
    if (fs.existsSync(path.join(dir, 'src', 'app', 'app-runner.ts'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Whether a path sits inside a `node_modules` tree, where Node refuses its own type stripping. */
function underNodeModules(dir: string): boolean {
  return dir.split(/[\\/]/).includes('node_modules')
}

/**
 * Walk up each root chain looking for an installed tsx entry (`node_modules/tsx/dist/cli.mjs`).
 * The DSH host runs on tsx, so its install tree usually provides it; a profile that installed the
 * engine with hoisted deps may provide it too.
 * @param fromDirs - ancestor chains to search, in order.
 * @returns the absolute cli.mjs path, or undefined.
 */
function findTsxCli(fromDirs: string[]): string | undefined {
  for (const start of fromDirs) {
    let dir = path.resolve(start)
    for (;;) {
      const cli = path.join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs')
      if (fs.existsSync(cli)) return cli
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}

/**
 * Read the current value behind a loader Volatile reference. Volatile Config fields are wrapped by
 * the loader (so an update can commit a new value without remounting the plugin); plain values pass
 * through unchanged (tests and older loader shapes).
 * @param value - a volatile reference or a plain config value.
 * @returns the current plain value, or undefined.
 */
function volatileValue<T>(value: T | { get(): T } | undefined): T | undefined {
  if (value !== undefined && typeof value === 'object' && value !== null
    && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get(): T }).get()
  }
  return value as T | undefined
}

/** Resolve defaults and verify the checkout really is one, at LOAD time rather than first call. */
function resolveOptions(config: Config): BridgeOptions {
  // Precedence: explicit config (a patch line) > AMBERFLOW_REPO > the pre-rename LAYAWEBUSE_REPO
  // (still honored so deployments written before the rename keep working) > own checkout.
  const envRepo = process.env.AMBERFLOW_REPO ?? process.env.LAYAWEBUSE_REPO
  const repoPath = config.repoPath !== undefined && config.repoPath !== ''
    ? path.resolve(config.repoPath)
    : envRepo !== undefined && envRepo !== ''
      ? path.resolve(envRepo)
      : findCheckout(path.dirname(fileURLToPath(import.meta.url)))
  if (repoPath === undefined) {
    throw new Error('amberflow-bridge: no AmberFlow checkout found — set Config.repoPath or AMBERFLOW_REPO')
  }
  if (!fs.existsSync(path.join(repoPath, 'src', 'app', 'app-runner.ts'))) {
    throw new Error(`amberflow-bridge: ${repoPath} is not an AmberFlow checkout (missing src/app/app-runner.ts)`)
  }
  const prefix = config.toolPrefix ?? 'amberflow'
  if (!/^[a-z][a-z0-9_]*$/.test(prefix)) {
    throw new Error(`amberflow-bridge: toolPrefix ${JSON.stringify(prefix)} must be lower_snake_case`)
  }
  // Node's own type stripping refuses .ts files under a node_modules tree (Node 22-24, no flag
  // overrides it). A git-installed bundle lives exactly there, so spawn through tsx instead —
  // unless the deployment already named its own launcher via nodeBin (a tsx binary also works).
  let tsxCli: string | undefined
  if (underNodeModules(repoPath) && config.nodeBin === undefined) {
    tsxCli = findTsxCli([
      repoPath,
      process.argv[1] === undefined ? path.dirname(process.execPath) : path.dirname(path.resolve(process.argv[1])),
    ])
    if (tsxCli === undefined) {
      throw new Error(
        `amberflow-bridge: the checkout ${repoPath} sits under node_modules, where Node cannot run `
        + 'its TypeScript CLIs (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). No tsx was found from '
        + 'the checkout or the host install tree: install tsx into this profile, point '
        + 'Config.nodeBin at a tsx binary, or set AMBERFLOW_REPO to a checkout outside node_modules.',
      )
    }
  }
  // 步间距 from the configuration page: read through the volatile wrapper like the model fields.
  // Defensively clamped to 0..60000 (the schema already enforces it; NaN/debris reads as 0).
  const rawStepGapMs = Number(volatileValue(config.stepGapMs) ?? 0)
  return {
    repoPath,
    nodeBin: config.nodeBin ?? process.execPath,
    ...(tsxCli === undefined ? {} : { tsxCli }),
    timeoutMs: config.timeoutMs ?? 900_000,
    allowDangerous: config.allowDangerous ?? false,
    toolPrefix: prefix,
    envMode: config.envMode ?? 'inherit',
    forwardEnv: config.forwardEnv ?? [],
    keepRuns: config.keepRuns ?? 30,
    decisionModel: {
      endpoint: normalizeDecisionEndpoint(volatileValue(config.modelBaseUrl) ?? ''),
      apiKey: (volatileValue(config.modelApiKey) ?? '').trim(),
      model: (volatileValue(config.modelName) ?? '').trim(),
    },
    stepGapMs: Number.isFinite(rawStepGapMs)
      ? Math.min(60_000, Math.max(0, Math.floor(rawStepGapMs)))
      : 0,
    // headful 开关：volatile 布尔，只有显式 true 才生效（默认 false = 不注入，逐字节现状）。
    headful: volatileValue(config.headful) === true,
    // Auto-select the online decision provider only when the endpoint AND token are both present:
    // a half-configured page must not break runs that otherwise work on the local model.
    ...(normalizeDecisionEndpoint(volatileValue(config.modelBaseUrl) ?? '').trim() !== ''
      && (volatileValue(config.modelApiKey) ?? '').trim() !== ''
      ? { decisionProvider: 'decision-service' as const }
      : {}),
    ...(config.appsHome === undefined ? {} : { appsEnv: { AMBERFLOW_HOME: config.appsHome } }),
  }
}

/**
 * Register the bridge tools on the calling context.
 * @param ctx - the Cordis context (must expose `ctx.tools`).
 * @param config - deployment configuration; a checkout that does not exist fails here, loudly.
 */
export function apply(ctx: Context, config: Config): void {
  const options = resolveOptions(config)
  const { toolPrefix } = options
  // Layer-1 overview (single source: engine help-map.ts, distributed verbatim via the
  // generated module — the bridge-side Agent has no AGENTS.md to read). Logging it once
  // here makes the plugin's index description and every tool registration share one text.
  ctx.logger.info(`amberflow-bridge: ${OVERVIEW_TEXT}`)
  // The plugin ships its own configuration page (the three model fields plus the step gap), so the
  // generic settings page must not also generate one for this entry. Optional service: a deployment
  // without Settings keeps working (page simply absent).
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), 'amberflow-bridge: own config page')
  })
  // Loader commits `.volatile()` field updates into the running references without remounting the
  // plugin, then emits this event. Re-resolve into the SAME options object so the tools and the
  // service (both closed over it) see the new endpoint immediately.
  ctx.on('loader/volatile-update', () => {
    try {
      Object.assign(options, resolveOptions(config))
    } catch (error) {
      ctx.logger.warn('amberflow-bridge: could not apply the updated model configuration; keeping the previous values')
      ctx.logger.warn(error)
    }
  })

  // Plugin-to-plugin door: another plugin injects `amberflow` and calls the engine directly, running
  // exactly the code the tools run (same options, same gates, same diagnostics).
  const service: AmberFlowService = createService(options)
  ctx.provide('amberflow', service)

  ctx.tools.register(defineTool({
    name: `${toolPrefix}_apps`,
    description:
      'List runnable flow apps and their metadata; use it to pick an app id for `*_run`, `*_app_show` '
        + 'or `*_app_check`. Here `*_<name>` means this bridge\'s tool of that name under any prefix. Each '
        + 'row gives id, label, goal, script path, source, invariant count and allowed hosts; a row with '
        + '`error` failed to load. `filter` matches id, label or goal case-insensitively. Starts no browser '
        + 'and calls no model.',
    parameters: {
      filter: { type: 'string', description: 'Case-insensitive substring match on app id, label or goal.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          apps: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                goal: { type: 'string', required: true },
                path: { type: 'string', required: true },
                source: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                invariants: { type: 'integer', required: true },
                hosts: { type: 'array', required: true, items: { type: 'string' } },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.apps.length === 0
          ? 'No apps matched.'
          : value.apps.map(a => `${a.id}${a.label === '' || a.label === a.id ? '' : ` — ${a.label}`}`
            + ` (${String(a.invariants)} invariants, ${a.source}`
            + `${a.hosts.length ? `, hosts: ${a.hosts.join(',')}` : ''})`
            + `\n  app.mjs: ${a.path}`
            + (a.error === undefined ? '' : `\n  load error: ${a.error}`)).join('\n'),
      }],
    },
    async execute(args) {
      const apps = await listApps(options, args.filter ?? '')
      return {
        apps: apps.map(a => ({
          id: a.id,
          label: a.label,
          goal: a.goal,
          path: a.path,
          source: a.source,
          kind: a.kind,
          invariants: a.invariants,
          hosts: a.hosts,
          ...(a.error === undefined ? {} : { error: a.error }),
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: `${toolPrefix}_run`,
    description:
      'Run one flow app end to end; declared end-state invariants decide pass/fail. Returns `status`, '
      + '`verified`, failed steps and report paths. `max_steps` is a budget, not a step index; used up = '
      + '`budget_exceeded` (status=partial, verified=false). `dry` dry-runs without a browser; '
      + '`ablate`/`provider` are experiment-only overrides. A killed call writes `run-killed.json`; raise '
      + '`timeout_sec` for long flows. Navigate via page controls; direct URL jumps can trip site risk '
      + 'controls. Escalation rule: '
      + STOP_ESCALATION_TEXT,
    // The parameter schema is the bridge projection of the shared run-args contract (generated by
    // `npm run run-args:gen`), so a new bridge field is added there rather than here. One fact from
    // that schema worth repeating where the tool is declared: `max_steps` is an EXECUTION BUDGET,
    // not a 1-based step index.
    parameters: RUN_TOOL_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          exitCode: { type: 'integer' },
          dry: { type: 'boolean', required: true },
          completed: { type: 'string', required: true },
          blocked: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                desc: { type: 'string', required: true },
                obstacle: { type: 'string', required: true },
              },
            },
          },
          blockedTotal: { type: 'integer', required: true },
          refused: { type: 'array', required: true, items: { type: 'string' } },
          failedTools: { type: 'array', required: true, items: { type: 'string' } },
          invariants: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              held: { type: 'integer', required: true },
              total: { type: 'integer', required: true },
              failed: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          reportPath: { type: 'string', required: true },
          timedOut: { type: 'boolean', required: true },
          stdoutTail: { type: 'string', required: true },
          // Which tier executed (`on` / `off(missing)` / `off(rules-only)` / `off(scripted)`) and the
          // decision-source tally. Absent only on older artifacts.
          model: { type: 'string' },
          decisions: { type: 'string' },
          status: { type: 'string' },
          verified: { type: 'boolean' },
          partial: { type: 'boolean' },
          resultPath: { type: 'string' },
          outDir: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                desc: { type: 'string', required: true },
                status: { type: 'string', required: true },
                id: { type: 'string' },
                call: { type: 'string' },
                url: { type: 'string' },
                method: { type: 'string' },
                stop_code: { type: 'string' },
                obstacle: { type: 'string' },
              },
            },
          },
          // 06-C：dry/real 摘要的展示截断标注（配合 bridge.ts 的 steps_total 透传）。
          steps_total: { type: 'integer' },
          steps_truncated: { type: 'boolean' },
          failure: {
            type: 'object',
            additionalProperties: false,
            properties: {
              step: { type: 'integer', required: true },
              desc: { type: 'string', required: true },
              stop_code: { type: 'string' },
              obstacle: { type: 'string' },
            },
          },
          // S1：引擎 result 的 warnings[]（前进性 flags 等）；缺省不出现（旧产物同形状）。
          warnings: { type: 'array', items: { type: 'string' } },
          // §8 步 5：真实求援的结构化请求（stop 模式）；只在引擎写了 result.rescue 时出现。
          rescue: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true },
              mode: { type: 'string', required: true },
              why_stuck: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  summary: { type: 'string', required: true },
                  stop_code: { type: 'string' },
                  step_id: { type: 'string' },
                },
              },
              what_would_unblock: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.dry) {
          return [{
            type: 'text',
            text: `DRY ${String(value.steps?.length ?? 0)} call(s)`
              + (value.steps_truncated === true
                ? ` (display truncated: showing ${String(value.steps?.length ?? 0)} of ${String(value.steps_total ?? '?')}; the full sequence was validated)`
                : '')
              + ` — nothing executed, nothing verified`
              + (value.model ? ` (model tier: ${value.model})` : '')
              + (value.steps && value.steps.length
                ? `:\n${value.steps.map(s => `${String(s.index)}. [${s.call ?? 'step'}] ${s.desc}`
                  + `${s.url ? ` → ${s.url}` : ''}`).join('\n')}`
                : ''),
          }]
        }
        const named = value.blockedTotal + value.failedTools.length + value.refused.length
        // A run can also stop without a failed step to name — killed at the timeout, or a non-zero
        // exit the artifact does not reflect — so say that rather than printing a bare FAIL.
        // C8 (round 04, 已改待重启验证): a PARTIAL budget stop is an intended stop and already
        // carries its own "(partial run: execution budget used up)" note — the bare
        // "; stopped: exit 0" suffix read like an abnormal halt, so suppress it for partial runs.
        const stopped = !value.ok && named === 0 && value.partial !== true
          ? value.timedOut
            ? '; stopped: timed out'
            : value.exitCode === undefined ? '' : `; stopped: exit ${String(value.exitCode)}`
          : ''
        const status = value.status ?? (value.ok ? 'passed' : 'failed')
        return [{
          type: 'text',
          text: `${status.toUpperCase()} ${value.completed}`
            + `; verified ${value.verified === true ? 'yes' : 'no'}`
            + (value.partial ? ' (partial run: execution budget used up)' : '')
            + `; invariants ${String(value.invariants.held)}/${String(value.invariants.total)}`
            + (value.blockedTotal ? `; blocked ${String(value.blockedTotal)}: `
              + value.blocked.map(b => `${b.desc} (${b.obstacle})`).join(' | ') : '')
            + (value.failedTools.length ? `; tool steps failed: ${value.failedTools.join(' | ')}` : '')
            + (value.refused.length ? `; not executed: ${value.refused.join(', ')}` : '')
            // S0：first-failure 只在**非 passed** 时输出——passed 同屏出现 “first failure” 会把
            // 一次成功的运行读成失败（脚本已处理/恢复的 transient 失败不是最终结论）。
            + (status !== 'passed' && value.failure
              ? `; first failure: step ${String(value.failure.step)} ${value.failure.desc}`
                + `${value.failure.stop_code ? ` (${value.failure.stop_code})` : ''}`
              : '')
            + (value.warnings?.length
              ? `\nwarnings: ${value.warnings.map(w => `- ${w}`).join(' | ')}`
              : '')
            // §8 步 5：真实求援透传——Agent 第一眼看到「为什么需要人」与解锁路径。
            + (value.rescue
              ? `\nrescue: ${value.rescue.kind} (${value.rescue.mode}) — ${value.rescue.why_stuck.summary}`
                + `${value.rescue.why_stuck.stop_code ? ` [${value.rescue.why_stuck.stop_code}]` : ''}`
                + (value.rescue.what_would_unblock?.length
                  ? `\nunblock: ${value.rescue.what_would_unblock.map(u => `- ${u}`).join(' | ')}`
                  : '')
              : '')
            + stopped
            + (value.model ? `; model: ${value.model}` : '')
            + (value.decisions ? `\ndecisions: ${value.decisions}` : '')
            + (value.resultPath ? `\nresult: ${value.resultPath}` : '')
            + (value.reportPath ? `\nreport: ${value.reportPath}` : '\nno report was written'),
        }]
      },
    },
    async execute(args) {
      // A Map, not an object: `slots['__proto__'] = v` writes through the prototype setter, which
      // silently drops the value and hides the key from both the duplicate check and `Object.entries`.
      const slots = new Map<string, string>()
      for (const entry of args.slots ?? []) {
        const at = entry.indexOf('=')
        if (at <= 0) {
          throw new Error(fillArgMessage(RUN_BRIDGE_MESSAGES.slotFormat, { value: JSON.stringify(entry) }))
        }
        const key = entry.slice(0, at)
        // The CLI treats a repeated slot as a usage error; catching it here keeps the bridge from
        // silently dropping the first value before the CLI ever sees the duplicate.
        if (slots.has(key)) {
          throw new Error(fillArgMessage(RUN_BRIDGE_MESSAGES.slotDuplicate, { value: JSON.stringify(key) }))
        }
        slots.set(key, entry.slice(at + 1))
      }
      // Tool parameter → camelCase comes from the shared contract; only the slot bag needs its own
      // collection step (array of `k=v` → record) because the engine CLI takes repeated flags.
      const runValues: Record<string, unknown> = {}
      for (const field of RUN_TOOL_FIELDS) {
        const value = (args as unknown as Readonly<Record<string, unknown>>)[field.param]
        if (value === undefined) continue
        // `Object.fromEntries` defines own properties, so even a `__proto__` slot reaches the CLI.
        runValues[field.key] = field.collect === 'slots' ? Object.fromEntries(slots) : value
      }
      // The deployment gate lives in the shared call, so the service refuses it identically.
      const { summary } = await runApp(options, runValues as unknown as AmberFlowRunArgs)
      return {
        ok: summary.ok,
        ...(summary.exitCode === null ? {} : { exitCode: summary.exitCode }),
        dry: summary.dry,
        completed: summary.completed,
        blocked: summary.blocked,
        blockedTotal: summary.blockedTotal,
        refused: summary.refused,
        failedTools: summary.failedTools,
        invariants: summary.invariants,
        reportPath: summary.reportPath,
        timedOut: summary.timedOut,
        stdoutTail: summary.stdoutTail,
        ...(summary.model === undefined ? {} : { model: summary.model }),
        ...(summary.decisions === undefined ? {} : { decisions: summary.decisions }),
        ...(summary.status === undefined ? {} : { status: summary.status }),
        ...(summary.verified === undefined ? {} : { verified: summary.verified }),
        ...(summary.partial === undefined ? {} : { partial: summary.partial }),
        ...(summary.resultPath === undefined ? {} : { resultPath: summary.resultPath }),
        outDir: summary.outDir,
        ...(summary.steps === undefined ? {} : { steps: summary.steps }),
        ...(summary.failure === undefined ? {} : { failure: summary.failure }),
        ...(summary.warnings === undefined ? {} : { warnings: summary.warnings }),
        ...(summary.rescue === undefined ? {} : { rescue: summary.rescue }),
      }
    },
  }))

  const appDetailSchema = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      app: { type: 'string', required: true },
      label: { type: 'string', required: true },
      goal: { type: 'string', required: true },
      /** The ONE writable location: `apps/<id>/app.mjs`. */
      path: { type: 'string', required: true },
      source: { type: 'string', required: true },
      script_sha256: { type: 'string', required: true },
      plan_sha256: { type: 'string', required: true },
      hosts: { type: 'array', required: true, items: { type: 'string' } },
      slots: { type: 'object', required: true, additionalProperties: true },
      required_slots: { type: 'array', required: true, items: { type: 'string' } },
      sources: { type: 'array', required: true, items: { type: 'string' } },
      invariants: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
      policy: { type: 'object', additionalProperties: true },
      pace: { type: 'object', additionalProperties: true },
      /** Current script source (`--code`). */
      code: { type: 'string' },
      code_truncated: { type: 'boolean' },
    },
  } as const

  ctx.tools.register(defineTool({
    name: `${toolPrefix}_status`,
    description:
      OVERVIEW_TEXT + '\n\n'
        + 'Report the engine environment: Node, Chromium, model artifacts, decision source and outer LLM '
        + 'status. No browser, no model call, keys masked. Also runs the default-on ask probe '
        + '(`provider.ask_probe`): one minimal real ask through this deployment\'s decision plane; on '
        + 'failure check the deployment and CLI configs.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          node: { type: 'object', required: true, additionalProperties: true },
          chromium: { type: 'object', required: true, additionalProperties: true },
          model: { type: 'object', required: true, additionalProperties: true },
          provider: { type: 'object', required: true, additionalProperties: true },
          llm: { type: 'object', required: true, additionalProperties: true },
        },
      },
      render: (_args, value) => {
        // A5：探针只在它真跑过时出现（无在线决策源 / 部署侧关掉时缺省缺席，旧输出不变）。
        const probe = field(value.provider, 'ask_probe')
        const probeTag = probe === undefined
          ? ''
          : `; ask probe ${field(probe, 'ok') === true ? 'ok' : 'FAILED'}`
        return [{
          type: 'text',
          text: `${value.ok ? 'READY' : 'CHECK'}; node ${String(field(value.node, 'version') ?? '?')}; `
            + `chromium ${field(value.chromium, 'ok') === true ? 'ok' : 'missing'}; `
            + `model ${field(value.model, 'ready') === true ? 'ready' : 'missing'}; `
            + `decision ${String(field(field(value.provider, 'default'), 'name') ?? '?')}`
            + `${probeTag}; `
            + `outer LLM ${field(value.llm, 'configured') === true ? 'configured' : 'stub'}`,
        }]
      },
    },
    async execute() {
      return status(options)
    },
  }))

  ctx.tools.register(defineTool({
    name: `${toolPrefix}_app_show`,
    description:
      'Read one flow app before editing it: metadata, writable script path, version anchors and current '
        + '`app.mjs` source. Loads the script without a browser or run; the bridge never writes app code, '
        + 'you edit the file yourself.',
    parameters: {
      app: { type: 'string', required: true, description: 'App id from `*_apps`.' },
    },
    output: {
      schema: appDetailSchema,
      render: (_args, value) => [{
        type: 'text',
        text: `${value.app} — ${value.goal}`
          + `\npath: ${value.path} (${value.source})`
          + `\nhosts: ${value.hosts.join(',') || '-'}`
          + ` · slots: ${Object.keys(value.slots).join(',') || '-'}`
          + ` · required: ${value.required_slots.join(',') || '-'}`
          + ` · invariants: ${String(value.invariants.length)}`
          + `\nscript_sha256: ${value.script_sha256} · plan_sha256: ${value.plan_sha256}`
          + (value.code_truncated === true ? '\n(code truncated by the CLI; read the path for the rest)' : '')
          + (value.code === undefined ? '' : `\n\n${value.code}`),
      }],
    },
    async execute(args) {
      return appShow(options, args.app)
    },
  }))

  ctx.tools.register(defineTool({
    name: `${toolPrefix}_app_check`,
    description:
      'Validate a flow app offline: load `app.mjs` and dry-run its `flow(ctx)` call sequence. Checks '
        + 'targets, signals, slots and commands without a browser; returns per-app problems with the script '
        + 'line when available. An empty list means the script loads and its call sequence is legal, not '
        + 'that page state will hold.',
    parameters: {
      app: { type: 'string', required: true, description: 'App id from `*_apps`.' },
      slots: {
        type: 'array', items: { type: 'string' },
        description: 'Slot values for the offline branch check, in the same `key=value` format as `*_run` slots. '
          + 'Required slots still need a declared default in meta.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          checked: { type: 'integer', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                app: { type: 'string', required: true },
                path: { type: 'string', required: true },
                problems: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? 'VALID'
          : value.results.map(r => `${r.app}: ${r.problems.join('; ')}`).join('\n'),
      }],
    },
    async execute(args) {
      return appCheck(options, args.app, args.slots)
    },
  }))

  ctx.tools.register(defineTool({
    name: `${toolPrefix}_inspect`,
    description:
      'Observe a live page read-only before writing a target hint: title, URL and verified hint '
        + 'candidates. Returns elements with `hint_candidates`, AX-tree evidence and engine advisories. '
        + 'Element rows use the same ElementView contract as `*_session` `op:"observe"`; `ref` is a display '
        + 'anchor, not an act address, and the `hint_candidates` are the strings to copy: never invent CSS. '
        + '`structure_path` is diagnostic only, not a target. Starts its own one-shot session; use '
        + '`*_session` for repeated in-page steps. No clicks, typing or model calls; http(s) URLs only.',
    parameters: {
      url: { type: 'string', required: true, description: 'http(s) page to observe; the bridge rejects checkout-relative paths.' },
      max_elements: { type: 'integer', description: 'Maximum element rows to return (default 60, max 200).' },
      include_text: { type: 'boolean', description: 'Include a bounded body-text excerpt.' },
      headful: { type: 'boolean', description: 'Show a browser window on the engine host.' },
      probes: {
        type: 'array', items: { type: 'string' },
        description:
          'Read-only CSS selector probes (repeatable, max 10): match count plus up to 5 text excerpts each. '
            + 'Use for non-interactive done signals that the element pool cannot expose.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          url: { type: 'string', required: true },
          requested_url: { type: 'string' },
          title: { type: 'string', required: true },
          saw_at: { type: 'string' },
          wait_ms: { type: 'integer' },
          hint_syntax: { type: 'string' },
          elements: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          element_count: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          window: { type: 'object', additionalProperties: true },
          ax: { type: 'object', additionalProperties: true },
          advisories: { type: 'array', items: { type: 'object', additionalProperties: true } },
          pool_near_empty: { type: 'boolean' },
          interactive_on_page: { type: 'integer' },
          probes: { type: 'array', items: { type: 'object', additionalProperties: true } },
          text: { type: 'string' },
          screenshot_path: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.title} — ${value.url}\n`
          + (value.pool_near_empty === true
            ? `⚠ pool_near_empty (page has ${String(value.interactive_on_page ?? '?')} interactive elements; main pool barely picked any - heavy JS SPA). Try --wide --pool, or a 1-step probe app first.\n`
            : '')
          + value.elements.map(e => {
            const hints = field(e, 'hint_candidates')
            return `  ${String(field(e, 'ref') ?? '')} ${String(field(e, 'tag') ?? '')} ${String(field(e, 'label') ?? '')}`
              + `${Array.isArray(hints) && hints.length ? `  hints: ${hints.map(String).join(' | ')}` : ''}`
          }).join('\n')
          + (value.truncated ? `\n(truncated to ${String(value.element_count)} elements)` : '')
          + (Array.isArray(value.probes) && value.probes.length
            ? `\nprobes:\n${value.probes.map(p => `  ${String(field(p, 'selector') ?? '')} → `
              + (field(p, 'error') !== undefined ? String(field(p, 'error'))
                : `${String(field(p, 'count') ?? '')} hit ${JSON.stringify((field(p, 'texts') as unknown[] ?? []).slice(0, 1))}`)).join('\n')}`
            : '')
          + (Array.isArray(value.advisories) && value.advisories.length
            ? `\nadvisories:\n${value.advisories.map(a => `  [${String(field(a, 'kind') ?? '?')}] `
              + `${String(field(a, 'message') ?? '').slice(0, 200)}`).join('\n')}`
            : '')
          + (field(value, 'ax') !== undefined && field(value, 'ax') !== null
            ? `\nax: ${renderAxSummary(field(value, 'ax') as Record<string, unknown>)}`
            : ''),
      }],
    },
    async execute(args) {
      return inspect(options, {
        url: args.url,
        ...(args.max_elements === undefined ? {} : { maxElements: args.max_elements }),
        ...(args.include_text === undefined ? {} : { includeText: args.include_text }),
        ...(args.headful === undefined ? {} : { headful: args.headful }),
        ...(args.probes === undefined ? {} : { probes: args.probes }),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: `${toolPrefix}_test`,
    description:
      'Run the real-site regression suite: list cases, validate declarations offline, or run a tier. '
        + 'Blocked, unreachable and skipped are never counted as passed; evidence is written outside the '
        + 'repo and its path is returned.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'validate', 'run'] },
      tier: { type: 'string', description: 'Suite tier to run; the closed set is declared in the schema.' },
      case: { type: 'string', description: 'Run one case id instead of a whole tier.' },
      site: { type: 'string', description: 'Restrict to one site declared under `online/sites`.' },
      headful: { type: 'boolean' },
      require_all: { type: 'boolean', description: 'Treat skipped or blocked cases as failures (for scheduled runs).' },
      max_steps: { type: 'integer', description: 'Execution budget per case subgoal.' },
      timeout_sec: { type: 'integer', description: 'Per-site or per-case timeout override, in seconds.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          tier: { type: 'string' },
          sites: { type: 'integer' },
          cases: { type: 'integer' },
          valid: { type: 'boolean' },
          passed: { type: 'integer' },
          failed: { type: 'integer' },
          skipped: { type: 'integer' },
          evidence_dir: { type: 'string' },
          cases_detail: { type: 'array', items: { type: 'object', additionalProperties: true } },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.action === 'validate'
          ? `VALID ${String(value.sites)} sites / ${String(value.cases)} cases`
          : value.action === 'list'
            ? `${String(value.cases_detail?.length ?? 0)} cases`
            : `${value.ok ? 'PASS' : 'FAIL'} ${String(value.passed)} passed / ${String(value.failed)} failed / ${String(value.skipped)} skipped`
              + (value.evidence_dir ? `\nevidence: ${value.evidence_dir}` : ''),
      }],
    },
    async execute(args) {
      return test(options, {
        action: args.action as 'list' | 'validate' | 'run',
        ...(args.tier === undefined ? {} : { tier: args.tier }),
        ...(args.case === undefined ? {} : { case: args.case }),
        ...(args.site === undefined ? {} : { site: args.site }),
        ...(args.headful === undefined ? {} : { headful: args.headful }),
        ...(args.require_all === undefined ? {} : { requireAll: args.require_all }),
        ...(args.max_steps === undefined ? {} : { maxSteps: args.max_steps }),
        ...(args.timeout_sec === undefined ? {} : { timeoutSec: args.timeout_sec }),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: `${toolPrefix}_app_create`,
    description:
      'Create a flow app skeleton under the user scope via `amber apps new`; you then edit the '
        + 'generated `app.mjs`. Returns the app id, path and current source. The skeleton is guidance only: '
        + 'no step table, no JSON app format. '
        + PLAN_PLAYBOOK_SHORT,
    parameters: {
      id: { type: 'string', required: true, description: 'Lowercase id; also the directory name.' },
      goal: { type: 'string', description: 'One-line goal written into `meta.goal`.' },
      hosts: { type: 'array', items: { type: 'string' }, description: 'Allowed hosts, repeatable (`--host`).' },
      url: {
        type: 'string',
        description: 'Entry page forwarded as `--url`: `site.pages.home` becomes this page and its host joins the '
          + 'allowed hosts.',
      },
    },
    output: {
      schema: appDetailSchema,
      render: (_args, value) => [{
        type: 'text',
        text: `CREATED ${value.app} at ${value.path}; next: edit the app.mjs, then `
          + `${toolPrefix}_app_check, then ${toolPrefix}_run`,
      }],
    },
    async execute(args) {
      return createApp(options, {
        id: args.id,
        ...(args.goal === undefined ? {} : { goal: args.goal }),
        ...(args.hosts === undefined ? {} : { hosts: args.hosts }),
        ...(args.url === undefined ? {} : { url: args.url }),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: `${toolPrefix}_learn`,
    description:
      'Record one browser flow into a flow app from a recorded action list plus its start page. The '
        + 'engine runs the list once, induces each step\'s completion signal and the end-state invariants, '
        + 'and writes `apps/<id>/app.mjs` only when a rules-only replay with zero model calls still passes. '
        + 'The result reports that replay honestly; a flow that cannot be reproduced is never reported as '
        + 'learned. A live demo is unavailable through a tool call, so `script` is required. Needs a '
        + 'browser and the local decision runtime on the engine host.',
    parameters: {
      goal: { type: 'string', required: true, description: 'One line describing the flow to perform.' },
      url: { type: 'string', required: true, description: 'http(s) page to start the recording from.' },
      script: {
        type: 'string',
        required: true,
        description:
          'Path to the recorded action list: a JSON array of action entries. Each entry is '
            + '`{"op":"click"|"type","hint":"<selector hint>","value"?,"label"?}`. Required; the only action '
            + 'source that works without a terminal. '
            + HINT_LEARN_NOTE,
      },
      id: { type: 'string', description: 'App id to save under; defaults to a slug of host plus goal.' },
      cdp: { type: 'string', description: 'CDP WebSocket URL of the browser to attach to; selects the browser, not the actions.' },
      headful: { type: 'boolean', description: 'Launch a visible browser for the recording (debug aid for flaky flows).' },
      apps_dir: {
        type: 'string',
        description: 'Directory to write the flow app into (the CLI\'s `--apps-dir`); defaults to the user-scope apps '
          + 'dir, never the checkout. Recorded apps are user config; checkout `apps/` are development '
          + 'fixtures.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          app: { type: 'string', required: true },
          steps: { type: 'integer', required: true },
          verified: { type: 'boolean', required: true },
          forwards: { type: 'integer', required: true },
          completed: { type: 'string', required: true },
          invariants: { type: 'string', required: true },
          problems: { type: 'array', items: { type: 'string' } },
          saved: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.status}: ${value.app} (${String(value.steps)} steps) — rules-only replay of the `
          + `generated script: ${value.completed}, ${value.invariants}, ${String(value.forwards)} model call(s); `
          + (value.saved ? `saved as a flow app at ${value.saved}` : 'NOT saved')
          + (value.problems && value.problems.length ? `; failed invariants: ${value.problems.join(', ')}` : ''),
      }],
    },
    async execute(args) {
      const summary = await learn(options, {
        url: args.url,
        goal: args.goal,
        script: args.script,
        ...(args.id === undefined ? {} : { id: args.id }),
        ...(args.cdp === undefined ? {} : { cdp: args.cdp }),
        ...(args.headful === undefined ? {} : { headful: args.headful }),
        ...(args.apps_dir === undefined ? {} : { appsDir: args.apps_dir }),
      })
      return {
        status: summary.status,
        app: summary.app,
        steps: summary.steps,
        verified: summary.verified,
        forwards: summary.forwards,
        completed: summary.completed,
        invariants: summary.invariants,
        ...(summary.problems === undefined ? {} : { problems: summary.problems }),
        ...(summary.saved ? { saved: summary.saved } : {}),
      }
    },
  }))

  // ---------- `amberflow_session`（task-35 / Phase 3）：交互式试错 authoring 面 ----------
  // 纯增量：不改任何既有工具的参数/返回/描述；缺省不创建子进程（只有 open 才 spawn 一个
  // 常驻引擎子进程）。工具失败语义：引擎结构化失败原样透传且会话继续；只有会话不可用/桥故障
  // 才是 {ok:false, code} 的工具级错误（见 iterations/interactive-session/phase3-design.md §5）。
  const sessions = new SessionManager({
    bridge: options,
    ...(config.sessionIdleMs === undefined ? {} : { idleMs: config.sessionIdleMs }),
    ...(config.maxSessions === undefined ? {} : { maxSessions: config.maxSessions }),
  })
  // 插件卸载 / 宿主退出：关掉所有会话（close → 等退出 → 杀进程树），不留孤儿浏览器。
  ctx.effect(() => () => { void sessions.dispose() }, 'amberflow-bridge: session manager (kill children)')
  ctx.tools.register(defineTool({
    name: `${toolPrefix}_session`,
    description:
      'Start a state-preserving authoring session against one live page. `open` returns `session_id`; '
        + 'then call `observe`/`act`/`read`/`extract`/`signal`/`wait_for`/`snapshot`/`tab`; `close` ends '
        + 'it. Calls do not re-navigate, so SPA state survives. Use it to try a flow step by step or debug '
        + 'one failing step; `*_inspect` is the one-shot read and `*_run` is completion truth: this tool '
        + 'never judges completion. `observe` returns verified hint candidates; `act` needs an explicit '
        + '`value`. Errors return `{ok:false, code, reason}` and keep the session alive. Sessions expire '
        + 'after an idle TTL.',
    parameters: {
      op: {
        type: 'string', required: true,
        enum: ['open', 'observe', 'act', 'read', 'extract', 'signal', 'wait_for', 'snapshot', 'tab', 'close', 'list'],
        description: 'Operation to run; `open` creates a session and returns `session_id`.',
      },
      session_id: { type: 'string', description: 'Session id returned by `open`; required for every op except `open` and `list`.' },
      url: { type: 'string', description: 'open: entry page (http(s) only; checkout-relative paths are rejected).' },
      hosts: {
        type: 'array', items: { type: 'string' },
        description: 'open: navigation envelope; same semantics as `meta.hosts` (defaults to the URL host).',
      },
      headful: { type: 'boolean', description: 'open: show a browser window.' },
      window: {
        type: 'string', enum: ['maximized', 'fullscreen'],
        description: 'open: window size for a headed session: `maximized` keeps browser chrome, `fullscreen` covers '
          + 'the screen. Needs a visible window (headful or deployment config); a headless session rejects '
          + 'it.',
      },
      record: {
        type: 'boolean',
        description: 'open: record the action trajectory JSONL under the session evidence dir. `close` returns the '
          + 'record path for `amber session export`; set `false` to disable.',
      },
      act_op: {
        type: 'string', enum: ['click', 'check', 'fill', 'select', 'hover', 'scroll'],
        description: 'act: single action to perform.',
      },
      target: { type: 'string', description: 'act: target hint string (hint grammar: `#id`, `tag[attr=value]`, `tag[attr~substr]`, '
        + '`tag~token`, role word, bare word).' },
      on_ambiguous: {
        type: 'string', enum: ['fail', 'act'],
        description: 'act: what to do when several distinct candidates match the hint. `fail` executes nothing and '
          + 'returns `code:"target_ambiguous"` with a bounded ambiguity block; `act` clicks the first '
          + 'actionable candidate (legacy behavior, use only to reproduce an old flow). Prefer narrowing the '
          + 'hint over guessing.',
      },
      rehydrate_rescan: {
        type: 'boolean',
        description: 'act: opt-in bounded rescan for hydration races. When the first resolve misses and the page never '
          + 'settled, wait 2 s, re-extract and re-resolve the same hint at most once, with no model vote. '
          + 'Reports `resolved_via:"rehydrate-rescan"` on hit; otherwise keeps the original stop code. Prefer '
          + '`wait_for` anchoring when authoring.',
      },
      value: { type: 'string', description: 'act `fill`/`select`: the value to type or select; explicit only, never invented.' },
      to: {
        type: 'string', enum: ['bottom', 'top', 'page'],
        description: 'act `scroll`: scroll the target\'s scrollable container to `bottom` or `top`, or use `page` for '
          + 'the document. Omit `to` and `by` to scroll the target into the viewport instead.',
      },
      by: {
        type: 'integer',
        description: 'act `scroll`: pixel delta for the container; preferred when both `to` and `by` are given. Must '
          + 'be finite and non-zero.',
      },
      selector: { type: 'string', description: 'read: CSS selector to read.' },
      what: {
        type: 'string', enum: ['text', 'value', 'count', 'attr'],
        description: 'read: what to read: `text` (innerText), `value` (inputValue), `count` (match count) or `attr` '
          + '(attribute value).',
      },
      attr: { type: 'string', description: 'read with `what:"attr"`: attribute name.' },
      rows: { type: 'string', description: 'extract: row CSS selector.' },
      fields: {
        type: 'object', additionalProperties: true,
        description: 'extract: field map `{name: css | row text | @attr}`; same semantics as inline `ctx.extract`.',
      },
      max_items: { type: 'integer', description: 'extract: rows per page; `count` is the rows returned on this page, not the total.' },
      offset: {
        type: 'integer',
        description: 'extract: 0-based row offset for the next page; advance by the returned `count` and stop when '
          + '`has_more` is false. Out of range returns `config_error`.',
      },
      save: {
        type: 'boolean',
        description: 'extract: persist the full result to an evidence file. Pages through the result in the bridge '
          + '(hard cap 2000 rows / 4MB) and writes `<evidence_dir>/extract-<n>.json`; the result then carries '
          + '`file`/`saved`/`bytes` and, when capped, `truncated`/`save_limit`.',
      },
      signal: {
        type: 'object', additionalProperties: true,
        description: 'signal/`wait_for`: verifiable-signal object, same operator set as run done/when signals. '
          + 'Operators: `url_contains`, `css_exists`, `css_exists_text`, `css_visible_exists`, '
          + '`css_text_contains`, `css_text_equals`, `css_value_equals`, `all_of`, `any_of`, `not`, `manual`.',
      },
      timeout_ms: { type: 'integer', description: 'wait_for: poll window in milliseconds.' },
      max: { type: 'integer', description: 'observe: maximum rows (same ElementView cap as `*_inspect` `max_elements`).' },
      include_hidden: { type: 'boolean', description: 'observe: include invisible elements.' },
      include_structure: {
        type: 'boolean',
        description: 'observe: include diagnostic-only `structure_path` evidence. It is unstable and not a hint; never '
          + 'copy it into a target.',
      },
      screenshot: { type: 'boolean', description: 'snapshot: also write a viewport screenshot. `act`: write a failure screenshot only when the '
        + 'action fails; only paths are returned.' },
      tab_action: {
        type: 'string', enum: ['list', 'switch'],
        description: 'tab: `list` enumerates context pages without switching: active index plus TabInfo rows. `switch` '
          + 'moves the session to the one tab matching `match` and refreshes the idle TTL.',
      },
      match: {
        type: 'object', additionalProperties: true,
        description: 'tab `switch`: match by `{index}`, `{urlContains}` or `{titleContains}`; keys AND-narrow and at '
          + 'least one is required. Missing, empty, 0 or more than 1 matches return `config_error`; a tab '
          + 'outside the declared hosts envelope returns `host_not_allowed` and is not activated.',
      },
      idle_timeout_ms: {
        type: 'integer',
        description: 'open: per-session idle TTL in milliseconds. Omit for the deployment default; `0` means '
          + 'unlimited. Values 1..999 are rejected with `config_error`; other ops passing it also return '
          + '`config_error`. `op:"list"` rows echo the effective value.',
      },
    },
    output: {
      // 结果形态按 op 不同（设计师 §2/§3）：只声明公共 ok/op/session_id 与额外的宽松键。
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderSessionResult(value as Record<string, unknown>) }],
    },
    async execute(args) {
      // 结果是按 op 不同的紧凑 JSON（schema 面宽松，见上）；这里只是把 unknown 收窄回 JsonValue。
      return await handleSessionTool(args as SessionToolArgs, sessions) as unknown as Record<string, JsonValue>
    },
  }))
}

/** One context-cheap line for the inspect `ax` block: counts + not_in_pool gap, or the reason it is unavailable. */
function renderAxSummary(ax: Record<string, unknown>): string {
  if (ax['available'] !== true) {
    return `unavailable — ${String(ax['reason'] ?? 'accessibility tree not readable; other observation unchanged')}`
  }
  const notInPool = typeof ax['not_in_pool'] === 'number' ? ax['not_in_pool'] : undefined
  const interactive = typeof ax['interactive_count'] === 'number' ? ax['interactive_count'] : undefined
  const poolSize = typeof ax['pool_size'] === 'number' ? ax['pool_size'] : undefined
  return `interactive=${String(interactive ?? '?')} pool=${String(poolSize ?? '?')}`
    + (notInPool === undefined ? '' : ` named-interactive-not-in-pool=${String(notInPool)} (approximate; see ax.nodes)`)
}

/** One context-cheap textual line (or block) for one `amberflow_session` result. */
function renderSessionResult(value: Record<string, unknown>): string {
  const ok = value.ok === true
  const op = typeof value.op === 'string' ? value.op : '?'
  const sid = typeof value.session_id === 'string' ? value.session_id : ''
  const tag = `${ok ? 'ok' : 'FAIL'} ${op}${sid === '' ? '' : ` [${sid}]`}`
  if (!ok) {
    const amb = typeof value.ambiguity === 'object' && value.ambiguity !== null
      ? value.ambiguity as Record<string, unknown>
      : undefined
    const rows = amb !== undefined && Array.isArray(amb.candidates)
      ? amb.candidates.filter((raw): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null).slice(0, 5)
      : []
    const header = amb === undefined
      ? ''
      : `\nambiguous: ${String(amb.candidates_total ?? rows.length)} candidate(s) for ${JSON.stringify(amb.target ?? '')}`
        + ` — would have acted on ${String(amb.would_act_ref ?? '-')}; nothing was executed`
        + (amb.source === 'dom_fallback' ? ' (DOM fallback candidates, outside the visible pool)' : '')
        + ' — narrow the hint or set on_ambiguous:"act" to reproduce the old click'
    const detail = rows.map((c) => {
      const ref = String(c.ref ?? '?')
      const tag = String(c.tag ?? '')
      const role = typeof c.role === 'string' && c.role !== '' ? `[role=${c.role}]` : ''
      const label = String(c.label ?? '')
      const near = typeof c.near === 'string' && c.near !== '' ? ` near="${c.near}"` : ''
      // B 批：候选帧 origin（引擎给了才有）——跨帧同名时先看这一项，再用 hint 的 frame: 尾缀收窄。
      const origin = typeof c.frame_origin === 'string' && c.frame_origin !== '' ? ` frame=${c.frame_origin}` : ''
      const hint = typeof c.suggested_hint === 'string' ? `  hint=${c.suggested_hint}` : ''
      return `\n  ${ref} ${tag}${role} "${label}"${c.same_label === true ? ' (same label as others)' : ''}${near}${origin}${hint}`
    }).join('')
    // B1：动作失败现场（引擎给了 actionability 才有这一行）——直接被谁挡住、节点是否还在。
    const actionability = typeof value.actionability === 'object' && value.actionability !== null
      ? value.actionability as Record<string, unknown>
      : undefined
    const blocked = actionability === undefined
      ? ''
      : `\nblocked by ${String(actionability.blocker ?? 'unknown')} (requery=${String(actionability.requery ?? 'unknown')})`
    // A4：落空判别（引擎 `diagnostics` 存在才有这一行）——池里有什么/近似什么/为何没解析成目标。
    const miss = typeof value.diagnostics === 'object' && value.diagnostics !== null
      ? value.diagnostics as Record<string, unknown>
      : undefined
    const missRows = (key: string): string => {
      const list = miss?.[key]
      if (!Array.isArray(list)) return ''
      return list.map((raw) => {
        const row = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
        const why = typeof row.why === 'string' && row.why !== '' ? ` (${row.why})` : ''
        return `${String(row.tag ?? '')} "${String(row.label ?? '')}"${why}`
      }).join(' | ')
    }
    const missLine = miss === undefined
      ? ''
      : `\nno match: hint ${String(miss.hint_shape ?? '?')}/${String(miss.hint_len ?? '?')} pool ${String(miss.pool_size ?? '?')}`
        + (missRows('candidates') === '' ? '' : ` — candidates: ${missRows('candidates')}`)
        + (missRows('near') === '' ? '' : ` — near: ${missRows('near')}`)
        + (missRows('rejected') === '' ? '' : ` — rejected: ${missRows('rejected')}`)
    return `${tag}: ${String(value.code ?? 'error')}${value.reason === undefined ? '' : ` — ${String(value.reason)}`}`
      + (value.session_alive === true ? ' (session still alive)' : '')
      + header
      + detail
      + blocked
      + missLine
  }
  switch (op) {
    case 'open':
      return `${tag}: ${String(value.url ?? '')}${value.title === undefined ? '' : ` — ${String(value.title)}`}`
        + (value.code === 'navigation_flapping'
          ? `\nnavigation flap: ${value.healed === true
            ? `healed — re-nav to ${String(value.heal_url ?? '')}`
            : 'NOT healed'} (${String(value.navigations ?? '?')} navs in ${String(value.window_ms ?? '?')}ms)`
          : '')
        + `\nevidence: ${String(value.evidence_dir ?? '')}`
        + (value.record === undefined || value.record === null ? '\nrecord: off' : `\nrecord: ${String(value.record)}`)
        + `\nidle TTL: ${String(value.idle_ttl_ms ?? '?')}ms`
    case 'observe': {
      const el = Array.isArray(value.elements) ? value.elements : []
      const lines = el.slice(0, OBSERVE_DISPLAY).map((raw) => {
        const e = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
        const hints = Array.isArray(e.hint_candidates) ? e.hint_candidates.filter((h): h is string => typeof h === 'string') : []
        const notAdmitted = e.admitted === false && typeof e.why_not_admitted === 'string' && e.why_not_admitted !== ''
        return `  ${String(e.ref ?? '')} ${String(e.tag ?? '')} ${String(e.label ?? '')}`
          + (hints.length ? ` → ${hints.join(' | ')}` : ' (no hint)')
          + (notAdmitted ? `  [not admitted: ${String(e.why_not_admitted).slice(0, 80)}]` : '')
      })
      const counts = typeof value.counts === 'object' && value.counts !== null
        ? value.counts as Record<string, unknown>
        : undefined
      const total = counts !== undefined && typeof counts['elements'] === 'number' ? counts['elements'] : el.length
      const omitted = counts !== undefined && typeof counts['omitted'] === 'number' ? counts['omitted'] : undefined
      const more = el.length - OBSERVE_DISPLAY
      return `${tag}: ${String(value.url ?? '')} elements ${String(el.length)}`
        + (value.counts === undefined ? '' : ` counts ${JSON.stringify(value.counts)}`)
        + (value.truncated === true ? ' (truncated)' : '')
        + (lines.length ? `\n${lines.join('\n')}` : '')
        // C1：只有溢出才追加两行（≤20 行时输出与此前逐字节一致；observe 没有 offset——
        // 元素序随水合/动画变化，收窄用 selector，全量用 snapshot）。
        + (more > 0
          ? `\n… +${more} more (${String(total)} total${omitted === undefined ? '' : `, ${String(omitted)} omitted`})`
            + '\nnext: selector="<css>" 收窄 · max=<n≤200> 放宽 · snapshot → pool-<n>.json（全量元素）'
          : '')
    }
    case 'act':
      return `${tag}: ${String(value.act_op ?? '')} ${String(value.target ?? '')} → ${String(value.how ?? '?')}`
        + ` ref=${String(value.ref ?? '-')} changed=${String(value.changed === true)}`
        + (value.act_op === 'scroll'
          ? ` moved=${String(value.moved === true)}`
            + (typeof value.delta === 'number' ? ` delta=${String(value.delta)}px` : '')
            + (typeof value.scroll === 'object' && value.scroll !== null
              ? ` scrollTop=${String((value.scroll as Record<string, unknown>).scrollTop ?? '?')}`
              : '')
          : '')
        + `\nurl: ${String(value.url ?? '')}`
        + (value.ambiguous === true
          ? `\nambiguous: yes${Array.isArray(value.matched_others) && value.matched_others.length > 0
            ? ` — other candidates: ${value.matched_others.map((raw) => {
              const c = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
              return `${String(c.tag ?? '')}${typeof c.class === 'string' && c.class !== '' ? `.${c.class}` : ''} "${String(c.label ?? '')}"`
            }).join(' | ')}`
            : ''}; re-observe and retry with a narrower hint`
          : '')
        + (value.hint_suspicious === true
          ? `\nweak-tier hit (${String(value.hint_kind ?? '?')} tier ${String(value.hint_tier ?? '?')}) — the element may be a container/same-prefix node, not the intended target`
          : '')
    case 'read':
      return `${tag}: ${String(value.what ?? '')}(${String(value.selector ?? '')}) = ${JSON.stringify(value.value ?? null)}`
        + (value.value_truncated === true ? ' (truncated)' : '')
    case 'extract': {
      const rows = Array.isArray(value.rows) ? value.rows : []
      const total = typeof value.total === 'number' ? value.total : undefined
      const offset = typeof value.offset === 'number' ? value.offset : 0
      const more = total === undefined ? 0 : total - offset - rows.length
      const savedLine = typeof value.file === 'string'
        ? `\nsaved: ${String(value.file)} (${String(value.saved ?? rows.length)} row(s), ${String(value.bytes ?? 0)} bytes)`
          + (value.truncated === true
            ? ` — truncated${typeof value.save_limit === 'string' ? ` at ${value.save_limit}` : ''}`
            : '')
        : ''
      return `${tag}: ${String(value.count ?? rows.length)} row(s)${value.capped === true ? ' (capped)' : ''}`
        + (rows.length ? `\n${rows.slice(0, EXTRACT_DISPLAY).map(r => `  ${JSON.stringify(r)}`).join('\n')}` : '')
        // C1：只有还有行没显示时才追加两行（≤20 行且无续页时输出与此前逐字节一致）。
        + (more > 0
          ? `\n… +${more} more`
            + `\ntotal=${String(total)} · offset=${String(offset + rows.length)} 续页 · save:true → extract-<n>.json`
          : '')
        + savedLine
    }
    case 'signal':
      return `${tag}: held=${String(value.held === true)}`
    case 'wait_for':
      return `${tag}: held=${String(value.held === true)} after ${String(value.elapsed_ms ?? '?')}ms`
    case 'snapshot':
      return `${tag}: ${String(value.url ?? '')}`
        + `\nsnapshot: ${String(value.snapshot_file ?? '')}`
        + `\npool: ${String(value.pool_file ?? '')}`
        + (value.screenshot_file === undefined ? '' : `\nscreenshot: ${String(value.screenshot_file)}`)
    case 'tab': {
      const sw = typeof value.switched === 'object' && value.switched !== null
        ? value.switched as Record<string, unknown>
        : undefined
      if (value.action === 'switch' || sw !== undefined) {
        return `${tag}: switched → #${String(sw?.index ?? '?')} ${String(sw?.url ?? '')}`
          + (sw?.title === undefined || sw?.title === '' ? '' : ` — ${String(sw?.title)}`)
      }
      const tabs = Array.isArray(value.tabs) ? value.tabs : []
      const lines = tabs.slice(0, 10).map((raw) => {
        const t = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
        return `  #${String(t.index ?? '?')} ${String(t.url ?? '')}`
          + (t.title === undefined || t.title === '' ? '' : ` — ${String(t.title)}`)
          + (t.active === true ? ' [active]' : '')
      })
      const more = tabs.length - lines.length
      return `${tag}: ${tabs.length} tab(s), active=#${String(value.active ?? '?')}`
        + (lines.length ? `\n${lines.join('\n')}` : '')
        + (more > 0 ? `\n… +${more} more (full list in the JSON result)` : '')
    }
    case 'close':
      return `${tag}: closed after ${String(value.requests ?? 0)} request(s), ${String(value.actions ?? 0)} action(s);`
        + ` evidence: ${String(value.evidence_dir ?? '')}`
        + (value.record === undefined ? '' : `\nnext: amber session export --record ${String(value.record)} --id <appId>`)
    case 'list': {
      const rows = Array.isArray(value.sessions) ? value.sessions : []
      return rows.length === 0
        ? `${tag}: no live sessions`
        : `${tag}:\n${rows.map((r) => {
          const s = typeof r === 'object' && r !== null ? r as Record<string, unknown> : {}
          return `  ${String(s.session_id ?? '')} ${String(s.url ?? '')} idle=${String(s.idle_ms ?? 0)}ms actions=${String(s.actions ?? 0)}`
        }).join('\n')}`
    }
    default:
      return `${tag}: ${JSON.stringify(value).slice(0, 500)}`
  }
}