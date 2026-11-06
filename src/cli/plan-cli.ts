/**
 * Plan CLI — TS twin of `plan_cli.py`: hand-built plans（规划归 Agent：LLM 起草/重规划面
 * 已移除——引擎只执行冻结计划）, constrained by the same `PlanningRules`, validated
 * before anything runs.
 *
 *   plan-cli new "goal..." [--url URL]
 *   plan-cli add 0 "desc" --signal op=value [--url URL] [--hint HINT]
 *   plan-cli edit 1 --desc ... --signal ... --url ... [--hint HINT]
 *   plan-cli move 2 0 | del 1 | show | check | reset | run [--confirm allow|deny|ask]
 *                                                            [--escalate] [--provider NAME]
 *
 * Signal syntax (`--signal`): url_contains=SUBSTR | css_exists=SEL |
 *   css_exists_text=SEL|TEXT | css_visible_exists=SEL |
 *   css_text_equals=SEL|TEXT | css_text_contains=SEL|TEXT | css_value_equals=SEL|VALUE
 *
 * PORT FIX (Python audit M3): the reference decided success with
 * `rep["completed"].startswith(str(len(plan.subgoals)))`, which counts a SKIPPED
 * conditional subgoal as a failure — a plan whose guards all fired correctly
 * exited 1 and the audit said REJECT. Here "finished" = done + skipped.
 */
import { parseArgs } from "node:util";
import { PlanningRules, TaskPlan } from "../engine/plan.ts";
import { runPlan, type PlannerLike } from "../engine/planner.ts";
import { SIGNAL_OPS, checkSignal, validateSignalSpec, type SignalSpec } from "../engine/signals.ts";
import { browserSession, BrowserMiddleware, type EscalatorLike } from "../engine/executor.ts";
import { extractElements } from "../engine/extraction.ts";
import { getAuditor, type AuditVerdict } from "../engine/audit.ts";
import { createHintMemory, type HintMemoryLike } from "../model/hint-memory.ts";
import { applySpecToRuntime, installDecisionProvider, resolveProviderSpec } from "../model/decision-provider.ts";
import { installLayaRuntime } from "../model/model.ts";
import { providerEscalator } from "../model/provider-escalator.ts";
import { isParseUsageError, stripArgSeparators, usageErrorLine } from "../support/cli-args.ts";
import { applyConfiguredEnv } from "../support/apply-config-env.ts";
// B1 节奏统一：规划脸动作间间距走 env 层（子目标/重试间距在 runPlan 里同样 env-only）。
import { envPace } from "../support/pace.ts";
import { defaultPlanPath } from "../app/amberflow-home.ts";

/**
 * 计划文件的默认落点：与 `npm start` 同一处——**用户作用域** `$AMBERFLOW_HOME/task_plan.json`
 * （`src/app/amberflow-home.ts`）。以前它俩各写一个默认值（一个仓库根、一个相对路径），
 * 于是"我的计划在哪"取决于你是从哪个入口进来的。
 */
export const DEFAULT_FILE = defaultPlanPath();

/** `op=value` or `op=selector|value`, with the operator's arity enforced. */
export function parseSignal(s: string): SignalSpec {
  const eq = s.indexOf("=");
  const op = eq >= 0 ? s.slice(0, eq) : s;
  const val = eq >= 0 ? s.slice(eq + 1) : "";
  if (!(op in SIGNAL_OPS)) {
    throw new Error(`unknown signal op '${op}'; valid: ${Object.keys(SIGNAL_OPS).join(", ")}`);
  }
  const arity = SIGNAL_OPS[op]!;
  // arity 0（`manual`）是无参叶子：不看值，也不能被下面的 `selector|value` 分支误杀。
  // 写成 `{manual: true}` 与应用层文档同形（值是声明存在，不是可校验参数）。
  if (arity === 0) return { [op]: true };
  let spec: SignalSpec;
  if (arity === 1) {
    spec = { [op]: [val] };
  } else {
    if (!val.includes("|")) throw new Error(`${op} needs 'selector|value'`);
    const [sel, ...rest] = val.split("|");
    spec = { [op]: [sel, rest.join("|")] };
  }
  // U4：解析期就拒绝真空操作数——手写 `--signal url_contains=` / `text=#h1|` 曾经被
  // 静默接受，运行期该信号恒真 ⇒ 零动作假过。语法只有一份（validateSignalSpec）。
  const problems = validateSignalSpec(spec, "signal");
  if (problems.length) {
    throw new Error(`${problems[0]}；合法写法：`
      + `--signal url_contains=page2 / --signal css_exists=#main / `
      + `--signal css_exists_text=#h1|Saved / --signal css_value_equals=#i|0 / --signal manual`);
  }
  return spec;
}

