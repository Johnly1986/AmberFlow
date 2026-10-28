/**
 * 「这台机器上 `amber` 到底叫什么」—— 一个只在必要时说真话的检测器。
 *
 * 起因（2026-10-23 实测）：`npm ci` 只链接**依赖**的 bin，不会把根包自己的
 * `bin.amber` 放进 PATH。于是 README 里每一句 `npm run test` 在裸 checkout 上
 * 都会得到 `CommandNotFoundException`，而仓库里没有任何一处会提前说出来——
 * 用户只能自己猜"是不是装错了"。
 *
 * 这里只做一件事：**查 PATH 里有没有 amber**，没有就把两种现在就能用的写法点出来。
 * 它不改退出码（缺 link 不是环境故障，只是少一条捷径），也不尝试替你 link。
 */
import fs from "node:fs";
import path from "node:path";

export interface CliInvocation {
  /** `amber` 是否已经在 PATH 上（= 执行过 `npm link` 或全局安装）。 */
  linked: boolean;
  /** 命中的可执行文件；没命中为 `null`。 */
  path: string | null;
}

/** Windows 的 bin 垫片有四种扩展名；POSIX 只有一种。 */
const CANDIDATES = process.platform === "win32"
  ? ["amber.cmd", "amber.ps1", "amber.exe", "amber"]
  : ["amber"];

/**
 * `node_modules/.bin` 只在 npm 派生的进程里出现在 PATH 上（`npx` / `npm run`），
 * 用户新开一个终端时它不在。把它算作"已安装"，正好会掩盖我们要诊断的那个问题。
 */
function npmLocalBin(dir: string): boolean {
  return dir.replace(/\\/g, "/").endsWith("node_modules/.bin");
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  return raw
    .split(path.delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter((d) => d !== "" && !npmLocalBin(d));
}

export function detectCliInvocation(env: NodeJS.ProcessEnv = process.env): CliInvocation {
  for (const dir of pathDirs(env)) {
    for (const name of CANDIDATES) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return { linked: true, path: candidate };
      } catch {
        // 目录不存在 / 无权限都按"没有"处理：这只是提示，不该抛。
      }
    }
  }
  return { linked: false, path: null };
}

/** 没 link 时现在就能用的写法（顺序 = 推荐顺序）。`…` 是参数占位。 */
export const INVOKE_FALLBACKS: readonly string[] = [
  "npx amber …",
  "npm run amber -- …",
  "npm run cli -- …",
];

/** 一行可抄的补救：`npm link`（只需一次，之后裸 `amber` 就能用）。 */
export const LINK_HINT = "npm link";

/** doctor / 首页共用的一句话（caller 决定走 stdout 还是 stderr）。 */
export function cliInvocationLine(inv: CliInvocation = detectCliInvocation()): {
  status: string;
  hints: string[];
} {
  if (inv.linked) return { status: `amber  ✓  ${inv.path ?? ""}`.trimEnd(), hints: [] };
  return {
    status: "裸 amber 未安装（npm ci 只装依赖，不会把根包的 bin 放进 PATH）",
    hints: [
      `现在可用：${INVOKE_FALLBACKS.join("  或  ")}`,
      `想直接敲 amber：执行一次 ${LINK_HINT}`,
    ],
  };
}
