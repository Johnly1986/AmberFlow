/**
 * L2 `ctx` 的**原语参数校验面**（从 ctx.ts 拆出，F1）——真实 / dry / replay 共用同一份。
 *
 * 拆出的理由：这些校验函数不依赖 `createCtx` 的闭包（纯输入→抛错/通过），却占了 ctx.ts
 * 约 400 行。集中到此处后，ctx-dry 直接 import 同一份实现（消重复），且任何一面都能在
 * dry 期拦住非法声明（不留到真跑）。
 */
import path from "node:path";
import { REPO } from "../support/paths.ts";
import { validateCommands } from "../engine/actions.ts";
import type { CommandDecl, TargetDecl } from "./kit.ts";
import { StopError, type StepRequest, type SwitchTabMatch } from "./ctx-types.ts";
import { listAppAdapters, requireAppAdapter } from "./app-adapters.ts";

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 相对仓库路径 → `file://`（dry/replay 也用这一份，host/URL 语义才同口径）。 */
export function resolveCtxUrl(u: string): string {
  if (/^(https?|file):/i.test(u)) return u;
  // 与 `app-runner.startUrl` 同一口径：用 `new URL("file://" + path)` 而不是 `pathToFileURL`，
  // 因为后者会把 `?sn=CAM-1001` 当成文件名百分号编码掉（实测 ERR_FILE_NOT_FOUND）。
  return new URL(`file://${path.resolve(REPO, u)}`).href;
}

export function assertAct(req: StepRequest): void {
  if (req === null || typeof req !== "object") throw new StopError("config_error", "ctx.step needs a request object");
  if (req.done === undefined || req.done === null || !isObj(req.done) || !Object.keys(req.done).length) {
    throw new StopError("config_error", "ctx.step: done signal is required (completion only comes from the evidence surface)");
  }
  // act 省略 = 让引擎决策目标；只有显式给了 act 才校验它的形状（真正形状由 targetOptions/执行器校验）。
  // F2：newTab 声明形状（对象；urlContains 若给必须是非空字符串）——dry 与真实面同文案。
  if (req.newTab !== undefined && req.newTab !== null) {
    if (typeof req.newTab !== "object" || Array.isArray(req.newTab)) {
      throw new StopError("config_error", "ctx.step: newTab must be an object like { urlContains: \"p2\" }");
    }
    const uc = (req.newTab as Record<string, unknown>)["urlContains"];
    if (uc !== undefined && (typeof uc !== "string" || !uc.trim())) {
      throw new StopError("config_error", "ctx.step: newTab.urlContains must be a non-empty string (case-insensitive URL substring used for tab adoption/dedup)");
    }
  }
}

/**
 * A6 walk 的同页判定：origin+path 相同即同页（query/hash 忽略）。
 * 为什么忽略 query：作者惯例里「每步起点 URL」常写成当前页去 query 的重锚
 * （如 Maps 的 `cleanUrl(await ctx.url())`）——walk 把它折叠成缺省「当前页」语义（不重导航，
 * SPA 状态跨步保留）；而真正换页（不同 origin/path）的显式 url 仍然导航，显式意图优先。
 * 解析不了 URL 的原始串按字面相等兜底。
 */
export function samePage(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host && ua.pathname === ub.pathname;
  } catch {
    return a === b;
  }
}

/**
 * 导航纪律（`meta.policy.navigation:"entry-only"`）的**同 URL 重试**判定：
 * origin+path+query 全等（hash 忽略——锚点滚动不是换页）。解析不了的原始串按
 * 去 hash 字面相等兜底。与 walk 的 `samePage`（只比 origin+path）口径不同：
 * gate 管"重试同址"，query 变了就是新地址（拼参数直达正是要拦的行为）。
 */
export function sameNavTarget(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host
      && ua.pathname === ub.pathname && ua.search === ub.search;
  } catch {
    const bare = (s: string) => { const i = s.indexOf("#"); return i < 0 ? s : s.slice(0, i); };
    return bare(a) === bare(b);
  }
}

/**
 * P0-B：entry-only 的**声明页放行**判定。两边 URL 各经 `new URL(...).href` 归一后
 * **全等**（含 query；不做尾斜杠/case/协议升级等特判）⇒ 目标是一个已声明入口页。
 * 解析不了的原始串按字面相等兜底（与 `sameNavTarget` 同一条纪律）。
 */
