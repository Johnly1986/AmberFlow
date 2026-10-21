/**
 * 架构图生成器（`node tools/arch-diagram.mjs [--png] [--check] [--out <path>]` → `docs/architecture.svg`）。
 *
 * 2026-10 更新（P0–P4 + D3/R-4 落地、模型角色实测之后）：④ 的链条补上**命令闭集**（P2）、
 * **执行动作里的具名绑定**（P3）、**同一元素重复上界 → no_progress**（D3/R-4）；③ 写明
 * `id/next` 与 `runPlan` 对边的拒绝；⑤ 写上真模型的实测口径（它现在是兜底与诊断，不是承重件）。
 *
 * 为什么是**生成**而不是手画：手画的图会随代码漂移，而且"文字出框/盒子重叠"这类缺陷
 * 只有量过才发现。这里每条文字行都按 CJK≈1em / ASCII≈0.55em 估宽，任何一行出框、
 * 任何两个盒子重叠、任何盒子越过内容右界——**直接非零退出**，图就不会以坏的样子进仓库。
 * 要改图：改下面的 box()/band() 调用，跑一次，量不过它会告诉你哪一行太长。
 *
 * 渲染成 PNG（可选）：用仓库里的 playwright chromium 把 SVG 内联进 HTML 截图即可
 * （viewBox 1560×1120，deviceScaleFactor 2）。
 *
 * **`--check` 是自洽门，不是真值门**：它只保证"仓库里那份 == 生成器现在的输出"，
 * 图里写死的数字（测试条数、实测口径之类）不受它保护——改完仓库要**顺手把数字重算一遍**，
 * 否则会出现"图里 1061、实际 1068、而 --check 照样绿"（本轮实测到过）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const W = 1560, PAD = 11;
const wide = (cp) =>
  (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0x303E) || (cp >= 0x3041 && cp <= 0x33FF)
  || (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0xA000 && cp <= 0xA4CF)
  || (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE4F)
  || (cp >= 0xFF00 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x2000 && cp <= 0x206F && cp !== 0x2022);
const est = (s, size) => [...s].reduce((n, ch) => {
  const cp = ch.codePointAt(0);
  if (wide(cp)) return n + size * 1.0;
  if (ch === " ") return n + size * 0.30;
  return n + size * 0.55;
}, 0);

const problems = [];

// 计量单一出处（docs/ARCHITECTURE_REVIEW…不，见 docs/ARCHITECTURE_IMPROVEMENTS.md §1/§8）：
// 图里**能算的数字一律从 arch-metrics.json 插值**，不再手写——否则"图与生成结果一致"的
// --check 只是自洽门（本轮实测：图里写 1061、实际 1068，--check 照样绿）。
// JSON 缺失就记为问题（先检查后写 ⇒ 不落盘），而不是悄悄退回旧数字。
const HERE0 = path.dirname(fileURLToPath(import.meta.url));
let M = null;
try {
  M = JSON.parse(fs.readFileSync(path.resolve(HERE0, "..", "docs", "arch-metrics.json"), "utf-8"));
} catch {
  problems.push("计量缺失：docs/arch-metrics.json 读不到（跑 npm run metrics）");
}
const mv = (get, label) => {
  if (!M) return "?" + label;
  const v = get(M);
  if (v === null || v === undefined) { problems.push(`计量缺字段：${label}（刷新 docs/arch-metrics.json）`); return "?"; }
  return String(v);
};
const N = {
  tests: mv((m) => m.tests?.count, "tests.count"),
  binLines: mv((m) => m.corpus?.bin_fixture_lines, "corpus.bin_fixture_lines"),
  hintPct: mv((m) => m.corpus?.hint_coverage?.pct, "corpus.hint_coverage.pct"),
  named: mv((m) => m.corpus?.hint_coverage?.named, "corpus.hint_coverage.named"),
  hinted: mv((m) => m.corpus?.hint_coverage?.hinted, "hint_coverage.hinted"),
  browserSteps: mv((m) => m.corpus?.hint_coverage?.browser, "hint_coverage.browser"),
  top1: mv((m) => m.model?.harness?.numeric?.top1_pct, "harness.top1_pct"),
  prec: mv((m) => m.model?.harness?.numeric?.precision025_pct, "harness.precision025_pct"),
  aucPt: mv((m) => m.model?.harness?.numeric?.passthrough_auc, "harness.passthrough_auc"),
  aucSl: mv((m) => m.model?.harness?.numeric?.shortlist_auc, "harness.shortlist_auc"),
};
const boxes = [];
const check = (where, text, size, max) => { if (est(text, size) * 1.06 > max) problems.push(`${where}: ${Math.round(est(text,size)*1.06)} > ${Math.round(max)}  ${JSON.stringify(text)}`); };

const out = [];
const T = (x, y, s, cls, extra = "") => out.push(`<text x="${x}" y="${y}" class="${cls}"${extra}>${s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</text>`);
const R = (x, y, w, h, cls) => out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" class="${cls}"/>`);
const P = (d, cls = "ln", marker = true) => out.push(`<path class="${cls}" d="${d}"${marker ? ' marker-end="url(#arr)"' : ""}/>`);

/** 盒子：title + 若干副行。自动量宽，超宽即记问题。 */
function box(x, y, w, h, cls, title, lines, opts = {}) {
  boxes.push({ x, y, w, h, title });
  R(x, y, w, h, cls);
  const inner = w - PAD * 2;
  const size = opts.titleSize ?? 12.5;
  check(`${title}`, title, size, inner);
  T(x + PAD, y + (opts.titleDy ?? 19), title, "t", ` font-size="${size}"`);
  let ty = y + (opts.titleDy ?? 19) + 16;
  for (const l of lines) {
    const c = l.startsWith("$") ? "sm" : "s";
    const text = l.startsWith("$") ? l.slice(1) : l;
    check(`${title} / ${text.slice(0, 12)}`, text, 10.5, inner);
    T(x + PAD, ty, text, c);
    ty += 14;
  }
}

