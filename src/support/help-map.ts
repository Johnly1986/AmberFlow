/**
 * help-map —— 概述层（层 1）的唯一出处：引擎是什么、什么时候用、从哪开始。
 *
 * 设计出处：docs/PROMPT_SYSTEM.md §2。投放面（全部渲染，不许手抄）：
 *   ① `amber` 无参首页（cli/main.ts home）；
 *   ② `amber --help` 头部（registry.ts GLOBAL_USAGE）；
 *   ③ AGENTS.md「引擎概述」节（逐字嵌入，prompt-hit overview 组校验）；
 *   ④ DSH 桥插件描述（grammar.generated.ts 生成物——桥侧无 AGENTS.md 可读）；
 *   ⑤ `amber schema ctx` 的 overview 节（schema-gen.ts）。
 *
 * 长度预算（prompt-hit overview 组断言，超限即红）：
 *   OVERVIEW_TEXT ≤ 400 字符；每条 when ≤ 40 字符。
 * 叶子模块：零 import。
 */

/** 概述全文（≤400 字符；含两条差异声明，纠正"直接写 Playwright"的错误心智）。 */
export const OVERVIEW_TEXT =
  "AmberFlow 是冻结计划的浏览器自动化引擎：计划由人给出（app.mjs 的 flow(ctx) 脚本），"
  + "引擎逐步选元素、执行动作、验证完成信号；模型只做选择/风险/完成票（完成票仅 advisory），不生成动作，完成只认 DOM/工具信号。"
  + "什么时候用：要在真实网站上自动化一条可验证的流程（采集、下单、巡检、回归），"
  + "且希望每一步有结构化证据与完成裁决时。"
  + "从哪开始：已安装 → amber doctor 体检；checkout 内 → "
  + "node --experimental-strip-types src/cli/main.ts doctor"
  + "（裸 amber 不在 PATH，npx amber 会挂住）。";

/** 概述层与工具层的桥梁：每个 CLI 命令一行"何时用"（每条 ≤40 字符）。 */
export interface WhenToUse {
  readonly cmd: string;
  readonly when: string;
}

export const WHEN_TO_USE: readonly WhenToUse[] = [
  { cmd: "run", when: "应用过了 check，要真跑或按预算试跑" },
  { cmd: "record", when: "宁可演示一次也不想手写流程时" },
  { cmd: "plan", when: "想把计划写成文件再执行（一次性目标除外）" },
  { cmd: "apps", when: "创建、查看、离线校验一个应用" },
  { cmd: "inspect", when: "写流程前先只读看一眼真实页面" },
  { cmd: "schema", when: "无源码时查引擎语义契约" },
  { cmd: "doctor", when: "环境、浏览器、决策源有问题先体检" },
  { cmd: "config", when: "查看或修改机器/项目配置" },
  { cmd: "model", when: "本地决策模型的安装与状态" },
  { cmd: "test", when: "跑真实站点回归（声明在 online/）" },
];

/** 首页「下一步」的唯一出处（单源渲染，不许手抄；prompt-hit 断言 cmd 都是 registry 命令）。 */
export interface HomeNext {
  readonly cmd: string;
  readonly args?: string;
  readonly why: string;
}

export const HOME_NEXT: readonly HomeNext[] = [
  { cmd: "test", args: "--tier smoke", why: "跑一轮真实站点可达性" },
  { cmd: "run", args: '--goal "把商品加入购物车" --url <页面>', why: "直接跑一条一次性目标" },
  { cmd: "record", args: "https://shop.example.com", why: "录一条自己的流程" },
  { cmd: "doctor", why: "环境有问题时先体检" },
];
