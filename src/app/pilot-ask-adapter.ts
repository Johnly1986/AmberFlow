/**
 * pilot 面的决策询问适配器（DC7 边界）：把 `BrowserMiddleware` + `PilotLedger` 折成引擎的
 * `DecisionAskHost`，并维护 pilot-leg 作用域与账本实例（策略由引擎工厂按 lifetime 绑定）。
 *
 * 边界：本文件属应用层，可 import engine；engine 反向不 import 本文件（`DecisionAskHost`
 * 是纯结构类型）。面只提供观察与投票原语，候选池/禁选/注记/SQL 阶梯归引擎 `decision-ask.ts`。
 *
 * 作用域：一次 pilot 驾驶 = 一个 `pilot-leg`；改道（redirect）即换语境——`noteRedirect()`
 * 让 leg 自增并让下一轮询问重建账本实例（本 leg 显式禁选不跨改道残留；守卫账本由面按既有
 * 纪律 `clear()`，不在本适配器里复制清段逻辑）。
 */
import { WIDE_QUOTAS } from "../engine/extraction.ts";
import type { ElemPool } from "../engine/elem-model.ts";
import { createDecisionAccounting } from "../engine/decision-accounting.ts";
import { createDecisionAsk, type DecisionAskHost } from "../engine/decision-ask.ts";
import type {
  DecisionAccounting, DecisionAsk, DecisionAskOutcome, DecisionAskPorts, DecisionLifetime,
} from "../engine/decision-ask-contract.ts";
import { WIDER_ELEMENTS } from "../engine/executor-pure.ts";
import { decisionAskPortsOf } from "./middleware-factory.ts";
import type { AnyPage, BrowserMiddleware } from "../engine/executor.ts";
import type { ProviderPage } from "../support/decision-provider-contract.ts";
import { PilotLedger } from "./pilot-ledger.ts";
import { askViewOf } from "./pilot-tree.ts";
import { loadSiteFacts, matchSiteFacts, renderModelFence } from "./site-facts.ts";

/** 一次 pilot 驾驶的询问入口（modelVote 委托面；池/禁选/注记由引擎自取）。 */
export interface PilotAskCall {
  page: AnyPage;
  goal: string;
  confFloor: number;
}

/**
 * pilot 面 ask 适配器。`mw`/`hosts` 走惰性 getter：驾驶面是惰性建 middleware 的，
 * 适配器要能在 middleware 之前构造（字段初始化顺序不成为耦合）。
 */
export class PilotAskAdapter {
  /** 询问 seam（惰性建：端口来自 `buildMiddleware` 的 WeakMap，构造期 middleware 可能还不存在）。 */
  private askSeam: DecisionAsk | null = null;
  private readonly ledger: PilotLedger;
  private readonly mwRef: () => BrowserMiddleware;
  private readonly hostsRef: () => string[] | null;
  private readonly runId: string;
  /** 当前 leg；改道自增（见 `noteRedirect`）。 */
  private leg = 1;
  /** 当前 leg 的账本实例（按 lifetime 由引擎工厂创建；改道后惰性重建）。 */
  private accounting: DecisionAccounting | null = null;
  private boundLeg = 0;

  /** L4 site-facts 文件缓存（进程内一次加载；按 hosts 每次匹配，端口无命中 = null）。 */
  private siteFactsCache: ReturnType<typeof loadSiteFacts> | null = null;

  constructor(mw: () => BrowserMiddleware, ledger: PilotLedger, hosts: () => string[] | null, runId = "pilot") {
    this.mwRef = mw;
    this.ledger = ledger;
    this.hostsRef = hosts;
    this.runId = runId;
  }

  /** 改道 = 换语境：leg 自增，下一轮询问用新作用域的账本实例。 */
  noteRedirect(): void {
    this.leg += 1;
    this.accounting = null;
  }

  /** 当前 leg 作用域（诊断/证据面读它；账本实例不跨 leg 复用）。 */
  scope(): DecisionLifetime {
    return { kind: "pilot-leg", runId: this.runId, leg: this.leg };
  }

  /** 询问 seam：组合根经 `buildMiddleware` 注入的端口随 middleware 一起取（缺省 = 无端口）。 */
  private seam(): DecisionAsk {
    if (this.askSeam === null) {
      this.askSeam = createDecisionAsk(this.host(), { ports: this.ports() });
    }
    return this.askSeam;
  }

  /** 询问一次：引擎自取池、读账本、执行窄问→闸门→宽扫阶梯，回执行池与投票信号。 */
  async vote(a: PilotAskCall): Promise<DecisionAskOutcome> {
    return await this.seam().ask(
      a.page as unknown as ProviderPage,
      this.scope(),
      this.accountingForLeg(),
      { goal: a.goal },
      { face: "pilot", confFloor: a.confFloor, reobserve: true },
    );
  }

  private accountingForLeg(): DecisionAccounting {
    if (this.accounting === null || this.boundLeg !== this.leg) {
      this.accounting = createDecisionAccounting({ pilot: this.ledger }, this.scope());
      this.boundLeg = this.leg;
    }
    return this.accounting;
  }

  /**
   * 组合根端口：L4 站点知识按本面 hosts 信封匹配（与 run 面 D2 的 site-facts 同一份文件与
   * fence 渲染）；无命中/读失败 = null（请求体形状不变）。既有端口原样透传。
   */
  private ports(): DecisionAskPorts {
    const base = decisionAskPortsOf(this.mwRef());
    return {
      ...(base ?? {}),
      siteFacts: {
        notes: async () => {
          const hosts = this.hostsRef();
          if (hosts === null || hosts.length === 0) return null;
          try {
            if (this.siteFactsCache === null) {
              this.siteFactsCache = loadSiteFacts(() => { /* pilot 面没有 stderr 通道 */ });
            }
            return renderModelFence(matchSiteFacts(this.siteFactsCache, hosts));
          } catch { return null; }
        },
      },
    };
  }

  /** host 原语：窄池 = 驾驶面同一条抽池链；宽扫 = 执行期 4d 同款参数（WIDER_ELEMENTS/WIDE_QUOTAS）。 */
  private host(): DecisionAskHost {
    return {
      ready: async () => {
        const mw = this.mwRef();
        await mw.ready();
        return { rulesOnly: mw.rulesOnly };
      },
      extract: async (page, wide) => {
        const mw = this.mwRef();
        const anyPage = page as unknown as AnyPage;
        if (!wide) return (await mw._extractPoolSettled(anyPage, "bucketed")).elems;
        await mw._settleBeforeExtract(anyPage);
        return await mw.candidates!.extract({
          page: anyPage, jsProbe: true, maxElements: WIDER_ELEMENTS, widgets: true,
          quotas: WIDE_QUOTAS, candidatePriority: "bucketed", hosts: this.hostsRef() ?? undefined,
        });
      },
      // 提问视图：空标签行补身份 token（浏览器树的注入段）；ref/顺序/执行面不变。
      pick: async (goal, page, pool: ElemPool, forbidden: Set<string>, notes: Record<string, string> | null) =>
        await this.mwRef().pickProposal(goal, page as unknown as AnyPage, askViewOf(pool), forbidden, notes),
      filter: (pool: ElemPool): ElemPool | null => PilotLedger.filterAggregate(pool),
      scoreKind: () => this.mwRef().decision?.capabilities.score_kind ?? "entropy_conf",
      contextCapability: () => this.mwRef().decision?.capabilities.context ?? null,
    };
  }
}
