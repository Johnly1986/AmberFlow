/**
 * 进程观察面的信号语言测试 —— 命令行工具当动作腿时，"完成"这个判断本身要被验证。
 *
 * 与浏览器面同一套要求：叶子是**可验证的事实**（退出码/stdout/stderr/产物文件），
 * 组合只做逻辑（`all_of`/`any_of`/`not`，递归、不可能比叶子更宽松），且加载期就校验。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkToolSignal, TOOL_SIGNAL_OPS, validateToolSignal, type ToolSignal } from "../src/browser/tool-signals.ts";
import type { CliObservation } from "../src/data/datasource.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-tool-signals-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const obs = (over: Partial<CliObservation> = {}): CliObservation => ({
  code: 0, ok: true, stdout: "", stderr: "", argv: ["stub"], cwd: process.cwd(), exit_ok: [0], ...over,
});

describe("工具信号：加载期校验", () => {
  it("算子表是白名单，且与浏览器面同型的组合算子都在", () => {
    expect(Object.keys(TOOL_SIGNAL_OPS)).toEqual(expect.arrayContaining(
      ["all_of", "any_of", "not", "exit_ok", "exit_code_equals", "stdout_contains",
        "stderr_contains", "stdout_matches", "json_path_equals", "file_exists", "file_absent"]));
    expect(validateToolSignal({ exit_ok: true })).toEqual([]);
    expect(validateToolSignal({ stdout_contains: "x" })).toEqual([]);
    expect(validateToolSignal({ json_path_equals: ["a.b", 1] })).toEqual([]);
  });

  it.each([
    ["未知算子", { magic: 1 }, "unknown tool signal op 'magic'"],
    ["空信号", {}, "empty signal"],
    ["参数太多", { stdout_contains: ["a", "b"] }, "stdout_contains needs 1 argument(s)"],
    ["json_path 少参", { json_path_equals: ["a.b"] }, "json_path_equals needs 2 argument(s)"],
    ["all_of 空", { all_of: [] }, "all_of needs a non-empty list"],
    ["嵌套坏算子", { all_of: [{ nope: 1 }] }, "all_of[0]: unknown tool signal op 'nope'"],
    ["not 里坏算子", { not: { nope: 1 } }, "not: unknown tool signal op 'nope'"],
    ["信号不是对象", [1, 2] as unknown as ToolSignal, "signal must be an object"],
  ])("%s", (_label, spec, snippet) => {
    expect(validateToolSignal(spec as ToolSignal).join(" | ")).toContain(snippet);
  });
});

describe("工具信号：求值（叶子）", () => {
  it("exit_ok / exit_code_equals 看退出码（`grep` 那种语义化退出码用得上）", () => {
    expect(checkToolSignal(obs({ code: 0, ok: true }), { exit_ok: true })).toBe(true);
    expect(checkToolSignal(obs({ code: 3, ok: false }), { exit_ok: true })).toBe(false);
    expect(checkToolSignal(obs({ code: 3, ok: false }), { exit_code_equals: 3 })).toBe(true);
    // exit_ok 是由 source 的 exit_ok 白名单决定的，不是硬编码 0
    expect(checkToolSignal(obs({ code: 1, ok: true, exit_ok: [0, 1] }), { exit_ok: true })).toBe(true);
  });

  it("stdout/stderr 分开看：失败原因在 stderr，结果在 stdout", () => {
    const o = obs({ code: 2, ok: false, stdout: "rows: 3\n", stderr: "authentication required\n" });
    expect(checkToolSignal(o, { stdout_contains: "rows: 3" })).toBe(true);
    expect(checkToolSignal(o, { stderr_contains: "authentication required" })).toBe(true);
    expect(checkToolSignal(o, { stdout_contains: "authentication" })).toBe(false);
    expect(checkToolSignal(o, { stderr_contains: "rows: 3" })).toBe(false);
  });

  it("stdout_matches 是形状断言（正则），坏正则不抛而是不成立", () => {
    expect(checkToolSignal(obs({ stdout: "abc1234|Ada|2026-10-03|feat: x\n" }),
      { stdout_matches: "^[0-9a-f]{7,40}\\|[^|]*\\|\\d{4}-\\d{2}-\\d{2}\\|" })).toBe(true);
    expect(checkToolSignal(obs({ stdout: "nope" }), { stdout_matches: "^[0-9a-f]{7,40}\\|" })).toBe(false);
    expect(checkToolSignal(obs({ stdout: "nope" }), { stdout_matches: "([" })).toBe(false);
  });

  it("json_path_equals 用数据源那套路径语言；stdout 不是 JSON 就不成立", () => {
    const o = obs({ stdout: JSON.stringify({ rows: [{ id: "w-1" }, { id: "w-2" }], meta: { n: 2 } }) });
    expect(checkToolSignal(o, { json_path_equals: ["rows[1].id", "w-2"] })).toBe(true);
    expect(checkToolSignal(o, { json_path_equals: ["meta.n", "2"] })).toBe(true);
    expect(checkToolSignal(o, { json_path_equals: ["rows[0].id", "w-9"] })).toBe(false);
    expect(checkToolSignal(obs({ stdout: "not json" }), { json_path_equals: ["a", "b"] })).toBe(false);
  });

  it("file_exists / file_absent 看产物是否落地（相对路径按仓库根解析）", () => {
    const f = path.join(tmp, "artifact.txt");
    fs.writeFileSync(f, "x");
    expect(checkToolSignal(obs(), { file_exists: f })).toBe(true);
    expect(checkToolSignal(obs(), { file_absent: f })).toBe(false);
    const missing = path.join(tmp, "nope.txt");
    expect(checkToolSignal(obs(), { file_exists: missing })).toBe(false);
    expect(checkToolSignal(obs(), { file_absent: missing })).toBe(true);
    // 目录不算文件
    expect(checkToolSignal(obs(), { file_exists: tmp })).toBe(false);
  });

  it("未知算子求值为假（校验在加载期已经拦过一次）", () => {
    expect(checkToolSignal(obs(), { magic: 1 })).toBe(false);
  });
});

describe("工具信号：组合不能比叶子更宽松", () => {
  it("all_of 全真才真；any_of 有一真即真；not 取反", () => {
    const o = obs({ code: 0, ok: true, stdout: "wrote /tmp/x\n" });
    expect(checkToolSignal(o, { all_of: [{ exit_ok: true }, { stdout_contains: "wrote" }] })).toBe(true);
    expect(checkToolSignal(o, { all_of: [{ exit_ok: true }, { stdout_contains: "nope" }] })).toBe(false);
    expect(checkToolSignal(o, { any_of: [{ stdout_contains: "nope" }, { stdout_contains: "wrote" }] })).toBe(true);
    expect(checkToolSignal(o, { any_of: [{ stdout_contains: "a" }, { stdout_contains: "b" }] })).toBe(false);
    expect(checkToolSignal(o, { not: { stdout_contains: "boom" } })).toBe(true);
    expect(checkToolSignal(o, { not: { exit_ok: true } })).toBe(false);
    // 递归嵌套
    expect(checkToolSignal(o, {
      all_of: [{ any_of: [{ exit_code_equals: 9 }, { exit_ok: true }] }, { not: { stderr_contains: "x" } }],
    })).toBe(true);
  });
});
