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
 * `DecisionAskHost` 是纯结构类型（engine 不 import 应用层）：面把 middleware/账本折成这四个
 * 观察与投票原语注入；`ready` 让"模型不在位"如实回 `no_model`，而不是伪装成弃权。
 */
import { DEFAULT_CONF_FLOOR } from "../support/config-schema.ts";
import type { ProviderCapabilities, ProviderPage } from "../support/decision-provider-contract.ts";
import type {
  DecisionAccounting, DecisionAsk, DecisionAskIntent, DecisionAskLadderCode, DecisionAskOutcome,
  DecisionAskPorts, DecisionLayerReceipt, DecisionLifetime, DecisionPickProfile,
} from "./decision-ask-contract.ts";
import { esig, type ElemPool } from "./elem-model.ts";
import type { PickProposal } from "./executor-types.ts";
import { urlOf } from "./page-shapes.ts";

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
}

/** 装配选项（S1 只保留端口占位：face/段/site-facts 校验与 L4 取数未接线）。 */
export interface DecisionAskOptions {
  /** 组合根注入端口（S1 不消费；S3 起用于面注册校验与站点知识取数）。 */
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

/**
 * 最小逐层回执（DC1.3：带/未带都如实回传，任何裁剪/缺席都不静默）：
 *   - L0 = 目标语义（goal），chars = 原文长度；
 *   - L1 = 候选池（chars = 候选数 × 每候选近似字节）；
 *   - L2 = 账本注记（chars = 注记 JSON 长度）；
 *   - L3/L4 在 S1 尚无注入路径（面不传段、无 site-facts 端口）→ 回执 `absent`，
 *     不伪造 sent/clipped；S3/S4 接段与端口后改为真实状态。
 */
function layerReceipts(goal: string, pool: ElemPool | null, notes: Record<string, string> | null): DecisionLayerReceipt[] {
  const layers: DecisionLayerReceipt[] = [];
  const goalText = typeof goal === "string" ? goal : "";
  layers.push(goalText.trim() === ""
    ? { layer: "L0", status: "absent", chars: 0 }
    : { layer: "L0", status: "sent", chars: goalText.length });
  const candidateCount = pool === null ? 0 : Object.keys(pool).length;
  layers.push(candidateCount === 0
    ? { layer: "L1", status: "absent", chars: 0 }
    : { layer: "L1", status: "sent", chars: candidateCount * LAYER1_CHARS_PER_CANDIDATE });
  const noteCount = notes === null ? 0 : Object.keys(notes).length;
  layers.push(noteCount === 0
    ? { layer: "L2", status: "absent", chars: 0 }
    : { layer: "L2", status: "sent", chars: JSON.stringify(notes).length });
  // L3/L4：本批无注入路径（S3/S4 接段与 site-facts 端口），如实报 absent——
  // 「没带」必须可被审计，不能靠"数组里没有"表达。
  layers.push({ layer: "L3", status: "absent", chars: 0 });
  layers.push({ layer: "L4", status: "absent", chars: 0 });
  return layers;
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
 * 端口（face/段/site-facts）本批未接线——`opts` 只为固定组合根注入形状。
 */
export function createDecisionAsk(host: DecisionAskHost, opts: DecisionAskOptions = {}): DecisionAsk {
  void opts;   // S1：端口未消费（见 DecisionAskOptions 注释）
  return {
    async ask(
      page: ProviderPage, scope: DecisionLifetime, accounting: DecisionAccounting,
      intent: DecisionAskIntent, profile: DecisionPickProfile,
    ): Promise<DecisionAskOutcome> {
      void scope;   // 账本实例由面按 lifetime 创建并传入；询问只消费实例，不读身份
      const goal = intent.goal;
      const instruction = intent.instruction ?? goal;
      const confFloor = profile.confFloor ?? DEFAULT_CONF_FLOOR;

      // ⓪ 模型不在位 = 如实 no_model（绝不装会抛的 runtime，也不伪装弃权）。
      if ((await host.ready()).rulesOnly) {
        return {
          kind: "no_model", asked: 0, reason: { code: "no_model_runtime" }, executionPool: null,
          context: { layers: layerReceipts(goal, null, null) },
        };
      }

      // ① 窄问视图（引擎自取池）：候选窗剔除无角色聚合容器——闸门与题面看同一份视图。
      const narrowRaw = await host.extract(page, false);
      let pool = host.filter(narrowRaw) ?? narrowRaw;

      // ② 账本：禁选按 lifetime 策略重映射到本视图；注记只表达已试负面证据（无 = null）。
      let forbidden = accounting.forbiddenRefs(pool);
      let notes = accounting.notesFor(pool, { url: urlOf(page), instruction });

      // ③ 窄问：弃权（choiceRef=null）与执行期 abstain 同源——直接停，不付宽扫重问。
      let asked = 1;
      let proposal = await host.pick(goal, page, pool, forbidden, notes);
      if (proposal.choiceRef === null) {
        return abstained(null, [], asked, layerReceipts(goal, pool, notes));
      }

      // ④ floor 闸门不过 = 低置信回流：先付一次宽扫，宽池**真变大**才重问；否则如实弃权
      //    （同一视图重问只会再烧一次询问，不产生新信息）。`profile.reobserve === false`
      //    = 面显式关闭低置信宽扫（执行期同档），闸门结果直接成为弃权。
      let via: "ask" | "reobserve" = "ask";
      const ladder: DecisionAskLadderCode[] = [];
      const gated = !passesFloor(proposal, confFloor);
      if (gated && profile.reobserve === false) {
        return abstained(pool, [], asked, layerReceipts(goal, pool, notes));
      }
      if (gated) {
        const wideRaw = await extractWide(host, page);
        const wide = wideRaw === null ? null : (host.filter(wideRaw) ?? wideRaw);
        ladder.push("wide_reobserve");
        if (wide === null || Object.keys(wide).length <= Object.keys(pool).length) {
          return abstained(null, ladder, asked, layerReceipts(goal, pool, notes));
        }
        // 宽池重编号：账本禁选按 esig 平移（策略在工厂），注记按新池重投影后重问。
        accounting.prune(wide);
        pool = wide;
        forbidden = accounting.forbiddenRefs(pool);
        notes = accounting.notesFor(pool, { url: urlOf(page), instruction });
        asked += 1;
        proposal = await host.pick(goal, page, pool, forbidden, notes);
        via = "reobserve";
        if (proposal.choiceRef === null || !passesFloor(proposal, confFloor)) {
          return abstained(pool, ladder, asked, layerReceipts(goal, pool, notes));
        }
      }

      // ⑤ 命中：回执执行池 + 单元素快照（sig 供面做 anti-repeat 比对）+ 完整投票信号。
      const ref = proposal.choiceRef;
      const el = pool[ref];
      if (el === undefined) {
        return abstained(pool, ladder, asked, layerReceipts(goal, pool, notes),
          "pick returned a ref outside the execution pool");
      }
      return {
        kind: "picked", origin: "model", executionPool: pool, target: { ref, sig: esig(el) },
        method: via === "reobserve" ? "model:reobserve" : "model",
        ladder, via, asked,
        signal: { proposal, scoreKind: host.scoreKind() ?? "entropy_conf" },
        context: { layers: layerReceipts(goal, pool, notes) },
      };
    },
  };
}
