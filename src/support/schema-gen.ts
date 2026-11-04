/**
 * schema-gen —— 引擎语义契约的**唯一数据源**（自描述运行时 · P0-A）。
 *
 * 背景：正式发布可能不带源码（打包产物 / 仅桥工具）。Agent 的语义知识必须作为
 * **数据**随包存在，而不是藏在 .ts 里等人读。本模块从引擎真源取表（不复制表本身），
 * 加上带出处注记的语义事实，渲染出：
 *   ① `amber schema ctx` 的 JSON 契约（commands/schema.ts 消费）；
 *   ② 骨架语义速查文案（renderCheatSheet；M2 与骨架/桥描述多面分发）。
 *
 * 原则：
 *   - 表从真源 import：SIGNAL_OPS（signal-ops.ts 零 import 叶子）、COMMAND_OPS（actions.ts）、
 *     nextForStop（planning-playbook.ts 零 import 叶子）——引擎改表，契约自动跟；
 *   - 语义注记是"源码里查得到、文档里没写死"的行为事实，逐条标出处文件；
 *   - 输出确定性（无时间戳）：`--check` 与快照逐字节比对防漂移。
 */

import { SIGNAL_OPS } from "../engine/signal-ops.ts";
import { COMMAND_OPS } from "../engine/actions.ts";
import { nextForStop, EXEMPT_NEXT, STOP_ESCALATION_TEXT } from "../engine/planning-playbook.ts";
import { OVERVIEW_TEXT, WHEN_TO_USE } from "./help-map.ts";

/** 可查询的节名（`--topic`）。 */
export const SCHEMA_TOPICS = [
  "overview", "facts", "signals", "hints", "commands", "budget", "navigation", "flow_control", "dry", "data_out", "stopcodes",
] as const;
export type SchemaTopic = (typeof SCHEMA_TOPICS)[number];

