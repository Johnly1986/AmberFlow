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
import { validateToolSignal, type ToolSignal } from "./tool-signals.ts";
import { validateProbeBlock } from "./probe-set.ts";
import { loadSource } from "./datasource.ts";

export const APPS_DIR = path.join(REPO, "apps");
export const SPEC_VERSION = 1;

/**
 * **运行期占位符**：由运行器提供，不属于计划的数据袋（值是"写到哪儿"，不是业务数据）。
 * 目前只有 `{out_dir}`（本次运行的输出目录）——不可逆动作的产物几乎总要落到一个运行期目录里，
 * 写死绝对路径会让应用包换台机器就不可跑。
 */
export const RUNTIME_PLACEHOLDERS: Readonly<Record<string, string>> = {
  out_dir: "{out_dir}",
  /**
   * G-K：**每次运行唯一**的标识。`{out_dir}` 是跨运行复用的，所以把"跨调用的状态"（重试计数、
   * 临时锁、一次性令牌）写在 out_dir 里会让**第二次运行的行为与第一次不同**——实测：
   * `cli-report` 的"前两次失败"在同一条命令第二次执行时第一次尝试就通过了，验收变成了
   * 不可复现。要跨调用有状态又不想污染运行之间，就用 `{run_id}`。
   */
  run_id: "{run_id}",
};

/** 包级允许的键；未知键在加载期报错（配置写错了要响亮，不静默）。 */
export const PACK_KEYS = [
  "spec_version", "id", "label", "goal", "model", "max_subgoals", "hosts",
  "slots", "required_slots", "sources", "roles", "journey", "invariants", "notes", "probe", "device",
] as const;

/**
 * `device` 允许的键（与 `DeviceSpec` 一一对应）。理由是**只有手机版页面存在**的站点：
 * 桌面 UA/视口下 DOM 不同、计划点名的目标不在池里，hint 必然落空。设备是站点知识，所以进声明面；
 * 未知键在加载期报错（写错了要响亮）。
 */
export const DEVICE_KEYS = [
  "user_agent", "viewport", "is_mobile", "has_touch", "locale", "timezone", "device_scale_factor",
] as const;

/**
 * 旅程里一步允许的键。两种步型：
 *   - **浏览器步**（`Subgoal` 的声明面）：desc/signal/start_url/target_hint(s)/slots/when/retries
 *   - **工具步**（命令行动作腿）：source/args/dry_run_args/idempotent/dangerous + 进程信号
 * 两种步型互斥的键在加载期就报错，不会"写了没用"。
 */
export const STEP_KEYS = [
  // 共同
  "role", "desc", "signal", "slots", "retries", "id",
  // 浏览器步
  "start_url", "target_hint", "target_hints", "when",
  // 工具步
  "source", "args", "dry_run_args", "idempotent", "dangerous",
] as const;

const BROWSER_ONLY = ["start_url", "target_hint", "target_hints", "when"] as const;
const TOOL_ONLY = ["source", "args", "dry_run_args", "idempotent", "dangerous"] as const;

/** 展开后的一步：浏览器步或工具步（`kind` 由 `source` 是否存在决定）。 */
export interface ExpandedStep {
  index: number;
  kind: "browser" | "tool";
  desc: string;
  role: string | null;
  /** 浏览器步：交给唯一执行器的子目标 */
  subgoal?: Subgoal;
  /** 工具步：命令行动作腿的调用参数（signal 是进程观察面的信号） */
  tool?: {
    source: string;
    args: string[];
    dry_run_args: string[] | null;
    signal: ToolSignal;
    retries: number;
    idempotent: boolean;
    dangerous: boolean;
  };
}

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
  /** 浏览器设备面（只有手机版页面存在的站点必须声明它；见 `executor.DeviceSpec`）。 */
  device?: Record<string, unknown>;
  /**
   * 探针集（测量型应用）：声明要测哪些 URL、站点特征、结果目录。站点知识的**唯一**合法
   * 去处——驱动只剩"怎么测"。校验见 `probe-set.validateProbeBlock`（含"每个 URL 的主机都
   * 必须在 `hosts` 里"，否则防泄漏门禁会漏掉它）。
   */
  probe?: Record<string, unknown>;
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
  /** 展开后的步骤（按旅程顺序，含浏览器步与工具步） */
  steps: ExpandedStep[];
  /** 只含浏览器步的冻结计划（交给 `runPlan` / `runSubgoalWithRetries` 的执行单元） */
  plan: TaskPlan;
  slots: Record<string, unknown>;
  /** plan 里用到的角色（按出现顺序去重）——角色覆盖率就是一个数字。 */
  rolesUsed: string[];
}

/** 一步是工具步还是浏览器步：有 `source` 就是工具步（加载期已保证互斥键不混用）。 */
export function stepKind(step: Record<string, unknown>): "browser" | "tool" {
  return step["source"] === undefined ? "browser" : "tool";
}

