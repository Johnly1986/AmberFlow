/**
 * 决策询问单点实现（`DecisionAsk` 的引擎侧实现；契约 `decision-ask-contract.ts`）。
 *
 * 边界（DC7）：
 *   - 候选池归引擎：`host.extract` 抽池、`host.filter` 剔无角色聚合容器；面不交池/禁选/注记；
 *   - 阶梯是**一次询问的内部实现**：窄问 → floor 闸门 → 低置信宽扫重问（宽池真变大才重问），
 *     弃权与执行期 abstain 同源（直接停，不付宽扫）；
 *   - 账本只经 `DecisionAccounting`（策略由工厂按 lifetime 绑定，见 `decision-accounting.ts`）；
 *   - 回执 `executionPool` = 产出 ref 的那份**完整执行池**（宽扫后为宽池）；模型投影永不外返回。
 *
 * 本实现只承载 pilot 面当前模型票所需的阶梯；窗口升级/升级票/裁决票/R2b/族修复**未实现**，
 * `profile` 的对应开关在本文件无效（调用方不得假设它们生效）。
 *
 * 上文能力档（DC4）只影响**逐层回执**，不改变询问行为：`none`/`minimal` 档的 L3/L4 记
 * `unsupported`（有声明但 provider 不收）；`full`/未声明档按产出事实记 `sent`/`absent`；
 * 提供了段但未注册 face/段 = `rejected`（校验不过，照常询问，不 abort）。
 *
 * `DecisionAskHost` 是纯结构类型（engine 不 import 应用层）：面把 middleware/账本折成这些
 * 观察与投票原语注入；`ready` 让"模型不在位"如实回 `no_model`，而不是伪装成弃权。
 */
import { DEFAULT_CONF_FLOOR } from "../support/config-schema.ts";
import type { ProviderCapabilities, ProviderPage } from "../support/decision-provider-contract.ts";
import type {
  DecisionAccounting, DecisionAsk, DecisionAskIntent, DecisionAskLadderCode, DecisionAskOutcome,
  DecisionAskPorts, DecisionLayerReceipt, DecisionLifetime, DecisionPickProfile, DecisionSegment,
} from "./decision-ask-contract.ts";
import { esig, type ElemPool } from "./elem-model.ts";
import type { PickProposal } from "./executor-types.ts";
import { urlOf } from "./page-shapes.ts";
import { effectiveNotes, hasSiteFactsNotes } from "./decision-request.ts";
import { WIDE_QUOTAS, ariaInteractiveLines, criteriaView } from "./extraction.ts";
import { WIDER_ELEMENTS, describeActionError } from "./executor-pure.ts";
import { runWindowEscalationRung } from "./window-escalation.ts";
import type { BrowserMiddleware } from "./executor.ts";
import { drivingGoalText, type DecisionHistoryStep } from "./decision-goal-text.ts";
import type { GateRecovery, PickAcc, RunPickCtx, RunPickHost } from "./decision-pick-types.ts";

/** L1 回执的字符估算（每候选近似人读字节；只做诊断，不参与任何裁剪/裁决）。 */
const LAYER1_CHARS_PER_CANDIDATE = 40;

/**
 * 面注入的观察与投票原语（纯结构类型；engine 不 import 应用层实现）。
 *
 * 三类池纪律：`extract` 产出执行池（真实 ref）；`pick` 只票池内 ref；`filter` 只做候选窗
 * 构成过滤（返回 null = 不剔，题面逐字节不变）。模型投影的剥离/渲染归 host 的 pick 实现
 * （复用执行期 `pickProposal` 同一条链），引擎不重复实现。
 */
export interface DecisionAskHost {
  /** 解析决策源并回报模型是否在位（`mw.ready()` + `rulesOnly` 的折叠；缺模型 = 如实 no_model）。 */
  ready(): Promise<{ rulesOnly: boolean }>;
  /** 抽池：wide=false = 窄/默认可视窗；wide=true = 低置信宽扫视图。失败可抛（引擎按宽扫失败处理）。 */
  extract(page: ProviderPage, wide: boolean): Promise<ElemPool>;
  /** 池内闭集投票（唯一模型询问通道；模型只票 ref，不生成动作）。 */
  pick(goal: string, page: ProviderPage, pool: ElemPool, forbidden: Set<string>,
      notes: Record<string, string> | null): Promise<PickProposal>;
  /** 候选窗剔除（无角色聚合容器）；null = 不剔除。 */
  filter(pool: ElemPool): ElemPool | null;
  /** 把握数解释档（floor 闸门怎么读 `score`）；null = 面未声明，回执按 entropy_conf 记。 */
  scoreKind(): ProviderCapabilities["score_kind"] | null;
  /** DC4 上文能力档（provider 自报）；null = 未声明（回执不据此判 unsupported）。 */
  contextCapability(): ProviderCapabilities["context"] | null;
}

