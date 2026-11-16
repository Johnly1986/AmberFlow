/**
 * 执行器唯一构造点 —— `buildMiddleware` 工厂。
 *
 * 为什么要有这一层：`BrowserMiddleware` 的构造散在各入口，同一个 `MiddlewareOptions` 字段
 * 在某个入口漏接，就变成「这个入口不支持该 policy」且没有单点可审。本工厂只做两件事：
 *   1. 构造执行器（全仓唯一 `new BrowserMiddleware(` 落点）；
 *   2. 把 per-face 的确认策略写进类型：face 与 `confirmPolicy.kind` 不匹配在构造期就红，
 *      不会因为某个入口少传 confirmFn 而悄悄落到另一个默认档。
 *
 * 不负责：决策源解析、`installLayaRuntime` / `applySpecToRuntime` 全局安装、run-scoped
 * provider 注入——那些属于各入口的装配前奏。工厂只接收**已解析**的 `MiddlewareOptions`，
 * 非 confirm 字段原样透传给执行器；`confirmFn` 只能经 `confirmPolicy` 声明。
 */
import { DESTRUCTIVE_PATTERNS } from "../engine/rules.ts";
import { BrowserMiddleware } from "../engine/executor.ts";
import type { MiddlewareOptions } from "../engine/executor-types.ts";

/** 执行器构造的调用面。新增 face 须同步登记到 `docs/MAINLINE.md` 的装配表。 */
export type MiddlewareFace =
  | "start"        // npm start：一次性目标（演示 → 归纳 → 执行）
  | "plan"         // plan-cli / amber plan run：计划文件执行
  | "online"       // 真实站点套件
  | "app-declared" // 声明式应用运行器
  | "app-script"   // flow 脚本应用运行器
  | "session";     // amber session 交互式 authoring

export type ConfirmFn = (desc: string) => boolean | Promise<boolean>;

/** 确认策略（必填且显式；face → kind 的对应关系见 `FACE_POLICY`）。 */
export type ConfirmPolicy =
  /** 全部放行。start / online 的既有语义；安全口径单独立项复核后再统一。 */
  | { kind: "allow-all" }
  /** 不注入 confirmFn，执行器用内置的缺省拒绝（`DEFAULT_CONFIRM`）。 */
  | { kind: "default-deny" }
  /**
   * app 两面：默认按关键词拒绝破坏性动作；`confirmSafe: false` 才全放行（风险只记录不阻断）。
   * 两个 app 面的方向必须一致（默认拒绝、unsafe 才放行），反接等于安全语义颠倒。
   */
  | { kind: "safe-browser"; confirmSafe: boolean }
  /** plan：confirm 语义由调用方决定（allow / deny / ask）；工厂只校验函数存在。 */
  | { kind: "caller"; confirmFn: ConfirmFn };

export interface BuildMiddlewareConfig {
  face: MiddlewareFace;
  confirmPolicy: ConfirmPolicy;
  /** 除 `confirmFn` 外的执行器选项，原样透传。 */
  options?: Omit<MiddlewareOptions, "confirmFn">;
}

/** face → 唯一合法的 `confirmPolicy.kind`（构造期校验的唯一出处）。 */
const FACE_POLICY: Readonly<Record<MiddlewareFace, ConfirmPolicy["kind"]>> = {
  start: "allow-all",
  plan: "caller",
  online: "allow-all",
  "app-declared": "safe-browser",
  "app-script": "safe-browser",
  session: "default-deny",
};

/** 关键词命中即视为破坏性动作（与执行器的风险关键词同一闭集）。 */
const denyDestructive: ConfirmFn = (desc) =>
  !DESTRUCTIVE_PATTERNS.some((x) => desc.toLowerCase().includes(x));

/** 按 `face` 校验并解析出该面的 confirmFn；`undefined` = 交给执行器的缺省拒绝。 */
function confirmFnFor(face: MiddlewareFace, policy: ConfirmPolicy): ConfirmFn | undefined {
  const expected = FACE_POLICY[face];
  if (policy.kind !== expected) {
    throw new Error(`buildMiddleware: face ${JSON.stringify(face)} 只接受 confirmPolicy.kind=${JSON.stringify(expected)}，`
      + `收到 ${JSON.stringify(policy.kind)}——确认策略必须按 face 显式声明`);
  }
  switch (policy.kind) {
    case "allow-all":
      return () => true;
    case "default-deny":
      return undefined;
    case "safe-browser":
      return policy.confirmSafe ? denyDestructive : () => true;
    case "caller": {
      if (typeof policy.confirmFn !== "function") {
        throw new Error('buildMiddleware: face "plan" 需要调用方提供 confirmFn');
      }
      return policy.confirmFn;
    }
  }
}

/**
 * 构造执行器。全仓唯一 `new BrowserMiddleware(` 落点：新入口不得自建，只能选 face + 策略。
 * @throws face 未知 / confirmPolicy.kind 与 face 不匹配 / options 里夹带 confirmFn 时。
 */
export function buildMiddleware(config: BuildMiddlewareConfig): BrowserMiddleware {
  const { face, confirmPolicy, options = {} } = config;
  if (!(face in FACE_POLICY)) {
    throw new Error(`buildMiddleware: 未知 face ${JSON.stringify(face)}（已登记：${Object.keys(FACE_POLICY).join(" / ")}）`);
  }
  if ((options as MiddlewareOptions).confirmFn !== undefined) {
    throw new Error("buildMiddleware: confirmFn 只能经 confirmPolicy 声明，不能放进 options");
  }
  const confirmFn = confirmFnFor(face, confirmPolicy);
  return new BrowserMiddleware({
    ...options,
    ...(confirmFn === undefined ? {} : { confirmFn }),
  });
}
