/**
 * ElementView —— 桥侧观察面的**统一元素投影合同**（单一出处）。
 *
 * 两个观察面共用本模块（缺一不可，分叉即缺陷）：
 *   - `…_inspect`：CLI `amber inspect --json` 的 elements 投影（一次性无状态面）；
 *   - `…_session op:"observe"`：引擎 session JSONL `observe` 响应（ctx.observe 视图，
 *     会话内状态保持面）的投影。
 *
 * 为什么要有这一层（对齐裁决 2026-11-11）：
 *   - 两面背后是**同一个引擎观察语义**——`hint_candidates` 都经同一个 `rules.suggestHints
 *     + hintMatch` 在观察/池集合上自证（可照抄），诊断事实都来自引擎；阶段差异只应体现在
 *     "被观察的页面状态"与信封字段（url+element_count vs session_id+counts），
 *     **不应体现在字段名、截断策略、行数上限上**。
 *   - 此前两个 mapper 各自手写裁剪：inspect 透传 `hint_candidates`、observe 改名 `hints`
 *     且截到 ≤3、cap 60/200 vs 40/40、`why_not_admitted`/`ax` 各断一处——"可照抄"不变量
 *     被投影层削弱，"为什么进不了池"经桥无处可答。收敛成本模块后，引擎观察视图加字段
 *     只改这里一处，两个面同时跟上。
 *
 * 纪律（与桥既有透传纪律一致）：
 *   - **只做有界映射，不重算、不补字段**：引擎没给的键桥不发明（缺键 = 该面未提供）；
 *   - `ref` 是展示/对账锚（inspect=池 ref `eN`，observe=观察序号 `oN`），**不是动作地址**：
 *     act/read 的寻址货币是 hint 字符串与 CSS，工具描述必须讲清这一点；
 *   - 引擎新字段先加进下面的合同清单再透传——未知键一律丢弃（输出有界可证）。
 *
 * 本文件不 import 任何 Cordis/DSH 包、不依赖 node 内建模块：纯函数 + 常量，
 * 与 session.ts 一样可以脱离桥构建独立做类型检查。
 */

/* ------------------------------------------------------------ 合同常量（唯一出处） */

/** 元素行数缺省（两面一致；`amber inspect` 的 CLI 缺省同为 60）。 */
export const ELEMENT_DEFAULT_MAX = 60
/** 元素行数硬上限（两面一致；引擎 ctx.observe 硬上限同为 200）。 */
export const ELEMENT_MAX = 200
/** 每元素 hint_candidates 条数上限。 */
export const HINTS_PER_ELEMENT = 6
/** 单条 hint 字符串上限。 */
export const HINT_MAX_CHARS = 160
/** label 上限（与引擎匹配口径 full_label 的 200 字一致；超出置 label_truncated）。 */
export const LABEL_MAX_CHARS = 200
/** href 展示投影上限。 */
export const HREF_MAX_CHARS = 160
/** why_not_admitted 诊断文本上限。 */
export const WHY_NOT_ADMITTED_MAX_CHARS = 120
/** class_names 条数上限（与引擎 F41 口径一致）。 */
export const CLASS_NAMES_PER_ELEMENT = 8
/** 单个 class 名上限（与引擎 F41 口径一致）。 */
export const CLASS_NAME_MAX_CHARS = 40
/** role 等短标识字段上限。 */
export const IDENTITY_MAX_CHARS = 60

/* ------------------------------------------------------------ 合同形状 */

/**
 * 一个观察元素行的统一形状。两面**同形同义**：
 *   - `hint_candidates`（不是 `hints`）：每条已经 `hintMatch` 自证「恰好唯一命中该元素」，
 *     可直接照抄进 act target / ctx.hint / app.mjs；
 *   - `admitted` / `why_not_admitted`：observe 面的池准入诊断（为什么进不了池/没有可解析
 *     hint）；inspect 面的元素本来就是池内行，不出现这对字段；
 *   - `ax` / `advisories` / `window` 是 inspect 面的顶层证据块（不在元素行内），经
 *     service.ts 原样透传。
 */
