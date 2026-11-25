/**
 * `amber pilot` 的现场证据与步间投影（pilot-runtime 拆分；方案见
 * docs/PILOTED_WALKTHROUGH_PLAN.md §PW1/§PW2）。
 *
 * 两件事共用一条纪律：**每件独立失败、独立缺字段——证据/投影失败不掩盖停因本身**。
 *   - 交接四件套（PW1）：截图 / DOM（>2MB 截断注明总长）/ 池快照（最近一轮抽池的
 *     ElemPool 原样落盘）/ observe 明细；
 *   - agent 驾驶的步间候选投影（--driver agent）：observe 契约行的有界子集
 *     （ref/tag/label/hint_candidates——hint_candidates 本就经 hintMatch 自证唯一命中）。
 */
import fs from "node:fs";
import path from "node:path";
import { urlOf } from "../engine/extraction.ts";
import { frameGateOf } from "../engine/frame-scope.ts";
import type { ObserveResult } from "../engine/observe.ts";
import type { AnyPage } from "../engine/executor.ts";
import { disallowedHost } from "../engine/host-envelope.ts";
import type { ElemPool } from "../engine/elem-model.ts";
import { sleep } from "../support/sleep.ts";
import { isChromeErrorPage, pageNavError } from "../engine/nav-error.ts";
import { DEFAULT_CONF_FLOOR } from "../support/config-schema.ts";
import { checkSignal, type SignalSpec } from "../engine/signals.ts";
import { clipText } from "../support/text.ts";
import { bounded, isObj } from "./session-runtime-contract.ts";
import type { PilotHandoff, PilotStopCode, WeakPick } from "./pilot-contract.ts";

/** DOM 快照落盘上限（超长截断并注明总长，避免长页把证据目录写爆）。 */
const DOM_SNAPSHOT_CAP_BYTES = 2_000_000;
/** agent 步间投影的观察窗（观察面缺省档）：40 会先被侧栏/章元素占满，正文候选不可见。 */
const STEP_REQUEST_OBSERVE_MAX = 120;

/** 观察闭包的形状（pilot-runtime 注入 ctx().observe）。 */
export type PilotObserve = (opts: { max: number }) => Promise<ObserveResult>;

/**
 * 被 hosts 信封排除的子 frame（**显式信号**）：动作池按信封排除它们，但现场存在。
 * 交接块把它投影成结构化证据 + 解锁建议，避免把「目标在未声明 iframe 内」误判成
 * 「模型选不准」（Google 九宫格 = ogs.google.com 跨源 iframe 的走查实测）。
 * 有界（≤6 帧）且只读；取不到 = 空数组（不掩盖停因）。
 */
export function frameExclusionsOf(page: AnyPage, hosts: string[] | null): Array<{ origin: string; index: number }> {
  try {
    const gate = frameGateOf(page as never, hosts);
    if (gate === null) return [];
    return gate.excluded.slice(0, 6).map((e) => ({ origin: e.origin === "" ? "about:blank" : e.origin, index: e.index }));
  } catch {
    return [];
  }
}

/**
 * 交接 evidence 的现场事实装配（inert/禁选/账本/frame/期望页/值需求/落空 hint）。
 * 值需求只带 label/键/ref，**不带值**（与 resume.value 轨迹只留省略标记同一纪律）。
 */
export function handoffWhyEvidence(a: {
  inertRun: number;
  forbidden: ReadonlySet<string>;
  ledgerEvidence: object;
  framesExcluded: Array<{ origin: string; index: number }>;
  expectUrl: string | null;
  valueNeed: { target: string; key: string; ref: string } | null;
  missedHint: string | null;
  /** 走出 hosts 信封的落地 URL（只有 host_not_allowed 停因给）；null = 未越界。 */
  offEnvelope?: string | null;
  /** Chrome 错误页还原的导航原文（只有 unreachable/config_error 停因给）；null = 无导航失败。 */
  navError?: string | null;
}): Record<string, unknown> {
  return {
    inert_run: a.inertRun,
    forbidden: [...a.forbidden].slice(0, 40),
    ...(a.ledgerEvidence as Record<string, unknown>),
    ...(a.framesExcluded.length === 0 ? {} : { frames_excluded: a.framesExcluded }),
    ...(a.expectUrl === null ? {} : { expect_url: a.expectUrl }),
    ...(a.valueNeed === null ? {} : { needs_value: a.valueNeed }),
    ...(a.missedHint === null ? {} : { resume_hint: { hint: a.missedHint, missed: true } }),
    // 越界落地页：给"是哪一步走出信封的"事实，人才能判断是加 host 还是换入口。
    ...(a.offEnvelope === undefined || a.offEnvelope === null ? {} : { off_envelope: a.offEnvelope }),
    // 导航失败原文：落在 Chrome 错误页时唯一的原文来源（事后读页面拿不到），带码的判据。
    ...(a.navError === undefined || a.navError === null ? {} : { nav_error: a.navError }),
  };
}

