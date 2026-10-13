/**
 * **决策提供者对照台**（`node --experimental-strip-types tools/provider-baselines.ts [--apps a,b]`）
 *
 * 它回答一个之前没人能回答的问题：**换一个新决策模型，它比"没有智能"强多少？**
 * 以前这个问题没法问，因为缝是 laya 形状的——要试别的策略只能改执行器。
 * 现在 `--provider` 能选，基线就是必须过的线。
 *
 * 三把尺子（都不加载权重、都不问模型，所以整轮跑几十秒）：
 *   `first-candidate` 只有名次、永远选第一个未禁候选（零智能）
 *   `coin-flip`      均匀随机（可复现：种子 = goal + 候选集）
 *   `always-abstain` 永远不选（= 兜底不存在）
 *
 * 对照的是**删掉全部 hint 的同一批旅程**——有 hint 的时候规则层全包了，比不出任何东西。
 *
 * 2026-10-13 首轮实测（真模型那一列来自 docs/DECISION_MODEL_PURPOSE_REVIEW.md §2.4）：
 *
 * | 无 hint 旅程 | always-abstain | **first-candidate** | coin-flip | laya（真 ONNX） |
 * |---|---|---|---|---|
 * | demo-app        | 1/5 ✗ | **5/5 ✓** | 2/5 ✗ | 3/5 ✗ |
 * | camera-entry    | 0/4 ✗ | **4/4 ✓** | 0/4 ✗ | 0/4 ✗ |
 * | transfer-trekly | 0/19 ✗ | **19/19 ✓** | 0/19 ✗ | 0/19 ✗ |
 * | ctrip-case      | 0/19 ✗ | 7/19 ✗ | 0/19 ✗ | 10/19 ✗ |
 *
 * **一个零智能的"选第一个"在四条旅程里的三条上完整通过，而真模型一条都没过。**
 * 原因在执行器的梯级本身：选错 → 页面没变 → `inert` → 禁掉该元素 → 再问。
 * 于是"选第一个"变成一次**系统性遍历**——把搜索做掉的是 forbid+inert+retries 这套机制，
 * 不是模型。这条改写了"模型带来弹性"的评估基线：**新模型要赢的是 `first-candidate`，不是"没有模型"。**
 *
 * 三条不夸大的边界（都写进输出的 note）：
 * 1. 夹具上"点第一个"便宜，是因为点错**基本是惰性的**；真实页面上它会乱点导航/品牌，
 *    且不可逆动作要靠 `effect.irreversible` + 风险闸门 + `hosts` 信封拦住——基线**不安全**，
 *    它是尺子，不是可以上线的策略。
 * 2. `ctrip-case` 上它 7/19 输给 laya 的 10/19：这条不是"基线总赢"，是"基线常常就够"。
 * 3. 咨询数会涨（trekly 37 次、ctrip 137 次）：遍历靠的是多次问，代价在步数与时间。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const argOf = (n: string): string | null => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] ?? null : null;
};
const APPS = (argOf("--apps") ?? "demo-app,camera-entry,transfer-trekly,ctrip-case")
  .split(",").map((x) => x.trim()).filter(Boolean);
const PROVIDERS = (argOf("--providers") ?? "always-abstain,first-candidate,coin-flip")
  .split(",").map((x) => x.trim()).filter(Boolean);
const OUT = argOf("--out") ?? path.join(REPO, "bench", "provider-baselines.json");

/** 把 hint 全删掉（roles 模板与 journey 条目都删），写进临时目录——**不动仓库里的包**。 */
function hintless(app: string, dir: string): string {
  const pack = JSON.parse(fs.readFileSync(path.join(REPO, "apps", app, "pack.json"), "utf-8")) as
    { roles?: Record<string, Record<string, unknown>>; journey?: Array<Record<string, unknown>> };
  const strip = (o: Record<string, unknown> | undefined): void => {
    if (!o) return;
    delete o.target_hint; delete o.target_hints;
  };
  for (const r of Object.values(pack.roles ?? {})) strip(r);
  for (const e of pack.journey ?? []) if (!e["source"]) strip(e);
  const file = path.join(dir, `${app}.json`);
  fs.writeFileSync(file, JSON.stringify(pack, null, 2));
  return file;
}

interface Cell { ok: boolean; completed: string; asks: number; passed: number; secs: number }

