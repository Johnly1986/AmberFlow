/**
 * task-12（C1，评审 #6 改造后形态）：`amber apps rehearsal <id|路径>` —— **只读预检**。
 *
 * 它与 `apps check` 的关系（一句话）：check = 声明形状（dry 校验调用序列合法）；
 * rehearsal = **可达页面上**的 hint 实况（真导航 + hintMatch 核对）——**两者都不证明完成**。
 * 独立命令，不动 apps check 的任何契约/输出。
 *
 * 做什么：按 `meta.site.pages` 与各步静态声明的 url 真开浏览器纯导航；对每条静态可求值的
 * act hint / 命令 target 在每个可达页面上跑同一个 `hintMatch`（唯一语法出处）核对命中数与
 * 歧义。不执行动作、不计预算、不调模型。
 *
 * 覆盖边界（诚实口径，写进输出）：
 *   - 只证明「该 hint 在可达页面上的命中数/歧义」，**不证明页面状态成立**；
 *   - 没有静态 url 的步骤依赖前置交互才能到达——它们的 hint 在可达页面上没命中属于
 *     **不可达常态**，不是"hint 写错"的判定（两者区分不了，不硬判，Author 自查）；
 *   - visible 口径池面不采（extractElements 不带可见性），以命中数/歧义为准。
 *
 * `--remember`：把「验证 n=1」的 hint 写进 hint-memory sidecar（与 run --remember 同一份
 * `$AMBERFLOW_HOME/hint-memory/<app>.json`；键=(页面 URL, hint 文本)）。运行期 lookup 键是
 * (页面 URL, 步指令)——两键只在指令文本恰为 hint 文本时对齐，所以 sidecar 的主要价值是
 * **给作者/Agent 读已验证清单**；authored hint 恒优先原则不变（sidecar 永不覆盖声明）。
 */
import path from "node:path";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { loadScriptApp, scriptDisplayPath } from "../../app/app-script.ts";
import { scanDeclarations } from "../../app/declaration-scan.ts";
import { resolveCtxUrl } from "../../app/ctx.ts";
import { userAppsDir } from "../../app/amberflow-home.ts";
import { browserSession } from "../../engine/executor.ts";
import { extractElements } from "../../engine/extraction.ts";
import { hintCandidates, hintMatch } from "../../engine/rules.ts";
import { createHintMemory } from "../../model/hint-memory.ts";
import type { CliContext } from "../context.ts";
import { emitJson, say } from "../context.ts";
import { usageError } from "../errors.ts";
import { successEnvelope } from "../json.ts";
import { commandHelp } from "../registry.ts";

interface RehearsalPage {
  url: string;
  source: string;
  error?: string;
  elements?: number;
  /** hint → 本页命中数（仅静态 hint）。 */
  hits: Record<string, number>;
}

interface RehearsalTarget {
  hint: string;
  /** act hint（ctx.hint/hints）或命令 target（ctx.command）。 */
  origin: "act" | "command";
  lines: number[];
  verdict: "verified" | "ambiguous" | "missing";
  pages: Array<{ url: string; count: number }>;
}

