/**
 * 可维护性门禁 · 文档组（docs）
 *
 * 只断言「人读视图与仓库事实一致」这一件事，不替代 0.2 的配置三向门禁与 0.6 的
 * mainline 断言（后者在 mainline 组/独立脚本里）。规则：
 *   - README 的示例数量与 `examples/apps/` 实际目录数一致；
 *   - README 文档清单包含关键文档（ARCHITECTURE / IMPROVEMENT_PLAN / REVIEW / PROMPT_SYSTEM）；
 *   - README / ARCHITECTURE / AGENTS 中的本地 markdown 链接目标真实存在（禁止死链）；
 *   - AGENTS 的离线夹具表述与 fixtures 事实一致（已拍板：非门禁验证）；
 *   - P0 0.6 之前 MAINLINE 缺失只 warn；创建后要求含依赖分层 L1.5 与执行阶段 S0。
 * 纯离线、零网络；所有输入由 `collectDocs` 读取，`evaluateDocs` 是纯函数便于负向自测。
 */
import fs from "node:fs";
import path from "node:path";
import type { Problem } from "./size.ts";

export interface DocLink {
  /** 相对仓库根的文件（正斜杠）。 */
  file: string;
  /** 链接目标原文。 */
  target: string;
}

export interface DocsSnapshot {
  readme: string;
  agents: string;
  /** examples/apps 下的目录数。 */
  examplesCount: number;
  /** 仓库相对路径 → 是否存在。 */
  exists: Record<string, boolean>;
  /** 从 README/ARCHITECTURE/AGENTS 提取的本地链接。 */
  links: DocLink[];
  mainline: string | null;
  plan: string;
}

export interface DocsBaseline {
  readmeExamples: number;
  requiredDocLinks: string[];
}

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;

/** 收集文档快照（fs 侧）。 */
export function collectDocs(repo: string): DocsSnapshot {
  const read = (rel: string): string => {
    const abs = path.join(repo, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  };
  const examplesDir = path.join(repo, "examples", "apps");
  const examplesCount = fs.existsSync(examplesDir)
    ? fs.readdirSync(examplesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length
    : 0;
  const linkFiles = ["README.md", "ARCHITECTURE.md", "AGENTS.md"];
  const links: DocLink[] = [];
  const exists: Record<string, boolean> = {};
  for (const file of linkFiles) {
    const text = read(file);
    for (const m of text.matchAll(LINK_RE)) {
      const target = m[1]!;
      if (/^(?:[a-z]+:|#)/i.test(target)) continue;
      if (target.startsWith("<")) continue;
      const clean = target.replace(/#.*$/, "");
      if (!clean) continue;
      links.push({ file, target: clean });
      const abs = path.resolve(path.dirname(path.join(repo, file)), clean);
      const rel = path.relative(repo, abs).split(path.sep).join("/");
      exists[rel] = fs.existsSync(abs);
    }
  }
  return {
    readme: read("README.md"),
    agents: read("AGENTS.md"),
    examplesCount,
    exists,
    links,
    mainline: fs.existsSync(path.join(repo, "docs", "MAINLINE.md")) ? read("docs/MAINLINE.md") : null,
    plan: read("docs/IMPROVEMENT_PLAN.md"),
  };
}

/** 纯函数：给定快照与基线，返回问题列表（可离线负向断言）。 */
export function evaluateDocs(snapshot: DocsSnapshot, baseline: DocsBaseline): Problem[] {
  const problems: Problem[] = [];
  const fail = (message: string): void => { problems.push({ group: "docs", severity: "fail", message }); };
  const warn = (message: string): void => { problems.push({ group: "docs", severity: "warn", message }); };

  const exampleMatch = /离线跑通\s*(\d+)\s*个示例/.exec(snapshot.readme);
  if (!exampleMatch) {
    fail("README 缺少「离线跑通 N 个示例」表述（examples-check 说明必须可见）");
  } else if (Number(exampleMatch[1]) !== baseline.readmeExamples || snapshot.examplesCount !== baseline.readmeExamples) {
    fail(`README 声称 ${exampleMatch[1]} 个示例，examples/apps 实际 ${snapshot.examplesCount} 个，基线 ${baseline.readmeExamples} 个——三处必须一致`);
  }

  for (const rel of baseline.requiredDocLinks) {
    if (!snapshot.exists[rel]) fail(`关键文档 ${rel} 不存在`);
    if (!snapshot.readme.includes(rel)) fail(`README 文档清单缺少 ${rel}`);
  }

  for (const link of snapshot.links) {
    // 只对以仓库内相对路径表达的链接做存在性断言（exists 以仓库相对键存储）。
    const key = link.target.replace(/^\.\//, "");
    const candidates = [key, path.posix.normalize(path.posix.join(path.posix.dirname(link.file), link.target))];
    const known = candidates.some((c) => c in snapshot.exists);
    if (!known) continue;
    const rel = candidates.find((c) => c in snapshot.exists)!;
    if (!snapshot.exists[rel]) fail(`${link.file} 的本地链接指向不存在的 ${rel}`);
  }

  if (!/离线夹具[^。\n]*非门禁[^。\n]*验证/.test(snapshot.agents)) {
    fail("AGENTS.md 未说明「离线夹具仅用于非门禁验证」——与 fixtures/engine 事实不一致（已拍板决策 4）");
  }

  if (snapshot.mainline === null) {
    warn("docs/MAINLINE.md 尚未创建（P0 0.6）——mainline 组创建后转 fail");
  } else {
    if (!snapshot.mainline.includes("L1.5")) fail("docs/MAINLINE.md 缺依赖分层 L1.5");
    if (!snapshot.mainline.includes("S0")) fail("docs/MAINLINE.md 缺执行阶段 S0–S5");
  }

  if (!snapshot.plan.includes("IMPROVEMENT_PLAN_REVIEW.md")) {
    fail("docs/IMPROVEMENT_PLAN.md 未链接架构评审记录 IMPROVEMENT_PLAN_REVIEW.md");
  }
  return problems;
}
