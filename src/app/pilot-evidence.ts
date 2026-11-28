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
import type {
  FrameExclusion, HandoffValueNeed, LowConfidenceKind, ModelAbstainFacts, ObservationFacts, PilotHandoff, PilotHandoffStopFacts,
  PilotStopCode, WeakPick,
} from "./pilot-contract.ts";

/** DOM 快照落盘上限（超长截断并注明总长，避免长页把证据目录写爆）。 */
const DOM_SNAPSHOT_CAP_BYTES = 2_000_000;
/** agent 步间投影的观察窗（观察面缺省档）：40 会先被侧栏/章元素占满，正文候选不可见。 */
const STEP_REQUEST_OBSERVE_MAX = 120;

/** 观察闭包的形状（pilot-runtime 注入 ctx().observe）。 */
export type PilotObserve = (opts: { max: number }) => Promise<ObserveResult>;

/**
 * 交接里被排除 frame 的**生成侧**条数上限（表里的 producer 列）：证据块 ≤6 的旧承诺由它兑现。
 * 顶层新增可见面的投影界更宽（引擎/桥 8 条），见 `SESSION_HANDOFF_CAP_TABLE`。
 */
export const FRAME_EXCLUSIONS_MAX = 6;

/**
 * 被 hosts 信封排除的子 frame（**显式信号**）：动作池按信封排除它们，但现场存在。
 * 交接块把它投影成结构化证据 + 解锁建议，避免把「目标在未声明 iframe 内」误判成
 * 「模型选不准」（Google 九宫格 = ogs.google.com 跨源 iframe 的走查实测）。
 * 有界（≤{@link FRAME_EXCLUSIONS_MAX} 帧）且只读；取不到 = 空数组（不掩盖停因）。
 */
export function frameExclusionsOf(page: AnyPage, hosts: string[] | null): FrameExclusion[] {
  try {
    const gate = frameGateOf(page as never, hosts);
    if (gate === null) return [];
    return gate.excluded.slice(0, FRAME_EXCLUSIONS_MAX)
      .map((e) => ({ origin: e.origin === "" ? "about:blank" : e.origin, index: e.index }));
  } catch {
    return [];
  }
}

/**
 * 交接 evidence 的现场事实装配（inert/禁选/账本/frame/期望页/值需求/落空 hint/停因专属事实）。
 * 值需求只带 label/键/ref，**不带值**（与 resume.value 轨迹只留省略标记同一纪律）。
 * `stopFacts` 缺省 = 空：非对应停因的交接形状逐字节不变。
 */
export function handoffWhyEvidence(a: {
  inertRun: number;
  forbidden: ReadonlySet<string>;
  ledgerEvidence: object;
  framesExcluded: FrameExclusion[];
  expectUrl: string | null;
  valueNeed: { target: string; key: string; ref: string } | null;
  missedHint: string | null;
  /** 停因专属事实（`stopFactsOf` 装配；证据块与交接顶层同源）。 */
  stopFacts?: PilotHandoffStopFacts;
}): Record<string, unknown> {
  const facts = a.stopFacts ?? {};
  return {
    inert_run: a.inertRun,
    forbidden: [...a.forbidden].slice(0, 40),
    ...(a.ledgerEvidence as Record<string, unknown>),
    ...(a.framesExcluded.length === 0 ? {} : { frames_excluded: a.framesExcluded }),
    ...(a.expectUrl === null ? {} : { expect_url: a.expectUrl }),
    ...(a.valueNeed === null ? {} : { needs_value: a.valueNeed }),
    ...(a.missedHint === null ? {} : { resume_hint: { hint: a.missedHint, missed: true } }),
    // 越界落地页：给"是哪一步走出信封的"事实，人才能判断是加 host 还是换入口。
    ...(facts.off_envelope === undefined ? {} : { off_envelope: facts.off_envelope }),
    // 导航失败原文：落在 Chrome 错误页时唯一的原文来源（事后读页面拿不到），带码的判据。
    ...(facts.nav_error === undefined ? {} : { nav_error: facts.nav_error }),
    // 模型显式弃权：与"引擎没拿到选择"分开——只有这条能回答"模型看着 N 个候选说不行"。
    ...(facts.model_abstain === undefined ? {} : { model_abstain: facts.model_abstain }),
    // 观测体检：`low_confidence` 是三种完全不同的处境共用的一个码，靠这两键分开。
    ...(facts.observation === undefined
      ? {}
      : { observation: facts.observation, low_confidence_kind: lowConfidenceKindOf(facts.observation) }),
  };
}

