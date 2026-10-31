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
② 单步探针先行：先写 1 步探针应用（arrive + read）验证四件事：页面可达 / 登录与验证可处理 / 无风控拦截 / 目标数据在 DOM。探针 30 秒判死刑，好过全流程应用跑 5 轮；
③ 正式应用参数化：单段/单城 + slots，1 步 flow；早停守卫（凭据/验证不可得，或命中反爬风控 → ctx.fail("blocked:…")）+ meta.policy 声明 done_timeout_ms，不盲等；
④ 离线分支校验：amber apps check <id> --slot k=v（不启浏览器）验证各分支调用序列；
⑤ 真跑留证：amber run <id> --trace；失败先看 trace 的 stopCode/reason——reason 自带修正指引。`;

/** 压缩版（桥 `_app_create` 工具描述用；生成物逐字分发，工具描述不能太长）。 */
export const PLAN_PLAYBOOK_SHORT = `高效规划五步法：① inspect 先看（验证过的 hint_candidates 可照抄）→ ② 单步探针先行（1 步 arrive+read 验证：页面可达 / 登录与验证可处理 / 无风控拦截 / 数据在 DOM）→ ③ 正式应用参数化（slots + 早停守卫 + meta.policy 声明 done_timeout_ms）→ ④ apps check <id> --slot k=v 离线分支校验 → ⑤ run --trace 真跑，失败看 stopCode/reason。`;

/**
 * 失败特征速查（**通用风控判定，只判不绕反爬风控**：判定 + 早停，不含任何绕反爬手段；验证环节可代过）。
 * 实测来源：m.ctrip.com 五轮移动站取证（2026-10-29），特征本身是通用模式。
 */
export const FAILURE_SIGNS_TEXT = `失败特征速查（只判不绕反爬风控：命中反爬风控即 ctx.fail("blocked:…") 早停；验证环节可代过）：
- body 极短（<200 字符）+「登录/注册」浮层 = 登录墙：换可匿名读价的来源，或用凭据 + 验证步骤处理；无凭据/无授权时如实标 blocked，别重试表单；
- 卡片价格处全是「登录看低价」= 服务端价格闸：匿名会话拿不到价格，不是渲染问题，早停；
- 价格列全是「查价」+ 页尾「服务器异常」= 站点限流：等待与重试无效，早停；
- 「依次点击图标验证 / 滑动拼图」= 验证码：属验证环节，可在用户授权下由人工步/注入处理器代过；若站点同时以风控/限流拦截（反爬），不绕，立即早停。`;

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
    "1 步探针应用先行（五步法②）：arrive + read 验证可达/登录与验证可处理/无风控拦截/数据在 DOM，再写正式应用",
    "probe/DOM 命中 ≠ hint 可命中；反爬风控/登录墙等失败特征与早停/代过配方见 docs/APP_SCRIPT_AUTHORING.md 快速路径",
  ];
}

/**
 * run 失败的下一步建议（按停因映射；只收实测验证过的停因，未知 code 返回 null——
 * 宁可不建议，不给泛泛而谈）。hint 未命中的语法纠正由 executor 停因 reason 自带。
 * 键集纪律：schema-gen 的 STOPCODE_MEANING 键集 ⊆ STOP_NEXT ∪ EXEMPT_NEXT
 * （prompt-hit coverage 组断言）——新增停因要么给 next，要么显式豁免。
 */
export const STOP_NEXT: Readonly<Record<string, string>> = {
  max_steps: "预算用尽：先看 trace 各步的 stopCode/reason 找第一个失败；多数是目标不可分辨或页面未变——按五步法② 收窄为单步探针",
  budget_exceeded: "ctx.step 预算用满（status=partial、verified=false）：调高 --max-steps 或按五步法② 收窄流程",
  arrive_signal_not_held: "导航完成但 done 信号未成立：确认「动作前不成立、动作后成立」；重 JS SPA 先 inspect --wide --pool 或运行时取证",
  done_not_held: "命令闭集已走完但 done 未成立：检查 done 信号是否真的会在动作后成立",
  low_confidence: "决策层低置信：看 trace 的 decisions 行与候选 label；有稳定句柄（id / data-test / 唯一 label）就写 act hint 收窄（六形状闭集见 docs/APP_SCRIPT_AUTHORING.md）",
  no_model_runtime: "rules-only 模式需要规则命中：加 target_hint，或配置决策源（docs/DECISION_SERVICE_CONFIG.md）",
  config_error: "停因 reason 自带具体声明错误；改 meta/声明后先 amber apps check <id>（离线）再重跑",
  host_not_allowed: "目标主机加进 meta.hosts，或改用 meta.site.pages + ctx.openPage；amber apps check 离线可验",
  invariant_failed: "看 steps[] 最后一步是否真的到达结束页；amber inspect --probe 实证不变量选择器后再改",
  missing_done: "flow 末尾补 ctx.done()；声明了结束态不变量就必须验收，不能跳过",
  needs_value: "slot 缺值：值必须来自任务输入或数据源（--slot k=v 传入）；没有真实值就如实返回 needs_value 给上游，不要造默认值",
  trace_mismatch: "重放条件不符（脚本版本/输入变了）：重新完整运行，不要重放",
  precondition_skipped: "不是失败：按 stopCode 分支继续；误跳则修 when 条件（先 inspect 实证前提信号）",
  hint_matched_nothing: "hint 在池内零命中：reason 自带六形状闭集提示；先 inspect 拿验证过的 hint_candidates 再改（别自创选择器）",
  needs_human: "非 TTY 遇到人工步：换交互终端重跑，或 --headful 让真人完成后再继续；引擎不假装有人（docs/MANUAL_STEPS_AND_PACE.md）",
  frame_not_allowed: "frame origin 不在信封内：把该 origin 加进 meta.hosts（或改用 meta.site.pages + ctx.openPage）；apps check 离线可验",
  popup_not_allowed: "popup origin 不在信封内：把该 origin 加进 meta.hosts；apps check 离线可验",
  manual_signal_not_held: "人已确认但 DOM 信号复核未过：确认该步真的完成，并复核 done 信号选择器（inspect --probe 实证）；不会静默算绿",
  action_unsupported: "动作不在能力面内：查 amber schema ctx --topic commands 的命令闭集，换成支持的动作或改目标",
  target_not_found: "目标零命中：按 reason 的六形状闭集提示改 hint；先 inspect 拿验证过的 hint_candidates（别自创选择器）",
  target_ambiguous: "多候选歧义：按 trace 候选 label 收窄 hint（id / data-test / 唯一 label）；inspect 拿 hint_candidates",
  hint_matched_no_target: "target_hint 在池内零命中：按 reason 的闭集提示改 hint；先 inspect 拿候选",
  step_names_no_target: "步骤未点名目标且无候选：写明目标或加 target_hint（先 inspect）；属声明层修复，apps check 离线可验",
  noul_unverified: "模型声称 done 但无 DOM 信号可验证：补一个可验证的完成信号（url/css_*）；不要依赖模型口头 done",
  no_progress: "同一元素有效执行多次而信号从不成立：目标疑似死元素或信号永不成立——换目标/修 done 信号（inspect 实证）",
  space_empty: "声明的命令空间在页面无任何可解析元素：先 inspect --wide --pool 实证页面；环境与声明严重不符时修声明",
  nominated_family_empty: "提名族在该页无候选：inspect 实证该族元素是否存在；修 roles/meta 提名或放宽提名",
  nominated_family_mismatch: "动作族与提名不符：按 inspect 实证改提名，或改用页面真实控件族",
};

/**
 * 显式豁免清单：确实没有可建议下一跳的停因（不进 STOP_NEXT，coverage 组放行）。
 * 每条豁免必须写理由——新增停因时若给不出工程动作，也必须在这里留理由，不许静默漏。
 */
export const EXEMPT_NEXT: Readonly<Record<string, string>> = {
  manual_declined: "人主动放弃人工步——没有工程动作可建议，交给人决策",
  page_not_ready: "页面未稳定是暂态：执行器已带重试；反复出现才需要人查页面本身，无确定性回流动作",
  action_space_exhausted: "候选被禁用到只剩边界：说明页面与声明严重不符，需要人重新评估目标，无自动回流",
};

/**
 * 停手出口（兜底规则，层 3 终止条件）：回流建议必须带"何时停止自愈"——
 * 调用方 Agent 最危险的行为是反复改脚本重跑真实站点。投放面：run 失败输出
 * （runNextHint 附在 next 之后）、桥生成物、文档逐字块。
 */
export const STOP_ESCALATION_TEXT =
  "同一停因按 next 修正后重跑仍出现 2 次以上 → 停手：如实上报 stopCode / reason / 已试过的修正，等待人或上游决策；不要再自行迭代脚本或重试。";

export function nextForStop(code: string): string | null {
  return STOP_NEXT[code] ?? null;
}
