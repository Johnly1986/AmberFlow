/**
 * Bench harness — TS twin of `bench/run_bench.py`.
 *
 *     固化流程 = a Plan JSON -- ordered subgoals, each with {desc, signal, start_url}.
 *     The executor NEVER re-plans and NEVER invents values: it replays the frozen
 *     plan step by step; laya only answers "which element now / is this risky".
 *     Success per subgoal = the plan's own DOM/url done-signal fired.
 *
 * `BenchMiddleware` SUBCLASSES the production executor and only chooses the
 * checkpoint and flips the measured ablation switches — the invariant the repo
 * pins in Python (`BenchMiddleware.run is BrowserMiddleware.run`) is pinned here
 * too, in the prototype chain.
 */
import fs from "node:fs";
import { benchOptions, cliBool, cliString, parseCliArgs } from "../support/cli-args.ts";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import * as browserEnv from "../browser/browser-env.ts";
import { MockAuditor, type Auditor } from "../engine/audit.ts";
import { BrowserMiddleware } from "../engine/executor.ts";
import { REPO } from "../flow/flow.ts";
import { validateSignalSpec } from "../engine/signals.ts";
import { TaskPlan, type Subgoal } from "../engine/plan.ts";
import { checkSignal } from "../engine/signals.ts";
import { runSubgoalWithRetries } from "../engine/planner.ts";
import { installLayaRuntime, type DecisionAgent, type LayaRuntime } from "../model/model.ts";
import { applySpecToRuntime, installDecisionProvider, resolveProviderSpec } from "../model/decision-provider.ts";
import { createOutcomeMemory, type OutcomeMemoryLike } from "../model/outcome-memory.ts";
import { createHintMemory, type HintMemoryLike } from "../model/hint-memory.ts";
import { applyRcToEnv } from "../support/rcfile.ts";

export interface BenchCase {
  id: string;
  platform: string;
  model?: string;
  rules?: boolean;
  anti_repeat?: boolean;
  conf_floor?: number;
  max_steps?: number;
  slots?: Record<string, unknown>;
  goal: string;
  subgoals: Array<Partial<Subgoal>>;
}


/**
 * 基准用例的加载期校验（P0-C）：用例包过去只靠 `BenchCase` 的**编译期**类型，运行时是裸
 * `JSON.parse`——少了 `signal`、`start_url` 指到不存在的文件、`slots` 写成数组，都要等跑到
 * 那一步才炸（或更糟：静默地当成"没有信号"）。这里把三件事变成加载期错误：
 *
 *   1. 用例/子目标的结构与必填字段；
 *   2. 完成信号必须走**同一套语法**（`validateSignalSpec`，与计划/应用包同一个走查器）；
 *   3. 非 `http(s)` 的 `start_url` 必须真的指向仓库里的文件（fixtures 少了文件是配置错误，
 *      不是"这个 case 偶尔挂"）。
 */
export function validateBenchCase(c: BenchCase, where = "case"): string[] {
  const problems: string[] = [];
  if (typeof c !== "object" || c === null) return [`${where}: case must be an object`];
  if (typeof c.id !== "string" || !c.id.trim()) problems.push(`${where}: id must be a non-empty string`);
  if (typeof c.platform !== "string" || !c.platform.trim()) problems.push(`${where}: platform must be a non-empty string`);
  if (typeof c.goal !== "string" || !c.goal.trim()) problems.push(`${where}: goal must be a non-empty string`);
  if (c.slots !== undefined && (typeof c.slots !== "object" || c.slots === null || Array.isArray(c.slots))) {
    problems.push(`${where}: slots must be an object`);
  }
  if (!Array.isArray(c.subgoals) || c.subgoals.length === 0) {
    problems.push(`${where}: subgoals must be a non-empty list`);
    return problems;
  }
  c.subgoals.forEach((sg, i) => {
    const at = `${where}.subgoals[${i}]`;
    if (typeof sg !== "object" || sg === null || Array.isArray(sg)) { problems.push(`${at}: subgoal must be an object`); return; }
    const sig = (sg as { signal?: unknown }).signal;
    if (sig === undefined || sig === null || typeof sig !== "object" || Array.isArray(sig) || !Object.keys(sig as object).length) {
      problems.push(`${at}: missing done-signal (a subgoal without ` + "`signal`" + ` can never be verified done)`);
    } else {
      problems.push(...validateSignalSpec(sig, at));
    }
    const url = (sg as { start_url?: unknown }).start_url;
    if (url === undefined) problems.push(`${at}: missing start_url`);
    else if (typeof url !== "string" || !url.trim()) problems.push(`${at}: start_url must be a non-empty string`);
    else if (!/^https?:\/\//i.test(url) && !fs.existsSync(path.isAbsolute(url) ? url : path.join(REPO, url))) {
      problems.push(`${at}: start_url file not found: ${url}`);
    }
    const slots = (sg as { slots?: unknown }).slots;
    if (slots !== undefined && (typeof slots !== "object" || slots === null || Array.isArray(slots))) {
      problems.push(`${at}: slots must be an object`);
    }
  });
  return problems;
}

