/**
 * session / pilot 协议**闭集与边界的唯一数据表**（L0，纯数据：只有 type 与 const）。
 *
 * 为什么要有它：同一批闭集与数值界原先在引擎请求线闭集、桥工具 op 表、工具 schema 的
 * enum、逐 op 形状校验四处各写一份，且四面并不对称——引擎请求集有协议内部 op `mark`，
 * 桥另有只在本地处理的 `list`；act op、drive 的 cmd/driver、max_steps 与 idle 界也是多写。
 * 任一处漏改就是「模型能传但引擎不认」或「引擎支持但桥推不出」的静默漂移。
 *
 * 桥包自带 tsconfig（`rootDir=src`）不能 import 仓库 `src`，所以桥只收
 * `tools/session-contract-gen.ts` 从本表生成的确定性投影
 * `integrations/dsh-bridge/src/session-contract.generated.ts`（check in，`--check` 判过期）。
 * 生成器同时把本表与引擎契约 `src/app/session-runtime-contract.ts` 交叉校验（请求 type 集、
 * act op 集、drive 的 driver/cmd 闭集与 max_steps / note 界、缺省 idle），两侧不等即红；
 * 因此本表是桥面闭集的**单源**，并被钉在引擎实现上。
 *
 * 改一个值 = 改本表 + `tools/session-contract-gen.ts --write`；引擎侧也变时同步改
 * `src/app/session-runtime-contract.ts`（生成器会拦住漏改）。生成物禁止手改。
 *
 * 纪律：本模块只放数据。判定/校验逻辑留在消费侧（引擎、桥、工具 schema 各自组装）。
 */
import { SESSION_IDLE_TIMEOUT_MS } from "./tuning.ts";

/* ------------------------------------------------------------ 请求 op（引擎协议 ↔ 桥工具面） */

/**
 * 引擎 session JSONL 请求线的 `type` 闭集（引擎序；唯一出处 = `SESSION_REQUEST_TYPES`）。
 *
 * 桥请求线使用其中除 `mark` 外的条目；`mark` 见 {@link SESSION_INTERNAL_OPS}。
 */
export const SESSION_ENGINE_REQUEST_TYPES = [
  "open", "goto", "observe", "act", "read", "extract", "waitFor", "signal", "snapshot", "mark", "tab",
  "drive", "driveCommand", "driveStatus", "driveClose", "close",
] as const;
export type SessionEngineRequestType = (typeof SESSION_ENGINE_REQUEST_TYPES)[number];

/** 引擎支持、桥工具面不暴露的协议内部 op（`mark` = 人工标记写轨迹）。 */
export const SESSION_INTERNAL_OPS = ["mark"] as const;

/**
 * 桥工具 `op` 闭集（桥序；工具 schema 的 enum、op 校验报错文案、`op:"list"` 语义共用）。
 *
 * 其中 `list` 只在桥本地枚举会话、不进引擎请求线（见 {@link SESSION_BRIDGE_ONLY_OPS}）。
 */
export const SESSION_BRIDGE_OPS = [
  "open", "goto", "observe", "act", "read", "extract", "signal", "wait_for", "snapshot", "tab",
  "drive", "drive_command", "drive_status", "drive_close", "close", "list",
] as const;
export type SessionBridgeOp = (typeof SESSION_BRIDGE_OPS)[number];

/** 桥本地处理、不进引擎请求线的 op。 */
export const SESSION_BRIDGE_ONLY_OPS = ["list"] as const;

/**
 * 桥 op → 引擎请求 `type` 的显式映射：**只登记两侧名字不同的条目**，未登记的桥 op 与引擎
 * type 同名（`open`/`goto`/`observe`/…）。桥发请求时经生成物里的映射取字面量，避免逐 op
 * 手写 wire 名。
 */
export const SESSION_OP_ENGINE_TYPE = {
  wait_for: "waitFor",
  drive_command: "driveCommand",
  drive_status: "driveStatus",
  drive_close: "driveClose",
} as const;

/* ------------------------------------------------------------ act / drive / tab 闭集 */

/** act op 闭集（与引擎执行器的 authoring MVP 能力面一致）。 */
export const SESSION_ACT_OPS = ["click", "check", "fill", "select", "hover", "scroll", "set_range"] as const;
export type SessionActOp = (typeof SESSION_ACT_OPS)[number];

/** drive 的驾驶者闭集：model = 每步决策模型投票；agent = 每步等兜底指令点名（零模型票）。 */
export const SESSION_DRIVE_DRIVERS = ["model", "agent"] as const;
export type SessionDriveDriver = (typeof SESSION_DRIVE_DRIVERS)[number];

