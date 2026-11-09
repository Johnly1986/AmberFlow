/**
 * `amber inspect` —— 只读页面观察。给 Agent 在写 `target_hint` 前看真实元素。
 *
 * 纪律：
 *   - 只接受 http(s)；不点击、不填值、不调用决策模型；
 *   - 复用 `extractElements` 与 `suggestHints`（后者用 `hintMatch` 自证）；
 *   - 输出有界：元素默认 60 条，正文摘要固定截断；不返回整页 HTML；
 *   - 会话无论成功失败都关闭。
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { CliContext } from "../context.ts";
import { emitJson, say } from "../context.ts";
import { usageError } from "../errors.ts";
import { successEnvelope } from "../json.ts";
import { browserSession } from "../../engine/executor.ts";
// AX 证据源（只读观察面）：浏览器自己算的 accessibility 语义。只在 inspect 跑一次，
// 不进池构成/hint 匹配/模型视图/动作路径（见 src/engine/ax.ts 文件头纪律）。
import { AX_NOT_IN_POOL_BASIS, countAxNotInPool, snapshotAx } from "../../engine/ax.ts";
import {
  extractElements, INTERACTIVE_ALL, WIDE_POOL_ELEMENTS, windowAudit,
} from "../../engine/extraction.ts";
import { poolView } from "../../engine/pool-view.ts";
import { poolNearEmpty, nextForInspect } from "../../engine/planning-playbook.ts";
import { matchSelector } from "../../engine/signals.ts";
import { parseCliArgs } from "../../support/cli-args.ts";
import { commandHelp } from "../registry.ts";

type ProbeOutcome = { selector: string; count?: number; texts?: string[]; error?: string };

/** task-6 `--summary`：人话紧凑输出的有界常量（总行数 ≈ 头 3 + 元素 12 + 尾注 ≤ 15 + probe ≤ 10）。 */
const SUMMARY_ELEMENTS = 12;
const SUMMARY_HINTS_PER_ELEMENT = 2;
const SUMMARY_LABEL_CHARS = 36;
const SUMMARY_HREF_CHARS = 40;

