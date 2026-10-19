/**
 * 架构与语料的**计量单一出处**：
 * `node --experimental-strip-types tools/arch-metrics.ts [--out docs/arch-metrics.json] [--check] [--tests N]`
 *
 * 为什么需要它：本轮独立复核在**同一份仓库**里抓到 7 处过期/口径不一的数字
 * （测试 1061 vs 1068、`bindings` 17 vs 20、语料 180/190/191/192 四个分母、
 * "61% 机械行"是 15 包时代的旧数、基线 ~240 s 实际 160.7 s、"0 代码行"排除了 `bin/` 的 93 行、
 * 阶段编号 P3 在两份文档里指两件事）。它们不是"写错"，是**同一个数被抄在多处**。
 * 本工具把能算的全部算出来、把算不出来的**标明来源**，写进 `docs/arch-metrics.json`：
 * 图、文档、套件从这一份读，别再各抄一份。
 *
 * 三条纪律：
 * 1. **能算的绝不手写**（语料结构、声明覆盖、行数、模型出场都从仓库与产物里读出来）；
 * 2. **算不出来的写"未测"并注明需要的命令**（例如测试条数要靠 `npx vitest list`，
 *    静态数 `it(` 只有 799 而实际 1068——参数化/循环用例数不出来，所以不接受"估一个"）；
 * 3. **每个数带口径**（`when/retries/next` 两套分母、`hint 覆盖` 的分子分母是什么，
 *    都写进 JSON 的 `note`，避免下一个人再把两个分母混着比）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPacks, loadPack, packHintCoverage } from "../src/app-pack.ts";

// `URL.pathname` keeps the leading slash on Windows ("/E:/…") and path.resolve then
// doubles the drive ("E:\E:\…") — fileURLToPath is the only correct conversion.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
};

const nonEmpty = (s: string): number => s.split("\n").filter((l) => l.trim()).length;
const readJson = (p: string): Record<string, unknown> | null => {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>; } catch { return null; }
};

/* ── ① 语料结构：能算的全算 ─────────────────────────────────────────────── */
interface Corpus {
  app_dirs: number;
  packs_with_journey: number;
  journey_entries: number;
  browser_steps: number;
  tool_steps: number;
  steps_naming_target: number;
  hint_coverage: { hinted: number; named: number; browser: number; pct: number };
  hint_coverage_browser: string;
  hint_coverage_with_flow: string;
  flow_apps: number;
  flow_steps: number;
  declared_lines: { pack: number; flow: number; profile: number; total: number };
  journey_roles_lines: { lines: number; of_pack_lines: string };
  bin_fixture_lines: number;
  /**
   * **声明面的发散度**（§6 的前提：不能计数的东西没法归并）。
   * 同一个意图（"填一个字段再提交"）今天有三条写法：拆成两个子目标 + URL 深链 /
   * `target_hints`（有序点名）/ `commands`（命令闭集）。这里数的是**每种写法被用了几次、
   * 在几个包里**，以及有多少包同时用了不止一种。
   */
  surfaces: {
    multi_action_packs: number;
    target_hints_steps: number;
    commands_packs: number;
    commands_decls: number;
    deep_link_steps: number;
    packs_using_more_than_one: string[];
    note: string;
  };
  declarations: {
    when: number; retries: number; next: number;
    all_journey_entries: string;
    split_roles_plus_entries: string;
    note: string;
  };
}

