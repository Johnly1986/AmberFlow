/**
 * `amber pilot` 的**契约面**（选项/停因闭集/兜底指令闭集/交接块类型，PW1+PW2）。
 *
 * 纪律（docs/PILOTED_WALKTHROUGH_PLAN.md §5 红线的类型化）：
 *   - 模型只投票不生成：驾驶问句走 `mw.pickProposal`（池内闭集 ref），动作类型由
 *     affordance 族判定；这里不存在「自由文本动作」类型。
 *   - 兜底触发确定性：停因全部是引擎既有停因码的确定性判定，模型不能自请兜底。
 *   - 完成只认信号：`final_signal_held` 只有 `checkSignal` 成立才成立；产物恒带
 *     `pilot:true`，不冒充 run 结论。
 *   - 值不猜：`needs_value` 停 → 只接受 Agent 兜底显式给值（`resume.value`）或
 *     预声明 `--slots`；两袋解析与 run 同一套（values → slots）。
 *
 * 零新 stopCode：下表全部来自引擎既有停因（见 executor/actOnce 的返回面），
 * 只有 `final_signal_held` 是 pilot 收尾语义（正因，不是失败）。
 */
// 会话注入 seam 的类型面走 type-only import：契约叶子不得因这一字段把执行器/决策/浏览器
// 那一串运行期模块拖进加载图（pilot-contract 被 CLI/导出面单独加载时也要能零副作用）。
import type { BrowserSession } from "../engine/executor.ts";
import { DECISION_HISTORY_STEPS, drivingGoalText } from "../engine/decision-goal-text.ts";

/** 驾驶停止原因闭集（引擎既有停因码 + pilot 收尾正因）。 */
export const PILOT_STOP_CODES = [
  "final_signal_held", // 声明的最终信号被 checkSignal 验证成立（正因收尾）
  "budget_exceeded",   // --max-steps 用满（与 run 同名同义）
  "off_task_page",     // 当前 URL 不含发起方声明的 --expect-url（页面漂移的确定性停因）
  "host_not_allowed",  // 当前 URL 越出 hosts 信封（与 run 面 hostGate / session 同一判定）
  "unreachable",       // 落在 Chrome 错误页且原文是连接/DNS/超时类（站点此刻不可达，不是越界）
  "config_error",      // 导航失败的其余归因（端口被拒/畸形 URL/原文不可得）——改声明，不重试
  "low_confidence",    // 模型 pick 低于闸门且 reobserve 更宽后仍低（run 同序）
  "target_ambiguous",  // 解析命中多个不同候选（run 命令步同一歧义谓词）
  "needs_value",       // fill/select 决策步缺值（绝不猜；Agent 兜底给值）
  "stuck_inert",       // 连续动作无变化（anti-repeat 同参数口径）
  "no_model_runtime",  // rules-only 环境需要模型选点（如实停，不装会抛的 runtime）
  "browser_dead",      // 页面/浏览器已死（isDeadPageError 同判据）
] as const;
export type PilotStopCode = (typeof PILOT_STOP_CODES)[number];

/**
 * Agent 兜底指令闭集（stdin JSONL；观察类指令复用 session 请求面）。形状：
 *   resume { hint?, value?, target?, skip? }（value 对象 = 多槽 k:v；字符串 = 单值，键序
 *     target → needs_value 记录的目标键 → "resumed"；带 hint 时值跟着 hint 目标走）｜
 *   redirect { url? | goal? }（步史/禁选清段重新累计，预算不清零）｜
 *   finish { signal }（或复用预声明的 --final-signal；checkSignal 验证成立才记 held）｜
 *   abort {}。
 */
export const PILOT_AGENT_COMMANDS = ["resume", "redirect", "finish", "abort"] as const;
export type PilotAgentCommand = (typeof PILOT_AGENT_COMMANDS)[number];

/**
 * agent 驾驶模式的步间等待标记（不是停因）：drive() 返回它 = 本步无 hint 待选，
 * 已投影 `step_request` 候选、在等 Agent 的 `resume{hint}` 点名（零模型票）。
 */
export const PILOT_AWAIT_PICK = "await_pick";

/**
 * `low_confidence` 停因背后的三种处境（闭集，单源 = `pilot-evidence` 的 `lowConfidenceKindOf`）。
 *
 * 同一个码的处置方向相反：池里没有候选要查抽取/等渲染，全被排除要查为什么都被排除，
 * 只有「有可用候选、模型没把握」才该调题面。
 */
