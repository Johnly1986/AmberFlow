/**
 * 应用支持器（AppAdapter）层测试（docs/APP_SUPPORTER_DESIGN.md，Slice 1）。
 *
 * 钉子：
 *   ① 注册表：web/cli 内建；未知 id 响亮报错；**注册一个新类型 = 加一种应用**（不改核心分支）；
 *   ② 声明面：显式 `adapter` 优先于推断；每类型的专属键白名单（写别的类型的键加载期红，文案不变）；
 *   ③ 展开：`ExpandedStep` 带 `adapter` / `decl`（web = 子目标；cli = 进程声明）；
 *   ④ 执行分派：runner 按注册表调 `adapter.run`（web/cli 是迁移桥，委托 runner 的服务回调）。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  adapterKind, appStepKeys, expandPack, loadPack, stepKind, validatePack, type AppPack,
} from "../src/app-pack.ts";
import {
  getAppAdapter, listAppAdapters, registerAppAdapter, requireAppAdapter, resetAppAdapters,
  type AppAdapter,
} from "../src/app-adapters.ts";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const demo = (): any => clone(loadPack("demo-app")) as any;
const cli = (): any => clone(loadPack("cli-report")) as any;
/** demo-app 的 journey[0] 是工具步、journey[1] 才是角色（浏览器）步——本文件的 web 断言用它。 */
const webDemoStep = (): any => demo().journey[1];
/** 一个显式的 web 步（不靠角色/推断）。 */
const explicitWebStep = (): any => ({
  id: "open-explicit", desc: "打开页面", adapter: "web",
  start_url: "testpages/product.html", signal: { css_exists: "main" },
});

/** 最小假类型：只证明"注册一个适配器 = 多一种应用"，不模拟真实执行。 */
function fakeAdapter(opts: { kind?: string } = {}): AppAdapter {
  const kind = opts.kind ?? "fake";
  return {
    kind, legacyKind: "tool", label: kind,
    stepKeys: [`${kind}_cmd`],
    validateStep(step, where, p) {
      if (typeof step[`${kind}_cmd`] !== "string") p.push(`${where}: ${kind} needs ${kind}_cmd`);
    },
    expand(merged) {
      return { decl: { cmd: String(merged[`${kind}_cmd`]) } };
    },
    async run() { return { done: true }; },
  };
}

afterEach(() => resetAppAdapters());

describe("①注册表：一种应用类型 = 一个支持器", () => {
  it("内建 web/cli；未知 id 响亮报错并列出已知项（绝不静默退回）", () => {
    expect(listAppAdapters()).toEqual(["cli", "web"]);
    expect(getAppAdapter("web")!.legacyKind).toBe("browser");
    expect(getAppAdapter("cli")!.legacyKind).toBe("tool");
    expect(() => requireAppAdapter("telnet")).toThrow(/未知的应用支持器.*telnet.*cli, web/);
  });

  it("注册新类型后：步键立刻合法、包能通过校验并展开出 adapter/decl（不改 app-pack 分支）", () => {
    registerAppAdapter(fakeAdapter());
    expect(appStepKeys()).toContain("fake_cmd");
    const pack = demo();
    pack.journey = [{ id: "f", desc: "跑一个假类型步", signal: { exit_ok: true }, adapter: "fake", fake_cmd: "x" }];
    pack.invariants = [];
    expect(validatePack(pack as AppPack)).toEqual([]);
    const exp = expandPack(pack as AppPack, {}, ":memory:");
    expect(exp.steps[0]).toMatchObject({ adapter: "fake", kind: "tool" });
    expect(exp.steps[0]!.decl).toEqual({ cmd: "x" });
  });
});

