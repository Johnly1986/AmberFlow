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
import { nextForStop } from "../engine/planning-playbook.ts";

/** 可查询的节名（`--topic`）。 */
export const SCHEMA_TOPICS = [
  "facts", "signals", "hints", "commands", "budget", "navigation", "flow_control", "dry", "stopcodes",
] as const;
export type SchemaTopic = (typeof SCHEMA_TOPICS)[number];

/** 语义事实清单：无源码世界里 Agent 必须能从本契约回答的每一题（逐条验收）。 */
const CTX_FACTS: ReadonlyArray<{ id: string; statement: string; truth: string }> = [
  { id: "F01", statement: "fill/select/drag 的值只认 slot 绑定：ctx.command(op, sel, {from:\"slot\", key}) 且 key 必须在 meta.slots 声明；绑定缺值 = 结构化 needs_value，值绝不来自模型或猜测", truth: "executor.ts（红线②：never guessed）；apps check 离线可拦截" },
  { id: "F02", statement: "judge.url(s) = URL 子串包含（urlOf(page).includes(s)），不是全等", truth: "signals.ts url_contains" },
  { id: "F03", statement: "judge.exists(sel) 跨主 frame 与同源子 frame（locatorAnyFrame），任意 CSS 可用", truth: "signals.ts css_exists" },
  { id: "F04", statement: "judge.text(sel,s) = 首匹配 innerText 包含 s；精确全等在带徽标/编辑链接的标题上永不成立，优先 contains", truth: "signals.ts css_text_contains" },
  { id: "F05", statement: "act hint 是六形状语法闭集（#id / tag[attr~substr] / tag~token / tag[attr=value] / 角色词 / 裸词）；属性白名单仅 test→data-test、type→input_type、href、name、id、role、near——aria-label/class 不在池字段模型，永不命中", truth: "hint.ts parseHint + rules.ts poolAttr + grammar-prompt.ts（prompt-hit 校验）" },
  { id: "F06", statement: "裸词 hint 四档匹配（整 label 全等 → 词全等 → 前缀 → 包含），只取最强非空档；档内真歧义返回 null 交给决策层", truth: "rules.ts hintMatchImpl bare-token ladder" },
  { id: "F07", statement: "ctx.step 失败是【返回】{ok:false, stopCode, reason}，不抛异常不中断 flow；只有 ctx.fail(code, reason) 抛 StopError 终止运行", truth: "ctx.ts / app-runner.ts" },
  { id: "F08", statement: "when 守卫不成立 = 该步不执行，返回 ok:false + stopCode:precondition_skipped，trace 记 skipped——不是失败，但同样消耗 1 步执行预算", truth: "executor.ts / APP_SCRIPT_AUTHORING.md §4" },
  { id: "F09", statement: "预算三层：① flow 调用预算（缺省 100，--max-steps 覆盖；step/arrive/run/人工步各计 1）② 子目标动作预算（缺省 8，当前不可配）③ 信号等待窗口（done_timeout_ms 缺省 2000，步级 timeoutMs 覆盖）", truth: "executor.ts maxSteps=8 + ctx.ts budget" },
  { id: "F10", statement: "只读调用免费不占预算：read.text/value/count/attr、extract、holds、waitFor、log、url", truth: "app-runner.ts 计费口径" },
  { id: "F11", statement: "dry 模拟面：step/arrive/run/manual 恒 ok:true 且 when 不评估；read.* 返 null/0；url() 是最近声明值；预算照计——数据驱动的分支/断言必须用 ctx.runtime.runId===(dry) 守卫", truth: "ctx-dry.ts createDryCtx（06-B 实证全表）" },
  { id: "F12", statement: "导航：open/openPage 只做 goto(domcontentloaded) 不等信号；arrive(url,{done}) = 导航 + 轮询等落地证据——「导航后还要等页面状态」一律用 arrive", truth: "ctx.ts / APP_SCRIPT_AUTHORING.md §4（04-C 实测）" },
];

/** 信号算子语义注记（表从 SIGNAL_OPS 真源取；语义逐条标出处）。 */
const SIGNAL_SEMANTICS: Readonly<Record<string, string>> = {
  url_contains: "URL 含子串（includes），非全等——写路径/参数片段即可",
  css_exists: "任意 CSS、跨主 frame 与同源子 frame（locatorAnyFrame）；存在即真",
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
  attr_whitelist: { test: "data_test", type: "input_type", href: "href", name: "name", id: "id", role: "role", near: "near" },
  attr_never_matches: ["aria-label", "class", "title", "placeholder（及一切不在白名单的属性）"],
  note: "act hint 走「语法闭集 + 元素池投影」；judge.* 的 selector 走 DOM 查询面（任意 CSS）——两个观察面，别互相推断",
  bare_token_tiers: ["整 label 全等", "label/data-test 词全等", "词前缀", "词包含"],
  attr_substr_tiers: ["属性值全等", "末路径段全等", "子串"],
};

