/**
 * golden-manual —— 六条人工路径话术基线（介入/救援模块设计 §8 步 2 先建 golden）。
 *
 * 基线先冻结、再动实现：本工具对六条人工路径做**静态源码扫描**，抽取每条路径的
 * 话术锚点事实，与 `tools/golden/manual-baseline.json` 快照比对。A 组（逐字节）的
 * 运行时面（--json / report）由步 2 后续提交接线；B 组（真实求援）本轮只建骨架。
 *
 * 路径清单（设计 §8 步 2 原文）：
 *   1  src/cli/start.ts            规划脸人工确认「这一步完成了么？(y/N) > 」
 *   2  src/app/app-runner.ts       promptManualOnTty 的「[manual] …」/「完成后按 Enter 继续；输入 n 放弃：」
 *   3  src/app/ctx-dry.ts          dry 桩 manual 的 trace 事件形状（result: { dry: true, instructions }）
 *   4  src/app/app-runner.ts       runManualStep 的 manual_handler_error reason 模板
 *   5  src/app/ctx-replay.ts       replay 桩 manual（nextEvent("manual", …) + stepResult）
 *   6  src/app/agent-view.ts +     needs_human 判定 + report「人工步骤」表渲染（消费面）
 *      src/app/app-report-view.ts
 *
 * 提取方式统一：定位锚点行 → 抽取 ≤3 行窗口 → 归一空白（连续空白折叠为单空格、
 * 去首尾空白）→ 存入快照 JSON。文件不存在或锚点缺失 = 单条 problem。
 *
 * 双轨验收（设计 §7「字节兼容」）：
 *   A 组（逐字节）  四条冻结人工路径 + 非 TTY 无 handler 场景的 --json 结果与 report
 *                  输出，比对前先经 `normalizeForGolden` 剔除/归零每次必变字段
 *                  （elapsedMs / started / *_at / at / epoch / run_id / secs /
 *                  saved_at / 临时目录段 → <TMP>）。
 *   B 组（逐字段）  真实求援场景——本轮只建工具骨架与空目录，不生成快照。
 *
 * 本工具还导出 `normalizeForGolden(json: unknown): unknown`，供步 2 后续提交
 * （B 组接线与切默认验收）复用——规范化规则只有这一处。
 *
 * 退出码：0 全绿 / 1 有不一致 / 2 用法错误。
 * 用法：
 *   npm run golden-manual              # 扫描比对（缺快照即红）
 *   npm run golden-manual -- --fix     # 写入/刷新 tools/golden/manual-baseline.json
 *   npm run golden-manual -- --run-sample  # A 组运行时基线（见 deferredRunSample）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO } from "../src/support/paths.ts";

/* ---- 用法与参数 ------------------------------------------------------------ */

const args = process.argv.slice(2);
const fix = args.includes("--fix");
const runSample = args.includes("--run-sample");
const unknown = args.filter((a) => a !== "--fix" && a !== "--run-sample");
if (unknown.length > 0) {
  console.error(`golden-manual: 未知参数 ${unknown.join(", ")}`);
  console.error("usage: npm run golden-manual [-- --fix | -- --run-sample]");
  process.exit(2);
}

const BASELINE = path.join(REPO, "tools", "golden", "manual-baseline.json");

/** 锚点定位：源文本里首次命中该正则的行。 */
interface Anchor {
  /** 路径编号（设计 §8 步 2 的 1..6）。 */
  path: number;
  /** 仓库相对路径（快照键）。 */
  file: string;
  /** 锚点定位正则（只用于找行；归一文本才是比对面）。 */
  find: RegExp;
  /** 断言：归一窗口必须逐字节包含这些字面量（否则锚点缺失）。 */
  mustContain: string[];
}

/**
 * 定位锚点行并抽取归一窗口：锚点行 + 其后最多 2 行（≤3 行），CRLF 先归 LF，
 * 再把连续空白折叠为单空格、去首尾空白。
 */
function extractAnchor(text: string, find: RegExp): string | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const idx = lines.findIndex((l) => find.test(l));
  if (idx < 0) return null;
  const window = lines.slice(idx, Math.min(idx + 3, lines.length)).join(" ");
  return window.replace(/\s+/g, " ").trim();
}

/* ---- 六条路径的锚点定义 ------------------------------------------------------ */

