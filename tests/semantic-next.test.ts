/**
 * NL Flow S3（docs/NL_FLOW_DESIGN.md §6/§10-S3）：语义流的声明式走向（`next`）。
 *
 * 四组钉子：
 *   ① 校验：`next` 是 v3 声明面（v2 写了就红 + 指路升版）；目标必须是声明过的步 id；
 *      重复目标红；空列表红；max_step_visits 非正整数红。
 *   ② 跨步 e2e：`a.next=[c]` 且 c 的 when 在 a 的落点不成立 → 边不用、b 自然接管、
 *      d 经 b 的边直达；c 从未进入 → 记 skipped、path_crossed 点名；ok=true。
 *   ③ 环上界 e2e：自环步走到 max_step_visits（缺省 3）→ 结构化 `next_cycle` 停因
 *      （不是挂死、不是栈溢出），ok=false。
 *   ④ 缺省等价：无边模板的结果 JSON 不出现 path_* 字段（新字段不该只是"多一行没人看的数"）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateTemplate, runFlow, type FlowTemplate } from "../src/semantic-flow.ts";

const template = (specVersion: number, steps: unknown[]): FlowTemplate => ({
  spec_version: specVersion,
  id: "next-app",
  label: "next-app",
  goal: "next-app",
  model: "english",
  slots: {},
  sites: { "site-x": { label: "site-x", start_url: "file:///home.html" } },
  pages: { home: "home.html", second: "second.html", done: "done.html" },
  steps: steps as FlowTemplate["steps"],
  invariants: [],
});

describe("①校验：next 是 v3 声明面，目标必须是声明过的步 id", () => {
  const withNext = [
    { id: "a", desc: "d", page: "home", signal: { page: "second" }, next: ["b"] },
    { id: "b", desc: "d2", page: "second", signal: { page: "done" } },
  ];

  it("v2 写 next ⇒ 红 + 指路升版；v3 同一模板 ⇒ 无问题", () => {
    const v2 = validateTemplate(template(2, withNext));
    expect(v2.some((x) => /step\.next requires spec_version 3/.test(x))).toBe(true);
    expect(validateTemplate(template(3, withNext))).toEqual([]);
  });

  it("指向空气的边 ⇒ 红（一步都不走的静默分支，加载期就说清楚）", () => {
    const ghost = validateTemplate(template(3, [{ ...withNext[0], next: ["ghost"] }]));
    expect(ghost.some((x) => /next: target "ghost" is not a declared step id/.test(x))).toBe(true);
  });

  it("重复目标 / 空列表 / 非正整数 max_step_visits ⇒ 各自红", () => {
    expect(validateTemplate(template(3, [{ ...withNext[0], next: ["b", "b"] }, withNext[1]]))
      .some((x) => /duplicate target "b"/.test(x))).toBe(true);
    expect(validateTemplate(template(3, [{ ...withNext[0], next: [] }]))
      .some((x) => /non-empty list of step ids/.test(x))).toBe(true);
    const t = template(3, withNext);
    t.max_step_visits = 0;
    expect(validateTemplate(t).some((x) => /max_step_visits must be a positive integer/.test(x))).toBe(true);
  });
});

/* ------------------------------------------------------------------ e2e（真 chromium） */