function loadPlan(file: string): TaskPlan {
  const plan = TaskPlan.load(file);
  if (!plan) throw new Error(`no plan at ${file}; create one with \`new\` first`);
  return plan;
}

/* ------------------------------------------------------------------ commands */

export interface CliIO {
  out: (s: string) => void;
  ask: (s: string) => Promise<boolean>;
}

const defaultIO: CliIO = {
  out: (s) => console.log(s),
  ask: async (s) => {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const a = await rl.question(`${s} [y/N] `);
      return a.toLowerCase() === "y";
    } finally {
      rl.close();
    }
  },
};

export interface NewArgs {
  goal: string; file: string; url: string | null;
}

export async function cmdNew(a: NewArgs, io: CliIO = defaultIO): Promise<TaskPlan> {
  // 规划归 Agent（2026-11）：计划起草不再有 LLM 面（原 `new --llm` 已移除）。这里只
  // 产出手工骨架，由人/Agent 用 `add` 逐条补齐——引擎只执行冻结计划；步级决策照旧走
  // 统一决策源（docs/DECISION_SERVICE_CONFIG.md）。
  const plan = new TaskPlan(a.goal, []);      // manual skeleton: fill with `add`
  if (a.url) for (const s of plan.subgoals) if (!s.start_url) s.start_url = a.url;
  plan.path = a.file;
  plan.save();
  io.out(`saved to ${a.file}`);
  io.out("定位提示：plan JSON 是逐步调试/续跑的轻载体；应用的唯一编写格式是 app.mjs"
    + "（amber apps new / npm run learn）——命令空间与结束态不变量只在 app 面有一等支持。");
  io.out(JSON.stringify(plan.subgoals, null, 2));
  return plan;
}

export function cmdShow(file: string, io: CliIO = defaultIO): void {
  const plan = loadPlan(file);
  io.out(`goal: ${plan.goal}`);
  plan.subgoals.forEach((s, i) => {
    io.out(`  [${i}] ${String(s.status).padEnd(8)} ${s.desc}`);
    io.out(`       signal=${JSON.stringify(s.signal)}  start_url=${s.start_url ?? null}`
      + (s.target_hint ? `  target_hint=${s.target_hint}` : "")
      + (s.obstacle ? `  obstacle=${s.obstacle}` : ""));
  });
}

export function cmdAdd(file: string, idx: number, desc: string, signal: string,
                       url: string | null, hint: string | null, io: CliIO = defaultIO): void {
  const plan = loadPlan(file);
  plan.insert(idx, desc, parseSignal(signal), url, hint);
  plan.save();
  io.out(`inserted at ${idx}; ${plan.summary()}`);
}

export function cmdEdit(file: string, idx: number,
                        fields: { desc?: string; signal?: string; url?: string; hint?: string },
                        io: CliIO = defaultIO): void {
  const plan = loadPlan(file);
  const patch: Record<string, unknown> = {};
  if (fields.desc !== undefined) patch.desc = fields.desc;
  if (fields.signal !== undefined) patch.signal = parseSignal(fields.signal);
  if (fields.url !== undefined) patch.start_url = fields.url;
  if (fields.hint !== undefined) patch.target_hint = fields.hint;
  plan.update(idx, patch as never);
  plan.save();
  io.out(JSON.stringify(plan.subgoals[idx], null, 2));
}

