/**
 * verify-dedup-controls —— **非门禁**的池构成证据 lane：空名可编辑原生控件不被 empty-child 裁决剔除。
 *
 * 缺陷面（F86 一区域一候选去重的边界错）：`__dedupPoolRows` 在"候选祖先包含 + 子为空名"
 * 时无条件剔子（理由：空名 = 无独立身份 / 装饰）。但 input/select/textarea 的 label 为空
 * 只等于"模型无法按 label 寻址"，控件本身仍是这块区域里**唯一的写入口**：剔出池后
 * fill/type/select 只能走池外回退，值写不进去（已复现：fill 被静默降级成 click）。
 * 修复 = 三件可编辑原生控件不因空名剔；空名 a/button 不豁免（无写语义，air 文案控件
 * 人也判断不出点的是什么），label-dup / listener-child / unit-sibling 规则不变。
 *
 * 断言（全部经真实 `extractElements`，不 mock 池；夹具由本地静态服务供给，不联网）：
 *   ① `fixtures/engine/pool-dedup/empty-child-control.html`：像 input/select/textarea
 *      三件空名可编辑控件**全部进池**（ref/tag/label 事实、label 可为空），各控件的
 *      候选祖先 wrapper 仍在池且是 kind=container；页面无 `data-dshdrop` 章、
 *      windowAudit 无 dedup_dropped 键（= 没有发生 empty-child 剔除）。
 *   ② `fixtures/engine/pool-dedup/empty-child.html`：纯图标空名子（`<i>`）**仍被剔**，
 *      被剔账 why=empty-child、章名同源——证明豁免面没有扩大到非可编辑节点。
 *   ③ 证据形状：`DEDUP_DROP_ATTR` = 页面章名、why ∈ `DEDUP_WHY_CODES`、
 *      `dedup_dropped` 条目恰为 `{tag,label,why}` 三键字符串。
 * 另证**前件**：每个空名控件都有池内候选祖先（被删分支的命中前件），说明夹具确实复现
 * 原缺陷形态，不是靠改夹具绕开规则；tested HTML 的 value 只作 property 写入（attribute
 * 为空），池行 label 因此仍为空。
 *
 * 用法：node --experimental-strip-types tools/verify-dedup-controls.ts [--json]
 * 退出码：0 全绿 / 1 有断言失败 / 2 用法或环境错误（夹具缺失、chromium 起不来）。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { extractElements } from "../src/app/candidate-scan.ts";
import { browserSession } from "../src/engine/executor.ts";
import type { AnyPage } from "../src/engine/executor-types.ts";
import { type ElemPool, type PageLike, windowAudit } from "../src/engine/extraction.ts";
import { DEDUP_DROP_ATTR, DEDUP_WHY_CODES } from "../src/engine/pool-js.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(REPO, "fixtures", "engine");
const CONTROL_FIXTURE = "pool-dedup/empty-child-control.html";
const ICON_FIXTURE = "pool-dedup/empty-child.html";
const USAGE = "usage: node --experimental-strip-types tools/verify-dedup-controls.ts [--json]";
/** 池侧盖章属性名（`[data-dshref]` 是 `_locatorFor` 的稳定句柄；页内事实读它判"是否进池"）。 */
const REF_ATTR = "data-dshref";
const EDITABLE_TAGS = ["input", "select", "textarea"] as const;
/** 控制夹具里的空名控件（DOM id → 期望 tag）。 */
const CONTROL_IDS = ["free-text", "free-select", "free-note"] as const;
/** 图标夹具里应继续被剔的空名装饰子。 */
const ICON_IDS = ["icon-ow", "icon-rt"] as const;

interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

interface PoolRowView {
  ref: string;
  dsh_ref: string;
  tag: string;
  label: string;
  name: string;
  id: string;
  kind: string;
  scan: number;
}

interface HostFact {
  tag: string;
  ref: string;
}

