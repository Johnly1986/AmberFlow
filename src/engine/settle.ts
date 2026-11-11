/**
 * S2 稳定门（settle）——页面突变传感器 + 有界静默等待。
 *
 * 为什么需要它（8 轮实测 r2/r5/r7）：`goto(domcontentloaded)` 之后，SPA 的面板/菜单
 * 还在异步渲染；引擎在这一刻抽池，菜单项根本不在池里，点到被遮罩的旧节点或直接
 * `target_not_found`。固定 sleep 要么太短（还是抽早了），要么每一步都白等。
 *
 * 设计（三条纪律，逐条对应方案 §2.3）：
 *   1. **只作传感器**：向页面注入一次持久 MutationObserver（`window.__afQuiet`），
 *      只记录"最近一次 DOM 突变时间 + 突变次数"；没有回调进引擎、没有并发/中断。
 *   2. **有界且只脏时等**：`settle()` 读 `lastMutationTs`；已静默 ≥ quietMs 立即返回
 *      （0 等待），否则 ~50ms 轮询到静默或 timeout 为止。超时不抛错。
 *   3. **失败不阻断**：页面 evaluate 失败（已关闭/跨进程）按 `settled:false,
 *      timedOut:true` 返回——稳定门是观察增强，不该把一次运行变成崩溃。
 *
 * 传感器只听**页面自己的**突变：引擎的池盖章属性（`data-af-probe` / `data-js-ref` /
 * `data-dshref` / `data-hintref`）在 MutationObserver 回调里被过滤掉。否则每次抽池插桩
 * 都会把页面标脏，下一步白等一个 quietMs（实测静态页每步 829ms → 修后首步 ~400ms、其后 0）。
 *
 * 安装语义：安装那一刻**视为刚脏**（`lastMutationTs = Date.now()`）。理由：导航后
 * 页面正处于"刚 domcontentloaded、还没渲染完"的窗口，把它当静默会让稳定门在最有用的
 * 时刻失效。代价是每个导航后的第一次抽池最多付一次 quietMs；同一页面后续若不再突变
 * 就是 0 等待（静态页稳态零开销）。导航会丢弃 window 上下文，执行器在 goto 后重装。
 */
import { sleep } from "../support/sleep.ts";

/** settle 可观察的最小页面面（Playwright page / frame 的 evaluate）。 */
export interface SettlePage {
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
}

export interface SettleOptions {
  /** 判定"静默"所需的无突变时长（毫秒；缺省 400）。 */
  quietMs?: number;
  /** 总等待上限（毫秒；缺省 5000）；超时返回 timedOut=true，不抛错。 */
  timeoutMs?: number;
}

export interface SettleResult {
  /** true = 页面已静默（可能等了 0ms）；false = 超时/页面不可读。 */
  settled: boolean;
  /** 实际等待的墙钟毫秒（已静默立即返回 = 0）。 */
  waitedMs: number;
  /** true = 等到超时仍未静默（或页面 evaluate 失败）；调用方不应把它当异常。 */
  timedOut: boolean;
}

/** `meta.policy.settle` 的缺省档（方案 §2.5）。 */
export const DEFAULT_SETTLE: Readonly<{ quietMs: number; timeoutMs: number }> =
  Object.freeze({ quietMs: 400, timeoutMs: 5000 });

/** 轮询间隔：~50ms（与方案 §2.3 一致）。 */
const POLL_MS = 50;

/**
 * 注入/读取 `window.__afQuiet` 的**唯一**页面脚本：幂等安装 + 返回当前传感器读数。
 * 已安装就只读（导航后是新 window，会重装）。
 */
