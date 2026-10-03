/**
 * 独立对抗复核（task-2）：**应用包是数据，坏数据必须在加载期响亮地失败**。
 *
 * 这份文件不看作者叙述，只做两件事：
 *   1. **证伪优先**：把每一个"只在加载期炸"的声明都当成可被绕过的假设 —— 未知键 /
 *      未知角色 / 未声明槽位 / 未知 `{slot}` / 主机没进 `hosts` / 探针目标 id 悬空 /
 *      重复目标 id / `hosts` 写成了裸字符串 / 角色内联覆盖混用两种步型的键。每条都断言
 *      **消息内容**，而不是"它抛了错"。
 *   2. **同一条路径**：离线应用的验收跑 `runApp`（`src/app-runner.ts` 的 `main()` 除
 *      argv 解析与 `--no-model` 运行时安装外，全部逻辑都在这里），并用一次真实的
 *      `main()` 子进程证明"没干活 -> 退出码 1"这条链路真的通到进程退出码。
 *
 * 报告见 `bench/APP_VERIFY_REPORT.md`（逐条：题面 → 命令 → 原始观测 → 结论）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDirs, expandPack, loadPack, validatePack, type AppPack, type ExpandedStep } from "../src/app-pack.ts";
import { main as appMain, runApp, runToolStep } from "../src/app-runner.ts";
import { loadProbeSet } from "../src/probe-set.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime } from "../src/model.ts";
import type { ToolSignal } from "../src/tool-signals.ts";
import { matrix } from "../tools/apps_matrix.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** 捕获 `main()` 写到 stderr 的失败说明（CLI 的契约是"报清楚"，而不是抛栈）。 */
async function captureErr<T>(fn: () => Promise<T>): Promise<{ code: T; err: string }> {
  const orig = console.error;
  const lines: string[] = [];
  console.error = (...a: unknown[]) => { lines.push(a.map((x) => String(x)).join(" ")); };
  try {
    return { code: await fn(), err: lines.join("\n") };
  } finally {
    console.error = orig;
  }
}

const tmpDirs: string[] = [];
function tmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `app-verify-${tag}-`));
  tmpDirs.push(d);
  return d;
}

/** 把一份包写成临时 `pack.json`（**绝不改动仓库里的 apps/<id>/pack.json**）。 */
function tmpPack(tag: string, pack: unknown): string {
  const d = tmpDir(tag);
  const p = path.join(d, "pack.json");
  fs.writeFileSync(p, JSON.stringify(pack, null, 2), "utf-8");
  return p;
}