/** drive_command 的兜底指令闭集（与 pilot 面同一套指令）。 */
export const SESSION_DRIVE_COMMANDS = ["resume", "redirect", "finish", "abort"] as const;
export type SessionDriveCommand = (typeof SESSION_DRIVE_COMMANDS)[number];

/** `drive` 请求的形状边界。`maxStepsMin/Max` 与引擎 `SESSION_DRIVE_MAX_STEPS`、pilot `--max-steps` 同口径。 */
export const SESSION_DRIVE_LIMITS = {
  maxStepsMin: 1,
  maxStepsMax: 200,
  confFloorMin: 0,
  confFloorMax: 1,
  /** `drive_command.note` 上界（引擎 `SESSION_DRIVE_NOTE_MAX_CHARS`）。 */
  noteMaxChars: 300,
} as const;

/** tab op 的动作闭集；缺省 `list`。 */
export const SESSION_TAB_ACTIONS = ["list", "switch"] as const;
/** open 的有头窗口尺寸闭集（仅 headful 会话可用）。 */
export const SESSION_WINDOW_MODES = ["maximized", "fullscreen"] as const;
/** act 的歧义策略闭集；缺省 `fail`（零动作 + 结构化 target_ambiguous）。 */
export const SESSION_AMBIGUITY_MODES = ["fail", "act"] as const;
/** act `scroll` 的 `to` 闭集。 */
export const SESSION_SCROLL_TARGETS = ["bottom", "top", "page"] as const;
/** read 的 `what` 闭集。 */
export const SESSION_READ_WHATS = ["text", "value", "count", "attr"] as const;

/* ------------------------------------------------------------ idle / 并发 / 超时界 */

/**
 * 会话 idle TTL 的全部边界（双层 idle：桥管理器 TTL + 引擎子进程孤儿兜底）。
 *
 * - `defaultMs` 同时是引擎 `--idle-timeout-ms` 缺省值与桥管理器缺省（同值同义）；
 * - 桥显式 `idle_timeout_ms` 只接受 `0` 或 ≥ `minExplicitMs` 的整数（`0` = 不限）；
 * - 引擎 CLI 的接受区间是 `[engineCliMinMs, engineCliMaxMs]`；
 * - 显式 ttl > 0 时下发给子进程的孤儿兜底 = clamp(`orphanFactor`×ttl, `orphanDefaultMs`, `orphanCapMs`)；
 * - 部署配置键 `sessionIdleMs` 的接受区间是 `[configMinMs, configMaxMs]`。
 */
export const SESSION_IDLE = {
  defaultMs: SESSION_IDLE_TIMEOUT_MS,
  minExplicitMs: 1_000,
  engineCliMinMs: 0,
  engineCliMaxMs: 24 * 60 * 60 * 1000,
  orphanDefaultMs: 2 * SESSION_IDLE_TIMEOUT_MS,
  orphanFactor: 2,
  orphanCapMs: 24 * 60 * 60 * 1000,
  configMinMs: 1_000,
  configMaxMs: 60 * 60 * 1000,
} as const;

/** 桥会话管理器的在册上限与部署配置 `maxSessions` 接受区间。 */
export const SESSION_CONCURRENCY = {
  defaultMaxSessions: 2,
  configMinSessions: 1,
  configMaxSessions: 8,
} as const;

/** 桥会话管理器的读超时缺省与工具面数值界（goto / wait_for）。 */
export const SESSION_TIMEOUTS = {
  /** 单 op 读超时缺省。 */
  opDefaultMs: 60_000,
  /** `open` 读超时缺省（首次启动浏览器 + 导航）。 */
  openDefaultMs: 120_000,
  /** idle reaper 扫描间隔缺省。 */
  reaperDefaultMs: 5_000,
  /** 管理器对 op/open 读超时的下界（低于它的配置值被抬到该值）。 */
  timeoutFloorMs: 1_000,
  /** reaper 间隔下界（测试可调小，但不低于该值）。 */
  reaperFloorMs: 50,
  gotoMinMs: 1,
  gotoMaxMs: 120_000,
  waitMinMs: 0,
  waitMaxMs: 120_000,
  waitDefaultMs: 15_000,
} as const;

/* ------------------------------------------------------ handoff 投影 cap（三层） */

