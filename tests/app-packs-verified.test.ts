/**
 * 独立对抗复核（task-2）：**应用包是数据，坏数据必须在加载期响亮地失败**。
 *
 * 这份文件不看作者叙述，只做两件事：
 *   1. **证伪优先**：把每一个"只在加载期炸"的声明都当成可被绕过的假设 —— 未知键 /
 *      未知角色 / 未声明槽位 / 未知 `{slot}` / 主机没进 `hosts` / 探针目标 id 悬空 /
 *      重复目标 id / `hosts` 写成了裸字符串 / 角色内联覆盖混用两种步型的键。每条都断言
 *      **消息内容**，而不是"它抛了错"。
 *   2. **同一条路径**：离线应用的验收跑 `runApp`（`src/app-runner.ts` 的 `main()` 除
 *      argv 解析与 `--ablate` 运行时安装外，全部逻辑都在这里），并用一次真实的
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
import { main as appMain, refusalLine, runApp, runToolStep, startUrl } from "../src/app-runner.ts";
import { loadProbeSet } from "../src/probe-set.ts";
import { DEMO_ROWS, FORMS, TYPE_TO_FORM } from "../src/camera-entry.ts";
import { emitPlan } from "../src/transfer-task.ts";
import { loadSpec } from "../src/flow.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime } from "../src/model.ts";
import type { ToolSignal } from "../src/tool-signals.ts";
import { matrix } from "../tools/apps_matrix.ts";
import { main as suiteMain, suite } from "../tools/apps_suite.ts";

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
      "--app", packPath, "--ablate", "stub", "--quiet", "--out", out,
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
    const { code, err } = await captureErr(() => appMain(["--app", "ctrip-live", "--ablate", "stub"]));
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

    const full = await captureErr(() => appMain(["--app", packPath, "--ablate", "stub", "--quiet", "--out", out]));
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
      index: 0, kind: "tool", desc: "缺二进制的工具步", role: null, id: null, next: [],
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

/* ==================================================== 第 2 轮：三个新应用包 */

/** `expandPack` 计划 vs `emitPlan(spec)` 的逐字段对比（本轮 transfer 两包的基准）。 */
function alignmentDiffs(packId: string, specName: string): string[] {
  const out = tmpDir(`align-${packId}`);
  const got = expandPack(loadPack(packId), {}, path.join(out, "p.json")).plan.subgoals as any[];
  // 冻结时钟：pack 的日期是写死的（生成语料那天 = 2026-10-02），不 pin 就会随墙上时钟漂移
  const prev = process.env.LAYA_TODAY;
  process.env.LAYA_TODAY = "2026-10-02";
  let emitted: any[];
  try {
    emitted = JSON.parse(fs.readFileSync(emitPlan(specName, loadSpec(specName), out), "utf-8")).subgoals as any[];
  } finally {
    if (prev === undefined) delete process.env.LAYA_TODAY; else process.env.LAYA_TODAY = prev;
  }
  const FIELDS = ["desc", "start_url", "target_hint", "target_hints", "signal", "when", "retries", "slots"];
  const diffs: string[] = [];
  if (got.length !== emitted.length) diffs.push(`length ${got.length} != ${emitted.length}`);
  for (let i = 0; i < Math.max(got.length, emitted.length); i++) {
    for (const f of FIELDS) {
      let a = (got[i] ?? {})[f] ?? null;
      const b = (emitted[i] ?? {})[f] ?? null;
      if (f === "start_url" && typeof a === "string") a = startUrl(a);
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`[${i}].${f}`);
    }
  }
  return diffs;
}

