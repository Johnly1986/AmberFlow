/**
 * P0-C：应用包的**单一校验入口**（`validateApp = validatePack + 数据源 schema`）。
 *
 * 背景：`validatePack` 对 `sources/*.json` 只查"存在"，不跑 `validateSource`——同一个配置文件，
 * datasource 自身 CLI 会校验、应用路径却放行。本文件钉三件事：
 *   1. `appSourceNames` 把 `sources` 声明与工具步引用的 source 都算进来（角色模板合并规则一致）；
 *   2. `validateApp` 对仓库里**全部**应用包不产生任何新问题（没有假阳性）；
 *   3. 存在但 schema 坏的数据源会被点名（`source "<name>": ...`），且缺失来源仍由原文案报一次。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { appDirs, loadPack, validatePack, type AppPack } from "../src/app/app-pack.ts";
import { validateBenchCase } from "../src/cli/bench.ts";
import { REPO } from "../src/flow/flow.ts";
import { appSourceNames, validateApp } from "../src/app/cross-ref.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-crossref-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function minimalPack(over: Partial<AppPack> = {}): AppPack {
  return {
    spec_version: 1, id: "x", goal: "g", journey: [], invariants: [],
    ...over,
  } as unknown as AppPack;
}

/** 一个**真的能通过 validatePack** 的包（借 demo-app），只替换要测的字段。 */
function realPack(over: Partial<AppPack> = {}): AppPack {
  return { ...loadPack("demo-app"), ...over } as AppPack;
}

describe("appSourceNames：数据源名的唯一收集处", () => {
  it("合并 sources 声明与工具步（含角色模板）引用的 source，去重排序", () => {
    const pack = minimalPack({
      sources: ["git-log"],
      roles: { "run-report": { desc: "跑报告", source: "demo-tool", args: [], signal: { exit_ok: true } } as never },
      journey: [
        { role: "run-report" } as never,
        { desc: "内联工具步", source: "repo-tool", args: [], signal: { exit_ok: true } } as never,
      ],
    });
    expect(appSourceNames(pack)).toEqual(["demo-tool", "git-log", "repo-tool"]);
  });

  it("没有数据源时返回空数组（纯浏览器应用）", () => {
    expect(appSourceNames(minimalPack())).toEqual([]);
  });
});

describe("validateApp：对既有应用包零假阳性", () => {
  it("全部仓库应用包：validateApp 不产生 validatePack 之外的问题", () => {
    const dirs = appDirs();
    let seen = 0;
    for (const dir of dirs) {
      const p = path.join(dir, "pack.json");
      if (!fs.existsSync(p)) continue;
      const pack = loadPack(p);
      const base = validatePack(pack);
      const withSources = validateApp(pack);
      expect(withSources.filter((x) => !base.includes(x)), pack.id).toEqual([]);
      seen += 1;
    }
    expect(seen).toBeGreaterThan(10);          // 至少扫到仓库里的应用包
  });
});

describe("validateApp：坏数据源在加载期被点名", () => {
  it("存在但 schema 坏（未知 extractor）→ source \"<name>\": 前缀的问题", () => {
    const dir = path.join(tmp, "sources");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "broken-source.json"), JSON.stringify({
      name: "broken-source",
      transport: { client: "curl", url_template: "https://example.invalid/{url}" },
      extract: { kind: "nope", fields: {} },
    }), "utf-8");
    const pack = realPack({ sources: ["broken-source"] });
    const problems = validateApp(pack, { sourceDirs: [dir] });
    expect(problems.join(" | ")).toMatch(/source "broken-source": extract\.kind must be one of/);
  });

  it("缺失的数据源仍用既有文案报一次（不重复）", () => {
    const pack = realPack({ sources: ["no-such-source"] });
    const problems = validateApp(pack);
    const hits = problems.filter((p) => p.includes("no-such-source"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("not found");
  });
});

describe("bench 用例：加载期校验（P0-C）", () => {
  const good = () => ({
    id: "c1", platform: "fixture:shop", goal: "g",
    subgoals: [{ desc: "开页", start_url: "testpages/product.html", signal: { css_exists: "main" } }],
  });

  it("缺 signal / 缺 start_url / fixtures 文件不存在 / slots 非对象 全部加载期红", () => {
    const cases = [
      [{ ...good(), subgoals: [{ desc: "x", start_url: "testpages/product.html" }] }, "missing done-signal"],
      [{ ...good(), subgoals: [{ desc: "x", signal: { css_exists: "main" } }] }, "missing start_url"],
      [{ ...good(), subgoals: [{ desc: "x", start_url: "testpages/nope.html", signal: { css_exists: "main" } }] }, "start_url file not found"],
      [{ ...good(), subgoals: [] }, "subgoals must be a non-empty list"],
      [{ ...good(), slots: [1, 2] }, "slots must be an object"],
      [{ ...good(), subgoals: [{ desc: "x", start_url: "https://example.com/a", signal: { magic: 1 } }] }, "unknown signal op"],
    ] as const;
    for (const [c, snippet] of cases) {
      expect(validateBenchCase(c as never).join(" | ")).toContain(snippet);
    }
  });

  it("既有三份用例语料零问题（不制造假阳性）", () => {
    for (const name of ["cases.json", "cases-live.json", "cases-live-long.json"]) {
      const parsed = JSON.parse(fs.readFileSync(path.join(REPO, "bench", name), "utf-8")) as { cases: unknown[] };
      const problems = (parsed.cases as never[]).flatMap((c, i) => validateBenchCase(c, `case[${i}]`));
      expect(problems, name).toEqual([]);
    }
  });
});
