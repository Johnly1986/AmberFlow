/**
 * CLI 的统一错误面。
 *
 * 旧入口各自 `console.error` + 返回码；新入口要同时服务人类输出、`--json` 和
 * 兼容层，所以把「错误码 → 退出码 → 下一步」收在一处。可预期错误永远不打堆栈，
 * 只有真正未捕获的异常才交给顶层。
 */

export const EXIT = {
  OK: 0,
  INCOMPLETE: 1,
  USAGE: 2,
  BLOCKED: 3,
  QUALITY_GATE: 4,
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly hint: string | null;
  readonly next: string[];

  constructor(
    code: string,
    message: string,
    opts: { exitCode?: ExitCode; hint?: string | null; next?: string[] } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = opts.exitCode ?? EXIT.USAGE;
    this.hint = opts.hint ?? null;
    this.next = opts.next ?? [];
  }
}

/** 结果包络 `error.code` 的退出码映射（唯一出处）。各入口共用，避免分支各自漂移。 */
export type ResultCode = "OK" | "INCOMPLETE" | "USAGE" | "BLOCKED" | "QUALITY_GATE" | "INTERRUPTED";

export function exitCodeName(exitCode: number): ResultCode {
  switch (exitCode) {
    case EXIT.OK:
      return "OK";
    case EXIT.USAGE:
      return "USAGE";
    case EXIT.BLOCKED:
      return "BLOCKED";
    case EXIT.QUALITY_GATE:
      return "QUALITY_GATE";
    case EXIT.INTERRUPTED:
      return "INTERRUPTED";
    default:
      return "INCOMPLETE";
  }
}

export function usageError(message: string, opts: { hint?: string | null; next?: string[] } = {}): CliError {
  return new CliError("USAGE", message, { ...opts, exitCode: EXIT.USAGE });
}

export function blockedError(message: string, opts: { hint?: string | null; next?: string[] } = {}): CliError {
  return new CliError("BLOCKED", message, { ...opts, exitCode: EXIT.BLOCKED });
}

/** 把 Node `parseArgs` 的异常翻译成统一的一行用法错误。 */
export function usageFromParseError(err: unknown): CliError {
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.replace(/^[A-Za-z]*Error:\s*/, "");
  const hint = /--dry\b/.test(message)
    ? "你是不是想用 --dry-run？"
    : /--no-sources\b/.test(message)
      ? "你是不是想用 --skip-data？"
      : null;
  return usageError(`参数用法不对：${message}`, hint ? { hint } : {});
}

/** 人类错误块：错误 / 提示 / 下一步。 */
export function formatCliError(err: CliError): string[] {
  const lines = [`错误：${err.message}`];
  if (err.hint) lines.push(`提示：${err.hint}`);
  if (err.next.length) {
    lines.push("下一步：");
    for (const n of err.next) lines.push(`  ${n}`);
  }
  return lines;
}
