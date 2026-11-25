/**
 * verify-offline —— **非门禁**的确定性等价 lane：本地静态夹具页 + 无头 chromium。
 *
 * 定位（为什么不进 `npm run check`）：本 lane 需要 chromium，而 PR 门禁是纯离线的；
 * 它只在本地/定时任务里跑，用来给「机械拆分 / 运行期重构」补一层**可重复**的
 * 页面事实证据。真正的完成裁决仍在 `amber run` / `online/` 套件，本工具不做完成判定、
 * 不调模型、不联网（只连 127.0.0.1 上自己起的静态服务）。
 *
 * 观测口径（全部确定性、与时机无关）：
 *   - DOM 事实：title / 元素计数 / 文本前缀；
 *   - 引擎元素池：`extractElements` 的行（scan + 稳定字段），按 scan 升序；
 *   - hint 事实：代表性 hint 的 `hintCandidates` 计数/档位/裁决与 `hintMatch` 结果；
 *   - 网络事实：页面发出的外部请求数必须恒为 0（本 lane 的「不联网」自证）。
 * 归一化：`http://127.0.0.1:<随机端口>` → `<LOCAL>`；JSON 键递归排序后再比对。
 * 比对口径：`ref`（`e0…`）是抽池时按枚举顺序分配的**位置性句柄**——同一代码状态内分配确定
 * （连跑两次 `--record` 逐字节一致），但抽池实现/枚举顺序一变就整体重排（实测基线记录后
 * 一次池面演进让 filter-bar 的三行只换编号、元素集合不变），所以它不是页面/引擎行为契约。
 * 比对前按元素身份（tag/label/scan 等稳定字段）归一：`refs` 比顺序无关**多重集**，
 * `match`/`decided` 比身份，`ref_count` 仍钉数量（见 `identityView`）。
 * golden 存原始观测（含当次 ref 编号）；两侧都在身份视图上比，所以纯编号漂移不触发重录。
 *
 * 用法：
 *   node --experimental-strip-types tools/verify-offline.ts            # 比对（默认 --check）
 *   node --experimental-strip-types tools/verify-offline.ts --check    # 显式
 *   node --experimental-strip-types tools/verify-offline.ts --record   # 写基线 tools/golden/offline/**
 *   node --experimental-strip-types tools/verify-offline.ts --list
 * 退出码：0 绿 / 1 红（含「外部请求不为 0」）/ 2 用法或环境错误（如 chromium 缺失）。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { browserSession } from "../src/engine/executor.ts";
import { type ElemPool, type PageLike, windowAudit } from "../src/engine/extraction.ts";
import { observePage } from "../src/engine/observe.ts";
import { extractElements } from "../src/app/candidate-scan.ts";
import { hintCandidates, hintMatch } from "../src/engine/rules.ts";
import { SessionRuntime } from "../src/app/session-runtime.ts";
import type { SessionSink } from "../src/app/session-runtime-contract.ts";
import type { AnyPage } from "../src/engine/executor-types.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(REPO, "fixtures", "engine");
const GOLDEN_DIR = path.join(REPO, "tools", "golden", "offline");
const USAGE = "usage: node --experimental-strip-types tools/verify-offline.ts [--check | --record | --list]";
const GOLDEN_DOC =
  "verify-offline 基线（tools/verify-offline.ts，非门禁）：本地静态夹具 + 无头 chromium 的确定性观测。"
  + "页面/代码变化后显式 --record 更新；端口已归一为 <LOCAL>，不得手改。";
const EXAMPLE_COUNT = 4;

/* ------------------------------------------------------------------ 静态 HTTP */

interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

/** 起一个只服务 `fixtures/engine/` 下 .html 的本地服务（监听随机端口，仅 127.0.0.1）。 */
async function startFixtureServer(root: string): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    const rel = decodeURIComponent(new URL(rawUrl, "http://127.0.0.1").pathname);
    const abs = path.resolve(root, `.${rel}`);
    const inside = abs === root || abs.startsWith(`${root}${path.sep}`);
    if (!inside || !fs.existsSync(abs) || !fs.statSync(abs).isFile() || !abs.endsWith(".html")) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(fs.readFileSync(abs));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("夹具服务没有拿到端口");
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

/* ------------------------------------------------------------------ 归一化 */

const LOCAL_RE = /http:\/\/127\.0\.0\.1:\d+/g;