/** 观测事实取数（纯读）：`lastPool` 是最近一次真抽到的池，`forbidden` 是当轮禁选集。 */
export function observationFactsOf(pool: ElemPool | null, forbidden: ReadonlySet<string>): ObservationFacts {
  const entries = Object.values(pool ?? {});
  return {
    pool_size: entries.length,
    forbidden: forbidden.size,
    empty_labels: entries.filter((e) => e.label === "").length,
  };
}

/**
 * 交接事实的文本上限（顶层投影与外层 cap 表同一界）：停因专属事实与现场定位键都是短文本
 * （浏览器原文 / 落地 URL / 值需求三键 / 落空点名 / 期望页），不清这一段就是几百字符的噪音。
 */
export const HANDOFF_FACT_TEXT_MAX = 300;

/**
 * 停因专属事实的装配（单源）：同一个对象既进 `why_stuck.evidence`，也展开进交接块顶层。
 *
 * **只在对应停因出现**——其它停因返回空对象，交接形状逐字节不变。`gate` 是最近一次
 * 信封/导航失败判定：越界落地 URL 只服务 `host_not_allowed`，错误页原文只服务
 * `unreachable`/`config_error`（两者是不同码，不能互串）。
 *
 * `model_abstain` 只在 `low_confidence` 且模型**显式弃权**时出现：与"引擎没拿到选择"分开，
 * 否则摘要会对后者说"该调题面"，方向是错的。
 */
export function stopFactsOf(a: {
  stop: PilotStopCode;
  gate: EnvelopeStop | null;
  modelAbstain: ModelAbstainFacts | null;
  pool: ElemPool | null;
  forbidden: ReadonlySet<string>;
}): PilotHandoffStopFacts {
  const facts: PilotHandoffStopFacts = {};
  if (a.stop === "low_confidence") {
    facts.observation = observationFactsOf(a.pool, a.forbidden);
    if (a.modelAbstain !== null) facts.model_abstain = a.modelAbstain;
    return facts;
  }
  if (a.stop === "host_not_allowed") {
    const off = a.gate?.offEnvelope ?? null;
    if (off !== null) facts.off_envelope = off;
    return facts;
  }
  if (a.stop === "unreachable" || a.stop === "config_error") {
    const reason = a.gate?.reason ?? null;
    if (reason !== null) facts.nav_error = reason;
  }
  return facts;
}

/**
 * 停因专属事实的**顶层投影**（Agent 可见面）：与 evidence 同源，文本项按
 * `HANDOFF_FACT_TEXT_MAX` 有界化，整数项原样（值域天然有界）；无事实 = 键不出现。
 *
 * 必须放顶层而不是只放 `why_stuck.evidence`：桥面整体丢弃 evidence（只投影交接块白名单），
 * 只有顶层才到得了 Agent 面前。
 */
export function topStopFacts(facts: PilotHandoffStopFacts): Record<string, unknown> {
  return {
    ...(facts.observation === undefined ? {} : { observation: facts.observation }),
    ...(facts.model_abstain === undefined ? {} : { model_abstain: facts.model_abstain }),
    ...(facts.nav_error === undefined ? {} : { nav_error: clipText(facts.nav_error, HANDOFF_FACT_TEXT_MAX) }),
    ...(facts.off_envelope === undefined ? {} : { off_envelope: clipText(facts.off_envelope, HANDOFF_FACT_TEXT_MAX) }),
  };
}

/** 现场定位键的取数口（证据块与顶层同源；三者各自独立缺省）。 */
export interface HandoffLocatorSource {
  /** 发起方声明的任务页 URL 子串；null = 未声明。 */
  expectUrl: string | null;
  /** 未决值需求（只有 `needs_value` 停因给）；null = 无。 */
  valueNeed: HandoffValueNeed | null;
  /** 上一次 resume 点名落空的原文；null = 未落空。 */
  missedHint: string | null;
}

/**
 * 现场定位键的**顶层投影**（Agent 可见面）：`expect_url`（声明时）/ `needs_value`
 * （`needs_value` 停因）/ `resume_hint`（落空后第一次交接），文本项按
 * `HANDOFF_FACT_TEXT_MAX` 有界化；无事实 = 键不出现（其它情形的交接形状逐字节不变）。
 *
 * 必须放顶层而不是只放 `why_stuck.evidence`：桥面整体丢弃 evidence，只有顶层才到得了
 * Agent 面前——而这三项正是"停在哪、缺什么值、上次点名为什么落空"的判据。
 */
