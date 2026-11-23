/**
 * `DecisionAccounting` 工厂（DC7.5：契约 v5 的账本面由**引擎工厂按 lifetime 创建**）。
 *
 * 定位：把既有三本账**组合**成一个面，不改任何旧账本、不动 run/pilot 调用点——
 *   - 作用域禁选（`src/engine/run-context.ts` 的 `RunAccounting`：forbidden/forbidWhy）；
 *   - 守卫账本（`src/app/pilot-ledger.ts` 的 `PilotLedger`：desc/tries/lastOutcome）；
 *   - 跨作用域记忆（outcome-memory 语义：url+instruction 键、`"inert"|"effective"`，effective 清旧 inert）。
 *
 * 边界（DC7）：engine 不得 import 应用层（`src/app/*`）。pilot 守卫账本按**结构接口**
 * `PilotLedgerLike` 注入——调用方传现有 `PilotLedger` 实例即可，不在这里 import 它。
 * 记忆类型取 engine 侧类型面单源（`./executor-types.ts` 的 `OutcomeMemoryLike`），
 * **不新增** engine→model 依赖边（MAINLINE §1.2 只减不增）。
 *
 * 交接证据边界：`entries(limit)` 只做守卫条目投影，上限是单源常量
 * `DECISION_ACCOUNTING_ENTRIES_MAX`（8）；它**不含守停现场**——现场只经 `guardStop`
 * 的返回值 `{desc,tries}` 交给调用方（pilot 账本的 `loopTrip` 另由既有交接证据面读）。
 *
 * **签名编码纪律（唯一出口）**：memory sig 只经 `decisionSigOf(el)` 编码，即
 * `JSON.stringify(esig(el))`——与执行期 outcome-memory 记账逐字节同口径。pilot 守卫账本的
 * 内部键另用 `esig(el).join("\u0000")`（`PilotLedger.esigKey` 同口径）。**两种编码不得混用**：
 * 前者进跨运行记忆，后者只做本次驾驶的去重键。
 *
 * 策略**由工厂按 lifetime 绑定**（调用点不二选一；契约成员注释为准）：
 *   | 成员 | attempt/run | pilot-leg |
 *   |---|---|---|
 *   | `forbiddenRefs` | run 显式 forbid 键集 | 账本全部已试 esig 按池重映射 + 本 leg 显式禁选 |
 *   | `prune` | 只删「同 ref 签名失配」的过期禁选（`pruneForbids` 同语义） | 按 esig 全量重映射 |
 *   | `notesFor` | 仅 rank 档 memory inert 注记；forbid 档 = null | 守卫账本全部条目（已试 N 次 · outcome） |
 */
import type { DecisionAccounting, DecisionLifetime, DecisionMemoryOutcome } from "./decision-ask-contract.ts";
import { esig, type Elem, type ElemPool } from "./extraction.ts";
import type { OutcomeMemoryLike, Sig } from "./executor-types.ts";
import type { RunAccounting } from "./run-context.ts";

/** 守卫账本条目投影（交接证据面用；与 `PilotLedgerEntry` 同形）。 */
export interface DecisionGuardEntry {
  desc: string;
  tries: number;
  lastOutcome: string;
}

/**
 * pilot 守卫账本的结构接口（engine 禁 import 应用层，故只按形状注入；调用方传现有
 * `PilotLedger` 实例）。只列工厂真正消费的成员：`loopTrip` 由 pilot-leg 的 `guardStop`
 * 命中时写入（交接证据依赖它）。
 */
export interface PilotLedgerEvidenceLike {
  ledger?: Array<{ desc: string; tries: number; last_outcome: string }>;
  loop_stop?: { desc: string; tries: number };
}

export interface PilotLedgerLike {
  bump(el: Elem, desc: string, outcome: string): void;
  tries(el: Elem): number;
  forbiddenRefs(pool: ElemPool): Set<string>;
  notesFor(pool: ElemPool): Record<string, string> | null;
  changedLoop(el: Elem): boolean;
  unhittable(el: Elem): boolean;
  /** 死目标守停现场（可变字段：pilot-leg `guardStop` 命中时写入，与既有账本同形）。 */
  loopTrip: { desc: string; tries: number } | null;
  evidence(): PilotLedgerEvidenceLike;
}

