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
import { listApps, normalizeDecisionEndpoint, type BridgeOptions } from './bridge.ts'
import {
  appCheck, appShow, createApp, inspect, learn, runApp, status, test,
  createService, type AmberFlowService,
} from './service.ts'
// 语法/规划引导/概述层生成物（勿手改）：唯一出处是引擎的 grammar-prompt.ts、
// planning-playbook.ts 与 help-map.ts，这里只收字符串（桥不 import 引擎代码）；
// 漂移由 `npm run prompt-hit` 校验。
import { HINT_LEARN_NOTE, OVERVIEW_TEXT, PLAN_PLAYBOOK_SHORT, STOP_ESCALATION_TEXT } from './grammar.generated.ts'

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
   * These three fields plus {@link Config.stepGapMs} are the ONLY `.volatile()` fields in this
   * Config, so the plugin's configuration page (`plugins.row.config`) shows exactly them. They are
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
      'List the flow apps this machine can run, via `amber apps list --json`. Apps live in the user '
      + 'scope (`$AMBERFLOW_HOME/apps/<id>/app.mjs`, by default ~/.amberflow/apps) — the repository '
      + 'ships no apps, whatever is under its `apps/` is a development fixture. Every row names the '
      + 'app id, label, one-line goal, the writable script path, its source (user scope or checkout '
      + 'fixture), invariant count and allowed hosts. There is only ONE app format — a JS flow '
      + 'script — so there is no static step table: steps are runtime facts. A row carrying `error` '
      + 'failed to load. Starts no browser and calls no model.',
    parameters: {
      filter: { type: 'string', description: 'Optional case-insensitive substring match on id/label/goal.' },
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
      'Run one flow app (a user-scope `app.mjs`; the repository ships no apps) end to end: the '
      + 'script\'s `flow(ctx)` owns the control '
      + 'flow (if/for/while, sub-functions), the engine decides each step\'s target, gate, action and '
      + 'completion signal, and the declared end-state invariants are the only pass/fail truth. '
      + '`max_steps` is an EXECUTION BUDGET, not a step index: the script runs under its own control '
      + 'flow and stops with `budget_exceeded` when the budget is used up (status=partial, '
      + 'verified=false). By default it runs the whole flow. `trace` defaults to true. `dry` only '
      + 'dry-runs the call sequence without a browser; `ablate` is an explicit ablation arm, not a '
      + 'routine mode. Returns a compact summary with status, failed steps, invariants, model tier, '
      + 'result/report paths and the first structured failure. Escalation rule: '
      + STOP_ESCALATION_TEXT,
    parameters: {
      app: { type: 'string', required: true, description: 'The app id from `' + toolPrefix + '_apps`.' },
      dry: { type: 'boolean', description: 'Only dry-run the script\'s call sequence; no browser, no tools.' },
      ablate: { type: 'string', enum: ['stub', 'rules-only'], description: 'ABLATION EXPERIMENT ONLY. `stub` installs a scripted fake model; `rules-only` runs with no model at all. Omit to use the plane the checkout is configured with: the online service when AMBERFLOW_DECISION_BASE_URL is set, otherwise the local model (run `npm run doctor` in the checkout to see which one resolves).' },
      provider: { type: 'string', description: 'Override the decision provider for this call (laya-onnx, decision-service, a baseline, or an ablation). Omit to use the configured three-key service, or the local model when no service URL is set.' },
      no_sources: { type: 'boolean', description: 'Skip the data leg (use already-available data).' },
      headful: { type: 'boolean', description: 'Open a VISIBLE browser window for the run (engine '
        + '--headful). The window appears on the machine that runs the engine — the deployment host, '
        + 'not inside this browser page — so that host needs a real display, or a virtual one '
        + '(`xvfb-run -a`) plus VNC/noVNC, for a person to watch. Default false (headless).' },
      allow_dangerous: {
        type: 'boolean',
        description: 'Permit dangerous tool steps (dry-run gated). Requires the deployment to enable it.',
      },
      confirm_safe: {
        type: 'boolean',
        description: 'With allow_dangerous, still confirm each destructive step against its dry-run '
          + 'evidence (the engine\'s middle gate) instead of blanket-approving.',
      },
      tiered_hint: {
        type: 'boolean',
        description: 'P1 experiment: when a target hint resolves to an ambiguous tier, the model is '
          + 'asked a SMALLER question (only that tier\'s candidates, not the whole pool). Off by '
          + 'default — behavior identical to before; use it for A/B runs.',
      },
      slots: {
        type: 'array',
        description: 'Values for declared slots, as "key=value" entries (e.g. ["date=2026-10-12"]).',
        items: { type: 'string' },
      },
      max_steps: {
        type: 'integer',
        description: 'Execution budget for this call (engine `--max-steps`), NOT a 1-based step '
          + 'index. When the budget is used up the script stops with `budget_exceeded` '
          + '(status=partial, verified=false).',
      },
      trace: { type: 'boolean', description: 'Include per-step execution evidence in the result. Defaults to true.' },
    },
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
            + (value.failure ? `; first failure: step ${String(value.failure.step)} ${value.failure.desc}`
              + `${value.failure.stop_code ? ` (${value.failure.stop_code})` : ''}` : '')
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
          throw new Error(`amberflow-bridge: slot ${JSON.stringify(entry)} must be "key=value"`)
        }
        const key = entry.slice(0, at)
        // The CLI treats a repeated slot as a usage error; catching it here keeps the bridge from
        // silently dropping the first value before the CLI ever sees the duplicate.
        if (slots.has(key)) {
          throw new Error(`amberflow-bridge: slot ${JSON.stringify(key)} was given more than once`)
        }
        slots.set(key, entry.slice(at + 1))
      }
      // The deployment gate lives in the shared call, so the service refuses it identically.
      const { summary } = await runApp(options, {
        app: args.app,
        ...(args.dry === undefined ? {} : { dry: args.dry }),
        ...(args.ablate === undefined ? {} : { ablate: args.ablate }),
        ...(args.provider === undefined ? {} : { provider: args.provider }),
        ...(args.no_sources === undefined ? {} : { noSources: args.no_sources }),
        ...(args.headful === undefined ? {} : { headful: args.headful }),
        ...(args.allow_dangerous === undefined ? {} : { allowDangerous: args.allow_dangerous }),
        ...(args.confirm_safe === undefined ? {} : { confirmSafe: args.confirm_safe }),
        ...(args.tiered_hint === undefined ? {} : { tieredHint: args.tiered_hint }),
        ...(args.max_steps === undefined ? {} : { maxSteps: args.max_steps }),
        ...(args.trace === undefined ? {} : { trace: args.trace }),
        // `Object.fromEntries` defines own properties, so even a `__proto__` slot reaches the CLI.
        ...(args.slots === undefined ? {} : { slots: Object.fromEntries(slots) }),
      })
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
      + 'Report the environment the engine will run in: Node, Chromium, local model artifacts, the '
      + 'effective decision source (online service or local), and whether the outer LLM is configured. '
      + 'Reads only; no browser, no model call, no secrets (API keys are masked).',
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
      render: (_args, value) => [{
        type: 'text',
        text: `${value.ok ? 'READY' : 'CHECK'}; node ${String(field(value.node, 'version') ?? '?')}; `
          + `chromium ${field(value.chromium, 'ok') === true ? 'ok' : 'missing'}; `
          + `model ${field(value.model, 'ready') === true ? 'ready' : 'missing'}; `
          + `decision ${String(field(field(value.provider, 'default'), 'name') ?? '?')}; `
          + `outer LLM ${field(value.llm, 'configured') === true ? 'configured' : 'stub'}`,
      }],
    },
    async execute() {
      return status(options)
    },
  }))

  ctx.tools.register(defineTool({
    name: `${toolPrefix}_app_show`,
    description:
      'Read one flow app: metadata (hosts, slots, sources, invariants, policy, pace), the writable '
      + 'script path, both version anchors (`script_sha256` / `plan_sha256`) and the CURRENT source of '
      + '`app.mjs`. Use this before editing; it loads the script (no browser, no run). The Agent reads '
      + 'and edits the file itself — this bridge never writes app code.',
    parameters: {
      app: { type: 'string', required: true, description: 'The app id from the apps tool.' },
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
      'Statically validate one flow app: load `app.mjs` (meta contract + imports) and dry-run its '
      + '`flow(ctx)` call sequence, checking targets/signals/slots/commands without launching a '
      + 'browser. Returns per-app problems (with script line when available); an empty list means the '
      + 'script is loadable and its call sequence is legal — not that page state will hold.',
    parameters: {
      app: { type: 'string', required: true, description: 'The app id from the apps tool.' },
      slots: {
        type: 'array', items: { type: 'string' },
        description: 'Values for declared slots as "k=v" entries (repeatable), forwarded as `--slot` to '
          + 'the dry validation — validate slot-parameterized branches offline. Required slots still need '
          + 'a declared (possibly empty-string) default in meta.',
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
      'Observe a live page without acting: title, URL, a bounded list of interactive elements, and '
      + 'verified hint candidates for each. Use this before writing a step target hint. No clicks, no '
      + 'typing, no model call; only http(s) URLs.',
    parameters: {
      url: { type: 'string', required: true, description: 'The http(s) page to observe.' },
      max_elements: { type: 'integer', description: 'Default 60, max 200.' },
      include_text: { type: 'boolean', description: 'Include a bounded body-text excerpt.' },
      headful: { type: 'boolean', description: 'Show a browser window on the engine host.' },
      probes: {
        type: 'array', items: { type: 'string' },
        description:
          'Read-only CSS selector probes (repeatable, max 10): existence count + up to 5 text '
          + 'excerpts each. Use for non-interactive done signals (h1/.class) that the interactive '
          + 'element pool cannot show.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          elements: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          element_count: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
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
      'Use the real-site regression suite: list cases, validate declarations offline, or run a tier. '
      + 'Never counts blocked/unreachable/skipped as passed; evidence is written outside the repo and '
      + 'the path is returned.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'validate', 'run'] },
      tier: { type: 'string', description: 'smoke | core | deep | probe | all | default' },
      case: { type: 'string', description: 'Run one case id.' },
      site: { type: 'string', description: 'Restrict to one site.' },
      headful: { type: 'boolean' },
      require_all: { type: 'boolean', description: 'Treat skipped/blocked as failure (scheduled runs).' },
      max_steps: { type: 'integer', description: 'Per-case subgoal execution budget (default 8).' },
      timeout_sec: { type: 'integer', description: 'Override site/case timeout in seconds.' },
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
      'Create a flow app skeleton under the user scope via `amber apps new`: `apps/<id>/app.mjs` '
      + 'with `meta` + an empty `flow(ctx)` to fill in. Returns the new app, its writable path and its '
      + 'current source. Only the skeleton is generated — the Agent edits the script itself; there is '
      + 'no step/format/kind parameter and no JSON app format. '
      + PLAN_PLAYBOOK_SHORT,
    parameters: {
      id: { type: 'string', required: true, description: 'Lowercase id; also the directory name.' },
      goal: { type: 'string', description: 'One-line goal written into `meta.goal`.' },
      hosts: { type: 'array', items: { type: 'string' }, description: 'Allowed hosts (repeatable `--host`).' },
      url: {
        type: 'string',
        description: 'Entry page forwarded to the CLI `--url`: `site.pages.home` becomes this real '
          + 'page instead of the example.com placeholder, and its host joins the allowed hosts.',
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
      'Hand one browser flow to AmberFlow so it can be recorded instead of hand-written: give the '
      + 'recorded action list plus the page it starts from, and the engine runs it once, induces each '
      + "step's completion signal and the end-state invariants from the observed transitions, and "
      + 'writes a **flow app** (`apps/<id>/app.mjs`) ONLY when a rules-only replay of the generated '
      + 'script with zero model calls still passes. The result reports that replay honestly, so a flow '
      + 'that cannot be reproduced is never reported as learned. A live demonstration is NOT available '
      + 'through a tool call — the engine records from a human on an interactive terminal and a tool '
      + 'call has none — so `script` is required. Needs a browser and the local decision runtime on the '
      + 'machine running the checkout.',
    parameters: {
      goal: { type: 'string', required: true, description: 'One line describing the flow to perform.' },
      url: { type: 'string', required: true, description: 'The http(s) page to start from.' },
      script: {
        type: 'string',
        required: true,
        description:
          'Path to the recorded action list: a JSON array of '
          + '{"op":"click"|"type","hint":"<selector hint>"[,"value":"…"][,"label":"…"]} entries. '
          + HINT_LEARN_NOTE + ' '
          + 'Required, and the only action source that works without a terminal.',
      },
      id: { type: 'string', description: 'App id to save under (defaults to a slug of host+goal).' },
      cdp: { type: 'string', description: 'CDP websocket URL of the browser to attach to; selects the browser, not the actions.' },
      headful: { type: 'boolean', description: 'Launch a visible browser for the recording (debug aid for a flaky flow).' },
      apps_dir: {
        type: 'string',
        description: 'Directory to write the flow app into (the CLI\'s `--apps-dir`). Defaults to '
        + 'the user-scope apps dir ($AMBERFLOW_HOME/apps, or ~/.amberflow/apps) — NOT inside the '
        + 'checkout. Recorded apps are user config; the checkout\'s apps/ are only development fixtures.',
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
}