/** 递归归一：端口地址 → `<LOCAL>`；对象键排序（同内容 = 同字节）。 */
function normalize(value: unknown): unknown {
  if (typeof value === "string") return value.replace(LOCAL_RE, "<LOCAL>");
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

/* ------------------------------------------------------------------ 比对视图 */

/**
 * 元素身份（ref 归一化的唯一出处）：`ref`（`e0…`）是抽池时按枚举顺序分配的位置性句柄，
 * 抽池实现/枚举顺序变化会让同一个元素换编号——编号本身不是页面或引擎行为契约；
 * 元素身份才是（tag/label/scan 等稳定字段）。身份 = 池投影行的全部稳定字段（除 ref 外），
 * 键按字典序编码成可读串。
 */
function rowIdentity(row: Record<string, unknown>): string {
  return Object.keys(row)
    .filter((key) => key !== "ref")
    .sort()
    .map((key) => `${key}=${JSON.stringify(row[key])}`)
    .join("|");
}

/** 池 ref → 元素身份（同一池内一一对应）。 */
function refIdentityMap(pool: unknown): Map<string, string> {
  const map = new Map<string, string>();
  const rows = pool !== null && typeof pool === "object"
    ? (pool as Record<string, unknown>)["rows"]
    : undefined;
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const ref = (row as Record<string, unknown>)["ref"];
    if (typeof ref === "string") map.set(ref, rowIdentity(row as Record<string, unknown>));
  }
  return map;
}

/** ref → 身份；解析不到时保留原文并显式标记（不静默当成未变化）。 */
function refIdentity(ref: string, map: Map<string, string>): string {
  return map.get(ref) ?? `<unresolved ref ${JSON.stringify(ref)}>`;
}

/** ref 列表 → 元素身份**多重集**（排序后比较，顺序无关；数量由 ref_count 单独钉住）。 */
function refIdentityMultiset(value: unknown, map: Map<string, string>): unknown {
  if (!Array.isArray(value)) return value;
  const out: string[] = value.map((item) => (typeof item === "string" ? refIdentity(item, map) : String(item)));
  out.sort();
  return out;
}

/**
 * 池投影的比对视图：行只留身份字段（ref 是位置性句柄）；count 等其它事实原样。
 * 行序由池投影的 scan 排序保证，不再按 ref 排序。
 */
function poolIdentityView(pool: unknown): unknown {
  if (pool === null || typeof pool !== "object") return pool;
  const obj = pool as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key !== "rows" || !Array.isArray(value)) {
      out[key] = value;
      continue;
    }
    out[key] = value.map((row) => {
      if (row === null || typeof row !== "object") return row;
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row as Record<string, unknown>)) if (k !== "ref") clean[k] = v;
      return clean;
    });
  }
  return out;
}

/**
 * 一份观测的比对视图：把位置性 ref 全部归一成元素身份，其余事实原样递归。
 *   - `pool.rows`：剔除 ref，只留身份字段；
 *   - `hints.<hint>.refs`：身份多重集（顺序无关），`ref_count` 原样保留（数量是行为事实）；
 *   - `hints.<hint>.match` / `decided`：ref → 身份（裁决看「哪个元素」，不看「几号」）；
 *   - `ref_order`：ref 序列 → 身份序列（拾取序是事实，只消编号漂移）；
 *   - 其它键原样递归。遇到 `pool` 就为所在层重建 ref→身份表——overlay 的 on/off 是两张
 *     互不相干的池，ref 编号各自从零开始，不能共表。
 */
function identityView(node: unknown, inherited?: Map<string, string>): unknown {
  if (Array.isArray(node)) return node.map((item) => identityView(item, inherited));
  if (node === null || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  const map = "pool" in obj ? refIdentityMap(obj["pool"]) : (inherited ?? new Map<string, string>());
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "pool") out[key] = poolIdentityView(value);
    else if (key === "refs") out[key] = refIdentityMultiset(value, map);
    else if (key === "ref_order") {
      out[key] = Array.isArray(value)
        ? value.map((item) => (typeof item === "string" ? refIdentity(item, map) : item))
        : value;
    } else if ((key === "match" || key === "decided") && typeof value === "string") {
      out[key] = refIdentity(value, map);
    } else out[key] = identityView(value, map);
  }
  return out;
}

