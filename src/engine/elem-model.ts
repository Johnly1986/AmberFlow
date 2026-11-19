/**
 * 元素模型（element model）——`Elem` 形状与动作能力面的**唯一出处**。
 *
 * 从 extraction.ts 纯搬移而来（本轮大文件拆分）：池行形状、动作族、动作能力面、签名/槽位助手
 * 都在这里；JS 扫描/帧门禁/语言观察仍在 extraction/frame-scope。搬移不改任何语义，
 * 既有 importer 经 extraction re-export 零改动。
 */
import { parseClickAtValue } from "./click-at.ts";

/* ------------------------------------------------------------------ element model */

/** 完整标签上限（`full_label`；hint 匹配口径，池行与文档共用）。 */
export const FULL_LABEL_MAX = 200;
/** 模型视图标签前缀上限（`label`；恒为 `full_label` 的前缀）。 */
export const MODEL_LABEL_MAX = 40;

export interface Elem {
  ref?: string;
  scan?: number;
  tag: string;
  label: string;
  data_test?: string;
  /**
   * F75：A3 DOM 回退面合成行的探针句柄（`data-af-probe="<批次>-<序号>"` 的值）——run 决策步
   * 复用回退面时 `_locatorFor` 的 af_probe 首分支据此重建 locator。仅合成行携带；真池行
   * 恒缺省（键不出现 = 行为不变）。
   */
  af_probe?: string;
  /**
   * clickxy：文本 bbox 中心坐标点击的**合成行**标记（`{x,y}` = 视口 CSS 像素中心）。
   * 仅 `_resolveClickxyFallback` 的合成行携带（最后手段：文本定位成功但无任何可用句柄时）；
   * 执行单点 = `_clickOnly` 的 clickxy 首分支（page.mouse.click），**不经 locator**。
   * 危险门控：该行强制走确认闸门（`risky=true` → `confirmFn`，缺省拒绝）。
   */
  clickxy?: { x: number; y: number };
  name?: string;
  id?: string;
  /**
   * E3：祖先链上的 id 集合（小写；≤8 个，最近祖先在前）——`within:#id` 尾缀的
   * 池侧判定底座（纯内存：锚 id ∈ anchor_ids ⇔ 元素在锚子树内）。提取期一次
   * 算好；无 id 祖先的普通页面 = 空数组（池行多一个空字段，匹配面零开销）。
   */
  anchor_ids?: string[];
  input_type?: string;
  href?: string;
  /**
   * T9：**原始** `getAttribute('href')`（原样保留 query/fragment/origin，不切段）。
   * `href` 仍是展示投影（模型视图/criteriaView 用的就是它），本字段只服务 hint 匹配
   * （rules.ts 的 href 双字段底座）与 inspect 的观察面；不进 `ChoiceRequest.elems`
   * （executor.pickInner 剥离，与 `surface` 同一处）。空 href 不出现（空即缺省）。
   */
  href_full?: string;
  /** 显式 ARIA 角色（`getAttribute('role')`；没有就不出现——对拍语料逐字节不变）。 */
  role?: string;
  /** `contenteditable` 为真（语义上是"可填"，结构上不是 input/textarea）。 */
  content_editable?: boolean;
  near?: string;
  /**
   * F82（in-row 行锚）：行上下文文本（≤6 行、每行 ≤40 字符）——`in-row:<token>` 尾缀的池侧
   * 匹配底座（rules.rowMatch 单档 includes，仅小写折叠）与 suggestHints 第 5 档的词元来源。
   * **仅同文案重复组元素携带**（与 near 同触发：addNearContext / OBSERVE_JS dup 门控 /
   * HINT_HEAD in-row 门 / A3 DOM fallback 行）——行锚只服务"同文案网格"这一它要解决的问题，
   * 非重复组写 in-row = 恒落空（fail-closed 对称，R6）。**不进模型面**
   * （`modelProjectionOf` guard+解构两处剥离，F14/T9 同纪律）；**不进 esig/firstIfSame 签名**；
   * 只服务匹配/回捞/建议。与 near 的一句话分工：near = 模型视图单行（宿主挑选后的展示装饰），
   * row_texts = in-row 匹配底座（自证候选的词元来源）。
   */
  row_texts?: string[];
  /**
   * F83（row-index 顺序行锚）：dup 组内 **DOM 先序位次**（1-based）——`row-index:N` 尾缀的
   * 池侧匹配底座（整数全等比较）与 suggestHints 第 6 档的序号来源。编号口径（v1.0 §3.4）：
   * 帧内 (tag+label) dup 子组按 scan 升序——单帧场景 = 纯 DOM 先序；跨帧同名网格各自编号。
   * **仅同文案重复组元素携带**（与 near/row_texts 同触发）；**不进模型面**
   * （`modelProjectionOf` guard+解构两处剥离）、**不进 esig/firstIfSame 签名**；只服务匹配/
   * 回捞/建议/证据。序号即语义的合法场景（排序榜/排序命令后点第 N 行）由作者显式承担序漂移。
   */
  row_index?: number;
  /**
   * U3 类目标记（native-control / native-label / aria-role / aria-widget / native-activation）。
   * **只进 PoolView / inspect / 类目计数**，不进 `ChoiceRequest.elems` 的模型投影（F14）。
   */
  surface?: string;
  frame?: number;
  /**
   * A 批（frame:<origin> 帧限定）：元素所在帧的 origin（小写 http(s) 规范形）与祖先 origin
   * 链（外→内）。`frame_path` 省略 = 主帧（帧链 = [frame_origin]）；两字段都缺 = 未知
   * origin 帧（about:blank/srcdoc/空串等）——该帧内元素**不可被任何 `frame:` 命中**。
   * 打点唯一出处 = frame-scope.elemFrameStamp；消费点：rules.hintMatchImpl 入口过滤
   * （档位在帧内计算）与 PoolView 展示。不进 `ChoiceRequest.elems`（pickInner 剥离，
   * 与 surface 同一处）；**不进 esig/firstIfSame 签名**。
   */
  frame_origin?: string;
  frame_path?: string[];
  /**
   * B 批：结构证据（仅 inspect 的 `structurePath` opt-in 时出现；≤160 字符）。祖先 tag/`#id`
   * + 同 tag 兄弟序号 + 帧下标前缀（如 `f2>div#panel>button[2]`）。**只作诊断**：动态页面
   * （重排/虚拟列表/插入广告）随时失效，**不可照抄进 hint/target**；不进模型面
   * （`modelProjectionOf` 剥离）、不进歧义证据（`describeAmbiguity` 是零页面 I/O 纯函数）。
   */
  structure_path?: string;
  /** 结构证据的不稳定标记（与 `structure_path` 同出现：一眼看出"不是 hint"）。 */
  structure_unstable?: true;
  js_events?: unknown;
  js_ref?: string;
  dsh_ref?: string;
  /**
   * A2 分桶/可寻址（只读诊断字段；主池每个候选都有）：
   *   full_label —— 完整可读标签（≤200 字符；`label` 仍是模型视图的前缀 40，别拿它做完整匹配）；
   *   rect/inViewport/nearViewport —— 提取那一刻相对**当前视口**的几何（不滚动、不追视口）；
   *   scrollDepth/inScrollContainer —— 到最近可滚动祖先的层数（0 = 不在滚动容器里）；
   *   bucket/prio —— 分桶闭集（chrome/viewport/contentNear/mainOffscreen/other）与优先级（仅诊断）。
   */
  full_label?: string;
  /**
   * P0-A（inspect 观察面 opt-in）：`label_full` 是**不截断**的完整标签（`full_label` 仍是
   * ≤200 的匹配口径）；`class_names` 有界（≤8 个、每项 ≤40 字符）。缺省不出现 ⇒ 池/模型面
   * 与既有产物逐字节不变。
   */
  label_full?: string;
  class_names?: string[];
  rect?: { top: number; left: number; width: number; height: number };
  inViewport?: boolean;
  nearViewport?: boolean;
  scrollDepth?: number;
  inScrollContainer?: boolean;
  bucket?: PoolBucket;
  prio?: number;
  /**
   * 一区域一候选的采集期事实（EXTRACT_JS 采集期计算；只进证据面/审计，不进模型投影——
   * `modelProjectionOf` guard+解构两处剥离，与 surface/row_texts 同纪律；不进 esig/firstIfSame 签名）：
   *   contains_candidate —— 该候选的子树里还有其它候选（祖先打标 ≤32 层）；
   *   kind —— container = 含候选后代 且（自身无文案 或 与内层候选同 label），否则 atomic
   *   （键只在 container 出现：atomic = 缺省）；
   *   prominence —— 分桶醒目度：viewport 桶用可见交集面积（真人此刻看到多少），
   *   视口外桶用原始 rect 面积（看不到但体积大仍可能是主控件）；排序平局由 scan 定。
   */
  contains_candidate?: true;
  kind?: "container";
  prominence?: number;
  [k: string]: unknown;
}
export type ElemPool = Record<string, Elem>;

