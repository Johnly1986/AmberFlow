/**
 * Pure helpers behind the AmberFlow bridge: build the argv for the external CLI, read the
 * artifacts it writes, and summarize them into a **context-cheap** shape.
 *
 * No spawning happens here, so the process policy lives in exactly one place (`runProcess`) and
 * everything else stays unit-testable without a browser, a model, or the external repo.
 * @module @deepseek-ai/dsh-amberflow-bridge/bridge
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/** Resolved deployment options (defaults already applied). */
export interface BridgeOptions {
  /** Absolute path of the AmberFlow checkout that owns `src/app-runner.ts`. */
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
  /** Browser steps in the journey. */
  steps: number
  /** Tool (CLI/datasource) steps in the journey. */
  toolSteps: number
  invariants: number
  /** Where this pack came from: generated (spec/source) | recorded (demo) | hand-written. */
  origin: string
  /**
   * What `_run` can do with it. `journey` runs end to end; `probe` is a measurement set the engine
   * refuses to run through app-runner (its drivers live in the checkout), so the model learns it
   * from the listing instead of burning a spawn; `data-source` has no pack.json at all;
   * `semantic-template` is a site-agnostic SemanticFlow template (flow.json) — run it with
   * `…_run` plus a `site` from its `sites` map, and grow its per-site profile with `…_plan`.
   */
  kind: 'journey' | 'probe' | 'data-source' | 'semantic-template'
  hosts: string[]
  /** For semantic templates: the declared site keys (each backed by `apps/<id>/sites/<site>.profile.json`). */
  sites?: string[]
}

