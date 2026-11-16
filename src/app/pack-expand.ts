/**
 * pack 展开：占位符（只替换已声明槽位）与 journey/角色展开成计划步骤。
 *
 * 纯函数区：只读 AppPack，不碰执行器与决策面。
 */
import { isDict } from "../support/pystr.ts";
import path from "node:path";
import { REPO } from "../flow/flow.ts";
import { TaskPlan } from "../engine/plan.ts";
import type { Subgoal } from "../engine/plan.ts";
import { getAppAdapter, listAppAdapterObjects } from "./app-adapters.ts";
import type { AppPack, ExpandedStep, AppInvariant, SourceObservation } from "./app-pack.ts";
import { validatePack } from "./validate-pack.ts";

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

/** 行里的"主值"（与数据腿报告里 selects 列的渲染同一顺序：price → id → name）。 */
function rowMainValue(row: Record<string, string> | null): string {
  if (!row) return "";
  for (const k of ["price", "id", "name"] as const) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v) !== "") return String(v);
  }
  return "";
}

/* ------------------------------------------------------------------ 占位符 */

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** 收集一段文本里的占位符名（未知槽位要在加载期就报错）。 */
function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/** 只替换**已声明**的槽位，其余花括号原样保留（工具参数/JSON 里到处是花括号）。 */
export function substitute(value: unknown, slots: Record<string, unknown>, out: string[]): unknown {
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
  /**
   * 结束状态断言，**已完成槽位替换**：`{checkin}` 与 journey 里的 `{checkin}` 是同一件事，
   * 展开期一次替换完，运行期不再各处理一遍。
   */
  invariants: AppInvariant[];
  slots: Record<string, unknown>;
  /** plan 里用到的角色（按出现顺序去重）——角色覆盖率就是一个数字。 */
  rolesUsed: string[];
}

/** 一步是工具步还是浏览器步：有 `source` 就是工具步（加载期已保证互斥键不混用）。 */
/**
 * 这一步属于哪种应用类型：显式 `adapter` 优先；否则按既有推断（有 `source` ⇒ cli，否则 web）。
 * **未知类型不在这里炸**——加载期校验会红并列出已知项；这里只回答"类型名是什么"。
 */
export function adapterKind(step: Record<string, unknown>): string {
  const explicit = step["adapter"];
  if (explicit !== undefined && explicit !== null) return String(explicit).trim().toLowerCase();
  return step["source"] === undefined ? "web" : "cli";
}

/**
 * 兼容视图（既有消费者按 `"browser" | "tool"` 读 `ExpandedStep.kind`）。
 * 未知类型返回 "browser"（加载期必红，跑到这里之前就失败了）。
 */
export function stepKind(step: Record<string, unknown>): "browser" | "tool" {
  return getAppAdapter(adapterKind(step))?.legacyKind ?? "browser";
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
    const stepId = merged["id"] === undefined || merged["id"] === null ? null : String(merged["id"]);
    const stepNext = Array.isArray(merged["next"]) ? (merged["next"] as unknown[]).map((x) => String(x)) : [];
    const adapter = getAppAdapter(adapterKind(merged));
    if (adapter === undefined) {
      // 加载期校验已经报过这条；这里不让它把展开变成"半成品步骤"。
      subProblems.push(`journey[${i}].adapter: unknown app adapter ${JSON.stringify(adapterKind(merged))} `
        + `(known: ${listAppAdapterObjects().map((a) => a.kind).join(", ")})`);
      return;
    }
    const out = adapter.expand(merged, `journey[${i}]`);
    if (out.subgoal) browserSubgoals.push(out.subgoal);
    steps.push({
      index: i, adapter: adapter.kind, kind: adapter.legacyKind,
      desc: String(merged["desc"]), role, id: stepId, next: stepNext,
      decl: out.decl,
      ...(out.subgoal ? { subgoal: out.subgoal as Subgoal } : {}),
      ...(out.tool ? { tool: out.tool } : {}),
    });
  });
  if (subProblems.length) {
    throw new Error(`app pack ${pack.id} is invalid:\n  - ${subProblems.join("\n  - ")}`);
  }
  const plan = new TaskPlan(pack.goal, browserSubgoals as unknown as Array<Partial<Subgoal>>, planPath, slots);
  // 不变量与步骤同一套 `{slot}` 规则（未知占位符已在 `validatePack` 里红过了）。
  // Slice 4：按 `adapter` 分派——web（缺省）= 浏览器结束态断言；其它 = 该类型的只读观察探针。
  const invariants = (pack.invariants ?? []).map((raw) => {
    const inv = substitute(raw, bag, []) as AppInvariant;
    const kind = inv.adapter === undefined || inv.adapter === null ? "web" : String(inv.adapter).trim().toLowerCase();
    const adapter = getAppAdapter(kind);
    if (adapter === undefined || kind === "web") return { ...inv, adapter: "web" };
    const out = adapter.expand({ ...inv, desc: String(inv.desc ?? inv.id) }, `invariants:${inv.id}`);
    return { ...inv, adapter: kind, decl: out.decl };
  });
  return { pack, steps, plan, invariants, slots, rolesUsed: [...new Set(used)] };
}

/**
 * 数据腿结果 → 槽位（**回写的唯一实现**）。
 *
 * 为什么放在这里：应用层的"数据腿跑完了"有三个出口（应用运行器、`--dry` 的声明视图、
 * 将来的其它驱动），每个出口各写一份"从 selects 里抠字段"的逻辑，就会有第二份口径——
 * 本仓库为这种事付过账（hint 语法、`{dataset:NAME}` 替换都是两份实现）。
 *
 * 只认声明过的取值点，取不到就**不写**（保留调用方给的既有值）；写回的是观测值，
 * 不是"猜一个差不多的"。
 */
export function resolveSourceSlots(
  pack: AppPack, observed: Record<string, SourceObservation>,
): Record<string, string> {
  const decl = pack.source_slots;
  if (!isDict(decl)) return {};
  const out: Record<string, string> = {};
  for (const [slot, b] of Object.entries(decl)) {
    if (!isDict(b)) continue;
    const obs = observed[String(b["source"])];
    if (obs === undefined) continue;                 // 没跑（--no-sources / 源被跳过）：不写，让占位符响亮
    if (b["select"] !== undefined) {
      const row = obs.selects[String(b["select"])] ?? null;
      if (row === null) continue;
      const f = b["field"];
      const v = f === undefined ? rowMainValue(row) : row[String(f)];
      if (v === undefined || v === null || String(v) === "") continue;
      out[slot] = String(v);
    } else if (b["count"] !== undefined) {
      const n = obs.counts[String(b["count"])];
      if (n === undefined) continue;
      out[slot] = String(n);
    }
  }
  return out;
}
