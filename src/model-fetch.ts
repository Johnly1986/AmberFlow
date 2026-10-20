#!/usr/bin/env node
/**
 * 权重通道（LAYA_VALUE_PLAN P0）——让"想体验模型兜底的人"**有路可走**。
 *
 *   npm run model:fetch -- --from <url|file://|本地路径> [--sha256-onnx <hex>] [--sha256-data <hex>]
 *                         [--out <laya_dec.onnx>] [--tokenizer <path|url>] [--force]
 *
 * `--from` 给 `.onnx` 文件（权重按 onnxruntime 的 external-data 约定取 `.onnx.data` 兄弟件），
 * 或给一个**目录/URL 前缀**（按 `laya_dec.onnx` + `laya_dec.onnx.data` 找）。目标落点沿用
 * 全仓库的同一约定（`src/model-artifacts.ts`）：`LAYA_ONNX_MODEL` 环境变量，默认
 * `/tmp/laya_dec.onnx`——doctor 报的路径与这里装的路径永远是同一个。
 *
 * 四条纪律（和这个仓库对"落盘"的一切要求同源）：
 *   1. **先验后换**：写到 `.part`，算完 SHA256 才 rename 就位——坏产物绝不覆盖好产物；
 *   2. **校验是点名而不是点头**：给了 `--sha256-*` 就必须等值，不符就删 `.part` 并以失败退出；
 *      没给就**打印实测 digest**（"未校验"三个字照写），让分发方下一轮能把它钉住；
 *   3. **不覆盖已有**（除非 `--force`）：产物 1.7GB，误覆盖的代价是人重新下载一整轮；
 *   4. **不留半途态**：一组里某件失败时，本轮**新装**的兄弟件一起撤回（动工前已存在的一件未动）——
 *      否则"图装上了、权重没装上"的重跑会被第 3 条的覆盖保护挡住，把人锁在既不齐又不让补的状态里。
 *
 * 本仓库没有公开源，所以通道先认 `file://`/本地路径——这正是方案工作量表里
 * "先做 `--from <本地路径/file://>` 让通道成型，URL 源后补"的那一条；http(s) 同步支持，
 * 流式下载不吞内存。
 */
import crypto from "node:crypto";
import { isParseUsageError, usageErrorLine } from "./cli-args.ts";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { findDefaultTokenizerDir } from "./laya-onnx.ts";
import { onnxModelPath, weightsPathOf, checkArtifacts, missingPieces } from "./model-artifacts.ts";
import { applyRcToEnv } from "./rcfile.ts";

/** 图/权重对的文件名约定（HF 仓库里 laya 的导出形状）。 */
const GRAPH_NAME = "laya_dec.onnx";

export interface FetchIo {
  out(line: string): void;
}

const defaultIo: FetchIo = { out: (line) => console.log(line) };

/** 测试缝：注入取回函数（http 流或本地复制），返回实测 sha256。 */
export interface FetchDeps {
  /** 把一个源（URL 或本地路径）落进 destPart，边写边算 sha256。 */
  transfer?: (src: string, destPart: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}

/** `--from` 的两种形状：点名 `.onnx` 文件，或给目录/前缀。返回两件产物的源地址。 */
export function resolveSources(from: string): { onnx: string; data: string } {
  const clean = from.replace(/[?#].*$/, "");
  if (/\.onnx$/i.test(clean)) return { onnx: from, data: `${from}.data` };
  const sep = /\/$/.test(from) ? "" : "/";
  const base = `${from}${sep}`;
  return { onnx: `${base}${GRAPH_NAME}`, data: `${base}${GRAPH_NAME}.data` };
}

/** 增量 hash 的流水线件：字节照流过，顺手喂给 sha256。 */
function tapHash(hash: crypto.Hash): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null, data?: Buffer) => void) {
      hash.update(chunk);
      cb(null, chunk);
    },
  });
}

/** 本地文件（含 file://）流式复制到 .part 并返回 sha256。 */
async function copyLocal(srcPath: string, destPart: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const ws = fs.createWriteStream(destPart);
  try {
    await pipeline(fs.createReadStream(srcPath), tapHash(hash), ws);
  } catch (e) {
    try { fs.rmSync(destPart, { force: true }); } catch { /* 尽力清理 */ }
    throw e;
  }
  return hash.digest("hex");
}

