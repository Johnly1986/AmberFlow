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
import { firstLoc } from "../engine/executor-pure.ts";
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
function rangeEvidence(r: RangeOutcome, peers?: HandleAddress[] | null): Record<string, unknown> {
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
  // peers 带上每柄的池行序号（P0-A：`row-index:N` 的 N 就是它），处方才可执行；
  // 对不上号的那一柄不带 `pool_row_index`（缺键 = 没量到，不在证据里编一个序）。
  if (peers !== undefined && peers !== null && peers.length > 1) out["peers"] = peerEvidence(peers);
  else if (Array.isArray(r.peers) && r.peers.length > 1) out["peers"] = r.peers;
  // 池侧 `row_index`（dup 组内序；与 handle_index 是两条不同的序，两个都带出）。
  if (typeof r.pool_row_index === "number" && Number.isFinite(r.pool_row_index)) out["row_index"] = r.pool_row_index;
  // 页面提供的档位人读文本（只有页面给才有）。
  if (typeof r.valuetext === "string" && r.valuetext !== "") out["valuetext"] = r.valuetext;
  // 键盘策略收敛失败的可判别原因（仅键盘路径失败时出现）。
  if (typeof r.probe === "string") out["probe"] = r.probe;
  return out;
}

/* ---------------------------------------------------------------- P0-A：多柄处方 */

/**
 * `value` 的**入参防御**：只处理"字符串里装着一个 JSON 对象"这一种形态
 * （实测 `(got "{\"value\": 4}")`——调用方把结构化值又序列化了一次）。
 *
 * 解析成功即按对象继续走同一套形状校验（不另开旁路）；解析失败**原样返回**，
 * 由 `sessionSetRangeProblem` 报结构化的 config_error（不吞错、不猜值）。
 * 非对象字符串（如 `"70"`）不解析：那是"值形态错"，不是"序列化产物"。
 */
export function normalizeSetRangeValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return value;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

/** 耦合组内单柄的可执行寻址事实（`peers[]` 的会话侧投影 + 池行序号）。 */
interface HandleAddress {
  handle: number;
  min: number;
  max: number;
  value: number | null;
  valuetext: string | null;
  /** 池行 dup 组序号（1-based，`row-index:N` 的 N）；该柄无池行 = null（不猜、不补算）。 */
  row_index: number | null;
  /** 该柄池行的**形状**（`input[type=range]`）——`row-index:N` 必须挂在一个能覆盖整组的形状上。 */
  shape?: string;
}

/** 池行是不是滑杆手柄（与 range.ts 的耦合组判定同一形态面）。 */
function isSliderPoolRow(el: { tag?: string; input_type?: string; role?: string }): boolean {
  if (String(el.input_type ?? "").toLowerCase() === "range") return true;
  return String(el.role ?? "").toLowerCase() === "slider";
}

/**
 * 池行能给出的**寻址形状**：`row-index:N` 要挂在"能命中整组手柄"的形状上（`#id`/唯一 label
 * 是单元素身份，再叠 `row-index` 会被 fail-closed 的 AND 过滤成零命中——处方就没法照抄）。
 * 原生 range 有通用形状（`input[type=range]`）；自绘 `role=slider` 没有通用形状 = null。
 */
function shapeOfPoolRow(el: { tag?: string; input_type?: string }): string | null {
  const tag = String(el.tag ?? "").toLowerCase();
  if (tag === "input" && String(el.input_type ?? "").toLowerCase() === "range") return "input[type=range]";
  return null;
}

/**
 * 手柄的**值域事实**读取（页面侧单次只读）：取值口径与 range.ts 的 `readState` 逐条一致
 * （min: aria-valuemin→min；max: aria-valuemax→max；value: 活值→aria-valuenow；
 * valuetext: aria-valuetext）——口径一致才允许把池行与 `peers[]` 对上号。
 */
const HANDLE_FACTS_FN = (node: any): {
  min: number; max: number; value: number | null; valuetext: string | null;
} => {
  const toNum = (v: unknown): number | null => {
    const n = typeof v === "number" ? v : Number(String(v ?? ""));
    return Number.isFinite(n) ? n : null;
  };
  const attr = (n: string): string | null => node.getAttribute(n);
  const value = toNum(node.value) ?? toNum(attr("aria-valuenow"));
  const min = toNum(attr("aria-valuemin") ?? attr("min")) ?? value ?? 0;
  const max = toNum(attr("aria-valuemax") ?? attr("max")) ?? value ?? 100;
  const vt = attr("aria-valuetext");
  return { min, max, value, valuetext: vt === null || vt === "" ? null : String(vt) };
};