/** 装配选项（S3：端口参与段校验与逐层回执；不改询问行为）。 */
export interface DecisionAskOptions {
  /** 组合根注入端口（faces/segments/siteFacts）。缺省 undefined = 无端口（回执按未产出记 absent）。 */
  ports?: DecisionAskPorts;
}

/** 置信判定档（shape 分档；与执行期 low_confidence 同一认识论，不得跨 shape 比标量）。 */
export function gateOf(shape: PickProposal["shape"]): "full" | "shortlist" | null {
  if (shape.kind === "full") return "full";
  if (shape.kind === "shortlist") return "shortlist";
  return null;
}

/** floor 闸门（shape 分档，与执行期 4d 同口径；弃权不进这里——它直接停）。 */
export function passesFloor(p: PickProposal, confFloor: number): boolean {
  const gate = gateOf(p.shape);
  if (gate === "full") return p.entropyConf >= confFloor;
  if (gate === "shortlist") return !(p.shape.options > 1 && (p.pTop1 ?? 0) < confFloor);
  return false;
}

/** 宽扫抽池：失败如实 null（与执行期宽扫同为观察增强，不把异常当结论）。 */
async function extractWide(host: DecisionAskHost, page: ProviderPage): Promise<ElemPool | null> {
  try {
    return await host.extract(page, true);
  } catch {
    return null;
  }
}

/** 计算逐层回执的输入事实（一次询问内固定；只读，不参与裁决）。 */
interface ReceiptContext {
  /** `intent.segments`（S3 起接受面传入，S4 才作为请求段上线）。 */
  segments: readonly DecisionSegment[];
  /** provider 自报的上文能力档；null = 未声明。 */
  capability: ProviderCapabilities["context"] | null;
  /** 组合根注入端口；undefined = 未接线。 */
  ports: DecisionAskPorts | undefined;
  /** 当前询问面（注册校验用；未注册 = generic，行为不变）。 */
  face: string;
}

/** 能力档是否允许某层：`none`/`minimal` 只到 L2（L3/L4 = provider 不收）；`full`/未声明不设限。 */
function capabilityAllows(cap: ProviderCapabilities["context"] | null, layer: "L0" | "L1" | "L2" | "L3" | "L4"): boolean {
  if (cap === "none" || cap === "minimal") return layer === "L0" || layer === "L1" || layer === "L2";
  return true;
}

/** 层产出事实的字符数（L0 goal 原文 / L1 候选数×近似字节 / L2 注记 JSON；L3/L4 由段产出）。 */
function producedChars(
  layer: "L0" | "L1" | "L2" | "L3" | "L4",
  goal: string, pool: ElemPool | null, notes: Record<string, string> | null,
): number {
  if (layer === "L0") return typeof goal === "string" ? goal.trim().length : 0;
  if (layer === "L1") return (pool === null ? 0 : Object.keys(pool).length) * LAYER1_CHARS_PER_CANDIDATE;
  if (layer === "L2") return notes === null ? 0 : Object.keys(notes).length === 0 ? 0 : JSON.stringify(notes).length;
  if (layer === "L4") {
    const sf = notes === null ? undefined : notes["site_facts"];
    return typeof sf === "string" ? sf.length : 0;
  }
  return 0;
}

/**
 * 单层回执：**先声明档、再段校验、最后产出事实**（DC1.3：带/未带/收不了一律如实回传）。
 * 状态闭集语义：`sent` = 真带上；`absent` = 没产出；`unsupported` = provider 声明档不收；
 * `rejected` = 提供了段但校验不过（未注册 face/段或层不符）——rejected 不阻断询问本身。
 */
