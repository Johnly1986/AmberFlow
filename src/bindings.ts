/**
 * 数据槽层（④c，P3 落地）——参数的**来源**与**声明式候选规则**。
 *
 * 出处：docs/ARCHITECTURE_REVIEW.md §6.1 的表（"数据槽层 = 绑定，阶段 = 绑定期（运行期），
 * 权威 = 值的来源与声明式选择规则，失败行为 = 缺值 → `needs_value`（今天已有的正确行为）"）
 * 与 §7-P3 行（"先接 `<select>` 与 `list_extract` 两处**已有前身**"）。
 *
 * 本模块只做两件事，且**全部可选**（不声明时不改变任何既有行为，§8.4 缺省等价）：
 *
 *   1. **声明半（加载期）**：`validateBinding` 对着引擎的能力面校验一条绑定。
 *      未知来源 / 未知匹配规则 / 空键来源 / `option` 用在看不见选项的 op 上 ⇒ 加载期红。
 *   2. **运行期解析**：`resolveBinding` 是**纯函数**（声明 × 当次观察 → 值或结构化缺值原因）。
 *
 * 红线②（不发明取值）在这里的落地形式：**模型永远不参与选值**——只有三种来源，
 * 且每一种都必须由声明点名：
 *
 * | 来源 | 形状 | 今天的前身 |
 * |---|---|---|
 * | 用户参数 / 计划槽（**绑定**，不是候选） | `{"from":"slot","key":"…"}` | `--slot k=v`、`plan.slots` |
 * | 页面候选 + **声明规则** | `{"from":"option","key":"…","match":"value\|label\|contains"}` | `<select>` 的 label→value 两候选回退 |
 * | 列表行 + **数据规则** | `{"from":"list","by":"price","order":"min\|max"}` | `list_extract` → `datasource.selectIndex` |
 *
 * 两条纪律，与 hint 的 P1 同款：
 *   - **分档匹配、档内歧义 = 弃权**（fail closed）：`option` 的匹配按
 *     value 精确 → label 精确 → label/value 子串 三档走，**每一档内部 >1 命中都返回失败**——
 *     这就是 `rules.hintMatchImpl` 的 tier 纪律换到"值"上（人写 `_first_if_same` 从不掷硬币）。
 *   - **不新开第三套语法**（§8.3）：`list` 的"选哪一行"直接调用
 *     `datasource.selectIndex`——浏览器侧与数据侧共用同一实现（`list_step` 也走这里）。
 */
import { selectIndex } from "./datasource.ts";

/** 引擎能力面：参数来源（代码，不是用户词表）。 */
export const BINDING_SOURCES = ["slot", "option", "list"] as const;
export type BindingSource = (typeof BINDING_SOURCES)[number];
/** 页面候选的声明式匹配规则（红线②：规则必须声明，不接受"看着像就填"）。 */
export const OPTION_MATCHES = ["value", "label", "contains"] as const;
export type OptionMatch = (typeof OPTION_MATCHES)[number];
/** 列表行的声明式选择规则（min/max 只是 `selectIndex` 的 `order`）。 */
export const LIST_ORDERS = ["min", "max"] as const;
export type ListOrder = (typeof LIST_ORDERS)[number];

/** 计划槽位绑定（值只在计划的数据袋里，按名字取）。 */
export interface SlotBinding {
  from: "slot";
  key: string;
}
/** 页面候选绑定：把计划里的键值对到**当次观察到的**候选上，匹配规则必须声明。 */
export interface OptionBinding {
  from: "option";
  key: string;
  match: OptionMatch;
}
/** 列表行绑定：在**当次观察到的**行集上按声明规则选一行。 */
export interface ListBinding {
  from: "list";
  by: string;
  order: ListOrder;
}
export type ValueBinding = SlotBinding | OptionBinding | ListBinding;

/** 当次观察到的页面候选（`<select>` 的 option：机器值 + 人读标签）。 */
export interface OptionCandidate {
  value: string;
  label: string;
}