/** 走真实的加载路径（`expandPack` = `runApp`/CLI 的第一步），拿到**完整消息**。 */
function loadError(pack: AppPack): string {
  try {
    expandPack(pack, {}, path.join(os.tmpdir(), "app-verify-plan.json"));
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "";
}

/** 探针集的真实加载路径（`loadProbeSet` 直接读 pack.json，不经过 validatePack）。 */
function probeLoadError(pack: unknown): string {
  try {
    loadProbeSet(tmpPack("probe", pack));
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "";
}

const hasTool = (bin: string): boolean => {
  const r = spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
  return r.status === 0;
};

beforeAll(() => {
  installLayaRuntime(scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 }))));
});
afterAll(() => {
  installLayaRuntime(null);
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/* ==================================================== 坏包：加载期报错（消息点名） */

describe("坏应用包：加载期失败，且消息点出是哪一处", () => {
  const bad = (mutate: (p: any) => void): AppPack => {
    const p = clone(loadPack("demo-app")) as any;
    mutate(p);
    return p as AppPack;
  };

  it.each([
    ["未知包键", (p: any) => { p.whatever = 1; }, /whatever: unknown pack key/],
    ["未知角色", (p: any) => { p.journey[1] = { role: "ghost" }; }, /journey\[1\]: unknown role "ghost"/],
    ["未声明槽位的必填项", (p: any) => { p.required_slots = ["missing"]; }, /required slot "missing" has no value/],
    ["未知 {slot} 占位符", (p: any) => { p.roles["add-to-cart"].desc = "把 {nope} 加入购物车"; },
      /unknown slot placeholder \{nope\}/],
    ["宿主清单写成裸字符串", (p: any) => { p.hosts = "m.ctrip.com"; },
      /hosts must be a list of strings/],
    // 下面三条是"两种步型互斥键"在**角色内联覆盖**上的收紧（复核发现旧口径会把键静默丢掉）
    ["浏览器角色上写工具键", (p: any) => { p.journey[1] = { role: "add-to-cart", args: ["--ignored"] }; },
      /journey\[1\]\.args: tool-only key on a browser step/],
    ["工具步上写浏览器键", (p: any) => {
      p.journey[0] = { ...p.journey[0], start_url: "bench/fixtures/shop_home.html" };
    }, /journey\[0\]\.start_url: browser-only key on a tool step/],
    ["角色模板混用两种步型键", (p: any) => { p.roles["add-to-cart"].source = "demo-tool"; },
      /roles\.add-to-cart\.start_url: browser-only key on a tool step/],
  ])("%s", (_label, mutate, pattern) => {
    const msg = loadError(bad(mutate));
    // 完整形状：外层点名是哪个包，内层点出问题
    expect(msg).toMatch(/^app pack demo-app is invalid:\n {2}- /);
    expect(msg).toMatch(pattern);
  });

  it("未知信号算子也走同一套计划校验口径", () => {
    const msg = loadError(bad((p) => { p.roles.checkout.signal = { magic_op: "x" }; }));
    expect(msg).toContain("unknown signal op 'magic_op'");
  });

  it("runApp 在展开阶段就拒绝坏包（不是跑到一半才炸）", async () => {
    await expect(runApp(bad((p) => { p.journey[1] = { role: "ghost" }; }), { sources: false }))
      .rejects.toThrow(/unknown role "ghost"/);
  });

  it("合法包零问题：仓库里现有的每个应用包都通过 validatePack", () => {
    for (const dir of appDirs()) {
      const pack = loadPack(path.join(dir, "pack.json"));
      expect(validatePack(pack), `${pack.id}: ${JSON.stringify(validatePack(pack))}`).toEqual([]);
    }
  });
});

/* ==================================================== 坏探针集：加载期报错（消息点名） */

describe("坏探针集：loadProbeSet 加载期失败，且消息点出是哪一处", () => {
  const base = (): Record<string, unknown> => ({
    spec_version: 1, id: "probe-x", label: "probe-x", goal: "probe-x",
    hosts: ["m.ctrip.com"], journey: [],
  });

  it.each([
    ["URL 主机没进 hosts", { probe: { http: [{ id: "a", url: "https://evil.example/x" }] } },
      /probe\.http\[0\]\.url host "evil\.example" is not declared in pack\.hosts/],
    ["hosts 为空时也不许藏主机", { hosts: [], probe: { http: [{ id: "a", url: "https://evil.example/x" }] } },
      /is not declared in pack\.hosts/],
    ["探针目标 id 悬空（browser）",
      { probe: { http: [{ id: "a", url: "https://m.ctrip.com/x" }], browser: ["b"] } },
      /probe\.browser: "b" is not an http target id/],
    ["探针目标 id 悬空（repeat）",
      { probe: { http: [{ id: "a", url: "https://m.ctrip.com/x" }], repeat: { id: "z", times: 2 } } },
      /probe\.repeat\.id "z" is not an http target id/],
    ["探针目标 id 悬空（roles）",
      { probe: { http: [{ id: "a", url: "https://m.ctrip.com/x" }], roles: { flight: "b" } } },
      /probe\.roles\.flight: "b" is not an http target id/],
    ["重复目标 id", { probe: { http: [{ id: "a", url: "https://m.ctrip.com/1" }, { id: "a", url: "https://m.ctrip.com/2" }] } },
      /probe\.http: duplicate target ids/],
    ["未知探针键", { probe: { magic: 1 } }, /probe\.magic: unknown key/],
    ["未知日期占位符", { probe: { http: [{ id: "a", url: "https://m.ctrip.com/x?d={tomorrow}" }] } },
      /unknown placeholder \{tomorrow\}/],
    ["hosts 写成裸字符串", { hosts: "m.ctrip.com", probe: { http: [{ id: "a", url: "https://m.ctrip.com/x" }] } },
      /hosts must be a list of strings/],
    ["login.hosts 没声明", { probe: { login: { hosts: ["elsewhere.example"], paths: [] } } },
      /probe\.login\.hosts "elsewhere\.example" is not declared in pack\.hosts/],
  ])("%s", (_label, patch, pattern) => {
    const msg = probeLoadError({ ...base(), ...patch });
    expect(msg).toMatch(/^probe set .* is invalid:\n {2}- /);
    expect(msg).toMatch(pattern);
  });

  it("三个已提交的探针集仍然合法（收紧没有误伤）", () => {
    for (const id of ["ctrip-live", "ota-live", "qunar-live"]) {
      expect(() => loadProbeSet(id)).not.toThrow();
    }
  });
});

/* ==================================================== gateway：apps:matrix */

describe("门禁：apps:matrix 的泄漏与债都为空，应用目录 0 行代码", () => {
  it("leaks / debt 都为空，且每个应用目录的代码行数为 0", () => {
    const { rows, leaks, debt } = matrix();
    expect(leaks, JSON.stringify(leaks)).toEqual([]);
    expect(debt, JSON.stringify(debt)).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(9);
    for (const r of rows) expect(r.code, `${r.app} 代码行`).toBe(0);
    // 应用目录里真的没有代码文件（顶层与子目录都不许有 .ts/.js/.mjs/.cjs，bin/ 除外）
    const codeFiles: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== "bin") walk(p); }
        else if (/\.(ts|js|mjs|cjs)$/.test(e.name)) codeFiles.push(p);
      }
    };
    for (const dir of appDirs()) walk(dir);
    expect(codeFiles, codeFiles.join(", ")).toEqual([]);
  });

  it("声明的标识真的进了清单（否则防泄漏门禁是空转）", () => {
    const { rows } = matrix();
    const declared = new Set(rows.flatMap((r) => r.tokens));
    expect(declared.size).toBeGreaterThan(5);
    expect(declared.has("m.ctrip.com")).toBe(true);
    expect(declared.has("www.kayak.com")).toBe(true);
  });
});

