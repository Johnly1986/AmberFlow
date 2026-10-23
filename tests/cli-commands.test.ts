/**
 * 八个命令组的**行为契约**（设计文档 §3.3–§3.10、§4.4）。
 *
 * 这里的每个断言都只做一件事：证明**新旗标被翻译成正确的旧调用**，或者
 * **在起任何子进程之前就把话说完**。做法是把 `ctx.runEntry` 换成记录器——
 * 它记下"打算跑哪个旧入口、带哪些参数"，于是"翻译表"第一次成为可测的东西，
 * 而不是散在 `docs/` 里的承诺。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cli, workspace, type CliResult } from "./cli-harness.ts";

const PLAN = "./.amberflow/plan.json";

/** 建一份"跑得起来"的计划：new（带入口页） + add（带信号）。 */
async function seedPlan(cwd: string, home: string): Promise<void> {
  const created = await cli(["plan", "new", "测试目标", "--url", "https://example.com/p/1"], { cwd, home });
  expect(created.code).toBe(0);
  const added = await cli(["plan", "add", "加入购物车", "--signal", "css_exists=#ok"], { cwd, home });
  expect(added.code).toBe(0);
}

const forwarded = (r: CliResult): { entry: string; args: string[] } =>
  ({ entry: r.calls[0]!.entry, args: r.calls[0]!.args });

/* -------------------------------------------------------------------- run */

