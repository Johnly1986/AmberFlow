/**
 * verify-decision-accounting —— **非门禁、纯内存、确定性**的 `DecisionAccounting` 工厂断言 lane。
 *
 * 定位：S0b 是「账面组合」而不是执行路径改造——本 lane 不启浏览器、不调模型、不写文件，
 * 只把工厂对外的 11 个成员逐条钉在既有语义上，供后续 S1/S2 切换 run/pilot 调用点时做
 * 等价回归的**先行证据**。真正的行为等价仍由 `verify:runtime:offline`（run 面）与
 * §3.2 pilot 矩阵承担；本 lane 只证「账本语义没有漂移」。
 *
 * 断言分组（与 `src/engine/decision-accounting.ts` 头部的策略表一一对应）：
 *   ① attempt 的 prune = 只删同 ref 签名失配（不迁移）；pilot-leg 的 prune = 按 esig 全量重映射；
 *   ② attempt 的 notes 只在 rank 档出定文本注记；pilot-leg 的 notes = 守卫账本全部条目；
 *   ③ effective 清除同键旧 inert（`recordMemory` 与 `decisionSigOf` 同一条编码）；
 *   ④ desc/tries/lastOutcome 保真（首见 desc 固定、末次结果更新、tries 累计）；
 *   ⑤ forbid 原因保留（run.forbidWhy）与 unforbid/prune 清理面；
 *   ⑥ guardStop 阈值（缺省 3：2 次不过、第 3 次命中；选项可覆盖；缺省值与 pilot 契约数值对拍）；
 *   ⑦ entries 限幅 ≤ 8（单源常量，limit=20 亦然）且只做三字段投影；**不含守停现场**
 *     （现场只经 `guardStop` 返回值，pilot 账本 `loopTrip` 归交接证据面）；
 *   ⑧ Sig 编码唯一：memory sig 走 JSON、pilot 内部键走 NUL join，不得混用；
 *   ⑩ pilot notesFor 上限 = 8 条 / 24 字（以既有 PilotLedger 实现为准，≥9 条时截断）；
 *   ⑨ 缺依赖/非法选项 = 结构化错误，绝不静默降级。
 *
 * 用法：`node --experimental-strip-types tools/verify-decision-accounting.ts`
 * 退出码：0 全过 / 1 任一断言红。
 */
import assert from "node:assert/strict";
import { esig, type Elem, type ElemPool } from "../src/engine/extraction.ts";
import { createRunAccounting } from "../src/engine/run-context.ts";
import { createOutcomeMemory } from "../src/model/outcome-memory.ts";
import { PilotLedger } from "../src/app/pilot-ledger.ts";
import { PILOT_REPEAT_LIMIT } from "../src/app/pilot-contract.ts";
import type { DecisionLifetime } from "../src/engine/decision-ask-contract.ts";
import {
  createDecisionAccounting,
  decisionSigOf,
  DECISION_ACCOUNTING_ENTRIES_MAX,
  DECISION_ACCOUNTING_ERROR_CODES,
  DECISION_GUARD_REPEAT_LIMIT_DEFAULT,
  DECISION_MEMORY_INERT_NOTE,
  DecisionAccountingError,
  type DecisionAccountingErrorCode,
} from "../src/engine/decision-accounting.ts";

const ATTEMPT: DecisionLifetime = { kind: "attempt", runId: "run-1", subgoalId: "sg-1", attempt: 1 };
const PILOT_LEG: DecisionLifetime = { kind: "pilot-leg", runId: "run-1", leg: 1 };
const URL = "https://example.test/step";
const INSTRUCTION = "Open the detail page";

let checks = 0;
function check(cond: unknown, msg: string): void {
  checks += 1;
  assert.ok(cond, msg);
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  checks += 1;
  assert.deepEqual(actual, expected, msg);
}
function throwsWith(code: DecisionAccountingErrorCode, fn: () => void, msg: string): void {
  checks += 1;
  assert.throws(fn, (e: unknown) => e instanceof DecisionAccountingError && e.code === code, msg);
}

