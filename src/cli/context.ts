import { runNodeEntry, type EntryRunner } from "./process.ts";

/** 全局选项：命令自己的解析器仍可再看到它们，但错误/JSON 的统一处理只需要这一份。 */
export interface GlobalOptions {
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  yes: boolean;
  noColor: boolean;
  /** 全局超时（秒）。目前只做统一接收；具体命令按自己的语义消费。 */
  timeout: string | null;
}

/**
 * 一次 CLI 调用的全部外部依赖。
 *
 * 测试 import `main()` 时只需要替换 stdout/stderr/env/cwd，不必把进程变量
 * 全局改来改去。`baseEnv` 是读配置之前的快照，`env` 是层叠后的有效环境。
 */
export interface CliContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  baseEnv: NodeJS.ProcessEnv;
  globals: GlobalOptions;
  /** 显式 `--config`；解析后已从参数里移除。 */
  explicitConfig: string | null;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  stdin: NodeJS.ReadStream;
  isTTY: boolean;
  /** 统一子进程入口；测试可注入，避免真的启动浏览器。 */
  runEntry: EntryRunner;
}

export function makeContext(overrides: Partial<CliContext> = {}): CliContext {
  const baseEnv = { ...process.env };
  return {
    cwd: process.cwd(),
    env: { ...baseEnv },
    baseEnv,
    globals: { json: false, quiet: false, verbose: false, yes: false, noColor: false, timeout: null },
    explicitConfig: null,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    stdin: process.stdin,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    runEntry: runNodeEntry,
    ...overrides,
  };
}

/** 输出一行人类文案；非 TTY 也原样输出，只是不等待输入。 */
export function say(ctx: CliContext, line = ""): void {
  ctx.stdout(line);
}

/** 进度/诊断走 stderr，保持 `--json` 时 stdout 干净。 */
export function diag(ctx: CliContext, line: string): void {
  ctx.stderr(line);
}

/** 机器输出：stdout 只有一个 JSON 对象。 */
export function emitJson(ctx: CliContext, value: unknown): void {
  ctx.stdout(JSON.stringify(value, null, 2));
}