/** 解析一条绑定所需的**当次观察**（缺哪一样，用那种来源就在运行期结构化失败）。 */
export interface BindingContext {
  slots?: Record<string, unknown>;
  options?: readonly OptionCandidate[];
  rows?: readonly Record<string, unknown>[];
}

export type BindingOutcome =
  | {
    ok: true;
    value: unknown;
    /** `list` 来源的胜者下标；其余为 null。 */
    index: number | null;
    /** 命中的档位（诊断/证据用；与 hint 的 tier 诊断同款）。 */
    via: string;
  }
  | { ok: false; reason: string };

/** 是不是一条结构上可辨认的绑定声明（只做形状判断，不做能力面校验）。 */
export function isValueBinding(v: unknown): v is ValueBinding {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const from = (v as Record<string, unknown>)["from"];
  return typeof from === "string" && (BINDING_SOURCES as readonly string[]).includes(from);
}

/**
 * 加载期校验（一条绑定）。错误是数据：产 problem 字符串，由调用方汇总——
 * 与 `PlanningRules.problems` / `actions.validateCommands` / `sources/*.json` 同一个口径
 * （§8.3：不新开第三套校验器）。
 *
 * @param value - 配置里那条 `value`。
 * @param where - problem 前缀（`sg.commands[0].value` 这类）。
 * @param problems - 汇总数组。
 * @param opts.slotKeys - 给了就校"槽位键必须声明过"（应用包层传 merged slots 的键）。
 * @param opts.op - 命令的 op；`option` 只对能看见选项的 op（`select`）成立，加载期就拒绝。
 * @param opts.allowList - 是否允许 `list` 来源（只有数据腿 `list_step` 消费行；命令闭集不消费）。
 */
export function validateBinding(
  value: unknown, where: string, problems: string[],
  opts: { slotKeys?: ReadonlySet<string>; op?: string; allowList?: boolean } = {},
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.push(`${where}: value must be {from:'slot',key} | {from:'option',key,match} | {from:'list',by,order}`);
    return;
  }
  const v = value as Record<string, unknown>;
  const from = v["from"];
  if (typeof from !== "string" || !(BINDING_SOURCES as readonly string[]).includes(from)) {
    problems.push(`${where}: value.from must be one of ${BINDING_SOURCES.join("|")} (got ${JSON.stringify(from)})`);
    return;
  }
  if (from === "slot") {
    const key = v["key"];
    if (typeof key !== "string" || !key.trim()) {
      problems.push(`${where}: value.key must be a non-empty slot name`);
    } else if (opts.slotKeys !== undefined && !opts.slotKeys.has(key)) {
      problems.push(`${where}: value.key ${JSON.stringify(key)} is not a declared slot (known: ${[...opts.slotKeys].join(", ") || "none"})`);
    }
    return;
  }
  if (from === "option") {
    const key = v["key"];
    if (typeof key !== "string" || !key.trim()) {
      problems.push(`${where}: value.key must be a non-empty slot name (the plan's bag holds the value to match)`);
    } else if (opts.slotKeys !== undefined && !opts.slotKeys.has(key)) {
      problems.push(`${where}: value.key ${JSON.stringify(key)} is not a declared slot (known: ${[...opts.slotKeys].join(", ") || "none"})`);
    }
    const match = v["match"];
    // 红线②：候选的选择规则**必须声明**——默认一个"看着像"的匹配就是模型/启发式在选值。
    if (match === undefined) {
      problems.push(`${where}: value.match must be declared for an 'option' source (one of ${OPTION_MATCHES.join("|")}) — an undeclared rule is a guess`);
    } else if (typeof match !== "string" || !(OPTION_MATCHES as readonly string[]).includes(match)) {
      problems.push(`${where}: value.match must be one of ${OPTION_MATCHES.join("|")} (got ${JSON.stringify(match)})`);
    }
    if (opts.op !== undefined && opts.op !== "select") {
      problems.push(`${where}: an 'option' source needs an op that can see options (got '${opts.op}'; only 'select' observes a candidate list)`);
    }
    return;
  }
  // from === "list"
  if (!opts.allowList) {
    problems.push(`${where}: an 'list' source picks a ROW, which no command op consumes — declare it on a list_step (the data leg), not on commands`);
    return;
  }
  const by = v["by"];
  if (typeof by !== "string" || !by.trim()) {
    problems.push(`${where}: value.by must be a non-empty field name (the row column the rule ranks)`);
  }
  const order = v["order"];
  if (order === undefined) {
    problems.push(`${where}: value.order must be declared for a 'list' source (one of ${LIST_ORDERS.join("|")})`);
  } else if (typeof order !== "string" || !(LIST_ORDERS as readonly string[]).includes(order)) {
    problems.push(`${where}: value.order must be one of ${LIST_ORDERS.join("|")} (got ${JSON.stringify(order)})`);
  }
}