function corpus(): Corpus {
  const appsDir = path.join(REPO, "apps");
  let packLines = 0, flowLines = 0, profileLines = 0, binLines = 0;
  let packs = 0, journeyEntries = 0, browser = 0, tool = 0, hinted = 0, jrLines = 0, namedTotal = 0;
  let flowApps = 0, flowSteps = 0;
  let hintsSteps = 0, cmdDecls = 0, urlStateSteps = 0;
  const cmdPackSet = new Set<string>();
  const multiActionPacks = new Set<string>();
  const usingMoreThanOne: string[] = [];
  let whenMerged = 0, retriesMerged = 0, nextMerged = 0;       // 口径①：合并后、只看浏览器步
  let whenAll = 0, retriesAll = 0, nextAll = 0;                // 口径②：合并后、全部 journey 条目（含工具步）
  let whenSplit = 0, retriesSplit = 0, nextSplit = 0;          // 口径③：角色模板与 journey 条目分开数
  const hintOf = (m: Record<string, unknown>): unknown =>
    Array.isArray(m["target_hints"]) ? (m["target_hints"] as unknown[])[0] : m["target_hint"];
  const countDecl = (m: Record<string, unknown>, merged: boolean): void => {
    if (m["when"]) { if (merged) whenMerged++; else whenSplit++; }
    if (m["retries"]) { if (merged) retriesMerged++; else retriesSplit++; }
    if (m["next"]) { if (merged) nextMerged++; else nextSplit++; }
  };

  for (const id of fs.readdirSync(appsDir)) {
    const dir = path.join(appsDir, id);
    const packPath = path.join(dir, "pack.json");
    const flowPath = path.join(dir, "flow.json");
    if (fs.existsSync(packPath)) {
      packs++;
      packLines += nonEmpty(fs.readFileSync(packPath, "utf-8"));
      const pack = loadPack(packPath) as unknown as Record<string, unknown>;
      // 覆盖率走单一实现 `packHintCoverage`（套件/matrix/图共用同一口径），本地不再数一遍。
      const cov = packHintCoverage(pack as never);
      browser += cov.browser; hinted += cov.hinted; tool += cov === undefined ? 0 : 0;
      namedTotal += cov.named;
      const roles = (pack["roles"] ?? {}) as Record<string, Record<string, unknown>>;
      const journey = (pack["journey"] ?? []) as Array<Record<string, unknown>>;
      jrLines += nonEmpty(JSON.stringify({ roles: pack["roles"] ?? {}, journey }, null, 2));
      for (const [, r] of Object.entries(roles)) countDecl(r, false);          // 口径③：角色模板单独数
      let packHints = 0, packCmds = 0;
      for (const e of journey) {
        journeyEntries++;
        const merged: Record<string, unknown> = e["role"] ? { ...(roles[String(e["role"])] ?? {}), ...e } : e;
        countDecl(merged, false);                                             // 口径③：journey 合并后也数一遍
        if (e["source"]) tool++;                                             // 工具步：没有 DOM 目标
        // browser/hinted/named 由 packHintCoverage 数（见上），这里不再重复一份口径
        // §6 发散度：一个步同时算进它用到的每一种"多动作写法"
        if (Array.isArray(merged["target_hints"]) && (merged["target_hints"] as unknown[]).length > 1) {
          hintsSteps++; packHints++;
        }
        if (Array.isArray(merged["commands"]) && (merged["commands"] as unknown[]).length > 0) {
          cmdDecls += (merged["commands"] as unknown[]).length;
          cmdPackSet.add(id); packCmds++;
        }
        // 注意：URL 带查询参数**不是**"多动作的另一种写法"——那是红线①（状态进 URL）的纪律，
        // 几乎每一步都这样。把它算进发散度会得出一个吓人或安慰人的假数，所以单列。
        if (/[?&](selected|sort|window|cap|date|q)=/.test(String(merged["start_url"] ?? ""))) urlStateSteps++;
        if (merged["when"]) whenAll++;                                        // 口径②：合并后、全部条目
        if (merged["retries"]) retriesAll++;
        if (merged["next"]) nextAll++;
        if (!e["source"]) countDecl(merged, true);                            // 口径①：合并后的浏览器步
      }
      // 发散度只算**真的两种多动作写法**：有序点名 vs 命令闭集。
      const kinds = [packHints > 0, packCmds > 0].filter(Boolean).length;
      if (packHints > 0 || packCmds > 0) multiActionPacks.add(id);
      if (kinds > 1) usingMoreThanOne.push(`${id}(target_hints + commands)`);
    }
    if (fs.existsSync(flowPath)) {
      flowApps++;
      flowLines += nonEmpty(fs.readFileSync(flowPath, "utf-8"));
      const flow = readJson(flowPath) as { steps?: unknown[] } | null;
      flowSteps += (flow?.steps ?? []).length;
    }
    const sites = path.join(dir, "sites");
    if (fs.existsSync(sites)) {
      for (const f of fs.readdirSync(sites)) {
        if (f.endsWith(".json")) profileLines += nonEmpty(fs.readFileSync(path.join(sites, f), "utf-8"));
      }
    }
    const bin = path.join(dir, "bin");
    if (fs.existsSync(bin)) {
      for (const f of fs.readdirSync(bin)) {
        if (/\.[cm]?js$/.test(f)) {
          const txt = fs.readFileSync(path.join(bin, f), "utf-8");
          binLines += txt.split("\n").length - 1;                             // 总行数（含空行），与"非空"区分
        }
      }
    }
  }

  return {
    app_dirs: fs.readdirSync(appsDir).length,
    packs_with_journey: packs,
    journey_entries: journeyEntries,
    browser_steps: browser,
    tool_steps: tool,
    steps_naming_target: hinted,
    hint_coverage: {
      hinted, named: namedTotal, browser, pct: Math.round((100 * hinted) / browser * 10) / 10,
    },
    hint_coverage_browser: `${hinted}/${browser} = ${((100 * hinted) / browser).toFixed(1)}%`,
    hint_coverage_with_flow: `${hinted + 0}/${browser + flowSteps} = ${((100 * hinted) / (browser + flowSteps)).toFixed(1)}%（+2 个语义流模板的 ${flowSteps} 步，设计上零 hint）`,
    flow_apps: flowApps,
    flow_steps: flowSteps,
    declared_lines: { pack: packLines, flow: flowLines, profile: profileLines, total: packLines + flowLines + profileLines },
    journey_roles_lines: { lines: jrLines, of_pack_lines: `${((100 * jrLines) / packLines).toFixed(1)}%` },
    bin_fixture_lines: binLines,
    surfaces: {
      multi_action_packs: multiActionPacks.size,
      target_hints_steps: hintsSteps,
      commands_packs: cmdPackSet.size,
      commands_decls: cmdDecls,
      deep_link_steps: urlStateSteps,
      packs_using_more_than_one: usingMoreThanOne,
      note: "§6 的前提：不能计数就没法归并。多动作意图今天有两种写法"
        + "（target_hints 有序点名 / commands 命令闭集）；deep_link_steps 是**红线①（状态进 URL）**"
        + "的纪律，不是多动作写法，单列以免被误读成发散度。",
    },
    declarations: {
      when: whenMerged, retries: retriesMerged, next: nextMerged,
      all_journey_entries: `${whenAll}/${retriesAll}/${nextAll}`,
      split_roles_plus_entries: `${whenSplit}/${retriesSplit}/${nextSplit}`,
      note: `三套分母都真实，引用时必须写明是哪一套：`
        + `① 合并后只看浏览器步 = ${whenMerged}/${retriesMerged}/${nextMerged}（本文件头条）；`
        + `② 合并后全部 journey 条目（含 ${tool} 个工具步）= ${whenAll}/${retriesAll}/${nextAll}；`
        + `③ 角色模板与 journey 条目分开数（同一条声明可能各数一次）= ${whenSplit}/${retriesSplit}/${nextSplit}`,
    },
  };
}