const band = (y, h, label) => { R(40, y, W - 80, h, "band"); T(58, y + 24, label, "lay"); };

/* ---------------- L1 入口 ---------------- */
band(70, 236, "① 入口层（一条命令 / 一次工具调用）");
box(175, 106, 210, 78, "bx", "npm start · doctor", ["src/cli/start.ts", "开箱任务；演示一次即归纳信号", "缺件点名 + 一条补齐命令"]);
box(400, 106, 210, 78, "bx", "npm run apps", ["src/app/app-runner.ts", "数据腿 → 旅程 → 结束态不变量", "--dry / --ablate / --slot"]);
box(625, 106, 210, 78, "bx", "npm run learn · agent", ["tools/learn.ts --json --yes", "演示一次 → 录成应用包", "零模型重放通过才落盘"]);
box(850, 106, 225, 78, "bx", "plan:flow · semantic", ["plan-flow / semantic-flow", "一句话+种子页 → 模板+站点档案", "跨站迁移 · 回填重放门"]);
box(1090, 106, 175, 78, "bx", "plan-cli · datasource", ["plan_cli / datasource", "手写计划；站点=配置", "sources/*.json 发现制"]);
box(1280, 106, 135, 78, "bx", "bench · 探针", ["bench.ts / live-*", "冻结计划跑分矩阵", "可达性长流程实测"]);

box(175, 196, 620, 84, "bxp", "DSH 插件模式（integrations/dsh-bridge）", [
  "四个工具：apps 列包 · run 跑应用 · learn 录流程 · plan 出模板",
  "$引擎对 DSH 零引用：桥起 CLI 子进程，读 *-result.json 归纳 summary",
  "$summary 带 model: on|off(missing) 与决策来源小计；危险步默认拒绝",
]);
box(810, 196, 257, 84, "bxm", "npm run model:fetch", ["src/model/model-fetch.ts → ⑤ 的约定路径", "图 + 权重（+ tokenizer）", ".part 先落，SHA256 先验后换", "半途态整组撤回，不覆盖已有"]);
box(1075, 196, 340, 98, "bxe", "度量与门禁（同一条命令可复现）", [
  "apps:matrix 声明成本 / 0 代码行 / 站点知识泄漏与债",
  "apps:suite 逐应用真跑 + 模型账 · apps:gen --check",
  "model:contribution 逐题实测 · ask-shapes 换问法",
  "probes:baseline · verify · smoke.sh——全绿才算完",
  "$读 ④ 落下的 *-result.json（模型账两列的出处）",
]);
T(58, 296, "入口只编排：所有浏览器决策都落到同一个执行循环（④），没有第二个分支", "lbl");

