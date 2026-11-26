/**
 * `amber session` 会话响应的**证据/校验 helper**（纯函数 + 显式依赖）。
 *
 * 从 session-runtime.ts 的私有方法纯搬移（大文件拆分）：这些 helper 只做"引擎给什么就
 * 回显什么"（歧义/可行动性/落空诊断/截图/回读/信号形状校验），不含会话状态机；
 * 显式参数代替 `this`，行为与搬移前逐字节一致。
 */
import path from "node:path";
import { ensureDir } from "../support/amberflow-home.ts";
import { signalProblemText, validateSignalSpec } from "../engine/signals.ts";
import { takeHintMatchOthers } from "../engine/rules.ts";
import { HINT_CLOSED_SET_TEXT } from "../engine/grammar-prompt.ts";
import { countAnyFrame, rowStatsAnyFrame, type PageLike } from "../engine/extraction.ts";
import { sleepMs } from "../support/sleep.ts";
import type { ActionabilityDetail, ActMissDiagnostics, AnyPage } from "../engine/executor.ts";
import type { HintShapeProblem } from "../engine/hint.ts";
import type { AmbiguityView } from "../engine/ambiguity.ts";
import type { Ctx } from "./ctx.ts";
import { errMsg, intIn, nonEmpty, type SessionActOp } from "./session-runtime-contract.ts";

/**
 * 弱档旁路命中事实 → act 响应的歧义/撞词字段（只读回显，不改解析与执行）。
 *
 * `ambiguous` 由**本次动作的结果码**派生（`stopCode === "target_ambiguous"`），不读任何
 * 解析旁路：歧义是"零动作的判决"，已执行的动作不可能是歧义，两者必须由同一个事实回答。
 * 弱档旁路的 `decided` 不能当判据——它是 `firstIfSame` 的"可互换"结果（同签名重复组返回
 * 第一个），与 `describeAmbiguity` 的 `decided === null && refs > 1` 是两套语义。
 * 于是不变量是恒等式：`ambiguous === (code === "target_ambiguous")`，
 * `ok === true && ambiguous === true` 结构上不可能成立。
 *
 * `matched_others`/`hint_suspicious` 只是「池里还有相似候选」的提示，与歧义判决无关，
 * 照旧回显（仅当旁路记录的 hint 与本次 target 同一串）。旁路有记录时 `ambiguous` 照旧
 * **恒出现**（false = 不歧义），保持成功响应的键集不因本判据而变。
 */
export function actAmbiguity(
  target: string, chosenRef: string | null | undefined, stopCode: string | undefined,
): Record<string, unknown> {
  const ambiguous = stopCode === "target_ambiguous";
  const diag = takeHintMatchOthers();
  // 旁路没有本次 target 的记录（如 `#id`/`tag` 形状不写旁路）时，歧义判决仍要如实回显。
  if (diag === null || diag.hint !== target) return ambiguous ? { ambiguous: true } : {};
  const others = diag.candidates
    .filter((c) => c.ref !== diag.decided && c.ref !== chosenRef)
    .slice(0, 3);
  return {
    ambiguous,
    ...(others.length === 0
      ? {}
      : {
        matched_others: others.map((c) => ({
          ref: c.ref, tag: c.tag, class: c.class, label: c.label,
        })),
      }),
    // 只有弱档（词前缀/词包含、loose 子串）才值得提示"可能是容器/同缀元素"。
    ...(diag.suspicious ? { hint_kind: diag.kind, hint_tier: diag.tier, hint_suspicious: true } : {}),
  };
}

/**
 * A2：本行 `act` 的歧义策略（`"fail"` = 缺省，歧义即零动作；`"act"` = 旧行为）。
 * 优先级：请求字段 `onAmbiguous`（桥逐调用透传）> 会话旗标 `--on-ambiguous` > 缺省 fail。
 * 返回 null = 请求字段是非法值（调用方报结构化 config_error，不静默取缺省）。
 */
export function ambiguityMode(
  req: Record<string, unknown>, onAmbiguous: "fail" | "act" | undefined,
): "fail" | "act" | null {
  const raw = req["onAmbiguous"];
  if (raw === undefined || raw === null) return onAmbiguous === "act" ? "act" : "fail";
  return raw === "fail" || raw === "act" ? raw : null;
}

