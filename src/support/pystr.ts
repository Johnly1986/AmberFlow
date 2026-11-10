/**
 * Python 兼容的纯序列化/字符串工具（support 层最底层，只依赖 node 内建）。
 *
 * 从 `model/laya-format.ts` 的 `pyJsonDumps` 与 `data/datasource.ts` 的 py 仿真函数收敛而来：
 * 这些是纯函数，不该住在模型层或数据层——搬到这里后，任意层都能复用而不造成反向边。
 * 行为必须与移动前逐字节一致（Python `json.dumps(..., ensure_ascii=False,
 * separators=(", ", ": "), default=str)` 口径）。
 */
export function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NaN";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return "[" + value.map(pyJsonDumps).join(", ") + "]";
  if (typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${JSON.stringify(k)}: ${pyJsonDumps(v)}`).join(", ") + "}";
  }
  return JSON.stringify(String(value));
}