function layerReceipt(
  layer: "L0" | "L1" | "L2" | "L3" | "L4", ctx: ReceiptContext,
  goal: string, pool: ElemPool | null, notes: Record<string, string> | null,
): DecisionLayerReceipt {
  if ((layer === "L3" || layer === "L4") && !capabilityAllows(ctx.capability, layer)) {
    return { layer, status: "unsupported", chars: 0 };
  }
  const produced = producedChars(layer, goal, pool, notes);
  const segs = ctx.segments.filter((s) => s.layer === layer);
  if (segs.length === 0) {
    return produced === 0 ? { layer, status: "absent", chars: 0 } : { layer, status: "sent", chars: produced };
  }
  // 段校验 fail-closed：无端口 / face 未注册 / 段未注册或层不符 → rejected（询问照常继续）。
  if (ctx.ports === undefined) return { layer, status: "rejected", chars: 0 };
  if ((ctx.ports.faces?.(ctx.face) ?? null) === null) return { layer, status: "rejected", chars: 0 };
  let chars = produced;
  let budget = 0;
  let truncated = false;
  for (const s of segs) {
    const reg = ctx.ports.segments?.(s.kind);
    if (reg === undefined || reg === null || reg.layer !== layer) return { layer, status: "rejected", chars: 0 };
    budget += reg.budgetChars;
    chars += Math.min(s.text.length, reg.budgetChars);
    if (s.text.length > reg.budgetChars) truncated = true;
  }
  return { layer, status: "sent", chars, ...(budget === 0 ? {} : { budget }), ...(truncated ? { truncated } : {}) };
}

/**
 * 逐层回执的对外入口（run/pilot 两面共用）：只做「声明档 / 段校验 / 产出事实」纯投影，
 * 不改变询问行为。run 面把它挂进 trace 的 `context_layers`，pilot 面走 DecisionAskOutcome。
 */
export function contextLayerReceipts(q: {
  capability: ProviderCapabilities["context"] | null;
  goal: string;
  pool: ElemPool | null;
  notes: Record<string, string> | null;
  segments?: DecisionSegment[];
  face?: string;
  ports?: DecisionAskPorts;
}): DecisionLayerReceipt[] {
  return layerReceipts(
    { segments: q.segments ?? [], capability: q.capability, ports: q.ports, face: q.face ?? "run" },
    q.goal, q.pool, q.notes,
  );
}

/** 五层回执（顺序固定 L0→L4；层闭集不得增第六层）。 */
function layerReceipts(
  ctx: ReceiptContext, goal: string, pool: ElemPool | null, notes: Record<string, string> | null,
): DecisionLayerReceipt[] {
  return (["L0", "L1", "L2", "L3", "L4"] as const).map((layer) => layerReceipt(layer, ctx, goal, pool, notes));
}

/** 弃权回执：`executionPool` 为最后一次真实询问所用的池（窄问弃权 = null；宽扫后 = 宽池）。 */
function abstained(
  executionPool: ElemPool | null, ladder: DecisionAskLadderCode[], asked: number,
  layers: DecisionLayerReceipt[], detail?: string,
): DecisionAskOutcome {
  return {
    kind: "abstained", executionPool, reason: { code: "low_confidence", ...(detail === undefined ? {} : { detail }) },
    ladder, asked, context: { layers },
  };
}

/**
 * 造一次询问 seam：内部按 `host` 自取池并执行窄问 → 闸门 → 宽扫阶梯，回执行池与投票信号。
 * `opts.ports` 只参与段校验与逐层回执（S3），不改变 picked/abstained 语义。
 */
