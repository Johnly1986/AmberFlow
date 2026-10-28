import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { CliContext } from "../context.ts";
import { say, emitJson } from "../context.ts";
import { usageError, usageFromParseError } from "../errors.ts";
import { successEnvelope } from "../json.ts";
import { emitPlanStatus } from "../plan-result.ts";
import { flatList, injectOptionalValue, normalizeAliases, parseSlots } from "../args.ts";
import { toAgentRunView } from "../../app/agent-view.ts";
import type { AppRunResult } from "../../app/app-runner.ts";

export const DEFAULT_PLAN = "./.amberflow/plan.json";

type Values = Record<string, string | boolean | string[] | undefined>;

const OPTIONS = {
  plan: { type: "string" as const },
  "save-plan": { type: "string" as const },
  goal: { type: "string" as const },
  url: { type: "string" as const },
  "dry-run": { type: "boolean" as const },
  headful: { type: "boolean" as const },
  headless: { type: "boolean" as const },
  out: { type: "string" as const },
  slot: { type: "string" as const, multiple: true },
  provider: { type: "string" as const },
  "skip-data": { type: "boolean" as const },
  "allow-dangerous": { type: "boolean" as const },
  "confirm-safe": { type: "boolean" as const },
  "manual-fail-fast": { type: "boolean" as const },
  "emit-trace": { type: "string" as const },
  replay: { type: "string" as const },
  remember: { type: "boolean" as const },
  memory: { type: "string" as const },
  reset: { type: "boolean" as const },
  replan: { type: "boolean" as const },
  confirm: { type: "string" as const },
  target: { type: "string" as const },
  max: { type: "string" as const },
  "min-confidence": { type: "string" as const },
  "tiered-hint": { type: "boolean" as const },
  trace: { type: "boolean" as const },
  "max-steps": { type: "string" as const },
  ablate: { type: "string" as const },
  json: { type: "boolean" as const },
  quiet: { type: "boolean" as const },
  verbose: { type: "boolean" as const },
  timeout: { type: "string" as const },
  help: { type: "boolean" as const },
};

