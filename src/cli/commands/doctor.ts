import path from "node:path";
import { parseArgs } from "node:util";
import type { CliContext } from "../context.ts";
import { say, diag, emitJson } from "../context.ts";
import { usageFromParseError } from "../errors.ts";
import { successEnvelope } from "../json.ts";
import { runExecutable } from "../process.ts";
import { REPO } from "../../support/paths.ts";
import { ensureDir, userAppsDir } from "../../app/amberflow-home.ts";
import { listAppInfos } from "./apps.ts";
import { userConfigPath, projectConfigPath, resolveConfig } from "../config-store.ts";
import { cliInvocationLine, detectCliInvocation, INVOKE_FALLBACKS, LINK_HINT } from "../invocation.ts";
import { missingPieces } from "../../model/model-artifacts.ts";

export async function runDoctor(args: string[], ctx: CliContext): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: "boolean" }, fix: { type: "boolean" },
        verbose: { type: "boolean" }, help: { type: "boolean" },
      },
    });
  } catch (err) {
    throw usageFromParseError(err);
  }
  const v = parsed.values;
  if (v.help) {
    const { commandHelp } = await import("../registry.ts");
    say(ctx, commandHelp("doctor"));
    return 0;
  }

  const [{ preflight, doctorReport }, provider, baselines] = await Promise.all([
    import("../start.ts"),
    import("../../model/decision-provider.ts"),
    import("../../model/decision-baselines.ts"),
  ]);
  await Promise.all([
    import("../../model/decision-jevk5.ts").then((m) => m.registerJevK5()),
    import("../../model/decision-bailian.ts").then((m) => m.registerBailian()),
    import("../../model/decision-tokenplan.ts").then((m) => m.registerTokenPlan()),
    import("../../model/decision-service.ts").then((m) => m.registerDecisionService()),
  ]);
  baselines.registerBaselines();

  let p = preflight();
  if (v.fix) {
    const fixes: string[] = [];
    ensureDir(path.dirname(userConfigPath(ctx.env)));
    ensureDir(path.dirname(projectConfigPath(ctx.cwd)));
    ensureDir(userAppsDir(ctx.env));
    fixes.push(`已确保配置目录：${path.dirname(userConfigPath(ctx.env))}`);
    fixes.push(`已确保应用目录：${userAppsDir(ctx.env)}`);
    if (!p.chromium) {
      const installHint = "Chromium 缺失，执行 npx playwright install chromium …";
      if (v.json || ctx.globals.json) diag(ctx, installHint);
      else say(ctx, installHint);
      const code = await runExecutable("npx playwright install chromium", [], {
        cwd: REPO, env: ctx.env, shell: true,
        // JSON 模式 stdout 只能有一个对象；安装进度属于人类日志。
        stdoutToStderr: Boolean(v.json || ctx.globals.json),
      });
      fixes.push(code === 0 ? "已执行 npx playwright install chromium" : `playwright install 退出码 ${code}`);
      p = preflight();
    }
    if (v.json || ctx.globals.json) {
      // 修复动作的人话进 stderr，stdout 仍只有一个 JSON。
      for (const f of fixes) diag(ctx, f);
    } else {
      for (const f of fixes) say(ctx, `  ✓ ${f}`);
    }
  }

  const report = doctorReport(p);
  const invocation = detectCliInvocation(ctx.baseEnv);
  const config = resolveConfig(ctx.baseEnv, ctx.cwd, ctx.explicitConfig);
  const apps = listAppInfos(ctx);
  const userCount = apps.filter((a) => a.source === "user").length;
  let providerDefault: { name: string; tier: string } | null = null;
  let providerError: string | null = null;
  try {
    const dflt = await provider.resolveProviderSpec(undefined);
    providerDefault = { name: dflt.name, tier: String(dflt.tier) };
  } catch (err) {
    providerError = err instanceof Error ? err.message : String(err);
  }
  const providers = provider.listDecisionProviders();
  // 决策源解析失败是“可用性警告”，不是核心阻塞项；退出码只看 Node / Chromium / 配置。
  const exitCode = report.ok && config.errors.length === 0 ? 0 : 2;

  if (v.json || ctx.globals.json) {
    const envelope = successEnvelope("doctor", {
      node: { version: p.node, ok: p.nodeOk },
      chromium: { path: p.chromium, ok: p.chromium !== null },
      model: {
        ready: p.model, artifacts: p.artifacts, missing: p.model ? [] : missingPieces(p.artifacts),
      },
      llm: { configured: p.llm },
      provider: { default: providerDefault, error: providerError, available: providers },
      // 裸 `amber` 能不能敲：这是"照着 README 复制却 CommandNotFound"的唯一线索。
      cli: {
        linked: invocation.linked,
        path: invocation.path,
        fallbacks: invocation.linked ? [] : [...INVOKE_FALLBACKS],
        link_hint: invocation.linked ? null : LINK_HINT,
      },
      config: {
        layers: config.layers.map((l) => ({
          name: l.name, path: l.path, exists: l.exists, count: Object.keys(l.values).length, errors: l.errors,
        })),
        errors: config.errors,
      },
      apps: { total: apps.length, user: userCount, builtin: apps.length - userCount },
      report: report.lines,
    }, {
      exitCode,
      diagnostics: config.errors,
      next: exitCode ? ["amber config show", "amber doctor --fix"] : ["amber online --tier smoke"],
    });
    if (exitCode !== 0) {
      envelope.ok = false;
      envelope.error = {
        code: "CONFIG",
        message: report.ok ? "配置不合法" : "核心环境项缺失",
        hint: "先修 Node / Chromium / 配置；amber doctor --fix 只做安全修复。",
        next: ["amber config show", "amber doctor --fix"],
      };
    }
    emitJson(ctx, envelope);
    return exitCode;
  }

  say(ctx, "AmberFlow doctor");
  say(ctx, "");
  for (const line of report.lines) say(ctx, line);
  const invocationLine = cliInvocationLine(invocation);
  say(ctx, `CLI 入口     ${invocationLine.status}`);
  for (const hint of invocationLine.hints) say(ctx, `             ${hint}`);
  say(ctx, "");
  for (const line of config.layers.flatMap((l) => [
    `${l.name}：${l.path ?? "（无）"}${l.exists ? `（${Object.keys(l.values).length} 项）` : "（不存在）"}`,
    ...l.errors.map((e) => `  ✗ ${e}`),
  ])) say(ctx, line);
  const legacyLayer = config.layers[0];
  if (legacyLayer?.exists && Object.keys(legacyLayer.values).length > 0) {
    say(ctx, "提示：旧 rc 仍可读；建议用 amber config set 迁移到用户配置，迁移后旧文件只作兼容。");
  }
  if (v.verbose || ctx.globals.verbose) {
    say(ctx, `工作目录：${ctx.cwd}`);
    say(ctx, `用户配置：${userConfigPath(ctx.env)}`);
    say(ctx, `项目配置：${projectConfigPath(ctx.cwd)}`);
    say(ctx, `应用目录：${userAppsDir(ctx.env)}`);
  }
  say(ctx, "");
  say(ctx, `应用：${apps.length} 个（${userCount} 个用户 / ${apps.length - userCount} 个内置）`);
  if (providerDefault) {
    say(ctx, `当前决策源：${providerDefault.name}（tier=${providerDefault.tier}）`);
  } else if (providerError) {
    say(ctx, `当前决策源：解析失败（${providerError}）`);
  }
  if (exitCode !== 0) {
    say(ctx, "");
    say(ctx, "下一步：amber doctor --fix / amber config show");
  }
  return exitCode;
}