export function sameDeclaredPageHref(target: string, declared: readonly string[]): boolean {
  if (!declared.length) return false;
  const hrefOf = (u: string): string => {
    try { return new URL(u).href; } catch { return u; }
  };
  const h = hrefOf(target);
  for (const d of declared) if (hrefOf(d) === h) return true;
  return false;
}

/**
 * 命令闭集补 id：`ctx.command(...)` 不强制作者写 id，但执行器的闭集要求每个选项有名字。
 * 缺省补「序号 + op」的稳定 id（不随运行变化；重放/forbidden 语义仍稳定）。
 */
export function normalizeCommandIds(commands: CommandDecl[]): CommandDecl[] {
  return commands.map((c, i) => {
    const rec = c as unknown as Record<string, unknown>;
    if (typeof rec["id"] === "string" && String(rec["id"]).trim()) return c;
    return { ...(c as object), id: `cmd${i + 1}_${String(rec["op"] ?? "op")}` } as CommandDecl;
  });
}

/**
 * `ctx.run` **声明形式**允许的顶层键（唯一出处；dry/`apps check` 与运行期共用）。
 * 以实现实际消费者为准：
 *   - `adapter`/`source`/`args`/`dryRunArgs`（cli 形式，`source`/`args` 也供 ssh/stdio 的
 *     适配器校验读取）；
 *   - `stdio`/`ssh`（声明块；块内未知键由各自 adapter 校验）；
 *   - `desc`/`id`/`idempotent`/`retries`/`returns`/`done`；
 *   - `signal` 只为给出「journey 词写进了 flow」的显式改法（不是合法字段）；
 *   - `dangerous`：ssh/stdio 的 adapter.validateStep 会读它并给出「尚未实现」的结构化拒绝。
 * 没有 `cli`：cli 形式就是 `source`+`args`+`dryRunArgs`，没有 `cli: {...}` 块消费者——
 * 写了它等于写了没用，按未知键拒绝（不静默忽略）。
 */
export const DECLARED_RUN_KEYS = [
  "adapter", "source", "args", "dryRunArgs", "desc", "id", "idempotent", "retries",
  "returns", "done", "stdio", "ssh", "signal", "dangerous",
] as const;

/**
 * `ctx.run` 声明形式的**共享校验**（T7）：未知顶层键、`signal`/`done` 冲突、done 必需。
 * dry/`apps check` 与运行期念同一段文案；未知键点名 unknown + known，绝不静默忽略。
 */
export function declaredRunProblems(step: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const known = DECLARED_RUN_KEYS as readonly string[];
  const unknown = Object.keys(step).filter((k) => !known.includes(k));
  if (unknown.length) {
    problems.push(`ctx.run: unknown declaration key(s) ${unknown.map((k) => JSON.stringify(k)).join(", ")}`
      + ` (known: ${DECLARED_RUN_KEYS.join(", ")})`);
  }
  const straySignal = step["signal"];
  if (straySignal !== undefined && step["done"] === undefined) {
    problems.push("ctx.run: flow 的声明形式用 done（journey 用 signal）；把 signal 改名为 done，"
      + "例如 { stdio: {...}, done: { stdout_contains: \"ok\" } }");
  }
  if (straySignal !== undefined && step["done"] !== undefined) {
    problems.push("ctx.run: 声明块同时写了 signal 和 done——flow 的声明形式只认 done（signal 是 journey 的词）；"
      + "删掉 signal，或把它改名为 done");
  }
  if (step["done"] === undefined || step["done"] === null) {
    problems.push("ctx.run: done signal is required (completion is the process observation)");
  } else if (typeof step["done"] !== "object" || Array.isArray(step["done"])) {
    problems.push("ctx.run: done signal must be an object");
  }
  return problems;
}

/* ---- A3 原语参数校验（真实/dry/replay 共用同一份声明面；校验失败 = config_error） ---- */

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

const SWITCH_TAB_MATCH_KEYS = new Set(["index", "urlContains", "titleContains"]);

/**
 * A5：`ctx.switchTab` 的声明面校验（真实/dry/replay 共用同一份；坏 match 在 dry 期也红）。
 * 三条纪律：只认三个键（拼错的 `url`/`title` 不静默忽略）、至少给一个条件（否则等于
 * "随便挑一个"，与显式原语的初衷相反）、index 是 0-based 非负整数。
 */