/** 池行最小构造（`Elem` 其余字段缺省 = 既有抽取面的空值形态）。 */
function el(tag: string, label: string, dataTest?: string): Elem {
  return dataTest === undefined
    ? { tag, label }
    : { tag, label, data_test: dataTest };
}
function poolOf(rows: Array<[string, Elem]>): ElemPool {
  return Object.fromEntries(rows);
}
function sortedSet(set: Set<string>): string[] {
  return [...set].sort();
}

/* ---------------------------------------------------------------- ① prune 两模式 */

function scenarioAttemptPrune(): void {
  const run = createRunAccounting({ maxSteps: 5 });
  const acct = createDecisionAccounting({ run }, ATTEMPT);
  const a = el("button", "Go", "go");
  const b = el("button", "Cancel", "cancel");
  const pool = poolOf([["e0", a], ["e1", b]]);

  acct.forbid("e0", a, "inert");
  eq(run.forbidden["e0"], esig(a), "attempt forbid 记元素签名（run 面唯一出口）");
  eq(run.forbidWhy["e0"], "inert", "attempt forbid 原因保留（诊断面读它）");
  eq(sortedSet(acct.forbiddenRefs(pool)), ["e0"], "attempt forbiddenRefs = run 显式 forbid 键集（不按池回筛）");

  acct.forbiddenRefs(pool).delete("e0");
  check(run.forbidden["e0"] !== undefined, "forbiddenRefs 返回副本：调用方改变量不反写账本");

  run.reAdmitted.add("e0");
  acct.prune(pool);
  check(run.forbidden["e0"] !== undefined, "同 ref 同签名：prune 不清禁选");
  check(run.forbidWhy["e0"] === "inert", "同 ref 同签名：prune 不清原因");

  acct.prune(poolOf([["e0", b]]));
  check(run.forbidden["e0"] === undefined, "同 ref 签名失配：prune 清禁选（stale ref 语义）");
  check(run.forbidWhy["e0"] === undefined, "prune 清 forbid 原因");
  check(!run.reAdmitted.has("e0"), "prune 清 reAdmitted（与 pruneForbids 同语义）");

  acct.forbid("e1", b, "anti-repeat");
  acct.prune(poolOf([["e0", a]]));
  check(run.forbidden["e1"] === undefined, "ref 从池里消失：prune 清禁选");

  acct.forbid("e0", a, "inert");
  acct.prune(poolOf([["e9", a]]));
  check(run.forbidden["e0"] === undefined, "attempt prune 只清 stale ref，不把禁选迁移到新 ref");
  eq(sortedSet(acct.forbiddenRefs(poolOf([["e9", a]]))), [], "迁移后的池无禁选残留");
}

function scenarioPilotPrune(): void {
  const ledger = new PilotLedger();
  const acct = createDecisionAccounting({ pilot: ledger }, PILOT_LEG);
  const a = el("link", "Docs", "docs");
  const b = el("button", "Go", "go");

  acct.forbid("e0", a, "inert");
  eq(sortedSet(acct.forbiddenRefs(poolOf([["e0", a], ["e1", b]]))), ["e0"], "pilot 本 leg 显式禁选进 forbiddenRefs");

  const renumbered = poolOf([["e7", b], ["e8", a]]);
  acct.prune(renumbered);
  eq(sortedSet(acct.forbiddenRefs(renumbered)), ["e8"], "pilot prune 按 esig 全量重映射到新 ref（不是删 stale ref）");
  check(!acct.forbiddenRefs(renumbered).has("e0"), "pilot prune 后旧 ref 不残留");

  acct.prune(poolOf([["e1", b]]));
  eq(sortedSet(acct.forbiddenRefs(poolOf([["e1", b]]))), [], "元素消失：pilot 全量重映射如实丢弃");

  const ledger2 = new PilotLedger();
  const acct2 = createDecisionAccounting({ pilot: ledger2 }, PILOT_LEG);
  acct2.recordLocal(a, "click Docs", "no_change");
  eq(sortedSet(acct2.forbiddenRefs(poolOf([["e9", a], ["e3", b]]))), ["e9"], "账本已试 esig 按池重映射（PilotLedger.forbiddenRefs 同口径）");

  acct2.forbid("e3", b, "inert");
  acct2.unforbid("e3");
  eq(sortedSet(acct2.forbiddenRefs(poolOf([["e9", a], ["e3", b]]))), ["e9"], "unforbid 只清本 leg 显式禁选（账本已试记录不可撤）");
}

