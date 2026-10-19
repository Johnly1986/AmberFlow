/**
 * 系统架构总览生成器（`node tools/arch-diagram-system.mjs [--png] [--check] [--out <path>]`
 *   → `docs/architecture-system.svg`）。
 *
 * 与既有两图的分工（为什么不改它们）：
 *   - `architecture.svg`（v1）：数据流链——一条命令怎么穿过各层。
 *   - `architecture-target.svg`（v2）：执行层三段化的**目标**架构（命令/决策/数据槽）。
 *   - 本图：**系统全景 + 外部边界 + 信任链**——七层各是什么、系统与世界接壤在哪、
 *     每层的红线由什么撑着。补上 v1 画完后才落地的东西：决策提供者注册表
 *     （decision-provider）、`$AMBERFLOW_HOME/apps` 双根发现、模型出场的实测账、
 *     CLI 一行点名（cli-args）；NL Flow（docs/NL_FLOW_DESIGN.md）落地后新增：
 *     声明面 v3（nominate/instr/next/gives）、提名梯级与组合指令解释器、
 *     具名数据集生产面、元素动作的证据面强制、S0 实验台的 --check 门禁。
 *
 * 纪律与 v1/v2 相同：
 *   - 数字一律从单一出处 `docs/arch-metrics.json` 插值，不手抄（手抄的数会过期——
 *     §1 of ARCHITECTURE_IMPROVEMENTS 一次抓到 7 处）。
 *   - 每条文字行按 CJK≈1em / ASCII≈0.55em 估宽，出框、重叠、越右界 ⇒ **先检查后写、不落盘**。
 *   - `--check` 自洽门：仓库里那份必须与生成结果逐字节一致。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const W = 1560, PAD = 11;
const H = 1288;
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

// 单一出处：docs/arch-metrics.json。读不到/缺字段 ⇒ 记问题（不落坏图），不退回旧数字。
const HERE0 = path.dirname(fileURLToPath(import.meta.url));
let M = null;
try {
  M = JSON.parse(fs.readFileSync(path.resolve(HERE0, "..", "docs", "arch-metrics.json"), "utf-8"));
} catch {
  problems.push("计量缺失：docs/arch-metrics.json 读不到（跑 npm run metrics -- --tests N）");
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
  apps: mv((m) => m.corpus?.app_dirs, "corpus.app_dirs"),
  journeyApps: mv((m) => m.corpus?.packs_with_journey, "corpus.packs_with_journey"),
  entries: mv((m) => m.corpus?.journey_entries, "corpus.journey_entries"),
  browserSteps: mv((m) => m.corpus?.hint_coverage?.browser, "hint_coverage.browser"),
  hinted: mv((m) => m.corpus?.hint_coverage?.hinted, "hint_coverage.hinted"),
  named: mv((m) => m.corpus?.hint_coverage?.named, "hint_coverage.named"),
  hintPct: mv((m) => m.corpus?.hint_coverage?.pct, "hint_coverage.pct"),
  flowApps: mv((m) => m.corpus?.flow_apps, "corpus.flow_apps"),
  flowSteps: mv((m) => m.corpus?.flow_steps, "corpus.flow_steps"),
  toolSteps: mv((m) => m.corpus?.tool_steps, "corpus.tool_steps"),
  modelApps: mv((m) => m.model?.real_model_corpus?.stats?.apps, "model.real_model_corpus.stats.apps"),
  modelSteps: mv((m) => m.model?.real_model_corpus?.stats?.trace_steps, "model.real_model_corpus.stats.trace_steps"),
  modelAsks: mv((m) => m.model?.real_model_corpus?.stats?.choice_asks, "model.real_model_corpus.stats.choice_asks"),
  modelPassed: mv((m) => m.model?.real_model_corpus?.stats?.passed, "model.real_model_corpus.stats.passed"),
};

const boxes = [];
const check = (where, text, size, max) => { if (est(text, size) * 1.06 > max) problems.push(`${where}: ${Math.round(est(text,size)*1.06)} > ${Math.round(max)}  ${JSON.stringify(text)}`); };

const out = [];
const T = (x, y, s, cls, extra = "") => out.push(`<text x="${x}" y="${y}" class="${cls}"${extra}>${s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</text>`);
const R = (x, y, w, h, cls) => out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" class="${cls}"/>`);
const P = (d, cls = "ln", marker = true) => out.push(`<path class="${cls}" d="${d}"${marker ? ' marker-end="url(#arr)"' : ""}/>`);

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
const band = (y, h, label) => { R(40, y, 1170, h, "band"); T(58, y + 22, label, "lay"); };
const side = (y, h, label) => { R(1225, y, 295, h, "band side"); T(1243, y + 22, label, "lay"); };

/* ---------------- ① 入口层 ---------------- */
band(64, 150, "① 入口层 — 一条命令 / 一次工具调用（误输=一行点名，不甩堆栈：cli-args.ts）");
box(60, 96, 268, 52, "bx", "npm start · doctor", ["src/start.ts：开箱任务 / 演示一次归纳", "$doctor 缺件点名 + 一条补齐命令"]);
box(338, 96, 268, 52, "bx", "npm run apps · semantic", ["app-runner / semantic-flow", "整跑一条链 / 模板跨站迁移"]);
box(616, 96, 292, 52, "bx", "learn · agent · plan:flow", ["tools/learn.ts / src/plan-flow.ts", "演示一次或一句话 → 包/模板，门槛见 ③"]);
box(918, 96, 272, 52, "bx", "plan-cli · datasource · bench", ["手写计划；站点=配置；跑分矩阵", "$探针 live-*：URL 全在 pack 声明"]);
box(60, 158, 546, 44, "bxp", "DSH 插件（integrations/dsh-bridge）：amberflow_apps / run / learn", ["桥起 CLI 子进程、读 *-result.json 归纳 summary；引擎对 DSH 零引用"]);
box(616, 158, 292, 44, "bxm", "npm run model:fetch（产物通道）", [".part 先落 · SHA256 先验后换 · 半途态整组撤回"]);
box(918, 158, 272, 44, "bxe", "度量与门禁（一条命令可复现）", ["matrix/suite/gen/probes/nominate --check", "$提名实验台：冻结产物复算不一致即红"]);
T(58, 224, "入口只编排：所有浏览器动作都汇入同一个执行循环（⑤），没有第二个分支", "lbl");

