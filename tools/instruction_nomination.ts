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
 * ⚠ **考卷偏倚警示（2026-10-17 逐行复核，docs/NOMINATION_QUESTION_SET_ANALYSIS.md）**：
 * 本考卷**只能测"desc-only 无条件闭集"这一种题形状**，不能给"③ 提名"整体打分——
 * ①题面无状态（83/165 行同一句话跨应用真值不同）；②标签取 trace 首动作（题面首动作族与真值吻合
 * 仅 44.8%）；③语料排除 list/check 步（闭集 2/5 结构性不可对，77 次 list_pick 预测全错）。
 * 换问法/换语料（S0-v2：受约束提名）= 换考卷，必须新建产物、各记各数，别改本冻结产物。
 * **S0-v2 已实现**：`--context --provider <name>`（独立产物 `bench/instruction-nomination-context/`）——
 * 同一考卷补页面状态（captureStateView），并对照"候选按页面条件化"臂；实测 24.8% → 63.6% → 88.5%
 * （da2 歧义组 7.2% → 92.8%），见 docs/NOMINATION_QUESTION_SET_ANALYSIS.md §6。
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
import { loadPack, expandPack, type AppPack } from "../src/app/app-pack.ts";
import { appDataFileInDir } from "../src/app/declarative.ts";
import { getAppAdapter } from "../src/app/app-adapters.ts";
import { runApp, type AppRunResult, type StepStateView } from "../src/app/app-runner.ts";
import { conditionedInstructionCriteria, pageStateForModel } from "../src/model/page-context.ts";
import { checkArtifacts, missingPieces, modelConfigError, onnxModelPath } from "../src/model/model-artifacts.ts";
import { createLayaOnnxRuntime } from "../src/model/laya-onnx.ts";
import { installLayaRuntime, type DecisionAgent } from "../src/model/model.ts";
import { ruleNominate } from "../src/model/nominate.ts";
import { DEFAULT_ENUM_ORDER, INSTRUCTION_NAMES, instructionCriteria } from "../src/model/instructions.ts";
import { nominationInstructions, providerNominationAsk } from "../src/model/nominate.ts";
import { resolveProviderSpec, type ProviderInfo } from "../src/model/decision-provider.ts";
import { applyRcToEnv } from "../src/support/rcfile.ts";

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
  /** S0-v2 上下文实验：这一步开始时的页面状态（withState 才采；缺字段 = 没开）。 */
  state?: StepStateView;
}

/**
 * 离线旅程包发现：有浏览器步、无 hosts（真网络）、无 probe 块的 pack。
 *
 * **还要排除"能力探测型"应用**（多类型应用里依赖本机服务的类型，如 ssh 需要可用 sshd）：
 * 这份提名语料是**机器无关的冻结证据**（`--check` 逐字节复算），一个"能不能跑取决于这台机器
 * 有没有装服务"的应用进了语料，语料就会随环境漂移——所以按适配器声明的 `ready()` 探测排除，
 * **不按应用 id 特判**（加新类型时自动获得同一条规则）。
 */
function discoverOfflineJourneyPacks(): Array<{ pack: AppPack; path: string }> {
  const root = path.resolve(import.meta.dirname, "..", "apps");
  const out: Array<{ pack: AppPack; path: string }> = [];
  for (const dir of fs.readdirSync(root).sort()) {
    const p = appDataFileInDir(path.join(root, dir));
    if (p === null) continue;
    try {
      const pack = loadPack(p);
      const live = Array.isArray(pack.hosts) && pack.hosts.length > 0;
      if (live || pack.probe !== undefined) continue;
      let capabilityGated = false;
      try {
        for (const st of expandPack(pack, {}, ":memory:").steps) {
          if (getAppAdapter(st.adapter)?.ready !== undefined) { capabilityGated = true; break; }
        }
      } catch { continue; }   // 展开失败不进语料（apps:suite 会点名它）
      if (capabilityGated) continue;
      out.push({ pack, path: p });
    } catch { /* 坏包不进语料（apps:suite 会点名它） */ }
  }
  return out;
}

