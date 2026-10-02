/**
 * Plan CLI — TS twin of `plan_cli.py`: LLM-drafted OR hand-built plans, both
 * constrained by the same `PlanningRules`, validated before anything runs.
 *
 *   plan-cli new "goal..." [--llm] [--url URL]
 *   plan-cli add 0 "desc" --signal op=value [--url URL] [--hint HINT]
 *   plan-cli edit 1 --desc ... --signal ... --url ... [--hint HINT]
 *   plan-cli move 2 0 | del 1 | show | check | reset | run [--confirm allow|deny|ask]
 *
 * Signal syntax (`--signal`): url_contains=SUBSTR | css_exists=SEL |
 *   css_text_equals=SEL|TEXT | css_text_contains=SEL|TEXT | css_value_equals=SEL|VALUE
 *
 * PORT FIX (Python audit M3): the reference decided success with
 * `rep["completed"].startswith(str(len(plan.subgoals)))`, which counts a SKIPPED
 * conditional subgoal as a failure — a plan whose guards all fired correctly
 * exited 1 and the audit said REJECT. Here "finished" = done + skipped.
 */
import { parseArgs } from "node:util";
import { PlanningRules, TaskPlan } from "./plan.ts";
import { LLMPlanner, runPlan, type PlannerLike } from "./planner.ts";
import { SIGNAL_OPS, type SignalSpec } from "./signals.ts";
import { browserSession, BrowserMiddleware } from "./executor.ts";
import { extractElements } from "./extraction.ts";
import { getAuditor, type AuditVerdict } from "./audit.ts";

export const DEFAULT_FILE = ".task_plan.json";

/** `op=value` or `op=selector|value`, with the operator's arity enforced. */
export function parseSignal(s: string): SignalSpec {
  const eq = s.indexOf("=");
  const op = eq >= 0 ? s.slice(0, eq) : s;
  const val = eq >= 0 ? s.slice(eq + 1) : "";
  if (!(op in SIGNAL_OPS)) {
    throw new Error(`unknown signal op '${op}'; valid: ${Object.keys(SIGNAL_OPS).join(", ")}`);
  }
  if (SIGNAL_OPS[op] === 1) return { [op]: [val] };
  if (!val.includes("|")) throw new Error(`${op} needs 'selector|value'`);
  const [sel, ...rest] = val.split("|");
  return { [op]: [sel, rest.join("|")] };
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
  goal: string; file: string; llm: boolean; url: string | null; max: number;
}

