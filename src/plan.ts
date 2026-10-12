/**
 * Plan contract: `PlanningRules` (one rule set that both renders into the LLM
 * prompt AND validates manual edits) + `TaskPlan` (JSON checkpoint / resume).
 *
 * Ported from `layaapp/planner.py` with one deliberate FIX carried over from the
 * Python audit: `insert()` there dropped `when`/`retries`, so a replan amendment
 * lost its guards and retry policy (finding M2). The port makes the manual
 * editing surface complete — every contract field survives insert(), update(),
 * and every disk round-trip.
 */
import fs from "node:fs";
import path from "node:path";
import { SIGNAL_OPS, signalArgs, type SignalSpec } from "./signals.ts";
import { validateCommands, type CommandDecl } from "./actions.ts";

/** 一步的可逆性声明（docs/ARCHITECTURE_IMPROVEMENTS.md §4）。 */
export interface StepEffect {
  /** 执行后会不会留下不可撤回的后果（提交订单、发消息、删除…）。 */
  irreversible?: boolean;
  /** 动作后用什么证明"页面接受了它"：`signal`=该步自己的完成信号（默认）；`none`=不校验。 */
  verify_after?: "signal" | "none";
}

export interface Subgoal {
  desc: string;
  signal: SignalSpec;
  start_url?: string | null;
  target_hint?: string;
  target_hints?: string[];
  slots?: Record<string, unknown>;
  when?: SignalSpec;
  retries?: number;
  /**
   * P4 声明式后继（= 分支）的落点名字。应用包的步本来就有 `id`（此前是死字段：无人读、
   * `TaskPlan` 不保留）；`next` 让它变成活的。
   */
  id?: string;
  /**
   * P4 声明式后继：**有序候选步 id**。这一步完成之后，运行期取第一个"此刻适用"的候选
   * （适用性 = 该步自己的 `when` 守卫，与"这一步适不适用"是同一个问题），都不适用就走自然顺序。
   * 边是**编译期**就存在的（加载期校验落点），运行期只选走哪条——不生成新命令（红线①）。
   */
  next?: string[];
  /**
   * P2 命令层：这一步的**命令闭集**（可选；不写 = 今天的一步一指针，逐字节不变）。
   * 声明半在加载期对着引擎能力面校验（`actions.validateCommands`），
   * 实例化半在运行期把声明 × 当次元素池收成候选（`actions.instantiateSpace`）。
   */
  commands?: CommandDecl[];
  /**
   * §4：这一步的**可逆性**声明（`irreversible` = 错了会留下不可撤回的后果）。
   * 风险闸门读它：写了就以声明为准（不再靠关键词猜），没写 = 今天（关键词 + 模型票）。
   * `irreversible: true` 的步不许重试（加载期校验），也是模型**绝不能**被放开的地方。
   */
  effect?: StepEffect;
  status?: string;
  obstacle?: string | null;
  attempts?: number;
  [k: string]: unknown;
}

export interface PlanFile {
  goal: string;
  subgoals: Subgoal[];
  slots: Record<string, unknown>;
  saved_at?: number;
}

const EDITABLE = new Set([
  "desc", "signal", "start_url", "status", "target_hint", "target_hints", "slots", "when", "retries",
  "commands", "id", "next",
]);

/**
 * P4 走向的**路径上界**：同一个步 id 在一次运行里最多被进入多少次。
 *
 * `maxSteps=8` 是**每一步**的预算，不是**每一条路径**的（docs/ARCHITECTURE_REVIEW.md X4）：
 * 一旦允许 `next` 边，环就必须有一个显式的上界，跑出结构化停因，而不是挂死或栈溢出。
 * 默认 3 = "一条回边最多把同一步再走两次"；应用包可用 `max_step_visits` 覆盖。
 */
export const DEFAULT_MAX_STEP_VISITS = 3;

/** 走向只读这几列（`Subgoal` 与 pack 的展开步都有）。 */
export interface PathStepLike {
  id?: string | null;
  next?: string[] | null;
}

