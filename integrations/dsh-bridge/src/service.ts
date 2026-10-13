/**
 * The programmatic seam: the same calls the three tools make, exposed as a Cordis service so another
 * plugin calls the engine **without** going through the tool registry.
 *
 * One implementation, two doors — the tools are thin adapters over {@link runApp} / {@link learn}, so
 * a deployment gate (the dangerous-step refusal) and the failure diagnostics cannot drift between
 * "the model called the tool" and "another plugin called the service".
 * @module @deepseek-ai/dsh-amberflow-bridge/service
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  diagnoseFailure, flowRunArgs, learnArgs, listApps as listAppSummaries, parseSource, planArgs,
  pruneRunDirs, runArgs, runProcess, summarizeFlow, summarizeLearn, summarizePlan, summarizeRun,
  type AppSummary, type BridgeOptions, type LearnSummary, type PlanSummary, type RunSummary,
} from './bridge.ts'

/** One `run` call, mirroring the `…_run` tool parameters with camelCase names. */
export interface AmberFlowRunArgs {
  /** App id from {@link AmberFlowService.listApps}. */
  app: string
  /**
   * Semantic templates only: the site key to run against (see the app's `sites` in the listing).
   * A pack id with `site` is a usage error, and a semantic template without it is one too — the
   * doors are dispatched by the artifact on disk (`apps/<id>/flow.json`), not by the caller's guess.
   */
  site?: string
  /** Only expand the plan: no browser, no tools. */
  dry?: boolean
  /** Rules-only: never ask the local decision model. */
  /** 消融实验臂（`stub`=脚本桩，`rules-only`=不装模型）。**省略即真模型**——这是默认。 */
  ablate?: "stub" | "rules-only"
  /** 换决策提供者跑这一次（laya-onnx 默认 / 基线 / 自注册）。不透传则工具参数会静默失效。 */
  provider?: string
  /** Skip the data leg. */
  noSources?: boolean
  /** Permit dangerous tool steps; refused unless the deployment set `allowDangerous`. */
  allowDangerous?: boolean
  /**
   * The engine's middle gate (`--confirm-safe`): with `allowDangerous`, destructive actions are
   * still confirmed per step against their dry-run evidence instead of blanket-approved.
   */
  confirmSafe?: boolean
  /**
   * P1 experiment switch (engine `--tiered-hint`): an ambiguous-in-tier plan hint becomes a
   * SMALLER question to the model (it sees only that tier's candidates instead of the whole pool).
   * Off by default — behavior byte-identical to before; used for A/B on live packs.
   */
  tieredHint?: boolean
  /** Values for declared slots. */
  slots?: Record<string, string>
}

/** One `learn` call, mirroring the `…_learn` tool parameters with camelCase names. */
export interface AmberFlowLearnArgs {
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
  /** Directory to write the pack into; defaults to the user-scope dir `$AMBERFLOW_HOME/apps`
   *  — recorded apps are user config, the repo `apps/` are development fixtures. */
  packDir?: string
}

/** One `plan` call: goal + seed → v2 template + site profile, gated by a replay before writing. */
export interface AmberFlowPlanArgs {
  /** One sentence, exactly as the user said it (the engine extracts date/cities/intents from it). */
  goal: string
  /** Seed page: a repo-relative fixture path or a URL. */
  seed: string
  /** App id to write the template under (`apps/<id>/flow.json`). */
  app: string
  /** Site key for the profile; defaults to the seed's directory/host in the engine CLI. */
  site?: string
  /** Overwrite an existing template app (a re-plan); the engine's `--force`. */
  force?: boolean
  /**
   * Demonstrate the dangerous step (a purchase click) during the walk. Refused unless the
   * deployment set `allowDangerous` — on a real site, "demonstrate once" places a real order.
   */
  allowDangerous?: boolean
  /** Planner door: `llm` needs OPENAI_* in the environment; default is the engine's offline recipe. */
  planner?: 'scripted' | 'llm'
}

/**
 * What another plugin can call. Every method is the exact code path the corresponding tool runs.
 */
export interface AmberFlowService {
  /**
   * List the declared apps.
   * @param filter - optional case-insensitive substring match on id, label or goal.
   * @returns the matching app summaries.
   */
  listApps(filter?: string): AppSummary[]
  /**
   * Run one declared app end to end. Packs go through app-runner; a semantic template (its id owns
   * an `apps/<id>/flow.json`) goes through the SemanticFlow door and needs a `site`.
   * @param args - the app and its run options.
   * @returns the compact summary (failures only; the full table stays in the report file).
   */
  run(args: AmberFlowRunArgs): Promise<RunSummary>
  /**
   * Record one browser flow, or fail honestly.
   * @param args - the goal, the page, and how the flow is demonstrated.
   * @returns the summary including the rules-only replay that gated the save.
   */
  learn(args: AmberFlowLearnArgs): Promise<LearnSummary>
  /**
   * Plan a semantic flow from one sentence: look at the pages, induce each step's completion signal
   * from two reproducible demonstrations, and write template + site profile ONLY when the replay
   * gate passes. A failed gate writes nothing and says so.
   * @param args - the goal, the seed page, and the app id.
   * @returns the plan summary (status, steps with signal provenance, written paths).
   */
  plan(args: AmberFlowPlanArgs): Promise<PlanSummary>
}

