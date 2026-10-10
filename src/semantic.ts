/**
 * SemanticFlow —— 语义模板的匹配面与运行时站点档案（learned-hint store）。
 *
 * 方案：docs/SEMANTIC_FLOW_TRANSFER_PLAN.md（§2 三级解析 + 回填环）。
 *
 * 三级解析把 hint 从"人写的答案"变成"运行时学到的缓存"：
 *   ① SiteProfile[site][step] 有已学 hint → 规则解析，零模型零 token（稳态）
 *   ② 没有 → 语义步的 desc 进元素池，Laya 现场选（conf 闸/风险闸/actionability 照旧）
 *   ③ Laya 不过闸 → escalateFn（LLM"老师"）看同一份 criteria view 点名 ref
 *         成功且 DOM 信号成立 → 候选 hint 回填 SiteProfile（下次起走 ①）
 *         失败 → blocked，如实报告
 *
 * 本模块只提供两块纯机制，执行循环零改动：
 *   - `matchSemanticTarget`：把一个**语义目标**（role/text）对到 criteria view 里的唯一 ref。
 *     离线它是"老师"替身（scripted laya / scripted escalator）的匹配核；线上 LLM 老师
 *     收到的是同一份 criteria 渲染，所以它的提名面对的是同一个元素空间。
 *   - `LearnedStore` + `SiteProfileMemory`：站点档案的落盘与 `HintMemoryLike` 接缝。
 *     执行器本来就会在"laya/escalate 的提名让 DOM 信号成立"时调用 `hintMemory.record`
 *     （回填的门 = DOM 信号，唯一完成真值），并在没有 authored hint 时用
 *     `hintMemory.lookup` 取回学到的 hint——三级解析的 ① 和 ③ 回填因此**不需要改执行器**。
 *
 * 与 `hint-memory.ts`（按 url+指令哈希记忆、二进制不可读）的区别：档案按
 * （站点, 语义步 id）键控、人可读、跨运行累计 `replays_ok`——它是迁移的证据面，
 * 不是执行器的私有缓存。稳定句柄纪律沿用 induceHint：只认 data-test/id/name/near，
 * 永不从位置发明选择器。
 */
import fs from "node:fs";
import path from "node:path";
import type { HintMemoryLike } from "./hint-memory.ts";

/** 语义目标：模板携带的全部站点无关定位信息（代替硬 hint 成为模板默认）。 */
export interface SemanticTarget {
  /** widget 类：button | link | input | textarea | select。声明了就严格过滤。 */
  role?: string;
  /** 可见文案：等值优先、其次包含；字符串或候选列表（跨语言站点各写一个）。 */
  text?: string | string[];
  /** 额外的上下文过滤：criteria 行必须包含其中之一（不满足就淘汰）。 */
  near?: string | string[];
  /** 测试句柄（模板一般不写；写等价于把硬 hint 又放回模板）。 */
  data_test?: string | string[];
}

/** criteria 行的 aria role / 标签词 → 模板 role 词的别名表。 */
const ROLE_ALIASES: Record<string, readonly string[]> = {
  button: ["button"],
  link: ["a", "link"],
  input: ["input", "textbox"],
  textarea: ["textarea", "textbox"],
  select: ["select", "combobox"],
};

const asList = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/** criteria 行的第一个词（criteriaView 渲染为 `<role> "<label>"…`）。 */
function roleWordOf(line: string): string {
  return (line.match(/^([A-Za-z-]+)\s/) ?? [])[1]?.toLowerCase() ?? "";
}

/** criteria 行里引号包住的可见文案（找不到就返回 null——该行不参与文案匹配）。 */
export function labelOfCriteria(line: string): string | null {
  const m = line.match(/"([^"]*)"/);
  return m ? m[1]! : null;
}

function roleOk(target: SemanticTarget, line: string): boolean {
  const role = target.role;
  if (!role) return true;
  const aliases = ROLE_ALIASES[role];
  if (!aliases) return false;                    // 未知的 role 词：宁可空手也不猜
  return aliases.includes(roleWordOf(line));
}

