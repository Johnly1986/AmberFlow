/**
 * **应用套件** —— 一条命令跑完所有"旅程型应用"的验收，回答"所有应用是不是都完成了"。
 *
 *   npm run apps:suite [-- --only <id,id>] [--json]
 *
 * 为什么需要它：`apps:matrix` 度量的是**声明**（多少角色/步骤/不变量、几行代码、有没有泄漏），
 * 那是静态的；这份清单是**动态的**——每个应用真的跑一遍它自己的旅程，逐条报 步骤/不变量/退出码。
 * 于是"完成所有应用"从一句承诺变成一个可复现的退出码。
 *
 * 口径（与各应用验收命令一致，只是省掉网络与 1.7GB 权重）：
 *   - 只跑**有 journey** 的应用；纯测量型应用（只声明 probe）跳过并注明（它们要真网络）；
 *   - 一律 `sources: false`（数据腿要网络/外部工具的单独跑）+ 脚本模型（离线、确定性）；
 *   - 需要真工具的包（如 `repo-report` 用 git/jq）如果工具缺失，会以 `tool-unavailable` 如实报失败，
 *     而不是被跳过——**"没验证"必须是可见的**。
 *
 * 每行还报**模型出场**三组数（LAYA_VALUE_PLAN P1：出场率 / 挽回 / 缓存）。口径有两个出处，各有
 * 道理：**过关数在 trace 里数**（`method` 为 laya/laya:reobserve），**咨询数在运行时缝上数**
 * （`countingRuntime`）——低置信 break 的那次咨询不在 trace 留 `method`，只按 trace 数会把
 * `transfer-slowjet` 的在场漏报成零出场。`slowjet 咨询 ≥1 而 demo-app = 0` 是同一张表要同时讲的
 * 两句真话：规则消化了绝大多数，但没有模型时 slowjet 会红。"零出场"也写成卖点
 * （`model not needed`），不是难看。每个应用的完整结果落 `<套件目录>/<app>/<app>-result.json`，
 * `apps:matrix` 的"模型咨询/reobserve"两列读的就是这份**上一次真跑**的产物——没有跑过的应用
 * 显示"未跑"，绝不编数。
 */
import path from "node:path";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { appDirs, loadPack, packHintCoverage, type AppPack } from "../src/app-pack.ts";
import { runApp, refusalLine, type AppRunResult } from "../src/app-runner.ts";
import { withDecisionCache, type CachedRuntime, type DecisionCacheStats } from "../src/decision-cache.ts";
import { countingRuntime, installLayaRuntime, scriptedAgent, scriptedRuntime, type CountingRuntime } from "../src/model.ts";

/** 套件产物目录：matrix 的运行时两列从这里读（单一出处、**调用时**读 env，测试可隔离）。 */
export function suiteOutDir(): string {
  return process.env.AMBERFLOW_SUITE_OUT ?? path.join("/tmp", "amberflow-suite");
}

export type SuiteStatus = "passed" | "needs-dangerous-opt-in" | "failed";

export interface SuiteRow {
  app: string;
  steps: number;
  completed: string;
  skipped: number;
  invariants: string;
  status: SuiteStatus;
  secs: number;
  note?: string;
  /** 模型被咨询的决策数（含没过置信闸门的——"保险碰没碰过"看这个）。 */
  model_asks: number;
  /** 过关并执行的模型步（trace `method` 为 laya/laya:reobserve）；脚本模型下通常 0。 */
  model_steps: number;
  /** 模型步的最高 conf（出场率一行里的小尾巴；没有出场为 null）。 */
  conf_max: number | null;
  /** 加宽重看救回的步数（`laya:reobserve`）。 */
  reobserve: number;
  /** 规则/hint 级决定的步数（梯级账单用；来自 decisions.by_method["rule:match"]）。 */
  rule_steps: number;
  /** escalate 级决定的步数（LLM 老师点名；没有端点时恒 0，正是要暴露的那种 dead rung）。 */
  escalate: number;
  /** 浏览器步里点名了目标的比例（§W2：hint 是承重墙这件事要每天看得见，不是审查时才数）。 */
  hint_hinted: number;
  hint_browser: number;
  /** 本次运行期间决策缓存省下的重复提问（增量，不是进程累计）。 */
  cache_saved: number;
}

