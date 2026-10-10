/**
 * Hermetic tests for the LayaWebUse bridge: argument assembly, artifact summarization, load-time
 * validation, and the full registry path (`ctx.tools.execute`) against a **stub checkout** whose
 * `app-runner.ts` / `learn.ts` print canned documents. No browser, no model, no network — the real
 * checkout is exercised separately in `live.spec.ts`.
 */
import { Context } from '@deepseek-ai/cordis'
import { OPTIONS, PACKS, SPAWN_MARKER, proc, stubCheckout, stubDataSource, tmp } from './stub.ts'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as Bridge from '@deepseek-ai/dsh-layawebuse-bridge'
import {
  buildEnv, diagnoseFailure, firstLines, learnArgs, listApps, parseJsonDocument, pruneRunDirs,
  runArgs, runProcess, stripAnsi, summarizeLearn, summarizeRun,
} from '../src/bridge.ts'

describe('bridge helpers', () => {
  it('listApps reports steps, invariants and provenance per pack', () => {
    const repo = stubCheckout(PACKS)
    const apps = listApps(repo)
    expect(apps.map(a => a.id)).toEqual(['gen-app', 'hand-app', 'rec-app'])
    expect(apps[0]).toMatchObject({ steps: 2, toolSteps: 1, invariants: 1, origin: 'generated:transfer/specs/x.json' })
    expect(apps[2]).toMatchObject({ steps: 1, invariants: 2, origin: 'recorded:testpages/product.html' })
    expect(apps[1]!.origin).toBe('hand-written')
  })

  it('listApps fails loudly on a directory that is not a checkout', () => {
    expect(() => listApps(tmp('empty'))).toThrow(/no apps\/ directory/)
  })

  it('listApps classifies kinds: journey runs, probe is refused by the engine, data-source has no pack', () => {
    const repo = stubCheckout({
      ...PACKS,
      'probe-app': { id: 'probe-app', label: 'p', goal: 'reachability', hosts: ['x.example'], invariants: [], probe: { http: ['a', 'b'] } },
    })
    stubDataSource(repo, 'src-app')
    const apps = listApps(repo)
    expect(apps.find(a => a.id === 'probe-app')!.kind).toBe('probe')
    expect(apps.find(a => a.id === 'src-app')!.kind).toBe('data-source')
    expect(apps.find(a => a.id === 'gen-app')!.kind).toBe('journey')
  })

  it('summarizeRun translates the engine probe refusal into this door\'s guidance', () => {
    const out = tmp('run-out')
    const detail = 'app probe-app 是测量型应用（探针集，17 个目标），没有 journey：请用对应的探针驱动…或用 `npm run apps -- --app probe-app --dry` 只看声明。'
    expect(() => summarizeRun(out, 'probe-app', proc({ code: 2, stderr: detail })))
      .toThrow(/cannot run .*kind='probe'/)
  })

  it('runArgs assembles flags, slots and the dangerous switch', () => {
    const argv = runArgs(OPTIONS, {
      app: 'demo', outDir: '/tmp/out', dry: true, noModel: true, noSources: true, dangerous: true,
      confirmSafe: true,
      slots: { date: '2026-10-12', window: '0800-1800' },
    })
    expect(argv.slice(0, 3)).toEqual(['/usr/bin/node', '--experimental-strip-types', '/repo/src/app-runner.ts'])
    expect(argv.join(' ')).toContain('--app demo --out /tmp/out')
    for (const flag of ['--dry', '--no-model', '--no-sources', '--allow-dangerous', '--confirm-safe']) expect(argv).toContain(flag)
    expect(argv.slice(-4)).toEqual(['--slot', 'date=2026-10-12', '--slot', 'window=0800-1800'])
  })

  it('learnArgs always asks for the machine-readable single call', () => {
    const argv = learnArgs(OPTIONS, { url: 'testpages/product.html', goal: 'add to cart', outDir: '/tmp/out' })
    expect(argv).toContain('--json')
    expect(argv).toContain('--yes')
    expect(argv.slice(-2)).toEqual(['--out', '/tmp/out'])
    expect(argv).not.toContain('--cdp')
    expect(argv).not.toContain('--headful')
    const headful = learnArgs(OPTIONS, { url: 'p', goal: 'g', outDir: '/tmp/o', headful: true })
    expect(headful).toContain('--headful')
  })

  it('summarizeRun keeps FAILURES only and names the artifact it read', () => {
    const out = tmp('run-out')
    fs.writeFileSync(path.join(out, 'demo-result.json'), JSON.stringify({
      ok: true, completed: '2/3',
      subgoals: [
        { desc: 'a', status: 'done' }, { desc: 'b', status: 'skipped' },
        { desc: 'c', status: 'blocked', obstacle: 'low confidence 0.10 < floor 0.25' },
      ],
      tool_steps: [{ desc: 'write', refused: 'dangerous' }],
      invariants: [{ id: 'i1', held: true }, { id: 'i2', held: false }],
    }))
    // A real run writes the report next to the artifact; `reportPath` only names a file that is there.
    fs.writeFileSync(path.join(out, 'demo-report.md'), '# report')
    const s = summarizeRun(out, 'demo', proc({ code: 1, stdout: 'tail' }))
    expect(s.ok).toBe(false)                       // exit code decides, not the artifact alone
    expect(s.completed).toBe('2/3')
    expect(s.blocked).toEqual([{ desc: 'c', obstacle: 'low confidence 0.10 < floor 0.25' }])
    expect(s.blockedTotal).toBe(1)
    expect(s.refused).toEqual(['write: dangerous'])
    expect(s.invariants).toEqual({ held: 1, total: 2, failed: ['i2'] })
    expect(s.reportPath).toBe(path.join(out, 'demo-report.md'))
  })

  it('summarizeRun refuses to invent a result when the run never reached the artifact stage', () => {
    // The cause, not the usage block that follows it.
    expect(() => summarizeRun(tmp('run-empty'), 'demo', proc({
      code: 2, stderr: 'app pack "demo" not found under /repo/apps\nusage: app-runner [--list]',
    }))).toThrow(/app pack "demo" not found/)
    expect(() => summarizeRun(tmp('run-empty'), 'demo', proc({ code: 2 })))
      .toThrow(/^\(no demo-result\.json .*\)$|no demo-result\.json/)
  })

  it('summarizeLearn parses the JSON document even when the CLI logged first', () => {
    const s = summarizeLearn('page: file:///x\n{"status":"ok","app":"a","steps":2,"verified":true,'
      + '"replay":{"forwards":0,"completed":"2/2","invariants":"2/2"},"saved":"apps/a/pack.json"}\n')
    expect(s).toEqual({
      status: 'ok', app: 'a', steps: 2, verified: true, forwards: 0,
      completed: '2/2', invariants: '2/2', saved: 'apps/a/pack.json',
    })
  })
})

