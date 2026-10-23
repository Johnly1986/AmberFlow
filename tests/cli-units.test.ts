/**
 * CLI 的**纯函数层**：参数归一化、错误面、JSON 信封、命令表、context、子进程退出码。
 *
 * 这一层不需要临时目录也不需要假子进程——它们是"翻译规则"，规则错了谁都跑不对，
 * 所以逐条钉住：旧旗标映射、可选值旗标、错误码 → 退出码、信封形状、帮助与分发的同源。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  flatList, hasFlag, injectOptionalValue, normalizeAliases, parseOrThrow, parseSlots, stringValue,
} from "../src/cli/args.ts";
import {
  blockedError, CliError, EXIT, formatCliError, incompleteError, usageError, usageFromParseError,
} from "../src/cli/errors.ts";
import { errorEnvelope, SCHEMA_VERSION, successEnvelope } from "../src/cli/json.ts";
import {
  COMMANDS, commandHelp, commandSpec, globalHelp, GLOBAL_USAGE, suggestion,
} from "../src/cli/registry.ts";
import { diag, emitJson, makeContext, say, type CliContext } from "../src/cli/context.ts";
import { runExecutable } from "../src/cli/process.ts";
import { emitPlanStatus } from "../src/cli/plan-result.ts";
import { TaskPlan } from "../src/engine/plan.ts";
import { ctxOf, workspace } from "./cli-harness.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ args */