export function validateSwitchTabMatch(match: unknown): void {
  if (!isObj(match)) {
    throw new StopError("config_error",
      "ctx.switchTab: match must be an object like { index } | { urlContains } | { titleContains }");
  }
  const unknownKeys = Object.keys(match).filter((k) => !SWITCH_TAB_MATCH_KEYS.has(k));
  if (unknownKeys.length) {
    throw new StopError("config_error",
      `ctx.switchTab: unknown match key(s) ${unknownKeys.map((k) => JSON.stringify(k)).join(", ")} `
      + "(allowed: index, urlContains, titleContains)");
  }
  const { index, urlContains, titleContains } = match as Record<string, unknown>;
  if (index !== undefined && (typeof index !== "number" || !Number.isInteger(index) || index < 0)) {
    throw new StopError("config_error",
      `ctx.switchTab: match.index must be a 0-based integer (got ${JSON.stringify(index)})`);
  }
  if (urlContains !== undefined && !isNonEmptyString(urlContains)) {
    throw new StopError("config_error",
      `ctx.switchTab: match.urlContains must be a non-empty string (got ${JSON.stringify(urlContains)})`);
  }
  if (titleContains !== undefined && !isNonEmptyString(titleContains)) {
    throw new StopError("config_error",
      `ctx.switchTab: match.titleContains must be a non-empty string (got ${JSON.stringify(titleContains)})`);
  }
  if (index === undefined && urlContains === undefined && titleContains === undefined) {
    throw new StopError("config_error",
      "ctx.switchTab: match needs at least one of index | urlContains | titleContains "
      + "(refusing to pick a tab implicitly)");
  }
}

/** A5 匹配语义（真实/dry 共用）：多条件 AND；url/title 子串大小写不敏感。 */
export function switchTabMatches(
  tab: { index: number; url: string; title: string }, match: SwitchTabMatch,
): boolean {
  if (match.index !== undefined && tab.index !== match.index) return false;
  if (match.urlContains !== undefined && !tab.url.toLowerCase().includes(match.urlContains.toLowerCase())) return false;
  if (match.titleContains !== undefined && !tab.title.toLowerCase().includes(match.titleContains.toLowerCase())) return false;
  return true;
}

/** A5：错误面里列出当前 tabs（index/url/title/active）——作者不用再猜为什么没匹配上。 */
export function describeTabs(
  tabs: ReadonlyArray<{ index: number; url: string; title: string; active?: boolean }>,
): string {
  if (tabs.length === 0) return "(none)";
  return tabs.map((t) => `#${t.index} url=${JSON.stringify(t.url)} title=${JSON.stringify(t.title)}`
    + (t.active === true ? " [active]" : "")).join("; ");
}

/**
 * F1：`ctx.scrollList` 的**合成滚动目标**闭集（大小写不敏感）。这些名字不进元素池、
 * 不占池位，也不做 hint 匹配：统一解析为主滚动器 `document.scrollingElement`
 * （兜底 body → documentElement）。容器目标（任何其他 hint）走既有池外回退解析，
 * 行为逐字节不变。
 */
export const SCROLL_SYNTHETIC_TARGETS = ["document", "body", "html", "window"] as const;

export function isSyntheticScrollTarget(target: string): boolean {
  return (SCROLL_SYNTHETIC_TARGETS as readonly string[]).includes(target.trim().toLowerCase());
}

/** `ctx.scrollList` 的参数声明。非法值**在这里**红（dry 期也能拦住，不留到真跑）。 */
export function validateScrollListRequest(target: unknown, opts: unknown): void {
  if (!isNonEmptyString(target)) {
    throw new StopError("config_error", "ctx.scrollList: target must be a non-empty hint string (e.g. \"Feed list\" or \"#feed\", or a synthetic \"document\"|\"body\"|\"html\"|\"window\")");
  }
  if (opts === undefined) return;
  if (!isObj(opts)) throw new StopError("config_error", "ctx.scrollList: opts must be an object");
  const to = opts["to"];
  if (to !== undefined && to !== "bottom" && to !== "top" && to !== "page") {
    throw new StopError("config_error", `ctx.scrollList: opts.to must be one of bottom | top | page (got ${JSON.stringify(to)})`);
  }
  const by = opts["by"];
  if (by !== undefined && (typeof by !== "number" || !Number.isFinite(by) || by === 0)) {
    throw new StopError("config_error", "ctx.scrollList: opts.by must be a non-zero finite number of pixels");
  }
  const settle = opts["settleMs"];
  if (settle !== undefined && (typeof settle !== "number" || !Number.isFinite(settle) || settle < 0)) {
    throw new StopError("config_error", "ctx.scrollList: opts.settleMs must be a number >= 0");
  }
}

