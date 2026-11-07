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
  { id: "F01", statement: "fill/select/drag/upload/clickAt 的值只认声明绑定：ctx.command(op, sel, {from:\"slot\", key}) 且 key 必须在 meta.slots 声明（upload 另可走 dataset；option 不适用）；绑定缺值 = 结构化 needs_value，值绝不来自模型或猜测", truth: "executor.ts（红线②：never guessed）；apps check 离线可拦截" },
  { id: "F02", statement: "judge.url(s) = URL 子串包含（urlOf(page).includes(s)），不是全等", truth: "signals.ts url_contains" },
  { id: "F03", statement: "judge.exists(sel) 跨主 frame 与可达的子 frame（locatorAnyFrame；同源与跨源均可 locator 定位，跨源页面行为的稳定性以实测为准——R11 B5），任意 CSS 可用", truth: "signals.ts css_exists" },
  { id: "F04", statement: "judge.text(sel,s) = 首匹配 innerText 包含 s；精确全等在带徽标/编辑链接的标题上永不成立，优先 contains", truth: "signals.ts css_text_contains" },
  { id: "F05", statement: "act hint 是六形状语法闭集（#id / tag[attr~substr] / tag~token / tag[attr=value] / 角色词 / 裸词）；属性白名单仅 test→data-test、type→input_type、href、name、id、role、near——其中 aria-label 是 label 的别名（DOM 的 aria-label 提取期已并进 label，a[aria-label~x] 按 label 匹配、可正常命中）；class/title/placeholder 等不在白名单的属性永不命中", truth: "hint.ts parseHint + rules.ts poolAttr（aria-label→label 别名，rules.ts A2）+ grammar-prompt.ts（prompt-hit 校验）" },
  { id: "F06", statement: "裸词 hint 四档匹配（整 label 全等 → 词全等 → 前缀 → 包含），只取最强非空档；档内真歧义返回 null 交给决策层", truth: "rules.ts hintMatchImpl bare-token ladder" },
  { id: "F07", statement: "ctx.step 失败是【返回】{ok:false, stopCode, reason}，不抛异常不中断 flow；只有 ctx.fail(code, reason) 抛 StopError 终止运行", truth: "ctx.ts / app-runner.ts" },
  { id: "F08", statement: "when 守卫不成立 = 该步不执行，返回 ok:false + stopCode:precondition_skipped，trace 记 skipped——不是失败，但同样消耗 1 步执行预算", truth: "executor.ts / APP_SCRIPT_AUTHORING.md §4" },
  { id: "F09", statement: "预算三层：① flow 调用预算（缺省 100，--max-steps 覆盖；step/arrive/run/人工步各计 1）② 子目标动作预算（缺省 8，当前不可配）③ 信号等待窗口（done_timeout_ms 缺省 2000，步级 timeoutMs 覆盖）", truth: "executor.ts maxSteps=8 + ctx.ts budget" },
  { id: "F10", statement: "只读调用免费不占预算：read.text/value/count/attr、extract、holds、waitFor、log、url、tabs", truth: "app-runner.ts 计费口径" },
  { id: "F11", statement: "dry 模拟面：step/arrive/run/manual 恒 ok:true 且 when 不评估；read.* 返 null/0；url() 是最近声明值；预算照计——数据驱动的分支/断言必须用 ctx.runtime.runId===(dry) 守卫", truth: "ctx-dry.ts createDryCtx（06-B 实证全表）" },
  { id: "F12", statement: "导航：open/openPage 只做 goto(domcontentloaded) 不等信号；arrive(url,{done}) = 导航 + 轮询等落地证据——「导航后还要等页面状态」一律用 arrive", truth: "ctx.ts / APP_SCRIPT_AUTHORING.md §4（04-C 实测）" },
  { id: "F13", statement: "列表/范围三原语：ctx.scrollList/ctx.expand/ctx.setRange 各计 1 个 flow step；expand 的内部点击不占预算（maxClicks 缺省 20、timeoutMs 缺省 60000 兜底，行数连续 stableRounds 轮不增长即稳定）", truth: "ctx.ts 三原语实现 + createDryCtx 桩（A3）" },
  { id: "F14", statement: "三原语失败是结构化结果不是异常：scrollList 找不到滚动容器=not_scrollable、expand 到顶未稳定=expand_not_stable（带完整指标）、setRange 三策略（fill→keyboard→pointer）全失败=slider_not_settable（含已试策略/bbox/当前值）——绝不假装成功", truth: "range.ts + ctx.ts（A3 §4）" },
  { id: "F15", statement: "脚本层读槽位值用 ctx.slots（冻结 Record）：ctx.slots[\"键\"]，键须在 meta.slots 声明；ctx.source 是数据腿注册表，不是读槽位的口——city/list 等任务参数要么走 ctx.slots，要么作为脚本常量", truth: "ctx.ts（slots: Object.freeze），实测自真实运行" },
  { id: "F16", statement: "pre-held done 陷阱：done 引用了动作前已存在的元素 → 完成判定瞬间成立、引擎跳过实际动作（trace 记 done_preheld/skipped_actions，executed=false），步骤「零执行通过」、后续步骤连锁失败——done 必须锚定动作后才出现的证据（弹出菜单项、跳转后 URL、面板内新元素）", truth: "executor.ts done 判定 + APP_SCRIPT_AUTHORING §5（实测自真实运行）" },
  { id: "F17", statement: "状态层（S1）：每个 ctx.step 在 step_traces[i].state 落 StepStateRecord——before/after 指纹（epoch 每次抽池/观察 +1；navEpoch 本次 run 初始 goto 完成 +1；url；readyState=document.readyState；struct=可动元素计数+角色/标签分布 hash；content 仅诊断）、actions{attempted,executed,changed}、flags（done_preheld / no_state_progress / pool_empty）与可选 effect；ctx.runtime.epoch 是执行器游标的只读投影（dry=0）。flags 只是证据：done 语言未变，done_preheld 缺省 warn 不拦（policy.done_preheld=\"fail\" 才在动作前结构化停止）。done_preheld 只覆盖**命令步**（声明了 act 命令闭集）的动作前预评估；决策步不付这次评估成本，不会标记。r8 式串扰签名（done 成立但动作零执行且页面无前进）由 done_preheld + no_state_progress 覆盖；pool_empty（U3）= 该步池空但页面已就绪（settle 静默 + readyState=complete），步级 fact 不是 run 级判死", truth: "executor.ts StateFingerprint/StepStateRecord + app-runner.ts step_traces 投影 + ctx.ts runtime" },
  { id: "F18", statement: "effect 读回（S1）：fill 动作后读回组件值并与写入值比对，结果进 step_traces[i].state.effect{kind,before,after,applied}；不可读组件自动降级跳过（不假装成功）。ctx.setRange 在 policy.effect_readback.set_range !== false 时结果附 applied / accurate / target（accurate = |achieved-target| <= tolerance）；两项开关缺省都开，关掉只少字段、不改变动作。敏感槽位（meta.secretSlots）来源的 fill：before/after 恒掩 \"***\"、applied 保留（W8，见 F28）", truth: "executor.ts _executeElement + range.ts applyRange + app-pack.ts PackPolicy.effect_readback" },
  { id: "F19", statement: "settle 稳定门（S2）：每次抽池前（决策/act 解析、宽扫、收尾观察）若页面最近有 DOM 突变（now - 最近突变 < quiet_ms = “脏”）先等到静默；已静默立即返回（0 等待），超时返回 {timedOut:true} 不抛错、不阻断。等待毫秒数落 step_traces[i].state.settleMs（策略关闭时省略；0 = 跑过但无需等待）。meta.policy.settle 缺省 {quiet_ms:400, timeout_ms:5000}（默认开启），也可写 \"off\"；未知子键/越界值加载期拒绝。MutationObserver 只作传感器（不中断执行循环），导航后重装；安装时刻视为“刚脏”，所以每次导航后最多付一次 quiet_ms，静态页首个观察后零等待", truth: "src/engine/settle.ts + executor.ts _settleBeforeExtract + app-pack.ts PackPolicy.settle" },
  { id: "F20", statement: "existsText / 可见性（S3）：judge.existsText(sel,text) = { css_exists_text: [selector, text] }——存在任一匹配 selector 且（可见）文本含 text 的元素（live = Playwright locator(sel,{hasText})，跨主 frame 与可达的子 frame——同源/跨源均可定位；大小写不敏感子串、含后代文本）。judge.exists(sel,{visible:true}) = { css_visible_exists: selector }——首匹配 locator.isVisible()。池/离线近似：css_exists_text 用匹配元素的合成 label 包含 text（近似，不是 innerText）；css_visible_exists 在**未捕获可见性**的旧视图上返回 null（不可判定，诱导期不采纳）；learn 的 StateView 捕获 `visible` 后按首匹配判定（U2a，见 F38）", truth: "signals.ts css_exists_text/css_visible_exists + extraction.ts locatorAnyFrame(hasText) + kit.ts judge" },
  { id: "F21", statement: "ctx.collect（S3）：ctx.collect({row, fields?, until?, dedupe?, maxRounds?}) 反复（滚动行容器→抽行→去重）直到在容器到底/滚不动之后连续 stableRounds 轮（缺省 2）无新增 / 达 maxRows（缺省 500）/ 内部轮数 maxRounds（缺省 30）用完；整体计 1 个 flow step（内部滚动/等待不占预算）。返回 {rows, coverage:{rounds,rowsSeen,addedLastRound}, stopReason}，stopReason ∈ stable | maxRows | budget | not_scrollable（dry 桩 = dry）——诚实口径，不假装穷尽。行容器 = 行元素的最近可滚动祖先（找不到/不可滚动 = not_scrollable，结果只覆盖当前可见部分）；fields 与 extract inline 同语法，缺省 {text:\".\"}", truth: "ctx.ts collect + ctx-dry.ts 桩 + ctx-replay.ts 回放 + trace.ts collect 事件" },
  { id: "F22", statement: "执行韧性（S4，两项都是步级 opt-in，缺省 false = 行为不变）：① staleRetry:true —— 动作失败且疑似 stale 时重抽池→用同一声明目标（命令 target / act hint）重新解析→重试动作，同一步最多 2 次、不额外计入子目标动作预算；判据只有三类：stale_ref（_locatorFor 盖章句柄与属性回退全落空）、action_failed（Playwright 动作抛错）、not-actionable-or-covered 且 actionability.requery===\"detached\"（节点在探针后被卸载）；action-timeout / 有覆盖者且 requery=\"present\" 不重试；纯模型挑元素的决策步没有可复现的声明目标，不重试。每次重试进 trace 行事件 stale_retry:[{attempt,reason,ref}]（dry 面同名键是布尔声明标记），运行结果汇总数组字段是复数的 stale_retries（RunReport/StepResult；两处字段名不同，文案勿混写——R9 记录项 1），最终失败仍按既有 stopCode（stale_ref / action_failed / not-actionable-or-covered 等）诚实报告。② force:true —— 动作走 Playwright force 语义（click/fill/selectOption/hover 的 {force:true}）：跳过 actionability 检查（可见/稳定/可接收事件/启用），仍要求元素可定位；trace 行记 forced:true。风险：鼠标坐标上的顶层元素可能不是目标本身（可能点到被遮挡目标），只用于作者已确认的瞬态弹层/动画控件；风险确认（risky/confirmFn）闸门不受 force 影响。dry 面只记录声明（forced:true / stale_retry:true），不改变模拟", truth: "executor.ts RunOptions.force/staleRetry + _clickOnly/_executeElement force + stale 重解析重试 + ctx.ts StepRequest/ctx-dry.ts" },
  { id: "F23", statement: "hover 命令（S4）：ctx.command(\"hover\", sel) 只把指针移到目标上（locator.hover()）——用于 :hover 展开的菜单/图层面板；不点击、不导航、不触发预填。它是命令闭集的第 8 个 op（U6 之前的闭集：click|check|fill|select|scroll|drag|hover|skip；U6 追加第 9 个 upload，见 F31），能力面对池内可交互元素恒真（池只收可交互元素），且接受步级 force。hover 是**指针状态**：快照没变不判 inert（与 scroll/drag 同口径），完成仍只由 done 信号裁决", truth: "actions.ts COMMAND_OPS + extraction.ts HOVER_ADAPTER/actionCapabilities + executor.ts _executeElement(hover) + ctx.ts validateCommands" },
  { id: "F24", statement: "状态闸门（S5a，默认关）：meta.policy.decision_state.gate=\"stable_only\" 时，每次模型 ask **之前**先检查状态游标——① 页面未静默（settle 传感器脏）就先等到静默（走 policy.settle 参数；超时不抛、不阻塞，照旧问）；② **池指纹**（本次 ask 池的 structDigest：可动元素计数+角色/标签分布 hash，与 S1 的 StateFingerprint.struct 同一算法、零新增页面往返）与该池结构下最近一次真 ask 相同、且规则层仍歧义（走到模型入口就是规则没解出目标）时 **不重复敲门**：题面一字不差（同 goal + 同候选 ref/元素签名集合）直接复用答复；仅结构相同则要求上一次的选择**此刻仍可行动**（在池里且未 forbidden）才复用——答复之后继续走既有 floor/reobserve/escalate 裁决（即既有降级路径）。不能安全复用（上次选择已被禁/已不在池里）或 goal 变了 ⇒ 照常问，引擎不拿过时答复冒充新答复、也不替模型编答案。指标：产物 decisions.{asks_saved, gate_waits}（顶层平铺；asks_saved = 被闸门省掉的 ask 数；gate_waits = settle **实际等待**次数，waitedMs>0 才计，0ms 静默检查不计）；两项都 off 时这四个键全部缺席（默认档产物逐字节不变）。gate 只改「什么时候问」，不改「模型只投票/完成只认信号」，也不改变 dry 面模拟", truth: "executor.ts _gateSettle/_askSignature/_askedPools/pickInner + app-runner.ts summarizeDecisions(decisions 顶层指标) + app-pack.ts PackPolicy.decision_state" },
  { id: "F25", statement: "状态进模型上文（S5b，默认关）：meta.policy.decision_state.context=\"delta\" 时，决策请求带可选**结构化**字段 state_digest（JSON 对象，硬上限 200 字节）——形状 {nav_epoch_delta:number（距上一次 ask 的导航代数差，首次 ask=自 run 起点）, last_effect?:{kind:\"fill\"|\"set_range\", applied:boolean}（只给事实，不带值）, settled:boolean（ask 时刻页面是否已静默）, pool_changed:boolean（候选池是否与上次 ask 不同，首次=true）, flags?:(\"done_preheld\"|\"no_state_progress\")[]（本次 run 到目前为止出现过的 S1 flags）}；只给观测事实、不塞建议，模型仍只在一组 ref 里投票。注入面：SystemOne 的 state 是不透明包 ⇒ state.state_digest 可选键（协议无版本字段，老服务忽略未知键即向后兼容）；provider 用 capabilities.state_digest 自报是否接受，不接受时整段跳过、绝不把 JSON 塞进自然语言（本地 laya-onnx / OpenAI Decisions 属此列）。指标：decisions.{context_sent, context_skipped}（顶层平铺；sent=真带上去的请求数；skipped=策略要求但 provider 不支持而跳过的请求数）；两项都 off 时这四个键缺席。≤200B 由构造端保证：超限按 flags→last_effect 顺序裁字段，绝不截断 JSON", truth: "executor.ts StateDigest/_buildStateDigest/pickInner + decision-provider.ts ChoiceRequest.state_digest/ProviderCapabilities.state_digest + system-one-client.ts buildChoiceBody + decision-service.ts stateDigest" },
  { id: "F26", statement: "运行节奏（B1 节奏统一）：`meta.pace` / `AMBERFLOW_STEP_DELAY_MS` / `AMBERFLOW_ACTION_DELAY_MS` 的语义是**最小步间距（start-to-start ≥ gap）**——相邻两次引擎单元**开始时刻**至少隔 gap 毫秒，上一步耗时长则本步**不补等**（不是无条件 sleep；等待量 = paceRemainder(gap, 上次单元开始时刻, now)）。三脸共用 `src/support/pace.ts` 的同一语义与 env 口径，各自持有 lastUnitStart 时钟，且都是**首个单元之前不等**。应用点：flow = ctx 每个引擎单元（step/arrive/manual/run/scrollList/expand/setRange/collect）之前；声明式 = runApp 循环每步执行前（journey 步为单元）；规划脸（plan run）= 子目标之间 + runSubgoalWithRetries 重试之间（同值同源，单元 = attempt）；online 套件 = 用例间/子目标间/重试间（跟随 env，不显式关闭；套件结果带 pace:{between_steps_ms, source, total_waited_ms} 标注，全 0 省略）。来源优先级 explicit > meta.pace > env > 0（sources 逐字段标注）；**规划脸/online = env-only**（无 pack/meta 可声明，meta.pace 仍是应用脸专属）；动作间间距 between_actions_ms 由执行器在动作之间等待（应用脸经 mw.actionDelayMs，规划脸/online 也经 envPace().between_actions_ms 传入 mw）。可见性：应用结果 pace 字段在任一键非 0 或来源非 default 时出现（默认档逐字节不变）；plan run 输出生效节奏行（非零才打，含来源）。与正确性等待的边界：settle/轮询/退避等正确性等待不并入 pace。行为变更（B1 语义修正，不是回归）：声明了 pace 的既有应用在「上一步耗时 > gap」时等待变少；声明式路径不再有「最后一步之后的补等」。dry 面不模拟等待（pace 是节奏不是断言），apps check 不受影响", truth: "src/support/pace.ts(envPace/resolvePace/paceRemainder/PaceClock/paceBeforeUnit) + ctx.ts paceBeforeStep + app-runner.ts resolvePace 转口/runApp 循环 + planner.ts runPlan/runSubgoalWithRetries + online/runner.ts runSuite pace 标注" },
  { id: "F27", statement: "扫描面扩面（B2）：INTERACTIVE 扫描面追加五个 ARIA 角色 [role='menuitem'] / [role='menuitemradio'] / [role='menuitemcheckbox'] / [role='option'] / [role='tab']——弹层菜单项、下拉选项、页签这类 div 自绘控件从此进元素池（此前 role 面只有 button/combobox/listbox/textbox/searchbox/spinbutton/checkbox/radio/switch/slider 与原生标签；W3 记录项 1：popup.html 的 div[role=menuitem][aria-label] 九宫格 learn 回放 pool=1 失败的根因之一）。五个新 role 全部归 **click 族**（menuitemradio/menuitemcheckbox 的选中语义也是 click 驱动，不放 check/slider 族；elemFamily 默认分支即 click，原生 input 语义不受影响）；命令闭集（click|check|fill|select|scroll|drag|hover|skip）与动作语义不变。这是**全局行为变更**：所有应用的候选池构成可能变化——决策层看到的候选集合与排序可能不同；同名候选增多可能引入新歧义（例如 tab 与按钮同 label）。对 hint 命中无影响（仍按 label 匹配，六形状闭集不变）；MAX_ELEMENTS=40（宽扫 120）与分桶配额不变，新 role 走既有分桶", truth: "extraction.ts INTERACTIVE（B2 扩面注释）+ elemFamily（默认 click 族）+ planning-playbook.ts ③ + docs/APP_SCRIPT_AUTHORING.md §4.5（W3 记录项 1）" },
  { id: "F28", statement: "effect 读回的 secretSlots 掩码（W8，安全级）：fill 的值来自敏感槽位（meta.secretSlots 声明；值绑定 from:slot 且 key ∈ 名单）或读回内容命中敏感值时，state.effect.before/after 恒掩 \"***\"（与顶层 slots 掩码同值、不保留长度）——applied 布尔保留：它是「真的填进去了」的核心证据，不泄漏值本身。掩码在**执行器构造 effect 时**做（源头一次，覆盖 step_traces[i].result.state.effect 与 step_traces[i].state.effect 两条投影，收尾不再处理）。判定链 = app-runner 传 MiddlewareOptions.secretSlotKeys（meta.secretSlots + 名称启发，与顶层 slots 掩码同一份名单）× 当次步合并 slots 袋现读值 ∪ 执行器实例累计已见敏感值（后续步在同一输入上的残留 before 也掩——步级 slots 的真值只在执行器可见，runScriptApp 的 secretValues 名单从不包含它，收尾 scrubSecrets 对此天然失明，这是 R3 实测的泄漏根源）。password/file/hidden 输入形态维持 redactValue 的既有 \"***(N)\" 口径；非敏感槽位/字面值的 before/after 维持明文（读回证据行为不变）。理由：秘密值绝不进产物（AGENTS.md 硬规则）；applied 是动作真发生的核心证据，只掩值、不掩事实", truth: "executor.ts _executeElement（W8 掩码 + _secretValuesSeen 累计）+ MiddlewareOptions.secretSlotKeys + app-runner.ts getMw 传递 + redaction.ts MASKED_SLOT（同值 ***）" },
  { id: "F29", statement: "扫描面三投影（U3）：元素可动作性由 `src/engine/surface.ts` 的类别表给出，但对三个消费面是三个投影——① POOL_SEL（admission=window）= 池/scan 序号/`_locatorFor` 位置回退的**唯一基准**；② ADMIT_SEL（window ∪ resolve）= 只用于按盖章身份寻址的面（hintLookup、windowAudit、A3 `_domFallbackResolve`、inspect 只读计数），**绝不用于位置序号**；③ focusable（[tabindex]）只建表、默认不启用（FOCUSABLE_ENABLED=false，resolve-only）。类目：native-control / native-label / aria-role / aria-widget / native-activation / focusable。native-activation 本波只收 `summary`（audio/video[controls] 缓做）；它进窗口并受类目 cap=6 约束（WINDOW_CAPS，固定不加数字键）——30 条 FAQ 的 summary 不得把页头按钮挤出窗口，被裁元素进 windowAudit 的 out_of_window_total。surface 字段只进 PoolView/inspect/类目计数，**进 provider 请求体前剥离**（模型视图逐字段同 U3 之前）。POOL_SEL 的既有成员与顺序与 U3 之前逐字节一致、新类目只追加在尾部，`INTERACTIVE_ALL = POOL_SEL + \", [data-js-ref]\"` 后缀不变 ⇒ 不含新类目的页面 ref 集合/scan 序号逐字节不变（A/B 可证）。策略键 meta.policy.surface.native_activation ∈ window（缺省）|resolve|off，off 时池构成回到 U3 之前；未知子键加载期拒绝", truth: "src/engine/surface.ts（SURFACE/POOL_SEL/ADMIT_SEL/WINDOW_CAPS）+ extraction.ts（EXTRACT_JS surface/cap、windowAudit surface_counts、poolSniff）+ executor.ts（_domFallbackResolve/A3 用 ADMIT_SEL；pickInner 请求体剥离 surface）+ app-pack.ts PackPolicy.surface" },
  { id: "F30", statement: "就绪四档（U3，唯一出处 §5.3 判档表）：池空不再等于 page_not_ready。判据接回既有观测——每次抽池前的 settle 结论（settled/timedOut，以前只累计 waitedMs）+ readyState + pool_size + waited_ms/budget_ms（budget_ms 是池空闸门的真实上限：每轮 settle 的 timeout 都被钳到剩余预算，总等待 ≤ pool_ready_timeout_ms + 一次抽池）+ 一次只读 sniff（admitted/focusable/aria/frames/body_text，只在池空/失败路径跑）。四档：navigating / not_ready（预算耗尽且 settle 未静默或 readyState≠complete ⇒ 保留 run 级 page_not_ready，reason 点名 settled/settle_timed_out/readyState/budget_ms/waited_ms）/ ready（池非空）/ ready_empty（预算耗尽但 settle 静默且 readyState=complete 且池 0 ⇒ 步级 flags:pool_empty + 一条去重 warning 后**继续**，不再整页判死）。diagnostics.readiness={verdict,evidence} 在 verdict≠ready 时出现（ready_empty 也出现）；policy.pool_gate=\"strict\" 时 ready_empty 改判 not_ready（U3 之前的逐字节行为）。闸门只在 flow 面（ctx.step 开 poolReady）；journey/plan 面 poolReady=false，本键不适用", truth: "executor.ts _poolReadiness/_settleBeforeExtract(deadline)/池空判档 + extraction.ts poolSniff + app-pack.ts PackPolicy.pool_gate" },
  { id: "F31", statement: "文件上传（U6）：命令闭集第 9 个 op `upload`——ctx.command(\"upload\", \"#file\", ctx.value.slot(\"path\")) 把**声明绑定**的路径交给 Playwright locator.setInputFiles（string = 单文件，string[] = 多文件）；值只来自既有绑定来源（slot/dataset；option 不适用），缺失 = 结构化 needs_value，空串/空数组/非字符串 = 结构化 config_error。执行前逐条 fs.existsSync 校验，缺失 = 结构化 config_error（reason 点名 basename，不抛裸栈）；不做环境变量/通配/目录遍历解析。证据 executed_actions 记 {op:\"upload\", how:\"setInputFiles\", files:[basename…]}——只记 basename，绝对路径不进产物；changed 依据调用后 input.files.length >= 期望数如实记（读不到记 false，不假装）。能力面只对 input[type=file] 成立（池的可见性过滤不变，隐藏 file input 支持为后续项），非 file 目标 = action_unsupported。dry/apps check 只校声明形状（值绑定与 fill/select 同一校验器），不做文件存在性检查。上传不新增 risky 语义（不触发危险动作确认面）", truth: "actions.ts COMMAND_OPS/VALUE_OPS + extraction.ts UPLOAD_ADAPTER/actionCapabilities/elemFamily + executor.ts _executeElement(upload)/executed_actions + ctx.ts/ctx-dry.ts validateCommands" },
  { id: "F32", statement: "坐标点击（U7）：命令闭集第 10 个 op `clickAt`——ctx.command(\"clickAt\", \"#cv\", ctx.value.slot(\"coords\")) 在目标元素的**元素相对**坐标上点击（Playwright locator.click({position:{x,y}}) 语义，相对元素 padding box 左上角，单位 CSS 像素），用于 canvas/自绘画布这类“进了池但只能点中心”的元素。坐标值只来自声明绑定（slot/dataset），规范形是字符串 \"x,y\"（非负整数或有限小数，允许空白如 \"50, 25\"）；严格解析，坏格式（非字符串、center、百分比、负偏移、指数、x;y、多余段）一律结构化 config_error 并点名合法格式，不做隐式猜测。能力面只对 click 族元素成立（ActionCapability \"clickAt\" 由 click 族 adapter 声明），非 click 族目标 = action_unsupported。执行前用元素 boundingBox 校验 0 <= x < width、0 <= y < height，越界 = 结构化 config_error（reason 给出实测 width/height 与声明值）；bbox 测不到（detached/零尺寸）= action_failed。force 语义与 click 一致（click 的 {force:true}），风险面沿用 click 关键词/模型风险票，不新增确认语义。证据 executed_actions 记 {op:\"clickAt\", position:{x,y}, changed}（how=\"clicked\"），trace 行同步带 position；changed/inert 沿用 click 的快照 diff 口径。dry/apps check 只校声明形状（值绑定存在且来源合法），不解析坐标、不开浏览器", truth: "actions.ts COMMAND_OPS/VALUE_OPS + click-at.ts parseClickAtValue + extraction.ts ActionCapability \"clickAt\"/CLICK_AT_ADAPTER + executor.ts _executeElement(clickAt)/executed_actions.position + ctx.ts/ctx-dry.ts validateCommands" },
  { id: "F33", statement: "标签页切换（A5）：ctx.tabs() 免费只读——枚举当前 browser context 里未关闭的页面（Playwright page.context().pages()；closed 页跳过），返回 [{index,url,title,active}]，index=0 基于枚举序，active=引擎当前页；不切页、不计 flow step，trace 记 {call:\"tab\", action:\"list\", pages:[…]}。ctx.switchTab(match) 显式切页：match 至少给 index（0-based 整数）| urlContains | titleContains（后两者大小写不敏感子串），多条件 AND；必须恰好 1 个匹配——0 个或 >1 个都是结构化 config_error，reason 列出当前 tabs（index/url/title/active），绝不回退\"随便选一个\"。目标页 URL 在 meta.hosts 信封外 = 结构化 host_not_allowed（与 open/openPage 同一判定）且不切换；tabs() 的只读列表可以包含信封外页面，但切过去会被拒绝。成功后 session.page=目标页、currentUrl 更新、best-effort bringToFront（失败不致命）、有界等 waitForLoadState(\"domcontentloaded\")（≤5s，超时/失败忽略），计 1 个 flow step 且走 pace；trace 记 {call:\"tab\", action:\"switch\", from:{url}, to:{index,url,title}, pages:n}。新标签页不会自动跟随：window.open/target=_blank 动作后引擎仍停在原 page，必须显式 tabs/switchTab（自动跟随未实现，列为后续 policy 提案）。dry：不访问浏览器，tabs 返回合成 [{index:0,url:\"(dry)\",title:\"(dry)\",active:true}]；switchTab 按 dry 纪律只验声明形状（未知键/空 match/非法值 = 结构化 config_error），对合法 match 恒返回合成成功 {ok:true,index:0,url:\"(dry)\",title:\"(dry)\"}（match 是否命中真实标签是观察事实，dry 不据此判红——与 step 恒 ok、done 不评估同一纪律），因此不需要 dry 守卫", truth: "ctx.ts tabs/switchTab + createDryCtx 桩 + ctx-replay.ts tab 事件回放 + trace.ts TraceCall tab + app-runner.ts isFlowStepEvent" },
  { id: "F34", statement: "href 无损身份（T9/FW6）：`Elem.href` 仍是**有损展示投影**（去 origin、去 query、只留路径末 ≤2 段），逐字节不变——模型视图与 criteriaView 用的仍是它；新增只读字段 `href_full` = 原始 `getAttribute('href')` 原样（不切段、不去 query/fragment/origin；空 href 不出现该字段）。池侧匹配对 `attr === href` 的 attrSubstr/attrEq 走**双字段底座** [href_full, href]（空值剔除、同值去重）：exact → 末路径段 → substring 三档都按「任一字段命中」计算——旧路径型 hint（`a[href=many.html]` 依赖投影）照旧命中，新 query/raw hint（`a[href~page=2]`、`[href=/x?y=1]`）新增可命中；其它属性/形状逐字节不变。DOM 回捞侧无需改（attrSubstr 的 haystack 本就含原始 getAttribute('href')，attrEq 比原始属性）。`ChoiceRequest.elems` 进 provider 前剥离 `href_full`（与 surface 同一处），模型看到的元素形状不变。`suggestHints` 的 href 建议改用原始值（href_full，空则退投影），仍经同一个 hintMatch 自证——inspect 给出的 hint 不再「池面能中、DOM 面永不中」；href_full 同时进 PoolView/inspect 的 extras 供观察", truth: "extraction.ts Elem.href_full（EXTRACT_JS/PASS_HINT/TS 兜底）+ rules.ts hintMatchImpl attrMatchValues/suggestHints + executor.ts pickInner 剥离 + pool-view.ts extras + docs/APP_SCRIPT_AUTHORING.md" },
  { id: "F35", statement: "AX 证据源（第 5 项，只读观察面）：`inspect --json` 新增顶层 `ax` 块，把**浏览器自己算的 accessibility tree**作为第二条观察证据——`{available, source:\"cdp\"|\"playwright\", interactive_count, counts_by_role（全树非 ignored、非文本叶子节点）, interactive_counts_by_role, nodes:[{role,name,focusable,disabled}]≤50, nodes_truncated, total_nodes, pool_size, not_in_pool, not_in_pool_basis}`。取树：优先 Playwright `page.accessibility.snapshot`（1.58 已无该 API，保留旧运行时路径），否则降级 CDP `Accessibility.getFullAXTree`（`page.context().newCDPSession(page)`）；总超时 ≤3s，取不到/抛错/无会话 → null → `ax.available=false` + reason，**绝不抛裸栈、不阻断 inspect 其余输出**。可交互判定只有两条确定性依据：原生可聚焦/可激活 AX role（button/link/textbox/searchbox/checkbox/radio/combobox/listbox/menuitem/menuitemcheckbox/menuitemradio/tab/slider/switch/spinbutton/summary/DisclosureTriangle/treeitem/scrollbar；**option 有意不计入（即使 focusable=true 也不算）**——select 内部 option 由 select 动作承载，计入会灌噪声到 not_in_pool，原始 role 仍在 nodes/counts_by_role）或浏览器报告 `focusable=true`（如 `div[tabindex=0]` 的 generic）；文档根（RootWebArea/WebArea/document）即使 focusable 也不算，generic/none/group 只有 focusable 才计；原始 role 原样输出供人判读。nodes 有界（≤200；“可交互→有名→其余”+ 文档树序），`interactive_count` 与计数不受 nodes 截断影响。`not_in_pool` 是**近似**口径：AX 可交互且有名字的节点中，name 与池元素 label 归一化后全等/互相包含算已进池，否则计未进池（空名不参与），与 `pool_size` 并列如实，只用于指出信息差、不作可点击/存在性断言。**边界**：AX 只进 `inspect` 观察面（每页一次）——不进池构成、hint 匹配、ChoiceRequest/模型视图、dry/run 或任何动作路径；引擎池仍是选择器闭集", truth: "src/engine/ax.ts（snapshotAx/countAxNotInPool/axNodeInteractive）+ src/cli/commands/inspect.ts（ax 块 + 人类行）+ docs/APP_SCRIPT_AUTHORING.md" },
  { id: "F36", statement: "声明驱动的身份回捞（FW8，identity recovery）：反应型框架把 click 监听挂在根容器、叶子自绘控件自身无可枚举属性（不进选择器闭集也不进 ADMIT 准入面），作者写下的稳定身份声明因此永远解析不到。补一条**只服务声明面**的回捞：唯一触发点是这一步**作者声明的目标**（命令 `target` / act hint 即 `ctx.hint(...)` / plan `target_hint`，同一执行器路径）；决策步（无 act）与模型选出的元素**永不**走回捞，回捞元素也绝不进入 `ChoiceRequest.elems` 或 done 判定。**形状白名单**（`hint.ts` 的 parseHint 结果判定）：只认 `#id`、`tag[attr=value]`、`[attr=value]` 且 attr ∈ {data-test, test→data-test, name, id}（精确值，大小写折叠与池侧一致）；attrSubstr / tag~token / 角色词 / 裸词 / near 一律不回捞（它们不是身份声明，行为与今天逐字节一致）。**恰好一个可见匹配**：跨 frame（与 hintLookup 的 framesOf 同口径，≤6 帧）查询全部匹配；0 个 → 保持今天的失败路径（命令走后续候选/最终 target_not_found，act hint 走模型回退）；>1 个可见 → 结构化 `target_ambiguous`（reason 列出每个候选的 tag/label/id/frame/是否可见，绝不回退随便选）；匹配但全不可见（checkVisibility CSS + 非零盒）→ 视为 0，绝不操作隐藏元素，诊断带 hidden_matches 计数（命令进 target_not_found reason，act hint 进 warnings）。**能力守门**：为命中元素合成与池同构的 Elem（tag/label/id/name/data_test/role/input_type/content_editable/draggable/hint_ref/frame），用既有 `elemFamily`/`actionCapabilities` 判定；请求 op 不在能力面 = 结构化 `action_unsupported`（如对普通 div 声明 fill）；click 族对无显式语义的 div 是允许的（身份声明是作者的证据，完成仍由 done 信号裁决，不新增可点性猜测）。**证据与不污染**：trace 行记 `resolved_by:\"dom_identity\"` + `identity:{target,shape,attr,value,matches,total_matches,hidden_matches,frame}`；executed_actions 的 ref 用合成标识（`dom:0` / `dom:f<n>:0`，不伪装成池 ref `eN`）并带 `resolved_by`；命中行临时盖 `data-hintref`（复用 `_locatorFor` 既有身份链），动作尝试一结束（成功/失败/提前停）即清理，只删本批次章值（与 A3 data-af-probe cleanup 同纪律）。不扩池/不扩 ADMIT 选择器/不加 policy 键", truth: "src/engine/extraction.ts（identityHintInfo/identityLookup/PASS_IDENTITY* + Elem 合成）+ src/engine/executor.ts（命令 target 与 act hint 两处一次性接线、能力守门走既有 actionCapabilities、trace/executed_actions 证据、cleanup）+ docs/APP_SCRIPT_AUTHORING.md" },
  { id: "F37", statement: "进程工具信号（T4/T7）：`json_path_equals` 支持 RFC 9535 子集——点路径 + 方括号下标、`$` 前缀可选（`$` = 根、`$.a.b` ≡ `a.b`、`$[0]` ≡ `[0]`），归一后走数据腿同一份 `resolve()`，不新增表达式语法（无递归/过滤/通配）；旧无 `$` 路径逐字节不变。载荷在 dry/`apps check` 与运行期同文案校验：path/want/contains/file_* 必须是字符串（空串/纯空白仍由 U4 真空校验拦）、`exit_code_equals` 必须是整数、`stdout_matches` 必须可编译为 `RegExp(...,\"s\")`——坏载荷 = 结构化 `config_error`，不是运行期静默 false。信号不成立时工具步 `reason`/trace/工件/报告带结构化诊断：json_path_equals 给 path（含归一结果）、实际类型（object/array/string/number/boolean/null/undefined）与 ≤120 字符值摘要（大对象截断；敏感值仍由产物面既有 scrubSecrets 掩码）；exit/stdout/stderr 叶子给期望与实测。`ctx.run` 声明形式只允许实际消费的顶层键（adapter/source/args/dryRunArgs/desc/id/idempotent/retries/returns/done/stdio/ssh/signal/dangerous）；未知键 = 结构化 `config_error`，reason 点名 unknown + known，dry/`apps check` 与运行期同一份校验器（`declaredRunProblems`），绝不静默忽略", truth: "src/browser/tool-signals.ts（normalizeJsonPath/validateToolSignalPayload/explainToolSignal）+ src/app/ctx.ts（declaredRunProblems，运行期）+ src/app/ctx-dry.ts（同一份 dry 校验）+ src/app/app-runner.ts/app-adapters.ts（诊断接线）+ docs/APP_SCRIPT_AUTHORING.md + docs/BACKLOG.md（依赖评审）" },
  { id: "F38", statement: "录制归纳观测面（U2a）：learn/`induceSignals` 的动作前后 StateView 只加观测字段，**不改运行时 judge/池/模型语义**。WITNESS_JS 为每个 witness 节点记 `visible`（`checkVisibility({checkVisibilityCSS:true})` + 非零盒，与 extraction 同口径；隐藏节点不剔除——两态都存在、只翻转 display 的面板/弹层正是证据）与 `disabled`（仅 true 时出现，观测字段，不参与信号语义）；缺字段 = 未捕获。`diffStates` 新增 `visibility`：**两态都捕获了布尔 visible 且不同**的节点（存在性变化仍只走 appeared/gone → `css_exists`/`gone`）；每个可见性翻转生成新候选 kind `visible`（false→true → `css_visible_exists [sel]`）/`hidden`（true→false → `not(css_visible_exists [sel])`），只有动作前 false、动作后 true 才采纳（与既有判别纪律相同）。`evalSignalOnState` 的 `css_visible_exists` 变得可判：matchSelector 命中且首匹配有 visible 字段 → 该布尔值；无命中 → false；**命中但无 visible 字段（旧视图/未捕获）→ null（未知，绝不当作成立）**，`not` 传播 null。候选排序 KINDS = `url_contains > css_value_equals > css_visible_exists > not(css_visible_exists) > css_text_equals > all_of > css_text_contains > css_exists > not(css_exists)`（U2a 值优先：`type`/`fill` 之后输入值把 `css_value_equals` 排在 `css_text_equals` 前；value 只在非空、非 volatile、且捕获期已按 password/file/hidden 长度掩码时生成——敏感值/波动值仍永不进信号）；同 kind 的可见性候选按捕获序（文档序）排列，祖先排在后代前。`tools/learn.ts` 单步与 `--script` 两条路径的 before/after 都走同一 `captureStateView`；learn 落盘格式与成功判定不变（录下来的字面值回放 = U2b，不在本项）", truth: "src/flow/signal-induction.ts（WITNESS_JS visible/disabled + StateDiff.visibility + KINDS/候选排序）+ src/engine/signals.ts（StateView.visible + evalSignalOnState css_visible_exists）+ tools/learn.ts（before/after capture）+ docs/APP_SCRIPT_AUTHORING.md §6" },
  { id: "F39", statement: "录制值管道（U2b）：learn/`record` 把演示的 `type` 值从「录完就丢」接成声明绑定——① 中间结构 `LearnedStep` 带 `value_key`（槽位键，取自控件 name > id > data-test > label，ASCII 归一，重复且值不同才加后缀）、非敏感 `value` 与 `secret` 标记（password/file/hidden，或录制器 `secret`）；② `packFromLearning` 生成 journey 步 `value_binding: {from:\"slot\", key}`，`slots[key]` 默认值 = 演示值，并把**所有**信号/不变量值操作数里的演示值参数化成 `{key}`（pack 展开期按运行槽位替换）——不是硬编码字面值；③ `packToFlowSource` 把值绑定写成 `ctx.command(\"fill\", hint, ctx.value.slot(\"key\"))`（literal 绑定写 `ctx.value.literal`），把信号里的 `{key}` 写成运行期表达式 `ctx.slots[\"key\"]`（动态 done；如 `ctx.judge.value(sel, ctx.slots.key)` 等价），因此 `--slot key=Bob` 回放时动作与完成判据一起变；④ 敏感纪律：secret 槽位 `meta.slots` 恒空串占位（codegen 强制），值绝不进 app.mjs/notes/recordedFrom/信号/诊断（敏感值在信号里只以 `{key}` 出现，人读文本 `***`），生成的 flow 带显式守卫 `if (!ctx.slots[\"k\"]) ctx.fail(\"needs_value\", …)`——空串对 fill 是合法清空，不能静默当成值；⑤ `record/learn --slot k=v`（可重复）与 `--slot-file <json>`：命中 type 动作键时覆盖演示值并成为生成应用的默认值，未命中 = 用法错误，敏感槽位没有值 = 回放门如实失败并提示 --slot-file；learn 自己的 pack/脚本两道回放门都按同一槽位袋运行；⑥ `AppPack.journey` 的 `value_binding` 只认 `{from:\"slot\",key}`：option/list/dataset 请直接写 commands，**literal 显式拒绝**（命令/计划面的绑定来源只有 slot/option/list/dataset，literal 不可用，见 F33 遗留；不新增 literal 语义）；`webStepForPlan` 是加载期校验与 `expandPack` 共用的同一份「绑定 → fill 命令」视图，槽位键未声明由同一份 validateCommands + slotKeys 加载期拦截；⑦ plan 面：learn 只产 flow 应用、不产 plan（`amber start` 的 plan 生成不在本项），故值管道只在 app 面；flow 的 `meta.invariants` 不做槽位替换，依赖演示值的不变量生成时省略并写进 notes（每步 done 已按槽位值动态生成），不猜；⑧ 无值的流程（纯导航/可见性）生成物与 U2b 之前逐字节一致", truth: "tools/learn.ts（LearnedStep value/value_key/secret + learnFromActions 槽位键/敏感检测 + packFromLearning + replayCheck/replayScriptCheck slots）+ src/app/app-adapters.ts（WEB_STEP_KEYS value_binding + webStepForPlan + webAdapter.validateStep/expand）+ src/app/app-pack.ts（validatePack 计划面同一视图）+ src/app/app-meta.ts（packToFlowSource：值绑定 codegen、{slot} → ctx.slots 动态信号、secret 守卫与不落盘、依赖演示值的不变量省略）+ src/cli/commands/record.ts（--slot/--slot-file 透传）+ docs/APP_SCRIPT_AUTHORING.md §6.1" },
];