export interface PathWalk {
  /** 进入第 `i` 步：访问计数 +1。返回非 null = 这一步**已经走得太多**（显式停因）。 */
  enter(i: number): { id: string; visits: number } | null;
  /**
   * 第 `i` 步之后的走向：按 `next` 的**声明顺序**取第一个"此刻适用"的候选（`applies(j)` 由调用方
   * 在当次页面上回答——它问的就是该步自己的 `when`），都不适用 / 没声明 ⇒ 自然顺序 `i+1`。
   *
   * 注意 `when` 会被问**两次**：选边时问在**来源页**上，进入该步时问在**它自己的 `start_url`** 上
   * （那是 `when` 原有的语义，一个字没改）。所以跨页分支的守卫要写成"页面角色级"的事实
   * （两页都成立，例如 `css_exists: "[data-test=logo]"` 或会话级的登录横幅），而不是只在来源页
   * 成立的东西——只在一页成立时，边可以被选中、步却会在进入时被跳过。
   * 返回 `steps.length` 表示走完。落点 id 不存在只可能来自改动过的计划（加载期已校验），
   * 运行期按"不适用的候选"处理，绝不抛栈。`applies` 可以是异步的（DOM 守卫要读页面）。
   */
  after(i: number, applies: (j: number) => boolean | Promise<boolean>): Promise<number>;
  /** 已经走过的步 id → 次数（报告/诊断用）。 */
  visits(): Record<string, number>;
}

/**
 * 走向的唯一实现（§8.3：同一个"下一步往哪走"的规则不许有两个版本）。
 * 纯函数、无 IO、可离线单测——环的上界也在这里，不在调用方各写一遍。
 */
export function createPathWalk(
  steps: readonly PathStepLike[], maxVisits: number = DEFAULT_MAX_STEP_VISITS,
): PathWalk {
  const byId = new Map<string, number>();
  steps.forEach((s, i) => {
    const id = s.id === undefined || s.id === null ? "" : String(s.id);
    if (id !== "" && !byId.has(id)) byId.set(id, i);
  });
  const counts = new Map<string, number>();
  return {
    enter(i) {
      const raw = steps[i]?.id;
      const id = raw === undefined || raw === null ? "" : String(raw);
      if (id === "") return null;                 // 没名字 ⇒ 不可计数（自然顺序本就单调，不会重入）
      const n = (counts.get(id) ?? 0) + 1;
      counts.set(id, n);
      return n > maxVisits ? { id, visits: n } : null;
    },
    async after(i, applies) {
      for (const target of steps[i]?.next ?? []) {
        const j = byId.get(String(target));
        if (j === undefined) continue;            // 加载期已报红；运行期当"不适用"
        if (await applies(j)) return j;
      }
      return i + 1;
    },
    visits: () => Object.fromEntries(counts),
  };
}

export class PlanningRules {
  // NOTE: explicit fields, not constructor parameter properties — the repo's
  // tool scripts run under `node --experimental-strip-types`, which cannot strip
  // parameter properties (tests/project.test.ts guards this).
  maxSubgoals: number;
  requireSignal: boolean;
  requireStartUrl: boolean;
  forbiddenWords: readonly string[];
  requireHint: boolean;

  constructor(
    maxSubgoals = 8,
    requireSignal = true,
    requireStartUrl = false,
    forbiddenWords: readonly string[] = [],
    requireHint = false,
  ) {
    this.maxSubgoals = maxSubgoals;
    this.requireSignal = requireSignal;
    this.requireStartUrl = requireStartUrl;
    this.forbiddenWords = forbiddenWords.map((w) => w.toLowerCase());
    this.requireHint = requireHint;
  }

