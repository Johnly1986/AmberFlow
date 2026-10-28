/**
 * Pure helpers behind the AmberFlow bridge: build the argv for the external CLIs, read the
 * artifacts they write, and summarize them into a **context-cheap** shape.
 *
 * No spawning happens here beyond `runProcess` / `listApps`, so the process policy lives in exactly
 * one place and everything else stays unit-testable without a browser, a model, or the external repo.
 *
 * The app surface has exactly ONE author model: `apps/<id>/app.mjs` with `meta` + `flow(ctx)`. Apps
 * are listed through the checkout's own `amber apps list --json` door; the bridge never scans the
 * apps directory or interprets app source itself.
 * @module @deepseek-ai/dsh-amberflow-bridge/bridge
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/**
 * A JSON value, structurally identical to the harness's own `JsonValue` so tool outputs (and the
 * schemas they are checked against) line up without importing the host package's internals.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject

/** A JSON object (a CLI envelope, an artifact, one tool-output record). */
export interface JsonObject { [key: string]: JsonValue }

/** Resolved deployment options (defaults already applied). */
export interface BridgeOptions {
  /** Absolute path of the AmberFlow checkout that owns `src/app/app-runner.ts`. */
  repoPath: string
  /** Node binary used to run the CLI (defaults to the running interpreter). */
  nodeBin: string
  /** Hard wall-clock cap for one bridge call. */
  timeoutMs: number
  /** Whether this deployment permits `--allow-dangerous` (dry-run-gated tool steps). */
  allowDangerous: boolean
  /** Model-visible tool-name prefix. */
  toolPrefix: string
  /**
   * How the engine child process gets its environment. `inherit` (the default) forwards everything,
   * which is what a deployment trusting the checkout expects; `allowlist` forwards only the keys a
   * CLI run actually needs (PATH/HOME/certs/proxies/playwright) plus AMBERFLOW_*, so session
   * secrets never reach the external process.
   */
  envMode: 'inherit' | 'allowlist'
  /** Extra environment variable names forwarded in `allowlist` mode (exact keys, no glob). */
  forwardEnv: string[]
  /**
   * Unified **decision service** (System One protocol) configured through the plugin's
   * configuration page — the only fields that page exposes (URL / key / model name). Empty strings
   * mean "not configured": runs keep their normal decision plane (local ONNX, or rules-only).
   *
   * These values are forwarded to the engine child process as the unified
   * `AMBERFLOW_DECISION_BASE_URL` / `_API_KEY` / `_MODEL` keys (never into argv, results or logs),
   * and when URL + key are both set the bridge defaults app runs to the `decision-service`
   * provider — the same three-key configuration the engine CLI's `amber config set` writes.
   */
  decisionModel: {
    /** Full SystemOne endpoint (`…/compatible-mode/v1/systemone`), normalized from the page's URL. */
    endpoint: string
    /** Bearer token for that endpoint. Write-only in the UI; never read back. */
    apiKey: string
    /** Decision model id (`AMBERFLOW_DECISION_MODEL`, e.g. `decision-model-preview`). */
    model: string
  }
  /** Provider a run defaults to when the decision model is fully configured. */
  decisionProvider?: 'decision-service'
  /**
   * Extra environment entries merged into the child process that lists apps — a deployment-level
   * `AMBERFLOW_HOME` override (`Config.appsHome`), so the listing resolves the same user scope every
   * other bridge call would. Undefined means "use the deployment's own environment".
   */
  appsEnv?: NodeJS.ProcessEnv
  /**
   * Per-call artifact directories are kept because the result names a report inside them; this caps
   * how many of the newest `dsh-amberflow-*` temp directories survive. 0 disables pruning.
   */
  keepRuns: number
  /**
   * Absolute path of tsx's `dist/cli.mjs` when the checkout lives under a `node_modules` tree.
   * Node's own `--experimental-strip-types` refuses such paths (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING),
   * so the engine CLI is launched through tsx, which forwards the flags and handles the file.
   */
  tsxCli?: string
}

/** One declared app, as the bridge presents it to the model. */
export interface AppSummary {
  id: string
  label: string
  goal: string
  /** Absolute path of the writable flow script (`…/apps/<id>/app.mjs`). */
  path: string
  /** Where the app came from: `user` (user scope) or `built-in` (checkout fixtures). */
  source: string
  /** The only app format there is: a flow script (`meta` + `flow(ctx)`). */
  kind: 'flow'
  /**
   * Static script steps. Always 0: a flow script has no step table, its steps are runtime facts
   * produced by `ctx.step` / `ctx.arrive` / `ctx.run` as the script executes.
   */
  steps: 0
  /** Declared end-state invariants (script `meta.invariants`). */
  invariants: number
  /** Hosts the app is allowed to touch. */
  hosts: string[]
  /** Load/validation problem the CLI reported while listing; absent when the app loaded cleanly. */
  error?: string
}

