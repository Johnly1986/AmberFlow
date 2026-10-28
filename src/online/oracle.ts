/**
 * **独立 oracle**：直接读页面事实，不读执行器的 trace / signal 结论。
 *
 * 目的不是再写一套执行器，而是让至少一部分用例的结论不依赖“执行器说它完成了”：
 * 行数、文本顺序、属性值这些事实由这里单独求值。
 */
import type { OnlineOracle } from "./types.ts";

type PageLike = { locator(selector: string): any; url?(): string };

function nums(text: string): number[] {
  return [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0])).filter(Number.isFinite);
}

export async function checkOracle(page: PageLike, oracle: OnlineOracle): Promise<{ ok: boolean; detail: string }> {
  try {
    if (oracle.kind === "url_contains") {
      const url = typeof page.url === "function" ? page.url() : "";
      return { ok: url.includes(oracle.value), detail: `url=${JSON.stringify(url)} contains ${JSON.stringify(oracle.value)}` };
    }
    const loc = page.locator(oracle.selector);
    if (oracle.kind === "css_count") {
      const n = await loc.count();
      const min = oracle.min ?? 0;
      const max = oracle.max ?? Number.POSITIVE_INFINITY;
      return { ok: n >= min && n <= max, detail: `count=${n} expected ${min}..${max}` };
    }
    if (oracle.kind === "attr_equals") {
      const n = await loc.count();
      if (!n) return { ok: false, detail: `selector ${JSON.stringify(oracle.selector)} matched 0` };
      const got = await loc.first().getAttribute(oracle.attr);
      return { ok: got === oracle.value, detail: `${oracle.attr}=${JSON.stringify(got)} expected ${JSON.stringify(oracle.value)}` };
    }
    const texts: string[] = (await loc.allInnerTexts()).map((t: unknown) => String(t).trim());
    if (oracle.kind === "text_set") {
      const got = [...texts].sort();
      const want = [...oracle.values].map((s) => String(s).trim()).sort();
      return { ok: JSON.stringify(got) === JSON.stringify(want), detail: `texts=${JSON.stringify(got)} expected ${JSON.stringify(want)}` };
    }
    const values = texts.flatMap(nums);
    if (values.length < 2) return { ok: false, detail: `only ${values.length} numeric value(s) in ${JSON.stringify(oracle.selector)}` };
    const asc = values.every((v, i) => i === 0 || values[i - 1]! <= v);
    const desc = values.every((v, i) => i === 0 || values[i - 1]! >= v);
    const ok = oracle.direction === "asc" ? asc : desc;
    return { ok, detail: `numbers=${JSON.stringify(values)} direction=${oracle.direction}` };
  } catch (e) {
    return { ok: false, detail: `oracle failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}