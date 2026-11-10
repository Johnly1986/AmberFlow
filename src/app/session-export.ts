/**
 * `amber session export` —— 把 `--record` 动作轨迹还原成 `app.mjs` 骨架（task-33 / Phase 2）。
 *
 * 定位（design Q6 拍板口径）：
 *   - **只出骨架**：`meta` 占位 + `flow(ctx)` 的 steps 序列 + 每步 `observe_hints` 候选；
 *   - **不归纳 done 信号**：done 一律写成可过 `apps check`（dry 不评估信号）的占位
 *     `ctx.judge.url("TODO-REPLACE-ME")`，并把轨迹里观察到的落点 URL 作为**注释候选**给出——
 *     归纳/验证信号是 `record`/`learn` 的职责，export 不抢；
 *   - **不发明动作**：轨迹里 `ok:false` 的动作只以注释块保留（写明 code/reason），
 *     不生成假动作；`fill/select` 的值只记了 `value_hash`（安全），所以它们也以注释块
 *     保留"需要作者补值绑定"，不写空值/假值；
 *   - 生成的骨架必须能过 `amber apps check`（dry、无浏览器）——这是本工具的自检门。
 *
 * 输入契约：`amber session --record <file>` 产出的 JSONL：
 *   {"type":"open","url":…,"title":…}                     入口页（meta.site.pages.entry 来源）
 *   {"type":"mark","note":…}                              人工标记（转成 flow 注释）
 *   {"i":N,"op":"click|check|fill|select|hover|scroll", "target":…, "to"?,"by"?,
 *    "ok":bool, "code"?, "ref", "how", "changed", "url", "observe_hints"?}
 */
import fs from "node:fs";
import path from "node:path";
import { amberflowHome } from "./amberflow-home.ts";

/** 轨迹里动作事件的最小形状（缺字段按"未知"处理，不猜）。 */
export interface RecordedAction {
  i?: number;
  op: string;
  target?: string | null;
  to?: string;
  by?: number;
  ok: boolean;
  code?: string;
  reason?: string;
  ref?: string | null;
  how?: string | null;
  changed?: boolean;
  url?: string;
  observe_hints?: string[];
  value_hash?: string;
  value_len?: number;
}

export interface ExportOptions {
  /** `--record` 轨迹文件（JSONL）。 */
  record: string;
  /** `--out`：app.mjs 文件路径或目录；缺省 `$AMBERFLOW_HOME/apps/<id>/app.mjs`。 */
  out?: string | null;
  /** `--id`：应用 id（缺省从轨迹文件名生成 `session-<slug>`）。 */
  id?: string | null;
  /** `--goal`：meta.goal 占位文案。 */
  goal?: string | null;
  /** `--hosts`：覆盖推导出的 hosts。 */
  hosts?: string[] | null;
  /** `--force`：覆盖已存在的 app.mjs。 */
  force?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ExportResult {
  ok: boolean;
  problems: string[];
  warnings: string[];
  app_id: string;
  path: string;
  steps: number;
  failed_actions: number;
  unresolved_actions: number;
  /** 骨架里 done 占位符的正文（给人和断言看）。 */
  done_placeholder: string;
}

/** done 占位符：非空、合法信号，**故意**不可能在真跑里成立（作者必须替换）。 */
export const EXPORT_DONE_PLACEHOLDER = "TODO-REPLACE-ME";

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** slug：小写字母/数字/连字符；保证 app id 合法且稳定。 */
export function slugAppId(recordPath: string): string {
  const base = path.basename(recordPath).replace(/\.(jsonl|json|trace\.json)$/i, "");
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `session-${slug === "" ? "export" : slug}`.slice(0, 60);
}

function hostOf(url: string | undefined): string | null {
  if (typeof url !== "string" || url.trim() === "") return null;
  try {
    const h = new URL(url).hostname;
    return h === "" ? null : h;
  } catch {
    return null;
  }
}

/**
 * 读轨迹并分组：入口页（首个 open）、mark 序列、动作序列（保持先后）。
 * 坏行不静默：返回 problem 列表（调用方决定 exit 2）。
 */
export function readRecord(file: string): {
  problems: string[];
  entry: string | null;
  marks: string[];
  actions: RecordedAction[];
} {
  const problems: string[] = [];
  const marks: string[] = [];
  const actions: RecordedAction[] = [];
  let entry: string | null = null;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (e) {
    return { problems: [`cannot read record file ${JSON.stringify(file)}: ${(e as Error).message}`], entry, marks, actions };
  }
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, idx) => {
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
    if (parsed["type"] === "open") {
      if (entry === null && typeof parsed["url"] === "string" && parsed["url"].trim() !== "") entry = parsed["url"];
      return;
    }
    if (parsed["type"] === "mark") {
      if (typeof parsed["note"] === "string" && parsed["note"].trim() !== "") marks.push(parsed["note"]);
      return;
    }
    if (typeof parsed["op"] !== "string" || parsed["op"] === "") {
      problems.push(`line ${idx + 1}: neither an open/mark event nor an action with an op`);
      return;
    }
    actions.push({
      ...(typeof parsed["i"] === "number" ? { i: parsed["i"] } : {}),
      op: parsed["op"],
      ...(typeof parsed["target"] === "string" ? { target: parsed["target"] } : {}),
      ...(typeof parsed["to"] === "string" ? { to: parsed["to"] } : {}),
      ...(typeof parsed["by"] === "number" ? { by: parsed["by"] } : {}),
      ok: parsed["ok"] === true,
      ...(typeof parsed["code"] === "string" ? { code: parsed["code"] } : {}),
      ...(typeof parsed["reason"] === "string" ? { reason: parsed["reason"] } : {}),
      ...(typeof parsed["ref"] === "string" ? { ref: parsed["ref"] } : {}),
      ...(typeof parsed["how"] === "string" ? { how: parsed["how"] } : {}),
      ...(typeof parsed["changed"] === "boolean" ? { changed: parsed["changed"] } : {}),
      ...(typeof parsed["url"] === "string" ? { url: parsed["url"] } : {}),
      ...(Array.isArray(parsed["observe_hints"])
        ? { observe_hints: parsed["observe_hints"].filter((h): h is string => typeof h === "string") }
        : {}),
      ...(typeof parsed["value_hash"] === "string" ? { value_hash: parsed["value_hash"] } : {}),
      ...(typeof parsed["value_len"] === "number" ? { value_len: parsed["value_len"] } : {}),
    });
  });
  return { problems, entry, marks, actions };
}

