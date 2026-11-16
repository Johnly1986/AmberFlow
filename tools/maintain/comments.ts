/**
 * 可维护性门禁 · 注释组（comments）
 *
 * 对应 v2.1 §4.2：注释解释代码本身说不出来的事，历史归 CHANGELOG。
 * 本组只做两类断言：
 *   硬失败（fail）：失效引用（历史回归/缺失 docs/旧路径）、行号锚点、裸 TODO/FIXME 注释——这些是**错误**。
 *   ratchet（warn）：日期戳 / 方案批次号 / 历史措辞——存量只减不增；B4 迁移（P1）完成后转 fail。
 *
 * 扫描口径：逐行识别「整行注释」与 JSDoc 续行（`//` / `*` / `/*` 开头），不解析字符串里的 `//`
 * （避免把 prompt 模板/URL 当注释——旧审计裸 grep 曾误报 795 行）。行尾内联注释不纳入本组
 * （数量少、改造成本高；TODO 纪律靠 review）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Problem } from "./size.ts";

export interface CommentLine {
  file: string;
  line: number;
  text: string;
}

export interface CommentsSnapshot {
  lines: CommentLine[];
}

export interface CommentsBaseline {
  dateStamps: number;
  planTokens: number;
  historyWording: number;
  lineAnchors: number;
  ghostRefs: number;
  todo: number;
}

const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;
const DATE = /20\d{2}-\d{2}-\d{2}/;
const LINE_ANCHOR = /(?:^|[^A-Za-z0-9_])L\d{3,4}(?![A-Za-z0-9_])|\b[A-Za-z0-9_.-]+\.ts:\d+/;
const PLAN_TOKEN = /\bF\d{1,3}\b|\btask-\d+\b|\b批\s*\d+\b/;
const HISTORY = /曾经|以前|旧实现|旧语义|旧行为|历史|教训|事故|改成|曾反接/;
const TODO = /\b(TODO|FIXME|HACK|XXX)\b/;
const GHOST_REFS: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /历史回归/, why: "引用了仓库不存在的「历史回归」套件" },
  { re: /PORTING\.md|ROOT-CAUSE\.md|DEVELOPING\.md|DECISION_PROVIDER_JEVK5\.md/, why: "引用了不存在的文档" },
  { re: /src\/app\/amberflow-home\.ts/, why: "旧路径（实际为 src/support/amberflow-home.ts）" },
];

/** 收集 src 下全部整行注释（fs 侧）。 */
export function collectComments(repo: string): CommentsSnapshot {
  const root = path.join(repo, "src");
  const lines: CommentLine[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const file = path.relative(repo, abs).split(path.sep).join("/");
      const text = fs.readFileSync(abs, "utf8");
      text.split("\n").forEach((raw, i) => {
        if (!COMMENT_LINE.test(raw)) return;
        lines.push({ file, line: i + 1, text: raw });
      });
    }
  };
  walk(root);
  return { lines };
}

/** 纯函数：给定注释快照与基线，返回问题列表（可离线负向断言）。 */
export function evaluateComments(snapshot: CommentsSnapshot, baseline: CommentsBaseline): Problem[] {
  const problems: Problem[] = [];
  const hits = (re: RegExp): CommentLine[] => snapshot.lines.filter((l) => re.test(l.text));
  const fail = (message: string): void => { problems.push({ group: "comments", severity: "fail", message }); };
  const warn = (message: string): void => { problems.push({ group: "comments", severity: "warn", message }); };

  const ghosts = snapshot.lines.filter((l) => GHOST_REFS.some((g) => g.re.test(l.text)));
  if (ghosts.length > 0) {
    fail(`失效引用 ${ghosts.length} 处（禁止）：${ghosts.slice(0, 3).map((l) => `${l.file}:${l.line}`).join("；")}`);
  }
  const anchors = hits(LINE_ANCHOR);
  if (anchors.length > 0) {
    fail(`行号锚点 ${anchors.length} 处（禁止，改指符号名）：${anchors.slice(0, 3).map((l) => `${l.file}:${l.line}`).join("；")}`);
  }
  // `TODO-REPLACE-ME` / `EXPORT_DONE_PLACEHOLDER` 是 session-export 生成给作者看的**用户可见占位符**，
  // 不是开发待办；静态门禁按内容豁免（避免把生成物文案当成债务）。
  const todos = hits(TODO).filter((l) => !/TODO-REPLACE-ME|EXPORT_DONE_PLACEHOLDER/.test(l.text));
  if (todos.length > 0) {
    fail(`裸 TODO/FIXME 注释 ${todos.length} 处（禁止）：${todos.slice(0, 3).map((l) => `${l.file}:${l.line}`).join("；")}`);
  }
  const dates = hits(DATE);
  if (dates.length > baseline.dateStamps) {
    warn(`日期戳注释 ${dates.length} 处 > 基线 ${baseline.dateStamps}——只减不增（清理后 --update 下调）`);
  }
  const planTokens = hits(PLAN_TOKEN);
  if (planTokens.length > baseline.planTokens) {
    warn(`方案/批次 token ${planTokens.length} 处 > 基线 ${baseline.planTokens}——只减不增`);
  }
  const history = hits(HISTORY);
  if (history.length > baseline.historyWording) {
    warn(`历史措辞 ${history.length} 行 > 基线 ${baseline.historyWording}——只减不增（迁移到 CHANGELOG）`);
  }
  if (anchors.length > baseline.lineAnchors || ghosts.length > baseline.ghostRefs || todos.length > baseline.todo) {
    // 硬失败已在上方记；基线里这些应为 0，保留计数口径供审计。
  }
  return problems;
}

/** 当前计数（供 baseline --report / 安装基线时打印）。 */
export function counts(snapshot: CommentsSnapshot): CommentsBaseline {
  const count = (re: RegExp): number => snapshot.lines.filter((l) => re.test(l.text)).length;
  return {
    dateStamps: count(DATE),
    planTokens: count(PLAN_TOKEN),
    historyWording: count(HISTORY),
    lineAnchors: count(LINE_ANCHOR),
    ghostRefs: snapshot.lines.filter((l) => GHOST_REFS.some((g) => g.re.test(l.text))).length,
    todo: snapshot.lines.filter((l) => TODO.test(l.text) && !/TODO-REPLACE-ME|EXPORT_DONE_PLACEHOLDER/.test(l.text)).length,
  };
}

/**
 * comments 基线只降不升的更新协议（P1-1.3）。
 * 硬失败类必须为 0 才允许写基线；ratchet 类只允许下降/持平，增长即拒绝。
 */
export function mergeCommentsForUpdate(
  previous: CommentsBaseline,
  current: CommentsBaseline,
): { next: CommentsBaseline; errors: string[] } {
  const errors: string[] = [];
  const absolute: Array<keyof CommentsBaseline> = ["lineAnchors", "ghostRefs", "todo"];
  for (const key of absolute) {
    if (current[key] > 0) errors.push(`${key}=${current[key]}：硬失败类必须为 0，不能写进基线`);
  }
  const ratchet: Array<keyof CommentsBaseline> = ["dateStamps", "planTokens", "historyWording"];
  const next: CommentsBaseline = { ...previous };
  for (const key of ratchet) {
    if (current[key] > previous[key]) {
      errors.push(`${key} 从基线 ${previous[key]} 增长到 ${current[key]}：只减不增`);
      continue;
    }
    next[key] = current[key];
  }
  for (const key of absolute) next[key] = current[key];
  return { next, errors };
}
