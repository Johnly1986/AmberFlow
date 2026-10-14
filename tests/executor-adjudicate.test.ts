/**
 * **A2′（W4′ 存活半边，2026-10-14 补完）：非破坏性步放开模型、事后由信号裁决。**
 *
 * 钉四件事：
 *  ① 加载期：`adjudicate:true` 必须显式 `effect.irreversible:false` + 可判定信号，否则红；
 *  ② 运行期·救回：模型低于闸门但**选对** → 声明了裁决资格就执行、信号成立 → done（`laya:adjudicated`）；
 *  ③ 运行期·对照：同样的模型**没声明** → 逐字节今天（`low_confidence` 阻塞）；
 *  ④ 运行期·有界：模型低于闸门且**选错**（动作非惰性但信号不成立）→ 白跑一次即禁该元素，
 *     下一步换到正确候选才 done——"错了白跑"的爆炸半径就是**每个元素一次**。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BrowserMiddleware } from "../src/executor.ts";
import { checkSignal } from "../src/signals.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer } from "../src/model.ts";
import { PlanningRules, TaskPlan } from "../src/plan.ts";

afterAll(() => installLayaRuntime(null));

const SIGNAL = { css_text_equals: ["[data-test=status]", "DONE"] };

/** 两个按钮：Store（错，改了页面但不是 DONE）与 Proceed（对，置 DONE）。 */
function page(): string {
  const html = `<!doctype html><html><body><main>
<button data-test="store" onclick="document.querySelector('[data-test=status]').textContent='SOMETHING ELSE'">Store locator</button>
<button data-test="proceed" onclick="document.querySelector('[data-test=status]').textContent='DONE'">Proceed to payment</button>
<div data-test="status">IDLE</div></main></body></html>`;
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "a2p-")), "p.html");
  fs.writeFileSync(f, html);
  return `file://${f}`;
}

/** 一个"永远没过闸门"（conf 0.10）的模型；`pick` 决定它在候选里先点谁。 */
function belowGate(pick: "store" | "proceed"): void {
  installLayaRuntime(scriptedRuntime(scriptedAgent((key, _s, questions): Answer | undefined => {
    if (key === "r") return { noul: 0.05 };
    if (key === "d") return { noul: 0.0 };
    if (key === "act") {
      const crit = (questions[key]!.criteria ?? {}) as Record<string, string>;
      const keys = Object.keys(crit);
      const want = (k: string) => String(crit[k]).includes(pick === "store" ? "Store locator" : "Proceed to payment");
      const target = keys.find(want) ?? keys[0] ?? "";
      return {
        choice: target,
        probabilities: Object.fromEntries(keys.map((k) => [k, k === target ? 0.1 : 0.05])),
        confidence: 0.1,
      };
    }
    return undefined;
  }) as never));
}

const attempt = (url: string, adjudicate: boolean, effect?: { irreversible?: boolean }) => {
  const mw = new BrowserMiddleware({ maxSteps: 4, confirmFn: () => true });
  return mw.run("complete checkout", url, {
    slots: {}, goalSignalFn: (p) => checkSignal(p as never, SIGNAL),
    adjudicate, effect, verbose: false,
  });
};

describe("A2′ 前置：effect/adjudicate 能穿过 TaskPlan 构造器（2026-10-14 修的断链）", () => {
  it("构造器不再丢弃 effect——W1 的 effect.irreversible 声明从没到过执行器，就是这个 bug", () => {
    const plan = new TaskPlan("g", [{
      desc: "d", signal: SIGNAL, start_url: "file:///x",
      effect: { irreversible: false }, adjudicate: true,
    }] as never, "/tmp/a2rt.json", {});
    expect(plan.subgoals[0]!.effect).toEqual({ irreversible: false });
    expect((plan.subgoals[0] as Record<string, unknown>).adjudicate).toBe(true);
  });
});

describe("A2′ 加载期：裁决资格是声明出来的", () => {
  const problems = (sub: Record<string, unknown>) =>
    new PlanningRules().problems(new TaskPlan("g", [sub] as never, "/tmp/a2p.json", {}));
  it("adjudicate:true 但没声明可逆性 ⇒ 红（爆炸半径不许假设）", () => {
    expect(problems({ desc: "d", signal: SIGNAL, start_url: "file:///x", adjudicate: true }))
      .toMatchObject([expect.stringMatching(/adjudicate requires effect.irreversible = false/)]);
  });
  it("adjudicate:true + irreversible:true ⇒ 红（不可逆的步绝不能放开模型）", () => {
    expect(problems({ desc: "d", signal: SIGNAL, start_url: "file:///x", adjudicate: true,
      effect: { irreversible: true } }))
      .toMatchObject([expect.stringMatching(/adjudicate requires effect.irreversible = false/)]);
  });
  it("adjudicate:true + manual 信号 ⇒ 红（没有裁判就没有事后裁决）", () => {
    expect(problems({ desc: "d", signal: { manual: true }, start_url: "file:///x", adjudicate: true,
      effect: { irreversible: false } }))
      .toMatchObject([expect.stringMatching(/decidable DOM signal/)]);
  });
  it("adjudicate:true + irreversible:false + DOM 信号 ⇒ 合法", () => {
    expect(problems({ desc: "d", signal: SIGNAL, start_url: "file:///x", adjudicate: true,
      effect: { irreversible: false } })).toEqual([]);
  });
});

describe("A2′ 运行期：低于闸门的选择，由这一步自己的信号裁决", () => {
  it("选对 + 声明裁决 ⇒ done（laya:adjudicated）；同样的模型不声明 ⇒ 逐字节阻塞", async () => {
    belowGate("proceed");
    const url = page();
    const saved = await attempt(url, true, { irreversible: false });
    expect(saved.done).toBe(true);
    expect(saved.steps.some((s) => s.method === "laya:adjudicated" && s.executed)).toBe(true);

    belowGate("proceed");
    const blocked = await attempt(page(), false);   // 对照：没声明就没放开
    expect(blocked.done).toBe(false);
    expect(blocked.stop_code).toBe("low_confidence");
  }, 120_000);

  it("选错（非惰性但信号不成立）⇒ 白跑一次即禁，换到正确候选才 done——爆炸半径 = 每元素一次", async () => {
    belowGate("store");   // 模型先点 Store（改了页面但不是 DONE）
    const mw = new BrowserMiddleware({ maxSteps: 4, confirmFn: () => true });
    // 让模型在被禁掉 Store 后能选到 Proceed：criteria 会随 forbidden 收缩，第二次问就只剩 Proceed。
    const report = await mw.run("complete checkout", page(), {
      slots: {}, goalSignalFn: (p) => checkSignal(p as never, SIGNAL),
      adjudicate: true, effect: { irreversible: false }, verbose: false,
    });
    // 第一次裁决落在 Store：执行了、非惰性、信号没成立 → 记 laya:adjudicated 且该元素被禁；
    // 第二次问模型只剩 Proceed（store 已 forbidden），再裁决 → DONE。
    const adjudicated = report.steps.filter((s) => s.method === "laya:adjudicated");
    expect(adjudicated.length).toBeGreaterThanOrEqual(2);
    expect(report.done).toBe(true);
    // 白跑的那一步：desc 是 Store，且它没有把子目标判成 done（done 来自 Proceed 那一步）
    expect(adjudicated[0]!.desc).toContain("Store");
  }, 120_000);
});
