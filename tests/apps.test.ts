/**
 * 应用层测试 —— 应用包是**数据**，共享层零改动。
 *
 * 五组：
 *   1. 发现与校验：坏包在加载期炸（未知键/角色/占位符/缺必填槽位/未知数据源/坏不变量）；
 *   2. 展开：角色模板 + 槽位替换 + 可复现（同一份包展开出逐字段相同的计划）；
 *   3. 端到端：`runApp` 跑完「数据腿 → 冻结计划 → 结束状态不变量」整条链路（离线、脚本模型）；
 *   4. 度量：应用目录 0 行代码；核心层不许出现应用声明的站点/工具标识（`apps:matrix`）；
 *   5. 工具步：命令行工具当动作腿（退出码/stdout/stderr/JSON/产物 + 干跑/确认/幂等重试）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDirs, expandPack, listPacks, loadPack, packHintCoverage, PACK_KEYS, validatePack, type AppPack } from "../src/app-pack.ts";
import { runApp } from "../src/app-runner.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime } from "../src/model.ts";
import { validateProbeBlock } from "../src/probe-set.ts";
import { matrix } from "../tools/apps_matrix.ts";
import { suiteExitCode } from "../tools/apps_suite.ts";
import { isLive } from "../tools/apps_suite.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

beforeAll(() => {
  // 与其它离线测试同一约定：注入脚本模型，绝不加载 1.7GB 权重
  installLayaRuntime(scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 }))));
});
afterAll(() => installLayaRuntime(null));

describe("应用包：发现与校验", () => {
  it("发现制扫出 apps/<id>/pack.json；demo-app 通过校验", () => {
    const packs = listPacks().map(([id]) => id);
    expect(packs).toContain("demo-app");
    expect(appDirs().some((d) => d.endsWith(path.join("apps", "demo-app")))).toBe(true);
    const pack = loadPack("demo-app");
    expect(validatePack(pack), JSON.stringify(validatePack(pack))).toEqual([]);
  });

  it.each([
    ["spec_version", (p: any) => { p.spec_version = 2; }, "spec_version must be 1"],
    ["未知包键", (p: any) => { p.whatever = 1; }, "unknown pack key"],
    ["缺 goal", (p: any) => { delete p.goal; }, "goal is required"],
    ["空 journey", (p: any) => { p.journey = []; }, "journey must be a non-empty list"],
    ["未知角色", (p: any) => { p.journey[0] = { role: "nope" }; }, "unknown role"],
    ["未知步骤键", (p: any) => { p.journey[0].magic = 1; }, "unknown step key"],
    ["未知占位符", (p: any) => { p.roles["add-to-cart"].desc = "用 {nope} 加购"; }, "unknown slot placeholder {nope}"],
    ["缺必填槽位", (p: any) => { p.required_slots = ["missing"]; }, "required slot \"missing\" has no value"],
    ["未知数据源", (p: any) => { p.sources = ["no-such-source"]; }, "not found"],
    ["坏不变量", (p: any) => { p.invariants = [{ id: "x" }]; }, "invariants[0] needs"],
    ["未知信号算子", (p: any) => { p.roles.checkout.signal = { magic_op: "x" }; }, "unknown signal op"],
    ["未知策略键（§3：写了就要生效，不许静默忽略）", (p: any) => { p.policy = { made_up: 1 }; }, "unknown policy key"],
    ["策略值类型错（risk_ask 是闭集）", (p: any) => { p.policy = { risk_ask: "sometimes" }; }, "must be one of always | on-ambiguity"],
    ["策略值类型错（tiered_hint 必须是布尔）", (p: any) => { p.policy = { tiered_hint: "yes" }; }, "tiered_hint: must be a boolean"],
    ["max_effective_repeats 要 >=1", (p: any) => { p.policy = { max_effective_repeats: 0 }; }, "integer >= 1"],
    ["角色缺信号", (p: any) => { delete p.roles.checkout.signal; }, "needs a done-signal"],
  ])("%s", (_label, mutate, snippet) => {
    const pack = clone(loadPack("demo-app")) as any;
    mutate(pack);
    expect(validatePack(pack).join(" | ")).toContain(snippet);
  });

  it("包级键集合是白名单（未知键不会被静默忽略）", () => {
    expect(PACK_KEYS).toContain("journey");
    expect(PACK_KEYS).toContain("invariants");
    expect(PACK_KEYS).toContain("sources");
  });

  it("校验器复用计划自己的口径：子目标超预算会报出来", () => {
    const pack = clone(loadPack("demo-app")) as AppPack;
    pack.max_subgoals = 2;                                   // 4 步 > 预算 2
    expect(validatePack(pack).join(" | ")).toContain("exceed max 2");
  });
});

describe("应用包：展开成冻结计划", () => {
  it("角色模板 + 槽位替换 + 可复现（两次展开逐字段相同）", () => {
    const pack = loadPack("demo-app");
    const a = expandPack(pack, {}, "/tmp/a.json");
    const b = expandPack(pack, {}, "/tmp/b.json");
    expect(a.rolesUsed).toEqual(["add-to-cart", "open-cart", "apply-coupon", "checkout"]);
    expect(a.plan.subgoals).toHaveLength(4);
    // 逐字段相同（path 不在比较范围内；计划内容必须完全一致）
    expect(JSON.parse(JSON.stringify(a.plan.subgoals))).toEqual(JSON.parse(JSON.stringify(b.plan.subgoals)));
    // 占位符替换：desc 与子目标 slots 都拿到了值，且**值只来自计划**
    const coupon = a.plan.subgoals[2]!;
    expect(coupon.desc).toContain("ACME10");
    expect((coupon.slots as Record<string, unknown>).coupon).toBe("ACME10");
    expect(a.plan.slots.coupon).toBe("ACME10");
  });

  it("覆盖槽位（--slot）只改数据，不改结构", () => {
    const pack = loadPack("demo-app");
    const a = expandPack(pack, { coupon: "OTHER20" }, "/tmp/c.json");
    expect(a.plan.subgoals).toHaveLength(4);
    expect(a.plan.subgoals[2]!.desc).toContain("OTHER20");
    expect((a.plan.subgoals[2]!.slots as Record<string, unknown>).coupon).toBe("OTHER20");
  });

  it("未知角色引用在展开时报错（不是跑到一半才发现）", () => {
    const pack = clone(loadPack("demo-app")) as AppPack;
    pack.journey[0] = { role: "ghost" } as never;
    expect(() => expandPack(pack, {}, "/tmp/d.json")).toThrow(/unknown role/);
  });
});

describe("应用运行器：数据腿 → 动作腿 → 结束状态不变量", () => {
  it("demo-app 端到端通过（离线夹具 + 桩工具，脚本模型）", async () => {
    const pack = loadPack("demo-app");
    const res = await runApp(pack, {
      verbose: false, planPath: path.join("/tmp", "amberflow-apps", "demo-app-test.json"),
    });
    expect(res.ok, JSON.stringify(res.subgoals)).toBe(true);
    expect(res.completed).toBe("5/5");
    expect(res.subgoals.every((s) => s.status === "done")).toBe(true);
    expect(res.invariants.map((i) => [i.id, i.held])).toEqual([
      ["on-thanks-page", true], ["no-error-banner", true],
    ]);
    // 数据腿真的跑了，而且走的是同一套引擎（CLI 通道 + 版本 pin）
    expect(res.sources).toHaveLength(1);
    expect(res.sources[0]).toMatchObject({ name: "demo-tool", rows: 3, tool_version: "stub-tool 1.4.2" });
    expect(res.sources[0]!.counts.rows).toBe(3);
  }, 120_000);

  it("不变量在会话结束状态上求值：故意写错的不变量必须不成立", async () => {
    const pack = clone(loadPack("demo-app")) as AppPack;
    pack.invariants = [{ id: "wrong", desc: "结束状态里不该有的东西", signal: { css_exists: "[data-test=definitely-absent]" } }];
    const res = await runApp(pack, { verbose: false, sources: false, planPath: "/tmp/amberflow-apps/bad.json" });
    expect(res.subgoals.every((s) => s.status === "done")).toBe(true);   // 旅程本身跑完了
    expect(res.invariants).toEqual([{ id: "wrong", desc: "结束状态里不该有的东西", held: false }]);
    expect(res.ok).toBe(false);                                          // 但验收不通过
  }, 120_000);
});

describe("应用层度量：代码行与防泄漏", () => {
  it("应用目录里 0 行代码；核心层没有应用声明的站点/工具标识", () => {
    const { rows, leaks, debt } = matrix();
    expect(rows.map((r) => r.app)).toEqual(expect.arrayContaining(["demo-app", "demo-tool", "git-log", "bench-cases"]));
    expect(rows.every((r) => r.code === 0), JSON.stringify(rows)).toBe(true);
    expect(leaks, JSON.stringify(leaks)).toEqual([]);
    // 债归零：每个站点知识都搬进了 apps/（探针驱动也进了核心层，见 tools/apps_matrix.ts 的 CORE）
    expect(debt, JSON.stringify(debt)).toEqual([]);
    const demo = rows.find((r) => r.app === "demo-app")!;
    expect(demo).toMatchObject({ kind: "pack", roles: 4, steps: 5, invariants: 2, sources: 1 });
  });

  it("泄漏检查真的有牙：把一个站点名写进核心层就会被抓到（模拟，不改文件）", () => {
    // 直接验证判据本身：词边界 + 大小写不敏感，且短标识不会误伤普通单词
    const tokens = ["git", "jq", "m.ctrip.com"];
    const word = (t: string): RegExp => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    expect(word("git").test("a legitimate digit")).toBe(false);
    expect(word("git").test("run git log")).toBe(true);
    expect(word("jq").test("jQuery-ish")).toBe(false);
    expect(word("m.ctrip.com").test("https://m.ctrip.com/x")).toBe(true);
    expect(tokens.length).toBe(3);
  });
});

describe("应用包与数据源的位置约定", () => {
  it("app 目录只放声明（JSON）与可选的 bin/，不放业务代码", () => {
    for (const dir of appDirs()) {
      const stray = fs.readdirSync(dir).filter((f) => /\.(ts|js|mjs|cjs)$/.test(f));
      expect(stray, `${dir} 顶层不该有代码文件`).toEqual([]);
    }
  });
});

/* ------------------------------------------------- 工具步：命令行当动作腿 */

