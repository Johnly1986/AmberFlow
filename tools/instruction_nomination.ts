/**
 * S0 指令提名实验台（NL Flow，docs/NL_FLOW_DESIGN.md §4/§10-S0）——先测后立。
 *
 * 问题：模型把一条 NL 步骤描述（"输入出发城市" / "选择最低价的一个航班"）映射到**指令闭集**
 * 的准确率是多少？这一问没测过（laya 为元素选择训练，这是分布偏移），而整个"指令晚绑定"
 * 设想的可行性压在这个数上。本工具用**已验收语料的实际执行**当真值（truth = 这一步真的
 * 执行了什么动作，从生产执行循环的 trace 里取），四个臂同台：
 *
 *   - `rules`          ：确定性关键词梯级（S2 提名梯级的第①档；弃权如实记 abstain）
 *   - `first-candidate`：永远答 click——零智能基线，任何新问法要先赢的线（provider 基线台同款）
 *   - `model`          ：真模型窄问（choice 题，选项 = 指令闭集）；产物不齐 ⇒ 如实 off(missing)，
 *                        **SKIP 不是通过**；CJK 描述按本仓纪律路由 multilingual checkpoint
 *   - `enumeration`    ：声明优先序（S2 第⑤档的裁决序）——真值在第几位 = 裁决兜回来的代价
 *
 * 产出：`bench/instruction-nomination/nomination.json`（冻结产物）+ 同名 .md 报告 + 控制台结论。
 * **停止条件（设计文档 §10-S0）只报告、不裁定**：③ 正确率 ≤ 基线且 ⑤ 收不回 ⇒ 设想降级，
 * 由项目方对着数字定。
 *
 * 用法：`node --experimental-strip-types tools/instruction_nomination.ts [--out DIR] [--limit N]`
 *       `… --check [--no-model]`：与已入库产物比可离线复算的部分（`--no-model` = CI 快跑）；
 *       冻结产物没有门禁就会静默漂移（改词表/改夹具/手改 REPORT 都不红），这条是它的门。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { loadPack, expandPack, type AppPack } from "../src/app-pack.ts";
import { runApp, type AppRunResult } from "../src/app-runner.ts";
import { checkArtifacts, missingPieces, modelConfigError, onnxModelPath } from "../src/model-artifacts.ts";
import { createLayaOnnxRuntime } from "../src/laya-onnx.ts";
import { installLayaRuntime, type DecisionAgent } from "../src/model.ts";
import { ruleNominate } from "../src/nominate.ts";
import { DEFAULT_ENUM_ORDER, instructionCriteria } from "../src/instructions.ts";

/** 本工具不经执行器，直接问 agent；装运行时只为保持"谁在跑"的单一出处。 */
function installLayaRuntimeSafe(rt: ReturnType<typeof createLayaOnnxRuntime>): void {
  try { installLayaRuntime(rt); } catch { /* 仅诊断面，装不上不影响直接问 agent */ }
}

/* ------------------------------------------------------------ 指令闭集与关键词梯级 */

/**
 * 提名的指令闭集与关键词梯级都**只活在 src/**（`instructions.ts` / `nominate.ts`）——
 * 本工具是 S0 的考官，不自备词表（单一出处；改词表 = 换考卷，必须重跑 S0 并各记各数）。
 */
const INSTRUCTIONS: Record<string, string> = instructionCriteria();
const ORDER: string[] = [...DEFAULT_ENUM_ORDER];

/** 真值提取：这一步**真的执行了**什么（从生产循环的 trace，不是从声明猜）。 */
export function truthOf(hows: string[], descs: string[]): string | null {
  const i = hows.findIndex((h) => h === "clicked" || h === "filled");
  if (i < 0) return null;
  const d = (descs[i] ?? "").toLowerCase();
  if (d.startsWith("type text into select")) return "select";
  if (d.startsWith("type text into input") || d.startsWith("type text into textarea")) return "fill";
  if (d.startsWith("click") || hows[i] === "clicked") return "click";
  if (hows[i] === "filled") return "fill";
  return null;
}

/* ------------------------------------------------------------------------ 语料收集 */

interface Row {
  app: string; index: number; id: string | null; desc: string; truth: string;
}