/* ------------------------------------------------------------------ 观测 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询一个 JS 表达式，直到连续 `quietMs` 不再变化（确定性等待；不用固定 sleep 猜时机）。 */
async function waitStable(page: AnyPage, expression: string, quietMs = 500, timeoutMs = 15_000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  let lastChange = Date.now();
  let value: unknown = null;
  while (Date.now() < deadline) {
    value = await page.evaluate(expression);
    const now = JSON.stringify(value);
    if (now !== last) { last = now; lastChange = Date.now(); } else if (Date.now() - lastChange >= quietMs) return value;
    await sleep(100);
  }
  return value;
}

/** 等待表达式为真（同上，超时即抛——夹具没按声明出现 = 该 lane 自身失败，别静默放行）。 */
async function waitTrue(page: AnyPage, expression: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(`等待超时：${expression.slice(0, 120)}`);
}

/** DOM 事实（表达式是字符串：浏览器侧执行，root tsconfig 不带 DOM lib）。 */
const DOM_EXPR = `(() => {
  const q = (sel) => document.querySelectorAll(sel).length;
  const texts = (sel, limit) => Array.from(document.querySelectorAll(sel)).slice(0, limit).map((el) => (el.textContent || "").trim());
  // 去掉 <script>/<style>：body.textContent 会把内联脚本源码算进正文，噪声且随实现漂移。
  const body = document.body.cloneNode(true);
  Array.from(body.querySelectorAll("script,style")).forEach((el) => el.remove());
  return {
    title: document.title,
    counts: { button: q("button"), link: q("a"), li: q("li"), input: q("input"), role_dialog: q("[role=dialog]") },
    texts: { h1: texts("h1", 3), first_buttons: texts("button", 8), dialogs: texts("[role=dialog]", 3) },
    body_text_prefix: (body.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 240)
  };
})()`;

const OVERLAY_VISIBLE_EXPR = `(() => { const el = document.getElementById("modal-overlay"); return !!el && !el.hidden; })()`;
/** hit-test 语义的页面事实：容器候选的中心点命中谁（后代命中 = 正常操作，不得判 covered）。 */
const CENTER_HIT_EXPR = `(() => {
  const parent = document.getElementById("hit-region");
  const r = parent.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {
    hit_tag: hit ? hit.tagName.toLowerCase() : null,
    hit_id: hit && hit.id ? hit.id : "",
    is_descendant: hit !== null && parent.contains(hit),
    is_self: hit === parent,
  };
})()`;
const LAZY_EXPR = `(() => {
  const rows = document.querySelectorAll(".lazy-row");
  const last = rows.length ? (rows[rows.length - 1].textContent || "").trim() : "";
  const status = document.getElementById("status");
  return { rows: rows.length, last_row: last, status: status ? (status.textContent || "").trim() : "" };
})()`;

/** 元素池投影：只取稳定字段（不放几何/样式/事件等易漂移字段）。 */
function poolProjection(pool: ElemPool): { count: number; rows: Array<Record<string, unknown>> } {
  const rows = Object.entries(pool).map(([ref, elem]) => {
    const row: Record<string, unknown> = { ref, tag: elem.tag, label: elem.label };
    if (elem.scan !== undefined) row["scan"] = elem.scan;
    for (const key of ["role", "id", "data_test", "input_type", "href"] as const) {
      const value = elem[key];
      if (value !== undefined && value !== "") row[key] = value;
    }
    if (elem.surface !== undefined) row["surface"] = elem.surface;
    if (elem.frame !== undefined) row["frame"] = elem.frame;
    return row;
  });
  rows.sort((a, b) => Number(a["scan"] ?? 0) - Number(b["scan"] ?? 0) || String(a["ref"]).localeCompare(String(b["ref"])));
  return { count: rows.length, rows };
}

/** 代表性 hint 的候选/裁决事实（对照池；同一份 rules 实现，不另造解析）。 */
function hintFacts(hints: string[], pool: ElemPool): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const hint of hints) {
    const candidates = hintCandidates(hint, pool);
    out[hint] = candidates === null
      ? { match: hintMatch(hint, pool) ?? null }
      : {
        ref_count: candidates.refs.length,
        refs: candidates.refs.slice(0, 20),
        tier: candidates.tier,
        decided: candidates.decided,
        match: hintMatch(hint, pool) ?? null,
      };
  }
  return out;
}

interface ObservationContext {
  page: AnyPage;
  origin: string;
}

