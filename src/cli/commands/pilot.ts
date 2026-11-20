/**
 * `amber pilot` —— 模型驾驶走查（PW2；方案见 docs/PILOTED_WALKTHROUGH_PLAN.md）。
 *
 * 这是**驾驶面**的薄入口：决策模型逐步投票（规则档先行），Agent 只在停因交接时兜底。
 * 本文件只做 CLI 形状：解析 flags → runPilot（驾驶/兜底回路在 src/app/pilot-entry.ts）。
 *
 * 协议（stdout 纯 JSONL，stderr 人话）：
 *   stdout started / drive / handoff / command_result / pilot_end 各一行一个 JSON 对象
 *   （pilot_end 只发一条：idle/中断/异常的 code 并进汇总行，不重复发终态）；
 *   stdin  兜底指令闭集（每行一个 JSON 对象；被拒 = 单行失败，继续等下一条）：
 *     {"cmd":"resume","hint":"…","value":{"k":"v"},"skip":true}
 *         解除交接继续驾驶：hint 点名即确定性执行（零模型）；value 对象 = 多槽 k:v
 *         显式给值；skip = 把最近一次驾驶选中的目标加入禁选后继续。
 *     {"cmd":"redirect","url":"…"} | {"cmd":"redirect","goal":"…"}
 *         换入口或换目标（步史与禁选清段重新累计；预算不清零）。
 *     {"cmd":"finish","signal":{…}}
 *         声明最终信号——引擎 checkSignal 验证成立才记 final_signal_held（exit 0）；
 *         未声明 --final-signal 且不带 signal = config_error 单行拒绝。
 *     {"cmd":"abort"}   终止（落已走轨迹，exit 3）。
 *
 * --driver（缺省 model）：model = 决策模型投票驾驶；agent = 消融对照臂——每步投影
 * step_request（有界候选含 hint_candidates），等 Agent resume{hint} 点名，零模型票。
 *
 * 纪律：不改任何既有命令的默认行为；不新增依赖；产物恒带 pilot:true。
 */
import path from "node:path";
import { parseArgs } from "node:util";
import type { CliContext } from "../context.ts";
import { diag, emitJson, say } from "../context.ts";
import { EXIT, usageError, usageFromParseError } from "../errors.ts";
import { successEnvelope } from "../json.ts";
import { amberflowHome } from "../../support/amberflow-home.ts";
import { parseRunDefaults } from "../../support/run-defaults.ts";
import { runPilot } from "../../app/pilot-entry.ts";
import type { PilotSink } from "../../app/pilot-runtime.ts";
import { exportPilotRecord } from "../../app/pilot-export.ts";
import { commandHelp } from "../registry.ts";

const EXPORT_USAGE = `amber pilot export --record <轨迹文件> [--out <app.mjs|目录>] [--id <appId>]
                    [--goal "<一句话>"] [--host HOST]... [--force] [--json]`;

/** 从 `--url` 推 hosts（与 session 的推断同口径：只取主机名）。 */
function inferHosts(url: string | undefined): string[] | null {
  if (url === undefined || url.trim() === "") return null;
  try {
    const u = new URL(url);
    return u.hostname ? [u.hostname] : null;
  } catch {
    return null;
  }
}

/**
 * `amber pilot export`（PW3）：把驾驶轨迹（--record JSONL）还原成 app.mjs 骨架。
 * 与 session export 同一纪律：只出骨架、不归纳 done；驾驶来源标记（picked_by）忠实保留。
 */
