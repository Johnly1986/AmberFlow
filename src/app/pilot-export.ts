/**
 * `amber pilot export`（PW3）：把驾驶轨迹（--record JSONL）还原成 app.mjs 骨架。
 *
 * 与 session export 的分工（同一纪律的两种轨迹）：
 *   - session 轨迹 = 人点出来的动作序列（hint 是作者现场挑的）；
 *   - pilot 轨迹   = 模型驾驶出来的动作序列（hint 是模型票 + 兜底指令投影）。
 *     每步带 `picked_by`（rule = 规则档零模型 / model = 决策票）与 pick 证据——骨架注释
 *     忠实保留这个来源标记，绝不把它伪装成作者手写的目标。
 *
 * 生成纪律（与 session export 同源，不比它多做归纳）：
 *   - 只还原**走通了的动作序列**（ok:true 的 drive 行）；失败步以注释块保留；
 *   - done 信号**未归纳**：final_signal_held 的交接只作注释候选，占位符必须替换；
 *   - fill/select 的值只有槽位引用（驾驶面的值来自 slots/resume，不落明文轨迹）；
 *   - 产物必须能过 `amber apps check`（dry、无浏览器）。
 */
import fs from "node:fs";
import path from "node:path";
import { amberflowHome } from "../support/amberflow-home.ts";
import {
  EXPORT_DONE_PLACEHOLDER, slugAppId,
} from "./session-export.ts";
import type { PilotRecordLine } from "./pilot-contract.ts";

