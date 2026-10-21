/**
 * ssh 支持器 + 同一旅程跨类型 + 返回值传递（Slice 2，docs/APP_SUPPORTER_DESIGN.md §8）。
 *
 * **真实场景**：本机 sshd（`ssh localhost` key 认证）。不可用时**如实跳过**（打印原因；跳过 ≠ 通过）——
 * CI 上通常跳过，有 sshd 的机器（本仓库的开发机已实测可用）真跑。
 *
 * 钉子：
 *   ① 同一旅程混用 web / cli / ssh 三种类型（类型由适配器注册表分派，不是 runner 的 if 分支）；
 *   ② 返回值跨类型传递：cli 的 stdout_regex → 数据集 → ssh 远端命令的 `{dataset:NAME}`；
 *      ssh 的 stdout_regex → 数据集 → 下一 cli 步的 argv；
 *   ③ 真实副作用的证据在机器上可查（远端文件内容 = 传过去的值）；
 *   ④ 连不上 = 结构化失败（不抛栈、不假装成功）。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sshReady } from "../src/app/app-adapters.ts";
import { loadPack, type AppPack } from "../src/app/app-pack.ts";
import { runApp } from "../src/app/app-runner.ts";
import { tmpDir } from "./fixtures.ts";

const probe = sshReady();
if (!probe.ready) console.warn(`SKIP app-ssh（真实场景不可用）：${probe.reason ?? "unknown"}`);
const d = probe.ready ? describe : describe.skip;

function packOf(decl: Record<string, unknown>): AppPack {
  const dir = tmpDir("ssh-pack-");
  fs.mkdirSync(path.join(dir, "app"), { recursive: true });
  const file = path.join(dir, "app", "pack.json");
  fs.writeFileSync(file, JSON.stringify(decl, null, 2), "utf-8");
  return loadPack(file);
}

const MARKER_DIR = "/tmp/amberflow-ssh-slice2";

d("ssh 支持器（真实本机 sshd）：跨类型旅程 + 返回值传递", () => {
  it("web → cli → ssh → cli 同一旅程；cli 值喂 ssh、ssh 值喂下一步 cli；真实远端文件可查", { timeout: 180_000 }, async () => {
    fs.rmSync(MARKER_DIR, { recursive: true, force: true });
    try {
      const pack = packOf({
        spec_version: 1, id: "mixed-types", label: "mixed-types", goal: "跨类型旅程", model: "english",
        journey: [
          {
            id: "web-cart", adapter: "web", desc: "把商品加入购物车",
            start_url: "testpages/product.html", target_hint: "button[data-test=add-to-cart]",
            signal: { css_text_equals: ["[data-test=cart-count]", "1"] },
          },
          {
            id: "produce", adapter: "cli", desc: "产出单词（cli）",
            source: "demo-tool", args: ["--query=widgets"],
            signal: { exit_ok: true },
            returns: { token: { from: "stdout_regex", pattern: '"query":\\s*"([a-z]+)"' } },
          },
          {
            id: "remote", adapter: "ssh", desc: "在远端写令牌并读回（ssh）",
            ssh: {
              host: "localhost",
              argv: [`mkdir -p ${MARKER_DIR} && echo {dataset:token} > ${MARKER_DIR}/token && cat ${MARKER_DIR}/token`],
            },
            signal: { exit_ok: true, stdout_contains: "widgets" },
            returns: { remote: { from: "stdout_regex", pattern: "([a-z]+)" } },
          },
          {
            id: "consume", adapter: "cli", desc: "消费远端值（cli）",
            source: "demo-tool", args: ["--query={dataset:remote}"],
            signal: { exit_ok: true, stdout_contains: "widget widgets" },
          },
        ],
        invariants: [{ id: "cart-has-item", signal: { css_text_equals: ["[data-test=cart-count]", "1"] } }],
      });
      const out = tmpDir("ssh-out-");
      const res = await runApp(pack, {
        sources: false, verbose: false, outDir: out, planPath: path.join(out, "plan.json"),
      });
      expect(res.ok).toBe(true);
      expect(res.completed).toBe("4/4");
      // 三种类型都在同一旅程里真执行了（web 步进计划，cli/ssh 进 tool_steps）
      expect(res.subgoals.filter((s) => s.status === "done").length).toBe(1);
      expect(res.tool_steps.map((t) => t.source)).toEqual(["demo-tool", "ssh:localhost", "demo-tool"]);
      // 真实的远端副作用：远端命令收到的值落到了机器上（本机 sshd = 同一台机器，文件内容可查）
      expect(fs.readFileSync(path.join(MARKER_DIR, "token"), "utf-8").trim()).toBe("widgets");
      // 返回值跨类型的审计面：值 + 溯源（哪个步、第几次尝试）
      expect(res.dataset_view?.find((e) => e.key === "token"))
        .toMatchObject({ value: "widgets", writtenBy: "produce#1", stale: false });
      expect(res.dataset_view?.find((e) => e.key === "remote"))
        .toMatchObject({ value: "widgets", writtenBy: "remote#1", stale: false });
      // 替换真的进了 ssh 的 argv（不是"只在报告里好看"）
      expect(res.tool_steps[1]!.argv.join(" ")).toContain(`echo widgets > ${MARKER_DIR}/token`);
      // ssh 的返回值真的喂给了下一步的 argv
      expect(res.tool_steps[2]!.argv.some((a) => a.includes("--query=widgets"))).toBe(true);
    } finally {
      fs.rmSync(MARKER_DIR, { recursive: true, force: true });
    }
  });

  it("ssh 连不上 = 结构化失败（不抛栈、不假装成功）", { timeout: 120_000 }, async () => {
    const pack = packOf({
      spec_version: 1, id: "ssh-bad", label: "ssh-bad", goal: "连不上", model: "english",
      journey: [{
        id: "bad", adapter: "ssh", desc: "连不上的 ssh",
        ssh: { host: "localhost", port: 1, argv: ["true"] },
        signal: { exit_ok: true },
      }],
    });
    const out = tmpDir("ssh-bad-out-");
    const res = await runApp(pack, {
      sources: false, verbose: false, outDir: out, planPath: path.join(out, "plan.json"),
    });
    expect(res.ok).toBe(false);
    const bad = res.tool_steps[0]!;
    expect(bad.done).toBe(false);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr.length).toBeGreaterThan(0);
  });
});