const ANCHORS: Anchor[] = [
  {
    path: 1,
    file: "src/cli/start.ts",
    // 规划脸人工确认话术行（manualConfirmFn 内的 io.ask）。
    find: /这一步完成了么？\(y\/N\) > /,
    mustContain: ["这一步完成了么？(y/N) > "],
  },
  {
    path: 2,
    file: "src/app/app-runner.ts",
    // promptManualOnTty 函数体：先定位函数头，窗口须含两段话术。
    find: /console\.log\(`\\n\[manual\] \$\{req\.desc\}`\)/,
    mustContain: ["[manual] ", "完成后按 Enter 继续；输入 n 放弃："],
  },
  {
    path: 3,
    file: "src/app/ctx-dry.ts",
    // dry 桩 manual：trace 事件 result 形状（call: "manual" 行起 3 行窗口）。
    find: /call: "manual", desc, url: currentUrl, ok: true,/,
    mustContain: ["result: { dry: true, instructions:"],
  },
  {
    path: 4,
    file: "src/app/app-runner.ts",
    // runManualStep 的 handler 抛错 reason 模板。
    find: /manual_handler_error: \$\{/,
    mustContain: ["manual_handler_error: ${"],
  },
  {
    path: 5,
    file: "src/app/ctx-replay.ts",
    // replay 桩 manual：nextEvent("manual") 行起窗口须含 stepResult(ev)。
    find: /const ev = nextEvent\("manual", \{ desc \}\);/,
    mustContain: ['nextEvent("manual", { desc })', "stepResult(ev)"],
  },
  {
    path: 6,
    file: "src/app/agent-view.ts",
    // needs_human 判定行（manual_steps 消费面）；report 侧锚点单独扫描（见 PATH6_REPORT）。
    find: /const manual = \(result\.manual_steps \?\? \[\]\)\.some\(\(m\) => !m\.done\);/,
    mustContain: ["(result.manual_steps ?? []).some((m) => !m.done)", "needs_human"],
  },
];

/** 路径 6 的第二消费面：report 视图「人工步骤」表渲染（markdown 段）。 */
const PATH6_REPORT: Anchor = {
  path: 6,
  file: "src/app/app-report-view.ts",
  find: /## 人工步骤（登录\/验证码\/人工确认）/,
  mustContain: ["## 人工步骤（登录/验证码/人工确认）", "manual_steps"],
};

/* ---- 扫描：抽取全部锚点事实 --------------------------------------------------- */

interface Fact {
  path: number;
  file: string;
  anchor: string;
}

const problems: string[] = [];
const facts: Fact[] = [];

function scanAnchor(a: Anchor): void {
  const full = path.join(REPO, ...a.file.split("/"));
  if (!fs.existsSync(full)) {
    problems.push(`路径 ${a.path}: 文件缺失 ${a.file}`);
    return;
  }
  const text = fs.readFileSync(full, "utf-8");
  const anchor = extractAnchor(text, a.find);
  if (anchor === null) {
    problems.push(`路径 ${a.path}: ${a.file} 未找到锚点（/${a.find.source}/）`);
    return;
  }
  for (const lit of a.mustContain) {
    if (!anchor.includes(lit)) {
      // 窗口不够盖住全部字面量时，允许在整文件（归一后）里找——锚点行只是定位面。
      const whole = text.replace(/\r\n/g, "\n").replace(/\s+/g, " ");
      if (!whole.includes(lit)) {
        problems.push(`路径 ${a.path}: ${a.file} 锚点窗口缺字面量 ${JSON.stringify(lit)}`);
      }
    }
  }
  facts.push({ path: a.path, file: a.file, anchor });
}

for (const a of ANCHORS) scanAnchor(a);
scanAnchor(PATH6_REPORT);

/* ---- normalizeForGolden：A 组逐字节比对的规范化（唯一出处） -------------------- */

/** 每次必变、比对前剔除/归零的字段（显式列表，设计 §7「字节兼容」行）。 */
const VOLATILE_KEYS = new Set([
  "elapsedMs", "elapsed_ms", "started", "epoch", "run_id", "secs", "saved_at",
]);
/** `*_at` 用「键名以 _at 结尾或等于 at」判定。 */
function isVolatileKey(key: string): boolean {
  return VOLATILE_KEYS.has(key) || key === "at" || key.endsWith("_at");
}
/** 绝对路径里的临时目录段归一为 <TMP>（会话临时目录 + os.tmpdir() 前缀）。 */
function maskTmpSegments(value: string): string {
  const prefixes = [
    path.join(REPO, ".session_tmps"),
    os.tmpdir(),
    REPO + path.sep + ".session_tmps",
  ];
  // 先长后短替换，避免 tmpdir 是 .session_tmps 前缀的边角。
  const uniq = [...new Set(prefixes.filter((p) => p.length > 0))].sort((x, y) => y.length - x.length);
  let out = value;
  for (const p of uniq) out = out.split(p).join("<TMP>");
  return out;
}

/**
 * golden 规范化：递归剔除/归零必变字段（显式列表 + `_at` 后缀判定），并把字符串里
 * 的临时目录段替换为 `<TMP>`。数组元素递归；键名本身含 `_at` 的对象值置 0。
 */
export function normalizeForGolden(json: unknown): unknown {
  if (Array.isArray(json)) return json.map(normalizeForGolden);
  if (json !== null && typeof json === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
      if (isVolatileKey(k)) {
        out[k] = 0;
      } else {
        out[k] = normalizeForGolden(v);
      }
    }
    return out;
  }
  if (typeof json === "string") return maskTmpSegments(json);
  return json;
}