/**
 * A2：歧义停因进 `--record` 轨迹的最小记账（`code` 已由调用方记录）：
 * 候选 ref（≤5）+ 总集大小。没开记录时 `recordAction` 本身是 no-op。
 */
export function ambiguityRecord(amb: AmbiguityView | undefined): Record<string, unknown> {
  if (amb === undefined) return {};
  return {
    candidate_refs: amb.candidates.map((c) => c.ref).slice(0, 5),
    candidates_total: amb.candidates_total,
  };
}

/** A2：失败响应上的 `ambiguity` 证据（只有引擎真的给了才出现；成功响应键集不变）。 */
export function ambiguityResponse(amb: AmbiguityView | undefined): Record<string, unknown> {
  return amb === undefined ? {} : { ambiguity: amb };
}

/**
 * A6/B15：滚动策略与到底事实的 additive 回显（引擎给才有）。
 *
 * `strategy:"programmatic"` = 目标没有标准滚动器、引擎回退到"内容溢出但 overflow:hidden"的
 * 祖先上写 scrollTop（那类面板自己的滚动机制）；`at_bottom:true` = 已到底，用来把
 * `moved:false` 的两种含义（没动 / 到底了）分开。标准滚动路径两者都不出现 ⇒ 键集不变。
 */
export function scrollStrategyFacts(
  out: { strategy?: "programmatic"; at_bottom?: true; container?: string },
): Record<string, unknown> {
  return {
    ...(out.strategy === "programmatic" ? { strategy: "programmatic" as const } : {}),
    ...(out.at_bottom === true ? { at_bottom: true as const } : {}),
    // 文档自身不可滚、回退到内部容器时用的是哪个容器（标准路径不出现该键）。
    ...(typeof out.container === "string" && out.container !== "" ? { container: out.container } : {}),
  };
}

/**
 * task-34：会话面的执行证据词按动作语义回显（`select` → `selected`）。
 *
 * 为什么只在会话面映射、不改执行器：`how` 是 run 的 `executed_actions`/trace 共享产物，
 * 改引擎词会让既有应用的产物变化（task-34 红线：缺省参数下产物逐字节不变）。所以引擎词
 * 保持 `filled`（选择/填写同一个动作结果词），会话这一层按 op 精确化——文档已写明。
 */
export function displayHow(op: SessionActOp, how: unknown): unknown {
  if (op === "select" && how === "filled") return "selected";
  return how ?? null;
}

/**
 * B1：act 失败响应上的 `actionability` 证据（引擎给才有；成功响应键集不变）。
 * 原样复用引擎的 `ActionabilityDetail`（reason/bbox/blocker/requery），会话层不重算、不补键。
 */
export function actionabilityResponse(detail: ActionabilityDetail | undefined): Record<string, unknown> {
  return detail === undefined ? {} : { actionability: detail };
}

/**
 * 超时对账在会话面的回显（引擎给才有）。
 *
 * `action-timeout` 收尾时 URL 未变 = 派发与未派发都可能：回复里带 `execution_state:"unknown"`，
 * 让调用方按**未知**处置（尤其破坏性动作不得据此重试）。引擎判"已派发"（URL 已变）时不走失败
 * 分支，因此这里只会见到 `"unknown"`；键缺省 = 该路径没有这份事实（其余键集逐字节不变）。
 */
export function executionStateResponse(state: "executed" | "unknown" | undefined): Record<string, unknown> {
  return state === undefined ? {} : { execution_state: state };
}

/**
 * A4：act 落空（`target_not_found`）的判别证据在会话面的回显。
 *
 * 引擎已按上限构造（`candidates` ≤5 / `near` ≤5 / `rejected` ≤3、label ≤40、why 只在有原因
 * 时出现），会话层**原样**回显——与 `actionabilityResponse` 同一纪律：不重算、不补键。
 * 没有该字段（成功路径 / 非落空失败）= 响应键集与之前逐字节一致。
 */
/**
 * `diagnostics` 的原样透传（**成功面与失败面共用**）：成功面用它承载 `no_op_click`
 * ——"动作成功但页面快照没变"的唯一载体；失败面用它承载形状/歧义诊断。
 * 只透传不重算；`diag` 缺省时返回 `{}`，响应形状不变。
 */
