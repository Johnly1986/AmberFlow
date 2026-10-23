import path from "node:path";
import { parseArgs } from "node:util";
import type { CliContext } from "../context.ts";
import { say, diag, emitJson } from "../context.ts";
import { usageError, usageFromParseError } from "../errors.ts";
import { successEnvelope } from "../json.ts";
import { runExecutable } from "../process.ts";
import {
  CONFIG_KEYS, displayValue, initConfigFile, isKnownConfigKey, isSecretKey,
  legacyConfigPath, projectConfigPath, removeConfigValue, resolveConfig,
  selectedConfigPath, userConfigPath, writeConfigValue,
} from "../config-store.ts";

const KEY_HINT = `可用键：${CONFIG_KEYS.join(", ")}`;

function parse(args: string[], options: Record<string, { type: "boolean" | "string" }>) {
  try {
    return parseArgs({ args, allowPositionals: true, options });
  } catch (err) {
    throw usageFromParseError(err);
  }
}

function wantsJson(ctx: CliContext, v: { json?: boolean }): boolean {
  return ctx.globals.json || Boolean(v.json);
}

function requireKnown(key: string | undefined, what: string): string {
  if (!key) throw usageError(`${what} 需要配置键名`, { hint: KEY_HINT });
  if (!isKnownConfigKey(key)) {
    throw usageError(`未知配置键 '${key}'`, { hint: KEY_HINT, next: ["amber config show"] });
  }
  return key;
}

function targetFile(ctx: CliContext, project: boolean): { file: string; label: string } {
  const file = selectedConfigPath(ctx.cwd, ctx.baseEnv, ctx.explicitConfig, project);
  const label = ctx.explicitConfig ? "显式配置" : project ? "项目配置" : "用户配置";
  return { file, label };
}

export async function runConfig(args: string[], ctx: CliContext): Promise<number> {
  let sub = args[0];
  let rest = args.slice(1);
  if (sub === undefined || sub === "--help" || sub === "-h") {
    if (sub === "--help" || sub === "-h") {
      const { commandHelp } = await import("../registry.ts");
      say(ctx, commandHelp("config"));
      return 0;
    }
    sub = "show";
    rest = args;
  }
  switch (sub) {
    case "path": return configPathCmd(rest, ctx);
    case "show": return configShow(rest, ctx);
    case "get": return configGet(rest, ctx);
    case "set": return configSet(rest, ctx);
    case "unset": return configUnset(rest, ctx);
    case "init": return configInit(rest, ctx);
    case "edit": return configEdit(rest, ctx);
    default:
      throw usageError(`未知的 config 子命令 '${sub}'`, {
        hint: "可用：path / show / get / set / unset / init / edit",
        next: ["amber config --help"],
      });
  }
}