interface ElementFacts {
  tag: string;
  in_pool: boolean;
  ref: string | null;
  drop_why: string | null;
  aria_label: string | null;
  title: string | null;
  placeholder: string | null;
  value_attr: string | null;
  inner_text: string;
  value_property: string;
  host: HostFact | null;
}

type FactMap = Record<string, ElementFacts | null>;

interface Check {
  name: string;
  ok: boolean;
  actual: unknown;
  expected: unknown;
}

/* ------------------------------------------------------------------ 夹具服务 */

/** 只服务 `fixtures/engine/` 下 .html 的本地静态服务（监听随机端口，仅 127.0.0.1）。 */
async function startFixtureServer(root: string): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
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

/* ------------------------------------------------------------------ 页内事实 */

/**
 * 读若干 id 元素的"是否进池 / 被剔章 / label 三源 / 最近池内候选祖先"事实。
 * 表达式是字符串（浏览器侧执行，root tsconfig 不带 DOM lib）；`data-dshref` 由
 * EXTRACT_JS 在每次建池末尾盖，读它 = 该元素属于**本次**池（旧章已被开头清章）。
 */
function factsExpr(ids: readonly string[]): string {
  return `(() => {
    const ids = ${JSON.stringify(ids)};
    const dropAttr = ${JSON.stringify(DEDUP_DROP_ATTR)};
    const refAttr = ${JSON.stringify(REF_ATTR)};
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) { out[id] = null; continue; }
      let host = null;
      let p = el.parentElement;
      for (let g = 0; p && g < 32; g++, p = p.parentElement) {
        if (p.hasAttribute(refAttr)) { host = { tag: p.tagName.toLowerCase(), ref: p.getAttribute(refAttr) }; break }
      }
      out[id] = {
        tag: el.tagName.toLowerCase(),
        in_pool: el.hasAttribute(refAttr),
        ref: el.getAttribute(refAttr),
        drop_why: el.getAttribute(dropAttr),
        aria_label: el.getAttribute('aria-label'),
        title: el.getAttribute('title'),
        placeholder: el.getAttribute('placeholder'),
        value_attr: el.getAttribute('value'),
        inner_text: String(el.innerText || '').trim(),
        value_property: String(el.value == null ? '' : el.value),
        host: host,
      };
    }
    return out;
  })()`;
}

/* ------------------------------------------------------------------ 观测 */

function poolRows(pool: ElemPool): PoolRowView[] {
  return Object.entries(pool)
    .map(([ref, elem]) => ({
      ref,
      dsh_ref: String(elem.dsh_ref ?? ""),
      tag: String(elem.tag ?? ""),
      label: String(elem.label ?? ""),
      name: String(elem.name ?? ""),
      id: String(elem.id ?? ""),
      kind: String(elem.kind ?? ""),
      scan: Number(elem.scan ?? -1),
    }))
    .sort((a, b) => a.scan - b.scan || a.ref.localeCompare(b.ref));
}

interface FixtureObservation {
  rows: PoolRowView[];
  shown: number;
  audit: Awaited<ReturnType<typeof windowAudit>>;
  facts: FactMap;
}

async function observeFixture(
  page: AnyPage, origin: string, fixture: string, factsIds: readonly string[],
): Promise<FixtureObservation> {
  await page.goto(`${origin}/${fixture}`, { waitUntil: "load", timeout: 15_000 });
  const asPageLike = page as unknown as PageLike;
  const pool = await extractElements(asPageLike, true);
  const shown = Object.keys(pool).length;
  // 先建池再读页内事实：data-dshref 是本次建池盖的章，读事实必须在提取之后。
  const facts = (await page.evaluate(factsExpr(factsIds))) as unknown as FactMap;
  const audit = await windowAudit(asPageLike, shown, 10);
  return { rows: poolRows(pool), shown, audit, facts };
}

/* ------------------------------------------------------------------ 断言 */

