/**
 * 梯级账单（docs/ARCHITECTURE_IMPROVEMENTS.md §5）：**没出场的梯级要有数字**。
 *
 * 为什么单独一个文件：`tools/apps_suite.ts` 的 `suite()` 在进程里 `installLayaRuntime(自己的缓存+计数缝)`，
 * 会顶掉别的测试文件在 `beforeAll` 里装的缝——放一起跑，后面那些"slowjet 咨询 ≥1"的断言就会
 * 因为计数走错了缝而全变 0（本轮实测踩过）。vitest 按文件隔离进程，所以拆开来才是诚实的写法。
 */
import { describe, expect, it } from "vitest";
import { loadPack } from "../src/app-pack.ts";
import { summarizeDecisions } from "../src/app-runner.ts";
import { suite } from "../tools/apps_suite.ts";

describe("梯级账单：每一级的独立决定数与 dead rung", () => {
  it("summarizeDecisions 的 ladder 就是同一份 trace 的另一只眼（不自造数）", () => {
    const d = summarizeDecisions(
      [
        { method: "rule:match", conf: 1 },
        { method: "rule:match", conf: 1 },
        { method: "laya", conf: 0.31 },
        { method: "laya:reobserve", conf: 0.4 },
        { method: "escalate", conf: 1 },
      ] as never, null, 9,
    );
    expect(d.ladder).toEqual({ rule: 2, laya: 1, reobserve: 1, escalate: 1, asked_not_passed: 7 });
    // 对账：ladder 不许和 by_method / model_steps 打架
    expect(d.ladder.rule).toBe(d.by_method["rule:match"]);
    expect(d.ladder.laya + d.ladder.reobserve).toBe(d.model_steps);
  });

  it("套件行带 rule_steps/escalate（聚合层的 dead rung 判定靠这两列）", async () => {
    const { rows } = await suite(["demo-app"]);
    expect(rows.length).toBe(1);
    expect(typeof rows[0]!.rule_steps).toBe("number");
    expect(rows[0]!.rule_steps).toBeGreaterThan(0);   // demo-app 全规则消化
    expect(rows[0]!.escalate).toBe(0);                // 没有端点 ⇒ 这一级恒 0 = dead rung
  }, 240_000);
});
