/**
 * **应用脚本加载器**：`apps/<id>/app.mjs`（`app.mjs` / `app.js` / `app.ts`，运行期 `import()`）
 * → `meta(kit)` → `flow(ctx)` → 内部 `AppPack` IR → 同一套加载期校验。
 *
 * 现在只有一种应用格式：**flow 脚本**。没有 `pack.json`，没有声明式数据脚本，没有语义模板。
 * 脚本与项目主体隔离：不 import 仓库任何模块（`kit` 由引擎注入），不在 `tsconfig.json` 的 include 里。
 *
 * 任何契约/校验错误都在这里抛（带脚本路径与逐条 problem），绝不“降级成没加载到”：
 * 脚本存在但坏了，就是配置错误，不允许静默回退到另一种格式。
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "../flow/flow.ts";
import { appDirs, type AppPack } from "./app-pack.ts";
import { validateApp } from "./cross-ref.ts";
import { createKit, type Kit } from "./kit.ts";
import { lowerMeta, type ScriptMeta } from "./app-meta.ts";
import { StopError, type Ctx } from "./ctx.ts";
import { createDryCtx } from "./ctx-dry.ts";
import { finishTrace, inputsSha256, newTrace, type AppTrace } from "./trace.ts";

/** 脚本文件名（按优先级）。`.ts` 靠 Node 22.6+ 的 strip-types 解释，仍不进项目编译。 */
export const SCRIPT_FILENAMES = ["app.mjs", "app.js", "app.ts"] as const;

export interface ScriptModule {
  meta?: (kit: Kit) => ScriptMeta;
  /** 唯一入口：运行期控制流。 */
  flow?: (ctx: Ctx) => Promise<unknown>;
  /** 已移除的声明式出口；保留检测位以给出可照做的迁移错误。 */
  app?: unknown;
}

