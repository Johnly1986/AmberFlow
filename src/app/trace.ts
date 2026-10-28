/**
 * L2 执行轨迹（`AppTrace`）——脚本应用的**审计产物**。
 *
 * 为什么不是新的"计划文件"：L2 的控制流在脚本里（`flow(ctx)`），运行前没有静态步骤表；
 * 能审计的是"这一版脚本、这一组输入，实际发生了什么"。所以 trace = 版本 + 输入 + 逐次 ctx 调用。
 *
 * 三条纪律：
 *   1. **版本可钉**：`script_sha256` + `inputs_sha256`；重放时不一致就拒跑（不猜）。
 *   2. **只记事实**：每次调用的种类/参数摘要/结果（ok、stop_code），不记模型自由文本。
 *   3. **确定性可测**：同一脚本+输入两次运行，`events` 序列必须相同（`verifyReplay`）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type TraceCall =
  | "open" | "openPage" | "arrive" | "step" | "read" | "extract" | "holds" | "waitFor" | "source"
  | "run" | "dangerous" | "manual" | "done" | "log";

export interface TraceEvent {
  /** 第几次 ctx 调用（1-based，贯穿一次运行）。 */
  i: number;
  call: TraceCall;
  /** 步骤/调用的说明（`step`/`arrive` 有）。 */
  desc?: string;
  /** 作者声明的稳定步骤标识（`ctx.step({ id })` / `ctx.arrive({ id })`）。 */
  id?: string;
  url?: string;
  ok?: boolean;
  stop_code?: string;
  /** 只读观察的结果摘要（JSON 可序列化；不包含模型文本）。 */
  result?: unknown;
}

export interface AppTrace {
  schema_version: 1;
  app: string;
  script_sha256: string;
  /** 槽位 + CLI 输入（**不含**每次运行都变的 outDir/runId）。 */
  inputs_sha256: string;
  events: TraceEvent[];
  done: boolean;
  stop_code?: string;
  stop_reason?: string;
  /** 结束时是否所有不变量成立（没有不变量时 true）。 */
  invariants_ok?: boolean;
}

/** 确定性序列化（键排序）——与 `app-script.canonicalJson` 同一口径（这里再导出一次避免循环依赖）。 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = walk((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export function sha256(text: string | Buffer): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** 输入指纹：槽位（以及声明的 hosts）——故意不含 outDir/runId（它们每次运行都变）。 */
export function inputsSha256(slots: Record<string, unknown>, hosts: string[] = []): string {
  return sha256(canonicalJson({ slots, hosts }));
}

export function newTrace(init: {
  app: string; script_sha256: string; inputs_sha256: string;
}): AppTrace {
  return { schema_version: 1, ...init, events: [], done: false };
}

/** 追加一条事件并返回它（`i` 由 trace 自己编号，调用方不用维护计数）。 */
export function pushEvent(trace: AppTrace, ev: Omit<TraceEvent, "i">): TraceEvent {
  const full: TraceEvent = { i: trace.events.length + 1, ...ev };
  trace.events.push(full);
  return full;
}

export function finishTrace(trace: AppTrace, end: {
  done: boolean; stop_code?: string; stop_reason?: string; invariants_ok?: boolean;
}): AppTrace {
  trace.done = end.done;
  if (end.stop_code !== undefined) trace.stop_code = end.stop_code;
  if (end.stop_reason !== undefined) trace.stop_reason = end.stop_reason;
  if (end.invariants_ok !== undefined) trace.invariants_ok = end.invariants_ok;
  return trace;
}

export function writeTrace(file: string, trace: AppTrace): string {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(trace, null, 2) + "\n", "utf-8");
  return file;
}

export function readTrace(file: string): AppTrace {
  const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
  const problems = validateTrace(raw);
  if (problems.length) throw new Error(`trace ${file} is invalid:\n  - ${problems.join("\n  - ")}`);
  return raw as AppTrace;
}

