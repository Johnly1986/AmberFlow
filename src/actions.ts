/**
 * 命令层（④a，P2 落地）——把"一步 = 一个指针"改成"一步 = 一个**命令闭集**"。
 *
 * 出处是这场重审自己的话（docs/ARCHITECTURE_REVIEW.md §0）：执行层的真正问题不是
 * "少了一层命令层"，而是 `run()` 把"实例化动作空间 / 选择 / 应用动作"揉在同一个可变
 * 状态机里。本模块只接前两件事的一半，且**全部可选**：不声明 `commands` 的包，
 * 展开结果、计划文件、执行路径与今天逐字节相同（缺省等价的硬约束，§8.4）。
 *
 * 两半分界（§6.1 勘误后的口径）：
 *   - **声明半（加载期）**：`COMMAND_OPS` 是引擎能力面（代码，不是词表配置）；应用配置
 *     里的 `commands` 引用它 + 参数槽 + 该步完成信号。`validateCommands` 对着能力面校验：
 *     未知 op / 重复 id / 缺或多参数 ⇒ 加载期红（与 `sources/*.json` 同一模式）。
 *   - **实例化半（运行期）**：`instantiateSpace` 是**纯函数**——声明 × 当次元素池 ×
 *     forbidden ⇒ "此刻真实可选的命令闭集"。解析不到的候选出局；全部出局 ⇒ 调用方得到
 *     结构化的 `space-empty` 事实，**绝不退回"全量观察"**（同 hint 纪律：未命中不赌）。
 *
 * 红线落点：
 *   - 红线②（不发明取值）：`fill`/`select` 的参数只有**声明绑定**一种来源——
 *     `{"from": "slot", "key": "…"}`，值按计划槽位；缺值即 `needs_value`（如实，不猜），
 *     模型永不参与选值。
 *   - hint 语法（§8.3）：命令的 `target` 用的就是 `rules.hintMatchImpl` 那**一套**语法，
 *     不新开第三种句柄语法。
 *   - 红线③（完成只认该面证据）：命令走完 ≠ 完成；子目标的 `signal` 仍是唯一真相。
 */
import { hintMatch } from "./rules.ts";
import type { ElemPool } from "./extraction.ts";

/** 引擎能力面的动词表（代码）。新增一个面/原语是新 provider，不是在配置里造词。 */
export const COMMAND_OPS = ["click", "check", "fill", "select", "skip"] as const;
export type CommandOp = (typeof COMMAND_OPS)[number];

/** 需要参数绑定的 op；`skip` 无 target；其余必须点名一个 target。 */
const VALUE_OPS: ReadonlySet<string> = new Set(["fill", "select"]);
const NO_TARGET_OPS: ReadonlySet<string> = new Set(["skip"]);

/**
 * 一条命令的声明（应用配置形状）。`target` 是 hint 语法字符串（`#id`、
 * `button[data-test=x]`、裸词……全部走 `hintMatchImpl` 的同一套语义）。
 * `value` 是**绑定**，不是候选：值从计划槽位按名字来。
 */
export interface CommandDecl {
  id: string;
  op: CommandOp | string;         // 字符串收进来，`validateCommands` 对着 COMMAND_OPS 校
  target?: string;
  value?: { from: "slot"; key: string };
}

/** 实例化出的一条可选项：声明 + 当次池里的落点。 */
export interface SpaceCommand {
  decl: CommandDecl;
  ref: string;
  /** 池下标，供调用方回查元素。 */
  index: number;
}

/** `instantiateSpace` 的结果：live 保持声明顺序；missing 记录**为什么**出局。 */
export interface InstantiatedSpace {
  live: SpaceCommand[];
  /** 未解析（目标不在池里）的命令 id，按声明顺序。 */
  unresolved: string[];
  /** 解析得到、但对应元素已被禁（inert/试过）的命令 id。 */
  forbidden: string[];
}

/**
 * 声明半校验（加载期）：未知 op、重复 id、缺/多的 `target`/`value`、非 `slot` 的参数来源，
 * 全部产 problem 字符串（与 `PlanningRules.problems` 同款口径：错误是数据，由调用方汇总）。
 * `slotKeys` 给了就顺带校"参数键必须是声明过的槽位"（应用包层传 merged slots 的键）。
 */