function expect(checks: Check[], name: string, actual: unknown, expected: unknown): void {
  checks.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
}

function requireFacts(checks: Check[], facts: FactMap, ids: readonly string[]): void {
  for (const id of ids) expect(checks, `#${id}: 夹具元素存在`, facts[id] !== null && facts[id] !== undefined, true);
}

function checkControlFixture(checks: Check[], obs: FixtureObservation, evidence: Record<string, unknown>): void {
  const tag = CONTROL_FIXTURE;
  const editableRows = obs.rows.filter((r) => (EDITABLE_TAGS as readonly string[]).includes(r.tag));
  expect(checks, `${tag}: 进池的可编辑控件行数`, editableRows.length, 3);
  expect(checks, `${tag}: 进池的可编辑控件 tag（DOM 序）`, editableRows.map((r) => r.tag), ["input", "select", "textarea"]);
  expect(checks, `${tag}: 可编辑控件 label 可为空（池行 label 全空）`, editableRows.map((r) => r.label), ["", "", ""]);
  expect(checks, `${tag}: 可编辑控件都带池 ref + 盖章句柄`, editableRows.every((r) => r.ref !== "" && r.dsh_ref !== ""), true);
  const inputRow = obs.rows.find((r) => r.tag === "input");
  expect(checks, `${tag}: 空名 input 进池（#free-text 有池行）`, inputRow ? { tag: inputRow.tag, label: inputRow.label, id: inputRow.id } : null, { tag: "input", label: "", id: "free-text" });
  // label 空不等于不可寻址：name 属性保留在行上（池外回退/属性寻址的底座），模型面能看到。
  expect(checks, `${tag}: 空名 input 的 name 仍可读（池行 name=q）`, inputRow?.name ?? null, "q");
  expect(checks, `${tag}: 空名 select/textarea 同样进池`, editableRows.filter((r) => r.tag !== "input").map((r) => r.id), ["free-select", "free-note"]);

  requireFacts(checks, obs.facts, CONTROL_IDS);
  // 前件：每个空名控件都在一个池内候选祖先之下——这正是被删 empty-child 分支的命中形态。
  for (const id of CONTROL_IDS) {
    const f = obs.facts[id];
    if (!f) continue;
    expect(checks, `#${id}: 无 data-dshdrop 章（未被 empty-child 剔）`, f.drop_why, null);
    expect(checks, `#${id}: label 三源全空（aria-label/title/placeholder/value attribute）`, [f.aria_label, f.title, f.placeholder, f.value_attr], [null, null, null, null]);
    const hostRow = f.host === null ? undefined : obs.rows.find((r) => r.dsh_ref === f.host?.ref);
    expect(checks, `#${id}: 有池内候选祖先（empty-child 前件）`, hostRow !== undefined, true);
    expect(checks, `#${id}: 候选祖先仍是 kind=container`, hostRow?.kind ?? "", "container");
  }
  expect(checks, `${tag}: value 只作 property 写入（#free-text）`, obs.facts["free-text"]?.value_property, "only-property-value");
  expect(checks, `${tag}: value 只作 property 写入（#free-note）`, obs.facts["free-note"]?.value_property, "typed note");
  expect(checks, `${tag}: 页面已无任何被剔章`, CONTROL_IDS.map((id) => obs.facts[id]?.drop_why ?? null), [null, null, null]);

  const wrapperRows = obs.rows.filter((r) => r.tag === "div");
  expect(checks, `${tag}: 三个 wrapper 仍在池`, wrapperRows.length, 3);
  expect(checks, `${tag}: wrapper 仍是容器（只降权不除名）`, wrapperRows.every((r) => r.kind === "container"), true);
  expect(checks, `${tag}: wrapper label 为空`, wrapperRows.map((r) => r.label), ["", "", ""]);
  expect(checks, `${tag}: windowAudit 无 dedup_dropped 键（无被剔）`, "dedup_dropped" in obs.audit, false);
  expect(checks, `${tag}: 可见交互计数（3 wrapper + 3 控件）`, obs.audit.visible_interactive, 6);
  expect(checks, `${tag}: shown = 池大小`, obs.audit.shown, obs.shown);

  evidence["control_fixture"] = {
    fixture: tag,
    pool: obs.rows,
    editable_in_pool: editableRows,
    legacy_empty_child_precondition: CONTROL_IDS.map((id) => {
      const f = obs.facts[id];
      const poolLabel = editableRows.find((r) => r.id === id)?.label ?? null;
      return {
        id,
        tag: f?.tag ?? null,
        pool_label: poolLabel,
        candidate_host: f?.host ?? null,
        candidate_host_kind: f?.host === null || f === null || f === undefined ? null : (obs.rows.find((r) => r.dsh_ref === f.host?.ref)?.kind ?? null),
        // 被删分支的命中前件：候选行 label 为空 + 有池内候选祖先 + tag 属可编辑原生控件。
        matches_removed_branch_precondition: poolLabel === "" && f != null && f.host !== null
          && (EDITABLE_TAGS as readonly string[]).includes(f.tag),
      };
    }),
    data_dshdrop: CONTROL_IDS.map((id) => ({ id, drop_why: obs.facts[id]?.drop_why ?? null })),
    window_audit: {
      visible_interactive: obs.audit.visible_interactive,
      shown: obs.audit.shown,
      dedup_dropped: "dedup_dropped" in obs.audit ? obs.audit.dedup_dropped : "absent",
    },
  };
}