/** One temp run directory per call, so artifacts never collide between sessions. */
export function newOutDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-amberflow-${tag}-`))
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
  options: BridgeOptions, args: AmberFlowRunArgs,
): Promise<{ summary: RunSummary; outDir: string }> {
  if (args.allowDangerous && !options.allowDangerous) {
    throw new Error(
      'amberflow-bridge: this deployment does not permit dangerous tool steps; '
      + `set Config.allowDangerous=true to allow ${options.toolPrefix}_run with allow_dangerous`,
    )
  }
  // The doors are dispatched by what is on disk (apps/<id>/flow.json), not by the caller's guess —
  // the same "load-time beats first-call" discipline as resolving the checkout.
  const isFlow = fs.existsSync(path.join(options.repoPath, 'apps', args.app, 'flow.json'))
  const outDir = newOutDir('run')
  pruneRunDirs(options.keepRuns)
  if (isFlow) {
    if (args.noSources !== undefined || args.confirmSafe !== undefined) {
      throw new Error(
        `amberflow-bridge: ${args.app} is a semantic template — no_sources/confirm_safe belong to `
        + 'pack apps (a template has no data leg; its irreversible gate is allow_dangerous).',
      )
    }
    if (!isFilled(args.site)) {
      throw new Error(
        `amberflow-bridge: ${args.app} is a semantic template (site-agnostic) — pass \`site\`, one `
        + `of its declared sites (see ${options.toolPrefix}_apps). Migrating to a new site: run `
        + `${options.toolPrefix}_plan against it first, or run without a profile and let the `
        + 'backfill ring learn one.',
      )
    }
    const outcome = await runProcess(options, flowRunArgs(options, {
      app: args.app, site: args.site, outDir,
      ...(args.dry === undefined ? {} : { dry: args.dry }),
      ...(args.ablate === undefined ? {} : { ablate: args.ablate }),
    ...(args.provider === undefined ? {} : { provider: args.provider }),
      ...(args.provider === undefined ? {} : { provider: args.provider }),
      ...(args.allowDangerous === undefined ? {} : { dangerous: args.allowDangerous }),
      ...(args.slots === undefined ? {} : { slots: args.slots }),
    }))
    return { summary: summarizeFlow(outDir, args.app, args.site, outcome), outDir }
  }
  if (isFilled(args.site)) {
    throw new Error(
      `amberflow-bridge: \`site\` applies only to semantic templates (apps/${args.app}/flow.json); `
      + `${args.app} is a pack app and runs against the sites frozen in its own pack.`,
    )
  }
  const outcome = await runProcess(options, runArgs(options, {
    app: args.app,
    outDir,
    ...(args.dry === undefined ? {} : { dry: args.dry }),
    ...(args.ablate === undefined ? {} : { ablate: args.ablate }),
    ...(args.provider === undefined ? {} : { provider: args.provider }),
    ...(args.noSources === undefined ? {} : { noSources: args.noSources }),
    ...(args.allowDangerous === undefined ? {} : { dangerous: args.allowDangerous }),
    ...(args.confirmSafe === undefined ? {} : { confirmSafe: args.confirmSafe }),
    ...(args.tieredHint === undefined ? {} : { tieredHint: args.tieredHint }),
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
  options: BridgeOptions, args: AmberFlowLearnArgs,
): Promise<LearnSummary> {
  // The type marks `script` required so a TypeScript caller cannot forget it; a JavaScript caller
  // still can, and must get the same sentence instead of a browser launch that fails a minute later.
  const script = args.script
  if (!isFilled(script)) {
    throw new Error(
      `amberflow-bridge: ${options.toolPrefix}_learn needs a recorded action list — pass \`script\` `
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
 * Plan one semantic flow from a goal + seed. `--json --yes` is what makes it a single machine
 * call: the interactive door (per-step y/n) does not exist for a tool. The engine's own gates do
 * the rest: no dangerous-step demonstration without `allowDangerousDemo`, and no file written
 * unless the replay gate passes — so a failed plan is a RESULT (`status: failed`), not a crash.
 * @param options - resolved bridge options.
 * @param args - the plan arguments.
 * @returns the summary with absolute written paths (empty strings when nothing was written).
 * @throws when the CLI died without any machine-readable document (usage/env failure).
 */
export async function plan(
  options: BridgeOptions, args: AmberFlowPlanArgs,
): Promise<PlanSummary> {
  if (args.allowDangerous && !options.allowDangerous) {
    throw new Error(
      'amberflow-bridge: this deployment does not permit demonstrating the dangerous step during '
      + `planning; set Config.allowDangerous=true to allow ${options.toolPrefix}_plan with `
      + 'allow_dangerous (fixtures/sandboxes only)',
    )
  }
  // The plan writes into the checkout's apps/, not into a per-call artifact dir — no outDir here.
  pruneRunDirs(options.keepRuns)
  const outcome = await runProcess(options, planArgs(options, {
    goal: args.goal, seed: args.seed, app: args.app,
    ...(isFilled(args.site) ? { site: args.site } : {}),
    ...(args.force === undefined ? {} : { force: args.force }),
    ...(args.allowDangerous === undefined ? {} : { dangerousDemo: args.allowDangerous }),
    ...(args.planner === undefined ? {} : { planner: args.planner }),
  }))
  try {
    return summarizePlan(parseSource(outcome))
  } catch {
    throw new Error(diagnoseFailure(`${options.toolPrefix}_plan`, outcome))
  }
}

/**
 * Build the service for one deployment.
 * @param options - resolved bridge options.
 * @returns the service {@link apply} provides as `ctx.amberflow`.
 */
export function createService(options: BridgeOptions): AmberFlowService {
  return {
    listApps(filter) {
      const needle = (filter ?? '').toLowerCase()
      return listAppSummaries(options.repoPath, options.appsEnv).filter(app => !needle
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
    plan(args) {
      return plan(options, args)
    },
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The AmberFlow bridge's programmatic seam, provided by `@deepseek-ai/dsh-amberflow-bridge`. */
    amberflow: AmberFlowService
  }
}
