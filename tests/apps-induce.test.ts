/**
 * 不变量归纳（第 3 条）：让跑通的旅程自己提出"什么必须成立"。
 *
 * 这里是它的**资格测试**，不是它的说明书：
 *   1. 候选必须是"结束后为真、对照态为假"（区分性）——否则它只是把页面上本来就有的东西抄了一遍；
 *   2. 对照态是"这条旅程少做最后一步"，不是首页（首页会把城市输入框/搜索按钮这类无关 UI 也收进来）；
 *   3. 写回只追加、不覆盖人的判断，且重复信号不写第二遍。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPack } from "../src/app/app-pack.ts";
import { evalSignalOnState, type StateView } from "../src/engine/signals.ts";
import {
  appendInvariants, captureRun, discriminating, induceOnce, intersect, removeInvariants,
  toInvariant, type Proposal,
} from "../tools/apps-induce.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const TMP: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "apps-induce-test-"));
  TMP.push(d);
  return d;
}
afterEach(() => { while (TMP.length) fs.rmSync(TMP.pop()!, { recursive: true, force: true }); });

describe("不变量归纳：对照态 = 旅程少做最后一步", () => {
  it("归纳 ctrip-case：候选存在、每条都通过区分性闸门、且复跑结果一致", async () => {
    const pack = loadPack(path.join(REPO, "apps", "ctrip-case", "pack.json"));
    const run = await captureRun(pack, { outDir: tmp(), runId: "t1" });
    expect(run.control).toMatch(/少做最后一步/);
    expect(run.ok).toBe(true);
    const proposals = await induceOnce(pack, tmp(), "t2");
    expect(proposals.length).toBeGreaterThan(0);
    for (const p of proposals) {
      expect(evalSignalOnState(p.signal, run.after)).toBe(true);      // 结束后为真
      expect(evalSignalOnState(p.signal, run.before)).toBe(false);    // 对照态为假
      expect(p.why).toMatch(/对照：/);                                 // 审查的人要知道跟什么比的
    }
    // 归纳到的必须是"这一步真的改变了什么"：识别到记录节点，而不是首页的 UI
    expect(JSON.stringify(proposals.map((p) => p.signal))).toMatch(/hotel-recorded/);
    expect(JSON.stringify(proposals.map((p) => p.signal))).not.toMatch(/city-input/);
  }, 600_000);

  it("与手写的不变量对照：归纳命中了同一个节点，但断言写法不同（人仍要 review）", async () => {
    const pack = loadPack(path.join(REPO, "apps", "ctrip-case", "pack.json"));
    const hand = JSON.stringify((pack.invariants ?? []).map((i) => i.signal));
    const proposals = await induceOnce(pack, tmp(), "t3");
    const induced = JSON.stringify(proposals.map((p) => p.signal));
    expect(hand).toMatch(/hotel-recorded/);       // 手写的那条断言 [data-test=hotel-recorded] 含「已记录」
    expect(induced).toMatch(/hotel-recorded/);    // 归纳命中了同一个节点
    expect(induced).not.toBe(hand);               // 但写法不同：归纳给的是它观测到的文本，不是人的措辞
  }, 600_000);

  it("区分性闸门：真在对照态里也成立的信号会被拒", () => {
    const before = { url: "file:///x/report.html", elems: { e1: { tag: "div", data_test: "log", label: "空" } } } as StateView;
    const after = { url: "file:///x/report.html", elems: { e1: { tag: "div", data_test: "log", label: "已记录" } } } as StateView;
    expect(discriminating({ css_text_equals: ["[data-test=log]", "已记录"] }, before, after)).toBe(true);
    // 这条在两边都成立（URL 没变）→ 不是"这条旅程的结束状态"，拒
    expect(discriminating({ url_contains: "report.html" }, before, after)).toBe(false);
  });

  it("复跑取交集：只有每次都出现的候选算数", () => {
    const mk = (s: string): Proposal => ({ id: s, desc: s, signal: { css_exists: [s] }, why: s, kind: "appeared" });
    const a = [mk("#x"), mk("#y")];
    const b = [mk("#y"), mk("#z")];
    expect(intersect([a, b]).map((p) => p.id)).toEqual(["#y"]);
    expect(intersect([])).toEqual([]);
  });

  it("候选 → 不变量：id 稳定、可安全写进 JSON", () => {
    const p = toInvariant({ signal: { css_text_equals: ["[data-test=log]", "已记录"] }, kind: "appeared", why: "x", stability: 3 } as never, "app-1");
    expect(p.id).toMatch(/^induced-[a-z0-9-]+$/);
    expect(p.desc).toContain("归纳");
    expect(toInvariant({ signal: { css_exists: ["#a"] }, kind: "appeared", why: "x", stability: 3 } as never, "app-1").id)
      .toBe(toInvariant({ signal: { css_exists: ["#a"] }, kind: "appeared", why: "y", stability: 3 } as never, "app-1").id);
  });
});

describe("不变量归纳：写回只追加，不覆盖人的判断", () => {
  it("撤掉不可复现的候选：只删指定的 id，人的条目一条不动", () => {
    const file = path.join(tmp(), "pack.json");
    fs.writeFileSync(file, JSON.stringify({
      id: "x",
      invariants: [
        { id: "human-1", desc: "人的判断", signal: { css_exists: ["#human"] } },
        { id: "induced-bad", desc: "归纳但不可复现", signal: { not: { css_exists: ["#ledger-table"] } } },
      ],
    }, null, 2));
    expect(removeInvariants(file, new Set(["induced-bad"]))).toEqual(["induced-bad"]);
    const after = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(after.invariants.map((i: { id: string }) => i.id)).toEqual(["human-1"]);
  });

  it("追加 + 幂等：重复信号不写第二遍，已有条目一个字不动", () => {
    const file = path.join(tmp(), "pack.json");
    const original = {
      id: "x", invariants: [{ id: "human-1", desc: "人的判断", signal: { css_exists: ["#human"] } }],
    };
    fs.writeFileSync(file, JSON.stringify(original, null, 2));
    const p: Proposal = { id: "induced-a", desc: "归纳", signal: { css_exists: ["#induced"] }, why: "", kind: "appeared" };
    const first = appendInvariants(file, [p]);
    expect(first).toEqual({ added: 1, total: 2 });
    const second = appendInvariants(file, [p]);                 // 再来一次：不重复写
    expect(second).toEqual({ added: 0, total: 2 });
    const after = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(after.invariants[0]).toEqual(original.invariants[0]);  // 人的那条原封不动
    expect(after.invariants[1].id).toBe("induced-a");
  });
});
