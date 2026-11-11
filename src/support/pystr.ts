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

/* ---------------------------------------------------------------- Python 语义小工具（自 datasource.ts 搬移） */

/** Python `dict.get(k, d)`：键存在（哪怕是 null）就取它。 */
export function getOr<T>(o: unknown, k: string, dflt: T): unknown {
  return hasOwn(o, k) ? (o as Record<string, unknown>)[k] : dflt;
}

export function hasOwn(o: unknown, k: string): boolean {
  return o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k);
}

/** Python 真值判断：NaN 是**真**，0/-0/""/[]/{} 是假。 */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return true;
}

/** Python `str()`。 */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return String(v);
  }
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (isDict(v)) {
    return "{" + Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ") + "}";
  }
  return String(v);
}

/** Python `repr()`（字符串的引号选择与 Python 一致：含单引号且不含双引号时用双引号）。 */
export function pyRepr(v: unknown): string {
  if (typeof v === "string") {
    if (v.includes("'") && !v.includes('"')) {
      return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    }
    return "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  }
  return pyStr(v);
}

/** Python `str(value or "")`：先真值判断（假值 -> ""），再 `str`。 */
export function strOrEmpty(v: unknown): string {
  return pyTruthy(v) ? pyStr(v) : "";
}

/** Python `int(value)`：失败返回 null（对应 Python 抛 TypeError/ValueError 被吞）。 */
export function pyInt(v: unknown): number | null {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!/^[+-]?\d(?:_?\d)*$/.test(s)) return null;
    const parsed = Number(s.replace(/_/g, ""));
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

/** Python `len()`：只对 list/str 有值（str 按码点计数）。 */
export function pyLen(v: unknown): number | null {
  if (typeof v === "string") return Array.from(v).length;
  if (Array.isArray(v)) return v.length;
  return null;
}

/** Python 字符串比较：按 Unicode 码点。 */
export function pyStrCmp(a: string, b: string): number {
  const A = Array.from(a);
  const B = Array.from(b);
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const ca = A[i]!.codePointAt(0)!;
    const cb = B[i]!.codePointAt(0)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return A.length === B.length ? 0 : A.length < B.length ? -1 : 1;
}

/** Python `<` 的比较语义（数值含 bool；字符串按码点；其余抛 TypeError）。 */
function pyCompare(a: unknown, b: unknown): number {
  const num = (v: unknown): number | null =>
    typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? v : null;
  const na = num(a);
  const nb = num(b);
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") return pyStrCmp(a, b);
  throw new TypeError(`'<' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/** Python 元组比较（逐项，先到先判）。 */
export function pyCompareTuple(a: readonly unknown[], b: readonly unknown[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = pyCompare(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export function isDict(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Python 迭代：list -> 项，str -> 字符，dict -> 键，None -> 空。 */
export function pyIterate(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return Array.from(v);
  if (isDict(v)) return Object.keys(v);
  return []; // 数字/布尔在 Python 会抛 TypeError；这里退化为空序列（配置不会走到）
}

/** Python 元组 repr：`('curl', 'httpx')`。 */
export function pyTuple(items: readonly unknown[]): string {
  const body = items.map(pyRepr).join(", ");
  return "(" + body + (items.length === 1 ? "," : "") + ")";
}

export function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  if (isDict(v)) return "dict";
  return typeof v;
}

/** Python `json.dumps(v, ensure_ascii=False, indent=2)`。 */
export function pyJsonDumpsIndent(value: unknown, indent = 2, level = 0): string {
  const pad = " ".repeat(indent * level);
  const padIn = " ".repeat(indent * (level + 1));
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return "[\n" + value.map((v) => padIn + pyJsonDumpsIndent(v, indent, level + 1)).join(",\n") + "\n" + pad + "]";
  }
  if (isDict(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    return "{\n" + entries
      .map(([k, v]) => padIn + JSON.stringify(k) + ": " + pyJsonDumpsIndent(v, indent, level + 1))
      .join(",\n") + "\n" + pad + "}";
  }
  return pyJsonDumps(value);
}