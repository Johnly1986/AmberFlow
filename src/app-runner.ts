/**
 * 应用运行器 —— 一份 `apps/<app>/pack.json` 跑完一条完整链路：
 *
 *   数据腿（`sources`，同一套 datasource 引擎）
 *        ↓
 *   旅程（`journey`）：**浏览器步** → 冻结计划 → 唯一的生产执行器
 *                      **工具步**   → 命令行工具（进程观察面信号 + 干跑/确认/幂等）
 *        ↓
 *   验收（`invariants` 在**同一个浏览器会话的结束状态**上断言）
 *
 * 它**不分叉执行器**：浏览器步就是 `runSubgoalWithRetries`（bench 用的同一个入口，执行循环
 * 始终是 `BrowserMiddleware.run`），只是把会话的生命周期握在自己手里——会话在**第一个**浏览器
 * 步时才创建，并且推迟 `close()`，好让旅程结束后的不变量还能在同一页面/cookie 上求值。
 * 之所以不再整段交给 `runPlan`：旅程现在混了两种面（DOM / 进程），`runPlan` 只认识 DOM 步。
 *
 * 工具步的三条纪律（都来自"浏览器里重点一次很便宜、命令行重跑可能不可逆"）：
 *   1. **默认不重试**：`retries > 0` 必须显式 `idempotent: true`（加载期校验）；
 *   2. **不可逆先干跑**：`dangerous: true` 必须有 `dry_run_args`，干跑不成功就不 apply；
 *   3. **确认才动手**：`dangerous` 步默认**拒绝**，只有 `--allow-dangerous`（或注入的
 *      `confirmToolStep`）点头才执行；拒绝会作为显式结果上报，不是静默跳过。
 *
 *   node --experimental-strip-types src/app-runner.ts --list
 *   node --experimental-strip-types src/app-runner.ts --app demo-app --no-model     # CI 可跑
 *   node --experimental-strip-types src/app-runner.ts --app demo-app --dry          # 只展开计划
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { MockAuditor } from "./audit.ts";
import { cliRunDetailed, defaultDates, loadSource, runSource, urlFor, type CliObservation } from "./datasource.ts";
import { BrowserMiddleware, browserSession, type BrowserSession } from "./executor.ts";
import { REPO } from "./flow.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime } from "./model.ts";
import { runSubgoalWithRetries } from "./planner.ts";
import { DESTRUCTIVE_PATTERNS } from "./rules.ts";
import { checkSignal } from "./signals.ts";
import { checkToolSignal, type ToolSignal } from "./tool-signals.ts";
import { expandPack, listPacks, loadPack, type AppPack, type ExpandedStep } from "./app-pack.ts";

/** 进程内运行序号：保证同一毫秒内连续两次运行也不会撞上同一个 `{run_id}`。 */
let RUN_SEQ = 0;

/** 相对 start_url 按仓库根解析成 file://（与 bench 同一口径）。 */
export function startUrl(u: string): string {
  if (u.includes("://")) return u;
  return new URL(`file://${path.resolve(REPO, u)}`).href;
}

export interface AppRunOptions {
  /** 覆盖包的槽位（`--slot k=v`）。值仍然只来自计划。 */
  slots?: Record<string, unknown>;
  /** 计划 checkpoint 的落盘位置。 */
  planPath?: string;
  /** 跑数据腿（默认跑）。 */
  sources?: boolean;
  /** 浏览器步：危险动作一律拒绝（默认允许并在日志里标注 RISKY）。 */
  confirmSafe?: boolean;
  /** 工具步：允许 `dangerous` 步真跑（默认拒绝）。 */
  allowDangerous?: boolean;
  /** 工具步：注入确认钩子（拿到干跑证据）；返回 false 则拒绝。 */
  confirmToolStep?: (desc: string, evidence: ToolStepEvidence) => boolean | Promise<boolean>;
  verbose?: boolean;
  /** 本次运行的输出目录：工具步的 `{out_dir}` 占位符用它替换（运行期值，不是计划数据）。 */
  outDir?: string;
  /** 本次运行唯一标识：`{run_id}`（默认时间戳 + pid；测试可注入固定值以复现）。 */
  runId?: string;
  /** 测试缝：注入会话工厂。 */
  sessionFactory?: () => Promise<BrowserSession>;
  modelId?: string;
}

