/**
 * 指令提名梯级（NL Flow S2，docs/NL_FLOW_DESIGN.md §4）——"模型参与判断"的正确姿势。
 *
 * 梯级五档，**命中即停**；无论哪档提名，完成一律由该步自己的信号裁决（红线③）：
 *
 *   ① 规则匹配（`ruleNominate`）：确定性关键词梯级，数据规则优先——"选择最低价"必须先撞
 *      `list_pick`，才不会被 select 的"选择"吃掉。没命中就是**弃权**，不是猜。
 *   ② 档案映射（`memory`）：已学映射，键由调用方拼（app/site/stepId）；纪律归学习环
 *      （staged → 零模型重放 → commit；drift 撤下——语义流已落地的那套）。
 *   ③ 模型窄问（`ask`）：选项 = 指令闭集；**答案不在闭集内 = 弃权**（fail closed，
 *      绝不为凑答案现造指令）。注入式——执行器/实验台各自提供自己的问法。
 *   ④ 老师点名（`teacher`）：LLM 点名（同 ③ 的闭集校验）。不可逆步允许 ④、禁 ③⑤。
 *   ⑤ 枚举裁决（`order` 首位）：零智能兜底——调用方拿 `order` 按序试，信号不成立换下一条。
 *      S0 实测本序对已验收语料 100% 覆盖、真值平均位置 0.88，兜底代价有界。
 *
 * S0 的直接推论（bench/instruction-nomination/REPORT.md）：③ 在 desc-only 问法下
 * **低于零智能基线**（4.8% vs 51.5%）——所以缺省姿势是 ①②⑤ 承重、③ 可选；
 * 本模块把 ③ 做成注入点而不是内置调用，正是为了让"要不要问模型"成为调用方的策略。
 */
import { DEFAULT_ENUM_ORDER, INSTRUCTION_NAMES, isInstructionName } from "./instructions.ts";

/**
 * ① 确定性关键词梯级（单一出处：S0 实验台与运行期共用这一份——
 * 词表就是 S0 测过的那张，改动 = 换考卷，必须重跑 S0 并各记各数）。
 *
 * @returns 指令名，或 null = 弃权（梯级往下走）。
 */
export function ruleNominate(desc: string): string | null {
  const d = desc.toLowerCase();
  if (/最低价|最低|最便宜|最贵|最高价|最高|最小|最大|cheapest|lowest|highest/.test(d)) return "list_pick";
  if (/勾选|复选|单选|勾上|check/.test(d)) return "check";
  if (/下拉|选择.*(选项|航班|酒店|日期|房型)|(select).*(option|dropdown)/.test(d)) return "select";
  if (/输入|填写|填入|键入|fill|type/.test(d)) return "fill";
  if (/点击|单击|进入|打开|跳转|提交|搜索|记录|保存|click|open|press|submit|search/.test(d)) return "click";
  return null;
}

/** ② 已学映射的最小读取面（存储与纪律归学习环；语义流试点绑 SiteProfileMemory 同款库）。 */
export interface NominationMemory {
  /** 键没有学过 / 已被 drift 撤下 ⇒ null。 */
  lookupInstruction(stepKey: string): string | null;
}

/** ③④ 的共享形状：给 desc 与闭集选项，返回提名或 null（null = 弃权）。 */
export type NominationAsk = (desc: string, options: readonly string[]) => Promise<string | null>;

export type NominationVia = "rule" | "learned" | "model" | "teacher" | "enumerate";

export interface NominateInput {
  /** 步骤的自然语言描述（③④ 的题面）。 */
  desc: string;
  /** ② 的键（调用方拼：app/site/stepId）。不给 = 跳过该档。 */
  stepKey?: string;
  /** ② 已学映射（不给 = 跳过该档）。 */
  memory?: NominationMemory | null;
  /** ③ 模型窄问（不给 = 跳过该档——rules-only / 不可逆步的缺省姿势）。 */
  ask?: NominationAsk | null;
  /** ④ 老师点名（不给 = 跳过该档）。 */
  teacher?: NominationAsk | null;
  /** ⑤ 枚举序（缺省 `DEFAULT_ENUM_ORDER`；调用方覆盖时未知名会被剔除）。 */
  order?: readonly string[];
}

export interface Nomination {
  /** 梯级选出的指令；null = 全梯级空手（⑤ 也空）——调用方如实阻塞，不猜。 */
  instruction: string | null;
  /** 命中档（证据面：进 trace/报告，与执行器 `method` 同一口径）。 */
  via: NominationVia;
  /** ⑤ 裁决用的完整枚举序（信号不成立时调用方按序换下一条；含命中的那条在首位之后的位置里）。 */
  order: readonly string[];
}

/** 档案/问句给的名字必须在闭集内：不在 = 这一档弃权，绝不采纳。 */
const inSet = (v: string | null | undefined): string | null => (isInstructionName(v) ? v : null);

/** ⑤ 的枚举序：调用方声明优先、过滤未知名、去重；空了就回落缺省序。 */
function enumOrder(order?: readonly string[]): readonly string[] {
  if (!order) return DEFAULT_ENUM_ORDER;
  const cleaned = order.filter(isInstructionName);
  const deduped = [...new Set(cleaned)];
  return deduped.length ? deduped : DEFAULT_ENUM_ORDER;
}

/**
 * 梯级主入口。永不抛异常：③④ 的 ask 抛错 = 该档弃权（与执行器"老师抛错降级"同一口径），
 * 绝不让一个坏 provider 打死整条计划。
 */
export async function nominateInstruction(input: NominateInput): Promise<Nomination> {
  const order = enumOrder(input.order);
  // ① 规则
  const ruled = inSet(ruleNominate(input.desc));
  if (ruled !== null) return { instruction: ruled, via: "rule", order };
  // ② 档案
  if (input.memory && input.stepKey) {
    const learned = inSet(input.memory.lookupInstruction(input.stepKey));
    if (learned !== null) return { instruction: learned, via: "learned", order };
  }
  // ③ 模型窄问
  if (input.ask) {
    try {
      const asked = inSet(await input.ask(input.desc, INSTRUCTION_NAMES));
      if (asked !== null) return { instruction: asked, via: "model", order };
    } catch { /* 坏 provider = 该档弃权，不是崩溃 */ }
  }
  // ④ 老师
  if (input.teacher) {
    try {
      const named = inSet(await input.teacher(input.desc, INSTRUCTION_NAMES));
      if (named !== null) return { instruction: named, via: "teacher", order };
    } catch { /* 同上 */ }
  }
  // ⑤ 枚举首位（调用方按 order 裁决换条；order 空 = 结构上没得选）
  if (order.length > 0) return { instruction: order[0]!, via: "enumerate", order };
  return { instruction: null, via: "enumerate", order };
}
