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
export function stubCheckout(packs: Record<string, unknown>, options: StubOptions = {}): string {
  const repo = tmp('amberflow-stub')
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
    // The real CLI's `--dry`: expand the plan, print it, write NO artifact, exit 0.
    "if (argv.includes('--dry')) {",
    `  const steps = Array.from({ length: ${String(options.drySteps ?? 2)} }, (_, i) => `,
    '    ({ index: i, kind: i % 2 ? "tool" : "browser", desc: "step " + i + " " + "x".repeat(80) }))',
    '  console.log(JSON.stringify({ app, roles_used: [], slots: {}, steps }, null, 2))',
    '  process.exit(0)',
    '}',
    'fs.writeFileSync(path.join(out, `${app}-result.json`), JSON.stringify({',
    ...options.cleanThenExit === undefined
      ? [
        "  ok: true, completed: '2/2',",
        "  subgoals: [{ desc: 'open the page', status: 'done' }, { desc: 'add to cart', status: 'blocked', obstacle: 'hint matched nothing' }],",
        "  tool_steps: [{ desc: 'dry run', refused: 'dangerous', done: false }],",
        "  invariants: [{ id: 'cart-count-1', held: true }, { id: 'total-shown', held: false }],",
      ]
      : [
        "  ok: true, completed: '2/2',",
        "  subgoals: [{ desc: 'open the page', status: 'done' }],",
        '  tool_steps: [],',
        "  invariants: [{ id: 'cart-count-1', held: true }],",
      ],
    '}))',
    ...options.cleanThenExit === undefined ? [] : [`process.exit(${String(options.cleanThenExit)})`],
  ].join('\n'))
  fs.writeFileSync(path.join(repo, 'tools', 'learn.ts'), learnSource(options))
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