async function collectCorpus(limit: number, withState = false): Promise<{ rows: Row[]; skipped: string[]; packs: number }> {
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
        ...(withState ? { captureStateView: true } : {}),
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
      rows.push({
        app: pack.id, index: t.index, id: t.id, desc: t.desc, truth,
        ...(t.state_view ? { state: t.state_view } : {}),
      });
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

async function loadModelArm(stateFor?: (desc: string) => Record<string, unknown>): Promise<{
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
      stateFor ? { ...stateFor(desc), goal: desc } : { goal: desc },
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

/** 计分（默认四臂与线上 provider 审查臂共用同一份口径）。 */
function scoreArm(rows: Row[], pred: Array<string | null>): {
  correct: number; abstain: number; total: number;
  byTruth: Record<string, { n: number; correct: number }>;
} {
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
}

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

/* ------------------------------------------------------- 线上决策模型审查臂（S0-online） */

/**
 * **用线上决策模型审查 S0 考卷**：同一份语料、同一份问法，把 ③ 档换成"闭集选择能力"
 * （`DecisionProvider.askChoice`，与运行期提名梯级同一份接线 `providerNominationAsk`）。
 *
 * 与默认四臂的关系：默认模式是**冻结的 S0 产物**（本地 laya 那一枪）；本模式写**独立产物**，
 * 不碰 S0 冻结文件——换模型不是重跑考试，是**另一场考试**，各记各数。
 * 复用：语料收集、离线三臂、闭集与序全部与本工具同源（单一出处），只把 ③ 的模型换掉。
 */
async function runProviderReview(outDir: string, providerName: string, limit: number): Promise<number> {
  console.log(`S0 线上决策模型审查：provider=${providerName}｜语料 = 已验收离线语料的实际执行`);
  const { rows, skipped, packs } = await collectCorpus(limit);
  console.log(`语料：${packs} 个离线旅程包，${rows.length} 条有真值的浏览器步（跳过 ${skipped.length} 条）`);

  // 离线三臂（与默认四臂同一份口径）
  const rules = rows.map((r) => ruleNominate(r.desc));
  const first = rows.map(() => "click");
  const enumeration = rows.map(() => ORDER[0]!);

  // 线上 ③：解析 provider（显式点名却没配 ⇒ 响亮说清楚，不写产物——空手产物会被误读成"测过了"）
  let status = "off(unconfigured)";
  let detail = "";
  let identity: ProviderInfo | null = null;
  let ask: ReturnType<typeof providerNominationAsk> = null;
  try {
    const spec = await resolveProviderSpec(providerName, process.env);
    if (spec.kind !== "provider") {
      detail = `provider 未配置到可用（tier=${spec.tier}）：按仓库纪律，未配置不测、不写产物`;
    } else {
      identity = {
        name: spec.provider.name, version: spec.provider.version,
        capabilities: { ...spec.provider.capabilities },
        ...(spec.provider.floor !== undefined ? { floor: spec.provider.floor } : {}),
      };
      ask = providerNominationAsk(spec.provider);
      if (!ask) detail = "provider 没有 askChoice 能力（不能做闭集选择）";
      else status = "on";
    }
  } catch (e) {
    detail = `解析失败：${e instanceof Error ? e.message : String(e)}`;
  }
  if (!ask) {
    console.error(`线上臂不可用：${status}｜${detail}`);
    return 2;
  }

  console.log(`线上 ③：${identity!.name} ${identity!.version}（score_kind=${identity!.capabilities.score_kind}`
    + `${identity!.floor !== undefined ? `，floor=${identity!.floor}` : ""}）`);
  const preds: Array<string | null> = [];
  const latencies: number[] = [];
  const t0 = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const t = Date.now();
    preds.push(await ask(rows[i]!.desc, INSTRUCTION_NAMES));
    latencies.push(Date.now() - t);
    if ((i + 1) % 20 === 0) console.log(`  线上臂进度 ${i + 1}/${rows.length}`);
  }
  const totalMs = Date.now() - t0;

  const arms: Record<string, Array<string | null>> = {
    rules, "first-candidate": first, [providerName]: preds, enumeration,
  };
  const scores = Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, scoreArm(rows, v)]));
  const positions = rows.map((r) => ORDER.indexOf(r.truth));
  const coverage1 = positions.filter((p) => p === 0).length;
  const coverageAll = positions.filter((p) => p >= 0).length;

  // 错成什么（审查用：模型臂的混淆矩阵）
  const confusion: Record<string, Record<string, number>> = {};
  rows.forEach((r, i) => {
    const p = preds[i];
    if (p === null || p === undefined || p === r.truth) return;
    (confusion[r.truth] ??= {})[p] = ((confusion[r.truth] ??= {})[p] ?? 0) + 1;
  });

  // 历史账：引用 S0 冻结产物里本地 laya 那一枪（有则引用，无则明说）
  const s0Path = path.join(import.meta.dirname, "..", "bench", "instruction-nomination", "nomination.json");
  let s0Ref: { model_status: string; correct: number; total: number } | null = null;
  if (fs.existsSync(s0Path)) {
    try {
      const s0 = JSON.parse(fs.readFileSync(s0Path, "utf-8")) as {
        corpus: { rows: number }; model_arm: { status: string }; scores: { model?: { correct: number } };
      };
      s0Ref = { model_status: s0.model_arm.status, correct: s0.scores.model?.correct ?? -1, total: s0.corpus.rows };
    } catch { /* 引用失败就当没有 */ }
  }

  const artifact = {
    generated_at: new Date().toISOString(),
    mode: "provider-review",
    provider_arm: {
      provider: providerName,
      status,
      identity,
      asks: rows.length,
      total_ms: totalMs,
      mean_ms: rows.length ? Math.round((totalMs / rows.length) * 10) / 10 : 0,
      p50_ms: latencies.length ? latencies.slice().sort((a, b) => a - b)[Math.floor(latencies.length / 2)] : 0,
    },
    instruction_set: INSTRUCTIONS,
    enumeration_order: ORDER,
    corpus: { packs, rows: rows.length, skipped: skipped.length },
    rows,
    predictions: { rules, "first-candidate": first, [providerName]: preds },
    scores,
    confusion,
    enumeration: {
      order: ORDER, coverage_at_first: coverage1, coverage_in_order: coverageAll,
      mean_truth_position: Math.round((positions.reduce((a, b) => a + b, 0) / Math.max(1, positions.length)) * 1000) / 1000,
    },
    reference_s0: s0Ref,
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "nomination-online.json"), JSON.stringify(artifact, null, 2), "utf-8");

  // ---- 报告 ----
  const base = scores["first-candidate"]!.correct;
  const ruled = scores.rules!.correct;
  const online = scores[providerName]!.correct;
  const L: string[] = [];
  L.push("# S0 线上决策模型审查（③ 提名窄问换 provider）");
  L.push("");
  L.push(`- 生成：${artifact.generated_at} ｜ provider：**${identity!.name} ${identity!.version}**`);
  L.push(`- 语料：${packs} 包 / ${rows.length} 步（跳过 ${skipped.length}）——与 S0 冻结产物同一份收集器`);
  L.push(`- 问法：同一份 \`nominationInstructions\`（S0 与本审查共用单一出处）；选项 = 指令闭集`);
  L.push(`- 代价：${rows.length} 次咨询，总 ${(totalMs / 1000).toFixed(1)} s（均值 ${artifact.provider_arm.mean_ms} ms / p50 ${artifact.provider_arm.p50_ms} ms）`);
  L.push("");
  L.push("| 臂 | 正确率 | 弃权 | 说明 |");
  L.push("|---|---|---|---|");
  L.push(`| rules（①关键词梯级） | ${pct(ruled, rows.length)} | ${scores.rules!.abstain} | 确定性；未命中弃权 |`);
  L.push(`| first-candidate（基线） | ${pct(base, rows.length)} | 0 | 永远答 click |`);
  if (s0Ref) {
    L.push(`| 本地 laya（S0 冻结账） | ${pct(Math.max(0, s0Ref.correct), s0Ref.total)} | — | 2026-10-15 冻结产物（${s0Ref.model_status}） |`);
  }
  L.push(`| **线上 ${identity!.name}（③）** | **${pct(online, rows.length)}** | ${scores[providerName]!.abstain} | score_kind=${identity!.capabilities.score_kind} |`);
  L.push("");
  L.push("## 按真值拆分");
  L.push("");
  L.push(`| 真值 | 条数 | rules 命中 | 线上 ③ 命中 |`);
  L.push("|---|---|---|---|");
  for (const t of ORDER) {
    const bt = scores.rules!.byTruth[t];
    if (!bt) continue;
    const bo = scores[providerName]!.byTruth[t];
    L.push(`| ${t} | ${bt.n} | ${bt.correct} | ${bo ? bo.correct : 0} |`);
  }
  L.push("");
  L.push("## 错成什么（线上 ③ 的混淆，只列错行）");
  L.push("");
  if (Object.keys(confusion).length === 0) {
    L.push("- 无错误。");
  } else {
    for (const [truth, m] of Object.entries(confusion)) {
      L.push(`- 真值 ${truth} → ${Object.entries(m).map(([p, n]) => `${p}×${n}`).join("、")}`);
    }
  }
  L.push("");
  L.push("## 对设计文档停止条件的读数（只报告，不裁定）");
  L.push("");
  L.push(`- ③ vs 基线：线上 ${online} / first-candidate ${base}（总 ${rows.length}）`
    + ` ⇒ ${online > base ? "**高于**基线" : "**不高于**基线"}`);
  L.push(`- ③ vs ①规则：${online} vs ${ruled} ⇒ ${online > ruled ? "高于" : "不高于"}确定性梯级`);
  if (s0Ref) {
    L.push(`- 与本地 laya 的差：${online} vs ${Math.max(0, s0Ref.correct)}（同一份考卷、不同模型——不是"同模型换问法"）`);
  }
  L.push("");
  L.push("## 口径边界（诚实清单）");
  L.push("");
  L.push("- **desc-only 问法**（state 只有 `{goal: desc}`，无页面）：这是\"不依赖页面的提名\"的下界；"
    + "运行期提名器可以带页面状态，那一档没测。");
  L.push("- **一份权重/一个服务**：换 provider 的权重或服务版本 = 另一场考试，数字不迁移（同 S0 model 臂的 graph_sha256 纪律）。");
  L.push("- **单次运行**，不是统计重采样；线上服务有网络抖动（延迟列在产物里）。");
  L.push("- 本产物**不替代** S0 冻结产物（`bench/instruction-nomination/`）：那份仍是本地 laya 的账。");
  L.push("");
  L.push(`复算：\`TOKEN_PLAN_ENDPOINT=… TOKEN_PLAN_API_KEY=… node --experimental-strip-types tools/instruction_nomination.ts --provider ${providerName}\``);
  const report = L.join("\n");
  fs.writeFileSync(path.join(outDir, "REPORT.md"), report, "utf-8");
  console.log("\n" + report);
  return 0;
}