/* ── ② 模型与梯级：读套件产物，按层级认臂 ───────────────────────── */

/** 一臂的统计。层级由产物自己说（`model_status`），不由目录名猜。 */
interface ArmStats {
  apps: number; trace_steps: number; choice_asks: number; passed: number;
  reobserve: number; escalate: number; rule_match: number; secs: number; tier: string;
}
interface ArmResult { note?: string; stats?: ArmStats }

interface ModelMetrics {
  tier: string;
  /** 默认臂（真模型）：读 `/tmp/amberflow-suite`，只认 `model_status === "on"` 的产物。 */
  real_model_corpus: ArmResult;
  /** 消融臂：读 `/tmp/amberflow-suite-ablate`；没跑过就是"未测"。 */
  ablation_corpus: ArmResult;
  harness: {
    judged: number; top1: string; floor025_precision: string; auc_all: number;
    passthrough: string; shortlist: string;
    /** 源产物（/tmp/model-contribution.json）不在时，这份是**沿用上一次的快照**——标出来，
     *  免得刷新命令在 /tmp 冷的时候把 15 分钟模型跑的数悄悄清成"未测"、连带打爆图门禁。 */
    carried?: string;
    numeric: {
      judged: number; top1_pct: number; latin_pct: number; cjk_pct: number; precision025_pct: number;
      auc_all: number; passthrough_auc: number; shortlist_auc: number;
      passthrough_adopted: number; passthrough_right: number; shortlist_adopted: number; shortlist_right: number;
    };
  } | { note: string };
  ladder: { note: string };
}