function num(v: string | boolean | string[] | undefined): number | undefined {
  const raw = typeof v === "string" ? v : undefined;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function appsRehearsal(args: string[], ctx: CliContext): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args, allowPositionals: true,
      options: {
        remember: { type: "boolean" },
        "hint-memory": { type: "string" },
        "max-elements": { type: "string" },
        timeout: { type: "string" },
        headed: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
    });
  } catch (err) {
    throw usageError(`apps rehearsal 参数不对：${err instanceof Error ? err.message : String(err)}`, {
      next: ["amber apps rehearsal <id> --json"],
    });
  }
  const v = parsed.values;
  if (v.help) { say(ctx, commandHelp("apps")); return 0; }
  const positional = parsed.positionals[0];
  if (!positional) throw usageError("apps rehearsal 需要一个应用 id 或脚本路径", { next: ["amber apps list"] });
  const max = Math.min(200, Math.max(1, Math.floor(num(v["max-elements"]) ?? 120)));
  const timeout = Math.min(120_000, Math.max(1_000, Math.floor(num(v.timeout) ?? 30_000)));
  const wantJson = ctx.globals.json || v.json === true;

  const loaded = await loadScriptApp(positional);
  const pack = loaded.pack;
  const file = path.basename(loaded.scriptPath);
  const scan = scanDeclarations(loaded.sourceText);

  // ① 导航面：meta.site.pages + 各步静态声明的 url（open/arrive/step.url/openPage 角色解析）。
  const pages: RehearsalPage[] = [];
  const seenUrls = new Set<string>();
  const addPage = (rawUrl: unknown, source: string): void => {
    if (typeof rawUrl !== "string" || rawUrl.trim() === "") return;
    let url: string;
    try { url = resolveCtxUrl(rawUrl); } catch { return; }
    if (seenUrls.has(url)) return;
    seenUrls.add(url);
    pages.push({ url, source, hits: {} });
  };
  const sitePages = (pack.site?.pages ?? {}) as Record<string, string>;
  for (const [role, u] of Object.entries(sitePages)) addPage(u, `site.pages.${role}`);
  for (const site of scan.sites) {
    if (site.call === "ctx.open" || site.call === "ctx.arrive") {
      addPage(site.args[0]?.static === true ? site.args[0].value : undefined,
        `${site.call}@${file}:${site.line}`);
    } else if (site.call === "ctx.openPage") {
      const role = site.args[0]?.static === true ? site.args[0].value : undefined;
      if (typeof role === "string") addPage(sitePages[role], `${site.call}(${role})@${file}:${site.line}`);
    } else if (site.call === "ctx.step" && site.args[1]?.static === true) {
      const req = site.args[1].value as Record<string, unknown> | null;
      if (req !== null && typeof req === "object") addPage(req["url"], `ctx.step.url@${file}:${site.line}`);
    }
  }

  // ② 核对面：静态 act hint / 命令 target；dynamic 的只列名不核对（不强解）。
  const targets = new Map<string, RehearsalTarget>();
  const dynamicHints: Array<{ call: string; line: number; col: number }> = [];
  for (const site of scan.sites) {
    const want = (idx: number, origin: "act" | "command"): void => {
      const arg = site.args[idx];
      if (arg === undefined) return;
      if (!arg.static || typeof arg.value !== "string") {
        dynamicHints.push({ call: site.call, line: site.line, col: site.col });
        return;
      }
      const t = targets.get(arg.value) ?? { hint: arg.value, origin, lines: [], verdict: "missing" as const, pages: [] };
      if (!t.lines.includes(site.line)) t.lines.push(site.line);
      if (t.origin === "act" && origin === "command") t.origin = "command"; // 命令 target 也算声明位
      targets.set(arg.value, t);
    };
    if (site.call === "ctx.hint") want(0, "act");
    else if (site.call === "ctx.hints") for (const a of site.args) want(a.index, "act");
    else if (site.call === "ctx.command") want(1, "command");
  }

  // ③ 真导航 + hintMatch 实况核对（只读；不执行动作、不计预算、不调模型）。
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
      url(): string;
      evaluate(script: string): Promise<unknown>;
    };
    const INTERACTIVE = "[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],a,button,input,textarea,select,[onclick],[tabindex]";
    const countSel = JSON.stringify(INTERACTIVE);
    for (const p of pages) {
      try {
        await page.goto(p.url, { waitUntil: "domcontentloaded", timeout });
        // 与 inspect 同款水合等待：load 完成 + 交互计数稳定（上限 3s）——半渲染页面上的
        // 命中数不可信，宁可多等这几秒。
        try {
          await page.evaluate("new Promise((res) => { if (document.readyState === 'complete') res(); else window.addEventListener('load', () => res(), { once: true }); })");
        } catch { /* load 已过：自然落到稳定轮询 */ }
        let last = -1, stable = 0;
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 300));
          let n = -1;
          try { n = Number(await page.evaluate(`document.querySelectorAll(${countSel}).length`)); } catch { n = -1; }
          if (n === last) { stable++; if (stable >= 2) break; } else stable = 0;
          last = n;
        }
        await new Promise((r) => setTimeout(r, 500));
        const elems = await extractElements(page as never, true, max, {});
        p.elements = Object.keys(elems).length;
        for (const t of targets.keys()) {
          const cand = hintCandidates(t, elems);
          const count = cand === null ? 0 : cand.refs.length;
          p.hits[t] = count;
          const rec = targets.get(t)!;
          rec.pages.push({ url: p.url, count });
        }
      } catch (e) {
        p.error = (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200);
      }
    }
  } finally {
    await session.close();
  }

  // ④ 逐 hint 判定：verified（任一可达页 n=1）＞ ambiguous（只有多命中）＞ missing（全 0）。
  const list = [...targets.values()].sort((a, b) => a.origin.localeCompare(b.origin) || a.lines[0]! - b.lines[0]!);
  for (const t of list) {
    const counts = t.pages.map((x) => x.count);
    if (counts.some((n) => n === 1)) t.verdict = "verified";
    else if (counts.some((n) => n > 1)) t.verdict = "ambiguous";
    else t.verdict = "missing";
  }
  const countsOut = {
    verified: list.filter((t) => t.verdict === "verified").length,
    ambiguous: list.filter((t) => t.verdict === "ambiguous").length,
    missing: list.filter((t) => t.verdict === "missing").length,
    dynamic: dynamicHints.length,
  };

  // ⑤ --remember：verified（n=1）写 sidecar（与 run --remember 同一份文件；键=(页面 URL, hint 文本)）。
  let remembered = 0;
  let memoryStats: { entries: number } | null = null;
  if (v.remember === true) {
    const memoryPath = typeof v["hint-memory"] === "string" && v["hint-memory"] !== ""
      ? path.resolve(String(v["hint-memory"]))
      : path.join(path.dirname(userAppsDir()), "hint-memory", `${pack.id}.json`);
    try {
      fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
      const memory = createHintMemory({ path: memoryPath });
      for (const t of list) {
        if (t.verdict !== "verified") continue;
        const page = t.pages.find((x) => x.count === 1)!;
        memory.record(memory.key(page.url, t.hint), t.hint);
        remembered++;
      }
      memoryStats = { entries: memory.stats().entries };
    } catch (e) {
      if (!wantJson) say(ctx, `⚠ sidecar 写不进去：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (wantJson) {
    emitJson(ctx, successEnvelope("apps rehearsal", {
      app: pack.id,
      path: loaded.scriptPath,
      script_sha256: loaded.scriptSha256,
      pages,
      targets: list.map((t) => ({ hint: t.hint, origin: t.origin, lines: t.lines, verdict: t.verdict, pages: t.pages })),
      dynamic_hints: dynamicHints,
      counts: countsOut,
      ...(v.remember === true ? { remembered, memory: memoryStats } : {}),
      coverage_note: "只证明 hint 在可达页面上的命中数/歧义；不证明页面状态成立；交互后步骤不可达是常态",
    }, {
      next: countsOut.missing > 0
        ? ["amber inspect --url <可达页> --json 对照未命中声明", "amber apps check <id>"]
        : ["amber apps check <id>", "amber run <id> --max-steps 3 --trace"],
    }));
    return 0;
  }

  say(ctx, `${pack.id} — rehearsal（只读预检：真导航 ${pages.length} 页 × 静态 act hint/command target ${list.length} 条）`);
  say(ctx, `  脚本：${scriptDisplayPath(loaded.scriptPath)}`);
  for (const p of pages) {
    say(ctx, `  页面 ${p.url}${p.error !== undefined ? `  ✗ ${p.error}` : `（池 ${p.elements ?? 0}）`}`);
    const entries = Object.entries(p.hits);
    if (entries.length === 0 && p.error === undefined) say(ctx, "    （无静态 hint 核对）");
    for (const [hint, count] of entries) {
      const mark = count === 1 ? "✓" : count === 0 ? "·" : "△";
      say(ctx, `    ${mark} ${JSON.stringify(hint)} → 命中 ${count}${count > 1 ? "（歧义）" : ""}`);
    }
  }
  say(ctx, `  已验证（n=1）${countsOut.verified} ｜ 歧义 ${countsOut.ambiguous} ｜ 未命中/不可达 ${countsOut.missing} ｜ dynamic ${countsOut.dynamic}`);
  if (v.remember === true) {
    say(ctx, `  sidecar：写入 ${remembered} 条已验证 hint（$AMBERFLOW_HOME/hint-memory/${pack.id}.json；authored hint 恒优先）`);
  }
  say(ctx, "  覆盖边界：只证明「hint 在可达页面上的命中数/歧义」，不证明页面状态成立；交互后步骤不可达是常态"
    + "——未命中声明可能属于交互后 UI，也可能 hint 有误，不判定，对照 inspect 自查。");
  say(ctx, "  与 check 的关系：apps check = 声明形状（dry 校验调用序列合法）；rehearsal = 可达页面的 hint 实况——两者都不证明完成。");
  return 0;
}
