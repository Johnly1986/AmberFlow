/**
 * `maintain:check` —— 可维护性门禁的统一入口（groups：size / docs / mainline；comments 随后启用）。
 *
 * 设计对齐 `tools/prompt-hit.ts` 的体例：分组输出、`--self-test` 负向自测、退出码 0/1。
 * 与 prompt-hit 的分工：
 *   - prompt-hit 管「提示词怎么说 ↔ 实现认什么」；
 *   - maintain 管「可维护性存量与文档真值」。
 *
 * 用法：
 *   node --experimental-strip-types tools/maintain/index.ts            # 检查（进 npm run check）
 *   ... --self-test                                                     # 合成违规必须被抓住
 *   ... --report                                                        # 只报告不判红（季度趋势）
 *   ... --update                                                        # 基线只许下调/删除
 *   ... --json                                                          # 机器可读
 *
 * 基线文件：`tools/maintain/baseline.json`（进仓库；只减不增）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectSize, evaluateSize, mergeBaselineForUpdate, type Problem, type Severity, type SizeBaseline } from "./size.ts";
import { collectDocs, evaluateDocs, type DocsBaseline, type DocsSnapshot } from "./docs.ts";
import { collectMainline, evaluateMainline, type MainlineBaseline, type MainlineSnapshot } from "./mainline.ts";
import { collectComments, counts as commentCounts, evaluateComments, mergeCommentsForUpdate, type CommentLine, type CommentsBaseline, type CommentsSnapshot } from "./comments.ts";
import { collectConstants, evaluateConstants, scanConstants, type ConstantProblem, type ConstantsBaseline } from "./constants.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE_PATH = path.join(REPO, "tools", "maintain", "baseline.json");
const argv = process.argv.slice(2);
const has = (flag: string): boolean => argv.includes(flag);

interface Baseline {
  _doc: string;
  size: SizeBaseline;
  docs: DocsBaseline;
  mainline: MainlineBaseline;
  comments: CommentsBaseline;
  constants: ConstantsBaseline;
}

function readBaseline(): Baseline {
  const raw = fs.readFileSync(BASELINE_PATH, "utf8");
  return JSON.parse(raw) as Baseline;
}

function report(problems: Problem[], json: boolean): number {
  const fails = problems.filter((p) => p.severity === "fail");
  const warns = problems.filter((p) => p.severity === "warn");
  if (json) {
    console.log(JSON.stringify({ ok: fails.length === 0, fails, warns }, null, 2));
  } else {
    for (const p of fails) console.error(`[${p.group}] FAIL ${p.message}`);
    for (const p of warns) console.error(`[${p.group}] WARN ${p.message}`);
    if (fails.length === 0) {
      console.log(`maintain: OK — size/docs/mainline/comments/constants 五组通过（warn ${warns.length}）`);
    } else {
      console.error(`maintain: FAIL — ${fails.length} 个问题（warn ${warns.length}）；基线文件 ${path.relative(REPO, BASELINE_PATH)}`);
    }
  }
  return fails.length === 0 ? 0 : 1;
}

function check(json: boolean): number {
  const baseline = readBaseline();
  const problems: Problem[] = [];
  const { files, functions } = collectSize(REPO);
  problems.push(...evaluateSize(files, functions, baseline.size, baseline.size));
  problems.push(...evaluateDocs(collectDocs(REPO), baseline.docs));
  problems.push(...evaluateMainline(collectMainline(REPO), baseline.mainline));
  problems.push(...evaluateComments(collectComments(REPO), baseline.comments));
  // constants 组自带 group 字面量；Problem.group 闭集在 size.ts（非本批写域），边界断言保持接线最小。
  problems.push(...(evaluateConstants(collectConstants(REPO), baseline.constants) as unknown as Problem[]));
  return report(problems, json);
}

function update(): number {
  const previous = readBaseline();
  const { files, functions } = collectSize(REPO);
  const { next, errors } = mergeBaselineForUpdate(
    { files, functions, limits: previous.size, template: previous.size },
    previous.size,
  );
  if (errors.length > 0) {
    for (const e of errors) console.error(`maintain --update: ${e}`);
    console.error("maintain --update: 拒绝写入（基线只许下调/删除；新增超标项必须先在代码里解决）");
    return 1;
  }
  const commentUpdate = mergeCommentsForUpdate(previous.comments, commentCounts(collectComments(REPO)));
  if (commentUpdate.errors.length > 0) {
    for (const e of commentUpdate.errors) console.error(`maintain --update: comments ${e}`);
    console.error("maintain --update: 拒绝写入（comments 硬失败类必须为 0；ratchet 类只减不增）");
    return 1;
  }
  const out: Baseline = {
    _doc: previous._doc,
    size: next,
    docs: previous.docs,
    mainline: previous.mainline,
    comments: commentUpdate.next,
    constants: previous.constants,
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`maintain --update: 已写入 ${path.relative(REPO, BASELINE_PATH)}（files ${Object.keys(next.files).length} / functions ${next.functions.length}）`);
  return 0;
}

function selfTest(): number {
  const failures: string[] = [];
  const limits = { newFileMaxLines: 800, newFunctionMaxLines: 150, phaseFunctionMaxLines: 400 };
  const empty = { files: {}, functions: [], phaseFunctions: [] };
  const expectProblem = (label: string, problems: Problem[], match: RegExp): void => {
    if (!problems.some((p) => p.severity === "fail" && match.test(p.message))) {
      failures.push(`${label}: 合成违规未被抓住（期望匹配 ${match}）`);
    }
  };

  expectProblem(
    "size 新文件超限",
    evaluateSize([{ file: "src/new.ts", lines: 900 }], [], limits, empty),
    /新文件/,
  );
  expectProblem(
    "size 存量文件增长",
    evaluateSize([{ file: "src/old.ts", lines: 901 }], [], limits, { ...empty, files: { "src/old.ts": 900 } }),
    /只减不增/,
  );
  expectProblem(
    "size 新函数超限",
    evaluateSize([], [{ file: "src/new.ts", name: "big", lines: 200 }], limits, empty),
    /新函数/,
  );
  expectProblem(
    "size 阶段函数例外上限",
    evaluateSize([], [{ file: "src/run.ts", name: "phase", lines: 450 }], limits, { ...empty, phaseFunctions: ["src/run.ts#phase"] }),
    /阶段函数/,
  );
  // 正例：等于基线不报、≤硬上限不报
  const positive = evaluateSize(
    [{ file: "src/old.ts", lines: 900 }],
    [{ file: "src/old.ts", name: "f", lines: 150 }],
    limits,
    { ...empty, files: { "src/old.ts": 900 }, functions: [{ file: "src/old.ts", name: "f", lines: 150 }] },
  );
  if (positive.length > 0) failures.push(`size 正例被误报：${positive.map((p) => p.message).join("; ")}`);

  const baseSnapshot: DocsSnapshot = {
    readme: "离线跑通 5 个示例\n[架构](ARCHITECTURE.md)\n[计划](docs/IMPROVEMENT_PLAN.md)\n[评审](docs/IMPROVEMENT_PLAN_REVIEW.md)\n[提示词](docs/PROMPT_SYSTEM.md)",
    agents: "离线夹具仅用于非门禁本地等价验证（fixtures/engine/），不进 npm run check",
    examplesCount: 5,
    exists: {
      "ARCHITECTURE.md": true,
      "docs/IMPROVEMENT_PLAN.md": true,
      "docs/IMPROVEMENT_PLAN_REVIEW.md": true,
      "docs/PROMPT_SYSTEM.md": true,
    },
    links: [],
    mainline: "## 依赖分层 L1.5\n## 执行阶段 S0–S5",
    plan: "评审记录见 IMPROVEMENT_PLAN_REVIEW.md",
  };
  const docsBaseline: DocsBaseline = {
    readmeExamples: 5,
    requiredDocLinks: ["ARCHITECTURE.md", "docs/IMPROVEMENT_PLAN.md", "docs/IMPROVEMENT_PLAN_REVIEW.md", "docs/PROMPT_SYSTEM.md"],
  };
  const docsOk = evaluateDocs(baseSnapshot, docsBaseline);
  if (docsOk.some((p) => p.severity === "fail")) failures.push(`docs 正例被误报：${docsOk.map((p) => p.message).join("; ")}`);
  expectProblem("docs 示例数漂移", evaluateDocs({ ...baseSnapshot, readme: "离线跑通 4 个示例" }, docsBaseline), /示例/);
  expectProblem("docs 关键文档缺失", evaluateDocs({ ...baseSnapshot, readme: "离线跑通 5 个示例" }, docsBaseline), /文档清单缺少/);
  expectProblem(
    "docs 死链",
    evaluateDocs(
      {
        ...baseSnapshot,
        exists: { ...baseSnapshot.exists, "docs/NOT_EXIST.md": false },
        links: [{ file: "README.md", target: "docs/NOT_EXIST.md" }],
      },
      docsBaseline,
    ),
    /不存在/,
  );
  expectProblem("docs 夹具表述", evaluateDocs({ ...baseSnapshot, agents: "无离线夹具" }, docsBaseline), /离线夹具/);
  expectProblem("docs MAINLINE 缺层", evaluateDocs({ ...baseSnapshot, mainline: "只有 S0" }, docsBaseline), /L1.5/);

  if (failures.length > 0) {
    for (const f of failures) console.error(`maintain --self-test: ${f}`);
    console.error(`maintain --self-test: FAIL（${failures.length} 条）`);
    return 1;
  }
  // mainline：正例 + 4 条负向（缺层/缺目录/多装配/多 importer）
  const mainlineOk: MainlineSnapshot = {
    doc: "# MAINLINE\nL1.5 S0 S5 引擎入口 宿主集成 开发/创作 目录 → 层映射 Seam / 符号归属冻结表 命名表 integrations/dsh-bridge tools/ src/engine/ src/app/",
    srcDirs: ["src/engine/", "src/app/"],
    mwConstructions: 2,
    runEntryCalls: 3,
    indexImporters: [],
  };
  const mainlineBaseline: MainlineBaseline = { mwConstructions: 6, runEntryCalls: 12 };
  const mainlinePositive = evaluateMainline(mainlineOk, mainlineBaseline);
  if (mainlinePositive.length > 0) failures.push(`mainline 正例被误报：${mainlinePositive.map((p) => p.message).join("; ")}`);
  expectProblem("mainline 缺 L1.5", evaluateMainline({ ...mainlineOk, doc: mainlineOk.doc.replace("L1.5", "") }, mainlineBaseline), /L1\.5/);
  expectProblem("mainline 缺目录", evaluateMainline({ ...mainlineOk, srcDirs: ["src/engine/", "src/newdir/"] }, mainlineBaseline), /未登记/);
  expectProblem("mainline 多装配", evaluateMainline({ ...mainlineOk, mwConstructions: 7 }, mainlineBaseline), /构造/);
  expectProblem(
    "mainline 有 importer",
    evaluateMainline({ ...mainlineOk, indexImporters: ["src/x.ts: from \"./index.ts\""] }, mainlineBaseline),
    /importer/,
  );
  failures.push();
  const mainlineFailures = failures.filter((f) => f.startsWith("mainline"));
  if (mainlineFailures.length > 0) failures.length = failures.length; // keep all

  // comments：正例 + 4 条负向（日期 ratchet / 行号锚点 / 幽灵引用 / 裸 TODO）
  const commentsBaseline: CommentsBaseline = { dateStamps: 0, planTokens: 0, historyWording: 0, lineAnchors: 0, ghostRefs: 0, todo: 0 };
  const commentLine = (text: string): CommentLine => ({ file: "src/x.ts", line: 1, text });
  const commentsOk: CommentsSnapshot = { lines: [commentLine("契约：完成只认信号（唯一出处 checkSignal）。")] };
  const commentsPositive = evaluateComments(commentsOk, commentsBaseline);
  if (commentsPositive.length > 0) failures.push(`comments 正例被误报：${commentsPositive.map((p) => p.message).join("; ")}`);
  expectProblem("comments 行号锚点", evaluateComments({ lines: [commentLine("见 executor.ts:1234 的说明。")] }, commentsBaseline), /行号锚点/);
  expectProblem("comments 幽灵引用", evaluateComments({ lines: [commentLine("等价由 历史回归 钉住。")] }, commentsBaseline), /失效引用/);
  expectProblem("comments 裸 TODO", evaluateComments({ lines: [commentLine("TODO 以后再说。")] }, commentsBaseline), /TODO/);
  const commentsDateBaseline: CommentsBaseline = { ...commentsBaseline, dateStamps: 1 };
  expectProblem("comments 日期 ratchet", evaluateComments({ lines: [commentLine("实测（2026-10-29）结论。"), commentLine("另一处（2026-11-01）。")] }, commentsDateBaseline), /日期戳/);

  // constants：正例（env.ts 读取点 / 平台变量不报）+ 负向（白名单外裸读 fail；调参回写 warn）
  const expectConstantProblem = (label: string, problems: ConstantProblem[], match: RegExp, severity: Severity = "fail"): void => {
    if (!problems.some((p) => p.severity === severity && match.test(p.message))) {
      failures.push(`${label}: 合成违规未被抓住（期望 ${severity} 匹配 ${match}）`);
    }
  };
  const constantsBaseline: ConstantsBaseline = { envReads: 0, tuningHits: 0 };
  const constantsPositive = evaluateConstants(scanConstants([
    { file: "src/support/env.ts", text: "const v = process.env.AMBERFLOW_DECISION_API_KEY;" },
    { file: "src/cli/main.ts", text: 'process.env.NO_COLOR = "1";' },
  ]), constantsBaseline);
  if (constantsPositive.length > 0) {
    failures.push(`constants 正例被误报：${constantsPositive.map((p) => p.message).join("; ")}`);
  }
  expectConstantProblem("constants 白名单外裸读", evaluateConstants(scanConstants([
    { file: "src/model/foo.ts", text: "const x = process.env.AMBERFLOW_DECISION_API_KEY;" },
  ]), constantsBaseline), /裸读 process\.env\.AMBERFLOW_DECISION_API_KEY/);
  expectConstantProblem("constants 调参回写", evaluateConstants(scanConstants([
    { file: "src/engine/foo.ts", text: "await page.goto(url, { timeout: 30_000 });" },
  ]), constantsBaseline), /疑似回写 tuning 常量 NAVIGATION_GOTO_TIMEOUT_MS/, "warn");
  // comments --update 协议：只降不升 + 硬失败类必须为 0
  const mergeBase: CommentsBaseline = { dateStamps: 3, planTokens: 5, historyWording: 7, lineAnchors: 0, ghostRefs: 0, todo: 0 };
  const mergeOk = mergeCommentsForUpdate(mergeBase, { ...mergeBase, dateStamps: 2 });
  if (mergeOk.errors.length > 0 || mergeOk.next.dateStamps !== 2) failures.push("comments update 正例（下调）被误报");
  const mergeGrowth = mergeCommentsForUpdate(mergeBase, { ...mergeBase, historyWording: 8 });
  if (!mergeGrowth.errors.some((e) => /historyWording/.test(e))) failures.push("comments update 增长未被拒绝");
  const mergeAbsolute = mergeCommentsForUpdate({ ...mergeBase, lineAnchors: 0 }, { ...mergeBase, lineAnchors: 1 });
  if (!mergeAbsolute.errors.some((e) => /lineAnchors/.test(e))) failures.push("comments update 硬失败类非 0 未被拒绝");
  console.log("maintain --self-test: OK — 负向断言 21 条（size 4 / docs 5 / mainline 4 / comments 4 / comments-update 2 / constants 2）+ 正例 6 条全部符合预期");
  return 0;
}

const help = (): void => {
  console.log(`usage: node --experimental-strip-types tools/maintain/index.ts [--self-test|--report|--update|--json]
  （默认 = 检查；--report 只报告不判红；--update 基线只许下调）`);
};

if (has("--help")) {
  help();
  process.exit(0);
}
if (has("--self-test")) process.exit(selfTest());
if (has("--update")) process.exit(update());
if (has("--report")) {
  const baseline = readBaseline();
  const { files, functions } = collectSize(REPO);
  const overFiles = files.filter((f) => f.lines > baseline.size.newFileMaxLines);
  const overFns = functions.filter((f) => f.lines > baseline.size.newFunctionMaxLines);
  const cc = commentCounts(collectComments(REPO));
  console.log(`maintain report: 文件 ${files.length}；>${baseline.size.newFileMaxLines} 行 ${overFiles.length}（基线 ${Object.keys(baseline.size.files).length}）；>${baseline.size.newFunctionMaxLines} 行函数 ${overFns.length}（基线 ${baseline.size.functions.length}）；注释：日期 ${cc.dateStamps}/基线 ${baseline.comments.dateStamps}、批次 token ${cc.planTokens}/${baseline.comments.planTokens}、历史措辞 ${cc.historyWording}/${baseline.comments.historyWording}、行号 ${cc.lineAnchors}、幽灵 ${cc.ghostRefs}、TODO ${cc.todo}`);
  process.exit(0);
}
process.exit(check(has("--json")));
