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

// 值单源在仓库 src/support/session-contract.ts 的 SESSION_ELEMENT_VIEW_LIMITS；桥包自带
// tsconfig 不能 import 仓库 src，故从这里读确定性投影（element-view.constants.generated.ts
// 由 tools/session-contract-gen.ts 生成，--check 判过期）。导出名保持不变：调用方只认这份。
import {
  classNamesPerElement,
  classNameMaxChars,
  elementDefaultMax,
  elementMax,
  ELEMENT_VIEW_FIELDS,
  type ElementViewFieldSpec,
  framePathMaxItems,
  framePathSegmentMaxChars,
  hintMaxChars,
  hintsPerElement,
  hrefMaxChars,
  identityMaxChars,
  labelMaxChars,
  rowTextsLineMaxChars,
  rowTextsMaxLines,
  structurePathMaxChars,
  whyNotAdmittedMaxChars,
} from './element-view.constants.generated.ts'

/**
 * 元素行字段合同（生成物 `ELEMENT_VIEW_FIELDS` 的再导出）：字段 × 出现面 × 能否作动作地址 × cap 键。
 * 权威表在仓库 `src/support/session-contract.ts` 的 `SESSION_ELEMENT_VIEW_FIELDS`（人类可读的完整
 * 版本见 `docs/AGENT_INTERFACE.md` §3.2）；桥包不能 import 仓库 `src`，只收这份确定性投影。
 */
export const ELEMENT_VIEW_FIELD_CONTRACT: readonly ElementViewFieldSpec[] = ELEMENT_VIEW_FIELDS
export type { ElementViewFieldSpec }

/**
 * 合同自证（import 时一次）：**地址只来自 `hint_candidates`**。
 *
 * 仓库侧由生成器对权威表断言同一条；这里是**消费侧镜像**——桥看不到仓库源码，只能验自己收到的
 * 投影。两侧同时成立，"把 `ref`/`label`/`structure_path` 当 target 用"才不可能被写成合法合同。
 */
const ADDRESS_FIELDS: readonly string[] = ELEMENT_VIEW_FIELDS.filter((f) => f.address).map((f) => f.field)
if (ADDRESS_FIELDS.length !== 1 || ADDRESS_FIELDS[0] !== 'hint_candidates') {
  throw new Error(
    'element-view: 字段合同的 address 面必须恰好是 hint_candidates，实际 '
    + `${JSON.stringify(ADDRESS_FIELDS)}（生成物与仓库表不一致？重跑 session-contract-gen --write）`,
  )
}

/** 元素行数缺省（两面一致；`amber inspect` 的 CLI 缺省同为 60）。 */
export const ELEMENT_DEFAULT_MAX = elementDefaultMax
/** 元素行数硬上限（两面一致；引擎 ctx.observe 硬上限同为 200）。 */
export const ELEMENT_MAX = elementMax
/**
 * 每元素 hint_candidates 收集上限。**兼容性 cap**：引擎 `suggestHints` 实际最多给 4 条，
 * 这里按 6 收集（多出的两条永不会出现）；保留 6 不改变既有输出形状，引擎侧上限才是真界。
 */
export const HINTS_PER_ELEMENT = hintsPerElement
/** 单条 hint 字符串上限（与引擎 AMBIGUITY_HINT_MAX 同口径；`<label> frame:<origin链>`
 *  候选最长可达 4 段 origin 链）。 */
export const HINT_MAX_CHARS = hintMaxChars
/** label 上限（与引擎匹配口径 full_label 的 200 字一致；超出置 label_truncated）。 */
export const LABEL_MAX_CHARS = labelMaxChars
/** href 展示投影上限。 */
export const HREF_MAX_CHARS = hrefMaxChars
/**
 * why_not_admitted 诊断文本上限（词边界截断，见 `clipWhyNotAdmitted`）：断点落在空白/标点处，
 * 寻址 token（`#id` / `[data-test=…]` / `[name=…]` / `role=…`）不从中间切断——token 自身
 * 越过上限时保 token 完整、截其余叙述（唯一可超本上限的情形，字段仍 ≤ 引擎原文长度）。
 */
