import type { CliContext } from "./context.ts";
import { diag, say } from "./context.ts";
import { usageError } from "./errors.ts";
import { runExecutable } from "./process.ts";
import { REPO } from "../support/paths.ts";

interface LegacySpec {
  entry?: string;
  prefix?: string[];
  npm?: boolean;
  /** 新写法，只用于提示；实际执行仍走旧入口以保持行为逐字节一致。 */
  equivalent: string;
}

/**
 * 旧 46 个 script 的兼容表。
 *
 * Phase 0 的目标是**行为不变**：这里直接转发旧入口，不把旧调用方偷偷换成新默认值
 * （例如 `start --plan` 仍是保存位置，`apps` 无参数仍 exit 2，`learn` 仍 headless）。
 * 新默认值只在 `amber run/record/plan` 里生效。
 */
const LEGACY: Record<string, LegacySpec> = {
  start: { entry: "src/cli/start.ts", equivalent: "amber run --demo" },
  doctor: { entry: "src/cli/start.ts", prefix: ["--doctor"], equivalent: "amber doctor" },
  "model:fetch": { entry: "src/model/model-fetch.ts", equivalent: "amber model fetch --from <url|路径>" },
  apps: { entry: "src/app/app-runner.ts", equivalent: "amber apps list / amber run <id>" },
  learn: { entry: "tools/learn.ts", equivalent: "amber record --headless" },
  agent: { entry: "tools/learn.ts", prefix: ["--json", "--yes"], equivalent: "amber record --headless --yes --json" },
  "plan-cli": { entry: "tools/plan_cli.ts", equivalent: "amber plan" },
  semantic: { entry: "src/flow/semantic-flow.ts", equivalent: "amber dev semantic" },
  "plan:flow": { entry: "src/flow/plan-flow.ts", equivalent: "amber dev plan-flow" },
  bench: { entry: "src/cli/bench.ts", equivalent: "amber dev bench" },
  "bench:fixtures": {
    entry: "src/cli/bench.ts",
    prefix: ["--fixtures-only", "--mode-tag", "smoke", "--out", "bench/results"],
    equivalent: "amber dev bench --fixtures-only --mode-tag smoke --out bench/results",
  },
  "apps:matrix": { entry: "tools/apps_matrix.ts", equivalent: "amber dev matrix" },
  shortlist: { entry: "tools/shortlist_demo.ts", equivalent: "amber dev shortlist" },
  "ip-config": { entry: "src/cli/ip-config.ts", equivalent: "amber dev legacy ip-config" },
  "camera-entry": { entry: "src/cli/camera-entry.ts", equivalent: "amber dev legacy camera-entry" },
  "picker-server": { entry: "src/cli/picker-server.ts", equivalent: "amber dev serve picker" },
  induce: { entry: "tools/induce_signal.ts", equivalent: "amber dev induce" },
  "cache:measure": { entry: "tools/cache_measure.ts", equivalent: "amber dev measure cache" },
  calibration: { entry: "tools/calibration.ts", equivalent: "amber dev measure calibration" },
  "model:contribution": { entry: "tools/model-contribution.ts", equivalent: "amber dev measure contribution" },
  "hint:measure": { entry: "tools/hint_measure.ts", equivalent: "amber dev measure hints" },
  "apps:suite": { entry: "tools/apps_suite.ts", equivalent: "amber dev suite" },
  "apps:gen": { entry: "tools/spec-to-pack.ts", equivalent: "amber dev generate" },
  "probes:baseline": { entry: "tools/probe-baseline.ts", equivalent: "amber dev measure probes" },
  "apps:induce": { entry: "tools/apps-induce.ts", equivalent: "amber dev apps-induce" },
  metrics: { entry: "tools/arch-metrics.ts", equivalent: "amber dev measure metrics" },
  "gate:signals": { entry: "tools/gate-signals.ts", equivalent: "amber dev measure gate" },
  "nominate:measure": { entry: "tools/instruction_nomination.ts", equivalent: "amber dev measure nominations" },
  "providers:baseline": { entry: "tools/provider-baselines.ts", equivalent: "amber dev providers baseline" },
  "probe:tokenplan": { entry: "tools/probe-tokenplan.mjs", equivalent: "amber dev providers probe" },
  "nominate:online": {
    entry: "tools/instruction_nomination.ts",
    prefix: ["--provider", "token-plan"], equivalent: "amber dev providers nominate",
  },
  "nominate:context": {
    entry: "tools/instruction_nomination.ts",
    prefix: ["--context", "--provider", "token-plan"], equivalent: "amber dev providers nominate --context",
  },
  parity: { entry: "tools/parity.ts", equivalent: "amber dev parity rules" },
  "parity:extraction": { entry: "tools/extraction-parity.ts", equivalent: "amber dev parity extraction" },
  "parity:executor": { entry: "tools/executor-parity.ts", equivalent: "amber dev parity executor" },
  "parity:datasource": { entry: "tools/datasource-parity.ts", equivalent: "amber dev parity datasource" },
  "parity:ctrip": { entry: "tools/ctrip-parity.ts", equivalent: "amber dev parity ctrip" },
  "parity:transfer": { entry: "tools/transfer-parity.ts", equivalent: "amber dev parity transfer" },
  typecheck: { npm: true, equivalent: "amber dev verify" },
  test: { npm: true, equivalent: "amber dev verify" },
  "test:watch": { npm: true, equivalent: "amber dev verify" },
  "test:bridge": { npm: true, equivalent: "amber dev verify" },
  "test:bridge:offline": { npm: true, equivalent: "amber dev verify" },
  "test:parity": { npm: true, equivalent: "amber dev parity all" },
  verify: { npm: true, equivalent: "amber dev verify" },
  prepare: { npm: true, equivalent: "npm run prepare" },
};

