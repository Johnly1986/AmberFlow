/**
 * 信号算子表（叶子模块：零 import）。
 *
 * 从 `signals.ts` 抽出的原因：`grammar-prompt.ts`（语法描述的提示词出处）要引用它，
 * 而那条链上的 `signals.ts → extraction.ts` 有 1100+ 行浏览器面 JS 与模块级编译——
 * "描述语法"这件事不该为此付出加载代价。`signals.ts` 保持 re-export，API 不变。
 *
 * 值 = 算子的参数个数；**0 = 无参叶子**（`manual`，值不参与校验）。
 */
export const SIGNAL_OPS: Readonly<Record<string, number>> = {
  // composition (leaves stay DOM facts, so composing cannot weaken them)
  all_of: 1,
  any_of: 1,
  not: 1,
  // a human attestation: never verifiable from the DOM, so it blocks without a human
  manual: 0,
  url_contains: 1,
  css_exists: 1,
  css_text_equals: 2,
  css_text_contains: 2,
  css_value_equals: 2,
};