/** 一次抽池最多读多少个手柄行（有界；抽池本身只为拿 `row_index`）。 */
const MAX_HANDLE_ROWS = 12;
/** 抽池的有界预算（毫秒）：这里只为拿行号，不为等页面稳定（与稳定门无关）。 */
const HANDLE_POOL_DEADLINE_MS = 400;

/**
 * 把 `peers[]` 的每一柄对上**池行序号**（`row-index:N` 的 N）。
 *
 * 为什么要真读一次池：`peers` 由 range.ts 在页面里按"同容器同形控件"枚举，与池的
 * dup 组序（同 tag+label 的可见成员的 DOM 先序）是**两条不同的序**——滑杆 label 常为空串，
 * 会和页面其它空 label 输入同组，所以"N = 第几个手柄"推不出来。这里用**页面活值事实**
 * （min/max/value/valuetext，与 readState 同口径）把池行与 peers 对上号：三元组唯一命中
 * 才认，命中不唯一/对不上 = 该柄 `row_index:null`（宁可说不知道，也不给指错柄的处方）。
 *
 * 失败即降级：抽池/定位/读取任何一步抛错都返回 null（调用方保留原引擎事实，不加半截证据）。
 */
async function peersWithPoolRows(
  deps: SetRangeDeps, peers: NonNullable<RangeOutcome["peers"]>,
): Promise<HandleAddress[] | null> {
  const base: HandleAddress[] = peers.map((p) => ({
    handle: p.handle, min: p.min, max: p.max, value: p.value, valuetext: p.valuetext, row_index: null,
  }));
  try {
    const mw = deps.mw();
    const page = deps.page;
    const ex = await mw._extractPoolSettled(page, mw.candidatePriority, Date.now() + HANDLE_POOL_DEADLINE_MS);
    const rows = Object.values(ex.elems).filter((el) => isSliderPoolRow(el) && typeof el.row_index === "number");
    if (rows.length === 0) return base;
    /** 值域三元组 → 池行（同键多行 = 语义不可分，整键作废）。 */
    const byKey = new Map<string, Array<{ row: number; shape: string | null }>>();
    for (const el of rows.slice(0, MAX_HANDLE_ROWS)) {
      const loc = await mw._locatorFor(page, el);
      if (loc === null) continue;
      let raw: unknown = null;
      try {
        raw = await firstLoc(loc).evaluate(HANDLE_FACTS_FN);
      } catch {
        continue;
      }
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const live = raw as { min: number; max: number; value: number | null; valuetext: string | null };
      const key = handleKey(live);
      const hit = { row: Number(el.row_index), shape: shapeOfPoolRow(el) };
      const bucket = byKey.get(key);
      if (bucket === undefined) byKey.set(key, [hit]);
      else bucket.push(hit);
    }
    for (const peer of base) {
      const hit = byKey.get(handleKey(peer));
      if (hit === undefined || hit.length !== 1) continue;
      peer.row_index = hit[0]!.row;
      if (hit[0]!.shape !== null) peer.shape = hit[0]!.shape;
    }
    return base;
  } catch {
    return null;
  }
}

/** 值域三元组键（口径与 range.ts peers 完全一致；空格归一避免 valuetext 排版差异）。 */
function handleKey(f: { min: number; max: number; value: number | null; valuetext: string | null }): string {
  const vt = f.valuetext === null ? "" : f.valuetext.replace(/\s+/g, " ").trim();
  return `${f.min}|${f.max}|${f.value === null ? "?" : f.value}|${vt}`;
}

/**
 * `peers[]` 的响应形状：引擎给的五个事实原样 + 量到行号时追加 `pool_row_index`
 * （= `row-index:N` 的 N；量不到 = 键不出现）。
 */
function peerEvidence(peers: HandleAddress[]): Array<Record<string, unknown>> {
  return peers.map((p) => ({
    handle: p.handle, min: p.min, max: p.max, value: p.value, valuetext: p.valuetext,
    ...(p.row_index === null ? {} : { pool_row_index: p.row_index }),
  }));
}