/** 命令闭集与值绑定（COMMAND_OPS 从 actions.ts 真源取）。 */
const COMMAND_FACTS = {
  ops: [...COMMAND_OPS],
  value_ops: ["fill", "select", "drag"],
  value_binding: { from: "slot", key_must_be_declared_in: "meta.slots", missing: "needs_value（结构化停，绝不猜值）" },
  submit_inputs: "input[type=submit|button] 是点击目标，永远不填值",
  after_commands: "命令闭集走完后引擎评估一次 done 信号；全部命令解决而 done 不成立 = done_not_held",
  scroll: "把目标滚入视口；drag 的 value 是落点 selector，仅 [draggable=true]/slider 族声明了能力",
};

/** 预算（三层结构，08-A6 实测成文）。 */
const BUDGET = {
  flow_call: { default: 100, cli_flag: "--max-steps", counts: ["ctx.step", "ctx.arrive", "ctx.run", "批准执行的人工步"], note: "when 跳过的步同样计 1；用满 → budget_exceeded（status=partial、verified=false）" },
  subgoal_actions: { default: 8, configurable: false, note: "执行器动作循环上限；reason 里的 \"on step N\" 是本层动作号，与流步号两口径" },
  signal_wait: { done_timeout_ms_default: 2000, step_level_override: "timeoutMs", note: "约束动作后等 done 的窗口，不约束整步挂钟（模型咨询/导航渲染不在其内）" },
  free_calls: ["read.text/value/count/attr", "extract", "holds", "waitFor", "log", "url"],
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
};

/** dry 模拟面（createDryCtx 实证全表，06-B）。 */
const DRY = {
  step_arrive_run_manual: "恒返回 ok:true，when 不评估（precondition_skipped 分支结构性不可预演）",
  read_extract: "extract 返 []、read.attr 返 null、read.count 返 0、waitFor 立即 true",
  url: "url() 是最近声明值",
  budget: "步预算照常计数",
  rule: "一切基于观察值的 ctx.fail/分支/断言必须用 ctx.runtime.runId === \"(dry)\" 守卫；check VALID ≠ 每条分支被走过",
};

/** stopCode 一句话表（与 docs/APP_SCRIPT_AUTHORING.md §10 同步；--check 防漂移）。 */
const STOPCODE_MEANING: Readonly<Record<string, string>> = {
  config_error: "脚本声明/运行配置错——改声明，不要重试",
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
  step_names_no_target: "步骤未点名目标且规则/模型都没有可用候选",
  needs_value: "声明了 slot 绑定但值不存在（绝不猜）",
  trace_mismatch: "重放与轨迹版本/输入不一致——重跑，不要重放",
};

/** 停因 → 下一步（从 planning-playbook 真源取，未收录的如实标 null）。 */
function stopcodesSection(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [code, meaning] of Object.entries(STOPCODE_MEANING)) {
    out[code] = { meaning, next: nextForStop(code) };
  }
  return out;
}

/** 渲染完整契约（确定性输出：键序固定、无时间戳——--check 依赖这一点）。 */
export function renderSchemaCtx(): Record<string, unknown> {
  return {
    schema: "amberflow.ctx-contract",
    note: "无源码世界的 Agent 语义契约：全部事实标注源码出处；引擎行为以本契约为准（快照经 --check 防漂移）",
    topics: [...SCHEMA_TOPICS],
    facts: CTX_FACTS,
    sections: {
      signals: { ops: SIGNAL_OPS, semantics: SIGNAL_SEMANTICS, done_rule: FLOW_CONTROL.done_rule },
      hints: HINT_GRAMMAR,
      commands: COMMAND_FACTS,
      budget: BUDGET,
      navigation: NAVIGATION,
      flow_control: FLOW_CONTROL,
      dry: DRY,
      stopcodes: stopcodesSection(),
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
    "- hint 六形状；属性仅 test/type/href/name/id/role/near —— aria-label/class 永不命中",
    "- ctx.step 失败返回 {ok:false}，只有 ctx.fail 中断；when 跳过同样计 1 步预算",
    "- read/extract/holds/waitFor/log 免费；step/arrive/run/manual 各计 1",
  ];
}
