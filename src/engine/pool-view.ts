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
  hint_candidates: string[];
  /** 有界附加属性：只有存在且非空时才输出，避免把空串当事实。 */
  extras: Partial<Record<"name" | "id" | "data_test" | "href" | "input_type" | "role" | "near", string>>;
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
    for (const k of ["name", "id", "data_test", "href", "input_type", "role", "near"] as const) {
      const val = e[k];
      if (typeof val === "string" && val !== "") extras[k] = val;
    }
    const fi = typeof e.frame === "number" ? e.frame : 0;
    return {
      ref: e.ref!,
      tag: e.tag,
      label: e.label ?? "",
      action_family: elemFamily(e),
      action_capabilities: actionCapabilities(e),
      frame_origin: frameOrigins[fi] ?? frameOrigins[0] ?? "opaque",
      hint_candidates: suggestHints(e, elems),
      extras,
    };
  });
  return { frame_origins: frameOrigins, elements, count: rows.length, truncated };
}
