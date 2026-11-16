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
 *
 * C 批（N10）：`frame:` 尾缀的**独立提醒通道**（`frameFindings`，同一批 hint 形状位）——
 * 值必被解析拒绝 / origin 不在 `meta.hosts`（拿不到 hosts 时只做值形状检查）。它沿用本文件的
 * 通道纪律：只产 stderr 人话行、不进 problems、不改 VALID/exit；三类形状的判定与计数口径
 * （`findings`/`scanned`）不受影响。
 *
 * F82/F83 批 2 遗留收编：行锚尾缀（`in-row:` / `row-index:`）的**独立提醒通道**
 * （`rowAnchorFindings`，同一批 hint 形状位、同一通道纪律——stderr 人话行、不进 problems、
 * 不改 VALID/exit）：
 *   - `rejected`：值必被解析拒绝（`describeRowSuffixRejection` / `describeRowIndexSuffixRejection`
 *     点名）——运行期整组回退，**必不命中**；
 *   - `dupOnly`：值合法但**行锚只服务同文案重复网格**——声明扫描面拿不到重复组事实（静态
 *     字符串位），提醒降级为静态文案（不假装验证）：目标元素必须带 `row_texts`/`row_index`
 *     （inspect/observe 面该字段在场 = 重复组成员），非重复组元素恒落空（fail-closed）。
 */
import { describeFrameSuffixRejection, describeRowIndexSuffixRejection, describeRowSuffixRejection, parseHint } from "../engine/hint.ts";
import { urlInHostsEnvelope } from "../engine/host-envelope.ts";
import { poolFieldFor } from "../engine/rules.ts";
import { type DeclarationScan, type DeclSite } from "./declaration-scan.ts";

export type HintLintKind = "bare" | "nearToken" | "labelSubstr";

export interface HintLintFinding {
  kind: HintLintKind;
  /** 触发该类的 hint 原文（分组去重的键）。 */
  hint: string;
  locations: Array<{ file: string; line: number }>;
}

/**
 * C 批（N10）：`frame:` 尾缀的**独立**静态提醒通道（不是第四类 lint——三类形状的判定与
 * 计数口径保持不变，也不进 problems/VALID/exit）。
 *   - `rejected`：值不是 parseHint 接受的形状（缺 `://`、带 path、多尾缀、空段、>4 段…）——
 *     运行期整串按旧形状解析，**必不命中**；
 *   - `host`：值合法但 origin 的 hostname 不在 `meta.hosts` 信封内——若该帧是被排除的子 frame，
 *     运行期会 `frame_not_allowed`（主 frame 恒允许，故文案点明这一边界）。
 */
export type HintFrameLintKind = "rejected" | "host";

export interface HintFrameLintFinding {
  kind: HintFrameLintKind;
  /** 触发提醒的 hint 原文（去重键）。 */
  hint: string;
  /** 为什么（可行动：值形状 / 不在 hosts）。 */
  reason: string;
  locations: Array<{ file: string; line: number }>;
}

/**
 * F82/F83 批 2 遗留收编：行锚尾缀的**独立**静态提醒通道（同 frame 通道纪律——stderr 人话行、
 * 不进 problems/VALID/exit）。
 *   - `rejected`：值不是 parseHint 接受的形状（空值/含 `>`/超限/重复/缺主体…）——运行期
 *     整组回退，**必不命中**；
 *   - `dupOnly`：值合法但行锚只服务同文案重复网格——声明扫描面拿不到重复组事实（静态
 *     字符串位），提醒降级为静态文案（不假装验证）：目标元素无 `row_texts`/`row_index`
 *     （inspect/observe 面缺该字段）= 恒落空（fail-closed）；row-index 另带序漂移责任声明。
 */
export type HintRowAnchorLintKind = "rejected" | "dupOnly";

export interface HintRowAnchorLintFinding {
  kind: HintRowAnchorLintKind;
  /** 触发提醒的 hint 原文（去重键）。 */
  hint: string;
  /** 为什么（可行动：值形状 / 重复组归属）。 */
  reason: string;
  locations: Array<{ file: string; line: number }>;
}