export function legacyEquivalent(name: string): string | null {
  return LEGACY[name]?.equivalent ?? null;
}

export function legacyNames(): string[] {
  return Object.keys(LEGACY).sort();
}

export async function runLegacy(name: string | undefined, args: string[], ctx: CliContext): Promise<number> {
  if (!name || name === "--help" || name === "-h" || name === "help") {
    say(ctx, "兼容层：amber legacy <旧命令> [参数]");
    say(ctx, "");
    say(ctx, "旧命令到新写法的对应（实际执行仍走旧入口以保持默认值）：");
    for (const [key, spec] of Object.entries(LEGACY).sort(([a], [b]) => a.localeCompare(b))) {
      say(ctx, `  ${key.padEnd(22)} → ${spec.equivalent}`);
    }
    return name ? 0 : 2;
  }
  const spec = LEGACY[name];
  if (!spec) {
    throw usageError(`未知的旧命令 '${name}'`, {
      hint: "用 amber legacy 查看完整兼容表。",
      next: ["amber legacy"],
    });
  }
  diag(ctx, `提示：${name} 是旧命令；新写法：${spec.equivalent}`);

  if (spec.npm) {
    const npmArgs = ["run", name, ...(args.length ? ["--", ...args] : [])];
    return runExecutable("npm", npmArgs, {
      // 兼容层不消费新配置层：旧入口仍只看到调用前的环境 + 自己的旧 rc。
      cwd: REPO, env: ctx.baseEnv, shell: process.platform === "win32",
      // `ctx.runEntry` 的全局超时包装只覆盖 TS 入口；npm 直跑也要吃到同一秒数。
      timeoutMs: ctx.globals.timeout !== null ? Number(ctx.globals.timeout) * 1000 : null,
    });
  }
  return ctx.runEntry(spec.entry!, [...(spec.prefix ?? []), ...args], {
    cwd: REPO,
    env: ctx.baseEnv,
  });
}