/* ---------------- L2 应用数据 ---------------- */
band(322, 122, "② 应用 = 目录（数据，不是代码）");
box(175, 356, 320, 78, "bxd", "apps/<id>/pack.json", ["roles 模板 · journey 混合步（浏览器+工具）", "slots · invariants · hosts · device · probe", "加载期校验：与计划同一套语法"]);
box(510, 356, 320, 78, "bxd", "sources/*.json（数据腿）", ["transport: curl / fetch / cli（argv 数组，无 shell）", "extractor 四种 · date 表达式 · counts/selects", "\"引擎不认识站点\"是单测"]);
box(845, 356, 320, 78, "bxd", "flow.json + sites/*.profile.json", ["spec_version 2：页面角色 + 语义目标 + 契约信号", "authored 档案：pages / fill_keys / list_extract", "学到的 hint 另存，replays_ok 计数，不过报 drift"]);
box(1180, 356, 235, 78, "bxd", "血统与可复现", ["generated_from / recorded_from", "FROZEN_TODAY 钉住展开周", "未声明的 {slot} 即用法错误"]);
T(58, 438, `新增一个应用 = 新目录；应用目录里的应用逻辑代码行数由 apps:matrix 计（0；bin/ 桩夹具 ${N.binLines} 行另列，npm run metrics）`, "lbl");

/* ---------------- L3 计划 ---------------- */
band(460, 92, "③ 计划层");
box(175, 492, 330, 50, "bx", "src/engine/plan.ts：TaskPlan/PlanningRules", ["有序子目标 + 完成信号 + 数据袋 · checkpoint 续跑"]);
box(520, 492, 330, 50, "bx", "src/engine/planner.ts — runPlan / 重试", ["when 跳过 · retries 整步重跑 · replan 异常必打印"]);
box(865, 492, 300, 50, "bx", "LLM 规划 / 审计（可选）", ["OPENAI_* 齐则启用，否则 Mock/Scripted 照常全流程"]);
box(1180, 492, 235, 50, "bx", "engine/signals.ts — 信号语言", ["5 个 DOM 算子 + all_of/any_of/not"]);

T(58, 548, "P4：步 id/next + createPathWalk（路径上界 → next_cycle）；runPlan 拒绝 next 边——声明式后继只在应用旅程层生效；signal 与 when 走同一个走查器", "lbl");

/* ---------------- L4 执行 ---------------- */
band(568, 208, "④ 执行层 — 唯一生产循环 BrowserMiddleware.run（永不分叉；bench 只继承换 checkpoint/消融开关）");
const chain = [
  ["元素抽取", ["extraction.ts", "一次 JS pass", "iframe+shadow"]],
  ["命令闭集", ["actions.ts P2", "声明×当次观察", "空则 space_empty"]],
  ["规则 / hint", ["rules.ts", "nav / affordance", "分层 hint 匹配"]],
  ["laya 选", ["pickElement", "conf < floor", "→ block"]],
  ["加宽重看", ["reobserve ×1", "120 元素", "laya:reobserve"]],
  ["升级老师", ["escalateFn", "只能点池中 ref", "失败即弃权"]],
  ["风险闸门", ["DESTRUCTIVE", "+ 模型票 ≥0.6", "dry-run 证据"]],
  ["可点性探针", ["hit-test / 遮挡", "失败=结果", "不抛栈"]],
  ["执行动作", ["click / type", "select / radio", "填值=绑定 P3"]],
  ["inert → 上界", ["url+text+values", "同元素重复→", "no_progress D3"]],
  ["完成 = 信号", ["check_signal", "noul 仅参考", "manual → 问人"]],
];
const cw = 118, gap = 4, x0 = 60;
chain.forEach(([t, ls], i) => {
  const cls = ["laya 选", "加宽重看", "升级老师"].includes(t) ? "bxm"
    : ["命令闭集", "inert → 上界"].includes(t) ? "bxnew"
    : t.startsWith("完成") ? "bxe" : "bx";
  box(x0 + i * (cw + gap), 604, cw, 72, cls, t, ls, { titleSize: 11.5, titleDy: 17 });
  if (i) P(`M${x0 + i * (cw + gap) - gap},640 H${x0 + i * (cw + gap)}`);
});
box(60, 690, 400, 82, "bx", "工具步（命令行当动作腿）", ["src/browser/tool-signals.ts：", "exit_ok / stdout / json_path / file_exists", "retries 需 idempotent；dangerous 需 dry_run_args；拒绝不落盘"]);
box(475, 690, 330, 68, "bxm", "决策缓存 + 咨询计数", ["decision-cache.ts：精确指纹，同问不重答", "model.ts countingRuntime：出场率在运行时缝上数"]);
box(820, 690, 315, 68, "bxm", "记忆两本账", ["hint-memory.ts：回填过了重放门才落盘", "outcome-memory.ts：失败动作按签名禁复用"]);
box(1150, 690, 265, 68, "bxe", "运行结果 = 可核对的证据", ["<app>-result.json：model_status", "<app>-report.md：逐步表 + 决策来源小计"]);
T(58, 776, "低置信 break 的那次咨询不在 trace 留 method——咨询数在运行时缝上数，过关数在 trace 里数", "lbl");

