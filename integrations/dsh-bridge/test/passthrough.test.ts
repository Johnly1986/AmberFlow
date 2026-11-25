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

interface Route { type?: string; targetIncludes?: string; urlIncludes?: string; lineIncludes?: string; respond: Record<string, unknown> }
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

/* ---- 4.5 `amberflow_session` 的 drive 扩展：与 session 共用同一 page 的 pilot 驾驶 ---- */

test('session drive：参数闭集（goal/max_steps/driver/cmd/conf_floor）', async () => {
  await withHarness({}, async (h) => {
    const noGoal = await h.call({ op: 'drive' })
    assert.equal(noGoal.ok, false)
    assert.equal(noGoal.code, 'config_error')
    const badSteps = await h.call({ op: 'drive', goal: 'open detail', max_steps: 0 })
    assert.equal(badSteps.code, 'config_error')
    const badDriver = await h.call({ op: 'drive', goal: 'open detail', driver: 'wizard' as never })
    assert.equal(badDriver.code, 'config_error')
    const badFloor = await h.call({ op: 'drive', goal: 'open detail', conf_floor: 2 })
    assert.equal(badFloor.code, 'config_error')
    const badCmd = await h.call({ op: 'drive_command', cmd: 'fly' as never })
    assert.equal(badCmd.code, 'config_error')
  })
})

test('session drive：有界投影（白名单 + handoff/events 裁剪 + 不泄露池/槽值）', async () => {
  const handoff = {
    stop_code: 'low_confidence', step_id: 3, url: 'http://fixture.local/page',
    why_stuck: { summary: 'low_confidence @ step 3 — no clickable candidate', evidence: { inert_run: 0 } },
    what_would_unblock: ['resume 带 hint 点名', 'redirect 换目标', 'third', 'fourth'],
    evidence_refs: { screenshot: '/tmp/h3.png', dom: '/tmp/h3.dom.html', pool_snapshot: '/tmp/h3.pool.json', observe: '/tmp/h3.observe.json' },
    pool: ['LEAK'], candidates: ['LEAK'],
  }
  const events = Array.from({ length: 30 }, (_, i) => ({
    type: 'drive', step: i, op: 'click', target: `t-${i}`, ok: true, changed: i % 2 === 0,
    url: 'http://fixture.local/page', conf: 0.8, pool: ['LEAK'], candidates: ['LEAK'],
  }))
  await withHarness({
    routes: [{
      type: 'drive',
      respond: {
        ok: true, status: 'handoff', stop_code: 'low_confidence', url: 'http://fixture.local/detail',
        steps: 3, model_asks: 4, out_dir: '/tmp/pilot-run-1', session_id: 'engine-echo',
        pilot: true, attached: true, terminal: false,
        handoff, events, pool: ['LEAK'], candidates: ['LEAK'], slots: { secret: 'LEAK' },
      },
    }],
  }, async (h) => {
    const r = await h.call({ op: 'drive', goal: 'open the first detail', max_steps: 5, driver: 'model', expect_url: '/page' })
    assert.equal(r.ok, true)
    assert.equal(r.status, 'handoff')
    assert.equal(r.stop_code, 'low_confidence')
    assert.equal(r.url, 'http://fixture.local/detail')
    assert.equal(r.steps, 3)
    assert.equal(r.model_asks, 4)
    assert.equal(r.out_dir, '/tmp/pilot-run-1')
    assert.equal(r.session_id, h.sid, 'session_id is the join key, not the engine echo')
    assert.equal(r.op, 'drive')
    assert.equal(r.pilot, true)
    assert.equal(r.attached, true)
    assert.equal(r.terminal, false)
    const ho = r.handoff as Record<string, unknown>
    assert.equal(ho.step_id, 3)
    assert.ok(String(ho.summary).length <= 300)
    assert.equal((ho.what_would_unblock as string[]).length, 3, 'what_would_unblock capped at 3')
    assert.ok(!('pool' in ho) && !('candidates' in ho))
    const ev = r.events as Array<Record<string, unknown>>
    assert.equal(ev.length, 20, 'events capped at 20')
    assert.ok(!('pool' in ev[0]!) && !('candidates' in ev[0]!))
    assert.ok(!('pool' in r) && !('candidates' in r) && !('slots' in r), 'engine extras must not leak')
  })
})