describe("args.ts — 无歧义的旗标归一化", () => {
  it("旧旗标一对一换成新旗标（只认无歧义的那些）", () => {
    expect(normalizeAliases(["--dry", "--no-sources", "--learn-hints", "--hint-memory"]))
      .toEqual(["--dry-run", "--skip-data", "--remember", "--memory"]);
    expect(normalizeAliases(["--conf-floor", "0.5", "--model", "p.onnx", "--hint", "#add"]))
      .toEqual(["--min-confidence", "0.5", "--checkpoint", "p.onnx", "--target", "#add"]);
  });

  it("--plan 不放进全局表：它的含义依赖命令（保存位置 vs 输入）", () => {
    expect(normalizeAliases(["--plan", "x.json"])).toEqual(["--plan", "x.json"]);
  });

  it("双 token 的 --force-hints off 是特例，不能靠单词映射", () => {
    expect(normalizeAliases(["--force-hints", "off"])).toEqual(["--without-hints"]);
    expect(normalizeAliases(["--force-hints=off"])).toEqual(["--without-hints"]);
    // 不是 off 就原样留给命令自己报错，不悄悄吞掉
    expect(normalizeAliases(["--force-hints", "on"])).toEqual(["--force-hints", "on"]);
  });

  it("未知旗标原样通过（归一化不替命令做校验）", () => {
    expect(normalizeAliases(["--whatever", "-x"])).toEqual(["--whatever", "-x"]);
  });

  it("injectOptionalValue 只给裸旗标补默认值", () => {
    expect(injectOptionalValue(["--plan"], "--plan", "./.amberflow/plan.json"))
      .toEqual(["--plan", "./.amberflow/plan.json"]);
    // 后面紧跟另一个旗标也视为"没给值"，否则 parseArgs 会把旗标当值吃掉
    expect(injectOptionalValue(["--plan", "--json"], "--plan", "D")).toEqual(["--plan", "D", "--json"]);
    expect(injectOptionalValue(["--plan", "x.json"], "--plan", "D")).toEqual(["--plan", "x.json"]);
    expect(injectOptionalValue(["--goal", "g"], "--plan", "D")).toEqual(["--goal", "g"]);
  });

  it("hasFlag 认 `--flag` 与 `--flag=value` 两种写法", () => {
    expect(hasFlag(["--json"], "--json")).toBe(true);
    expect(hasFlag(["a", "--json=1"], "--json")).toBe(true);
    expect(hasFlag(["--jsonld"], "--json")).toBe(false);
    expect(hasFlag(["--quiet", "-q"], "--quiet", "-q")).toBe(true);
  });

  it("flatList 同时接受可重复与逗号分隔（旧脚本的混合写法）", () => {
    expect(flatList(["a,b", " c ,, d "])).toEqual(["a", "b", "c", "d"]);
    expect(flatList(undefined)).toEqual([]);
  });

  it("parseSlots 要求 k=v（空键与缺 = 都点名拒绝）", () => {
    expect(parseSlots(["city=上海", "date=2026-10-03"])).toEqual({ city: "上海", date: "2026-10-03" });
    expect(() => parseSlots(["novalue"])).toThrow(/--slot 要写成 k=v/);
    expect(() => parseSlots(["=v"])).toThrow(/--slot 要写成 k=v/);
  });

  it("stringValue 只认字符串，避免把布尔当值", () => {
    expect(stringValue("x")).toBe("x");
    expect(stringValue(true)).toBeUndefined();
  });

  it("parseOrThrow 把 parseArgs 的 TypeError 收成 CliError（exit 2）", () => {
    const err = ((): unknown => {
      try {
        return parseOrThrow(() => { throw new TypeError("Unknown option '--nope'"); });
      } catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT.USAGE);
  });
});

/* ---------------------------------------------------------------- errors */

describe("errors.ts — 错误码 → 退出码 → 下一步", () => {
  it("退出码表就是设计文档里那六个", () => {
    expect(EXIT).toEqual({
      OK: 0, INCOMPLETE: 1, USAGE: 2, BLOCKED: 3, QUALITY_GATE: 4, INTERRUPTED: 130,
    });
  });

  it("三个构造器各自落到自己的退出码", () => {
    expect(usageError("x").exitCode).toBe(2);
    expect(blockedError("x").exitCode).toBe(3);
    expect(incompleteError("x").exitCode).toBe(1);
    expect(usageError("x").code).toBe("USAGE");
    expect(blockedError("x").code).toBe("BLOCKED");
    expect(incompleteError("x").code).toBe("INCOMPLETE");
  });

  it("默认 exit 2，且 hint / next 缺省为空而不是 undefined", () => {
    const e = new CliError("X", "boom");
    expect(e.exitCode).toBe(2);
    expect(e.hint).toBeNull();
    expect(e.next).toEqual([]);
  });

  it("人类错误块是三行一组：错误 / 提示 / 下一步，且不含堆栈", () => {
    const lines = formatCliError(blockedError("被策略挡住", {
      hint: "加 --allow-dangerous", next: ["amber run x --allow-dangerous"],
    }));
    expect(lines).toEqual([
      "错误：被策略挡住",
      "提示：加 --allow-dangerous",
      "下一步：",
      "  amber run x --allow-dangerous",
    ]);
    expect(lines.join("\n")).not.toMatch(/ at .*:\d+:\d+/);
  });

  it("usageFromParseError 把旧旗标错误翻译成新旗标提示", () => {
    expect(usageFromParseError(new Error("TypeError: Unknown option '--dry'")).hint).toContain("--dry-run");
    expect(usageFromParseError(new Error("TypeError: Unknown option '--no-sources'")).hint).toContain("--skip-data");
    expect(usageFromParseError(new Error("TypeError: Unknown option '--whatever'")).hint).toBeNull();
    expect(usageFromParseError(new Error("boom")).message).toContain("参数用法不对");
  });
});

/* ------------------------------------------------------------------ json */

describe("json.ts — stdout 上只有一个信封", () => {
  it("成功信封：schema 版本 / 命令名 / ok / 退出码 / data", () => {
    const env = successEnvelope("apps list", { a: 1 }, { next: ["amber run demo-app"] });
    expect(env).toEqual({
      schema_version: SCHEMA_VERSION,
      command: "apps list",
      ok: true,
      exit_code: 0,
      data: { a: 1 },
      diagnostics: [],
      next: ["amber run demo-app"],
    });
  });

  it("退出码非 0 时 ok=false（不靠调用方自觉填）", () => {
    expect(successEnvelope("run", {}, { exitCode: 1 }).ok).toBe(false);
  });

  it("错误信封：错误码 + 人类提示 + 下一步，没有 hint 就不放空字段", () => {
    const plain = errorEnvelope("run", usageError("坏了"));
    expect(plain.ok).toBe(false);
    expect(plain.exit_code).toBe(2);
    expect(plain.error).toEqual({ code: "USAGE", message: "坏了", next: [] });
    expect("hint" in plain.error!).toBe(false);

    const hinted = errorEnvelope("run", blockedError("挡住", { hint: "h", next: ["n"] }), ["d"]);
    expect(hinted.error!.hint).toBe("h");
    expect(hinted.diagnostics).toEqual(["d"]);
  });
});

/* -------------------------------------------------------------- registry */

describe("registry.ts — 命令表是唯一的帮助来源", () => {
  it("命令名不重复，且每条都有用法 / 示例 / 旗标", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of COMMANDS) {
      expect(c.usage.length, c.name).toBeGreaterThan(0);
      expect(c.summary.length, c.name).toBeGreaterThan(0);
      expect(c.examples.length, c.name).toBeGreaterThan(0);
      expect(c.flags.length, c.name).toBeGreaterThan(0);
    }
  });

  it("帮助里有的命令，分发表里一定有的（帮助与入口同源）", () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, "src/cli/main.ts"), "utf-8");
    for (const c of COMMANDS) {
      expect(mainSrc, `main.ts 缺少 case "${c.name}"`).toContain(`case "${c.name}":`);
    }
  });

  it("反过来：分发表里的命令，要么在帮助里，要么在故意隐身的短名单里", () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, "src/cli/main.ts"), "utf-8");
    const dispatched = [...mainSrc.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]!);
    // 兼容层 / 补全 / 版本 / 帮助刻意不进用户命令表：它们不是"一项工作"的入口。
    const HIDDEN = new Set(["legacy", "completion", "version", "help"]);
    expect(dispatched.length).toBeGreaterThan(COMMANDS.length);
    for (const name of dispatched) {
      if (HIDDEN.has(name)) expect(COMMANDS.some((c) => c.name === name), `${name} 不该隐形`).toBe(false);
      else expect(commandSpec(name), `registry 缺少 ${name} 的说明`).toBeDefined();
    }
  });

  it("commandHelp 把语法 / 示例 / 选项 / 退出码拼成一段中文", () => {
    const help = commandHelp("run");
    expect(help).toContain("run — 运行应用、计划或一次性目标");
    expect(help).toContain("语法：");
    expect(help).toContain("示例：");
    expect(help).toContain("--dry-run");
    expect(help).toContain("退出码：0=成功");
    expect(help).toContain("相关命令：");
  });

  it("未知名字的 commandHelp 退回全局帮助（不抛错）", () => {
    expect(commandHelp("nope")).toBe(GLOBAL_USAGE);
    expect(commandSpec("nope")).toBeUndefined();
  });

  it("globalHelp(--all) 才露出高级选项", () => {
    expect(globalHelp()).not.toContain("--ablate");
    expect(globalHelp(true)).toContain("--ablate");
    expect(globalHelp()).toContain("amber <命令> [选项]");
  });

  it("suggestion 只给近距离的候选，差太远就不硬凑", () => {
    expect(suggestion("rn", ["run", "record", "plan"])).toBe("run");
    expect(suggestion("aplans", ["run", "record", "plan", "apps"])).toBe("plan");
    expect(suggestion("zzzzzzzzzz", ["run", "record"])).toBeNull();
  });
});

