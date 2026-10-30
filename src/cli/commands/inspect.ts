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
import { extractElements, INTERACTIVE_ALL, WIDE_POOL_ELEMENTS } from "../../engine/extraction.ts";
import { poolView } from "../../engine/pool-view.ts";
import { poolNearEmpty, nextForInspect } from "../../engine/planning-playbook.ts";
import { matchSelector } from "../../engine/signals.ts";
import { parseCliArgs } from "../../support/cli-args.ts";

const USAGE = `usage: inspect --url <http(s) URL> [--max-elements N] [--wide] [--text] [--pool] [--probe SEL]...
               [--screenshot FILE] [--timeout MS] [--headed] [--json]

只看页面，不点击、不填值、不调用模型。输出有界元素与可验证的 hint 候选；
--pool 输出引擎实际看到的 pool 视图（action_family/frame_origin/hint_candidates）。
--wide 用执行器低置信恢复路径的**宽扫参数**（120 上限 + R2 启发式伪按钮候选，
heuristic 标记可辨）抽池——给 Agent 看"宽扫后模型能看见什么"；主池语义不变。
--probe 可重复（最多 10 个）：对**任意 CSS selector**（含 h1/文本类非交互元素）做只读
探测，返回存在数与至多 5 条文本摘录（单条 120 字符截断）——补“元素池只含可行动元素”
的观察缺口；--json 输出落 probes[] 字段。`;

type ProbeOutcome = { selector: string; count?: number; texts?: string[]; error?: string };

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
        probe: { type: "string", multiple: true },
        screenshot: { type: "string" },
        timeout: { type: "string" },
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
  if (v.help) { say(ctx, USAGE); return 0; }
  const url = typeof v.url === "string" ? v.url.trim() : "";
  if (!url) throw usageError("inspect 需要 --url <http(s) URL>", { next: ['amber inspect --url https://example.com --json'] });
  let u: URL;
  try { u = new URL(url); } catch { throw usageError(`--url 不是合法 URL：${JSON.stringify(url)}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw usageError(`inspect 只接受 http(s)，拒绝 ${JSON.stringify(url)}`);
  }
  const max = Math.min(200, Math.max(1, Math.floor(num(v["max-elements"]) ?? 60)));
  const timeout = Math.min(120_000, Math.max(1_000, Math.floor(num(v.timeout) ?? 30_000)));
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
    const pool = await extractElements(
      page as never, true, poolMax, wide ? { widgets: true } : undefined);
    const heuristicCount = Object.values(pool).filter((e) => e.heuristic === true).length;
    const view = poolView(pool, page as never, poolMax);
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
    const elements: InspectElement[] = view.elements.map((e) => ({
      ref: e.ref,
      tag: e.tag,
      label: e.label,
      hint_candidates: e.hint_candidates,
      action_family: e.action_family,
      action_capabilities: e.action_capabilities,
      frame_origin: e.frame_origin,
      ...e.extras,
    }));
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
    const data = {
      url: page.url(),
      requested_url: url,
      title: String(await page.title()),
      elements,
      element_count: view.count,
      truncated: view.truncated,
      ...(nearEmpty ? { pool_near_empty: true, interactive_on_page: interactiveOnPage } : {}),
      ...(wide ? { wide: true, heuristic_count: heuristicCount } : {}),
      ...(wantPool ? { frame_origins: view.frame_origins } : {}),
      ...(wantPool ? { pool: view } : {}),
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
    say(ctx, `${data.title} — ${data.url}`);
    say(ctx, `元素 ${data.element_count} 个${data.truncated ? `（只显示前 ${max}）` : ""}`);
    if (nearEmpty) {
      // 措辞按实测分开：页面上有交互元素而池没收进来 = 池投影问题；页面上一个都没有 =
      // SPA 未水合/渲染进 shadow DOM——前者试 --wide，后者宽扫也救不了，直接走探针/运行时取证。
      say(ctx, interactiveOnPage > 0
        ? `⚠ 主池近空而页面上有 ${interactiveOnPage} 个交互元素（池投影盲区）：试 --wide --pool，或 1 步探针应用先行（见 docs/APP_SCRIPT_AUTHORING.md 快速路径）`
        : "⚠ 主池为空且页面未渲染出交互元素（重 JS SPA 未水合或渲染进 shadow DOM）：宽扫也难救，直接 1 步探针应用先行（arrive + read，见 docs/APP_SCRIPT_AUTHORING.md 快速路径）");
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
