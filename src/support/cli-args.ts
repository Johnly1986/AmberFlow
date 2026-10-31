/**
 * CLI 用法错误的**一行解释**——单一出处。
 *
 * 为什么存在：`parseArgs` 对打错的参数抛 TypeError，每个入口都会把整段堆栈
 * 打印给一个第一次用 `npm start` 的人。这与仓库既有的体例相悖——doctor 对缺前提
 * 的处理是"缺什么 + 一条补齐命令"（`src/cli/start.ts` 的 MODEL_MISSING_LINE），
 * UX 评审轮也把"使用者完全看不懂的报错"逐个修成了点名式（REFUSAL_LABELS、
 * `step N names no target: …`、`--slot` 未声明键）。unknown-option 是同一类缺陷，
 * 只是此前没人接住它。实测（2026-10-14，开箱测试轮）：
 *   `npm start -- --out /tmp/x`  → ERR_PARSE_ARGS_UNKNOWN_OPTION 裸堆栈；
 *   `plan-cli add --signal 'css_text_equals=#only'` → `needs 'selector|value'` 裸堆栈。
 *
 * 纪律：**只把用法错误变成一行话，真异常照抛**——吞掉非用法错误会让"崩了"与
 * "没人干活"不可区分（planner 的同款教训）。用法错误的判据是 Node 自己给的错误码。
 *
 * 用法：入口只写三行（`parseCliArgs` 把"吃掉 `--`"、一行报错、改名提示、usage 收在一处）：
 *   const cli = parseCliArgs(argv, { options: appOptions(), usage: USAGE });
 *   if (!cli.ok) return cli.code;
 *   const v = cli.values;
 */

import { parseArgs } from "node:util";

/** parseArgs 会抛的"你给错了"类错误码（其余的 code 是程序 bug，不许截肢成一行话）。 */
const USAGE_ERROR_CODES = new Set([
  "ERR_PARSE_ARGS_UNKNOWN_OPTION",
  "ERR_PARSE_ARGS_MISSING_ARG_VALUE",
  "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
  "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL",
  "ERR_PARSE_ARGS_AMBIGUOUS_OPTION_ARGUMENT",
]);

export function isParseUsageError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? "";
  return USAGE_ERROR_CODES.has(code);
}

/** 用法错误的一行说法：Node 的 message 已点名到具体选项，别再加工。 */
export function usageErrorLine(err: unknown): string {
  const m = (err as Error)?.message ?? String(err);
  return `参数用法不对：${m.replace(/^[A-Za-z]*Error: /, "")}`;
}

/**
 * 改名/废弃参数的迁移表——给"上一版调用方"指路（升级窗口里的旧插件、旧脚本、旧文档抄来的命令）。
 * `--no-model` 是 2026-10 改名轮的活案例：名实不符（桩被标成 rules-only）所以拆成
 * `--ablate stub|rules-only`，但正在运行的旧桥仍会发 `--no-model`（link 安装形态下
 * 桥是宿主进程里的旧模块、引擎 CLI 是子进程里的新代码——README/DEVELOPING.md 的"重启一次"）。
 * 报错必须回答"那我该写什么"，否则使用者只能翻 git log。
 */
const RENAMED_HINTS: Array<[RegExp, string]> = [
  [/--no-model\b/, "--no-model 已改名（名实相符原则）：规则模式用 --ablate rules-only，脚本桩用 --ablate stub。"],
  [/--LAYAA_/i, "LAYAA_* 环境变量是旧名，新名 LAYA_*（旧名仍兼容）。"],
];

export function renamedHint(line: string): string | null {
  for (const [re, hint] of RENAMED_HINTS) if (re.test(line)) return hint;
  return null;
}

/* ------------------------------------------------------------------ 空命令 `--` */

/**
 * 吃掉命令行里的**空命令** `--`（npm / shell 的参数分隔符：`npm run apps -- --app <id>`）。
 *
 * 它既不是旗标也不是位置参数，留在 argv 里只有一个后果：`parseArgs` 把它后面的旗标
 * 全当成位置参数吃掉——表现是"明明传了 `--app <id>`，却像什么都没传"（apps 直接打印
 * 清单 + usage、exit 2）。Windows 的 shell 与不少包装脚本会把这个分隔符原样留给子进程，
 * 所以**每个入口**都得做这件事，而每个入口各做一遍就是本仓库的复发缺陷形状——放在这里，一处。
 */
export function stripArgSeparators(argv: readonly string[]): string[] {
  return [...argv].filter((a) => a !== "--");
}

/* ------------------------------------------------------------------ 共用旗标表 */

export interface CliOptionSpec {
  type: "string" | "boolean";
  multiple?: boolean;
  short?: string;
  /** 缺省值（`--plan` 这类"总有一个落点"的旗标用它，好让打印副作用与解析读同一个值）。 */
  default?: string | boolean;
}

export type CliOptions = Record<string, CliOptionSpec>;
export type CliValue = string | boolean | Array<string | boolean> | undefined;
export type CliValues = Record<string, CliValue>;

/**
 * `apps` 的运行旗标：闸门刻度、学习环、消融等。
 * 模型名不走命令行：没有服务地址时由 `AMBERFLOW_DECISION_MODEL` 选本地 checkpoint。
 */
