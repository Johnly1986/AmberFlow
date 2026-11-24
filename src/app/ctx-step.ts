/**
 * createCtx 的单步原语：一步声明 → 池/命令解析 → 动作 → done/停因 → StepResult 投影。
 *
 * 从 createCtx 闭包提取为显式 deps（首个参数 CtxRuntime）；本文件不持有运行期状态。
 */
import { disallowedHost } from "../engine/executor.ts";
import type { RunReport } from "../engine/executor.ts";
import { validateCommands } from "../engine/actions.ts";
import { urlOf } from "../engine/extraction.ts";
import type { PageLike } from "../engine/extraction.ts";
import { checkSignal } from "../engine/signals.ts";
import type { CommandDecl, DomSignal, TargetDecl } from "./kit.ts";
import { StopError } from "./ctx-types.ts";
import type { StepResult } from "./ctx-types.ts";
import { resolveCtxUrl, samePage, normalizeCommandIds, targetOptions } from "./ctx-validate.ts";
import type { CtxRuntime, TabPage } from "./ctx-runtime.ts";

export async function runOneStep(rt: CtxRuntime, desc: string, req: {
    url?: string; done: DomSignal | Record<string, unknown>; act?: TargetDecl | CommandDecl[];
    slots?: Record<string, string>; values?: Record<string, string>;
    when?: DomSignal | null; id?: string; timeoutMs?: number;
    forceAct?: boolean; force?: boolean; staleRetry?: boolean; rehydrateRescan?: boolean;
    newTab?: { urlContains?: string };
}): Promise<StepResult> {
  const { deps, slots, budget, hosts, pageState, signalHosts, markDirectNavLanded, navGate, assertOpen, contextPages, listTabs, bounded, checkBudget, record, paceBeforeStep } = rt;


    assertOpen(`ctx.step(${JSON.stringify(desc)})`);
    checkBudget();
    await paceBeforeStep();
    const started = Date.now();
    const startUrl = resolveCtxUrl(req.url ?? rt.currentUrl);
    if (hosts && hosts.length && disallowedHost(startUrl, hosts)) {
      throw new StopError("host_not_allowed", `ctx.step: ${JSON.stringify(startUrl)} is outside the declared hosts envelope (${hosts.join(", ")})`);
    }
    const session = await deps.ensureSession();
    // A6 walk 调试模式：步声明的 url 与当前页**同页**（origin+path 相同）=「起点 URL=当前页」
    // 的重锚，折叠成缺省「当前页」语义——不重导航（SPA 客户端状态跨步保留）；指向另一页的
    // 显式 url 仍然导航。默认（walk 关）逐字节不变：带 url 就导航。
    const walkKeepPage = deps.walk === true && req.url !== undefined
      && samePage(startUrl, urlOf(session.page) || rt.currentUrl);
    // 导航纪律闸门（entry-only）：step 级 url 重锚是引擎发起的直接导航（执行器在
    // skipNavigation 关闭时 `pg.goto(startUrl)`）；walk 的同页重锚没有 goto，不进闸门。
    if (req.url !== undefined && !walkKeepPage) navGate("step", `ctx.step(${JSON.stringify(desc)})`, startUrl);
    if (req.url !== undefined && !walkKeepPage) rt.currentUrl = startUrl;
    // ---- F2 newTab（缺省不声明 = 本块整体不存在，行为逐字节不变）----
    // ① 去重采用：动作前已存在 URL 命中 urlContains 的标签（此前尝试开的）→ 直接切过去、
    //    不再点击（act/决策动作整体跳过），done 在该标签上判定——消重复标签。
    //    信封外的命中标签不采用（与 switchTab/popup 同一判定），照常走动作路径。
    const nt = req.newTab;
    const ntActive = nt !== undefined && nt !== null;
    const ntContains = ntActive && typeof (nt as { urlContains?: unknown })["urlContains"] === "string"
      ? String((nt as { urlContains: string })["urlContains"]) : undefined;
    type NtTab = { index: number; url: string; title: string; adopted: "existing" | "opened" };
    let ntAdopted: NtTab | null = null;
    let ntAdoptedPage: TabPage | null = null;
    let ntSkipAction = false;
    let ntBeforePages: Set<unknown> | null = null;
    if (ntActive) {
      const listed = await listTabs(session);
      if (ntContains !== undefined && ntContains.trim()) {
        const hit = listed.find((t) => t.url.toLowerCase().includes(ntContains.toLowerCase()));
        if (hit && !(hosts && hosts.length && disallowedHost(hit.url, hosts))) {
          ntAdopted = { index: hit.index, url: hit.url, title: hit.title, adopted: "existing" };
          ntAdoptedPage = hit.page;
          ntSkipAction = true;
        }
      }
      if (!ntSkipAction) ntBeforePages = new Set<unknown>(await contextPages(session));
    }
    if (ntSkipAction && ntAdopted !== null && ntAdoptedPage !== null) {
      // 去重采用路径：不进执行器（零动作），done 只在采用的标签上求值（如实，不假装成功）。
      const before = urlOf(session.page as unknown as PageLike) || rt.currentUrl;
      session.page = ntAdoptedPage as unknown as typeof session.page;
      rt.currentUrl = ntAdopted.url;
      await bounded(() => (ntAdoptedPage as { bringToFront?: () => Promise<void> }).bringToFront?.(), 2000);
      await bounded(() => (ntAdoptedPage as { waitForLoadState?: (s?: string, o?: { timeout?: number }) => Promise<void> })
        .waitForLoadState?.("domcontentloaded", { timeout: 5000 }), 5000);
      let held = false;
      try {
        held = (await checkSignal(ntAdoptedPage as never, req.done as never, signalHosts(req.done))) === true;
      } catch (e) {
        throw new StopError("config_error",
          `ctx.step newTab dedup: done signal evaluation failed on the adopted tab: ${e instanceof Error ? e.message : String(e)}`);
      }
      budget.stepsUsed += 1;
      try { pageState.update(ntAdoptedPage, "settled"); } catch { /* 记录面让位事实 */ }
      const result: StepResult = {
        ok: held,
        ...(req.id === undefined ? {} : { id: req.id }),
        ...(held ? {} : { stopCode: "done_not_held" }),
        ...(held
          ? { reason: `newTab dedup: adopted existing tab ${JSON.stringify(ntAdopted.url)} (was ${JSON.stringify(before)}); done-signal held on it, no click performed` }
          : { reason: `newTab dedup: adopted existing tab ${JSON.stringify(ntAdopted.url)} (no click performed — a tab matching urlContains already existed) but the done-signal never held on it` }),
        newTab: ntAdopted,
        evidence: { url: ntAdopted.url, attempts: 1, elapsedMs: Date.now() - started },
      };
      record(held, {
        desc, url: ntAdopted.url,
        ...(req.id === undefined ? {} : { id: req.id }),
        ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
        result: {
          ok: held,
          ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          elapsed_ms: result.evidence.elapsedMs,
          new_tab: ntAdopted,
        },
      });
      return result;
    }
    const opts: Record<string, unknown> = {
      goalSignalFn: (p: unknown) => checkSignal(p as never, req.done as never),
      page: session.page,
      // 不带 url = 决策语句在当前页上执行；带 url 才先导航。整页重载会丢 SPA 状态。
      // walk 的同页重锚（walkKeepPage）走同一条「当前页」路径（A6）。
      ...(req.url === undefined || walkKeepPage ? { skipNavigation: true } : {}),
      poolReady: true,
      ...(deps.poolReadyTimeoutMs === undefined ? {} : { poolReadyTimeoutMs: deps.poolReadyTimeoutMs }),
      ...(deps.poolReadyPollMs === undefined ? {} : { poolReadyPollMs: deps.poolReadyPollMs }),
      ...(deps.poolGate === undefined ? {} : { poolGate: deps.poolGate }),
      ...(deps.surfacePolicy === undefined ? {} : { surfacePolicy: deps.surfacePolicy }),
      ...(req.timeoutMs === undefined
        // 04-F：步级 timeoutMs 映射到该步的 done 等待上限
        // （本次显式 > meta.policy.done_timeout_ms）。它约束的是"动作后等信号成立"的窗口，
        // 不约束整步挂钟时长（模型咨询/导航耗时不在其内）。
        // F3：显式 timeoutMs 同时是该步的**整步挂钟帽**（stepTimeoutMs）——reobserve/升级
        // 循环的每轮与总时长受它约束，超时 = 结构化 stop_timeout。未声明 = 无帽，不变。
        ? (deps.doneTimeoutMs === undefined ? {} : { doneTimeoutMs: deps.doneTimeoutMs })
        : { doneTimeoutMs: req.timeoutMs, stepTimeoutMs: req.timeoutMs }),
      ...(deps.donePollMs === undefined ? {} : { donePollMs: deps.donePollMs }),
      // 带 url 的步：domcontentloaded 对 SPA 太早，给面板一个短稳定窗口再抽取。
      // walk 同页重锚没有 goto（页面早已就位），与不带 url 的步同待遇。
      ...(req.url === undefined || walkKeepPage ? {} : { settleMs: 700 }),
      pw: session.pw,
      slots: { ...slots, ...(req.slots ?? {}) },
      // U1：步级显式值袋（缺省不出现 = 既有行为逐字节不变；执行器只在决策步值请求里用）。
      ...(req.values === undefined ? {} : { values: req.values }),
      verbose: deps.verbose === true,
    };
    if (req.when !== undefined && req.when !== null) opts["precondition"] = req.when;
    // P0-E：原始 done 声明进执行器（只读；false_done guard 的「弱 done 零前进」判定用）。
    opts["doneSpec"] = req.done as never;
    // A1 forceAct：只把声明透传给执行器（缺省不出现 = 既有行为不变；执行器只记录、不改变顺序）。
    if (req.forceAct === true) opts["forceAct"] = true;
    // S4：步级 force / staleRetry 同样是显式声明（缺省不出现 = 既有行为逐字节不变）。
    if (req.force === true) opts["force"] = true;
    if (req.staleRetry === true) opts["staleRetry"] = true;
    // 步级 rehydrateRescan 兼容声明（重扫已缺省自动；透传只为声明链兼容，引擎不再读）。
    if (req.rehydrateRescan === true) opts["rehydrateRescan"] = true;
    if (ntActive && !ntSkipAction && req.act !== undefined && !Array.isArray(req.act)
        && (req.act as { kind?: string }).kind === "hint") {
      // F2：newTab + 单条 act hint → 收敛为**恰好一次点击**的单命令闭集：点完即判 done，
      // done 不成立 = done_not_held（不再重试连点，避免同一动作开出一串重复标签）。
      // 命令 target 走既有声明解析链（池/ADMIT/FW8/DRF），hint 语义不变。
      const hint = String((req.act as { hint: string }).hint);
      const one: CommandDecl[] = normalizeCommandIds([{ id: "newtab_open", op: "click", target: hint }]);
      const problems: string[] = [];
      validateCommands(one, "ctx.step", problems);
      if (problems.length) throw new StopError("config_error", problems.join("；"));
      opts["commands"] = one;
    } else {
      Object.assign(opts, req.act === undefined ? {} : targetOptions(req.act));
    }
    let rep: RunReport;
    try {
      rep = await deps.mw().run(desc, startUrl, opts as never);
    } catch (e) {
      // 执行器把"动作失败"当结果而不是异常（既有语义）；走到这里只可能是配置级错误。
      throw new StopError("config_error", `ctx.step ${JSON.stringify(desc)} crashed: ${e instanceof Error ? e.message : String(e)}`);
    }
    deps.onRunReport?.(rep);
    budget.stepsUsed += 1;
    // ---- F2 newTab ②：动作后短暂等待新标签并自动采用（读面 + 动作面），done 在新标签上判定 ----
    // 声明了 newTab 且没有命中已存标签时执行；没有新标签出现 = rep 原样（正常 done 判定，
    // 如实失败）。已在途的 executor 轮询即"短暂等待"（动作后 done 窗口内新 tab 已 commit）。
    if (ntActive && !ntSkipAction) {
      try {
        const listed = await listTabs(session);
        const fresh = ntBeforePages === null ? [] : listed.filter((t) => !ntBeforePages!.has(t.page));
        if (fresh.length > 0) {
          const pick = (ntContains !== undefined && ntContains.trim()
            ? fresh.find((t) => t.url.toLowerCase().includes(ntContains.toLowerCase()))
            : undefined) ?? fresh[fresh.length - 1]!;
          // 信封外的新标签不采用（既有 popup 门禁已在执行器侧拒绝；这里只是不再重复处理）。
          if (!(hosts && hosts.length && disallowedHost(pick.url, hosts))) {
            session.page = pick.page as unknown as typeof session.page;
            await bounded(() => pick.page.bringToFront?.(), 2000);
            await bounded(() => pick.page.waitForLoadState?.("domcontentloaded", { timeout: 5000 }), 5000);
            ntAdopted = { index: pick.index, url: pick.url, title: pick.title, adopted: "opened" };
            ntAdoptedPage = pick.page;
            try {
              if ((await checkSignal(pick.page as never, req.done as never, signalHosts(req.done))) === true) {
                rep = { ...rep, done: true, stop_code: "dom_goal_signal",
                  stop_reason: "dom goal signal (new tab adopted; done judged on the adopted tab)" };
              } else {
                rep = { ...rep, done: false, stop_code: "done_not_held",
                  stop_reason: `new tab ${JSON.stringify(pick.url)} was opened and adopted (read+action face follow it), `
                    + `but the done-signal never held on the adopted tab — judged honestly there` };
              }
            } catch (e) {
              throw new StopError("config_error",
                `ctx.step newTab: done signal evaluation failed on the adopted tab: ${e instanceof Error ? e.message : String(e)}`);
            }
            try { pageState.update(pick.page, "settled"); } catch { /* 记录面让位事实 */ }
          }
        }
      } catch (e) {
        if (e instanceof StopError) throw e;
        // 标签枚举失败不吞掉执行器的既有结论（如实按 rep 判定）。
      }
    }
    // 动作可能导航到另一个页面；`ctx.step` 之后的下一条语句必须从**落地页**开始，
    // 否则 `ctx.step({url?})` 会把上一页当成当前页（实测：Maps 已打开，下一步却又回到 google.com）。
    const landed = urlOf(session.page) || startUrl;
    rt.currentUrl = landed;
    // 入口只在**真的发生直接导航**时建立（无 url 的步没有 goto，不烧入口槽）。
    if (req.url !== undefined && !walkKeepPage) markDirectNavLanded();
    const landedState = pageState.update(session.page as unknown as PageLike, "settled");
    const reason = typeof rep.stop_reason === "string" && rep.stop_reason ? rep.stop_reason : undefined;
    // when 守卫不成立的步（rep.skipped）= “不适用”，不是“完成”：执行器在计划层把它记成
    // done 让流程前进，但 ctx.step 对作者返回 ok:false + stopCode="precondition_skipped"
    // （与 §4 文档和本文件 when 字段注释一致），脚本据 stopCode 分支。跳过步同样消耗预算。
    const skipped = rep.skipped === true;
    const result: StepResult = {
      ok: rep.done === true && !skipped,
      ...(req.id === undefined ? {} : { id: req.id }),
      ...(rep.stop_code === undefined ? {} : { stopCode: rep.stop_code }),
      ...(reason === undefined ? {} : { reason }),
      evidence: { url: landed, attempts: 1, elapsedMs: Date.now() - started, pageState: landedState },
      // A1 动作执行证据：执行器只在有事实时给字段，这里原样透出（缺省不硬造）。
      ...(rep.executed === undefined ? {} : { executed: rep.executed }),
      ...(rep.executed_actions === undefined ? {} : { executed_actions: rep.executed_actions }),
      ...(rep.skipped_actions === undefined ? {} : { skipped_actions: rep.skipped_actions }),
      ...(rep.stale_retries === undefined ? {} : { stale_retries: rep.stale_retries }),
      ...(rep.rehydrate_rescan === undefined ? {} : { rehydrate_rescan: rep.rehydrate_rescan }),
      ...(rep.forced === undefined ? {} : { forced: rep.forced }),
      ...(rep.done_preheld === undefined ? {} : { done_preheld: rep.done_preheld }),
      ...(rep.warnings === undefined ? {} : { warnings: rep.warnings }),
      ...(rep.diagnostics === undefined ? {} : { diagnostics: rep.diagnostics }),
      // S1 状态记录：执行器只在本 run 有观察时给；原样透出（dry 面另有合成值）。
      ...(rep.state === undefined ? {} : { state: rep.state }),
      // F2 newTab：本步采用的新标签事实（缺字段 = 没声明 newTab 或没有标签被采用）。
      ...(ntAdopted === null ? {} : { newTab: ntAdopted }),
    };
    record(result.ok, {
      desc, url: landed,
      ...(req.id === undefined ? {} : { id: req.id }),
      ...(result.stopCode === undefined ? {} : { stop_code: result.stopCode }),
      result: {
        ok: result.ok,
        // 成功步不写 stop_code：`dom_goal_signal` 这类是执行器的“完成依据”停因，不是失败分类，
        // 放在名为 stop_code 的字段里会把成功读成失败（01 轮 B6）。完成动作证据在 hows/methods 行里。
        ...(result.ok ? {} : { stop_code: result.stopCode ?? null }),
        ...(reason === undefined ? {} : { reason }),
        elapsed_ms: result.evidence.elapsedMs,
        // PageState 的紧凑证据；不记 observedAt（每次运行都会变，不属于结构）。
        page_state: {
          page_id: landedState.pageId,
          readiness: landedState.readiness,
          pool_version: landedState.poolVersion,
          frame_origins: landedState.frameOrigins,
        },
        // A1：动作执行证据同样进 trace event 的 result——app-runner 的 step_traces 与
        // report.md 的动作证据小节都从这一份投影（缺省不出现，旧产物形状不变）。
        ...(result.executed === undefined ? {} : { executed: result.executed }),
        ...(result.executed_actions === undefined ? {} : { executed_actions: result.executed_actions }),
        ...(result.skipped_actions === undefined ? {} : { skipped_actions: result.skipped_actions }),
        ...(result.stale_retries === undefined ? {} : { stale_retries: result.stale_retries }),
        ...(result.rehydrate_rescan === undefined ? {} : { rehydrate_rescan: result.rehydrate_rescan }),
        ...(result.forced === undefined ? {} : { forced: result.forced }),
        ...(result.done_preheld === undefined ? {} : { done_preheld: result.done_preheld }),
        ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
        ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
        ...(result.state === undefined ? {} : { state: result.state }),
        ...(ntAdopted === null ? {} : { new_tab: ntAdopted }),
      },
    });
    return result;
  };
