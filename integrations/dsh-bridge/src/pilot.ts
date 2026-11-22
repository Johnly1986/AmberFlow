/**
 * `amberflow_pilot` 的桥侧服务（PILOTED_WALKTHROUGH §PW3.2）：**one-shot 驾驶调用**。
 *
 * 桥契约三件事不变——拼 CLI（`pilotArgs`）、收 envelope（引擎 stdout 的 JSONL 协议流）、
 * 投影有界摘要。业务语义全部留在引擎 CLI：停因闭集、兜底指令闭集、信号验证、危险
 * default-deny 都不在桥里复制；`commands`（兜底剧本）逐行原样物化成临时文件走 `--input`。
 *
 * 与 `amberflow_run` 的墙钟纪律同源：`timeout_sec` 只改桥侧 spawn 超时，超时杀进程并写
 * `pilot-killed.json` 部分证据（已完成步骤只活在输出尾部里）。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  fillArgMessage, pilotArgs, pruneRunDirs, runProcess, type BridgeOptions, type JsonObject, type ProcessOutcome,
} from './bridge.ts'
import { newOutDir } from './service.ts'
import { RUN_BRIDGE_MESSAGES, RUN_TIMEOUT_MAX_SEC, type BridgePilotArgs } from './run-contract.generated.ts'

/** 兜底剧本的行数上限（防题面级滥用；指令语义由引擎闭集校验）。 */
const PILOT_COMMANDS_MAX_LINES = 200
/** 事件行的投影上限（超出的 drive/command_result/step_request 计入 events_truncated）。 */
const PILOT_EVENTS_MAX = 60
/** 交接块投影上限（每块 why_stuck/unblock 有界；再多只留计数）。 */
const PILOT_HANDOFFS_MAX = 4

/** One `…_pilot` call: the bounded projection of the engine's JSONL protocol stream. */
export interface AmberFlowPilotSummary {
  status: 'held' | 'stopped' | 'browser_dead' | 'killed' | 'config_error'
  ok: boolean
  stop_code: string | null
  steps: number
  model_asks: number | null
  rule_picks: number | null
  model_picks: number | null
  handoffs: number | null
  fallbacks: number | null
  driver?: 'agent'
  failed_asks?: number
  cache?: { hits: number; misses: number }
  url?: string
  out_dir: string
  timed_out: boolean
  exit_code: number | null
  events: JsonObject[]
  handoffs_detail?: JsonObject[]
  events_truncated?: number
  notes?: string[]
  end_code?: string
  stdout_tail: string
}

/** The model-facing pilot call arguments: contract fields + the hand-written playbook/timeout. */
export interface AmberFlowPilotArgs extends BridgePilotArgs {
  /** Fallback playbook as JSONL text, one command object per line; the bridge materializes it to `--input`. */
  commands?: string
}

/** Test seams: the fake-engine harness replaces argv assembly and/or the process run. */
export interface PilotRunDeps {
  buildArgv?: typeof pilotArgs
  run?: typeof runProcess
}

