/**
 * The programmatic seam: the same calls the tools make, exposed as a Cordis service so another
 * plugin calls the engine **without** going through the tool registry.
 *
 * One implementation, two doors — the tools are thin adapters over these functions, so a deployment
 * gate (the dangerous-step refusal) and the failure diagnostics cannot drift between "the model
 * called the tool" and "another plugin called the service".
 *
 * The app surface has exactly one format: `apps/<id>/app.mjs` with `meta` + `flow(ctx)`. Listing and
 * metadata come from the checkout's own `amber apps … --json` commands; the bridge adds no app
 * semantics of its own.
 * @module @deepseek-ai/dsh-amberflow-bridge/service
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cliArgs, diagnoseFailure, learnArgs, listApps as listAppSummaries, parseJsonDocument,
  parseSource, pruneRunDirs, runArgs, runProcess, summarizeLearn, summarizeRun,
  type AppSummary, type BridgeOptions, type JsonObject, type LearnSummary,
  type RunSummary,
} from './bridge.ts'

/** One `run` call, mirroring the `…_run` tool parameters with camelCase names. */
export interface AmberFlowRunArgs {
  /** App id from {@link AmberFlowService.listApps}. */
  app: string
  /** Only dry-run the flow's call sequence: no browser, no tools. */
  dry?: boolean
  /** Ablation arm (`stub` = scripted fake model, `rules-only` = no model at all). Omit for a real run. */
  ablate?: "stub" | "rules-only"
  /** Override the decision provider for this call (laya-onnx, decision-service, a baseline, or an ablation). */
  provider?: string
  /** Skip the data leg. */
  noSources?: boolean
  /**
   * Visible browser window on the machine running the engine.
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
   * P1 experiment switch (engine `--tiered-hint`): an ambiguous-in-tier target hint becomes a
   * SMALLER question to the model (it sees only that tier's candidates instead of the whole pool).
   * Off by default — behaviour byte-identical to before; used for A/B on live apps.
   */
  tieredHint?: boolean
  /**
   * Execution budget for this call (engine `--max-steps`), NOT a 1-based step index: the script runs
   * under its own control flow and stops with `budget_exceeded` when the budget is used up
   * (`status=partial`, `verified=false`).
   */
  maxSteps?: number
  /** Include per-step execution evidence in the result. Defaults to true for the bridge. */
  trace?: boolean
  /** Values for declared slots. */
  slots?: Record<string, string>
}

/** One `learn` call, mirroring the `…_learn` tool parameters with camelCase names. */
export interface AmberFlowLearnArgs {
  /** One line describing the flow to perform. */
  goal: string
  /** Page to start from (an http(s) URL or a repo-relative fixture path). */
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
  /** Directory to write the flow app into (the CLI's `--apps-dir`); defaults to the user-scope dir
   *  `$AMBERFLOW_HOME/apps` — recorded apps are user config, the checkout's `apps/` are development
   *  fixtures. */
  appsDir?: string
}

/** One CLI JSON envelope's data field (shape owned by the command, not the bridge). */
export type CliData = JsonObject

export interface AmberFlowInspectArgs {
  url: string
  maxElements?: number
  includeText?: boolean
  headful?: boolean
  /** Read-only CSS selector probes (E3): existence count + up to 5 text excerpts each. The
   *  element pool only carries actionable elements, so `exists`/`text` done signals over
   *  h1/.class had no verification surface through the bridge until now. */
  probes?: string[]
}

export interface AmberFlowTestArgs {
  action: 'list' | 'validate' | 'run'
  tier?: string
  case?: string
  site?: string
  headful?: boolean
  requireAll?: boolean
  maxSteps?: number
  timeoutSec?: number
}