/**
 * 语义目标 → criteria view 里的唯一 ref；歧义/落空如实返回 null（回落到下一级，
 * 绝不猜）。分稿与 hintMatch 同族：句柄 → 等值 → 包含，只在**最强非空档**内判定。
 */
export function matchSemanticTarget(
  target: SemanticTarget,
  crit: Record<string, string>,
): string | null {
  const entries = Object.entries(crit);
  const tests = asList(target.data_test);
  const texts = asList(target.text);
  const nears = asList(target.near);

  if (tests.length) {
    const hits = entries.filter(([, line]) => tests.some((t) => line.includes(`[test=${t}]`)));
    if (hits.length === 1) return hits[0]![0]!;
    if (hits.length > 1) return null;
    // 句柄写了个没出现的值：不猜文案档，直接落空（句柄是写死的强声明）。
    return null;
  }

  const nearHit = (line: string): boolean =>
    nears.length === 0 || nears.some((n) => line.includes(n));

  // 档 1：role 相符 + 文案等值
  const exact = entries.filter(([r, line]) => {
    if (!roleOk(target, line)) return false;
    const label = labelOfCriteria(line);
    return label !== null && texts.includes(label) && nearHit(line);
  });
  if (exact.length === 1) return exact[0]![0]!;
  if (exact.length > 1) return null;
  if (exact.length) return null;

  // 档 2：role 相符 + 文案包含 + （声明了 near 时）near 命中
  const contains = entries.filter(([r, line]) => {
    if (!roleOk(target, line)) return false;
    const label = labelOfCriteria(line);
    return label !== null && texts.some((t) => label.includes(t)) && nearHit(line);
  });
  if (contains.length === 1) return contains[0]![0]!;
  return null;
}

/**
 * 语义目标 → 执行器 hint 语法的一个字符串；只认 data-test 这一个稳定句柄，
 * 其余返回 null（同 induceHint 的纪律：绝不发明会烂掉的选择器）。模板的
 * text/near 目标走 laya/escalate 现场决策（②/③），学到的 hint 由回填环产生。
 */
export function semanticToHint(target: SemanticTarget): string | null {
  const tests = asList(target.data_test);
  if (tests.length === 1 && tests[0]!.trim()) return `[data-test=${tests[0]!.trim()}]`;
  return null;
}

/* ------------------------------------------------------------------ 文字系统路由 */

export type CheckpointId = "english" | "multilingual";
export const CHECKPOINTS: readonly CheckpointId[] = ["english", "multilingual"];

/**
 * 页面文字系统 → 站点 locale / checkpoint（方案 §3："locale/checkpoint 复用 Router 的
 * 文字系统路由结论"）。
 *
 * Router 的路由依据是**脚本检测**，不是置信度。离线可复现的同一依据有两条：
 * ① `<html lang>` 的声明（站点自己的陈述，最强）；② 没有声明时按 CJK 占比
 * （> 0.2 视为 CJK 页）。这不是第二套语义——只是把同一个判据落成可测的数据。
 */
