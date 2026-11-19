/**
 * 桥层透传回归 harness（BACKLOG §15）：`node --test` + fake-engine JSONL 缝
 * （SessionManager 的 `spawnArgv` 测试缝——真跑桥面投影代码，不经网络、不启浏览器）。
 *
 * 断言组（白名单投影丢字段类回归在此被拦——wide_scan 桥面不可达事故的回归面）：
 *   1. act 失败 `wide_scan` 有界透传：hint 行优先、≤40 行、tag/label/hint clip、pool_size 如实、
 *      引擎不带键 = 桥结果缺键（形状不变）；
 *   2. `ambiguity` 两面：失败面 `ambiguityEvidence`（≤5 行 + suggested_hint ≤200）与成功面
 *      `matched_others`（≤3 行）+ 弱档标记；
 *   3. snapshot `window` 审计块（windowAudit/dedup_dropped）有界透传 + 缺键形状不变；
 *   4. open/goto 基础往返（成功形状 + engineFailure 投影）。
 *
 * 运行：`npm run bridge:test`（主仓 check 链一步；离线、进程内、确定性）。设计纪律：
 * fake-engine 经 stdio 管道子进程驱动——本仓探针已验证该形态可行；若某环境管道受限
 * （EPERM），该环境应改跑 stdio inherit + 文件中转的等价形态，不改断言语义。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { SessionManager, handleSessionTool } from '../src/session.ts'
import type { BridgeOptions } from '../src/bridge.ts'
import type { SessionToolArgs } from '../src/session.ts'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..')
const FAKE = path.join(import.meta.dirname, 'fake-engine.cjs')

interface Route { type?: string; targetIncludes?: string; urlIncludes?: string; respond: Record<string, unknown> }
interface Scenario { autoOpen?: Record<string, unknown>; routes?: Route[] }

interface Harness {
  sid: string
  call(args: Partial<SessionToolArgs>): Promise<Record<string, unknown>>
  dispose(): Promise<void>
}

/** 起一个挂 fake-engine 的管理器（scenario 落盘到临时目录，env 注入；用完 dispose）。 */
async function withHarness(scenario: Scenario, body: (h: Harness) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-bridge-test-'))
  // 真 CLI 由 --url argv 自行 open：fake 必须在 spawn 后主动发出无 id 的 auto-open 响应
  //（readyWaiter 等它）；scenario 未给 = 缺省成功 open（个别测试可覆盖）。
  const full: Scenario = {
    autoOpen: { ok: true, url: 'http://fixture.local/page', hosts: ['fixture.local'] },
    ...scenario,
  }
  const scenarioPath = path.join(dir, 'scenario.json')
  fs.writeFileSync(scenarioPath, JSON.stringify(full))
  const bridge = {
    repoPath: dir, nodeBin: process.execPath, timeoutMs: 60_000, allowDangerous: false,
    toolPrefix: 'amberflow', envMode: 'inherit', forwardEnv: [],
    decisionModel: { endpoint: '', apiKey: '', model: '' },
    headful: false, appsEnv: {},
  } as unknown as BridgeOptions
  const manager = new SessionManager({
    bridge,
    evidenceRoot: path.join(dir, 'evidence'),
    idleMs: 60_000,
    env: { AF_FAKE_SCENARIO: scenarioPath, AF_FAKE_TRACE: path.join(dir, 'fake-trace.log') },
    spawnArgv: () => [process.execPath, FAKE],
  })
  try {
    const open = await handleSessionTool({ op: 'open', url: 'http://fixture.local/page' } as SessionToolArgs, manager)
    assert.equal(open.ok, true, `open must succeed: ${JSON.stringify(open)}`)
    const sid = String(open.session_id)
    await body({
      sid,
      call: (args) => handleSessionTool({ ...args, session_id: sid } as SessionToolArgs, manager),
      dispose: () => manager.dispose(),
    })
  } finally {
    await manager.dispose()
  }
}