async function observeHtml(ctx: ObservationContext, html: string, hints: string[]): Promise<Record<string, unknown>> {
  await ctx.page.goto(`${ctx.origin}/${html}`, { waitUntil: "load", timeout: 15_000 });
  const pool = await extractElements(ctx.page as unknown as PageLike, true);
  return {
    dom: await ctx.page.evaluate(DOM_EXPR),
    pool: poolProjection(pool),
    hints: hintFacts(hints, pool),
  };
}

/**
 * 一区域一候选夹具（fixtures/engine/pool-dedup/）的观测：池投影（稳定字段）+ ref 拾取序
 * + windowAudit 的被剔账（dedup_dropped）。golden 把"留父剔子 / 留子剔父 / 都留 / 64 帽可达"
 * 钉成逐字节事实：被剔行不出现在 pool 里、被剔账带 why、无被剔页 dedup_dropped 为空数组。
 */
async function observePoolDedup(ctx: ObservationContext, html: string): Promise<Record<string, unknown>> {
  await ctx.page.goto(`${ctx.origin}/${html}`, { waitUntil: "load", timeout: 15_000 });
  const pool = await extractElements(ctx.page as unknown as PageLike, true);
  const shown = Object.keys(pool).length;
  const audit = await windowAudit(ctx.page as unknown as PageLike, shown, 10);
  return {
    pool: poolProjection(pool),
    ref_order: Object.keys(pool),
    window: {
      visible_interactive: audit.visible_interactive,
      shown: audit.shown,
      out_of_window_total: audit.out_of_window_total,
      dedup_dropped: audit.dedup_dropped ?? [],
    },
  };
}

interface ObservationCase {
  name: string;
  run(ctx: ObservationContext): Promise<Record<string, unknown>>;
}

