/**
 * 最小延时工具的单源实现。
 *
 * 同一行 `new Promise((r) => setTimeout(r, ms))` 若在 executor / extraction / settle /
 * range / ctx / app-runner / session-runtime 各写一份，轮询与节奏代码的语义就会漂移；
 * 收敛到这里，语义保持逐字节不变：
 *   - `sleep`：原样等待（负值/NaN 由 setTimeout 语义处理）；
 *   - `sleepMs`：非负裁剪（`Math.max(0, ms)`），settle/session 系沿用的口径。
 */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));
