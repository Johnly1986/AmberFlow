/**
 * `spec → pack` 生成器的回归测试。
 *
 * 这里要钉住的是一条**构造性质**：包里的旅程 = `emitPlan(spec)` 的展开结果，
 * 而包里记着展开内容的 `plan_sha256`。任何一侧漂移（改包、改 spec）都必须变红——
 * 以前这件事靠"作者抄一遍 + 复核方逐字段验一遍"，现在靠这个。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPack, validatePack, type AppPack } from "../src/app-pack.ts";
import { discoverSpecs, emitPlan } from "../src/transfer-task.ts";
import {
  checkAgainstFlow, flowFor, generatePack, generatedApps, inexpressibleKeys, planSha, serializePack,
  specPathOf, structureFromSeed, type Flow,
} from "../tools/spec-to-pack.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const TMP: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "spec-to-pack-test-"));
  TMP.push(d);
  return d;
}
afterEach(() => { while (TMP.length) fs.rmSync(TMP.pop()!, { recursive: true, force: true }); });

/** 测试里按应用现算一次 flow（checkAgainstFlow 接收已解析的 flow）。 */
async function testFlow(a: { ref: Parameters<typeof flowFor>[0] }): Promise<Flow> {
  return flowFor(a.ref);
}

describe("spec → pack：7 个复刻站应用与 spec 展开一致（构造性质，不是人工对齐）", () => {
  it("每个声明了 generated_from 的应用都通过 check（加载 + 展开 + 逐字段 + 哈希）", async () => {
    const apps = generatedApps();
    expect(apps.length).toBeGreaterThanOrEqual(7);          // 6 个 transfer 复刻站 + ctrip-case
    for (const a of apps) {
      const flow = await flowFor(a.ref);
      expect({ id: a.id, problems: checkAgainstFlow(a, flow) }).toEqual({ id: a.id, problems: [] });
    }
  });

  it("生成是**幂等**的，而且不依赖时钟（同一输入两次生成逐字节相同）", () => {
    const specs = discoverSpecs();
    for (const key of ["trekly", "farehaven"] as const) {
      const id = key === "trekly" ? "transfer-trekly" : "transfer-farehaven";
      const seed = loadPack(path.join(REPO, "apps", id, "pack.json"));
      const a = serializePack(generatePack(id, key, specs[key], specPathOf(key), seed).pack);
      const b = serializePack(generatePack(id, key, specs[key], specPathOf(key), seed).pack);
      expect(a).toBe(b);
    }
  });

  it("plan_sha256 只跟「计划语义」有关：运行期字段（status/obstacle/saved_at）不进指纹", () => {
    const plan = { goal: "g", slots: {}, subgoals: [{ desc: "d", start_url: "x", signal: { css_exists: "#a" }, status: "pending", obstacle: null }] };
    const ran = { plan: { ...plan, saved_at: 1791084324, subgoals: [{ ...plan.subgoals[0]!, status: "done", obstacle: "whatever" }] } };
    expect(planSha(ran.plan as never)).toBe(planSha(plan as never));
  });
});

