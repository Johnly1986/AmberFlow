/**
 * verify-parity：**三腿步级对照**（run / session / pilot）非门禁验收 lane。
 *
 * 同一条本地 fixture、同一步（点击 `#detail-link` → 详情页），三面各自用自己的入口跑：
 *   - run：flow 脚本声明 `act: ctx.hint("#detail-link")` + `done: judge.exists("#detail")`（规则面）；
 *   - session：`amber session` 的 `act`（显式 target，零模型）；
 *   - pilot：`amber pilot --driver agent` + 兜底 `resume{hint:"#detail-link"}`（零模型票）。
 * 对照 **解析+动作事实**（ref / how / changed / 落地 URL）、**池计数**（session observe 与 pilot
 * step_request）与**决策源**（run 的 methods、pilot 的 picked_by、以及两边 model_asks=0）。
 *
 * 为什么能对照：三面调用同一批 `hintMatch` / `actOnce` / `checkSignal` / 抽池实现；同一页同一序
 * 的池 ref 应一致。若 ref 出现分叉，这里就红——不猜、不跳。
 *
 * 零模型、零外网、零仓库写（产物全在临时目录）；不要求 attach/run take-over。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const FIXTURES = path.join(REPO, 'fixtures', 'engine', 'pilot')
const CLI = path.join(REPO, 'src', 'cli', 'main.ts')

interface Fixture { origin: string; close(): Promise<void> }
interface CliResult { status: number | null; stdout: string; stderr: string }

function startFixture(): Promise<Fixture> {
  const server = http.createServer((req, res) => {
    const name = path.basename((req.url ?? '/').split('?')[0] ?? '/')
    const file = path.join(FIXTURES, name === '' ? 'home.html' : name)
    let body: Buffer
    try { body = fs.readFileSync(file) } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) })
    })
  })
}

function runCli(args: string[], env: NodeJS.ProcessEnv, timeout = 240_000): Promise<CliResult> {
  // 异步 spawn：fixture 服务器跑在本进程里，同步 spawnSync 会阻塞事件循环 → 页面永远等不到响应。
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', CLI, ...args], {
      cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer | string) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer | string) => { stderr += d.toString() })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeout)
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }) })
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: -1, stdout, stderr: stderr + String(e) }) })
  })
}

/** 干净的 leg 环境：继承当前 env，但剥掉决策三件套（保证零模型、结果可复现）。 */
function legEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const key of Object.keys(env)) if (key.startsWith('AMBERFLOW_DECISION_')) delete env[key]
  delete env['AMBERFLOW_HEADFUL']
  return env
}

function jsonl(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of text.split('\n')) {
    const raw = line.trim()
    if (raw === '') continue
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) out.push(parsed as Record<string, unknown>)
    } catch { /* 非协议行（人话日志不该在 stdout；忽略） */ }
  }
  return out
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
}

function fail(tag: string, r: CliResult): never {
  console.error(`\n[${tag}] CLI 失败（exit=${String(r.status)}）`)
  console.error('stdout tail:\n' + r.stdout.split('\n').slice(-20).join('\n'))
  console.error('stderr tail:\n' + r.stderr.split('\n').slice(-20).join('\n'))
  process.exit(1)
}

