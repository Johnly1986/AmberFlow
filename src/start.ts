#!/usr/bin/env node
/**
 * One command to start a piece of work — the entry point the README leads with.
 *
 * Why this exists: getting from a fresh checkout to a running job used to require
 * installing everything, exporting model weights, and then AUTHORING a plan by hand —
 * and the hard part of a plan is not the prose, it is the completion signal (a DOM fact
 * that is false before the step and true after it) plus naming the target.
 *
 *   npm start                                     # 开箱任务：仓库自带页面上跑一份真实计划
 *   npm start -- --goal "把商品加入购物车" --url <页面>   # 演示一次 → 归纳信号+点名目标 → 直接执行
 *   npm start -- --doctor                          # 只体检环境
 *
 * The second form WATCHES the transition instead of asking the user to predict it
 * (the same rule the repo applies to signals everywhere else): it opens the page, acts
 * once on the element the user names, compiles the completion signal from the before/after
 * pair, records the element's stable handle as the plan's target, saves the plan and runs it.
 *
 * No model weights are required: the demonstrated step becomes a plan-named target, so the
 * run resolves it by rule. Steps that need the local model say so instead of guessing.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import * as browserEnv from "./browser-env.ts";
import { browserSession, BrowserMiddleware, type BrowserSession } from "./executor.ts";
import { extractElements, type Elem, type ElemPool } from "./extraction.ts";
import { REPO } from "./flow.ts";
import { induceHint } from "./hint-memory.ts";
import { LayaNotConfiguredError, installLayaRuntime } from "./model.ts";
import { createLayaOnnxRuntime } from "./laya-onnx.ts";
import { PlanningRules, TaskPlan } from "./plan.ts";

/** CLI 的默认检查点（与 parseArgs 的 default 同一个字符串；打印副作用时要用到它）。 */
export const DEFAULT_PLAN_PATH = ".task_plan.json";
import type { SignalSpec } from "./signals.ts";
import { runPlan } from "./planner.ts";
import { affordanceRule } from "./rules.ts";
import { captureStateView, induceSignals } from "./signal-induction.ts";

export interface Io {
  out(line: string): void;
  /** Interactive answer; \`null\` when there is nobody to ask (CI, piped stdin). */
  ask(question: string): Promise<string | null>;
}

const defaultIo: Io = {
  out: (line) => console.log(line),
  ask: async (question) => {
    if (!process.stdin.isTTY) return null;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  },
};

export interface StartDeps {
  /** Test seam: reuse an already launched browser. */
  session?: BrowserSession | null;
  /** Test seam: skip the model runtime even when artifacts exist. */
  noModel?: boolean;
}

const MODEL_PATH = (): string => process.env.LAYA_ONNX_MODEL ?? "/tmp/laya_dec.onnx";

export interface Preflight {
  node: string;
  nodeOk: boolean;
  chromium: string | null;
  model: boolean;
  llm: boolean;
  browserPath: string | null;
}

/** What is ready, what is missing — and never a stack trace for a missing prerequisite. */
export function preflight(): Preflight {
  const node = process.versions.node;
  const [maj = 0, min = 0] = node.split(".").map(Number);
  // Use the repo's OWN resolver (it understands PLAYWRIGHT_BROWSERS_PATH, the default
  // cache, and both full chrome and the headless shell) — a hand-rolled check here said
  // "chromium ✗" while the tests were launching it happily.
  let chromiumPath: string | null = browserEnv.chromiumCandidates()[0] ?? null;
  if (!chromiumPath) {
    try {
      const p = chromium.executablePath();
      if (p && fs.existsSync(p)) chromiumPath = p;
    } catch {
      chromiumPath = null;
    }
  }
  const base = MODEL_PATH();
  return {
    node,
    nodeOk: maj > 22 || (maj === 22 && min >= 6),
    chromium: chromiumPath,
    model: fs.existsSync(base) && fs.existsSync(`${base}.data`),
    llm: Boolean(process.env.OPENAI_BASE_URL && process.env.OPENAI_API_KEY),
    browserPath: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null,
  };
}