/** 语义事实清单：无源码世界里 Agent 必须能从本契约回答的每一题（逐条验收）。 */
const CTX_FACTS: ReadonlyArray<{ id: string; statement: string; truth: string }> = [
  { id: "F01", statement: "fill/select/drag 的值只认 slot 绑定：ctx.command(op, sel, {from:\"slot\", key}) 且 key 必须在 meta.slots 声明；绑定缺值 = 结构化 needs_value，值绝不来自模型或猜测", truth: "executor.ts（红线②：never guessed）；apps check 离线可拦截" },
  { id: "F02", statement: "judge.url(s) = URL 子串包含（urlOf(page).includes(s)），不是全等", truth: "signals.ts url_contains" },
  { id: "F03", statement: "judge.exists(sel) 跨主 frame 与同源子 frame（locatorAnyFrame），任意 CSS 可用", truth: "signals.ts css_exists" },
  { id: "F04", statement: "judge.text(sel,s) = 首匹配 innerText 包含 s；精确全等在带徽标/编辑链接的标题上永不成立，优先 contains", truth: "signals.ts css_text_contains" },
  { id: "F05", statement: "act hint 是六形状语法闭集（#id / tag[attr~substr] / tag~token / tag[attr=value] / 角色词 / 裸词）；属性白名单仅 test→data-test、type→input_type、href、name、id、role、near——其中 aria-label 是 label 的别名（DOM 的 aria-label 提取期已并进 label，a[aria-label~x] 按 label 匹配、可正常命中）；class/title/placeholder 等不在白名单的属性永不命中", truth: "hint.ts parseHint + rules.ts poolAttr（aria-label→label 别名，rules.ts A2）+ grammar-prompt.ts（prompt-hit 校验）" },
  { id: "F06", statement: "裸词 hint 四档匹配（整 label 全等 → 词全等 → 前缀 → 包含），只取最强非空档；档内真歧义返回 null 交给决策层", truth: "rules.ts hintMatchImpl bare-token ladder" },
  { id: "F07", statement: "ctx.step 失败是【返回】{ok:false, stopCode, reason}，不抛异常不中断 flow；只有 ctx.fail(code, reason) 抛 StopError 终止运行", truth: "ctx.ts / app-runner.ts" },
  { id: "F08", statement: "when 守卫不成立 = 该步不执行，返回 ok:false + stopCode:precondition_skipped，trace 记 skipped——不是失败，但同样消耗 1 步执行预算", truth: "executor.ts / APP_SCRIPT_AUTHORING.md §4" },
  { id: "F09", statement: "预算三层：① flow 调用预算（缺省 100，--max-steps 覆盖；step/arrive/run/人工步各计 1）② 子目标动作预算（缺省 8，当前不可配）③ 信号等待窗口（done_timeout_ms 缺省 2000，步级 timeoutMs 覆盖）", truth: "executor.ts maxSteps=8 + ctx.ts budget" },
  { id: "F10", statement: "只读调用免费不占预算：read.text/value/count/attr、extract、holds、waitFor、log、url", truth: "app-runner.ts 计费口径" },
  { id: "F11", statement: "dry 模拟面：step/arrive/run/manual 恒 ok:true 且 when 不评估；read.* 返 null/0；url() 是最近声明值；预算照计——数据驱动的分支/断言必须用 ctx.runtime.runId===(dry) 守卫", truth: "ctx-dry.ts createDryCtx（06-B 实证全表）" },
  { id: "F12", statement: "导航：open/openPage 只做 goto(domcontentloaded) 不等信号；arrive(url,{done}) = 导航 + 轮询等落地证据——「导航后还要等页面状态」一律用 arrive", truth: "ctx.ts / APP_SCRIPT_AUTHORING.md §4（04-C 实测）" },
  { id: "F13", statement: "列表/范围三原语：ctx.scrollList/ctx.expand/ctx.setRange 各计 1 个 flow step；expand 的内部点击不占预算（maxClicks 缺省 20、timeoutMs 缺省 60000 兜底，行数连续 stableRounds 轮不增长即稳定）", truth: "ctx.ts 三原语实现 + createDryCtx 桩（A3）" },
  { id: "F14", statement: "三原语失败是结构化结果不是异常：scrollList 找不到滚动容器=not_scrollable、expand 到顶未稳定=expand_not_stable（带完整指标）、setRange 三策略（fill→keyboard→pointer）全失败=slider_not_settable（含已试策略/bbox/当前值）——绝不假装成功", truth: "range.ts + ctx.ts（A3 §4）" },
  { id: "F15", statement: "脚本层读槽位值用 ctx.slots（冻结 Record）：ctx.slots[\"键\"]，键须在 meta.slots 声明；ctx.source 是数据腿注册表，不是读槽位的口——city/list 等任务参数要么走 ctx.slots，要么作为脚本常量", truth: "ctx.ts（slots: Object.freeze），实测自真实运行" },
  { id: "F16", statement: "pre-held done 陷阱：done 引用了动作前已存在的元素 → 完成判定瞬间成立、引擎跳过实际动作（trace 记 done_preheld/skipped_actions，executed=false），步骤「零执行通过」、后续步骤连锁失败——done 必须锚定动作后才出现的证据（弹出菜单项、跳转后 URL、面板内新元素）", truth: "executor.ts done 判定 + APP_SCRIPT_AUTHORING §5（实测自真实运行）" },
  { id: "F17", statement: "状态层（S1）：每个 ctx.step 在 step_traces[i].state 落 StepStateRecord——before/after 指纹（epoch 每次抽池/观察 +1；navEpoch 本次 run 初始 goto 完成 +1；url；readyState=document.readyState；struct=可动元素计数+角色/标签分布 hash；content 仅诊断）、actions{attempted,executed,changed}、flags（done_preheld / no_state_progress）与可选 effect；ctx.runtime.epoch 是执行器游标的只读投影（dry=0）。flags 只是证据：done 语言未变，done_preheld 缺省 warn 不拦（policy.done_preheld=\"fail\" 才在动作前结构化停止）。done_preheld 只覆盖**命令步**（声明了 act 命令闭集）的动作前预评估；决策步不付这次评估成本，不会标记。r8 式串扰签名（done 成立但动作零执行且页面无前进）由 done_preheld + no_state_progress 覆盖", truth: "executor.ts StateFingerprint/StepStateRecord + app-runner.ts step_traces 投影 + ctx.ts runtime" },
  { id: "F18", statement: "effect 读回（S1）：fill 动作后读回组件值并与写入值比对，结果进 step_traces[i].state.effect{kind,before,after,applied}；不可读组件自动降级跳过（不假装成功）。ctx.setRange 在 policy.effect_readback.set_range !== false 时结果附 applied / accurate / target（accurate = |achieved-target| <= tolerance）；两项开关缺省都开，关掉只少字段、不改变动作", truth: "executor.ts _executeElement + range.ts applyRange + app-pack.ts PackPolicy.effect_readback" },
  { id: "F19", statement: "settle 稳定门（S2）：每次抽池前（决策/act 解析、宽扫、收尾观察）若页面最近有 DOM 突变（now - 最近突变 < quiet_ms = “脏”）先等到静默；已静默立即返回（0 等待），超时返回 {timedOut:true} 不抛错、不阻断。等待毫秒数落 step_traces[i].state.settleMs（策略关闭时省略；0 = 跑过但无需等待）。meta.policy.settle 缺省 {quiet_ms:400, timeout_ms:5000}（默认开启），也可写 \"off\"；未知子键/越界值加载期拒绝。MutationObserver 只作传感器（不中断执行循环），导航后重装；安装时刻视为“刚脏”，所以每次导航后最多付一次 quiet_ms，静态页首个观察后零等待", truth: "src/engine/settle.ts + executor.ts _settleBeforeExtract + app-pack.ts PackPolicy.settle" },
  { id: "F20", statement: "existsText / 可见性（S3）：judge.existsText(sel,text) = { css_exists_text: [selector, text] }——存在任一匹配 selector 且（可见）文本含 text 的元素（live = Playwright locator(sel,{hasText})，跨主 frame 与同源子 frame；大小写不敏感子串、含后代文本）。judge.exists(sel,{visible:true}) = { css_visible_exists: selector }——首匹配 locator.isVisible()。池/离线近似：css_exists_text 用匹配元素的合成 label 包含 text（近似，不是 innerText）；css_visible_exists 在池评估恒返回 null（可见性是页面事实，诱导期按“需真实验证”处理）", truth: "signals.ts css_exists_text/css_visible_exists + extraction.ts locatorAnyFrame(hasText) + kit.ts judge" },
  { id: "F21", statement: "ctx.collect（S3）：ctx.collect({row, fields?, until?, dedupe?, maxRounds?}) 反复（滚动行容器→抽行→去重）直到在容器到底/滚不动之后连续 stableRounds 轮（缺省 2）无新增 / 达 maxRows（缺省 500）/ 内部轮数 maxRounds（缺省 30）用完；整体计 1 个 flow step（内部滚动/等待不占预算）。返回 {rows, coverage:{rounds,rowsSeen,addedLastRound}, stopReason}，stopReason ∈ stable | maxRows | budget | not_scrollable（dry 桩 = dry）——诚实口径，不假装穷尽。行容器 = 行元素的最近可滚动祖先（找不到/不可滚动 = not_scrollable，结果只覆盖当前可见部分）；fields 与 extract inline 同语法，缺省 {text:\".\"}", truth: "ctx.ts collect + ctx-dry.ts 桩 + ctx-replay.ts 回放 + trace.ts collect 事件" },
  { id: "F22", statement: "执行韧性（S4，两项都是步级 opt-in，缺省 false = 行为不变）：① staleRetry:true —— 动作失败且疑似 stale 时重抽池→用同一声明目标（命令 target / act hint）重新解析→重试动作，同一步最多 2 次、不额外计入子目标动作预算；判据只有三类：stale_ref（_locatorFor 盖章句柄与属性回退全落空）、action_failed（Playwright 动作抛错）、not-actionable-or-covered 且 actionability.requery===\"detached\"（节点在探针后被卸载）；action-timeout / 有覆盖者且 requery=\"present\" 不重试；纯模型挑元素的决策步没有可复现的声明目标，不重试。每次重试进 trace 行的 stale_retry:[{attempt,reason,ref}]，最终失败仍按既有 stopCode（stale_ref / action_failed / not-actionable-or-covered 等）诚实报告。② force:true —— 动作走 Playwright force 语义（click/fill/selectOption/hover 的 {force:true}）：跳过 actionability 检查（可见/稳定/可接收事件/启用），仍要求元素可定位；trace 行记 forced:true。风险：鼠标坐标上的顶层元素可能不是目标本身（可能点到被遮挡目标），只用于作者已确认的瞬态弹层/动画控件；风险确认（risky/confirmFn）闸门不受 force 影响。dry 面只记录声明（forced:true / stale_retry:true），不改变模拟", truth: "executor.ts RunOptions.force/staleRetry + _clickOnly/_executeElement force + stale 重解析重试 + ctx.ts StepRequest/ctx-dry.ts" },
  { id: "F23", statement: "hover 命令（S4）：ctx.command(\"hover\", sel) 只把指针移到目标上（locator.hover()）——用于 :hover 展开的菜单/图层面板；不点击、不导航、不触发预填。它是命令闭集的第 8 个 op（click|check|fill|select|scroll|drag|hover|skip），能力面对池内可交互元素恒真（池只收可交互元素），且接受步级 force。hover 是**指针状态**：快照没变不判 inert（与 scroll/drag 同口径），完成仍只由 done 信号裁决", truth: "actions.ts COMMAND_OPS + extraction.ts HOVER_ADAPTER/actionCapabilities + executor.ts _executeElement(hover) + ctx.ts validateCommands" },
];

