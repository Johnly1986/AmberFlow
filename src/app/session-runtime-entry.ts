/**
 * `amber session` 入口：起会话 + 逐行驱动 + 收尾（stdin 或 `--input` 文件）。
 *
 * 从 session-runtime.ts 尾部纯搬移（大文件拆分）：只持有"进程/stdio/空闲超时/退出码"
 * 这一层，会话状态机仍在 `SessionRuntime`；行为逐字节不变。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { SessionRuntime } from "./session-runtime.ts";
import { StopError } from "./ctx.ts";
import {
  SESSION_DEFAULT_IDLE_TIMEOUT_MS, errMsg, intIn, sessionExitCode,
  type SessionExit, type SessionOptions, type SessionSink,
} from "./session-runtime-contract.ts";

/** 起会话 + 逐行驱动 + 收尾（stdin 或 `--input` 文件）。返回进程退出码。 */
export async function runSession(opts: SessionOptions, sink: SessionSink): Promise<number> {
  const rt = new SessionRuntime(opts, sink);
  const idleMs = intIn(opts.idleTimeoutMs, 0, 24 * 60 * 60 * 1000) ?? SESSION_DEFAULT_IDLE_TIMEOUT_MS;
  let exit: SessionExit = "eof";
  let idleFired = false;
  let interrupted = false;
  let rl: readline.Interface | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onInterrupt = (): void => { interrupted = true; rl?.close(); };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  try {
    try {
      await rt.start();
    } catch (e) {
      // 启动期环境错误（如 headed 但没有 XServer）：本次自动 open 失败，**会话不终结**——
      // 后续请求仍可换档（headless）或用其它方式继续；只有非启动期的错误才是会话级死亡。
      if (!(e instanceof StopError) || e.diagnostics?.["browser_startup"] !== true) throw e;
      sink.respond({ id: null, type: "open", ok: false, code: e.code, reason: e.message });
    }
    const input = opts.inputFile !== null && opts.inputFile !== undefined
      ? fs.createReadStream(path.resolve(opts.inputFile), { encoding: "utf8" })
      : process.stdin;
    rl = opts.inputFile !== null && opts.inputFile !== undefined
      ? readline.createInterface({ input, crlfDelay: Infinity })
      : readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });

    const arm = (): void => {
      if (idleMs <= 0) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { idleFired = true; rl?.close(); }, idleMs);
    };
    arm();
    for await (const line of rl) {
      // Windows/PowerShell 的 UTF-8 **带 BOM** 文件会让第一行的 JSON 解析失败（实测：
      // `Set-Content -Encoding UTF8` 的 --input 文件）。BOM 不是请求内容，剥掉它；
      // 只有行首这一个字符可能受影响，其余行逐字节不变。
      const raw = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
      if (raw.trim() === "") { arm(); continue; }
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      const stop = await rt.handleLine(raw);
      if (stop) { exit = "closed"; break; }
      arm();
    }
    if (idleFired) {
      exit = "idle_timeout";
      sink.respond({
        type: "session_end", unsolicited: true, ok: false, code: "idle_timeout",
        reason: `no request for ${idleMs}ms (--idle-timeout-ms); closing`,
      });
    } else if (interrupted) {
      exit = "interrupted";
      sink.respond({ type: "session_end", unsolicited: true, ok: false, code: "interrupted", reason: "signal received" });
    }
  } catch (e) {
    exit = "browser_dead";
    sink.respond({
      type: "session_end", unsolicited: true, ok: false, code: "browser_dead",
      reason: errMsg(e),
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    rl?.close();
    await rt.finish(exit);
  }
  return sessionExitCode(exit);
}
