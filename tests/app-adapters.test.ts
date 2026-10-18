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
  sshReady, type AppAdapter,
} from "../src/app-adapters.ts";
import { unavailableAdapters } from "../tools/apps_suite.ts";

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
    expect(listAppAdapters()).toEqual(["cli", "ssh", "web"]);
    expect(getAppAdapter("web")!.legacyKind).toBe("browser");
    expect(getAppAdapter("cli")!.legacyKind).toBe("tool");
    expect(() => requireAppAdapter("telnet")).toThrow(/未知的应用支持器.*telnet.*cli, ssh, web/);
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

/* --------------------------------------------- Slice 2：ssh 声明面与能力探测 */

describe("⑤ssh 支持器：声明面（加载期）", () => {
  const sshStep = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "remote", desc: "在远端读一次", adapter: "ssh",
    ssh: { host: "localhost", argv: ["cat", "/tmp/x"] },
    signal: { exit_ok: true }, ...over,
  });

  it("合法 ssh 步通过校验并展开出 ssh 声明；事件族信号（exit/stdout）可用", () => {
    const pack = demo();
    pack.journey = [sshStep(), ...pack.journey.slice(1)];
    expect(validatePack(pack as AppPack).filter((x) => x.includes("ssh"))).toEqual([]);
    const exp = expandPack(pack as AppPack, {}, ":memory:");
    const step = exp.steps[0]!;
    expect(step).toMatchObject({ adapter: "ssh", kind: "tool" });
    expect((step.decl as { host: string }).host).toBe("localhost");
  });

  it("坏 ssh 块：缺 host/argv、未知键、port 越界 —— 全部加载期红", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ssh: { argv: ["true"] } }, "ssh.host"],
      [{ ssh: { host: "localhost" } }, "ssh.argv"],
      [{ ssh: { host: "localhost", argv: ["true"], bogus: 1 } }, "ssh.bogus: unknown key"],
      [{ ssh: { host: "localhost", argv: ["true"], port: 70000 } }, "ssh.port"],
    ];
    for (const [over, snippet] of cases) {
      const pack = demo();
      pack.journey = [sshStep(over), ...pack.journey.slice(1)];
      expect(validatePack(pack as AppPack).join(" | ")).toContain(snippet);
    }
  });

  it("ssh 没有本地文件面：file_* 信号加载期拒绝；dangerous 未实现也拒绝", () => {
    const pack1 = demo();
    pack1.journey = [sshStep({ signal: { file_exists: "/tmp/x" } }), ...pack1.journey.slice(1)];
    expect(validatePack(pack1 as AppPack).join(" | ")).toContain("ssh 步没有本地文件面");
    const pack2 = demo();
    pack2.journey = [sshStep({ dangerous: true }), ...pack2.journey.slice(1)];
    expect(validatePack(pack2 as AppPack).join(" | ")).toContain("ssh 的危险步/干跑语义尚未实现");
  });

  it("web 步声明 returns ⇒ 加载期红（DOM 抽取是 Slice 4）", () => {
    const pack = demo();
    pack.journey = [{ ...explicitWebStep(), returns: { x: { from: "stdout" } } }, ...pack.journey.slice(1)];
    expect(validatePack(pack as AppPack).join(" | ")).toContain("web 步的返回值抽取尚未实现");
  });

  it("能力探测返回布尔形状（本机可用性如实反映，不在 CI 猜测）", () => {
    const probe = sshReady();
    expect(typeof probe.ready).toBe("boolean");
    if (!probe.ready) expect(typeof probe.reason).toBe("string");
  });
});

describe("⑥能力闸：本机缺服务 ⇒ 套件如实跳过（跳过 ≠ 通过）", () => {
  it("适配器 ready() 不可用 ⇒ unavailableAdapters 给出类型 + 原因；可用 ⇒ 空", () => {
    const needService: AppAdapter = {
      ...fakeAdapter({ kind: "needsvc" }),
      ready: () => ({ ready: false, reason: "本机没有该服务" }),
    };
    registerAppAdapter(needService);
    const pack = demo();
    pack.journey = [{ id: "s", desc: "需要一个本机服务", signal: { exit_ok: true }, adapter: "needsvc", needsvc_cmd: "x" }];
    pack.invariants = [];
    const missing = unavailableAdapters(pack as AppPack);
    expect(missing).toEqual(["needsvc：本机没有该服务"]);

    const available: AppAdapter = { ...fakeAdapter({ kind: "avail" }), ready: () => ({ ready: true }) };
    registerAppAdapter(available);
    const pack2 = demo();
    pack2.journey = [{ id: "s", desc: "服务可用", signal: { exit_ok: true }, adapter: "avail", avail_cmd: "x" }];
    pack2.invariants = [];
    expect(unavailableAdapters(pack2 as AppPack)).toEqual([]);
  });

  it("内建的 ssh 能力探测与套件判定一致（同一处探测，不各写一套）", () => {
    const pack = demo();
    pack.journey = [{
      id: "ssh", desc: "ssh 步", adapter: "ssh",
      ssh: { host: "localhost", argv: ["true"] }, signal: { exit_ok: true },
    }];
    pack.invariants = [];
    const missing = unavailableAdapters(pack as AppPack);
    const probe = sshReady();
    expect(missing.length === 0).toBe(probe.ready);
  });
});
