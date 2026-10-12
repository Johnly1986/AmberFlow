/**
 * The plugin-to-plugin seam: another plugin `inject`s `amberflow` and calls the engine directly,
 * without going through the tool registry. These tests mount a real consumer plugin next to the
 * bridge and assert that both doors run the SAME code — same options, same deployment gate, same
 * diagnostics — so neither can drift from the other.
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Bridge from '@deepseek-ai/dsh-amberflow-bridge'
// The package ROOT must carry the helpers: a published package ships only `lib/`, never `src/`.
import { firstLines, stripAnsi, summarizeLearn, type AmberFlowService } from '@deepseek-ai/dsh-amberflow-bridge'
import { cleanupTmp, PACKS, SPAWN_MARKER, stubCheckout } from './stub.ts'

afterEach(cleanupTmp)

/** A consumer plugin, written the way a real plugin would be: inject the service, use it. */
function consumerPlugin(seen: { api?: AmberFlowService }) {
  return {
    name: 'amberflow-consumer',
    inject: ['amberflow'],
    apply(ctx: Context): void {
      seen.api = ctx.amberflow
    },
  }
}

async function mount(repoPath: string): Promise<{ api: AmberFlowService; ctx: Context }> {
  const ctx = new Context()
  const seen: { api?: AmberFlowService } = {}
  // The bridge injects `tools` (it registers the three tools), so a deployment mounts the registry;
  // the service then comes up with it, and the consumer injects the service.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Bridge, { repoPath, appsHome: '/nonexistent-amberflow-test-home' })
  await ctx.plugin(consumerPlugin(seen))
  if (seen.api === undefined) throw new Error('the consumer never received ctx.amberflow')
  return { api: seen.api, ctx }
}

describe('service seam (plugin to plugin)', () => {
  it('is provided by the bridge and injectable by a consumer', async () => {
    const { api } = await mount(stubCheckout(PACKS))
    expect(typeof api.listApps).toBe('function')
    expect(typeof api.run).toBe('function')
    expect(typeof api.learn).toBe('function')
  })

  it('lists apps with the same filtering the tool applies', async () => {
    const { api } = await mount(stubCheckout(PACKS))
    expect(api.listApps().map(a => a.id)).toEqual(['gen-app', 'hand-app', 'rec-app'])
    expect(api.listApps('rec').map(a => a.id)).toEqual(['rec-app'])
    expect(api.listApps('generated').map(a => a.origin)).toEqual(['generated:transfer/specs/x.json'])
  })

  it('runs an app through the CLI and returns the compact summary', async () => {
    const { api } = await mount(stubCheckout(PACKS))
    const summary = await api.run({ app: 'gen-app', noModel: true })
    expect(summary.ok).toBe(true)
    expect(summary.completed).toBe('2/2')
    expect(summary.blocked).toEqual([{ desc: 'add to cart', obstacle: 'hint matched nothing' }])
    expect(summary.invariants).toEqual({ held: 1, total: 2, failed: ['total-shown'] })
  })

  it('applies the deployment gate to the service call, not only to the tool', async () => {
    const { api } = await mount(stubCheckout(PACKS))
    await expect(api.run({ app: 'gen-app', allowDangerous: true }))
      .rejects.toThrow(/does not permit dangerous tool steps/)
  })

  it('learns a flow and reports the rules-only replay, with an absolute saved path', async () => {
    const repo = stubCheckout(PACKS)
    const { api } = await mount(repo)
    const summary = await api.learn({
      url: 'testpages/product.html', goal: 'add to cart', script: '/tmp/actions.json',
    })
    expect(summary).toMatchObject({
      status: 'ok', app: 'stub-app', steps: 2, verified: true, forwards: 0,
    })
    // The CLI answers relative to the checkout; the seam hands back something a caller can read.
    expect(summary.saved).toBe(path.join(repo, 'apps', 'stub-app', 'pack.json'))
  })

  it('refuses learn without a script before spawning, and says why', async () => {
    const repo = stubCheckout(PACKS)
    const { api } = await mount(repo)
    // A plain-JavaScript consumer can omit a field the type marks required; the refusal must be the
    // same sentence the tool gives, not a browser launch that fails a minute later.
    await expect(api.learn({ url: 'testpages/product.html', goal: 'x' } as never))
      .rejects.toThrow(/needs a recorded action list/)
    await expect(api.learn({ url: 'testpages/product.html', goal: 'x', script: '' }))
      .rejects.toThrow(/needs a recorded action list/)
    expect(fs.existsSync(path.join(repo, SPAWN_MARKER))).toBe(false)
  })

  it('reports a failing learn as its cause, exactly like the tool does', async () => {
    const { api } = await mount(stubCheckout(PACKS, { learnFails: true }))
    const args = { url: 'testpages/missing.html', goal: 'x', script: '/tmp/actions.json' }
    await expect(api.learn(args)).rejects.toThrow(/ERR_FILE_NOT_FOUND/)
    await expect(api.learn(args)).rejects.not.toThrow(/usage:/)
  })
})

describe('package root surface', () => {
  it('re-exports the helpers a published consumer can import', () => {
    expect(stripAnsi('\u001B[31mred\u001B[39m')).toBe('red')
    expect(firstLines('cause\nusage: tool')).toBe('cause')
    expect(() => summarizeLearn('')).toThrow(/printed no JSON document/)
  })
})
