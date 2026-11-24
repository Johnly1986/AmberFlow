/**
 * 规则面词面归一与「逐词点名」判定的唯一出处：goal 侧与候选 label 侧共用本模块的切词
 * 模式，因此两侧不存在第二套相等口径。本模块不持站点/业务词，也不新增任何命中词——
 * 词面知识只留在 `rules.ts` 的通用词集（STOP / ROLE / FILLER）。
 */
import type { Elem, ElemPool } from "./extraction.ts";

/** 归一：小写后的 `[a-z]{4,}` 连续段（导航词面用）。 */
export const ASCII4 = /[a-z]{4,}/g;
/** 归一：小写后的 `[a-z0-9]{2,}` 连续段（goal 与候选 label 两侧共用）。 */
export const ASCII2 = /[a-z0-9]{2,}/g;
/** 归一：CJK 连续段（≥2 字）。 */
export const CJK2 = /[\u4e00-\u9fff]{2,}/g;
/** 归一：CJK 连续段（≥1 字）。 */
export const CJK1 = /[\u4e00-\u9fff]+/g;

/** 用给定归一模式切词——两侧唯一的切词入口。 */
export function words(s: string, re: RegExp): string[] {
  return s.match(re) ?? [];
}

/** 候选 label 的空白切词（短语档与单 token 档读同一个 label 字段）。 */
function labelWords(e: Elem): string[] {
  return String(e.label ?? "").toLowerCase().split(/\s+/).filter((p) => p !== "");
}

/** label 每个词切出的 ASCII 段；任一词切不出段（纯 CJK / 纯符号）⇒ 返回 null。 */
function asciiRunsOf(e: Elem): string[] | null {
  const parts = labelWords(e);
  if (parts.length === 0) return null;
  const runs = parts.map((p) => words(p, ASCII2));
  if (runs.some((r) => r.length === 0)) return null;
  return runs.flat();
}

/**
 * 「逐词点名」是否推翻当前撞词：仅当
 *   ① 当前每个撞词候选的 label 都只是**部分**被点名（label 里有词不在 goal 原词表里，
 *      例如多词 label 里那个 goal 从未写出的数字/限定词），且
 *   ② 池里存在多词 label，其**每个**词都在 goal 原词表里、且都已从内容词表 `toks` 中
 *      被通用词集剔除（因此它对内容词档完全不可见）。
 * 满足时返回 ② 的候选集（可能 >1，由调用方沿用既有消歧），否则返回空集 = 不推翻。
 *
 * 为什么要这一档：通用词集只从 goal 侧剔除，于是「每个词都是通用词」的多词 label 在内容
 * 词档里恒不可见；同组里只要有一个词是 goal 的内容词，那个**部分命中**的候选就会独占
 * 命中，于是选中组内的错误选项。本档把「goal 究竟逐词点名了哪个 label」这一**字面事实**
 * 补回来，它用的是同一套切词与同一套词表，不引入任何领域知识。
 *
 * 为什么不会放宽选择集：
 *   - 无任何撞词（`hits` 为空）⇒ 规则本来就不点名，本档不介入（召回不变）；
 *   - 撞词候选自身 label 被**完全**点名（含单词 label 等于某个内容词）⇒ 它并不处于劣势，
 *     本档不重排（既有选择语义逐字节保留）；
 *   - label 词切不出 ASCII 段（纯 CJK / 纯符号 / 被标点切碎的数字）⇒ 不算"逐词点名"；
 *   - 本档只在本已有点名结果上换候选，绝不把"无命中"变成"命中"。
 */
export function namedPhraseOverrides(
  instruction: string,
  elems: ElemPool,
  content: ReadonlySet<string>,
  hits: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  if (hits.size === 0) return out;
  const raw = new Set(words(instruction.toLowerCase(), ASCII2));
  if (raw.size === 0) return out;
  // ① 只对「部分被点名」的撞词生效：完全被点名的候选与其他候选地位相同，不得重排。
  const allPartial = [...hits].every((r) => {
    const runs = asciiRunsOf(elems[r]!);
    if (runs === null) return true; // 不可逐词核对 ⇒ 视为部分，交给本档判定
    const parts = labelWords(elems[r]!);
    return parts.some((p) => words(p, ASCII2).some((w) => !raw.has(w)));
  });
  if (!allPartial) return out;
  // ② 完全被点名、且对内容词档不可见的多词 label。
  for (const [ref, e] of Object.entries(elems)) {
    const parts = labelWords(e);
    if (parts.length < 2) continue;
    const runs = asciiRunsOf(e);
    if (runs === null) continue;
    if (runs.every((w) => raw.has(w) && !content.has(w))) out.add(ref);
  }
  return out;
}
