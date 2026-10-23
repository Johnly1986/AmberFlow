import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { PlanningRules, TaskPlan, type Subgoal } from "../../engine/plan.ts";
import type { SignalSpec } from "../../engine/signals.ts";
import { cmdNew, parseSignal, type CliIO } from "../plan-cli.ts";
import type { CliContext } from "../context.ts";
import { say, emitJson } from "../context.ts";
import { usageError, usageFromParseError } from "../errors.ts";
import { successEnvelope } from "../json.ts";
import { emitPlanStatus } from "../plan-result.ts";
import { normalizeAliases, stringValue } from "../args.ts";

export const DEFAULT_PLAN = "./.amberflow/plan.json";

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

/** 旧 plan-cli 的 `--file` / `--hint` 只在这一层转换；run 的 `--plan` 语义不混进来。 */
function normalizePlanArgs(args: readonly string[]): string[] {
  // 旧 `plan-cli new --file` 是输出位置；其它子命令的 `--file` 是输入计划。
  const fileFlag = args[0] === "new" ? "--save-plan" : "--plan";
  return normalizeAliases(args).map((a) => {
    if (a === "--file") return fileFlag;
    if (a.startsWith("--file=")) return `${fileFlag}=${a.slice("--file=".length)}`;
    if (a === "--hint") return "--target";
    if (a.startsWith("--hint=")) return `--target=${a.slice("--hint=".length)}`;
    return a;
  });
}

function loadPlan(file: string): TaskPlan {
  const plan = TaskPlan.load(file);
  if (!plan) throw usageError(`没有找到计划：${file}`, {
    hint: "先用 amber plan new 创建，或检查 --plan 路径。",
    next: ['amber plan new "目标"'],
  });
  return plan;
}

function parseMax(raw: unknown): number {
  const n = Number(stringValue(raw) ?? 8);
  if (!Number.isInteger(n) || n < 1) throw usageError("--max 需要正整数");
  return n;
}

function slug(desc: string): string {
  const s = desc.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return s || "step";
}

function hash6(desc: string): string {
  return createHash("sha1").update(desc).digest("hex").slice(0, 6);
}

function assignId(plan: TaskPlan, desc: string): string {
  const base = `${slug(desc)}-${hash6(desc)}`;
  const used = new Set(plan.subgoals.map((s) => s.id).filter((x): x is string => typeof x === "string"));
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("无法生成唯一步骤 id");
}

function refIndex(plan: TaskPlan, ref: string | undefined, what: string): number {
  if (ref === undefined || ref === "") throw usageError(`${what} 需要一个编号或步骤 id`);
  const byId = plan.subgoals.findIndex((s) => s.id === ref);
  if (byId >= 0) return byId;
  const n = Number(ref);
  if (Number.isInteger(n) && n >= 1 && n <= plan.subgoals.length) return n - 1;
  throw usageError(`${what} 引用的步骤不存在：${JSON.stringify(ref)}`, {
    hint: "新 CLI 的编号从 1 开始；也可以直接用步骤 id。",
    next: ["amber plan show"],
  });
}

