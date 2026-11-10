import path from "node:path";
import { parseArgs } from "node:util";
import type { CliContext } from "../context.ts";
import { say, diag, emitJson } from "../context.ts";
import { usageFromParseError } from "../errors.ts";
import { successEnvelope } from "../json.ts";
import { runExecutable } from "../process.ts";
import { REPO } from "../../support/paths.ts";
import { ensureDir, userAppsDir } from "../../support/amberflow-home.ts";
import { listAppInfos } from "./apps.ts";
import { userConfigPath, projectConfigPath, resolveConfig } from "../../support/config-store.ts";
import { cliInvocationLine, detectCliInvocation, INVOKE_FALLBACKS, LINK_HINT } from "../invocation.ts";
import { missingPieces } from "../../model/model-artifacts.ts";
// task-14：探针底座共享（run 起跑探测与 doctor 单一出处）。
import { probeDecisionPlane } from "../../model/decision-probe.ts";

export async function runDoctor(args: string[], ctx: CliContext): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: "boolean" }, fix: { type: "boolean" },
        verbose: { type: "boolean" }, help: { type: "boolean" },
        "ask-probe": { type: "boolean" },
        // A5：探针改为缺省执行（仅在线决策源存在时）；这两个旗标只用于显式强制/关闭。
        "no-ask-probe": { type: "boolean" },
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
  const apps = await listAppInfos(ctx);
  const userCount = apps.filter((a) => a.source === "user").length;
  let providerDefault: { name: string; tier: string } | null = null;
  let providerError: string | null = null;
  try {
    const dflt = await provider.resolveProviderSpec(undefined);
    providerDefault = { name: dflt.name, tier: String(dflt.tier) };
  } catch (err) {
    // A5：解析期错误已附「两条通道」指引；JSON 的 `provider.error` 仍只放事实（旧字段语义不变），
    // 指引在文本输出与文档里给。
    providerError = provider.decisionFailureFact(err);
  }
  const providers = provider.listDecisionProviders();
  // A3（决策源对齐）：真实 ask 探针。doctor 的静态检查只看"配置项在不在"，看不出凭据是否
  // 真能过网关——实测有"配置齐全 + 403 AccessDenied.Unpurchased"的组合，引擎把它吞成静默降级。
  // A5：探针改为**缺省执行**（仅当在线决策源存在：AMBERFLOW_DECISION_BASE_URL 非空），
  // 否则 doctor 全绿却跑不动应用的错位仍要靠用户想起加旗标才能发现。探针走与运行时**同一**
  // 装配路径真发一次最小 ask（一次请求）；`--no-ask-probe` 关闭（部署侧不希望默认请求），
  // `--ask-probe` 强制（没有在线源也发，用来确认"真的没配"）。
  // 医生只诊断：探针成败**不改变退出码**（exitCode 与它无关），失败只如实多报事实 + 通道指引。
  const decisionServiceConfigured = (ctx.env.AMBERFLOW_DECISION_BASE_URL ?? "").trim() !== "";
  const askProbeDisabled = v["no-ask-probe"] === true;
  const askProbeForced = v["ask-probe"] === true;
  const askProbe = !askProbeDisabled && (askProbeForced || decisionServiceConfigured)
    ? await runAskProbe(provider)
    : null;
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
      provider: {
        default: providerDefault, error: providerError, available: providers,
        // A5：探针真跑过才出现这个字段（没配在线决策源 / --no-ask-probe 时缺席——
        // 那种情况下的 JSON 形状与旧版逐字段一致）。
        ...(askProbe === null ? {} : { ask_probe: askProbe }),
      },
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
      next: exitCode ? ["amber config show", "amber doctor --fix"] : ["amber test --tier smoke"],
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
    // JSON 模式 stdout 只能有一个对象：提示/指引走 stderr（diag），信封形状不变。
    if (askProbe === null) {
      diag(ctx, askProbeDisabled
        ? "提示：已按 --no-ask-probe 跳过 ask 探针（探针只诊断，不改退出码）"
        : "提示：未配置在线决策源（AMBERFLOW_DECISION_BASE_URL），ask 探针未发请求；--ask-probe 可强制");
    } else if (!askProbe.ok) {
      diag(ctx, `ask 探针失败：${askProbe.error ?? "未知失败"}`);
      for (const line of decisionChannelHintLines(provider.DECISION_CHANNEL_GUIDANCE)) diag(ctx, line);
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
  // A3/A5：探针结果单独一行（或未发请求时的提示）。成败都不动退出码——医生只诊断。
  if (askProbe === null) {
    say(ctx, askProbeDisabled
      ? "ask 探针     已按 --no-ask-probe 跳过（探针只诊断，不改退出码）"
      : "ask 探针     未发请求——未配置在线决策源（AMBERFLOW_DECISION_BASE_URL）；--ask-probe 可强制");
  } else if (askProbe.ok) {
    say(ctx, `ask 探针     ✓ ${askProbe.provider}：ref=${JSON.stringify(askProbe.ref)} conf=${askProbe.conf?.toFixed(2) ?? "-"}`);
  } else {
    say(ctx, `ask 探针     ✗ ${askProbe.error ?? "未知失败"}`);
    // A5：失败时把「两条通道」指引当场给全——403 在这个仓里最常见的两个原因就是
    // 走错了配置面（桥部署配置 vs CLI 用户配置）。只提示，不自动切换。
    const [bridgeHalf, cliHalf] = provider.DECISION_CHANNEL_GUIDANCE.split("；");
    say(ctx, `             恢复指引     ① ${bridgeHalf}`);
    if (cliHalf !== undefined) say(ctx, `                          ② ${cliHalf}`);
  }
  if (exitCode !== 0) {
    say(ctx, "");
    say(ctx, "下一步：amber doctor --fix / amber config show");
  }
  return exitCode;
}

