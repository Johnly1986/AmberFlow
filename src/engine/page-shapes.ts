/**
 * 页面形状的**运行时**助手（page shapes）——Playwright 双运行时（property vs method）适配。
 *
 * 从 extraction.ts 纯搬移（本轮大文件拆分）；页面形状**类型**在 L0 `src/support/page-like.ts`，
 * 本模块只放读页面事实的函数。既有 importer 经 extraction re-export 零改动。
 */
import type { FrameLike, InnerLoc, LocLike, PageLike } from "../support/page-like.ts";

/** `.first` across both Playwright runtimes (property vs method). */
export function firstOf(loc: LocLike): InnerLoc {
  return typeof loc.first === "function" ? loc.first() : loc.first;
}
/** `page.url` across both Playwright runtimes (property vs method). */
export function urlOf(page: PageLike): string {
  return typeof page.url === "function" ? page.url() : page.url;
}

/** Main frame first, then at most `limit` child frames (ad iframes must not eat the budget). */
export function framesOf(page: PageLike, limit = 6): FrameLike[] {
  try {
    const f = typeof page.frames === "function" ? page.frames() : page.frames;
    const list = (f ?? []) as FrameLike[];
    return (list.length ? list : [page as unknown as FrameLike]).slice(0, limit);
  } catch {
    return [page as unknown as FrameLike];
  }
}

