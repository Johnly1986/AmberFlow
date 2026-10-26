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
  cliArgs, diagnoseFailure, flowRunArgs, learnArgs, listApps as listAppSummaries, parseJsonDocument,
  parseSource, planArgs, pruneRunDirs, runArgs, runProcess, summarizeFlow, summarizeLearn,
  summarizePlan, summarizeRun,
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
  /**
   * Visible browser window on the machine running the engine (pack and template runs alike).
   * The window is not in the caller's browser page: the deployment host needs a real display, or a
   * virtual one (`xvfb-run -a`) plus VNC/noVNC, for a human to see it.
   */
  headful?: boolean
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
  /** 分段运行：只跑第 N 步（1-based）。 */
  onlyStep?: number
  /** 分段运行：从第 N 步开始（1-based）。 */
  fromStep?: number
  /** 分段运行：本段最多几步。 */
  maxSteps?: number
  /** 结果里带逐步骤 trace。 */
  trace?: boolean
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
  /** Visible browser window on the engine host during the planning walk (engine `--headful`). */
  headful?: boolean
}

/**
 * What another plugin can call. Every method is the exact code path the corresponding tool runs.
 */
/** One CLI JSON envelope's data field (shape owned by the command, not the bridge). */
export type CliData = Record<string, any>

export interface AmberFlowInspectArgs {
  url: string
  maxElements?: number
  includeText?: boolean
  headful?: boolean
}

export interface AmberFlowOnlineArgs {
  action: 'list' | 'validate' | 'run'
  tier?: string
  case?: string
  site?: string
  headful?: boolean
  requireAll?: boolean
}

export interface AmberFlowCreateArgs {
  id: string
  goal?: string
  hosts?: string[]
}

export interface AmberFlowSetStepArgs {
  app: string
  index: number
  step: Record<string, unknown>
  hosts?: string[]
}

export interface AmberFlowRemoveStepArgs {
  app: string
  index: number
}

export interface AmberFlowSetInvariantArgs {
  app: string
  invariants: Array<Record<string, any>>
}

/** One `…_status` call: environment/model/browser facts, already masked by the CLI. */
export interface AmberFlowStatus {
  ok: boolean
  node: CliData
  chromium: CliData
  model: CliData
  provider: CliData
  llm: CliData
}

/** One `…_app_show` call: the declaration an Agent edits against. */
export interface AmberFlowAppDetail {
  app: string
  label: string
  goal: string
  path: string
  source: string
  mode?: string
  hosts: string[]
  slots: Record<string, any>
  required_slots: string[]
  journey: Array<Record<string, any>>
  invariants: Array<Record<string, any>>
  sites?: string[]
}

/** One `…_app_check` call. */
export interface AmberFlowAppCheck {
  ok: boolean
  checked: number
  results: Array<{ app: string; path: string; problems: string[] }>
}

/** One `…_inspect` call: bounded page observation. */
export interface AmberFlowInspect {
  ok: boolean
  url: string
  title: string
  elements: Array<Record<string, any>>
  element_count: number
  truncated: boolean
  text?: string
  screenshot_path?: string
}

/** One `…_online` call. */
export interface AmberFlowOnline {
  ok: boolean
  action: string
  tier?: string
  sites?: number
  cases?: number
  valid?: boolean
  passed?: number
  failed?: number
  skipped?: number
  evidence_dir?: string
  cases_detail?: Array<Record<string, any>>
  reason?: string
}

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
  /** Environment/model/browser status, no secrets. */
  status(): Promise<AmberFlowStatus>
  /** Full declaration of one app (steps/invariants/hosts). */
  appShow(app: string): Promise<AmberFlowAppDetail>
  /** Static validation of one app; no browser. */
  appCheck(app: string): Promise<AmberFlowAppCheck>
  /** Read-only page observation. */
  inspect(args: AmberFlowInspectArgs): Promise<AmberFlowInspect>
  /** List/validate/run the real-site suite. */
  online(args: AmberFlowOnlineArgs): Promise<AmberFlowOnline>
  /** Create a data-pack app skeleton. */
  createApp(args: AmberFlowCreateArgs): Promise<AmberFlowAppDetail>
  /** Atomically replace one journey step and validate. */
  setStep(args: AmberFlowSetStepArgs): Promise<AmberFlowAppDetail>
  /** Replace end-state invariants and validate. */
  setInvariant(args: AmberFlowSetInvariantArgs): Promise<AmberFlowAppDetail>
  /** Remove one journey step and validate. */
  removeStep(args: AmberFlowRemoveStepArgs): Promise<AmberFlowAppDetail>
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
      ...(args.allowDangerous === undefined ? {} : { dangerous: args.allowDangerous }),
      ...(args.headful === undefined ? {} : { headful: args.headful }),
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
    ...(args.headful === undefined ? {} : { headful: args.headful }),
    ...(args.allowDangerous === undefined ? {} : { dangerous: args.allowDangerous }),
    ...(args.confirmSafe === undefined ? {} : { confirmSafe: args.confirmSafe }),
    ...(args.tieredHint === undefined ? {} : { tieredHint: args.tieredHint }),
    ...(args.onlyStep === undefined ? {} : { onlyStep: args.onlyStep }),
    ...(args.fromStep === undefined ? {} : { fromStep: args.fromStep }),
    ...(args.maxSteps === undefined ? {} : { maxSteps: args.maxSteps }),
    trace: args.trace ?? true,
    manualFailFast: true,
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
    ...(args.headful === undefined ? {} : { headful: args.headful }),
  }))
  try {
    return summarizePlan(parseSource(outcome))
  } catch {
    throw new Error(diagnoseFailure(`${options.toolPrefix}_plan`, outcome))
  }
}