function checkIconFixture(checks: Check[], obs: FixtureObservation, evidence: Record<string, unknown>): void {
  const tag = ICON_FIXTURE;
  expect(checks, `${tag}: 池构成不变（只有 2 个 li）`, obs.rows.map((r) => `${r.tag}#${r.id}`), ["li#tab-ow", "li#tab-rt"]);
  expect(checks, `${tag}: li 的 label 仍可读`, obs.rows.map((r) => r.label), ["单程", "往返"]);
  requireFacts(checks, obs.facts, ICON_IDS);
  for (const id of ICON_IDS) {
    const f = obs.facts[id];
    if (!f) continue;
    expect(checks, `#${id}: <i> 不在池（无池 ref）`, f.ref, null);
    expect(checks, `#${id}: <i> 仍被 empty-child 剔（章名同源）`, f.drop_why, "empty-child");
    const hostRow = f.host === null ? undefined : obs.rows.find((r) => r.dsh_ref === f.host?.ref);
    expect(checks, `#${id}: 被剔图标挂在池内 li 之下（父子同区域形态不变）`, hostRow?.tag ?? "", "li");
  }

  const drops = obs.audit.dedup_dropped ?? [];
  expect(checks, `${tag}: dedup_dropped 恰 2 条 i/empty-child`, drops.map((d) => [d.tag, d.label, d.why]), [["i", "", "empty-child"], ["i", "", "empty-child"]]);
  expect(checks, `${tag}: dedup_dropped 条目键恰为 tag/label/why`, drops.map((d) => Object.keys(d).sort().join(",")), ["label,tag,why", "label,tag,why"]);
  expect(checks, `${tag}: dedup_dropped 条目值均为字符串`, drops.every((d) => typeof d.tag === "string" && typeof d.label === "string" && typeof d.why === "string"), true);
  expect(checks, `${tag}: 被剔 why ∈ DEDUP_WHY_CODES`, drops.every((d) => (DEDUP_WHY_CODES as readonly string[]).includes(d.why)), true);

  evidence["icon_fixture"] = {
    fixture: tag,
    pool: obs.rows,
    dropped: drops,
    data_dshdrop: ICON_IDS.map((id) => ({ id, drop_why: obs.facts[id]?.drop_why ?? null })),
    non_editable_children_still_dropped: drops.length === 2 && drops.every((d) => d.why === "empty-child"),
  };
}