export interface LoadedScriptApp {
  pack: AppPack;
  flow: (ctx: Ctx) => Promise<unknown>;
  scriptPath: string;
  /** 脚本源字节的 sha256（运行结果里记账用；与 `plan_sha256` 一起构成“跑了哪一版”）。 */
  scriptSha256: string;
  /** 生成的 IR 的 sha256（同一脚本两次加载必须相同 = 确定性）。 */
  planSha256: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 确定性序列化：键排序，便于算 `plan_sha256`。 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (isObj(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export function sha256(text: string | Buffer): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** 解析脚本路径：显式路径优先；否则按 `appDirs()`（用户目录在前、仓库夹具在后）发现。 */
export function resolveScriptPath(idOrPath: string): string | null {
  const looksLikeScript = /\.(mjs|js|ts)$/i.test(idOrPath);
  const looksLikePath = looksLikeScript || idOrPath.includes("/") || idOrPath.includes("\\");
  if (looksLikePath) {
    if (!looksLikeScript) return null;
    const p = path.resolve(idOrPath);
    return fs.existsSync(p) ? p : null;
  }
  for (const dir of appDirs()) {
    if (path.basename(dir) !== idOrPath) continue;
    for (const name of SCRIPT_FILENAMES) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * 从异常栈里找“脚本文件:行:列”（ESM 帧形如 `at flow (file:///…/app.mjs:12:13)`）。
 * 目的：flow 的配置/语法错误在 check/explain 时能指向**作者代码行**。
 */
export function scriptErrorLocation(err: unknown, scriptPath: string): string | null {
  if (!(err instanceof Error) || typeof err.stack !== "string") return null;
  const href = pathToFileURL(scriptPath).href;
  const candidates = [href, scriptPath];
  for (const line of err.stack.split("\n")) {
    for (const token of candidates) {
      const idx = line.indexOf(token);
      if (idx < 0) continue;
      const rest = line.slice(idx + token.length);
      const m = rest.match(/^:(\d+):(\d+)/) ?? rest.match(/^:(\d+)/);
      if (m) return `${path.basename(scriptPath)}:${m[1]}${m[2] === undefined ? "" : `:${m[2]}`}`;
    }
  }
  return null;
}

/**
 * 语法错误的行号：ESM 的 SyntaxError 栈里**没有**用户文件帧（Node 只在 loader 内部失败），
 * 所以在 import 失败时用 `node --check` 复核一次（只在错误路径跑，正常加载零开销）。
 */
function syntaxCheckLocation(scriptPath: string): string | null {
  try {
    const res = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8", timeout: 10_000 });
    const text = String(res.stderr ?? "");
    const m = text.match(/^(.*?):(\d+)\s*$/m);
    if (m !== null && path.resolve(m[1]!) === path.resolve(scriptPath)) {
      return `${path.basename(scriptPath)}:${m[2]}`;
    }
  } catch { /* 取不到行号就退回纯消息 */ }
  return null;
}

/**
 * 加载并校验一个应用脚本。**任何契约/校验错误都在这里抛**（带脚本路径与逐条 problem）。
 */
export async function loadScriptApp(idOrPath: string): Promise<LoadedScriptApp> {
  const scriptPath = resolveScriptPath(idOrPath);
  if (scriptPath === null) {
    throw new Error(`app script not found for ${JSON.stringify(idOrPath)} `
      + `(looked for ${SCRIPT_FILENAMES.join("/")} under ${appDirs().join(", ")})`);
  }
  const source = fs.readFileSync(scriptPath);
  let mod: ScriptModule;
  try {
    mod = (await import(pathToFileURL(scriptPath).href)) as ScriptModule;
  } catch (e) {
    const loc = scriptErrorLocation(e, scriptPath) ?? syntaxCheckLocation(scriptPath);
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`app script ${scriptPath}${loc ? ` (at ${loc})` : ""}: import failed: ${msg}`);
  }
  if (typeof mod.meta !== "function") {
    throw new Error(`app script ${scriptPath}: missing "export const meta = (kit) => ({...})"`);
  }
  if (mod.app !== undefined) {
    throw new Error(`app script ${scriptPath}: "app()" / declarative-data was removed — `
      + `export "flow(ctx)" instead (one author model: JS control flow)`);
  }
  if (typeof mod.flow !== "function") {
    throw new Error(`app script ${scriptPath}: missing "export async function flow(ctx) { ... }"`);
  }

  const kit = createKit();
  let meta: ScriptMeta;
  try {
    meta = mod.meta(kit);
  } catch (e) {
    throw new Error(`app script ${scriptPath}: meta(kit) threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  const pack = lowerMeta(meta);
  // flow 没有静态旅程：跳过“空旅程 / web 不变量需要浏览器步”两条结构性检查；
  // 步骤级校验发生在每次 ctx 调用（真实执行器/同一套 PlanningRules）。
  const problems = validateApp(pack, { allowEmptyJourney: true });
  if (problems.length) {
    throw new Error(`app script ${scriptPath} is invalid:\n  - ${problems.join("\n  - ")}`);
  }
  pack._path = scriptPath;
  return {
    pack,
    flow: mod.flow,
    scriptPath,
    scriptSha256: sha256(source),
    planSha256: sha256(canonicalJson(pack)),
  };
}

/** 统一入口：拿一个应用的完整信息（`pack` + `flow` + 两个版本指纹）。 */
export async function resolveApp(idOrPath: string): Promise<{ pack: AppPack; script: LoadedScriptApp }> {
  const script = await loadScriptApp(idOrPath);
  return { pack: script.pack, script };
}

/** 仓库内脚本的相对路径（记账/报告用；用户作用域返回绝对路径）。 */
export function scriptDisplayPath(scriptPath: string): string {
  const rel = path.relative(REPO, scriptPath);
  return rel.startsWith("..") ? scriptPath : rel;
}

/**
 * **dry 跑一遍 flow**：不动作、不开浏览器，但把每次调用都校验一遍并记进 trace。
 * 这是 `amber apps check/explain` 的落法（与真实运行同一套调用序列）。
 *
 * 返回 `problems`（空 = 通过）：dry 的成功**不代表**页面状态会成立，它证明的是
 * “脚本的调用序列在语法/命令/信号层面是合法的”。
 */
export async function dryRunFlow(loaded: LoadedScriptApp, opts: {
  slots?: Record<string, string>;
  outDir?: string;
  runId?: string;
} = {}): Promise<{ trace: AppTrace; problems: string[] }> {
  const slots: Record<string, string> = {
    ...((loaded.pack.slots ?? {}) as Record<string, string>),
    ...(opts.slots ?? {}),
  };
  const trace = newTrace({
    app: loaded.pack.id,
    script_sha256: loaded.scriptSha256,
    inputs_sha256: inputsSha256(slots, (loaded.pack.hosts ?? []) as string[]),
  });
  const slotKeys = new Set<string>([
    ...Object.keys(slots),
    ...((loaded.pack.required_slots ?? []) as string[]),
  ]);
  const ctx = createDryCtx({
    pack: loaded.pack as never,
    slots,
    runtime: { outDir: opts.outDir ?? "(dry)", runId: opts.runId ?? "(dry)", today: process.env.LAYA_TODAY ?? "" },
    trace,
    slotKeys,
  });
  const problems: string[] = [];
  try {
    await loaded.flow(ctx);
  } catch (e) {
    const loc = scriptErrorLocation(e, loaded.scriptPath);
    const at = loc === null ? "" : ` (at ${loc})`;
    if (e instanceof StopError) problems.push(`${e.code}: ${e.message}${at}`);
    else problems.push(`flow threw: ${e instanceof Error ? e.message : String(e)}${at}`);
  }
  // “声明了不变量但没验收”在 dry 路径上通常就能看出来（除非 done 只在不可达分支）：
  // 缺失时给一条 problem，避免 check 假绿后真跑才报 missing_done。
  if (problems.length === 0 && (loaded.pack.invariants ?? []).length > 0) {
    const hasDone = trace.events.some((e) => e.call === "done");
    const browserish = trace.events.some((e) => e.call === "open" || e.call === "openPage"
      || e.call === "arrive" || e.call === "step");
    if (!hasDone) {
      problems.push("flow: declared end-state invariants but ctx.done() was never called on the dry path");
    } else if (!browserish) {
      problems.push("flow: web invariants need at least one browser navigation (open/openPage/arrive)");
    }
  }
  finishTrace(trace, { done: problems.length === 0 });
  return { trace, problems };
}