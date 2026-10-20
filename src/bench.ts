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
import { isParseUsageError, usageErrorLine } from "./cli-args.ts";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import * as browserEnv from "./browser-env.ts";
import { MockAuditor, type Auditor } from "./audit.ts";
import { BrowserMiddleware } from "./executor.ts";
import { REPO } from "./flow.ts";
import { TaskPlan, type Subgoal } from "./plan.ts";
import { checkSignal } from "./signals.ts";
import { runSubgoalWithRetries } from "./planner.ts";
import { installLayaRuntime, type DecisionAgent, type LayaRuntime } from "./model.ts";
import { applySpecToRuntime, installDecisionProvider, resolveProviderSpec } from "./decision-provider.ts";
import { createOutcomeMemory, type OutcomeMemoryLike } from "./outcome-memory.ts";
import { createHintMemory, type HintMemoryLike } from "./hint-memory.ts";
import { applyRcToEnv } from "./rcfile.ts";

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
  /** Cross-run outcome memory (see src/outcome-memory.ts). */
  outcomeMemory?: OutcomeMemoryLike | null;
  /** "forbid" (default) removes a remembered element; "rank" annotates it instead. */
  outcomeMemoryMode?: "forbid" | "rank";
  /** Cross-run learned hints (see src/hint-memory.ts). */
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
  const browser = (await browserEnv.launch({ chromium } as never)) as unknown as {
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

export async function main(argv: string[] = process.argv.slice(2), deps: BenchMainDeps = {}): Promise<number> {
  // rc 文件坏 = 配置类用法错误：在任何腿出场之前逐行点名并 exit 2（src/rcfile.ts）。
  { const rc = applyRcToEnv(); if (rc.errors.length) { for (const e of rc.errors) console.error(e); return 2; } }
  let parsed;
  // 打错的参数 → 一行点名，绝不甩 parseArgs 的堆栈（src/cli-args.ts 的体例）。
  try {
    parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cases: { type: "string" }, out: { type: "string" }, "mode-tag": { type: "string" },
      only: { type: "string" }, "fixtures-only": { type: "boolean" },
      "force-model": { type: "string" }, "force-rules": { type: "string" },
      // Ablation knob: the confidence floor is a GATE, so its setting must be
      // measurable on the same cases (see docs/decision-model-survey.md).
      "force-conf-floor": { type: "string" },
      // Outcome memory: remember elements that proved inert on a page+subgoal so a
      // retry does not walk into them again (see src/outcome-memory.ts).
      "outcome-memory": { type: "string" },
      "outcome-memory-file": { type: "string" },
      // forbid (default) removes a remembered-inert element; rank keeps it and annotates
      // it in the model's view (the two ways to use the same observation).
      "outcome-memory-mode": { type: "string" },
      // Learned hints: remember the stable handle of a pick that WORKED, so the next run
      // of the same page+subgoal needs no model call (see src/hint-memory.ts).
      "hint-memory": { type: "string" },
      "hint-memory-file": { type: "string" },
      // Ablation: strip the AUTHORED hints, leaving the model (and any learned hints) to
      // decide — the regime in which a learned hint is measurable.
      "force-hints": { type: "string" },
      // 智能缺省：决策源解析与安装走 apps/suite/start/bench 共用的那一扇门
      // （本地产物就绪→本地 checkpoints；配了 provider→在线；都没配→规则档如实降级）。
      provider: { type: "string" },
    },
  });
  } catch (err) {
    if (!isParseUsageError(err)) throw err;
    console.error(usageErrorLine(err));
    return 2;
  }
  const v = parsed.values;
  const casesPath = v.cases ? path.resolve(v.cases) : path.join(REPO, "bench", "cases.json");
  const outdir = path.resolve(v.out ?? path.join(REPO, "bench", "results"));
  const modeTag = v["mode-tag"] ?? "baseline";

  let cases = (JSON.parse(fs.readFileSync(casesPath, "utf-8")) as { cases: BenchCase[] }).cases;
  if (v.only) cases = cases.filter((c) => c.id === v.only);
  if (v["fixtures-only"]) cases = cases.filter((c) => c.platform.startsWith("fixture:"));
  if (!cases.length) throw new Error("no cases selected");
  for (const c of cases) {
    if (v["force-model"]) c.model = String(v["force-model"]);
    if (v["force-rules"] !== undefined) c.rules = v["force-rules"] === "on";
    if (v["force-conf-floor"] !== undefined) c.conf_floor = Number(v["force-conf-floor"]);
    if (v["force-hints"] === "off") {
      for (const sg of c.subgoals ?? []) {
        delete (sg as { target_hint?: string }).target_hint;
        delete (sg as { target_hints?: string[] }).target_hints;
      }
    }
  }

  // 智能缺省（apps/suite/start/bench 四门同一实现）：先解析决策源，再决定走哪条腿——
  // checkpoints 腿只在"真 laya 在场（就绪或测试注入了 runtime）"时才预载；
  // 配了在线 provider 就直接问 provider；什么都没配 ⇒ 规则档如实降级（以前是当场崩）。
  let spec;
  try {
    spec = await resolveProviderSpec(v.provider);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const useCheckpoints = deps.runtime != null || (spec.kind === "laya" && spec.tier === "on");
  if (v["force-model"] !== undefined && !useCheckpoints) {
    // 旗标语义只在 checkpoints 上有意义；在别的决策源上静默忽略会让一整轮 A/B 白跑。
    console.error(`--force-model 选的是 laya checkpoint，在决策源 ${JSON.stringify(spec.name)}（tier=${spec.tier}）上没有意义；换模型用 --provider。`);
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
    console.log(`checkpoints loaded: ${JSON.stringify(Object.keys(agents))}\n`);
  } else if (spec.kind === "laya" && spec.tier === "off(missing)") {
    // 规则档如实降级（旧行为是当场崩）：不装一个逐步 config-refuse 的懒加载 runtime——
    // 执行器进 rulesOnly，语料里被点名的步照规则跑。model_status 如实记 off(missing)。
    // 两扇全局都清：执行器优先显式 provider，同进程残留会让规则档标签说谎。
    installLayaRuntime(null);
    installDecisionProvider(null);
    console.log(`决策源：${spec.name}（tier=${spec.tier}）→ 走规则档\n`);
  } else {
    await applySpecToRuntime(spec);
    console.log(`决策源：${spec.name}（tier=${spec.tier}）\n`);
  }

  const all: BenchCaseResult[] = [];
  const mem = v["outcome-memory"] === "on"
    ? createOutcomeMemory({ path: (v["outcome-memory-file"] as string | undefined) ?? null })
    : null;
  const hints = v["hint-memory"] === "on"
    ? createHintMemory({ path: (v["hint-memory-file"] as string | undefined) ?? null })
    : null;
  for (const c of cases) {
    console.log(`=== ${c.id} (${c.platform}, model=${c.model ?? "english"}) ===`);
    try {
      all.push(await runCase(c, agents, mem, hints,
        (v["outcome-memory-mode"] as "forbid" | "rank" | undefined) ?? "forbid"));
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
    console.log();
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
  const { createLayaOnnxRuntime } = await import("./laya-onnx.ts");
  const rt = createLayaOnnxRuntime();
  installLayaRuntime(rt);
  return rt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