export const WHY_NOT_ADMITTED_MAX_CHARS = whyNotAdmittedMaxChars
/** class_names 条数上限（与引擎池抽取口径一致）。 */
export const CLASS_NAMES_PER_ELEMENT = classNamesPerElement
/** 单个 class 名上限（与引擎池抽取口径一致）。 */
export const CLASS_NAME_MAX_CHARS = classNameMaxChars
/** role 等短标识字段上限。 */
export const IDENTITY_MAX_CHARS = identityMaxChars
/** frame_path（帧 origin 祖先链）条数上限（与 parseHint 的 ≤4 段声明上限同口径）。 */
export const FRAME_PATH_MAX_ITEMS = framePathMaxItems
/** 单段 frame origin 上限（仅作有界化，规范 origin 通常远小于此）。 */
export const FRAME_PATH_SEGMENT_MAX_CHARS = framePathSegmentMaxChars
/** structure_path 上限（独立诊断上限；与 hint 的 200 分开——它不是 hint）。 */
export const STRUCTURE_PATH_MAX_CHARS = structurePathMaxChars
/** row_texts 行数上限（与引擎 `Elem.row_texts` 的 ≤6 行同口径）。 */
export const ROW_TEXTS_MAX_LINES = rowTextsMaxLines
/** row_texts 单行上限（与引擎的 ≤40 字符行过滤同口径）。 */
export const ROW_TEXTS_LINE_MAX_CHARS = rowTextsLineMaxChars

/* ------------------------------------------------------------ 合同形状 */

/**
 * 一个观察元素行的统一形状。两面**同形同义**：
 *   - `hint_candidates`（不是 `hints`）：每条已经 `hintMatch` 自证「恰好唯一命中该元素」，
 *     可直接照抄进 act target / ctx.hint / app.mjs；
 *   - `admitted` / `why_not_admitted`：observe 面的池准入诊断（为什么进不了池/没有可解析
 *     hint）；inspect 面的元素本来就是池内行，不出现这对字段；
 *   - `ax` / `advisories` / `window` 是**顶层证据块，不在元素行内**：inspect 面的
 *     ax/advisories/window 经 service.ts 原样透传；session observe 面的 ax（引擎缺省附带、
 *     与 inspect 同一取树实现同一口径，pool_size/not_in_pool 的对照底座是本次观察的准入
 *     元素）经 session.ts 原样透传——advisories/window 仍是 inspect 专属。
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
  /** observe 面：不满足 admitted 的可行动原因（≤WHY_NOT_ADMITTED_MAX_CHARS，词边界截断）。 */
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
  /** inspect/observe 面：元素所属 frame origin（B 批 observe 面开始透传；未知 origin 帧缺省）。 */
  frame_origin?: string
  /** inspect/observe 面：祖先 origin 链（外→内；主帧省略；B 批透传，≤4 段 × 64 字符）。 */
  frame_path?: string[]
  /**
   * B 批：**结构证据**（仅引擎 inspect/observe 的 structure opt-in 面提供；≤160 字符）。
   * 祖先 tag/`#id` + 同 tag 兄弟序号 + 帧下标前缀。**不是 hint**：动态页面可能失效、
   * 不可照抄进 act target；与 `structure_unstable:true` 同出现。
   */
  structure_path?: string
  /** 结构证据的不稳定标记（引擎给才有；桥不补字段）。 */
  structure_unstable?: boolean
  /** inspect 面：动作族/能力面（池投影）。 */
  action_family?: string
  action_capabilities?: string[]
  id?: string
  name?: string
  data_test?: string
  input_type?: string
  /** inspect 面 extras：near 锚（hint 白名单属性）。 */
  near?: string
  /**
   * F84 批 3：行上下文文本（in-row 匹配底座 + 词元来源）——**仅同文案重复组元素携带**
   * （≤6 行 × ≤40 字符，引擎 dup 门控采集；非重复组不出键）。不进模型面。
   */
  row_texts?: string[]
  /**
   * F84 批 3：dup 组内 DOM 先序位次（1-based；row-index 匹配底座）——仅同文案重复组元素
   * 携带（非重复组不出键）。序号即语义的序漂移责任在作者（组合 in-row 守卫 = fail-safe）。
   */
  row_index?: number
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