/* ---------------- ② 声明层 ---------------- */
band(236, 118, `② 声明层 — 应用是目录与数据，不是代码（${N.apps} 个目录，代码行数实测 0）`);
box(60, 268, 380, 76, "bxd", "apps/<id>/pack.json（spec_version 1）", ["roles · journey（浏览器步+工具步混排）· slots", "invariants · hosts · device · probe · policy", "$加载期校验与计划同一套语法（PlanningRules）"]);
box(450, 268, 380, 76, "bxd", "flow.json + sites/*.profile.json（v2/v3）", [`${N.flowApps} 份模板 / ${N.flowSteps} 步：页面角色 + 语义目标 + 契约信号`, "v3 声明面：nominate / instr / next / gives", "$学到的 hint 与指令映射都过重放门；drift 撤下重学"]);
box(840, 268, 350, 76, "bxd", "transfer/specs/*.json + sources/*.json", ["phase × repeat（once/per_date/per_checkin）", "数据腿：curl / fetch / cli(argv，无 shell)", "$「引擎不认识站点」是单测"]);
T(58, 348, "落盘与发现（本轮实测修的缝）：pack 与 flow 同一双根纪律——扫 [用户目录, 仓库 apps/]，同 id 用户赢", "lbl");

/* ---------------- ③ 编译/录制层 ---------------- */
band(360, 108, "③ 编译与录制层 — 三类入口，一道门：零模型重放不过 ⇒ 不落盘");
box(60, 392, 276, 60, "bx", "apps:gen（tools/spec-to-pack.ts）", ["spec/代码里的计划 → 整包；FROZEN_TODAY 钉周", "$--check 进 CI：改 spec 忘重生成就红"]);
box(346, 392, 276, 60, "bx", "learn（演示一次）", ["动作拾取按稳定句柄；信号/不变量从真转换归纳", "$不变量取自回放形状，不是演示会话"]);
box(632, 392, 276, 60, "bx", "plan:flow（一句话+种子页）", ["逐步看页面→真执行→两次独立演示归纳判据", "$dangerous 由 goal 自动标注；plan 不写 hint"]);
box(918, 392, 272, 60, "bx", "apps:induce · induce_signals", ["跑通一次 → 候选过判别/稳定句柄/复现三关", "$选不出来 = manual：如实停，不放宽成\"看着像\""]);

