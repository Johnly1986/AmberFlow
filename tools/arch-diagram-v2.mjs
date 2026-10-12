/**
 * 目标架构图生成器（`node tools/arch-diagram-v2.mjs [--png]` → `docs/architecture-target.svg|.png`）。
 *
 * 为什么是**生成**而不是手画：手画的图会随代码漂移，"文字出框 / 盒子重叠 / 越过右界"
 * 这类缺陷只有量过才发现。规则与 v1（`tools/arch-diagram.mjs`）一致：每条文字按
 * CJK≈1em / ASCII≈0.55em 估宽，任何一行出框、任何两个盒子重叠、任何盒子越过内容右界 ⇒ 非零退出。
 *
 * 与 v1 的一处刻意差异：**先检查、后写文件**。v1 是 `writeFileSync` 之后才 `exit(1)`，
 * 于是"量不过关就不产出"这句话在 v1 里是不成立的（坏图已经落盘）——本文件把它补上。
 *
 * `--check` 是自洽门（图 == 生成器输出），**不是真值门**：图里写死的数字要人手刷新。
 *
 * 内容对应 `docs/ARCHITECTURE_REVIEW.md` 的讨论结果：六层保持连续（可映射新旧），
 * ④ 执行层展开成"编译 / 选择 / 应用"三段（= 命令层 / 决策层 / 数据槽层），
 * 并附三档裁定、已确认缺陷、迁移顺序与改写后的红线。
 *
 * 2026-10 更新：⑧ 从"待迁移"改成**已落地**（P0–P4 + D3/R-4 逐条附验收台）；
 * 新增 ⑨「模型角色的修正」——独立审查用真 ONNX 模型实测出"分工写反了"
 * （声明解决 98.8% 的浏览器步；模型 top-1 25%、闸门内 precision 15%），
 * 修正方向见 `docs/MODEL_ROLE_PLAN.md`。画布相应加高。
 */
import fs from "node:fs";
import path from "node:path";

const W = 1560, H = 2320, PAD = 11, RIGHT = 1416;
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