  promptText(): string {
    const lines = [
      "Planning rules (hard constraints):",
      `- at most ${this.maxSubgoals} subgoals, ordered, each independently verifiable`,
      '- when the page elements are given, add "target_hint" naming the element the',
      "  subgoal drives: #id | tag[attr=value] | tag[attr~substr] | tag[near~token] |",
      "  tag | bare-token. It is resolved by rule at zero model cost; omit it only when",
      "  the target is genuinely ambiguous in the snapshot",
      "- every subgoal MUST carry a done-signal, one of:",
      "    url_contains: substring of the final url  (op=value)",
      "    css_exists: css selector that must exist  (op=value)",
      "    css_text_equals: selector|exact text",
      "    css_text_contains: selector|substring of the element's text",
      "    css_value_equals: selector|exact input value",
    ];
    if (this.requireStartUrl) lines.push("- every subgoal needs an explicit start_url");
    if (this.forbiddenWords.length) {
      lines.push(`- forbidden in descriptions: ${this.forbiddenWords.join(", ")}`);
    }
    return lines.join("\n") + "\n";
  }

  /**
   * @param plan - 待校验的计划。
   * @param opts.extraIds - 计划**之外**的合法 `next` 落点。混合旅程（浏览器步 + 工具步）里，
   *   一个浏览器步的 `next` 可以指向工具步——而工具步不进计划，只看计划会说"这个 id 不存在"。
   *   调用方（应用包加载器）把旅程里**全部**步 id 传进来，边就按旅程校验而不是按计划的子集校验。
   * @param opts.slotKeys - 已知的数据袋键。给了就顺带校"命令绑定的键必须声明过"——
   *   槽位名打错在运行期才变成 `needs_value` 已经太晚（D6：配置类错误要在加载期红）。
   *   不传（计划 CLI/bench 那条路）时不做这项检查，旧行为不变。
   */
  problems(plan: TaskPlan, opts: { extraIds?: ReadonlySet<string>; slotKeys?: ReadonlySet<string> } = {}): string[] {
    const issues: string[] = [];
    if (plan.subgoals.length > this.maxSubgoals) {
      issues.push(`${plan.subgoals.length} subgoals exceed max ${this.maxSubgoals}`);
    }
    // P4 声明式后继的**落点**在加载期校验：`next` 指向一个不存在的步 id 是配置错误，
    // 不是运行期意外（跑起来才发现的边 = 一步都不走的静默分支）。id 也必须唯一，
    // 否则"往哪走"取决于谁先声明——那正是位置性 ref 那类不变量漂移的来源。
    const ids = new Map<string, number>();
    plan.subgoals.forEach((s, i) => {
      const id = (s as { id?: unknown }).id;
      if (id === undefined || id === null) return;
      if (typeof id !== "string" || id.trim() === "") {
        issues.push(`subgoal[${i}]: id must be a non-empty string`);
        return;
      }
      if (ids.has(id)) issues.push(`subgoal[${i}]: duplicate step id '${id}' (next edges need one name per step)`);
      else ids.set(id, i);
    });
    plan.subgoals.forEach((s, i) => {
      const next = (s as { next?: unknown }).next;
      if (next === undefined || next === null) return;
      if (!Array.isArray(next) || next.length === 0 || !next.every((x) => typeof x === "string" && x.trim() !== "")) {
        issues.push(`subgoal[${i}]: next must be a non-empty list of step ids`);
        return;
      }
      for (const t of next) {
        if (!ids.has(String(t)) && !(opts.extraIds?.has(String(t)) ?? false)) {
          issues.push(`subgoal[${i}].next: ${JSON.stringify(String(t))} names no step in this plan`
            + ` (declared ids: ${[...ids.keys(), ...(opts.extraIds ?? [])].join(", ") || "none"})`);
        }
      }
    });
    plan.subgoals.forEach((s, i) => {
      const tag = `subgoal[${i}]`;
      const sig = (s.signal ?? {}) as SignalSpec;
      // Composition and `manual` carry no scalar arguments; they are validated
      // structurally and — for the combinators — recursively, so a bad op nested
      // inside `all_of` is caught at plan-validation time, not mid-run.
      //
      // `when` uses the SAME languages as `signal` (`signals.ts` answers both
      // questions), so it must be checked by the same walker. It used to be skipped:
      // a `when: {magic_op: "#x"}` passed validation and only blew up mid-run as
      // `stop_reason: "error: … unknown signal spec"` -> a BLOCKED subgoal. Loud, but
      // one round too late — a guard that can never be evaluated should fail at load.
      const checkSignalSpec = (spec: SignalSpec, where: string): void => {
        for (const [op, args] of Object.entries(spec)) {
          if (!(op in SIGNAL_OPS)) { issues.push(`${where}: unknown signal op '${op}'`); continue; }
          if (op === "manual") continue;                        // a human attestation, no args
          if (op === "all_of" || op === "any_of") {
            if (!Array.isArray(args) || args.length === 0) {
              issues.push(`${where}: ${op} needs a non-empty list of signals`);
              continue;
            }
            args.forEach((child, j) => checkSignalSpec(child as SignalSpec, `${where}.${op}[${j}]`));
            continue;
          }
          if (op === "not") {
            if (!args || typeof args !== "object" || Array.isArray(args)) {
              issues.push(`${where}: not needs one signal`);
              continue;
            }
            checkSignalSpec(args as SignalSpec, `${where}.not`);
            continue;
          }
          if (signalArgs(args).length !== SIGNAL_OPS[op]) {
            issues.push(`${where}: ${op} needs ${SIGNAL_OPS[op]} argument(s)`);
          }
        }
      };
      if (Object.keys(sig).length === 0) {
        if (this.requireSignal) issues.push(`${tag}: missing done-signal`);
      } else {
        checkSignalSpec(sig, tag);
      }
      const when = (s as { when?: SignalSpec | null }).when;
      if (when !== undefined && when !== null) {
        if (typeof when !== "object" || Array.isArray(when) || Object.keys(when).length === 0) {
          issues.push(`${tag}.when: must be a non-empty signal (the guard decides skip vs run)`);
        } else {
          checkSignalSpec(when, `${tag}.when`);
        }
      }
      const hint = s.target_hint;
      const hints = s.target_hints;
      if (hint !== undefined && (typeof hint !== "string" || hint.trim() === "")) {
        issues.push(`${tag}: target_hint must be a non-empty string`);
      }
      if (hints !== undefined && (!Array.isArray(hints) || hints.length === 0 ||
          !hints.every((h) => typeof h === "string" && h.trim() !== ""))) {
        issues.push(`${tag}: target_hints must be a non-empty list of strings`);
      }
      // One named target OR an ordered list of them both satisfy the rule:
      // a form search legitimately needs "fill the date, pick, submit".
      if (this.requireHint && !hint && !hints) issues.push(`${tag}: missing target_hint`);
      if (this.requireStartUrl && !s.start_url) issues.push(`${tag}: missing start_url`);
      const retries = s.retries;
      if (retries !== undefined &&
          (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0)) {
        issues.push(`${tag}: retries must be a non-negative integer`);
      }
      // P2 command space: the SAME validator the pack loader uses (`actions.validateCommands`),
      // so a hand-edited or LLM-amended plan that declares `commands` is checked at load time
      // exactly like a pack step — unknown op / dup id / a fill with no slot binding fail here,
      // not mid-run. Absent `commands` adds nothing (default-equivalence).
      if (s.commands !== undefined) {
        validateCommands(s.commands, tag, issues, opts.slotKeys);
      }
      const desc = String(s.desc ?? "").toLowerCase();
      for (const w of this.forbiddenWords) {
        if (desc.includes(w)) issues.push(`${tag}: forbidden word '${w}' in desc`);
      }
    });
    return issues;
  }
}

