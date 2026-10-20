/**
 * `configs/amberflowrc.json` —— **机器事实配置**（gitignore 掉，不进 checkout；模板
 * `configs/amberflowrc.example.json` 入库）。
 *
 * 存在的意义：把"这台机器的事"从 shell 里收进一个文件，但**不新造第二套读配置的门**。
 * 每个消费点本来就只有一个 env 读点（`model-artifacts.ts` 的 `onnxModelPath(env)`、
 * `decision-tokenplan.ts` 的 `resolveEndpoint(env)`……），所以这里只做一件事：
 * 在 CLI 入口把文件里**环境没设过的键**补进 `process.env`——
 * 优先级天然是 CLI 旗标 > 环境变量 > 文件 > 内建缺省，且文件缺席时零动作（默认等价纪律）。
 *
 * 三条纪律：
 * - **未知键响亮拒绝**（与 pack/source 的加载期校验同一口气）：`LAYA_TODAY` 写进来会被拒——
 *   展开日期是仓库常量（tools/frozen-today.ts），谁把它变成"机器配置"，谁就复活周日绿周一红。
 * - **凭据只在本机文件里**：文件被 gitignore；doctor 展示按 P0 掩码纪律只留长度，
 *   任何被审计产物（计划/包/报告）都不许出现这些值。
 * - **单一实现**：只有这个模块懂 rc 文件；入口只调 `applyRcToEnv()`，别处再解析就是缺陷。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RC_FILENAME = "amberflowrc.json";
/** 相对仓库根的配置面文件夹：机器配置统一住这里，不散在根上。 */
export const RC_DIR = "configs";
export const RC_REL = path.join(RC_DIR, RC_FILENAME);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");

