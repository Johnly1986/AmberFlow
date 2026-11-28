/**
 * 浏览器应用的决策树（**应用层：状态 + 转移表**）——引擎只定义接口，结构在这里声明。
 *
 * 分层出处 `docs/DECISION_ENGINE_TREE_DESIGN.md`；契约与 walker 在
 * `src/engine/decision-tree.ts`（状态类型闭集、逐 kind 结果闭集、加载期校验）。
 *
 * 这棵树把驾驶面的行为逻辑**作为数据**表达：一次驾驶尝试 = select → resolve → invoke → verify，
 * 四条不可继续的选点形态各自成事件并汇入交接叶，验证不达预期有纠正回环。
 * 状态实现薄调该类型的既有能力（`PilotRuntime` 的抽池/规则/投票/执行/验证），
 * 不在本文件里重写任何执行链——树是路由，不是第二执行器。
 *
 * 引擎不变量在本树上的落点：
 *   ① 一次 walk 一次动作尝试：只有 `invoke` 落动作（预算计一次）；`rejected`/`denied`
 *      是动作前拒绝，直接收尾不耗步。
 *   ② 路由是数据：改路由 = 改下面的 edges；新增可放置状态（如重述题面）= 加状态 + 改边。
 *   ③ 终态两种：动作叶收尾（`@exit`）或交接叶（`handoff`，停因由调用方闭集裁决）。
 */
import { TREE_EXIT, validateTree, type DecisionTree } from "../engine/decision-tree.ts";
import type { AnyPage } from "../engine/executor.ts";
import type { Elem, ElemPool } from "../engine/elem-model.ts";
import type { ValueNeed } from "./pilot-value-need.ts";
import { PilotLedger } from "./pilot-ledger.ts";
import { affordanceRule, navRule } from "../engine/rules.ts";

/** 池内票面事实（低置信 `weak_picks` 的取数口；不参与驾驶问句/裁决）。 */
export interface PickEvidence {
  ref: string;
  conf: number;
  shape: string;
  pool_size: number;
  via?: "ask" | "reobserve";
}

/** 一次动作的步记录（驾驶轨迹/交接证据的单元）。 */
export interface DrivingStep {
  op: "click" | "check" | "fill" | "select";
  target: string;
  ref: string | null;
  how: string | null;
  ok: boolean;
  changed: boolean;
  /** 票面事实（低置信 `weak_picks` 的取数口；不参与驾驶问句/裁决）。 */
  step: number; picked_by?: "rule" | "model"; conf?: number;
}

/**
 * 浏览器树的**黑板**：状态间传递的可变数据（引擎 walker 只透传，不解释）。
 * 三段各自填自己那格——select 填 pick，resolve 填 action，invoke/verify 填 step/urlAfter，
 * 任何状态要交接就把停因写进 stopCode 再走 handoff 叶。
 */
export interface DriveBoard {
  readonly page: AnyPage;
  readonly urlNow: string;
  readonly goal: string;
  pick?: { ref: string; pool: ElemPool; by: "rule" | "model"; evidence: PickEvidence | null; poolSize: number };
  action?: {
    el: Elem; op: "click" | "check" | "fill" | "select";
    bind: { value: unknown } | null; need: ValueNeed | null;
    drift: { from: string; to: string } | null;
    targetFull: string; target: string; urlBefore: string;
  };
  step?: DrivingStep;
  urlAfter?: string;
  stopCode?: string;
}

/**
 * 空标签候选的**身份兜底**（浏览器树的注入段：只作用于"模型看到的那一行"，不碰执行面）。
 *
 * 池里有 `role` / `name` / `input_type` 三个身份字段，而渲染只给 label——标签为空时模型看到
 * 的是 `input ""`，等于让它在无法区分的行里投票（走查实测：池 32 候选、模型只看到 5 行、
 * 3 次决策 0 次有效推进）。这里按固定序补最多三个身份 token。
 *
 * **只对空标签生效**：有标签的行逐字节不变（有 aria 名的行仍以 aria 名为准，见 `criteriaView`
 * 的 aligned 分支——它优先用 aria name，本函数填的 label 只在无 aria 名时兜底）。
 */
export function identityLabelOf(e: Elem): string | null {
  const parts: string[] = [];
  if (e.role) parts.push(e.role);
  if (e.name) parts.push(`[name=${e.name}]`);
  if (e.input_type) parts.push(`[type=${e.input_type}]`);
  return parts.length === 0 ? null : parts.join(" ");
}

/**
 * 提问视图：仅把**空标签**行的 label 换成身份串（浅拷贝，ref 与顺序不动——回票与执行面
 * 用同一份 ref 空间）。无空标签可补时**原样返回同一对象**（题面逐字节不变，不制造新分配）。
 */
