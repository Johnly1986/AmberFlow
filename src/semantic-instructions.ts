/**
 * 指令学习存储（NL Flow S2，docs/NL_FLOW_DESIGN.md §7）——"这一步用哪条指令"的档案面。
 *
 * 与 `SiteProfileMemory`（hint 学习）同一套纪律，存的是 S2 提名梯级的产物：
 *
 *   - **staged 回填门（红线 2 同款）**：`recordInstruction` 只写内存；`commitVerified`
 *     把"同一次运行的零模型重放里真的靠它完成"的条目落盘并把 `replays_ok` +1，
 *     其余按原值撤回——不可复现即不存。
 *   - **drift 撤下**：已学指令连续 N 次（默认 2）没让信号成立 → `dropInstruction`
 *     撤下条目，下次运行重新提名（deopt，不是拿烂映射硬跑）。
 *   - **证据面**：人可读的 `<site>.profile.json` 的 `instructions` 段；坏档案
 *     （闭集外的指令名、负数计数）在 `LearnedStore.load` 处响亮报错。
 *
 * 与 B2（定位评审"两套学习库"）的关系：本类**刻意镜像** `SiteProfileMemory` 的形状，
 * 让"统一 LearningStore"将来有一条等价迁移路；合并前先让纪律一致。
 */
import type { NominationMemory } from "./nominate.ts";
import {
  LearnedStore,
  type LearnedInstructionEntry,
  type LearnedSiteFile,
} from "./semantic.ts";
import { isInstructionName } from "./instructions.ts";

export interface InstructionMemoryOptions {
  staged?: boolean;
  readOnly?: boolean;
  /** drift 阈值：连续 N 次失败撤下（缺省 2，与语义流 hint 的缺省一致）。 */
  driftThreshold?: number;
}

export class InstructionProfileMemory implements NominationMemory {
  /** 本次运行新回填的步 id（报告面用）。 */
  readonly recordedThisRun = new Set<string>();
  /** 本次运行靠已学映射以提名命中且完成的步 id（重放计数用）。 */
  readonly replayedThisRun = new Set<string>();

  private readonly file: LearnedSiteFile;
  private readonly store: LearnedStore;
  private readonly site: string;
  private readonly staged: boolean;
  private readonly readOnly: boolean;
  private readonly driftThreshold: number;
  private readonly pending = new Set<string>();
  private readonly prior = new Map<string, LearnedInstructionEntry | undefined>();

  constructor(store: LearnedStore, site: string, opts: InstructionMemoryOptions = {}) {
    this.store = store;
    this.site = site;
    this.staged = opts.staged === true;
    this.readOnly = opts.readOnly === true;
    this.driftThreshold = Math.max(1, opts.driftThreshold ?? 2);
    const learned = store.load(site);
    // steps 段原样携带——指令落盘不得把 hint 段悄悄丢掉（与 SiteProfileMemory 对称）。
    this.file = {
      host: learned.host,
      steps: learned.steps,
      ...(learned.instructions ? { instructions: learned.instructions } : {}),
    };
  }

  /** ② 档案档（nominate.ts 的 `NominationMemory`）：没学过 / 已被 drift 撤下 ⇒ null。 */
  lookupInstruction(stepKey: string): string | null {
    const e = this.file.instructions?.[stepKey];
    return e ? e.instruction : null;
  }

  /**
   * 回填一条提名（门 = 该步的完成信号，由调用方把握）。staged 模式只进内存；
   * 改写指令 ⇒ `replays_ok` 归零（换映射 = 重新挣信任），同值保持计数。
   */
  recordInstruction(stepKey: string, instruction: string, method: "rule" | "model" | "teacher" | "enumerate"): void {
    if (!isInstructionName(instruction)) {
      throw new Error(`instruction memory ${this.site}.${stepKey}: `
        + `${JSON.stringify(instruction)} is not in the closed set (never invent an instruction)`);
    }
    if (this.file.instructions === undefined) this.file.instructions = {};
    if (this.staged && !this.pending.has(stepKey)) this.prior.set(stepKey, this.file.instructions[stepKey]);
    const prior = this.file.instructions[stepKey];
    this.file.instructions[stepKey] = {
      instruction,
      replays_ok: prior && prior.instruction === instruction ? prior.replays_ok : 0,
      method,
      ...(prior && prior.instruction === instruction && prior.failures ? { failures: prior.failures } : {}),
    };
    this.recordedThisRun.add(stepKey);
    if (this.staged) {
      this.pending.add(stepKey);
      return;
    }
    this.persist();
  }

