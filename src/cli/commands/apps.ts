import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { APPS_DIR, listPacks, loadPack, type AppPack } from "../../app/app-pack.ts";
import { isDeclarativeScriptSource, parseDeclarativeScript } from "../../app/declarative.ts";
import { validateApp } from "../../app/cross-ref.ts";
import {
  dryRunFlow, loadApp, loadScriptApp, resolveApp, resolveScriptPath, scriptDisplayPath,
  type LoadedScriptApp,
} from "../../app/app-script.ts";
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
  kind: "journey" | "measure" | "flow" | "unknown";
  error: string | null;
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function sourceOf(p: string, ctx: CliContext): "user" | "built-in" {
  return inside(path.resolve(p), path.resolve(userAppsDir(ctx.env))) ? "user" : "built-in";
}

/**
 * 同步读一个应用点位：`pack.json` 或**带标记的**声明式数据脚本。
 * 手写脚本返回 null——它是被发现的（列表里有它），只是同步列表拿不到步骤数；
 * 异步路径（show/check/run/explain）能读任意脚本。
 */
function readPackAt(p: string): AppPack | null {
  try {
    let pack: AppPack;
    if (p.endsWith(".json")) {
      pack = JSON.parse(fs.readFileSync(p, "utf-8")) as AppPack;
    } else {
      const src = fs.readFileSync(p, "utf-8");
      if (!isDeclarativeScriptSource(src)) return null;
      const parts = parseDeclarativeScript(src);
      pack = {
        ...(parts.meta as unknown as AppPack),
        journey: parts.journey,
      } as AppPack;
    }
    pack._path = p;
    return pack;
  } catch {
    return null;
  }
}