/* ---------------- ④ 计划层 ---------------- */
band(478, 96, "④ 计划层 — 冻结的有序子目标");
box(60, 510, 350, 52, "bx", "src/plan.ts — TaskPlan / PlanningRules", ["子目标+完成信号+数据袋；checkpoint 续跑、保留 hint"]);
box(420, 510, 330, 52, "bx", "src/planner.ts — runPlan / 重试", ["when 跳过 · retries 整步重跑 · replan 异常必打印"]);
box(760, 510, 220, 52, "bx", "src/signals.ts — 信号语言", ["5 个 DOM 算子 + all_of/any_of/not", "$完成与适用同一实现"]);
box(990, 510, 200, 52, "bx", "LLM 规划/审计（可选）", ["OPENAI_* 齐则启用；", "否则内置替身，流程照常"]);

/* ---------------- ⑤ 执行层 ---------------- */
band(584, 268, "⑤ 执行层 — 唯一生产循环 BrowserMiddleware.run（永不分叉）");
const chain = [
  ["元素池", ["extraction.ts", "一次 JS pass", "iframe+shadow", "非零盒判可见"]],
  ["规则先行", ["rules.ts", "tiered hint 单实现", "档内歧义才问模型", "$authored 恒赢已学"]],
  ["闭集内选", ["决策层 ⑥ 出场", "confidence 闸门", "失手→加宽重看", "→升级老师（只点名）"]],
  ["闸门与动作", ["风险=关键词或投票", "dangerous 先干跑取证", "hosts 导航信封", "password/secret 掩码"]],
  ["完成判定", ["DOM/URL 信号唯一真值", "inert → 禁；反复无效 →", "no_progress（按签名数）"]],
];
const cw = 214, gap = 8, x0 = 60;
chain.forEach(([t, ls], i) => {
  const cls = ["闭集内选"].includes(t) ? "bxm" : ["完成判定"].includes(t) ? "bxe" : "bx";
  box(x0 + i * (cw + gap), 616, cw, 88, cls, t, ls, { titleSize: 12, titleDy: 17 });
  if (i) P(`M${x0 + i * (cw + gap) - gap},660 H${x0 + i * (cw + gap)}`);
});
box(60, 714, 372, 52, "bx", "三面同词汇：DOM 面 / 工具面 / 数据面", ["tool-signals：exit/stdout/json_path/file_* 等", "$retries 需 idempotent；dangerous 先干跑再点头"]);
box(442, 714, 372, 52, "bxnew", "命令闭集 + 具名绑定（P2/P3 已接线）", ["click|check|fill|select|skip；值只按 slot 具名绑定", "$list 绑定 = datasource.selectIndex 同一实现"]);
box(824, 714, 386, 52, "bxe", "运行结果 = 可核对的证据", ["<app>-result.json（model_status、决策账）+ <app>-report.md", "$suite/matrix/桥 读的是同一份产物"]);
// NL Flow：晚绑定三件（S2/S3）——指令在运行期提名，数据在信号之后具名流转
box(60, 778, 372, 56, "bxnew", "提名梯级 S2 — nominate.ts + 指令注册表", ["②档案 → ①规则 → ③窄问 → ④老师 → ⑤枚举，命中即停", "$闭集外答案 = 弃权（fail closed）；instr 锁跳过梯级"]);
box(442, 778, 372, 56, "bxnew", "组合指令解释器 + 数据集生产面（S3）", ["list_pick 声明 compose：extract→select→act，参数全是声明", "$gives → 信号成立后 dataset.write；重放门前先失效"]);
box(824, 778, 386, 56, "bxnew", "证据面强制与两本账（S3/S4）", ["提名与 trace 动作族不符 ⇒ instruction_not_honored（blocked）", "$dataset_view / nominate_bill：生产与账每跑可见"]);