/**
 * 交接块（`PilotHandoff`）经 producer → 引擎 → 桥三层投影后的**字段 × 上限**表。
 *
 * 行 = 交接块字段路径（`[]` = 逐条上限，无 `[]` = 该字段自身；`exposed` = 桥面字段名，
 * `null` = 该字段在桥面整体丢弃）。三列 = 各层对**同一字段**的界：`producer` = pilot
 * 生成时的界，`engine` = 会话响应投影的界，`bridge` = 桥面再投影的界；`null` = 该层不设
 * 界（原样透传或值域天然有界）。字符类与条数类混在同一列，行注释标明单位——
 * 它们都是「同一字段在不同面的上限」，这才是本表要冻结的事实。
 *
 * 逐列出处：引擎列 = `src/app/session-driver.ts` 的 `projectHandoff`/事件投影；桥列 =
 * `BRIDGE_HANDOFF_CAPS` 生成物（消费侧在桥 `session.ts` 的 `driveHandoff`）；
 * `why_stuck.evidence` 只存在于引擎响应（桥面整体丢弃，故 `exposed:null`）——桥不是超集。
 *
 * 改一个值 = 改本表 + `tools/session-contract-gen.ts --write`；生成器会拿引擎投影的
 * 实测行为交叉校验引擎列（见 `tools/session-contract-gen.ts` 的 `checkHandoffCaps`）。
 */
export const SESSION_HANDOFF_CAP_TABLE = [
  // 停因闭集字段：值域有界（`PILOT_STOP_CODES` / 步号），三层都不裁剪。
  { field: "step_id", exposed: "step_id", producer: null, engine: null, bridge: null, note: "步号（整数，值域有界）" },
  { field: "stop_code", exposed: "stop_code", producer: null, engine: null, bridge: null, note: "停因闭集（`PILOT_STOP_CODES`，不裁剪）" },
  // 字符界：goal_digest 200 → 200 → 300。
  { field: "goal_digest", exposed: "goal_digest", bridgeKey: "goalDigestMaxChars", producer: 200, engine: 200, bridge: 300, note: "总目标摘要（字符）" },
  { field: "why_stuck.summary", exposed: "summary", bridgeKey: "summaryMaxChars", producer: null, engine: 400, bridge: 300, note: "卡住原因摘要（字符；producer 由值域拼装）" },
  // 交接证据块：900 是**整块 JSON** 的界（超限退化为键名清单 ≤8）。
  { field: "why_stuck.evidence", exposed: null, producer: null, engine: 900, bridge: null, note: "现场证据块（整块 JSON 字符；桥面丢弃）" },
  { field: "why_stuck.evidence.keys", exposed: null, producer: null, engine: 8, bridge: null, note: "证据超限时的键名清单条数（桥面丢弃）" },
  // 解锁建议：条数 3（producer 闭集生成）→ 3 → 3；每条字符 null → 400 → 200。
  { field: "what_would_unblock", exposed: "what_would_unblock", bridgeKey: "unblockMaxItems", producer: 3, engine: 3, bridge: 3, note: "解锁建议条数（3 = 闭集生成上限）" },
  { field: "what_would_unblock[]", exposed: "what_would_unblock", bridgeKey: "unblockItemMaxChars", producer: null, engine: 400, bridge: 200, note: "单条解锁建议（字符）" },
  // 现场证据引用：四件套各自独立；桥面原样透传（不裁剪）。
  { field: "evidence_refs[]", exposed: "evidence_refs", producer: null, engine: 400, bridge: null, note: "单条落盘路径（字符；桥面不裁剪）" },
  { field: "url", exposed: "url", bridgeKey: "urlMaxChars", producer: null, engine: 200, bridge: 300, note: "停驶页 URL（字符）" },
  { field: "final_signal", exposed: "final_signal", bridgeKey: "finalSignalMaxChars", producer: 200, engine: 400, bridge: 200, note: "结束态声明摘要（字符；`null` 原样透传）" },
  { field: "weak_picks", exposed: "weak_picks", bridgeKey: "weakPicksMax", producer: 6, engine: 6, bridge: 6, note: "低置信票条数" },
  { field: "weak_picks[].target", exposed: "weak_picks", bridgeKey: "weakPickTargetMaxChars", producer: 40, engine: 120, bridge: 120, note: "票面目标文本（字符）" },
  { field: "weak_picks[].picked_by", exposed: "weak_picks", bridgeKey: "weakPickPickedByMaxChars", producer: null, engine: null, bridge: 20, note: "票来源（闭集 `rule|model`，桥面只做有界化）" },
] as const;

