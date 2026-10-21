/**
 * Bench-harness tests: the pinned subclassing invariant, the ablation switches,
 * one end-to-end case through the real browser, and the CLI's filtering/plumbing.
 * The model is a scripted runtime — the harness is under test, not the checkpoint.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BenchMiddleware, main, runCase, startUrl, type BenchCase } from "../src/cli/bench.ts";
import { BrowserMiddleware } from "../src/engine/executor.ts";
import { REPO } from "../src/flow/flow.ts";
import { installLayaRuntime, scriptedAgent, scriptedRuntime, type Answer } from "../src/model/model.ts";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "layabench-"));
});
afterAll(() => installLayaRuntime(null));

/** Offline stand-in for the checkpoint: hint-resolved clicks never pick anyway. */
function installScripted(): void {
  const agent = scriptedAgent((key: string): Answer | undefined => {
    if (key === "r") return { noul: 0.05 };       // low risk
    if (key === "act") return { choice: "add_to_cart", probabilities: { add_to_cart: 0.9 }, confidence: 0.9 };
    return undefined;
  });
  installLayaRuntime(scriptedRuntime(agent));
}

const CASE: BenchCase = {
  id: "synthetic-add-to-cart",
  platform: "fixture:test",
  goal: "add the wireless mouse to the cart",
  subgoals: [{
    desc: "add the Wireless Mouse to the shopping cart",
    signal: { css_text_contains: ["[data-test='cart-count']", "1"] },
    start_url: "testpages/product.html",
    target_hint: "button[data-test=add-to-cart]",
  }],
};

describe("BenchMiddleware — the production loop is reused, not forked", () => {
  it("inherits run() (the repo's pinned invariant)", () => {
    expect(Object.getPrototypeOf(BenchMiddleware.prototype).run).toBe(BrowserMiddleware.prototype.run);
    expect(Object.prototype.hasOwnProperty.call(BenchMiddleware.prototype, "run")).toBe(false);
  });

  it("exposes the measured ablation switches and the checkpoint label", () => {
    const m = new BenchMiddleware({ model: "english" });
    expect([m.rulesOn, m.antiRepeat, m.confFloor, m.riskyThreshold]).toEqual([true, true, 0.25, 0.6]);
    expect(m.modelIdUsed).toBe("convaiinnovations/laya");

    const ablated = new BenchMiddleware({ rules: false, antiRepeat: false, confFloor: 0.4 });
    expect([ablated.rulesOn, ablated.antiRepeat, ablated.confFloor]).toEqual([false, false, 0.4]);

    expect(new BenchMiddleware({ model: "multilingual" }).modelIdUsed).toBe("convaiinnovations/laya/multilingual");
    expect(new BenchMiddleware({ model: "router" }).modelIdUsed).toBe("router");
  });

  it("allows risks by default (the bench user is allow-all)", () => {
    const m = new BenchMiddleware({});
    // confirmFn is wired through the base class; a risk prompt must return true
    expect(m.confirmFn?.("pay now")).toBe(true);
  });
});

describe("startUrl — relative case paths resolve against the repo root", () => {
  it("keeps absolute URLs and rewrites relative paths", () => {
    expect(startUrl("https://quotes.toscrape.com/")).toBe("https://quotes.toscrape.com/");
    const u = startUrl("testpages/product.html");
    expect(u.startsWith("file://")).toBe(true);
    // the URL carries "/" separators; compare with the platform-correct conversion
    expect(u).toBe(pathToFileURL(path.join(REPO, "testpages", "product.html")).href);
  });
});

describe("runCase — one browser, one page, real DOM signals", () => {
  it("runs the case through the production loop and reports the Python shape", async () => {
    installScripted();
    const agents = { english: (await scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 }))).load("x")) };
    const res = await runCase(CASE, agents);

    expect(res.all_done).toBe(true);
    expect(res.subgoals_done).toBe("1/1");
    expect(res.case).toBe(CASE.id);
    expect(res.platform).toBe(CASE.platform);
    expect(res.model).toBe("english");
    expect(res.rules).toBe(true);
    expect(res.steps).toBeGreaterThanOrEqual(1);
    expect((res.results[0] as { done: boolean }).done).toBe(true);
    installLayaRuntime(null);
  }, 60_000);
});