/** 停驶现场四件套：各自独立落盘、独立失败、独立缺字段。 */
export async function handoffEvidence(a: {
  page: AnyPage;
  outDir: string;
  stepCount: number;
  lastPool: ElemPool | null;
  observe: PilotObserve;
}): Promise<PilotHandoff["evidence_refs"]> {
  const { page, outDir, stepCount, lastPool, observe } = a;
  const refs: PilotHandoff["evidence_refs"] = {};
  try {
    const shot = path.join(outDir, `handoff-${stepCount}.png`);
    await bounded(() => page.screenshot?.({ path: shot }), 5000);
    refs.screenshot = shot;
  } catch { /* 截图失败不掩盖停因 */ }
  try {
    const dom = path.join(outDir, `handoff-${stepCount}.dom.html`);
    // DOM 读取有界（卡死页面不能拖住交接）：bounded 是弃值 race，这里要拿回文本，
    // 用 Promise.race 自己兜超时；失败/无 content = 如实缺字段。
    const html = await Promise.race([
      Promise.resolve().then(() => page.content?.() ?? "").catch(() => ""),
      sleep(5000).then(() => ""),
    ]);
    if (html !== "") {
      fs.writeFileSync(
        dom,
        html.length > DOM_SNAPSHOT_CAP_BYTES
          ? `${html.slice(0, DOM_SNAPSHOT_CAP_BYTES)}\n<!-- truncated: ${html.length} bytes total -->`
          : html,
        "utf8",
      );
      refs.dom = dom;
    }
  } catch { /* DOM 落盘失败不掩盖停因 */ }
  try {
    if (lastPool !== null) {
      const p = path.join(outDir, `handoff-${stepCount}.pool.json`);
      fs.writeFileSync(p, JSON.stringify(lastPool, null, 2), "utf8");
      refs.pool_snapshot = p;
    }
  } catch { /* 池快照失败不掩盖停因 */ }
  try {
    const obs = await observe({ max: 120 });
    const p = path.join(outDir, `handoff-${stepCount}.observe.json`);
    fs.writeFileSync(p, JSON.stringify(obs, null, 2), "utf8");
    refs.observe = p;
  } catch { /* observe 失败如实缺字段 */ }
  return refs;
}

/**
 * agent 驾驶的步间候选投影：observe 契约行的 ref/tag/label/hint_candidates 有界子集
 * （Agent 照抄 hint_candidates 进 resume.hint 即确定性执行）。observe 失败 = 空候选，
 * Agent 仍可读证据目录/redirect/abort。
 */
/**
 * agent 驾驶的步间投影（`--driver agent`）：候选行有界投影后经 respond 写出；浏览器已死 =
 * 空候选（投影失败不掩盖收尾）。与 `handoffEvidence` 同族：每件事实独立失败，不抛整块。
 */
export async function emitStepRequest(args: {
  respond: (obj: Record<string, unknown>) => void;
  page: AnyPage | null;
  observe: PilotObserve;
  lastPool: ElemPool | null;
  goal: string;
  step: number;
}): Promise<void> {
  const view = args.page === null
    ? { url: "", poolSize: 0, candidates: [] as Array<Record<string, unknown>> }
    : await agentStepCandidates({ page: args.page, observe: args.observe, lastPool: args.lastPool });
  args.respond({
    type: "step_request", unsolicited: true, pilot: true, driver: "agent",
    step: args.step, goal: args.goal, url: view.url, pool_size: view.poolSize, candidates: view.candidates,
  });
}

export async function agentStepCandidates(a: {
  page: AnyPage;
  observe: PilotObserve;
  lastPool: ElemPool | null;
}): Promise<{ url: string; poolSize: number; candidates: Array<Record<string, unknown>> }> {
  const { page, observe, lastPool } = a;
  let url = "";
  const candidates: Array<Record<string, unknown>> = [];
  let poolSize = lastPool === null ? 0 : Object.keys(lastPool).length;
  try {
    url = urlOf(page);
    const obs = await observe({ max: STEP_REQUEST_OBSERVE_MAX });
    poolSize = obs.counts?.elements ?? poolSize;
    for (const el of obs.elements ?? []) {
      if (!isObj(el)) continue;
      const row: Record<string, unknown> = {};
      for (const k of ["ref", "tag", "label", "hint_candidates"] as const) {
        const v = (el as Record<string, unknown>)[k];
        if (v !== undefined) row[k] = v;
      }
      if (Object.keys(row).length > 0) candidates.push(row);
    }
  } catch { /* observe 失败 = 空候选：如实投影，Agent 仍有 redirect/abort 出口 */ }
  return { url, poolSize, candidates };
}

/* ------------------------------------------------ 结束态可见性（evidence-only，不改驾驶行为） */

/** weak_picks 上限（有界证据：够解释最近的回退，不膨胀交接块）。 */
export const WEAK_PICKS_MAX = 6;
/** weak_picks 目标文本上限（与驾驶轨迹的 40 字截断同口径；截断唯一出处 = support/text.ts）。 */
const WEAK_TARGET_MAX = 40;

