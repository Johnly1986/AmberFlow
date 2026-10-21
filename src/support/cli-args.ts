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
 * 用法（每个入口 4 行，保住 parseArgs 的精确泛型，不做类型体操）：
 *   let parsed;                                   // eslint-disable-line no-useless-annotation
 *   try { parsed = parseArgs({…}); }
 *   catch (err) { if (!isParseUsageError(err)) throw err; say([usageErrorLine(err), "", USAGE]); return 2; }
 */

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
