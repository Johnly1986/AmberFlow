/**
 * `amberflow_session` 的运行时（task-35 / Phase 3）：把引擎 CLI 的 `amber session` 暴露成
 * **跨工具调用的持续会话**（op + session_id）。
 *
 * 纪律（设计稿 iterations/interactive-session/phase3-design.md 的实现面）：
 *   - 一个 session = 一个常驻子进程（`stdin/stdout` JSONL 协议，与 CLI 的协议 1:1 透传，
 *     不新增任何引擎语义：不选元素、不归纳信号、不改动作）；
 *   - 桥独占 idle 语义（TTL 缺省 300s，reaper 每 5s 扫一次）；CLI 侧 `--idle-timeout-ms 600000`
 *     只作孤儿兜底（双层 idle，Lead 裁决 Q3）；
 *   - 一条命令失败 ≠ 工具失败：引擎结构化失败原样透传，会话继续；只有 session 不可用
 *     （child_exited / session_not_found / session_limit / bridge_timeout）才是工具级错误；
 *   - 无孤儿：dispose / TTL / close 都走 `close → 等退出 → kill 进程树`（Windows 用
 *     `taskkill /pid <pid> /T /F`，因为浏览器是孙进程）；
 *   - 证据路径固定（桥不接受用户提供的 out 路径）：`$AMBERFLOW_HOME/session/<session_id>/`。
 *
 * 本文件不 import 任何 Cordis/DSH 包：只依赖 `./bridge.ts` 与 node 内建模块，因此可以脱离
 * 桥的构建（其 `tsc -b` 有既存错误）独立做类型检查与单元测试。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { buildEnv, cliArgs, type BridgeOptions } from './bridge.ts'

/** 缺省 idle TTL（Lead 裁决 Q3：桥独占 300s，CLI 兜底 600s）。 */
export const DEFAULT_SESSION_IDLE_MS = 300_000
/** 缺省同时在册会话上限（Lead 裁决 Q1）。 */
export const DEFAULT_MAX_SESSIONS = 2
/** CLI 侧的孤儿兜底（2× 桥 TTL）。 */
export const CLI_ORPHAN_IDLE_MS = 600_000
/** 单 op 读超时缺省。 */
export const DEFAULT_OP_TIMEOUT_MS = 60_000
/** `open` 的读超时（首次启动浏览器 + 导航）。 */
export const DEFAULT_OPEN_TIMEOUT_MS = 120_000
/** 返回体有界裁剪（与设计 §6 一致）。 */
export const OBSERVE_MAX_ELEMENTS = 40
export const OBSERVE_MAX_HINTS = 3
export const EXTRACT_MAX_ROWS = 20
export const READ_MAX_CHARS = 2000
export const STDERR_TAIL_BYTES = 2048

/** 工具级错误（会话不可用/桥故障）；引擎结构化失败不走这里。 */
export class SessionToolError extends Error {
  readonly code: string
  readonly extra: Record<string, unknown>
  constructor(code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'SessionToolError'
    this.code = code
    this.extra = extra
  }
}

export interface SessionManagerOptions {
  /** 桥已解析的部署选项（repoPath/nodeBin/tsxCli/env 策略）。 */
  bridge: BridgeOptions
  /** 桥 TTL（缺省 300s）。 */
  idleMs?: number
  /** 同时在册会话上限（缺省 2）。 */
  maxSessions?: number
  /** 单 op 读超时（缺省 60s；open 用 openTimeoutMs）。 */
  opTimeoutMs?: number
  /** open 读超时（缺省 120s）。 */
  openTimeoutMs?: number
  /** 证据根（测试可注入；缺省 `$AMBERFLOW_HOME/session`）。 */
  evidenceRoot?: string
  /**
   * 测试缝：子进程 argv 构造器。缺省 = `cliArgs(bridge, ['session', …])`。
   * 真引擎与 fake engine 共用同一条 spawn 路径（fake 用它把 node 指向假引擎脚本）。
   */
  spawnArgv?: (spec: { url: string; outDir: string; recordPath: string | null; hosts: string[]; headful: boolean }) => string[]
  /** 测试缝：额外环境变量（在 buildEnv + appsEnv 之后合并）。 */
  env?: NodeJS.ProcessEnv
  /** reaper 扫描间隔（缺省 5s；测试可调小）。 */
  reaperMs?: number
}

