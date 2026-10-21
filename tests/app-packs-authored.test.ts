/**
 * 本轮出题的两个应用包（`apps/INVENTORY.md` 的 A1 / A2）的回归测试。
 *
 * 每个应用两条（题面要求）+ 一条把"逐字段对齐"钉死的强断言：
 *   1. **离线端到端**：`runApp` 走完整条旅程（脚本模型，不碰 1.7GB ONNX）；
 *   2. **加载期坏包**：克隆一份包做坏，断言 `validatePack` 返回的**精确**报错文本
 *      （不是 `toContain` 一个片段——校验器的价值就在于"响亮且具体"）；
 *   3. 展开后的 `journey` 必须与素材里的冻结计划**逐字段一致**：
 *      ctrip-case 对 `src/sites/ctrip-task.ts` 的 `flightSubgoals`/`hotelSubgoals`，
 *      ip-config 对 `src/cli/ip-config.ts` 的 `buildPlan`。
 *
 * 两条口径值得单独说：
 *   - 脚本模型对 `choice` 问题**给不出答案**（它只会回 `{noul}`）。所以"19/19 与 8/8 全
 *     done"本身就证明：每一步都由 `target_hint` 规则命中，没有一步落到模型选择上。
 *     测试里还把这一点显式化——`asked` 里不允许出现 `act`（执行器只有 pick 才问 `act`）。
 *   - ctrip-case 的日期是写死的（2026-10-05..09），因为站点数据是一份提交进仓库的冻结
 *     生成物；因此这里的对齐断言用的是**显式日期**，不跟随墙上时钟（与 `LAYA_TODAY`
 *     那条教训同型：冻结语料不该随日期漂移）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expandPack, loadPack, validatePack } from "../src/app/app-pack.ts";
import { runApp, startUrl } from "../src/app/app-runner.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime } from "../src/model/model.ts";
import { buildPlan, DEMO_ROWS } from "../src/cli/ip-config.ts";
import { DEMO_ROWS as CAM_ROWS, FORMS, TYPE_TO_FORM } from "../src/cli/camera-entry.ts";
import { discoverSpecs, emitPlan } from "../src/sites/transfer-task.ts";
import * as CT from "../src/sites/ctrip-task.ts";
import { matrix } from "../tools/apps_matrix.ts";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const planPath = (tag: string): string =>
  path.join(os.tmpdir(), `app-packs-authored-${tag}-${process.pid}.json`);

/** 与冻结计划一致的显式日期（站点数据的冻结生成物；不跟随墙上时钟）。 */
const CT_DATES = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"];
const CT_CHECKIN = "2026-10-08";

/** 会被问到的 question key（`act` = 选择元素；`r` = 风险；`d` = done 建议）。 */
let asked: string[] = [];
/** 脚本模型：noul 一律低风险/未完成，且对 choice 给不出答案。 */
const installScripted = (): void => {
  installLayaRuntime(scriptedRuntime(scriptedAgent((key) => {
    asked.push(key);
    return { noul: 0.05 };
  })));
};

beforeAll(() => {
  // 与 apps.test.ts 同一约定：离线测试只注入脚本模型
  installScripted();
});
afterAll(() => installLayaRuntime(null));

/* ================================================================ A1 */