export function cmdDel(file: string, idx: number, io: CliIO = defaultIO): void {
  const plan = loadPlan(file);
  plan.remove(idx);
  plan.save();
  io.out(plan.summary());
}

export function cmdMove(file: string, idx: number, to: number, io: CliIO = defaultIO): void {
  const plan = loadPlan(file);
  plan.move(idx, to);
  plan.save();
  io.out(plan.summary());
}

export function cmdCheck(file: string, max: number, io: CliIO = defaultIO): boolean {
  const plan = loadPlan(file);
  const issues = new PlanningRules(max).problems(plan);
  if (issues.length) {
    io.out("INVALID:");
    for (const i of issues) io.out(`  - ${i}`);
    return false;
  }
  io.out(`OK: ${plan.subgoals.length} subgoals pass the planning rules`);
  return true;
}

/**
 * 信号可判定性探针（P1b，2026-11-01 产品评审）：opt-in 在线预检——`check --probe`。
 *
 * plan check 是纯离线校验，对「信号在目标页永远不成立」「hint 在实况页不存在」零提示；
 * 执行时才挡、且（修复前）停因误导。探针把每个 start_url 真实到达一遍（只读观察，
 * 不执行任何动作）：
 *   - 点名步：target_hint 在实况元素池里能否解析；
 *   - 零动作验证步（无 target、无 commands）：done 信号此刻是否成立——不成立 = 规则档必挡；
 *   - 命令步：信号此刻状态只作情报（动作后评估，未成立属预期）。
 * 失败（hint 未解析 / 验证步信号不成立 / 打不开页面）→ false（exit 1）。
 * 探针不代替真实执行，只回答"这份计划在当前实况页上有没有机制性必挡项"。
 */
