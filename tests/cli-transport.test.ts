/**
 * CLI 传输层测试 —— 「命令行工具当数据源」这条路走通了吗。
 *
 * 四类工具，四种形状（这也是"多类型工具复核"的清单）：
 *   1. 合成桩 `apps/demo-tool/bin/stub-tool.mjs` —— 确定性的，CI 无条件可跑（等价于注入
 *      的 scriptedRuntime）：argv 数组、env 白名单、cwd、退出码白名单、超时、版本 pin、
 *      以及"永不过 shell"的验收。
 *   2. 行文本工具（git log）—— `lines_regex`，真实仓库。
 *   3. JSON 工具（jq）—— `json_stdout` / `lines_regex`，输入是受版本控制的仓库产物。
 *   4. HTTP 客户端（curl / httpx）—— 既有那一档的回归：引擎行为逐字节没变（见
 *      `npm run parity:datasource` 的 163 项）。
 *
 * 真实工具缺失时用 skipIf 跳过（与 smoke.sh 的 ONNX "缺产物打印 SKIP" 同一约定）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  checkVersion, cliRun, cliVersion, CLI_KEYS, extract, EXTRACT_KINDS, loadSource, runSource,
  sourceDirs, TRANSPORTS, validateSource, type Source,
} from "../src/datasource.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const STUB = "apps/demo-tool/bin/stub-tool.mjs";

const hasTool = (bin: string): boolean => {
  try {
    execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** 桩工具 source（inline，便于逐项改配置）。 */
const stubSource = (over: Partial<Record<string, unknown>> = {}): Source => {
  const base = {
    name: "t",
    label: "t",
    transport: {
      client: "cli",
      url_template: "widgets",
      cli: { bin: "node", argv: [STUB, "--query={url}", "--json"] },
      version_pin: "stub-tool 1.4.2",
      version_argv: [STUB, "--version"],
    },
    extract: { kind: "json_stdout", rows: "rows", fields: { id: "id", price: "price" } },
  };
  return { ...base, ...over } as unknown as Source;
};

const fakeName = (): string => path.join(os.tmpdir(), `amberflow-shell-${process.pid}-${Math.random().toString(36).slice(2)}`);
const exists = (p: string): boolean => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

/* ------------------------------------------------------------ 1. 配置校验 */

describe("validateSource：cli 那一档写错就在加载时炸", () => {
  it("四个随仓库提交的应用 source 全部通过校验", () => {
    for (const name of ["demo-tool", "git-log", "bench-cases-index", "bench-cases-shape"]) {
      const cfg = loadSource(name);
      expect(validateSource(cfg), name).toEqual([]);
    }
  });

  it("词表里已经有 cli / json_stdout / lines_regex", () => {
    expect(TRANSPORTS).toContain("cli");
    expect(EXTRACT_KINDS).toContain("json_stdout");
    expect(EXTRACT_KINDS).toContain("lines_regex");
  });

  it.each([
    ["没有 cli 块", (c: any) => { delete c.transport.cli; }, "transport.cli is required"],
    ["bin 空", (c: any) => { c.transport.cli.bin = "  "; }, "transport.cli.bin is required"],
    ["bin 不是字符串", (c: any) => { c.transport.cli.bin = ["node"]; }, "transport.cli.bin is required"],
    ["argv 缺失", (c: any) => { delete c.transport.cli.argv; }, "argv must be a non-empty list of strings"],
    ["argv 空数组", (c: any) => { c.transport.cli.argv = []; }, "argv must be a non-empty list of strings"],
    ["argv 里有非字符串", (c: any) => { c.transport.cli.argv = ["node", 7]; }, "argv must be a non-empty list of strings"],
    ["未知 cli 键", (c: any) => { c.transport.cli.shell = true; }, "transport.cli.shell: unknown key"],
    ["env_allow 不是列表", (c: any) => { c.transport.cli.env_allow = "HOME"; }, "env_allow must be a list"],
    ["exit_ok 不是整数表", (c: any) => { c.transport.cli.exit_ok = ["0"]; }, "exit_ok must be a list of integer"],
    ["cwd 不是字符串", (c: any) => { c.transport.cli.cwd = 3; }, "cwd must be a string"],
    ["stdin 不是字符串", (c: any) => { c.transport.cli.stdin = {}; }, "stdin must be a string"],
    ["version_pin 不是字符串", (c: any) => { c.transport.version_pin = 2; }, "version_pin must be a string"],
    ["version_argv 空", (c: any) => { c.transport.version_argv = []; }, "version_argv must be a non-empty list of strings"],
  ])("%s", (_label, mutate, snippet) => {
    const c = JSON.parse(JSON.stringify(stubSource())) as any;
    mutate(c);
    expect(validateSource(c).join(" | ")).toContain(snippet);
  });

  it("curl 那一档带了 cli 块 / version_pin -> 报错（不留死配置）", () => {
    const curl = loadSource("ctrip-hotels-pc") as any;
    const withCli = JSON.parse(JSON.stringify(curl));
    withCli.transport.cli = { bin: "git", argv: ["log"] };
    expect(validateSource(withCli).join(" | ")).toContain("transport.cli only applies to transport.client 'cli'");
    const withPin = JSON.parse(JSON.stringify(curl));
    withPin.transport.version_pin = "curl 8.";
    expect(validateSource(withPin).join(" | ")).toContain("transport.version_pin only applies to transport.client 'cli'");
  });

  it("json_stdout 必须有 rows；lines_regex 的 line_sep 必须是字符串", () => {
    const a = stubSource();
    delete (a.extract as any).rows;
    expect(validateSource(a).join(" | ")).toContain("extract.rows is required for json_stdout");
    const b = stubSource({ extract: { kind: "lines_regex", line_sep: 7, fields: { id: "^(.+)$" } } });
    expect(validateSource(b).join(" | ")).toContain("extract.line_sep must be a string");
  });

  it("正则字段里的 `|` 是交替，不是「路径|算子」——不再被误报成 unknown op", () => {
    const cfg = stubSource({
      extract: { kind: "lines_regex", fields: { id: "^(a|b)-([0-9]+)$" } },
    });
    // 两个捕获组 -> 只报捕获组的问题，不报算子
    const problems = validateSource(cfg).join(" | ");
    expect(problems).toContain("regex needs exactly one capture group");
    expect(problems).not.toContain("unknown op");
    const one = stubSource({ extract: { kind: "lines_regex", fields: { id: "^(a|b)$" } } });
    expect(validateSource(one)).toEqual([]);
  });
});

