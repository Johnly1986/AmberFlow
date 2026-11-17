/**
 * createCtx 的滚动作战原语：scrollList / expand / setRange（每个原语整体计 1 个 flow step）。
 *
 * 容器定位与滑动/展开/设值策略保持原实现；共享页面/状态访问经 CtxRuntime。
 */
import { pushEvent } from "./trace.ts";
import { sleepMs } from "../support/sleep.ts";
import { StopError } from "./ctx-types.ts";
import type { ScrollListResult, ExpandResult, SetRangeResult, Ctx } from "./ctx-types.ts";
import { isSyntheticScrollTarget, validateScrollListRequest, validateExpandRequest, validateSetRangeRequest } from "./ctx-validate.ts";
import type { CtxRuntime } from "./ctx-runtime.ts";

export function createCtxScroll(rt: CtxRuntime): Pick<Ctx, "scrollList" | "expand" | "setRange"> {
    const { deps, trace, budget, pageState, assertOpen, page, checkBudget, paceBeforeStep } = rt;

return {
    // ---- A3 列表/范围原语：各计 1 flow step；内部 click/滚动不占预算（由 maxClicks/timeoutMs 兜底）----
    scrollList: async (target, opts = {}) => {
      validateScrollListRequest(target, opts);
      assertOpen("ctx.scrollList");
      checkBudget();
      await paceBeforeStep();
      const p = await page();
      budget.stepsUsed += 1;
      // F1：合成滚动目标（"document"/"body"/"html"/"window"，大小写不敏感）不进池、
      // 不做 hint 匹配——直接解析主滚动器执行同一套滚动语义；其余目标走既有容器路径
      // （池外回退 + 最近可滚动祖先），行为逐字节不变。
      const r = isSyntheticScrollTarget(target)
        ? await deps.mw().scrollDocument(
          p as never, opts.to ?? "bottom",
          { ...(opts.by === undefined ? {} : { by: opts.by }), ...(opts.settleMs === undefined ? {} : { settleMs: opts.settleMs }) },
        )
        : await deps.mw().scrollContainer(
          p as never, target, opts.to ?? "bottom",
          { ...(opts.by === undefined ? {} : { by: opts.by }), ...(opts.settleMs === undefined ? {} : { settleMs: opts.settleMs }) },
        );
      const result: ScrollListResult = {
        ok: r.ok,
        ...(r.scrollTop === undefined ? {} : { scrollTop: r.scrollTop }),
        ...(r.scrollHeight === undefined ? {} : { scrollHeight: r.scrollHeight }),
        ...(r.clientHeight === undefined ? {} : { clientHeight: r.clientHeight }),
        ...(r.moved === undefined ? {} : { moved: r.moved }),
        ...(r.stopCode === undefined ? {} : { stopCode: r.stopCode }),
        ...(r.reason === undefined ? {} : { reason: r.reason }),
      };
      pushEvent(trace, {
        call: "scrollList", desc: target, ok: result.ok,
        args: { target, opts },
        ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
        result,
      });
      try { pageState.update(p, "interactive"); } catch { /* 记录面让位事实 */ }
      return result;
    },
    expand: async (target, opts) => {
      validateExpandRequest(target, opts);
      assertOpen("ctx.expand");
      checkBudget();
      await paceBeforeStep();
      const p = await page();
      budget.stepsUsed += 1;
      // 行数只用 rows/selector 计数（`count.fields` 仅形状校验，不参与 expand 判定）：直接 DOM 计数
      // 而不走 ctx.read/extract——内部观察不应写成独立 trace 事件（否则 replay 要额外消费，
      // extract 还有 maxItems 截断）。coverage.rows = 最终 DOM 行数。
      const rowSelector = "rows" in opts.count ? opts.count.rows : opts.count.selector;
      const maxClicks = opts.maxClicks ?? 20;
      const stableRounds = opts.stableRounds ?? 2;
      const settleMs = opts.settleMs ?? 800;
      const timeoutMs = opts.timeoutMs ?? 60_000;
      const started = Date.now();
      const countRows = async (): Promise<number> => {
        try {
          const n = await p.evaluate!((sel: string) => {
            const g = globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } };
            return g.document.querySelectorAll(sel).length;
          }, rowSelector);
          return Number(n) || 0;
        } catch (e) {
          throw new StopError("config_error",
            `ctx.expand: row selector ${JSON.stringify(rowSelector)} is invalid (${e instanceof Error ? e.message : String(e)})`);
        }
      };
      const before = await countRows();
      let after = before;
      let clicks = 0;
      let grew = false;
      let stable = false;
      let stableCount = 0;
      let stopCode: string | undefined;
      let reason: string | undefined;
      let clickFailures = 0;
      let lastClickError: string | undefined;
      const mw = deps.mw();
      while (clicks < maxClicks && Date.now() - started < timeoutMs) {
        const act = await mw.actOnce(p as never, target, "click");
        clicks += 1;
        // 点击失败不立即判死：真站的"展开更多"在**到达展开上限**后会变成不可点
        //（Maps See more 实测：行数稳定后按钮仍在、但点击 timeout）。此时以"行数
        // 是否还在长"为准——等一拍重读，长出来的算异步到达，连续 stableRounds 轮
        // 不再长才算稳定（plateau 是这次调用的目标，grew/clicks 仍如实暴露）。
        if (!act.ok) {
          clickFailures += 1;
          lastClickError = act.reason ?? act.stopCode ?? "click failed";
        }
        if (settleMs > 0) await sleepMs(settleMs);
        const now = await countRows();
        if (now > after) { grew = true; stableCount = 0; } else { stableCount += 1; }
        after = now;
        if (stableCount >= stableRounds) { stable = true; break; }
      }
      if (!stable && stopCode === undefined) {
        stopCode = "expand_not_stable";
        reason = `stopped after ${clicks} click(s)/${Date.now() - started}ms without ${stableRounds} consecutive stable round(s) `
          + `(maxClicks=${maxClicks}, timeoutMs=${timeoutMs}, rows=${after})`
          + (clickFailures ? `; ${clickFailures} click(s) failed (last: ${lastClickError ?? "-"})` : "");
      } else if (stable && clickFailures > 0) {
        // 稳定但有点击失败：说明到顶后控件不可点（不是本调用的失败，但必须可解释）。
        reason = `rows stabilized at ${after} after ${clicks} click(s); ${clickFailures} click(s) failed `
          + `(last: ${lastClickError ?? "-"}) — the expand control no longer accepts clicks`;
      }
      const result: ExpandResult = {
        ok: stable, clicks, before, after, grew, stable,
        coverage: { rows: after },
        ...(stopCode === undefined ? {} : { stopCode }),
        ...(reason === undefined ? {} : { reason }),
      };
      pushEvent(trace, {
        call: "expand", desc: target, ok: result.ok,
        args: { target, opts },
        ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
        result,
      });
      try { pageState.update(p, "interactive"); } catch { /* 记录面让位事实 */ }
      return result;
    },
    setRange: async (target, value, opts = {}) => {
      validateSetRangeRequest(target, value, opts);
      assertOpen("ctx.setRange");
      checkBudget();
      await paceBeforeStep();
      const p = await page();
      budget.stepsUsed += 1;
      const r = await deps.mw().setRange(p as never, target, value, opts);
      // S1 effect 读回：`applied`/`accurate` 只在开关开着时出现（缺省开）。
      const readback = deps.effectReadback?.set_range !== false;
      const result: SetRangeResult = {
        ok: r.ok,
        ...(r.achieved === undefined ? {} : { achieved: r.achieved }),
        ...(r.strategy === undefined ? {} : { strategy: r.strategy }),
        ...(r.stopCode === undefined ? {} : { stopCode: r.stopCode }),
        ...(r.reason === undefined ? {} : { reason: r.reason }),
        ...(!readback || r.applied === undefined ? {} : { applied: r.applied }),
        ...(!readback || r.accurate === undefined ? {} : { accurate: r.accurate }),
        ...(!readback || r.target === undefined ? {} : { target: r.target }),
        // task-21/1a：requested/clamped_from/probe 透传（越界拒绝与键盘 probe 的证据链；
        // SetRangeResult 类型同步扩展）。
        ...(!readback || r.requested === undefined ? {} : { requested: r.requested }),
        ...(!readback || r.clamped_from === undefined ? {} : { clamped_from: r.clamped_from }),
        ...(!readback || r.probe === undefined ? {} : { probe: r.probe }),
      };
      pushEvent(trace, {
        call: "setRange", desc: target, ok: result.ok,
        args: { target, value, opts },
        ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
        result,
      });
      try { pageState.update(p, "interactive"); } catch { /* 记录面让位事实 */ }
      return result;
    },
  };
}