/** A3/A5：`doctor` 缺省 ask 探针（`--no-ask-probe` 可关）的一次结果。医生只诊断：成败都不影响退出码。 */
interface AskProbeResult {
  /** 实际装配的决策源名（探针跳过/装配失败时如实给名字或 unknown）。 */
  provider: string;
  ok: boolean;
  /** ok=true：模型在最小考卷（3 个假候选）里选中的 ref 与把握值。 */
  ref?: string | null;
  conf?: number;
  /**
   * ok=false：HTTP 状态码 + 错误关键句（或跳过原因）；文本只来自响应体/网络错误，绝无凭据。
   * A5：统一追加的「两条通道」指引已剥离——JSON 字段要的是可比较的事实，指引在文本/stderr。
   */
  error?: string;
}

/**
 * `doctor` 缺省执行（在线决策源存在时；`--ask-probe` 强制、`--no-ask-probe` 关闭）的 ask 探针：
 * 用与运行时**完全相同**的装配路径（resolveProviderSpec → applySpecToRuntime → provider.pick）
 * 真实发一次最小 pick 请求（一次 HTTP 请求，超时按 `AMBERFLOW_DECISION_TIMEOUT_MS`）。
 * doctor 的静态段只证明"配置项在不在"，证明不了"凭据真的能过网关"——2026-11-02 实测：
 * 三层配置齐全、doctor 全绿，三件套凭据在网关上是 403 AccessDenied.Unpurchased，而引擎把这次
 * 失败吞成「模型被咨询 1 次（1 次未过闸门）」静默降级。这个探针就是那类故障的直达检查：
 * HTTP 成败给 ref/conf，失败给状态码+错误关键句（不含也不回显任何凭据）。
 * task-14：探针底座抽到 `model/decision-probe.ts` 共享（run 起跑探测与 doctor 单一出处）。
 */
async function runAskProbe(
  provider: typeof import("../../model/decision-provider.ts"),
): Promise<AskProbeResult> {
  const r = await probeDecisionPlane();
  const out: AskProbeResult = { provider: r.provider, ok: r.ok };
  if (r.ok) { out.ref = r.ref ?? null; out.conf = r.conf; }
  else out.error = r.error ?? "未知失败";
  return out;
}

/**
 * A5：把 decision-provider 的统一「两条通道」指引拆成两行（桥 / CLI）。
 * 文案唯一出处仍是 `DECISION_CHANNEL_GUIDANCE`——这里只排版，不另抄一份。
 */
function decisionChannelHintLines(guidance: string): string[] {
  const [bridgeHalf, cliHalf] = guidance.split("；");
  return [
    `  ① ${bridgeHalf}`,
    ...(cliHalf === undefined ? [] : [`  ② ${cliHalf}`]),
  ];
}