describe("apps/ctrip-case（A1：携程复刻站 19 个冻结子目标）", () => {
  it("journey 与 src/sites/ctrip-task.ts 的冻结计划逐字段对齐", () => {
    const frozen = [...CT.flightSubgoals(CT_DATES), ...CT.hotelSubgoals(CT_CHECKIN)];
    const exp = expandPack(loadPack("ctrip-case"), {}, planPath("ctrip-align"));
    expect(exp.plan.subgoals).toHaveLength(19);
    expect(frozen).toHaveLength(19);
    expect(exp.rolesUsed).toEqual(["filter-window", "sort-flights", "record-lowest"]);
    frozen.forEach((f, i) => {
      const g = exp.plan.subgoals[i]! as Record<string, unknown>;
      expect(g.desc, `desc[${i}]`).toBe(f.desc);
      // 包里是相对仓库路径；按 bench/runner 的同一口径解析后必须与冻结计划的绝对 URL 相同
      expect(startUrl(String(g.start_url)), `start_url[${i}]`).toBe(f.start_url);
      expect(g.target_hint, `target_hint[${i}]`).toBe(f.target_hint);
      expect(g.signal, `signal[${i}]`).toEqual(f.signal);
      expect(g.when ?? null, `when[${i}]`).toBe(f.when ?? null);
      expect(g.retries ?? null, `retries[${i}]`).toBe(f.retries ?? null);
      expect(g.slots ?? null, `slots[${i}]`).toBe(f.slots ?? null);
    });
  });

  it("start_url 全是相对仓库路径（不是绝对 file://），hosts/sources 为空", () => {
    const pack = loadPack("ctrip-case");
    expect(pack.hosts).toEqual([]);
    expect(pack.sources).toEqual([]);
    // 角色引用型的 journey 条目自己没有 start_url（继承模板），所以查**展开后**的计划
    const exp = expandPack(pack, {}, planPath("ctrip-rel"));
    expect(exp.plan.subgoals).toHaveLength(19);
    for (const sg of exp.plan.subgoals) {
      const u = String(sg.start_url ?? "");
      expect(u, JSON.stringify(u)).not.toMatch(/^[a-z]+:\/\//);
      expect(u.startsWith("ctrip/site/"), JSON.stringify(u)).toBe(true);
    }
    // 角色模板里的 start_url 同样必须是相对路径
    for (const [name, tpl] of Object.entries(pack.roles ?? {})) {
      const u = String((tpl as Record<string, unknown>)["start_url"] ?? "");
      expect(u.startsWith("ctrip/site/"), `${name}: ${JSON.stringify(u)}`).toBe(true);
    }
  });

  it("端到端：19/19 done + 3 条结束状态不变量成立，且没有一步落到模型选择", async () => {
    asked = [];
    installScripted();
    const res = await runApp(loadPack("ctrip-case"), {
      verbose: false, sources: false, planPath: planPath("ctrip-e2e"),
    });
    expect(res.ok, JSON.stringify({ subgoals: res.subgoals, invariants: res.invariants })).toBe(true);
    expect(res.completed).toBe("19/19");
    expect(res.subgoals).toHaveLength(19);
    expect(res.subgoals.every((s) => s.status === "done")).toBe(true);
    expect(res.subgoals.every((s) => s.attempts === 1)).toBe(true);
    expect(res.invariants.map((i) => [i.id, i.held])).toEqual([
      ["end-on-recorded-capped-hotel-list", true],
      ["end-state-is-the-hotel-page", true],
      ["hotel-results-not-empty", true],
    ]);
    // 执行器只有"选择元素"才问 `act`：它没被问过 = 19 步全部由 target_hint 规则命中
    expect(asked).not.toContain("act");
  }, 180_000);

  it("坏包在加载期炸：未知角色 / 超预算，报错文本精确匹配", () => {
    const ghost = clone(loadPack("ctrip-case")) as any;
    ghost["journey"][0] = { role: "ghost" };
    expect(validatePack(ghost)).toEqual(['journey[0]: unknown role "ghost"']);

    const tight = clone(loadPack("ctrip-case")) as any;
    tight["max_subgoals"] = 18;                       // 19 步 > 预算 18
    expect(validatePack(tight)).toEqual(["plan: 19 subgoals exceed max 18"]);

    const stray = clone(loadPack("ctrip-case")) as any;
    stray["journey"][5]["magic"] = 1;
    expect(validatePack(stray)).toEqual(["journey[5].magic: unknown step key"]);
  });
});

/* ================================================================ A2 */

describe("apps/ip-config（A2：Excel IP 规划表 → 设备网络页）", () => {
  it("前三台设备的步骤与 buildPlan 对齐（保存步信号是刻意的加固）；第四台是显式的拒绝步", () => {
    const exp = expandPack(loadPack("ip-config"), {}, planPath("ip-align"));
    expect(exp.plan.subgoals).toHaveLength(8);
    expect(exp.rolesUsed).toEqual([]);

    (DEMO_ROWS.slice(0, 3) as typeof DEMO_ROWS).forEach((row, k) => {
      const frozen = buildPlan(String(row.序列号), row);
      const open = exp.plan.subgoals[k * 2]! as Record<string, unknown>;
      const save = exp.plan.subgoals[k * 2 + 1]! as Record<string, unknown>;
      expect(open.desc, `open.desc[${k}]`).toBe(frozen.subgoals[0]!.desc);
      expect(startUrl(String(open.start_url)), `open.url[${k}]`).toBe(frozen.subgoals[0]!.start_url);
      expect(open.target_hint, `open.hint[${k}]`).toBe(frozen.subgoals[0]!.target_hint);
      expect(open.signal, `open.signal[${k}]`).toEqual(frozen.subgoals[0]!.signal);
      expect(save.desc, `save.desc[${k}]`).toBe(frozen.subgoals[1]!.desc);
      expect(startUrl(String(save.start_url)), `save.url[${k}]`).toBe(frozen.subgoals[1]!.start_url);
      expect(save.target_hint, `save.hint[${k}]`).toBe(frozen.subgoals[1]!.target_hint);
      // 保存步的完成信号是驱动的叶子 **加固**：驱动的「已保存」叶子之上再钉该行自己的 IP
      // （页面回显「已保存 <ip> / <mask> / <gw> 到 <sn>」），所以它不再逐字相等，而是
      // 一个 all_of，第一个叶子必须与驱动的信号逐字段相同。
      const leaves = (save.signal as Record<string, unknown>)["all_of"] as unknown[];
      expect(Array.isArray(leaves), `save.signal[${k}]`).toBe(true);
      expect(leaves, `save.signal[${k}]`).toContainEqual(frozen.subgoals[1]!.signal);
      expect(leaves, `save.signal[${k}]`).toContainEqual({
        css_text_contains: ["[data-test=save-ok]", String(row.ip)],
      });
      // 驱动里 slots 是**计划级**（一台设备一份计划）；应用包是一条旅程覆盖 4 行，
      // 同一组值落在各自那一步上——值必须逐字段相同。
      expect(save.slots, `save.slots[${k}]`).toEqual(frozen.slots);
    });

    const bad = DEMO_ROWS[3]!;
    const frozenBad = buildPlan(String(bad.序列号), bad);
    const openBad = exp.plan.subgoals[6]! as Record<string, unknown>;
    const saveBad = exp.plan.subgoals[7]! as Record<string, unknown>;
    expect(openBad.desc).toBe(frozenBad.subgoals[0]!.desc);
    expect(startUrl(String(openBad.start_url))).toBe(frozenBad.subgoals[0]!.start_url);
    expect(openBad.signal).toEqual(frozenBad.subgoals[0]!.signal);
    expect(saveBad.slots).toEqual(frozenBad.slots);          // 同一个被规划表写错的值
    // 完成信号**不是**驱动的"已保存"，而是设备页自己的拒绝文案（设计好的失败被显式表达）
    expect(saveBad.signal).not.toEqual(frozenBad.subgoals[1]!.signal);
    expect(JSON.stringify(saveBad.signal)).toContain("IP 地址格式错误");
  });

  it("端到端：8/8 done（含被拒绝的那一步）+ 3 条不变量成立", async () => {
    asked = [];
    installScripted();
    const res = await runApp(loadPack("ip-config"), {
      verbose: false, planPath: planPath("ip-e2e"),
    });
    expect(res.ok, JSON.stringify({ subgoals: res.subgoals, invariants: res.invariants })).toBe(true);
    expect(res.completed).toBe("8/8");
    expect(res.subgoals.every((s) => s.status === "done")).toBe(true);
    // 第 7 步就是那个**设计好要被设备页拒绝**的行：它以"页面给出拒绝文案"为完成信号，
    // 所以它也是 done —— 不是被静默丢掉，也不是被当成失败。
    expect(res.subgoals[7]!.status).toBe("done");
    expect(res.invariants.map((i) => [i.id, i.held])).toEqual([
      ["end-on-the-rejected-device-page", true],
      ["the-rejected-value-is-the-planned-one", true],
      ["rejection-is-not-reported-as-success", true],
    ]);
    expect(asked).not.toContain("act");
  }, 180_000);

  it("设计好的拒绝没有被静默丢掉：那一行的规划值就是 10.0.1.999", () => {
    const pack = loadPack("ip-config");
    const rejected = pack.journey.filter((s) => JSON.stringify(s).includes("10.0.1.999"));
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!["slots"] as Record<string, unknown>)["ip"]).toBe("10.0.1.999");
    expect(JSON.stringify(rejected[0]!["signal"])).toContain("IP 地址格式错误");
    expect(JSON.stringify(pack.invariants)).toContain("rejection-is-not-reported-as-success");
  });

  it("验收有牙齿：把「被拒绝」谎报成「已保存」的不变量不成立 -> ok=false（一票否决）", async () => {
    const pack = clone(loadPack("ip-config")) as any;
    pack["invariants"] = [{
      id: "claims-success",
      desc: "谎报：结束状态里 save-ok 含「已保存」",
      signal: { css_text_contains: ["[data-test=save-ok]", "已保存"] },
    }];
    const res = await runApp(pack, { verbose: false, planPath: planPath("ip-veto") });
    expect(res.subgoals.every((s) => s.status === "done")).toBe(true);  // 旅程本身仍然跑完
    expect(res.invariants.map((i) => [i.id, i.held])).toEqual([["claims-success", false]]);
    expect(res.ok).toBe(false);                                        // 但验收不通过
  }, 180_000);

  it("坏包在加载期炸：缺信号 / 未知占位符 / 缺 id+signal，报错文本精确匹配", () => {
    const noSignal = clone(loadPack("ip-config")) as any;
    delete noSignal["journey"][1]["signal"];
    expect(validatePack(noSignal)).toEqual(["journey[1]: needs a done-signal"]);

    const badSlot = clone(loadPack("ip-config")) as any;
    badSlot["journey"][1]["desc"] = "保存到 {nope}";
    expect(validatePack(badSlot)).toEqual(["unknown slot placeholder {nope}"]);

    const badInv = clone(loadPack("ip-config")) as any;
    badInv["invariants"] = [{ id: "x" }];
    expect(validatePack(badInv)).toEqual(["invariants[0] needs {id, signal}"]);
  });
});