/* ---------------------------------------------------------------- ② notes 两模式 */

function scenarioAttemptNotes(): void {
  const memory = createOutcomeMemory();
  const a = el("button", "Go", "go");
  const b = el("link", "Cancel");
  const pool = poolOf([["e0", a], ["e1", b]]);
  const run = createRunAccounting({ maxSteps: 5 });
  const rank = createDecisionAccounting({ run, memory }, ATTEMPT, { outcomeMemoryMode: "rank" });

  check(rank.notesFor(pool) === null, "rank 档：未取记忆键 = 无注记（键单源前置）");
  eq(rank.memoryKey(URL, INSTRUCTION), memory.key(URL, INSTRUCTION), "memoryKey 键编码归 memory 实现（不复制哈希）");
  memory.record(rank.memoryKey(URL, INSTRUCTION), decisionSigOf(a), "inert");
  eq(rank.notesFor(pool), { e0: DECISION_MEMORY_INERT_NOTE }, "rank 档：inert 候选给定文本注记");
  eq(rank.notesFor(poolOf([["e1", b]])), null, "rank 档：无 inert 匹配 = null（题面不变）");

  rank.forbid("e0", a, "inert");
  check(rank.notesFor(pool) === null, "rank 档：已禁选候选不进注记（与执行期 filter 同序）");

  const forbidRun = createRunAccounting({ maxSteps: 5 });
  const forbidding = createDecisionAccounting({ run: forbidRun, memory }, ATTEMPT);
  forbidding.memoryKey(URL, INSTRUCTION);
  check(forbidding.notesFor(pool) === null, "forbid 档（缺省）：不新增 memory 注记");

  const bare = createDecisionAccounting({ run: forbidRun }, ATTEMPT);
  throwsWith("memory_not_configured", () => bare.memoryKey(URL, INSTRUCTION), "无 memory：memoryKey 抛结构化错误（不发明键）");
  bare.recordMemory("any-key", esig(a), "inert");
  check(true, "无 memory：recordMemory 如实空转（与执行期 outcomeMemory?.record 同语义）");

  const providerKey = "provider-key";
  const viaProvider = createDecisionAccounting({ run: forbidRun, memory }, ATTEMPT, { memoryKey: () => providerKey });
  eq(viaProvider.notesFor(pool), null, "forbid 档：即使给了键提供者也不出注记");
  const rankProvider = createDecisionAccounting({ run: forbidRun, memory }, ATTEMPT, { outcomeMemoryMode: "rank", memoryKey: () => providerKey });
  memory.record(providerKey, decisionSigOf(a), "inert");
  eq(rankProvider.notesFor(pool), { e0: DECISION_MEMORY_INERT_NOTE }, "rank 档显式键提供者可覆盖最近一次取键");
}

function scenarioPilotNotes(): void {
  const ledger = new PilotLedger();
  const acct = createDecisionAccounting({ pilot: ledger }, PILOT_LEG);
  const a = el("button", "Go", "go");
  const b = el("button", "Next", "next");
  const pool = poolOf([["e0", a], ["e1", b]]);

  check(acct.notesFor(pool) === null, "空守卫账本：无注记（题面逐字节不变）");
  acct.recordLocal(a, "click Go", "changed");
  acct.recordLocal(a, "click Go", "no_change");
  eq(acct.notesFor(pool), { e0: "已试 2 次 · no_change" }, "pilot 注记 = 已试 N 次 · outcome（全部条目）");
}

