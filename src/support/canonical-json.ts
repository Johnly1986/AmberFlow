/**
 * 确定性 JSON 序列化与 sha256 的唯一出处（L0 叶子，零业务依赖）。
 *
 * 口径：对象键按字典序排序后 `JSON.stringify`、数组保序——同一结构不论构造顺序都得到逐字节
 * 相同的文本；`plan_sha256` / `inputs_sha256` / 轨迹对账都依赖这份确定性。函数/`undefined`
 * 等 JSON 之外的值按 `JSON.stringify` 的既有语义处理（对象里省略、数组里变 `null`）：
 * 本模块不增强也不猜测，只保证「同一输入 → 同一字节」。`sha256` 接受文本（按 utf8）或字节。
 */
import crypto from "node:crypto";

/** 确定性序列化：键排序，便于算 `plan_sha256`。 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = walk((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/** sha256 十六进制摘要（小写）；文本按 utf8 编码入账。 */
export function sha256(text: string | Buffer): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}