/* ==================================================== 离线应用的验收（同一条路径） */

describe("离线应用：验收命令真的跑通（runApp = CLI main 的核心路径）", () => {
  it("demo-app：5/5 + 2 条不变量成立，且每一步都有完成信号", async () => {
    const out = tmpDir("demo-app");
    const res = await runApp(loadPack("demo-app"), {
      verbose: false, outDir: out, planPath: path.join(out, "plan.json"),
    });
    expect(res.ok, JSON.stringify({ subgoals: res.subgoals, tools: res.tool_steps })).toBe(true);
    expect(res.completed).toBe("5/5");
    // 4 个浏览器步全部有 done 信号 + 1 个工具步信号成立 => 通过不是"空转"
    expect(res.subgoals.map((s) => s.status)).toEqual(["done", "done", "done", "done"]);
    expect(res.tool_steps.map((t) => [t.source, t.code, t.done])).toEqual([["demo-tool", 0, true]]);
    expect(res.invariants.map((i) => [i.id, i.held])).toEqual([
      ["on-thanks-page", true], ["no-error-banner", true],
    ]);
  }, 120_000);

  it("cli-report --allow-dangerous：5/5，危险步有干跑证据且产物落地", async () => {
    const out = tmpDir("cli-allow");
    const res = await runApp(loadPack("cli-report"), {
      verbose: false, outDir: out, planPath: path.join(out, "plan.json"), allowDangerous: true,
    });
    // 该包**没有** invariants —— 通过完全由 5 个工具步各自的 done 信号支撑
    expect(loadPack("cli-report").invariants ?? []).toEqual([]);
    expect(res.invariants).toEqual([]);
    expect(res.ok, JSON.stringify(res.tool_steps)).toBe(true);
    expect(res.completed).toBe("5/5");
    expect(res.tool_steps.map((t) => t.done)).toEqual([true, true, true, true, true]);
    expect(res.tool_steps[4]!.dry_run?.ok).toBe(true);
    expect(fs.existsSync(path.join(out, "cli-report-artifact.txt"))).toBe(true);
  }, 120_000);

  it("cli-report 不带 --allow-dangerous：危险步被拒绝、不落盘、整跑未通过", async () => {
    const out = tmpDir("cli-deny");
    const res = await runApp(loadPack("cli-report"), {
      verbose: false, outDir: out, planPath: path.join(out, "plan.json"),
    });
    expect(res.ok).toBe(false);
    expect(res.completed).toBe("4/5");
    expect(res.tool_steps[4]!.refused).toBe("dangerous");
    expect(res.tool_steps[4]!.code).toBeNull();
    expect(fs.existsSync(path.join(out, "cli-report-artifact.txt"))).toBe(false);
  }, 120_000);

  it.skipIf(!hasTool("git") || !hasTool("jq"))("repo-report：真实 git + jq，3/3", async () => {
    const out = tmpDir("repo-report");
    const res = await runApp(loadPack("repo-report"), {
      verbose: false, outDir: out, planPath: path.join(out, "plan.json"),
    });
    expect(loadPack("repo-report").invariants ?? []).toEqual([]);   // 无 invariants，靠逐步信号
    expect(res.ok, JSON.stringify(res.tool_steps)).toBe(true);
    expect(res.tool_steps.map((t) => [t.source, t.code, t.done])).toEqual([
      ["git-log", 0, true], ["bench-cases-index", 0, true], ["bench-cases-shape", 0, true],
    ]);
  }, 120_000);

  it("测量型应用经 runApp 是**空转通过**（0 步 / 0 不变量）—— 验收在探针驱动里，不在运行器里", async () => {
    const out = tmpDir("probe-only");
    const res = await runApp(loadPack("ctrip-live"), {
      verbose: false, outDir: out, planPath: path.join(out, "plan.json"),
    });
    expect(res.subgoals).toEqual([]);
    expect(res.tool_steps).toEqual([]);
    expect(res.invariants).toEqual([]);
    expect(res.completed).toBe("0/0");
    // 这一条是"诚实记录"而不是"认可"：ok=true 在这里什么都没证明（见报告 G-A 条目）。
    expect(res.ok).toBe(true);
  }, 120_000);
});