/** 展开一步：角色模板 + 内联覆盖 + 槽位替换（两种步型共用）。 */
function expandStep(
  entry: Record<string, unknown>, roles: Record<string, Record<string, unknown>>,
  slots: Record<string, unknown>, problems: string[], index: number,
): { merged: Record<string, unknown>; role: string | null } {
  const roleName = entry["role"] === undefined ? null : String(entry["role"]);
  let merged: Record<string, unknown> = {};
  if (roleName !== null) {
    merged = { ...(roles[roleName] ?? {}) };
  }
  merged = { ...merged, ...entry };
  delete merged["role"];
  const out = substitute(merged, slots, problems) as Record<string, unknown>;
  if (!out["desc"]) problems.push(`journey[${index}]: step has no desc (role ${roleName ?? "-"})`);
  return { merged: out, role: roleName };
}

/**
 * 包 → 冻结计划（浏览器步）+ 步骤表（含工具步）。**同一份包 + 同一组槽位必须展开出逐字段
 * 相同的计划**（可复现性由测试钉住）。
 */
export function expandPack(pack: AppPack, overrides: Record<string, unknown> = {},
  planPath = path.join(REPO, ".task_state.json")): ExpandedPack {
  const slots: Record<string, unknown> = { ...(pack.slots ?? {}), ...overrides };
  // 替换袋 = 计划槽位 + 运行期占位符（后者替换成自身，留给运行器换成真实输出目录）
  const bag: Record<string, unknown> = { ...RUNTIME_PLACEHOLDERS, ...slots };
  const problems = validatePack(pack, { slots });
  if (problems.length) {
    throw new Error(`app pack ${pack.id} is invalid:\n  - ${problems.join("\n  - ")}`);
  }
  const roles = pack.roles ?? {};
  const used: string[] = [];
  const steps: ExpandedStep[] = [];
  const browserSubgoals: Array<Record<string, unknown>> = [];
  const subProblems: string[] = [];
  pack.journey.forEach((entry, i) => {
    const { merged, role } = expandStep(entry, roles, bag, subProblems, i);
    if (role !== null) used.push(role);
    if (stepKind(merged) === "tool") {
      steps.push({
        index: i, kind: "tool", desc: String(merged["desc"]), role,
        tool: {
          source: String(merged["source"]),
          args: ((merged["args"] as unknown[]) ?? []).map((x) => String(x)),
          dry_run_args: merged["dry_run_args"] === undefined || merged["dry_run_args"] === null
            ? null : (merged["dry_run_args"] as unknown[]).map((x) => String(x)),
          signal: (merged["signal"] ?? {}) as ToolSignal,
          retries: merged["retries"] === undefined ? 0 : Math.trunc(Number(merged["retries"])),
          idempotent: merged["idempotent"] === true,
          dangerous: merged["dangerous"] === true,
        },
      });
    } else {
      browserSubgoals.push(merged);
      steps.push({ index: i, kind: "browser", desc: String(merged["desc"]), role, subgoal: merged as Subgoal });
    }
  });
  if (subProblems.length) {
    throw new Error(`app pack ${pack.id} is invalid:\n  - ${subProblems.join("\n  - ")}`);
  }
  const plan = new TaskPlan(pack.goal, browserSubgoals as unknown as Array<Partial<Subgoal>>, planPath, slots);
  return { pack, steps, plan, slots, rolesUsed: [...new Set(used)] };
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
  // G-H：几个"看着能用其实会误导"的类型错误在加载期就报。最典型的是把 `sources` 写成**裸字符串**
  // ——它会被当列表逐字符遍历，于是报出一串"未知数据源"的伪错误，把人引到错的方向。
  if (pack.max_subgoals !== undefined
    && (!Number.isInteger(pack.max_subgoals) || pack.max_subgoals < 1)) {
    p.push("max_subgoals must be a positive integer");
  }
  if (pack.slots !== undefined && !isDict(pack.slots)) {
    p.push("slots must be an object of slot -> value");
  }
  if (pack.required_slots !== undefined
    && (!Array.isArray(pack.required_slots) || pack.required_slots.some((x) => typeof x !== "string"))) {
    p.push("required_slots must be a list of slot names");
  }
  if (pack.sources !== undefined
    && (!Array.isArray(pack.sources) || pack.sources.some((x) => typeof x !== "string"))) {
    p.push("sources must be a list of source names (a bare string would be read as a list of characters)");
  }
  if (pack.model !== undefined && typeof pack.model !== "string") {
    p.push("model must be a string");
  }
  // `hosts` 必须是字符串列表：防泄漏门禁（`tools/apps_matrix.ts`）会逐项遍历它。
  // 写成裸字符串虽然能被 `validateProbeBlock` 的 `asList` 容忍，但门禁会按**字符**建 token
  // （`\bm\b` 之类），既漏掉真主机又刷出一堆假泄漏 —— 所以在加载期就拒绝。
  if (pack.hosts !== undefined && (!Array.isArray(pack.hosts) || pack.hosts.some((h) => typeof h !== "string"))) {
    p.push("hosts must be a list of strings (the leak gate iterates it)");
  }
  if (!Array.isArray(pack.journey)) {
    p.push("journey must be a list of steps");
    return p;
  }
  if (pack.journey.length === 0 && pack.probe === undefined) {
    // 空旅程只有一个合法理由：这是**测量型应用**（只声明探针集，没有要跑的旅程）。
    p.push("journey must be a non-empty list of steps (or declare a probe set)");
    return p;
  }
  if (pack.roles !== undefined && !isDict(pack.roles)) p.push("roles must be an object of step templates");
  if (pack.invariants !== undefined && !Array.isArray(pack.invariants)) p.push("invariants must be a list");
  if (pack.required_slots !== undefined && !Array.isArray(pack.required_slots)) {
    p.push("required_slots must be a list of slot names");
  }
  // 类型不对时用空袋兜住下游遍历：加载期只该报**那一条**真错，不该再刷出一串"逐字符"的伪错误。
  const slotsDict = isDict(pack.slots) ? pack.slots : {};
  const slots = { ...slotsDict, ...(opts.slots ?? {}) };
  for (const s of Array.isArray(pack.required_slots) ? pack.required_slots : []) {
    if (!(String(s) in slots)) p.push(`required slot ${JSON.stringify(String(s))} has no value`);
  }
  const roles = pack.roles ?? {};
  const checkStep = (step: Record<string, unknown>, where: string): void => {
    for (const k of Object.keys(step)) {
      if (!(STEP_KEYS as readonly string[]).includes(k) || k === "role") {
        p.push(`${where}.${k}: unknown step key (known: ${STEP_KEYS.filter((x) => x !== "role").join(", ")})`);
      }
    }
    const tool = step["source"] !== undefined;
    if (tool) {
      for (const k of BROWSER_ONLY) {
        if (step[k] !== undefined) p.push(`${where}.${k}: browser-only key on a tool step (source=${JSON.stringify(String(step["source"]))})`);
      }
      try {
        loadSource(String(step["source"]));
      } catch (e) {
        p.push(`${where}.source ${JSON.stringify(String(step["source"]))} not found (${e instanceof Error ? e.message : String(e)})`);
      }
      p.push(...validateToolSignal((step["signal"] ?? {}) as ToolSignal, `${where}.signal`));
      const args = step["args"];
      if (args !== undefined && !(Array.isArray(args) && args.every((x) => typeof x === "string"))) {
        p.push(`${where}.args must be a list of strings (appended to the source argv)`);
      }
      const dry = step["dry_run_args"];
      if (dry !== undefined && !(Array.isArray(dry) && dry.length && dry.every((x) => typeof x === "string"))) {
        p.push(`${where}.dry_run_args must be a non-empty list of strings`);
      }
      const retries = Number(step["retries"] ?? 0);
      if (retries > 0 && step["idempotent"] !== true) {
        p.push(`${where}.retries=${retries} needs idempotent: true (re-running a tool can be irreversible)`);
      }
      if (step["dangerous"] === true) {
        if (dry === undefined) {
          p.push(`${where}.dangerous needs dry_run_args — 不可逆动作必须先干跑`);
        }
        if (retries > 0) p.push(`${where}.dangerous must not retry (retries=${retries})`);
      }
    } else {
      for (const k of TOOL_ONLY) {
        if (step[k] !== undefined) p.push(`${where}.${k}: tool-only key on a browser step`);
      }
      if (!step["signal"]) p.push(`${where}: needs a done-signal`);
      if (!step["desc"]) p.push(`${where}: needs desc`);
      // G-G：执行器**每个子目标都会重新 goto start_url**（计划里状态不跨子目标保留），
      // 所以浏览器步没有 start_url 在运行时只有两种结局：goto("") 报错，或者悄悄停在上一页。
      // 两种都不该等到运行时才发现。
      if (!step["start_url"]) p.push(`${where}: a browser step needs start_url (each subgoal re-navigates)`);
    }
  };
  for (const [name, tpl] of Object.entries(roles)) {
    if (!isDict(tpl)) { p.push(`roles.${name} must be an object`); continue; }
    checkStep(tpl as Record<string, unknown>, `roles.${name}`);
    if (stepKind(tpl as Record<string, unknown>) === "browser" && !tpl["desc"]) {
      p.push(`roles.${name} needs desc and signal`);
    }
  }
  pack.journey.forEach((entry, i) => {
    if (!isDict(entry)) { p.push(`journey[${i}] must be an object`); return; }
    const roleName = entry["role"];
    if (roleName !== undefined && !(String(roleName) in roles)) {
      p.push(`journey[${i}]: unknown role ${JSON.stringify(String(roleName))}`);
    }
    if (roleName === undefined) {
      checkStep(entry, `journey[${i}]`);
    } else {
      // 角色模板已经校验过；内联覆盖只允许"补字段"，键集合再查一遍
      for (const k of Object.keys(entry)) {
        if (!(STEP_KEYS as readonly string[]).includes(k)) p.push(`journey[${i}].${k}: unknown step key`);
      }
      // 合并后两种步型的互斥键仍要查：角色模板走 checkStep，但**内联覆盖**以前只查键名，
      // 于是 `{role: <浏览器角色>, args:[...]}` 会把 args 静默丢掉（"写了没用"），
      // step 仍按浏览器步执行 —— 这正是不变量"两种步型互斥键加载期就报错"要防的事。
      const tpl = roles[String(roleName)];
      if (isDict(tpl)) {
        const merged = { ...tpl, ...entry };
        const tool = merged["source"] !== undefined;
        if (!tool && !merged["start_url"]) {
          p.push(`journey[${i}]: a browser step needs start_url (neither the role nor the override has one)`);
        }
        for (const k of tool ? BROWSER_ONLY : TOOL_ONLY) {
          if (merged[k] !== undefined) {
            p.push(`journey[${i}].${k}: ${tool
              ? `browser-only key on a tool step (source=${JSON.stringify(String(merged["source"]))})`
              : "tool-only key on a browser step"}`);
          }
        }
      }
    }
  });
  // 占位符必须指向已声明的槽位（`required_slots` 或 `slots` 里给了值）
  const seen: string[] = [];
  substitute({ roles: pack.roles ?? {}, journey: pack.journey },
    { ...RUNTIME_PLACEHOLDERS, ...slots }, seen);
  for (const s of [...new Set(seen)]) p.push(s);
  // 数据腿：引用的数据源必须真的存在（发现制，不维护清单）
  for (const s of Array.isArray(pack.sources) ? pack.sources : []) {
    try {
      loadSource(String(s));
    } catch (e) {
      p.push(`source ${JSON.stringify(String(s))} not found (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (pack.device !== undefined) {
    if (!isDict(pack.device)) {
      p.push("device must be an object");
    } else {
      for (const [k, v] of Object.entries(pack.device)) {
        if (!(DEVICE_KEYS as readonly string[]).includes(k)) {
          p.push(`device.${k}: unknown key (known: ${DEVICE_KEYS.join(", ")})`);
        }
        if (k === "viewport" && (!isDict(v) || !Number.isFinite(Number(v["width"])) || !Number.isFinite(Number(v["height"])))) {
          p.push("device.viewport must be {width, height}");
        }
        if (k === "user_agent" && (typeof v !== "string" || !v.trim())) {
          p.push("device.user_agent must be a non-empty string");
        }
      }
    }
  }
  if (pack.probe !== undefined) {
    p.push(...validateProbeBlock(pack.probe, pack.hosts, "probe"));
  }
  if ((pack.invariants ?? []).length
    && !pack.journey.some((e) => stepKind((e["role"] ? { ...(roles[String(e["role"])] ?? {}), ...e } : e) as Record<string, unknown>) === "browser")) {
    p.push("invariants need at least one browser step (they are evaluated on the browser end state)");
  }
  for (const [i, inv] of (pack.invariants ?? []).entries()) {
    if (!isDict(inv) || !inv["id"] || !isDict(inv["signal"])) {
      p.push(`invariants[${i}] needs {id, signal}`);
    }
  }
  // 展开成计划后再用计划自己的校验器过一遍（信号/hint/when/retries 一套口径）。
  // 只有**浏览器步**进计划；工具步的信号是进程观察面的，它们已经在上面按 TOOL_SIGNAL_OPS 校验过。
  if (!p.length) {
    try {
      const browserSteps = pack.journey.map((e, i) => {
        const merged = e["role"] ? { ...(roles[String(e["role"])] ?? {}), ...e } : { ...e };
        delete merged["role"];
        return substitute(merged, { ...RUNTIME_PLACEHOLDERS, ...slots }, []) as Record<string, unknown>;
      }).filter((step) => stepKind(step) === "browser");
      if (browserSteps.length) {
        const plan = new TaskPlan(pack.goal, browserSteps as unknown as Array<Partial<Subgoal>>,
          ":memory:", slots);
        const rules = new PlanningRules(pack.max_subgoals ?? 12, true, false);
        p.push(...rules.problems(plan).map((x) => `plan: ${x}`));
      }
    } catch (e) {
      p.push(`plan: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return p;
}