/* ------------------------------------------------------------ 2. 抽取器 */

describe("子进程 stdout 的两种抽取器", () => {
  it("json_stdout：整个 stdout 是一个 JSON 文档，rows 是必填路径", () => {
    const page = extract('{"rows":[{"id":"a","n":1},{"id":"b","n":2}]}',
      stubSource({ extract: { kind: "json_stdout", rows: "rows", fields: { id: "id", n: "n" } } }) as any);
    expect(page.rows).toEqual([{ id: "a", n: 1 }, { id: "b", n: 2 }]);
  });

  it("json_stdout：不是 JSON 就报错（把第一行带进消息，方便定位）", () => {
    expect(() => extract("fatal: not a git repository\n", stubSource() as any))
      .toThrow(/stdout is not JSON.*fatal: not a git repository/s);
  });

  it("lines_regex：保留第一行（html_regex 会丢第一块，那是 HTML 表头口径）", () => {
    const cfg = stubSource({
      extract: { kind: "lines_regex", fields: { sha: "^([0-9a-f]{7,40})\\|", subject: "^[^|]*\\|(.+)$" } },
    });
    const text = "abc1234|first commit\n\ndef5678|second commit \n";
    const page = extract(text, cfg as any);
    expect(page.rows).toEqual([
      { sha: "abc1234", subject: "first commit" },
      { sha: "def5678", subject: "second commit" },
    ]);
  });

  it("lines_regex：line_sep 可换（不是 \n 的输出），全空字段的行不计入", () => {
    const cfg = stubSource({
      extract: { kind: "lines_regex", line_sep: ";;", fields: { id: "id=([^;]+)" } },
    });
    expect(extract("id=a;;;garbage;;id=b", cfg as any).rows).toEqual([{ id: "a" }, { id: "b" }]);
  });
});

/* ------------------------------------------------------------ 3. 子进程行为 */