/** A process result, with the output bounded so one call cannot flood the session. */
export interface ProcessOutcome {
  code: number | null
  /** Bounded excerpt of stdout (head + tail) — the only form a summary may surface. */
  stdout: string
  /**
   * The COMPLETE stdout, kept because parsing needs it: a dry-run call sequence or a `learn`
   * document can be larger than the excerpt window, and a truncated JSON document does not parse —
   * which would turn a successful call into "no document found". Never surfaced to the model.
   *
   * Optional so a caller that only ever reads the excerpt can omit it; the parsers then fall back to
   * {@link stdout}, which is correct for small documents and degrades to the old behaviour otherwise.
   */
  stdoutFull?: string
  stderr: string
  timedOut: boolean
}

/** Characters of each end of a child process's output one call keeps — enough to diagnose, small
 * enough to keep in context. */
const HEAD = 1200
const TAIL = 800
/** Cap on how many failed subgoals/invariants one summary lists. */
const MAX_FAILURES = 6
/** Lines of diagnostics one failure message keeps. */
const DIAGNOSTIC_LINES = 6
/** Cap on how many steps/calls one summary lists (a dry invocation sequence is a full list). */
const MAX_STEPS = 20
/** How long 'close' may lag 'exit' before the outcome settles anyway, ms (see runProcess). */
const STDIO_GRACE_MS = 1000

/**
 * Keep BOTH ends: a CLI that fails typically prints the cause FIRST and its usage block LAST, so a
 * tail-only window shows the usage and hides the reason (observed with `learn` on a missing page).
 * The cut is by UTF-16 code unit, so a boundary inside a surrogate pair can leave a lone surrogate
 * in this display-only excerpt — the full text in {@link ProcessOutcome.stdoutFull} is untouched.
 * @param text - the process output.
 * @returns the head and tail with an elision marker between them.
 */
const excerpt = (text: string): string =>
  (text.length <= HEAD + TAIL ? text : `${text.slice(0, HEAD)}\n…\n${text.slice(-TAIL)}`)

/** Strip ANSI colour/CSI escapes so a CLI's diagnostics read as text. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/**
 * The text a parser reads: the complete stdout when the caller supplied it, otherwise the excerpt.
 * A caller that only ever displays output may omit `stdoutFull`; parsing then degrades to the old
 * bounded behaviour instead of crashing.
 * @param outcome - the finished process.
 * @returns the text to parse.
 */
export function parseSource(outcome: ProcessOutcome): string {
  return outcome.stdoutFull ?? outcome.stdout
}

/**
 * The first lines of a process's diagnostics, ANSI-stripped, stopping at the usage block. The cause
 * is at the top and `usage:` introduces instructions rather than a reason, so everything from that
 * line on is dropped instead of being shown as if it were the failure.
 * @param text - one stream's output, unexcerpted or excerpted.
 * @returns at most {@link DIAGNOSTIC_LINES} non-empty lines, bounded in length.
 */
export function firstLines(text: string): string {
  const lines = stripAnsi(text).split('\n').map(line => line.trimEnd())
  const usage = lines.findIndex(line => /^usage:/i.test(line.trim()))
  return (usage < 0 ? lines : lines.slice(0, usage))
    .filter(line => line.trim() !== '')
    .slice(0, DIAGNOSTIC_LINES)
    .join('\n')
    .slice(0, 600)
}

/**
 * Read a JSON field as text without ever handing a non-primitive to `String()` (which would produce
 * `[object Object]`): anything that is not a string/number/boolean falls back instead.
 * @param value - the parsed field.
 * @param fallback - returned for a missing or non-primitive field.
 * @returns the field as text.
 */
function asText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

/**
 * Read a JSON field as a number.
 * @param value - the parsed field.
 * @param fallback - returned for a missing or non-finite field.
 * @returns the field as a number.
 */
function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Read a JSON field as an object, so nested documents can be walked without casts at every use.
 * @param value - the parsed field.
 * @returns the object, or null when the field is missing or not a plain object.
 */
function asRecord(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null
}

/**
 * Read a JSON field as a list of objects, so every walk over CLI output stays total.
 * @param value - the parsed field.
 * @returns the object entries, or an empty array.
 */
function asRecords(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((v): v is JsonObject => typeof v === 'object' && v !== null)
    : []
}

/**
 * Read a JSON field as a list of strings; non-strings are dropped rather than stringified into
 * `[object Object]` entries.
 * @param value - the parsed field.
 * @returns the string entries, or an empty array.
 */
function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).filter((v): v is string => typeof v === 'string') : []
}

/**
 * The balanced-brace slice starting at `start`, aware of string literals and escapes.
 * @param stream - the text to slice.
 * @param start - index of the opening brace.
 * @returns the slice ending at the matching close, or null when it never closes.
 */
function balancedSlice(stream: string, start: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < stream.length; i += 1) {
    const ch = stream.charAt(i)
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) return stream.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Parse the last JSON document a stream carries.
 *
 * Both CLIs write non-JSON to stdout before their document — the executor logs its step lines, and a
 * page label can contain a brace — so "parse from the first `{`" breaks on real output. The document
 * itself is printed by `JSON.stringify(value, null, 2)`, i.e. its outer brace sits in column 0, while
 * nested objects and log noise do not. This takes the last column-0 candidate that is balanced and
 * parses, which also tolerates trailing text after the document.
 * @param stdout - the process output.
 * @returns the parsed object, or null when the stream carries no JSON object.
 */
