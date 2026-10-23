#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO } from "../support/paths.ts";
import { CONFIG_KEYS, resolveConfig } from "./config-store.ts";
import { COMMANDS, commandHelp, globalHelp, suggestion } from "./registry.ts";
import { makeContext, say, emitJson, type CliContext, type GlobalOptions } from "./context.ts";
import { CliError, EXIT, formatCliError, usageError } from "./errors.ts";
import { errorEnvelope, successEnvelope } from "./json.ts";
import { runNodeEntry, type EntryRunner } from "./process.ts";

export interface MainOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  stdin?: NodeJS.ReadStream;
  isTTY?: boolean;
  runEntry?: EntryRunner;
}

interface Invocation {
  command: string | null;
  rest: string[];
  /** 命令后的原始参数（仅兼容层需要逐字节转发旧旗标）。 */
  rawRest: string[];
  globals: GlobalOptions;
  explicitConfig: string | null;
  /** 命令前出现的 -h/--help；命令后的 help 交给命令自己。 */
  helpBeforeCommand: boolean;
  version: boolean;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function extractConfig(argv: string[]): { args: string[]; config: string | null } {
  const out: string[] = [];
  let config: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config") {
      const v = argv[i + 1];
      // 与 --timeout 同一口径：值以 `-` 开头说明用户漏写了路径，悄悄把后面的旗标
      // 当文件名会变成"配了却像没配"的静默失败。
      if (v === undefined || v.startsWith("-")) {
        throw usageError("--config 需要一个文件路径", { next: ["amber --help"] });
      }
      config = v;
      i++;
      continue;
    }
    if (a.startsWith("--config=")) {
      config = a.slice("--config=".length);
      continue;
    }
    out.push(a);
  }
  return { args: out, config };
}

function parseInvocation(rawArgv: string[]): Invocation {
  const { args: argv, config } = extractConfig(rawArgv);
  const globals: GlobalOptions = { json: false, quiet: false, verbose: false, yes: false, noColor: false, timeout: null };
  let helpBeforeCommand = false;
  let version = false;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--json") { globals.json = true; i++; continue; }
    if (a === "--quiet" || a === "-q") { globals.quiet = true; i++; continue; }
    if (a === "--verbose") { globals.verbose = true; i++; continue; }
    if (a === "--yes") { globals.yes = true; i++; continue; }
    if (a === "--no-color") { globals.noColor = true; i++; continue; }
    if (a === "--timeout") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw usageError("--timeout 需要秒数", { next: ["amber --help"] });
      }
      globals.timeout = value;
      i += 2;
      continue;
    }
    if (a.startsWith("--timeout=")) {
      globals.timeout = a.slice("--timeout=".length);
      i++;
      continue;
    }
    if (a === "--help" || a === "-h") { helpBeforeCommand = true; i++; continue; }
    if (a === "--version" || a === "-V") { version = true; i++; continue; }
    if (a.startsWith("-") && i === 0) {
      throw usageError(`未知全局选项 '${a}'`, {
        hint: "全局选项只有 --json / --quiet / --verbose / --no-color / --yes / --config / --help / --version。",
        next: ["amber --help"],
      });
    }
    break;
  }
  // 全局 --no-color / --json / --yes 允许出现在命令后；命令解析器自己会再看到一次。
  if (argv.includes("--no-color")) globals.noColor = true;
  if (argv.includes("--json")) globals.json = true;
  if (argv.includes("--yes")) globals.yes = true;
  const command = argv[i] ?? null;
  const rawRest = argv.slice(i + 1);
  if (rawRest.includes("--version") || rawRest.includes("-V")) version = true;
  const rest: string[] = [];
  for (let j = 0; j < rawRest.length; j++) {
    const a = rawRest[j]!;
    if (a === "--quiet" || a === "-q") { globals.quiet = true; continue; }
    if (a === "--verbose") { globals.verbose = true; continue; }
    if (a === "--yes") { globals.yes = true; continue; }
    if (a === "--no-color") { globals.noColor = true; continue; }
    if (a === "--timeout") {
      const value = rawRest[j + 1];
      if (value === undefined || value.startsWith("-")) {
        throw usageError("--timeout 需要秒数", { next: ["amber --help"] });
      }
      globals.timeout = value;
      j++;
      continue;
    }
    if (a.startsWith("--timeout=")) {
      globals.timeout = a.slice("--timeout=".length);
      continue;
    }
    rest.push(a);
  }
  return { command, rest, rawRest, globals, explicitConfig: config, helpBeforeCommand, version };
}