describe('bridge diagnostics', () => {
  it('stripAnsi removes colour escapes so a CLI diagnostic reads as text', () => {
    expect(stripAnsi('\u001B[22mError: boom\u001B[39m')).toBe('Error: boom')
    expect(stripAnsi('plain text')).toBe('plain text')
  })

  it('firstLines keeps the CAUSE and stops at the usage block', () => {
    const text = 'cause line one\ncause line two\n\nusage: tool [--flag]\nusage line two\n'
    expect(firstLines(text)).toBe('cause line one\ncause line two')
    const many = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    expect(firstLines(many).split('\n')).toHaveLength(6)
  })

  it('diagnoseFailure names the exit and prefers stderr over stdout', () => {
    const message = diagnoseFailure('layawebuse_learn', proc({
      code: 2, stdout: 'usage text', stderr: 'page.goto: net::ERR_FILE_NOT_FOUND',
    }))
    expect(message).toBe('layawebuse_learn failed (exit 2): page.goto: net::ERR_FILE_NOT_FOUND')
    expect(diagnoseFailure('layawebuse_run', proc({ code: null, timedOut: true })))
      .toBe('layawebuse_run failed (timed out): (no output)')
  })

  it('summarizeLearn on an empty document reports the first lines instead of a usage tail', () => {
    expect(() => summarizeLearn('')).toThrow(/printed no JSON document; first lines: \(empty\)/)
  })

  it('runProcess keeps BOTH ends of a noisy process', async () => {
    const options = { ...OPTIONS, repoPath: tmp('noisy'), nodeBin: process.execPath, timeoutMs: 30_000 }
    const outcome = await runProcess(options, [
      process.execPath, '-e',
      "process.stdout.write('HEADMARK' + 'x'.repeat(4000) + 'TAILMARK')",
    ])
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain('HEADMARK')
    expect(outcome.stdout).toContain('TAILMARK')
    expect(outcome.stdout).toContain('…')
    expect(outcome.stdout.length).toBeLessThan(2100)
    // The full text survives for parsing even though the display form is bounded. `stdoutFull` is
    // optional on ProcessOutcome (a display-only caller may omit it), so narrow before using it.
    const full = outcome.stdoutFull ?? ''
    expect(full.length).toBeGreaterThan(4000)
    expect(full).not.toContain('…')
  }, 60_000)
})