describe("amber run — 一扇门、四种模式", () => {
  it("应用模式：新旗标翻译成 app-runner 的旧旗标", async () => {
    const r = await cli([
      "run", "demo-app", "--headful", "--skip-data", "--allow-dangerous", "--remember",
      "--slot", "city=上海", "--checkpoint", "p.onnx", "--min-confidence", "0.3",
      "--without-hints", "--out", "out-dir",
    ], { runEntry: 0 });
    expect(r.code).toBe(0);
    const { entry, args } = forwarded(r);
    expect(entry).toBe("src/app/app-runner.ts");
    expect(args).toEqual(expect.arrayContaining([
      "--app", "demo-app", "--headful", "--no-sources", "--allow-dangerous", "--learn-hints",
      "--slot", "city=上海", "--model", "p.onnx", "--conf-floor", "0.3",
      "--force-hints", "off", "--out", "out-dir",
    ]));
  });

  it("旧旗标别名也被归一化（--dry / --no-sources / --learn-hints）", async () => {
    const r = await cli(["run", "demo-app", "--dry", "--no-sources", "--learn-hints"], { runEntry: 0 });
    expect(forwarded(r).args).toEqual(expect.arrayContaining(["--dry", "--no-sources", "--learn-hints"]));
  });

  it("--slot 必须是 k=v（拼写错误在起浏览器之前就报）", async () => {
    const r = await cli(["run", "demo-app", "--slot", "novalue", "--json"], { runEntry: 0 });
    expect(r.code).toBe(2);
    expect(r.json().error.message).toContain("--slot");
  });

  it("目标模式：--goal 与 --url 必须成对，缺一个就报", async () => {
    for (const args of [["run", "--goal", "g"], ["run", "--url", "https://example.com"]]) {
      const r = await cli([...args, "--json"], { runEntry: 0 });
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.json().error.code, args.join(" ")).toBe("USAGE");
    }
  });

  it("目标模式转发给 start，并把计划落点一起带上", async () => {
    const r = await cli(["run", "--goal", "把商品加入购物车", "--url", "https://example.com/p/1"], {
      runEntry: 0,
    });
    expect(r.code).toBe(0);
    const { entry, args } = forwarded(r);
    expect(entry).toBe("src/cli/start.ts");
    expect(args).toEqual(["--goal", "把商品加入购物车", "--url", "https://example.com/p/1",
      "--plan", PLAN]);
  });

  it("demo 模式转发给 start --plan，且 --demo 不能和别的模式混用", async () => {
    const r = await cli(["run", "--demo", "--headful"], { runEntry: 0 });
    expect(forwarded(r)).toEqual({ entry: "src/cli/start.ts", args: ["--plan", PLAN, "--headful"] });

    for (const args of [["run", "--demo", "demo-app"], ["run", "--demo", "--plan", "x.json"]]) {
      const bad = await cli([...args, "--json"], { runEntry: 0 });
      expect(bad.code, args.join(" ")).toBe(2);
    }
  });

  it("计划模式：非 TTY 默认 --confirm deny，--yes 才是 allow", async () => {
    const ws = workspace();
    try {
      await seedPlan(ws.cwd, ws.home);
      const deny = await cli(["run", "--plan", PLAN], { cwd: ws.cwd, home: ws.home, runEntry: 0 });
      expect(deny.code).toBe(0);
      expect(forwarded(deny)).toEqual({
        entry: "tools/plan_cli.ts",
        args: ["run", "--file", PLAN, "--confirm", "deny"],
      });

      const allow = await cli(["run", "--plan", PLAN, "--yes"], { cwd: ws.cwd, home: ws.home, runEntry: 0 });
      expect(forwarded(allow).args).toEqual(expect.arrayContaining(["--confirm", "allow"]));

      const reset = await cli(["run", "--plan", PLAN, "--reset", "--replan"], {
        cwd: ws.cwd, home: ws.home, runEntry: 0,
      });
      expect(forwarded(reset).args).toEqual(expect.arrayContaining(["--reset", "--replan"]));
    } finally {
      ws.cleanup();
    }
  });

  it("非 TTY 不允许 --confirm ask（没人来回答）", async () => {
    const ws = workspace();
    try {
      await seedPlan(ws.cwd, ws.home);
      const r = await cli(["run", "--plan", PLAN, "--confirm", "ask", "--json"], {
        cwd: ws.cwd, home: ws.home, runEntry: 0,
      });
      expect(r.code).toBe(2);
      expect(r.json().error.message).toContain("--confirm ask");
      expect(r.json().error.next.join()).toContain("--confirm deny");
    } finally {
      ws.cleanup();
    }
  });

  it("--confirm 只接受 allow / ask / deny", async () => {
    const ws = workspace();
    try {
      await seedPlan(ws.cwd, ws.home);
      const r = await cli(["run", "--plan", PLAN, "--confirm", "maybe", "--json"], {
        cwd: ws.cwd, home: ws.home, runEntry: 0,
      });
      expect(r.code).toBe(2);
      expect(r.json().error.message).toContain("maybe");
    } finally {
      ws.cleanup();
    }
  });

  it("模式互斥：应用 / --goal / --plan / --demo 一次只能选一个", async () => {
    const cases = [
      ["run", "demo-app", "--goal", "g", "--url", "u"],
      ["run", "a", "b"],
      ["run", "--demo", "--goal", "g", "--url", "u"],
      ["run", "--headful", "--headless"],
    ];
    for (const args of cases) {
      const r = await cli([...args, "--json"], { runEntry: 0 });
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.json().error.code, args.join(" ")).toBe("USAGE");
    }
  });

  it("作用域不符的旗标点名拒绝（--out / --slot 不用于 --goal）", async () => {
    for (const args of [["run", "--goal", "g", "--url", "u", "--out", "o"],
      ["run", "--goal", "g", "--url", "u", "--slot", "a=1"]]) {
      const r = await cli([...args, "--json"], { runEntry: 0 });
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.json().error.message, args.join(" ")).toMatch(/只用于/);
    }
  });

  it("无参数 + JSON：不替用户挑应用，退出码 2 并给出清单", async () => {
    const r = await cli(["run", "--json"]);
    expect(r.code).toBe(2);
    const o = r.json();
    expect(o.data.mode).toBe("pick");
    expect(o.error.code).toBe("USAGE");
    expect(o.diagnostics.join()).toContain("不替用户选择");
    expect(o.data.apps.length).toBeGreaterThan(0);
  });

  it("无参数 + 非 TTY：打印应用清单后退出 2（不静默跑第一个）", async () => {
    const r = await cli(["run"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("非 TTY 不替用户选择");
    expect(r.calls).toEqual([]);
  });

  it("应用 --dry-run --json 不启子进程，直接给出展开后的计划", async () => {
    const r = await cli(["run", "demo-app", "--dry-run", "--json", "--slot", "a=1"]);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
    const o = r.json();
    expect(o.data.mode).toBe("app");
    expect(o.data.dry_run).toBe(true);
    expect(o.data.app).toBe("demo-app");
  });

  it("--max 必须是正整数", async () => {
    const r = await cli(["run", "--plan", PLAN, "--max", "0", "--json"], { runEntry: 0 });
    expect(r.code).toBe(2);
    expect(r.json().error.message).toContain("--max");
  });
});

