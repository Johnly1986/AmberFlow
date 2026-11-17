/**
 * 页面形状的纯类型（L0 叶子）：Playwright 结构替身，供 page 扫描/动作/provider 跨层引用。
 *
 * 只放**类型**；`firstOf`/`urlOf`/`framesOf` 等读页面事实的运行时助手仍在
 * `src/engine/extraction.ts`。下沉到 L0 的理由：provider 契约（`decision-provider-contract`）
 * 需要 `ProviderPage`，而 L0 不能反向 import L2 的 extraction。
 */

/* ------------------------------------------------------------------ page shapes */

export interface InnerLoc {
  innerText(opts?: { timeout?: number }): Promise<string> | string;
  inputValue(opts?: { timeout?: number }): Promise<string> | string;
  /** 读属性（Playwright Locator.getAttribute 的同一语义：不存在 → null）。可选：实现方可以不提供。 */
  getAttribute?(name: string, opts?: { timeout?: number }): Promise<string | null> | string | null;
  /** 可见性（Playwright Locator.isVisible）。可选：实现方可以不提供——调用方按"不可判定"处理。 */
  isVisible?(): Promise<boolean> | boolean;
}
export interface LocLike {
  count(): Promise<number> | number;
  /** Python exposes `.first` as a property; the Node API as a method. */
  first: InnerLoc | (() => InnerLoc);
  all?(): Promise<unknown[]>;
  /** 可见性（Playwright Locator.isVisible）。可选：实现方可以不提供。 */
  isVisible?(): Promise<boolean> | boolean;
}

export interface FrameLike {
  /** `hasText` 过滤器（css_exists_text）走 Playwright locator(selector, { hasText })。 */
  locator(selector: string, opts?: { hasText?: string }): LocLike & { all?(): Promise<unknown[]> };
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
  url?: string | (() => string);
  /**
   * A 批（frame:<origin> 帧链）：父帧（Playwright Frame.parentFrame）。可选——
   * `framesOf` 的 `[page as FrameLike]` 兜底没有它 = 主帧（帧链 = [ownOrigin]）。
   * 判根用 `parentFrame()===null`，**不**假设 `frames()[0]` 是主帧。
   */
  parentFrame?(): FrameLike | null;
  /**
   * A 批（frame:<origin> 帧链）：帧存活判定（Playwright 1.58 Frame.isDetached）。
   * detach 后 `parentFrame()` 不抛错也不返回 null（返回陈旧父帧）——判活只能靠它；
   * detached 帧 = 未知 origin（frame-scope.frameChainOf 返回 undefined）。
   */
  isDetached?(): boolean;
}
export interface PageLike {
  /** Python's Playwright exposes `page.url` as a property; the Node API as a method. */
  url: string | (() => string);
  frames?: FrameLike[] | (() => FrameLike[]);
  locator?(selector: string, opts?: { hasText?: string }): LocLike & { all?(): Promise<unknown[]> };
  evaluate?(fn: unknown, arg?: unknown): Promise<unknown>;
  context?: unknown;
  locatorAnyFrame?(selector: string): LocLike | null | Promise<LocLike | null>;
}