export function createDecisionAsk(host: DecisionAskHost, opts: DecisionAskOptions = {}): DecisionAsk {
  return {
    async ask(
      page: ProviderPage, scope: DecisionLifetime, accounting: DecisionAccounting,
      intent: DecisionAskIntent, profile: DecisionPickProfile,
    ): Promise<DecisionAskOutcome> {
      void scope;   // 账本实例由面按 lifetime 创建并传入；询问只消费实例，不读身份
      const goal = intent.goal;
      const instruction = intent.instruction ?? goal;
      const confFloor = profile.confFloor ?? DEFAULT_CONF_FLOOR;
      // L4 端口：组合根注入 site-facts 摘要；缺端口 / 已有 site_facts / 端口无命中 = notes 原样
      //（请求体形状不变）。取端口失败按"未产出"处理，不阻断询问。
      const siteFactsPort = opts.ports?.siteFacts;
      const enrichNotes = async (notes: Record<string, string> | null): Promise<Record<string, string> | null> => {
        if (siteFactsPort === undefined || hasSiteFactsNotes(notes)) return notes;
        let text: string | null = null;
        try {
          text = await siteFactsPort.notes({ url: urlOf(page), instruction });
        } catch { text = null; }
        return effectiveNotes(notes, text);
      };
      const ready = await host.ready();
      const receipts = (pool: ElemPool | null, notes: Record<string, string> | null): DecisionLayerReceipt[] =>
        layerReceipts({
          segments: intent.segments ?? [], capability: host.contextCapability(), ports: opts.ports, face: profile.face,
        }, goal, pool, notes);

      // ⓪ 模型不在位 = 如实 no_model（绝不装会抛的 runtime，也不伪装弃权）。
      if (ready.rulesOnly) {
        return {
          kind: "no_model", asked: 0, reason: { code: "no_model_runtime" }, executionPool: null,
          context: { layers: receipts(null, null) },
        };
      }

      // ① 窄问视图（引擎自取池）：候选窗剔除无角色聚合容器——闸门与题面看同一份视图。
      const narrowRaw = await host.extract(page, false);
      let pool = host.filter(narrowRaw) ?? narrowRaw;

      // ② 账本：禁选按 lifetime 策略重映射到本视图；注记只表达已试负面证据（无 = null）。
      let forbidden = accounting.forbiddenRefs(pool);
      let notes = await enrichNotes(accounting.notesFor(pool, { url: urlOf(page), instruction }));

      // ③ 窄问：弃权（choiceRef=null）与执行期 abstain 同源——直接停，不付宽扫重问。
      let asked = 1;
      let proposal = await host.pick(goal, page, pool, forbidden, notes);
      if (proposal.choiceRef === null) {
        return abstained(null, [], asked, receipts(pool, notes));
      }

      // ④ floor 闸门不过 = 低置信回流：先付一次宽扫，宽池**真变大**才重问；否则如实弃权
      //    （同一视图重问只会再烧一次询问，不产生新信息）。`profile.reobserve === false`
      //    = 面显式关闭低置信宽扫（执行期同档），闸门结果直接成为弃权。
      let via: "ask" | "reobserve" = "ask";
      const ladder: DecisionAskLadderCode[] = [];
      const gated = !passesFloor(proposal, confFloor);
      if (gated && profile.reobserve === false) {
        return abstained(pool, [], asked, receipts(pool, notes));
      }
      if (gated) {
        const wideRaw = await extractWide(host, page);
        const wide = wideRaw === null ? null : (host.filter(wideRaw) ?? wideRaw);
        ladder.push("wide_reobserve");
        if (wide === null || Object.keys(wide).length <= Object.keys(pool).length) {
          return abstained(null, ladder, asked, receipts(pool, notes));
        }
        // 宽池重编号：账本禁选按 esig 平移（策略在工厂），注记按新池重投影后重问。
        accounting.prune(wide);
        pool = wide;
        forbidden = accounting.forbiddenRefs(pool);
        notes = await enrichNotes(accounting.notesFor(pool, { url: urlOf(page), instruction }));
        asked += 1;
        proposal = await host.pick(goal, page, pool, forbidden, notes);
        via = "reobserve";
        if (proposal.choiceRef === null || !passesFloor(proposal, confFloor)) {
          return abstained(pool, ladder, asked, receipts(pool, notes));
        }
      }

      // ⑤ 命中：回执执行池 + 单元素快照（sig 供面做 anti-repeat 比对）+ 完整投票信号。
      const ref = proposal.choiceRef;
      const el = pool[ref];
      if (el === undefined) {
        return abstained(pool, ladder, asked, receipts(pool, notes),
          "pick returned a ref outside the execution pool");
      }
      return {
        kind: "picked", origin: "model", executionPool: pool, target: { ref, sig: esig(el) },
        method: via === "reobserve" ? "model:reobserve" : "model",
        ladder, via, asked,
        signal: { proposal, scoreKind: host.scoreKind() ?? "entropy_conf" },
        context: { layers: receipts(pool, notes) },
      };
    },
  };
}

/* ------------------------------------------------------------------ run 面阶梯 rung 单源 */

/** 宽扫/升级票的窗口递增链替身（phase 的 `rungCarrier` 同构；本模块不持 BrowserMiddleware）。 */
function rungCarrierOf(host: RunPickHost): BrowserMiddleware {
  return { candidates: { extract: (req: Parameters<RunPickHost["candidatesExtract"]>[0]) => host.candidatesExtract(req) } } as unknown as BrowserMiddleware;
}

