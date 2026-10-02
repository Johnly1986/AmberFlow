/**
 * Outcome memory — the other half of decision memory.
 *
 * `withDecisionCache` memoises what the model DECIDED. This remembers what HAPPENED:
 * an element that was clicked and changed nothing (the executor calls that "inert")
 * is remembered against the page+subgoal it failed on, so a retry, a resume or a
 * re-run does not walk into it again.
 *
 * Why this is the right shape, from this repo's own measurements (rounds 2-3):
 * wrong actions on real pages are not low-confidence pickups — they are CONFIDENT
 * clicks on plausible-but-inert elements (the worst measured one had confidence
 * 0.890). Confidence gates cannot see that; an observed outcome can.
 *
 * Scope rules, so this can never turn into a stale blacklist:
 *   - key = the exact page URL + the subgoal text -> a different page or a different
 *     goal is a different memory;
 *   - a remembered element is only skipped while OTHER candidates remain (never
 *     empties the pool);
 *   - seeing the same element work CLEARS its mark (pages change);
 *   - bounded: keys and per-key entries are LRU-capped.
 *
 * The mark is expressed as an element *signature* (tag|label|href|data-test), the same
 * identity the executor's forbiddance uses — refs are positional and re-indexed on
 * every scan, so they must never be persisted.
 */
import fs from "node:fs";

export type Outcome = "inert" | "effective";

export interface OutcomeMemoryStats {
  states: number;
  entries: number;
  /** times a remembered element was actually skipped */
  prevented: number;
  /** times a mark was cleared because the element worked */
  cleared: number;
}

export interface OutcomeMemoryLike {
  key(url: string, instruction: string): string;
  inertIn(key: string): ReadonlySet<string>;
  record(key: string, signature: string, outcome: Outcome): void;
  stats(): OutcomeMemoryStats;
}

export interface OutcomeMemoryOptions {
  /** Max distinct (url, subgoal) keys remembered. Default 256. */
  maxStates?: number;
  /** Max inert signatures per key. Default 32. */
  maxPerState?: number;
  /** Load/save state as JSON (resume across processes). */
  path?: string | null;
}

export class OutcomeMemory implements OutcomeMemoryLike {
  private readonly maxStates: number;
  private readonly maxPerState: number;
  private readonly path: string | null;
  /** insertion-ordered: used as an LRU (re-inserting a key moves it to the end) */
  private states = new Map<string, Set<string>>();
  private counters = { prevented: 0, cleared: 0 };
  private dirty = false;

  constructor(opts: OutcomeMemoryOptions = {}) {
    this.maxStates = Math.max(1, opts.maxStates ?? 256);
    this.maxPerState = Math.max(1, opts.maxPerState ?? 32);
    this.path = opts.path ?? null;
    if (this.path) this.load();
  }

  /** Stable key: the exact page plus the subgoal it was acting on. */
  key(url: string, instruction: string): string {
    let h = 0;
    const s = instruction.trim().toLowerCase();
    for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return `${url}#${(h >>> 0).toString(36)}`;
  }

  inertIn(key: string): ReadonlySet<string> {
    const set = this.states.get(key);
    if (!set) return EMPTY;
    // touch for LRU
    this.states.delete(key);
    this.states.set(key, set);
    return set;
  }

  record(key: string, signature: string, outcome: Outcome): void {
    let set = this.states.get(key);
    if (outcome === "effective") {
      if (set?.delete(signature)) {
        this.counters.cleared += 1;
        this.dirty = true;
        if (!set.size) this.states.delete(key);
        else { this.states.delete(key); this.states.set(key, set); }
        this.save();
      }
      return;
    }
    if (!set) {
      set = new Set();
      this.states.set(key, set);
    } else {
      this.states.delete(key);
      this.states.set(key, set);
    }
    if (!set.has(signature)) {
      set.add(signature);
      while (set.size > this.maxPerState) {
        const oldest = set.values().next().value as string | undefined;
        if (oldest === undefined) break;
        set.delete(oldest);
      }
      this.dirty = true;
    }
    while (this.states.size > this.maxStates) {
      const oldest = this.states.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.states.delete(oldest);
    }
    this.save();
  }

  /** Count a skip that the executor actually performed (for the audit). */
  countPrevented(n = 1): void {
    this.counters.prevented += n;
  }

  stats(): OutcomeMemoryStats {
    let entries = 0;
    for (const set of this.states.values()) entries += set.size;
    return { states: this.states.size, entries, ...this.counters };
  }

  toJSON(): { states: Array<[string, string[]]> } {
    return { states: [...this.states].map(([k, v]) => [k, [...v]] as [string, string[]]) };
  }

  static fromJSON(data: { states?: Array<[string, string[]]> }, opts: OutcomeMemoryOptions = {}): OutcomeMemory {
    const mem = new OutcomeMemory({ ...opts, path: null });
    for (const [k, v] of data.states ?? []) {
      const set = new Set(v);
      if (set.size) mem.states.set(k, set);
    }
    return mem;
  }

  private load(): void {
    if (!this.path || !fs.existsSync(this.path)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.path, "utf-8")) as { states?: Array<[string, string[]]> };
      for (const [k, v] of data.states ?? []) {
        const set = new Set(v);
        if (set.size) this.states.set(k, set);
      }
    } catch {
      /* unreadable memory is no memory: never break a run over it */
    }
  }

  private save(): void {
    if (!this.path || !this.dirty) return;
    this.dirty = false;
    try {
      fs.writeFileSync(this.path, JSON.stringify(this.toJSON()), "utf-8");
    } catch {
      /* diagnostic artifact only */
    }
  }
}

const EMPTY: ReadonlySet<string> = new Set<string>();

export function createOutcomeMemory(opts: OutcomeMemoryOptions = {}): OutcomeMemory {
  return new OutcomeMemory(opts);
}