/* ---------------- ⑥ 决策层 ---------------- */
band(862, 152, `⑥ 决策层 — 可插拔提供者与它的账（实测咨询 ${N.modelAsks}/${N.modelSteps} 步、独立决定 ${N.modelPassed}）`);
box(60, 894, 470, 62, "bxm", "决策提供者注册表（decision-provider.ts）", ["laya-onnx | stub | none | jevk5 | bailian | token-plan | 自注册", "$基线对照：first-candidate 是新模型要赢的线（providers:baseline）"]);
box(540, 894, 306, 62, "bxm", "laya-onnx.ts + Router", ["buildSequence · shortlist · 按文字系统选点", "$置信度从不参与换 checkpoint（ECE 0.855 的教训）"]);
box(856, 894, 354, 62, "bxm", "decision-cache.ts + countingRuntime", ["精确指纹：同问不重答（二跑 0 forwards 实测）", "$过关数在 trace 数 · 咨询数在运行时缝数，差值=未过闸"]);
box(60, 964, 262, 42, "bxm", "学习库：hint 与指令映射", ["过重放门才回填；authored 优先；读-合并-写"]);
box(332, 964, 262, 42, "bxm", "outcome-memory（opt-in）", ["按元素签名记\"点了没变化\"，可禁可标注"]);
box(604, 964, 320, 42, "bxm", "风险头 + 注入守卫（实测阈值，不是默认值）", ["关键词∨模型投票≥0.6 → 要确认；注入 0.95 分离度实测"]);
box(934, 964, 290, 42, "bxm", "model-artifacts.ts 单一口径", ["三件齐才算 on；缺了如实走规则模式"]);

/* ---------------- ⑦ 验收层 ---------------- */
band(1024, 108, "⑦ 验收层 — 结论必须能被命令复现（跳过 ≠ 通过）");
box(60, 1056, 276, 60, "bxe", "npm run verify", [`typecheck + ${N.tests} 条测试 + 六层对拍`]);
box(346, 1056, 276, 60, "bxe", "bench/smoke.sh（CI 的绿色唯一定义）", ["离线无条件；模型侧缺产物打 SKIP 并跳过"]);
box(632, 1056, 284, 60, "bxe", "apps:suite + apps:matrix", ["分层退出码 0/1/2/3；泄漏 0 · 应用代码 0 行"]);
box(926, 1056, 284, 60, "bxe", "metrics 单一出处 + 两图 --check", ["能算的算出来；快照段标 generated_at 与命令"]);

/* ---------------- 右栏：外部边界 ---------------- */
side(64, 1068, "与世界接壤（系统的边界在哪、缺了什么会怎样）");
box(1243, 96, 259, 64, "bx", "chromium（Playwright 解析）", ["PLAYWRIGHT_BROWSERS_PATH 或托管版", "$缺 → doctor 直接给那条安装命令"]);
box(1243, 172, 259, 76, "bx", "laya 模型产物（1.7GB 级，不进 git）", ["HF 快照发现 / LAYA_ONNX_MODEL 约定", "$缺产物走规则模式；要模型的步骤如实 block"]);
box(1243, 260, 259, 64, "bx", "真实站点（线上应用与探针才碰）", ["携程 H5 走 HTTP 门（浏览器门被拦）", "$移动页要声明 device；CI 不依赖网络"]);
box(1243, 336, 259, 52, "bx", "DSH 宿主（插件形态才出现）", ["三个工具走 CLI 子进程；桥不依赖宿主也能测"]);
box(1243, 400, 259, 52, "bx", "LLM 端点（可选，OPENAI_*）", ["规划/审计/升级老师；缺 → 内置替身，流程照常"]);
box(1243, 464, 259, 64, "bx", "命令行工具（git/jq/桩）", ["argv 数组 + env 白名单；永不见 shell", "$工具缺 → refused: tool-unavailable"]);
box(1243, 540, 259, 64, "bx", "用户正在开的浏览器（--cdp 挂载）", ["learn 连上去录；退出只断开不关浏览器", "$挂载模式也认 --url：不给停 about:blank"]);
box(1243, 616, 259, 64, "bx", "用户作用域目录 $AMBERFLOW_HOME", ["learn/plan:flow 的新产物默认落这里", "$双根发现、同 id 用户赢；生包响亮拒绝"]);
box(1243, 692, 259, 52, "bx", "冻结语料与钉住的日期", ["对拍对的是入库记录；FROZEN_TODAY 钉周"]);
box(1243, 756, 259, 64, "bx", "实测证据（2026-10-14 开箱测试轮）", [`${N.modelApps} 个真跑应用 / ${N.modelSteps} 步 trace（真模型臂）`, "$live 8 站与长流程 3 站属线上口径，见 bench/"]);
// 边界连线（虚线）
out.push(`<path class="lnb" d="M1230,128 H1243" marker-end="url(#arrB)"/>`);
out.push(`<path class="lnb" d="M1230,200 H1243" marker-end="url(#arrB)"/>`);
out.push(`<path class="lnb" d="M1230,292 H1243" marker-end="url(#arrB)"/>`);
out.push(`<path class="lnb" d="M1230,926 H1237 V172 H1243" marker-end="url(#arrB)"/>`);
T(1243, 914, "⑥ 的模型经缝上接产物；入口层接 DSH 宿主与浏览器", "lbl");