export function parseJsonDocument(stdout: string): JsonObject | null {
  let found: JsonObject | null = null
  for (let at = stdout.indexOf('{'); at >= 0; at = stdout.indexOf('{', at + 1)) {
    if (at !== 0 && stdout.charAt(at - 1) !== '\n') continue
    const slice = balancedSlice(stdout, at)
    if (slice === null) continue
    try {
      const doc: unknown = JSON.parse(slice)
      if (typeof doc === 'object' && doc !== null && !Array.isArray(doc)) {
        found = doc as JsonObject
      }
    } catch {
      // Not a document starting here; keep looking for the real one.
    }
  }
  return found
}

/**
 * The `error` field of a CLI JSON envelope as one sentence (message + hint + next steps).
 * @param doc - the parsed envelope.
 * @returns a human-readable failure sentence.
 */
function envelopeError(doc: JsonObject): string {
  const error = asRecord(doc['error'])
  const message = asText(error?.['message'], 'command failed')
  const hint = asText(error?.['hint'])
  const next = error === null || !Array.isArray(error['next'])
    ? []
    : (error['next'] as unknown[]).map(String).filter(x => x !== '')
  const extras = [hint, next.length === 0 ? '' : `next: ${next.join(', ')}`].filter(x => x !== '')
  return extras.length === 0 ? message : `${message} (${extras.join('; ')})`
}

/**
 * List the apps the checkout can run, through its own JSON door: `amber apps list --json`.
 *
 * This is the ONE app view: the CLI owns discovery and app loading (importing user-scope scripts is
 * the established trust boundary), so the bridge neither scans `apps/` nor interprets app source.
 * Listing starts no browser and calls no model.
 * @param options - resolved bridge options (names the checkout and the tool prefix).
 * @param filter - optional case-insensitive substring match on id, label or goal.
 * @returns one summary per app, sorted by id.
 * @throws when the CLI produced no envelope, or answered with a failed one.
 */