export class TaskPlan {
  goal: string;
  slots: Record<string, unknown>;
  subgoals: Subgoal[];
  path: string;

  constructor(
    goal: string,
    subgoals: readonly Partial<Subgoal>[],
    path: string = ".task_state.json",
    slots: Record<string, unknown> | null = null,
  ) {
    this.goal = goal;
    // The plan's data bag (same contract as cases.json's top-level `slots`):
    // values the executor may fill, never values the model invents.
    this.slots = { ...(slots ?? {}) };
    this.subgoals = subgoals.map((s) => {
      const out: Subgoal = {
        desc: String(s.desc),
        signal: (s.signal ?? {}) as SignalSpec,
        start_url: s.start_url ?? null,
        status: "pending",
        obstacle: null,
      };
      for (const k of ["target_hint", "target_hints", "slots", "when", "commands", "id", "next"] as const) {
        if (s[k]) out[k] = s[k] as never;      // truthy-only, exactly like Python
      }
      if (s.retries) out.retries = Math.trunc(Number(s.retries));
      return out;
    });
    this.path = path;
  }

  save(): void {
    const dir = path.dirname(this.path);
    if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
    const payload: PlanFile = {
      goal: this.goal, subgoals: this.subgoals, slots: this.slots, saved_at: Date.now() / 1000,
    };
    fs.writeFileSync(this.path, JSON.stringify(payload, null, 2), "utf-8");
  }

