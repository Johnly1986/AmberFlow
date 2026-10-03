/**
 * 应用运行器 —— 一份 `apps/<app>/pack.json` 跑完一条完整链路：
 *
 *   数据腿（`sources`，同一套 datasource 引擎）
 *        ↓
 *   动作腿（`journey` → 冻结计划 → `runPlan` → 唯一的生产执行器）
 *        ↓
 *   验收（`invariants` 在**同一个会话的结束状态**上断言）
 *
 * 它**不分叉执行器**：动作腿就是 `runPlan`，只是把会话的生命周期握在自己手里（`sessionFactory`
 * 返回一个 close 被推迟的壳），好让旅程结束后的不变量还能在同一页面/cookie 上求值——
 * 这条正是"下单后购物车已清空"这类验收的语义。
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
import { defaultDates, loadSource, runSource } from "./datasource.ts";
import { BrowserMiddleware, browserSession, type BrowserSession } from "./executor.ts";
import { REPO } from "./flow.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime } from "./model.ts";
import { runPlan } from "./planner.ts";
import { DESTRUCTIVE_PATTERNS } from "./rules.ts";
import { checkSignal } from "./signals.ts";
import { expandPack, listPacks, loadPack, type AppPack } from "./app-pack.ts";

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
  /** 危险动作一律拒绝（默认允许并在日志里标注 RISKY）。 */
  confirmSafe?: boolean;
  verbose?: boolean;
  /** 测试缝：注入会话工厂。 */
  sessionFactory?: () => Promise<BrowserSession>;
  modelId?: string;
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
  invariants: AppInvariantResult[];
  sources: AppSourceResult[];
  ok: boolean;
  secs: number;
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
    console.log(`=== app ${pack.id} (${pack.label}) ===`);
    console.log(`  journey: ${plan.subgoals.length} subgoal(s), roles: ${expanded.rolesUsed.join(", ") || "-"}`);
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

  // ---- 动作腿：冻结计划 → runPlan（唯一执行器） -----------------------------
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
  const session = own ? await browserSession() : await opts.sessionFactory!();
  // 会话的生命周期由本函数掌握：`runPlan` 关掉的是这个壳，真正的 page 留到不变量之后。
  const shell: BrowserSession = {
    page: session.page, pw: session.pw, browser: session.browser, close: async () => {},
  };
  let invariantResults: AppInvariantResult[] = [];
  try {
    await runPlan(mw as never, plan, { sessionFactory: async () => shell, verbose, replan: false });
    // ---- 验收：结束状态上的不变量（同一会话、同一 cookie/页面） -------------
    invariantResults = [];
    for (const inv of pack.invariants ?? []) {
      const held = await checkSignal(session.page as never, inv.signal);
      invariantResults.push({ id: inv.id, desc: inv.desc ?? inv.id, held });
      if (verbose) console.log(`  invariant ${inv.id}: ${held ? "held" : "VIOLATED"}`);
    }
  } finally {
    await session.close();
  }

  const subgoals = plan.subgoals.map((s) => ({
    desc: s.desc, status: s.status, attempts: s.attempts ?? 1, obstacle: s.obstacle ?? null,
  }));
  const ok = subgoals.every((s) => s.status === "done" || s.status === "skipped")
    && invariantResults.every((i) => i.held);
  return {
    app: pack.id, label: pack.label, goal: pack.goal,
    pack_path: pack._path ?? "", plan_path: planPath,
    roles_used: expanded.rolesUsed, slots: expanded.slots,
    completed: plan.subgoals.filter((x) => x.status === "done").length
      + "/" + plan.subgoals.length, subgoals, invariants: invariantResults,
    sources: sourceResults, ok, secs: Math.round((Date.now() - t0) / 100) / 10,
  };
}

/** 结构化结果 → 人读的 Markdown（应用级证据：旅程 + 不变量 + 数据腿）。 */
export function appReportMarkdown(r: AppRunResult): string {
  const L: string[] = [
    `# 应用运行报告：${r.label}（\`${r.app}\`）`,
    "",
    `- 应用包：\`${r.pack_path}\``,
    `- 目标：${r.goal}`,
    `- 结果：**${r.ok ? "通过" : "未通过"}** ｜ 子目标 ${r.completed} ｜ 用时 ${r.secs}s`,
    `- 角色：${r.roles_used.map((x) => `\`${x}\``).join(", ") || "（未用角色模板）"}`,
    `- 槽位（值只来自计划）：${JSON.stringify(r.slots)}`,
  ];
  if (r.sources.length) {
    L.push("", "## 数据腿", "", "| 数据源 | 行数 | counts | selects | 工具版本 |", "|---|---|---|---|---|");
    for (const s of r.sources) {
      L.push(`| ${s.name} | ${s.rows} | ${JSON.stringify(s.counts)} | ${JSON.stringify(s.selects)} | ${s.tool_version ?? "-"} |`);
    }
  }
  L.push("", "## 动作腿（冻结计划）", "", "| # | 子目标 | 状态 | 尝试 | 障碍 |", "|---|---|---|---|---|");
  r.subgoals.forEach((s, i) => {
    L.push(`| ${i} | ${String(s.desc).slice(0, 80)} | ${s.status} | ${s.attempts} | ${s.obstacle ?? "-"} |`);
  });
  if (r.invariants.length) {
    L.push("", "## 验收（结束状态不变量）", "", "| 不变量 | 说明 | 结论 |", "|---|---|---|");
    for (const i of r.invariants) L.push(`| ${i.id} | ${i.desc} | ${i.held ? "成立" : "**不成立**"} |`);
  }
  return L.join("\n") + "\n";
}

const USAGE = `usage: app-runner [--list] [--app ID] [--dry] [--slot k=v ...] [--out DIR]
                  [--model ID] [--no-model] [--no-sources] [--confirm-safe] [--quiet]

按 apps/<app>/pack.json 跑一条完整应用链路：数据腿 → 冻结计划 → 结束状态不变量`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      list: { type: "boolean" }, app: { type: "string" }, dry: { type: "boolean" },
      slot: { type: "string", multiple: true }, out: { type: "string" },
      model: { type: "string" }, "no-model": { type: "boolean" },
      "no-sources": { type: "boolean" }, "confirm-safe": { type: "boolean" },
      quiet: { type: "boolean" }, "up-to": { type: "string" }, help: { type: "boolean" },
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

  if (v.dry) {
    const { plan, rolesUsed } = expandPack(pack, slots, planPath);
    console.log(JSON.stringify({
      app: pack.id, roles_used: rolesUsed, slots: plan.slots,
      goal: plan.goal, subgoals: plan.subgoals,
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
      slots, planPath, verbose: !v.quiet,
      sources: !v["no-sources"], confirmSafe: v["confirm-safe"] === true,
      modelId: v.model ?? pack.model ?? "english",
    });
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
