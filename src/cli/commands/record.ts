import { parseArgs } from "node:util";
import type { CliContext } from "../context.ts";
import { say, emitJson } from "../context.ts";
import { usageError, usageFromParseError } from "../errors.ts";
import { successEnvelope } from "../json.ts";

/**
 * learn --json 仍会往 stdout 打逐步日志（历史行为），最后才写结果对象。
 * 从后往前找以 `{` 开头的行，找到能整体解析的那个；日志部分交还给 stderr。
 */
function parseTrailingJson(stdout: string): { value: unknown | null; prefix: string } {
  const text = stdout.trim();
  if (!text) return { value: null, prefix: "" };
  try {
    return { value: JSON.parse(text), prefix: "" };
  } catch {
    // 继续找末尾的 JSON 对象。
  }
  const starts: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" && (i === 0 || text[i - 1] === "\n" || text[i - 1] === "\r")) {
      starts.push(i);
    }
  }
  for (let i = starts.length - 1; i >= 0; i--) {
    const start = starts[i]!;
    try {
      return { value: JSON.parse(text.slice(start)), prefix: text.slice(0, start) };
    } catch {
      // 试更早的对象起点。
    }
  }
  return { value: null, prefix: "" };
}

export async function runRecord(args: string[], ctx: CliContext): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        name: { type: "string" }, id: { type: "string" },
        goal: { type: "string" }, cdp: { type: "string" }, url: { type: "string" },
        out: { type: "string" }, "apps-dir": { type: "string" }, script: { type: "string" },
        yes: { type: "boolean" }, json: { type: "boolean" },
        headless: { type: "boolean" }, headful: { type: "boolean" },
        quiet: { type: "boolean" }, help: { type: "boolean" },
      },
    });
  } catch (err) {
    throw usageFromParseError(err);
  }
  const v = parsed.values;
  if (v.help) {
    const { commandHelp } = await import("../registry.ts");
    say(ctx, commandHelp("record"));
    return 0;
  }
  if (v.name && v.id) throw usageError("--name 与 --id 只能选一个（--id 是旧名）");
  if (v.headless && v.headful) throw usageError("--headless 与 --headful 只能选一个");
  const positional = parsed.positionals[0];
  if (parsed.positionals.length > 1) throw usageError("record 最多接受一个页面 URL");
  if (positional && v.url) throw usageError("页面 URL 给位置参数或 --url 即可，不要同时给");
  const url = positional ?? v.url;
  if (v.script && !url && !v.cdp) {
    throw usageError("--script 回放仍需要一个页面：请同时给 --url 或 --cdp", {
      next: ["amber record https://shop.example.com --script ./demo-actions.json --yes"],
    });
  }
  if (!url && !v.cdp && !ctx.isTTY) {
    throw usageError("record 需要 --url <页面> 或 --cdp <ws://…>", {
      hint: "非 TTY 不等待输入；CI / Agent 请给 --url 或 --cdp。",
      next: [
        "amber record https://shop.example.com --name my-app",
        "amber record https://shop.example.com --script ./demo-actions.json --yes",
      ],
    });
  }

  // 新 record 默认 headful；旧 learn/agent 的 headless 默认只留在兼容层。
  const oldArgs: string[] = [];
  const id = v.name ?? v.id;
  if (id) oldArgs.push("--id", id);
  if (url) oldArgs.push("--url", url);
  if (v.cdp) oldArgs.push("--cdp", v.cdp);
  if (v.goal) oldArgs.push("--goal", v.goal);
  if (v.out) oldArgs.push("--out", v.out);
  if (v["apps-dir"]) oldArgs.push("--apps-dir", v["apps-dir"]);
  if (v.script) oldArgs.push("--script", v.script);
  if (v.yes || ctx.globals.yes) oldArgs.push("--yes");
  if (v.json || ctx.globals.json) oldArgs.push("--json");
  if (v.quiet || ctx.globals.quiet) oldArgs.push("--quiet");
  if (!v.headless || v.headful) oldArgs.push("--headful");

  const jsonMode = v.json || ctx.globals.json;
  if (!jsonMode) {
    return ctx.runEntry("tools/learn.ts", oldArgs, { cwd: ctx.cwd, env: ctx.env });
  }

  // learn --json 已经会输出一个结构化对象；这里只把它包成统一信封。
  // stdout 必须由 CLI 独占，所以子进程的输出先收进内存再解析。
  const { runNodeEntryCapture } = await import("../process.ts");
  const timeoutMs = ctx.globals.timeout !== null ? Number(ctx.globals.timeout) * 1000 : null;
  const { code, stdout } = await runNodeEntryCapture("tools/learn.ts", oldArgs, {
    cwd: ctx.cwd,
    env: ctx.env,
    timeoutMs,
  });
  const parsedOutput = parseTrailingJson(stdout);
  if (parsedOutput.prefix.trim()) ctx.stderr(parsedOutput.prefix.trimEnd());
  let result: Record<string, unknown> | null = null;
  if (parsedOutput.value && typeof parsedOutput.value === "object" && !Array.isArray(parsedOutput.value)) {
    result = parsedOutput.value as Record<string, unknown>;
  } else if (stdout.trim() && !parsedOutput.value) {
    // 没有可解析对象时，把旧入口的 stdout 原样转到 stderr，避免诊断丢失。
    ctx.stderr(stdout.trimEnd());
  }
  const app = typeof result?.app === "string" ? result.app : id ?? null;
  const next = code === 0
    ? [...(app ? [`amber run ${app}`] : []), "amber apps list"]
    : ["amber doctor", "amber record --help"];
  const envelope = successEnvelope("record", result ?? { app, saved: null }, { exitCode: code, next });
  if (code !== 0) {
    const replayFailed = result?.status === "replay-failed";
    envelope.ok = false;
    envelope.error = {
      code: code === 130 ? "INTERRUPTED" : code === 2 ? "USAGE" : "INCOMPLETE",
      message: replayFailed ? "回放没通过，录制没有落盘" : `录制未完成（退出码 ${code}）`,
      hint: replayFailed
        ? "页面或信号不稳定；重新演示，或先检查 stderr 里的失败不变量。"
        : "诊断在 stderr；修好后重试。",
      next,
    };
  }
  emitJson(ctx, envelope);
  return code;
}