/* ------------------------------------------ why_not_admitted 的词边界截断 */

/**
 * 词边界字符：空白 + 收束标点。连接符（`-` `:` `=` `/` `<` `>`）与开括号不算——它们是
 * token / 复合词的内部结构（`row-index:N`、`within:#outer`、`id/name`），断在上面同样毁证据。
 */
const BOUNDARY_CHARS = new Set([')', ']', '}', ',', ';', '.', '!', '?', '…', '—', '"', "'", '`'])

function isBoundaryChar(c: string | undefined): boolean {
  if (c === undefined) return false
  return /\s/.test(c) || BOUNDARY_CHARS.has(c)
}

/** 寻址 token 的终止字符（token 在它之前结束；空白总是终止）。 */
const TOKEN_STOP_CHARS = new Set([')', ']', '}', '"', "'", '`', ',', ';', '…'])

/**
 * 扫描寻址 token 的闭区间（`[start, end)`，end 排他；扫描器逐段消费，区间互不重叠）。三种形态：
 *   - `[attr=…]`：`[` 到配对 `]`（含）——覆盖 `[data-test=…]` / `[name=…]`；无 `]` 时保守保护到下一空白；
 *   - `#id`：`#` 起到空白/终止字符前——`(#id)` 的 `)`、`` `#id` `` 的反引号不属于 token，
 *     `within:#outer>#inner` 的 `>` 属于 token 内部（链式锚不可断）；
 *   - `role=…`：词边界上的 `role=` 起（`hero=` 不算），值可带引号（`role="button"`）。
 */
function protectedTokenSpans(s: string): Array<[number, number]> {
  const stop = (from: number): number => {
    let j = from
    while (j < s.length) {
      const c = s[j]!
      if (/\s/.test(c) || TOKEN_STOP_CHARS.has(c)) break
      j += 1
    }
    return j
  }
  const spans: Array<[number, number]> = []
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === '[') {
      const close = s.indexOf(']', i + 1)
      const end = close === -1 ? stop(i + 1) : close + 1
      spans.push([i, end])
      i = end
    } else if (c === '#') {
      const end = stop(i + 1)
      spans.push([i, end])
      i = end
    } else if (c === 'r' && s.startsWith('role=', i) && !/[A-Za-z0-9_-]/.test(i > 0 ? s[i - 1]! : ' ')) {
      const valueStart = i + 5
      const quote = s[valueStart]
      let end: number
      if (quote === '"' || quote === "'") {
        const closeQuote = s.indexOf(quote, valueStart + 1)
        end = closeQuote === -1 ? stop(valueStart + 1) : closeQuote + 1
      } else {
        end = stop(valueStart)
      }
      spans.push([i, end])
      i = end
    } else {
      i += 1
    }
  }
  return spans
}

/** 截断点是否落在某个 token 内部（区间开闭：token 起点与末位本身都允许截断——前者丢弃 token，后者保其完整）。 */
function insideToken(spans: Array<[number, number]>, p: number): boolean {
  return spans.some(([start, end]) => start < p && p < end)
}

/**
 * why_not_admitted 承载"为什么进不了池"的第一证据，其中寻址 token（稳定句柄）是可行动性的
 * 关键——`#filter_item_trans_coupon` 被切在中间的诊断不可判读。与通用 `clip` 的硬切不同：
 * 截断点落在空白/标点处，token 不从中间切断；token 自身越过上限时保 token 完整、截其余叙述
 * （此时字段长度 = token 末位 + …，仍 ≤ 引擎原文长度）。
 */