const SOURCE_HINT = (base: string): string =>
  `（导出方式见 node-port-poc/README.md；或设 LAYA_ONNX_MODEL=${base}）`;

/** Plain-language report, with the exact next command for anything missing. */
export function doctorReport(p: Preflight): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  lines.push(`Node        ${p.node}${p.nodeOk ? "  ✓" : "  ✗ 需要 ≥ 22.6"}`);
  lines.push(`chromium    ${p.chromium ?? "✗ 未找到"}`);
  lines.push(p.model
    ? `决策模型     ${MODEL_PATH()}  ✓ 真模型`
    : `决策模型     ✗ 未找到 ${MODEL_PATH()} → 规则模式：计划点名的步骤照样能跑，需要模型兜底时${SOURCE_HINT(MODEL_PATH())}`);
  lines.push(`LLM 规划/审计 ${p.llm ? "✓ 已配置" : "— 未配置（用内置替身，全流程照常）"}`);
  const ok = p.nodeOk && p.chromium !== null;
  if (!ok) {
    lines.push("");
    lines.push("先修好上面带 ✗ 的两项之一：");
    lines.push("  npm ci");
    lines.push("  npx playwright install chromium");
  } else {
    lines.push("");
    if (!p.model) lines.push("规则模式也能跑：计划点名目标的步骤不需要模型权重。");
    lines.push("现在就可以开始：npm start           # 在仓库自带页面上跑一份真实计划");
    lines.push("               npm start -- --goal \"把商品加入购物车\" --url <你的页面>");
  }
  return { ok, lines };
}

/** The bundled job: two subgoals over `testpages/`, resolved entirely by plan-named targets. */
function demoPlan(planPath: string): TaskPlan {
  const base = `file://${path.join(REPO, "testpages")}`;
  return new TaskPlan(
    "在示例商店把无线鼠标加入购物车并打开购物车页",
    [
      {
        desc: "把 Wireless Mouse X200 加入购物车",
        signal: { css_text_equals: ["[data-test=cart-count]", "1"] },
        start_url: `${base}/product.html`,
        target_hint: "[data-test=add-to-cart]",
      },
      {
        desc: "打开购物车页",
        signal: { url_contains: "cart.html" },
        start_url: `${base}/product.html`,
        target_hint: "[data-test=cart-link]",
      },
    ],
    planPath,
    {},
  );
}

