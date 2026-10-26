/**
 * 一轮"使用者视角"评审（`bench/UX_REVIEW.md`）里揪出的 5 个问题的回归测试。
 *
 * 每个 it 都写清"以前是什么样、现在必须是什么样"——因为这几条的共同点是
 * **静默**：假绿、看不懂的报错、没说的副作用。静默的缺陷最容易在下一次重构里回来。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main as appMain, REFUSAL_LABELS, refusalLine } from "../src/app/app-runner.ts";
import { main as suiteMain, suite } from "../tools/apps_suite.ts";
import { checkArtifacts } from "../src/model/model-artifacts.ts";
// 这两条断言的是**真模型臂**的退出码梯子（3 = 未执行、4 = 模型边际为 0）。产物不齐的机器上
// 套件在装模型前就响亮拒绝——用例本身没得跑，按仓库纪律"明着跳过 ≠ 通过"（bench/smoke.sh 同款）。
const MODEL_READY = checkArtifacts().ready;
import { runApp } from "../src/app/app-runner.ts";
import { loadPack } from "../src/app/app-pack.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime } from "../src/model/model.ts";
import { installDecisionProvider } from "../src/model/decision-provider.ts";
import { main as startMain, type Io } from "../src/cli/start.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const TMP: string[] = [];
function tmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `ux-${tag}-`));
  TMP.push(d);
  return d;
}
afterEach(() => {
  installLayaRuntime(null);
  while (TMP.length) fs.rmSync(TMP.pop()!, { recursive: true, force: true });
});

/** 把 console 的输出收走，测试里不刷屏。 */
function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  return fn().finally(() => { console.log = log; console.error = err; });
}

describe("① `--slot` 打错名字不再是假绿", () => {
  it("未声明的槽位 -> exit 2（以前会静默塞进计划并照旧\"通过\"）", async () => {
    const code = await quiet(() => appMain(["--app", "demo-app", "--ablate", "stub", "--slot", "foo=1"]));
    expect(code).toBe(2);
  });

  it("声明过的槽位照常通过", async () => {
    const code = await quiet(() => appMain(["--app", "demo-app", "--ablate", "stub", "--slot", "coupon=ACME10",
      "--out", tmpDir("slot-ok")]));
    expect(code).toBe(0);
  }, 60_000);   // 有浏览器步：Windows 冷启动吃掉默认 5s（实测 5.02s 超时）

  it("`--slot` 连 k=v 都不是 -> exit 2", async () => {
    expect(await quiet(() => appMain(["--app", "demo-app", "--slot", "x"]))).toBe(2);
  });

  it("同一槽位给两次不再是静默 last-wins（复核方发现的同类问题）", async () => {
    expect(await quiet(() => appMain(["--app", "demo-app", "--ablate", "stub",
      "--slot", "coupon=A", "--slot", "coupon=B"]))).toBe(2);
  });
});

describe("② `apps:suite`：没跑过的应用不许报绿，坏包不许掀桌子", () => {
  it("`--only` 打错字 -> exit 2（以前是 \"0/0 通过\" + exit 0）", async () => {
    expect(await quiet(() => suiteMain(["--only", "demo-ap"]))).toBe(2);
  });

  it.skipIf(!MODEL_READY)("有\"未执行\"（危险步没放行）-> exit 3，而不是 0", async () => {
    // demo-app 通过 + cli-report 的危险步未放行：以前这一组合是 exit 0。
    expect(await quiet(() => suiteMain(["--only", "demo-app,cli-report"]))).toBe(3);
  }, 180_000);

  it.skipIf(!MODEL_READY)("全部真执行且通过 -> 消融臂 exit 0；真模型臂 exit 4（应用都过但模型边际为 0，不算绿）", async () => {
    // 两条断言各管一件事：
    //  · 消融臂（--ablate）只看"执行与验收"，全过就是 0（跳过/未执行仍被排除在同一条结论之外）；
    //  · 默认臂是真模型：demo-app 全过，但模型一步也没独立决定 ⇒ 4（docs/ARCHITECTURE_IMPROVEMENTS.md §7）。
    expect(await quiet(() => suiteMain(["--only", "demo-app", "--ablate"]))).toBe(0);
    expect(await quiet(() => suiteMain(["--only", "demo-app"]))).toBe(4);
  }, 300_000);

  it("`--json` 的用法错误也给可解析对象（脚本调用方不该拿到空 stdout）", async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    let code = 0;
    try {
      code = await (async () => {
        const err = console.error; console.error = () => {};
        try { return await suiteMain(["--only", "demo-ap", "--json"]); } finally { console.error = err; }
      })();
    } finally { console.log = log; }
    expect(code).toBe(2);
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed.exit_code).toBe(2);
    expect(parsed.unmatched).toEqual(["demo-ap"]);
    expect(parsed.known).toContain("demo-app");
  });

  it("suite() 报告未命中的过滤项，并给出已知应用名", async () => {
    const out = await quiet(() => suite(["nope-app"], { arm: "ablate" }));
    expect(out.unmatched).toEqual(["nope-app"]);
    expect(out.rows).toHaveLength(0);
    expect(out.known).toContain("demo-app");     // 打错字时能自查
  });
});