export function topLocatorFacts(a: HandoffLocatorSource): Record<string, unknown> {
  return {
    ...(a.expectUrl === null ? {} : { expect_url: clipText(a.expectUrl, HANDOFF_FACT_TEXT_MAX) }),
    ...(a.valueNeed === null ? {} : {
      needs_value: {
        target: clipText(a.valueNeed.target, HANDOFF_FACT_TEXT_MAX),
        key: clipText(a.valueNeed.key, HANDOFF_FACT_TEXT_MAX),
        ref: clipText(a.valueNeed.ref, HANDOFF_FACT_TEXT_MAX),
      },
    }),
    ...(a.missedHint === null
      ? {}
      : { resume_hint: { hint: clipText(a.missedHint, HANDOFF_FACT_TEXT_MAX), missed: true } }),
  };
}

/**
 * 交接块**顶层可选事实**的单源投影（停因专属事实 + 现场定位键）：两者同一纪律——只在
 * 对应情形出现、文本有界、键集由投影固定（不是"把对象摊平"）。两个组成面各自导出，
 * 供上限表交叉校验与纯函数断言分开钉。
 */
export function topHandoffFacts(facts: PilotHandoffStopFacts, locator: HandoffLocatorSource): Record<string, unknown> {
  return { ...topStopFacts(facts), ...topLocatorFacts(locator) };
}

/**
 * `low_confidence` 的三义分类（纯函数，单一出处）：
 *   - `observation-empty`：池里**一个候选都没有**——先查抽取/等渲染，不是问模型的问题；
 *   - `observation-all-forbidden`：抽到了但**全被禁选**——先查为什么都被排除；
 *   - `model-unsure`：有可用候选、模型看过仍没把握——这才是真正该调题面的情形。
 */
export function lowConfidenceKindOf(f: ObservationFacts): LowConfidenceKind {
  if (f.pool_size === 0) return "observation-empty";
  if (f.forbidden >= f.pool_size) return "observation-all-forbidden";
  return "model-unsure";
}

/**
 * 三档各自的**处置方向**（一档一句人话；键闭集 = `LOW_CONFIDENCE_KINDS`，新增档位必须
 * 同时给出方向，否则编译期报缺键）。摘要进 Agent 上下文，所以写"下一步查什么"，
 * 不写档位名——档位名本身没有行动含义。
 */
const LOW_CONFIDENCE_DIRECTION: Record<LowConfidenceKind, (f: ObservationFacts) => string> = {
  "observation-empty": () => "池里一个候选都没有——先查抽取/等渲染，不要调题面",
  "observation-all-forbidden": (f) => `抽到 ${f.pool_size} 个候选但全部被排除——先查为什么都被排除，不要调题面`,
  "model-unsure": (f) =>
    `池里至少 ${Math.max(1, f.pool_size - f.forbidden)} 个可用候选、模型给分低于闸门——这才该调题面或换问法`,
};

/**
 * 停因摘要（`why_stuck.summary` 的单源拼装）：**停因码恒在行首**（结构可解析，闭集值），
 * 其后是停驶页锚点与低置信档位的处置方向，`dead target` 事实只在账本有死目标时追加。
 *
 * 摘要会进 Agent 上下文且有 300 字符上限（桥面 `BRIDGE_HANDOFF_CAPS.summaryMaxChars`）：
 * 除停驶页 URL 外不放随时间漂移的内容（时间戳/随机 id）——同一现场的两次交接必须同文。
 */
export function whyStuckSummary(a: {
  stop: PilotStopCode;
  step: number;
  url: string;
  /** 观测事实（只有 `low_confidence` 停因给）；null = 本停因不分类。 */
  observation: ObservationFacts | null;
  /** 账本里的死目标事实（连续驱动同一目标而信号未成立）；null = 无。 */
  loopTrip: { desc: string; tries: number } | null;
}): string {
  const where = `${a.stop} @ step ${a.step}${a.url === "" ? "" : ` (${clipText(a.url, 120)})`}`;
  const direction = a.observation === null
    ? ""
    : `：${LOW_CONFIDENCE_DIRECTION[lowConfidenceKindOf(a.observation)](a.observation)}`;
  const trip = a.loopTrip === null ? "" : ` — dead target: "${clipText(a.loopTrip.desc, 40)}"`
    + ` driven ${String(a.loopTrip.tries)} time(s) without the signal holding`;
  return `${where}${direction}${trip}`;
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
 * 低置信模型票筛选（纯函数）：只收 **model** 票且 `conf < floor`（缺省 = 全局单源 `DEFAULT_CONF_FLOOR`，
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
