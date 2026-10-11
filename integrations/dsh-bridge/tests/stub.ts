import type { BridgeOptions, ProcessOutcome } from '../src/bridge.ts'

/**
 * Shared fixtures for the bridge specs: a scratch checkout whose CLIs answer with canned documents.
 * Lives outside `*.spec.ts` so both spec files mount the same deployment.
 *
 * The canned CLIs mirror the REAL ones on the points the bridge depends on, because a fixture that
 * is easier than the real thing is what lets a bridge assumption rot: `--dry` prints a plan and
 * writes NO artifact (exit 0); `learn` refuses without `--script`; `learn` logs executor-style step
 * lines — one of them containing a brace — before its JSON document and prints a trailing line after
 * it; and every spawn drops a marker so a spec can prove the bridge refused BEFORE spawning.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const TMP: string[] = []
export function tmp(tag = 'bridge'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`))
  TMP.push(dir)
  return dir
}
/** Remove every scratch directory a spec created. */
export function cleanupTmp(): void {
  while (TMP.length) fs.rmSync(TMP.pop()!, { recursive: true, force: true })
}

export const OPTIONS: BridgeOptions = {
  repoPath: '/repo', nodeBin: '/usr/bin/node', timeoutMs: 1000, allowDangerous: false,
  toolPrefix: 'amberflow', envMode: 'inherit', forwardEnv: [], keepRuns: 0,
}

/**
 * Build a finished process result. `stdoutFull` defaults to the excerpt, because only the specs that
 * are about the output window need the two to differ.
 * @param fields - the fields to set; omitted ones default to an empty/successful value.
 * @returns the outcome a summarizer would receive.
 */
export function proc(fields: {
  code: number | null
  stdout?: string
  stdoutFull?: string
  stderr?: string
  timedOut?: boolean
}): ProcessOutcome {
  const stdout = fields.stdout ?? ''
  return {
    code: fields.code,
    stdout,
    stdoutFull: fields.stdoutFull ?? stdout,
    stderr: fields.stderr ?? '',
    timedOut: fields.timedOut ?? false,
  }
}

/** How the canned `learn` CLI should behave. */
export interface StubOptions {
  /** Fail the way the real CLI does on a bad page: cause on stderr, stdout EMPTY, usage last. */
  learnFails?: boolean
  /** Steps in the canned `--dry` plan (default 2). A long journey makes the plan exceed the window. */
  drySteps?: number
  /** Pad the canned `learn` document past the display window, as a long recorded flow would. */
  learnBig?: boolean
  /**
   * Write a CLEAN artifact (ok:true, nothing failed) and then exit with this code — the shape a run
   * leaves behind when it is killed after writing its result. The summary then has no failed step to
   * name, so it has to report the exit instead.
   */
  cleanThenExit?: number
  /** Also expose one SemanticFlow template (`apps/flow-app/flow.json`). */
  flow?: boolean
}

/** The marker every canned CLI drops in its cwd, so a spec can prove what was spawned. */
export const SPAWN_MARKER = 'stub-spawned.txt'

/** The canned `tools/learn.ts`: refuses without `--script`, then answers with a noisy document. */
function learnSource(options: StubOptions): string {
  if (options.learnFails) {
    return [
      "import fs from 'node:fs'",
      `fs.writeFileSync(${JSON.stringify(SPAWN_MARKER)}, 'learn')`,
      "process.stderr.write('\\u001B[31mpage.goto: net::ERR_FILE_NOT_FOUND at file:///x/missing.html\\u001B[39m\\n')",
      "process.stderr.write('Call log:\\n  - navigating to \"file:///x/missing.html\"\\n')",
      "for (let i = 0; i < 20; i++) process.stderr.write('usage: learn [--url <page>] [--goal \"one line\"]\\n')",
      'process.exit(2)',
    ].join('\n')
  }
  return [
    "import fs from 'node:fs'",
    `fs.writeFileSync(${JSON.stringify(SPAWN_MARKER)}, 'learn')`,
    'const argv = process.argv.slice(2)',
    // The real CLI's only non-interactive action source (tools/learn.ts, `动作来源`).
    "if (!argv.includes('--script')) {",
    "  process.stderr.write('没有动作来源：给 --script <录好的动作.json>，或在终端里现场演示给 learn 看\\n')",
    '  process.exit(2)',
    '}',
    // Executor step lines land on stdout before the document — and a page label can contain a brace.
    "console.log('  step 1: click a \"Cart {badge}\" (clicked, rule:match, conf=1.00)')",
    "console.log(JSON.stringify({ status: 'ok', app: 'stub-app', steps: 2, verified: true,",
    ...options.learnBig ? [`  notes: '${'y'.repeat(3_000)}',`] : [],
    "  replay: { forwards: 0, completed: '2/2', invariants: '2/2' }, saved: 'apps/stub-app/pack.json' }))",
    "console.log('recorded 2 step(s)')",
  ].join('\n')
}