const CASES: ObservationCase[] = [
  {
    name: "ambiguity-order",
    run: async (ctx) => await observeHtml(ctx, "ambiguity-order.html", ["订票", "button", "#not-exist"]),
  },
  {
    name: "filter-bar",
    run: async (ctx) => await observeHtml(ctx, "filter-bar.html", ["订票", "航空公司", "#filter_item_airline", "button"]),
  },
  {
    name: "lazy-list",
    run: async (ctx) => {
      // 只记录「加载后自稳定」的状态：初始 7 行会经 IntersectionObserver 追加一次后收敛；
      // 不做程序化滚动的收敛计数（行高/视口跨机器有像素级差异，会变成假红）。
      await ctx.page.goto(`${ctx.origin}/lazy-list.html`, { waitUntil: "load", timeout: 15_000 });
      const settled = await waitStable(ctx.page, LAZY_EXPR);
      const pool = await extractElements(ctx.page as unknown as PageLike, true);
      return { settled, pool: poolProjection(pool) };
    },
  },
  {
    name: "overlay",
    run: async (ctx) => {
      // ① 遮罩出现（2.5s 定时器）：确定性等待「可见」而不是 sleep 猜。
      await ctx.page.goto(`${ctx.origin}/overlay.html`, { waitUntil: "load", timeout: 15_000 });
      await waitTrue(ctx.page, OVERLAY_VISIBLE_EXPR, 10_000);
      const overlayOnPool = await extractElements(ctx.page as unknown as PageLike, true);
      const overlayOn = {
        dom: await ctx.page.evaluate(DOM_EXPR),
        pool: poolProjection(overlayOnPool),
        hints: hintFacts(["确认提交", "我知道了"], overlayOnPool),
      };
      // ② 对照 ?overlay=0：不走定时器，恒不可见（静态事实，跑两次不变）。
      await ctx.page.goto(`${ctx.origin}/overlay.html?overlay=0`, { waitUntil: "load", timeout: 15_000 });
      const overlayOffPool = await extractElements(ctx.page as unknown as PageLike, true);
      return {
        overlay_on: overlayOn,
        overlay_off: { dom: await ctx.page.evaluate(DOM_EXPR), pool: poolProjection(overlayOffPool) },
      };
    },
  },
  {
    name: "pool-dedup-parent-label",
    // ① 父子同 label：默认留父剔子（region-a 的 button 让位）；监听章在子 → 留子剔父
    //（region-b 的 div 让位）。被剔账 why = label-dup / listener-child 各一条。
    run: async (ctx) => await observePoolDedup(ctx, "pool-dedup/dup-parent-label.html"),
  },
  {
    name: "pool-dedup-deco-child",
    // ② 装饰子：自绘按钮 div 与文本 span 同文案、双方带监听章 → 留父剔子（why=label-dup）。
    run: async (ctx) => await observePoolDedup(ctx, "pool-dedup/deco-child.html"),
  },
  {
    name: "pool-dedup-empty-child",
    // ③ 空名子：页签 li 与空 label 图标 i → 剔子留父（why=empty-child×2）；li 保持 atomic。
    run: async (ctx) => await observePoolDedup(ctx, "pool-dedup/empty-child.html"),
  },
  {
    name: "pool-dedup-card-independent",
    // ④ 卡内独立按钮（不同 label）→ 两者都留，不误杀；空名容器包装层（icon 型按钮）与
    // 内层原子按钮都留且**atomic 子排前**（类目维排序：container 只降权不除名）。
    run: async (ctx) => await observePoolDedup(ctx, "pool-dedup/card-independent.html"),
  },
  {
    name: "pool-dedup-unit-sibling",
    // ⑤ 同卡兄弟同 label（Maps 结果卡同构）：互不包含、共享 role=article 交互祖先、
    // 组内恰一个 native（覆盖链接）→ 执行者留、标题 div 出池（why=unit-sibling）。
    run: async (ctx) => await observePoolDedup(ctx, "pool-dedup/unit-sibling.html"),
  },
  {
    name: "pool-dedup-long-list-64",
    // ⑤ 61 控件全在首屏网格：64 帽全入池、item-50 可达（40 帧下它被挤出窗口）。
    run: async (ctx) => {
      const out = await observePoolDedup(ctx, "pool-dedup/long-list-64.html");
      return { ...out, target_in_pool: out["pool"] !== undefined
        ? Object.values((out["pool"] as { rows: Array<Record<string, unknown>> }).rows)
            .some((r) => r["id"] === "target-50")
        : false };
    },
  },
  {
    name: "pool-dedup-hit-descendant",
    // hit-test 语义锚：容器候选的中心点被自己的绝对定位子元素盖住——页面事实 = 后代命中
    //（executor 的 HIT_JS/HIT_DETAIL_JS/DRF _declaredHitTest 对这种形态放行，绝不判 covered）。
    run: async (ctx) => {
      const out = await observePoolDedup(ctx, "pool-dedup/hit-descendant.html");
      return { ...out, center_hit: await ctx.page.evaluate(CENTER_HIT_EXPR) };
    },
  },
  {
    name: "hydrate-delay-default",
    // F89 缺省门：水合在稳定窗口内 → 双门等出水合（settled:true）且行内有值。
    run: async (ctx) => await observeSessionExtract(ctx, "?delay=1000", {}),
  },
  {
    name: "hydrate-delay-optout",
    // F89 opt-out（请求级 waitSettled:false）：跳过双门 → 骨架态如实（空值 + blank_rows>0
    // + settled 缺席——无门无证据，绝不谎报稳定）。
    run: async (ctx) => await observeSessionExtract(ctx, "?delay=3000", { waitSettled: false }),
  },
  {
    name: "hydrate-delay-static",
    // F89 静态页：双门首轮即稳 ≈ 零额外等待（settled:true，耗时口径与 E5 同量级）。
    run: async (ctx) => await observeSessionExtract(ctx, "?delay=0", {}),
  },
  {
    name: "secret-input",
    // 敏感输入的活值不是身份：password/file/hidden 的 value 不得出现在池行 / observe 行 /
    // 被剔账（这三个面各自有一份 label 实现，golden 把「三面同口径 + 敏感值零泄漏」钉住）。
    run: async (ctx) => {
      const out = await observePoolDedup(ctx, "secret-input.html");
      const observed = await observePage(ctx.page as unknown as PageLike, { max: 60 });
      return {
        ...out,
        observe: {
          elements: observed.elements.map((e) => ({ tag: e.tag, type: e.type ?? "", label: e.label ?? "" })),
        },
      };
    },
  },
];

/**
 * 懒渲染稳定读（会话 extract 缺省门）夹具观测：起一个**独立** SessionRuntime（自带浏览器，
 * 与池观测的 browserSession 互不影响）驱动会话 extract——这是 F89 的消费面（会话 extract 面；
 * app 面 ctx.extract 不在本批范围）。断言钉住三件事：
 *   - 缺省路径（?delay=1000，水合在稳定窗口内）：行内有值 + settled:true；
 *   - opt-out（?delay=3000，水合在窗口外）：空值 + blank_rows>0 + settled 缺席（无门无证据）；
 *   - 静态页（?delay=0）：settled:true（双门首轮即稳 ≈ 零额外等待，耗时口径与 E5 同量级）。
 * golden 只钉确定性事实（行值/键/布尔），不钉耗时。
 */
