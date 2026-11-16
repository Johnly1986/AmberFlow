/**
 * 应用 pack 的 policy 声明面：键表、合法值闭集与 `PackPolicy` 类型；policy 嵌套块的加载期校验见 validatePolicyExtras。
 *
 * 只声明"作者能写什么"；校验顺序与文案由 validate-pack.ts 的 validatePolicy 按序调用。
 */
import { isDict } from "../support/pystr.ts";

/**
 * **运行策略可以声明**。
 *
 * 配置面必须收敛到包声明："应用是什么"在包里、"这次怎么跑"只在命令行时，同一个包的含义随
 * 命令行变，而 `tieredHint`（窄问）这类**属于站点知识**的开关，包作者根本没法为自己的包打开。
 * 现在包级可以声明这些策略；**缺省 = 今天的行为**（不写 policy 的包逐字节不变），
 * CLI 显式参数只覆盖本次运行，报告打印生效值与来源。
 */
export const POLICY_KEYS = [
  "tiered_hint", "risk_ask", "reobserve", "max_effective_repeats", "conf_floor",
  "done_timeout_ms", "done_poll_ms", "pool_ready_timeout_ms", "pool_ready_poll_ms",
  "candidate_priority",
  // S1 状态层：pre-held done 的处置 + fill/setRange 的 effect 读回。
  "done_preheld", "effect_readback",
  // P0-E 完成语义诚实：done 成立后的只读复核 guard（false_done；缺省 warn = 只记录）。
  "done_guard",
  // S2：抽池前的稳定门（缺省开启；"off" 关闭）。
  "settle",
  // U3：池空判档（缺省 "fact"；"strict" = U3 之前的 page_not_ready 快败）+ surface 类目策略。
  "pool_gate", "surface",
  // S5：状态接入决策（gate/context 两项都缺省 off = 行为不变）。
  "decision_state",
  // 导航纪律（缺省 "free" = 现行为逐字节不变；"entry-only" = 入口外直接 URL 跳转被拦）。
  "navigation",
  // P0-B：act hint 未命中时是否允许模型自由选（缺省 widen = 现行为逐字节不变）。
  "act_hint",
  // A3：弱档命中（bare 词前缀/词包含、attrSubstr loose 子串）算不算命中
  // （缺省 any = 现行为逐字节不变；strong = 改判未命中）。
  "act_hint_tier",
  // P0-C：声明目标解析链是否启用 DRF（缺省 "off" = 现行为逐字节不变）。
  "target_resolution",
  // F74：决策步 act hint 的 DOM 回退跳（缺省 false = 现行为逐字节不变；true = 解析链全落空
  // 后补一次主帧 ADMIT_SEL 回退面，A3 对称）。
  "act_hint_dom_fallback",
  // A1：aria-label 属性 hint 的池侧匹配底座（缺省 "full_label" = 修复后；"display" = A1 之前）。
  "attr_value_match",
  // task-43：浏览器通道选择面（缺省不写 = 现状链逐字节不变；优先级 env > meta > default）。
  "browser",
  // F84 批 3（deny-list 可配化）：第 5 档词元护栏的放行词元表（缺省不写 = 护栏行为逐字节
  // 不变；SKU 恰似数字被价格/时段 deny 模式误杀时的外科调优出口）。
  "hint_token_allow",
] as const;

/** 导航纪律档位（`meta.policy.navigation`）。 */
export const NAVIGATION_MODES = ["entry-only", "free"] as const;

/** act hint 解析失败时的档位（`meta.policy.act_hint`）。 */
export const ACT_HINT_MODES = ["widen", "strict"] as const;

/**
 * A3：弱档胜出算不算命中（`meta.policy.act_hint_tier`；与 `act_hint` **正交**）。
 * `any`（缺省）= 今天逐字节不变（弱档胜出 conf=1.0 直接执行 + `matched_others` 警告）；
 * `strong` = 弱档（bare tier≥3 词前缀/词包含、attrSubstr tier=3 loose 子串）改判**未命中**，
 * 随后按 `act_hint` 既有语义继续（widen 交模型 / rules-only 落既有 no_model_runtime /
 * strict 结构化 target_not_found）。判据复用 rules 的 `suspicious`，不另造档位表。
 */
export const ACT_HINT_TIER_MODES = ["any", "strong"] as const;

