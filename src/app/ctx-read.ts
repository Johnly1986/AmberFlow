/**
 * createCtx 的只读观察原语：read/observe/extract/collect/rows/holds/waitFor/waitForTarget/source/data。
 *
 * 观察类调用不占 flow 预算（与 ctx.ts 的写面分离）；共享状态一律经 CtxRuntime 显式传入。
 */
import { firstOf, framesOf, locatorAnyFrame, splitFrameSuffixFromSelector, frameScopeEvidenceOf } from "../engine/extraction.ts";
import type { FrameScopeEvidence, FrameLike, PageLike } from "../engine/extraction.ts";
import { extractElements } from "./candidate-scan.ts";
import { hintCandidates } from "../engine/rules.ts";
import { observePage, validateObserveOptions } from "../engine/observe.ts";
import { checkSignal } from "../engine/signals.ts";
import { defaultDates, defaultDatesSlotNames, loadSource, parseDatesValue, runSource, ValueError } from "../data/datasource.ts";
import { pushEvent } from "./trace.ts";
import { sleepMs } from "../support/sleep.ts";
import { StopError } from "./ctx-types.ts";
import type { CollectStopReason, CollectCoverage, CollectResult, SourceObservationView, Ctx } from "./ctx-types.ts";
import { isObj, validateCollectRequest, validateExtractOptions, validateWaitForTargetArgs, waitTiming } from "./ctx-validate.ts";
import { pickRowMin, pickRowMax } from "./ctx-tool.ts";
import type { CtxRuntime } from "./ctx-runtime.ts";

/**
 * Playwright 专属选择器语法（页内 querySelector 永不命中或语义不同）——批量行抽取快路径
 * 的静态拒入名单：字段选择器命中任一 → 直接走旧路径（不浪费一次往返）。名单只收
 * "确定不支持"的语法；拿不准的交给页内执行的整体回退（快路径只是加速，不是语义源）。
 */
const PW_ONLY_CELL_RE =
  /:has-text\(|:visible|:hidden|:hover|:nth\s*=|:left-of|:right-of|:above|:below|:near\b|>>|(?:^|>>|\s)(?:text|xpath|css|id)\s*=/i;

/**
 * 批量行抽取快路径（readRows 的加速面，旧路径仍是语义源）：一次 evaluateAll 完成
 * 全部行×字段（1 次往返），替代逐行逐字段 locator 读（rows × fields 次往返，每字段
 * 1500ms 超时帽——选择器无命中的字段每格付 2×1500ms，16 行 × 2 空字段实测 ≥96s，
 * 18 行 × 6 字段整体超桥 60s op 帽 = bridge_timeout 且引擎 trace 无记录）。
 * 语义逐字节对齐旧路径：
 *   - 页内 querySelector = 文档序首个（= locator.first() 同口径）；shadow DOM 深查对齐
 *     locator 的 pierce-open-shadow 语义；
 *   - "."/":scope" = 行自身 innerText；"@attr" = 行自身 attribute；
 *   - 无命中 = ""（旧行为：innerText 1500ms 超时抛 → inputValue 1500ms 再抛 → 外层
 *     catch ""，净结果一致；页内 attached 元素 innerText 不抛，故 matched 元素不存在
 *     value 兜底——这里同样不加，trim 同口径）；
 * 返回 null = 条件不满足（test double 无 evaluateAll / Playwright 专属语法）或页内失败
 * （非法 CSS 等）→ 调用方回退旧路径。
 */
async function tryBatchExtractRows(
  rowsLoc: unknown, fields: Record<string, string>, cap: number, offset: number,
): Promise<{ rows: Array<Record<string, string>>; total: number } | null> {
  const loc = rowsLoc as {
    evaluateAll?: (fn: (els: any[], arg: { entries: Array<[string, string]> }) => unknown,
      arg?: { entries: Array<[string, string]> }) => Promise<unknown>;
  };
  if (typeof loc.evaluateAll !== "function") return null;
  const entries = Object.entries(fields);
  for (const [, sel] of entries) {
    if (sel !== "." && sel !== ":scope" && !(sel.startsWith("@") && sel.length > 1)
        && PW_ONLY_CELL_RE.test(sel)) {
      return null;
    }
  }
  const out = await loc.evaluateAll!((els, arg) => {
    // 页内执行（Node strip-types 下本函数源码原样进浏览器，保持纯 JS）：
    const deepQuery = (root: any, sel: any): any => {
      const hit = root.querySelector(sel);
      if (hit) return hit;
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          const found = deepQuery(el.shadowRoot, sel);
          if (found) return found;
        }
      }
      return null;
    };
    return els.map((row: any) => {
      const rec: Record<string, string> = {};
      for (const [name, sel] of arg.entries) {
        if (sel === "." || sel === ":scope") {
          rec[name] = String(row.innerText ?? "").trim();
          continue;
        }
        if (sel.charAt(0) === "@" && sel.length > 1) {
          rec[name] = String(row.getAttribute(sel.slice(1)) ?? "").trim();
          continue;
        }
        const cell = deepQuery(row, sel);
        const v = cell === null ? "" : String(cell.innerText ?? "");
        rec[name] = String(v ?? "").trim();
      }
      return rec;
    });
  }, { entries }) as Array<Record<string, string>> | null;
  if (!Array.isArray(out)) return null;
  return { rows: out.slice(offset, offset + cap), total: out.length };
}