export const LOW_CONFIDENCE_KINDS = ["observation-empty", "observation-all-forbidden", "model-unsure"] as const;
export type LowConfidenceKind = (typeof LOW_CONFIDENCE_KINDS)[number];

/**
 * 被 hosts 信封排除出解析面的子 frame（**显式现场事实**，不是推断）：`index` 是池内真实
 * frame 下标（排除只影响解析面，不重编号），`origin` 是它的 origin。
 */
export interface FrameExclusion {
  origin: string;
  index: number;
}

/**
 * 观测体检事实（`low_confidence` 三义分类的取数口，全部取自当场读数而非推断）：
 * `pool_size = 0` 与 `forbidden >= pool_size` 是两种"根本没什么可问"，与"模型看过可用候选
 * 仍不确定"处置方向相反。
 */
export interface ObservationFacts {
  pool_size: number;
  /** 被禁选/已证明无效的候选数（含本轮与账本累积）。 */
  forbidden: number;
  /** 池内空标签候选数（渲染兜底前的读数；有身份字段的行仍可能可读）。 */
  empty_labels: number;
}

/**
 * 模型**显式弃权**的事实（看过多少候选之后说都不行）：唯一能把
 * 「模型看着 N 个候选说不行」与「引擎根本没拿到选择」分开的取数口——两者同落
 * `low_confidence`，没有它摘要可能对第二种说"该调题面"，方向是错的。
 */
export interface ModelAbstainFacts {
  /** 本轮驾驶池的候选数（与 `ObservationFacts.pool_size` 同一份读数）。 */
  pool_size: number;
  /** 本轮决策询问次数（含低置信宽扫重问）。 */
  asks: number;
}

/**
 * 停因专属的现场事实（**只在对应停因出现**）：同一个对象既进 `why_stuck.evidence`，
 * 也展开进交接块顶层。桥面整体丢弃 evidence（只投影交接块白名单字段），只放 evidence
 * 等于 Agent 永远读不到——而这几项恰是分辨同码不同处境的判据。
 */
export interface PilotHandoffStopFacts {
  /** 观测体检计数（仅 `low_confidence`）：档位在 `low_confidence_kind`，计数在这里才能核对。 */
  observation?: ObservationFacts;
  /** 模型显式弃权（仅 `low_confidence` 且真弃权）。 */
  model_abstain?: ModelAbstainFacts;
  /** 导航失败原文（仅 `unreachable`/`config_error`）：错误页事后读不到，这是唯一原文来源。 */
  nav_error?: string;
  /** 走出 hosts 信封的落地 URL（仅 `host_not_allowed`）：「该加 host 还是换入口」的唯一判据。 */
  off_envelope?: string;
}

/**
 * 未决值需求的交接投影（`PilotHandoff.needs_value`）：仅 `needs_value` 停因出现。
 * 只带目标/键/ref，**不带值**——值是 Agent 显式给定的，引擎不猜也不回显。
 */
export interface HandoffValueNeed {
  /** 目标描述（可读提示；与驾驶步 `target` 同口径）。 */
  target: string;
  /** 值袋键（`resume.value` 字符串形式的确定性绑定键）。 */
  key: string;
  /** 池内 ref（证据定位，不是动作地址）。 */
  ref: string;
}

/**
 * 落空的 resume 点名（`PilotHandoff.resume_hint`）：仅 `missed` 为真时出现。
 * `missed` 是字面量类型：出现即落空，读方不必再判第二种取值。
 */
export interface HandoffMissedHint {
  /** 落空时 Agent 给的点名原文（不含值）。 */
  hint: string;
  /** 恒 `true`（本键的存在本身就是"上次点名落空了"的证据）。 */
  missed: true;
}

/**
 * 停因交接块（PW1 冻结面）：pilot 停止时向 Agent 投影的结构化现场。
 * 借 intervention 合同的证据形状（why_stuck / what_would_unblock），不接 rescue 通道。
 * 可选事实继承自 {@link PilotHandoffStopFacts}（停因专属、只在对应停因出现）；现场定位键
 * （{@link HandoffValueNeed} / {@link HandoffMissedHint} / `expect_url`）同样只在对应情形出现。
 */
