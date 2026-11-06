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

import type { ElemFamily } from "./extraction.ts";

export type SurfaceCategoryId =
  | "native-control"     // a,button,input,select,textarea —— 今天就在窗口里
  | "native-label"       // label（R1 延迟裁决，保持原逻辑）
  | "aria-role"          // 今天那 11 个 role + B2 的 5 个 role
  | "aria-widget"        // [onclick]、contenteditable、[draggable=true]
  | "native-activation"  // ★ 新增：summary（audio/video[controls] 缓做，见文件头）
  | "focusable";         // ★ 新增但只进解析面：[tabindex]（默认不启用）

export type Admission = "window" | "resolve";

export interface SurfaceCategory {
  id: SurfaceCategoryId;
  /** 该类的选择器片段（逗号表成员；禁止后代/伪类：见 matchSelector 可表达子集）。 */
  selector: string;
  admission: Admission;
  /** 可见性口径：window 类目一律 visible-box（由提取 pass 的 checkVisibility 实施）。 */
  visibility: "visible-box" | "any";
  /** 仅作 hint/pick 的软先验默认值（不是硬过滤）。 */
  family: ElemFamily;
  /** 窗口内该类目的名额上限（缺省不限）；cap 命中时该元素不进池，自然计入 windowAudit 的 out_of_window。 */
  windowCap?: number;
  note: string;
}

export const SURFACE: readonly SurfaceCategory[] = [
  {
    id: "native-control", selector: "a, button, input, select, textarea",
    admission: "window", visibility: "visible-box", family: "click",
    note: "原生可激活控件：今天的窗口成员，语义与配额不变。",
  },
  {
    id: "native-label", selector: "label",
    admission: "window", visibility: "visible-box", family: "click",
    note: "R1 延迟裁决：关联控件自身可见时跳过，避免同控件双份候选。",
  },
  {
    id: "aria-role", admission: "window", visibility: "visible-box", family: "click",
    selector: "[role='button'], [role='combobox'], [role='listbox'], [role='textbox'], [role='searchbox'], "
      + "[role='spinbutton'], [role='checkbox'], [role='radio'], [role='switch'], [role='slider'], "
      + "[role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox'], [role='option'], [role='tab']",
    note: "ARIA 自绘控件：前 11 个是既有角色，后 5 个是 B2 扩面（全局行为变更）。",
  },
  {
    id: "aria-widget", admission: "window", visibility: "visible-box", family: "click",
    selector: "[onclick], [contenteditable='true'], [contenteditable=''], [contenteditable='plaintext-only'], [draggable='true']",
    note: "通用可交互属性。[contenteditable='plaintext-only'] 是显式追加；绝不用 [contenteditable] 通配（会匹配 =\"false\" 关闭态）。",
  },
  {
    id: "native-activation", selector: "summary",
    admission: "window", visibility: "visible-box", family: "click", windowCap: 6,
    note: "原生激活元素（U3 根因）：<summary> 是 details 的切换面，点击后内部内容才进入可动作面。"
      + "窗口 cap=6（固定，不加数字键）：30 条 FAQ 的 30 个 summary 不得把页头按钮挤出窗口。"
      + "audio[controls]/video[controls] 缓做（§7.3 拍板）：类目结构保留，有真实案件再追加。",
  },
  {
    id: "focusable", selector: "[tabindex]",
    admission: "resolve", visibility: "any", family: "click",
    note: "★只建表、默认不启用：[tabindex] 是\"可聚焦\"事实，不是\"可激活\"证据。"
      + "FOCUSABLE_ENABLED=false 时既不进 POOL_SEL 也不进 ADMIT_SEL；tabindex-only 页面池仍为 0（ready_empty 而非伪候选）。",
  },
];

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