/** JS 字符串字面量（`null/undefined` 折成空串——轨迹缺字段时不猜内容）。 */
function js(s: string | null | undefined): string {
  return JSON.stringify(s ?? "");
}

/** 一步的动作是否"能直接生成"：click/check/hover 是命令闭集；fill/select 缺明文值；scroll 走原语。 */
function isDirectAction(a: RecordedAction): boolean {
  return a.op === "click" || a.op === "check" || a.op === "hover";
}

interface BuiltFile {
  source: string;
  steps: number;
  failed: number;
  unresolved: number;
  warnings: string[];
}

/** 由轨迹生成 app.mjs 源码（纯函数：不写盘、不做 I/O，便于单测/离线校验）。 */
export function buildAppSource(input: {
  actions: RecordedAction[];
  entry: string | null;
  marks: string[];
  appId: string;
  goal: string;
  hosts: string[];
}): BuiltFile {
  const { actions, entry, marks, appId, goal, hosts } = input;
  const warnings: string[] = [];
  let failed = 0;
  let unresolved = 0;
  const body: string[] = [];
  let stepNo = 0;

  const stepIdOf = (n: number, op: string): string => `step-${n}-${op}`;

  for (const [idx, a] of actions.entries()) {
    const where = `step ${idx + 1} (${a.op}${a.target === undefined ? "" : ` ${js(a.target)}`})`;
    if (!a.ok) {
      failed += 1;
      body.push(
        `  // ── ✗ ${where} —— 轨迹里这一步**没有走通**，骨架不生成假动作 ──────────────`,
        `  // code: ${a.code ?? "unknown"}${a.reason === undefined ? "" : ` · reason: ${a.reason}`}`,
        `  // 现场核对后手写这一步（换目标/换入口/换控件族），不要照抄失败动作。`,
        "",
      );
      continue;
    }
    if (a.op === "fill" || a.op === "select") {
      unresolved += 1;
      const key = a.op === "fill" ? "TODO_VALUE" : "TODO_OPTION";
      body.push(
        `  // ── ⚠ ${where} —— 值未落明文（--record 只记 value_hash），骨架不生成假值 ──────`,
        `  // 轨迹事实: value_len=${a.value_len ?? "?"} value_hash=${a.value_hash ?? "?"}`,
        `  // 作者补值：meta.slots 声明槽位后写成`,
        `  //   act: [ctx.command(${js(a.op)}, ${js(a.target ?? "")}, ctx.value.slot(${js(key)}))]`,
        `  // 然后把它包进同样的 ctx.step(desc, { act, done: … }) 结构。`,
        "",
      );
      continue;
    }
    stepNo += 1;
    const id = stepIdOf(stepNo, a.op);
    const desc = `${a.op}${a.target === undefined ? "" : ` ${a.target}`}`.slice(0, 80);
    const hints = Array.isArray(a.observe_hints) && a.observe_hints.length > 0 ? a.observe_hints : [];
    body.push(
      `  // ── step ${stepNo} · ${desc}${a.changed === false ? "（轨迹 changed=false：页面无变化，done 需特别核对）" : ""}`,
    );
    if (hints.length > 0) {
      body.push(`  // observe_hints（--record 采自观察面，已由同一个 hintMatch 自证；可照抄进 ctx.hint/command）：`);
      for (const h of hints.slice(0, 6)) body.push(`  //   - ${js(h)}`);
    } else {
      body.push(`  // observe_hints：轨迹未采到候选（观察面未命中）——先用 amber session observe 或 inspect 核对。`);
    }
    const doneCandidate = doneCandidateFor(a);
    body.push(`  // TODO done（未归纳）：轨迹落点 ${js(a.url ?? "")}`);
    if (doneCandidate !== null) {
      body.push(`  //   候选信号（未验证，按站点实况核对后再启用）：${doneCandidate}`);
    } else {
      body.push(`  //   候选信号：本步没有可用的落点 URL；用 actions 之后的页面证据（如 css_exists_text）自拟。`);
    }
    body.push(`  //   替换下面的占位符 ${js(EXPORT_DONE_PLACEHOLDER)} 后，真跑才会认完成。`);
    if (a.op === "scroll") {
      // scroll 在 session 里是纯 DOM 滚动原语（元素 scrollIntoView / document scrollTop），
      // 导出用同一族原语 scrollList（各计 1 flow step），不伪装成点击。
      const target = a.target !== undefined && a.target !== "" && a.target !== "document" ? a.target : "document";
      const to = a.to === "top" || a.to === "page" ? a.to : "bottom";
      body.push(
        `  // scroll 导出为原语（轨迹里是 ${a.target === "document" ? "mw.scrollDocument" : "元素 scrollIntoView"}）：`,
        `  await ctx.scrollList(${js(target === "document" ? "document" : target)}, { to: ${js(to)} });`,
        "",
      );
      continue;
    }
    const act = a.op === "click"
      ? `ctx.hint(${js(a.target ?? "")})`
      : `[ctx.command(${js(a.op)}, ${js(a.target ?? "")})]`;
    body.push(
      `  const s${stepNo} = await ctx.step(${js(desc)}, {`,
      `    id: ${js(id)},`,
      `    act: ${act},`,
      `    done: ctx.judge.url(${js(EXPORT_DONE_PLACEHOLDER)}),`,
      `  });`,
      `  if (!s${stepNo}.ok) ctx.fail(s${stepNo}.stopCode ?? "step_failed", s${stepNo}.reason);`,
      "",
    );
  }

  for (const m of marks) body.push(`  // mark: ${m}`);

  if (!actions.some((a) => a.ok)) warnings.push("轨迹里没有成功的动作：骨架只有注释，真跑前请补动作");
  if (entry === null) warnings.push("轨迹里没有 open 事件：meta.site.pages.entry 未生成，第一步需要作者补 url 或先 open 入口页");
  if (hosts.length === 0) warnings.push("无法从轨迹推导 hosts（没有 open/动作 URL）：请在 meta.hosts 补允许主机");

  const pagesLine = entry === null
    ? `// TODO 入口页未记录：补 site.pages.entry 后把 flow 开头的 openPage 打开。\n  site: { pages: {} },`
    : `site: { pages: { entry: ${js(entry)} } },`;
  const openLine = entry === null
    ? `// TODO 入口页：轨迹里没有 open 事件——补 meta.site.pages.entry 后再启用下一行。\n  // await ctx.openPage("entry");`
    : `await ctx.openPage("entry");`;

  const header = `/**
 * ${appId} —— 由 \`amber session export\` 从动作轨迹（--record）生成的 **app.mjs 骨架**。
 *
 * 生成纪律（不要期待它"直接能跑"）：
 *   - 只还原**动作序列**；done 信号**未归纳**，每步是占位符 ${js(EXPORT_DONE_PLACEHOLDER)}，
 *     轨迹观察到的落点 URL 只作为注释候选；归纳/验证信号请走 amber record（learn）通道。
 *   - fill/select 的值在轨迹里只有 hash（--record 不落明文），以注释块保留，需作者补 slot 绑定。
 *   - 轨迹里失败的动作（ok:false）以注释块保留，不生成假动作。
 *   - 本骨架保证能过 \`amber apps check\`（dry、无浏览器）；真跑前必须补 done 并逐条核对。
 *
 * 下一步：amber apps check <id> → 编辑补 done/slot → amber run <id>（失败看 stopCode/reason）。
 */
`;

  const meta = `export const meta = (kit) => ({
  id: ${js(appId)},
  label: ${js(appId)},
  goal: ${js(goal)},
  hosts: ${JSON.stringify(hosts)},
  ${pagesLine}
  slots: {},
  // 结束态不变量：导出不发明，留空由作者补（空数组 = ctx.done() 恒过）。
  invariants: [],
});

export async function flow(ctx) {
  // TODO done 待作者补：下面每个 step 的 done 都是占位符 ${js(EXPORT_DONE_PLACEHOLDER)}。
  // 骨架的最短演化路径：先跑 apps check（dry 必过）→ 补一个真实 done → run 单步试通 → 再补全。
  ${openLine}

${body.join("\n")}${body.length > 0 ? "\n" : ""}  await ctx.done();
}
`;

  return { source: header + meta, steps: stepNo, failed, unresolved, warnings };
}

