/**
 * **漂移族**（docs/ARCHITECTURE_IMPROVEMENTS.md §7 = 实施计划的 W3）：
 * 弹性不是一个可以"声称"的属性，而是**一族必须逐类计价的行为**。
 *
 * 在此之前，仓库里证明"声明在承重"的证据只有一次**临时 A/B**（把 hint 全删掉 → 4/4 → 0/4），
 * 没有任何门禁会在"页面变了"时给出信号。这个文件把五类真实漂移各做成一份固定夹具，
 * 每类跑两种点名方式（属性句柄 / 可见标签），把**恢复率**变成表里的数。
 *
 * 期望表写的是**本轮实测出来的事实**，不是愿望：今天红的那几类，要等 W4
 * （窄问 + 按问法归一的闸门）落地时**逐格改这张表**——而不是把断言松掉。
 *
 * 夹具都在 `testpages/drift/`，离线、零站点知识。模型侧是**故意很差**的脚本桩
 * （任何点名都只给 0.10 置信）：这一族量的是"规则/hint 失效之后还剩多少"，
 * 不是"模型多聪明"——模型的真实水位另有 `npm run model:contribution` 与漂移族的对照实验。
 */
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BrowserMiddleware } from "../src/executor.ts";
import { checkSignal } from "../src/signals.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer, type Question } from "../src/model.ts";

afterAll(() => installLayaRuntime(null));

const PAGES = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "testpages", "drift");
const urlOf = (f: string): string => `file://${path.join(PAGES, f)}`;

/** 一个"什么都不是很有把握"的模型：给了候选也只到 0.10 ⇒ 低于 0.25 闸门。 */
function unsureModel(): void {
  installLayaRuntime(scriptedRuntime(scriptedAgent((key, _s, questions): Answer | undefined => {
    if (key === "r") return { noul: 0.05 };
    if (key === "d") return { noul: 0.0 };
    if (key === "act") {
      const crit = (questions["act"]!.criteria ?? {}) as Record<string, string>;
      const first = Object.keys(crit)[0];
      // ChoiceAnswer 要带概率分布：没有分布，执行器的闸门就没有输入。
      return first
        ? { choice: first, confidence: 0.1, probabilities: { [first]: 0.1 } }
        : undefined;
    }
    return undefined;
  }) as never));
}

/** 一次点名：hint 可以是属性句柄（`[data-test=save]`），也可以是可见标签（`保存`）。 */
async function attempt(file: string, hint: string): Promise<{ done: boolean; method?: string; stop?: string }> {
  unsureModel();
  const mw = new BrowserMiddleware({ maxSteps: 3, confirmFn: () => true });
  const report = await mw.run("保存这单的设置", urlOf(file), {
    slots: {},
    targetHint: hint,
    goalSignalFn: (p) => checkSignal(p as never, { url_contains: "saved.html" }),
    verbose: false,
  });
  return {
    done: report.done === true,
    method: report.steps[0]?.["method"] as string | undefined,
    stop: report.stop_reason,
  };
}


/**
 * 基线 + 五类漂移。每格 = (点名方式 → 期望结果 + 原因)。
 * 期望是本轮实测记账：`attr` 用属性句柄点名，`label` 用可见文字点名。
 */
const FAMILY: Array<{
  file: string; drift: string;
  attr: { ok: boolean; why: string };
  label: { ok: boolean; why: string };
}> = [
  {
    file: "base.html", drift: "基线（没有漂移）",
    attr: { ok: true, why: "句柄在" },
    label: { ok: true, why: "标签在" },
  },
  {
    file: "d1-renamed-id.html", drift: "① 改了 data-test（重构最常见的一种）",
    attr: { ok: false, why: "句柄不存在 ⇒ hint 落空 ⇒ 只能问模型 ⇒ 0.10 低于闸门" },
    label: { ok: true, why: "可见文字没变 ⇒ 标签点名不受影响" },
  },
  {
    file: "d2-wrapper.html", drift: "② 目标被包进一层 wrapper",
    attr: { ok: true, why: "属性匹配不看祖先层级" },
    label: { ok: true, why: "标签也没变" },
  },
  {
    file: "d3-button-to-a.html", drift: "③ button 换成 a（控件类型变了）",
    attr: { ok: true, why: "句柄没变；动作从 submit 变导航，信号仍是 URL" },
    label: { ok: true, why: "标签没变" },
  },
  {
    file: "d4-reworded.html", drift: "④ 文案改写（句柄在、文字变了）",
    attr: { ok: true, why: "属性句柄不受文案影响" },
    label: { ok: false, why: "『保存』→『提交订单』⇒ 标签点名落空" },
  },
  {
    file: "d5-mobile-dom.html", drift: "⑤ 桌面 DOM 换成手机版 DOM（qunar 那一类）",
    attr: { ok: false, why: "手机版页面根本没有 data-test ⇒ 与 device 未声明同一种失败" },
    label: { ok: true, why: "手机版仍写着『保存』（input[type=submit] 的 value）" },
  },
];

describe("漂移族：逐类计价（§7 / W3）", () => {
  const rows: Array<{ drift: string; attr: string; label: string }> = [];

  it("每一类的实际结果必须等于表里记账的期望（不许为了绿而松断言）", async () => {
    for (const f of FAMILY) {
      const a = await attempt(f.file, "[data-test=save]");
      const l = await attempt(f.file, "保存");
      rows.push({
        drift: f.drift,
        attr: `${a.done ? "绿" : "红"}（${a.method ?? a.stop?.slice(0, 24)}）`,
        label: `${l.done ? "绿" : "红"}（${l.method ?? l.stop?.slice(0, 24)}）`,
      });
      expect(a.done, `属性句柄点名 / ${f.drift}：${f.attr.why}`).toBe(f.attr.ok);
      expect(l.done, `标签点名 / ${f.drift}：${f.label.why}`).toBe(f.label.ok);
    }
    // 这张表就是"弹性"的账单：谁在承重、哪一类漂移今天没人兜。
    console.log("\n漂移族（同一旅程 × 两种点名方式）：");
    console.log("类别".padEnd(46), "属性句柄".padEnd(28), "可见标签");
    for (const r of rows) console.log(r.drift.padEnd(42), r.attr.padEnd(26), r.label);
    // 恢复率只算**漂移的那五类**（基线 trivially 绿，算进去就是自抬成绩）。
    const drifted = FAMILY.slice(1);
    const attrGreen = drifted.filter((f) => f.attr.ok).length;
    const labelGreen = drifted.filter((f) => f.label.ok).length;
    console.log(`恢复率（五类漂移）：属性句柄 ${attrGreen}/5 ｜ 可见标签 ${labelGreen}/5`
      + `（今天没有任何一级把红的那几类兜回来 —— 这就是 W4 的验收台）`);
  }, 300_000);

  it("红的那些类是**阻塞**而不是崩溃，且理由结构化（低置信 / 点名落空）", async () => {
    const dead = FAMILY.filter((f) => !f.attr.ok);
    expect(dead.length).toBeGreaterThan(0);
    for (const f of dead) {
      const r = await attempt(f.file, "[data-test=save]");
      expect(r.done).toBe(false);
      expect(String(r.stop)).toMatch(/confidence|no target|names no target/);
    }
  }, 300_000);
});