/** 有界截断：≤max 字符，超出以 … 收尾。 */
function clipChars(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** 只读探测一个 selector：存在数 + 前 5 条文本摘录。坏 selector 如实报错，不崩。 */
async function probeSelector(
  page: { evaluate(script: string): Promise<unknown> },
  selector: string,
): Promise<ProbeOutcome> {
  if (!selector.trim()) return { selector, error: "empty selector" };
  const sel = JSON.stringify(selector.trim());
  let count: unknown;
  try {
    count = await page.evaluate(`document.querySelectorAll(${sel}).length`);
  } catch (e) {
    const first = (e instanceof Error ? e.message : String(e)).split("\n")[0];
    return { selector, error: `invalid selector: ${first}` };
  }
  if (typeof count !== "number") return { selector, error: "evaluate returned no count" };
  if (count === 0) return { selector, count: 0 };
  let texts: string[] = [];
  try {
    const raw = await page.evaluate(
      `Array.from(document.querySelectorAll(${sel})).slice(0, 5).map((el) => (el.textContent || "").trim())`,
    );
    if (Array.isArray(raw)) texts = raw.map(String).map((t) => (t.length > 120 ? `${t.slice(0, 120)}…` : t));
  } catch {
    // 文本取失败不影响存在性结论（例如元素被 detach）；如实只留 count。
  }
  return { selector, count, ...(texts.length ? { texts } : {}) };
}

type InspectElement = {
  ref: string;
  tag: string;
  label: string;
  hint_candidates: string[];
} & Record<string, unknown>;

function num(v: string | boolean | string[] | undefined): number | undefined {
  const raw = typeof v === "string" ? v : undefined;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * A2：`--pool` 调试视图——在原 PoolView 上补 bucket/prio/full_label（只读诊断字段；
 * 主 elements 清单保持旧形状，避免把调试字段混进稳定契约）。
 */
function poolDebugView(
  view: ReturnType<typeof poolView>,
  pool: Record<string, { bucket?: string; prio?: number; full_label?: string; label?: string }>,
): ReturnType<typeof poolView> {
  const elements = view.elements.map((el) => {
    const pe = pool[el.ref];
    const extras = { ...el.extras } as Record<string, string>;
    if (pe !== undefined) {
      if (typeof pe.bucket === "string") extras["bucket"] = pe.bucket;
      if (typeof pe.prio === "number") extras["prio"] = String(pe.prio);
      const full = typeof pe.full_label === "string" ? pe.full_label : "";
      if (full && full !== el.label) extras["full_label"] = full;
    }
    return { ...el, extras };
  });
  return { ...view, elements };
}

export async function runInspect(args: string[], ctx: CliContext): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      options: {
        url: { type: "string" },
        "max-elements": { type: "string" },
        text: { type: "boolean" },
        pool: { type: "boolean" },
        wide: { type: "boolean" },
        summary: { type: "boolean" },
        probe: { type: "string", multiple: true },
        screenshot: { type: "string" },
        timeout: { type: "string" },
        "wait-ms": { type: "string" },
        headed: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw usageError(`inspect 参数不对：${msg}`, { next: ["amber inspect --url https://example.com --json"] });
  }
  const v = parsed.values;
  if (v.help) { say(ctx, commandHelp("inspect")); return 0; }
  const url = typeof v.url === "string" ? v.url.trim() : "";
  if (!url) throw usageError("inspect 需要 --url <http(s) URL>", { next: ['amber inspect --url https://example.com --json'] });
  let u: URL;
  try { u = new URL(url); } catch { throw usageError(`--url 不是合法 URL：${JSON.stringify(url)}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw usageError(`inspect 只接受 http(s)，拒绝 ${JSON.stringify(url)}`);
  }
  const max = Math.min(200, Math.max(1, Math.floor(num(v["max-elements"]) ?? 60)));
  const timeout = Math.min(120_000, Math.max(1_000, Math.floor(num(v.timeout) ?? 30_000)));
  // P0-A：`--wait-ms` = 抽取前额外等待（默认 0，上限 5000）——给迟渲染/异步水合的页面。
  // `load` 完成 + 3s 交互计数稳定轮询仍在它之前（两者叠加：先等页面自身稳定，再按需等待）。
  // 非法值 = usageError（不静默当 0，否则"等了却没用"又无法归因）。
  let waitMs = 0;
  if (typeof v["wait-ms"] === "string") {
    const rawWait = v["wait-ms"].trim();
    const parsedWait = Number(rawWait);
    if (!Number.isFinite(parsedWait) || parsedWait < 0) {
      throw usageError(`--wait-ms 需要非负毫秒数（收到 ${JSON.stringify(v["wait-ms"])}）`, {
        next: ["amber inspect --url <URL> --wait-ms 800 --json"],
      });
    }
    waitMs = Math.min(5000, Math.floor(parsedWait));
  }
  const wantJson = ctx.globals.json || v.json === true;
  const wantPool = v.pool === true;

  let session;
  try {
    session = await browserSession(v.headed !== true);
  } catch (err) {
    throw usageError(`浏览器启动失败：${err instanceof Error ? err.message : String(err)}`, {
      next: ["npm run doctor"],
    });
  }
  try {
    const page = session.page as unknown as {
      goto(url: string, opts?: unknown): Promise<unknown>;
      title(): Promise<string>;
      url(): string;
      evaluate(script: string): Promise<unknown>;
      screenshot(opts: { path: string; fullPage?: boolean }): Promise<unknown>;
    };
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    // R2c：迟水合盲区——m.ctrip 实证 domcontentloaded+500ms 时表单未渲染
    // （City_city-wrap textContent 空），约 2s 后 "北京上海" 才出现。等 load 完成
    // + 交互元素计数连续 3 次读数稳定（上限 3s）再抽取：观察工具没有预算压力，
    // 正确性优先；不等待时主池/宽池都可能在"半渲染"页面上扫描。
    try {
      await page.evaluate("new Promise((res) => { if (document.readyState === 'complete') res(); else window.addEventListener('load', () => res(), { once: true }); })");
    } catch { /* load 已过或执行环境不支持：自然落到稳定轮询 */ }
    let interactiveOnPage = -1;   // 水合循环的最后读数（-1 = 页面函数不可用）；空池诊断复用它
    {
      const countSel = JSON.stringify(INTERACTIVE_ALL);
      let last = -1;
      let stable = 0;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
        let n = -1;
        try { n = Number(await page.evaluate(`document.querySelectorAll(${countSel}).length`)); } catch { n = -1; }
        if (n === last) { stable++; if (stable >= 2) break; } else { stable = 0; }
        last = n;
      }
      interactiveOnPage = last;
    }
    await new Promise((r) => setTimeout(r, 500));
    // P0-A `--wait-ms`：页面自身稳定后的额外等待（给 setTimeout/异步接口补渲染的元素）。
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    // "saw" 时刻：本次观察真正读取 DOM 的时刻（JSON 与人类输出都标注，便于判断水合时机）。
    const sawAt = new Date().toISOString();
    // --probe：只读探测，放在元素池抽取**之前**——结论不受 --max-elements 截断影响
    // （01 轮 B2：exists/text 类 done 信号此前没有验证面）。
    const probeList = (parsed.values.probe ?? []).filter((s): s is string => typeof s === "string" && s.trim() !== "");
    const probes: ProbeOutcome[] = [];
    for (const s of probeList.slice(0, 10)) probes.push(await probeSelector(page, s));
    if (probeList.length > 10) probes.push({ selector: `…另有 ${probeList.length - 10} 个`, error: "超出 10 个探测上限，未探测" });
    // --wide：执行器低置信恢复路径的宽扫参数（120 上限 + R2 启发式伪按钮）。
    // 主池语义不变（不带 --wide 时逐字节今天）；heuristic 候选带标记，审计可辨。
    const wide = v.wide === true;
    const poolMax = wide ? Math.max(max, WIDE_POOL_ELEMENTS) : max;
    // P0-A：inspect 观察面显式要完整标签 + 有界 class_names（池行/模型面缺省逐字节不变——
    // 这两个字段只在 classNames/fullLabel 显式打开时才出现）。
    const pool = await extractElements(
      page as never, true, poolMax,
      { ...(wide ? { widgets: true } : {}), classNames: true, fullLabel: true });
    const heuristicCount = Object.values(pool).filter((e) => e.heuristic === true).length;
    const view = poolView(pool, page as never, poolMax);
    // A2 窗口透明化：页面上**可见**的交互元素里，有多少没进本次池（被 40/120 窗口或分桶顺序
    // 挤出）。它回答的是"窗口外还有什么"，不是"页面没有"——把信息差当场说给 Agent。
    const windowInfo = await windowAudit(page as never, view.count, 10);
    const frameOrigins = view.frame_origins;
    // advisories（自描述运行时 · P0-B）：把「引擎已知、作者看不见」的信息差当场说出来。
    // 依据 2026-10-30 实测：3/5 次运行失败属此类（ogs.google.com 跨源 frame 1 次、
    // 仅 aria-label 的出行模式 radio 2 次）——inspect 当时就有能力预警。
    // 措辞红线：只说「引擎元素池无法指向」，不说「不可点击/不存在」。
    const mainOrigin = u.origin;
    const advisories: Array<Record<string, unknown>> = [];
    const foreign = frameOrigins.filter((o) => o && o !== mainOrigin);
    if (foreign.length) {
      advisories.push({
        kind: "frame_host",
        origins: foreign,
        message: `池含跨源 frame（${foreign.join("、")}）：meta.hosts 不声明这些主机时，其内元素的动作步将报 frame_not_allowed。`,
      });
    }
    for (const p of probes) {
      if (p.error !== undefined || typeof p.count !== "number") continue;
      // 池命中用 matchSelector（池可表达子集：#id / tag / [attr=v] / [attr~v] / 逗号表）——
      // 与 act hint 的可指向性同口径；DOM probe 是主 frame 任意 CSS。
      const poolHits = matchSelector(pool, p.selector);
      if (p.count > 0 && poolHits === null) {
        advisories.push({
          kind: "pool_inexpressible",
          probe: p.selector,
          dom_hits: p.count,
          message: `probe「${p.selector}」DOM 命中 ${p.count} 但选择器超出元素池可表达子集（类/伪类/后代组合器）：act hint 不可命中；judge.exists（任意 CSS、跨 frame）仍可用。`,
        });
      } else if (p.count > 0 && poolHits !== null && poolHits.length === 0) {
        advisories.push({
          kind: "not_in_pool",
          probe: p.selector,
          dom_hits: p.count,
          message: `probe「${p.selector}」主 frame DOM 命中 ${p.count} 但引擎元素池 0 命中：元素可能仅带池外属性（aria-label/class 等永不入池），act hint 永不命中——改用池内句柄（data-test/id/name/href/可见文本）或深链/直达 URL。`,
        });
      } else if (p.count === 0 && poolHits !== null && poolHits.length > 0) {
        advisories.push({
          kind: "pool_only",
          probe: p.selector,
          pool_hits: poolHits.length,
          message: `probe「${p.selector}」主 frame DOM 未命中但池内有 ${poolHits.length} 个（子 frame）：judge.exists 可跨 frame 命中；对其动作需 meta.hosts 声明该 frame origin，否则 frame_not_allowed。`,
        });
      }
    }
    const shownAdvisories = advisories.slice(0, 8);
    // P0-A：JSON 的 `label` 给**完整**值（旧行为是池模型视图的 40 字前缀；长 label 因此
    // 被截断，hint 照抄静默降级——R10 实证）。`label_truncated:true` 只表示"原始标签超过
    // 200 字符，引擎的**匹配口径** full_label 只取前 200"（不是本次输出被截断）。
    const elements: InspectElement[] = view.elements.map((e) => {
      const pe = pool[e.ref];
      const full = typeof pe?.label_full === "string" && pe.label_full !== "" ? pe.label_full : e.label;
      const classNames = Array.isArray(pe?.class_names) && pe.class_names.length > 0
        ? pe.class_names.slice(0, 8) : undefined;
      return {
        ref: e.ref,
        tag: e.tag,
        label: full,
        ...(full.length > 200 ? { label_truncated: true } : {}),
        ...(classNames === undefined ? {} : { class_names: classNames }),
        hint_candidates: e.hint_candidates,
        action_family: e.action_family,
        action_capabilities: e.action_capabilities,
        frame_origin: e.frame_origin,
        ...e.extras,
      };
    });
    const text = v.text === true
      ? String(await page.evaluate("document.body ? document.body.innerText : ''")).slice(0, 800)
      : "";
    let screenshotPath: string | undefined;
    if (typeof v.screenshot === "string" && v.screenshot !== "") {
      screenshotPath = v.screenshot;
      fs.mkdirSync(path.dirname(path.resolve(screenshotPath)), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: false });
    }
    // 空池诊断（planning-playbook）：页面上交互元素多而池几乎没收进来 = 重 JS SPA 的典型
    // 形态（2026-10-29 实测：两个 Agent 都是"跑了才发现池是空的"，才转入宽扫/SSR 深挖）。
    // 判定与建议来自唯一出处；建议写进 envelope 的 next（Agent 调用即得）。
    const nearEmpty = poolNearEmpty(view.count, Math.max(0, interactiveOnPage));
    // AX 证据源（只读 additive，第 5 项）：浏览器自己算的可访问性语义作为第二条观察证据，
    // 回答“浏览器认为可交互/有名字的节点有哪些、哪些没进池”。取树失败 = available:false，
    // 其余输出照常；调用放在抽池之后，池 ref/排序不受影响（A/B 可证）。
    const axSnap = await snapshotAx(page as never);
    const axNotInPool = axSnap
      ? countAxNotInPool(axSnap, Object.values(pool).map((e) => e.full_label || e.label || ""))
      : null;
    const ax = axSnap
      ? {
          available: true as const,
          source: axSnap.source,
          interactive_count: axSnap.interactive_count,
          counts_by_role: axSnap.counts_by_role,
          interactive_counts_by_role: axSnap.interactive_counts_by_role,
          nodes: axSnap.nodes.slice(0, 50),
          nodes_truncated: axSnap.nodes.length > 50 || axSnap.truncated,
          total_nodes: axSnap.total_nodes,
          pool_size: view.count,
          not_in_pool: axNotInPool,
          not_in_pool_basis: AX_NOT_IN_POOL_BASIS,
        }
      : {
          available: false as const,
          reason: "AX 树不可用（该运行时无 accessibility API / 无 CDP 会话 / 取树失败或超时 ≤3s）；其余观察面照常",
        };
    const data = {
      url: page.url(),
      requested_url: url,
      title: String(await page.title()),
      // P0-A：观察时刻（`--wait-ms` 之后的真实读取时刻）+ 声明的额外等待。新增字段，
      // 既有字段语义不变；人类输出同样标注这一行（水合时机是排障的一等事实）。
      saw_at: sawAt,
      wait_ms: waitMs,
      // P3（2026-11-01 产品评审）：hint 语法不是 CSS、href 等字段是池投影——实测有 Agent
      // 把 `a[href=…]` 投影误当 CSS 选择器用。把这两句话随每次观察一起给出去。
      // T9：href 匹配同时认原始属性（href_full，query 可命中），hint_candidates 优先给原始值。
      hint_syntax: "hint_candidates 可直接用作 --hint / ctx.hint（非 CSS 语法）；href 字段是展示投影（匹配同时认原始属性 href_full，query 可命中），hint 建议优先给原始值",
      elements,
      element_count: view.count,
      truncated: view.truncated,
      // A2：窗口透明化（--json 恒有；文本模式在下面按需提示）。
      window: windowInfo,
      // AX 证据源：浏览器语义参照（只读，不进决策）。不可用时 available:false + reason。
      ax,
      ...(nearEmpty ? { pool_near_empty: true, interactive_on_page: interactiveOnPage } : {}),
      ...(wide ? { wide: true, heuristic_count: heuristicCount } : {}),
      ...(wantPool ? { frame_origins: view.frame_origins } : {}),
      // --pool 是调试视图：候选补 A2 的分桶/优先级/完整 label（只在这里出现，不动 elements 清单）。
      ...(wantPool ? { pool: poolDebugView(view, pool) } : {}),
      ...(text ? { text } : {}),
      ...(screenshotPath ? { screenshot_path: screenshotPath } : {}),
      ...(probes.length ? { probes } : {}),
      ...(shownAdvisories.length ? { advisories: shownAdvisories } : {}),
    };
    if (wantJson) {
      emitJson(ctx, successEnvelope("inspect", data, {
        next: nextForInspect(view.count, Math.max(0, interactiveOnPage), url),
      }));
      return 0;
    }
    const surfaceLine = Object.entries(windowInfo.surface_counts)
      .map(([k, v]) => `${k} ${v}`).join("、");
    // task-6 `--summary`：人话紧凑输出（行数有界）。只改人话面——`--json` 面逐字节不变
    // （summary 旗标不进 JSON；--pool/--wide/--probe 的 JSON 语义照旧）。
    if (v.summary === true) {
      say(ctx, `${data.title} — ${data.url}`);
      say(ctx, `观察时刻 ${sawAt}${waitMs > 0 ? `（--wait-ms ${waitMs}）` : ""}；元素 ${data.element_count} 个${data.truncated ? `（截断，只显示前 ${max}）` : ""}`);
      const shown = elements.slice(0, SUMMARY_ELEMENTS);
      for (const e of shown) {
        const rec = e as Record<string, unknown>;
        const href = typeof rec["href"] === "string" ? String(rec["href"])
          : typeof rec["href_full"] === "string" ? String(rec["href_full"]) : "";
        const hints = e.hint_candidates.slice(0, SUMMARY_HINTS_PER_ELEMENT)
          .map((h) => clipChars(h, SUMMARY_HREF_CHARS));
        say(ctx, `  ${e.ref} ${e.tag} ${clipChars(e.label, SUMMARY_LABEL_CHARS)}`
          + `${href ? `  ${clipChars(href, SUMMARY_HREF_CHARS)}` : ""}`
          + `${hints.length ? `  hints: ${hints.join(" | ")}` : ""}`);
      }
      if (elements.length > shown.length) {
        say(ctx, `  …另有 ${elements.length - shown.length} 个元素未展示（完整清单用默认输出或 --json）`);
      }
      if (surfaceLine) say(ctx, `ℹ 可见类目计数：${surfaceLine}（准入面）`);
      if (nearEmpty) {
        say(ctx, `⚠ 主池近空（interactive_on_page=${interactiveOnPage}）——宽扫/池投影诊断见默认输出或 --json 的 pool_near_empty`);
      }
      for (const a of shownAdvisories.slice(0, 3)) say(ctx, `  ⚠ ${String(a.message)}`);
      for (const p of probes) {
        const verdict = p.error !== undefined ? p.error
          : p.count === 0 ? "无命中"
          : `${p.count} 命中${p.texts?.length ? `：${p.texts.join(" / ")}` : ""}`;
        say(ctx, `  probe  ${p.selector} → ${verdict}`);
      }
      if (text) say(ctx, `文本摘要：${clipChars(text, 200)}`);
      say(ctx, `（--summary：元素仅前 ${SUMMARY_ELEMENTS} 条、hints 前 ${SUMMARY_HINTS_PER_ELEMENT} 条、href ≤${SUMMARY_HREF_CHARS} 字符——完整清单去掉 --summary，机器消费用 --json）`);
      return 0;
    }
    say(ctx, `${data.title} — ${data.url}`);
    say(ctx, `观察时刻 ${sawAt}${waitMs > 0 ? `（--wait-ms ${waitMs}）` : ""}`);
    say(ctx, `元素 ${data.element_count} 个${data.truncated ? `（只显示前 ${max}）` : ""}`);
    say(ctx, "（hints 可直接当 --hint / ctx.hint 用——不是 CSS；href 等字段是池投影，仅供识别）");
    if (surfaceLine) {
      // U3：按类目计数（ADMIT_SEL 可见口径）——区分"页面没有交互事实"与"准入面没覆盖"。
      say(ctx, `ℹ 可见类目计数：${surfaceLine}（准入面；池只展示 ${view.count} 个）`);
    }
    if (windowInfo.out_of_window_total > 0) {
      const examples = windowInfo.out_of_window
        .slice(0, 3)
        .map((e) => `${e.label || e.tag} (${e.tag})`)
        .join("、");
      say(ctx, `ℹ ${windowInfo.out_of_window_total} 个可见交互在默认窗口外（池只展示 ${view.count}/${windowInfo.visible_interactive}）`
        + `，例如 ${examples}——宽扫/收窄 hint 或直接观察目标；窗口不是页面事实，别把"不在池"读成"不存在"`);
    }
    if (axSnap) {
      // 措辞红线：只说“池未指向/未进池”，不说“不可点击/不存在”。AX 是浏览器语义参照，
      // 不是池的一部分；不可用时不打印（空白 > 误导）。
      const roleLine = Object.entries(axSnap.interactive_counts_by_role)
        .slice(0, 4)
        .map(([role, n]) => `${role} ${n}`)
        .join("、");
      say(ctx, `ℹ AX 树：可交互 ${axSnap.interactive_count}（池 ${view.count}；其中 ${axNotInPool ?? 0} 个未进池）`
        + `${roleLine ? `，可交互 role：${roleLine}` : ""}——浏览器语义参照；池仍是选择器闭集，AX 不进决策`);
    }
    if (nearEmpty) {
      // U3：文案引用 sniff 证据（ADMIT_SEL 可见计数 / 窗口外 / 类目），区分两种事实：
      //   ① 页面**有**准入面覆盖的交互元素而池没收进来 = 窗口/投影问题（池口径，不是不可点击）；
      //   ② 页面没有可见的准入面候选 = 未水合/只落在准入面之外（[tabindex] 等）——宽扫也难救。
      // 措辞红线沿用：只说「池无法指向」，不说「不可点击/不存在」。
      const admittedVisible = windowInfo.visible_interactive;
      const counts = Object.entries(windowInfo.surface_counts).map(([k, v]) => `${k}=${v}`).join(", ") || "none";
      say(ctx, admittedVisible > 0
        ? `⚠ 主池近空而准入面可见 ${admittedVisible} 个（surface: ${counts}；窗口外 ${windowInfo.out_of_window_total}）：池投影/窗口问题，不是页面没有——试 --wide --pool，或 1 步探针应用先行（见 docs/APP_SCRIPT_AUTHORING.md 快速路径）`
        : `⚠ 主池为空且准入面 0 个可见候选（surface: ${counts}; interactive_on_page=${interactiveOnPage}）：页面未渲染出可动作事实或只落在准入面之外（如仅 [tabindex]）——宽扫也难救，直接 1 步探针应用先行（arrive + read，见 docs/APP_SCRIPT_AUTHORING.md 快速路径）`);
    }
    for (const e of elements) {
      say(ctx, `  ${e.ref.padEnd(6)} ${e.tag.padEnd(8)} ${e.label.slice(0, 60)}`
        + `${e.hint_candidates.length ? `  hints: ${e.hint_candidates.join(" | ")}` : ""}`);
    }
    for (const p of probes) {
      const verdict = p.error !== undefined ? p.error
        : p.count === 0 ? "无命中"
        : `${p.count} 命中${p.texts?.length ? `：${p.texts.join(" / ")}` : ""}`;
      say(ctx, `  probe  ${p.selector} → ${verdict}`);
    }
    for (const a of shownAdvisories) say(ctx, `  ⚠ ${String(a.message)}`);
    if (text) say(ctx, `\n文本摘要：${text}`);
    return 0;
  } finally {
    await session.close();
  }
}