/** 允许出现在 rc 里的键（白名单即校验面）。分组只影响 doctor 的展示顺序。 */
export const RC_GROUPS: Array<{ group: string; keys: string[] }> = [
  { group: "决策模型产物", keys: [
    "LAYA_ONNX_MODEL", "LAYAA_ONNX_MODEL", "LAYA_TOKENIZER_DIR", "LAYAA_TOKENIZER_DIR",
    "HF_HOME", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"] },
  { group: "决策 provider", keys: [
    "AMBERFLOW_DECISION_PROVIDER", "AMBERFLOW_DEFAULT_DECISION_PROVIDER",
    "TOKEN_PLAN_ENDPOINT", "TOKEN_PLAN_API_KEY", "TOKEN_PLAN_MODEL",
    "JEVK5_ENDPOINT", "BAILIAN_ENDPOINT", "BAILIAN_API_KEY", "BAILIAN_MODEL",
    "BAILIAN_REGION", "BAILIAN_WORKSPACE_ID", "DASHSCOPE_API_KEY"] },
  { group: "外层 LLM（planner/auditor）", keys: [
    "OPENAI_BASE_URL", "OPENAI_API_KEY", "PLANNER_MODEL", "AUDIT_MODEL", "PLANNER_TIMEOUT"] },
  { group: "浏览器与落盘", keys: [
    "PLAYWRIGHT_BROWSERS_PATH", "AMBERFLOW_HOME", "AMBERFLOW_APPS_OUT", "AMBERFLOW_SUITE_OUT",
    "AMBERFLOW_REPO", "LAYAWEBUSE_REPO"] },
  { group: "路由偏好", keys: ["CAMERA_ROUTE"] },
];
const KNOWN_KEYS = new Set(RC_GROUPS.flatMap((g) => g.keys));

export interface RcLoad {
  path: string | null;
  values: Record<string, string>;
  errors: string[];
}

/** 读并校验 rc 文件。文件不存在 ⇒ 合法的空配置（默认等价）。 */
export function loadRc(root: string = REPO_ROOT): RcLoad {
  const p = path.join(root, RC_REL);
  if (!fs.existsSync(p)) return { path: null, values: {}, errors: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    return { path: p, values: {}, errors: [`${RC_REL} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { path: p, values: {}, errors: [`${RC_REL} 顶层必须是对象（键 → 字符串值）`] };
  }
  const values: Record<string, string> = {};
  const errors: string[] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === "_doc") continue;                     // example 文件的自述键，允许存在
    if (!KNOWN_KEYS.has(k)) {
      errors.push(`${RC_REL} 有未知键 ${JSON.stringify(k)}——已知键见 configs/amberflowrc.example.json；`
        + "若是刻意想钉的东西（如展开日期），它属于仓库常量，不属于机器配置。");
      continue;
    }
    if (typeof v !== "string") {
      errors.push(`${RC_REL} 的 ${k} 必须是字符串（收到 ${JSON.stringify(v)}）`);
      continue;
    }
    values[k] = v;
  }
  return { path: p, values, errors };
}

export interface RcApply extends RcLoad {
  /** 从文件补进 env 的键（环境里已有的一律不覆盖——CLI/env 永远赢）。 */
  applied: string[];
}

let lastApply: RcApply | null = null;

/** 入口唯一该调的函数：把 rc 的键补进目标 env（缺省 process.env）。幂等。 */
export function applyRcToEnv(env: NodeJS.ProcessEnv = process.env, root: string = REPO_ROOT): RcApply {
  if (lastApply && lastApply.path === path.join(root, RC_REL) && env === process.env) {
    return lastApply;
  }
  const load = loadRc(root);
  const applied: string[] = [];
  if (load.errors.length === 0) {
    for (const [k, v] of Object.entries(load.values)) {
      // 空串 = 没设（example 里留空占位用的）：写进 env 会击穿消费点的 `?? 缺省` 链。
      if (v === "") continue;
      if (env[k] === undefined || env[k] === "") { env[k] = v; applied.push(k); }
    }
  }
  const result = { ...load, applied };
  if (env === process.env) lastApply = result;
  return result;
}

/** 测试缝：清掉幂等缓存（进程内换了 rc 文件内容时用）。 */
export function resetRcCache(): void { lastApply = null; }

// 只掩真凭据（*_API_KEY / SECRET / PASSWORD / ACCESS_TOKEN）；主机类（*_ENDPOINT / BASE_URL）
// 回显给用户自己的终端不构成泄漏，掩了反而让人看不懂自己的配置。
const SECRETISH = /API_KEY|SECRET|PASSWORD|ACCESS_TOKEN/;
/** doctor 口径：值只留掩码后的长度，键名原样。 */
export function maskValue(key: string, value: string): string {
  return SECRETISH.test(key) ? `${"*".repeat(Math.min(value.length, 12))}（长度 ${value.length}，已掩码）` : value;
}

/** doctor 的"配置来源"段：每个生效键点名它是从 env 还是文件来的。
 * 来源判断按 `loadRc` 的值比对，不依赖 applyRcToEnv 的写入痕迹——否则同一进程内
 * 先 apply 再展示时，键已在 env 里、重算的 applied 就不含它，会把"文件"错标成"环境"。 */
export function rcStatusLines(env: NodeJS.ProcessEnv = process.env, root: string = REPO_ROOT): string[] {
  const load = loadRc(root);
  const lines: string[] = [];
  lines.push(load.path ? `rc 文件：${load.path}` : `rc 文件：无（${RC_REL} 不存在，全部按 环境变量 > 缺省 走）`);
  for (const e of load.errors) lines.push(`  ✗ ${e}`);
  for (const { group, keys } of RC_GROUPS) {
    const shown = keys.filter((k) => env[k] !== undefined && env[k] !== "");
    if (!shown.length) continue;
    lines.push(`  ${group}：`);
    for (const k of shown) {
      const fromFile = load.values[k] !== undefined && load.values[k] === env[k];
      lines.push(`    ${k}=${maskValue(k, env[k]!)}（${fromFile ? "文件" : "环境"}）`);
    }
  }
  return lines;
}