export interface PilotHandoff extends PilotHandoffStopFacts {
  /** 停因闭集（`PilotStopCode`）。 */
  stop_code: PilotStopCode;
  /** 停在第几驾驶步（0-based；budget_exceeded 时 = max_steps）。 */
  step_id: number;
  /** 总目标摘要（发起方给的 goal 的有界投影，≤200 字符）。 */
  goal_digest: string;
  /** 卡住原因的一句话摘要（≤400 字符）。 */
  why_stuck: { summary: string; evidence: Record<string, unknown> };
  /** 「怎样解锁」的建议闭集（≤3 条，按停因确定性生成，不是模型建议）。 */
  what_would_unblock: string[];
  /** 现场证据引用（四件套落盘路径：截图 / DOM / 池快照 / observe 明细；各自独立失败独立缺字段）。 */
  evidence_refs: {
    screenshot?: string;
    dom?: string;
    pool_snapshot?: string;
    observe?: string;
  };
  /** 停驶页 URL（Agent resume/redirect 的现场锚点）。 */
  url: string;
  /**
   * 任务页期望 URL 子串（可选；**已声明时出现，任何停因**）：Agent 拿它核对「偏到哪去了」。
   * 顶层字段——`why_stuck.evidence` 有同一份原始值，但桥面整体丢弃 evidence；而
   * `off_task_page` 的解锁建议正说「偏离 --expect-url」，不给值就无法判断偏离了多少。
   */
  expect_url?: string;
  /**
   * 未决值需求（可选；**仅 `needs_value` 停因出现**）：`{target,key,ref}`。
   * 顶层字段——桥面丢弃 evidence，只读 `what_would_unblock` 的建议文本就只剩键名可猜，
   * `target`/`ref` 全丢（Agent 无从核对停驶现场是哪个控件要值）。
   */
  needs_value?: HandoffValueNeed;
  /**
   * 落空的 resume 点名（可选；**仅落空后第一次交接出现**）：`{hint,missed:true}`。
   * 顶层字段——"你上次的点名落空了"正是 Agent 被再问的原因，只在 evidence 里等于不可见。
   */
  resume_hint?: HandoffMissedHint;
  /**
   * 被 hosts 信封排除的子 frame（可选，无排除则键不出现）：`[{origin,index}]`。
   * 顶层字段——`why_stuck.evidence` 有同一份原始值，但桥面整体丢弃 evidence；
   * `what_would_unblock` 已按它给出「把 origin 加进 hosts」的建议，Agent 需要同一份结构化事实。
   */
  frames_excluded?: FrameExclusion[];
  /**
   * 低置信模型票（可选，≤6；**无则键不出现**）。纯 evidence-only：只报票面事实，
   * 不判错、不阻断、不新增停因。必须放顶层而不是 `why_stuck.evidence`——桥面整体丢弃
   * evidence（只投影交接块白名单字段），只有顶层才到得了 Agent 面前。
   */
  weak_picks?: WeakPick[];
  /**
   * 低置信三义分类（`LOW_CONFIDENCE_KINDS`）：**仅 `low_confidence` 停因时出现**，
   * 其它停因缺键（旧形状逐字节不变）。必须放顶层而不是 `why_stuck.evidence`——桥面整体
   * 丢弃 evidence（只投影交接块白名单字段），只有顶层才到得了 Agent 面前。
   * 同一档位的人话处置方向写在 `why_stuck.summary`（`low_confidence` 前缀之后）。
   */
  low_confidence_kind?: LowConfidenceKind;
  /**
   * 结束态校验声明（显式 fact）：`null` = 本 run **没有声明完成信号**，结束态**未被验证**
   * （`budget_exceeded`/`needs_value` 不是"做完了"）；有声明时是有界摘要。与 `stop_code`
   * 分工：`stop_code` 说停在哪，本字段说"有没有可校验的完成真值"。
   */
  final_signal?: null | string;
}

/**
 * 低置信模型票的票面事实（`PilotHandoff.weak_picks`）。
 * 只收 **model** 票且 `conf < DEFAULT_CONF_FLOOR`（全局缺省，单源）：这是"这一票低于文档
 * 默认刻度却过了闸"的可复现解释——闸门刻度可被 provider 自报/CLI 下调，票面本身不撒谎。
 */
export interface WeakPick {
  /** 1-based 驾驶步号（与 `PilotHandoff.step_id`/轨迹 `i+1` 对齐）。 */
  step: number;
  /** 选中的目标（≤40 字，与驾驶轨迹同口径）。 */
  target: string;
  /** 模型票置信度原值（0–1）。 */
  conf: number;
  /** 票来源；闭集为未来规则票对照保留，当前 weak_picks 只会有 "model"。 */
  picked_by: "rule" | "model";
}