function infoOf(id: string, label: string, p: string, ctx: CliContext): AppInfo {
  const pack = readPackAt(p);
  if (!pack) {
    // 手写脚本：能发现、但不假装知道它的步骤数（异步 show/check 才读得了）。
    // 旧版这里对所有非 JSON 文件报 "pack.json 不是合法 JSON"——L3 之后每个应用都中招。
    return {
      id: path.basename(path.dirname(p)), label, path: p,
      source: sourceOf(p, ctx), steps: 0,
      // 非 JSON 的数据文件 = 手写脚本（同步列表读不了它的步骤；flow 的步骤本来就在运行期产生）。
      kind: p.endsWith(".json") ? "unknown" : "flow",
      error: p.endsWith(".json") ? "pack.json 不是合法 JSON" : null,
    };
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
  return kind === "journey" ? "旅程"
    : kind === "measure" ? "测量"
      : kind === "flow" ? "flow 脚本（运行期步骤）" : "未知";
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

/** `amber apps new <id>`：生成一个**可跑**的应用骨架（默认 flow；`--kind data` 生成声明式数据脚本）。 */
async function appsNew(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parseSimple(args, {
    json: { type: "boolean" }, help: { type: "boolean" },
    kind: { type: "string" }, dir: { type: "string" }, force: { type: "boolean" }, print: { type: "boolean" },
  });
  if (parsed.values.help) {
    say(ctx, "用法：amber apps new <id> [--kind flow|data] [--dir <目录>] [--force] [--print] [--json]");
    return 0;
  }
  const id = parsed.positionals[0];
  if (!id) throw usageError("apps new 需要一个应用 id", { next: ["amber apps new my-app"] });
  if (parsed.positionals.length > 1) throw usageError("apps new 只接受一个 id");
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw usageError(`应用 id ${JSON.stringify(id)} 不合法`, {
      hint: "小写字母开头，只含小写字母 / 数字 / 连字符（它同时是目录名与 `amber run` 的参数）。",
    });
  }
  const kind = typeof parsed.values.kind === "string" && parsed.values.kind ? parsed.values.kind : "flow";
  if (kind !== "flow" && kind !== "data") {
    throw usageError("--kind 只接受 flow | data", {
      hint: "flow = 运行期控制流（默认，适合有循环/条件/重试的流程）；"
        + "data = 声明式数据脚本（固定形状、工具链可同步读取）。",
    });
  }
  const dir = typeof parsed.values.dir === "string" && parsed.values.dir
    ? path.resolve(ctx.cwd, parsed.values.dir)
    : path.join(userAppsDir(ctx.env), id);
  const file = path.join(dir, "app.mjs");
  const source = kind === "data" ? dataScriptTemplate(id) : flowScriptTemplate(id);
  const next = [`amber apps check ${id}`, `amber apps explain ${id}`, `amber run ${id}`];
  if (parsed.values.print) {
    if (jsonWanted(ctx, parsed.values)) {
      emitJson(ctx, successEnvelope("apps new", { app: id, kind, path: file, source }, { next }));
    } else {
      say(ctx, source);
    }
    return 0;
  }
  if (fs.existsSync(file) && !parsed.values.force) {
    throw usageError(`已存在 ${file}`, {
      hint: "换一个 id，或加 --force 覆盖（旧的 app.mjs 会被替换）。",
      next: ["amber apps list"],
    });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, source, "utf-8");
  if (jsonWanted(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("apps new", { app: id, kind, path: file }, { next }));
  } else {
    say(ctx, `✓ 已生成 ${file}（${kind === "flow" ? "flow 脚本" : "声明式数据脚本"}）`);
    say(ctx, "  这是**可跑**的骨架（用仓库自带的 testpages/portal.html），先验证再改：");
    for (const n of next) say(ctx, `    ${n}`);
    say(ctx, "  改入口页 / 目标 / 完成条件见 docs/APP_SCRIPT_AUTHORING.md。");
  }
  return 0;
}

/** 生成 flow 骨架：普通 JS，循环/条件/重试直接写。 */
function flowScriptTemplate(id: string): string {
  return `/**
 * ${id} —— flow 应用：控制流写在脚本里（循环 / 条件 / 重试都是普通 JS）。
 *
 * 分工：脚本管走向；引擎管一步之内的一切（元素池 / 选元素 / 闸门 / 动作 / 证据判定）。
 * 脚本拿不到模型文本或分数，只能看到 { ok, stopCode, reason? }；完成只认 done 信号。
 */
export const meta = (kit) => ({
  id: ${JSON.stringify(id)},
  label: ${JSON.stringify(id)},
  goal: "把这条流程要达成的结果写清楚（一句话）",
  hosts: [],                          // 线上应用：声明允许访问的主机（导航信封 + 防泄漏门禁）
  slots: {},                          // 数据槽：值只能来自声明/观察（不写进 goal 文本）
  invariants: [                       // 结束态断言：用 ctx.done() 验收
    { id: "on-target", desc: "结束时确实到了目标页", signal: kit.judge.url("camera_a.html") },
  ],
});

export async function flow(ctx) {
  await ctx.open("testpages/portal.html");   // ← 你的入口页（仓库内相对路径或 http(s)://）

  const r = await ctx.step("点击「枪机 / 筒机 录入」", {   // ← 这一步做什么
    act: ctx.hint("[data-test=entry-fixed]"),              // ← 目标：ctx.hint / ctx.hints / ctx.command 闭集
    done: ctx.judge.url("camera_a.html"),                  // ← 完成条件（证据面；绝不猜）
  });
  if (!r.ok) throw new Error(\`第一步没完成：\${r.stopCode ?? "blocked"}\${r.reason ? \`（\${r.reason}）\` : ""}\`);

  // 运行期循环/重试示例（需要时打开）：
  // for (let attempt = 0; attempt < 3; attempt += 1) {
  //   const retry = await ctx.step("重试一次", { act: ctx.hint("button[type=submit]"), done: ctx.judge.url("next.html") });
  //   if (retry.ok) break;
  // }

  await ctx.done();   // 结束态不变量在这里验收；失败会抛 invariant_failed
}
`;
}

/** 生成声明式数据脚本骨架（固定形状 + 标记：`apps:matrix` / `apps:gen` 等工具能同步读取）。 */
function dataScriptTemplate(id: string): string {
  return `// @amberflow:declarative-data —— 声明式数据脚本（固定形状；想写循环/条件请用 --kind flow）
// 数据 + 旅程 + 验收三段，全部是 JSON 可表达的字面量；工具链（apps:matrix / apps:gen /
// apps:migrate）能同步读取与比对。手写这个形状时保持 "const META/DATA/JOURNEY = ..." 原样。
const META = {
  "id": ${JSON.stringify(id)},
  "label": ${JSON.stringify(id)},
  "goal": "把这条流程要达成的结果写清楚（一句话）",
  "hosts": [],
  "slots": {},
  "invariants": [
    { "id": "on-target", "desc": "结束时确实到了目标页", "signal": { "url_contains": "camera_a.html" } }
  ]
};
const DATA = {};
const JOURNEY = [
  {
    "desc": "点击「枪机 / 筒机 录入」",
    "start_url": "testpages/portal.html",
    "target_hint": "[data-test=entry-fixed]",
    "signal": { "url_contains": "camera_a.html" }
  }
];

export const meta = () => META;
export const app = () => ({ data: DATA, exec: JOURNEY });
`;
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
    case "new":
      return appsNew(rest, ctx);
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
        hint: "可用：list / new / show / check / explain / emit / path / remove",
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

async function appsShow(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parseSimple(args, { json: { type: "boolean" }, help: { type: "boolean" } });
  if (parsed.values.help) {
    say(ctx, "用法：amber apps show <应用|脚本路径> [--json]");
    return 0;
  }
  const id = parsed.positionals[0];
  if (!id) throw usageError("apps show 需要一个应用 id 或脚本路径", { next: ["amber apps list"] });
  if (parsed.positionals.length > 1) throw usageError("apps show 只接受一个应用");
  let resolved: Awaited<ReturnType<typeof resolveApp>>;
  try {
    resolved = await resolveApp(id);
  } catch (err) {
    throw usageError(`找不到应用 '${id}'`, {
      hint: err instanceof Error ? err.message : String(err),
      next: ["amber apps list"],
    });
  }
  const pack = resolved.pack;
  const script = resolved.script;
  const shownPath = script?.scriptPath ?? pack._path ?? id;
  if (jsonWanted(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("apps show", {
      app: pack.id, label: pack.label, goal: pack.goal, path: shownPath,
      source: sourceOf(shownPath, ctx),
      ...(script === null ? {} : {
        mode: script.mode, script: scriptDisplayPath(script.scriptPath), plan_sha256: script.planSha256,
      }),
      pack,
    }, {
      next: script === null
        ? [`amber run ${pack.id}`]
        : [`amber apps explain ${scriptDisplayPath(script.scriptPath)}`, `amber run ${pack.id}`],
    }));
    return 0;
  }
  if (script !== null) printShowScript(script, ctx);
  else printShow(ctx, pack);
  return 0;
}

/** `show` 对脚本应用的形态：声明面 + 路径 + 下一步（flow 的步骤在运行期，不假装有静态列表）。 */
function printShowScript(loaded: LoadedScriptApp, ctx: CliContext): void {
  const pack = loaded.pack;
  say(ctx, `${pack.id} — ${pack.label ?? ""}`.trim());
  say(ctx, `  目标：${pack.goal}`);
  say(ctx, `  形态：${loaded.mode === "flow" ? "flow 脚本（步骤在运行期产生）" : "声明式数据脚本"} · ${sourceLabel(sourceOf(loaded.scriptPath, ctx))}`);
  say(ctx, `  路径：${scriptDisplayPath(loaded.scriptPath)}`);
  say(ctx, `  plan_sha256：${loaded.planSha256.slice(0, 16)}…`);
  if (pack.hosts?.length) say(ctx, `  hosts：${pack.hosts.join(", ")}`);
  if (pack.slots && Object.keys(pack.slots).length) say(ctx, `  参数：${Object.keys(pack.slots).join(", ")}`);
  if (pack.journey?.length) {
    say(ctx, "  步骤：");
    for (const [i, step] of pack.journey.entries()) {
      const kind = step.source !== undefined ? "工具" : "浏览器";
      say(ctx, `    [${i + 1}]  ${kind}  ${String(step.desc ?? step.role ?? "")}`);
    }
  } else {
    say(ctx, "  步骤：运行期产生（flow）——用 `amber apps explain` 看 dry 调用序列");
  }
  if (pack.invariants?.length) {
    say(ctx, `  验收条件（${pack.invariants.length}）：`);
    for (const inv of pack.invariants) say(ctx, `    - ${inv.id}: ${inv.desc ?? ""}`);
  }
  say(ctx, `  下一步：amber apps explain ${scriptDisplayPath(loaded.scriptPath)}`);
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
      const resolved = await resolveApp(t.path ?? t.id);
      const pack = resolved.pack;
      const problems = validateApp(pack, resolved.script?.mode === "flow" ? { allowEmptyJourney: true } : {});
      if (resolved.script !== null && resolved.script.mode === "flow") {
        const dry = await dryRunFlow(resolved.script);
        problems.push(...dry.problems);
      }
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
  const resolved = await resolveApp(target);
  const pack = resolved.pack;
  const loaded = resolved.script ?? (await loadScriptApp(target));
  const invs = pack.invariants ?? [];
  if (loaded.mode === "flow") {
    // L2：步骤在运行期产生——explain 就是"dry 跑一遍，把调用序列渲染成人话"。
    const dry = await dryRunFlow(loaded);
    const rows = dry.trace.events.map((ev) => ({
      i: ev.i, call: ev.call, desc: ev.desc, url: ev.url,
      ok: ev.ok === undefined ? null : ev.ok,
      ...(ev.stop_code === undefined ? {} : { stop_code: ev.stop_code }),
    }));
    if (jsonWanted(ctx, parsed.values)) {
      emitJson(ctx, successEnvelope("apps explain", {
        app: pack.id, goal: pack.goal, script: scriptDisplayPath(loaded.scriptPath),
        mode: "flow", plan_sha256: loaded.planSha256, problems: dry.problems, events: rows,
        invariants: invs.map((inv) => ({ id: inv.id, desc: inv.desc, done: renderSignal(inv.signal) })),
      }, { exitCode: dry.problems.length ? 2 : 0, next: dry.problems.length ? ["amber apps check <脚本>"] : [`amber run ${pack.id}`] }));
      return dry.problems.length ? 2 : 0;
    }
    say(ctx, `${pack.id} — ${pack.goal}（flow 脚本：dry 调用序列）`);
    say(ctx, "");
    for (const ev of rows) {
      const head = `${String(ev.i).padStart(2, " ")}. [${ev.call}] ${ev.desc ?? ""}`;
      const where = ev.url === undefined || ev.url === "about:blank" ? "（当前页）" : ev.url;
      say(ctx, `${head} → ${where}${ev.ok === false ? `  ✗ ${ev.stop_code ?? "failed"}` : ""}`);
    }
    if (invs.length) {
      say(ctx, "");
      say(ctx, "结束态不变量：");
      for (const inv of invs) say(ctx, `  - ${inv.id}${inv.desc ? `：${inv.desc}` : ""}`);
    }
    if (dry.problems.length) {
      say(ctx, "");
      for (const p of dry.problems) say(ctx, `✗ ${p}`);
    }
    say(ctx, "");
    say(ctx, `脚本：${scriptDisplayPath(loaded.scriptPath)}  plan_sha256=${loaded.planSha256.slice(0, 16)}…`);
    return dry.problems.length ? 2 : 0;
  }
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
    say(ctx, "用法：amber apps emit <声明式脚本> [--out <文件>] [--json]（flow 脚本没有静态 IR）");
    return 0;
  }
  const target = parsed.positionals[0];
  if (!target) throw usageError("apps emit 需要一个脚本路径", { next: ["amber apps explain <脚本>"] });
  if (parsed.positionals.length > 1) throw usageError("apps emit 只接受一个脚本");
  let loaded: LoadedScriptApp;
  try {
    const resolved = await resolveApp(target);
    loaded = resolved.script ?? (await loadScriptApp(target));
  } catch (err) {
    throw usageError(`找不到脚本 '${target}'`, { hint: err instanceof Error ? err.message : String(err) });
  }
  if (loaded.mode === "flow") {
    // flow 没有静态 IR：强 emit 要么是假的空 journey，要么是"不应发生"的内部错误——两者都在骗人。
    throw usageError("apps emit 不支持 flow 脚本：步骤在运行期产生，没有静态 IR", {
      hint: "用 amber apps explain <脚本> 看 dry 调用序列；声明式（数据）脚本才可 emit。",
      next: [`amber apps explain ${scriptDisplayPath(loaded.scriptPath)}`],
    });
  }
  const outPath = path.resolve(
    typeof parsed.values.out === "string" && parsed.values.out
      ? parsed.values.out
      : path.join(ctx.cwd, ".amberflow", "emit", `${loaded.pack.id}.json`),
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

async function appsPath(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parseSimple(args, { json: { type: "boolean" }, help: { type: "boolean" } });
  if (parsed.values.help) {
    say(ctx, "用法：amber apps path <应用>");
    return 0;
  }
  const id = parsed.positionals[0];
  if (!id) throw usageError("apps path 需要一个应用 id", { next: ["amber apps list"] });
  if (parsed.positionals.length > 1) throw usageError("apps path 只接受一个应用");
  let resolved: Awaited<ReturnType<typeof resolveApp>>;
  try {
    resolved = await resolveApp(id);
  } catch (err) {
    throw usageError(`找不到应用 '${id}'`, {
      hint: err instanceof Error ? err.message : String(err),
      next: ["amber apps list"],
    });
  }
  const p = resolved.script?.scriptPath ?? resolved.pack._path ?? id;
  if (jsonWanted(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("apps path", {
      app: resolved.pack.id, path: p,
      ...(resolved.script === null ? {} : { mode: resolved.script.mode }),
    }));
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
  let resolved: Awaited<ReturnType<typeof resolveApp>>;
  try {
    resolved = await resolveApp(id);
  } catch (err) {
    throw usageError(`找不到应用 '${id}'`, {
      hint: err instanceof Error ? err.message : String(err),
      next: ["amber apps list"],
    });
  }
  const pack = resolved.pack;
  const packPath = path.resolve(resolved.script?.scriptPath ?? pack._path ?? "");
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