export async function listApps(options: BridgeOptions, filter = ''): Promise<AppSummary[]> {
  const outcome = await runProcess(options, cliArgs(options, ['apps', 'list', '--json']), options.appsEnv)
  const doc = parseJsonDocument(parseSource(outcome))
  if (doc === null) {
    const cause = firstLines(outcome.stderr) || firstLines(outcome.stdout)
    throw new Error(
      `amberflow-bridge: ${options.toolPrefix}_apps could not list apps — `
      + `\`amber apps list --json\` produced no JSON envelope `
      + `(${outcome.timedOut ? 'timed out' : `exit ${outcome.code ?? 'killed'}`})`
      + (cause === '' ? '' : `: ${cause}`),
    )
  }
  if (doc['ok'] !== true) {
    throw new Error(`amberflow-bridge: ${options.toolPrefix}_apps failed: ${envelopeError(doc)}`)
  }
  const data = asRecord(doc['data'])
  const rows = data === null ? [] : asRecords(data['apps'])
  const needle = filter.trim().toLowerCase()
  const out: AppSummary[] = []
  for (const row of rows) {
    const id = asText(row['id'])
    if (id === '') continue
    const label = asText(row['label'], id)
    const goal = asText(row['goal'])
    if (needle !== ''
      && !id.toLowerCase().includes(needle)
      && !label.toLowerCase().includes(needle)
      && !goal.toLowerCase().includes(needle)) continue
    const problem = asText(row['error'])
    out.push({
      id,
      label,
      goal,
      path: asText(row['path']),
      source: asText(row['source'], 'user'),
      kind: 'flow',
      steps: 0,
      invariants: asNumber(row['invariants'], 0),
      hosts: asStrings(row['hosts']),
      ...(problem === '' ? {} : { error: problem }),
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * The argv for one app-runner invocation. The external CLI is the contract, so the flags are
 * assembled here (and asserted in tests) instead of being strung together at the call site.
 *
 * `--max-steps` is an **execution budget**, not a step index: the script runs under its own control
 * flow and stops with `budget_exceeded` when the budget is used up.
 * @param options - resolved bridge options.
 * @param args - the model-facing call arguments.
 * @returns argv including the node binary as element 0.
 */
export function runArgs(
  options: BridgeOptions,
  args: {
    app: string
    outDir: string
    dry?: boolean
    ablate?: "stub" | "rules-only"
    provider?: string
    noSources?: boolean
    dangerous?: boolean
    /**
     * Visible browser window for this run (engine `--headful`). The window appears on the machine
     * running the engine — the deployment host, not the caller's browser page — so it needs a real
     * display there, or a virtual one (`xvfb-run -a`) plus VNC/noVNC to actually be seen.
     */
    headful?: boolean
    /** Ask the engine to refuse destructive actions per dry-run evidence (middle gate). */
    confirmSafe?: boolean
    /** P1 experiment: narrowed model question for an ambiguous-in-tier hint (engine `--tiered-hint`). */
    tieredHint?: boolean
    /** Execution budget for this call (engine `--max-steps`), not a 1-based step selector. */
    maxSteps?: number
    trace?: boolean
    manualFailFast?: boolean
    slots?: Record<string, string>
  },
): string[] {
  const argv = [options.nodeBin, ...(options.tsxCli !== undefined ? [options.tsxCli] : []), '--experimental-strip-types', path.join(options.repoPath, 'src', 'app', 'app-runner.ts')]
  argv.push('--app', args.app, '--out', args.outDir)
  if (args.dry) argv.push('--dry')
  if (args.headful) argv.push('--headful')
  if (args.ablate) argv.push('--ablate', String(args.ablate))
  // An explicitly requested provider wins; otherwise a fully configured decision model makes the
  // run use the online provider. Ablation arms are explicit experiments, so they never get the
  // default provider (they measure a different plane).
  const provider = args.provider ?? (args.ablate === undefined ? options.decisionProvider : undefined)
  if (provider !== undefined) argv.push('--provider', String(provider))
  if (args.noSources) argv.push('--no-sources')
  if (args.dangerous) argv.push('--allow-dangerous')
  if (args.confirmSafe) argv.push('--confirm-safe')
  if (args.tieredHint) argv.push('--tiered-hint')
  if (args.maxSteps !== undefined) argv.push('--max-steps', String(args.maxSteps))
  if (args.trace) argv.push('--trace')
  if (args.manualFailFast) argv.push('--manual-fail-fast')
  for (const [key, value] of Object.entries(args.slots ?? {})) argv.push('--slot', `${key}=${value}`)
  return argv
}

/**
 * The argv for one `learn` invocation: the recorded-flow door. `--json --yes` is what makes it a
 * single machine call instead of an interactive demo. The recording is induced into a flow app
 * (`app.mjs`); nothing is written unless the replay gate passes. `--apps-dir` names where that app
 * lands (the CLI's `--pack-dir` is only a legacy alias).
 * @param options - resolved bridge options.
 * @param args - the model-facing call arguments.
 * @returns argv including the node binary as element 0.
 */
export function learnArgs(
  options: BridgeOptions,
  args: { url?: string; goal?: string; id?: string; cdp?: string; script?: string; appsDir?: string; outDir: string; headful?: boolean },
): string[] {
  const argv = [options.nodeBin, ...(options.tsxCli !== undefined ? [options.tsxCli] : []), '--experimental-strip-types', path.join(options.repoPath, 'tools', 'learn.ts'), '--json', '--yes']
  if (args.url) argv.push('--url', args.url)
  if (args.goal) argv.push('--goal', args.goal)
  if (args.id) argv.push('--id', args.id)
  if (args.cdp) argv.push('--cdp', args.cdp)
  if (args.script) argv.push('--script', args.script)
  if (args.appsDir) argv.push('--apps-dir', args.appsDir)
  if (args.headful) argv.push('--headful')
  argv.push('--out', args.outDir)
  return argv
}

/** Environment keys an engine CLI run actually needs in `allowlist` mode. Everything the spawned
 * process must NOT see (session API keys and the rest) is dropped unless named in `forwardEnv`. */
const ENV_BASE = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'PLAYWRIGHT_BROWSERS_PATH',
]
const ENV_PROXY = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy']

/**
 * Unified decision-service environment variables (`src/model/decision-service.ts`):
 * service address, bearer key, and model id. One map so tests can pin the contract.
 */
export const DECISION_ENV = {
  endpoint: 'AMBERFLOW_DECISION_BASE_URL',
  apiKey: 'AMBERFLOW_DECISION_API_KEY',
  model: 'AMBERFLOW_DECISION_MODEL',
} as const

/**
 * Normalize the URL typed on the configuration page into the engine's SystemOne endpoint.
 * The page asks for the OpenAI-compatible base URL (for example
 * `https://host/compatible-mode/v1`); the decision provider needs the `/systemone` suffix.
 * A value that already names the SystemOne endpoint is kept as-is.
 * @param baseUrl - the page's model URL.
 * @returns the endpoint, or `''` when unset.
 */
export function normalizeDecisionEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed === '') return ''
  return /\/systemone$/i.test(trimmed) ? trimmed : `${trimmed}/systemone`
}

/**
 * Translate the plugin's decision-model configuration into child-process environment entries.
 * Unset fields are omitted, so a deployment that configures nothing keeps inheriting env vars.
 * @param decision - the resolved decision-model section of the bridge options.
 * @returns environment entries to merge into the child environment.
 */
export function decisionEnv(decision: BridgeOptions['decisionModel'] | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  if (decision === undefined) return env
  if (decision.endpoint !== '') env[DECISION_ENV.endpoint] = decision.endpoint
  if (decision.apiKey !== '') env[DECISION_ENV.apiKey] = decision.apiKey
  if (decision.model !== '') env[DECISION_ENV.model] = decision.model
  return env
}

/**
 * The environment for one engine child process.
 * @param options - resolved bridge options (env mode + explicit forward list).
 * @returns a fresh env object for `spawn`.
 */
export function buildEnv(options: BridgeOptions): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = (() => {
    if (options.envMode === 'inherit') return { ...process.env }
    const env: NodeJS.ProcessEnv = {}
    const wanted = [...ENV_BASE, ...ENV_PROXY, ...options.forwardEnv]
    for (const key of wanted) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    // Deployment-level overrides for the engine itself (repo path, model hints, timeouts) travel by
    // name, and AMBERFLOW_* stays forwardable so a checkout configured by env keeps working.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('AMBERFLOW_')) env[key] = process.env[key]
    }
    return env
  })()
  // The configuration page is explicit user intent, so it wins over whatever the environment
  // policy forwarded above (including in `inherit` mode). Empty fields add nothing.
  Object.assign(out, decisionEnv(options.decisionModel))
  return out
}