/** `ctx.expand` 的参数声明（count 形状/上限都校验；未知形状在 dry 期红）。 */
export function validateExpandRequest(target: unknown, opts: unknown): void {
  if (!isNonEmptyString(target)) {
    throw new StopError("config_error", "ctx.expand: target must be a non-empty hint string (the load-more/expand control)");
  }
  if (!isObj(opts)) throw new StopError("config_error", "ctx.expand: opts must be an object like { count: { rows, fields? } }");
  const count = opts["count"];
  if (!isObj(count)) {
    // S0：首句点破**类型**（以前只说形状，number/string 这类错要读到句尾才反应过来）。
    const got = count === null ? "null" : Array.isArray(count) ? "array" : typeof count;
    throw new StopError("config_error",
      `ctx.expand: opts.count must be an object { rows: selector } | { selector } — got ${got}`);
  }
  const hasRows = count["rows"] !== undefined;
  const hasSelector = count["selector"] !== undefined;
  if (hasRows === hasSelector) {
    throw new StopError("config_error", "ctx.expand: opts.count must have EXACTLY one of rows | selector (got both or neither)");
  }
  if (hasRows && !isNonEmptyString(count["rows"])) {
    throw new StopError("config_error", "ctx.expand: opts.count.rows must be a non-empty selector string");
  }
  if (hasSelector && !isNonEmptyString(count["selector"])) {
    throw new StopError("config_error", "ctx.expand: opts.count.selector must be a non-empty selector string");
  }
  if (hasRows && count["fields"] !== undefined) {
    if (!isObj(count["fields"])) throw new StopError("config_error", "ctx.expand: opts.count.fields must be an object of field -> selector");
    for (const [k, v] of Object.entries(count["fields"])) {
      if (!isNonEmptyString(k) || !isNonEmptyString(v)) {
        throw new StopError("config_error", `ctx.expand: opts.count.fields[${JSON.stringify(k)}] must map a field name to a non-empty selector`);
      }
    }
  }
  for (const [key, min, max] of [["maxClicks", 1, 500], ["stableRounds", 1, 20]] as const) {
    const v = opts[key];
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)) {
      throw new StopError("config_error", `ctx.expand: opts.${key} must be an integer in [${min}, ${max}] (got ${JSON.stringify(v)})`);
    }
  }
  for (const [key, max] of [["settleMs", 60_000], ["timeoutMs", 600_000]] as const) {
    const v = opts[key];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max)) {
      throw new StopError("config_error", `ctx.expand: opts.${key} must be a number in [0, ${max}] (got ${JSON.stringify(v)})`);
    }
  }
}

/** `ctx.setRange` 的参数声明：value 二选一、数值有限、percent 在 [0,100]。 */
export function validateSetRangeRequest(target: unknown, value: unknown, opts: unknown): void {
  if (!isNonEmptyString(target)) {
    throw new StopError("config_error", "ctx.setRange: target must be a non-empty hint string (the range/slider control)");
  }
  if (!isObj(value)) throw new StopError("config_error", "ctx.setRange: value must be { value: number } or { percent: 0..100 }");
  const hasValue = value["value"] !== undefined;
  const hasPercent = value["percent"] !== undefined;
  if (hasValue === hasPercent) {
    throw new StopError("config_error", "ctx.setRange: value must have EXACTLY one of {value} | {percent} (got both or neither)");
  }
  if (hasValue) {
    const v = value["value"];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new StopError("config_error", "ctx.setRange: value.value must be a finite number");
  } else {
    const p = value["percent"];
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 100) {
      throw new StopError("config_error", "ctx.setRange: value.percent must be a number in [0, 100]");
    }
  }
  if (opts === undefined) return;
  if (!isObj(opts)) throw new StopError("config_error", "ctx.setRange: opts must be an object");
  const tol = opts["tolerance"];
  if (tol !== undefined && (typeof tol !== "number" || !Number.isFinite(tol) || tol < 0)) {
    throw new StopError("config_error", "ctx.setRange: opts.tolerance must be a number >= 0");
  }
  const timeout = opts["timeoutMs"];
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 1 || timeout > 600_000)) {
    throw new StopError("config_error", "ctx.setRange: opts.timeoutMs must be a number in [1, 600000]");
  }
}