export async function runPilotExport(args: string[], ctx: CliContext): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    say(ctx, `pilot export —— 把 --record 驾驶轨迹导出成 app.mjs 骨架（done 未归纳，占位符待补）\n\n语法：\n  ${EXPORT_USAGE}`);
    return EXIT.OK;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      options: {
        record: { type: "string" },
        out: { type: "string" },
        id: { type: "string" },
        goal: { type: "string" },
        host: { type: "string", multiple: true },
        hosts: { type: "string" },
        force: { type: "boolean" },
        json: { type: "boolean" },
      },
    });
  } catch (err) {
    throw usageFromParseError(err);
  }
  const v = parsed.values;
  if (typeof v.record !== "string" || v.record.trim() === "") {
    throw usageError("pilot export 需要 --record <轨迹文件>（就是 `amber pilot --record` 写出的 JSONL）", {
      hint: "先跑一次 amber pilot --url … --record <file>，再 export。",
      next: ["amber pilot --help"],
    });
  }
  const hosts: string[] = [];
  for (const h of v.host ?? []) for (const part of h.split(",")) if (part.trim()) hosts.push(part.trim());
  if (typeof v.hosts === "string") for (const part of v.hosts.split(",")) if (part.trim()) hosts.push(part.trim());
  const result = exportPilotRecord({
    record: v.record,
    out: typeof v.out === "string" ? v.out : null,
    id: typeof v.id === "string" ? v.id : null,
    goal: typeof v.goal === "string" ? v.goal : null,
    hosts: hosts.length > 0 ? hosts : null,
    force: v.force === true,
    cwd: ctx.cwd,
    env: ctx.env,
  });
  if (!result.ok) {
    throw usageError(`pilot export 失败：\n  - ${result.problems.join("\n  - ")}`, {
      next: ["amber pilot --help"],
    });
  }
  // --json 允许出现在命令后（全局约定）：globals 已置位或本命令位都走 envelope 输出。
  if (ctx.globals.json || v.json === true) {
    emitJson(ctx, successEnvelope("pilot export", {
      app_id: result.app_id,
      path: result.path,
      steps: result.steps,
      failed_actions: result.failed_actions,
      model_picks: result.model_picks,
      rule_picks: result.rule_picks,
      handoffs: result.handoffs,
      done_placeholder: result.done_placeholder,
      warnings: result.warnings,
      next: [`amber apps check ${result.app_id}`, `amber run ${result.app_id}`],
    }));
    return EXIT.OK;
  }
  say(ctx, `导出 app.mjs 骨架：${result.path}`);
  say(ctx, `  app id: ${result.app_id}`);
  say(ctx, `  steps: ${result.steps}（决策票 ${result.model_picks} 步 / 规则档 ${result.rule_picks} 步；失败动作 ${result.failed_actions} 条以注释保留）`);
  say(ctx, `  handoffs: ${result.handoffs} 次停因交接（注释保留兜底上下文，人工核对后再固化）`);
  say(ctx, `  done: 占位符 ${JSON.stringify(result.done_placeholder)} —— 真跑前必须替换（export 不归纳 done）`);
  for (const w of result.warnings) say(ctx, `  ⚠ ${w}`);
  say(ctx, `下一步：amber apps check ${result.app_id} → 补 done/slot → amber run ${result.app_id}`);
  diag(ctx, `[pilot export] 轨迹 ${path.resolve(ctx.cwd, v.record)} → ${result.path}`);
  return EXIT.OK;
}

function parseSlots(raw: string[] | undefined, flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of raw ?? []) {
    for (const part of item.split(",")) {
      const kv = part.trim();
      if (kv === "") continue;
      const eq = kv.indexOf("=");
      if (eq <= 0 || eq >= kv.length - 1) {
        throw usageError(`${flag} 需要 k=v 形式（拿到 ${JSON.stringify(part)}）`, {
          next: ["amber pilot --help"],
        });
      }
      out[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
    }
  }
  return out;
}