export interface ToolStepEvidence {
  desc: string;
  source: string;
  argv: string[];
  dry_run: { code: number; ok: boolean; stdout: string; stderr: string } | null;
}

export interface ToolStepResult {
  index: number;
  desc: string;
  source: string;
  signal: ToolSignal;
  argv: string[];
  attempts: number;
  done: boolean;
  /** 显式拒绝的原因：`dangerous`（没允许）/ `declined`（确认函数说不）/ `dry-run-failed` */
  /**
   * 显式拒绝/失败的原因：
   *   dangerous        —— 危险步没拿到许可（默认行为）
   *   declined         —— 确认钩子说不
   *   dry-run-failed   —— 干跑不成功，所以不 apply
   *   tool-unavailable —— 命令根本起不来（缺二进制 / 超时被杀 / argv 非法）：
   *                       这是**结果**不是崩溃——上层要能在结果 JSON 里读到它。
   */
  refused?: "dangerous" | "declined" | "dry-run-failed" | "tool-unavailable";
  dry_run: { code: number; ok: boolean; stdout: string; argv: string[] } | null;
  code: number | null;
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface AppInvariantResult {
  id: string;
  desc: string;
  held: boolean;
}

export interface AppSourceResult {
  name: string;
  rows: number;
  counts: Record<string, number>;
  selects: Record<string, string>;
  tool_version?: string;
}

export interface AppRunResult {
  app: string;
  label: string;
  goal: string;
  pack_path: string;
  plan_path: string;
  roles_used: string[];
  slots: Record<string, unknown>;
  completed: string;
  subgoals: Array<Record<string, unknown>>;
  tool_steps: ToolStepResult[];
  invariants: AppInvariantResult[];
  sources: AppSourceResult[];
  ok: boolean;
  secs: number;
}

/** 跑一个工具步：干跑（若声明）→ 确认（若不可逆）→ apply（按幂等性决定重试）。 */
export async function runToolStep(
  step: ExpandedStep, opts: AppRunOptions = {},
): Promise<ToolStepResult> {
  const rawTool = step.tool!;
  const src = loadSource(rawTool.source);
  const target = urlFor(src, defaultDates(src)[0]!);
  // `{out_dir}` 是运行期占位符（写到哪儿），不是计划里的值：在这里换成真实输出目录
  const outDir = opts.outDir ?? path.dirname(opts.planPath ?? path.join(os.tmpdir(), "app"));
  // `{run_id}`：**每次运行唯一**（进程内单调序号 + 毫秒时间戳 + pid），给"跨调用有状态"的参数用
  // （重试计数等）。只用秒级时间戳是不够的：同一秒里连跑两次会复用同一个计数文件，
  // 于是第二次运行"看起来"第一次就成功了——那正是 G-K 要修的不可复现。
  const runId = opts.runId
    ?? `${Date.now().toString(36)}-${process.pid}-${++RUN_SEQ}`;
  // `{out_dir}` 是运行期占位符（写到哪儿），不是计划里的值：argv、干跑 argv 和 signal 里
  // 的路径（file_exists / file_absent）都要换成真实输出目录，否则"产物落地了吗"永远为假。
  const sub = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v.split("{out_dir}").join(outDir).split("{run_id}").join(runId);
    }
    if (Array.isArray(v)) return v.map(sub);
    if (typeof v === "object" && v !== null) {
      const o: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) o[k] = sub(vv);
      return o;
    }
    return v;
  };
  const t = { ...rawTool, signal: sub(rawTool.signal) as ToolSignal };
  const base: ToolStepResult = {
    index: step.index, desc: step.desc, source: t.source, signal: t.signal, argv: [],
    attempts: 0, done: false, dry_run: null, code: null, ok: false, stdout: "", stderr: "",
  };

  const unavailable = (e: unknown): void => {
    base.refused = "tool-unavailable";
    base.stderr = `${e instanceof Error ? e.name : typeof e}: `
      + `${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
    if (opts.verbose) console.log(`  [${step.index}] tool ${t.source}: UNAVAILABLE (${base.stderr})`);
  };

  let dry: CliObservation | null = null;
  if (t.dry_run_args) {
    try {
      dry = await cliRunDetailed(target, 60, src, t.dry_run_args.map((a) => String(sub(a))));
    } catch (e) {
      // 缺二进制 / 超时被杀：干跑起不来 => 不 apply，并且如实上报（不抛栈）
      unavailable(e);
      return base;
    }
    base.dry_run = { code: dry.code, ok: dry.ok, stdout: dry.stdout, argv: dry.argv };
    if (opts.verbose) {
      console.log(`  [${step.index}] dry-run ${t.source}: exit ${dry.code}${dry.ok ? "" : " (not ok)"}`);
    }
    if (!dry.ok) {
      base.refused = "dry-run-failed";
      return base;
    }
  }
  if (t.dangerous) {
    const evidence: ToolStepEvidence = {
      desc: step.desc, source: t.source, argv: dry?.argv ?? t.args,
      dry_run: dry ? { code: dry.code, ok: dry.ok, stdout: dry.stdout, stderr: dry.stderr } : null,
    };
    let allowed = opts.allowDangerous === true;
    if (opts.confirmToolStep) allowed = await opts.confirmToolStep(step.desc, evidence);
    if (!allowed) {
      base.refused = opts.confirmToolStep ? "declined" : "dangerous";
      if (opts.verbose) console.log(`  [${step.index}] REFUSED (${base.refused}) ${step.desc}`);
      return base;
    }
  }
  const tries = Math.max(1, 1 + (t.idempotent ? t.retries : 0));
  for (let i = 1; i <= tries; i++) {
    base.attempts = i;
    let o: CliObservation;
    try {
      o = await cliRunDetailed(target, 60, src, t.args.map((a) => String(sub(a))));
    } catch (e) {
      unavailable(e);
      break;
    }
    base.argv = o.argv;
    base.code = o.code;
    base.ok = o.ok;
    base.stdout = o.stdout;
    base.stderr = o.stderr;
    const held = checkToolSignal(o, t.signal);
    if (opts.verbose) {
      console.log(`  [${step.index}] tool ${t.source}: exit ${o.code}, signal ${held ? "held" : "not yet"}`
        + (i > 1 ? ` (attempt ${i})` : ""));
    }
    if (held) { base.done = true; break; }
  }
  return base;
}

/** 跑一个应用包。返回结构化结果（报告与退出码都由调用方决定）。 */
export async function runApp(pack: AppPack, opts: AppRunOptions = {}): Promise<AppRunResult> {
  const {
    slots = {}, sources = true, confirmSafe = false, verbose = true,
    planPath = path.join(os.tmpdir(), "layawebuse-apps", `${pack.id}-plan.json`),
    modelId = pack.model ?? "english",
  } = opts;
  const t0 = Date.now();
  const expanded = expandPack(pack, slots, planPath);
  const plan = expanded.plan;
  // 相对 start_url 按仓库根解析成 file://（与 bench 同一口径）：应用包写仓库内路径，
  // 不写死绝对路径，换机器/换 checkout 目录仍然可跑。
  for (const sg of plan.subgoals) {
    if (sg.start_url) sg.start_url = startUrl(sg.start_url);
  }
  if (verbose) {
    const kinds = expanded.steps.map((s) => (s.kind === "tool" ? "tool" : "web")).join(",");
    console.log(`=== app ${pack.id} (${pack.label}) ===`);
    console.log(`  journey: ${expanded.steps.length} step(s) [${kinds}], roles: ${expanded.rolesUsed.join(", ") || "-"}`);
    if (expanded.steps.length === 0 && pack.probe !== undefined) {
      const sets = pack.probe as Record<string, unknown>;
      const n = ["http", "alts", "mobile", "capture"]
        .reduce((k, key) => k + (Array.isArray(sets[key]) ? (sets[key] as unknown[]).length : 0), 0);
      console.log(`  测量型应用（探针集）：${n} 个目标；测量入口见 apps/README.md 的探针一节`);
    }
  }

  // ---- 数据腿：同一套数据源引擎（HTTP 或 CLI 通道） -------------------------
  const sourceResults: AppSourceResult[] = [];
  for (const name of pack.sources ?? []) {
    const src = loadSource(String(name));
    const dates = defaultDates(src);
    const res = await runSource(src, dates, { verbose: false });
    const day = Object.values(res.dates)[0] as Record<string, any> | undefined;
    const counts = (day?.counts ?? {}) as Record<string, number>;
    const selects: Record<string, string> = {};
    for (const [k, row] of Object.entries((day?.selects ?? {}) as Record<string, any>)) {
      if (row) selects[k] = String(row.price ?? row.id ?? row.name ?? "");
    }
    sourceResults.push({
      name: String(name), rows: (day?.rows ?? []).length, counts, selects,
      ...(res.tool_version ? { tool_version: res.tool_version } : {}),
    });
    if (verbose) console.log(`  source ${name}: ${(day?.rows ?? []).length} 条 ${JSON.stringify(counts)}`);
  }

  // ---- 旅程：逐步骤按类型执行（浏览器步走执行器，工具步走命令行） -----------
  const mw = new BrowserMiddleware({
    modelId,
    auditor: new MockAuditor(),
    maxSteps: 8,
    confFloor: 0.25,
    riskyThreshold: 0.6,
    doneThreshold: 0.5,
    // 批量运行器的默认：风险只记录不阻断；`confirmSafe` 时拒绝破坏性动作。
    confirmFn: confirmSafe
      ? (desc: string) => !DESTRUCTIVE_PATTERNS.some((x) => desc.toLowerCase().includes(x))
      : () => true,
  });

  const own = opts.sessionFactory === undefined;
  // 用 holder 而不是裸的 `let`：会话是在闭包里惰性创建的，裸变量的控制流收窄会把后续读取
  // 变成 never（TS 看不到闭包里的赋值）。
  const holder: { session: BrowserSession | null } = { session: null };
  const getShell = async (): Promise<BrowserSession> => {
    if (holder.session === null) {
      holder.session = own ? await browserSession() : await opts.sessionFactory!();
    }
    const s = holder.session;
    // 会话的生命周期由本函数掌握：执行器关掉的是这个壳，真正的 page 留到不变量之后。
    return { page: s.page, pw: s.pw, browser: s.browser, close: async () => {} };
  };

  const toolSteps: ToolStepResult[] = [];
  const invariantResults: AppInvariantResult[] = [];
  let browserI = 0;
  try {
    for (const step of expanded.steps) {
      if (step.kind === "tool") {
        toolSteps.push(await runToolStep(step, opts));
        continue;
      }
      const sg = plan.subgoals[browserI++]!;
      const shell = await getShell();
      const { rep, attempt } = await runSubgoalWithRetries(
        mw as never, sg, plan, sg.start_url ?? "", shell.page, shell.pw, verbose);
      sg.status = rep.done ? (rep.skipped ? "skipped" : "done") : "blocked";
      sg.attempts = attempt;
      sg.obstacle = rep.done ? null : rep.stop_reason;
      plan.save();
    }
    // ---- 验收：结束状态上的不变量（同一会话、同一 cookie/页面） -------------
    // 显式再标注一次类型：`session` 是在 `getShell` 闭包里赋值的，控制流分析看不到。
    const live = holder.session;
    for (const inv of pack.invariants ?? []) {
      const held = live === null ? false : await checkSignal(live.page as never, inv.signal);
      invariantResults.push({ id: inv.id, desc: inv.desc ?? inv.id, held });
      if (verbose) console.log(`  invariant ${inv.id}: ${held ? "held" : "VIOLATED"}`);
    }
  } finally {
    if (holder.session !== null) await holder.session.close();
  }

  const subgoals = plan.subgoals.map((s) => ({
    desc: s.desc, status: s.status, attempts: s.attempts ?? 1, obstacle: s.obstacle ?? null,
  }));
  const browserOk = subgoals.every((s) => s.status === "done" || s.status === "skipped");
  const toolsOk = toolSteps.every((t) => t.done);
  const ok = browserOk && toolsOk && invariantResults.every((i) => i.held);
  const doneCount = subgoals.filter((s) => s.status === "done" || s.status === "skipped").length
    + toolSteps.filter((t) => t.done).length;
  return {
    app: pack.id, label: pack.label, goal: pack.goal,
    pack_path: pack._path ?? "", plan_path: planPath,
    roles_used: expanded.rolesUsed, slots: expanded.slots,
    completed: `${doneCount}/${expanded.steps.length}`,
    subgoals, tool_steps: toolSteps, invariants: invariantResults,
    sources: sourceResults, ok, secs: Math.round((Date.now() - t0) / 100) / 10,
  };
}

/** 结构化结果 → 人读的 Markdown（应用级证据：数据腿 + 旅程 + 不变量）。 */
export function appReportMarkdown(r: AppRunResult): string {
  const L: string[] = [
    `# 应用运行报告：${r.label}（\`${r.app}\`）`,
    "",
    `- 应用包：\`${r.pack_path}\``,
    `- 目标：${r.goal}`,
    `- 结果：**${r.ok ? "通过" : "未通过"}** ｜ 步骤 ${r.completed} ｜ 用时 ${r.secs}s`,
    `- 角色：${r.roles_used.map((x) => `\`${x}\``).join(", ") || "（未用角色模板）"}`,
    `- 槽位（值只来自计划）：${JSON.stringify(r.slots)}`,
  ];
  if (r.sources.length) {
    L.push("", "## 数据腿", "", "| 数据源 | 行数 | counts | selects | 工具版本 |", "|---|---|---|---|---|");
    for (const s of r.sources) {
      L.push(`| ${s.name} | ${s.rows} | ${JSON.stringify(s.counts)} | ${JSON.stringify(s.selects)} | ${s.tool_version ?? "-"} |`);
    }
  }
  if (r.subgoals.length) {
    L.push("", "## 动作腿：浏览器步（冻结计划）", "", "| # | 子目标 | 状态 | 尝试 | 障碍 |", "|---|---|---|---|---|");
    r.subgoals.forEach((s, i) => {
      L.push(`| ${i} | ${String(s.desc).slice(0, 80)} | ${s.status} | ${s.attempts} | ${s.obstacle ?? "-"} |`);
    });
  }
  if (r.tool_steps.length) {
    L.push("", "## 动作腿：工具步（命令行）", "",
      "| # | 步骤 | 数据源 | 退出码 | 结论 | 尝试 | 干跑 |", "|---|---|---|---|---|---|---|");
    for (const t of r.tool_steps) {
      const verdict = t.done ? "signal held" : `**${t.refused ?? "signal not held"}**`;
      const dry = t.dry_run ? `exit ${t.dry_run.code}${t.dry_run.ok ? "" : " (not ok)"}` : "-";
      L.push(`| ${t.index} | ${t.desc.slice(0, 60)} | ${t.source} | ${t.code ?? "-"} | ${verdict} | ${t.attempts} | ${dry} |`);
    }
    L.push("", "<details><summary>工具步的原始观察（argv / stdout 摘要）</summary>", "");
    for (const t of r.tool_steps) {
      L.push(`- \`${t.source}\` argv: \`${t.argv.join(" ")}\``);
      if (t.dry_run) L.push(`  - dry-run argv: \`${t.dry_run.argv.join(" ")}\``);
      if (t.stdout) L.push(`  - stdout: ${JSON.stringify(t.stdout.slice(0, 200))}`);
      if (t.stderr) L.push(`  - stderr: ${JSON.stringify(t.stderr.slice(0, 200))}`);
    }
    L.push("", "</details>");
  }
  if (r.invariants.length) {
    L.push("", "## 验收（浏览器结束状态不变量）", "", "| 不变量 | 说明 | 结论 |", "|---|---|---|");
    for (const i of r.invariants) L.push(`| ${i.id} | ${i.desc} | ${i.held ? "成立" : "**不成立**"} |`);
  }
  return L.join("\n") + "\n";
}