/** 信号算子语义注记（表从 SIGNAL_OPS 真源取；语义逐条标出处）。 */
const SIGNAL_SEMANTICS: Readonly<Record<string, string>> = {
  url_contains: "URL 含子串（includes），非全等——写路径/参数片段即可",
  css_exists: "任意 CSS、跨主 frame 与同源子 frame（locatorAnyFrame）；存在即真",
  css_exists_text: "[selector, text] 存在任一匹配 selector 且文本含 text 的元素（live=Playwright hasText，跨主/同源子 frame，大小写不敏感子串；池近似=匹配元素的合成 label 包含 text）",
  css_visible_exists: "[selector] 首匹配元素存在且可见（locator.isVisible()）；池/离线面不可判定（null）",
  css_text_contains: "[selector, text] 首匹配 innerText 包含 text；带徽标标题用这个，别用 equals",
  css_text_equals: "[selector, text] 首匹配 innerText.trim() 全等",
  css_value_equals: "[selector, value] 首匹配 inputValue 全等",
  all_of: "全部成立才算成立（每支仍是 DOM 事实，组合不会更宽）",
  any_of: "任一成立即成立",
  not: "取反（如「spinner 消失」）",
  manual: "人工自证：自动执行环恒 false，由人工步处理器显式问人",
};