export async function runPilotCommand(args: string[], ctx: CliContext): Promise<number> {
  // PW3：`pilot export` 是同一命令下的子动词（与 session export 同一聚合纪律）。
  if (args[0] === "export") return runPilotExport(args.slice(1), ctx);
  if (args.includes("--help") || args.includes("-h")) {
    say(ctx, commandHelp("pilot"));
    return EXIT.OK;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      options: {
        url: { type: "string" },
        goal: { type: "string" },
        host: { type: "string", multiple: true },
        hosts: { type: "string" },
        "final-signal": { type: "string" },
        "max-steps": { type: "string" },
        "conf-floor": { type: "string" },
        slot: { type: "string", multiple: true },
        input: { type: "string" },
        out: { type: "string" },
        record: { type: "string" },
        "idle-timeout-ms": { type: "string" },
        headful: { type: "boolean" },
        driver: { type: "string" },
        // 全局约定：--json 允许出现在命令后、命令解析器会再看到一次——声明并吞掉，
        // stdout 本就是 JSONL 协议流，不再叠加 envelope 输出。
        json: { type: "boolean" },
      },
    });
  } catch (err) {
    throw usageFromParseError(err);
  }
  const v = parsed.values;

  if (typeof v.url !== "string" || v.url.trim() === "") {
    throw usageError("pilot 需要 --url <入口页>", { next: ["amber pilot --help"] });
  }
  if (typeof v.goal !== "string" || v.goal.trim() === "") {
    throw usageError("pilot 需要 --goal \"<一句话总目标>\"", { next: ["amber pilot --help"] });
  }

  // hosts：--host 可重复 > --hosts 逗号表 > 从 --url 推断（与 session 同一信封语义）。
  const explicitHosts: string[] = [];
  for (const h of v.host ?? []) for (const part of h.split(",")) if (part.trim()) explicitHosts.push(part.trim());
  if (typeof v.hosts === "string") for (const part of v.hosts.split(",")) if (part.trim()) explicitHosts.push(part.trim());
  const hosts = explicitHosts.length > 0 ? explicitHosts : inferHosts(v.url);

  // 最终信号（--final-signal '<JSON>'）：完成只认信号；坏 JSON = 用法错误，不猜。
  let finalSignal: Record<string, unknown> | null = null;
  if (typeof v["final-signal"] === "string" && v["final-signal"].trim() !== "") {
    try {
      const spec: unknown = JSON.parse(v["final-signal"]);
      if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
        throw new Error("signal spec must be a JSON object");
      }
      finalSignal = spec as Record<string, unknown>;
    } catch (e) {
      throw usageError(`--final-signal 需要一个 JSON 对象（拿到 ${JSON.stringify(v["final-signal"])}：${e instanceof Error ? e.message : String(e)}）`, {
        hint: '例如 --final-signal \'{"url_contains":"/success"}\'',
        next: ["amber pilot --help"],
      });
    }
  }

  // 边界含两端：下界本身合法（--max-steps 1 可用；--idle-timeout-ms 0 = 不限）。
  const num = (raw: string | undefined, flag: string, lo: number, hi: number): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < lo || n > hi) {
      throw usageError(`${flag} 需要 ${lo}..${hi} 的整数（拿到 ${JSON.stringify(raw)}）`, {
        next: ["amber pilot --help"],
      });
    }
    return n;
  };
  const maxSteps = num(v["max-steps"], "--max-steps", 1, 200);
  const idleTimeoutMs = num(v["idle-timeout-ms"], "--idle-timeout-ms", 0, 24 * 60 * 60 * 1000);
  // --driver model|agent：消融对照臂（agent = 每步等 resume{hint} 点名，零模型票）。
  const driver = v.driver === undefined ? undefined : String(v.driver);
  if (driver !== undefined && driver !== "model" && driver !== "agent") {
    throw usageError(`--driver 只接受 model | agent（拿到 ${JSON.stringify(v.driver)}）`, {
      next: ["amber pilot --help"],
    });
  }
  let confFloor: number | undefined;
  if (typeof v["conf-floor"] === "string") {
    const f = Number(v["conf-floor"]);
    if (!Number.isFinite(f) || f < 0 || f > 1) {
      throw usageError(`--conf-floor 需要 [0, 1] 的数（拿到 ${JSON.stringify(v["conf-floor"])}）`, {
        next: ["amber pilot --help"],
      });
    }
    confFloor = f;
  }

  const slots = parseSlots(v.slot, "--slot");
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  const outDir = typeof v.out === "string" && v.out.trim() !== ""
    ? path.resolve(ctx.cwd, v.out)
    : path.join(amberflowHome(ctx.env), "pilot", runId);

  const sink: PilotSink = {
    respond: (obj) => ctx.stdout(JSON.stringify(obj)),
  };
  const { defaults: runDefaults, errors: runDefaultErrors } = parseRunDefaults();
  if (runDefaultErrors.length) {
    for (const e of runDefaultErrors) console.error(e);
    return 2;
  }
  const headful = v.headful === true || runDefaults.headful === true;
  diag(ctx, `[pilot] ${runId}  max-steps=${maxSteps ?? 12}  conf-floor=${confFloor ?? 0.25}  out=${outDir}`);

  return await runPilot({
    url: v.url,
    goal: v.goal,
    hosts,
    ...(finalSignal === null ? {} : { finalSignal }),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(confFloor === undefined ? {} : { confFloor }),
    ...(driver === undefined ? {} : { driver }),
    ...(Object.keys(slots).length === 0 ? {} : { slots }),
    inputFile: typeof v.input === "string" ? path.resolve(ctx.cwd, v.input) : null,
    outDir,
    record: typeof v.record === "string" ? path.resolve(ctx.cwd, v.record) : null,
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    headful,
    verbose: ctx.globals.verbose,
    quiet: ctx.globals.quiet,
    env: ctx.env,
  }, sink);
}