test('session drive：结束态可见性（weak_picks/final_signal/conf_floor）有界投影', async () => {
  const handoff = {
    stop_code: 'needs_value', step_id: 2, goal_digest: 'find a restaurant',
    why_stuck: { summary: 'needs_value @ step 2', evidence: { needs_value: { key: 'q' } } },
    what_would_unblock: ['resume 带 value'],
    evidence_refs: { screenshot: '/tmp/h2.png' },
    final_signal: null,
    weak_picks: Array.from({ length: 8 }, (_, i) => ({
      step: i + 1, target: `t-${String(i)}`, conf: 0.1, picked_by: 'model', pool: ['LEAK'],
    })),
    pool: ['LEAK'],
  }
  await withHarness({
    routes: [
      { type: 'drive', respond: { ok: true, status: 'handoff', stop_code: 'needs_value', steps: 2, url: 'http://fixture.local/page', handoff } },
      { type: 'driveClose', respond: {
        ok: true, status: 'closed', closed: true,
        summary: { type: 'pilot_end', pilot: true, stop_code: 'needs_value', steps: 2, conf_floor: 0.2, max_steps: 5 },
      } },
    ],
  }, async (h) => {
    const r = await h.call({ op: 'drive', goal: 'find a restaurant' })
    const ho = r.handoff as Record<string, unknown>
    const picks = ho.weak_picks as Array<Record<string, unknown>>
    assert.ok(Array.isArray(picks), 'weak_picks reach the caller')
    assert.equal(picks.length, 6, 'weak_picks are capped at 6')
    assert.deepEqual(picks[0], { step: 1, target: 't-0', conf: 0.1, picked_by: 'model' },
      'weak pick rows are whitelisted (no pool/candidates leak)')
    assert.ok(!('pool' in picks[0]!))
    assert.equal(ho.final_signal, null, 'the unverified end-state fact is visible')
    assert.equal(ho.goal_digest, 'find a restaurant', 'the active goal digest is echoed')
    const cl = await h.call({ op: 'drive_close' })
    const sm = cl.summary as Record<string, unknown>
    assert.equal(sm.conf_floor, 0.2, 'the effective floor scale reaches the caller')
  })
})

test('session drive：无 weak_picks/final_signal = 旧形状（键不出现）', async () => {
  const handoff = { stop_code: 'low_confidence', step_id: 1, why_stuck: { summary: 'x' } }
  await withHarness({
    routes: [{ type: 'drive', respond: { ok: true, status: 'handoff', stop_code: 'low_confidence', handoff } }],
  }, async (h) => {
    const r = await h.call({ op: 'drive', goal: 'x' })
    const ho = r.handoff as Record<string, unknown>
    assert.equal('weak_picks' in ho, false, 'no weak votes = no key (old handoff shape)')
    assert.equal('final_signal' in ho, false, 'no final-signal fact in the response = no key (bridge invents nothing)')
  })
})

test('session drive：未决交接时 reused 回执带 handoff_open/goal_ignored/next', async () => {
  await withHarness({
    routes: [{ type: 'drive', respond: {
      ok: false, code: 'handoff_open', reused: true, goal_ignored: true,
      reason: 'a handoff is open; use driveCommand resume|redirect|finish|abort to continue this run',
      status: 'handoff', stop_code: 'off_task_page', steps: 2, model_asks: 0,
      handoff_open: { stop_code: 'off_task_page', step_id: 2, goal_digest: 'old goal', why_stuck: { summary: 'x' } },
      next: ['driveCommand resume|redirect|finish|abort continues the open handoff', 'start a new session', 'third'],
    } }],
  }, async (h) => {
    const r = await h.call({ op: 'drive', goal: 'a brand new goal' })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'handoff_open')
    assert.equal(r.reused, true, 'the compat reuse fact is projected')
    assert.equal(r.goal_ignored, true, 'the ignored goal is explicit')
    assert.equal(r.status, 'handoff')
    assert.equal(r.stop_code, 'off_task_page')
    const ho = r.handoff as Record<string, unknown>
    assert.equal(ho.stop_code, 'off_task_page', 'the open handoff is echoed')
    assert.equal(ho.goal_digest, 'old goal', 'the active goal digest proves the new goal was not adopted')
    const next = r.next as string[]
    assert.ok(Array.isArray(next) && next.length === 3, 'next is bounded to 3 entries')
    assert.ok(next.some((s) => s.includes('driveCommand')) && next.some((s) => s.includes('new session')))
  })
})

