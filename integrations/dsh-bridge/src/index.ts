/**
 * AmberFlow bridge — the harness side of "the engine is called, not embedded".
 *
 * AmberFlow is a frozen-plan browser engine: an LLM (or a human) authors a flow once, the engine
 * decides every step locally, and **DOM signals are the only completion truth**. It already exposes
 * that engine as CLIs (`app-runner`, `learn`). This plugin turns those CLIs into model-facing tools
 * so a DSH session can drive them — and it deliberately adds **no browser logic of its own**:
 *
 * - `…_apps`  — list declared apps by reading `apps/<id>/pack.json` (no subprocess, no browser).
 * - `…_run`   — run a declared app and return a compact summary of its artifacts.
 * - `…_learn` — hand over "goal + page" once: the engine records the flow, induces the completion
 *               signals and the end-state invariants, and only saves the pack when a **rules-only
 *               replay with zero model calls** passes.
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
import { formatRequires, formatTypeMix, listApps, normalizeDecisionEndpoint, type BridgeOptions } from './bridge.ts'
import { createService, runApp, learn, plan, type AmberFlowService } from './service.ts'

// The package root is the consumer surface: another plugin imports these without reaching into `src/`
// (a published package ships only `lib/`).
export {
  learn, newOutDir, runApp, plan,
  type AmberFlowLearnArgs, type AmberFlowPlanArgs, type AmberFlowRunArgs, type AmberFlowService,
} from './service.ts'
export {
  buildEnv, diagnoseFailure, firstLines, flowRunArgs, formatRequires, formatTypeMix, learnArgs,
  listApps, parseJsonDocument,
  parseSource, planArgs, pruneRunDirs, runArgs, runProcess, stepAdapter, stripAnsi,
  summarizeFlow, summarizeLearn, summarizePlan, summarizeRun,
  type AppSummary, type BridgeOptions, type LearnSummary, type PlanStep, type PlanSummary,
  type ProcessOutcome, type RunSummary,
} from './bridge.ts'

export const name = 'amberflow-bridge'
export const inject = ['tools']

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
   * Override for the USER-scope apps dir root (`$AMBERFLOW_HOME`, listed as `$AMBERFLOW_HOME/apps`
   * before the checkout's fixture `apps/`). Tests pin this to a non-existent path so a developer's
   * own recorded apps can never leak into a listing assertion.
   */
  appsHome?: string
  /**
   * Online **decision model** endpoint (token-plan SystemOne provider).
   *
   * These three fields are the ONLY `.volatile()` fields in this Config, so the plugin's
   * configuration page (`plugins.row.config`) shows exactly them. They are forwarded to the engine
   * child process as `TOKEN_PLAN_ENDPOINT` / `TOKEN_PLAN_API_KEY` / `TOKEN_PLAN_MODEL`, and when the
   * URL + token are both set the bridge defaults runs to the `token-plan` decision provider.
   * Empty means "not configured": runs keep the local ONNX decision model (or rules-only).
   */
  modelBaseUrl?: Volatile<string>
  /** Bearer token for {@link modelBaseUrl}. Secret: the settings surface never reads it back. */
  modelApiKey?: Volatile<string | undefined>
  /** Decision model id (`TOKEN_PLAN_MODEL`; empty = the provider's default, `decision-model-preview`). */
  modelName?: Volatile<string>
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
  // volatile fields). They configure the ONLINE DECISION MODEL (token-plan SystemOne): URL is
  // normalized to the /systemone endpoint, token/key/model become TOKEN_PLAN_* for the engine CLI,
  // and a fully configured pair makes app runs default to the `token-plan` provider.
  modelBaseUrl: z.string().default('').volatile(),
  // No schema default: the settings secret-presence marker is `value !== undefined`, so a default
  // would make an unset token read as "configured" in the configuration page.
  modelApiKey: z.string().role('secret').volatile(),
  modelName: z.string().default('').volatile(),
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
    // Auto-select the online decision provider only when the endpoint AND token are both present:
    // a half-configured page must not break runs that otherwise work on the local model.
    ...(normalizeDecisionEndpoint(volatileValue(config.modelBaseUrl) ?? '').trim() !== ''
      && (volatileValue(config.modelApiKey) ?? '').trim() !== ''
      ? { decisionProvider: 'token-plan' as const }
      : {}),
    ...(config.appsHome === undefined ? {} : { appsEnv: { ...process.env, AMBERFLOW_HOME: config.appsHome } }),
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
  // The plugin ships its own configuration page (the three model fields), so the generic settings
  // page must not also generate one for this entry. Optional service: a deployment without Settings
  // keeps working (page simply absent).
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
      'List the browser/CLI apps declared in the AmberFlow checkout, with their step counts, '
      + 'invariant counts and where each pack came from (generated from a spec/source, recorded from '
      + 'a demonstrated flow, hand-written, or a pure data source with no journey of its own). '
      + 'Each row carries a kind: `journey` apps run under the run tool; `probe` apps are measurement '
      + 'sets the engine refuses to run through the app runner (read their declaration only); '
      + '`data-source` rows feed other packs; `semantic-template` rows (flow.json) are site-agnostic '
      + 'SemanticFlow templates — run them with the run tool plus one of their listed `sites`, and '
      + 'grow a new site\'s profile with the plan tool. A journey may MIX application types '
      + '(web/cli/ssh/stdio): each row lists its type mix (e.g. `web×2 · cli×3 · ssh×1`) and any '
      + 'local service the app needs at run time (e.g. ssh needs a reachable local sshd) — check '
      + 'that before spending a run. Reads the packs only: no browser, no model, no subprocess.',
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
                steps: { type: 'integer', required: true },
                toolSteps: { type: 'integer', required: true },
                types: { type: 'string', required: true, description: 'Adapter type mix of the journey, e.g. `web×2 · cli×3 · ssh×1` (empty for data sources).' },
                requires: { type: 'array', required: true, items: { type: 'string' }, description: 'Local services needed at run time (e.g. `ssh` needs a local sshd).' },
                invariants: { type: 'integer', required: true },
                origin: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                hosts: { type: 'array', required: true, items: { type: 'string' } },
                sites: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.apps.length === 0
          ? 'No apps matched.'
          : value.apps.map(a => `${a.id}${a.label === '' || a.label === a.id ? '' : ` — ${a.label}`} `
            + `(${a.steps} browser + ${a.toolSteps} tool steps`
            + `${a.types ? ` [${a.types}]` : ''}, `
            + `${a.invariants} invariants, ${a.origin}, kind=${a.kind}`
            + `${a.hosts.length ? `, hosts: ${a.hosts.join(',')}` : ''}`
            + `${a.requires.length ? `, needs local: ${a.requires.map(x => formatRequires([x])).join(', ')}` : ''}`
            + `${a.sites && a.sites.length ? `, sites: ${a.sites.join(',')}` : ''})`).join('\n'),
      }],
    },
    execute(args) {
      const needle = (args.filter ?? '').toLowerCase()
      const apps = listApps(options.repoPath, options.appsEnv)
        .filter(a => !needle
          || a.id.toLowerCase().includes(needle)
          || a.label.toLowerCase().includes(needle)
          || a.goal.toLowerCase().includes(needle))
        .map(a => ({
          id: a.id, label: a.label, goal: a.goal,
          steps: a.steps, toolSteps: a.toolSteps,
          types: formatTypeMix(a.types),
          requires: a.requires,
          invariants: a.invariants, origin: a.origin,
          kind: a.kind, hosts: a.hosts,
          ...(a.sites === undefined ? {} : { sites: a.sites }),
        }))
      return Promise.resolve({ apps })
    },
  }))

  ctx.tools.register(defineTool({
    name: `${toolPrefix}_run`,
    description:
      'Run one declared AmberFlow app end to end (data leg -> browser/tool steps -> end-state '
      + 'invariants) and return a compact summary: completion, the FAILED subgoals only, refusals, '
      + 'invariant results, and a `model: on|off(missing)` tier line saying whether the local '
      + 'decision model was in play at all — plus the per-step decision tally (rule vs laya vs '
      + 'reobserve vs cache). The full per-step table stays in the report file named by the result, '
      + 'read it with the read tool when you need the detail. `ablate` runs an ABLATION arm (scripted stub, or no '
      + 'forward passes); `dry` expands the plan and returns it instead of executing anything, so it '
      + 'verifies nothing and writes no report. Semantic templates (`kind=semantic-template` in the '
      + 'apps listing) additionally REQUIRE `site` and report a resolution-level tally line '
      + '(rule/laya/escalate/backfill counts). A non-zero exit with no artifact means the run never '
      + 'reached the verify stage; the cause is included.',
    parameters: {
      app: { type: 'string', required: true, description: 'The app id from `' + toolPrefix + '_apps`.' },
      site: {
        type: 'string',
        description: 'Semantic templates only: one of the site keys listed by `' + toolPrefix
          + '_apps`. Pack apps must not pass it.',
      },
      dry: { type: 'boolean', description: 'Only expand the plan; do not open a browser or run tools.' },
      ablate: { type: 'string', enum: ['stub', 'rules-only'], description: 'ABLATION EXPERIMENT ONLY. `stub` installs a scripted fake model; `rules-only` runs with no model at all. Omit for a normal run (the real decision model is the default).' },
      provider: { type: 'string', description: 'Which decision provider to run on: laya-onnx (default), scripted-stub, none, or a baseline (first-candidate | coin-flip | always-abstain) / any registered provider. Use baselines to measure whether a model beats zero-intelligence search.' },
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
        description: 'P1 experiment: when the plan\'s target_hint resolves to an ambiguous tier, '
          + 'the model is asked a SMALLER question (only that tier\'s candidates, not the whole pool). '
          + 'Off by default — behavior identical to before; use it for A/B runs.',
      },
      slots: {
        type: 'array',
        description: 'Values for declared slots, as "key=value" entries (e.g. ["date=2026-10-12"]).',
        items: { type: 'string' },
      },
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
          planSteps: { type: 'integer', required: true },
          plan: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                kind: { type: 'string', required: true },
                desc: { type: 'string', required: true },
              },
            },
          },
          reportPath: { type: 'string', required: true },
          timedOut: { type: 'boolean', required: true },
          stdoutTail: { type: 'string', required: true },
          // Semantic-flow runs only: the rule/laya/escalate/backfill tally line, and the learned
          // site profile the backfill ring wrote (when it wrote one).
          line: { type: 'string' },
          profilePath: { type: 'string' },
          // Pack runs: which tier executed (`on` / `off(missing)` / `off(rules-only)` /
          // `off(scripted)`), and the decision-source tally. Absent only on older artifacts.
          model: { type: 'string' },
          // Multi-type journeys: the declared type mix and local services the app needs (e.g. ssh).
          // Present only when the pack declares more than one adapter kind / a local requirement.
          types: { type: 'string' },
          requires: { type: 'array', items: { type: 'string' } },
          decisions: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.dry) {
          return [{
            type: 'text',
            text: `DRY ${value.planSteps} step(s) expanded — nothing executed, nothing verified`
              + (value.model ? ` (model tier: ${value.model})` : '')
              + (value.plan.length
                ? `:\n${value.plan.map(s => `${s.index}. [${s.kind}] ${s.desc}`).join('\n')}`
                : ''),
          }]
        }
        const named = value.blockedTotal + value.failedTools.length + value.refused.length
        // A run can also stop without a failed step to name — killed at the timeout, or a non-zero
        // exit the artifact does not reflect — so say that rather than printing a bare FAIL.
        const stopped = !value.ok && named === 0
          ? value.timedOut
            ? '; stopped: timed out'
            : value.exitCode === undefined ? '' : `; stopped: exit ${value.exitCode}`
          : ''
        return [{
          type: 'text',
          text: `${value.ok ? 'PASS' : 'FAIL'} ${value.completed}`
            + `; invariants ${value.invariants.held}/${value.invariants.total}`
            + (value.blockedTotal ? `; blocked ${value.blockedTotal}: `
              + value.blocked.map(b => `${b.desc} (${b.obstacle})`).join(' | ') : '')
            + (value.failedTools.length ? `; tool steps failed: ${value.failedTools.join(' | ')}` : '')
            + (value.refused.length ? `; not executed: ${value.refused.join(', ')}` : '')
            + stopped
            + (value.line ? `; ${value.line}` : '')
            + (value.model ? `; model: ${value.model}` : '')
            + (value.types ? `; types: ${value.types}` : '')
            + (value.requires && value.requires.length
              ? `; needs local: ${value.requires.map(x => formatRequires([x])).join(', ')}` : '')
            + (value.decisions ? `\ndecisions: ${value.decisions}` : '')
            + (value.reportPath ? `\nreport: ${value.reportPath}` : '\nno report was written')
            + (value.profilePath ? `\nprofile: ${value.profilePath}` : ''),
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
      // The listing is filesystem-only; read the declared type mix/requirements from it so a
      // capability-gated app (e.g. ssh without sshd) is interpretable in the run summary itself.
      let declared: { types: Record<string, number>; requires: string[] } | null = null
      try {
        const row = listApps(options.repoPath, options.appsEnv).find(a => a.id === args.app)
        declared = row === undefined ? null : { types: row.types, requires: row.requires }
      } catch { declared = null }
      // The deployment gate lives in the shared call, so the service refuses it identically.
      const { summary } = await runApp(options, {
        app: args.app,
        ...(args.site === undefined ? {} : { site: args.site }),
        ...(args.dry === undefined ? {} : { dry: args.dry }),
        ...(args.ablate === undefined ? {} : { ablate: args.ablate }),
        ...(args.provider === undefined ? {} : { provider: args.provider }),
        ...(args.no_sources === undefined ? {} : { noSources: args.no_sources }),
        ...(args.headful === undefined ? {} : { headful: args.headful }),
        ...(args.allow_dangerous === undefined ? {} : { allowDangerous: args.allow_dangerous }),
        ...(args.confirm_safe === undefined ? {} : { confirmSafe: args.confirm_safe }),
        ...(args.tiered_hint === undefined ? {} : { tieredHint: args.tiered_hint }),
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
        planSteps: summary.planSteps,
        plan: summary.plan,
        reportPath: summary.reportPath,
        timedOut: summary.timedOut,
        stdoutTail: summary.stdoutTail,
        ...(summary.line === undefined ? {} : { line: summary.line }),
        ...(summary.profilePath === undefined ? {} : { profilePath: summary.profilePath }),
        ...(summary.model === undefined ? {} : { model: summary.model }),
        ...(summary.decisions === undefined ? {} : { decisions: summary.decisions }),
        ...(declared === null || Object.keys(declared.types).length <= 1
          ? {} : { types: formatTypeMix(declared.types) }),
        ...(declared === null || declared.requires.length === 0
          ? {} : { requires: declared.requires }),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: `${toolPrefix}_learn`,
    description:
      'Hand one browser flow to AmberFlow so it can be recorded instead of hand-written: give the '
      + 'recorded action list plus the page it starts from, and the engine runs it once, induces each '
      + "step's completion signal and the end-state invariants from the observed transitions, and "
      + 'saves the pack ONLY when a rules-only replay with zero model calls still passes. The result '
      + 'reports that replay honestly, so a flow that cannot be reproduced is never reported as learned. '
      + 'A live demonstration is NOT available through a tool call — the engine records from a human '
      + 'on an interactive terminal and a tool call has none — so `script` is required. Needs a browser '
      + 'and the local decision runtime on the machine running the checkout.',
    parameters: {
      goal: { type: 'string', required: true, description: 'One line describing the flow to perform.' },
      url: { type: 'string', required: true, description: 'The page to start from (a URL or a repo-relative fixture path).' },
      script: {
        type: 'string',
        required: true,
        description:
          'Path to the recorded action list: a JSON array of '
          + '{"op":"click"|"type","hint":"<selector hint>"[,"value":"…"][,"label":"…"]} entries. '
          + 'Required, and the only action source that works without a terminal.',
      },
      id: { type: 'string', description: 'App id to save under (defaults to a slug of host+goal).' },
      cdp: { type: 'string', description: 'CDP websocket URL of the browser to attach to; selects the browser, not the actions.' },
      headful: { type: 'boolean', description: 'Launch a visible browser for the recording (debug aid for a flaky flow).' },
      pack_dir: {
        type: 'string',
        description: 'Directory to write the pack into. Defaults to the user-scope apps dir '
        + '($AMBERFLOW_HOME/apps, or ~/.amberflow/apps) — NOT inside the checkout. '
        + 'Recorded apps are user config; the repo\'s apps/ are only development fixtures.',
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
          saved: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.status}: ${value.app} (${value.steps} steps) — rules-only replay: `
          + `${value.completed}, ${value.invariants}, ${value.forwards} model call(s); `
          + (value.saved ? `saved to ${value.saved}` : 'NOT saved'),
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
        ...(args.pack_dir === undefined ? {} : { packDir: args.pack_dir }),
      })
      return {
        status: summary.status,
        app: summary.app,
        steps: summary.steps,
        verified: summary.verified,
        forwards: summary.forwards,
        completed: summary.completed,
        invariants: summary.invariants,
        ...(summary.saved ? { saved: summary.saved } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: `${toolPrefix}_plan`,
    description:
      'Turn ONE sentence plus a seed page into a site-agnostic SemanticFlow template (spec_version 2 '
      + 'flow.json) plus that site\'s profile: the engine looks at each page as it walks the flow, '
      + 'proposes each step semantically (no selectors in the template), executes it through the same '
      + 'decision ladder the run tool uses, and INDUCES each step\'s completion signal from TWO '
      + 'independent demonstrations (discriminating + reproducible, or the plan stops instead of '
      + 'guessing). Page-role filenames, query parameter names, fill bindings and row extraction are '
      + 'observed into the SITE PROFILE; learned hints are NOT written here (the run-time backfill '
      + 'ring earns those on the first real runs). The template + profile are written ONLY when a '
      + 'replay gate — compiling and running the whole journey — passes; a failed gate writes nothing '
      + 'and reports the blocked steps. Re-running with an existing app id plans the SAME template '
      + 'onto a new site (migration: only the new site\'s profile is produced). Needs a browser; '
      + 'pass `planner: "llm"` for the LLM planner (requires OPENAI_* env), default is the offline '
      + 'goal-recipe planner. A dangerous step (purchase) is never demonstrated unless this '
      + 'deployment allows dangerous actions AND the caller passes allow_dangerous — on a real site '
      + 'a demo click is a real order.',
    parameters: {
      goal: {
        type: 'string', required: true,
        description: 'The user sentence, as said ("订一张5月18日昆明到北京价格最低的机票") — '
          + 'the engine extracts date/cities/intents into the slot bag; values never come from prose later.',
      },
      seed: {
        type: 'string', required: true,
        description: 'Seed page: a repo-relative path (semantic/site-a/index.html) or a URL.',
      },
      app: { type: 'string', required: true, description: 'App id to write apps/<id>/flow.json under.' },
      site: {
        type: 'string',
        description: 'Site key for the profile; defaults to the seed\'s directory name (file) or host (http).',
      },
      force: { type: 'boolean', description: 'Overwrite an existing brand-new template app id (a re-plan).' },
      headful: { type: 'boolean', description: 'Watch the planning walk in a VISIBLE browser window. '
        + 'The window opens on the machine running the engine (needs a display there, or `xvfb-run -a` '
        + 'with VNC/noVNC), not in this browser page. Default false (headless).' },
      planner: {
        type: 'string', enum: ['scripted', 'llm'],
        description: 'Planner door: `llm` needs OPENAI_* on the machine running the checkout; '
          + 'the default offline recipe covers goal-shaped flows on fixtures/sandboxes.',
      },
      allow_dangerous: {
        type: 'boolean',
        description: 'Demonstrate the dangerous step (purchase click) during the walk. Deployment-'
          + 'gated; fixtures/sandboxes only.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          app: { type: 'string', required: true },
          site: { type: 'string', required: true },
          steps: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                desc: { type: 'string', required: true },
                signal_source: { type: 'string', required: true },
              },
            },
          },
          gate: { type: 'string', required: true },
          templatePath: { type: 'string', required: true },
          profilePath: { type: 'string', required: true },
          error: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'planned'
          ? `PLANNED ${value.app} @ ${value.site}: ${value.steps.length} step(s), gate: ${value.gate}`
            + `\ntemplate: ${value.templatePath}\nprofile: ${value.profilePath}`
            + (value.steps.some(s => s.signal_source === 'contract')
              ? '\n(steps with signal_source=contract carry only the page-role URL fact)' : '')
          : `NOT planned (${value.app} @ ${value.site}) — nothing was written: ${value.error}`,
      }],
    },
    async execute(args) {
      const summary = await plan(options, {
        goal: args.goal,
        seed: args.seed,
        app: args.app,
        ...(args.site === undefined ? {} : { site: args.site }),
        ...(args.force === undefined ? {} : { force: args.force }),
        ...(args.planner === undefined ? {} : { planner: args.planner }),
        ...(args.headful === undefined ? {} : { headful: args.headful }),
        ...(args.allow_dangerous === undefined ? {} : { allowDangerous: args.allow_dangerous }),
      })
      return {
        status: summary.status,
        ok: summary.ok,
        app: summary.app,
        site: summary.site,
        steps: summary.steps,
        gate: summary.gate,
        templatePath: summary.templatePath,
        profilePath: summary.profilePath,
        error: summary.error,
      }
    },
  }))
}