/** done 候选只作为注释：从轨迹记录的落点 URL 取一个有辨识度的路径段（不验证、不归纳）。 */
function doneCandidateFor(a: RecordedAction): string | null {
  if (typeof a.url !== "string" || a.url.trim() === "") return null;
  try {
    const u = new URL(a.url);
    const segs = u.pathname.split("/").filter((s) => s !== "");
    const clean = (s: string): string => s.replace(/\.(html?|php|aspx?)$/i, "");
    let token = segs.length > 0 ? clean(segs[segs.length - 1]!) : "";
    // 默认页（index.html/空串）没有辨识度：退回上一段（.../travel_2/index.html → travel_2）。
    if ((token === "" || token === "index" || token === "default") && segs.length >= 2) {
      token = clean(segs[segs.length - 2]!);
    }
    if (token !== "" && token.length >= 3) {
      return `ctx.judge.url(${js(token)})${u.search === "" ? "" : " （或含 query 的更精确写法）"}`;
    }
    return u.hostname === "" ? null : `ctx.judge.url(${js(u.hostname)})`;
  } catch {
    return null;
  }
}

/** 写盘 + 自检形状（不跑 apps check；那一步由调用方/验收执行）。 */
export function exportSessionRecord(opts: ExportOptions): ExportResult {
  const record = path.resolve(opts.cwd ?? process.cwd(), opts.record);
  const read = readRecord(record);
  const problems = [...read.problems];
  const appId = opts.id !== null && opts.id !== undefined && opts.id.trim() !== ""
    ? opts.id.trim()
    : slugAppId(record);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(appId)) {
    problems.push(`app id ${JSON.stringify(appId)} must be lowercase letters/digits/hyphens (use --id)`);
  }
  const hosts = opts.hosts !== null && opts.hosts !== undefined && opts.hosts.length > 0
    ? [...opts.hosts]
    : dedupe([
      ...(read.entry === null ? [] : [hostOf(read.entry)]),
      ...read.actions.map((a) => hostOf(a.url)),
    ].filter((h): h is string => h !== null));
  const goal = opts.goal !== null && opts.goal !== undefined && opts.goal.trim() !== ""
    ? opts.goal.trim()
    : "（待作者补：一句话目标——轨迹只记录动作，不记录意图）";
  const built = buildAppSource({
    actions: read.actions, entry: read.entry, marks: read.marks, appId, goal, hosts,
  });
  let outPath: string;
  const out = opts.out;
  if (out !== null && out !== undefined && out.trim() !== "") {
    const resolved = path.resolve(opts.cwd ?? process.cwd(), out);
    outPath = resolved.toLowerCase().endsWith(".mjs") ? resolved : path.join(resolved, "app.mjs");
  } else {
    outPath = path.join(amberflowHome(opts.env ?? process.env), "apps", appId, "app.mjs");
  }
  if (problems.length === 0) {
    if (fs.existsSync(outPath) && opts.force !== true) {
      problems.push(`${outPath} already exists (use --force to overwrite)`);
    } else {
      try {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, built.source, "utf-8");
      } catch (e) {
        problems.push(`cannot write ${outPath}: ${(e as Error).message}`);
      }
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    warnings: built.warnings,
    app_id: appId,
    path: outPath,
    steps: built.steps,
    failed_actions: built.failed,
    unresolved_actions: built.unresolved,
    done_placeholder: EXPORT_DONE_PLACEHOLDER,
  };
}

function dedupe(xs: string[]): string[] {
  const out: string[] = [];
  for (const x of xs) if (!out.includes(x)) out.push(x);
  return out;
}
