/**
 * 可维护性门禁 · 规模组（size）
 *
 * 口径（与 docs/IMPROVEMENT_PLAN.md v2.1 §5 对齐）：
 *   - **新代码硬上限**：不在 baseline 里的新文件 > `newFileMaxLines`、新函数 > `newFunctionMaxLines` → fail；
 *   - **存量只减不增**：baseline 里已有的超标文件/函数不得比记录值更大；缩小后由 `--update` 下调基线；
 *   - 计划内阶段函数（`phaseFunctions` allowlist，如 run() 九阶段）适用 `phaseFunctionMaxLines`
 *     例外——它是「提函数」批次的一部分，不能反过来阻断批次。
 * 纯离线、零网络。基线由 `tools/maintain/baseline.json` 提供，`--update` 只允许下调/删除。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type * as TSTypes from "typescript";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof TSTypes;

export interface FileInfo {
  /** 仓库相对路径（正斜杠）。 */
  file: string;
  /** wc -l 口径行数。 */
  lines: number;
}

export interface FunctionInfo {
  /** 仓库相对路径（正斜杠）。 */
  file: string;
  /** 函数名；同文件重名时生成器追加 `#2`、`#3`。 */
  name: string;
  lines: number;
}

export interface SizeLimits {
  newFileMaxLines: number;
  newFunctionMaxLines: number;
  phaseFunctionMaxLines: number;
}

export interface SizeBaseline extends SizeLimits {
  files: Record<string, number>;
  functions: FunctionInfo[];
  /** 计划内阶段函数 allowlist：`文件#函数名`（允许超 newFunctionMaxLines，但不超过 phaseFunctionMaxLines）。 */
  phaseFunctions: string[];
}

export type Severity = "fail" | "warn";

export interface Problem {
  group: "size" | "docs" | "mainline" | "comments";
  severity: Severity;
  message: string;
}