/**
 * 低置信模型票筛选（纯函数）：只收 **model** 票且 `conf < floor`（缺省 = 全局 0.25 单源，
 * 静态阈值——不随 provider 自报刻度漂移，才解释得了"低于文档默认却过了闸"），取最近 ≤6 条。
 * 返回 `undefined` = 无此类票（调用方据此不出现该键，旧形状逐字节不变）。
 * 不判错、不阻断：它只来自票面，与 DOM/页面合法变化无关，因此不会误报"回退"。
 */
export function weakPicksFrom(
  history: ReadonlyArray<{ step?: number; target: string; picked_by?: "rule" | "model"; conf?: number }>,
  opts: { floor?: number; max?: number } = {},
): WeakPick[] | undefined {
  const floor = typeof opts.floor === "number" && Number.isFinite(opts.floor) ? opts.floor : DEFAULT_CONF_FLOOR;
  const max = Math.max(1, Math.min(WEAK_PICKS_MAX, opts.max ?? WEAK_PICKS_MAX));
  const out: WeakPick[] = [];
  for (let i = 0; i < history.length; i += 1) {
    const s = history[i]!;
    if (s.picked_by !== "model") continue;
    const conf = s.conf;
    if (typeof conf !== "number" || !Number.isFinite(conf) || conf >= floor) continue;
    out.push({
      step: typeof s.step === "number" ? s.step : i + 1,
      target: clipText(s.target, WEAK_TARGET_MAX),
      conf,
      picked_by: "model",
    });
  }
  return out.length === 0 ? undefined : out.slice(-max);
}

/**
 * 交接的结束态声明事实：无声明（含空对象）= `null`（结束态**未被验证**的显式 fact）；
 * 有声明 = ≤200 字的有界摘要（声明内容本就来自调用方，不引入新敏感面）。
 */
export function finalSignalFact(spec: Record<string, unknown> | null | undefined, max = 200): string | null {
  if (spec === null || spec === undefined || !isObj(spec) || Object.keys(spec).length === 0) return null;
  try {
    return clipText(JSON.stringify(spec), max);
  } catch {
    return null;
  }
}

/**
 * 驾驶面的**导航信封**判定（轮首与步尾共用；越界返回落地 URL，未越界 null）。
 *
 * 与 run 面 `hostGate`、session 的 `open`/`goto`/`tab` 同一判定：走出 hosts 就不再是任务语境
 * （登录跳转、第三方重定向会把后续模型票带离任务页）。轮首判是为了不拿漂走后的候选问模型；
 * 步尾判是为了把"是哪一步走出的"写进交接证据。
 */
export function envelopeEscape(url: string, hosts: string[] | null): string | null {
  if (hosts === null || hosts.length === 0) return null;
  return disallowedHost(url, hosts) === null ? null : url;
}

/** 信封/导航判定的一次结果：停因 + 交接证据（`offEnvelope` 只在真越界时给）。 */
export interface EnvelopeStop {
  stop: PilotStopCode;
  offEnvelope: string | null;
  reason: string | null;
}

/**
 * 信封或**导航失败**判定（轮首/步尾/finish 共用）。
 *
 * 落在 Chrome 错误页不等于越界：错误页 URL 的 host 是 `chromewebdata`，拿它判信封会把
 * 「网络不通」说成「走出 hosts」。错误页一律先还原原文再按引擎既有码归类
 * （`unreachable` = 站点此刻不可达；`config_error` = 端口/URL 等声明问题或原文不可得）。
 */
export async function envelopeStopOf(page: AnyPage, url: string, hosts: string[] | null): Promise<EnvelopeStop | null> {
  if (isChromeErrorPage(url)) {
    const failure = await pageNavError(page);
    return { stop: failure?.code ?? "config_error", offEnvelope: null, reason: failure?.reason ?? null };
  }
  return envelopeEscape(url, hosts) === null ? null : { stop: "host_not_allowed", offEnvelope: url, reason: null };
}

/**
 * 信封判定的**页面取址体**（轮首与 finish 共用）。
 *
 * 取址失败 = null（不越界）：页面已死由既有 `browser_dead` / 信号不成立路径如实收口，
 * 不把「读不到 URL」冒充成「越界」（那会把死页诊断成信封问题，解锁建议也就指向错处）。
 */
export async function envelopeStopNow(
  page: () => Promise<AnyPage>,
  hosts: string[] | null,
): Promise<EnvelopeStop | null> {
  try {
    const p = await page();
    return await envelopeStopOf(p, urlOf(p), hosts);
  } catch {
    return null;
  }
}

/**
 * 最终信号的判定体（`--final-signal` 每轮判与 `finish` 指令共用同一实现）。
 *
 * 只回答"此刻是否成立"，**不判完成**：pilot 的正因收尾是 `final_signal_held`，
 * 信号不成立只是继续驾驶。页面已死/信号形状非法一律 false（不抛）。
 */
export async function finalSignalHeldImpl(
  spec: Record<string, unknown> | null | undefined,
  page: () => Promise<AnyPage>,
  hosts: string[] | null,
): Promise<boolean> {
  if (spec === null || spec === undefined || !isObj(spec) || Object.keys(spec).length === 0) return false;
  try {
    return await checkSignal(await page() as never, spec as SignalSpec, { hosts });
  } catch {
    return false;
  }
}
