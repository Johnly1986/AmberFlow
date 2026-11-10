/**
 * **「已设键不覆盖」合并语义的单源实现**。
 *
 * 历史：同一语义在 main.ts（syncConfigEnv）与 apply-config-env.ts 各写一遍，rcfile.ts 与
 * config-store.ts 又各手写一遍——同一规则 4 处实现，修一处漏三处。config-store 下移 support
 * 后把这条语义收敛到这里，CLI 入口与原始工具入口共用。
 *
 * 规则（有意保持，勿改顺序）：
 *  - **env 已设键不覆盖**：`baseEnv[key]` 已是非空串就保持原样（环境变量是最高层）；
 *  - 否则把 `effective[key]` 补进去，并记入 `touched` 供随后还原。
 * 保留 VITEST 豁免（apply-config-env 在测试进程里走旧 rc 最低层）与旧 rc 最低层顺序——
 * 那两处是"环境变量最高、旧 rc 最低"纪律的执法点，也是 2026-10-28 实测事故的教材。
 */
export interface MergeEnvResult {
  /** 本调用实际补进 env 的键（env 已设的键不会被覆盖，不会出现在这里）。 */
  touched: string[];
}

/**
 * 把 `effective` 里**当前未设**（undefined 或空串）的键补进 `baseEnv`；已设的键原样保留。
 * 返回补进的键清单（供 `restoreEnv` 还原）。
 */
export function applyEnvNoOverwrite(
  baseEnv: NodeJS.ProcessEnv,
  effective: NodeJS.ProcessEnv,
): MergeEnvResult {
  const touched: string[] = [];
  for (const key of Object.keys(effective)) {
    const before = baseEnv[key];
    const next = effective[key];
    if ((before === undefined || before === "") && next !== undefined && next !== "") {
      baseEnv[key] = next;
      touched.push(key);
    }
  }
  return { touched };
}

/** 还原 `applyEnvNoOverwrite` 补进的键（undefined 删除，有值恢复原样）。幂等。 */
export function restoreEnv(baseEnv: NodeJS.ProcessEnv, touched: string[]): void {
  for (const key of touched) {
    const before = baseEnv[key];
    if (before === undefined) delete baseEnv[key];
    else baseEnv[key] = before;
  }
}