/** 加载期校验：坏的 trace 必须响亮（审计产物不能"看起来像"）。 */
export function validateTrace(t: unknown): string[] {
  const p: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(t)) return ["trace must be an object"];
  if (t["schema_version"] !== 1) p.push("schema_version must be 1");
  for (const k of ["app", "script_sha256", "inputs_sha256"]) {
    if (typeof t[k] !== "string" || !(t[k] as string)) p.push(`${k} must be a non-empty string`);
  }
  for (const k of ["script_sha256", "inputs_sha256"]) {
    if (typeof t[k] === "string" && !/^[0-9a-f]{64}$/.test(t[k] as string)) p.push(`${k} must be a sha256 hex string`);
  }
  if (typeof t["done"] !== "boolean") p.push("done must be a boolean");
  if (!Array.isArray(t["events"])) {
    p.push("events must be a list");
    return p;
  }
  (t["events"] as unknown[]).forEach((ev, i) => {
    if (!isObj(ev)) { p.push(`events[${i}] must be an object`); return; }
    if (!Number.isInteger(ev["i"])) p.push(`events[${i}].i must be an integer`);
    if (typeof ev["call"] !== "string") p.push(`events[${i}].call must be a string`);
  });
  return p;
}

/**
 * 重放闸门：**版本或输入不一致就拒跑**（不猜、不"尽量重放"）。
 * 返回 problem 列表（空 = 兼容）。
 */
export function replayCompatibility(
  trace: AppTrace,
  now: { app: string; script_sha256: string; inputs_sha256: string },
): string[] {
  const p: string[] = [];
  if (trace.app !== now.app) p.push(`app mismatch: trace ${JSON.stringify(trace.app)} vs ${JSON.stringify(now.app)}`);
  if (trace.script_sha256 !== now.script_sha256) {
    p.push(`script version mismatch: trace ${trace.script_sha256.slice(0, 12)}… vs current ${now.script_sha256.slice(0, 12)}… `
      + "(re-run instead of replaying across versions)");
  }
  if (trace.inputs_sha256 !== now.inputs_sha256) {
    p.push(`inputs mismatch: trace ${trace.inputs_sha256.slice(0, 12)}… vs current ${now.inputs_sha256.slice(0, 12)}… `
      + "(slots/CLI differ; replaying would compare two different runs)");
  }
  return p;
}

/**
 * 两次运行的**结构**是否一致：只比 "调用了什么 + 参数 + 结果"（call/desc/url/ok/stop_code），
 * 忽略 `result` 里像耗时这类每次都会变的证据。真实运行的确定性主张用这个口径
 * （dry 的等价性仍用逐字段的 `sameEventSequence`）。
 */
export function sameEventStructure(a: AppTrace, b: AppTrace): boolean {
  const pick = (t: AppTrace) => t.events.map((e) => {
    // result 里的耗时是每次都会变的证据，剥掉；其余（ok/stop_code/reason/rows…）属于结构。
    let result: unknown = e.result ?? null;
    if (typeof result === "object" && result !== null && !Array.isArray(result)) {
      const { elapsed_ms: _ignored, ...rest } = result as Record<string, unknown>;
      void _ignored;
      result = rest;
    }
    return {
      call: e.call, desc: e.desc ?? null, url: e.url ?? null,
      ok: e.ok ?? null, stop_code: e.stop_code ?? null, result,
    };
  });
  return canonicalJson(pick(a)) === canonicalJson(pick(b));
}

/** 两次运行的事件序列是否一致（确定性/重放的判据；只比"调用 + 结果"这些事实）。 */
export function sameEventSequence(a: AppTrace, b: AppTrace): boolean {
  const pick = (t: AppTrace) => t.events.map((e) => ({
    call: e.call, desc: e.desc ?? null, url: e.url ?? null,
    ok: e.ok ?? null, stop_code: e.stop_code ?? null, result: e.result ?? null,
  }));
  return canonicalJson(pick(a)) === canonicalJson(pick(b));
}
