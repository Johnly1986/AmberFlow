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