/* --------------------------------------------------------------- context */

describe("context.ts — 输出分流的唯一实现", () => {
  it("say 走 stdout，diag 走 stderr，emitJson 只写 stdout", () => {
    const out: string[] = [];
    const err: string[] = [];
    const ctx: CliContext = makeContext({
      stdout: (l) => out.push(l), stderr: (l) => err.push(l),
    });
    say(ctx, "人话");
    diag(ctx, "进度");
    emitJson(ctx, { a: 1 });
    expect(out).toEqual(["人话", '{\n  "a": 1\n}']);
    expect(err).toEqual(["进度"]);
  });

  it("makeContext 的缺省是可注入的（测试不依赖真实进程状态）", () => {
    const { ctx, out, ws } = ctxOf();
    try {
      expect(ctx.cwd).toBeTruthy();
      expect(ctx.globals).toEqual({
        json: false, quiet: false, verbose: false, yes: false, noColor: false, timeout: null,
      });
      expect(ctx.explicitConfig).toBeNull();
      say(ctx, "x");
      expect(out).toEqual(["x"]);
    } finally {
      ws.cleanup();
    }
  });
});

/* --------------------------------------------------------------- process */

describe("process.ts — 子进程退出码归一化", () => {
  it("退出码原样透传", async () => {
    const code = await runExecutable(process.execPath, ["-e", "process.exit(3)"], {});
    expect(code).toBe(3);
  });

  it("启动不了的可执行文件 → 2（不是抛栈）", async () => {
    const code = await runExecutable("definitely-not-a-binary-xyz", ["--version"], {});
    expect(code).toBe(2);
  });

  it("stdoutToStderr 把子进程 stdout 让给信封", async () => {
    const code = await runExecutable(process.execPath, ["-e", "console.log('noise')"], {
      stdoutToStderr: true,
    });
    expect(code).toBe(0);
  });
});

