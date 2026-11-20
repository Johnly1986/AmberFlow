/**
 * 桥层回归 harness 的 **fake engine**（§15；JSONL 协议子进程，SessionManager.spawnArgv 测试缝注入）。
 *
 * 数据驱动：`AF_FAKE_SCENARIO`（JSON 文件路径）给 `autoOpen`（spawn 后主动发出的无 id open 响应，
 * 与真 CLI 的 `--url` 自动 open 同形——桥的 readyWaiter 等它）与 `routes`（按 type + 可选
 * urlIncludes/targetIncludes 首个匹配的路由给出 canned 引擎响应；未命中路由 = `{ok:true}`）。
 * 纯 CJS：bridge 测试进程内不会遇到 ESM loader 差异；require 可用。
 *
 * 协议纪律与真引擎一致：一行一个 JSON 响应、带回请求 id（自动 open 的响应不带 id）；
 * 不打印非协议行到 stdout（诊断走 stderr）。
 */
const fs = require('node:fs')

const TRACE = process.env.AF_FAKE_TRACE || ''
const trace = (m) => { if (TRACE !== '') { try { fs.appendFileSync(TRACE, Date.now() + ' ' + m + '\n') } catch { /* 诊断失败不碍协议 */ } } }
process.on('exit', (c) => trace('exit ' + c))
process.on('uncaughtException', (e) => { trace('UNCAUGHT ' + (e && e.stack || e)); process.stderr.write('fake-engine crashed: ' + String(e && e.message || e) + '\n') })

const scenarioPath = process.env.AF_FAKE_SCENARIO || ''
trace('started scenario=' + JSON.stringify(scenarioPath))
const scenario = scenarioPath !== '' ? JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) : {}
const routes = Array.isArray(scenario.routes) ? scenario.routes : []

// ---- pilot one-shot 分支（`amberflow_pilot` 服务层回归）：--pilot-scenario <name> 下按
// canned JSONL 协议流打印后退出——不挂 stdin 等待（一次性调用，stdin 由 runProcess 关闭）。
// 'stop' 场景把收到的 --input 剧本首行回显进 log 行，供透传断言核对物化内容。
const pilotIdx = process.argv.indexOf('--pilot-scenario')
if (pilotIdx >= 0) {
  const name = process.argv[pilotIdx + 1] ?? ''
  const inputIdx = process.argv.indexOf('--input')
  const inputPath = inputIdx >= 0 ? process.argv[inputIdx + 1] : ''
  const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
  out({ type: 'log', unsolicited: true, line: 'starting headless browser' })
  out({ type: 'started', ok: true, url: 'https://fixture.local/page', out_dir: '/tmp/fake-pilot' })
  out({
    type: 'drive', ok: true, step: 1, picked_by: 'model', op: 'click', target: 'Learn more',
    ref: 'e0', changed: true, url: 'https://fixture.local/detail', elapsed_ms: 12,
    conf: 0.9, shape: 'full', pool_size: 3, via: 'ask',
  })
  if (name === 'hold') {
    out({
      type: 'pilot_end', unsolicited: true, pilot: true, ok: true, stop_code: 'final_signal_held',
      steps: 1, max_steps: 6, model_asks: 1, rule_picks: 0, model_picks: 1, handoffs: 0, fallbacks: 0,
      cache: { hits: 0, misses: 2 }, url: 'https://fixture.local/detail', out_dir: '/tmp/fake-pilot',
    })
    process.exit(0)
  }
  if (name === 'stop') {
    out({
      type: 'handoff', unsolicited: true, pilot: true,
      handoff: {
        stop_code: 'low_confidence', step_id: 1, goal_digest: 'open the first detail',
        why_stuck: { summary: 'low_confidence @ step 1 (https://fixture.local/detail)', evidence: { inert_run: 0, forbidden: [] } },
        what_would_unblock: ['resume 带 hint 点名更精确的目标', 'redirect 换更具体的总目标后重驾驶'],
        evidence_refs: {
          screenshot: '/tmp/fake-pilot/handoff-1.png', dom: '/tmp/fake-pilot/handoff-1.dom.html',
          pool_snapshot: '/tmp/fake-pilot/handoff-1.pool.json', observe: '/tmp/fake-pilot/handoff-1.observe.json',
        },
        url: 'https://fixture.local/detail',
      },
    })
    if (inputPath !== '' && fs.existsSync(inputPath)) {
      const played = fs.readFileSync(inputPath, 'utf8').split('\n').filter((l) => l.trim() !== '')
      out({ type: 'command_result', ok: true, resumed: true, step: 1 })
      out({ type: 'log', unsolicited: true, line: 'input=' + String(played[0] ?? '') })
    }
    out({
      type: 'pilot_end', unsolicited: true, pilot: true, ok: false, stop_code: 'low_confidence',
      steps: 1, max_steps: 6, model_asks: 2, rule_picks: 0, model_picks: 1, handoffs: 1, fallbacks: 1,
      url: 'https://fixture.local/detail', out_dir: '/tmp/fake-pilot',
    })
    process.exit(3)
  }
  process.stderr.write('fake-engine: unknown --pilot-scenario ' + JSON.stringify(name) + '\n')
  process.exit(2)
}

const matches = (route, req) => {
  if (route.type !== undefined && route.type !== req.type) return false
  if (route.targetIncludes !== undefined && !String(req.target ?? '').includes(route.targetIncludes)) return false
  if (route.urlIncludes !== undefined && !String(req.url ?? '').includes(route.urlIncludes)) return false
  return true
}

const reply = (req, obj) => {
  const line = JSON.stringify({ id: req.id, ...obj })
  process.stdout.write(line + '\n')
}

process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (line === '') continue
    let req
    try { req = JSON.parse(line) } catch { continue }
    const route = routes.find((r) => matches(r, req))
    if (route !== undefined) reply(req, route.respond)
    else reply(req, { ok: true })
  }
})
process.stdin.on('end', () => { /* 桥 dispose 关 stdin：自然退出 */ })

// 真 CLI 在 spawn 后由 --url argv 自行 open 并发出**无 id** 的 open 响应——桥的 readyWaiter 等它。
if (scenario.autoOpen !== undefined) {
  trace('auto-open sent')
  process.stdout.write(JSON.stringify(scenario.autoOpen) + '\n')
}
process.stdin.on('end', () => trace('stdin END'))
process.stdin.on('close', () => trace('stdin CLOSE'))