/**
 * 读一个套件产物目录。**按层级认臂，不按目录名认**：
 * 目录里混进另一臂的产物时宁可跳过并留 note，也不要拿真模型的 754.8 s 去填"脚本桩基线"
 * 那种字段——本轮真的差点这么干了（默认臂改成真模型之后，旧字段名就开始说谎）。
 */
function readArm(dir: string, want: "on" | "ablate"): ArmResult {
  if (!fs.existsSync(dir)) {
    return { note: `未测：没有 ${dir}（跑 npm run apps:suite${want === "ablate" ? " -- --ablate" : ""}）` };
  }
  const acc: ArmStats = {
    apps: 0, trace_steps: 0, choice_asks: 0, passed: 0,
    reobserve: 0, escalate: 0, rule_match: 0, secs: 0, tier: want === "on" ? "on" : "ablation",
  };
  let skipped: string | null = null;
  for (const d of fs.readdirSync(dir)) {
    const r = readJson(path.join(dir, d, `${d}-result.json`)) as Record<string, any> | null;
    if (!r) continue;
    const tier = String(r.model_status ?? "");
    const isReal = tier === "on";
    if (isReal !== (want === "on")) {
      skipped = skipped ?? (tier || "(无层级)");
      continue;
    }
    const dec = (r.decisions ?? {}) as Record<string, any>;
    acc.apps += 1;
    acc.trace_steps += Number(dec.total_steps ?? 0);
    acc.choice_asks += Number(dec.model_asks ?? 0);
    acc.passed += Number(dec.model_steps ?? 0);
    acc.reobserve += Number(dec.reobserve ?? 0);
    acc.escalate += Number(dec.escalate ?? 0);
    acc.rule_match += Number(dec.by_method?.["rule:match"] ?? 0);
    acc.secs += Number(r.secs ?? 0);
  }
  acc.secs = Math.round(acc.secs * 10) / 10;
  if (acc.apps === 0) {
    return { note: `未测：${dir} 里没有属于本臂（want=${want}）的产物${skipped ? `（跳过了 ${skipped} 的）` : ""}` };
  }
  return skipped ? { stats: acc, note: `跳过了层级为 ${skipped} 的产物` } : { stats: acc };
}