/* ================================================================ 应用目录是数据 */

describe("两个新应用包：应用目录是数据（0 行代码 / 0 泄漏 / 0 债）", () => {
  it("apps:matrix 里两个包都 0 代码行、没有声明任何外部标识", () => {
    const { rows, leaks, debt } = matrix();
    const ct = rows.find((r) => r.app === "ctrip-case")!;
    const ip = rows.find((r) => r.app === "ip-config")!;
    expect(ct).toMatchObject({ kind: "pack", roles: 3, steps: 19, toolSteps: 0, invariants: 3, code: 0 });
    expect(ip).toMatchObject({ kind: "pack", roles: 0, steps: 8, toolSteps: 0, invariants: 3, code: 0 });
    expect(ct.tokens).toEqual([]);                    // hosts 为空
    expect(ip.tokens).toEqual([]);
    expect(leaks, JSON.stringify(leaks)).toEqual([]);
    expect(debt, JSON.stringify(debt)).toEqual([]);
  });
});

/* ================================================================ A3 / A4 / A5 */

/** `[data-test='a-serial']` -> `a-serial`：包里的槽位键就是表单字段的 data-test 名。 */
const fieldKey = (sel: string): string => sel.replace(/^\[data-test='|'\]$/g, "");
const isBlankRow = (v: unknown): boolean =>
  v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v));

