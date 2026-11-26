/**
 * 执行器**证据构造单点**：身份回捞（FW8）/ 声明目标解析（DRF）/ 行锚的证据形状与停因尾缀。
 *
 * 为什么单独成文件：这些对象/文案原本散在 `BrowserMiddleware.run()` 的局部闭包里，形状与
 * 文案混在 2600+ 行的执行循环内，既无法复用也无法单独审。收敛到这里后：
 *   - 证据对象的**键顺序**与条件 spread 只有一份（trace/停因 reason 的字节形状由本文件决定）；
 *   - 停因尾缀的**文案**只有一份（含标点/空格），run() 只传现场值；
 *   - 类型单源（`IdentityFacts` / `DeclaredFacts` 及隐藏/零命中事实），run() 用 `import type` 引用。
 *
 * 纪律：
 *   - 纯函数 + 纯类型，无模块级可变状态；
 *   - 不 import 执行器类/Playwright 具体类型；只 import engine 结构类型（`Elem`/`ParsedHint`）；
 *   - 只构造证据，不做判定、不读页面、不写 trace（进入 trace/reason 的位置仍由 run() 决定）。
 */
import type { Elem } from "./extraction.ts";
import type { ParsedHint } from "./hint.ts";

/** FW8 身份回捞命中事实（`resolved_by:"dom_identity"` 的 identity 块来源）。 */
export interface IdentityFacts {
  ref: string;
  target: string;
  shape: string;
  attr: string;
  value: string;
  matches: number;
  total_matches: number;
  hidden_matches: number;
  frame: number;
}

/** FW8 命中但全不可见的诊断事实（按 0 处理；绝不操作隐藏元素）。 */
export interface IdentityHiddenFacts {
  target: string;
  hidden: number;
  total: number;
}

/** DRF 声明目标解析命中事实（`resolved_by:"declared_dom"` 的 declared_resolve 块来源）。 */
export interface DeclaredFacts {
  ref: string;
  target: string;
  mode: "attr" | "text";
  matches: number;
  total_matches: number;
  hidden_matches: number;
  frame: number;
  hit_test?: "covered" | "ancestor";
  blocker?: string;
}

/** DRF 匹配到但全不可见的诊断事实（按 0 处理；绝不操作隐藏元素）。 */
export interface DeclaredHiddenFacts {
  target: string;
  hidden: number;
  total: number;
}

/** DRF 实跑且可见零命中的事实（`total`/`hidden` 为实测字段，`visible=0`）。 */
export interface DeclaredMissFacts {
  target: string;
  mode: "attr" | "text";
  total: number;
  hidden: number;
  /**
   * 页内 pass **求值失败**的帧（≤3；只在真的失败时出现）。
   * 有它 = "DRF 脚本在那些帧里根本没跑起来"，与"页面确实 0 命中"是两种事实。
   */
  eval_failed?: ReadonlyArray<{ frame: number; reason: string }>;
}

/** FW8 命中证据：无命中 = `{}`（trace 行键集逐字节不变）。 */
export function identityEvidence(facts: IdentityFacts | null): Record<string, unknown> {
  return facts === null ? {} : {
    resolved_by: "dom_identity",
    identity: {
      target: facts.target, shape: facts.shape, attr: facts.attr, value: facts.value,
      matches: facts.matches, total_matches: facts.total_matches,
      hidden_matches: facts.hidden_matches, frame: facts.frame,
    },
  };
}

/** DRF 命中证据：无命中 = `{}`；`hit_test`/`blocker` 仅存在时出现（键顺序固定）。 */
export function declaredEvidence(facts: DeclaredFacts | null): Record<string, unknown> {
  return facts === null ? {} : {
    resolved_by: "declared_dom",
    declared_resolve: {
      mode: facts.mode, target: facts.target, matches: facts.matches,
      hidden_matches: facts.hidden_matches, total_matches: facts.total_matches,
      frame: facts.frame,
      ...(facts.hit_test === undefined ? {} : { hit_test: facts.hit_test }),
      ...(facts.blocker === undefined ? {} : { blocker: facts.blocker }),
    },
  };
}

/** FW8：命中但全不可见时的停因补充（诊断必须带隐藏匹配计数）。 */
export function identityHiddenSuffix(facts: IdentityHiddenFacts | null): string {
  return facts === null ? ""
    : ` — identity recovery: ${JSON.stringify(facts.target)} matched `
      + `${facts.total} element(s) in the DOM but ${facts.hidden} are hidden `
      + `(checkVisibility CSS / zero box); hidden elements are never acted on`;
}

/** DRF：命中但全不可见时的停因补充（与身份面同一措辞纪律）。 */
export function declaredHiddenSuffix(facts: DeclaredHiddenFacts | null): string {
  return facts === null ? ""
    : ` — declared-DOM resolution: ${JSON.stringify(facts.target)} matched `
      + `${facts.total} element(s) in the DOM but ${facts.hidden} are hidden `
      + `(checkVisibility CSS / zero box); hidden elements are never acted on`;
}

/** DRF 实跑且可见零命中的停因尾缀（只回显实测三数——`total`/`hidden`/`visible=0`）。 */
export function declaredMissSuffix(facts: DeclaredMissFacts | null): string {
  if (facts === null) return "";
  // 只在真的发生过页内求值失败时追加（无失败 = 尾缀与既有产物逐字节一致）。
  const evalNote = facts.eval_failed === undefined || facts.eval_failed.length === 0
    ? ""
    : `; the DRF page-pass never ran in ${facts.eval_failed.length} frame(s) (`
      + facts.eval_failed.map((f) => `frame=${f.frame} ${JSON.stringify(f.reason)}`).join("; ")
      + ") — a collect-script error, not a page fact";
  return ` — declared-DOM resolution (DRF, ${facts.mode} mode) ran: `
    + `total=${facts.total}, hidden=${facts.hidden}, visible=0` + evalNote;
}

/**
 * `target_not_found` 的能力提示尾缀：仅**未声明** `target_resolution:"declared"` 时追加——
 * 声明了 `"declared"` 的场景已经走 DRF，再提示就是噪音。
 */
export function drfHintSuffix(targetResolutionDeclared: boolean): string {
  return targetResolutionDeclared
    ? ""
    : ` — 自绘控件可声明 meta.policy.target_resolution:"declared" 让声明目标走 DRF（attr/文本精确匹配）`;
}

/**
 * 行锚证据（`row_evidence`）：声明 `row-index`/`in-row` 的目标解析成功后，所选 Elem 的实值
 * 进 trace（事后可审计"点的是哪一行"）。仅字段存在时出现；缺省路径零新字段。
 */
export function rowEvidence(el: Elem, parsed: ParsedHint | null): Record<string, unknown> {
  return parsed !== null
    && (parsed.rowIndex !== undefined || parsed.inRow !== undefined)
    && (el.row_index !== undefined || el.row_texts !== undefined)
    ? {
        row_evidence: {
          ...(el.row_index !== undefined ? { row_index: el.row_index } : {}),
          ...(el.row_texts !== undefined ? { row_texts: el.row_texts } : {}),
        },
      }
    : {};
}
