/**
 * **不变量归纳**：让一个跑通的旅程自己提出"什么必须成立"，而不是让人去猜页面做完之后长什么样。
 *
 * 背景（见 [bench/AUTHORING_ASSESSMENT.md](../bench/AUTHORING_ASSESSMENT.md)）：15 个应用里唯一真正
 * 不可约的"人写"就是 `invariants`（29 条）——它是"结束状态要成立什么"的**意图**。生成器不发明意图，
 * 但**可以看**：这条旅程跑完之后页面变成了什么样，哪些事实是"动手前不成立、动手后成立、而且稳定"的。
 *
 *   一条命令看它提出什么：   npm run apps:induce -- --app ctrip-case --json
 *   看它 + 复跑一致性 + 写回： npm run apps:induce -- --app ctrip-case --write
 *
 * 三道闸门（都在这里，不是靠信任）：
 *   1. **区分性**：候选必须"动手前为假、结束后为真"（复用 `induceSignals` 的 diff 口径）；
 *   2. **稳定句柄**：只认 `data-test` / `id` / `name`，且值不能是波动量（4+ 位数字、日期、hash）——
 *      同一条规则也用在信号归纳上；
 *   3. **复跑一致**：`--runs N`（默认 2）各自归纳一遍，只有**每次都出现**的候选才算数。
 *
 * 它**不改**已有不变量：`--write` 只把"包里还没有的"追加进去，然后**立刻再跑一遍应用**验证仍然通过
 * （写回不是终点，验收才是）。归纳出来的不变量带着来源注释（哪次运行、什么状态变化），方便人 review。
 */
import fs from "node:fs";
import { isParseUsageError, stripArgSeparators, usageErrorLine } from "../src/support/cli-args.ts";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  appDataFile, appDirs, loadPack, expandPack, type AppPack,
} from "../src/app/app-pack.ts";
import { parseDeclarativeScript, packToScriptSource } from "../src/app/declarative.ts";
import { runApp } from "../src/app/app-runner.ts";
import { browserSession } from "../src/engine/executor.ts";
import { startUrl } from "../src/app/app-runner.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime } from "../src/model/model.ts";
import { captureStateView, induceSignals, type InducedCandidate } from "../src/flow/signal-induction.ts";
import { evalSignalOnState, type SignalSpec, type StateView } from "../src/engine/signals.ts";
import { applyConfiguredEnv } from "../src/support/apply-config-env.ts";

export const REPO = path.resolve(import.meta.dirname, "..");

export interface Proposal {
  id: string;
  desc: string;
  signal: SignalSpec;
  why: string;
  kind: string;
}

/** 候选 → 包里的不变量条目（id 稳定、desc 说明它是怎么来的）。 */
export function toInvariant(c: InducedCandidate, appId: string): Proposal {
  const sig = c.signal as SignalSpec;
  const key = JSON.stringify(sig).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48).toLowerCase();
  return {
    id: `induced-${key || "signal"}`,
    desc: `（归纳：${appId} 的旅程结束后必须成立，且动手前不成立）${c.why}`,
    signal: sig,
    why: c.why,
    kind: c.kind,
  };
}

/** 把 N 次归纳的结果取交集：只有每次都出现的候选算数（复跑一致）。 */
export function intersect(runs: Proposal[][]): Proposal[] {
  if (!runs.length) return [];
  const keyOf = (p: Proposal): string => JSON.stringify(p.signal);
  const first = runs[0]!;
  return first.filter((p) => runs.every((r) => r.some((q) => keyOf(q) === keyOf(p))));
}

/** 只打开一个 URL、不做任何动作，抓一份状态视图（对照态用）。 */
async function capturePage(pack: AppPack, url: string): Promise<StateView> {
  const session = await browserSession(true, (pack.device ?? null) as never);
  try {
    await (session.page as unknown as { goto(u: string, o?: unknown): Promise<unknown> })
      .goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return await captureStateView(session.page as never);
  } finally {
    await session.close();
  }
}