/**
 * 元素**动作族**（S2 ③ 运行期接线 + 页面状态采集共用）。
 *
 * 判据与执行器自己的分类**同一份**（`_isCheckable` / `_isTyping` / `_isSubmit`）：
 *   - check：input[type=checkbox|radio]
 *   - select：`<select>`
 *   - fill：input/textarea（不含 submit/button/checkbox/radio/file）
 *   - upload：input[type=file]（file 不是文本输入；上传是独立原语，见 U6）
 *   - click：其余（a / button / input[type=submit|button] / 其它可点元素）
 * 为什么必须单一出处：提名指令收窄元素池时，窄出的池子必须正好是"这条指令能作用的那一族"；
 * 两处各判一次就会漂移（本仓 hint 语法漂移过两次，同一条教训）。
 */
export type ElemFamily = "click" | "fill" | "select" | "check" | "upload";

export function elemFamily(e: Elem): ElemFamily {
  const type = String(e.input_type ?? "").toLowerCase();
  const role = String(e.role ?? "").toLowerCase();
  // ---- 语义角色优先（结构族 ≠ 语义动作；2026-10-18 推敲）----
  // 显式 ARIA 角色说的就是"这个控件能做什么"，比标签名可靠：
  //   role=combobox/listbox → select（div/span 做的下拉）
  //   role=checkbox/radio/switch → check
  //   role=textbox/searchbox/spinbutton → fill（自定义输入控件）
  if (role === "combobox" || role === "listbox" || role === "menulist") return "select";
  if (role === "checkbox" || role === "radio" || role === "switch") return "check";
  if (role === "textbox" || role === "searchbox" || role === "spinbutton") return "fill";
  // B2 扩面的五个 role（menuitem / menuitemradio / menuitemcheckbox / option / tab）**有意不设
  // 显式分支**：上面的 select/check/fill 清单都不收它们，落到底部默认 return "click"
  // （menuitemradio/menuitemcheckbox 的选中语义也是 click 驱动，不放 check/slider 族）。
  if (e.content_editable === true) return "fill";       // contenteditable：可填，但不是 input/textarea
  // ---- 原生标签（没有显式角色时按结构与 input type 判）----
  if (e.tag === "input" && (type === "checkbox" || type === "radio")) return "check";
  // U6：文件输入不是文本输入，单独一族——upload 能力面只对它成立。
  if (e.tag === "input" && type === "file") return "upload";
  if (e.tag === "select") return "select";
  if (role === "button" || role === "link") return "click";
  if ((e.tag === "input" || e.tag === "textarea") && type !== "submit" && type !== "button") return "fill";
  return "click";
}

