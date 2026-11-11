/**
 * The verifiable-signal language, in ONE place.
 *
 * `checkSignal` answers two different questions with the same five operators:
 * "is this subgoal DONE?" (completion) and "does this subgoal APPLY?" (a
 * precondition / `when` guard). Layering mirrors the Python module:
 * signals -> extraction (only); planner and executor both import it.
 *
 * Port note: the Python implementation is synchronous because Playwright's sync
 * API is; the port is ASYNC (browser I/O in Node). Callers await it either way.
 */
import { firstOf, locatorAnyFrame, urlOf, type PageLike } from "./extraction.ts";
// 算子表本体在叶子模块 `signal-ops.ts`（零 import）：`grammar-prompt.ts` 要引用它生成
// 提示词/报错文案，不应为此拖入本模块背后的 extraction 链。此处 re-export 保持 API。
import { SIGNAL_OPS } from "./signal-ops.ts";
export { SIGNAL_OPS };

export type SignalSpec = Record<string, unknown>;

/** Values may be scalars or 1/2-element lists (the CLI parses them as lists). */
function arg(v: unknown): unknown {
  return Array.isArray(v) && v.length === 1 ? v[0] : v;
}

/**
 * Tiny verifiable-signal language for subgoal completion.
 *
 * `css_text_contains` is the workhorse on REAL pages: exact equality breaks the
 * moment a heading carries a badge or an edit link (zh.wikipedia's <h1> reads
 * "艾伦·图灵编辑", so `css_text_equals` can never fire there), while contains
 * survives cosmetic chrome. It reads the first match rather than insisting on a
 * single one: css selectors on production pages legitimately match many nodes.
 */
export async function checkSignal(
  page: PageLike, spec: SignalSpec, opts?: { hosts?: string[] | null },
): Promise<boolean> {
  try {
    if ("url_contains" in spec) return urlOf(page).includes(String(arg(spec.url_contains)));
    // CSS ops look in the main frame AND reachable child frames (same-origin and
    // cross-origin both resolve through Playwright locators; cross-origin stability
    // is measured, R11 B5): a done-signal
    // frequently lives inside an iframe (embedded form field, status banner).
    if ("css_exists" in spec) return (await locatorAnyFrame(page, String(arg(spec.css_exists)), opts)) !== null;
    // S3：存在**任一**匹配 selector 且文本含 want 的元素（跨主 frame 与可达的子 frame，同源/跨源均可定位）。
    // live 用 Playwright 的 hasText 过滤器（大小写不敏感的子串；匹配元素自身或后代文本）。
    if ("css_exists_text" in spec) {
      const [sel, want] = (spec.css_exists_text as unknown[]).map(arg);
      return (await locatorAnyFrame(page, String(sel), { hasText: String(want), ...opts })) !== null;
    }
    // S3：存在且**可见**（首匹配 locator.isVisible()）。池/离线面无法判定可见性（见 evalSignalOnState）。
    if ("css_visible_exists" in spec) {
      const loc = await locatorAnyFrame(page, String(arg(spec.css_visible_exists)), opts);
      if (loc === null) return false;
      const first = firstOf(loc);
      if (typeof first.isVisible !== "function") return false;   // 无法证伪为可见 ⇒ 不判真
      return (await first.isVisible()) === true;
    }
    if ("css_text_contains" in spec) {
      const [sel, want] = (spec.css_text_contains as unknown[]).map(arg);
      const loc = await locatorAnyFrame(page, String(sel), opts);
      return loc !== null && String(await firstOf(loc).innerText({ timeout: 2000 })).includes(String(want));
    }
    if ("css_text_equals" in spec) {
      const [sel, want] = (spec.css_text_equals as unknown[]).map(arg);
      const loc = await locatorAnyFrame(page, String(sel), opts);
      return loc !== null && String(await firstOf(loc).innerText({ timeout: 2000 })).trim() === String(want);
    }
    if ("css_value_equals" in spec) {
      const [sel, want] = (spec.css_value_equals as unknown[]).map(arg);
      const loc = await locatorAnyFrame(page, String(sel), opts);
      return loc !== null && String(await firstOf(loc).inputValue({ timeout: 2000 })) === String(want);
    }
    // Composition. Each leaf is still a DOM fact, so a composed signal cannot be
    // more permissive than its parts: `all_of` adds discrimination, `any_of` only
    // accepts alternatives a human verified one by one, `not` expresses "the
    // spinner is gone" without inventing a positive claim.
    if ("all_of" in spec) {
      for (const part of spec.all_of as SignalSpec[]) {
        if (!(await checkSignal(page, part, opts))) return false;
      }
      return true;
    }
    if ("any_of" in spec) {
      for (const part of spec.any_of as SignalSpec[]) {
        if (await checkSignal(page, part, opts)) return true;
      }
      return false;
    }
    if ("not" in spec) return !(await checkSignal(page, spec.not as SignalSpec, opts));
    // A human attestation is not a DOM fact: it can never be verified here, so a
    // `manual` signal is false for the automated loop and the executor asks the
    // human explicitly (see RunOptions.manualGoal). With no human, the step blocks.
    if ("manual" in spec) return false;
  } catch {
    return false;
  }
  throw new Error(`unknown signal spec: ${JSON.stringify(spec)}`);
}

