/**
 * **应用脚本加载器**（L1）：`app.mjs`/`app.ts`（隔离、零构建、运行期解释）
 * → `meta(kit)`/`app(kit)` → `lower()` → 今天的 `AppPack`（IR）→ 同一套加载期校验。
 *
 * 为什么不是编译：项目方 2026-10-24 的口径是**脚本与项目主体隔离、与项目编译无关**。
 * 所以这里的路径是：运行期动态 `import()`（先例 `tools/spec-to-pack.ts:100`），
 * 脚本**不 import 仓库任何模块**（kit 由引擎注入），不在 `tsconfig.json` 的 include 里，
 * 也不进 `vitest` 的收集面（没有 `*.test.*` 文件名）。
 *
 * 零行为变化的承诺（L1）：脚本只是**新增一条加载路径**。没有脚本时走 `loadPack`，
 * 21 个既有包一个字节都不动；`AMBERFLOW_NO_SCRIPTS=1` 强制走旧路径。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "../flow/flow.ts";
import { appDirs, loadPack, type AppPack } from "./app-pack.ts";
import { validateApp } from "./cross-ref.ts";
import { createKit, type Kit } from "./kit.ts";

/** 脚本文件名（按优先级）。`.ts` 靠 Node 22.6+ 的 strip-types 解释，仍不进项目编译。 */
export const SCRIPT_FILENAMES = ["app.mjs", "app.js", "app.ts"] as const;

export interface ScriptMeta {
  id: string;
  label?: string;
  goal: string;
  model?: string;
  max_subgoals?: number;
  hosts?: string[];
  slots?: Record<string, string>;
  requiredSlots?: string[];
  sources?: string[];
  device?: Record<string, unknown>;
  notes?: string[];
  policy?: Record<string, unknown>;
  invariants?: Array<Record<string, unknown>>;
  recordedFrom?: Record<string, unknown>;
}

export interface ScriptDraft {
  /** ① 数据槽：常量写进 `slots`；`kit.data.source(...)` 写进 `source_slots`。 */
  data?: Record<string, unknown>;
  /** ② 决策判断（应用级）：只有 `invariants` 在这一层（每步的 done/when 在 exec 里）。 */
  judge?: { invariants?: Array<Record<string, unknown>> };
  /** ③ 决策执行：步骤列表（`kit.step`/`kit.go`/`kit.run` 产出）。 */
  exec: Array<Record<string, unknown>>;
}

export interface ScriptModule {
  meta?: (kit: Kit) => ScriptMeta;
  app?: (kit: Kit) => ScriptDraft;
}

export interface LoadedScriptApp {
  pack: AppPack;
  scriptPath: string;
  /** 脚本源字节的 sha256（运行结果里记账用；与 `plan_sha256` 一起构成"跑了哪一版"）。 */
  scriptSha256: string;
  /** 展开后的 IR 的 sha256（同一脚本两次运行必须相同 = 确定性）。 */
  planSha256: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 确定性序列化：键排序，便于算 `plan_sha256` 与做"两次构建必须一致"的断言。 */
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

/** 脚本是否被强制关闭（`--no-scripts` 的等效环境变量；CLI 旗标在 L1-2 接上）。 */
export function scriptsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.AMBERFLOW_NO_SCRIPTS;
  return v === "1" || v === "true";
}

