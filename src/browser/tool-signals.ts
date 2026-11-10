/**
 * 进程观察面的信号语言 —— 命令行工具当**动作腿**时的"完成真值"。
 *
 * 浏览器面的完成真值是 DOM（`src/engine/signals.ts` 的五个叶子 + 组合）。命令行工具没有 DOM，
 * 它的可验证事实是：**退出码、stdout、stderr、以及它写下的产物文件**。这里只是把同一套
 * 形状（叶子 + `all_of`/`any_of`/`not`）长在另一个观察面上，而**不是**新开一套语言：
 *   - 组合算子语义完全一致（递归、不能比叶子更宽松）；
 *   - 叶子同样是"可验证的事实"，不是"模型说完成了"；
 *   - 加载期校验和浏览器面一样严格（未知算子/参数个数）。
 *
 * 为什么叶子是这几个（每个都有真实消费者，见 既有应用 与 历史回归）：
 *   `exit_ok`            —— 退出码在 source 的 `exit_ok` 白名单里（最常用的"跑成功了"）
 *   `exit_code_equals`   —— 精确退出码（`grep`/`diff` 这类语义化退出码）
 *   `stdout_contains`    —— 产物里必须出现的事实
 *   `stderr_contains`    —— 失败原因/提示（"要登录"这类）
 *   `stdout_matches`     —— 形状断言（正则）
 *   `json_path_equals`   —— 结构化产物里的一个字段（复用数据源的路径语言；
 *                           支持 RFC 9535 子集：点路径 + 方括号下标，`$` 前缀可选）
 *   `file_exists` / `file_absent` —— 副作用落地了吗（不可逆动作的验收）
 */
import fs from "node:fs";
import path from "node:path";
import type { CliObservation } from "../data/datasource.ts";
import { REPO } from "../support/paths.ts";
import { resolve } from "../data/datasource.ts";
import { validateSignalSpec, type SignalGrammar } from "../engine/signals.ts";

export type ToolSignal = Record<string, unknown>;

/** 叶子 + 组合算子（`exit_ok` 无参，与浏览器面的 `manual` 同型）。 */
export const TOOL_SIGNAL_OPS: Readonly<Record<string, number>> = {
  all_of: 1,
  any_of: 1,
  not: 1,
  exit_ok: 0,
  exit_code_equals: 1,
  stdout_contains: 1,
  stderr_contains: 1,
  stdout_matches: 1,
  json_path_equals: 2,
  file_exists: 1,
  file_absent: 1,
};

/**
 * 进程观察面的语法描述。**组合算子与递归规则不在这里**——它们来自
 * `signals.validateSignalSpec` 这唯一一份实现；本文件只声明"这个面的叶子有哪些"。
 */
export const TOOL_SIGNAL_GRAMMAR: SignalGrammar = {
  ops: TOOL_SIGNAL_OPS,
  label: "tool signal",
  listKnown: true,
};

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** `file_*` 的路径：绝对路径照用，相对路径按仓库根解析（与 start_url 同口径）。 */
export function artifactPath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(REPO, p);
}

/**
 * 加载期校验：未知算子、参数个数、组合递归。**走的是与浏览器面同一个走查器**
 * （`signals.validateSignalSpec`），本文件只提供叶子算子表——所以"两套语法同构"
 * 不再是靠人成对改的纪律，而是构造性质。
 */
export function validateToolSignal(spec: ToolSignal, where = "signal"): string[] {
  return [
    ...validateSignalSpec(spec, where, TOOL_SIGNAL_GRAMMAR),
    ...validateToolSignalPayload(spec, where),
  ];
}

/** 非空字符串（路径/匹配串这类载荷不接受空串——空串在运行期只会静默 false）。 */
const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * 叶子载荷的**加载期**校验（T7）：算子/参数个数只说明"形状对"，`jsonPath("", "x")`
 * 这类坏载荷必须在这里就红（结构化 config_error），不能留到运行期静默 false。
 *
 * 校验面：
 *   `json_path_equals` path/want 非空字符串；`exit_code_equals` 整数；
 *   `stdout_contains`/`stderr_contains` 非空字符串；`stdout_matches` 非空且正则可编译；
 *   `file_exists`/`file_absent` 非空字符串。`exit_ok` 无参（与浏览器面 `manual` 同型），
 *   不校验其布尔值——`{exit_ok: true}` 是既有文档写法。
 */
