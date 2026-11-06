/**
 * 工具步产物（T1：数据腿的进程观察面必须**可回读**，不只是一行 trace 摘要）。
 *
 * 三件事，各只有一份实现：
 *   1. **有界文本**（`capToolText` / `stderrTail`）：stdout/stderr 各截断到 8KB，
 *      超过就带 `truncated: true`——产物里不塞无界输出（一次 `--help` 就能几十 MB）；
 *   2. **安全工件名**（`safeArtifactSlug`）：desc 是人写的自由文本，直接拼路径等于
 *      让脚本写任意文件；只允许 `[A-Za-z0-9._-]`，其余替换 `-`，并去掉首尾点/横线；
 *   3. **落盘 + 掩码**（`writeToolStepArtifact`）：写 `<outDir>/tool-steps/NN-<slug>.json`，
 *      写之前用既有 `scrubSecrets` 深扫一遍（与 result/trace/report 同一个掩码惯例）。
 *
 * 返回的是**相对 outDir 的 posix 路径**（如 `tool-steps/01-query.json`）：产物在
 * result/trace 里可定位，但不把运行机的绝对路径散进产物。
 */
import fs from "node:fs";
import path from "node:path";
import { scrubSecrets } from "./redaction.ts";

/** stdout/stderr 的单值上限（每个工具步各自截断，互不侵占）。 */
export const TOOL_TEXT_CAP = 8 * 1024;
/** 失败诊断里 stderr 摘要的长度上限（进 `reason`/trace 的 `stderr_tail`）。 */
export const TOOL_STDERR_TAIL_CAP = 400;

/** 有界文本：只截头，不改变内容语义；`truncated` 标记"这里不再是全文"。 */
export function capToolText(value: unknown): { text: string; truncated: boolean } {
  const text = typeof value === "string" ? value
    : value === undefined || value === null ? "" : String(value);
  if (text.length <= TOOL_TEXT_CAP) return { text, truncated: false };
  return { text: text.slice(0, TOOL_TEXT_CAP), truncated: true };
}

/**
 * stderr 的**尾部摘要**（失败诊断用）：取最后一个非空行（多数进程把原因写在最后一行），
 * 过长就留尾部 `cap` 个字符并加省略号——`reason` 是给人读的一句话，不是日志搬运。
 */
export function stderrTail(value: unknown, cap = TOOL_STDERR_TAIL_CAP): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const picked = lines.length > 0 ? lines[lines.length - 1]! : text;
  return picked.length <= cap ? picked : `…${picked.slice(-cap)}`;
}

/** 工件名 slug：自由文本 desc → 只含 `[A-Za-z0-9._-]` 的安全片段（防路径注入）。 */
export function safeArtifactSlug(desc: unknown, max = 48): string {
  const raw = typeof desc === "string" ? desc : desc === undefined || desc === null ? "" : String(desc);
  const slug = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.\-_]+/, "")
    .replace(/[.\-_]+$/, "")
    .slice(0, max);
  return slug.length > 0 ? slug : "tool-step";
}

/**
 * 写一个工具步工件。返回相对 outDir 的 posix 路径；写不了（权限/磁盘）返回 null——
 * 工件写失败**不得**改变工具步的结论（结论来自进程观察，不来自磁盘）。
 */
export function writeToolStepArtifact(
  outDir: string,
  seq: number,
  desc: string,
  record: Record<string, unknown>,
  secrets: readonly string[],
): string | null {
  try {
    const dir = path.join(outDir, "tool-steps");
    fs.mkdirSync(dir, { recursive: true });
    const name = `${String(Math.max(1, Math.trunc(seq))).padStart(2, "0")}-${safeArtifactSlug(desc)}.json`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, `${JSON.stringify(scrubSecrets(record, secrets), null, 2)}\n`, "utf8");
    return path.posix.join("tool-steps", name);
  } catch {
    return null;
  }
}