/* ----------------------------------------------------------- plan-result */

describe("plan-result.ts — 从计划文件重建统一信封", () => {
  it("步骤状态按完成 / 跳过计数，退出码非 0 时给出错误口径", async () => {
    const ws = workspace();
    try {
      const file = path.join(ws.cwd, "plan.json");
      // TaskPlan 的构造器会把 status 归一成 pending（与旧执行器同口径），
      // 所以"跑过一半的计划"要构造完再改状态再落盘——磁盘才是权威。
      const plan = new TaskPlan("目标", [
        { desc: "a", signal: { url_contains: "a" } },
        { desc: "b", signal: { url_contains: "b" } },
        { desc: "c", signal: { url_contains: "c" } },
      ] as never, file, {});
      plan.subgoals[0]!.status = "done";
      plan.subgoals[1]!.status = "skipped";
      plan.save();

      const { ctx, out } = ctxOf({ cwd: ws.cwd, home: ws.home });
      const code = await emitPlanStatus(ctx, {
        file, pathLabel: "./plan.json", mode: "plan", code: 1,
      });
      expect(code).toBe(1);
      const env = JSON.parse(out.join("\n")) as Record<string, any>;
      expect(env.ok).toBe(false);
      expect(env.exit_code).toBe(1);
      expect(env.data.completed).toBe("2/3");
      expect(env.data.skipped).toBe(1);
      expect(env.data.steps).toHaveLength(3);
      expect(env.error.code).toBe("INCOMPLETE");
    } finally {
      ws.cleanup();
    }
  });

  it("退出码 → 错误码的映射：130 / 3 / 2 / 其它", async () => {
    const ws = workspace();
    try {
      const file = path.join(ws.cwd, "plan.json");
      new TaskPlan("g", [], file, {}).save();
      const seen: string[] = [];
      for (const [code, want] of [[130, "INTERRUPTED"], [3, "BLOCKED"], [2, "USAGE"], [1, "INCOMPLETE"]] as const) {
        const { ctx, out } = ctxOf({ cwd: ws.cwd, home: ws.home });
        await emitPlanStatus(ctx, { file, pathLabel: "p", mode: "demo", code });
        seen.push((JSON.parse(out.join("\n")) as Record<string, any>).error?.code ?? "none");
        expect(seen.at(-1)).toBe(want);
      }
      // 0 不产生 error 字段
      const { ctx, out } = ctxOf({ cwd: ws.cwd, home: ws.home });
      await emitPlanStatus(ctx, { file, pathLabel: "p", mode: "goal", code: 0, dryRun: true });
      const env = JSON.parse(out.join("\n")) as Record<string, any>;
      expect(env.error).toBeUndefined();
      expect(env.data.dry_run).toBe(true);
    } finally {
      ws.cleanup();
    }
  });
});
