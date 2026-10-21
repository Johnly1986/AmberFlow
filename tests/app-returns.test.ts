/**
 * 返回值传递（Slice 2，docs/APP_SUPPORTER_DESIGN.md §5）——离线夹具版本，CI 无条件可跑。
 *
 * 钉子：
 *   ① 加载期对账：`{dataset:NAME}` 必须有产者；`returns` 名字唯一；抽取器形状/名字非法要红；
 *   ② 运行期：`returns` **只在信号成立后**写入数据集（带溯源）；下一步以 `{dataset:NAME}` 消费；
 *   ③ 缺失值 = 结构化 `needs_value`（不猜、不静默用空串），且不产生任何副作用。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPack, validatePack, type AppPack } from "../src/app/app-pack.ts";
import { runApp, type AppRunOptions } from "../src/app/app-runner.ts";
import { tmpDir } from "./fixtures.ts";

/** 把一份声明写成临时应用包并加载（走真实的加载期校验）。 */
function packOf(decl: Record<string, unknown>): AppPack {
  const dir = tmpDir("returns-pack-");
  fs.mkdirSync(path.join(dir, "app"), { recursive: true });
  const file = path.join(dir, "app", "pack.json");
  fs.writeFileSync(file, JSON.stringify(decl, null, 2), "utf-8");
  return loadPack(file);
}

const base = (journey: unknown[]): Record<string, unknown> => ({
  spec_version: 1, id: "returns-demo", label: "returns-demo", goal: "返回值传递演示",
  model: "english", journey,
});

const optsOf = (): { opts: AppRunOptions } => {
  const out = tmpDir("returns-out-");
  return { opts: { sources: false, verbose: false, outDir: out, planPath: path.join(out, "plan.json") } };
};

describe("①加载期对账：产者/消费者/抽取器", () => {
  it("引用了没有产者的 {dataset:NAME} ⇒ 加载期红（不是运行期静默 needs_value）", () => {
    const pack = packOf(base([
      { id: "consume", desc: "消费一个不存在值", source: "demo-tool", args: ["--query={dataset:who}"],
        signal: { exit_ok: true } },
    ]));
    expect(validatePack(pack).join(" | ")).toContain("has no producer");
  });

  it("两个步产出同名值 ⇒ 红（数据集会静默按后写者赢）", () => {
    const pack = packOf(base([
      { id: "a", desc: "产者 A", source: "demo-tool", args: ["--query=a"], signal: { exit_ok: true },
        returns: { who: { from: "stdout" } } },
      { id: "b", desc: "产者 B", source: "demo-tool", args: ["--query=b"], signal: { exit_ok: true },
        returns: { who: { from: "stdout" } } },
    ]));
    expect(validatePack(pack).join(" | ")).toContain("returns names must be unique");
  });

  it("坏抽取器：未知 from / regex 缺 pattern / 名字非法 ⇒ 全部加载期红", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ who: { from: "magic" } }, "must be one of stdout"],
      [{ who: { from: "stdout_regex" } }, "pattern: required"],
      [{ "bad name": { from: "stdout" } }, "name must match"],
    ];
    for (const [returns, snippet] of cases) {
      const pack = packOf(base([
        { id: "a", desc: "产者", source: "demo-tool", signal: { exit_ok: true }, returns },
      ]));
      expect(validatePack(pack).join(" | ")).toContain(snippet);
    }
  });
});

describe("②运行期：returns → 数据集 → 下一步消费（真实桩工具进程）", () => {
  it("cli 步产出 stdout_regex 值 → 下一步 argv 用 {dataset:who} 消费；数据集有溯源", async () => {
    const pack = packOf(base([
      { id: "produce", desc: "产出单词", source: "demo-tool", args: ["--query=widgets"],
        signal: { exit_ok: true },
        returns: { who: { from: "stdout_regex", pattern: '"query":\\s*"([a-z]+)"' } } },
      { id: "consume", desc: "消费单词", source: "demo-tool", args: ["--query={dataset:who}"],
        signal: { exit_ok: true, stdout_contains: "widget widgets" } },
    ]));
    const { opts } = optsOf();
    const res = await runApp(pack, opts);
    expect(res.ok).toBe(true);
    expect(res.completed).toBe("2/2");
    // 第一步真的把值抽出来了（并写进 tool_steps 证据面）
    expect(res.tool_steps[0]!.returns).toEqual({ who: "widgets" });
    // 第二步真的收到了替换后的 argv
    expect(res.tool_steps[1]!.argv.some((a) => a.includes("--query=widgets"))).toBe(true);
    // 数据集审计面：值 + 溯源（stepId#attempt），不是模型转述
    const view = res.dataset_view ?? [];
    expect(view.find((e) => e.key === "who")).toMatchObject({
      value: "widgets", writtenBy: "produce#1", stale: false,
    });
    expect(res.dataset_view).toBeDefined();
  });

  it("产者信号不成立 ⇒ 不写数据集；消费者结构化 needs_value（不猜、不空串）", async () => {
    const pack = packOf(base([
      { id: "produce", desc: "注定失败", source: "demo-tool", args: ["--fail"],
        signal: { exit_ok: true }, returns: { who: { from: "stdout" } } },
      { id: "consume", desc: "消费一个没产出的值", source: "demo-tool", args: ["--query={dataset:who}"],
        signal: { exit_ok: true } },
    ]));
    const { opts } = optsOf();
    const res = await runApp(pack, opts);
    expect(res.ok).toBe(false);
    expect(res.tool_steps[0]!.done).toBe(false);
    expect(res.dataset_view).toBeUndefined();          // 信号不成立 = 一个字都不写
    const consume = res.tool_steps.find((t) => t.desc.includes("消费"))!;
    expect(consume.refused).toBe("needs_value");
    expect(consume.stderr).toContain("missing dataset value(s): who");
  });

  it("信号成立但抽取器抽不到 ⇒ 该名字如实缺席（不编造值）", async () => {
    const pack = packOf(base([
      { id: "produce", desc: "产出", source: "demo-tool", args: ["--query=widgets"],
        signal: { exit_ok: true },
        returns: { missing: { from: "stdout_regex", pattern: 'NO_SUCH_(\\d+)' } } },
    ]));
    const { opts } = optsOf();
    const res = await runApp(pack, opts);
    expect(res.ok).toBe(true);
    expect(res.tool_steps[0]!.returns).toEqual({});    // 有 returns 动作，但一个值也没抽到
  });
});
