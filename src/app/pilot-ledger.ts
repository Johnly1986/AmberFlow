/**
 * 驾驶守卫账本（P0）：esig 键的已试/结果记账、禁选平移、死目标守停判定与交接证据。
 *
 * 单源：规则档 exclude、模型禁选、守停、交接证据四处都从这一本派生——与 run 面
 * `RunAccounting` / `outcome-memory`（sig 键、forbid|rank 双档）同一认识论：ref 的位置性
 * 重编号不再让禁选失效（实测 e15→e18），toggle/乒乓这类「每步都 changed、URL 不变」的
 * 形态也不再能无声烧预算（`inert` 判据捕获不到 changed=true 的复读）。
 */
import { esig } from "../engine/extraction.ts";
import type { Elem, ElemPool } from "../engine/elem-model.ts";
import { PILOT_REPEAT_LIMIT } from "./pilot-contract.ts";

/** 账本条目：人读摘要 + 累计次数 + 最近结果（changed / no_change / failed:<code> / …）。 */
export interface PilotLedgerEntry { desc: string; tries: number; lastOutcome: string }

/** 交接证据面（≤8 条账本 + 守停现场；空则不出键，保持旧形状）。 */
export interface PilotLedgerEvidence {
  ledger?: Array<{ desc: string; tries: number; last_outcome: string }>;
  loop_stop?: { desc: string; tries: number };
}

export class PilotLedger {
  private readonly entries = new Map<string, PilotLedgerEntry>();
  /** 死目标守停现场：账本命中上限时的元素摘要与次数（交接摘要/证据用）。 */
  loopTrip: { desc: string; tries: number } | null = null;

  /** 规则档不该选的**无角色聚合容器**：含候选后代（整块包装层，词面命中是"容器撞车"）且
   *  既非 native 控件、又无 role、也无监听章——点它通常零变化（实测 Maps 筛选面板聚合 div 被
   *  goal 词面命中，每步 1 步预算全废）。卡片类容器（role=article / 带 handler）不受影响。 */
  static aggregateContainer(el: Elem): boolean {
    if (el.contains_candidate !== true) return false;
    if (el.js_events !== undefined && el.js_events !== null) return false;
    if (String(el.role ?? "") !== "") return false;
    return !["a", "button", "input", "select", "textarea", "label"].includes(String(el.tag ?? ""));
  }

  /** 模型候选窗过滤：去掉**无角色无监听字节的聚合容器**（点它零变化、label 却把多个
   *  选项词拼在一起——实测 Maps 筛选面板在候选窗里被低置信反复选中，每步 1 步预算 + 一次
   *  宽扫重问）。卡片类容器（role / 监听章 / native）保留；无剔除时返回 null（题面不变）。 */
  static filterAggregate(elems: ElemPool): ElemPool | null {
    let dropped = 0;
    const out: ElemPool = {};
    for (const [ref, el] of Object.entries(elems)) {
      if (PilotLedger.aggregateContainer(el)) { dropped += 1; continue; }
      out[ref] = el;
    }
    return dropped === 0 ? null : out;
  }

  /** 元素签名键（引擎单源 `esig`；与 run 面 forbid/outcome-memory 同一口径）。 */
  static esigKey(el: Elem): string {
    return esig(el).join("\u0000");
  }

  /** 记账：同一 esig 的累计次数与最近结果。 */
  bump(el: Elem, desc: string, outcome: string): void {
    const key = PilotLedger.esigKey(el);
    const cur = this.entries.get(key);
    if (cur === undefined) this.entries.set(key, { desc, tries: 1, lastOutcome: outcome });
    else { cur.tries += 1; cur.lastOutcome = outcome; }
  }

  tries(el: Elem): number {
    return this.entries.get(PilotLedger.esigKey(el))?.tries ?? 0;
  }