describe("第 2 轮：camera-entry / transfer-voyagio / transfer-slowjet", () => {
  it("camera-entry：4/4 + 3 不变量；空类型行与 CAM-12 拒绝行都显式成步", async () => {
    const steps = loadPack("camera-entry").journey as any[];
    expect(steps).toHaveLength(4);
    // (a) 空 device_type 行：显式选 PTZ 表单（不是丢给模型，也不是跳过）
    const blank = steps.find((s) => String(s.desc).includes("类型列空"));
    expect(blank, "blank device_type row").toBeTruthy();
    expect((blank.target_hints as string[])[0]).toBe("[data-test='entry-ptz']");
    expect(blank.slots["b-sn"]).toBe("PTZ-2002");
    // (b) CAM-12 被拒行：显式信号 = 表单自己的错误文案 + 我们填的那个值 + 页面
    const cam12 = steps.find((s) => JSON.stringify(s.slots ?? {}).includes("CAM-12"));
    expect(cam12, "CAM-12 rejected row").toBeTruthy();
    const sig = JSON.stringify(cam12.signal);
    expect(sig).toContain("序列号格式错误");
    expect(sig).toContain("CAM-12");
    expect(sig).toContain("camera_a.html");

    const out = tmpDir("r2-camera");
    const res = await runApp(loadPack("camera-entry"), {
      verbose: false, outDir: out, planPath: path.join(out, "plan.json"),
    });
    expect(res.completed).toBe("4/4");
    expect(res.ok, JSON.stringify(res.subgoals)).toBe(true);
    expect(res.invariants.map((i) => [i.id, i.held])).toEqual([
      ["end-on-the-rejected-form", true],
      ["rejection-not-reported-as-success", true],
      ["end-state-is-the-fixed-form", true],
    ]);
  }, 120_000);

  it("camera-entry：每行 slots 与 DEMO_ROWS × TYPE_TO_FORM × FORMS 逐项一致", () => {
    const steps = loadPack("camera-entry").journey as any[];
    const dt = (sel: string): string => (/\[data-test='?([^'\]]+)/.exec(sel) ?? [])[1]!;
    for (const row of DEMO_ROWS as any[]) {
      const step = steps.find((s) => Object.values(s.slots ?? {}).map(String).includes(String(row.serial)));
      expect(step, `row ${row.serial}`).toBeTruthy();
      const stype = typeof row.device_type === "string" ? row.device_type.trim() : "";
      // 空类型：包显式按行内证据选了 PTZ 表单（与 TYPE_TO_FORM 对 PTZ 的判定同源）
      const formName = (TYPE_TO_FORM[stype] ?? (String(row.serial).startsWith("PTZ") ? "form_b" : "form_a")) as "form_a" | "form_b";
      const form = FORMS[formName];
      for (const [col, sel] of Object.entries(form.fields)) {
        const v = row[col];
        if (v === null || v === undefined || String(v).trim() === "") continue;
        expect(String((step.slots as any)[dt(sel)]), `${row.serial}.${col}`).toBe(String(v));
      }
      const hints = step.target_hints as string[];
      expect(hints[0], `${row.serial} entry hint`).toBe(form.entry);
      expect(hints[hints.length - 1], `${row.serial} submit hint`).toBe(form.submit);
    }
  });

  it("transfer-voyagio：验收 24/24 + 3 不变量；计划与 emitPlan('voyagio') 逐字段全等", async () => {
    expect(alignmentDiffs("transfer-voyagio", "voyagio")).toEqual([]);
    const out = tmpDir("r2-voyagio");
    const res = await runApp(loadPack("transfer-voyagio"), {
      verbose: false, sources: false, outDir: out, planPath: path.join(out, "plan.json"),
    });
    expect(res.completed).toBe("24/24");
    expect(res.ok, JSON.stringify(res.subgoals.filter((s) => s.status !== "done"))).toBe(true);
    expect(res.invariants.every((i) => i.held)).toBe(true);
  }, 180_000);

  it("transfer-slowjet：计划与 emitPlan('slowjet') 逐字段全等", () => {
    expect(alignmentDiffs("transfer-slowjet", "slowjet")).toEqual([]);
  });

  it("transfer-slowjet：retries 真的被用到；临时副本去掉 retries -> 14/19 + exit 1", async () => {
    const base = { verbose: false, sources: false } as const;
    const out = tmpDir("r2-slowjet");
    const res = await runApp(loadPack("transfer-slowjet"), {
      ...base, outDir: out, planPath: path.join(out, "plan.json"),
    });
    expect(res.completed).toBe("19/19");
    expect(res.ok, JSON.stringify(res.subgoals.filter((s) => s.status !== "done"))).toBe(true);
    // 冷启动：5 个 record 步在第 2 次尝试才 done（这就是 retries 被用到的证据）
    expect(res.subgoals.filter((s) => s.attempts === 2)).toHaveLength(5);

    const stripped = clone(loadPack("transfer-slowjet")) as any;
    for (const tpl of Object.values(stripped.roles ?? {}) as any[]) delete tpl.retries;
    for (const s of stripped.journey) delete s.retries;
    const out2 = tmpDir("r2-slowjet-noretry");
    const res2 = await runApp(stripped, { ...base, outDir: out2, planPath: path.join(out2, "plan.json") });
    expect(res2.ok).toBe(false);
    expect(res2.completed).toBe("14/19");                       // 5 个 record 步第一次就 blocked
    expect(res2.subgoals.filter((s) => s.status === "blocked")).toHaveLength(5);
  }, 240_000);

  it("第 2 轮门禁：三个新目录只有 JSON，matrix 仍然 0 代码行 / 0 泄漏 / 0 债", () => {
    for (const id of ["camera-entry", "transfer-voyagio", "transfer-slowjet", "transfer-trekly", "transfer-farehaven", "transfer-skybook", "transfer-flyquest"]) {
      expect(validatePack(loadPack(id)), id).toEqual([]);
      const files = fs.readdirSync(path.join(REPO, "apps", id));
      expect(files.filter((f) => /\.(ts|js|mjs|cjs)$/.test(f)), `${id} code files`).toEqual([]);
      expect(files).toEqual(["pack.json"]);
    }
    const { rows, leaks, debt } = matrix();
    expect(leaks, JSON.stringify(leaks)).toEqual([]);
    expect(debt, JSON.stringify(debt)).toEqual([]);
    for (const id of ["camera-entry", "transfer-voyagio", "transfer-slowjet", "transfer-trekly", "transfer-farehaven", "transfer-skybook", "transfer-flyquest"]) {
      expect(rows.find((r) => r.app === id)!.code, id).toBe(0);
    }
  });
});