function run(file: string, app: string, provider: string, outDir: string): Cell {
  // **应用未通过时 app-runner 退出码非 0，那是结果不是故障**：这里不能拿退出码当异常，
  // 否则"没通过的基线"会被记成"跑挂了"（本轮第一版就这么错过三格数据）。
  try {
    execFileSync("node", ["--experimental-strip-types", "src/app-runner.ts",
      "--app", file, "--no-sources", "--provider", provider, "--out", outDir],
    { cwd: REPO, stdio: "pipe", timeout: 600_000 });
  } catch { /* 非零退出：产物里自有分晓 */ }
  const r = JSON.parse(fs.readFileSync(path.join(outDir, `${app}-result.json`), "utf-8")) as
    { ok: boolean; completed: string; secs: number; decisions?: Record<string, number> };
  return {
    ok: r.ok, completed: r.completed, secs: r.secs,
    asks: r.decisions?.model_asks ?? 0, passed: r.decisions?.model_steps ?? 0,
  };
}

/**
 * 外部 provider 的就绪探测：`jevk5` 这类要一个服务在场。没服务就**提前停下并指路**，
 * 而不是跑出 12 格"未通过"——那会被误读成"这个模型不行"，而真相是"根本没问成"。
 */
async function ensureReady(names: string[]): Promise<void> {
  if (!names.includes("jevk5")) return;
  const endpoint = process.env.JEVK5_ENDPOINT ?? "http://127.0.0.1:8090/v1/systemone";
  const health = endpoint.replace(/\/v1\/systemone\/?$/, "/health");
  try {
    const res = await fetch(health, { signal: AbortSignal.timeout(5000) });
    if (res.ok) return;
  } catch { /* 下面统一报 */ }
  throw new Error(`provider "jevk5" 需要在线服务，但 ${health} 不应答。`
    + `起法（CUDA / GGUF / Lite 三条路）见 docs/DECISION_PROVIDER_JEVK5.md；`
    + `或用 JEVK5_ENDPOINT 指向已有服务。`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prov-base-"));
try {
  await ensureReady(PROVIDERS);
} catch (e) {
  // 期望内的失败（服务没起）说清楚就退出，别甩栈——栈会让人以为是工具的 bug。
  console.error((e as Error).message);
  process.exit(2);
}
const results: Record<string, Record<string, Cell>> = {};
for (const app of APPS) {
  const file = hintless(app, tmp);
  results[app] = {};
  for (const p of PROVIDERS) {
    try {
      results[app]![p] = run(file, app, p, path.join(tmp, `${app}-${p}`));
    } catch (e) {
      // 真故障（产物都没有）：明写，不留个假的 ✗
      results[app]![p] = { ok: false, completed: "跑挂了", asks: 0, passed: 0, secs: 0 };
      console.error(`${app}/${p}: ${(e as Error).message.slice(0, 120)}`);
    }
  }
}

const head = ["应用(无 hint)", ...PROVIDERS];
const rows = APPS.map((a) => [a, ...PROVIDERS.map((p) => {
  const c = results[a]![p]!;
  return `${c.ok ? "✓" : "✗"} ${c.completed} 问${c.asks}/过${c.passed}`;
})]);
const w = head.map((h, i) => Math.max([...rows].reduce((m, r) => Math.max(m, r[i]!.length), h.length)));
const line = (cs: string[]): string => cs.map((c, i) => c.padEnd(w[i]!)).join("  ");
console.log("决策提供者对照台（同一批删掉 hint 的旅程；真模型列见审查文档 §2.4）\n");
console.log(line(head));
console.log(w.map((x) => "-".repeat(x)).join("  "));
for (const r of rows) console.log(line(r));
const wins = PROVIDERS.map((p) => [p, APPS.filter((a) => results[a]![p]!.ok).length] as const);
console.log(`\n通过数：${wins.map(([p, n]) => `${p} ${n}/${APPS.length}`).join(" ｜ ")}`);
console.log("判据：任何新决策模型要证明自己值得留在关键路径上，赢的是 first-candidate，不是『没有模型』。");

fs.writeFileSync(OUT, JSON.stringify({
  generated_by: "tools/provider-baselines.ts",
  note: "基线不是可上线策略：夹具里点错多为惰性，真实页面不是；不可逆动作靠 effect.irreversible + 风险闸门 + hosts 信封拦。",
  providers: PROVIDERS, apps: APPS, results,
}, null, 2) + "\n");
console.log(`\n写出 ${OUT}`);