function clipWhyNotAdmitted(s: string, max: number): string {
  if (s.length <= max) return s
  const limit = max - 1 // 结尾省略号占一位
  const spans = protectedTokenSpans(s)
  const straddling = spans.find(([start, end]) => start < limit && end > limit)
  if (straddling !== undefined) return `${s.slice(0, straddling[1])}…`
  for (let p = limit; p >= 1; p -= 1) {
    if (insideToken(spans, p)) continue
    if (isBoundaryChar(s[p - 1]) || isBoundaryChar(s[p])) {
      return `${s.slice(0, p).replace(/\s+$/, '')}…`
    }
  }
  return `${s.slice(0, limit)}…` // 上限内没有任何词边界：退回硬切，守住有界承诺
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
  const framePath = strArray(raw['frame_path'], FRAME_PATH_MAX_ITEMS, FRAME_PATH_SEGMENT_MAX_CHARS)
  const capabilities = strArray(raw['action_capabilities'], 8, IDENTITY_MAX_CHARS)
  // F84 批 3：行上下文（仅同文案重复组元素携带；≤6 行 × ≤40 字符——引擎口径本就同界）。
  const rowTexts = strArray(raw['row_texts'], ROW_TEXTS_MAX_LINES, ROW_TEXTS_LINE_MAX_CHARS)
  const rowIndex = num(raw['row_index'])
  // why_not_admitted：词边界截断（见 clipWhyNotAdmitted）——寻址 token 不切中。
  const whyNot =
    typeof raw['why_not_admitted'] === 'string' && raw['why_not_admitted'] !== ''
      ? clipWhyNotAdmitted(raw['why_not_admitted'], WHY_NOT_ADMITTED_MAX_CHARS)
      : undefined
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
    ...(whyNot === undefined ? {} : { why_not_admitted: whyNot }),
    ...(bool(raw['visible']) === undefined ? {} : { visible: raw['visible'] as boolean }),
    ...(str(raw['role'], IDENTITY_MAX_CHARS) === undefined ? {} : { role: str(raw['role'], IDENTITY_MAX_CHARS) as string }),
    ...(str(raw['href'], HREF_MAX_CHARS) === undefined ? {} : { href: str(raw['href'], HREF_MAX_CHARS) as string }),
    ...(str(raw['href_full'], HREF_MAX_CHARS) === undefined ? {} : { href_full: str(raw['href_full'], HREF_MAX_CHARS) as string }),
    ...(classNames.items.length ? { class_names: classNames.items } : {}),
    ...(bbox === undefined ? {} : { bbox }),
    ...(num(raw['frame']) === undefined ? {} : { frame: num(raw['frame']) as number }),
    ...(str(raw['frame_origin'], IDENTITY_MAX_CHARS) === undefined ? {} : { frame_origin: str(raw['frame_origin'], IDENTITY_MAX_CHARS) as string }),
    ...(framePath.items.length ? { frame_path: framePath.items } : {}),
    ...(str(raw['structure_path'], STRUCTURE_PATH_MAX_CHARS) === undefined
      ? {}
      : {
          structure_path: str(raw['structure_path'], STRUCTURE_PATH_MAX_CHARS) as string,
          ...(raw['structure_unstable'] === true ? { structure_unstable: true } : {}),
        }),
    ...(str(raw['action_family'], IDENTITY_MAX_CHARS) === undefined ? {} : { action_family: str(raw['action_family'], IDENTITY_MAX_CHARS) as string }),
    ...(capabilities.items.length ? { action_capabilities: capabilities.items } : {}),
    ...(str(raw['id'], IDENTITY_MAX_CHARS) === undefined ? {} : { id: str(raw['id'], IDENTITY_MAX_CHARS) as string }),
    ...(str(raw['name'], IDENTITY_MAX_CHARS) === undefined ? {} : { name: str(raw['name'], IDENTITY_MAX_CHARS) as string }),
    ...(str(raw['data_test'], IDENTITY_MAX_CHARS) === undefined ? {} : { data_test: str(raw['data_test'], IDENTITY_MAX_CHARS) as string }),
    ...(str(raw['input_type'], IDENTITY_MAX_CHARS) === undefined ? {} : { input_type: str(raw['input_type'], IDENTITY_MAX_CHARS) as string }),
    ...(str(raw['near'], IDENTITY_MAX_CHARS) === undefined ? {} : { near: str(raw['near'], IDENTITY_MAX_CHARS) as string }),
    // F84 批 3：行锚两键（仅同文案重复组元素携带；缺省/非重复组不出键——桥不补字段）。
    ...(rowTexts.items.length ? { row_texts: rowTexts.items } : {}),
    ...(rowIndex === undefined ? {} : { row_index: rowIndex }),
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