  /** staged 模式下本次新回填、尚未过重放门的步 id。 */
  stagedSteps(): string[] {
    return [...this.pending];
  }

  /**
   * 回填门的落盘点：`verified` 里的步重放通过 → `replays_ok` +1、失败清零；
   * 不在里面的按原值撤回（新条目删除、旧条目还原）。
   */
  commitVerified(verified: ReadonlySet<string>): { committed: string[]; dropped: string[] } {
    const committed: string[] = [];
    const dropped: string[] = [];
    for (const stepKey of this.pending) {
      const entry = this.file.instructions?.[stepKey];
      if (verified.has(stepKey) && entry) {
        entry.replays_ok += 1;
        delete entry.failures;
        this.replayedThisRun.add(stepKey);
        committed.push(stepKey);
        continue;
      }
      const before = this.prior.get(stepKey);
      if (before === undefined) delete this.file.instructions![stepKey];
      else this.file.instructions![stepKey] = before;
      this.recordedThisRun.delete(stepKey);
      dropped.push(stepKey);
    }
    this.pending.clear();
    this.prior.clear();
    this.persist();
    return { committed, dropped };
  }

  /** 撤掉所有尚未过门的条目。 */
  discardPending(): string[] {
    return this.commitVerified(new Set()).dropped;
  }

  /** 一条已学指令用上了但这一步没完成 → 记一次失败；达到阈值即 drift（调用方调 dropInstruction）。 */
  countFailure(stepKey: string): number {
    const entry = this.file.instructions?.[stepKey];
    if (entry === undefined) return 0;
    entry.failures = (entry.failures ?? 0) + 1;
    if (!this.staged) this.persist();
    return entry.failures;
  }

  /** 是否已到 drift 阈值（调用方据此撤下并上报）。 */
  isDrifted(stepKey: string): boolean {
    const entry = this.file.instructions?.[stepKey];
    return entry !== undefined && (entry.failures ?? 0) >= this.driftThreshold;
  }

  /** drift 撤下：删条目（下次运行重新提名）；返回被撤的指令（报告面用）。 */
  dropInstruction(stepKey: string): string | null {
    const entry = this.file.instructions?.[stepKey];
    if (entry === undefined) return null;
    delete this.file.instructions![stepKey];
    this.recordedThisRun.delete(stepKey);
    this.pending.delete(stepKey);
    this.prior.delete(stepKey);
    if (!this.staged) this.persist();
    return entry.instruction;
  }

  /** 重放成功 → 连续失败清零（自愈）。 */
  resetFailures(stepKey: string): void {
    const entry = this.file.instructions?.[stepKey];
    if (entry === undefined || !entry.failures) return;
    delete entry.failures;
    if (!this.staged) this.persist();
  }

  /**
   * 运行器在步完成后调用：这次运行真的靠已学映射完成 → `replays_ok` +1（未 staged 的
   * 日常路径；staged 路径的计数走 `commitVerified`）。与 `SiteProfileMemory.countReplay` 同款。
   */
  countReplay(stepKey: string): void {
    const entry = this.file.instructions?.[stepKey];
    if (entry === undefined) return;
    entry.replays_ok += 1;
    delete entry.failures;                        // 重放成功即清零：连续失败才算 drift
    this.replayedThisRun.add(stepKey);
    if (!this.staged) this.persist();
  }

  flush(): void {
    this.persist();
  }

  getInstructions(): Record<string, LearnedInstructionEntry> {
    return JSON.parse(JSON.stringify(this.file.instructions ?? {})) as Record<string, LearnedInstructionEntry>;
  }

  stats(): { entries: number; used: number } {
    return { entries: Object.keys(this.file.instructions ?? {}).length, used: this.replayedThisRun.size };
  }

  private persist(): void {
    if (this.readOnly) return;
    // 读-合并-写：本类只拥有 instructions 段——同运行的 hint 记忆可能刚写过 steps 段，
    // 拿着构造时的旧快照整体写回会把它清掉（lost-update）。重读最新档案、只覆盖自己的段。
    const fresh = this.store.load(this.site);
    this.store.save(this.site, {
      host: fresh.host,
      steps: fresh.steps,
      instructions: this.file.instructions ?? {},
    });
  }
}

export function createInstructionMemory(
  store: LearnedStore, site: string, opts: InstructionMemoryOptions = {},
): InstructionProfileMemory {
  return new InstructionProfileMemory(store, site, opts);
}