test('session drive_command / drive_status / drive_close：闭集与往返', async () => {
  await withHarness({
    routes: [
      { type: 'driveCommand', respond: { ok: true, status: 'final_signal_held', stop_code: 'final_signal_held', url: 'http://fixture.local/detail', steps: 4, model_asks: 5, out_dir: '/tmp/pilot-run-2' } },
      { type: 'driveStatus', respond: { ok: true, status: 'handoff', url: 'http://fixture.local/detail', steps: 4, model_asks: 5, out_dir: '/tmp/pilot-run-2', pilot: true, attached: true, active: true, terminal: false, handoff_open: { stop_code: 'low_confidence', step_id: 3, why_stuck: { summary: 'x' } } } },
      { type: 'driveClose', respond: { ok: true, status: 'closed', url: 'http://fixture.local/detail', steps: 4, model_asks: 5, out_dir: '/tmp/pilot-run-2', pilot: true, attached: true, closed: true, summary: { ok: true, pilot: true, stop_code: 'final_signal_held', steps: 4, model_asks: 5, url: 'http://fixture.local/detail', out_dir: '/tmp/pilot-run-2' } } },
    ],
  }, async (h) => {
    const cmd = await h.call({ op: 'drive_command', cmd: 'resume', hint: 'Open the detail page' })
    assert.equal(cmd.ok, true)
    assert.equal(cmd.status, 'final_signal_held')
    const st = await h.call({ op: 'drive_status' })
    assert.equal(st.ok, true)
    assert.equal(st.op, 'drive_status')
    assert.equal(st.steps, 4)
    assert.equal(st.active, true)
    assert.equal(st.terminal, false)
    assert.equal((st.handoff as Record<string, unknown>).stop_code, 'low_confidence')
    const cl = await h.call({ op: 'drive_close' })
    assert.equal(cl.ok, true)
    assert.equal(cl.op, 'drive_close')
    assert.equal(cl.closed, true)
    const sm = cl.summary as Record<string, unknown>
    assert.equal(sm.stop_code, 'final_signal_held')
    assert.equal(sm.steps, 4)
  })
})

test('session drive：引擎失败 = engineFailure 形状（session 继续存活，不泄露池）', async () => {
  await withHarness({
    routes: [{ type: 'drive', respond: { ok: false, code: 'config_error', reason: 'attached page outside hosts', session_alive: true, pool: ['LEAK'] } }],
  }, async (h) => {
    const r = await h.call({ op: 'drive', goal: 'x' })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'config_error')
    assert.equal(r['session_alive'], true)
    assert.ok(!('pool' in r) && !('candidates' in r))
  })
})

test('session drive：终态 resume 的 drive_terminal/reason 透传 + target 到达引擎', async () => {
  await withHarness({
    routes: [
      // lineIncludes 断言 target 真的组进了引擎指令行（桥静默丢弃 target 的回归会被拦住）。
      { type: 'driveCommand', lineIncludes: '"target":"search-term"', respond: {
        ok: false, code: 'drive_terminal', reason: 'the pilot driver is terminal; start a new session to drive again',
        stop_code: 'final_signal_held', status: 'done', outcome: 'stay', cmd: 'resume',
      } },
    ],
  }, async (h) => {
    const r = await h.call({ op: 'drive_command', cmd: 'resume', value: 'amber', target: 'search-term' })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'drive_terminal')
    assert.equal(r.reason, 'the pilot driver is terminal; start a new session to drive again')
    assert.equal(r.stop_code, 'final_signal_held')
    assert.equal(r.outcome, 'stay')
    assert.equal(r.cmd, 'resume')
  })
})