function modelMetrics(): ModelMetrics {
  const mc = readJson("/tmp/model-contribution.json") as { summary?: Record<string, any> } | null;
  // 源产物不在时**沿用上一次的 harness 快照**（而不是清成"未测"）：harness 是一次 15 分钟
  // 真模型跑的冻结数，`npm run metrics` 不重跑它；把它清空会让依赖这些字段的架构图
  // 在 /tmp 冷的时候无法生成（实测踩过：刷新一次 metrics，v1/v2 图门禁同时红）。
  // 只有从没有过快照（committed 里也没有完整 harness）才落"未测"。
  const committed = readJson(path.join(REPO, "docs", "arch-metrics.json")) as
    { model?: { harness?: ModelMetrics["harness"] } } | null;
  const carriedHarness = committed?.model?.harness && "numeric" in committed.model.harness
    ? { ...committed.model.harness,
        carried: "沿用上一次的快照（/tmp/model-contribution.json 不在；重跑：npm run model:contribution -- --out /tmp/model-contribution.json）" }
    : null;
  let harness: ModelMetrics["harness"] = carriedHarness
    ?? { note: "未测：跑 `npm run model:contribution -- --out /tmp/model-contribution.json`（真模型，约 15 分钟）" };
  if (mc?.summary) {
    const s = mc.summary as Record<string, any>;
    const pt = s.by_question_shape.passthrough_pool_le_8;
    const sl = s.by_question_shape.shortlist_pool_gt_8;
    const branch = (b: Record<string, any>): string =>
      `n=${b.steps} 命中 ${b.accuracy === null ? "-" : `${Math.round(b.accuracy * 100)}%`}`
      + ` ｜ floor0.25 采纳 ${b.decided_at_floor_025}（对 ${b.right}）｜ AUC ${b.auc_conf_vs_correct}`;
    const f25 = s.floor_sweep.find((f: any) => f.floor === 0.25);
    harness = {
      judged: s.judged,
      top1: `${Math.round(s.top1_accuracy * 100)}%`,
      floor025_precision: `${Math.round(f25.precision * 100)}%`,
      auc_all: s.conf.auc_conf_vs_correct,
      passthrough: branch(pt), shortlist: branch(sl),
      numeric: {
        judged: s.judged, top1_pct: Math.round(s.top1_accuracy * 100),
        latin_pct: Number(String(s.accuracy_latin_pages).match(/\((\d+)%\)/)?.[1] ?? 0),
        cjk_pct: Number(String(s.accuracy_cjk_pages).match(/\((\d+)%\)/)?.[1] ?? 0),
        precision025_pct: Math.round(f25.precision * 100),
        auc_all: s.conf.auc_conf_vs_correct,
        passthrough_auc: pt?.auc_conf_vs_correct ?? null, shortlist_auc: sl?.auc_conf_vs_correct ?? null,
        passthrough_adopted: pt?.decided_at_floor_025 ?? null, passthrough_right: pt?.right ?? null,
        shortlist_adopted: sl?.decided_at_floor_025 ?? null, shortlist_right: sl?.right ?? null,
      },
    };
  }
  return {
    tier: fs.existsSync("/tmp/laya_dec.onnx") ? "on（/tmp/laya_dec.onnx 在位）" : "off(missing)",
    real_model_corpus: readArm("/tmp/amberflow-suite", "on"),
    ablation_corpus: readArm("/tmp/amberflow-suite-ablate", "ablate"),
    harness,
    ladder: {
      note: "梯级出场以 real_model_corpus 为准；0 表示该级在已验收语料上从未独立决定任何东西（不是『没测』）",
    },
  };
}


// 已入库的快照：`--tests`/model-contribution 缺席时，tests/model 段沿用上一次的值（标 carried），
// 而不是清成"未测"——否则裸跑 `npm run metrics` 会在 /tmp 冷的时候把架构图依赖的字段抹掉，
// 让 `--check` 门禁红（2026-10-14 实测踩过：刷新一次 metrics，v1/v2 图同时无法生成）。
const committedDoc = readJson(path.join(REPO, "docs", "arch-metrics.json")) as
  { tests?: { count?: number | null } } | null;

