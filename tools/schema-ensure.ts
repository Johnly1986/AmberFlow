/**
 * `precheck` —— 让 `npm run check` 在任何 checkout 上都**可重复地绿**。
 *
 * `dist/schema/ctx.json` 是 gitignored 的构建产物：`schema:check` 拿它做"引擎契约 ↔ 快照"
 * 比较。但它**没有任何版本基线**（不进仓库）——旧快照只会让本地 `npm run check` 恒红，
 * 且无法区分"代码改坏了契约"与"快照过期"（2026-11-16 架构评审实测：F72-F84 落地后，
 * 本机 check 恒以 SCHEMA_DRIFT exit 2，而 CI 因为先生成再 check 反而全绿）。
 *
 * 评审收口：precheck 改为**无条件重生成**快照——`schema:check` 退化为"当前源能渲染且
 * 渲染结果自洽"的检查（仍能拦住渲染期崩溃/非确定性输出）；发布物/CI 的快照正确性由
 * 构建流程（`check:ci`）负责，而不是靠开发者机器上的陈旧产物。纯 Node 内建模块，
 * 无网络、无浏览器。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const snapshot = path.join(REPO, "dist", "schema", "ctx.json");
fs.mkdirSync(path.dirname(snapshot), { recursive: true });
console.error("[precheck] 重新生成契约快照 dist/schema/ctx.json（gitignored 构建产物、无版本基线：schema:check 只验当前源自洽）。");
const r = spawnSync(process.execPath, [
  "--experimental-strip-types",
  path.join(REPO, "src", "cli", "main.ts"),
  "schema", "ctx", "--out", snapshot,
], { cwd: REPO, stdio: "inherit" });
process.exit(r.status ?? 1);
