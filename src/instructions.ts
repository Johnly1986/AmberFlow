/**
 * 指令注册表（NL Flow S2，docs/NL_FLOW_DESIGN.md §2.2）——提名梯级的**闭集**。
 *
 * 两半分界（与命令层 `actions.ts` 同一条裁定）：
 *   - **能力面是代码**：本表就是"运行期可以被提名的指令"全集——闭集不可逃逸，
 *     提名答案不在集合内 = 弃权（fail closed），绝不为凑答案现造一条指令。
 *   - **组合是配置**：`list_pick` 这类组合指令由原语声明式组合而成（S3 落地组合 DAG 校验）。
 *
 * 双契约（设计文档 §2.2：每条指令必须声明参数契约与输出契约）在 S2 的最小形状：
 *   - S2 的原语都消费"目标元素"（由执行器既有的 hint/模型/老师梯级解析）与
 *     "值"（S1 的四种绑定来源之一，缺绑定 = `needs_value`）——参数契约由命令层承担；
 *   - `outputs` 目前只有 `list_pick` 产出行/选中行（S1 数据集的写入方），
 *     其余原语无产出。契约随 S3 组合层补全，schema 先立、字段后长。
 *
 * 可逆性纪律（红线③的提名面形态）：本表的指令**全部可逆**（错了 = 一步白跑，信号裁决收回）。
 * 不可逆动作（购买/提交订单）不是一条可提名的指令——它永远是清单里**显式声明**的
 * `dangerous` 步，走 dry-run + 人确认，永不进闭集（设计文档 §8）。
 */

/** 一条可提名指令的声明。 */
export interface InstructionDecl {
  name: string;
  /** 给 ③ 窄问当 criteria 文案（执行器实测问法形状里 criteria 的值就是这种短描述）。 */
  desc: string;
  /** 提名错了的爆炸半径：可逆指令 = 一步白跑；本表只收可逆指令。 */
  reversible: boolean;
}

/** 引擎能力面：可提名指令全集（代码，不是词表配置）。 */
export const INSTRUCTION_SET: readonly InstructionDecl[] = [
  { name: "click", desc: "点击一个链接、按钮或控件（打开/进入/提交/记录）", reversible: true },
  { name: "fill", desc: "在一个文本输入框里填写文字（日期、名称、编号）", reversible: true },
  { name: "select", desc: "在一个下拉框里选择一个选项", reversible: true },
  { name: "check", desc: "勾选一个复选框或单选框", reversible: true },
  { name: "list_pick", desc: "从列表行里按数据规则选一行（最低价/最高价/最小/最大）", reversible: true },
];

export const INSTRUCTION_NAMES: readonly string[] = INSTRUCTION_SET.map((i) => i.name);

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
