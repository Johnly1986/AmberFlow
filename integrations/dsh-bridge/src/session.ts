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
import {
  BRIDGE_ACT_OPS, BRIDGE_AMBIGUITY_MODES, BRIDGE_DRIVE_COMMANDS, BRIDGE_DRIVE_DRIVERS,
  BRIDGE_DRIVE_LIMITS, BRIDGE_OP_ENGINE_TYPE, BRIDGE_READ_WHATS,
  BRIDGE_SESSION_CONCURRENCY, BRIDGE_SESSION_IDLE, BRIDGE_SESSION_OPS, BRIDGE_SESSION_TIMEOUTS,
  BRIDGE_TAB_ACTIONS, BRIDGE_WINDOW_MODES,
  type BridgeAmbiguousMode, type BridgeDriveCommand, type BridgeDriveDriver, type BridgeReadWhat,
  type BridgeScrollTarget, type BridgeTabAction, type BridgeWindowMode,
} from './session-contract.generated.ts'
import {
  BRIDGE_EVIDENCE_AMBIGUITY_CAPS,
  BRIDGE_EVIDENCE_MISS_CAPS,
  BRIDGE_EVIDENCE_WIDE_CAPS,
  BRIDGE_HANDOFF_CAPS,
} from './session-contract.generated.ts'

/** 缺省 idle TTL（桥管理器与引擎 CLI 缺省同值；边界见生成物 `BRIDGE_SESSION_IDLE`）。 */
export const DEFAULT_SESSION_IDLE_MS = BRIDGE_SESSION_IDLE.defaultMs
/** 缺省同时在册会话上限。 */
export const DEFAULT_MAX_SESSIONS = BRIDGE_SESSION_CONCURRENCY.defaultMaxSessions
/** CLI 侧的孤儿兜底（缺省 TTL × orphanFactor；显式 ttl 按生成物里的区间钳制）。 */
export const CLI_ORPHAN_IDLE_MS = BRIDGE_SESSION_IDLE.orphanDefaultMs
/** 单 op 读超时缺省。 */
export const DEFAULT_OP_TIMEOUT_MS = BRIDGE_SESSION_TIMEOUTS.opDefaultMs
/** `open` 的读超时（首次启动浏览器 + 导航）。 */
export const DEFAULT_OPEN_TIMEOUT_MS = BRIDGE_SESSION_TIMEOUTS.openDefaultMs
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
  spawnArgv?: (spec: { url: string; outDir: string; recordPath: string | null; hosts: string[]; headful: boolean; window: BridgeWindowMode | null; /** F80：CLI 孤儿兜底（已按 openSession 规则算好；缺省 = CLI_ORPHAN_IDLE_MS 逐字节不变）。 */ orphanIdleMs?: number }) => string[]
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
  /** F80：本会话的 idle TTL（open 的 idle_timeout_ms；undefined = 管理器缺省，`0` = reaper 跳过）。 */
  idleMs?: number
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
  /** F80：本会话的生效 idle TTL（显式 0 回显 0 = 不限；缺省 = 管理器缺省）。 */
  idle_timeout_ms: number
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
  /** 有头窗口尺寸（open）：`maximized` | `fullscreen`；需有头（headful:true 或部署 Config.headful）。 */
  window?: BridgeWindowMode
  record?: boolean
  act_op?: string
  /** act：目标 hint 字符串；drive_command `resume`：字符串 value 的显式值袋键。 */
  target?: string
  /** A2：不传 = 引擎缺省 fail（歧义不执行）；`"act"` 恢复旧行为。只在有值时透传。 */
  on_ambiguous?: BridgeAmbiguousMode
  /** F72：act 的 rehydrate 重扫 opt-in（true 才透传；缺省不传 = 引擎缺省关）。 */
  rehydrate_rescan?: boolean
  /**
   * act `fill`/`select`（string）/ `set_range`（`{value:number}` 或 `{percent:0..100}`，二选一）
   * / drive_command `resume`。原样透传，桥不猜值。
   */
  value?: unknown
  to?: BridgeScrollTarget
  by?: number
  selector?: string
  what?: BridgeReadWhat
  attr?: string
  rows?: string
  fields?: Record<string, string>
  max_items?: number
  /** C1：extract 续页起点（0-based 整数 0..10000；与 max_items 一起分页）。 */
  offset?: number
  /** C1：extract save:true = 桥内翻页取全并落盘（每页 ≤500，硬顶 2000 行/4MB）。 */
  save?: boolean
  /**
   * F89：extract 稳定读口径（缺省不传 = 双指标缺省门运行，响应恒带 settled；
   * `false` = 请求级 opt-out 跳过双门，settled 缺键；`true` = 冗余兼容）。
   */
  wait_settled?: boolean
  signal?: Record<string, unknown>
  timeout_ms?: number
  max?: number
  include_hidden?: boolean
  /** B 批：observe 的结构证据 opt-in（透传 `includeStructure`；缺省不传 = 引擎 false）。 */
  include_structure?: boolean
  screenshot?: boolean
  /** F76：tab op 的动作（缺省 'list'；非法值 = config_error 报闭集）。 */
  tab_action?: BridgeTabAction
  /** F76：tab switch 的匹配条件（AND；至少一个键的语义校验在引擎 ctx-validate，桥只做形状校验）。 */
  match?: { index?: number; urlContains?: string; titleContains?: string }
  // ---- drive（pilot 在**同一会话页**上驾驶；不新增工具/命令，op 扩展）----
  /** drive：一行目标（必填；与 `engine pilot protocol goal` 同义）。 */
  goal?: string
  /** drive：可选完成信号（与 run done / pilot --final-signal 同一信号语言）。 */
  final_signal?: Record<string, unknown>
  /** drive：驾驶步预算 1..200（缺省引擎缺省）。 */
  max_steps?: number
  /** drive：置信下限 [0,1]（缺省引擎/provider 口径）。 */
  conf_floor?: number
  /** drive：任务页 URL 子串（每轮驾驶前不含即 off_task_page）。 */
  expect_url?: string
  /** drive：决策驱动档——model（模型投票，缺省）| agent（每步等 resume 点名，零模型票）。 */
  driver?: BridgeDriveDriver
  /** drive：槽位值（k=v 字符串；值只来自调用方显式给，桥不猜）。 */
  slots?: Record<string, string>
  /** drive_command：兜底指令闭集。 */
  cmd?: BridgeDriveCommand
  /** drive_command resume：点名收窄目标（hint 唯一命中即确定性执行）。 */
  hint?: string
  /** drive_command resume.skip：把最近一次驾驶选中的目标加入禁选后继续（不点名换目标的兜底）。 */
  skip?: boolean
  /** drive_command：备注（finish/abort 的收尾说明）。 */
  note?: string
  /**
   * F80：open 专属的会话 idle TTL（ms）。undefined = 管理器缺省（逐字节不变）；`0` = 不限
   * （仅显式，reaper 跳过该会话）；非整数或 1..999 = config_error。**其他 op 传入 = config_error**。
   */
  idle_timeout_ms?: number
}

