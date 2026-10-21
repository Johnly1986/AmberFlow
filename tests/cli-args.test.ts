/**
 * CLI 用法错误必须走**一行点名**，不是堆栈（src/support/cli-args.ts 的体例）。
 *
 * 缺陷来源：开箱测试轮实测——`npm start -- --out /tmp/x`、`plan-cli add` 的坏信号、
 * `apps -- --ap` 打错选项，全部把 parseArgs 的 TypeError 整段甩给第一次用的人。
 * 这里钉三件事：① 用法错误码被识别；② 真异常不被吞；③ 一行说法点名到具体选项。
 */
import { describe, expect, it } from "vitest";
import { parseArgs } from "node:util";
import { isParseUsageError, renamedHint, usageErrorLine } from "../src/support/cli-args.ts";

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
