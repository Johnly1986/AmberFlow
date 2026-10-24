import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { APPS_DIR, listPacks, loadPack, type AppPack } from "../../app/app-pack.ts";
import { validateApp } from "../../app/cross-ref.ts";
import { loadApp, loadScriptApp, resolveScriptPath, scriptDisplayPath } from "../../app/app-script.ts";
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
    case "explain":
      return appsExplain(rest, ctx);
    case "emit":
      return appsEmit(rest, ctx);
    case "path":
      return appsPath(rest, ctx);
    case "remove":
    case "rm":
      return appsRemove(rest, ctx);
    default:
      throw usageError(`未知的 apps 子命令 '${sub}'`, {
        hint: "可用：list / show / check / explain / emit / path / remove",
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

async function appsCheck(args: string[], ctx: CliContext): Promise<number> {
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
      const pack = await loadApp(t.path ?? t.id);
      const problems = validateApp(pack);
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

/** 把信号渲染成人话（explain 用；未识别算子原样 JSON，绝不假装理解）。 */
function renderSignal(spec: unknown): string {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return JSON.stringify(spec);
  const parts: string[] = [];
  for (const [op, arg] of Object.entries(spec as Record<string, unknown>)) {
    if (op === "all_of" || op === "any_of") {
      const kids = Array.isArray(arg) ? arg.map(renderSignal) : [renderSignal(arg)];
      parts.push(`${op === "all_of" ? "全部" : "任一"}（${kids.join("；")}）`);
    } else if (op === "not") {
      parts.push(`非（${renderSignal(arg)}）`);
    } else if (op === "manual") {
      parts.push(`人工确认：${String(arg)}`);
    } else if (op === "url_contains") {
      parts.push(`URL 含「${String(arg)}」`);
    } else if (op === "css_exists") {
      parts.push(`存在 ${String(arg)}`);
    } else if (op === "css_text_contains") {
      const [sel, want] = arg as unknown[];
      parts.push(`${String(sel)} 含「${String(want)}」`);
    } else if (op === "css_text_equals") {
      const [sel, want] = arg as unknown[];
      parts.push(`${String(sel)} 等于「${String(want)}」`);
    } else if (op === "css_value_equals") {
      const [sel, want] = arg as unknown[];
      parts.push(`${String(sel)} 的值等于「${String(want)}」`);
    } else if (op === "exit_ok") {
      parts.push("退出码在成功白名单里");
    } else if (op === "exit_code_equals") {
      parts.push(`退出码 = ${String(arg)}`);
    } else if (op === "stdout_contains") {
      parts.push(`stdout 含「${String(arg)}」`);
    } else if (op === "stdout_matches") {
      parts.push(`stdout 匹配 /${String(arg)}/`);
    } else if (op === "stderr_contains") {
      parts.push(`stderr 含「${String(arg)}」`);
    } else if (op === "json_path_equals") {
      const [p, want] = arg as unknown[];
      parts.push(`JSON ${String(p)} = ${String(want)}`);
    } else if (op === "file_exists") {
      parts.push(`文件存在 ${String(arg)}`);
    } else if (op === "file_absent") {
      parts.push(`文件不存在 ${String(arg)}`);
    } else {
      parts.push(`${op}=${JSON.stringify(arg)}`);
    }
  }
  return parts.join(" 且 ");
}

/** `amber apps explain <脚本>`：把三段骨架展开成人话（不动作、不开浏览器）。 */
async function appsExplain(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parseSimple(args, { json: { type: "boolean" }, help: { type: "boolean" } });
  if (parsed.values.help) {
    say(ctx, "用法：amber apps explain <脚本路径|应用 id> [--json]");
    return 0;
  }
  const target = parsed.positionals[0];
  if (!target) throw usageError("apps explain 需要一个脚本路径或应用 id", { next: ["amber apps list"] });
  if (parsed.positionals.length > 1) throw usageError("apps explain 只接受一个应用");
  const loaded = await loadScriptApp(target);
  const pack = loaded.pack;
  const invs = pack.invariants ?? [];
  const steps = pack.journey.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    const isTool = typeof e["source"] === "string";
    const targets = Array.isArray(e["target_hints"])
      ? (e["target_hints"] as string[])
      : typeof e["target_hint"] === "string" ? [e["target_hint"] as string] : [];
    const commands = Array.isArray(e["commands"]) ? (e["commands"] as unknown[]).length : 0;
    return {
      index: i + 1,
      kind: isTool ? "tool" : "browser",
      desc: String(e["desc"] ?? ""),
      start_url: typeof e["start_url"] === "string" ? e["start_url"] : undefined,
      source: isTool ? String(e["source"]) : undefined,
      targets, commands,
      done: renderSignal(e["signal"]),
      when: e["when"] === undefined ? undefined : renderSignal(e["when"]),
    };
  });
  if (jsonWanted(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("apps explain", {
      app: pack.id, goal: pack.goal, script: scriptDisplayPath(loaded.scriptPath),
      plan_sha256: loaded.planSha256,
      hosts: pack.hosts ?? [], sources: pack.sources ?? [],
      slots: pack.slots ?? {}, source_slots: (pack as unknown as Record<string, unknown>)["source_slots"] ?? {},
      steps,
      invariants: invs.map((inv) => ({ id: inv.id, desc: inv.desc, done: renderSignal(inv.signal) })),
    }, { next: [`amber run ${pack.id}`] }));
    return 0;
  }
  say(ctx, `${pack.id} — ${pack.goal}`);
  say(ctx, "");
  for (const st of steps) {
    const where = st.kind === "tool" ? `工具 ${st.source}` : st.start_url ? `页面 ${st.start_url}` : "当前页面";
    say(ctx, `${String(st.index).padStart(2, " ")}. [${st.kind}] ${st.desc}`);
    say(ctx, `     ${where}`);
    if (st.targets.length) say(ctx, `     目标（按序）：${st.targets.join(" → ")}`);
    if (st.commands) say(ctx, `     命令闭集：${st.commands} 条`);
    say(ctx, `     完成：${st.done}`);
    if (st.when) say(ctx, `     适用：${st.when}`);
  }
  if (invs.length) {
    say(ctx, "");
    say(ctx, "结束态不变量：");
    for (const inv of invs) say(ctx, `  - ${inv.id}${inv.desc ? `：${inv.desc}` : ""}`);
  }
  say(ctx, "");
  say(ctx, `脚本：${scriptDisplayPath(loaded.scriptPath)}  plan_sha256=${loaded.planSha256.slice(0, 16)}…`);
  return 0;
}

/** `amber apps emit <脚本> [--out]`：把脚本展开成 IR 快照（审计/交接用；默认不落盘）。 */
async function appsEmit(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parseSimple(args, {
    json: { type: "boolean" }, help: { type: "boolean" }, out: { type: "string" },
  });
  if (parsed.values.help) {
    say(ctx, "用法：amber apps emit <脚本路径> [--out <文件>] [--json]");
    return 0;
  }
  const target = parsed.positionals[0];
  if (!target) throw usageError("apps emit 需要一个脚本路径", { next: ["amber apps explain <脚本>"] });
  if (parsed.positionals.length > 1) throw usageError("apps emit 只接受一个脚本");
  const loaded = await loadScriptApp(target);
  const outPath = path.resolve(
    typeof parsed.values.out === "string" && parsed.values.out
      ? parsed.values.out
      : path.join(path.dirname(loaded.scriptPath), "pack.json"),
  );
  const pack: Record<string, unknown> = {
    ...(loaded.pack as unknown as Record<string, unknown>),
    generated_from: { source: `${loaded.scriptPath}#app`, plan_sha256: loaded.planSha256 },
  };
  const problems = validateApp(pack as never);
  if (problems.length) throw usageError(`展开结果不合法（不应发生；脚本已过校验）`, { hint: problems.join("；") });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(pack, null, 2) + "\n", "utf-8");
  if (jsonWanted(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("apps emit", {
      app: loaded.pack.id, script: scriptDisplayPath(loaded.scriptPath),
      out: outPath, plan_sha256: loaded.planSha256, script_sha256: loaded.scriptSha256,
    }, { next: [`amber apps check ${outPath}`] }));
  } else {
    say(ctx, `已展开：${outPath}`);
    say(ctx, `plan_sha256=${loaded.planSha256}`);
  }
  return 0;
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