/** 信号算子语义注记（表从 SIGNAL_OPS 真源取；语义逐条标出处）。 */
const SIGNAL_SEMANTICS: Readonly<Record<string, string>> = {
  url_contains: "URL 含子串（includes），非全等——写路径/参数片段即可",
  css_exists: "任意 CSS、跨主 frame 与可达的子 frame（locatorAnyFrame，同源/跨源均可定位）；存在即真",
  css_exists_text: "[selector, text] 存在任一匹配 selector 且文本含 text 的元素（live=Playwright hasText，跨主 frame 与可达的子 frame——同源/跨源均可，大小写不敏感子串；池近似=匹配元素的合成 label 包含 text）",
  css_visible_exists: "[selector] 首匹配元素存在且可见（live=locator.isVisible()）；learn 捕获了 visible 的 StateView 可按首匹配离线判定，命中但无 visible 字段（旧视图/未捕获）返回 null（不采纳）",
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
  attr_whitelist: { test: "data_test", type: "input_type", "aria-label": "label（别名：DOM 的 aria-label 提取期并进 label）", href: "href（展示投影；匹配同时认原始属性 href_full——query/fragment 可命中）", name: "name", id: "id", role: "role", near: "near" },
  attr_never_matches: ["class", "title", "placeholder（及一切不在白名单的属性）"],
  note: "act hint 走「语法闭集 + 元素池投影」；judge.* 的 selector 走 DOM 查询面（任意 CSS）——两个观察面，别互相推断；href 是唯一双底座属性（href_full + href），suggestHints 优先给原始值；身份形状（#id / tag[attr=value] / [attr=value]，attr=test→data-test|name|id）在**声明目标**解析失败后会做一次 DOM 身份回捞（跨 frame、恰好一个可见匹配才动作；>1 可见=target_ambiguous，全隐藏=不操作只报数；只服务作者声明，不服务决策步/模型）",
  bare_token_tiers: ["整 label 全等", "label/data-test 词全等", "完整 label 的词边界/前缀（A2；大小写不敏感）", "词前缀", "词包含"],
  attr_substr_tiers: ["属性值全等", "末路径段全等", "子串"],
};

