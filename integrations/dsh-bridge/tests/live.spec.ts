/**
 * Live tests: the bridge driving the REAL AmberFlow checkout through the tool registry.
 *
 * They are skipped — loudly, with the reason printed — when the checkout or a chromium build is not
 * present on this machine, so a checkout-less CI reports "skipped", never "passed".
 *
 * Point `AMBERFLOW_REPO` at the checkout to run them; the default is the development path.
 */
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as Bridge from '@deepseek-ai/dsh-amberflow-bridge'

// The bridge lives inside the engine repo, so the checkout is simply three levels up;
// AMBERFLOW_REPO (or the pre-rename LAYAWEBUSE_REPO) overrides it for split layouts.
const REPO = process.env['AMBERFLOW_REPO'] ?? process.env['LAYAWEBUSE_REPO']
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const HAS_REPO = fs.existsSync(path.join(REPO, 'src', 'app-runner.ts'))
/**
 * Written straight to stderr: Vitest intercepts `console.*` during collection, so a `console.warn`
 * here is swallowed and the "skipped with the reason printed" contract would be a lie.
 * @param reason - the skip reason to print.
 */
function warnSkipped(reason: string): void {
  process.stderr.write(`[amberflow-bridge] ${reason}\n`)
}
if (!HAS_REPO) {
  warnSkipped(`live tests SKIPPED: no checkout at ${REPO} (set AMBERFLOW_REPO)`)
}

/** A chromium that Playwright can launch, or null (the browser test is skipped without one). */
function chromiumAvailable(): string | null {
  const roots = [
    process.env['PLAYWRIGHT_BROWSERS_PATH'],
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ].filter((p): p is string => Boolean(p))
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root)) {
      if (!entry.startsWith('chromium-')) continue
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const bin = path.join(root, entry, rel)
        if (fs.existsSync(bin)) return bin
      }
    }
  }
  return null
}

const CHROMIUM = chromiumAvailable()
if (HAS_REPO && !CHROMIUM) {
  warnSkipped('the browser test will be SKIPPED: no chromium under the Playwright cache')
}

let counter = 0
async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Bridge, { repoPath: REPO })
  return ctx
}