export interface ElementView {
  /** inspect=池 ref `eN`（与 run 的 executed_actions 可对账）；observe=观察序号 `oN`。展示锚，非动作地址。 */
  ref: string
  tag: string
  /** 完整标签（clip 到 LABEL_MAX_CHARS；引擎口径本就 ≤200）。 */
  label: string
  /** label 被截断过（引擎报告的匹配口径截断或本层 clip）。 */
  label_truncated?: boolean
  /** 自证 hint 候选（≤HINTS_PER_ELEMENT 条）。可照抄。 */
  hint_candidates: string[]
  /** 候选被本层截断（引擎给得比合同上限多）。 */
  hints_truncated?: boolean
  /** observe 面：是否满足「准入面 + 可见 + 至少一条自证 hint」。 */
  admitted?: boolean
  /** observe 面：不满足 admitted 的可行动原因。 */
  why_not_admitted?: string
  /** observe 面：可见性（includeHidden:true 时 false 行会出现）。 */
  visible?: boolean
  role?: string
  /** 展示投影（原始属性走 href_full；hint 建议优先原始值）。 */
  href?: string
  /** 原始 getAttribute('href')（T9 口径）。 */
  href_full?: string
  /** 有界类名（≤8 × ≤40）。 */
  class_names?: string[]
  /** observe 面：bbox。 */
  bbox?: { x: number; y: number; w: number; h: number }
  /** observe 面：0 = 主 frame，frames[] 下标。 */
  frame?: number
  /** inspect 面：元素所属 frame origin。 */
  frame_origin?: string
  /** inspect 面：动作族/能力面（池投影）。 */
  action_family?: string
  action_capabilities?: string[]
  id?: string
  name?: string
  data_test?: string
  input_type?: string
  /** inspect 面 extras：near 锚（hint 白名单属性）。 */
  near?: string
  /** inspect 面 extras：类目标记（U3）。 */
  surface?: string
  /** inspect 面 extras：R2 启发式伪按钮标记（宽扫专属）。 */
  heuristic?: string
}

/* ------------------------------------------------------------ 投影实现 */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || v === '') return undefined
  return clip(v, max)
}

/** 布尔/数字/数组字段：类型不对就当不存在（桥不修引擎的形状，也不传播坏形状）。 */
function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function strArray(v: unknown, maxItems: number, maxChars: number): { items: string[]; truncated: boolean } {
  if (!Array.isArray(v)) return { items: [], truncated: false }
  const raw = v.filter((x): x is string => typeof x === 'string' && x !== '')
  return { items: raw.slice(0, maxItems).map((s) => clip(s, maxChars)), truncated: raw.length > maxItems }
}

/**
 * 一行引擎元素 → 合同形状。返回 null 仅当输入根本不是对象（数组里混进的垃圾行）。
 * 未列入合同的引擎键一律丢弃——要透传新字段，先把它加进 ElementView。
 */