/** 解析脚本路径：显式路径优先；否则按 `appDirs()`（用户目录在前、仓库夹具在后）发现。 */
export function resolveScriptPath(idOrPath: string): string | null {
  const looksLikeScript = /\.(mjs|js|ts)$/i.test(idOrPath);
  const looksLikePath = looksLikeScript || idOrPath.includes("/") || idOrPath.includes("\\");
  if (looksLikePath) {
    // 显式路径：**只接受脚本扩展名**。`pack.json` 走旧路径（否则会把 JSON 当模块 import，
    // Node 会报 "needs an import attribute of type: json"——那是入口判断错，不是用户写错）。
    if (!looksLikeScript) return null;
    const p = path.resolve(idOrPath);
    return fs.existsSync(p) ? p : null;
  }
  for (const dir of appDirs()) {
    for (const name of SCRIPT_FILENAMES) {
      const p = path.join(dir, idOrPath, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * 把声明面/动作面**降级**成今天的 IR（`AppPack`）。这是唯一翻译点：
 * 三段骨架 → `slots`/`source_slots`/`journey`/`invariants`/`hosts`/`sources`/…
 *
 * 校验不在这里做（契约：降级只搬运；`validateApp` 是唯一裁判）。
 */
export function lowerScriptApp(meta: ScriptMeta, draft: ScriptDraft): AppPack {
  if (!isObj(meta)) throw new Error("app script: meta(kit) must return an object");
  if (!isObj(draft)) throw new Error("app script: app(kit) must return an object");
  if (typeof meta.id !== "string" || !meta.id.trim()) throw new Error("app script: meta.id must be a non-empty string");
  if (typeof meta.goal !== "string" || !meta.goal.trim()) throw new Error("app script: meta.goal must be a non-empty string");
  if (!Array.isArray(draft.exec)) throw new Error("app script: app(kit).exec must be a list of steps");
  if (!meta.id.trim()) throw new Error("app script: meta.id must be a non-empty string");

  const slots: Record<string, unknown> = { ...(isObj(meta.slots) ? meta.slots : {}) };
  const sourceSlots: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(isObj(draft.data) ? draft.data : {})) {
    if (typeof v === "string") {
      slots[key] = v;
      continue;
    }
    if (isObj(v) && v["kind"] === "source") {
      if (typeof v["source"] !== "string" || !v["source"]) {
        throw new Error(`app script: data.${key}: source binding needs a non-empty "source"`);
      }
      const binding: Record<string, unknown> = { source: v["source"] };
      for (const k of ["select", "count", "field"] as const) {
        if (v[k] !== undefined) binding[k] = v[k];
      }
      sourceSlots[key] = binding;
      continue;
    }
    throw new Error(`app script: data.${key}: value must be a string literal or kit.data.source(...)`);
  }

  const pack: Record<string, unknown> = {
    spec_version: 1,
    id: meta.id,
    goal: meta.goal,
    ...(meta.label === undefined ? {} : { label: meta.label }),
    ...(meta.model === undefined ? {} : { model: meta.model }),
    ...(meta.max_subgoals === undefined ? {} : { max_subgoals: meta.max_subgoals }),
    hosts: Array.isArray(meta.hosts) ? [...meta.hosts] : [],
    slots,
    required_slots: Array.isArray(meta.requiredSlots) ? [...meta.requiredSlots] : [],
    sources: Array.isArray(meta.sources) ? [...meta.sources] : [],
    journey: [...draft.exec],
    invariants: [...(meta.invariants ?? draft.judge?.invariants ?? [])],
  };
  if (Object.keys(sourceSlots).length) pack["source_slots"] = sourceSlots;
  if (Array.isArray(meta.notes)) pack["notes"] = [...meta.notes];
  if (meta.device !== undefined) pack["device"] = meta.device;
  if (meta.policy !== undefined) pack["policy"] = meta.policy;
  if (meta.recordedFrom !== undefined) pack["recorded_from"] = meta.recordedFrom;
  return pack as unknown as AppPack;
}

/**
 * 加载并校验一个应用脚本。**任何契约/校验错误都在这里抛**（带脚本路径与逐条 problem），
 * 绝不"降级成没加载到"：脚本存在但坏了，就是配置错误，不许静默回退到旧 JSON。
 */
export async function loadScriptApp(idOrPath: string): Promise<LoadedScriptApp> {
  const scriptPath = resolveScriptPath(idOrPath);
  if (scriptPath === null) {
    throw new Error(`app script not found for ${JSON.stringify(idOrPath)} `
      + `(looked for ${SCRIPT_FILENAMES.join("/")} under ${appDirs().join(", ")})`);
  }
  const source = fs.readFileSync(scriptPath);
  const mod = (await import(pathToFileURL(scriptPath).href)) as ScriptModule;
  if (typeof mod.meta !== "function") throw new Error(`app script ${scriptPath}: missing "export const meta = (kit) => ({...})"`);
  if (typeof mod.app !== "function") throw new Error(`app script ${scriptPath}: missing "export const app = (kit) => ({...})"`);

  const kit = createKit();
  let meta: ScriptMeta;
  let draft: ScriptDraft;
  try {
    meta = mod.meta(kit);
    draft = mod.app(kit);
  } catch (e) {
    throw new Error(`app script ${scriptPath}: building the declarative app threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  const pack = lowerScriptApp(meta, draft);
  const problems = validateApp(pack);
  if (problems.length) {
    throw new Error(`app script ${scriptPath} is invalid:\n  - ${problems.join("\n  - ")}`);
  }
  return {
    pack,
    scriptPath,
    scriptSha256: sha256(source),
    planSha256: sha256(canonicalJson(pack)),
  };
}

/**
 * 统一的"拿一个应用"入口：**有脚本用脚本，没有脚本走旧 JSON**；
 * `AMBERFLOW_NO_SCRIPTS=1` 强制旧路径（回退可验：与今天逐字节等价）。
 *
 * 注意：脚本存在但坏了 → 抛错（不静默回退）。
 */
export async function loadApp(idOrPath: string): Promise<AppPack> {
  if (!scriptsDisabled()) {
    const scriptPath = resolveScriptPath(idOrPath);
    if (scriptPath !== null) return (await loadScriptApp(scriptPath)).pack;
  }
  return loadPack(idOrPath);
}

/** 仓库内脚本的相对路径（记账/报告用；用户作用域返回绝对路径）。 */
export function scriptDisplayPath(scriptPath: string): string {
  const rel = path.relative(REPO, scriptPath);
  return rel.startsWith("..") ? scriptPath : rel;
}
