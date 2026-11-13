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
  /**
   * S3：存在任一匹配 selector 且（可见）文本含 text 的元素。live = Playwright
   * `locator(selector, { hasText })`（跨主 frame 与可达的子 frame，同源/跨源均可定位；大小写不敏感子串）；
   * 离线池评估是**近似**（匹配元素的合成 label 包含 text）。
   */
  css_exists_text: 2,
  /** S3：存在且可见（首匹配 locator.isVisible）；池/离线面不可判定（null）。 */
  css_visible_exists: 1,
  css_text_equals: 2,
  css_text_contains: 2,
  css_value_equals: 2,
  /**
   * E5：匹配 selector 的元素总数（主 frame + 可达子 frame 合计）恰等于 / 至少为 N。
   * live = 各帧 locator.count() 求和；离线池评估 = matchSelector 命中数（池近似，
   * 池表达不了的选择器返回 null = 待 live 验证）。列表页"恰好 25 行商品"、懒加载
   * "至少 10 行"是它的主场——旧行只能数 `css_exists` 的 0/1 面。
   */
  css_count_equals: 2,
  css_count_min: 2,
};