/**
 * 会话响应**证据块**的白名单与 cap（桥面 `session.ts` 的五个投影：滚动 / 范围 / 歧义
 * 诊断 / 落空判别 / 宽扫）。每块的 `fields` 是白名单（引擎给了才出现，桥不补键），
 * 数值项是各块字段的上限。
 *
 * `frame_origin` 的引擎界（120）与本批的桥界（60）**有意不同**：桥对候选帧 origin 只做
 * 短标识，对齐引擎界属可见变化，需单独成批。
 */
export const SESSION_EVIDENCE_CAP_TABLE = {
  scroll: {
    bridgeKey: "scroll",
    fields: ["moved", "delta", "scroll", "strategy", "at_bottom"],
    strategies: ["programmatic"],
    note: "滚动实测读数（三件套全在才出现；像素取整非负，无字符界）；strategy 只在非标准滚动器回退时出现，at_bottom 只在已到底时出现",
  },
  range: {
    bridgeKey: "range",
    fields: ["applied", "accurate", "strategy", "achieved", "requested", "target_value", "clamped_from",
      "snapped_to", "handles", "handle_index", "peers", "row_index", "valuetext", "probe"],
    strategies: ["fill", "keyboard", "pointer"],
    probes: ["value_unreadable", "home_ignored", "lattice_unreachable"],
    note: "范围控件实测（strategy/probe 是引擎闭集；数值字段无字符界）",
  },
  ambiguity: {
    bridgeKey: "ambiguity",
    fields: ["ambiguous", "matched_others", "hint_kind", "hint_tier", "hint_suspicious"],
    matchedOthersMax: 3,
    labelMaxChars: 40,
    /** 候选 `frame_origin`：引擎上界 120，桥面带 60（有意更窄，对齐引擎属可见变化）。 */
    frameOriginMaxChars: 60,
    frameOriginEngineMaxChars: 120,
    note: "act 当场歧义旁路（撞词候选 ≤3 行、label ≤40；frame_origin 两层界不同，见字段注释）",
  },
  miss: {
    bridgeKey: "miss",
    fields: ["target", "pool_size", "hint_shape", "hint_len", "settle_timed_out", "settle_waited_ms",
      "rescan", "candidates", "near", "rejected", "shape_problem"],
    candidatesMax: 3,
    nearMax: 3,
    rejectedMax: 2,
    refMaxChars: 16,
    tagMaxChars: 16,
    labelMaxChars: 40,
    whyMaxChars: 40,
    hintShapeMaxChars: 32,
    /**
     * `shape_problem.kind` 的**唯一闭集**（桥按它过滤：引擎新增类别必须同步这里，
     * 否则桥面会静默丢掉诊断，变成「引擎说写法可疑、Agent 看不到原因」）。
     */
    shapeProblemKinds: ["tag-plus-text", "role-word-plus-text", "selector-syntax", "css-attr-operator"],
    note: "落空判别证据（候选/near/rejected 三组各自限行；shape_problem.kind 按闭集过滤）",
  },
  wide: {
    bridgeKey: "wide",
    fields: ["candidates", "window", "pool_size"],
    candidatesMax: 40,
    tagMaxChars: 16,
    labelMaxChars: 40,
    hintMaxChars: 200,
    note: "宽扫回传（带自证 hint 的行优先、组内保持引擎序）",
  },
} as const;

/* ------------------------------------------------------ ElementView 合同常量 */

/**
 * 桥面 ElementView 行合同的全部上限（唯一出处）。生成器把这些值投影成
 * `integrations/dsh-bridge/src/element-view.constants.generated.ts`（check in）。
 *
 * 上限只答"多少"，字段本身（哪一面有、叫什么、能不能当动作地址）见
 * {@link SESSION_ELEMENT_VIEW_FIELDS}——两张表是同一份合同的两个维度，改其一必须同步另一。
 *
 * `note` 是生成物里的 JSDoc：写契约事实（与哪一层的口径同界），不是变更记录。
 * 引擎侧同界由生成器逐项交叉校验（`elementMax` ↔ `observe` 硬上限、`labelMaxChars` ↔
 * `elem-model` 的 full_label、`hintMaxChars` ↔ `ambiguity` 的 hint 界、类名/结构/行上下文
 * ↔ 池抽取 JS 的内嵌常量）。
 *
 * `hintsPerElement` 是**兼容性 cap**：引擎 `suggestHints` 实际最多给 4 条，桥按 6 收集
 * （多出的两条永不会出现）；保留 6 是为了不改变既有输出形状，引擎侧上限才是真界。
 */