export interface PilotExportOptions {
  record: string;
  out?: string | null;
  id?: string | null;
  goal?: string | null;
  hosts?: string[] | null;
  force?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface PilotExportResult {
  ok: boolean;
  problems: string[];
  warnings: string[];
  app_id: string;
  path: string;
  steps: number;
  failed_actions: number;
  model_picks: number;
  rule_picks: number;
  handoffs: number;
  done_placeholder: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const js = (s: string): string => JSON.stringify(s);

function hostOf(url: string | undefined): string | null {
  if (typeof url !== "string" || url.trim() === "") return null;
  try {
    const h = new URL(url).hostname;
    return h === "" ? null : h;
  } catch {
    return null;
  }
}

/** 读驾驶轨迹：drive/handoff/command 三类行按序保留；坏行不静默。 */
export function readPilotRecord(file: string): {
  problems: string[];
  entry: string | null;
  lines: PilotRecordLine[];
} {
  const problems: string[] = [];
  const lines: PilotRecordLine[] = [];
  let entry: string | null = null;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { problems: [`cannot read pilot record ${JSON.stringify(file)}: ${(e as Error).message}`], entry, lines };
  }
  raw.split(/\r?\n/).forEach((line, idx) => {
    const text = line.trim();
    if (text === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      problems.push(`line ${idx + 1}: not valid JSON`);
      return;
    }
    if (!isObj(parsed)) {
      problems.push(`line ${idx + 1}: not a JSON object`);
      return;
    }
    const type = parsed["type"];
    if (type !== "drive" && type !== "handoff" && type !== "command") {
      problems.push(`line ${idx + 1}: unknown pilot record type ${JSON.stringify(type)}`);
      return;
    }
    const rec = parsed as unknown as PilotRecordLine;
    lines.push(rec);
    if (type === "drive" && entry === null && typeof parsed["url_before"] === "string" && parsed["url_before"].trim() !== "") {
      entry = parsed["url_before"];
    }
  });
  return { problems, entry, lines };
}

/** 从驾驶轨迹生成 app.mjs 骨架源文本（纯函数：不落盘，调用方负责写）。 */
export function buildPilotAppSource(input: {
  lines: PilotRecordLine[];
  entry: string | null;
  appId: string;
  goal: string;
  hosts: string[];
}): { source: string; steps: number; failed: number; modelPicks: number; rulePicks: number; handoffs: number; warnings: string[] } {
  const { lines, entry, appId, goal, hosts } = input;
  const warnings: string[] = [];
  const body: string[] = [];
  let stepNo = 0;
  let failed = 0;
  let modelPicks = 0;
  let rulePicks = 0;
  let handoffs = 0;

  for (const line of lines) {
    if (line.type === "handoff") {
      handoffs += 1;
      body.push(
        `  // ── handoff @ step ${line.handoff.step_id}: ${line.handoff.stop_code}（Agent 兜底接管后驾驶继续）`,
        `  // why_stuck: ${line.handoff.why_stuck.summary}`,
        ...(line.handoff.what_would_unblock.length === 0
          ? []
          : [`  // unblock: ${line.handoff.what_would_unblock.map((w) => w.replace(/\s+/g, " ")).join("；")}`]),
        "",
      );
      continue;
    }
    if (line.type === "command") {
      const argText = Object.keys(line.args).length === 0
        ? "" : ` ${JSON.stringify(Object.assign({}, line.args, { value: line.args["value"] === undefined ? undefined : "<值已省略>" }))}`;
      body.push(`  // ── fallback command: ${line.command}${argText}`, "");
      continue;
    }
    // drive 行
    const a = line.action;
    const src = line.picked_by === "model" ? "决策票" : "规则档（零模型）";
    if (line.picked_by === "model") modelPicks += 1; else rulePicks += 1;
    const pickText = line.pick === undefined
      ? "" : ` conf=${line.pick.conf.toFixed(3)} shape=${line.pick.shape} pool=${line.pick.pool_size}`;
    const where = `step ${line.i + 1} · ${a.op} ${a.target}（${src}${pickText}）`;
    if (!a.ok) {
      failed += 1;
      body.push(
        `  // ── ✗ ${where} —— 驾驶在这一步没走通，骨架不生成假动作`,
        `  // code: ${String((a as Record<string, unknown>)["code"] ?? "unknown")}`,
        `  // 现场核对后手写（换目标/换入口）；驾驶证据见轨迹与 handoff 落盘。`,
        "",
      );
      continue;
    }
    if (a.op === "fill" || a.op === "select") {
      body.push(
        `  // ── ⚠ ${where} —— 驾驶值来自 slots/resume，轨迹不落明文；槽位绑定待作者补`,
        `  //   act: [ctx.command(${js(a.op)}, ${js(a.target)}, ctx.value.slot("TODO_VALUE"))]`,
        "",
      );
      continue;
    }
    stepNo += 1;
    const id = `pilot-${stepNo}-${a.op}`;
    const desc = `${a.op} ${a.target}`.slice(0, 80);
    const act = a.op === "click"
      ? `ctx.hint(${js(a.target)})`
      : `[ctx.command(${js(a.op)}, ${js(a.target)})]`;
    body.push(
      `  // ── ${where}`,
      `  const s${stepNo} = await ctx.step(${js(desc)}, {`,
      `    id: ${js(id)},`,
      `    act: ${act},`,
      `    done: ctx.judge.url(${js(EXPORT_DONE_PLACEHOLDER)}),`,
      `  });`,
      `  if (!s${stepNo}.ok) ctx.fail(s${stepNo}.stopCode ?? "step_failed", s${stepNo}.reason);`,
      "",
    );
  }

  if (stepNo === 0) warnings.push("轨迹里没有走通的可导出动作：骨架只有注释，真跑前请补动作");
  if (entry === null) warnings.push("轨迹里没有可用的入口页 URL：meta.site.pages.entry 未生成，需作者补");
  if (hosts.length === 0) warnings.push("无法从轨迹推导 hosts：请在 meta.hosts 补允许主机");
  if (handoffs > 0) warnings.push(`轨迹含 ${handoffs} 次停因交接：骨架注释保留了兜底上下文，人工核对后再固化`);

  const pagesLine = entry === null
    ? `// TODO 入口页未记录：补 site.pages.entry。\n  site: { pages: {} },`
    : `site: { pages: { entry: ${js(entry)} } },`;
  const openLine = entry === null
    ? `// TODO 入口页：补 meta.site.pages.entry 后再启用下一行。\n  // await ctx.openPage("entry");`
    : `await ctx.openPage("entry");`;

  const header = `/**
 * ${appId} —— 由 \`amber pilot export\` 从**模型驾驶轨迹**（--record）生成的 app.mjs 骨架。
 *
 * 生成纪律（不要期待它"直接能跑"）：
 *   - 动作序列来自决策模型驾驶（picked_by 标记每步来源：决策票 / 规则档），
 *     与作者手写的目标不是同一种证据——人工核对后才可固化；
 *   - done 信号未归纳：占位符 ${js(EXPORT_DONE_PLACEHOLDER)} 必须替换；
 *   - fill/select 的值是槽位引用（驾驶值不落明文），需作者补 meta.slots 绑定；
 *   - 失败步与停因交接（handoff）以注释块保留，不生成假动作。
 *
 * 下一步：amber apps check <id> → 编辑补 done/slot → amber run <id>。
 */
`;

  const meta = `export const meta = (kit) => ({
  id: ${js(appId)},
  label: ${js(appId)},
  goal: ${js(goal)},
  hosts: ${JSON.stringify(hosts)},
  ${pagesLine}
  slots: {},
  invariants: [],
});

export async function flow(ctx) {
  // TODO done 待作者补：下面每个 step 的 done 都是占位符 ${js(EXPORT_DONE_PLACEHOLDER)}。
  ${openLine}

${body.join("\n")}${body.length > 0 ? "\n" : ""}  await ctx.done();
}
`;

  return { source: header + meta, steps: stepNo, failed, modelPicks, rulePicks, handoffs, warnings };
}

/** 写盘 + 形状自检（不跑 apps check；那一步由调用方执行）。 */
export function exportPilotRecord(opts: PilotExportOptions): PilotExportResult {
  const record = path.resolve(opts.cwd ?? process.cwd(), opts.record);
  const read = readPilotRecord(record);
  const problems = [...read.problems];
  const appId = opts.id !== null && opts.id !== undefined && opts.id.trim() !== ""
    ? opts.id.trim()
    : slugAppId(record).replace(/^session-/, "pilot-");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(appId)) {
    problems.push(`app id ${JSON.stringify(appId)} must be lowercase letters/digits/hyphens (use --id)`);
  }
  const hosts = opts.hosts !== null && opts.hosts !== undefined && opts.hosts.length > 0
    ? [...opts.hosts]
    : [...new Set([
      hostOf(read.entry ?? undefined),
      ...read.lines.map((l) => (l.type === "drive" ? hostOf(l.url_after) : l.type === "handoff" ? hostOf(l.handoff.url) : null)),
    ].filter((h): h is string => h !== null))];
  const goal = opts.goal !== null && opts.goal !== undefined && opts.goal.trim() !== ""
    ? opts.goal.trim()
    : "(由 amber pilot export 生成的驾驶骨架——目标来自驾驶时的总目标，请人工确认)";

