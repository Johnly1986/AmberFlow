/**
 * task-10（B2，评审 #5）：hint 语义 lint——`apps check` 声明层的**静态提醒**。
 *
 * 通道纪律（与 weak_done lint 同款）：只产 stderr 人话行，**不进 problems、不改 VALID/exit**——
 * 它是"这个写法容易撞容器"的先天提醒，不是裁决。clean 应用（无三类形状）零输出。
 *
 * 与 B1 的分层（评审 #2 的运行面警告）：`matched_others` 是**运行期当场事实**（谁真的被
 * 弱档命中、点了什么）；这里是**声明形状的静态语义**（这个写法按什么口径匹配、容易撞什么）。
 * 同题材、两层各说各的话，不复制同一段文案。
 *
 * 范围护栏（lead 批复，违反即返工）：只消费 declaration-scan 的 **hint 形状位**——
 * `ctx.hint` / `ctx.hints` 元素 / `ctx.command` target / `ctx.scrollList`·`expand`·`setRange`
 * target 的静态字符串实参，经 `parseHint`（唯一解析器，只读复用）判三类形状。挂起工作流的
 * 其他族校验面（judge/命令操作数真空、dynamic 计数外显、declarationLint 字段）一律不接出；
 * 未求值的 hint 实参静默跳过（不在检视范围，也不计数外显）。
 */
import { parseHint } from "../engine/hint.ts";
import { poolFieldFor } from "../engine/rules.ts";
import { type DeclarationScan, type DeclSite } from "./declaration-scan.ts";

export type HintLintKind = "bare" | "nearToken" | "labelSubstr";

export interface HintLintFinding {
  kind: HintLintKind;
  /** 触发该类的 hint 原文（分组去重的键）。 */
  hint: string;
  locations: Array<{ file: string; line: number }>;
}

export interface HintLintResult {
  findings: HintLintFinding[];
  /** 检视的静态字符串 hint 实参总数（含三类之外的健康形状——口径计数）。 */
  scanned: number;
}

/** 一个调用点的哪个实参位是 hint 语义字符串（唯一出处：ctx 的参数签名）。 */
function hintArgsOf(site: DeclSite): number[] {
  switch (site.call) {
    case "ctx.hint": return [0];
    case "ctx.hints": return site.args.map((a) => a.index);
    case "ctx.command": return [1];                 // target
    case "ctx.scrollList":
    case "ctx.expand":
    case "ctx.setRange": return [0];                // target
    default: return [];
  }
}

const LABEL_MATCH_NOTE: Record<HintLintKind, string> = {
  bare: "裸词按前缀/词边界匹配 label（长 CJK 词整串成词，尤其如此），注意撞上以同词开头的容器 div"
    + "——运行面若真弱档命中，matched_others 警告会当场点名；收窄：tag[attr=…] 精确值 / #id / 更长独词",
  nearToken: "这是近邻语义（元素位于 label=token 的元素附近），不是『标签+文本』；若想要后者用 tag[attr~…]",
  labelSubstr: "子串语义：aria-label 提取期已并入 label，按子串匹配会撞更长相邻标签；精确用 [aria-label=x]",
};

const KIND_LABEL: Record<HintLintKind, string> = {
  bare: "裸词",
  nearToken: "nearToken",
  labelSubstr: "attrSubstr-on-label",
};

/** 扫描声明收集结果，产出三类 hint 形状的静态提醒（纯函数，不打印）。 */
export function lintHintSemantics(scan: DeclarationScan, file: string): HintLintResult {
  const findings = new Map<string, HintLintFinding>();
  let scanned = 0;
  for (const site of scan.sites) {
    for (const idx of hintArgsOf(site)) {
      const arg = site.args[idx];
      if (arg === undefined || !arg.static || typeof arg.value !== "string") continue;
      scanned++;
      const parsed = parseHint(arg.value);
      let kind: HintLintKind | null = null;
      if (parsed.kind === "bare") kind = "bare";
      else if (parsed.kind === "nearToken") kind = "nearToken";
      else if (parsed.kind === "attrSubstr" && poolFieldFor(parsed.attr) === "label") kind = "labelSubstr";
      if (kind === null) continue;                   // 健康形状（id/attrEq/tag/非 label 子串）不提醒
      const key = `${kind}\u0000${arg.value}`;
      const f = findings.get(key)
        ?? { kind, hint: arg.value, locations: [] };
      f.locations.push({ file, line: site.line });
      findings.set(key, f);
    }
  }
  return { findings: [...findings.values()], scanned };
}

/** 渲染 stderr 行（weak_done 风格；每类一行、位置列前 3 个，其余计数带过）。 */
export function renderHintLintLines(result: HintLintResult): string[] {
  const lines: string[] = [];
  const byKind = new Map<HintLintKind, HintLintFinding[]>();
  for (const f of result.findings) {
    const arr = byKind.get(f.kind) ?? [];
    arr.push(f);
    byKind.set(f.kind, arr);
  }
  for (const kind of ["bare", "nearToken", "labelSubstr"] as const) {
    const arr = byKind.get(kind);
    if (arr === undefined || arr.length === 0) continue;
    const total = arr.reduce((n, f) => n + f.locations.length, 0);
    const locs = arr.flatMap((f) => f.locations.map((l) => ({ ...l, hint: f.hint })));
    const shown = locs.slice(0, 3)
      .map((l) => `${l.file}:${l.line} ${JSON.stringify(l.hint)}`).join("、");
    const rest = locs.length > 3 ? `（另 ${locs.length - 3} 处略）` : "";
    lines.push(`hintLint: ${KIND_LABEL[kind]} ×${total} — ${shown}${rest} —— ${LABEL_MATCH_NOTE[kind]}`);
  }
  const counts = (["bare", "nearToken", "labelSubstr"] as const)
    .map((k) => `${KIND_LABEL[k]} ${byKind.get(k)?.reduce((n, f) => n + f.locations.length, 0) ?? 0}`)
    .join(" · ");
  if (result.findings.length > 0) {
    lines.push(`hintLint: 检视 ${result.scanned} 个静态 hint 声明 — ${counts}`
      + "（仅静态提醒，不影响 VALID/exit）");
  }
  return lines;
}