export function observeLocale(
  lang: string | null | undefined, text: string,
): { locale: string; checkpoint: CheckpointId } {
  const declared = String(lang ?? "").trim().toLowerCase();
  if (declared) {
    const primary = declared.split(/[-_]/)[0] ?? declared;
    const cjk = primary === "zh" || primary === "ja" || primary === "ko";
    return { locale: declared, checkpoint: cjk ? "multilingual" : "english" };
  }
  const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
  const cjkCount = (text.match(CJK) ?? []).length;
  const letters = (text.match(/[A-Za-z\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const ratio = letters === 0 ? 0 : cjkCount / letters;
  return ratio > 0.2
    ? { locale: "zh", checkpoint: "multilingual" }
    : { locale: "en", checkpoint: "english" };
}

/* ------------------------------------------------------------------ 档案存储 */

/** 一个已学的步级条目：hint + 重放通过次数（回填门的证据）。 */
export interface LearnedStepEntry {
  hint: string;
  replays_ok: number;
  /** 回填来源：laya（②现场）还是 escalate（③老师点名）——报告面用。 */
  method?: "laya" | "escalate";
  /** 已学 hint 连续失败的次数（重放成功即清零）——drift 判定用。 */
  failures?: number;
}

/** 一个站点的已学档案：只存学到的（authored 的站点知识在模板包里，不在这）。 */
export interface LearnedSiteFile {
  host: string;
  steps: Record<string, LearnedStepEntry>;
}

const ENTRY_METHODS = new Set(["laya", "escalate"]);

function validateLearned(site: string, file: LearnedSiteFile): void {
  if (typeof file.host !== "string" || !file.host) {
    throw new Error(`learned profile ${site}: host must be a non-empty string`);
  }
  if (typeof file.steps !== "object" || file.steps === null || Array.isArray(file.steps)) {
    throw new Error(`learned profile ${site}: steps must be an object`);
  }
  for (const [stepId, e] of Object.entries(file.steps)) {
    if (typeof e.hint !== "string" || !e.hint.trim()) {
      throw new Error(`learned profile ${site}.${stepId}: hint must be a non-empty string`);
    }
    if (!Number.isInteger(e.replays_ok) || e.replays_ok < 0) {
      throw new Error(`learned profile ${site}.${stepId}: replays_ok must be a non-negative integer`);
    }
    if (e.method !== undefined && !ENTRY_METHODS.has(e.method)) {
      throw new Error(`learned profile ${site}.${stepId}: method must be laya|escalate`);
    }
    if (e.failures !== undefined && (!Number.isInteger(e.failures) || e.failures < 0)) {
      throw new Error(`learned profile ${site}.${stepId}: failures must be a non-negative integer`);
    }
  }
}

/** 站点档案的落盘点：`<dir>/<site>.profile.json`（人可读、可提交为迁移证据）。 */
export class LearnedStore {
  /** 显式字段而非 parameter property：工具脚本跑在 `node --experimental-strip-types` 下，
   *  它剥不掉参数属性（tests/project.test.ts 钉住这一条）。 */
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }


  pathFor(site: string): string {
    return path.join(this.dir, `${site}.profile.json`);
  }

  load(site: string): LearnedSiteFile {
    const p = this.pathFor(site);
    if (!fs.existsSync(p)) return { host: site, steps: {} };
    let file: LearnedSiteFile;
    try {
      file = JSON.parse(fs.readFileSync(p, "utf-8")) as LearnedSiteFile;
    } catch (e) {
      // 档案是**证据面**：坏掉的证据要响亮地报，而不是悄悄当没有（那是 outcome-memory
      // 的宽容口径——缓存坏一台机器无妨；证据坏说明有人手改了它）。
      throw new Error(`learned profile ${this.pathFor(site)} is not valid JSON: `
        + `${e instanceof Error ? e.message : String(e)}`);
    }
    validateLearned(site, file);
    return file;
  }

  save(site: string, file: LearnedSiteFile): void {
    validateLearned(site, file);
    fs.mkdirSync(this.dir, { recursive: true });
    // 原子写：先落临时文件再改名，半截文件不会冒充一份档案。
    const p = this.pathFor(site);
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, p);
  }
}

/**
 * `HintMemoryLike` 的站点档案实现 —— 三级解析在执行器侧的全部接缝。
 *
 * 执行器调用约定（src/executor.ts，零改动复用）：
 *   - `key(url, instruction)`：本运行只有一个站点，键 = 站点 + 指令哈希；
 *     `registerSteps` 把（desc → 语义步 id）预先注册进来，档案因此按**语义步**键控。
 *   - `lookup(key)`：执行器在没有 authored hint 时取回学到的 hint（①稳态路径，
 *     与 authored hint 同权威——hint 语法不变，落空/歧义仍回落到模型）。
 *   - `record(key, hint)`：执行器在"laya/escalate 的提名让 DOM 信号成立"时调用
 *     （③回填路径，门 = DOM 信号）。新条目 `replays_ok: 0`——它还没有被重放验证过；
 *     后续运行真的靠它以规则命中并完成，才由运行器把 `replays_ok` +1（可复现重放计数）。
 */
export class SiteProfileMemory implements HintMemoryLike {
  /** 本次运行新回填的语义步 id（报告面用："written back N"）。 */
  readonly recordedThisRun = new Set<string>();
  /** 本次运行以已学 hint 规则命中的语义步 id（重放计数用）。 */
  readonly replayedThisRun = new Set<string>();

  private readonly file: LearnedSiteFile;
  private readonly keyToStep = new Map<string, string>();
  private readonly store: LearnedStore;
  private readonly site: string;
  /**
   * 回填门（红线 2）：staged 模式下 `record` **只写内存**，直到 `commitVerified`
   * 把"整跑重放里真的以规则命中并完成"的条目落盘，其余条目按原值撤回。
   * 这是 learn 的纪律（不可复现即不存）在站点档案上的复用。
   */
  private readonly staged: boolean;
  /** 只读（`writeProfile:false`）：一切改动只留在内存，磁盘上什么都不写。 */
  private readonly readOnly: boolean;
  /** staged 模式下本次新写的步 id（commitVerified 的输入域）。 */
  private readonly pending = new Set<string>();
  /** staged 模式下每个 pending 步在**本次写入之前**的条目（撤回用）。 */
  private readonly prior = new Map<string, LearnedStepEntry | undefined>();

  constructor(
    store: LearnedStore,
    site: string,
    /** authored 档案里的步级 hint（模板包可携带已知站的先验），learned 覆盖 authored。 */
    baseSteps: Record<string, LearnedStepEntry> = {},
    opts: { staged?: boolean; readOnly?: boolean } = {},
  ) {
    this.store = store;
    this.site = site;
    this.staged = opts.staged === true;
    this.readOnly = opts.readOnly === true;
    const learned = store.load(site);
    this.file = { host: learned.host, steps: { ...baseSteps, ...learned.steps } };
  }

  /** 运行器在编译模板后注册（desc → stepId）；重复注册同一 desc 以最后一次为准。 */
  registerSteps(pairs: Array<[string, string]>): void {
    for (const [desc, stepId] of pairs) this.keyToStep.set(this.hashKey(desc), stepId);
  }

  /** 执行器侧的键：一个运行只面对一个站点，所以 url 不进键。 */
  key(_url: string, instruction: string): string {
    return this.hashKey(instruction);
  }

  lookup(key: string): string | null {
    const stepId = this.keyToStep.get(key);
    if (stepId === undefined) return null;
    const entry = this.file.steps[stepId];
    if (entry === undefined) return null;
    return entry.hint;
  }

  record(key: string, hint: string): void {
    const stepId = this.keyToStep.get(key);
    if (stepId === undefined || !hint) return;   // 注册外的指令（不该发生）：不落盘
    if (this.staged && !this.pending.has(stepId)) this.prior.set(stepId, this.file.steps[stepId]);
    const prior = this.file.steps[stepId];
    // 重放计数只增不清零：一条 hint 被验证过 N 次，改写 hint 才重新从 0 计数。
    this.file.steps[stepId] = {
      hint, replays_ok: prior && prior.hint === hint ? prior.replays_ok : 0,
      ...(prior && prior.hint === hint && prior.failures ? { failures: prior.failures } : {}),
    };
    this.recordedThisRun.add(stepId);
    if (this.staged) {
      this.pending.add(stepId);
      return;                                     // 回填门：重放通过前不落盘
    }
    this.persist();
  }

  /** staged 模式下本次新回填、尚未过重放门的步 id。 */
  stagedSteps(): string[] {
    return [...this.pending];
  }

  /**
   * 回填门的落盘点：`verified` 里的步**重放通过**（整跑里以已学 hint 规则命中并完成）
   * → 落盘并把 `replays_ok` +1；不在里面的步撤回（新条目删除、旧条目还原）。
   * 返回落盘与撤回的步 id（报告面分别记 backfilled / unverified）。
   */
  commitVerified(verified: ReadonlySet<string>): { committed: string[]; dropped: string[] } {
    const committed: string[] = [];
    const dropped: string[] = [];
    for (const stepId of this.pending) {
      const entry = this.file.steps[stepId];
      if (verified.has(stepId) && entry) {
        entry.replays_ok += 1;                    // 这一次重放真的靠它完成
        delete entry.failures;
        this.replayedThisRun.add(stepId);
        committed.push(stepId);
        continue;
      }
      const before = this.prior.get(stepId);
      if (before === undefined) delete this.file.steps[stepId];
      else this.file.steps[stepId] = before;
      this.recordedThisRun.delete(stepId);
      dropped.push(stepId);
    }
    this.pending.clear();
    this.prior.clear();
    this.persist();
    return { committed, dropped };
  }

  /** 撤掉所有尚未过门的条目（不写任何新东西，只把档案还原）。 */
  discardPending(): string[] {
    const dropped = this.commitVerified(new Set()).dropped;
    return dropped;
  }

  /**
   * 显式关掉回填门（测试/消融）：本次新写的条目按现状落盘，`replays_ok` 不 +1
   * ——它还没有被重放验证过，这一点在档案里如实可见。
   */
  commitAll(): string[] {
    const committed = [...this.pending];
    this.pending.clear();
    this.prior.clear();
    this.persist();
    return committed;
  }

  /** 把内存里的计数（重放次数 / 连续失败）落盘；没有新条目时也要调。 */
  flush(): void {
    this.persist();
  }

  /** 一条已学 hint 用上了但这一步没完成 → 记一次失败（drift 判定）。 */
  countFailure(stepId: string): number {
    const entry = this.file.steps[stepId];
    if (entry === undefined) return 0;
    entry.failures = (entry.failures ?? 0) + 1;
    if (!this.staged) this.persist();
    return entry.failures;
  }

  /** 一条已学 hint 重放成功 → 连续失败计数清零（自愈）。 */
  resetFailures(stepId: string): void {
    const entry = this.file.steps[stepId];
    if (entry === undefined || !entry.failures) return;
    delete entry.failures;
    if (!this.staged) this.persist();
  }

  /** drift：这条 hint 连续 N 次没让信号成立 → 不再信任它（下次运行重新学）。 */
  dropHint(stepId: string): string | null {
    const entry = this.file.steps[stepId];
    if (entry === undefined) return null;
    delete this.file.steps[stepId];
    this.recordedThisRun.delete(stepId);
    this.pending.delete(stepId);
    this.prior.delete(stepId);
    if (!this.staged) this.persist();
    return entry.hint;
  }

  /** 运行器在步完成后调用：这条已学 hint 真的以规则命中且步完成 → 重放 +1。 */
  countReplay(stepId: string): void {
    const entry = this.file.steps[stepId];
    if (entry === undefined) return;
    entry.replays_ok += 1;
    delete entry.failures;                        // 重放成功即清零：连续失败才算 drift
    this.replayedThisRun.add(stepId);
    if (!this.staged) this.persist();
  }

  /** 运行器回填后补记来源（laya 还是 escalate 老师）——只影响报告面。 */
  labelMethod(stepId: string, method: "laya" | "escalate"): void {
    const entry = this.file.steps[stepId];
    if (entry === undefined) return;
    entry.method = method;
    if (!this.staged) this.persist();
  }

  getSteps(): Record<string, LearnedStepEntry> {
    return JSON.parse(JSON.stringify(this.file.steps)) as Record<string, LearnedStepEntry>;
  }

  stats(): { entries: number; used: number } {
    return { entries: Object.keys(this.file.steps).length, used: this.replayedThisRun.size };
  }

  private persist(): void {
    if (this.readOnly) return;
    this.store.save(this.site, this.file);
  }

  private hashKey(instruction: string): string {
    let h = 0;
    const s = instruction.trim();
    for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return `${this.site}#${(h >>> 0).toString(36)}`;
  }
}