/** 声明目标解析链档位（`meta.policy.target_resolution`；缺省 off = 现行为逐字节不变）。 */
export const TARGET_RESOLUTION_MODES = ["off", "declared"] as const;

/**
 * A1：`aria-label` 属性 hint 的池侧匹配底座（`meta.policy.attr_value_match`）。
 * `full_label`（缺省）= `[full_label, label]` 双底座（>40 字的值命中）；
 * `display` = A1 之前只看模型视图前 40 字 label（逃生口/对照臂）。
 */
export const ATTR_VALUE_MATCH_MODES = ["full_label", "display"] as const;

/**
 * 浏览器通道档位（`meta.policy.browser`；task-43）。
 * `chrome` = Playwright channel:"chrome"（系统 Chrome，new headless）；`headless-shell` =
 * ms-playwright 的 headless-shell 二进制（= 缺省现状）。不写 = `launchKwargs` 现行解析
 * （headless 缺省即 headless-shell）；优先级 env(AMBERFLOW_BROWSER_CHANNEL) > meta > default。
 */
export const BROWSER_CHANNELS = ["chrome", "headless-shell"] as const;

/** S5 状态闸门档位（`meta.policy.decision_state.gate`）。 */
export const DECISION_STATE_GATES = ["off", "stable_only"] as const;

/** S5 状态上文档位（`meta.policy.decision_state.context`）。 */
export const DECISION_STATE_CONTEXTS = ["off", "delta"] as const;

/**
 * `risk_ask`：值不值得为"要不要拦"花一次模型前向。
 * `always` = 今天（非关键词动作每一步都问）；`rules-only` = 只信 `DESTRUCTIVE_PATTERNS`。
 * 批量运行里 `confirmFn` 默认一律放行 ⇒ 这次前向的答案没人看，`rules-only` 就是把它省下来。
 */
export const RISK_ASK_MODES = ["always", "rules-only"] as const;

