/**
 * `clickAt` 的坐标值规范形（U7）：`"x,y"`——**元素相对**坐标（相对目标元素 padding box
 * 左上角，与 Playwright `locator.click({position})` 同一语义），单位 CSS 像素。
 *
 * 红线不变：坐标值是**值**，只来自声明绑定（slot/dataset），不来自模型/猜测/环境。
 * 本模块是唯一解析器（executor 执行前 + ActionAdapter 共用）：**严格解析**，坏格式是
 * 结构化 `config_error` 并点名合法格式——不做隐式猜测（不接受 `center`、百分比、负偏移、
 * 指数、`x;y` 等）。越界校验（0 ≤ x < width、0 ≤ y < height）需要元素实测 bbox，
 * 属于执行期，不在本纯函数里做。
 *
 * 叶子模块（零 import）：executor 与 extraction 都能引用而不引入循环。
 */

/** 一个已解析的元素相对坐标。 */
export interface ClickAtPosition {
  x: number;
  y: number;
}

/** 合法格式说明（坏格式 reason 逐字引用这一句——报错点名格式，不让人猜）。 */
export const CLICK_AT_FORMAT =
  'clickAt value must be the string "x,y" (two non-negative integers or finite decimals, '
  + 'element-relative CSS pixels relative to the element\'s top-left corner, e.g. "50,25")';

/**
 * 严格解析 `"x,y"`：允许整体/两侧空白（`"50, 25"`），两段必须是非负十进制整数或
 * 有限小数（`.5` 也接受）。空段、第三段、符号、指数、百分号、非字符串一律失败。
 * 返回 `{ok:false, reason}` 而不是抛异常：调用方把它变成结构化 `config_error`。
 */
export function parseClickAtValue(
  value: unknown,
): { ok: true; position: ClickAtPosition } | { ok: false; reason: string } {
  if (typeof value !== "string") return { ok: false, reason: CLICK_AT_FORMAT };
  const parts = value.split(",");
  if (parts.length !== 2) return { ok: false, reason: CLICK_AT_FORMAT };
  const coord = (raw: string): number | null => {
    const s = raw.trim();
    // 只收非负十进制：不接受 +/ -、指数、百分比、十六进制、NaN/Infinity。
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const x = coord(parts[0]!);
  const y = coord(parts[1]!);
  if (x === null || y === null) return { ok: false, reason: CLICK_AT_FORMAT };
  return { ok: true, position: { x, y } };
}
