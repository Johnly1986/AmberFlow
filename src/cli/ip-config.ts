/**
 * 摄像头 IP 规划表 → 网络设置页批量配置（TS twin of `ip_config.py`）。
 *
 * 输入：`camera_ips.xlsx`（序列号 / ip / 子网掩码 / 网关；缺文件时生成演示表）
 * 每台设备一份冻结计划，表格整行就是这份计划的数据袋：
 *   1. 门户页按序列号进入该设备的网络设置页（4 个链接文字全同，只有 hint 能区分）；
 *   2. 断言打开的正是这台设备（页面回显的序列号必须匹配）；
 *   3. 保存时执行器在点击前用表格值预填 ip/掩码/网关（值只来自数据袋）；
 *   4. 风险闸门确认后点保存；完成只认设备页回显的成功信号；
 *   5. 被设备页自身校验拒绝的行，读它自己的错误文案，如实报 REJECTED。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { MockAuditor, type Auditor } from "../engine/audit.ts";
import { BrowserMiddleware, browserSession, type BrowserSession } from "../engine/executor.ts";
import { TaskPlan } from "../engine/plan.ts";
import { checkSignal } from "../engine/signals.ts";
import { firstOf } from "../engine/extraction.ts";
import { REPO } from "../flow/flow.ts";
import { applyRcToEnv } from "../support/rcfile.ts";

export const PAGES = path.join(REPO, "testpages");
export const XLSX = path.join(REPO, "camera_ips.xlsx");
export const PORTAL = new URL(`file://${path.join(PAGES, "net_portal.html")}`).href;

export interface IpRow {
  序列号: string | number;
  ip: string | number;
  子网掩码: string | number;
  网关: string | number;
  [k: string]: unknown;
}

export const DEMO_ROWS: IpRow[] = [
  { 序列号: "CAM-1001", ip: "10.0.1.11", 子网掩码: "255.255.255.0", 网关: "10.0.1.1" },
  { 序列号: "CAM-1002", ip: "10.0.1.12", 子网掩码: "255.255.255.0", 网关: "10.0.1.1" },
  { 序列号: "PTZ-2001", ip: "10.0.2.21", 子网掩码: "255.255.255.0", 网关: "10.0.2.1" },
  // 规划表写错的行（第 4 段 999）：设备页自己的校验会拒绝，用来演示 REJECTED 路径
  { 序列号: "CAM-1003", ip: "10.0.1.999", 子网掩码: "255.255.255.0", 网关: "10.0.1.1" },
];

/** Sheet row -> plain object; blank cells become null (pandas NaN). */
function rowsFromSheet(ws: ExcelJS.Worksheet): IpRow[] {
  const headers: string[] = [];
  ws.getRow(1).eachCell((cell, col) => {
    headers[col] = String(cell.value ?? "").trim();
  });
  const out: IpRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (row.values === undefined) continue;
    const obj: Record<string, unknown> = {};
    let empty = true;
    headers.forEach((h, col) => {
      if (!h) return;
      const v = row.getCell(col).value;
      const val = v === undefined || v === null || v === "" ? null
        : typeof v === "object" && v !== null && "text" in (v as object)
          ? (v as { text: string }).text : v;
      obj[h] = val;
      if (val !== null) empty = false;
    });
    if (!empty) out.push(obj as IpRow);
  }
  return out;
}

/** Generic sheet reader: row 1 is the header, blank cells become null. */
export async function readSheet(file: string): Promise<Array<Record<string, unknown>>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return rowsFromSheet(wb.worksheets[0]!) as unknown as Array<Record<string, unknown>>;
}

export async function readXlsx(file = XLSX): Promise<IpRow[]> {
  return (await readSheet(file)) as unknown as IpRow[];
}

/** Read the plan sheet, creating the demo sheet on first run (like the Python CLI). */
export async function ensureXlsx(file = XLSX): Promise<IpRow[]> {
  try {
    return await readXlsx(file);
  } catch {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("ips");
    ws.addRow(["序列号", "ip", "子网掩码", "网关"]);
    for (const r of DEMO_ROWS) ws.addRow([r.序列号, r.ip, r.子网掩码, r.网关]);
    await wb.xlsx.writeFile(file);
    console.log(`created demo ${path.basename(file)}`);
    return DEMO_ROWS;
  }
}

export function settingsUrl(sn: string): string {
  return new URL(`file://${path.join(PAGES, "net_settings.html")}?sn=${encodeURIComponent(sn)}`).href;
}

