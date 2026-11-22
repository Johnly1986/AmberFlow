/**
 * 决策询问契约（DC7 责任边界的接口层）：**引擎只依赖这个纯数据契约**去组装模型题面，
 * 各问询面（run / pilot / 未来其它应用类型）只依赖它去表达意图、策略与作用域。
 *
 * 定位（与 `candidate-contract.ts` 同一范式）：只留结构类型——不 import Playwright 具体类型、
 * 不起浏览器、不做页面 I/O、不定义行为。类型**单源复用**执行期既有形状（`PickProposal`/`Sig`/
 * `StopCode`/`ModelPickPhase`/`ProviderPage`/`score_kind`），不另造平行类型（防漂移）。
 *
 * 边界（DC7）：
 *   - 事实归引擎：候选池、结构事实、命中关系、投影白名单、渲染、有界化、模型询问本身，
 *     以及**询问内部的整个阶梯**——规则分支（无模型票）、窄问→全池回退、低置信宽扫、
 *     窗口升级、升级票、裁决票、R2b、族修复共享同一份**视图世代**（池/禁选/注记），
 *     必须作为单次询问的内部实现（run 面 = 整个选择段 phase，`decision-pick-phase.runDecisionPick` 的接入单位）；
 *   - 意图归面：`DecisionAskIntent` 与 `DecisionPickProfile`；**池与禁选/注记不在意图面里**；
 *     驾驶循环策略（driver/ambiguity/riskVote/remainingSteps）不属于询问，留在各面执行层；
 *   - 生命周期归面、实现归引擎：`DecisionLifetime` 由面声明，账本实例由**引擎工厂**按
 *     lifetime 创建（跨 attempt 的 outcome-memory 由工厂组合注入，不压进一个 scope.id）。
 *
 * 三类池不得混淆：执行池（`executionPool`，本契约返回的对象）、排序/窄化后的 askPool、
 * 经 `modelProjectionOf` 剥离的模型投影——**模型投影永不返回执行面**；本契约只回执行池。
 */

import type { Elem, ElemPool } from "./extraction.ts";
import type { ModelPickPhase } from "./executor.ts";
import type { PickProposal, Sig, StopCode } from "./executor-types.ts";
import type { ProviderCapabilities, ProviderPage } from "../support/decision-provider-contract.ts";

/** 契约版本：形状变更 = seam 变更（`docs/MAINLINE.md` seam 表 + A/B）。 */
export const DECISION_ASK_CONTRACT_VERSION = 5;

/** 上文层闭集（DC1.2 五层；不得发明第六层）。 */
export type DecisionLayer = "L0" | "L1" | "L2" | "L3" | "L4";

/**
 * 面种类：**开放注册**（组合根经 `DecisionAskPorts` 注入，引擎校验；未注册 = 结构化拒收）。
 * 引擎不维护闭集 union、不依赖模块全局。只有真正接模型的 face 才注册（确定性寻址面不注册）。
 */
export type DecisionFaceKind = string;

/** 面注册项（组合根注入；`needs` 为该面缺省请求的层）。 */
export interface DecisionFaceRegistration {
  face: DecisionFaceKind;
  needs?: DecisionLayer[];
  /** 是否接入模型询问（false = 该面确定性寻址，不询问）。 */
  asks: boolean;
}

/** 段注册项（组合根注入；层挂靠 + 字符预算，引擎按它校验与裁剪）。 */
export interface DecisionSegmentRegistration {
  kind: string;
  layer: DecisionLayer;
  budgetChars: number;
}

/**
 * 组合根注入面（与 `CandidateProducer` 经 `buildMiddleware` 注入同一范式；engine 禁 import
 * 应用层实现——`app/site-facts` 明确禁止 engine 引用，故 L4 经端口注入而非引擎直取）。
 */
export interface DecisionAskPorts {
  faces?: (face: DecisionFaceKind) => DecisionFaceRegistration | null;
  segments?: (kind: string) => DecisionSegmentRegistration | null;
  /** L4 站点知识端口：引擎按 URL/指令取摘要，不感知实现来源。 */
  siteFacts?: { notes(req: { url: string; instruction: string }): Promise<string | null> };
}