export interface PackPolicy {
  tiered_hint?: boolean;
  risk_ask?: (typeof RISK_ASK_MODES)[number];
  reobserve?: boolean;
  max_effective_repeats?: number;
  /**
   * 导航纪律（缺省 `"free"` = 现行为逐字节不变；**只在 flow 脚本面生效**——plan/journey
   * 面的 subgoal start_url 不受此 policy 约束）：
   *   - `"entry-only"`：强制"人类式导航"。引擎发起的直接 URL 导航（`ctx.open` /
   *     `ctx.openPage` / `ctx.arrive` / step 级 `url` 重锚）只有（a）本次运行的第一次
   *     直接导航（= 入口，仍走 hosts 信封检查）或（b）目标与当前页 **origin+path+query
   *     全等**（忽略 hash，重试语义）时放行；其余结构化停因 `navigation_forbidden`
   *     （reason 同时给出当前 URL 与试图跳转的 URL；`diagnostics.navigation` 留
   *     {policy, attempted, current} 证据）。**页面驱动的导航永不拦截**：点击链接/按钮
   *     导致的跳转、锚点 hash 变化、新标签页/tab 切换都是浏览器行为，不是引擎直接导航。
   *   - `"free"`：显式声明"不约束"（与缺省同义；声明了才进 effective_policy 的账）。
   */
  navigation?: (typeof NAVIGATION_MODES)[number];
  /**
   * P0-B：声明目标（`act: ctx.hint(...)` / `target_hints` 多声明）的解析链
   * （池 hintMatch → ADMIT 回捞 → FW8 声明身份回捞）全部未命中时怎么办：
   *   - `"widen"`（缺省，= 现行为逐字节不变）：不拦，交给模型自由选（决策步的既有阶梯）；
   *   - `"strict"`：**禁止模型回退**，结构化停因 `target_not_found`（reason 显式写明
   *     `act_hint="strict"` + 原 hint + 池快照）。只砍模型回退：FW8 身份回捞（`#id` /
   *     `[data-test]` / `[name]` 声明）仍先执行；命令步（自带解析/报错）不受影响。
   * 显式声明才进 effective_policy.act_hint（widen 也进账）。
   */
  act_hint?: (typeof ACT_HINT_MODES)[number];
  /**
   * A3：**弱档命中算不算命中**（与 `act_hint` 正交；缺省 `"any"` = 现行为逐字节不变）。
   *   - `"any"`：今天——裸词的词前缀/词包含档（bare t=3/t=4）或属性子串的 loose 档
   *     （attrSubstr t=3）胜出即 conf=1.0 `rule:match` 直接执行，只留一条 step warning
   *     `matched_others`（"命中对象可能是容器/同缀元素"）；
   *   - `"strong"`：同一判据（复用 rules 的 `suspicious`）下该命中**不算命中**——ref 清空、
   *     step warning 换成 `weak_hint_rejected`，随后按 `act_hint` 既有语义继续：
   *     `widen`（缺省）交模型自由选（rules-only 落既有 `no_model_runtime`）；`strict`
   *     结构化 `target_not_found`（reason 写明"弱档被判未命中"+候选+两条修法）。
   * 两键**互不替代**（一个管"没命中怎么办"、一个管"弱档算不算命中"）；widen+strong 与
   * strict+strong 都合法。命令 target、`--remember` 学到的 hint（非作者声明）、决策步不受影响；
   * 只作用于声明目标的规则解析与 rules-only 宽扫两处（同一 `declaredAllow`）。
   * 显式声明才进 effective_policy.act_hint_tier（显式 "any" 也进账）。
   */
  act_hint_tier?: (typeof ACT_HINT_TIER_MODES)[number];
  /**
   * P0-C 声明目标解析链（DRF，declared target resolution）：
   *   - `"off"`（缺省）= 现行为逐字节不变；
   *   - `"declared"` = 命令 `target` / act hint 在池 hintMatch → ADMIT 回捞 → FW8 身份回捞
   *     全部落空后，再由 DOM 侧兜底：属性型 hint 走 ADMIT_SEL + 同一套 hint 语义，裸词 hint
   *     走可见文本精确匹配；跨 frame 恰好一个可见才动作（>1 → target_ambiguous，全隐藏 =
   *     未命中 + hidden 诊断）。click 族动作前必须 hit-test（被覆盖不点击）。首版只允许
   *     click/scroll/hover，fill/select/drag/upload/clickAt → 结构化 action_unsupported。
   *     回捞元素只进本步局部池，**模型不参与**（不进 ChoiceRequest.elems）。
   *     dry/apps check 只校验 policy 值（DOM 事实无法离线验证，不新增绿）。
   */
  target_resolution?: (typeof TARGET_RESOLUTION_MODES)[number];
  /**
   * F74：决策步 act hint 的 **DOM 回退跳**（布尔；缺省 false = 现行为逐字节不变）。
   * true = 声明 act hint 在 池→ADMIT 回捞→FW8→(DRF)→(U5/F72) 全链真落空后，再走一次
   * 主帧 ADMIT_SEL DOM 回退面（与会话 act 的 `_domFallbackResolve` 同一实现，不过滤
   * 可见性、含 0×0 自绘控件）；命中 = 确定性 rule:match（不进模型投影）；至多一次/步。
   * 与 `act_hint` 族命名对齐但形状是布尔（非档位）。显式声明才进 effective_policy。
   */
  act_hint_dom_fallback?: boolean;
  /**
   * A1：`tag[aria-label=…]` / `tag[aria-label~…]` 的**池侧**属性值匹配底座。
   *   - `"full_label"`（缺省）：`[full_label, label]` 双底座——池字段 `full_label` 是
   *     ≤200 的完整匹配串，`label` 只是模型视图的前 40 字；只比 label 时 >40 字的
   *     aria-label 值永远等不上（`attrEq` 与 `attrSubstr` 同一函数，一处修两形状）。
   *   - `"display"`：A1 之前的行为（只比 `label` 前 40 字，>40 的值永不命中）——逃生口/对照臂。
   * 只作用于 hint 匹配；≤40 的值**等值**命中集合逐字节不变（同值重复仍取 DOM 首个）。
   * inspect/observe/session 无 policy，恒 `full_label`。显式声明才进 effective_policy。
   */
  attr_value_match?: (typeof ATTR_VALUE_MATCH_MODES)[number];
  /**
   * F84 批 3（deny-list 可配化）：第 5 档词元护栏的**放行词元表**（`meta.policy.
   * hint_token_allow`；缺省不写 = 护栏行为逐字节不变）。
   *   - 用途：SKU 恰似数字被价格/时段 deny 模式误杀时的外科调优出口（表内词元跳过 deny
   *     模式直接参与 in-row 候选生成；结构约束〔非空/禁 `>`/≤40 字符〕不退让）。
   *   - 校验：字符串数组、每项非空且无内部空白、≤40 字符、至多 16 项（非法 = config_error）；
   *     比较时小写折叠。
   *   - 配置面选择理由（meta.policy vs config-schema 二选一）：词元误杀是**站点内容特征**
   *     （SKU 形态随站点而变）→ per-app policy；config-schema 全局键会跨站点污染（A 站的
   *     SKU 放行不该影响 B 站）。沿 F58 attr_value_match / F59 act_hint_tier 先例。
   *   - 面覆盖：run 面（歧义证据 suggested_hint）与 ctx.observe（自证池 hint_candidates）
   *     生效；inspect CLI（无 meta 面）与 session/桥面缺省——F58 同款面边界，文档写明。
   *   - 显式声明才进 effective_policy。
   */
  hint_token_allow?: string[];
  /**
   * task-43：浏览器通道（`"chrome" | "headless-shell"`；**缺省不写 = 现状链逐字节不变**）。
   * 优先级 env(AMBERFLOW_BROWSER_CHANNEL) > meta > default——env 是部署/CI 的机器级覆盖，
   * meta 是应用作者的站点知识（已知 headless-shell 下坏的站点在此点名 chrome）。
   * 主机没有系统 Chrome 时 launch 如实报错（**不静默回退**；要回退请删 meta 或改 env）。
   * 生效值与来源进 `effective_policy.browser`（仅 env/meta 任一存在时出现）；
   * 真实二进制以 `env.browser.binary_basename` 记账（D-1）为准。
   */
  browser?: (typeof BROWSER_CHANNELS)[number];
  /**
   * 置信度闸门（缺省 0.25）。**为什么要能声明**：闸门比的是 provider 的 `score`，而
   * `score_kind` 不同的两支不可比（laya 的归一化熵 vs 在线服务的标定概率）——
   * 换 provider 时 0.25 的含义就变了（实测：token-plan 在 camera-entry 上有一枪 0.20
   * 被硬阻塞，而 0.20 是它自己的"把握"刻度）。优先级：CLI > pack.policy > provider 自报 > 0.25。
   */
  conf_floor?: number;
  /** action 后 done 信号的总等待窗口（毫秒；缺省 2000）。 */
  done_timeout_ms?: number;
  /** action 后 done 信号轮询间隔（毫秒；缺省 120）。 */
  done_poll_ms?: number;
  /** 元素池 ready gate 的最大等待（毫秒；缺省 700）。 */
  pool_ready_timeout_ms?: number;
  /** 元素池 ready gate 的轮询间隔（毫秒；缺省 100）。 */
  pool_ready_poll_ms?: number;
  /**
   * A2 候选窗口排序策略：`bucketed`（缺省，分桶配额 chrome/viewport/...）或
   * `main-first`（回退 A2 之前的 main 内容优先排序）。显式声明才进 effective_policy。
   */
  candidate_priority?: "bucketed" | "main-first";
  /**
   * S1 状态层：动作**之前** done 信号就已成立时的处置（缺省 `warn` = 只记录、不拦）。
   *   - `warn`：`step_traces[i].state.flags` 记 `done_preheld` + run summary warning，行为逐字节不变；
   *   - `fail`：该步在动作**执行前**结构化停止（`stop_code=done_preheld`）——pre-held 的 done
   *     不能算作这一步的完成证据，继续动作只会制造“零执行通过/顺手通过”的假证据；
   *   - `allow`：显式接受（只留 flags，不出 warning）。
   * 步级 `forceAct` 优先于 `fail`：作者已显式声明“即使已成立也先把命令闭集走完”。
   */
  done_preheld?: "warn" | "fail" | "allow";
  /**
   * P0-E 完成语义诚实：done 成立后的**只读**复核 guard（`false_done`）的处置
   * （缺省 `"warn"` = 只把证据记进 step warning，成功判定不变）：
   *   - `warn`：guard 命中（登录墙特征：主 frame URL 词边界命中 / title 或 h1-h3 登录文案 /
   *     跨出 meta.hosts 信封；或「有动作但 changed=false 且 done 是否定式」的零前进蹭成立）
   *     ⇒ step warning `false_done: …`（含 URL/证据），步骤仍 ok；
   *   - `fail`：命中 ⇒ 结构化停因 `false_done`（reason 含证据与修法）。
   * guard 是诚实 tripwire，不是启发式完成判定：完成仍只认 done 信号；登录类应用
   * （正常登录会落在 /passport 这类 URL）建议保持缺省 warn。
   */
  done_guard?: "warn" | "fail";
  /**
   * S1 状态层：fill / setRange 的 effect 读回（缺省两项都开）。
   *   - fill：动作后读回组件值并与写入值比对，结果进 `step_traces[i].state.effect`
   *     （`applied` 才是“真的填进去了”，不再只看动作没抛错）；不可读组件自动降级跳过。
   *   - set_range：`ctx.setRange` 结果附 `applied` / `accurate`（与目标容差内）。
   * 声明 false 只关掉对应的读回字段，不改变动作本身。
   */
  effect_readback?: { fill?: boolean; set_range?: boolean };
  /**
   * S2 稳定门：每次抽池前，若页面最近有 DOM 突变（"脏"）就先等到静默再抽。
   * 缺省开启 `{quiet_ms:400, timeout_ms:5000}`（方案 §2.5）；`"off"` 完全关闭。
   *   - 已静默立即返回（0 等待）；静态页稳态零开销；
   *   - 导航后第一次抽池最多付一次 quiet_ms（安装 observer 的时刻视为刚脏）；
   *   - 永不抛错：超时只返回 timedOut，不阻断执行；等待毫秒数落 `state.settleMs`。
   * 未知子键在加载期拒绝（写了就要生效）。
   */
  settle?: { quiet_ms?: number; timeout_ms?: number } | "off";
  /**
   * U3 池空判档（**只在 flow 脚本面生效**：`ctx.step` 开 poolReady；journey/plan 面
   * `poolReady=false`，本键不适用）：
   *   - `"fact"`（缺省）：池空但 settle 静默且 readyState=complete ⇒ `ready_empty`：
   *     step 记 `flags:["pool_empty"]` + 一条 warning 后**继续**（不再整页判死）；
   *   - `"strict"`：池空 = `page_not_ready`（U3 之前的逐字节行为，逃生口）。
   */
  pool_gate?: "fact" | "strict";
  /**
   * U3 surface 类目策略（声明面）：
   *   - `native_activation: "window"`（缺省）——`<summary>` 进元素池，受类目 cap=6 约束；
   *   - `"resolve"`——进**准入面**但不入窗口：决策步看不到 summary（池=0），但命令 target / 声明
   *     `target_hint` 仍可按身份经 DOM 回捞命中并执行（FW5 实测：`#sum` 可点、changed=true）；
   *   - `"off"`——池构成回到 U3 之前（逃生口，A/B 对照臂）。
   * 未知子键在加载期拒绝（写了就要生效）。
   */
  surface?: {
    native_activation?: "window" | "resolve" | "off";
  };
  /**
   * S5 状态接入决策（**两项缺省都 off = 行为不变**；A/B 开关，见方案 §2.5/§4 S5）。
   *   - `gate: "stable_only"`：模型 ask 之前先检查状态游标——
   *     ① 页面未静默 → 先 settle（走 `policy.settle` 参数；超时不阻塞继续问）；
   *     ② **池指纹与上一次 ask 相同且规则层仍歧义 → 不重复 ask**，复用上一次答复，
   *        后续 floor/reobserve/escalate 裁决全部照旧（就是"既有降级路径"）。
   *     指标（应用产物 `decisions`）：`asks_saved`（省掉的 ask 数）、`gate_waits`（真正等待次数）。
   *   - `context: "delta"`：决策请求带 ≤200B 的**结构化** `state_digest`
   *     `{nav_epoch_delta, last_effect?{kind,applied}, settled, pool_changed, flags?[]}`——
   *     只给观测事实，不塞建议；模型仍只投票。指标：`context_sent` / `context_skipped`
   *     （后者 = provider 输入 schema 固定而被整段跳过，如本地 laya-onnx / OpenAI Decisions）。
   * 未知子键、非法档位在加载期拒绝（写了就要生效）。
   */
  decision_state?: {
    gate?: (typeof DECISION_STATE_GATES)[number];
    context?: (typeof DECISION_STATE_CONTEXTS)[number];
  };
}