describe("builder → pack：流程来自代码里的应用级计划（第 2 条）", () => {
  it("apps/ip-config 由 src/ip-config.ts#buildAppPlan 生成，且 check 通过", async () => {
    const a = generatedApps().find((x) => x.id === "ip-config")!;
    expect(a.ref).toEqual({ source: "src/ip-config.ts#buildAppPlan" });
    expect(checkAgainstFlow(a, await flowFor(a.ref))).toEqual([]);
  });

  it("builder 把验收语义带进包：保存步认回显值，坏行预期被拒绝（而不是手抄进 JSON）", () => {
    const pack = loadPack(path.join(REPO, "apps", "ip-config", "pack.json"));
    const j = pack.journey as Array<Record<string, unknown>>;
    // 第 2 步（CAM-1001 的保存）：all_of[已保存, 回显 10.0.1.11]
    expect(JSON.stringify(j[1]!["signal"])).toContain("10.0.1.11");
    expect(JSON.stringify(j[1]!["signal"])).toContain("all_of");
    // 第 8 步（CAM-1003 坏行）：错误文案 + 被拒的值 + not 已保存 + 自己的 slots
    const bad = JSON.stringify(j[7]!["signal"]);
    expect(bad).toContain("IP 地址格式错误");
    expect(bad).toContain("10.0.1.999");
    expect(bad).toContain("not");
    expect(j[7]!["slots"]).toMatchObject({ ip: "10.0.1.999" });
  });

  it("builder 侧的漂移同样被 check 抓到（改 src 里的判断而没重新生成）", async () => {
    const a = generatedApps().find((x) => x.id === "ip-config")!;
    const doctored = JSON.parse(JSON.stringify(a.pack)) as AppPack;
    (doctored.journey[1] as Record<string, unknown>)["signal"] = { css_text_contains: ["[data-test=save-ok]", "已保存"] };
    const flow = await flowFor(a.ref);
    expect(checkAgainstFlow({ id: a.id, pack: doctored }, flow).join(" | ")).toMatch(/与 spec 展开不一致/);
  });

  it("坏 source 声明在加载期报错（模块不存在 / 缺 #导出名 / 两种都给）", () => {
    const base = loadPack(path.join(REPO, "apps", "ip-config", "pack.json"));
    const mk = (): AppPack => JSON.parse(JSON.stringify(base)) as AppPack;
    const noModule = mk();
    (noModule.generated_from as { source: string }).source = "src/ghost.ts#buildAppPlan";
    expect(validatePack(noModule).join(" | ")).toMatch(/module "src\/ghost\.ts" does not exist/);
    const noFn = mk();
    (noFn.generated_from as { source: string }).source = "src/ip-config.ts";
    expect(validatePack(noFn).join(" | ")).toMatch(/must look like/);
    const both = mk();
    (both.generated_from as unknown as Record<string, unknown>)["spec"] = "transfer/specs/trekly.json";
    expect(validatePack(both).join(" | ")).toMatch(/must not carry both/);
  });
});

describe("spec → pack：漂移必须被抓到（这是它替代人工对齐的资格）", () => {
  it("包里的旅程被手改 → check 报「与 spec 展开不一致」", async () => {
    const a = generatedApps().find((x) => x.id === "transfer-trekly")!;
    const doctored = JSON.parse(JSON.stringify(a.pack)) as AppPack;
    (doctored.journey[1] as Record<string, unknown>)["target_hint"] = "#totally-different";
    const problems = checkAgainstFlow({ id: a.id, pack: doctored }, (await testFlow(a))).join(" | ");
    expect(problems).toMatch(/与 spec 展开不一致/);
  });

  it("角色模板被手改 → 同样被抓到（角色也是展开结果的一部分）", async () => {
    const a = generatedApps().find((x) => x.id === "transfer-trekly")!;
    const doctored = JSON.parse(JSON.stringify(a.pack)) as AppPack;
    const roles = doctored.roles as Record<string, Record<string, unknown>>;
    roles["filter-window"]!["signal"] = { css_exists: "#wrong" };
    expect(checkAgainstFlow({ id: a.id, pack: doctored }, (await testFlow(a))).join(" | ")).toMatch(/与 spec 展开不一致/);
  });

  it("plan_sha256 对不上 → 报哈希不匹配（改了 spec 忘了重新生成时就是这样）", async () => {
    const a = generatedApps().find((x) => x.id === "transfer-voyagio")!;
    const doctored = JSON.parse(JSON.stringify(a.pack)) as AppPack;
    (doctored.generated_from as { plan_sha256: string }).plan_sha256 = "0".repeat(64);
    expect(checkAgainstFlow({ id: a.id, pack: doctored }, (await testFlow(a))).join(" | ")).toMatch(/plan_sha256 不匹配/);
  });

  it("invariants 为空会被明说（生成器只搬判断，不发明判断）", async () => {
    const a = generatedApps().find((x) => x.id === "transfer-skybook")!;
    const doctored = JSON.parse(JSON.stringify(a.pack)) as AppPack;
    doctored.invariants = [];
    expect(checkAgainstFlow({ id: a.id, pack: doctored }, (await testFlow(a))).join(" | ")).toMatch(/invariants 为空/);
  });

  it("spec 路径不存在时也报（generated_from.spec 是发现入口，不能悬空）", async () => {
    const a = generatedApps()[0]!;
    await expect(flowFor({ spec: "transfer/specs/nope.json" })).rejects.toThrow(/不存在/);
  });
});