/** 命令闭集与值绑定（COMMAND_OPS 从 actions.ts 真源取）。 */
const COMMAND_FACTS = {
  ops: [...COMMAND_OPS],
  value_ops: ["fill", "select", "drag", "upload", "clickAt"],
  value_binding: { from: "slot", key_must_be_declared_in: "meta.slots", missing: "needs_value（结构化停，绝不猜值）" },
  submit_inputs: "input[type=submit|button] 是点击目标，永远不填值",
  after_commands: "命令闭集走完后引擎评估一次 done 信号；全部命令解决而 done 不成立 = done_not_held",
  scroll: "默认把目标滚入视口；带 to（{to:\"bottom\"|\"top\"|\"page\"}，ctx.command(\"scroll\", sel, {to})）= 把容器滚到该方向（A3）；drag 的 value 是落点 selector，仅 [draggable=true]/slider 族声明了能力",
  hover: "S4：只把指针移到目标上（locator.hover()）——用于 :hover 展开的菜单/图层面板；不点击、不导航、不触发预填；池内可交互元素恒有能力，可配步级 force。hover 是按指针状态，快照没变不判 inert（完成仍只认 done）",
  clickAt: "U7：ctx.command(\"clickAt\", \"#cv\", ctx.value.slot(\"coords\")) 在**元素相对**坐标上点击（Playwright locator.click({position}) 语义，相对 padding box 左上角）；值是声明绑定的字符串 \"x,y\"（非负整数/有限小数，允许空白），严格解析，坏格式 = config_error（点名合法格式）；只对 click 族元素成立，非 click 族 = action_unsupported；执行前用 boundingBox 校验 0<=x<width、0<=y<height，越界 = config_error（reason 带实测 width/height）；force 同 click；executed_actions 记 {op:\"clickAt\", position:{x,y}, changed}（how=\"clicked\"），changed/inert 沿用 click 快照 diff；dry/apps check 只校声明形状",
  upload: "U6：只对 input[type=file] 成立；值为声明绑定的路径（单文件 string / 多文件 string[]），执行前 fs.existsSync 校验（缺失 = config_error，reason 点名 basename），经 Playwright locator.setInputFiles 写入；executed_actions 记 {op:\"upload\", how:\"setInputFiles\", files:[basename…]}（只记 basename），changed = 调用后 input.files.length >= 期望数；空串/空数组/非字符串 = config_error；dry/apps check 只校声明形状、不读文件；不新增 risky 语义",
  step_resilience: "步级 opt-in（缺省 false）：force=true 走 Playwright force（click/fill/selectOption/hover 的 {force:true}，跳过 actionability 仍要求可定位，trace 记 forced）；staleRetry=true 在 stale_ref / action_failed / not-actionable-or-covered 且 requery=\"detached\" 时重抽池→重解析同一声明目标→重试 ≤2 次（trace 行事件记 stale_retry:[{attempt,reason,ref}]；运行结果汇总字段是复数的 stale_retries），action-timeout 与「有覆盖者且节点仍在」不重试",
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
    "只读免费（不占预算）：read.text/value/count/attr、extract、holds、waitFor、log、url、tabs",
    "各计 1 个 flow step：ctx.step / ctx.arrive / ctx.run / 批准执行的人工步 / ctx.scrollList / ctx.expand / ctx.setRange / ctx.collect / ctx.switchTab",
    "step 内的 command 闭集不单独计 flow 步：一个 step 的动作循环上限 8（子目标动作预算）",
    "flow 预算用满 → budget_exceeded（status=partial、verified=false、exit 0）",
  ],
  flow_call: { default: 100, cli_flag: "--max-steps", counts: ["ctx.step", "ctx.arrive", "ctx.run", "批准执行的人工步", "ctx.scrollList", "ctx.expand", "ctx.setRange", "ctx.collect", "ctx.switchTab"], note: "when 跳过的步同样计 1；用满 → budget_exceeded（status=partial、verified=false）" },
  subgoal_actions: { default: 8, configurable: false, note: "执行器动作循环上限；reason 里的 \"on step N\" 是本层动作号，与流步号两口径" },
  signal_wait: { done_timeout_ms_default: 2000, step_level_override: "timeoutMs", note: "约束动作后等 done 的窗口，不约束整步挂钟（模型咨询/导航渲染不在其内）" },
  free_calls: ["read.text/value/count/attr", "extract", "holds", "waitFor", "log", "url", "tabs"],
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
  tabs_switch: "新标签页不会自动跟随：window.open/target=_blank 后先 ctx.tabs()（免费只读；列表可含信封外页面）再 ctx.switchTab({index|urlContains|titleContains})（计 1 步；恰好一个匹配，0/多 = config_error 并列出当前 tabs；信封外 = host_not_allowed 且不切换）",
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
  tabs_switch: "标签页桩：tabs() 返回合成 [{index:0,url:\"(dry)\",title:\"(dry)\",active:true}]；switchTab 只验声明形状（未知键/空 match/非法值 = config_error），对合法 match 恒返回合成成功（match 是观察事实，dry 不验——与 step 恒 ok 同一纪律），不需要 dry 守卫；dry 不访问浏览器，switchTab 仍计 1 步预算",
  validation_errors: "S3 吞错留痕：ctx-dry 的 validateXxxRequest（scrollList/expand/setRange/collect）抛错前先落 validation_error 事件（含 call/desc/message）——脚本 try/catch 吞掉 config_error，apps check 仍判 FAIL 并输出「脚本吞掉了配置错误：<call> <message>」。源码调用点对账（ctx.expand/scrollList/setRange/collect 出现次数 vs dry 事件数）只在 check 报告警告，不改退出码",
  policy_settle: "settle 是引擎侧行为（无页面面无桩）；但 meta.policy.settle 的加载期校验在 dry 同样生效——非法 settle 在 apps check 就红",
  policy_decision_state: "S5：meta.policy.decision_state 是**声明面**——{gate?:\"off\"|\"stable_only\", context?:\"off\"|\"delta\"}，未知子键/非法档位在 dry（apps check）就红；dry 不跑执行器决策路径 ⇒ 没有 ask/settle，产物 decisions 的 S5 指标只在真实运行出现（dry 流程也不伪造计数）",
  step_resilience: "S4：步级 force / staleRetry 是**声明面**——dry 的 step event result 只记 forced:true / stale_retry:true（布尔声明标记），不模拟重试、不改变 ok；真实面的重试证据是 executor trace 行上的 stale_retry:[{attempt,reason,ref}] 数组（StepResult/RunReport 侧汇总字段名为复数的 stale_retries，勿混写）。命令闭集的 op 校验在 dry 与真实 ctx 走同一份 validateCommands（含 hover）",
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
    "- upload（U6）：ctx.command(\"upload\", \"#file\", ctx.value.slot(\"path\")) 只对 input[type=file]；单文件 string / 多文件 string[]；路径须存在（缺失=config_error），只记 basename；非 file 目标=action_unsupported；dry 不查文件",
    "- clickAt（U7）：ctx.command(\"clickAt\", \"#cv\", ctx.value.slot(\"coords\")) 的值是声明绑定的 \"x,y\" 元素相对坐标（非负整数/有限小数，允许空白）；只对 click 族成立；坏格式/越界=config_error（reason 带实测尺寸），非 click 族=action_unsupported；证据 {op:\"clickAt\", position:{x,y}}；dry 只校声明形状",
    "- judge.url(s)=URL 含子串；judge.exists 跨 iframe；judge.text(sel,s)=首匹配含 s",
    "- judge.existsText(sel,s)=存在文本含 s 的元素（live hasText；池评估是 label 近似）；judge.exists(sel,{visible:true})=存在且可见（池评估不可判定）",
    "- hint 六形状；属性仅 test/type/href/name/id/role/near（aria-label 是 label 别名）—— class/title/placeholder 永不命中；href 匹配认原始属性（query/fragment 可中，展示投影 href 仍供模型识别）",
    "- ctx.step 失败返回 {ok:false}，只有 ctx.fail 中断；when 跳过同样计 1 步预算",
    "- read/extract/holds/waitFor/log/url 免费；step/arrive/run/manual 与四原语各计 1",
    "- ctx.extract(\"name\") 走 meta.site.listExtract；inline 用 ctx.extract({rows, fields})（无需声明）",
    "- ctx.collect({row,fields,until}) 反复滚动取行（计 1 步）；stopReason=stable|maxRows|budget|not_scrollable，绝不假装穷尽",
    "- 新标签页不会自动跟随：window.open/target=_blank 后先 ctx.tabs()（免费列未关闭页）再 ctx.switchTab({index|urlContains|titleContains})（恰好一个匹配、计 1 步；0/多 = config_error 列出当前 tabs；信封外 = host_not_allowed 且不切换）",
    "- settle：抽池前只在页面有突变时等静默（meta.policy.settle 默认开；等待落 state.settleMs）",
    "- 就绪（U3）：池空 ≠ 未就绪。meta.policy.pool_gate 缺省 fact = 池空但 settle 静默且 readyState=complete 记 flags:pool_empty 后继续（diagnostics.readiness 带证据）；strict = 旧 page_not_ready 快败。闸门只在 flow 面（ctx.step）",
    "- surface（U3）：meta.policy.surface.native_activation 缺省 window（summary 进池、类目 cap=6）；off = 池构成回到 U3 之前（A/B 逃生口）",
    "- 执行韧性（S4，步级 opt-in）：force:true 走 Playwright force（跳过 actionability，仍要求可定位）；staleRetry:true 在 stale_ref/action_failed/节点已卸载时重解析同一目标重试 ≤2 次（trace 行事件 stale_retry 数组；结果汇总字段 stale_retries）；hover 命令只移指针展开 :hover 面板",
    "- step_traces[i].state 记状态指纹/flags/effect；ctx.runtime.epoch 只读；flags 只标注不改 done",
    "- 决策状态（S5，默认关，meta.policy.decision_state）：gate:\"stable_only\" = ask 前先 settle、同池同题不重复问（产物 decisions.asks_saved/gate_waits）；context:\"delta\" = 请求带 ≤200B 结构化 state_digest（provider 不支持则跳过并记 context_skipped）",
    "- 扫描面（B2）含 div[role=menuitem/menuitemradio/menuitemcheckbox/option/tab]（click 族）：弹层菜单项/下拉选项/页签进池——全局行为变更，候选构成与排序可能变化、同名候选（tab 与按钮同 label）歧义可能增多；hint 按 label 匹配不变，窗口与分桶配额不变",
  ];
}
