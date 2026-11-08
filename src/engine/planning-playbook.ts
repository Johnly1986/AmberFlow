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
 * 本 playbook 压的就是那 42% 的规划期信息获取成本）。v2.1（六步、走查先行）并入 12 轮
 * 真站实测的结论：骨架正确但覆盖不全，最贵的返工全部发生在「静态看页面 → 直接写正式
 * 应用」的缺口里——②走查先行就是补这个缺口（走查工具与产出物详见
 * docs/APP_SCRIPT_AUTHORING.md「走查先行」节）。叶子模块：零 import。
 */

/** 六步法 v2.1 全文（文档逐字嵌入 + apps new 骨架注释逐字插入，prompt-hit 校验）。 */
export const PLAN_PLAYBOOK_TEXT = `高效规划六步法 v2.1（走查先行——先用引擎把流程按真实步序走通，再写正式应用）：
① inspect 先看：amber inspect --url <页> --json 拿验证过的 hint_candidates——有候选照抄，别自创选择器；同时核对目标 op 在能力面内（amber schema ctx --topic commands）与词面真的在池里（probe/DOM 命中 ≠ hint 可命中）；
② 全流程走查：按真实步序用引擎走通一遍，五样产出物全带出来——能力墙清单（哪步走不通、卡在什么停因）/ 产品事实清单（真实文案、控件、URL 规律——done 与 hint 只能从这里来）/ 提槽清单（哪些值随任务变化、进 meta.slots）/ done 素材（每步动作前后页面各长什么样）/ 绕行决策（走不通的步骤就地找等价路径：换入口页、换来源、换控件族；反爬风控不绕，早停）；
   走查工具三选一：探针链（每步一个 1 步微型应用：arrive+read 验证页面可达 / 登录与验证可处理 / 无风控拦截 / 数据在 DOM——探针 30 秒判死刑，好过全流程应用跑 5 轮）或 plan 面草稿（plan new → plan add --signal … → plan check --probe 只读预检 → plan run 真执行）或 walk 模式（amber run <id> --walk 一个临时应用单会话按真实步序 act→read 串完整流程：步声明的 url 与当前页同页就不重导航、SPA 状态跨步保持，跨页显式 url 仍导航——适合复现「只在演进状态出现」的问题）；
③ 规划应用：提槽 + done 双向清单——done 四形态：正向锚（url_* / css_*）、否定配 exists（裸 not 在空池/重渲染瞬间空洞成立）、多动作后判（两连击的第一击是中间态，不算完成）、状态前进自检（信号跟着页面真前进，不是恒真）；
   值只认 slot：fill/select/drag/upload/clickAt 的值来自任务输入或数据源（缺值如实 needs_value，不猜）；采样与分块：虚拟列表按视口采样（池里只有已渲染的行，滚动/翻页分块取全）、长流程分块成多个短应用、多源双腿（meta.sources 数据腿 + 浏览器腿互核）；
   候选窗口有界：每步只取 40（宽扫 120）个候选并按当前视口分桶（chrome/viewport 优先，内容优先级见 amber schema ctx），窗口外不等于页面上没有——要穷举列表用 ctx.scrollList/ctx.expand 分块取证（各计 1 flow step，expand 内部点击不占预算；范围控件用 ctx.setRange），引擎不自动滚动；hint 用完整 label（≤200）匹配、aria-label 是 label 别名；要回退 A2 前的主内容优先排序在 meta.policy 写 candidate_priority: "main-first"（缺省 bucketed）；扫描面（B2）含 div[role=menuitem/menuitemradio/menuitemcheckbox/option/tab]（click 族）——弹层菜单项/下拉选项/页签可直接 act；这是全局行为变更：候选构成与排序可能变化、同名候选增多可能引入新歧义（如 tab 与按钮同 label），hint 按 label 匹配不受影响；
④ 落地应用：单段/单城 + slots，1 步 flow；早停守卫（凭据/验证不可得，或命中反爬风控 → ctx.fail("blocked:…")）+ meta.policy 声明 done_timeout_ms，不盲等；amber apps check <id> --slot k=v（不启浏览器）验证各分支调用序列——stderr 的两条信号 lint（裸 not / any 含 not(exists)）当场改掉再进 ⑤；
⑤ 真跑留证：amber run <id> --trace；失败先看 trace 的 stopCode/reason——reason 自带池快照判别（「目标不在页面」还是「候选在而闸门拒/闭集约束」）与决策源降级原因；动作步再看 executed/changed 与 skipped_actions/done_preheld——done=true 但零执行时先看跳过原因，别把「信号本来就成立」当成动作推进；被杀有 run-killed.json 部分证据；
⑥ 失败取证判别：最小取证探针先区分引擎缺陷 / 产品事实 / 任务口径再动手——A/B（单变量重跑）、对照（--provider 换决策源或 rules-only 消融）、双腿取数（数据腿核产品事实）；判别不了就上报，别靠反复重跑收敛。`;