/**
 * S3 `ctx.collect` 的参数声明。真实/dry/replay 三面共用；非法值在**这里**红（dry 期也拦）。
 * `until` 二选一：`stableRounds`（1..20）或 `maxRows`（1..5000）。
 */
export function validateCollectRequest(req: unknown): void {
  const where = "ctx.collect";
  if (!isObj(req)) {
    throw new StopError("config_error", `${where}: request must be an object { row, fields?, until?, dedupe?, maxRounds? }`);
  }
  if (!isNonEmptyString(req["row"])) {
    throw new StopError("config_error", `${where}: row must be a non-empty CSS row selector (e.g. "li.item")`);
  }
  const fields = req["fields"];
  if (fields !== undefined) {
    if (!isObj(fields)) throw new StopError("config_error", `${where}: fields must be an object of field -> selector`);
    for (const [k, v] of Object.entries(fields)) {
      if (!isNonEmptyString(k) || !isNonEmptyString(v)) {
        throw new StopError("config_error", `${where}: fields[${JSON.stringify(k)}] must map a field name to a non-empty selector`);
      }
    }
  }
  const until = req["until"];
  if (until !== undefined) {
    if (!isObj(until)) {
      throw new StopError("config_error", `${where}: until must be one of { stableRounds } | { maxRows }`);
    }
    const hasStable = until["stableRounds"] !== undefined;
    const hasMax = until["maxRows"] !== undefined;
    if (hasStable === hasMax) {
      throw new StopError("config_error", `${where}: until must have EXACTLY one of stableRounds | maxRows (got both or neither)`);
    }
    if (hasStable) {
      const v = until["stableRounds"];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 20) {
        throw new StopError("config_error", `${where}: until.stableRounds must be an integer in [1, 20] (got ${JSON.stringify(v)})`);
      }
    } else {
      const v = until["maxRows"];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5000) {
        throw new StopError("config_error", `${where}: until.maxRows must be an integer in [1, 5000] (got ${JSON.stringify(v)})`);
      }
    }
  }
  const dedupe = req["dedupe"];
  if (dedupe !== undefined && typeof dedupe !== "boolean") {
    throw new StopError("config_error", `${where}: dedupe must be a boolean`);
  }
  const maxRounds = req["maxRounds"];
  if (maxRounds !== undefined && (typeof maxRounds !== "number" || !Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 200)) {
    throw new StopError("config_error", `${where}: maxRounds must be an integer in [1, 200] (got ${JSON.stringify(maxRounds)})`);
  }
}

/**
 * C1：`ctx.extract` 的第二参（仅 `{ offset? }`）——真实/dry/replay 共用同一份文案。
 *
 * 三条纪律（与 `ctx.observe` 的选项面同风格）：
 *   - `offset` **只认第二参**：写成 inline spec 键（`{ rows, fields, offset }`）= 结构化
 *     `config_error` 并指路（spec 是声明，offset 是这一次调用的读取位置，两者不混）；
 *   - 未知第二参键不静默忽略（allowed: offset）；
 *   - 整数 0..10000；负数/小数/字符串/越界都是 `config_error`（绝不自己 clamp —— 分页起点
 *     被悄悄改掉会让「续页不重不漏」变成假话）。
 *
 * @returns 规范化后的 offset（缺省 0）。
 */
export function validateExtractOptions(nameOrSpec: unknown, opts: unknown): number {
  if (isObj(nameOrSpec) && nameOrSpec["offset"] !== undefined) {
    throw new StopError("config_error",
      "ctx.extract: offset is the SECOND argument, not a spec key — call ctx.extract(spec, { offset }) "
      + "(inline spec keys are rows/fields/maxItems)");
  }
  if (opts === undefined) return 0;
  if (!isObj(opts)) {
    throw new StopError("config_error", "ctx.extract: opts must be an object like { offset }");
  }
  const unknown = Object.keys(opts).filter((k) => k !== "offset");
  if (unknown.length) {
    throw new StopError("config_error",
      `ctx.extract: unknown opts key(s) ${unknown.map((k) => JSON.stringify(k)).join(", ")} (allowed: offset)`);
  }
  const offset = opts["offset"];
  if (offset === undefined) return 0;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > 10_000) {
    throw new StopError("config_error",
      `ctx.extract: opts.offset must be an integer in [0, 10000] (got ${JSON.stringify(offset)})`);
  }
  return offset;
}