/**
 * 运行一次应用，返回 {before, after} 两个状态视图。
 *
 * **对照态（before）不是首页，而是"这条旅程少做最后一步"**：把它设成首页的话，区分出来的只是
 * "首页和结果页不一样"，会收进一堆与任务无关的 UI（城市输入框、搜索按钮、分页按钮……）；
 * 只有"最后一步真的改变了什么"才是这条旅程的**结束状态**该断言的东西。
 * 单步应用没有可减的步，退回"只打开它的页面"。
 */
export async function captureRun(
  pack: AppPack, opts: { outDir: string; runId: string },
): Promise<{ before: StateView; after: StateView; ok: boolean; completed: string; control: string }> {
  const browserSteps = (pack.journey ?? []).filter((s) => (s as { source?: unknown }).source === undefined);
  const expanded = expandPack(pack, {}, path.join(opts.outDir, `${pack.id}-plan.json`));
  const firstBrowser = expanded.steps.find((s) => s.kind !== "tool") as { start_url?: string } | undefined;
  const firstUrl = firstBrowser?.start_url ?? (pack.journey[0] as { start_url?: string }).start_url;
  if (!firstUrl) throw new Error(`应用 ${pack.id} 没有浏览器步，无法归纳 DOM 不变量`);

  let before: StateView;
  let control: string;
  if (browserSteps.length >= 2) {
    // 减掉最后一步：其余照跑，抓它停下来的状态
    const ablated = JSON.parse(JSON.stringify(pack)) as AppPack;
    ablated.journey = (pack.journey ?? []).slice(0, -1);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), `apps-induce-ctl-${pack.id}-`));
    try {
      const res = await runWithCapture(ablated, out, `${opts.runId}-control`);
      if (res.end_state) { before = res.end_state; control = "旅程少做最后一步"; }
      else { before = await capturePage(pack, startUrl(String(firstUrl))); control = "只打开第一步的页面（对照运行没抓到状态）"; }
    } catch {
      before = await capturePage(pack, startUrl(String(firstUrl)));
      control = "只打开第一步的页面（对照运行失败）";
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  } else {
    before = await capturePage(pack, startUrl(String(firstUrl)));
    control = "只打开它的页面（单步应用没有可减的步）";
  }

  // "结束后"：真跑一遍整条旅程（脚本模型，离线确定性）
  const res = await runWithCapture(pack, opts.outDir, opts.runId);
  if (!res.end_state) throw new Error(`应用 ${pack.id} 的结束状态没捕获到（它可能没有跑到浏览器步）`);
  return { before, after: res.end_state, ok: res.ok, completed: res.completed, control };
}

/** 跑一遍应用、不捕获状态（写回验证用）：只要 ok 与每条不变量的结论。 */
async function verify(file: string) {
  const pack = loadPack(file);
  installLayaRuntime(scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 }))));
  try {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "apps-induce-verify-"));
    try {
      return await runApp(pack, { verbose: false, sources: false, outDir: out, planPath: path.join(out, "plan.json") });
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  } finally {
    installLayaRuntime(null);
  }
}

/** 跑一遍应用并捕获结束状态（离线脚本模型）。 */
async function runWithCapture(pack: AppPack, outDir: string, runId: string) {
  installLayaRuntime(scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 }))));
  try {
    return await runApp(pack, {
      verbose: false, sources: false, outDir, runId,
      planPath: path.join(outDir, `${pack.id}-plan.json`), captureState: true,
    });
  } finally {
    installLayaRuntime(null);
  }
}

/** 归纳一次：候选 → 过滤掉"已经能用别的不变量表达"的重复项。 */
export async function induceOnce(
  pack: AppPack, outDir: string, runId: string,
): Promise<Proposal[]> {
  const { before, after, control } = await captureRun(pack, { outDir, runId });
  const ind = induceSignals(before, after, { max: 12 });
  const proposals = ind.candidates.map((c) => toInvariant(c, pack.id));
  // 自证：候选必须在 after 上为真（归纳器保证），且在 before 上为假（区分性）
  const kept = proposals.filter((p) => discriminating(p.signal, before, after));
  // 把对照态写在候选的 why 里：review 的人要知道"它是跟什么比出来的"
  return kept.map((p) => ({ ...p, why: `${p.why}（对照：${control}）` }));
}