/** Mount the bridge on a checkout stub, with the registry it registers its tools into. */
async function mount(repoPath: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)          // ToolRuntime resolves its scope through the prompt seam
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Bridge, { repoPath })
  return ctx
}

/** Drive one tool through the registry, exactly as the model would. */
function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    callId: ToolCallId(`call-${name}-${Math.random().toString(36).slice(2)}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent: { session: { header: {} } } as never,
  })
}

describe('bridge plugin', () => {
  it('refuses a repoPath that is not a checkout, at load time', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(Bridge, { repoPath: tmp('not-a-repo') }))
      .rejects.toThrow(/not a LayaWebUse checkout/)
  })

  it('registers the three tools under the configured prefix', async () => {
    const ctx = await mount(stubCheckout(PACKS))
    const names = ctx.tools.schemas().map(s => s.name).sort()
    expect(names).toEqual(['layawebuse_apps', 'layawebuse_learn', 'layawebuse_run'])
    const run = ctx.tools.schemas().find(s => s.name === 'layawebuse_run')!
    expect(run.description).toContain('compact summary')
    // schemas() exposes the whole JSON Schema, so read the property map
    const props = (run.parameters as { properties: Record<string, unknown> }).properties
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['app', 'dry', 'no_model', 'allow_dangerous', 'slots']))
  })

  it('executes …_apps through the registry (filesystem only)', async () => {
    const ctx = await mount(stubCheckout(PACKS))
    const result = await call(ctx, 'layawebuse_apps', { filter: 'rec' })
    expect(result.isError).toBe(false)
    const value = result.value as { apps: { id: string; origin: string; steps: number }[] }
    expect(value.apps).toHaveLength(1)
    expect(value.apps[0]).toMatchObject({ id: 'rec-app', origin: 'recorded:testpages/product.html', steps: 1 })
  })

  it('executes …_run through the registry and summarizes the real artifact', async () => {
    const ctx = await mount(stubCheckout(PACKS))
    const result = await call(ctx, 'layawebuse_run', { app: 'gen-app', no_model: true, no_sources: true })
    expect(result.isError).toBe(false)
    const value = result.value as {
      ok: boolean
      completed: string
      blockedTotal: number
      blocked: { desc: string; obstacle: string }[]
      refused: string[]
      invariants: { held: number; total: number; failed: string[] }
    }
    expect(value.ok).toBe(true)
    expect(value.completed).toBe('2/2')
    // Only the FAILED step survives summarization; the done one is a count, not a row.
    expect(value.blocked).toEqual([{ desc: 'add to cart', obstacle: 'hint matched nothing' }])
    expect(value.blockedTotal).toBe(1)
    expect(value.refused).toEqual(['dry run: dangerous'])
    expect(value.invariants).toEqual({ held: 1, total: 2, failed: ['total-shown'] })
  })

  it('executes …_learn through the registry and reports the zero-forward replay', async () => {
    const repo = stubCheckout(PACKS)
    const ctx = await mount(repo)
    const result = await call(ctx, 'layawebuse_learn', {
      url: 'testpages/product.html', goal: 'add to cart', script: '/tmp/actions.json',
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      status: 'ok', app: 'stub-app', steps: 2, verified: true, forwards: 0,
    })
    // `saved` comes back relative to the checkout; the bridge resolves it so it can be read as-is.
    expect((result.value as { saved: string }).saved).toBe(
      path.join(repo, 'apps', 'stub-app', 'pack.json'),
    )
  })

  it('reports a failing learn as its CAUSE, never as the usage block', async () => {
    const ctx = await mount(stubCheckout(PACKS, { learnFails: true }))
    const result = await call(ctx, 'layawebuse_learn', {
      url: 'testpages/missing.html', goal: 'x', script: '/tmp/actions.json',
    })
    expect(result.isError).toBe(true)
    const text = JSON.stringify(result)
    expect(text).toContain('ERR_FILE_NOT_FOUND')
    expect(text).not.toContain('usage: learn')
    expect(text).not.toContain('u001B')
  })

  it('refuses dangerous tool steps when the deployment has not enabled them', async () => {
    const ctx = await mount(stubCheckout(PACKS))
    const result = await call(ctx, 'layawebuse_run', { app: 'gen-app', allow_dangerous: true })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('does not permit dangerous tool steps')
  })
})

/**
 * Regressions for the defects an independent verification pass found in the first release. Each one
 * failed before the fix, so none of them is a restatement of the happy path.
 */
describe('verified defects, kept fixed', () => {
  it('summarizes a dry run as an expansion instead of failing on the missing artifact', () => {
    const stdout = JSON.stringify({
      app: 'demo', roles_used: [], slots: {},
      steps: [{ index: 0, kind: 'browser', desc: 'open' }, { index: 1, kind: 'tool', desc: 'write' }],
    }, null, 2)
    const s = summarizeRun(tmp('dry-out'), 'demo', proc({ code: 0, stdout }))
    expect(s.dry).toBe(true)
    expect(s.ok).toBe(true)
    expect(s.planSteps).toBe(2)
    expect(s.plan).toEqual([
      { index: 0, kind: 'browser', desc: 'open' },
      { index: 1, kind: 'tool', desc: 'write' },
    ])
    // A dry run verifies nothing and writes nothing, so it must not advertise a report.
    expect(s.reportPath).toBe('')
    expect(s.invariants).toEqual({ held: 0, total: 0, failed: [] })
  })

  it('detects a dry plan that is LARGER than the display excerpt', () => {
    // A 24-step plan is several kilobytes; the display window keeps only 1200 + 800 bytes, and a
    // truncated document does not parse — which is indistinguishable from "not a dry run".
    const steps = Array.from({ length: 60 }, (_, i) => ({
      index: i, kind: i % 2 ? 'tool' : 'browser', desc: `step ${i} ${'x'.repeat(80)}`,
    }))
    const full = JSON.stringify({ app: 'demo', steps }, null, 2)
    expect(full.length).toBeGreaterThan(2_000)
    const excerpted = `${full.slice(0, 1200)}\n…\n${full.slice(-800)}`
    const s = summarizeRun(tmp('dry-big'), 'demo', proc({ code: 0, stdout: excerpted, stdoutFull: full }))
    expect(s.dry).toBe(true)
    expect(s.planSteps).toBe(60)
    expect(s.plan).toHaveLength(40)          // still bounded for the model
    expect(s.stdoutTail).toBe(excerpted)     // the surfaced tail stays bounded
  })

  it('still fails loudly when a run ends with neither an artifact nor an expansion', () => {
    expect(() => summarizeRun(tmp('no-artifact'), 'demo', proc({
      code: 2, stdout: 'not a plan', stderr: 'boom',
    }))).toThrow(/run did not reach the artifact stage; cause: boom/)
  })

  it('reports a truncated result artifact as a diagnosis, not a bare SyntaxError', () => {
    const out = tmp('corrupt-artifact')
    fs.writeFileSync(path.join(out, 'demo-result.json'), '{"ok": true, "subgoals": [{"desc": "a"')
    expect(() => summarizeRun(out, 'demo', proc({ code: 0 })))
      .toThrow(/unreadable demo-result\.json in .*: /)
  })

  it('rejects a result artifact that is valid JSON but not an object', () => {
    for (const body of ['[1,2,3]', '42', '"x"', 'null']) {
      const out = tmp('wrong-shape')
      fs.writeFileSync(path.join(out, 'demo-result.json'), body)
      // Without the shape check these became a silent "FAIL ; invariants 0/0" or a raw TypeError.
      expect(() => summarizeRun(out, 'demo', proc({ code: 0 })), body)
        .toThrow(/unreadable demo-result\.json in .*: not a JSON object/)
    }
  })

  it('names only a report that exists', () => {
    const out = tmp('no-report')
    fs.writeFileSync(path.join(out, 'demo-result.json'), JSON.stringify({
      ok: true, completed: '1/1', subgoals: [{ desc: 'a', status: 'done' }], tool_steps: [], invariants: [],
    }))
    expect(summarizeRun(out, 'demo', proc({ code: 0 })).reportPath).toBe('')
    fs.writeFileSync(path.join(out, 'demo-report.md'), '# report')
    expect(summarizeRun(out, 'demo', proc({ code: 0 })).reportPath).toBe(path.join(out, 'demo-report.md'))
  })

  it('settles even when a grandchild keeps the pipes open', async () => {
    const options = { ...OPTIONS, repoPath: tmp('grandchild'), nodeBin: process.execPath, timeoutMs: 500 }
    // The grandchild inherits stdout/stderr, so 'close' does not fire when the child is killed.
    const started = Date.now()
    const outcome = await runProcess(options, [
      process.execPath, '-e',
      'require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"],'
        + ' { stdio: ["ignore", "inherit", "inherit"] }); setTimeout(() => {}, 4000)',
    ])
    expect(outcome.timedOut).toBe(true)
    expect(outcome.code).toBeNull()
    // The 500 ms cap plus the 1 s stdio grace, not the grandchild's 4 s.
    expect(Date.now() - started).toBeLessThan(3_000)
  }, 30_000)

  it('rejects an empty binary with a diagnosis', async () => {
    await expect(runProcess(OPTIONS, ['', 'x'])).rejects.toThrow(/must name a binary/)
  })

  it('reports why a FAIL stopped when no step can be named', async () => {
    const ctx = await mount(stubCheckout(PACKS, { cleanThenExit: 3 }))
    const result = await call(ctx, 'layawebuse_run', { app: 'gen-app' })
    expect(result.isError).toBe(false)
    const value = result.value as { ok: boolean; blockedTotal: number; failedTools: string[] }
    expect(value.ok).toBe(false)
    expect(value.blockedTotal).toBe(0)
    expect(value.failedTools).toEqual([])
    // A bare "FAIL 2/2" hid the fact that the process never exited cleanly.
    expect(JSON.stringify(result)).toContain('stopped: exit 3')
  })

  it('corrupts no character when a multi-byte run straddles a stdout chunk', async () => {
    const options = { ...OPTIONS, repoPath: tmp('utf8'), nodeBin: process.execPath, timeoutMs: 30_000 }
    // The child builds the text itself: 60k characters of argv would not fit (spawn E2BIG).
    const outcome = await runProcess(options, [
      process.execPath, '-e',
      'process.stdout.write(String.fromCharCode(0x4e2d).repeat(60000))',
    ])
    expect(outcome.code).toBe(0)
    expect(outcome.stdoutFull).toHaveLength(60_000)
    expect(outcome.stdoutFull).not.toContain('\uFFFD')
  }, 60_000)

  it('refuses a repeated slot, and still passes a __proto__ slot through', async () => {
    const repo = stubCheckout(PACKS)
    const ctx = await mount(repo)
    const dup = await call(ctx, 'layawebuse_run', { app: 'gen-app', slots: ['cap=1', 'cap=2'] })
    expect(dup.isError).toBe(true)
    expect(JSON.stringify(dup)).toContain('was given more than once')
    // Refused before spawning: the canned CLI never ran, so it never recorded its argv.
    expect(fs.existsSync(path.join(repo, 'argv.json'))).toBe(false)

    // `slots['__proto__'] = v` would write through the prototype setter and silently vanish; the CLI
    // must actually receive it.
    const ok = await call(ctx, 'layawebuse_run', { app: 'gen-app', slots: ['__proto__=x'] })
    expect(ok.isError).toBe(false)
    const argv = JSON.parse(fs.readFileSync(path.join(repo, 'argv.json'), 'utf-8')) as string[]
    expect(argv.join(' ')).toContain('--slot __proto__=x')
  })

  it('accepts an outcome built without stdoutFull, as an older caller would', () => {
    // The field is optional so a JavaScript consumer on the previous shape degrades to the bounded
    // behaviour instead of failing with a raw TypeError.
    const out = tmp('legacy-caller')
    const legacy = { code: 2, stdout: '', stderr: 'boom', timedOut: false }
    expect(() => summarizeRun(out, 'demo', legacy)).toThrow(/run did not reach the artifact stage; cause: boom/)
  })

  it('names a tool step that failed WITHOUT being refused', () => {
    const out = tmp('tool-failure')
    fs.writeFileSync(path.join(out, 'demo-result.json'), JSON.stringify({
      ok: false, completed: '1/2',
      subgoals: [{ desc: 'open', status: 'done' }],
      tool_steps: [{ desc: 'run git log', done: false, code: 3, refused: null }],
      invariants: [],
    }))
    const s = summarizeRun(out, 'demo', proc({ code: 1 }))
    expect(s.ok).toBe(false)
    expect(s.blockedTotal).toBe(0)
    expect(s.refused).toEqual([])
    // Without this the summary would say FAIL 1/2 with no cause at all.
    expect(s.failedTools).toEqual(['run git log: signal not held (exit 3)'])
  })

  it('parses the LAST document when a log line carries a brace and text follows it', () => {
    const stdout = '  step 1: click a "Cart {badge}" (clicked, conf=1.00)\n'
      + '{\n  "status": "ok",\n  "app": "a",\n  "steps": 1,\n  "verified": true,\n'
      + '  "replay": { "forwards": 0, "completed": "1/1", "invariants": "1/1" }\n}\n'
      + 'recorded 1 step(s)\n'
    expect(parseJsonDocument(stdout)).toMatchObject({ app: 'a', status: 'ok' })
    expect(summarizeLearn(stdout)).toMatchObject({ app: 'a', verified: true, forwards: 0 })
    // The old first-brace rule returned the nested `replay` object here, or threw.
    expect(parseJsonDocument(stdout)?.['steps']).toBe(1)
  })

  it('lists a declared data-source app that has no pack.json', () => {
    const repo = stubCheckout(PACKS)
    stubDataSource(repo, 'git-log')
    expect(listApps(repo).find(a => a.id === 'git-log')).toMatchObject({
      id: 'git-log', label: 'git-log', steps: 0, toolSteps: 0, invariants: 0, origin: 'data-source',
    })
  })

  it('counts a tool step a role template introduces, the way the checkout does', () => {
    const repo = stubCheckout({
      'role-tool': {
        id: 'role-tool', label: 'r', goal: 'g',
        roles: { writer: { source: 'git-log' } },
        journey: [{ role: 'writer' }, { role: 'plain' }],
      },
    })
    expect(listApps(repo).find(a => a.id === 'role-tool')).toMatchObject({ steps: 1, toolSteps: 1 })
  })

  it('refuses …_learn without a script BEFORE spawning the CLI', async () => {
    const repo = stubCheckout(PACKS)
    const ctx = await mount(repo)
    const result = await call(ctx, 'layawebuse_learn', { url: 'testpages/product.html', goal: 'x' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toMatch(/script/i)
    expect(fs.existsSync(path.join(repo, SPAWN_MARKER))).toBe(false)
  })

  it('executes a dry run through the registry and renders it as DRY, not PASS/FAIL', async () => {
    const ctx = await mount(stubCheckout(PACKS))
    const result = await call(ctx, 'layawebuse_run', { app: 'gen-app', dry: true })
    expect(result.isError).toBe(false)
    const value = result.value as { dry: boolean; ok: boolean; planSteps: number; plan: unknown[] }
    expect(value).toMatchObject({ dry: true, ok: true, planSteps: 2 })
    expect(value.plan).toHaveLength(2)
    const text = JSON.stringify(result)
    expect(text).toContain('DRY 2 step(s) expanded')
    expect(text).not.toContain('PASS')
  })

  it('expands a long journey through the registry, whose plan exceeds the output window', async () => {
    const ctx = await mount(stubCheckout(PACKS, { drySteps: 60 }))
    const result = await call(ctx, 'layawebuse_run', { app: 'gen-app', dry: true })
    // Before the full-stdout fix this reported "run did not reach the artifact stage": the plan was
    // cut by the display window and could no longer be parsed.
    expect(result.isError).toBe(false)
    const value = result.value as { dry: boolean; planSteps: number; plan: unknown[] }
    expect(value.dry).toBe(true)
    expect(value.planSteps).toBe(60)
    expect(value.plan).toHaveLength(40)
  })

  it('reads a learn document that is larger than the display excerpt', async () => {
    const ctx = await mount(stubCheckout(PACKS, { learnBig: true }))
    const result = await call(ctx, 'layawebuse_learn', {
      url: 'testpages/product.html', goal: 'add to cart', script: '/tmp/actions.json',
    })
    // A long recorded flow's document overflows the 1200 + 800 byte window; parsing the excerpt
    // instead of the full stdout turned that into "learn printed no JSON document".
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ status: 'ok', verified: true, forwards: 0 })
  })
})

describe('environment and artifact policy', () => {
  it('buildEnv inherits by default; allowlist strips session secrets, keeps the run essentials', () => {
    process.env.LAYAWEBUSE_BRIDGE_TEST = 'engine-facing'
    process.env.BRIDGE_TEST_ONLY_KEY = 'forward-me'
    try {
      const inherit = buildEnv({ ...OPTIONS, envMode: 'inherit' })
      expect(inherit.BRIDGE_TEST_ONLY_KEY).toBe('forward-me')
      const allow = buildEnv({ ...OPTIONS, envMode: 'allowlist' })
      expect(allow.PATH).toBe(process.env.PATH)
      expect(allow.HOME).toBe(process.env.HOME)
      expect(allow.LAYAWEBUSE_BRIDGE_TEST).toBe('engine-facing') // LAYAWEBUSE_* always travels
      expect(allow.BRIDGE_TEST_ONLY_KEY).toBeUndefined()
      const withForward = buildEnv({ ...OPTIONS, envMode: 'allowlist', forwardEnv: ['BRIDGE_TEST_ONLY_KEY'] })
      expect(withForward.BRIDGE_TEST_ONLY_KEY).toBe('forward-me')
    } finally {
      delete process.env.LAYAWEBUSE_BRIDGE_TEST
      delete process.env.BRIDGE_TEST_ONLY_KEY
    }
  })

  it('pruneRunDirs keeps the newest N, spares young and foreign directories', () => {
    const root = tmp('prune')
    const mk = (name: string, ageMs: number) => {
      const d = path.join(root, name)
      fs.mkdirSync(d)
      const t = new Date(Date.now() - ageMs)
      fs.utimesSync(d, t, t)
      return d
    }
    const old1 = mk('dsh-layawebuse-run-old1', 48 * 3_600_000)
    const old2 = mk('dsh-layawebuse-learn-old2', 24 * 3_600_000)
    const young = mk('dsh-layawebuse-run-young', 60_000)
    const foreign = mk('unrelated-dir', 48 * 3_600_000)
    expect(pruneRunDirs(1, 3_600_000, root)).toBe(2)
    expect(fs.existsSync(old1)).toBe(false)
    expect(fs.existsSync(old2)).toBe(false)
    expect(fs.existsSync(young)).toBe(true)
    expect(fs.existsSync(foreign)).toBe(true)
    expect(pruneRunDirs(0, 0, root)).toBe(0)
  })
})

describe('checkout resolution: config > LAYAWEBUSE_REPO > self-locate', () => {
  it('findCheckout walks up to the ancestor holding src/app-runner.ts', () => {
    const repo = stubCheckout(PACKS)
    const deep = path.join(repo, 'integrations', 'dsh-bridge', 'src')
    fs.mkdirSync(deep, { recursive: true })
    expect(Bridge.findCheckout(deep)).toBe(fs.realpathSync(repo))
    expect(Bridge.findCheckout(tmp('nowhere'))).toBeUndefined()
  })

  it('an explicit config repoPath wins over the environment', async () => {
    process.env.LAYAWEBUSE_REPO = '/does/not/exist'
    try {
      const ctx = await mount(stubCheckout(PACKS))
      const result = await call(ctx, 'layawebuse_apps', {})
      expect(result.isError).toBe(false)
    } finally {
      delete process.env.LAYAWEBUSE_REPO
    }
  })

  it('LAYAWEBUSE_REPO decides when the config omits repoPath', async () => {
    const repo = stubCheckout(PACKS)
    process.env.LAYAWEBUSE_REPO = repo
    try {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(Bridge, {})
      const result = await call(ctx, 'layawebuse_apps', {})
      expect(result.isError).toBe(false)
      expect((result.value as { apps: unknown[] }).apps.length).toBeGreaterThan(0)
    } finally {
      delete process.env.LAYAWEBUSE_REPO
    }
  })

  it('with neither config nor env, the plugin self-locates its own checkout (git-install shape)', async () => {
    // The specs run inside the LayaWebUse repo, so the module's ancestors ARE a checkout — the same
    // resolution a git-installed bundle performs against its clone.
    delete process.env.LAYAWEBUSE_REPO
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(Bridge, {})
    const result = await call(ctx, 'layawebuse_apps', { filter: 'demo-app' })
    expect(result.isError).toBe(false)
    expect((result.value as { apps: { id: string }[] }).apps.map(a => a.id)).toContain('demo-app')
  })
})
