/**
 * `amber session` 运行时 · act `set_range` 分支的**执行体**（A3 范围原语的会话面）。
 *
 * 与 flow 的 `ctx.setRange` 共用同一条引擎原语（`mw.setRange` → `range.ts` 三策略
 * fill→keyboard→pointer）；会话层只做形状校验委托与**有界回显**：不重算 applied/accurate、
 * 不把失败说成成功（越界请求 = `value_out_of_range` 零动作，引擎事实原样透传）。
 *
 * 独立成模块而非写进 `doAct`：主文件与 doAct 是只减不增的存量基线（maintain 门禁）。
 *
 * 轨迹（`--record`）：本 op 与其它 act op 同一纪律——**动作发生即记一条**（成功与失败都记，
 * 与 click/fill 的 `recordAction` 同一形状）。缺了它 `session export` 的结构化骨架就少一整步，
 * 重放必挂在滑杆上；因此记录点在这里（执行体自持，不依赖 doAct 的通用记账）。
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
  /** `--record` 轨迹写入（未开记录时调用方给 no-op；与其它 act op 同一入口）。 */
  recordAction(entry: Record<string, unknown>): void;
  /** 当前动作序号（轨迹 `i` 由会话层统一编号）。 */
  actionCount(): number;
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
  // 请求值不在页面的格点上、被吸附到最近格点后**成功**：如实带出落地值（accurate 已为 false）。
  if (typeof r.snapped_to === "number" && Number.isFinite(r.snapped_to)) out["snapped_to"] = r.snapped_to;
  // 多柄/耦合控件的事实（仅 >1 柄时出现）：percent 被拒或值域瞬变的判别依据。
  if (typeof r.handles === "number" && Number.isFinite(r.handles)) out["handles"] = r.handles;
  // 本次作用的是耦合组内第几个手柄 + 各柄自己的值域（多柄才有）——"请求值对另一柄合法"的判据。
  if (typeof r.handle_index === "number" && Number.isFinite(r.handle_index)) out["handle_index"] = r.handle_index;
  if (Array.isArray(r.peers) && r.peers.length > 1) out["peers"] = r.peers;
  // 池侧 `row_index`（dup 组内序；与 handle_index 是两条不同的序，两个都带出）。
  if (typeof r.pool_row_index === "number" && Number.isFinite(r.pool_row_index)) out["row_index"] = r.pool_row_index;
  // 页面提供的档位人读文本（只有页面给才有）。
  if (typeof r.valuetext === "string" && r.valuetext !== "") out["valuetext"] = r.valuetext;
  // 键盘策略收敛失败的可判别原因（仅键盘路径失败时出现）。
  if (typeof r.probe === "string") out["probe"] = r.probe;
  return out;
}

/**
 * act `set_range` 的完整执行体（返回值即会话协议的一行响应）。
 *
 * 形状校验先于页面交互：缺/非法 value = 结构化 `config_error`（零动作，不猜值）。
 * 合法后委托 `mw.setRange`——越界（`value_out_of_range`）/不可设置（`slider_not_settable`）
 * 等停因原样回显，`ok:false` 绝不伪装成成功。**两次都进轨迹**（失败也是事实）。
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
  // 轨迹：只记事实（目标 hint、请求值形状、引擎给的 applied/accurate/achieved/策略），
  // 明文值不进轨迹（与 fill/select 的 value_hash 同纪律；本 op 的值是数字，不是凭据）。
  const recorded = {
    op: "set_range", target,
    ok: r.ok === true,
    ...(r.ok === true ? {} : { code: String(r.stopCode ?? "slider_not_settable") }),
    ...evidence,
    url: urlOf(deps.page),
  };
  deps.recordAction(recorded);
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