/**
 * 只追加：把候选写进包的 `invariants`，**已有的判断一条不动**，重复的信号不写第二遍。
 * 返回值给 CLI 用来说清楚"加了几条 / 现在共几条"。
 */
/** 读一个可写包文件（`pack.json` 或声明式 `app.mjs`）成 IR 形状。 */
function readWritablePack(file: string): Record<string, unknown> {
  if (file.endsWith(".json")) return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  const parts = parseDeclarativeScript(fs.readFileSync(file, "utf-8"));
  return { ...(parts.meta as unknown as Record<string, unknown>), journey: parts.journey, source_slots: parts.data };
}

function writeWritablePack(file: string, raw: Record<string, unknown>): void {
  if (file.endsWith(".json")) fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
  else fs.writeFileSync(file, packToScriptSource(raw as never));
}

export function appendInvariants(file: string, proposals: Proposal[]): { added: number; total: number } {
  const raw = readWritablePack(file);
  const list = (raw["invariants"] ?? []) as Array<Record<string, unknown>>;
  const known = new Set(list.map((i) => JSON.stringify(i["signal"])));
  let added = 0;
  for (const p of proposals) {
    if (known.has(JSON.stringify(p.signal))) continue;
    list.push({ id: p.id, desc: p.desc, signal: p.signal });
    known.add(JSON.stringify(p.signal));
    added++;
  }
  raw["invariants"] = list;
  writeWritablePack(file, raw);
  return { added, total: list.length };
}

/** 撤掉指定的不变量（写回后重跑发现不可复现时用）。 */
export function removeInvariants(file: string, ids: Set<string>): string[] {
  const raw = readWritablePack(file);
  const list = (raw["invariants"] ?? []) as Array<Record<string, unknown>>;
  const kept = list.filter((i) => !ids.has(String(i["id"])));
  const removed = list.filter((i) => ids.has(String(i["id"]))).map((i) => String(i["id"]));
  raw["invariants"] = kept;
  writeWritablePack(file, raw);
  return removed;
}

/** 区分性闸门：候选必须在结束后为真、在对照态为假。 */
export function discriminating(signal: SignalSpec, before: StateView, after: StateView): boolean {
  return evalSignalOnState(signal, after) === true && evalSignalOnState(signal, before) === false;
}

