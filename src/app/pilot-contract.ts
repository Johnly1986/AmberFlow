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
 * 停因交接块（PW1 冻结面）：pilot 停止时向 Agent 投影的结构化现场。
 * 借 intervention 合同的证据形状（why_stuck / what_would_unblock），不接 rescue 通道。
 */
export interface PilotHandoff {
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
   * 低置信模型票（可选，≤6；**无则键不出现**）。纯 evidence-only：只报票面事实，
   * 不判错、不阻断、不新增停因。必须放顶层而不是 `why_stuck.evidence`——桥面整体丢弃
   * evidence（只投影交接块白名单字段），只有顶层才到得了 Agent 面前。
   */
  weak_picks?: WeakPick[];
  /**
   * 结束态校验声明（显式 fact）：`null` = 本 run **没有声明完成信号**，结束态**未被验证**
   * （`budget_exceeded`/`needs_value` 不是"做完了"）；有声明时是有界摘要。与 `stop_code`
   * 分工：`stop_code` 说停在哪，本字段说"有没有可校验的完成真值"。
   */
  final_signal?: null | string;
}

/**
 * 低置信模型票的票面事实（`PilotHandoff.weak_picks`）。
 * 只收 **model** 票且 `conf < DEFAULT_CONF_FLOOR`（全局缺省 0.25）：这是"这一票低于文档
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
  /** 导航信封（缺省从 --url 推断）。 */
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
  /** 置信闸门覆盖（CLI --conf-floor > provider 自报 floor > 0.25 缺省）。 */
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