  static load(p = ".task_state.json"): TaskPlan | null {
    if (!fs.existsSync(p)) return null;
    const d = JSON.parse(fs.readFileSync(p, "utf-8")) as PlanFile;
    const plan = new TaskPlan(d.goal, d.subgoals, p, d.slots ?? null);
    plan.subgoals = d.subgoals;   // disk is authoritative: verbatim, no re-filtering
    plan.path = p;
    return plan;
  }

  /** Manual-editing surface (CLI / hand-tuned JSON land here). */
  insert(
    idx: number,
    desc: string,
    signal: SignalSpec,
    startUrl: string | null = null,
    targetHint: string | null = null,
    targetHints: string[] | null = null,
    slots: Record<string, unknown> | null = null,
    when: SignalSpec | null = null,
    retries: number | null = null,
    commands: CommandDecl[] | null = null,
    /**
     * P2/P4 追加字段的**具名**出口：位置参数已经排到第 10 个（U2 记着这笔债），
     * 再加两个位置参数只会让调用方更容易错位。给 replan 补丁与 plan-cli 用。
     */
    extra: { id?: string | null; next?: string[] | null } | null = null,
  ): void {
    const sg: Subgoal = { desc, signal, start_url: startUrl, status: "pending", obstacle: null };
    // Complete contract surface: Python's insert() silently dropped when/retries —
    // and the same lesson applies to every field added later, so `commands`/`id`/`next`
    // ride here too (a replan amendment must never lose a step's command space or its edges).
    if (targetHint) sg.target_hint = targetHint;
    if (targetHints) sg.target_hints = targetHints;
    if (slots) sg.slots = slots;
    if (when) sg.when = when;
    if (retries) sg.retries = Math.trunc(retries);
    if (commands) sg.commands = commands;
    if (extra?.id) sg.id = String(extra.id);
    if (extra?.next && extra.next.length) sg.next = extra.next.map((x) => String(x));
    this.subgoals.splice(idx, 0, sg);
  }

  remove(idx: number): void {
    this.subgoals.splice(idx, 1);
  }

  move(idx: number, newIdx: number): void {
    const [sg] = this.subgoals.splice(idx, 1);
    this.subgoals.splice(newIdx, 0, sg!);
  }

  update(idx: number, fields: Partial<Subgoal>): void {
    for (const [k, v] of Object.entries(fields)) {
      if (EDITABLE.has(k)) (this.subgoals[idx] as Record<string, unknown>)[k] = v;
    }
  }

  pending(): Subgoal[] {
    return this.subgoals.filter((s) => s.status === "pending");
  }

  summary(): string {
    return this.subgoals.map((s) => `${String(s.status).slice(0, 4)}:${s.desc.slice(0, 30)}`).join(" | ");
  }
}
