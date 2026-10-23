/**
 * `amber` 新 CLI 的测试夹具。
 *
 * CLI 的全部外部依赖（cwd / env / stdout / stderr / stdin / 子进程入口）都在
 * `CliContext` 里，所以测试不需要改进程环境变量、也不需要真起浏览器：这里把
 * 它们换成临时目录 + 数组收集器 + 可注入的 `runEntry`（记录调用、返回指定退出码）。
 *
 * 与 `cli-main.test.ts` 里那份内联夹具同形，只是多了一个"记录子进程调用"的缝——
 * 命令层测试要断言"新旗标被正确翻译成旧旗标"，那就必须看得见转发参数。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../src/cli/main.ts";
import { makeContext, type CliContext } from "../src/cli/context.ts";
import type { EntryRunner, RunEntryOptions } from "../src/cli/process.ts";

export interface Workspace {
  cwd: string;
  home: string;
  cleanup(): void;
}

export function workspace(): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amber-cli-"));
  const cwd = path.join(root, "work");
  const home = path.join(root, "home");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { cwd, home, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** 一次被拦截的子进程调用。 */
export interface EntryCall {
  entry: string;
  args: string[];
  opts: RunEntryOptions;
}

export interface CliResult {
  code: number;
  out: string;
  err: string;
  /** stdout 只有一个 JSON 信封时解析它；否则抛出（把原文带进消息里方便定位）。 */
  json<T = Record<string, any>>(): T;
  /** 记录到的子进程调用（没注入 runEntry 时为空）。 */
  calls: EntryCall[];
}

export interface CliOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  /**
   * 假的子进程入口。给数字 = 固定退出码；给函数 = 按 entry 决定。
   * 缺省（undefined）= 抛错，用来证明"这条路径不该起子进程"。
   */
  runEntry?: number | ((entry: string, args: string[]) => number);
}

const throwingEntry: EntryRunner = async () => {
  throw new Error("这条路径不该启动子进程：测试没有注入 runEntry");
};

/**
 * `main()` 会把配置层的值补进真正的 `process.env`（子进程要靠它看见配置）。
 * 单个进程里这没问题，但同一进程里跑几十条用例时，上一条用例的临时
 * `$AMBERFLOW_HOME` 会留下来、被下一条用例的"环境变量赢"规则当成用户意图，
 * 于是应用目录指向一个已删除的目录。这里把进程环境快照/还原，让每条用例独立。
 */
function withEnvSnapshot<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  const finish = (): void => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(saved)) {
      if (process.env[key] !== value) process.env[key] = value!;
    }
  };
  return fn().then((v) => { finish(); return v; }, (e) => { finish(); throw e; });
}

export async function cli(args: string[], opts: CliOptions = {}): Promise<CliResult> {
  const owned = opts.cwd && opts.home ? null : workspace();
  const cwd = opts.cwd ?? owned!.cwd;
  const home = opts.home ?? owned!.home;
  const out: string[] = [];
  const err: string[] = [];
  const calls: EntryCall[] = [];
  const runEntry: EntryRunner = async (entry, entryArgs, entryOpts = {}) => {
    calls.push({ entry, args: [...entryArgs], opts: entryOpts });
    const fake = opts.runEntry ?? throwingEntry;
    if (typeof fake === "number") return fake;
    return fake(entry, entryArgs);
  };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VITEST: "1",
    AMBERFLOW_HOME: home,
    ...(opts.env ?? {}),
  };
  let code = -1;
  try {
    code = await withEnvSnapshot(() => main(args, {
      cwd,
      env,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      isTTY: opts.isTTY ?? false,
      runEntry,
    }));
  } finally {
    owned?.cleanup();
  }
  const text = out.join("\n");
  return {
    code,
    out: text,
    err: err.join("\n"),
    calls,
    json<T = Record<string, any>>(): T {
      try {
        return JSON.parse(text) as T;
      } catch (e) {
        throw new Error(`stdout 不是一个 JSON 信封：${(e as Error).message}\n--- stdout ---\n${text}`);
      }
    },
  };
}

/** 绕过 `main()`，直接给命令函数一个受控的 context（命令层单元测试用）。 */
export function ctxOf(opts: CliOptions = {}): {
  ctx: CliContext;
  out: string[];
  err: string[];
  calls: EntryCall[];
  ws: Workspace;
} {
  const ws = opts.cwd && opts.home
    ? { cwd: opts.cwd, home: opts.home, cleanup: () => {} }
    : workspace();
  const out: string[] = [];
  const err: string[] = [];
  const calls: EntryCall[] = [];
  const runEntry: EntryRunner = async (entry, entryArgs, entryOpts = {}) => {
    calls.push({ entry, args: [...entryArgs], opts: entryOpts });
    const fake = opts.runEntry ?? throwingEntry;
    if (typeof fake === "number") return fake;
    return fake(entry, entryArgs);
  };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VITEST: "1",
    AMBERFLOW_HOME: ws.home,
    ...(opts.env ?? {}),
  };
  const ctx = makeContext({
    cwd: ws.cwd,
    env,
    baseEnv: env,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    isTTY: opts.isTTY ?? false,
    runEntry,
  });
  return { ctx, out, err, calls, ws };
}