/* ==================================================== 第 4 轮：skybook / flyquest */

describe("第 4 轮：transfer-skybook / transfer-flyquest", () => {
  it("skybook：23/23 + 3 不变量；5 个角色模板覆盖 19 步、4 步内联", async () => {
    const pack: any = loadPack("transfer-skybook");
    const cov = new Map<string, number>();
    let inline = 0;
    for (const s of pack.journey as any[]) {
      if (s.role) cov.set(s.role, (cov.get(s.role) ?? 0) + 1); else inline++;
    }
    expect(pack.journey).toHaveLength(23);
    expect(cov).toEqual(new Map([["filter-window", 5], ["sort-flights", 5], ["record-lowest", 5], ["select-all", 2], ["record-selected", 2]]));
    expect(inline).toBe(4);                                   // 入口 / 酒店上限 / 酒店排序 / 翻页
    const out = tmpDir("r4-skybook");
    const res = await runApp(pack, { verbose: false, sources: false, outDir: out, planPath: path.join(out, "plan.json") });
    expect(res.completed).toBe("23/23");
    expect(res.ok, JSON.stringify(res.subgoals.filter((s) => s.status !== "done"))).toBe(true);
    expect(res.invariants.map((i) => [i.id, i.held])).toEqual([
      ["end-on-recorded-second-page", true],
      ["the-second-page-was-really-selected", true],
      ["end-state-is-the-hotels-page", true],
    ]);
  }, 180_000);

  it("skybook：信号独立性画像 —— 23 步 / 8 种信号 / 5 个重复组，其中 1 组跨页面", () => {
    const sgs = expandPack(loadPack("transfer-skybook"), {}, path.join(tmpDir("r4-sky-a"), "p.json")).plan.subgoals as any[];
    const bySig = new Map<string, number[]>();
    sgs.forEach((s: any, i: number) => { const k = JSON.stringify(s.signal); bySig.set(k, [...(bySig.get(k) ?? []), i]); });
    expect(sgs).toHaveLength(23);
    expect(bySig.size).toBe(8);                               // 8 种 done-signal
    const dup = [...bySig.entries()].filter(([, idx]) => idx.length > 1);
    expect(dup).toHaveLength(5);
    // 唯一跨页面的一组：机票排序 ×5 + 酒店排序 ×1 共用 #sort-state
    const crossPage = dup.filter(([, idx]) => new Set(idx.map((i) => String(sgs[i].start_url).split("?")[0].split("/").pop())).size > 1);
    expect(crossPage).toHaveLength(1);
    expect(crossPage[0]![1]).toEqual([2, 5, 8, 11, 14, 17]);
    expect(String(sgs[2].signal.css_text_contains[0])).toBe("#sort-state");
  });

  it("skybook：计划与 emitPlan('skybook') 逐字段全等", () => {
    expect(alignmentDiffs("transfer-skybook", "skybook")).toEqual([]);
  });

  it("flyquest：search-form 步是有序 target_hints（填日期→选时段→提交）；与 emitPlan('flyquest') 逐字段全等", () => {
    const pack: any = loadPack("transfer-flyquest");
    const tpl = pack.roles["search-form"];
    expect(tpl.target_hints).toEqual(["#date", "#window", "#search-btn"]);
    expect(tpl.start_url).toBe("transfer/site4/search.html");   // 不带查询串：结果页只能由提交产生
    expect(tpl.slots).toEqual({ date: "2026-10-05" });
    expect(alignmentDiffs("transfer-flyquest", "flyquest")).toEqual([]);
  });

  it("flyquest：19/19 + 3 不变量", async () => {
    const out = tmpDir("r4-flyquest");
    const res = await runApp(loadPack("transfer-flyquest"), {
      verbose: false, sources: false, outDir: out, planPath: path.join(out, "plan.json"),
    });
    expect(res.completed).toBe("19/19");
    expect(res.ok, JSON.stringify(res.subgoals.filter((s) => s.status !== "done"))).toBe(true);
    expect(res.invariants.every((i) => i.held)).toBe(true);
  }, 180_000);

  it("flyquest：把有序 target_hints 退化成单个 target_hint -> 14/19，那 5 个 search 步 blocked", async () => {
    const stripped = clone(loadPack("transfer-flyquest")) as any;
    delete stripped.roles["search-form"].target_hints;
    stripped.roles["search-form"].target_hint = "#date";
    const out = tmpDir("r4-flyquest-hint1");
    const res = await runApp(stripped, { verbose: false, sources: false, outDir: out, planPath: path.join(out, "plan.json") });
    expect(res.ok).toBe(false);
    expect(res.completed).toBe("14/19");
    const blocked = res.subgoals.map((s, i) => [i, s.status]).filter(([, st]) => st === "blocked").map(([i]) => i);
    expect(blocked).toEqual([1, 4, 7, 10, 13]);               // 5 个 per-date search-form 步
  }, 180_000);
});