const PAGE = (body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;

function nextApp(specVersion: number, steps: unknown[]): { appsDir: string; site: string; profileDir: string } {
  const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-next-"));
  const dir = path.join(appsDir, "next-app");
  const pagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-next-pages-"));
  fs.writeFileSync(path.join(pagesDir, "home.html"),
    PAGE('<button data-test="go" onclick="location.href=\'second.html\'">前往</button>'), "utf-8");
  fs.writeFileSync(path.join(pagesDir, "second.html"),
    PAGE('<button data-test="record" onclick="location.href=\'done.html\'">记录</button>'), "utf-8");
  fs.writeFileSync(path.join(pagesDir, "done.html"),
    PAGE('<button data-test="finish" onclick="document.title=\'f\'">完成</button>'), "utf-8");
  fs.mkdirSync(path.join(dir, "sites"), { recursive: true });
  fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({
    spec_version: specVersion, id: "next-app", label: "next-app", goal: "next-app",
    model: "english", slots: {},
    sites: { "site-x": { label: "site-x", start_url: `file://${path.join(pagesDir, "home.html")}` } },
    pages: { home: "home.html", second: "second.html", done: "done.html" },
    steps, invariants: [],
  }, null, 2), "utf-8");
  fs.writeFileSync(path.join(dir, "sites", "site-x.profile.json"),
    JSON.stringify({ spec_version: 2, site: "site-x" }, null, 2), "utf-8");
  return { appsDir, site: "site-x", profileDir: fs.mkdtempSync(path.join(os.tmpdir(), "semantic-next-prof-")) };
}

const run = (app: { appsDir: string; site: string; profileDir: string }): ReturnType<typeof runFlow> =>
  runFlow("next-app", app.site, {
    appsDir: app.appsDir, profileDir: app.profileDir, laya: "scripted", verbose: false,
  });

describe("②③走向 e2e：跨步与环上界（真 chromium）", () => {

  it("a.next=[c] 且 c 的 when 在 a 的落点不成立 ⇒ b 自然接管、d 经边直达；c 记 skipped", { timeout: 180_000 }, async () => {
    const app = nextApp(3, [
      { id: "a", desc: "open the second page", page: "home",
        semantic_target: { role: "button", text: "前往" }, signal: { page: "second" }, next: ["c"] },
      { id: "b", desc: "record on the second page", page: "second",
        semantic_target: { role: "button", text: "记录" }, signal: { page: "done" }, next: ["d"] },
      { id: "c", desc: "done-page handler (edge target)", page: "done",
        semantic_target: { role: "button", text: "完成" }, signal: { page: "done" },
        when: { url_contains: "never.html" } },          // 在 a 的落点（second.html）永远不成立
      { id: "d", desc: "finish on the done page", page: "done",
        semantic_target: { role: "button", text: "完成" }, signal: { page: "done" } },
    ]);
    const r = await run(app);
    expect(r.ok).toBe(true);
    const byId = Object.fromEntries(r.steps.map((s) => [s.id, s]));
    expect(byId["a"]!.status).toBe("done");
    expect(byId["b"]!.status).toBe("done");
    expect(byId["d"]!.status).toBe("done");
    expect(byId["c"]!.status).toBe("skipped");           // 被边跨过且从未进入
    expect(r.path_crossed!.some((x) => x.startsWith("c "))).toBe(true);
    expect(r.path_visits).toMatchObject({ a: 1, b: 1, d: 1 });
  });

  it("自环走到 max_step_visits ⇒ 结构化 next_cycle 停因（不是挂死），ok=false", { timeout: 180_000 }, async () => {
    const app = nextApp(3, [
      { id: "a", desc: "open the second page", page: "home",
        semantic_target: { role: "button", text: "前往" }, signal: { page: "second" }, next: ["a"] },
    ]);
    const r = await run(app);
    expect(r.ok).toBe(false);
    // enter() 先计数再判上界：被拒绝的那次进入也计入（与 P4 共享同一 walk 语义）
    expect(r.path_stop).toMatchObject({ code: "next_cycle", step_id: "a", visits: 4 });
    expect(r.path_visits).toMatchObject({ a: 4 });
  });

  it("缺省等价：无边模板的结果不出现 path_* 字段；有提名才有 nominate_bill", { timeout: 180_000 }, async () => {
    const app = nextApp(2, [
      { id: "a", desc: "open the second page", page: "home",
        semantic_target: { role: "button", text: "前往" }, signal: { page: "second" } },
    ]);
    const r = await run(app);
    expect(r.ok).toBe(true);
    expect("path_stop" in r).toBe(false);
    expect("path_visits" in r).toBe(false);
    expect("path_crossed" in r).toBe(false);
    expect("nominate_bill" in r).toBe(false);
  });
});
