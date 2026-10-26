/**
 * CLI 用法错误必须走**一行点名**，不是堆栈（src/support/cli-args.ts 的体例）。
 *
 * 缺陷来源：开箱测试轮实测——`npm start -- --out /tmp/x`、`plan-cli add` 的坏信号、
 * `apps -- --ap` 打错选项，全部把 parseArgs 的 TypeError 整段甩给第一次用的人。
 * 这里钉三件事：① 用法错误码被识别；② 真异常不被吞；③ 一行说法点名到具体选项。
 */
import { describe, expect, it } from "vitest";
import { parseArgs } from "node:util";
import {
  SHARED_RUN_OPTIONS, appOptions, benchOptions, cliBool, cliString, cliStrings,
  isParseUsageError, parseCliArgs, renamedHint, stripArgSeparators, usageErrorLine,
} from "../src/support/cli-args.ts";

describe("cli-args — a typo'd flag is a one-liner, not a stack trace", () => {
  it("recognizes Node's usage-error codes", () => {
    const grab = (args: string[]): unknown => {
      try {
        parseArgs({ args, options: { goal: { type: "string" } } });
        return null;
      } catch (err) { return err; }
    };
    expect(isParseUsageError(grab(["--nope"]))).toBe(true);          // UNKNOWN_OPTION
    expect(isParseUsageError(grab(["--goal"]))).toBe(true);          // MISSING_ARG_VALUE
    expect(isParseUsageError(new Error("boom"))).toBe(false);        // 真异常不是用法错误
    expect(isParseUsageError(null)).toBe(false);
  });

  it("the one-liner names the offending option and carries no stack", () => {
    let err: unknown;
    try { parseArgs({ args: ["--out", "/tmp/x"], options: {} }); } catch (e) { err = e; }
    const line = usageErrorLine(err);
    expect(line).toContain("--out");
    expect(line.startsWith("参数用法不对："));
    expect(line).not.toContain("\n");          // 一行
    expect(line).not.toMatch(/ at .*:\d+:\d+/); // 没有堆栈行
  });

  it("an unknown signal op from the CLI stays a normal Error (parseArgs did not raise it)", () => {
    expect(isParseUsageError(new Error("unknown signal op 'nope'"))).toBe(false);
  });

  it("a RENAMED flag gets the new spelling, not just a rejection", () => {
    // 升级窗口里旧桥仍会发 --no-model（README/DEVELOPING：link 形态换安装要重启宿主）。
    // 报错必须回答"那我该写什么"——这是改名轮的迁移账，不是新行为。
    let err: unknown;
    try { parseArgs({ args: ["--no-model"], options: { ablate: { type: "string" } } }); } catch (e) { err = e; }
    const line = usageErrorLine(err);
    const hint = renamedHint(line);
    expect(hint).toContain("--ablate rules-only");
    expect(hint).toContain("--ablate stub");
    expect(renamedHint("参数用法不对：Unknown option '--app'")).toBe(null);  // 没迁移可指就不硬凑
  });
});

describe("cli-args — 空命令 `--` 不再是命令", () => {
  it("stripArgSeparators 只吃掉 `--` 本身，其余原样", () => {
    expect(stripArgSeparators(["--app", "demo-app"])).toEqual(["--app", "demo-app"]);
    // npm/shell 的分隔符：`npm run apps -- --app demo-app` 在 Windows 的 shell 里会原样留下来。
    expect(stripArgSeparators(["--", "--app", "demo-app"])).toEqual(["--app", "demo-app"]);
    expect(stripArgSeparators(["--app", "--", "demo-app"])).toEqual(["--app", "demo-app"]);
    // `--` 之外一个字符都不动（`-` 是别的意思，`--x` 是旗标）
    expect(stripArgSeparators(["-", "--x", ""])).toEqual(["-", "--x", ""]);
  });

  it("留着 `--` 会把后面的旗标全变成位置参数（这正是要修的静默失败）", () => {
    const p = parseCliArgs(["--", "--app", "demo-app"], { options: { app: { type: "string" } } });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    // 修好后 `--app` 仍然是旗标；修之前 v.app === undefined（表现为"传了却像没传"）
    expect(p.values["app"]).toBe("demo-app");
    expect(p.positionals).toEqual([]);
  });
});

describe("cli-args — apps 与 bench 的旗标表对齐", () => {
  it("共用旗标在两个入口是同一批名字", () => {
    for (const name of Object.keys(SHARED_RUN_OPTIONS)) {
      expect(Object.keys(appOptions()), `apps 缺共用旗标 ${name}`).toContain(name);
      expect(Object.keys(benchOptions()), `bench 缺共用旗标 ${name}`).toContain(name);
    }
    // 模型名不走命令行：两个入口都不再有 model / force-model 旗标。
    expect(Object.keys(SHARED_RUN_OPTIONS)).not.toContain("model");
    expect(Object.keys(benchOptions())).not.toContain("force-model");
    expect(Object.keys(SHARED_RUN_OPTIONS)).toContain("conf-floor");
    expect(Object.keys(SHARED_RUN_OPTIONS)).toContain("ablate");
    expect(Object.keys(benchOptions())).toContain("force-conf-floor");
  });

  it("各自专属的旗标不混进对方的表（语料层 vs 应用包层）", () => {
    expect(Object.keys(appOptions())).toContain("app");
    expect(Object.keys(benchOptions())).not.toContain("app");
    expect(Object.keys(benchOptions())).toContain("cases");
    expect(Object.keys(appOptions())).not.toContain("cases");
  });

  it("parseCliArgs 把用法错误收成一行 + usage，不抛栈", () => {
    const lines: string[] = [];
    const r = parseCliArgs(["--nope"], {
      options: { app: { type: "string" } }, usage: "usage: x", say: (l) => lines.push(l),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe(2);
    expect(lines.join("\n")).toContain("--nope");
    expect(lines).toContain("usage: x");
  });

  it("取值助手按声明的形状读（string / multiple / boolean）", () => {
    const cli = parseCliArgs(
      ["--app", "x", "--slot", "a=1", "--slot", "b=2", "--headful"],
      { options: appOptions() },
    );
    expect(cli.ok).toBe(true);
    if (!cli.ok) return;
    expect(cliString(cli.values, "app")).toBe("x");
    expect(cliStrings(cli.values, "slot")).toEqual(["a=1", "b=2"]);
    expect(cliBool(cli.values, "headful")).toBe(true);
    expect(cliBool(cli.values, "confirm-safe")).toBe(false);            // 没给 = false
    expect(cliString(cli.values, "out")).toBe(undefined);               // 没给 = undefined，不是空串
  });
});