/** 把 `StepRequest` 的目标声明摊成 `RunOptions` 的字段。 */
export function targetOptions(act: TargetDecl | CommandDecl[]): {
  targetHint?: string | null; targetHints?: string[] | null; commands?: CommandDecl[] | null;
} {
  if (Array.isArray(act)) {
    for (const [i, c] of act.entries()) {
      if (!isObj(c) || typeof c.op !== "string" || !c.op) {
        throw new StopError("config_error", `ctx.step: act[${i}] is not a command (needs {op, ...}; build it with kit.command())`);
      }
    }
    const commands = normalizeCommandIds(act);
    // 与 dry 面**同一份**命令声明校验（`engine/actions.validateCommands`）：未知 op（含 hover 这类
    // 新原语的拼写错误）/ 重复 id / 缺 target / 给不支持 value 的 op 带 value，都在动作前红。
    const problems: string[] = [];
    validateCommands(commands, "ctx.step", problems);
    if (problems.length) throw new StopError("config_error", problems.join("；"));
    return { commands };
  }
  if (!isObj(act) || (act.kind !== "hint" && act.kind !== "hints")) {
    throw new StopError("config_error", "ctx.step: act must be kit.hint()/kit.hints() or an array of kit.command(...)");
  }
  if (act.kind === "hint") {
    if (typeof act.hint !== "string" || !act.hint.trim()) throw new StopError("config_error", "ctx.step: hint must be a non-empty string");
    return { targetHint: act.hint };
  }
  if (!Array.isArray(act.hints) || !act.hints.length || act.hints.some((h) => typeof h !== "string" || !h.trim())) {
    throw new StopError("config_error", "ctx.step: hints must be a non-empty list of strings");
  }
  return { targetHints: act.hints };
}

/**
 * `ctx.waitForTarget` 的声明形状校验（C2）：hint 非空字符串、visible 只认布尔。
 * 真实面（ctx.ts）与 dry 面（ctx-dry.ts）同一份——否则 `apps check` 会放过一个
 * 真实运行必然 `config_error` 的脚本。
 */
export function validateWaitForTargetArgs(hint: unknown, opts: { visible?: unknown }): void {
  if (typeof hint !== "string" || !hint.trim()) {
    throw new StopError("config_error", "ctx.waitForTarget: hint must be a non-empty string");
  }
  if (opts.visible !== undefined && typeof opts.visible !== "boolean") {
    throw new StopError("config_error", "ctx.waitForTarget: visible must be a boolean");
  }
}

/** `ctx.waitFor` / `ctx.waitForTarget` 共用的轮询参数缺省（至少查一次；最后一次 sleep 裁到 deadline）。 */
export function waitTiming(opts: { timeoutMs?: unknown; pollMs?: unknown }): { timeoutMs: number; pollMs: number } {
  return {
    timeoutMs: Math.max(0, Number(opts.timeoutMs ?? 15_000)),
    pollMs: Math.max(1, Number(opts.pollMs ?? 200)),
  };
}

/**
 * `ctx.run` 声明形式的适配器解析与可用性校验（T7）：声明面声明过 `declaredRunProblems`
 * 之后，这里统一解析 adapter（显式 > ssh 键 > stdio 键 > cli 缺省）、拒绝 web、点名未知
 * 适配器。真实面（ctx.ts）与 dry 面（ctx-dry.ts）同一份——文案逐字一致，check 期与
 * 运行期红同一句话。
 *
 * @returns 解析出的适配器名。
 */
export function resolveRunAdapter(step: Record<string, unknown>): string {
  const adapter = typeof step["adapter"] === "string" && step["adapter"]
    ? step["adapter"]
    : step["ssh"] !== undefined ? "ssh" : step["stdio"] !== undefined ? "stdio" : "cli";
  if (adapter === "web") {
    throw new StopError("config_error", "ctx.run: the web adapter is not a process step; use ctx.step() for browser steps");
  }
  try { requireAppAdapter(adapter); } catch {
    throw new StopError("config_error", `ctx.run: unknown app adapter ${JSON.stringify(adapter)} (known: ${listAppAdapters().join(", ")})`);
  }
  return adapter;
}
