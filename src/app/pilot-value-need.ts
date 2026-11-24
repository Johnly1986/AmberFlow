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
import { clipText } from "../support/text.ts";

/** 值袋键上限：与模型视图 `label` 投影同口径（40 字符）。 */
export const VALUE_KEY_MAX = 40;

/**
 * 元素 → 值袋键：`label → name → id → tag` 兜底（各自 trim 后取第一个非空）。
 *
 * 空 label 必须回落：空键会让 `includes("")` 恒真、把任意槽位误绑到空 label 输入框——
 * 真实站点空 label 输入框很常见（Google Maps signed-out 搜索框即 label="" name="q"）。
 * tag 恒在，正常页面不会得到空键；真得到空键时 `slotKeyFor` 拒绝它参与匹配（fail-closed）。
 *
 * 注意 label 是**抽池当时的形状**，同一控件跨轮可能变（真实 Maps 搜索框首轮
 * `label="Search Google Maps"`、次轮 label 丢失只剩 `name=q`）——所以键本身不是稳定身份，
 * 稳定身份见 `valueTargetIdOf`，跨轮回放见 `bindValueFor`。
 */
export function valueKeyOf(el: Elem): string {
  const raw = String(el.label ?? "").trim()
    || String(el.name ?? "").trim()
    || String(el.id ?? "").trim()
    || String(el.tag ?? "").trim();
  return clipText(raw, VALUE_KEY_MAX);
}

/**
 * 值需求签名：`tag\0label\0data_test\0name\0id`。
 *
 * 比 `esig` 多 name/id：多枚空 label 输入框（表单页常见）只有靠 name/id 才能区分，
 * 否则「同一目标」的判定会在不同控件间串线。**含 label ⇒ 跨轮不稳**：label 形状变化即
 * 签名变化，故它只作停驶现场的证据签名，不承担跨轮回放（回放用 `valueTargetIdOf`）。
 */
export function valueSigOf(el: Elem): string {
  return [el.tag, el.label, el.data_test ?? "", el.name ?? "", el.id ?? ""].join("\u0000");
}

/**
 * 值目标的**稳定身份**：`tag\0name:<name>`，无 name 时退 `tag\0id:<id>`；两者皆空 = null。
 *
 * 为什么需要：`valueKeyOf` 首选 label，而 label 跨轮会变（同一控件首轮有 label、次轮丢失）⇒
 * 上一轮 needs_value 记录的值写在旧键下，次轮按新键查找必然失配、裸字符串 resume 也不解决
 * （Agent 得照最新 handoff 重发才行）。name 是表单提交身份（跨轮稳定）、id 是文档内唯一句柄
 * ——凭它证明「还是同一个控件」，记录值才可安全回放到本轮键（`bindValueFor` 的 drift 档）。
 * 两者皆空 = 不声称同一目标（fail-closed）：只有 tag 的控件彼此不可区分。
 */
export function valueTargetIdOf(el: Elem): string | null {
  const tag = String(el.tag ?? "").trim();
  const name = String(el.name ?? "").trim();
  if (name !== "") return `${tag}\u0000name:${name}`;
  const id = String(el.id ?? "").trim();
  if (id !== "") return `${tag}\u0000id:${id}`;
  return null;
}

/** 池内该稳定身份的出现次数（回放前要求唯一：同 name 的多枚表单控件不判「哪个要值」）。 */
export function countValueTargetId(elems: ElemPool, targetId: string): number {
  let n = 0;
  for (const el of Object.values(elems)) if (valueTargetIdOf(el) === targetId) n += 1;
  return n;
}

/** 交接证据/解锁建议用的目标描述（与驾驶步 `target` 同口径：40 字前缀）。 */
export function valueTargetOf(el: Elem): string {
  return clipText(String(el.full_label ?? el.label ?? el.text ?? el.tag ?? ""), VALUE_KEY_MAX);
}

/** 一次 needs_value 的值需求（交接证据 + resume 字符串值的确定性绑定键）。 */
export interface ValueNeed {
  /** 池内 ref（停驶现场的选中目标；仅供证据定位，不是动作地址）。 */
  ref: string;
  /** 目标描述（≤40 字前缀；给 Agent 读「哪个目标要值」）。 */
  target: string;
  /** 值袋键（`resume.value` 字符串形式的确定性绑定键）。 */
  key: string;
  /** 目标签名（停驶现场的池身份证据；含 label，跨轮可能变）。 */
  sig: string;
  /** 值目标的稳定身份（`valueTargetIdOf`；null = 无 name/id，不声称同一控件）。 */
  targetId: string | null;
}

/** 元素 → 值需求（`ref` 缺省取元素自带的 ref；调用方有池键时显式传入）。 */
export function valueNeedOf(el: Elem, ref?: string): ValueNeed {
  return {
    ref: ref ?? String(el.ref ?? ""),
    target: valueTargetOf(el),
    key: valueKeyOf(el),
    sig: valueSigOf(el),
    targetId: valueTargetIdOf(el),
  };
}

