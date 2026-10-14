#!/usr/bin/env node
/**
 * 漂移族的**真模型臂**（第二次目的审查 R1 的验收台；审查见 docs/MODEL_PURPOSE_ARCH_REVIEW_2.md）。
 *
 * `tests/drift-family.test.ts` 故意用 0.10 的坏桩跑——它量的是"声明失效之后规则还剩多少"。
 * 但红的那三格（改 data-test、手机版 DOM、文案改写）**职责归模型**，而"真模型到底能兜回哪一格"
 * 从来没有一条臂测过：一个永远不被测量的主张，红不了也绿不了。这个工具补上那条腿——
 * 同一批夹具、同一个生产执行器、真决策模型在位，逐格报恢复率，并把结论**冻结成产物**。
 *
 *   node --experimental-strip-types tools/drift-real-arm.ts                 # 跑 + 打印（不落文件）
 *   node --experimental-strip-types tools/drift-real-arm.ts --write         # 跑 + 冻结进 bench/drift-real-arm.json
 *   node --experimental-strip-types tools/drift-real-arm.ts --check         # 跑 + 与已入库产物比，漂移即非零（smoke 用）
 *
 * 首测（2026-10-14，真 ONNX）：**0/3**——三格全红，conf 0.04/0.04/0.16，全在 0.25 闸门外。
 * 这不是"该臂该绿"的预言，是 W4′（若立项）的**验收基线**：以后谁把某格跑绿了，`--check` 会红，
 * 逼他显式 `--write` 刷新并改 `tests/drift-real-arm.test.ts` 里钉的期望——而不是悄悄发生。
 * 需要真模型产物（1.7GB）：CI 无产物时 `--check` 由 smoke.sh 的模型侧分支跳过（跳过 ≠ 通过）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserMiddleware } from "../src/executor.ts";
import { checkSignal } from "../src/signals.ts";
import { checkArtifacts } from "../src/model-artifacts.ts";
import { installLayaRuntime } from "../src/model.ts";
import { createLayaOnnxRuntime } from "../src/laya-onnx.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = path.join(REPO, "testpages", "drift");
const ARTIFACT = path.join(REPO, "bench", "drift-real-arm.json");

/** 与 tests/drift-family.test.ts 同一批红格：(夹具, 点名方式, 人读标签)。 */
export const CELLS: Array<[string, string, string]> = [
  ["d1-renamed-id.html", "[data-test=save]", "① 改 data-test × 属性句柄"],
  ["d5-mobile-dom.html", "[data-test=save]", "⑤ 手机版 DOM × 属性句柄"],
  ["d4-reworded.html", "保存", "④ 文案改写 × 标签点名"],
];

export interface CellVerdict {
  file: string; hint: string; label: string;
  done: boolean; method: string | null; conf: number | null; stop: string | null;
}

/** 逐格跑一次（真模型在位由调用方保证）。 */
export async function runCells(): Promise<CellVerdict[]> {
  const out: CellVerdict[] = [];
  for (const [file, hint, label] of CELLS) {
    const mw = new BrowserMiddleware({ maxSteps: 3, confirmFn: () => true });
    const report = await mw.run("保存这单的设置", `file://${path.join(PAGES, file)}`, {
      slots: {}, targetHint: hint,
      goalSignalFn: async (p) => checkSignal(p as never, { url_contains: "saved.html" }),
      verbose: false,
    });
    const s = (report.steps[0] ?? {}) as Record<string, unknown>;
    out.push({
      file, hint, label, done: report.done === true,
      method: typeof s.method === "string" ? s.method : null,
      conf: typeof s.conf === "number" ? s.conf : null,
      stop: report.done ? null : (report.stop_reason ?? null) as string | null,
    });
  }
  return out;
}

/** 纯函数：观测 vs 已入库产物，逐格比 `done`（不比 timing/conf——那些是快照，会因机器变）。 */
export function compareVerdicts(
  recorded: CellVerdict[], observed: CellVerdict[],
): string[] {
  const problems: string[] = [];
  for (const o of observed) {
    const r = recorded.find((x) => x.file === o.file && x.hint === o.hint);
    if (!r) { problems.push(`产物缺这一格：${o.file} / ${o.hint}`); continue; }
    if (r.done !== o.done) {
      problems.push(`漂移：${o.label} 产物记 ${r.done ? "绿" : "红"}，本次 ${o.done ? "绿" : "红"}`
        + `（要认这个变化就 --write 刷新 + 改 tests/drift-real-arm.test.ts 的期望）`);
    }
  }
  return problems;
}

function artifactDoc(cells: CellVerdict[]): string {
  const recovered = cells.filter((c) => c.done).length;
  return JSON.stringify({
    generated_by: "tools/drift-real-arm.ts",
    note: "漂移族真模型臂的冻结结论。--check 逐格比 done（不比 conf/timing）；"
      + "某格变绿 = W4′ 落地了，必须 --write 刷新并同步 tests/drift-real-arm.test.ts 的期望。",
    model: "真 ONNX 决策模型（换 checkpoint 要重跑 --write）",
    recovered: `${recovered}/${cells.length}`,
    cells,
  }, null, 2) + "\n";
}

const argOf = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? "" : null;
};
const has = (flag: string): boolean => process.argv.includes(flag);

async function main(): Promise<number> {
  const a = checkArtifacts();
  if (!a.ready) {
    console.error(`真模型产物不齐（缺 ${[a.graph ? "" : "图", a.weights ? "" : "权重", a.tokenizerDir ? "" : "tokenizer"]
      .filter(Boolean).join("/")}）——这一臂量的就是模型，桩不算数。补齐：npm run model:fetch -- --from <url|本地路径>`);
    return 2;
  }
  installLayaRuntime(createLayaOnnxRuntime());
  const cells = await runCells();
  const recovered = cells.filter((c) => c.done).length;
  for (const c of cells) {
    console.log(`${c.label}  ->  ${c.done ? "绿" : "红"}`
      + `  [${c.done ? `method=${c.method} conf=${c.conf}` : `stop=${String(c.stop ?? "").slice(0, 52)}`}]`);
  }
  console.log(`\n恢复率（真模型臂，漂移族红格）：${recovered}/${cells.length}`);

  if (has("--write")) {
    fs.writeFileSync(ARTIFACT, artifactDoc(cells));
    console.log(`写出 ${ARTIFACT}`);
    return 0;
  }
  if (has("--check")) {
    if (!fs.existsSync(ARTIFACT)) { console.error(`产物不存在：${ARTIFACT}（先 --write）`); return 1; }
    const recorded = (JSON.parse(fs.readFileSync(ARTIFACT, "utf-8")) as { cells: CellVerdict[] }).cells;
    const problems = compareVerdicts(recorded, cells);
    if (problems.length) { console.error("漂移：\n" + problems.join("\n")); return 1; }
    console.log(`与已入库产物一致：${ARTIFACT}`);
    return 0;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