export interface BenchCaseResult {
  case: string;
  platform: string;
  model: string;
  rules: boolean;
  anti_repeat: boolean;
  subgoals_done: string;
  all_done: boolean;
  steps: number;
  secs: number;
  results: Array<Record<string, unknown>>;
  error?: string;
}

/** case 的 start_url：带 scheme 的照用；相对路径按仓库根解析成 file:// URI。 */
export function startUrl(u: string): string {
  if (u.includes("://")) return u;
  return new URL(`file://${path.resolve(REPO, u)}`).href;
}

export interface BenchMiddlewareOptions {
  model?: string;
  rules?: boolean;
  antiRepeat?: boolean;
  confFloor?: number;
  maxSteps?: number;
  agentOverride?: DecisionAgent | null;
  auditor?: Auditor;
  routeModels?: boolean;
  /** Cross-run outcome memory (see src/model/outcome-memory.ts). */
  outcomeMemory?: OutcomeMemoryLike | null;
  /** "forbid" (default) removes a remembered element; "rank" annotates it instead. */
  outcomeMemoryMode?: "forbid" | "rank";
  /** Cross-run learned hints (see src/model/hint-memory.ts). */
  hintMemory?: HintMemoryLike | null;
}

export class BenchMiddleware extends BrowserMiddleware {
  modelIdUsed: string;

  constructor(opts: BenchMiddlewareOptions = {}) {
    const model = opts.model ?? "english";
    const route = model === "router";
    super({
      modelId: opts.agentOverride ?? "convaiinnovations/laya",
      routeModels: opts.routeModels ?? route,
      // the harness stays offline and deterministic: no LLM audit calls
      auditor: opts.auditor ?? new MockAuditor(),
      maxSteps: opts.maxSteps ?? 8,
      confFloor: opts.confFloor ?? 0.25,
      riskyThreshold: 0.6,
      doneThreshold: 0.5,
      confirmFn: () => true,     // bench user: allow-all (risk logged, not blocking)
      // Forwarded, or the harness would silently run without the memory it was given
      // (this exact omission produced an A/B that measured nothing).
      outcomeMemory: opts.outcomeMemory ?? null,
      outcomeMemoryMode: opts.outcomeMemoryMode ?? "forbid",
      hintMemory: opts.hintMemory ?? null,            // forwarded, or it silently does nothing
    });
    this.modelIdUsed = route
      ? "router"
      : "convaiinnovations/laya" + (model === "english" ? "" : "/multilingual");
    // ablation switches live on the production loop (camelCase in the TS port)
    this.rulesOn = opts.rules ?? true;
    this.antiRepeat = opts.antiRepeat ?? true;
  }
}