/** hint 语法闭集描述（与 grammar-prompt.ts 同一口径；白名单是池字段模型，不是 CSS）。 */
const HINT_GRAMMAR = {
  shapes: ["#id", "tag[attr~substr]", "tag~token", "tag[attr=value]", "button|link|input|textarea|select", "裸词（按 label 匹配）"],
  attr_whitelist: { test: "data_test", type: "input_type", "aria-label": "label（别名：DOM 的 aria-label 提取期并进 label）", href: "href", name: "name", id: "id", role: "role", near: "near" },
  attr_never_matches: ["class", "title", "placeholder（及一切不在白名单的属性）"],
  note: "act hint 走「语法闭集 + 元素池投影」；judge.* 的 selector 走 DOM 查询面（任意 CSS）——两个观察面，别互相推断",
  bare_token_tiers: ["整 label 全等", "label/data-test 词全等", "完整 label 的词边界/前缀（A2；大小写不敏感）", "词前缀", "词包含"],
  attr_substr_tiers: ["属性值全等", "末路径段全等", "子串"],
};

/** 命令闭集与值绑定（COMMAND_OPS 从 actions.ts 真源取）。 */
const COMMAND_FACTS = {
  ops: [...COMMAND_OPS],
  value_ops: ["fill", "select", "drag"],
  value_binding: { from: "slot", key_must_be_declared_in: "meta.slots", missing: "needs_value（结构化停，绝不猜值）" },
  submit_inputs: "input[type=submit|button] 是点击目标，永远不填值",
  after_commands: "命令闭集走完后引擎评估一次 done 信号；全部命令解决而 done 不成立 = done_not_held",
  scroll: "默认把目标滚入视口；带 to（{to:\"bottom\"|\"top\"|\"page\"}，ctx.command(\"scroll\", sel, {to})）= 把容器滚到该方向（A3）；drag 的 value 是落点 selector，仅 [draggable=true]/slider 族声明了能力",
  hover: "S4：只把指针移到目标上（locator.hover()）——用于 :hover 展开的菜单/图层面板；不点击、不导航、不触发预填；池内可交互元素恒有能力，可配步级 force。hover 是按指针状态，快照没变不判 inert（完成仍只认 done）",
  step_resilience: "步级 opt-in（缺省 false）：force=true 走 Playwright force（click/fill/selectOption/hover 的 {force:true}，跳过 actionability 仍要求可定位，trace 记 forced）；staleRetry=true 在 stale_ref / action_failed / not-actionable-or-covered 且 requery=\"detached\" 时重抽池→重解析同一声明目标→重试 ≤2 次（trace 记 stale_retry:[{attempt,reason,ref}]），action-timeout 与「有覆盖者且节点仍在」不重试",
  /** extract 双形式（骨架/契约都可发现；inline 不需要 meta 声明）。 */
  extract_forms: {
    named: "ctx.extract(\"name\")：行选择器/字段选择器声明在 meta.site.listExtract[name]",
    inline: "ctx.extract({ rows, fields, maxItems? })：不需要 meta 声明，直接在脚本里给选择器——例：ctx.extract({ rows: \"li.item\", fields: { title: \".title\", price: \".price\" } })",
    fields_dot: "字段值 \".\" = 行自身文本；超过 maxItems（缺省 500）在 trace 里标 truncated",
  },
};

