/**
 * 有界文本截断的唯一出处（模型可见证据与人读输出的统一省略号语义）。
 *
 * 语义：`text.length <= max` 原样返回；否则取前 `max - 1` 个 code unit 并以 `…` 收尾，
 * 结果长度恰为 `max`（`max === 1` = 单个省略号）。`max <= 0` 返回空串——装不下省略号的
 * 预算不产出半截标记（既有调用点的预算都是正整数，该分支不可达，只是把边界定死）。
 *
 * 按 code unit 截断、不额外修补代理对：修补会改变既有输出字节；本模块的职责是让各调用点
 * 共用同一份既有语义，不是改变截断结果。需要保留 `max` 个字符（而不是 `max - 1` + 省略号）
 * 的语义是另一回事，不走本模块（`model/page-context.ts` 的页面正文摘要即如此）。
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";
  return `${text.slice(0, max - 1)}…`;
}
