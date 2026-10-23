import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { CliContext } from "../context.ts";
import { say, emitJson } from "../context.ts";
import { usageError, usageFromParseError } from "../errors.ts";
import { successEnvelope } from "../json.ts";
import { stringValue } from "../args.ts";
import { checkArtifacts, missingPieces, onnxModelPath } from "../../model/model-artifacts.ts";
import { findDefaultTokenizerDir } from "../../model/laya-onnx.ts";

function parse(args: string[], options: Record<string, { type: "boolean" | "string" }>) {
  try {
    return parseArgs({ args, allowPositionals: true, options });
  } catch (err) {
    throw usageFromParseError(err);
  }
}

function wantsJson(ctx: CliContext, v: { json?: boolean }): boolean {
  return ctx.globals.json || Boolean(v.json);
}

export async function runModel(args: string[], ctx: CliContext): Promise<number> {
  let sub = args[0];
  let rest = args.slice(1);
  if (sub === undefined || sub === "--help" || sub === "-h") {
    if (sub === "--help" || sub === "-h") {
      const { commandHelp } = await import("../registry.ts");
      say(ctx, commandHelp("model"));
      return 0;
    }
    sub = "status";
    rest = args;
  }
  switch (sub) {
    case "status": return modelStatus(rest, ctx);
    case "path": return modelPath(rest, ctx);
    case "fetch": return modelFetch(rest, ctx);
    default:
      throw usageError(`未知的 model 子命令 '${sub}'`, {
        hint: "可用：status / fetch / path",
        next: ["amber model --help"],
      });
  }
}

function modelStatus(args: string[], ctx: CliContext): number {
  const parsed = parse(args, { json: { type: "boolean" }, help: { type: "boolean" } });
  if (parsed.values.help) {
    say(ctx, "用法：amber model status [--json]");
    return 0;
  }
  const path = onnxModelPath(ctx.env);
  const artifacts = checkArtifacts(path);
  const missing = missingPieces(artifacts);
  if (wantsJson(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("model status", {
      ready: artifacts.ready,
      onnx: artifacts.onnxPath,
      data: artifacts.dataPath,
      graph: artifacts.graph,
      weights: artifacts.weights,
      tokenizer: artifacts.tokenizerDir,
      missing,
    }, {
      next: artifacts.ready ? ["amber run <id>"] : ["amber model fetch --from <url 或本地路径>"],
    }));
    return 0;
  }
  say(ctx, `决策模型：${artifacts.ready ? "✓ 真模型（图 + 权重 + tokenizer 齐）" : `✗ 缺 ${missing.join(" / ")}`}`);
  say(ctx, `  ONNX：     ${artifacts.onnxPath}${artifacts.graph ? "  ✓" : "  ✗"}`);
  say(ctx, `  外置权重： ${artifacts.dataPath}${artifacts.weights ? "  ✓" : "  ✗"}`);
  say(ctx, `  tokenizer：${artifacts.tokenizerDir ?? "（未找到）"}${artifacts.tokenizerDir ? "  ✓" : "  ✗"}`);
  if (!artifacts.ready) {
    say(ctx, "");
    say(ctx, "下一步：amber model fetch --from <url 或本地路径>");
  }
  return 0;
}

function modelPath(args: string[], ctx: CliContext): number {
  const parsed = parse(args, { json: { type: "boolean" }, help: { type: "boolean" } });
  if (parsed.values.help) {
    say(ctx, "用法：amber model path");
    return 0;
  }
  const p = onnxModelPath(ctx.env);
  if (wantsJson(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("model path", { path: p }));
  } else {
    say(ctx, p);
  }
  return 0;
}