/**
 * 元素能力面：同一条结构化规则给出"它到底能做什么"。
 * `elemFamily` 仍然是提名/修复用的单一动作族；`actionCapabilities` 面向 PoolView/inspect，
 * 可以表达 role=slider / input[type=range] 这类特殊控件。注意：native range 目前
 * 可由引擎的 `fill` 动作驱动；div[role=slider] 仍是 click 族，当前动作集不能设 aria-valuenow。
 */
export type ActionCapability = "click" | "clickAt" | "fill" | "select" | "check" | "slider" | "scroll" | "drag" | "hover" | "upload";

/** 执行动作所需的最小 locator 面；由执行器/PoolView 的调用方提供。 */
export interface ActionLocatorLike {
  click(opts?: Record<string, unknown>): Promise<void>;
  fill(value: string, opts?: Record<string, unknown>): Promise<void>;
  selectOption(value: unknown, opts?: Record<string, unknown>): Promise<void>;
  /** S4：指针悬停原语（可选——未提供时按 action_unsupported 报）。 */
  hover?(opts?: Record<string, unknown>): Promise<void>;
  /** U6：文件上传原语（Playwright locator.setInputFiles；可选，缺了按 action_unsupported 报）。 */
  setInputFiles?(files: unknown, opts?: Record<string, unknown>): Promise<void>;
  /** U7：clickAt 越界校验要的实测盒（Playwright locator.boundingBox；可选，缺了按测不到报）。 */
  boundingBox?(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
}

/**
 * ActionAdapter：显式能力面——"元素能做什么"收敛在这里，不散在动作实现里。
 * `canApply` 是 PoolView / inspect 的静态能力判定；`apply` 是执行器未来接入的同一能力面。
 * 模型不能发明动作；它只能点能力面里已声明的 kind。
 */
export interface ActionAdapter {
  kind: ActionCapability;
  canApply(e: Elem): boolean;
  apply(loc: ActionLocatorLike, opts?: { value?: string; timeoutMs?: number }): Promise<[string, unknown]>;
}

const CLICK_ADAPTER: ActionAdapter = {
  kind: "click",
  canApply: (e) => elemFamily(e) === "click",
  async apply(loc, { timeoutMs = 5000 } = {}) {
    await loc.click({ timeout: timeoutMs });
    return ["clicked", null];
  },
};

/**
 * U7：坐标点击原语（命令闭集的 `clickAt` op）。能力面与 click 族**同一集合**
 * （canvas 这类元素在池里归 click 族）；坐标是**元素相对**坐标，只来自声明绑定。
 * 真正执行入口是 executor `_executeElement(clickAt)`（含 bbox 越界校验）；本 adapter
 * 保留同一能力面声明与一份等价的 apply 供未来接入，不另开动作生成路径。
 */
const CLICK_AT_ADAPTER: ActionAdapter = {
  kind: "clickAt",
  canApply: (e) => elemFamily(e) === "click",
  async apply(loc, { value, timeoutMs = 5000 } = {}) {
    const parsed = parseClickAtValue(value);
    if (!parsed.ok) return ["config_error", parsed.reason];
    const box = typeof loc.boundingBox === "function" ? await loc.boundingBox() : null;
    if (box === null) return ["action_failed", "clickAt: element has no bounding box (detached or zero-size)"];
    const { x, y } = parsed.position;
    if (x < 0 || x >= box.width || y < 0 || y >= box.height) {
      return ["config_error",
        `clickAt position ${x},${y} is outside the element: measured ${box.width}x${box.height} `
        + `(need 0 <= x < ${box.width}, 0 <= y < ${box.height})`];
    }
    await loc.click({ position: { x, y }, timeout: timeoutMs });
    return ["clicked", { x, y }];
  },
};

const CHECK_ADAPTER: ActionAdapter = {
  kind: "check",
  canApply: (e) => elemFamily(e) === "check",
  async apply(loc, { timeoutMs = 5000 } = {}) {
    await loc.click({ timeout: timeoutMs });
    return ["clicked", null];
  },
};

const FILL_ADAPTER: ActionAdapter = {
  kind: "fill",
  canApply: (e) => elemFamily(e) === "fill",
  async apply(loc, { value, timeoutMs = 5000 } = {}) {
    if (value === undefined || value === null) return ["needs_value", null];
    await loc.fill(String(value), { timeout: timeoutMs });
    return ["filled", value];
  },
};

const SELECT_ADAPTER: ActionAdapter = {
  kind: "select",
  canApply: (e) => elemFamily(e) === "select",
  async apply(loc, { value, timeoutMs = 5000 } = {}) {
    if (value === undefined || value === null) return ["needs_value", null];
    try {
      await loc.selectOption({ label: String(value) }, { timeout: Math.min(1500, timeoutMs) });
    } catch {
      await loc.selectOption({ value: String(value) }, { timeout: timeoutMs });
    }
    return ["filled", value];
  },
};

const SLIDER_ADAPTER: ActionAdapter = {
  kind: "slider",
  canApply: (e) => String(e.role ?? "").toLowerCase() === "slider"
    || (e.tag === "input" && String(e.input_type ?? "").toLowerCase() === "range"),
  async apply(loc, { value, timeoutMs = 5000 } = {}) {
    if (value === undefined || value === null) return ["needs_value", null];
    await loc.fill(String(value), { timeout: timeoutMs });
    return ["filled", value];
  },
};

const DRAG_ADAPTER: ActionAdapter = {
  kind: "drag",
  canApply: (e) => e.draggable === true
    || String(e.role ?? "").toLowerCase() === "slider"
    || (e.tag === "input" && String(e.input_type ?? "").toLowerCase() === "range"),
  async apply(loc, { value, timeoutMs = 5000 } = {}) {
    if (value === undefined || value === null || !String(value).trim()) return ["needs_value", null];
    const dragTo = (loc as unknown as { dragTo?: (target: unknown, o?: unknown) => Promise<void> }).dragTo;
    if (typeof dragTo !== "function") return ["action_unsupported", "locator has no dragTo"];
    await dragTo.call(loc, { selector: String(value) }, { timeout: timeoutMs });
    return ["dragged", value];
  },
};

const SCROLL_ADAPTER: ActionAdapter = {
  kind: "scroll",
  canApply: () => true,   // scrollIntoView 是 viewport 语义，任何已定位元素都可用
  async apply(loc) {
    await loc.evaluate(String.raw`(el) => {
      if (typeof el.scrollIntoViewIfNeeded === 'function') el.scrollIntoViewIfNeeded({ block: 'center', behavior: 'instant' });
      else el.scrollIntoView({ block: 'center', behavior: 'instant' });
    }`);
    return ["scrolled", null];
  },
};

/**
 * S4：hover 原语（命令闭集的 `hover` op）。池里只有**可交互**元素（INTERACTIVE_ALL），
 * 悬停是任何已定位元素都有的指针语义（与 scroll 的 viewport 语义同款），所以能力面恒真；
 * 它只改变指针位置，不点击、不导航——展开 `:hover` 菜单/图层面板正是它的用途。
 */
const HOVER_ADAPTER: ActionAdapter = {
  kind: "hover",
  canApply: () => true,
  async apply(loc, { timeoutMs = 5000 } = {}) {
    if (typeof loc.hover !== "function") return ["action_unsupported", "locator has no hover"];
    await loc.hover({ timeout: timeoutMs });
    return ["hovered", null];
  },
};

/**
 * U6：上传原语（命令闭集的 `upload` op）。能力面**只**对 `input[type=file]` 成立；
 * 值只来自声明绑定（slot/dataset；option/list 不适用），由执行器 `_executeElement` 归一成路径列表后
 * 调 `locator.setInputFiles`。这里保留 adapter 形状供 `actionCapabilities`/PoolView 使用。
 */
const UPLOAD_ADAPTER: ActionAdapter = {
  kind: "upload",
  canApply: (e) => e.tag === "input" && String(e.input_type ?? "").toLowerCase() === "file",
  async apply(loc, { value, timeoutMs = 5000 } = {}) {
    if (value === undefined || value === null || String(value).trim() === "") return ["needs_value", null];
    const setInputFiles = (loc as unknown as {
      setInputFiles?: (files: unknown, o?: unknown) => Promise<void>;
    }).setInputFiles;
    if (typeof setInputFiles !== "function") return ["action_unsupported", "locator has no setInputFiles"];
    await setInputFiles.call(loc, String(value), { timeout: timeoutMs });
    return ["uploaded", value];
  },
};

export const ACTION_ADAPTERS: readonly ActionAdapter[] = [
  DRAG_ADAPTER, SCROLL_ADAPTER, SLIDER_ADAPTER, CHECK_ADAPTER, SELECT_ADAPTER, FILL_ADAPTER, CLICK_ADAPTER,
  CLICK_AT_ADAPTER, HOVER_ADAPTER, UPLOAD_ADAPTER,
];

export function actionCapabilities(e: Elem): ActionCapability[] {
  const out: ActionCapability[] = [];
  for (const adapter of ACTION_ADAPTERS) if (adapter.canApply(e) && !out.includes(adapter.kind)) out.push(adapter.kind);
  return out;
}

/** 按动作族过滤元素池（**只用于有界修复**；ref 保留原值）。 */
export function filterElemsByFamily(elems: ElemPool, family: ElemFamily): ElemPool {
  const out: ElemPool = {};
  for (const [ref, e] of Object.entries(elems)) if (elemFamily(e) === family) out[ref] = e;
  return out;
}

/**
 * 按动作族**排序**元素池（不丢信息）：该族在前、其余在后。
 *
 * 这是"提名族作为**软先验**"的载体——各族元素都还在候选里（其他族的元素既可能是真目标，
 * 也可能是解出目标的上下文：`div[role=combobox]` 是 click 族却是 select、`contenteditable`
 * 是 click 族却是 fill、`input[type=range]` 是 fill 族却是设值），排序只让该族优先被规则/模型看到。
 * 结构族 ≠ 语义动作，所以**不能**拿它硬过滤。
 */
export function orderElemsByFamily(elems: ElemPool, family: ElemFamily): ElemPool {
  const first: ElemPool = {};
  const rest: ElemPool = {};
  for (const [ref, e] of Object.entries(elems)) {
    if (elemFamily(e) === family) first[ref] = e;
    else rest[ref] = e;
  }
  return { ...first, ...rest };
}

/**
 * Element signature for stale-forbidden pruning. refs are POSITIONAL
 * (re-indexed on every scan), so after a DOM change a held `e0` can name a
 * different element than when it was forbidden — an overlay case proved
 * that poisons healthy elements.
 */
export function esig(e: Elem): [string, string, string] {
  return [e.tag, e.label, (e.data_test as string) ?? ""];
}

/**
 * Resolve a target_hint hit set: one hit is unambiguous, none is a miss, and
 * several are decidable when they are indistinguishable on (tag, label, href,
 * data_test) — bbc.com ships two identical `/news` links, either satisfies the
 * goal. Genuinely different candidates return null and defer to laya.
 */
export function firstIfSame(hits: Iterable<string>, elems: ElemPool): string | null {
  const list = [...hits];
  if (list.length === 1) return list[0]!;
  if (list.length === 0) return null;
  const sigs = new Set(list.map((r) => JSON.stringify([
    elems[r]!.tag, elems[r]!.label, (elems[r]!.href as string) ?? "", (elems[r]!.data_test as string) ?? "",
  ])));
  if (sigs.size !== 1) return null;
  return list.reduce((best, r) => ((elems[r]!.scan ?? 0) < (elems[best]!.scan ?? 0) ? r : best));
}

const SLOT_RE = /([A-Za-z_][\p{L}\p{N}_-]*)\s*[=:：]\s*([^\s,，。;；]+)/gu;

/**
 * Pull `key=value` slots out of the instruction. Python's `\w` is Unicode-aware,
 * so the port uses [`\p{L}\p{N}_`] instead of JS's ASCII-only `\w`; duplicate
 * keys: last wins (dict-comprehension semantics).
 */
export function extractSlots(instruction: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of instruction.matchAll(SLOT_RE)) out[m[1]!] = m[2]!;
  return out;
}

