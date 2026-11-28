/**
 * 决策树（有限状态机）契约与 walker —— **引擎层：接口由引擎定义**。
 *
 * 分层（`docs/DECISION_ENGINE_TREE_DESIGN.md`）：
 *   - 引擎层（本模块）：状态类型闭集、逐 kind 结果闭集、转移表加载期校验、walker。
 *   - 应用层：声明状态与转移表并实现状态（`src/app/pilot-tree.ts` 是浏览器树；
 *     命令行树同形，第二个消费者出现时并列注册）。
 *   - 实例层：`app.mjs` 只挂参数，不参与树的结构。
 *
 * 三条不变量（违反即架构回归，不是风格问题）：
 *   ① **一次 walk = 一次动作尝试**：预算按**动作**计（`invoke` 落一次动作），不按状态计——
 *      状态再多也不通胀。调用方以 `shouldContinue` 兜住跨 walk 的预算边界。
 *   ② **转移是数据**：应用声明 `状态 × 结果 → 下一状态`；加载期校验**每个已声明结果都有出边**
 *      且终点存在。新增路由 = 改数据，不改 walker。
 *   ③ **终态只两种**：动作叶（`invoke`，经调用方 gate 包裹）或交接叶（`handoff`，落停因闭集）。
 *
 * 红线（**不可挂载**，状态拿不到）：完成裁决调用点、停因闭集、预算计账、危险闸门、值纪律。
 * 状态只产出**闭集结果**与黑板数据，永不产出动作文本（红线①：模型只投票不生成）。
 */

/** 状态类型闭集。新增 kind = 改引擎（须过架构评审），不是应用可扩的面。 */
export const TREE_STATE_KINDS = ["select-tool", "resolve-param", "invoke", "verify-step", "handoff"] as const;
export type TreeStateKind = (typeof TREE_STATE_KINDS)[number];

/**
 * 逐 kind 的结果闭集——**各 kind 互不相同**，这就是状态机的逐状态转移事件集，
 * 不是统一的「成功 | 失败」模板。状态实现只能返回本 kind 声明的结果之一。
 */
export const TREE_RESULTS: Record<TreeStateKind, readonly string[]> = {
  // 池内选点：四种不可继续的形态各自成事件（交接原因在黑板 stopCode 上，路由在边上）。
  "select-tool": ["picked", "below-floor", "abstain", "no-model", "ambiguous"],
  // 值解析：值只来自声明/观察，缺值不是失败而是交接事件。
  "resolve-param": ["bound", "needs-value"],
  // 动作：changed/no-change/failed 进验证；rejected/denied 是动作前拒绝（不耗步、不进验证）。
  invoke: ["changed", "no-change", "failed", "rejected", "denied"],
  // 验证：as-expected 收尾；retry 是纠正回环（不达预期退回重选）；inert 是连续无变化停。
  "verify-step": ["as-expected", "retry", "inert"],
  // 交接叶：**零结果**——它只以 `{ stop }` 出口（停因由调用方闭集裁决，不由树定义）。
  handoff: [],
};

/** 一次 walk 的正常收尾（动作尝试完成，控制权交回调用方循环）。 */
export const TREE_EXIT = "@exit";

export interface TreeState {
  readonly id: string;
  readonly kind: TreeStateKind;
}

/** 转移边：`from --result→ to`（to 可为状态 id 或 `TREE_EXIT`）。 */
export interface TreeEdge {
  readonly from: string;
  readonly result: string;
  readonly to: string;
}

export interface DecisionTree {
  readonly name: string;
  readonly entry: string;
  readonly states: readonly TreeState[];
  readonly edges: readonly TreeEdge[];
}

/** 状态求值出口：闭集结果（走边）、直接停（落调用方停因闭集）、或挂起（交回调用方等人）。 */
export type StateOutcome =
  | { readonly result: string }
  | { readonly stop: string }
  | { readonly suspend: string };

export type TreeHandler<B extends object> = (board: B) => Promise<StateOutcome>;

/** walker 出口：收尾 / 停（调用方按停因闭集处理）/ 挂起（非停因，如等 Agent 点名）。 */
export type TreeOutcome =
  | { readonly kind: "exit" }
  | { readonly kind: "stop"; readonly code: string }
  | { readonly kind: "suspend"; readonly reason: string };

