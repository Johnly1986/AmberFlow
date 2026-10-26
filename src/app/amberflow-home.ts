/**
 * 用户作用域（前提 A，docs/ARCHITECTURE_REVIEW.md §0.1）——**应用是用户本地的流程配置，
 * 不是仓库的分享品**。
 *
 * 为什么默认落盘必须移出 checkout：
 *   - 用户录一个包（`learn`）或规划一个包（`plan:flow`）写进 `<repo>/apps`，等于往引擎的
 *     安装目录里塞东西：升级即丢、git status 变脏、多 checkout 之间互相看不见；
 *   - 仓库不再内置应用，应用只住 `$AMBERFLOW_HOME/apps`，跟着用户走。
 *
 * 规则（都在这一个文件里，不分散）：
 *   - **落点**：`$AMBERFLOW_HOME/apps`，默认 `~/.amberflow/apps`；录制/规划生成的新包写这里。
 *   - **发现**：读取用户目录；没有仓库内置包。

 *   - **版本**：`spec_version` 不认识就响亮拒绝（`app-pack.ts` 的加载期校验是这条规则的
 *     执法点），引擎演进时宁可拒跑也不猜着跑——CI 盖不到用户目录里的包，猜 = 静默错。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** `AMBERFLOW_HOME` 未设时的缺省：`~/.amberflow`。 */
export const DEFAULT_HOME_DIRNAME = ".amberflow";

/** 用户作用域的引擎主目录（apps、learn 产物、profile 的归属）。不落盘，只算路径。 */
export function amberflowHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.AMBERFLOW_HOME;
  if (fromEnv && fromEnv.trim() !== "") return path.resolve(fromEnv);
  return path.join(os.homedir(), DEFAULT_HOME_DIRNAME);
}

/** 用户应用包的目录：`$AMBERFLOW_HOME/apps`。录制/规划的新包写这里，不写 checkout。 */
export function userAppsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(amberflowHome(env), "apps");
}

/**
 * 计划检查点的默认落点：`$AMBERFLOW_HOME/task_plan.json`。
 *
 * 它以前写在**仓库根**（`.task_plan.json`）——运行产物被塞进引擎的安装目录：git status
 * 变脏、多 checkout 互相覆盖、升级即丢（与用户作用域迁移同一个理由）。`start` 与
 * `plan-cli` 共用这一个函数：两个入口各写一个默认值，就是"同一件事两个落点"的复发形状。
 */
export function defaultPlanPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(amberflowHome(env), "task_plan.json");
}

/**
 * 应用包的**搜索路径**（发现制的目录序列，按优先级）：用户目录在前、仓库夹具在后。
 * `repoApps` 由调用方传入（`app-pack.ts` 的 `APPS_DIR`），本模块不认识仓库布局——
 * 和"引擎不认识站点"同一个口径：路径知识在调用方，这里只定义"用户作用域"。
 */
export function appsSearchPath(repoApps: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const user = userAppsDir(env);
  return user === repoApps ? [repoApps] : [user, repoApps];
}

/** 写目录时按需建父目录（`mkdir -p` 语义）；返回传入路径便于链式调用。 */
export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
