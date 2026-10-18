/**
 * `stdio` 应用支持器（游戏/交互式进程）——离线真实场景（CI 无条件可跑，只依赖 node）。
 *
 * 钉子：
 *   ① 声明面：结构化 `stdio` 块 + 交互脚本 `{when, send}`；retries/dangerous 加载期拒绝；
 *   ② 运行期：真实子进程的**持续双向会话**（看提示 → 回一行 → … → 完成信号），
 *      完成仍只认该步自己的进程观察信号；超时 = 结构化失败（不挂死、不抛栈）；
 *   ③ 传值：`{dataset:NAME}` 可喂 argv 与 `send`；缺失 = needs_value（且**不启动进程**）。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPack, validatePack, type AppPack } from "../src/app-pack.ts";
import { runApp, type AppRunOptions } from "../src/app-runner.ts";
import { tmpDir } from "./fixtures.ts";

function packOf(decl: Record<string, unknown>): AppPack {
  const dir = tmpDir("stdio-pack-");
  fs.mkdirSync(path.join(dir, "app"), { recursive: true });
  const file = path.join(dir, "app", "pack.json");
  fs.writeFileSync(file, JSON.stringify(decl, null, 2), "utf-8");
  return loadPack(file);
}

const base = (journey: unknown[]): Record<string, unknown> => ({
  spec_version: 1, id: "stdio-demo", label: "stdio-demo", goal: "交互式进程演示",
  model: "english", journey,
});

const GAME_ARGV = ["node", "bench/fixtures/guess-game.mjs", "--secret=42"];
const WIN_SCRIPT = [
  { when: "Guess a number", send: "50" },
  { when: "Too high", send: "25" },
  { when: "Too low", send: "37" },
  { when: "Too low", send: "43" },
  { when: "Too high", send: "40" },
  { when: "Too low", send: "41" },
  { when: "Too low", send: "42" },
];
const gameStep = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "game", adapter: "stdio", desc: "玩一局猜数字（真实交互进程）",
  stdio: { argv: GAME_ARGV, script: WIN_SCRIPT, timeout_ms: 20_000 },
  signal: { exit_ok: true, stdout_contains: "You win" },
  returns: { tries: { from: "stdout_regex", pattern: "in (\\d+) tries" } },
  ...over,
});

const optsOf = (): AppRunOptions => {
  const out = tmpDir("stdio-out-");
  return { sources: false, verbose: false, outDir: out, planPath: path.join(out, "plan.json") };
};

describe("①声明面：stdio 块与交互脚本（加载期）", () => {
  it("合法 stdio 步通过校验；信号是进程观察面（exit/stdout）", () => {
    expect(validatePack(packOf(base([gameStep()])))).toEqual([]);
  });

  it("坏声明：缺块/未知键/缺脚本/坏正则/retries/dangerous —— 全部加载期红", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ stdio: undefined }, "stdio: a stdio step needs an object"],
      [{ stdio: { argv: GAME_ARGV, script: WIN_SCRIPT, bogus: 1 } }, "stdio.bogus: unknown key"],
      [{ stdio: { argv: GAME_ARGV } }, "stdio.script: a non-empty list"],
      [{ stdio: { argv: GAME_ARGV, script: [{ when: "([", send: "1" }] } }, "stdio.script[0].when: invalid regex"],
      [{ retries: 2 }, "不支持 retries"],
      [{ dangerous: true }, "stdio 的危险步/干跑语义尚未实现"],
    ];
    for (const [over, snippet] of cases) {
      expect(validatePack(packOf(base([gameStep(over)]))).join(" | ")).toContain(snippet);
    }
  });

  it("stdio 专属键写进 web 步 ⇒ 点名归属（类型白名单）", () => {
    const pack = packOf(base([{
      id: "w", adapter: "web", desc: "web 步", start_url: "testpages/product.html",
      target_hint: "[data-test=add-to-cart]", signal: { css_exists: "main" },
      stdio: { argv: ["node", "x"], script: [{ when: ".*", send: "1" }] },
    }]));
    expect(validatePack(pack).join(" | ")).toContain("stdio-only key on a browser step");
  });
});

describe("②运行期：真实交互式会话（提示 → 应答 → 信号）", () => {
  it("猜数字游戏真跑：7 次猜中、退出码 0、returns 抽到 tries、数据集有溯源", async () => {
    const res = await runApp(packOf(base([gameStep()])), optsOf());
    expect(res.ok).toBe(true);
    expect(res.completed).toBe("1/1");
    const t = res.tool_steps[0]!;
    expect(t.done).toBe(true);
    expect(t.code).toBe(0);
    expect(t.source).toBe("stdio:node");
    expect(t.stdout).toContain("You win in 7 tries");
    expect(t.returns).toEqual({ tries: "7" });
    expect(res.dataset_view?.find((e) => e.key === "tries"))
      .toMatchObject({ value: "7", writtenBy: "game#1", stale: false });
  });

  it("超时 = 结构化失败：进程被杀、如实写 timed out（不挂死、不抛栈）", async () => {
    const st = gameStep({
      stdio: { argv: GAME_ARGV, script: [{ when: "Guess a number", send: "1" }], timeout_ms: 1_200 },
      signal: { exit_ok: true, stdout_contains: "You win" },
      returns: undefined,
    });
    const started = Date.now();
    const res = await runApp(packOf(base([st])), optsOf());
    expect(Date.now() - started).toBeLessThan(30_000);
    const t = res.tool_steps[0]!;
    expect(res.ok).toBe(false);
    expect(t.done).toBe(false);
    expect(t.stderr).toContain("timed out after 1200ms");
  });
});

describe("③传值：{dataset:NAME} 喂 stdio 的 argv / send", () => {
  it("cli 产出的值喂给游戏的第一猜（真的一次跨类型传递）", async () => {
    const pack = packOf(base([
      {
        id: "produce", adapter: "cli", desc: "产出一个数字",
        source: "demo-tool", signal: { exit_ok: true },
        // 桩工具的固定输出里第一行价格是 12.5（确定性）：抽出来当游戏的"第一猜"。
        returns: { first: { from: "stdout_regex", pattern: '"price":\\s*([0-9.]+)' } } },
      {
        ...gameStep(),
        stdio: {
          argv: GAME_ARGV,
          // 第一猜是 12.5（Too low）⇒ 之后的应答顺序按"低/低/高/低/低/中"排
          script: [
            { when: "Guess a number", send: "{dataset:first}" },
            { when: "Too low", send: "25" },
            { when: "Too low", send: "37" },
            { when: "Too low", send: "43" },
            { when: "Too high", send: "40" },
            { when: "Too low", send: "41" },
            { when: "Too low", send: "42" },
          ],
          timeout_ms: 20_000,
        },
      },
    ]));
    const res = await runApp(pack, optsOf());
    expect(res.ok).toBe(true);
    expect(res.tool_steps[1]!.stdout).toContain("You win in 7 tries");
    expect(res.dataset_view?.find((e) => e.key === "first")).toMatchObject({ value: "12.5", writtenBy: "produce#1" });
  });

  it("缺失数据集值 ⇒ needs_value，且**不启动进程**（没有开局的 Guess 提示）", async () => {
    const pack = packOf(base([
      { id: "produce", adapter: "cli", desc: "注定失败", source: "demo-tool", args: ["--fail"],
        signal: { exit_ok: true }, returns: { first: { from: "stdout" } } },
      {
        ...gameStep(),
        stdio: {
          argv: GAME_ARGV,
          script: [{ when: "Guess a number", send: "{dataset:first}" }],
          timeout_ms: 5_000,
        },
      },
    ]));
    const res = await runApp(pack, optsOf());
    expect(res.ok).toBe(false);
    const t = res.tool_steps.find((x) => x.desc.includes("猜数字"))!;
    expect(t.refused).toBe("needs_value");
    expect(t.stdout).toBe("");                       // 进程根本没起来
    expect(t.stderr).toContain("missing dataset value(s): first");
  });
});