/** 工厂依赖（按 lifetime 校验必填项；多余项忽略，不静默降级）。 */
export interface DecisionAccountingDeps {
  /** attempt 面必填：作用域禁选账本（`src/engine/run-context.ts`）。 */
  run?: RunAccounting;
  /** 跨作用域记忆（两 lifetime 均可选；缺省 = 记忆成员如实空转，`memoryKey` 抛结构化错误）。 */
  memory?: OutcomeMemoryLike | null;
  /** pilot-leg 面必填：守卫账本（现有 `PilotLedger` 实例）。 */
  pilot?: PilotLedgerLike | null;
}

/** 工厂选项（策略/阈值由调用方按面传入；缺省值即既有执行期口径）。 */
export interface DecisionAccountingOptions {
  /**
   * attempt 面：outcome-memory 消费档（`src/engine/executor-types.ts` 的 `RunOptions.outcomeMemoryMode`）。
   * 缺省 `"forbid"` = 与执行期缺省一致：不新增注记（禁选由 run 面负责）。
   */
  outcomeMemoryMode?: "forbid" | "rank";
  /**
   * attempt 面：`notesFor` 用的记忆键提供者。缺省 = 最近一次 `memoryKey(url,instruction)` 的返回值
   * （调用方在询问前取键，既是 recordMemory 的键，也是 rank 注记的作用域）。
   */
  memoryKey?: () => string | null;
  /**
   * 守卫上限。缺省 3——与 `src/app/pilot-contract.ts` 的 `PILOT_REPEAT_LIMIT` 同口径；
   * engine 禁 import 应用层，故由调用方/本选项传入同值。
   */
  repeatLimit?: number;
}

/** `entries(limit)` 的硬上限（交接证据有界；与 pilot 交接块 ≤8 条同口径）。 */
export const DECISION_ACCOUNTING_ENTRIES_MAX = 8;
/** 守卫上限缺省值（与 pilot 契约 `PILOT_REPEAT_LIMIT` 同口径）。 */
export const DECISION_GUARD_REPEAT_LIMIT_DEFAULT = 3;
/** rank 档 memory 注记定文本（执行期 `pickElement` 的同一句，不得改写）。 */
export const DECISION_MEMORY_INERT_NOTE = "[tried before, page did not change]";

/** 结构化错误码闭集（缺依赖/非法选项 = 配置错误，绝不静默降级）。 */
export const DECISION_ACCOUNTING_ERROR_CODES = [
  "missing_run_accounting",
  "missing_pilot_ledger",
  "unknown_lifetime",
  "invalid_outcome_memory_mode",
  "invalid_repeat_limit",
  "memory_not_configured",
] as const;
export type DecisionAccountingErrorCode = (typeof DECISION_ACCOUNTING_ERROR_CODES)[number];

/** 结构化错误：`code` 是闭集码，`detail` 是人读现场（不抛裸栈给面）。 */
export class DecisionAccountingError extends Error {
  readonly code: DecisionAccountingErrorCode;
  readonly detail: string;

  constructor(code: DecisionAccountingErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "DecisionAccountingError";
    this.code = code;
    this.detail = detail;
  }
}

/** memory sig 的编码实现（本文件唯一一处 `JSON.stringify(Sig)`；对外只经 `decisionSigOf`）。 */
function encodeMemorySig(sig: Sig | readonly string[]): string {
  return JSON.stringify(sig);
}

/** memory sig 的唯一编码出口（`Sig` = [tag,label,data_test] 三元组；与执行期同一条 JSON 编码）。 */
export function decisionSigOf(el: Elem): string {
  return encodeMemorySig(esig(el));
}

/** pilot 守卫账本内部键（`PilotLedger.esigKey` 同口径；**不得**当作 memory sig）。 */
function guardKeyOf(el: Elem): string {
  return esig(el).join("\u0000");
}