/** 预算（三层结构，08-A6 实测成文）。 */
const BUDGET = {
  /** 一图流（S0 可发现性）：四行回答“什么免费、什么计 1、什么不单计”。 */
  summary: [
    "只读免费（不占预算）：read.text/value/count/attr、extract、holds、waitFor、log、url",
    "各计 1 个 flow step：ctx.step / ctx.arrive / ctx.run / 批准执行的人工步 / ctx.scrollList / ctx.expand / ctx.setRange / ctx.collect",
    "step 内的 command 闭集不单独计 flow 步：一个 step 的动作循环上限 8（子目标动作预算）",
    "flow 预算用满 → budget_exceeded（status=partial、verified=false、exit 0）",
  ],
  flow_call: { default: 100, cli_flag: "--max-steps", counts: ["ctx.step", "ctx.arrive", "ctx.run", "批准执行的人工步", "ctx.scrollList", "ctx.expand", "ctx.setRange", "ctx.collect"], note: "when 跳过的步同样计 1；用满 → budget_exceeded（status=partial、verified=false）" },
  subgoal_actions: { default: 8, configurable: false, note: "执行器动作循环上限；reason 里的 \"on step N\" 是本层动作号，与流步号两口径" },
  signal_wait: { done_timeout_ms_default: 2000, step_level_override: "timeoutMs", note: "约束动作后等 done 的窗口，不约束整步挂钟（模型咨询/导航渲染不在其内）" },
  free_calls: ["read.text/value/count/attr", "extract", "holds", "waitFor", "log", "url"],
  list_range_primitives: {
    each_counts_as: 1,
    calls: ["ctx.scrollList", "ctx.expand", "ctx.setRange", "ctx.collect"],
    note: "每个原语整体计 1 flow step（受 --max-steps 预算约束）；expand 内部点击 / collect 内部滚动与轮间等待**不占**预算，由 maxClicks/timeoutMs/maxRounds 兜底；collect 的 stopReason 诚实（stable|maxRows|budget|not_scrollable）",
  },
};

/** 导航语义（04-C 实测）。 */
const NAVIGATION = {
  open_openPage: "只 goto(domcontentloaded)，不等 done/信号/settle",
  arrive: "导航 + 轮询等 done 信号；「导航后要等页面状态」一律用它",
  dynamic_urls: "运行期才知道的 URL 可 new URL(href, ctx.url()) 绝对化（正规通道，不是硬编码豁免）",
  hosts_envelope: "导航信封在起点与落地都强制；子 frame / popup 的 origin 不在 meta.hosts = frame_not_allowed / popup_not_allowed",
};