/**
 * Evaluate a signal OFFLINE, against a captured page view.
 *
 * The live `checkSignal` needs a browser; signal INDUCTION needs to test hundreds
 * of candidate predicates against a recorded before/after pair, so the same
 * semantics are available over the extracted element pool. Returns `null` when the
 * selector cannot be decided from the pool (classes, `:nth-child`, shadow paths):
 * induction treats that as "needs live verification" instead of guessing.
 */
export function evalSignalOnState(spec: SignalSpec, view: StateView): boolean | null {
  const one = (s: SignalSpec): boolean | null => evalSignalOnState(s, view);
  if ("all_of" in spec) return andAll((spec.all_of as SignalSpec[]).map(one));
  if ("any_of" in spec) return orAny((spec.any_of as SignalSpec[]).map(one));
  if ("not" in spec) {
    const v = one(spec.not as SignalSpec);
    return v === null ? null : !v;
  }
  if ("manual" in spec) return null;                       // human attestation: not decidable here
  if ("url_contains" in spec) return view.url.includes(String(arg(spec.url_contains)));
  // 可见性（U2a）：learn 的 StateView 在捕获期记了每个节点的 `visible`，因此可判——按
  // live 的同一口径取**首匹配**（matchSelector 已按捕获序=文档序），有匹配但无 visible
  // 字段（旧视图/未捕获）= **未知**（null，诱导期不采纳），绝不当作成立。
  // 无匹配时 live 的 locator.isVisible() 也是 false，离线同样返回 false。
  if ("css_visible_exists" in spec) {
    const hits = matchSelector(view.elems, String(arg(spec.css_visible_exists)));
    if (hits === null) return null;
    if (!hits.length) return false;
    const first = hits[0]!;
    return typeof first.visible === "boolean" ? first.visible : null;
  }
  if ("css_exists" in spec) {
    const hits = matchSelector(view.elems, String(arg(spec.css_exists)));
    return hits === null ? null : hits.length > 0;
  }
  // **池近似**（文档已注明）：匹配 selector 的元素 label（池投影）包含 text。
  // live 的 hasText 还会看后代文本、大小写不敏感；池里只有合成 label，判不出的选择器返回 null。
  if ("css_exists_text" in spec) {
    const pair = (Array.isArray(spec.css_exists_text) ? spec.css_exists_text as unknown[] : [spec.css_exists_text]).map(arg);
    const hits = matchSelector(view.elems, String(pair[0]));
    if (hits === null) return null;
    const want = String(pair[1]).toLowerCase();
    return hits.some((el) => String(el.label ?? "").toLowerCase().includes(want));
  }
  const textOps: Array<[string, (got: string, want: string) => boolean]> = [
    ["css_text_contains", (g, w) => g.includes(w)],
    ["css_text_equals", (g, w) => g.trim() === w],
    ["css_value_equals", (g, w) => g === w],
  ];
  for (const [op, cmp] of textOps) {
    if (!(op in spec)) continue;
    const pair = (Array.isArray(spec[op]) ? (spec[op] as unknown[]) : [spec[op]]).map(arg);
    const hits = matchSelector(view.elems, String(pair[0]));
    if (hits === null) return null;                        // selector is not pool-expressible
    if (!hits.length) return false;
    const el = hits[0]!;
    const got = op === "css_value_equals"
      ? String(el.value ?? el.label ?? "")
      : String(el.label ?? "");
    return cmp(got, String(pair[1]));
  }
  return null;                                             // unknown op: undecidable offline
}

