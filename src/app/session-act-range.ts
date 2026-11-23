/**
 * `amber session` 运行时 · act `set_range` 分支的**执行体**（A3 范围原语的会话面）。
 *
 * 与 flow 的 `ctx.setRange` 共用同一条引擎原语（`mw.setRange` → `range.ts` 三策略
 * fill→keyboard→pointer）；会话层只做形状校验委托与**有界回显**：不重算 applied/accurate、
 * 不把失败说成成功（越界请求 = `value_out_of_range` 零动作，引擎事实原样透传）。
 *
 * 独立成模块而非写进 `doAct`：主文件与 doAct 是只减不增的存量基线（maintain 门禁）。
 */
import { urlOf } from "../engine/extraction.ts";
import type { BrowserMiddleware, AnyPage } from "../engine/executor.ts";
import type { RangeOutcome } from "../engine/range.ts";
import { sessionSetRangeProblem, type SessionSetRangeValue } from "./session-runtime-contract.ts";

/** set_range 分支的会话侧依赖（窄接口投影，不把整个会话类拖进模块）。 */
export interface SetRangeDeps {
  page: AnyPage;
  startedAt: number;
  mw(): BrowserMiddleware;
  log(line: string): void;
}

/**
 * RangeOutcome 的有界投影：引擎给哪些键就带哪些键（缺键 = 该路径没有此事实，不补算、不猜）。
 * 注意命名：会话响应的 `target` 已是 hint 字符串，引擎 `RangeOutcome.target` 是**数值目标**
 * （percent 已折算/对账用）——同名两义会误读，故数值目标落 `target_value`。
 */
function rangeEvidence(r: RangeOutcome): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof r.applied === "boolean") out["applied"] = r.applied;
  if (typeof r.accurate === "boolean") out["accurate"] = r.accurate;
  if (typeof r.strategy === "string") out["strategy"] = r.strategy;
  if (typeof r.achieved === "number" && Number.isFinite(r.achieved)) out["achieved"] = r.achieved;
  if (typeof r.requested === "number" && Number.isFinite(r.requested)) out["requested"] = r.requested;
  if (typeof r.target === "number" && Number.isFinite(r.target)) out["target_value"] = r.target;
  // 越界拒绝的零动作证据链（仅 value_out_of_range 出现）：被拒的钳制值如实带出。
  if (typeof r.clamped_from === "number" && Number.isFinite(r.clamped_from)) out["clamped_from"] = r.clamped_from;
  // 键盘策略收敛失败的可判别原因（仅键盘路径失败时出现）。
  if (typeof r.probe === "string") out["probe"] = r.probe;
  return out;
}

/**
 * act `set_range` 的完整执行体（返回值即会话协议的一行响应）。
 *
 * 形状校验先于页面交互：缺/非法 value = 结构化 `config_error`（零动作，不猜值）。
 * 合法后委托 `mw.setRange`——越界（`value_out_of_range`）/不可设置（`slider_not_settable`）
 * 等停因原样回显，`ok:false` 绝不伪装成成功。
 */
export async function doActSetRange(
  target: string, value: unknown, deps: SetRangeDeps,
): Promise<Record<string, unknown>> {
  const problem = sessionSetRangeProblem(value);
  if (problem !== null) {
    return {
      ok: false, code: "config_error", reason: problem,
      op: "set_range", target, executed: false,
      allowed_value_shapes: ["{ value: <finite number> }", "{ percent: <number 0..100> }"],
    };
  }
  const r: RangeOutcome = await deps.mw().setRange(deps.page, target, value as SessionSetRangeValue);
  const evidence = rangeEvidence(r);
  const elapsedMs = Date.now() - deps.startedAt;
  if (r.ok !== true) {
    const code = String(r.stopCode ?? "slider_not_settable");
    deps.log(`act set_range ${JSON.stringify(target)} → ${code}${r.reason === undefined ? "" : ` (${r.reason.slice(0, 120)})`}`);
    return {
      ok: false, code, reason: String(r.reason ?? "set_range failed"),
      op: "set_range", target, executed: false,
      url: urlOf(deps.page), elapsed_ms: elapsedMs,
      ...evidence,
    };
  }
  deps.log(`act set_range ${JSON.stringify(target)} → ${String(r.strategy ?? "?")} `
    + `achieved=${r.achieved === undefined ? "?" : String(r.achieved)} accurate=${r.accurate === true}`);
  return {
    ok: true, op: "set_range", target, executed: true,
    url: urlOf(deps.page), elapsed_ms: elapsedMs,
    ...evidence,
  };
}
