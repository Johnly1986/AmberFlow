/**
 * 生成物（勿手改）：tools/session-contract-gen.ts 从 src/support/session-contract.ts 的
 * SESSION_ELEMENT_VIEW_LIMITS 与 SESSION_ELEMENT_VIEW_FIELDS 生成（check in）。
 * 重新生成 / 校验：session-contract-gen --write | --check。
 * 桥包 tsconfig（rootDir=src）不能 import 仓库 src，故上限与字段合同以常量投影到这里。
 */

/** 元素行数缺省（inspect/observe 两面一致；CLI inspect 缺省同为 60） */
export const elementDefaultMax = 60;

/** 元素行数硬上限（引擎 observe 硬上限同界） */
export const elementMax = 200;

/** 每元素 hint_candidates 收集上限（兼容性 cap，引擎实际最多 4 条） */
export const hintsPerElement = 6;

/** 单条 hint 字符串上限（与引擎歧义证据 hint 界同口径） */
export const hintMaxChars = 200;

/** label 上限（与引擎 full_label 口径同界） */
export const labelMaxChars = 200;

/** href 展示投影上限（桥侧独立界） */
export const hrefMaxChars = 160;

/** why_not_admitted 诊断文本上限（词边界截断，寻址 token 不切中） */
export const whyNotAdmittedMaxChars = 400;

/** class_names 条数上限（与引擎池抽取的 8 个同界） */
export const classNamesPerElement = 8;

/** 单个 class 名上限（与引擎池抽取的 40 字符同界） */
export const classNameMaxChars = 40;

/** role/id/name 等短标识上限（桥侧独立界） */
export const identityMaxChars = 60;

/** frame_path 条数上限（与 hint 的 ≤4 段帧链声明同口径） */
export const framePathMaxItems = 4;

/** 单段帧 origin 上限（桥侧有界化，规范 origin 通常远小于此） */
export const framePathSegmentMaxChars = 64;

/** structure_path 上限（结构证据不是 hint，与 hint 的界分开） */
export const structurePathMaxChars = 160;

/** row_texts 行数上限（与引擎行上文的 ≤6 行同界） */
export const rowTextsMaxLines = 6;

/** row_texts 单行上限（与引擎的 ≤40 字符行过滤同界） */
export const rowTextsLineMaxChars = 40;

/* ----------------------------------------------------- 字段合同（生成） */

/**
 * 元素行字段的出现面闭集（与仓库表 `SESSION_ELEMENT_VIEW_FIELDS.faces` 同值域）。
 * `both` = inspect 与 session `observe` 两面都带；另两值表示只有该面带。
 */
export const ELEMENT_VIEW_FACES = ["both", "observe", "inspect"] as const;
export type ElementViewFace = (typeof ELEMENT_VIEW_FACES)[number];

/** 一个元素行字段的桥侧合同事实（键名以桥面为准）。 */
export interface ElementViewFieldSpec {
  field: string;
  faces: ElementViewFace;
  /** 能否直接作为 act/read 的动作地址（全表有且只有 `hint_candidates`）。 */
  address: boolean;
  /** 关联的上限键（`null` = 无字符/条数界）。 */
  caps: readonly string[] | null;
}

/**
 * 元素行字段合同（唯一出处 = src/support/session-contract.ts 的 SESSION_ELEMENT_VIEW_FIELDS）。
 *
 * **地址只来自 `hint_candidates`**：`address` 字段在整张表里恰好一条为 `true`，生成器断言。
 * `ref` 是展示/对账锚，`structure_path` 是诊断证据，`label`/`bbox`/`class_names` 是人读信息——
 * 它们都不可当 target；act/read/extract 的 target 只认 hint 字符串或 CSS。
 */
export const ELEMENT_VIEW_FIELDS: readonly ElementViewFieldSpec[] = [
  { field: "ref", faces: "both", address: false, caps: null },
  { field: "hint_candidates", faces: "both", address: true, caps: ["hintsPerElement", "hintMaxChars"] },
  { field: "tag", faces: "both", address: false, caps: null },
  { field: "role", faces: "both", address: false, caps: ["identityMaxChars"] },
  { field: "label", faces: "both", address: false, caps: ["labelMaxChars"] },
  { field: "label_truncated", faces: "both", address: false, caps: null },
  { field: "hints_truncated", faces: "both", address: false, caps: null },
  { field: "href", faces: "both", address: false, caps: ["hrefMaxChars"] },
  { field: "href_full", faces: "inspect", address: false, caps: ["hrefMaxChars"] },
  { field: "class_names", faces: "both", address: false, caps: ["classNamesPerElement", "classNameMaxChars"] },
  { field: "id", faces: "both", address: false, caps: ["identityMaxChars"] },
  { field: "name", faces: "both", address: false, caps: ["identityMaxChars"] },
  { field: "data_test", faces: "both", address: false, caps: ["identityMaxChars"] },
  { field: "input_type", faces: "inspect", address: false, caps: ["identityMaxChars"] },
  { field: "bbox", faces: "observe", address: false, caps: null },
  { field: "visible", faces: "observe", address: false, caps: null },
  { field: "admitted", faces: "observe", address: false, caps: null },
  { field: "why_not_admitted", faces: "observe", address: false, caps: ["whyNotAdmittedMaxChars"] },
  { field: "frame", faces: "observe", address: false, caps: null },
  { field: "frame_origin", faces: "both", address: false, caps: ["identityMaxChars"] },
  { field: "frame_path", faces: "both", address: false, caps: ["framePathMaxItems", "framePathSegmentMaxChars"] },
  { field: "row_texts", faces: "observe", address: false, caps: ["rowTextsMaxLines", "rowTextsLineMaxChars"] },
  { field: "row_index", faces: "observe", address: false, caps: null },
  { field: "structure_path", faces: "both", address: false, caps: ["structurePathMaxChars"] },
  { field: "structure_unstable", faces: "both", address: false, caps: null },
  { field: "action_family", faces: "inspect", address: false, caps: ["identityMaxChars"] },
  { field: "action_capabilities", faces: "inspect", address: false, caps: ["identityMaxChars"] },
  { field: "near", faces: "inspect", address: false, caps: ["identityMaxChars"] },
  { field: "surface", faces: "inspect", address: false, caps: ["identityMaxChars"] },
  { field: "heuristic", faces: "inspect", address: false, caps: ["identityMaxChars"] },
];