export function askViewOf(pool: ElemPool): ElemPool {
  let changed = false;
  const out: ElemPool = {};
  for (const [ref, e] of Object.entries(pool)) {
    const id = e.label === "" ? identityLabelOf(e) : null;
    if (id === null) { out[ref] = e; continue; }
    out[ref] = { ...e, label: id };
    changed = true;
  }
  return changed ? out : pool;
}

/**
 * 规则档：导航规则 → affordance 规则（与 run 的 hybrid picking 同一序）。只吃发起方的原始
 * goal——步史摘要若进匹配面，"做过什么"会被当成"要做什么"反复复读。exclude 排两类复读：
 * 乒乓形态（`changedLoop`）与**已证明无变化**（`inertNoChange`）。命中即确定性执行、零模型票。
 */
export function ruleRefOf(goal: string, elems: ElemPool, ledger: PilotLedger): string | null {
  const navRef = navRule(goal, elems);
  const ruleRef = navRef !== null ? navRef : affordanceRule(goal, elems, null, {});
  const ruleEl = ruleRef !== null ? elems[ruleRef] : undefined;
  const skip = ruleEl !== undefined
    && (ledger.changedLoop(ruleEl) || ledger.unhittable(ruleEl) || ledger.inertNoChange(ruleEl)
      || PilotLedger.aggregateContainer(ruleEl));
  return ruleRef !== null && elems[ruleRef] !== undefined && !skip ? ruleRef : null;
}

/**
 * 状态 id 闭集——**与 `BROWSER_TREE.states` 必须一致**（下面模块求值时断言）。
 * 它的真正用途是给实现绑定加类型约束：`Record<BrowserStateId, TreeHandler>` 下
 * 少一个状态的实现就是编译错，不必等到运行时才炸。
 */
export const BROWSER_STATE_IDS = ["select", "resolve", "invoke", "verify", "handoff"] as const;
export type BrowserStateId = (typeof BROWSER_STATE_IDS)[number];

export const BROWSER_TREE: DecisionTree = {
  name: "browser",
  entry: "select",
  states: [
    // 选择工具：池内闭集选点（resume 点名 / 规则档 / 模型票三档同源）。
    { id: "select", kind: "select-tool" },
    // 获取参数：族判定 + 值绑定（值只来自声明/观察）。
    { id: "resolve", kind: "resolve-param" },
    // 调用工具：动作前拒绝 → 危险闸门 → actOnce（唯一执行器）。
    { id: "invoke", kind: "invoke" },
    // 是否符合预期：步尾信封 + anti-repeat 记账。
    { id: "verify", kind: "verify-step" },
    // 交接叶：停因闭集由调用方裁决，树只声明"这里交出去"。
    { id: "handoff", kind: "handoff" },
  ],
  edges: [
    // 选到点 → 解析参数。四种不可继续的形态各自独立成边——其中 abstain 的落点就是
    // "重述题面"将来的挂载位：把这条边改指一个新状态即可，不必动 walker。
    { from: "select", result: "picked", to: "resolve" },
    { from: "select", result: "below-floor", to: "handoff" },
    { from: "select", result: "abstain", to: "handoff" },
    { from: "select", result: "no-model", to: "handoff" },
    { from: "select", result: "ambiguous", to: "handoff" },
    // 参数解析 → 执行；缺值是交接事件，不是失败。
    { from: "resolve", result: "bound", to: "invoke" },
    { from: "resolve", result: "needs-value", to: "handoff" },
    // 执行 → 验证（三种动作后果都要验）；动作前拒绝直接收尾（不耗步、不进验证）。
    { from: "invoke", result: "changed", to: "verify" },
    { from: "invoke", result: "no-change", to: "verify" },
    { from: "invoke", result: "failed", to: "verify" },
    { from: "invoke", result: "rejected", to: TREE_EXIT },
    { from: "invoke", result: "denied", to: TREE_EXIT },
    // 验证：通过则本轮收尾（下一轮从入口重进）；不达预期走纠正回环重选工具；
    // 连续无变化达阈值 = 交接。
    { from: "verify", result: "as-expected", to: TREE_EXIT },
    { from: "verify", result: "retry", to: "select" },
    { from: "verify", result: "inert", to: "handoff" },
  ],
};

/** 加载期校验（模块求值即执行）：结构非法在 import 时就红，不进运行时。 */
const problems = validateTree(BROWSER_TREE);
if (problems.length > 0) throw new Error(`浏览器决策树非法：${problems.join("；")}`);
const declared = BROWSER_TREE.states.map((s) => s.id).sort().join(",");
if (declared !== [...BROWSER_STATE_IDS].sort().join(",")) {
  throw new Error(`浏览器决策树的状态 id 与 BROWSER_STATE_IDS 不一致：${declared}`);
}