export function validatePolicyExtras(pol: Record<string, unknown>, p: string[]): void {
  const sf = pol["surface"];

  if (sf !== undefined) {
    if (!isDict(sf)) {
      p.push("policy.surface: must be an object { native_activation?: \"window\" | \"resolve\" | \"off\" }");
    } else {
      for (const k of Object.keys(sf)) {
        if (k !== "native_activation" && !k.startsWith("_")) {
          p.push(`policy.surface.${k}: unknown key (known: native_activation)`);
        }
      }
      const na = sf["native_activation"];
      if (na !== undefined && na !== "window" && na !== "resolve" && na !== "off") {
        p.push('policy.surface.native_activation: must be one of "window" | "resolve" | "off"');
      }
    }
  }

  // S1 状态层：两个新键同样在加载期响亮拒绝（未知键逻辑不变，已知面只增）。
  const dp = pol["done_preheld"];

  if (dp !== undefined && dp !== "warn" && dp !== "fail" && dp !== "allow") {
    p.push('policy.done_preheld: must be one of "warn" | "fail" | "allow"');
  }

  // P0-E：done_guard 档位（缺省 warn = 只记录；fail 才把 false_done 变成结构化停因）。
  const dg = pol["done_guard"];

  if (dg !== undefined && dg !== "warn" && dg !== "fail") {
    p.push('policy.done_guard: must be one of "warn" | "fail"');
  }

  const er = pol["effect_readback"];

  if (er !== undefined) {
    if (!isDict(er)) {
      p.push("policy.effect_readback: must be an object { fill?: boolean, set_range?: boolean }");
    } else {
      for (const k of Object.keys(er)) {
        if (k !== "fill" && k !== "set_range" && !k.startsWith("_")) {
          p.push(`policy.effect_readback.${k}: unknown key (known: fill, set_range)`);
        }
      }
      for (const k of ["fill", "set_range"]) {
        if (er[k] !== undefined && typeof er[k] !== "boolean") {
          p.push(`policy.effect_readback.${k}: must be a boolean`);
        }
      }
    }
  }

  // S2 稳定门：`"off"` 或 `{ quiet_ms?, timeout_ms? }`；未知子键/越界值加载期红。
  const st = pol["settle"];

  if (st !== undefined) {
    if (st === "off") {
      // 合法：显式关闭
    } else if (!isDict(st)) {
      p.push('policy.settle: must be "off" or an object { quiet_ms?: int(0-5000), timeout_ms?: int(0-30000) }');
    } else {
      for (const k of Object.keys(st)) {
        if (k !== "quiet_ms" && k !== "timeout_ms" && !k.startsWith("_")) {
          p.push(`policy.settle.${k}: unknown key (known: quiet_ms, timeout_ms)`);
        }
      }
      for (const [k, max] of [["quiet_ms", 5000], ["timeout_ms", 30000]] as const) {
        const value = st[k];
        if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max)) {
          p.push(`policy.settle.${k}: must be an integer in [0, ${max}]`);
        }
      }
    }
  }

  for (const k of ["done_timeout_ms", "done_poll_ms", "pool_ready_timeout_ms", "pool_ready_poll_ms"]) {
    const v = pol[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 60_000)) {
      p.push(`policy.${k}: must be an integer in [0, 60000]`);
    }
  }

  // S5 状态接入决策：{ gate?: "off"|"stable_only", context?: "off"|"delta" }——未知子键/非法档位加载期红。
  const ds = pol["decision_state"];

  if (ds !== undefined) {
    if (!isDict(ds)) {
      p.push("policy.decision_state: must be an object { gate?: \"off\"|\"stable_only\", "
        + "context?: \"off\"|\"delta\" }");
    } else {
      for (const k of Object.keys(ds)) {
        if (k !== "gate" && k !== "context" && !k.startsWith("_")) {
          p.push(`policy.decision_state.${k}: unknown key (known: gate, context)`);
        }
      }
      const gate = ds["gate"];
      if (gate !== undefined && !(DECISION_STATE_GATES as readonly string[]).includes(String(gate))) {
        p.push(`policy.decision_state.gate: must be one of ${DECISION_STATE_GATES.join(" | ")}`);
      }
      const ctx = ds["context"];
      if (ctx !== undefined && !(DECISION_STATE_CONTEXTS as readonly string[]).includes(String(ctx))) {
        p.push(`policy.decision_state.context: must be one of ${DECISION_STATE_CONTEXTS.join(" | ")}`);
      }
    }
  }
}
