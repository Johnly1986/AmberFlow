import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../src/cli/main.ts";

interface RunResult {
  code: number;
  out: string;
  err: string;
  cwd: string;
  home: string;
}

function makeWorkspace(): { cwd: string; home: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amber-cli-test-"));
  const cwd = path.join(root, "work");
  const home = path.join(root, "home");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { cwd, home, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function runCli(
  args: string[],
  opts: { cwd?: string; home?: string; env?: NodeJS.ProcessEnv; isTTY?: boolean } = {},
): Promise<RunResult> {
  const ws = opts.cwd && opts.home ? null : makeWorkspace();
  const cwd = opts.cwd ?? ws!.cwd;
  const home = opts.home ?? ws!.home;
  const out: string[] = [];
  const err: string[] = [];
  const env = {
    ...process.env,
    VITEST: "1",
    AMBERFLOW_HOME: home,
    ...(opts.env ?? {}),
  };
  const code = await main(args, {
    cwd,
    env,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    isTTY: opts.isTTY ?? false,
    runEntry: async () => {
      throw new Error("test did not expect a child process");
    },
  });
  if (ws) ws.cleanup();
  return { code, out: out.join("\n"), err: err.join("\n"), cwd, home };
}

function json(result: RunResult): Record<string, any> {
  return JSON.parse(result.out) as Record<string, any>;
}

describe("amber CLI — Phase 0 contract", () => {
  it("renders global help and version without touching the workspace", async () => {
    const help = await runCli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("amber <命令> [选项]");
    expect(help.out).toContain("run       运行应用、计划或一次性目标");
    expect(help.out).toContain("退出码");

    const version = await runCli(["--version"]);
    expect(version.code).toBe(0);
    expect(version.out).toMatch(/^AmberFlow \d+\.\d+\.\d+/);
  });

  it("suggests the nearest command and keeps --json stdout clean", async () => {
    const r = await runCli(["rn", "--json"]);
    expect(r.code).toBe(2);
    const o = json(r);
    expect(o.ok).toBe(false);
    expect(o.exit_code).toBe(2);
    expect(o.error.code).toBe("USAGE");
    expect(o.error.hint).toContain("run");
    expect(r.err).toBe("");
  });

  it("renders command help in Chinese", async () => {
    const r = await runCli(["run", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("amber run [应用] [选项]");
    expect(r.out).toContain("--dry-run");
    expect(r.out).toContain("退出码");
  });
});

describe("amber apps", () => {
  it("lists built-in apps as a JSON envelope", async () => {
    const r = await runCli(["apps", "list", "--yes", "--timeout", "5", "--json"]);
    expect(r.code).toBe(0);
    const o = json(r);
    expect(o.ok).toBe(true);
    expect(o.command).toBe("apps list");
    expect(o.data.counts.total).toBe(o.data.apps.length);
    expect(o.data.apps.some((a: { id: string }) => a.id === "demo-app")).toBe(true);
  });

  it("shows and checks a known app", async () => {
    const shown = await runCli(["apps", "show", "demo-app", "--json"]);
    expect(shown.code).toBe(0);
    expect(json(shown).data.app).toBe("demo-app");
    expect(json(shown).data.pack.journey.length).toBeGreaterThan(0);

    const checked = await runCli(["apps", "check", "demo-app", "--json"]);
    expect(checked.code).toBe(0);
    expect(json(checked).data.ok).toBe(true);
    expect(json(checked).data.results[0].problems).toEqual([]);
  });

  it("rejects an unknown app with a usage error", async () => {
    const r = await runCli(["apps", "show", "no-such-app", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error.code).toBe("USAGE");
    expect(r.err).toBe("");
  });
});

describe("amber config", () => {
  it("initializes, writes, reads, and unsets a user config", async () => {
    const ws = makeWorkspace();
    const opts = { cwd: ws.cwd, home: ws.home };
    try {
      expect((await runCli(["config", "init", "--json"], opts)).code).toBe(0);
      expect((await runCli(["config", "init", "--json"], opts)).code).toBe(2);

      const set = await runCli(["config", "set", "PLANNER_MODEL", "gpt-test", "--json"], opts);
      expect(set.code).toBe(0);
      expect(json(set).data.key).toBe("PLANNER_MODEL");

      const get = await runCli(["config", "get", "PLANNER_MODEL", "--json"], opts);
      expect(get.code).toBe(0);
      expect(json(get).data.value).toBe("gpt-test");

      const show = await runCli(["config", "show", "--json"], opts);
      expect(show.code).toBe(0);
      expect(json(show).data.values.PLANNER_MODEL.source).toBe("用户配置");

      const unset = await runCli(["config", "unset", "PLANNER_MODEL", "--json"], opts);
      expect(unset.code).toBe(0);
      expect(json(unset).data.removed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it("masks secret values in config show", async () => {
    const ws = makeWorkspace();
    try {
      const opts = { cwd: ws.cwd, home: ws.home };
      expect((await runCli(["config", "set", "TOKEN_PLAN_API_KEY", "sk-12345678", "--json"], opts)).code).toBe(0);
      const show = await runCli(["config", "show", "--json"], opts);
      const v = json(show).data.values.TOKEN_PLAN_API_KEY;
      expect(v.secret).toBe(true);
      expect(v.value).not.toContain("sk-12345678");
      expect(v.value).toContain("掩码");
    } finally {
      ws.cleanup();
    }
  });

  it("reports malformed explicit config instead of leaking child output", async () => {
    const ws = makeWorkspace();
    try {
      const bad = path.join(ws.cwd, "bad.json");
      fs.writeFileSync(bad, "{not json", "utf-8");
      const r = await runCli(["--config", bad, "apps", "list", "--json"], { cwd: ws.cwd, home: ws.home });
      expect(r.code).toBe(2);
      const o = json(r);
      expect(o.ok).toBe(false);
      expect(o.error.code).toBe("CONFIG");
      expect(r.err).toBe("");
    } finally {
      ws.cleanup();
    }
  });
});

describe("amber plan", () => {
  it("creates, edits, moves, checks, and removes a plan with 1-based indexes and ids", async () => {
    const ws = makeWorkspace();
    try {
      const opts = { cwd: ws.cwd, home: ws.home };
      const created = await runCli(["plan", "new", "测试目标", "--url", "https://example.com", "--json"], opts);
      expect(created.code).toBe(0);
      expect(json(created).data.path).toBe("./.amberflow/plan.json");

      const add1 = await runCli([
        "plan", "add", "打开页面", "--signal", "url_contains=example.com",
        "--url", "https://example.com", "--target", "#main", "--json",
      ], opts);
      expect(add1.code).toBe(0);
      expect(json(add1).data.index).toBe(1);

      const add2 = await runCli([
        "plan", "add", "点击按钮", "--signal", "css_exists=#done", "--at", "1", "--json",
      ], opts);
      expect(add2.code).toBe(0);
      expect(json(add2).data.index).toBe(1);
      expect(json(add2).data.start_url).toBe("https://example.com");

      const shown = await runCli(["plan", "show", "--json"], opts);
      expect(shown.code).toBe(0);
      const steps = json(shown).data.steps as Array<{ index: number; id: string; desc: string }>;
      expect(steps.map((s) => s.desc)).toEqual(["点击按钮", "打开页面"]);
      expect(steps.every((s) => typeof s.id === "string" && s.id.length > 0)).toBe(true);

      const edited = await runCli(["plan", "edit", steps[1]!.id, "--desc", "打开目标页", "--json"], opts);
      expect(edited.code).toBe(0);
      expect(json(edited).data.desc).toBe("打开目标页");

      const moved = await runCli(["plan", "move", "1", "--to", "2", "--json"], opts);
      expect(moved.code).toBe(0);

      const checked = await runCli(["plan", "check", "--json"], opts);
      expect(checked.code).toBe(0);
      expect(json(checked).data.ok).toBe(true);

      const removed = await runCli(["plan", "rm", steps[0]!.id, "--json"], opts);
      expect(removed.code).toBe(0);

      const remaining = await runCli(["plan", "show", "--json"], opts);
      expect(json(remaining).data.steps).toHaveLength(1);
    } finally {
      ws.cleanup();
    }
  });

  it("rejects a missing plan without writing one", async () => {
    const ws = makeWorkspace();
    try {
      const r = await runCli(["plan", "show", "--json"], { cwd: ws.cwd, home: ws.home });
      expect(r.code).toBe(2);
      expect(json(r).error.message).toContain("没有找到计划");
      expect(fs.existsSync(path.join(ws.cwd, ".amberflow", "plan.json"))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });
});

describe("amber run", () => {
  it("accepts leading global --json and emits the app list envelope", async () => {
    const r = await runCli(["--json", "apps", "list"]);
    expect(r.code).toBe(0);
    expect(json(r).command).toBe("apps list");
  });

  it("dry-runs the bundled demo without launching a browser", async () => {
    const ws = makeWorkspace();
    try {
      const r = await runCli(["run", "--demo", "--dry-run", "--json"], { cwd: ws.cwd, home: ws.home });
      expect(r.code).toBe(0);
      const o = json(r);
      expect(o.command).toBe("run");
      expect(o.data.mode).toBe("demo");
      expect(o.data.dry_run).toBe(true);
      expect(o.data.steps).toHaveLength(2);
      expect(fs.existsSync(path.join(ws.cwd, ".amberflow", "plan.json"))).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it("dry-runs an app as an expanded plan envelope", async () => {
    const r = await runCli(["run", "demo-app", "--dry-run", "--json"]);
    expect(r.code).toBe(0);
    const o = json(r);
    expect(o.data.mode).toBe("app");
    expect(o.data.app).toBe("demo-app");
    expect(o.data.steps.length).toBeGreaterThan(0);
    expect(o.data.subgoals.length).toBeGreaterThan(0);
  });

  it("rejects conflicting mode flags with exit 2", async () => {
    const r = await runCli(["run", "--demo", "--plan", "x.json", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error.code).toBe("USAGE");
  });
});

describe("amber compatibility layer", () => {
  it("lists the legacy command table and maps old names", async () => {
    const r = await runCli(["legacy"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("plan-cli");
    expect(r.out).toContain("amber plan");
  });

  it("rejects unknown legacy names with a usage error", async () => {
    const r = await runCli(["legacy", "nope", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error.code).toBe("USAGE");
  });
});