const USAGE = `usage: app-runner [--list] [--app ID] [--dry] [--slot k=v ...] [--out DIR]
                  [--model ID] [--no-model] [--no-sources] [--confirm-safe]
                  [--allow-dangerous] [--quiet]

按 apps/<app>/pack.json 跑一条完整应用链路：数据腿 → 浏览器步/工具步 → 结束状态不变量`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      list: { type: "boolean" }, app: { type: "string" }, dry: { type: "boolean" },
      slot: { type: "string", multiple: true }, out: { type: "string" },
      model: { type: "string" }, "no-model": { type: "boolean" },
      "no-sources": { type: "boolean" }, "confirm-safe": { type: "boolean" },
      "allow-dangerous": { type: "boolean" },
      quiet: { type: "boolean" }, help: { type: "boolean" },
    },
  });
  const v = parsed.values;
  if (v.help) { console.log(USAGE); return 0; }
  if (v.list || !v.app) {
    for (const [id, label, p] of listPacks()) console.log(`${id.padEnd(22)} ${label}  ${p}`);
    if (!v.app) { console.log(); console.log(USAGE); return v.list ? 0 : 2; }
  }

  const slots: Record<string, unknown> = {};
  for (const s of v.slot ?? []) {
    const i = s.indexOf("=");
    if (i <= 0) { console.error(`--slot needs k=v, got ${JSON.stringify(s)}`); return 2; }
    slots[s.slice(0, i)] = s.slice(i + 1);
  }

  let pack: AppPack;
  try {
    pack = loadPack(String(v.app));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }

  const outDir = path.resolve(v.out ?? path.join(os.tmpdir(), "layawebuse-apps"));
  fs.mkdirSync(outDir, { recursive: true });
  const planPath = path.join(outDir, `${pack.id}-plan.json`);

  // 测量型应用（只声明 probe、没有 journey）走 app 运行器是没有意义的：它会"通过 0/0"。
  // 与其给一个什么都没证明的绿色，不如指路到真正的测量入口。
  if (pack.probe !== undefined && (pack.journey ?? []).length === 0) {
    const sets = pack.probe as Record<string, unknown>;
    const n = ["http", "alts", "mobile", "capture"]
      .reduce((k, key) => k + (Array.isArray(sets[key]) ? (sets[key] as unknown[]).length : 0), 0);
    console.error(`app ${pack.id} 是测量型应用（探针集，${n} 个目标），没有 journey：`
      + "请用对应的探针驱动（src/live-probe.ts / live-capture.ts / ota-probe.ts / qunar-probe.ts），"
      + "或用 `npm run apps -- --app " + pack.id + " --dry` 只看声明。");
    return 2;
  }

  if (v.dry) {
    let dryOut;
    try {
      dryOut = expandPack(pack, slots, planPath);
    } catch (e) {                                  // 坏包也要干净地报错（exit 2），不是抛栈
      console.error(e instanceof Error ? e.message : String(e));
      return 2;
    }
    const { plan, steps, rolesUsed } = dryOut;
    console.log(JSON.stringify({
      app: pack.id, roles_used: rolesUsed, slots: plan.slots,
      goal: plan.goal, steps, subgoals: plan.subgoals,
    }, null, 2));
    return 0;
  }

  if (v["no-model"]) {
    installLayaRuntime(scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 }))));
  } else {
    const { createLayaOnnxRuntime } = await import("./laya-onnx.ts");
    const rt = createLayaOnnxRuntime();
    installLayaRuntime(rt);
  }

  let result: AppRunResult;
  try {
    result = await runApp(pack, {
      slots, planPath, outDir, verbose: !v.quiet,
      sources: !v["no-sources"], confirmSafe: v["confirm-safe"] === true,
      allowDangerous: v["allow-dangerous"] === true,
      modelId: v.model ?? pack.model ?? "english",
    });
  } catch (e) {
    // 坏包（未知键/角色/占位符/主机……）在 `expandPack` 里就抛出：CLI 的契约是
    // "报清楚 + 退出码 2"，不是把栈甩给用户。
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  } finally {
    installLayaRuntime(null);
  }

  const jsonPath = path.join(outDir, `${pack.id}-result.json`);
  const mdPath = path.join(outDir, `${pack.id}-report.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf-8");
  fs.writeFileSync(mdPath, appReportMarkdown(result), "utf-8");
  if (!v.quiet) {
    console.log();
    console.log(appReportMarkdown(result));
    console.log(`写入 ${jsonPath} 与 ${mdPath}`);
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