/** wc -l 口径：文件末尾换行不算一行。 */
export function countLines(text: string): number {
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** 收集 src 下全部 .ts 的文件规模与函数规模（AST 口径）。 */
export function collectSize(repo: string): { files: FileInfo[]; functions: FunctionInfo[] } {
  const root = path.join(repo, "src");
  const absFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts")) absFiles.push(abs);
    }
  };
  walk(root);

  const files: FileInfo[] = [];
  const functions: FunctionInfo[] = [];
  for (const abs of absFiles) {
    const file = path.relative(repo, abs).split(path.sep).join("/");
    const text = fs.readFileSync(abs, "utf8");
    files.push({ file, lines: countLines(text) });
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
    const seen = new Map<string, number>();
    const visit = (node: TSTypes.Node): void => {
      const isFn = ts.isFunctionDeclaration(node)
        || ts.isMethodDeclaration(node)
        || ts.isFunctionExpression(node)
        || (ts.isArrowFunction(node) && node.parent !== undefined
          && (ts.isVariableDeclaration(node.parent) || ts.isPropertyDeclaration(node.parent)));
      if (isFn) {
        const fn = node as TSTypes.FunctionLikeDeclaration;
        const parentName = ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)
          ? fn.parent.name.text
          : null;
        const rawName = fn.name?.getText(sf) ?? parentName ?? "<anon>";
        const start = sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1;
        const end = sf.getLineAndCharacterOfPosition(fn.end).line + 1;
        const lines = end - start + 1;
        if (lines > 150) {
          const n = seen.get(rawName) ?? 0;
          seen.set(rawName, n + 1);
          functions.push({ file, name: n > 0 ? `${rawName}#${n + 1}` : rawName, lines });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { files, functions };
}

/** 纯函数：给定观测与基线，返回问题列表（可离线单测负向断言）。 */
export function evaluateSize(
  files: FileInfo[],
  functions: FunctionInfo[],
  limits: SizeLimits,
  baseline: Pick<SizeBaseline, "files" | "functions" | "phaseFunctions">,
): Problem[] {
  const problems: Problem[] = [];
  const phase = new Set(baseline.phaseFunctions);
  const baselineFiles = baseline.files;
  const baselineFns = new Map<string, number>();
  for (const fn of baseline.functions) baselineFns.set(`${fn.file}\u0000${fn.name}`, fn.lines);

  for (const f of files) {
    if (f.lines <= limits.newFileMaxLines) continue;
    const recorded = baselineFiles[f.file];
    if (recorded === undefined) {
      problems.push({
        group: "size",
        severity: "fail",
        message: `新文件 ${f.file} ${f.lines} 行 > ${limits.newFileMaxLines} 行硬上限——拆小，或在方案评审后显式登记（不得手改 baseline）`,
      });
    } else if (f.lines > recorded) {
      problems.push({
        group: "size",
        severity: "fail",
        message: `${f.file} 从基线 ${recorded} 行增长到 ${f.lines} 行——存量文件只减不增（缩小后跑 --update 下调）`,
      });
    }
  }

  for (const fn of functions) {
    const key = `${fn.file}\u0000${fn.name}`;
    const isPhase = phase.has(`${fn.file}#${fn.name}`);
    const max = isPhase ? limits.phaseFunctionMaxLines : limits.newFunctionMaxLines;
    if (fn.lines <= max) continue;
    const recorded = baselineFns.get(key);
    if (recorded === undefined) {
      problems.push({
        group: "size",
        severity: "fail",
        message: isPhase
          ? `阶段函数 ${fn.file}#${fn.name} ${fn.lines} 行 > ${limits.phaseFunctionMaxLines} 行例外上限`
          : `新函数 ${fn.file}#${fn.name} ${fn.lines} 行 > ${limits.newFunctionMaxLines} 行硬上限——拆小或登记为计划内阶段函数`,
      });
    } else if (fn.lines > recorded) {
      problems.push({
        group: "size",
        severity: "fail",
        message: `${fn.file}#${fn.name} 从基线 ${recorded} 行增长到 ${fn.lines} 行——存量函数只减不增`,
      });
    }
  }
  return problems;
}

export interface UpdateInput {
  files: FileInfo[];
  functions: FunctionInfo[];
  limits: SizeLimits;
  template: SizeBaseline;
}

/** 只允许下调/删除的基线更新：任何增长或新增超标项都拒绝。 */
export function mergeBaselineForUpdate(input: UpdateInput, previous: SizeBaseline): { next: SizeBaseline; errors: string[] } {
  const errors: string[] = [];
  const nextFiles: Record<string, number> = {};
  for (const f of input.files) {
    if (f.lines <= input.limits.newFileMaxLines) continue;
    const old = previous.files[f.file];
    if (old === undefined) {
      errors.push(`新增超标文件 ${f.file}（${f.lines} 行）：先拆小，不能登记进基线`);
      continue;
    }
    if (f.lines > old) {
      errors.push(`${f.file} 增长 ${old}→${f.lines}：基线上调被拒绝`);
      continue;
    }
    nextFiles[f.file] = f.lines;
  }
  const prevFns = new Map<string, number>();
  for (const fn of previous.functions) prevFns.set(`${fn.file}\u0000${fn.name}`, fn.lines);
  const nextFns: FunctionInfo[] = [];
  for (const fn of input.functions) {
    if (fn.lines <= input.limits.newFunctionMaxLines) continue;
    const old = prevFns.get(`${fn.file}\u0000${fn.name}`);
    if (old === undefined) {
      errors.push(`新增超标函数 ${fn.file}#${fn.name}（${fn.lines} 行）：先拆小，不能登记进基线`);
      continue;
    }
    if (fn.lines > old) {
      errors.push(`${fn.file}#${fn.name} 增长 ${old}→${fn.lines}：基线上调被拒绝`);
      continue;
    }
    nextFns.push({ file: fn.file, name: fn.name, lines: fn.lines });
  }
  const next: SizeBaseline = {
    ...input.limits,
    files: Object.fromEntries(Object.entries(nextFiles).sort((a, b) => b[1] - a[1])),
    functions: nextFns.sort((a, b) => b.lines - a.lines),
    phaseFunctions: previous.phaseFunctions,
  };
  return { next, errors };
}
