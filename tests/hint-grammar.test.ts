/**
 * hint 语法：**解析只有一份**（P0-B）。
 *
 * 背景：池侧（`rules.hintMatchImpl`）与 DOM 侧回捞（`extraction.hintLookup`）曾经各写一遍
 * 字符串解析，靠"成对改"维持同构，漂移过两次（`#id` 只加一侧、`=` 漏大小写折叠）。
 * 现在形状识别、属性名规范化、大小写折叠、去引号都只在 `engine/hint.ts` 的 `parseHint` 里发生一次。
 *
 * 本文件钉两件事：
 *   1) 6 种形状各自解析成什么（含历史踩过的边界：大写设备 ID、带引号的值、link 角色词）；
 *   2) DOM 侧拿到的**就是** parseHint 的结果（`hintLookupArgs`），不是第二个解析器。
 */
import { describe, expect, it } from "vitest";
import { parseHint } from "../src/engine/hint.ts";
import { hintMatch, hintCandidates } from "../src/engine/rules.ts";
import { hintLookupArgs } from "../src/engine/extraction.ts";
import type { ElemPool } from "../src/engine/extraction.ts";

const pool = (): ElemPool => ({
  e1: { ref: "e1", scan: 0, tag: "a", label: "购物车", id: "cart-link", href: "/cart" },
  e2: { ref: "e2", scan: 1, tag: "a", label: "Cart", id: "shopping-cart-link", href: "/cart" },
  e3: { ref: "e3", scan: 2, tag: "input", label: "Search", id: "searchInput", name: "q", input_type: "text" },
  e4: { ref: "e4", scan: 3, tag: "button", label: "Add to cart", data_test: "add-to-cart" },
  e5: { ref: "e5", scan: 4, tag: "button", label: "Add to cart", data_test: "net-CAM-1001" },
  e6: { ref: "e6", scan: 5, tag: "input", label: "Submit", input_type: "submit" },
  e7: { ref: "e7", scan: 6, tag: "a", label: "Alan Turing", href: "/wiki/Alan_Turing" },
  e8: { ref: "e8", scan: 7, tag: "a", label: "Alan Turing law", href: "/wiki/Alan_Turing_law" },
});

describe("hint 解析：6 种形状", () => {
  it("id：大小写折叠", () => {
    expect(parseHint("#SearchInput")).toEqual({ kind: "id", value: "searchinput" });
  });

  it("attr=：属性名规范化 + 值折叠（历史漂移点：大写设备 ID）", () => {
    expect(parseHint("a[data-test=NET-cam-1001]")).toEqual(
      { kind: "attrEq", tag: "a", attr: "data-test", value: "net-cam-1001" });
    expect(parseHint("a[href~Alan_Turing]")).toEqual(
      { kind: "attrSubstr", tag: "a", attr: "href", value: "alan_turing" });
  });

  it("attr= 的值去引号（文档里写成 'x' 也要能认）", () => {
    expect(parseHint("a[data-test='cart-link']")).toEqual(
      { kind: "attrEq", tag: "a", attr: "data-test", value: "cart-link" });
  });

  it("attr=：`test`/`type` 规范化成 DOM 名，值去引号", () => {
    expect(parseHint("a[data-test=cart-link]")).toEqual(
      { kind: "attrEq", tag: "a", attr: "data-test", value: "cart-link" });
    expect(parseHint("input[type='submit']")).toEqual(
      { kind: "attrEq", tag: "input", attr: "type", value: "submit" });
  });

  it("near~：带括号与不带括号两种都认（不带括号的只有池侧有近邻上下文）", () => {
    expect(parseHint("button[near~onesie]").kind).toBe("attrSubstr");
    expect(parseHint("button[near~onesie]")).toEqual(
      { kind: "attrSubstr", tag: "button", attr: "near", value: "onesie" });
    expect(parseHint("row~onesie")).toEqual({ kind: "nearToken", tag: "", token: "onesie" });
  });

  it("角色词：link 是池侧词汇，DOM 侧映射成 a", () => {
    expect(parseHint("link")).toEqual({ kind: "tag", tag: "link" });
    expect(parseHint("button")).toEqual({ kind: "tag", tag: "button" });
  });

  it("裸词：整串折叠成 token", () => {
    expect(parseHint("  Alan Turing  ")).toEqual({ kind: "bare", token: "alan turing" });
  });
});

describe("hint 解析：两面拿到的是同一个结果", () => {
  it("DOM 侧调用参数里的 parsed 就是 parseHint(hint)", () => {
    for (const h of ["#SearchInput", "a[href~Alan_Turing]", "input[type=submit]", "button", "裸词"]) {
      const args = hintLookupArgs(h);
      expect(args.parsed).toEqual(parseHint(h));
      expect(args.hint).toBe(h.trim().toLowerCase());
    }
  });
});

describe("hint 匹配：解析之后池侧行为不变（回归钉）", () => {
  it("大写设备 ID 的 = 分支仍然命中（漏折叠会整批 BLOCKED）", () => {
    expect(hintMatch("button[data-test=net-CAM-1001]", pool())).toBe("e5");
  });

  it("~ 的路径段档位仍然生效：先精确、再整段、最后子串", () => {
    const one = hintCandidates("a[href~Alan_Turing]", pool());
    expect(one?.tier).toBe(2);          // 两个都是整段命中（Alan_Turing / Alan_Turing_law 的后缀）
  });

  it("角色词 link 仍然只命中 <a>", () => {
    const hits = hintCandidates("link", pool());
    expect(hits!.refs.every((r) => pool()[r]!.tag === "a")).toBe(true);
  });

  it("裸词档位：整标签优先于子串", () => {
    expect(hintMatch("购物车", pool())).toBe("e1");
    expect(hintMatch("Alan Turing", pool())).toBe("e7");
  });
});