export interface HintLintOptions {
  /** 应用 `meta.hosts`（拿不到 = undefined/null ⇒ 只做值形状检查，不报 host 提醒）。 */
  hosts?: readonly string[] | null;
}

export interface HintLintResult {
  findings: HintLintFinding[];
  /** 检视的静态字符串 hint 实参总数（含三类之外的健康形状——口径计数）。 */
  scanned: number;
  /** C 批：frame: 尾缀提醒（独立 stderr 通道；不参与上面的 findings/scanned 口径）。 */
  frameFindings: HintFrameLintFinding[];
  /** F82/F83 批 2 遗留收编：行锚尾缀提醒（独立 stderr 通道；不参与 findings/scanned 口径）。 */
  rowAnchorFindings: HintRowAnchorLintFinding[];
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
    + "——运行面若真弱档命中，缺省（`act_hint_tier:\"any\"`）下 matched_others 警告会当场点名，"
    + "声明 `act_hint_tier:\"strong\"` 则改报 weak_hint_rejected 并不执行弱档；"
    + "收窄：tag[attr=…] 精确值 / #id / 更长独词",
  nearToken: "这是近邻语义（元素位于 label=token 的元素附近），不是『标签+文本』；若想要后者用 tag[attr~…]",
  labelSubstr: "子串语义：aria-label 提取期已并入 label，按子串匹配会撞更长相邻标签；精确用 [aria-label=x]",
};

const KIND_LABEL: Record<HintLintKind, string> = {
  bare: "裸词",
  nearToken: "nearToken",
  labelSubstr: "attrSubstr-on-label",
};

/** 行锚静态提醒的单一文案出处（dupOnly；声明面拿不到重复组事实 = 不假装验证）。 */
const ROW_ANCHOR_DUP_ONLY_NOTE = "行锚（in-row/row-index）只服务同文案重复网格：目标元素必须带 "
  + "row_texts/row_index（inspect/observe 面该字段在场 = 重复组成员），非重复组元素恒落空"
  + "（fail-closed）——请确认目标在同文案重复网格内（inspect 复核），否则改用 id/data-test/"
  + "唯一 label；row-index 另见序漂移责任（作者指南 §4.13：单用 = 序号即语义，作者显式承担；"
  + "组合 in-row 守卫把序漂移变成显式落空）";