export function missDiagnosticsResponse(diag: ActMissDiagnostics | undefined): Record<string, unknown> {
  return diag === undefined ? {} : { diagnostics: diag };
}

/**
 * B1：act 失败时的**opt-in**截图（请求 `screenshot:true` 才写；缺省不碰页面）。
 * 文件落会话证据目录 `act-<n>-failure.png`（n = 本次会话的动作序号），响应只回
 * `screenshot_file` 路径，不内联图片。截图失败只记日志，不改变动作失败事实。
 */
export async function failureScreenshot(outDir: string, log: (line: string) => void, page: AnyPage, n: number, req: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (req["screenshot"] !== true) return {};
  const file = path.join(outDir, `act-${n}-failure.png`);
  try {
    const shot = (page as unknown as {
      screenshot?: (o: Record<string, unknown>) => Promise<unknown>;
    }).screenshot;
    if (typeof shot !== "function") return {};
    ensureDir(outDir);
    await shot.call(page, { path: file, fullPage: false });
    log(`act failure screenshot #${n} → ${file}`);
    return { screenshot_file: file };
  } catch (e) {
    log(`act failure screenshot failed: ${errMsg(e)}`);
    return {};
  }
}

/** 动作后的有界回读（缺省开）：只给 counts/url/title，不返回元素明细（明细请显式 observe）。 */
export async function observeAfter(ctx: Ctx, req: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (req["observeAfter"] === false) return {};
  try {
    const result = await ctx.observe({ max: 40 });
    return {
      after: {
        url: result.url,
        counts: result.counts,
        truncated: result.truncated,
        ...(result.title === undefined ? {} : { title: result.title }),
      },
    };
  } catch {
    return {}; // 回读失败不影响动作事实（动作已经发生）
  }
}

export function signalSpec(req: Record<string, unknown>): { ok: true; spec: Record<string, unknown> } | { ok: false; resp: Record<string, unknown> } {
  const spec = req["signal"];
  const problems = validateSignalSpec(spec, "signal");
  if (problems.length > 0) {
    // C3：reason 与 CLI/加载期**同一份**合法形态提示（json 版示例串）；problems 数组原样。
    return { ok: false, resp: { ok: false, code: "config_error", reason: signalProblemText(problems, "json"), problems } };
  }
  return { ok: true, spec: spec as Record<string, unknown> };
}

export async function doRead(ctx: Ctx, req: Record<string, unknown>): Promise<Record<string, unknown>> {
  const what = req["what"];
  if (what !== "text" && what !== "value" && what !== "count" && what !== "attr") {
    return {
      ok: false, code: "config_error",
      reason: `read.what must be one of text | value | count | attr (got ${JSON.stringify(what)})`,
    };
  }
  const selector = req["selector"];
  if (!nonEmpty(selector)) {
    return { ok: false, code: "config_error", reason: "read needs a non-empty selector string" };
  }
  if (what === "count") {
    const value = await ctx.read.count(selector);
    return { ok: true, what, selector, value };
  }
  if (what === "attr") {
    const attr = req["attr"];
    if (!nonEmpty(attr)) {
      return { ok: false, code: "config_error", reason: "read.what='attr' needs a non-empty attr string" };
    }
    const value = await ctx.read.attr(selector, attr);
    return { ok: true, what, selector, attr, value };
  }
  const value = what === "text" ? await ctx.read.text(selector) : await ctx.read.value(selector);
  // 命中数事实：CSS 选择器命中多个元素时 `text`/`value` 静默取**第一个**（DOM 惯例），
  // 但「页面有 2 个 role=main、read 拿到的是左侧列表那个」这类现场里，调用方必须能区分
  // "就一个元素、值如此" 与 "命中多个、这是第一个"。`matched_zero` 让 "元素不存在"
  // 与 "存在但值为空" 可区分（value:null 两义，count 命中数补全事实）。
  let matched: number | undefined;
  try {
    matched = Number(await ctx.read.count(selector));
  } catch { /* count 读不到就不附（additive 字段） */ }
  return {
    ok: true, what, selector, value,
    ...(matched !== undefined && Number.isFinite(matched) ? { matched_count: matched } : {}),
    ...(matched === 0 ? { matched_zero: true } : {}),
  };
}

