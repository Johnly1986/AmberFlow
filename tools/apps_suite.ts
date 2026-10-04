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
 */
import path from "node:path";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { appDirs, loadPack, type AppPack } from "../src/app-pack.ts";
import { runApp, refusalLine, type AppRunResult } from "../src/app-runner.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime } from "../src/model.ts";

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

/** 跑一个应用包（离线口径）。返回值就是套件表格里的一行。 */
export async function runOne(pack: AppPack): Promise<SuiteRow> {
  const out = path.join("/tmp", "layawebuse-suite", pack.id);
  fs.mkdirSync(out, { recursive: true });
  const res: AppRunResult = await runApp(pack, {
    verbose: false, sources: false, outDir: out, planPath: path.join(out, "plan.json"),
  });
  const steps = res.subgoals.length + res.tool_steps.length;
  const skipped = res.subgoals.filter((s) => s.status === "skipped").length;
  const held = res.invariants.filter((i) => i.held).length;
  // 危险步被拒**不是失败也不是通过**：套件没有放行不可逆动作的权限（那是 --allow-dangerous 的事），
  // 所以它如实记成"需显式放行，本次未执行"。绿色的前提永远是真的执行过。
  const refusals = res.tool_steps.filter((t) => !t.done).map((t) => t.refused);
  const onlyDangerous = !res.ok && refusals.length > 0 && refusals.every((r) => r === "dangerous");
  const status: SuiteStatus = res.ok ? "passed" : onlyDangerous ? "needs-dangerous-opt-in" : "failed";
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
  };
}

export async function suite(only: string[] = []): Promise<{
  rows: SuiteRow[]; skipped: string[]; unmatched: string[]; known: string[];
}> {
  installLayaRuntime(scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 }))));
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
        rows.push(await runOne(pack));
      } catch (e) {
        rows.push({
          app: pack.id, steps: 0, completed: "0/0", skipped: 0, invariants: "-",
          status: "failed", secs: 0,
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
  return { rows, skipped, unmatched, known };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      only: { type: "string" }, json: { type: "boolean" },
      help: { type: "boolean" }, verbose: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log("usage: apps-suite [--only id,id] [--json] [--verbose]\n\n"
      + "一条命令跑完所有旅程型应用的验收（离线口径）\n\n"
      + "退出码：0=全部真执行且通过 ｜ 1=有未通过（含加载失败） ｜ "
      + "2=用法错误（--only 未命中任何应用） ｜ 3=有\"未执行\"（危险步未放行，不算全绿）\n"
      + "线上/测量型应用会被明着跳过（它们要真网络），跳过不等于通过。\n"
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
    out = await suite(only);
  } finally {
    console.log = passthrough;
  }
  const { rows, skipped, unmatched, known } = out;
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
      rows, skipped, exit_code: code,
      legend: "0=全部真执行且通过 ｜ 1=有未通过 ｜ 2=用法错误 ｜ 3=有未执行（危险步未放行）",
    }, null, 2));
    return code;
  }
  const head = ["应用", "步骤", "完成", "跳过", "不变量", "用时", "结论"];
  const verdict = (r: SuiteRow): string =>
    r.status === "passed" ? "通过"
      : r.status === "needs-dangerous-opt-in" ? "未执行（危险步未放行）" : "**未通过**";
  const table = rows.map((r) => [r.app, String(r.steps), r.completed, String(r.skipped),
    r.invariants, `${r.secs}s`, verdict(r)]);
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
  for (const r of pending) console.log(`  - ${r.app}：${r.note ?? ""}`);
  console.log(`退出码：${failed.length ? 1 : pending.length ? 3 : 0}`
    + `（0=全部真执行且通过 ｜ 1=有未通过 ｜ 2=用法错误 ｜ 3=有未执行）`);
  return failed.length ? 1 : pending.length ? 3 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exit(await main());
}
