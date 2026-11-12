/**
 * `amber session` —— 交互式试错会话（task-33 / Phase 1）。
 *
 * 这是 **authoring 面**的薄入口：真正的事务在 `src/app/session-runtime.ts`
 *（createCtx + BrowserMiddleware.actOnce + checkSignal —— 与正式 run 同一份实现）。
 * 本文件只做 CLI 形状：解析 flags、建会话、按 stdin/`--input` 逐行驱动、把退出码翻成进程码。
 *
 * 协议（stdout 纯 JSONL，stderr 人话）：
 *   stdin  每行一个请求对象：{"type":"open|observe|act|read|extract|waitFor|signal|snapshot|mark|close", ...}
 *   stdout 每行一个响应对象：{"id":…, "type":…, "ok":…}（与请求一一对应、同序）
 *
 * 纪律：不改任何既有命令的默认行为；不新增依赖；不 import 决策 provider。
 */
import path from "node:path";
import { parseArgs } from "node:util";
import type { CliContext } from "../context.ts";
import { diag, emitJson, say } from "../context.ts";
import { EXIT, usageError, usageFromParseError } from "../errors.ts";
import { successEnvelope } from "../json.ts";
import { amberflowHome } from "../../support/amberflow-home.ts";
import { parseRunDefaults } from "../../support/run-defaults.ts";
import { runSession, SESSION_DEFAULT_IDLE_TIMEOUT_MS, type SessionSink } from "../../app/session-runtime.ts";
import { exportSessionRecord } from "../../app/session-export.ts";
import { commandHelp } from "../registry.ts";

const EXPORT_USAGE = `amber session export --record <轨迹文件> [--out <app.mjs|目录>] [--id <appId>]
                     [--goal "<一句话>"] [--host HOST]... [--force] [--json]`;

/** 从 `--url` 推 hosts（与 apps new 的推断同口径：只取主机名）。 */
function inferHosts(url: string | undefined): string[] | null {
  if (url === undefined || url.trim() === "") return null;
  try {
    const u = new URL(url);
    return u.hostname ? [u.hostname] : null;
  } catch {
    return null; // 相对仓库路径（file://）没有主机信封
  }
}

/**
 * `amber session export`：把 `--record` 轨迹还原成 app.mjs 骨架（Phase 2）。
 * 只出骨架、不归纳 done（占位符 + 注释候选），生成物必须能过 `amber apps check`。
 */
export async function runSessionExport(args: string[], ctx: CliContext): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    say(ctx, `session export —— 把 --record 动作轨迹导出成 app.mjs 骨架（done 未归纳，占位符待补）\n\n语法：\n  ${EXPORT_USAGE}`);
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
      },
    });
  } catch (err) {
    throw usageFromParseError(err);
  }
  const v = parsed.values;
  if (typeof v.record !== "string" || v.record.trim() === "") {
    throw usageError("session export 需要 --record <轨迹文件>（就是 `amber session --record` 写出的 JSONL）", {
      hint: "先跑一次 amber session --record <file>，再 export。",
      next: ["amber session --help", "amber help session"],
    });
  }
  const hosts: string[] = [];
  for (const h of v.host ?? []) for (const part of h.split(",")) if (part.trim()) hosts.push(part.trim());
  if (typeof v.hosts === "string") for (const part of v.hosts.split(",")) if (part.trim()) hosts.push(part.trim());
  const result = exportSessionRecord({
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
    throw usageError(`session export 失败：\n  - ${result.problems.join("\n  - ")}`, {
      next: ["amber session --help"],
    });
  }
  if (ctx.globals.json) {
    emitJson(ctx, successEnvelope("session export", {
      app_id: result.app_id,
      path: result.path,
      steps: result.steps,
      failed_actions: result.failed_actions,
      unresolved_actions: result.unresolved_actions,
      done_placeholder: result.done_placeholder,
      warnings: result.warnings,
      next: [`amber apps check ${result.app_id}`, `amber run ${result.app_id}`],
    }));
    return EXIT.OK;
  }
  say(ctx, `导出 app.mjs 骨架：${result.path}`);
  say(ctx, `  app id: ${result.app_id}`);
  say(ctx, `  steps: ${result.steps}（失败动作 ${result.failed_actions} 条以注释保留，待补值/待手写 ${result.unresolved_actions} 条）`);
  say(ctx, `  done: 占位符 ${JSON.stringify(result.done_placeholder)} —— 真跑前必须替换（export 不归纳 done）`);
  for (const w of result.warnings) say(ctx, `  ⚠ ${w}`);
  say(ctx, `下一步：amber apps check ${result.app_id} → 补 done/slot → amber run ${result.app_id}`);
  diag(ctx, `[session export] 轨迹 ${path.resolve(ctx.cwd, v.record)} → ${result.path}`);
  return EXIT.OK;
}