/* ----------------------------------------------------------------- record */

describe("amber record — 非 TTY 必须先说清页面从哪来", () => {
  it("非 TTY 缺 --url / --cdp → 用法错误，并给出两条可抄的写法", async () => {
    const r = await cli(["record", "--json"]);
    expect(r.code).toBe(2);
    const o = r.json();
    expect(o.error.code).toBe("USAGE");
    expect(o.error.hint).toContain("非 TTY");
    expect(o.error.next.length).toBeGreaterThan(1);
  });

  it("--script 回放仍需要页面", async () => {
    const r = await cli(["record", "--script", "./a.json", "--json"]);
    expect(r.code).toBe(2);
    expect(r.json().error.message).toContain("--script");
  });

  it("--name / --id 是同一个东西：只能给一个", async () => {
    const r = await cli(["record", "--url", "https://example.com", "--name", "a", "--id", "b", "--json"],
      { runEntry: 0 });
    expect(r.code).toBe(2);
    expect(r.json().error.message).toContain("--id 是旧名");
  });

  it("headless / headful 只能选一个；位置参数与 --url 重复也报", async () => {
    for (const args of [
      ["record", "--headless", "--headful"],
      ["record", "https://example.com", "--url", "https://example.com"],
      ["record", "a", "b"],
    ]) {
      const r = await cli([...args, "--json"], { runEntry: 0 });
      expect(r.code, args.join(" ")).toBe(2);
    }
  });

  it("默认 headful（与旧 learn 的 headless 默认相反）", async () => {
    const r = await cli(["record", "--url", "https://example.com"], { runEntry: 0 });
    expect(r.code).toBe(0);
    const { entry, args } = forwarded(r);
    expect(entry).toBe("tools/learn.ts");
    expect(args).toEqual(["--url", "https://example.com", "--headful"]);
  });

  it("--headless 不再补 --headful", async () => {
    const r = await cli(["record", "--url", "u", "--headless"], { runEntry: 0 });
    expect(forwarded(r).args).not.toContain("--headful");
  });

  it("位置参数就是页面；其余旗标按旧入口的名字转发", async () => {
    const r = await cli([
      "record", "https://example.com", "--name", "my-app", "--goal", "加购",
      "--cdp", "ws://127.0.0.1:9222", "--out", "o", "--pack-dir", "p",
      "--script", "s.json", "--yes",
    ], { runEntry: 0 });
    expect(forwarded(r).args).toEqual([
      "--id", "my-app", "--url", "https://example.com", "--cdp", "ws://127.0.0.1:9222",
      "--goal", "加购", "--out", "o", "--pack-dir", "p", "--script", "s.json",
      "--yes", "--headful",
    ]);
  });
});

/* ------------------------------------------------------------------- plan */