describe("②声明面：显式 adapter 优先、推断向后兼容、专属键白名单", () => {
  it("推断：没有 source ⇒ web；有 source ⇒ cli（既有包一个字节不用改）", () => {
    expect(adapterKind(webDemoStep())).toBe("web");
    expect(adapterKind(demo().journey[0])).toBe("cli");
    expect(adapterKind(cli().journey[0])).toBe("cli");
    expect(stepKind(webDemoStep())).toBe("browser");
    expect(stepKind(cli().journey[0])).toBe("tool");
  });

  it("显式 adapter 优先：web 步写 adapter:cli 却没有 source ⇒ 该类型必需键报错", () => {
    const pack = demo();
    pack.journey = [
      { id: "cli-explicit", desc: "x", adapter: "cli", signal: { exit_ok: true } },
      ...pack.journey.slice(1),
    ];
    expect(validatePack(pack as AppPack).some((x) => x.includes("a cli step needs source"))).toBe(true);
  });

  it("未知 adapter ⇒ 加载期红并列出已知项", () => {
    const pack = demo();
    pack.journey = [
      { id: "telnet-step", desc: "x", adapter: "telnet", signal: { exit_ok: true } },
      ...pack.journey.slice(1),
    ];
    const problems = validatePack(pack as AppPack);
    expect(problems.some((x) => x.includes('unknown app adapter "telnet"') && x.includes("web"))).toBe(true);
  });

  it("写别的类型的专属键 ⇒ 红并点名归属（browser/tool 的既有文案不变）", () => {
    const webPack = demo();
    webPack.journey = [
      { ...explicitWebStep(), source: "git-log" },   // web 步写 cli 的键
      ...webPack.journey.slice(1),
    ];
    expect(validatePack(webPack as AppPack).some((x) => x.includes("tool-only key on a browser step"))).toBe(true);

    const cliPack = cli();
    cliPack.journey = [
      { ...cliPack.journey[0], adapter: "cli", start_url: "https://example.com/x" },  // cli 步写 web 的键
      ...cliPack.journey.slice(1),
    ];
    expect(validatePack(cliPack as AppPack).some((x) => x.includes("browser-only key on a tool step"))).toBe(true);
  });

  it("新类型的专属键写进 web 步 ⇒ 点名归属（动态键集，不用改核心）", () => {
    registerAppAdapter(fakeAdapter({ kind: "game" }));
    const pack = demo();
    pack.journey = [
      { ...explicitWebStep(), game_cmd: "x" },
      ...pack.journey.slice(1),
    ];
    expect(validatePack(pack as AppPack).some((x) => x.includes("game-only key on a browser step"))).toBe(true);
  });
});

describe("③展开：ExpandedStep 带 adapter + decl（既有字段保持兼容）", () => {
  it("web 步：adapter=web、decl=子目标、kind=browser", () => {
    const exp = expandPack(loadPack("demo-app"), {}, ":memory:");
    const web = exp.steps.filter((s) => s.adapter === "web");
    expect(web.length).toBeGreaterThan(0);
    expect(web[0]!.kind).toBe("browser");
    expect(web[0]!.subgoal).toBeDefined();
    expect(web[0]!.decl).toBe(web[0]!.subgoal);
  });

  it("cli 步：adapter=cli、decl=进程声明、kind=tool", () => {
    const exp = expandPack(loadPack("cli-report"), {}, ":memory:");
    const cliStep = exp.steps.find((s) => s.adapter === "cli")!;
    expect(cliStep).toBeDefined();
    expect(cliStep.kind).toBe("tool");
    expect(cliStep.decl).toBe(cliStep.tool);
    expect((cliStep.decl as { source: string }).source).toBeTruthy();
  });
});

describe("④执行分派：adapter.run（迁移桥委托 runner 服务；新类型可原生实现）", () => {
  it("web/cli 适配器各自委托对应服务回调，并把结果带回", async () => {
    const calls: string[] = [];
    const ctx = {
      outDir: "/tmp", verbose: false,
      runWebStep: async () => { calls.push("web"); return { done: true }; },
      runCliStep: async () => {
        calls.push("cli");
        return {
          index: 0, desc: "d", source: "s", signal: {}, argv: [], attempts: 1,
          done: true, dry_run: null, code: 0, ok: true, stdout: "", stderr: "",
        };
      },
    };
    const web = getAppAdapter("web")!;
    const cliA = getAppAdapter("cli")!;
    const webOut = await web.run(undefined, {} as never, ctx as never);
    const cliOut = await cliA.run(undefined, {} as never, ctx as never);
    expect(webOut).toEqual({ done: true });
    expect(cliOut.done).toBe(true);
    expect(cliOut.tool).toMatchObject({ done: true, code: 0 });
    expect(calls).toEqual(["web", "cli"]);
  });
});