function configPathCmd(args: string[], ctx: CliContext): number {
  const v = parse(args, { project: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" } }).values;
  if (v.help) {
    say(ctx, "用法：amber config path [--project]");
    return 0;
  }
  const resolved = resolveConfig(ctx.baseEnv, ctx.cwd, ctx.explicitConfig);
  const user = userConfigPath(ctx.baseEnv);
  const project = projectConfigPath(ctx.cwd);
  const legacy = legacyConfigPath();
  const effective = ctx.explicitConfig
    ? path.resolve(ctx.cwd, ctx.explicitConfig)
    : [...resolved.layers].reverse().find((l) => l.exists && l.name !== "旧 rc")?.path ?? project;
  if (wantsJson(ctx, v)) {
    emitJson(ctx, successEnvelope("config path", {
      user, project, legacy,
      explicit: ctx.explicitConfig ? path.resolve(ctx.cwd, ctx.explicitConfig) : null,
      effective,
    }));
    return 0;
  }
  if (v.project) {
    say(ctx, project);
    return 0;
  }
  say(ctx, `旧 rc：    ${legacy}${resolved.layers[0]?.exists ? "" : "（不存在）"}`);
  say(ctx, `用户配置：${user}`);
  say(ctx, `项目配置：${project}`);
  if (ctx.explicitConfig) say(ctx, `显式配置：${path.resolve(ctx.cwd, ctx.explicitConfig)}`);
  say(ctx, `生效文件：${effective}`);
  return 0;
}

function configShow(args: string[], ctx: CliContext): number {
  const v = parse(args, { json: { type: "boolean" }, help: { type: "boolean" }, verbose: { type: "boolean" } }).values;
  if (v.help) {
    say(ctx, "用法：amber config show [--json]");
    return 0;
  }
  const resolved = resolveConfig(ctx.baseEnv, ctx.cwd, ctx.explicitConfig);
  const keys = [...new Set([...CONFIG_KEYS, ...Object.keys(resolved.values)])].sort();
  const shown = keys
    .filter((k) => resolved.values[k] !== undefined)
    .map((k) => {
      const item = resolved.values[k]!;
      return { key: k, value: item.value, displayed: displayValue(k, item.value), source: item.source, secret: item.secret };
    });

  if (wantsJson(ctx, v)) {
    const envelope = successEnvelope("config show", {
      layers: resolved.layers.map((l) => ({
        name: l.name, path: l.path, exists: l.exists, count: Object.keys(l.values).length, errors: l.errors,
      })),
      values: Object.fromEntries(shown.map((s) => [s.key, {
        value: s.secret ? s.displayed : s.value,
        source: s.source, secret: s.secret,
      }])),
    }, {
      exitCode: resolved.errors.length ? 2 : 0,
      diagnostics: resolved.errors,
      next: ["amber config set <KEY> <VALUE>", "amber doctor"],
    });
    if (resolved.errors.length) {
      envelope.ok = false;
      envelope.error = {
        code: "CONFIG",
        message: "配置层不合法",
        hint: "按 layers[].errors 定位文件；修好后重跑 doctor。",
        next: ["amber doctor"],
      };
    }
    emitJson(ctx, envelope);
    return resolved.errors.length ? 2 : 0;
  }

  for (const layer of resolved.layers) {
    const state = layer.exists ? `${Object.keys(layer.values).length} 项` : "不存在";
    say(ctx, `${layer.name}：${layer.path ?? "（无）"}（${state}）`);
    for (const err of layer.errors) say(ctx, `  ✗ ${err}`);
  }
  say(ctx, "");
  if (!shown.length) {
    say(ctx, "没有生效的配置项（全部按环境变量 / 内建默认）。");
  } else {
    const keyWidth = Math.max(...shown.map((s) => s.key.length));
    for (const s of shown) {
      say(ctx, `  ${s.key.padEnd(keyWidth)} = ${s.secret ? s.displayed : s.value}  [${s.source}]`);
    }
  }
  return resolved.errors.length ? 2 : 0;
}

function configGet(args: string[], ctx: CliContext): number {
  const parsed = parse(args, { json: { type: "boolean" }, help: { type: "boolean" } });
  if (parsed.values.help) {
    say(ctx, "用法：amber config get <KEY>");
    return 0;
  }
  const key = requireKnown(parsed.positionals[0], "config get");
  const resolved = resolveConfig(ctx.baseEnv, ctx.cwd, ctx.explicitConfig);
  const item = resolved.values[key];
  if (!item) {
    throw usageError(`配置键 ${key} 未设置`, {
      hint: "可以用 amber config set 写入。",
      next: [`amber config set ${key} <VALUE>`],
    });
  }
  if (wantsJson(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("config get", {
      key, value: item.value, masked: item.secret ? displayValue(key, item.value) : item.value,
      source: item.source, secret: item.secret,
    }));
  } else {
    say(ctx, item.value);
  }
  return 0;
}

function configSet(args: string[], ctx: CliContext): number {
  const parsed = parse(args, {
    project: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" },
  });
  if (parsed.values.help) {
    say(ctx, "用法：amber config set <KEY> <VALUE> [--project]");
    return 0;
  }
  const key = requireKnown(parsed.positionals[0], "config set");
  const value = parsed.positionals[1];
  if (value === undefined) throw usageError("config set 需要值", { next: [`amber config set ${key} <VALUE>`] });
  const target = targetFile(ctx, Boolean(parsed.values.project));
  try {
    writeConfigValue(target.file, key, value);
  } catch (err) {
    throw usageError(err instanceof Error ? err.message : String(err));
  }
  if (isSecretKey(key)) {
    diag(ctx, `提示：${key} 是密钥类配置；文件已按明文写入，请确认目录权限，不要提交到版本库。`);
  }
  if (wantsJson(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("config set", { key, path: target.file, layer: target.label }));
  } else {
    say(ctx, `✓ ${key} 已写入${target.label}：${target.file}`);
  }
  return 0;
}

function configUnset(args: string[], ctx: CliContext): number {
  const parsed = parse(args, {
    project: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" },
  });
  if (parsed.values.help) {
    say(ctx, "用法：amber config unset <KEY> [--project]");
    return 0;
  }
  const key = requireKnown(parsed.positionals[0], "config unset");
  const target = targetFile(ctx, Boolean(parsed.values.project));
  let removed = false;
  try {
    removed = removeConfigValue(target.file, key);
  } catch (err) {
    throw usageError(err instanceof Error ? err.message : String(err));
  }
  if (wantsJson(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("config unset", { key, path: target.file, removed, layer: target.label }));
  } else {
    say(ctx, removed
      ? `✓ 已从${target.label}删除 ${key}：${target.file}`
      : `${key} 不在${target.label}中：${target.file}`);
  }
  return 0;
}

function configInit(args: string[], ctx: CliContext): number {
  const parsed = parse(args, {
    project: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" },
  });
  if (parsed.values.help) {
    say(ctx, "用法：amber config init [--project]");
    return 0;
  }
  const target = targetFile(ctx, Boolean(parsed.values.project));
  const created = initConfigFile(target.file);
  if (!created) {
    throw usageError(`${target.label}已存在：${target.file}`, {
      hint: "直接 amber config edit 或 amber config set 即可。",
      next: [`amber config path${parsed.values.project ? " --project" : ""}`],
    });
  }
  if (wantsJson(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("config init", { path: target.file, layer: target.label }));
  } else {
    say(ctx, `✓ 已创建${target.label}：${target.file}`);
  }
  return 0;
}

async function configEdit(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parse(args, {
    project: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" },
  });
  if (parsed.values.help) {
    say(ctx, "用法：amber config edit [--project]");
    return 0;
  }
  if (!ctx.isTTY) {
    throw usageError("config edit 需要终端里的编辑器", {
      hint: "非 TTY 不打开交互式编辑器；用 config set / unset 修改。",
      next: ["amber config set <KEY> <VALUE>", "amber config show"],
    });
  }
  const target = targetFile(ctx, Boolean(parsed.values.project));
  if (!initConfigFile(target.file)) {
    // 已存在：保持原内容。
  }
  const editor = ctx.baseEnv.VISUAL || ctx.baseEnv.EDITOR;
  if (!editor) {
    throw usageError("没有设置 EDITOR / VISUAL，无法打开编辑器", {
      hint: `文件路径：${target.file}`,
      next: [`amber config path${parsed.values.project ? " --project" : ""}`],
    });
  }
  // 编辑器可能自带参数（code --wait / notepad.exe），交给 shell 解析。
  const code = await runExecutable(`${editor} "${target.file}"`, [], {
    cwd: ctx.cwd,
    env: ctx.env,
    shell: true,
  });
  if (code !== 0) {
    throw usageError(`编辑器退出码 ${code}`, { hint: target.file });
  }
  if (wantsJson(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("config edit", { path: target.file, layer: target.label }));
  } else {
    say(ctx, `已保存：${target.file}`);
  }
  return 0;
}