/* ==================================================== 第 3 轮：trekly / farehaven */

describe("第 3 轮：transfer-trekly / transfer-farehaven", () => {
  it("trekly：价格上限步真的是 range 滑块（页面 input[type=range] + 包点名 #max-price）", () => {
    const html = fs.readFileSync(path.join(REPO, "transfer", "site3", "hotels.html"), "utf-8");
    expect(html).toMatch(/<input[^>]*type="range"[^>]*id="max-price"/);
    expect(html).toContain('id="cap-state"');
    const pack: any = loadPack("transfer-trekly");
    const cap = (pack.journey as any[]).find((s) => s.target_hint === "#max-price");
    expect(cap, "cap step").toBeTruthy();
    expect(cap.start_url).toContain("checkin=");
    expect(cap.start_url).not.toContain("cap=");              // 必须靠 fill+input 事件导航，而不是预置 URL
    expect((pack.slots as any).cap).toBe("300");              // 值只来自计划
  });

  it("trekly：19/19 + 3 不变量，且结束状态真的收窄（#row-count = 12 stays）", async () => {
    const out = tmpDir("r3-trekly");
    const res = await runApp(loadPack("transfer-trekly"), {
      verbose: false, sources: false, outDir: out, planPath: path.join(out, "plan.json"),
    });
    expect(res.completed).toBe("19/19");
    expect(res.ok, JSON.stringify(res.subgoals.filter((s) => s.status !== "done"))).toBe(true);
    expect(res.invariants.map((i) => [i.id, i.held])).toEqual([
      ["end-on-recorded-narrowed-stays-list", true],
      ["the-slider-really-moved-off-its-default", true],
      ["the-slider-narrowed-the-list-to-the-frozen-count", true],
    ]);
  }, 180_000);

  it("trekly：计划与 emitPlan('trekly') 逐字段全等（when/retries 均为 0）", () => {
    expect(alignmentDiffs("transfer-trekly", "trekly")).toEqual([]);
    const sgs = expandPack(loadPack("transfer-trekly"), {}, path.join(tmpDir("r3-trekly-a"), "p.json")).plan.subgoals as any[];
    expect(sgs.filter((s) => s.when)).toHaveLength(0);
    expect(sgs.filter((s) => s.retries)).toHaveLength(0);
  });

  it("farehaven：计划与 emitPlan('farehaven') 逐字段全等，且 when 如实保留 5 条", () => {
    expect(alignmentDiffs("transfer-farehaven", "farehaven")).toEqual([]);
    const sgs = expandPack(loadPack("transfer-farehaven"), {}, path.join(tmpDir("r3-fh-a"), "p.json")).plan.subgoals as any[];
    const whens = sgs.filter((s) => s.when);
    expect(whens).toHaveLength(5);
    for (const s of whens) expect(s.when).toEqual({ css_exists: ["#promo-modal"] });
  });

  it("farehaven：24/24，且端到端真的出现 4 条 skipped（部分日期没有浮层）", async () => {
    const out = tmpDir("r3-farehaven");
    const res = await runApp(loadPack("transfer-farehaven"), {
      verbose: false, sources: false, outDir: out, planPath: path.join(out, "plan.json"),
    });
    expect(res.completed).toBe("24/24");
    expect(res.ok, JSON.stringify(res.subgoals.filter((s) => s.status === "blocked"))).toBe(true);
    const skipped = res.subgoals.map((s, i) => [i, s.status]).filter(([, st]) => st === "skipped");
    expect(skipped.map(([i]) => i)).toEqual([5, 9, 13, 17]);   // 恰好是没有 #promo-modal 的那 4 天
    expect(res.invariants.every((i) => i.held)).toBe(true);
  }, 180_000);

  it("farehaven：删掉 when 的临时副本阻塞在无浮层的那 4 天（when 是区分性验证的）", async () => {
    const stripped = clone(loadPack("transfer-farehaven")) as any;
    for (const tpl of Object.values(stripped.roles ?? {}) as any[]) delete tpl.when;
    for (const s of stripped.journey) delete s.when;
    const out = tmpDir("r3-farehaven-nowhen");
    const res = await runApp(stripped, {
      verbose: false, sources: false, outDir: out, planPath: path.join(out, "plan.json"),
    });
    expect(res.ok).toBe(false);
    expect(res.completed).toBe("20/24");
    const blocked = res.subgoals.map((s, i) => [i, s.status]).filter(([, st]) => st === "blocked").map(([i]) => i);
    expect(blocked).toEqual([5, 9, 13, 17]);
  }, 180_000);
});