/** 扫描声明收集结果，产出三类 hint 形状的静态提醒（纯函数，不打印）。 */
export function lintHintSemantics(
  scan: DeclarationScan, file: string, opts: HintLintOptions = {},
): HintLintResult {
  const findings = new Map<string, HintLintFinding>();
  const frameFindings = new Map<string, HintFrameLintFinding>();
  const rowAnchorFindings = new Map<string, HintRowAnchorLintFinding>();
  let scanned = 0;
  const addFrameFinding = (kind: HintFrameLintKind, hint: string, reason: string, line: number): void => {
    const key = `${kind}\u0000${hint}`;
    const f = frameFindings.get(key) ?? { kind, hint, reason, locations: [] };
    f.locations.push({ file, line });
    frameFindings.set(key, f);
  };
  const addRowAnchorFinding = (kind: HintRowAnchorLintKind, hint: string, reason: string, line: number): void => {
    const key = `${kind}\u0000${hint}`;
    const f = rowAnchorFindings.get(key) ?? { kind, hint, reason, locations: [] };
    f.locations.push({ file, line });
    rowAnchorFindings.set(key, f);
  };
  for (const site of scan.sites) {
    for (const idx of hintArgsOf(site)) {
      const arg = site.args[idx];
      if (arg === undefined || !arg.static || typeof arg.value !== "string") continue;
      scanned++;
      const parsed = parseHint(arg.value);
      // C 批（N10）：frame: 尾缀提醒——值形状必被拒绝 / origin hostname 不在 meta.hosts。
      // 放在三类形状判定之前（不影响它们：下面只读同一个 parsed，不改 findings/scanned 口径）。
      const rejection = describeFrameSuffixRejection(arg.value);
      if (rejection !== null) {
        addFrameFinding("rejected", arg.value, rejection, site.line);
      } else if (parsed.frameChain !== undefined
          && opts.hosts !== undefined && opts.hosts !== null && opts.hosts.length > 0) {
        const outside = parsed.frameChain.filter((seg) => !urlInHostsEnvelope(seg, opts.hosts as string[]));
        if (outside.length > 0) {
          addFrameFinding("host", arg.value,
            `frame: 链里的 ${outside.map((s) => JSON.stringify(s)).join("、")} 不在 meta.hosts `
            + `(${opts.hosts.join(", ")}) 内——若该 origin 是被排除的子 frame，运行期会 frame_not_allowed`
            + `（先把它加进 meta.hosts；主 frame 恒允许）`, site.line);
        }
      }
      // F82/F83 批 2 遗留收编：行锚尾缀提醒（独立通道；三类形状判定不受影响）。
      //   rejected：值必被解析拒绝（describeRow/RowIndexSuffixRejection 点名）；
      //   dupOnly：值合法但行锚只服务同文案重复网格（静态文案，不假装验证）。
      const rowAnchorRejection = describeRowSuffixRejection(arg.value)
        ?? describeRowIndexSuffixRejection(arg.value);
      if (rowAnchorRejection !== null) {
        addRowAnchorFinding("rejected", arg.value, rowAnchorRejection, site.line);
      } else if (parsed.inRow !== undefined || parsed.rowIndex !== undefined) {
        addRowAnchorFinding("dupOnly", arg.value, ROW_ANCHOR_DUP_ONLY_NOTE, site.line);
      }
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
  return {
    findings: [...findings.values()],
    scanned,
    frameFindings: [...frameFindings.values()],
    rowAnchorFindings: [...rowAnchorFindings.values()],
  };
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
  // C 批（N10）：frame: 尾缀提醒（独立 stderr 行；clean 应用零输出，三类 lint 的判定/计数不变）。
  for (const f of result.frameFindings.slice(0, 3)) {
    const locs = f.locations.slice(0, 3).map((l) => `${l.file}:${l.line}`).join("、");
    const rest = f.locations.length > 3 ? `（另 ${f.locations.length - 3} 处略）` : "";
    const label = f.kind === "rejected" ? "frame: 尾缀必被解析拒绝" : "frame: origin 不在 meta.hosts";
    lines.push(`hintLint: ${label} — ${locs}${rest} ${JSON.stringify(f.hint)} —— ${f.reason}`
      + "（仅静态提醒，不影响 VALID/exit）");
  }
  if (result.frameFindings.length > 3) {
    lines.push(`hintLint: frame: 尾缀另有 ${result.frameFindings.length - 3} 处提醒（只列前 3；`
      + "仅静态提醒，不影响 VALID/exit）");
  }
  // F82/F83 批 2 遗留收编：行锚尾缀提醒（独立 stderr 行；clean 应用零输出，三类 lint 的
  // 判定/计数不变）。
  for (const f of result.rowAnchorFindings.slice(0, 3)) {
    const locs = f.locations.slice(0, 3).map((l) => `${l.file}:${l.line}`).join("、");
    const rest = f.locations.length > 3 ? `（另 ${f.locations.length - 3} 处略）` : "";
    const label = f.kind === "rejected" ? "行锚尾缀必被解析拒绝" : "行锚只服务同文案重复网格";
    lines.push(`hintLint: ${label} — ${locs}${rest} ${JSON.stringify(f.hint)} —— ${f.reason}`
      + "（仅静态提醒，不影响 VALID/exit）");
  }
  if (result.rowAnchorFindings.length > 3) {
    lines.push(`hintLint: 行锚尾缀另有 ${result.rowAnchorFindings.length - 3} 处提醒（只列前 3；`
      + "仅静态提醒，不影响 VALID/exit）");
  }
  return lines;
}