  const base = { app_id: appId, problems, warnings: [] as string[] };
  if (problems.length > 0) {
    return { ...base, ok: false, path: "", steps: 0, failed_actions: 0, model_picks: 0, rule_picks: 0, handoffs: 0, done_placeholder: EXPORT_DONE_PLACEHOLDER };
  }

  const built = buildPilotAppSource({ lines: read.lines, entry: read.entry ?? null, appId, goal, hosts });
  const outFile = opts.out !== null && opts.out !== undefined && opts.out.trim() !== ""
    ? path.resolve(opts.cwd ?? process.cwd(), opts.out)
    : path.join(amberflowHome(opts.env), "apps", appId, "app.mjs");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  if (fs.existsSync(outFile) && opts.force !== true) {
    problems.push(`refusing to overwrite ${outFile} (use --force)`);
    return { ...base, ok: false, path: outFile, steps: built.steps, failed_actions: built.failed, model_picks: built.modelPicks, rule_picks: built.rulePicks, handoffs: built.handoffs, done_placeholder: EXPORT_DONE_PLACEHOLDER };
  }
  fs.writeFileSync(outFile, built.source, "utf8");
  return {
    ok: true, problems: [], warnings: built.warnings, app_id: appId, path: outFile,
    steps: built.steps, failed_actions: built.failed,
    model_picks: built.modelPicks, rule_picks: built.rulePicks, handoffs: built.handoffs,
    done_placeholder: EXPORT_DONE_PLACEHOLDER,
  };
}