/**
 * 模型问句的 L0 文本（与 pilot 面同源渲染）：instruction + 当前页 + 已执行步史。
 * 只改**模型询问**的 goal；规则匹配/词面判据/升级建议仍用原 `instruction`（语义面不混入渲染）。
 */
export function askGoalOf(ctx: RunPickCtx): string {
  const history: DecisionHistoryStep[] = [];
  for (const t of ctx.trace) {
    if (t.executed !== true || typeof t.desc !== "string") continue;
    const step: DecisionHistoryStep = { target: t.desc, ok: true };
    if (t.changed === true || t.changed === false) step.changed = t.changed;
    history.push(step);
  }
  return drivingGoalText(ctx.instruction, history, urlOf(ctx.pg));
}

/** 作用域禁选：attempt 账本与 run 的 forbid 表同源（无实例时退回就地视图）。 */
export function forbiddenOf(ctx: RunPickCtx, pool: ElemPool): Set<string> {
  return ctx.decisionAccounting?.forbiddenRefs(pool) ?? new Set(Object.keys(ctx.forbidden));
}

/**
 * run 面低置信恢复阶梯（宽扫 → 窗口递增 → 升级票）的**单一编排点**：phase 只调本函数，
 * 三档 rung 的实现与顺序都在本模块（P2 迁移边界；裁决/R2b/族修复仍归 phase，P3 再迁）。
 */
export async function runRecoveryLadder(
  host: RunPickHost, ctx: RunPickCtx, st: PickAcc, mm: string, floor: number, rec: GateRecovery,
): Promise<void> {
  await runWideReobserve(host, ctx, st, mm, floor, rec);
  await runEscalatedPick(host, ctx, st, floor, rec);
}

/** 一次模型询问：记录逐层回执（阶梯选哪支，证据面都看到最后一次询问的上文层）。 */
export async function askPick(
  host: RunPickHost, ctx: RunPickCtx, st: PickAcc, goal: string,
  pool: ElemPool, forbidden: Set<string>, notes: Record<string, string> | null,
): Promise<[string | null, number, Record<string, number>]> {
  // 回执的 L4 观察与实际 wire 同一份计算（单源 = `decision-request.effectiveNotes`）：
  // pickInner 发给 provider 的 notes 也由它得出，此处只按同一入参取投影，不改询问行为。
  st.decisionContext = {
    layers: contextLayerReceipts({
      capability: host.contextCapability(), goal, pool, notes: effectiveNotes(notes, host.siteFactsNotes()),
    }),
  };
  return await host.pickElement(goal, ctx.pg, pool, forbidden, notes);
}


/**
 * 分支⑤c：低置信宽扫（OBSERVATION-BOTTLENECK RECOVERY）。宽视图**成为本步视图**，
 * 即使本地提问仍不过闸；第二档由共享的窗口递增链 helper 扩到硬顶重问一次（命中即停）。
 */