/** flow 控制语义（作者最容易赌错的三条）。 */
const FLOW_CONTROL = {
  step_failure: "返回 {ok:false, stopCode, reason}，不抛异常——不写 ctx.fail 流程也能继续（兜底/分支的合法用法）",
  fail: "ctx.fail(code, reason) 抛结构化 StopError 终止运行",
  when_guard: "动作前判定；不成立 = 跳过（precondition_skipped、计 1 预算、trace 记 skipped）",
  done_rule: "能用的 done 必须「动作前不成立、动作后成立」；动作前已成立的信号对验证零贡献",
  list_range_primitives: {
    scrollList: "滚目标自身或最近可滚动祖先（纯 DOM scrollTop，不做滚轮模拟、不自动滚页面）；找不到容器=not_scrollable",
    expand: "反复点 load-more/展开控件直到行数连续 stableRounds 轮不增长；到顶未稳定=expand_not_stable（仍返回 clicks/before/after/coverage）",
    setRange: "三策略 fill→keyboard→pointer（0×0 手柄用最近有尺寸祖先 bbox）；全失败=slider_not_settable，绝不返回假 achieved；读回给出 applied/accurate/target",
    collect: "反复（滚动行容器→抽行→去重）直到连续 stableRounds 轮无新增/达 maxRows/轮数用完；整体计 1 step；stopReason=stable|maxRows|budget|not_scrollable（诚实口径，不假装穷尽）",
    billing: "四个原语各计 1 flow step；expand 内部点击、collect 内部滚动与轮间等待不占预算（maxClicks/timeoutMs/maxRounds 兜底）",
  },
  /** S1：状态层是**证据**，不是新的完成语言。 */
  state_evidence: "ctx.step 的 step_traces[i].state 记录 before/after 指纹、前进性 flags（done_preheld / no_state_progress）与 settleMs（S2 稳定门等待；策略关闭时省略）；flags 只标注、不改 done 语言：done_preheld 缺省 warn 不拦，policy 显式 fail 才在动作前停（stop_code=done_preheld），且只覆盖命令步（决策步不做动作前预评估）。ctx.runtime.epoch 是只读投影",
};

/**
 * 采集数据出口（data_out）：「extract 到的数据怎么落盘」的契约——采集类任务的
 * 刚需，此前三层提示均未回答（实测两轮独立靠猜）。ctx 面板不提供写文件原语，
 * 但 app.mjs 本身是 Node ESM 脚本，可直接 import node:fs 写产物。
 */
const DATA_OUT = {
  extraction: "ctx.extract({rows, fields}) 返回行对象数组；字段值 \".\" = 行自身文本；dry 期返回 []（断言须守卫 ctx.runtime.runId===\"(dry)\"）",
  persistence: "app.mjs 是 Node ESM 脚本：可直接 import { writeFileSync } from \"node:fs\" 把 extract 结果写成 JSON——引擎不提供写文件原语，也不拦进程内 IO",
  recommended_path: "$AMBERFLOW_HOME/apps/<id>/outputs/（应用目录旁，与应用同生命周期）；跨平台路径用 import.meta.dirname（Node ≥20.11）拼接，不要用 new URL().pathname（Windows 会带 /C:/ 前缀）",
  run_artifacts: "每次运行另落三件套到临时目录（stdout 尾行打印路径）：<id>-result.json（含 script.stop_code/stop_reason）/<id>-report.md/<id>-report.html",
  masking: "meta.secretSlots 声明的槽位在 result/report/stdout 一律掩码 ***——不要把敏感值写进自定义产物文件",
};

/** dry 模拟面（createDryCtx 实证全表，06-B）。 */
const DRY = {
  step_arrive_run_manual: "恒返回 ok:true，when 不评估（precondition_skipped 分支结构性不可预演）",
  read_extract: "extract 返 []、read.attr 返 null、read.count 返 0、waitFor 立即 true",
  url: "url() 是最近声明值",
  budget: "步预算照常计数",
  list_range_primitives: "三原语确定性桩：expand {ok:true,clicks:0,before:0,after:0,grew:false,stable:true,coverage:{rows:0}}；scrollList {ok:true}；setRange {ok:true,applied:true,accurate:true}（effect_readback.set_range=false 时后两项不出现）——但参数校验真做（非法 count/to/value 在 dry 期红）",
  collect: "collect 桩：{rows:[], coverage:{rounds:0,rowsSeen:0,addedLastRound:0}, stopReason:\"dry\"}；参数校验真做（row/fields/until/maxRounds 非法在 dry 期红）",
  validation_errors: "S3 吞错留痕：ctx-dry 的 validateXxxRequest（scrollList/expand/setRange/collect）抛错前先落 validation_error 事件（含 call/desc/message）——脚本 try/catch 吞掉 config_error，apps check 仍判 FAIL 并输出「脚本吞掉了配置错误：<call> <message>」。源码调用点对账（ctx.expand/scrollList/setRange/collect 出现次数 vs dry 事件数）只在 check 报告警告，不改退出码",
  policy_settle: "settle 是引擎侧行为（无页面面无桩）；但 meta.policy.settle 的加载期校验在 dry 同样生效——非法 settle 在 apps check 就红",
  step_resilience: "S4：步级 force / staleRetry 是**声明面**——dry 的 step event result 只记 forced:true / stale_retry:true（布尔声明标记），不模拟重试、不改变 ok；真实面的重试证据是 executor trace 行上的 stale_retry:[{attempt,reason,ref}] 数组。命令闭集的 op 校验在 dry 与真实 ctx 走同一份 validateCommands（含 hover）",
  state_layer: "state 是合成值：before=after={epoch:0,navEpoch:0,url,readyState:\"complete\",struct:\"dry\"}、actions 全 0、flags []；runtime.epoch=0。形状与真实面同构，但不代表发生过状态推进（dry 没有页面观察）",
  rule: "一切基于观察值的 ctx.fail/分支/断言必须用 ctx.runtime.runId === \"(dry)\" 守卫；check VALID ≠ 每条分支被走过",
};