const metrics = {
  generated_by: "tools/arch-metrics.ts",
  /** 快照时间：`corpus` 段是仓库算出来的（永远新鲜），`model`/`tests` 是外部产物快照（会过期）。 */
  generated_at: new Date().toISOString().slice(0, 10),
  provenance: {
    corpus: "仓库实时计算（--check 的门只比这一段）",
    model: "外部快照：/tmp 下的真模型跑批产物；换机器或重跑就会变，引用时看 generated_at",
    // 口径 2026-10-14 修正：`vitest list | wc -l` 会把**多行用例名**数成多行（实测一条
    // 用例名换行 ⇒ 1132 ≠ 运行器报的 1131）。只数每条用例开头的 `(tests|integrations)/` 行。
    tests: "外部快照：`npx vitest list | grep -cE \"^(tests|integrations)/\"`（静态数 it( 只有 799，不可用；wc -l 会把多行用例名数成多行）",
  },
  note: "本文件是计量单一出处：能算的自动算，算不出来的写 note 并注明需要的命令；每个数带口径。",
  corpus: corpus(),
  model: modelMetrics(),
  tests: argOf("--tests")
    ? { count: Number(argOf("--tests")), source: "--tests（应来自 `npx vitest list | grep -cE \"^(tests|integrations)/\"`；静态数 `it(` 只有 799，不可用）" }
    : committedDoc?.tests?.count != null
      ? { count: committedDoc.tests.count, source: "沿用上一次的快照（未给 --tests；重算：`npx vitest list | grep -cE \"^(tests|integrations)/\"` 再 `--tests N`）" }
      : { count: null, source: "未测：`npx vitest list | grep -cE \"^(tests|integrations)/\"`（静态数不出参数化用例）" },
};

const OUT = argOf("--out") ?? path.join(REPO, "docs", "arch-metrics.json");
const body = JSON.stringify(metrics, null, 2) + "\n";

if (args.includes("--check")) {
  // 只比**仓库能算出来的那部分**（corpus）：model 段是产物快照（/tmp 里的真模型跑批与逐题实测），
  // tests.count 要靠 `npx vitest list` 刷新——那两段进不了 CI（换台机器就是另一批产物），
  // 拿它们做门会让"没跑过模型"直接变红，那就不是漂移门而是噪声门了。
  const cur = readJson(OUT) as { corpus?: unknown } | null;
  if (!cur) {
    console.error(`计量缺失：${OUT} 不存在（先跑一次本工具）`);
    process.exit(1);
  }
  const same = JSON.stringify(cur.corpus) === JSON.stringify(metrics.corpus);
  if (!same) {
    console.error("语料计量漂移：" + OUT + " 的 corpus 段与本次计算结果不一致"
      + "（改了 apps/ 的语料就重跑 node --experimental-strip-types tools/arch-metrics.ts）");
    process.exit(1);
  }
  console.log(`语料计量与计算一致：${OUT}（model/tests 两段是快照，不参与本门）`);
  process.exit(0);
}

fs.writeFileSync(OUT, body);
const c = metrics.corpus;
console.log(`语料：${c.packs_with_journey} 个包 / ${c.journey_entries} 个 journey 条目`
  + `（浏览器 ${c.browser_steps} + 工具 ${c.tool_steps}）｜点名目标 ${c.steps_naming_target} = ${c.hint_coverage_browser}`);
console.log(`声明行 ${c.declared_lines.total}（pack ${c.declared_lines.pack} + flow ${c.declared_lines.flow} + profile ${c.declared_lines.profile}）`
  + `｜journey+roles 占 pack 行 ${c.journey_roles_lines.of_pack_lines}｜bin/ 夹具 ${c.bin_fixture_lines} 行`);
console.log(`容错声明：when ${c.declarations.when} / retries ${c.declarations.retries} / next ${c.declarations.next}`
  + `（合并后浏览器步口径；另一套分母见 JSON 的 note）`);
console.log(`模型：层级 ${metrics.model.tier} ｜ 真模型臂 ${JSON.stringify(metrics.model.real_model_corpus)}`
  + ` ｜ 消融臂 ${JSON.stringify(metrics.model.ablation_corpus)}`);
console.log(`测试：${metrics.tests.count ?? "未测"}（${metrics.tests.source}）`);
console.log(`写出 ${OUT}`);