async function main(): Promise<void> {
  const fixture = await startFixture()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-verify-parity-'))
  const homeUrl = `${fixture.origin}/home.html`
  try {
    // ---------------- session 腿（零模型） ----------------
    const sessionOut = path.join(tmp, 'session-out')
    const sessionIn = path.join(tmp, 'session-in.jsonl')
    fs.writeFileSync(sessionIn, [
      { id: 1, type: 'observe', max: 30 },
      { id: 2, type: 'act', op: 'click', target: '#detail-link' },
      { id: 3, type: 'read', what: 'text', selector: '#detail' },
      { id: 4, type: 'close' },
    ].map((x) => JSON.stringify(x)).join('\n') + '\n')
    const sess = await runCli(['session', '--url', homeUrl, '--out', sessionOut, '--input', sessionIn],
      legEnv({ AMBERFLOW_HOME: path.join(tmp, 'home-session') }))
    if (sess.status !== 0) fail('session', sess)
    const sEvents = jsonl(sess.stdout)
    const sObserve = sEvents.find((e) => e['type'] === 'observe')
    const sAct = sEvents.find((e) => e['type'] === 'act')
    const sRead = sEvents.find((e) => e['type'] === 'read')
    assert.ok(sObserve !== undefined && sObserve['ok'] === true, 'session observe 必须成功')
    assert.ok(sAct !== undefined && sAct['ok'] === true, 'session act 必须成功')
    assert.ok(sRead !== undefined && sRead['value'] === 'Detail', `session 必须读到详情页文本: ${JSON.stringify(sRead)}`)
    const sCounts = sObserve['counts'] as Record<string, unknown>
    const sPool = Number(sCounts['elements'])

    // ---------------- pilot 腿（session 子进程内 drive，agent 档 = 零模型票） ----------------
    const pilotOut = path.join(tmp, 'session-drive-out')
    const pilotIn = path.join(tmp, 'session-drive-in.jsonl')
    fs.writeFileSync(pilotIn, [
      { id: 1, type: 'drive', goal: 'Complete the checkout flow', driver: 'agent', final_signal: { css_exists: '#detail' } },
      { id: 2, type: 'driveCommand', cmd: 'resume', hint: '#detail-link' },
      { id: 3, type: 'driveStatus' },
      { id: 4, type: 'driveClose' },
      { id: 5, type: 'close' },
    ].map((x) => JSON.stringify(x)).join('\n') + '\n')
    const pilot = await runCli(['session', '--url', homeUrl, '--out', pilotOut, '--input', pilotIn],
      legEnv({ AMBERFLOW_HOME: path.join(tmp, 'home-pilot') }))
    if (pilot.status !== 0) fail('pilot-drive', pilot)
    const pEvents = jsonl(pilot.stdout)
    const pDriveResp = pEvents.find((e) => e['type'] === 'drive')
    const pCmdResp = pEvents.find((e) => e['type'] === 'driveCommand')
    const pStatus = pEvents.find((e) => e['type'] === 'driveStatus')
    assert.ok(pDriveResp !== undefined && pDriveResp['ok'] === true, `drive 必须成功: ${JSON.stringify(pDriveResp)}`)
    assert.equal(pDriveResp['status'], 'await_pick', `drive 首轮必须 await_pick: ${JSON.stringify(pDriveResp)}`)
    assert.ok(pCmdResp !== undefined && pCmdResp['ok'] === true, `driveCommand 必须成功: ${JSON.stringify(pCmdResp)}`)
    assert.equal(pCmdResp['stop_code'], 'final_signal_held', `drive 终态必须 final_signal_held: ${JSON.stringify(pCmdResp)}`)
    assert.equal(Number(pCmdResp['model_asks']), 0, 'pilot agent 腿必须零模型')
    assert.equal(pStatus?.['terminal'], true, 'driveStatus 必须 terminal')
    const pStepReq = (Array.isArray(pDriveResp['events']) ? pDriveResp['events'] as Array<Record<string, unknown>> : [])
      .find((e) => e['type'] === 'step_request')
    assert.ok(pStepReq !== undefined && pStepReq['pool_size'] !== undefined, 'drive 首轮必须带 step_request.pool_size')
    const pPool = Number(pStepReq['pool_size'])
    const pDrive = (Array.isArray(pCmdResp['events']) ? pCmdResp['events'] as Array<Record<string, unknown>> : [])
      .find((e) => e['type'] === 'drive')
    assert.ok(pDrive !== undefined, 'resume 后必须留 drive 事件')
    assert.equal(pDrive['picked_by'], 'rule', `pilot 这步应由规则档点名完成: ${JSON.stringify(pDrive)}`)
    // 事件面只有 ref/changed/url（不带 how）；how 由 session/run 两腿对照。

    // ---------------- run 腿（flow 脚本：声明 hint + done 信号） ----------------
    const runHome = path.join(tmp, 'home-run')
    const appDir = path.join(runHome, 'apps', 'parity-run')
    fs.mkdirSync(appDir, { recursive: true })
    fs.writeFileSync(path.join(appDir, 'app.mjs'), [
      'export const meta = (kit) => ({',
      "  id: 'parity-run', label: 'parity run leg', goal: '打开详情页',",
      "  hosts: ['127.0.0.1'], slots: { entry: '' },",
      "  invariants: [{ id: 'detail-shown', desc: '详情页标题出现', signal: kit.judge.exists('#detail') }],",
      '})',
      'export async function flow(ctx) {',
      '  const arrived = await ctx.arrive(ctx.slots.entry, { id: "arrive", done: ctx.judge.exists("#detail-link") })',
      '  if (!arrived.ok) ctx.fail(arrived.stopCode ?? "arrive_failed", arrived.reason)',
      '  const stepped = await ctx.step("打开详情页", { id: "open-detail", act: ctx.hint("#detail-link"), done: ctx.judge.exists("#detail") })',
      '  if (!stepped.ok) ctx.fail(stepped.stopCode ?? "step_failed", stepped.reason)',
      '  await ctx.done()',
      '}',
    ].join('\n') + '\n')
    const runOut = path.join(tmp, 'run-out')
    const run = await runCli(['run', 'parity-run', '--slot', `entry=${homeUrl}`, '--trace', '--out', runOut],
      legEnv({ AMBERFLOW_HOME: runHome }))
    if (run.status !== 0) fail('run', run)
    const runResult = readJson(path.join(runOut, 'parity-run-result.json'))
    assert.equal(runResult['ok'], true, `run 必须 ok: ${JSON.stringify(runResult['ok'])}`)
    const traces = runResult['step_traces'] as Array<Record<string, unknown>>
    const step = traces.find((t) => t['id'] === 'open-detail')
    assert.ok(step !== undefined, 'run 必须留 open-detail 步迹')
    assert.equal(step['status'], 'done', `run 该步必须 done: ${JSON.stringify(step['status'])}`)
    const rActions = step['executed_actions'] as Array<Record<string, unknown>>
    assert.ok(Array.isArray(rActions) && rActions.length === 1, 'run 该步必须恰好一个执行动作')
    const rAction = rActions[0]!
    const rMethods = (step['methods'] as string[]) ?? []
    assert.ok(rMethods.some((m) => m.startsWith('rule:')), `run 这步应由规则档完成: ${JSON.stringify(rMethods)}`)
    const runDecisions = runResult['decisions'] as Record<string, unknown>
    assert.equal(Number(runDecisions['model_asks']), 0, 'run 腿必须零模型')
    const runInvariants = runResult['invariants'] as Array<Record<string, unknown>>
    assert.ok(Array.isArray(runInvariants) && runInvariants.every((i) => i['held'] === true), 'run 不变量必须全部成立')

    // ---------------- 三腿对照 ----------------
    const sRef = String(sAct['ref']); const pRef = String(pDrive['ref']); const rRef = String(rAction['ref'])
    const sHow = String(sAct['how']); const rHow = String(rAction['how'])
    const sChanged = sAct['changed'] === true; const pChanged = pDrive['changed'] === true; const rChanged = rAction['changed'] === true
    const sUrl = String(sAct['url']); const pUrl = String(pDrive['url']); const rUrl = String(step['url'])
    const sExecuted = sAct['executed'] === true

    console.log('session 腿:', JSON.stringify({ ref: sRef, how: sHow, changed: sChanged, executed: sExecuted, url: sUrl, pool: sPool }))
    console.log('pilot   腿:', JSON.stringify({ ref: pRef, changed: pChanged, url: pUrl, pool: pPool, picked_by: pDrive['picked_by'] }))
    console.log('run     腿:', JSON.stringify({ ref: rRef, how: rHow, changed: rChanged, url: rUrl, methods: rMethods, model_asks: runDecisions['model_asks'] }))

    const problems: string[] = []
    const eq = (a: unknown, b: unknown, what: string): void => {
      if (a !== b) problems.push(`${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)
    }
    eq(sRef, pRef, 'session/pilot ref')
    eq(sRef, rRef, 'session/run ref')
    eq(sHow, rHow, 'session/run how')
    eq(sChanged, true, 'session changed')
    eq(pChanged, true, 'pilot changed')
    eq(rChanged, true, 'run changed')
    eq(String(sUrl).endsWith('/detail.html'), true, 'session 落地详情页')
    eq(String(pUrl).endsWith('/detail.html'), true, 'pilot 落地详情页')
    eq(String(rUrl).endsWith('/detail.html'), true, 'run 落地详情页')
    eq(sPool, pPool, 'session/pilot 池计数')
    eq(String(sUrl), String(rUrl), 'session/run 落地 URL')
    eq(String(pUrl), String(rUrl), 'pilot/run 落地 URL')
    if (problems.length > 0) {
      console.error('verify-parity: FAIL')
      for (const p of problems) console.error(`  - ${p}`)
      console.error(`证据目录: ${tmp}`)
      process.exit(1)
    }
    console.log('verify-parity: OK — 同 fixture 三腿步级一致（ref/changed/落地 URL/池计数/规则档/零模型；how 由 session/run 两腿对照）')
    fs.rmSync(tmp, { recursive: true, force: true })
  } finally {
    await fixture.close()
  }
}

main().then(() => process.exit(0), (e) => { console.error('verify-parity: FAIL —', e); process.exit(1) })