export async function probePlan(file: string, io: CliIO = defaultIO): Promise<boolean> {
  const plan = loadPlan(file);
  const urls = [...new Set(plan.subgoals
    .map((s) => s.start_url)
    .filter((u): u is string => typeof u === "string" && u !== ""))];
  if (!urls.length) {
    io.out("PROBE 跳过：没有任何子目标声明 start_url");
    return true;
  }
  // 动态 import：start.ts 静态引 playwright（chromium），拖进来会让 new/add/check 等纯
  // 离线路径也背上浏览器启动成本——只有真探针才付这笔。
  const { findByHint } = await import("./start.ts");
  io.out(`PROBE：${urls.length} 个 start_url 逐一到达并实证（只读观察，不执行任何动作）`);
  let failed = false;
  const session = await browserSession(true);
  try {
    for (const url of urls) {
      io.out(`  → ${url}`);
      try {
        await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch (e) {
        io.out(`    ✗ 打不开：${(e as Error).message}`);
        failed = true;
        continue;
      }
      const elems = await extractElements(session.page);
      for (let i = 0; i < plan.subgoals.length; i++) {
        const sg = plan.subgoals[i]!;
        if (sg.start_url !== url) continue;
        const hasCmds = Array.isArray(sg.commands) && sg.commands.length > 0;
        const head = `    [${i}] ${sg.desc}`;
        if (sg.target_hint) {
          const found = findByHint(elems, sg.target_hint);
          io.out(`${head}\n      target_hint ${JSON.stringify(sg.target_hint)}：${found
            ? "在实况元素池命中 ✓"
            : "未命中 ✗（inspect --url 复核 hint；动态页注意水合时机）"}`);
          if (!found) failed = true;
        } else if (!hasCmds) {
          const holds = await checkSignal(session.page as never, sg.signal);
          io.out(`${head}\n      零动作验证步：done 信号此刻${holds
            ? "成立 ✓"
            : "不成立 → 规则档必挡 ✗（inspect --probe 核对选择器；声明 skip 命令救不了不成立的信号）"}`);
          if (!holds) failed = true;
        } else {
          const holds = await checkSignal(session.page as never, sg.signal);
          io.out(`${head}\n      命令步：done 信号此刻${holds ? "已成立" : "未成立（动作后评估，属预期）"}`);
        }
      }
    }
  } finally {
    await session.close();
  }
  io.out(failed ? "PROBE：发现机制性必挡项 ✗（先修计划再 run）" : "PROBE：全部可判定 ✓");
  return !failed;
}

export function cmdReset(file: string, io: CliIO = defaultIO): void {
  const plan = loadPlan(file);
  for (const s of plan.subgoals) {
    s.status = "pending";
    s.obstacle = null;
  }
  plan.save();
  io.out(`reset ${plan.subgoals.length} subgoals to pending`);
}

export interface RunArgs {
  file: string; max: number; reset: boolean; confirm: "allow" | "deny" | "ask";
  /** 低置信恢复的最后一级：经 provider 缝的 askChoice 闭集点名（opt-in；缺省关）。 */
  escalate?: boolean;
  /** 决策源覆盖（仅本次，不进配置）：与 `--provider` 全局语义一致。 */
  provider?: string | null;
  /** 新 CLI 的 `run/plan run --headful`；旧 plan-cli 缺省仍是 headless。 */
  headful?: boolean;
  /**
   * Sidecar path for LEARNED HINTS (see src/model/hint-memory.ts). The memory lives in its own
   * file on purpose: a frozen plan is an audited artifact and a run must not rewrite it.
   */
  hintMemory?: string | null;
}

export interface RunOutcome {
  exitCode: number;
  completed: string;
  audit: AuditVerdict;
  /** done + skipped: a skipped conditional subgoal is FINISHED, not a failure. */
  finished: boolean;
}

export interface RunDeps {
  planner?: PlannerLike | null;
  /** Test seam: replace the executor / the session factory. */
  middleware?: unknown;
  sessionFactory?: () => Promise<unknown>;
  /** Test seam: an in-memory learned-hint store instead of the sidecar file. */
  hintMemory?: HintMemoryLike | null;
}

export async function cmdRun(a: RunArgs, io: CliIO = defaultIO, deps: RunDeps = {}): Promise<RunOutcome> {
  // B1：坏 env 值在**任何**动作之前响亮报错（plan-cli main 把它归入「参数用法不对」exit 2）。
  const paceEnv = envPace(process.env);
  const plan = loadPlan(a.file);
  if (a.reset) {
    for (const s of plan.subgoals) {
      s.status = "pending";
      s.obstacle = null;
    }
  }
  const rules = new PlanningRules(a.max);
  const issues = rules.problems(plan);
  if (issues.length) throw new Error(`plan is invalid (run \`check\`): ${issues.join("; ")}`);
  const confirmFn = {
    allow: () => true,
    deny: () => false,
    ask: (d: string) => io.ask(`  CONFIRM '${d}'?`),
  }[a.confirm];
  const hints = deps.hintMemory ?? (a.hintMemory ? createHintMemory({ path: a.hintMemory }) : null);
  let escalateFn: EscalatorLike | null = null;
  if (!deps.middleware) {
    // 统一决策解析（BACKLOG #1）：plan-cli 与 start/apps/online 走**同一个门**——
    // 有 AMBERFLOW_DECISION_BASE_URL 即线上服务，无地址用本地 laya；`--provider` 只作
    // 本次实验/消融覆盖。本地产物不齐 = 规则档，两扇全局都清（与 start 同语义），
    // 绝不装一个每步都抛错的 runtime，也绝不悄悄换模型。
    let spec;
    try {
      spec = await resolveProviderSpec(a.provider ?? null);
    } catch (e) {
      throw new Error(`决策源解析失败：${(e as Error).message}`);
    }
    if (spec.kind === "laya" && spec.tier === "off(missing)") {
      installLayaRuntime(null);
      installDecisionProvider(null);
    } else {
      await applySpecToRuntime(spec);
    }
    if (a.escalate) {
      escalateFn = providerEscalator();
      if (!escalateFn) {
        io.out("⚠ --escalate：当前决策源没有 askChoice 闭集窄问能力（无 provider 或该 provider 不支持）"
          + "——梯级缺席，低置信步照原样阻塞。");
      }
    }
  }
  const mw = (deps.middleware ?? new BrowserMiddleware({
    confirmFn,
    // B1：规划脸动作间间距（env-only；缺省 0 = 行为不变）。
    actionDelayMs: paceEnv.between_actions_ms ?? 0,
    hintMemory: hints,
    ...(escalateFn ? { escalateFn } : {}),
  })) as BrowserMiddleware;
  const start = plan.subgoals.find((s) => s.start_url)?.start_url ?? null;
  if (start === null) throw new Error("no subgoal has a start_url");
  const sessionFactory = deps.sessionFactory
    ?? (a.headful ? async () => browserSession(false) : undefined);
  const rep = await runPlan(mw as never, plan, {
    startUrl: start, planner: deps.planner ?? null, rules,
    ...(sessionFactory ? { sessionFactory: sessionFactory as never } : {}),
  });
  const finished = plan.subgoals.every((s) => s.status === "done" || s.status === "skipped");
  const auditor = (mw as unknown as { auditor?: ReturnType<typeof getAuditor> }).auditor ?? getAuditor();
  const audit = (await auditor.audit(plan.goal, rep.traces, finished)) as AuditVerdict;
  io.out(`\n${rep.completed} subgoals; steps=${rep.traces.length}`);
  io.out(`final audit: ${JSON.stringify(audit)}`);
  // B1：生效节奏行（非零才打；来源标注纪律与 effective_policy 一致）。
  if ((paceEnv.between_steps_ms ?? 0) > 0 || (paceEnv.between_actions_ms ?? 0) > 0) {
    const src = (v: number | undefined): string => (v === undefined ? "default" : "env");
    io.out(`pace: between_steps=${paceEnv.between_steps_ms ?? 0}ms(${src(paceEnv.between_steps_ms)})`
      + ` between_actions=${paceEnv.between_actions_ms ?? 0}ms(${src(paceEnv.between_actions_ms)})`);
  }
  if (hints?.stats) {
    const s = hints.stats();
    io.out(`learned hints: ${s.entries} known, ${s.used} reused this run`
      + `${a.hintMemory ? ` (${a.hintMemory})` : ""}`);
  }
  return { exitCode: finished ? 0 : 1, completed: rep.completed, audit, finished };
}

/* ------------------------------------------------------------------ entry */

const USAGE = `Plan CLI: hand-built plans（规划归 Agent，LLM 起草/重规划面已移除）, constrained by the same rules.

  plan-cli new "goal..." [--url URL] [--max N]
  plan-cli add IDX "desc" --signal OP=VALUE [--url URL] [--hint HINT]
  plan-cli edit IDX [--desc D] [--signal S] [--url U] [--hint H]
  plan-cli move IDX TO | del IDX | show | check [--probe] | reset
  plan-cli run [--confirm allow|deny|ask] [--reset] [--escalate] [--provider NAME]
               [--learn-hints | --hint-memory FILE]   # learned hints live in a SIDECAR

载体定位：plan JSON 是**逐步调试 / 续跑**的轻载体；应用的唯一编写格式是 app.mjs
（amber apps new / npm run learn）——命令空间（含零动作验证步）与结束态不变量只在
app 面有一等支持。check --probe 是 opt-in 在线探针：实况核对 hint 解析与验证步信号。

Plans live in --file (default ${DEFAULT_FILE}); editing that JSON by hand between
commands works too — \`check\` re-validates whatever is on disk.`;

export async function main(argv: string[] = process.argv.slice(2), io: CliIO = defaultIO): Promise<number> {
  // rc 文件坏 = 配置类用法错误：在任何腿出场之前逐行点名并 exit 2（src/support/rcfile.ts）。
  { const rc = applyConfiguredEnv(); if (rc.errors.length) { for (const e of rc.errors) console.error(e); return 2; } }
  // 空命令 `--`（npm 的分隔符）在这里吃掉：`npm run plan-cli -- --help` 不该变成"没有子命令"。
  const [cmd, ...rest] = stripArgSeparators(argv);
  if (!cmd || cmd === "--help" || cmd === "-h") {
    io.out(USAGE);
    return cmd ? 0 : 1;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        file: { type: "string" }, max: { type: "string" },
        url: { type: "string" }, hint: { type: "string" },
        desc: { type: "string" }, signal: { type: "string" },
        confirm: { type: "string" }, reset: { type: "boolean" },
        probe: { type: "boolean" },
        escalate: { type: "boolean" }, provider: { type: "string" },
        headful: { type: "boolean" },
        "hint-memory": { type: "string" }, "learn-hints": { type: "boolean" },
      },
    });
  } catch (err) {
    if (!isParseUsageError(err)) throw err;
    io.out(usageErrorLine(err)); io.out(""); io.out(USAGE);
    return 2;
  }
  const file = parsed.values.file ?? DEFAULT_FILE;
  const max = Number(parsed.values.max ?? 8);
  const pos = parsed.positionals;

  // 索引必须是整数：`add x` 以前会 insert(NaN) —— 打错的参数**污染计划文件**比报错更糟。
  const index = (raw: string | undefined, which: string): number | null => {
    const n = Number(raw);
    if (raw === undefined || !Number.isInteger(n) || n < 0) {
      io.out(`参数用法不对：${which} 需要非负整数（收到 '${raw ?? "（缺）"}'）；计划文件未改动。`);
      return null;
    }
    return n;
  };

  try {
    switch (cmd) {
      case "new":
        await cmdNew({ goal: pos[0] ?? "", file, url: parsed.values.url ?? null }, io);
        return 0;
      case "show":
        cmdShow(file, io);
        return 0;
      case "add": {
        const i = index(pos[0], "add IDX");
        if (i === null) return 2;
        cmdAdd(file, i, pos[1] ?? "", String(parsed.values.signal ?? ""),
               parsed.values.url ?? null, parsed.values.hint ?? null, io);
        return 0;
      }
      case "edit": {
        const i = index(pos[0], "edit IDX");
        if (i === null) return 2;
        cmdEdit(file, i, {
          desc: parsed.values.desc, signal: parsed.values.signal,
          url: parsed.values.url, hint: parsed.values.hint,
        }, io);
        return 0;
      }
      case "del": {
        const i = index(pos[0], "del IDX");
        if (i === null) return 2;
        cmdDel(file, i, io);
        return 0;
      }
      case "move": {
        const from = index(pos[0], "move IDX");
        const to = index(pos[1], "move TO");
        if (from === null || to === null) return 2;
        cmdMove(file, from, to, io);
        return 0;
      }
      case "check": {
        const rulesOk = cmdCheck(file, max, io);
        if (!rulesOk) return 1;
        if (parsed.values.probe) return await probePlan(file, io) ? 0 : 1;
        return 0;
      }
      case "reset":
        cmdReset(file, io);
        return 0;
      case "run": {
        const learn = Boolean(parsed.values["learn-hints"]);
        const outcome = await cmdRun({
          file, max, reset: Boolean(parsed.values.reset),
          confirm: (parsed.values.confirm ?? "ask") as RunArgs["confirm"],
          escalate: Boolean(parsed.values.escalate),
          provider: parsed.values.provider ?? null,
          headful: Boolean(parsed.values.headful),
          // --learn-hints keeps the memory NEXT TO the plan (a sidecar), never inside it
          hintMemory: (parsed.values["hint-memory"] as string | undefined)
            ?? (learn ? `${file}.hints.json` : null),
        }, io);
        return outcome.exitCode;
      }
      default:
        io.out(`unknown command '${cmd}'\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    // 三类**已知**的"你给错了"消息（信号语法 / 没有计划 / 决策源未配置）：一行点名，
    // 不甩堆栈；其余异常是真 bug，原样上抛（吞掉它比堆栈更糟——"崩了"必须看得见）。
    const m = (err as Error)?.message ?? "";
    if (/unknown signal op|needs 'selector\|value'|^no plan at |^决策源解析失败|不合法：需要 0\.\.60000 的整数毫秒/.test(m)) {
      io.out(`参数用法不对：${m}`);
      return 2;
    }
    throw err;
  }
}