export async function doSignal(ctx: Ctx, log: (line: string) => void, req: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parsed = signalSpec(req);
  if (!parsed.ok) return parsed.resp;
  const started = Date.now();
  const held = await ctx.holds(parsed.spec as never);
  log(`signal held=${held}`);
  return { ok: true, held, elapsed_ms: Date.now() - started };
}

/* ------------------------------------------------------ waitFor 超时诊断（css ≟ hint） */

/**
 * 只有**超时**才会问的那个问题：这条串其实是 act 的 `hint`，被误当成了 CSS 信号吗？
 *
 * 两套寻址语义互不覆盖：`css_*` 走原始 DOM / Playwright locator（`checkSignal`），而 act 的
 * `target` 走 hint 的池字段匹配——`aria-label` 经 `poolFieldFor` 别名到提取期合成的 `label`，
 * **不看 DOM 属性本身**。同一串于是可以"作为 hint 立即点中、作为 CSS 永远等不到"，作者只有
 * 在等满超时之后才撞见这条差异。超时回执因此带一份可执行的对照事实。
 *
 * 判定只认 `ctx.waitForTarget`（observe + `hintMatch` 的唯一权威口径）。**不能**用
 * `hint_candidates` 的成员判定：候选数组是"已自证唯一命中、可直接照抄的串"，不是"能命中的
 * 写法"的集合——`button[aria-label="价格"]` 经 `label` 底座能命中，却永远不会出现在候选里；
 * 拿成员判定会把"能点中"误报成"不是 hint"（反向假话），比不给诊断更坏。
 *
 * 触发面严格：`held === false` + **单个** css 族叶子算子 + 首参是字符串；复合信号
 * （`all_of`/`any_of`/`not`）与 `manual`/`url_contains` 一律跳过（没有"一条选择器"可对照）。
 * 只读、**单发**（`timeoutMs:1` 在 waitForTarget 的"至少查一次"语义下正好是一次判定，不做
 * 二次等待）、有界；没真评过（抛错 / dry 面）就**不下结论**——绝不改写 `held:false` 这个既有事实。
 */
const WAITFOR_CSS_OPS: ReadonlySet<string> = new Set([
  "css_exists", "css_visible_exists", "css_exists_text", "css_text_equals",
  "css_text_contains", "css_value_equals", "css_count_equals", "css_count_min",
]);

/** 回执里的字符串都不得无界（与观察面 label 上限同口径；桥侧还会再截断一次）。 */
const WAITFOR_DIAG_SELECTOR_MAX = 120;

/** 结论在前：note 会被桥侧截断，第一个分句必须是"这行该怎么读"。 */
function hintMatchableNote(count: number): string {
  return `该串作为 hint 可命中 ${count} 个候选，但作为 CSS 不存在：css_* 走原始 DOM（Playwright locator），`
    + "act 的 target 走 hint（池字段匹配，aria-label 已并进 label）。别把 hint 串当 CSS 信号等。"
    // 多候选 = 这串当 act target 会歧义（缺省 on-ambiguous=fail），比"换个 CSS"更该先知道。
    + (count > 1 ? "多候选时 act 默认报 target_ambiguous。" : "");
}

const WAITFOR_HINT_UNMATCHABLE_NOTE = "该串既不能作为 CSS 命中，也不能作为 hint 命中："
  + "css_* 走原始 DOM，act 的 target 走 hint（池字段匹配）。"
  + "先用 observe 抄 hint_candidates，或改用与 DOM 一致的 CSS。";

