/**
 * LayaWebUse bridge — the harness side of "the engine is called, not embedded".
 *
 * LayaWebUse is a frozen-plan browser engine: an LLM (or a human) authors a flow once, the engine
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
 * @module @deepseek-ai/dsh-layawebuse-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs'
import path from 'node:path'
import { listApps, type BridgeOptions } from './bridge.ts'
import { createService, runApp, learn, type LayawebuseService } from './service.ts'

// The package root is the consumer surface: another plugin imports these without reaching into `src/`
// (a published package ships only `lib/`).
export {
  learn, newOutDir, runApp,
  type LayawebuseLearnArgs, type LayawebuseRunArgs, type LayawebuseService,
} from './service.ts'
export {
  diagnoseFailure, firstLines, learnArgs, listApps, parseJsonDocument, parseSource, runArgs,
  runProcess, stripAnsi, summarizeLearn, summarizeRun,
  type AppSummary, type BridgeOptions, type LearnSummary, type PlanStep, type ProcessOutcome,
  type RunSummary,
} from './bridge.ts'

export const name = 'layawebuse-bridge'
export const inject = ['tools']

/** Deployment configuration for the bridge. */
export interface Config {
  /** Absolute path of the LayaWebUse checkout (the one holding `src/app-runner.ts`). Required. */
  repoPath: string
  /** Node binary used for the external CLI; defaults to the running interpreter. */
  nodeBin?: string
  /** Hard wall-clock cap per call, ms (default 15 min: live runs are slow by nature). */
  timeoutMs?: number
  /** Whether this deployment permits dangerous tool steps (`--allow-dangerous`, dry-run gated). */
  allowDangerous?: boolean
  /** Model-visible tool-name prefix (default `layawebuse`). */
  toolPrefix?: string
}

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  repoPath: z.string().required(),
  nodeBin: z.string().default(process.execPath),
  timeoutMs: z.natural().min(1000).default(900_000),
  allowDangerous: z.boolean().default(false),
  toolPrefix: z.string().default('layawebuse'),
})

/** Resolve defaults and verify the checkout really is one, at LOAD time rather than first call. */
function resolveOptions(config: Config): BridgeOptions {
  const repoPath = path.resolve(config.repoPath)
  const entry = path.join(repoPath, 'src', 'app-runner.ts')
  if (!fs.existsSync(entry)) {
    throw new Error(`layawebuse-bridge: ${repoPath} is not a LayaWebUse checkout (missing src/app-runner.ts)`)
  }
  const prefix = config.toolPrefix ?? 'layawebuse'
  if (!/^[a-z][a-z0-9_]*$/.test(prefix)) {
    throw new Error(`layawebuse-bridge: toolPrefix ${JSON.stringify(prefix)} must be lower_snake_case`)
  }
  return {
    repoPath,
    nodeBin: config.nodeBin ?? process.execPath,
    timeoutMs: config.timeoutMs ?? 900_000,
    allowDangerous: config.allowDangerous ?? false,
    toolPrefix: prefix,
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

  // Plugin-to-plugin door: another plugin injects `layawebuse` and calls the engine directly, running
  // exactly the code the tools run (same options, same gates, same diagnostics).
  const service: LayawebuseService = createService(options)
  ctx.provide('layawebuse', service)

  ctx.tools.register(defineTool({
    name: `${toolPrefix}_apps`,
    description:
      'List the browser/CLI apps declared in the LayaWebUse checkout, with their step counts, '
      + 'invariant counts and where each pack came from (generated from a spec/source, recorded from '
      + 'a demonstrated flow, hand-written, or a pure data source with no journey of its own). Reads '
      + 'the packs only: no browser, no model, no subprocess.',
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
                invariants: { type: 'integer', required: true },
                origin: { type: 'string', required: true },
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
            + `(${a.steps} browser + ${a.toolSteps} tool steps, `
            + `${a.invariants} invariants, ${a.origin})`).join('\n'),
      }],
    },
    execute(args) {
      const needle = (args.filter ?? '').toLowerCase()
      const apps = listApps(options.repoPath)
        .filter(a => !needle
          || a.id.toLowerCase().includes(needle)
          || a.label.toLowerCase().includes(needle)
          || a.goal.toLowerCase().includes(needle))
        .map(a => ({
          id: a.id, label: a.label, goal: a.goal,
          steps: a.steps, toolSteps: a.toolSteps, invariants: a.invariants, origin: a.origin,
        }))
      return Promise.resolve({ apps })
    },
  }))

  ctx.tools.register(defineTool({
    name: `${toolPrefix}_run`,
    description:
      'Run one declared LayaWebUse app end to end (data leg -> browser/tool steps -> end-state '
      + 'invariants) and return a compact summary: completion, the FAILED subgoals only, refusals, and '
      + 'invariant results. The full per-step table stays in the report file named by the result, read '
      + 'it with the read tool when you need the detail. `no_model` keeps the run rules-only (no model '
      + 'forward passes); `dry` expands the plan and returns it instead of executing anything, so it '
      + 'verifies nothing and writes no report. A non-zero exit with no artifact means the run never '
      + 'reached the verify stage; the cause is included.',
    parameters: {
      app: { type: 'string', required: true, description: 'The app id from `' + toolPrefix + '_apps`.' },
      dry: { type: 'boolean', description: 'Only expand the plan; do not open a browser or run tools.' },
      no_model: { type: 'boolean', description: 'Rules-only: never ask the local decision model.' },
      no_sources: { type: 'boolean', description: 'Skip the data leg (use already-available data).' },
      allow_dangerous: {
        type: 'boolean',
        description: 'Permit dangerous tool steps (dry-run gated). Requires the deployment to enable it.',
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
        },
      },
      render: (_args, value) => {
        if (value.dry) {
          return [{
            type: 'text',
            text: `DRY ${value.planSteps} step(s) expanded — nothing executed, nothing verified`
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
          throw new Error(`layawebuse-bridge: slot ${JSON.stringify(entry)} must be "key=value"`)
        }
        const key = entry.slice(0, at)
        // The CLI treats a repeated slot as a usage error; catching it here keeps the bridge from
        // silently dropping the first value before the CLI ever sees the duplicate.
        if (slots.has(key)) {
          throw new Error(`layawebuse-bridge: slot ${JSON.stringify(key)} was given more than once`)
        }
        slots.set(key, entry.slice(at + 1))
      }
      // The deployment gate lives in the shared call, so the service refuses it identically.
      const { summary } = await runApp(options, {
        app: args.app,
        ...(args.dry === undefined ? {} : { dry: args.dry }),
        ...(args.no_model === undefined ? {} : { noModel: args.no_model }),
        ...(args.no_sources === undefined ? {} : { noSources: args.no_sources }),
        ...(args.allow_dangerous === undefined ? {} : { allowDangerous: args.allow_dangerous }),
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
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: `${toolPrefix}_learn`,
    description:
      'Hand one browser flow to LayaWebUse so it can be recorded instead of hand-written: give the '
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
      pack_dir: {
        type: 'string',
        description: 'Directory to write the pack into. Defaults to <repo>/apps, i.e. inside the checkout itself.',
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
}