/* ---------------- 层间主干箭头 ---------------- */
P("M620,214 V264"); T(632, 242, "发现包/模板（双根，用户赢）", "lbl");
P("M620,354 V388"); T(632, 376, "编译/录制的产物 = 声明", "lbl");
P("M620,452 V506"); T(632, 484, "展开 → 冻结计划", "lbl");
P("M620,562 V612"); T(632, 590, "子目标 + 完成信号 + slots", "lbl");
P("M620,704 V712");

/* ---------------- 底部：红线 + 开箱承诺 ---------------- */
R(40, 1142, W - 80, 96, "band red");
T(58, 1166, "四条红线（每条都有测试与门禁撑着，不是口号）", "foot", ' font-weight="700"');
T(58, 1186, "① 不重规划——计划结构冻结在开始；运行期只允许闭集内提名与过门回填；② 不发明取值——填的值只来自数据袋（slots/具名绑定，模型无权产生值）；③ 不信模型说\"完成\"——只认该步 DOM/URL 信号；④ 不可复现即拒存——零模型重放门不过一个文件都不落，危险步先干跑取证再点头。", "foot");
T(58, 1206, `实测口径（单一出处 docs/arch-metrics.json，generated_at ${M?.generated_at ?? "?"}）：浏览器步 ${N.named}/${N.browserSteps} 全由声明解决（${N.hinted} 用 hint 点名 = ${N.hintPct}%，其余 ${Number(N.named) - Number(N.hinted)} 步走命令闭集）；真模型臂 ${N.modelApps} 应用 ${N.modelSteps} 步里咨询 ${N.modelAsks}、独立决定 ${N.modelPassed}——兜底与诊断，不是承重件。`, "foot");
T(58, 1228, "开箱：`npm ci && npx playwright install chromium && npm start` 两条命令见结果；无权重走规则模式（缺件点名+补齐命令）；`npm start -- --goal … --url …` 演示一次即归纳；`plan:flow` 一句话即编译。", "foot");

/* ---------------- 重叠与越界检查 ---------------- */
for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
  const a = boxes[i], b = boxes[j];
  const yHit = a.y < b.y + b.h - 2 && b.y < a.y + a.h - 2;
  const xHit = a.x < b.x + b.w - 2 && b.x < a.x + a.w - 2;
  if (yHit && xHit) problems.push(`盒子重叠：${a.title} × ${b.title} @ ${a.x},${a.y},${a.w}×${a.h} / ${b.x},${b.y},${b.w}×${b.h}`);
}
for (const b of boxes) if (b.x + b.w > W - 40) problems.push(`越出内容右界：${b.title} 到 ${String(b.x + b.w)}`);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'PingFang SC','Microsoft YaHei','Noto Sans CJK SC','Source Han Sans CN','Helvetica Neue',Arial,sans-serif">
<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#4a5568"/></marker>
<marker id="arrB" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#2b6cb0"/></marker>
<style>
.band{fill:#f7f8fa;stroke:#d7dce3;stroke-width:1}
.side{fill:#fbfcfe;stroke-dasharray:6 4}
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argOf = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = argOf("--out") ?? path.resolve(HERE, "..", "docs", "architecture-system.svg");

if (problems.length) {
  console.error(`图不合法（${problems.length} 项），未写任何文件：\n` + problems.join("\n"));
  process.exit(1);
}
if (process.argv.includes("--check")) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf-8") : "";
  if (cur !== svg + "\n") { console.error(`图漂移：${OUT} 与生成结果不一致（改生成器就要重跑）`); process.exit(1); }
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
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
    await page.setContent(`<!doctype html><html><body style="margin:0;padding:0">${svg}</body></html>`);
    await page.screenshot({ path: OUT_PNG, clip: { x: 0, y: 0, width: W, height: H } });
    console.log(`写出 ${OUT_PNG}（${W * 2}×${H * 2}）`);
  } finally { await browser.close(); }
}