describe("③ 缺目标时的报错要说人话（身份 B 唯一一次被迫读源码的原因）", () => {
  it("没有 target_hint 的浏览器步 -> 报错直说\"names no target\"与补救办法", async () => {
    installDecisionProvider(null);
    installLayaRuntime(scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 }))));
    const dir = tmpDir("nohint");
    const packPath = path.join(dir, "pack.json");
    fs.writeFileSync(packPath, JSON.stringify({
      spec_version: 1, id: "ux-nohint", label: "复现：只有 signal 没有点名目标", goal: "打开门户页",
      model: "english", max_subgoals: 4, hosts: [], slots: {}, required_slots: [], sources: [],
      roles: { open: { desc: "打开 portal 页", start_url: "testpages/portal.html",
        signal: { url_contains: "portal.html" } } },
      journey: [{ role: "open" }],
      invariants: [{ id: "still-here", desc: "还在门户页", signal: { url_contains: "portal.html" } }],
    }), "utf-8");
    const res = await quiet(() => runApp(loadPack(packPath), {
      verbose: false, sources: false, outDir: dir, planPath: path.join(dir, "plan.json"),
    }));
    const reason = String((res.subgoals[0] as { obstacle?: string }).obstacle ?? "");
    expect(reason).toMatch(/names no target/);
    expect(reason).toMatch(/target_hint/);                 // 告诉使用者下一步改什么
    expect(reason).not.toMatch(/is not in the element pool/);   // 老消息（内部产物）不该再出现
  }, 180_000);
});

describe("④ 危险步在三个界面只有一套说法（并且带补救动作）", () => {
  it("REFUSAL_LABELS 是唯一来源：含\"未执行\"+\"怎么放行\"+\"没落盘\"", () => {
    expect(REFUSAL_LABELS.dangerous).toContain("未执行");
    expect(REFUSAL_LABELS.dangerous).toContain("--allow-dangerous");
    expect(REFUSAL_LABELS.dangerous).toContain("未落盘");
    expect(refusalLine("dangerous")).toBe(REFUSAL_LABELS.dangerous!.replace(/`/g, ""));
    for (const k of ["declined", "dry-run-failed", "tool-unavailable"]) {
      expect(REFUSAL_LABELS[k]).toContain("未执行");
    }
  });

  it("单应用报告的结论列写结论（不是内部类别），并带补救动作", async () => {
    const dir = tmpDir("cli-md");
    // 报告文件是 CLI 写的（runApp 只跑链路），所以这里走与使用者同一条命令。
    const code = await quiet(() => appMain(["--app", "cli-report", "--ablate", "stub", "--out", dir]));
    expect(code).toBe(1);                                      // 未执行 -> 非零
    const res = JSON.parse(fs.readFileSync(path.join(dir, "cli-report-result.json"), "utf-8"));
    expect(res.tool_steps[4].refused).toBe("dangerous");       // 机器字段没变
    const md = fs.readFileSync(path.join(dir, "cli-report-report.md"), "utf-8");
    expect(md).toContain("未执行（危险步未放行");
    expect(md).toContain("--allow-dangerous");
    expect(md).not.toMatch(/\| \*\*dangerous\*\* \|/);         // 老写法：只写类别
  }, 180_000);
});

describe("⑤ 副作用与用法错误都要说清", () => {
  it("`npm start` 打印它写进仓库的检查点路径（以前零提示就弄脏 git status）", async () => {
    installLayaRuntime(null);
    const lines: string[] = [];
    const io: Io = { out: (l) => lines.push(l), ask: async () => null };
    const plan = path.join(tmpDir("start"), ".task_plan.json");
    const code = await startMain(["--demo", "--plan", plan], io, { noModel: true });
    const text = lines.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("计划检查点：");
    expect(text).toContain(plan);
  }, 180_000);

  it("`--out` 建不出来是用法错误（exit 2），不是把 Node 的 mkdir 栈甩给使用者", async () => {
    // 跨平台必然建不出来：在一个**普通文件**下面建目录（ENOTDIR，Linux/Windows 同）。
    // （原来用 /sys、/proc 判断——Windows 上"管理员在盘根建目录"照样成功，exit 0。）
    const dir = tmpDir("out-blocked");
    const blocker = path.join(dir, "afile");
    fs.writeFileSync(blocker, "");
    const bad = path.join(blocker, "ux-out-should-fail");
    expect(await quiet(() => appMain(["--app", "demo-app", "--ablate", "stub", "--out", bad]))).toBe(2);
  });
});