/**
 * 这个应用的旅程是不是**线上**的（要真网络）？
 *
 * 判据是结构性的，不是人肉清单：离线应用的 `start_url` 是仓库相对路径（运行器解析成 `file://`），
 * 只要有一个绝对 `http(s)://` 的 `start_url`，这条旅程就要真网络。于是新增一个线上应用不需要
 * 记得去改套件的跳过名单——它自己会被认出来，并且**明着报告"没跑"**，而不是被悄悄算绿。
 */
export function isLive(pack: AppPack): boolean {
  const steps = [...Object.values(pack.roles ?? {}), ...pack.journey] as Array<Record<string, unknown>>;
  return steps.some((st) => typeof st["start_url"] === "string" && /^https?:\/\//.test(String(st["start_url"])));
}

/** 跑一个应用包（离线口径）。返回值就是套件表格里的一行；完整结果另落 `<套件目录>/<app>/` 供 matrix 读。 */
export async function runOne(
  pack: AppPack, cached: CachedRuntime, counted: CountingRuntime, outBase = suiteOutDir(),
): Promise<SuiteRow> {
  const hints = packHintCoverage(pack);          // §W2：承重墙每天看得见
  const out = path.join(outBase, pack.id);
  fs.mkdirSync(out, { recursive: true });
  const before = cached.decisionStats();
  const asksBefore = counted.pickAsks();
  const res: AppRunResult = await runApp(pack, {
    verbose: false, sources: false, outDir: out, planPath: path.join(out, "plan.json"),
    // 套件的口径 = 脚本模型：层级如实写，不冒充真 ONNX。咨询数从运行时缝上数——
    // "哪一步本该问模型"与"模型此刻是谁"是两个问题，seam 回答前者、trace 回答后者。
    modelStatus: "off(scripted)",
    // 报**本次运行的增量**：套件一个进程跑所有应用，累计值会把前一个应用的命中算进来。
    runtimeStats: () => {
      const after = cached.decisionStats();
      return { hits: after.hits - before.hits, misses: after.misses - before.misses, entries: after.entries };
    },
    pickAsks: () => counted.pickAsks() - asksBefore,
  });
  fs.writeFileSync(path.join(out, `${pack.id}-result.json`), JSON.stringify(res, null, 2), "utf-8");
  const steps = res.subgoals.length + res.tool_steps.length;
  const skipped = res.subgoals.filter((s) => s.status === "skipped").length;
  const held = res.invariants.filter((i) => i.held).length;
  // 危险步被拒**不是失败也不是通过**：套件没有放行不可逆动作的权限（那是 --allow-dangerous 的事），
  // 所以它如实记成"需显式放行，本次未执行"。绿色的前提永远是真的执行过。
  const refusals = res.tool_steps.filter((t) => !t.done).map((t) => t.refused);
  const onlyDangerous = !res.ok && refusals.length > 0 && refusals.every((r) => r === "dangerous");
  const status: SuiteStatus = res.ok ? "passed" : onlyDangerous ? "needs-dangerous-opt-in" : "failed";
  const d = res.decisions!;
  return {
    app: pack.id,
    steps,
    completed: res.completed,
    skipped,
    invariants: `${held}/${res.invariants.length}`,
    status,
    secs: res.secs,
    ...(onlyDangerous
      ? { note: refusalLine("dangerous") } : {}),
    model_asks: d.model_asks,
    rule_steps: d.ladder?.rule ?? 0, escalate: d.ladder?.escalate ?? 0,
    hint_hinted: hints.hinted, hint_browser: hints.browser,
    model_steps: d.model_steps,
    conf_max: d.conf.max,
    reobserve: d.reobserve,
    cache_saved: d.cache?.hits ?? 0,
  };
}

/**
 * 套件的退出码规则（抽成纯函数是为了能被测到——"边际为 0 不许算绿"这条判据本身也得有回归）。
 *
 * 优先级 `1 > 3 > 4` 的理由：**没真执行完的运行不配被判定"模型有没有用"**。
 * 所以有未通过先 1；有危险步未放行先 3；只有"全都真执行且通过"时，才轮到问
 * "那模型独立决定了什么？"——答案是 0 就是 4（§7/W2）。
 */
export function suiteExitCode(a: {
  failed: number; pending: number; tierOn: boolean; marginal: number;
}): number {
  if (a.failed > 0) return 1;
  if (a.pending > 0) return 3;
  if (a.tierOn && a.marginal === 0) return 4;
  return 0;
}

export async function suite(
  only: string[] = [], opts: { realModel?: boolean } = {},
): Promise<{
  rows: SuiteRow[]; skipped: string[]; unmatched: string[]; known: string[];
  /** 整个套件一进程的决策缓存账（命中=省下的重复提问）。 */
  cache: DecisionCacheStats;
  /** 这一臂跑在哪个模型层级（`on` = 真 ONNX；`off(scripted)` = 桩）。 */
  tier: string;
}> {
  // 两层包装：缓存记"省下的重复提问"（零成本率），外层计数记"模型被咨询几次"（出场率）——
  // 命中也是一次咨询，所以计数在缓存外面。laya 是确定性的，同问不重答。
  // §7/W2：`--real-model` 显式换真模型那一臂（CI 默认仍是桩：不把 1.7 GB 权重塞进 CI）。
  const inner = opts.realModel
    ? (await import("../src/laya-onnx.ts")).createLayaOnnxRuntime() as never
    : scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 })));
  const cached = withDecisionCache(inner);
  const counted = countingRuntime(cached);
  installLayaRuntime(counted);
  const rows: SuiteRow[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  try {
    for (const dir of appDirs()) {
      const name = path.basename(dir);
      // **逐应用容错**：一个坏包/坏目录只该影响它自己那一行。以前 loadPack 在 try 之外，
      // 一个加载失败会掀掉整张表——包括已经跑完的十几行（实测：198s 的工作换来一张空表）。
      let pack: AppPack;
      try {
        pack = loadPack(path.join(dir, "pack.json"));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!only.length || only.includes(name)) {
          rows.push({
            app: name, steps: 0, completed: "0/0", skipped: 0, invariants: "-",
            status: "failed", secs: 0, note: `加载失败：${msg}`,
            model_asks: 0, model_steps: 0, conf_max: null, reobserve: 0, cache_saved: 0, rule_steps: 0, escalate: 0, hint_hinted: 0, hint_browser: 0,
          });
        }
        continue;
      }
      seen.add(pack.id);
      if (only.length && !only.includes(pack.id)) continue;
      if (!Array.isArray(pack.journey) || pack.journey.length === 0) {
        skipped.push(`${pack.id}（测量型应用：只声明 probe，要真网络）`);
        continue;
      }
      if (isLive(pack)) {
        skipped.push(`${pack.id}（线上旅程：start_url 是 http(s)，要真网络）`);
        continue;
      }
      try {
        rows.push(await runOne(pack, cached, counted));
      } catch (e) {
        rows.push({
          app: pack.id, steps: 0, completed: "0/0", skipped: 0, invariants: "-",
          status: "failed", secs: 0, model_asks: 0, model_steps: 0, conf_max: null, reobserve: 0, cache_saved: 0, rule_steps: 0, escalate: 0, hint_hinted: 0, hint_browser: 0,
          note: `运行崩了：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  } finally {
    installLayaRuntime(null);
  }
  // `seen` 在 `--only` 过滤**之前**收集，所以它就是"已知应用"的完整名单（用来给打错字的人候选）。
  const known = [...seen].sort();
  const unmatched = only.filter((o: string) => !seen.has(o) && !rows.some((r) => r.app === o));
  return {
    rows, skipped, unmatched, known, cache: cached.decisionStats(),
    tier: opts.realModel ? "on" : "off(scripted)",
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      only: { type: "string" }, json: { type: "boolean" },
      "real-model": { type: "boolean" },
      help: { type: "boolean" }, verbose: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log("usage: apps-suite [--only id,id] [--json] [--verbose] [--real-model]\n\n"
      + "一条命令跑完所有旅程型应用的验收（离线口径）\n\n"
      + "默认臂是**脚本桩**（确定性、CI 可跑、不碰 1.7 GB 权重）；`--real-model` 换真 ONNX 那一臂。\n"
      + "退出码：0=全部真执行且通过 ｜ 1=有未通过（含加载失败） ｜ "
      + "2=用法错误（--only 未命中任何应用） ｜ 3=有\"未执行\"（危险步未放行，不算全绿） ｜ "
      + "4=真模型臂**边际为 0**（应用都过了，但模型一步也没独立决定 ⇒ \"弹性\"不成立）\n"
      + "线上/测量型应用会被明着跳过（它们要真网络），跳过不等于通过。\n"
      + "表里带模型账（咨询数 / reobserve / 页脚的缓存命中）——出场率、挽回、零成本率三组数（P1）。\n"
      + "默认只打结论表；要看逐应用日志加 --verbose。");
    return 0;
  }
  const only = (values.only ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  // 默认把逐应用日志收走：表才是结论，255 行 step 日志会把表挤到屏幕外（实测）。
  const passthrough = console.log;
  const swallowed: string[] = [];
  if (!values.verbose && !values.json) console.log = (...a: unknown[]) => { swallowed.push(a.join(" ")); };
  let out;
  try {
    out = await suite(only, { realModel: values["real-model"] === true });
  } finally {
    console.log = passthrough;
  }
  const { rows, skipped, unmatched, known, cache, tier } = out;
  const tierOn = tier === "on";
  if (unmatched.length) {
    const msg = `--only ${unmatched.map((u) => JSON.stringify(u)).join(", ")} 没有匹配任何应用。`
      + `已知应用：${known.join(", ")}`;
    console.error(msg);
    // `--json` 的调用方是脚本：用法错误也要给一个可解析的对象，而不是"exit 2 + 空 stdout"。
    if (values.json) passthrough(JSON.stringify({ error: msg, unmatched, known, exit_code: 2 }, null, 2));
    return 2;
  }
  if (values.json) {
    const code = rows.some((r) => r.status === "failed") ? 1
      : rows.some((r) => r.status === "needs-dangerous-opt-in") ? 3 : 0;
    passthrough(JSON.stringify({
      rows, skipped, cache, tier: out.tier,
      model_marginal: out.tier === "on" ? rows.reduce((n, r) => n + r.model_steps, 0) : null,
      exit_code: code,
      legend: "0=全部真执行且通过 ｜ 1=有未通过 ｜ 2=用法错误 ｜ 3=有未执行（危险步未放行） ｜ 4=真模型臂边际为 0",
    }, null, 2));
    return code;
  }
  const head = ["应用", "步骤", "完成", "跳过", "不变量", "模型咨询", "reobserve", "用时", "结论",
    "模型边际", "hint覆盖"];
  const verdict = (r: SuiteRow): string =>
    r.status === "passed"
      ? (r.steps > 0 && r.model_asks === 0 ? "通过（model not needed）" : "通过")
      : r.status === "needs-dangerous-opt-in" ? "未执行（危险步未放行）" : "**未通过**";
  // 模型边际（§7 / W2）：梯级只有低一级没决定才轮得到模型，所以"模型独立决定的步"
  // 就是它的边际贡献——不需要反事实重跑。缺省（脚本桩）下这一列没有意义，打"未测"而不是 0。
  const marginal = (r: SuiteRow): string =>
    tierOn ? String(r.model_steps) : "未测";
  const table = rows.map((r) => [r.app, String(r.steps), r.completed, String(r.skipped),
    r.invariants, `${r.model_asks}${r.conf_max !== null ? `(conf ${r.model_steps ? `✓` : r.conf_max.toFixed(2)})` : ""}`,
    String(r.reobserve), `${r.secs}s`, verdict(r), marginal(r),
    r.hint_browser ? `${r.hint_hinted}/${r.hint_browser}` : "-"]);
  const widths = head.map((h, i) => Math.max(h.length, ...table.map((r) => r[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log(line(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of table) console.log(line(r));
  for (const r of rows) if (r.note && r.status === "failed") console.log(`  - ${r.app}：${r.note}`);
  if (skipped.length) {
    console.log();
    console.log("跳过（不是豁免：它们要真网络，另有验收口径）：");
    for (const s of skipped) console.log(`  - ${s}`);
  }
  const passed = rows.filter((r) => r.status === "passed").length;
  const pending = rows.filter((r) => r.status === "needs-dangerous-opt-in");
  const failed = rows.filter((r) => r.status === "failed");
  console.log();
  console.log(`应用套件：${passed}/${rows.length} 真执行且通过`
    + (pending.length ? `，${pending.length} 个未执行` : "")
    + (failed.length ? `，${failed.length} 个未通过` : "")
    + (skipped.length ? `（另有 ${skipped.length} 个要真网络，已跳过——跳过不等于通过）` : "")
    + (!pending.length && !failed.length ? "  ← 全部真执行且通过" : ""));
  // 三组数（LAYA_VALUE_PLAN P1）：出场率、挽回、缓存——"模型的价值"从这里开始可核对。
  const modelAsks = rows.reduce((n, r) => n + r.model_asks, 0);
  const modelSteps = rows.reduce((n, r) => n + r.model_steps, 0);
  const totalSteps = rows.reduce((n, r) => n + r.steps, 0);
  const withModel = rows.filter((r) => r.model_asks > 0);
  const noModel = rows.filter((r) => r.steps > 0 && r.model_asks === 0);
  console.log(`模型参与：咨询 ${modelAsks} 次（过关执行 ${modelSteps} 步）/ 总步 ${totalSteps}；用到模型的应用：`
    + `${withModel.map((r) => `${r.app} 问 ${r.model_asks}${r.conf_max !== null ? `(conf ${r.conf_max.toFixed(2)})` : ""}`).join("、") || "无"}`);
  console.log(`reobserve 救回：${rows.reduce((n, r) => n + r.reobserve, 0)} 步`
    + `（加宽重看从"低置信要停"边缘拿回的那几步）；零咨询的应用 ${noModel.length} 个`
    + `——model not needed 正是产品主张的证据：能规则化就别猜。`);
  console.log(`决策缓存：命中 ${cache.hits} / 提问 ${cache.hits + cache.misses}`
    + `（laya 是确定性的：同问不重答——${cache.misses} 次是真问，${cache.hits} 次省）`);
  // 梯级账单（ARCHITECTURE_IMPROVEMENTS §5）：每一级"到达 → 决定"，整条语料上决定 0 步的级
  // 就是 dead rung——它不是保险，是错觉（会让人以为"有兜底"）。口径：低一级没决定的那一步
  // 才轮得到这一级，所以 trace 里的 method 计数就是它的"独立决定数"，不需要反事实重跑。
  const rungRule = rows.reduce((n, r) => n + (r.rule_steps ?? 0), 0);
  const rungLaya = modelSteps - rows.reduce((n, r) => n + r.reobserve, 0);
  const rungEscalate = rows.reduce((n, r) => n + (r.escalate ?? 0), 0);
  const rungs: Array<[string, number]> = [
    ["规则/hint", rungRule], ["laya", rungLaya],
    ["reobserve", rows.reduce((n, r) => n + r.reobserve, 0)], ["escalate", rungEscalate],
  ];
  const dead = rungs.filter(([, n]) => n === 0).map(([k]) => k);
  const hintHinted = rows.reduce((n, r) => n + r.hint_hinted, 0);
  const hintBrowser = rows.reduce((n, r) => n + r.hint_browser, 0);
  if (hintBrowser > 0) {
    const pct = ((100 * hintHinted) / hintBrowser).toFixed(1);
    console.log(`hint 覆盖：${hintHinted}/${hintBrowser} = ${pct}% 的浏览器步点了名（**这就是承重墙**——`
      + `删掉它们，同一批旅程的完成率会掉到 0；剩下的 ${hintBrowser - hintHinted} 步才依赖模型兜底）`);
  }
  const marginalTotal = rows.reduce((n, r) => n + r.model_steps, 0);
  if (tierOn) {
    console.log(`模型边际：${marginalTotal} 步（梯级里只有规则/hint 没决定才轮到模型 ⇒ model_steps 就是它的独立贡献）`);
    if (marginalTotal === 0) {
      console.log("** 模型边际 = 0：本语料上『运行期弹性/容错』主张不成立 —— "
        + "要么接线（docs/MODEL_ROLE_PLAN.md A1/A2），要么走备选降级。这不算通过。 **");
    }
  } else {
    console.log(`模型边际：未测（本臂跑在 ${tier}；桩模型的"过关 0"是构造出来的，不是证据。`
      + `真模型那一臂：npm run apps:suite -- --real-model）`);
  }
  console.log(`梯级账单：${rungs.map(([k, n]) => `${k} 决定 ${n}`).join(" ｜ ")}`
    + (dead.length ? ` ⇒ **dead rung：${dead.join("、")}**（本轮语料上从未救回任何东西；`
      + `要么接线、要么从架构里拿掉，别让它当"保险"）` : ""));
  for (const r of pending) console.log(`  - ${r.app}：${r.note ?? ""}`);
  const code = suiteExitCode({
    failed: failed.length, pending: pending.length, tierOn, marginal: marginalTotal,
  });
  console.log(`退出码：${code}`
    + `（0=全部真执行且通过 ｜ 1=有未通过 ｜ 2=用法错误 ｜ 3=有未执行 ｜ 4=真模型臂边际为 0）`);
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exit(await main());
}