describe("amber plan — 1-based 编号 + 稳定 id", () => {
  it("缺子命令 / 未知子命令都是用法错误", async () => {
    for (const args of [["plan"], ["plan", "nope"]]) {
      const r = await cli([...args, "--json"]);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.json().error.hint, args.join(" ")).toContain("new / show / add");
    }
  });

  it("plan new 用 --save-plan（--plan 只表示输入计划）", async () => {
    const bad = await cli(["plan", "new", "g", "--plan", "x.json", "--json"]);
    expect(bad.code).toBe(2);
    expect(bad.json().error.message).toContain("--save-plan");

    const ws = workspace();
    try {
      const ok = await cli(["plan", "new", "g", "--save-plan", "custom.json", "--json"], {
        cwd: ws.cwd, home: ws.home,
      });
      expect(ok.code).toBe(0);
      expect(ok.json().data.path).toBe("custom.json");
      expect(fs.existsSync(path.join(ws.cwd, "custom.json"))).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it("plan new 缺目标 → 用法错误", async () => {
    const r = await cli(["plan", "new", "--json"]);
    expect(r.code).toBe(2);
  });

  it("旧 --file / --hint 在这一层翻译成 --plan / --target", async () => {
    const ws = workspace();
    try {
      await seedPlan(ws.cwd, ws.home);
      const r = await cli(["plan", "add", "第二步", "--signal", "css_exists=#x",
        "--file", "custom.json", "--hint", "#y", "--json"], { cwd: ws.cwd, home: ws.home });
      // --file 在 add 里是输入计划；custom.json 不存在 → 点名"没有找到计划"
      expect(r.code).toBe(2);
      expect(r.json().error.message).toContain("custom.json");
    } finally {
      ws.cleanup();
    }
  });

  it("--signal 与 --signal-file 只能给一个；--signal-file 读不了就报", async () => {
    const ws = workspace();
    try {
      await seedPlan(ws.cwd, ws.home);
      const both = await cli(["plan", "add", "x", "--signal", "css_exists=#a",
        "--signal-file", "s.json", "--json"], { cwd: ws.cwd, home: ws.home });
      expect(both.code).toBe(2);
      expect(both.json().error.message).toContain("只能给一个");

      const missing = await cli(["plan", "add", "x", "--signal-file", "nope.json", "--json"],
        { cwd: ws.cwd, home: ws.home });
      expect(missing.code).toBe(2);
      expect(missing.json().error.message).toContain("--signal-file");
    } finally {
      ws.cleanup();
    }
  });

  it("--signal-file 可以传复杂信号", async () => {
    const ws = workspace();
    try {
      await seedPlan(ws.cwd, ws.home);
      fs.writeFileSync(path.join(ws.cwd, "sig.json"),
        JSON.stringify({ url_contains: "cart.html" }), "utf-8");
      const r = await cli(["plan", "add", "打开购物车", "--signal-file", "sig.json", "--json"],
        { cwd: ws.cwd, home: ws.home });
      expect(r.code).toBe(0);
      expect(r.json().data.signal).toEqual({ url_contains: "cart.html" });
    } finally {
      ws.cleanup();
    }
  });

  it("--at 越界点名到可插范围；合法则插到指定位置", async () => {
    const ws = workspace();
    try {
      await seedPlan(ws.cwd, ws.home);
      const bad = await cli(["plan", "add", "x", "--signal", "css_exists=#a", "--at", "9", "--json"],
        { cwd: ws.cwd, home: ws.home });
      expect(bad.code).toBe(2);
      expect(bad.json().error.message).toContain("可插 1..");

      const ok = await cli(["plan", "add", "插到最前", "--signal", "css_exists=#a", "--at", "1", "--json"],
        { cwd: ws.cwd, home: ws.home });
      expect(ok.code).toBe(0);
      expect(ok.json().data.index).toBe(1);
    } finally {
      ws.cleanup();
    }
  });

  it("步骤 id 是 描述slug-短哈希，重复描述也不会撞", async () => {
    const ws = workspace();
    try {
      await seedPlan(ws.cwd, ws.home);
      const a = await cli(["plan", "add", "同名步骤", "--signal", "css_exists=#a", "--json"],
        { cwd: ws.cwd, home: ws.home });
      const b = await cli(["plan", "add", "同名步骤", "--signal", "css_exists=#b", "--json"],
        { cwd: ws.cwd, home: ws.home });
      expect(a.json().data.id).toMatch(/^[\w-]+$/);
      expect(b.json().data.id).not.toBe(a.json().data.id);
    } finally {
      ws.cleanup();
    }
  });

  it("plan edit 至少要给一个字段；引用不存在的步骤要点名", async () => {
    const ws = workspace();
    try {
      await seedPlan(ws.cwd, ws.home);
      const noField = await cli(["plan", "edit", "1", "--json"], { cwd: ws.cwd, home: ws.home });
      expect(noField.code).toBe(2);
      expect(noField.json().error.message).toContain("至少给一个字段");

      const badRef = await cli(["plan", "edit", "nope", "--desc", "x", "--json"],
        { cwd: ws.cwd, home: ws.home });
      expect(badRef.code).toBe(2);
      expect(badRef.json().error.message).toContain("nope");
    } finally {
      ws.cleanup();
    }
  });

  it("plan move 需要 --to 且不能越界", async () => {
    const ws = workspace();
    try {
      await seedPlan(ws.cwd, ws.home);
      const noTo = await cli(["plan", "move", "1", "--json"], { cwd: ws.cwd, home: ws.home });
      expect(noTo.code).toBe(2);

      const badTo = await cli(["plan", "move", "1", "--to", "9", "--json"], { cwd: ws.cwd, home: ws.home });
      expect(badTo.code).toBe(2);
      expect(badTo.json().error.message).toContain("越界");
    } finally {
      ws.cleanup();
    }
  });

  it("plan check：坏计划报 problems，退出码 2", async () => {
    const ws = workspace();
    try {
      await seedPlan(ws.cwd, ws.home);
      const ok = await cli(["plan", "check", "--json"], { cwd: ws.cwd, home: ws.home });
      expect(ok.code).toBe(0);
      expect(ok.json().data.ok).toBe(true);

      // 故意塞一个没有信号的步骤
      const file = path.join(ws.cwd, ".amberflow", "plan.json");
      const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { subgoals: Array<Record<string, unknown>> };
      raw.subgoals.push({ desc: "没有信号的步骤", signal: {} });
      fs.writeFileSync(file, JSON.stringify(raw, null, 2), "utf-8");

      const bad = await cli(["plan", "check", "--json"], { cwd: ws.cwd, home: ws.home });
      expect(bad.code).toBe(2);
      expect(bad.json().data.problems.length).toBeGreaterThan(0);
      expect(bad.json().error.code).toBe("USAGE");
    } finally {
      ws.cleanup();
    }
  });

  it("plan reset 把状态清回 pending；plan rm 报告删掉的是哪一步", async () => {
    const ws = workspace();
    try {
      await seedPlan(ws.cwd, ws.home);
      expect((await cli(["plan", "reset", "--json"], { cwd: ws.cwd, home: ws.home })).code).toBe(0);

      const rm = await cli(["plan", "rm", "1", "--json"], { cwd: ws.cwd, home: ws.home });
      expect(rm.code).toBe(0);
      expect(rm.json().data.removed).toBe("加入购物车");

      const again = await cli(["plan", "rm", "1", "--json"], { cwd: ws.cwd, home: ws.home });
      expect(again.code).toBe(2);      // 已经删空了
    } finally {
      ws.cleanup();
    }
  });

  it("plan run：缺 start_url 先报；非 TTY 默认 deny；转发给 plan-cli", async () => {
    const ws = workspace();
    try {
      await seedPlan(ws.cwd, ws.home);
      const r = await cli(["plan", "run"], { cwd: ws.cwd, home: ws.home, runEntry: 0 });
      expect(r.code).toBe(0);
      const { entry, args } = forwarded(r);
      expect(entry).toBe("tools/plan_cli.ts");
      expect(args).toEqual(["run", "--file", path.join(ws.cwd, ".amberflow", "plan.json"),
        "--confirm", "deny", "--max", "8"]);

      // 去掉 start_url：执行器不知道从哪一页开始
      const file = path.join(ws.cwd, ".amberflow", "plan.json");
      const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { subgoals: Array<Record<string, unknown>> };
      for (const s of raw.subgoals) delete s.start_url;
      fs.writeFileSync(file, JSON.stringify(raw, null, 2), "utf-8");
      const noUrl = await cli(["plan", "run", "--json"], { cwd: ws.cwd, home: ws.home, runEntry: 0 });
      expect(noUrl.code).toBe(2);
      expect(noUrl.json().error.message).toContain("start_url");
      expect(noUrl.json().error.next.join()).toContain("plan edit");
    } finally {
      ws.cleanup();
    }
  });
});

/* ------------------------------------------------------------------- apps */

describe("amber apps — 发现制目录的两个作用域", () => {
  it("无子命令 = list；旧 --list 仍是别名", async () => {
    const a = await cli(["apps"], { runEntry: 0 });
    expect(a.code).toBe(0);
    expect(a.out).toContain("demo-app");
    const b = await cli(["apps", "--list"], { runEntry: 0 });
    expect(b.code).toBe(0);
    expect(b.out).toContain("demo-app");
  });

  it("未知子命令 → 用法错误并列出可用子命令", async () => {
    const r = await cli(["apps", "nope", "--json"]);
    expect(r.code).toBe(2);
    expect(r.json().error.hint).toContain("list / show / check / path / remove");
  });

  it("show / path / check 都要求一个应用；多给就报", async () => {
    for (const sub of ["show", "path"]) {
      const none = await cli(["apps", sub, "--json"]);
      expect(none.code, sub).toBe(2);
      const many = await cli(["apps", sub, "a", "b", "--json"]);
      expect(many.code, sub).toBe(2);
    }
    const r = await cli(["apps", "check", "a", "b", "--json"]);
    expect(r.code).toBe(2);
  });

  it("show 给出目标 / 步骤 / 验收条件；path 只给一行路径", async () => {
    const shown = await cli(["apps", "show", "demo-app", "--json"], { runEntry: 0 });
    expect(shown.code).toBe(0);
    expect(shown.json().data.pack.journey.length).toBeGreaterThan(0);

    const p = await cli(["apps", "path", "demo-app", "--json"], { runEntry: 0 });
    expect(p.code).toBe(0);
    expect(p.json().data.path).toMatch(/pack\.json$/);
  });

  it("内置应用默认删不掉（退出码 3 = 被策略挡住），--force 才放行", async () => {
    const blocked = await cli(["apps", "remove", "demo-app", "--yes", "--json"], { runEntry: 0 });
    expect(blocked.code).toBe(3);
    expect(blocked.json().error.code).toBe("BLOCKED");
    expect(blocked.json().error.hint).toContain("--force");
    expect(blocked.calls).toEqual([]);
  });

  it("非 TTY 删用户应用也要 --yes（--yes 不隐含 --allow-dangerous）", async () => {
    const ws = workspace();
    try {
      const dir = path.join(ws.home, "apps", "my-app");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "pack.json"), JSON.stringify({
        id: "my-app", label: "我的应用", goal: "g", journey: [],
      }), "utf-8");
      const opts = { cwd: ws.cwd, home: ws.home };

      const needsYes = await cli(["apps", "remove", "my-app", "--json"], { ...opts, runEntry: 0 });
      expect(needsYes.code, needsYes.out).toBe(3);
      expect(needsYes.json().error.code).toBe("BLOCKED");
      expect(needsYes.json().error.hint).toContain("--yes");
      expect(fs.existsSync(dir)).toBe(true);

      const done = await cli(["apps", "remove", "my-app", "--yes", "--json"], { ...opts, runEntry: 0 });
      expect(done.code).toBe(0);
      expect(done.json().data.removed).toContain("my-app");
      expect(fs.existsSync(dir)).toBe(false);
    } finally {
      ws.cleanup();
    }
  });
});