function clipChars(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** `null` = 本次超时没有可对照的选择器（调用方据此保持既有响应形状不动）。 */
async function waitForTimeoutDiagnostics(
  ctx: Ctx, spec: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const ops = Object.keys(spec);
  const op = ops.length === 1 ? ops[0]! : "";
  if (!WAITFOR_CSS_OPS.has(op)) return null;
  const raw = spec[op];
  // 1 参算子可写标量或 1 项数组（同一取值口径）；2 参算子的首项才是选择器。
  const selector = Array.isArray(raw) ? raw[0] : raw;
  if (typeof selector !== "string" || selector.trim() === "") return null;
  const cssSelector = clipChars(selector, WAITFOR_DIAG_SELECTOR_MAX);
  let probe: { found: boolean; count: number; dry?: boolean };
  try {
    probe = await ctx.waitForTarget(selector, { timeoutMs: 1 });
  } catch {
    // 判定没跑成（页面已死/参数被拒）：只有"问过什么"是事实，不给结论。
    return { css_selector: cssSelector };
  }
  // dry 面合成 `{found:false, dry:true}`（没真评），与抛错同一条纪律：不冒充"不是 hint"。
  if (probe.dry === true) return { css_selector: cssSelector };
  const matchable = probe.found === true;
  const count = matchable ? Math.max(0, Math.trunc(Number(probe.count) || 0)) : 0;
  return {
    css_selector: cssSelector,
    hint_matchable: matchable,
    hint_match_count: count,
    note: matchable ? hintMatchableNote(count) : WAITFOR_HINT_UNMATCHABLE_NOTE,
  };
}

export async function doWaitFor(ctx: Ctx, log: (line: string) => void, req: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parsed = signalSpec(req);
  if (!parsed.ok) return parsed.resp;
  const timeoutMs = intIn(req["timeoutMs"], 0, 600_000) ?? 15_000;
  const pollMs = intIn(req["pollMs"], 1, 60_000) ?? 200;
  const started = Date.now();
  const held = await ctx.waitFor(parsed.spec as never, { timeoutMs, pollMs });
  log(`waitFor held=${held} (${Date.now() - started}ms)`);
  if (!held) {
    // `elapsed_ms` 在诊断之前取：那段时间只属于"等"，不属于超时后的回执整理。
    const elapsedMs = Date.now() - started;
    const diag = await waitForTimeoutDiagnostics(ctx, parsed.spec);
    if (diag !== null) {
      return {
        ok: true, held, timeout_ms: timeoutMs, poll_ms: pollMs, elapsed_ms: elapsedMs,
        timeout_diagnostics: diag,
      };
    }
  }
  return { ok: true, held, timeout_ms: timeoutMs, poll_ms: pollMs, elapsed_ms: Date.now() - started };
}

/**
 * E5：rows 选择器的**滚动稳定判定**——两次连读命中数相等即稳定。间隔 600ms、
 * 最多 5 轮（首读 + 至多 4 次复读 = 有界窗口 ~2.4s）。选择器非法/不可定位时
 * 返回 true（让 extract 本体去报结构化错误，这里不抢答）。
 */
export async function rowsSettled(
  page: () => Promise<PageLike>, rowsSel: string,
): Promise<boolean> {
  const read = async (): Promise<number | null> => {
    try {
      return await countAnyFrame(await page(), rowsSel);
    } catch {
      return null;
    }
  };
  let prev = await read();
  if (prev === null) return true;
  for (let round = 0; round < 4; round++) {
    await sleepMs(600);
    const now = await read();
    if (now === null) return true;
    if (now === prev) return true;
    prev = now;
  }
  return false;
}

/** 稳定门的结论：`settle_reason` 只在门**判不了**时出现（缺省 = 窗口到点仍在变）。 */
export type SettleGateResult = {
  settled: boolean;
  scroll_settled: boolean;
  settle_reason?: "read_failed";
};

/**
 * 懒渲染稳定读（双指标缺省门）：rows 选择器的**双指标**稳定判定（会话 extract 缺省门）——行数与空行数
 * （`rowStatsAnyFrame`，一次 evaluate 同时拿两个数）连续 2 轮相等即稳定；返回值同时
 * 携带 E5 口径的滚动稳定事实（rows 曾在窗口内出现连续相等 = `scroll_settled:true`，
 * 与 `rowsSettled` 同判据、不早退——blank 还在变时循环继续，rows 的稳定事实照记）。
 * 单循环双读：双门与 E5 共用同一轮询，不另起第二个循环（默认化的真实成本 ≈ 0）。
 * 空行数单独盯：懒渲染页的行数可以先稳定（骨架节点已挂载）而内容还在灌——只看行数
 * 会提前放行，代理只能用重复 extract 轮询把这笔税交出去。窗口与 E5 同款（600ms ×
 * 至多 5 轮）；超窗 = `{settled:false, …}` 如实回——抽取照常发生，不无界等。
 *
 * **读不到 ≠ 稳定**：`read()` 返回 null（替身页无帧面/帧全失联/page() 抛错）时既没有
 * 行数也没有空行数事实，绝不能给 `settled:true`——那是「判不了」冒充「已稳定」，与
 * `settle.ts` 的「失败即 settled:false」纪律相反（同一类矛盾会让调用方拿着"稳定"去
 * 信任一批尚不存在的内容）。此时**必须** `settled:false` + `settle_reason:"read_failed"`；
 * `scroll_settled` 也只按**已观测到**的连续相等回（没读到过 = false），不借「读不到
 * 就不阻断」的旧口径谎报滚动稳定。`settle_reason` 缺席 = 窗口到点仍在变（超窗）。
 */
export async function rowsSettledDual(
  page: () => Promise<PageLike>, hosts: string[] | null, rowsSel: string,
): Promise<SettleGateResult> {
  const read = async (): Promise<{ rows: number; blank: number } | null> => {
    try {
      return await rowStatsAnyFrame(await page(), rowsSel,
        hosts === null ? undefined : { hosts });
    } catch {
      return null;
    }
  };
  let prev = await read();
  // 首读即判不了：没有任何双指标事实，稳定门只能给 false（不是"稳定"）。
  if (prev === null) return { settled: false, scroll_settled: false, settle_reason: "read_failed" };
  let rowsEverStable = false;
  for (let round = 0; round < 4; round++) {
    await sleepMs(600);
    const now = await read();
    // 窗口内读失：已拿到的连续相等事实照记（不早退），但稳定结论只能是 false。
    if (now === null) return { settled: false, scroll_settled: rowsEverStable, settle_reason: "read_failed" };
    const rowsStable = now.rows === prev.rows;
    rowsEverStable = rowsEverStable || rowsStable;
    if (rowsStable && now.blank === prev.blank) return { settled: true, scroll_settled: true };
    prev = now;
  }
  return { settled: false, scroll_settled: rowsEverStable };
}

/**
 * 会话 extract 的**稳定门编排**（缺省双指标门 / 请求级 opt-out / settle off 三态）：
 * 只决定「跑不跑门、跑哪个门」，再把门的结论摊成 extract 响应的证据键（引擎给才有）。
 *
 * 三态口径：
 *   - settleOff（meta.policy.settle === 'off'）：双门与 E5 同跳——两键都不出现（无门无证据）；
 *   - waitSettled === false：请求级 opt-out，只跑 E5 单指标滚动门 → 仅 scroll_settled；
 *   - 其余（缺省 / waitSettled:true）：双指标门（行数 AND 空行数两轮稳定）→ settled +
 *     scroll_settled，判不了时另带 settle_reason:'read_failed'（见 {@link rowsSettledDual}）。
 * 抽取本体不在这里：本函数只回证据，读到的行由调用方照常抽取（超窗也照抽）。
 */
export type ExtractSettleEvidence = {
  settled?: boolean;
  settle_reason?: "read_failed";
  scroll_settled?: boolean;
};

export async function extractSettleEvidence(
  settleOff: boolean, waitSettled: boolean | undefined,
  page: () => Promise<PageLike>, hosts: string[] | null, rowsSel: string,
): Promise<ExtractSettleEvidence> {
  if (settleOff) return {};
  if (waitSettled === false) return { scroll_settled: await rowsSettled(page, rowsSel) };
  const dual = await rowsSettledDual(page, hosts, rowsSel);
  return {
    settled: dual.settled,
    ...(dual.settle_reason === undefined ? {} : { settle_reason: dual.settle_reason }),
    scroll_settled: dual.scroll_settled,
  };
}

/**
 * S3：act 成功后的同标签页导航事实探测（纯页面读 + 时钟，无会话依赖）。
 * 100ms 间隔轮询 `urlOf` 最多 `probeMs`；变 = `{same_tab_navigation:true, nav_from,
 * nav_to, probe_ms}`，未变 = `{same_tab_navigation:false, probe_ms}`。只报事实不判完成。
 */
export async function navProbeFacts(
  page: AnyPage, urlOf: (p: AnyPage) => string, probeMs: number, sleepMs: (ms: number) => Promise<void>,
): Promise<{ facts: Record<string, unknown>; from: string; to: string }> {
  const urlBefore = urlOf(page);
  const deadline = Date.now() + probeMs;
  while (Date.now() < deadline) {
    await sleepMs(100);
    if (urlOf(page) !== urlBefore) break;
  }
  const urlAfter = urlOf(page);
  if (urlAfter !== urlBefore) {
    return {
      facts: { same_tab_navigation: true, nav_from: urlBefore, nav_to: urlAfter, probe_ms: probeMs },
      from: urlBefore, to: urlAfter,
    };
  }
  return { facts: { same_tab_navigation: false, probe_ms: probeMs }, from: urlBefore, to: urlAfter };
}

/**
 * S4：最近成功解析记录（会话内存 LRU，≤capacity 条；插入序即淘汰序，重复 target
 * 刷新到队尾）。落空诊断用它回答「这个 hint 上一步还点得动吗」。
 */
export class RecentResolutions {
  private readonly map = new Map<string, { actionSeq: number; op: string; how: string }>();

  // Node --experimental-strip-types 只擦类型、不支持 TS 参数属性（constructor(private …)）
  // ——会话子进程启动即崩（child_exited）；字段必须显式赋值。
  private readonly capacity: number;

  constructor(capacity: number = 20) {
    this.capacity = capacity;
  }

  remember(target: string, actionSeq: number, op: string, how: string): void {
    this.map.delete(target);
    this.map.set(target, { actionSeq, op, how });
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  /**
   * 落空提示：同 target 在 ≤10 个动作内命中过 → 独立键 `recently_resolved`
   * （steps_ago/last_op/last_how）+ reason 尾行；无历史/隔太久 = 两个空值
   * （键不出现，响应键集不变）。只陈述事实，不自动重试。
   */
  hint(target: string, actionSeqNow: number): { diag: Record<string, unknown>; reasonLine: string } {
    const hit = this.map.get(target);
    if (hit === undefined) return { diag: {}, reasonLine: "" };
    const stepsAgo = actionSeqNow - hit.actionSeq;
    if (stepsAgo <= 0 || stepsAgo > 10) return { diag: {}, reasonLine: "" };
    return {
      diag: { recently_resolved: { steps_ago: stepsAgo, last_op: hit.op, last_how: hit.how } },
      reasonLine: `；该 hint 曾在 ${stepsAgo} 个动作前命中（op=${hit.op}, how=${hit.how}）——行内容可能已变（展开/刷新），建议重新 observe 后换锚`,
    };
  }
}

/**
 * 落空时的**形状判别**回显（`diagnostics.shape_problem`，引擎给才有）。
 *
 * 它回答"我写错了吗"——区别于 `diagnostics.near` 回答的"页面里有没有近似词"。会话面把它
 * 提成独立一行写在 reason 尾部（不与候选/近似混在一起），错误码仍是既有 target_not_found。
 */
export function shapeProblemResponse(shape: HintShapeProblem | undefined): Record<string, unknown> {
  return shape === undefined ? {} : { shape_problem: shape };
}

/**
 * 会话 act 落空时补**闭集提示**（引擎侧命令步已有，会话面此前没有）。
 *
 * 为什么补：会话 act 的 `target_not_found` 只说 `matched nothing in a pool of N`——那是
 * "页面没有"的口吻。作者最常错的其实是**写法**（角色词后接文本、后代组合 CSS），因此落空
 * reason 末尾追加与命令空间**同一份**闭集文本（`grammar-prompt.HINT_CLOSED_SET_TEXT`，
 * 单一出处，不手抄），指明"这串被当成永不命中的形状"。
 *
 * 纪律：只追加既有 reason 的尾段，停因码/证据键集不变；成功路径与非落空停因逐字节不变。
 */
export function closedSetReasonSuffix(code: string | undefined): string {
  return code === "target_not_found" ? ` — ${HINT_CLOSED_SET_TEXT}` : "";
}