const wideScanResponse = (rows: Array<Record<string, unknown>>): Record<string, unknown> => ({
  ok: false, code: 'target_not_found', reason: 'no match', executed: false,
  url: 'http://fixture.local/page',
  wide_scan: { window: 128, pool_size: 45, candidates: rows },
})

test('wide_scan：hint 行优先 + ≤40 行裁剪 + clip + pool_size 如实', async () => {
  const rows: Array<Record<string, unknown>> = [{ ref: 'e0', tag: 'button', label: 'x'.repeat(60) }]
  for (let i = 1; i < 50; i++) rows.push({ ref: `e${i}`, tag: 'button', label: `row-${i}` })
  rows.push({ ref: 'eZ', tag: 'button', label: '结账', hint: 'h'.repeat(300) })   // hint 行在末尾：桥应提到首位
  await withHarness({
    routes: [{ type: 'act', targetIncludes: 'missing', respond: wideScanResponse(rows) }],
  }, async (h) => {
    const r = await h.call({ op: 'act', act_op: 'click', target: 'missing-target' })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'target_not_found')
    const w = r['wide_scan'] as Record<string, unknown>
    assert.ok(w !== undefined, 'wide_scan must reach the bridge result')
    assert.equal(w['window'], 128)
    assert.equal(w['pool_size'], 45, 'pool_size must keep the unfiltered total')
    const out = w['candidates'] as Array<Record<string, unknown>>
    assert.equal(out.length, 40, 'candidates must be capped at 40 rows')
    assert.equal((out[0] as Record<string, unknown>)['ref'], 'eZ', 'hint-bearing row must be surfaced first')
    assert.equal(String((out[0] as Record<string, unknown>)['hint']).length, 200, 'hint must be clipped to 200')
    assert.ok(String((out[0] as Record<string, unknown>)['label']).length <= 40, 'label must be clipped to 40')
  })
})

test('wide_scan：引擎不带键 = 桥结果缺键（形状不变）', async () => {
  await withHarness({
    routes: [{ type: 'act', targetIncludes: 'nomal', respond: { ok: false, code: 'action_failed', reason: 'probe failed', executed: false, url: 'http://fixture.local/page' } }],
  }, async (h) => {
    const r = await h.call({ op: 'act', act_op: 'click', target: 'nomal-target' })
    assert.equal(r.code, 'action_failed')
    assert.ok(!('wide_scan' in r), 'no engine key = no bridge key')
  })
})

test('ambiguity：失败面证据有界透传（≤5 行 + suggested_hint ≤200）', async () => {
  await withHarness({
    routes: [{
      type: 'act', targetIncludes: 'amb',
      respond: {
        ok: false, code: 'target_ambiguous', executed: false, url: 'http://fixture.local/page',
        ambiguity: {
          target: 'amb-target', source: 'pool', tier: 0, would_act_ref: 'e3',
          candidates_total: 8, truncated: false,
          candidates: Array.from({ length: 7 }, (_, i) => ({
            ref: `e${i}`, tag: 'button', label: `订票-${i}`, same_label: true,
            suggested_hint: `订票 row-index:${i + 1}`,
          })),
        },
      },
    }],
  }, async (h) => {
    const r = await h.call({ op: 'act', act_op: 'click', target: 'amb-target' })
    assert.equal(r.code, 'target_ambiguous')
    const amb = r['ambiguity'] as Record<string, unknown>
    assert.ok(amb !== undefined, 'ambiguity must reach the bridge result')
    const rows = amb['candidates'] as Array<Record<string, unknown>>
    assert.ok(rows.length <= 5, `candidates must be capped at 5, got ${rows.length}`)
    for (const row of rows) {
      assert.ok(String(row['suggested_hint']).length <= 200, 'suggested_hint must be clipped to 200')
    }
  })
})