/* ---- --run-sample：A 组运行时基线（本轮显式推迟） ------------------------------ */

/**
 * 设计 §8 步 2 的 A 组运行时面（非 TTY 无 handler 的 --json / report 逐字节）需要
 * 真实 dry 运行；仓库的 dry 路径依赖浏览器/模型，离线子进程不可行，而 AGENTS.md
 * 红线禁止引入测试框架或离线夹具——因此本轮显式推迟：只打印说明并 exit 0，
 * 不做假运行。接线提交落地后，此处改为真实采样 + normalizeForGolden 比对。
 */
function deferredRunSample(): void {
  console.log("golden-manual: --run-sample → runtime baseline deferred");
  console.log("  （A 组运行时面需真实 dry 运行——浏览器/模型依赖 + 无测试夹具红线，");
  console.log("   本轮只冻结静态话术基线；接线提交落地后再生成运行时快照。）");
}

/* ---- 快照写入 / 比对 ---------------------------------------------------------- */

interface Baseline {
  /** 快照工具与规则的简述（人类可读，变更即重写）。 */
  note: string;
  generated_at: string;
  /** A 组运行时基线：显式推迟（真实求援尚未接线，B 组不生成）。 */
  runtime: "deferred";
  /** 六条路径的归一锚点文本（键 = 仓库相对路径）。 */
  anchors: Record<string, string[]>;
}

function buildBaseline(): Baseline {
  const anchors: Record<string, string[]> = {};
  for (const f of facts) {
    (anchors[f.file] ??= []).push(f.anchor);
  }
  return {
    note: "六条人工路径话术基线（介入/救援模块设计 §8 步 2）：归一锚点文本 = 锚点行 + 其后 ≤2 行，"
      + "CRLF→LF、连续空白折叠单空格、去首尾空白。比对为逐字节（归一后）；"
      + "话术改动 = 演进，须 --fix 显式刷新。",
    generated_at: new Date().toISOString(),
    runtime: "deferred",
    anchors,
  };
}

const snapshotMissing = !fs.existsSync(BASELINE);
let mismatch = false;

if (snapshotMissing || fix) {
  if (facts.length !== 7) {
    // 六条路径、七个锚点（路径 6 双文件）。缺锚点时绝不写半份快照。
    for (const p of problems) console.error(`golden-manual: ${p}`);
    console.error(`golden-manual: 锚点不全（${facts.length}/7），拒绝写快照`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(buildBaseline(), null, 2) + "\n", "utf-8");
  console.log(`golden-manual: ${snapshotMissing ? "快照缺失" : "--fix"}，已重写 ${path.relative(REPO, BASELINE)}`);
} else if (facts.length === 7 && problems.length === 0) {
  // 有快照且静态扫描全绿：逐字节比对归一锚点。
  const baseline: unknown = JSON.parse(fs.readFileSync(BASELINE, "utf-8"));
  const expected = (baseline as { anchors?: Record<string, string[]> }).anchors ?? {};
  const actual = buildBaseline().anchors;
  for (const file of Object.keys(expected)) {
    for (let i = 0; i < expected[file]!.length; i++) {
      if (expected[file]![i] !== actual[file]?.[i]) {
        mismatch = true;
        console.error(
          `golden-manual: 路径 ${file}#${i} 话术漂移——基线 ${JSON.stringify(expected[file]![i])}`
          + ` ≠ 现状 ${JSON.stringify(actual[file]?.[i] ?? null)}（有意演进请 npm run golden-manual -- --fix）`,
        );
      }
    }
  }
  for (const file of Object.keys(actual)) {
    if (expected[file] === undefined) mismatch = true;
  }
} else {
  mismatch = true;
}

if (runSample) deferredRunSample();

if (problems.length > 0) {
  for (const p of problems) console.error(`golden-manual: ${p}`);
  process.exit(1);
}
if (mismatch) {
  process.exit(1);
}

if (!fix && !snapshotMissing && !runSample) {
  const byPath = new Map<number, string[]>();
  for (const f of facts) byPath.set(f.path, [...(byPath.get(f.path) ?? []), f.anchor]);
  console.log("golden-manual: OK — 六条人工路径话术基线全绿（归一锚点逐字节一致）：");
  for (let p = 1; p <= 6; p++) {
    for (const a of byPath.get(p) ?? [`<路径 ${p} 缺锚点>`]) {
      console.log(`  ${p}. ${a.length > 72 ? a.slice(0, 72) + "…" : a}`);
    }
  }
}
