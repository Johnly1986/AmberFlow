/**
 * 指令注册表（NL Flow S2，docs/NL_FLOW_DESIGN.md §2.2）——提名梯级的**闭集**。
 *
 * 两半分界（与命令层 `actions.ts` 同一条裁定）：
 *   - **能力面是代码**：本表就是"运行期可以被提名的指令"全集——闭集不可逃逸，
 *     提名答案不在集合内 = 弃权（fail closed），绝不为凑答案现造一条指令。
 *   - **组合是配置（S3 已落地）**：组合指令由**原语名按序声明成管线**（`compose`），
 *     由应用脚本/执行器的组合面按声明执行——今天唯一成员是 `list_pick`
 *     （extract_rows → select → act_on_row）。参数（`by`/`order`/行选择器）永远来自
 *     声明（模板 × 档案），解释器不发明任何东西（红线②）。
 *
 * 双契约（设计文档 §2.2：每条指令必须声明参数契约与输出契约）：
 *   - 元素动作（click/fill/select/check）消费"目标元素"（执行器既有梯级解析）与
 *     "值"（S1 四种绑定来源之一），无产出；
 *   - 组合指令声明 `outputs`（产出名 → 类型）——`list_pick` 产出 `chosen`（选中行），
 *     它正是数据集生产面的挂载点（步用 `gives` 把产出名接成具数据集条目）。
 *
 * 可逆性纪律（红线③的提名面形态）：本表的指令**全部可逆**（错了 = 一步白跑，信号裁决收回）。
 * 不可逆动作（购买/提交订单）不是一条可提名的指令——它永远是清单里**显式声明**的
 * `dangerous` 步，走 dry-run + 人确认，永不进闭集（设计文档 §8）。
 */

/** 组合原语名（引擎能力面，代码）。新增原语 = 新 provider，不是在配置里造词。 */
export const COMPOSE_PRIMITIVES = ["extract_rows", "select", "act_on_row"] as const;
export type ComposePrimitive = (typeof COMPOSE_PRIMITIVES)[number];

/** 一条可提名指令的声明。 */
export interface InstructionDecl {
  name: string;
  /** 给 ③ 窄问当 criteria 文案（执行器实测问法形状里 criteria 的值就是这种短描述）。 */
  desc: string;
  /** 提名错了的爆炸半径：可逆指令 = 一步白跑；本表只收可逆指令。 */
  reversible: boolean;
  /** 组合管线的原语序（缺省 = 元素动作，走执行器支线，不在此层）。 */
  compose?: readonly ComposePrimitive[];
  /** 输出契约：产出名 → 类型（`row` = 选中行对象）。步用 `gives` 把它们接进数据集。 */
  outputs?: Readonly<Record<string, "row">>;
}

/** 引擎能力面：可提名指令全集（代码，不是词表配置）。 */
export const INSTRUCTION_SET: readonly InstructionDecl[] = [
  { name: "click", desc: "点击一个链接、按钮或控件（打开/进入/提交/记录）", reversible: true },
  { name: "fill", desc: "在一个文本输入框里填写文字（日期、名称、编号）", reversible: true },
  { name: "select", desc: "在一个下拉框里选择一个选项", reversible: true },
  { name: "check", desc: "勾选一个复选框或单选框", reversible: true },
  {
    name: "list_pick",
    desc: "从列表行里按数据规则选一行（最低价/最高价/最小/最大）",
    reversible: true,
    compose: ["extract_rows", "select", "act_on_row"],
    outputs: { chosen: "row" },
  },
];

export const INSTRUCTION_NAMES: readonly string[] = INSTRUCTION_SET.map((i) => i.name);

export function getInstruction(name: string): InstructionDecl | null {
  return INSTRUCTION_SET.find((i) => i.name === name) ?? null;
}

/**
 * 注册表自校验（加载期跑一次）：compose 只能引用已注册原语、原语不重复、
 * 声明的指令名唯一。违反 = 抛错——注册表是代码，坏注册表不该活到运行期。
 */
export function validateInstructionRegistry(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const inst of INSTRUCTION_SET) {
    if (seen.has(inst.name)) problems.push(`duplicate instruction ${JSON.stringify(inst.name)}`);
    seen.add(inst.name);
    if (inst.compose) {
      const dup = inst.compose.filter((op, i) => inst.compose!.indexOf(op) !== i);
      for (const op of inst.compose) {
        if (!(COMPOSE_PRIMITIVES as readonly string[]).includes(op)) {
          problems.push(`instruction ${inst.name}: unknown compose primitive ${JSON.stringify(op)} (capability: ${COMPOSE_PRIMITIVES.join("|")})`);
        }
      }
      if (dup.length) problems.push(`instruction ${inst.name}: duplicate compose primitive(s) ${dup.join(", ")}`);
      if (!inst.outputs || Object.keys(inst.outputs).length === 0) {
        problems.push(`instruction ${inst.name}: a composed instruction must declare outputs (否则产出没有契约可言)`);
      }
    }
  }
  return problems;
}

/** ③ 窄问的 criteria（名字 → 文案），即 S0 实验台测过的那张考卷。 */
export function instructionCriteria(): Record<string, string> {
  return Object.fromEntries(INSTRUCTION_SET.map((i) => [i.name, i.desc]));
}

export function isInstructionName(v: unknown): v is string {
  return typeof v === "string" && INSTRUCTION_NAMES.includes(v);
}

/**
 * ⑤ 枚举裁决的缺省序（S0 实测：本语料真值 ∈ {click, fill, select}，序内覆盖 100%，
 * 真值平均位置 0.88 —— 裁决兜回来的代价有界）。序是**声明的**，调用方可覆盖；
 * 新指令进闭集时要同步看 S0 报告的"真值分布"一列。
 */
export const DEFAULT_ENUM_ORDER: readonly string[] = ["click", "fill", "select", "check", "list_pick"];

// 注册表是代码：坏注册表不该活到运行期（加载期响亮失败）。
{
  const problems = validateInstructionRegistry();
  if (problems.length) throw new Error(`instruction registry invalid: ${problems.join("; ")}`);
}
