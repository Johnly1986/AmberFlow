/**
 * 决策服务三件套的环境读取**唯一出处**（P0-0.7）。
 *
 * 修 bug：此前「在线决策源是否配置」有两条口径——
 *   - `src/app/app-runner.ts` 用 `typeof env.X === "string" && env.X !== ""`（**不 trim**，空白串算已配置）；
 *   - CLI / doctor / decision-service 用 `(env.X ?? "").trim() !== ""`（空白串算未配置）。
 * 同一份配置在「amber run」与「npm run apps」下行为不同（空白地址会触发一次无意义探测并被标记 degraded）。
 * 现统一为：**只有非空白的字符串才算配置**；本模块是 L0 叶子（零 import），所有入口直接引用。
 *
 * 纪律：三件套的读取都从这里走；新增消费点不得再手写 `process.env.AMBERFLOW_DECISION_*` 判空。
 * 说明：这是**配置面是否在**的判断；凭据能否过网关仍由运行期/探针如实判定（不归本模块）。
 */

/** 读取 env 字符串并 trim；缺省/非字符串 = 空串。 */
export function envText(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  return typeof v === "string" ? v.trim() : "";
}

/** 线下决策服务地址（trim 后；空串 = 未配置，走本地模型）。 */
export function decisionBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return envText(env, "AMBERFLOW_DECISION_BASE_URL");
}

/** 在线决策源是否配置（唯一判空口径：非空白地址才算配置）。 */
export function decisionServiceConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return decisionBaseUrl(env) !== "";
}