/**
 * 把多柄拒绝的 reason **补上可直接照抄的处方**：每柄一行，含档位（下界/上界手柄）、当前
 * aria-valuetext 与值，以及一条完整的 act 请求 JSON（`row-index:N` 的 N 就是该柄的池行序号）。
 * 拿不到行号的那一柄如实写"row index unknown"——绝不给出可能指错柄的 N。
 *
 * 引擎那句"用 row-index:N 指到手柄"的说明**保留**：它讲的是解法口径（A2 验收面钉住这段
 * 词面），而 `peers[].pool_row_index` 到位后它已经可执行——处方只是把 N 具体化。
 */
function handlePrescription(target: string, handles: HandleAddress[]): string {
  // 调用方可能已经写了 row-index:N（指到的是本次命中的那一柄）：处方里换成每柄自己的 N，
  // 否则会出现两个 row-index 尾缀（整组后缀会被解析层拒绝）。
  const given = target.replace(/\s+row-index\s*:\s*\S+\s*$/i, "").trim() || target;
  // `row-index:N` 只有挂在能覆盖整组手柄的形状上才可执行（`#id` 那类单元素身份再叠行锚
  // 会被 AND 过滤成零命中）。所有已对上号的柄给出同一形状时才采用它。
  const shapes = new Set(handles.filter((h) => h.row_index !== null && h.shape !== undefined).map((h) => h.shape!));
  const base = shapes.size === 1 ? [...shapes][0]! : given;
  const lowerFirst = handles.length === 2 && handles[0]!.value !== null && handles[1]!.value !== null
    && handles[0]!.value! < handles[1]!.value!;
  const lines = handles.map((h, i) => {
    // 两柄时按**实测值**说谁是下界谁是上界（值大小是当前事实，不是猜的组序语义）。
    const role = handles.length === 2 && handles[0]!.value !== null && handles[1]!.value !== null
      ? ((i === 0) === lowerFirst ? "lower" : "upper")
      : `handle ${h.handle}`;
    const shown = `${h.valuetext === null ? "" : `${h.valuetext}, `}now ${h.value === null ? "?" : String(h.value)}`;
    const address = h.row_index === null
      ? "pool row index unknown (no pool row for this handle) — address it by #id instead"
      : `{"op":"set_range","target":${JSON.stringify(`${base} row-index:${h.row_index}`)},"value":{"value":<n>}}`;
    return `  #${h.handle} (${role}, ${shown}) → ${address}`;
  });
  return `handles (one line each; N in \`row-index:N\` = that handle's pool row index — paste the JSON as the act request):\n${lines.join("\n")}`;
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
  // 入参防御：字符串形态的 JSON 对象先解一次（解析失败 = 原样，交给形状校验报 config_error）。
  const wanted = normalizeSetRangeValue(value);
  const problem = sessionSetRangeProblem(wanted);
  if (problem !== null) {
    return {
      ok: false, code: "config_error", reason: problem,
      op: "set_range", target, executed: false,
      allowed_value_shapes: ["{ value: <finite number> }", "{ percent: <number 0..100> }"],
      ...(wanted === value ? {} : { value_normalized: "json-string" }),
    };
  }
  const r: RangeOutcome = await deps.mw().setRange(deps.page, target, wanted as SessionSetRangeValue);
  // 多柄失败面：把每一柄对上池行序号，才谈得上"用 row-index:N 指到手柄"。
  // 只在多柄失败时读一次池（成功面/单柄面零新增页面往返）。
  const multi = r.ok !== true && typeof r.handles === "number" && r.handles > 1
    && Array.isArray(r.peers) && r.peers.length > 1;
  const peers = multi ? await peersWithPoolRows(deps, r.peers!) : null;
  const evidence = rangeEvidence(r, peers);
  if (wanted !== value) evidence["value_normalized"] = "json-string";
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
    // 引擎 reason 讲清了"为什么"（percent 在耦合组上没有唯一目标）与解法口径（`row-index:N`）；
    // 这里再补一段**逐柄可照抄**的处方（N 是实测的池行序号），让建议当场可执行。
    const hintText = peers !== null && peers.length > 1
      ? `${String(r.reason ?? "set_range failed")}\n${handlePrescription(target, peers)}`
      : String(r.reason ?? "set_range failed");
    deps.log(`act set_range ${JSON.stringify(target)} → ${code}${r.reason === undefined ? "" : ` (${r.reason.slice(0, 120)})`}`);
    return {
      ok: false, code, reason: hintText,
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
