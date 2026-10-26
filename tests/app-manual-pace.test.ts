/**
 * 人工步骤 + 应用配置表里的运行节奏（`pace`）。
 *
 * 这两件事都是"线上路径"的降载/人机协同机制，不是反爬对抗：
 *   - `pace.between_steps_ms` / `between_actions_ms`：显式声明的最小等待；
 *   - `adapter: "manual"`：登录/验证码/人工确认，人完成，引擎验声明的 signal。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AppRunConfigError, appReportMarkdown, resolvePace, runApp,
} from "../src/app/app-runner.ts";
import { appStepKeys, validatePack, type AppPack } from "../src/app/app-pack.ts";
import { listAppAdapters, manualAdapter } from "../src/app/app-adapters.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amberflow-manual-pace-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function pack(journey: Array<Record<string, unknown>>, pace?: Record<string, number>): AppPack {
  return {
    spec_version: 1,
    id: `manual-pace-${seq++}`,
    label: "人工步骤/节奏夹具",
    goal: "验证人工步骤和步间延迟",
    model: "english",
    hosts: [],
    slots: {},
    journey,
    ...(pace === undefined ? {} : { pace }),
  } as AppPack;
}

function manualStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    adapter: "manual",
    desc: "人工登录",
    instructions: "在打开的浏览器里完成登录",
    signal: { manual: true },
    ...overrides,
  };
}

function runOpts(p: AppPack, extra: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "run-"));
  return {
    planPath: path.join(dir, "plan.json"),
    verbose: false,
    sources: false,
    ...extra,
  };
}

describe("人工步骤（adapter: manual）", () => {
  it("是已注册的适配器，步键/必填项在加载期校验", () => {
    expect(listAppAdapters()).toContain("manual");
    expect(manualAdapter.ready!().ready).toBe(false);       // apps:suite 是批处理：不等人
    expect(appStepKeys()).toEqual(expect.arrayContaining(["instructions", "start_url", "signal"]));
    expect(validatePack(pack([manualStep()]))).toEqual([]);
    expect(validatePack(pack([manualStep({ signal: undefined })]))).toEqual(
      expect.arrayContaining([expect.stringMatching(/manual step needs a signal/)]),
    );
    expect(validatePack(pack([manualStep({ desc: "" })]))).toEqual(
      expect.arrayContaining([expect.stringMatching(/needs desc/)]),
    );
    expect(validatePack(pack([manualStep({ instruction: "typo" })]))).toEqual(
      expect.arrayContaining([expect.stringMatching(/unknown step key/)])
    );
    expect(validatePack(pack([manualStep({ signal: { unknown_op: true } })]))).toEqual(
      expect.arrayContaining([expect.stringMatching(/unknown signal op/)])
    );
    expect(validatePack(pack([manualStep({ retries: 1 })]))).toEqual(
      expect.arrayContaining([expect.stringMatching(/does not retry/)])
    );
    expect(validatePack(pack([manualStep({ returns: { x: { from: "stdout" } } })]))).toEqual(
      expect.arrayContaining([expect.stringMatching(/no process observation/)])
    );
  });

  it("人确认后完成；两个人工步之间按 pace 等待", async () => {
    const p = pack([manualStep({ desc: "登录" }), manualStep({ desc: "确认" })], { between_steps_ms: 60 });
    const requests: string[] = [];
    const t0 = Date.now();
    const res = await runApp(p, runOpts(p, {
      manualHandler: async (req: { desc: string }) => { requests.push(req.desc); return true; },
    }) as never);
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(true);
    expect(res.completed).toBe("2/2");
    expect(res.manual_steps).toHaveLength(2);
    expect(res.manual_steps!.every((m) => m.done && m.attested)).toBe(true);
    expect(requests).toEqual(["登录", "确认"]);
    expect(res.pace).toEqual({ between_steps_ms: 60, between_actions_ms: 0 });
    expect(elapsed).toBeGreaterThanOrEqual(80);        // 两个步间等待（只少不多，容忍调度）
    expect(appReportMarkdown(res)).toContain("人工步骤");
  });

  it("人放弃 = 未完成（ok=false），报告写明原因，不会假装通过", async () => {
    const p = pack([manualStep({ desc: "登录" })]);
    const res = await runApp(p, runOpts(p, { manualHandler: () => false }) as never);
    expect(res.ok).toBe(false);
    expect(res.completed).toBe("0/1");
    expect(res.manual_steps).toEqual([
      expect.objectContaining({ done: false, reason: "declined" }),
    ]);
    const md = appReportMarkdown(res);
    expect(md).toContain("未完成");
    expect(md).toContain("declined");
  });

  it("有 start_url：先导航；人完成后 DOM 信号由引擎再验（不冒充人自证）", async () => {
    const state = { url: "about:blank" };
    const fakePage = {
      url: () => state.url,
      goto: async (u: string) => { state.url = u; },
      title: async () => "login",
      locator: () => { throw new Error("not needed for url_contains"); },
    };
    const fakeSession = {
      page: fakePage, pw: {}, browser: { close: async () => {} }, close: async () => {},
    } as never;
    const p = pack([manualStep({
      start_url: "https://login.example/signin",
      signal: { url_contains: "/home" },
    })]);
    (p as { hosts?: string[] }).hosts = ["login.example"];
    const res = await runApp(p, runOpts(p, {
      sessionFactory: async () => fakeSession,
      manualHandler: async () => { state.url = "https://login.example/home"; return true; },
    }) as never);
    expect(res.ok).toBe(true);
    expect(res.manual_steps?.[0]).toMatchObject({ done: true, attested: false });

    const deniedPack = pack([manualStep({
      start_url: "https://login.example/signin",
      signal: { url_contains: "/home" },
    })]);
    (deniedPack as { hosts?: string[] }).hosts = ["other.example"];
    const denied = await runApp(deniedPack, runOpts(deniedPack, {
      sessionFactory: async () => fakeSession,
      manualHandler: () => true,
    }) as never);
    expect(denied.ok).toBe(false);
    expect(denied.manual_steps?.[0]?.reason).toMatch(/host_not_allowed/);
  });

  it("DOM 信号但没有页面可验 -> 结构化未完成，不静默算绿", async () => {
    const p = pack([manualStep({ signal: { url_contains: "done" } })]);
    const res = await runApp(p, runOpts(p, { manualHandler: () => true }) as never);
    expect(res.ok).toBe(false);
    expect(res.manual_steps?.[0]).toMatchObject({ done: false });
    expect(res.manual_steps?.[0]?.reason).toMatch(/needs a page/);
  });
});

describe("运行节奏（pace）解析与配置校验", () => {
  it("本次显式 > pack > 环境变量 > 0", () => {
    const p = pack([], { between_steps_ms: 30, between_actions_ms: 40 });
    expect(resolvePace(p, { pace: { between_steps_ms: 10 } }, {
      AMBERFLOW_STEP_DELAY_MS: "100", AMBERFLOW_ACTION_DELAY_MS: "200",
    })).toEqual({ between_steps_ms: 10, between_actions_ms: 40 });
    expect(resolvePace(p, {}, { AMBERFLOW_STEP_DELAY_MS: "100" }))
      .toEqual({ between_steps_ms: 30, between_actions_ms: 40 });
    expect(resolvePace(pack([]), {}, { AMBERFLOW_STEP_DELAY_MS: "7" }))
      .toEqual({ between_steps_ms: 7, between_actions_ms: 0 });
  });

  it("坏环境值 = 配置类错误（不是静默当 0）", () => {
    expect(() => resolvePace(pack([]), {}, { AMBERFLOW_STEP_DELAY_MS: "-1" }))
      .toThrow(AppRunConfigError);
    expect(() => resolvePace(pack([]), {}, { AMBERFLOW_STEP_DELAY_MS: "abc" }))
      .toThrow(AppRunConfigError);
    expect(() => resolvePace(pack([]), {}, { AMBERFLOW_STEP_DELAY_MS: "60001" }))
      .toThrow(AppRunConfigError);
  });

  it("pack 的 pace 在加载期校验（未知键/负数/非整数）", () => {
    expect(validatePack(pack([manualStep()], { between_steps_ms: 10, between_actions_ms: 0 }))).toEqual([]);
    expect(validatePack({ ...pack([manualStep()]), pace: { jitter_ms: 1 } } as never))
      .toEqual(expect.arrayContaining([expect.stringMatching(/pace\.jitter_ms: unknown key/)]));
    expect(validatePack({ ...pack([manualStep()]), pace: { between_steps_ms: -1 } } as never))
      .toEqual(expect.arrayContaining([expect.stringMatching(/0\.\.60000/)]));
    expect(validatePack({ ...pack([manualStep()]), pace: { between_steps_ms: 1.5 } } as never))
      .toEqual(expect.arrayContaining([expect.stringMatching(/0\.\.60000/)]));
  });

  it("非 TTY 且没有注入 handler 时，人工步不会假装有人在", async () => {
    if (process.stdin.isTTY) return;                       // 本地真实终端里跳过（CI/测试通常非 TTY）
    const p = pack([manualStep()]);
    const res = await runApp(p, runOpts(p) as never);
    expect(res.ok).toBe(false);
    expect(res.manual_steps?.[0]?.reason).toMatch(/interactive terminal/);
  });
});