/* ---------------- L5 模型运行时 ---------------- */
band(792, 134, "⑤ 模型运行时（可缺席——缺了走规则模式，需要模型的步骤如实 block）");
box(175, 826, 260, 66, "bxm", "src/model/model.ts — LayaRuntime", ["load / predictShortlist / Router", "测试注入 scriptedRuntime，不碰权重"]);
box(450, 826, 300, 66, "bxm", "laya-onnx.ts + laya-format.ts", ["buildSequence · 温度标定 · shortlist k=8", "checkpoint 按文字系统路由，不按置信度"]);
box(765, 826, 320, 66, "bxm", "产物：图 + .onnx.data + tokenizer", ["约 1.7GB，刻意不进 git", "LAYA_ONNX_MODEL 约定 / HF 快照发现"]);
box(1100, 826, 315, 66, "bxm", "src/model/model-artifacts.ts", ["三件齐才算 on（单一出处）", "doctor / fetch / 运行器 / 桥 共用"]);
T(58, 906, `实测（真 ONNX，本机）：浏览器步 ${N.named}/${N.browserSteps} 全由声明解决（其中 ${N.hinted} 用 hint 点名 = ${N.hintPct}%，其余走 commands 闭集）；模型 top-1 ${N.top1}%、闸门内 precision ${N.prec}%（两把不可比的尺子：passthrough AUC ${N.aucPt} / shortlist AUC ${N.aucSl}）`, "lbl");


/* ---------------- L6 证据 ---------------- */
band(924, 108, "⑥ 分层证据（结论必须能被命令复现，叙述不算证据）");
box(175, 958, 420, 60, "bxe", `tests/ ${N.tests} 条 + 六层跨实现对拍（冻结语料）`, ["rules/extraction/executor/datasource/ctrip/transfer", "node-port-poc：ONNX 与 ORT 数值对拍 max|diff| 2.98e-5"]);
box(610, 958, 400, 60, "bxe", "用例与线上复测记录", ["bench/cases*.json · ctrip 19 子目标 + 独立判分 7/7", "transfer 七站 · live-retest 逐项原始观测"]);
box(1025, 958, 390, 60, "bxe", "作者 / 独立复核两角色", ["apps/INVENTORY.md 定义\"完成一个应用\"的五条", "APP_VERIFY_REPORT.md：缺陷带最小复现，报而不装绿"]);

/* ---------------- 层间箭头（只走干净竖直/单一折线） ---------------- */
P("M700,306 V352"); T(710, 330, "发现包 / 模板", "lbl");
P("M700,444 V488"); T(710, 470, "expandPack / compileFlow → 冻结计划", "lbl");
P("M700,552 V600"); T(710, 578, "子目标 + 完成信号 + slots", "lbl");
P("M600,758 V822"); T(612, 790, "经决策缓存与咨询计数后问模型", "lbl");
out.push(`<path class="lnb" d="M1000,280 V300 H1465 V800 H900 V822" marker-end="url(#arrB)"/>`);
out.push(`<path class="lnb" d="M1415,724 H1450 V250 H1419" marker-end="url(#arrB)"/>`);
T(1120, 318, "装进 ⑤ 的约定路径", "lbl");
T(1424, 520, "模型账 → 度量", "lbl", ` transform="rotate(90 1424 520)"`);

