/**
 * 模型产物探测——**单一出处**（LAYA_VALUE_PLAN P0 的地基）。
 *
 * 三处要回答同一个问题"真模型在不在"：`npm run doctor`（缺件要报哪一件、给哪条补法命令）、
 * `npm run model:fetch`（往哪儿放、放齐了没有）、应用运行器（结果与桥的 summary 要写
 * `model: on|off(missing)`）。以前这个判断散在 start.ts 的一行 `existsSync` 里，而
 * laya-onnx 的 `load()` 又是另一套报错——两处对"齐不齐"的定义一旦漂移，doctor 就会
 * 在真跑挂掉时说"✓ 真模型"。这里钉成一个模块：
 *
 *   图（.onnx）· 外置权重（.onnx.data）· tokenizer（HF 快照目录或 LAYA_TOKENIZER_DIR）
 *
 * 三件**齐**才算 `on`；缺哪件，doctor 就点名哪件并给出补齐命令。约定的落点仍是
 * `LAYA_ONNX_MODEL`（旧名 `LAYAA_ONNX_MODEL` 兼容）指向的 `.onnx` 路径，默认 /tmp。
 */
import fs from "node:fs";
import path from "node:path";

import { findDefaultTokenizerDir } from "./laya-onnx.ts";

/** 图/权重是否齐全只看这两个文件；tokenizer 由 laya-onnx 的发现逻辑回答。 */
export interface ModelArtifacts {
  /** ONNX 图的路径（约定：`LAYA_ONNX_MODEL` / `LAYAA_ONNX_MODEL` / 默认 /tmp/laya_dec.onnx）。 */
  onnxPath: string;
  /** 外置权重路径（图的 `.onnx` + `.data`——与 onnxruntime 的外部数据约定一致）。 */
  dataPath: string;
  /** 图在不在。 */
  graph: boolean;
  /** 权重在不在。 */
  weights: boolean;
  /** tokenizer 目录（含 tokenizer.json）；找不到为 null。 */
  tokenizerDir: string | null;
  /** 三件齐 = 真模型可用。 */
  ready: boolean;
}

/** 默认图路径（与 `src/laya-onnx.ts` 的 `DEFAULT_ONNX_PATH` 同一约定）。 */
export const DEFAULT_ONNX_PATH = "/tmp/laya_dec.onnx";

/** 约定的图路径：环境变量优先（`LAYAA_*` 是旧名，兼容保留）。 */
export function onnxModelPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.LAYA_ONNX_MODEL ?? env.LAYAA_ONNX_MODEL ?? DEFAULT_ONNX_PATH;
}

/** 外置权重的约定位置：图路径 + `.data`（onnxruntime external-data 的形状）。 */
export function weightsPathOf(onnxPath: string): string {
  return `${onnxPath}.data`;
}

/**
 * 探测一次产物状态。`findTokenizer` 可注入（测试用），默认复用 laya-onnx 的快照发现——
 * 包括 `LAYAA_TOKENIZER_DIR` / `LAYA_TOKENIZER_DIR` 覆盖，避免第二套搜索逻辑。
 */
export function checkArtifacts(
  onnxPath: string = onnxModelPath(),
  findTokenizer: () => string | null = findDefaultTokenizerDir,
): ModelArtifacts {
  const graph = fs.existsSync(onnxPath);
  const dataPath = weightsPathOf(onnxPath);
  const weights = fs.existsSync(dataPath);
  let tokenizerDir: string | null = null;
  try {
    tokenizerDir = findTokenizer();
  } catch {
    tokenizerDir = null;                 // 探测失败不等于崩：如实按缺件处理
  }
  return {
    onnxPath, dataPath, graph, weights, tokenizerDir,
    ready: graph && weights && tokenizerDir !== null,
  };
}

/** 缺件的**点名 + 一条补齐命令**（doctor 与 CLI 警告共用同一措辞，不散落三份）。 */
export function missingPieces(a: ModelArtifacts): string[] {
  const out: string[] = [];
  if (!a.graph) out.push("ONNX 图");
  if (!a.weights) out.push("外置权重 .onnx.data");
  if (a.tokenizerDir === null) out.push("tokenizer");
  return out;
}

/**
 * 区分两种"模型不在"（D6 / backlog I-1）：
 *
 *   - **没配置**（环境变量未设、默认路径没有产物）→ 层级 `off(missing)`，照常跑规则层，
 *     需要模型的步**如实 block**。这是这台 CPU 机器的常态，不是错误。
 *   - **配置错了**（显式把 `LAYA_ONNX_MODEL` 指到一个不存在的文件）→ 这是**用法错误**：
 *     它不是瞬时的，重试一百次也是同一句话；而且"跑到第一个需要模型的步才发现"意味着
 *     数据腿和第一个工具步**已经执行**（实测过：同一配置错误被重试 2 次、产物已落盘）。
 *
 * 所以配置错误要在**启动期预检**里点名并拒绝开跑（0 步、0 副作用），永不进重试循环。
 */
export function modelConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicitGraph = env.LAYA_ONNX_MODEL ?? env.LAYAA_ONNX_MODEL ?? null;
  if (explicitGraph !== null && !fs.existsSync(explicitGraph)) {
    return `LAYA_ONNX_MODEL=${JSON.stringify(explicitGraph)} points at a file that does not exist `
      + `(补产物：npm run model:fetch -- --from <url|本地路径>；或删掉这个环境变量，按缺产物的规则层跑)`;
  }
  const explicitTok = env.LAYA_TOKENIZER_DIR ?? env.LAYAA_TOKENIZER_DIR ?? null;
  if (explicitTok !== null && !fs.existsSync(path.join(explicitTok, "tokenizer.json"))) {
    return `LAYA_TOKENIZER_DIR=${JSON.stringify(explicitTok)} has no tokenizer.json inside`;
  }
  return null;
}