/**
 * Run one child process with a hard timeout and bounded output.
 *
 * The bridge spawns a **foreign** process, so this deliberately does not pretend to inherit the
 * harness sandbox policy: a deployment that enables this plugin is trusting `repoPath`.
 * @param options - resolved bridge options.
 * @param argv - full argv (element 0 is the binary).
 * @param envOverride - extra entries merged over the deployment environment (used to point the
 *   listing at a configured `AMBERFLOW_HOME`).
 * @returns the exit code (null when killed), bounded stdout/stderr, and whether the timeout fired.
 */
export function runProcess(
  options: BridgeOptions,
  argv: string[],
  envOverride?: NodeJS.ProcessEnv,
): Promise<ProcessOutcome> {
  const [bin, ...args] = argv
  if (bin === undefined || bin === '') {
    return Promise.reject(new Error('runProcess: argv must name a binary'))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.repoPath,
      env: { ...buildEnv(options), ...(envOverride ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let grace: NodeJS.Timeout | undefined
    // Decode through a StringDecoder: `chunk.toString('utf-8')` corrupts a multi-byte character that
    // straddles two chunks (this engine's output is largely Chinese), silently inserting U+FFFD.
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      if (grace !== undefined) clearTimeout(grace)
      clearTimeout(timer)
      stdout += stdoutDecoder.end()
      stderr += stderrDecoder.end()
      resolve({ code, stdout: excerpt(stdout), stdoutFull: stdout, stderr: excerpt(stderr), timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { stdout += stdoutDecoder.write(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr += stderrDecoder.write(chunk) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (grace !== undefined) clearTimeout(grace)
      clearTimeout(timer)
      reject(new Error(`cannot run ${argv[0]}: ${error.message}`))
    })
    child.on('exit', (code) => {
      // A grandchild that inherited the pipes keeps the streams open, so 'close' can lag 'exit'
      // indefinitely. Settle on a short grace instead: the wall-clock cap has to stay a cap.
      grace = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        finish(code)
      }, STDIO_GRACE_MS)
    })
    child.on('close', (code) => { finish(code) })
  })
}

/** One step (or one dry-run call) in the compact, model-facing run view. */
export interface RunStep {
  index: number
  desc: string
  /** `done` / `blocked` / `failed` / `refused` for executed steps; `ok` / `failed` for dry calls. */
  status: string
  /** Stable author anchor (`ctx.step(..., { id })`); absent when the step had none. */
  id?: string
  /** Which `ctx` call produced this row (`open` / `step` / `arrive` / `done` / `run`); dry runs only. */
  call?: string
  /** Page the call acted from; dry runs only. */
  url?: string
  /** How the engine resolved the step (browser steps, when the artifact records it). */
  method?: string
  stop_code?: string
  obstacle?: string
}

/** The compact, model-facing view of one app run. */
export interface RunSummary {
  /**
   * The run both completed and verified: exit 0, no blocked subgoal, no unfinished tool step, no
   * failed invariant. A dry run reports true because the expansion itself succeeded — it has verified
   * nothing, which is what `dry` says.
   */
  ok: boolean
  /** Process exit code, `null` when it was killed (the timeout path). */
  exitCode: number | null
  /** True when `--dry` only expanded the flow's call sequence: nothing ran and nothing was verified. */
  dry: boolean
  completed: string
  /** Failed subgoals only — the full per-step table lives in the report file. */
  blocked: { desc: string; obstacle: string }[]
  blockedTotal: number
  refused: string[]
  /**
   * Tool steps that failed WITHOUT being refused. They force `ok:false` exactly like a blocked
   * subgoal does, so a summary that omitted them would report a failure with no stated cause.
   */
  failedTools: string[]
  invariants: { held: number; total: number; failed: string[] }
  /** 本次运行的模型可见状态：passed/partial/failed/blocked/dry/needs_human。 */
  status?: string
  /** 完整旅程 + 不变量成立；分段/停止/dry 为 false。 */
  verified?: boolean
  /** 本次只跑了分段（max_steps 预算用满）。 */
  partial?: boolean
  /** 固定结果 JSON 的路径；Agent 需要详细步骤时读它。 */
  resultPath?: string
  /** 有界的逐步骤视图（失败/完成都可读）；dry 运行是调用序列。 */
  steps?: RunStep[]
  /** 第一个失败步骤的结构化原因。 */
  failure?: { step: number; desc: string; stop_code?: string; obstacle?: string }
  outDir: string
  /** The report to read, or '' when the run wrote none (a dry run, or one killed before it did). */
  reportPath: string
  stdoutTail: string
  timedOut: boolean
  /**
   * Which tier the run executed on — **`on` is the default and the only normal one** (real ONNX
   * model in place); `off(missing)` means the artifacts are absent, so the rules ladder did
   * everything a rule could and model-needed steps blocked honestly; `off(ablation:stub)` /
   * `off(ablation:rules-only)` mark an explicit **ablation arm** (`ablate`), i.e. an experiment
   * that answers "what happens without this layer" — never a routine way to run.
   * Absent only for artifacts written by older engines: no line rather than a guess.
   */
  model?: string
  /**
   * The decision-source tally (`rule 19 · laya 1 (conf 0.31) · laya:reobserve 1 · cache 6/12`)
   * from the engine's `decisions.line` — model appearances in one string, so a plugin user can
   * SEE the ladder working instead of reading step logs. Absent for older artifacts.
   */
  decisions?: string
}

/**
 * Prune this bridge's old per-call temp directories (`dsh-amberflow-*`).
 *
 * A run's report must outlive the call — that is why the directories exist — but they must not grow
 * without bound. This keeps the newest `keep` directories and never touches one younger than
 * `minAgeMs` (a slow run's directory is still a live directory). Best-effort: a failed stat or
 * removal is ignored — housekeeping never breaks the call it follows.
 * @param keep - how many newest directories to retain; 0 or below disables pruning.
 * @param minAgeMs - minimum age before a beyond-quota directory may be removed.
 * @returns how many directories were removed.
 */
export function pruneRunDirs(keep: number, minAgeMs = 3_600_000, root = os.tmpdir()): number {
  if (keep <= 0) return 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return 0
  }
  const dirs = entries
    .filter(e => e.isDirectory() && (e.name.startsWith('dsh-amberflow-') || e.name.startsWith('dsh-layawebuse-')))
    .map(e => {
      const full = path.join(root, e.name)
      let mtime = 0
      try {
        mtime = fs.statSync(full).mtimeMs
      } catch {
        return null
      }
      return { full, mtime }
    })
    .filter((x): x is { full: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
  let removed = 0
  for (const dir of dirs.slice(keep)) {
    if (Date.now() - dir.mtime < minAgeMs) continue
    try {
      fs.rmSync(dir.full, { recursive: true, force: true })
      removed += 1
    } catch {
      // Leave it for the next call.
    }
  }
  return removed
}

/**
 * Read the flow dry-run document out of the CLI's stdout.
 *
 * A script app has no static step table: `--dry` dry-runs the script (same implementation as
 * `apps check`) and prints its call sequence as `events[]`. Each event becomes one row of the
 * summary's `steps[]`, so the model sees what the script WOULD call without a browser opening.
 * @param stdout - the process output.
 * @returns the dry call sequence, or null when the stream is not a dry-run document.
 */
function readDryRun(stdout: string): { app: string; steps: RunStep[]; model?: string; problems: string[] } | null {
  const doc = parseJsonDocument(stdout)
  if (doc === null) return null
  const events = asRecords(doc['events'])
  const hasEvents = Array.isArray(doc['events'])
  const hasSteps = Array.isArray(doc['steps'])
  if (!hasEvents && !hasSteps) return null
  const steps = hasEvents
    ? events.map((ev, i): RunStep => {
      const call = asText(ev['call'])
      const index = typeof ev['i'] === 'number' ? ev['i'] : i + 1
      const desc = asText(ev['desc']) || (call === '' ? `call ${String(index)}` : call)
      const url = asText(ev['url'])
      const stopCode = asText(ev['stop_code'])
      return {
        index,
        desc,
        status: ev['ok'] === false ? 'failed' : 'ok',
        ...(call === '' ? {} : { call }),
        ...(url === '' ? {} : { url }),
        ...(stopCode === '' ? {} : { stop_code: stopCode }),
      }
    })
    // Older/expanded shapes print static steps; keep them readable rather than rejecting the doc.
    : asRecords(doc['steps']).map((st, i): RunStep => ({
      index: typeof st['index'] === 'number' ? st['index'] : i + 1,
      desc: asText(st['desc'], `step ${String(i + 1)}`),
      status: 'planned',
    }))
  const problems = Array.isArray(doc['problems']) ? (doc['problems'] as unknown[]).map(String) : []
  const model = asText(doc['model_status'])
  return {
    app: asText(doc['app']),
    steps,
    problems,
    ...(model === '' ? {} : { model }),
  }
}

/**
 * Summarize an `app-runner` run's artifacts. Only FAILURES are listed: the whole step table is a
 * file the caller can read, and a 60-step flow should not be pasted into a session by default.
 *
 * A run may legitimately produce no `<app>-result.json` and still succeed: `--dry` dry-runs the
 * script (or expands the flow), prints its call sequence, verifies nothing and writes nothing,
 * exiting 0. That is an expansion, not a failure, so it is summarized as such instead of being
 * reported as "the run did not reach the artifact stage".
 * @param outDir - the run directory the bridge passed as `--out`.
 * @param app - the app id.
 * @param outcome - the finished process.
 * @param runTool - the model-visible run tool name, used in diagnostics.
 * @returns the compact summary.
 * @throws when the run ended without a result artifact and without an expansion to show for it, or
 *   when the dry run found problems in the script's call sequence.
 */
export function summarizeRun(outDir: string, app: string, outcome: ProcessOutcome, runTool?: string): RunSummary {
  const resultPath = path.join(outDir, `${app}-result.json`)
  if (!fs.existsSync(resultPath)) {
    // Parse the FULL stdout: a call sequence is several kilobytes and the display excerpt would cut
    // the document in half, which looks exactly like "this was not a dry run".
    const dry = readDryRun(parseSource(outcome))
    if (dry !== null && dry.problems.length > 0) {
      throw new Error(
        `${runTool ?? `${app} run`}: the dry run found problems in the script's call sequence: `
        + `${dry.problems.join('; ')}`,
      )
    }
    if (dry !== null && outcome.code === 0 && !outcome.timedOut) {
      return {
        ok: true, exitCode: outcome.code, dry: true, completed: '',
        blocked: [], blockedTotal: 0, refused: [], failedTools: [],
        invariants: { held: 0, total: 0, failed: [] },
        steps: dry.steps.slice(0, MAX_STEPS),
        outDir, reportPath: '', stdoutTail: outcome.stdout, timedOut: false, status: 'dry', verified: false,
        ...(dry.model === undefined ? {} : { model: dry.model }),
      }
    }
    const detail = firstLines(outcome.stderr) || firstLines(outcome.stdout)
    throw new Error(
      `no ${app}-result.json in ${outDir} (exit ${outcome.code ?? 'killed'}) — run did not reach the artifact stage`
      + (detail ? `; cause: ${detail}` : ''),
    )
  }
  let raw: JsonObject
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(resultPath, 'utf-8'))
    // Shape matters as much as syntax: a stray array or scalar parses fine and would otherwise be
    // summarized as a FAIL with no cause at all.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not a JSON object')
    }
    raw = parsed as JsonObject
  } catch (error) {
    // A result file cut short (killed mid-write) must read as a diagnosis, not a bare SyntaxError.
    throw new Error(
      `unreadable ${app}-result.json in ${outDir}: `
      + (error instanceof Error ? error.message : 'not valid JSON'),
    )
  }
  const subgoals = asRecords(raw['subgoals'])
  const blocked = subgoals
    .filter(s => s['status'] !== 'done' && s['status'] !== 'skipped')
    .map(s => ({ desc: asText(s['desc']), obstacle: asText(s['obstacle'], asText(s['status'])) }))
  const toolSteps = asRecords(raw['tool_steps'])
  const refused = toolSteps
    .filter(t => asText(t['refused']) !== '')
    .map(t => `${asText(t['desc'])}: ${asText(t['refused'])}`)
  const failedTools = toolSteps
    .filter(t => t['done'] !== true && asText(t['refused']) === '')
    .map(t => `${asText(t['desc'])}: signal not held (exit ${asText(t['code'], '?')})`)
  const invariants = asRecords(raw['invariants'])
  // Flow scripts run behind `ctx.step` / `ctx.arrive`, whose trace is the step table: the runner
  // records it under `steps` when it can (agent view) and `step_traces` on the browser path. Older
  // artifacts used `subgoals`; keep that fallback so a stale result still summarizes.
  const traces = asRecords(raw['step_traces'])
  const agentSteps = asRecords(raw['steps'])
  const rawSteps = agentSteps.length ? agentSteps : traces.length ? traces : subgoals
  const subgoalMeta = new Map(subgoals.map((sg, i) => [i + 1, sg]))
  const indexOffset = agentSteps.length ? 0 : traces.length ? 1 : 0
  const steps = rawSteps.slice(0, MAX_STEPS).map((st, i): RunStep => {
    const methods = Array.isArray(st['methods']) ? st['methods'].map(String).filter(Boolean) : []
    const status = asText(st['status'], 'unknown')
    const index = typeof st['index'] === 'number' ? st['index'] + indexOffset : i + 1
    const meta = subgoalMeta.get(index) ?? {}
    const id = asText(st['id'])
    const stop = asText(st['stop_code']) || asText(meta['stop_code'])
    const obstacle = asText(st['obstacle']) || asText(meta['obstacle'])
    return {
      index,
      desc: asText(st['desc'], `step ${i + 1}`),
      status,
      ...(id === '' ? {} : { id }),
      ...(methods.length ? { method: methods[methods.length - 1]! } : {}),
      ...(stop !== '' ? { stop_code: stop } : {}),
      ...(obstacle !== '' ? { obstacle } : {}),
    }
  })
  const failed = steps.find(st => st.status === 'blocked' || st.status === 'failed' || st.status === 'refused')
  const partial = raw['partial'] === true
  // A flow script reports "a human must act here" as a structured stop on the script record
  // (`ctx.manual` on a non-TTY call), not as a per-step table entry; older artifacts used
  // `manual_steps`. Both must read as `needs_human`, never as a plain failure.
  const scriptInfo = asRecord(raw['script'])
  const scriptStop = scriptInfo === null ? '' : asText(scriptInfo['stop_code'])
  const manualPending = asRecords(raw['manual_steps']).some(m => m['done'] !== true) || scriptStop === 'needs_human'
  const status = manualPending ? 'needs_human'
    : partial ? 'partial' : raw['ok'] === true && outcome.code === 0 ? 'passed'
    : blocked.length ? 'blocked' : failedTools.length ? 'failed' : invariants.some(i => i['held'] !== true) ? 'failed' : 'failed'
  return {
    ok: raw['ok'] === true && outcome.code === 0,
    exitCode: outcome.code,
    dry: false,
    completed: asText(raw['completed']),
    blocked: blocked.slice(0, MAX_FAILURES),
    blockedTotal: blocked.length,
    refused,
    failedTools,
    invariants: {
      held: invariants.filter(i => i['held'] === true).length,
      total: invariants.length,
      failed: invariants.filter(i => i['held'] !== true).map(i => asText(i['id'])),
    },
    outDir,
    resultPath,
    status,
    verified: partial ? false : raw['ok'] === true && outcome.code === 0,
    ...(partial ? { partial: true } : {}),
    steps,
    ...(failed ? { failure: { step: failed.index, desc: failed.desc, ...(failed.stop_code ? { stop_code: failed.stop_code } : {}), ...(failed.obstacle ? { obstacle: failed.obstacle } : {}) } } : {}),
    // Only name a report that is really there: a killed run can leave the artifact without one, and
    // a path the caller cannot open is worse than saying so.
    reportPath: fs.existsSync(path.join(outDir, `${app}-report.md`))
      ? path.join(outDir, `${app}-report.md`)
      : '',
    stdoutTail: outcome.stdout,
    timedOut: outcome.timedOut,
    // Which tier ran, and who decided each step — read from the artifact, never inferred from
    // the exit code (P0: a plugin user must SEE that the model did or did not take part).
    ...modelFields(raw),
  }
}

