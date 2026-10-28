/**
 * PageState 的最小一等运行时模型。
 *
 * 目标不是复刻 Playwright 的 page 对象，而是把 flow 运行期真正需要回答的
 * “现在在哪一页 / 是否已经 interactive / frame 边界是谁”收敛成一个可记录的证据对象。
 * `poolVersion` 是本进程内的观察版本号，不是 DOM mutation id。
 */
import { urlOf, type PageLike } from "../engine/extraction.ts";

export type PageReadiness = "navigating" | "loading" | "interactive" | "settled";

export interface PageState {
  /** 同一 page 对象在进程内的稳定标识（不跨进程持久化）。 */
  pageId: string;
  url: string;
  /** 顶层页面和已知 frame 的 origin；空 URL / about:blank 记为 "opaque"。 */
  frameOrigins: string[];
  readiness: PageReadiness;
  /** PageStateStore 每次观察递增；用于判断“同一页的哪一次观察”。 */
  poolVersion: number;
  observedAt: number;
}

const pageIds = new WeakMap<object, string>();
let nextId = 1;

function pageIdOf(page: PageLike): string {
  const key = page as unknown as object;
  let id = pageIds.get(key);
  if (id === undefined) {
    id = `p${nextId++}`;
    pageIds.set(key, id);
  }
  return id;
}

function originOf(u: string): string {
  try {
    const url = new URL(u);
    if (url.protocol === "about:" || url.protocol === "javascript:" || url.protocol === "data:") return "opaque";
    return url.origin;
  } catch {
    return "opaque";
  }
}

/** 从真实 Playwright page / 测试替身读取当前 PageState；只读，不决策。 */
export function pageStateOf(page: PageLike, readiness: PageReadiness = "interactive"): PageState {
  const url = urlOf(page);
  const origins = new Set<string>();
  const frames = typeof page.frames === "function" ? page.frames() : page.frames;
  for (const frame of frames ?? []) {
    const u = typeof frame.url === "function" ? frame.url() : frame.url;
    if (typeof u === "string" && u.trim()) origins.add(originOf(u));
  }
  // Popup / new tab 也是同一 browser context 的页面；PageState 不能只看当前 page 的 frame。
  // Playwright 的 page.context 是方法；替身可能直接给对象。
  const contextValue = (page as unknown as { context?: unknown }).context;
  const context = (typeof contextValue === "function" ? contextValue.call(page) : contextValue) as
    | { pages?: ArrayLike<PageLike> | (() => ArrayLike<PageLike>) }
    | undefined;
  const rawPages = typeof context?.pages === "function" ? context.pages() : context?.pages;
  for (const popup of Array.from(rawPages ?? [])) {
    const u = typeof popup.url === "function" ? popup.url() : popup.url;
    if (typeof u === "string" && u.trim()) origins.add(originOf(u));
  }
  origins.add(originOf(url));
  return {
    pageId: pageIdOf(page),
    url,
    frameOrigins: [...origins].sort(),
    readiness,
    poolVersion: 0,
    observedAt: Date.now(),
  };
}

export interface PageStateSnapshot {
  current: Readonly<PageState> | null;
}

/**
 * flow 运行期内的单一 PageState 事实源。
 * `poolVersion` 每次观察递增，所以调用方可以看出“这是不是同一次观察”。
 */
export class PageStateStore implements PageStateSnapshot {
  private state: PageState | null = null;
  private version = 0;

  get current(): Readonly<PageState> | null {
    return this.state;
  }

  update(page: PageLike, readiness: PageReadiness = "interactive"): Readonly<PageState> {
    const next = pageStateOf(page, readiness);
    this.version += 1;
    this.state = { ...next, poolVersion: this.version };
    return this.state;
  }

  /** 没有页面时用于让 URL / PageState 保持一致。 */
  clear(): void {
    this.state = null;
    this.version = 0;
  }
}
