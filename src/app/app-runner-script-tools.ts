/**
 * flow 面的工具步适配（从 `app-runner.runScriptApp` 拆出）：`ctx.run` 的唯一实现——
 * 干跑/确认/幂等重试仍接既有 `runToolStep`（不复制），非 cli 适配器走应用层同一份
 * `getAppAdapter` 实现；工件落盘与 `returns` 抽取也集中在这一处。
 */
import { type ToolRunRequest, type ToolRunResult } from "./ctx.ts";
import { type ManualStepRun, extractProcessReturns, getAppAdapter } from "./app-adapters.ts";
import type { ExpandedStep } from "./app-pack.ts";
import { refusalLine, type AppRunOptions, type ToolStepResult } from "./app-runner-types.ts";
import { runToolStep } from "./app-runner-tool-step.ts";
import { capToolText, writeToolStepArtifact } from "./tool-artifact.ts";
import type { DatasetStore } from "../engine/dataset.ts";

/** 工具步适配需要的运行期面（值来自 `runScriptApp` 的本次运行）。 */
export interface ScriptToolRunnerDeps {
  opts: AppRunOptions;
  outDir: string;
  runId: string;
  verbose: boolean;
  /** 声明槽位（数据腿/CLI 合并后的真值袋；工具步 `{slot}` 占位符从这里取）。 */
  slots: Record<string, unknown>;
  dataset: DatasetStore;
  /** 敏感值清单（工件落盘前统一掩码；与 result 收尾同一份）。 */
  secretValues: string[];
}

