/**
 * **本地检查点选择**：`AMBERFLOW_DECISION_MODEL` 在未提供 provider 时表示本地 Laya 检查点。
 *
 * 模型名只有一个配置键（`AMBERFLOW_DECISION_MODEL`）：
 *   - 没有 provider：它选本地 checkpoint（`english` / `multilingual`；bench 额外支持 `router`）；
 *   - 有 provider：它作为该服务的模型名（token-plan / 百炼 / 统一决策服务）。
 *
 * 本地模型只在**未提供 provider**时使用；因此把在线模型名填进本地模式会在开跑前报错，而不是
 * 让 runtime 拿一个不存在的 checkpoint 去加载。
 */
export const LOCAL_CHECKPOINTS = ["english", "multilingual"] as const;
export const ROUTER_CHECKPOINTS = [...LOCAL_CHECKPOINTS, "router"] as const;

/** 配置里的模型名（空串 = 没设）。 */
export function configuredDecisionModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.AMBERFLOW_DECISION_MODEL;
  if (raw === undefined) return null;
  const v = raw.trim();
  return v === "" ? null : v;
}

/**
 * 本地 checkpoint 名：配置 > 包声明 > `english`。
 * 允许集合按入口给（apps 不接受 `router`；bench 的 router 是一个测量臂）。
 */
export function resolveLocalCheckpoint(
  env: NodeJS.ProcessEnv = process.env,
  fallback: string | null = null,
  opts: { allowRouter?: boolean } = {},
): string {
  const configured = configuredDecisionModel(env);
  const name = configured ?? fallback ?? "english";
  const allowed: readonly string[] = opts.allowRouter ? ROUTER_CHECKPOINTS : LOCAL_CHECKPOINTS;
  if (!allowed.includes(name)) {
    throw new Error(
      `AMBERFLOW_DECISION_MODEL=${JSON.stringify(name)} 不是本地 checkpoint（可用：${allowed.join(", ")}）。`
      + "本地模型只在未提供 provider 时使用；要用在线模型，请设置 provider"
      + "（AMBERFLOW_DECISION_PROVIDER=… 或命令行 --provider …）。",
    );
  }
  return name;
}