export function validateToolSignalPayload(spec: ToolSignal, where: string): string[] {
  const problems: string[] = [];
  if (typeof spec !== "object" || spec === null) return problems;
  for (const [op, raw] of Object.entries(spec)) {
    if (op === "all_of" || op === "any_of") {
      if (Array.isArray(raw)) {
        raw.forEach((child, i) => problems.push(...validateToolSignalPayload(child as ToolSignal, `${where}.${op}[${i}]`)));
      }
      continue;
    }
    if (op === "not") {
      problems.push(...validateToolSignalPayload(raw as ToolSignal, `${where}.not`));
      continue;
    }
    const args = Array.isArray(raw) ? raw : [raw];
    const at = `${where}.${op}`;
    // 空串/纯空白由 `validateSignalSpec` 的 U4 真空校验统一拦（信号语法面），这里只补
    // **类型与可编译性**——不重复报同一件事。
    if (op === "json_path_equals") {
      const [path, want] = args;
      if (typeof path !== "string") {
        problems.push(`${at}: path must be a string (JSONPath subset: dot path + [index], optional $ prefix; got ${JSON.stringify(path)})`);
      }
      if (typeof want !== "string") {
        problems.push(`${at}: want must be a string (got ${JSON.stringify(want)})`);
      }
    } else if (op === "exit_code_equals") {
      if (typeof args[0] !== "number" || !Number.isInteger(args[0])) {
        problems.push(`${at}: exit code must be an integer (got ${JSON.stringify(args[0])})`);
      }
    } else if (op === "stdout_contains" || op === "stderr_contains") {
      if (typeof args[0] !== "string") {
        problems.push(`${at}: must be a string (got ${JSON.stringify(args[0])})`);
      }
    } else if (op === "stdout_matches") {
      if (typeof args[0] !== "string") {
        problems.push(`${at}: regex must be a string (got ${JSON.stringify(args[0])})`);
      } else {
        try { new RegExp(args[0], "s"); } catch (e) {
          problems.push(`${at}: invalid regex (${e instanceof Error ? e.message : String(e)})`);
        }
      }
    } else if (op === "file_exists" || op === "file_absent") {
      if (typeof args[0] !== "string") {
        problems.push(`${at}: path must be a string (got ${JSON.stringify(args[0])})`);
      }
    }
  }
  return problems;
}

/**
 * JSONPath 子集归一（RFC 9535 的**点路径 + 方括号下标**，不新增表达式语法）：
 *   `$`     → 根（空路径）
 *   `$.a.b` → `a.b`（去掉 `$.`）
 *   `$[0]`  → `[0]`（去掉 `$`）
 * 不以 `$` 开头的路径**原样返回**——旧路径行为逐字节不变。其它 `$...` 形状
 * （`$..a` / `$['a']` / `$a`）保持原样，交给既有解析器如实失败（不发明语法）。
 */
export function normalizeJsonPath(p: string): string {
  if (typeof p !== "string" || !p.startsWith("$")) return p;
  const rest = p.slice(1);
  if (rest === "") return "";
  // `$.` 后必须是名字（`$..a` 是递归下降，不在本子集里——保持原样交给解析器如实失败）。
  if (rest.startsWith(".") && rest.length > 1 && rest[1] !== ".") return rest.slice(1);
  if (rest.startsWith("[")) return rest;
  return p;
}

/** 值的运行时类型名（诊断用；null 不冒充 object，数组不冒充 object）。 */
function valueType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** 值摘要（≤120 字符；大对象不整段进 reason——secretSlots 掩码由产物面既有 scrub 统一处理）。 */
function valueSummary(v: unknown, cap = 120): string {
  let text: string;
  if (v === undefined) text = "undefined";
  else {
    try {
      const j = JSON.stringify(v);
      text = j === undefined ? String(v) : j;
    } catch {
      text = String(v);
    }
  }
  return text.length <= cap ? text : `${text.slice(0, cap)}… (${text.length} chars)`;
}

/**
 * `json_path_equals` 的失败诊断：path、归一后的解析路径、实际类型与值摘要。
 * 成立返回 null（只在信号不成立时调用）。
 */
function explainJsonPathEquals(obs: CliObservation, rawPath: string, want: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(obs.stdout);
  } catch {
    return `json_path_equals ${JSON.stringify(rawPath)}: stdout is not valid JSON — cannot resolve the path`;
  }
  const path = normalizeJsonPath(rawPath);
  const got = resolve(parsed, path);
  if (s(got) === s(want)) return null;
  const normalized = path === rawPath ? "" : ` (normalized to ${JSON.stringify(path)})`;
  const actual = got === null
    ? "null (path missing or JSON null)"
    : `${valueType(got)} ${valueSummary(got)}`;
  return `json_path_equals ${JSON.stringify(rawPath)} = ${JSON.stringify(want)} not held: path${normalized} `
    + `resolved to ${actual}`;
}

/**
 * 把**不成立**的工具信号翻译成人读诊断（T4/T6）：每个失败叶子一条观察事实，
 * path/类型/值摘要与 exit/stdout/stderr 证据都在里面；组合算子只解释失败的分支。
 * 只在 `checkToolSignal` 返回 false 后调用（成立时没有诊断可写）。
 */