describe("main() — case selection, ablations, summary file", () => {
  const writeCases = (cases: BenchCase[]): string => {
    const p = path.join(tmp, "cases.json");
    fs.writeFileSync(p, JSON.stringify({ cases }), "utf-8");
    return p;
  };

  it("runs the selected cases and writes the summary JSON", async () => {
    installScripted();
    const cases = writeCases([CASE, { ...CASE, id: "live-one", platform: "live:quotes" }]);
    const out = path.join(tmp, "results");
    const code = await main(["--cases", cases, "--out", out, "--mode-tag", "test", "--only", CASE.id],
      { runtime: scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 }))) });
    expect(code).toBe(0);

    const files = fs.readdirSync(out);
    expect(files).toHaveLength(1);
    const summary = JSON.parse(fs.readFileSync(path.join(out, files[0]!), "utf-8")).summary;
    expect(summary.mode_tag).toBe("test");
    expect(summary.cases_passed).toBe("1/1");
    expect(summary.subgoals_passed).toBe("1/1");
    expect(summary.per_case[0].case).toBe(CASE.id);
    installLayaRuntime(null);
  }, 60_000);

  it("--fixtures-only drops the live cases; an empty selection fails loudly", async () => {
    installScripted();
    const cases = writeCases([{ ...CASE, id: "live-only", platform: "live:quotes" }]);
    await expect(main(["--cases", cases, "--fixtures-only", "--out", path.join(tmp, "r2")],
      { runtime: scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 }))) }))
      .rejects.toThrow(/no cases selected/);
  });

  it("--force-rules / --force-model override every case", async () => {
    installScripted();
    const cases = writeCases([CASE]);
    const out = path.join(tmp, "r3");
    await main(["--cases", cases, "--out", out, "--force-rules", "off", "--force-model", "english"],
      { runtime: scriptedRuntime(scriptedAgent(() => ({ noul: 0.05 }))) });
    const file = fs.readdirSync(out)[0]!;
    const detail = JSON.parse(fs.readFileSync(path.join(out, file), "utf-8")).detail;
    expect(detail[0].rules).toBe(false);
    expect(detail[0].model).toBe("english");
    installLayaRuntime(null);
  }, 60_000);
});

describe("main() — 智能缺省的 provider 门（bench 与 apps/suite 同一扇门）", () => {
  it("--provider 档：不加载 checkpoints，summary/per_case 如实记 provider 名与档位", async () => {
    installScripted();
    const p = path.join(tmp, "cases-p.json");
    fs.writeFileSync(p, JSON.stringify({ cases: [CASE] }), "utf-8");
    const out = path.join(tmp, "rp");
    const code = await main(["--cases", p, "--out", out, "--provider", "first-candidate"], {});
    expect(code).toBe(0);
    const summary = JSON.parse(fs.readFileSync(path.join(out, fs.readdirSync(out)[0]!), "utf-8")).summary;
    expect(summary.decision_provider).toBe("first-candidate");
    expect(summary.model_status).toBe("on");
    expect(summary.per_case[0].model).toBe("first-candidate");   // checkpoint 标签不许冒充决策源
    const { installDecisionProvider } = await import("../src/model/decision-provider.ts");
    installDecisionProvider(null);
    installLayaRuntime(null);
  }, 180_000);

  it("--force-model 与 provider 档互斥：用法错误点名，不静默忽略（A/B 白跑是比崩更贵的失败）", async () => {
    const p = path.join(tmp, "cases-fm.json");
    fs.writeFileSync(p, JSON.stringify({ cases: [CASE] }), "utf-8");
    const code = await main(["--cases", p, "--out", path.join(tmp, "rfm"),
      "--provider", "first-candidate", "--force-model", "english"], {});
    expect(code).toBe(2);
  }, 60_000);
});
