/**
 * NL Flow S2：指令学习存储（docs/NL_FLOW_DESIGN.md §7 + src/semantic-instructions.ts）。
 *
 * 五组钉子：
 *   ① 回填门（红线 2 同款）：staged 只进内存；commitVerified 放行验证过的（replays_ok+1），
 *      其余按原值撤回；改写指令 ⇒ replays_ok 归零（换映射 = 重新挣信任）。
 *   ② drift：连续失败计数 → 达阈值 isDrifted → dropInstruction 撤下（deopt，不是硬跑）；
 *      重放成功清零。
 *   ③ 证据面：落盘人可读；闭集外的指令名（手改档案）响亮报错；旧档案无 instructions 段
 *      照常加载（向后兼容）。
 *   ④ 段保持：hint 记忆落盘不丢指令段、指令记忆落盘不丢 hint 段（半份档案比没有更糟）。
 *   ⑤ 集成：作为 `NominationMemory` 喂给 `nominateInstruction` 的 ② 档——学到的映射真的
 *      会被提名梯级命中（via "learned"）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LearnedStore } from "../src/semantic.ts";
import { createInstructionMemory } from "../src/semantic-instructions.ts";
import { SiteProfileMemory } from "../src/semantic.ts";
import { nominateInstruction } from "../src/nominate.ts";

const tmpDir = (): { dir: string; store: LearnedStore } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amber-instr-mem-"));
  return { dir, store: new LearnedStore(dir) };
};

describe("指令学习存储：回填门与重放计数（红线 2 同款）", () => {
  it("staged：record 只进内存；verified ⇒ 落盘且 replays_ok=1；二跑同值累加", () => {
    const { store } = tmpDir();
    const mem = createInstructionMemory(store, "site-a", { staged: true });
    mem.recordInstruction("pick-cheapest", "list_pick", "model");
    expect(mem.stagedSteps()).toEqual(["pick-cheapest"]);
    expect(mem.lookupInstruction("pick-cheapest")).toBe("list_pick");   // 内存可见
    expect(store.load("site-a").instructions).toBeUndefined();          // 盘上没有（门未过）
    const { committed, dropped } = mem.commitVerified(new Set(["pick-cheapest"]));
    expect(committed).toEqual(["pick-cheapest"]);
    expect(dropped).toEqual([]);
    expect(store.load("site-a").instructions!["pick-cheapest"]).toMatchObject({
      instruction: "list_pick", replays_ok: 1, method: "model",
    });
    // 二跑：同值再学再验 → 计数累加，不归零
    const mem2 = createInstructionMemory(store, "site-a", { staged: true });
    mem2.recordInstruction("pick-cheapest", "list_pick", "model");
    mem2.commitVerified(new Set(["pick-cheapest"]));
    expect(store.load("site-a").instructions!["pick-cheapest"].replays_ok).toBe(2);
  });

  it("staged：重放不过 ⇒ 按原值撤回（新条目删除、旧条目还原），盘上一个字节不脏", () => {
    const { store } = tmpDir();
    const first = createInstructionMemory(store, "site-a", { staged: true });
    first.recordInstruction("s1", "click", "model");
    first.commitVerified(new Set(["s1"]));                    // 第一次过门
    const second = createInstructionMemory(store, "site-a", { staged: true });
    second.recordInstruction("s1", "fill", "teacher");        // 改写（pending）
    second.recordInstruction("s2", "select", "enumerate");    // 新条目（pending）
    second.commitVerified(new Set());                          // 全部不过
    const file = store.load("site-a").instructions!;
    expect(file["s1"]).toMatchObject({ instruction: "click", replays_ok: 1 }); // 还原旧值
    expect(file["s2"]).toBeUndefined();                                        // 新条目删除
  });

  it("改写指令 ⇒ replays_ok 归零（换映射 = 重新挣信任）；同值保持（staged 流）", () => {
    const { store } = tmpDir();
    const mem = createInstructionMemory(store, "site-a", { staged: true });
    mem.recordInstruction("s1", "click", "model");
    mem.commitVerified(new Set(["s1"]));                      // replays_ok = 1
    mem.recordInstruction("s1", "click", "model");            // 同值再学：保持计数
    expect(mem.getInstructions()["s1"].replays_ok).toBe(1);
    mem.recordInstruction("s1", "fill", "teacher");           // 改写：归零
    expect(mem.getInstructions()["s1"].replays_ok).toBe(0);
  });

  it("countReplay（未 staged 的日常路径）：replays_ok+1 且失败清零", () => {
    const { store } = tmpDir();
    const mem = createInstructionMemory(store, "site-a");
    mem.recordInstruction("s1", "click", "teacher");
    mem.countFailure("s1");
    mem.countReplay("s1");
    expect(mem.getInstructions()["s1"].replays_ok).toBe(1);
    expect(mem.getInstructions()["s1"].failures).toBeUndefined();
    expect(mem.stats()).toMatchObject({ entries: 1, used: 1 });
  });
});

describe("drift：连续失败 → 达阈值撤下；重放成功清零", () => {
  it("failures 累计、isDrifted 在阈值（缺省 2）翻转、dropInstruction 撤下且盘上消失", () => {
    const { store } = tmpDir();
    const mem = createInstructionMemory(store, "site-a");
    mem.recordInstruction("s1", "select", "model");
    mem.commitVerified(new Set(["s1"]));
    expect(mem.countFailure("s1")).toBe(1);
    expect(mem.isDrifted("s1")).toBe(false);
    mem.countFailure("s1");
    expect(mem.isDrifted("s1")).toBe(true);
    expect(mem.dropInstruction("s1")).toBe("select");
    expect(mem.lookupInstruction("s1")).toBeNull();
    expect(store.load("site-a").instructions!["s1"]).toBeUndefined();
  });

  it("重放成功 ⇒ 失败清零（自愈，不带着旧账误判 drift）", () => {
    const { store } = tmpDir();
    const mem = createInstructionMemory(store, "site-a");
    mem.recordInstruction("s1", "click", "rule");
    mem.countFailure("s1");
    mem.resetFailures("s1");
    expect(mem.isDrifted("s1")).toBe(false);
  });
});

describe("证据面：闭集校验、向后兼容、段保持", () => {
  it("手改档案写出闭集外的指令 ⇒ load 响亮报错（不是运行期静默弃权）", () => {
    const { dir, store } = tmpDir();
    // 绕过 store.save（它有同款校验）直写文件——测的是 load 侧的守卫
    fs.writeFileSync(store.pathFor("site-x"), JSON.stringify({
      host: "site-x", steps: {},
      instructions: { s1: { instruction: "delete_all", replays_ok: 1 } },
    }), "utf-8");
    expect(() => store.load("site-x")).toThrow(/instruction must be one of click\|fill\|select\|check\|list_pick/);
    expect(dir).toBeTruthy();
  });

  it("旧档案没有 instructions 段 ⇒ 两种记忆都照常加载（向后兼容）", () => {
    const { store } = tmpDir();
    store.save("legacy", { host: "legacy", steps: { s1: { hint: "[data-test=x]", replays_ok: 3 } } });
    const hints = new SiteProfileMemory(store, "legacy");
    expect(hints.lookup(hints.key("http://x", "anything"))).toBeNull(); // 键未注册而已，加载不炸即可
    const instr = createInstructionMemory(store, "legacy");
    expect(instr.lookupInstruction("s1")).toBeNull();
    expect(instr.stats().entries).toBe(0);
  });

  it("段保持（双向）：指令落盘不丢 hint 段，hint 落盘不丢指令段", () => {
    const { store } = tmpDir();
    // 先学一条指令（落盘）
    const instr = createInstructionMemory(store, "site-a");
    instr.recordInstruction("s1", "list_pick", "rule");
    // 再用 hint 记忆回填一步并落盘（SiteProfileMemory 构造带上了 instructions 段）
    const hints = new SiteProfileMemory(store, "site-a");
    hints.registerSteps([["输入出发城市", "s2"]]);
    hints.record(hints.key("http://x", "输入出发城市"), "[data-test=dep]");
    // 指令记忆再落盘（带 steps 段）
    instr.recordInstruction("s3", "fill", "model");
    const file = store.load("site-a");
    expect(file.instructions!["s1"]).toMatchObject({ instruction: "list_pick" });
    expect(file.instructions!["s3"]).toMatchObject({ instruction: "fill" });
    expect(file.steps["s2"]).toMatchObject({ hint: "[data-test=dep]" });
  });
});

describe("与提名梯级的集成：②档案档真的被命中", () => {
  it("学到的映射 ⇒ nominateInstruction 走 via learned（①规则弃权的 desc 上）", async () => {
    const { store } = tmpDir();
    const mem = createInstructionMemory(store, "site-a");
    mem.recordInstruction("app/site/step-9", "fill", "teacher");
    const r = await nominateInstruction({
      desc: "处理这一单",                       // ① 必弃权
      stepKey: "app/site/step-9",
      memory: mem,
    });
    expect(r).toMatchObject({ instruction: "fill", via: "learned" });
  });

  it("readOnly：一切改动只留内存，盘上一个字节不写", () => {
    const { store } = tmpDir();
    const mem = createInstructionMemory(store, "site-a", { readOnly: true });
    mem.recordInstruction("s1", "click", "model");
    expect(mem.lookupInstruction("s1")).toBe("click");
    expect(fs.existsSync(store.pathFor("site-a"))).toBe(false);
  });
});
