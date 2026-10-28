import { spawn } from "node:child_process";
import path from "node:path";
import { REPO } from "../support/paths.ts";

export interface RunEntryOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 把子进程的 stdout 转到 stderr；`--json` 时用，保证 stdout 只有一个信封。 */
  stdoutToStderr?: boolean;
  /** 全局 --timeout 的毫秒形态；到点先 SIGTERM，超时按未完成处理。 */
  timeoutMs?: number | null;
}

export type EntryRunner = (
  entry: string,
  args: string[],
  opts?: RunEntryOptions,
) => Promise<number>;

function normalizeExit(code: number | null, signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") return 130;
  if (code === null) return 1;
  // Windows 的 Ctrl-C 退出码：0xC000013A。脚本只认得 130。
  if (code === 3221225786) return 130;
  return code;
}

/**
 * 运行一个 TS 入口。旧命令保留原样的 stdout/stderr/退出码，新 CLI 只负责
 * 参数归一化与退出码归一化。
 */
export function runNodeEntry(entry: string, args: string[], opts: RunEntryOptions = {}): Promise<number> {
  const script = path.isAbsolute(entry) ? entry : path.resolve(REPO, entry);
  return runExecutable(process.execPath, ["--experimental-strip-types", script, ...args], opts);
}

/** 只用于确实会把结构化结果写 stdout 的旧入口（如 learn --json）后再包信封。 */
export function runNodeEntryCapture(
  entry: string,
  args: string[],
  opts: RunEntryOptions = {},
): Promise<{ code: number; stdout: string }> {
  const script = path.isAbsolute(entry) ? entry : path.resolve(REPO, entry);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, ["--experimental-strip-types", script, ...args], {
        cwd: opts.cwd ?? process.cwd(),
        env: opts.env ?? process.env,
        stdio: ["inherit", "pipe", "inherit"],
      });
    } catch (err) {
      console.error(`错误：无法启动 ${entry}：${err instanceof Error ? err.message : String(err)}`);
      resolve({ code: 2, stdout: "" });
      return;
    }
    let stdout = "";
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    let finished = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut ? 1 : normalizeExit(code, null), stdout });
    };
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        console.error(`错误：${entry} 超过 ${Math.round(opts.timeoutMs! / 1000)} 秒，已停止。`);
        child.kill("SIGTERM");
      }, opts.timeoutMs);
    }
    child.once("error", (err) => {
      console.error(`错误：${entry} 启动失败：${err.message}`);
      finish(2);
    });
    // 等 close 而不是 exit：旧入口常用 process.exit()，stdout 管道可能还有未读完的字节。
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    child.once("exit", (code, signal) => { exitCode = code; exitSignal = signal; });
    child.once("close", () => finish(normalizeExit(exitCode, exitSignal)));
  });
}

/** 运行任意可执行文件（用于 `npx playwright install` / 编辑器等少量路径）。 */
export function runExecutable(
  command: string,
  args: string[],
  opts: RunEntryOptions & { shell?: boolean; stdoutToStderr?: boolean } = {},
): Promise<number> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd ?? process.cwd(),
        env: opts.env ?? process.env,
        stdio: opts.stdoutToStderr ? ["inherit", "pipe", "inherit"] : "inherit",
        ...(opts.shell ? { shell: true } : {}),
      });
    } catch (err) {
      console.error(`错误：无法启动 ${command}：${err instanceof Error ? err.message : String(err)}`);
      resolve(2);
      return;
    }

    if (opts.stdoutToStderr && child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    }

    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve(timedOut ? 1 : code);
    };
    const forward = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal);
      } catch {
        // 子进程已经退出：交给 exit 事件收尾。
      }
    };
    const onSigint = (): void => forward("SIGINT");
    const onSigterm = (): void => forward("SIGTERM");

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        console.error(`错误：${command} 超过 ${Math.round(opts.timeoutMs! / 1000)} 秒，已停止。`);
        forward("SIGTERM");
      }, opts.timeoutMs);
    }

    // 只在真正有子进程时挂信号转发；bin 的外层还有一层转发，最终都落到同一进程组。
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    child.once("error", (err) => {
      console.error(`错误：${command} 启动失败：${err.message}`);
      finish(2);
    });
    child.once("exit", (code, signal) => finish(normalizeExit(code, signal)));
  });
}