/* ----------------------------------------------------------------- doctor */

describe("amber doctor — 体检不替你做决定", () => {
  it("--json 给出完整分段，退出码与信封一致", async () => {
    const r = await cli(["doctor", "--json"], { runEntry: 0 });
    const o = r.json();
    expect(o.command).toBe("doctor");
    for (const key of ["node", "chromium", "model", "llm", "provider", "config", "apps", "report"]) {
      expect(o.data, key).toHaveProperty(key);
    }
    expect(o.data.config.layers.map((l: { name: string }) => l.name)).toContain("用户配置");
    const want = o.data.node.ok && o.data.chromium.ok ? 0 : 2;
    expect(r.code).toBe(want);
    expect(o.exit_code).toBe(want);
  });

  it("人类输出有报告 / 配置层 / 应用计数；--verbose 补上四个路径", async () => {
    const plain = await cli(["doctor"], { runEntry: 0 });
    expect(plain.code).toBe(0);
    expect(plain.out).toContain("AmberFlow doctor");
    expect(plain.out).toContain("用户配置");
    expect(plain.out).toContain("应用：");
    expect(plain.out).not.toContain("工作目录：");

    const verbose = await cli(["doctor", "--verbose"], { runEntry: 0 });
    expect(verbose.out).toContain("工作目录：");
    expect(verbose.out).toContain("应用目录：");
  });

  it("决策源解析失败只是警告，不改变只看核心项的退出码", async () => {
    const r = await cli(["doctor", "--json"], {
      runEntry: 0,
      env: { AMBERFLOW_DECISION_PROVIDER: "definitely-not-a-provider" },
    });
    const o = r.json();
    expect(o.data.provider.error).toBeTruthy();
    expect(r.code).toBe(o.data.node.ok && o.data.chromium.ok ? 0 : 2);
  });
});