/* ---------------- 红线 ---------------- */
R(40, 1048, W - 80, 60, "band red");
T(58, 1070, "四条红线（有测试与门禁撑着，不是口号）", "foot", ' font-weight="700"');
T(58, 1090, "① 不重规划——任务开始即冻结计划；② 不发明取值——填的值只来自 slots；③ 不信模型说\"完成\"——只认该步 DOM/URL 信号；④ 不可复现即拒存——零模型重放门不过就一个文件都不落，危险步先干跑再点头。", "foot");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="1120" viewBox="0 0 ${W} 1120" font-family="'PingFang SC','Microsoft YaHei','Noto Sans CJK SC','Source Han Sans CN','Helvetica Neue',Arial,sans-serif">
<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#4a5568"/></marker>
<marker id="arrB" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#2b6cb0"/></marker>
<style>
.band{fill:#f7f8fa;stroke:#d7dce3;stroke-width:1}
.red{fill:#fff5f5;stroke:#e08383}
.lay{fill:#2d3748;font-size:13.5px;font-weight:700}
.bx{fill:#fff;stroke:#b8c1cc;stroke-width:1.2}
.bxd{fill:#fffaf0;stroke:#dd9b3b;stroke-width:1.2}
.bxm{fill:#ebf4ff;stroke:#4a86c5;stroke-width:1.2}
.bxe{fill:#f0fff4;stroke:#4a9d63;stroke-width:1.2}
.bxp{fill:#faf5ff;stroke:#8b5fbf;stroke-width:1.4}
.bxnew{fill:#f0f7ff;stroke:#2b6cb0;stroke-width:1.6}
.t{fill:#1a202c;font-size:12.5px;font-weight:600}
.s{fill:#4a5568;font-size:10.5px}
.sm{fill:#2b6cb0;font-size:10.5px}
.ln{stroke:#4a5568;stroke-width:1.4;fill:none}
.lnb{stroke:#2b6cb0;stroke-width:1.4;fill:none;stroke-dasharray:5 3}
.lbl{fill:#718096;font-size:10.5px;font-style:italic}
.foot{fill:#4a5568;font-size:11.5px}
</style></defs>
${out.join("\n")}
</svg>`;

// 重叠检查：同一行（y 区间相交）里 x 区间也相交 = 碰撞；另查是否越出内容右界 1415
for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
  const a = boxes[i], b = boxes[j];
  const yHit = a.y < b.y + b.h - 2 && b.y < a.y + a.h - 2;
  const xHit = a.x < b.x + b.w - 2 && b.x < a.x + a.w - 2;
  if (yHit && xHit) problems.push(`盒子重叠：${a.title} × ${b.title}`);
}
for (const b of boxes) if (b.x + b.w > 1416) problems.push(`越出内容右界：${b.title} 到 ${String(b.x + b.w)}`);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const OUT = argOf("--out") ?? path.resolve(HERE, "..", "docs", "architecture.svg");

// 先量后写（v1 原来把这两步反了：坏图会落盘之后才 exit 1）——与 v2 同一套纪律。
if (problems.length) {
  console.error(`图不合法（${problems.length} 项），未写任何文件：\n` + problems.join("\n"));
  process.exit(1);
}

if (process.argv.includes("--check")) {
  // 漂移门：仓库里那份必须与生成结果逐字节一致。图是生成物，就该像 apps:gen --check 一样可复算。
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf-8") : "";
  if (cur !== svg + "\n") {
    console.error(`图漂移：${OUT} 与生成结果不一致（改模块就要重跑本生成器）`);
    process.exit(1);
  }
  console.log(`图与生成结果一致：${OUT}`);
  process.exit(0);
}

fs.writeFileSync(OUT, svg + "\n");
console.log(`写出 ${OUT}`);

if (process.argv.includes("--png")) {
  const OUT_PNG = OUT.replace(/\.svg$/, ".png");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: W, height: 1120 }, deviceScaleFactor: 2 });
    await page.setContent(`<!doctype html><html><body style="margin:0;padding:0">${svg}</body></html>`);
    await page.screenshot({ path: OUT_PNG, clip: { x: 0, y: 0, width: W, height: 1120 } });
    console.log(`写出 ${OUT_PNG}（${W * 2}×${1120 * 2}）`);
  } finally {
    await browser.close();
  }
}