/** A CSS selector from the element's STABLE handles — never a positional guess. */
export function selectorForHint(hint: string): string | null {
  const m = /^\[(data-test|id|name)=(.+)\]$/.exec(hint);
  if (!m) return hint.startsWith("#") || hint.startsWith("[") || /^[a-z]+\[/i.test(hint) ? hint : null;
  const [, attr, value] = m;
  return attr === "id" ? `#${value}` : `[${attr}="${value}"]`;
}

/** Resolve a user-given hint (`[data-test=x]`, `#id`, `[name=x]`, …) against the pool. */
export function findByHint(elems: ElemPool, hint: string): { ref: string; el: Elem } | null {
  const m = /^\[?(data-test|id|name)=(.+?)\]?$/.exec(hint);
  const fold = (s: string): string => s.toLowerCase();
  if (m) {
    const [, attr, raw] = m;
    const want = fold(raw!.replace(/^["']|["']$/g, ""));
    for (const [ref, el] of Object.entries(elems)) {
      const val = attr === "data-test" ? el.data_test : attr === "id" ? el.id : el.name;
      if (typeof val === "string" && fold(val) === want) return { ref, el };
    }
    return null;
  }
  const idm = /^#(.+)$/.exec(hint);
  if (idm) {
    for (const [ref, el] of Object.entries(elems)) {
      if (typeof el.id === "string" && fold(el.id) === fold(idm[1]!)) return { ref, el };
    }
    return null;
  }
  for (const [ref, el] of Object.entries(elems)) if (induceHint(el) === hint) return { ref, el };
  return null;
}

/** Ask which candidate to act on; returns a ref. Refuses to guess when nobody can answer. */
async function chooseTarget(
  goal: string, elems: ElemPool, io: Io, forbidden: Set<string> = new Set(),
): Promise<{ ref: string; auto: boolean } | null> {
  const byRule = affordanceRule(goal, elems);
  if (byRule) return { ref: byRule, auto: true };
  const refs = Object.keys(elems).filter((r) => !forbidden.has(r)).slice(0, 12);
  if (!refs.length) return null;
  io.out("");
  io.out("页面上的候选（按编号选一个，直接回车=第 1 个）：");
  refs.forEach((r, i) => {
    const e = elems[r]!;
    io.out(`  ${String(i + 1).padStart(2)}. ${e.tag} "${e.label}"${e.data_test ? ` [test=${e.data_test}]` : ""}`);
  });
  const answer = await io.ask("目标编号 > ");
  if (answer === null) {
    // Nobody to ask (piped stdin / CI): do NOT pick one on the user's behalf — this acts
    // on a real page. Print the exact command that names the target explicitly instead.
    io.out("");
    io.out("没有可交互输入，就不替你猜了。把目标显式点名再来一次，例如：");
    io.out(`  npm start -- --goal \"${goal}\" --url <页面> --target '[data-test=${refs
      .map((r) => elems[r]!.data_test ?? elems[r]!.id ?? "")
      .find((x) => x) ?? "..."}]'`);
    return null;
  }
  const idx = Math.max(1, Math.min(refs.length, Number(answer) || 1)) - 1;
  return { ref: refs[idx]!, auto: false };
}

/**
 * The onboarding path: demonstrate ONE step, compile its completion signal, record the
 * target's stable handle, save the plan, run it.
 */
async function commandJob(
  goal: string, url: string, opts: { plan: string; target: string | null; dryRun: boolean; headless: boolean },
  io: Io, deps: StartDeps,
): Promise<number> {
  const own = deps.session ? null : await browserSession(opts.headless);
  const session = (deps.session ?? own)!;
  try {
    const page = session.page;
    io.out(`打开 ${url}`);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (err) {
      io.out(`打不开这个页面：${(err as Error).message}`);
      return 2;
    }

    const before = await captureStateView(page as never);
    const elems = await extractElements(page as never);
    if (!Object.keys(elems).length) {
      io.out("这个页面上没有可交互元素——换个页面，或确认它已经加载完。");
      return 2;
    }

    let ref: string;
    let hint: string | null = null;
    if (opts.target) {
      const found = findByHint(elems, opts.target);
      if (!found) {
        io.out(`这个页面上没有匹配 ${opts.target} 的元素。`);
        io.out(`页面上的稳定句柄：${Object.values(elems).map((e) => induceHint(e)).filter(Boolean).slice(0, 8).join("  ")}`);
        return 2;
      }
      ref = found.ref;
      hint = induceHint(found.el) ?? opts.target;
      io.out(`点名目标：${found.el.tag} "${found.el.label}"`);
    } else {
      const pick = await chooseTarget(goal, elems, io);
      if (!pick) return 2;
      ref = pick.ref;
      const e = elems[ref]!;
      hint = induceHint(e);
      if (pick.auto) io.out(`按目标措辞选中：${e.tag} "${e.label}"`);
    }
    const el = elems[ref];
    if (!el) {
      io.out(`点名的目标不在这个页面上：${ref}`);
      return 2;
    }
    const sel = hint ? selectorForHint(hint) : null;
    if (!sel) {
      io.out(`这个元素没有稳定句柄（data-test / id / name），不按位置盲点。请用 --target 指名别的元素。`);
      return 2;
    }

    io.out(`执行演示：点击 ${sel}`);
    try {
      await page.click(sel, { timeout: 10_000 });
    } catch (err) {
      io.out(`点击失败：${(err as Error).message}`);
      return 2;
    }
    await page.waitForTimeout(300);
    const after = await captureStateView(page as never);

    // The completion signal is COMPILED from the observed transition, never predicted.
    const ind = induceSignals(before, after);
    let signal: SignalSpec;
    if (ind.verdict === "discriminating" && ind.candidates.length) {
      signal = ind.candidates[0]!.signal;
      io.out(`归纳出完成信号（稳定性 ${ind.candidates[0]!.stability}）：${JSON.stringify(signal)}`);
      for (const e of ind.effect) io.out(`  观察到：${e}`);
    } else {
      signal = { manual: true };
      io.out("没有归纳出可判定的 DOM 信号 → 该步声明为人工确认（运行时会问你一次）。");
    }

    const plan = new TaskPlan(goal, [{
      desc: goal,
      signal,
      start_url: url,
      ...(hint && sel !== hint ? { target_hint: hint } : hint ? { target_hint: hint } : {}),
    }], opts.plan, {});
    const problems = new PlanningRules().problems(plan);
    if (problems.length) {
      io.out(`计划不合法：${problems.join("; ")}`);
      return 2;
    }
    plan.save();
    io.out(`计划已保存：${opts.plan}（1 个子目标；目标已点名 → 运行时零模型调用）`);

    if (opts.dryRun) {
      io.out("--dry-run：到此为止。下一步：npm run plan-cli -- show");
      return 0;
    }

    io.out("");
    const mw = new BrowserMiddleware({ confirmFn: () => true, manualConfirmFn: async () => {
      const a = await io.ask("这一步完成了么？(y/N) > ");
      return a === "y" || a === "Y";
    } });
    const rep = await runPlan(mw as never, plan, { startUrl: url, verbose: false });
    for (const t of rep.traces) {
      io.out(`  ${t.how} · ${t.method} · conf=${t.conf}${t.inert ? " · 无变化" : ""}`);
    }
    const status = rep.plan.subgoals[0]!.status;
    io.out(`\n结果：${rep.completed}  ${status === "done" ? "✓ 完成" : "✗ 未完成"}（状态 ${status}）`);
    if (status !== "done" && (signal as { manual?: boolean }).manual) {
      io.out("该步没有可自动判定的 DOM 信号，需要人工确认；非交互环境无法确认，所以如实报未完成。");
      io.out("建议：换一个「动作后页面确实变化」的步骤，或给该步补一个 DOM 信号（见 npm run plan-cli -- --help）。");
    }
    io.out("");
    io.out(`计划检查点：${opts.plan}`
      + (opts.plan === DEFAULT_PLAN_PATH ? "（默认落在仓库根目录，会出现在版本控制状态里）" : ""));
    io.out("");
    io.out("接着做：npm run plan-cli -- show           # 看这份计划");
    io.out("        npm run plan-cli -- add 1 \"下一步描述\" --signal 'css_exists=#id' --url <页面>");
    io.out("        npm run plan-cli -- run [--replan]  # 再跑一次（可续跑）");
    return rep.completed.startsWith("1/") ? 0 : 1;
  } catch (err) {
    if (err instanceof LayaNotConfiguredError || /laya runtime not configured/.test(String(err))) {
      io.out("");
      io.out("这一步需要本地决策模型兜底，但没找到模型权重。两种选择：");
      io.out(`  1) 让计划点名目标（本次演示已经这样做了；规则命不中时才需要模型）`);
      io.out(`  2) 准备模型产物：${SOURCE_HINT(MODEL_PATH())}`);
      return 3;
    }
    throw err;
  } finally {
    if (own) await own.close();
  }
}

async function commandDemo(planPath: string, headless: boolean, io: Io, deps: StartDeps): Promise<number> {
  const plan = demoPlan(planPath);
  const problems = new PlanningRules().problems(plan);
  if (problems.length) throw new Error(`内置示例计划不合法：${problems.join("; ")}`);
  io.out("开箱任务（仓库自带的示例商店，离线运行）：");
  io.out(`  ${plan.goal}\n`);
  const mw = new BrowserMiddleware({ confirmFn: () => true });
  const url = plan.subgoals[0]!.start_url!;
  const buf: string[] = [];
  const sink: Io = { out: (l) => { buf.push(l); io.out(l); }, ask: io.ask };
  const injected = deps.session ?? null;
  const rep = await runPlan(mw as never, plan, {
    startUrl: url, verbose: true,
    ...(injected ? { sessionFactory: async () => injected } : {}),
  });
  io.out(`\n结果：${rep.completed}   步骤 ${rep.traces.length}   跳过 ${rep.skipped}   重试 ${rep.retried}`);
  io.out(`每步的判定方式：${rep.traces.map((t) => t.method).join(", ") || "（无步骤）"}`);
  io.out("");
  io.out(`计划检查点：${planPath}`);
  io.out("  （本次运行已把它更新：版本控制会让你看到这一处改动；不想动工作区就加 --plan /tmp/your-plan.json）");
  io.out("");
  io.out("这份计划全部由「计划点名目标 + DOM 信号」解决，没有用到模型权重。");
  io.out("换成你自己的页面：npm start -- --goal \"<你要做的事>\" --url <页面地址>");
  void headless;
  return rep.traces.length > 0 && rep.completed.startsWith(String(rep.traces.length)) ? 0 : 1;
}

export async function main(argv: string[] = process.argv.slice(2), io: Io = defaultIo, deps: StartDeps = {}): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      goal: { type: "string" }, url: { type: "string" },
      doctor: { type: "boolean" }, demo: { type: "boolean" },
      "dry-run": { type: "boolean" }, headful: { type: "boolean" },
      target: { type: "string" },
      plan: { type: "string", default: DEFAULT_PLAN_PATH },
      help: { type: "boolean" },
    },
  });
  const v = parsed.values;
  const headless = !v.headful;

  if (v.help) {
    io.out(USAGE);
    return 0;
  }
  if (v.doctor) {
    const report = doctorReport(preflight());
    for (const l of report.lines) io.out(l);
    return report.ok ? 0 : 2;
  }

  const p = preflight();
  if (!p.nodeOk) {
    io.out(`需要 Node ≥ 22.6（当前 ${p.node}）。`);
    return 2;
  }
  if (!p.chromium) {
    io.out("还没装 chromium，先跑一次：");
    io.out("  npx playwright install chromium");
    return 2;
  }
  // Real weights when they are there; otherwise run in rules mode and let a step that
  // genuinely needs the model say so (never a stack trace, never a guess).
  if (p.model && !deps.noModel) installLayaRuntime(createLayaOnnxRuntime());
  else io.out(`（规则模式：未找到 ${MODEL_PATH()} —— 计划点名的步骤照样能跑）\n`);

  const goal = v.goal;
  const url = v.url;
  if (goal && url) {
    return commandJob(goal, url, {
      plan: String(v.plan), target: (v.target as string | undefined) ?? null,
      dryRun: Boolean(v["dry-run"]), headless,
    }, io, deps);
  }
  if (goal || url) {
    io.out("--goal 和 --url 要一起给，例如：");
    io.out('  npm start -- --goal "把商品加入购物车" --url https://shop.example.com/p/1');
    return 2;
  }
  return commandDemo(String(v.plan), headless, io, deps);
}

export const USAGE = `npm start — 一条命令开始一项工作

  npm start                                        开箱任务：仓库自带页面上跑一份真实计划
  npm start -- --goal "把商品加入购物车" --url <页面>   演示一次 → 归纳完成信号 + 点名目标 → 执行
  npm start -- --doctor                            只体检环境（Node / chromium / 模型 / LLM）
  npm start -- --goal ... --url ... --dry-run      只生成计划，不执行

  可选：--target '<hint>'  直接点名目标（跳过选择）
        --plan <文件>      计划保存位置（默认 .task_plan.json）
        --headful          显示浏览器窗口
`;

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  process.exit(await main());
}