/* ------------------------------------------------------------------ model */

describe("amber model — 三件产物的状态与安装", () => {
  it("无子命令 = status", async () => {
    const r = await cli(["model"], { runEntry: 0 });
    expect(r.code).toBe(0);
    expect(r.out).toContain("ONNX：");
  });

  it("status --json 报三件齐不齐、缺哪件", async () => {
    const r = await cli(["model", "status", "--json"], { runEntry: 0 });
    const o = r.json();
    expect(o.command).toBe("model status");
    expect(typeof o.data.ready).toBe("boolean");
    expect(o.data.missing.length === 0).toBe(o.data.ready);
    expect(o.next.join()).toMatch(/amber (model fetch|run)/);
  });

  it("path 给出引擎实际会读的位置", async () => {
    const r = await cli(["model", "path", "--json"], { runEntry: 0 });
    expect(r.code).toBe(0);
    expect(r.json().data.path).toMatch(/\.onnx$/);
  });

  it("未知子命令 → 用法错误", async () => {
    const r = await cli(["model", "nope", "--json"], { runEntry: 0 });
    expect(r.code).toBe(2);
    expect(r.json().error.hint).toContain("status / fetch / path");
  });

  it("fetch 缺 --from 就是用法错误（不先下载再报）", async () => {
    const r = await cli(["model", "fetch", "--json"], { runEntry: 0 });
    expect(r.code).toBe(2);
    expect(r.json().error.message).toContain("--from");
    expect(r.calls).toEqual([]);
  });

  it("fetch 把新旗标翻译成 model-fetch 的旧旗标", async () => {
    const r = await cli(["model", "fetch", "--from", "D:/m/laya.onnx", "--to", "D:/m/out.onnx",
      "--sha256-onnx", "aa", "--sha256-data", "bb", "--tokenizer", "t.json",
      "--sha256-tokenizer", "cc", "--force"], { runEntry: 0 });
    expect(r.code).toBe(0);
    const { entry, args } = forwarded(r);
    expect(entry).toBe("src/model/model-fetch.ts");
    expect(args).toEqual(["--from", "D:/m/laya.onnx", "--out", "D:/m/out.onnx",
      "--sha256-onnx", "aa", "--sha256-data", "bb", "--tokenizer", "t.json",
      "--sha256-tokenizer", "cc", "--force"]);
  });
});