export function existingSignals(pack: AppPack): string[] {
  return (pack.invariants ?? []).map((i) => JSON.stringify(i.signal));
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // rc 文件坏 = 配置类用法错误：在任何腿出场之前逐行点名并 exit 2（src/support/rcfile.ts）。
  { const rc = applyConfiguredEnv(); if (rc.errors.length) { for (const e of rc.errors) console.error(e); return 2; } }
  let values;
  // 打错的参数 → 一行点名，绝不甩 parseArgs 的堆栈（src/support/cli-args.ts 的体例）。
  try {
    ({ values } = parseArgs({
    args: stripArgSeparators(argv),
    options: {
      app: { type: "string" }, write: { type: "boolean" }, json: { type: "boolean" },
      runs: { type: "string" }, quiet: { type: "boolean" }, help: { type: "boolean" },
    },
  }));
  } catch (err) {
    if (!isParseUsageError(err)) throw err;
    console.error(usageErrorLine(err));
    return 2;
  }
  if (values.help || !values.app) {
    console.log(`usage: apps-induce --app <id> [--write] [--json] [--runs N] [--quiet]

  跑通一个应用，从"动手前 / 结束后"两个状态提出**可判定、可区分、可复现**的结束状态不变量。
  --write   把包里还没有的候选追加进 \`invariants\`，然后立刻再跑一遍应用验证仍然通过
  --runs N  复跑几次取交集（默认 2）
退出码：0=完成 ｜ 1=应用没跑通或写回后不通过 ｜ 2=用法错误`);
    return values.help ? 0 : 2;
  }
  const dirs = appDirs().filter((d) => path.basename(d) === values.app);
  if (!dirs.length) { console.error(`没有应用 ${JSON.stringify(values.app)}`); return 2; }
  const pack = loadPack(appDataFile(dirs[0]!) ?? path.join(dirs[0]!, "pack.json"));
  const runs = Math.max(1, Number(values.runs ?? 2));
  if (!Number.isFinite(runs) || runs > 10) { console.error("--runs 要在 1..10"); return 2; }

  const perRun: Proposal[][] = [];
  const outDirs: string[] = [];
  for (let i = 0; i < runs; i++) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), `apps-induce-${pack.id}-`));
    outDirs.push(out);
    try {
      perRun.push(await induceOnce(pack, out, `induce-${i}`));
    } catch (e) {
      console.error(`第 ${i + 1} 次归纳失败：${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  const agreed = intersect(perRun);
  const known = new Set(existingSignals(pack));
  const fresh = agreed.filter((p) => !known.has(JSON.stringify(p.signal)));
  for (const d of outDirs) fs.rmSync(d, { recursive: true, force: true });

  if (values.json) {
    console.log(JSON.stringify({
      app: pack.id, runs, candidates_per_run: perRun.map((r) => r.length),
      agreed: agreed.map((p) => ({ id: p.id, signal: p.signal, why: p.why })),
      new: fresh.map((p) => ({ id: p.id, signal: p.signal })),
      already_in_pack: agreed.length - fresh.length,
    }, null, 2));
    return 0;
  }

  console.log(`应用 ${pack.id}：跑 ${runs} 次，每次归纳到 ${perRun.map((r) => r.length).join(" / ")} 个候选`);
  console.log(`复跑都出现的（区分性 + 稳定句柄 + 复现）：${agreed.length} 个；包里已有的：${agreed.length - fresh.length} 个`);
  for (const p of fresh) console.log(`  + ${p.id}  ${JSON.stringify(p.signal)}  ← ${p.why}`);
  if (!fresh.length) console.log("  （没有新候选：这条旅程的结束状态要么已经被现有不变量覆盖，要么它没有稳定可判定的变化）");

  if (values.write && fresh.length) {
    const file = appDataFile(dirs[0]!) ?? path.join(dirs[0]!, "app.mjs");
    // 人的判断不许被机器覆盖：只追加（`appendInvariants` 里保证重复信号不写第二遍）
    const { added, total } = appendInvariants(file, fresh);
    console.log(`已追加 ${added} 条到 apps/${pack.id}/${path.basename(file)}（原有 ${known.size} 条未改动，现共 ${total} 条）`);

    // 写回不是终点：**立刻再跑一遍**。归纳是"看过两次"，第三次不成立就说明它不可复现——
    // 那就不该把它留在包里（宁可少一条真断言，也不要一条会骗人的）。
    let res = await verify(file);
    let removed = 0;
    if (!res.ok) {
      const failed = new Set(res.invariants.filter((i) => !i.held).map((i) => String(i.id)));
      const mine = new Set(fresh.map((p) => p.id));
      const toRemove = new Set([...failed].filter((id) => mine.has(id)));
      if (toRemove.size) {
        removed = removeInvariants(file, toRemove).length;
        if (!values.quiet) {
          console.log(`写回后重跑有 ${failed.size} 条不成立，其中 ${removed} 条是本次归纳的 → 已撤掉：`
            + [...toRemove].join(", "));
        }
        res = await verify(file);
      }
    }
    console.log(`写回后重跑：${res.ok ? "通过" : "**未通过**"} ｜ 步骤 ${res.completed} ｜ 不变量 `
      + `${res.invariants.filter((i) => i.held).length}/${res.invariants.length} 成立`
      + (removed ? `（撤掉了 ${removed} 条不可复现的候选）` : ""));
    return res.ok ? 0 : 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exit(await main());
}