/** stopCode 一句话表（与 docs/APP_SCRIPT_AUTHORING.md §10 同步；--check 防漂移；
 *  导出供 prompt-hit coverage 组做 STOP_NEXT ⊆ 键集闭环校验）。 */
export const STOPCODE_MEANING: Readonly<Record<string, string>> = {
  config_error: "脚本声明/运行配置错——改声明，不要重试",
  unreachable: "站点不可达（DNS/连接/导航超时）——验证可达后重试/放宽 --timeout，不是声明错",
  host_not_allowed: "目标主机不在 meta.hosts 信封内",
  budget_exceeded: "步预算/截止时间用完",
  invariant_failed: "ctx.done() 时结束态不变量不成立",
  missing_done: "声明了不变量却从未调用 ctx.done()",
  arrive_signal_not_held: "导航完成但 done 信号在超时内未成立",
  precondition_skipped: "when 不成立，本步未执行（计 1 预算，不是失败）",
  page_not_ready: "元素池为空，页面未稳定",
  target_not_found: "目标在页面上不存在；改 hint 或换目标",
  target_ambiguous: "目标命中多个不同候选；收窄 hint",
  action_unsupported: "目标存在但动作 op 不在能力面内",
  done_not_held: "命令闭集已走完但 done 未成立",
  frame_not_allowed: "frame origin 不在 meta.hosts 内",
  popup_not_allowed: "新 tab/popup 不在 meta.hosts 内",
  no_model_runtime: "rules-only 需要规则命中：加 target_hint 或配置决策源",
  low_confidence: "决策层置信低于闸门；有稳定句柄就写 act hint 收窄",
  action_space_exhausted: "动作空间耗尽（候选被禁用到只剩边界）",
  hint_matched_nothing: "target_hint 在池内零命中",
  decision_service_choice_limit: "候选窗口超过决策服务上限（200 安全帽/服务侧 255）：收窄 hint 或依赖分桶优先级，不要放大窗口",
  step_names_no_target: "步骤未点名目标且规则/模型都没有可用候选",
  needs_value: "声明了 slot 绑定但值不存在（绝不猜）",
  manual_signal_not_held: "人工步：人已确认但 DOM 信号复核未过——未完成，不会静默算绿",
  manual_declined: "人工步：人在 TTY 里主动放弃",
  needs_human: "人工步需要人：非 TTY 不假装有人，不拉有头浏览器",
  hint_matched_no_target: "target_hint 在池内零命中（reason 附闭集提示）",
  trace_mismatch: "重放与轨迹版本/输入不一致——重跑，不要重放",
  max_steps: "子目标动作步数预算用完（每次调用缺省 8）：按六步法② 走查收窄流程",
  noul_unverified: "模型声称 done 但无 DOM 信号可验证——补可验证完成信号，完成只认信号",
  no_progress: "同一元素有效执行多次而信号从不成立——目标疑似死元素或信号永不成立",
  done_preheld: "done 在动作前已成立（policy.done_preheld=\"fail\" 才停）：完成不是这一步动作的证据",
  space_empty: "声明的命令空间在页面无任何可解析元素",
  nominated_family_empty: "提名族软先验在该页无候选（S2③）",
  nominated_family_mismatch: "动作族与提名不符且有界修复未解出（S2③）",
};

/**
 * 执行器内部停因边界：这些 StopCode **有意不进** agent 契约表（逐条写理由，
 * prompt-hit coverage 组对 executor StopCode union 做双向闭环）。
 */