test('session drive：失败回执 reason 为空时回落嵌套 command.reason', async () => {
  await withHarness({
    routes: [{ type: 'driveCommand', respond: {
      ok: false, code: 'config_error', cmd: 'resume', outcome: 'stay',
      command: { type: 'command_result', ok: false, code: 'config_error', reason: 'resume without an open handoff' },
    } }],
  }, async (h) => {
    const r = await h.call({ op: 'drive_command', cmd: 'resume' })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'config_error')
    assert.equal(r.reason, 'resume without an open handoff', 'the nested single-line reason reaches the caller')
  })
})

/* ---- 4.6 extract 稳定读：双指标缺省门证据透传（F89） ---- */

test('extract settled：缺省门证据透传（F89）', async () => {
  await withHarness({
    routes: [
      // 缺省 extract（无 waitSettled 字段）：引擎响应带 settled=false + blank_rows=2（懒渲染骨架）
      { type: 'extract', lineIncludes: 'extract', respond: {
        ok: true, rows: [{ name: '' }, { name: '' }], count: 2, capped: false,
        blank_rows: 2, settled: false, scroll_settled: true,
      } },
    ],
  }, async (h) => {
    const r = await h.call({ op: 'extract', rows: '.h-row', fields: { name: '.' } })
    assert.equal(r.ok, true)
    // F6 教训的直接适用：投影丢键 = 白做——三个键都必须到达桥面
    assert.equal(r['blank_rows'], 2)
    assert.equal(r['settled'], false)
    assert.equal(r['scroll_settled'], true)
  })
})

test('extract settled：opt-out 无 settled 键（形状不变）+ 非法值 config_error', async () => {
  await withHarness({
    routes: [
      // opt-out 请求体带 "waitSettled":false：引擎回 opt-out 形状（settled 缺席）
      { type: 'extract', lineIncludes: '"waitSettled":false', respond: {
        ok: true, rows: [{ name: '' }], count: 1, capped: false, blank_rows: 1, scroll_settled: true,
      } },
    ],
  }, async (h) => {
    const r = await h.call({ op: 'extract', rows: '.h-row', fields: { name: '.' }, wait_settled: false })
    assert.equal(r.ok, true)
    assert.ok(!('settled' in r), 'opt-out = no gate = no settled key (never claim stability without evidence)')
    assert.equal(r['blank_rows'], 1)
    assert.equal(r['scroll_settled'], true)
    const bad = await h.call({ op: 'extract', rows: '.h-row', fields: { name: '.' }, wait_settled: 'yes' as unknown as boolean })
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'config_error')
  })
})

test('shape_problem：落空时的形状判别有界透传（kind 闭集 + reason/suggestion ≤200）', async () => {
  await withHarness({
    routes: [{
      type: 'act', targetIncludes: 'shaped',
      respond: {
        ok: false, code: 'target_not_found', executed: false, url: 'http://fixture.local/page',
        reason: 'target "button 搜索" matched nothing in a pool of 61 element(s)',
        // 引擎实际形状：同一份同时进 diagnostics（引擎构造）与顶层（会话回显）。
        shape_problem: { kind: 'role-word-plus-text', reason: 'r'.repeat(400), suggestion: 's'.repeat(400) },
        diagnostics: {
          target: 'button 搜索', pool_size: 61, hint_shape: 'bare', hint_len: 9,
          shape_problem: { kind: 'role-word-plus-text', reason: 'r'.repeat(400), suggestion: 's'.repeat(400) },
        },
      },
    }],
  }, async (h) => {
    const r = await h.call({ op: 'act', act_op: 'click', target: 'shaped-target' })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'target_not_found')
    // 形状判别随 diagnostics 透传（引擎把它放在 diagnostics 里；会话线另在顶层回显同一份）。
    const sp = (r['diagnostics'] as Record<string, unknown> | undefined)?.['shape_problem'] as Record<string, unknown> | undefined
    assert.ok(sp !== undefined, 'shape_problem must reach the bridge diagnostics block')
    assert.equal(sp['kind'], 'role-word-plus-text', 'kind must survive the closed-set filter')
    assert.equal(String(sp['reason']).length, 200, 'reason must be clipped to 200')
    assert.equal(String(sp['suggestion']).length, 200, 'suggestion must be clipped to 200')
    // diagnostics 内的同一份也要透传（引擎给才有）
    const diag = r['diagnostics'] as Record<string, unknown>
    assert.ok(diag !== undefined, 'diagnostics must still pass through')
    assert.equal(diag['pool_size'], 61)
  })
})