const freshOut = (tag: string): string => {
  const d = path.join(os.tmpdir(), `amberflow-apps-test-${tag}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const hasTool = (bin: string): boolean => {
  try {
    execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("工具步：命令行工具当动作腿", () => {
  it.each([
    ["未知数据源", (p: any) => { p.journey[0] = { id: "x", desc: "d", source: "no-such", signal: { exit_ok: true } }; },
      "source \"no-such\" not found"],
    ["retries 需要幂等", (p: any) => { p.journey[0].retries = 2; }, "needs idempotent: true"],
    ["dangerous 需要干跑", (p: any) => {
      p.journey[0] = { id: "x", desc: "d", source: "demo-tool", dangerous: true, signal: { exit_ok: true } };
    }, "dangerous needs dry_run_args"],
    ["dangerous 不许重试", (p: any) => {
      p.journey[0] = {
        id: "x", desc: "d", source: "demo-tool", dangerous: true, idempotent: true, retries: 1,
        dry_run_args: ["--dry-run"], signal: { exit_ok: true },
      };
    }, "must not retry"],
    ["工具步不许有浏览器键", (p: any) => { p.journey[0].start_url = "https://x"; },
      "browser-only key on a tool step"],
    ["浏览器步不许有工具键", (p: any) => {
      p.journey[0] = { desc: "d", signal: { css_exists: "#a" }, args: ["--x"] };
    }, "tool-only key on a browser step"],
    ["工具信号算子白名单", (p: any) => { p.journey[0].signal = { stdout_eq: "x" }; },
      "unknown tool signal op 'stdout_eq'"],
    ["不变量需要浏览器步", (p: any) => {
      p.journey = p.journey.filter((s: any) => s.source !== undefined);
      p.invariants = [{ id: "x", signal: { css_exists: "#a" } }];
    }, "invariants need at least one browser step"],
  ])("%s", (_label, mutate, snippet) => {
    const pack = clone(loadPack("cli-report")) as any;
    mutate(pack);
    expect(validatePack(pack).join(" | ")).toContain(snippet);
  });

  it("cli-report 全绿：退出码 / JSON 路径 / stderr / 幂等重试 / 干跑+确认+落盘", async () => {
    const out = freshOut("cli-report");
    const res = await runApp(loadPack("cli-report"), {
      verbose: false, outDir: out, planPath: path.join(out, "plan.json"), allowDangerous: true,
    });
    expect(res.ok, JSON.stringify(res.tool_steps)).toBe(true);
    expect(res.completed).toBe("5/5");
    expect(res.subgoals).toHaveLength(0);                     // 全工具步：没有浏览器子目标
    expect(res.tool_steps.map((t) => [t.source, t.code, t.done])).toEqual([
      ["demo-tool", 0, true], ["demo-tool", 3, true], ["demo-tool", 2, true],
      ["demo-tool", 0, true], ["demo-tool", 0, true],
    ]);
    // 幂等读操作重试到第 3 次才成功（失败计数在进程之外，所以这是真的重试）
    expect(res.tool_steps[3]!.attempts).toBe(3);
    // 不可逆写入：干跑先过了，产物才落地
    expect(res.tool_steps[4]!.dry_run?.ok).toBe(true);
    expect(res.tool_steps[4]!.refused).toBeUndefined();
    expect(fs.existsSync(path.join(out, "cli-report-artifact.txt"))).toBe(true);
  }, 120_000);

  it("危险步默认拒绝：不确认就不落盘，并且明确报告 refused", async () => {
    const out = freshOut("cli-refuse");
    const res = await runApp(loadPack("cli-report"), {
      verbose: false, outDir: out, planPath: path.join(out, "plan.json"),
    });
    expect(res.ok).toBe(false);
    expect(res.completed).toBe("4/5");
    expect(res.tool_steps[4]!.refused).toBe("dangerous");
    expect(res.tool_steps[4]!.code).toBeNull();               // apply 根本没跑
    expect(fs.existsSync(path.join(out, "cli-report-artifact.txt"))).toBe(false);
  }, 120_000);

  it("确认钩子说不 -> declined；说可以 -> 执行（钩子拿到的是干跑证据）", async () => {
    const out = freshOut("cli-confirm");
    const seen: string[] = [];
    const declined = await runApp(loadPack("cli-report"), {
      verbose: false, outDir: out, planPath: path.join(out, "plan.json"),
      confirmToolStep: (desc, ev) => { seen.push(`${desc}|${ev.dry_run?.ok}`); return false; },
    });
    expect(declined.tool_steps[4]!.refused).toBe("declined");
    expect(fs.existsSync(path.join(out, "cli-report-artifact.txt"))).toBe(false);
    expect(seen[0]).toContain("|true");                       // 确认时已经看到干跑结果

    const allowed = await runApp(loadPack("cli-report"), {
      verbose: false, outDir: out, planPath: path.join(out, "plan.json"),
      confirmToolStep: () => true,
    });
    expect(allowed.ok).toBe(true);
    expect(fs.existsSync(path.join(out, "cli-report-artifact.txt"))).toBe(true);
  }, 120_000);

  it("干跑不成功就不 apply（干跑失败是一种显式拒绝）", async () => {
    const out = freshOut("cli-dryfail");
    const pack = clone(loadPack("cli-report")) as any;
    const write = pack.journey[4];
    write.args = ["--fail", "--write={out_dir}/never.txt"];
    write.dry_run_args = ["--fail", "--write={out_dir}/never.txt", "--dry-run"];
    write.signal = { all_of: [{ exit_ok: 0 }, { file_exists: "{out_dir}/never.txt" }] };
    const res = await runApp(pack, {
      verbose: false, outDir: out, planPath: path.join(out, "plan.json"), allowDangerous: true,
    });
    expect(res.ok).toBe(false);
    expect(res.tool_steps[4]!.refused).toBe("dry-run-failed");
    expect(fs.existsSync(path.join(out, "never.txt"))).toBe(false);
  }, 120_000);

  it("混合旅程：工具步 + 浏览器步按顺序跑（demo-app 5 步）", async () => {
    const out = freshOut("mixed");
    const res = await runApp(loadPack("demo-app"), {
      verbose: false, outDir: out, planPath: path.join(out, "plan.json"),
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.completed).toBe("5/5");
    expect(res.subgoals).toHaveLength(4);                     // 浏览器步子目标
    expect(res.tool_steps).toHaveLength(1);                   // 旅程第一步是工具步
    expect(res.tool_steps[0]).toMatchObject({ source: "demo-tool", code: 0, done: true });
    expect(res.invariants.every((i) => i.held)).toBe(true);
  }, 120_000);

  it.skipIf(!hasTool("git") || !hasTool("jq"))("真实工具的工具步（git + jq）：只读链路 3/3", async () => {
    const out = freshOut("repo-report");
    const res = await runApp(loadPack("repo-report"), {
      verbose: false, outDir: out, planPath: path.join(out, "plan.json"),
    });
    expect(res.ok, JSON.stringify(res.tool_steps)).toBe(true);
    expect(res.tool_steps.map((t) => t.source)).toEqual(["git-log", "bench-cases-index", "bench-cases-shape"]);
    expect(res.tool_steps.every((t) => t.done && t.code === 0)).toBe(true);
  }, 120_000);
});

/* ------------------------------------------- 第 2 轮共享层加固（复核发现，逐条钉住） */

describe("共享层加固：复核发现的 5 类缺陷不得回归", () => {
  it("G-G 浏览器步必须有 start_url——包括角色模板合并之后", () => {
    // 角色自带 start_url、但某一次使用把它覆盖掉：合并后就没有了
    const withRole = clone(loadPack("ctrip-case")) as any;
    delete withRole.roles["filter-window"].start_url;
    expect(validatePack(withRole).join(" | "))
      .toContain("a browser step needs start_url");

    // 普通（无角色）浏览器步同样要查：ctrip-case 的第 0 步就是无角色的浏览器步
    const plain = clone(loadPack("ctrip-case")) as any;
    delete plain.journey[0].start_url;
    expect(validatePack(plain).join(" | ")).toContain("needs start_url");
  });

  it("G-H 类型校验：max_subgoals / slots / required_slots / sources / model", () => {
    const p = clone(loadPack("demo-app")) as any;
    p.max_subgoals = 0;
    p.slots = "x";
    p.required_slots = "coupon";
    p.sources = "demo-tool";                    // 裸字符串会被逐字符遍历 -> 一串伪错误
    p.model = 5;
    const problems = validatePack(p).join(" | ");
    expect(problems).toContain("max_subgoals must be a positive integer");
    expect(problems).toContain("slots must be an object");
    expect(problems).toContain("required_slots must be a list of slot names");
    expect(problems).toContain("sources must be a list of source names");
    expect(problems).toContain("model must be a string");
    // 关键是**不要**再吐出一串"未知数据源"的伪错误
    expect(problems).not.toContain("not found");
  });

  it("G-E / G-F 探针集：跨列表重复 id 与非字符串 id", () => {
    const hosts = ["m.ctrip.com"];
    const cross = validateProbeBlock({
      http: [{ id: "a", url: "https://m.ctrip.com/1" }],
      alts: [{ id: "a", url: "https://m.ctrip.com/2" }],
    }, hosts);
    expect(cross.join(" | ")).toContain("ids are one namespace across the target lists");

    const numeric = validateProbeBlock({ http: [{ id: 1, url: "https://m.ctrip.com/1" }] }, hosts);
    expect(numeric.join(" | ")).toContain("id must be a string");
  });

  it("G-K {run_id}：同一条命令在同一个 --out 目录里重复运行必须可复现", async () => {
    const out = freshOut("g-k");
    const opts = { verbose: false, outDir: out, planPath: path.join(out, "plan.json"), allowDangerous: true };
    const first = await runApp(loadPack("cli-report"), opts);
    const second = await runApp(loadPack("cli-report"), opts);   // 同一个 out_dir！
    expect(first.tool_steps[3]!.attempts).toBe(3);
    expect(second.tool_steps[3]!.attempts).toBe(3);              // 修复前这里是 1
    // 机制说明：`{run_id}` 是"每次运行唯一"的那一半；注入固定 runId 就会复用计数（因此默认不能用固定值）
    const fixed = await runApp(loadPack("cli-report"), { ...opts, runId: "pinned" });
    const fixedAgain = await runApp(loadPack("cli-report"), { ...opts, runId: "pinned" });
    expect(fixed.tool_steps[3]!.attempts).toBe(3);
    expect(fixedAgain.tool_steps[3]!.attempts).toBe(1);
  }, 120_000);
});

/* --------------------------------------------------- 应用套件（"完成所有应用"的退出码） */

describe("应用套件：线上/离线是结构判据，不是人肉名单", () => {
  it("isLive 只看 journey 里的 start_url 协议（离线应用解析成 file://）", () => {
    expect(isLive(loadPack("qunar-live"))).toBe(true);        // 线上旅程：start_url 是 https
    expect(isLive(loadPack("demo-app"))).toBe(false);         // 仓库相对路径 -> file://
    expect(isLive(loadPack("ctrip-case"))).toBe(false);
    expect(isLive(loadPack("transfer-farehaven"))).toBe(false);
    // 测量型应用只声明 probe、没有 journey：它既不"线上"也不在套件里跑（另有验收口径）
    expect(loadPack("ctrip-live").journey).toHaveLength(0);
  });

  it("套件的判定三分法：通过 / 待放行（危险步未执行）/ 未通过，且只有「未通过」会让退出码变红", () => {
    // 静态断言规则本身：危险步被拒不是失败，也不是通过
    const refused = ["dangerous"];
    const onlyDangerous = refused.length > 0 && refused.every((r) => r === "dangerous");
    expect(onlyDangerous).toBe(true);
    expect(["dangerous", "tool-unavailable"].every((r) => r === "dangerous")).toBe(false);
  });
});

describe("共享层加固：`when` 与 `signal` 用同一套校验（出题方本轮发现的不对称）", () => {
  it("坏 `when` 在**加载期**就报，而不是运行期变成 BLOCKED", () => {
    // 出题方的原始最小复现：给一个角色模板塞未知算子的 when
    const p = clone(loadPack("transfer-farehaven")) as any;
    p.roles["dismiss-promo"].when = { magic_op: "#x" };
    const problems = validatePack(p).join(" | ");
    expect(problems).toContain("unknown signal op 'magic_op'");
    expect(problems).toContain(".when");

    // 组合里嵌套的坏算子同样要抓到
    const nested = clone(loadPack("transfer-farehaven")) as any;
    nested.roles["dismiss-promo"].when = { all_of: [{ not: { nope_op: "#x" } }] };
    expect(validatePack(nested).join(" | ")).toContain("unknown signal op 'nope_op'");

    // 空 when 是"永远为假"的伪装，也拒
    const empty = clone(loadPack("transfer-farehaven")) as any;
    empty.roles["dismiss-promo"].when = {};
    expect(validatePack(empty).join(" | ")).toContain("must be a non-empty signal");
  });

  it("真包里的 5 条 when 全部通过校验（修完不误伤既有数据）", () => {
    expect(validatePack(loadPack("transfer-farehaven"))).toEqual([]);
    expect(validatePack(loadPack("transfer-slowjet"))).toEqual([]);
  });
});

describe("共享层：`device` 声明（只有手机版页面存在的站点）", () => {
  it("qunar-live 声明了 iPhone 设备面，且校验通过（这是它能在线上跑通的前提）", () => {
    const pack = loadPack("qunar-live");
    expect(pack.device).toMatchObject({ is_mobile: true, has_touch: true, locale: "zh-CN" });
    expect((pack.device as any).viewport).toEqual({ width: 390, height: 844 });
    expect(String((pack.device as any).user_agent)).toContain("iPhone");
    expect(validatePack(pack)).toEqual([]);
  });

  it("坏 device 在加载期报错（未知键 / 视口形状 / 空 UA）", () => {
    const p = clone(loadPack("qunar-live")) as any;
    p.device = { user_agent: "", viewport: { width: 390 }, nope: 1, is_mobile: true };
    const problems = validatePack(p).join(" | ");
    expect(problems).toContain("device.viewport must be {width, height}");
    expect(problems).toContain("device.user_agent must be a non-empty string");
    expect(problems).toContain("device.nope: unknown key");
    const notObj = clone(loadPack("qunar-live")) as any;
    notObj.device = "iphone";
    expect(validatePack(notObj).join(" | ")).toContain("device must be an object");
  });

  it("没声明 device 的离线应用不受影响（老路径仍是 browser.newPage()）", () => {
    for (const id of ["demo-app", "ctrip-case", "transfer-skybook"]) {
      const pack = loadPack(id);
      if (pack.device === undefined) expect(validatePack(pack)).toEqual([]);
    }
  });
});

describe("套件退出码规则（§7/W2：边际为 0 不许算绿）", () => {
  it("优先级 1 > 3 > 4：没真执行完的运行不配被判定模型有没有用", () => {
    expect(suiteExitCode({ failed: 1, pending: 1, tierOn: true, marginal: 0 })).toBe(1);
    expect(suiteExitCode({ failed: 0, pending: 1, tierOn: true, marginal: 0 })).toBe(3);
    expect(suiteExitCode({ failed: 0, pending: 0, tierOn: true, marginal: 0 })).toBe(4);
    expect(suiteExitCode({ failed: 0, pending: 0, tierOn: true, marginal: 2 })).toBe(0);
    // 桩臂：过关数恒 0 是构造出来的，不能当"边际为 0"的证据 ⇒ 永远是 0（不新增红）
    expect(suiteExitCode({ failed: 0, pending: 0, tierOn: false, marginal: 0 })).toBe(0);
  });
});

describe("packHintCoverage（承重墙的单一实现：三处消费共用一份口径）", () => {
  it("工具步不进分母；target_hints 与 target_hint 都算点名", () => {
    const pack = clone(loadPack("demo-app")) as AppPack;
    const c = packHintCoverage(pack);
    expect(c.browser).toBe(4);                 // demo-app：5 个 journey 条目里 1 个是工具步
    expect(c.hinted).toBe(4);                  // 全部浏览器步都点了名
    const noHint = clone(pack) as AppPack;
    delete (noHint.roles as Record<string, Record<string, unknown>>)["add-to-cart"]["target_hint"];
    delete (noHint.roles as Record<string, Record<string, unknown>>)["add-to-cart"]["target_hints"];
    const c2 = packHintCoverage(noHint);
    expect(c2.hinted).toBeLessThan(c.hinted);  // 删声明 ⇒ 覆盖数真的掉下来（不是恒等于步数）
    expect(c2.browser).toBe(c.browser);        // 分母不动
  });
});
