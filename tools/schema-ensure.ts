/**
 * `precheck` —— 让 `npm run check` 在**干净 checkout** 上直接绿。
 *
 * `dist/schema/ctx.json` 是 gitignored 的构建产物：`schema:check` 要靠它做"引擎契约 ↔ 快照"漂移比较。
 * 干净 checkout 没有快照，原行为是 `SCHEMA_SNAPSHOT_MISSING` exit 2；CI 里可以先生成再 check，
 * 但本地使用者/新贡献者不该先读一段报错才知道要跑什么。这里：
 *   - 快照**存在** → 不动它（让 schema:check 做真正的漂移比较）；
 *   - 快照**缺失** → 用当前源生成（此时没有历史基线，只能证明"当前源可渲染"，不是漂移比较）。
 *
 * 注意：这是**precheck**，只挂在 `npm run check` 前；`npm run schema:check` 本身仍保持严格的
 * "缺失即错"，发布/CI 需要显式漂移门时用后者。纯 Node 内建模块，无网络、无浏览器。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const snapshot = path.join(REPO, "dist", "schema", "ctx.json");
if (fs.existsSync(snapshot)) process.exit(0);

fs.mkdirSync(path.dirname(snapshot), { recursive: true });
console.error("[precheck] dist/schema/ctx.json 不存在（干净 checkout / 构建产物已清理）：先用当前源生成快照，再跑漂移检查。");
const r = spawnSync(process.execPath, [
  "--experimental-strip-types",
  path.join(REPO, "src", "cli", "main.ts"),
  "schema", "ctx", "--out", snapshot,
], { cwd: REPO, stdio: "inherit" });
process.exit(r.status ?? 1);
