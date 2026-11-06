/**
 * L1 作者面 kit —— 应用脚本里可用的**纯构造器**（无副作用、不接触运行时）。
 *
 * 脚本契约（`$AMBERFLOW_HOME/apps/<id>/app.mjs`，或仓库夹具）：
 *
 * ```js
 * export const meta = (kit) => ({ id, goal, hosts, slots, sources, invariants, ... });
 * export const app  = (kit) => ({ data: {...}, exec: [ ...steps ] });
 * ```
 *
 * `meta` 是**声明面**（load 期、任何网络动作之前可校验：hosts/slots/invariants 形状）；
 * `app` 是**动作面**（L1 里是声明式步骤列表，L2 才升级成 `flow(ctx)` 的运行期控制流）。
 *
 * 三段骨架：`data`（数据槽）｜`judge`（决策判断，落在每步的 `done`/`when` 与 `invariants`）｜
 * `exec`（决策执行）。kit 只提供构造器，**不提供**模型、时钟、网络、文件系统。
 */
import type { ToolSignal } from "../browser/tool-signals.ts";

/** 浏览器面完成/适用信号（与 `plan.ts` 的 signal 同形）。 */
export type DomSignal = Record<string, unknown>;

/** 一条命令声明（与 `actions.ts` 的 `CommandDecl` 同形；L2 的 `ctx.command` 复用）。 */
export interface CommandDecl {
  id?: string;
  op: string;
  target?: string;
  value?: ValueBinding;
  /**
   * A3：`scroll` 的**方向原语**（`ctx.command("scroll", sel, { to: "bottom" })`）。
   * 缺省 = 旧语义（把目标滚入视口）。只有 scroll 认它；其它 op 带 to 在加载期红。
   */
  to?: "bottom" | "top" | "page";
}

/** 值绑定四来源（与 `bindings.ts` 的 `ValueBinding` 同形）。 */
export type ValueBinding =
  | { literal: string }
  | { from: "slot"; key: string }
  | { from: "option"; key: string; match: "value" | "label" | "contains" }
  | { from: "list"; by: string; order: "min" | "max" };

/** 目标声明：单点名 / 有序多点名。 */
export type TargetDecl = { kind: "hint"; hint: string } | { kind: "hints"; hints: string[] };

/** 数据槽的来源绑定（落到 `source_slots`）。 */
export interface SourceBinding {
  kind: "source";
  source: string;
  select?: string;
  count?: string;
  field?: string;
}

/** 一步的声明（浏览器步 / 纯导航步 / 工具步三种由 kit 的构造函数产出）。 */
export type StepDecl = Record<string, unknown>;

export interface StepRequest {
  /** 必填吗？——L1 只校验 @加载期；`done` 缺失由 validatePack 报。 */
  done: DomSignal;
  /** 目标：`kit.hint()`/`kit.hints()`/命令数组；纯导航步用 `kit.go`。 */
  act?: TargetDecl | CommandDecl[];
  url?: string;
  slots?: Record<string, string>;
  when?: DomSignal;
  retries?: number;
  id?: string;
}

export interface RunRequest {
  desc: string;
  done: ToolSignal;
  args?: string[];
  dryRunArgs?: string[];
  idempotent?: boolean;
  dangerous?: boolean;
  retries?: number;
  id?: string;
}

export interface DataSourceRequest {
  select?: string;
  count?: string;
  field?: string;
}