/** http(s)：流式下载 + 增量 hash；非 200 直接失败（产物不分"半张图"）。 */
async function downloadHttp(
  url: string, destPart: string, fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(url);
  if (!res.ok || res.body === null) {
    throw new Error(`下载失败：HTTP ${String(res.status)} ${res.statusText} — ${url}`);
  }
  const hash = crypto.createHash("sha256");
  const ws = fs.createWriteStream(destPart);
  try {
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), tapHash(hash), ws);
  } catch (e) {
    try { fs.rmSync(destPart, { force: true }); } catch { /* 尽力清理 */ }
    throw e;
  }
  return hash.digest("hex");
}

/** 把一个源（URL / file:// / 本地路径）落到 destPart，返回 sha256（默认实现，测试可整体注入）。 */
async function transfer(src: string, destPart: string, fetchImpl?: typeof fetch): Promise<string> {
  if (/^https?:\/\//i.test(src)) return downloadHttp(src, destPart, fetchImpl ?? fetch);
  const local = src.startsWith("file:") ? fileURLToPath(src) : path.resolve(src);
  if (!fs.existsSync(local)) throw new Error(`源不存在：${local}`);
  if (!fs.statSync(local).isFile()) throw new Error(`源不是文件：${local}`);
  return copyLocal(local, destPart);
}

const SHA_RE = /^[0-9a-f]{64}$/i;

/** 装一件产物：.part → 校验 → rename。坏件/校验不符以异常表达（.part 已删，现有产物未动）。 */
function installVerified(
  digest: string, expected: string | undefined, kind: string, shaFlag: string,
  dest: string, destPart: string, io: FetchIo,
): void {
  const label = `${kind}（${fs.statSync(destPart).size} 字节）`;
  if (expected !== undefined && digest !== expected.toLowerCase()) {
    fs.rmSync(destPart, { force: true });
    throw new Error(
      `SHA256 校验不符：${label}\n  期望 ${expected.toLowerCase()}\n  实得 ${digest}\n`
      + "  未安装（.part 已删，现有产物未动）。");
  }
  if (expected === undefined) {
    io.out(`  ${label}: sha256=${digest}（未提供期望值，未校验——把它写进分发说明，下次用 ${shaFlag} 钉住）`);
  } else {
    io.out(`  ${label}: sha256=${digest} ✓ 与期望一致`);
  }
  fs.renameSync(destPart, dest);
}

export const USAGE = `npm run model:fetch — 决策模型产物的安装通道（缺 → 一条命令补）

  npm run model:fetch -- --from <url|file://|本地路径>
      --from 给 laya_dec.onnx 文件本身（外置权重取同名 .onnx.data 兄弟件），
      或给一个目录/URL 前缀（自动找 laya_dec.onnx + laya_dec.onnx.data）。

  可选：
    --out <path>            图的落点（默认沿用 LAYA_ONNX_MODEL 约定，缺省 /tmp/laya_dec.onnx）
    --sha256-onnx <hex64>   图的期望 SHA256（给了就必须等值，不符不安装）
    --sha256-data <hex64>   权重的期望 SHA256
    --tokenizer <path|url>  tokenizer.json（装到 <out 目录>/tokenizer/，并打印 LAYA_TOKENIZER_DIR 用法）
    --sha256-tokenizer <hex64> 上件的期望 SHA256
    --force                 覆盖已有产物

  装完自检：npm run doctor   # 决策模型一行应变为 ✓ 真模型`;

export async function main(
  argv: string[] = process.argv.slice(2), io: FetchIo = defaultIo, deps: FetchDeps = {},
): Promise<number> {
  // rc 文件坏 = 配置类用法错误：在任何写盘动作之前逐行点名并 exit 2（src/rcfile.ts）。
  { const rc = applyRcToEnv(); if (rc.errors.length) { for (const e of rc.errors) console.error(e); return 2; } }
  let parsed;
  // 打错的参数 → 一行点名，绝不甩 parseArgs 的堆栈（src/cli-args.ts 的体例）。
  try {
    parsed = parseArgs({
    args: argv, allowPositionals: false,
    options: {
      from: { type: "string" }, out: { type: "string" },
      "sha256-onnx": { type: "string" }, "sha256-data": { type: "string" },
      "sha256-tokenizer": { type: "string" },
      tokenizer: { type: "string" }, force: { type: "boolean" }, help: { type: "boolean" },
    },
  });
  } catch (err) {
    if (!isParseUsageError(err)) throw err;
    console.error(usageErrorLine(err));
    return 2;
  }
  const v = parsed.values;
  if (v.help || !v.from) {
    io.out(USAGE);
    return v.help ? 0 : 2;
  }
  const onnxDest = String(v.out ?? onnxModelPath());
  const dataDest = weightsPathOf(onnxDest);
  const expect = {
    onnx: v["sha256-onnx"] as string | undefined,
    data: v["sha256-data"] as string | undefined,
    tokenizer: v["sha256-tokenizer"] as string | undefined,
  };
  for (const [name, val] of Object.entries(expect)) {
    if (val !== undefined && !SHA_RE.test(val)) {
      io.out(`--sha256-${name} 不是 64 位十六进制：${JSON.stringify(val)}`);
      return 2;
    }
  }
  const force = Boolean(v.force);
  const tokDest = path.join(path.dirname(onnxDest), "tokenizer", "tokenizer.json");
  // 覆盖保护在动工**之前**：先报冲突，别让人等一次 1.7GB 下载才知道不让写。
  for (const dest of [onnxDest, dataDest, ...(v.tokenizer ? [tokDest] : [])]) {
    if (fs.existsSync(dest) && !force) {
      io.out(`已存在：${dest}（不给 --force 不覆盖。想换一份就加 --force，想装到别处就加 --out）`);
      return 2;
    }
  }
  const { onnx: onnxSrc, data: dataSrc } = resolveSources(String(v.from));
  fs.mkdirSync(path.dirname(onnxDest), { recursive: true });

  const doTransfer = deps.transfer
    ?? ((src: string, destPart: string) => transfer(src, destPart, deps.fetchImpl));

  io.out(`源：${onnxSrc}`);
  io.out(`   ${dataSrc}`);
  io.out(`落点：${onnxDest}（约定见 src/model-artifacts.ts，与 doctor 同一处）`);

  const jobs: Array<{ src: string; dest: string; kind: string; expect?: string; shaFlag: string }> = [
    { src: onnxSrc, dest: onnxDest, kind: "图", expect: expect.onnx, shaFlag: "--sha256-onnx" },
    { src: dataSrc, dest: dataDest, kind: "权重", expect: expect.data, shaFlag: "--sha256-data" },
  ];
  if (v.tokenizer) jobs.push({ src: String(v.tokenizer), dest: tokDest, kind: "tokenizer",
    expect: expect.tokenizer, shaFlag: "--sha256-tokenizer" });

  // 半途态是陷阱：图装上了、权重没装上，重跑时**第一条就会被"不覆盖已有"挡住**，用户被困在
  // 一个既不齐又不让补的状态里。所以逐件记录"本轮新装"的落点，失败时撤回去——
  // 动工前已存在的产物从头到尾没被碰过，这个不变式对整组成立，不只对单件成立。
  const installedFresh: string[] = [];
  try {
    for (const job of jobs) {
      fs.mkdirSync(path.dirname(job.dest), { recursive: true });
      const part = `${job.dest}.part`;
      const preexisting = fs.existsSync(job.dest);
      io.out(`取回 ${job.kind} …`);
      const digest = await doTransfer(job.src, part);
      installVerified(digest, job.expect, job.kind, job.shaFlag, job.dest, part, io);
      if (!preexisting) installedFresh.push(job.dest);
      io.out(`  已就位：${job.dest}`);
    }
  } catch (e) {
    for (const f of installedFresh) {
      try { fs.rmSync(f, { force: true }); io.out(`  撤回本轮新装：${f}`); } catch { /* 尽力 */ }
    }
    io.out(`失败：${e instanceof Error ? e.message : String(e)}`);
    io.out("（本轮没有留下半途态：缺件重跑不必 --force，现有产物也未被改动）");
    return 1;
  }

  if (v.tokenizer) {
    io.out("");
    io.out(`tokenizer 装到了非 HF 位置；让引擎找到它：export LAYA_TOKENIZER_DIR=${path.dirname(tokDest)}`);
  }

  // 刚装到非 HF 位置的 tokenizer 也要被认出来（否则这条自检永远说缺 tokenizer）。
  const a = checkArtifacts(onnxDest, () => findDefaultTokenizerDir()
    ?? (fs.existsSync(tokDest) ? path.dirname(tokDest) : null));
  io.out("");
  if (a.ready) {
    io.out("决策模型产物齐了（图 + 权重 + tokenizer）。npm run doctor 会显示 ✓ 真模型；");
    io.out("之后 npm run apps -- --app ctrip-case 就是真模型在决策（默认，不需要旗标）。");
  } else {
    io.out(`产物还不齐，缺：${missingPieces(a).join("、")}`);
    io.out("（规则模式照跑；缺件清单与补法见 npm run doctor）");
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
