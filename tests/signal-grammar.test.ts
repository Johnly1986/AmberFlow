/**
 * 信号语法：**两面共用同一个走查器**（P0-A）。
 *
 * 背景：DOM 面（`signal`/`when`）与进程面（工具步）曾经各写一份校验器，靠"成对改"的纪律
 * 维持同构；`when` 漏校验就是这么漏了一轮。现在语法只有一份 `signals.validateSignalSpec`，
 * 每个面只提供自己的**叶子算子表**与报错面名。
 *
 * 本文件证明的是**构造性质**：同一棵坏信号树，两面报出的结构完全一致（措辞只差面名）。
 * 面各自专属的叶子/无参叶子行为另有断言（见文件后半）。
 */
import { describe, expect, it } from "vitest";
import {
  DOM_SIGNAL_GRAMMAR, SIGNAL_OPS, validateSignalSpec,
} from "../src/engine/signals.ts";
import {
  TOOL_SIGNAL_GRAMMAR, TOOL_SIGNAL_OPS, validateToolSignal,
} from "../src/browser/tool-signals.ts";

/** 抹掉"面名"与"已知算子表"，只留下结构（路径 + 规则 + 参数个数）。 */
function structural(problems: string[]): string[] {
  return problems.map((p) => p
    .replace(/unknown tool signal op/g, "unknown signal op")
    .replace(/ \(known: [^)]*\)/g, ""));
}

/** 同一棵树，两面各校验一次，结构必须逐字相同。 */
function expectSameShape(spec: unknown): void {
  const dom = validateSignalSpec(spec, "at", DOM_SIGNAL_GRAMMAR);
  const tool = validateSignalSpec(spec, "at", TOOL_SIGNAL_GRAMMAR);
  expect(structural(tool)).toEqual(structural(dom));
}

describe("信号语法：唯一走查器（跨面构造性质）", () => {
  it("两面声明的组合算子集合相同（叶子可以不同，组合不能）", () => {
    const combos = (ops: Readonly<Record<string, number>>) =>
      Object.keys(ops).filter((k) => k === "all_of" || k === "any_of" || k === "not").sort();
    expect(combos(TOOL_SIGNAL_OPS)).toEqual(combos(SIGNAL_OPS));
  });

  it("grammar.ops 就是各面的算子表本体（同一对象，不是复制一份）", () => {
    expect(DOM_SIGNAL_GRAMMAR.ops).toBe(SIGNAL_OPS);
    expect(TOOL_SIGNAL_GRAMMAR.ops).toBe(TOOL_SIGNAL_OPS);
  });

  it("组合算子/递归/路径在两面完全同构", () => {
    const cases: unknown[] = [
      { all_of: [] },
      { any_of: [] },
      { all_of: [{}] },
      { all_of: [{ nope: 1 }] },
      { any_of: [{ not: { nope: 1 } }] },
      { not: "不是对象" },
      { not: { not: { nope_op: 1 } } },
      { all_of: [{ all_of: [] }] },
      { magic: 1 },
      { all_of: [{ any_of: [{ magic2: 1 }] }] },
    ];
    for (const spec of cases) expectSameShape(spec);
  });

  it("路径逐层展开（嵌套能定位到第几个孩子）", () => {
    const dom = validateSignalSpec({ all_of: [{ any_of: [{ magic: 1 }] }] }, "subgoal[3]");
    expect(dom).toEqual([
      `subgoal[3].all_of[0].any_of[0]: unknown signal op 'magic' (known: ${Object.keys(DOM_SIGNAL_GRAMMAR.ops).join(", ")})`,
    ]);
    const tool = validateToolSignal({ all_of: [{ any_of: [{ magic: 1 }] }] }, "step 2");
    expect(tool.join(" | ")).toContain("step 2.all_of[0].any_of[0]: unknown tool signal op 'magic'");
  });
});

describe("信号语法：两个面各自的叶子", () => {
  it("DOM 面：空信号默认报 empty，但调用方可接管措辞（allowEmpty）", () => {
    expect(validateSignalSpec({}, "s")).toEqual(["s: empty signal"]);
    expect(validateSignalSpec({}, "s", DOM_SIGNAL_GRAMMAR, { allowEmpty: true })).toEqual([]);
  });

  it("DOM 面：叶子 arity 由 SIGNAL_OPS 决定", () => {
    expect(validateSignalSpec({ css_text_equals: ["#a"] }, "s"))
      .toEqual(["s: css_text_equals needs 2 argument(s)"]);
    expect(validateSignalSpec({ url_contains: "x" }, "s")).toEqual([]);
  });

  it("进程面：无参叶子 exit_ok 不看值（与 DOM 的 manual 同型）", () => {
    expect(validateToolSignal({ exit_ok: true })).toEqual([]);
    expect(validateToolSignal({ exit_ok: "随便什么" })).toEqual([]);
    expect(validateToolSignal({ exit_ok: [1, 2] })).toEqual([]);
  });

  it("进程面：未知算子带已知算子表（给人配 CLI 用）", () => {
    const problems = validateToolSignal({ magic: 1 });
    expect(problems[0]).toContain("unknown tool signal op 'magic'");
    expect(problems[0]).toContain("(known: all_of, any_of, not");
  });

  it("进程面：叶子 arity 仍然严格", () => {
    expect(validateToolSignal({ stdout_contains: ["a", "b"] }).join(" | "))
      .toContain("stdout_contains needs 1 argument(s)");
    expect(validateToolSignal({ json_path_equals: ["a.b"] }).join(" | "))
      .toContain("json_path_equals needs 2 argument(s)");
  });
});