/** `model_status` / `decisions.line` from the artifact; keys omitted when an older engine wrote none. */
function modelFields(raw: JsonObject): { model?: string, decisions?: string } {
  const out: { model?: string, decisions?: string } = {}
  const status = asText(raw['model_status'])
  if (status !== '') out.model = status
  const d = asRecord(raw['decisions'])
  const line = d === null ? '' : asText(d['line'])
  if (line !== '') out.decisions = line
  return out
}

/**
 * The message for a bridge call that failed without a machine-readable answer. `learn` prints its
 * JSON document only on success paths; on a usage or environment failure stdout is EMPTY and the
 * cause is the first lines of stderr.
 * @param tool - the model-visible tool name.
 * @param outcome - the finished process.
 * @returns one error message naming the exit, the timeout when it fired, and the cause.
 */
export function diagnoseFailure(tool: string, outcome: ProcessOutcome): string {
  const cause = firstLines(outcome.stderr) || firstLines(outcome.stdout) || '(no output)'
  const how = outcome.timedOut ? 'timed out' : `exit ${outcome.code ?? 'killed'}`
  return `${tool} failed (${how}): ${cause}`
}

/** The compact, model-facing view of one `learn` (recorded-flow) call. */
export interface LearnSummary {
  status: string
  app: string
  steps: number
  verified: boolean
  forwards: number
  completed: string
  invariants: string
  /** Invariant ids that failed on the rules-only replay (why `saved` is false). */
  problems?: string[]
  /** Where the flow app (`app.mjs`) was written; absolute once it passed through the service,
   * `false` when the replay gate refused to save it. */
  saved: string | false
}