/** 离线旅程包发现：有浏览器步、无 hosts（真网络）、无 probe 块的 pack。 */
function discoverOfflineJourneyPacks(): Array<{ pack: AppPack; path: string }> {
  const root = path.resolve(import.meta.dirname, "..", "apps");
  const out: Array<{ pack: AppPack; path: string }> = [];
  for (const dir of fs.readdirSync(root).sort()) {
    const p = path.join(root, dir, "pack.json");
    if (!fs.existsSync(p)) continue;
    try {
      const pack = loadPack(p);
      const live = Array.isArray(pack.hosts) && pack.hosts.length > 0;
      if (live || pack.probe !== undefined) continue;
      out.push({ pack, path: p });
    } catch { /* 坏包不进语料（apps:suite 会点名它） */ }
  }
  return out;
}

async function collectCorpus(limit: number): Promise<{ rows: Row[]; skipped: string[]; packs: number }> {
  const rows: Row[] = [];
  const skipped: string[] = [];
  const packs = discoverOfflineJourneyPacks();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amber-nominate-"));
  let packsWithSteps = 0;
  for (const { pack } of packs) {
    let expanded;
    try {
      expanded = expandPack(pack, {}, ":memory:");
    } catch (e) {
      skipped.push(`${pack.id}: expand failed (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const browserSteps = expanded.steps.filter((s) => s.kind === "browser");
    if (browserSteps.length === 0) continue;
    packsWithSteps += 1;
    if (rows.length >= limit) continue;
    let res: AppRunResult;
    try {
      res = await runApp(pack, {
        sources: false, verbose: false,
        planPath: path.join(tmp, `${pack.id}.plan.json`),
        outDir: tmp, captureTraces: true,
        confirmSafe: true,
      });
    } catch (e) {
      skipped.push(`${pack.id}: run failed (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    for (const t of res.step_traces ?? []) {
      if (rows.length >= limit) break;
      if (t.status !== "done") { skipped.push(`${pack.id}#${t.index}: ${t.status}`); continue; }
      const truth = truthOf(t.hows, t.descs);
      if (truth === null) { skipped.push(`${pack.id}#${t.index}: no executed action`); continue; }
      rows.push({ app: pack.id, index: t.index, id: t.id, desc: t.desc, truth });
    }
  }
  return { rows, skipped, packs: packsWithSteps };
}

/* ------------------------------------------------------------------------ 真模型臂 */

const cjkRatio = (s: string): number => {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return s.length ? cjk / s.length : 0;
};

/** 流式 sha256（图是 GB 级，不整读进内存）；取前 16 hex 做证据面指纹。 */
async function sha256File(p: string): Promise<string | null> {
  try {
    const h = crypto.createHash("sha256");
    await pipeline(fs.createReadStream(p), h);
    return h.digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

async function loadModelArm(): Promise<{
  status: string;
  ask: ((desc: string) => Promise<string | null>) | null;
  detail: string;
  /** 权重图指纹（发现 9：冻结产物的 model 数字属于**那一组权重**——换权重不许误红也不许假绿）。 */
  graphSha: string | null;
}> {
  const envError = modelConfigError();
  const artifacts = checkArtifacts();
  const missing = missingPieces(artifacts);
  if (envError || missing.length > 0) {
    return {
      status: "off(missing)",
      ask: null,
      detail: envError ?? `missing: ${missing.join(", ")}`,
      graphSha: null,
    };
  }
  installLayaRuntimeSafe(createLayaOnnxRuntime());
  const rt = createLayaOnnxRuntime();
  const base: DecisionAgent = await rt.load("convaiinnovations/laya");
  const multi: DecisionAgent = await rt.load("convaiinnovations/laya", { subfolder: "multilingual" });
  const ask = async (desc: string): Promise<string | null> => {
    // 路由按**文字系统**切，绝不按置信度切（ECE 0.855 的教训）——CJK 描述走 multilingual。
    const agent = cjkRatio(desc) >= 0.3 ? multi : base;
    // 问法**逐字照抄**执行器给 laya 的实测形状（decision-provider.ts:349——
    // ask-shapes 调研的教训：措辞影响行为，实验必须给模型它被调优过的那一枪）。
    const res = await agent.predict(
      { goal: desc },
      {
        act: {
          type: "choice",
          instructions: `Goal: ${desc}. Which single instruction should be executed next to make progress on this goal? The candidates are abstract operation names; choose the one whose description matches the step.`,
          criteria: { ...INSTRUCTIONS },
        },
      },
    );
    const a = res.answers["act"];
    if (!a || !("choice" in a) || typeof a.choice !== "string") return null;
    return a.choice in INSTRUCTIONS ? a.choice : null;
  };
  return {
    status: "on", ask, detail: "convaiinnovations/laya (+multilingual)",
    graphSha: await sha256File(onnxModelPath()),
  };
}

/* ---------------------------------------------------------------------------- 主流程 */

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${n}/${d} (${((100 * n) / d).toFixed(1)}%)`;
}

/**
 * `--check`：与已入库产物比**可离线复算的部分**——语料计数 + 规则/基线/枚举三臂 + 闭集与序。
 * 冻结产物没有门禁就会静默漂移（改词表、改夹具、手改 REPORT.md 都不红），这条是它的门。
 * model 臂依赖本机权重：只在**产物与本机都 on** 时比，否则如实说"未比"（跳过 ≠ 通过）。
 */
async function check(outDir: string, withModel: boolean): Promise<number> {
  const p = path.join(outDir, "nomination.json");
  if (!fs.existsSync(p)) {
    console.error(`nomination --check：产物不存在：${p}（先跑一次不带 --check 的生成）`);
    return 1;
  }
  const committed = JSON.parse(fs.readFileSync(p, "utf-8")) as {
    instruction_set: unknown; enumeration_order: unknown;
    corpus: { packs: number; rows: number };
    scores: Record<string, { correct: number; abstain: number }>;
    enumeration: { order: unknown; coverage_at_first: number; coverage_in_order: number; mean_truth_position: number };
    model_arm: { status: string };
  };
  const { rows, packs } = await collectCorpus(10_000);
  const diffs: string[] = [];
  const eq = (what: string, a: unknown, b: unknown): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diffs.push(`${what}: 产物 ${JSON.stringify(a)} ≠ 复算 ${JSON.stringify(b)}`);
    }
  };
  eq("corpus.packs", committed.corpus.packs, packs);
  eq("corpus.rows", committed.corpus.rows, rows.length);
  eq("instruction_set", committed.instruction_set, INSTRUCTIONS);
  eq("enumeration_order", committed.enumeration_order, ORDER);
  const rules = rows.map((r) => ruleNominate(r.desc));
  const first = rows.map(() => "click");
  const correctOf = (pred: Array<string | null>): number =>
    rows.reduce((n, r, i) => n + (pred[i] === r.truth ? 1 : 0), 0);
  eq("scores.rules.correct", committed.scores.rules!.correct, correctOf(rules));
  eq("scores.rules.abstain", committed.scores.rules!.abstain, rules.filter((x) => x === null).length);
  eq("scores.first-candidate.correct", committed.scores["first-candidate"]!.correct, correctOf(first));
  const positions = rows.map((r) => ORDER.indexOf(r.truth));
  eq("enumeration.coverage_at_first", committed.enumeration.coverage_at_first, positions.filter((x) => x === 0).length);
  eq("enumeration.coverage_in_order", committed.enumeration.coverage_in_order, positions.filter((x) => x >= 0).length);
  const mean = positions.length ? positions.reduce((a, b) => a + b, 0) / positions.length : 0;
  eq("enumeration.mean_truth_position", committed.enumeration.mean_truth_position, Math.round(mean * 1000) / 1000);
  // model 臂：默认比（产物与本机都 on **且权重同一份**时）；`--no-model` = CI 快速门只比离线部分。
  let modelNote: string;
  if (!withModel) {
    modelNote = "未比（--no-model：CI 快跑只验离线部分；加默认档或 --with-model 才比）";
  } else {
    const m = await loadModelArm();
    const committedSha = (committed.model_arm as { graph_sha256?: string }).graph_sha256;
    if (committed.model_arm.status !== "on" || m.status !== "on" || !m.ask) {
      modelNote = `未比（产物 model_arm=${committed.model_arm.status} ｜ 本机=${m.status}）——跳过 ≠ 通过`;
    } else if (committedSha && m.graphSha && committedSha !== m.graphSha) {
      // 换权重不是"数字错了"——是**另一场考试**。不误红（别的机器不该为权重差异背锅），
      // 也不假绿（明说没比）。刷新 = 显式重跑生成并 --write 产物。
      modelNote = `未比（权重与冻结产物不同：committed ${committedSha}… vs 本机 ${m.graphSha}…）——跳过 ≠ 通过；要刷新产物请重跑本命令（不带 --check 即写）`;
    } else {
      let hit = 0;
      for (const r of rows) if ((await m.ask(r.desc)) === r.truth) hit += 1;
      eq("scores.model.correct", committed.scores.model!.correct, hit);
      modelNote = `已比（${hit}/${rows.length}）`;
    }
  }
  if (diffs.length) {
    console.error("nomination --check FAILED（冻结产物与复算不一致）：");
    for (const d of diffs) console.error(`  - ${d}`);
    return 1;
  }
  console.log(`nomination --check OK：语料 ${packs} 包 / ${rows.length} 步 + 离线三臂 + 闭集/序与产物一致；model 臂 ${modelNote}`);
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const outDir = path.resolve(get("out") ?? path.join(import.meta.dirname, "..", "bench", "instruction-nomination"));
  const limit = Math.max(1, Number(get("limit") ?? 10_000));
  if (argv.includes("--check")) return check(outDir, !argv.includes("--no-model"));

  console.log("S0 指令提名实验台：语料 = 已验收离线语料的实际执行（truth 来自生产循环 trace）");
  const { rows, skipped, packs } = await collectCorpus(limit);
  console.log(`语料：${packs} 个离线旅程包，${rows.length} 条有真值的浏览器步（跳过 ${skipped.length} 条：skipped/blocked/无动作）`);

  // ---- 四臂 ------------------------------------------------------------------
  const arms: Record<string, Array<string | null>> = { rules: [], "first-candidate": [], model: [], enumeration: [] };
  let modelStatus = "off(not-run)";
  let modelDetail = "arm disabled";
  let modelGraphSha: string | null = null;
  if (rows.length) {
    for (const r of rows) arms.rules.push(ruleNominate(r.desc));
    for (const r of rows) arms["first-candidate"].push("click");
    const m = await loadModelArm();
    modelStatus = m.status; modelDetail = m.detail; modelGraphSha = m.graphSha;
    console.log(`model 臂：${modelStatus}（${modelDetail}）`);
    if (m.ask) {
      let i = 0;
      for (const r of rows) {
        arms.model.push(await m.ask(r.desc));
        i += 1;
        if (i % 25 === 0) console.log(`  model 臂进度 ${i}/${rows.length}`);
      }
    } else {
      for (const _r of rows) arms.model.push(null);
    }
    for (const _r of rows) arms.enumeration.push(ORDER[0]!); // 枚举臂按序试，首位即 click
  }

  // ---- 计分 ------------------------------------------------------------------
  const score = (pred: Array<string | null>) => {
    let correct = 0, abstain = 0;
    const byTruth: Record<string, { n: number; correct: number }> = {};
    rows.forEach((r, i) => {
      const t = r.truth;
      byTruth[t] ??= { n: 0, correct: 0 };
      byTruth[t]!.n += 1;
      const p = pred[i];
      if (p === null || p === undefined) { abstain += 1; return; }
      if (p === t) { correct += 1; byTruth[t]!.correct += 1; }
    });
    return { correct, abstain, total: rows.length, byTruth };
  };
  const scores = Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, score(v)]));

  // 枚举臂：真值在声明序里的位置（裁决兜回来的代价 = 位置，0 起算）
  const positions = rows.map((r) => ORDER.indexOf(r.truth));
  const coverage1 = positions.filter((p) => p === 0).length;
  const coverageAll = positions.filter((p) => p >= 0).length;
  const meanPos = positions.length ? positions.reduce((a, b) => a + b, 0) / positions.length : 0;

  const artifact = {
    generated_at: new Date().toISOString(),
    instruction_set: INSTRUCTIONS,
    enumeration_order: ORDER,
    corpus: { packs, rows: rows.length, skipped: skipped.length },
    model_arm: {
      status: modelStatus, detail: modelDetail,
      ...(modelGraphSha ? { graph_sha256: modelGraphSha } : {}),
    },
    rows,
    /** 每行的各臂预测（诊断用：错在哪、错成什么）。 */
    predictions: Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, v])),
    scores,
    enumeration: {
      order: ORDER,
      coverage_at_first: coverage1,
      coverage_in_order: coverageAll,
      mean_truth_position: Math.round(meanPos * 1000) / 1000,
    },
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "nomination.json"), JSON.stringify(artifact, null, 2), "utf-8");

  // ---- 报告 ------------------------------------------------------------------
  const L: string[] = [];
  L.push("# S0 指令提名实验（NL Flow）");
  L.push("");
  L.push(`- 生成：${artifact.generated_at} ｜ 语料：${packs} 包 / ${rows.length} 步（跳过 ${skipped.length}）`);
  L.push(`- 真值：已验收语料的**实际执行**（生产循环 trace 的 how/desc），不是声明猜的`);
  L.push(`- model 臂：**${modelStatus}**（${modelDetail}）——SKIP 不是通过`);
  L.push("");
  L.push("| 臂 | 正确率 | 弃权 | 备注 |");
  L.push("|---|---|---|---|");
  L.push(`| rules（①关键词梯级） | ${pct(scores.rules!.correct, rows.length)} | ${scores.rules!.abstain} | 数据规则优先；未命中弃权 |`);
  L.push(`| first-candidate（基线） | ${pct(scores["first-candidate"]!.correct, rows.length)} | 0 | 永远答 click——新问法要先赢的线 |`);
  L.push(`| model（③窄问） | ${modelStatus === "on" ? pct(scores.model!.correct, rows.length) : "未测（off）"} | ${scores.model!.abstain} | ${modelStatus} |`);
  L.push(`| enumeration（⑤裁决序） | 首位命中 ${pct(coverage1, rows.length)}；序内命中 ${pct(coverageAll, rows.length)} | 0 | 真值平均位置 ${meanPos.toFixed(2)}（0 起算） |`);
  L.push("");
  L.push("## 按真值拆分（rules 臂 / model 臂）");
  L.push("");
  L.push("| 真值 | 条数 | rules 命中 | model 命中 |");
  L.push("|---|---|---|---|");
  for (const t of ORDER) {
    const bt = scores.rules!.byTruth[t];
    const bm = scores.model!.byTruth[t];
    if (!bt) continue;
    L.push(`| ${t} | ${bt.n} | ${bt.correct} | ${bm ? bm.correct : "—"} |`);
  }
  L.push("");
  L.push("## 对设计文档停止条件的读数（只报告，不裁定）");
  L.push("");
  const base = scores["first-candidate"]!.correct;
  const mdl = scores.model!.correct;
  L.push(`- ③ vs 基线：model ${mdl} / first-candidate ${base}（总 ${rows.length}）`
    + ` ⇒ ${modelStatus === "on" ? (mdl > base ? "model 臂**高于**基线" : "model 臂**不高于**基线") : "model 臂未测，停止条件无法判"}`);
  L.push(`- ⑤ 兜底：枚举序首位命中 ${coverage1}/${rows.length}，序内命中 ${coverageAll}/${rows.length}`
    + ` ⇒ 裁决兜回来的代价 = 平均再试 ${meanPos.toFixed(2)} 条指令`);
  L.push("");
  L.push("## 口径边界（诚实清单）");
  L.push("");
  L.push("- **本数是\"NL desc 单独够不够\"的下界**：问句 state 只装 `{goal: desc}`（无页面）。"
    + "S2 运行期提名器**可以**看当次页面（执行器实测问法含 `main_text`）——本工具刻意不装，"
    + "量的是\"不依赖页面的提名\"这一档的真实水位。");
  L.push("- **model 臂塌缩现象**：多数行答 `list_pick`（desc 里的\"最低价/排序\"字样关键词捕获，"
    + "与 ① 规则臂同因）。逐行预测在 `nomination.json` 的 `predictions`，可复核。"
    + "换问法（短标签 / 带页面 state）是合法的下一步（ask-shapes 先例），换一次重跑一次、各记各数。");
  L.push("- **⑤ 的 100% 覆盖是真值分布的性质**：本语料真值 ∈ {click, fill, select}，"
    + "声明序恰好覆盖；新指令进闭集时要同步看这一列。");
  L.push("");
  L.push(`复算：\`node --experimental-strip-types tools/instruction_nomination.ts --out ${outDir}\``);
  const report = L.join("\n");
  fs.writeFileSync(path.join(outDir, "REPORT.md"), report, "utf-8");
  console.log("\n" + report);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? "");
if (isMain) main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