describe("apps/camera-entry（A3：Excel 类型列路由两套表单）", () => {
  it("journey 与 src/cli/camera-entry.ts 的类型规则 + fillForm 的字段映射逐字段对齐", () => {
    const exp = expandPack(loadPack("camera-entry"), {}, planPath("camera-align"));
    expect(exp.plan.subgoals).toHaveLength(CAM_ROWS.length);   // 4 行 = 4 步
    expect(exp.rolesUsed).toEqual([]);

    // 期望的槽位 = 该行的 form 字段（跳过空值），键名是 data-test 名，值是行里的值
    const expectedSlots = (form: "form_a" | "form_b", row: Record<string, unknown>): Record<string, string> =>
      Object.fromEntries(Object.entries(FORMS[form].fields)
        .filter(([col]) => !isBlankRow(row[col]))
        .map(([col, sel]) => [fieldKey(sel), String(row[col])]));

    // 行 0/1/3 的页面由 TYPE_TO_FORM 决定（规则路由，不是模型）
    const cases: Array<[number, string]> = [[0, "form_a"], [1, "form_b"], [3, "form_a"]];
    for (const [i, form] of cases) {
      const row = CAM_ROWS[i]! as Record<string, unknown>;
      expect(TYPE_TO_FORM[String(row["device_type"])], `row ${i} 类型规则`).toBe(form);
      expect(exp.plan.subgoals[i]!.slots, `row ${i} slots`).toEqual(expectedSlots(form as "form_a", row));
    }
    // 行 2 的 类型 为空：驱动会落到 laya.Router，pack 里必须用**行内证据**显式选页（PTZ 序列号 + 变倍/预置位）
    const blank = CAM_ROWS[2]! as Record<string, unknown>;
    expect(blank["device_type"]).toBeNull();
    expect(String(blank["serial"]).startsWith("PTZ")).toBe(true);
    expect(exp.plan.subgoals[2]!.slots).toEqual(expectedSlots("form_b", blank));
    // 行 4（CAM-12）是设计好被表单拒绝的：它必须**显式成步**，完成信号是表单自己的拒绝文案
    expect(exp.plan.subgoals[3]!.slots).toMatchObject({ "a-serial": "CAM-12" });
    const sig = JSON.stringify(exp.plan.subgoals[3]!.signal);
    expect(sig).toContain(fieldKey(FORMS.form_a.error));
    expect(sig).toContain("CAM-12");
  });

  it("端到端 4/4 + 3 条不变量；没有任何一步落到模型选择", async () => {
    asked = [];
    const res = await runApp(loadPack("camera-entry"), {
      verbose: false, sources: false, planPath: planPath("camera-e2e"),
    });
    expect(res.ok, JSON.stringify(res.subgoals)).toBe(true);
    expect(res.completed).toBe("4/4");
    expect(res.invariants.map((i) => [i.id, i.held])).toEqual([
      ["end-on-the-rejected-form", true],
      ["rejection-not-reported-as-success", true],
      ["end-state-is-the-fixed-form", true],
    ]);
    expect(asked).not.toContain("act");          // 脚本模型给不出 choice；全 done 即全规则命中
  }, 120_000);

  it("坏包在加载期炸：浏览器步缺信号 / 缺 start_url 都要被点名", () => {
    const noSignal = clone(loadPack("camera-entry")) as any;
    delete noSignal["journey"][3]["signal"];
    expect(validatePack(noSignal)).toEqual(["journey[3]: needs a done-signal"]);

    const noStart = clone(loadPack("camera-entry")) as any;
    delete noStart["journey"][1]["start_url"];
    expect(validatePack(noStart)).toEqual(["journey[1]: a browser step needs start_url (each subgoal re-navigates)"]);
  });
});