test('shape_problem：未知 kind 被丢弃（闭集纪律，不外扩词面）', async () => {
  await withHarness({
    routes: [{
      type: 'act', targetIncludes: 'shapedbad',
      respond: {
        ok: false, code: 'target_not_found', executed: false, url: 'http://fixture.local/page',
        shape_problem: { kind: 'made-up-kind', reason: 'x' },
      },
    }],
  }, async (h) => {
    const r = await h.call({ op: 'act', act_op: 'click', target: 'shapedbad-target' })
    const diag = r['diagnostics'] as Record<string, unknown> | undefined
    assert.ok(diag === undefined || !('shape_problem' in diag), 'unknown kind must not be projected (closed set stays closed)')
  })
})

test('execution_state：action-timeout 的 unknown 派发事实透传', async () => {
  await withHarness({
    routes: [{
      type: 'act', targetIncludes: 'timing',
      respond: {
        ok: false, code: 'action-timeout', executed: false, url: 'http://fixture.local/page',
        reason: 'still not actionable: it is not just slow', execution_state: 'unknown',
      },
    }],
  }, async (h) => {
    const r = await h.call({ op: 'act', act_op: 'click', target: 'timing-target' })
    assert.equal(r.code, 'action-timeout')
    assert.equal(r['execution_state'], 'unknown', 'unknown dispatch must reach the caller (never silently "not executed")')
  })
})

test('execution_state：其它失败不补该键（形状不变）', async () => {
  await withHarness({
    routes: [{
      type: 'act', targetIncludes: 'notiming',
      respond: { ok: false, code: 'target_not_found', executed: false, url: 'http://fixture.local/page', reason: 'no match' },
    }],
  }, async (h) => {
    const r = await h.call({ op: 'act', act_op: 'click', target: 'notiming-target' })
    assert.ok(!('execution_state' in r), 'no engine key = no bridge key')
  })
})

test('buildEnv：有头浏览器需要的显示变量必须透过（DISPLAY/XAUTHORITY/WAYLAND_DISPLAY）', async () => {
  const { buildEnv } = await import('../src/bridge.ts')
  const saved = { DISPLAY: process.env['DISPLAY'], XAUTHORITY: process.env['XAUTHORITY'] }
  try {
    process.env['DISPLAY'] = ':99'
    process.env['XAUTHORITY'] = '/tmp/xauth-probe'
    const env = buildEnv({ repoPath: '.', envMode: 'allowlist', forwardEnv: [] } as never)
    assert.equal(env['DISPLAY'], ':99', 'DISPLAY must reach the engine child (headful otherwise never starts)')
    assert.equal(env['XAUTHORITY'], '/tmp/xauth-probe', 'XAUTHORITY must reach the engine child')
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
})

test('sessionGoneMessage：idle 回收要说清是超时回收并给重开方式', async () => {
  const { sessionGoneMessage } = await import('../src/session.ts')
  const reaped = sessionGoneMessage('s-abc', 'idle_timeout')
  assert.ok(/reclaimed after idle timeout/.test(reaped), `idle 回收要说清是超时回收（拿到 ${reaped}）`)
  assert.ok(/open a new session/.test(reaped), `应给出重开方式（拿到 ${reaped}）`)
  assert.ok(/idle_timeout_ms/.test(reaped), `应提到可调大 TTL（拿到 ${reaped}）`)
  // 其它死因 / 未知会话仍是原来的"不存在"文案（键集与措辞不变）
  assert.equal(sessionGoneMessage('s-abc'), 'no live session "s-abc"')
  assert.equal(sessionGoneMessage('s-abc', 'child_exited'), 'no live session "s-abc"')
})
