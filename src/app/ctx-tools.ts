/**
 * createCtx 的工具步原语（进程观察面）：一次干跑/确认/幂等重试的实现 + ctx.run/ctx.dangerous 门面。
 *
 * 从 createCtx 闭包提取为显式 deps（CtxRuntime）；产物形状由 app-runner 投影，本文件不新增字段。
 */
import { capToolText, stderrTail } from "./tool-artifact.ts";
import { pushEvent } from "./trace.ts";
import { validateToolSignal } from "../browser/tool-signals.ts";
import type { ToolSignal } from "../browser/tool-signals.ts";
import { StopError } from "./ctx-types.ts";
import type { StepResult, ToolRunRequest, ToolRunResult, Ctx } from "./ctx-types.ts";
import { declaredRunProblems, resolveRunAdapter } from "./ctx-validate.ts";
import { toolReturns, toolFailureReason } from "./ctx-tool.ts";
import type { CtxRuntime } from "./ctx-runtime.ts";

export function createCtxTools(rt: CtxRuntime): Pick<Ctx, "run" | "dangerous"> {
    const { deps, trace, budget, assertOpen, checkBudget, paceBeforeStep } = rt;

  /**
   * 工具步结果的**唯一收口**（命令行/声明两形式共用）：有界 output、失败诊断、数据集回写、
   * trace 事件。三条纪律都在这里，脚本面无法绕过：
   *   - 返回值只在**信号成立**后写（`ok !== true` 一个都不写）；
   *   - `writtenBy = <id|desc>#<attempts>`（与声明式路径同一形状，审计能数到第几次尝试）；
   *   - 失败原因带底层证据（exit code + stderr 尾行），不是 `refusalLine` 空壳。
   */
  const finishToolRun = (
    r: ToolRunResult, started: number, call: "run" | "dangerous",
    desc: string, req: { source: string; id?: string; adapter?: string },
  ): StepResult => {
    const ok = r.ok === true;
    const stopCode = r.stopCode ?? (ok ? undefined : (r.refused ?? "tool_failed"));
    const attempts = r.attempts ?? 1;
    const elapsedMs = Date.now() - started;
    const out = capToolText(r.stdout);
    const err = capToolText(r.stderr);
    const tail = stderrTail(r.stderr);
    const reason = stopCode === undefined
      ? r.reason
      : toolFailureReason(stopCode, r.code, tail, r.reason);
    // 数据集回写（T2）：步标识必须是**稳定非空**字符串；`desc` 在两条入口都有缺省，不会空。
    const written: string[] = [];
    const stepKey = (req.id !== undefined && req.id.trim() ? req.id.trim() : desc).trim();
    if (ok && r.returns !== undefined && deps.dataset !== undefined && stepKey) {
      const writtenBy = `${stepKey}#${attempts}`;
      for (const [name, value] of Object.entries(r.returns)) {
        deps.dataset.write(name, value, writtenBy);
        written.push(name);
      }
    }
    const hasOutput = out.text.length > 0 || err.text.length > 0
      || (r.code !== null && r.code !== undefined);
    const isCli = req.adapter === undefined || req.adapter === "cli";
    const result: StepResult = {
      ok,
      ...(stepKey && req.id !== undefined ? { id: stepKey } : {}),
      ...(stopCode === undefined ? {} : { stopCode }),
      ...(reason === undefined ? {} : { reason }),
      ...(hasOutput ? {
        output: {
          code: r.code ?? null, stdout: out.text, stderr: err.text,
          ...(out.truncated || err.truncated ? { truncated: true as const } : {}),
        },
      } : {}),
      ...(r.artifact === undefined ? {} : { artifact: r.artifact }),
      evidence: { url: rt.currentUrl, attempts, elapsedMs },
    };
    pushEvent(trace, {
      call, desc, ok,
      ...(stopCode === undefined ? {} : { stop_code: stopCode }),
      // 08-C：attempts/code/refused 进事件 result（投影面从这里读，不再只有脚本侧 evidence）。
      // T6：工具步至少带 code/ok（事件顶层 ok）/artifact/stderr_tail——失败也带结构化事实，不是空壳。
      result: {
        source: req.source,
        ...(isCli ? {} : { adapter: req.adapter }),
        ...(stepKey && req.id !== undefined ? { id: stepKey } : {}),
        attempts, code: r.code ?? null, refused: r.refused ?? null,
        ...(isCli ? { dry_run: r.dryRun ?? null } : (r.dryRun === undefined ? {} : { dry_run: r.dryRun })),
        elapsed_ms: elapsedMs,
        ...(r.artifact === undefined ? {} : { artifact: r.artifact }),
        ...(tail === undefined ? {} : { stderr_tail: tail }),
        // T4：信号不成立的结构化诊断（path/类型/值摘要）也进 trace——投影面/报告从
        // 同一份事件重建，不再只剩「signal not held」。
        ...(stopCode !== undefined && r.reason !== undefined ? { reason: r.reason } : {}),
        ...(written.length > 0 ? { dataset_written: written } : {}),
      },
    });
    return result;
  };

  const runTool = async (source: string, args: string[], req: ToolRunRequest, dangerous: boolean): Promise<StepResult> => {
    if (typeof source !== "string" || !source.trim()) throw new StopError("config_error", "ctx.run: source must be a non-empty string");
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new StopError("config_error", "ctx.run: args must be a list of strings");
    if (req === null || typeof req !== "object" || req.done === undefined || req.done === null) {
      throw new StopError("config_error", "ctx.run: done signal is required (completion is the process observation)");
    }
    // T7：工具信号载荷的运行期兜底（与 dry 同一份校验器）。坏载荷是配置错误，
    // 不能落到 `checkToolSignal` 里静默 false。
    const signalProblems = validateToolSignal(req.done as ToolSignal, `ctx.run(${JSON.stringify(req.desc ?? source)}).done`);
    if (signalProblems.length) {
      throw new StopError("config_error", signalProblems.join("；"));
    }
    if (dangerous && (!Array.isArray(req.dryRunArgs) || req.dryRunArgs.length === 0)) {
      throw new StopError("config_error", "ctx.dangerous requires dryRunArgs (a failed dry run must never apply)");
    }
    if (deps.toolRunner === undefined) {
      throw new StopError("config_error", "ctx.run: no tool runner wired in this build");
    }
    // 与声明式适配器同一条纪律（load 期就该红；ctx 在运行期补一次，flow 也逃不掉）。
    if ((req.retries ?? 0) > 0 && req.idempotent !== true) {
      throw new StopError("config_error",
        `ctx.run: retries=${req.retries} needs idempotent: true (re-running a process can be irreversible)`);
    }
    // `returns` 只认既有 `ReturnExtractor` 声明面（缺失/形状错 = fail closed，不给模型开口子）。
    const returns = toolReturns(req.returns, `ctx.run(${JSON.stringify(req.desc ?? source)})`);
    assertOpen(`ctx.run` + (req.desc ? ` ${JSON.stringify(req.desc)}` : ""));
    checkBudget();
    await paceBeforeStep();
    const started = Date.now();
    let r: ToolRunResult;
    try {
      r = await deps.toolRunner({
        ...req, desc: req.desc ?? (dangerous ? `dangerous ${source}` : `run ${source}`),
        ...(req.id === undefined ? {} : { id: req.id.trim() || undefined }),
        returns, source, args, ...(dangerous ? { dangerous: true } : {}),
      });
    } catch (e) {
      // 工具源名/配置错（如 loadSource 抛）不能变成裸栈：给结构化 config_error。
      throw new StopError("config_error",
        `ctx.run: ${e instanceof Error ? e.message : String(e)}`);
    }
    budget.stepsUsed += 1;
    return finishToolRun(r, started, dangerous ? "dangerous" : "run",
      req.desc ?? source, { source, ...(req.id === undefined ? {} : { id: req.id }) });
  };

  /** 声明形式：挑适配器 → 交给驱动（与声明式 journey 同一套适配器实现）。 */
  const runDeclaredTool = async (step: Record<string, unknown>, dangerous: boolean): Promise<StepResult> => {
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      throw new StopError("config_error", "ctx.run: the declaration form needs an object like { stdio: {...}, done: {...} }");
    }
    const done = step["done"];
    // T7：未知顶层键/`signal` 冲突/done 必需在真实与 dry 两面念同一段文案
    // （`declaredRunProblems` 是唯一出处）。
    const declaredProblems = declaredRunProblems(step);
    if (declaredProblems.length) {
      throw new StopError("config_error", declaredProblems.join("；"));
    }
    const adapter = resolveRunAdapter(step);
    // `returns`/`id` 在两条分支（cli 委托 / 其它适配器直跑）前统一规范化一次。
    const declaredSource = typeof step["source"] === "string" ? step["source"] : "";
    const declaredDesc = typeof step["desc"] === "string" && step["desc"]
      ? step["desc"]
      : adapter === "cli" ? `cli:${declaredSource || "declared"}` : `${adapter} step`;
    const declaredReturns = toolReturns(step["returns"], `ctx.run(${JSON.stringify(declaredDesc)})`);
    const declaredId = typeof step["id"] === "string" && step["id"].trim() ? step["id"].trim() : undefined;
    if (adapter === "cli") {
      // 声明形式的 cli 步与命令行形式完全等价（args/dryRunArgs/idempotent/retries 都认）。
      const cliArgs = Array.isArray(step["args"]) ? (step["args"] as unknown[]).map(String) : [];
      const cliReq: ToolRunRequest = {
        desc: declaredDesc,
        source: declaredSource, done: done as Record<string, unknown>, adapter: "cli", rawStep: step,
        ...(declaredId === undefined ? {} : { id: declaredId }),
        ...(declaredReturns === null ? {} : { returns: declaredReturns }),
        ...(Array.isArray(step["dryRunArgs"]) ? { dryRunArgs: (step["dryRunArgs"] as unknown[]).map(String) } : {}),
        ...(step["idempotent"] === true ? { idempotent: true } : {}),
        ...(typeof step["retries"] === "number" ? { retries: step["retries"] } : {}),
        ...(dangerous ? { dangerous: true } : {}),
      };
      return runTool(declaredSource, cliArgs, cliReq, dangerous);
    }
    if (deps.toolRunner === undefined) throw new StopError("config_error", "ctx.run: no tool runner wired in this build");
    checkBudget();
    await paceBeforeStep();
    const started = Date.now();
    const desc = declaredDesc;
    let r: ToolRunResult;
    try {
      r = await deps.toolRunner({
        desc, source: declaredSource || `${adapter}:declared`,
        done: done as Record<string, unknown>, adapter, rawStep: step,
        ...(declaredId === undefined ? {} : { id: declaredId }),
        ...(declaredReturns === null ? {} : { returns: declaredReturns }),
        ...(dangerous ? { dangerous: true } : {}),
      });
    } catch (e) {
      throw new StopError("config_error", `ctx.run: ${e instanceof Error ? e.message : String(e)}`);
    }
    budget.stepsUsed += 1;
    return finishToolRun(r, started, dangerous ? "dangerous" : "run", desc, {
      source: declaredSource || `${adapter}:declared`,
      adapter,
      ...(declaredId === undefined ? {} : { id: declaredId }),
    });
  };

  return {
    run: (async (sourceOrStep: unknown, args?: string[], req?: unknown): Promise<StepResult> => {
      if (typeof sourceOrStep === "string") {
        return runTool(sourceOrStep, args ?? [], req as ToolRunRequest, false);
      }
      const step = sourceOrStep as Record<string, unknown>;
      return runDeclaredTool(step, false);
    }) as Ctx["run"],
    dangerous: async (req) => {
      if (!Array.isArray(req?.dryRunArgs) || req.dryRunArgs.length === 0) {
        throw new StopError("config_error", "ctx.dangerous requires dryRunArgs (a failed dry run must never apply)");
      }
      return runTool(req.source, req.args, req as ToolRunRequest, true);
    },
  };
}