/* ==================================================== 证伪：没干活 -> 退出码 1 */

describe("证伪：把工作弄坏，退出码必须变 1", () => {
  it("demo-app 的不变量不可能成立 -> runApp.ok=false（旅程本身仍跑完）", async () => {
    const pack = clone(loadPack("demo-app")) as AppPack;
    pack.invariants = [
      { id: "impossible", desc: "证伪：结束状态里不可能存在的东西", signal: { css_exists: "[data-test=definitely-absent]" } },
    ];
    const out = tmpDir("falsify-invariant");
    const res = await runApp(pack, { verbose: false, outDir: out, planPath: path.join(out, "plan.json") });
    expect(res.subgoals.every((s) => s.status === "done")).toBe(true);   // 动作腿确实做完了
    expect(res.invariants).toEqual([{ id: "impossible", desc: "证伪：结束状态里不可能存在的东西", held: false }]);
    expect(res.ok).toBe(false);
  }, 120_000);

  it("CLI main() 把它变成真实退出码 1（临时 cli-report 包，破坏第 1 步的信号）", () => {
    const pack = clone(loadPack("cli-report")) as any;
    pack.journey[0].signal = { exit_code_equals: 99 };                   // 不可能成立
    const packPath = tmpPack("falsify-cli", pack);
    const out = tmpDir("falsify-cli-out");
    const r = spawnSync(process.execPath, [
      "--experimental-strip-types", path.join(REPO, "src", "app-runner.ts"),
      "--app", packPath, "--no-model", "--quiet", "--out", out,
    ], { cwd: REPO, encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    const result = JSON.parse(fs.readFileSync(path.join(out, "cli-report-result.json"), "utf-8"));
    expect(result.ok).toBe(false);
    // 被弄坏的第 1 步不成立；第 5 步（危险写）没给 --allow-dangerous，按规矩被拒 -> 3/5
    expect(result.completed).toBe("3/5");
    expect(result.tool_steps[0].done).toBe(false);
    expect(result.tool_steps[4].refused).toBe("dangerous");
  }, 120_000);
});

/* ==================================================== CLI 错误路径（Lead 的三条 robustness 修复） */

describe("CLI 错误路径：G-A / G-J / G-L 三条修复不得静默回归", () => {
  it("G-A：测量型应用经 CLI 返回 2 并指向探针驱动（不再'通过 0/0'）", async () => {
    const { code, err } = await captureErr(() => appMain(["--app", "ctrip-live", "--no-model"]));
    expect(code).toBe(2);
    expect(err).toContain("测量型应用");
    expect(err).toContain("src/live-probe.ts");                 // 指路到真正的测量入口
    expect(err).toMatch(/\d+ 个目标/);
    expect(err).not.toMatch(/\n\s+at /);                        // 不是栈
  });

  it("G-J：坏包经 CLI 干净退出 2（消息精确、无栈），--dry 同样", async () => {
    const pack = clone(loadPack("demo-app")) as any;
    pack.journey[0].bogus_key = 1;
    const packPath = tmpPack("g-j", pack);
    const out = tmpDir("g-j-out");

    const full = await captureErr(() => appMain(["--app", packPath, "--no-model", "--quiet", "--out", out]));
    expect(full.code).toBe(2);
    expect(full.err).toMatch(/app pack .* is invalid:/);
    expect(full.err).toContain("journey[0].bogus_key: unknown step key");
    expect(full.err).not.toMatch(/\n\s+at /);

    const dry = await captureErr(() => appMain(["--app", packPath, "--dry"]));
    expect(dry.code).toBe(2);
    expect(dry.err).toMatch(/app pack .* is invalid:/);
    expect(dry.err).toContain("journey[0].bogus_key: unknown step key");
    expect(dry.err).not.toMatch(/\n\s+at /);
  });

  it("G-L：命令行起不来是**结果**不是崩溃：refused=tool-unavailable / code=null / stderr 含 ENOENT", async () => {
    const src = JSON.parse(fs.readFileSync(
      path.join(REPO, "apps", "demo-tool", "sources", "demo-tool.json"), "utf-8")) as any;
    src.transport.cli.bin = "definitely-not-a-real-tool-xyz";
    const srcPath = path.join(tmpDir("g-l"), "demo-tool-broken.json");
    fs.writeFileSync(srcPath, JSON.stringify(src), "utf-8");

    const step: ExpandedStep = {
      index: 0, kind: "tool", desc: "缺二进制的工具步", role: null,
      tool: {
        source: srcPath, args: [], dry_run_args: null,
        signal: { exit_ok: 0 } as unknown as ToolSignal,
        retries: 0, idempotent: false, dangerous: false,
      },
    };
    const res = await runToolStep(step, { verbose: false });     // 不许抛
    expect(res.refused).toBe("tool-unavailable");
    expect(res.done).toBe(false);
    expect(res.code).toBeNull();
    expect(res.stderr).toContain("ENOENT");
    expect(res.stderr).toContain("definitely-not-a-real-tool-xyz");
  });
});
