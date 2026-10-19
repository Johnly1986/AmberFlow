/**
 * 类型无关的结束态不变量（Slice 4，docs/APP_SUPPORTER_DESIGN.md §14）。
 *
 * 钉子：
 *   ① web 不变量 = 浏览器结束态（既有语义，不变；需要浏览器步）；
 *   ② 进程族不变量（cli/ssh/stdio）= 旅程结束后的**只读观察探针**，不需要浏览器步，
 *      借用该适配器自己的声明面/信号语言校验；
 *   ③ 断言纪律：不变量不许 retries / dangerous / when（证据不能靠重跑、副作用或条件换）；
 *   ④ 探针失败 = 不变量不成立（整趟旅程如实变红），不是被忽略。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPack, validatePack, type AppPack } from "../src/app-pack.ts";
import { runApp, type AppRunOptions } from "../src/app-runner.ts";
import { tmpDir } from "./fixtures.ts";

function packOf(decl: Record<string, unknown>): AppPack {
  const dir = tmpDir("inv-pack-");
  fs.mkdirSync(path.join(dir, "app"), { recursive: true });
  const file = path.join(dir, "app", "pack.json");
  fs.writeFileSync(file, JSON.stringify(decl, null, 2), "utf-8");
  return loadPack(file);
}

const base = (journey: unknown[], invariants: unknown[]): Record<string, unknown> => ({
  spec_version: 1, id: "inv-demo", label: "inv-demo", goal: "不变量演示", model: "english",
  journey, invariants,
});

const cliOk = (id: string): Record<string, unknown> => ({
  id, adapter: "cli", desc: "跑一次桩工具",
  source: "demo-tool", signal: { exit_ok: true },
});

const optsOf = (): AppRunOptions => {
  const out = tmpDir("inv-out-");
  return { sources: false, verbose: false, outDir: out, planPath: path.join(out, "plan.json") };
};

describe("①声明面：不变量按类型分派（加载期）", () => {
  it("进程族不变量不需要浏览器步；cli 探针的声明面/信号走 cli 适配器校验", () => {
    const pack = packOf(base([cliOk("run")], [
      {
        id: "error-path", adapter: "cli", desc: "错误路径仍可观察",
        source: "demo-tool", args: ["--fail"],
        signal: { all_of: [{ exit_code_equals: 3 }, { stderr_contains: "boom" }] },
      },
    ]));
    expect(validatePack(pack)).toEqual([]);
  });

  it("web 不变量仍需要浏览器步（既有语义不变）", () => {
    const pack = packOf(base([cliOk("run")], [
      { id: "browser-only", signal: { css_exists: "[data-test=order-ok]" } },
    ]));
    expect(validatePack(pack).join(" | ")).toContain("web invariants need at least one browser step");
  });

  it("断言纪律：未知 adapter/dangerous/retries/when/未知键 全部加载期红", () => {
    const cases: Array<[unknown, string]> = [
      [{ id: "x", adapter: "telnet", signal: { exit_ok: true } }, "unknown app adapter"],
      [{ id: "x", adapter: "cli", source: "demo-tool", signal: { exit_ok: true }, dangerous: true },
        "不变量探针必须是只读观察"],
      [{ id: "x", adapter: "cli", source: "demo-tool", signal: { exit_ok: true }, retries: 1 },
        "不变量探针不许重试"],
      [{ id: "x", adapter: "cli", source: "demo-tool", signal: { exit_ok: true }, when: { exit_ok: true } },
        "不接受 when"],
      [{ id: "x", adapter: "cli", source: "demo-tool", signal: { exit_ok: true }, start_url: "x" },
        "unknown key on a tool invariant"],
    ];
    for (const [inv, snippet] of cases) {
      const pack = packOf(base([cliOk("run")], [inv]));
      expect(validatePack(pack).join(" | ")).toContain(snippet);
    }
  });
});

describe("②运行期：只读观察探针（离线、无浏览器）", () => {
  it("cli 不变量探针在旅程结束后执行；成立 ⇒ held，结果带类型标注", async () => {
    const pack = packOf(base([cliOk("run")], [
      {
        id: "error-path", adapter: "cli", desc: "错误路径仍可观察",
        source: "demo-tool", args: ["--fail"],
        signal: { all_of: [{ exit_code_equals: 3 }, { stderr_contains: "boom" }] },
      },
      { id: "ok", adapter: "cli", desc: "成功路径可观察", source: "demo-tool", signal: { exit_ok: true } },
    ]));
    const res = await runApp(pack, optsOf());
    expect(res.ok).toBe(true);
    expect(res.invariants).toEqual([
      { id: "error-path", desc: "错误路径仍可观察", held: true, adapter: "cli" },
      { id: "ok", desc: "成功路径可观察", held: true, adapter: "cli" },
    ]);
    // 探针不混进 journey 的 tool_steps（账要分得清：旅程 vs 验收）
    expect(res.tool_steps.length).toBe(1);
  });

  it("探针失败 = 不变量不成立（整趟旅程如实变红）", async () => {
    const pack = packOf(base([cliOk("run")], [
      {
        id: "impossible", adapter: "cli", desc: "错误路径按成功断言（必然不成立）",
        source: "demo-tool", args: ["--fail"], signal: { exit_ok: true },
      },
    ]));
    const res = await runApp(pack, optsOf());
    expect(res.ok).toBe(false);
    expect(res.invariants[0]).toMatchObject({ id: "impossible", held: false, adapter: "cli" });
  });

  it("单一类型应用的产物里不出现 step_types（缺省等价纪律）", async () => {
    const res = await runApp(packOf(base([cliOk("a"), cliOk("b")], [])), optsOf());
    expect(res.step_types).toBeUndefined();
  });
});
