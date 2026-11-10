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
import { diag, say } from "../context.ts";
import { EXIT, usageError, usageFromParseError } from "../errors.ts";
import { amberflowHome } from "../../app/amberflow-home.ts";
import { runSession, SESSION_DEFAULT_IDLE_TIMEOUT_MS, type SessionSink } from "../../app/session-runtime.ts";
import { commandHelp } from "../registry.ts";

const USAGE = `amber session [--url <入口页>] [--host HOST]... [--hosts h1,h2]
              [--headful] [--input <请求文件>] [--out <目录>]
              [--record <轨迹文件>] [--idle-timeout-ms N] [--max-request-bytes N]`;

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

export async function runSessionCommand(args: string[], ctx: CliContext): Promise<number> {
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
        "idle-timeout-ms": { type: "string" },
        "max-request-bytes": { type: "string" },
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

  const sink: SessionSink = {
    // stdout 只能是协议行：一行一个 JSON 对象（不缩进，绝不混人话）。
    respond: (obj) => ctx.stdout(JSON.stringify(obj)),
    log: (line) => diag(ctx, `[session] ${line}`),
  };
  diag(ctx, `[session] ${runId}  idle=${idleTimeoutMs ?? SESSION_DEFAULT_IDLE_TIMEOUT_MS}ms  out=${outDir}`);
  const code = await runSession({
    url: v.url ?? null,
    hosts,
    headful: v.headful === true,
    outDir,
    record: typeof v.record === "string" ? path.resolve(ctx.cwd, v.record) : null,
    inputFile: typeof v.input === "string" ? path.resolve(ctx.cwd, v.input) : null,
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    ...(maxRequestBytes === undefined ? {} : { maxRequestBytes }),
    verbose: ctx.globals.verbose,
    quiet: ctx.globals.quiet,
    env: ctx.env,
  }, sink);
  return code;
}
