/**
 * 原始工具入口（`npm run apps` / `apps:suite` / `bench` / `tools/*` …）的**统一配置引导**。
 *
 * 背景：`amber` CLI 的 `main.ts` 会把「旧 rc < 用户配置 < 项目配置 < 环境变量」解析进
 * `process.env` 再分派；但直接用 `node tools/...`（npm run 脚本的常态）的入口只调了
 * `applyRcToEnv()`，于是 `amber config set AMBERFLOW_DECISION_BASE_URL …` 写的统一配置
 * 对它们不可见——同一台机器，"amber run" 能用线上服务、"npm run apps" 却报缺端点。
 *
 * 这个模块把两件事按 CLI 同一次序做掉（旧 rc 仍是最低层，环境变量仍最高）：
 *   1. `applyRcToEnv()`（旧 rc 的单一实现）；
 *   2. `resolveConfig()` 的新层叠（用户/项目/显式配置），只补仍为空的键。
 * 返回 errors 供入口决定 exit 2；`applied` 供测试/doctor 断言。
 *
 * 注意：它**只写 process.env**，不缓存；入口各自在 `main()` 第一行调用一次即可（与旧 rc 相同）。
 */
import { resolveConfig } from "../cli/config-store.ts";
import { applyRcToEnv } from "./rcfile.ts";

export interface AppliedConfigEnv {
  /** 本调用实际补进 env 的键（环境变量已设置的键不会被覆盖，不会出现在这里）。 */
  applied: string[];
  /** 配置层里的错误（未知键/坏 JSON/类型不对…）；非空 = 入口应 exit 2。 */
  errors: string[];
}

export function applyConfiguredEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  opts: { includeFiles?: boolean } = {},
): AppliedConfigEnv {
  const rc = applyRcToEnv(baseEnv);
  const errors = [...rc.errors];
  // 测试进程不吸收开发者本机的用户/项目配置：直接调入口的用例会随谁的本机配置漂移。
  // 需要测配置层的用例显式传 { includeFiles: true }（并自己指定 AMBERFLOW_HOME）。
  const includeFiles = opts.includeFiles ?? baseEnv.VITEST === undefined;
  if (!includeFiles) return { applied: [], errors };
  let resolved;
  try {
    resolved = resolveConfig(baseEnv, cwd);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    return { applied: [], errors };
  }
  errors.push(...resolved.errors);
  const applied: string[] = [];
  for (const [key, entry] of Object.entries(resolved.values)) {
    if (baseEnv[key] === undefined || baseEnv[key] === "") {
      baseEnv[key] = entry.value;
      applied.push(key);
    }
  }
  return { applied, errors };
}