/** 溯源标签（DC1.4）：无溯源的段不得进入请求；`ts` 与 DC3 同形（epoch ms）。 */
export interface DecisionSegmentProvenance {
  kind: "probe" | "trace" | "site-facts" | "memory" | "slots" | "plan";
  ref: string;
  ts?: number;
  version?: string;
}

/**
 * 面注入的一段上文（S1 **不开放**：面不得传 segments；S4 起用**结构化判别联合**——
 * plan=L3、history=L2，L4 由 `siteFacts` 端口生成，不作任意面文本，防自由文本绕过 R3）。
 */
export interface DecisionSegment {
  kind: string;
  layer: DecisionLayer;
  text: string;
  provenance: DecisionSegmentProvenance;
}

/** 面能提供的**意图**（不含 elems/forbidden/notes——那些归引擎）。 */
export interface DecisionAskIntent {
  /** 目标语义（L0）。 */
  goal: string;
  /** 可选指令原文（与 goal 同层，二者择一或并用由面决定）。 */
  instruction?: string;
  /**
   * 声明锚点＝**当前声明 hint（curHint）的语义**：声明 hint 权威压过模型判断，声明解析
   * 仍由上游既有链（DRF/ADMIT/hintMatch）承担；`actHint:"strict"` 时解析失败即结构化停因、
   * 不回退全池；只有 `profile.tieredHint` 显式开启才走"窄问弃权→全池回退"阶梯。
   * 面不得以此构造/裁剪候选池（子池一律引擎产出）。
   */
  anchor?: { kind: "declared"; hint: string };
  /** 面特有上文段（S4 起用；见 `DecisionSegment`）。 */
  segments?: DecisionSegment[];
}

/**
 * 账本作用域（生命周期由面驱动、实例由引擎工厂创建；跨 attempt 记忆由工厂组合注入，
 * 不把局部 attempt 与持久 memory 压进一个 id）。
 */
export type DecisionLifetime =
  | { kind: "attempt"; runId: string; subgoalId: string; attempt: number }
  | { kind: "pilot-leg"; runId: string; leg: number };

/** 记忆结果闭集（与执行期 outcome-memory 同口径；effective 清除旧 inert）。 */
export type DecisionMemoryOutcome = "inert" | "effective";

/**
 * 引擎账本面（实现归引擎；面只持有句柄并负责生命周期时机）。**策略由工厂按 lifetime
 * 绑定**，不在调用点上让面二选一：
 *   - `forbiddenRefs`：attempt/run = 显式 forbid 集；pilot-leg = 全部已试 esig 按池重映射；
 *   - `prune`：attempt/run = 只删"同 ref 签名失配"的过期禁选；pilot-leg = 按 esig 全量重映射；
 *   - `notesFor`：attempt/run = rank 档 memory 注记（forbid 档不新增注记）；pilot-leg =
 *     守卫账本全部条目（"已试 N 次 · outcome"）。
 * 三组记账分立：作用域禁选（run）/ 守卫账本（pilot，desc/tries/lastOutcome）/ 跨作用域记忆
 * （outcome-memory 语义）。签名编码唯一 helper（执行期 = `JSON.stringify(esig(el))`），
 * 契约只收 `Sig` 类型，不收未约定编码的字符串。
 */