export interface Kit {
  // ---- ① 数据槽 ----
  data: {
    /** 数据腿查到的值回写槽位（`source_slots`）；键 = 槽位名。 */
    source(source: string, req: DataSourceRequest): SourceBinding;
  };
  // ---- ② 决策判断（纯谓词构造器）----
  judge: {
    url(part: string): DomSignal;
    /**
     * 存在选择器（任意 CSS，跨主 frame 与可达的子 frame——同源与跨源均可 locator 定位；
     * 跨源页面行为的稳定性以实测为准，R11 B5）。
     * `{ visible: true }` = 还要**可见**（`css_visible_exists`；首匹配 isVisible）。
     */
    exists(selector: string, opts?: { visible?: boolean }): DomSignal;
    /**
     * S3：存在任一匹配 selector 且文本含 text 的元素（`css_exists_text`）。
     * live = Playwright hasText（大小写不敏感子串，含后代文本）；池/离线面是 label 近似。
     */
    existsText(selector: string, text: string): DomSignal;
    text(selector: string, want: string): DomSignal;
    equals(selector: string, want: string): DomSignal;
    value(selector: string, want: string): DomSignal;
    all(...s: DomSignal[]): DomSignal;
    any(...s: DomSignal[]): DomSignal;
    not(s: DomSignal): DomSignal;
    manual(question: string): DomSignal;
  };
  tool: {
    /** `exit_ok` 的值本身不参与判定；保留 `0` 是为了与既有冻结包逐字段对齐。 */
    exitOk(value?: true | 0): ToolSignal;
    exitCode(n: number): ToolSignal;
    stdoutContains(s: string): ToolSignal;
    stdoutMatches(re: string): ToolSignal;
    stderrContains(s: string): ToolSignal;
    jsonPath(path: string, want: string): ToolSignal;
    fileExists(p: string): ToolSignal;
    fileAbsent(p: string): ToolSignal;
    all(...s: ToolSignal[]): ToolSignal;
    any(...s: ToolSignal[]): ToolSignal;
    not(s: ToolSignal): ToolSignal;
  };
  // ---- ③ 决策执行（步骤构造器）----
  go(url: string, req: { done: DomSignal; desc?: string; when?: DomSignal }): StepDecl;
  step(desc: string, req: StepRequest): StepDecl;
  run(source: string, req: RunRequest): StepDecl;
  hint(hint: string): TargetDecl;
  hints(...hints: string[]): TargetDecl;
  /** 命令闭集的一项；`id` 可省略（ctx 会补稳定名），需要稳定审计名时自己给。 */
  /**
   * A3：第三参可以是值绑定，也可以是 scroll 的方向 `{ to: "bottom" | "top" | "page" }`；
   * 旧调用（值绑定/省略）语义不变。
   */
  command(
    op: string,
    target?: string,
    value?: ValueBinding | { to: "bottom" | "top" | "page" },
    id?: string,
  ): CommandDecl;
  value: {
    literal(v: string): ValueBinding;
    slot(key: string): ValueBinding;
    option(key: string, match: "value" | "label" | "contains"): ValueBinding;
    list(by: string, order: "min" | "max"): ValueBinding;
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 把目标声明摊进一步的 IR 字段（单点名 → target_hint；有序 → target_hints）。 */
function applyAct(step: StepDecl, act: TargetDecl | CommandDecl[]): void {
  if (Array.isArray(act)) {
    step["commands"] = act;
    return;
  }
  if (!isObj(act)) throw new Error("step.act must be kit.hint()/kit.hints()/kit.command(...)[]");
  if (act.kind === "hint") step["target_hint"] = act.hint;
  else step["target_hints"] = act.hints;
}

/** 创建一个 **纯构造器** kit（无状态；L2 的真实 ctx 会复用它产出的声明形状）。 */
export function createKit(): Kit {
  const judge: Kit["judge"] = {
    url: (part) => ({ url_contains: part }),
    exists: (selector, opts) => (opts?.visible === true
      ? { css_visible_exists: selector }
      : { css_exists: selector }),
    existsText: (selector, text) => ({ css_exists_text: [selector, text] }),
    text: (selector, want) => ({ css_text_contains: [selector, want] }),
    equals: (selector, want) => ({ css_text_equals: [selector, want] }),
    value: (selector, want) => ({ css_value_equals: [selector, want] }),
    all: (...s) => ({ all_of: s }),
    any: (...s) => ({ any_of: s }),
    not: (s) => ({ not: s }),
    manual: (question) => ({ manual: question }),
  };
  const tool: Kit["tool"] = {
    exitOk: (value = true) => ({ exit_ok: value }),
    exitCode: (n) => ({ exit_code_equals: n }),
    stdoutContains: (s) => ({ stdout_contains: s }),
    stdoutMatches: (re) => ({ stdout_matches: re }),
    stderrContains: (s) => ({ stderr_contains: s }),
    jsonPath: (path, want) => ({ json_path_equals: [path, want] }),
    fileExists: (p) => ({ file_exists: p }),
    fileAbsent: (p) => ({ file_absent: p }),
    all: (...s) => ({ all_of: s }),
    any: (...s) => ({ any_of: s }),
    not: (s) => ({ not: s }),
  };
  const valueKit: Kit["value"] = {
    literal: (v) => ({ literal: v }),
    slot: (key) => ({ from: "slot", key }),
    option: (key, match) => ({ from: "option", key, match }),
    list: (by, order) => ({ from: "list", by, order }),
  };
  // 层 3（错误自带修正指引）：值绑定没有 fromSlot 这类面——实测首用 Agent 会猜。
  // 未知属性访问当场报清楚可用面，而不是让 TypeError「is not a function」裸抛。
  const valueKitGuarded = new Proxy(valueKit, {
    get(t, prop: string) {
      if (prop in t) return (t as Record<string, unknown>)[prop];
      throw new Error(
        `kit.value.${String(prop)} 不存在。值绑定的可用面：kit.value.slot(key) / literal(v) / option(key, match) / list(by, order)，`
        + `或直接写对象字面量 { from: "slot", key: "…" }（fill/select/drag 的值只认 slot，绝不猜）`,
      );
    },
  });

  return {
    data: {
      source: (source, req) => ({
        kind: "source", source,
        ...(req.select === undefined ? {} : { select: req.select }),
        ...(req.count === undefined ? {} : { count: req.count }),
        ...(req.field === undefined ? {} : { field: req.field }),
      }),
    },
    judge,
    tool,
    go: (url, req) => ({
      ...(req.desc === undefined ? {} : { desc: req.desc }),
      start_url: url,
      signal: req.done,
      ...(req.when === undefined ? {} : { when: req.when }),
    }),
    step: (desc, req) => {
      const step: StepDecl = { desc, signal: req.done };
      if (req.act !== undefined) applyAct(step, req.act);
      if (req.url !== undefined) step["start_url"] = req.url;
      if (req.slots !== undefined) step["slots"] = req.slots;
      if (req.when !== undefined) step["when"] = req.when;
      if (req.retries !== undefined) step["retries"] = req.retries;
      if (req.id !== undefined) step["id"] = req.id;
      return step;
    },
    run: (source, req) => ({
      ...(req.id === undefined ? {} : { id: req.id }),
      desc: req.desc,
      source,
      ...(req.args === undefined ? {} : { args: req.args }),
      ...(req.dryRunArgs === undefined ? {} : { dry_run_args: req.dryRunArgs }),
      ...(req.idempotent === undefined ? {} : { idempotent: req.idempotent }),
      ...(req.dangerous === undefined ? {} : { dangerous: req.dangerous }),
      ...(req.retries === undefined ? {} : { retries: req.retries }),
      signal: req.done,
    }),
    hint: (hint) => ({ kind: "hint", hint }),
    hints: (...hints) => ({ kind: "hints", hints }),
    command: (op, target, value, id) => {
      // 形态防御（层 3：错误自带正确写法）：值绑定是对象字面量（或 kit.value.* 的返回值），
      // 不是函数调用链——实测首用 Agent 会猜成 ctx.value.fromSlot(...) 这类不存在的面。
      if (value !== undefined && (typeof value !== "object" || value === null || Array.isArray(value))) {
        throw new Error(
          `kit.command("${op}", …): 第三参值绑定必须是对象字面量，如 { from: "slot", key: "username" }`
          + `（或 kit.value.slot("username") / kit.value.literal("…")）；收到的是 ${typeof value}`
          + (typeof value === "function" ? "——没有 ctx.value.fromSlot 这类函数面" : ""),
        );
      }
      // A3：scroll 方向的形态（旧调用不变）。op 不是 scroll 却带 to ⇒ 由 validateCommands 拒。
      const isTo = typeof value === "object" && value !== null && Object.keys(value).length === 1
        && typeof (value as Record<string, unknown>)["to"] === "string";
      const toVal = isTo ? (value as { to: "bottom" | "top" | "page" }).to : undefined;
      const valueBinding = isTo ? undefined : (value as ValueBinding | undefined);
      return {
        ...(target === undefined ? {} : { target }),
        op,
        ...(valueBinding === undefined ? {} : { value: valueBinding }),
        ...(toVal === undefined ? {} : { to: toVal }),
        ...(id === undefined ? {} : { id }),
      };
    },
    value: valueKitGuarded,
  };
}