function clip(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** 引擎 JSON 行里的未知值 → JsonValue 标量（白名单投影：只收 string/number/boolean，其余 null）。 */
function scalar(value: unknown): string | number | boolean | null {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null
}

/**
 * Project the engine's JSONL protocol stream into one bounded summary. Each line kind is whitelisted
 * and clipped: a dropped engine key is a dropped bridge key (缺键 = 旧形状不变)，and lines past the
 * caps are counted (`events_truncated`), never silently discarded.
 */
function projectPilotOutcome(outDir: string, outcome: ProcessOutcome): AmberFlowPilotSummary {
  const events: JsonObject[] = []
  const handoffNotes: JsonObject[] = []
  const notes: string[] = []
  let end: Record<string, unknown> | null = null
  let eventsDropped = 0
  for (const line of (outcome.stdoutFull ?? outcome.stdout).split('\n')) {
    const text = line.trim()
    if (text === '') continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(text) as Record<string, unknown>
    } catch {
      continue
    }
    const type = String(obj['type'] ?? '')
    if (type === 'pilot_end') {
      end = obj
      continue
    }
    if (type === 'log' || type === 'error') {
      if (notes.length < 8) notes.push(clip(obj['line'] ?? obj['reason'], 160))
      continue
    }
    if (type === 'handoff') {
      if (handoffNotes.length >= PILOT_HANDOFFS_MAX) continue
      const h = (obj['handoff'] ?? {}) as Record<string, unknown>
      const why = (h['why_stuck'] ?? {}) as Record<string, unknown>
      const whyEv = (why['evidence'] ?? {}) as Record<string, unknown>
      const refs = (h['evidence_refs'] ?? {}) as Record<string, unknown>
      handoffNotes.push({
        stop_code: scalar(h['stop_code']),
        step_id: scalar(h['step_id']),
        url: clip(h['url'], 200),
        summary: clip(why['summary'], 200),
        unblock: Array.isArray(h['what_would_unblock'])
          ? (h['what_would_unblock'] as unknown[]).slice(0, 3).map((w) => clip(w, 120))
          : [],
        evidence: {
          ...(refs['screenshot'] === undefined ? {} : { screenshot: clip(refs['screenshot'], 300) }),
          ...(refs['dom'] === undefined ? {} : { dom: clip(refs['dom'], 300) }),
          ...(refs['pool_snapshot'] === undefined ? {} : { pool_snapshot: clip(refs['pool_snapshot'], 300) }),
          ...(refs['observe'] === undefined ? {} : { observe: clip(refs['observe'], 300) }),
          ...(Array.isArray(whyEv['frames_excluded'])
            ? {
                frames_excluded: (whyEv['frames_excluded'] as Array<Record<string, unknown>>).slice(0, 6).map((f) => ({
                  origin: clip(f['origin'], 200), index: scalar(f['index']),
                })),
              }
            : {}),
          ...(whyEv['expect_url'] === undefined ? {} : { expect_url: clip(whyEv['expect_url'], 200) }),
        },
      })
      continue
    }
    if (events.length >= PILOT_EVENTS_MAX) {
      eventsDropped += 1
      continue
    }
    if (type === 'started') {
      events.push({
        started: true, url: clip(obj['url'], 200),
        ...(Array.isArray(obj['frames_excluded'])
          ? {
              frames_excluded: (obj['frames_excluded'] as Array<Record<string, unknown>>).slice(0, 6).map((f) => ({
                origin: clip(f['origin'], 200), index: scalar(f['index']),
              })),
            }
          : {}),
        ...(obj['expect_url'] === undefined ? {} : { expect_url: clip(obj['expect_url'], 200) }),
      })
      continue
    }
    if (type === 'drive') {
      events.push({
        drive: true, step: scalar(obj['step']), picked_by: scalar(obj['picked_by']), op: scalar(obj['op']),
        target: clip(obj['target'], 60), ok: obj['ok'] === true, changed: obj['changed'] === true,
        url: clip(obj['url'], 200),
        ...(obj['conf'] === undefined ? {} : { conf: scalar(obj['conf']) }),
        ...(obj['via'] === undefined ? {} : { via: scalar(obj['via']) }),
      })
      continue
    }
    if (type === 'command_result') {
      events.push({
        command_result: true, ok: obj['ok'] === true,
        ...(obj['code'] === undefined ? {} : { code: scalar(obj['code']) }),
        ...(obj['resumed'] === undefined ? {} : { resumed: scalar(obj['resumed']) }),
        ...(obj['finished'] === undefined ? {} : { finished: scalar(obj['finished']) }),
        ...(obj['aborted'] === undefined ? {} : { aborted: scalar(obj['aborted']) }),
        ...(obj['skipped'] === undefined ? {} : { skipped: clip(obj['skipped'], 40) }),
      })
      continue
    }
    if (type === 'step_request') {
      const cands = Array.isArray(obj['candidates']) ? (obj['candidates'] as Array<Record<string, unknown>>) : []
      events.push({
        step_request: true, step: scalar(obj['step']), url: clip(obj['url'], 200),
        pool_size: scalar(obj['pool_size']),
        candidate_labels: cands.slice(0, 40).map((c) => clip(c['label'], 60)),
      })
      continue
    }
  }
  const endObj = end ?? {}
  const stopCode = typeof endObj['stop_code'] === 'string' ? endObj['stop_code'] : null
  const endCode = endObj['code']
  let status: AmberFlowPilotSummary['status']
  if (outcome.timedOut) status = 'killed'
  else if (endObj['ok'] === true) status = 'held'
  else if (stopCode === 'browser_dead' || endCode === 'browser_dead') status = 'browser_dead'
  else if (endCode === 'config_error' || outcome.code === 2) status = 'config_error'
  else status = 'stopped'
  const cache = (endObj['cache'] ?? undefined) as { hits?: number; misses?: number } | undefined
  const summary: AmberFlowPilotSummary = {
    status,
    ok: endObj['ok'] === true,
    stop_code: stopCode,
    steps: typeof endObj['steps'] === 'number' ? endObj['steps'] : 0,
    model_asks: typeof endObj['model_asks'] === 'number' ? endObj['model_asks'] : null,
    rule_picks: typeof endObj['rule_picks'] === 'number' ? endObj['rule_picks'] : null,
    model_picks: typeof endObj['model_picks'] === 'number' ? endObj['model_picks'] : null,
    handoffs: typeof endObj['handoffs'] === 'number' ? endObj['handoffs'] : null,
    fallbacks: typeof endObj['fallbacks'] === 'number' ? endObj['fallbacks'] : null,
    ...(endObj['driver'] === 'agent' ? { driver: 'agent' } : {}),
    ...(typeof endObj['failed_asks'] === 'number' ? { failed_asks: endObj['failed_asks'] } : {}),
    ...(cache !== undefined && typeof cache.hits === 'number'
      ? { cache: { hits: cache.hits, misses: typeof cache.misses === 'number' ? cache.misses : 0 } }
      : {}),
    ...(typeof endObj['url'] === 'string' && endObj['url'] !== '' ? { url: clip(endObj['url'], 200) } : {}),
    out_dir: outDir,
    timed_out: outcome.timedOut,
    exit_code: outcome.code,
    events,
    ...(handoffNotes.length === 0 ? {} : { handoffs_detail: handoffNotes }),
    ...(eventsDropped > 0 ? { events_truncated: eventsDropped } : {}),
    ...(notes.length === 0 ? {} : { notes }),
    ...(endCode !== undefined ? { end_code: String(endCode) } : {}),
    stdout_tail: outcome.stderr.trim() === '' ? clip(outcome.stdout, 400) : clip(outcome.stderr, 400),
  }
  return summary
}