interface Pending {
  resolve(value: Record<string, unknown>): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

interface SessionState {
  id: string
  child: ChildProcess
  stdoutBuf: string
  stdoutDecoder: StringDecoder
  stderrDecoder: StringDecoder
  stderrTail: string
  pending: Map<number, Pending>
  nextId: number
  queue: Promise<unknown>
  lastActivity: number
  url: string
  title?: string | undefined
  actions: number
  requests: number
  dead: boolean
  deadReason?: string | undefined
  /** 已解析的第一条响应（auto-open 的 `{id:null,type:"open"}`）；ready 前到达的行进这里。 */
  readyLine?: Record<string, unknown> | undefined
  readyWaiter?: { resolve(v: Record<string, unknown>): void; reject(e: Error): void } | undefined
  exitPromise: Promise<void>
  closing: boolean
}

export interface SessionListRow {
  session_id: string
  url: string
  idle_ms: number
  actions: number
  requests: number
  evidence_dir: string
}

export interface SessionToolArgs {
  op?: string
  session_id?: string
  url?: string
  hosts?: string[]
  headful?: boolean
  record?: boolean
  act_op?: string
  target?: string
  value?: unknown
  to?: 'bottom' | 'top' | 'page'
  by?: number
  selector?: string
  what?: 'text' | 'value' | 'count' | 'attr'
  attr?: string
  rows?: string
  fields?: Record<string, string>
  max_items?: number
  signal?: Record<string, unknown>
  timeout_ms?: number
  max?: number
  include_hidden?: boolean
  screenshot?: boolean
}

export type SessionToolResult = Record<string, unknown>

const SESSION_OPS = ['open', 'observe', 'act', 'read', 'extract', 'signal', 'wait_for', 'snapshot', 'close', 'list'] as const
const ACT_OPS = ['click', 'check', 'fill', 'select', 'hover', 'scroll'] as const

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** 用户作用域主页（与 CLI 的 `$AMBERFLOW_HOME` 同口径）。 */
export function userHome(env: NodeJS.ProcessEnv): string {
  const raw = env.AMBERFLOW_HOME
  if (typeof raw === 'string' && raw.trim() !== '') return path.resolve(raw)
  return path.join(os.homedir(), '.amberflow')
}

/** session_id：`s-` + 10 位 base36 随机（不可预测、不含时间信息）。 */
function newSessionId(): string {
  const bytes = Buffer.from(Array.from({ length: 10 }, () => Math.floor(Math.random() * 256)))
  return `s-${bytes.toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 10)}`
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`
}

/**
 * 一个桥进程内的会话管理器：spawn/行解析/请求配对/串行化/TTL/reaper/杀进程树。
 * **缺省配置下不创建任何子进程**（所有会话都是 open op 显式创建的）。
 */
export class SessionManager {
  private readonly options: Required<Pick<SessionManagerOptions, 'idleMs' | 'maxSessions' | 'opTimeoutMs' | 'openTimeoutMs' | 'reaperMs'>> & SessionManagerOptions
  private readonly sessions = new Map<string, SessionState>()
  private readonly evidenceRoot: string
  private readonly spawnCountRef: { count: number } = { count: 0 }
  private reaper: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(options: SessionManagerOptions) {
    this.options = {
      ...options,
      idleMs: Math.max(1_000, options.idleMs ?? DEFAULT_SESSION_IDLE_MS),
      maxSessions: Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS),
      opTimeoutMs: Math.max(1_000, options.opTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS),
      openTimeoutMs: Math.max(1_000, options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS),
      reaperMs: Math.max(50, options.reaperMs ?? 5_000),
    }
    this.evidenceRoot = options.evidenceRoot
      ?? path.join(userHome({ ...buildEnv(options.bridge), ...(options.bridge.appsEnv ?? {}), ...(options.env ?? {}) }), 'session')
    this.reaper = setInterval(() => { void this.reap() }, this.options.reaperMs)
    // unref：reaper 不该单独撑住宿主进程（DSH 退出时 dispose 会兜底清理）。
    this.reaper.unref?.()
  }

  /** 已 spawn 的子进程数（测试断言「参数错误不 spawn」用）。 */
  spawnedCount(): number {
    return this.spawnCountRef.count
  }

  /** 当前在册会话（元数据，不含任何页面内容）。 */
  list(): SessionListRow[] {
    const now = Date.now()
    const rows: SessionListRow[] = []
    for (const s of this.sessions.values()) {
      rows.push({
        session_id: s.id,
        url: s.url,
        idle_ms: now - s.lastActivity,
        actions: s.actions,
        requests: s.requests,
        evidence_dir: path.join(this.evidenceRoot, s.id),
      })
    }
    return rows
  }

  /** dispose 钩子：清 reaper + 关所有会话（幂等）。 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.reaper !== undefined) clearInterval(this.reaper)
    this.reaper = undefined
    const ids = [...this.sessions.keys()]
    await Promise.all(ids.map(id => this.closeSession(id, 'dispose').catch(() => undefined)))
  }

  /** TTL：超过 idleMs 没活动的会话 → 先 close（能优雅就优雅）再杀树。 */
  private async reap(): Promise<void> {
    const now = Date.now()
    for (const [id, s] of this.sessions) {
      if (s.dead) { this.sessions.delete(id); continue }
      if (now - s.lastActivity > this.options.idleMs) {
        await this.closeSession(id, 'idle_timeout').catch(() => undefined)
      }
    }
  }

  /** 工具入口：所有 op 的唯一实现。 */
  async handle(args: SessionToolArgs): Promise<SessionToolResult> {
    const op = typeof args.op === 'string' ? args.op : ''
    if (!(SESSION_OPS as readonly string[]).includes(op)) {
      throw new SessionToolError('config_error', `op must be one of ${SESSION_OPS.join(' | ')} (got ${JSON.stringify(args.op)})`, {
        allowed_ops: [...SESSION_OPS],
      })
    }
    if (op === 'list') return { ok: true, op, sessions: this.list() }
    if (op === 'open') return await this.openSession(args)
    const id = nonEmpty(args.session_id) ? args.session_id : ''
    if (id === '') {
      throw new SessionToolError('config_error', `op '${op}' needs session_id (open returns one)`, {
        sessions: this.list(),
      })
    }
    const state = this.sessions.get(id)
    if (state === undefined || state.dead) {
      throw new SessionToolError('session_not_found', `no live session ${JSON.stringify(id)}`, {
        sessions: this.list(),
        ...(state?.deadReason === undefined ? {} : { last_code: state.deadReason }),
      })
    }
    try {
      switch (op) {
        case 'observe': return await this.observe(state, args)
        case 'act': return await this.act(state, args)
        case 'read': return await this.read(state, args)
        case 'extract': return await this.extract(state, args)
        case 'signal': return await this.signal(state, args)
        case 'wait_for': return await this.waitFor(state, args)
        case 'snapshot': return await this.snapshot(state, args)
        case 'close': return await this.closeSessionOp(state)
        default:
          throw new SessionToolError('config_error', `unsupported op ${JSON.stringify(op)}`)
      }
    } catch (error) {
      // 引擎失败（ok:false 的响应）不是异常：在各自 op 里已按数据返回。这里只兜工具级错误。
      if (error instanceof SessionToolError) throw error
      throw new SessionToolError('internal_error', error instanceof Error ? error.message : String(error))
    }
  }

  /* ------------------------------------------------------------ open */

  private validateUrl(url: string): string {
    const trimmed = url.trim()
    if (!/^https?:\/\//i.test(trimmed)) {
      throw new SessionToolError('config_error', 'open needs an http(s) url (relative checkout paths are not allowed through the bridge)')
    }
    try {
      new URL(trimmed)
    } catch {
      throw new SessionToolError('config_error', `open url ${JSON.stringify(url)} is not a valid URL`)
    }
    return trimmed
  }

  private async openSession(args: SessionToolArgs): Promise<SessionToolResult> {
    if (!nonEmpty(args.url)) throw new SessionToolError('config_error', 'open needs a url')
    const url = this.validateUrl(args.url)
    const hosts: string[] = []
    if (args.hosts !== undefined) {
      if (!Array.isArray(args.hosts) || args.hosts.some(h => typeof h !== 'string' || h.trim() === '')) {
        throw new SessionToolError('config_error', 'hosts must be a list of non-empty host strings')
      }
      for (const h of args.hosts) hosts.push(h.trim())
    }
    const live = [...this.sessions.values()].filter(s => !s.dead)
    if (live.length >= this.options.maxSessions) {
      throw new SessionToolError('session_limit', `max ${this.options.maxSessions} concurrent session(s); close one first`, {
        max_sessions: this.options.maxSessions,
        sessions: this.list(),
      })
    }
    const id = newSessionId()
    const outDir = path.join(this.evidenceRoot, id)
    const recordPath = args.record === false ? null : path.join(outDir, 'actions.jsonl')
    const argv = this.argvFor({ url, outDir, recordPath, hosts, headful: args.headful === true })
    const env = {
      ...buildEnv(this.options.bridge),
      ...(this.options.bridge.appsEnv ?? {}),
      ...(this.options.env ?? {}),
    }
    const [bin, ...rest] = argv
    if (bin === undefined || bin === '') throw new SessionToolError('internal_error', 'empty spawn argv')
    fs.mkdirSync(outDir, { recursive: true })
    this.spawnCountRef.count += 1
    const child = spawn(bin, rest, {
      cwd: this.options.bridge.repoPath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const state: SessionState = {
      id,
      child,
      stdoutBuf: '',
      stdoutDecoder: new StringDecoder('utf8'),
      stderrDecoder: new StringDecoder('utf8'),
      stderrTail: '',
      pending: new Map(),
      nextId: 1,
      queue: Promise.resolve(),
      lastActivity: Date.now(),
      url,
      actions: 0,
      requests: 0,
      dead: false,
      exitPromise: Promise.resolve(),
      closing: false,
    }
    this.wire(state)
    this.sessions.set(id, state)
    try {
      const ready = await this.waitReady(state)
      if (ready['ok'] !== true) {
        await this.closeSession(id, 'open_failed').catch(() => undefined)
        throw new SessionToolError(
          typeof ready['code'] === 'string' ? ready['code'] : 'unreachable',
          typeof ready['reason'] === 'string' ? ready['reason'] : 'session open failed',
        )
      }
      state.url = typeof ready['url'] === 'string' && ready['url'] !== '' ? ready['url'] : url
      if (typeof ready['title'] === 'string') state.title = ready['title']
      return {
        ok: true,
        op: 'open',
        session_id: id,
        url: state.url,
        ...(state.title === undefined ? {} : { title: state.title }),
        hosts: Array.isArray(ready['hosts']) ? ready['hosts'] : hosts,
        evidence_dir: outDir,
        record: recordPath,
        idle_ttl_ms: this.options.idleMs,
      }
    } catch (error) {
      this.sessions.delete(id)
      await this.terminate(state)
      if (error instanceof SessionToolError) throw error
      throw new SessionToolError('child_exited', error instanceof Error ? error.message : String(error), {
        stderr_tail: this.tail(state),
      })
    }
  }

  private argvFor(spec: { url: string; outDir: string; recordPath: string | null; hosts: string[]; headful: boolean }): string[] {
    if (this.options.spawnArgv !== undefined) return this.options.spawnArgv(spec)
    const args = ['session', '--url', spec.url, '--out', spec.outDir, '--idle-timeout-ms', String(CLI_ORPHAN_IDLE_MS)]
    for (const h of spec.hosts) args.push('--host', h)
    // headful 透传（task-37 后续修复）：工具参数 headful:true 时让引擎起可见窗口；
    // 缺省 false 不加旗标（产物/行为与此前逐字节一致）。
    if (spec.headful) args.push('--headful')
    if (spec.recordPath !== null) {
      fs.mkdirSync(path.dirname(spec.recordPath), { recursive: true })
      args.push('--record', spec.recordPath)
    }
    return cliArgs(this.options.bridge, args)
  }

  /* ------------------------------------------------------------ 子进程 I/O */

  private wire(state: SessionState): void {
    const child = state.child
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = state.stdoutDecoder.write(chunk)
      state.stdoutBuf += text
      let idx = state.stdoutBuf.indexOf('\n')
      while (idx >= 0) {
        const line = state.stdoutBuf.slice(0, idx).trim()
        state.stdoutBuf = state.stdoutBuf.slice(idx + 1)
        if (line !== '') this.onLine(state, line)
        idx = state.stdoutBuf.indexOf('\n')
      }
      if (state.stdoutBuf.length > 4 * 1024 * 1024) state.stdoutBuf = '' // 防无换行的病态输出
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = state.stderrDecoder.write(chunk)
      state.stderrTail = (state.stderrTail + text).slice(-STDERR_TAIL_BYTES * 2)
    })
    state.exitPromise = new Promise<void>((resolve) => {
      child.on('exit', () => {
        state.dead = true
        state.deadReason = state.deadReason ?? 'child_exited'
        this.rejectAll(state, new SessionToolError('child_exited', 'engine session process exited', {
          stderr_tail: this.tail(state),
        }))
        state.readyWaiter?.reject(new SessionToolError('child_exited', 'engine session process exited before open completed', {
          stderr_tail: this.tail(state),
        }))
        state.readyWaiter = undefined
        resolve()
      })
    })
    child.on('error', (error) => {
      state.dead = true
      state.deadReason = 'child_exited'
      const err = new SessionToolError('child_exited', `cannot spawn/watch the engine session: ${error.message}`)
      this.rejectAll(state, err)
      state.readyWaiter?.reject(err)
      state.readyWaiter = undefined
    })
    child.stdin?.on('error', () => { /* 写失败由 exit/超时路径统一结算 */ })
  }

  private onLine(state: SessionState, line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return // 非协议行（理论上没有；stderr 才是日志面）——忽略，不猜
    }
    if (!isObj(parsed)) return
    if (parsed['type'] === 'session_end') {
      const code = typeof parsed['code'] === 'string' ? parsed['code'] : 'child_exited'
      const reason = typeof parsed['reason'] === 'string' ? parsed['reason'] : 'session ended'
      state.dead = true
      state.deadReason = code
      const err = new SessionToolError('child_exited', `${code}: ${reason}`, {
        engine_code: code,
        stderr_tail: this.tail(state),
      })
      this.rejectAll(state, err)
      state.readyWaiter?.reject(err)
      state.readyWaiter = undefined
      return
    }
    const id = parsed['id']
    if (typeof id === 'number') {
      const pending = state.pending.get(id)
      if (pending === undefined) return // 超时后的迟到响应：丢弃（超时语义已如实报 uncertain）
      state.pending.delete(id)
      clearTimeout(pending.timer)
      state.lastActivity = Date.now()
      pending.resolve(parsed)
      return
    }
    // id null = 自动 open 的响应（或极端情况下的 unsolicited 行）。
    if (state.readyWaiter !== undefined) {
      const waiter = state.readyWaiter
      state.readyWaiter = undefined
      waiter.resolve(parsed)
      return
    }
    if (state.readyLine === undefined && parsed['type'] === 'open') {
      state.readyLine = parsed
    }
  }

  private waitReady(state: SessionState): Promise<Record<string, unknown>> {
    if (state.readyLine !== undefined) {
      const line = state.readyLine
      state.readyLine = undefined
      return Promise.resolve(line)
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.readyWaiter = undefined
        reject(new SessionToolError('bridge_timeout', `engine session did not report open within ${this.options.openTimeoutMs}ms`, {
          uncertain: true,
          stderr_tail: this.tail(state),
        }))
      }, this.options.openTimeoutMs)
      state.readyWaiter = {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      }
    })
  }

  private rejectAll(state: SessionState, error: Error): void {
    for (const [, pending] of state.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    state.pending.clear()
  }

  private tail(state: SessionState): string {
    return clip(state.stderrTail.trim(), STDERR_TAIL_BYTES)
  }

  /* ------------------------------------------------------------ 请求（串行化 + 配对 + 超时） */

  private request(
    state: SessionState,
    body: Record<string, unknown>,
    timeoutMs = this.options.opTimeoutMs,
  ): Promise<Record<string, unknown>> {
    const run = async (): Promise<Record<string, unknown>> => {
      if (state.dead) {
        throw new SessionToolError('child_exited', 'engine session is no longer alive', { stderr_tail: this.tail(state) })
      }
      const id = state.nextId
      state.nextId += 1
      state.requests += 1
      state.lastActivity = Date.now()
      const line = JSON.stringify({ id, ...body })
      const result = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          state.pending.delete(id)
          reject(new SessionToolError('bridge_timeout', `no response to ${JSON.stringify(body['type'])} within ${timeoutMs}ms`, {
            uncertain: true,
            session_id: state.id,
            stderr_tail: this.tail(state),
          }))
        }, timeoutMs)
        state.pending.set(id, { resolve, reject, timer })
      })
      state.child.stdin?.write(`${line}\n`)
      const response = await result
      if (body['type'] === 'act') state.actions += 1
      return response
    }
    const queued = state.queue.then(run, run)
    // 队列本身吞掉失败，避免一次失败卡死后续请求（错误仍通过返回值抛给调用方）。
    state.queue = queued.catch(() => undefined)
    return queued
  }

  /* ------------------------------------------------------------ 各 op */

  private async observe(state: SessionState, args: SessionToolArgs): Promise<SessionToolResult> {
    const max = Math.max(1, Math.min(OBSERVE_MAX_ELEMENTS, Math.floor(args.max ?? OBSERVE_MAX_ELEMENTS)))
    const response = await this.request(state, {
      type: 'observe',
      max,
      ...(args.selector === undefined ? {} : { selector: args.selector }),
      ...(args.include_hidden === undefined ? {} : { includeHidden: args.include_hidden }),
    })
    if (response['ok'] !== true) return this.engineFailure(response, 'observe')
    const elements = Array.isArray(response['elements']) ? response['elements'] : []
    const rows = elements.slice(0, OBSERVE_MAX_ELEMENTS).map((raw) => {
      const el = isObj(raw) ? raw : {}
      const hints = Array.isArray(el['hint_candidates']) ? el['hint_candidates'].filter((h): h is string => typeof h === 'string') : []
      return {
        ref: typeof el['ref'] === 'string' ? el['ref'] : undefined,
        tag: typeof el['tag'] === 'string' ? el['tag'] : '',
        ...(typeof el['label'] === 'string' && el['label'] !== '' ? { label: clip(el['label'], 80) } : {}),
        ...(typeof el['role'] === 'string' && el['role'] !== '' ? { role: el['role'] } : {}),
        ...(typeof el['href'] === 'string' && el['href'] !== '' ? { href: clip(el['href'], 160) } : {}),
        admitted: el['admitted'] === true,
        hints: hints.slice(0, OBSERVE_MAX_HINTS),
      }
    })
    return {
      ok: true,
      op: 'observe',
      session_id: state.id,
      url: response['url'],
      counts: response['counts'],
      truncated: response['truncated'],
      elements: rows,
    }
  }

  private async act(state: SessionState, args: SessionToolArgs): Promise<SessionToolResult> {
    const actOp = typeof args.act_op === 'string' ? args.act_op : ''
    if (!(ACT_OPS as readonly string[]).includes(actOp)) {
      throw new SessionToolError('config_error', `act needs act_op one of ${ACT_OPS.join(' | ')} (got ${JSON.stringify(args.act_op)})`, {
        allowed_act_ops: [...ACT_OPS],
      })
    }
    if (!nonEmpty(args.target) && actOp !== 'scroll') {
      throw new SessionToolError('config_error', `act op '${actOp}' needs a non-empty target (hint string)`)
    }
    if ((actOp === 'fill' || actOp === 'select') && args.value === undefined) {
      throw new SessionToolError('config_error', `act op '${actOp}' needs a value parameter (the tool never invents values)`)
    }
    const body: Record<string, unknown> = { type: 'act', op: actOp, target: args.target ?? '' }
    if (args.value !== undefined) body['value'] = args.value
    if (args.to !== undefined) body['to'] = args.to
    if (args.by !== undefined) body['by'] = args.by
    const response = await this.request(state, body)
    const base = { op: 'act', session_id: state.id, act_op: actOp, target: args.target ?? null }
    // task-36：歧义诊断**原样透传**（引擎有这些键才出现）——交互试错第一诉求是"为什么点错/
    // 是不是多个候选"，而 CLI 会话面已经用 B1 旁路算好了；bridge 只做有界映射，不重算、不猜。
    // 语义纪律：ambiguous 是**诊断事实**不是错误（ok:true 也回显）；缺键 = 精确形状，响应不变。
    const ambiguity = this.ambiguityDiagnostics(response)
    if (response['ok'] !== true) {
      return { ...this.engineFailure(response, 'act'), ...ambiguity, ...base }
    }
    return {
      ok: true,
      ...base,
      executed: response['executed'] === true,
      ref: response['ref'] ?? null,
      how: response['how'] ?? null,
      changed: response['changed'] === true,
      url: response['url'] ?? state.url,
      ...(isObj(response['after']) ? { after: response['after'] } : {}),
      ...ambiguity,
    }
  }

  /**
   * task-36：act 歧义诊断的有界透传（引擎响应里有才有；精确形状的响应键集不变）。
   *
   * 来源：CLI 会话面用 B1 旁路（与 run 的 matched_others 同一份）算出的当场事实——
   * `ambiguous:boolean`、`matched_others[]`（≤3；ref/tag/class/label≤40）、弱档标记
   * `hint_kind`/`hint_tier`/`hint_suspicious`。bridge 只做形状裁剪，不改语义、不补字段。
   */
  private ambiguityDiagnostics(response: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    if (typeof response['ambiguous'] === 'boolean') out['ambiguous'] = response['ambiguous']
    const rawOthers = response['matched_others']
    if (Array.isArray(rawOthers)) {
      const rows = rawOthers.slice(0, 3).map((raw) => {
        const o: Record<string, unknown> = isObj(raw) ? raw : {}
        return {
          ...(typeof o['ref'] === 'string' ? { ref: o['ref'] } : {}),
          ...(typeof o['tag'] === 'string' ? { tag: o['tag'] } : {}),
          ...(typeof o['class'] === 'string' ? { class: o['class'] } : {}),
          ...(typeof o['label'] === 'string' ? { label: clip(o['label'], 40) } : {}),
        }
      })
      if (rows.length > 0) out['matched_others'] = rows
    }
    if (typeof response['hint_kind'] === 'string') out['hint_kind'] = response['hint_kind']
    if (typeof response['hint_tier'] === 'number') out['hint_tier'] = response['hint_tier']
    if (response['hint_suspicious'] === true) out['hint_suspicious'] = true
    return out
  }

  private async read(state: SessionState, args: SessionToolArgs): Promise<SessionToolResult> {
    const what = typeof args.what === 'string' ? args.what : ''
    if (!['text', 'value', 'count', 'attr'].includes(what)) {
      throw new SessionToolError('config_error', `read needs what one of text | value | count | attr (got ${JSON.stringify(args.what)})`)
    }
    if (!nonEmpty(args.selector)) throw new SessionToolError('config_error', 'read needs a selector')
    const body: Record<string, unknown> = { type: 'read', what, selector: args.selector }
    if (what === 'attr') {
      if (!nonEmpty(args.attr)) throw new SessionToolError('config_error', "read what='attr' needs attr")
      body['attr'] = args.attr
    }
    const response = await this.request(state, body)
    if (response['ok'] !== true) return this.engineFailure(response, 'read')
    const value = response['value']
    return {
      ok: true,
      op: 'read',
      session_id: state.id,
      what,
      selector: args.selector,
      value: typeof value === 'string' ? clip(value, READ_MAX_CHARS) : value,
      ...(typeof value === 'string' && value.length > READ_MAX_CHARS ? { value_truncated: true } : {}),
    }
  }

  private async extract(state: SessionState, args: SessionToolArgs): Promise<SessionToolResult> {
    if (!nonEmpty(args.rows)) throw new SessionToolError('config_error', 'extract needs rows (a CSS selector)')
    if (!isObj(args.fields) || Object.keys(args.fields).length === 0) {
      throw new SessionToolError('config_error', 'extract needs fields ({name: css | "." | "@attr"})')
    }
    const maxItems = Math.max(1, Math.min(EXTRACT_MAX_ROWS, Math.floor(args.max_items ?? EXTRACT_MAX_ROWS)))
    const response = await this.request(state, {
      type: 'extract', rows: args.rows, fields: args.fields, maxItems,
    })
    if (response['ok'] !== true) return this.engineFailure(response, 'extract')
    const rows = Array.isArray(response['rows']) ? response['rows'] : []
    return {
      ok: true,
      op: 'extract',
      session_id: state.id,
      rows: rows.slice(0, EXTRACT_MAX_ROWS),
      count: typeof response['count'] === 'number' ? response['count'] : rows.length,
      capped: response['capped'] === true,
    }
  }

  private async signal(state: SessionState, args: SessionToolArgs): Promise<SessionToolResult> {
    if (!isObj(args.signal)) throw new SessionToolError('config_error', 'signal needs a signal object')
    const response = await this.request(state, { type: 'signal', signal: args.signal })
    if (response['ok'] !== true) return this.engineFailure(response, 'signal')
    return { ok: true, op: 'signal', session_id: state.id, held: response['held'] === true }
  }

  private async waitFor(state: SessionState, args: SessionToolArgs): Promise<SessionToolResult> {
    if (!isObj(args.signal)) throw new SessionToolError('config_error', 'wait_for needs a signal object')
    const timeoutMs = Math.max(0, Math.min(120_000, Math.floor(args.timeout_ms ?? 15_000)))
    const response = await this.request(
      state,
      { type: 'waitFor', signal: args.signal, timeoutMs },
      Math.max(this.options.opTimeoutMs, timeoutMs + 15_000),
    )
    if (response['ok'] !== true) return this.engineFailure(response, 'wait_for')
    return {
      ok: true,
      op: 'wait_for',
      session_id: state.id,
      held: response['held'] === true,
      elapsed_ms: typeof response['elapsed_ms'] === 'number' ? response['elapsed_ms'] : undefined,
    }
  }

  private async snapshot(state: SessionState, args: SessionToolArgs): Promise<SessionToolResult> {
    const response = await this.request(state, {
      type: 'snapshot',
      // 设计 Q4：桥缺省不截图（模型面只看路径）；显式 screenshot:true 才截。
      screenshot: args.screenshot === true,
    }, Math.max(this.options.opTimeoutMs, 90_000))
    if (response['ok'] !== true) return this.engineFailure(response, 'snapshot')
    return {
      ok: true,
      op: 'snapshot',
      session_id: state.id,
      url: response['url'],
      title: response['title'],
      snapshot_file: response['snapshot_file'],
      pool_file: response['pool_file'],
      ...(response['screenshot_file'] === undefined ? {} : { screenshot_file: response['screenshot_file'] }),
      counts: response['counts'],
    }
  }

  private async closeSessionOp(state: SessionState): Promise<SessionToolResult> {
    const summary = await this.closeSession(state.id, 'closed')
    return {
      ok: true,
      op: 'close',
      session_id: state.id,
      closed: true,
      requests: summary.requests,
      actions: summary.actions,
      duration_ms: summary.duration_ms,
      urls: summary.urls,
      evidence_dir: summary.evidence_dir,
      ...(summary.record === undefined ? {} : { record: summary.record }),
      next: summary.record === undefined
        ? ['sessions are gone; evidence dir kept for inspection']
        : [`amber session export --record ${summary.record} --id <appId>  (then: amber apps check <appId>)`],
    }
  }

  private engineFailure(response: Record<string, unknown>, op: string): SessionToolResult {
    return {
      ok: false,
      op,
      code: typeof response['code'] === 'string' ? response['code'] : 'engine_error',
      reason: typeof response['reason'] === 'string' ? clip(response['reason'], 1000) : '',
      session_alive: true,
    }
  }

  /* ------------------------------------------------------------ 关闭 / 杀进程树 */

  private async closeSession(id: string, reason: string): Promise<{
    requests: number; actions: number; duration_ms: number; urls: string[]; evidence_dir: string; record?: string
  }> {
    const state = this.sessions.get(id)
    if (state === undefined) {
      throw new SessionToolError('session_not_found', `no live session ${JSON.stringify(id)}`)
    }
    this.sessions.delete(id)
    const started = Date.now()
    let summary: Record<string, unknown> = {}
    if (!state.dead && !state.closing) {
      state.closing = true
      try {
        summary = await this.request(state, { type: 'close' }, 10_000)
      } catch {
        // close 失败不影响"会话必须结束"：走 kill 树兜底。
      }
    }
    await this.terminate(state, 3_000)
    void reason
    return {
      requests: typeof summary['requests'] === 'number' ? summary['requests'] : state.requests,
      actions: typeof summary['actions'] === 'number' ? summary['actions'] : state.actions,
      duration_ms: typeof summary['duration_ms'] === 'number' ? summary['duration_ms'] : Date.now() - started,
      urls: Array.isArray(summary['urls']) ? (summary['urls'] as unknown[]).filter((u): u is string => typeof u === 'string') : [],
      evidence_dir: typeof summary['evidence_dir'] === 'string' ? summary['evidence_dir'] : path.join(this.evidenceRoot, state.id),
      ...(typeof summary['record'] === 'string' ? { record: summary['record'] } : {}),
    }
  }

  /** 等子进程自然退出；超时 → 杀整棵进程树（浏览器是孙进程，必须按树杀）。 */
  private async terminate(state: SessionState, graceMs = 3_000): Promise<void> {
    if (state.dead) {
      await Promise.race([state.exitPromise, Promise.resolve()])
      return
    }
    const exited = await Promise.race([
      state.exitPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ])
    if (exited) return
    await killTree(state.child)
    await Promise.race([state.exitPromise, new Promise<void>((resolve) => setTimeout(resolve, 2_000))])
  }
}

/** 杀进程树：Windows 用 taskkill /T（浏览器孙进程），其它平台 SIGKILL 子进程。 */
export function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return Promise.resolve()
  if (process.platform === 'win32') {
    return new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('exit', () => resolve())
      killer.on('error', () => { try { child.kill('SIGKILL') } catch { /* already gone */ } resolve() })
      setTimeout(resolve, 3_000)
    })
  }
  try { child.kill('SIGKILL') } catch { /* already gone */ }
  return Promise.resolve()
}

/**
 * 工具执行入口（`amberflow_session` 的 execute）。所有失败都以 `{ok:false, code, reason}`
 * 返回（工具级错误 = 会话不可用/桥故障；引擎结构化失败原样透传且 == 会话仍存活）。
 */
export async function handleSessionTool(
  args: SessionToolArgs,
  manager: SessionManager,
): Promise<SessionToolResult> {
  try {
    return await manager.handle(args)
  } catch (error) {
    if (error instanceof SessionToolError) {
      return { ok: false, op: typeof args.op === 'string' ? args.op : '', code: error.code, reason: error.message, ...error.extra }
    }
    return {
      ok: false,
      op: typeof args.op === 'string' ? args.op : '',
      code: 'internal_error',
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