/* ---------------------------------------------------------------- ③ effective 清 inert */

function scenarioEffectiveClearsInert(): void {
  const memory = createOutcomeMemory();
  const a = el("button", "Go", "go");
  const run = createRunAccounting({ maxSteps: 5 });
  const acct = createDecisionAccounting({ run, memory }, ATTEMPT, { outcomeMemoryMode: "rank" });
  const key = acct.memoryKey(URL, INSTRUCTION);

  memory.record(key, decisionSigOf(a), "inert");
  eq(memory.inertIn(key).size, 1, "inert 记忆入账（执行期 JSON 编码）");
  const before = acct.notesFor(poolOf([["e0", a]]));
  eq(before, { e0: DECISION_MEMORY_INERT_NOTE }, "rank 注记在清除前可见");

  acct.recordMemory(key, esig(a), "effective");
  eq(memory.inertIn(key).size, 0, "effective 清除同键旧 inert（recordMemory 与 decisionSigOf 同编码）");
  eq(memory.stats().cleared, 1, "memory cleared 计数如实");
  check(acct.notesFor(poolOf([["e0", a]])) === null, "清除后 rank 注记消失");
}

/* ---------------------------------------------------------------- ④ 保真 + ⑥ 阈值 + ⑦ 限幅 */

function scenarioGuardFidelity(): void {
  const run = createRunAccounting({ maxSteps: 5 });
  const acct = createDecisionAccounting({ run }, ATTEMPT);
  const a = el("button", "Go", "go");

  eq(acct.guardStop(a, "click Go"), null, "未记录：不守停");
  acct.recordLocal(a, "click Go", "no_change");
  acct.recordLocal(a, "click Go", "no_change");
  eq(acct.guardStop(a, "click Go"), null, "2 次未达缺省阈值 3：不守停");
  eq(acct.entries(8), [{ desc: "click Go", tries: 2, lastOutcome: "no_change" }], "entries 投影 desc/tries/lastOutcome 保真");

  acct.recordLocal(a, "click Go again", "changed");
  eq(acct.guardStop(a, "click Go"), { desc: "click Go", tries: 3 }, "第 3 次命中：返回现场 {desc,tries}");
  eq(acct.entries(8)[0], { desc: "click Go", tries: 3, lastOutcome: "changed" }, "首见 desc 固定，末次 lastOutcome 更新");

  eq(acct.ruleSkip(a), "changed-loop", "attempt：lastOutcome=changed → changed-loop");
  const b = el("button", "Bad", "bad");
  acct.recordLocal(b, "click Bad", "unhittable:covered");
  eq(acct.ruleSkip(b), "unhittable", "attempt：unhittable* → unhittable");
  acct.recordLocal(b, "click Bad", "failed:timeout");
  eq(acct.ruleSkip(b), null, "attempt：普通失败不是让位判据");
  eq(acct.ruleSkip(el("button", "Never")), null, "attempt：无账本记录 = 不让位");

  const run2 = createRunAccounting({ maxSteps: 5 });
  const tuned = createDecisionAccounting({ run: run2 }, ATTEMPT, { repeatLimit: 2 });
  const c = el("input", "Name", "name");
  tuned.recordLocal(c, "fill Name", "no_change");
  eq(tuned.guardStop(c, "fill Name"), null, "自定义阈值 2：1 次不守停");
  tuned.recordLocal(c, "fill Name", "no_change");
  eq(tuned.guardStop(c, "fill Name"), { desc: "fill Name", tries: 2 }, "自定义阈值 2：第 2 次命中");
}