/** A process result, with the output bounded so one call cannot flood the session. */
export interface ProcessOutcome {
  code: number | null
  /** Bounded excerpt of stdout (head + tail) — the only form a summary may surface. */
  stdout: string
  /**
   * The COMPLETE stdout, kept because parsing needs it: a `--dry` plan or a `learn` document can be
   * larger than the excerpt window, and a truncated JSON document does not parse — which would turn
   * a successful call into "no document found". Never surfaced to the model.
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
/** Cap on how many expanded steps one dry-run summary lists. */
const MAX_PLAN_STEPS = 40
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
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Read a JSON field as a list of objects, so every walk over CLI output stays total.
 * @param value - the parsed field.
 * @returns the object entries, or an empty array.
 */
function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    : []
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
export function parseJsonDocument(stdout: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null
  for (let at = stdout.indexOf('{'); at >= 0; at = stdout.indexOf('{', at + 1)) {
    if (at !== 0 && stdout.charAt(at - 1) !== '\n') continue
    const slice = balancedSlice(stdout, at)
    if (slice === null) continue
    try {
      const doc: unknown = JSON.parse(slice)
      if (typeof doc === 'object' && doc !== null && !Array.isArray(doc)) {
        found = doc as Record<string, unknown>
      }
    } catch {
      // Not a document starting here; keep looking for the real one.
    }
  }
  return found
}

/**
 * Read every `apps/<id>/pack.json` under a checkout and summarize it.
 * Deliberately filesystem-only: listing apps needs no browser, no model and no subprocess.
 * @param repoPath - absolute path of the AmberFlow checkout.
 * @returns one summary per declared app, sorted by id.
 */
export function listApps(repoPath: string): AppSummary[] {
  const dir = path.join(repoPath, 'apps')
  if (!fs.existsSync(dir)) throw new Error(`no apps/ directory under ${repoPath}`)
  const out: AppSummary[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(dir, entry.name, 'pack.json')
    if (!fs.existsSync(file)) {
      // A SemanticFlow template (spec_version 2, site-agnostic): a different family in the SAME
      // directory listing, so the model sees exactly one app surface. It runs through the
      // checkout's `src/semantic-flow.ts` with a `site`, and `src/plan-flow.ts` grows its per-site
      // profile — the listing is what tells the model which door a given id belongs to.
      const flowFile = path.join(dir, entry.name, 'flow.json')
      if (fs.existsSync(flowFile)) {
        const flow = JSON.parse(fs.readFileSync(flowFile, 'utf-8')) as Record<string, unknown>
        const sites = asRecord(flow['sites'])
        const notes = Array.isArray(flow['notes']) ? (flow['notes'] as unknown[]) : []
        out.push({
          id: asText(flow['id'], entry.name),
          label: asText(flow['label'], entry.name),
          goal: asText(flow['goal']),
          steps: Array.isArray(flow['steps']) ? (flow['steps'] as unknown[]).length : 0,
          toolSteps: 0,
          invariants: Array.isArray(flow['invariants']) ? (flow['invariants'] as unknown[]).length : 0,
          origin: typeof notes[0] === 'string' && notes[0].startsWith('planned') ? 'planned' : 'hand-written',
          kind: 'semantic-template',
          hosts: [],
          sites: sites === null ? [] : Object.keys(sites),
        })
        continue
      }
      // A declared app with no journey of its own: a pure data source other packs reference by name
      // (`apps/<id>/sources`, e.g. `git-log`). Listing it is what makes a `source` resolvable.
      if (fs.existsSync(path.join(dir, entry.name, 'sources'))) {
        out.push({
          id: entry.name, label: entry.name, goal: '', steps: 0, toolSteps: 0,
          invariants: 0, origin: 'data-source', kind: 'data-source', hosts: [],
        })
      }
      continue
    }
    const pack = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>
    const roles = (typeof pack['roles'] === 'object' && pack['roles'] !== null ? pack['roles'] : {}) as Record<string, Record<string, unknown>>
    const journey = asRecords(pack['journey'])
    // The kind is decided on the MERGED step (role template + inline entry), exactly as the
    // checkout's `src/app-pack.ts` does: a role whose template carries `source` is a tool step.
    const isToolStep = (step: Record<string, unknown>): boolean => {
      const role = step['role']
      const template = typeof role === 'string' ? roles[role] : undefined
      return (template === undefined ? step : { ...template, ...step })['source'] !== undefined
    }
    const generated = asRecord(pack['generated_from'])
    const recorded = asRecord(pack['recorded_from'])
    // The same predicate the engine's app-runner uses to refuse a spawn (probe defined, no
    // journey): surface it in the listing instead of letting `_run` discover it by burning a call.
    const isProbe = pack['probe'] !== undefined && journey.length === 0
    out.push({
      id: asText(pack['id'], entry.name),
      label: asText(pack['label']),
      goal: asText(pack['goal']),
      steps: journey.filter(s => !isToolStep(s)).length,
      toolSteps: journey.filter(isToolStep).length,
      invariants: Array.isArray(pack['invariants']) ? (pack['invariants'] as unknown[]).length : 0,
      origin: generated !== null
        ? `generated:${asText(generated['spec'], asText(generated['source'], '?'))}`
        : recorded !== null
          ? `recorded:${asText(recorded['url'], '?')}`
          : 'hand-written',
      kind: isProbe ? 'probe' : 'journey',
      hosts: Array.isArray(pack['hosts'])
        ? (pack['hosts'] as unknown[]).filter((h): h is string => typeof h === 'string')
        : [],
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * The argv for one `app-runner` invocation. The external CLI is the contract, so the flags are
 * assembled here (and asserted in tests) instead of being strung together at the call site.
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
    noModel?: boolean
    noSources?: boolean
    dangerous?: boolean
    /** Ask the engine to refuse destructive actions per dry-run evidence (middle gate). */
    confirmSafe?: boolean
    slots?: Record<string, string>
  },
): string[] {
  const argv = [options.nodeBin, ...(options.tsxCli !== undefined ? [options.tsxCli] : []), '--experimental-strip-types', path.join(options.repoPath, 'src', 'app-runner.ts')]
  argv.push('--app', args.app, '--out', args.outDir)
  if (args.dry) argv.push('--dry')
  if (args.noModel) argv.push('--no-model')
  if (args.noSources) argv.push('--no-sources')
  if (args.dangerous) argv.push('--allow-dangerous')
  if (args.confirmSafe) argv.push('--confirm-safe')
  for (const [key, value] of Object.entries(args.slots ?? {})) argv.push('--slot', `${key}=${value}`)
  return argv
}

/**
 * The argv for one `learn` invocation: the recorded-flow door. `--json --yes` is what makes it a
 * single machine call instead of an interactive demo.
 * @param options - resolved bridge options.
 * @param args - the model-facing call arguments.
 * @returns argv including the node binary as element 0.
 */
export function learnArgs(
  options: BridgeOptions,
  args: { url?: string; goal?: string; id?: string; cdp?: string; script?: string; packDir?: string; outDir: string; headful?: boolean },
): string[] {
  const argv = [options.nodeBin, ...(options.tsxCli !== undefined ? [options.tsxCli] : []), '--experimental-strip-types', path.join(options.repoPath, 'tools', 'learn.ts'), '--json', '--yes']
  if (args.url) argv.push('--url', args.url)
  if (args.goal) argv.push('--goal', args.goal)
  if (args.id) argv.push('--id', args.id)
  if (args.cdp) argv.push('--cdp', args.cdp)
  if (args.script) argv.push('--script', args.script)
  if (args.packDir) argv.push('--pack-dir', args.packDir)
  if (args.headful) argv.push('--headful')
  argv.push('--out', args.outDir)
  return argv
}

/**
 * The argv for one semantic-flow run (`src/semantic-flow.ts`): the same tool contract as packs,
 * dispatched to the site-agnostic template. `noModel` maps to the engine's pure-rule plane
 * (`--laya none --escalate none` — SiteProfile hints, rules, and list steps only); anything else
 * runs the real decision model (`--laya onnx`) with the LLM teacher (`--escalate llm`), and the
 * model/endpoint's absence degrades exactly like the pack door: blocked steps, honest counts.
 * @param options - resolved bridge options.
 * @param args - the model-facing call arguments (`site` selects the profile to run against).
 * @returns argv including the node binary as element 0.
 */
export function flowRunArgs(
  options: BridgeOptions,
  args: {
    app: string
    site: string
    outDir: string
    dry?: boolean
    noModel?: boolean
    dangerous?: boolean
    slots?: Record<string, string>
  },
): string[] {
  const argv = [options.nodeBin, ...(options.tsxCli !== undefined ? [options.tsxCli] : []),
    '--experimental-strip-types', path.join(options.repoPath, 'src', 'semantic-flow.ts')]
  argv.push('--app', args.app, '--site', args.site, '--out', args.outDir, '--quiet')
  if (args.dry) argv.push('--dry')
  if (args.noModel) argv.push('--laya', 'none', '--escalate', 'none')
  else argv.push('--laya', 'onnx', '--escalate', 'llm')
  if (args.dangerous) argv.push('--allow-dangerous')
  for (const [key, value] of Object.entries(args.slots ?? {})) argv.push('--slot', `${key}=${value}`)
  return argv
}

/**
 * The argv for one plan call (`src/plan-flow.ts`): goal + seed → template + site profile, gated by
 * a replay before anything is written. `--json --yes` is what makes it a single machine call — the
 * interactive door (per-step y/n) is not available to a tool, and the dangerous-step demo gate is
 * engine-side: `--allow-dangerous-demo` only for fixtures/sandboxes.
 * @param options - resolved bridge options.
 * @param args - the model-facing call arguments.
 * @returns argv including the node binary as element 0.
 */
export function planArgs(
  options: BridgeOptions,
  args: {
    goal: string
    seed: string
    app: string
    site?: string
    force?: boolean
    dangerousDemo?: boolean
    planner?: 'scripted' | 'llm'
  },
): string[] {
  const argv = [options.nodeBin, ...(options.tsxCli !== undefined ? [options.tsxCli] : []),
    '--experimental-strip-types', path.join(options.repoPath, 'src', 'plan-flow.ts'), '--json', '--yes']
  argv.push('--goal', args.goal, '--seed', args.seed, '--app', args.app)
  if (args.site) argv.push('--site', args.site)
  if (args.force) argv.push('--force')
  if (args.dangerousDemo) argv.push('--allow-dangerous-demo')
  if (args.planner) argv.push('--planner', args.planner)
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
 * The environment for one engine child process.
 * @param options - resolved bridge options (env mode + explicit forward list).
 * @returns a fresh env object for `spawn`.
 */
export function buildEnv(options: BridgeOptions): NodeJS.ProcessEnv {
  if (options.envMode === 'inherit') return { ...process.env }
  const out: NodeJS.ProcessEnv = {}
  const wanted = [...ENV_BASE, ...ENV_PROXY, ...options.forwardEnv]
  for (const key of wanted) {
    if (process.env[key] !== undefined) out[key] = process.env[key]
  }
  // Deployment-level overrides for the engine itself (repo path, model hints, timeouts) travel by
  // name, and AMBERFLOW_* stays forwardable so a checkout configured by env keeps working.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AMBERFLOW_')) out[key] = process.env[key]
  }
  return out
}

/**
 * Run one child process with a hard timeout and bounded output.
 *
 * The bridge spawns a **foreign** process, so this deliberately does not pretend to inherit the
 * harness sandbox policy: a deployment that enables this plugin is trusting `repoPath`.
 * @param options - resolved bridge options.
 * @param argv - full argv (element 0 is the binary).
 * @returns the exit code (null when killed), bounded stdout/stderr, and whether the timeout fired.
 */
export function runProcess(options: BridgeOptions, argv: string[]): Promise<ProcessOutcome> {
  const [bin, ...args] = argv
  if (bin === undefined || bin === '') {
    return Promise.reject(new Error('runProcess: argv must name a binary'))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.repoPath,
      env: buildEnv(options),
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

/** One step of an expanded (dry-run) plan. */
export interface PlanStep {
  index: number
  /** `browser` or `tool`. */
  kind: string
  desc: string
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
  /** True when `--dry` only expanded the plan: nothing ran and nothing was verified. */
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
  /** The expanded steps of a dry run (bounded by {@link MAX_PLAN_STEPS}); empty otherwise. */
  plan: PlanStep[]
  /** Total expanded steps of a dry run; 0 otherwise. */
  planSteps: number
  outDir: string
  /** The report to read, or '' when the run wrote none (a dry run, or one killed before it did). */
  reportPath: string
  stdoutTail: string
  timedOut: boolean
  /**
   * Semantic-flow runs only: the engine's per-level tally line
   * (`rule N · laya M · escalate K (written back W) · list L · blocked B`) — the migration
   * evidence in one string. Absent for pack apps.
   */
  line?: string
  /** Semantic-flow runs only: where the learned site profile was written ('' when none was). */
  profilePath?: string
}

/** What one `…_plan` call answered: the planned template + site profile, or the honest failure. */
export interface PlanSummary {
  /** `planned` = the replay gate passed and files were written; `failed` = nothing was written. */
  status: string
  ok: boolean
  app: string
  site: string
  /** The planned steps with where each completion signal came from (induced | contract). */
  steps: { id: string; desc: string; signal_source: string }[]
  /** The gate run's tally line — same shape as {@link RunSummary.line}. */
  gate: string
  /** Absolute paths once written; '' when the plan wrote nothing (a failed gate never does). */
  templatePath: string
  profilePath: string
  /** Failure cause when status is `failed`; '' otherwise. */
  error: string
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
 * Read a `--dry` expansion out of the CLI's stdout.
 * @param stdout - the process output.
 * @returns the plan, or null when the stream is not an expansion document.
 */
function readDryPlan(stdout: string): { app: string; steps: PlanStep[] } | null {
  const doc = parseJsonDocument(stdout)
  if (doc === null || !Array.isArray(doc['steps'])) return null
  const steps = asRecords(doc['steps'])
  if (steps.length !== (doc['steps'] as unknown[]).length) return null
  return {
    app: asText(doc['app']),
    steps: steps.map((step, i) => ({
      index: asNumber(step['index'], i),
      kind: asText(step['kind']),
      desc: asText(step['desc']),
    })),
  }
}

/**
 * Summarize `app-runner`'s artifacts. Only FAILURES are listed: the whole step table is a file the
 * caller can read, and a 60-step journey should not be pasted into a session by default.
 *
 * A run may legitimately produce no `<app>-result.json` and still succeed: `--dry` expands the plan,
 * prints it, verifies nothing and writes nothing, exiting 0. That is an expansion, not a failure, so
 * it is summarized as such instead of being reported as "the run did not reach the artifact stage".
 * @param outDir - the run directory the bridge passed as `--out`.
 * @param app - the app id.
 * @param outcome - the finished process.
 * @param runTool - the model-visible run tool name, used when translating the engine's probe refusal.
 * @returns the compact summary.
 * @throws when the run ended without a result artifact and without an expansion to show for it.
 */
export function summarizeRun(outDir: string, app: string, outcome: ProcessOutcome, runTool?: string): RunSummary {
  const resultPath = path.join(outDir, `${app}-result.json`)
  if (!fs.existsSync(resultPath)) {
    // Parse the FULL stdout: a 24-step plan is several kilobytes and the display excerpt would cut
    // the document in half, which looks exactly like "this was not a dry run".
    const plan = readDryPlan(parseSource(outcome))
    if (plan !== null && outcome.code === 0 && !outcome.timedOut) {
      return {
        ok: true, exitCode: outcome.code, dry: true, completed: '',
        blocked: [], blockedTotal: 0, refused: [], failedTools: [],
        invariants: { held: 0, total: 0, failed: [] },
        plan: plan.steps.slice(0, MAX_PLAN_STEPS), planSteps: plan.steps.length,
        outDir, reportPath: '', stdoutTail: outcome.stdout, timedOut: false,
      }
    }
    const detail = firstLines(outcome.stderr) || firstLines(outcome.stdout)
    // The engine refuses probe packs with a CLI-worded pointer to its own drivers (and sometimes to
    // `--dry`, which the model just did). Translate that into what THIS door offers instead.
    if (/没有 journey|测量型/.test(detail)) {
      throw new Error(
        `amberflow-bridge: ${JSON.stringify(app)} is a measurement probe (no journey) and cannot run `
        + `through ${runTool ?? 'the …_run tool'}; read its declaration with the apps tool `
        + `(kind='probe') or run the checkout's probe drivers directly. CLI said: ${detail}`,
      )
    }
    throw new Error(
      `no ${app}-result.json in ${outDir} (exit ${outcome.code ?? 'killed'}) — run did not reach the artifact stage`
      + (detail ? `; cause: ${detail}` : ''),
    )
  }
  let raw: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(resultPath, 'utf-8'))
    // Shape matters as much as syntax: a stray array or scalar parses fine and would otherwise be
    // summarized as a FAIL with no cause at all.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not a JSON object')
    }
    raw = parsed as Record<string, unknown>
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
    plan: [],
    planSteps: 0,
    outDir,
    // Only name a report that is really there: a killed run can leave the artifact without one, and
    // a path the caller cannot open is worse than saying so.
    reportPath: fs.existsSync(path.join(outDir, `${app}-report.md`))
      ? path.join(outDir, `${app}-report.md`)
      : '',
    stdoutTail: outcome.stdout,
    timedOut: outcome.timedOut,
  }
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
  /** Where the pack was written; absolute once it passed through the service, `false` when not saved. */
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
    saved: typeof saved === 'string' && saved !== '' ? saved : false,
  }
}

/**
 * Summarize a semantic-flow run's artifact (`<app>-<site>-flow-result.json`), into the SAME
 * shape as {@link summarizeRun} plus the migration line. Only failures are listed; the per-step
 * table lives in the report file the summary names.
 *
 * A `--dry` semantic run expands the compiled steps and writes nothing — same contract as packs,
 * so the expansion is summarized as `dry: true`, not as a missing artifact.
 * @param outDir - the run directory the bridge passed as `--out`.
 * @param app - the template id.
 * @param site - the site key the template ran against.
 * @param outcome - the finished process.
 * @returns the compact summary.
 * @throws when the run ended without a result artifact and without an expansion to show for it.
 */
export function summarizeFlow(
  outDir: string, app: string, site: string, outcome: ProcessOutcome,
): RunSummary {
  const resultPath = path.join(outDir, `${app}-${site}-flow-result.json`)
  if (!fs.existsSync(resultPath)) {
    const plan = readDryPlan(parseSource(outcome))
    if (plan !== null && outcome.code === 0 && !outcome.timedOut) {
      return {
        ok: true, exitCode: outcome.code, dry: true, completed: '',
        blocked: [], blockedTotal: 0, refused: [], failedTools: [],
        invariants: { held: 0, total: 0, failed: [] },
        plan: plan.steps.slice(0, MAX_PLAN_STEPS), planSteps: plan.steps.length,
        outDir, reportPath: '', stdoutTail: outcome.stdout, timedOut: false,
      }
    }
    const detail = firstLines(outcome.stderr) || firstLines(outcome.stdout)
    throw new Error(
      `no ${app}-${site}-flow-result.json in ${outDir} (exit ${outcome.code ?? 'killed'})`
      + ' — the semantic run did not reach the artifact stage'
      + (detail ? `; cause: ${detail}` : ''),
    )
  }
  let raw: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(resultPath, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not a JSON object')
    }
    raw = parsed as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `unreadable ${app}-${site}-flow-result.json in ${outDir}: `
      + (error instanceof Error ? error.message : 'not valid JSON'),
    )
  }
  const steps = asRecords(raw['steps'])
  const blocked = steps
    .filter(s => s['status'] === 'blocked')
    .map(s => ({ desc: asText(s['desc']), obstacle: asText(s['obstacle'], 'blocked') }))
  const refused = steps
    .filter(s => s['status'] === 'refused')
    .map(s => `${asText(s['desc'])}: ${asText(s['obstacle'], 'refused')}`)
  const doneCount = steps.filter(s => s['status'] === 'done' || s['status'] === 'skipped').length
  const invariants = asRecords(raw['invariants'])
  return {
    ok: raw['ok'] === true && outcome.code === 0,
    exitCode: outcome.code,
    dry: false,
    completed: `${String(doneCount)}/${String(steps.length)}`,
    blocked: blocked.slice(0, MAX_FAILURES),
    blockedTotal: blocked.length,
    refused,
    failedTools: [],
    invariants: {
      held: invariants.filter(i => i['held'] === true).length,
      total: invariants.length,
      failed: invariants.filter(i => i['held'] !== true).map(i => asText(i['id'])),
    },
    plan: [],
    planSteps: 0,
    outDir,
    reportPath: fs.existsSync(path.join(outDir, `${app}-${site}-flow-report.md`))
      ? path.join(outDir, `${app}-${site}-flow-report.md`)
      : '',
    stdoutTail: outcome.stdout,
    timedOut: outcome.timedOut,
    line: asText(raw['line']),
    profilePath: asText(raw['profile_path']),
  }
}