  /** 禁选按 esig 平移：每轮重抽池后按新 ref 重建 ref 键视图（消费面：模型票/证据）。 */
  forbiddenRefs(elems: ElemPool): Set<string> {
    const out = new Set<string>();
    for (const [r, el] of Object.entries(elems)) {
      if (this.entries.has(PilotLedger.esigKey(el))) out.add(r);
    }
    return out;
  }

  /** 规则档 exclude：只排除**已改变状态却未推进**的 esig（toggle/乒乓形态）；无变化/失败/
   *  拒绝的复读仍交给 inert/deny 计数收尾（那是 stuck_inert 的诚实口径，规则档必须能重试到阈值）。 */
  changedLoop(el: Elem): boolean {
    return this.entries.get(PilotLedger.esigKey(el))?.lastOutcome === "changed";
  }

  /** 该元素已被判「不可命中/不可动作」（动作前快速拒绝的账本口径）：规则档与模型档都跳过它，
   *  避免同一被覆盖目标每轮重选（每次 5.8s 探针 + 1 步预算）。 */
  unhittable(el: Elem): boolean {
    const outcome = this.entries.get(PilotLedger.esigKey(el))?.lastOutcome;
    return outcome !== undefined && (outcome.startsWith("unhittable") || outcome === "stale_ref"
      || outcome.startsWith("unsupported"));
  }

  /**
   * 该元素**已证明执行成功但不产生变化**（`no_change`）：规则档跳过它。
   * 与 `changedLoop` 的分工：后者排"变过又变回"的乒乓；这个排"压根没变"的复读。
   * 只作用于规则档——模型档仍可重新考虑（页面已变时模型能给出不同理由，规则不能）。
   * 现场：走查里广告文案与目标词面重合，规则档连点三次同一广告，白耗 3 步预算。
   */
  inertNoChange(el: Elem): boolean {
    return this.entries.get(PilotLedger.esigKey(el))?.lastOutcome === "no_change";
  }

  /** 死目标守停（执行前判定；run 面 `maxEffectiveRepeats` 同口径）：同一 esig 已驱动达上限 =
   *  再执行只会重复烧预算。命中即落 loopTrip 并返回 true（调用方按 stuck_inert 停）。 */
  guardStop(el: Elem, desc: string): boolean {
    const prior = this.tries(el);
    if (prior < PILOT_REPEAT_LIMIT) return false;
    this.loopTrip = { desc, tries: prior };
    return true;
  }

  /** L2 上文注记出口（DC1.2/DC1.4）：账本里有记录的候选给一句人读负面证据（≤24 字/条、
   *  ≤8 条），喂给模型票的 `notes`（ChoiceRequest.notes 既有通道；minimal 档天然可用）。
   *  只表达"试过几次 + 最近结果"，不解释长文（那归 L3/L4）；空 = null（题面逐字节不变）。 */
  notesFor(elems: ElemPool): Record<string, string> | null {
    const out: Record<string, string> = {};
    let n = 0;
    for (const [r, el] of Object.entries(elems)) {
      const e = this.entries.get(PilotLedger.esigKey(el));
      if (e === undefined) continue;
      if (n >= 8) break;
      out[r] = `已试 ${String(e.tries)} 次 · ${e.lastOutcome}`.slice(0, 24);
      n += 1;
    }
    return n === 0 ? null : out;
  }

  /** 交接证据（≤8 条 + 守停现场；无账本/无守停 = 空对象，旧形状不变）。 */
  evidence(): PilotLedgerEvidence {
    return {
      ...(this.entries.size === 0 ? {} : {
        ledger: [...this.entries.values()].slice(-8).map((e) => ({
          desc: e.desc, tries: e.tries, last_outcome: e.lastOutcome,
        })),
      }),
      ...(this.loopTrip === null ? {} : { loop_stop: this.loopTrip }),
    };
  }

  /** 清段（redirect 改道 = 换语境；与步史/禁选同一纪律）。 */
  clear(): void {
    this.entries.clear();
    this.loopTrip = null;
  }
}
