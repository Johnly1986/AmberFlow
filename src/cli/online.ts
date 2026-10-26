#!/usr/bin/env node
/**
 * `amber online` / `npm run online` —— 真实线上用例入口。
 *
 * 离线校验（PR 门禁）与联网运行分开：
 *   online --validate       只读 JSON，不开浏览器、不联网
 *   online --tier smoke     快速可达性 + 地标
 *   online --tier core      短流程
 *   online --tier deep      有状态长流程
 *   online --tier probe     风控/可达性探针（非门禁）
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyConfiguredEnv } from "../support/apply-config-env.ts";
import { cliBool, cliString, parseCliArgs } from "../support/cli-args.ts";
import {
  loadBundle, selectCases, tierOf, validateBundle,
} from "../online/case.ts";
import { runSuite } from "../online/runner.ts";

const USAGE = `usage: online [--validate] [--list] [--dry] [--tier smoke|core|deep|probe|all|default]
              [--case ID] [--site SITE] [--headed] [--out DIR] [--json]
              [--provider NAME] [--require-all] [--verbose | --quiet] [--help]

  --validate   离线校验全部 site/case（PR 门禁；不开浏览器、不联网）
  --list       列出 case（id / site / tier）
  --dry        只展开并打印选中的 case（不执行）
  --tier       缺省 default = smoke + core；all = smoke + core + deep；probe 需显式
  --case ID    只跑一个 case
  --site SITE  只跑一个站点
  --headed     显示浏览器窗口
  --out DIR    证据目录（缺省 $AMBERFLOW_HOME/online-runs/<run-id>）
  --json       stdout 只输出 summary JSON
  --require-all 有 blocked/unreachable/skipped 也按失败处理（定时任务用）`;

function printCases(cases: Array<{ id: string; site: string; tier: string }>): void {
  for (const c of cases) console.log(`${c.id}\t${c.site}\t${c.tier}`);
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
      dry: { type: "boolean" },
      tier: { type: "string" },
      case: { type: "string" },
      site: { type: "string" },
      headed: { type: "boolean" },
      out: { type: "string" },
      json: { type: "boolean" },
      provider: { type: "string" },
      "require-all": { type: "boolean" },
      verbose: { type: "boolean" },
      quiet: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (!cli.ok) return cli.code;
  const v = cli.values;
  if (cliBool(v, "help")) { console.log(USAGE); return 0; }

  let bundle;
  try { bundle = loadBundle(); } catch (e) { console.error(`online: ${e instanceof Error ? e.message : String(e)}`); return 2; }
  const problems = validateBundle(bundle);
  if (problems.length) {
    for (const p of problems) console.error(`online: ${p}`);
    return 2;
  }
  if (cliBool(v, "validate")) {
    console.log(`online: ${bundle.sites.size} site(s), ${bundle.cases.length} case(s) valid`);
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
  if (cliBool(v, "list")) { printCases(cases); return 0; }
  if (cliBool(v, "dry")) {
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
    headless: !cliBool(v, "headed"),
    ...(cliString(v, "provider") === undefined ? {} : { provider: cliString(v, "provider") }),
    ...(cliString(v, "out") === undefined ? {} : { out: cliString(v, "out") }),
    tier: tierRaw,
    verbose,
    requireAll: cliBool(v, "require-all"),
    }));
  } catch (e) { console.error(`online: ${e instanceof Error ? e.message : String(e)}`); return 2; }
  if (json) {
    console.log(JSON.stringify({ ...suite, evidence_dir: path.resolve(dir) }, null, 2));
  } else {
    console.log(`online: ${suite.passed} passed / ${suite.failed} failed / ${suite.skipped} skipped · ${(suite.duration_ms / 1000).toFixed(1)}s`);
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