/** `--check`：上下文实验产物的**可离线复算部分**（语料/歧义组/离线两臂）；线上臂是网络臂，默认不比。 */
async function checkContextReview(outDir: string, providerName: string): Promise<number> {
  const p = path.join(outDir, "nomination-context.json");
  if (!fs.existsSync(p)) {
    console.error(`nomination --check：上下文实验产物不存在：${p}（先跑一次 --context --provider ${providerName}）`);
    return 1;
  }
  const committed = JSON.parse(fs.readFileSync(p, "utf-8")) as {
    instruction_set: unknown; enumeration_order: unknown;
    corpus: { packs: number; rows: number; with_state: number; ambiguous: number };
    scores: Record<string, { correct: number }>;
    predictions: Record<string, Array<string | null>>;
  };
  const { rows, packs } = await collectCorpus(10_000, true);
  const diffs: string[] = [];
  const eq = (what: string, a: unknown, b: unknown): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${what}: 产物 ${JSON.stringify(a)} ≠ 复算 ${JSON.stringify(b)}`);
  };
  eq("corpus.packs", committed.corpus.packs, packs);
  eq("corpus.rows", committed.corpus.rows, rows.length);
  eq("corpus.with_state", committed.corpus.with_state, rows.filter((r) => r.state).length);
  eq("instruction_set", committed.instruction_set, INSTRUCTIONS);
  eq("enumeration_order", committed.enumeration_order, ORDER);
  const rules = rows.map((r) => ruleNominate(r.desc));
  const first = rows.map(() => "click");
  const correctOf = (pred: Array<string | null>): number => rows.reduce((n, r, i) => n + (pred[i] === r.truth ? 1 : 0), 0);
  eq("scores.rules.correct", committed.scores["rules"]!.correct, correctOf(rules));
  eq("scores.first-candidate.correct", committed.scores["first-candidate"]!.correct, correctOf(first));
  if (diffs.length) {
    console.error("nomination --check（上下文实验产物）FAILED：");
    for (const d of diffs) console.error(`  - ${d}`);
    return 1;
  }
  console.log(`nomination --check（上下文实验产物）OK：语料 ${packs} 包 / ${rows.length} 步（状态 ${rows.filter((r) => r.state).length}）`
    + ` + 离线两臂一致；线上臂 未比（网络臂：产物 provider=${providerName}；重跑需配置端点/密钥）`);
  return 0;
}

/** `--check`：线上审查产物的**可离线复算部分**（语料/闭集/离线三臂）；线上臂是网络臂，默认不比。 */
async function checkProviderReview(outDir: string, providerName: string): Promise<number> {
  const p = path.join(outDir, "nomination-online.json");
  if (!fs.existsSync(p)) {
    console.error(`nomination --check：线上审查产物不存在：${p}（先跑一次 --provider ${providerName} 生成）`);
    return 1;
  }
  const committed = JSON.parse(fs.readFileSync(p, "utf-8")) as {
    instruction_set: unknown; enumeration_order: unknown;
    corpus: { packs: number; rows: number };
    scores: Record<string, { correct: number; abstain: number }>;
    provider_arm: { provider: string; status: string; identity: { name: string; version: string } | null };
  };
  const { rows, packs } = await collectCorpus(10_000);
  const diffs: string[] = [];
  const eq = (what: string, a: unknown, b: unknown): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${what}: 产物 ${JSON.stringify(a)} ≠ 复算 ${JSON.stringify(b)}`);
  };
  eq("corpus.packs", committed.corpus.packs, packs);
  eq("corpus.rows", committed.corpus.rows, rows.length);
  eq("instruction_set", committed.instruction_set, INSTRUCTIONS);
  eq("enumeration_order", committed.enumeration_order, ORDER);
  const rules = rows.map((r) => ruleNominate(r.desc));
  const first = rows.map(() => "click");
  const correctOf = (pred: Array<string | null>): number => rows.reduce((n, r, i) => n + (pred[i] === r.truth ? 1 : 0), 0);
  eq("scores.rules.correct", committed.scores["rules"]!.correct, correctOf(rules));
  eq("scores.first-candidate.correct", committed.scores["first-candidate"]!.correct, correctOf(first));
  // 线上臂：**网络臂**，默认不比（跳过 ≠ 通过）；产物身份自报也要一致。
  const note = committed.provider_arm.status === "on"
    ? `未比（网络臂：产物 provider=${committed.provider_arm.provider} ${committed.provider_arm.identity?.version ?? "?"}；重跑需配置端点/密钥）`
    : `未比（产物线上臂 status=${committed.provider_arm.status}）`;
  if (diffs.length) {
    console.error("nomination --check（线上审查产物）FAILED：");
    for (const d of diffs) console.error(`  - ${d}`);
    return 1;
  }
  console.log(`nomination --check（线上审查产物）OK：语料 ${packs} 包 / ${rows.length} 步 + 离线三臂与产物一致；线上臂 ${note}`);
  return 0;
}

