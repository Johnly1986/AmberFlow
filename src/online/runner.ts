/**
 * 线上套件运行器：真实浏览器 + 生产执行器循环。
 *
 * 不新写执行器：每个子目标仍走 `runSubgoalWithRetries`，最终仍是
 * `BrowserMiddleware.run`。这里只负责“真实站点 + 用例账 + 证据 + 分类”。
 */
import path from "node:path";
import os from "node:os";
import {
  BrowserMiddleware, browserSession, type BrowserSession,
} from "../engine/executor.ts";
import { TaskPlan } from "../engine/plan.ts";
import { runSubgoalWithRetries } from "../engine/planner.ts";
import { checkSignal } from "../engine/signals.ts";
import {
  applySpecToRuntime, installDecisionProvider, resolveProviderSpec,
} from "../model/decision-provider.ts";
import { installLayaRuntime } from "../model/model.ts";
import { checkOracle } from "./oracle.ts";
import { expandEnvValue } from "./case.ts";
import { createRun, writeCaseEvidence, writeSummary } from "./report.ts";
import type {
  CaseOutcome, OnlineCase, OnlineSite, SuiteOutcome,
} from "./types.ts";

export interface RunOptions {
  headless?: boolean;
  provider?: string;
  out?: string;
  verbose?: boolean;
  tier?: string;
  requireAll?: boolean;
  /** 与 `run --max-steps` 同名的子目标执行预算；缺省 8。 */
  maxSteps?: number;
  /** 与 run 的 `--timeout` 对齐：覆盖 site/case 的毫秒超时。 */
  timeoutSec?: number;
}

type PageAny = any;

function isLocalhost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

/** 先解析一次决策源：套件内所有 case 共用一个 provider/runtime。 */
export async function prepareDecisionSource(provider?: string): Promise<{ name: string; tier: string }> {
  const spec = await resolveProviderSpec(provider);
  if (spec.kind === "laya" && spec.tier === "off(missing)") {
    // 规则档：不装一个每步都抛的懒加载 runtime。
    installLayaRuntime(null);
    installDecisionProvider(null);
  } else {
    await applySpecToRuntime(spec);
  }
  return { name: spec.name, tier: spec.tier };
}

function tmo(site: OnlineSite, c: OnlineCase, timeoutSec?: number): number {
  const declared = c.timeout_ms ?? site.timeout_ms ?? 60_000;
  const override = timeoutSec === undefined ? undefined : timeoutSec * 1000;
  return Math.max(5_000, Math.min(300_000, override ?? declared));
}

async function pageText(page: PageAny): Promise<string> {
  try { return String(await page.locator("body").innerText({ timeout: 5_000 })); } catch { return ""; }
}

