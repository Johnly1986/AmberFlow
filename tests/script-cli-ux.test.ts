/**
 * 脚本应用的**用户旅程**回归：从"新用户按 README 手写 app.mjs"到"按 id 检查/解释/预览/运行/删除"。
 *
 * 这些用例来自一次用户视角审计（`docs/SCRIPT_AUTHORING_AUDIT.md`）：
 * 审计发现的问题都是"命令能不能用"级别，不是风格问题——
 * 手写脚本看不见（发现制只认标记）、按 id 找不到（解析差一）、list 对每个应用报假错误、
 * `run --dry-run` 对 flow 脚本直接报坏包、`apps emit` 对 flow 报"不应发生"的内部错误。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cli, workspace } from "./cli-harness.ts";
import { REPO } from "../src/flow/flow.ts";

const ws = workspace();
const extraDirs: string[] = [];
afterAll(() => {
  ws.cleanup();
  for (const d of extraDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** 新用户从 README 抄的 flow 应用（手写、无标记）。 */
const HELLO = `export const meta = () => ({
  id: "hello",
  label: "最小离线应用",
  goal: "在门户页进入枪机/筒机录入",
  hosts: [],
  invariants: [{ id: "on-camera-a", desc: "结束时停在 camera_a 录入页", signal: { url_contains: "camera_a.html" } }],
});

export async function flow(ctx) {
  const r = await ctx.step("点击「枪机 / 筒机 录入」", {
    act: ctx.hint("[data-test=entry-fixed]"),
    done: ctx.judge.url("camera_a.html"),
  });
  if (!r.ok) throw new Error(\`entry failed: \${r.stopCode}\`);
  await ctx.done();
}
`;

function writeUserApp(id: string, source = HELLO): string {
  const dir = path.join(ws.home, "apps", id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "app.mjs");
  fs.writeFileSync(file, source, "utf-8");
  return file;
}

function tmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `amberflow-ux-${tag}-`));
  extraDirs.push(d);
  return d;
}

describe("用户作用域的手写脚本：按 id 就能用", () => {
  const file = writeUserApp("hello");

  it("apps check <id>：dry 跑一遍校验（exit 0）", async () => {
    const r = await cli(["apps", "check", "hello"], { home: ws.home });
    expect(r.code).toBe(0);
    expect(r.out).toContain("hello");
    expect(r.out).toContain("全部通过校验");
  });

  it("apps explain <id>：dry 调用序列（不再显示 about:blank）", async () => {
    const r = await cli(["apps", "explain", "hello"], { home: ws.home });
    expect(r.code).toBe(0);
    expect(r.out).toContain("[step] 点击「枪机 / 筒机 录入」");
    expect(r.out).toContain("（当前页）");
    expect(r.out).not.toContain("about:blank");
  });

  it("apps show / path <id>：脚本应用也能查看（含形态与路径）", async () => {
    const shown = await cli(["apps", "show", "hello"], { home: ws.home });
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("flow 脚本（步骤在运行期产生）");
    expect(shown.out).toContain(file);
    const p = await cli(["apps", "path", "hello", "--json"], { home: ws.home });
    expect(p.code).toBe(0);
    expect(p.json().data.path).toBe(file);
  });

  it("apps list：手写脚本被列出，且**没有**假错误（L3 后曾逐个报 'pack.json 不是合法 JSON'）", async () => {
    const r = await cli(["apps", "list"], { home: ws.home });
    expect(r.code).toBe(0);
    expect(r.out).toContain("hello");
    expect(r.out).not.toContain("不是合法 JSON");
    expect(r.out).not.toContain("✗");
  });

  it("run <id> --dry-run：flow 脚本 dry 跑调用序列（曾报 'journey must be a non-empty list'）", async () => {
    const r = await cli(["run", "hello", "--dry-run", "--json"], { home: ws.home });
    expect(r.code).toBe(0);
    const env = r.json();
    expect(env.ok).toBe(true);
    expect(env.data.mode).toBe("flow");
    expect(env.data.events.map((e: { call: string }) => e.call)).toEqual(["step", "done"]);
    expect(env.data.problems).toEqual([]);
  });

  it("run --emit-trace / --replay：被翻译成 app-runner 旗标（以前只有 npm run apps 才有）", async () => {
    const r = await cli(["run", "hello", "--dry-run", "--emit-trace", "/tmp/t.json", "--replay", "/tmp/t.json"], {
      home: ws.home, runEntry: 0,
    });
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("Unknown option");
    const argv = r.calls[0]?.args ?? [];
    expect(argv).toContain("--emit-trace");
    expect(argv).toContain("--replay");
  });

  it("apps remove <id>：用户脚本能按 id 删除", async () => {
    const doomed = writeUserApp("doomed");
    const r = await cli(["apps", "remove", "doomed", "--yes"], { home: ws.home });
    expect(r.code).toBe(0);
    expect(fs.existsSync(doomed)).toBe(false);
  });
});