export type SessionToolResult = Record<string, unknown>

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
      idleMs: Math.max(BRIDGE_SESSION_IDLE.minExplicitMs, options.idleMs ?? DEFAULT_SESSION_IDLE_MS),
      maxSessions: Math.max(BRIDGE_SESSION_CONCURRENCY.configMinSessions, options.maxSessions ?? DEFAULT_MAX_SESSIONS),
      opTimeoutMs: Math.max(BRIDGE_SESSION_TIMEOUTS.timeoutFloorMs, options.opTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS),
      openTimeoutMs: Math.max(BRIDGE_SESSION_TIMEOUTS.timeoutFloorMs, options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS),
      reaperMs: Math.max(BRIDGE_SESSION_TIMEOUTS.reaperFloorMs, options.reaperMs ?? BRIDGE_SESSION_TIMEOUTS.reaperDefaultMs),
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
        // F80：生效 TTL additive 回显（显式 0 回显 0 = 不限；缺省 = 管理器缺省）。
        idle_timeout_ms: s.idleMs ?? this.options.idleMs,
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
      // F80：会话级 TTL —— `0` = 显式不限（reaper 跳过该会话）；undefined = 管理器缺省（逐字节不变）。
      const ttl = s.idleMs
      if (ttl !== 0 && now - s.lastActivity > (ttl ?? this.options.idleMs)) {
        await this.closeSession(id, 'idle_timeout').catch(() => undefined)
      }
    }
  }

  /** 工具入口：所有 op 的唯一实现。 */
  async handle(args: SessionToolArgs): Promise<SessionToolResult> {
    const op = typeof args.op === 'string' ? args.op : ''
    if (!(BRIDGE_SESSION_OPS as readonly string[]).includes(op)) {
      throw new SessionToolError('config_error', `op must be one of ${BRIDGE_SESSION_OPS.join(' | ')} (got ${JSON.stringify(args.op)})`, {
        allowed_ops: [...BRIDGE_SESSION_OPS],
      })
    }
    // F80：idle_timeout_ms 是 open 专属参数——其他 op 传入 = config_error（不静默忽略）。
    if (op !== 'open' && args.idle_timeout_ms !== undefined) {
      throw new SessionToolError('config_error', `idle_timeout_ms is open-only; op ${JSON.stringify(op)} does not accept it`)
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
        case 'goto': return await this.gotoOp(state, args)
        case 'observe': return await this.observe(state, args)
        case 'act': return await this.act(state, args)
        case 'read': return await this.read(state, args)
        case 'extract': return await this.extract(state, args)
        case 'signal': return await this.signal(state, args)
        case 'wait_for': return await this.waitFor(state, args)
        case 'snapshot': return await this.snapshot(state, args)
        case 'tab': return await this.tab(state, args)
        case 'drive': return await this.driveOp(state, args)
        case 'drive_command': return await this.driveCommandOp(state, args)
        case 'drive_status': return await this.driveStatusOp(state)
        case 'drive_close': return await this.driveCloseOp(state)
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
    // F80：open 专属 idle TTL。undefined = 管理器缺省（逐字节不变）；`0` = 不限（仅显式）；
    // 非整数或 1..999 = config_error（不静默取缺省）。没有上限帽——不受部署 sessionIdleMs
    // 的 1h 配置帽约束（那约束的是管理器缺省值，不是单会话显式值）。
    const idleTtl = args.idle_timeout_ms === undefined ? undefined : args.idle_timeout_ms
    if (args.idle_timeout_ms !== undefined
      && (typeof args.idle_timeout_ms !== 'number'
        || !Number.isInteger(args.idle_timeout_ms)
        || (args.idle_timeout_ms !== 0 && args.idle_timeout_ms < BRIDGE_SESSION_IDLE.minExplicitMs))) {
      throw new SessionToolError('config_error', `idle_timeout_ms must be 0 or an integer >= ${BRIDGE_SESSION_IDLE.minExplicitMs} (got ${JSON.stringify(args.idle_timeout_ms)})`)
    }
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
    // 窗口尺寸（window）：值闭集 + 必须真有头。无头下静默忽略就是「配了没反应」——
    // 与引擎侧 session CLI 的校验同一条纪律，桥先拒（结构化 config_error），不靠子进程报错。
    if (args.window !== undefined && !(BRIDGE_WINDOW_MODES as readonly string[]).includes(args.window)) {
      throw new SessionToolError('config_error', `window must be one of ${BRIDGE_WINDOW_MODES.join(' | ')} (got ${JSON.stringify(args.window)})`)
    }
    const headed = args.headful === true || this.options.bridge.headful === true
    if (args.window !== undefined && !headed) {
      throw new SessionToolError('config_error',
        'window only applies to a headed session: pass headful:true (or enable Config.headful on this deployment)', {
          hint: 'without a visible window window would be a silent no-op, so it is rejected instead.',
        })
    }
    const id = newSessionId()
    const outDir = path.join(this.evidenceRoot, id)
    const recordPath = args.record === false ? null : path.join(outDir, 'actions.jsonl')
    // F80 spawn 联动（2026-11-16 评审收口）：子进程 idle 与 per-session TTL **同源**——
    // 显式 ttl 原样下发，否则 `idle_timeout_ms:0` 只是桥侧不限、子进程仍在 600s 后自杀
    // （headful 等人 >10min 照样死，F80 的动机没被解决）。规则：
    //   - 未显式（undefined）→ CLI_ORPHAN_IDLE_MS(600s)：缺省 300s 下 spawn argv 逐字节不变；
    //   - 显式 0 → 子进程 0（真·不限；桥 reaper 跳过 + 子进程 stdin EOF 退出兜底）；
    //   - 显式 >0 → min(24h, max(600s, 2×ttl))：孤儿兜底，且不再越 CLI --idle-timeout-ms 的 24h 帽
    //     （旧实现对 >12h 的 ttl 会生成 >24h argv 触发 spawn 用法错误）。
    const orphanIdleMs = idleTtl === undefined
      ? CLI_ORPHAN_IDLE_MS
      : (idleTtl === 0 ? 0 : Math.min(BRIDGE_SESSION_IDLE.orphanCapMs, Math.max(CLI_ORPHAN_IDLE_MS, BRIDGE_SESSION_IDLE.orphanFactor * idleTtl)))
    const argv = this.argvFor({
      url, outDir, recordPath, hosts,
      headful: args.headful === true,
      window: args.window ?? null,
      orphanIdleMs,
    })
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
      // F80：显式给的会话级 TTL 才写入（缺省不出现 = 管理器缺省，reap/list 行为逐字节不变）。
      ...(idleTtl === undefined ? {} : { idleMs: idleTtl }),
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
        // F80：回显本会话的生效 TTL（显式 0 = 不限；缺省 = 管理器缺省，逐字节不变）。
        idle_ttl_ms: state.idleMs ?? this.options.idleMs,
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

  /* ------------------------------------------------------------ goto */

  /**
   * goto：受控导航——引擎侧与 open **同一条实现**（hosts 信封前置检查、goto(domcontentloaded)、
   * unreachable/config_error 结构化分类、落地后 302 跨主机拒绝；flap 监听与有界自愈同 open
   * 路径）。桥只做形状校验 + 透传，并维护 state.url/title（tab list/会话清单显示当前页）。
   * 成功响应与 open 同形（url/title/hosts）；flap 自愈成功 = additive 诊断字段组（与 open
   * 的 flapFields 同一组键）；自愈失败 = 引擎 ok:false → engineFailure 原样投影。
   */
  private async gotoOp(state: SessionState, args: SessionToolArgs): Promise<SessionToolResult> {
    if (!nonEmpty(args.url)) throw new SessionToolError('config_error', 'goto needs a url')
    const url = this.validateUrl(args.url)
    if (args.timeout_ms !== undefined
      && (typeof args.timeout_ms !== 'number' || !Number.isInteger(args.timeout_ms)
        || args.timeout_ms < BRIDGE_SESSION_TIMEOUTS.gotoMinMs || args.timeout_ms > BRIDGE_SESSION_TIMEOUTS.gotoMaxMs)) {
      throw new SessionToolError('config_error',
        `goto timeout_ms must be an integer in [${BRIDGE_SESSION_TIMEOUTS.gotoMinMs}, ${BRIDGE_SESSION_TIMEOUTS.gotoMaxMs}] (got ${JSON.stringify(args.timeout_ms)})`)
    }
    const response = await this.request(state, {
      type: BRIDGE_OP_ENGINE_TYPE.goto, url,
      ...(args.timeout_ms === undefined ? {} : { timeoutMs: args.timeout_ms }),
    })
    if (response['ok'] !== true) return this.engineFailure(response, 'goto')
    if (typeof response['url'] === 'string' && response['url'] !== '') state.url = response['url']
    if (typeof response['title'] === 'string' && response['title'] !== '') state.title = response['title']
    return {
      ok: true,
      op: 'goto',
      session_id: state.id,
      url: response['url'],
      ...(typeof response['title'] === 'string' ? { title: response['title'] } : {}),
      ...(Array.isArray(response['hosts']) ? { hosts: response['hosts'] } : {}),
      // flap 自愈成功的诊断组（未判 flap 时键不存在 → 响应与普通导航一致）。
      ...(response['code'] === 'navigation_flapping' ? {
        code: 'navigation_flapping',
        ...(typeof response['navigations'] === 'number' ? { navigations: response['navigations'] } : {}),
        ...(typeof response['window_ms'] === 'number' ? { window_ms: response['window_ms'] } : {}),
        ...(Array.isArray(response['urls_sample']) ? { urls_sample: (response['urls_sample'] as unknown[]).slice(0, 5).map(String) } : {}),
        ...(response['healed'] === true ? { healed: true } : {}),
        ...(typeof response['heal_url'] === 'string' ? { heal_url: response['heal_url'] } : {}),
        ...(typeof response['reason'] === 'string' ? { reason: String(response['reason']).slice(0, 200) } : {}),
        ...(typeof response['suggestion'] === 'string' ? { suggestion: String(response['suggestion']).slice(0, 200) } : {}),
      } : {}),
    }
  }

  private argvFor(spec: { url: string; outDir: string; recordPath: string | null; hosts: string[]; headful: boolean; window: BridgeWindowMode | null; orphanIdleMs?: number }): string[] {
    if (this.options.spawnArgv !== undefined) return this.options.spawnArgv(spec)
    // F80：CLI 侧孤儿兜底只兜"桥进程整个没了"的会话（双层 idle）——openSession 已按
    // max(600s, 2×ttl) 算好传入；spec 没带（旧测试缝/直接调用）= 既有 600s 逐字节不变。
    const orphanIdleMs = spec.orphanIdleMs === undefined ? CLI_ORPHAN_IDLE_MS : spec.orphanIdleMs
    const args = ['session', '--url', spec.url, '--out', spec.outDir, '--idle-timeout-ms', String(orphanIdleMs)]
    for (const h of spec.hosts) args.push('--host', h)
    // headful 透传（task-37 后续修复）：工具参数 headful:true 时让引擎起可见窗口；
    // 缺省 false 不加旗标（产物/行为与此前逐字节一致）。
    if (spec.headful) args.push('--headful')
    // 有头窗口尺寸（--window）：bridge 已在 openSession 拒绝无头组合，这里只透传。
    if (spec.window !== null) args.push('--window', spec.window)
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
      if (body['type'] === BRIDGE_OP_ENGINE_TYPE.act) state.actions += 1
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
      type: BRIDGE_OP_ENGINE_TYPE.observe,
      max,
      ...(args.selector === undefined ? {} : { selector: args.selector }),
      ...(args.include_hidden === undefined ? {} : { includeHidden: args.include_hidden }),
      // B 批：结构证据 opt-in 只在显式给值时才进请求体（缺省由引擎给 false）。
      ...(args.include_structure === undefined ? {} : { includeStructure: args.include_structure }),
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
      // AX 证据块（引擎缺省附带，与 inspect 同口径）：原样透传——桥不发明、不重算；
      // 缺键 = 该响应没给（dry/replay 合成形状或旧引擎）。
      ...(isObj(response['ax']) ? { ax: response['ax'] } : {}),
    }
  }

  private async act(state: SessionState, args: SessionToolArgs): Promise<SessionToolResult> {
    const actOp = typeof args.act_op === 'string' ? args.act_op : ''
    if (!(BRIDGE_ACT_OPS as readonly string[]).includes(actOp)) {
      throw new SessionToolError('config_error', `act needs act_op one of ${BRIDGE_ACT_OPS.join(' | ')} (got ${JSON.stringify(args.act_op)})`, {
        allowed_act_ops: [...BRIDGE_ACT_OPS],
      })
    }
    if (!nonEmpty(args.target) && actOp !== 'scroll') {
      throw new SessionToolError('config_error', `act op '${actOp}' needs a non-empty target (hint string)`)
    }
    if ((actOp === 'fill' || actOp === 'select' || actOp === 'set_range') && args.value === undefined) {
      throw new SessionToolError('config_error', `act op '${actOp}' needs a value parameter (the tool never invents values)`)
    }
    const body: Record<string, unknown> = { type: BRIDGE_OP_ENGINE_TYPE.act, op: actOp, target: args.target ?? '' }
    // A2：歧义策略只在显式给值时进请求体（缺省由引擎给 fail）；引擎/CLI 仍是唯一的语义面，
    // 桥只做形状校验 + 透传。
    if (args.on_ambiguous !== undefined) {
      const mode: unknown = args.on_ambiguous
      if (!(BRIDGE_AMBIGUITY_MODES as readonly unknown[]).includes(mode)) {
        throw new SessionToolError('config_error', `on_ambiguous must be one of ${BRIDGE_AMBIGUITY_MODES.join(' | ')} (got ${JSON.stringify(args.on_ambiguous)})`, {
          allowed_modes: [...BRIDGE_AMBIGUITY_MODES],
        })
      }
      body['onAmbiguous'] = mode
    }
    if (args.value !== undefined) body['value'] = args.value
    if (args.to !== undefined) body['to'] = args.to
    if (args.by !== undefined) body['by'] = args.by
    // B1：失败截图 opt-in（缺省不传 = 会话不碰截图；只在动作失败时落盘）。
    if (args.screenshot === true) body['screenshot'] = true
    // F72：解析落空 + 页面未静默时的有界重扫 opt-in（true 才透传；缺省不传 = 引擎关）。
    if (args.rehydrate_rescan !== undefined) {
      if (args.rehydrate_rescan !== true) {
        throw new SessionToolError('config_error', `rehydrate_rescan must be true when present (got ${JSON.stringify(args.rehydrate_rescan)})`)
      }
      body['rehydrateRescan'] = true
    }
    const response = await this.request(state, body)
    const base = { op: 'act', session_id: state.id, act_op: actOp, target: args.target ?? null }
    // task-36：歧义诊断**原样透传**（引擎有这些键才出现）——交互试错第一诉求是"为什么点错/
    // 是不是多个候选"，而 CLI 会话面已经用 B1 旁路算好了；bridge 只做有界映射，不重算、不猜。
    // 语义纪律：ambiguous 是**诊断事实**不是错误（ok:true 也回显）；缺键 = 精确形状，响应不变。
    const ambiguity = this.ambiguityDiagnostics(response)
    // B2：滚动证据（moved/delta/scroll）同样只透传、不重算——引擎给什么就回什么（成功/失败
    // 同一口径：not_scrollable 也带 moved:false 与当时的容器几何）。
    const scroll = this.scrollDiagnostics(response)
    // A3：set_range 证据（applied/accurate/strategy/requested/target_value…）只透传、不重算——
    // 越界/不可设置的 ok:false 由 engineFailure 的 code/reason 承担，绝不补成成功事实。
    // 只对 set_range 启用：其余 act op 的响应键集逐字节不变（不因引擎未来多字段而漂移）。
    const range = actOp === 'set_range' ? this.rangeDiagnostics(response) : {}
    if (response['ok'] !== true) {
      // B1：被遮挡/超时失败现场 + opt-in 失败截图路径（只在引擎给了才出现；不内联图片）。
      const actionability = this.actionabilityEvidence(response['actionability'])
      return {
        ...this.engineFailure(response, 'act'),
        ...ambiguity,
        ...scroll,
        ...range,
        ...(actionability === undefined ? {} : { actionability }),
        ...(typeof response['screenshot_file'] === 'string' ? { screenshot_file: response['screenshot_file'] } : {}),
        ...base,
      }
    }
    return {
      ok: true,
      ...base,
      executed: response['executed'] === true,
      // F72：解析通道证据透传（引擎给才有：#id 直查兜底 / rehydrate 重扫命中）。
      ...(typeof response['resolved_via'] === 'string' ? { resolved_via: response['resolved_via'] } : {}),
      ref: response['ref'] ?? null,
      how: response['how'] ?? null,
      changed: response['changed'] === true,
      url: response['url'] ?? state.url,
      ...scroll,
      ...range,
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
   * A3：`act set_range` 证据的有界透传（引擎 RangeOutcome 有才有；不重算 applied/accurate、
   * 不补字段）。越界/不可设置的失败由 `engineFailure` 的 `code`/`reason` 承担（`stopCode`
   * 不再重复回显）；数值目标落在 `target_value`——`target` 已是 hint 字符串，同名两义会误读。
   */
  private rangeDiagnostics(response: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    if (typeof response['applied'] === 'boolean') out['applied'] = response['applied']
    if (typeof response['accurate'] === 'boolean') out['accurate'] = response['accurate']
    for (const strategy of ['fill', 'keyboard', 'pointer'] as const) {
      if (response['strategy'] === strategy) out['strategy'] = strategy
    }
    for (const key of ['achieved', 'requested', 'target_value', 'clamped_from'] as const) {
      const v = response[key]
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
    }
    for (const probe of ['value_unreadable', 'home_ignored', 'lattice_unreachable'] as const) {
      if (response['probe'] === probe) out['probe'] = probe
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
      const rows = rawOthers.slice(0, BRIDGE_EVIDENCE_AMBIGUITY_CAPS.matchedOthersMax).map((raw) => {
        const o: Record<string, unknown> = isObj(raw) ? raw : {}
        return {
          ...(typeof o['ref'] === 'string' ? { ref: o['ref'] } : {}),
          ...(typeof o['tag'] === 'string' ? { tag: o['tag'] } : {}),
          ...(typeof o['class'] === 'string' ? { class: o['class'] } : {}),
          ...(typeof o['label'] === 'string' ? { label: clip(o['label'], BRIDGE_EVIDENCE_AMBIGUITY_CAPS.labelMaxChars) } : {}),
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

  /**
   * F6：act 歧义/落空时引擎宽扫回传的**有界透传**（引擎有才有；不重算、不补 hint）。
   *
   * 来源：引擎 doAct 失败路径的 `wide_scan`（target_not_found/target_ambiguous 停因专属；
   * 零动作的一次 ≤128 宽扫）——`window`/`pool_size`/`candidates[{ref,tag,label,hint?}]`。
   * 裁剪：candidates ≤40 行，**带自证 hint 的行优先**（组内保持引擎顺序——作者先看可寻址
   * 词面），每行 tag ≤16 / label ≤40 / hint ≤200（hint 引擎已自证，桥不重算、不发明）；
   * 完整口径由 `pool_size` 如实表达。其它停因引擎不带该键 ⇒ 缺键 = 响应形状不变。
   */
  private wideScanEvidence(raw: unknown): Record<string, unknown> | undefined {
    if (!isObj(raw)) return undefined
    const rawRows = raw['candidates']
    if (!Array.isArray(rawRows)) return undefined
    const rows = rawRows.filter((r): r is Record<string, unknown> => isObj(r))
    const hasHint = (r: Record<string, unknown>): boolean => typeof r['hint'] === 'string' && r['hint'] !== ''
    const picked = [...rows.filter(hasHint), ...rows.filter((r) => !hasHint(r))].slice(0, BRIDGE_EVIDENCE_WIDE_CAPS.candidatesMax)
    const out: Record<string, unknown> = {
      candidates: picked.map((r) => ({
        ...(typeof r['ref'] === 'string' ? { ref: r['ref'] } : {}),
        ...(typeof r['tag'] === 'string' ? { tag: clip(r['tag'], BRIDGE_EVIDENCE_WIDE_CAPS.tagMaxChars) } : {}),
        ...(typeof r['label'] === 'string' ? { label: clip(r['label'], BRIDGE_EVIDENCE_WIDE_CAPS.labelMaxChars) } : {}),
        ...(hasHint(r) ? { hint: clip(String(r['hint']), BRIDGE_EVIDENCE_WIDE_CAPS.hintMaxChars) } : {}),
      })),
    }
    if (typeof raw['window'] === 'number') out['window'] = raw['window']
    if (typeof raw['pool_size'] === 'number') out['pool_size'] = raw['pool_size']
    return out
  }

  /**
   * §15：快照响应 `window` 审计块（windowAudit）的**有界透传**（引擎有才有；不重算、不补键）。
   *
   * 来源：引擎 doSnapshot 的 additive `window`（一次只读 evaluate：池外可见交互 + 被剔账）。
   * 裁剪：out_of_window ≤10 行、dedup_dropped ≤40 行（引擎已各自限界，桥按同值复核）；
   * 每行 tag ≤16 / label ≤40 / why ≤32，prio/bucket 原样（有界枚举值）；surface_counts 只收
   * 有限数。缺键 = 引擎没提供（旧快照响应形状不变）。
   */
  private windowAuditEvidence(raw: unknown): Record<string, unknown> | undefined {
    if (!isObj(raw)) return undefined
    const out: Record<string, unknown> = {}
    if (typeof raw['visible_interactive'] === 'number') out['visible_interactive'] = raw['visible_interactive']
    if (typeof raw['shown'] === 'number') out['shown'] = raw['shown']
    if (typeof raw['out_of_window_total'] === 'number') out['out_of_window_total'] = raw['out_of_window_total']
    const rows = (key: string, cap: number, clipWhy: boolean): Array<Record<string, unknown>> | undefined => {
      const list = raw[key]
      if (!Array.isArray(list)) return undefined
      const mapped = list.slice(0, cap).map((rawRow) => {
        const r = isObj(rawRow) ? rawRow : {}
        const row: Record<string, unknown> = {}
        if (typeof r['tag'] === 'string') row['tag'] = clip(r['tag'], 16)
        if (typeof r['label'] === 'string') row['label'] = clip(r['label'], 40)
        if (typeof r['prio'] === 'number') row['prio'] = r['prio']
        if (typeof r['bucket'] === 'string') row['bucket'] = clip(r['bucket'], 16)
        if (clipWhy && typeof r['why'] === 'string') row['why'] = clip(r['why'], 32)
        return row
      })
      return mapped.length > 0 ? mapped : undefined
    }
    const oow = rows('out_of_window', 10, false)
    if (oow !== undefined) out['out_of_window'] = oow
    const drops = rows('dedup_dropped', 40, true)
    if (drops !== undefined) out['dedup_dropped'] = drops
    const countsRaw = raw['surface_counts']
    if (isObj(countsRaw)) {
      const counts: Record<string, number> = {}
      for (const [k, v] of Object.entries(countsRaw)) {
        if (typeof v === 'number' && Number.isFinite(v)) counts[k] = v
      }
      if (Object.keys(counts).length > 0) out['surface_counts'] = counts
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  private async read(state: SessionState, args: SessionToolArgs): Promise<SessionToolResult> {
    const what = typeof args.what === 'string' ? args.what : ''
    if (!(BRIDGE_READ_WHATS as readonly string[]).includes(what)) {
      throw new SessionToolError('config_error', `read needs what one of ${BRIDGE_READ_WHATS.join(' | ')} (got ${JSON.stringify(args.what)})`)
    }
    if (!nonEmpty(args.selector)) throw new SessionToolError('config_error', 'read needs a selector')
    const body: Record<string, unknown> = { type: BRIDGE_OP_ENGINE_TYPE.read, what, selector: args.selector }
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
    // F89：wait_settled 请求级口径（true = 冗余兼容 / false = 跳过双指标门 opt-out；
    // 缺省 = 缺省门运行）。非法值 = config_error，不静默取缺省。
    if (args.wait_settled !== undefined && typeof args.wait_settled !== 'boolean') {
      throw new SessionToolError('config_error', `extract wait_settled must be a boolean (got ${JSON.stringify(args.wait_settled)})`)
    }
    const rows = args.rows
    const fields = args.fields
    const response = await this.request(state, {
      type: BRIDGE_OP_ENGINE_TYPE.extract, rows, fields, maxItems,
      ...(offset > 0 ? { offset } : {}),
      ...(args.wait_settled === undefined ? {} : { waitSettled: args.wait_settled }),
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
      // F89：稳定读证据（引擎有才有——缺省路径恒带 settled；opt-out/settle-off 缺键）。
      // blank_rows 恒带（引擎侧本就恒带，此前被本投影丢弃——F6 教训：不透传=白做）。
      ...(typeof response['blank_rows'] === 'number' ? { blank_rows: response['blank_rows'] } : {}),
      ...(typeof response['settled'] === 'boolean' ? { settled: response['settled'] } : {}),
      ...(typeof response['scroll_settled'] === 'boolean' ? { scroll_settled: response['scroll_settled'] } : {}),
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
        type: BRIDGE_OP_ENGINE_TYPE.extract, rows: req.rows, fields: req.fields, maxItems: SAVE_PAGE,
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
    const response = await this.request(state, { type: BRIDGE_OP_ENGINE_TYPE.signal, signal: args.signal })
    if (response['ok'] !== true) return this.engineFailure(response, 'signal')
    return { ok: true, op: 'signal', session_id: state.id, held: response['held'] === true }
  }

  private async waitFor(state: SessionState, args: SessionToolArgs): Promise<SessionToolResult> {
    if (!isObj(args.signal)) throw new SessionToolError('config_error', 'wait_for needs a signal object')
    const timeoutMs = Math.max(BRIDGE_SESSION_TIMEOUTS.waitMinMs, Math.min(BRIDGE_SESSION_TIMEOUTS.waitMaxMs,
      Math.floor(args.timeout_ms ?? BRIDGE_SESSION_TIMEOUTS.waitDefaultMs)))
    const response = await this.request(
      state,
      { type: BRIDGE_OP_ENGINE_TYPE.wait_for, signal: args.signal, timeoutMs },
      Math.max(this.options.opTimeoutMs, timeoutMs + BRIDGE_SESSION_TIMEOUTS.waitDefaultMs),
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
      type: BRIDGE_OP_ENGINE_TYPE.snapshot,
      // 设计 Q4：桥缺省不截图（模型面只看路径）；显式 screenshot:true 才截。
      screenshot: args.screenshot === true,
    }, Math.max(this.options.opTimeoutMs, 90_000))
    if (response['ok'] !== true) return this.engineFailure(response, 'snapshot')
    // §15：windowAudit 证据（引擎有才有——doSnapshot additive；缺键 = 旧快照响应形状不变）。
    const window = this.windowAuditEvidence(response['window'])
    return {
      ok: true,
      op: 'snapshot',
      session_id: state.id,
      url: response['url'],
      title: response['title'],
      snapshot_file: response['snapshot_file'],
      pool_file: response['pool_file'],
      ...(response['screenshot_file'] === undefined ? {} : { screenshot_file: response['screenshot_file'] }),
      ...(window === undefined ? {} : { window }),
      counts: response['counts'],
    }
  }

  /**
   * F76/P3：tab op——`tab_action:"list"`（缺省）免费只读枚举标签页；`"switch"` 显式切到恰好一个
   * 匹配的标签页。桥只做**形状校验**（isObj + 字段类型 + 键闭集，非法 = config_error 报闭集），
   * 匹配语义/信封判定/文案全部在引擎 `amber session`（ctx-validate 纯函数层同一份）；结果
   * 透传引擎响应（tabs/active/switched），桥不重算、不补键。switch 刷新 idle TTL（与其它 op
   * 同一记活语义——request() 统一更新 lastActivity），list 免费。
   */
  private async tab(state: SessionState, args: SessionToolArgs): Promise<SessionToolResult> {
    const action = args.tab_action === undefined ? 'list' : args.tab_action
    if (!(BRIDGE_TAB_ACTIONS as readonly string[]).includes(action)) {
      throw new SessionToolError('config_error', `tab_action must be one of ${BRIDGE_TAB_ACTIONS.join(' | ')} (got ${JSON.stringify(args.tab_action)})`, {
        allowed_actions: [...BRIDGE_TAB_ACTIONS],
      })
    }
    const body: Record<string, unknown> = { type: BRIDGE_OP_ENGINE_TYPE.tab }
    if (args.tab_action !== undefined) body['action'] = action
    if (args.match !== undefined) {
      const m: unknown = args.match
      if (!isObj(m)) {
        throw new SessionToolError('config_error', `tab match must be an object like {index} | {urlContains} | {titleContains} (got ${JSON.stringify(m)})`)
      }
      const unknown = Object.keys(m).filter(k => k !== 'index' && k !== 'urlContains' && k !== 'titleContains')
      if (unknown.length > 0) {
        throw new SessionToolError('config_error', `tab match has unknown key(s) ${unknown.map(k => JSON.stringify(k)).join(', ')} (allowed: index, urlContains, titleContains)`)
      }
      const index = m['index']
      if (index !== undefined && (typeof index !== 'number' || !Number.isInteger(index) || index < 0)) {
        throw new SessionToolError('config_error', `tab match.index must be a 0-based integer (got ${JSON.stringify(index)})`)
      }
      for (const k of ['urlContains', 'titleContains'] as const) {
        const v = m[k]
        if (v !== undefined && (typeof v !== 'string' || v.trim() === '')) {
          throw new SessionToolError('config_error', `tab match.${k} must be a non-empty string (got ${JSON.stringify(v)})`)
        }
      }
      body['match'] = m
    }
    const response = await this.request(state, body)
    if (response['ok'] !== true) return this.engineFailure(response, 'tab')
    const switched = isObj(response['switched']) ? response['switched'] : undefined
    // 换页成功后同步桥侧记账（list 行的 url 与 act 失败回退的 state.url 保持真实）。
    if (action === 'switch' && switched !== undefined && typeof switched['url'] === 'string' && switched['url'] !== '') {
      state.url = switched['url']
      if (typeof switched['title'] === 'string') state.title = switched['title']
    }
    return {
      ok: true,
      op: 'tab',
      session_id: state.id,
      action,
      ...(Array.isArray(response['tabs']) ? { tabs: response['tabs'] } : {}),
      ...(typeof response['active'] === 'number' ? { active: response['active'] } : {}),
      ...(switched !== undefined ? { switched } : {}),
    }
  }

  /* ------------------------------------------------------------ drive（pilot 驾驶，与 session 共用同一 page） */

  /**
   * drive：在**当前会话页**上开始/继续模型驱动走查（pilot face，产物 pilot:true/attached:true）。
   *
   * 与 session 的 act/observe 共用同一 browser/page（不新开浏览器、不重新导航）；停在交接处返回，
   * Agent 可先用 act/observe 人工补一步，再 drive_command 继续——"切换互证"的入口。缺省不创建
   * 任何进程/浏览器（会话已由 open 建好）；不新增工具、不新增 CLI 命令。
   */
  private async driveOp(state: SessionState, args: SessionToolArgs): Promise<SessionToolResult> {
    if (!nonEmpty(args.goal)) {
      throw new SessionToolError('config_error', 'drive needs a non-empty goal (one line describing the step)')
    }
    const body: Record<string, unknown> = { type: BRIDGE_OP_ENGINE_TYPE.drive, goal: args.goal.trim() }
    if (args.max_steps !== undefined) {
      if (typeof args.max_steps !== 'number' || !Number.isInteger(args.max_steps)
        || args.max_steps < BRIDGE_DRIVE_LIMITS.maxStepsMin || args.max_steps > BRIDGE_DRIVE_LIMITS.maxStepsMax) {
        throw new SessionToolError('config_error',
          `max_steps must be an integer ${BRIDGE_DRIVE_LIMITS.maxStepsMin}..${BRIDGE_DRIVE_LIMITS.maxStepsMax} (got ${JSON.stringify(args.max_steps)})`)
      }
      body['max_steps'] = args.max_steps
    }
    if (args.final_signal !== undefined) {
      if (!isObj(args.final_signal)) {
        throw new SessionToolError('config_error', `final_signal must be a JSON object (got ${JSON.stringify(args.final_signal)})`)
      }
      body['final_signal'] = args.final_signal
    }
    if (args.conf_floor !== undefined) {
      if (typeof args.conf_floor !== 'number' || !Number.isFinite(args.conf_floor)
        || args.conf_floor < BRIDGE_DRIVE_LIMITS.confFloorMin || args.conf_floor > BRIDGE_DRIVE_LIMITS.confFloorMax) {
        throw new SessionToolError('config_error',
          `conf_floor must be a number in [${BRIDGE_DRIVE_LIMITS.confFloorMin},${BRIDGE_DRIVE_LIMITS.confFloorMax}] (got ${JSON.stringify(args.conf_floor)})`)
      }
      body['conf_floor'] = args.conf_floor
    }
    if (args.expect_url !== undefined) {
      if (!nonEmpty(args.expect_url)) {
        throw new SessionToolError('config_error', 'expect_url must be a non-empty string when present')
      }
      body['expect_url'] = args.expect_url
    }
    if (args.driver !== undefined) {
      if (!(BRIDGE_DRIVE_DRIVERS as readonly string[]).includes(args.driver)) {
        throw new SessionToolError('config_error', `driver must be one of ${BRIDGE_DRIVE_DRIVERS.join(' | ')} (got ${JSON.stringify(args.driver)})`, {
          allowed_drivers: [...BRIDGE_DRIVE_DRIVERS],
        })
      }
      body['driver'] = args.driver
    }
    if (args.slots !== undefined) {
      const slots: unknown = args.slots
      if (!isObj(slots) || Object.values(slots).some((v) => typeof v !== 'string')) {
        throw new SessionToolError('config_error', 'slots must be an object of string values (the bridge never invents values)')
      }
      body['slots'] = slots
    }
    const response = await this.request(state, body)
    return this.driveResult(state, 'drive', response)
  }

  /** drive_command：把兜底指令（resume/redirect/finish/abort 闭集）交给驾驶面；drive 时继续一轮。 */
  private async driveCommandOp(state: SessionState, args: SessionToolArgs): Promise<SessionToolResult> {
    const cmd = args.cmd
    if (cmd === undefined || !(BRIDGE_DRIVE_COMMANDS as readonly string[]).includes(cmd)) {
      throw new SessionToolError('config_error', `cmd must be one of ${BRIDGE_DRIVE_COMMANDS.join(' | ')} (got ${JSON.stringify(args.cmd)})`, {
        allowed_cmds: [...BRIDGE_DRIVE_COMMANDS],
      })
    }
    const body: Record<string, unknown> = { type: BRIDGE_OP_ENGINE_TYPE.drive_command, cmd }
    if (args.hint !== undefined) {
      if (!nonEmpty(args.hint)) throw new SessionToolError('config_error', 'hint must be a non-empty string when present')
      body['hint'] = args.hint
    }
    if (args.value !== undefined) body['value'] = args.value
    // resume 字符串值 + target = 显式值袋键（AGENT_INTERFACE 文档承诺的"键取 target"，
    // 此前桥静默丢弃；对象值不需要它）。
    if (args.target !== undefined) {
      if (!nonEmpty(args.target)) throw new SessionToolError('config_error', 'target must be a non-empty string when present')
      body['target'] = args.target
    }
    if (args.goal !== undefined) {
      if (!nonEmpty(args.goal)) throw new SessionToolError('config_error', 'goal must be a non-empty string when present')
      body['goal'] = args.goal
    }
    if (args.url !== undefined) {
      if (!nonEmpty(args.url)) throw new SessionToolError('config_error', 'url must be a non-empty string when present')
      body['url'] = args.url
    }
    if (args.note !== undefined) {
      if (!nonEmpty(args.note)) throw new SessionToolError('config_error', 'note must be a non-empty string when present')
      body['note'] = args.note
    }
    if (args.skip !== undefined) {
      if (typeof args.skip !== 'boolean') throw new SessionToolError('config_error', 'skip must be a boolean when present')
      body['skip'] = args.skip
    }
    const response = await this.request(state, body)
    return this.driveResult(state, 'drive_command', response)
  }

  /** drive_status：只读回显（url/步数/咨询数/未决交接/证据目录；不推进驾驶）。 */
  private async driveStatusOp(state: SessionState): Promise<SessionToolResult> {
    const response = await this.request(state, { type: BRIDGE_OP_ENGINE_TYPE.drive_status })
    return this.driveResult(state, 'drive_status', response)
  }

  /** drive_close：收尾驾驶面（宿主浏览器归 session 所有，不在这里关闭）。 */
  private async driveCloseOp(state: SessionState): Promise<SessionToolResult> {
    const response = await this.request(state, { type: BRIDGE_OP_ENGINE_TYPE.drive_close })
    return this.driveResult(state, 'drive_close', response)
  }

  /**
   * 驾驶结果有界投影：白名单字段（status/stop_code/url/steps/model_asks/out_dir/attached +
   * 有界 handoff/events）；**不回**池/候选/槽值/完整 DOM。引擎 ok:false 走既有 engineFailure
   * （失败形状与其它会话 op 同源，session 继续存活）。
   */
  private driveResult(state: SessionState, op: string, response: Record<string, unknown>): SessionToolResult {
    const ok = response['ok'] === true
    const out: SessionToolResult = ok
      ? { ok: true, op, session_id: state.id }
      : { ...this.engineFailure(response, op), op, session_id: state.id }
    // 桥层兜底：引擎失败回执的顶层 reason 为空时回落到单行回执（command.reason）——
    // 渲染只读顶层 reason，嵌套 reason 到不了调用方。
    if (out['ok'] === false && out['reason'] === '' && isObj(response['command'])
      && typeof response['command']['reason'] === 'string' && response['command']['reason'] !== '') {
      out['reason'] = clip(response['command']['reason'], 1000)
    }
    // 驾驶面白名单（t7 契约：pilot/attached/status/.../terminal/active/closed/cmd/outcome）。
    for (const key of ['status', 'stop_code', 'steps', 'model_asks', 'out_dir', 'cmd', 'outcome'] as const) {
      const v = response[key]
      if (typeof v === 'string' || typeof v === 'number') out[key] = v
    }
    for (const key of ['pilot', 'attached', 'terminal', 'active', 'closed', 'reused', 'goal_ignored'] as const) {
      if (response[key] === true || response[key] === false) out[key] = response[key]
    }
    // 未决交接时的显式 next（≤3 条：继续本 run 的 drive_command / 起新 session）。
    if (Array.isArray(response['next'])) {
      const next = response['next'].filter((x): x is string => typeof x === 'string').slice(0, 3).map((s) => clip(s, 300))
      if (next.length > 0) out['next'] = next
    }
    if (typeof response['url'] === 'string' && response['url'] !== '') {
      out['url'] = response['url']
      state.url = response['url']   // 驾驶换页后桥侧记账（list/失败回退）保持真实
    }
    const handoff = this.driveHandoff(response['handoff'] ?? response['handoff_open'])
    if (handoff !== undefined) out['handoff'] = handoff
    const command = this.driveCommandSummary(response['command'])
    if (command !== undefined) out['command'] = command
    const summary = this.driveSummary(response['summary'])
    if (summary !== undefined) out['summary'] = summary
    const events = this.driveEvents(response['events'])
    if (events !== undefined) out['events'] = events
    return out
  }

  /** 交接块有界投影（step_id/stop_code/goal_digest/summary/url/≤3 条解锁建议/证据路径 + 结束态可见性）。 */
  private driveHandoff(raw: unknown): Record<string, unknown> | undefined {
    if (!isObj(raw)) return undefined
    const out: Record<string, unknown> = {}
    if (typeof raw['step_id'] === 'number') out['step_id'] = raw['step_id']
    if (typeof raw['stop_code'] === 'string') out['stop_code'] = raw['stop_code']
    if (typeof raw['goal_digest'] === 'string') out['goal_digest'] = clip(raw['goal_digest'], BRIDGE_HANDOFF_CAPS.goalDigestMaxChars)
    if (typeof raw['url'] === 'string') out['url'] = clip(raw['url'], BRIDGE_HANDOFF_CAPS.urlMaxChars)
    // 结束态可见性（evidence-only）：无完成信号声明 = 显式 null；无低置信票 = 键不出现。
    if (raw['final_signal'] === null) out['final_signal'] = null
    else if (typeof raw['final_signal'] === 'string') out['final_signal'] = clip(raw['final_signal'], BRIDGE_HANDOFF_CAPS.finalSignalMaxChars)
    if (Array.isArray(raw['weak_picks'])) {
      const picks = raw['weak_picks'].filter(isObj).slice(0, BRIDGE_HANDOFF_CAPS.weakPicksMax).map((p) => {
        const row: Record<string, unknown> = {}
        if (typeof p['step'] === 'number') row['step'] = p['step']
        if (typeof p['target'] === 'string') row['target'] = clip(p['target'], BRIDGE_HANDOFF_CAPS.weakPickTargetMaxChars)
        if (typeof p['conf'] === 'number') row['conf'] = p['conf']
        if (typeof p['picked_by'] === 'string') row['picked_by'] = clip(p['picked_by'], BRIDGE_HANDOFF_CAPS.weakPickPickedByMaxChars)
        return row
      })
      if (picks.length > 0) out['weak_picks'] = picks
    }
    const why = isObj(raw['why_stuck']) ? raw['why_stuck'] : undefined
    if (why !== undefined && typeof why['summary'] === 'string') out['summary'] = clip(why['summary'], BRIDGE_HANDOFF_CAPS.summaryMaxChars)
    if (Array.isArray(raw['what_would_unblock'])) {
      out['what_would_unblock'] = raw['what_would_unblock']
        .filter((x): x is string => typeof x === 'string')
        .slice(0, BRIDGE_HANDOFF_CAPS.unblockMaxItems)
        .map((s) => clip(s, BRIDGE_HANDOFF_CAPS.unblockItemMaxChars))
    }
    if (isObj(raw['evidence_refs'])) {
      const refs: Record<string, unknown> = {}
      for (const k of ['screenshot', 'dom', 'pool_snapshot', 'observe'] as const) {
        if (typeof raw['evidence_refs'][k] === 'string') refs[k] = raw['evidence_refs'][k]
      }
      if (Object.keys(refs).length > 0) out['evidence_refs'] = refs
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  /** drive_command 的单行回执（command_result/error）有界投影：ok/code/reason + 少量事实键。 */
  private driveCommandSummary(raw: unknown): Record<string, unknown> | undefined {
    if (!isObj(raw)) return undefined
    const out: Record<string, unknown> = {}
    if (raw['ok'] === true || raw['ok'] === false) out['ok'] = raw['ok']
    if (typeof raw['code'] === 'string') out['code'] = clip(raw['code'], 60)
    if (typeof raw['reason'] === 'string') out['reason'] = clip(raw['reason'], 300)
    for (const k of ['resumed', 'skipped', 'closed'] as const) {
      if (raw[k] === true || raw[k] === false) out[k] = raw[k]
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  /** driveClose 的 pilot_end 摘要（有界白名单；不回落盘路径以外的敏感键）。 */
  private driveSummary(raw: unknown): Record<string, unknown> | undefined {
    if (!isObj(raw)) return undefined
    const out: Record<string, unknown> = {}
    for (const k of ['ok', 'pilot', 'attached', 'driver', 'stop_code', 'aborted'] as const) {
      const v = raw[k]
      if (v === true || v === false || typeof v === 'string') out[k] = typeof v === 'string' ? clip(v, 60) : v
    }
    for (const k of ['steps', 'max_steps', 'conf_floor', 'model_asks', 'rule_picks', 'model_picks', 'handoffs', 'fallbacks'] as const) {
      if (typeof raw[k] === 'number') out[k] = raw[k]
    }
    for (const k of ['url', 'out_dir'] as const) {
      if (typeof raw[k] === 'string') out[k] = clip(raw[k], 300)
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  /** 驾驶事件有界投影（≤20 条；每字段 clip；不回池/候选/DOM）。 */
  private driveEvents(raw: unknown): Array<Record<string, unknown>> | undefined {
    if (!Array.isArray(raw)) return undefined
    return raw.slice(0, 20).map((entry) => {
      const e = isObj(entry) ? entry : {}
      const out: Record<string, unknown> = {}
      if (typeof e['type'] === 'string') out['type'] = clip(e['type'], 40)
      if (typeof e['step'] === 'number') out['step'] = e['step']
      if (typeof e['stop_code'] === 'string') out['stop_code'] = clip(e['stop_code'], 40)
      if (typeof e['op'] === 'string') out['op'] = clip(e['op'], 20)
      if (typeof e['target'] === 'string') out['target'] = clip(e['target'], 120)
      if (e['ok'] === true || e['ok'] === false) out['ok'] = e['ok']
      if (e['changed'] === true || e['changed'] === false) out['changed'] = e['changed']
      if (typeof e['url'] === 'string') out['url'] = clip(e['url'], 300)
      if (typeof e['conf'] === 'number') out['conf'] = e['conf']
      return out
    })
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
    // F6：歧义/落空的宽扫回传（引擎有才有——只在这两个停因出现；其它 op/停因缺键形状不变）。
    const wide = this.wideScanEvidence(response['wide_scan'])
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
      ...(wide === undefined ? {} : { wide_scan: wide }),
    }
  }

  /**
   * A4：落空判别证据的**有界透传**（引擎有才有；不重算、不补键、不改语义）。
   *
   * 上限：`candidates` ≤3、`near` ≤3、`rejected` ≤2 行；每行 `ref`/`tag` ≤16、`label`/`why`
   * ≤40；`hint_shape` ≤32。缺键 = 引擎没提供，桥不发明（与 `ambiguityEvidence` 同一纪律）。
   * F72：`settle_timed_out`/`settle_waited_ms`（渲染可疑信号）与 `rescan.{waited_ms,pool_size}`
   * （显式重扫未命中事实）同样只透传、不改语义。
   */
  private missDiagnosticsEvidence(raw: unknown): Record<string, unknown> | undefined {
    if (!isObj(raw)) return undefined
    const out: Record<string, unknown> = {}
    if (typeof raw['target'] === 'string') out['target'] = raw['target']
    if (typeof raw['pool_size'] === 'number') out['pool_size'] = raw['pool_size']
    if (typeof raw['hint_shape'] === 'string') out['hint_shape'] = clip(raw['hint_shape'], BRIDGE_EVIDENCE_MISS_CAPS.hintShapeMaxChars)
    if (typeof raw['hint_len'] === 'number') out['hint_len'] = raw['hint_len']
    // F72：渲染可疑信号与显式重扫事实（引擎给才有；只透传）。
    if (raw['settle_timed_out'] === true) out['settle_timed_out'] = true
    if (typeof raw['settle_waited_ms'] === 'number') out['settle_waited_ms'] = raw['settle_waited_ms']
    if (isObj(raw['rescan'])) {
      const rs: Record<string, unknown> = {}
      if (typeof raw['rescan']['waited_ms'] === 'number') rs['waited_ms'] = raw['rescan']['waited_ms']
      if (typeof raw['rescan']['pool_size'] === 'number') rs['pool_size'] = raw['rescan']['pool_size']
      if (Object.keys(rs).length > 0) out['rescan'] = rs
    }
    const rows = (key: string, cap: number): Array<Record<string, unknown>> | undefined => {
      const list = raw[key]
      if (!Array.isArray(list)) return undefined
      return list.slice(0, cap).map((entry) => {
        const row = isObj(entry) ? entry : {}
        const projected: Record<string, unknown> = {}
        if (typeof row['ref'] === 'string') projected['ref'] = clip(row['ref'], BRIDGE_EVIDENCE_MISS_CAPS.refMaxChars)
        if (typeof row['tag'] === 'string') projected['tag'] = clip(row['tag'], BRIDGE_EVIDENCE_MISS_CAPS.tagMaxChars)
        if (typeof row['label'] === 'string') projected['label'] = clip(row['label'], BRIDGE_EVIDENCE_MISS_CAPS.labelMaxChars)
        if (typeof row['why'] === 'string') projected['why'] = clip(row['why'], BRIDGE_EVIDENCE_MISS_CAPS.whyMaxChars)
        return projected
      })
    }
    const candidates = rows('candidates', BRIDGE_EVIDENCE_MISS_CAPS.candidatesMax)
    if (candidates !== undefined) out['candidates'] = candidates
    const near = rows('near', BRIDGE_EVIDENCE_MISS_CAPS.nearMax)
    if (near !== undefined) out['near'] = near
    const rejected = rows('rejected', BRIDGE_EVIDENCE_MISS_CAPS.rejectedMax)
    if (rejected !== undefined) out['rejected'] = rejected
    return Object.keys(out).length > 0 ? out : undefined
  }

  /**
   * A2：`ambiguity` 证据的**有界透传**（引擎有才有；不重算、不补键、不改语义）。
   *
   * 上限与引擎侧同一张表：候选 ≤5 行、ref/tag/role ≤16、label/class/near ≤40、
   * suggested_hint ≤200（B 批：可容 4 段 `frame:` 链；与引擎 AMBIGUITY_HINT_MAX /
   * ElementView HINT_MAX_CHARS 同口径）、target ≤120；候选 additive `frame_origin`
   * 与 ElementView 的短标识同口径（≤60）。缺键 = 引擎没提供，桥不发明。
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
        // B 批：候选帧 origin（引擎有才出现；跨帧同名时区分是哪一帧）。
        if (typeof row['frame_origin'] === 'string') {
          // 桥面带窄于引擎界（120 → 60）：对齐引擎属可见变化，需单独成批（见契约表字段注释）。
          projected['frame_origin'] = clip(row['frame_origin'], BRIDGE_EVIDENCE_AMBIGUITY_CAPS.frameOriginMaxChars)
        }
        if (typeof row['same_label'] === 'boolean') projected['same_label'] = row['same_label']
        if (typeof row['suggested_hint'] === 'string') projected['suggested_hint'] = clip(row['suggested_hint'], 200)
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
        summary = await this.request(state, { type: BRIDGE_OP_ENGINE_TYPE.close }, 10_000)
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
