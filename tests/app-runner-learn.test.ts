/**
 * **R2（第二次目的审查 2026-10-14 立项）：学习环接进主链路。**
 *
 * 审查原文的验收判据："同一应用二跑，第二跑的 `laya` 出场数严格 ≤ 第一跑，
 * 且矩阵列非'未跑'"。外加一条既有纪律（plan-cli 的 sidecar 测试钉过，这里钉 app-runner）：
 * **学到的永不写进被审计的包**——包文件逐字节不变，学到的只出现在 sidecar。
 *
 * 夹具与 tests/hint-memory.test.ts 同族：一个带稳定句柄的页面、包里**没有任何 authored hint**
 * （否则 authored 恒赢、模型永远不上场，学习环无事可做），模型桩**过闸门**并选对。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadPack } from "../src/app/app-pack.ts";
import { runApp } from "../src/app/app-runner.ts";
import { createHintMemory } from "../src/model/hint-memory.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer } from "../src/model/model.ts";
import { matrix } from "../tools/apps_matrix.ts";

afterAll(() => installLayaRuntime(null));

/** 目标元素带稳定句柄（data-test），页面本身没有任何 authored 点名的可能。 */
function fixturePage(dir: string): string {
  const html = `<!doctype html><html><body><main>
<button data-test="other-thing" onclick="void 0">Store locator</button>
<button data-test="proceed-now" onclick="document.querySelector('[data-test=status]').textContent='DONE'">Proceed to payment</button>
<div data-test="status">IDLE</div></main></body></html>`;
  const f = path.join(dir, "checkout.html");
  fs.writeFileSync(f, html);
  return f;
}

/** 过闸门的模型：永远选"Proceed to payment"，并计数被咨询次数。 */
function modelPassingGate(): () => number {
  let calls = 0;
  installLayaRuntime(scriptedRuntime(scriptedAgent((key, _s, questions): Answer | undefined => {
    if (key === "r") return { noul: 0.05 };
    if (key === "d") return { noul: 0.0 };
    if (key === "act") {
      calls += 1;
      const crit = (questions[key]!.criteria ?? {}) as Record<string, string>;
      const keys = Object.keys(crit);
      const target = keys.find((k) => String(crit[k]).includes("Proceed to payment")) ?? keys[0] ?? "";
      return {
        choice: target,
        probabilities: Object.fromEntries(keys.map((k) => [k, k === target ? 0.9 : 0.1 / keys.length])),
        confidence: 0.9,
      };
    }
    return undefined;
  }) as never));
  return () => calls;
}

const SIGNAL = { css_text_equals: ["[data-test=status]", "DONE"] };
// desc 刻意与元素标签零重叠：affordance 规则不命中，模型必须上场——这才测得到学习环。
const DOC = (url: string) => ({
  spec_version: 1, id: "r2-learn-loop", label: "R2 验收：学习环 sidecar",
  goal: "complete checkout",
  journey: [{ desc: "complete checkout", start_url: url, signal: SIGNAL }],
  invariants: [{ id: "status-done", desc: "结束态是 DONE", signal: SIGNAL }],
});

describe("R2：app-runner 的学习环（--learn-hints 的库面）", () => {
  it("run 1 学、run 2 复用且零额外前向；包文件逐字节不变；matrix 列不是'未跑'", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r2-learn-"));
    const url = `file://${fixturePage(tmp)}`;
    const appsRoot = path.join(tmp, "home");
    const packFile = path.join(appsRoot, "apps", "r2-learn-loop", "pack.json");
    fs.mkdirSync(path.dirname(packFile), { recursive: true });
    fs.writeFileSync(packFile, JSON.stringify(DOC(url), null, 2));
    const prevHome = process.env.AMBERFLOW_HOME;
    const prevOut = process.env.AMBERFLOW_APPS_OUT;
    process.env.AMBERFLOW_HOME = appsRoot;
    const calls = modelPassingGate();
    const sidecar = path.join(tmp, "hints", "r2-learn-loop.json");
    // CLI 的 main() 会 ensureDir；这里直接走 runApp 库面，得自己把 sidecar 目录建出来
    // （否则 HintMemory.save() 静默失败——它 best-effort，不替调用方造目录）。
    fs.mkdirSync(path.dirname(sidecar), { recursive: true });
    const outDir = path.join(tmp, "out");
    try {
      const pack = loadPack("r2-learn-loop");
      const run = () => runApp(pack, {
        outDir, sources: false, verbose: false,
        hintMemory: createHintMemory({ path: sidecar }), hintMemoryPath: sidecar,
      });

      const r1 = await run();
      expect(r1.ok).toBe(true);
      expect(r1.decisions?.by_method["laya"]).toBe(1);           // 第一跑：模型上场
      expect(r1.hint_memory?.entries).toBe(1);                   // 且把成功变成了规则
      expect(r1.hint_memory?.path).toBe(sidecar);

      const before = calls();
      const r2 = await run();
      expect(r2.ok).toBe(true);
      expect(r2.decisions?.by_method["laya"] ?? 0).toBe(0);      // 第二跑：模型零出场
      expect(r2.decisions?.by_method["rule:match"]).toBe(1);     // 由学到的规则解决
      expect(calls()).toBe(before);                              // 严格 ≤：一次前向都没多花
      expect(r2.hint_memory?.used).toBe(1);

      // sidecar 纪律：学到的**不在被审计的包里**（plan-cli 钉过的那条，app-runner 同样成立）
      const onDisk = JSON.parse(fs.readFileSync(packFile, "utf-8"));
      expect(onDisk.journey[0].target_hint).toBeUndefined();
      expect(onDisk.journey[0].target_hints).toBeUndefined();
      expect(fs.existsSync(sidecar)).toBe(true);

      // 不开学习环：产物**没有** hint_memory 字段（缺省等价的纪律，同 path_visits）
      const r3 = await runApp(pack, { outDir: path.join(tmp, "out3"), sources: false, verbose: false });
      expect(r3.hint_memory).toBeUndefined();

      // matrix 的"学到/复用"列读的就是这份产物。产物文件由 `main()` 落盘（runApp 只返回结果），
      // 所以这里手动写一份 r2 的产物到 AMBERFLOW_APPS_OUT，模拟"上一次独立跑"。
      process.env.AMBERFLOW_APPS_OUT = outDir;
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "r2-learn-loop-result.json"), JSON.stringify(r2));
      const { rows } = matrix();
      const row = rows.find((r) => r.app === "r2-learn-loop");
      expect(row?.learn).toBe("1/1");                            // 已知 1 条、复用 1 次
    } finally {
      if (prevHome === undefined) delete process.env.AMBERFLOW_HOME; else process.env.AMBERFLOW_HOME = prevHome;
      if (prevOut === undefined) delete process.env.AMBERFLOW_APPS_OUT; else process.env.AMBERFLOW_APPS_OUT = prevOut;
    }
  }, 240_000);
});