/* ------------------------------------------- S0-v2：把页面上下文补进题面（上下文实验） */

/** 归一化题面（日期/时段/价格→占位），用于识别"同一句话、不同真值"的跨实现歧义组。 */
function normalizeDesc(d: string): string {
  return d
    .replace(/20\d\d-\d\d-\d\d（周.）?/g, "{date}")
    .replace(/20\d\d-\d\d-\d\d/g, "{date}")
    .replace(/\d{1,2}:\d{2}-\d{2}:\d{2}/g, "{time}")
    .replace(/¥\d+/g, "{price}")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * **S0-v2 上下文实验**：与 S0 同一考卷（语料/真值/闭集/问法），只把**页面上下文**补进题面。
 * 对照臂：
 *   - `nostate`（同 S0 的线上执行）：state 只有 goal——复现"猜"的那一臂；
 *   - `context`：state = {url,title,main_text,affordances}（页面有什么，模型自己判断）；
 *   - `context-candidates`：context + 候选描述带上**本页可用性**（候选条件化）；
 *   - `laya-context`：本地 laya 也带同一份上下文（两个模型同题对照，验证"根因是设计"）。
 * 额外读数：**歧义组**（归一化题面同、跨应用真值不同）上的准确率——上下文应该主要救这些行。
 */
async function runContextReview(outDir: string, providerName: string, limit: number): Promise<number> {
  console.log(`S0-v2 上下文实验：provider=${providerName}｜同一考卷 + 页面上下文`);
  const { rows, skipped, packs } = await collectCorpus(limit, true);
  const withState = rows.filter((r) => r.state !== undefined).length;
  console.log(`语料：${packs} 包 / ${rows.length} 步（跳过 ${skipped.length}；带页面状态 ${withState}）`);
  if (withState === 0) {
    console.error("没有采到页面状态（captureStateView 未生效？）——上下文实验无从谈起，不写产物");
    return 2;
  }

  // 歧义组标记：归一化题面相同且真值不同 ⇒ 该组内所有行标 ambiguous
  const groups = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const k = normalizeDesc(r.desc);
    groups.set(k, [...(groups.get(k) ?? []), i]);
  });
  const ambiguous = new Set<number>();
  for (const idxs of groups.values()) {
    if (idxs.length > 1 && new Set(idxs.map((i) => rows[i]!.truth)).size > 1) for (const i of idxs) ambiguous.add(i);
  }
  console.log(`歧义组（同一句话跨应用不同真值）：${ambiguous.size} 行`);

  // ---- 解析 provider（缺配置不写产物） ----
  let identity: ProviderInfo | null = null;
  let provider: Awaited<ReturnType<typeof resolveProviderSpec>> | null = null;
  try {
    const spec = await resolveProviderSpec(providerName, process.env);
    if (spec.kind !== "provider") {
      console.error(`provider 未配置到可用（tier=${spec.tier}）：不测、不写产物`);
      return 2;
    }
    if (!spec.provider.askChoice) {
      console.error(`provider ${providerName} 没有 askChoice 能力`);
      return 2;
    }
    provider = spec;
    identity = {
      name: spec.provider.name, version: spec.provider.version,
      capabilities: { ...spec.provider.capabilities },
      ...(spec.provider.floor !== undefined ? { floor: spec.provider.floor } : {}),
    };
  } catch (e) {
    console.error(`解析 provider 失败：${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const askChoice = provider!.kind === "provider" ? provider!.provider.askChoice!.bind(provider!.provider) : null;
  if (!askChoice) return 2;

  // ---- 各臂 ----
  const arms: Record<string, Array<string | null>> = {
    rules: rows.map((r) => ruleNominate(r.desc)),
    "first-candidate": rows.map(() => "click"),
  };
  const asksOf: Record<string, { asks: number; totalMs: number }> = {};
  const runOnline = async (arm: string, stateFor: (row: Row) => Record<string, unknown> | undefined,
    criteriaFor?: (row: Row) => Record<string, string>): Promise<void> => {
    const preds: Array<string | null> = [];
    const t0 = Date.now();
    for (const r of rows) {
      const criteria = criteriaFor ? criteriaFor(r) : { ...INSTRUCTIONS };
      const res = await askChoice({
        goal: r.desc,
        instructions: nominationInstructions(r.desc),
        criteria,
        ...(stateFor(r) ? { state: stateFor(r) } : {}),
      });
      preds.push(res?.ref ?? null);
    }
    arms[arm] = preds;
    asksOf[arm] = { asks: rows.length, totalMs: Date.now() - t0 };
    console.log(`  ${arm}: ${preds.filter((p) => p !== null).length}/${rows.length} 有答案 · ${(asksOf[arm]!.totalMs / 1000).toFixed(1)}s`);
  };
  await runOnline("nostate", () => undefined);
  await runOnline("context", (r) => (r.state ? pageStateForModel(r.state) : undefined));
  await runOnline("context-candidates", (r) => (r.state ? pageStateForModel(r.state) : undefined),
    (r) => (r.state ? conditionedInstructionCriteria(r.state, Object.keys(INSTRUCTIONS)) : { ...INSTRUCTIONS }));

  // laya 上下文臂（本地模型同题对照；产物不齐 = 如实 off）
  const layaArm = await loadModelArm((desc) => {
    const r = rows.find((x) => x.desc === desc);
    if (r?.state === undefined) return {};
    const a = r.state.affordances;
    const line = `可点击 ${a.clickables.length}｜输入框 ${a.text_inputs.length}｜下拉 ${a.selects.length}`
      + `｜勾选 ${a.checkboxes.length}｜价格元素 ${a.prices}`;
    return { url: r.state.url, title: r.state.title, main_text: `${r.state.text} [${line}]` };
  });
  let layaStatus = layaArm.status;
  if (layaArm.ask) {
    const preds: Array<string | null> = [];
    for (const r of rows) preds.push(await layaArm.ask(r.desc));
    arms["laya-context"] = preds;
  } else {
    arms["laya-context"] = rows.map(() => null);
    layaStatus = layaArm.status;
  }

  // ---- 计分（总体 + 歧义组/非歧义组分别记） ----
  const scores = Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, scoreArm(rows, v)]));
  const splitScore = (arm: string): { amb: { n: number; correct: number }; clear: { n: number; correct: number } } => {
    let ambN = 0, ambC = 0, clN = 0, clC = 0;
    rows.forEach((r, i) => {
      const ok = arms[arm]![i] === r.truth;
      if (ambiguous.has(i)) { ambN += 1; if (ok) ambC += 1; } else { clN += 1; if (ok) clC += 1; }
    });
    return { amb: { n: ambN, correct: ambC }, clear: { n: clN, correct: clC } };
  };

  const artifact = {
    generated_at: new Date().toISOString(),
    mode: "context-review",
    provider_arm: {
      provider: providerName, status: "on", identity,
      asks: asksOf, laya: { status: layaStatus },
    },
    instruction_set: INSTRUCTIONS,
    enumeration_order: ORDER,
    corpus: { packs, rows: rows.length, skipped: skipped.length, with_state: withState, ambiguous: ambiguous.size },
    rows,
    predictions: arms,
    scores,
    by_subset: Object.fromEntries(Object.keys(arms).map((k) => [k, splitScore(k)])),
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "nomination-context.json"), JSON.stringify(artifact, null, 2), "utf-8");

  const pctArm = (k: string): string => pct(scores[k]!.correct, rows.length);
  const L: string[] = [];
  L.push("# S0-v2 上下文实验：把页面状态补进题面");
  L.push("");
  L.push(`- 生成：${artifact.generated_at} ｜ provider：**${identity!.name} ${identity!.version}**`);
  L.push(`- 语料：${packs} 包 / ${rows.length} 步（跳过 ${skipped.length}；带页面状态 ${withState}；歧义组 ${ambiguous.size} 行）`);
  L.push("- 设计：与 S0 **同一语料/同一真值/同一闭集/同一问法**，唯一变量 = 题面里有没有页面上下文");
  L.push("");
  L.push("| 臂 | 正确率 | 歧义组（同一句话跨应用不同真值） | 非歧义组 | 说明 |");
  L.push("|---|---|---|---|---|");
  const lineOf = (k: string, note: string): string => {
    const sp = splitScore(k);
    return `| ${k} | ${pctArm(k)} | ${pct(sp.amb.correct, sp.amb.n)} | ${pct(sp.clear.correct, sp.clear.n)} | ${note} |`;
  };
  L.push(lineOf("first-candidate", "永远答 click（零智能基线）"));
  L.push(lineOf("rules", "① 关键词梯级"));
  L.push(lineOf("nostate", "复现 S0 的『猜』臂：state 只有 goal"));
  L.push(lineOf("context", "**补页面状态**：url/title/正文摘要/控件能力摘要"));
  L.push(lineOf("context-candidates", "上下文 + 候选描述带本页可用性"));
  L.push(lineOf("laya-context", `本地 laya 带同一份上下文（${layaStatus}）`));
  L.push("");
  const ctx = scores["context"]!;
  const ns = scores["nostate"]!;
  const base = scores["first-candidate"]!.correct;
  L.push("## 读数（只报告，不裁定）");
  L.push("");
  L.push(`- **缺口→补齐**：nostate ${ns.correct}/${rows.length} → context ${ctx.correct}/${rows.length}`
    + `（+${ctx.correct - ns.correct}）⇒ ${ctx.correct > ns.correct ? "页面上下文有增益" : "没有增益"}`);
  L.push(`- **对基线**：context ${ctx.correct} vs first-candidate ${base}`
    + ` ⇒ ${ctx.correct > base ? "**高于**零智能基线" : "仍不高于零智能基线"}`);
  L.push(`- **歧义组是试金石**：context 在歧义组 ${pct(splitScore("context").amb.correct, splitScore("context").amb.n)}，`
    + `nostate 在歧义组 ${pct(splitScore("nostate").amb.correct, splitScore("nostate").amb.n)}`);
  L.push(`- 咨询代价：${Object.entries(asksOf).map(([k, v]) => `${k} ${v.asks} 次/${(v.totalMs / 1000).toFixed(1)}s`).join("；")}`);
  L.push("");
  L.push("## 口径边界（诚实清单）");
  L.push("");
  L.push("- 真值仍是 **trace 首个 DOM 动作**（S0 同口径）：上下文能消除『同一句话跨实现』的歧义，"
    + "但不能修复『多动作步只取第一动作』的标签错位——那部分要改标签口径（见 NOMINATION_QUESTION_SET_ANALYSIS §4）。");
  L.push("- 页面状态是**只读摘要**（正文 240 字 + 控件分组），不是完整 DOM；信息量是「能给到多少」的近似，不是上限。");
  L.push("- 单次运行、单服务版本；网络臂不进 CI。");
  L.push("");
  L.push(`复算：\`TOKEN_PLAN_ENDPOINT=… TOKEN_PLAN_API_KEY=… node --experimental-strip-types tools/instruction_nomination.ts --context --provider ${providerName}\``);
  const report = L.join("\n");
  fs.writeFileSync(path.join(outDir, "REPORT.md"), report, "utf-8");
  console.log("\n" + report);
  return 0;
}

