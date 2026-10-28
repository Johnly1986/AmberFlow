#!/usr/bin/env node
/**
 * `amber test` / `npm run test` —— 真实站点测试入口。
 *
 * 离线校验（PR 门禁）与联网运行分开；常用旗标与 run 对齐：
 *   test --validate         只读 JSON，不开浏览器、不联网
 *   test --tier smoke       快速可达性 + 地标
 *   test --tier core        短流程
 *   test --tier deep        有状态长流程
 *   test --tier probe       风控/可达性探针（非门禁）
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyConfiguredEnv } from "../support/apply-config-env.ts";
import { cliBool, cliString, parseCliArgs } from "../support/cli-args.ts";
import {
  loadBundle, selectCases, tierOf, validateBundle,
} from "../online/case.ts";
import { runSuite } from "../online/runner.ts";

const USAGE = `usage: test [--validate] [--list] [--dry-run] [--tier smoke|core|deep|probe|all|default]
             [--case ID] [--site SITE] [--headful | --headless] [--out DIR] [--json]
             [--provider NAME] [--require-all] [--max-steps N] [--timeout SEC]
             [--verbose | --quiet] [--help]

  --validate   离线校验全部 site/case（PR 门禁；不开浏览器、不联网）
  --list       列出 case（id / site / tier）
  --dry-run    只展开并打印选中的 case（不执行）
  --tier       缺省 default = smoke + core；all = smoke + core + deep；probe 需显式
  --case ID    只跑一个 case
  --site SITE  只跑一个站点
  --headful    显示浏览器窗口；--headless 显式无窗口（缺省 headless）
  --out DIR    证据目录（缺省 $AMBERFLOW_HOME/online-runs/<run-id>）
  --json       list/validate/run 都输出结构化 JSON
  --max-steps  每个 case 内子目标的执行预算（缺省 8）
  --timeout    每个 case 的整体超时秒数（覆盖 site/case 声明）
  --require-all 有 blocked/unreachable/skipped 也按失败处理（定时任务用）`;

function printCases(cases: Array<{ id: string; site: string; tier: string; goal: string }>): void {
  for (const c of cases) console.log(`${c.id}\t${c.site}\t${c.tier}\t${c.goal}`);
}

function numberArg(raw: string | undefined, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`${flag} 需要正整数（收到 ${JSON.stringify(raw)}）`);
    process.exit(2);
  }
  return n;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const rc = applyConfiguredEnv();
  if (rc.errors.length) {
    for (const e of rc.errors) console.error(e);
    return 2;
  }
  const cli = parseCliArgs(argv, {
    allowPositionals: true,
    usage: USAGE,
    options: {
      validate: { type: "boolean" },
      list: { type: "boolean" },
      "dry-run": { type: "boolean" },
      tier: { type: "string" },
      case: { type: "string" },
      site: { type: "string" },
      headful: { type: "boolean" },
      headless: { type: "boolean" },
      out: { type: "string" },
      json: { type: "boolean" },
      provider: { type: "string" },
      "require-all": { type: "boolean" },
      "max-steps": { type: "string" },
      timeout: { type: "string" },
      verbose: { type: "boolean" },
      quiet: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (!cli.ok) return cli.code;
  const v = cli.values;
  if (cliBool(v, "help")) { console.log(USAGE); return 0; }
  if (cliBool(v, "headful") && cliBool(v, "headless")) {
    console.error("--headful 与 --headless 只能选一个");
    return 2;
  }

  let bundle;
  try { bundle = loadBundle(); } catch (e) { console.error(`test: ${e instanceof Error ? e.message : String(e)}`); return 2; }
  const problems = validateBundle(bundle);
  if (problems.length) {
    for (const p of problems) console.error(`test: ${p}`);
    return 2;
  }
  if (cliBool(v, "validate")) {
    if (cliBool(v, "json")) {
      console.log(JSON.stringify({ ok: true, sites: bundle.sites.size, cases: bundle.cases.length, valid: true }, null, 2));
    } else {
      console.log(`test: ${bundle.sites.size} site(s), ${bundle.cases.length} case(s) valid`);
    }
    return 0;
  }

  const tierRaw = cliString(v, "tier") ?? "default";
  const tier = tierOf(tierRaw);
  if (tier === null) {
    console.error(`--tier 只接受 smoke|core|deep|probe|all|default（收到 ${JSON.stringify(tierRaw)}）`);
    return 2;
  }
  const cases = selectCases(bundle.cases, {
    tier: tierRaw,
    ...(cliString(v, "case") === undefined ? {} : { id: cliString(v, "case") }),
    ...(cliString(v, "site") === undefined ? {} : { site: cliString(v, "site") }),
  });
  if (!cases.length) {
    console.error(`没有选中任何 case（tier=${tierRaw}${cliString(v, "case") ? `, case=${cliString(v, "case")}` : ""}${cliString(v, "site") ? `, site=${cliString(v, "site")}` : ""}）`);
    return 2;
  }
  if (cliBool(v, "list")) {
    if (cliBool(v, "json")) {
      console.log(JSON.stringify({
        tier: tierRaw,
        cases: cases.map((c) => ({ id: c.id, site: c.site, tier: c.tier, goal: c.goal, tags: c.tags ?? [] })),
      }, null, 2));
    } else {
      printCases(cases);
    }
    return 0;
  }
  if (cliBool(v, "dry-run")) {
    console.log(JSON.stringify({
      tier: tierRaw, cases: cases.map((c) => ({ id: c.id, site: c.site, tier: c.tier, goal: c.goal, subgoals: c.subgoals?.length ?? 0 })),
    }, null, 2));
    return 0;
  }

  const json = cliBool(v, "json");
  const quiet = cliBool(v, "quiet");
  const verbose = !quiet;
  let suite, code, dir;
  try {
    ({ suite, code, dir } = await runSuite(cases, bundle.sites, {
    headless: !(cliBool(v, "headful") || cliBool(v, "headless")),
    ...(cliString(v, "max-steps") === undefined ? {} : { maxSteps: numberArg(cliString(v, "max-steps"), "--max-steps") }),
    ...(cliString(v, "timeout") === undefined ? {} : { timeoutSec: numberArg(cliString(v, "timeout"), "--timeout") }),
    ...(cliString(v, "provider") === undefined ? {} : { provider: cliString(v, "provider") }),
    ...(cliString(v, "out") === undefined ? {} : { out: cliString(v, "out") }),
    tier: tierRaw,
    verbose,
    requireAll: cliBool(v, "require-all"),
    }));
  } catch (e) { console.error(`test: ${e instanceof Error ? e.message : String(e)}`); return 2; }
  if (json) {
    console.log(JSON.stringify({ ...suite, evidence_dir: path.resolve(dir) }, null, 2));
  } else {
    console.log(`test: ${suite.passed} passed / ${suite.failed} failed / ${suite.skipped} skipped · ${(suite.duration_ms / 1000).toFixed(1)}s`);
    console.log(`evidence: ${path.resolve(dir)}`);
    for (const c of suite.cases) {
      if (c.status !== "passed") console.log(`  ${c.status.padEnd(15)} ${c.id}${c.reason ? ` — ${c.reason}` : ""}`);
    }
  }
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}