/** One case: one browser, one page across the whole case (session + JS state persist). */
export async function runCase(
  c: BenchCase, agents: Record<string, DecisionAgent | null>,
  outcomeMemory: OutcomeMemoryLike | null = null,
  hintMemory: HintMemoryLike | null = null,
  outcomeMemoryMode: "forbid" | "rank" = "forbid",
  /** 看着跑（apps/start 同一口径的 `--headful`）；缺省 true，测量臂与 CI 零变化。 */
  headless = true,
): Promise<BenchCaseResult> {
  // `slots` go on the PLAN, not into the per-call options: `runSubgoalWithRetries`
  // passes `plan.slots` (merged with the subgoal's own), so a case-level value bag
  // must live there or the fill has nothing to type. Measured live: python.org's
  // `{"q": "asyncio"}` stopped reaching the recovered search field after the retry
  // wiring, and the step burned as `needs_value`.
  const plan = new TaskPlan(c.goal, c.subgoals, "/tmp/bench_plan.json", c.slots ?? {});
  const t0 = Date.now();
  const results: Array<Record<string, unknown>> = [];
  const model = c.model ?? "english";
  const mw = new BenchMiddleware({
    model, rules: c.rules ?? true, antiRepeat: c.anti_repeat ?? true,
    confFloor: c.conf_floor ?? 0.25, maxSteps: c.max_steps ?? 8,
    agentOverride: agents[model] ?? null,
    outcomeMemory: outcomeMemory ?? null,
    outcomeMemoryMode,
    hintMemory: hintMemory ?? null,
  });
  const browser = (await browserEnv.launch({ chromium } as never, headless)) as unknown as {
    newPage(): Promise<unknown>; close(): Promise<void>;
  };
  const page = await browser.newPage();
  try {
    for (const [i, sg] of plan.subgoals.entries()) {
      // Through `runSubgoalWithRetries`, not `mw.run`: a case's `retries` is the
      // plan's own vocabulary for transient failures and the live pack uses it
      // (a cold load on a real site burned 9 steps into `max_steps` while the same
      // case passed in isolation). `attempts` is recorded per subgoal so a retried
      // step shows up in the report instead of being silently absorbed.
      const { rep, attempt, steps } = await runSubgoalWithRetries(
        mw as never, sg, plan, startUrl(sg.start_url!),
        page as never, { chromium } as never, true,
      );
      results.push({
        subgoal: sg.desc, ...rep, attempts: attempt,
        steps: steps.length ? steps : rep.steps,
      });
      console.log(`  [${i}] ${rep.done ? "DONE" : "FAIL"} ${sg.desc.slice(0, 60)}`
        + `  (${rep.stop_reason}${attempt > 1 ? `, ${attempt} attempts` : ""})`);
    }
  } finally {
    await browser.close();
  }
  const ok = results.filter((r) => r.done).length;
  return {
    case: c.id, platform: c.platform, model,
    rules: c.rules ?? true, anti_repeat: c.anti_repeat ?? true,
    subgoals_done: `${ok}/${results.length}`, all_done: ok === results.length,
    steps: results.reduce((n, r) => n + ((r.steps as unknown[])?.length ?? 0), 0),
    secs: Math.round((Date.now() - t0) / 100) / 10,
    results,
  };
}

export interface BenchSummary {
  mode_tag: string;
  cases_passed: string;
  subgoals_passed: string;
  total_secs: number;
  /** 这一跑是谁在决策（tier 与 apps/suite 产物同一口径：on / off(missing) / off(ablation:…)）。 */
  model_status?: string;
  decision_provider?: string;
  per_case: Array<Record<string, unknown>>;
}

export interface BenchMainDeps {
  /** Model runtime used to load the per-case checkpoints (defaults to ONNX if present). */
  runtime?: LayaRuntime;
}

/**
 * bench 的用法（与 apps 对齐后的旗标名）。两张旗标表共用 `SHARED_RUN_OPTIONS`
 * ——同一个名字在两个入口是同一件事，剩下的才是各自专属的（bench 的语料层、apps 的包层）。
 */
const USAGE = `usage: bench [--cases FILE] [--only ID] [--fixtures-only] [--mode-tag TAG] [--out DIR]
             [--model ID | --provider NAME | --ablate stub|rules-only] [--conf-floor N] [--force-hints off]
             [--force-rules on|off] [--headful] [--quiet] [--help]
             [--outcome-memory on] [--outcome-memory-file FILE] [--outcome-memory-mode forbid|rank]
             [--learn-hints | --hint-memory FILE]

在冻结语料上跑对照（bench/cases.json）：浏览器步 → 完成信号 → 逐用例结论
--model ID       换 laya checkpoint（只在 checkpoints 档有意义；换决策源用 --provider）
--ablate         消融臂：stub = 脚本桩，rules-only = 规则档（与 apps 同一取值集合）
--conf-floor N   置信度闸门刻度（0<N≤1）；旧名 --force-conf-floor 仍认
--quiet          只留机器读的 summary JSON（过程行不打印）
R2 学习环：--learn-hints 用默认 sidecar，--hint-memory FILE 显式指定落点（旧写法 --hint-memory on 仍认）

旧名（升级窗口仍认，不再列进新文档）：--force-model → --model，--force-conf-floor → --conf-floor，
--hint-memory-file → --hint-memory FILE`;

