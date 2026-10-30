/**
 * 高效规划流程（Planning Playbook）的**唯一出处**——引擎不只被动报错，要在规划路径的
 * 每个节点主动告诉 Agent「下一步怎么走最高效」。
 *
 * 文本由六个面投放（同一句话，不许各面手抄）：
 *   ① `apps new` 骨架注释（commands/apps.ts，Agent 建应用的第一眼，工具结果直接带源码）；
 *   ② `inspect` 的 next 建议（commands/inspect.ts，按池状态**条件触发**，空池才引导）；
 *   ③ run 失败的 next 建议（app-runner.ts CLI 输出与 report.md，按 stop_code 映射）；
 *   ④ executor 停因 reason（hint 未命中附闭集——闭集文本仍由 `grammar-prompt.ts` 生成）；
 *   ⑤ 桥生成物（grammar.generated.ts 的 PLAN_PLAYBOOK_SHORT，桥 "called, not embedded"）；
 *   ⑥ 文档快速路径（docs/APP_SCRIPT_AUTHORING.md 逐字嵌入，prompt-hit 第 6 层校验）。
 *
 * 蒸馏自 2026-10-29 双代理实测（93 min 任务分解：纯执行 4%、取证 26%、迭代改版 16%——
 * 本 playbook 压的就是那 42% 的规划期信息获取成本）。叶子模块：零 import。
 */

/** 五步法全文（文档逐字嵌入 + apps new 骨架注释逐字插入，prompt-hit 校验）。 */
export const PLAN_PLAYBOOK_TEXT = `高效规划五步法（Planning Playbook）：
① 先看再写：amber inspect --url <页> --json 拿验证过的 hint_candidates——有候选照抄，别自创选择器；
② 单步探针先行：先写 1 步探针应用（arrive + read）验证四件事：页面可达 / 无登录墙 / 无验证码 / 目标数据在 DOM。探针 30 秒判死刑，好过全流程应用跑 5 轮；
③ 正式应用参数化：单段/单城 + slots，1 步 flow；早停守卫（命中登录墙/验证码特征 → ctx.fail("blocked:…")）+ meta.policy 声明 done_timeout_ms，不盲等；
④ 离线分支校验：amber apps check <id> --slot k=v（不启浏览器）验证各分支调用序列；
⑤ 真跑留证：amber run <id> --trace；失败先看 trace 的 stopCode/reason——reason 自带修正指引。`;

/** 压缩版（桥 `_app_create` 工具描述用；生成物逐字分发，工具描述不能太长）。 */
export const PLAN_PLAYBOOK_SHORT = `高效规划五步法：① inspect 先看（验证过的 hint_candidates 可照抄）→ ② 单步探针先行（1 步 arrive+read 验证：页面可达 / 无登录墙 / 无验证码 / 目标数据在 DOM）→ ③ 正式应用参数化（slots + 早停守卫 + meta.policy 声明 done_timeout_ms）→ ④ apps check <id> --slot k=v 离线分支校验 → ⑤ run --trace 真跑，失败看 stopCode/reason。`;

/**
 * 失败特征速查（**通用风控判定，只判不绕**：判定 + 早停，不含任何绕过手段）。
 * 实测来源：m.ctrip.com 五轮移动站取证（2026-10-29），特征本身是通用模式。
 */
export const FAILURE_SIGNS_TEXT = `失败特征速查（只判不绕，命中即 ctx.fail("blocked:…") 早停）：
- body 极短（<200 字符）+「登录/注册」浮层 = 登录墙：换可匿名读价的来源或如实标 blocked，别重试表单；
- 卡片价格处全是「登录看低价」= 服务端价格闸：匿名会话拿不到价格，不是渲染问题，早停；
- 价格列全是「查价」+ 页尾「服务器异常」= 站点限流：等待与重试无效，早停；
- 「依次点击图标验证 / 滑动拼图」= 验证码：不代过，立即早停。`;

/** inspect 的空池判定（绝对近空，或相对近空：页面上交互元素多而池几乎没收进来）。 */
export function poolNearEmpty(poolCount: number, interactiveOnPage: number): boolean {
  if (poolCount === 0) return true;
  if (interactiveOnPage < 10) return false;
  return poolCount * 5 < interactiveOnPage;
}

/**
 * inspect 的 `next` 建议：池正常时与历史文案逐字一致（缺省等价），空池才给取证配方。
 */
export function nextForInspect(poolCount: number, interactiveOnPage: number, url: string): string[] {
  if (!poolNearEmpty(poolCount, interactiveOnPage)) {
    return [`amber run --goal "<目标>" --url ${url}`, "amber doctor"];
  }
  return [
    `amber inspect --url ${url} --wide --pool   # 宽扫：含启发式伪按钮的真实 label（heuristic 标记可辨）`,
    "1 步探针应用先行（五步法②）：arrive + read 验证可达/无登录墙/无验证码/数据在 DOM，再写正式应用",
    "probe/DOM 命中 ≠ hint 可命中；登录墙/验证码等失败特征与早停配方见 docs/APP_SCRIPT_AUTHORING.md 快速路径",
  ];
}

/**
 * run 失败的下一步建议（按停因映射；只收实测验证过的停因，未知 code 返回 null——
 * 宁可不建议，不给泛泛而谈）。hint 未命中的语法纠正由 executor 停因 reason 自带。
 */
const STOP_NEXT: Readonly<Record<string, string>> = {
  max_steps: "预算用尽：先看 trace 各步的 stopCode/reason 找第一个失败；多数是目标不可分辨或页面未变——按五步法② 收窄为单步探针",
  budget_exceeded: "ctx.step 预算用满（status=partial、verified=false）：调高 --max-steps 或按五步法② 收窄流程",
  arrive_signal_not_held: "导航完成但 done 信号未成立：确认「动作前不成立、动作后成立」；重 JS SPA 先 inspect --wide --pool 或运行时取证",
  done_not_held: "命令闭集已走完但 done 未成立：检查 done 信号是否真的会在动作后成立",
  low_confidence: "决策层低置信：看 trace 的 decisions 行与候选 label；有稳定句柄（id / data-test / 唯一 label）就写 act hint 收窄（六形状闭集见 docs/APP_SCRIPT_AUTHORING.md）",
  no_model_runtime: "rules-only 模式需要规则命中：加 target_hint，或配置决策源（docs/DECISION_SERVICE_CONFIG.md）",
};

export function nextForStop(code: string): string | null {
  return STOP_NEXT[code] ?? null;
}