export const EXECUTOR_ONLY_STOPCODES: Readonly<Record<string, string>> = {
  dom_goal_signal: "done 信号直接成立的成功出口（无动作即命中/命令解析即命中）——不是失败停因",
  dry_run: "干跑探针出口（--dry-run/预检：只报告 would-do，不执行）",
  dry_run_not_actionable: "干跑判定目标不可执行——结构化拒绝，回流见工具步 refusal 语义",
  manual_needs_human: "执行器级人工步无 confirmFn——应用层已映射为 needs_human（含 TTY/--headful 指引）",
  manual_confirmation: "人工确认（human oracle）通过——成功路径结束码，不是失败停因",
};

/** 停因 → 下一步（从 planning-playbook 真源取，未收录的如实标 null）。 */
function stopcodesSection(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [code, meaning] of Object.entries(STOPCODE_MEANING)) {
    out[code] = { meaning, next: nextForStop(code) };
  }
  return out;
}

/** 概述层（层 1，唯一出处 help-map）：无源码 Agent 的第一眼 + 命令「何时用」速查。 */
function overviewSection(): Record<string, unknown> {
  return {
    overview: OVERVIEW_TEXT,
    when_to_use: WHEN_TO_USE,
    commands_help: "amber help <命令> --json（结构化 when/flow/flags）",
    json_consumption: "机器消费 --json 输出：进程内直读 stdout 或 --out 落盘后读文件；Windows PowerShell 管道/重定向会强转 UTF-16 加 BOM，JSON.parse 会挂",
    escalation: STOP_ESCALATION_TEXT,
  };
}

/** 渲染完整契约（确定性输出：键序固定、无时间戳——--check 依赖这一点）。 */
export function renderSchemaCtx(): Record<string, unknown> {
  return {
    schema: "amberflow.ctx-contract",
    note: "无源码世界的 Agent 语义契约：全部事实标注源码出处；引擎行为以本契约为准（快照经 --check 防漂移）",
    topics: [...SCHEMA_TOPICS],
    overview: overviewSection(),
    facts: CTX_FACTS,
    sections: {
      signals: { ops: SIGNAL_OPS, semantics: SIGNAL_SEMANTICS, done_rule: FLOW_CONTROL.done_rule },
      hints: HINT_GRAMMAR,
      commands: COMMAND_FACTS,
      budget: BUDGET,
      navigation: NAVIGATION,
      flow_control: FLOW_CONTROL,
      dry: DRY,
      data_out: DATA_OUT,
      stopcodes: stopcodesSection(),
      next_exempt: EXEMPT_NEXT,
    },
  };
}

/** 骨架语义速查（M2 多面分发的文案源；由数据渲染，禁止手抄）。 */
export function renderCheatSheet(): string[] {
  const d = renderSchemaCtx();
  void d;
  return [
    "⚠ 语义速查（完整契约：amber schema ctx；违者运行期才红）",
    "- fill/select 值只认 slot：ctx.command(\"fill\", sel, {from:\"slot\",key})，key 须在 meta.slots 声明",
    "- judge.url(s)=URL 含子串；judge.exists 跨 iframe；judge.text(sel,s)=首匹配含 s",
    "- judge.existsText(sel,s)=存在文本含 s 的元素（live hasText；池评估是 label 近似）；judge.exists(sel,{visible:true})=存在且可见（池评估不可判定）",
    "- hint 六形状；属性仅 test/type/href/name/id/role/near（aria-label 是 label 别名）—— class/title/placeholder 永不命中",
    "- ctx.step 失败返回 {ok:false}，只有 ctx.fail 中断；when 跳过同样计 1 步预算",
    "- read/extract/holds/waitFor/log/url 免费；step/arrive/run/manual 与四原语各计 1",
    "- ctx.extract(\"name\") 走 meta.site.listExtract；inline 用 ctx.extract({rows, fields})（无需声明）",
    "- ctx.collect({row,fields,until}) 反复滚动取行（计 1 步）；stopReason=stable|maxRows|budget|not_scrollable，绝不假装穷尽",
    "- settle：抽池前只在页面有突变时等静默（meta.policy.settle 默认开；等待落 state.settleMs）",
    "- 执行韧性（S4，步级 opt-in）：force:true 走 Playwright force（跳过 actionability，仍要求可定位）；staleRetry:true 在 stale_ref/action_failed/节点已卸载时重解析同一目标重试 ≤2 次（trace.stale_retry）；hover 命令只移指针展开 :hover 面板",
    "- step_traces[i].state 记状态指纹/flags/effect；ctx.runtime.epoch 只读；flags 只标注不改 done",
  ];
}