describe("验收回归：坏脚本 explain 口径 / 手写脚本 label", () => {
  it("坏脚本（只有 meta）→ apps explain exit 2（配置错误，不是 INTERNAL）", async () => {
    const bad = path.join(ws.home, "bad-explain.mjs");
    fs.writeFileSync(bad, `export const meta = () => ({ id: "bad", goal: "g" });`, "utf-8");
    const r = await cli(["apps", "explain", bad]);
    expect(r.code).toBe(2);
    expect(r.out + r.err).not.toContain("未预期的内部错误");
    expect(r.out + r.err).toMatch(/无法加载|needs either "export const app/);
  });

  it("手写 flow 脚本在 apps list --json 里 label 回退到目录名（不再空串）", async () => {
    const r = await cli(["apps", "list", "--json"], { home: ws.home });
    const hello = (r.json().data.apps as Array<{ id: string; label: string; kind: string }>)
      .find((a) => a.id === "hello");
    expect(hello?.kind).toBe("flow");
    expect(hello?.label).toBe("hello");
  });
});

describe("amber apps new：脚手架（可跑、可检查、两种形态）", () => {
  it("默认 flow：check 通过 + dry-run 可预演", async () => {
    const dir = tmpDir("new-flow");
    const target = path.join(dir, "app.mjs");
    const r = await cli(["apps", "new", "my-flow", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf-8")).toContain("export async function flow(ctx)");
    const check = await cli(["apps", "check", target]);
    expect(check.code).toBe(0);
    const dry = await cli(["run", target, "--dry-run", "--json"]);
    expect(dry.code).toBe(0);
    expect(dry.json().data.events.length).toBeGreaterThan(0);
  });

  it("--kind data：固定形状 + 标记（同步工具读得到），check 通过", async () => {
    const dir = tmpDir("new-data");
    const target = path.join(dir, "app.mjs");
    const r = await cli(["apps", "new", "my-data", "--kind", "data", "--dir", dir]);
    expect(r.code).toBe(0);
    const src = fs.readFileSync(target, "utf-8");
    expect(src).toContain("@amberflow:declarative-data");
    expect(src).toContain("const META = ");
    const check = await cli(["apps", "check", target]);
    expect(check.code).toBe(0);
  });

  it("--print 只打印源码、不落盘；已存在时要求 --force", async () => {
    const dir = tmpDir("new-print");
    const r = await cli(["apps", "new", "printed", "--dir", dir, "--print"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("export async function flow(ctx)");
    expect(fs.existsSync(path.join(dir, "app.mjs"))).toBe(false);
    fs.writeFileSync(path.join(dir, "app.mjs"), "// existing", "utf-8");
    const again = await cli(["apps", "new", "printed", "--dir", dir]);
    expect(again.code).toBe(2);
    expect(again.err).toContain("已存在");
    const forced = await cli(["apps", "new", "printed", "--dir", dir, "--force"]);
    expect(forced.code).toBe(0);
  });
});

describe("apps emit：只对声明式脚本，默认落点不再写回应用目录", () => {
  it("flow 脚本：干净拒绝（exit 2 + 下一步），不是'不应发生'的内部错误", async () => {
    writeUserApp("flow-emit");
    const r = await cli(["apps", "emit", "flow-emit"], { home: ws.home });
    expect(r.code).toBe(2);
    expect(r.err).toContain("不支持 flow 脚本");
    expect(r.err).not.toContain("不应发生");
    expect(r.err).toContain("amber apps explain");
  });

  it("声明式脚本：--out 落盘；默认落点在 ./.amberflow/emit/（不污染应用目录）", async () => {
    const camera = path.join(REPO, "tests/fixtures/scripts/camera-entry.mjs");
    const out = path.join(tmpDir("emit"), "camera.json");
    const r = await cli(["apps", "emit", camera, "--out", out]);
    expect(r.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, "utf-8")).id).toBe("camera-entry");

    const cwd = tmpDir("emit-cwd");
    const r2 = await cli(["apps", "emit", camera], { cwd });
    expect(r2.code).toBe(0);
    const def = path.join(cwd, ".amberflow", "emit", "camera-entry.json");
    expect(fs.existsSync(def)).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(camera), "pack.json"))).toBe(false);
  });
});