function commandPath(command: string | null, rest: string[]): string {
  if (!command) return "amber";
  if (["apps", "config", "plan", "model", "dev"].includes(command) && rest[0] && !rest[0].startsWith("-")) {
    return `${command} ${rest[0]}`;
  }
  return command;
}

function syncConfigEnv(baseEnv: NodeJS.ProcessEnv, effective: NodeJS.ProcessEnv): { touched: string[] } {
  const touched: string[] = [];
  for (const key of CONFIG_KEYS) {
    const before = process.env[key];
    const next = effective[key];
    if ((before === undefined || before === "") && next !== undefined && next !== "") {
      process.env[key] = next;
      touched.push(key);
    }
  }
  return { touched };
}

function restoreConfigEnv(baseEnv: NodeJS.ProcessEnv, touched: string[]): void {
  for (const key of touched) {
    const before = baseEnv[key];
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
}

function reportError(ctx: CliContext, command: string, err: unknown, json: boolean): number {
  const cliErr = err instanceof CliError
    ? err
    : new CliError("INTERNAL", err instanceof Error ? err.message : String(err), {
      exitCode: EXIT.INCOMPLETE,
      hint: "这是未预期的内部错误；加 --verbose 可看堆栈。",
    });
  if (json) {
    emitJson(ctx, errorEnvelope(command, cliErr));
  } else {
    for (const line of formatCliError(cliErr)) ctx.stderr(line);
    if (ctx.globals.verbose && err instanceof Error && err.stack) ctx.stderr(err.stack);
  }
  return cliErr.exitCode;
}

class HelpRequested extends Error {}

async function dispatch(command: string, rest: string[], ctx: CliContext, rawRest: string[] = rest): Promise<number> {
  switch (command) {
    case "run": {
      const { runRun } = await import("./commands/run.ts");
      return runRun(rest, ctx);
    }
    case "record": {
      const { runRecord } = await import("./commands/record.ts");
      return runRecord(rest, ctx);
    }
    case "plan": {
      const { runPlan } = await import("./commands/plan.ts");
      return runPlan(rest, ctx);
    }
    case "apps": {
      const { runApps } = await import("./commands/apps.ts");
      return runApps(rest, ctx);
    }
    case "doctor": {
      const { runDoctor } = await import("./commands/doctor.ts");
      return runDoctor(rest, ctx);
    }
    case "config": {
      const { runConfig } = await import("./commands/config.ts");
      return runConfig(rest, ctx);
    }
    case "model": {
      const { runModel } = await import("./commands/model.ts");
      return runModel(rest, ctx);
    }
    case "dev": {
      const { runDev } = await import("./commands/dev.ts");
      return runDev(rest, ctx);
    }
    case "legacy": {
      const { runLegacy } = await import("./legacy.ts");
      // 兼容层必须看到用户原样输入的旧旗标；全局解析只在错误/JSON 面做旁路。
      return runLegacy(rawRest[0], rawRest.slice(1), ctx);
    }
    case "completion": {
      return completion(rest, ctx);
    }
    case "version": {
      const version = readVersion();
      if (ctx.globals.json) emitJson(ctx, successEnvelope("version", { version }));
      else say(ctx, `AmberFlow ${version}`);
      return 0;
    }
    case "help": {
      throw new HelpRequested();
    }
    default: {
      const names = COMMANDS.map((c) => c.name);
      const near = suggestion(command, names);
      throw usageError(`未知命令 '${command}'`, {
        hint: near ? `你是不是想用 '${near}'？` : "用 amber --help 查看可用命令。",
        next: [near ? `amber ${near} --help` : "amber --help"],
      });
    }
  }
}

async function home(ctx: CliContext): Promise<number> {
  const version = readVersion();
  let node = process.versions.node;
  let nodeOk = Number(node.split(".")[0] ?? 0) >= 22;
  let chromium: string | null = null;
  let modelReady = false;
  try {
    const { preflight } = await import("./start.ts");
    const p = preflight();
    node = p.node;
    nodeOk = p.nodeOk;
    chromium = p.chromium;
    modelReady = p.model;
  } catch {
    // 首页是轻量状态页：体检模块自己坏了也不该让 amber 无输出。
  }
  const provider = ctx.env.AMBERFLOW_DECISION_PROVIDER
    ?? ctx.env.AMBERFLOW_DEFAULT_DECISION_PROVIDER
    ?? (modelReady ? "auto → local" : "auto → rules");
  const { listAppInfos } = await import("./commands/apps.ts");
  const apps = listAppInfos(ctx);
  const user = apps.filter((a) => a.source === "user").length;

  if (ctx.globals.json) {
    emitJson(ctx, successEnvelope("amber", {
      version,
      node: { version: node, ok: nodeOk },
      chromium,
      modelReady,
      provider,
      apps: { total: apps.length, user, builtin: apps.length - user },
      shown: apps.slice(0, 10),
    }, { next: ["amber run demo-app", "amber record https://shop.example.com", "amber doctor"] }));
    return 0;
  }

  say(ctx, `AmberFlow ${version}`);
  say(ctx, "");
  say(ctx, `  Node        ${node}  ${nodeOk ? "✓" : "✗ 需要 ≥ 22.6"}`);
  say(ctx, `  Chromium    ${chromium ? "✓" : "✗ 未找到"}${chromium ? `  ${chromium}` : ""}`);
  say(ctx, `  决策源      ${provider}`);
  say(ctx, "");
  say(ctx, `应用（${user} 个用户 / ${apps.length - user} 个内置）`);
  const shown = apps.slice(0, 10);
  if (!shown.length) say(ctx, "  （没有发现应用）");
  for (const a of shown) {
    say(ctx, `  ${a.id.padEnd(16)} ${a.label.padEnd(28)} ${a.source === "user" ? "用户" : "内置"}`);
  }
  if (apps.length > shown.length) say(ctx, `  … 还有 ${apps.length - shown.length} 个，运行 amber apps list 查看。`);
  say(ctx, "");
  say(ctx, "下一步：");
  say(ctx, "  amber run demo-app                 先跑一个内置示例");
  say(ctx, "  amber record https://shop.example.com   录一条自己的流程");
  say(ctx, "  amber doctor                       环境有问题时先体检");
  return 0;
}

function completion(args: string[], ctx: CliContext): number {
  const shell = args[0];
  const commands = COMMANDS.map((c) => c.name).join(" ");
  const scripts: Record<string, string> = {
    bash: `_amber_complete() {\n  local cur="\${COMP_WORDS[COMP_CWORD]}"\n  COMPREPLY=( $(compgen -W "${commands} help completion version" -- "$cur") )\n}\ncomplete -F _amber_complete amber`,
    zsh: `#compdef amber\n_arguments '1:command:(${commands} help completion version)'`,
    fish: `complete -c amber -f -a "${commands} help completion version"`,
    powershell: `Register-ArgumentCompleter -CommandName amber -ScriptBlock { param($wordToComplete) "${commands} help completion version".Split(' ') | Where-Object { $_ -like "$wordToComplete*" } }`,
  };
  if (!shell || !scripts[shell]) {
    throw usageError("completion 需要 bash / zsh / fish / powershell 之一", {
      hint: Object.keys(scripts).join(" / "),
      next: ["amber completion powershell"],
    });
  }
  say(ctx, scripts[shell]!);
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2), options: MainOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const baseEnv = { ...(options.env ?? process.env) };
  const jsonRequested = argv.includes("--json");
  const ctx = makeContext({
    cwd,
    env: { ...baseEnv },
    baseEnv,
    ...(options.stdout ? { stdout: options.stdout } : {}),
    ...(options.stderr ? { stderr: options.stderr } : {}),
    ...(options.stdin ? { stdin: options.stdin } : {}),
    ...(options.isTTY !== undefined ? { isTTY: options.isTTY } : {}),
    ...(options.runEntry ? { runEntry: options.runEntry } : {}),
    globals: {
      json: jsonRequested,
      quiet: false,
      verbose: false,
      yes: false,
      noColor: baseEnv.NO_COLOR !== undefined,
      timeout: null,
    },
  });

  let invocation: Invocation;
  try {
    invocation = parseInvocation(argv);
  } catch (err) {
    return reportError(ctx, "amber", err, jsonRequested);
  }
  ctx.globals = {
    ...invocation.globals,
    noColor: invocation.globals.noColor || baseEnv.NO_COLOR !== undefined,
  };
  ctx.explicitConfig = invocation.explicitConfig;

  if (ctx.globals.timeout !== null) {
    const seconds = Number(ctx.globals.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return reportError(ctx, "amber", usageError("--timeout 需要正数秒", {
        next: ["amber --help"],
      }), jsonRequested);
    }
    const timeoutMs = seconds * 1000;
    const baseRunEntry = ctx.runEntry;
    ctx.runEntry = (entry, args, opts = {}) => baseRunEntry(entry, args, { ...opts, timeoutMs });
  }

  if (invocation.version) {
    const version = readVersion();
    if (ctx.globals.json) emitJson(ctx, successEnvelope("version", { version }));
    else say(ctx, `AmberFlow ${version}`);
    return 0;
  }
  if (invocation.helpBeforeCommand) {
    if (invocation.command && COMMANDS.some((c) => c.name === invocation.command)) {
      say(ctx, commandHelp(invocation.command));
    } else {
      say(ctx, globalHelp());
    }
    return 0;
  }
  if (invocation.command === "help") {
    const all = invocation.rest.includes("--all") || invocation.rest.includes("-a");
    const topic = invocation.rest.find((a) => !a.startsWith("-"));
    if (!topic || all) {
      say(ctx, globalHelp(all));
      return 0;
    }
    if (topic === "all") {
      say(ctx, globalHelp(true));
      return 0;
    }
    if (!COMMANDS.some((c) => c.name === topic)) {
      return reportError(ctx, "help", usageError(`帮助主题 '${topic}' 不存在`, {
        hint: `可用：${COMMANDS.map((c) => c.name).join(" / ")}`,
        next: ["amber --help"],
      }), jsonRequested);
    }
    say(ctx, commandHelp(topic));
    return 0;
  }

  const resolved = resolveConfig(baseEnv, cwd, invocation.explicitConfig);
  const command = invocation.command;
  const exemptConfigErrors = command === "config" || command === "doctor"
    || command === "legacy" || command === null;
  if (resolved.errors.length && !exemptConfigErrors) {
    return reportError(ctx, commandPath(command, invocation.rest), new CliError("CONFIG",
      `配置不合法：\n${resolved.errors.map((e) => `  - ${e}`).join("\n")}`, {
        hint: "先修配置；amber config show 可以查看层叠与错误。",
        next: ["amber config show"],
      }), jsonRequested);
  }

  ctx.env = resolved.env;
  ctx.baseEnv = baseEnv;
  if (invocation.globals.noColor) {
    ctx.env.NO_COLOR = "1";
    process.env.NO_COLOR = "1";
  }
  const { touched } = syncConfigEnv(baseEnv, resolved.env);

  try {
    if (!command) {
      return await home(ctx);
    }
    try {
      return await dispatch(command, invocation.rest, ctx, invocation.rawRest);
    } catch (err) {
      if (err instanceof HelpRequested) {
        say(ctx, globalHelp());
        return 0;
      }
      return reportError(ctx, commandPath(command, invocation.rest), err, jsonRequested || ctx.globals.json);
    }
  } finally {
    restoreConfigEnv(baseEnv, touched);
    if (invocation.globals.noColor) {
      if (baseEnv.NO_COLOR === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = baseEnv.NO_COLOR;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main();
  process.exitCode = code;
}