export interface DecisionAccounting {
  /** 禁选候选（语义由工厂按 lifetime 绑定，见上）。 */
  forbiddenRefs(pool: ElemPool): Set<string>;
  /**
   * 逐候选注记（模式由工厂按 lifetime 绑定，见上；null = 无注记）。
   * attempt/run 的 rank 注记必须落在当前步的 `memoryKey(url, instruction)` 上——调用方先
   * `memoryKey()` 取键再注记，或经 `ctx` 传入作用域（实现可二选一；两者都不得发明键）。
   * pilot-leg 的注记来自守卫账本，**≤8 条、每条 ≤24 字**（与 `PilotLedger.notesFor` 同上限）。
   */
  notesFor(pool: ElemPool, ctx?: { url: string; instruction: string }): Record<string, string> | null;
  /**
   * 唯一 forbid 出口：元素退出动作空间（带原因；诊断面读它）。
   * **pilot-leg 不对称**：守卫账本无 ref→why 列，原因经 `recordLocal` 的 outcome 表达；
   * 已试条目不可删除，故 `unforbid` 只撤本 leg 的显式禁选 overlay。
   */
  forbid(ref: string, el: Elem, why: string): void;
  /** 唯一 un-forbid 出口：页面变化消除阻塞后重新放行。 */
  unforbid(ref: string): void;
  /** 抽池后重剪（策略由工厂按 lifetime 绑定，见上）。 */
  prune(pool: ElemPool): void;
  /**
   * 跨作用域记忆键（url+instruction；与执行期 outcome-memory 同口径）。
   * **无 memory 配置 = fail-closed**（结构化错误，不发明键）；`recordMemory` 无 memory 则
   * no-op（与执行期 `outcomeMemory?.record` 同）。
   */
  memoryKey(url: string, instruction: string): string;
  /** 记忆记账：effective 清除同键旧 inert（执行期语义）。 */
  recordMemory(key: string, sig: Sig, outcome: DecisionMemoryOutcome): void;
  /** 守卫记账：一次驾驶尝试（`desc` 供死目标现场与交接证据用；**首见 desc 固定**，之后只增次数/更结果）。 */
  recordLocal(el: Elem, desc: string, outcome: string): void;
  /**
   * 规则档让位判据：toggle/乒乓形态复读或已判不可命中（规则档跳过，模型档照常可见）。
   * **无角色聚合容器不在这里**：它是池构成事实（引擎在池投影期过滤），不属于账本记录。
   */
  ruleSkip(el: Elem): "changed-loop" | "unhittable" | null;
  /**
   * 死目标守停（执行前判定）：达上限返回现场 `{desc, tries}`，否则 null。
   * 阈值由工厂选项 `repeatLimit` 绑定（缺省与 pilot 契约 `PILOT_REPEAT_LIMIT` 同值）；
   * 契约只承诺返回值，命中后的交接现场写入是实现细节。
   */
  guardStop(el: Elem, desc: string): { desc: string; tries: number } | null;
  /**
   * 守卫账本条目投影（交接证据用）：**上限 ≤8 条**（单源常量），只回 `{desc,tries,lastOutcome}`；
   * **不含守停现场**（现场只从 `guardStop` 返回值拿）。
   */
  entries(limit: number): Array<{ desc: string; tries: number; lastOutcome: string }>;
}

/** 逐层上文回执（DC1.3：任何裁剪/未带/被拒都必须如实回传）。 */
export interface DecisionLayerReceipt {
  layer: DecisionLayer;
  status: "sent" | "clipped" | "unsupported" | "absent" | "rejected";
  chars: number;
  budget?: number;
  truncated?: boolean;
}

/** 询问内部阶梯事件账（事件史，不承担最终动作语义；与执行期选择段分支一一对应）。 */
export const DECISION_ASK_LADDER_CODES = [
  "rules_first",       // 规则分支命中（无模型票）
  "narrow_ask",        // 声明锚点窄问（tieredHint 显式开启）
  "wide_reobserve",    // 低置信宽扫重问
  "window_escalated",  // 窗口升级
  "escalate",          // 升级票
  "adjudicate",        // 裁决票
  "r2b_repair",        // R2b 宽扫触发
  "family_repair",     // 族提名修复（可最终来自 rule）
] as const;
export type DecisionAskLadderCode = (typeof DECISION_ASK_LADDER_CODES)[number];

/**
 * 引擎返回的询问结果（**判别联合**）。`picked` 再按 `origin` 判别票源：规则分支与升级票
 * **没有模型信号**（`signal: null`）；只有 `origin:"model"` 携带完整投票信号（复用执行期
 * `PickProposal` 单源）。`executionPool` = 产出 ref 的那份**完整执行池**（宽扫重问后为宽池；
 * 模型投影永不返回执行面；面只读、不得改/再裁/排序）。`run` 保留执行期 phase 元数据
 * （后续动作与 trace 的连续性载体）；`method/via/ladder/asked` 与执行期同口径。
 */
