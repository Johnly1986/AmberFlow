/**
 * P1 出场量化 —— "模型的价值"必须**可核对**（LAYA_VALUE_PLAN 的北极星三组数）。
 *
 * 钉住一张表同时讲出的两句真话：
 *   - demo-app：`model_asks = 0`——能规则化就别猜，**零出场是卖点**（结论列明写 `model not needed`）；
 *   - transfer-slowjet：`model_asks ≥ 1`——冷加载的那一问就是模型的活；
 *     脚本模型下它"咨询但没过闸门、靠 retries 才绿"，真 ONNX 下同理（去掉 retries 实测 0/7）。
 *
 * 口径纪律：**咨询数在运行时缝上数**（未过闸门的问不在 trace 里留 `method`——执行器在
 * low confidence 直接 break），**过关数在 trace 里数**；两处只在这一个模块里各数一遍。
 * `apps:matrix` 的运行时两列读上一次套件真跑的 `*-result.json`——没跑过显示"未跑"，
 * 绝不把"没证据"排成 0。产物目录用 `AMBERFLOW_SUITE_OUT` 指到本测试的临时区，互不污染。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appReportMarkdown, runApp } from "../src/app-runner.ts";
import { loadPack } from "../src/app-pack.ts";
import { countingRuntime, installLayaRuntime, scriptedAgent, scriptedRuntime } from "../src/model.ts";
import { withDecisionCache } from "../src/decision-cache.ts";
import { matrix } from "../tools/apps_matrix.ts";
import { runOne, suite, suiteOutDir } from "../tools/apps_suite.ts";

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
}

const OUT = tmpDir("mv-suite");
process.env.AMBERFLOW_SUITE_OUT = OUT;          // 套件与矩阵**同一约定**（调用时读 env）

let cached: ReturnType<typeof withDecisionCache>;
let counted: ReturnType<typeof countingRuntime>;
beforeAll(() => {
  // 与套件同一约定：脚本模型 + 决策缓存（命中数）+ 外层咨询计数（出场数）。
  cached = withDecisionCache(scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 }))));
  counted = countingRuntime(cached);
  installLayaRuntime(counted);
});
afterAll(() => {
  installLayaRuntime(null);
  delete process.env.AMBERFLOW_SUITE_OUT;
  fs.rmSync(OUT, { recursive: true, force: true });
});

describe("runApp 的决策来源汇总（P1 的第一处出口）", () => {
  it("demo-app：全规则消化 → 咨询 0 次，报告里讲出『model not needed』", async () => {
    const out = tmpDir("mv-demo");
    const asksBefore = counted.pickAsks();
    const res = await runApp(loadPack("demo-app"), {
      verbose: false, sources: false, outDir: out, planPath: path.join(out, "plan.json"),
      modelStatus: "off(scripted)", runtimeStats: () => cached.decisionStats(),
      pickAsks: () => counted.pickAsks() - asksBefore,
    });
    expect(res.ok).toBe(true);
    expect(res.model_status).toBe("off(scripted)");
    const d = res.decisions!;
    expect(d.total_steps).toBeGreaterThan(0);
    expect(d.model_asks).toBe(0);
    expect(d.model_steps).toBe(0);
    expect(d.by_method["rule:match"] ?? 0).toBeGreaterThan(0);
    expect(d.cache).not.toBeNull();
    expect(d.line.startsWith("rule ")).toBe(true);
    expect(d.line).toContain("laya 0");
    expect(d.line).not.toContain("咨询");        // 零出场不喊"被咨询 0 次"的空话
    const md = appReportMarkdown(res);
    expect(md).toContain("模型层级：`off(scripted)`");
    expect(md).toContain("决策来源");
    expect(md).toContain("model not needed");
  }, 180_000);
});

describe("梯级账单（ARCHITECTURE_IMPROVEMENTS §5：没出场的梯级要有数字）", () => {
  it("AppDecisions.ladder 把每一级的独立决定数算出来（trace 的 method 就是它的口径）", async () => {
    const out = tmpDir("mv-ladder");
    const asksBefore = counted.pickAsks();
    const res = await runApp(loadPack("demo-app"), {
      verbose: false, sources: false, outDir: out, planPath: path.join(out, "plan.json"),
      modelStatus: "off(scripted)", runtimeStats: () => cached.decisionStats(),
      pickAsks: () => counted.pickAsks() - asksBefore,
    });
    const l = res.decisions!.ladder;
    expect(l.rule).toBeGreaterThan(0);            // 全规则消化的应用
    expect(l.laya).toBe(0);
    expect(l.reobserve).toBe(0);
    expect(l.escalate).toBe(0);                   // 没有端点 ⇒ 这一级恒 0，正是要暴露的 dead rung
    expect(l.asked_not_passed).toBe(0);
    // 与 by_method 对账：梯级账单不许自造数，它就是同一份 trace 的另一只眼
    expect(l.rule).toBe(res.decisions!.by_method["rule:match"] ?? 0);
    expect(l.laya + l.reobserve).toBe(res.decisions!.model_steps);
  }, 180_000);

});

describe("套件的验收数（P1 的验收口径）", () => {
  it("同一张表：slowjet 咨询 ≥1（保险被碰过）；demo-app 为 0；产物落套件目录", async () => {
    const sj = await runOne(loadPack("transfer-slowjet"), cached, counted);
    expect(sj.status).toBe("passed");
    // 咨询但没过闸门 = slowjet 的真实形状（脚本模型与真 ONNX 在这一步同形：0.16 < 0.25）。
    // 没有"问"这一次咨询、也没有 retries 重跑，这包就是红的——这就是"模型在场"的证据。
    expect(sj.model_asks).toBeGreaterThanOrEqual(1);
    expect(sj.model_steps).toBe(0);
    const dm = await runOne(loadPack("demo-app"), cached, counted);
    expect(dm.model_asks).toBe(0);
    expect(dm.conf_max).toBeNull();
    // 产物落套件目录——matrix 的运行时两列吃的就是这份。
    expect(fs.existsSync(path.join(suiteOutDir(), "transfer-slowjet", "transfer-slowjet-result.json"))).toBe(true);
  }, 300_000);

  it("cache_saved 有牙：同计划二跑，第二次至少省下一次（确定性模型不该被问两次）", async () => {
    // 上一用例已经跑过一遍 slowjet（同一进程、同一缓存实例），每个问的指纹都存了下来。
    // 再跑同一份计划——重试/续跑/消融重跑就是这个形状——同一状态的同一问必须**命中**
    // （`cache:measure` 实测同计划二跑 12 forwards → 0 的离线等价物）。
    const sj = await runOne(loadPack("transfer-slowjet"), cached, counted);
    expect(sj.cache_saved).toBeGreaterThanOrEqual(1);
  }, 300_000);
});

describe("matrix 的运行时两列读真跑的产物", () => {
  it("跑过的应用给出数；没跑过的显示未跑（不排成 0）", async () => {
    await suite(["demo-app"]);                               // 真跑一遍，产物进隔离目录
    const { rows } = matrix();
    const demo = rows.find((r) => r.app === "demo-app")!;
    expect(demo.modelAsks).toBe(0);                         // 真跑过且零咨询 = 卖点，不是缺数
    const sj = rows.find((r) => r.app === "transfer-slowjet")!;
    expect(sj.modelAsks).not.toBeNull();                    // 验收用例真跑过它 → 有数
    expect(sj.modelAsks).toBeGreaterThanOrEqual(1);
    const ctrip = rows.find((r) => r.app === "ctrip-case")!;
    expect(ctrip.modelAsks).toBeNull();                     // 从没跑过的才是 null（"未跑"）
  }, 300_000);
});
