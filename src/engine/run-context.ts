/**
 * `BrowserMiddleware.run()` 的四组记账状态载体（RunCtx）。
 *
 * 为什么单独成对象：stop 停因 / forbid 与原因 / noteSkipped / unforbid·pruneForbids
 * 原本是 `run()` 内的四组局部闭包，状态与逻辑一起埋在 2600+ 行的执行循环里，后续
 * 阶段拆分无法把它们交给独立函数。收敛成一个**每 run 实例化**的对象后：
 *   - 状态（stopCode/stopReason/stopStep、forbidden/forbidWhy、blockedRetry、reAdmitted、
 *     skippedActions）有唯一 owner；
 *   - 四个出口（`stop` / `forbid` / `unforbid` / `pruneForbids` / `noteSkipped`）的语义
 *     只在这里定义一次；
 *   - `run()` 只持入口引用，调用顺序与返回值不变（零语义差）。
 *
 * 纪律：
 *   - 无模块级可变状态：所有字段由 `createRunAccounting()` 每次调用新建；
 *   - 不 import Playwright / 页面具体类型：只用 engine 既有结构类型（`Elem`/`ElemPool`/
 *     `Sig`/`SkippedAction`/`StopCode`）与纯函数 `esig`/`sigEq`；
 *   - `pruneForbids` 的时机由调用方掌握（重新抽池后按**元素签名**重剪，refs 会被重编号），
 *     本文件不主动调度。
 */
import { esig, type Elem, type ElemPool } from "./extraction.ts";
import type { Sig, SkippedAction, StopCode } from "./executor-types.ts";
import { sigEq } from "./executor-pure.ts";

/** `run()` 记账对象的创建参数。 */
export interface RunAccountingOptions {
  /** 动作预算上限：只用于默认停因文案（与 `run()` 的原默认串逐字一致）。 */
  readonly maxSteps: number;
}

/**
 * 一个 subgoal 的记账对象（`run()` 开头创建一次；不跨 run 复用）。
 *
 * `stopCode`/`stopReason`/`stopStep` 是可变字段：只有 `stop()` 出口写它们。
 */
export interface RunAccounting {
  /** a) 停因（最后一个 `stop()` 的现场；缺省 = 预算用尽）。 */
  stopCode: StopCode;
  stopReason: string;
  stopStep: number | undefined;
  /** b) ref → 元素签名；同 ref 的元素签名变了就不该继续禁（见 pruneForbids）。 */
  readonly forbidden: Record<string, Sig>;
  /** b) ref → 被禁原因（诊断面；不参与判定）。 */
  readonly forbidWhy: Record<string, string>;
  /** d) ref → (step, trace 长度)：仅因遮罩/不可动作而跳过的候选，页面变化后可重试。 */
  readonly blockedRetry: Record<string, [number, number]>;
  /** d) 本 run 内被重新放行的 ref（unforbid 出口去重记账）。 */
  readonly reAdmitted: Set<string>;
  /** c) 跳过动作的结构化原因（同一 (command_id, ref, reason) 只记一次）。 */
  readonly skippedActions: SkippedAction[];
  /** a) 唯一停因出口：写 code/step，给了 detail 才覆盖 reason。 */
  stop(code: StopCode, detail?: string, at?: number): void;
  /** b) 唯一 forbid 出口：元素离开动作空间只经这里（同时记原因）。 */
  forbid(ref: string, el: Elem, why: string): void;
  /** d) 唯一 un-forbid 出口：页面变化消除阻塞后重新放行（清 allow 记账）。 */
  unforbid(ref: string): void;
  /** d) 唯一重剪出口：refs 每次抽池重编号，签名不符的过期 forbiddance 必须清掉。 */
  pruneForbids(elems: ElemPool): void;
  /** c) 记一条 skipped（幂等：同 (command_id, ref, reason) 只入账一次）。 */
  noteSkipped(s: SkippedAction): void;
}

/** 新建一个 run 的记账对象（每次 `run()` 调用一次；字段/集合全部新建）。 */
export function createRunAccounting(opts: RunAccountingOptions): RunAccounting {
  const seenSkipped = new Set<string>();
  const acct: RunAccounting = {
    stopCode: "max_steps",
    // 默认值只在"循环自然用满、没有任何站点显式 stop"时存活；带预算数字，作者能判断
    // 是预算还是进度问题（与 `run()` 原默认串逐字一致）。
    stopReason:
      `subgoal action budget used up (${opts.maxSteps} action step(s) tried) without the done-signal ever holding — `
      + `raise the budget, narrow the target, or check what the page did after each action`,
    stopStep: undefined,
    forbidden: {},
    forbidWhy: {},
    blockedRetry: {},
    reAdmitted: new Set<string>(),
    skippedActions: [],
    stop(code: StopCode, detail?: string, at?: number): void {
      acct.stopCode = code;
      if (detail !== undefined) acct.stopReason = detail;
      if (at !== undefined) acct.stopStep = at;
    },
    forbid(ref: string, el: Elem, why: string): void {
      acct.forbidden[ref] = esig(el);
      acct.forbidWhy[ref] = why;
    },
    unforbid(ref: string): void {
      delete acct.forbidden[ref];
      delete acct.blockedRetry[ref];
      delete acct.forbidWhy[ref];
    },
    pruneForbids(elems: ElemPool): void {
      for (const r of Object.keys(acct.forbidden)) {
        const cur = elems[r];
        if (cur === undefined || !sigEq(acct.forbidden[r]!, esig(cur))) {
          acct.unforbid(r);
          acct.reAdmitted.delete(r);
        }
      }
    },
    noteSkipped(s: SkippedAction): void {
      const key = `${s.command_id ?? ""}\u0000${s.ref ?? ""}\u0000${s.reason}`;
      if (seenSkipped.has(key)) return;
      seenSkipped.add(key);
      acct.skippedActions.push(s);
    },
  };
  return acct;
}