/**
 * Persist what a killed pilot run managed to produce (same discipline as the run face's
 * `run-killed.json`): a timed-out pilot writes no `pilot_end`, so the completed steps live only in
 * the output tails. Best-effort by design; pruned together with the temp directory.
 */
function writePilotKilledEvidence(outDir: string, outcome: ProcessOutcome): string {
  const evidence: JsonObject = {
    app: 'pilot',
    timedOut: outcome.timedOut,
    exit_code: outcome.code,
    killed_at: new Date().toISOString(),
    timeout_ms: outcome.timeoutMs ?? null,
    stdout_tail: (outcome.stdoutFull ?? outcome.stdout).slice(-4000),
    stderr_tail: outcome.stderr.slice(-4000),
    note: 'Partial evidence of a pilot run the bridge killed at its wall-clock cap: the completed '
      + 'driving steps live only in this tail. Rerun with a larger timeout_sec.',
  }
  const evidencePath = path.join(outDir, 'pilot-killed.json')
  try {
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2))
    return evidencePath
  } catch {
    return ''
  }
}

/**
 * Run one `amber pilot` call end to end and project its bounded summary.
 * @param options - resolved bridge options.
 * @param args - the model-facing call arguments (`url`/`goal` required).
 * @param deps - test seams (fake-engine harness replaces argv assembly / process run).
 * @returns the bounded projection of the engine's JSONL protocol stream.
 * @throws when `timeoutSec` is not an integer in 1..7200 or the playbook exceeds its line cap.
 */
export async function runPilotBridge(
  options: BridgeOptions, args: AmberFlowPilotArgs, deps: PilotRunDeps = {},
): Promise<AmberFlowPilotSummary> {
  const toolName = `${options.toolPrefix}_pilot`
  if (args.timeoutSec !== undefined
    && (!Number.isInteger(args.timeoutSec) || args.timeoutSec <= 0 || args.timeoutSec > RUN_TIMEOUT_MAX_SEC)) {
    throw new Error(fillArgMessage(RUN_BRIDGE_MESSAGES.timeoutSec, {
      tool: toolName,
      max: String(RUN_TIMEOUT_MAX_SEC),
      defaultSec: String(Math.round(options.timeoutMs / 1000)),
    }))
  }
  const outDir = newOutDir('pilot')
  pruneRunDirs(options.keepRuns)
  // 兜底剧本物化：逐行原样落盘走 `--input`（指令闭集/单行失败纪律在引擎侧校验，桥不复制）。
  let inputScript: string | null = null
  if (args.commands !== undefined && args.commands.trim() !== '') {
    const lines = args.commands.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
    if (lines.length > PILOT_COMMANDS_MAX_LINES) {
      throw new Error(
        `amberflow-bridge: ${toolName} commands playbook exceeds ${String(PILOT_COMMANDS_MAX_LINES)} lines; split the walkthrough`,
      )
    }
    inputScript = path.join(outDir, 'commands.jsonl')
    fs.writeFileSync(inputScript, `${lines.join('\n')}\n`, 'utf8')
  }
  const spawnOptions: BridgeOptions = args.timeoutSec === undefined
    ? options
    : { ...options, timeoutMs: args.timeoutSec * 1000 }
  const build = deps.buildArgv ?? pilotArgs
  const run = deps.run ?? runProcess
  const outcome = await run(spawnOptions, build(options, { ...args, outDir, inputScript }))
  const summary = projectPilotOutcome(outDir, outcome)
  if (summary.status === 'killed') {
    writePilotKilledEvidence(outDir, outcome)
  }
  return summary
}
