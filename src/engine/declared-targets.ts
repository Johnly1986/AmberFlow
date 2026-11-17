/**
 * 声明目标（FW8 身份回捞 / DRF 声明目标解析）的**逐步解析状态单点**。
 *
 * 为什么单独成对象：这两面（identity recovery / declared-DOM resolution）的状态与逻辑原本散在
 * `BrowserMiddleware.run()` 的每步局部闭包里——命令空间 walk 与 act-hint 解析两处各写一遍，
 * 去重集合、cleanup 生命周期、歧义停因与隐藏证据的记账只能靠读两段代码确认「是不是同一份」。
 * 收敛成**每步实例化**的 resolver 后：
 *   - 状态 owner 唯一：`identityTried/identity/identityStop/identityHidden` 与
 *     `declaredTried/declared/declaredStop/declaredHidden/declaredMiss`；
 *   - 两面共用 `tryIdentity` / `tryDeclared`：证据形状走 `evidence.ts` 纯函数，文案模板只有一份；
 *   - cleanup 生命周期：`cleanupIdentity()`（FW8 章 + 一并清 DRF 章）/ `cleanupDeclared()` 各一处。
 *
 * 纪律：
 *   - 每步新建一个（不得跨步复用）：去重集合是 per-step 语义——同一步同一条 hint 只尝试一次；
 *   - 无模块级可变状态；无 Playwright 具体类型（只用 engine 结构类型/纯函数）；
 *   - 只做解析与记账，不改动作/判定：歧义只写结构化停因字段，由调用方在同一位置读。
 */
import { declaredLookup, formatDeclaredCandidates } from "./declared.ts";
import { formatIdentityCandidates, identityLookup } from "./identity.ts";
import type { Elem } from "./extraction.ts";
import type { AnyPage, SkippedAction, StopCode } from "./executor-types.ts";
import type { HintMatchOptions } from "./rules.ts";
import type { SurfacePolicy } from "./surface.ts";
import type {
  DeclaredFacts, DeclaredHiddenFacts, DeclaredMissFacts, IdentityFacts, IdentityHiddenFacts,
} from "./evidence.ts";

/** resolver 的显式依赖（不读外层闭包状态；phase 拆分时可整体传参）。 */
export interface DeclaredTargetsDeps {
  readonly pg: AnyPage;
  /** 步号：只进停因文案（与原 run() 内文案同源）。 */
  readonly stepNo: number;
  /** skipped 记账（与 run() 同一数组/同一去重）。 */
  readonly noteSkipped: (s: SkippedAction) => void;
  /** 池侧 hint 选项（`this._hintOpts()` 的转口；DRF/池判定同一口径）。 */
  readonly hintOpts: () => HintMatchOptions;
  readonly surfacePolicy: SurfacePolicy;
  readonly frameHosts: string[] | null;
  /** `meta.policy.target_resolution === "declared"` 才启用 DRF。 */
  readonly targetResolutionDeclared: boolean;
  /** DRF 隐藏命中的 run 级旁路记账（原 `lastDeclaredHiddenBox`；报告诊断用）。 */
  readonly onDeclaredHidden?: (facts: DeclaredHiddenFacts) => void;
}

/** 一次 FW8 尝试的面向文案参数（命令面/act-hint 面各自给；正文模板仍共享）。 */
export interface IdentityAttemptOptions {
  /** 停因 reason 的前缀（已含 target）；命令面 = `command "<id>" identity target "<t>"`。 */
  readonly reasonPrefix: string;
  /** 收尾句的名词（命令面 `declaration` / act-hint 面 `hint`）。 */
  readonly narrowNoun: string;
  /** 命令面的 skipped 记账需要 command_id；act-hint 面无此键（键集逐字节不变）。 */
  readonly commandId?: string;
}

/** FW8 一次尝试的结果（状态已写进 resolver；这里只表达调用方要做的分支）。 */
export type IdentityAttempt =
  | { readonly kind: "skipped" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "hidden" }
  | { readonly kind: "row"; readonly ref: string; readonly el: Elem };