/* ==================================================== 第 5 轮：使用者体验修复（补 Lead 未覆盖的角度） */

/** 收走 console.log / console.error（suiteMain 的 --json 走 stdout）。 */
async function captureOut<T>(fn: () => Promise<T>): Promise<{ code: T; out: string }> {
  const log = console.log, err = console.error;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { return { code: await fn(), out: lines.join("\n") }; }
  finally { console.log = log; console.error = err; }
}

describe("第 5 轮：使用者体验修复（对抗性补测）", () => {
  it("`--slot` 大小写/空格不做静默折叠：键名原样回显", async () => {
    const up = await captureErr(() => appMain(["--app", "demo-app", "--ablate", "stub", "--slot", "COUPON=x"]));
    expect(up.code).toBe(2);
    expect(up.err).toContain('--slot "COUPON" not declared');
    const sp = await captureErr(() => appMain(["--app", "demo-app", "--ablate", "stub", "--slot", " coupon=1"]));
    expect(sp.code).toBe(2);
    expect(sp.err).toContain('--slot " coupon" not declared');
  });

  // 第 5 轮复核（§12.1）曾把"同名给两次 = 后者生效"记为**观察**；Lead 随后按同一条最小修法收紧：
  // 与"打错槽位名"同一类静默——值没被用上而使用者以为生效——所以现在**是用法错误**（exit 2，回显两个值）。
  it("`--slot` 同名给两次 = 用法错误（exit 2，回显两个值；由 §12 复核从 last-wins 收紧）", async () => {
    const out = tmpDir("r5-dup-slot");
    const cap = await captureErr(() => appMain(["--app", "demo-app", "--ablate", "stub", "--quiet",
      "--out", out, "--slot", "coupon=A", "--slot", "coupon=B"]));
    expect(cap.code).toBe(2);
    expect(cap.err).toContain('--slot "coupon" 给了两次');
    expect(cap.err).toContain('"A"');                            // 两个值都要回显，使用者才知道自己给了什么
    expect(cap.err).toContain('"B"');
    expect(fs.existsSync(path.join(out, "demo-app-plan.json"))).toBe(false);  // 没跑到展开计划
  }, 120_000);

  it("`apps:suite --json` 的 exit_code 与真退出码一致（3 = 未执行；2 = 用法错误且 output 是合法 JSON）", async () => {
    const r = await captureOut(() => suiteMain(["--only", "demo-app,cli-report", "--json"]));
    expect(r.code).toBe(3);
    const payload = JSON.parse(r.out.slice(r.out.indexOf("{")));   // 跳过 npm 前缀（这里直接调 main）
    expect(payload.exit_code).toBe(3);

    // --only 打错字 + --json：以前是 exit 2 + 空 stdout；现在必须给可解析对象
    const typo = await captureOut(() => suiteMain(["--only", "demo-ap", "--json"]));
    expect(typo.code).toBe(2);
    const errPayload = JSON.parse(typo.out.slice(typo.out.indexOf("{")));
    expect(errPayload.exit_code).toBe(2);
    expect(errPayload.unmatched).toEqual(["demo-ap"]);
    expect(errPayload.known).toContain("demo-app");
    expect(String(errPayload.error)).toMatch(/没有匹配任何应用/);
  }, 180_000);

  it("hint 匹配不到 -> 走 `matched nothing in a pool of N` 这条消息，而不是 `names no target`", async () => {
    installLayaRuntime(scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 }))));
    const dir = tmpDir("r5-badhint");
    const packPath = path.join(dir, "pack.json");
    fs.writeFileSync(packPath, JSON.stringify({
      spec_version: 1, id: "r5-badhint", label: "hint 匹配不到", goal: "打开门户页",
      model: "english", max_subgoals: 1, hosts: [], slots: {}, sources: [],
      roles: {}, journey: [{
        desc: "点一个页面上不存在的句柄", start_url: "testpages/portal.html",
        target_hint: "#definitely-absent", signal: { url_contains: "portal.html" },
      }],
      invariants: [{ id: "x", signal: { url_contains: "portal.html" } }],
    }), "utf-8");
    const res = await runApp(loadPack(packPath), {
      verbose: false, sources: false, outDir: dir, planPath: path.join(dir, "plan.json"),
    });
    const reason = String((res.subgoals[0] as { obstacle?: string }).obstacle ?? "");
    expect(reason).toMatch(/matched nothing in a pool of \d+ element\(s\)/);
    expect(reason).toContain('#definitely-absent');
    expect(reason).not.toMatch(/names no target/);
  }, 180_000);

  it("危险步三处同源：CLI 行 = refusalLine，报告 = Markdown 形式，JSON 仍是机器值", async () => {
    const out = tmpDir("r5-refusal");
    const r = await captureOut(() => appMain(["--app", "cli-report", "--ablate", "stub", "--out", out]));
    expect(r.code).toBe(1);
    expect(r.out).toContain(refusalLine("dangerous"));          // CLI 用无反引号的一行短语
    const md = fs.readFileSync(path.join(out, "cli-report-report.md"), "utf-8");
    expect(md).toContain("未执行（危险步未放行；加 `--allow-dangerous` 可放行，本次未落盘）");
    const result = JSON.parse(fs.readFileSync(path.join(out, "cli-report-result.json"), "utf-8"));
    expect(result.tool_steps[4].refused).toBe("dangerous");      // 机器值不被文案污染
    expect(result.tool_steps[4].done).toBe(false);
  }, 120_000);

  it("坏包只毁自己那一行：suite 逐应用 try/catch，其余照常出表且 exit 1", async () => {
    const brokenDir = path.join(REPO, "apps", "zz-verify-broken");
    try {
      fs.mkdirSync(brokenDir, { recursive: true });
      fs.writeFileSync(path.join(brokenDir, "pack.json"), "{ this is not json", "utf-8");
      const out = await captureOut(() => suiteMain(["--only", "zz-verify-broken,demo-app"]));
      expect(out.code).toBe(1);                                  // 有未通过 -> 1
      const payload = await suite(["zz-verify-broken", "demo-app"], { arm: "ablate" });
      const broken = payload.rows.find((r) => r.app === "zz-verify-broken")!;
      const demo = payload.rows.find((r) => r.app === "demo-app")!;
      expect(broken.status).toBe("failed");
      expect(String((broken as { note?: string }).note ?? "")).toMatch(/加载失败/);
      expect(demo.status).toBe("passed");                        // 坏包不掀桌子
    } finally {
      fs.rmSync(brokenDir, { recursive: true, force: true });    // 不留脏目录
    }
  }, 180_000);
});
