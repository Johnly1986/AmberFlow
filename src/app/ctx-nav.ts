/**
 * createCtx 的导航与一步原语：open/openPage/arrive/tabs/switchTab/step（step 委托 ctx-step.runOneStep）。
 *
 * 导航纪律（hosts 信封 / entry-only 闸门）仍由 CtxRuntime.navigate 唯一实现。
 */
import { disallowedHost } from "../engine/executor.ts";
import { urlOf, poolSniff } from "../engine/extraction.ts";
import type { PageLike } from "../engine/extraction.ts";
import { admitSelectorWithJsFor } from "../engine/surface.ts";
import { THROTTLE_BODY_FLOOR, THROTTLE_COLLAPSE_RATIO } from "../engine/throttle-signature.ts";
import { checkSignal, signalHasFrameSuffix } from "../engine/signals.ts";
import { pushEvent } from "./trace.ts";
import { StopError } from "./ctx-types.ts";
import type { StepResult, TabInfo, Ctx } from "./ctx-types.ts";
import { isObj, assertAct, validateSwitchTabMatch, switchTabMatches, describeTabs } from "./ctx-validate.ts";
import type { CtxRuntime } from "./ctx-runtime.ts";
import { runOneStep } from "./ctx-step.ts";

export function createCtxNav(rt: CtxRuntime): Pick<Ctx, "open" | "openPage" | "arrive" | "tabs" | "switchTab" | "step"> {
    const { deps, pack, trace, budget, hosts, pageState, assertOpen, page, listTabs, bounded, checkBudget, paceBeforeStep, navigate } = rt;

return {
    open: async (u, o = {}) => { await navigate(u, "open", "ctx.open", o.timeoutMs); },
    openPage: async (role) => {
      if (typeof role !== "string" || !role.trim()) {
        throw new StopError("config_error", "ctx.openPage: role must be a non-empty string");
      }
      const pages = (pack.site?.pages ?? {}) as Record<string, string>;
      const url = pages[role];
      if (typeof url !== "string" || !url.trim()) {
        const known = Object.keys(pages);
        throw new StopError("config_error",
          `ctx.openPage(${JSON.stringify(role)}): no such page role in meta.site.pages`
          + ` (known: ${known.length ? known.join(", ") : "none declared"})${known.length ? "" : " — declare meta.site.pages or use ctx.open(url)"}`);
      }
      await navigate(url, "openPage", `ctx.openPage(${JSON.stringify(role)})`, undefined, role);
    },
    arrive: async (u, req) => {
      if (!isObj(req) || !isObj(req.done) || !Object.keys(req.done).length) {
        throw new StopError("config_error", "ctx.arrive: done signal is required");
      }
      checkBudget();
      await paceBeforeStep();
      const started = Date.now();
      const label = req.desc ?? `到达 ${u}`;
      // 纯导航：只 goto + 等信号，**不做元素选择、不花模型**（误走 step 路径会：
      // 记录成 step、还会因选不到元素而 no_model_runtime —— 三实现漂移，replay 必 mismatch）。
      await navigate(u, "arrive", label, req.timeoutMs, req.desc, false);
      const timeout = req.timeoutMs ?? 15_000;
      const deadline = Date.now() + timeout;
      let held = false;
      let waitErr: unknown;
      let hostViolation: string | null = null;
      // task-16（B3+）：in-arrive 塌缩读数——从首个非 held 轮次**之后**才开始（首个轮次即
      // held = 零新增读取），只留首/末两个读数（有界内存）。成功路径零新增。
      let seenNonHeld = false;
      let inArriveFirst: number | null = null;
      let inArriveLast: number | null = null;
      try {
        const p = await page();
        const pAny = p as unknown as { waitForTimeout?(ms: number): Promise<void>; evaluate(script: string): Promise<unknown> };
        do {
          const landed = urlOf(p);
          if (landed) {
            if (hosts && hosts.length && disallowedHost(landed, hosts)) { hostViolation = landed; break; }
            rt.currentUrl = landed;
            pageState.update(p as PageLike, "settled");
          }
          try {
            // E4：done 信号带合法 ` frame:` 尾缀时按信封求值（声明帧不在信封 = miss，与执行器
            // done/when 的 F45② 读面同口径；否则尾缀会让 E4 前必失败的串在无信封面上命中被排除帧）。
            // 无尾缀 = 既有无 hosts 口径逐字节不变。
            const arriveHosts = signalHasFrameSuffix(req.done) ? { hosts } : undefined;
            if (await checkSignal(p as never, req.done as never, arriveHosts as never)) { held = true; break; }
          } catch (e) { waitErr = e; break; }        // 坏信号 = 配置错误，别轮询到超时
          if (!seenNonHeld) seenNonHeld = true;
          else {
            try {
              const bl = Number(await pAny.evaluate("document.body ? document.body.innerText.length : 0"));
              if (Number.isFinite(bl)) {
                if (inArriveFirst === null) inArriveFirst = bl;
                inArriveLast = bl;
              }
            } catch { /* 观察让位事实 */ }
          }
          if (typeof pAny.waitForTimeout === "function") await pAny.waitForTimeout(200);
          else await new Promise((r) => setTimeout(r, 200));
        } while (Date.now() < deadline);
      } catch (e) { waitErr = e; }
      budget.stepsUsed += 1;
      const stopCode = held ? undefined : (hostViolation !== null ? "host_not_allowed" : "arrive_signal_not_held");
      const failReason = held ? undefined
        : hostViolation !== null
          ? `arrive: landed on ${JSON.stringify(hostViolation)} outside the declared hosts envelope (${hosts?.join(", ")})`
          : `arrive: navigation finished but done-signal never held within ${timeout}ms`
            + (waitErr instanceof Error ? ` (${waitErr.message})` : "");
      // 06-D：与 ctx.step 记录面同形——成功也留"到达依据"文案，嵌套 result 带 page_state；
      // 不为 arrive 伪造 method/hows（它没有决策流水，差异是语义不是缺陷）。
      // task-16（B3+）：arrive 失败路径的限速判据（与 B3 step 侧同构：峰值基线 + 骤降比例；
      // 成功路径零改动——held=true 不嗅探/无字段/无 warning）。基线 = executor 会话正文峰值
      // （B3 失败嗅探记账，零成功路径成本）。无峰值基线（本会话首个失败即 arrive）→ 如实
      // 不判：字段缺席，判读走 docs §10；该签名由知识层 site-facts 承载（两层分工）。
      let throttle: {
        evidence: {
          body_text: number; body_text_peak: number; ready_state: string;
          elapsed_ms: number; url: string; in_arrive_first?: number; in_arrive_last?: number;
        };
      } | null = null;
      if (!held && hostViolation === null && waitErr === undefined) {
        try {
          const p = await page();
          const s = await poolSniff(p as never, admitSelectorWithJsFor(deps.surfacePolicy));
          const peak = deps.mw().sessionBodyTextPeak();
          // task-24/6a：阈值单源化（throttle-signature.ts——step 侧与 arrive 侧共用）。
          const crossCollapse = peak >= THROTTLE_BODY_FLOOR
            && s.body_text * THROTTLE_COLLAPSE_RATIO <= peak;
          const inArriveCollapse = inArriveFirst !== null && inArriveFirst >= THROTTLE_BODY_FLOOR
            && inArriveLast !== null && inArriveLast * THROTTLE_COLLAPSE_RATIO <= inArriveFirst;
          if (crossCollapse || inArriveCollapse) {
            throttle = {
              evidence: {
                body_text: s.body_text,
                body_text_peak: peak,
                ready_state: String(s.ready_state ?? "unknown"),
                elapsed_ms: Date.now() - started,
                url: rt.currentUrl,
                ...(inArriveFirst !== null ? { in_arrive_first: inArriveFirst } : {}),
                ...(inArriveLast !== null ? { in_arrive_last: inArriveLast } : {}),
              },
            };
          }
        } catch { /* 观察让位事实 */ }
      }
      const reason = held ? "arrive signal held" : failReason;
      let arrivedState: ReturnType<typeof pageState.update> | null = null;
      if (held) {
        try { arrivedState = pageState.update((await page()) as PageLike, "settled"); } catch { /* 记录面让位事实 */ }
      }
      const result: StepResult = {
        ok: held,
        ...(req.id === undefined ? {} : { id: req.id }),
        ...(stopCode === undefined ? {} : { stopCode }),
        ...(reason === undefined ? {} : { reason }),
        // task-16（B3+）：限速判据留痕（仅组合判据命中时出现；不新增 stopCode）。
        ...(throttle !== null ? { diagnostics: { throttle_suspect: throttle } } : {}),
        ...(throttle !== null ? {
          warnings: [`throttle_suspect: arrive 信号不成立且观测到正文塌缩`
            + `（峰值 ${throttle.evidence.body_text_peak} → 当前 ${throttle.evidence.body_text}）`
            + "——疑似站点限速/降频/风控分批。已知处置：冷却后重试、降频（拉大 meta.pace）、分批跑，"
            + "不绕过反爬；证据见 diagnostics.throttle_suspect"],
        } : {}),
        evidence: { url: rt.currentUrl, attempts: 1, elapsedMs: Date.now() - started },
      };
      pushEvent(trace, {
        call: "arrive", desc: req.desc ?? label, url: rt.currentUrl, ok: held,
        ...(req.id === undefined ? {} : { id: req.id }),
        ...(stopCode === undefined ? {} : { stop_code: stopCode }),
        result: { ok: held, ...(stopCode === undefined ? {} : { stop_code: stopCode }),
          ...(reason === undefined ? {} : { reason }), elapsed_ms: result.evidence.elapsedMs,
          ...(throttle !== null ? { diagnostics: { throttle_suspect: throttle } } : {}),
          ...(arrivedState === null ? {} : {
            page_state: {
              page_id: arrivedState.pageId,
              readiness: arrivedState.readiness,
              pool_version: arrivedState.poolVersion,
              frame_origins: arrivedState.frameOrigins,
            },
          }) },
      });
      return result;
    },
    // ---- A5 标签页：tabs() 免费只读；switchTab 计 1 flow step 且走 pace（与 step/arrive 同单元语义）----
    tabs: async () => {
      const session = await deps.ensureSession();
      const listed = await listTabs(session);
      const view: TabInfo[] = listed.map(({ index, url, title, active }) => ({ index, url, title, active }));
      pushEvent(trace, { call: "tab", desc: "tabs()", action: "list", pages: view, ok: true });
      return view;
    },
    switchTab: async (match) => {
      assertOpen("ctx.switchTab");
      validateSwitchTabMatch(match);
      checkBudget();
      await paceBeforeStep();
      const started = Date.now();
      const session = await deps.ensureSession();
      const before = urlOf(session.page as unknown as PageLike) || rt.currentUrl;
      const listed = await listTabs(session);
      const matched = listed.filter((t) => switchTabMatches(t, match));
      if (matched.length !== 1) {
        const why = matched.length === 0
          ? "no tab matches"
          : `${matched.length} tabs match`;
        throw new StopError("config_error",
          `ctx.switchTab: ${why} ${JSON.stringify(match)} — expected exactly 1; current tabs: ${describeTabs(listed)}`
          + " (use ctx.tabs() to inspect; no implicit fallback to an arbitrary tab)");
      }
      const target = matched[0]!;
      // 导航信封：列表可以只读看到信封外页面，切过去不行（与 open/openPage 同一判定）。
      if (hosts && hosts.length && disallowedHost(target.url, hosts) !== null) {
        throw new StopError("host_not_allowed",
          `ctx.switchTab: ${JSON.stringify(target.url)} is outside the declared hosts envelope (${hosts.join(", ")})`
          + " — the tab was not activated");
      }
      session.page = target.page as unknown as typeof session.page;
      rt.currentUrl = target.url;
      // Playwright 成熟做法：置前 + 有界等 domcontentloaded；两者失败都不致命（切页已是事实）。
      await bounded(() => target.page.bringToFront?.(), 2000);
      await bounded(() => target.page.waitForLoadState?.("domcontentloaded", { timeout: 5000 }), 5000);
      budget.stepsUsed += 1;
      try { pageState.update(target.page, "settled"); } catch { /* 记录面让位事实 */ }
      pushEvent(trace, {
        call: "tab", desc: `switchTab(${JSON.stringify(match)})`, action: "switch",
        from: { url: before },
        to: { index: target.index, url: target.url, title: target.title },
        pages: listed.length,
        args: match,
        ok: true,
        result: {
          index: target.index, url: target.url, title: target.title,
          elapsed_ms: Date.now() - started,
        },
      });
      return { ok: true as const, index: target.index, url: target.url, title: target.title };
    },
    step: async (desc, req) => {
      assertAct(req);
      return runOneStep(rt, desc, { ...req, when: req.when ?? null });
    },
  };
}