/** 累计式防抖记账（既有 `PilotLedger.bump` 语义：首见 desc 固定，次数/末次结果更新）。 */
function bumpGuard(book: Map<string, DecisionGuardEntry>, el: Elem, desc: string, outcome: string): void {
  const key = guardKeyOf(el);
  const cur = book.get(key);
  if (cur === undefined) book.set(key, { desc, tries: 1, lastOutcome: outcome });
  else {
    cur.tries += 1;
    cur.lastOutcome = outcome;
  }
}

/** 规则档让位判据（既有 `PilotLedger.changedLoop` / `unhittable` 两判据同序）。 */
function ruleSkipOf(entry: DecisionGuardEntry | undefined): "changed-loop" | "unhittable" | null {
  if (entry === undefined) return null;
  if (entry.lastOutcome === "changed") return "changed-loop";
  const out = entry.lastOutcome;
  if (out.startsWith("unhittable") || out === "stale_ref" || out.startsWith("unsupported")) return "unhittable";
  return null;
}

/** 条目投影上限：非有限/非正 = 空；超过上限按上限（不抛，证据面只做有界投影）。 */
function clampEntryLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 0;
  const n = Math.floor(limit);
  if (n <= 0) return 0;
  return Math.min(n, DECISION_ACCOUNTING_ENTRIES_MAX);
}

/** 选项校验（非法值 = 配置错误；`undefined` = 用缺省口径）。 */
function repeatLimitOf(options: DecisionAccountingOptions): number {
  const limit = options.repeatLimit;
  if (limit === undefined) return DECISION_GUARD_REPEAT_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new DecisionAccountingError("invalid_repeat_limit", `repeatLimit must be a positive integer, got ${String(limit)}`);
  }
  return limit;
}

/** 记忆档校验（闭集外的值 = 配置错误，不当作 forbid）。 */
function memoryModeOf(options: DecisionAccountingOptions): "forbid" | "rank" {
  const mode = options.outcomeMemoryMode;
  if (mode === undefined) return "forbid";
  if (mode !== "forbid" && mode !== "rank") {
    throw new DecisionAccountingError("invalid_outcome_memory_mode", `outcomeMemoryMode must be "forbid" or "rank", got ${String(mode)}`);
  }
  return mode;
}

/** 每次账本实例的记忆作用域游标（`memoryKey` 是键单源，`notesFor(rank)` 消费它）。 */
interface MemoryScope {
  currentKey: string | null;
}

/** 取当前记忆键：显式 provider 优先（跨 step URL 变化时由调用方给当前页），否则用最近一次取键。 */
function currentMemoryKey(options: DecisionAccountingOptions, scope: MemoryScope): string | null {
  return options.memoryKey === undefined ? scope.currentKey : options.memoryKey();
}

/** `memoryKey` 出口：键编码归 memory 实现（唯一出处），本文件不复制哈希。 */
function memoryKeyOf(
  memory: OutcomeMemoryLike | null, scope: MemoryScope, url: string, instruction: string,
): string {
  if (memory === null) {
    throw new DecisionAccountingError("memory_not_configured", "memoryKey requires deps.memory (no memory = no cross-scope key; refusing to invent one)");
  }
  scope.currentKey = memory.key(url, instruction);
  return scope.currentKey;
}

/** `recordMemory` 出口：`Sig` 经 JSON 编码后入账（与 `decisionSigOf` 同一条编码）。 */
function recordMemoryTo(memory: OutcomeMemoryLike | null, key: string, sig: Sig, outcome: DecisionMemoryOutcome): void {
  if (memory === null) return;
  memory.record(key, encodeMemorySig(sig), outcome);
}

/* ------------------------------------------------------------------ attempt 面 */

/**
 * `attempt`：作用域禁选归 run（显式 forbid），跨 attempt 记忆归 outcome-memory，
 * 守卫账本为本 attempt 内的引擎侧局部账（不读取 run 的 effectiveRuns——那是执行器内部反惰性计数）。
 */
