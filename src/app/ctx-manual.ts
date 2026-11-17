/**
 * createCtx 的人工步原语：TTY 提示/嵌入方 manualRunner 接入、信号复核、非交互 needs_human 短路。
 *
 * 红线保持：人工步不自动过；非 TTY 不假装有人（manualFailFast 时立即结构化返回）。
 */
import { urlOf } from "../engine/extraction.ts";
import type { PageLike } from "../engine/extraction.ts";
import { checkSignal, signalHasFrameSuffix } from "../engine/signals.ts";
import { pushEvent } from "./trace.ts";
import { StopError } from "./ctx-types.ts";
import type { StepResult, Ctx } from "./ctx-types.ts";
import { isObj } from "./ctx-validate.ts";
import type { CtxRuntime } from "./ctx-runtime.ts";

export function createCtxManual(rt: CtxRuntime): Pick<Ctx, "manual"> {
    const { deps, trace, budget, hosts, pageState, assertOpen, checkBudget, paceBeforeStep } = rt;

return {
    manual: async (desc, req) => {
      assertOpen(`ctx.manual(${JSON.stringify(desc)})`);
      if (req === null || typeof req !== "object" || req.done === undefined || req.done === null) {
        throw new StopError("config_error", "ctx.manual: done signal is required");
      }
      if (deps.manualFailFast === true) {
        const stopCode = "needs_human";
        const reason = "manual step needs a human; --manual-fail-fast is set";
        // 影子旁路（§8 步 2）：旧路径权威——只记录，不改下方任何语句。
        deps.rescueShadow?.noteShadow({
          desc, id: req.id, instructions: typeof req.instructions === "string" ? req.instructions : "",
          pageUrl: rt.currentUrl, computed: { status: "unavailable", by: "fail-fast" }, legacyStopCode: stopCode,
        });
        pushEvent(trace, {
          call: "manual", desc, ...(req.id === undefined ? {} : { id: req.id }),
          url: rt.currentUrl, ok: false, stop_code: stopCode,
          result: { needs_human: true, reason },
        });
        return {
          ok: false, ...(req.id === undefined ? {} : { id: req.id }), stopCode, reason,
          evidence: { url: rt.currentUrl, attempts: 0, elapsedMs: 0 },
        };
      }
      if (deps.manualRunner === undefined) {
        if (!process.stdin.isTTY) {
          const stopCode = "needs_human";
          const reason = "manual step needs an interactive terminal (non-TTY)";
          // 影子旁路（§8 步 2）：旧路径权威——只记录，不改下方任何语句。
          deps.rescueShadow?.noteShadow({
            desc, id: req.id, instructions: typeof req.instructions === "string" ? req.instructions : "",
            pageUrl: rt.currentUrl, computed: { status: "unavailable", by: "none" }, legacyStopCode: stopCode,
          });
          pushEvent(trace, {
            call: "manual", desc, ...(req.id === undefined ? {} : { id: req.id }),
            url: rt.currentUrl, ok: false, stop_code: stopCode,
            result: { needs_human: true, reason },
          });
          return {
            ok: false, ...(req.id === undefined ? {} : { id: req.id }),
            stopCode, reason,
            evidence: { url: rt.currentUrl, attempts: 0, elapsedMs: 0 },
          };
        }
        throw new StopError("config_error", "ctx.manual: no manual runner wired in this build");
      }
      checkBudget();
      await paceBeforeStep();
      const started = Date.now();
      const session = await deps.ensureSession();
      const pageUrl = urlOf(session.page) || rt.currentUrl;
      if (pageUrl) pageState.update(session.page as unknown as PageLike, "interactive");
      let approved = false;
      try {
        approved = await deps.manualRunner({
          desc,
          instructions: typeof req.instructions === "string" ? req.instructions : "",
          url: pageUrl,
        });
      } catch (e) {
        const reason = `manual handler failed: ${e instanceof Error ? e.message : String(e)}`;
        // 影子旁路（§8 步 2）：旧路径权威——只记录，不改下方任何语句。
        deps.rescueShadow?.noteShadow({
          desc, id: req.id, instructions: typeof req.instructions === "string" ? req.instructions : "",
          pageUrl, computed: { status: "unavailable", by: "handler" }, legacyStopCode: "manual_handler_error",
        });
        pushEvent(trace, {
          call: "manual", desc, ...(req.id === undefined ? {} : { id: req.id }),
          url: pageUrl, ok: false, stop_code: "manual_handler_error", result: { reason },
        });
        return {
          ok: false, ...(req.id === undefined ? {} : { id: req.id }),
          stopCode: "manual_handler_error", reason,
          evidence: { url: pageUrl, attempts: 0, elapsedMs: Date.now() - started },
        };
      }
      budget.stepsUsed += 1;
      const manualLeaf = isObj(req.done) && Object.prototype.hasOwnProperty.call(req.done, "manual");
      let ok = approved;
      let stopCode: string | undefined = approved ? undefined : "manual_declined";
      let reason: string | undefined = approved ? undefined : "human declined the manual step";
      if (approved) {
        if (!manualLeaf) {
          try {
            // E4：人工复核信号带合法 ` frame:` 尾缀时按信封求值（同 arrive 口径——声明帧不在
            // 信封 = 不成立；无尾缀 = 既有无 hosts 口径逐字节不变）。
            ok = await checkSignal(session.page as never, req.done as never,
              signalHasFrameSuffix(req.done) ? ({ hosts } as never) : undefined);
          } catch (e) {
            throw new StopError("config_error", `ctx.manual(${JSON.stringify(desc)}) signal: ${e instanceof Error ? e.message : String(e)}`);
          }
          if (!ok) {
            stopCode = "manual_signal_not_held";
            reason = "human confirmed, but the declared DOM signal is not held";
          }
        }
      }
      const result: StepResult = {
        ok,
        ...(req.id === undefined ? {} : { id: req.id }),
        ...(stopCode === undefined ? {} : { stopCode }),
        ...(reason === undefined ? {} : { reason }),
        evidence: { url: pageUrl, attempts: 1, elapsedMs: Date.now() - started },
      };
      // 影子旁路（§8 步 2）：approved 判定后按三种结局各记一次（declined/fulfilled/signal_not_held）；
      // 旧路径权威——只记录，不改下方任何语句。by 与顺序链同口径：显式 handler > TTY。
      {
        const shadowBy = deps.manualRunner !== undefined ? "handler" : "tty";
        if (!approved) {
          deps.rescueShadow?.noteShadow({
            desc, id: req.id, instructions: typeof req.instructions === "string" ? req.instructions : "",
            pageUrl, computed: { status: "declined", by: shadowBy }, legacyStopCode: "manual_declined",
          });
        } else if (stopCode === "manual_signal_not_held") {
          // 信号复核不过：计算值仍是 fulfilled，legacy_stop_code 表达「旧路径停 manual_signal_not_held」。
          deps.rescueShadow?.noteShadow({
            desc, id: req.id, instructions: typeof req.instructions === "string" ? req.instructions : "",
            pageUrl, computed: { status: "fulfilled", by: shadowBy }, legacyStopCode: "manual_signal_not_held",
          });
        } else {
          // approved 且信号成立/manualLeaf：计算值 fulfilled，无 legacy 停因（省略不硬造）。
          deps.rescueShadow?.noteShadow({
            desc, id: req.id, instructions: typeof req.instructions === "string" ? req.instructions : "",
            pageUrl, computed: { status: "fulfilled", by: shadowBy },
          });
        }
      }
      pushEvent(trace, {
        call: "manual", desc, ...(req.id === undefined ? {} : { id: req.id }),
        url: pageUrl, ok,
        ...(stopCode === undefined ? {} : { stop_code: stopCode }),
        result: { approved, attested: manualLeaf, ...(reason === undefined ? {} : { reason }) },
      });
      return result;
    },
  };
}