export function validateCommands(
  commands: unknown, where: string, problems: string[], slotKeys?: ReadonlySet<string>,
): void {
  if (!Array.isArray(commands)) {
    problems.push(`${where}: commands must be a list`);
    return;
  }
  if (commands.length === 0) {
    problems.push(`${where}: commands must not be empty (a step either declares a space or acts like today)`);
    return;
  }
  const seen = new Set<string>();
  commands.forEach((c, i) => {
    const at = `${where}.commands[${i}]`;
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      problems.push(`${at}: command must be an object {id, op, target?, value?}`);
      return;
    }
    const cmd = c as Record<string, unknown>;
    const id = typeof cmd["id"] === "string" ? cmd["id"].trim() : "";
    if (!id) problems.push(`${at}: id must be a non-empty string`);
    else if (seen.has(id)) problems.push(`${at}: duplicate command id '${id}' (the closed set needs one name per option)`);
    else seen.add(id);
    const op = cmd["op"];
    if (typeof op !== "string" || !(COMMAND_OPS as readonly string[]).includes(op)) {
      problems.push(`${at}: unknown command op ${JSON.stringify(op)} (capability surface: ${COMMAND_OPS.join("|")})`);
      return;
    }
    if (op === "skip") {
      if (cmd["target"] !== undefined) problems.push(`${at}: op 'skip' takes no target`);
      if (cmd["value"] !== undefined) problems.push(`${at}: op 'skip' takes no value`);
      return;
    }
    const target = cmd["target"];
    if (typeof target !== "string" || target.trim() === "") {
      problems.push(`${at}: op '${op}' needs a target (a hint-grammar string resolved by hintMatch)`);
    }
    const value = cmd["value"];
    if (VALUE_OPS.has(op)) {
      if (value === undefined) {
        problems.push(`${at}: op '${op}' needs value {from:'slot', key} — a value's only source is the plan (红线②)`);
      } else if (typeof value !== "object" || value === null || Array.isArray(value)) {
        problems.push(`${at}: value must be {from:'slot', key}`);
      } else {
        const v = value as Record<string, unknown>;
        if (v["from"] !== "slot") {
          problems.push(`${at}: value.from must be 'slot' (model-chosen and literal-authored values are refused)`);
        }
        if (typeof v["key"] !== "string" || !v["key"].trim()) {
          problems.push(`${at}: value.key must be a non-empty slot name`);
        } else if (slotKeys !== undefined && !slotKeys.has(v["key"])) {
          problems.push(`${at}: value.key ${JSON.stringify(v["key"])} is not a declared slot (known: ${[...slotKeys].join(", ") || "none"})`);
        }
      }
    } else if (value !== undefined && !NO_TARGET_OPS.has(op)) {
      problems.push(`${at}: op '${op}' takes no value (only fill/select bind parameters)`);
    }
  });
}

/**
 * 实例化半（运行期，纯函数）：把命令声明逐条对**当次元素池**解析。
 *
 * - `hintMatch` 命中且元素不在 `forbidden` ⇒ 进 `live`（保持声明顺序——走向由声明与
 *   页面证据决定，不由评分决定）；
 * - 命中但被禁 ⇒ `forbidden` 名单（这个候选本轮出局）；
 * - 没命中 ⇒ `unresolved` 名单（"声明与页面不符"，由调用方决定是否先做过 evicted 回捞
 *   再重新实例化——`hint_lookup` 那条既有纪律）。
 */
export function instantiateSpace(
  commands: readonly CommandDecl[],
  elems: ElemPool,
  forbidden: ReadonlySet<string> = new Set(),
): InstantiatedSpace {
  const live: SpaceCommand[] = [];
  const unresolved: string[] = [];
  const forbiddenOut: string[] = [];
  const entries = Object.entries(elems);
  const indexOf = new Map(entries.map(([ref], i) => [ref, i] as const));
  for (const decl of commands) {
    if (decl.op === "skip") {
      live.push({ decl, ref: "", index: -1 });      // skip 永远可选：执行即推进，不动页面
      continue;
    }
    const ref = decl.target ? hintMatch(decl.target, elems) : null;
    if (ref === null) { unresolved.push(decl.id); continue; }
    if (forbidden.has(ref)) { forbiddenOut.push(decl.id); continue; }
    live.push({ decl, ref, index: indexOf.get(ref) ?? -1 });
  }
  return { live, unresolved, forbidden: forbiddenOut };
}

/** 参数绑定的解析（数据槽层的 P2 一半）：值**只**按计划槽位按名字来；缺 ⇒ needs_value。 */
export function resolveCommandValue(
  decl: CommandDecl, slots: Record<string, unknown>,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (!decl.value) return { ok: false, reason: "no declared binding" };
  if (decl.value.from !== "slot") return { ok: false, reason: `unsupported value source ${JSON.stringify(decl.value.from)}` };
  if (!(decl.value.key in slots)) {
    return { ok: false, reason: `slot ${JSON.stringify(decl.value.key)} is not in the plan's data bag (values come from the plan, never invented)` };
  }
  return { ok: true, value: slots[decl.value.key] };
}