function andAll(vs: Array<boolean | null>): boolean | null {
  if (vs.some((v) => v === false)) return false;
  return vs.some((v) => v === null) ? null : true;
}

function orAny(vs: Array<boolean | null>): boolean | null {
  if (vs.some((v) => v === true)) return true;
  return vs.some((v) => v === null) ? null : false;
}

/** A captured page state: enough to decide pool-expressible signals offline. */
export interface StateView {
  url: string;
  elems: Record<string, { tag: string; label?: string; value?: unknown;
    data_test?: string; name?: string; id?: string; input_type?: string;
    href?: string; near?: string; aria_label?: string; scan?: number;
    /**
     * 捕获时的可见性（checkVisibility CSS + 非零盒，与 extraction 同口径）。
     * 缺字段 = **未捕获**（旧视图）⇒ css_visible_exists 离线不可判定，绝不当作成立。
     */
    visible?: boolean;
    /** 表单控件 disabled（只在 true 时捕获；观测字段，不参与信号语义）。 */
    disabled?: boolean;
    [k: string]: unknown }>;
}

const ATTR_ALIAS: Record<string, string> = {
  test: "data_test", "data-test": "data_test", type: "input_type",
  // S4：witness 池用 aria_label 存 `aria-label`（CSS 属性名不能带连字符做字段名）。
  "aria-label": "aria_label", "aria_label": "aria_label",
};

/**
 * Match the SUBSET of CSS that the element pool can express: `#id`, `tag`,
 * `[attr=value]`, `[attr~substr]`, `tag[attr=v]`, comma lists, and `[data-test=x]`.
 * Anything else (classes, `:nth-child`, descendant combinators) returns null —
 * induction must not pretend it can evaluate what the offline view cannot see.
 */
