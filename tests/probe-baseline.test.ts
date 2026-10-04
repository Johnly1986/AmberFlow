/**
 * 探针基线（第 4 条）：把"上一次真实探测的判决"变成包里可核对的数据。
 *
 * 基线只存标量判决（不存 reason——那是冻结语料里的叙述）；`--check` 拿它与已入库的探测记录比，
 * 于是"站点变了"和"有人手改了包"这两种情况都会变红，而不是等人再读一遍报告。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPack, validatePack, type AppPack } from "../src/app-pack.ts";
import {
  DEFAULT_FROM, baselineOf, diffPack, readRecord, verdictsOf,
} from "../tools/probe-baseline.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const pack = (id: string): AppPack => loadPack(path.join(REPO, "apps", id, "pack.json"));

describe("探针基线：与已入库的探测记录一致", () => {
  it("三个探针应用的基线都等于记录里的判决", () => {
    const record = readRecord(DEFAULT_FROM);
    for (const id of ["ctrip-live", "ota-live", "qunar-live"]) {
      const rec = record.find((r) => r.app === id)!;
      expect(rec, `${id} 在记录里`).toBeTruthy();
      expect(diffPack(pack(id), rec.verdicts)).toEqual({ app: id, missing: [], changed: [], extra: [] });
    }
  });

  it("基线里存的是判决，不是叙述（reason 一律不进基线）", () => {
    const record = readRecord(DEFAULT_FROM);
    const ctrip = record.find((r) => r.app === "ctrip-live")!;
    expect(ctrip.verdicts["flight_search"]).toBe("BLOCKED");       // 枚举判决
    expect(ctrip.verdicts["hotel_price"]).toBe("LOGIN_REQUIRED");
    expect(Object.keys(ctrip.verdicts).some((k) => /reason/i.test(k))).toBe(false);
    expect(Object.keys(baselineOf(pack("ctrip-live"))).some((k) => /reason/i.test(k))).toBe(false);
  });

  it("四种探针驱动的结果形状都能抽出判决（含 qunar 的逐行文本）", () => {
    expect(verdictsOf("apps/x (live-capture)", { captured: 0, total: 2, verdicts: { flights: "blocked" } }))
      .toEqual({ captured: "0", total: "2", flights: "blocked" });
    expect(verdictsOf("apps/x (ota-probe)", { verdict: { anonymous_price_list_reachable: false, reason: "长文" } }))
      .toEqual({ anonymous_price_list_reachable: "false" });
    expect(verdictsOf("apps/x (qunar-probe)", { 0: 'curl-default-ua    captured       {"code":200,"verdict":"captured"}' }))
      .toEqual({ "curl-default-ua": "captured" });
  });
});

describe("探针基线：漂移必须被抓住", () => {
  it("站点变了（记录里是新判决）→ changed", () => {
    const d = diffPack(pack("ota-live"), { anonymous_price_list_reachable: "true", usable_targets: "5" });
    expect(d.changed).toContain("anonymous_price_list_reachable");
    expect(d.missing).toContain("usable_targets");
  });

  it("有人手改了包里的基线 → changed（同一个检查）", () => {
    const doctored = JSON.parse(JSON.stringify(pack("ctrip-live"))) as AppPack;
    const b = (doctored.probe as { baseline: { verdicts: Record<string, string> } }).baseline;
    b.verdicts["flight_search"] = "CAPTURED";
    const rec = readRecord(DEFAULT_FROM).find((r) => r.app === "ctrip-live")!;
    expect(diffPack(doctored, rec.verdicts).changed).toContain("flight_search");
  });

  it("记录里消失的项 → extra（探针不再产出它了，该清理）", () => {
    const d = diffPack(pack("qunar-live"), {});
    expect(d.extra.length).toBeGreaterThan(0);
  });

  it("坏 baseline 在加载期报错（未知键 / 非字符串判决 / 不是对象）", () => {
    const mk = (): AppPack => JSON.parse(JSON.stringify(pack("ota-live"))) as AppPack;
    const a = mk();
    ((a.probe as { baseline: Record<string, unknown> }).baseline)["nope"] = 1;
    expect(validatePack(a).join(" | ")).toMatch(/probe\.baseline\.nope: unknown key/);
    const b = mk();
    (b.probe as { baseline: { verdicts: Record<string, unknown> } }).baseline.verdicts["x"] = 42;
    expect(validatePack(b).join(" | ")).toMatch(/must be a string/);
    const c = mk();
    (c.probe as unknown as Record<string, unknown>)["baseline"] = "yes";
    expect(validatePack(c).join(" | ")).toMatch(/baseline must be an object/);
  });
});
