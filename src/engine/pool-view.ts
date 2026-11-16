/**
 * PoolView：把执行器实际看到的元素池投影成一个**可解释、可验证**的只读视图。
 *
 * 这是 Agent / inspect / 报告共用的观察面，不是新的动作空间；动作选择仍走
 * `elemFamily` + rules/model。这里只回答“这个元素是谁、属于哪个 frame、能做什么、
 * 有哪些可验证 hint”。
 */
import { actionCapabilities, elemFamily, type Elem, type ElemPool, type PageLike } from "./extraction.ts";
import { suggestHints } from "./rules.ts";

export type PoolActionCapability = ReturnType<typeof actionCapabilities>[number];

export interface PoolElemView {
  ref: string;
  tag: string;
  label: string;
  action_family: ReturnType<typeof elemFamily>;
  action_capabilities: PoolActionCapability[];
  frame_origin: string;
  /** A 批（frame:<origin>）：祖先 origin 链（外→内；仅子帧行出现，主帧 path 省略）。 */
  frame_path?: string[];
  /**
   * B 批：结构证据（仅 inspect 的 `structurePath` opt-in 时出现；≤160 字符）。祖先 tag/`#id`
   * + 同 tag 兄弟序号 + 帧下标前缀——**只作诊断**，不是 hint：动态页面可能失效、不可照抄。
   */
  structure_path?: string;
  /** 结构证据的不稳定标记（与 `structure_path` 同出现）。 */
  structure_unstable?: true;
  hint_candidates: string[];
  /** 有界附加属性：只有存在且非空时才输出，避免把空串当事实。 */
  extras: Partial<Record<"name" | "id" | "data_test" | "href" | "href_full" | "input_type" | "role" | "near" | "heuristic" | "surface", string>>;
}

export interface PoolView {
  frame_origins: string[];
  elements: PoolElemView[];
  count: number;
  truncated: boolean;
}

function originOf(u: unknown): string {
  if (typeof u !== "string" || !u.trim()) return "opaque";
  try { return new URL(u).origin; } catch { return "opaque"; }
}

function pageUrl(page: PageLike): string {
  return typeof page.url === "function" ? page.url() : page.url;
}

function framesOfPage(page: PageLike): Array<{ url?: string | (() => string) }> {
  const raw = typeof page.frames === "function" ? page.frames() : page.frames;
  return (raw ?? []) as Array<{ url?: string | (() => string) }>;
}

export function poolView(elems: ElemPool, page: PageLike, maxElements: number): PoolView {
  const frameUrls = [
    pageUrl(page),
    ...framesOfPage(page).map((f) => (typeof f.url === "function" ? f.url() : f.url)),
  ];
  const frameOrigins = [...new Set(frameUrls.map(originOf))].sort();
  const rows = Object.values(elems).filter((e) => typeof e.ref === "string");
  const truncated = rows.length > maxElements;
  const elements = rows.slice(0, maxElements).map((e): PoolElemView => {
    const extras: PoolElemView["extras"] = {};
    for (const k of ["name", "id", "data_test", "href", "href_full", "input_type", "role", "near"] as const) {
      const val = e[k];
      if (typeof val === "string" && val !== "") extras[k] = val;
    }
    // R2：启发式伪按钮标记（宽扫通道专属），审计可辨
    if (e.heuristic === true) extras.heuristic = "true";
    // U3：类目标记只进 PoolView/inspect/类目计数（不进 ChoiceRequest.elems 的模型投影）。
    if (typeof e.surface === "string" && e.surface !== "") extras.surface = e.surface;
    // A 批（B6 修复）：元素行 frame_origin 改用 `Elem.frame_origin` **单一出处**——
    // 不能用 `[pageUrl, ...frames()].map(origin).sort()` 的下标映射：会重复/排序打乱 fi↔origin，
    // 跨源页会全反（有意的行为修复：cross-origin 页 inspect 行的 frame_origin 值变对，
    // CHANGELOG 记录）。行上没有 frame_origin = 未知 origin 帧（about:blank/srcdoc）→
    // 如实报 "opaque"，不再用错误的映射编一个 origin。顶层 frame_origins 仍按帧枚举口径。
    const framePath = Array.isArray(e.frame_path) && e.frame_path.length > 0 ? e.frame_path : undefined;
    // B 批：结构证据只由 extractElements 的 structurePath opt-in 产出；这里 additive 透传
    // （≤160 的保证在 JS 侧；万一别的来源塞了超长值，这里再裁一次防无界输出——与 JS
    // 同口径：保留帧前缀与元素端，中途用 …> 标记）。
    const rawStructure = typeof e.structure_path === "string" && e.structure_path !== "" ? e.structure_path : undefined;
    const structurePath = rawStructure === undefined ? undefined : (() => {
      if (rawStructure.length <= 160) return rawStructure;
      const m = /^f\d+>/.exec(rawStructure);
      const prefix = m === null ? "" : m[0];
      const body = rawStructure.slice(prefix.length);
      const room = Math.max(1, 160 - prefix.length - 2);
      return `${prefix}…>${body.slice(body.length - room)}`;
    })();
    return {
      ref: e.ref!,
      tag: e.tag,
      label: e.label ?? "",
      action_family: elemFamily(e),
      action_capabilities: actionCapabilities(e),
      frame_origin: typeof e.frame_origin === "string" && e.frame_origin !== "" ? e.frame_origin : "opaque",
      ...(framePath !== undefined ? { frame_path: framePath } : {}),
      ...(structurePath === undefined ? {} : { structure_path: structurePath, structure_unstable: true as const }),
      hint_candidates: suggestHints(e, elems),
      extras,
    };
  });
  return { frame_origins: frameOrigins, elements, count: rows.length, truncated };
}