function str(v: string | boolean | string[] | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function bool(v: string | boolean | string[] | undefined): boolean {
  return v === true;
}

function maxSteps(v: Values): number {
  const n = Number(str(v.max) ?? 8);
  if (!Number.isInteger(n) || n < 1) throw usageError("--max 需要正整数");
  return n;
}

export async function runRun(args: string[], ctx: CliContext): Promise<number> {
  const normalized = normalizeAliases(args);
  if (normalized.includes("--help") || normalized.includes("-h")) {
    const { commandHelp } = await import("../registry.ts");
    say(ctx, commandHelp("run"));
    return 0;
  }
  const planGiven = normalized.some((a) => a === "--plan" || a.startsWith("--plan="));
  const withPlan = injectOptionalValue(normalized, "--plan", DEFAULT_PLAN);

  let parsed;
  try {
    parsed = parseArgs({ args: withPlan, allowPositionals: true, options: OPTIONS });
  } catch (err) {
    throw usageFromParseError(err);
  }
  const v = parsed.values as Values;
  const positional = parsed.positionals;
  if (positional.length > 1) {
    throw usageError(`run 最多接受一个应用名（收到 ${positional.length} 个）`, {
      hint: "模式只能选一个：应用 / --plan / --goal。",
      next: ["amber run --help"],
    });
  }

  const app = positional[0];
  const goal = str(v.goal);
  const url = str(v.url);
  const savePlan = str(v["save-plan"]);
  const headful = bool(v.headful);
  const headless = bool(v.headless);
  const planFile = planGiven ? str(v.plan) ?? DEFAULT_PLAN : null;

  if (headful && headless) {
    throw usageError("--headful 与 --headless 只能选一个");
  }
  if ((goal || url) && app) {
    throw usageError("应用名与 --goal 只能二选一", { hint: "要跑应用包用 amber run <id>；要一次性任务用 --goal + --url。" });
  }
  if (planGiven && (app || goal || url)) {
    throw usageError("--plan 不能与应用 / --goal 同用");
  }
  if (goal && !url) {
    throw usageError("--goal 需要同时给 --url", {
      next: ['amber run --goal "把商品加入购物车" --url https://shop.example.com/p/1'],
    });
  }
  if (url && !goal) {
    throw usageError("--url 需要同时给 --goal");
  }
  if (savePlan && planGiven) {
    throw usageError("--save-plan 只用于 --goal；--plan 是输入文件");
  }
  if (savePlan && app) {
    throw usageError("--save-plan 只用于 --goal，不用于应用包");
  }

  const mode = planGiven ? "plan" : goal ? "goal" : app ? "app" : "pick";
  if (mode === "app" || mode === "pick") {
    validateAppFlags(v, mode);
  } else if (mode === "plan") {
    validatePlanFlags(v);
  } else {
    validateGoalFlags(v);
  }

  if (mode === "pick") {
    return runPick(args, ctx);
  }
  if (mode === "plan") {
    return runPlanFile({ ...v, planPath: planFile ?? DEFAULT_PLAN }, ctx);
  }
  if (mode === "goal") {
    return runGoal(v, goal!, url!, savePlan ?? DEFAULT_PLAN, headful, ctx);
  }
  return runApp(app!, v, headful, ctx);
}

function validateAppFlags(v: Values, mode: "app" | "pick"): void {
  if (str(v["save-plan"])) throw usageError("--save-plan 只用于 --goal");
  if (bool(v.reset) || bool(v.replan) || str(v.confirm)) {
    throw usageError("--reset / --replan / --confirm 只用于 --plan 模式", {
      hint: mode === "pick" ? "选定应用后不支持计划状态旗标。" : undefined,
    });
  }
  if (str(v.target)) throw usageError("--target 只用于 --goal 模式");
}

function validatePlanFlags(v: Values): void {
  if (str(v["save-plan"])) throw usageError("--save-plan 只用于 --goal");
  if (str(v["max-steps"])) throw usageError("--max-steps 只用于应用运行（计划用 --max）");
  if (bool(v["confirm-safe"]) || bool(v["manual-fail-fast"])) throw usageError("--confirm-safe / --manual-fail-fast 只用于应用运行");
  if (bool(v["skip-data"])) throw usageError("--skip-data 只用于应用运行");
  if (bool(v["allow-dangerous"])) throw usageError("--allow-dangerous 只用于应用运行 / 一次性目标");
  if (str(v.out)) throw usageError("--out 暂不用于 --plan 模式", { hint: "计划执行器把结果写到计划同目录；--out 留给应用运行。" });
  if (str(v.slot) || Array.isArray(v.slot)) throw usageError("--slot 只用于应用运行");
  if (str(v.target)) throw usageError("--target 只用于 --goal 模式");
  if (bool(v.remember) || str(v.memory)) {
    // plan-cli 有旧名 --learn-hints / --hint-memory，分别映射到 sidecar。
  }
  const confirm = str(v.confirm);
  if (confirm && !["allow", "ask", "deny"].includes(confirm)) {
    throw usageError(`--confirm 只能是 allow / ask / deny（收到 ${JSON.stringify(confirm)}）`);
  }
}

function validateGoalFlags(v: Values): void {
  if (str(v["max-steps"])) throw usageError("--max-steps 只用于应用运行");
  if (bool(v["confirm-safe"]) || bool(v["manual-fail-fast"])) throw usageError("--confirm-safe / --manual-fail-fast 只用于应用运行");
  if (bool(v["skip-data"])) throw usageError("--skip-data 只用于应用运行");
  if (bool(v["allow-dangerous"])) throw usageError("--allow-dangerous 只用于应用包");
  if (bool(v.remember) || str(v.memory)) throw usageError("--remember / --memory 只用于应用包 / --plan");
  if (bool(v.reset) || bool(v.replan) || str(v.confirm)) {
    throw usageError("--reset / --replan / --confirm 只用于 --plan 模式");
  }
  if (str(v.out)) throw usageError("--out 只用于应用运行");
  if (str(v.slot) || Array.isArray(v.slot)) throw usageError("--slot 只用于应用运行");
}



async function runApp(app: string, v: Values, headful: boolean, ctx: CliContext): Promise<number> {
  // 槽位拼写（`--slot city` 少了 `=值`）必须在起浏览器之前点名：旧入口只会在
  // 展开包时报一句看不懂的话，而这一步根本不需要任何外部依赖。
  let slots: Record<string, string>;
  try {
    slots = parseSlots(v.slot as string[] | undefined);
  } catch (err) {
    throw usageError(err instanceof Error ? err.message : String(err));
  }
  if (bool(v["dry-run"]) && (bool(v.json) || ctx.globals.json)) {
    const { resolveApp, dryRunFlow } = await import("../../app/app-script.ts");
    let resolved: Awaited<ReturnType<typeof resolveApp>>;
    try {
      resolved = await resolveApp(app);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const missing = /not found|ENOENT|no such/i.test(why);
      if (bool(v["dry-run"]) && (bool(v.json) || ctx.globals.json)) {
        // 机器可读的 dry-run 信封必须能区分"加载失败"与"没问题"：problems 里放真因。
        const envelope = successEnvelope("run", {
          mode: "app", dry_run: true, app, problems: [why],
        }, { exitCode: 2, next: ["amber apps check <应用|脚本>", "amber apps list"] });
        envelope.ok = false;
        envelope.error = {
          code: "USAGE",
          message: missing ? `找不到应用 '${app}'` : `应用 '${app}' 无法加载`,
          hint: why,
          next: ["amber apps check <应用|脚本>"],
        };
        emitJson(ctx, envelope);
        return 2;
      }
      throw usageError(missing ? `找不到应用 '${app}'` : `应用 '${app}' 无法加载`, {
        hint: why,
        next: ["amber apps list", "amber apps check <应用|脚本>"],
      });
    }
    const dry = await dryRunFlow(resolved.script, { slots });
    const pack = resolved.pack;
    const envelope = successEnvelope("run", {
      mode: "flow", dry_run: true, status: "dry", verified: false, partial: false,
      app: pack.id, label: pack.label, goal: pack.goal,
      slots, problems: dry.problems,
      events: dry.trace.events.map((e) => ({
        i: e.i, call: e.call, id: e.id, desc: e.desc, url: e.url,
        ok: e.ok ?? null,
        ...(e.stop_code === undefined ? {} : { stop_code: e.stop_code }),
      })),
    }, { exitCode: dry.problems.length ? 2 : 0, next: dry.problems.length ? ["amber apps check <脚本>"] : [`amber run ${pack.id}`] });
    if (dry.problems.length) {
      envelope.ok = false;
      envelope.error = { code: "USAGE", message: "dry-run 发现配置错误", hint: dry.problems.join("；"), next: ["amber apps check <脚本>"] };
    }
    emitJson(ctx, envelope);
    return dry.problems.length ? 2 : 0;
  }
  const args = ["--app", app];
  if (bool(v["dry-run"])) args.push("--dry");
  if (headful) args.push("--headful");
  if (bool(v["skip-data"])) args.push("--no-sources");
  if (bool(v["allow-dangerous"])) args.push("--allow-dangerous");
  if (bool(v["confirm-safe"])) args.push("--confirm-safe");
  if (bool(v["manual-fail-fast"])) args.push("--manual-fail-fast");
  if (bool(v.remember)) args.push("--learn-hints");
  const emitTrace = str(v["emit-trace"]);
  if (emitTrace !== undefined) args.push("--emit-trace", emitTrace);
  const replay = str(v.replay);
  if (replay !== undefined) args.push("--replay", replay);
  for (const s of flatList(v.slot as string[] | undefined)) args.push("--slot", s);
  for (const [key, flag] of [
    ["out", "--out"], ["provider", "--provider"], ["memory", "--hint-memory"],
    ["min-confidence", "--conf-floor"], ["ablate", "--ablate"],
  ] as const) {
    const val = str(v[key]);
    if (val !== undefined) args.push(flag, val);
  }
  if (bool(v["tiered-hint"])) args.push("--tiered-hint");
  if (bool(v.trace) || bool(v.json) || ctx.globals.json) args.push("--trace");
  const maxStepsArg = str(v["max-steps"]);
  if (maxStepsArg !== undefined) args.push("--max-steps", maxStepsArg);
  if (bool(v.quiet) || ctx.globals.quiet) args.push("--quiet");

  const jsonMode = bool(v.json) || ctx.globals.json;
  if (!jsonMode) {
    return ctx.runEntry("src/app/app-runner.ts", args, { cwd: ctx.cwd, env: ctx.env });
  }

  let appId = path.basename(app, path.extname(app));
  try {
    const { loadScriptApp } = await import("../../app/app-script.ts");
    appId = (await loadScriptApp(app)).pack.id;
  } catch {
    // 脚本坏了交给 app-runner 报错；这里只负责给结果文件一个安全的名字。
  }

  // app-runner 的人类进度先转到 stderr；跑完再从固定产物路径读结果，
  // 由 CLI 统一包成 §5.3 的信封。这样不重写执行器，也不让 stdout 混入日志。
  const userOut = str(v.out);
  const outDir = path.resolve(
    ctx.cwd,
    userOut ?? ctx.env.AMBERFLOW_APPS_OUT ?? path.join(os.tmpdir(), "amberflow-apps"),
  );
  const resultPath = path.join(outDir, `${appId}-result.json`);
  const reportPath = path.join(outDir, `${appId}-report.md`);
  const startedAt = Date.now();
  const code = await ctx.runEntry("src/app/app-runner.ts", args, {
    cwd: ctx.cwd,
    env: ctx.env,
    stdoutToStderr: true,
  });

  let result: Record<string, unknown> | null = null;
  try {
    if (fs.statSync(resultPath).mtimeMs >= startedAt - 2000) {
      const parsed = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        result = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // 配置类预检失败时不会落 result；下面仍给出一个可解析的失败信封。
  }

  const next = code === 0
    ? [`amber apps show ${appId}`, `amber run ${appId} --headful`]
    : ["amber doctor", `amber run ${appId} --headful`];
  if (result) {
    const subgoals = Array.isArray(result.subgoals) ? result.subgoals as Array<Record<string, unknown>> : [];
    const view = toAgentRunView(result as unknown as AppRunResult, {
      outDir, resultPath, reportPath,
      partial: result["partial"] === true,
    });
    const partial = view.partial === true;
    const exitCode = partial ? 0 : code;
    const next = view.next.length ? view.next : [`amber apps show ${appId}`];
    const data = {
      ...result,
      ...view,
      app: appId,
      skipped: subgoals.filter((s) => s.status === "skipped").length,
      steps: view.steps,
      artifacts: { result_json: resultPath, report_md: reportPath },
    };
    const envelope = successEnvelope("run", data, { exitCode, next });
    if (code !== 0 && !partial) {
      envelope.ok = false;
      envelope.error = {
        code: view.status === "needs_human" ? "NEEDS_HUMAN"
          : code === 3 ? "BLOCKED" : code === 2 ? "USAGE" : "INCOMPLETE",
        message: view.status === "needs_human"
          ? `应用 ${appId} 需要人工介入（非 TTY 或人工步未完成）`
          : `应用 ${appId} 未通过（退出码 ${code}）`,
        hint: "完整步骤结果在 data 里；人类报告在 stderr 与 artifacts.report_md。",
        next,
      };
    }
    emitJson(ctx, envelope);
    return exitCode;
  }

  const envelope = successEnvelope("run", {
    app: appId,
    completed: "0/0",
    skipped: 0,
    steps: [],
    artifacts: { result_json: resultPath, report_md: reportPath },
  }, { exitCode: code, next });
  envelope.ok = false;
  envelope.error = {
    code: code === 130 ? "INTERRUPTED" : code === 3 ? "BLOCKED" : code === 2 ? "USAGE" : "INCOMPLETE",
    message: `应用 ${appId} 没有产出结果（退出码 ${code}）`,
    hint: "预检或浏览器阶段失败；诊断在 stderr。",
    next,
  };
  emitJson(ctx, envelope);
  return code;
}

async function runPlanFile(v: Values, ctx: CliContext): Promise<number> {
  const planPath = str(v.planPath) ?? DEFAULT_PLAN;
  const planMax = str(v.max) !== undefined ? maxSteps(v) : null;
  if (bool(v["dry-run"])) {
    if (bool(v.json) || ctx.globals.json) {
      const [{ TaskPlan, PlanningRules }] = await Promise.all([import("../../engine/plan.ts")]);
      const file = path.resolve(ctx.cwd, planPath);
      const plan = TaskPlan.load(file);
      if (!plan) throw usageError(`没有找到计划：${planPath}`, { next: ["amber plan new \"目标\""] });
      const issues = new PlanningRules(planMax ?? 8).problems(plan);
      const code = issues.length ? 2 : 0;
      const envelope = successEnvelope("run", {
        mode: "plan", dry_run: true, path: planPath, goal: plan.goal,
        steps: plan.subgoals.map((s, i) => ({
          index: i + 1, id: s.id ?? null, desc: s.desc, signal: s.signal,
          start_url: s.start_url ?? null, target_hint: s.target_hint ?? null,
        })),
        skipped: 0,
        problems: issues,
      }, { exitCode: code, next: code ? ["amber plan check"] : [`amber run --plan ${planPath}`] });
      if (issues.length) {
        envelope.ok = false;
        envelope.error = {
          code: "USAGE",
          message: `计划未通过校验（${issues.length} 项）`,
          hint: "按 problems 修正计划；dry-run 不执行步骤。",
          next: ["amber plan check"],
        };
      }
      emitJson(ctx, envelope);
      return code;
    }
    const args = ["check", "--file", planPath];
    if (planMax !== null) args.push("--max", String(planMax));
    return ctx.runEntry("tools/plan_cli.ts", args, { cwd: ctx.cwd, env: ctx.env });
  }
  const { TaskPlan, PlanningRules } = await import("../../engine/plan.ts");
  const plan = TaskPlan.load(path.resolve(ctx.cwd, planPath));
  if (!plan) throw usageError(`没有找到计划：${planPath}`, { next: ['amber plan new "目标"'] });
  const problems = new PlanningRules(planMax ?? 8).problems(plan);
  if (problems.length) {
    throw usageError(`计划未通过校验：${problems.join("; ")}`, {
      hint: "先运行 amber plan check 定位；计划执行器不会带着明显错误启动浏览器。",
      next: ["amber plan check", "amber plan show"],
    });
  }
  if (!plan.subgoals.some((s) => typeof s.start_url === "string" && s.start_url !== "")) {
    throw usageError("计划没有 start_url，执行器不知道从哪一页开始", {
      hint: "给步骤补 --url，或在 plan new 时带 --url。",
      next: ["amber plan edit <编号|id> --url <页面>", "amber plan check"],
    });
  }
  const jsonMode = bool(v.json) || ctx.globals.json;
  const args = ["run", "--file", planPath];
  if (bool(v.reset)) args.push("--reset");
  if (bool(v.replan)) args.push("--replan");
  const confirm = str(v.confirm) ?? (ctx.globals.yes ? "allow" : ctx.isTTY ? null : "deny");
  if (confirm && !["allow", "ask", "deny"].includes(confirm)) {
    throw usageError("--confirm 只能是 allow / ask / deny");
  }
  if (confirm === "ask" && !ctx.isTTY) {
    throw usageError("非 TTY 不能用 --confirm ask", {
      hint: "非交互环境请显式给 allow 或 deny。",
      next: ["amber run --plan <文件> --confirm deny", "amber run --plan <文件> --yes"],
    });
  }
  if (confirm) args.push("--confirm", confirm);
  if (bool(v.remember)) args.push("--learn-hints");
  const emitTrace = str(v["emit-trace"]);
  if (emitTrace !== undefined) args.push("--emit-trace", emitTrace);
  const replay = str(v.replay);
  if (replay !== undefined) args.push("--replay", replay);
  if (str(v.memory)) args.push("--hint-memory", str(v.memory)!);
  if (bool(v.headful)) args.push("--headful");
  if (planMax !== null) args.push("--max", String(planMax));
  if (!jsonMode) {
    return ctx.runEntry("tools/plan_cli.ts", args, { cwd: ctx.cwd, env: ctx.env });
  }

  // plan-cli 把进度打在 stdout；JSON 模式转到 stderr，跑完重读计划文件，
  // 用步骤状态生成统一信封。执行器本身仍由旧入口负责。
  const code = await ctx.runEntry("tools/plan_cli.ts", args, {
    cwd: ctx.cwd,
    env: ctx.env,
    stdoutToStderr: true,
  });
  return emitPlanStatus(ctx, {
    file: path.resolve(ctx.cwd, planPath),
    pathLabel: planPath,
    mode: "plan",
    code,
    fallbackGoal: plan.goal,
  });
}

async function runGoal(
  v: Values, goal: string, url: string, savePlan: string, headful: boolean, ctx: CliContext,
): Promise<number> {
  const dryRun = bool(v["dry-run"]);
  const args = ["--goal", goal, "--url", url, "--plan", savePlan];
  if (dryRun) args.push("--dry-run");
  if (headful) args.push("--headful");
  if (str(v.target)) args.push("--target", str(v.target)!);
  if (str(v.provider)) args.push("--provider", str(v.provider)!);
  const jsonMode = bool(v.json) || ctx.globals.json;
  if (!jsonMode) {
    return ctx.runEntry("src/cli/start.ts", args, { cwd: ctx.cwd, env: ctx.env });
  }
  const code = await ctx.runEntry("src/cli/start.ts", args, {
    cwd: ctx.cwd,
    env: ctx.env,
    stdoutToStderr: true,
  });
  return emitPlanStatus(ctx, {
    file: path.resolve(ctx.cwd, savePlan),
    pathLabel: savePlan,
    mode: "goal",
    code,
    dryRun,
    fallbackGoal: goal,
    next: dryRun ? [`amber run --plan ${savePlan}`] : undefined,
  });
}

async function runPick(originalArgs: string[], ctx: CliContext): Promise<number> {
  const { listAppInfos } = await import("./apps.ts");
  const apps = await listAppInfos(ctx);
  if (ctx.globals.json) {
    const envelope = successEnvelope("run", {
      mode: "pick", skipped: 0,
      apps: apps.map((a) => ({ id: a.id, label: a.label, source: a.source, invariants: a.invariants })),
    }, {
      exitCode: 2,
      diagnostics: ["非交互 / JSON 模式不替用户选择应用。"],
      next: ["amber run <id>", "amber apps list"],
    });
    envelope.ok = false;
    envelope.error = {
      code: "USAGE",
      message: "run 在 JSON 模式下需要一个应用或显式模式",
      hint: "用 amber run <id> / --plan / --goal 指定。",
      next: ["amber run <id>", "amber apps list"],
    };
    emitJson(ctx, envelope);
    return 2;
  }
  const { say: out } = await import("../context.ts");
  out(ctx, "应用：");
  for (let i = 0; i < apps.length; i++) out(ctx, `  ${String(i + 1).padStart(2)}. ${apps[i]!.id}  ${apps[i]!.label}`);
  if (!ctx.isTTY) {
    out(ctx, "");
    out(ctx, "非 TTY 不替用户选择。下一步：amber run <id>");
    return 2;
  }
  const rl = (await import("node:readline/promises")).createInterface({
    input: ctx.stdin,
    output: process.stdout,
  });
  let answer = "1";
  try {
    answer = (await rl.question(`选择应用编号 [1-${apps.length}]（回车 = 1）> `)).trim() || "1";
  } finally {
    rl.close();
  }
  const n = Number(answer);
  if (!Number.isInteger(n) || n < 1 || n > apps.length) {
    throw usageError(`无效编号 '${answer}'`, { next: ["amber run"] });
  }
  const chosen = apps[n - 1]!.id;
  return runRun([chosen, ...originalArgs], ctx);
}