/** 驾驶步的轨迹行（`--record` JSONL；export 的输入）。 */
export interface PilotStepRecord {
  i: number;
  ts: string;
  type: "drive";
  /** 驾驶问句的目标（总目标 + 有界步史摘要）。 */
  goal: string;
  /** 本步选择来源：rule = 规则档命中（零模型）；model = 决策 pick。 */
  picked_by: "rule" | "model";
  /** 模型票（picked_by=model 才有；闭集 ref + conf + shape + 轮次来源）。 */
  pick?: {
    ref: string;
    conf: number;
    shape: string;
    pool_size: number;
    /** 票来自首轮问句还是低置信后的宽扫重问（run 4d 的 reobserve 同款）。 */
    via?: "ask" | "reobserve";
  };
  /** 执行事实（actOnce 同口径）。 */
  action: {
    op: "click" | "check" | "fill" | "select";
    target: string;
    ref: string | null;
    how: string | null;
    ok: boolean;
    changed: boolean;
    elapsed_ms: number;
    [k: string]: unknown;
  };
  /** 动作前 URL（before/after 供信号归纳）。 */
  url_before: string;
  /** 动作后 URL（含导航）。 */
  url_after: string;
}

/** 一次交接的轨迹行（PilotHandoff 的落盘形态 + 兜底指令回执）。 */
export interface PilotHandoffRecord {
  i: number;
  ts: string;
  type: "handoff";
  handoff: PilotHandoff;
  /** Agent 用哪条指令应答（null = 尚未应答，进程收尾时遗留）。 */
  resolved_by: PilotAgentCommand | null;
}

/** 一条兜底指令的轨迹行。 */
export interface PilotCommandRecord {
  i: number;
  ts: string;
  type: "command";
  command: PilotAgentCommand;
  args: Record<string, unknown>;
}

export type PilotRecordLine = PilotStepRecord | PilotHandoffRecord | PilotCommandRecord;

/** `amber pilot` 的选项面（CLI 解析后传入；缺省值见 `PILOT_DEFAULTS`）。 */
export interface PilotOptions {
  /** 入口页（必填；与 session --url 同语义，自动 open）。 */
  url: string;
  /** 总目标（发起方给的一句话；驾驶问句的 goal 底座）。 */
  goal: string;
  /**
   * 导航信封（单一来源 = 声明本身；未声明/`null`/`[]`/全空串 = 不设防，**不**按 `url` 推断）。
   * 空串条目在此归一并剔除。CLI `amber session --url` 的面由 CLI 的 `inferHosts` 显式声明
   * 后传入，所以那条默认路径的信封不受这里的「未声明」语义影响。
   */
  hosts?: string[] | null;
  /** 最终信号声明（缺省 = 无信号收尾：预算内推进、连续 inert 即停）。 */
  finalSignal?: Record<string, unknown> | null;
  /**
   * 任务页**期望 URL 子串**（可选，缺省 null = 不判）。
   * 每轮驾驶前检查当前 URL 是否包含它；不包含即确定性停 `off_task_page` 并交接。
   * 它是发起方的任务约束（不是模型裁量）：导航漂移（如从 /maps 漂到 /preferences）不得
   * 默默继续烧预算。裁剪在归因面：只用于守卫与题面提示，不参与 hint/候选解析。
   */
  expectUrl?: string | null;
  /** 驾驶步预算（缺省 12；与 run --max-steps 同名同义）。 */
  maxSteps?: number;
  /** 置信闸门覆盖（CLI --conf-floor > provider 自报 floor > 全局缺省 `DEFAULT_CONF_FLOOR`）。 */
  confFloor?: number;
  /** 预声明槽位值（决策 fill/select 的值袋；缺省空）。 */
  slots?: Record<string, string>;
  /** Agent 兜底指令文件（非 TTY 剧本；对齐 session --input 先例）。 */
  inputFile?: string | null;
  /** 证据/轨迹落点（缺省 $AMBERFLOW_HOME/pilot/<runId>）。 */
  outDir?: string | null;
  /** 驾驶轨迹 JSONL 落点（给了才写；缺省 = outDir/pilot-trace.jsonl）。 */
  record?: string | null;
  /** 驾驶者（缺省 model = 决策模型投票；agent = 每步等 Agent `resume{hint}` 点名，零模型票——消融对照臂）。 */
  driver?: "model" | "agent";
  /** 无人兜底时的静默上限（缺省 SESSION_IDLE_TIMEOUT_MS；0 = 不限）。 */
  idleTimeoutMs?: number;
  headful?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  /**
   * **attach 会话注入 seam（内部；CLI 无对应 flag）**：由宿主提供已存在的浏览器会话，
   * pilot 在宿主页面上驾驶而不是自建浏览器。三字段共同表达 attach 模式；全缺省 = 既有
   * 一次性 pilot（自建会话 → 导航入口页 → 自己关浏览器）行为逐字节不变。
   */
  /** 注入会话工厂：给了就直接用（不打印 starting browser、不承担启动失败语义）。 */
  sessionFactory?: () => Promise<BrowserSession>;
  /** 浏览器所有权：false = 宿主拥有（`closeBrowser()` no-op）；缺省 true。 */
  ownsSession?: boolean;
  /** 起步导航：true = 不 goto / 不 settle，直接驾驶当前页；缺省 false。 */
  skipStartNavigation?: boolean;
  env?: NodeJS.ProcessEnv;
}