test('ambiguity：成功面 matched_others ≤3 + 弱档标记', async () => {
  await withHarness({
    routes: [{
      type: 'act', targetIncludes: 'weakok',
      respond: {
        ok: true, executed: true, ref: 'e1', how: 'clicked', changed: true,
        url: 'http://fixture.local/page',
        matched_others: [
          { ref: 'e2', tag: 'button', class: 'btn-a', label: '关闭' },
          { ref: 'e3', tag: 'button', class: 'btn-b', label: '关闭' },
          { ref: 'e4', tag: 'div', class: 'btn-c', label: '关闭' },
          { ref: 'e5', tag: 'span', class: 'btn-d', label: '关闭' },
        ],
        hint_kind: 'bare', hint_tier: 3, hint_suspicious: true,
      },
    }],
  }, async (h) => {
    const r = await h.call({ op: 'act', act_op: 'click', target: 'weakok-target' })
    assert.equal(r.ok, true)
    assert.equal(r.ref, 'e1')
    const others = r['matched_others'] as Array<Record<string, unknown>>
    assert.ok(Array.isArray(others) && others.length === 3, `matched_others must be capped at 3, got ${others.length}`)
    assert.equal(r['hint_kind'], 'bare')
    assert.equal(r['hint_tier'], 3)
    assert.equal(r['hint_suspicious'], true)
  })
})

test('snapshot window：windowAudit/dedup_dropped 有界透传', async () => {
  await withHarness({
    routes: [{
      type: 'snapshot',
      respond: {
        ok: true, url: 'http://fixture.local/page', title: 'Fixture',
        snapshot_file: 'snapshot-1.json', pool_file: 'pool-1.json',
        counts: { pool: 64, text_chars: 1200, frames: 1 },
        window: {
          visible_interactive: 96, shown: 64, out_of_window_total: 12,
          out_of_window: [{ tag: 'a', label: '页脚链接', prio: 2, bucket: 'contentNear' }],
          dedup_dropped: [
            { tag: 'button', label: '登录', why: 'label-dup' },
            { tag: 'i', label: '', why: 'empty-child' },
          ],
          surface_counts: { 'native-control': 80, 'aria-role': 5 },
        },
      },
    }],
  }, async (h) => {
    const withWindow = await h.call({ op: 'snapshot' })
    const w = withWindow['window'] as Record<string, unknown>
    assert.ok(w !== undefined, 'window audit must reach the bridge snapshot result')
    assert.equal(w['visible_interactive'], 96)
    assert.equal(w['out_of_window_total'], 12)
    const drops = w['dedup_dropped'] as Array<Record<string, unknown>>
    assert.equal(drops.length, 2)
    assert.equal(drops[0]['why'], 'label-dup')
    assert.equal((w['surface_counts'] as Record<string, number>)['native-control'], 80)
  })
})

test('snapshot window：引擎不带键 = 桥结果缺键（形状不变）', async () => {
  await withHarness({
    routes: [{
      type: 'snapshot',
      respond: { ok: true, url: 'http://fixture.local/plain', title: 'Plain', snapshot_file: 's.json', pool_file: 'p.json', counts: { pool: 3 } },
    }],
  }, async (h) => {
    const without = await h.call({ op: 'snapshot' })
    assert.ok(!('window' in without), 'no engine key = no bridge key')
    assert.equal((without['counts'] as Record<string, unknown>)['pool'], 3)
  })
})

test('open/goto：基础往返 + engineFailure 投影', async () => {
  await withHarness({
    routes: [
      { type: 'goto', urlIncludes: 'page2', respond: { ok: true, url: 'http://fixture.local/page2', title: 'Page 2' } },
      { type: 'goto', urlIncludes: 'dead', respond: { ok: false, code: 'unreachable', reason: 'page.goto: net::ERR' } },
    ],
  }, async (h) => {
    const ok = await h.call({ op: 'goto', url: 'http://fixture.local/page2' })
    assert.equal(ok.ok, true)
    assert.equal(ok.url, 'http://fixture.local/page2')
    assert.equal(ok.title, 'Page 2')
    const fail = await h.call({ op: 'goto', url: 'http://fixture.local/dead' })
    assert.equal(fail.ok, false)
    assert.equal(fail.code, 'unreachable')
    assert.equal(fail['session_alive'], true)
    assert.ok(typeof fail.reason === 'string' && fail.reason.length > 0)
  })
})