async function main(): Promise<number> {
  // rc 文件坏 = 配置类用法错误：在任何腿出场之前逐行点名并 exit 2（src/support/rcfile.ts）。
  { const rc = applyRcToEnv(); if (rc.errors.length) { for (const e of rc.errors) console.error(e); return 2; } }
  const argv = process.argv.slice(2);
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const providerName = get("provider");
  const contextMode = argv.includes("--context");
  const defaultOut = contextMode
    ? path.join(import.meta.dirname, "..", "bench", "instruction-nomination-context")
    : providerName
      ? path.join(import.meta.dirname, "..", "bench", "instruction-nomination-online")
      : path.join(import.meta.dirname, "..", "bench", "instruction-nomination");
  const outDir = path.resolve(get("out") ?? defaultOut);
  const limit = Math.max(1, Number(get("limit") ?? 10_000));
  if (contextMode) {
    if (!providerName) {
      console.error("--context 需要 --provider <name>（上下文实验要一个决策 provider）");
      return 2;
    }
    return argv.includes("--check")
      ? checkContextReview(outDir, providerName)
      : runContextReview(outDir, providerName, limit);
  }
  if (providerName) {
    return argv.includes("--check")
      ? checkProviderReview(outDir, providerName)
      : runProviderReview(outDir, providerName, limit);
  }
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
  const scores = Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, scoreArm(rows, v)]));

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