export const PILOT_DEFAULT_MAX_STEPS = 12;
/** 连续 inert 判定阈值（与执行器 maxEffectiveRepeats 缺省同源的驾驶面口径）。 */
export const PILOT_INERT_LIMIT = 3;
/** 同一元素（按 esig）被驱动达上限而最终信号仍未成立 = 死目标（run 面 `maxEffectiveRepeats`
 *  缺省同口径的驾驶面版）：到达上限即守停，不再执行——防 toggle/复读形态无声烧预算。 */
export const PILOT_REPEAT_LIMIT = 3;
/** 已走步数摘要上限（驾驶问句里带的已走步数；有界，防题面膨胀）——与 run 面同源常量。 */
export const PILOT_HISTORY_STEPS = DECISION_HISTORY_STEPS;

/** 驾驶问句的 goal 底座（总目标 + 当前页/期望页 + 有界步史；实现单源在引擎 `decision-goal-text`）。 */
export { drivingGoalText };

/** 解锁建议的可选现场事实（确定性生成用；不是模型建议，也不进 hint 解析面）。 */
export interface PilotUnblockContext {
  /** 被 hosts 信封排除的子 frame origins（handoff 证据同源）。 */
  framesExcluded?: readonly string[];
  /** 未决值需求的值袋键（needs_value 停时由驾驶面记录；用于生成可照抄的 resume 形状）。 */
  needsValueKey?: string;
  /** 未决值需求的目标描述（可读提示用；不参与解析）。 */
  needsValueTarget?: string;
}

/** 停因 → 基础解锁建议闭集（确定性生成；按停因查表，不是模型建议）。 */
function baseUnblockHints(stop: PilotStopCode, ctx?: PilotUnblockContext): string[] {
  switch (stop) {
    case "low_confidence":
      return [
        "resume 带 hint 点名更精确的目标（hint 唯一命中即确定性执行，不花模型）",
        "redirect 换更具体的总目标后重驾驶",
      ];
    case "target_ambiguous":
      return [
        "resume 带 hint 收窄（闭集：#id | tag[attr=value] | bare-token 等既有 hint 语法）",
        "重新 observe 看候选证据后点名",
      ];
    case "needs_value": {
      // 已知目标键时给可照抄的形状：Agent 照抄即确定性绑定到产生 needs_value 的目标；
      // 键未知（无记录/异常路径）退回无键建议，绝不发明键。
      const key = ctx?.needsValueKey ?? "";
      const target = ctx?.needsValueTarget ?? "";
      const named = key === ""
        ? "resume 带 value 显式给值（值来自 Agent = 显式给定，引擎绝不猜）"
        : `resume 带 value：{"${key}":"<值>"}${target === "" ? "" : `（目标：${target}）`}（值来自 Agent，引擎绝不猜）`;
      return [named, "起会话时预声明 --slots k=v"];
    }
    case "stuck_inert":
      return [
        "resume 带 hint 换目标（连续无变化的元素已被禁）",
        "redirect 换入口或目标",
      ];
    case "no_model_runtime":
      return [
        "amber doctor 体检决策源；模型产物不齐时 npm run model:fetch",
        "resume 带 hint 走确定性解析（规则档不花模型）",
      ];
    case "budget_exceeded":
      return [
        "起新 pilot 并增大 --max-steps（预算用尽即终态：本 run 不再接受 resume/redirect）",
        "把这次已走轨迹（record）当输入：换更小的 --goal 或先修入口页",
      ];
    case "off_task_page":
      return [
        "redirect 回任务页（当前 URL 已偏离发起方声明的 --expect-url）",
        "核对 --expect-url 与入口 URL：只写稳定的路径片段（如 /maps），不要写 query",
      ];
    case "host_not_allowed":
      return [
        "redirect 回信封内的页面（驾驶已走出 hosts：登录/第三方跳转不作为驾驶面）",
        "确认这一步导航是任务需要的：需要就把它加进 hosts，不需要就别点那个入口",
      ];
    case "unreachable":
      return [
        "先验证站点可达（curl/fetch）：不可达就等站点恢复或换入口，不是改 hosts/声明",
        "可达则放宽 --timeout 或稍后重试（交接块顶层的 nav_error 带浏览器原文 net::ERR_*）",
      ];
    case "config_error":
      return [
        "核对交接块顶层的 nav_error：端口被拒（ERR_UNSAFE_PORT）/URL 畸形 = 改入口 URL，不要重试",
        "确认声明的 hosts 与实际入口一致后 redirect 回可用页面",
      ];
    case "browser_dead":
      return ["redirect 重开入口页（浏览器已死，现场不可恢复）"];
    case "final_signal_held":
      return []; // 正因收尾，无需解锁
  }
}

