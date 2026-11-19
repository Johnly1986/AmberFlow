/**
 * `amber pilot` 入口：起飞 → 驾驶 → 停因交接 → 兜底指令（stdin JSONL）→ 收尾。
 *
 * 编排模板照搬 session-runtime-entry（大文件拆分后只持有"进程/stdio/空闲超时/退出码"层）：
 *   - 驾驶循环每停一次（非 browser_dead）就把 stdin 交给兜底指令 readline；
 *     resume/redirect 后重新进驾驶轮（预算不清零），finish/abort 结束会话。
 *   - `--input` 文件 = 非交互剧本（Agent 兜底自动化）；EOF 且无未决交接 = 干净收尾。
 *
 * 退出码：0 = final_signal_held；1 = browser_dead / 输入流错误；3 = 被停因挡住（含 abort）。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { PilotRuntime, validatePilotOptions, type PilotSink } from "./pilot-runtime.ts";
import {
  PILOT_DEFAULT_IDLE_TIMEOUT_MS, type PilotOptions,
} from "./pilot-contract.ts";
import { errMsg } from "./session-runtime-contract.ts";

function intIn(v: unknown, lo: number, hi: number): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) return null;
  return v;
}

/** 起 pilot + 驾驶 + 兜底回路 + 收尾。返回进程退出码。 */
export async function runPilot(opts: PilotOptions, sink: PilotSink): Promise<number> {
  const invalid = validatePilotOptions(opts);
  if (invalid !== null) {
    sink.respond({ type: "pilot_end", unsolicited: true, ok: false, code: "config_error", reason: invalid });
    return 2;
  }
  const rt = new PilotRuntime(opts, sink);
  const idleMs = intIn(opts.idleTimeoutMs ?? PILOT_DEFAULT_IDLE_TIMEOUT_MS, 0, 24 * 60 * 60 * 1000)
    ?? PILOT_DEFAULT_IDLE_TIMEOUT_MS;
  let interrupted = false;
  let idleFired = false;
  /** 活跃 readline（闭包内赋值；finally 只负责关掉它，不再读写）。 */
  let rl: readline.Interface | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const closeRl = (): void => { const r = rl; if (r !== null) r.close(); };
  const onInterrupt = (): void => { interrupted = true; closeRl(); };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);

  const armIdle = (): void => {
    if (idleMs <= 0) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => { idleFired = true; closeRl(); }, idleMs);
  };

  /**
   * 兜底指令流：`--input` 文件整段剧本**只打开一次**（跨驾驶轮共享同一 readline 序列——
   * 每次交接都重开文件会把已消费的指令再读一遍）；stdin 模式每轮重开（交互语义）。
   * 读尽（文件 EOF / stdin 关闭）= 无人继续兜底 → 收尾（final_signal 已成立则按它收）。
   */
  let scriptIter: AsyncIterableIterator<string> | null = null;
  const nextCommand = async (): Promise<string | null> => {
    if (opts.inputFile !== null && opts.inputFile !== undefined) {
      if (scriptIter === null) {
        const stream = fs.createReadStream(path.resolve(opts.inputFile), { encoding: "utf8" });
        const iface = readline.createInterface({ input: stream, crlfDelay: Infinity });
        rl = iface;
        scriptIter = iface[Symbol.asyncIterator]();
      }
      const r = await scriptIter.next();
      return r.done === true ? null : r.value;
    }
    // stdin：每轮驾驶暂停后重开一段 readline（同一 stdin 不能双开；resume 即关）。
    if (stdinIter === null) {
      const iface = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
      rl = iface;
      stdinIter = iface;
    }
    const r = await stdinIter[Symbol.asyncIterator]().next();
    return r.done === true ? null : r.value;
  };
  let stdinIter: readline.Interface | null = null;

  /** 一段兜底等待：读指令直到 resume/redirect（继续）或 finish/abort/EOF（结束）。 */
  const awaitCommands = async (): Promise<"continue" | "closed"> => {
    armIdle();
    while (true) {
      const line = await nextCommand();
      if (line === null) {
        if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
        return "closed";
      }
      const raw = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
      if (raw.trim() === "") { armIdle(); continue; }
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      const { driveAgain } = await rt.handleLine(raw);
      if (!driveAgain) return "closed";
      // resume/redirect：指令流保持打开（文件模式跨轮续读；stdin 模式续读同一接口），
      // 直接回驾驶轮。
      return "continue";
    }
  };

  try {
    await rt.start();
    // 驾驶轮：停因 → 兜底等待 → resume/redirect 再进下一轮；browser_dead 直接收尾。
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const stop = await rt.drive();
      if (rt.done || stop === "browser_dead") break;
      const next = await awaitCommands();
      if (next === "closed") break;
      // 交接已被 resume/redirect 解除：继续驾驶（预算不清零）。
    }    if (idleFired) {
      sink.respond({
        type: "pilot_end", unsolicited: true, ok: false, code: "idle_timeout",
        reason: `no fallback command for ${idleMs}ms (--idle-timeout-ms); closing`,
      });
    } else if (interrupted) {
      sink.respond({ type: "pilot_end", unsolicited: true, ok: false, code: "interrupted", reason: "signal received" });
    }
  } catch (e) {
    sink.respond({
      type: "pilot_end", unsolicited: true, ok: false, code: "browser_dead", reason: errMsg(e),
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    closeRl();
    await rt.finish(null);
    await rt.closeBrowser();
  }
  return interrupted || idleFired ? 3 : rt.exitCode;
}
