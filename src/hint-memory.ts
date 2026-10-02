/**
 * Learned hints — turning an OBSERVED success into a rule for next time.
 *
 * The repo's own measurements (rounds 2-4) keep landing on the same conclusion: on real
 * pages the lever is not model accuracy, it is asking the model LESS OFTEN — the 8 live
 * cases run 8/8 with authored hints and 4/8 without them. But a hint has always been an
 * AUTHORED artifact (the planner writes it from the DOM snapshot, `plan_cli --hint`
 * writes it by hand).
 *
 * This module lets a hint be EARNED: when a model pick actually advanced the subgoal, the
 * element it touched is turned into a hint in the existing grammar — restricted to STABLE
 * handles (`data-test`, `id`, `name`, `near`) whose value is not volatile (no counts,
 * years, ids of 4+ digits, hashes). It is the same epistemology as induced completion
 * signals (round "a signal is induced, or human-attested, never guessed"): the hint is
 * WATCHED, not predicted, and a bad hint cannot do damage because the hint grammar falls
 * back to the model when the hint matches nothing or is ambiguous.
 *
 * Keyed by (exact url, subgoal), bounded, optionally persisted — a second run of the same
 * plan is where it pays: the step resolves `rule:hint` at zero model cost.
 */
import fs from "node:fs";
import type { Elem } from "./extraction.ts";
import { isVolatile } from "./signal-induction.ts";

/** Attributes in preference order: the most stable handle the element actually has. */
const HANDLE_ATTRS: Array<[keyof Elem, string]> = [
  ["data_test", "data-test"],
  ["id", "id"],
  ["name", "name"],
];

/**
 * One hint in the executor's grammar, or null when the element has no stable handle.
 * Never invents a selector from position — that is what makes locators rot.
 */
export function induceHint(elem: Elem | undefined | null): string | null {
  if (!elem) return null;
  for (const [field, attr] of HANDLE_ATTRS) {
    const raw = elem[field];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value || isVolatile(value)) continue;
    // the grammar's `=` branch case-folds, so store the raw value as-is
    return `[${attr}=${value}]`;
  }
  const token = String(elem.label ?? "").trim();
  const tag = String(elem.tag ?? "").trim();
  if (token && tag && !isVolatile(token) && token.length <= 48) {
    return `${tag}[near~${token}]`;
  }
  return null;
}

export interface HintMemoryLike {
  key(url: string, instruction: string): string;
  lookup(key: string): string | null;
  record(key: string, hint: string): void;
  /** Optional: report what the memory knows (the CLI prints it after a run). */
  stats?(): { entries: number; used: number };
}

export interface HintMemoryStats {
  entries: number;
  /** hints that a later run actually resolved with */
  used: number;
  /** observations that could not be turned into a stable hint */
  rejected: number;
}

export interface HintMemoryOptions {
  max?: number;
  path?: string | null;
}

export class HintMemory implements HintMemoryLike {
  private readonly max: number;
  private readonly path: string | null;
  private hints = new Map<string, string>();
  private counters = { used: 0, rejected: 0 };

  constructor(opts: HintMemoryOptions = {}) {
    this.max = Math.max(1, opts.max ?? 256);
    this.path = opts.path ?? null;
    if (this.path) this.load();
  }

  key(url: string, instruction: string): string {
    let h = 0;
    const s = instruction.trim().toLowerCase();
    for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return `${url}#${(h >>> 0).toString(36)}`;
  }

  lookup(key: string): string | null {
    const hint = this.hints.get(key);
    if (hint === undefined) return null;
    this.hints.delete(key);                     // LRU touch
    this.hints.set(key, hint);
    return hint;
  }

  record(key: string, hint: string): void {
    if (!hint) {
      this.counters.rejected += 1;
      return;
    }
    this.hints.delete(key);
    this.hints.set(key, hint);
    while (this.hints.size > this.max) {
      const oldest = this.hints.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.hints.delete(oldest);
    }
    this.save();
  }

  countUsed(n = 1): void {
    this.counters.used += n;
  }

  stats(): HintMemoryStats {
    return { entries: this.hints.size, ...this.counters };
  }

  toJSON(): { hints: Array<[string, string]> } {
    return { hints: [...this.hints] };
  }

  static fromJSON(data: { hints?: Array<[string, string]> }, opts: HintMemoryOptions = {}): HintMemory {
    const mem = new HintMemory({ ...opts, path: null });
    for (const [k, v] of data.hints ?? []) mem.hints.set(k, v);
    return mem;
  }

  private load(): void {
    if (!this.path || !fs.existsSync(this.path)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.path, "utf-8")) as { hints?: Array<[string, string]> };
      for (const [k, v] of data.hints ?? []) this.hints.set(k, v);
    } catch {
      /* unreadable memory is no memory */
    }
  }

  private save(): void {
    if (!this.path) return;
    try {
      fs.writeFileSync(this.path, JSON.stringify(this.toJSON()), "utf-8");
    } catch {
      /* diagnostic artifact only */
    }
  }
}

export function createHintMemory(opts: HintMemoryOptions = {}): HintMemory {
  return new HintMemory(opts);
}