function scenarioEntriesClamp(): void {
  const run = createRunAccounting({ maxSteps: 5 });
  const acct = createDecisionAccounting({ run }, ATTEMPT);
  const seen: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const e = el("button", `Item ${String(i)}`, `item-${String(i)}`);
    acct.recordLocal(e, `click Item ${String(i)}`, "no_change");
    seen.push(`click Item ${String(i)}`);
  }
  const clamps = acct.entries(100);
  eq(clamps.length, DECISION_ACCOUNTING_ENTRIES_MAX, "entries(100) 限幅到 8");
  eq(clamps.map((e) => e.desc), seen.slice(-8), "限幅保留最近条目（首见序尾部）");
  eq(Object.keys(clamps[0] ?? {}), ["desc", "tries", "lastOutcome"], "entries 只回投影（三字段）");
  eq(acct.entries(3).map((e) => e.desc), seen.slice(-3), "entries(3) 取最近 3 条");
  eq(acct.entries(0), [], "entries(0) = 空");
  eq(acct.entries(Number.NaN), [], "entries(NaN) = 空（非有限不猜）");
}

/* ---------------------------------------------------------------- ⑤ unforbid */

function scenarioAttemptUnforbid(): void {
  const run = createRunAccounting({ maxSteps: 5 });
  const acct = createDecisionAccounting({ run }, ATTEMPT);
  const a = el("button", "Go", "go");
  acct.forbid("e0", a, "inert");
  run.blockedRetry["e0"] = [1, 2];
  acct.unforbid("e0");
  check(run.forbidden["e0"] === undefined, "attempt unforbid 清禁选");
  check(run.forbidWhy["e0"] === undefined, "attempt unforbid 清原因");
  check(run.blockedRetry["e0"] === undefined, "attempt unforbid 清阻塞重试（与 run.unforbid 同语义）");
}

/* ---------------------------------------------------------------- pilot 守卫 */

function scenarioPilotGuard(): void {
  const ledger = new PilotLedger();
  const acct = createDecisionAccounting({ pilot: ledger }, PILOT_LEG);
  const a = el("button", "Go", "go");
  const c = el("button", "Covered", "covered");

  acct.recordLocal(a, "click Go", "changed");
  acct.recordLocal(a, "click Go", "no_change");
  eq(acct.guardStop(a, "click Go"), null, "pilot 2 次未达 PILOT_REPEAT_LIMIT：不守停");
  acct.recordLocal(a, "click Go", "changed");
  eq(acct.guardStop(a, "click Go"), { desc: "click Go", tries: 3 }, "pilot 第 3 次命中（与 pilot 契约同口径）");
  eq(ledger.loopTrip, { desc: "click Go", tries: 3 }, "命中现场同步进账本 loopTrip（交接证据依赖）");
  eq(acct.ruleSkip(a), "changed-loop", "pilot：changedLoop → changed-loop");

  acct.recordLocal(c, "click Covered", "unhittable:covered");
  eq(acct.ruleSkip(c), "unhittable", "pilot：unhittable → unhittable");
  eq(acct.ruleSkip(el("button", "Fresh")), null, "pilot：无账本记录 = 不让位");

  for (let i = 0; i < 10; i += 1) {
    acct.recordLocal(el("link", `Row ${String(i)}`, `row-${String(i)}`), `click Row ${String(i)}`, "no_change");
  }
  eq(acct.entries(100).length, DECISION_ACCOUNTING_ENTRIES_MAX, "pilot entries(100) 限幅到 8（交接证据有界）");
  eq(acct.entries(2).length, 2, "pilot entries(2) 取最近 2 条");
  eq(acct.entries(2)[1], { desc: "click Row 9", tries: 1, lastOutcome: "no_change" }, "pilot entries 投影 last_outcome → lastOutcome");
}

/* ---------------------------------------------------------------- ⑧ 编码唯一 */