export async function main(argv: string[] = process.argv.slice(2), deps: BenchMainDeps = {}): Promise<number> {
  // rc 文件坏 = 配置类用法错误：在任何腿出场之前逐行点名并 exit 2（src/support/rcfile.ts）。
  { const rc = applyRcToEnv(); if (rc.errors.length) { for (const e of rc.errors) console.error(e); return 2; } }
  // 打错的参数 → 一行点名 + usage，绝不甩 parseArgs 的堆栈（src/support/cli-args.ts 的体例）。
  // 旗标表与 apps 共用一张（`benchOptions()`），两个入口的同一件事同一个名字。
  const cli = parseCliArgs(argv, { allowPositionals: true, options: benchOptions(), usage: USAGE });
  if (!cli.ok) return cli.code;
  const v = cli.values;
  if (cliBool(v, "help")) { console.log(USAGE); return 0; }
  const quiet = cliBool(v, "quiet");
  const say = (line: string): void => { if (!quiet) console.log(line); };
  const casesPath = path.resolve(cliString(v, "cases") ?? path.join(REPO, "bench", "cases.json"));
  const outdir = path.resolve(cliString(v, "out") ?? path.join(REPO, "bench", "results"));
  const modeTag = cliString(v, "mode-tag") ?? "baseline";

  // 对齐后的名字优先，旧名（`--force-model` / `--force-conf-floor`）在升级窗口里仍认。
  const forcedModel = cliString(v, "model") ?? cliString(v, "force-model");
  const ablate = cliString(v, "ablate");
  if (ablate !== undefined && ablate !== "stub" && ablate !== "rules-only") {
    console.error(`--ablate 只接受 stub | rules-only（收到 ${JSON.stringify(ablate)}）`);
    return 2;
  }
  const confFloorRaw = cliString(v, "conf-floor") ?? cliString(v, "force-conf-floor");
  let confFloor: number | undefined;
  if (confFloorRaw !== undefined) {
    confFloor = Number(confFloorRaw);
    if (!Number.isFinite(confFloor) || confFloor <= 0 || confFloor > 1) {
      console.error(`--conf-floor 要是 (0, 1] 之间的数（拿到 ${JSON.stringify(confFloorRaw)}）`);
      return 2;
    }
  }
  if (cliString(v, "force-hints") !== undefined && cliString(v, "force-hints") !== "off") {
    console.error(`--force-hints 只接受 off（收到 ${JSON.stringify(cliString(v, "force-hints"))}）——它是消融旗标，只有"剥掉"这一档。`);
    return 2;
  }

  let cases = (JSON.parse(fs.readFileSync(casesPath, "utf-8")) as { cases: BenchCase[] }).cases;
  {
    const problems = cases.flatMap((c, i) => validateBenchCase(c, `case[${i}] ${JSON.stringify(c?.id ?? "?")}`));
    if (problems.length) throw new Error(`bench cases ${JSON.stringify(casesPath)} are invalid:\n  - ${problems.join("\n  - ")}`);
  }
  const only = cliString(v, "only");
  if (only) cases = cases.filter((c) => c.id === only);
  if (cliBool(v, "fixtures-only")) cases = cases.filter((c) => c.platform.startsWith("fixture:"));
  if (!cases.length) throw new Error("no cases selected");
  for (const c of cases) {
    if (forcedModel) c.model = forcedModel;
    if (cliString(v, "force-rules") !== undefined) c.rules = cliString(v, "force-rules") === "on";
    if (confFloor !== undefined) c.conf_floor = confFloor;
    if (cliString(v, "force-hints") === "off") {
      for (const sg of c.subgoals ?? []) {
        delete (sg as { target_hint?: string }).target_hint;
        delete (sg as { target_hints?: string[] }).target_hints;
      }
    }
  }

  // 智能缺省（apps/suite/start/bench 四门同一实现）：先解析决策源，再决定走哪条腿——
  // checkpoints 腿只在"真 laya 在场（就绪或测试注入了 runtime）"时才预载；
  // 配了在线 provider 就直接问 provider；什么都没配 ⇒ 规则档如实降级（以前是当场崩）。
  // `--ablate` 与 apps 同一个取值集合（stub → scripted-stub；rules-only → none）。
  const providerWanted = cliString(v, "provider")
    ?? (ablate === "stub" ? "scripted-stub" : ablate === "rules-only" ? "none" : undefined);
  let spec;
  try {
    spec = await resolveProviderSpec(providerWanted);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const useCheckpoints = deps.runtime != null || (spec.kind === "laya" && spec.tier === "on");
  if (forcedModel !== undefined && !useCheckpoints) {
    // 旗标语义只在 checkpoints 上有意义；在别的决策源上静默忽略会让一整轮 A/B 白跑。
    console.error(`--model 选的是 laya checkpoint，在决策源 ${JSON.stringify(spec.name)}（tier=${spec.tier}）上没有意义；换模型用 --provider。`);
    return 2;
  }
  const agents: Record<string, DecisionAgent | null> = {};
  if (useCheckpoints) {
    // The model seam: an explicitly injected runtime (tests), or the installed one.
    const runtime = deps.runtime ?? await defaultRuntime();
    // Load each requested checkpoint exactly once for the whole run.
    const wanted = [...new Set(cases.map((c) => c.model ?? "english"))].sort();
    for (const m of wanted) {
      agents[m] = m === "router" ? null
        : await runtime.load("convaiinnovations/laya", { subfolder: m === "english" ? null : "multilingual" });
    }
    say(`checkpoints loaded: ${JSON.stringify(Object.keys(agents))}\n`);
  } else if (spec.kind === "laya" && spec.tier === "off(missing)") {
    // 规则档如实降级（旧行为是当场崩）：不装一个逐步 config-refuse 的懒加载 runtime——
    // 执行器进 rulesOnly，语料里被点名的步照规则跑。model_status 如实记 off(missing)。
    // 两扇全局都清：执行器优先显式 provider，同进程残留会让规则档标签说谎。
    installLayaRuntime(null);
    installDecisionProvider(null);
    say(`决策源：${spec.name}（tier=${spec.tier}）→ 走规则档\n`);
  } else {
    await applySpecToRuntime(spec);
    say(`决策源：${spec.name}（tier=${spec.tier}）\n`);
  }

  const all: BenchCaseResult[] = [];
  const mem = cliString(v, "outcome-memory") === "on"
    ? createOutcomeMemory({ path: cliString(v, "outcome-memory-file") ?? null })
    : null;
  // R2 学习环：与 apps 同一个旗标口径——`--learn-hints`（默认 sidecar）或
  // `--hint-memory FILE`（显式落点）；bench 的旧写法 `--hint-memory on` 等同 `--learn-hints`。
  const hintMemoryRaw = cliString(v, "hint-memory") ?? cliString(v, "hint-memory-file");
  const wantsHintMemory = cliBool(v, "learn-hints") || hintMemoryRaw !== undefined;
  const hintMemoryPath = wantsHintMemory
    ? (hintMemoryRaw !== undefined && hintMemoryRaw !== "on" ? path.resolve(hintMemoryRaw) : null)
    : undefined;
  const hints = hintMemoryPath !== undefined ? createHintMemory({ path: hintMemoryPath }) : null;
  for (const c of cases) {
    say(`=== ${c.id} (${c.platform}, model=${useCheckpoints ? (c.model ?? "english") : spec.name}) ===`);
    try {
      all.push(await runCase(c, agents, mem, hints,
        (cliString(v, "outcome-memory-mode") as "forbid" | "rank" | undefined) ?? "forbid",
        !cliBool(v, "headful")));
    } catch (e) {
      console.error(e);
      all.push({
        // 非 checkpoints 档下 checkpoint 标签是误导——如实写"谁在决策"。
        case: c.id, platform: c.platform, model: useCheckpoints ? (c.model ?? "english") : spec.name,
        rules: c.rules ?? true, anti_repeat: c.anti_repeat ?? true,
        subgoals_done: "0/0", all_done: false, steps: 0, secs: 0, results: [],
        error: String(e),
      });
    }
    say("");
  }

  const passed = all.filter((r) => r.all_done).length;
  const sgOk = all.reduce((n, r) => n + Number(r.subgoals_done.split("/")[0]), 0);
  const sgN = all.reduce((n, r) => n + r.results.length, 0);
  const summary: BenchSummary = {
    mode_tag: modeTag,
    model_status: spec.tier, decision_provider: spec.name,
    cases_passed: `${passed}/${all.length}`,
    subgoals_passed: `${sgOk}/${sgN}`,
    total_secs: Math.round(all.reduce((n, r) => n + r.secs, 0) * 10) / 10,
    per_case: all.map((r) => ({
      // 非 checkpoints 档里 runCase 的 model 是 checkpoint 标签——summary 如实改写为决策源名。
      case: r.case, platform: r.platform, model: useCheckpoints ? r.model : spec.name, rules: r.rules,
      subgoals_done: r.subgoals_done, all_done: r.all_done, steps: r.steps, secs: r.secs, error: r.error,
    })),
  };
  fs.mkdirSync(outdir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const dest = path.join(outdir, `${modeTag}-${stamp}.json`);
  fs.writeFileSync(dest, JSON.stringify({ summary, detail: all }, null, 1), "utf-8");
  console.log(JSON.stringify(summary, null, 2));
  return passed === all.length ? 0 : 1;
}

/** Install the ONNX runtime when the caller did not inject one (CLI use). */
async function defaultRuntime(): Promise<LayaRuntime> {
  const { createLayaOnnxRuntime } = await import("../model/laya-onnx.ts");
  const rt = createLayaOnnxRuntime();
  installLayaRuntime(rt);
  return rt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