async function observeSessionExtract(ctx: ObservationContext, query: string, req: Record<string, unknown>): Promise<Record<string, unknown>> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-verify-extract-"));
  const sink: SessionSink = { respond: () => {}, log: () => {} };
  const runtime = new SessionRuntime(
    { url: `${ctx.origin}/hydrate-delay.html${query}`, outDir, quiet: true, env: process.env },
    sink,
  );
  const dispatch = (runtime as unknown as { dispatch(req: Record<string, unknown>): Promise<Record<string, unknown>> }).dispatch.bind(runtime);
  try {
    await dispatch({ type: "open", url: `${ctx.origin}/hydrate-delay.html${query}` });
    const r = await dispatch({ type: "extract", rows: ".h-row", fields: { name: "." }, ...req });
    const rows = Array.isArray(r["rows"]) ? r["rows"] as Array<Record<string, unknown>> : [];
    return {
      count: r["count"],
      first_row: rows[0] ?? null,
      blank_rows: r["blank_rows"],
      has_settled: "settled" in r,
      settled: r["settled"],
      scroll_settled: r["scroll_settled"],
    };
  } finally {
    await dispatch({ type: "close" });
  }
}

/** 跑全部夹具：返回 `{ case名: 观测 }` + 外部请求清单。 */
async function observeAll(origin: string, page: AnyPage): Promise<{ observations: Record<string, unknown>; external: string[] }> {
  const external: string[] = [];
  const onRequest = (req: { url(): string }): void => {
    const url = req.url();
    if (url.startsWith(origin) || url.startsWith("data:") || url === "about:blank") return;
    external.push(url);
  };
  const withOn = page as unknown as { on(event: string, cb: (req: { url(): string }) => void): void };
  withOn.on("request", onRequest);
  const observations: Record<string, unknown> = {};
  try {
    for (const testCase of CASES) {
      observations[testCase.name] = await testCase.run({ page, origin });
    }
  } finally {
    // 观测已结束；外部请求清单随 golden 一起入库（必须恒为 []）。
    observations["external_requests"] = [...external].sort();
  }
  return { observations, external };
}

/* ------------------------------------------------------------------ golden I/O */

function goldenPath(name: string): string {
  return path.join(GOLDEN_DIR, `${name}.json`);
}

function goldenOf(name: string, observations: Record<string, unknown>): Record<string, unknown> {
  return { _doc: GOLDEN_DOC, schema_version: 1, fixture: name, expected: observations };
}

