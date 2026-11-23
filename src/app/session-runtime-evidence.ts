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
import { countAnyFrame, rowStatsAnyFrame, type PageLike } from "../engine/extraction.ts";
import { sleepMs } from "../support/sleep.ts";
import type { ActionabilityDetail, ActMissDiagnostics, AnyPage } from "../engine/executor.ts";
import type { AmbiguityView } from "../engine/ambiguity.ts";
import type { Ctx } from "./ctx.ts";
import { errMsg, intIn, nonEmpty, type SessionActOp } from "./session-runtime-contract.ts";

export function actAmbiguity(target: string, chosenRef: string | null | undefined): Record<string, unknown> {
  const diag = takeHintMatchOthers();
  if (diag === null || diag.hint !== target) return {};
  const others = diag.candidates
    .filter((c) => c.ref !== diag.decided && c.ref !== chosenRef)
    .slice(0, 3);
  return {
    ambiguous: diag.candidates.length > 1,
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
 * A4：act 落空（`target_not_found`）的判别证据在会话面的回显。
 *
 * 引擎已按上限构造（`candidates` ≤5 / `near` ≤5 / `rejected` ≤3、label ≤40、why 只在有原因
 * 时出现），会话层**原样**回显——与 `actionabilityResponse` 同一纪律：不重算、不补键。
 * 没有该字段（成功路径 / 非落空失败）= 响应键集与之前逐字节一致。
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
  return { ok: true, what, selector, value };
}

export async function doSignal(ctx: Ctx, log: (line: string) => void, req: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parsed = signalSpec(req);
  if (!parsed.ok) return parsed.resp;
  const started = Date.now();
  const held = await ctx.holds(parsed.spec as never);
  log(`signal held=${held}`);
  return { ok: true, held, elapsed_ms: Date.now() - started };
}

export async function doWaitFor(ctx: Ctx, log: (line: string) => void, req: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parsed = signalSpec(req);
  if (!parsed.ok) return parsed.resp;
  const timeoutMs = intIn(req["timeoutMs"], 0, 600_000) ?? 15_000;
  const pollMs = intIn(req["pollMs"], 1, 60_000) ?? 200;
  const started = Date.now();
  const held = await ctx.waitFor(parsed.spec as never, { timeoutMs, pollMs });
  log(`waitFor held=${held} (${Date.now() - started}ms)`);
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

/**
 * 懒渲染稳定读（双指标缺省门）：rows 选择器的**双指标**稳定判定（会话 extract 缺省门）——行数与空行数
 * （`rowStatsAnyFrame`，一次 evaluate 同时拿两个数）连续 2 轮相等即稳定；返回值同时
 * 携带 E5 口径的滚动稳定事实（rows 曾在窗口内出现连续相等 = `scroll_settled:true`，
 * 与 `rowsSettled` 同判据、不早退——blank 还在变时循环继续，rows 的稳定事实照记）。
 * 单循环双读：双门与 E5 共用同一轮询，不另起第二个循环（默认化的真实成本 ≈ 0）。
 * 空行数单独盯：懒渲染页的行数可以先稳定（骨架节点已挂载）而内容还在灌——只看行数
 * 会提前放行，代理只能用重复 extract 轮询把这笔税交出去。窗口与 E5 同款（600ms ×
 * 至多 5 轮）；读不到（替身页/帧全失联）= 稳定（让 extract 本体去报结构化结果，这里
 * 不抢答）。超窗 = `{settled:false, …}` 如实回——抽取照常发生，不无界等。
 */
export async function rowsSettledDual(
  page: () => Promise<PageLike>, hosts: string[] | null, rowsSel: string,
): Promise<{ settled: boolean; scroll_settled: boolean }> {
  const read = async (): Promise<{ rows: number; blank: number } | null> => {
    try {
      return await rowStatsAnyFrame(await page(), rowsSel,
        hosts === null ? undefined : { hosts });
    } catch {
      return null;
    }
  };
  let prev = await read();
  if (prev === null) return { settled: true, scroll_settled: true };
  let rowsEverStable = false;
  for (let round = 0; round < 4; round++) {
    await sleepMs(600);
    const now = await read();
    if (now === null) return { settled: true, scroll_settled: true };
    const rowsStable = now.rows === prev.rows;
    rowsEverStable = rowsEverStable || rowsStable;
    if (rowsStable && now.blank === prev.blank) return { settled: true, scroll_settled: true };
    prev = now;
  }
  return { settled: false, scroll_settled: rowsEverStable };
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