/** 规范化一条已被 `validateBinding` 认可的绑定（类型收窄用；不做校验）。 */
export function asBinding(value: unknown): ValueBinding {
  return value as ValueBinding;
}

/**
 * 运行期解析（纯函数）：声明 × 当次观察 → 值，或**结构化缺值原因**。
 *
 * 三条来源各自 fail closed：
 *   - `slot`：袋里没有那个键 ⇒ 失败（值不在计划里就停下来，绝不猜）。
 *   - `option`：没有观察到候选 / 三档都没命中 / 档内歧义 ⇒ 失败。
 *   - `list`：没有行 / 该列在**所有**行上都为空 ⇒ 失败（`selectIndex` 对全空列会返回第 0 行，
 *     那是"没有数据时挑第一行"，不是声明式选择，所以这里先拦）。
 */
export function resolveBinding(binding: ValueBinding, ctx: BindingContext = {}): BindingOutcome {
  const slots = ctx.slots ?? {};
  if (binding.from === "slot") {
    if (!(binding.key in slots)) {
      return {
        ok: false,
        reason: `slot ${JSON.stringify(binding.key)} is not in the plan's data bag`
          + ` (values come from the plan, never invented)`,
      };
    }
    return { ok: true, value: slots[binding.key], index: null, via: `slot:${binding.key}` };
  }

  if (binding.from === "option") {
    const options = ctx.options;
    if (options === undefined || options.length === 0) {
      return {
        ok: false,
        reason: `no option candidates were observed for the 'option' source`
          + ` (the element exposes no candidate list)`,
      };
    }
    if (!(binding.key in slots)) {
      return {
        ok: false,
        reason: `slot ${JSON.stringify(binding.key)} is not in the plan's data bag`
          + ` (values come from the plan, never invented)`,
      };
    }
    const want = String(slots[binding.key] ?? "");
    const fold = (s: string): string => s.trim().toLowerCase();
    // 三档：声明的那一档先用，仍无命中时依次放宽——但**每一档内部 >1 命中都弃权**
    // （档内歧义交给"更小的提问"是 P1 对元素做的事；对值没有更小的提问，所以只能是失败）。
    const tiers: Array<{ name: string; hit: (o: OptionCandidate) => boolean }> = [];
    if (binding.match === "value") {
      tiers.push({ name: "option:value", hit: (o) => o.value === want });
      tiers.push({ name: "option:value-fold", hit: (o) => fold(o.value) === fold(want) });
      tiers.push({ name: "option:label", hit: (o) => o.label === want });
      tiers.push({ name: "option:label-fold", hit: (o) => fold(o.label) === fold(want) });
      tiers.push({ name: "option:contains", hit: (o) => fold(o.label).includes(fold(want)) || fold(o.value).includes(fold(want)) });
    } else if (binding.match === "label") {
      tiers.push({ name: "option:label", hit: (o) => o.label === want });
      tiers.push({ name: "option:label-fold", hit: (o) => fold(o.label) === fold(want) });
      tiers.push({ name: "option:value", hit: (o) => o.value === want });
      tiers.push({ name: "option:contains", hit: (o) => fold(o.label).includes(fold(want)) || fold(o.value).includes(fold(want)) });
    } else {
      tiers.push({ name: "option:contains", hit: (o) => fold(o.label).includes(fold(want)) || fold(o.value).includes(fold(want)) });
      tiers.push({ name: "option:value", hit: (o) => o.value === want });
      tiers.push({ name: "option:label", hit: (o) => o.label === want });
    }
    for (const tier of tiers) {
      const hits = options.filter(tier.hit);
      if (hits.length === 1) {
        return { ok: true, value: hits[0]!.value, index: options.indexOf(hits[0]!), via: tier.name };
      }
      if (hits.length > 1) {
        const shown = hits.slice(0, 4).map((o) => JSON.stringify(o.label || o.value)).join(", ");
        return {
          ok: false,
          reason: `'${tier.name}' matched ${hits.length} candidates (${shown}${hits.length > 4 ? ", …" : ""})`
            + ` — ambiguous inside a tier, so the binding abstains instead of picking one`,
        };
      }
    }
    return {
      ok: false,
      reason: `none of the observed candidates matched ${JSON.stringify(want)} for ${JSON.stringify(binding.key)}`
        + ` (rule '${binding.match}'; ${options.length} candidate(s) observed)`,
    };
  }

  // from === "list"
  const rows = ctx.rows ?? [];
  if (rows.length === 0) {
    return { ok: false, reason: `no rows were observed for the 'list' source (nothing to rank by '${binding.by}')` };
  }
  const present = rows.filter((r) => r[binding.by] !== null && r[binding.by] !== undefined);
  if (present.length === 0) {
    return {
      ok: false,
      reason: `field ${JSON.stringify(binding.by)} is empty on all ${rows.length} observed row(s)`
        + ` — a declared rule ranks data, and there is none`,
    };
  }
  // 混类型的列不是"排序结果奇怪"，而是**没法排序**：一个 number 与一个 string 相比，
  // 底层比较器会抛错。失败必须是数据（这个函数对调用方的合同是"要么给值、要么给理由"），
  // 所以先判可比性，再兜住任何比较器异常。
  const kinds = new Set(rows
    .map((r) => (r[binding.by] === null || r[binding.by] === undefined ? "" : typeof r[binding.by]))
    .filter((k) => k !== ""));
  if (kinds.size > 1) {
    return {
      ok: false,
      reason: `field ${JSON.stringify(binding.by)} mixes value types (${[...kinds].sort().join(", ")})`
        + ` — a declared ${binding.order} rule ranks comparable data, and this column is not comparable`,
    };
  }
  // "选哪一行"只有一份实现（红线② + §8.3）：datasource 引擎的 selectIndex，
  // `list_step`（浏览器侧）与 `selects`（数据侧）走的是同一个它。
  let index: number;
  try {
    index = selectIndex(rows as Array<Record<string, unknown>>, { sort_by: [binding.by], order: binding.order });
  } catch (e) {
    return {
      ok: false,
      reason: `ranking by ${JSON.stringify(binding.by)} failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (index < 0) return { ok: false, reason: `no row was selected by '${binding.order}(${binding.by})'` };
  return {
    ok: true, value: rows[index], index,
    via: `list:${binding.order}(${binding.by})`,
  };
}

/** 从一条**已声明**的 `<select>` 元素读出候选（运行期观察；读不到就是空集，由解析如实失败）。 */
export function optionCandidatesFrom(raw: unknown): OptionCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: OptionCandidate[] = [];
  for (const o of raw) {
    if (typeof o !== "object" || o === null) continue;
    const rec = o as Record<string, unknown>;
    out.push({ value: String(rec["value"] ?? ""), label: String(rec["label"] ?? "").trim() });
  }
  return out;
}
