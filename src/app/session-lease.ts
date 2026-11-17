/**
 * P2-2.2 S1 执行内核 · 会话租约（SessionLease）。
 *
 * 目标态（docs/MAINLINE.md §2 S1）：三个源适配器（flow / plan / suite）共享同一份
 * `SessionLease(惰性创建 / finally 关闭)` 语义，而不是各自手写「holder.session + close」。
 * 本批先落地 seam 本身并接入 suite 适配器（online runner）；flow（app-runner）与
 * plan（planner 注入 page/pw）在后续批次接入，接入前保持各自现状、不得改写语义。
 *
 * 契约（行为冻结）：
 *   - **惰性**：create 只在第一次 `get()` 时调用；未创建时 `close()` 是 no-op。
 *   - **只关一次**：`close()` 幂等；关闭失败吞掉（调用方 finally 不应因关会话抛错）。
 *   - **所有权**：`LeaseSessionFactory` 由调用方决定是否真的拥有会话；注入 page/pw 的
 *     调用方不应使用本租约的 close（改由上层持有），以免关闭调用方资源——这个边界由
 *     适配器显式选择（见各调用点注释），租约本身不做推断。
 */
import type { BrowserSession } from "../engine/executor.ts";

/** 惰性会话租约：一个 run（或一个用例）一份。 */
export interface SessionLease {
  /** 首次调用触发 create；并发调用共享同一个 Promise 结果（不重复建会话）。 */
  get(): Promise<BrowserSession>;
  /** 幂等关闭：从未创建 = no-op；关闭异常静默（不让 finally 掩盖真实结果）。 */
  close(): Promise<void>;
}

export function createSessionLease(create: () => Promise<BrowserSession>): SessionLease {
  let pending: Promise<BrowserSession> | null = null;
  let session: BrowserSession | null = null;
  let closed = false;
  return {
    async get(): Promise<BrowserSession> {
      if (session !== null) return session;
      if (pending === null) {
        pending = create();
        // 创建失败：清掉 pending，允许后续调用重试（与手写 holder 语义一致）。
        pending.catch(() => { pending = null; });
      }
      session = await pending;
      return session;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      pending = null;
      if (session === null) return;
      const s = session;
      session = null;
      try { await s.close(); } catch { /* 关闭失败不覆盖 run 结果 */ }
    },
  };
}
