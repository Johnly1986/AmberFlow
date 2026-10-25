/**
 * L2 试点：`flow(ctx)` 的**循环版**与既有 `pack.json` 的 journey 逐字段一致。
 *
 * 这条测试回答"L2 到底多了什么"：`ip-config` 的 8 个步骤在 JSON 里是逐行展开的，
 * 在 flow 里是"4 行数据 × 一个循环 + 一个运行期 if（坏 IP 行期望被拒绝）"。
 * 展开结果必须相同——否则"脚本接管控制流"只是换了个写法。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dryRunFlow, loadScriptApp } from "../src/app/app-script.ts";
import { runScriptApp } from "../src/app/app-runner.ts";
import { expandPack, loadPack } from "../src/app/app-pack.ts";
import { resolveCtxUrl } from "../src/app/ctx.ts";
import { REPO } from "../src/flow/flow.ts";

const FLOW = path.join(REPO, "tests/fixtures/scripts/flow-ip-config.mjs");
const PACK = path.join(REPO, "apps/ip-config/pack.json");

describe("L2 试点：ip-config 循环版 == 既有 pack 展开", () => {
  it("dry 的 step 序列（desc / start_url / 完成条件）与 expandPack(journey) 逐字段相同", async () => {
    const loaded = await loadScriptApp(FLOW);
    const dry = await dryRunFlow(loaded);
    expect(dry.problems).toEqual([]);

    const actual = dry.trace.events
      .filter((e) => e.call === "step")
      .map((e) => ({
        desc: e.desc,
        // dry 的 trace 现在记录**解析后**的 URL（与真实/重放同一口径）；对照时把 journey 的
        // 仓库相对 start_url 也解析一次再比。
        start_url: e.url === undefined ? undefined : resolveCtxUrl(e.url),
        signal: (e.result as { done?: unknown } | undefined)?.done,
      }));
    const expanded = expandPack(loadPack(PACK));
    const expected = expanded.steps.map((s) => ({
      desc: s.desc,
      start_url: s.subgoal?.start_url === undefined ? undefined : resolveCtxUrl(String(s.subgoal.start_url)),
      signal: s.subgoal?.signal,
    }));
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(8);
  });

  it("声明面（invariants）与既有包一致", async () => {
    const loaded = await loadScriptApp(FLOW);
    const legacy = loadPack(PACK);
    const pick = (pack: { invariants?: Array<{ id: string; desc?: string; signal?: unknown }> }) =>
      (pack.invariants ?? []).map((i) => ({ id: i.id, desc: i.desc, signal: i.signal }));
    expect(pick(loaded.pack)).toEqual(pick(legacy));
  });

  it("真实跑（本地复刻站）：ok + 三条不变量成立", async () => {
    const loaded = await loadScriptApp(FLOW);
    const res = await runScriptApp(loaded, { verbose: false, headful: false });
    expect(res.ok).toBe(true);
    expect(res.invariants.map((i) => `${i.id}:${i.held}`)).toEqual([
      "end-on-the-rejected-device-page:true",
      "the-rejected-value-is-the-planned-one:true",
      "rejection-is-not-reported-as-success:true",
    ]);
  }, 180_000);
});
