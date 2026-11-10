/**
 * L2 `ctx` 的**纯工具函数**（从 ctx.ts 拆出，F1）——不依赖 `createCtx` 闭包。
 *
 * 拆出的理由：`toolReturns` / `toolFailureReason` / `pickRow` 都是纯输入→输出，却挤在
 * ctx.ts 尾部。dry/replay 面要复用同一份（`ctx.run` 的 returns 规范、失败原因人读化、
 * 行选 min/max 语义逐字节不变），故集中到这里。
 */
import { validateReturns, type ReturnExtractor } from "./app-adapters.ts";
import { StopError } from "./ctx-types.ts";

/**
 * `ctx.run` 的 `returns` 规范化：只认既有 `ReturnExtractor` 声明面（`validateReturns` 是
 * 加载期与运行期**同一份**校验）。坏声明 = 结构化 `config_error`，绝不"猜一个抽取方式"。
 */
export function toolReturns(raw: unknown, where: string): Record<string, ReturnExtractor> | null {
  const problems: string[] = [];
  const out = validateReturns(raw, where, problems);
  if (problems.length > 0) throw new StopError("config_error", problems.join("；"));
  return out;
}

/**
 * 工具步失败的人读原因（T6）：`<stop_code>: exit N — <stderr 尾行>`。
 * 没有退出码（起不来/被拒绝）时省略 `exit` 段；`given`（适配器/拒绝文案）只在
 * stderr 摘要里没有时才补上——同一句话不重复两遍。
 */
export function toolFailureReason(
  stopCode: string, code: number | null | undefined, tail: string | undefined, given?: string,
): string {
  let out = stopCode;
  if (code !== null && code !== undefined) out += `: exit ${code}`;
  const g = given !== undefined && given.trim() ? given.trim() : undefined;
  if (tail !== undefined && tail.length > 0) {
    out += ` — ${tail}`;
    if (g !== undefined && g !== tail && !tail.includes(g) && !out.includes(g)) out += ` (${g})`;
  } else if (g !== undefined) {
    out += ` — ${g}`;
  }
  return out;
}

/** 选一行：`min|max` 按字段的数值比较（非数值回落到字符串比较；空集合 → null）。 */
export function pickRow<T extends Record<string, unknown>>(rows: T[], by: string, order: "min" | "max"): T | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  let best: T | null = null;
  for (const row of rows) {
    if (best === null) { best = row; continue; }
    const a = num(row[by]);
    const b = num(best[by]);
    const cmp = a !== null && b !== null ? a - b : String(row[by] ?? "").localeCompare(String(best[by] ?? ""));
    if (order === "min" ? cmp < 0 : cmp > 0) best = row;
  }
  return best;
}