/**
 * `amber` 的**入口契约**：帮助 / 版本 / 补全 / 全局选项 / 退出码 / 错误信封。
 *
 * 设计文档 §3.1–§3.2、§5：这层是"第一次用的人"唯一会碰到的东西，所以它必须
 * 可判定、不靠自觉——每条断言都对应文档里的一句承诺：
 *   · 帮助与命令表同源；未知命令给最近建议；
 *   · `--json` 后 stdout 只有一个信封，人类输出与进度一律走 stderr；
 *   · 退出码与信封里的 `exit_code` 永远一致；
 *   · `--no-color` / `--config` 这类会动进程环境的选项，跑完必须还原。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cli, workspace } from "./cli-harness.ts";

describe("amber — 首页（无参数）", () => {
  it("打印状态 + 应用清单 + 下一步，不启动任何子进程", async () => {
    const r = await cli([]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^AmberFlow \d+\.\d+\.\d+/);
    expect(r.out).toContain("Node");
    expect(r.out).toContain("决策源");
    expect(r.out).toContain("应用（");
    expect(r.out).toContain("amber run demo-app");
    expect(r.out).toContain("amber doctor");
    expect(r.calls).toEqual([]);
  });

  it("--json 首页给出机器可读的状态对象", async () => {
    const r = await cli(["--json"]);
    expect(r.code).toBe(0);
    const o = r.json();
    expect(o.command).toBe("amber");
    expect(o.ok).toBe(true);
    expect(o.data.node).toHaveProperty("ok");
    expect(o.data.apps.total).toBe(o.data.apps.builtin + o.data.apps.user);
    expect(o.data.shown.length).toBeLessThanOrEqual(10);
    expect(o.next).toContain("amber doctor");
    // 首页要说清楚"裸 amber 能不能敲"——照抄 next 里的写法却不认命令，是这个包的经典坑。
    expect(typeof o.data.cli.linked).toBe("boolean");
    expect(Array.isArray(o.data.cli.fallbacks)).toBe(true);
  });
});

describe("amber — 帮助与版本", () => {
  it("--help / -h 打印全局帮助", async () => {
    for (const flag of ["--help", "-h"]) {
      const r = await cli([flag]);
      expect(r.code, flag).toBe(0);
      expect(r.out, flag).toContain("amber <命令> [选项]");
      expect(r.out, flag).toContain("退出码");
    }
  });

  it("命令级 --help 交给命令自己（同一份 registry）", async () => {
    const r = await cli(["record", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("record — 演示一次，生成应用");
    expect(r.out).toContain("--cdp");
  });

  it("--help 出现在命令前时给出该命令的帮助", async () => {
    const r = await cli(["--help", "plan"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("plan — 创建 / 编辑 / 校验计划");
  });

  it("help 命令：无主题 = 全局；--all = 含高级选项；主题 = 单命令", async () => {
    const all = await cli(["help", "--all"]);
    expect(all.code).toBe(0);
    expect(all.out).toContain("--ablate");

    const topic = await cli(["help", "config"]);
    expect(topic.code).toBe(0);
    expect(topic.out).toContain("config — 查看 / 修改机器配置");

    // `help` 单独一个词等价于全局帮助（dispatch 里的 HelpRequested）
    const bare = await cli(["help"]);
    expect(bare.code).toBe(0);
    expect(bare.out).toContain("amber <命令> [选项]");
  });

  it("未知帮助主题是用法错误，不是空输出", async () => {
    const r = await cli(["help", "nope", "--json"]);
    expect(r.code).toBe(2);
    expect(r.json().error.code).toBe("USAGE");
    expect(r.json().error.hint).toContain("run");
  });

  it("--version / -V / version 三种写法一致", async () => {
    for (const args of [["--version"], ["-V"], ["version"], ["apps", "--version"]]) {
      const r = await cli(args);
      expect(r.code, args.join(" ")).toBe(0);
      expect(r.out, args.join(" ")).toMatch(/^AmberFlow \d+\.\d+\.\d+/);
    }
  });

  it("version --json 也是同一个信封", async () => {
    const r = await cli(["version", "--json"]);
    const o = r.json();
    expect(o.command).toBe("version");
    expect(o.data.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("amber — 补全", () => {
  it("四种 shell 各给一段脚本", async () => {
    for (const shell of ["bash", "zsh", "fish", "powershell"]) {
      const r = await cli(["completion", shell]);
      expect(r.code, shell).toBe(0);
      expect(r.out.length, shell).toBeGreaterThan(10);
      expect(r.out, shell).toContain("amber");
    }
  });

  it("缺 shell 或给了不认识的 shell → 用法错误并列出可选值", async () => {
    for (const args of [["completion"], ["completion", "tcsh"]]) {
      const r = await cli([...args, "--json"]);
      expect(r.code, args.join(" ")).toBe(2);
      const o = r.json();
      expect(o.error.code).toBe("USAGE");
      expect(o.error.hint).toContain("powershell");
    }
  });
});

describe("amber — 未知命令与全局选项", () => {
  it("未知命令给最近建议 + 退出码 2 + JSON 信封", async () => {
    const r = await cli(["rn", "--json"]);
    expect(r.code).toBe(2);
    const o = r.json();
    expect(o.ok).toBe(false);
    expect(o.exit_code).toBe(2);
    expect(o.error.code).toBe("USAGE");
    expect(o.error.hint).toContain("run");
    expect(o.next.join()).toContain("amber run --help");
    expect(r.err).toBe("");                       // 人类错误文本只进 JSON
  });

  it("差太远的命令不给假建议", async () => {
    const r = await cli(["zzzzzzzz", "--json"]);
    expect(r.code).toBe(2);
    expect(r.json().error.hint).toContain("amber --help");
  });

  it("第一个位置上的未知选项 → 用法错误（不是把它当命令）", async () => {
    const r = await cli(["--nope", "--json"]);
    expect(r.code).toBe(2);
    const o = r.json();
    expect(o.error.message).toContain("--nope");
    expect(o.error.hint).toContain("--json");
  });

  it("--config 缺值是用法错误；--config=FILE 可用", async () => {
    // 值以 `-` 开头 = 漏写路径。悄悄把后面的旗标当文件名会变成"配了却像没配"。
    for (const args of [["--config"], ["--config", "--json"], ["--config", "-x"]]) {
      const missing = await cli([...args, "--json"]);
      expect(missing.code, args.join(" ")).toBe(2);
      expect(missing.json().error.message, args.join(" ")).toContain("--config");
    }
    const ws = workspace();
    try {
      fs.writeFileSync(path.join(ws.cwd, "cfg.json"), '{"PLANNER_MODEL":"m"}', "utf-8");
      const ok = await cli(["--config", "cfg.json", "config", "get", "PLANNER_MODEL", "--json"], {
        cwd: ws.cwd, home: ws.home,
      });
      expect(ok.code).toBe(0);
      expect(ok.json().data.value).toBe("m");
      expect(ok.json().data.source).toBe("显式配置");
    } finally {
      ws.cleanup();
    }
  });

  it("--timeout 必须是正数秒", async () => {
    for (const args of [["--timeout"], ["--timeout", "--json"], ["--timeout", "abc"], ["--timeout", "0"]]) {
      const r = await cli([...args, "version"]);
      expect(r.code, args.join(" ")).toBe(2);
    }
  });

  it("--timeout 合法时不报错，且把它交给子进程预算", async () => {
    const r = await cli(["--timeout", "5", "apps", "list"], { runEntry: 0 });
    expect(r.code).toBe(0);
  });

  it("--quiet / --verbose / --yes 出现在命令前后都认", async () => {
    for (const args of [
      ["--quiet", "apps", "list"], ["apps", "list", "--quiet"],
      ["--verbose", "apps", "list"], ["apps", "list", "--verbose"],
      ["--yes", "apps", "list"], ["apps", "list", "--yes"],
    ]) {
      const r = await cli(args, { runEntry: 0 });
      expect(r.code, args.join(" ")).toBe(0);
    }
  });

  it("--json 在命令之后也一样生效（Agent 常这么拼）", async () => {
    const r = await cli(["apps", "list", "--json"], { runEntry: 0 });
    expect(r.code).toBe(0);
    expect(r.json().command).toBe("apps list");
  });

  it("--no-color 只在本进程内生效，跑完还原 NO_COLOR", async () => {
    const saved = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      const r = await cli(["--no-color", "version"], { runEntry: 0 });
      expect(r.code).toBe(0);
      expect(process.env.NO_COLOR).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = saved;
    }
  });
});

describe("amber — 退出码与信封一致", () => {
  it("返回的退出码 == 信封里的 exit_code", async () => {
    const cases: Array<[string[], number]> = [
      [["nope", "--json"], 2],
      [["apps", "show", "nope", "--json"], 2],
      [["--json"], 0],
    ];
    for (const [args, want] of cases) {
      const r = await cli(args, { runEntry: 0 });
      expect(r.code, args.join(" ")).toBe(want);
      expect(r.json().exit_code, args.join(" ")).toBe(want);
    }
  });

  it("非 JSON 模式下错误文本走 stderr，stdout 保持干净", async () => {
    const r = await cli(["nope"], { runEntry: 0 });
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain("错误：未知命令 'nope'");
    expect(r.err).toContain("下一步：");
    expect(r.err).not.toMatch(/ at .*:\d+:\d+/);   // 可预期错误不打堆栈
  });

  it("未预期的内部异常被收成 INTERNAL（退出码 1）而不是堆栈", async () => {
    const r = await cli(["run", "demo-app", "--json"], {
      runEntry: () => { throw new Error("boom-in-child"); },
    });
    expect(r.code).toBe(1);
    const o = r.json();
    expect(o.error.code).toBe("INTERNAL");
    expect(o.error.message).toContain("boom-in-child");
  });
});

describe("amber — 配置错误对命令的门", () => {
  it("项目配置坏了：普通命令被 CONFIG 挡住，config / doctor / legacy 仍可运行", async () => {
    const ws = workspace();
    try {
      fs.mkdirSync(path.join(ws.cwd, ".amberflow"), { recursive: true });
      fs.writeFileSync(path.join(ws.cwd, ".amberflow", "config.json"), "{not json", "utf-8");
      const opts = { cwd: ws.cwd, home: ws.home };

      const blocked = await cli(["apps", "list", "--json"], opts);
      expect(blocked.code).toBe(2);
      expect(blocked.json().error.code).toBe("CONFIG");
      expect(blocked.json().next.join()).toContain("amber config show");

      // 救自己的门不能一起被锁上：否则坏配置 = 永久出不去
      const shown = await cli(["config", "show", "--json"], opts);
      expect(shown.code).toBe(2);                       // show 报告错误但仍然给出层叠
      expect(shown.json().data.layers.length).toBeGreaterThan(0);

      const legacy = await cli(["legacy"], opts);
      expect(legacy.code).toBe(2);                      // 兼容层列出对照表
      expect(legacy.out).toContain("plan-cli");
    } finally {
      ws.cleanup();
    }
  });
});