async function modelFetch(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parse(args, {
    from: { type: "string" }, to: { type: "string" },
    "sha256-onnx": { type: "string" }, "sha256-data": { type: "string" },
    "sha256-tokenizer": { type: "string" }, tokenizer: { type: "string" },
    force: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" },
  });
  if (parsed.values.help) {
    say(ctx, "用法：amber model fetch --from <url|路径> [--to <onnx>] [--sha256-onnx <hex>] [--sha256-data <hex>] [--tokenizer <路径|url>] [--sha256-tokenizer <hex>] [--force]");
    return 0;
  }
  const from = stringValue(parsed.values.from);
  if (!from) throw usageError("model fetch 需要 --from <url 或本地路径>", {
    next: ["amber model fetch --from D:/models/laya_dec.onnx"],
  });
  const oldArgs = ["--from", from];
  const to = stringValue(parsed.values.to);
  if (to) oldArgs.push("--out", to);
  const shaOnnx = stringValue(parsed.values["sha256-onnx"]);
  if (shaOnnx) oldArgs.push("--sha256-onnx", shaOnnx);
  const shaData = stringValue(parsed.values["sha256-data"]);
  if (shaData) oldArgs.push("--sha256-data", shaData);
  const tokenizer = stringValue(parsed.values.tokenizer);
  if (tokenizer) oldArgs.push("--tokenizer", tokenizer);
  const shaTokenizer = stringValue(parsed.values["sha256-tokenizer"]);
  if (shaTokenizer) oldArgs.push("--sha256-tokenizer", shaTokenizer);
  if (parsed.values.force) oldArgs.push("--force");
  const jsonMode = parsed.values.json || ctx.globals.json;
  if (!jsonMode) {
    return ctx.runEntry("src/model/model-fetch.ts", oldArgs, { cwd: ctx.cwd, env: ctx.env });
  }
  // 安装过程的人类进度走 stderr；结束后以磁盘上的实际产物为准生成信封。
  const code = await ctx.runEntry("src/model/model-fetch.ts", oldArgs, {
    cwd: ctx.cwd,
    env: ctx.env,
    stdoutToStderr: true,
  });
  // 探测必须盯着**这次安装的落点**（--to/--out 是自定义路径时默认约定路径一无所知），
  // 并把装到落点旁的 tokenizer 也认出来——与 model-fetch 自检保持同一套口径。
  const targetOnnx = to ? path.resolve(ctx.cwd, to) : onnxModelPath(ctx.env);
  const tokDest = path.join(path.dirname(targetOnnx), "tokenizer", "tokenizer.json");
  const artifacts = checkArtifacts(targetOnnx, () =>
    findDefaultTokenizerDir() ?? (fs.existsSync(tokDest) ? path.dirname(tokDest) : null));
  // 自定义落点 ≠ 引擎约定路径：不加一行，agent 会误以为 ready 就能直接跑。
  const diagnostics: string[] = [];
  if (to && targetOnnx !== onnxModelPath(ctx.env)) {
    diagnostics.push(`落点在自定义路径；引擎只认 LAYA_ONNX_MODEL 指向的位置，运行前请先设置。`);
  }
  const next = artifacts.ready ? (to && diagnostics.length ? [
    "amber model status",
    `amber config set LAYA_ONNX_MODEL ${targetOnnx}`,
  ] : ["amber model status", "amber run <id>"]) : ["amber model status", "amber doctor"];
  const envelope = successEnvelope("model fetch", {
    installed: code === 0 && artifacts.ready,
    ready: artifacts.ready,
    onnx: artifacts.onnxPath,
    data: artifacts.dataPath,
    tokenizer: artifacts.tokenizerDir,
    missing: missingPieces(artifacts),
  }, { exitCode: code, diagnostics, next });
  if (code !== 0) {
    envelope.ok = false;
    envelope.error = {
      code: code === 130 ? "INTERRUPTED" : code === 2 ? "USAGE" : "INCOMPLETE",
      message: `模型安装未完成（退出码 ${code}）`,
      hint: "安装进度与诊断在 stderr。",
      next,
    };
  }
  emitJson(ctx, envelope);
  return code;
}