export const SHARED_RUN_OPTIONS: CliOptions = {
  out: { type: "string" },
  provider: { type: "string" },
  headful: { type: "boolean" },
  /** 消融臂：`stub` = 脚本桩，`rules-only` = 规则档（两个入口同一个取值集合）。 */
  ablate: { type: "string" },
  /** 置信度闸门刻度（0<N≤1）。 */
  "conf-floor": { type: "string" },
  /** R2 学习环：开，落点用默认 sidecar。 */
  "learn-hints": { type: "boolean" },
  /**
   * R2 学习环的 sidecar 落点。`FILE` = 显式路径；与 `--learn-hints` 同义。
   */
  "hint-memory": { type: "string" },
  quiet: { type: "boolean" },
  help: { type: "boolean" },
};

/** apps 专属：应用包与槽位。 */
export const APP_ONLY_OPTIONS: CliOptions = {
  list: { type: "boolean" },
  app: { type: "string" },
  dry: { type: "boolean" },
  /** 结果里带每步执行证据（step_traces）；不执行额外页面扫描。 */
  trace: { type: "boolean" },
  /** flow 的执行预算：本次最多执行几个 ctx.step/arrive（调试用）。 */
  "max-steps": { type: "string" },
  /** 非交互：遇到 manual 步直接返回 needs_human，不拉 headed 浏览器。 */
  "manual-fail-fast": { type: "boolean" },
  slot: { type: "string", multiple: true },
  /** 从 JSON 文件读槽位（避免敏感值进 argv）。 */
  "slot-file": { type: "string" },
  /** 时钟缝：把"今天"钉成 YYYY-MM-DD（数据腿相对日期表达式 + ctx.runtime.today）。 */
  today: { type: "string" },
  "no-sources": { type: "boolean" },
  "confirm-safe": { type: "boolean" },
  /** 显式恢复旧行为：危险浏览器动作不再逐次拒绝（M0 默认已翻转为安全）。 */
  "confirm-unsafe": { type: "boolean" },
  "allow-dangerous": { type: "boolean" },
  "tiered-hint": { type: "boolean" },
  /** L2 脚本应用：把本次执行轨迹写成 JSON（审计/交接）。 */
  "emit-trace": { type: "string" },
  /** L2 脚本应用：按一条已记录轨迹重放（版本/输入不一致直接拒跑）。 */
  replay: { type: "string" },
};

export function appOptions(): CliOptions {
  return { ...SHARED_RUN_OPTIONS, ...APP_ONLY_OPTIONS };
}

/* ------------------------------------------------------------------ 一个入口的解析 */

export type CliParseResult =
  | { ok: true; values: CliValues; positionals: string[] }
  | { ok: false; code: number };

export interface CliParseSpec {
  options: CliOptions;
  /** 给了就把 usage 一并打出来（apps/start 的体例）；没给就只报一行。 */
  usage?: string;
  allowPositionals?: boolean;
  /** 输出去向（默认 console.error；注入式 CLI 接到自己的 io 上）。 */
  say?: (line: string) => void;
}

/**
 * 每个 CLI 入口的**同一段开头**：吃掉空命令 `--` → 解析 → 用法错误变成一行话 + usage。
 * 以前这段（含"别把堆栈甩给使用者"的纪律）在每个入口手抄一遍，抄漏一处就是裸堆栈。
 */
export function parseCliArgs(argv: readonly string[], spec: CliParseSpec): CliParseResult {
  const say = spec.say ?? ((line: string) => console.error(line));
  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: stripArgSeparators(argv),
      allowPositionals: spec.allowPositionals ?? false,
      options: spec.options,
    }) as unknown as { values: Record<string, unknown>; positionals: string[] };
  } catch (err) {
    if (!isParseUsageError(err)) throw err;
    const line = usageErrorLine(err);
    say(line);
    const hint = renamedHint(line);          // 旧调用方（升级窗口的旧桥）要知道新写法
    if (hint) say(hint);
    if (spec.usage !== undefined) { say(""); say(spec.usage); }
    return { ok: false, code: 2 };
  }
  return { ok: true, values: parsed.values as CliValues, positionals: parsed.positionals };
}

/** 取字符串旗标（没给 / 给了布尔 ⇒ undefined；`--x a --x b` ⇒ 只认最后一个）。 */
export function cliString(v: CliValues, key: string): string | undefined {
  const x = v[key];
  if (x === undefined || typeof x === "boolean") return undefined;
  return Array.isArray(x) ? String(x[x.length - 1]) : String(x);
}

/** 取可重复旗标的全部值（`--slot a=1 --slot b=2`）。 */
export function cliStrings(v: CliValues, key: string): string[] {
  const x = v[key];
  if (x === undefined) return [];
  if (Array.isArray(x)) return x.map(String);
  if (typeof x === "boolean") return x ? ["true"] : [];
  return [String(x)];
}

/** 取布尔旗标（没给 = false）。 */
export function cliBool(v: CliValues, key: string): boolean {
  const x = v[key];
  if (x === undefined) return false;
  if (typeof x === "boolean") return x;
  return Array.isArray(x) ? x.length > 0 : String(x) !== "false";
}