function scenarioSigEncoding(): void {
  const a = el("button", "Go", "go");
  eq(decisionSigOf(a), JSON.stringify(esig(a)), "decisionSigOf = JSON.stringify(esig(el))（memory sig 唯一出口）");
  eq(decisionSigOf(a), JSON.stringify([a.tag, a.label, a.data_test ?? ""]), "元组序 tag|label|data_test（esig 单源）");
  const guardKey = esig(a).join("\u0000");
  check(decisionSigOf(a) !== guardKey, "memory sig（JSON）≠ pilot 内部键（NUL join）：两种编码不得混用");
  check(decisionSigOf(a).startsWith("[") && guardKey.includes("\u0000"), "两种编码可形态区分");

  const noDataTest = el("button", "Go");
  check(decisionSigOf(a) !== decisionSigOf(noDataTest), "data_test 不同的元素 = 不同签名");
  eq(decisionSigOf(el("a", "b", "")), JSON.stringify(["a", "b", ""]), "缺省 data_test 编码为空串");
  eq(decisionSigOf(a), decisionSigOf(el("button", "Go", "go")), "同签名不同对象编码稳定（确定性）");

  eq(DECISION_GUARD_REPEAT_LIMIT_DEFAULT, PILOT_REPEAT_LIMIT, "guard 缺省阈值与 app pilot 契约同值（engine 不 import，工具层对拍）");
  eq(DECISION_ACCOUNTING_ENTRIES_MAX, 8, "entries 上限 8 与交接块 ≤8 条同口径");
  eq(DECISION_MEMORY_INERT_NOTE, "[tried before, page did not change]", "rank 注记定文本与执行期逐字一致");
}

/* ---------------------------------------------------------------- ⑨ 结构化错误 */

function scenarioConfigErrors(): void {
  throwsWith("missing_run_accounting", () => createDecisionAccounting({}, ATTEMPT), "attempt 缺 run：结构化错误，不静默降级");
  throwsWith("missing_pilot_ledger", () => createDecisionAccounting({}, PILOT_LEG), "pilot-leg 缺 pilot：结构化错误");
  throwsWith("missing_pilot_ledger", () => createDecisionAccounting({ pilot: null }, PILOT_LEG), "pilot-leg pilot=null：同样结构化拒绝");
  throwsWith(
    "unknown_lifetime",
    () => createDecisionAccounting({}, { kind: "bogus", runId: "r" } as unknown as DecisionLifetime),
    "未知 lifetime kind：结构化拒绝",
  );

  const run = createRunAccounting({ maxSteps: 1 });
  throwsWith("invalid_repeat_limit", () => createDecisionAccounting({ run }, ATTEMPT, { repeatLimit: 0 }), "repeatLimit=0 非法");
  throwsWith("invalid_repeat_limit", () => createDecisionAccounting({ run }, ATTEMPT, { repeatLimit: 1.5 }), "repeatLimit 非整数非法");
  throwsWith(
    "invalid_outcome_memory_mode",
    () => createDecisionAccounting({ run }, ATTEMPT, { outcomeMemoryMode: "bogus" as "forbid" }),
    "outcomeMemoryMode 闭集外非法",
  );
  check(DECISION_ACCOUNTING_ERROR_CODES.length === 6, "错误码闭集为 6 个");
  check(DECISION_ACCOUNTING_ERROR_CODES.includes("missing_run_accounting"), "错误码可枚举（诊断面可读）");
}


/* ---------------------------------------------------------------- ⑩ 上限与守停现场 */