/**
 * 停因 → 解锁建议闭集（确定性生成；≤3 条）。
 *
 * frame 排除只在「候选面可能因此残缺」的停因上当根因级解锁项（low_confidence /
 * target_ambiguous / needs_value / stuck_inert）——budget_exceeded 是已走了 N 步的终态，
 * 把 frame 建议放它前面会误导（实测 Maps 页常驻一个与任务无关的 ogs launcher frame）。
 */
export function unblockHintsFor(stop: PilotStopCode, ctx?: PilotUnblockContext): string[] {
  // 走查实测：目标在跨源 iframe（ogs.google.com 九宫格）时，动作池里根本没有候选——
  // 只看 stop_code 会误判成"模型选不准"。把 frame 排除事实变成可执行的 envelope 建议。
  const frameStop = stop === "low_confidence" || stop === "target_ambiguous"
    || stop === "needs_value" || stop === "stuck_inert";
  const frames = frameStop
    ? [...new Set((ctx?.framesExcluded ?? []).filter((o) => o !== ""))].slice(0, 2)
    : [];
  const frameHint = frames.length === 0
    ? [] : [`目标可能在未声明的 iframe 内：把 ${frames.join(", ")} 加入 hosts（--host / hosts 参数）后重试`];
  return [...frameHint, ...baseUnblockHints(stop, ctx)].slice(0, 3);
}

/** 退出码：0 = final_signal_held 或干净收尾 / 1 = browser_dead / 3 = 被挡住（停因待兜底）。 */
export function pilotExitCode(stop: PilotStopCode): number {
  if (stop === "final_signal_held") return 0;
  if (stop === "browser_dead") return 1;
  return 3;
}

/** 形状判断（契约叶子不引入运行期 helper 模块，见文件头注释）。 */
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 一次性校验 pilot 选项面（CLI 入口先跑；非法 = 结构化错误，不猜）。 */
export function validatePilotOptions(opts: PilotOptions): string | null {
  if (typeof opts.url !== "string" || opts.url.trim() === "") return "pilot needs a non-empty --url";
  try { new URL(opts.url); } catch { return `pilot --url is not a valid URL: ${JSON.stringify(opts.url)}`; }
  if (typeof opts.goal !== "string" || opts.goal.trim() === "") return "pilot needs a non-empty --goal";
  if (opts.finalSignal != null && !isObj(opts.finalSignal)) return "pilot --final-signal must be a JSON object when present";
  if (opts.maxSteps !== undefined && (!Number.isInteger(opts.maxSteps) || opts.maxSteps! < 1 || opts.maxSteps! > 200)) {
    return "pilot --max-steps must be an integer in [1, 200]";
  }
  if (opts.confFloor !== undefined && (typeof opts.confFloor !== "number" || opts.confFloor! < 0 || opts.confFloor! > 1)) {
    return "pilot --conf-floor must be a number in [0, 1]";
  }
  if (opts.driver !== undefined && opts.driver !== "model" && opts.driver !== "agent") {
    return "pilot --driver must be model|agent";
  }
  if (opts.expectUrl !== undefined && opts.expectUrl !== null
    && (typeof opts.expectUrl !== "string" || opts.expectUrl.trim() === "")) {
    return "pilot --expect-url must be a non-empty string when present";
  }
  return null;
}