async function classify(
  page: PageAny, site: OnlineSite, target: string, timeoutMs?: number,
): Promise<{ status: "blocked" | "unreachable" | "login_required" | "captured"; reason: string }> {
  try {
    const resp = await page.goto(target, { waitUntil: "domcontentloaded", timeout: timeoutMs ?? site.timeout_ms ?? 60_000 });
    const code = typeof resp?.status === "function" ? resp.status() : 0;
    if (code === 401 || code === 403 || code === 429) {
      return { status: "blocked", reason: `HTTP ${code}` };
    }
    if (code >= 500) return { status: "unreachable", reason: `HTTP ${code}` };
    const url = String(page.url?.() ?? "");
    const text = await pageText(page);
    for (const marker of site.login_markers ?? []) {
      if (url.includes(marker) || text.includes(marker)) return { status: "login_required", reason: `login marker ${JSON.stringify(marker)}` };
    }
    for (const marker of site.blocked_markers ?? []) {
      if (text.includes(marker)) return { status: "blocked", reason: `blocked marker ${JSON.stringify(marker)}` };
    }
    return { status: "captured", reason: `HTTP ${code || "ok"}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "unreachable", reason: msg.split("\n")[0]!.slice(0, 300) };
  }
}

function newMiddleware(maxSteps = 8): BrowserMiddleware {
  return new BrowserMiddleware({
    maxSteps,
    confFloor: 0.25,
    confirmFn: () => true,
    manualConfirmFn: null,
  });
}

async function runOneCase(
  c: OnlineCase, site: OnlineSite, runDir: string, opts: RunOptions,
): Promise<{ outcome: CaseOutcome; page?: PageAny }> {
  const t0 = Date.now();
  c = expandEnvValue(c, process.env) as OnlineCase;
  const caseTimeout = tmo(site, c, opts.timeoutSec);
  const out: CaseOutcome = {
    id: c.id, site: c.site, tier: c.tier, status: "failed",
    duration_ms: 0, subgoals: [], invariants: [],
    evidence_dir: runDir,
  };
  let session: BrowserSession | null = null;
  let pageRef: PageAny | undefined;
  try {
    session = await browserSession(opts.headless !== false, c.device ?? site.device ?? null);
    const page: PageAny = session.page;
    pageRef = page;
    page.setDefaultTimeout?.(caseTimeout);
    const target = c.start_url ?? site.home;
    if (!/^https?:\/\//i.test(target)) throw new Error(`start_url must be http(s): ${target}`);
    if (isLocalhost(target) && site.allow_local !== true) throw new Error("localhost is not allowed by site.allow_local");

    const pre = await classify(page, site, target, caseTimeout);
    if (pre.status !== "captured") {
      out.status = pre.status === "blocked" ? "blocked" : pre.status === "login_required" ? "login_required" : "unreachable";
      out.reason = pre.reason;
      out.duration_ms = Date.now() - t0;
      return { outcome: out, page };
    }

    if ((c.subgoals ?? []).length > 0) {
      const plan = new TaskPlan(c.goal, c.subgoals ?? [], path.join(os.tmpdir(), `online-${c.id}.json`), c.slots ?? {});
      const mw = newMiddleware(opts.maxSteps);
      for (const sg of plan.subgoals) {
        const { rep, attempt, steps } = await runSubgoalWithRetries(
          mw as never, sg, plan, String(sg.start_url), page, session.pw, false,
        );
        const last = (steps.length ? steps[steps.length - 1] : rep.steps[rep.steps.length - 1]) as
          { method?: string; confidence?: number } | undefined;
        out.subgoals.push({
          desc: sg.desc,
          done: rep.done === true,
          attempts: attempt,
          stop_reason: String(rep.stop_reason ?? ""),
          ...(rep.stop_code === undefined ? {} : { stop_code: String(rep.stop_code) }),
          steps: steps.length || rep.steps.length,
          ...(last?.method === undefined ? {} : { method: last.method }),
          ...(last?.confidence === undefined ? {} : { confidence: last.confidence }),
        });
        if (!rep.done) {
          out.reason = `subgoal ${out.subgoals.length}: ${rep.stop_reason}`;
          break;
        }
      }
    }

    for (const inv of c.invariants ?? []) {
      const held = await checkSignal(page as never, inv.signal);
      out.invariants.push({ id: inv.id, desc: inv.desc, held });
    }
    if (c.oracle) out.oracle = await checkOracle(page, c.oracle);

    const allSub = out.subgoals.every((s) => s.done);
    const allInv = out.invariants.every((i) => i.held);
    const oracleOk = out.oracle?.ok ?? true;
    out.status = allSub && allInv && oracleOk ? "passed" : "failed";
    if (out.status === "failed" && !out.reason) {
      out.reason = [
        ...out.subgoals.filter((s) => !s.done).map((s) => `subgoal: ${s.desc}`),
        ...out.invariants.filter((i) => !i.held).map((i) => `invariant: ${i.id}`),
        ...(out.oracle && !out.oracle.ok ? [`oracle: ${out.oracle.detail}`] : []),
      ].join("; ");
    }
  } catch (e) {
    out.status = "failed";
    out.reason = e instanceof Error ? e.message : String(e);
  } finally {
    out.duration_ms = Date.now() - t0;
    // 证据必须在 close 之前取（截图/DOM 是页面上的事实）；close 后只剩结果账。
    try {
      await writeCaseEvidence({ runId: path.basename(runDir), dir: runDir }, out, pageRef);
    } catch { /* 证据失败不改变结论 */ }
    if (session) {
      try { await session.close(); } catch { /* 已关闭 */ }
    }
  }
  return { outcome: out };
}

function probeOutcome(c: OnlineCase, base: CaseOutcome): CaseOutcome {
  // 探针的“结果”是环境观测，不是产品通过/失败；预期集合内记 skipped，集合外也记 skipped
  // 但 reason 点明“未在预期集合内”，并让套件退出码 3，避免把跳过伪装成绿。
  const expected = c.expect ?? [];
  const observed = base.status;
  const inExpected = observed === "passed" ? expected.includes("captured") : expected.includes(observed as never);
  return {
    ...base,
    status: "skipped",
    reason: `probe observed=${observed} expected=${expected.join("|")}${inExpected ? "" : " (UNEXPECTED)"}`,
  };
}

export async function runSuite(
  cases: OnlineCase[], sites: Map<string, OnlineSite>, opts: RunOptions = {},
): Promise<{ suite: SuiteOutcome; code: number; dir: string }> {
  const started = Date.now();
  const run = createRun(opts.out);
  const sel = opts.tier ?? "default";
  const provider = await prepareDecisionSource(opts.provider);
  const outcomes: CaseOutcome[] = [];
  for (const c of cases) {
    const site = sites.get(c.site);
    if (!site) {
      outcomes.push({
        id: c.id, site: c.site, tier: c.tier, status: "failed", duration_ms: 0,
        reason: `unknown site ${c.site}`, subgoals: [], invariants: [],
      });
      continue;
    }
    if (opts.verbose !== false) console.error(`=== ${c.id} (${c.site}, ${c.tier}) ===`);
    const base = (await runOneCase(c, site, run.dir, opts)).outcome;
    const outcome = c.tier === "probe" ? probeOutcome(c, base) : base;
    outcomes.push(outcome);
    if (opts.verbose !== false) console.error(`  -> ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}`);
  }

  const passed = outcomes.filter((c) => c.status === "passed").length;
  const failed = outcomes.filter((c) => c.status === "failed").length;
  const skipped = outcomes.filter((c) => c.status !== "passed" && c.status !== "failed").length;
  const suite: SuiteOutcome = {
    run_id: run.runId,
    started_at: new Date(started).toISOString(),
    tier: `${sel} (provider=${provider.name}, tier=${provider.tier})`,
    cases: outcomes,
    passed, failed, skipped,
    duration_ms: Date.now() - started,
  };
  writeSummary(run, suite);
  const code = failed > 0 ? 1 : skipped > 0 ? (opts.requireAll ? 1 : 3) : 0;
  return { suite, code, dir: run.dir };
}