/**
 * `amber pilot` 的**值需求键推导**（pilot-runtime 拆出；值绑定纪律见
 * docs/PILOTED_WALKTHROUGH_PLAN.md 与 docs/AGENT_INTERFACE.md 的 drive 系列 op）。
 *
 * 为什么独立成模块：pilot-runtime 已有 800 行硬顶（`tools/maintain/size.ts`），而值绑定要从
 * 「元素」推出「值袋键」——这是纯函数面，放这里也便于零模型 lane 直接断言（verify:pilot）。
 *
 * 纪律：值不猜。本模块只回答「这个元素的值该挂在哪个键上、这个 needs_value 指向哪个目标」，
 * 绝不产生值本身（值只来自预声明 slots 或 Agent resume 的显式 value）。
 */
import type { Elem, ElemPool } from "../engine/elem-model.ts";

/** 值袋键上限：与模型视图 `label` 投影同口径（40 字符）。 */
export const VALUE_KEY_MAX = 40;

const buf = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/**
 * 元素 → 值袋键：`label → name → id → tag` 兜底（各自 trim 后取第一个非空）。
 *
 * 空 label 必须回落：空键会让 `includes("")` 恒真、把任意槽位误绑到空 label 输入框——
 * 真实站点空 label 输入框很常见（Google Maps signed-out 搜索框即 label="" name="q"）。
 * tag 恒在，正常页面不会得到空键；真得到空键时 `slotKeyFor` 拒绝它参与匹配（fail-closed）。
 */
export function valueKeyOf(el: Elem): string {
  const raw = String(el.label ?? "").trim()
    || String(el.name ?? "").trim()
    || String(el.id ?? "").trim()
    || String(el.tag ?? "").trim();
  return buf(raw, VALUE_KEY_MAX);
}

/**
 * 值需求签名：`tag\0label\0data_test\0name\0id`。
 *
 * 比 `esig` 多 name/id：多枚空 label 输入框（表单页常见）只有靠 name/id 才能区分，
 * 否则「同一目标」的判定会在不同控件间串线。
 */
export function valueSigOf(el: Elem): string {
  return [el.tag, el.label, el.data_test ?? "", el.name ?? "", el.id ?? ""].join("\u0000");
}

/** 交接证据/解锁建议用的目标描述（与驾驶步 `target` 同口径：40 字前缀）。 */
export function valueTargetOf(el: Elem): string {
  return buf(String(el.full_label ?? el.label ?? el.text ?? el.tag ?? ""), VALUE_KEY_MAX);
}

/** 一次 needs_value 的值需求（交接证据 + resume 字符串值的确定性绑定键）。 */
export interface ValueNeed {
  /** 池内 ref（停驶现场的选中目标；仅供证据定位，不是动作地址）。 */
  ref: string;
  /** 目标描述（≤40 字前缀；给 Agent 读「哪个目标要值」）。 */
  target: string;
  /** 值袋键（`resume.value` 字符串形式的确定性绑定键）。 */
  key: string;
  /** 目标签名（跨轮抽池的身份；同签名 = 引擎自己判定过的同一目标）。 */
  sig: string;
}

/** 元素 → 值需求（`ref` 缺省取元素自带的 ref；调用方有池键时显式传入）。 */
export function valueNeedOf(el: Elem, ref?: string): ValueNeed {
  return {
    ref: ref ?? String(el.ref ?? ""),
    target: valueTargetOf(el),
    key: valueKeyOf(el),
    sig: valueSigOf(el),
  };
}

/** 在池里按值需求签名回找同一目标（M2 确定性回放的底座；找不到 = null，绝不猜）。 */
export function findPoolRefBySig(elems: ElemPool, sig: string): string | null {
  for (const [ref, el] of Object.entries(elems)) {
    if (valueSigOf(el) === sig) return ref;
  }
  return null;
}

/**
 * 在值袋里找与元素键匹配的已声明槽位键（相等或双向 includes；空键不参与）。
 *
 * 双向 includes 保留既有宽松语义：预声明 `--slots "search=…"` 配 label "Search Google Maps"
 * 仍能命中；但空键/空白键不再"匹配一切"（`includes("")` 恒真的误绑已由此堵住）。
 */
export function slotKeyFor(key: string, slots: Record<string, string>): string | null {
  const k = key.trim().toLowerCase();
  if (k === "") return null;
  for (const name of Object.keys(slots)) {
    const n = name.trim().toLowerCase();
    if (n === "" || n !== k && !k.includes(n) && !n.includes(k)) continue;
    return name;
  }
  return null;
}
