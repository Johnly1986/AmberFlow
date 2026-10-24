/**
 * L2 执行轨迹（`AppTrace`）：审计产物本身也要被校验。
 *
 * 三条纪律的可测形式：
 *   1. 版本可钉：版本/输入不一致 → `replayCompatibility` 返回 problem（重放拒跑）；
 *   2. 只记事实：事件是 `{call, desc, url, ok, stop_code}` 这类结构化事实；
 *   3. 确定性：同一脚本+输入两次运行的事件序列相同（`sameEventSequence`）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  finishTrace, inputsSha256, newTrace, pushEvent, readTrace, replayCompatibility,
  sameEventSequence, validateTrace, writeTrace,
} from "../src/app/trace.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-trace-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sha = (n: string) => n.repeat(64).slice(0, 64);

function sample() {
  const t = newTrace({ app: "demo", script_sha256: sha("a"), inputs_sha256: sha("b") });
  pushEvent(t, { call: "open", url: "file:///x.html" });
  pushEvent(t, { call: "step", desc: "a", ok: true });
  pushEvent(t, { call: "done", ok: true, result: { invariants: [{ id: "i", held: true }] } });
  return finishTrace(t, { done: true, invariants_ok: true });
}

describe("trace 校验：坏产物必须响亮", () => {
  it("合法 trace 零问题；写读往返一致", () => {
    const t = sample();
    expect(validateTrace(t)).toEqual([]);
    const file = path.join(tmp, "t1.json");
    writeTrace(file, t);
    expect(readTrace(file)).toEqual(t);
  });

  it("缺字段/schema 版本不对/sha 不是 64 hex → 逐条点名", () => {
    expect(validateTrace({ schema_version: 2 }).join(" | ")).toContain("schema_version must be 1");
    expect(validateTrace({ schema_version: 1 }).join(" | ")).toContain("app must be a non-empty string");
    const bad = { ...sample(), script_sha256: "nope" };
    expect(validateTrace(bad).join(" | ")).toContain("script_sha256 must be a sha256 hex string");
    expect(validateTrace({ ...sample(), events: "x" }).join(" | ")).toContain("events must be a list");
  });

  it("readTrace 对坏文件抛错（不是返回一个看起来像的物体）", () => {
    const file = path.join(tmp, "bad.json");
    fs.writeFileSync(file, JSON.stringify({ schema_version: 9 }), "utf-8");
    expect(() => readTrace(file)).toThrow(/trace .* is invalid/);
  });
});

describe("重放闸门：版本或输入不一致就拒跑", () => {
  it("全部一致 → 兼容", () => {
    const t = sample();
    expect(replayCompatibility(t, { app: "demo", script_sha256: t.script_sha256, inputs_sha256: t.inputs_sha256 })).toEqual([]);
  });

  it("脚本版本变了 / 输入（槽位）变了 → 各自点名", () => {
    const t = sample();
    const p = replayCompatibility(t, { app: "demo", script_sha256: sha("c"), inputs_sha256: sha("d") });
    expect(p.join(" | ")).toContain("script version mismatch");
    expect(p.join(" | ")).toContain("inputs mismatch");
  });

  it("inputsSha256 对键顺序不敏感、对 outDir/runId 不敏感（它们不在输入里）", () => {
    expect(inputsSha256({ a: "1", b: "2" }, ["h"])).toBe(inputsSha256({ b: "2", a: "1" }, ["h"]));
    expect(inputsSha256({ a: "1" })).not.toBe(inputsSha256({ a: "2" }));
  });
});

describe("确定性：同一事实序列必须相同", () => {
  it("两次运行的事件序列相同 → true；多一条/改一个结果 → false", () => {
    const a = sample();
    const b = sample();
    expect(sameEventSequence(a, b)).toBe(true);
    pushEvent(b, { call: "log", desc: "extra" });
    expect(sameEventSequence(a, b)).toBe(false);
    const c = sample();
    (c.events[1] as { ok?: boolean }).ok = false;
    expect(sameEventSequence(a, c)).toBe(false);
  });
});