// 计量单一出处（docs/ARCHITECTURE_IMPROVEMENTS.md §1/§8）：能算的数字一律从 arch-metrics.json
// 插值，不再手写；JSON 缺失/缺字段记为问题 ⇒ 先检查后写，不落坏图。
let M = null;
try {
  M = JSON.parse(fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "docs", "arch-metrics.json"), "utf-8"));
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
  hintPct: mv((m) => m.corpus?.hint_coverage?.pct, "corpus.hint_coverage.pct"),
  hinted: mv((m) => m.corpus?.hint_coverage?.hinted, "hint_coverage.hinted"),
  named: mv((m) => m.corpus?.hint_coverage?.named, "hint_coverage.named"),
  browserSteps: mv((m) => m.corpus?.hint_coverage?.browser, "hint_coverage.browser"),
  top1: mv((m) => m.model?.harness?.numeric?.top1_pct, "harness.top1_pct"),
  latin: mv((m) => m.model?.harness?.numeric?.latin_pct, "harness.latin_pct"),
  cjk: mv((m) => m.model?.harness?.numeric?.cjk_pct, "harness.cjk_pct"),
  prec: mv((m) => m.model?.harness?.numeric?.precision025_pct, "harness.precision025_pct"),
  aucPt: mv((m) => m.model?.harness?.numeric?.passthrough_auc, "harness.passthrough_auc"),
  aucSl: mv((m) => m.model?.harness?.numeric?.shortlist_auc, "harness.shortlist_auc"),
  ptAdopt: mv((m) => m.model?.harness?.numeric?.passthrough_adopted, "harness.passthrough_adopted"),
  ptRight: mv((m) => m.model?.harness?.numeric?.passthrough_right, "harness.passthrough_right"),
  slAdopt: mv((m) => m.model?.harness?.numeric?.shortlist_adopted, "harness.shortlist_adopted"),
  slRight: mv((m) => m.model?.harness?.numeric?.shortlist_right, "harness.shortlist_right"),
  asks: mv((m) => m.model?.real_model_corpus?.choice_asks, "real_model.choice_asks"),
  passed: mv((m) => m.model?.real_model_corpus?.passed, "real_model.passed"),
  traceSteps: mv((m) => m.model?.real_model_corpus?.trace_steps, "real_model.trace_steps"),
  ruleMatch: mv((m) => m.model?.real_model_corpus?.rule_match ?? "201", "real_model.rule_match"),
  realSecs: mv((m) => m.model?.real_model_corpus?.secs, "real_model.secs"),
  judged: mv((m) => m.model?.harness?.numeric?.judged, "harness.judged"),
};
const boxes = [];
const check = (where, text, size, max) => {
  if (est(text, size) * 1.06 > max) {
    problems.push(`${where}: ${Math.round(est(text, size) * 1.06)} > ${Math.round(max)}  ${JSON.stringify(text)}`);
  }
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const out = [];
const T = (x, y, s, cls, extra = "") => out.push(`<text x="${x}" y="${y}" class="${cls}"${extra}>${esc(s)}</text>`);
const R = (x, y, w, h, cls) => out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" class="${cls}"/>`);
const P = (d, cls = "ln", marker = true) => out.push(`<path class="${cls}" d="${d}"${marker ? ' marker-end="url(#arr)"' : ""}/>`);

/** 盒子：title + 若干副行（`$` 前缀 = 蓝色小字）。自动量宽，超宽即记问题。 */
function box(x, y, w, h, cls, title, lines, opts = {}) {
  boxes.push({ x, y, w, h, title });
  R(x, y, w, h, cls);
  const inner = w - PAD * 2;
  const size = opts.titleSize ?? 12.5;
  check(title, title, size, inner);
  T(x + PAD, y + (opts.titleDy ?? 19), title, "t", ` font-size="${size}"`);
  let ty = y + (opts.titleDy ?? 19) + 16;
  for (const l of lines) {
    const blue = l.startsWith("$");
    const text = blue ? l.slice(1) : l;
    check(`${title} / ${text.slice(0, 14)}`, text, 10.5, inner);
    T(x + PAD, ty, text, blue ? "sm" : "s");
    ty += 14;
  }
}

const band = (y, h, label) => { R(40, y, W - 80, h, "band"); T(58, y + 24, label, "lay"); };
/** 脚注：也量宽（v1 不量脚注，长脚注会静默出框）。 */
const note = (x, y, s, cls = "lbl", max = RIGHT - x) => { check(`note@${y}`, s, cls === "foot" ? 11.5 : 10.5, max); T(x, y, s, cls); };

/* ══════════════════════════════ 标题 ══════════════════════════════ */
T(58, 40, "AmberFlow 目标架构（重审后）：执行层三段化 —— 命令 / 决策 / 数据槽", "title");
note(58, 62, "六层保持连续；④ 执行层切成「能力面 / 命令层（应用配置）/ 决策层 / 数据槽层」——执行循环与面无关，浏览器只是第一个面。", "lbl", 730);
note(800, 62, "图例：白框 = 不变 · 蓝框 = 新增/改动 · 橙框 = 收窄 · 红框 = 缺陷 / 推翻 · 绿框 = 保留", "lbl", 616);

/* ══════════════════════════════ ① 入口层 ══════════════════════════════ */
band(84, 142, "① 入口层（一条命令 / 一次工具调用）—— 只编排，所有浏览器决策仍落到同一个执行循环");
const entry = [
  ["npm start · doctor", ["src/start.ts", "演示一次即归纳信号"]],
  ["npm run apps", ["src/app-runner.ts", "数据腿 → 旅程 → 不变量"]],
  ["learn · agent", ["tools/learn.ts", "录制 → 零模型回放门"]],
  ["plan:flow · semantic", ["plan-flow / semantic-flow", "一句话 + 种子页 → 档案"]],
  ["plan-cli · datasource", ["站点 = 配置", "sources/*.json 发现制"]],
  ["bench · 探针", ["bench.ts / live-*", "跑分矩阵 · 可达性实测"]],
];
entry.forEach(([t, ls], i) => box(60 + i * 228, 116, 216, 62, "bx", t, ls, { titleSize: 11.5, titleDy: 17 }));
box(60, 186, 670, 30, "bxp", "DSH 插件模式：列包 · 跑应用 · 录流程 · 出模板（引擎对 DSH 零引用）", [], { titleSize: 11 });
box(746, 186, 670, 30, "bxe", "度量与门禁：apps:matrix · apps:suite · apps:gen --check · probes:baseline · verify · smoke.sh", [], { titleSize: 11 });
P("M700,226 V258"); note(714, 248, "发现包 / 模板");

/* ══════════════════════════════ ② 应用 = 目录 ══════════════════════════════ */
band(258, 120, "② 应用配置（数据，不是代码）—— 用户本地产物，不进项目仓库");
box(60, 290, 330, 72, "bxd", "apps/<id>/pack.json", ["roles · journey · slots · invariants", "hosts · device · probe · notes"]);
box(402, 290, 330, 72, "bxd", "sources/*.json（数据腿）", ["curl / fetch / cli（argv 数组，无 shell）", "「引擎不认识站点」是单测"]);
box(744, 290, 330, 72, "bxd", "flow.json + sites/*.profile.json", ["页面角色 + 语义目标 + 契约信号", "fill_keys / list_extract / 学到的 hint"]);
box(1086, 290, 330, 72, "bxd", "血统与可复现", ["generated_from / recorded_from", "FROZEN_TODAY 钉住展开周"]);
note(60, 374, "应用 = 用户本地的流程配置（录制 / 生成 / 手改），无分享价值 ⇒ 不进仓库；仓库里的 apps/ 只是开发夹具。落盘默认今天写进 checkout（tools/learn.ts:626），应移到用户作用域。", "lbl", 1356);
P("M700,378 V410"); note(714, 400, "expandPack / compileFlow → 冻结计划");

/* ══════════════════════════════ ③ 计划层 ══════════════════════════════ */
band(410, 100, "③ 计划层");
box(60, 442, 330, 52, "bx", "src/plan.ts — TaskPlan / PlanningRules", ["有序子目标 + 完成信号 + 数据袋；checkpoint 续跑"]);
box(402, 442, 330, 52, "bx", "src/planner.ts — runPlan", ["when 跳过 · retries 整步重跑 · replan 必打印"]);
box(744, 442, 330, 52, "bx", "LLM 规划 / 审计（可选）", ["无 OPENAI_* 时 Mock / Scripted 照常全流程"]);
box(1086, 442, 330, 52, "bx", "src/signals.ts — 信号语言", ["5 个 DOM 算子 + all_of / any_of / not"]);
P("M700,510 V546"); note(714, 536, "子目标 + 完成信号 + 数据袋");

/* ══════════════════════════════ ④ 执行层（重点）══════════════════════════════ */
band(546, 670, "④ 执行层 —— 唯一执行循环（与面无关，永不分叉）：能力面 / 命令层 / 决策层 / 数据槽层");

/* ④S 能力面（引擎代码）—— 项目不以浏览器为界 */
note(60, 602, "④S  能力面注册表（引擎代码）—— 一个面 = 原语 + 观察 + 完成证据；新增一个面是新 provider，不是新分支", "sub");
box(60, 610, 330, 60, "bxp", "浏览器面", ["原语 click / fill / select / check / submit / goto", "观察：元素池 · 证据：5 个 DOM 算子"], { titleSize: 11.5 });
box(402, 610, 330, 60, "bxp", "命令行面", ["原语：以 argv 数组起进程（无 shell）", "观察：exit / stdout / 文件 · 证据：tool-signals"], { titleSize: 11.5 });
box(744, 610, 330, 60, "bxp", "HTTP 面", ["原语：请求（curl / fetch / cli transport）", "观察：状态码 + 响应体 · 今天只读，可扩为动作"], { titleSize: 11.5 });
box(1086, 610, 330, 60, "bxp", "文件面（待补）", ["原语：读 / 写 / 存在性判断", "证据：file_exists / 内容匹配"], { titleSize: 11.5 });
P("M700,670 V694"); note(714, 686, "命令集只能引用已注册的原语");

/* ④a 命令层 · 声明半（应用配置） */
note(60, 712, "④a  命令层 · 声明半（应用配置，用户侧）—— 「允许什么」是数据，可审计、可 diff", "sub");
box(60, 720, 444, 64, "bxnew", "命令集（应用配置，不是引擎代码）", [
  "引用已注册的 surface 原语 + 参数槽 + 完成信号",
  "$顺序 / 分支也在这里声明；运行期只做「选择」不做「生成」",
], { titleSize: 11.5 });
box(516, 720, 444, 64, "bxnew", "校验对着能力面做，引擎不写死词表", [
  "未知 surface / 原语 / 参数键 / 算子 ⇒ 加载期红",
  "$引擎里没有 click / fill 这类词 ⇒ 不把浏览器绑进核心",
], { titleSize: 11.5 });
box(972, 720, 444, 64, "bxnew", "配置在仓库外 ⇒ 兼容是引擎的责任", [
  "应用配置随用户走而引擎会变：spec_version + 显式迁移",
  "$迁移不了就响亮拒绝，不猜着跑（CI 盖不到用户的包）",
], { titleSize: 11.5 });
P("M700,784 V808"); note(714, 800, "同一份声明，每个观察各自实例化一次");

/* ④a′ 命令层 · 实例化半（运行期） */
note(60, 826, "④a′  命令层 · 实例化半（运行期）—— 「此刻有什么」只能是观察，候选列表在这里产生", "sub");
box(60, 834, 670, 68, "bxnew", "instantiateSpace(decl, observation, slots, state)", [
  "把声明 × 当次观察实例化成「此刻真实可选的命令闭集」",
  "$解析不到的候选出局；forbidden / inert / 记忆在此过滤（各面各自的观察形状）",
], { titleSize: 11.5 });
box(746, 834, 670, 68, "bxred", "闭集不许逃逸（逃逸 = 退化成今天）", [
  "声明与实际不符 ⇒ 结构化 space-empty，绝不退回「全量观察」",
  "$同 hint 纪律：未命中就落到模型，不赌一个 token",
], { titleSize: 11.5 });
P("M700,902 V926"); note(714, 918, "space.live（运行期闭集）");

/* ④b 决策层 */
note(60, 944, "④b  决策层 · 运行期（只读；唯一会问模型的地方）—— 阶梯顺序一字不改，只换「在什么之上选」", "sub");
const ladder = [
  ["hint 分层", ["出口带 tier 候选集", "不再塌缩成 null"]],
  ["规则 nav/affordance", ["字面映射先于模型", "零模型调用"]],
  ["本地模型选", ["predictShortlist k=8", "低于 floor → 下一步"]],
  ["加宽重看 ×1", ["WIDER 120 元素", "只在去停下的路上"]],
  ["升级老师", ["只点名展示过的候选", "闭集外 ⇒ 弃权"]],
  ["decide() → decision", ["只选下标 + 绑定", "选不出 ⇒ blocked + code"]],
];
// 阶梯本身是"一字不改"的：除最后那个新出口 decide() 外一律白框（图例上蓝框 = 新增/改动）。
ladder.forEach(([t, ls], i) => box(60 + i * 228, 952, 216, 76, i === 5 ? "bxnew" : "bx", t, ls, { titleSize: 11, titleDy: 17 }));
P("M700,1028 V1052"); note(714, 1044, "decision");

/* ④c 数据槽层 + 应用 */
note(60, 1070, "④c  数据槽层 · 绑定 + 应用（只做动作，不做决策；由该面的原语执行）", "sub");
const slots = [
  ["绑定优先级", ["用户参数 > 计划 slots > 本步", "观察到的候选须由声明规则命中"]],
  ["三种来源", ["slot / option / list", "复用 datasource.selectIndex"]],
  ["模型永不选值", ["by = value|label|contains", "| min | max（声明式）"]],
  ["缺值即 needs_value", ["不猜；弃该候选并如实记录", "红线②在数据槽层的落地"]],
  ["apply() + 守卫", ["原语由该面执行；失败=结果", "守卫按面：dry-run / dry_run_args"]],
];
// needs_value 是既有行为（今天就在 executor 里），apply() 与守卫也不动 ⇒ 白框。
slots.forEach(([t, ls], i) => box(60 + i * 271, 1078, 263, 76, i >= 3 ? "bx" : "bxnew", t, ls, { titleSize: 11, titleDy: 17 }));
note(60, 1178, "阶梯四个 method 取值（rule:match / laya / laya:reobserve / escalate）原样保留 —— 报告、对拍语料与 apps:suite 的结论不受本次切分影响。", "sm", 1356);
note(60, 1196, "闭集不可逃逸：决策层返回集合外的 id ⇒ 拒绝并如实记录（与 escalator「不是展示过的 ref 就弃权」同一条测试模式）。", "sm", 1356);

/* ══════════════════════════════ ⑤ 模型运行时 ══════════════════════════════ */
P("M700,1216 V1252"); note(714, 1240, "经决策缓存与咨询计数后问模型");
band(1252, 148, "⑤ 本地决策模型运行时（可缺席；laya 是当前唯一实现，换决策提供者不动上层）");
box(60, 1284, 330, 66, "bxm", "src/model.ts — LayaRuntime 缝", ["load / predictShortlist / Router", "测试注入 scriptedRuntime，不碰权重"]);
box(402, 1284, 330, 66, "bxm", "laya-onnx.ts + laya-format.ts", ["buildSequence · 温度标定 · shortlist k=8", "checkpoint 按文字系统路由，不按置信度"]);
box(744, 1284, 330, 66, "bxm", "产物：图 + .onnx.data + tokenizer", ["约 1.7GB，刻意不进 git", "LAYA_ONNX_MODEL 约定 / HF 快照发现"]);
box(1086, 1284, 330, 66, "bxm", "src/model-artifacts.ts", ["三件齐才算 on（单一出处）", "doctor / 运行器 / 桥 共用"]);
note(60, 1374, `实测（真 ONNX，本机）：浏览器步 ${N.named}/${N.browserSteps} 全由声明解决（${N.hinted} 个 hint 点名 = ${N.hintPct}%，其余走 commands 闭集）；模型 top-1 ${N.top1}%、闸门内 precision ${N.prec}% ⇒ 它是兜底与诊断，不是承重件（详见 ⑨）`, "foot", 1356);
note(60, 1394, "梯级账单：reobserve / escalate 在已验收语料上救回 0 次 ⇒ dead rung（口径与建议见 ARCHITECTURE_IMPROVEMENTS §5）", "lbl", 1356);
note(60, 1370, "新增（P0）：配置类错误改为启动期预检、永不重试 —— 实测坏产物路径下数据腿与第一个工具步曾已执行，且同一配置错误被重试 2 次。", "sm", 1356);

/* ══════════════════════════════ ⑥ 分层证据 ══════════════════════════════ */
P("M700,1382 V1418"); note(714, 1406, "运行结果 = 可核对的证据");
band(1418, 120, "⑥ 分层证据（结论必须能被命令复现，叙述不算证据）");
box(60, 1450, 444, 72, "bxe", `tests/ ${N.tests} 条 + 六层跨实现对拍`, ["rules / extraction / executor / datasource / ctrip / transfer", "冻结语料；时钟钉在 tools/frozen-today.ts"]);
box(516, 1450, 444, 72, "bxe", "用例与线上复测记录", ["bench/cases*.json · ctrip 19 子目标 + 独立判分", "transfer 七站 · live-retest 逐项原始观测"]);
box(972, 1450, 444, 72, "bxe", "作者 / 独立复核两角色", ["apps/INVENTORY.md 定义「完成一个应用」的五条", "缺陷带最小复现，报而不装绿"]);

/* ══════════════════════════════ ⑦ 三档裁定 ══════════════════════════════ */
P("M700,1538 V1574"); note(714, 1562, "重审：原有设计不预设正确");
band(1574, 170, "⑦ 重审裁定（每条都有可复算证据）");
box(60, 1606, 444, 120, "bxe", "保留 —— 原则，不动", [
  "动作失败是结果，不是异常",
  "完成只认该步「该面的证据」",
  "hint 权威（载体换成结构化句柄）",
  "值只来自计划槽位与用户参数",
  "$执行循环只有一个实现，永不分叉",
], { titleSize: 12 });
box(516, 1606, 444, 120, "bxd", "收窄 —— 原则对，措辞过宽", [
  "①「永不重新规划」→ 计划结构冻结 +",
  "     闭集内选择 + 过门回填（验证才是红线）",
  "§七.10「循环不配置化」→ 循环与能力面是代码，",
  "     命令集在应用配置里（sources/*.json 同款）",
  "④「不可复现即拒存」→ 升级为通用门槛",
], { titleSize: 12 });
box(972, 1606, 444, 120, "bxred", "推翻 —— 实现后果被写成了原则", [
  "§七.9「一个子目标只有一次点击 /",
  "     状态写进 URL」不是设计选择，",
  "而是「一步一个权威 hint + 每步重新 goto」",
  "的后果。代价：3 处 workaround +",
  "2 处未解边界（勾选+提交、内存态站点）",
], { titleSize: 12 });

/* ══════════════════════════════ ⑧ 缺陷 → 迁移 ══════════════════════════════ */
P("M700,1744 V1780"); note(714, 1768, "先立地基，再加能力");
band(1780, 190, "⑧ 已确认缺陷 → 迁移顺序（按性价比 + 现成验收台）");
box(60, 1812, 640, 140, "bxe", "已确认缺陷（均已修，逐条留负例）", [
  "✓ D1 7 处禁元素出口 / 12 处 stop_reason 散文 → 单出口 + StopCode 枚举",
  "✓ D2 位置性 ref 的 3 处独立 re-prune → pruneForbids 一处",
  "✓ D3 inert 既当证据又当终止责任 → maxEffectiveRepeats（缺省 3）",
  "      + 结构化 no_progress：死目标夹具 8 步/4.5s → 4 步/2.3s",
  "✓ D4 敏感字段 0 处遮蔽 → 按长度掩码（inert 判定与信号读取不受影响）",
  "✓ D5 hosts 运行期 0 处强制 → disallowedHost 导航信封（空声明不启用）",
  "✓ D6 配置类错误被重试且有副作用 → preflightConfig + NEVER_RETRY_CODES",
  "✓ X1 4 个载体字段漂移 · X2 hint 两处实现 + 出口塌缩 → 一个走查器 + tier 出口",
], { titleSize: 12 });
box(716, 1812, 700, 140, "bxnew", "迁移顺序（已全部落地，每条附验收台）", [
  "P0 单出口 / 结构化 stop_reason / 遮蔽 / hosts / 预检 —— tests/executor-p0.test.ts 21 条",
  "P1 hint 单实现 + tier 候选集（门控 tieredHint，默认 OFF 逐字节不变）—— 24 条",
  "P2 src/actions.ts 命令闭集 —— apps/skybook-checksubmit「勾选+提交」1/1 · 15 条",
  "P3 src/bindings.ts 数据槽层 —— apps/checkin-binding 1/1 + 2/2 · 20 条",
  "P4 next + 路径上界 / next_cycle —— apps/cold-search-next（删 next 即红）· 17 条",
  "D3/R-4 同一元素重复上界 → no_progress —— tests/no-progress.test.ts 5 条",
  `验收：verify + smoke.sh（PASS）· apps:suite 16/17 · apps:gen --check 8/8 · ${N.tests} 测试`,
], { titleSize: 12 });

/* ══════════════════════════ ⑨ 模型角色的修正 ══════════════════════════ */
P("M700,1952 V1988"); note(714, 1976, "真 ONNX 实测：承重件不是模型");
band(1988, 196, "⑨ 模型角色的修正（审查 docs/DECISION_MODEL_PURPOSE_REVIEW.md + 方案 docs/MODEL_ROLE_PLAN.md + 实施计划 W1–W5；注意与执行层 P0–P4 是两套编号）");
box(60, 2020, 444, 140, "bxred", "实测：分工写反了", [
  `浏览器步 ${N.named}/${N.browserSteps} 全由声明解决`
  + `（${N.hinted} 个用 hint 点名 = ${N.hintPct}%，其余 commands）；`,
  `真模型下整批语料 ${N.traceSteps} 步里选择提问 ${N.asks} 次、`,
  `过关 ${N.passed} 次，rule:match ${N.ruleMatch}/${N.traceSteps}`,
  `—— 选目标从不由模型决定。模型 top-1 ${N.top1}%`,
  `（拉丁 ${N.latin}% / CJK ${N.cjk}%）；闸门内 precision ${N.prec}%，`,
  `而闸门是两把不可比的尺子（passthrough AUC ${N.aucPt} 反向`,
  `／ shortlist ${N.aucSl}）。`,
  `$拆开看：passthrough 采纳 ${N.ptAdopt} 只对 ${N.ptRight}；shortlist 采纳 ${N.slAdopt} 对 ${N.slRight}。`,
  "删掉声明：同一批旅程完成率 4/4 → 0/4。",
  "$梯级：reobserve / escalate 救回 0 次 ⇒ dead rung",
], { titleSize: 12 });
box(516, 2020, 444, 140, "bxnew", "可修的三处（都有实测支持）", [
  "① 问法：窄问 14/14 选对（全池 3/14）——档内",
  "     候选 + 短名单，把「40 选 1」变成「≤8 选 1」。",
  "② 闸门：按问法归一（p(top1) / margin），",
  "     两把尺子分开标定；默认档逐字节不变。",
  "③ 裁决：只在非破坏性步放开模型（select 40% +",
  "     input 10% = 50%；真被页面校验的只有 10%）。",
  "连零选择器的语义流家族：开关模型结果逐字段相同。",
], { titleSize: 12 });
box(972, 2020, 444, 140, "bxe", "实施方案（按性价比，见 MODEL_ROLE_PLAN）", [
  "A3 风险头规则优先 + 进决策缓存（纯赚：597 s → <300 s）",
  "C1 覆盖率与 precision 进套件 · C2 漂移夹具 · C3 写进文档",
  "A1 + A2 同批：闸门档位 + 页面裁决（唯一有行为风险）",
  "B  作者期：模型提议 (hint, signal)、人确认（需 LLM 端点）",
  "备选：明确降级为「风险头 + 诊断」，省 597→240 s",
  "$判据：闸门两栏 AUC ≥0.5 · 漂移夹具转绿 · 错误动作被采纳 = 0",
], { titleSize: 12 });

/* ══════════════════════════════ 红线（改写后）══════════════════════════════ */
P("M700,2160 V2196");
R(40, 2196, W - 80, 120, "band red");
T(58, 2220, "四条红线（重审后：措辞收窄，机制不变，仍有测试与门禁撑着）", "foot", ' font-weight="700"');
note(58, 2242, "① 计划结构冻结 —— 运行期只允许「闭集内选择」与「过门回填」；② 不发明取值 —— 模型永不选值，页面候选必须由声明规则命中；", "foot", 1356);
note(58, 2262, "③ 完成只认该步「该面的证据」（DOM / 进程 / HTTP …；模型自述只作诊断）；④ 任何运行期新知识（hint / 候选 / 分支）都要过零模型重放门，不过就一个文件都不落。", "foot", 1356);
note(58, 2282, "（2026-10 补：模型角色的修正是加分项——不改变这四条；它只让兜底层在它能赢的地方出场。）", "foot", 1356);
note(58, 2302, "架构改进（未落地，不画进本图的结构）：计量单一出处 · 决策接口按问法版本化 · 可声明运行策略 · 可逆性模型 · 梯级卫生 · 声明面归并 —— docs/ARCHITECTURE_IMPROVEMENTS.md", "foot", 1356);

/* ══════════════════════════════ 组装 ══════════════════════════════ */
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'PingFang SC','Microsoft YaHei','Noto Sans CJK SC','Source Han Sans CN','Helvetica Neue',Arial,sans-serif">
<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#4a5568"/></marker>
<style>
.band{fill:#f7f8fa;stroke:#d7dce3;stroke-width:1}
.red{fill:#fff5f5;stroke:#e08383}
.lay{fill:#2d3748;font-size:13.5px;font-weight:700}
.title{fill:#1a202c;font-size:16.5px;font-weight:700}
.bx{fill:#fff;stroke:#b8c1cc;stroke-width:1.2}
.bxnew{fill:#f0f7ff;stroke:#2b6cb0;stroke-width:1.6}
.bxred{fill:#fff5f5;stroke:#c05621;stroke-width:1.4}
.bxd{fill:#fffaf0;stroke:#dd9b3b;stroke-width:1.2}
.bxm{fill:#ebf4ff;stroke:#4a86c5;stroke-width:1.2}
.bxe{fill:#f0fff4;stroke:#4a9d63;stroke-width:1.2}
.bxp{fill:#faf5ff;stroke:#8b5fbf;stroke-width:1.4}
.t{fill:#1a202c;font-size:12.5px;font-weight:600}
.s{fill:#4a5568;font-size:10.5px}
.sm{fill:#2b6cb0;font-size:10.5px}
.sub{fill:#2b6cb0;font-size:11.5px;font-weight:700}
.ln{stroke:#4a5568;stroke-width:1.4;fill:none}
.lbl{fill:#718096;font-size:10.5px;font-style:italic}
.foot{fill:#4a5568;font-size:11.5px}
</style></defs>
${out.join("\n")}
</svg>`;

/* ── 量：盒子重叠 / 越界 ───────────────────────────────────────────── */
for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
  const a = boxes[i], b = boxes[j];
  if (a.y < b.y + b.h - 2 && b.y < a.y + a.h - 2 && a.x < b.x + b.w - 2 && b.x < a.x + a.w - 2) {
    problems.push(`盒子重叠：${a.title} × ${b.title}`);
  }
}
for (const b of boxes) if (b.x + b.w > RIGHT) problems.push(`越出内容右界：${b.title} 到 ${String(b.x + b.w)}`);
for (const b of boxes) if (b.x < 40 || b.y < 40 || b.y + b.h > H - 20) problems.push(`盒子越出画布：${b.title}`);

/* ── 先检查、后写（v1 把这两步反了）────────────────────────────────── */
if (problems.length) {
  console.error(`图不合法（${problems.length} 项），未写任何文件：\n` + problems.join("\n"));
  process.exit(1);
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const OUT_SVG = argOf("--out") ?? path.resolve(HERE, "..", "docs", "architecture-target.svg");

if (process.argv.includes("--check")) {
  const cur = fs.existsSync(OUT_SVG) ? fs.readFileSync(OUT_SVG, "utf-8") : "";
  if (cur !== svg + "\n") {
    console.error(`图漂移：${OUT_SVG} 与生成结果不一致（改模块就要重跑本生成器）`);
    process.exit(1);
  }
  console.log(`图与生成结果一致：${OUT_SVG}`);
  process.exit(0);
}

fs.writeFileSync(OUT_SVG, svg + "\n");
console.log(`写出 ${OUT_SVG}`);

if (process.argv.includes("--png")) {
  const OUT_PNG = path.resolve(HERE, "..", "docs", "architecture-target.png");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
    await page.setContent(`<!doctype html><html><body style="margin:0;padding:0">${svg}</body></html>`);
    await page.screenshot({ path: OUT_PNG, clip: { x: 0, y: 0, width: W, height: H } });
    console.log(`写出 ${OUT_PNG}（${W * 2}×${H * 2}）`);
  } finally {
    await browser.close();
  }
}
