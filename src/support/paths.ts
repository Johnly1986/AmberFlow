import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 仓库根的单一出处：从本文件位置向上找 package.json。
 *
 * 平铺时代 src 内 14 个文件各自写一份 `path.resolve(HERE, "..")`——
 * 隐含"我距仓库根恰好一层"的假设，文件一旦移入子目录就集体失准
 * （夹具发现、rc 加载、结果目录全指错）。向上查找对再次移动鲁棒。
 */
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`AmberFlow: 向上未找到 package.json（起点 ${start}）`);
    }
    dir = parent;
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPO = findRepoRoot(HERE);
