#!/usr/bin/env node
/**
 * 漂移族的**真模型臂**（第二次目的审查 §B2 的测量工具；审查见 docs/MODEL_PURPOSE_ARCH_REVIEW_2.md）。
 *
 * `tests/drift-family.test.ts` 故意用 0.10 的坏桩跑——它量的是"声明失效之后规则还剩多少"。
 * 但漂移族红的那三格的**职责归模型**，而"真模型到底能兜回哪一格"从来没有臂测过：
 * 一个永远不被测量的主张，红不了也绿不了。这个工具补上那条腿：同一批夹具、同一个生产执行器、
 * 真决策模型在位，逐格报恢复率。
 *
 *   node --experimental-strip-types tools/drift-real-arm.ts
 *
 * 首测结果（2026-10-14，/tmp/laya_dec.onnx 真模型）：**0/3**——
 * ①改 data-test×属性句柄、⑤手机版DOM×属性句柄 各 conf 0.04，④文案改写×标签点名 conf 0.16，
 * 全部低于 0.25 闸门。这不是"该臂该绿"的预言，是 W4′（若立项）的**验收台基线**。
 * 未进 CI：它是审查工具，不是门禁——把它变成门禁需要先有裁定（审查 §E-2）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserMiddleware } from "../src/executor.ts";
import { checkSignal } from "../src/signals.ts";
import { checkArtifacts } from "../src/model-artifacts.ts";
import { installLayaRuntime } from "../src/model.ts";
import { createLayaOnnxRuntime } from "../src/laya-onnx.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = path.join(REPO, "testpages", "drift");

const a = checkArtifacts();
if (!a.ready) {
  console.error(`真模型产物不齐（缺 ${["图", "权重", "tokenizer"].filter((_, i) => ![a.graph, a.weights, a.tokenizerDir][i]).join("/")}）——`
    + "这一臂量的就是模型，桩不算数。补齐：npm run model:fetch -- --from <url|本地路径>");
  process.exit(2);
}
installLayaRuntime(createLayaOnnxRuntime());

/** 与 tests/drift-family.test.ts 同一批红格：(夹具, 点名方式, 桩臂结果)。 */
const CELLS: Array<[string, string, string]> = [
  ["d1-renamed-id.html", "[data-test=save]", "① 改 data-test × 属性句柄"],
  ["d5-mobile-dom.html", "[data-test=save]", "⑤ 手机版 DOM × 属性句柄"],
  ["d4-reworded.html", "保存", "④ 文案改写 × 标签点名"],
];

let green = 0;
for (const [file, hint, label] of CELLS) {
  const mw = new BrowserMiddleware({ maxSteps: 3, confirmFn: () => true });
  const report = await mw.run("保存这单的设置", `file://${path.join(PAGES, file)}`, {
    slots: {}, targetHint: hint,
    goalSignalFn: async (p) => checkSignal(p as never, { url_contains: "saved.html" }),
    verbose: false,
  });
  const s = (report.steps[0] ?? {}) as Record<string, unknown>;
  const done = report.done === true;
  green += done ? 1 : 0;
  console.log(`${label}  ->  ${done ? "绿" : "红"}`
    + `  [${done ? `method=${s.method} conf=${s.conf}` : `stop=${String(report.stop_reason ?? "").slice(0, 52)}`}]`);
}
console.log(`\n恢复率（真模型臂，漂移族红格）：${green}/3`
  + "　——基线是 2026-10-14 首测的 0/3；W4′ 若落地，改的是这个数，不是断言。");