export function explainToolSignal(obs: CliObservation, spec: ToolSignal): string[] {
  if (typeof spec !== "object" || spec === null) return ["tool signal is not an object"];
  const out: string[] = [];
  for (const [op, raw] of Object.entries(spec)) {
    const args = Array.isArray(raw) ? raw : [raw];
    switch (op) {
      case "all_of":
        if (!Array.isArray(raw)) out.push("all_of: not a list");
        else for (const child of raw) {
          if (!checkToolSignal(obs, child as ToolSignal)) out.push(...explainToolSignal(obs, child as ToolSignal));
        }
        break;
      case "any_of":
        if (!Array.isArray(raw)) out.push("any_of: not a list");
        else if (!raw.some((x) => checkToolSignal(obs, x as ToolSignal))) {
          out.push(`any_of: none of ${raw.length} branch(es) held`);
          for (const child of raw.slice(0, 4)) {
            if (!checkToolSignal(obs, child as ToolSignal)) out.push(...explainToolSignal(obs, child as ToolSignal));
          }
        }
        break;
      case "not":
        if (checkToolSignal(obs, raw as ToolSignal)) out.push("not: the negated signal held");
        break;
      case "exit_ok":
        if (!obs.ok) out.push(`exit_ok: exit ${obs.code} is not on the success list`);
        break;
      case "exit_code_equals":
        if (obs.code !== Number(args[0])) out.push(`exit_code_equals ${JSON.stringify(args[0])}: got exit ${obs.code}`);
        break;
      case "stdout_contains":
        if (!obs.stdout.includes(s(args[0]))) out.push(`stdout_contains ${JSON.stringify(args[0])}: not found in ${obs.stdout.length}-char stdout`);
        break;
      case "stderr_contains":
        if (!obs.stderr.includes(s(args[0]))) out.push(`stderr_contains ${JSON.stringify(args[0])}: not found in ${obs.stderr.length}-char stderr`);
        break;
      case "stdout_matches":
        try {
          if (!new RegExp(s(args[0]), "s").test(obs.stdout)) out.push(`stdout_matches /${s(args[0])}/: no match in ${obs.stdout.length}-char stdout`);
        } catch {
          out.push(`stdout_matches ${JSON.stringify(args[0])}: invalid regex`);
        }
        break;
      case "json_path_equals": {
        const detail = explainJsonPathEquals(obs, s(args[0]), s(args[1]));
        if (detail !== null) out.push(detail);
        break;
      }
      case "file_exists":
        try {
          if (!fs.statSync(artifactPath(s(args[0]))).isFile()) out.push(`file_exists ${JSON.stringify(args[0])}: not a file`);
        } catch {
          out.push(`file_exists ${JSON.stringify(args[0])}: not found`);
        }
        break;
      case "file_absent":
        try {
          fs.statSync(artifactPath(s(args[0])));
          out.push(`file_absent ${JSON.stringify(args[0])}: the file exists`);
        } catch {
          /* 不存在：叶子成立，无需诊断 */
        }
        break;
      default:
        out.push(`${op}: unknown tool-signal operator`);
        break;
    }
  }
  return out;
}

/** 求值：一个叶子只看一个事实，组合只做逻辑（不可能比叶子更宽松）。 */
export function checkToolSignal(obs: CliObservation, spec: ToolSignal): boolean {
  if (typeof spec !== "object" || spec === null) return false;
  for (const [op, raw] of Object.entries(spec)) {
    const args = Array.isArray(raw) ? raw : [raw];
    switch (op) {
      case "all_of":
        if (!Array.isArray(raw) || !raw.every((x) => checkToolSignal(obs, x as ToolSignal))) return false;
        break;
      case "any_of":
        if (!Array.isArray(raw) || !raw.some((x) => checkToolSignal(obs, x as ToolSignal))) return false;
        break;
      case "not":
        if (checkToolSignal(obs, raw as ToolSignal)) return false;
        break;
      case "exit_ok":
        if (!obs.ok) return false;
        break;
      case "exit_code_equals":
        if (obs.code !== Number(args[0])) return false;
        break;
      case "stdout_contains":
        if (!obs.stdout.includes(s(args[0]))) return false;
        break;
      case "stderr_contains":
        if (!obs.stderr.includes(s(args[0]))) return false;
        break;
      case "stdout_matches":
        try {
          if (!new RegExp(s(args[0]), "s").test(obs.stdout)) return false;
        } catch {
          return false;
        }
        break;
      case "json_path_equals": {
        let parsed: unknown;
        try {
          parsed = JSON.parse(obs.stdout);
        } catch {
          return false;                                  // 不是 JSON -> 这个叶子不成立，不抛
        }
        const got = resolve(parsed, normalizeJsonPath(s(args[0])));
        if (s(got) !== s(args[1])) return false;
        break;
      }
      case "file_exists": {
        try {
          if (!fs.statSync(artifactPath(s(args[0]))).isFile()) return false;
        } catch {
          return false;
        }
        break;
      }
      case "file_absent": {
        try {
          fs.statSync(artifactPath(s(args[0])));
          return false;                                  // 存在 -> "不存在"不成立
        } catch {
          /* 不存在：成立 */
        }
        break;
      }
      default:
        return false;
    }
  }
  return true;
}
