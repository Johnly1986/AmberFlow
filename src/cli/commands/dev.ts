import path from "node:path";
import type { CliContext } from "../context.ts";
import { say, diag, emitJson } from "../context.ts";
import { usageError } from "../errors.ts";
import { runExecutable, runNodeEntryCapture } from "../process.ts";
import { successEnvelope } from "../json.ts";
import { REPO } from "../../support/paths.ts";

const PARITY: Record<string, string> = {
  rules: "tools/parity.ts",
  extraction: "tools/extraction-parity.ts",
  executor: "tools/executor-parity.ts",
  datasource: "tools/datasource-parity.ts",
  ctrip: "tools/ctrip-parity.ts",
  transfer: "tools/transfer-parity.ts",
};

const MEASURE: Record<string, string> = {
  cache: "tools/cache_measure.ts",
  hints: "tools/hint_measure.ts",
  calibration: "tools/calibration.ts",
  contribution: "tools/model-contribution.ts",
  nominations: "tools/instruction_nomination.ts",
  probes: "tools/probe-baseline.ts",
  metrics: "tools/arch-metrics.ts",
  gate: "tools/gate-signals.ts",
};

const LEGACY: Record<string, string> = {
  "ip-config": "src/cli/ip-config.ts",
  "camera-entry": "src/cli/camera-entry.ts",
  "long-task": "src/cli/long-task.ts",
  "path-a": "src/cli/path-a.ts",
  "tune-guard": "src/cli/tune-guard.ts",
};

export async function runDev(args: string[], ctx: CliContext): Promise<number> {
  const sub = args[0];
  if (sub === undefined || sub === "--help" || sub === "-h") {
    const { commandHelp } = await import("../registry.ts");
    say(ctx, commandHelp("dev"));
    return 0;
  }
  const rest = args.slice(1);
  switch (sub) {
    case "suite": {
      // 旧文档里的 --real-model 已经是默认臂；接受但不再改变任何行为。
      if (rest.includes("--real-model")) diag(ctx, "提示：suite 默认就是真模型；--real-model 已无操作。");
      const suiteArgs = rest.filter((a) => a !== "--real-model");
      return runDevJson("tools/apps_suite.ts", suiteArgs, ctx, "dev suite");
    }
    case "matrix":
      return runDevJson("tools/apps_matrix.ts", rest, ctx, "dev matrix");
    case "verify":
      return runExecutable("npm run verify", [], { cwd: REPO, env: ctx.env, shell: true });
    case "bench":
      return ctx.runEntry("src/cli/bench.ts", rest, { cwd: ctx.cwd, env: ctx.env });
    case "parity":
      return runParity(rest, ctx);
    case "measure": {
      const name = rest[0];
      if (!name || !MEASURE[name]) {
        throw usageError(`未知的 dev measure 目标 '${name ?? "（缺）"}'`, {
          hint: `可用：${Object.keys(MEASURE).join(" / ")}`,
          next: ["amber dev --help"],
        });
      }
      return ctx.runEntry(MEASURE[name]!, rest.slice(1), { cwd: ctx.cwd, env: ctx.env });
    }
    case "providers":
      return runProviders(rest, ctx);
    case "generate":
      return ctx.runEntry("tools/spec-to-pack.ts", rest, { cwd: ctx.cwd, env: ctx.env });
    case "shortlist":
      return ctx.runEntry("tools/shortlist_demo.ts", rest, { cwd: ctx.cwd, env: ctx.env });
    case "induce":
      return ctx.runEntry("tools/induce_signal.ts", rest, { cwd: ctx.cwd, env: ctx.env });
    case "apps-induce":
      return ctx.runEntry("tools/apps-induce.ts", rest, { cwd: ctx.cwd, env: ctx.env });
    case "plan-flow":
      return ctx.runEntry("src/flow/plan-flow.ts", rest, { cwd: ctx.cwd, env: ctx.env });
    case "semantic":
      return ctx.runEntry("src/flow/semantic-flow.ts", rest, { cwd: ctx.cwd, env: ctx.env });
    case "serve":
    case "picker-server":
      if (rest[0] === "picker") {
        return ctx.runEntry("src/cli/picker-server.ts", rest.slice(1), { cwd: ctx.cwd, env: ctx.env });
      }
      throw usageError("dev serve 目前只支持 picker", { hint: "amber dev serve picker" });
    case "legacy":
      return runLegacyDev(rest, ctx);
    default:
      throw usageError(`未知的 dev 子命令 '${sub}'`, {
        hint: "可用：suite / matrix / verify / bench / parity / measure / providers / generate / shortlist / induce / plan-flow / semantic / serve / legacy",
        next: ["amber dev --help"],
      });
  }
}

