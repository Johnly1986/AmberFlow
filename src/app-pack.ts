/**
 * 应用包（`apps/<app>/pack.json`）—— 应用层的一份声明，零共享代码改动。
 *
 * 一个应用包把三样东西绑在一起：
 *   1. **动作腿**：`journey` 用**角色**（`roles` 里的模板）串起来的一条旅程，展开成冻结计划
 *      （`TaskPlan`）交给唯一的生产执行器；
 *   2. **数据腿**：`sources` 引用 `<dir>/sources/*.json` 里的数据源（HTTP 或 CLI 通道），
 *      由 `src/datasource.ts` 的同一套引擎跑；
 *   3. **验收**：`invariants` 是旅程**结束状态**上的断言（不是子目标信号的重复），
 *      以及 `slots`/`required_slots` 这套"值只来自计划"的数据袋。
 *
 * 三条纪律：
 *   - **发现制**：`apps/<id>/pack.json` 扫出来，没有中央清单；
 *   - **加载期校验**：未知键、未知角色、未知占位符、缺必填槽位、坏信号全部在加载时炸
 *     （信号复用 `PlanningRules.problems`，与冻结计划同一套校验）；
 *   - **占位符只替换已声明的槽位**（`{coupon}`），其余花括号原样保留——工具参数/JSON 里
 *     花括号太多，宽松口径才不会误伤。
 */
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./flow.ts";
import { PlanningRules, TaskPlan, type Subgoal } from "./plan.ts";
import type { SignalSpec } from "./signals.ts";
import { loadSource } from "./datasource.ts";

export const APPS_DIR = path.join(REPO, "apps");
export const SPEC_VERSION = 1;

/** 包级允许的键；未知键在加载期报错（配置写错了要响亮，不静默）。 */
export const PACK_KEYS = [
  "spec_version", "id", "label", "goal", "model", "max_subgoals", "hosts",
  "slots", "required_slots", "sources", "roles", "journey", "invariants", "notes",
] as const;

/** 旅程里一步允许的键（也就是 `Subgoal` 的声明面 + `role`）。 */
export const STEP_KEYS = [
  "role", "desc", "signal", "start_url", "target_hint", "target_hints", "slots", "when",
  "retries",
] as const;

export interface AppInvariant {
  id: string;
  desc?: string;
  signal: SignalSpec;
}

export interface AppPack {
  spec_version: number;
  id: string;
  label: string;
  goal: string;
  model?: string;
  max_subgoals?: number;
  hosts?: string[];
  slots?: Record<string, unknown>;
  required_slots?: string[];
  sources?: string[];
  roles?: Record<string, Record<string, unknown>>;
  journey: Array<Record<string, unknown>>;
  invariants?: AppInvariant[];
  notes?: string[];
  /** 加载器写入：这个包的文件路径（报告用）。 */
  _path?: string;
}

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `apps/<id>/pack.json` 的目录（发现制）。 */
export function appDirs(): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(APPS_DIR);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names.sort()) {
    const p = path.join(APPS_DIR, n, "pack.json");
    try {
      if (fs.statSync(p).isFile()) out.push(path.join(APPS_DIR, n));
    } catch {
      /* 没有 pack.json 的目录（比如只有 sources 的）不算应用包 */
    }
  }
  return out;
}

/** 已发现的应用包：`[id, label, path]`，按 id 排序。 */
export function listPacks(): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  for (const dir of appDirs()) {
    const p = path.join(dir, "pack.json");
    try {
      const pack = JSON.parse(fs.readFileSync(p, "utf-8")) as AppPack;
      out.push([String(pack.id ?? path.basename(dir)), String(pack.label ?? ""), p]);
    } catch (e) {
      out.push([path.basename(dir), `<invalid: ${e instanceof Error ? e.message : String(e)}>`, p]);
    }
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export function loadPack(nameOrPath: string): AppPack {
  let p = nameOrPath;
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
    const hit = appDirs().map((d) => path.join(d, "pack.json"))
      .find((c) => path.basename(path.dirname(c)) === nameOrPath);
    if (hit === undefined) {
      throw new Error(`app pack ${JSON.stringify(nameOrPath)} not found under ${APPS_DIR}`);
    }
    p = hit;
  }
  const pack = JSON.parse(fs.readFileSync(p, "utf-8")) as AppPack;
  pack._path = p;
  return pack;
}

