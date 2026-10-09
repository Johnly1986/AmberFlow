/**
 * The programmatic seam: the same calls the three tools make, exposed as a Cordis service so another
 * plugin calls the engine **without** going through the tool registry.
 *
 * One implementation, two doors — the tools are thin adapters over {@link runApp} / {@link learn}, so
 * a deployment gate (the dangerous-step refusal) and the failure diagnostics cannot drift between
 * "the model called the tool" and "another plugin called the service".
 * @module @deepseek-ai/dsh-layawebuse-bridge/service
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  diagnoseFailure, learnArgs, listApps as listAppSummaries, parseSource, pruneRunDirs,
  runArgs, runProcess, summarizeLearn, summarizeRun,
  type AppSummary, type BridgeOptions, type LearnSummary, type RunSummary,
} from './bridge.ts'

/** One `run` call, mirroring the `…_run` tool parameters with camelCase names. */
export interface LayawebuseRunArgs {
  /** App id from {@link LayawebuseService.listApps}. */
  app: string
  /** Only expand the plan: no browser, no tools. */
  dry?: boolean
  /** Rules-only: never ask the local decision model. */
  noModel?: boolean
  /** Skip the data leg. */
  noSources?: boolean
  /** Permit dangerous tool steps; refused unless the deployment set `allowDangerous`. */
  allowDangerous?: boolean
  /**
   * The engine's middle gate (`--confirm-safe`): with `allowDangerous`, destructive actions are
   * still confirmed per step against their dry-run evidence instead of blanket-approved.
   */
  confirmSafe?: boolean
  /** Values for declared slots. */
  slots?: Record<string, string>
}

/** One `learn` call, mirroring the `…_learn` tool parameters with camelCase names. */
export interface LayawebuseLearnArgs {
  /** One line describing the flow to perform. */
  goal: string
  /** Page to start from (a URL or a repo-relative fixture path). */
  url: string
  /**
   * A recorded action list — REQUIRED. It is the only workable action source for a programmatic
   * caller: the CLI's other source is a human demonstration in an interactive terminal, and the
   * bridge always runs it with `--yes` and no stdin.
   */
  script: string
  /** App id to save under; defaults to a slug of host+goal. */
  id?: string
  /** CDP websocket URL of the browser to attach to; chooses the browser, never the actions. */
  cdp?: string
  /** Launch a visible browser for the recording instead of headless (debug aid). */
  headful?: boolean
  /** Directory to write the pack into; defaults to `<repo>/apps`, i.e. inside the checkout. */
  packDir?: string
}

/**
 * What another plugin can call. Every method is the exact code path the corresponding tool runs.
 */
export interface LayawebuseService {
  /**
   * List the declared apps.
   * @param filter - optional case-insensitive substring match on id, label or goal.
   * @returns the matching app summaries.
   */
  listApps(filter?: string): AppSummary[]
  /**
   * Run one declared app end to end.
   * @param args - the app and its run options.
   * @returns the compact summary (failures only; the full table stays in the report file).
   */
  run(args: LayawebuseRunArgs): Promise<RunSummary>
  /**
   * Record one browser flow, or fail honestly.
   * @param args - the goal, the page, and how the flow is demonstrated.
   * @returns the summary including the rules-only replay that gated the save.
   */
  learn(args: LayawebuseLearnArgs): Promise<LearnSummary>
}