/**
 * suite / matrix 已经支持 `--json` 且 stdout 只有一个对象；把它们包成统一信封。
 * 其它 dev 子命令仍原样转发——`dev` 是维护面，不能假装所有旧工具都有结构化结果。
 */
async function runDevJson(
  entry: string,
  args: string[],
  ctx: CliContext,
  command: string,
): Promise<number> {
  if (!ctx.globals.json) {
    return ctx.runEntry(entry, args, { cwd: ctx.cwd, env: ctx.env });
  }
  const timeoutMs = ctx.globals.timeout !== null ? Number(ctx.globals.timeout) * 1000 : null;
  const childArgs = args.includes("--json") ? args : [...args, "--json"];
  const { code, stdout } = await runNodeEntryCapture(entry, childArgs, {
    cwd: ctx.cwd,
    env: ctx.env,
    timeoutMs,
  });
  let data: unknown = null;
  let diagnostics: string[] = [];
  try {
    data = JSON.parse(stdout.trim());
  } catch {
    diagnostics = ["旧入口的 stdout 不是一个 JSON 对象，已原样放进 data.raw_stdout。"];
    data = { raw_stdout: stdout.trim() };
  }
  const next = code === 0 ? ["amber dev matrix"] : ["amber doctor", "amber apps list"];
  const envelope = successEnvelope(command, data, { exitCode: code, diagnostics, next });
  if (code !== 0) {
    envelope.ok = false;
    envelope.error = {
      code: code === 4 ? "QUALITY_GATE" : code === 3 ? "BLOCKED" : code === 2 ? "USAGE" : "INCOMPLETE",
      message: `${command} 未通过（退出码 ${code}）`,
      hint: "逐应用日志与诊断在 stderr；结构化数据在 data。",
      next,
    };
  }
  emitJson(ctx, envelope);
  return code;
}

async function runParity(rest: string[], ctx: CliContext): Promise<number> {
  const layer = rest[0] ?? "all";
  const extra = rest.slice(1);
  if (layer === "all") {
    for (const [name, entry] of Object.entries(PARITY)) {
      say(ctx, `— parity ${name} —`);
      const code = await ctx.runEntry(entry, extra, { cwd: ctx.cwd, env: ctx.env });
      if (code !== 0) return code;
    }
    return 0;
  }
  const entry = PARITY[layer];
  if (!entry) {
    throw usageError(`未知的 parity 层 '${layer}'`, {
      hint: `可用：${Object.keys(PARITY).join(" / ")} / all`,
      next: ["amber dev parity all"],
    });
  }
  return ctx.runEntry(entry, extra, { cwd: ctx.cwd, env: ctx.env });
}

async function runProviders(rest: string[], ctx: CliContext): Promise<number> {
  const which = rest[0];
  const extra = rest.slice(1);
  switch (which) {
    case "baseline":
      return ctx.runEntry("tools/provider-baselines.ts", extra, { cwd: ctx.cwd, env: ctx.env });
    case "probe":
      return ctx.runEntry("tools/probe-baseline.ts", extra, { cwd: ctx.cwd, env: ctx.env });
    case "tokenplan":
      return ctx.runEntry("tools/probe-tokenplan.mjs", extra, { cwd: ctx.cwd, env: ctx.env });
    case "nominate":
      return ctx.runEntry("tools/instruction_nomination.ts",
        ["--provider", "token-plan", ...extra], { cwd: ctx.cwd, env: ctx.env });
    default:
      throw usageError(`未知的 dev providers 目标 '${which ?? "（缺）"}'`, {
        hint: "可用：baseline / probe / tokenplan / nominate",
        next: ["amber dev providers baseline"],
      });
  }
}

async function runLegacyDev(rest: string[], ctx: CliContext): Promise<number> {
  const name = rest[0];
  const entry = name ? LEGACY[name] : undefined;
  if (!entry) {
    throw usageError(`未知的 dev legacy 命令 '${name ?? "（缺）"}'`, {
      hint: `可用：${Object.keys(LEGACY).join(" / ")}`,
      next: ["amber dev --help"],
    });
  }
  return ctx.runEntry(entry, rest.slice(1), { cwd: ctx.cwd, env: ctx.env });
}

/** `dev` 的路径检查用：保留给将来的 --json envelope。 */
export function devRepo(): string {
  return path.resolve(REPO);
}
