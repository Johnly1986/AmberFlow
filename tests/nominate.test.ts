/**
 * NL Flow S2：指令提名梯级（docs/NL_FLOW_DESIGN.md §4）。
 *
 * 四组钉子：
 *   ① ①档规则：确定性关键词，数据规则优先；没命中 = 弃权（null），不是猜。
 *   ② 梯级顺序与证据面：①→②→③→④→⑤ 命中即停；via 如实记档；答案**不在闭集内 = 弃权**
 *      （fail closed，绝不现造指令）；③④ 抛错 = 该档弃权，绝不打死整条计划。
 *   ③ ⑤枚举序：调用方声明优先、未知名剔除、去重；空了回落缺省序（缺省序即 S0 测过的那张）。
 *   ④ 单一出处：S0 实验台的规则词表就是 `src/nominate.ts` 这一份（结构守卫——
 *      工具文件里不许再出现关键词副本，改动 = 换考卷，必须重跑 S0）。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENUM_ORDER, INSTRUCTION_NAMES, instructionCriteria, isInstructionName,
} from "../src/instructions.ts";
import { nominateInstruction, ruleNominate } from "../src/nominate.ts";

describe("①档规则：确定性关键词梯级，数据规则优先", () => {
  it("五类动词各归各档；数据规则词先于 select 的『选择』", () => {
    expect(ruleNominate("点击进入机票频道")).toBe("click");
    expect(ruleNominate("输入出发城市")).toBe("fill");
    expect(ruleNominate("在输入框填写折扣码")).toBe("fill");
    expect(ruleNominate("选择出发日期的下拉选项")).toBe("select");
    expect(ruleNominate("勾选同意条款")).toBe("check");
    expect(ruleNominate("选择最低价的一个航班")).toBe("list_pick");
    expect(ruleNominate("记录最低价酒店")).toBe("list_pick"); // 撞数据规则词——真实意图可能不是它，S0 的已知边界
    expect(ruleNominate("open the flights page")).toBe("click");
    expect(ruleNominate("type the coupon code")).toBe("fill");
  });

  it("没命中 = 弃权（null）——梯级往下走，不是拿 click 顶上", () => {
    expect(ruleNominate("处理这一单")).toBeNull();
    expect(ruleNominate("")).toBeNull();
  });
});

describe("梯级：命中即停、闭集 fail-closed、坏 ask 不打死计划", () => {
  const desc = "处理这一单"; // ① 必弃权的 desc

  it("②档案命中 ⇒ via learned（证据序：站点级已验证映射优先于全局启发式）", async () => {
    // desc 同时撞得中规则（"输入…"）与档案映射——②在前：信被重放验证过的那个
    const r = await nominateInstruction({
      desc: "输入出发城市",
      stepKey: "k",
      memory: { lookupInstruction: () => "select" },
    });
    expect(r).toMatchObject({ instruction: "select", via: "learned" });
  });

  it("①规则命中 ⇒ 停，③④ 不被咨询（②空手时）", async () => {
    let consulted = 0;
    const r = await nominateInstruction({
      desc: "输入出发城市",
      stepKey: "k",
      memory: { lookupInstruction: () => null },
      ask: async () => { consulted += 10; return "fill"; },
    });
    expect(r).toMatchObject({ instruction: "fill", via: "rule" });
    expect(consulted).toBe(0);
  });

  it("②档案命中 ⇒ via learned；学到的名字不在闭集内 = 弃权（fail closed）", async () => {
    const good = await nominateInstruction({
      desc, stepKey: "app/site/step-1",
      memory: { lookupInstruction: () => "select" },
    });
    expect(good).toMatchObject({ instruction: "select", via: "learned" });
    const ghost = await nominateInstruction({
      desc, stepKey: "app/site/step-1",
      memory: { lookupInstruction: () => "delete_all" },
      order: ["fill"],
    });
    expect(ghost.instruction).toBe("fill");          // ② 弃权 → ⑤ 枚举首位
    expect(ghost.via).toBe("enumerate");
  });


  it("③窄问命中 ⇒ via model；③抛错 ⇒ 掉到④/⑤，不是抛异常", async () => {
    const asked = await nominateInstruction({ desc, ask: async () => "check" });
    expect(asked).toMatchObject({ instruction: "check", via: "model" });
    const thrown = await nominateInstruction({
      desc, ask: async () => { throw new Error("provider down"); }, order: ["select"],
    });
    expect(thrown).toMatchObject({ instruction: "select", via: "enumerate" });
  });

  it("④老师命中 ⇒ via teacher；③空手（null）也继续往④走", async () => {
    let modelAsked = 0;
    const r = await nominateInstruction({
      desc,
      ask: async () => { modelAsked += 1; return null; },
      teacher: async () => "fill",
    });
    expect(r).toMatchObject({ instruction: "fill", via: "teacher" });
    expect(modelAsked).toBe(1);
  });

  it("全梯级空手 ⇒ ⑤枚举首位 + 完整序（裁决换条用）；rules-only 姿势（无 ask/teacher）同款", async () => {
    const bare = await nominateInstruction({ desc });
    expect(bare).toMatchObject({ instruction: "click", via: "enumerate" });
    expect(bare.order).toEqual(DEFAULT_ENUM_ORDER);
    const custom = await nominateInstruction({ desc, order: ["select", "fill", "nonsense", "select"] });
    expect(custom.instruction).toBe("select");
    expect(custom.order).toEqual(["select", "fill"]); // 未知名剔除 + 去重
  });
});

describe("③档的考卷：指令闭集与 criteria（S0 实验台同一份）", () => {
  it("闭集就是五个名字；criteria 名集与闭集一致；isInstructionName 收紧", () => {
    expect(INSTRUCTION_NAMES).toEqual(["click", "fill", "select", "check", "list_pick"]);
    expect(Object.keys(instructionCriteria()).sort()).toEqual([...INSTRUCTION_NAMES].sort());
    expect(isInstructionName("fill")).toBe(true);
    expect(isInstructionName("fill_all")).toBe(false);
    expect(isInstructionName(42)).toBe(false);
  });

  it("缺省枚举序首位是 click（S0：基线臂就是它，任何新问法要先赢的线）", () => {
    expect(DEFAULT_ENUM_ORDER[0]).toBe("click");
  });
});

describe("④单一出处：关键词梯级只许活在 src/nominate.ts 一处（仓库级结构守卫）", () => {
  it("tools/instruction_nomination.ts 从 src/nominate.ts 取规则——词表改动必须重跑 S0", () => {
    const tool = fs.readFileSync(
      path.resolve(import.meta.dirname, "..", "tools", "instruction_nomination.ts"), "utf-8",
    );
    expect(/最低价\|最低|最便宜\|/.test(tool), "关键词梯级的正则副本不许再出现（注释举例不算）").toBe(false);
    expect(/function ruleNominate|const ruleNominate/.test(tool),
      "规则函数只许活在 src/nominate.ts 一处").toBe(false);
    expect(tool).toContain("from \"../src/nominate.ts\"");
  });

  it("src/ tools/ integrations/ 全域都不得再出现第二份梯级正则（只扫 .ts，排除定义处）", () => {
    const roots = ["src", "tools", "integrations"].map((d) => path.resolve(import.meta.dirname, "..", d));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith(".ts")) continue;
        if (path.resolve(p) === path.resolve(import.meta.dirname, "..", "src", "nominate.ts")) continue;
        const src = fs.readFileSync(p, "utf-8");
        // 梯级正则的特征片段（带 `|` 的交替），不是散文里提到的"最低价"
        if (/最低价\|最低|最便宜\|最贵/.test(src)) offenders.push(path.relative(path.resolve(import.meta.dirname, ".."), p));
      }
    };
    for (const r of roots) if (fs.existsSync(r)) walk(r);
    expect(offenders, "第二份词表 = 换考卷不重跑 S0（复算门跟不上）").toEqual([]);
  });
});