export type DecisionAskOutcome =
  | ({
      kind: "picked";
      executionPool: ElemPool;
      target: { ref: string; sig: Sig };
      method: string;
      ladder: DecisionAskLadderCode[];
      via: "ask" | "reobserve";
      asked: number;
      /**
       * 执行期选择段 phase 元数据（**执行器实际消费的 7 个字段**，少一个都会丢 trace/anti-repeat 事实）：
       * `conf` 进 trace 与 verbose；`label` 参与 `method === mm` 的 anti-repeat 判定。
       */
      run?: Pick<ModelPickPhase,
        "conf" | "method" | "decisionKind" | "layaMargin" | "tierAsk" | "nominatedRepair" | "escalatedPick">;
      context: { layers: DecisionLayerReceipt[] };
    } & (
      | { origin: "rule" | "escalate"; signal: null }
      | {
          origin: "model";
          signal: {
            proposal: PickProposal;
            scoreKind: ProviderCapabilities["score_kind"];
          };
        }
    ))
  | {
      kind: "abstained";
      executionPool: ElemPool | null;
      /** code 直接复用执行期停因闭集子集（选择段出口），不新造近似码。 */
      reason: { code: StopCode; detail?: string };
      ladder: DecisionAskLadderCode[];
      asked: number;
      context: { layers: DecisionLayerReceipt[] };
    }
  | {
      kind: "limit";
      /** 复用执行期既有码，不另造。 */
      limit: { code: "decision_service_choice_limit"; detail: string };
      asked: number;
      context: { layers: DecisionLayerReceipt[] };
    }
  | {
      kind: "no_model";
      /** 已付的询问次数：provider 首次失败也是"问过之后降级"，不得硬编码 0。 */
      asked: number;
      reason: { code: "no_model_runtime"; detail?: string };
      executionPool: ElemPool | null;
      context: { layers: DecisionLayerReceipt[] };
    };

/**
 * 引擎侧唯一询问 seam：内部自取池（`page`）、按 lifetime 读账本、投影、渲染、有界化，
 * 并把**整个选择段阶梯**（规则分支/窄问→回退/宽扫/窗口升级/升级票/裁决票/R2b/族修复）
 * 作为单次询问的内部实现。端口（face/段/site-facts）由组合根经 `buildMiddleware` 注入。
 */
export interface DecisionAsk {
  ask(page: ProviderPage, scope: DecisionLifetime, accounting: DecisionAccounting,
      intent: DecisionAskIntent, profile: DecisionPickProfile): Promise<DecisionAskOutcome>;
}

/** 面能提供的**询问策略**（引擎执行；不改变裁决权 DC1.5）。 */
export interface DecisionPickProfile {
  face: DecisionFaceKind;
  /** 置信闸门口径（面所有；shape 分档闸门由引擎执行）。 */
  confFloor?: number;
  /** 池构成策略（面所有；缺省 = 面注册项 / 引擎缺省）。 */
  candidatePriority?: "bucketed" | "main-first";
  /** 分级窄问开关：**缺省 false**（与执行期一致——今天的行为就是不窄问）。 */
  tieredHint?: boolean;
  /** 低置信宽扫重问开关（缺省 true = 执行期行为）。 */
  reobserve?: boolean;
  /** 族提名修复的期望族（引擎内部 ladder 的输入事实；面透传）。 */
  expectedFamily?: string | null;
  /** 裁决票开关（低置信是阻断还是信号裁决执行）。 */
  adjudicate?: boolean;
  /** 步级墙钟上限：**询问阶梯的硬约束**（宽扫/窗口升级必须落在剩余预算内，不足即如实停）。 */
  stepTimeoutMs?: number;
  /** 本次询问需要哪些层（缺省 = 面注册项；引擎按 provider 能力档裁剪并逐层回执）。 */
  needs?: DecisionLayer[];
}