/**
 * Summarize `learn --json` output. The tool's own JSON is the contract; this only picks the fields
 * that answer "what did we learn, and is it reproducible".
 * @param stdout - the CLI's stdout (it prints one JSON document).
 * @returns the compact summary.
 */
export function summarizeLearn(stdout: string): LearnSummary {
  const doc = parseJsonDocument(stdout)
  if (doc === null) {
    throw new Error(`learn printed no JSON document; first lines: ${firstLines(stdout) || '(empty)'}`)
  }
  const replay = asRecord(doc['replay']) ?? {}
  const saved = doc['saved']
  return {
    status: asText(doc['status'], 'unknown'),
    app: asText(doc['app']),
    steps: asNumber(doc['steps'], 0),
    verified: doc['verified'] === true,
    forwards: asNumber(replay['forwards'], -1),
    completed: asText(replay['completed']),
    invariants: asText(replay['invariants']),
    ...(Array.isArray(replay['failing']) && (replay['failing'] as unknown[]).length
      ? { problems: (replay['failing'] as unknown[]).map(String) } : {}),
    saved: typeof saved === 'string' && saved !== '' ? saved : false,
  }
}

/**
 * The argv for one `amber` CLI call (JSON door). The bridge only adapts; all command semantics
 * live in the checkout's CLI, so a tool can never drift into a second implementation.
 */
export function cliArgs(options: BridgeOptions, args: string[]): string[] {
  return [
    options.nodeBin,
    ...(options.tsxCli !== undefined ? [options.tsxCli] : []),
    '--experimental-strip-types',
    path.join(options.repoPath, 'src', 'cli', 'main.ts'),
    ...args,
  ]
}