/**
 * Summarize `plan-flow --json` output: the replay gate is the engine's contract, so the tool
 * reports `status: planned` only when files were written. A failed plan prints
 * `{"status":"failed","error":…}` — that is a RESULT, not a crash, and it is surfaced as such.
 * @param stdout - the CLI's stdout (it prints one JSON document, walk lines before it).
 * @returns the compact plan summary; template/profile paths absolute.
 * @throws when the CLI produced no machine-readable document at all.
 */
export function summarizePlan(stdout: string): PlanSummary {
  const doc = parseJsonDocument(stdout)
  if (doc === null) {
    throw new Error(`plan printed no JSON document; first lines: ${firstLines(stdout) || '(empty)'}`)
  }
  const written = asRecord(doc['written'])
  const steps = asRecords(doc['steps'])
  return {
    status: asText(doc['status'], 'unknown'),
    ok: doc['ok'] === true,
    app: asText(doc['app']),
    site: asText(doc['site']),
    steps: steps.map(s => ({
      id: asText(s['id']), desc: asText(s['desc']), signal_source: asText(s['signal_source']),
    })),
    gate: asText(doc['gate']),
    templatePath: typeof written?.['flow'] === 'string' ? written['flow'] : '',
    profilePath: typeof written?.['profile'] === 'string' ? written['profile'] : '',
    error: asText(doc['error']),
  }
}