function checkEvidenceShape(checks: Check[], evidence: Record<string, unknown>): void {
  expect(checks, "DEDUP_DROP_ATTR 与夹具读取的章名同源", DEDUP_DROP_ATTR, "data-dshdrop");
  expect(checks, "why 闭集包含 empty-child", (DEDUP_WHY_CODES as readonly string[]).includes("empty-child"), true);
  expect(checks, "why 闭集未被本豁免改写（label-dup/listener-child/unit-sibling 仍在）",
    ["label-dup", "listener-child", "unit-sibling"].every((why) => (DEDUP_WHY_CODES as readonly string[]).includes(why)), true);
  evidence["evidence_shape"] = {
    drop_attr: DEDUP_DROP_ATTR,
    why_codes: DEDUP_WHY_CODES,
    control_dropped: "absent",
    icon_why: "empty-child",
  };
}

/* ------------------------------------------------------------------ 主流程 */

function printHuman(checks: Check[], evidence: Record<string, unknown>): void {
  const failed = checks.filter((c) => !c.ok);
  for (const c of failed) {
    console.error(`[FAIL] ${c.name}\n  期望: ${JSON.stringify(c.expected)}\n  实际: ${JSON.stringify(c.actual)}`);
  }
  console.log(JSON.stringify(evidence, null, 2));
  console.log("");
  if (failed.length > 0) {
    console.error(`verify-dedup-controls: FAIL — ${failed.length}/${checks.length} 条断言未通过`);
    return;
  }
  console.log(`verify-dedup-controls: OK — ${checks.length} 条断言全过（空名可编辑控件进池 + 空名图标仍被剔）`);
}

async function main(argv: string[]): Promise<number> {
  for (const arg of argv) {
    if (arg !== "--json") {
      console.error(`verify-dedup-controls: 未知参数 ${JSON.stringify(arg)}`);
      console.error(USAGE);
      return 2;
    }
  }
  const jsonOnly = argv.includes("--json");
  for (const [fixture, rel] of [[CONTROL_FIXTURE, "控制夹具"], [ICON_FIXTURE, "图标夹具"]] as const) {
    const abs = path.join(FIXTURES, fixture);
    if (!fs.existsSync(abs)) {
      console.error(`verify-dedup-controls: 缺少${rel} ${path.relative(REPO, abs)}`);
      return 2;
    }
  }

  const server = await startFixtureServer(FIXTURES);
  let session: Awaited<ReturnType<typeof browserSession>> | null = null;
  try {
    try {
      session = await browserSession(true);
    } catch (err) {
      console.error(`verify-dedup-controls: 启动无头 chromium 失败：${err instanceof Error ? err.message : String(err)}`);
      console.error("  补齐环境：npm ci && npx playwright install chromium；体检：npm run doctor");
      return 2;
    }
    const checks: Check[] = [];
    const evidence: Record<string, unknown> = {};
    const control = await observeFixture(session.page, server.origin, CONTROL_FIXTURE, CONTROL_IDS);
    checkControlFixture(checks, control, evidence);
    const icon = await observeFixture(session.page, server.origin, ICON_FIXTURE, ICON_IDS);
    checkIconFixture(checks, icon, evidence);
    checkEvidenceShape(checks, evidence);
    evidence["checks"] = checks.map((c) => ({ name: c.name, ok: c.ok, ...(c.ok ? {} : { actual: c.actual, expected: c.expected }) }));
    evidence["ok"] = checks.every((c) => c.ok);
    if (jsonOnly) {
      console.log(JSON.stringify(evidence, null, 2));
    } else {
      printHuman(checks, evidence);
    }
    return checks.every((c) => c.ok) ? 0 : 1;
  } finally {
    if (session !== null) await session.close();
    await server.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