function scenarioEvidenceLimits(): void {
  const ledger = new PilotLedger();
  const acct = createDecisionAccounting({ pilot: ledger }, PILOT_LEG);
  const rows: Array<[string, Elem]> = [];
  for (let i = 0; i < 10; i += 1) {
    rows.push([`e${String(i)}`, el("link", `Row ${String(i)}`, `row-${String(i)}`)]);
  }
  const pool = poolOf(rows);
  for (const [, row] of rows) acct.recordLocal(row, `click ${row.label}`, "no_change");

  const notes = acct.notesFor(pool);
  check(notes !== null, "10 条已试条目：pilot notesFor 非空");
  if (notes !== null) {
    eq(Object.keys(notes).length, DECISION_ACCOUNTING_ENTRIES_MAX, "pilot notesFor 上限 = 8 条（≥9 条时截断；以实现为准）");
    check(Object.values(notes).every((v) => v.length <= 24), "pilot notesFor 每条 ≤24 字");
    check(notes.e8 === undefined, "第 9 条起不再注记（上限截断）");
    eq(notes.e0, "已试 1 次 · no_change", "截断不影响首条注记文本");
  }

  eq(acct.entries(20).length, DECISION_ACCOUNTING_ENTRIES_MAX, "entries(20) 仍限幅到 8（上限 = 单源常量）");
  eq(acct.entries(3).length, 3, "entries(3) 正常取 3 条");

  const dead = rows[0]![1];
  acct.recordLocal(dead, "click dead", "no_change");
  acct.recordLocal(dead, "click dead", "no_change");
  eq(acct.guardStop(dead, "click dead"), { desc: "click dead", tries: 3 }, "guardStop 命中：现场由返回值交给调用方");
  const projections = acct.entries(20);
  check(
    projections.every((e) => Object.keys(e).length === 3
      && Object.keys(e).every((k) => k === "desc" || k === "tries" || k === "lastOutcome")),
    "entries 只回三字段投影",
  );
  check(!JSON.stringify(projections).includes("loop_stop"), "entries 不含守停现场键 loop_stop");
  check(!JSON.stringify(projections).includes("loopTrip"), "entries 不含 loopTrip 现场对象");
  eq(ledger.loopTrip, { desc: "click dead", tries: 3 }, "守停现场留在账本 loopTrip（交接证据面读）");

  eq(DECISION_GUARD_REPEAT_LIMIT_DEFAULT, 3, "guard 缺省阈值字面 = 3");
}

/* ---------------------------------------------------------------- main */

const SCENARIOS: Array<[string, () => void]> = [
  ["attempt prune（只清 stale ref）", scenarioAttemptPrune],
  ["pilot prune（按 esig 全量重映射）", scenarioPilotPrune],
  ["attempt notes（rank/forbid 两档）", scenarioAttemptNotes],
  ["pilot notes（守卫账本全部条目）", scenarioPilotNotes],
  ["effective 清同键旧 inert", scenarioEffectiveClearsInert],
  ["守卫保真与阈值（2 不过/第 3 命中）", scenarioGuardFidelity],
  ["entries 限幅 ≤8", scenarioEntriesClamp],
  ["attempt unforbid 清理面", scenarioAttemptUnforbid],
  ["pilot 守卫（ruleSkip/loopTrip/entries）", scenarioPilotGuard],
  ["pilot notes/entries 上限与守停现场边界", scenarioEvidenceLimits],
  ["Sig 编码唯一（JSON vs NUL）", scenarioSigEncoding],
  ["缺依赖/非法选项 = 结构化错误", scenarioConfigErrors],
];

function main(): number {
  const failures: string[] = [];
  for (const [name, run] of SCENARIOS) {
    try {
      run();
      console.log(`verify-decision-accounting PASS ${name}`);
    } catch (e) {
      failures.push(name);
      console.error(`verify-decision-accounting FAIL ${name}: ${(e as Error).message}`);
    }
  }
  if (failures.length > 0) {
    console.error(`verify-decision-accounting: ${failures.length}/${String(SCENARIOS.length)} 场景未过（${failures.join("、")}）`);
    return 1;
  }
  console.log(`verify-decision-accounting: ${SCENARIOS.length}/${SCENARIOS.length} 场景全过（${checks} 条断言，纯内存/零浏览器/零模型）`);
  return 0;
}

process.exit(main());