export const SESSION_ELEMENT_VIEW_LIMITS = {
  elementDefaultMax: { value: 60, note: "元素行数缺省（inspect/observe 两面一致；CLI inspect 缺省同为 60）" },
  elementMax: { value: 200, note: "元素行数硬上限（引擎 observe 硬上限同界）" },
  hintsPerElement: { value: 6, note: "每元素 hint_candidates 收集上限（兼容性 cap，引擎实际最多 4 条）" },
  hintMaxChars: { value: 200, note: "单条 hint 字符串上限（与引擎歧义证据 hint 界同口径）" },
  labelMaxChars: { value: 200, note: "label 上限（与引擎 full_label 口径同界）" },
  hrefMaxChars: { value: 160, note: "href 展示投影上限（桥侧独立界）" },
  whyNotAdmittedMaxChars: { value: 400, note: "why_not_admitted 诊断文本上限（词边界截断，寻址 token 不切中）" },
  classNamesPerElement: { value: 8, note: "class_names 条数上限（与引擎池抽取的 8 个同界）" },
  classNameMaxChars: { value: 40, note: "单个 class 名上限（与引擎池抽取的 40 字符同界）" },
  identityMaxChars: { value: 60, note: "role/id/name 等短标识上限（桥侧独立界）" },
  framePathMaxItems: { value: 4, note: "frame_path 条数上限（与 hint 的 ≤4 段帧链声明同口径）" },
  framePathSegmentMaxChars: { value: 64, note: "单段帧 origin 上限（桥侧有界化，规范 origin 通常远小于此）" },
  structurePathMaxChars: { value: 160, note: "structure_path 上限（结构证据不是 hint，与 hint 的界分开）" },
  rowTextsMaxLines: { value: 6, note: "row_texts 行数上限（与引擎行上文的 ≤6 行同界）" },
  rowTextsLineMaxChars: { value: 40, note: "row_texts 单行上限（与引擎的 ≤40 字符行过滤同界）" },
} as const;

/* ------------------------------------------------------ ElementView 字段合同 */

/** 元素行字段的出现面闭集：两面 / 只有 observe / 只有 inspect（桥输出面口径）。 */
export const SESSION_ELEMENT_VIEW_FACES = ["both", "observe", "inspect"] as const;
export type SessionElementViewFace = (typeof SESSION_ELEMENT_VIEW_FACES)[number];

/** `SESSION_ELEMENT_VIEW_FIELDS` 的一行形状（表用显式类型标注，便于生成器按行遍历）。 */
export interface SessionElementViewField {
  /** 桥面（消费面）字段名；也是本表的唯一键。 */
  field: string;
  /** 引擎 observe 面（`ObserveElement`）的键名；`null` = 该面没有这一键。 */
  engineObserve: string | null;
  /**
   * 引擎 inspect 面元素行的键名（inspect 命令从池投影 + `PoolView.extras` 组出的行）；
   * `null` = 该面没有这一键。
   */
  engineInspect: string | null;
  /** 桥面字段名（`ElementView`）；`null` = 桥面整体丢弃该引擎字段（当前无此情形）。 */
  bridge: string | null;
  /** 哪一面会带这个字段（桥输出面）。 */
  faces: SessionElementViewFace;
  /**
   * 引擎有、桥面**不给**该面的键（如实记录，不是缺陷）：`observe` = 引擎 observe 面产出但
   * 桥投影不读（键名不一致或桥不投影），`inspect` = inspect 面同理。生成器据此断言两侧的
   * 现状：登记了 `observe` 而桥投影竟然读了该键，或桥不读却没登记，都判红。
   */
  engineOnly?: readonly SessionElementViewFace[];
  /**
   * 桥侧**派生**出现面：引擎在该面不产这个键，桥自己置位（截断标记这类投影事实）。
   * 生成器用它校验 `faces` 不虚报引擎产出。
   */
  derived?: readonly SessionElementViewFace[];
  /** 该字段的上限键（`SESSION_ELEMENT_VIEW_LIMITS` 的键名；`null` = 无字符/条数界）。 */
  caps: readonly string[] | null;
  /** 能否直接作为 act/read target 的**动作地址**。闭集保证：全表有且只有 `hint_candidates`。 */
  address: boolean;
  /** 一句话语义。 */
  semantics: string;
  /** 契约事实（键名差异、采集面与投影面的差异、不可照抄的原因等）。 */
  note?: string;
}