describe("spec → pack：generated_from 在加载期就被校验（坏声明不许静默）", () => {
  const seed = (): AppPack => JSON.parse(JSON.stringify(
    loadPack(path.join(REPO, "apps", "transfer-trekly", "pack.json")))) as AppPack;

  it("已知的合法声明通过校验", () => {
    expect(validatePack(seed())).toEqual([]);
  });

  it("哈希不是 sha256 / spec 不存在 / 未知键 → 各自精确报错", () => {
    const bad1 = seed();
    (bad1.generated_from as { plan_sha256: string }).plan_sha256 = "zz";
    expect(validatePack(bad1).join(" | ")).toMatch(/plan_sha256 must be a sha256 hex string/);

    const bad2 = seed();
    (bad2.generated_from as { spec: string }).spec = "transfer/specs/ghost.json";
    expect(validatePack(bad2).join(" | ")).toMatch(/does not exist/);

    const bad3 = seed();
    (bad3.generated_from as unknown as Record<string, unknown>)["unknown"] = 1;
    expect(validatePack(bad3).join(" | ")).toMatch(/generated_from\.unknown: unknown key/);
  });
});

describe("生成器表达不了的键必须被点名（独立复核 D1：--write 会静默丢掉它们）", () => {
  it("手改一个生成包加了 P4 的边/上界 ⇒ --check 变红（不是静默假绿）", async () => {
    const a = generatedApps().find((x) => x.id === "transfer-skybook")!;
    const flow = await flowFor(a.ref);
    expect(checkAgainstFlow(a, flow)).toEqual([]);                 // 干净时全绿
    const tampered = JSON.parse(JSON.stringify(a.pack)) as AppPack;
    (tampered.journey[0] as Record<string, unknown>)["id"] = "step-one";
    (tampered.journey[0] as Record<string, unknown>)["next"] = ["step-two"];
    (tampered as unknown as Record<string, unknown>)["max_step_visits"] = 7;
    const joined = checkAgainstFlow({ id: a.id, pack: tampered }, flow).join(" | ");
    expect(joined).toMatch(/生成器表达不了.*journey\[0\]\.next/);
    expect(joined).toMatch(/journey\[0\]\.id/);
    expect(joined).toMatch(/max_step_visits/);
  });

  it("inexpressibleKeys 是数据驱动的：生成器新表达的键自动不再算丢失", () => {
    const seed = { spec_version: 1, id: "x", label: "x", goal: "g", hosts: [], journey: [], notes: [] } as unknown as AppPack;
    const fresh = { spec_version: 1, id: "x", label: "x", goal: "g", hosts: [], journey: [], notes: [] };
    expect(inexpressibleKeys(seed, fresh)).toEqual([]);
    (seed as unknown as Record<string, unknown>)["whatever_new"] = 1;
    expect(inexpressibleKeys(seed, fresh)).toEqual(["whatever_new"]);
  });
});

describe("spec → pack：新应用（没有种子包）时按 spec 的角色名归并", () => {
  it("没有种子 → 结构由 spec 的 role 名决定；有种子 → 沿用种子结构", () => {
    const specs = discoverSpecs();
    const steps = 19;
    expect(structureFromSeed(null, steps)).toBeNull();
    const seed = loadPack(path.join(REPO, "apps", "transfer-trekly", "pack.json"));
    const st = structureFromSeed(seed, steps)!;
    expect(st.length).toBe(steps);
    // 种子结构里"用角色"的步数 == 种子包的 journey 里带 role 的条数
    expect(st.filter((x) => x.role).length).toBe(seed.journey!.filter((j) => j.role).length);
    // 新应用（无种子）也能生成出可加载的包
    const fresh = generatePack("brand-new-app", "trekly", specs.trekly, specPathOf("trekly"), null);
    expect(validatePack(fresh.pack)).toEqual([]);
    expect((fresh.pack.journey ?? []).length).toBe(steps);
  });

  it("emitPlan 与生成物步数一致（防止 spec 改了而生成器没跟上）", () => {
    const specs = discoverSpecs();
    const dir = tmp();
    const planPath = emitPlan("slowjet", specs.slowjet, dir);
    const plan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
    const gen = generatePack("x", "slowjet", specs.slowjet, specPathOf("slowjet"), null);
    expect((gen.pack.journey ?? []).length).toBe(plan.subgoals.length);
  });
});