export interface AmberFlowCreateArgs {
  id: string
  goal?: string
  hosts?: string[]
  /** Entry page forwarded to the CLI's `--url` (B4b): with it the skeleton's `site.pages.home`
   *  is the real page and hosts stays closed; without it the placeholder example.com skeleton. */
  url?: string
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

/** One `…_app_show` call: the flow app an Agent reads and edits as a file. */
export interface AmberFlowAppDetail {
  app: string
  label: string
  goal: string
  /** The ONE writable location: `…/apps/<id>/app.mjs`. */
  path: string
  /** `user` (user scope) or `built-in` (checkout fixture). */
  source: string
  /** Version anchors: the flow script's bytes, and the IR the loaded script lowers to. */
  script_sha256: string
  plan_sha256: string
  hosts: string[]
  slots: JsonObject
  required_slots: string[]
  /** Declared data sources (`meta.sources`). */
  sources: string[]
  invariants: JsonObject[]
  policy?: JsonObject
  pace?: JsonObject
  /** Current script source (`--code`); the Agent edits this file. */
  code?: string
  /** True when the CLI capped `code`; read `path` for the rest. */
  code_truncated?: boolean
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
  elements: JsonObject[]
  element_count: number
  truncated: boolean
  /** 空池诊断（planning-playbook）：主池近空而页面上交互元素多——重 JS SPA 的典型形态。 */
  pool_near_empty?: boolean
  /** 页面上 INTERACTIVE_ALL 的水合后读数（仅 pool_near_empty 时出现）。 */
  interactive_on_page?: number
  /** Read-only selector probe outcomes (E3): {selector, count, texts} or {selector, error}. */
  probes?: JsonObject[]
  text?: string
  screenshot_path?: string
}

/** One `…_online` call. */
export interface AmberFlowTest {
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
  cases_detail?: JsonObject[]
  reason?: string
}

export interface AmberFlowService {
  /**
   * List the flow apps the checkout can run (`amber apps list --json`).
   * @param filter - optional case-insensitive substring match on id, label or goal.
   * @returns the matching app summaries.
   */
  listApps(filter?: string): Promise<AppSummary[]>
  /**
   * Run one flow app end to end. The script's own control flow decides what runs; the engine decides
   * each step and its completion signal; end-state invariants are the pass/fail truth.
   * @param args - the app and its run options.
   * @returns the compact summary (failures only; the full table stays in the report file).
   */
  run(args: AmberFlowRunArgs): Promise<RunSummary>
  /**
   * Record one browser flow into a flow app (`app.mjs`), or fail honestly.
   * @param args - the goal, the page, and how the flow is demonstrated.
   * @returns the summary including the rules-only replay that gated the save.
   */
  learn(args: AmberFlowLearnArgs): Promise<LearnSummary>
  /** Environment/model/browser status, no secrets. */
  status(): Promise<AmberFlowStatus>
  /** Full declaration of one app: metadata, current source and version anchors. */
  appShow(app: string): Promise<AmberFlowAppDetail>
  /** Static validation of one app (load + dry call sequence); no browser. */
  appCheck(app: string): Promise<AmberFlowAppCheck>
  /** Read-only page observation. */
  inspect(args: AmberFlowInspectArgs): Promise<AmberFlowInspect>
  /** List/validate/run the real-site suite. */
  test(args: AmberFlowTestArgs): Promise<AmberFlowTest>
  /** Create a flow app skeleton (`amber apps new`); the only writable app form. */
  createApp(args: AmberFlowCreateArgs): Promise<AmberFlowAppDetail>
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
 * Run one flow app through the external engine CLI and summarize its artifacts.
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
  const outDir = newOutDir('run')
  pruneRunDirs(options.keepRuns)
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
    ...(args.maxSteps === undefined ? {} : { maxSteps: args.maxSteps }),
    trace: args.trace ?? true,
    manualFailFast: true,
    ...(args.slots === undefined ? {} : { slots: args.slots }),
  }))
  return { summary: summarizeRun(outDir, args.app, outcome, `${options.toolPrefix}_run`), outDir }
}

/**
 * Hand one flow to the engine for recording. The CLI prints its JSON document only on the paths that
 * produced a verdict, so a usage/environment failure is reported from its stderr instead of parsed.
 *
 * The recording is induced into a flow app (`app.mjs`) and written only when the rules-only replay
 * against the generated script passes; the summary reports that replay honestly.
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
    ...(args.appsDir === undefined ? {} : { appsDir: args.appsDir }),
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

function record(value: unknown): CliData {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as CliData
    : {}
}

/** Whether a JSON field is a plain object, for optional nested blocks (`policy`, `pace`). */
function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/**
 * Project `amber apps show --json --code` data into the model-facing detail.
 * @param d - the envelope's `data`.
 * @returns the app detail; optional fields stay absent when the CLI omitted them.
 */