export async function runSessionCommand(args: string[], ctx: CliContext): Promise<number> {
  // Phase 2：`session export` 是同一命令下的子动词（聚合在 session 面，见 docs）。
  if (args[0] === "export") return runSessionExport(args.slice(1), ctx);
  if (args.includes("--help") || args.includes("-h")) {
    say(ctx, commandHelp("session"));
    return EXIT.OK;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      options: {
        url: { type: "string" },
        host: { type: "string", multiple: true },
        hosts: { type: "string" },
        headful: { type: "boolean" },
        input: { type: "string" },
        out: { type: "string" },
        record: { type: "string" },
        "record-values": { type: "boolean" },
        "idle-timeout-ms": { type: "string" },
        "max-request-bytes": { type: "string" },
        // A2：act 缺省歧义策略（fail = 歧义不执行；act = 恢复旧行为）。
        "on-ambiguous": { type: "string" },
        // 有头窗口尺寸：maximized（最大化，保留浏览器 chrome）| fullscreen（全屏，F11 语义）。
        window: { type: "string" },
      },
    });
  } catch (err) {
    throw usageFromParseError(err);
  }
  const v = parsed.values;

  // hosts：--host 可重复 > --hosts 逗号表 > 从 --url 推断（与 meta.hosts 同一信封语义）。
  const explicitHosts: string[] = [];
  for (const h of v.host ?? []) for (const part of h.split(",")) if (part.trim()) explicitHosts.push(part.trim());
  if (typeof v.hosts === "string") for (const part of v.hosts.split(",")) if (part.trim()) explicitHosts.push(part.trim());
  const hosts = explicitHosts.length > 0 ? explicitHosts : inferHosts(v.url);

  const runId = `${Date.now().toString(36)}-${process.pid}`;
  const outDir = typeof v.out === "string" && v.out.trim() !== ""
    ? path.resolve(ctx.cwd, v.out)
    : path.join(amberflowHome(ctx.env), "session", runId);

  const num = (raw: string | undefined, flag: string, lo: number, hi: number, allowZero: boolean): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < lo || n > hi || (!allowZero && n === lo)) {
      throw usageError(`${flag} 需要 ${lo}..${hi} 的整数（拿到 ${JSON.stringify(raw)}）`, {
        next: [`amber session --help`],
      });
    }
    return n;
  };
  const idleTimeoutMs = num(v["idle-timeout-ms"], "--idle-timeout-ms", 0, 24 * 60 * 60 * 1000, true);
  const maxRequestBytes = num(v["max-request-bytes"], "--max-request-bytes", 1024, 16 * 1024 * 1024, false);
  // A2：--on-ambiguous 闭集 fail|act；非法值 = 用法错误（exit 2 系），不静默取缺省。
  const onAmbiguousRaw = v["on-ambiguous"];
  if (onAmbiguousRaw !== undefined && onAmbiguousRaw !== "fail" && onAmbiguousRaw !== "act") {
    throw usageError(`--on-ambiguous 需要 fail 或 act（拿到 ${JSON.stringify(onAmbiguousRaw)}）`, {
      hint: "缺省 fail（歧义不执行，回结构化 target_ambiguous + 候选证据）；act 恢复旧行为（直接执行可行动优先的第一个候选）。",
      next: ["amber session --help"],
    });
  }

  const sink: SessionSink = {
    // stdout 只能是协议行：一行一个 JSON 对象（不缩进，绝不混人话）。
    respond: (obj) => ctx.stdout(JSON.stringify(obj)),
    log: (line) => diag(ctx, `[session] ${line}`),
  };
  diag(ctx, `[session] ${runId}  idle=${idleTimeoutMs ?? SESSION_DEFAULT_IDLE_TIMEOUT_MS}ms  out=${outDir}`);
  // 运行参数的配置默认值（AMBERFLOW_HEADFUL 等 env 层）：--headful 旗标仍最优先。坏配置响亮报错。
  const { defaults: runDefaults, errors: runDefaultErrors } = parseRunDefaults();
  if (runDefaultErrors.length) {
    for (const e of runDefaultErrors) console.error(e);
    return 2;
  }
  const headful = v.headful === true || runDefaults.headful === true;
  // 窗口尺寸模式（--window）：值闭集校验；只有有头能生效——headless 下静默忽略就是「配了没
  // 反应」，按仓库纪律响亮报用法错误（exit 2）。
  const windowRaw = typeof v.window === "string" ? v.window.trim() : "";
  let windowMode: "maximized" | "fullscreen" | undefined;
  if (windowRaw !== "") {
    if (windowRaw !== "maximized" && windowRaw !== "fullscreen") {
      throw usageError(`--window 只接受 maximized 或 fullscreen（拿到 ${JSON.stringify(windowRaw)}）`, {
        next: ["amber session --url <页面> --headful --window maximized"],
      });
    }
    if (!headful) {
      throw usageError("--window 只在有头模式生效：与 --headful 一起用（或配置层 AMBERFLOW_HEADFUL=1）", {
        next: ["amber session --url <页面> --headful --window maximized"],
      });
    }
    windowMode = windowRaw;
  }
  const code = await runSession({
    url: v.url ?? null,
    hosts,
    // --headful（CLI 旗标）> AMBERFLOW_HEADFUL（env 层，桥配置页勾选 HEADFUL 时注入）
    // > 缺省 headless：与 run 的层叠同一条纪律。
    headful,
    ...(windowMode === undefined ? {} : { window: windowMode }),
    outDir,
    record: typeof v.record === "string" ? path.resolve(ctx.cwd, v.record) : null,
    // task-34：明文值只在作者显式 opt-in 时进轨迹（缺省仍只记 value_hash）。
    recordValues: v["record-values"] === true,
    inputFile: typeof v.input === "string" ? path.resolve(ctx.cwd, v.input) : null,
    // A2：缺省 fail（会话不再在歧义上"随便点第一个"）；--on-ambiguous act 恢复旧行为。
    onAmbiguous: onAmbiguousRaw === "act" ? "act" : "fail",
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    ...(maxRequestBytes === undefined ? {} : { maxRequestBytes }),
    verbose: ctx.globals.verbose,
    quiet: ctx.globals.quiet,
    env: ctx.env,
  }, sink);
  return code;
}