/**
 * 观察面**元素行字段合同**的唯一出处：字段 × 引擎两面键名 × 桥面键名 × cap × 出现面 ×
 * 能否作动作地址。
 *
 * 为什么要这张表：元素行是 Agent 看页面的唯一入口，但它的描述此前只有桥面（`ElementView`）
 * 一处结构化清单，引擎侧 `ObserveElement` 与 inspect 面元素行没有可断言的对照物；三面各自
 * 加减字段时，"桥给了引擎没给""引擎给了桥不给""某个字段被当成地址用"都只能靠读代码发现。
 * 本表把三面收进一张可机检的表：生成器 `checkElementViewFields` 拿它做双向交叉校验——表里
 * 每个非 `null` 的引擎键必须真实存在于对应面的源码，两面源码里的每个键也必须在表里有行
 * （任一方向漏登记 = 红）。
 *
 * **核心不变量（机制化，不靠文档自觉）**：地址只来自 `hint_candidates`。`ref` 是展示/对账锚，
 * `structure_path` 是诊断证据，`label`/`bbox`/`class_names` 是人读信息；`act`/`read`/`extract`
 * 的 target 只认 hint 字符串或 CSS。生成器断言 `address:true` 的行**有且只有** `hint_candidates`。
 *
 * 改字段 = 改本表 + `tools/session-contract-gen.ts --write`（生成桥侧常量）；引擎面新增/删除
 * 字段时同步改表，否则 `--check` 红。
 */