/* ------------------------------------------------------------------ 占位符 */

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** 收集一段文本里的占位符名（未知槽位要在加载期就报错）。 */
function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/** 只替换**已声明**的槽位，其余花括号原样保留（工具参数/JSON 里到处是花括号）。 */
function substitute(value: unknown, slots: Record<string, unknown>, out: string[]): unknown {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER, (m, k: string) => {
      if (!(k in slots)) {
        out.push(`unknown slot placeholder {${k}}`);
        return m;
      }
      return String(slots[k]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, slots, out));
  if (isDict(value)) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) o[k] = substitute(v, slots, out);
    return o;
  }
  return value;
}

/* ------------------------------------------------------------------ 展开 */

export interface ExpandedPack {
  pack: AppPack;
  plan: TaskPlan;
  slots: Record<string, unknown>;
  /** plan 里用到的角色（按出现顺序去重）——角色覆盖率就是一个数字。 */
  rolesUsed: string[];
}

/**
 * 包 → 冻结计划。**同一份包 + 同一组槽位必须展开出逐字段相同的计划**（可复现性由测试钉住）。
 */
export function expandPack(pack: AppPack, overrides: Record<string, unknown> = {},
  planPath = path.join(REPO, ".task_state.json")): ExpandedPack {
  const slots: Record<string, unknown> = { ...(pack.slots ?? {}), ...overrides };
  const problems = validatePack(pack, { slots });
  if (problems.length) {
    throw new Error(`app pack ${pack.id} is invalid:\n  - ${problems.join("\n  - ")}`);
  }
  const roles = pack.roles ?? {};
  const used: string[] = [];
  const steps: Array<Record<string, unknown>> = [];
  const subProblems: string[] = [];
  pack.journey.forEach((entry, i) => {
    const roleName = entry["role"] === undefined ? null : String(entry["role"]);
    let merged: Record<string, unknown> = {};
    if (roleName !== null) {
      merged = { ...(roles[roleName] ?? {}) };
      used.push(roleName);
    }
    merged = { ...merged, ...entry };
    delete merged["role"];
    const step = substitute(merged, slots, subProblems) as Record<string, unknown>;
    if (!step["desc"]) subProblems.push(`journey[${i}]: step has no desc (role ${roleName ?? "-"})`);
    steps.push(step);
  });
  if (subProblems.length) {
    throw new Error(`app pack ${pack.id} is invalid:\n  - ${subProblems.join("\n  - ")}`);
  }
  const plan = new TaskPlan(pack.goal, steps as unknown as Array<Partial<Subgoal>>, planPath, slots);
  return { pack, plan, slots, rolesUsed: [...new Set(used)] };
}

/* ------------------------------------------------------------------ 校验 */

/**
 * 结构 + 信号语言校验：**加载期就炸**，不是跑到第 9 步才炸。
 *
 * 信号/hint/`when`/`retries` 复用 `PlanningRules.problems`——冻结计划怎么校验，应用包就怎么校验，
 * 不新开第二套语法校验器（hint 语法漂移过一次，代价是线上目标静默丢失）。
 */
