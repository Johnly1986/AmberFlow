/**
 * 执行器实现模块（从 executor-phases-b 切分）：窗口递增链的**硬顶档重问**——
 * 选择段的两处同构段（低置信恢复 / R2b 词面守卫的 120 档未命中分支）单源到这里。
 *
 * 本文件函数是 `BrowserMiddleware` 的实现片段，显式接收 `mw` 实例；deps 全部显式注入
 * （pickElement/orderedPool/pruneForbids/forbidden/noted/stepTimeoutLeft…），不闭包捕获
 * run() 状态。两处调用的语义差异（recovered/widePick/gateRejected 的后续处理）由返回值
 * 表达、留在调用方；window_escalation 事实就地追加进调用方持有的本步数组（与 trace 行
 * 证据共享同一份）。
 */
import { WIDE_QUOTAS, type ElemPool } from "./extraction.ts";
import { introducesNewIdentity } from "./elem-model.ts";
import { WIDER_ELEMENTS_MAX, type WindowChainFact } from "./executor-pure.ts";
import type { AnyPage, Sig } from "./executor-types.ts";
import type { BrowserMiddleware } from "./executor.ts";

/**
 * 硬顶档重问的结果：grew=该档带来新候选（调用方应换本步视图）；adopted=重问意见过了 floor；identityFlat=抽取成功但没引入新身份（本轮恢复就此止损，调用方按此归因）。
 */
export type WindowRungOutcome =
  | { grew: true; pool: ElemPool; adopted: boolean; ref: string | null; conf: number }
  | { grew: false; pool: null; adopted: false; ref: null; conf: 0; identityFlat: boolean };

/**
 * 窗口递增链第二档：扩到硬顶（WIDER_ELEMENTS_MAX）重抽池 → 同一排序取前 K → 重问一次。
 *
 * 门控：`stepTimeoutLeft() > 0` 且新窗比传入的当前视图（上一档窗口）**引入了新的元素身份**
 * ——页面本来只有那些候选时新窗只是重编号，就此停止加码（不付询问、不记窗口链事实，
 * `identityFlat` 交调用方归因）。命中（意见过 floor）后的"命中即停"由调用方落地（本函数只
 * 如实回结果，不推进 recovered/widePick 等调用方状态）。widgets:true 与宽扫档同款——伪按钮
 * 通道随扩窗轮次按既有规则展开；quotas 沿用 WIDE_QUOTAS 预算档（分桶 + 顺延可达硬顶）。
 */
export async function runWindowEscalationRung(mw: BrowserMiddleware, a: {
  pg: AnyPage; stepNo: number; instruction: string; verbose: boolean;
  /** 身份基准 = 上一档窗口（调用方当前视图）。 */
  elems: ElemPool;
  /** 过闸线（与调用方 floor 同一值）。 */
  floor: number;
  forbidden: Record<string, Sig>; noted: Record<string, string> | null;
  candidatePriority: "bucketed" | "main-first"; frameHosts: string[] | null;
  stepTimeoutLeft: () => number;
  pickElement: (goal: string, page: AnyPage, pool: ElemPool, blocked: Set<string>, notes: Record<string, string> | null) => Promise<[string | null, number, Record<string, number>]>;
  /** 排序先验（调用方闭包；本函数**显式传池**——无参形式读到的是 run() 的旧池，不是宽视图）。 */
  orderedPool: (pool: ElemPool) => ElemPool;
  pruneForbids: (pool: ElemPool) => void;
  /** 本步窗口链事实数组（调用方持有；命中/未命中事实就地追加）。 */
  windowChainFacts: WindowChainFact[];
  /** verbose 日志首段（两处调用的既有文案不同）。 */
  logTag: string;
  /** 命中行 "window <硬顶档>" 之后的尾段（两处既有文案不同，保持逐字节）。 */
  hitNote: (poolSize: number, ref: string, conf: number) => string;
  /** 未命中行 "window <硬顶档> ->" 之后的尾段。 */
  missNote: (pick: { ref: string | null; conf: number }) => string;
}): Promise<WindowRungOutcome> {
  if (!(a.stepTimeoutLeft() > 0)) return { grew: false, pool: null, adopted: false, ref: null, conf: 0, identityFlat: false };
  const wider = await mw.candidates!.extract({ page: a.pg, jsProbe: true, maxElements: WIDER_ELEMENTS_MAX, widgets: true, quotas: WIDE_QUOTAS, candidatePriority: a.candidatePriority, hosts: a.frameHosts });
  if (!introducesNewIdentity(wider, a.elems)) {
    return { grew: false, pool: null, adopted: false, ref: null, conf: 0, identityFlat: true };
  }
  a.pruneForbids(wider);
  const [ref2, conf2] = await a.pickElement(a.instruction, a.pg, a.orderedPool(wider), new Set(Object.keys(a.forbidden)), a.noted);
  const poolSize = Object.keys(wider).length;
  if (ref2 !== null && conf2 >= a.floor) {
    a.windowChainFacts.push({ window: WIDER_ELEMENTS_MAX, miss: 2, resolved: true, ref: ref2 });
    if (a.verbose) console.log(`  step ${a.stepNo}: ${a.logTag} window ${WIDER_ELEMENTS_MAX} ${a.hitNote(poolSize, ref2, conf2)}`);
    return { grew: true, pool: wider, adopted: true, ref: ref2, conf: conf2 };
  }
  a.windowChainFacts.push({ window: WIDER_ELEMENTS_MAX, miss: 2, resolved: false });
  if (a.verbose) console.log(`  step ${a.stepNo}: ${a.logTag} window ${WIDER_ELEMENTS_MAX} -> ${a.missNote({ ref: ref2, conf: conf2 })}`);
  return { grew: true, pool: wider, adopted: false, ref: ref2, conf: conf2 };
}
