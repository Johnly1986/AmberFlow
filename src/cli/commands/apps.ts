import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { APPS_DIR, listPacks, loadPack, validatePack, type AppPack } from "../../app/app-pack.ts";
import { userAppsDir } from "../../app/amberflow-home.ts";
import type { CliContext } from "../context.ts";
import { say, emitJson } from "../context.ts";
import { blockedError, usageError, usageFromParseError, type CliError } from "../errors.ts";
import { successEnvelope } from "../json.ts";

interface AppInfo {
  id: string;
  label: string;
  path: string;
  source: "user" | "built-in";
  steps: number;
  kind: "journey" | "measure" | "unknown";
  error: string | null;
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function sourceOf(p: string, ctx: CliContext): "user" | "built-in" {
  return inside(path.resolve(p), path.resolve(userAppsDir(ctx.env))) ? "user" : "built-in";
}

function readPackAt(p: string): AppPack | null {
  try {
    const pack = JSON.parse(fs.readFileSync(p, "utf-8")) as AppPack;
    pack._path = p;
    return pack;
  } catch {
    return null;
  }
}

function infoOf(id: string, label: string, p: string, ctx: CliContext): AppInfo {
  const pack = readPackAt(p);
  if (!pack) {
    return { id, label, path: p, source: sourceOf(p, ctx), steps: 0, kind: "unknown", error: "pack.json 不是合法 JSON" };
  }
  return {
    id: pack.id ?? id,
    label: pack.label ?? label,
    path: p,
    source: sourceOf(p, ctx),
    steps: Array.isArray(pack.journey) ? pack.journey.length : 0,
    kind: pack.probe ? "measure" : Array.isArray(pack.journey) ? "journey" : "unknown",
    error: null,
  };
}

export function listAppInfos(ctx: CliContext): AppInfo[] {
  return listPacks().map(([id, label, p]) => infoOf(id, label, p, ctx));
}

function kindLabel(kind: AppInfo["kind"]): string {
  return kind === "journey" ? "旅程" : kind === "measure" ? "测量" : "未知";
}

function sourceLabel(source: AppInfo["source"]): string {
  return source === "user" ? "用户" : "内置";
}

function printList(ctx: CliContext, apps: AppInfo[]): void {
  const user = apps.filter((a) => a.source === "user").length;
  say(ctx, `应用（${user} 个用户 / ${apps.length - user} 个内置）`);
  if (!apps.length) {
    say(ctx, "  （没有发现应用）");
    return;
  }
  const idWidth = Math.max(10, ...apps.map((a) => a.id.length));
  const labelWidth = Math.max(16, ...apps.map((a) => a.label.length));
  for (const a of apps) {
    const status = a.error ? `  ✗ ${a.error}` : "";
    say(ctx,
      `  ${a.id.padEnd(idWidth)}  ${a.label.padEnd(labelWidth)}  `
      + `${String(a.steps).padStart(2)} 步  ${kindLabel(a.kind)} · ${sourceLabel(a.source)}  ${a.path}${status}`);
  }
}

function printShow(ctx: CliContext, pack: AppPack): void {
  const p = pack._path ?? "(unknown)";
  say(ctx, `${pack.id} — ${pack.label}`);
  say(ctx, `  目标：${pack.goal}`);
  say(ctx, `  类型：${pack.probe ? "测量" : "旅程"} · ${pack.journey?.length ?? 0} 步 · ${sourceLabel(sourceOf(p, ctx))}`);
  say(ctx, `  路径：${p}`);
  if (pack.hosts?.length) say(ctx, `  hosts：${pack.hosts.join(", ")}`);
  if (pack.slots && Object.keys(pack.slots).length) {
    say(ctx, `  参数：${Object.keys(pack.slots).join(", ")}`);
  }
  if (pack.required_slots?.length) say(ctx, `  必填参数：${pack.required_slots.join(", ")}`);
  if (pack.invariants?.length) {
    say(ctx, `  验收条件（${pack.invariants.length}）：`);
    for (const inv of pack.invariants) {
      say(ctx, `    - ${inv.id}: ${inv.desc ?? ""} ${JSON.stringify(inv.signal)}`);
    }
  }
  if (pack.generated_from) {
    const g = pack.generated_from;
    say(ctx, `  生成来源：${"spec" in g ? g.spec : g.source}`);
  }
  say(ctx, "  步骤：");
  (pack.journey ?? []).forEach((step, i) => {
    const id = step.id ? ` id=${String(step.id)}` : "";
    const role = typeof step.role === "string" ? step.role : null;
    const roleDesc = role ? pack.roles?.[role]?.desc : null;
    const kind = step.source !== undefined ? "工具" : "浏览器";
    const desc = String(step.desc ?? step.goal ?? roleDesc ?? (role ? `角色 ${role}` : ""));
    say(ctx, `    [${i + 1}]${id}  ${kind}  ${desc}${role ? `  (role=${role})` : ""}`);
  });
}

export async function runApps(args: string[], ctx: CliContext): Promise<number> {
  let sub = args[0];
  let rest = args.slice(1);
  if (sub === undefined || sub === "--list" || sub === "--help" || sub === "-h") {
    if (sub === "--help" || sub === "-h") {
      const { commandHelp } = await import("../registry.ts");
      say(ctx, commandHelp("apps"));
      return 0;
    }
    sub = "list";
    // `--list` 本身是兼容别名；不能再原样交给 list 的 parseArgs。
    rest = sub === "list" && args[0] === "--list" ? args.slice(1) : args;
  }

  switch (sub) {
    case "list":
      return appsList(rest, ctx);
    case "show":
      return appsShow(rest, ctx);
    case "check":
      return appsCheck(rest, ctx);
    case "path":
      return appsPath(rest, ctx);
    case "remove":
    case "rm":
      return appsRemove(rest, ctx);
    default:
      throw usageError(`未知的 apps 子命令 '${sub}'`, {
        hint: "可用：list / show / check / path / remove",
        next: ["amber apps --help"],
      });
  }
}

function parseSimple(args: string[], options: Record<string, { type: "boolean" | "string"; multiple?: boolean }>) {
  try {
    return parseArgs({ args, allowPositionals: true, options });
  } catch (err) {
    throw usageFromParseError(err);
  }
}

function jsonWanted(ctx: CliContext, v: { json?: boolean }): boolean {
  return ctx.globals.json || Boolean(v.json);
}

function appsList(args: string[], ctx: CliContext): number {
  const parsed = parseSimple(args, { json: { type: "boolean" }, help: { type: "boolean" }, verbose: { type: "boolean" } });
  if (parsed.values.help) {
    say(ctx, "用法：amber apps list [--json]");
    return 0;
  }
  const apps = listAppInfos(ctx);
  if (jsonWanted(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("apps list", { apps, counts: {
      total: apps.length,
      user: apps.filter((a) => a.source === "user").length,
      builtin: apps.filter((a) => a.source === "built-in").length,
    } }, { next: ["amber apps show <id>", "amber run <id>"] }));
    return 0;
  }
  printList(ctx, apps);
  return 0;
}

function appsShow(args: string[], ctx: CliContext): number {
  const parsed = parseSimple(args, { json: { type: "boolean" }, help: { type: "boolean" } });
  if (parsed.values.help) {
    say(ctx, "用法：amber apps show <应用> [--json]");
    return 0;
  }
  const id = parsed.positionals[0];
  if (!id) throw usageError("apps show 需要一个应用 id 或 pack.json 路径", { next: ["amber apps list"] });
  if (parsed.positionals.length > 1) throw usageError("apps show 只接受一个应用");
  let pack: AppPack;
  try {
    pack = loadPack(id);
  } catch (err) {
    throw usageError(`找不到应用 '${id}'`, {
      hint: err instanceof Error ? err.message : String(err),
      next: ["amber apps list"],
    });
  }
  if (jsonWanted(ctx, parsed.values)) {
    const p = pack._path ?? id;
    emitJson(ctx, successEnvelope("apps show", {
      app: pack.id, label: pack.label, goal: pack.goal, path: p,
      source: sourceOf(p, ctx), pack,
    }, { next: [`amber run ${pack.id}`] }));
    return 0;
  }
  printShow(ctx, pack);
  return 0;
}

function appsCheck(args: string[], ctx: CliContext): number {
  const parsed = parseSimple(args, { json: { type: "boolean" }, help: { type: "boolean" } });
  if (parsed.values.help) {
    say(ctx, "用法：amber apps check [<应用>] [--json]");
    return 0;
  }
  if (parsed.positionals.length > 1) throw usageError("apps check 最多接受一个应用");
  const requested = parsed.positionals[0];
  const targets = requested
    ? [{ id: requested, path: null as string | null }]
    : listPacks().map(([id, , p]) => ({ id, path: p }));
  if (!targets.length) {
    if (jsonWanted(ctx, parsed.values)) {
      emitJson(ctx, successEnvelope("apps check", { checked: 0, ok: true, results: [] }, {
        next: ["amber apps list"],
      }));
    } else {
      say(ctx, "没有发现可校验的应用。");
    }
    return 0;
  }
  const results: Array<{ app: string; path: string; problems: string[] }> = [];
  for (const t of targets) {
    try {
      const pack = loadPack(t.path ?? t.id);
      const problems = validatePack(pack);
      results.push({ app: pack.id, path: pack._path ?? t.path ?? t.id, problems });
    } catch (err) {
      results.push({ app: t.id, path: t.path ?? t.id, problems: [err instanceof Error ? err.message : String(err)] });
    }
  }
  const bad = results.filter((r) => r.problems.length);
  const exitCode = bad.length ? 2 : 0;
  if (jsonWanted(ctx, parsed.values)) {
    const envelope = successEnvelope("apps check", {
      checked: results.length, ok: bad.length === 0, results,
    }, { exitCode, next: bad.length ? ["amber apps show <id>"] : ["amber run <id>"] });
    if (bad.length) {
      envelope.ok = false;
      envelope.error = {
        code: "USAGE",
        message: `${bad.length}/${results.length} 个应用包未通过校验`,
        hint: "看 results[].problems；apps check 不启动浏览器。",
        next: ["amber apps show <id>"],
      };
    }
    emitJson(ctx, envelope);
    return exitCode;
  }
  for (const r of results) {
    if (!r.problems.length) {
      say(ctx, `✓ ${r.app}  ${r.path}`);
    } else {
      say(ctx, `✗ ${r.app}  ${r.path}`);
      for (const p of r.problems) say(ctx, `    - ${p}`);
    }
  }
  say(ctx, "");
  say(ctx, bad.length
    ? `${bad.length}/${results.length} 个应用包未通过校验。`
    : `${results.length} 个应用包全部通过校验。`);
  return exitCode;
}

function appsPath(args: string[], ctx: CliContext): number {
  const parsed = parseSimple(args, { json: { type: "boolean" }, help: { type: "boolean" } });
  if (parsed.values.help) {
    say(ctx, "用法：amber apps path <应用>");
    return 0;
  }
  const id = parsed.positionals[0];
  if (!id) throw usageError("apps path 需要一个应用 id", { next: ["amber apps list"] });
  if (parsed.positionals.length > 1) throw usageError("apps path 只接受一个应用");
  let pack: AppPack;
  try {
    pack = loadPack(id);
  } catch (err) {
    throw usageError(`找不到应用 '${id}'`, {
      hint: err instanceof Error ? err.message : String(err),
      next: ["amber apps list"],
    });
  }
  const p = pack._path ?? id;
  if (jsonWanted(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("apps path", { app: pack.id, path: p }));
  } else {
    say(ctx, p);
  }
  return 0;
}

async function appsRemove(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parseSimple(args, {
    json: { type: "boolean" }, help: { type: "boolean" },
    yes: { type: "boolean" }, force: { type: "boolean" },
  });
  if (parsed.values.help) {
    say(ctx, "用法：amber apps remove <应用> [--yes] [--force]");
    return 0;
  }
  const id = parsed.positionals[0];
  if (!id) throw usageError("apps remove 需要一个应用 id", { next: ["amber apps list"] });
  if (parsed.positionals.length > 1) throw usageError("apps remove 只接受一个应用");
  let pack: AppPack;
  try {
    pack = loadPack(id);
  } catch (err) {
    throw usageError(`找不到应用 '${id}'`, {
      hint: err instanceof Error ? err.message : String(err),
      next: ["amber apps list"],
    });
  }
  const packPath = path.resolve(pack._path ?? "");
  const dir = path.dirname(packPath);
  const userRoot = path.resolve(userAppsDir(ctx.env));
  const builtinRoot = path.resolve(APPS_DIR);
  const inUser = inside(packPath, userRoot);
  const inBuiltin = inside(packPath, builtinRoot);
  if (!inUser && !inBuiltin) {
    throw usageError(`拒绝删除 ${packPath}：只允许删除用户作用域或内置 apps/ 下的包`, {
      hint: "手工移动过的包请直接用文件管理器处理。",
    });
  }
  if (inBuiltin && !parsed.values.force) {
    throw blockedError(`拒绝删除内置应用 '${pack.id}'`, {
      hint: "内置包属于仓库夹具；确实要删加 --force（删错可从仓库历史恢复）。",
      next: ["amber apps remove <id> --force"],
    });
  }
  const yes = ctx.globals.yes || Boolean(parsed.values.yes);
  if (!yes) {
    if (!ctx.isTTY) {
      throw blockedError(`删除 '${pack.id}' 需要确认`, {
        hint: "非 TTY 请加 --yes；--yes 不隐含 --allow-dangerous。",
        next: [`amber apps remove ${pack.id} --yes`],
      });
    }
    const rl = (await import("node:readline/promises")).createInterface({
      input: ctx.stdin,
      output: process.stdout,
    });
    let ok = false;
    try {
      const answer = (await rl.question(`删除 ${pack.id}（${dir}）？[y/N] `)).trim().toLowerCase();
      ok = answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
    if (!ok) {
      say(ctx, "已取消。");
      return 0;
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  if (jsonWanted(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("apps remove", { app: pack.id, removed: dir }));
  } else {
    say(ctx, `✓ 已删除 ${pack.id}：${dir}`);
  }
  return 0;
}