function createAttemptAccounting(
  run: RunAccounting, memory: OutcomeMemoryLike | null, options: DecisionAccountingOptions,
): DecisionAccounting {
  const scope: MemoryScope = { currentKey: null };
  const guard = new Map<string, DecisionGuardEntry>();
  const limit = repeatLimitOf(options);
  const rank = memoryModeOf(options) === "rank";

  return {
    /** 显式 forbid 键集（不按池回筛：抽池后必须先 `prune`，与执行期同序）。 */
    forbiddenRefs(_pool: ElemPool): Set<string> {
      return new Set(Object.keys(run.forbidden));
    },
    /** 仅 rank 档：memory inert 的候选给定文本注记；forbid 档/无记忆/未取键 = null。 */
    notesFor(pool: ElemPool): Record<string, string> | null {
      if (!rank || memory === null) return null;
      const key = currentMemoryKey(options, scope);
      if (key === null) return null;
      const inert = memory.inertIn(key);
      if (inert.size === 0) return null;
      const noted: Record<string, string> = {};
      for (const [ref, el] of Object.entries(pool)) {
        if (run.forbidden[ref] !== undefined) continue;
        if (inert.has(decisionSigOf(el))) noted[ref] = DECISION_MEMORY_INERT_NOTE;
      }
      return Object.keys(noted).length === 0 ? null : noted;
    },
    forbid(ref: string, el: Elem, why: string): void {
      run.forbid(ref, el, why);
    },
    unforbid(ref: string): void {
      run.unforbid(ref);
    },
    /** 单源委托 `RunAccounting.pruneForbids`（同 ref 签名失配/元素消失才清；不迁移到新 ref）。 */
    prune(pool: ElemPool): void {
      run.pruneForbids(pool);
    },
    memoryKey(url: string, instruction: string): string {
      return memoryKeyOf(memory, scope, url, instruction);
    },
    recordMemory(key: string, sig: Sig, outcome: DecisionMemoryOutcome): void {
      recordMemoryTo(memory, key, sig, outcome);
    },
    recordLocal(el: Elem, desc: string, outcome: string): void {
      bumpGuard(guard, el, desc, outcome);
    },
    ruleSkip(el: Elem): "changed-loop" | "unhittable" | null {
      return ruleSkipOf(guard.get(guardKeyOf(el)));
    },
    guardStop(_el: Elem, desc: string): { desc: string; tries: number } | null {
      const prior = guard.get(guardKeyOf(_el))?.tries ?? 0;
      if (prior < limit) return null;
      return { desc, tries: prior };
    },
    entries(limitN: number): DecisionGuardEntry[] {
      const lim = clampEntryLimit(limitN);
      if (lim === 0) return [];
      return [...guard.values()].slice(-lim).map((e) => ({ ...e }));
    },
  };
}

/* ------------------------------------------------------------------ pilot-leg 面 */

/**
 * `pilot-leg`：禁选=账本已试 esig 按池重映射 + 本 leg 显式禁选（按 esig 键记，ref 位置性），
 * 注记/守卫账本归注入的账本；`prune` 做**全量 esig 重映射**（不是 stale-ref 清理）。
 */