/**
 * 加载期校验（挂载 = 校验后装配，无运行时调度器）。
 * 返回问题清单，空数组 = 通过。四类问题都是**结构性**的：状态重复 / kind 越界 /
 * 结果无出边 / 边指向不存在的东西。
 */
export function validateTree(tree: DecisionTree): string[] {
  const problems: string[] = [];
  const byId = new Map<string, TreeState>();
  for (const s of tree.states) {
    if (byId.has(s.id)) problems.push(`状态 id 重复：${s.id}`);
    byId.set(s.id, s);
    if (!(TREE_STATE_KINDS as readonly string[]).includes(s.kind)) {
      problems.push(`状态 ${s.id} 的 kind 不在闭集：${String(s.kind)}`);
    }
  }
  if (!byId.has(tree.entry)) problems.push(`入口状态不存在：${tree.entry}`);
  const covered = new Map<string, Set<string>>();
  for (const e of tree.edges) {
    const from = byId.get(e.from);
    if (from === undefined) { problems.push(`边起点不存在：${e.from}`); continue; }
    const declared = TREE_RESULTS[from.kind] ?? [];
    if (!declared.includes(e.result)) {
      problems.push(`边 ${e.from} --${e.result} 不在 kind ${from.kind} 的结果闭集`);
    }
    if (e.to !== TREE_EXIT && !byId.has(e.to)) problems.push(`边终点不存在：${e.from} --${e.result} → ${e.to}`);
    const set = covered.get(e.from) ?? new Set<string>();
    set.add(e.result);
    covered.set(e.from, set);
  }
  // 每个已声明结果必须有出边——否则运行到那里就是未定义路由。
  for (const s of tree.states) {
    const got = covered.get(s.id) ?? new Set<string>();
    for (const r of TREE_RESULTS[s.kind] ?? []) {
      if (!got.has(r)) problems.push(`状态 ${s.id} 的结果 ${r} 没有出边`);
    }
  }
  return problems;
}

/** 编译转移表（校验通过后一次性建索引；walker 热路径不做字符串扫描）。 */
function compile(tree: DecisionTree): Map<string, Map<string, string>> {
  const edges = new Map<string, Map<string, string>>();
  for (const e of tree.edges) {
    let m = edges.get(e.from);
    if (m === undefined) { m = new Map(); edges.set(e.from, m); }
    m.set(e.result, e.to);
  }
  return edges;
}

/**
 * walker：逐状态求值 → 按结果走边。**决策面的循环**——它不做浏览器动作，
 * 动作只经应用层的 `invoke` 状态调既有唯一执行器（不存在第二个执行循环）。
 *
 * `opts.shouldContinue`：每状态求值前询问一次，返回 false 即收尾（把预算边界钉在调用方，
 * 让"一次 walk 一次动作"不因树变深而通胀）。`opts.maxStates` 是防未收敛的硬上限。
 */
export async function walkTree<B extends object>(
  tree: DecisionTree,
  handlers: Record<string, TreeHandler<B>>,
  board: B,
  opts: { shouldContinue?: () => boolean; maxStates?: number } = {},
): Promise<TreeOutcome> {
  const problems = validateTree(tree);
  if (problems.length > 0) throw new Error(`决策树非法（${tree.name}）：${problems.join("；")}`);
  const edges = compile(tree);
  const cap = opts.maxStates ?? 32;
  let id = tree.entry;
  for (let n = 0; n < cap; n += 1) {
    if (opts.shouldContinue !== undefined && !opts.shouldContinue()) return { kind: "exit" };
    const h = handlers[id];
    if (h === undefined) throw new Error(`状态 ${id} 没有实现（${tree.name}）`);
    const out = await h(board);
    if ("stop" in out) return { kind: "stop", code: out.stop };
    if ("suspend" in out) return { kind: "suspend", reason: out.suspend };
    const next = edges.get(id)?.get(out.result);
    if (next === undefined) throw new Error(`状态 ${id} 的结果 ${out.result} 没有出边（${tree.name}）`);
    if (next === TREE_EXIT) return { kind: "exit" };
    id = next;
  }
  throw new Error(`决策树超过 ${cap} 个状态未收敛（${tree.name}）`);
}