/** One frozen plan per device; the table row is its slots bag. */
export function buildPlan(sn: string, row: IpRow, portal = PORTAL): TaskPlan {
  return new TaskPlan(
    `配置摄像头 ${sn} 的网络参数：ip=${row.ip} mask=${row.子网掩码} gw=${row.网关}`,
    [
      {
        desc: `打开 ${sn} 的网络设置页`,
        // 断言打开的是这台设备：页面回显的序列号必须匹配
        signal: { css_text_contains: ["[data-test=sn]", sn] },
        start_url: portal,
        target_hint: `a[data-test=net-${sn}]`,
      },
      {
        desc: `把规划的 IP / 子网掩码 / 网关 保存到 ${sn}`,
        // 一次点击前预填三个字段；成功信号 = 设备页回显的保存结果
        signal: { css_text_contains: ["[data-test=save-ok]", "已保存"] },
        start_url: settingsUrl(sn),
        target_hint: "button[data-test=net-save]",
      },
    ],
    ".task_state.json",
    { ip: row.ip, mask: row.子网掩码, gw: row.网关 },
  );
}

/**
 * **应用级的计划**：整张规划表 → 一份计划（应用包 `apps/ip-config` 就由它生成）。
 *
 * 为什么它不直接等于 `rows.flatMap(row => buildPlan(...).subgoals)`：应用包的验收语义比
 * "驱动跑一遍"更强，而那部分判断**属于代码、不属于手抄的 JSON**：
 *
 *   1. 保存成功不只认"已保存"，还要认**回显的是这一行规划的值**（`all_of` 两条）——
 *      否则"保存了别的设备/别的值"也会被算成成功；
 *   2. 规划表写错的行（第 4 段 > 255）**预期被设备页拒绝**：完成信号 = 设备页的错误文案
 *      + **被拒绝的正是规划里那个值** + **没有出现"已保存"**，并且这一步带上自己的 `slots`，
 *      好让"被拒绝的值就是规划值"这件事有数据出处（不是从页面抄回来的）。
 *
 * 这两条以前只写在 `apps/ip-config/pack.json` 里（人抄的 JSON，复核方要逐字段核对）。现在它们
 * 是函数，`npm run apps:gen` 从它生成包，`--check` 保证两者不漂移。
 */
export function buildAppPlan(rows: IpRow[] = DEMO_ROWS, portal = PORTAL): TaskPlan {
  const subgoals: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const sn = String(row.序列号);
    const plan = buildPlan(sn, row, portal);
    const malformed = !isIpv4(String(row.ip));
    for (const sg of plan.subgoals) {
      const copy = JSON.parse(JSON.stringify(sg)) as Record<string, unknown>;
      const isSave = String(copy["desc"]).startsWith("把规划的");
      if (!isSave) { subgoals.push(copy); continue; }
      // 每台设备的值必须**跟着它自己那一步**（应用是 4 台设备拼成一条旅程，计划级数据袋装不下）
      copy["slots"] = { ip: String(row.ip), mask: String(row.子网掩码), gw: String(row.网关) };
      if (malformed) {
        copy["desc"] = `把规划的 IP / 子网掩码 / 网关 提交到 ${sn}（规划表写的是 ${String(row.ip)}）`;
        copy["signal"] = {
          all_of: [
            { css_text_contains: ["[data-test=error]", "IP 地址格式错误"] },
            { css_text_contains: ["[data-test=error]", String(row.ip)] },
            { not: { css_text_contains: ["[data-test=save-ok]", "已保存"] } },
          ],
        };
      } else {
        copy["signal"] = {
          all_of: [
            { css_text_contains: ["[data-test=save-ok]", "已保存"] },
            { css_text_contains: ["[data-test=save-ok]", String(row.ip)] },
          ],
        };
      }
      subgoals.push(copy);
    }
  }
  return new TaskPlan(
    "按 Excel IP 规划表把每台设备的 ip / 子网掩码 / 网关写进它自己的网络设置页；"
    + "表格里写错的那一行必须由设备页自己的校验拒绝，并被如实报出来",
    subgoals as never,
    ".task_state.json",
    {},
  );
}

/** 第 4 段 > 255（或不是四段）就是规划表写错的行——与设备页的校验同一条规则。 */
export function isIpv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) <= 255);
}

export interface IpResult {
  sn: string;
  status: "OK" | "REJECTED" | "BLOCKED";
  detail: string;
  audit: { verdict: string; reasons: string[] };
}

