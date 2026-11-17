/**
 * 工具步执行（从 app-runner.ts 纯搬移，大文件拆分 A1b）：dry-run 探针 → 危险步确认 →
 * 幂等重试 → 工具信号/工件；`RUN_SEQ`（`{run_id}` 进程内唯一序号）随本模块。
 */
/** 进程内运行序号：保证同一毫秒内连续两次运行也不会撞上同一个 `{run_id}`。 */
let RUN_SEQ = 0;

import os from "node:os";
import path from "node:path";
import { checkToolSignal, explainToolSignal, type ToolSignal } from "../browser/tool-signals.ts";
import { cliRunDetailed, defaultDates, loadSource, urlFor, type CliObservation, ValueError } from "../data/datasource.ts";
import { substituteDatasetPlaceholders } from "./app-adapters.ts";
import type {  ExpandedStep  } from "./app-pack.ts";
import { refusalLine } from "./app-runner-types.ts";
import type {  AppRunOptions, ToolStepEvidence, ToolStepResult  } from "./app-runner-types.ts";

/** 相对 start_url 按仓库根解析成 file://。 */
export async function runToolStep(
  step: ExpandedStep, opts: AppRunOptions = {},
): Promise<ToolStepResult> {
  const rawTool = step.tool!;
  const src = loadSource(rawTool.source);
  // `{out_dir}` 是运行期占位符（写到哪儿），不是计划里的值：在这里换成真实输出目录
  const outDir = opts.outDir ?? path.dirname(opts.planPath ?? path.join(os.tmpdir(), "app"));
  // `{run_id}`：**每次运行唯一**（进程内单调序号 + 毫秒时间戳 + pid），给"跨调用有状态"的参数用
  // （重试计数等）。只用秒级时间戳是不够的：同一秒里连跑两次会复用同一个计数文件，
  // 于是第二次运行"看起来"第一次就成功了——那正是 G-K 要修的不可复现。
  const runId = opts.runId
    ?? `${Date.now().toString(36)}-${process.pid}-${++RUN_SEQ}`;
  // `{out_dir}` 是运行期占位符（写到哪儿），不是计划里的值：argv、干跑 argv 和 signal 里
  // 的路径（file_exists / file_absent）都要换成真实输出目录，否则"产物落地了吗"永远为假。
  const missingDataset = new Set<string>();
  const sub = (v: unknown): unknown => {
    if (typeof v === "string") {
      // Slice 2：`{dataset:NAME}` 从运行级数据集现读（缺失 = 结构化 needs_value，绝不猜；
      // 与 `{out_dir}`/`{run_id}` 同一条"运行期占位符"纪律，只是值来自前序步骤）。
      // 替换的**唯一实现**在 `app-adapters.substituteDatasetPlaceholders`——手抄一份同名的正则
      // 就会两份实现各扫各的，正是本仓库的复发缺陷形状。
      const withRuntime = v.split("{out_dir}").join(outDir).split("{run_id}").join(runId);
      const { value, missing } = substituteDatasetPlaceholders(withRuntime, opts.dataset);
      for (const m of missing) missingDataset.add(m);
      return value;
    }
    if (Array.isArray(v)) return v.map(sub);
    if (typeof v === "object" && v !== null) {
      const o: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) o[k] = sub(vv);
      return o;
    }
    return v;
  };
  const t = { ...rawTool, signal: sub(rawTool.signal) as ToolSignal };
  // 参数里的运行期占位符一次解析完（干跑与 apply 用同一份），缺失值在**任何副作用之前**停。
  const resolvedArgs = t.args.map((a) => String(sub(a)));
  const resolvedDry = t.dry_run_args === null ? null : t.dry_run_args.map((a) => String(sub(a)));
  const base: ToolStepResult = {
    index: step.index, desc: step.desc, source: t.source, signal: t.signal, argv: [],
    attempts: 0, done: false, dry_run: null, code: null, ok: false, stdout: "", stderr: "",
  };

  if (missingDataset.size > 0) {
    base.refused = "needs_value";
    base.stderr = `missing dataset value(s): ${[...missingDataset].join(", ")} `
      + `（{dataset:NAME} 只认前序步骤在信号成立后写的值；没有就停，不猜）`;
    if (opts.verbose) console.log(`  [${step.index}] tool ${t.source}: NEEDS_VALUE (${base.stderr})`);
    return base;
  }

  // 工具步的 source URL（default_dates / {slot} 日期参数在这里解析）。
  // 坏日期参数/缺槽位值是**配置类结果**（结构化 refusal），不是崩溃——上层能在结果 JSON 里读到。
  let target: string;
  try {
    target = urlFor(src, defaultDates(src, opts.slotBag ?? opts.slots ?? null, opts.today)[0]!);
  } catch (e) {
    if (e instanceof ValueError) {
      base.refused = "config_error";
      base.stderr = `source ${t.source}: ${e.message}`;
      if (opts.verbose) console.log(`  [${step.index}] tool ${t.source}: CONFIG_ERROR (${base.stderr})`);
      return base;
    }
    throw e;
  }

  const unavailable = (e: unknown): void => {
    base.refused = "tool-unavailable";
    base.stderr = `${e instanceof Error ? e.name : typeof e}: `
      + `${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
    if (opts.verbose) console.log(`  [${step.index}] tool ${t.source}: UNAVAILABLE (${base.stderr})`);
  };

  let dry: CliObservation | null = null;
  if (t.dry_run_args) {
    try {
      dry = await cliRunDetailed(target, 60, src, resolvedDry ?? []);
    } catch (e) {
      // 缺二进制 / 超时被杀：干跑起不来 => 不 apply，并且如实上报（不抛栈）
      unavailable(e);
      return base;
    }
    base.dry_run = { code: dry.code, ok: dry.ok, stdout: dry.stdout, argv: dry.argv };
    if (opts.verbose) {
      console.log(`  [${step.index}] dry-run ${t.source}: exit ${dry.code}${dry.ok ? "" : " (not ok)"}`);
    }
    if (!dry.ok) {
      base.refused = "dry-run-failed";
      return base;
    }
  }
  if (t.dangerous) {
    const evidence: ToolStepEvidence = {
      desc: step.desc, source: t.source, argv: dry?.argv ?? t.args,
      dry_run: dry ? { code: dry.code, ok: dry.ok, stdout: dry.stdout, stderr: dry.stderr } : null,
    };
    let allowed = opts.allowDangerous === true;
    if (opts.confirmToolStep) allowed = await opts.confirmToolStep(step.desc, evidence);
    if (!allowed) {
      base.refused = opts.confirmToolStep ? "declined" : "dangerous";
      if (opts.verbose) console.log(`  [${step.index}] ${refusalLine(base.refused)} —— ${step.desc}`);
      return base;
    }
  }
  const tries = Math.max(1, 1 + (t.idempotent ? t.retries : 0));
  for (let i = 1; i <= tries; i++) {
    base.attempts = i;
    let o: CliObservation;
    try {
      o = await cliRunDetailed(target, 60, src, resolvedArgs);
    } catch (e) {
      unavailable(e);
      break;
    }
    base.argv = o.argv;
    base.code = o.code;
    base.ok = o.ok;
    base.stdout = o.stdout;
    base.stderr = o.stderr;
    const held = checkToolSignal(o, t.signal);
    // T4：信号不成立时把**观察事实**写进 reason（path/类型/值摘要、exit/stdout 期望），
    // 不再只剩 `tool_failed: exit 0`。重试后成立则删掉上一次的诊断（成功步不带失败话术）。
    if (held) delete base.reason;
    else base.reason = explainToolSignal(o, t.signal).join("; ");
    if (opts.verbose) {
      console.log(`  [${step.index}] tool ${t.source}: exit ${o.code}, signal ${held ? "held" : "not yet"}`
        + (i > 1 ? ` (attempt ${i})` : ""));
    }
    if (held) { base.done = true; break; }
  }
  return base;
}