export const SESSION_ELEMENT_VIEW_FIELDS: readonly SessionElementViewField[] = [
  // ---- 身份与地址 ----
  {
    field: "ref", engineObserve: "ref", engineInspect: "ref", bridge: "ref", faces: "both", caps: null, address: false,
    semantics: "展示/对账锚：observe 面是观察序号 `oN`，inspect 面是池 ref `eN`",
    note: "不是动作地址：act/read/extract 的 target 只认 hint 字符串或 CSS",
  },
  {
    field: "hint_candidates", engineObserve: "hint_candidates", engineInspect: "hint_candidates", bridge: "hint_candidates",
    faces: "both", caps: ["hintsPerElement", "hintMaxChars"], address: true,
    semantics: "自证 hint 候选：每条经同一个 `hintMatch` 在对应集合上验证「恰好唯一命中该元素」",
    note: "**唯一可作动作地址的字段**；跨帧为 `<label> frame:<origin链>`，同名组为 `within:`，同文案重复组为 `in-row:`/`row-index:`",
  },
  {
    field: "tag", engineObserve: "tag", engineInspect: "tag", bridge: "tag", faces: "both", caps: null, address: false,
    semantics: "元素标签名（小写）",
  },
  {
    field: "role", engineObserve: "role", engineInspect: "role", bridge: "role", faces: "both", caps: ["identityMaxChars"], address: false,
    semantics: "显式 ARIA 角色（`role` 属性，小写）；没有角色时缺键",
  },
  {
    field: "label", engineObserve: "label", engineInspect: "label", bridge: "label", faces: "both", caps: ["labelMaxChars"], address: false,
    semantics: "可见标签（匹配口径是引擎 `full_label` 的 ≤200 前缀）",
    note: "人读信息：可读、不可当地址；照抄进 target 不构成寻址",
  },
  {
    field: "text", engineObserve: "text", engineInspect: null, bridge: "text", faces: "observe",
    caps: ["labelMaxChars"], address: false,
    semantics: "元素**可见文本**（去掉 style/script 子树后的内容文本）——`aria-label` 优先时 label 是属性值，text 才是页面上的可见名",
    note: "人读信息，不可寻址；引擎侧上限 = labelMaxChars（`elem-model` 的 `__TEXT_MAX`），桥再按同一界裁剪",
  },
  {
    field: "label_source", engineObserve: "label_source", engineInspect: null, bridge: "label_source",
    faces: "observe", caps: null, address: false,
    semantics: "`label` 的取值档位（闭集 `aria-label` / `label` / `text` / `title` / `none`）",
    note: "与 `label` 同一取值链、同一处产出（`pool-js-core` 的 `labelInfoOf`）；`name`/`id`/`data-test` 是保留位、当前不产出",
  },
  {
    field: "label_truncated", engineObserve: null, engineInspect: "label_truncated", bridge: "label_truncated",
    faces: "both", derived: ["observe"], caps: null, address: false,
    semantics: "`label` 被截断过（引擎匹配口径 200，或桥层按 `labelMaxChars` 再裁）",
    note: "inspect 面由引擎置位；observe 面引擎不产此键，桥在裁剪时自己置位",
  },
  {
    field: "hints_truncated", engineObserve: null, engineInspect: null, bridge: "hints_truncated",
    faces: "both", derived: ["observe", "inspect"], caps: null, address: false,
    semantics: "引擎给的候选条数多于桥收集上限（桥侧独立置位）",
    note: "兼容位：当前两侧候选生成上限都低于收集上限，实际不会出现",
  },
  // ---- 展示与属性（人读，不可寻址） ----
  {
    field: "href", engineObserve: "href", engineInspect: "href", bridge: "href", faces: "both", caps: ["hrefMaxChars"], address: false,
    semantics: "链接地址（inspect 面是去 origin/query 的展示投影，observe 面是 DOM 原始属性）",
  },
  {
    field: "href_full", engineObserve: null, engineInspect: "href_full", bridge: "href_full", faces: "inspect",
    caps: ["hrefMaxChars"], address: false,
    semantics: "原始 `getAttribute('href')`（query/fragment/origin 都在）",
    note: "observe 面的 `href` 本身就是原始属性；此键只在 inspect 面出现",
  },
  {
    field: "class_names", engineObserve: "class_names", engineInspect: "class_names", bridge: "class_names", faces: "both",
    caps: ["classNamesPerElement", "classNameMaxChars"], address: false,
    semantics: "有界类名清单",
  },
  {
    field: "anchor_ids", engineObserve: "anchor_ids", engineInspect: null, bridge: "anchor_ids", faces: "observe",
    caps: null, address: false,
    semantics: "祖先 `id` 链（内→外、≤8 项、小写）——`within:#<id>` 的取值来源",
    note: "**地址素材不是地址**：单独照抄不构成 hint，写进 target 必须配合 `within:`（链外→内）；"
      + "与 `declared.ts` 的 `anchor_ids` 同一口径（共享 `ANCHOR_JS` 单源，池面/声明面 `within:` 同义）；"
      + "无 id 祖先时缺键；实现界 ≤8 项 × 每项 ≤40 字符（截断后的 id 不可寻址），故不占 contract cap；"
      + "只在 observe 元素行投影（inspect 元素行不带），不进模型面/`esig`/`firstIfSame`",
  },
  {
    field: "id", engineObserve: "id", engineInspect: "id", bridge: "id", faces: "both", caps: ["identityMaxChars"], address: false,
    semantics: "`id` 属性（空值缺键）",
  },
  {
    field: "name", engineObserve: "name", engineInspect: "name", bridge: "name", faces: "both", caps: ["identityMaxChars"], address: false,
    semantics: "`name` 属性（空值缺键）",
  },
  {
    field: "data_test", engineObserve: "data_test", engineInspect: "data_test", bridge: "data_test", faces: "both",
    caps: ["identityMaxChars"], address: false,
    semantics: "`data-test` 属性（空值缺键）",
  },
  {
    field: "input_type", engineObserve: "type", engineInspect: "input_type", bridge: "input_type", faces: "both",
    caps: ["identityMaxChars"], address: false,
    semantics: "`type` 属性（input 族语义）",
    note: "同一事实两个引擎键名：observe 面 `type`、inspect 面 `input_type`。桥投影两个键名都读（先 `input_type` 再回退 `type`），"
      + "输出**恒为 `input_type`**——所以两面在桥侧同名同义，键名差异不外泄",
  },
  {
    field: "bbox", engineObserve: "bbox", engineInspect: null, bridge: "bbox", faces: "observe", caps: null, address: false,
    semantics: "视口坐标盒 `{x,y,w,h}`（人读几何，不可寻址）",
  },
  // ---- 观察面准入诊断 ----
  {
    field: "visible", engineObserve: "visible", engineInspect: null, bridge: "visible", faces: "observe", caps: null, address: false,
    semantics: "可见性（`includeHidden:true` 时不可见行也会出现）",
  },
  {
    field: "admitted", engineObserve: "admitted", engineInspect: null, bridge: "admitted", faces: "observe", caps: null, address: false,
    semantics: "当前准入面（准入选择器 + 可见 + 至少一条自证 hint）可解析",
  },
  {
    field: "why_not_admitted", engineObserve: "why_not_admitted", engineInspect: null, bridge: "why_not_admitted",
    faces: "observe", caps: ["whyNotAdmittedMaxChars"], address: false,
    semantics: "不满足 `admitted` 的可行动原因（不是错误码堆叠）",
    note: "桥按词边界截断：`#id` / `[data-test=…]` / `[name=…]` / `role=…` 寻址 token 不从中间切断",
  },
  // ---- 帧链 ----
  {
    field: "frame", engineObserve: "frame", engineInspect: null, bridge: "frame", faces: "observe", caps: null, address: false,
    semantics: "元素所在帧下标（0 = 主 frame，对应 `frames[]`）",
  },
  {
    field: "frame_origin", engineObserve: "frame_origin", engineInspect: "frame_origin", bridge: "frame_origin", faces: "both",
    caps: ["identityMaxChars"], address: false,
    semantics: "元素所在帧的 origin",
    note: "未知 origin 帧（about:blank/srcdoc）两面都不出此键——这类帧不可被任何 `frame:` 命中",
  },
  {
    field: "frame_path", engineObserve: "frame_path", engineInspect: "frame_path", bridge: "frame_path", faces: "both",
    caps: ["framePathMaxItems", "framePathSegmentMaxChars"], address: false,
    semantics: "帧 origin 祖先链（外→内；主帧省略）",
  },
  // ---- 行锚底座 ----
  {
    field: "row_texts", engineObserve: "row_texts", engineInspect: null, bridge: "row_texts", faces: "observe",
    caps: ["rowTextsMaxLines", "rowTextsLineMaxChars"], address: false,
    semantics: "行上下文文本（`in-row:` 匹配底座与词元来源）",
    note: "引擎两面都采集，但 inspect 的元素行不投影此键；仅同文案重复组元素携带，不进模型面",
  },
  {
    field: "row_index", engineObserve: "row_index", engineInspect: null, bridge: "row_index", faces: "observe", caps: null,
    address: false,
    semantics: "同文案重复组内的 DOM 先序位次（1-based；`row-index:` 匹配底座）",
    note: "与 `row_texts` 同采集面，同样只在 observe 元素行投影；序漂移责任在作者",
  },
  // ---- 诊断证据（不是地址） ----
  {
    field: "structure_path", engineObserve: "structure_path", engineInspect: "structure_path", bridge: "structure_path",
    faces: "both", caps: ["structurePathMaxChars"], address: false,
    semantics: "结构证据：祖先 tag/`#id` + 同 tag 兄弟序号 + 帧下标前缀",
    note: "**诊断证据，不可照抄**：动态页面（重排/虚拟列表/插入广告）随时失效，不是 hint",
  },
  {
    field: "structure_unstable", engineObserve: "structure_unstable", engineInspect: "structure_unstable",
    bridge: "structure_unstable", faces: "both", caps: null, address: false,
    semantics: "结构证据的不稳定标记（与 `structure_path` 同出现，一眼看出不是 hint）",
  },
  // ---- 池投影附加（inspect 面的动作能力与宽扫标记） ----
  {
    field: "action_family", engineObserve: null, engineInspect: "action_family", bridge: "action_family", faces: "inspect",
    caps: ["identityMaxChars"], address: false,
    semantics: "动作族（池投影 `elemFamily`：click/fill/select/check/upload）",
  },
  {
    field: "action_capabilities", engineObserve: null, engineInspect: "action_capabilities", bridge: "action_capabilities",
    faces: "inspect", caps: ["identityMaxChars"], address: false,
    semantics: "动作能力面（含 slider/scroll/drag/hover/upload 等特殊控件能力）",
    note: "条数由桥投影按字面量 8 收集（`ACTION_ADAPTERS` 共 10 种，单元素同时具备 >8 种能力的页面上会被裁到 8）——"
      + "该条数界没有进 SESSION_ELEMENT_VIEW_LIMITS，故 caps 只记单项字符界；改它先补上限键再改这里",
  },
  {
    field: "near", engineObserve: null, engineInspect: "near", bridge: "near", faces: "inspect", caps: ["identityMaxChars"],
    address: false,
    semantics: "近邻上下文锚（既有 `near~` 属性词匹配的池字段）",
  },
  {
    field: "surface", engineObserve: null, engineInspect: "surface", bridge: "surface", faces: "inspect",
    caps: ["identityMaxChars"], address: false,
    semantics: "准入类目标记（native-control / aria-role / …，只进 inspect 与类目计数）",
  },
  {
    field: "heuristic", engineObserve: null, engineInspect: "heuristic", bridge: "heuristic", faces: "inspect",
    caps: ["identityMaxChars"], address: false,
    semantics: "启发式伪按钮标记（宽扫通道专属，审计可辨）",
  },
];