/**
 * 行抽取旧路径（**语义源**）：逐行逐字段 locator 读，实现逐字保留（含 1500ms 超时帽、
 * catch→inputValue 兜底、task-24/3c 属性投影）。批量快路径不可用/页内失败时的唯一回退，
 * 也是快路径语义对齐的基准——改这里 = 改抽取语义，必须连带核对 tryBatchExtractRows。
 */
async function extractRowsLegacy(
  all: unknown[], fields: Record<string, string>, cap: number, offset: number,
  rows: Array<Record<string, string>>,
): Promise<void> {
  for (const row of all.slice(offset, offset + cap)) {
    const locators = row as {
      locator?: (s: string) => { first(): { innerText(o?: { timeout?: number }): Promise<string>; inputValue(o?: { timeout?: number }): Promise<string> } };
      innerText?: (o?: { timeout?: number }) => Promise<string>;
      getAttribute?: (name: string) => Promise<string | null>;
    };
    const rec: Record<string, string> = {};
    for (const [field, cellSel] of Object.entries(fields)) {
      let value = "";
      try {
        if (cellSel === "." || cellSel === ":scope") {
          if (typeof locators.innerText === "function") value = await locators.innerText({ timeout: 1500 });
        } else if (cellSel.startsWith("@") && cellSel.length > 1) {
          // task-24/3c：属性投影（opt-in——"@" 前缀）——读**行元素自身**的 attribute
          //（如 fields:{rating:"@aria-label"}；无子选择器、无行内回退；读不到 → "" 与现行为一致）。
          // 旧 fields（无 @ 前缀）逐字节不变。
          if (typeof locators.getAttribute === "function") {
            value = (await locators.getAttribute(cellSel.slice(1))) ?? "";
          }
        } else if (typeof locators.locator === "function") {
          const cell = locators.locator(cellSel).first();
          try { value = await cell.innerText({ timeout: 1500 }); }
          catch { value = await cell.inputValue({ timeout: 1500 }); }
        }
      } catch { value = ""; }
      rec[field] = String(value ?? "").trim();
    }
    rows.push(rec);
  }
}

