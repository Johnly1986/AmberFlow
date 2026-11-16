/**
 * 敏感值掩码的**唯一契约**（P0-0.7）。
 *
 * 此前 sentinel 分散在三处且靠注释同步：
 *   - `src/app/redaction.ts: MASKED_SLOT = "***"`（顶层 slots / 收尾 scrubSecrets）；
 *   - `src/engine/executor-pure.ts: EFFECT_MASK = "***"`（effect 读回掩码，engine 不反向依赖 app）；
 *   - `src/engine/executor-pure.ts: redactValue` 的 `***(${len})`（password/file/hidden 输入形态）。
 * 同一安全契约的三个字面量靠注释人工同步 = 改一处漏两处的风险。现在 L0 叶子单源：
 * 所有掩码形状都从这里取 sentinel；改掩码形状只改这一行，并跑 `npm run check`（secret-scan / examples canary）。
 *
 * 纪律：产物/报告/stdout/trace/dry 的任何掩码一律引用 `MASK`；新增输出面不得手写 `"***"`。
 */
export const MASK = "***";