/** 每个 case 的 expected 都带外部请求清单（必须恒为 []；本 lane 的不联网自证入库）。 */
function expectedOf(observations: Record<string, unknown>, name: string): Record<string, unknown> {
  const external = Array.isArray(observations["external_requests"]) ? observations["external_requests"] : [observations["external_requests"]];
  return { ...(observations[name] as Record<string, unknown>), external_requests: external };
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

/** 记录全部 golden（先清掉不属于当前 case 集合的旧文件，保持目录与夹具一一对应）。 */
function record(observations: Record<string, unknown>): number {
  if (!fs.existsSync(GOLDEN_DIR)) fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  for (const testCase of CASES) fs.writeFileSync(goldenPath(testCase.name), stableStringify(goldenOf(testCase.name, expectedOf(observations, testCase.name))), "utf8");
  const keep = new Set(CASES.map((c) => `${c.name}.json`));
  for (const file of fs.readdirSync(GOLDEN_DIR)) {
    if (file.endsWith(".json") && !keep.has(file)) {
      fs.rmSync(path.join(GOLDEN_DIR, file));
      console.log(`verify-offline: 删除过期 golden ${file}`);
    }
  }
  console.log(`verify-offline: 已记录 ${CASES.length} 个夹具基线 → tools/golden/offline/`);
  return 0;
}

/** 比对全部 golden；返回问题列表（空 = 绿）。 */
function check(observations: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const external = observations["external_requests"];
  if (!Array.isArray(external) || external.length !== 0) {
    problems.push(`外部请求必须为 0（本 lane 不联网），实际：${JSON.stringify(external)}`);
  }
  if (!fs.existsSync(GOLDEN_DIR)) {
    problems.push("缺少 tools/golden/offline/ 基线——运行 --record 生成（非门禁 lane，基线需入库）");
    return problems;
  }
  const expectedFiles = new Set(CASES.map((c) => `${c.name}.json`));
  const present = fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json")).sort();
  for (const file of present) {
    if (!expectedFiles.has(file)) problems.push(`过期 golden：${file}（夹具已不存在；--record 会清理）`);
  }
  for (const testCase of CASES) {
    const file = goldenPath(testCase.name);
    if (!fs.existsSync(file)) { problems.push(`缺少 golden：${path.relative(REPO, file)}（--record 生成）`); continue; }
    let golden: unknown;
    try {
      golden = readJson(file);
    } catch (err) {
      problems.push(`${testCase.name}: golden JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const expected = (golden as { expected?: unknown }).expected;
    // 比对在「元素身份视图」上进行：ref 编号漂移不红，池构成/命中身份/数量变化照红。
    const actualText = stableStringify(identityView(expectedOf(observations, testCase.name)));
    const expectedText = stableStringify(identityView(expected));
    if (actualText === expectedText) continue;
    // 首个差异：给出行号 + 左右值，便于定位（不打印整份 golden）。
    const expLines = expectedText.split("\n");
    const actLines = actualText.split("\n");
    for (let i = 0; i < Math.max(expLines.length, actLines.length); i++) {
      if (expLines[i] === actLines[i]) continue;
      problems.push(`${testCase.name}: 观测与 golden 不一致（首个差异第 ${i + 1} 行）\n    golden: ${expLines[i] ?? "<无>"}\n    实际:   ${actLines[i] ?? "<无>"}`);
      break;
    }
  }
  return problems;
}

function list(): number {
  if (!fs.existsSync(GOLDEN_DIR)) {
    console.log("verify-offline: 没有 golden 目录（先 --record）");
    return 0;
  }
  const files = fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json")).sort();
  console.log(`verify-offline: 夹具 ${CASES.map((c) => c.name).join(" / ")}；golden ${files.length} 个`);
  return 0;
}

/* ------------------------------------------------------------------ 主流程 */

async function main(argv: string[]): Promise<number> {
  for (const arg of argv) {
    if (!["--check", "--record", "--list"].includes(arg)) {
      console.error(`verify-offline: 未知参数 ${JSON.stringify(arg)}`);
      console.error(USAGE);
      return 2;
    }
  }
  if (argv.includes("--list")) return list();
  const recordMode = argv.includes("--record");
  if (!fs.existsSync(FIXTURES)) {
    console.error(`verify-offline: 夹具目录不存在：${path.relative(REPO, FIXTURES)}`);
    return 2;
  }
  const htmlCount = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".html")).length;
  if (htmlCount < EXAMPLE_COUNT) {
    console.error(`verify-offline: fixtures/engine 只有 ${htmlCount} 个 .html（基线要求 ${EXAMPLE_COUNT} 个）`);
    return 2;
  }

  const server = await startFixtureServer(FIXTURES);
  let session: Awaited<ReturnType<typeof browserSession>> | null = null;
  try {
    try {
      session = await browserSession(true);
    } catch (err) {
      console.error(`verify-offline: 启动无头 chromium 失败：${err instanceof Error ? err.message : String(err)}`);
      console.error("  补齐环境：npm ci && npx playwright install chromium；体检：npm run doctor");
      return 2;
    }
    const { observations, external } = await observeAll(server.origin, session.page);
    if (recordMode) return record(observations);
    const problems = check(observations);
    if (external.length > 0) {
      // 双保险：check() 里已把 external_requests 作为问题；这里保持错误面显眼。
      console.error(`verify-offline: 检测到 ${external.length} 个外部请求（本 lane 不联网）：${external.join(", ")}`);
    }
    for (const problem of problems) console.error(`verify-offline: ${problem}`);
    if (problems.length > 0) {
      console.error(`verify-offline: FAIL — ${problems.length} 个问题；夹具/引擎行为变化时先确认是预期变更，再 --record 更新基线`);
      return 1;
    }
    console.log(`verify-offline: OK — ${CASES.length} 个夹具页的确定性观测与 golden 一致（无外部请求，未调模型）`);
    return 0;
  } finally {
    if (session !== null) await session.close();
    await server.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
