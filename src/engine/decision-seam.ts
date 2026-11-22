/**
 * S5 决策面装配 seam（从执行器 `ready()` 拆出）：一个执行器在首次模型面调用前只经本函数
 * 解析自己要用的决策提供者（装配面唯一出处）。
 *
 * 三档（行为冻结）：
 *   ① 显式装了 provider ⇒ 直接用它（换模型测试/在线服务），不要求 laya runtime 存在；
 *   ② 否则取 legacy `LayaRuntime`，经注入的 `decisionRuntime.layaProvider` 包一层 ⇒ 逐字段等价；
 *   ③ 没有注入面/没有 runtime ⇒ rules-only（规则面照跑，需要选点的步按规则面如实 block）。
 *
 * 输入只有执行器实例（它持有注入契约与 checkpoint/路由相关字段）；本模块不 import app 层。
 */
import { LayaNotConfiguredError, getLayaRuntime, type LayaRuntime } from "../model/model.ts";
import { routerMaxLoaded } from "./executor-pure.ts";
import type { BrowserMiddleware } from "./executor.ts";

export async function assembleDecisionRuntime(mw: BrowserMiddleware): Promise<void> {
    // **决策提供者层的入口**（装配面：组合根注入 `decisionRuntime`，执行器不 import 实现）：
    //   ① 显式装了 provider（换模型测试走这条）⇒ 直接用它，不要求 laya runtime 存在；
    //   ② 否则走 legacy 门：装了 `LayaRuntime` 就经注入的适配器包一层 ⇒ 逐字段等价；
    //   ③ 两者都没有 ⇒ rules-only（本地模型不在位 = 规则面照跑，需要选点的步如实 block）。
    if (mw.decisionRuntime === null) {
      // 没有组合根注入 = 没有可用的 provider 装配面：与"本地 runtime 不在位"同一档，
      // 如实进 rules-only（`buildMiddleware` 为所有入口注入缺省实现）。
      mw.rulesOnly = true;
      mw.rulesOnlyReason = "decision runtime not injected (construct the executor via buildMiddleware)";
      mw._ready = true;
      return;
    }
    const explicit = mw.decisionRuntime.providerOrNull();
    if (explicit) {
      mw.decision = explicit;
      mw._ready = true;
      return;
    }
    let rt: LayaRuntime;
    try {
      rt = getLayaRuntime();
    } catch (err) {
      if (!(err instanceof LayaNotConfiguredError)) throw err;
      // RULES-ONLY MODE. A frozen plan that NAMES its targets needs no model at all, so an
      // unconfigured runtime must not abort the whole run: the steps that rules/hints can
      // decide are executed, and a step that genuinely needs a pick blocks with this reason.
      // (Measured need: `npm start` on a fresh checkout has no ONNX artifacts and blocked
      //  immediately, which also made the doctor's "规则模式也能跑" claim false.)
      mw.rulesOnly = true;
      mw.rulesOnlyReason = (err as Error).message;
      mw._ready = true;
      return;
    }
    if (mw.agent === null) {
      try {
        mw.agent = typeof mw.modelId === "string" ? await rt.load(mw.modelId) : mw.modelId;
      } catch (e) {
        // CONFIG error (bad artifact path etc.): rules cannot stand in for a model
        // the operator explicitly pointed at — refuse to act, and say so once.
        mw.configError = e instanceof Error ? e.message : String(e);
        mw._ready = true;
        return;
      }
    }
    mw.embedFn = rt.embedFnFromAgent(mw.agent);
    if (mw.routeModels) {
      if (mw.router === null) {
        mw.router = rt.createRouter ? rt.createRouter({ maxLoaded: routerMaxLoaded() }) : null;
      }
      // The default checkpoint was just built: hand THAT agent to the router
      // instead of letting it build a second copy (Router.attach exists for
      // exactly this). Without it a 3 GB box would hold two.
      try {
        if (mw.router) {
          if (mw.router.attach && mw.router.default && mw.agent) {
            mw.router.attach(mw.router.default, mw.agent);
          }
          mw._routedModel = mw.router.default ?? null;
        }
      } catch {
        /* routing is an optimization, not a dependency */
      }
    }
    mw.decision = mw.decisionRuntime.layaProvider({
      runtime: rt,
      agentFor: (st) => mw.agentFor(st),
      name: `laya-onnx`, version: mw.modelId === undefined ? "default" : String(mw.modelId),
      capabilities: {
        choice: true, risk: true, done: true, shortlist: true, score_kind: "entropy_conf",
        // DC4：本地 laya 档只消费 L0–L2（与 `layaProvider` 缺省同值）。
        context: "minimal",
      },
    });
    mw._ready = true;
}