export function matchSelector(elems: StateView["elems"], selector: string): StateView["elems"][string][] | null {
  const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  // Pool-expressible only: `/^tag?(\[attr[=~]value\])?$/`. Classes, pseudos,
  // descendant/child combinators and `*` are NOT decidable from the pool, so the
  // caller is told `null` instead of getting a confident wrong answer.
  const PART = /^([a-z0-9]*)(?:#([^\[\]]+))?(?:\[([^\]=~]+)([=~])([^\]]*)\])?$/i;
  const ordered = Object.entries(elems).sort((a, b) => Number(a[1].scan ?? 0) - Number(b[1].scan ?? 0));
  const out: StateView["elems"][string][] = [];
  for (const part of parts) {
    const m = PART.exec(part);
    if (!m) return null;
    const [, tag, id, rawKey, op, rawVal] = m;
    if (!tag && !rawKey && !id) return null;
    const key = rawKey ? (ATTR_ALIAS[rawKey.toLowerCase()] ?? rawKey.toLowerCase()) : "";
    const val = (rawVal ?? "").replace(/^['"]|['"]$/g, "").toLowerCase();
    for (const [, e] of ordered) {
      if (tag && String(e.tag).toLowerCase() !== tag.toLowerCase()) continue;
      if (id && String(e.id ?? "") !== id) continue;
      if (key) {
        const got = String((e as Record<string, unknown>)[key] ?? "").toLowerCase();
        if (op === "=" && got !== val) continue;
        if (op === "~" && !got.includes(val)) continue;
      }
      out.push(e);
    }
  }
  return out;
}

// SIGNAL_OPS 已移至 `./signal-ops.ts`（见文件头 re-export）；值 = 算子参数个数，0 = 无参叶子。

/**
 * Normalise a signal value to its argument list.
 *
 * Runtime values may be a scalar or a 1/2-element list: `checkSignal` unwraps a
 * single-element list, plan_cli parses `op=value` into a list, and
 * 线上用例的 signal 允许裸标量；校验器把单元素列表折成标量。
 * must accept the same shapes the executor accepts (and must not call `.length`
 * on a number).
 */
export function signalArgs(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

/* ------------------------------------------------------------------ 登录墙特征（P0-E 完成语义诚实） */

/**
 * P0-E：登录墙的 **URL 特征**（单一出处，`ctx.judge.loginWall()` 预设与执行器步级 guard 共用）。
 * 词边界匹配（两侧必须是非字母数字）：`login` 命中 `/login.html?next=/`、`passport.ctrip.com`，
 * 但**不**命中 `author.html`（auth→author）、`verified.html`（verify→verified）这类同缀误报。
 */
export const LOGIN_WALL_URL_RE =
  /(^|[^a-z0-9])(login|signin|sign-in|sign_in|logon|passport|sso|auth|oauth|verify)([^a-z0-9]|$)/i;

/** 登录墙的 **标题/正文特征**词（大小写不敏感子串；正文只在短页（非内容页）上计）。 */
export const LOGIN_WALL_TEXTS = ["登录", "登入", "登陆", "login", "sign in", "登录墙"] as const;

/**
 * P0-E：`ctx.judge.loginWall()` 预设的信号形状（`any_of`，只由既有算子组成——
 * dry 可构造、checkSignal 可求值、加载期校验零改动）。语义：**当前页像一堵登录墙**
 * （URL 登录特征，或 title/h1/h2 登录文案）。用途是给否定式 done 配正向锚
 * （`all_of(judge.not(...), judge.loginWall 的否定)`）或做步级 guard 的事实底座——
 * 它是**诚实检测**信号，不是绕过登录的工具。
 */
export function loginWallSignal(): SignalSpec {
  return {
    any_of: [
      { url_contains: "/login" }, { url_contains: "/signin" }, { url_contains: "/sign-in" },
      { url_contains: "/sign_in" }, { url_contains: "/logon" }, { url_contains: "/passport" },
      { url_contains: "/sso/" }, { url_contains: "/auth" }, { url_contains: "/verify" },
      { url_contains: "passport." }, { url_contains: "sso." },
      { css_exists_text: ["title", "登录"] }, { css_exists_text: ["title", "登入"] },
      { css_exists_text: ["title", "login"] }, { css_exists_text: ["title", "sign in"] },
      { css_exists_text: ["h1", "登录"] }, { css_exists_text: ["h2", "登录"] },
      { css_exists_text: ["h1", "login"] }, { css_exists_text: ["h2", "login"] },
      { css_exists_text: ["h1", "sign in"] }, { css_exists_text: ["h2", "sign in"] },
    ],
  };
}

/**
 * P0-E：**弱信号判定**（lint 与步级 guard 共用的唯一口径）——顶层（或 all_of/any_of 的
 * 直接分支里）出现 `not(...)`，而整棵信号树在**否定之外**没有任何正向锚
 * （url_contains / css_* / manual 事实型谓词）。`not(...)` 内部的事实**不算**锚：
 * 它成立时断言的是"缺席"，不是"在场"——R11 的
 * `not(existsText(body,"8240家昆明酒店"))` 误入登录页照样成立，就是这一形状。
 * `all_of(not(…), url_contains(…))`（否定+正向锚）不算弱。
 */
export function isWeakNegativeSignal(spec: SignalSpec): boolean {
  let anchor = false;
  let directNot = false;
  const walk = (node: unknown, underNot: boolean): void => {
    if (anchor && directNot) return;
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    for (const [op, v] of Object.entries(node as Record<string, unknown>)) {
      if (op === "not") {
        if (!underNot) directNot = true;
        walk(v, true);
        continue;
      }
      if (op === "all_of" || op === "any_of") {
        if (Array.isArray(v)) for (const c of v) walk(c, underNot);
        continue;
      }
      // 正向锚 = 必须成立的 DOM/URL 事实；否定之下的事实不在此列（见上）。
      if (!underNot && (op === "url_contains" || op === "manual"
        || op.startsWith("css_"))) anchor = true;
    }
  };
  walk(spec, false);
  return directNot && !anchor;
}

/* ------------------------------------------------------ 报错形态（C3 唯一出处） */

/**
 * C3：信号**合法形态**的唯一文案出处。所有面向人/Agent 的信号报错都经
 * `signalProblemText` 取提示，不再各面手拼一份（plan-cli / session / apps check /
 * plan check / test --validate 的加载期校验都从这一处继承）。
 *
 * 规则只有两条（对应 `validateSignalSpec` 的组合分支与 arity 分支）：
 *   - 叶算子：操作数**按位置放数组**——`{op: [arg1(, arg2)]}`；对象形
 *     `{selector, text}` 不是合法形状（它会被折成长度 1 的参数列表 → arity 不匹配）。
 *   - 组合算子：`all_of`/`any_of` 收**非空数组**，`not` 收**单个对象**。
 */
export const SIGNAL_SHAPE_HINT = {
  /** 一个叶算子的合法写法（arity 决定操作数个数）。 */
  leaf: (op: string, arity: number): string =>
    `{ ${op}: ${arity <= 1 ? "[value]" : "[selector, text]"} }`,
  /** 组合算子的合法写法。 */
  compose: "{ all_of: [ {…}, … ] } / { any_of: [ {…}, … ] } / { not: {…} }（not 收单个对象）",
  /** 对象形操作数为什么非法（最常见的写错形态）。 */
  object_form: "对象形 {selector, text} 不是合法形状——操作数按位置放进数组",
} as const;

/** `--signal` 旗标面的示例串（plan-cli 的既有文案**逐字保留**）。 */
const SIGNAL_CLI_EXAMPLES = "--signal url_contains=page2 / --signal css_exists=#main / "
  + "--signal css_exists_text=#h1|Saved / --signal css_value_equals=#i|0 / --signal manual";

/** JSON 面（应用脚本 / plan 文件 / 会话请求）的示例串。 */
const SIGNAL_JSON_EXAMPLES = `{ url_contains: "page2" } / { css_exists: "#main" } / `
  + `{ css_exists_text: ["#h1", "Saved"] } / { css_value_equals: ["#i", "0"] } / { manual: true }`;

/**
 * 把 `validateSignalSpec` 的 problems 渲染成给作者的一行报错。`mode` 只决定示例串的形状
 * （`"cli"` = `--signal` 旗标写法；`"json"` = 对象/数组写法），合法形态提示两面共用。
 * cli 面只带第一条 problem（plan-cli 每次只有一个算子，既有文案逐字不变）。
 */
export function signalProblemText(problems: string[], mode: "json" | "cli"): string {
  if (mode === "cli") {
    const head = problems[0] ?? "signal is not valid";
    return `${head}；合法写法：${SIGNAL_CLI_EXAMPLES}`;
  }
  const head = problems.length ? problems.join("；") : "signal is not valid";
  return `${head}；合法写法：${SIGNAL_JSON_EXAMPLES}；组合算子：${SIGNAL_SHAPE_HINT.compose}`;
}

/* ------------------------------------------------------------------ 语法校验 */

/**
 * 一个**观察面**的语法描述：算子表 + 报错措辞。
 *
 * 语法只有一份（下面的 `validateSignalSpec`）；DOM 面与进程面的差别**只有**叶子算子表，
 * 组合算子（`all_of`/`any_of`/`not`）与递归/路径/arity 规则必须同构——否则"同一套语言"
 * 只是口号（两套校验器漂移过一次：`when` 漏校验，见 `plan.ts` 的注释）。
 */
export interface SignalGrammar {
  /** 算子 → 参数个数；**0 = 无参叶子**（DOM 的 `manual`、进程面的 `exit_ok`），值不参与校验。 */
  readonly ops: Readonly<Record<string, number>>;
  /** 报错里的面名：`signal` / `tool signal`（保留既有消息措辞，测试按原文断言）。 */
  readonly label: string;
  /** 未知算子是否附上已知算子表（进程面是给人配 CLI 的，附上更好；DOM 面保持原文）。 */
  readonly listKnown?: boolean;
}

/** 浏览器/DOM 观察面的语法（`signal` 与 `when` 共用）。 */
export const DOM_SIGNAL_GRAMMAR: SignalGrammar = { ops: SIGNAL_OPS, label: "signal", listKnown: true };

/** 报错里对「收到什么形状」的最小描述（只列键名，不打印值：信号里可能有字面量/敏感串）。 */
function describeSignalOperand(v: unknown): string {
  if (Array.isArray(v)) return `${v.length} 项数组`;
  if (typeof v === "object" && v !== null) {
    const keys = Object.keys(v as Record<string, unknown>).slice(0, 3);
    return `object {${keys.join(", ")}}`;
  }
  return typeof v === "string" ? "标量字符串" : `标量 ${typeof v}`;
}

/**
 * **唯一**的信号语法走查器。返回 problem 字符串（与 `PlanningRules.problems` 同款口径：
 * 错误是数据，由调用方汇总），不抛、不依赖浏览器。
 *
 * - 组合算子递归校验（`all_of` 空列表、`not` 不是对象、嵌套坏算子都要在**加载期**红）；
 * - 无参叶子（arity 0）只看键、不看值；
 * - `allowEmpty`：DOM 面把"空信号"的措辞放在调用方（`missing done-signal` /
 *   `must be a non-empty signal`），进程面则要求"empty signal"——两种都必须保留，所以做成选项。
 */
export function validateSignalSpec(
  spec: unknown,
  where: string,
  grammar: SignalGrammar = DOM_SIGNAL_GRAMMAR,
  opts: { allowEmpty?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      problems.push(`${at}: signal must be an object`);
      return;
    }
    const entries = Object.entries(node as Record<string, unknown>);
    if (!entries.length && !opts.allowEmpty) problems.push(`${at}: empty signal`);
    for (const [op, args] of entries) {
      if (!(op in grammar.ops)) {
        const known = grammar.listKnown ? ` (known: ${Object.keys(grammar.ops).join(", ")})` : "";
        problems.push(`${at}: unknown ${grammar.label} op '${op}'${known}`);
        continue;
      }
      if (op === "all_of" || op === "any_of") {
        if (!Array.isArray(args) || args.length === 0) {
          problems.push(`${at}: ${op} needs a non-empty list of signals`
            + ` —— 合法形态 ${SIGNAL_SHAPE_HINT.compose}`);
          continue;
        }
        args.forEach((child, i) => walk(child, `${at}.${op}[${i}]`));
        continue;
      }
      if (op === "not") {
        if (typeof args !== "object" || args === null || Array.isArray(args)) {
          problems.push(`${at}: not needs one signal —— 合法形态 ${SIGNAL_SHAPE_HINT.compose}`);
          continue;
        }
        walk(args, `${at}.not`);
        continue;
      }
      const arity = grammar.ops[op]!;
      if (arity === 0) continue;
      const operands = signalArgs(args);
      if (operands.length !== arity) {
        // C3：报错自带**合法形态**（此前只给 "needs 2 argument(s)"，对象形
        // `{selector,text}` 的作者无从知道要按位置放数组）。
        problems.push(`${at}: ${op} needs ${arity} argument(s)`
          + ` —— 合法形态 ${SIGNAL_SHAPE_HINT.leaf(op, arity)}（操作数按位置放数组；`
          + `${SIGNAL_SHAPE_HINT.object_form}），收到 ${describeSignalOperand(args)}`);
      }
      // 真空操作数（U4）：空串/纯空白不是"某个值"，而是**没有值**——`url_contains:""`
      // 对任何页面恒真，`css_exists_text:["#h1",""]` 只差 selector 存在，完成信号=门禁被掏空。
      // 数字 `0` / 布尔 `false` 是合法值，不在此列；arity 0 的叶子（manual/exit_ok）不看值。
      operands.forEach((v, i) => {
        if (typeof v !== "string" || v.trim() !== "") return;
        problems.push(`${at}: ${op} operand ${i} is an empty string`
          + ` — 空操作数把信号退化成恒真/恒假（url_contains:"" 在任何页面都成立），`
          + `完成信号=门禁被掏空；换成真实值，如 url_contains:"page2"、`
          + `css_value_equals:["#i","0"]（0 / false 本身是合法值）`);
      });
    }
  };
  walk(spec, where);
  return problems;
}