export function createScriptToolRunner(
  deps: ScriptToolRunnerDeps,
): (req: ToolRunRequest) => Promise<ToolRunResult> {
  const { opts, outDir, runId, verbose, slots, dataset, secretValues } = deps;
  /**
   * T1：工具步工件序号（每次 flow 运行从 1 起；只用于**文件名**，不是步骤 id）。
   * T1：把一次工具步的进程观察落成工件（`scrubSecrets` 掩码 → `outDir/tool-steps/NN-slug.json`）。
   * 返回相对 outDir 的 posix 路径；写不了就返回 undefined（工件失败不改变工具步结论）。
   */
  let toolStepSeq = 0;
  const writeToolArtifact = (
    started: number,
    desc: string,
    source: string,
    adapter: string | undefined,
    obs: {
      code: number | null; stdout: string; stderr: string; attempts: number; ok: boolean;
      stopCode?: string; argv?: string[]; args?: string[]; reason?: string;
    },
  ): string | undefined => {
    const seq = ++toolStepSeq;
    const out = capToolText(obs.stdout);
    const err = capToolText(obs.stderr);
    const artifact = writeToolStepArtifact(outDir, seq, desc, {
      index: seq, desc, source,
      ...(adapter === undefined ? {} : { adapter }),
      ...(obs.args === undefined ? {} : { args: obs.args }),
      ...(obs.argv === undefined ? {} : { argv: obs.argv }),
      code: obs.code, ok: obs.ok,
      ...(obs.stopCode === undefined ? {} : { stop_code: obs.stopCode }),
      ...(obs.reason === undefined ? {} : { reason: obs.reason }),
      attempts: obs.attempts, elapsed_ms: Date.now() - started,
      stdout: out.text, stderr: err.text,
      ...(out.truncated || err.truncated ? { truncated: true as const } : {}),
    }, secretValues);
    return artifact ?? undefined;
  };
  /** 工具步：接到既有 `runToolStep`（干跑/确认/幂等重试的唯一实现，不复制）。 */
  return async (req: ToolRunRequest): Promise<ToolRunResult> => {
    // ① 非 cli 适配器：与声明式 journey 用**同一份**适配器实现（validate → expand → run）。
    //    若 ctx.run 硬编码 `adapter:"cli"`，声明式能写的 ssh/stdio 步在 flow 脚本里不可表达。
    if (req.adapter !== undefined && req.adapter !== "cli") {
      const adapter = getAppAdapter(req.adapter);
      const base = { code: null as number | null, stdout: "", stderr: "", attempts: 0 };
      if (adapter === undefined) {
        return { ok: false, stopCode: "config_error", reason: `unknown app adapter ${JSON.stringify(req.adapter)}`, ...base };
      }
      const where = `ctx.run(${JSON.stringify(req.desc)})`;
      const raw = { ...(req.rawStep ?? {}), signal: req.done };
      const problems: string[] = [];
      let decl: unknown;
      try {
        adapter.validateStep(raw, where, problems);
        if (!problems.length) decl = adapter.expand(raw, where).decl;
      } catch (e) {
        return { ok: false, stopCode: "config_error", reason: e instanceof Error ? e.message : String(e), ...base };
      }
      if (problems.length) return { ok: false, stopCode: "config_error", reason: problems.join("；"), ...base };
      const step = {
        index: 0, adapter: adapter.kind, kind: adapter.legacyKind,
        desc: req.desc, role: null, id: null, next: [], decl,
      } as unknown as ExpandedStep;
      const started = Date.now();
      const adapterCtx = {
        // T2：适配器的 `{dataset:NAME}` 占位符也从这份运行级数据集现读（stdio argv 等）。
        outDir, verbose, runId, dataset,
        runWebStep: async (): Promise<{ done: boolean }> => { throw new Error("ctx.run: browser steps go through ctx.step()"); },
        runCliStep: async (): Promise<ToolStepResult> => { throw new Error("ctx.run: use the cli form for cli steps"); },
        runManualStep: async (): Promise<ManualStepRun> => ({
          done: false, reason: "manual steps are declared in the journey, not executed through ctx.run",
        }),
      };
      const out = await adapter.run(decl, step, adapterCtx);
      const t = out.tool;
      const stopCode = out.done ? undefined : (t?.refused ?? "tool_failed");
      // T1：非 cli 步同样落工件 + 把适配器抽出的 returns 交回 ctx（ctx 负责写数据集）。
      const artifact = writeToolArtifact(started, req.desc, req.source, adapter.kind, {
        code: t?.code ?? null, stdout: t?.stdout ?? "", stderr: t?.stderr ?? "",
        attempts: t?.attempts ?? 1, ok: out.done,
        ...(stopCode === undefined ? {} : { stopCode }),
        ...(t?.reason === undefined ? {} : { reason: t.reason }),
        ...(t?.argv === undefined ? {} : { argv: t.argv }),
      });
      return {
        ok: out.done,
        ...(stopCode === undefined ? {} : { stopCode }),
        ...(t?.refused === undefined ? {} : { refused: t.refused }),
        // T4：优先信号诊断（path/类型/值摘要）；没有才退回 stderr 首行。
        ...(t?.reason ? { reason: t.reason }
          : t?.stderr ? { reason: t.stderr.split("\n")[0]!.slice(0, 300) } : {}),
        ...(out.returns === undefined ? {} : { returns: out.returns }),
        code: t?.code ?? null, stdout: t?.stdout ?? "", stderr: t?.stderr ?? "",
        attempts: t?.attempts ?? 1,
        ...(t?.dry_run ? { dryRun: t.dry_run } : {}),
        ...(artifact === undefined ? {} : { artifact }),
      };
    }
    // ② cli（默认）：接到 runToolStep。
    const decl = {
      source: req.source,
      args: req.args ?? [],
      dry_run_args: req.dryRunArgs ?? null,
      signal: req.done as never,
      retries: req.retries ?? 0,
      idempotent: req.idempotent === true,
      dangerous: req.dangerous === true,
      // T2：`returns` 走既有 `ReturnExtractor` 声明面（校验在 ctx 侧，fail closed）。
      returns: req.returns ?? null,
    };
    const step = {
      index: 0, adapter: "cli", kind: "tool",
      desc: req.desc, role: null, id: null, next: [], decl, tool: decl,
    } as unknown as ExpandedStep;
    const started = Date.now();
    const r = await runToolStep(step, { ...opts, outDir, runId, verbose, slotBag: slots });
    const stopCode = r.done ? undefined : (r.refused ?? "tool_failed");
    // T2：信号成立后按**同一份** `extractProcessReturns` 抽取（与声明式适配器同源）。
    const returns = r.done && req.returns !== null && req.returns !== undefined
      ? extractProcessReturns(req.returns, { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code })
      : undefined;
    const artifact = writeToolArtifact(started, req.desc, req.source, undefined, {
      code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "", attempts: r.attempts, ok: r.done,
      ...(stopCode === undefined ? {} : { stopCode }),
      ...(r.reason === undefined ? {} : { reason: r.reason }),
      args: req.args ?? [],
      ...((r.argv ?? []).length > 0 ? { argv: r.argv } : {}),
    });
    return {
      ok: r.done,
      ...(stopCode === undefined ? {} : { stopCode }),
      // T4：信号诊断（path/类型/值摘要）优先；有底层 stderr 时由 ctx 组
      // 「exit + stderr 尾行」的诊断；两者都没有才退到拒绝话术。
      ...(stopCode === undefined ? {}
        : r.reason !== undefined ? { reason: r.reason }
          : (r.stderr ?? "").trim() === "" ? { reason: refusalLine(stopCode) } : {}),
      ...(r.refused === undefined ? {} : { refused: r.refused }),
      ...(returns === undefined ? {} : { returns }),
      code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "", attempts: r.attempts,
      ...(r.dry_run === null ? {} : { dryRun: r.dry_run }),
      ...(artifact === undefined ? {} : { artifact }),
    };
  };
}