const QUIET_JS = `() => {
  const w = globalThis;
  if (!w.__afQuiet) {
    /**
     * 引擎自己的探针属性（池盖章/ref 定位）也是 DOM 突变，但它们不是页面状态变化。
     * 只回写"观察者看到的页面突变"，不把引擎插桩算成脏——否则每次抽池后的下一步都要
     * 白等一次 quietMs（实测：静态页每步 829ms → 修后首步 ~400ms、其后 0）。
     */
    const IGNORED = { 'data-af-probe': 1, 'data-js-ref': 1, 'data-dshref': 1, 'data-hintref': 1 };
    const q = { lastMutationTs: Date.now(), count: 0, installedAt: Date.now() };
    const doc = w.document;
    const target = doc && (doc.documentElement || doc);
    if (target && typeof w.MutationObserver === "function") {
      const obs = new w.MutationObserver((records) => {
        let real = false;
        for (const rec of records) {
          if (rec && rec.type === 'attributes' && IGNORED[rec.attributeName]) continue;
          real = true;
          break;
        }
        if (!real) return;
        q.lastMutationTs = Date.now();
        q.count += 1;
      });
      obs.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    w.__afQuiet = q;
  }
  const q = w.__afQuiet;
  return {
    lastMutationTs: Number(q.lastMutationTs) || 0,
    count: Number(q.count) || 0,
    now: Date.now(),
    installed: true,
  };
}`;

const QUIET_FN = new Function(`return (${QUIET_JS});`)() as (arg?: unknown) => unknown;

interface QuietState {
  lastMutationTs: number;
  count: number;
  /** 页面自己的时钟（用它算 since-mutation，避免 Node/页面时钟漂移）。 */
  now: number;
}

/** 读传感器（首次调用会安装）；页面不可读返回 null。永不抛。 */
async function readQuiet(page: SettlePage): Promise<QuietState | null> {
  try {
    const raw = await page.evaluate(QUIET_FN);
    if (typeof raw !== "object" || raw === null) return null;
    const rec = raw as Record<string, unknown>;
    const lastMutationTs = Number(rec["lastMutationTs"]);
    const now = Number(rec["now"]);
    if (!Number.isFinite(lastMutationTs) || !Number.isFinite(now)) return null;
    return { lastMutationTs, count: Number(rec["count"]) || 0, now };
  } catch {
    return null;
  }
}

/** 安装（幂等）稳定门传感器；返回页面是否可读。永不抛。 */
export async function installSettle(page: SettlePage): Promise<boolean> {
  return (await readQuiet(page)) !== null;
}

/**
 * 等待页面静默（有界）。
 *
 * - 已静默（`now - lastMutationTs >= quietMs`）→ `{settled:true, waitedMs:0, timedOut:false}`；
 * - 脏 → ~50ms 轮询，直到静默或 `timeoutMs` 用完；超时 `{settled:false, ..., timedOut:true}`；
 * - 页面 evaluate 失败 → `{settled:false, timedOut:true}`（不抛、不阻断调用方）。
 *
 * `waitedMs` 用 Node 墙钟计（实际等待），静默判据用页面时钟（避免漂移）。
 */
export async function settle(page: SettlePage, opts: SettleOptions = {}): Promise<SettleResult> {
  const quietMs = Math.max(0, Math.min(5000, Math.floor(opts.quietMs ?? DEFAULT_SETTLE.quietMs)));
  const timeoutMs = Math.max(0, Math.min(30_000, Math.floor(opts.timeoutMs ?? DEFAULT_SETTLE.timeoutMs)));
  const started = Date.now();
  const first = await readQuiet(page);
  if (first === null) return { settled: false, waitedMs: Date.now() - started, timedOut: true };
  if (first.now - first.lastMutationTs >= quietMs) {
    return { settled: true, waitedMs: 0, timedOut: false };
  }
  for (;;) {
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) return { settled: false, waitedMs: elapsed, timedOut: true };
    await sleep(Math.min(POLL_MS, timeoutMs - elapsed));
    const next = await readQuiet(page);
    if (next === null) return { settled: false, waitedMs: Date.now() - started, timedOut: true };
    if (next.now - next.lastMutationTs >= quietMs) {
      return { settled: true, waitedMs: Date.now() - started, timedOut: false };
    }
  }
}