/** A checkout stub that satisfies load-time validation and answers with canned documents. */
export function stubCheckout(packs: Record<string, unknown>, options: StubOptions = {}): string {  const repo = tmp('amberflow-stub')
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'src', 'app-runner.ts'), [
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    'const argv = process.argv.slice(2)',
    "const app = argv[argv.indexOf('--app') + 1]",
    "const out = argv[argv.indexOf('--out') + 1]",
    'fs.mkdirSync(out, { recursive: true })',
    // Record what the bridge actually passed, so a spec can prove a slot reached the CLI.
    "fs.writeFileSync('argv.json', JSON.stringify(argv))",
    // The real CLI's `--dry`: expand the plan (including which tier WOULD run), print it,
    // write NO artifact, exit 0.
    "if (argv.includes('--dry')) {",
    `  const steps = Array.from({ length: ${String(options.drySteps ?? 2)} }, (_, i) => `,
    '    ({ index: i, kind: i % 2 ? "tool" : "browser", desc: "step " + i + " " + "x".repeat(80) }))',
    '  const tier = argv.includes("--no-model") ? "off(rules-only)" : "on"',
    '  console.log(JSON.stringify({ app, roles_used: [], slots: {}, steps, model_status: tier }, null, 2))',
    '  process.exit(0)',
    '}',
    'fs.writeFileSync(path.join(out, `${app}-result.json`), JSON.stringify({',
    ...options.cleanThenExit === undefined
      ? [
        "  ok: true, completed: '2/2',",
        "  subgoals: [{ desc: 'open the page', status: 'done' }, { desc: 'add to cart', status: 'blocked', obstacle: 'hint matched nothing' }],",
        "  tool_steps: [{ desc: 'dry run', refused: 'dangerous', done: false }],",
        "  invariants: [{ id: 'cart-count-1', held: true }, { id: 'total-shown', held: false }],",
        // Which tier ran + the decision tally (mirrors the engine's `model_status`/`decisions`).
        "  model_status: argv.includes('--no-model') ? 'off(rules-only)' : 'off(missing)',",
        "  decisions: { line: 'rule 1 · laya 1 (conf 0.31) · laya:reobserve 0 · escalate 0' },",
      ]
      : [
        "  ok: true, completed: '2/2',",
        "  subgoals: [{ desc: 'open the page', status: 'done' }],",
        '  tool_steps: [],',
        "  invariants: [{ id: 'cart-count-1', held: true }],",
        "  model_status: argv.includes('--no-model') ? 'off(rules-only)' : 'off(missing)',",
        "  decisions: { line: 'rule 1 · laya 0 · laya:reobserve 0 · escalate 0' },",
      ],
    '}))',
    ...options.cleanThenExit === undefined ? [] : [`process.exit(${String(options.cleanThenExit)})`],
  ].join('\n'))
  fs.writeFileSync(path.join(repo, 'tools', 'learn.ts'), learnSource(options))
  // The SemanticFlow door exists in every modern checkout; the dispatch is by the template file,
  // so the CLIs can be written unconditionally and `flow` only controls the template app.
  fs.writeFileSync(path.join(repo, 'src', 'semantic-flow.ts'), flowSource())
  fs.writeFileSync(path.join(repo, 'src', 'plan-flow.ts'), planSource())
  if (options.flow) {
    fs.mkdirSync(path.join(repo, 'apps', 'flow-app'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'apps', 'flow-app', 'flow.json'), JSON.stringify(FLOW_TEMPLATE))
  }
  for (const [id, pack] of Object.entries(packs)) {
    fs.mkdirSync(path.join(repo, 'apps', id), { recursive: true })
    fs.writeFileSync(path.join(repo, 'apps', id, 'pack.json'), JSON.stringify(pack))
  }
  return repo
}

/** Declare a pure data-source app (`apps/<id>/sources`), the kind that has no `pack.json`. */
export function stubDataSource(repo: string, id: string): void {
  fs.mkdirSync(path.join(repo, 'apps', id, 'sources'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'apps', id, 'sources', 'tool.json'), JSON.stringify({ name: id }))
}

export const PACKS = {
  'gen-app': {
    id: 'gen-app', label: 'generated', goal: 'g', hosts: ['a.example'],
    journey: [{ role: 'r1' }, { role: 'r2' }, { source: 'tool-x' }], invariants: [{ id: 'i1' }],
    generated_from: { spec: 'transfer/specs/x.json', plan_sha256: 'a'.repeat(64) },
  },
  'rec-app': {
    id: 'rec-app', label: 'recorded', goal: 'g', hosts: [],
    journey: [{ role: 'r1' }], invariants: [{ id: 'i1' }, { id: 'i2' }],
    recorded_from: { url: 'testpages/product.html', steps: 1, sha256: 'b'.repeat(64) },
  },
  'hand-app': { id: 'hand-app', label: 'hand', goal: 'g', hosted: [], journey: [{ role: 'r1' }] },
}