export async function cmdNew(a: NewArgs, io: CliIO = defaultIO): Promise<TaskPlan> {
  let plan: TaskPlan;
  if (a.llm) {
    if (!process.env.OPENAI_BASE_URL || !process.env.OPENAI_API_KEY) {
      throw new Error("--llm needs OPENAI_BASE_URL + OPENAI_API_KEY (PLANNER_MODEL optional); "
        + "without them use the manual skeleton");
    }
    // Snapshot the page first: the planner can only write done-signals and
    // target_hints if it sees the same element space the executor will see.
    let elems = null;
    if (a.url) {
      const session = await browserSession();
      try {
        await session.page.goto(a.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        elems = await extractElements(session.page);
        io.out(`snapshot: ${Object.keys(elems).length} interactive elements from ${a.url}`);
      } finally {
        await session.close();
      }
    }
    plan = await new LLMPlanner().makePlan(a.goal, {
      rules: new PlanningRules(a.max), startUrl: a.url, elems,
    });
  } else {
    plan = new TaskPlan(a.goal, []);      // manual skeleton: fill with `add`
  }
  if (a.url) for (const s of plan.subgoals) if (!s.start_url) s.start_url = a.url;
  plan.path = a.file;
  plan.save();
  io.out(`saved to ${a.file}`);
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
  replan: boolean;
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
}

export async function cmdRun(a: RunArgs, io: CliIO = defaultIO, deps: RunDeps = {}): Promise<RunOutcome> {
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
  let planner: PlannerLike | null = deps.planner ?? null;
  if (a.replan && !planner) {
    if (!process.env.OPENAI_BASE_URL || !process.env.OPENAI_API_KEY) {
      throw new Error("--replan needs OPENAI_BASE_URL + OPENAI_API_KEY");
    }
    planner = new LLMPlanner();
  }
  const mw = (deps.middleware ?? new BrowserMiddleware({ confirmFn })) as BrowserMiddleware;
  const start = plan.subgoals.find((s) => s.start_url)?.start_url ?? null;
  if (start === null) throw new Error("no subgoal has a start_url");
  const rep = await runPlan(mw as never, plan, {
    startUrl: start, planner, rules,
    sessionFactory: deps.sessionFactory as never,
  });
  const finished = plan.subgoals.every((s) => s.status === "done" || s.status === "skipped");
  const auditor = (mw as unknown as { auditor?: ReturnType<typeof getAuditor> }).auditor ?? getAuditor();
  const audit = (await auditor.audit(plan.goal, rep.traces, finished)) as AuditVerdict;
  io.out(`\n${rep.completed} subgoals; steps=${rep.traces.length}`);
  io.out(`final audit: ${JSON.stringify(audit)}`);
  return { exitCode: finished ? 0 : 1, completed: rep.completed, audit, finished };
}

/* ------------------------------------------------------------------ entry */

const USAGE = `Plan CLI: LLM-drafted OR hand-built plans, both constrained by the same rules.

  plan-cli new "goal..." [--llm] [--url URL] [--max N]
  plan-cli add IDX "desc" --signal OP=VALUE [--url URL] [--hint HINT]
  plan-cli edit IDX [--desc D] [--signal S] [--url U] [--hint H]
  plan-cli move IDX TO | del IDX | show | check | reset
  plan-cli run [--confirm allow|deny|ask] [--reset] [--replan]

Plans live in --file (default ${DEFAULT_FILE}); editing that JSON by hand between
commands works too — \`check\` re-validates whatever is on disk.`;

export async function main(argv: string[] = process.argv.slice(2), io: CliIO = defaultIO): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    io.out(USAGE);
    return cmd ? 0 : 1;
  }
  const parsed = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      file: { type: "string" }, max: { type: "string" },
      llm: { type: "boolean" }, url: { type: "string" }, hint: { type: "string" },
      desc: { type: "string" }, signal: { type: "string" },
      confirm: { type: "string" }, reset: { type: "boolean" }, replan: { type: "boolean" },
    },
  });
  const file = parsed.values.file ?? DEFAULT_FILE;
  const max = Number(parsed.values.max ?? 8);
  const pos = parsed.positionals;

  switch (cmd) {
    case "new":
      await cmdNew({ goal: pos[0] ?? "", file, llm: Boolean(parsed.values.llm),
                     url: parsed.values.url ?? null, max }, io);
      return 0;
    case "show":
      cmdShow(file, io);
      return 0;
    case "add":
      cmdAdd(file, Number(pos[0]), pos[1] ?? "", String(parsed.values.signal ?? ""),
             parsed.values.url ?? null, parsed.values.hint ?? null, io);
      return 0;
    case "edit":
      cmdEdit(file, Number(pos[0]), {
        desc: parsed.values.desc, signal: parsed.values.signal,
        url: parsed.values.url, hint: parsed.values.hint,
      }, io);
      return 0;
    case "del":
      cmdDel(file, Number(pos[0]), io);
      return 0;
    case "move":
      cmdMove(file, Number(pos[0]), Number(pos[1]), io);
      return 0;
    case "check":
      return cmdCheck(file, max, io) ? 0 : 1;
    case "reset":
      cmdReset(file, io);
      return 0;
    case "run": {
      const outcome = await cmdRun({
        file, max, reset: Boolean(parsed.values.reset),
        confirm: (parsed.values.confirm ?? "ask") as RunArgs["confirm"],
        replan: Boolean(parsed.values.replan),
      }, io);
      return outcome.exitCode;
    }
    default:
      io.out(`unknown command '${cmd}'\n\n${USAGE}`);
      return 2;
  }
}
