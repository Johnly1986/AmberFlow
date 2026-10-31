/**
 * 敏感槽位/凭据的**产物脱敏**（M0 P0）。
 *
 * 政策（2026-10-31）：凭据可由用户在本机配置/环境变量/受支持存储中保存，引擎按名读取；
 * **明文凭据不得进入用例/计划/报告/trace/仓库产物**（见 `AGENTS.md` 的「硬规则」）。
 * 本模块只负责输出面：运行期仍用原值，写 result JSON / report.md / stdout / dry JSON 前统一掩码。
 *
 * 两个来源：
 *   1. 显式声明：`meta.secretSlots: ["password", "otp"]`（推荐；加载期校验必须是已声明槽位）；
 *   2. 名称启发：未声明但名字像凭据的槽位（password/secret/token/api_key/...）也掩码，宁多勿漏。
 *
 * 纪律：**不修改入参**；返回新对象。掩码只换值、保留键，报告仍能看出"这里有一个敏感槽位"。
 */

/** 槽位名启发：命中即按敏感处理（显式声明优先，启发只加不减）。 */
export const SECRET_SLOT_NAME =
  /(pass(word|wd)?|secret|token|api[_-]?key|apikey|credential|passwd|pwd|pin|cookie|session|otp)/i;

/** 掩码后的值：不保留长度/前缀，避免"长度也是信息"。 */
export const MASKED_SLOT = "***";

/** 敏感槽位键集合 = 显式声明 ∪ 名称启发（启发只对已声明槽位做，避免误伤数据槽）。 */
export function secretSlotKeys(
  declaredSlots: Iterable<string>,
  explicit?: readonly string[] | null,
): Set<string> {
  const keys = new Set<string>(explicit ?? []);
  for (const k of declaredSlots) {
    if (SECRET_SLOT_NAME.test(k)) keys.add(k);
  }
  return keys;
}

/** 返回新对象：敏感键的值换成 `***`，其余原样（不修改入参）。 */
export function maskSecretSlots<T extends Record<string, unknown>>(
  slots: T,
  keys: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(slots)) {
    out[k] = keys.has(k) ? MASKED_SLOT : v;
  }
  return out;
}


/** 从已掩码的槽位袋里收集**原始**敏感值（用于其它输出面的深扫；掩码值本身不参与）。 */
export function secretValuesFromSlots(
  slots: Record<string, unknown>,
  keys: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const v = slots[k];
    if (v === undefined || v === null || v === MASKED_SLOT) continue;
    const s = String(v);
    if (s.length > 0) out.push(s);
  }
  return out;
}

/**
 * 深扫输出对象：把敏感值的**精确出现**换成 `***`；长度 ≥4 的值还做子串替换。
 * 用于 result / report 之外的输出面（logs、step_traces.result、trace）——
 * 槽位袋本身由 `maskSecretSlots` 按键掩码；这里兜底"值被流程写进别的字段"。
 */
export function scrubSecrets<T>(value: T, secrets: readonly string[]): T {
  const literals = secrets.filter((s) => s.length > 0);
  if (literals.length === 0) return value;
  const scrub = (v: unknown): unknown => {
    if (typeof v === "string") {
      let out = v;
      for (const s of literals) {
        if (out === s) return MASKED_SLOT;
        if (s.length >= 4 && out.includes(s)) out = out.split(s).join(MASKED_SLOT);
      }
      return out;
    }
    if (Array.isArray(v)) return v.map((x) => scrub(x));
    if (v !== null && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = scrub(val);
      return o;
    }
    return v;
  };
  return scrub(value) as T;
}