function record(value: unknown): CliData {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as CliData
    : {}
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

function records(value: unknown): CliData[] {
  return Array.isArray(value) ? value.map(record) : []
}

/** Run one `amber … --json` command and return its envelope. Throws only when the CLI emitted none. */
async function cliJson(options: BridgeOptions, args: string[]): Promise<CliData> {
  const outcome = await runProcess(options, cliArgs(options, args))
  const doc = parseJsonDocument(parseSource(outcome))
  if (doc === null) {
    throw new Error(diagnoseFailure('amber ' + args.join(' '), outcome))
  }
  return doc
}

function dataOf(doc: CliData): CliData {
  return record(doc['data'])
}

function ensureOk(doc: CliData, what: string): CliData {
  if (doc['ok'] === true) return doc
  const e = record(doc['error'])
  const msg = String(e['message'] ?? 'command failed')
  const hint = typeof e['hint'] === 'string' && e['hint'] !== '' ? `: ${e['hint']}` : ''
  throw new Error(`${what}: ${msg}${hint}`)
}

function detailOf(d: CliData): AmberFlowAppDetail {
  const pack = record(d['pack'])
  return {
    app: String(d['app'] ?? pack['id'] ?? ''),
    label: String(d['label'] ?? pack['label'] ?? ''),
    goal: String(d['goal'] ?? pack['goal'] ?? ''),
    path: String(d['path'] ?? ''),
    source: String(d['source'] ?? ''),
    ...(typeof d['mode'] === 'string' ? { mode: d['mode'] } : {}),
    hosts: strings(pack['hosts']),
    slots: record(pack['slots']),
    required_slots: strings(pack['required_slots']),
    journey: Array.isArray(pack['journey']) ? pack['journey'] : [],
    invariants: Array.isArray(pack['invariants']) ? pack['invariants'] : [],
    ...(Array.isArray(pack['sites']) ? { sites: strings(pack['sites']) } : {}),
  }
}

/** Environment/model/browser facts (doctor's JSON data). */
export async function status(options: BridgeOptions): Promise<AmberFlowStatus> {
  const doc = await cliJson(options, ['doctor', '--json'])
  const d = dataOf(doc)
  return {
    ok: doc['ok'] === true,
    node: record(d['node']),
    chromium: record(d['chromium']),
    model: record(d['model']),
    provider: record(d['provider']),
    llm: record(d['llm']),
  }
}

/** The full declaration of one app, for an Agent that wants to edit a step. */
export async function appShow(options: BridgeOptions, app: string): Promise<AmberFlowAppDetail> {
  const doc = await cliJson(options, ['apps', 'show', app, '--json'])
  ensureOk(doc, 'app_show')
  return detailOf(dataOf(doc))
}

/** Static validation of one app; no browser. */
export async function appCheck(options: BridgeOptions, app: string): Promise<AmberFlowAppCheck> {
  const doc = await cliJson(options, ['apps', 'check', app, '--json'])
  const d = dataOf(doc)
  return {
    ok: d['ok'] === true,
    checked: Number(d['checked'] ?? 0),
    results: records(d['results']).map((r) => ({
      app: String(r['app'] ?? ''),
      path: String(r['path'] ?? ''),
      problems: strings(r['problems']),
    })),
  }
}

/** Read-only page observation. */
export async function inspect(options: BridgeOptions, args: AmberFlowInspectArgs): Promise<AmberFlowInspect> {
  const argv = ['inspect', '--url', args.url, '--json']
  if (args.maxElements !== undefined) argv.push('--max-elements', String(args.maxElements))
  if (args.includeText === true) argv.push('--text')
  if (args.headful === true) argv.push('--headed')
  const doc = await cliJson(options, argv)
  const d = dataOf(doc)
  return {
    ok: doc['ok'] === true,
    url: String(d['url'] ?? args.url),
    title: String(d['title'] ?? ''),
    elements: records(d['elements']),
    element_count: Number(d['element_count'] ?? 0),
    truncated: d['truncated'] === true,
    ...(typeof d['text'] === 'string' ? { text: d['text'] } : {}),
    ...(typeof d['screenshot_path'] === 'string' ? { screenshot_path: d['screenshot_path'] } : {}),
  }
}

/** List/validate/run the real-site suite through the same CLI JSON contract. */
export async function online(options: BridgeOptions, args: AmberFlowOnlineArgs): Promise<AmberFlowOnline> {
  if (args.action === 'validate') {
    const doc = await cliJson(options, ['online', '--validate', '--json'])
    const d = doc
    return { ok: doc['ok'] === true, action: 'validate', sites: Number(d['sites'] ?? 0), cases: Number(d['cases'] ?? 0), valid: d['valid'] === true }
  }
  if (args.action === 'list') {
    const argv = ['online', '--list', '--json']
    if (args.tier !== undefined) argv.push('--tier', args.tier)
    const doc = await cliJson(options, argv)
    const d = doc
    return { ok: true, action: 'list', ...(typeof d['tier'] === 'string' ? { tier: d['tier'] } : {}), cases_detail: records(d['cases']) }
  }
  const argv = ['online', '--json']
  if (args.tier !== undefined) argv.push('--tier', args.tier)
  if (args.case !== undefined) argv.push('--case', args.case)
  if (args.site !== undefined) argv.push('--site', args.site)
  if (args.headful === true) argv.push('--headed')
  if (args.requireAll === true) argv.push('--require-all')
  const doc = await cliJson(options, argv)
  const d = doc
  const failed = Number(d['failed'] ?? 0)
  const skipped = Number(d['skipped'] ?? 0)
  return {
    ok: failed === 0 && (skipped === 0 || args.requireAll !== true),
    action: 'run',
    ...(typeof d['tier'] === 'string' ? { tier: d['tier'] } : {}),
    passed: Number(d['passed'] ?? 0),
    failed,
    skipped,
    ...(typeof d['evidence_dir'] === 'string' ? { evidence_dir: d['evidence_dir'] } : {}),
    cases_detail: records(d['cases']),
    ...(typeof d['reason'] === 'string' ? { reason: d['reason'] } : {}),
  }
}

/** Create a data-pack app skeleton (the only writable app form through the bridge). */
export async function createApp(options: BridgeOptions, args: AmberFlowCreateArgs): Promise<AmberFlowAppDetail> {
  const argv = ['apps', 'new', args.id, '--format', 'pack', '--json']
  if (args.goal !== undefined) argv.push('--goal', args.goal)
  for (const host of args.hosts ?? []) argv.push('--host', host)
  ensureOk(await cliJson(options, argv), 'app_create')
  return appShow(options, args.id)
}

/** Replace one journey step atomically; invalid input writes nothing. */
export async function setStep(options: BridgeOptions, args: AmberFlowSetStepArgs): Promise<AmberFlowAppDetail> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-amberflow-edit-'))
  const file = path.join(dir, 'step.json')
  try {
    fs.writeFileSync(file, JSON.stringify(args.step, null, 2), 'utf-8')
    const argv = ['apps', 'set-step', args.app, '--index', String(args.index), '--step-file', file, '--json']
    for (const host of args.hosts ?? []) argv.push('--host', host)
    ensureOk(await cliJson(options, argv), 'app_set_step')
    return appShow(options, args.app)
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/** Replace the end-state invariants; invalid input writes nothing. */
export async function setInvariant(options: BridgeOptions, args: AmberFlowSetInvariantArgs): Promise<AmberFlowAppDetail> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-amberflow-inv-'))
  const file = path.join(dir, 'invariants.json')
  try {
    fs.writeFileSync(file, JSON.stringify(args.invariants, null, 2), 'utf-8')
    ensureOk(await cliJson(options, ['apps', 'set-invariant', args.app, '--invariants-file', file, '--json']), 'app_set_invariant')
    return appShow(options, args.app)
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/** Remove one journey step (the app must keep at least one). */
export async function removeStep(options: BridgeOptions, args: AmberFlowRemoveStepArgs): Promise<AmberFlowAppDetail> {
  ensureOk(await cliJson(options, ['apps', 'remove-step', args.app, '--index', String(args.index), '--json']), 'app_remove_step')
  return appShow(options, args.app)
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
    status() { return status(options) },
    appShow(app) { return appShow(options, app) },
    appCheck(app) { return appCheck(options, app) },
    inspect(args) { return inspect(options, args) },
    online(args) { return online(options, args) },
    createApp(args) { return createApp(options, args) },
    setStep(args) { return setStep(options, args) },
    setInvariant(args) { return setInvariant(options, args) },
    removeStep(args) { return removeStep(options, args) },
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The AmberFlow bridge's programmatic seam, provided by `@deepseek-ai/dsh-amberflow-bridge`. */
    amberflow: AmberFlowService
  }
}