function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-live-${++counter}`),
    name,
    arguments: args,
    agent: { session: { header: {} } } as never,
  })
}

describe.skipIf(!HAS_REPO)('live checkout', () => {
  it('lists the real apps and reports where each pack came from', async () => {
    const ctx = await mount()
    const result = await call(ctx, 'amberflow_apps', {})
    expect(result.isError).toBe(false)
    const { apps } = result.value as { apps: { id: string; origin: string; steps: number }[] }
    expect(apps.length).toBeGreaterThanOrEqual(15)
    const recorded = apps.find(a => a.id === 'learned-cart')
    expect(recorded, 'the recorded example app should be part of the checkout').toBeDefined()
    expect(recorded!.origin).toBe('recorded:testpages/product.html')
    expect(apps.some(a => a.origin.startsWith('generated:'))).toBe(true)
    expect(apps.some(a => a.origin === 'hand-written')).toBe(true)
  }, 60_000)

  it('filters by substring across id, label and goal', async () => {
    const ctx = await mount()
    const result = await call(ctx, 'amberflow_apps', { filter: 'learned' })
    const { apps } = result.value as { apps: { id: string }[] }
    expect(apps.map(a => a.id)).toContain('learned-cart')
  }, 60_000)
})

describe.skipIf(!HAS_REPO || !CHROMIUM)('live checkout + browser', () => {
  it('runs a real app end to end and returns the failure-only summary', async () => {
    const ctx = await mount()
    const result = await call(ctx, 'amberflow_run', {
      app: 'learned-cart',        // 2 browser steps recorded from a demonstration
      no_model: true,             // rules only: this run must not need the decision model at all
      no_sources: true,
    })
    expect(result.isError).toBe(false)
    const value = result.value as {
      ok: boolean
      dry: boolean
      completed: string
      blockedTotal: number
      timedOut: boolean
      invariants: { held: number; total: number; failed: string[] }
      reportPath: string
    }
    expect(value.timedOut).toBe(false)
    expect(value.dry).toBe(false)
    expect(value.completed).toBe('2/2')
    expect(value.blockedTotal).toBe(0)
    expect(value.invariants.total).toBeGreaterThan(0)
    expect(value.invariants.failed).toEqual([])
    expect(value.ok).toBe(true)
    expect(fs.existsSync(value.reportPath), 'the run report should exist on disk').toBe(true)
  }, 300_000)

  it('expands a plan for `dry` instead of reporting a missing artifact', async () => {
    const ctx = await mount()
    const result = await call(ctx, 'amberflow_run', { app: 'learned-cart', dry: true })
    // Before the fix this was an error: the real CLI writes no artifact for `--dry` and exits 0.
    expect(result.isError).toBe(false)
    const value = result.value as {
      dry: boolean
      planSteps: number
      plan: { index: number; kind: string; desc: string }[]
      reportPath: string
    }
    expect(value.dry).toBe(true)
    expect(value.planSteps).toBe(2)
    expect(value.plan.map(s => s.kind)).toEqual(['browser', 'browser'])
    expect(value.plan[0]!.desc).toContain('Add to cart')
    expect(value.reportPath).toBe('')
  }, 120_000)

  it('reports FAIL when a real run really fails, with the blocked step named', async () => {
    const ctx = await mount()
    // A price cap the fixture site cannot apply: the run must end non-zero with a blocked subgoal.
    const result = await call(ctx, 'amberflow_run', {
      app: 'transfer-flyquest', no_model: true, no_sources: true, slots: ['cap=999'],
    })
    expect(result.isError).toBe(false)
    const value = result.value as {
      ok: boolean
      blockedTotal: number
      blocked: { desc: string; obstacle: string }[]
    }
    expect(value.ok).toBe(false)
    expect(value.blockedTotal).toBeGreaterThan(0)
    expect(value.blocked[0]!.obstacle).not.toBe('')
  }, 300_000)
})

/** The checkout's own default graph location (`src/laya-onnx.ts`), needed only by the recording test. */
const ONNX = process.env['LAYA_ONNX_MODEL'] ?? process.env['LAYAA_ONNX_MODEL'] ?? '/tmp/laya_dec.onnx'
const HAS_MODEL = fs.existsSync(ONNX)
if (HAS_REPO && CHROMIUM !== null && !HAS_MODEL) {
  warnSkipped(`the learn-recording test will be SKIPPED: no ONNX graph at ${ONNX}`)
}
if (HAS_REPO && CHROMIUM === null) {
  warnSkipped('the learn-recording test will be SKIPPED too: it drives a browser')
}

describe.skipIf(!HAS_REPO)('live checkout + learn', () => {
  it('refuses to spawn anything when a non-interactive call has no script', async () => {
    const ctx = await mount()
    const started = Date.now()
    const result = await call(ctx, 'amberflow_learn', {
      url: 'testpages/product.html', goal: 'add the wireless mouse to the cart',
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toMatch(/script/i)
    // A spawn would have launched a browser and cost seconds; the refusal is immediate.
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 60_000)

  it.skipIf(!HAS_MODEL || CHROMIUM === null)('records a flow from a script and reports the zero-forward replay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amberflow-live-learn-'))
    const script = path.join(dir, 'actions.json')
    fs.writeFileSync(script, JSON.stringify([
      { op: 'click', hint: '[data-test=add-to-cart]', label: 'Add to cart' },
      { op: 'click', hint: '[data-test=cart-link]', label: 'Cart' },
    ]))
    const ctx = await mount()
    const result = await call(ctx, 'amberflow_learn', {
      url: 'testpages/product.html',
      goal: 'add the wireless mouse to the cart',
      id: 'live-learn-probe',
      script,
      pack_dir: path.join(dir, 'packs'),   // never write the pack into the checkout under test
    })
    expect(result.isError).toBe(false)
    const value = result.value as {
      status: string
      steps: number
      verified: boolean
      forwards: number
      completed: string
      saved: string
    }
    expect(value.status).toBe('ok')
    expect(value.steps).toBe(2)
    expect(value.verified).toBe(true)
    expect(value.forwards).toBe(0)        // the save is gated on a rules-only replay
    expect(value.completed).toBe('2/2')
    expect(path.isAbsolute(value.saved), 'saved should be an absolute, readable path').toBe(true)
    expect(fs.existsSync(value.saved)).toBe(true)
    expect(value.saved.startsWith(REPO + path.sep), 'the pack must not land inside the checkout').toBe(false)
  }, 300_000)
})
