/**
 * 可动作性表面（Actionability Surface）——**类别表的唯一出处**。
 *
 * U3/FW5：准入面、窗口面、解析面过去恒等于一个 CSS 选择器串（`INTERACTIVE`），
 * 于是"扩面"必然同时改模型世界、窗口配额与 hint 回捞，每次都要赌池构成回归。
 * 这里把类别表与三个**投影**分开：
 *
 *   POOL_SEL   admission=="window" 的片段 —— 池/`scan` 序号/`_locatorFor` 位置回退的**唯一基准**；
 *   ADMIT_SEL  window ∪ resolve     —— 只用于**按盖章身份寻址**的面（hintLookup / windowAudit /
 *                                     A3 `_domFallbackResolve` / inspect 只读计数），**绝不用于位置序号**；
 *   focusable  只建表、默认不启用（admission:"resolve" 且不进 ADMIT_SEL，由 FOCUSABLE_ENABLED 控制）。
 *
 * **序号安全（实现纪律）**：`scan` 是"元素在该次 pass 的 sel 结果数组里的下标"。
 * POOL_FRAGMENTS 的**既有成员顺序逐字节保持今天 `INTERACTIVE` 的成员顺序**，新类目一律
 * **追加在尾部**（`INTERACTIVE_ALL = POOL_SEL + ", [data-js-ref]"` 的后缀位置也不变）。
 * 对不含新类目（summary / contenteditable='plaintext-only'）的页面，querySelectorAll 的结果
 * 集合与顺序 = 今天，因此 ref 集合 / scan 序号 / 池构成**逐字节等价**（A/B 可证）。
 *
 * 明确不做（FW5）：`[tabindex]` 入窗、`[contenteditable]` 通配（会匹配 `="false"` 关闭态）、
 * `audio|video[controls]`（Lead §7.3 拍板缓做；类目结构保留，有真实案件再一行加入）、
 * 任何 `cursor:pointer` 形式。
 */

export type SurfaceCategoryId =
  | "native-control"     // a,button,input,select,textarea —— 今天就在窗口里
  | "native-label"       // label（R1 延迟裁决，保持原逻辑）
  | "aria-role"          // 今天那 11 个 role + B2 的 5 个 role
  | "aria-widget"        // [onclick]、contenteditable、[draggable=true]
  | "native-activation"  // ★ 新增：summary（audio/video[controls] 缓做，见文件头）
  | "focusable";         // ★ 新增但只进解析面：[tabindex]（默认不启用）

export type Admission = "window" | "resolve";

/** focusable 是否进入解析面（resolve）。FW5 固定 false：“只建表不启用”。 */
export const FOCUSABLE_ENABLED = false;

/**
 * **池侧片段的有序表**——`POOL_SEL` 的唯一拼装来源。
 *
 * 纪律：这里的既有片段必须与 U3 之前 `INTERACTIVE` 的成员**与顺序逐字节一致**；
 * 新类目只能**追加在尾部**。`surface` 字段按片段顺序做首匹配分类（order 即分类优先级：
 * 一个元素同时匹配多类时归第一个片段所属类目）。
 */
export const POOL_FRAGMENTS: ReadonlyArray<readonly [SurfaceCategoryId, string]> = [
  ["native-control", "a, button, input, select, textarea"],
  ["native-label", "label"],
  ["aria-widget", "[onclick]"],
  ["aria-role", "[role='button']"],
  ["aria-role", "[role='combobox'], [role='listbox'], [role='textbox'], [role='searchbox'], [role='spinbutton']"],
  ["aria-role", "[role='checkbox'], [role='radio'], [role='switch'], [role='slider']"],
  ["aria-widget", "[contenteditable='true'], [contenteditable='']"],
  ["aria-role", "[role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox'], [role='option'], [role='tab']"],
  ["aria-widget", "[draggable='true']"],
  // ---- FW5 追加：只加在尾部，既有成员的顺序/位置不动 ----
  ["native-activation", "summary"],
  ["aria-widget", "[contenteditable='plaintext-only']"],
];

/** `meta.policy.surface` 的生效形状（缺省 = window）。 */
export interface SurfacePolicy {
  native_activation?: "window" | "resolve" | "off";
}

const activationAdmission = (policy: SurfacePolicy | undefined): Admission | "off" =>
  policy?.native_activation ?? "window";

function fragmentIncluded(id: SurfaceCategoryId, policy: SurfacePolicy | undefined): boolean {
  if (id === "focusable") return FOCUSABLE_ENABLED;
  if (id === "native-activation") return activationAdmission(policy) !== "off";
  return true;
}

function joinFragments(policy: SurfacePolicy | undefined, admissions: readonly Admission[]): string {
  const parts: string[] = [];
  for (const [id, sel] of POOL_FRAGMENTS) {
    if (!fragmentIncluded(id, policy)) continue;
    const admission = id === "native-activation" ? activationAdmission(policy) : "window";
    if (admission === "off" || !admissions.includes(admission as Admission)) continue;
    parts.push(sel);
  }
  return parts.join(", ");
}

/** 缺省策略下的池选择器；等于 U3 之前 `INTERACTIVE` + 尾部新类目。 */
export const POOL_SEL: string = joinFragments(undefined, ["window"]);

/** 缺省策略下的准入选择器（window ∪ resolve；focusable 默认关 ⇒ 当前 = POOL_SEL）。 */
export const ADMIT_SEL: string = joinFragments(undefined, ["window", "resolve"]);

/** 按 `meta.policy.surface` 取池选择器（"off" 时回到 U3 之前的池构成）。 */
export function poolSelectorFor(policy?: SurfacePolicy): string {
  return policy === undefined ? POOL_SEL : joinFragments(policy, ["window"]);
}

/** 按 `meta.policy.surface` 取准入选择器。 */
export function admitSelectorFor(policy?: SurfacePolicy): string {
  return policy === undefined ? ADMIT_SEL : joinFragments(policy, ["window", "resolve"]);
}

/**
 * CDP JS 探针后缀（`jsInteractiveWidgets` 盖的 `data-js-ref`）。它**不是类目**，但属于
 * 池/准入基准：today 的 `INTERACTIVE_ALL` 就带它，去掉会让 addEventListener 自绘控件
 * 从池与 hint 回捞里消失。位置恒在**末尾**（既有成员顺序不变）。
 */
export const JS_PROBE_SEL = "[data-js-ref]";

/** 池/序号基准的完整选择器 = 类目投影（window）+ JS 探针后缀（末尾）。 */
export function poolSelectorWithJsFor(policy?: SurfacePolicy): string {
  return `${poolSelectorFor(policy)}, ${JS_PROBE_SEL}`;
}

/** 准入面的完整选择器 = 类目投影（window ∪ resolve）+ JS 探针后缀（末尾）。 */
export function admitSelectorWithJsFor(policy?: SurfacePolicy): string {
  return `${admitSelectorFor(policy)}, ${JS_PROBE_SEL}`;
}

/** 类目窗口上限（当前只有 native-activation；固定 6，不加数字键——§7.4 拍板 1）。 */
export const WINDOW_CAPS: Partial<Record<SurfaceCategoryId, number>> = {
  "native-activation": 6,
};

/**
 * 提取 pass 的类目分类表（`[id, selector]`，按 POOL_FRAGMENTS 顺序）。
 * 传进页面函数只作为**同一个 evaluate 的参数**，不新增页面往返。
 */
export const SURFACE_SELECTORS: ReadonlyArray<readonly [SurfaceCategoryId, string]> =
  POOL_FRAGMENTS.map(([id, sel]) => [id, sel] as const);
