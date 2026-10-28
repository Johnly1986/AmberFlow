/**
 * **本地检查点选择**：没有在线服务地址时，`AMBERFLOW_DECISION_MODEL` 表示本地 Laya 检查点。
 *
 * 模型名只有一个配置键（`AMBERFLOW_DECISION_MODEL`）：
 *   - 没有 `AMBERFLOW_DECISION_BASE_URL`：它选本地 checkpoint（`english` / `multilingual`；
 *     测试臂额外支持 `router`）；
 *   - 有 `AMBERFLOW_DECISION_BASE_URL`：它作为该线上服务的模型名。
 *
 * 本地模型只在**没有服务地址**时使用；因此把在线模型名填进本地模式会在开跑前报错，而不是
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
 * 允许集合按入口给（apps 不接受 `router`；`router` 是测量臂）。
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
      + "本地模型只在没有 AMBERFLOW_DECISION_BASE_URL 时使用；要用在线模型，请设置"
      + "服务地址 / 密钥 / 模型三件套（AMBERFLOW_DECISION_BASE_URL / _API_KEY / _MODEL）。",
    );
  }
  return name;
}