/** 压缩版（桥 `_app_create` 工具描述用；生成物逐字分发，工具描述不能太长）。 */
export const PLAN_PLAYBOOK_SHORT = `高效规划六步法 v2.1（走查先行）：① inspect 先看（验证过的 hint_candidates 照抄 + 核对 op 能力面与词面在池）→ ② 全流程走查（探针链或 plan check --probe 按真实步序走通，或 walk 模式 --walk 单会话串真实步序：同页不重导航、跨页仍导航，带出能力墙/产品事实/提槽/done 素材/绕行决策五样）→ ③ 规划应用（slots + done 正向锚/否定配 exists/多动作后判/状态前进自检 + 分块采样）→ ④ apps check <id> --slot k=v 离线分支校验 + 信号 lint（裸 not / any 含 not(exists)）→ ⑤ run --trace 真跑，失败看 stopCode/reason（reason 自带池快照判别）→ ⑥ 失败取证判别（引擎缺陷/产品事实/任务口径；A/B、对照、双腿取数）。`;

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
    "走查先行（六步法②）：1 步探针（arrive + read）验证可达/登录与验证可处理/无风控拦截/数据在 DOM，按真实步序走通再写正式应用",
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
  max_steps: "预算用尽：先看 trace 各步的 stopCode/reason 找第一个失败；多数是目标不可分辨或页面未变——按六步法② 用单步探针把该步走通",
  budget_exceeded: "ctx.step 预算用满（status=partial、verified=false）：调高 --max-steps，或按六步法② 走查收窄流程（分块/找等价路径）",
  arrive_signal_not_held: "导航完成但 done 信号未成立：确认「动作前不成立、动作后成立」；重 JS SPA 先 inspect --wide --pool 或运行时取证",
  done_not_held: "命令闭集已走完但 done 未成立：检查 done 信号是否真的会在动作后成立",
  low_confidence: "决策层低置信：看 trace 的 decisions 行与候选 label；有稳定句柄（id / data-test / 唯一 label）就写 act hint 收窄（六形状闭集见 docs/APP_SCRIPT_AUTHORING.md）",
  decision_service_choice_limit: "候选窗口超过决策服务上限（MAX_CHOICES=200，服务侧 255）：不要放大窗口——用更窄的 act hint 收窄候选，或接受分桶优先级（chrome/viewport 先入池）",
  no_model_runtime: "rules-only 模式需要规则命中：加 target_hint，或配置决策源（docs/DECISION_SERVICE_CONFIG.md）",
  config_error: "停因 reason 自带具体声明错误；改 meta/声明后先 amber apps check <id>（离线）再重跑",
  unreachable: "站点此刻不可达（DNS/连接/导航超时）：先 curl/fetch 验证站点可达——可达则放宽 --timeout（秒，覆盖导航 goto 缺省 30s）或稍后重试；不是声明错误，改 meta 无效",
  host_not_allowed: "目标主机加进 meta.hosts，或改用 meta.site.pages + ctx.openPage；amber apps check 离线可验",
  navigation_forbidden: "meta.policy.navigation:\"entry-only\" 拦下入口外的直接 URL 跳转：改经页面元素导航（ctx.step 点链接/按钮），确需直达就移除该 policy；amber apps check 离线可验",
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
  done_preheld: "done 在动作前已成立（policy.done_preheld=\"fail\" 才停）：把 done 换成动作后才出现的证据（弹出菜单项/跳转 URL/面板内新元素）；确需先动作再判，用步级 forceAct:true 或把 policy.done_preheld 改回 warn",
  false_done: "done 成立但只读复核 guard 命中假绿特征（policy.done_guard=\"fail\" 才停）：登录墙特征/跨出 hosts 信封/否定式 done 零前进——给 done 配正向锚（exists/holds/url），如 all_of(not(...), 正向锚)，必要时配 ctx.judge.loginWall()；确属误报就把 policy.done_guard 改回 warn",
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
