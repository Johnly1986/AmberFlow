/**
 * 兼容层 `amber legacy`（设计文档 §7）。
 *
 * 三条纪律，各钉一条：
 *  1. **行为不变**：实际执行仍走旧入口（默认值、旗标写法都不偷偷换成新的）；
 *  2. **逐字节转发**：用户原样输入的旧旗标必须抵达旧入口，包括新 CLI 自己认识的
 *     `--yes` / `--quiet`——兼容层不做归一化，归一化只在 `amber run/record/plan` 里生效；
 *  3. **旧名 → 新写法**必须看得见：迁移是"旧命令不删、新命令并行"，提示就是迁移账。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { legacyEquivalent, legacyNames } from "../src/cli/legacy.ts";
import { cli } from "./cli-harness.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("兼容表本身", () => {
  it("旧命令齐全且排序稳定（每个名字都能查到新写法）", () => {
    const names = legacyNames();
    expect(names.length).toBeGreaterThanOrEqual(46);
    expect(names).toEqual([...names].sort());
    for (const n of names) {
      const eq = legacyEquivalent(n);
      expect(eq, n).toBeTruthy();
      expect(eq!.startsWith("amber") || eq!.startsWith("npm"), n).toBe(true);
    }
  });

  it("点名的旧入口文件都在磁盘上（表里的笔误不该等到运行时才发现）", () => {
    // 表里 `npm: true` 的那几条没有 entry，它们转发给 npm script。
    const src = fs.readFileSync(path.join(ROOT, "src/cli/legacy.ts"), "utf-8");
    const entries = [...src.matchAll(/entry: "([^"]+)"/g)].map((m) => m[1]!);
    expect(entries.length).toBeGreaterThan(35);
    for (const e of entries) {
      expect(fs.existsSync(path.join(ROOT, e)), `旧入口 ${e} 不存在`).toBe(true);
    }
  });

  it("每个旧命令都在 package.json 里还有一个同名 script（旧调用方不会一夜失效）", () => {
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")).scripts as
      Record<string, string>;
    for (const n of legacyNames()) {
      expect(scripts[n], `package.json 缺少旧 script ${n}`).toBeDefined();
    }
  });
});

describe("amber legacy 的输出", () => {
  it("无参数：打印整张对照表，退出码 2（它不是一项工作，是一张表）", async () => {
    const r = await cli(["legacy"], { runEntry: 0 });
    expect(r.code).toBe(2);
    expect(r.out).toContain("兼容层：amber legacy <旧命令> [参数]");
    for (const name of ["plan-cli", "apps:matrix", "learn", "start"]) {
      expect(r.out, name).toContain(name);
    }
    expect(r.out).toContain("amber plan");
    expect(r.calls).toEqual([]);
  });

  it("--help / -h / help 明确要帮助：退出码 0", async () => {
    for (const args of [["legacy", "--help"], ["legacy", "-h"], ["legacy", "help"]]) {
      const r = await cli(args, { runEntry: 0 });
      expect(r.code, args.join(" ")).toBe(0);
      expect(r.out, args.join(" ")).toContain("兼容层");
    }
  });

  it("未知旧命令 → 用法错误，并指向 amber legacy", async () => {
    const r = await cli(["legacy", "nope", "--json"], { runEntry: 0 });
    expect(r.code).toBe(2);
    expect(r.json().error.code).toBe("USAGE");
    expect(r.json().error.next.join()).toContain("amber legacy");
  });
});

describe("amber legacy 的转发", () => {
  it("按旧入口执行，并提示新写法（提示走 stderr，不污染 stdout）", async () => {
    const r = await cli(["legacy", "plan-cli", "new", "目标"], { runEntry: 0 });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.entry).toBe("tools/plan_cli.ts");
    expect(r.calls[0]!.args).toEqual(["new", "目标"]);
    expect(r.err).toContain("plan-cli 是旧命令");
    expect(r.err).toContain("amber plan");
  });

  it("表里声明的 prefix 原样带上，用户参数排在后面", async () => {
    const agent = await cli(["legacy", "agent", "--url", "u"], { runEntry: 0 });
    expect(agent.calls[0]!.entry).toBe("tools/learn.ts");
    expect(agent.calls[0]!.args).toEqual(["--json", "--yes", "--url", "u"]);

    const fixtures = await cli(["legacy", "bench:fixtures"], { runEntry: 0 });
    expect(fixtures.calls[0]!.entry).toBe("src/cli/bench.ts");
    expect(fixtures.calls[0]!.args).toEqual(["--fixtures-only", "--mode-tag", "smoke", "--out", "bench/results"]);

    const doctor = await cli(["legacy", "doctor"], { runEntry: 0 });
    expect(doctor.calls[0]!.entry).toBe("src/cli/start.ts");
    expect(doctor.calls[0]!.args).toEqual(["--doctor"]);
  });

  it("新 CLI 自己认识的旗标也要逐字节到达旧入口（兼容层不做归一化）", async () => {
    const r = await cli(["legacy", "learn", "--url", "u", "--yes", "--quiet"], { runEntry: 0 });
    // `--yes / --quiet` 会被全局解析记下，但 rawRest 仍把它们交给旧入口——
    // 旧 learn 的默认值一条都不能因为"全局认识了"就少一个字。
    expect(r.calls[0]!.args).toEqual(["--url", "u", "--yes", "--quiet"]);
  });

  it("旧入口的退出码就是 amber 的退出码（不做映射、不美化）", async () => {
    for (const code of [0, 1, 2, 3, 130]) {
      const r = await cli(["legacy", "apps"], { runEntry: code });
      expect(r.code).toBe(code);
    }
  });

  it("start 仍然指向 start.ts：旧 `npm start -- --plan x` 的语义一个字都不变", async () => {
    const r = await cli(["legacy", "start", "--plan", "out.json"], { runEntry: 0 });
    expect(r.calls[0]!.entry).toBe("src/cli/start.ts");
    expect(r.calls[0]!.args).toEqual(["--plan", "out.json"]);
    expect(r.err).toContain("amber run --demo");
  });
});