export interface DeclaredTargetsResolver {
  /** FW8 命中事实（证据面读；无命中 = null）。 */
  identity: IdentityFacts | null;
  /** FW8 已给出的结构化停因（歧义）；调用方在既有位置统一停。 */
  identityStop: { code: StopCode; reason: string } | null;
  /** FW8 命中但全不可见（按 0 处理；只留诊断证据）。 */
  identityHidden: IdentityHiddenFacts | null;
  /** DRF 已给出的结构化停因（歧义/首版能力面）。 */
  declaredStop: { code: StopCode; reason: string } | null;
  /** DRF 匹配到但全不可见（按 0 处理；只留诊断证据）。 */
  declaredHidden: DeclaredHiddenFacts | null;
  /** DRF 实跑且可见零命中（`total`/`hidden` 实测；停因尾缀回显）。 */
  declaredMiss: DeclaredMissFacts | null;
  /** 同一步同一条 hint 只尝试一次；未命中/歧义/全隐藏都算已尝试。 */
  tryIdentity(target: string, opts: IdentityAttemptOptions): Promise<IdentityAttempt>;
  /** 同一步同一条 hint 只跑一次 DRF；命中返回行，否则 null（诊断写进字段）。 */
  tryDeclared(target: string, op: string): Promise<{ ref: string; el: Elem } | null>;
  getDeclared(): DeclaredFacts | null;
  setDeclared(v: DeclaredFacts | null): void;
  getDeclaredHidden(): DeclaredHiddenFacts | null;
  /** 清 FW8 章（顺带清 DRF 章——两者同一动作定位窗口）。 */
  cleanupIdentity(): Promise<void>;
  /** 只清 DRF 章。 */
  cleanupDeclared(): Promise<void>;
}

/**
 * 每步一个的声明目标 resolver（stepNo/pg 固定；状态全部实例化）。
 * `identityTried`/`declaredTried` 的 per-step 语义 = 每次 run 的每步新建本对象。
 */
