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
import { clampElementMax, ELEMENT_DEFAULT_MAX, projectElementViews } from './element-view.ts'

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
/** 返回体有界裁剪（与设计 §6 一致）。observe 的元素行 cap/截断合同在 `./element-view.ts`。 */
export const EXTRACT_MAX_ROWS = 20
/**
 * C1：`save:true` 时桥内翻页的**每页行数**（引擎 extract 的 maxItems 上限同为 500）
 * 与硬顶（2000 行 / 4MB）——超过硬顶如实标 `truncated`，不假装取全。
 */
export const SAVE_PAGE = 500
export const SAVE_MAX = 2000
export const SAVE_MAX_BYTES = 4 * 1024 * 1024
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
  /** C1：本会话已落盘的 extract 文件数（`extract-<n>.json` 的 n，从 1 起）。 */
  extractSaves: number
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
  /** A2：不传 = 引擎缺省 fail（歧义不执行）；`"act"` 恢复旧行为。只在有值时透传。 */
  on_ambiguous?: 'fail' | 'act'
  value?: unknown
  to?: 'bottom' | 'top' | 'page'
  by?: number
  selector?: string
  what?: 'text' | 'value' | 'count' | 'attr'
  attr?: string
  rows?: string
  fields?: Record<string, string>
  max_items?: number
  /** C1：extract 续页起点（0-based 整数 0..10000；与 max_items 一起分页）。 */
  offset?: number
  /** C1：extract save:true = 桥内翻页取全并落盘（每页 ≤500，硬顶 2000 行/4MB）。 */
  save?: boolean
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
      extractSaves: 0,
      dead: false,
      exitPromise: Promise.resolve(),
      closing: false,
    }
    this.wire(state)
    this.sessions.set(id, state)
    try {
      const ready = await this.waitReady(state)
      if (ready['ok'] !== true) {
        // 导航 flap 且自愈失败：CLI open 以 ok:false + 完整诊断组关闭——把诊断带进工具错误，
        // 不只留 code/reason（task-41：与 task-36 歧义透传同模式）。
        const failExtra: Record<string, unknown> = {}
        if (ready['code'] === 'navigation_flapping') {
          if (Array.isArray(ready['urls_sample'])) failExtra['urls_sample'] = (ready['urls_sample'] as unknown[]).slice(0, 5).map(String)
          if (typeof ready['navigations'] === 'number') failExtra['navigations'] = ready['navigations']
          if (typeof ready['healed'] === 'boolean') failExtra['healed'] = ready['healed']
        }
        await this.closeSession(id, 'open_failed').catch(() => undefined)
        throw new SessionToolError(
          typeof ready['code'] === 'string' ? ready['code'] : 'unreachable',
          typeof ready['reason'] === 'string' ? ready['reason'] : 'session open failed',
          failExtra,
        )
      }
      state.url = typeof ready['url'] === 'string' && ready['url'] !== '' ? ready['url'] : url
      if (typeof ready['title'] === 'string') state.title = ready['title']
      // task-41：CLI open 判定导航 flap（自愈成功）时透传诊断字段组；
      // 未判定 flap 时这些键不存在 → 响应键集与此前逐字节一致。
      const flapFields: Record<string, unknown> = ready['code'] === 'navigation_flapping'
        ? {
            code: 'navigation_flapping',
            ...(typeof ready['navigations'] === 'number' ? { navigations: ready['navigations'] } : {}),
            ...(typeof ready['window_ms'] === 'number' ? { window_ms: ready['window_ms'] } : {}),
            ...(Array.isArray(ready['urls_sample']) ? { urls_sample: (ready['urls_sample'] as unknown[]).slice(0, 5).map(String) } : {}),
            ...(typeof ready['healed'] === 'boolean' ? { healed: ready['healed'] } : {}),
            ...(typeof ready['heal_url'] === 'string' ? { heal_url: ready['heal_url'] } : {}),
            ...(typeof ready['reason'] === 'string' ? { reason: String(ready['reason']).slice(0, 200) } : {}),
            ...(typeof ready['suggestion'] === 'string' ? { suggestion: String(ready['suggestion']).slice(0, 200) } : {}),
          }
        : {}
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
        ...flapFields,
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
    // 元素行投影走共享合同（element-view.ts）：与 …_inspect 同形同义（hint_candidates /
    // why_not_admitted / 同一 cap 表）。这里只决定行数钳制与信封字段，不手写字段裁剪。
    const max = clampElementMax(args.max, ELEMENT_DEFAULT_MAX)
    const response = await this.request(state, {
      type: 'observe',
      max,
      ...(args.selector === undefined ? {} : { selector: args.selector }),
      ...(args.include_hidden === undefined ? {} : { includeHidden: args.include_hidden }),
    })
    if (response['ok'] !== true) return this.engineFailure(response, 'observe')
    const { elements, truncated } = projectElementViews(response['elements'], max)
    const counts = isObj(response['counts']) ? response['counts'] : undefined
    return {
      ok: true,
      op: 'observe',
      session_id: state.id,
      url: response['url'],
      ...(typeof response['title'] === 'string' ? { title: response['title'] } : {}),
      ...(Array.isArray(response['frames']) ? { frames: response['frames'] } : {}),
      ...(counts !== undefined ? { counts } : {}),
      truncated,
      elements,
      ...(Array.isArray(response['frame_counts']) ? { frame_counts: response['frame_counts'] } : {}),
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
    // A2：歧义策略只在显式给值时进请求体（缺省由引擎给 fail）；引擎/CLI 仍是唯一的语义面，
    // 桥只做形状校验 + 透传。
    if (args.on_ambiguous !== undefined) {
      const mode: unknown = args.on_ambiguous
      if (mode !== 'fail' && mode !== 'act') {
        throw new SessionToolError('config_error', `on_ambiguous must be one of fail | act (got ${JSON.stringify(args.on_ambiguous)})`, {
          allowed_modes: ['fail', 'act'],
        })
      }
      body['onAmbiguous'] = mode
    }
    if (args.value !== undefined) body['value'] = args.value
    if (args.to !== undefined) body['to'] = args.to
    if (args.by !== undefined) body['by'] = args.by
    // B1：失败截图 opt-in（缺省不传 = 会话不碰截图；只在动作失败时落盘）。
    if (args.screenshot === true) body['screenshot'] = true
    const response = await this.request(state, body)
    const base = { op: 'act', session_id: state.id, act_op: actOp, target: args.target ?? null }
    // task-36：歧义诊断**原样透传**（引擎有这些键才出现）——交互试错第一诉求是"为什么点错/
    // 是不是多个候选"，而 CLI 会话面已经用 B1 旁路算好了；bridge 只做有界映射，不重算、不猜。
    // 语义纪律：ambiguous 是**诊断事实**不是错误（ok:true 也回显）；缺键 = 精确形状，响应不变。
    const ambiguity = this.ambiguityDiagnostics(response)
    // B2：滚动证据（moved/delta/scroll）同样只透传、不重算——引擎给什么就回什么（成功/失败
    // 同一口径：not_scrollable 也带 moved:false 与当时的容器几何）。
    const scroll = this.scrollDiagnostics(response)
    if (response['ok'] !== true) {
      // B1：被遮挡/超时失败现场 + opt-in 失败截图路径（只在引擎给了才出现；不内联图片）。
      const actionability = this.actionabilityEvidence(response['actionability'])
      return {
        ...this.engineFailure(response, 'act'),
        ...ambiguity,
        ...scroll,
        ...(actionability === undefined ? {} : { actionability }),
        ...(typeof response['screenshot_file'] === 'string' ? { screenshot_file: response['screenshot_file'] } : {}),
        ...base,
      }
    }
    return {
      ok: true,
      ...base,
      executed: response['executed'] === true,
      ref: response['ref'] ?? null,
      how: response['how'] ?? null,
      changed: response['changed'] === true,
      url: response['url'] ?? state.url,
      ...scroll,
      ...(isObj(response['after']) ? { after: response['after'] } : {}),
      ...ambiguity,
    }
  }

  /**
   * B2：act 滚动证据的有界透传（引擎响应里有才有；不重算 moved/delta、不补字段）。
   *
   * 来源：`mw.scrollIntoView` / `mw.scrollContainer` / `mw.scrollDocument` 的**实测**读数——
   * `moved` 是容器 scrollTop 前后差非零，`delta` 是差值，`scroll` 是容器三件套（三个都在
   * 才算数）。像素值取整并夹到非负（DOM scrollTop/scrollHeight/clientHeight 的取值面），
   * 只是有界化，不改变事实。
   */
  private scrollDiagnostics(response: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    if (typeof response['moved'] === 'boolean') out['moved'] = response['moved']
    if (typeof response['delta'] === 'number' && Number.isFinite(response['delta'])) {
      out['delta'] = Math.round(response['delta'])
    }
    const raw = response['scroll']
    if (isObj(raw)) {
      const geo: Record<string, number> = {}
      for (const key of ['scrollTop', 'scrollHeight', 'clientHeight'] as const) {
        const v = raw[key]
        if (typeof v === 'number' && Number.isFinite(v)) geo[key] = Math.max(0, Math.round(v))
      }
      if (typeof geo['scrollTop'] === 'number' && typeof geo['scrollHeight'] === 'number'
        && typeof geo['clientHeight'] === 'number') {
        out['scroll'] = geo
      }
    }
    return out
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

  /**
   * B1：act 失败现场（`actionability`）的**有界透传**（引擎有才有；不重算、不补键）。
   *
   * 来源：引擎 `occludedReason` / `_readActionabilityDetail` 的 `ActionabilityDetail`——
   * `reason`（≤200）、`bbox`（四个有限数才收，否则 `null` 照实保留）、`blocker`（≤60）、
   * `requery`（present|detached|unknown，≤60）。bridge 只裁剪形状，不改事实。
   */
  private actionabilityEvidence(raw: unknown): Record<string, unknown> | undefined {
    if (!isObj(raw)) return undefined
    const out: Record<string, unknown> = {}
    if (typeof raw['reason'] === 'string') out['reason'] = clip(raw['reason'], 200)
    const bbox = raw['bbox']
    if (isObj(bbox)) {
      const b: Record<string, number> = {}
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        const v = bbox[key]
        if (typeof v === 'number' && Number.isFinite(v)) b[key] = v
      }
      if (Object.keys(b).length === 4) out['bbox'] = b
    } else if (bbox === null) {
      out['bbox'] = null
    }
    if (typeof raw['blocker'] === 'string') out['blocker'] = clip(raw['blocker'], 60)
    if (raw['requery'] === 'present' || raw['requery'] === 'detached' || raw['requery'] === 'unknown') {
      out['requery'] = raw['requery']
    }
    return Object.keys(out).length > 0 ? out : undefined
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
    // C1：offset 只做续页起点（0-based 整数 0..10000）；非整数/越界 = config_error，不 clamp。
    const offset = args.offset === undefined ? 0 : args.offset
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 10_000) {
      throw new SessionToolError('config_error', `extract offset must be an integer in [0, 10000] (got ${JSON.stringify(args.offset)})`, {
        hint: 'count is the rows returned on THIS page, not the total; advance offset by count to page through.',
      })
    }
    const maxItems = Math.max(1, Math.min(EXTRACT_MAX_ROWS, Math.floor(args.max_items ?? EXTRACT_MAX_ROWS)))
    const rows = args.rows
    const fields = args.fields
    const response = await this.request(state, {
      type: 'extract', rows, fields, maxItems,
      ...(offset > 0 ? { offset } : {}),
    })
    if (response['ok'] !== true) return this.engineFailure(response, 'extract')
    const page = Array.isArray(response['rows']) ? response['rows'] as Array<Record<string, unknown>> : []
    const result: SessionToolResult = {
      ok: true,
      op: 'extract',
      session_id: state.id,
      rows: page.slice(0, EXTRACT_MAX_ROWS),
      count: typeof response['count'] === 'number' ? response['count'] : page.length,
      capped: response['capped'] === true,
      // C1：分页事实只在引擎给的时候透传（capped 或 offset>0 才出现）——旧响应键集逐字节不变。
      ...(typeof response['offset'] === 'number' ? { offset: response['offset'] } : {}),
      ...(typeof response['total'] === 'number' ? { total: response['total'] } : {}),
      ...(typeof response['has_more'] === 'boolean' ? { has_more: response['has_more'] } : {}),
    }
    if (args.save === true) {
      const saved = await this.saveExtract(state, { rows, fields, offset })
      if (saved.ok !== true) return saved.response
      Object.assign(result, saved.fields)
    }
    return result
  }

  /**
   * C1：`save:true` 的桥内翻页（**只组合，不新增引擎语义**）——每页一个 `extract` 请求
   * （maxItems = SAVE_PAGE、offset 递增），终止判据来自引擎的 `has_more`；引擎没给
   * （本页未被 cap 且 offset=0）就按「本页行数 < 页大小 = 末页」。硬顶 2000 行 / 4MB，
   * 超过就少写并如实标 `truncated` + `save_limit`——绝不假装取全。
   *
   * 文件名 `<evidenceRoot>/<session_id>/extract-<n>.json`，n 是本会话的落盘序号（从 1 起）。
   * 文件是合法 JSON：`{session_id, rows_selector, fields, offset, saved, truncated?, save_limit?, rows:[…]}`，
   * 一行一个行对象（便于直接看/数行，也不把 2000 行压成一行）。
   */
  private async saveExtract(
    state: SessionState,
    req: { rows: string; fields: Record<string, string>; offset: number },
  ): Promise<{ ok: true; fields: Record<string, unknown> } | { ok: false; response: SessionToolResult }> {
    /** 每行格式 = `<compact JSON>,\n`；元数据/括号预留（字段名很长的极端场景由收尾字节校验兜底）。 */
    const OVERHEAD = 4096
    const serialized: string[] = []
    let offset = req.offset
    let bytes = 0
    let stop: 'end' | 'max_rows' | 'max_bytes' = 'end'
    for (;;) {
      const page = await this.request(state, {
        type: 'extract', rows: req.rows, fields: req.fields, maxItems: SAVE_PAGE,
        ...(offset > 0 ? { offset } : {}),
      })
      if (page['ok'] !== true) return { ok: false, response: this.engineFailure(page, 'extract') }
      const pageRows = Array.isArray(page['rows']) ? (page['rows'] as unknown[]) : []
      for (const row of pageRows) {
        if (serialized.length >= SAVE_MAX) { stop = 'max_rows'; break }
        const json = JSON.stringify(row)
        const rowBytes = Buffer.byteLength(json, 'utf8') + 2
        if (bytes + rowBytes + OVERHEAD > SAVE_MAX_BYTES) { stop = 'max_bytes'; break }
        serialized.push(json)
        bytes += rowBytes
      }
      if (stop !== 'end') break
      const hasMore = typeof page['has_more'] === 'boolean' ? page['has_more'] : pageRows.length >= SAVE_PAGE
      if (!hasMore || pageRows.length === 0) break
      offset += pageRows.length
    }
    /** 合法 JSON（`rows` 一行一个对象）：`header` + `"rows":[\n` + rows + `\n]}\n`。 */
    const render = (rows: string[]): string => {
      const meta = JSON.stringify({
        session_id: state.id,
        rows_selector: req.rows,
        fields: req.fields,
        offset: req.offset,
        saved: rows.length,
        truncated: stop !== 'end',
        ...(stop === 'end' ? {} : { save_limit: stop }),
      })
      return `${meta.slice(0, -1)},"rows":[\n${rows.join(',\n')}\n]}\n`
    }
    let text = render(serialized)
    while (Buffer.byteLength(text, 'utf8') > SAVE_MAX_BYTES && serialized.length > 0) {
      serialized.pop()
      stop = 'max_bytes'
      text = render(serialized)
    }
    const n = state.extractSaves + 1
    state.extractSaves = n
    const file = path.join(this.evidenceRoot, state.id, `extract-${n}.json`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text, 'utf8')
    return {
      ok: true,
      fields: {
        file,
        saved: serialized.length,
        bytes: Buffer.byteLength(text, 'utf8'),
        ...(stop === 'end' ? {} : { truncated: true, save_limit: stop }),
      },
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
    const ambiguity = this.ambiguityEvidence(response['ambiguity'])
    // A4：落空判别证据（引擎有才有；act 的 target_not_found 路径）。其它 op 的失败不带它。
    const diagnostics = this.missDiagnosticsEvidence(response['diagnostics'])
    return {
      ok: false,
      op,
      code: typeof response['code'] === 'string' ? response['code'] : 'engine_error',
      reason: typeof response['reason'] === 'string' ? clip(response['reason'], 1000) : '',
      // C2：引擎的机器可读错误标记原样透传（extract/observe 的 `error:"bad_selector"`；
      // 其它失败面不设置 ⇒ 键集与之前逐字节一致）。桥不重算/不补键。
      ...(response['error'] === 'bad_selector' ? { error: 'bad_selector' as const } : {}),
      session_alive: true,
      ...(ambiguity === undefined ? {} : { ambiguity }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
    }
  }

  /**
   * A4：落空判别证据的**有界透传**（引擎有才有；不重算、不补键、不改语义）。
   *
   * 上限：`candidates` ≤3、`near` ≤3、`rejected` ≤2 行；每行 `ref`/`tag` ≤16、`label`/`why`
   * ≤40；`hint_shape` ≤32。缺键 = 引擎没提供，桥不发明（与 `ambiguityEvidence` 同一纪律）。
   */
  private missDiagnosticsEvidence(raw: unknown): Record<string, unknown> | undefined {
    if (!isObj(raw)) return undefined
    const out: Record<string, unknown> = {}
    if (typeof raw['target'] === 'string') out['target'] = raw['target']
    if (typeof raw['pool_size'] === 'number') out['pool_size'] = raw['pool_size']
    if (typeof raw['hint_shape'] === 'string') out['hint_shape'] = clip(raw['hint_shape'], 32)
    if (typeof raw['hint_len'] === 'number') out['hint_len'] = raw['hint_len']
    const rows = (key: string, cap: number): Array<Record<string, unknown>> | undefined => {
      const list = raw[key]
      if (!Array.isArray(list)) return undefined
      return list.slice(0, cap).map((entry) => {
        const row = isObj(entry) ? entry : {}
        const projected: Record<string, unknown> = {}
        if (typeof row['ref'] === 'string') projected['ref'] = clip(row['ref'], 16)
        if (typeof row['tag'] === 'string') projected['tag'] = clip(row['tag'], 16)
        if (typeof row['label'] === 'string') projected['label'] = clip(row['label'], 40)
        if (typeof row['why'] === 'string') projected['why'] = clip(row['why'], 40)
        return projected
      })
    }
    const candidates = rows('candidates', 3)
    if (candidates !== undefined) out['candidates'] = candidates
    const near = rows('near', 3)
    if (near !== undefined) out['near'] = near
    const rejected = rows('rejected', 2)
    if (rejected !== undefined) out['rejected'] = rejected
    return Object.keys(out).length > 0 ? out : undefined
  }

  /**
   * A2：`ambiguity` 证据的**有界透传**（引擎有才有；不重算、不补键、不改语义）。
   *
   * 上限与引擎侧同一张表：候选 ≤5 行、ref/tag/role ≤16、label/class/near ≤40、
   * suggested_hint ≤80、target ≤120。缺键 = 引擎没提供，桥不发明。
   */
  private ambiguityEvidence(raw: unknown): Record<string, unknown> | undefined {
    if (!isObj(raw)) return undefined
    const out: Record<string, unknown> = {}
    if (typeof raw['target'] === 'string') out['target'] = clip(raw['target'], 120)
    if (raw['source'] === 'pool' || raw['source'] === 'dom_fallback') out['source'] = raw['source']
    if (typeof raw['tier'] === 'number') out['tier'] = raw['tier']
    if (typeof raw['would_act_ref'] === 'string') out['would_act_ref'] = clip(raw['would_act_ref'], 16)
    if (typeof raw['candidates_total'] === 'number') out['candidates_total'] = raw['candidates_total']
    if (typeof raw['truncated'] === 'boolean') out['truncated'] = raw['truncated']
    if (Array.isArray(raw['candidates'])) {
      out['candidates'] = raw['candidates'].slice(0, 5).map((rawRow) => {
        const row = isObj(rawRow) ? rawRow : {}
        const projected: Record<string, unknown> = {}
        if (typeof row['ref'] === 'string') projected['ref'] = clip(row['ref'], 16)
        if (typeof row['tag'] === 'string') projected['tag'] = clip(row['tag'], 16)
        if (typeof row['role'] === 'string') projected['role'] = clip(row['role'], 16)
        if (typeof row['label'] === 'string') projected['label'] = clip(row['label'], 40)
        if (typeof row['class'] === 'string') projected['class'] = clip(row['class'], 40)
        if (typeof row['near'] === 'string') projected['near'] = clip(row['near'], 40)
        if (typeof row['frame'] === 'number') projected['frame'] = row['frame']
        if (typeof row['same_label'] === 'boolean') projected['same_label'] = row['same_label']
        if (typeof row['suggested_hint'] === 'string') projected['suggested_hint'] = clip(row['suggested_hint'], 80)
        return projected
      })
    }
    return Object.keys(out).length > 0 ? out : undefined
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