function detailOf(d: CliData): AmberFlowAppDetail {
  const code = typeof d['code'] === 'string' ? d['code'] : undefined
  const truncated = d['code_truncated']
  return {
    app: String(d['app'] ?? ''),
    label: String(d['label'] ?? ''),
    goal: String(d['goal'] ?? ''),
    path: String(d['path'] ?? ''),
    source: String(d['source'] ?? ''),
    script_sha256: String(d['script_sha256'] ?? ''),
    plan_sha256: String(d['plan_sha256'] ?? ''),
    hosts: strings(d['hosts']),
    slots: record(d['slots']),
    required_slots: strings(d['required_slots']),
    sources: strings(d['sources']),
    invariants: records(d['invariants']),
    ...(isRecord(d['policy']) ? { policy: d['policy'] } : {}),
    ...(isRecord(d['pace']) ? { pace: d['pace'] } : {}),
    ...(code === undefined ? {} : { code }),
    ...(typeof truncated === 'boolean' ? { code_truncated: truncated } : {}),
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

/**
 * The full declaration of one app, including its current source: the Agent edits `path`, then asks
 * for this again to see the new version.
 */
export async function appShow(options: BridgeOptions, app: string): Promise<AmberFlowAppDetail> {
  const doc = await cliJson(options, ['apps', 'show', app, '--json', '--code'])
  ensureOk(doc, 'app_show')
  return detailOf(dataOf(doc))
}

/** Static validation of one app (load + dry call sequence); no browser. `slots` forward as `--slot k=v`. */
export async function appCheck(options: BridgeOptions, app: string, slots?: string[]): Promise<AmberFlowAppCheck> {
  const argv = ['apps', 'check', app, '--json']
  for (const s of slots ?? []) argv.push('--slot', s)
  const doc = await cliJson(options, argv)
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
  // E3 (已改待重启验证): forward the read-only selector probes the 02-round CLI added.
  for (const sel of args.probes ?? []) argv.push('--probe', sel)
  const doc = await cliJson(options, argv)
  const d = dataOf(doc)
  return {
    ok: doc['ok'] === true,
    url: String(d['url'] ?? args.url),
    title: String(d['title'] ?? ''),
    elements: records(d['elements']),
    element_count: Number(d['element_count'] ?? 0),
    truncated: d['truncated'] === true,
    ...(d['pool_near_empty'] === true
      ? { pool_near_empty: true, interactive_on_page: Number(d['interactive_on_page'] ?? 0) }
      : {}),
    ...(Array.isArray(d['probes']) && d['probes'].length ? { probes: records(d['probes']) } : {}),
    ...(typeof d['text'] === 'string' ? { text: d['text'] } : {}),
    ...(typeof d['screenshot_path'] === 'string' ? { screenshot_path: d['screenshot_path'] } : {}),
  }
}

/**
 * The test suite's payload: the unified envelope's `data` when the CLI wraps its answer (the
 * documented `--json` contract), or the raw document for the older unwrapped shape. One adapter
 * either way — the bridge never re-derives suite semantics.
 */
function testData(doc: CliData): CliData {
  return doc['data'] !== undefined ? dataOf(doc) : doc
}

/** List/validate/run the real-site suite through the same CLI JSON contract. */
export async function test(options: BridgeOptions, args: AmberFlowTestArgs): Promise<AmberFlowTest> {
  if (args.action === 'validate') {
    const doc = await cliJson(options, ['test', '--validate', '--json'])
    const d = testData(doc)
    return { ok: doc['ok'] === true, action: 'validate', sites: Number(d['sites'] ?? 0), cases: Number(d['cases'] ?? 0), valid: d['valid'] === true }
  }
  if (args.action === 'list') {
    const argv = ['test', '--list', '--json']
    if (args.tier !== undefined) argv.push('--tier', args.tier)
    const doc = await cliJson(options, argv)
    const d = testData(doc)
    return { ok: true, action: 'list', ...(typeof d['tier'] === 'string' ? { tier: d['tier'] } : {}), cases_detail: records(d['cases']) }
  }
  const argv = ['test', '--json']
  if (args.tier !== undefined) argv.push('--tier', args.tier)
  if (args.case !== undefined) argv.push('--case', args.case)
  if (args.site !== undefined) argv.push('--site', args.site)
  if (args.headful === true) argv.push('--headful')
  if (args.requireAll === true) argv.push('--require-all')
  if (args.maxSteps !== undefined) argv.push('--max-steps', String(args.maxSteps))
  if (args.timeoutSec !== undefined) argv.push('--timeout', String(args.timeoutSec))
  const doc = await cliJson(options, argv)
  const d = testData(doc)
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

/**
 * Create a flow app skeleton (`amber apps new <id> --json`). Only the flow skeleton is generated:
 * the Agent then edits the returned `path` itself, so the bridge never writes app code.
 */
export async function createApp(options: BridgeOptions, args: AmberFlowCreateArgs): Promise<AmberFlowAppDetail> {
  const argv = ['apps', 'new', args.id, '--json']
  if (args.goal !== undefined) argv.push('--goal', args.goal)
  for (const host of args.hosts ?? []) argv.push('--host', host)
  // B4b (已改待重启验证): the CLI's --url was never forwarded, so every bridge-created skeleton
  // landed on the example.com placeholder even when the agent knew the real entry page.
  if (args.url !== undefined && args.url !== '') argv.push('--url', args.url)
  ensureOk(await cliJson(options, argv), 'app_create')
  return appShow(options, args.id)
}

/**
 * Build the service for one deployment.
 * @param options - resolved bridge options.
 * @returns the service {@link apply} provides as `ctx.amberflow`.
 */
export function createService(options: BridgeOptions): AmberFlowService {
  return {
    listApps(filter) {
      return listAppSummaries(options, filter ?? '')
    },
    async run(args) {
      return (await runApp(options, args)).summary
    },
    learn(args) {
      return learn(options, args)
    },
    status() { return status(options) },
    appShow(app) { return appShow(options, app) },
    appCheck(app) { return appCheck(options, app) },
    inspect(args) { return inspect(options, args) },
    test(args) { return test(options, args) },
    createApp(args) { return createApp(options, args) },
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The AmberFlow bridge's programmatic seam, provided by `@deepseek-ai/dsh-amberflow-bridge`. */
    amberflow: AmberFlowService
  }
}