/**
 * The canned `src/semantic-flow.ts` CLI: mirrors the real one on the points the bridge depends on
 * — `--dry` prints an expansion and writes nothing; a real run drops `<app>-<site>-flow-result.json`
 * (+ report.md) in `--out`, with the engine's `line` tally and `profile_path`; every spawn records
 * argv so a spec can prove the site/laya mapping reached the CLI.
 */
function flowSource(): string {
  return [
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    'const argv = process.argv.slice(2)',
    "const app = argv[argv.indexOf('--app') + 1]",
    "const site = argv[argv.indexOf('--site') + 1]",
    "const out = argv[argv.indexOf('--out') + 1]",
    'fs.mkdirSync(out, { recursive: true })',
    "fs.writeFileSync('argv.json', JSON.stringify(argv))",
    "if (argv.includes('--dry')) {",
    '  console.log(JSON.stringify({ app, site, steps: [',
    "    { index: 0, kind: 'browser', desc: 'open the flights channel' },",
    "    { index: 1, kind: 'list', desc: 'pick the cheapest fare' },",
    '  ] }))',
    '  process.exit(0)',
    '}',
    'fs.writeFileSync(path.join(out, `${app}-${site}-flow-result.json`), JSON.stringify({',
    "  ok: true, completed: '1/2',",
    // The real CLI writes both: the requested plane and the honest tier.
    "  laya: argv.includes('--laya') ? argv[argv.indexOf('--laya') + 1] : 'scripted',",
    "  model_status: argv.includes('--laya') && argv[argv.indexOf('--laya') + 1] === 'none'",
    "    ? 'off(rules-only)' : 'off(scripted)',",
    "  steps: [{ id: 'open-flights', desc: 'open the flights channel', status: 'done' },",
    "    { id: 'pick-date', desc: 'choose the departure date', status: 'blocked', obstacle: 'low confidence' }],",
    "  invariants: [{ id: 'inv0', desc: 'done page', held: true }],",
    "  line: 'rule 1 · laya 0 · escalate 0 (written back 0) · list 0 · blocked 1',",
    "  profile_path: path.join(out, `${site}.profile.json`),",
    '}))',
    "fs.writeFileSync(path.join(out, `${app}-${site}-flow-report.md`), '# flow report\\n')",
  ].join('\n')
}

/**
 * The canned `src/plan-flow.ts` CLI: logs walk noise BEFORE the JSON document (exactly like the
 * real one) and prints the `--json` envelope; with the deployment-off `--allow-dangerous-demo`
 * it exits 1 printing `{"status":"failed"}` — a failed plan is a result, not a crash.
 */
function planSource(): string {
  return [
    "import fs from 'node:fs'",
    'const argv = process.argv.slice(2)',
    "const app = argv[argv.indexOf('--app') + 1]",
    "const siteIdx = argv.indexOf('--site')",
    "const site = siteIdx > 0 ? argv[siteIdx + 1] : 'auto-site'",
    "fs.writeFileSync('argv.json', JSON.stringify(argv))",
    "console.log('  [open-flights] 进入机票预订频道 -> search.html 判据: induced')",
    "if (!argv.includes('--allow-dangerous-demo')) {",
    "  console.log(JSON.stringify({ status: 'failed', ok: false, app, site,",
    "    steps: [], gate: '', written: null,",
    "    error: 'planning reached the dangerous step purchase without allowDangerousDemo' }))",
    '  process.exit(1)',
    '}',
    "fs.mkdirSync(`apps/${app}/sites`, { recursive: true })",
    "fs.writeFileSync(`apps/${app}/flow.json`, JSON.stringify({ spec_version: 2, id: app, label: 'planned', goal: 'g', sites: { [site]: { label: site, start_url: 'x' } }, steps: [] }))",
    "fs.writeFileSync(`apps/${app}/sites/${site}.profile.json`, JSON.stringify({ spec_version: 2, site, steps: {} }))",
    "console.log(JSON.stringify({ status: 'planned', ok: true, app, site,",
    "  steps: [{ id: 'open-flights', desc: '进入机票预订频道', signal_source: 'induced' }],",
    "  gate: 'rule 1 · laya 3 · escalate 0 (written back 3) · list 1 · blocked 0',",
    "  written: { flow: `apps/${app}/flow.json`, profile: `apps/${app}/sites/${site}.profile.json` },",
    '  error: null }))',
  ].join('\n')
}

/** The SemanticFlow template a stub checkout can expose when `options.flow` is set. */
export const FLOW_TEMPLATE = {
  spec_version: 2, id: 'flow-app', label: 'semantic template', goal: 'book the cheapest flight',
  slots: { from: '昆明' },
  sites: { 'site-a': { label: 'replica A', start_url: 'semantic/site-a/index.html' } },
  pages: { home: 'index.html', search: 'search.html' },
  steps: [
    { id: 'open-flights', desc: '进入机票预订频道', page: 'home', semantic_target: { role: 'link', text: ['机票'] }, signal: { page: 'search' } },
  ],
  invariants: [{ page: 'search' }],
  notes: ['planned: goal="..." seed=... site=site-a'],
}
