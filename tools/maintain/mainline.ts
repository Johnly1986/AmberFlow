/**
 * 可维护性门禁 · 主线组（mainline）
 *
 * 断言 `docs/MAINLINE.md` 与仓库结构一致，且「装配点/子进程转交/公共面」只减不增：
 *   - 文档存在且含依赖分层 L1.5、执行阶段 S0/S5、三类入口、目录→层映射、seam 表、命名表；
 *   - `src/` 顶层目录与 `integrations/dsh-bridge`、`tools` 都登记在目录→层映射中；
 *   - `src/index.ts` 仓内 importer = 0（公共面不再自欺）；
 *   - `new BrowserMiddleware(` 真实构造数 ≤ 基线（注释行不算）——P1 工厂后由 `--update` 下调；
 *   - `ctx.runEntry(` 调用点数 ≤ 基线（子进程转交只减不增）。
 * 纯离线、零网络；`evaluateMainline` 是纯函数（负向自测用）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Problem } from "./size.ts";

export interface MainlineSnapshot {
  /** docs/MAINLINE.md 正文（不存在时为空串）。 */
  doc: string;
  /** src 下的顶层目录名（含 `src/` 前缀），按字典序。 */
  srcDirs: string[];
  /** 真实 `new BrowserMiddleware(` 构造数（剔除注释行）。 */
  mwConstructions: number;
  /** `ctx.runEntry(` 调用点数。 */
  runEntryCalls: number;
  /** 指向任意 `index.ts` 的仓内 import（相对路径），应为空。 */
  indexImporters: string[];
}

export interface MainlineBaseline {
  mwConstructions: number;
  runEntryCalls: number;
}

const REQUIRED_TOKENS: ReadonlyArray<{ token: string; why: string }> = [
  { token: "L1.5", why: "依赖分层缺 L1.5（intervention 登记）" },
  { token: "S0", why: "执行阶段缺 S0" },
  { token: "S5", why: "执行阶段缺 S5" },
  { token: "引擎入口", why: "入口三类缺「引擎入口」" },
  { token: "宿主集成", why: "入口三类缺「宿主集成」" },
  { token: "开发/创作", why: "入口三类缺「开发/创作」" },
  { token: "目录 → 层映射", why: "缺目录→层映射表" },
  { token: "Seam / 符号归属冻结表", why: "缺 seam 冻结表（0.9）" },
  { token: "命名表", why: "缺命名表" },
];

/** 在给定文本里数非注释行中的正则命中数。 */
function countCodeMatches(text: string, pattern: RegExp): number {
  let n = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
    if (pattern.test(line)) n += 1;
  }
  return n;
}

/** 收集 mainline 快照（fs 侧）。 */
export function collectMainline(repo: string): MainlineSnapshot {
  const docPath = path.join(repo, "docs", "MAINLINE.md");
  const doc = fs.existsSync(docPath) ? fs.readFileSync(docPath, "utf8") : "";
  const srcRoot = path.join(repo, "src");
  const srcDirs = fs.existsSync(srcRoot)
    ? fs.readdirSync(srcRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `src/${e.name}/`).sort()
    : [];

  const readTs = (roots: string[]): string => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.name.endsWith(".ts")) out.push(fs.readFileSync(abs, "utf8"));
      }
    };
    for (const root of roots) walk(path.join(repo, root));
    return out.join("\n");
  };

  const srcText = readTs(["src"]);
  const cliText = readTs(["src/cli"]);
  const mwConstructions = countCodeMatches(srcText, /new BrowserMiddleware\(/);
  const runEntryCalls = countCodeMatches(cliText, /ctx\.runEntry\(/);

  const indexImporters: string[] = [];
  // 只关心「是否有人 import 仓库根的 src/index.ts」；子目录的 index.ts（如
  // intervention/index.ts）是模块入口，不是公共面，不能误判。
  const importRe = /from\s+["']([^"']*\/index\.ts)["']/g;
  const rootIndex = path.join(repo, "src", "index.ts");
  const scanRoots = ["src", "tools", "integrations/dsh-bridge/src", "online"];
  const walkFiles = (relRoot: string): void => {
    const absRoot = path.join(repo, relRoot);
    if (!fs.existsSync(absRoot)) return;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
          continue;
        }
        if (!/\.(ts|mjs|js)$/.test(entry.name)) continue;
        const rel = path.relative(repo, abs).split(path.sep).join("/");
        if (rel === "src/index.ts") continue;
        const text = fs.readFileSync(abs, "utf8");
        for (const m of text.matchAll(importRe)) {
          const target = path.resolve(path.dirname(abs), m[1]!);
          if (target === rootIndex) indexImporters.push(`${rel}: ${m[0]}`);
        }
      }
    };
    walk(absRoot);
  };
  for (const root of scanRoots) walkFiles(root);

  return { doc, srcDirs, mwConstructions, runEntryCalls, indexImporters };
}

/** 纯函数：给定快照与基线，返回问题列表（可离线负向断言）。 */
export function evaluateMainline(snapshot: MainlineSnapshot, baseline: MainlineBaseline): Problem[] {
  const problems: Problem[] = [];
  const fail = (message: string): void => { problems.push({ group: "mainline", severity: "fail", message }); };

  if (snapshot.doc.trim() === "") {
    fail("docs/MAINLINE.md 不存在——P0 0.6 必须先落主线文档");
    return problems;
  }
  for (const req of REQUIRED_TOKENS) {
    if (!snapshot.doc.includes(req.token)) fail(`docs/MAINLINE.md ${req.why}`);
  }
  for (const dir of snapshot.srcDirs) {
    if (!snapshot.doc.includes(dir)) fail(`顶层目录 ${dir} 未登记在 MAINLINE 目录→层映射`);
  }
  if (!snapshot.doc.includes("integrations/dsh-bridge")) fail("MAINLINE 未登记 integrations/dsh-bridge 的层位");
  if (!snapshot.doc.includes("tools/")) fail("MAINLINE 未登记 tools/ 的层位");
  if (snapshot.indexImporters.length > 0) {
    fail(`src/index.ts 有 ${snapshot.indexImporters.length} 个仓内 importer（公共面应为 internal）：${snapshot.indexImporters.slice(0, 3).join("；")}`);
  }
  if (snapshot.mwConstructions > baseline.mwConstructions) {
    fail(`new BrowserMiddleware 真实构造 ${snapshot.mwConstructions} 处 > 基线 ${baseline.mwConstructions}——装配点只减不增（用 buildMiddleware 工厂）`);
  }
  if (snapshot.runEntryCalls > baseline.runEntryCalls) {
    fail(`ctx.runEntry 调用点 ${snapshot.runEntryCalls} 处 > 基线 ${baseline.runEntryCalls}——子进程转交只减不增`);
  }
  return problems;
}