/**
 * A2 分桶闭集与配额。为什么要有配额：默认池是 40 个名额的**有界窗口**，旧排序是
 * "main 优先"，一个长列表就能把页头 8 个按钮（排序/筛选）全部挤出窗口——Google Hotels
 * 的「排序」菜单实测不可选。配额保证每一类页面区域都有最小可见性：
 *   chrome       页面 chrome（nav/aside/footer/header），不受视口限制；
 *   viewport     非 chrome 且在当前视口内（±15%）；
 *   contentNear  非 chrome、视口外但在 ±150% 内（"快滚到"的内容）；
 *   mainOffscreen 非 chrome、更远、且在该页 main/article 里；
 *   other        其余（页脚外正文、侧栏外的离屏控件…）。
 * 配额用不完时按 BUCKET_FILL_ORDER 顺延，绝不自动滚动页面（提取只观察当前视口）。
 */
export type PoolBucket = "chrome" | "viewport" | "contentNear" | "mainOffscreen" | "other";
export type PoolQuotas = Record<PoolBucket, number>;
/** 默认池（64）的分桶配额（合计 64）。档位依据：真人浏览一屏会扫 60+ 控件，窗口应覆盖"一屏+邻近"。 */
export const POOL_QUOTAS: PoolQuotas = { chrome: 8, viewport: 24, contentNear: 16, mainOffscreen: 12, other: 4 };
/** 宽扫池（128 = 默认池翻倍）的分桶配额（合计 128）。 */
export const WIDE_QUOTAS: PoolQuotas = { chrome: 16, viewport: 52, contentNear: 34, mainOffscreen: 17, other: 9 };
/**
 * E1-b：`decision.pool_quota_mode:"quota"` 灰度档的换档配额——viewport 保底加大、
 * 壳限额收紧（chrome 8→6）。换档表按**新基础表的比例**放大（chrome×0.75、viewport×1.5、
 * 其余×1.0）并**保留超额订阅**语义：表合计（74/150）大于池帽（64/128），靠 BUCKET_FILL_ORDER
 * 填序截断——只改"谁被逐出"，总预算仍由 max 决定。
 * id-backed 保留不在配额表里（PIN_CAP 在探针侧，跨桶合计）。
 */
export const QUOTA_MODE_QUOTAS: PoolQuotas = { chrome: 6, viewport: 36, contentNear: 16, mainOffscreen: 12, other: 4 };
export const QUOTA_MODE_WIDE_QUOTAS: PoolQuotas = { chrome: 12, viewport: 78, contentNear: 34, mainOffscreen: 17, other: 9 };
/** 拼接顺序（ref 编号 / 诊断展示顺序）：chrome 在前，其余按"离当前视口由近到远"。 */
export const BUCKET_ORDER: readonly PoolBucket[] = ["chrome", "viewport", "contentNear", "mainOffscreen", "other"];
/** 配额没填满时的顺延顺序（chrome 最后兜底：它通常量小且已配额内收全）。 */
export const BUCKET_FILL_ORDER: readonly PoolBucket[] = ["viewport", "contentNear", "mainOffscreen", "other", "chrome"];