describe("transfer 复刻站两题（A4 向导 / A5 冷启动重试）", () => {
  const emitted = (key: string, dir: string): Array<Record<string, any>> => {
    const specs = discoverSpecs();
    // `emitPlan` 的日期来自 `nextWeekDates()`（读 LAYA_TODAY）；包里的日期是**冻结**的
    // （用 2026-10-02 那天生成的 2026-10-05..09），所以这里同步地把时钟钉在同一天 ——
    // 否则过了那个周末，对齐测试就会因为日期漂移而红（与 parity-clock 那条教训同型）。
    const old = process.env.LAYA_TODAY;
    process.env.LAYA_TODAY = "2026-10-02";
    try {
      const p = emitPlan(key, specs[key]!, dir);
      return (JSON.parse(fs.readFileSync(p, "utf-8")) as { subgoals: Array<Record<string, any>> }).subgoals;
    } finally {
      if (old === undefined) delete process.env.LAYA_TODAY; else process.env.LAYA_TODAY = old;
    }
  };

  // `modelFree`：这条旅程是否**全程规则命中**。voyagio 是；slowjet 不是——它的冷启动会让第一次
  // 尝试落空、laya 被问一次（脚本模型给不出 choice），最后是靠 `retries` 重跑才过的。
  // 这个区别必须显式写出来，否则"绿的"会被读成"不需要模型"。
  for (const [id, specKey, tag, modelFree] of [["transfer-voyagio", "voyagio", "voyagio", true],
    ["transfer-slowjet", "slowjet", "slowjet", false],
    ["transfer-trekly", "trekly", "trekly", true],
    ["transfer-farehaven", "farehaven", "farehaven", true],
    ["transfer-skybook", "skybook", "skybook", true],
    ["transfer-flyquest", "flyquest", "flyquest", true]] as const) {
    it(`${id}：journey 与 emitPlan(${specKey}) 的展开计划逐字段对齐`, () => {
      const frozen = emitted(specKey, path.join(os.tmpdir(), `app-packs-authored-${tag}`));
      const exp = expandPack(loadPack(id), {}, planPath(`${tag}-align`));
      expect(exp.plan.subgoals).toHaveLength(frozen.length);
      frozen.forEach((f, i) => {
        const g = exp.plan.subgoals[i]! as Record<string, any>;
        expect(g.desc, `desc[${i}]`).toBe(f.desc);
        expect(startUrl(String(g.start_url)), `start_url[${i}]`).toBe(String(f.start_url));
        expect(g.target_hint ?? null, `target_hint[${i}]`).toBe(f.target_hint ?? null);
        expect(g.signal, `signal[${i}]`).toEqual(f.signal);
        expect(g.when ?? null, `when[${i}]`).toEqual(f.when ?? null);
        expect(g.retries ?? 0, `retries[${i}]`).toBe(f.retries ?? 0);
        expect(g.slots ?? {}, `slots[${i}]`).toEqual(f.slots ?? {});
      });
    }, 120_000);

    it(`${id}：端到端全部 done/skipped + 不变量成立`, async () => {
      asked = [];
      const res = await runApp(loadPack(id), {
        verbose: false, sources: false, planPath: planPath(`${tag}-e2e`),
      });
      expect(res.ok, JSON.stringify(res.subgoals)).toBe(true);
      expect(res.subgoals.every((s) => s.status === "done" || s.status === "skipped")).toBe(true);
      expect(res.invariants.every((i) => i.held)).toBe(true);
      if (modelFree) {
        expect(asked).not.toContain("act");
      } else {
        // 如实记录：模型被问过（脚本模型没有 choice），而旅程仍然全 done —— 那是 `retries` 的功劳
        expect(asked).toContain("act");
        expect(res.subgoals.some((s) => Number(s.attempts ?? 1) > 1)).toBe(true);
      }
    }, 180_000);
  }

  it("slowjet 的 retries 是运行时策略：它如实进了 journey，且真的被用上（attempt>1）", async () => {
    const exp = expandPack(loadPack("transfer-slowjet"), {}, planPath("slowjet-retries"));
    const withRetries = exp.plan.subgoals.filter((s) => (s.retries ?? 0) > 0);
    expect(withRetries.length).toBeGreaterThan(0);
    const res = await runApp(loadPack("transfer-slowjet"), {
      verbose: false, sources: false, planPath: planPath("slowjet-retries-run"),
    });
    const retried = res.subgoals.filter((s) => Number(s.attempts ?? 1) > 1);
    expect(retried.length, JSON.stringify(res.subgoals)).toBeGreaterThan(0);
    expect(res.ok).toBe(true);
  }, 180_000);

  it("farehaven 的 when 是「可能不适用就跳过」：展开后 5 条 when，端到端确实出现 skipped", async () => {
    const frozen = emitted("farehaven", path.join(os.tmpdir(), "app-packs-authored-farehaven"));
    const exp = expandPack(loadPack("transfer-farehaven"), {}, planPath("farehaven-when"));
    expect(frozen.filter((f) => f.when).length).toBe(5);
    expect(exp.plan.subgoals.filter((s) => s.when).length).toBe(5);
    // 条件步没有被改写成普通步：那 5 条的 when 逐条与展开计划相同
    frozen.forEach((f, i) => {
      if (f.when) expect(exp.plan.subgoals[i]!.when, `when[${i}]`).toEqual(f.when);
    });
    // 而且它们确实没有 `retries`（when 不等于 retries —— 一个跳过，一个重跑）
    expect(exp.plan.subgoals.every((s) => (s.retries ?? 0) === 0)).toBe(true);

    const res = await runApp(loadPack("transfer-farehaven"), {
      verbose: false, sources: false, planPath: planPath("farehaven-when-run"),
    });
    const whenIdx = new Set(exp.plan.subgoals.map((s, i) => (s.when ? i : -1)).filter((i) => i >= 0));
    const skipped = res.subgoals.filter((s) => s.status === "skipped");
    expect(skipped.length, JSON.stringify(res.subgoals)).toBeGreaterThanOrEqual(1);
    // 每一条 skipped 都必须是那 5 个条件步之一（不是别的东西被悄悄跳过）
    res.subgoals.forEach((s, i) => {
      if (s.status === "skipped") expect(whenIdx.has(i), `skipped[${i}]`).toBe(true);
    });
    expect(res.ok).toBe(true);
    expect(res.subgoals.every((s) => s.status === "done" || s.status === "skipped")).toBe(true);
  }, 180_000);

  it("trekly 坏包在加载期炸：未知角色（精确报错文本）", () => {
    const ghost = clone(loadPack("transfer-trekly")) as any;
    ghost["journey"][0] = { role: "ghost" };
    expect(validatePack(ghost)).toEqual(['journey[0]: unknown role "ghost"']);
  });

  it("farehaven 坏包在加载期炸：子目标超预算（精确报错文本）", () => {
    const tight = clone(loadPack("transfer-farehaven")) as any;
    tight["max_subgoals"] = 23;                       // 24 步 > 预算 23
    expect(validatePack(tight)).toEqual(["plan: 24 subgoals exceed max 23"]);
  });

  it("flyquest 的搜索表单步用的是有序 target_hints（不是单个 hint）", () => {
    const exp = expandPack(loadPack("transfer-flyquest"), {}, planPath("flyquest-hints"));
    const formSteps = exp.plan.subgoals.filter((s) => Array.isArray(s.target_hints) && s.target_hints!.length === 3);
    // 5 个日期各一步：填日期 → 选时段 → 提交搜索（提交那一下才产生 URL 变化）
    expect(formSteps.length, JSON.stringify(exp.plan.subgoals.map((s) => s.target_hints))).toBe(5);
    for (const s of formSteps) {
      expect(s.target_hints).toEqual(["#date", "#window", "#search-btn"]);
      expect(s.target_hint ?? null, "有序列表的步骤不该再挂单 hint").toBeNull();
      expect(String(s.start_url), "表单步从 search.html 起步").toContain("transfer/site4/search.html");
      expect(s.slots).toEqual({ date: expect.any(String) });     // 日期值只来自计划
    }
    // 酒店上限那一步是第二处有序列表（先填 #cap 再点 #apply-cap）
    const capSteps = exp.plan.subgoals.filter((s) => Array.isArray(s.target_hints) && s.target_hints!.length === 2);
    expect(capSteps.map((s) => s.target_hints)).toEqual([["#cap", "#apply-cap"]]);
  });

  it("skybook 坏包在加载期炸：浏览器步缺 start_url（精确报错文本）", () => {
    const noUrl = clone(loadPack("transfer-skybook")) as any;
    delete noUrl["journey"][0]["start_url"];
    expect(validatePack(noUrl)).toEqual(["journey[0]: a browser step needs start_url (each subgoal re-navigates)"]);
  });

  it("flyquest 坏包在加载期炸：把搜索表单的有序列表清空（每个实例都被点名）", () => {
    const noHints = clone(loadPack("transfer-flyquest")) as any;
    noHints["roles"]["search-form"]["target_hints"] = [];
    expect(validatePack(noHints)).toEqual([
      "plan: subgoal[1]: target_hints must be a non-empty list of strings",
      "plan: subgoal[4]: target_hints must be a non-empty list of strings",
      "plan: subgoal[7]: target_hints must be a non-empty list of strings",
      "plan: subgoal[10]: target_hints must be a non-empty list of strings",
      "plan: subgoal[13]: target_hints must be a non-empty list of strings",
    ]);
  });

  it("transfer 包的应用目录是数据（0 代码行），且七个新应用都进了矩阵", () => {
    const { rows, leaks, debt } = matrix();
    for (const id of ["camera-entry", "transfer-voyagio", "transfer-slowjet",
      "transfer-trekly", "transfer-farehaven", "transfer-skybook", "transfer-flyquest"]) {
      const r = rows.find((x) => x.app === id)!;
      expect(r, id).toBeTruthy();
      expect(r.code, id).toBe(0);
      expect(r.tokens.length, id).toBe(0);                     // hosts 为空：本地复刻站
    }
    expect(leaks).toEqual([]);
    expect(debt).toEqual([]);
  });
});