export function validatePack(pack: AppPack,
  opts: { slots?: Record<string, unknown>; sources?: string[] } = {}): string[] {
  const p: string[] = [];
  if (!isDict(pack)) return ["pack must be a JSON object"];
  for (const k of Object.keys(pack)) {
    if (!(PACK_KEYS as readonly string[]).includes(k) && !k.startsWith("_")) {
      p.push(`${k}: unknown pack key (known: ${PACK_KEYS.join(", ")})`);
    }
  }
  if (pack.spec_version !== SPEC_VERSION) {
    p.push(`spec_version must be ${SPEC_VERSION} (got ${JSON.stringify(pack.spec_version)})`);
  }
  for (const k of ["id", "label", "goal"] as const) {
    if (typeof pack[k] !== "string" || !pack[k]) p.push(`${k} is required`);
  }
  if (!Array.isArray(pack.journey) || pack.journey.length === 0) {
    p.push("journey must be a non-empty list of steps");
    return p;
  }
  if (pack.roles !== undefined && !isDict(pack.roles)) p.push("roles must be an object of step templates");
  if (pack.invariants !== undefined && !Array.isArray(pack.invariants)) p.push("invariants must be a list");
  if (pack.required_slots !== undefined && !Array.isArray(pack.required_slots)) {
    p.push("required_slots must be a list of slot names");
  }
  const slots = { ...(pack.slots ?? {}), ...(opts.slots ?? {}) };
  for (const s of pack.required_slots ?? []) {
    if (!(String(s) in slots)) p.push(`required slot ${JSON.stringify(String(s))} has no value`);
  }
  const roles = pack.roles ?? {};
  for (const [name, tpl] of Object.entries(roles)) {
    if (!isDict(tpl)) { p.push(`roles.${name} must be an object`); continue; }
    for (const k of Object.keys(tpl)) {
      if (!(STEP_KEYS as readonly string[]).includes(k) || k === "role") {
        p.push(`roles.${name}.${k}: unknown step key (known: ${STEP_KEYS.filter((x) => x !== "role").join(", ")})`);
      }
    }
    if (!tpl["desc"] && !tpl["signal"]) p.push(`roles.${name} needs desc and signal`);
  }
  pack.journey.forEach((entry, i) => {
    if (!isDict(entry)) { p.push(`journey[${i}] must be an object`); return; }
    for (const k of Object.keys(entry)) {
      if (!(STEP_KEYS as readonly string[]).includes(k)) {
        p.push(`journey[${i}].${k}: unknown step key (known: ${STEP_KEYS.join(", ")})`);
      }
    }
    const roleName = entry["role"];
    if (roleName !== undefined && !(String(roleName) in roles)) {
      p.push(`journey[${i}]: unknown role ${JSON.stringify(String(roleName))}`);
    }
    if (!entry["desc"] && roleName === undefined) p.push(`journey[${i}]: needs desc (or a role that has one)`);
    if (!entry["signal"] && roleName === undefined) p.push(`journey[${i}]: needs a done-signal`);
  });
  // 占位符必须指向已声明的槽位（`required_slots` 或 `slots` 里给了值）
  const seen: string[] = [];
  substitute({ roles: pack.roles ?? {}, journey: pack.journey }, slots, seen);
  for (const s of [...new Set(seen)]) p.push(s);
  // 数据腿：引用的数据源必须真的存在（发现制，不维护清单）
  for (const s of pack.sources ?? []) {
    try {
      loadSource(String(s));
    } catch (e) {
      p.push(`source ${JSON.stringify(String(s))} not found (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  for (const [i, inv] of (pack.invariants ?? []).entries()) {
    if (!isDict(inv) || !inv["id"] || !isDict(inv["signal"])) {
      p.push(`invariants[${i}] needs {id, signal}`);
    }
  }
  // 展开成计划后再用计划自己的校验器过一遍（信号/hint/when/retries 一套口径）
  if (!p.length) {
    try {
      const rolesUsed = pack.journey.map((e, i) => {
        const merged = e["role"] ? { ...(roles[String(e["role"])] ?? {}), ...e } : { ...e };
        delete merged["role"];
        return substitute(merged, slots, []) as Record<string, unknown>;
      });
      const plan = new TaskPlan(pack.goal, rolesUsed as unknown as Array<Partial<Subgoal>>,
        ":memory:", slots);
      const rules = new PlanningRules(pack.max_subgoals ?? 12, true, false);
      p.push(...rules.problems(plan).map((x) => `plan: ${x}`));
    } catch (e) {
      p.push(`plan: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return p;
}