/** One temp run directory per call, so artifacts never collide between sessions. */
export function newOutDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-layawebuse-${tag}-`))
}

/**
 * Whether a value is a usable reference: a non-empty string. A plugin calling the service can be
 * plain JavaScript, so a field the TYPE marks required still needs a runtime guard.
 * @param value - the value to test.
 * @returns true when the value is a non-empty string.
 */
function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/**
 * Run one app through the external CLI and summarize its artifacts.
 * @param options - resolved bridge options.
 * @param args - the run arguments.
 * @returns the summary plus the directory the artifacts were written to.
 * @throws when the deployment forbids dangerous steps or the run produced no artifact.
 */
export async function runApp(
  options: BridgeOptions, args: LayawebuseRunArgs,
): Promise<{ summary: RunSummary; outDir: string }> {
  if (args.allowDangerous && !options.allowDangerous) {
    throw new Error(
      'layawebuse-bridge: this deployment does not permit dangerous tool steps; '
      + `set Config.allowDangerous=true to allow ${options.toolPrefix}_run with allow_dangerous`,
    )
  }
  const outDir = newOutDir('run')
  pruneRunDirs(options.keepRuns)
  const outcome = await runProcess(options, runArgs(options, {
    app: args.app,
    outDir,
    ...(args.dry === undefined ? {} : { dry: args.dry }),
    ...(args.noModel === undefined ? {} : { noModel: args.noModel }),
    ...(args.noSources === undefined ? {} : { noSources: args.noSources }),
    ...(args.allowDangerous === undefined ? {} : { dangerous: args.allowDangerous }),
    ...(args.confirmSafe === undefined ? {} : { confirmSafe: args.confirmSafe }),
    ...(args.slots === undefined ? {} : { slots: args.slots }),
  }))
  return { summary: summarizeRun(outDir, args.app, outcome, `${options.toolPrefix}_run`), outDir }
}

/**
 * Hand one flow to the engine. The CLI prints its JSON document only on the paths that produced a
 * verdict, so a usage/environment failure is reported from its stderr instead of being parsed.
 *
 * `script` is required, and that is a property of the wrapped CLI rather than a preference: its only
 * other action source is a human demonstration on an interactive terminal (`tools/learn.ts`), and a
 * tool call has neither a terminal nor stdin — the bridge always passes `--yes`, which switches the
 * recorder off. Refusing here, before spawning a browser, is what turns "always fails after a
 * minute" into a sentence the caller can act on.
 * @param options - resolved bridge options.
 * @param args - the learn arguments.
 * @returns the summary the `…_learn` tool renders, with `saved` resolved against the checkout.
 * @throws when no script was given, or when the CLI failed without a machine-readable answer.
 */
export async function learn(
  options: BridgeOptions, args: LayawebuseLearnArgs,
): Promise<LearnSummary> {
  // The type marks `script` required so a TypeScript caller cannot forget it; a JavaScript caller
  // still can, and must get the same sentence instead of a browser launch that fails a minute later.
  const script = args.script
  if (!isFilled(script)) {
    throw new Error(
      `layawebuse-bridge: ${options.toolPrefix}_learn needs a recorded action list — pass \`script\` `
      + '(a JSON array of {"op":"click"|"type","hint":"<selector>"} entries). The engine can also '
      + 'record from a live demonstration, but only in an interactive terminal, and every tool call '
      + 'runs the CLI with --yes and no stdin. `cdp` only picks the browser to attach to; it cannot '
      + 'supply the actions.',
    )
  }
  const outDir = newOutDir('learn')
  pruneRunDirs(options.keepRuns)
  const outcome = await runProcess(options, learnArgs(options, {
    url: args.url,
    goal: args.goal,
    outDir,
    script,
    ...(args.id === undefined ? {} : { id: args.id }),
    ...(args.cdp === undefined ? {} : { cdp: args.cdp }),
    ...(args.headful === undefined ? {} : { headful: args.headful }),
    ...(args.packDir === undefined ? {} : { packDir: args.packDir }),
  }))
  let summary: LearnSummary
  try {
    // The full stdout, not the display excerpt: a recorded flow's document grows with the step count
    // and a truncated document is not JSON.
    summary = summarizeLearn(parseSource(outcome))
  } catch {
    throw new Error(diagnoseFailure(`${options.toolPrefix}_learn`, outcome))
  }
  // The CLI reports `saved` relative to the checkout; hand back a path the caller can actually read.
  if (summary.saved === false) return summary
  return { ...summary, saved: path.resolve(options.repoPath, summary.saved) }
}

/**
 * Build the service for one deployment.
 * @param options - resolved bridge options.
 * @returns the service {@link apply} provides as `ctx.layawebuse`.
 */
export function createService(options: BridgeOptions): LayawebuseService {
  return {
    listApps(filter) {
      const needle = (filter ?? '').toLowerCase()
      return listAppSummaries(options.repoPath).filter(app => !needle
        || app.id.toLowerCase().includes(needle)
        || app.label.toLowerCase().includes(needle)
        || app.goal.toLowerCase().includes(needle))
    },
    async run(args) {
      return (await runApp(options, args)).summary
    },
    learn(args) {
      return learn(options, args)
    },
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The LayaWebUse bridge's programmatic seam, provided by `@deepseek-ai/dsh-layawebuse-bridge`. */
    layawebuse: LayawebuseService
  }
}