/* -------------------------------------------------------------------- dev */

describe("amber dev — 维护面收在一处", () => {
  it("无子命令 / --help 打印 dev 帮助", async () => {
    for (const args of [["dev"], ["dev", "--help"]]) {
      const r = await cli(args, { runEntry: 0 });
      expect(r.code, args.join(" ")).toBe(0);
      expect(r.out, args.join(" ")).toContain("dev — 套件、基准、对拍、测量");
    }
  });

  it("未知子命令点名可用清单", async () => {
    const r = await cli(["dev", "nope", "--json"], { runEntry: 0 });
    expect(r.code).toBe(2);
    expect(r.json().error.hint).toContain("suite / matrix / verify");
  });

  it("每个子命令落到设计文档里点名的那个旧入口", async () => {
    const table: Array<[string[], string]> = [
      [["matrix"], "tools/apps_matrix.ts"],
      [["bench"], "src/cli/bench.ts"],
      [["generate"], "tools/spec-to-pack.ts"],
      [["shortlist"], "tools/shortlist_demo.ts"],
      [["induce"], "tools/induce_signal.ts"],
      [["apps-induce"], "tools/apps-induce.ts"],
      [["plan-flow"], "src/flow/plan-flow.ts"],
      [["semantic"], "src/flow/semantic-flow.ts"],
      [["parity", "rules"], "tools/parity.ts"],
      [["parity", "transfer"], "tools/transfer-parity.ts"],
      [["measure", "cache"], "tools/cache_measure.ts"],
      [["measure", "gate"], "tools/gate-signals.ts"],
      [["providers", "baseline"], "tools/provider-baselines.ts"],
      [["providers", "probe"], "tools/probe-baseline.ts"],
      [["serve", "picker"], "src/cli/picker-server.ts"],
      [["legacy", "ip-config"], "src/cli/ip-config.ts"],
      [["legacy", "tune-guard"], "src/cli/tune-guard.ts"],
    ];
    for (const [sub, entry] of table) {
      const r = await cli(["dev", ...sub], { runEntry: 0 });
      expect(r.code, sub.join(" ")).toBe(0);
      expect(forwarded(r).entry, sub.join(" ")).toBe(entry);
    }
  });

  it("parity all 跑遍六层，短路在第一层失败", async () => {
    const all = await cli(["dev", "parity", "all"], { runEntry: 0 });
    expect(all.calls.map((c) => c.entry)).toEqual([
      "tools/parity.ts", "tools/extraction-parity.ts", "tools/executor-parity.ts",
      "tools/datasource-parity.ts", "tools/ctrip-parity.ts", "tools/transfer-parity.ts",
    ]);
    expect(all.code).toBe(0);

    const short = await cli(["dev", "parity", "all"], {
      runEntry: (entry) => (entry === "tools/parity.ts" ? 2 : 0),
    });
    expect(short.code).toBe(2);
    expect(short.calls).toHaveLength(1);
  });

  it("未知 parity 层 / measure 目标 / providers 目标 / serve 目标都点名可选值", async () => {
    const cases: Array<[string[], RegExp]> = [
      [["parity", "nope"], /rules \/ extraction/],
      [["measure", "nope"], /cache \/ hints/],
      [["providers", "nope"], /baseline \/ probe/],
      [["legacy", "nope"], /ip-config \/ camera-entry/],
      [["measure"], /未知的 dev measure/],
    ];
    for (const [sub, want] of cases) {
      const r = await cli(["dev", ...sub, "--json"], { runEntry: 0 });
      expect(r.code, sub.join(" ")).toBe(2);
      expect(`${r.json().error.message} ${r.json().error.hint ?? ""}`, sub.join(" ")).toMatch(want);
    }
    const serve = await cli(["dev", "serve", "nope", "--json"], { runEntry: 0 });
    expect(serve.code).toBe(2);
    expect(serve.json().error.hint).toContain("picker");
  });

  it("providers nominate 自动带上 --provider token-plan", async () => {
    const r = await cli(["dev", "providers", "nominate"], { runEntry: 0 });
    expect(forwarded(r).args.slice(0, 2)).toEqual(["--provider", "token-plan"]);
  });

  it("suite 的 --real-model 是无操作（默认就是真模型臂），并给出提示", async () => {
    const r = await cli(["dev", "suite", "--real-model"], { runEntry: 0 });
    expect(r.code).toBe(0);
    expect(forwarded(r).entry).toBe("tools/apps_suite.ts");
    expect(forwarded(r).args).not.toContain("--real-model");
    expect(r.err).toContain("--real-model 已无操作");
  });
});