function signalFrom(v: Record<string, string | boolean | undefined>, required: boolean, cwd: string): SignalSpec | null {
  const raw = typeof v.signal === "string" ? v.signal : undefined;
  const file = typeof v["signal-file"] === "string" ? v["signal-file"] : undefined;
  if (raw && file) throw usageError("--signal 与 --signal-file 只能给一个");
  if (file) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.resolve(cwd, file), "utf-8"));
    } catch (err) {
      throw usageError(`--signal-file 读不了：${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw usageError("--signal-file 顶层必须是信号对象");
    }
    return parsed as SignalSpec;
  }
  if (raw) {
    try {
      return parseSignal(raw);
    } catch (err) {
      throw usageError(err instanceof Error ? err.message : String(err));
    }
  }
  if (required) throw usageError("缺少 --signal（或 --signal-file）");
  return null;
}

function defaultStartUrl(plan: TaskPlan): string | null {
  const fromStep = plan.subgoals.find((s) => typeof s.start_url === "string" && s.start_url !== "")?.start_url;
  if (fromStep) return fromStep;
  const fromPlan = plan.slots.start_url;
  return typeof fromPlan === "string" && fromPlan !== "" ? fromPlan : null;
}

function stepJson(plan: TaskPlan, i: number): Record<string, unknown> {
  const s = plan.subgoals[i]!;
  return {
    index: i + 1,
    id: s.id ?? null,
    desc: s.desc,
    signal: s.signal,
    start_url: s.start_url ?? null,
    target_hint: s.target_hint ?? null,
    status: s.status,
    obstacle: s.obstacle ?? null,
  };
}

function printPlan(ctx: CliContext, plan: TaskPlan, file: string): void {
  say(ctx, `goal: ${plan.goal}`);
  say(ctx, `文件：${file}`);
  if (!plan.subgoals.length) {
    say(ctx, "（还没有步骤）");
    return;
  }
  plan.subgoals.forEach((s, i) => {
    say(ctx, `[${i + 1}]${s.id ? ` id=${s.id}` : ""}  ${String(s.status).padEnd(8)} ${s.desc}`);
    say(ctx, `     signal=${JSON.stringify(s.signal)}  start_url=${s.start_url ?? null}`
      + (s.target_hint ? `  target_hint=${s.target_hint}` : "")
      + (s.obstacle ? `  obstacle=${s.obstacle}` : ""));
  });
}

export async function runPlan(args: string[], ctx: CliContext): Promise<number> {
  const normalized = normalizePlanArgs(args);
  const sub = normalized[0];
  const rest = normalized.slice(1);
  if (sub === undefined || sub === "--help" || sub === "-h") {
    if (sub === "--help" || sub === "-h") {
      const { commandHelp } = await import("../registry.ts");
      say(ctx, commandHelp("plan"));
      return 0;
    }
    throw usageError("plan 需要一个子命令", {
      hint: "可用：new / show / add / edit / rm / move / check / reset / run",
      next: ["amber plan --help"],
    });
  }
  switch (sub) {
    case "new": return planNew(rest, ctx);
    case "show": return planShow(rest, ctx);
    case "add": return planAdd(rest, ctx);
    case "edit": return planEdit(rest, ctx);
    case "rm":
    case "del": return planRm(rest, ctx);
    case "move": return planMove(rest, ctx);
    case "check": return planCheck(rest, ctx);
    case "reset": return planReset(rest, ctx);
    case "run": return planRun(rest, ctx);
    default:
      throw usageError(`未知的 plan 子命令 '${sub}'`, {
        hint: "可用：new / show / add / edit / rm / move / check / reset / run",
        next: ["amber plan --help"],
      });
  }
}

async function planNew(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parse(args, {
    url: { type: "string" }, llm: { type: "boolean" }, max: { type: "string" },
    "save-plan": { type: "string" }, plan: { type: "string" },
    json: { type: "boolean" }, help: { type: "boolean" },
  });
  if (parsed.values.help) {
    say(ctx, '用法：amber plan new "<目标>" [--url <页面>] [--llm] [--max <N>] [--save-plan <文件>]');
    return 0;
  }
  if (parsed.values.plan) {
    throw usageError("plan new 生成计划请用 --save-plan；--plan 只表示输入计划");
  }
  const goal = parsed.positionals[0];
  if (!goal) throw usageError("plan new 需要一个目标描述", { next: ['amber plan new "把商品加入购物车"'] });
  const displayFile = stringValue(parsed.values["save-plan"]) ?? DEFAULT_PLAN;
  // main() 允许测试注入 cwd；cmdNew/save 用的是进程 cwd，所以这里先锚定到 ctx.cwd。
  const file = path.resolve(ctx.cwd, displayFile);
  const max = parseMax(parsed.values.max);

  const buffer: string[] = [];
  const io: CliIO = {
    out: (line) => buffer.push(line),
    ask: async () => false,
  };
  let plan: TaskPlan;
  const url = stringValue(parsed.values.url);
  try {
    plan = await cmdNew({
      goal, file, llm: Boolean(parsed.values.llm),
      url: url ?? null, max,
    }, io);
  } catch (err) {
    throw usageError(err instanceof Error ? err.message : String(err));
  }
  // 手写骨架没有步骤时也要记住入口页，后续 `plan add` 才能继承 start_url。
  if (url) {
    plan.slots.start_url = url;
    plan.save();
  }
  // 新入口统一 1-based 展示；生成器写盘格式不变。
  if (wantsJson(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("plan new", {
      goal: plan.goal, path: displayFile, steps: plan.subgoals.map((_, i) => stepJson(plan, i)),
    }, { next: ["amber plan show", "amber plan add <描述> --signal ..."] }));
  } else {
    say(ctx, `✓ 已创建计划：${displayFile}`);
    say(ctx, `  ${plan.goal}`);
    if (!plan.subgoals.length) say(ctx, "  下一步：amber plan add \"第一个步骤\" --signal url_contains=...");
    else say(ctx, `  ${plan.subgoals.length} 个步骤`);
  }
  return 0;
}

function planShow(args: string[], ctx: CliContext): number {
  const parsed = parse(args, { plan: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" } });
  if (parsed.values.help) {
    say(ctx, "用法：amber plan show [--plan <文件>]");
    return 0;
  }
  const file = path.resolve(ctx.cwd, stringValue(parsed.values.plan) ?? DEFAULT_PLAN);
  const plan = loadPlan(file);
  if (wantsJson(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("plan show", {
      goal: plan.goal, path: file, slots: plan.slots, steps: plan.subgoals.map((_, i) => stepJson(plan, i)),
    }, { next: ["amber plan add <描述> --signal ...", "amber plan run"] }));
  } else {
    printPlan(ctx, plan, file);
  }
  return 0;
}

function planAdd(args: string[], ctx: CliContext): number {
  const parsed = parse(args, {
    signal: { type: "string" }, "signal-file": { type: "string" },
    url: { type: "string" }, target: { type: "string" }, at: { type: "string" },
    plan: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" },
  });
  if (parsed.values.help) {
    say(ctx, '用法：amber plan add "<描述>" (--signal <op=value> | --signal-file <json>) [--url <页面>] [--target <hint>] [--at <编号|id>] [--plan <文件>]');
    return 0;
  }
  const desc = parsed.positionals[0];
  if (!desc) throw usageError("plan add 需要一个步骤描述");
  const file = path.resolve(ctx.cwd, stringValue(parsed.values.plan) ?? DEFAULT_PLAN);
  const plan = loadPlan(file);
  const signal = signalFrom(parsed.values, true, ctx.cwd)!;
  let at = plan.subgoals.length;
  const atRaw = stringValue(parsed.values.at);
  if (atRaw !== undefined) {
    const n = Number(atRaw);
    if (Number.isInteger(n)) {
      if (n < 1 || n > plan.subgoals.length + 1) {
        throw usageError(`--at 越界：${n}（当前 ${plan.subgoals.length} 步，可插 1..${plan.subgoals.length + 1}）`);
      }
      at = n - 1;
    } else {
      at = refIndex(plan, atRaw, "--at");
    }
  }
  plan.insert(at, desc, signal, stringValue(parsed.values.url) ?? defaultStartUrl(plan),
    stringValue(parsed.values.target) ?? null, null, null, null, null, null, {
      id: assignId(plan, desc),
    });
  plan.save();
  if (wantsJson(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("plan add", stepJson(plan, at), { next: ["amber plan check", "amber plan show"] }));
  } else {
    say(ctx, `✓ 已插入 [${at + 1}] ${desc}（id=${plan.subgoals[at]!.id}）`);
  }
  return 0;
}

function planEdit(args: string[], ctx: CliContext): number {
  const parsed = parse(args, {
    desc: { type: "string" }, signal: { type: "string" }, "signal-file": { type: "string" },
    url: { type: "string" }, target: { type: "string" },
    plan: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" },
  });
  if (parsed.values.help) {
    say(ctx, "用法：amber plan edit <编号|id> [--desc ...] [--signal ... | --signal-file ...] [--url ...] [--target ...] [--plan <文件>]");
    return 0;
  }
  const ref = parsed.positionals[0];
  const file = path.resolve(ctx.cwd, stringValue(parsed.values.plan) ?? DEFAULT_PLAN);
  const plan = loadPlan(file);
  const idx = refIndex(plan, ref, "plan edit");
  const signal = signalFrom(parsed.values, false, ctx.cwd);
  const desc = stringValue(parsed.values.desc);
  const url = stringValue(parsed.values.url);
  const target = stringValue(parsed.values.target);
  if (desc === undefined && signal === null && url === undefined && target === undefined) {
    throw usageError("plan edit 至少给一个字段：--desc / --signal / --signal-file / --url / --target");
  }
  const patch: Partial<Subgoal> = {};
  if (desc !== undefined) patch.desc = desc;
  if (signal !== null) patch.signal = signal;
  if (url !== undefined) patch.start_url = url;
  if (target !== undefined) patch.target_hint = target;
  if (!plan.subgoals[idx]!.id) patch.id = assignId(plan, patch.desc ?? plan.subgoals[idx]!.desc);
  plan.update(idx, patch);
  plan.save();
  if (wantsJson(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("plan edit", stepJson(plan, idx), { next: ["amber plan check", "amber plan show"] }));
  } else {
    say(ctx, `✓ 已更新 [${idx + 1}] ${plan.subgoals[idx]!.desc}`);
  }
  return 0;
}

function planRm(args: string[], ctx: CliContext): number {
  const parsed = parse(args, { plan: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" } });
  if (parsed.values.help) {
    say(ctx, "用法：amber plan rm <编号|id> [--plan <文件>]");
    return 0;
  }
  const file = path.resolve(ctx.cwd, stringValue(parsed.values.plan) ?? DEFAULT_PLAN);
  const plan = loadPlan(file);
  const idx = refIndex(plan, parsed.positionals[0], "plan rm");
  const [removed] = plan.subgoals.splice(idx, 1);
  plan.save();
  if (wantsJson(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("plan rm", { index: idx + 1, removed: removed?.desc ?? null },
      { next: ["amber plan show"] }));
  } else {
    say(ctx, `✓ 已删除 [${idx + 1}] ${removed?.desc ?? ""}`);
  }
  return 0;
}

function planMove(args: string[], ctx: CliContext): number {
  const parsed = parse(args, {
    to: { type: "string" }, plan: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" },
  });
  if (parsed.values.help) {
    say(ctx, "用法：amber plan move <编号|id> --to <位置> [--plan <文件>]");
    return 0;
  }
  const file = path.resolve(ctx.cwd, stringValue(parsed.values.plan) ?? DEFAULT_PLAN);
  const plan = loadPlan(file);
  const idx = refIndex(plan, parsed.positionals[0], "plan move");
  const toRaw = stringValue(parsed.values.to);
  if (toRaw === undefined) throw usageError("plan move 需要 --to <位置>");
  const toNum = Number(toRaw);
  if (!Number.isInteger(toNum) || toNum < 1 || toNum > plan.subgoals.length) {
    throw usageError(`--to 越界：${toRaw}（当前 ${plan.subgoals.length} 步，目标 1..${plan.subgoals.length}）`);
  }
  plan.move(idx, toNum - 1);
  plan.save();
  if (wantsJson(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("plan move", { from: idx + 1, to: toNum }, { next: ["amber plan show"] }));
  } else {
    say(ctx, `✓ 已把 [${idx + 1}] 移到 [${toNum}]`);
  }
  return 0;
}

function planCheck(args: string[], ctx: CliContext): number {
  const parsed = parse(args, {
    plan: { type: "string" }, max: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" },
  });
  if (parsed.values.help) {
    say(ctx, "用法：amber plan check [--plan <文件>] [--max <N>]");
    return 0;
  }
  const file = path.resolve(ctx.cwd, stringValue(parsed.values.plan) ?? DEFAULT_PLAN);
  const plan = loadPlan(file);
  const max = parseMax(parsed.values.max);
  const issues = new PlanningRules(max).problems(plan);
  const code = issues.length ? 2 : 0;
  if (wantsJson(ctx, parsed.values)) {
    const envelope = successEnvelope("plan check", {
      path: file, steps: plan.subgoals.length, ok: issues.length === 0, problems: issues,
    }, { exitCode: code, next: issues.length ? ["amber plan show"] : ["amber plan run"] });
    if (issues.length) {
      envelope.ok = false;
      envelope.error = {
        code: "USAGE",
        message: `计划未通过校验（${issues.length} 项）`,
        hint: "按 problems 修正计划；plan check 本身不启动浏览器。",
        next: ["amber plan show"],
      };
    }
    emitJson(ctx, envelope);
  } else if (issues.length) {
    say(ctx, "INVALID:");
    for (const issue of issues) say(ctx, `  - ${issue}`);
  } else {
    say(ctx, `OK: ${plan.subgoals.length} 个步骤通过计划规则`);
  }
  return code;
}

function planReset(args: string[], ctx: CliContext): number {
  const parsed = parse(args, { plan: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" } });
  if (parsed.values.help) {
    say(ctx, "用法：amber plan reset [--plan <文件>]");
    return 0;
  }
  const file = path.resolve(ctx.cwd, stringValue(parsed.values.plan) ?? DEFAULT_PLAN);
  const plan = loadPlan(file);
  for (const s of plan.subgoals) {
    s.status = "pending";
    s.obstacle = null;
  }
  plan.save();
  if (wantsJson(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("plan reset", { path: file, steps: plan.subgoals.length }, { next: ["amber plan run"] }));
  } else {
    say(ctx, `✓ 已重置 ${plan.subgoals.length} 个步骤为 pending`);
  }
  return 0;
}

async function planRun(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parse(args, {
    plan: { type: "string" }, max: { type: "string" },
    reset: { type: "boolean" }, replan: { type: "boolean" },
    confirm: { type: "string" }, "learn-hints": { type: "boolean" },
    "hint-memory": { type: "string" }, remember: { type: "boolean" },
    memory: { type: "string" }, headful: { type: "boolean" },
    json: { type: "boolean" }, help: { type: "boolean" },
  });
  if (parsed.values.help) {
    say(ctx, "用法：amber plan run [--plan <文件>] [--reset] [--replan] [--confirm allow|ask|deny]");
    return 0;
  }
  const confirm = stringValue(parsed.values.confirm)
    ?? (ctx.globals.yes ? "allow" : ctx.isTTY ? undefined : "deny");
  if (confirm && !["allow", "ask", "deny"].includes(confirm)) {
    throw usageError("--confirm 只能是 allow / ask / deny");
  }
  if (confirm === "ask" && !ctx.isTTY) {
    throw usageError("非 TTY 不能用 --confirm ask", {
      hint: "非交互环境请显式给 allow 或 deny。",
      next: ["amber plan run --confirm deny", "amber plan run --yes"],
    });
  }
  const file = path.resolve(ctx.cwd, stringValue(parsed.values.plan) ?? DEFAULT_PLAN);
  // 先做父进程预检：缺计划 / 明显不合规时走统一错误，避免旧入口把堆栈混进 stdout。
  const plan = loadPlan(file);
  const max = String(parseMax(parsed.values.max));
  const problems = new PlanningRules(Number(max)).problems(plan);
  if (problems.length) {
    throw usageError(`计划未通过校验：${problems.join("; ")}`, {
      hint: "先运行 amber plan check 定位。",
      next: ["amber plan check", "amber plan show"],
    });
  }
  if (!plan.subgoals.some((s) => typeof s.start_url === "string" && s.start_url !== "")) {
    throw usageError("计划没有 start_url，执行器不知道从哪一页开始", {
      hint: "给步骤补 --url，或在 plan new 时带 --url。",
      next: ["amber plan edit <编号|id> --url <页面>", "amber plan check"],
    });
  }
  const remember = Boolean(parsed.values.remember || parsed.values["learn-hints"]);
  const memory = stringValue(parsed.values.memory) ?? stringValue(parsed.values["hint-memory"]);
  const argv = ["run", "--file", file];
  if (parsed.values.reset) argv.push("--reset");
  if (parsed.values.replan) argv.push("--replan");
  if (confirm) argv.push("--confirm", confirm);
  if (remember) argv.push("--learn-hints");
  if (memory) argv.push("--hint-memory", memory);
  if (parsed.values.headful) argv.push("--headful");
  if (max) argv.push("--max", max);
  if (!wantsJson(ctx, parsed.values)) {
    return ctx.runEntry("tools/plan_cli.ts", argv, { cwd: ctx.cwd, env: ctx.env });
  }
  const code = await ctx.runEntry("tools/plan_cli.ts", argv, {
    cwd: ctx.cwd,
    env: ctx.env,
    stdoutToStderr: true,
  });
  return emitPlanStatus(ctx, {
    file,
    pathLabel: stringValue(parsed.values.plan) ?? DEFAULT_PLAN,
    mode: "plan",
    command: "plan run",
    code,
  });
}
