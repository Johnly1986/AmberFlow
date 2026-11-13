/**
 * 介入 / 救援中断模块 —— 求援提示词**数据**（零 import 叶子）。
 *
 * 设计出处：docs/INTERVENTION_RESCUE_MODULE.md（v2）§6。
 * 只覆盖求援 kind，不接管既有 31+ 停因文案（STOP_NEXT 的工程动作仍归 planning-playbook.ts）。
 *
 * 四层分离（每 kind）：
 *   事实层 summary       人话报告 / TTY 提示（zh 权威）
 *   问题层 human_question  一个问题 + 选项 ≤3 + 默认 + 可拒绝（TTY / 同步通道）
 *   动作层 next_actions    由通道渲染（TTY 命令 / Agent 结构化 next）
 *   机器层 agent_hint      独立结构化字段（en，跟桥合同语言）：fact + recommended_action + stop_condition
 *
 * 语言矩阵（v2 裁决）：事实层 / 问题层面向最终用户 → 永远 zh；
 * agent_hint 面向模型 → 跟随桥合同语言（现状 en）；agent_hint 内不得混入面向人的祈使句。
 *
 * 断言进 prompt-hit（§6 清单，实施照抄）：
 *   ① 每条 zh 非空；② en 可空但渲染器不得拼 zh；③ summary ≤400 字；
 *   ④ human_question ≤120 字；⑤ 人话层禁 stopCode 键名 / JSON / 英文栈；
 *   ⑥ agent_hint 不含面向人的祈使句。
 */

/** 每个求援 kind 的四层文案（语义字段；zh/en 渲染由消费面决定，本文件存权威 zh）。 */
export interface RescueTextSpec {
  /** 事实层（zh，≤400 字）：卡在哪 / 为什么 / 影响 / 已完成什么。 */
  readonly summary: string;
  /** 问题层（zh，≤120 字）：一个问题 + 选项 ≤3 + 默认 + 可拒绝。 */
  readonly human_question: string;
  /** 动作层：由通道渲染的下一步（≤3 条）。 */
  readonly next_actions: readonly string[];
  /** 机器层（en）：fact / recommended_action / stop_condition——不是人话翻译。 */
  readonly agent_hint: {
    readonly fact: string;
    readonly recommended_action: string;
    readonly stop_condition: string;
  };
}

/**
 * v1 注册表文案：键集必须与 RESCUE_KINDS（intervention-contract 的注册表实例）逐键一致
 * （prompt-hit 断言双向一致；示例文案必须逐条对应 v1 注册表中的 kind——不为本期不存在的
 * 通道（GUI）生成文案）。credential 依赖保险箱（未建）——不注册、不生成文案。
 */
export const RESCUE_TEXTS: Readonly<Record<string, RescueTextSpec>> = {
  action: {
    summary:
      "需要你本人完成一步：短信验证码只能你收（引擎不代收）。浏览器窗口已打开，完成后回这里按 Enter；"
      + "输入 n 放弃——放弃不会自动重试，已完成的步骤和截图都保留在结果里。",
    human_question: "这一步你完成了吗？（Enter = 完成；n = 放弃）",
    next_actions: [
      "在浏览器窗口里完成该步操作，然后回到终端按 Enter",
      "放弃：输入 n（已完成的步骤与证据保留，流程停止）",
    ],
    agent_hint: {
      fact: "STOP needs_human: 2FA required; engine won't fake a human",
      recommended_action: "ask the user ONCE to run `amber run <id> --headful`",
      stop_condition: "retry the same run at most once, then report and stop",
    },
  },
  value: {
    summary:
      "还缺一个值：优惠码。用 `--slot coupon=…` 重跑最快（只用于本次运行，不进日志）。"
      + "没有值就先别跑，引擎不会替你编。",
    human_question: "要继续就需要这个值：用 --slot 传入后重跑？（没有值就停止）",
    next_actions: [
      "拿到真实值后：--slot <键>=<值> 重跑（值不进日志）",
      "没有值：如实向上游返回缺值，不要编造默认值",
    ],
    agent_hint: {
      fact: "STOP needs_value: a declared slot has no value; engine never invents values",
      recommended_action: "report the missing slot to the caller and ask for the real value",
      stop_condition: "do not retry with a guessed or empty value",
    },
  },
  authorization: {
    summary:
      "这步操作不可逆（如删除、支付、授权），引擎默认不执行。确认是你本人的意图后，"
      + "明确重跑并显式允许；引擎不会替你点头。",
    human_question: "确认执行这个不可逆操作吗？（默认不执行；确认需显式）",
    next_actions: [
      "确认意图后：显式带确认参数重跑（引擎默认拒绝危险动作）",
      "不确认：流程如实停止，不伪装成功",
    ],
    agent_hint: {
      fact: "STOP needs_human: irreversible action requires explicit human authorization",
      recommended_action: "report the blocked action to the user and wait for explicit consent",
      stop_condition: "never retry the destructive action without explicit consent",
    },
  },
};

/** 人确认了但页面证据没成立（五态里用户最困惑的时刻；防话术漂移的压力测试文案，§6 示例 3）。 */
export const SIGNAL_NOT_HELD_TEXT =
  "你按了 Enter，但页面还没出现声明的完成信号（订单列表页）。确认操作已完成就检查信号定义是否过期；"
  + "没完成就回浏览器继续操作后重新确认。";

/** 五态差异化人话（§5.4，v2 新增；差异同时落到 agent_hint 停手条件）。 */
export const OUTCOME_TEXTS: Readonly<Record<string, string>> = {
  declined: "已放弃，流程停止（不是失败；已完成的步骤和证据都保留）",
  timeout: "等了你 N 分钟没等到，流程停了（重新运行会再问一次）",
  cancelled: "你取消了，流程停止",
  unavailable: "当前环境没有能等你的通道（批处理/无 TTY），流程已停，换交互终端重跑",
};

/** fulfilled 但信号不成立（绝不静默算绿；复核失败结构化停 manual_signal_not_held 类）。 */
export const FULFILLED_NOT_HELD_TEXT =
  "你确认了，但页面证据没成立（已完成步骤保留，本步不算完成）";