describe("cliRun：argv 数组、env 白名单、cwd、退出码、超时", () => {
  it("成功 -> 200 + stdout；版本 pin 命中并回传实测版本", async () => {
    const src = stubSource();
    const [code, body] = await cliRun("widgets", 30, src);
    expect(code).toBe(200);
    expect(JSON.parse(body).rows).toHaveLength(3);
    expect(cliVersion(src)).toBe("stub-tool 1.4.2");
    expect(checkVersion(src)).toBe("stub-tool 1.4.2");
  });

  it("退出码 3 -> 原样上报，stderr 进响应体（block_markers 才认得出失败）", async () => {
    const src = stubSource({
      transport: {
        client: "cli", url_template: "x",
        cli: { bin: "node", argv: [STUB, "--query={url}", "--fail"] },
      },
    });
    const [code, body] = await cliRun("x", 30, src);
    expect(code).toBe(3);
    expect(body).toContain("stub-tool: boom");
  });

  it("exit_ok 白名单：把 3 也算成功（diff/grep 这类语义化退出码）", async () => {
    const src = stubSource({
      transport: {
        client: "cli", url_template: "x",
        cli: { bin: "node", argv: [STUB, "--fail"], exit_ok: [0, 3] },
      },
    });
    expect((await cliRun("x", 30, src))[0]).toBe(200);
  });

  it("env 白名单：只放行列出的变量（PATH 永远保留，否则找不到可执行文件）", async () => {
    const src = stubSource({
      transport: {
        client: "cli", url_template: "x",
        cli: { bin: "node", argv: [STUB], env_allow: ["STUB_TOKEN"] },
      },
    });
    const saved = { token: process.env.STUB_TOKEN, home: process.env.HOME };
    process.env.STUB_TOKEN = "s3cret";
    try {
      const env = JSON.parse((await cliRun("x", 30, src))[1]).env;
      expect(env.STUB_TOKEN).toBe("s3cret");
      expect(env.HOME).toBeNull();          // 没在白名单里 -> 子进程看不到
      expect(env.PATH).toBe(true);
    } finally {
      if (saved.token === undefined) delete process.env.STUB_TOKEN; else process.env.STUB_TOKEN = saved.token;
      if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    }
  });

  it("cwd 生效（相对路径按仓库根解析）", async () => {
    const src = stubSource({
      transport: {
        client: "cli", url_template: "x",
        cli: { bin: "node", argv: [path.join(REPO, STUB)], cwd: "apps/demo-tool" },
      },
    });
    const out = JSON.parse((await cliRun("x", 30, src))[1]);
    expect(out.cwd).toBe(path.join(REPO, "apps", "demo-tool"));
  });

  it("超时：子进程被预算杀掉并抛错（不是静默返回空）", async () => {
    const src = stubSource({
      transport: {
        client: "cli", url_template: "x",
        cli: { bin: "node", argv: [STUB, "--slow=5000"] },
      },
    });
    await expect(cliRun("x", 0.4, src)).rejects.toThrow();
  }, 20_000);

  it("二进制不存在 -> 抛错（错误响亮度与 curl 那一档一致）", async () => {
    const src = stubSource({
      transport: { client: "cli", url_template: "x", cli: { bin: "definitely-not-a-tool-xyz", argv: ["--version"] } },
    });
    await expect(cliRun("x", 5, src)).rejects.toThrow();
  });

  it("永不过 shell：`;`、`$(...)`、反引号、`|` 都只是普通参数", async () => {
    const victim = fakeName();
    const src = stubSource({
      transport: {
        client: "cli", url_template: "{u}",
        cli: { bin: "node", argv: [STUB, "--query={url}"] },
      },
      constants: { u: "" },
    });
    const nasty = `x; touch ${victim}; $(touch ${victim}) \`touch ${victim}\` | touch ${victim}`;
    const [code, body] = await cliRun(nasty, 30, src);
    expect(code).toBe(200);
    expect(JSON.parse(body).argv.join(" ")).toContain(`--query=${nasty}`);   // 原样一个参数
    expect(exists(victim)).toBe(false);                                      // 什么都没被执行
  });

  it("argv 占位符：只替换已知键，工具参数里的花括号原样保留", async () => {
    const jqLike = "[.cases[] | {id: .id, subgoals: (.subgoals | length)}]";
    const src = stubSource({
      transport: {
        client: "cli", url_template: "widgets",
        cli: { bin: "node", argv: [STUB, "--query={url}", jqLike] },
      },
      constants: { CONST: "c" },
    });
    const out = JSON.parse((await cliRun("widgets", 30, src))[1]);
    expect(out.query).toBe("widgets");
    expect(out.argv).toContain(jqLike);
    expect(out.argv).toContain("--query=widgets");
  });

  it("版本 pin 不匹配 -> 抛 ValueError（响亮失败，不是抽出一堆看起来对的数据）", () => {
    const src = stubSource({
      transport: {
        client: "cli", url_template: "x",
        cli: { bin: "node", argv: [STUB] },
        version_pin: "stub-tool 9.9.9",
        version_argv: [STUB, "--version"],
      },
    });
    expect(() => checkVersion(src)).toThrow(/tool version mismatch/);
  });
});

/* ------------------------------------------------------------ 4. 端到端 */

