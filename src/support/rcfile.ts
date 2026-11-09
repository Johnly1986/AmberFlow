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
 * - **未知键响亮拒绝**（与 pack/source 的加载期校验同一口气）：不在 schema 里的键写进来会被拒，
 *   而不是"配了却像没配"。
 * - **凭据只在本机文件里**：文件被 gitignore；doctor 展示按 P0 掩码纪律只留长度，
 *   任何被审计产物（计划/包/报告）都不许出现这些值。
 * - **单一实现**：只有这个模块懂 rc 文件；入口只调 `applyRcToEnv()`，别处再解析就是缺陷。
 */
import fs from "node:fs";
import { REPO as REPO_ROOT } from "./paths.ts";

export { REPO_ROOT };
import path from "node:path";

export const RC_FILENAME = "amberflowrc.json";
/** 相对仓库根的配置面文件夹：机器配置统一住这里，不散在根上。 */
export const RC_DIR = "configs";
export const RC_REL = path.join(RC_DIR, RC_FILENAME);

/* 配置面的唯一声明在 `config-schema.ts`；这里只保留 rc 文件读写与 doctor 展示。 */
import { CONFIG_KEYS, RC_GROUPS, isSecretKey, maskValue } from "./config-schema.ts";

export { RC_GROUPS, isSecretKey, maskValue };
const KNOWN_KEYS = new Set(CONFIG_KEYS);

export interface RcLoad {
  path: string | null;
  values: Record<string, string>;
  errors: string[];
}

/* ---- task-7：错误文案面增强（只改消息，不改校验语义与键集合） ----
 * 背景：错误只给相对路径 `configs\amberflowrc.json`，真实文件在仓库根（经 npm 全局 junction
 * 隔了好几层），排障要翻目录。现在错误带**绝对路径 + 行号 + 建议动作**。 */

/** 未知键/坏值所在行（1-based；按 `"key":` 词形定位，找不到 = null，不硬猜）。 */
function keyLineIn(raw: string, key: string): number | null {
  const lines = raw.split(/\r?\n/);
  const pattern = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i]!)) return i + 1;
  }
  return null;
}

/** JSON 解析错误的行号：V8 message 带 `position N` 时按换行折算；取不到 = null。 */
function jsonErrorLine(raw: string, message: string): number | null {
  const m = message.match(/position (\d+)/);
  if (m === null) return null;
  const pos = Number(m[1]);
  if (!Number.isFinite(pos) || pos < 0 || pos >= raw.length) return null;
  let line = 1;
  for (let i = 0; i < pos; i++) {
    if (raw[i] === "\n") line++;
  }
  return line;
}

const atLine = (p: string, line: number | null): string => (line === null ? p : `${p}:${line}`);

/** 读并校验 rc 文件。文件不存在 ⇒ 合法的空配置（默认等价）。 */
export function loadRc(root: string = REPO_ROOT): RcLoad {
  const p = path.join(root, RC_REL);
  if (!fs.existsSync(p)) return { path: null, values: {}, errors: [] };
  const text = fs.readFileSync(p, "utf-8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const line = jsonErrorLine(text, msg);
    return { path: p, values: {}, errors: [`${atLine(p, line)} 不是合法 JSON：${msg}`
      + "——建议：修正 JSON 语法（常见：尾逗号/缺引号）；或删除该文件恢复全缺省行为。"] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { path: p, values: {}, errors: [`${p} 顶层必须是对象（键 → 字符串值）`
      + "——建议：删除该文件恢复全缺省行为，或改回 { \"键\": \"值\" } 形状。"] };
  }
  const values: Record<string, string> = {};
  const errors: string[] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === "_doc") continue;                     // example 文件的自述键，允许存在
    if (!KNOWN_KEYS.has(k)) {
      errors.push(`${atLine(p, keyLineIn(text, k))} 有未知键 ${JSON.stringify(k)}——建议：删除该行；`
        + `已知键见 configs/amberflowrc.example.json；若是刻意想钉的东西（如展开日期），`
        + "它属于仓库常量，不属于机器配置。");
      continue;
    }
    if (typeof v !== "string") {
      errors.push(`${atLine(p, keyLineIn(text, k))} 的 ${k} 必须是字符串（收到 ${JSON.stringify(v)}）`
        + "——建议：删除该行，或把值改成带引号的字符串。");
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

/** 入口唯一该调的函数：把 rc 的键补进目标 env（缺省 process.env）。幂等。
 * 测试进程（vitest 在场）不吸收用户本机配置：测试直接调各 main()，若让
 * configs/amberflowrc.json 生效，"开箱缺省=规则档"这类断言会随谁的本机文件而漂移
 * （2026-10-20 实测：token-plan 设成默认档后两条 start 测试在开发机上变红）。
 * 想测 rc 本身就用注入缝（applyRcToEnv(fakeEnv, tempRoot)），rcfile 测试就是这么做的。 */
export function applyRcToEnv(env: NodeJS.ProcessEnv = process.env, root: string = REPO_ROOT): RcApply {
  if (env.VITEST !== undefined) return { path: null, values: {}, errors: [], applied: [] };
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