/**
 * 值袋里的 **name/id 精确别名**：本轮键（label 形状）失配时，表单控件的 name/id 是值与目标
 * 之间的真实契约（`--slots q=…` 是站点的表单身份，不是可读标签）。
 *
 * 只收**精确相等**（trim + 小写），不做子串匹配——includes 语义留给 `slotKeyFor` 的既有面，
 * 别名面若也宽松，`--slots note=…` 会误绑 `id="notebook"` 这类控件。
 */
export function valueAliasKeyOf(el: Elem, slots: Record<string, string>): string | null {
  for (const candidate of [el.name, el.id]) {
    const want = String(candidate ?? "").trim().toLowerCase();
    if (want === "") continue;
    for (const name of Object.keys(slots)) {
      if (name.trim().toLowerCase() === want) return name;
    }
  }
  return null;
}

/** 一次 fill/select 值门的裁决。 */
export interface ValueGate {
  /** 本轮目标的值需求（`needs_value` 交接即用它点名「哪个目标/哪个键要值」）。 */
  need: ValueNeed;
  kind: "ready" | "needs_value";
  /** `ready` 时交给动作的值。 */
  value?: string;
  /** 同控件本轮键漂移（旧键→新键；记录值已回放到新键）。 */
  drift: { from: string; to: string } | null;
  /**
   * 上一轮记录值属于**另一个**控件（name/id 已变）⇒ 记录值不回放（不粘）。
   * 结构化证据：`from` = 旧记录键，`to` = 本轮键（只含键名，不含值）。
   */
  stale: { from: string; to: string } | null;
}

/**
 * `executePicked` 的 fill/select 值门（唯一裁决点；值袋是同一份可变记录，命中即写）。
 *
 * 三档，顺序确定：
 *   ① 键命中——本轮键与值袋键相等/双向互含（既有语义逐字节不变），或 name/id **精确别名**命中
 *      （`--slots q=…` 这类表单身份槽位）；命中即用该值，不改写值袋。
 *   ② 键漂移回放——本轮键失配，但上一轮 needs_value 的稳定身份（`valueTargetIdOf`）与本轮控件
 *      相同、该身份在池内唯一、且值袋里确有上一轮记录的那个值 ⇒ 把该值写到本轮键（label 形状
 *      变化不再要求 Agent 照最新 handoff 重发）。值来自 Agent 已显式给过的那份，引擎不发明值。
 *   ③ 落空 → `needs_value`；`stale` 只表示「身份明确不同」这一种证据事实（老值不跟到新控件）。
 *
 * `prev` = 上一轮 needs_value 记录（`PilotRuntime.valueNeed`）；resume 后清空的是它记录的值需求，
 * 不是这里读的 prev——调用方在成功消费值后清 `valueNeed`，于是回放只发生一次。
 */
export function bindValueFor(a: {
  slots: Record<string, string>;
  need: ValueNeed;
  el: Elem;
  pool: ElemPool;
  prev: ValueNeed | null;
}): ValueGate {
  const direct = slotKeyFor(a.need.key, a.slots);
  const directValue = direct === null ? undefined : a.slots[direct];
  if (directValue !== undefined) {
    return { need: a.need, kind: "ready", value: directValue, drift: null, stale: null };
  }
  const alias = valueAliasKeyOf(a.el, a.slots);
  if (alias !== null) {
    return { need: a.need, kind: "ready", value: a.slots[alias], drift: null, stale: null };
  }

  const prev = a.prev;
  const nowId = valueTargetIdOf(a.el);
  const stale = prev !== null && prev.targetId !== null && nowId !== prev.targetId
    ? { from: prev.key, to: a.need.key } : null;
  const miss: ValueGate = { need: a.need, kind: "needs_value", drift: null, stale };
  if (prev === null || prev.targetId === null || nowId === null || nowId !== prev.targetId) return miss;
  if (countValueTargetId(a.pool, nowId) !== 1) return { ...miss, stale: null };
  const prevSlot = a.slots[prev.key] !== undefined ? prev.key : slotKeyFor(prev.key, a.slots);
  const prevValue = prevSlot === null ? undefined : a.slots[prevSlot];
  if (prevValue === undefined) return { ...miss, stale: null };
  const key = a.need.key;
  // 空键不参与绑定（与 `slotKeyFor` 同一 fail-closed 口径）。本轮键已有值的情况到不了这里：
  // `slotKeyFor` 的相等分支已把「键在袋里」全收走，到不了 = 袋里没有该键。
  if (key === "") return { ...miss, stale: null };
  a.slots[key] = prevValue;
  return {
    need: a.need, kind: "ready", value: prevValue,
    drift: prev.key === key ? null : { from: prev.key, to: key }, stale: null,
  };
}

/** 在池里按值需求签名回找同一目标（停驶现场身份核对；找不到 = null，绝不猜）。 */
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