describe("runSource：CLI 工具走完整条数据源链路", () => {
  it("桩工具：rows / counts / audits / selects / 报告里的通道与版本", async () => {
    const src = loadSource("demo-tool");
    const res = await runSource(src, ["2026-10-03"], { today: "2026-10-03", verbose: false });
    const day = res.dates["2026-10-03"]!;
    expect(day.rows).toHaveLength(3);
    expect(day.counts!.rows).toBe(3);
    expect(day.audits!.no_price).toBe(0);
    expect((day.selects!.cheapest as any).price).toBe(9.99);
    expect(res.tool_version).toBe("stub-tool 1.4.2");
  });

  // 与下面两条 jq 用例同一个闸：这台机器没装 jq 就跑不了真通道（skipIf 明着跳过 ≠ 通过）。
  it.skipIf(!hasTool("jq"))("非价格型数据源的报告不再打出 None（选择项按 sort_by 的第一个键渲染）", async () => {
    const res = await runSource(loadSource("bench-cases-shape"), ["2026-10-03"],
      { today: "2026-10-03", verbose: false });
    const md = (await import("../src/datasource.ts")).reportMarkdown(loadSource("bench-cases-shape"), res.dates);
    expect(md.startsWith("# ")).toBe(true);            // 报告正常产出
    expect(md).not.toContain("**None**");
    expect(md).toContain("- 抓取通道：`cli`（`jq`");
  });

  it.skipIf(!hasTool("jq"))("jq 行文本：用例清单与文件内容一致（输入是受版本控制的产物）", async () => {
    const res = await runSource(loadSource("bench-cases-index"), ["2026-10-03"], { verbose: false });
    const ids = (res.dates["2026-10-03"]!.rows ?? []).map((r) => r.id);
    const pack = JSON.parse(fs.readFileSync(path.join(REPO, "bench", "cases-live-long.json"), "utf-8"));
    expect(ids).toEqual(pack.cases.map((c: any) => c.id));
    expect(res.tool_version).toMatch(/^jq-/);
  });

  it.skipIf(!hasTool("jq"))("jq 整份 JSON：json_stdout 抽到结构化字段", async () => {
    const res = await runSource(loadSource("bench-cases-shape"), ["2026-10-03"], { verbose: false });
    const rows = res.dates["2026-10-03"]!.rows as any[];
    expect(rows.map((r) => r.id)).toEqual([
      "live-long-saucedemo-checkout", "live-long-books", "live-long-quotes",
    ]);
    expect(rows[0].subgoals).toBe(15);
    expect(rows.every((r) => typeof r.platform === "string" && r.platform.startsWith("live:"))).toBe(true);
  });

  it.skipIf(!hasTool("git"))("git 行文本：提交行解析成 sha/author/date/subject", async () => {
    const res = await runSource(loadSource("git-log"), ["2026-10-03"], { verbose: false });
    const rows = res.dates["2026-10-03"]!.rows as any[];
    expect(rows.length).toBeGreaterThan(0);              // 30 天窗口：仓库有近期提交
    for (const r of rows) {
      expect(r.sha).toMatch(/^[0-9a-f]{7,40}$/);
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof r.subject).toBe("string");
      expect(r.subject.length).toBeGreaterThan(0);
    }
    expect(res.tool_version).toMatch(/^git version 2\./);
  });

  it("curl / httpx 那一档没有被这次的改动碰到（同一批 source 仍走老通道）", () => {
    for (const name of ["ctrip-flights-h5", "ctrip-hotels-pc"]) {
      const cfg = loadSource(name);
      expect((cfg.transport as any).client).toMatch(/^(curl|httpx)$/);
      expect(validateSource(cfg), name).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------ 5. 发现制与防泄漏 */

describe("发现制：新应用 = 新目录，引擎不加站点/工具知识", () => {
  it("sourceDirs 扫到 apps/*/sources（不用维护目录表）", () => {
    const dirs = sourceDirs();
    for (const app of ["demo-tool", "git-log", "bench-cases"]) {
      expect(dirs.some((d) => d === path.join(REPO, "apps", app, "sources")), app).toBe(true);
    }
    expect(dirs.some((d) => d.endsWith(path.join("ctrip", "sources")))).toBe(true);
  });

  it("引擎源码（剥掉块注释）里没有具体工具名——工具名只许出现在配置和注释里", () => {
    const src = fs.readFileSync(path.join(REPO, "src", "datasource.ts"), "utf-8");
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, " ");
    expect(codeOnly.length).toBeLessThan(src.length);
    for (const tool of ['"git"', "'git'", '"jq"', "'jq'", "ffprobe", "yt-dlp", "pandoc", "sha256sum"]) {
      expect(codeOnly, `引擎代码里出现了具体工具名：${tool}`).not.toContain(tool);
    }
    expect(CLI_KEYS.join(",")).toBe("bin,argv,env_allow,cwd,exit_ok,stdin");   // 配置面就这六个键
  });
});
