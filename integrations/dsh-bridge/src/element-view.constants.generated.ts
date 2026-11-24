/**
 * 生成物（勿手改）：由 tools/session-contract-gen.ts 从 src/support/session-contract.ts 的
 * SESSION_ELEMENT_VIEW_LIMITS 生成（check in）。
 * 重新生成：node --experimental-strip-types tools/session-contract-gen.ts --write
 * 校验：node --experimental-strip-types tools/session-contract-gen.ts --check
 *
 * 桥包自带 tsconfig（rootDir=src）不能 import 仓库 src，所以 ElementView 行的上限以常量
 * 投影到这里；引擎侧同界由生成器逐项交叉校验。
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