export async function runWideReobserve(host: RunPickHost, ctx: RunPickCtx, st: PickAcc, mm: string, floor: number, rec: GateRecovery): Promise<void> {
  if (!(ctx.reobserve && !st.reobserved && st.ref !== null && host.stepTimeoutLeft() > 0)) return;
  st.reobserved = true;
  await host.settleBeforeExtract(ctx.pg);
  const wide = await host.candidatesExtract({ page: ctx.pg, jsProbe: true, maxElements: WIDER_ELEMENTS, widgets: true, quotas: WIDE_QUOTAS, candidatePriority: ctx.candidatePriority, hosts: host.frameHosts });
  if (!(Object.keys(wide).length > Object.keys(st.elems).length)) return;
  // refs are positional: re-prune forbids whose ref now names a different element.
  host.pruneForbids(wide);
  // 宽视图同样只做**排序先验**（不丢元素：加宽看到的东西不该被族过滤掉）。
  const wideAsk = host.orderedPool(wide);
  const [ref2, conf2] = await askPick(host, ctx, st, askGoalOf(ctx), wideAsk, forbiddenOf(ctx, wideAsk), ctx.noted);
  // The wider view BECOMES the step's view even when the local model still abstains.
  st.elems = wide;
  if (ref2 !== null && conf2 >= floor) {
    st.ref = ref2;
    st.conf = conf2;
    st.method = `${mm}:reobserve`;
    rec.recovered = true;
    ctx.windowChainFacts.push({ window: WIDER_ELEMENTS, miss: 1, resolved: true, ref: ref2 });
    if (ctx.verbose) console.log(`  step ${ctx.stepNo}: re-observed wider (${Object.keys(wide).length} elements) -> ${st.ref} conf=${conf2.toFixed(2)}`);
    return;
  }
  if (ref2 !== null) {
    rec.widePick = { ref: ref2, conf: conf2 };
    rec.gateRejected.push(conf2);   // 宽看重问的意见也未过 floor（adjudicate 复用时撤回）
  }
  ctx.windowChainFacts.push({ window: WIDER_ELEMENTS, miss: 1, resolved: false });
  if (ctx.verbose) console.log(`  step ${ctx.stepNo}: re-observed wider (${Object.keys(wide).length} elements) -> still below floor`);
  // 窗口递增链第二档：120 档重问仍未过 floor → 扩到硬顶再重问一次（命中即停）；
  // widePick/"最后一次观察到的意见"语义随档位滚动（硬顶档成为最后一次观察）。
  const rung = await runWindowEscalationRung(rungCarrierOf(host), { pg: ctx.pg, stepNo: ctx.stepNo, instruction: askGoalOf(ctx), verbose: ctx.verbose, elems: st.elems, floor, forbidden: ctx.forbidden, noted: ctx.noted, candidatePriority: ctx.candidatePriority, frameHosts: host.frameHosts, stepTimeoutLeft: host.stepTimeoutLeft, pickElement: (g, _page, pool, blocked, notes) => askPick(host, ctx, st, g, pool, blocked, notes), orderedPool: host.orderedPool, pruneForbids: host.pruneForbids, windowChainFacts: ctx.windowChainFacts, logTag: "re-observed wider",
    hitNote: (poolSize, ref3, conf3) => `(${poolSize} elements) -> ${ref3} conf=${conf3.toFixed(2)}`, missNote: () => "still below floor" });
  if (rung.grew) {
    st.elems = rung.pool;
    if (rung.adopted && rung.ref !== null) { st.ref = rung.ref; st.conf = rung.conf; st.method = `${mm}:reobserve`; rec.recovered = true; }
    else if (rung.ref !== null) { rec.widePick = { ref: rung.ref, conf: rung.conf }; rec.gateRejected.push(rung.conf); }
  }
}

/**
 * 分支⑤d：升级票（C3-R 的深思路径）。更强的推理者只能从**本轮展示过的候选**里点名
 * （不在视图里的答案一律拒收），所以它无法发明元素、值或动作。
 * 决策面已降级（起跑探判死/中途死亡）→ 升级链规则兜底，不再咨询死服务。
 */
export async function runEscalatedPick(host: RunPickHost, ctx: RunPickCtx, st: PickAcc, floor: number, rec: GateRecovery): Promise<void> {
  if (rec.recovered || !ctx.escalateFn || st.escalated || ctx.decisionDegradedReasonClass !== null
      || host.stepTimeoutLeft() <= 0) return;
  st.escalated = true;
  // 显式传当前（宽化后的）池：orderedPool 无参形式读到的是 run() 闭包的旧窄视图
  // ——低置信恢复刚把 elems 换成宽视图时，升级题面必须与 pickElement 看到的是同一份。
  // noted 同步传入：升级题面不带 = 更强的推理者反而看不见"这个候选已白跑过"的事实。
  const crit = criteriaView(host.orderedPool(st.elems), new Set(Object.keys(ctx.forbidden)), await ariaInteractiveLines(ctx.pg), ctx.noted);
  const state = { url: urlOf(ctx.pg), title: await ctx.pg.title(), main_text: await host.stateTextFn(ctx.pg, ctx.instruction) };
  try {
    const pick = await ctx.escalateFn({ instruction: ctx.instruction, criteria: crit, why: `low confidence ${st.conf.toFixed(2)} < floor ${floor.toFixed(2)}`, ...state });
    if (pick && crit[pick] !== undefined && !(pick in ctx.forbidden)) {
      st.ref = pick;
      st.method = "escalate";
      st.decisionKind = "escalate";
      st.escalatedPick = pick;
      rec.recovered = true;
      if (ctx.verbose) console.log(`  step ${ctx.stepNo}: escalated -> ${pick}`);
    } else if (ctx.verbose) console.log(`  step ${ctx.stepNo}: escalation rejected (${pick === null ? "no answer" : `'${pick}' is not a shown candidate`})`);
  } catch (e) {
    if (ctx.verbose) console.log(`  step ${ctx.stepNo}: escalation failed (${describeActionError(e)})`);
  }
}