export interface IpMainDeps {
  middleware?: BrowserMiddleware;
  sessionFactory?: () => Promise<BrowserSession>;
  auditor?: Auditor;
  confirm?: (desc: string) => boolean;
}

async function readText(
  page: { locator(s: string): { first: unknown } }, sel: string,
): Promise<string> {
  // 页面可能已经不在设备页（例如导航都没成功），读取必须尽力而为。
  // NOTE: Node 的 `locator.first` 是方法（Python 是属性）—— 用 firstOf 适配，
  // 否则这里每次都抛异常并静默返回 ""，REJECTED 会被误报成 BLOCKED。
  try {
    return (await firstOf(page.locator(sel) as never).innerText({ timeout: 2000 })).trim();
  } catch {
    return "";
  }
}

/** Configure every row of the sheet; returns the per-device outcome. */
export async function configureAll(
  rows: IpRow[], deps: IpMainDeps = {},
): Promise<{ results: IpResult[]; exitCode: number }> {
  const demoUser = (desc: string): boolean => {
    // 演示用户：把网络参数写进设备是外部可见动作，闸门问了，他放行
    console.log(`    [demo-user] 允许不可逆动作：${desc}`);
    return true;
  };
  const mw = deps.middleware ?? new BrowserMiddleware({
    confirmFn: deps.confirm ?? demoUser, maxSteps: 8,
    auditor: deps.auditor ?? new MockAuditor(),
  });
  const sessionFactory = deps.sessionFactory ?? (() => browserSession());
  const results: IpResult[] = [];
  // 一张表共用一个浏览器会话（与 bench 同构）：会话/JS 状态跨行存活
  const session = await sessionFactory();
  try {
    for (const row of rows) {
      const sn = String(row.序列号);
      const plan = buildPlan(sn, row);
      console.log(`=== ${sn}  ${row.ip} / ${row.子网掩码} / ${row.网关} ===`);
      const traces: unknown[] = [];
      let blocked: string | null = null;
      for (const sg of plan.subgoals) {
        const rep = await mw.run(sg.desc, sg.start_url!, {
          goalSignalFn: (p: unknown) => checkSignal(p as never, sg.signal),
          slots: plan.slots, page: session.page, pw: session.pw,
          targetHint: sg.target_hint ?? null,
        });
        traces.push(...(rep.steps ?? []));
        if (!rep.done) {
          blocked = rep.stop_reason;
          break;
        }
      }
      let status: IpResult["status"];
      let detail: string;
      if (blocked === null) {
        status = "OK";
        detail = await readText(session.page as never, "[data-test=save-ok]");
      } else {
        // 区分两件事：设备页自己校验拒绝（有错误文案）vs 执行器没能完成
        const pageErr = await readText(session.page as never, "[data-test=error]");
        status = pageErr ? "REJECTED" : "BLOCKED";
        detail = pageErr || blocked;
      }
      const verdict = await mw.auditor.audit(plan.goal, traces as never, blocked === null);
      console.log(`    -> ${status}  ${detail}`);
      console.log(`    audit: ${verdict.verdict}  ${JSON.stringify(verdict.reasons)}\n`);
      results.push({ sn, status, detail, audit: verdict as IpResult["audit"] });
    }
  } finally {
    await session.close();
  }
  const ok = results.filter((r) => r.status === "OK").length;
  const rejected = results.filter((r) => r.status === "REJECTED").length;
  const blockedN = results.filter((r) => r.status === "BLOCKED").length;
  console.log("summary: " + results.map((r) => `${r.sn}=${r.status}`).join(", "));
  console.log(`${ok}/${results.length} configured; ${rejected} rejected by the device page's own validation`
    + (blockedN ? `; ${blockedN} blocked before that` : ""));
  const exitCode = ok === results.length - 1 && rejected === 1 ? 0 : 1;
  return { results, exitCode };
}

export async function main(argv: string[] = process.argv.slice(2), deps: IpMainDeps = {}): Promise<number> {
  // rc 文件坏 = 配置类用法错误：在任何腿出场之前逐行点名并 exit 2（src/support/rcfile.ts）。
  { const rc = applyRcToEnv(); if (rc.errors.length) { for (const e of rc.errors) console.error(e); return 2; } }
  const file = argv.find((a) => a.endsWith(".xlsx")) ?? XLSX;
  const rows = await ensureXlsx(file);
  console.log(`${rows.length} rows from ${path.basename(file)}\n`);
  const { exitCode } = await configureAll(rows, deps);
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