export function createCtxRead(rt: CtxRuntime): Pick<Ctx, "observe" | "read" | "holds" | "waitFor" | "waitForTarget" | "source" | "data" | "rows" | "extract" | "collect"> {
    const { deps, pack, slots, trace, budget, hosts, pageState, assertOpen, page, checkBudget, paceBeforeStep, scrollRowsContainer } = rt;

  /**
   * C2：抽取选择器的**唯一预检**（`ctx.extract` / `ctx.collect` 共用；每个调用入口一次，
   * 不逐字段逐行）。判定放在 `readRows` 入口（collect 先校验一次再在循环里跳过）。
   *
   * 为什么必须真付一次往返：CSS 由 Playwright 原生执行，`locator(sel)` 本身**不解析**
   * 选择器（解析在 driver 侧），所以只有一次 `count()` 才能把「非法选择器」与「合法但
   * 零命中」分开——前者此前被吞成 `""`/`[]`（假数据，最危险的静默形态），后者必须继续
   * 是 `""`/`[]`。代价：每次抽取 ≤ 1 + 字段数 次往返。
   *
   * 只把**解析错误**当配置错：掉帧/超时/页面已关闭等异常维持旧行为（绝不把执行面故障
   * 误报成选择器错）。`"."`（行自身）/`:scope`/`@attr` 不是子选择器，跳过。
   */
  const SELECTOR_PARSE_ERROR_RE =
    /(parsing (?:css )?selector|unexpected token|unknown engine|invalid (?:css )?selector|not a valid (?:css )?selector)/i;

  const selectorParseProblem = async (frame: FrameLike, selector: string): Promise<string | null> => {
    if (typeof frame.locator !== "function") return null;   // 替身页没有 locator：维持旧行为
    try {
      await frame.locator(selector).count();
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return SELECTOR_PARSE_ERROR_RE.test(msg) ? msg : null;
    }
  };

  const checkExtractSelectors = async (
    p: PageLike, rowSelector: string, fields: Record<string, string>, call: string,
  ): Promise<void> => {
    const frame = framesOf(p)[0]!;
    // E4：行选择器先剥合法 ` frame:` 尾缀再做解析预检（预检只验 CSS 形状，帧归属在
    // readRows 的帧过滤里；值非法 = 整串按原 CSS 处理 → 预检按原串判，拒因附注进报错——
    // M4① 的"原样 CSS 解析失败"诊断面）。无尾缀 = 原串逐字节。
    const rowSplit = splitFrameSuffixFromSelector(rowSelector);
    const rowBad = await selectorParseProblem(frame, rowSplit.selector);
    if (rowBad !== null) {
      throw new StopError("config_error",
        `${call}: row selector ${JSON.stringify(rowSelector)} is not valid: ${rowBad}`
        + (rowSplit.rejected !== undefined ? `（${rowSplit.rejected}）` : ""),
        { bad_selector: { selector: rowSelector } });
    }
    for (const [field, cellSel] of Object.entries(fields)) {
      if (cellSel === "." || cellSel === ":scope" || (cellSel.startsWith("@") && cellSel.length > 1)) continue;
      const bad = await selectorParseProblem(frame, cellSel);
      if (bad !== null) {
        // E4（M4①）：字段选择器是行内相对寻址（不支持 frame: 尾缀）；串里带被拒尾缀形状时
        // 同样附注拒因（原样 CSS 解析失败路径——成功路径零改动）。
        const cellRejected = splitFrameSuffixFromSelector(cellSel).rejected;
        throw new StopError("config_error",
          `${call}: field ${JSON.stringify(field)} selector ${JSON.stringify(cellSel)} is not valid: ${bad}`
          + (cellRejected !== undefined ? `（${cellRejected}）` : ""),
          { bad_selector: { selector: cellSel, field } });
      }
    }
  };

  /**
   * 行抽取的**唯一实现**（`ctx.extract` 与 `ctx.collect` 共用）：对当前 DOM 取行对象。
   * 字段值 = 行内相对选择器的文本投影（表单控件回退 inputValue；"." = 行自身文本）。
   * 返回 `{ rows, total, truncated }`：`rows` = `all.slice(offset, offset + cap)`，
   * `total` = 当前匹配行总数，`truncated` = 本页之后还有行（`offset + rows.length < total`）。
   * C1：`offset` 只改读取起点；`offset = 0` 与引入分页之前逐字节一致（同一段 slice）。
   * C2：入口先做一次选择器解析预检（`opts.prevalidated` = 调用方已在入口校验过，如 collect
   * 的循环）；非法选择器 = 结构化 `config_error` + `diagnostics.bad_selector`。
   */
  const readRows = async (
    rowSelector: string, fields: Record<string, string>, cap = 500, offset = 0,
    opts: { call?: string; prevalidated?: boolean } = {},
  ): Promise<{ rows: Array<Record<string, string>>; total: number; truncated: boolean }> => {
    const call = opts.call ?? "ctx.extract";
    const p = await page();
    if (opts.prevalidated !== true) await checkExtractSelectors(p, rowSelector, fields, call);
    // E4：声明了合法 ` frame:` 尾缀的行选择器与 ctx.read 同信封口径（hosts 传入 → 链匹配
    // 且信封内才读；声明帧全在信封外/不存在 = 空 + miss 证据）。无尾缀 = 原样（hosts 不传，
    // 既有跨帧抽取口径逐字节不变——对称化只经尾缀激活，既有 op 面零行为变更）。
    const rowSplit = splitFrameSuffixFromSelector(rowSelector);
    const rowsLoc = await locatorAnyFrame(p, rowSelector, rowSplit.frameChain !== undefined ? { hosts } : undefined);
    const rows: Array<Record<string, string>> = [];
    if (rowsLoc === null) return { rows, total: 0, truncated: false };
    const all = rowsLoc.all === undefined ? null : await rowsLoc.all();
    if (all === null) {
      throw new StopError("config_error", "ctx.extract needs a Playwright locator (locator.all() is not available here)");
    }
    // 批量快路径（1 次 evaluateAll 完成 rows×fields）；条件不满足/页内失败 → 走旧路径（语义源）。
    const batch = all.length > 0 ? await tryBatchExtractRows(rowsLoc, fields, cap, offset).catch(() => null) : null; if (batch !== null) return { rows: rows.concat(batch.rows), total: batch.total, truncated: offset + batch.rows.length < batch.total };
    await extractRowsLegacy(all, fields, cap, offset, rows);
    return { rows, total: all.length, truncated: offset + rows.length < all.length };
  };

  /**
   * E4（M4②/M4①）：读/抽取 **miss** 的帧尾缀证据（trace 事件 additive 字段；只在读空
   * 且选择器串带 ` frame:` 尾缀参与时出现，二者互斥）：
   *   - 合法尾缀 → `frame_evidence` = 声明帧扫描证据（`excluded` 非空 = 声明帧存在但被
   *     hosts 信封排除；`scanned` 空 = 声明帧不存在/链写错；`scanned` 非空 = 帧已扫、
   *     是选择器本身零命中）；
   *   - 非法尾缀 → `frame_suffix_rejected` = B8 同款拒因（整串按原 CSS 处理）。
   * 成功读取/无尾缀 = 空对象 ⇒ trace 事件键集与旧行为逐字节一致。**不抛**：读/抽取是
   * op 面，声明帧问题落成 null/空 + 证据，绝不升级 frame_not_allowed（那是 done/when
   * 的 F45② 面）。
   */
  const frameSuffixTrace = async (sel: string, missed: boolean): Promise<Record<string, unknown>> => {
    if (!missed) return {};
    const split = splitFrameSuffixFromSelector(sel);
    if (split.frameChain === undefined) {
      return split.rejected !== undefined ? { frame_suffix_rejected: split.rejected } : {};
    }
    try {
      const ev: FrameScopeEvidence = frameScopeEvidenceOf(await page(), hosts, split.frameChain);
      return { frame_evidence: ev };
    } catch {
      return {};   // 证据只是附注：页面取不到时静默省略，绝不影响读面返回值
    }
  };

  return {
    // ---- P0-A observe：免费只读（不占预算/不 pace/不写盘/不进模型面/不改页面）----
    observe: async (opts = {}) => {
      // 声明面先校验（形状错误 = config_error；非法 CSS 不在这里判——那要浏览器才知道，
      // 且 observe 用结构化 {ok:false,error:"bad_selector"} 回报，不中断 flow）。
      const problems = validateObserveOptions(opts);
      if (problems.length) throw new StopError("config_error", problems.join("；"));
      const started = Date.now();
      const session = await deps.ensureSession();
      const result = deps.hintTokenAllow !== undefined
        ? await observePage(session.page as unknown as PageLike, opts, deps.surfacePolicy,
            { hintTokenAllow: deps.hintTokenAllow })
        : await observePage(session.page as unknown as PageLike, opts, deps.surfacePolicy);
      // 只记摘要：counts + truncated + 判分样例（task-21/D-1：前 5 个元素 tag/label≤40/
      // hints≤3 的有界投影——0/5 判分所需字段的流式可见；全量明细仍只在 observe 返回值里，
      // result 装配时经 scrubSecrets 掩码）。
      const obsSample = (result.elements ?? []).slice(0, 5).map((e) => ({
        tag: String(e.tag ?? ""),
        label: String(e.label ?? "").slice(0, 40),
        ...(Array.isArray(e.hint_candidates) && e.hint_candidates.length > 0
          ? { hints: e.hint_candidates.slice(0, 3) } : {}),
      }));
      pushEvent(trace, {
        call: "observe", url: result.url, ok: result.ok,
        counts: result.counts, truncated: result.truncated,
        ...(result.ok && obsSample.length > 0 ? { elements_sample: obsSample } : {}),
        ...(result.ok ? {} : { result: { error: result.error, reason: result.reason } }),
      });
      if (deps.verbose === true) {
        // verbose 只打计数（不打印元素），与 trace 同一口径。
        console.log(`  [observe] ${result.url} elements=${result.counts.elements} admitted=${result.counts.admitted} omitted=${result.counts.omitted} (${Date.now() - started}ms)`);
      }
      return result;
    },
    read: {
      text: async (sel) => {
        let value: string | null = null;
        try {
          const loc = await locatorAnyFrame(await page(), sel, { hosts });
          if (loc !== null) value = String(await firstOf(loc).innerText({ timeout: 1500 }));
        } catch { value = null; }
        pushEvent(trace, { call: "read", desc: `text(${sel})`, result: value, ...await frameSuffixTrace(sel, value === null) });
        return value;
      },
      value: async (sel) => {
        let value: string | null = null;
        try {
          const loc = await locatorAnyFrame(await page(), sel, { hosts });
          if (loc !== null) value = String(await firstOf(loc).inputValue({ timeout: 1500 }));
        } catch { value = null; }
        pushEvent(trace, { call: "read", desc: `value(${sel})`, result: value, ...await frameSuffixTrace(sel, value === null) });
        return value;
      },
      count: async (sel) => {
        let value = 0;
        try {
          const loc = await locatorAnyFrame(await page(), sel, { hosts });
          value = loc === null ? 0 : Number(await loc.count());
        } catch { value = 0; }
        pushEvent(trace, { call: "read", desc: `count(${sel})`, result: value, ...await frameSuffixTrace(sel, value === 0) });
        return value;
      },
      attr: async (sel, attr) => {
        if (typeof sel !== "string" || !sel.trim()) throw new StopError("config_error", "ctx.read.attr: selector must be a non-empty string");
        if (typeof attr !== "string" || !attr.trim()) throw new StopError("config_error", "ctx.read.attr: attribute name must be a non-empty string");
        let value: string | null = null;
        try {
          const loc = await locatorAnyFrame(await page(), sel, { hosts });
          if (loc !== null) {
            const inner = firstOf(loc) as { getAttribute?(n: string, o?: { timeout?: number }): Promise<string | null> };
            if (typeof inner.getAttribute === "function") value = await inner.getAttribute(attr, { timeout: 1500 });
          }
        } catch { value = null; }
        pushEvent(trace, { call: "read", desc: `attr(${sel}, ${attr})`, result: value, ...await frameSuffixTrace(sel, value === null) });
        return value;
      },
    },
    holds: async (sig) => {
      if (!isObj(sig) || !Object.keys(sig).length) throw new StopError("config_error", "ctx.holds needs a non-empty signal");
      const ok = await checkSignal(await page(), sig as never, { hosts });
      pushEvent(trace, { call: "holds", ok });
      return ok;
    },
    waitFor: async (sig, opts = {}) => {
      if (!isObj(sig) || !Object.keys(sig).length) throw new StopError("config_error", "ctx.waitFor needs a non-empty signal");
      const { timeoutMs, pollMs } = waitTiming(opts);
      const started = Date.now();
      const deadline = started + timeoutMs;
      const p = await page();
      let held = false;
      // 轮询语义：至少检查一次；最后一次 sleep 裁到 deadline，不让“下一次会越界”提前退出。
      while (true) {
        try {
          if (await checkSignal(p as never, sig as never, { hosts })) { held = true; break; }
        } catch (e) {
          throw new StopError("config_error", `ctx.waitFor: ${e instanceof Error ? e.message : String(e)}`);
        }
        const now = Date.now();
        if (now >= deadline) break;
        await new Promise((r) => setTimeout(r, Math.max(1, Math.min(pollMs, deadline - now))));
      }
      if (held) pageState.update(p as PageLike, "settled");
      pushEvent(trace, {
        call: "waitFor", ok: held,
        result: { timeout_ms: timeoutMs, poll_ms: pollMs, elapsed_ms: Date.now() - started },
      });
      return held;
    },
    // C2：observe + hintMatch 轮询（免费只读；池 = 可见准入面，hidden 期元素不进池 →
    // count 0 → 可见后才命中，visible 语义由此成立）。返回 {found, count}，超时如实 false。
    waitForTarget: async (hint, opts = {}) => {
      validateWaitForTargetArgs(hint, opts);
      const { timeoutMs, pollMs } = waitTiming(opts);
      const started = Date.now();
      const deadline = started + timeoutMs;
      let count = 0;
      let found = false;
      // 轮询语义与 ctx.waitFor 同款：至少查一次；最后一次 sleep 裁到 deadline。
      while (true) {
        const p = await page();
        const elems = await extractElements(p as never, true, 120, { ...(hosts ? { hosts } : {}) });
        const cand = hintCandidates(hint, elems, {
          ...(deps.attrValueMatch === undefined ? {} : { attrValueMatch: deps.attrValueMatch }),
        });
        count = cand === null ? 0 : cand.refs.length;
        if (count > 0) { found = true; break; }
        const now = Date.now();
        if (now >= deadline) break;
        await new Promise((r) => setTimeout(r, Math.max(1, Math.min(pollMs, deadline - now))));
      }
      if (found) pageState.update(await page() as PageLike, "settled");
      pushEvent(trace, {
        call: "waitForTarget", desc: hint, ok: found,
        result: {
          hint, visible: opts.visible === true, timeout_ms: timeoutMs, poll_ms: pollMs,
          count, elapsed_ms: Date.now() - started,
        },
      });
      return { found, count };
    },
    source: async (name, sourceOpts = {}) => {
      if (deps.allowSources === false) {
        throw new StopError("config_error", `ctx.source(${JSON.stringify(name)})：本次运行带 --skip-data，数据腿被显式跳过`);
      }
      if (deps.sourceRunner) {
        const obs = await deps.sourceRunner(name, sourceOpts);
        // T6：sources 观测面不只记行数——名字 + counts + selects 都进事件（result 投影同源）。
        pushEvent(trace, {
          call: "source", desc: name,
          result: { name, counts: obs.counts, selects: obs.selects, rows: obs.rows.length },
        });
        return obs;
      }
      const src = loadSource(name);
      // 环封口：数据腿的日期参数只能来自包默认/CLI 槽位——引用 source_slots 产物
      // 是循环依赖（那些值要等数据腿跑完才存在），加载已知就拒绝。
      const producerSlots = new Set(Object.keys(deps.pack.source_slots ?? {}));
      for (const ph of defaultDatesSlotNames(src)) {
        if (producerSlots.has(ph)) {
          throw new StopError("config_error", `source ${JSON.stringify(name)} 的 default_dates 引用 {${ph}}，`
            + `但 ${ph} 由数据腿回写（source_slots）——数据腿参数不允许引用数据腿产物`);
        }
      }
      let dates: string[];
      try {
        if (sourceOpts.dates !== undefined) {
          const raws = Array.isArray(sourceOpts.dates) ? sourceOpts.dates : [sourceOpts.dates];
          dates = raws.flatMap((r) => parseDatesValue(String(r), deps.runtime.today || undefined));
        } else {
          dates = defaultDates(src, slots, deps.runtime.today || undefined);
        }
      } catch (e) {
        // 坏日期参数/缺槽位值是配置类错误：ValueError → 结构化 StopError，不裸抛。
        if (e instanceof ValueError) {
          throw new StopError("config_error", `ctx.source(${JSON.stringify(name)}): ${e.message}`);
        }
        throw e;
      }
      const res = await runSource(src, dates, { verbose: false, today: deps.runtime.today || undefined });
      const day = Object.values(res.dates)[0] as unknown as Record<string, unknown> | undefined;
      const counts = (day?.["counts"] ?? {}) as Record<string, number>;
      const selects = (day?.["selects"] ?? {}) as Record<string, Record<string, string> | null>;
      const rows = (day?.["rows"] ?? []) as Array<Record<string, string>>;
      const byDate: NonNullable<SourceObservationView["byDate"]> = {};
      for (const [dateKey, entry] of Object.entries(res.dates)) {
        const e = entry as unknown as Record<string, unknown>;
        if (e["error"] !== undefined) continue;
        byDate[dateKey] = {
          ...(e["url"] !== undefined ? { url: String(e["url"]) } : {}),
          counts: (e["counts"] ?? {}) as Record<string, number>,
          selects: (e["selects"] ?? {}) as Record<string, Record<string, string> | null>,
          rows: (e["rows"] ?? []) as Array<Record<string, string>>,
        };
      }
      const obs: SourceObservationView = {
        counts, selects, rows,
        ...(res.tool_version ? { version: res.tool_version } : {}),
        ...(Object.keys(byDate).length ? { byDate } : {}),
      };
      pushEvent(trace, {
        call: "source", desc: name,
        result: { name, counts, selects, rows: rows.length, dates: Object.keys(byDate) },
      });
      return obs;
    },
    data: {
      min: pickRowMin,
      max: pickRowMax,
    },
    rows: async () => {
      throw new StopError("config_error", "ctx.rows is closed in v1 (Q5: no new extraction grammar); "
        + "declare named row extraction in meta.site.listExtract and call ctx.extract(name)");
    },
    extract: async (nameOrSpec, extractOpts) => {
      // C1：offset 只认第二参（写进 spec 在 validateExtractOptions 里结构化指路）。
      const offset = validateExtractOptions(nameOrSpec, extractOpts);
      let spec: { rows: string; fields: Record<string, string>; maxItems?: number };
      if (typeof nameOrSpec === "string") {
        if (!nameOrSpec.trim()) throw new StopError("config_error", "ctx.extract: name must be a non-empty string");
        const named = pack.site?.listExtract?.[nameOrSpec];
        if (named === undefined) {
          const known = Object.keys(pack.site?.listExtract ?? {});
          throw new StopError("config_error",
            `ctx.extract(${JSON.stringify(nameOrSpec)}): meta.site.listExtract has no such entry`
            + ` (known: ${known.length ? known.join(", ") : "none declared"})`);
        }
        spec = named;
      } else if (isObj(nameOrSpec) && typeof nameOrSpec["rows"] === "string" && nameOrSpec["rows"].trim()
          && isObj(nameOrSpec["fields"])) {
        spec = { rows: nameOrSpec["rows"], fields: nameOrSpec["fields"] as Record<string, string> };
        if (typeof nameOrSpec["maxItems"] === "number") spec.maxItems = nameOrSpec["maxItems"];
      } else {
        throw new StopError("config_error",
          "ctx.extract needs a declared name or { rows, fields, maxItems? } structure");
      }
      const extractName = typeof nameOrSpec === "string" ? nameOrSpec : `inline:${spec.rows}`;
      const cap = Math.max(1, Math.min(500, Math.floor(spec.maxItems ?? 500)));
      const found = await readRows(spec.rows, spec.fields, cap, offset);
      // C1：total 经注入的观测口回写（返回类型不变）；未注入 = 不写（run/dry/replay 零影响）。
      if (deps.extractStats !== undefined) deps.extractStats.total = found.total;
      pushEvent(trace, {
        call: "extract", desc: extractName,
        result: {
          rows: found.rows,
          // offset=0 时与分页之前逐字节一致（`rows.length < total` ⇔ 旧的 `total > cap`）。
          truncated: found.truncated,
          ...(offset > 0 ? { offset } : {}),
        },
        // E4：行选择器带合法 ` frame:` 尾缀且本页零行 → miss 证据（additive；有行/无尾缀
        // = 键集与旧事件逐字节一致）。M4②：抽取不抛 frame_not_allowed，空行 + 证据。
        ...await frameSuffixTrace(spec.rows, found.rows.length === 0),
      });
      return found.rows;
    },
    collect: async (req) => {
      validateCollectRequest(req);
      assertOpen("ctx.collect");
      checkBudget();
      await paceBeforeStep();
      const p = await page();
      budget.stepsUsed += 1;
      const fields = req.fields ?? { text: "." };
      const until = req.until ?? { stableRounds: 2 };
      const stableRounds = "stableRounds" in until ? (until.stableRounds ?? 2) : 2;
      const maxRows = "maxRows" in until ? (until.maxRows ?? 500) : 500;
      const dedupe = req.dedupe !== false;
      const maxRounds = req.maxRounds ?? 30;
      // C2：行/字段选择器的唯一预检就在**入口这一处**（循环内不重复、每次轮询零额外往返）。
      // 预检必须与 extract 走同一个 Playwright 解析面（`locator(sel).count()`）：
      // 用 DOM `querySelectorAll` 会把 Playwright 自己的选择器扩展（`:has-text(...)` 等）
      // 误判成非法。
      await checkExtractSelectors(p, req.row, fields, "ctx.collect");
      const rows: Array<Record<string, string>> = [];
      const seen = new Set<string>();
      let rounds = 0;
      let addedLastRound = 0;
      let stableCount = 0;
      /**
       * 是否已确认"滚到底/滚不动"。滚动没到底时"本轮没新增"是正常的（还没滚到新内容），
       * 不能算进 plateau；只有到底后连续 stableRounds 轮无新增才是 stable。
       */
      let atBottomKnown = false;
      let stopReason: CollectStopReason = "budget";
      while (rounds < maxRounds) {
        rounds += 1;
        const found = await readRows(req.row, fields, maxRows, 0, { call: "ctx.collect", prevalidated: true });
        addedLastRound = 0;
        for (const row of found.rows) {
          const key = JSON.stringify(row);
          if (dedupe && seen.has(key)) continue;
          seen.add(key);
          rows.push(row);
          addedLastRound += 1;
          if (rows.length >= maxRows) break;
        }
        if (rows.length >= maxRows) { stopReason = "maxRows"; break; }
        if (addedLastRound > 0) stableCount = 0;
        else if (atBottomKnown) stableCount += 1;
        if (stableCount >= stableRounds) { stopReason = "stable"; break; }
        if (rounds >= maxRounds) break;                    // 内部轮数用尽 → budget
        const scroll = await scrollRowsContainer(req.row);
        if (!scroll.found || !scroll.scrollable) { stopReason = "not_scrollable"; break; }
        atBottomKnown = scroll.atBottom || !scroll.moved;
        // 给懒加载/无限滚动一点时间再读下一轮；这段等待**不占** flow 预算。
        await sleepMs(300);
      }
      const coverage: CollectCoverage = { rounds, rowsSeen: rows.length, addedLastRound };
      const result: CollectResult = { rows, coverage, stopReason };
      pushEvent(trace, {
        call: "collect", desc: req.row, ok: true,
        args: req,
        result,
      });
      return result;
    },
  };
}