function createPilotLegAccounting(
  pilot: PilotLedgerLike, memory: OutcomeMemoryLike | null, options: DecisionAccountingOptions,
): DecisionAccounting {
  const scope: MemoryScope = { currentKey: null };
  /** 本 leg 显式禁选：ref → 禁选时 esig 键（ref 重编号后由 `prune` 平移）。 */
  const overlay = new Map<string, string>();
  const limit = repeatLimitOf(options);

  return {
    forbiddenRefs(pool: ElemPool): Set<string> {
      const out = pilot.forbiddenRefs(pool);
      for (const [ref, key] of overlay) {
        const el = pool[ref];
        if (el !== undefined && guardKeyOf(el) === key) out.add(ref);
      }
      return out;
    },
    notesFor(pool: ElemPool): Record<string, string> | null {
      return pilot.notesFor(pool);
    },
    /** 本 leg 显式禁选：只记 esig 键（账本无 forbid 原因列；原因走 `recordLocal` 的 outcome 通道）。 */
    forbid(ref: string, el: Elem, _why: string): void {
      overlay.set(ref, guardKeyOf(el));
    },
    unforbid(ref: string): void {
      overlay.delete(ref);
    },
    /** 等价 `pilot-vote.carryForbidden`：按禁选时 esig 在新池全量重建 ref 视图，找不到即丢弃。 */
    prune(pool: ElemPool): void {
      const keys = new Set(overlay.values());
      overlay.clear();
      if (keys.size === 0) return;
      for (const [ref, el] of Object.entries(pool)) {
        if (keys.has(guardKeyOf(el))) overlay.set(ref, guardKeyOf(el));
      }
    },
    memoryKey(url: string, instruction: string): string {
      return memoryKeyOf(memory, scope, url, instruction);
    },
    recordMemory(key: string, sig: Sig, outcome: DecisionMemoryOutcome): void {
      recordMemoryTo(memory, key, sig, outcome);
    },
    recordLocal(el: Elem, desc: string, outcome: string): void {
      pilot.bump(el, desc, outcome);
    },
    ruleSkip(el: Elem): "changed-loop" | "unhittable" | null {
      if (pilot.changedLoop(el)) return "changed-loop";
      if (pilot.unhittable(el)) return "unhittable";
      return null;
    },
    /** 达上限的现场**由返回值交给调用方**（不另立私有 loopTrip；账本 `loopTrip` 同步写入以保交接证据）。 */
    guardStop(el: Elem, desc: string): { desc: string; tries: number } | null {
      const prior = pilot.tries(el);
      if (prior < limit) return null;
      pilot.loopTrip = { desc, tries: prior };
      return { desc, tries: prior };
    },
    entries(limitN: number): DecisionGuardEntry[] {
      const lim = clampEntryLimit(limitN);
      if (lim === 0) return [];
      const ledger = pilot.evidence().ledger ?? [];
      return ledger.slice(-lim).map((e) => ({ desc: e.desc, tries: e.tries, lastOutcome: e.last_outcome }));
    },
  };
}

/* ------------------------------------------------------------------ 工厂 */

/**
 * 按 `lifetime` 造账本：策略绑定在这里发生（调用点只持有句柄）。
 * 必填项缺失/非法选项 → `DecisionAccountingError`（结构化，绝不静默降级）。
 */
export function createDecisionAccounting(
  deps: DecisionAccountingDeps,
  lifetime: DecisionLifetime,
  options: DecisionAccountingOptions = {},
): DecisionAccounting {
  const detail = `lifetime=${JSON.stringify(lifetime)}`;
  switch (lifetime.kind) {
    case "attempt": {
      if (deps.run === undefined) {
        throw new DecisionAccountingError("missing_run_accounting", `attempt lifetime requires deps.run (${detail})`);
      }
      return createAttemptAccounting(deps.run, deps.memory ?? null, options);
    }
    case "pilot-leg": {
      if (deps.pilot === undefined || deps.pilot === null) {
        throw new DecisionAccountingError("missing_pilot_ledger", `pilot-leg lifetime requires deps.pilot (${detail})`);
      }
      return createPilotLegAccounting(deps.pilot, deps.memory ?? null, options);
    }
    default:
      throw new DecisionAccountingError(
        "unknown_lifetime",
        `unknown DecisionLifetime kind ${JSON.stringify((lifetime as { kind?: unknown }).kind)} (${detail})`,
      );
  }
}

/**
 * run 面组合根便捷构造：attempt lifetime（身份字段只用于诊断/证据；策略按 kind 选择，
 * 记忆作用域经 deps.memory + memoryKey 另行提供）。
 */
export function createRunDecisionAccounting(
  run: RunAccounting, memory: OutcomeMemoryLike | null, subgoalId: string,
): DecisionAccounting {
  return createDecisionAccounting({ run, memory }, { kind: "attempt", runId: "run", subgoalId, attempt: 1 });
}