export function createDeclaredTargetsResolver(deps: DeclaredTargetsDeps): DeclaredTargetsResolver {
  const identityTried = new Set<string>();
  const declaredTried = new Set<string>();
  let identityCleanup: (() => Promise<void>) | null = null;
  let declaredCleanup: (() => Promise<void>) | null = null;
  let declared: DeclaredFacts | null = null;
  const self: DeclaredTargetsResolver = {
    identity: null,
    identityStop: null,
    identityHidden: null,
    declaredStop: null,
    declaredHidden: null,
    declaredMiss: null,
    async tryIdentity(target: string, opts: IdentityAttemptOptions): Promise<IdentityAttempt> {
      if (identityTried.has(target)) return { kind: "skipped" };
      identityTried.add(target);
      const idr = await identityLookup(deps.pg, target, { hosts: deps.frameHosts });
      if (!idr.eligible) return { kind: "skipped" };
      // 约束 3：可见匹配 > 1 = 歧义（rows 只在恰好 1 个可见匹配时非空）。
      const visibleMatches = idr.total_matches - idr.hidden_matches;
      if (visibleMatches > 1) {
        for (const cand of idr.candidates.filter((x) => x.visible)) {
          deps.noteSkipped({
            ...(opts.commandId === undefined ? {} : { command_id: opts.commandId, target }),
            ref: `identity:${cand.tag}${cand.id ? `#${cand.id}` : ""}`,
            reason: "target_ambiguous",
            detail: `${visibleMatches} visible identity match(es) for ${JSON.stringify(target)}; never guessed`,
          });
        }
        await idr.cleanup();
        self.identityStop = {
          code: "target_ambiguous",
          reason: `${opts.reasonPrefix} (${idr.shape}, ${idr.attr}=${JSON.stringify(idr.value)}) matches `
            + `${visibleMatches} visible element(s) across frames (total=${idr.total_matches}, hidden=${idr.hidden_matches}) `
            + `— candidates: ${formatIdentityCandidates(idr.candidates)}. Identity recovery never guesses `
            + `among several matches; narrow the ${opts.narrowNoun} to a unique id/data-test/name on step ${deps.stepNo}`,
        };
        return { kind: "ambiguous" };
      }
      if (idr.rows.length === 1) {
        const el = idr.rows[0]!;
        const ref = String(el.ref ?? "dom:0");
        self.identity = {
          ref, target, shape: idr.shape, attr: idr.attr, value: idr.value,
          matches: 1, total_matches: idr.total_matches,
          hidden_matches: idr.hidden_matches, frame: Number(el.frame ?? 0),
        };
        identityCleanup = idr.cleanup;
        return { kind: "row", ref, el };
      }
      // 0 可见：保持既有失败路径（后续候选 / 最终 target_not_found）；隐藏匹配只作证据。
      if (idr.hidden_matches > 0) {
        self.identityHidden = { target, hidden: idr.hidden_matches, total: idr.total_matches };
        return { kind: "hidden" };
      }
      return { kind: "skipped" };
    },
    async tryDeclared(target: string, op: string): Promise<{ ref: string; el: Elem } | null> {
      if (!deps.targetResolutionDeclared || target === "" || declaredTried.has(target)) return null;
      declaredTried.add(target);
      const dr = await declaredLookup(
        deps.pg, target, op, deps.surfacePolicy, deps.frameHosts, deps.hintOpts(),
      );
      if (!dr.eligible) return null;
      // DRF 真跑了（形状 eligible）且可见零命中——记事实供停因尾缀回显（歧义分支自行结构化）。
      if (dr.visible_matches === 0) {
        self.declaredMiss = { target, mode: dr.mode, total: dr.total_matches, hidden: dr.hidden_matches };
      }
      if (dr.visible_matches > 1) {
        for (const cand of dr.candidates.filter((c) => c.visible)) {
          deps.noteSkipped({
            target, ref: `declared:${cand.tag}`,
            reason: "target_ambiguous",
            detail: `${dr.visible_matches} visible declared-DOM match(es) in ${dr.mode} mode for `
              + `${JSON.stringify(target)}; never guessed`,
          });
        }
        self.declaredStop = {
          code: "target_ambiguous",
          reason: `declared target ${JSON.stringify(target)} (${dr.mode} mode) matches `
            + `${dr.visible_matches} visible element(s) across frames (total=${dr.total_matches}, `
            + `hidden=${dr.hidden_matches}) — candidates: ${formatDeclaredCandidates(dr.candidates)}. `
            + `Declared-target resolution never guesses among several matches; narrow the declaration `
            + `to a unique #id / [data-test=…] / exact visible text on step ${deps.stepNo}`,
        };
        return null;
      }
      if (dr.rows.length !== 1) {
        if (dr.hidden_matches > 0) {
          self.declaredHidden = { target, hidden: dr.hidden_matches, total: dr.total_matches };
          deps.onDeclaredHidden?.(self.declaredHidden);
        }
        return null;
      }
      const el = dr.rows[0]!;
      declaredCleanup = dr.cleanup;
      const ref = String(el.ref ?? "drf:0");
      self.setDeclared({
        ref, target, mode: dr.mode, matches: 1,
        total_matches: dr.total_matches, hidden_matches: dr.hidden_matches,
        frame: Number(el.frame ?? 0),
      });
      return { ref, el };
    },
    getDeclared(): DeclaredFacts | null { return declared; },
    setDeclared(v: DeclaredFacts | null): void { declared = v; },
    getDeclaredHidden(): DeclaredHiddenFacts | null { return self.declaredHidden; },
    async cleanupIdentity(): Promise<void> {
      if (identityCleanup !== null) {
        const fn = identityCleanup;
        identityCleanup = null;
        try { await fn(); } catch { /* 清理失败不阻断：章值唯一，残留不会误指 */ }
      }
      // DRF 章与 FW8 同一纪律——动作尝试一结束（成功/失败/提前停）就清。
      await self.cleanupDeclared();
    },
    async cleanupDeclared(): Promise<void> {
      if (declaredCleanup === null) return;
      const fn = declaredCleanup;
      declaredCleanup = null;
      try { await fn(); } catch { /* 清理失败不阻断：章值唯一，残留不会误指 */ }
    },
  };
  return self;
}