export function projectElementView(raw: unknown): ElementView | null {
  if (!isObj(raw)) return null
  const label = typeof raw['label'] === 'string' ? raw['label'] : ''
  const clippedLabel = label === '' ? '' : clip(label, LABEL_MAX_CHARS)
  const hints = strArray(raw['hint_candidates'], HINTS_PER_ELEMENT, HINT_MAX_CHARS)
  const classNames = strArray(raw['class_names'], CLASS_NAMES_PER_ELEMENT, CLASS_NAME_MAX_CHARS)
  const capabilities = strArray(raw['action_capabilities'], 8, IDENTITY_MAX_CHARS)
  const bboxRaw = isObj(raw['bbox']) ? raw['bbox'] : undefined
  const bbox = bboxRaw
    ? {
        x: num(bboxRaw['x']) ?? 0,
        y: num(bboxRaw['y']) ?? 0,
        w: num(bboxRaw['w']) ?? 0,
        h: num(bboxRaw['h']) ?? 0,
      }
    : undefined
  return {
    ref: typeof raw['ref'] === 'string' ? raw['ref'] : '',
    tag: typeof raw['tag'] === 'string' ? raw['tag'] : '',
    label: clippedLabel,
    ...(clippedLabel.length < label.length || raw['label_truncated'] === true ? { label_truncated: true } : {}),
    hint_candidates: hints.items,
    ...(hints.truncated ? { hints_truncated: true } : {}),
    ...(bool(raw['admitted']) === undefined ? {} : { admitted: raw['admitted'] as boolean }),
    ...(str(raw['why_not_admitted'], WHY_NOT_ADMITTED_MAX_CHARS) === undefined
      ? {}
      : { why_not_admitted: str(raw['why_not_admitted'], WHY_NOT_ADMITTED_MAX_CHARS) as string }),
    ...(bool(raw['visible']) === undefined ? {} : { visible: raw['visible'] as boolean }),
    ...(str(raw['role'], IDENTITY_MAX_CHARS) === undefined ? {} : { role: str(raw['role'], IDENTITY_MAX_CHARS) as string }),
    ...(str(raw['href'], HREF_MAX_CHARS) === undefined ? {} : { href: str(raw['href'], HREF_MAX_CHARS) as string }),
    ...(str(raw['href_full'], HREF_MAX_CHARS) === undefined ? {} : { href_full: str(raw['href_full'], HREF_MAX_CHARS) as string }),
    ...(classNames.items.length ? { class_names: classNames.items } : {}),
    ...(bbox === undefined ? {} : { bbox }),
    ...(num(raw['frame']) === undefined ? {} : { frame: num(raw['frame']) as number }),
    ...(str(raw['frame_origin'], IDENTITY_MAX_CHARS) === undefined ? {} : { frame_origin: str(raw['frame_origin'], IDENTITY_MAX_CHARS) as string }),
    ...(str(raw['action_family'], IDENTITY_MAX_CHARS) === undefined ? {} : { action_family: str(raw['action_family'], IDENTITY_MAX_CHARS) as string }),
    ...(capabilities.items.length ? { action_capabilities: capabilities.items } : {}),
    ...(str(raw['id'], IDENTITY_MAX_CHARS) === undefined ? {} : { id: str(raw['id'], IDENTITY_MAX_CHARS) as string }),
    ...(str(raw['name'], IDENTITY_MAX_CHARS) === undefined ? {} : { name: str(raw['name'], IDENTITY_MAX_CHARS) as string }),
    ...(str(raw['data_test'], IDENTITY_MAX_CHARS) === undefined ? {} : { data_test: str(raw['data_test'], IDENTITY_MAX_CHARS) as string }),
    ...(str(raw['input_type'], IDENTITY_MAX_CHARS) === undefined ? {} : { input_type: str(raw['input_type'], IDENTITY_MAX_CHARS) as string }),
    ...(str(raw['near'], IDENTITY_MAX_CHARS) === undefined ? {} : { near: str(raw['near'], IDENTITY_MAX_CHARS) as string }),
    ...(str(raw['surface'], IDENTITY_MAX_CHARS) === undefined ? {} : { surface: str(raw['surface'], IDENTITY_MAX_CHARS) as string }),
    ...(str(raw['heuristic'], IDENTITY_MAX_CHARS) === undefined ? {} : { heuristic: str(raw['heuristic'], IDENTITY_MAX_CHARS) as string }),
  }
}

/**
 * 一个引擎 elements 数组 → 合同行列表。`cap` 是调用面声明的行上限（两面同一张常量表）。
 * 截断标志 = 引擎自己的 truncated 或本层再裁掉的行。
 */
export function projectElementViews(
  raw: unknown,
  cap: number,
): { elements: ElementView[]; truncated: boolean } {
  const rows = Array.isArray(raw) ? raw : []
  const projected: ElementView[] = []
  let validRows = 0
  for (const row of rows) {
    const el = projectElementView(row)
    if (el === null) continue // 数组里混进的垃圾行：丢弃，不计入截断
    validRows += 1
    if (projected.length < cap) projected.push(el)
  }
  return { elements: projected, truncated: validRows > projected.length }
}

/** 参数行数的统一钳制（`max_elements` / `max` 两个参数名对应同一合同）。 */
export function clampElementMax(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.max(1, Math.min(ELEMENT_MAX, Math.floor(v)))
    : Math.max(1, Math.min(ELEMENT_MAX, Math.floor(fallback)))
}
