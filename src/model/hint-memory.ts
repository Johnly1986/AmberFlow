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
import type { Elem, ElemPool } from "../engine/extraction.ts";
import { hintMatch, suggestHints } from "../engine/rules.ts";
import { isVolatile } from "../flow/signal-induction.ts";

/** Attributes in preference order: the most stable handle the element actually has. */
const HANDLE_ATTRS: Array<[keyof Elem, string]> = [
  ["data_test", "data-test"],
  ["id", "id"],
  ["name", "name"],
];

/**
 * E5（WITHIN_PARITY_PLAN §7）：子帧元素的记忆产物带 ` frame:<own origin>` 尾缀。
 *
 * 为什么：一条记忆 hint 只在**同一个 (url, subgoal)** 上生效，而同一个 url 下可能有
 * 同签名的父子/兄弟 frame；不带帧限定的记忆回放会歧义 → 回退模型（无误动作，但记忆
 * 价值打折）。`frame_path` 非空 ⇔ 非主帧（frame_path 省略 = 主帧，见 extraction.Elem）
 * ——主帧元素**逐字节不变**（绝大多数记忆不受影响）。未知 origin 帧（frame_origin /
 * frame_path 两字段皆缺，如 about:blank/srcdoc）**不追加**：任何 `frame:` 都命中不了
 * 这种帧，加了只会得到一条死 hint——保持既有"歧义/未命中 → 回模型"的行为。
 *
 * 同一 origin 的父子帧仍可能歧义（D2 边界：own origin 单段区分不了同源父子）——
 * 这属于既有 firstIfSame 合并语义，不在这里猜更长链（记忆侧没有帧完整链）。
 */
function frameSuffixOf(elem: Elem): string {
  const path = elem.frame_path;
  const origin = typeof elem.frame_origin === "string" ? elem.frame_origin.trim() : "";
  if (!Array.isArray(path) || path.length === 0 || origin === "") return "";
  return ` frame:${origin}`;
}

/**
 * One hint in the executor's grammar, or null when the element has no stable handle.
 * Never invents a selector from position — that is what makes locators rot.
 *
 * E5：子帧元素在稳定句柄后追加 ` frame:<own origin>`（主帧 / 未知 origin 帧不加）——
 * 回放面 `currentHint → hintMatch → parseHint` 已支持尾缀，消费链路无需新增代码。
 *
 * F82/F83 批 3 首项（记忆产物带行锚）：`elems` 在手时，若普通形状（identity / near~label）
 * **不自证唯一**（hintMatch 歧义或落空）且元素是**同文案重复组成员**（row_texts/row_index
 * 在场），复用 `suggestHints` 第 5/6 档纪律取行锚候选（内容候选优先、row-index 仅内容不可分
 * ——同一 push 自证唯一，不发明第二套生成逻辑；与歧义面收编同判例），并按 E5 先例追加帧尾缀。
 * **非 dup / 已唯一 / 不传 elems 场景产物逐字节不变**（全部既有调用点单参调用不受影响）。
 */
export function induceHint(elem: Elem | undefined | null, elems?: ElemPool): string | null {
  if (!elem) return null;
  for (const [field, attr] of HANDLE_ATTRS) {
    const raw = elem[field];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value || isVolatile(value)) continue;
    // the grammar's `=` branch case-folds, so store the raw value as-is
    return finishLearnedHint(elem, `[${attr}=${value}]${frameSuffixOf(elem)}`, elems);
  }
  const token = String(elem.label ?? "").trim();
  const tag = String(elem.tag ?? "").trim();
  if (token && tag && !isVolatile(token) && token.length <= 48) {
    return finishLearnedHint(elem, `${tag}[near~${token}]${frameSuffixOf(elem)}`, elems);
  }
  return null;
}

/**
 * F82/F83 批 3 首项：普通形状不自证唯一 + 重复组成员 ⇒ suggestHints 第 5/6 档行锚候选。
 * 自证口径 = `hintMatch(base, elems) === elem.ref`（恰好唯一命中；歧义/落空都算不自证）。
 * 行锚候选取 `suggestHints(elem, elems)` 输出里第一条含 ` in-row:` / ` row-index:` 的候选
 * （该函数内部同一 push 自证唯一才保留；第 5 档内容候选优先、第 6 档 row-index 仅内容
 * 不可分——复用，不复制）。elems 缺省 / 自证唯一 / 非重复组 = 原产物逐字节返回。
 */
function finishLearnedHint(elem: Elem, base: string, elems?: ElemPool): string {
  if (elems === undefined) return base;
  if (hintMatch(base, elems) === elem.ref) return base;   // 已自证唯一：逐字节不变
  const dupMember = typeof elem.row_index === "number" || Array.isArray(elem.row_texts);
  if (!dupMember) return base;                            // 非重复组：行锚恒落空，不产死 hint
  const rowAnchor = suggestHints(elem, elems)
    .find((h) => h.includes(" in-row:") || h.includes(" row-index:"));
  return rowAnchor !== undefined ? `${rowAnchor}${frameSuffixOf(elem)}` : base;
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
