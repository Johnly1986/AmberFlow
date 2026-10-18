/**
 * 全类型混合旅程的真实场景验收：`apps/mixed-demo`（web + cli + ssh + stdio 一条旅程）。
 *
 * **真实场景**：本机 sshd + 真实交互式子进程（`bench/fixtures/guess-game.mjs`）；无 sshd 时
 * 打印原因跳过（跳过 ≠ 通过），有 sshd 的机器（本仓库开发机已实测）真跑。
 *
 * 钉子：
 *   ① 同一旅程混用四种应用类型（类型由适配器注册表分派，不是 runner 的类型分支）；
 *   ② 返回值三条通路都真的成立：cli→ssh、ssh→浏览器命令绑定 `{from:"dataset"}`、
 *      stdio（游戏）→cli；数据集有值 + 溯源；
 *   ③ 真实副作用可查（远端写出的文件内容 = 传过去的值）；
 *   ④ 浏览器结束态不变量成立（且它是在后续 cli/ssh/stdio 步骤之后求值的）。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sshReady } from "../src/app-adapters.ts";
import { loadPack } from "../src/app-pack.ts";
import { appReportMarkdown, runApp } from "../src/app-runner.ts";
import { tmpDir } from "./fixtures.ts";

const probe = sshReady();
if (!probe.ready) console.warn(`SKIP app-mixed（真实场景不可用）：${probe.reason ?? "unknown"}`);
const d = probe.ready ? describe : describe.skip;

d("apps/mixed-demo：web+cli+ssh+stdio 的同一旅程（真实本机 sshd + 真实交互进程）", () => {
  it("7/7 步通过；返回值三条通路 + 真实副作用 + 浏览器结束态不变量", { timeout: 180_000 }, async () => {
    const out = tmpDir("mixed-out-");
    const res = await runApp(loadPack("mixed-demo"), {
      sources: false, verbose: false, outDir: out, planPath: path.join(out, "plan.json"),
    });
    expect(res.ok).toBe(true);
    expect(res.completed).toBe("7/7");

    // ① 四种类型都在同一条旅程里真执行：web 步进计划（2 个），cli/ssh/stdio 进 tool_steps（5 个）
    expect(res.subgoals.filter((s) => s.status === "done").length).toBe(2);
    expect(res.tool_steps.map((t) => t.source)).toEqual(
      ["demo-tool", "ssh:localhost", "demo-tool", "stdio:node", "demo-tool"],
    );
    expect(res.tool_steps.every((t) => t.done)).toBe(true);

    // ② 返回值三条通路：cli→ssh（token）、ssh→浏览器命令绑定（coupon）、stdio→cli（tries）
    const view = res.dataset_view ?? [];
    const byKey = new Map(view.map((e) => [e.key, e]));
    expect(byKey.get("token")).toMatchObject({ value: "widgets", writtenBy: "produce-token#1" });
    expect(byKey.get("remote")).toMatchObject({ value: "widgets", writtenBy: "remote#1" });
    expect(byKey.get("coupon")).toMatchObject({ value: "ACME10", writtenBy: "remote#1" });
    expect(byKey.get("tries")).toMatchObject({ value: "7", writtenBy: "game#1" });
    // ssh 真的收到了 {dataset:token} 替换后的值
    expect(res.tool_steps[1]!.argv.join(" ")).toContain("echo widgets");
    // stdio 的返回值真的进了下一步 cli 的 argv（桩工具把 argv 原样回显，信号即证据）
    expect(res.tool_steps[4]!.argv.some((a) => a.includes("--query=7"))).toBe(true);

    // ③ 真实副作用：远端写出的文件内容 = 传过去的值（本机 sshd = 同一台机器，可直接查）
    const fs = await import("node:fs");
    expect(fs.readFileSync(path.join(out, "ssh-token"), "utf-8").trim()).toBe("widgets");

    // ④ 浏览器结束态不变量（在 cli/ssh/stdio 步骤之后求值）；浏览器侧的优惠券值是数据集喂的
    expect(res.invariants.map((i) => [i.id, i.held])).toEqual([["coupon-applied", true]]);

    // 报告里数据传递是一等公民（不是只藏在 JSON 里）
    const md = appReportMarkdown(res);
    expect(md).toContain("数据传递");
    expect(md).toContain("coupon=\"ACME10\"");
  });
});
