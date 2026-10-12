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
   * P2 命令层：这一步的**命令闭集**（可选；不写 = 今天的一步一指针，逐字节不变）。
   * 声明半在加载期对着引擎能力面校验（`actions.validateCommands`），
   * 实例化半在运行期把声明 × 当次元素池收成候选（`actions.instantiateSpace`）。
   */
  commands?: CommandDecl[];
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
  "commands",
]);

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

  problems(plan: TaskPlan): string[] {
    const issues: string[] = [];
    if (plan.subgoals.length > this.maxSubgoals) {
      issues.push(`${plan.subgoals.length} subgoals exceed max ${this.maxSubgoals}`);
    }
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
        validateCommands(s.commands, tag, issues);
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
      for (const k of ["target_hint", "target_hints", "slots", "when", "commands"] as const) {
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
  ): void {
    const sg: Subgoal = { desc, signal, start_url: startUrl, status: "pending", obstacle: null };
    // Complete contract surface: Python's insert() silently dropped when/retries —
    // and the same lesson applies to every field added later, so `commands` rides here too
    // (a replan amendment must never lose a step's command space).
    if (targetHint) sg.target_hint = targetHint;
    if (targetHints) sg.target_hints = targetHints;
    if (slots) sg.slots = slots;
    if (when) sg.when = when;
    if (retries) sg.retries = Math.trunc(retries);
    if (commands) sg.commands = commands;
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
